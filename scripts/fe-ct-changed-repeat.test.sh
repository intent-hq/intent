#!/usr/bin/env bash
#
# Self-test for the `make fe-ct-changed-repeat` recipe: the root entry point to
# cloudlands-fe's `pnpm run test:ct:changed-repeat`, which runs PR CI's
# "Changed Component Tests (repeated)" job locally. It runs the real recipe
# from a copy of the Makefile in a throwaway checkout whose frontend is a stub
# `corepack` recording its argv, and pins how BASE / DRY_RUN / SKIP_BUILD /
# WORKERS / REPEAT / SPECS / ARGS map onto the script's flags plus that a
# failing run fails make with the script's own code. The plan itself (and its
# parity with the CI job) is cloudlands-fe's scripts/ct-changed-repeat.test.ts.

set -euo pipefail

# The caller's environment must not steer the recipe under test.
unset BASE DRY_RUN SKIP_BUILD WORKERS REPEAT SPECS ARGS FE_DIR MAKEFLAGS MFLAGS

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "fe-ct-changed-repeat test failed: $*" >&2
  exit 1
}

make_bin=$(command -v make 2>/dev/null) || {
  echo "fe-ct-changed-repeat tests: make not found; skipped"
  exit 0
}

# An apostrophe and a space in the checkout path must not break the recipe.
mk="$temp_dir/reviewer's checkout"
fe="$mk/packages/cloudlands-fe"
bin_dir="$temp_dir/bin"
mkdir -p "$mk/scripts" "$fe/.git" "$fe/node_modules/.pnpm" "$bin_dir"
cp "$repo_root/Makefile" "$mk/Makefile"
printf 'lockfileVersion: 9\n' >"$fe/pnpm-lock.yaml"
cp "$fe/pnpm-lock.yaml" "$fe/node_modules/.pnpm/lock.yaml"

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

run_make() {
  : >"$temp_dir/log"
  set +e
  PATH="$bin_dir:$PATH" FE_TEST_LOG="$temp_dir/log" \
    "$make_bin" -C "$mk" --no-print-directory fe-ct-changed-repeat "$@" \
    >/dev/null 2>"$temp_dir/stderr" </dev/null
  status=$?
  set -e
  stderr=$(<"$temp_dir/stderr")
  log=$(<"$temp_dir/log")
}

# $@ = the flags expected after `test:ct:changed-repeat --`.
expect_argv() {
  local expected="bootstrap: --check-frontend"$'\n'"corepack: $fe"$'\n'"pnpm"$'\n'"run"$'\n'"test:ct:changed-repeat"$'\n'"--"
  [[ $# -eq 0 ]] || expected+=$'\n'"$(printf '%s\n' "$@")"
  [[ "$log" == "$expected" ]] || fail "$case_name: stub log was"$'\n'"$log"$'\n'"expected"$'\n'"$expected"
}

expect_ok() {
  [[ "$status" -eq 0 ]] || fail "$case_name: make exited $status: $stderr"
}

case_name="no knobs: the script picks the diff against origin/main"
run_make
expect_ok
expect_argv

case_name="DRY_RUN=1 becomes --dry-run, DRY_RUN=0 runs"
run_make DRY_RUN=1
expect_ok
expect_argv --dry-run
run_make DRY_RUN=0
expect_ok
expect_argv

case_name="BASE with a space and an apostrophe stays one word"
run_make "BASE=it's a ref"
expect_ok
expect_argv --base "it's a ref"

case_name="WORKERS, REPEAT and SKIP_BUILD map onto their flags"
run_make WORKERS=4 REPEAT=50 SKIP_BUILD=1
expect_ok
expect_argv --skip-build --workers 4 --repeat-each 50

case_name="SPECS become positional spec paths"
run_make "SPECS=src/a/one.ct.spec.ts src/b/two.ct.spec.ts"
expect_ok
expect_argv src/a/one.ct.spec.ts src/b/two.ct.spec.ts

case_name="ARGS go after a second -- with their shell quoting kept"
run_make DRY_RUN=1 "ARGS=--grep \"opens the menu\" --headed"
expect_ok
expect_argv --dry-run -- --grep "opens the menu" --headed

case_name="exported knobs reach the recipe like make variables"
BASE=main WORKERS=3 ARGS="--grep 'x y'" run_make
expect_ok
expect_argv --base main --workers 3 -- --grep "x y"

case_name="a failing run fails make with the script's own code"
COREPACK_STUB_EXIT=7 run_make
[[ "$status" -ne 0 ]] || fail "$case_name: make exited 0 after the script exited 7"
[[ "$stderr" == *"fe-ct-changed-repeat] Error 7"* ]] \
  || fail "$case_name: make did not report the script's code; stderr was"$'\n'"$stderr"

case_name="make help lists the target"
"$make_bin" -C "$mk" --no-print-directory help >"$temp_dir/help" 2>&1 </dev/null \
  || fail "$case_name: make help failed: $(<"$temp_dir/help")"
grep -q '^  fe-ct-changed-repeat ' "$temp_dir/help" \
  || fail "$case_name: target missing from make help"

echo "fe-ct-changed-repeat tests passed"
