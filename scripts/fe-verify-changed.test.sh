#!/usr/bin/env bash
#
# Self-test for the `make fe-verify-changed` recipe: the root entry point to
# cloudlands-fe's `pnpm run verify:changed` (the frontend counterpart of
# `make test-changed`). It runs the real recipe from a copy of the Makefile in
# a throwaway checkout whose frontend is a stub `corepack` recording its argv,
# and pins how BASE / DRY_RUN / RESUME / NO_FAIL_FAST / SKIP_CT_FULL map onto verify:changed flags, that a failing
# run fails make with the script's own code, and that the frontend receives
# TRANSFER_SELECTION_FIXTURE_ROOT even when FE_DIR is a worktree outside the
# monorepo (its own ../../../docs default only resolves inside packages/). The selection itself is
# cloudlands-fe's scripts/verify-changed.test.ts.

set -euo pipefail

# The caller's environment must not steer the recipe under test (a shell with
# BASE=HEAD, DRY_RUN=1, RESUME=1, NO_FAIL_FAST=1 or SKIP_CT_FULL=1 exported would change every expected argv).
unset BASE DRY_RUN RESUME NO_FAIL_FAST SKIP_CT_FULL FE_DIR MAKEFLAGS MFLAGS
unset TRANSFER_SELECTION_FIXTURE_ROOT

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

# The checkout path carries an apostrophe and a space, so the recipe must not
# break when the working directory has them (FE_DIR itself stays relative).
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

# Stub corepack: logs "<cwd>", the fixture root it inherited, then one argv
# word per line, and exits COREPACK_STUB_EXIT.
cat >"$bin_dir/corepack" <<'SH'
#!/usr/bin/env bash
{
  echo "corepack: $PWD"
  echo "fixtures: ${TRANSFER_SELECTION_FIXTURE_ROOT-<unset>}"
  printf '%s\n' "$@"
} >>"$FE_TEST_LOG"
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

canonical_fixtures="$mk/docs/protocol/fixtures/transfer-selection"

# $@ = the flags expected after `verify:changed --`. expect_fe / expect_fixtures
# name the frontend directory and the fixture root the stub should see.
expect_fe=$fe
expect_fixtures=$canonical_fixtures
expect_verify_argv() {
  local expected="bootstrap: --check-frontend"$'\n'"corepack: $expect_fe"$'\n'"fixtures: $expect_fixtures"$'\n'"pnpm"$'\n'"run"$'\n'"verify:changed"$'\n'"--"
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

case_name="RESUME=1 becomes --resume"
run_make RESUME=1
expect_ok
expect_verify_argv --resume

case_name="RESUME=0 starts a fresh attempt"
run_make RESUME=0
expect_ok
expect_verify_argv

case_name="DRY_RUN=1 RESUME=1 previews the continuation"
run_make DRY_RUN=1 RESUME=1
expect_ok
expect_verify_argv --resolved-plan --resume

case_name="RESUME=1 and BASE combine"
run_make RESUME=1 BASE=origin/main
expect_ok
expect_verify_argv --resume --base origin/main

case_name="NO_FAIL_FAST=1 becomes --keep-going"
run_make NO_FAIL_FAST=1
expect_ok
expect_verify_argv --keep-going

case_name="NO_FAIL_FAST=0 passes no flag (the run stops at its first failed check)"
run_make NO_FAIL_FAST=0
expect_ok
expect_verify_argv

case_name="RESUME=1 NO_FAIL_FAST=1 and BASE combine"
run_make RESUME=1 NO_FAIL_FAST=1 BASE=origin/main
expect_ok
expect_verify_argv --resume --keep-going --base origin/main

case_name="SKIP_CT_FULL=1 becomes --skip-ct-full"
run_make SKIP_CT_FULL=1
expect_ok
expect_verify_argv --skip-ct-full

case_name="SKIP_CT_FULL=0 passes no flag (a CT-contract change still runs the full component suite)"
run_make SKIP_CT_FULL=0
expect_ok
expect_verify_argv

case_name="DRY_RUN=1 SKIP_CT_FULL=1 previews the plan without the full component suite"
run_make DRY_RUN=1 SKIP_CT_FULL=1
expect_ok
expect_verify_argv --resolved-plan --skip-ct-full

case_name="RESUME=1 NO_FAIL_FAST=1 SKIP_CT_FULL=1 and BASE combine"
run_make RESUME=1 NO_FAIL_FAST=1 SKIP_CT_FULL=1 BASE=origin/main
expect_ok
expect_verify_argv --resume --keep-going --skip-ct-full --base origin/main

case_name="an exported BASE / DRY_RUN / RESUME / NO_FAIL_FAST / SKIP_CT_FULL reaches the recipe like a make variable"
BASE=main DRY_RUN=1 RESUME=1 NO_FAIL_FAST=1 SKIP_CT_FULL=1 run_make
expect_ok
expect_verify_argv --resolved-plan --resume --keep-going --skip-ct-full --base main

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

case_name="FE_DIR outside the monorepo still gets the monorepo's fixture root"
outside="$temp_dir/fe-worktree"
mkdir -p "$outside/node_modules/.pnpm"
printf 'gitdir: elsewhere\n' >"$outside/.git"
cp "$fe/pnpm-lock.yaml" "$outside/pnpm-lock.yaml"
cp "$fe/pnpm-lock.yaml" "$outside/node_modules/.pnpm/lock.yaml"
expect_fe=$outside
run_make "FE_DIR=$outside" DRY_RUN=1
expect_ok
expect_verify_argv --resolved-plan

case_name="an exported fixture root wins over the default"
expect_fixtures="$temp_dir/my fixtures"
TRANSFER_SELECTION_FIXTURE_ROOT=$expect_fixtures run_make "FE_DIR=$outside"
expect_ok
expect_verify_argv

case_name="a fixture root on the make command line wins over the default"
expect_fixtures="$temp_dir/cli fixtures"
run_make "FE_DIR=$outside" "TRANSFER_SELECTION_FIXTURE_ROOT=$expect_fixtures"
expect_ok
expect_verify_argv

case_name="an exported empty fixture root is passed through for the frontend to reject"
expect_fixtures=
TRANSFER_SELECTION_FIXTURE_ROOT= run_make "FE_DIR=$outside"
expect_ok
expect_verify_argv
expect_fe=$fe
expect_fixtures=$canonical_fixtures

case_name="make help lists the target"
"$make_bin" -C "$mk" --no-print-directory help >"$temp_dir/help" 2>&1 </dev/null \
  || fail "$case_name: make help failed: $(<"$temp_dir/help")"
grep -q '^  fe-verify-changed ' "$temp_dir/help" \
  || fail "$case_name: target missing from make help"
grep -q '^  fe-verify-changed .*RESUME=1' "$temp_dir/help" \
  || fail "$case_name: make help does not mention RESUME=1 for the target"
grep -q '^  fe-verify-changed .*NO_FAIL_FAST=1' "$temp_dir/help" \
  || fail "$case_name: make help does not mention NO_FAIL_FAST=1 for the target"
grep -q '^  fe-verify-changed .*SKIP_CT_FULL=1' "$temp_dir/help" \
  || fail "$case_name: make help does not mention SKIP_CT_FULL=1 for the target"

echo "fe-verify-changed tests passed"
