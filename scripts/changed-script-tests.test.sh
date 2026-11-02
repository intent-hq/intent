#!/usr/bin/env bash
#
# Self-test for scripts/changed-script-tests.sh (`make test-scripts-changed`).
# It copies the selector into a throwaway git repo with a minimal ci.yml
# shell-tests job and a Makefile test-scripts recipe, makes changes on a branch,
# and pins the DRY_RUN plan (and the printed reason) for each selection rule plus
# the exit code of a real run with a failing step.

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
          bash scripts/lint-fixed-sleeps.sh
      - name: later step
        run: |
          bash scripts/later-step-not-selected.sh
  after-job:
    steps:
      - run: bash scripts/after.sh
EOF
# test-scripts lists its modules over a continuation line, as the real one may.
printf 'lint-shell:\n\t@echo lint ok\n\ntest-scripts: ## unit tests\n\tpython3 -S -B -m unittest -v scripts.test_eps \\\n\t  scripts.test_zeta\n\nother:\n\t@echo not a module scripts.test_other\n' >"$fixture/Makefile"
# test_eps.py is eps.py's own module; test_zeta.py names kappa.py by module.
: >"$fixture/scripts/__init__.py"
printf 'x = 1\n' >"$fixture/scripts/eps.py"
printf 'x = 1\n' >"$fixture/scripts/kappa.py"
printf 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n' >"$fixture/scripts/test_eps.py"
printf 'import unittest\nfrom scripts import kappa\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(kappa.x, 1)\n' >"$fixture/scripts/test_zeta.py"
printf 'echo alpha ok\n' >"$fixture/scripts/alpha.test.sh"
# test_beta.py names gamma.sh by file name and delta.py by module name.
printf '# runs gamma.sh\nimport delta\nprint("beta ok")\n' >"$fixture/scripts/test_beta.py"
printf 'echo lint-sleeps ok\n' >"$fixture/scripts/lint-fixed-sleeps.sh"
printf 'echo alpha\n' >"$fixture/scripts/alpha.sh"
printf 'x = 1\n' >"$fixture/scripts/beta.py"
printf 'echo gamma\n' >"$fixture/scripts/gamma.sh"
printf 'x = 1\n' >"$fixture/scripts/delta.py"
printf 'echo orphan\n' >"$fixture/scripts/orphan.sh"
# helper.sh is named by alpha.test.sh, but run.sh (not a test) sources it.
printf 'echo helper\n' >"$fixture/scripts/helper.sh"
printf '. scripts/helper.sh\n' >"$fixture/scripts/run.sh"
printf '# also covers helper.sh and run.sh\n' >>"$fixture/scripts/alpha.test.sh"
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

all_shell='make lint-shell
bash scripts/alpha.test.sh
python3 -S -B scripts/test_beta.py
bash scripts/lint-fixed-sleeps.sh'
all_suites='make lint-shell
make test-scripts
bash scripts/alpha.test.sh
python3 -S -B scripts/test_beta.py
bash scripts/lint-fixed-sleeps.sh'

expect_plan "no change runs lint-shell only" "make lint-shell"

expect_reason() {
  local label=$1 want=$2 output
  output=$(plan) || fail "$label: dry run exited non-zero: $output"
  case "$output" in
    *"$want"*) echo "ok - $label" ;;
    *) fail "$label: output lacks '$want': $output" ;;
  esac
}

printf '# edit\n' >>"$fixture/scripts/alpha.sh"
expect_plan "scripts/X.sh selects its own X.test.sh" 'make lint-shell
bash scripts/alpha.test.sh'
expect_reason "own-test selection says why" "selected scripts/alpha.test.sh: own test of scripts/alpha.sh"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/beta.py"
expect_plan "scripts/X.py selects its own test_X.py" 'make lint-shell
python3 -S -B scripts/test_beta.py'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/gamma.sh"
expect_plan "a suite that names the script by file is selected" 'make lint-shell
python3 -S -B scripts/test_beta.py'
expect_reason "mention selection says why" "selected scripts/test_beta.py: mentions gamma.sh"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/delta.py"
expect_plan "a suite that imports the .py module is selected" 'make lint-shell
python3 -S -B scripts/test_beta.py'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/alpha.sh"
printf '# edit\n' >>"$fixture/scripts/gamma.sh"
expect_plan "two scripts select the union of their suites in ci.yml order" 'make lint-shell
bash scripts/alpha.test.sh
python3 -S -B scripts/test_beta.py'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/alpha.test.sh"
expect_plan "unstaged suite change runs it and the fixed-sleep lint" 'make lint-shell
bash scripts/alpha.test.sh
bash scripts/lint-fixed-sleeps.sh'
expect_reason "fixed-sleep lint selection says why" "scans every scripts/*.test.sh"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/test_beta.py"
expect_plan "python suite change runs only that suite" 'make lint-shell
python3 -S -B scripts/test_beta.py'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/helper.sh"
expect_plan "shared helper runs every shell suite and make test-scripts" "$all_suites"
expect_reason "shared helper says who uses it" "scripts/helper.sh (shared helper: scripts/run.sh names it)"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/orphan.sh"
expect_plan "script no suite names runs every shell suite" "$all_shell"
expect_reason "unnamed script says why" "scripts/orphan.sh (no suite or test-scripts module names it)"
expect_reason "unnamed script skips the Python unit tests" "no make test-scripts module names a changed script"
reset_fixture

# The make test-scripts modules (intent PR 8290 changed nextest_stress.py and
# no local step ran its scripts.test_nextest_stress).
printf '# edit\n' >>"$fixture/scripts/eps.py"
expect_plan "scripts/X.py runs its own test-scripts module, not every shell suite" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_eps'
expect_reason "module selection says why" "selected scripts.test_eps (make test-scripts): own test of scripts/eps.py"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/test_eps.py"
expect_plan "a changed test-scripts module runs itself" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_eps'
expect_reason "changed module says why" "selected scripts.test_eps (make test-scripts): the suite itself changed"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/kappa.py"
expect_plan "a module that imports the changed script is selected" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_zeta'
expect_reason "module mention says why" "selected scripts.test_zeta (make test-scripts): mentions kappa.py"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/kappa.py"
printf '# edit\n' >>"$fixture/scripts/eps.py"
expect_plan "two scripts run their modules in one command, in Makefile order" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_eps scripts.test_zeta'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/beta.py"
printf '# edit\n' >>"$fixture/scripts/eps.py"
expect_plan "a module and a shell suite are both selected" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_eps
python3 -S -B scripts/test_beta.py'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/alpha.sh"
output=$(cd "$fixture" && BASE=main DRY_RUN=1 FULL=1 "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "FULL=1 dry run exited non-zero: $output"
[ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = "$all_suites" ] ||
  fail "FULL=1 did not select every suite: $output"
echo "ok - FULL=1 runs every shell suite and make test-scripts"
reset_fixture

output=$(cd "$fixture" && BASE=main DRY_RUN=1 FULL=1 "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "FULL=1 without changes exited non-zero: $output"
[ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = "$all_suites" ] ||
  fail "FULL=1 without changes did not select every suite: $output"
echo "ok - FULL=1 runs every shell suite with no change"

printf '# edit\n' >>"$fixture/Makefile"
git_fixture commit -q -am "edit Makefile"
expect_plan "committed Makefile change runs every shell suite" "$all_suites"
expect_reason "Makefile change says why make test-scripts runs" "all make test-scripts modules selected (full run: Makefile)"
reset_fixture

printf '# edit\n' >>"$fixture/.github/workflows/ci.yml"
git_fixture add -A
expect_plan "staged ci.yml change runs every shell suite" "$all_suites"
reset_fixture

printf 'more\n' >>"$fixture/scripts/fixtures/data.txt"
expect_plan "scripts/fixtures change runs every shell suite" "$all_suites"
reset_fixture

printf 'new\n' >"$fixture/scripts/new-helper.sh"
expect_plan "untracked script no suite names runs every shell suite" "$all_shell"
reset_fixture

git_fixture rm -q scripts/gamma.sh
expect_plan "deleted script still selects the suites that name it" 'make lint-shell
python3 -S -B scripts/test_beta.py'
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
output=$(cd "$fixture" && BASE=main FULL=1 "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "passing run exited non-zero: $output"
case "$output" in
  *"lint ok"*"Ran 2 tests"*"alpha ok"*"beta ok"*"all selected checks passed"*) echo "ok - passing run runs every step" ;;
  *) fail "passing run output: $output" ;;
esac

reset_fixture

# A selected node:test file name with a space or shell metacharacters reaches
# node as one argument and is never interpreted by the shell.
odd_name='scripts/odd name;touch pwned.test.mjs'
printf "import test from 'node:test';\ntest('odd', () => {});\n" >"$fixture/$odd_name"
output=$(cd "$fixture" && BASE=main "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "odd node:test file name run exited non-zero: $output"
if [ -e "$fixture/pwned.test.mjs" ] || [ -e "$fixture/pwned" ]; then
  fail "odd node:test file name was interpreted by the shell: $output"
fi
case "$output" in
  *"all selected checks passed"*) echo "ok - odd node:test file name stays one argument" ;;
  *) fail "odd node:test file name output: $output" ;;
esac
reset_fixture

printf '# edit\n' >>"$fixture/scripts/alpha.test.sh"
printf 'exit 7\n' >>"$fixture/scripts/alpha.test.sh"
status=0
output=$(cd "$fixture" && BASE=main FULL=1 "$script_bash" scripts/changed-script-tests.sh 2>&1) || status=$?
[ "$status" = 1 ] || fail "failing run exit $status, want 1: $output"
case "$output" in
  *"beta ok"*"FAILED steps:"*"bash scripts/alpha.test.sh"*) echo "ok - failing step fails the run after the rest ran" ;;
  *) fail "failing run output: $output" ;;
esac
reset_fixture

printf '# edit\n' >>"$fixture/scripts/eps.py"
printf 'class Broken(unittest.TestCase):\n    def test_fails(self):\n        self.fail("broken")\n' >>"$fixture/scripts/test_eps.py"
status=0
output=$(cd "$fixture" && BASE=main "$script_bash" scripts/changed-script-tests.sh 2>&1) || status=$?
[ "$status" = 1 ] || fail "failing module run exit $status, want 1: $output"
case "$output" in
  *"FAIL: test_fails"*"FAILED steps:"*"python3 -S -B -m unittest -v scripts.test_eps"*) echo "ok - failing test-scripts module fails the run" ;;
  *) fail "failing module run output: $output" ;;
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
