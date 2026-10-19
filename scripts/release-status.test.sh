#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/release-status.sh"
# The interpreter that runs the script under test defaults to the one running
# this suite; the Bash 3.2 compatibility pass at the end re-executes the suite
# with it set to a real Bash 3.
script_bash=${RELEASE_STATUS_TEST_BASH:-$BASH}
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
stub_dir="$temp_dir/stub"
mkdir -p "$bin_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "release-status test failed: $*" >&2
  exit 1
}

for command in bash cat mktemp python3 rm tr; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

# Stub gh: every call maps to one fixture path under $GH_STUB_DIR (see
# fixture_path below). An existing <path> is printed; an existing <path>.fail
# prints its content to stderr and exits 1; neither is an HTTP 404. `auth
# status` fails when $GH_STUB_DIR/unauth exists. Every call is logged.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
repo="" search=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[i]}" == --repo ]] && repo=${args[i + 1]#intent-hq/}
  [[ "${args[i]}" == --search ]] && search=${args[i + 1]//\//__}
done
case "$1 $2" in
  "auth status") [[ -f "$GH_STUB_DIR/unauth" ]] && { echo "not logged in" >&2; exit 1; }; exit 0 ;;
  "release list") path="releases/$repo.json" ;;
  "release download") path="download/$repo/$3" ;;
  "pr list") path="prs/$repo/$search.json" ;;
  "run list") path="runs/$repo.json" ;;
  "run view") path="logs/$repo/$3.log" ;;
  "variable list") path="vars/$repo.json" ;;
  api*)
    endpoint=${*: -1}
    endpoint=${endpoint#repos/intent-hq/}
    path="api/${endpoint//\//__}" ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
if [[ -f "$GH_STUB_DIR/$path.fail" ]]; then
  cat "$GH_STUB_DIR/$path.fail" >&2
  exit 1
fi
[[ -f "$GH_STUB_DIR/$path" ]] || { echo "HTTP 404: Not Found ($path)" >&2; exit 1; }
cat "$GH_STUB_DIR/$path"
SH
chmod +x "$bin_dir/gh"

put() {
  mkdir -p "$(dirname "$stub_dir/$1")"
  cat >"$stub_dir/$1"
}

# A pending fe release: the Release PR is green but a pin-bump PR defers the
# cut; intentd has no open Release PR and its last run was throttled.
reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$stub_dir"
  : >"$temp_dir/gh.log"
  put releases/intentd.json <<'J'
[{"tagName":"channel-alpha","publishedAt":"2026-10-19T12:05:00Z"},
 {"tagName":"v0.11.11","publishedAt":"2026-10-19T12:00:00Z"},
 {"tagName":"v0.11.10","publishedAt":"2026-10-19T10:00:00Z"}]
J
  put releases/cloudlands-releases.json <<'J'
[{"tagName":"beta","publishedAt":"2026-10-19T11:00:00Z"},
 {"tagName":"v2.221.0","publishedAt":"2026-10-19T10:00:00Z"}]
J
  echo '{"channel":"alpha","version":"0.11.11"}' | put download/intentd-releases/channel-alpha
  echo '{"channel":"beta","version":"0.10.33"}' | put download/intentd-releases/channel-beta
  echo '{"channel":"stable","version":"0.10.30"}' | put download/intentd-releases/channel-stable
  printf 'version: 2.219.8\nfiles:\n  - url: x\n' | put download/cloudlands-releases/beta
  printf "version: '2.219.1'\n" | put download/cloudlands-releases/stable
  echo '[{"name":"v0.11.9"},{"name":"v0.11.11"},{"name":"v0.11.10"},{"name":"cli-v1"}]' | put 'api/intentd__tags?per_page=30'
  echo '[{"name":"v2.221.0"},{"name":"v2.220.2"}]' | put 'api/cloudlands-fe__tags?per_page=30'
  echo '{"commit":{"committer":{"date":"2026-10-19T11:58:00Z"}}}' | put api/intentd__commits__v0.11.11
  echo '{"commit":{"committer":{"date":"2026-10-19T09:58:00Z"}}}' | put api/cloudlands-fe__commits__v2.221.0
  echo '{"ahead_by":3,"status":"ahead"}' | put 'api/intentd__compare__v0.11.11...main?per_page=1'
  echo '{"ahead_by":1,"status":"ahead"}' | put 'api/cloudlands-fe__compare__v2.221.0...main?per_page=1'
  printf '# Exact intentd version bundled as the sidecar\n0.11.10\n' |
    put 'api/cloudlands-fe__contents__intentd.version?ref=main'
  # Search is fuzzy: a near-miss head ref is filtered out.
  echo '[{"number":7,"headRefName":"feat/release-plz-docs","title":"x"}]' | put 'prs/intentd/head:release-plz-.json'
  put 'prs/cloudlands-fe/head:release-please--branches--main.json' <<'J'
[{"number":3512,"title":"chore(release): 2.222.0","url":"https://example/3512","headRefName":"release-please--branches--main--components--intent",
 "isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN",
 "statusCheckRollup":[{"name":"CI Gate","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-10-19T12:10:00Z"},
                      {"name":"CI Gate","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-10-19T12:44:00Z"},
                      {"name":"lint","status":"COMPLETED","conclusion":"STARTUP_FAILURE"},
                      {"context":"legacy","state":"SUCCESS"}],
 "commits":[{"committedDate":"2026-10-19T12:00:00Z"},{"committedDate":"2026-10-19T12:43:00Z"}]}]
J
  put 'prs/cloudlands-fe/head:auto__intentd-pin.json' <<'J'
[{"number":3517,"title":"fix: bump intentd sidecar to v0.11.11","url":"https://example/3517","headRefName":"auto/intentd-pin",
 "isDraft":false,"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN",
 "statusCheckRollup":[{"name":"CI Gate","status":"IN_PROGRESS","conclusion":""}],
 "commits":[{"committedDate":"2026-10-19T11:00:00Z"}]},
 {"number":3512,"title":"duplicate hit","headRefName":"release-please--branches--main--components--intent"}]
J
  put runs/intentd.json <<'J'
[{"databaseId":102,"status":"in_progress","conclusion":"","createdAt":"2026-10-19T12:58:00Z","event":"schedule","url":"https://example/102"},
 {"databaseId":101,"status":"completed","conclusion":"success","createdAt":"2026-10-19T12:40:00Z","event":"push","url":"https://example/101"}]
J
  # The \e[36;1m line is the step's echoed script source: never a decision.
  {
    printf 'Auto-merge\tMerge\t2026-10-19T12:40:26.1Z \033[36;1m# a comment about deferring and skipping\033[0m\n'
    printf 'Auto-merge\tMerge\t2026-10-19T12:40:27.7Z Last cut (v0.11.11) was 40 min ago (<60 min); throttled — the next cron tick retries.\n'
    printf 'Auto-merge\tMerge\t2026-10-19T12:40:28.0Z \033[36;1m# skipping again in a trailing comment\033[0m\n'
  } | put logs/intentd/101.log
  put runs/cloudlands-fe.json <<'J'
[{"databaseId":202,"status":"completed","conclusion":"success","createdAt":"2026-10-19T12:55:00Z","event":"push","url":"https://example/202"},
 {"databaseId":201,"status":"completed","conclusion":"success","createdAt":"2026-10-19T12:30:00Z","event":"schedule","url":"https://example/201"}]
J
  # The newest run was skipped at the job level (no decision line): the
  # report walks back to the older run.
  printf 'Auto-merge\tSet up job\t2026-10-19T12:55:01.0Z Complete job\n' | put logs/cloudlands-fe/202.log
  put logs/cloudlands-fe/201.log <<'L'
Auto-merge	Merge	2026-10-19T12:30:10.0Z Release PR: #3512 (chore(release): 2.222.0)
Auto-merge	Merge	2026-10-19T12:30:11.0Z ##[notice]Pin-bump PR #3517 (auto/intentd-pin) is open; deferring the alpha cut until the new sidecar pin lands
L
  echo '[]' | put vars/intent.json
  put vars/intentd.json <<'J'
[{"name":"CI_MACOS_RUNNER_DISABLED","value":"true"},
 {"name":"CI_MACOS_RUNNER_DISABLED_REASON","value":"2026-10-14: m1mac too slow"},
 {"name":"CI_WINDOWS_RUNNER_DISABLED","value":"True"},
 {"name":"CI_LINUX_RUNNER_DISABLED","value":" true"},
 {"name":"OTHER","value":"true"}]
J
  echo '[{"name":"CI_LINUX_RUNNER_DISABLED","value":"true"}]' | put vars/cloudlands-fe.json
}

run_script() {
  set +e
  PATH="$bin_dir" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" \
    RELEASE_STATUS_NOW=2026-10-19T13:00:00Z STATUS_JSON="${json:-}" \
    "$script_bash" "$script" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}

expect_line() {
  grep -qxF -- "$1" <<<"$stdout" || fail "missing line: '$1'"$'\n'"--- output:"$'\n'"$stdout"
}

json_value() {
  python3 -c 'import json, sys; print(json.dumps(eval(sys.argv[1], {"r": json.load(sys.stdin)})))' "$1" <<<"$stdout"
}

expect_json() {
  local got
  got=$(json_value "$1") || fail "JSON path $1 unreadable: $stdout"
  [[ "$got" == "$2" ]] || fail "JSON $1 = $got, expected $2"
}

ln -s "$(command -v grep)" "$bin_dir/grep"

# --- happy path, text
reset_stub
json="" run_script
[[ "$status" -eq 0 ]] || fail "happy path exited $status: $stderr"
expected=$(
  cat <<'T'
Release train at 2026-10-19 13:00Z
intentd        v0.11.11 (1h00m ago), 3 unshipped commits on main since v0.11.11
  channels     alpha 0.11.11 · beta 0.10.33 · stable 0.10.30
  release PRs  none open
  auto-cut     Last cut (v0.11.11) was 40 min ago (<60 min); throttled — the next cron tick retries. [run 101, push, 20m ago] (run 102 in_progress)
cloudlands-fe  v2.221.0 (3h00m ago), 1 unshipped commit on main since v2.221.0
  channels     alpha 2.221.0 · beta 2.219.8 · stable 2.219.1
  daemon pin   intentd 0.11.10 (behind intentd alpha 0.11.11)
  release PRs  #3512 chore(release): 2.222.0 — CI Gate SUCCESS, 2 failing checks, head 17m old
               #3517 [pin-bump] fix: bump intentd sidecar to v0.11.11 — CI Gate IN_PROGRESS, head 2h00m old, mergeable=UNKNOWN (GitHub still computing)
  auto-cut     Pin-bump PR #3517 (auto/intentd-pin) is open; deferring the alpha cut until the new sidecar pin lands [run 201, schedule, 30m ago]
runner overrides (CI_*_RUNNER_DISABLED)
  intentd        macos    2026-10-14: m1mac too slow
  cloudlands-fe  linux    (no _REASON variable)
T
)
[[ "$stdout" == "$expected" ]] || fail "happy-path text differs:"$'\n'"--- got:"$'\n'"$stdout"$'\n'"--- expected:"$'\n'"$expected"
# Unrelated PRs are never viewed; the in-progress run's log is not fetched.
! grep -q '^pr view' "$temp_dir/gh.log" || fail "release PRs were viewed one by one"
[[ "$(grep -c '^pr list' "$temp_dir/gh.log")" -eq 3 ]] || fail "expected one PR search per head prefix"
! grep -q '^run view 102' "$temp_dir/gh.log" || fail "an in-progress run log was fetched"
grep -q '^run view 202' "$temp_dir/gh.log" || fail "the newest completed fe run log was not read"
grep -q '^run view 201' "$temp_dir/gh.log" || fail "the walk-back to run 201 did not happen"

# --- happy path, JSON
reset_stub
json=1 run_script
[[ "$status" -eq 0 ]] || fail "JSON mode exited $status: $stderr"
expect_json 'r["generatedAt"]' '"2026-10-19T13:00:00Z"'
expect_json 'r["components"]["intentd"]["latestTag"]' '"v0.11.11"'
expect_json 'r["components"]["intentd"]["latestTagAgeMinutes"]' '60'
expect_json 'r["components"]["intentd"]["channels"]' '{"alpha": "0.11.11", "beta": "0.10.33", "stable": "0.10.30"}'
expect_json 'r["components"]["intentd"]["unshippedCommits"]' '3'
expect_json 'r["components"]["intentd"]["newestGitTag"]' '"v0.11.11"'
expect_json 'r["components"]["intentd"]["newestGitTagAgeMinutes"]' '62'
expect_json 'r["components"]["intentd"]["unreleasedTag"]' 'null'
expect_json 'r["components"]["intentd"]["releasePrs"]' '[]'
expect_json 'r["components"]["intentd"]["autoCut"]["runId"]' '101'
expect_json 'r["components"]["cloudlands-fe"]["channels"]["alpha"]' '"2.221.0"'
expect_json 'r["components"]["cloudlands-fe"]["releasePrs"][0]["ciGate"]' '"SUCCESS"'
expect_json 'r["components"]["cloudlands-fe"]["releasePrs"][0]["headAgeMinutes"]' '17'
expect_json 'r["components"]["cloudlands-fe"]["releasePrs"][1]["kind"]' '"pin-bump"'
expect_json 'r["components"]["cloudlands-fe"]["autoCut"]["decision"]' '"Pin-bump PR #3517 (auto/intentd-pin) is open; deferring the alpha cut until the new sidecar pin lands"'
expect_json 'r["fePin"]' '{"version": "0.11.10", "intentdAlpha": "0.11.11", "behindAlpha": true}'
expect_json 'r["runnerOverrides"][0]["variable"]' '"CI_MACOS_RUNNER_DISABLED"'
expect_json 'r["runnerOverrides"][1]["reason"]' 'null'
expect_json 'r["errors"]' '[]'

# --- auto-cut skip reasons from both repos' wording
for line in \
  "Release PR #2510 checks are still running; CI wait budget exhausted, skipping." \
  "Release PR #2510 mergeability is still being computed (mergeable=UNKNOWN); skipping." \
  "Directly squash-merged Release PR #3512 (chore(release): 2.222.0); release-please.yml now cuts the tag and release-alpha.yml publishes the alpha automatically."; do
  reset_stub
  {
    printf 'Merge\tMerge\t2026-10-19T12:40:01.0Z Release PR #2510 mergeability is still being computed (mergeable=UNKNOWN) — re-reading in 30s.\n'
    printf 'Merge\tMerge\t2026-10-19T12:40:02.0Z %s\n' "$line"
    printf 'Post\tComplete job\t2026-10-19T12:40:03.0Z Cleaning up orphan processes\n'
  } | put logs/intentd/101.log
  json=1 run_script
  expect_json 'r["components"]["intentd"]["autoCut"]["decision"]' "$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$line")"
done

# --- structured decision line (both auto-cut-alpha.yml decision contracts):
# preferred over any free-text match, wherever it sits in the log; script
# source echoes of it never count
reset_stub
{
  printf 'Merge\tMerge\t2026-10-19T12:40:00.5Z \033[36;1m            local line="auto-cut-decision: $1 $2 ${3}"\033[0m\n'
  printf 'Merge\tMerge\t2026-10-19T12:40:01.0Z \033[36;1m  decide skip draft "x"\033[0m\n'
  printf 'Merge\tMerge\t2026-10-19T12:40:02.0Z auto-cut-decision: throttle recent-cut Last cut (v0.11.11) was 40 min ago (<60 min); reworded freely\n'
  printf 'Merge\tMerge\t2026-10-19T12:40:03.0Z ##[warning]some later message that says skipping\n'
} | put logs/intentd/101.log
printf 'Merge\tMerge\t2026-10-19T12:30:11.0Z auto-cut-decision: defer pin-bump-open Pin-bump PR #3517 (auto/intentd-pin) is open\n' | put logs/cloudlands-fe/201.log
json="" run_script
expect_line "  auto-cut     throttle recent-cut: Last cut (v0.11.11) was 40 min ago (<60 min); reworded freely [run 101, push, 20m ago] (run 102 in_progress)"
expect_line "  auto-cut     defer pin-bump-open: Pin-bump PR #3517 (auto/intentd-pin) is open [run 201, schedule, 30m ago]"
json=1 run_script
expect_json 'r["components"]["intentd"]["autoCut"]["outcome"]' '"throttle"'
expect_json 'r["components"]["intentd"]["autoCut"]["reason"]' '"recent-cut"'
expect_json 'r["components"]["intentd"]["autoCut"]["decisionSource"]' '"structured"'
expect_json 'r["components"]["cloudlands-fe"]["autoCut"]["reason"]' '"pin-bump-open"'
# A structured line with no detail still renders.
reset_stub
printf 'Merge\tMerge\t2026-10-19T12:40:02.0Z auto-cut-decision: noop no-release-pr\n' | put logs/intentd/101.log
json="" run_script
expect_line "  auto-cut     noop no-release-pr [run 101, push, 20m ago] (run 102 in_progress)"
# Pre-contract runs keep the free-text fallback, flagged as such.
reset_stub
json=1 run_script
expect_json 'r["components"]["intentd"]["autoCut"]["decisionSource"]' '"pattern"'
expect_json 'r["components"]["intentd"]["autoCut"]["outcome"]' 'null'

# --- a tag newer than the newest release: its build has not published yet,
# so its commits still count as unshipped (since the published release)
reset_stub
echo '[{"name":"v0.11.11"},{"name":"v0.11.12"}]' | put 'api/intentd__tags?per_page=30'
echo '{"commit":{"committer":{"date":"2026-10-19T12:46:00Z"}}}' | put api/intentd__commits__v0.11.12
json="" run_script
expect_line "intentd        v0.11.11 (1h00m ago); v0.11.12 tagged 14m ago, release not published yet, 3 unshipped commits on main since v0.11.11"
json=1 run_script
expect_json 'r["components"]["intentd"]["unreleasedTag"]' '"v0.11.12"'

# --- tags lookup fails: the release and unshipped count still show
reset_stub
echo 'HTTP 502: Server Error' | put 'api/cloudlands-fe__tags?per_page=30.fail'
json="" run_script
expect_line "cloudlands-fe  v2.221.0 (3h00m ago), 1 unshipped commit on main since v2.221.0"
json=1 run_script
expect_json '[e["section"] for e in r["errors"]]' '["cloudlands-fe.newestGitTag"]'
expect_json 'r["components"]["cloudlands-fe"]["newestGitTag"]' 'null'

# --- pin matches alpha; channel and run lookups fail independently
reset_stub
printf '0.11.11\n' | put 'api/cloudlands-fe__contents__intentd.version?ref=main'
echo 'HTTP 502: Server Error' | put download/intentd-releases/channel-beta.fail
echo 'gh: API rate limit exceeded (HTTP 403)' | put runs/cloudlands-fe.json.fail
echo 'HTTP 403: Must have admin rights to Repository.' | put vars/intent.json.fail
json="" run_script
[[ "$status" -eq 0 ]] || fail "partial failure exited $status: $stderr"
expect_line "  channels     alpha 0.11.11 · beta ? · stable 0.10.30"
expect_line "  daemon pin   intentd 0.11.11 (matches or ahead of intentd alpha)"
expect_line "  auto-cut     unavailable: gh: API rate limit exceeded (HTTP 403)"
expect_line "  intent         unavailable: HTTP 403: Must have admin rights to Repository."
expect_line "  intentd        macos    2026-10-14: m1mac too slow"
json=1 run_script
expect_json 'r["errors"][0]["section"]' '"intentd.channels.beta"'
expect_json 'r["fePin"]["behindAlpha"]' 'false'
expect_json 'r["components"]["cloudlands-fe"]["autoCut"]' 'null'
expect_json '[e["section"] for e in r["errors"]]' '["intentd.channels.beta", "cloudlands-fe.autoCut", "runnerOverrides.intent"]'

# --- release list failure: the release and fe alpha are unavailable, and
# unshipped commits fall back to counting from the git tag
reset_stub
echo 'error connecting to api.github.com' | put releases/cloudlands-releases.json.fail
json="" run_script
[[ "$status" -eq 0 ]] || fail "release list failure exited $status"
expect_line "cloudlands-fe  unavailable: error connecting to api.github.com, 1 unshipped commit on main since v2.221.0"
expect_line "  channels     alpha ? · beta 2.219.8 · stable 2.219.1"

# --- no decision line in any run; no runs at all; no overrides
reset_stub
printf 'Merge\tMerge\t2026-10-19T12:40:02.0Z Release PR: #1 (x)\n' | put logs/intentd/101.log
echo '[]' | put runs/cloudlands-fe.json
for repo in intent intentd cloudlands-fe; do echo '[]' | put "vars/$repo.json"; done
json="" run_script
expect_line "  auto-cut     no decision line in the newest 1 completed run(s); newest success [run 101, push, 20m ago] (run 102 in_progress)"
expect_line "  auto-cut     no auto-cut-alpha.yml runs"
expect_line "runner overrides: none"

# --- a failed log fetch stops the walk and names the error
reset_stub
echo 'HTTP 410: logs expired' | put logs/cloudlands-fe/202.log.fail
json="" run_script
expect_line "  auto-cut     unavailable: HTTP 410: logs expired [run 202, push, 5m ago]"
! grep -q '^run view 201' "$temp_dir/gh.log" || fail "the walk continued past a failed log fetch"

# --- --no-logs never fetches logs
reset_stub
json="" run_script --no-logs
[[ "$status" -eq 0 ]] || fail "--no-logs exited $status"
! grep -q '^run view' "$temp_dir/gh.log" || fail "--no-logs fetched a run log"
expect_line "  auto-cut     logs skipped (--no-logs); newest success [run 202, push, 5m ago]"

# --- gh unauthenticated; usage error
reset_stub
touch "$stub_dir/unauth"
run_script
[[ "$status" -eq 1 ]] || fail "unauthenticated gh exited $status"
[[ "$stderr" == *"not authenticated"* ]] || fail "unauthenticated stderr: $stderr"
[[ -z "$stdout" ]] || fail "unauthenticated run printed a report"
reset_stub
run_script --limit 3
[[ "$status" -eq 2 ]] || fail "unknown argument exited $status"
[[ "$stderr" == Usage:* ]] || fail "usage stderr: $stderr"

echo "release-status tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${RELEASE_STATUS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4706): the script must parse
# and run there, so rerun the fixtures under a real Bash 3 when one can be
# found (BASH3_BIN, a bash3 on PATH, Homebrew bash@3, or a 3.x /bin/bash).
# A missing Bash 3 is a skip notice by default; REQUIRE_BASH3 (CI) makes it a
# failure.
bash -n "$script" || fail "release-status.sh does not parse"

find_bash3() {
  local candidate resolved brew_prefix
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  for candidate in "${BASH3_BIN:-}" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [[ -n "$candidate" ]] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [[ -x "$resolved" ]] || continue
    "$resolved" -c '[[ "${BASH_VERSINFO[0]}" -eq 3 ]]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  RELEASE_STATUS_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "release-status tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped"
fi
