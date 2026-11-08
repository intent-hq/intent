#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/pin-includes.sh"
# The interpreter that runs the script under test defaults to the one running
# this suite; the Bash 3.2 compatibility pass at the end re-executes the suite
# with it set to a real Bash 3.
script_bash=${PIN_INCLUDES_TEST_BASH:-$BASH}
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
stub_dir="$temp_dir/stub"
mkdir -p "$bin_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "pin-includes test failed: $*" >&2
  exit 1
}

for command in bash cat grep mktemp rm; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

# Stub gh, answering with the post-`--jq` value like gh does:
#   - `api repos/intent-hq/intent/contents/packages/<c>?ref=main` prints
#     $GH_STUB_DIR/pin/<c> (the gitlink sha; empty = not a submodule);
#   - `api repos/intent-hq/<c>/compare/<base>...<head>` prints
#     $GH_STUB_DIR/compare/<c>/<base>...<head>; a missing file or one holding
#     "@404" answers like gh does for an unknown commit.
# Every invocation is appended to GH_TEST_LOG. GH_STUB_FAIL selects a failure
# mode (one of the gh error texts below); GH_STUB_FAIL_ON narrows it to calls
# whose path contains that text ("/contents/", "/compare/"), default every call.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
if [[ -n "${GH_STUB_FAIL:-}" && "$2" == *"${GH_STUB_FAIL_ON:-}"* ]]; then
  case "$GH_STUB_FAIL" in
    ratelimit) echo "gh: API rate limit exceeded for user ID 526899. (HTTP 403)" >&2 ;;
    secondary) echo "gh: You have exceeded a secondary rate limit. (HTTP 403)" >&2 ;;
    5xx) echo "gh: Server Error (HTTP 502)" >&2 ;;
    network) echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2 ;;
    noroute) echo 'Get "https://api.github.com/repos/intent-hq/intent/contents/packages": dial tcp 172.182.252.137:443: connect: no route to host' >&2 ;;
    dial) echo 'Get "https://api.github.com/repos/intent-hq/intent/compare/a...b": dial tcp 140.82.112.6:443: connect: host is down' >&2 ;;
    forbidden) echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2 ;;
    *) echo "stub: unknown failure mode $GH_STUB_FAIL" >&2 ;;
  esac
  exit 1
fi
[[ "$1" == api && $# -eq 4 && "$3" == --jq ]] || { echo "stub: unexpected gh $*" >&2; exit 1; }
path=${2#repos/}
case "$path" in
  intent-hq/intent/contents/packages/*)
    [[ "$path" == *"?ref=main" ]] || { echo "stub: unexpected ref in $path" >&2; exit 1; }
    [[ "$4" == 'select(.type == "submodule") | .sha' ]] || { echo "stub: unexpected contents jq $4" >&2; exit 1; }
    component=${path#intent-hq/intent/contents/packages/}
    file="$GH_STUB_DIR/pin/${component%%\?*}" ;;
  intent-hq/*/compare/*)
    [[ "$4" == .status ]] || { echo "stub: unexpected compare jq $4" >&2; exit 1; }
    repo=${path%%/compare/*}
    file="$GH_STUB_DIR/compare/${repo#intent-hq/}/${path##*/compare/}" ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
if [[ ! -f "$file" || "$(<"$file")" == "@404" ]]; then
  echo '{"message":"Not Found","status":"404"}'
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
cat "$file"
SH
chmod +x "$bin_dir/gh"

sha=b4c475ad51cd05912acfb2f5a8e0dc3be74ad876
other_sha=66e5cb92c4858dd3119b1d12d369493bec69dfb2
fe_pin=aa3c5fe2093669c418490f5c2cc14ac4a451c368
intentd_pin=944d05fe481cece7177ac9cb950e79dc72a90b6c

reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$stub_dir/pin" "$stub_dir/compare/cloudlands-fe" "$stub_dir/compare/intentd"
  echo "$fe_pin" >"$stub_dir/pin/cloudlands-fe"
  echo "$intentd_pin" >"$stub_dir/pin/intentd"
  : >"$temp_dir/gh.log"
}

# compare <component> <base> <head> <status>
compare() {
  echo "$4" >"$stub_dir/compare/$1/$2...$3"
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

gh_calls() {
  grep -c "$1" "$temp_dir/gh.log" || true
}

# Included: the pin is ahead of the commit.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
run_script cloudlands-fe "$sha"
[[ "$status" -eq 0 ]] || fail "included commit exited $status: $stderr"
[[ "$stdout" == "cloudlands-fe $fe_pin includes $sha" ]] || fail "included commit printed '$stdout'"
[[ -z "$stderr" ]] || fail "included commit wrote stderr: $stderr"
grep -qxF "api repos/intent-hq/intent/contents/packages/cloudlands-fe?ref=main --jq select(.type == \"submodule\") | .sha" \
  "$temp_dir/gh.log" || fail "the pin was not read from intent-hq/intent main: $(<"$temp_dir/gh.log")"
grep -qxF "api repos/intent-hq/cloudlands-fe/compare/$sha...$fe_pin --jq .status" "$temp_dir/gh.log" ||
  fail "the commit was not compared with the pin on intent-hq/cloudlands-fe: $(<"$temp_dir/gh.log")"

# Run from scripts/ by bare name: the shared lib must still load (PR #8804 review).
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
cd "$repo_root/scripts"
script=pin-includes.sh run_script cloudlands-fe "$sha"
cd "$OLDPWD"
[[ "$status" -eq 0 ]] || fail "bare-name run from scripts/ exited $status: $stderr"
[[ "$stdout" == "cloudlands-fe $fe_pin includes $sha" ]] || fail "bare-name run from scripts/ printed '$stdout'"

# Included: the pin is the commit itself.
reset_stub
compare intentd "$sha" "$intentd_pin" identical
run_script intentd "$sha"
[[ "$status" -eq 0 ]] || fail "identical commit exited $status: $stderr"
[[ "$stdout" == "intentd $intentd_pin includes $sha" ]] || fail "identical commit printed '$stdout'"

# Not yet included: the pin is behind a commit main already carries.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" behind
compare cloudlands-fe "$sha" main ahead
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "not-yet-included commit exited $status (expected 3): $stderr"
[[ -z "$stdout" ]] || fail "not-yet-included commit printed '$stdout'"
[[ "$stderr" == "pin-includes: cloudlands-fe $sha is not in the intent-hq/intent main pin $fe_pin yet" ]] ||
  fail "not-yet-included commit reported '$stderr'"

# Several pairs: exit 0 only when every pair is included; each waiting pair is
# named and an included one is not.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
compare intentd "$other_sha" "$intentd_pin" behind
compare intentd "$other_sha" main identical
run_script cloudlands-fe "$sha" intentd "$other_sha"
[[ "$status" -eq 3 ]] || fail "half-included pairs exited $status (expected 3): $stderr"
[[ -z "$stdout" ]] || fail "half-included pairs printed '$stdout'"
[[ "$stderr" == *"intentd $other_sha is not in the intent-hq/intent main pin $intentd_pin yet"* ]] ||
  fail "half-included pairs did not name the waiting intentd pair: $stderr"
[[ "$stderr" != *"$sha"* ]] || fail "half-included pairs named the included pair: $stderr"

reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
compare intentd "$other_sha" "$intentd_pin" identical
run_script cloudlands-fe "$sha" intentd "$other_sha"
[[ "$status" -eq 0 ]] || fail "all-included pairs exited $status: $stderr"
[[ "$stdout" == "cloudlands-fe $fe_pin includes $sha"$'\n'"intentd $intentd_pin includes $other_sha" ]] ||
  fail "all-included pairs printed '$stdout'"

# The same component twice: its pin is read once.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
compare cloudlands-fe "$other_sha" "$fe_pin" ahead
run_script cloudlands-fe "$sha" cloudlands-fe "$other_sha"
[[ "$status" -eq 0 ]] || fail "repeated component exited $status: $stderr"
[[ "$(gh_calls '/contents/packages/cloudlands-fe')" -eq 1 ]] ||
  fail "repeated component read its pin more than once: $(<"$temp_dir/gh.log")"
[[ "$(gh_calls '/compare/')" -eq 2 ]] || fail "repeated component did not compare both commits"

# Diverged, commit on the component's main: the pin sits off main; keep waiting.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" diverged
compare cloudlands-fe "$sha" main ahead
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "off-main pin exited $status (expected 3): $stderr"
[[ "$stderr" == *"which is not on intent-hq/cloudlands-fe main"* ]] || fail "off-main pin reported '$stderr'"

# Diverged, commit not on main (a PR branch commit after a squash merge): no pin
# will ever include it, so fail instead of waiting forever.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" diverged
compare cloudlands-fe "$sha" main diverged
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "off-main commit exited $status (expected 1): $stderr"
[[ "$stderr" == *"is not on intent-hq/cloudlands-fe main (diverged)"*"not a PR branch commit"* ]] ||
  fail "off-main commit reported '$stderr'"

# A PR branch commit newer than the pin compares `behind` it but is not on main
# (main is behind an unmerged branch, diverged from a squash-merged one): fail on
# the first poll rather than wait until the pin passes the branch point.
for main_status in behind diverged; do
  reset_stub
  compare cloudlands-fe "$sha" "$fe_pin" behind
  compare cloudlands-fe "$sha" main "$main_status"
  run_script cloudlands-fe "$sha"
  [[ "$status" -eq 1 ]] || fail "branch commit ($main_status from main) exited $status (expected 1): $stderr"
  [[ "$stderr" == *"is not on intent-hq/cloudlands-fe main ($main_status)"*"not a PR branch commit"* ]] ||
    fail "branch commit ($main_status from main) reported '$stderr'"
done

# An included commit needs no main lookup.
reset_stub
compare cloudlands-fe "$sha" "$fe_pin" ahead
run_script cloudlands-fe "$sha"
[[ "$(gh_calls '/compare/')" -eq 1 ]] || fail "an included commit was also compared with main: $(<"$temp_dir/gh.log")"

# An unknown commit is a permanent failure, not a wait.
reset_stub
run_script cloudlands-fe deadbeef
[[ "$status" -eq 1 ]] || fail "unknown commit exited $status (expected 1): $stderr"
[[ "$stderr" == "pin-includes: commit deadbeef is unknown on intent-hq/cloudlands-fe: gh: Not Found (HTTP 404)" ]] ||
  fail "unknown commit reported '$stderr'"

reset_stub
compare cloudlands-fe "$sha" "$fe_pin" weird
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "unexpected compare status exited $status (expected 1): $stderr"
[[ "$stderr" == *"unexpected compare status 'weird'"* ]] || fail "unexpected compare status reported '$stderr'"

reset_stub
: >"$stub_dir/pin/cloudlands-fe"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "non-gitlink path exited $status (expected 1): $stderr"
[[ "$stderr" == *"packages/cloudlands-fe on intent-hq/intent main is not a submodule gitlink"* ]] ||
  fail "non-gitlink path reported '$stderr'"

# GitHub errors: transient ones exit 4 (a hook retries), others exit 1; gh's
# text is surfaced either way.
for case in "ratelimit:/contents/:4:rate limit exceeded" \
  "secondary:/compare/:4:secondary rate limit" \
  "5xx:/compare/:4:HTTP 502" \
  "network:/contents/:4:error connecting to api.github.com check your internet" \
  "noroute:/contents/:4:connect: no route to host" \
  "dial:/compare/:4:connect: host is down" \
  "forbidden:/contents/:1:Resource not accessible"; do
  mode=${case%%:*}
  rest=${case#*:}
  on=${rest%%:*}
  rest=${rest#*:}
  expected=${rest%%:*}
  text=${rest#*:}
  reset_stub
  compare cloudlands-fe "$sha" "$fe_pin" ahead
  set +e
  PATH="$bin_dir" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" GH_STUB_FAIL="$mode" GH_STUB_FAIL_ON="$on" \
    "$script_bash" "$script" cloudlands-fe "$sha" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stderr=$(<"$temp_dir/stderr")
  [[ "$status" -eq "$expected" ]] || fail "$mode on $on exited $status (expected $expected): $stderr"
  [[ "$stderr" == *"$text"* ]] || fail "$mode on $on did not surface gh's text: $stderr"
  [[ -z "$(<"$temp_dir/stdout")" ]] || fail "$mode on $on printed to stdout"
done

# Usage errors exit 2 before any gh call.
for args in "" "cloudlands-fe" "cloudlands-fe $sha intentd" "ios $sha" "cloudlands-fe not-a-sha" \
  "cloudlands-fe abc123" "cloudlands-fe $sha --limit 3"; do
  reset_stub
  # shellcheck disable=SC2086 # word splitting builds the argument list
  run_script $args
  [[ "$status" -eq 2 ]] || fail "usage '$args' exited $status (expected 2): $stderr"
  [[ "$stderr" == Usage:* ]] || fail "usage '$args' reported '$stderr'"
  [[ ! -s "$temp_dir/gh.log" ]] || fail "usage '$args' called gh"
done

# make pin-includes forwards COMPONENT/SHA and PAIRS and keeps the exit code.
make_target() {
  set +e
  PATH="$bin_dir:$PATH" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" \
    make -s -C "$repo_root" --no-print-directory pin-includes "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}
if [[ -z "${PIN_INCLUDES_TEST_BASH:-}" ]] && command -v make >/dev/null 2>&1; then
  reset_stub
  compare cloudlands-fe "$sha" "$fe_pin" ahead
  compare intentd "$other_sha" "$intentd_pin" ahead
  make_target COMPONENT=cloudlands-fe SHA="$sha" PAIRS="intentd:$other_sha"
  [[ "$status" -eq 0 ]] || fail "make pin-includes exited $status: $stderr"
  [[ "$stdout" == *"cloudlands-fe $fe_pin includes $sha"*"intentd $intentd_pin includes $other_sha"* ]] ||
    fail "make pin-includes printed '$stdout'"

  reset_stub
  compare cloudlands-fe "$sha" "$fe_pin" behind
  compare cloudlands-fe "$sha" main ahead
  make_target COMPONENT=cloudlands-fe SHA="$sha"
  [[ "$status" -ne 0 ]] || fail "make pin-includes passed for a commit that is not pinned yet"
  [[ "$stderr" == *"is not in the intent-hq/intent main pin"* ]] || fail "make pin-includes reported '$stderr'"

  reset_stub
  make_target PAIRS="cloudlands-fe"
  [[ "$status" -ne 0 ]] || fail "make pin-includes accepted a PAIRS entry without a sha"
  [[ "$stderr" == *"PAIRS entries must be <component>:<sha>"* ]] || fail "bad PAIRS reported '$stderr'"
  [[ ! -s "$temp_dir/gh.log" ]] || fail "bad PAIRS called gh"
fi

[[ -z "${PIN_INCLUDES_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4706). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found
# (shared lookup in find-bash3.sh; `make bash3` builds one). A missing Bash 3
# is a skip notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to
# make it a failure instead.
bash -n "$script" || fail "pin-includes.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "pin-includes.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments and the pattern itself are not scanned.
gate_hits=$(grep -nE "$bash4_constructs" "$script" "${BASH_SOURCE[0]}" |
  grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' | grep -v -F 'bash4_constructs' || true)
[[ -z "$gate_hits" ]] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

# shellcheck source=scripts/find-bash3.sh
source "$repo_root/scripts/find-bash3.sh"

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  PIN_INCLUDES_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set ($(bash3_missing_hint); or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "pin-includes tests: no Bash 3 interpreter found ($(bash3_missing_hint)); real 3.2 run skipped, static gate only"
fi
