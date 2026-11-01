#!/usr/bin/env bash
#
# Self-test for scripts/check-dry-run-targets.sh (`make check-dry-run-targets`):
# fixture Makefiles pin which targets it discovers and that an unguarded one
# fails it, then the real Makefile must pass (its coverage-e2e / coverage-all
# once launched a full instrumented run under DRY_RUN=1).

set -euo pipefail

unset DRY_RUN MAKEFLAGS MFLAGS MAKELEVEL DRY_RUN_CHECK_TIMEOUT

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
checker="$repo_root/scripts/check-dry-run-targets.sh"
temp_dir=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "check-dry-run-targets test failed: $*" >&2
  exit 1
}

command -v make >/dev/null 2>&1 || {
  echo "check-dry-run-targets tests: make not found; skipped"
  exit 0
}

# $1 = case dir; the Makefile body comes on stdin.
fixture() {
  mkdir -p "$temp_dir/$1"
  cat >"$temp_dir/$1/Makefile"
}

run_checker() {
  set +e
  output=$("$checker" --makefile-dir "$temp_dir/$1" 2>&1)
  status=$?
  set -e
}

expect_line() {
  printf '%s\n' "$output" | grep -qF -- "$1" \
    || fail "$case_name: expected a line with '$1'; output was"$'\n'"$output"
}

reject_line() {
  ! printf '%s\n' "$output" | grep -qF -- "$1" \
    || fail "$case_name: unexpected '$1'; output was"$'\n'"$output"
}

case_name="guarded targets pass; unrelated cargo targets are not run"
fixture guarded <<'MK'
plan: ## Build things (DRY_RUN=1 prints the plan)
	@if [ -n "$(DRY_RUN)" ] && [ "$(DRY_RUN)" != 0 ]; then echo "would build"; exit 0; fi; cargo build

handoff:
	@DRY_RUN="$(DRY_RUN)" sh -c 'if [ -n "$$DRY_RUN" ]; then echo plan; else cargo test; fi'

coverage-quick: ## Coverage (DRY_RUN=1 prints the plan)
	@if [ -n "$(DRY_RUN)" ] && [ "$(DRY_RUN)" != 0 ]; then echo plan; exit 0; fi; \
	cargo llvm-cov nextest

build:
	cargo build
MK
run_checker guarded
[[ "$status" -eq 0 ]] || fail "$case_name: exited $status; output was"$'\n'"$output"
expect_line "ok   plan "
expect_line "ok   handoff "
expect_line "ok   coverage-quick "
reject_line " build"

case_name="a documented but unguarded target fails, naming the cargo call"
fixture documented <<'MK'
slow: ## Slow run (DRY_RUN=1 prints the plan)
	cargo nextest run --workspace
MK
run_checker documented
[[ "$status" -eq 1 ]] || fail "$case_name: exited $status, expected 1; output was"$'\n'"$output"
expect_line "FAIL slow: DRY_RUN=1 started cargo-family processes:"
expect_line "cargo nextest run --workspace"

case_name="an exit 0 on its own recipe line does not skip the next line"
fixture split <<'MK'
split: ## Split guard (DRY_RUN=1 prints the plan)
	@if [ -n "$(DRY_RUN)" ]; then echo plan; exit 0; fi
	cargo llvm-cov nextest
MK
run_checker split
[[ "$status" -eq 1 ]] || fail "$case_name: exited $status, expected 1; output was"$'\n'"$output"
expect_line "FAIL split:"

case_name="a recipe that reads DRY_RUN but still probes cargo fails"
fixture probe <<'MK'
probe:
	@cargo nextest --version >/dev/null
	@if [ -n "$(DRY_RUN)" ]; then echo plan; exit 0; fi
MK
run_checker probe
[[ "$status" -eq 1 ]] || fail "$case_name: exited $status, expected 1; output was"$'\n'"$output"
expect_line "FAIL probe:"
expect_line "cargo nextest --version"

case_name="an undocumented coverage-* sibling is checked, through a script it calls"
fixture family <<'MK'
coverage-changed: ## Changed tests under coverage (DRY_RUN=1 prints the plan)
	@if [ -n "$(DRY_RUN)" ]; then echo plan; exit 0; fi

coverage-full:
	./run-coverage.sh
MK
printf '#!/bin/sh\ncommand -v cargo-llvm-cov >/dev/null && cargo-llvm-cov clean\nrustup component list --installed\n' \
  >"$temp_dir/family/run-coverage.sh"
chmod +x "$temp_dir/family/run-coverage.sh"
run_checker family
[[ "$status" -eq 1 ]] || fail "$case_name: exited $status, expected 1; output was"$'\n'"$output"
expect_line "ok   coverage-changed "
expect_line "FAIL coverage-full:"
expect_line "cargo-llvm-cov clean"
expect_line "rustup component list --installed"

case_name="a non-zero dry-run exit without cargo is reported, not failed; rustup which is allowed"
fixture early <<'MK'
early: ## Needs origin/main (DRY_RUN=1 prints the plan)
	@rustup which cargo >/dev/null
	@echo "no merge base" >&2; exit 2
MK
run_checker early
[[ "$status" -eq 0 ]] || fail "$case_name: exited $status; output was"$'\n'"$output"
expect_line "ok   early (exit 2, no cargo)"

case_name="target-specific variables and DRY_RUN in variable lines are not targets"
fixture vars <<'MK'
coverage-x: COVERAGE_SCOPE = x
LIST = $(DRY_RUN)
coverage-x:
	@if [ -n "$(DRY_RUN)" ]; then echo plan; exit 0; fi
MK
run_checker vars
[[ "$status" -eq 0 ]] || fail "$case_name: exited $status; output was"$'\n'"$output"
expect_line "ok   coverage-x "
[[ $(printf '%s\n' "$output" | grep -c '^ok ') -eq 1 ]] \
  || fail "$case_name: expected exactly one checked target; output was"$'\n'"$output"

if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  case_name="a dry run that outlives the timeout fails"
  fixture hang <<'MK'
hang: ## Hangs (DRY_RUN=1 prints the plan)
	@read -r _ <"$(CURDIR)/fifo"
MK
  mkfifo "$temp_dir/hang/fifo"
  set +e
  output=$(DRY_RUN_CHECK_TIMEOUT=1 "$checker" --makefile-dir "$temp_dir/hang" 2>&1)
  status=$?
  set -e
  [[ "$status" -eq 1 ]] || fail "$case_name: exited $status, expected 1; output was"$'\n'"$output"
  expect_line "FAIL hang: still running after 1s under DRY_RUN=1"
fi

case_name="a target that runs the checker itself does not recurse"
fixture nested <<MK
check-self: ## Runs the DRY_RUN check
	@bash '$checker' --makefile-dir '\$(CURDIR)'
MK
run_checker nested
[[ "$status" -eq 0 ]] || fail "$case_name: exited $status; output was"$'\n'"$output"
expect_line "ok   check-self (exit 0, no cargo)"

case_name="the real Makefile: every DRY_RUN target exits without cargo"
[[ -e "$repo_root/packages/intentd/.git" ]] \
  || fail "packages/intentd is not initialized; run git submodule update --init packages/intentd"
set +e
output=$("$checker" 2>&1)
status=$?
set -e
[[ "$status" -eq 0 ]] || fail "$case_name: exited $status; output was"$'\n'"$output"
for target in coverage-e2e coverage-all coverage-changed test-changed check-dry-run-targets; do
  expect_line "ok   $target "
done

echo "check-dry-run-targets tests passed"
