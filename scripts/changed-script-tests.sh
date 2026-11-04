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
#      runs instead when a changed file other than a top-level scripts/X.sh or
#      scripts/X.py matches the pathspec of the ci.yml python-tests "Select
#      Python test changes" step (read from it, so there is no second list; for
#      example the Makefile, ci.yml, scripts/fixtures/** or scripts/_vendor/**),
#      or when FULL=1.
#   3. Suites of the ci.yml `shell-tests` job (read from its first run step, so
#      there is no second list to drift). For each changed top-level
#      scripts/X.sh or scripts/X.py it selects the suites whose file is X
#      itself, X's own test (X.test.sh or test_X.py, `-` read as `_`), or a
#      file that mentions X by name (the file name; for .py also the module
#      name as a word). A changed scripts/*.test.sh also selects the
#      lint-fixed-sleeps.sh step, which scans every suite.
#      Every suite runs instead when the Makefile, ci.yml or scripts/fixtures/**
#      changed, when neither a suite nor a step 2 module names a changed
#      script (or, for a shared helper, any script that uses it), or when FULL=1.
#   Shared helpers (steps 2 and 3): when another non-test top-level script
#   other than this one names a changed non-test script X, X is a shared
#   helper. Its users, and their users in turn, count as changed for the
#   selection, so X gets the modules and suites of every script that uses it
#   directly or through other scripts, not a full run (intent PR 8305 ran
#   every suite for over 30 minutes after a resumable_nextest.py fix). Every
#   suite still runs when one of those users reaches no check, as it would if
#   that user changed. Only top-level scripts count as users: a check that
#   reaches X through a Makefile recipe or a *.fixture.sh without naming X or
#   one of its users is not selected, for a helper as for any changed script.
#      The merge queue still runs every suite.
#   4. The Bash 3.2 pass, when the suites' own lookup (scripts/find-bash3.sh,
#      which finds the `make bash3` cache) finds an interpreter: the lines of
#      the ci.yml `shell-tests-bash3` job's first run step that start a suite
#      step 3 runs under "$BASH3_BIN" itself, with BASH3_BIN exported. Its
#      other lines are not repeated: they rerun a suite that already reran its
#      own checks under that interpreter in step 3 (this selector's self-test
#      included).
#      With none found, the pass is skipped with a notice (the merge queue
#      still runs it).
#   5. `node --test scripts/X.test.mjs` for each changed scripts/X.mjs or
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

# Lines of the first `run: |` block in ci.yml job $1, minus echo lines.
job_run_lines() {
  [ -f "$ci_file" ] || die "$ci_file not found"
  awk -v job="$1:" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_job = ($1 == job); next }
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

shell_suites() {
  job_run_lines shell-tests
}

# The python-tests "Select Python test changes" `git diff` pathspec, one
# unquoted entry per line: the words between ` -- ` and the closing `)`.
python_pathspec() {
  [ -f "$ci_file" ] || die "$ci_file not found"
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { in_job = ($1 == "python-tests:"); in_step = 0; next }
    !in_job { next }
    /^[[:space:]]*- / { in_step = 0 }
    /^[[:space:]]*(- )?name: Select Python test changes[[:space:]]*$/ { in_step = 1; next }
    in_step && /git diff --name-only .* -- .*\)/ {
      line = $0
      sub(/^.* -- /, "", line)
      sub(/\).*$/, "", line)
      print line
      exit
    }
  ' "$ci_file" | xargs -n 1 printf '%s\n'
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

# Non-test top-level scripts, other than $1 and this selector, that name $1
# (as mentions reads it), one per line; none for a test file.
direct_users() {
  local script=$1 name other
  is_test_file "$script" && return 0
  name=${script##*/}
  {
    grep -lF -- "$name" scripts/*.sh scripts/*.py 2>/dev/null || true
    case "$name" in
      *.py) grep -lw -- "${name%.py}" scripts/*.sh scripts/*.py 2>/dev/null || true ;;
    esac
  } | LC_ALL=C sort -u | while IFS= read -r other; do
    [ "$other" = "$script" ] && continue
    # This selector names suite files only to pick them.
    [ "$other" = scripts/changed-script-tests.sh ] && continue
    is_test_file "$other" && continue
    printf '%s\n' "$other"
  done
}

# Script $1 and every script that uses it, directly or through other users,
# as "script<TAB>chain" lines: the chain is empty for $1 itself and otherwise
# says how the user reaches $1 (", which uses b.py, which uses a.py").
script_and_users() {
  local start=$1 queue line member chain user seen
  seen=$start$nl
  queue=$start$tab$nl
  printf '%s\t\n' "$start"
  while [ -n "$queue" ]; do
    line=${queue%%"$nl"*}
    queue=${queue#*"$nl"}
    member=${line%%"$tab"*}
    chain=${line#*"$tab"}
    while IFS= read -r user; do
      [ -n "$user" ] || continue
      case "$nl$seen" in *"$nl$user$nl"*) continue ;; esac
      seen=$seen$user$nl
      queue=$queue$user$tab", which uses ${member##*/}$chain"$nl
      printf '%s\t%s\n' "$user" ", which uses ${member##*/}$chain"
    done <<USERS
$(direct_users "$member")
USERS
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

# Why file $1 covers changed script $3 through $2, a member of
# script_and_users $3 whose chain is $4; empty when it does not.
covers_member() {
  local file=$1 member=$2 script=$3 chain=$4 reason
  if [ "$member" = "$script" ]; then
    covers "$file" "$script"
    return 0
  fi
  if [ "$file" = "$member" ]; then
    reason="it is ${member##*/}"
  else
    reason=$(covers "$file" "$member")
  fi
  [ -n "$reason" ] && printf '%s%s\n' "$reason" "$chain"
  return 0
}

nl=$'\n'
tab=$'\t'
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
# Changed files the python-tests pathspec matches, by git itself (its
# wildcards match across `/`, as in CI). Top-level scripts get the targeted
# selection of step 2; any other match runs every module, as CI would.
py_spec=()
while IFS= read -r entry; do
  [ -n "$entry" ] && py_spec+=("$entry")
done <<EOF
$(python_pathspec)
EOF
[ "${#py_spec[@]}" -gt 0 ] ||
  die "no git diff pathspec found in the $ci_file python-tests 'Select Python test changes' step"
py_triggers=$( {
  git diff --name-only "$merge_base" -- "${py_spec[@]}"
  git ls-files --others --exclude-standard -- "${py_spec[@]}"
} | LC_ALL=C sort -u)
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    scripts/*/*) ;;
    scripts/*.sh | scripts/*.py) continue ;;
  esac
  run_all_py=1; py_full_reasons="$py_full_reasons $path"
done <<EOF
$py_triggers
EOF

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

# Each changed script with its users (script_and_users), as
# "changed<TAB>member<TAB>chain" lines: a shared helper's checks are those of
# every script that uses it, directly or through other scripts.
members=""
helpers=""
while IFS= read -r script; do
  [ -n "$script" ] || continue
  users=""
  while IFS="$tab" read -r member chain; do
    [ -n "$member" ] || continue
    members=$members$script$tab$member$tab$chain$nl
    [ "$member" = "$script" ] || users="$users $member"
  done <<MEMBERS
$(script_and_users "$script")
MEMBERS
  if [ -n "$users" ]; then
    helpers="${helpers}test-scripts-changed: $script is a shared helper; also selecting the checks of the scripts that use it:$users"$nl
  fi
done <<SCRIPTS
$changed_scripts
SCRIPTS

# The members of changed script $1, as "member<TAB>chain" lines.
members_of() {
  printf '%s' "$members" | awk -F '\t' -v s="$1" '$1 == s { print $2 "\t" $3 }'
}

# "changed<TAB>member" lines for each member some module or suite covers.
covered=""

# Whether member $2 of changed script $1, or a script that uses $2, has a check.
member_reaches_check() {
  local script=$1 member=$2 user
  case "$nl$covered" in *"$nl$script$tab$member$nl"*) return 0 ;; esac
  while IFS="$tab" read -r user _; do
    [ -n "$user" ] || continue
    case "$nl$covered" in *"$nl$script$tab$user$nl"*) return 0 ;; esac
  done <<USERS
$(script_and_users "$member")
USERS
  return 1
}

# Step 2: the `make test-scripts` modules. "module<TAB>reason" per pick, and
# the members some module covers (in covered).
recipe=$(script_test_recipe)
py_modules=$(printf '%s\n' "$recipe" | grep -E '^scripts\.test_[A-Za-z0-9_]+$' || true)
py_command=$(printf '%s\n' "$recipe" | grep -vE '^scripts\.test_' | tr '\n' ' ' | sed 's/ *$//')
py_picks=""
if [ -n "$changed_scripts" ] && [ -n "$py_modules" ]; then
  while IFS= read -r script; do
    [ -n "$script" ] || continue
    while IFS="$tab" read -r member chain; do
      [ -n "$member" ] || continue
      while IFS= read -r module; do
        [ -n "$module" ] || continue
        reason=$(covers_member "scripts/${module#scripts.}.py" "$member" "$script" "$chain")
        if [ -n "$reason" ]; then
          py_picks="$py_picks$module"$'\t'"$reason"$'\n'
          covered=$covered$script$tab$member$nl
        fi
      done <<MODULES
$py_modules
MODULES
    done <<MEMBERS
$(members_of "$script")
MEMBERS
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
    shared=0
    while IFS="$tab" read -r member chain; do
      [ -n "$member" ] || continue
      [ "$member" = "$script" ] || shared=1
      while IFS= read -r suite; do
        [ -n "$suite" ] || continue
        file=$(suite_file "$suite")
        [ -n "$file" ] || continue
        reason=$(covers_member "$file" "$member" "$script" "$chain")
        if [ -z "$reason" ] && [ "$member" = "$script" ] && [ "$file" = scripts/lint-fixed-sleeps.sh ] && case "$name" in *.test.sh) true ;; *) false ;; esac; then
          reason="scans every scripts/*.test.sh ($name changed)"
        fi
        if [ -n "$reason" ]; then
          covered=$covered$script$tab$member$nl
          picks="$picks$suite"$'\t'"$reason"$'\n'
        fi
      done <<SUITES
$suites
SUITES
    done <<MEMBERS
$(members_of "$script")
MEMBERS
    # Every member must reach a check, through itself or a script that uses
    # it: a changed member no check reaches would run every suite itself.
    if ! member_reaches_check "$script" "$script"; then
      run_all_shell=1
      if [ "$shared" = 1 ]; then
        full_reasons="$full_reasons $script (no suite or test-scripts module names it or a script that uses it)"
      else
        full_reasons="$full_reasons $script (no suite or test-scripts module names it)"
      fi
      continue
    fi
    while IFS="$tab" read -r member _; do
      if [ -z "$member" ] || [ "$member" = "$script" ]; then continue; fi
      if ! member_reaches_check "$script" "$member"; then
        run_all_shell=1
        full_reasons="$full_reasons $script (used by $member, which no suite or test-scripts module names)"
        break
      fi
    done <<MEMBERS
$(members_of "$script")
MEMBERS
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
shell_steps=""
if [ "$run_all_shell" = 1 ]; then
  suites=$(shell_suites)
  [ -n "$suites" ] || die "no commands found in the $ci_file shell-tests job"
  shell_steps="$suites"$'\n'
  steps="$steps$suites"$'\n'
elif [ -n "$picks" ]; then
  # Keep the ci.yml order; join the reasons of a suite picked more than once.
  while IFS= read -r suite; do
    [ -n "$suite" ] || continue
    why=$(printf '%s' "$picks" | awk -F '\t' -v s="$suite" '$1 == s { r = r (r == "" ? "" : "; ") $2 } END { print r }')
    [ -n "$why" ] || continue
    steps="$steps$suite"$'\n'
    shell_steps="$shell_steps$suite"$'\n'
    selection="${selection}test-scripts-changed: selected $(suite_file "$suite"): $why"$'\n'
  done <<SUITES
$suites
SUITES
fi
# Step 4: the shell-tests-bash3 lines that start a suite step 3 runs under
# "$BASH3_BIN" itself. The other lines rerun a suite that, finding the same
# interpreter, already reran its checks under it in step 3.
bash3_lines=""
bash3_files=""
if [ -n "$shell_steps" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in *'"$BASH3_BIN" scripts/'*) ;; *) continue ;; esac
    file=$(suite_file "$line")
    [ -n "$file" ] || continue
    while IFS= read -r suite; do
      if [ -n "$suite" ] && [ "$(suite_file "$suite")" = "$file" ]; then
        bash3_lines="$bash3_lines$line"$'\n'
        bash3_files="$bash3_files $file"
        break
      fi
    done <<SUITES
$shell_steps
SUITES
  done <<LINES
$(job_run_lines shell-tests-bash3)
LINES
fi
bash3=""
bash3_note=""
if [ -n "$bash3_lines" ]; then
  # shellcheck source=scripts/find-bash3.sh
  . "$repo_root/scripts/find-bash3.sh"
  if bash3=$(find_bash3); then
    steps="$steps$bash3_lines"
    bash3_note="test-scripts-changed: Bash 3.2 pass with $bash3 (the shell-tests-bash3 lines that start these suites under it):$bash3_files"
  else
    bash3=""
    bash3_note="test-scripts-changed: Bash 3.2 pass skipped:$bash3_files ($(bash3_missing_hint); the merge queue still runs it)"
  fi
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
printf '%s' "$helpers"
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
[ -z "$bash3_note" ] || echo "$bash3_note"

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

# The Bash 3.2 lines start "$BASH3_BIN"; the suites' own lookup tries it first.
[ -z "$bash3" ] || export BASH3_BIN="$bash3"
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
