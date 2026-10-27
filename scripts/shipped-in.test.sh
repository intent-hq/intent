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
# The intentd release-plz probe reads main HEAD from $GH_STUB_DIR/intentd-head,
# open Release PR numbers (post --jq) from $GH_STUB_DIR/intentd-prs, Release-plz
# runs from $GH_STUB_DIR/intentd-runs.json, their jobs from the same jobs/
# directory, crates/intentd/Cargo.toml from $GH_STUB_DIR/intentd-cargo.toml and
# tag commits from $GH_STUB_DIR/intentd-tags/<tag>. Once main HEAD was read,
# $GH_STUB_DIR/intentd-head.next (if any) answers later reads (main moved).
# A stub file holding "@404" answers like gh does for a missing ref.
# The rate-limit probe (`api repos/intent-hq/cloudlands-releases`) succeeds
# unless $GH_STUB_DIR/probe.fail exists; its content names the failure mode
# (one of the modes below, empty = ratelimit).
# Every invocation is appended to GH_TEST_LOG.
# GH_STUB_FAIL selects a failure mode (1 = generic, or one of the gh error
# texts below); GH_STUB_FAIL_ON narrows it to one subcommand ("release list",
# "api", "release download", "run list"), default every call.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
stub_fail() {
  case "$1" in
    1) echo "stub: gh unavailable" >&2 ;;
    ratelimit) echo "gh: API rate limit exceeded for user ID 526899. If you reach out to GitHub Support for help, please include the request ID 1234:ABCD. (HTTP 403)" >&2 ;;
    ratelimit-rest) echo "HTTP 403: API rate limit exceeded for user ID 526899. (https://api.github.com/repos/intent-hq/cloudlands-releases/releases/tags/v2.3.0)" >&2 ;;
    5xx) echo "gh: Server Error (HTTP 502)" >&2 ;;
    network) echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2 ;;
    forbidden) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2 ;;
    notfound) echo "release not found" >&2 ;;
    *) echo "stub: unknown failure mode $1" >&2 ;;
  esac
  exit 1
}
fail_on=${GH_STUB_FAIL_ON:-}
if [[ -n "${GH_STUB_FAIL:-}" && ( -z "$fail_on" || "$fail_on" == "$1" || "$fail_on" == "$1 $2" ) ]]; then
  stub_fail "$GH_STUB_FAIL"
fi
case "$1 $2" in
  "release list")
    [[ "$*" == *"--repo intent-hq/cloudlands-releases"* ]] || exit 1
    cat "$GH_STUB_DIR/releases"
    [[ -f "$GH_STUB_DIR/releases.fail" ]] && { echo "stub: release list truncated" >&2; exit 1; }
    exit 0 ;;
  "api repos/"*)
    path=${2#repos/}
    if [[ "$path" == intent-hq/cloudlands-releases && $# -eq 2 ]]; then
      if [[ -f "$GH_STUB_DIR/probe.fail" ]]; then
        probe_mode=$(<"$GH_STUB_DIR/probe.fail")
        stub_fail "${probe_mode:-ratelimit}"
      fi
      echo '{"full_name":"intent-hq/cloudlands-releases"}'
      exit 0
    fi
    bare=${path%%\?*}
    if [[ "$bare" == intent-hq/intentd/git/ref/heads/main ]]; then
      file="$GH_STUB_DIR/intentd-head"
      if [[ -f "$GH_STUB_DIR/intentd-head.read" && -f "$GH_STUB_DIR/intentd-head.next" ]]; then
        file="$GH_STUB_DIR/intentd-head.next"
      fi
      : >"$GH_STUB_DIR/intentd-head.read"
    elif [[ "$bare" == intent-hq/intentd/commits/* ]]; then
      file="$GH_STUB_DIR/intentd-tags/${bare##*/}"
    elif [[ "$bare" == intent-hq/intentd/pulls ]]; then
      [[ "$path" == *"state=open&per_page=100" && "$*" == *" --paginate "* ]] || { echo "stub: unexpected pulls call $*" >&2; exit 1; }
      file="$GH_STUB_DIR/intentd-prs"
    elif [[ "$bare" == intent-hq/intentd/contents/crates/intentd/Cargo.toml ]]; then
      [[ "$path" == *"?ref=$(<"$GH_STUB_DIR/intentd-head")" && "$*" == *"-H Accept: application/vnd.github.raw+json"* ]] || { echo "stub: unexpected Cargo.toml call $*" >&2; exit 1; }
      file="$GH_STUB_DIR/intentd-cargo.toml"
    elif [[ "$bare" == intent-hq/intentd/actions/workflows/release-plz.yml/runs ]]; then
      [[ "$path" == *"branch=main&event=push&head_sha=$(<"$GH_STUB_DIR/intentd-head")&"* ]] || { echo "stub: unexpected Release-plz runs query $path" >&2; exit 1; }
      file="$GH_STUB_DIR/intentd-runs.json"
    elif [[ "$bare" == */actions/runs/*/jobs ]]; then
      [[ "$*" == *" --paginate"* ]] || { echo "stub: jobs fetched without --paginate" >&2; exit 1; }
      run_id=${bare%/jobs}; run_id=${run_id##*/}
      file="$GH_STUB_DIR/jobs/$run_id.json"
    else
      repo=${path%%/compare/*}; range=${path##*/compare/}
      file="$GH_STUB_DIR/compare/${repo/\//__}/$range"
    fi
    [[ -f "$file" ]] || { echo "stub: 404 $2" >&2; exit 1; }
    [[ "$(<"$file")" != "@404" ]] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
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
intentd_head=ff77764f0a1b2c3d4e5f60718293a4b5c6d7e8f9
baseline_sha=fb29506f6c16005708a9a81c61b0b38879deddae
fe_compare="$stub_dir/compare/intent-hq__cloudlands-fe"
intentd_compare="$stub_dir/compare/intent-hq__intentd"
manifest_dir="$stub_dir/manifest"

# The version released at intentd main HEAD; its tag commit is the baseline
# the no-op proof names unless a second argument overrides it.
set_intentd_version() {
  printf '[package]\nname = "intentd"\nversion = "%s"\n\n[dependencies]\nintent-core = { version = "0.0.1" }\n' "$1" >"$stub_dir/intentd-cargo.toml"
  mkdir -p "$stub_dir/intentd-tags"
  echo "${2:-$baseline_sha}" >"$stub_dir/intentd-tags/v$1"
}

reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$fe_compare" "$intentd_compare" "$manifest_dir"
  printf '%s\n' v2.3.0 v2.2.0 v2.1.0 >"$stub_dir/releases"
  for tag in v2.3.0 v2.2.0 v2.1.0; do
    printf '{"version":"%s","intentdVersion":"0.9.%s"}\n' "${tag#v}" "${tag##*.}" >"$manifest_dir/$tag.json"
  done
  echo '[]' >"$stub_dir/runs.json"
  # Neutral release-plz state: no open Release PR and no run for HEAD yet.
  echo "$intentd_head" >"$stub_dir/intentd-head"
  : >"$stub_dir/intentd-prs"
  echo '{"total_count":0,"workflow_runs":[]}' >"$stub_dir/intentd-runs.json"
  set_intentd_version 0.9.0
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
# Carriage is monotonic across tags: once the newest tag misses the pair no
# older tag can carry it, so the scan stops there.
! grep -qE "^api repos/intent-hq/cloudlands-fe/compare/$sha\.\.\.v2\.[21]\.0 " "$temp_dir/gh.log" || fail "no-hit compared against older tags after the newest tag missed"

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

# A failure that does not look transient is followed by exactly one REST
# probe on the releases repo before it counts as a hard failure.
probe_call='api repos/intent-hq/cloudlands-releases'
probe_count() {
  grep -c "^$probe_call\$" "$temp_dir/gh.log" || true
}

reset_stub
GH_STUB_FAIL=1 run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "gh failure exited $status (expected 1, not 3)"
[[ "$stderr" == *"stub: gh unavailable"* ]] || fail "gh failure hid gh stderr: $stderr"
[[ "$(probe_count)" -eq 1 ]] || fail "generic gh failure ran the rate-limit probe $(probe_count) times (expected 1)"

# Transient GitHub failures exit 4 and surface gh's text so a polling hook can
# retry instead of evicting itself (intent-hq/intent rate-limit incident).
for mode in ratelimit ratelimit-rest 5xx network; do
  reset_stub
  GH_STUB_FAIL=$mode run_script cloudlands-fe "$sha"
  [[ "$status" -eq 4 ]] || fail "$mode on release list exited $status (expected 4): $stderr"
  [[ -z "$stdout" ]] || fail "$mode on release list printed '$stdout'"
  [[ "$stderr" == "shipped-in: gh release list on intent-hq/cloudlands-releases failed: "* ]] || fail "$mode on release list message: $stderr"
  [[ "$(probe_count)" -eq 0 ]] || fail "$mode on release list ran the rate-limit probe despite the transient fast path"
done
[[ "$stderr" == *"error connecting to api.github.com check your internet connection"* ]] || fail "multi-line gh stderr was not surfaced on one line: $stderr"

# Under REST throttling gh masks the 403 as `release not found` (2026-09-22,
# workspace frosty-beaver: the "Wait for shipped alpha" hook was evicted with
# exit 1); a rate-limited follow-up probe reclassifies it as transient.
reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
: >"$stub_dir/probe.fail"
GH_STUB_FAIL=notfound GH_STUB_FAIL_ON="release download" run_script cloudlands-fe "$sha"
[[ "$status" -eq 4 ]] || fail "masked rate limit on release download exited $status (expected 4): $stderr"
[[ -z "$stdout" ]] || fail "masked rate limit on release download printed '$stdout'"
[[ "$stderr" == "shipped-in: gh release download release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases failed: release not found (GitHub REST API is rate limited: gh: API rate limit exceeded for user ID 526899."*"(HTTP 403))" ]] || fail "masked rate limit message: $stderr"
[[ "$(probe_count)" -eq 1 ]] || fail "masked rate limit ran the probe $(probe_count) times (expected 1)"

# A probe failing transiently for another reason (5xx, network) also exits 4,
# but is reported as unavailable rather than rate limited (PR #5681 review).
for mode in 5xx network; do
  reset_stub
  echo ahead >"$fe_compare/$sha...v2.3.0"
  echo behind >"$fe_compare/$sha...v2.2.0"
  echo behind >"$fe_compare/$sha...v2.1.0"
  echo "$mode" >"$stub_dir/probe.fail"
  GH_STUB_FAIL=notfound GH_STUB_FAIL_ON="release download" run_script cloudlands-fe "$sha"
  [[ "$status" -eq 4 ]] || fail "release not found with $mode probe exited $status (expected 4): $stderr"
  [[ -z "$stdout" ]] || fail "release not found with $mode probe printed '$stdout'"
  [[ "$stderr" == "shipped-in: gh release download release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases failed: release not found (GitHub REST API is unavailable: "*")" ]] || fail "release not found with $mode probe message: $stderr"
  ! grep -qi 'rate limit' <<<"$stderr" || fail "$mode probe was reported as rate limited: $stderr"
  [[ "$(probe_count)" -eq 1 ]] || fail "release not found with $mode probe ran the probe $(probe_count) times (expected 1)"
done
[[ "$stderr" == *"(GitHub REST API is unavailable: error connecting to api.github.com check your internet connection or https://githubstatus.com)" ]] || fail "multi-line probe stderr was not surfaced on one line: $stderr"

# The same gh text with a healthy probe is a genuinely missing release.
reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
GH_STUB_FAIL=notfound GH_STUB_FAIL_ON="release download" run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "genuinely missing release exited $status (expected 1): $stderr"
[[ -z "$stdout" ]] || fail "genuinely missing release printed '$stdout'"
[[ "$stderr" == "shipped-in: gh release download release-manifest.json for v2.3.0 on intent-hq/cloudlands-releases failed: release not found" ]] || fail "genuinely missing release message: $stderr"
! grep -qi 'rate limit' <<<"$stderr" || fail "genuinely missing release was reported as rate limited: $stderr"
[[ "$(probe_count)" -eq 1 ]] || fail "genuinely missing release ran the probe $(probe_count) times (expected 1)"

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
[[ "$(grep -c '^release download ' "$temp_dir/gh.log")" -eq 1 ]] || fail "uncarried intentd pair downloaded manifests beyond the newest tag"
! grep -q '^release download v2\.[21]\.0 ' "$temp_dir/gh.log" || fail "uncarried intentd pair downloaded an older tag's manifest"
! grep -q "^api repos/intent-hq/intentd/compare/$sha2...v0.9.4 " "$temp_dir/gh.log" || fail "uncarried intentd pair compared against an older pinned intentd version"
! grep -qE "^api repos/intent-hq/cloudlands-fe/compare/$sha\.\.\.v2\.[21]\.0 " "$temp_dir/gh.log" || fail "uncarried intentd pair compared fe against older tags"

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

# Release-plz verdict: when an intentd pair is uncarried, on intentd main and
# newer than the version released there, the newest completed Release-plz
# push run for intentd main HEAD decides between "a release is coming"
# (exit 3), "a Release-plz job failed, re-run it" (exit 5) and "release-plz
# confirmed no release is needed" (exit 6). intentd#2726 (87762398b) waited
# ~6 h behind a failed Release-plz PR job (run 40430078531, a crates.io
# network error) while every poll answered "not yet".
rp_run_id=40430078531
rp_run_url="https://github.com/intent-hq/intentd/actions/runs/$rp_run_id"
rp_old_run_id=40428021927
noop_job() {
  printf 'Release-plz no release needed: %s@%s\n' "$1" "$baseline_sha"
}
unrendered_noop_job='Release-plz no release needed: ${{ needs.release-plz-pr.outputs.baseline_tag }}@${{ needs.release-plz-pr.outputs.baseline_sha }}'
intentd_not_carried_line="shipped-in: $sha2 is not carried by the newest 3 release(s) on intent-hq/cloudlands-releases (newest v2.3.0)"
noop_line() {
  printf 'shipped-in: %s: no intentd release needed -- release-plz found no package changes on main %s since %s (%s); it ships with the next intentd release that changes a package\n' \
    "$1" "$intentd_head" "$2" "$rp_run_url"
}
failed_line() {
  printf 'shipped-in: the intentd %s job concluded %s on main %s (%s); %s wait on the next intentd release (after %s), which cannot start until someone re-runs it\n' \
    "$1" "$2" "$intentd_head" "$rp_run_url" "$sha2" "${3:-v0.9.0}"
}

# Each spec is "<run id>|<run number>|<head sha>[|<status>[|<conclusion>]]"
# (default completed, success).
set_release_plz_runs() {
  local spec id number head run_status conclusion runs=""
  for spec in "$@"; do
    IFS='|' read -r id number head run_status conclusion <<<"$spec"
    run_status=${run_status:-completed}
    if [[ "$run_status" != completed ]]; then
      conclusion=null
    else
      conclusion="\"${conclusion:-success}\""
    fi
    runs+="${runs:+,}{\"id\":$id,\"run_number\":$number,\"head_sha\":\"$head\",\"status\":\"$run_status\",\"conclusion\":$conclusion,\"html_url\":\"https://github.com/intent-hq/intentd/actions/runs/$id\"}"
  done
  printf '{"total_count":%d,"workflow_runs":[%s]}\n' "$#" "$runs" >"$stub_dir/intentd-runs.json"
}

# Each spec is "<job name>|<status>|<conclusion or empty>".
set_release_plz_jobs() {
  local run=$1 spec name job_status conclusion jobs=""
  shift
  for spec in "$@"; do
    name=${spec%|*|*}
    spec=${spec#"$name|"}
    IFS='|' read -r job_status conclusion <<<"$spec"
    jobs+="${jobs:+,}$(python3 -c 'import json, sys; print(json.dumps({"name": sys.argv[1], "status": sys.argv[2], "conclusion": sys.argv[3] or None}))' "$name" "$job_status" "$conclusion")"
  done
  mkdir -p "$stub_dir/jobs"
  printf '{"total_count":%d,"jobs":[%s]}\n' "$#" "$jobs" >"$stub_dir/jobs/$run.json"
}

# $sha2 is on intentd main, newer than the released v0.9.0 the fe pins.
set_pending_intentd() {
  echo behind >"$intentd_compare/$sha2...v0.9.0"
  echo ahead >"$intentd_compare/$sha2...$intentd_head"
  set_release_plz_runs "$rp_run_id|7|$intentd_head|completed|${1:-success}"
}

# The incident shape once release-plz ran clean: a test-only intentd commit on
# main after the released tag, and release-plz confirming no release.
set_noop_intentd() {
  set_pending_intentd
  set_release_plz_jobs "$rp_run_id" "runner-route / probe|completed|success" "Release-plz release|completed|success" \
    "Release-plz PR|completed|success" "$(noop_job "${1:-v0.9.0}")|completed|success"
}

# The incident itself: the Release-plz PR job failed at HEAD.
set_failed_intentd() {
  set_pending_intentd failure
  set_release_plz_jobs "$rp_run_id" "runner-route / probe|completed|success" "Release-plz release|completed|success" \
    "Release-plz PR|completed|${1:-failure}" "$unrendered_noop_job|completed|skipped"
}

reset_stub
set_noop_intentd
run_script intentd "$sha2"
[[ "$status" -eq 6 ]] || fail "confirmed no-op intentd commit exited $status (expected 6): $stderr"
[[ -z "$stdout" ]] || fail "confirmed no-op intentd commit printed '$stdout'"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"$(noop_line "$sha2" v0.9.0)" ]] || fail "confirmed no-op message: $stderr"
grep -q "^api repos/intent-hq/intentd/actions/runs/$rp_run_id/jobs?per_page=100 --paginate\$" "$temp_dir/gh.log" || fail "Release-plz jobs were not fetched for the HEAD run"
grep -q '^api repos/intent-hq/intentd/pulls?state=open&per_page=100 ' "$temp_dir/gh.log" || fail "confirmed no-op skipped the Release PR lookup"
[[ "$(grep -c '^api repos/intent-hq/intentd/git/ref/heads/main ' "$temp_dir/gh.log")" -eq 2 ]] || fail "confirmed no-op did not re-read main HEAD before exiting"
! grep -q '^run list' "$temp_dir/gh.log" || fail "confirmed no-op still probed the Release Alpha run"

# Both intentd pairs confirmed: one exit 6 naming both.
reset_stub
set_noop_intentd
echo behind >"$intentd_compare/$sha...v0.9.0"
echo identical >"$intentd_compare/$sha...$intentd_head"
run_script intentd "$sha2" intentd "$sha"
[[ "$status" -eq 6 ]] || fail "two confirmed no-op intentd pairs exited $status (expected 6): $stderr"
[[ "$stderr" == *$'\n'"$(noop_line "$sha2, $sha" v0.9.0)" ]] || fail "two no-op pairs message: $stderr"

# Released in v0.9.1 on intentd main but the fe still pins v0.9.0: the wait
# is on the fe pin, whatever release-plz says about HEAD.
for verdict in noop failed; do
  reset_stub
  if [[ "$verdict" == noop ]]; then set_noop_intentd v0.9.1; else set_failed_intentd; fi
  set_intentd_version 0.9.1
  echo ahead >"$intentd_compare/$sha2...v0.9.1"
  run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "$verdict verdict for a released commit exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line" ]] || fail "$verdict verdict for a released commit changed stderr: $stderr"
done

# A commit that is not on intentd main is never blamed on, or excused by, HEAD.
for verdict in noop failed; do
  reset_stub
  if [[ "$verdict" == noop ]]; then set_noop_intentd; else set_failed_intentd; fi
  echo diverged >"$intentd_compare/$sha2...$intentd_head"
  run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "$verdict verdict for a commit off intentd main exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line" ]] || fail "$verdict verdict for a commit off intentd main changed stderr: $stderr"
done

# Main moved during the probe: the verdict is stale, the next poll redoes it.
for verdict in noop failed; do
  reset_stub
  if [[ "$verdict" == noop ]]; then set_noop_intentd; else set_failed_intentd; fi
  echo "$sha" >"$stub_dir/intentd-head.next"
  run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "$verdict verdict with main moved exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line" ]] || fail "$verdict verdict with main moved changed stderr: $stderr"
done

# A no-op proof that does not name the version released at HEAD, or its tag
# commit, is stale; so is one from a run that did not succeed.
reset_stub
set_noop_intentd v0.8.9
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no-op proof for another version exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "no-op proof for another version changed stderr: $stderr"
reset_stub
set_noop_intentd
set_intentd_version 0.9.0 0123456789abcdef0123456789abcdef01234567
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no-op proof for another tag commit exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "no-op proof for another tag commit changed stderr: $stderr"
reset_stub
set_noop_intentd
set_release_plz_runs "$rp_run_id|7|$intentd_head|completed|cancelled"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no-op proof from a cancelled run exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "no-op proof from a cancelled run changed stderr: $stderr"

# One commit needs no release, the other is in the released v0.9.1 the fe pin
# has not reached yet: still waiting on the pin.
reset_stub
set_noop_intentd v0.9.1
set_intentd_version 0.9.1
echo behind >"$intentd_compare/$sha2...v0.9.1"
echo behind >"$intentd_compare/$sha...v0.9.0"
echo ahead >"$intentd_compare/$sha...$intentd_head"
echo ahead >"$intentd_compare/$sha...v0.9.1"
run_script intentd "$sha2" intentd "$sha"
[[ "$status" -eq 3 ]] || fail "mixed no-op/released intentd pairs exited $status (expected 3): $stderr"
[[ "$stderr" == "shipped-in: intentd $sha2, intentd $sha are not carried by the newest 3 release(s) on intent-hq/cloudlands-releases (newest v2.3.0)" ]] || fail "mixed no-op/released intentd pairs changed stderr: $stderr"

# An fe pair still pending keeps exit 3 and the note, so the hook keeps
# tracking the fe change.
reset_stub
set_noop_intentd
echo behind >"$fe_compare/$sha...v2.3.0"
run_script cloudlands-fe "$sha" intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no-op intentd with a pending fe pair exited $status (expected 3): $stderr"
[[ "$stderr" == *$'\n'"$(noop_line "$sha2" v0.9.0)"$'\n'"shipped-in: still waiting on the cloudlands-fe pair(s)" ]] || fail "pending fe pair message: $stderr"
grep -q '^run list' "$temp_dir/gh.log" || fail "pending fe pair skipped the Release Alpha stall probe"

# A failed or timed-out Release-plz PR job means no Release PR until a human
# re-runs it: exit 5 naming the run, like a stalled Release Alpha run.
for conclusion in failure timed_out; do
  reset_stub
  set_failed_intentd "$conclusion"
  run_script intentd "$sha2"
  [[ "$status" -eq 5 ]] || fail "Release-plz PR job $conclusion exited $status (expected 5): $stderr"
  [[ -z "$stdout" ]] || fail "Release-plz PR job $conclusion printed '$stdout'"
  [[ "$stderr" == "$intentd_not_carried_line"$'\n'"$(failed_line "Release-plz PR" "$conclusion")" ]] || fail "Release-plz PR job $conclusion message: $stderr"
done

# The pr job's concurrency group cancels a pending job a newer push
# supersedes, so `cancelled` alone is an ordinary wait.
reset_stub
set_pending_intentd cancelled
set_release_plz_jobs "$rp_run_id" "Release-plz release|completed|success" \
  "Release-plz PR|completed|cancelled" "$unrendered_noop_job|completed|skipped"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "cancelled Release-plz PR job exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "cancelled Release-plz PR job changed stderr: $stderr"

# Any other failed job (the tag push, the runner route) skips the rest: exit 5.
for failed_job in "Release-plz release" "runner-route / probe"; do
  reset_stub
  set_pending_intentd failure
  set_release_plz_jobs "$rp_run_id" "$failed_job|completed|failure" \
    "Release-plz PR|completed|skipped" "$unrendered_noop_job|completed|skipped"
  run_script intentd "$sha2"
  [[ "$status" -eq 5 ]] || fail "failed $failed_job job exited $status (expected 5): $stderr"
  [[ "$stderr" == *$'\n'"$(failed_line "$failed_job" failure)" ]] || fail "failed $failed_job job message: $stderr"
done

# A run that failed before any job (e.g. an invalid workflow file).
reset_stub
set_pending_intentd startup_failure
set_release_plz_jobs "$rp_run_id"
run_script intentd "$sha2"
[[ "$status" -eq 5 ]] || fail "startup_failure run exited $status (expected 5): $stderr"
[[ "$stderr" == *$'\n'"$(failed_line "Release-plz run" startup_failure)" ]] || fail "startup_failure run message: $stderr"

# A Release-PR merge whose tag push failed: HEAD carries v0.9.1 but the tag
# does not exist, and that must still report exit 5.
reset_stub
set_pending_intentd failure
set_release_plz_jobs "$rp_run_id" "Release-plz release|completed|failure" \
  "Release-plz PR|completed|skipped" "$unrendered_noop_job|completed|skipped"
set_intentd_version 0.9.1
echo @404 >"$intentd_compare/$sha2...v0.9.1"
run_script intentd "$sha2"
[[ "$status" -eq 5 ]] || fail "failed tag push on a release merge exited $status (expected 5): $stderr"
[[ "$stderr" == *$'\n'"$(failed_line "Release-plz release" failure v0.9.1)" ]] || fail "failed tag push on a release merge message: $stderr"
# ...but a missing tag never confirms a no-op.
reset_stub
set_noop_intentd v0.9.1
set_intentd_version 0.9.1
echo @404 >"$intentd_compare/$sha2...v0.9.1"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no-op with a missing tag exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"shipped-in: intentd release-plz probe skipped: gh api compare $sha2...v0.9.1 on intent-hq/intentd failed: gh: Not Found (HTTP 404)" ]] || fail "no-op with a missing tag message: $stderr"

# A run (or re-run attempt) still in flight has no verdict, even when the jobs
# listing still shows an earlier failure or proof.
for verdict in noop failed; do
  reset_stub
  if [[ "$verdict" == noop ]]; then set_noop_intentd; else set_failed_intentd; fi
  set_release_plz_runs "$rp_run_id|7|$intentd_head|in_progress"
  run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "$verdict verdict on an in-flight run exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line" ]] || fail "$verdict verdict on an in-flight run changed stderr: $stderr"
  ! grep -q "actions/runs/$rp_run_id/jobs" "$temp_dir/gh.log" || fail "$verdict verdict on an in-flight run fetched its jobs"
done

# A completed run without a verdict (e.g. the proof job skipped) is a wait,
# and costs no Release PR, version or compare lookups.
reset_stub
set_pending_intentd
set_release_plz_jobs "$rp_run_id" "Release-plz release|completed|success" \
  "Release-plz PR|completed|success" "$unrendered_noop_job|completed|skipped"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "completed run without a verdict exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "completed run without a verdict changed stderr: $stderr"
! grep -qE 'pulls|Cargo.toml|intentd/compare/.*\.\.\.'"$intentd_head" "$temp_dir/gh.log" || fail "completed run without a verdict still ran the verdict lookups"

# Only the newest run for HEAD counts; runs for other SHAs are ignored.
reset_stub
set_noop_intentd
set_release_plz_runs "$rp_old_run_id|6|$intentd_head|completed|failure" "$rp_run_id|7|$intentd_head" "5|8|$sha|completed|failure"
set_release_plz_jobs "$rp_old_run_id" "Release-plz PR|completed|failure"
set_release_plz_jobs 5 "Release-plz PR|completed|failure"
run_script intentd "$sha2"
[[ "$status" -eq 6 ]] || fail "newest Release-plz run was not the one read (exit $status): $stderr"
! grep -q "actions/runs/$rp_old_run_id/jobs" "$temp_dir/gh.log" || fail "an older Release-plz run had its jobs fetched"

# More runs for HEAD than one page: never guess which is newest.
reset_stub
set_noop_intentd
python3 -c 'import json, sys; data = json.load(open(sys.argv[1])); data["total_count"] = 101; json.dump(data, open(sys.argv[1], "w"))' "$stub_dir/intentd-runs.json"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "truncated Release-plz run list exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"shipped-in: intentd release-plz probe skipped: could not read the Release-plz runs on intent-hq/intentd: more Release-plz runs for HEAD than one page" ]] || fail "truncated Release-plz run list message: $stderr"

# An open Release PR means a release is coming, whatever the jobs say.
for verdict in noop failed; do
  reset_stub
  if [[ "$verdict" == noop ]]; then set_noop_intentd; else set_failed_intentd; fi
  echo 2741 >"$stub_dir/intentd-prs"
  run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "open Release PR with a $verdict verdict exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line" ]] || fail "open Release PR with a $verdict verdict changed stderr: $stderr"
  ! grep -q 'Cargo.toml' "$temp_dir/gh.log" || fail "open Release PR still read the intentd version"
done

# No Release-plz run for HEAD yet (the reset_stub default): an ordinary wait.
reset_stub
echo behind >"$intentd_compare/$sha2...v0.9.0"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "no Release-plz run for HEAD exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line" ]] || fail "no Release-plz run for HEAD changed stderr: $stderr"
grep -q 'release-plz.yml/runs?branch=main&event=push&head_sha='"$intentd_head"'&per_page=100$' "$temp_dir/gh.log" || fail "uncarried intentd pair skipped the Release-plz run lookup"

# fe-only waits never touch intentd.
reset_stub
echo behind >"$fe_compare/$sha...v2.3.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "fe-only wait exited $status (expected 3): $stderr"
! grep -q '^api repos/intent-hq/intentd/' "$temp_dir/gh.log" || fail "fe-only wait ran the release-plz probe"

# The probe is best-effort: any failure keeps exit 3 and says why.
probe_skip="shipped-in: intentd release-plz probe skipped: "
for case in "api repos/intent-hq/intentd/pulls?state=open&per_page=100|1|gh api open pulls on intent-hq/intentd failed: stub: gh unavailable" \
  "api repos/intent-hq/intentd/git/ref/heads/main|ratelimit|gh api main ref on intent-hq/intentd failed: gh: API rate limit exceeded" \
  "api repos/intent-hq/intentd/actions/runs/$rp_run_id/jobs?per_page=100|5xx|gh api jobs for Release-plz run $rp_run_id on intent-hq/intentd failed: gh: Server Error (HTTP 502)" \
  "api repos/intent-hq/intentd/contents/crates/intentd/Cargo.toml?ref=$intentd_head|1|gh api crates/intentd/Cargo.toml on intent-hq/intentd main $intentd_head failed: stub: gh unavailable" \
  "api repos/intent-hq/intentd/commits/v0.9.0|5xx|gh api commit of v0.9.0 on intent-hq/intentd failed: gh: Server Error (HTTP 502)" \
  "api repos/intent-hq/intentd/compare/$sha2...$intentd_head|network|gh api compare $sha2...$intentd_head on intent-hq/intentd failed: error connecting"; do
  IFS='|' read -r fail_on mode expected <<<"$case"
  reset_stub
  set_noop_intentd
  GH_STUB_FAIL=$mode GH_STUB_FAIL_ON=$fail_on run_script intentd "$sha2"
  [[ "$status" -eq 3 ]] || fail "probe failure on '$fail_on' exited $status (expected 3): $stderr"
  [[ "$stderr" == "$intentd_not_carried_line"$'\n'"$probe_skip$expected"* ]] || fail "probe failure on '$fail_on' message: $stderr"
done

reset_stub
set_noop_intentd
echo 'not json' >"$stub_dir/intentd-runs.json"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "malformed Release-plz runs exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"${probe_skip}could not read the Release-plz runs on intent-hq/intentd: "* ]] || fail "malformed Release-plz runs message: $stderr"

reset_stub
set_noop_intentd
echo 'main' >"$stub_dir/intentd-head"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "malformed intentd main ref exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"${probe_skip}unexpected main ref 'main' on intent-hq/intentd" ]] || fail "malformed intentd main ref message: $stderr"

reset_stub
set_noop_intentd
printf '[package]\nname = "intentd"\nversion.workspace = true\n' >"$stub_dir/intentd-cargo.toml"
run_script intentd "$sha2"
[[ "$status" -eq 3 ]] || fail "unreadable intentd version exited $status (expected 3): $stderr"
[[ "$stderr" == "$intentd_not_carried_line"$'\n'"${probe_skip}could not read the intentd version on intent-hq/intentd main $intentd_head" ]] || fail "unreadable intentd version message: $stderr"

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
# then rerun the fixtures under a real Bash 3 when one can be found
# (shared lookup in find-bash3.sh; `make bash3` builds one). The
# pattern gate is a best-effort guard for hosts without a Bash 3; the real
# Bash 3 fixture run is the authoritative check. A missing Bash 3 is a skip
# notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to make it
# a failure instead.
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

# shellcheck source=scripts/find-bash3.sh
source "$repo_root/scripts/find-bash3.sh"

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  SHIPPED_IN_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set ($(bash3_missing_hint); or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "shipped-in tests: no Bash 3 interpreter found ($(bash3_missing_hint)); real 3.2 run skipped, static gate only"
fi
