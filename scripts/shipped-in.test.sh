#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/shipped-in.sh"
# The interpreter that runs the script under test defaults to the one running
# this suite; the Bash 3.2 compatibility pass at the end re-executes the suite
# with it set to a real Bash 3.
script_bash=${SHIPPED_IN_TEST_BASH:-$BASH}
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
stub_dir="$temp_dir/stub"
mkdir -p "$bin_dir" "$stub_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "shipped-in test failed: $*" >&2
  exit 1
}

for command in bash cat grep head mktemp python3 rm; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

# Stub gh: releases from $GH_STUB_DIR/releases, compare statuses from
# $GH_STUB_DIR/compare/<owner>__<repo>/<base>...<head>, manifests from
# $GH_STUB_DIR/manifest/<tag>.json, the cloudlands-fe Release Alpha run list
# from $GH_STUB_DIR/runs.json and its jobs from $GH_STUB_DIR/jobs/<run id>.json.
# Every invocation is appended to GH_TEST_LOG.
# GH_STUB_FAIL selects a failure mode (1 = generic, or one of the gh error
# texts below); GH_STUB_FAIL_ON narrows it to one subcommand ("release list",
# "api", "release download", "run list"), default every call.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
fail_on=${GH_STUB_FAIL_ON:-}
if [[ -n "${GH_STUB_FAIL:-}" && ( -z "$fail_on" || "$fail_on" == "$1" || "$fail_on" == "$1 $2" ) ]]; then
  case "$GH_STUB_FAIL" in
    1) echo "stub: gh unavailable" >&2 ;;
    ratelimit) echo "gh: API rate limit exceeded for user ID 526899. If you reach out to GitHub Support for help, please include the request ID 1234:ABCD. (HTTP 403)" >&2 ;;
    ratelimit-rest) echo "HTTP 403: API rate limit exceeded for user ID 526899. (https://api.github.com/repos/intent-hq/cloudlands-releases/releases/tags/v2.3.0)" >&2 ;;
    5xx) echo "gh: Server Error (HTTP 502)" >&2 ;;
    network) echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2 ;;
    forbidden) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2 ;;
    *) echo "stub: unknown GH_STUB_FAIL $GH_STUB_FAIL" >&2 ;;
  esac
  exit 1
fi
case "$1 $2" in
  "release list")
    [[ "$*" == *"--repo intent-hq/cloudlands-releases"* ]] || exit 1
    cat "$GH_STUB_DIR/releases"
    [[ -f "$GH_STUB_DIR/releases.fail" ]] && { echo "stub: release list truncated" >&2; exit 1; }
    exit 0 ;;
  "api repos/"*)
    path=${2#repos/}
    if [[ "$path" == */actions/runs/*/jobs ]]; then
      [[ "$*" == *" --paginate"* ]] || { echo "stub: jobs fetched without --paginate" >&2; exit 1; }
      run_id=${path%/jobs}; run_id=${run_id##*/}
      file="$GH_STUB_DIR/jobs/$run_id.json"
    else
      repo=${path%%/compare/*}; range=${path##*/compare/}
      file="$GH_STUB_DIR/compare/${repo/\//__}/$range"
    fi
    [[ -f "$file" ]] || { echo "stub: 404 $2" >&2; exit 1; }
    cat "$file" ;;
  "run list")
    [[ "$*" == "run list --repo intent-hq/cloudlands-fe --workflow Release Alpha --limit 5 --json databaseId,status,url,displayTitle,createdAt" ]] || { echo "stub: unexpected run list args: $*" >&2; exit 1; }
    cat "$GH_STUB_DIR/runs.json" ;;
  "release download")
    [[ "$*" == *"--repo intent-hq/cloudlands-releases"*"--pattern release-manifest.json"*"--output -"* ]] || exit 1
    [[ -f "$GH_STUB_DIR/manifest/$3.json" ]] || { echo "stub: no manifest $3" >&2; exit 1; }
    cat "$GH_STUB_DIR/manifest/$3.json" ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
SH
chmod +x "$bin_dir/gh"

sha=66e5cb92c4858dd3119b1d12d369493bec69dfb2
fe_compare="$stub_dir/compare/intent-hq__cloudlands-fe"
intentd_compare="$stub_dir/compare/intent-hq__intentd"
manifest_dir="$stub_dir/manifest"

reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$fe_compare" "$intentd_compare" "$manifest_dir"
  printf '%s\n' v2.3.0 v2.2.0 v2.1.0 >"$stub_dir/releases"
  for tag in v2.3.0 v2.2.0 v2.1.0; do
    printf '{"version":"%s","intentdVersion":"0.9.%s"}\n' "${tag#v}" "${tag##*.}" >"$manifest_dir/$tag.json"
  done
  echo '[]' >"$stub_dir/runs.json"
  : >"$temp_dir/gh.log"
}

run_script() {
  set +e
  PATH="$bin_dir" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" \
    "$script_bash" "$script" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 0 ]] || fail "newest-tag hit exited $status: $stderr"
[[ "$stdout" == "v2.3.0 intentdVersion=0.9.0" ]] || fail "newest-tag hit printed '$stdout'"
grep -q -- '^release list --repo intent-hq/cloudlands-releases --limit 20 ' "$temp_dir/gh.log" || fail "default limit 10 was not over-fetched as 20"
! grep -q '^run list' "$temp_dir/gh.log" || fail "carried sha probed the Release Alpha run"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo identical >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha" --limit 3
[[ "$status" -eq 0 ]] || fail "older-tag hit exited $status: $stderr"
[[ "$stdout" == "v2.2.0 intentdVersion=0.9.0" ]] || fail "expected the oldest carrying tag, printed '$stdout'"
grep -q -- '^release list --repo intent-hq/cloudlands-releases --limit 13 ' "$temp_dir/gh.log" || fail "--limit 3 was not over-fetched as 13"

reset_stub
printf '%s\n' stable v2.3.0 alpha v2.2.0 beta v2.1.0 >"$stub_dir/releases"
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo identical >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha" --limit 2
[[ "$status" -eq 0 ]] || fail "channel-interleaved hit exited $status: $stderr"
[[ "$stdout" == "v2.3.0 intentdVersion=0.9.0" ]] || fail "channel-interleaved scan printed '$stdout' (v2.1.0 is outside --limit 2)"
! grep -q 'v2.1.0' "$temp_dir/gh.log" || fail "channel-interleaved scan inspected v2.1.0 beyond --limit 2"
! grep -qE 'compare/.*\.\.\.(stable|alpha|beta)$' "$temp_dir/gh.log" || fail "channel releases were compared"

reset_stub
echo behind >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "no-hit exited $status (expected 3): $stderr"
[[ -z "$stdout" ]] || fail "no-hit printed '$stdout'"
! grep -q '^release download' "$temp_dir/gh.log" || fail "no-hit downloaded a manifest"

reset_stub
echo diverged >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo diverged >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "behind/diverged counted as a hit (exit $status, stdout '$stdout')"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "compare API failure exited $status (expected 1)"
[[ -z "$stdout" ]] || fail "compare API failure printed '$stdout'"
[[ "$stderr" == *"stub: 404 repos/intent-hq/cloudlands-fe/compare/$sha...v2.2.0"* ]] || fail "compare API failure hid gh stderr: $stderr"

reset_stub
GH_STUB_FAIL=1 run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "gh failure exited $status (expected 1, not 3)"
[[ "$stderr" == *"stub: gh unavailable"* ]] || fail "gh failure hid gh stderr: $stderr"

# Transient GitHub failures exit 4 and surface gh's text so a polling hook can
# retry instead of evicting itself (intent-hq/intent rate-limit incident).
for mode in ratelimit ratelimit-rest 5xx network; do
  reset_stub
  GH_STUB_FAIL=$mode run_script cloudlands-fe "$sha"
  [[ "$status" -eq 4 ]] || fail "$mode on release list exited $status (expected 4): $stderr"
  [[ -z "$stdout" ]] || fail "$mode on release list printed '$stdout'"
  [[ "$stderr" == "shipped-in: gh release list on intent-hq/cloudlands-releases failed: "* ]] || fail "$mode on release list message: $stderr"
done
[[ "$stderr" == *"error connecting to api.github.com check your internet connection"* ]] || fail "multi-line gh stderr was not surfaced on one line: $stderr"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
GH_STUB_FAIL=ratelimit GH_STUB_FAIL_ON=api run_script cloudlands-fe "$sha"
[[ "$status" -eq 4 ]] || fail "rate-limited compare exited $status (expected 4): $stderr"
[[ "$stderr" == *"compare $sha...v2.3.0 on intent-hq/cloudlands-fe failed: gh: API rate limit exceeded for user ID 526899."* ]] || fail "rate-limited compare message: $stderr"
[[ "$stderr" == *"(HTTP 403)"* ]] || fail "rate-limited compare dropped the gh status: $stderr"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
GH_STUB_FAIL=ratelimit-rest GH_STUB_FAIL_ON="release download" run_script cloudlands-fe "$sha"
[[ "$status" -eq 4 ]] || fail "rate-limited fe manifest download exited $status (expected 4): $stderr"
[[ -z "$stdout" ]] || fail "rate-limited fe manifest download printed '$stdout'"
[[ "$stderr" == *"release download release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases failed: HTTP 403: API rate limit exceeded"* ]] || fail "rate-limited fe manifest message: $stderr"
[[ "$stderr" != *"could not read intentdVersion"* ]] || fail "rate-limited download was reported as a manifest parse failure: $stderr"

reset_stub
GH_STUB_FAIL=ratelimit GH_STUB_FAIL_ON="release download" run_script intentd "$sha"
[[ "$status" -eq 4 ]] || fail "rate-limited intentd manifest download exited $status (expected 4): $stderr"
[[ "$stderr" == *"release download release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases failed: gh: API rate limit exceeded"* ]] || fail "rate-limited intentd manifest message: $stderr"
! grep -q '^api ' "$temp_dir/gh.log" || fail "rate-limited intentd manifest download went on to compare"

reset_stub
GH_STUB_FAIL=forbidden run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "plain HTTP 403 exited $status (expected 1, not transient)"
[[ "$stderr" == *"Resource not accessible by personal access token (HTTP 403)"* ]] || fail "plain HTTP 403 hid gh stderr: $stderr"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
: >"$stub_dir/releases.fail"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "release list that printed tags then failed exited $status (expected 1)"
[[ -z "$stdout" ]] || fail "release list that printed tags then failed printed '$stdout'"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
rm "$manifest_dir/v2.3.0.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "fe hit with missing manifest exited $status (expected 1)"
[[ -z "$stdout" ]] || fail "fe hit with missing manifest printed '$stdout'"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
printf '{"version":"2.3.0"}\n' >"$manifest_dir/v2.3.0.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "fe hit with malformed manifest exited $status (expected 1)"
[[ -z "$stdout" ]] || fail "fe hit with malformed manifest printed '$stdout'"
[[ "$stderr" == "shipped-in: could not read intentdVersion from release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases" ]] || fail "malformed manifest message: $stderr"

reset_stub
printf '{"version":"2.3.0","intentdVersion":"0.9.5"}\n' >"$manifest_dir/v2.3.0.json"
printf '{"version":"2.2.0","intentdVersion":"0.9.5"}\n' >"$manifest_dir/v2.2.0.json"
printf '{"version":"2.1.0","intentdVersion":"0.9.4"}\n' >"$manifest_dir/v2.1.0.json"
echo ahead >"$intentd_compare/$sha...v0.9.5"
echo behind >"$intentd_compare/$sha...v0.9.4"
run_script intentd "$sha"
[[ "$status" -eq 0 ]] || fail "intentd hit exited $status: $stderr"
[[ "$stdout" == "v2.2.0 intentdVersion=0.9.5" ]] || fail "intentd hit printed '$stdout'"
[[ "$(grep -c "^api repos/intent-hq/intentd/compare/$sha...v0.9.5 " "$temp_dir/gh.log")" -eq 1 ]] || fail "intentd compare was not deduplicated per pinned version"
! grep -q '^api repos/intent-hq/cloudlands-fe/' "$temp_dir/gh.log" || fail "intentd lookup compared against cloudlands-fe"

reset_stub
echo ahead >"$intentd_compare/$sha...v0.9.0"
rm "$manifest_dir/v2.2.0.json"
run_script intentd "$sha"
[[ "$status" -eq 1 ]] || fail "missing manifest exited $status (expected 1)"
[[ "$stderr" == *"release download release-manifest.json for v2.2.0 on intent-hq/cloudlands-releases failed: stub: no manifest v2.2.0" ]] || fail "missing manifest hid gh stderr: $stderr"

# Several <component> <sha> pairs: the answer is the oldest tag carrying every
# pair, so a cross-component workspace can wait on one invocation.
sha2=d1ec26651cc3f101b740d3f970d7fd54bf4b0268
set_manifests() {
  printf '{"version":"2.3.0","intentdVersion":"%s"}\n' "$1" >"$manifest_dir/v2.3.0.json"
  printf '{"version":"2.2.0","intentdVersion":"%s"}\n' "$2" >"$manifest_dir/v2.2.0.json"
  printf '{"version":"2.1.0","intentdVersion":"%s"}\n' "$3" >"$manifest_dir/v2.1.0.json"
}

reset_stub
set_manifests 0.9.5 0.9.4 0.9.4
echo ahead >"$fe_compare/$sha...v2.3.0"
echo identical >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
echo ahead >"$intentd_compare/$sha2...v0.9.5"
echo behind >"$intentd_compare/$sha2...v0.9.4"
run_script cloudlands-fe "$sha" intentd "$sha2"
[[ "$status" -eq 0 ]] || fail "fe+intentd pair exited $status: $stderr"
[[ "$stdout" == "v2.3.0 intentdVersion=0.9.5" ]] || fail "fe+intentd pair printed '$stdout' (v2.2.0 carries fe but not intentd)"
grep -q "^api repos/intent-hq/cloudlands-fe/compare/$sha...v2.3.0 " "$temp_dir/gh.log" || fail "fe pair was not compared"
grep -q "^api repos/intent-hq/intentd/compare/$sha2...v0.9.5 " "$temp_dir/gh.log" || fail "intentd pair was not compared"

reset_stub
set_manifests 0.9.5 0.9.4 0.9.4
echo ahead >"$fe_compare/$sha...v2.3.0"
echo ahead >"$fe_compare/$sha...v2.2.0"
echo ahead >"$fe_compare/$sha...v2.1.0"
echo behind >"$intentd_compare/$sha2...v0.9.5"
echo behind >"$intentd_compare/$sha2...v0.9.4"
run_script cloudlands-fe "$sha" intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "uncarried intentd pair exited $status (expected 3): $stderr"
[[ -z "$stdout" ]] || fail "uncarried intentd pair printed '$stdout'"
[[ "$stderr" == "shipped-in: intentd $sha2 is not carried by the newest 3 release(s) on intent-hq/cloudlands-releases (newest v2.3.0)" ]] || fail "uncarried intentd pair message: $stderr"

reset_stub
echo behind >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
echo diverged >"$intentd_compare/$sha2...v0.9.0"
run_script cloudlands-fe "$sha" intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "two uncarried pairs exited $status (expected 3): $stderr"
[[ "$stderr" == "shipped-in: cloudlands-fe $sha, intentd $sha2 are not carried by the newest 3 release(s) on intent-hq/cloudlands-releases (newest v2.3.0)" ]] || fail "two uncarried pairs message: $stderr"

# Two intentd SHAs against the same pinned version must not share a cached
# compare status.
reset_stub
set_manifests 0.9.5 0.9.5 0.9.4
echo ahead >"$intentd_compare/$sha...v0.9.5"
echo ahead >"$intentd_compare/$sha...v0.9.4"
echo ahead >"$intentd_compare/$sha2...v0.9.5"
echo behind >"$intentd_compare/$sha2...v0.9.4"
run_script intentd "$sha" intentd "$sha2"
[[ "$status" -eq 0 ]] || fail "two intentd pairs exited $status: $stderr"
[[ "$stdout" == "v2.2.0 intentdVersion=0.9.5" ]] || fail "two intentd pairs printed '$stdout' (v2.1.0 carries $sha but not $sha2)"
for range in "$sha...v0.9.5" "$sha...v0.9.4" "$sha2...v0.9.5" "$sha2...v0.9.4"; do
  [[ "$(grep -c "^api repos/intent-hq/intentd/compare/$range " "$temp_dir/gh.log")" -eq 1 ]] || fail "intentd compare $range was not run exactly once"
done
for tag in v2.3.0 v2.1.0; do
  [[ "$(grep -c "^release download $tag " "$temp_dir/gh.log")" -eq 1 ]] || fail "manifest for $tag was downloaded once per intentd pair instead of once per tag"
done

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
GH_STUB_FAIL=ratelimit GH_STUB_FAIL_ON="api repos/intent-hq/intentd/compare/$sha2...v0.9.0" run_script cloudlands-fe "$sha" intentd "$sha2"
[[ "$status" -eq 4 ]] || fail "rate-limited second pair exited $status (expected 4): $stderr"
[[ -z "$stdout" ]] || fail "rate-limited second pair printed '$stdout'"
[[ "$stderr" == *"compare $sha2...v0.9.0 on intent-hq/intentd failed: gh: API rate limit exceeded"* ]] || fail "rate-limited second pair message: $stderr"
grep -q "^api repos/intent-hq/cloudlands-fe/compare/$sha...v2.3.0 " "$temp_dir/gh.log" || fail "first pair was not checked before the second pair failed"

reset_stub
set_manifests 0.9.5 0.9.4 0.9.3
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo identical >"$fe_compare/$sha...v2.1.0"
echo ahead >"$intentd_compare/$sha2...v0.9.5"
echo behind >"$intentd_compare/$sha2...v0.9.4"
echo ahead >"$intentd_compare/$sha2...v0.9.3"
run_script cloudlands-fe "$sha" intentd "$sha2" --limit 2
[[ "$status" -eq 0 ]] || fail "multi-pair --limit 2 exited $status: $stderr"
[[ "$stdout" == "v2.3.0 intentdVersion=0.9.5" ]] || fail "multi-pair --limit 2 printed '$stdout' (v2.1.0 is outside the limit)"
grep -q -- '^release list --repo intent-hq/cloudlands-releases --limit 12 ' "$temp_dir/gh.log" || fail "multi-pair --limit 2 was not over-fetched as 12"
! grep -q 'v2.1.0' "$temp_dir/gh.log" || fail "multi-pair --limit 2 inspected v2.1.0"
run_script cloudlands-fe "$sha" --limit=2 intentd "$sha2"
[[ "$status" -eq 0 && "$stdout" == "v2.3.0 intentdVersion=0.9.5" ]] || fail "--limit between pairs exited $status with '$stdout': $stderr"

# Stall detection: on the exit-3 path the active cloudlands-fe Release Alpha
# run is probed and a job queued past SHIPPED_IN_STALL_MINUTES turns exit 3
# into exit 5 (intent-hq/cloudlands-fe run 34716428577 sat queued for hours
# on an unserved runner label while hooks kept reporting "not cut yet").
run_id=34716428577
run_url="https://github.com/intent-hq/cloudlands-fe/actions/runs/$run_id"
stalled_job='build-linux (arm64, gh-linux-arm64-8x)'
jobs_call="api repos/intent-hq/cloudlands-fe/actions/runs/$run_id/jobs --paginate"
not_carried_line="shipped-in: $sha is not carried by the newest 3 release(s) on intent-hq/cloudlands-releases (newest v2.3.0)"

set_uncarried_fe() {
  echo behind >"$fe_compare/$sha...v2.3.0"
  echo behind >"$fe_compare/$sha...v2.2.0"
  echo behind >"$fe_compare/$sha...v2.1.0"
}
minutes_ago() {
  python3 -c 'import datetime, sys; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"
}
run_url_of() {
  printf 'https://github.com/intent-hq/cloudlands-fe/actions/runs/%s\n' "$1"
}
# The `gh run list` payload from "<run id>|<status>|<created minutes ago>"
# specs, newest first as gh lists them.
set_release_runs() {
  local runs="" spec id run_status
  for spec in "$@"; do
    id=${spec%%|*}; spec=${spec#*|}; run_status=${spec%%|*}
    runs+=$(printf '%s{"databaseId":%s,"status":"%s","url":"%s","displayTitle":"Release Alpha","createdAt":"%s"}' "${runs:+,}" "$id" "$run_status" "$(run_url_of "$id")" "$(minutes_ago "${spec#*|}")")
  done
  printf '[%s]\n' "$runs" >"$stub_dir/runs.json"
}
set_release_run() {
  set_release_runs "$run_id|$1|60"
}
# One REST jobs page from "<name>|<status>|<minutes ago>" specs.
jobs_page() {
  local jobs="" spec name job_status
  for spec in "$@"; do
    name=${spec%%|*}; spec=${spec#*|}; job_status=${spec%%|*}
    jobs+=$(printf '%s{"name":"%s","status":"%s","created_at":"%s"}' "${jobs:+,}" "$name" "$job_status" "$(minutes_ago "${spec#*|}")")
  done
  printf '{"total_count":%d,"jobs":[%s]}\n' "$#" "$jobs"
}
set_run_jobs() {
  local id=$1
  shift
  mkdir -p "$stub_dir/jobs"
  jobs_page "$@" >"$stub_dir/jobs/$id.json"
}
set_release_jobs() {
  set_run_jobs "$run_id" "$@"
}

reset_stub
set_uncarried_fe
set_release_run in_progress
set_release_jobs "build-macos|completed|45" "$stalled_job|queued|45" "publish|queued|2"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "stalled Release Alpha run exited $status (expected 5): $stderr"
[[ -z "$stdout" ]] || fail "stalled Release Alpha run printed '$stdout'"
since=$(python3 -c 'import json, sys; print([j for j in json.load(sys.stdin)["jobs"] if j["name"] == sys.argv[1]][0]["created_at"])' "$stalled_job" <"$stub_dir/jobs/$run_id.json")
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha run $run_url stalled: job \"$stalled_job\" queued for 45 min (since $since)" ]] || fail "stalled Release Alpha run message: $stderr"
grep -q "^$jobs_call\$" "$temp_dir/gh.log" || fail "jobs were not fetched via the paginated REST endpoint"

# A run that is `queued` at run level (the incident shape: the run never left
# queued while its only job waited on an unserved label) is probed the same way.
reset_stub
set_uncarried_fe
set_release_run queued
set_release_jobs "$stalled_job|queued|31"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "queued Release Alpha run with a stalled job exited $status (expected 5): $stderr"
[[ "$stderr" == *"stalled: job \"$stalled_job\" queued for 31 min"* ]] || fail "queued Release Alpha run message: $stderr"

# Release Alpha runs share the `cloudlands-release` concurrency group without
# cancel-in-progress: a newer tag's run sits entirely queued behind the run
# holding the group. Only the oldest active run is probed.
newer_run_id=34716500000
older_run_id=34716400000
reset_stub
set_uncarried_fe
set_release_runs "$newer_run_id|queued|40" "$older_run_id|in_progress|55" "34716300000|completed|300"
set_run_jobs "$newer_run_id" "build-macos|queued|40" "$stalled_job|queued|40" "publish|queued|40"
set_run_jobs "$older_run_id" "build-macos|completed|55" "$stalled_job|in_progress|55" "publish|queued|1"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "newer run queued behind an in-progress run exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line" ]] || fail "newer run queued behind an in-progress run changed stderr: $stderr"
grep -q "^api repos/intent-hq/cloudlands-fe/actions/runs/$older_run_id/jobs --paginate\$" "$temp_dir/gh.log" || fail "jobs of the older active run were not fetched"
! grep -q "^api repos/intent-hq/cloudlands-fe/actions/runs/$newer_run_id/" "$temp_dir/gh.log" || fail "jobs of the newer run waiting on the concurrency group were fetched"

reset_stub
set_uncarried_fe
set_release_runs "$newer_run_id|queued|20" "$older_run_id|in_progress|70"
set_run_jobs "$newer_run_id" "$stalled_job|queued|20"
set_run_jobs "$older_run_id" "build-macos|completed|70" "$stalled_job|queued|50"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "older active run with a stalled job exited $status (expected 5): $stderr"
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha run $(run_url_of "$older_run_id") stalled: job \"$stalled_job\" queued for 50 min"* ]] || fail "older active run stall message: $stderr"
! grep -q "^api repos/intent-hq/cloudlands-fe/actions/runs/$newer_run_id/" "$temp_dir/gh.log" || fail "the newer queued run was probed alongside the older one"

# Completed runs are never candidates, whatever the listing order.
reset_stub
set_uncarried_fe
set_release_runs "$newer_run_id|completed|20" "$older_run_id|queued|50"
set_run_jobs "$older_run_id" "$stalled_job|queued|50"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "active run behind a completed newer run exited $status (expected 5): $stderr"
[[ "$stderr" == *"Release Alpha run $(run_url_of "$older_run_id") stalled"* ]] || fail "active run behind a completed newer run message: $stderr"

# --paginate emits one JSON object per page; a stalled job on a later page
# still counts.
reset_stub
set_uncarried_fe
set_release_run in_progress
mkdir -p "$stub_dir/jobs"
{ jobs_page "build-macos|in_progress|40"; jobs_page "$stalled_job|queued|40"; } >"$stub_dir/jobs/$run_id.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "stalled job on the second jobs page exited $status (expected 5): $stderr"
[[ "$stderr" == *"job \"$stalled_job\" queued for 40 min"* ]] || fail "second-page stall message: $stderr"

# intentd-only changes ride the same fe Release Alpha run.
reset_stub
echo behind >"$intentd_compare/$sha2...v0.9.0"
set_release_run in_progress
set_release_jobs "$stalled_job|queued|45"
run_script intentd "$sha2"
[[ "$status" -eq 5 ]] || fail "stalled run for an intentd pair exited $status (expected 5): $stderr"
[[ "$stderr" == *"$sha2 is not carried by"*$'\n'*"Release Alpha run $run_url stalled"* ]] || fail "intentd stall message: $stderr"

reset_stub
set_uncarried_fe
set_release_run in_progress
set_release_jobs "build-macos|completed|20" "$stalled_job|queued|10" "publish|queued|1"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "queued job under the threshold exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line" ]] || fail "queued job under the threshold changed stderr: $stderr"

reset_stub
set_uncarried_fe
set_release_run in_progress
set_release_jobs "build-macos|completed|90" "$stalled_job|in_progress|90" "publish|queued|0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "in-progress jobs exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line" ]] || fail "in-progress jobs changed stderr: $stderr"

reset_stub
set_uncarried_fe
set_release_runs "$run_id|completed|60" "$older_run_id|completed|400"
set_release_jobs "$stalled_job|queued|500"
set_run_jobs "$older_run_id" "$stalled_job|queued|500"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "all runs completed exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line" ]] || fail "all runs completed changed stderr: $stderr"
grep -q '^run list ' "$temp_dir/gh.log" || fail "completed runs were not listed"
! grep -q '^api repos/intent-hq/cloudlands-fe/actions/runs/' "$temp_dir/gh.log" || fail "a completed run had its jobs fetched"

reset_stub
set_uncarried_fe
echo '[]' >"$stub_dir/runs.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "no Release Alpha run exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line" ]] || fail "no Release Alpha run changed stderr: $stderr"
! grep -q '^api repos/intent-hq/cloudlands-fe/actions/runs/' "$temp_dir/gh.log" || fail "no Release Alpha run still fetched jobs"

reset_stub
set_uncarried_fe
set_release_run in_progress
set_release_jobs "$stalled_job|queued|10"
SHIPPED_IN_STALL_MINUTES=5 run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "SHIPPED_IN_STALL_MINUTES=5 with a 10 min queue exited $status (expected 5): $stderr"
[[ "$stderr" == *"queued for 10 min"* ]] || fail "SHIPPED_IN_STALL_MINUTES=5 message: $stderr"
SHIPPED_IN_STALL_MINUTES=11 run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "SHIPPED_IN_STALL_MINUTES=11 with a 10 min queue exited $status (expected 3): $stderr"
# A leading zero must read as decimal, not octal.
SHIPPED_IN_STALL_MINUTES=08 run_script cloudlands-fe "$sha"
[[ "$status" -eq 5 ]] || fail "SHIPPED_IN_STALL_MINUTES=08 with a 10 min queue exited $status (expected 5): $stderr"
[[ "$stderr" != *"too great for base"* ]] || fail "SHIPPED_IN_STALL_MINUTES=08 was parsed as octal: $stderr"
for disabled in 0 00; do
  : >"$temp_dir/gh.log"
  SHIPPED_IN_STALL_MINUTES=$disabled run_script cloudlands-fe "$sha"
  [[ "$status" -eq 3 ]] || fail "SHIPPED_IN_STALL_MINUTES=$disabled exited $status (expected 3): $stderr"
  [[ "$stderr" == "$not_carried_line" ]] || fail "SHIPPED_IN_STALL_MINUTES=$disabled changed stderr: $stderr"
  ! grep -q '^run list' "$temp_dir/gh.log" || fail "SHIPPED_IN_STALL_MINUTES=$disabled still listed Release Alpha runs"
done
SHIPPED_IN_STALL_MINUTES=soon run_script cloudlands-fe "$sha"
[[ "$status" -eq 2 ]] || fail "non-numeric SHIPPED_IN_STALL_MINUTES exited $status (expected 2)"
[[ "$stderr" == *"SHIPPED_IN_STALL_MINUTES must be a non-negative integer"* ]] || fail "non-numeric SHIPPED_IN_STALL_MINUTES message: $stderr"

# The probe is best-effort: its failures never turn exit 3 into 1/4/5.
for mode in 1 ratelimit; do
  reset_stub
  set_uncarried_fe
  set_release_run in_progress
  set_release_jobs "$stalled_job|queued|500"
  GH_STUB_FAIL=$mode GH_STUB_FAIL_ON="run list" run_script cloudlands-fe "$sha"
  [[ "$status" -eq 3 ]] || fail "run list failure ($mode) exited $status (expected 3): $stderr"
  [[ -z "$stdout" ]] || fail "run list failure ($mode) printed '$stdout'"
  [[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha stall probe skipped: gh run list on intent-hq/cloudlands-fe failed: "* ]] || fail "run list failure ($mode) message: $stderr"
done
[[ "$stderr" == *"gh: API rate limit exceeded for user ID 526899."* ]] || fail "run list failure hid gh stderr: $stderr"

reset_stub
set_uncarried_fe
set_release_run in_progress
set_release_jobs "$stalled_job|queued|500"
GH_STUB_FAIL=5xx GH_STUB_FAIL_ON="api repos/intent-hq/cloudlands-fe/actions/runs/$run_id/jobs" run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "jobs failure exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha stall probe skipped: gh api jobs for Release Alpha run $run_id on intent-hq/cloudlands-fe failed: gh: Server Error (HTTP 502)" ]] || fail "jobs failure message: $stderr"

reset_stub
set_uncarried_fe
set_release_run in_progress
mkdir -p "$stub_dir/jobs"
echo '{"jobs": [' >"$stub_dir/jobs/$run_id.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "malformed jobs payload exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha stall probe skipped: could not read the jobs of Release Alpha run $run_id on intent-hq/cloudlands-fe: "* ]] || fail "malformed jobs payload message: $stderr"

reset_stub
set_uncarried_fe
set_release_run in_progress
mkdir -p "$stub_dir/jobs"
printf '{"total_count":1,"jobs":[{"name":"%s","status":"queued","created_at":"yesterday"}]}\n' "$stalled_job" >"$stub_dir/jobs/$run_id.json"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "malformed job timestamp exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha stall probe skipped: could not read the jobs of Release Alpha run $run_id on intent-hq/cloudlands-fe: "* ]] || fail "malformed job timestamp message: $stderr"

reset_stub
set_uncarried_fe
echo '[{"databaseId":' >"$stub_dir/runs.json"
set_release_jobs "$stalled_job|queued|500"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "malformed run list exited $status (expected 3): $stderr"
[[ "$stderr" == "$not_carried_line"$'\n'"shipped-in: Release Alpha stall probe skipped: could not read the active Release Alpha runs on intent-hq/cloudlands-fe: "* ]] || fail "malformed run list message: $stderr"
! grep -q '^api repos/intent-hq/cloudlands-fe/actions/runs/' "$temp_dir/gh.log" || fail "malformed run list still fetched jobs"

reset_stub
run_script cloudlands-fe "$sha" intentd
[[ "$status" -eq 2 ]] || fail "odd positional count exited $status (expected 2)"
run_script cloudlands-fe "$sha" ios "$sha2"
[[ "$status" -eq 2 ]] || fail "unknown component in second pair exited $status (expected 2)"
run_script cloudlands-fe "$sha" intentd main
[[ "$status" -eq 2 ]] || fail "non-sha ref in second pair exited $status (expected 2)"
run_script ios "$sha"
[[ "$status" -eq 2 ]] || fail "unknown component exited $status (expected 2)"
run_script cloudlands-fe main
[[ "$status" -eq 2 ]] || fail "non-sha ref exited $status (expected 2)"
run_script cloudlands-fe "$sha" --limit 0
[[ "$status" -eq 2 ]] || fail "--limit 0 exited $status (expected 2)"
! grep -q '^release list' "$temp_dir/gh.log" || fail "usage errors reached gh"

echo "shipped-in tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${SHIPPED_IN_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4706). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found:
# BASH3_BIN, a bash3 on PATH, Homebrew bash@3, or a 3.x /bin/bash. The
# pattern gate is a best-effort guard for hosts without a Bash 3; the real
# Bash 3 fixture run is the authoritative check.
bash -n "$script" || fail "shipped-in.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "shipped-in.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments, the pattern itself and the gate_sample table below are
# not scanned.
gate_matches() {
  grep -nE "$bash4_constructs" "$@" | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' |
    grep -v -F -e 'bash4_constructs' -e 'gate_sample' || true
}
gate_sample() {
  local expected=$1 sample=$2 hit
  hit=$(printf '%s\n' "$sample" | gate_matches)
  case "$expected:${hit:+hit}" in
    hit:hit | miss:) ;;
    *) fail "gate regex $expected sample misclassified: $sample" ;;
  esac
}
gate_sample hit 'declare -A m=()'
gate_sample hit 'local -gA x'
gate_sample hit 'declare -r -A cache=()'
gate_sample hit 'declare -Ar cache=()'
gate_sample hit 'declare -Ax cache=()'
gate_sample hit 'declare -r -Ax cache=()'
gate_sample hit $'declare\t-A m'
gate_sample hit 'typeset -n ref=x'
gate_sample hit 'local -nr ref=x'
gate_sample hit 'typeset -Anr ref=x'
gate_sample hit 'mapfile -t a'
gate_sample hit 'readarray a <f'
gate_sample hit 'coproc x'
gate_sample hit 'echo ${var,,}'
gate_sample hit 'echo ${var^^}'
gate_sample hit 'echo ${var^}'
gate_sample hit 'echo ${1^^}'
gate_sample hit 'echo ${@,,}'
gate_sample hit 'echo ${arr[1],,[a-z]}'
gate_sample hit 'cmd &>> log'
gate_sample hit 'cmd |& tee'
gate_sample hit 'x) y ;;&'
gate_sample hit 'x) y ;&'
gate_sample miss 'local head=$1 status'
gate_sample miss 'declare -a arr'
gate_sample miss 'local -r x=1'
gate_sample miss 'echo ${record%% *}'
gate_sample miss 'echo ${1#--limit=}'
gate_sample miss 'echo ${tags[0]}'
gate_sample miss 'echo ${repo/\//__}'
gate_sample miss 'a || b'
gate_sample miss 'x) y ;;'
gate_sample miss 'echo ${tag##*.}'
gate_sample miss 'cmd 2>&1 >>log'
gate_sample miss '# mapfile is unavailable on Bash 3'
gate_sample miss 'readarray_count=0'
gate_sample miss 'my_coproc=1'
gate_hits=$(gate_matches "$script" "${BASH_SOURCE[0]}")
[[ -z "$gate_hits" ]] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

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
  SHIPPED_IN_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
else
  echo "shipped-in tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
