#!/usr/bin/env bash
#
# Run, locally, the script checks CI would run for the current change
# (`make test-scripts-changed`). CI runs the shell suites only in the merge
# queue, so this is the one place to catch a broken suite or a shellcheck
# finding before pushing (intent-hq/intent#7472 took two extra rounds).
#
# Changed files are everything that differs from merge-base(BASE, HEAD) — the
# branch's commits plus staged, unstaged and untracked work. BASE defaults to
# origin/main. The plan is:
#   1. `make lint-shell`, always.
#   2. Every suite of the ci.yml `shell-tests` job (read from its first run
#      step, so there is no second list to drift) when the Makefile, ci.yml,
#      scripts/*.sh, scripts/*.py or scripts/fixtures/** changed.
#   3. `node --test scripts/X.test.mjs` for each changed scripts/X.mjs or
#      scripts/X.test.mjs whose test file exists.
# DRY_RUN=1 prints the plan without running it. Every step runs; the exit code
# is non-zero when any step failed, and the failures are listed at the end.
# Must parse and run under Bash 3.2 (stock macOS).

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_root"

base_ref=${BASE:-origin/main}
ci_file=.github/workflows/ci.yml

die() {
  echo "test-scripts-changed: $*" >&2
  exit 2
}

merge_base=$(git merge-base "$base_ref" HEAD 2>/dev/null) ||
  die "cannot find a merge base with '$base_ref' (run git fetch origin main, or set BASE=<ref>)"

changed=$( {
  git diff --name-only "$merge_base" --
  git ls-files --others --exclude-standard
} | LC_ALL=C sort -u)

# Lines of the first `run: |` block in the shell-tests job, minus echo lines.
shell_suites() {
  [ -f "$ci_file" ] || die "$ci_file not found"
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_job = ($1 == "shell-tests:"); next }
    !in_job { next }
    in_block {
      if ($0 ~ /^[[:space:]]*$/) next
      match($0, /^ */)
      if (RLENGTH <= block_indent) exit
      line = substr($0, RLENGTH + 1)
      if (line !~ /^echo /) print line
      next
    }
    /^[[:space:]]*(- )?run: \|[[:space:]]*$/ {
      match($0, /^ */); block_indent = RLENGTH; in_block = 1
    }
  ' "$ci_file"
}

run_all_shell=0
node_tests=""
reasons=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    Makefile | "$ci_file" | scripts/fixtures/*)
      run_all_shell=1; reasons="$reasons $path" ;;
    scripts/*/*) ;;
    scripts/*.sh | scripts/*.py)
      run_all_shell=1; reasons="$reasons $path" ;;
    scripts/*.test.mjs)
      [ -f "$path" ] && node_tests="$node_tests$path"$'\n' ;;
    scripts/*.mjs)
      candidate=${path%.mjs}.test.mjs
      [ -f "$candidate" ] && node_tests="$node_tests$candidate"$'\n' ;;
  esac
done <<EOF
$changed
EOF

steps="make lint-shell"$'\n'
if [ "$run_all_shell" = 1 ]; then
  suites=$(shell_suites)
  [ -n "$suites" ] || die "no commands found in the $ci_file shell-tests job"
  steps="$steps$suites"$'\n'
fi
if [ -n "$node_tests" ]; then
  while IFS= read -r test_file; do
    [ -n "$test_file" ] && steps="${steps}node --test $test_file"$'\n'
  done <<EOF
$(printf '%s' "$node_tests" | LC_ALL=C sort -u)
EOF
fi

changed_count=$(printf '%s\n' "$changed" | grep -c . || true)
echo "test-scripts-changed: $changed_count changed file(s) vs $base_ref (merge base ${merge_base:0:12})"
if [ "$run_all_shell" = 1 ]; then
  echo "test-scripts-changed: all shell-tests suites selected (changed:$reasons)"
else
  echo "test-scripts-changed: no Makefile, ci.yml or scripts/*.sh|*.py change; shell suites skipped"
fi

if [ -n "${DRY_RUN:-}" ] && [ "${DRY_RUN}" != 0 ]; then
  echo "test-scripts-changed: plan (DRY_RUN):"
  printf '%s' "$steps" | sed 's/^/  /'
  exit 0
fi

if [ "$run_all_shell" = 1 ] && [ ! -f packages/intentd/Cargo.toml ]; then
  die "the shell suites need the intentd submodule, as in CI: git submodule update --init packages/intentd"
fi
if [ -n "$node_tests" ] && ! command -v node >/dev/null 2>&1; then
  die "node is required for the node:test suites; run make bootstrap-dev-host"
fi

failed=""
while IFS= read -r step; do
  [ -n "$step" ] || continue
  echo "==> $step"
  if ! bash -c "$step" </dev/null; then
    failed="$failed  $step"$'\n'
  fi
done <<EOF
$steps
EOF

if [ -n "$failed" ]; then
  echo "test-scripts-changed: FAILED steps:" >&2
  printf '%s' "$failed" >&2
  exit 1
fi
echo "test-scripts-changed: all selected checks passed"
