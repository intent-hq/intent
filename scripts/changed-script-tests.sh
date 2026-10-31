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
#   2. Suites of the ci.yml `shell-tests` job (read from its first run step, so
#      there is no second list to drift). For each changed top-level
#      scripts/X.sh or scripts/X.py it selects the suites whose file is X
#      itself, X's own test (X.test.sh or test_X.py, `-` read as `_`), or a
#      file that mentions X by name (the file name; for .py also the module
#      name as a word). A changed scripts/*.test.sh also selects the
#      lint-fixed-sleeps.sh step, which scans every suite.
#      Every suite runs instead when the Makefile, ci.yml or scripts/fixtures/**
#      changed, when a changed non-test script is a shared helper (another
#      non-test top-level script other than this one names it), when no suite names a changed
#      script, or when FULL=1. The merge queue still runs every suite.
#   3. `node --test scripts/X.test.mjs` for each changed scripts/X.mjs or
#      scripts/X.test.mjs whose test file exists.
# The output says why each suite was selected. DRY_RUN=1 prints the plan
# without running it. Every step runs; the exit code is non-zero when any step
# failed, and the failures are listed at the end.
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

# The scripts/ path a suite line runs: its last scripts/... word.
suite_file() {
  printf '%s\n' "$1" | awk '{ f = ""; for (i = 1; i <= NF; i++) if ($i ~ /^scripts\//) f = $i; print f }'
}

# Test-side files: suites, their fixtures, and python tests. A change to one of
# these never makes it a shared helper.
is_test_file() {
  case "${1##*/}" in
    *.test.sh | *.fixture.sh | test_*.py | test-*.py) return 0 ;;
  esac
  return 1
}

# Whether file $1 names script $2 (file name; for .py also the module word).
mentions() {
  local file=$1 script=$2 name
  [ -f "$file" ] || return 1
  name=${script##*/}
  grep -qF -- "$name" "$file" && return 0
  case "$name" in
    *.py) grep -qw -- "${name%.py}" "$file" && return 0 ;;
  esac
  return 1
}

run_all_shell=0
full_reasons=""
node_tests=""
changed_scripts=""
if [ -n "${FULL:-}" ] && [ "${FULL}" != 0 ]; then
  run_all_shell=1; full_reasons="$full_reasons FULL=1"
fi
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    Makefile | "$ci_file" | scripts/fixtures/*)
      run_all_shell=1; full_reasons="$full_reasons $path" ;;
    scripts/*/*) ;;
    scripts/*.sh | scripts/*.py)
      changed_scripts="$changed_scripts$path"$'\n' ;;
    scripts/*.test.mjs)
      [ -f "$path" ] && node_tests="$node_tests$path"$'\n' ;;
    scripts/*.mjs)
      candidate=${path%.mjs}.test.mjs
      [ -f "$candidate" ] && node_tests="$node_tests$candidate"$'\n' ;;
  esac
done <<EOF
$changed
EOF

# "suite line<TAB>reason" for each targeted selection.
picks=""
if [ -n "$changed_scripts" ]; then
  suites=$(shell_suites)
  [ -n "$suites" ] || die "no commands found in the $ci_file shell-tests job"
  while IFS= read -r script; do
    [ -n "$script" ] || continue
    [ "$run_all_shell" = 1 ] && break
    name=${script##*/}
    if ! is_test_file "$script"; then
      user=""
      for other in scripts/*.sh scripts/*.py; do
        [ -f "$other" ] || continue
        [ "$other" = "$script" ] && continue
        # This selector names suite files only to pick them.
        [ "$other" = scripts/changed-script-tests.sh ] && continue
        is_test_file "$other" && continue
        if mentions "$other" "$script"; then user=$other; break; fi
      done
      if [ -n "$user" ]; then
        run_all_shell=1; full_reasons="$full_reasons $script (shared helper: $user names it)"
        break
      fi
    fi
    stem=${name%.*}
    own_sh=scripts/$stem.test.sh
    own_py=scripts/test_$(printf '%s' "$stem" | tr '-' '_').py
    found=0
    while IFS= read -r suite; do
      [ -n "$suite" ] || continue
      file=$(suite_file "$suite")
      [ -n "$file" ] || continue
      reason=""
      if [ "$file" = "$script" ]; then
        reason="the suite itself changed"
      elif [ "$file" = "$own_sh" ] || [ "$file" = "$own_py" ]; then
        reason="own test of $script"
      elif mentions "$file" "$script"; then
        reason="mentions $name"
      elif [ "$file" = scripts/lint-fixed-sleeps.sh ] && case "$name" in *.test.sh) true ;; *) false ;; esac; then
        reason="scans every scripts/*.test.sh ($name changed)"
      fi
      if [ -n "$reason" ]; then
        found=1
        picks="$picks$suite"$'\t'"$reason"$'\n'
      fi
    done <<SUITES
$suites
SUITES
    if [ "$found" = 0 ]; then
      run_all_shell=1; full_reasons="$full_reasons $script (no suite names it)"
    fi
  done <<SCRIPTS
$changed_scripts
SCRIPTS
fi

steps="make lint-shell"$'\n'
selection=""
if [ "$run_all_shell" = 1 ]; then
  suites=$(shell_suites)
  [ -n "$suites" ] || die "no commands found in the $ci_file shell-tests job"
  steps="$steps$suites"$'\n'
elif [ -n "$picks" ]; then
  # Keep the ci.yml order; join the reasons of a suite picked more than once.
  while IFS= read -r suite; do
    [ -n "$suite" ] || continue
    why=$(printf '%s' "$picks" | awk -F '\t' -v s="$suite" '$1 == s { r = r (r == "" ? "" : "; ") $2 } END { print r }')
    [ -n "$why" ] || continue
    steps="$steps$suite"$'\n'
    selection="${selection}test-scripts-changed: selected $(suite_file "$suite"): $why"$'\n'
  done <<SUITES
$suites
SUITES
fi
if [ -n "$node_tests" ]; then
  while IFS= read -r test_file; do
    # Steps run through `bash -c`; quote the path so it stays one argument.
    [ -n "$test_file" ] && steps="${steps}node --test $(printf '%q' "$test_file")"$'\n'
  done <<EOF
$(printf '%s' "$node_tests" | LC_ALL=C sort -u)
EOF
fi

changed_count=$(printf '%s\n' "$changed" | grep -c . || true)
echo "test-scripts-changed: $changed_count changed file(s) vs $base_ref (merge base ${merge_base:0:12})"
if [ "$run_all_shell" = 1 ]; then
  echo "test-scripts-changed: all shell-tests suites selected (full run:$full_reasons)"
elif [ -n "$selection" ]; then
  echo "test-scripts-changed: shell-tests suites for the changed scripts (FULL=1 runs all):"
  printf '%s' "$selection"
else
  echo "test-scripts-changed: no Makefile, ci.yml or scripts/*.sh|*.py change; shell suites skipped"
fi

if [ -n "${DRY_RUN:-}" ] && [ "${DRY_RUN}" != 0 ]; then
  echo "test-scripts-changed: plan (DRY_RUN):"
  printf '%s' "$steps" | sed 's/^/  /'
  exit 0
fi

if { [ "$run_all_shell" = 1 ] || [ -n "$selection" ]; } && [ ! -f packages/intentd/Cargo.toml ]; then
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
