#!/usr/bin/env bash
#
# Hermetic self-test for scripts/retry.sh. A stub `sleep` on PATH records each
# requested delay instead of waiting, and a stub `flaky` command fails a set
# number of times before succeeding, so the whole suite runs instantly.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/retry.sh"
# The interpreter that runs the script under test defaults to the one running
# this suite; the Bash 3.2 compatibility pass at the end re-executes the suite
# with it set to a real Bash 3.
script_bash=${RETRY_TEST_BASH:-$BASH}
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
mkdir -p "$bin_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "retry test failed: $*" >&2
  exit 1
}

cat >"$bin_dir/sleep" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$RETRY_TEST_SLEEPS"
SH
# flaky: fails FLAKY_FAILURES times with exit FLAKY_STATUS (default 1), then
# succeeds; every call (with its arguments) is appended to RETRY_TEST_CALLS.
cat >"$bin_dir/flaky" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$RETRY_TEST_CALLS"
calls=$(wc -l <"$RETRY_TEST_CALLS")
if [ "$calls" -le "${FLAKY_FAILURES:-0}" ]; then
  echo "flaky: simulated failure $calls" >&2
  exit "${FLAKY_STATUS:-1}"
fi
echo "flaky: ok"
SH
chmod +x "$bin_dir/sleep" "$bin_dir/flaky"

export RETRY_TEST_SLEEPS="$temp_dir/sleeps"
export RETRY_TEST_CALLS="$temp_dir/calls"
out="$temp_dir/out"
status=0

run_retry() {
  : >"$RETRY_TEST_SLEEPS"
  : >"$RETRY_TEST_CALLS"
  status=0
  PATH="$bin_dir:$PATH" "$script_bash" "$script" "$@" >"$out" 2>&1 || status=$?
}

expect_status() {
  [[ "$status" == "$1" ]] || fail "$2: expected exit $1, got $status; output:"$'\n'"$(cat "$out")"
}

expect_calls() {
  local got
  got=$(wc -l <"$RETRY_TEST_CALLS" | tr -d ' ')
  [[ "$got" == "$1" ]] || fail "$2: expected $1 call(s), got $got"
}

expect_sleeps() {
  local got
  got=$(tr '\n' ' ' <"$RETRY_TEST_SLEEPS")
  [[ "$got" == "$1" ]] || fail "$2: expected sleeps '$1', got '$got'"
}

expect_output() {
  grep -qF -- "$1" "$out" || fail "$2: expected output to contain '$1'; got:"$'\n'"$(cat "$out")"
}

reject_output() {
  if grep -qF -- "$1" "$out"; then
    fail "$2: output unexpectedly contains '$1'; got:"$'\n'"$(cat "$out")"
  fi
}

unset GITHUB_ACTIONS RETRY_DELAY

# Success on the first attempt: one call, no sleep, no warning.
FLAKY_FAILURES=0 run_retry -- flaky a b
expect_status 0 "first-try success"
expect_calls 1 "first-try success"
expect_sleeps "" "first-try success"
expect_output "flaky: ok" "first-try success"
reject_output "retry.sh" "first-try success"
[[ "$(cat "$RETRY_TEST_CALLS")" == "a b" ]] || fail "arguments are not passed through verbatim"

# Two failures, then success: default schedule waits 15s, then 30s.
FLAKY_FAILURES=2 run_retry -- flaky
expect_status 0 "recovers on the third attempt"
expect_calls 3 "recovers on the third attempt"
expect_sleeps "15 30 " "recovers on the third attempt"
expect_output "WARNING: retry.sh: attempt 1/3 failed (exit 1), retrying in 15s: flaky" "recovers on the third attempt"
expect_output "WARNING: retry.sh: attempt 2/3 failed (exit 1), retrying in 30s: flaky" "recovers on the third attempt"
reject_output "ERROR" "recovers on the third attempt"

# Every attempt fails: the last exit status is returned with a clear error.
FLAKY_FAILURES=99 FLAKY_STATUS=7 run_retry -- flaky rustup toolchain install
expect_status 7 "persistent failure"
expect_calls 3 "persistent failure"
expect_sleeps "15 30 " "persistent failure"
expect_output "ERROR: retry.sh: giving up after 3 attempt(s), last exit 7: flaky rustup toolchain install" "persistent failure"

# Custom attempts and delay, with = and space forms, and no `--` separator.
FLAKY_FAILURES=99 run_retry --attempts=4 --delay 2 flaky
expect_status 1 "custom schedule"
expect_calls 4 "custom schedule"
expect_sleeps "2 4 6 " "custom schedule"

# RETRY_DELAY sets the default base delay; an explicit --delay wins.
FLAKY_FAILURES=99 RETRY_DELAY=0 run_retry -- flaky
expect_status 1 "RETRY_DELAY=0"
expect_sleeps "0 0 " "RETRY_DELAY=0"
FLAKY_FAILURES=99 RETRY_DELAY=0 run_retry --delay 5 -- flaky
expect_sleeps "5 10 " "--delay overrides RETRY_DELAY"
RETRY_DELAY=soon run_retry -- flaky
expect_status 2 "invalid RETRY_DELAY"
expect_calls 0 "invalid RETRY_DELAY"

# A single attempt never sleeps.
FLAKY_FAILURES=99 run_retry --attempts 1 -- flaky
expect_status 1 "single attempt"
expect_calls 1 "single attempt"
expect_sleeps "" "single attempt"

# A missing or unexecutable command is not retried.
run_retry -- retry-test-no-such-command
expect_status 127 "command not found"
expect_sleeps "" "command not found"
expect_output "not retrying (exit 127, command not runnable)" "command not found"

# A command killed or interrupted by a signal (Ctrl-C, a cancelled job) is
# not retried.
for signal_status in 130 143; do
  FLAKY_FAILURES=99 FLAKY_STATUS=$signal_status run_retry -- flaky
  expect_status "$signal_status" "signal exit $signal_status"
  expect_calls 1 "signal exit $signal_status"
  expect_sleeps "" "signal exit $signal_status"
  expect_output "not retrying (exit $signal_status, interrupted by a signal): flaky" "signal exit $signal_status"
done

# The bounds are inclusive.
FLAKY_FAILURES=99 run_retry --attempts 99 --delay 3600 -- flaky
expect_status 1 "upper bounds"
expect_calls 99 "upper bounds"

# GitHub Actions annotations.
FLAKY_FAILURES=99 GITHUB_ACTIONS=true run_retry --attempts 2 --delay 1 -- flaky
expect_status 1 "actions annotations"
expect_output "::warning::retry.sh: attempt 1/2 failed (exit 1), retrying in 1s: flaky" "actions annotations"
expect_output "::error::retry.sh: giving up after 2 attempt(s), last exit 1: flaky" "actions annotations"

# Argument validation fails fast with exit 2 and never runs the command.
for bad in "--attempts 0" "--attempts -1" "--attempts x" "--attempts=" "--attempts 05" "--attempts 100" \
  "--delay -5" "--delay 1.5" "--delay 08" "--delay 010" "--delay 3601" "--delay 99999999999999999999" "--bogus"; do
  # shellcheck disable=SC2086 # word-split the option pair on purpose
  run_retry $bad -- flaky
  expect_status 2 "invalid arguments '$bad'"
  expect_calls 0 "invalid arguments '$bad'"
done
run_retry --attempts
expect_status 2 "--attempts without a value"
run_retry --
expect_status 2 "no command"
expect_output "no command given" "no command"
run_retry --help
expect_status 0 "--help"
expect_output "usage: retry.sh" "--help"

echo "retry tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${RETRY_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 and bootstrap-dev-host.sh runs this helper, so
# rerun the cases under a real Bash 3 when one can be found. A missing Bash 3
# is a skip notice by default; REQUIRE_BASH3 (CI) makes it a failure.
bash -n "$script" || fail "retry.sh does not parse"

# shellcheck source=scripts/find-bash3.sh
source "$repo_root/scripts/find-bash3.sh"

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the cases above already ran under Bash 3
elif bash3=$(find_bash3); then
  RETRY_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set ($(bash3_missing_hint); or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "retry tests: no Bash 3 interpreter found ($(bash3_missing_hint)); real 3.2 run skipped"
fi
