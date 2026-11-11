#!/usr/bin/env bash
#
# Self-test for scripts/changed-script-tests.sh (`make test-scripts-changed`).
# It copies the selector into a throwaway git repo with a minimal ci.yml
# shell-tests job and python-tests pathspec step and a Makefile test-scripts recipe, makes changes on a branch,
# and pins the DRY_RUN plan (and the printed reason) for each selection rule plus
# the exit code of a real run with a failing step. Then, unless it is already
# on one, it reruns itself with the selector under a Bash 3.2 (stock macOS).

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
fixture=$temp_dir/repo
# The selector runs under this interpreter. It defaults to the one running this
# suite; the Bash 3.2 pass at the end reruns the suite with a real Bash 3 here.
script_bash=${CHANGED_SCRIPT_TESTS_BASH:-$BASH}

fail() {
  echo "changed-script-tests test failed: $*" >&2
  exit 1
}

# shellcheck source=scripts/find-bash3.sh
source "$repo_root/scripts/find-bash3.sh"

# CI's shell-tests-bash3 job sets REQUIRE_BASH3: a wrong CHANGED_SCRIPT_TESTS_BASH
# must fail there, not quietly test a newer bash, and so must a missing Bash 3
# for the rerun at the end (checked here, before the first pass spends minutes).
if [ -n "${REQUIRE_BASH3:-}" ]; then
  if [ -n "${CHANGED_SCRIPT_TESTS_BASH:-}" ]; then
    "$script_bash" -c '[ "${BASH_VERSINFO[0]}" -eq 3 ]' 2>/dev/null ||
      fail "REQUIRE_BASH3 is set but CHANGED_SCRIPT_TESTS_BASH ('$CHANGED_SCRIPT_TESTS_BASH') is not Bash 3"
  elif [ "${BASH_VERSINFO[0]}" -ne 3 ] && ! find_bash3 >/dev/null; then
    fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set ($(bash3_missing_hint); or unset REQUIRE_BASH3 to skip the real 3.2 run)"
  fi
fi

git_fixture() {
  git -C "$fixture" -c user.name=test -c user.email=test@example.invalid "$@"
}

mkdir -p "$fixture/scripts/sub" "$fixture/scripts/fixtures" "$fixture/.github/workflows" "$fixture/packages/intentd"
cp "$repo_root/scripts/changed-script-tests.sh" "$repo_root/scripts/find-bash3.sh" "$fixture/scripts/"
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
          bash scripts/top.test.sh

          python3 -S -B scripts/test_beta.py
          bash scripts/lint-fixed-sleeps.sh
      - name: later step
        run: |
          bash scripts/later-step-not-selected.sh
  python-tests:
    steps:
      - name: Decoy step
        run: |
          changed=$(git diff --name-only HEAD^1 HEAD -- decoy-not-selected)
      - name: Select Python test changes
        run: |
          if true; then
            changed=$(git diff --name-only HEAD^1 HEAD -- 'scripts/*.py' 'scripts/*.sh' scripts/fixtures scripts/_vendor "docs/py data" Makefile .github/workflows/ci.yml)
          fi
  after-job:
    steps:
      - run: bash scripts/after.sh
EOF
# test-scripts lists its modules over a continuation line, as the real one may.
printf 'lint-shell:\n\t@echo lint ok\n\ntest-scripts: ## unit tests\n\tpython3 -S -B -m unittest -v scripts.test_eps \\\n\t  scripts.test_zeta scripts.test_middle\n\nother:\n\t@echo not a module scripts.test_other\n' >"$fixture/Makefile"
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
# base.py is a helper no check names: middle.py imports it and top.sh runs
# middle.py. scripts.test_middle and top.test.sh cover base.py through them.
printf 'x = 1\n' >"$fixture/scripts/base.py"
printf '# import base\nx = 1\n' >"$fixture/scripts/middle.py"
printf 'python3 scripts/middle.py\n' >"$fixture/scripts/top.sh"
printf 'echo top ok\n' >"$fixture/scripts/top.test.sh"
printf 'import unittest\nfrom scripts import middle\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(middle.x, 1)\n' >"$fixture/scripts/test_middle.py"
# loop-a.sh and loop-b.sh source each other and no check names either.
printf '. scripts/loop-b.sh\n' >"$fixture/scripts/loop-a.sh"
printf '. scripts/loop-a.sh\n' >"$fixture/scripts/loop-b.sh"
# split.sh has a user alpha.test.sh names and a user no check names.
printf 'echo split\n' >"$fixture/scripts/split.sh"
printf '. scripts/split.sh\n' >"$fixture/scripts/named-user.sh"
printf '. scripts/split.sh\n' >"$fixture/scripts/bare-user.sh"
printf '# also covers named-user.sh\n' >>"$fixture/scripts/alpha.test.sh"
# pyhelp.py is used only by kappa.py, which only the scripts.test_zeta module covers.
printf 'x = 1\n' >"$fixture/scripts/pyhelp.py"
printf '# import pyhelp\n' >>"$fixture/scripts/kappa.py"
# The lint-fixed-sleeps.sh suite is itself a user of doze.sh.
printf 'echo sleep helper\n' >"$fixture/scripts/doze.sh"
printf '# uses doze.sh\n' >>"$fixture/scripts/lint-fixed-sleeps.sh"
printf 'export const x = 1;\n' >"$fixture/scripts/tool.mjs"
printf "import test from 'node:test';\ntest('tool', () => {});\n" >"$fixture/scripts/tool.test.mjs"
printf 'export const y = 1;\n' >"$fixture/scripts/untested.mjs"
printf 'nested\n' >"$fixture/scripts/sub/nested.sh"
printf 'data\n' >"$fixture/scripts/fixtures/data.txt"
mkdir -p "$fixture/docs/py data"
printf 'data\n' >"$fixture/docs/py data/input.json"
printf 'decoy\n' >"$fixture/decoy-not-selected"
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
bash scripts/top.test.sh
python3 -S -B scripts/test_beta.py
bash scripts/lint-fixed-sleeps.sh'
all_suites='make lint-shell
make test-scripts
bash scripts/alpha.test.sh
bash scripts/top.test.sh
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

# A shared helper selects the checks of its users, not every suite (intent
# PR 8305 changed the shared test runner and ran every suite for over 30 min).
printf '# edit\n' >>"$fixture/scripts/helper.sh"
expect_plan "shared helper runs the checks that name it or its users, not every suite" 'make lint-shell
bash scripts/alpha.test.sh'
expect_reason "shared helper says who uses it" "scripts/helper.sh is a shared helper; also selecting the checks of the scripts that use it: scripts/run.sh"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/base.py"
expect_plan "shared helper follows its users through other scripts" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_middle
bash scripts/top.test.sh'
expect_reason "transitive helper lists every user" "scripts/base.py is a shared helper; also selecting the checks of the scripts that use it: scripts/middle.py scripts/top.sh"
expect_reason "transitive module selection says how" "selected scripts.test_middle (make test-scripts): own test of scripts/middle.py, which uses base.py"
expect_reason "transitive suite selection says how" "selected scripts/top.test.sh: own test of scripts/top.sh, which uses middle.py, which uses base.py"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/middle.py"
expect_plan "a user in the middle selects its own checks and its users', not its helper's" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_middle
bash scripts/top.test.sh'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/loop-a.sh"
expect_plan "helpers that use each other terminate and fall back to every shell suite" "$all_shell"
expect_reason "uncovered helper says why" "scripts/loop-a.sh (no suite or test-scripts module names it or a script that uses it)"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/split.sh"
expect_plan "a helper with a user no check names runs every shell suite, as that user would" "$all_shell"
expect_reason "uncovered user says why" "scripts/split.sh (used by scripts/bare-user.sh, which no suite or test-scripts module names)"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/pyhelp.py"
expect_plan "a helper whose user only a test-scripts module covers skips the shell suites" 'make lint-shell
python3 -S -B -m unittest -v scripts.test_zeta'
reset_fixture

printf '# edit\n' >>"$fixture/scripts/doze.sh"
expect_plan "a suite that is itself a user of the helper is selected" 'make lint-shell
bash scripts/lint-fixed-sleeps.sh'
expect_reason "suite user says why" "it is lint-fixed-sleeps.sh, which uses doze.sh"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/base.py"
printf '# edit\n' >>"$fixture/Makefile"
expect_plan "a Makefile change still runs everything next to a shared helper" "$all_suites"
reset_fixture

printf '# edit\n' >>"$fixture/scripts/orphan.sh"
expect_plan "script no suite names runs every shell suite" "$all_shell"
expect_reason "unnamed script says why" "scripts/orphan.sh (no suite or test-scripts module names it)"
expect_reason "unnamed script skips the Python unit tests" "no make test-scripts module names a changed script"
reset_fixture

# The make test-scripts modules (intent PR 8290 changed the stress runner and
# no local step ran its own unittest module).
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
mkdir -p "$fixture/scripts/_vendor/tomli"
printf 'license\n' >"$fixture/scripts/_vendor/tomli/LICENSE"
expect_plan "vendored file change runs only make test-scripts" 'make lint-shell
make test-scripts'
expect_reason "vendored file change says why make test-scripts runs" "all make test-scripts modules selected (full run: scripts/_vendor/tomli/LICENSE)"
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
expect_plan "nested scripts/sub/*.sh is no shell-tests input but matches the python-tests pathspec" 'make lint-shell
make test-scripts'
reset_fixture

printf 'more\n' >>"$fixture/docs/py data/input.json"
expect_plan "a file the ci.yml python-tests pathspec names runs only make test-scripts" 'make lint-shell
make test-scripts'
expect_reason "python-tests pathspec match says why" "all make test-scripts modules selected (full run: docs/py data/input.json)"
reset_fixture

printf 'more\n' >>"$fixture/decoy-not-selected"
expect_plan "another step's git diff pathspec is not read" "make lint-shell"
reset_fixture

sed 's/name: Select Python test changes/name: Renamed step/' "$fixture/.github/workflows/ci.yml" >"$temp_dir/ci.yml"
cp "$temp_dir/ci.yml" "$fixture/.github/workflows/ci.yml"
status=0
output=$(plan) || status=$?
case "$status:$output" in
  "2:"*"no git diff pathspec found in the .github/workflows/ci.yml python-tests 'Select Python test changes' step"*)
    echo "ok - a missing python-tests pathspec fails instead of skipping" ;;
  *) fail "missing python-tests pathspec: exit $status: $output" ;;
esac
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
  *"lint ok"*"Ran 3 tests"*"alpha ok"*"top ok"*"beta ok"*"all selected checks passed"*) echo "ok - passing run runs every step" ;;
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

# The Bash 3.2 pass: the shell-tests-bash3 lines that start a selected suite
# under "$BASH3_BIN" run when the suites' Bash 3 lookup finds an interpreter.
# The other lines rerun a suite that already reran itself under that
# interpreter, so they are not repeated. Last, so no other case sees the job.
git_fixture checkout -q main
cat >>"$fixture/.github/workflows/ci.yml" <<'EOF'
  shell-tests-bash3:
    steps:
      - uses: ./.github/actions/setup-bash3
      - run: |
          "$BASH3_BIN" --version
          REQUIRE_BASH3=1 bash scripts/alpha.test.sh
          REQUIRE_BASH3=1 STARTUP_ONLY=1 "$BASH3_BIN" scripts/top.test.sh
          "$BASH3_BIN" scripts/not-in-shell-tests.test.sh
EOF
git_fixture commit -q -am "add the Bash 3.2 job"
git_fixture checkout -q feature
reset_fixture
# A stand-in Bash 3: it passes the lookup's version probe and logs its runs.
stub_bash3=$temp_dir/stub-bash3
printf '#!/bin/sh\n[ "$1" = -c ] && exit 0\necho "bash3 ran $* startup=${STARTUP_ONLY:-}"\n' >"$stub_bash3"
chmod +x "$stub_bash3"
bash3_plan() {
  (cd "$fixture" && BASE=main DRY_RUN=1 BASH3_BIN=$stub_bash3 "$script_bash" scripts/changed-script-tests.sh) 2>&1
}

printf '# edit\n' >>"$fixture/scripts/top.sh"
output=$(bash3_plan) || fail "Bash 3.2 dry run exited non-zero: $output"
[ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = 'make lint-shell
bash scripts/top.test.sh
REQUIRE_BASH3=1 STARTUP_ONLY=1 "$BASH3_BIN" scripts/top.test.sh' ] ||
  fail "Bash 3.2 pass plan: $output"
case "$output" in
  *"Bash 3.2 pass with $stub_bash3"*"scripts/top.test.sh"*) echo "ok - a selected suite's direct Bash 3.2 line runs when an interpreter is found" ;;
  *) fail "Bash 3.2 pass reason: $output" ;;
esac
output=$(cd "$fixture" && BASE=main BASH3_BIN=$stub_bash3 "$script_bash" scripts/changed-script-tests.sh 2>&1) ||
  fail "Bash 3.2 pass run exited non-zero: $output"
case "$output" in
  *"top ok"*"bash3 ran scripts/top.test.sh startup=1"*"all selected checks passed"*) echo "ok - the Bash 3.2 line runs under the found interpreter" ;;
  *) fail "Bash 3.2 pass run output: $output" ;;
esac
reset_fixture

printf '# edit\n' >>"$fixture/scripts/alpha.sh"
output=$(bash3_plan) || fail "Bash 3.2 dry run exited non-zero: $output"
[ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = 'make lint-shell
bash scripts/alpha.test.sh' ] ||
  fail "a suite that reruns itself under Bash 3 got a second run: $output"
echo "ok - a suite with no direct Bash 3.2 line runs once"
reset_fixture

printf '# edit\n' >>"$fixture/Makefile"
output=$(bash3_plan) || fail "Bash 3.2 dry run exited non-zero: $output"
[ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = "$all_suites"'
REQUIRE_BASH3=1 STARTUP_ONLY=1 "$BASH3_BIN" scripts/top.test.sh' ] ||
  fail "full run Bash 3.2 pass: $output"
echo "ok - a full run adds only the Bash 3.2 lines of shell-tests suites"
reset_fixture

if (BASH3_BIN="" BASH3_CACHE_DIR=$temp_dir/no-bash3 find_bash3 >/dev/null); then
  echo "ok - # SKIP missing Bash 3.2 case: this host has one outside the cache (stock macOS)"
else
  printf '# edit\n' >>"$fixture/scripts/top.sh"
  output=$(cd "$fixture" && BASE=main DRY_RUN=1 BASH3_BIN="" BASH3_CACHE_DIR=$temp_dir/no-bash3 \
    "$script_bash" scripts/changed-script-tests.sh 2>&1) || fail "dry run without Bash 3 exited non-zero: $output"
  [ "$(printf '%s\n' "$output" | sed -n 's/^  //p')" = 'make lint-shell
bash scripts/top.test.sh' ] || fail "plan without Bash 3: $output"
  case "$output" in
    *"Bash 3.2 pass skipped"*"make bash3"*) echo "ok - a missing interpreter skips the Bash 3.2 pass and says how to get one" ;;
    *) fail "missing Bash 3 notice: $output" ;;
  esac
  reset_fixture
fi

echo "changed-script-tests tests passed with the selector under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[ -z "${CHANGED_SCRIPT_TESTS_BASH:-}" ] || exit 0

# The selector must parse and run under Bash 3.2 (stock macOS), so rerun the
# whole suite, selector included, under a real Bash 3 from the shared lookup
# (find-bash3.sh; `make bash3` builds one), as the other shell suites do. A
# missing Bash 3 is a skip notice by default; under REQUIRE_BASH3 (CI) the
# check at the top has already failed the run before the first pass.
if [ "${BASH_VERSINFO[0]}" -eq 3 ]; then
  : # the selector above already ran under Bash 3
elif bash3=$(find_bash3); then
  CHANGED_SCRIPT_TESTS_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
else
  echo "changed-script-tests tests: no Bash 3 interpreter found ($(bash3_missing_hint)); real 3.2 run skipped"
fi
