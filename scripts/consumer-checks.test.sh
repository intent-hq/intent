#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script=$repo_root/scripts/consumer-checks.sh
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

# The fixtures below run consumer-checks.sh under $script_bash against a
# stubbed make and append every exit code + output to $transcript, so a rerun
# under another interpreter (see the Bash 3 section at the end) can be
# compared byte for byte.
script_bash=${CONSUMER_CHECKS_TEST_BASH:-$BASH}
transcript=${CONSUMER_CHECKS_TEST_TRANSCRIPT:-$temp_dir/transcript}
: >"$transcript"

fail() {
  echo "consumer-checks test failed: $*" >&2
  exit 1
}

mkdir -p "$temp_dir/scripts" "$temp_dir/bin"
cp "$script" "$temp_dir/scripts/consumer-checks.sh"
stub_log=$temp_dir/make.log

# The stub logs its argv and fails when its last argument (the target) is in
# STUB_FAIL, so a run can pick which checks are red.
cat >"$temp_dir/bin/make" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$STUB_LOG"
for target in "$@"; do :; done
echo "stub make: $target"
for failing in ${STUB_FAIL:-}; do
  if [ "$failing" = "$target" ]; then
    echo "stub make: $target failed" >&2
    exit 2
  fi
done
EOF
chmod +x "$temp_dir/bin/make"

# run_check [STUB_FAIL=<targets>] [CONSUMER_CHECKS_ADVISORY=<targets>]
#           [CONSUMER_CHECKS_CONTEXT=<name>] <script args...>
run_check() {
  local status=0 stub_fail="" env_advisory="" env_context=""
  while :; do
    case "${1:-}" in
      STUB_FAIL=*) stub_fail=${1#*=} ;;
      CONSUMER_CHECKS_ADVISORY=*) env_advisory=${1#*=} ;;
      CONSUMER_CHECKS_CONTEXT=*) env_context=${1#*=} ;;
      *) break ;;
    esac
    shift
  done
  : >"$stub_log"
  check_output=$(cd "$temp_dir" && STUB_LOG="$stub_log" STUB_FAIL="$stub_fail" MAKE="$temp_dir/bin/make" \
    CONSUMER_CHECKS_ADVISORY="$env_advisory" CONSUMER_CHECKS_CONTEXT="$env_context" \
    "$script_bash" scripts/consumer-checks.sh "$@" 2>&1) || status=$?
  printf 'exit %s\n%s\n' "$status" "$check_output" >>"$transcript"
  return "$status"
}

all_checks="event-catalog-check check-mcp-bindings docs-check check-protocol-catalog check-makefile-targets check-protocol-field-parity"
expect_all_ran() {
  local target
  for target in $all_checks; do
    grep -q "^stub make: $target\$" <<<"$check_output" || fail "$1: $target did not run: $check_output"
  done
}

if ! run_check; then
  fail "all-green run exited non-zero: $check_output"
fi
expect_all_ran "all-green run"
grep -q -- '--no-print-directory -o event-catalog-check -o check-mcp-bindings docs-check$' "$stub_log" ||
  fail "docs-check was not invoked with its prerequisites assumed old: $(cat "$stub_log")"
[ "$(grep -c . "$stub_log")" -eq 6 ] || fail "expected 6 make invocations: $(cat "$stub_log")"
grep -q -- '--no-print-directory check-makefile-targets$' "$stub_log" ||
  fail "monorepo context did not run check-makefile-targets at the pinned gitlink: $(cat "$stub_log")"
grep -q 'CHECK_MAKEFILE_TARGETS_GITLINK' "$stub_log" &&
  fail "monorepo context overrode the check-makefile-targets gitlink: $(cat "$stub_log")"
[ "$(grep -c '^  [a-z-]*  *pass  ' <<<"$check_output")" -eq 6 ] ||
  fail "summary table did not list 6 passing rows: $check_output"
grep -q '::warning::' <<<"$check_output" && fail "all-green run printed a warning: $check_output"
grep -q '^Fix order:' <<<"$check_output" && fail "monorepo context printed the upstream fix-order line: $check_output"
[ "$(tail -n 1 <<<"$check_output")" = "consumer-checks: all checks passed" ] ||
  fail "all-green run did not end with the pass line: $check_output"

if run_check STUB_FAIL=check-protocol-catalog; then
  fail "non-advisory failure was accepted"
fi
expect_all_ran "non-advisory failure"
grep -q '^  check-protocol-catalog  *FAIL  *docs/protocol/05-method-catalog.md + docs/protocol/methods/\*.md$' <<<"$check_output" ||
  fail "failed row did not name the catalog fix path: $check_output"
grep -q '^  event-catalog-check  *pass  *docs/protocol/event-types.json + docs/protocol/06-events.md$' <<<"$check_output" ||
  fail "passing row did not keep its fix path: $check_output"
grep -q '::warning::' <<<"$check_output" && fail "non-advisory failure printed a warning: $check_output"
[ "$(tail -n 1 <<<"$check_output")" = "consumer-checks: FAILED" ] ||
  fail "failed run did not end with the FAILED line: $check_output"

if ! run_check STUB_FAIL=check-mcp-bindings --advisory=check-mcp-bindings; then
  fail "advisory failure changed the exit code: $check_output"
fi
expect_all_ran "advisory failure"
grep -q "^::warning::consumer check 'check-mcp-bindings' failed (advisory); fix in the monorepo: docs/protocol/methods/mcp-bindings.md (make mcp-bindings-doc)" <<<"$check_output" ||
  fail "advisory failure did not print the warning with its fix path: $check_output"
grep -q '^  check-mcp-bindings  *warn  *docs/protocol/methods/mcp-bindings.md' <<<"$check_output" ||
  fail "advisory row was not marked warn: $check_output"
grep -q '^  docs-check  *pass  ' <<<"$check_output" ||
  fail "docs-check row was affected by the advisory check-mcp-bindings failure: $check_output"

if ! run_check STUB_FAIL=check-mcp-bindings --advisory "check-mcp-bindings event-catalog-check"; then
  fail "space-separated --advisory list was rejected: $check_output"
fi

if ! run_check STUB_FAIL=check-mcp-bindings CONSUMER_CHECKS_ADVISORY=check-mcp-bindings; then
  fail "CONSUMER_CHECKS_ADVISORY was not honored: $check_output"
fi
grep -q '^  check-mcp-bindings  *warn  ' <<<"$check_output" || fail "env advisory run lost the warn row: $check_output"

if run_check "STUB_FAIL=check-mcp-bindings docs-check" --advisory=check-mcp-bindings; then
  fail "non-advisory failure alongside an advisory one was accepted"
fi
grep -q '^  check-mcp-bindings  *warn  ' <<<"$check_output" || fail "mixed run lost the warn row: $check_output"
grep -q '^  docs-check  *FAIL  *AGENTS.md / README.md / docs/fe/DEVELOPER_GUIDE.md' <<<"$check_output" ||
  fail "mixed run did not fail the docs-check row with its fix path: $check_output"

if run_check --advisory=not-a-check; then
  fail "unknown advisory target was accepted"
fi
grep -q "unknown advisory target 'not-a-check'" <<<"$check_output" || fail "unknown advisory target was not named: $check_output"
[ "$(grep -c . "$stub_log")" -eq 0 ] || fail "unknown advisory target still ran checks"

if ! run_check --context upstream; then
  fail "upstream context run exited non-zero: $check_output"
fi
[ "$(tail -n 1 <<<"$check_output")" = "Fix order: land the monorepo docs change first (docs may lead the pin), then re-run this job." ] ||
  fail "upstream context did not end with the fix-order line: $check_output"
[ "$(grep -c '^Fix order:' <<<"$check_output")" -eq 1 ] || fail "fix-order line printed more than once: $check_output"
# Upstream, packages/intentd is the caller's PR head rather than the pin, so
# check-makefile-targets must read that head instead of the monorepo gitlink.
grep -q -- '--no-print-directory CHECK_MAKEFILE_TARGETS_GITLINK=HEAD check-makefile-targets$' "$stub_log" ||
  fail "upstream context did not point check-makefile-targets at the caller head: $(cat "$stub_log")"
[ "$(grep -c 'CHECK_MAKEFILE_TARGETS_GITLINK' "$stub_log")" -eq 1 ] ||
  fail "the gitlink override leaked into another make invocation: $(cat "$stub_log")"

if run_check STUB_FAIL=docs-check CONSUMER_CHECKS_CONTEXT=upstream; then
  fail "upstream context masked a non-advisory failure"
fi
[ "$(tail -n 1 <<<"$check_output")" = "Fix order: land the monorepo docs change first (docs may lead the pin), then re-run this job." ] ||
  fail "CONSUMER_CHECKS_CONTEXT=upstream did not end a failed run with the fix-order line: $check_output"
grep -q -- 'CHECK_MAKEFILE_TARGETS_GITLINK=HEAD check-makefile-targets$' "$stub_log" ||
  fail "CONSUMER_CHECKS_CONTEXT=upstream did not point check-makefile-targets at the caller head: $(cat "$stub_log")"

if run_check --context=elsewhere; then
  fail "unknown context was accepted"
fi
grep -q "unknown context 'elsewhere'" <<<"$check_output" || fail "unknown context was not named: $check_output"

if run_check --bogus; then
  fail "unknown argument was accepted"
fi
grep -q "unknown argument '--bogus'" <<<"$check_output" || fail "unknown argument was not named: $check_output"

# The reusable workflow pipes the runner through `tee`, so its step must run
# under GitHub's `shell: bash` (`bash --noprofile --norc -eo pipefail {0}`);
# the default `run` shell is `bash -e` only and would report tee's exit 0.
# Extract the step as written and execute its body under that shell against
# a stubbed runner: a failing runner must fail the step with the summary
# still appended, a passing one must exit 0.
workflow=$repo_root/.github/workflows/consumer-checks.yml
step_name='Run the consumer checks (upstream context)'
step_block=$(awk -v name="$step_name" '
  /^      - / { in_step = index($0, "- name: " name) > 0 }
  in_step { print }
' "$workflow")
[[ -n "$step_block" ]] || fail "workflow step '$step_name' not found in $workflow"
grep -q '^        shell: bash$' <<<"$step_block" ||
  fail "workflow step '$step_name' does not declare 'shell: bash' (its piped run body needs pipefail):"$'\n'"$step_block"
grep -q '| tee ' <<<"$step_block" || fail "workflow step '$step_name' no longer pipes the runner; update this test"
run_body=$(awk 'body { sub(/^          /, ""); print } /^        run: \|$/ { body = 1 }' <<<"$step_block" |
  sed 's/\${{ github\.repository }}/intent-hq\/intentd/g')
grep -q '\${{' <<<"$run_body" && fail "workflow run body has an unsubstituted expression:"$'\n'"$run_body"
step_dir=$temp_dir/workflow-step
mkdir -p "$step_dir/scripts" "$step_dir/tmp"
printf '%s\n' "$run_body" >"$step_dir/step.sh"
cat >"$step_dir/scripts/consumer-checks.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >"$STUB_ARGS"
echo "==> make stub-check"
echo "consumer-checks summary"
echo "  stub-check  FAIL  stub/fix/path"
echo "consumer-checks: ${STUB_RESULT}"
exit "${STUB_STATUS}"
EOF
chmod +x "$step_dir/scripts/consumer-checks.sh"
# run_step <status> <result word>; sets step_status and step_summary.
run_step() {
  local summary=$step_dir/summary.md
  : >"$summary"
  step_status=0
  step_output=$(cd "$step_dir" && STUB_ARGS="$step_dir/args" STUB_STATUS="$1" STUB_RESULT="$2" \
    RUNNER_TEMP="$step_dir/tmp" GITHUB_STEP_SUMMARY="$summary" HEAD_SHA=0123456789abcdef \
    bash --noprofile --norc -eo pipefail step.sh 2>&1) || step_status=$?
  step_summary=$(cat "$summary")
}
run_step 1 FAILED
[ "$step_status" -eq 1 ] ||
  fail "workflow step exited $step_status for a failing runner (expected 1):"$'\n'"$step_output"
[ "$(cat "$step_dir/args")" = "--context upstream --advisory=check-mcp-bindings" ] ||
  fail "workflow step invoked the runner with unexpected arguments: $(cat "$step_dir/args")"
grep -q '^### monorepo-consumer-checks — intent-hq/intentd@0123456 vs intent-hq/intent@main$' <<<"$step_summary" ||
  fail "failed step did not write the summary heading:"$'\n'"$step_summary"
grep -q '^consumer-checks: FAILED$' <<<"$step_summary" ||
  fail "failed step did not append the runner's summary table:"$'\n'"$step_summary"
grep -q '^==> make stub-check$' <<<"$step_summary" &&
  fail "step summary included runner output above the summary table:"$'\n'"$step_summary"
run_step 0 "all checks passed"
[ "$step_status" -eq 0 ] ||
  fail "workflow step exited $step_status for a passing runner (expected 0):"$'\n'"$step_output"
grep -q '^consumer-checks: all checks passed$' <<<"$step_summary" ||
  fail "passing step did not append the runner's summary table:"$'\n'"$step_summary"

echo "consumer-checks tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${CONSUMER_CHECKS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as docs-check.test.sh: BASH3_BIN, bash3, Homebrew bash@3, 3.x
# /bin/bash) and require a byte-identical transcript. A missing Bash 3 is a
# skip notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to make
# it a failure instead.
bash -n "$script" || fail "consumer-checks.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "consumer-checks.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments and the pattern itself are not scanned.
gate_matches() {
  grep -nE "$bash4_constructs" "$@" | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' |
    grep -v -F -e 'bash4_constructs' || true
}
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
  bash3_transcript=$temp_dir/bash3-transcript
  CONSUMER_CHECKS_TEST_BASH="$bash3" CONSUMER_CHECKS_TEST_TRANSCRIPT="$bash3_transcript" \
    "$bash3" "${BASH_SOURCE[0]}"
  cmp -s "$transcript" "$bash3_transcript" ||
    fail "consumer-checks.sh output differs between bash $BASH_VERSION and $bash3:"$'\n'"$(diff "$transcript" "$bash3_transcript" || true)"
  echo "consumer-checks.sh output is identical under bash $BASH_VERSION and $bash3"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "consumer-checks tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
