#!/usr/bin/env bash
#
# Self-test for scripts/ci-gate.sh, the CI Gate result matrix behind the
# `gate` job in .github/workflows/ci.yml. It feeds the script synthetic
# `toJSON(needs)` inputs per event and pins the pass/fail/skip combinations by
# exit code and the job named in the output, and it diffs the script's job list
# against the gate job's `needs` in ci.yml so the two cannot drift apart.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script=$repo_root/scripts/ci-gate.sh
workflow=$repo_root/.github/workflows/ci.yml
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

# Every gate run below records its exit code + output in $transcript so a rerun
# under another interpreter (see the Bash 3 section at the end) can be compared
# byte for byte.
script_bash=${CI_GATE_TEST_BASH:-$BASH}
transcript=${CI_GATE_TEST_TRANSCRIPT:-$temp_dir/transcript}
: >"$transcript"

fail() {
  echo "ci-gate test failed: $*" >&2
  exit 1
}

always_on="bridge-test docs-check event-catalog-check shell-tests shell-tests-bash3 repo-hygiene ruleset-check triage-parser-test"
pr_only="pr-title breaking-token submodule-pins"

# needs_json <event> [<job>=<result> ...]: the `toJSON(needs)` object for a
# fully green run of <event> (PR-only jobs `success` on pull_request, `skipped`
# otherwise), with each override applied. `<job>=-` drops the job from the
# object, `<job>=` gives it an empty result. GitHub pretty-prints toJSON with
# two-space indentation; that is the shape produced here.
needs_json() {
  local event=$1 job result override out="{" sep=$'\n'
  shift
  for job in $always_on $pr_only; do
    result=success
    case " $pr_only " in
      *" $job "*) [ "$event" = pull_request ] || result=skipped ;;
    esac
    for override in "$@"; do
      [ "${override%%=*}" = "$job" ] || continue
      result=${override#*=}
    done
    [ "$result" != - ] || continue
    out="$out$sep  \"$job\": {"$'\n'"    \"result\": \"$result\","$'\n'"    \"outputs\": {}"$'\n'"  }"
    sep=","$'\n'
  done
  printf '%s\n}\n' "$out"
}

# run_gate <event> <json>: runs the gate, captures $gate_output, returns its status.
run_gate() {
  local status=0
  gate_output=$(cd "$repo_root" && GATE_EVENT="$1" GATE_NEEDS_JSON="$2" "$script_bash" scripts/ci-gate.sh 2>&1) || status=$?
  printf 'event %s\nexit %s\n%s\n' "$1" "$status" "$gate_output" >>"$transcript"
  return "$status"
}

expect_pass() {
  local name=$1 event=$2 json=$3
  run_gate "$event" "$json" || fail "$name: expected exit 0, got exit $?:"$'\n'"$gate_output"
  grep -q "^ci-gate: all jobs green on $event\$" <<<"$gate_output" ||
    fail "$name: pass did not report the event: $gate_output"
}

# expect_fail <name> <event> <json> <fragment>...: exit 1 and every fragment in the output.
expect_fail() {
  local name=$1 event=$2 json=$3 fragment status=0
  shift 3
  run_gate "$event" "$json" && fail "$name: expected exit 1, got exit 0:"$'\n'"$gate_output"
  status=$?
  [ "$status" -eq 1 ] || fail "$name: expected exit 1, got exit $status:"$'\n'"$gate_output"
  for fragment in "$@"; do
    grep -qF -- "$fragment" <<<"$gate_output" || fail "$name: output lacks '$fragment':"$'\n'"$gate_output"
  done
}

# ---- green runs --------------------------------------------------------------

expect_pass "all success on pull_request" pull_request "$(needs_json pull_request)"
expect_pass "all success, PR-only skipped on merge_group" merge_group "$(needs_json merge_group)"
compact=$(needs_json merge_group | tr -d ' \n')
expect_pass "compact JSON is read like pretty-printed" merge_group "$compact"
nested=$(needs_json pull_request | sed 's/"outputs": {}/"outputs": { "result": "failure", "note": "{}" }/')
expect_pass "a result key nested inside outputs is ignored" pull_request "$nested"

# ---- PR-only jobs are event-aware -------------------------------------------

for job in $pr_only; do
  expect_fail "$job skipped on pull_request" pull_request "$(needs_json pull_request "$job=skipped")" \
    "ci-gate: $job must be success on pull_request (result: 'skipped')" "ci-gate: FAILED on pull_request"
  expect_fail "$job ran on merge_group" merge_group "$(needs_json merge_group "$job=success")" \
    "ci-gate: $job must be skipped on merge_group (result: 'success')" "ci-gate: FAILED on merge_group"
  expect_fail "$job failure on pull_request" pull_request "$(needs_json pull_request "$job=failure")" \
    "ci-gate: $job must be success on pull_request (result: 'failure')"
  expect_fail "$job failure on merge_group" merge_group "$(needs_json merge_group "$job=failure")" \
    "ci-gate: $job must be skipped on merge_group (result: 'failure')"
done

# ---- always-on jobs must succeed on every event -----------------------------

for job in $always_on; do
  for event in pull_request merge_group; do
    for result in failure cancelled skipped; do
      expect_fail "$job $result on $event" "$event" "$(needs_json "$event" "$job=$result")" \
        "ci-gate: $job did not succeed (result: '$result')" "ci-gate: FAILED on $event"
    done
    expect_fail "$job empty result on $event" "$event" "$(needs_json "$event" "$job=")" \
      "ci-gate: $job did not succeed (result: '')"
    expect_fail "$job missing on $event" "$event" "$(needs_json "$event" "$job=-")" \
      "ci-gate: $job is missing from the needs results"
  done
done

# One bad job never masks another: every offender is named in one run.
expect_fail "several offenders are all named" merge_group \
  "$(needs_json merge_group "bridge-test=failure" "shell-tests=cancelled" "pr-title=success")" \
  "ci-gate: bridge-test did not succeed (result: 'failure')" \
  "ci-gate: shell-tests did not succeed (result: 'cancelled')" \
  "ci-gate: pr-title must be skipped on merge_group (result: 'success')"
# A green job elsewhere in the run is not reported.
grep -q "docs-check" <<<"$gate_output" && fail "a green job was reported: $gate_output"

# ---- events and inputs -------------------------------------------------------

expect_fail "unknown event" push "$(needs_json push)" \
  "ci-gate: unknown event 'push' (expected pull_request or merge_group)"
expect_fail "empty event" "" "$(needs_json pull_request)" "ci-gate: GATE_EVENT is empty"
expect_fail "empty needs JSON" pull_request "" "ci-gate: GATE_NEEDS_JSON is empty"
expect_fail "needs JSON that is not an object" pull_request "null" \
  "ci-gate: bridge-test is missing from the needs results" \
  "ci-gate: submodule-pins is missing from the needs results"
expect_fail "unknown jobs do not stand in for known ones" pull_request \
  '{"something-else": {"result": "success", "outputs": {}}}' \
  "ci-gate: bridge-test is missing from the needs results"

# ---- the script and the workflow agree on the job list ----------------------

listed_jobs=$(cd "$repo_root" && "$script_bash" scripts/ci-gate.sh --list-jobs)
printf 'list-jobs\n%s\n' "$listed_jobs" >>"$transcript"
expected_listed=$(printf '%s\n' $always_on $pr_only)
[ "$listed_jobs" = "$expected_listed" ] ||
  fail "--list-jobs does not match the job lists this suite covers:"$'\n'"$listed_jobs"

# The gate job is the `gate:` mapping; take its `needs: [...]` line.
gate_job=$(sed -n '/^  gate:$/,/^  [a-z]/p' "$workflow")
gate_needs=$(sed -n 's/^    needs: \[\(.*\)\]$/\1/p' <<<"$gate_job")
[ -n "$gate_needs" ] || fail "could not find the gate job's needs list in $workflow"
workflow_jobs=$(printf '%s\n' "$gate_needs" | tr ',' '\n' | sed 's/^[[:blank:]]*//; s/[[:blank:]]*$//' | sort)
script_jobs=$(printf '%s\n' "$listed_jobs" | sort)
[ "$workflow_jobs" = "$script_jobs" ] ||
  fail "the gate job's needs in ci.yml and the jobs in ci-gate.sh differ:"$'\n'"$(diff <(printf '%s\n' "$workflow_jobs") <(printf '%s\n' "$script_jobs") || true)"

# ... and the gate job actually runs the script with both inputs.
grep -q '^    name: CI Gate$' <<<"$gate_job" || fail "the gate job is no longer named CI Gate"
grep -q '^    if: always()$' <<<"$gate_job" || fail "the gate job lost its if: always()"
grep -qE '^ +GATE_EVENT: \$\{\{ github\.event_name \}\}$' <<<"$gate_job" ||
  fail "the gate job does not pass GATE_EVENT from github.event_name"
grep -qE '^ +GATE_NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}$' <<<"$gate_job" ||
  fail "the gate job does not pass GATE_NEEDS_JSON from toJSON(needs)"
grep -q '^        run: bash scripts/ci-gate.sh$' <<<"$gate_job" ||
  fail "the gate job does not run bash scripts/ci-gate.sh"

echo "ci-gate tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[ -z "${CI_GATE_TEST_BASH:-}" ] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too, then
# rerun the cases under a real Bash 3 when one can be found (same lookup as
# docs-check.test.sh: BASH3_BIN, bash3, Homebrew bash@3, 3.x /bin/bash) and
# require a byte-identical transcript. A missing Bash 3 is a skip notice by
# default; set REQUIRE_BASH3 to a non-empty value (CI) to make it a failure.
bash -n "$script" || fail "ci-gate.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "ci-gate.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments and the pattern itself are not scanned, nor is the awk
# program inside the gate's `| awk '` ... `')` block: it is awk, not bash. The
# awk lines are blanked, not dropped, so reported line numbers stay right.
gate_matches() {
  local file
  for file in "$@"; do
    sed "/| awk '\$/,/^')\$/s/.*//" "$file" | grep -nE "$bash4_constructs" | sed "s|^|$file:|" || true
  done | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' | grep -v -F 'bash4_constructs' || true
}
gate_hits=$(gate_matches "$script" "${BASH_SOURCE[0]}")
[ -z "$gate_hits" ] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

find_bash3() {
  local candidate resolved brew_prefix
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  for candidate in "${BASH3_BIN:-}" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [ -n "$candidate" ] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [ -x "$resolved" ] || continue
    "$resolved" -c '[ "${BASH_VERSINFO[0]}" -eq 3 ]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if [ "${BASH_VERSINFO[0]}" -eq 3 ]; then
  : # the cases above already ran under Bash 3
elif bash3=$(find_bash3); then
  bash3_transcript=$temp_dir/bash3-transcript
  CI_GATE_TEST_BASH="$bash3" CI_GATE_TEST_TRANSCRIPT="$bash3_transcript" \
    "$bash3" "${BASH_SOURCE[0]}"
  cmp -s "$transcript" "$bash3_transcript" ||
    fail "ci-gate.sh output differs between bash $BASH_VERSION and $bash3:"$'\n'"$(diff "$transcript" "$bash3_transcript" || true)"
  echo "ci-gate.sh output is identical under bash $BASH_VERSION and $bash3"
elif [ -n "${REQUIRE_BASH3:-}" ]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "ci-gate tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
