#!/usr/bin/env bash
#
# Self-test for scripts/changed-script-tests.sh (`make test-scripts-changed`).
# It copies the selector into a throwaway git repo with a minimal ci.yml
# shell-tests job, makes changes on a branch, and pins the DRY_RUN plan for
# each selection rule plus the exit code of a real run with a failing step.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
fixture=$temp_dir/repo
# The selector runs under this interpreter; a 3.2 bash here checks macOS parity.
script_bash=${CHANGED_SCRIPT_TESTS_BASH:-$BASH}

fail() {
  echo "changed-script-tests test failed: $*" >&2
  exit 1
}

git_fixture() {
  git -C "$fixture" -c user.name=test -c user.email=test@example.invalid "$@"
}

mkdir -p "$fixture/scripts/sub" "$fixture/scripts/fixtures" "$fixture/.github/workflows" "$fixture/packages/intentd"
cp "$repo_root/scripts/changed-script-tests.sh" "$fixture/scripts/"
cat >"$fixture/.github/workflows/ci.yml" <<'EOF'
jobs:
  other-job:
    steps:
      - run: |
          bash scripts/not-selected.test.sh
  shell-tests:
    steps:
      - uses: actions/checkout@v7
      - run: |
          echo "shell tests: banner is not a step"
          bash scripts/alpha.test.sh

          python3 -S -B scripts/test_beta.py
      - name: later step
        run: |
          bash scripts/later-step-not-selected.sh
  after-job:
    steps:
      - run: bash scripts/after.sh
EOF
printf 'lint-shell:\n\t@echo lint ok\n' >"$fixture/Makefile"
printf 'echo alpha ok\n' >"$fixture/scripts/alpha.test.sh"
printf 'print("beta ok")\n' >"$fixture/scripts/test_beta.py"
printf 'export const x = 1;\n' >"$fixture/scripts/tool.mjs"
printf "import test from 'node:test';\ntest('tool', () => {});\n" >"$fixture/scripts/tool.test.mjs"
printf 'export const y = 1;\n' >"$fixture/scripts/untested.mjs"
printf 'nested\n' >"$fixture/scripts/sub/nested.sh"
printf 'data\n' >"$fixture/scripts/fixtures/data.txt"
: >"$fixture/packages/intentd/Cargo.toml"
git_fixture init -q -b main
git_fixture add -A
git_fixture commit -q -m base
git_fixture checkout -q -b feature

plan() {
  (cd "$fixture" && BASE=main DRY_RUN=1 "$script_bash" scripts/changed-script-tests.sh) 2>&1
}

reset_fixture() {
  git_fixture reset -q --hard main
  git_fixture clean -q -fd
}

expect_plan() {
  local label=$1 expected=$2 output steps
  output=$(plan) || fail "$label: dry run exited non-zero: $output"
  steps=$(printf '%s\n' "$output" | sed -n 's/^  //p')
  [ "$steps" = "$expected" ] ||
    fail "$label: plan mismatch"$'\n'"expected:"$'\n'"$expected"$'\n'"got:"$'\n'"$steps"
  echo "ok - $label"
}

all_suites='make lint-shell
bash scripts/alpha.test.sh
python3 -S -B scripts/test_beta.py'

expect_plan "no change runs lint-shell only" "make lint-shell"

printf '# edit\n' >>"$fixture/scripts/alpha.test.sh"
expect_plan "unstaged scripts/*.sh change runs every shell suite" "$all_suites"
reset_fixture

printf '# edit\n' >>"$fixture/Makefile"
git_fixture commit -q -am "edit Makefile"
expect_plan "committed Makefile change runs every shell suite" "$all_suites"
reset_fixture

printf '# edit\n' >>"$fixture/.github/workflows/ci.yml"
git_fixture add -A
expect_plan "staged ci.yml change runs every shell suite" "$all_suites"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/test_beta.py"
expect_plan "scripts/*.py change runs every shell suite" "$all_suites"
reset_fixture

printf 'more\n' >>"$fixture/scripts/fixtures/data.txt"
expect_plan "scripts/fixtures change runs every shell suite" "$all_suites"
reset_fixture

printf 'new\n' >"$fixture/scripts/new-helper.sh"
expect_plan "untracked scripts/*.sh runs every shell suite" "$all_suites"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/sub/nested.sh"
expect_plan "nested scripts/sub/*.sh is not a shell-tests input" "make lint-shell"
reset_fixture

printf '// edit\n' >>"$fixture/scripts/tool.mjs"
printf '// edit\n' >>"$fixture/scripts/tool.test.mjs"
expect_plan "changed .mjs and its test run that node:test suite once" 'make lint-shell
node --test scripts/tool.test.mjs'
reset_fixture

printf '// edit\n' >>"$fixture/scripts/untested.mjs"
expect_plan ".mjs without a test adds no node step" "make lint-shell"
reset_fixture

git_fixture rm -q scripts/tool.test.mjs
expect_plan "deleted test file adds no node step" "make lint-shell"
reset_fixture

# A real run executes every step and fails when one fails.
printf '# edit\n' >>"$fixture/scripts/alpha.test.sh"
output=$(cd "$fixture" && BASE=main "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "passing run exited non-zero: $output"
case "$output" in
  *"lint ok"*"alpha ok"*"beta ok"*"all selected checks passed"*) echo "ok - passing run runs every step" ;;
  *) fail "passing run output: $output" ;;
esac

printf 'exit 7\n' >>"$fixture/scripts/alpha.test.sh"
status=0
output=$(cd "$fixture" && BASE=main "$script_bash" scripts/changed-script-tests.sh 2>&1) || status=$?
[ "$status" = 1 ] || fail "failing run exit $status, want 1: $output"
case "$output" in
  *"beta ok"*"FAILED steps:"*"bash scripts/alpha.test.sh"*) echo "ok - failing step fails the run after the rest ran" ;;
  *) fail "failing run output: $output" ;;
esac
reset_fixture

rm "$fixture/packages/intentd/Cargo.toml"
git_fixture commit -q -am "drop submodule stand-in"
printf '# edit\n' >>"$fixture/scripts/alpha.test.sh"
status=0
output=$(cd "$fixture" && BASE=main "$script_bash" scripts/changed-script-tests.sh 2>&1) || status=$?
case "$status:$output" in
  "2:"*"git submodule update --init packages/intentd"*) echo "ok - missing intentd submodule is reported" ;;
  *) fail "missing submodule: exit $status: $output" ;;
esac
reset_fixture

status=0
output=$(cd "$fixture" && BASE=no-such-ref DRY_RUN=1 "$script_bash" scripts/changed-script-tests.sh 2>&1) || status=$?
case "$status:$output" in
  "2:"*"cannot find a merge base with 'no-such-ref'"*) echo "ok - unknown BASE is reported" ;;
  *) fail "unknown BASE: exit $status: $output" ;;
esac

echo "changed-script-tests tests passed"
