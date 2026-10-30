#!/usr/bin/env bash
#
# Self-test for the `make fe-verify-changed` recipe: the root entry point to
# cloudlands-fe's `pnpm run verify:changed` (the frontend counterpart of
# `make test-changed`). It runs the real recipe from a copy of the Makefile in
# a throwaway checkout whose frontend is a stub `corepack` recording its argv,
# and pins how BASE / DRY_RUN map onto verify:changed flags plus that a failing
# run fails make with the script's own code. The selection itself is
# cloudlands-fe's scripts/verify-changed.test.ts.

set -euo pipefail

# The caller's environment must not steer the recipe under test (a shell with
# BASE=HEAD or DRY_RUN=1 exported would change every expected argv).
unset BASE DRY_RUN FE_DIR MAKEFLAGS MFLAGS

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "fe-verify-changed test failed: $*" >&2
  exit 1
}

make_bin=$(command -v make 2>/dev/null) || {
  echo "fe-verify-changed tests: make not found; skipped"
  exit 0
}

# The checkout path carries an apostrophe and a space so the recipe must keep
# FE_DIR and BASE as whole words.
mk="$temp_dir/reviewer's checkout"
fe="$mk/packages/cloudlands-fe"
bin_dir="$temp_dir/bin"
mkdir -p "$mk/scripts" "$fe/.git" "$fe/node_modules/.pnpm" "$bin_dir"
cp "$repo_root/Makefile" "$mk/Makefile"
# Fresh deps: the recipe skips `pnpm install` when the lockfiles match.
printf 'lockfileVersion: 9\n' >"$fe/pnpm-lock.yaml"
cp "$fe/pnpm-lock.yaml" "$fe/node_modules/.pnpm/lock.yaml"

# ensure-fe-toolchain's preflight; its own cases live in bootstrap-dev-host.test.sh.
cat >"$mk/scripts/bootstrap-dev-host.sh" <<'SH'
#!/usr/bin/env bash
printf 'bootstrap: %s\n' "$*" >>"$FE_TEST_LOG"
SH
chmod +x "$mk/scripts/bootstrap-dev-host.sh"

# Stub corepack: logs "<cwd>" then one argv word per line, exits COREPACK_STUB_EXIT.
cat >"$bin_dir/corepack" <<'SH'
#!/usr/bin/env bash
{ echo "corepack: $PWD"; printf '%s\n' "$@"; } >>"$FE_TEST_LOG"
exit "${COREPACK_STUB_EXIT:-0}"
SH
chmod +x "$bin_dir/corepack"

# Env prefixes on the call (COREPACK_STUB_EXIT=2 run_make ...) reach the stubs;
# make variables go on the command line after the target.
run_make() {
  : >"$temp_dir/log"
  set +e
  PATH="$bin_dir:$PATH" FE_TEST_LOG="$temp_dir/log" \
    "$make_bin" -C "$mk" --no-print-directory fe-verify-changed "$@" \
    >/dev/null 2>"$temp_dir/stderr" </dev/null
  status=$?
  set -e
  stderr=$(<"$temp_dir/stderr")
  log=$(<"$temp_dir/log")
}

# $@ = the flags expected after `verify:changed --`.
expect_verify_argv() {
  local expected="bootstrap: --check-frontend"$'\n'"corepack: $fe"$'\n'"pnpm"$'\n'"run"$'\n'"verify:changed"$'\n'"--"
  [[ $# -eq 0 ]] || expected+=$'\n'"$(printf '%s\n' "$@")"
  [[ "$log" == "$expected" ]] || fail "$case_name: stub log was"$'\n'"$log"$'\n'"expected"$'\n'"$expected"
}

expect_ok() {
  [[ "$status" -eq 0 ]] || fail "$case_name: make exited $status: $stderr"
}

case_name="no knobs: verify:changed picks its own default change set"
run_make
expect_ok
expect_verify_argv

case_name="BASE becomes --base"
run_make BASE=origin/main
expect_ok
expect_verify_argv --base origin/main

case_name="BASE with a space and an apostrophe stays one word"
run_make "BASE=it's a ref"
expect_ok
expect_verify_argv --base "it's a ref"

case_name="DRY_RUN=1 becomes --resolved-plan"
run_make DRY_RUN=1
expect_ok
expect_verify_argv --resolved-plan

case_name="DRY_RUN=1 and BASE combine"
run_make DRY_RUN=1 BASE=5a5149e0
expect_ok
expect_verify_argv --resolved-plan --base 5a5149e0

case_name="DRY_RUN=0 runs the checks"
run_make DRY_RUN=0
expect_ok
expect_verify_argv

case_name="an exported BASE / DRY_RUN reaches the recipe like a make variable"
: >"$temp_dir/log"
set +e
BASE=main DRY_RUN=1 PATH="$bin_dir:$PATH" FE_TEST_LOG="$temp_dir/log" \
  "$make_bin" -C "$mk" --no-print-directory fe-verify-changed >/dev/null 2>"$temp_dir/stderr" </dev/null
status=$?
set -e
stderr=$(<"$temp_dir/stderr")
log=$(<"$temp_dir/log")
expect_ok
expect_verify_argv --resolved-plan --base main

case_name="a failing verify:changed fails make with its own code"
COREPACK_STUB_EXIT=2 run_make
[[ "$status" -ne 0 ]] || fail "$case_name: make exited 0 after verify:changed exited 2"
[[ "$stderr" == *"fe-verify-changed] Error 2"* ]] \
  || fail "$case_name: make did not report the script's code; stderr was"$'\n'"$stderr"

case_name="a non-2 failure code is reported verbatim"
COREPACK_STUB_EXIT=7 run_make DRY_RUN=1
[[ "$status" -ne 0 ]] || fail "$case_name: make exited 0 after verify:changed exited 7"
[[ "$stderr" == *"fe-verify-changed] Error 7"* ]] \
  || fail "$case_name: make did not report the script's code; stderr was"$'\n'"$stderr"

case_name="make help lists the target"
"$make_bin" -C "$mk" --no-print-directory help >"$temp_dir/help" 2>&1 </dev/null \
  || fail "$case_name: make help failed: $(<"$temp_dir/help")"
grep -q '^  fe-verify-changed ' "$temp_dir/help" \
  || fail "$case_name: target missing from make help"

echo "fe-verify-changed tests passed"
