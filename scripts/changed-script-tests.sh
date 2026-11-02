#!/usr/bin/env bash
#
# Run, locally, the script checks CI would run for the current change
# (`make test-scripts-changed`). CI runs the shell suites only in the merge
# queue, so this is the one place to catch a broken suite or a shellcheck
# finding before pushing (intent-hq/intent#7472 took two extra rounds).
# The Python unit tests of `make test-scripts` also run on PRs, but only once
# pushed; intent PR 8290 found its tests by hand.
#
# Changed files are everything that differs from merge-base(BASE, HEAD) — the
# branch's commits plus staged, unstaged and untracked work. BASE defaults to
# origin/main. The plan is:
#   1. `make lint-shell`, always.
#   2. The Python unit tests of the Makefile `test-scripts` target (read from
#      its recipe, so there is no second list). For each changed top-level
#      scripts/X.sh or scripts/X.py it selects the modules whose file is X
#      itself, X's own test_X.py, or a file that names X, as in step 3, and
#      runs them with the recipe's own command. The whole `make test-scripts`
#      runs instead when the Makefile, ci.yml or scripts/fixtures/** changed,
#      when a changed non-test script is a shared helper, or when FULL=1.
#   3. Suites of the ci.yml `shell-tests` job (read from its first run step, so
#      there is no second list to drift). For each changed top-level
#      scripts/X.sh or scripts/X.py it selects the suites whose file is X
#      itself, X's own test (X.test.sh or test_X.py, `-` read as `_`), or a
#      file that mentions X by name (the file name; for .py also the module
#      name as a word). A changed scripts/*.test.sh also selects the
#      lint-fixed-sleeps.sh step, which scans every suite.
#      Every suite runs instead when the Makefile, ci.yml or scripts/fixtures/**
#      changed, when a changed non-test script is a shared helper (another
#      non-test top-level script other than this one names it), when neither
#      a suite nor a step 2 module names a changed script, or when FULL=1.
#      The merge queue still runs every suite.
#   4. `node --test scripts/X.test.mjs` for each changed scripts/X.mjs or
#      scripts/X.test.mjs whose test file exists.
# The output says why each suite and module was selected. DRY_RUN=1 prints the plan
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

# The `test-scripts` recipe as words, one per line (backslash continuations
# joined); the scripts.test_* words are its modules, the rest its command.
script_test_recipe() {
  [ -f Makefile ] || return 0
  awk '
    in_rule {
      if ($0 !~ /^\t/) exit
      line = substr($0, 2)
      more = sub(/\\$/, "", line)
      n = split(line, words, /[[:space:]]+/)
      for (i = 1; i <= n; i++) if (words[i] != "") print words[i]
      if (!more) exit
      next
    }
    /^test-scripts:/ { in_rule = 1 }
  ' Makefile
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

# The first non-test top-level script, other than $1 and this selector, that
# names $1; empty when none does.
shared_user() {
  local script=$1 other
  is_test_file "$script" && return 0
  for other in scripts/*.sh scripts/*.py; do
    [ -f "$other" ] || continue
    [ "$other" = "$script" ] && continue
    # This selector names suite files only to pick them.
    [ "$other" = scripts/changed-script-tests.sh ] && continue
    is_test_file "$other" && continue
    if mentions "$other" "$script"; then printf '%s' "$other"; return 0; fi
  done
}

# Own test file of script $1: own_test_file <script> <sh|py>.
own_test_file() {
  local stem=${1##*/}
  stem=${stem%.*}
  case "$2" in
    sh) printf 'scripts/%s.test.sh' "$stem" ;;
    py) printf 'scripts/test_%s.py' "$(printf '%s' "$stem" | tr '-' '_')" ;;
  esac
}

# Why suite or module file $1 covers changed script $2; empty when it does not.
covers() {
  local file=$1 script=$2
  if [ "$file" = "$script" ]; then
    echo "the suite itself changed"
  elif [ "$file" = "$(own_test_file "$script" sh)" ] || [ "$file" = "$(own_test_file "$script" py)" ]; then
    echo "own test of $script"
  elif mentions "$file" "$script"; then
    echo "mentions ${script##*/}"
  fi
}

run_all_shell=0
full_reasons=""
run_all_py=0
py_full_reasons=""
node_tests=""
changed_scripts=""
if [ -n "${FULL:-}" ] && [ "${FULL}" != 0 ]; then
  run_all_shell=1; full_reasons="$full_reasons FULL=1"
  run_all_py=1; py_full_reasons="$py_full_reasons FULL=1"
fi
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    Makefile | "$ci_file" | scripts/fixtures/*)
      run_all_shell=1; full_reasons="$full_reasons $path"
      run_all_py=1; py_full_reasons="$py_full_reasons $path" ;;
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

# Step 2: the `make test-scripts` modules. "module<TAB>reason" per pick, and
# the changed scripts some module covers (they need no shell-suite fallback).
recipe=$(script_test_recipe)
py_modules=$(printf '%s\n' "$recipe" | grep -E '^scripts\.test_[A-Za-z0-9_]+$' || true)
py_command=$(printf '%s\n' "$recipe" | grep -vE '^scripts\.test_' | tr '\n' ' ' | sed 's/ *$//')
py_picks=""
py_covered=""
if [ -n "$changed_scripts" ] && [ -n "$py_modules" ]; then
  while IFS= read -r script; do
    [ -n "$script" ] || continue
    user=$(shared_user "$script")
    if [ -n "$user" ]; then
      run_all_py=1; py_full_reasons="$py_full_reasons $script (shared helper: $user names it)"
    fi
    while IFS= read -r module; do
      [ -n "$module" ] || continue
      reason=$(covers "scripts/${module#scripts.}.py" "$script")
      if [ -n "$reason" ]; then
        py_picks="$py_picks$module"$'\t'"$reason"$'\n'
        py_covered="$py_covered$script"$'\n'
      fi
    done <<MODULES
$py_modules
MODULES
  done <<SCRIPTS
$changed_scripts
SCRIPTS
fi

# "suite line<TAB>reason" for each targeted selection.
picks=""
if [ -n "$changed_scripts" ]; then
  suites=$(shell_suites)
  [ -n "$suites" ] || die "no commands found in the $ci_file shell-tests job"
  while IFS= read -r script; do
    [ -n "$script" ] || continue
    [ "$run_all_shell" = 1 ] && break
    name=${script##*/}
    user=$(shared_user "$script")
    if [ -n "$user" ]; then
      run_all_shell=1; full_reasons="$full_reasons $script (shared helper: $user names it)"
      break
    fi
    found=0
    if printf '%s' "$py_covered" | grep -qxF -- "$script"; then found=1; fi
    while IFS= read -r suite; do
      [ -n "$suite" ] || continue
      file=$(suite_file "$suite")
      [ -n "$file" ] || continue
      reason=$(covers "$file" "$script")
      if [ -z "$reason" ] && [ "$file" = scripts/lint-fixed-sleeps.sh ] && case "$name" in *.test.sh) true ;; *) false ;; esac; then
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
      run_all_shell=1; full_reasons="$full_reasons $script (no suite or test-scripts module names it)"
    fi
  done <<SCRIPTS
$changed_scripts
SCRIPTS
fi

steps="make lint-shell"$'\n'
py_selection=""
py_selected=""
if [ "$run_all_py" = 1 ]; then
  steps="${steps}make test-scripts"$'\n'
elif [ -n "$py_picks" ]; then
  if [ -z "$py_command" ]; then
    die "the Makefile test-scripts recipe has no command before its scripts.test_* modules"
  fi
  # Keep the Makefile order; join the reasons of a module picked more than once.
  while IFS= read -r module; do
    [ -n "$module" ] || continue
    why=$(printf '%s' "$py_picks" | awk -F '\t' -v m="$module" '$1 == m { r = r (r == "" ? "" : "; ") $2 } END { print r }')
    [ -n "$why" ] || continue
    py_selected="$py_selected $module"
    py_selection="${py_selection}test-scripts-changed: selected $module (make test-scripts): $why"$'\n'
  done <<MODULES
$py_modules
MODULES
  steps="$steps$py_command$py_selected"$'\n'
fi
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
if [ "$run_all_py" = 1 ]; then
  echo "test-scripts-changed: all make test-scripts modules selected (full run:$py_full_reasons)"
elif [ -n "$py_selection" ]; then
  echo "test-scripts-changed: make test-scripts modules for the changed scripts:"
  printf '%s' "$py_selection"
else
  echo "test-scripts-changed: no make test-scripts module names a changed script; Python unit tests skipped"
fi
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
if { [ "$run_all_py" = 1 ] || [ -n "$py_selection" ]; } && ! command -v python3 >/dev/null 2>&1; then
  die "python3 (3.11+) is required for the make test-scripts modules; run make bootstrap-dev-host"
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
