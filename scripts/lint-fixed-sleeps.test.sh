#!/usr/bin/env bash
#
# Self-test for scripts/lint-fixed-sleeps.sh. It copies the lint into a temp
# repo skeleton, writes fixture `scripts/*.test.sh` suites and a fixture
# baseline, and pins the sleep predicate, the `timing-guard:` marker rules and
# the baseline ratchet by exit code and `path:line` output, so the lint can be
# refactored safely. The lint skips this file by name, so the fixtures below
# spell every pattern out without markers.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script=$repo_root/scripts/lint-fixed-sleeps.sh
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

# The fixtures below run lint-fixed-sleeps.sh under $script_bash and append
# every exit code + output to $transcript, so a rerun under another
# interpreter (see the Bash 3 section at the end) can be compared byte for
# byte.
script_bash=${LINT_FIXED_SLEEPS_TEST_BASH:-$BASH}
transcript=${LINT_FIXED_SLEEPS_TEST_TRANSCRIPT:-$temp_dir/transcript}
: >"$transcript"

baseline=scripts/fixed-sleep-baseline.txt

fail() {
  echo "lint-fixed-sleeps test failed: $*" >&2
  exit 1
}

run_check() {
  local status=0
  check_output=$(cd "$temp_dir" && "$script_bash" scripts/lint-fixed-sleeps.sh "$@" 2>&1) || status=$?
  printf 'exit %s\n%s\n' "$status" "$check_output" >>"$transcript"
  return "$status"
}

mkdir -p "$temp_dir/scripts"
cp "$script" "$temp_dir/scripts/lint-fixed-sleeps.sh"

# Fixture suites are built line by line so each case records its own
# `scripts/<file>:<line>` reference: `site` lines must be reported as
# unannotated fixed sleeps, `clean` lines must not be, `emit` is filler.
fixture_rel=
fixture_lines=0
fixture_sites=0
site_names=()
site_refs=()
clean_names=()
clean_refs=()
begin_fixture() {
  fixture_rel=scripts/$1
  : >"$temp_dir/$fixture_rel"
  fixture_lines=0
  fixture_sites=0
}
emit() {
  printf '%s\n' "$1" >>"$temp_dir/$fixture_rel"
  fixture_lines=$((fixture_lines + 1))
}
site() {
  emit "$2"
  fixture_sites=$((fixture_sites + 1))
  site_names+=("$1")
  site_refs+=("$fixture_rel:$fixture_lines")
}
clean() {
  emit "$2"
  clean_names+=("$1")
  clean_refs+=("$fixture_rel:$fixture_lines")
}

# Entries start on line 3: a comment header and a blank line must be ignored.
write_baseline() {
  {
    printf '# fixture baseline\n\n'
    printf '%s\n' "$@"
  } >"$temp_dir/$baseline"
}

# ---- predicate ---------------------------------------------------------------

begin_fixture predicate.test.sh
site 'plain sleep 0.2' 'sleep 0.2'
site 'sleep .2 (leading dot)' 'sleep .2'
site 'tab-separated sleep' $'sleep\t0.2'
site 'double-quoted duration' 'sleep "0.2"'
site 'single-quoted duration' "sleep '2'"
site 'poll loop without a deadline' 'while [ ! -e x ]; do sleep 0.05; done'
site 'fixed sleep before a stay-alive sleep' 'sleep 0.2; sleep 60 &'
site 'sleep 60 && (not the stay-alive idiom)' 'sleep 60 && echo'
site 'sleep 60 &> (not the stay-alive idiom)' 'sleep 60 &>/dev/null'
site 'python time.sleep(30)' 'time.sleep(30)'
emit "python3 - <<'PY'"
emit 'import time'
site 'indented time.sleep(0.5) in a python heredoc' '  time.sleep(0.5)'
emit 'PY'
site 'fixed-count for header (sleep in body)' 'for _ in {1..100}; do'
site 'sleep inside a fixed-count for' '  sleep 0.01'
emit 'done'
site 'exec -a name sleep 6543 inside a quoted string' 'holder_cmd="exec -a name sleep 6543"'
emit ''
clean 'stay-alive sleep 60 &' 'sleep 60 &'
clean 'stay-alive sleep 60 & in a while loop' 'while :; do sleep 60 & wait $!; done'
clean 'nosleep is not sleep' 'nosleep 10'
clean 'thread_sleep is not sleep' 'thread_sleep 10'
clean 'commented-out sleep' '# sleep 5'
clean 'sleep as a word with no argument' 'echo sleep'
clean 'variable duration' 'sleep "$interval"'
clean 'arithmetic duration' 'sleep $((n))'
clean 'fixed-count for without a sleep' 'for i in {1..3}; do touch "f$i"; done'
emit ''
site 'fixed-count for whose body has only a marked sleep (for line)' 'for _ in {1..3}; do'
clean 'marked sleep inside a fixed-count for' '  sleep 1 # timing-guard: fixture'
emit 'done'
predicate_sites=$fixture_sites

# ---- markers -----------------------------------------------------------------

begin_fixture markers.test.sh
clean 'trailing marker' 'sleep 1 # timing-guard: fixture trailing'
emit ''
emit '# timing-guard: fixture on the line above'
clean 'standalone marker on the line above' 'sleep 1'
emit ''
emit '# timing-guard: fixture two lines above'
emit 'echo between'
site 'marker two lines above does not exempt' 'sleep 1'
emit ''
emit '# timing-guard:'
site 'bare marker on the line above does not exempt' 'sleep 1'
malformed_above_ref=$fixture_rel:$fixture_lines
emit ''
site 'bare trailing marker does not exempt' 'sleep 1 # timing-guard:'
malformed_trailing_ref=$fixture_rel:$fixture_lines
emit ''
site 'marker text inside a quoted string with no # is not a marker' "sleep 1 'timing-guard: not a comment'"
quoted_marker_ref=$fixture_rel:$fixture_lines
emit ''
site 'marker text inside a quoted # is not a marker' 'echo "# timing-guard: quoted"; sleep 1'
quoted_hash_ref=$fixture_rel:$fixture_lines
markers_sites=$fixture_sites

write_baseline
if run_check; then
  fail "predicate/marker fixtures with an empty baseline were accepted"
fi
grep -q "^scripts/predicate.test.sh: $predicate_sites unannotated fixed sleep(s), the baseline has no entry for it:$" <<<"$check_output" ||
  fail "predicate fixture header did not report exactly $predicate_sites sites with no baseline entry: $check_output"
grep -q "^scripts/markers.test.sh: $markers_sites unannotated fixed sleep(s), the baseline has no entry for it:$" <<<"$check_output" ||
  fail "markers fixture header did not report exactly $markers_sites sites with no baseline entry: $check_output"
for ((i = 0; i < ${#site_refs[@]}; i++)); do
  grep -q "^${site_refs[i]}: error: unannotated fixed sleep: " <<<"$check_output" ||
    fail "positive case '${site_names[i]}' was not reported at ${site_refs[i]}: $check_output"
done
for ((i = 0; i < ${#clean_refs[@]}; i++)); do
  grep -q "^${clean_refs[i]}:" <<<"$check_output" &&
    fail "negative case '${clean_names[i]}' was reported at ${clean_refs[i]}: $check_output"
done
grep -q '^scripts/predicate.test.sh:[0-9]*: error: unannotated fixed sleep: sleep 0.2; sleep 60 &$' <<<"$check_output" ||
  fail "reported site text was not the trimmed source line: $check_output"
grep -q "^$malformed_above_ref: error: timing-guard marker is malformed: expected \`# timing-guard: <reason>\` in a \`#\` comment; the reason is required: sleep 1$" <<<"$check_output" ||
  fail "bare marker on the line above was not reported as malformed at $malformed_above_ref: $check_output"
grep -q "^$malformed_trailing_ref: error: timing-guard marker is malformed: " <<<"$check_output" ||
  fail "bare trailing marker was not reported as malformed at $malformed_trailing_ref: $check_output"
grep -q "^$quoted_marker_ref: error: timing-guard marker is malformed" <<<"$check_output" &&
  fail "marker text inside a quoted string was treated as a (malformed) marker at $quoted_marker_ref: $check_output"
grep -q "^$quoted_hash_ref: error: timing-guard marker is malformed" <<<"$check_output" &&
  fail "marker text inside a quoted # was treated as a (malformed) marker at $quoted_hash_ref: $check_output"
malformed_count=$(grep -c 'timing-guard marker is malformed' <<<"$check_output" || true)
[[ "$malformed_count" -eq 2 ]] ||
  fail "expected exactly 2 malformed marker findings, got $malformed_count: $check_output"
grep -qF -- "fix: justify each new sleep with \`# timing-guard: <reason>\` on its line or the one above, or replace it with a wait on an observable event; as a last resort (never preferred) set its entry in $baseline to \`scripts/predicate.test.sh $predicate_sites\`." <<<"$check_output" ||
  fail "over-baseline finding did not name the marker fix and the exact baseline entry: $check_output"

if ! run_check --print-counts; then
  fail "--print-counts failed: $check_output"
fi
expected_counts="scripts/markers.test.sh $markers_sites"$'\n'"scripts/predicate.test.sh $predicate_sites"
[[ "$check_output" == "$expected_counts" ]] ||
  fail "--print-counts did not print one sorted \`<path> <count>\` line per file with sites:"$'\n'"$check_output"

# ---- ratchet -----------------------------------------------------------------

rm -f "$temp_dir"/scripts/*.test.sh
begin_fixture a.test.sh
emit 'sleep 1'
emit 'echo ok'
emit 'sleep 2'
begin_fixture b.test.sh
emit 'sleep 3'
begin_fixture c.test.sh
emit 'sleep 60 &'
emit '# timing-guard: fixture'
emit 'sleep 4'

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1'
if ! run_check; then
  fail "clean tree with a matching baseline was rejected: $check_output"
fi
[[ -z "$check_output" ]] || fail "clean tree with a matching baseline printed output: $check_output"

write_baseline 'scripts/a.test.sh 1' 'scripts/b.test.sh 1'
if run_check; then
  fail "file over its baseline entry was accepted"
fi
grep -q '^scripts/a.test.sh: 2 unannotated fixed sleep(s), the baseline allows 1:$' <<<"$check_output" ||
  fail "file over its baseline entry did not report the count against the entry: $check_output"
grep -q '^scripts/a.test.sh:1: error: unannotated fixed sleep: sleep 1$' <<<"$check_output" ||
  fail "file over its baseline entry did not name line 1: $check_output"
grep -q '^scripts/a.test.sh:3: error: unannotated fixed sleep: sleep 2$' <<<"$check_output" ||
  fail "file over its baseline entry did not name line 3: $check_output"
grep -qF -- "set its entry in $baseline to \`scripts/a.test.sh 2\`." <<<"$check_output" ||
  fail "file over its baseline entry did not name the last-resort entry: $check_output"
grep -q '^scripts/b.test.sh' <<<"$check_output" &&
  fail "file matching its baseline entry was reported alongside an over-baseline file: $check_output"

write_baseline 'scripts/b.test.sh 1'
if run_check; then
  fail "file absent from the baseline was accepted"
fi
grep -q '^scripts/a.test.sh: 2 unannotated fixed sleep(s), the baseline has no entry for it:$' <<<"$check_output" ||
  fail "file absent from the baseline did not report the missing entry: $check_output"
grep -q '^scripts/a.test.sh:1: error: unannotated fixed sleep: sleep 1$' <<<"$check_output" &&
  grep -q '^scripts/a.test.sh:3: error: unannotated fixed sleep: sleep 2$' <<<"$check_output" ||
  fail "file absent from the baseline did not name every line: $check_output"

write_baseline 'scripts/a.test.sh 3' 'scripts/b.test.sh 1'
if run_check; then
  fail "file under its baseline entry was accepted"
fi
grep -qF -- "$baseline:3: error: scripts/a.test.sh has 2 unannotated fixed sleep(s) but the baseline allows 3; the ratchet only moves down: replace its line with \`scripts/a.test.sh 2\`" <<<"$check_output" ||
  fail "file under its baseline entry did not name the corrected baseline line: $check_output"
grep -q '^scripts/a.test.sh:' <<<"$check_output" &&
  fail "file under its baseline entry had its sites listed: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1' 'scripts/c.test.sh 1'
if run_check; then
  fail "baseline entry for a file with no unannotated sleeps was accepted"
fi
grep -qF -- "$baseline:5: error: scripts/c.test.sh has no unannotated fixed sleeps left but the baseline allows 1; the ratchet only moves down: remove its line \`scripts/c.test.sh 1\`" <<<"$check_output" ||
  fail "entry for a file with no unannotated sleeps did not say to remove the line: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1' 'scripts/zz-gone.test.sh 4'
if run_check; then
  fail "stale baseline entry for a missing file was accepted"
fi
grep -qF -- "$baseline:5: error: scripts/zz-gone.test.sh no longer exists; remove its line \`scripts/zz-gone.test.sh 4\`" <<<"$check_output" ||
  fail "stale baseline entry did not name the missing file and its line: $check_output"

write_baseline 'scripts/b.test.sh 1' 'scripts/a.test.sh 2'
if run_check; then
  fail "unsorted baseline was accepted"
fi
grep -qF -- "$baseline:4: error: entries must be sorted by path and unique, but \"scripts/a.test.sh\" follows \"scripts/b.test.sh\"" <<<"$check_output" ||
  fail "unsorted baseline failure did not name the line and paths: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/a.test.sh 2' 'scripts/b.test.sh 1'
if run_check; then
  fail "duplicate baseline entry was accepted"
fi
grep -qF -- "$baseline:4: error: entries must be sorted by path and unique, but \"scripts/a.test.sh\" follows \"scripts/a.test.sh\"" <<<"$check_output" ||
  fail "duplicate baseline entry failure did not name the line and path: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1' 'scripts/c.test.sh 0'
if run_check; then
  fail "baseline entry with count 0 was accepted"
fi
grep -qF -- "$baseline:5: error: a file with no unannotated sleeps has no entry; remove \"scripts/c.test.sh 0\"" <<<"$check_output" ||
  fail "count 0 baseline entry failure did not say to remove the line: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1' 'scripts/c.test.sh many'
if run_check; then
  fail "baseline entry with a non-numeric count was accepted"
fi
grep -qF -- "$baseline:5: error: count \"many\" is not a number" <<<"$check_output" ||
  fail "non-numeric count failure did not name the line and count: $check_output"

write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh' 'scripts/c.test.sh 1'
if run_check; then
  fail "baseline entry without a count was accepted"
fi
grep -qF -- "$baseline:4: error: expected \`<path> <count>\`, got \"scripts/b.test.sh\"" <<<"$check_output" ||
  fail "missing count failure did not name the line and entry: $check_output"

rm -f "$temp_dir/$baseline"
if run_check; then
  fail "missing baseline file was accepted"
fi
grep -qF -- "$baseline: error: baseline file is missing" <<<"$check_output" ||
  fail "missing baseline file was not reported: $check_output"

# The lint's own self-test is skipped by name, so its fixtures need no
# markers or baseline entry.
begin_fixture lint-fixed-sleeps.test.sh
emit 'sleep 5'
emit 'for _ in {1..10}; do sleep 0.1; done'
write_baseline 'scripts/a.test.sh 2' 'scripts/b.test.sh 1'
if ! run_check; then
  fail "the lint scanned its own self-test: $check_output"
fi
[[ -z "$check_output" ]] || fail "skipping the self-test printed output: $check_output"
if ! run_check --print-counts; then
  fail "--print-counts failed with the self-test present: $check_output"
fi
grep -q 'lint-fixed-sleeps.test.sh' <<<"$check_output" &&
  fail "--print-counts listed the lint's own self-test: $check_output"

# ---- verifier harness fixtures ------------------------------------------------
#
# The 81 cases the wave-1 verifier accepted the lint against, plus the PR
# review regressions (functions, subshells, heredocs), replayed one per
# isolated skeleton with the same checks: `--print-counts` exits 0 and its
# counts sum to <count>; a plain run exits <status> (default: 1 when <count>
# is above 0, else 0) with nothing on stdout, every <fragment> on stderr and,
# on failure, the baseline path named on the first stderr line. <source> is
# the fixture body written to <file> (`-` = scripts/x.test.sh; any other
# file also gets a `:` x.test.sh), <baseline> is written verbatim (`-` =
# empty), <status> `-` = default. The 23 prior-* cases are the intentd
# fixed_sleep_lint.rs table; the prior-adapted-* rows restate the Rust-only
# rows in shell terms.

harness_cases=0
harness_case() {
  local name=$1 file=$2 count=$3 status=$4 baseline_text=$5 source=$6
  shift 6
  local dir=$temp_dir/harness/$name run_status=0 counts_status=0 actual=0 fragment line
  [[ "$file" != - ]] || file=scripts/x.test.sh
  [[ "$baseline_text" != - ]] || baseline_text=
  [[ "$status" != - ]] || status=$((count > 0))
  mkdir -p "$dir/$(dirname "$file")" "$dir/scripts"
  cp "$script" "$dir/scripts/lint-fixed-sleeps.sh"
  printf '%s\n' "$source" >"$dir/$file"
  [[ "$file" == scripts/x.test.sh ]] || printf ':\n' >"$dir/scripts/x.test.sh"
  printf '%s' "$baseline_text" >"$dir/$baseline"
  harness_cases=$((harness_cases + 1))

  harness_counts=$(cd "$dir" && "$script_bash" scripts/lint-fixed-sleeps.sh --print-counts 2>"$dir/counts.err") || counts_status=$?
  harness_stdout=$(cd "$dir" && "$script_bash" scripts/lint-fixed-sleeps.sh 2>"$dir/lint.err") || run_status=$?
  harness_stderr=$(cat "$dir/lint.err")
  printf 'harness %s\ncounts exit %s\n%s\n%s\nexit %s\n%s\n%s\n' "$name" "$counts_status" "$harness_counts" \
    "$(cat "$dir/counts.err")" "$run_status" "$harness_stdout" "$harness_stderr" >>"$transcript"

  [[ "$counts_status" -eq 0 ]] ||
    fail "harness case $name: --print-counts exited $counts_status: $(cat "$dir/counts.err")"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    actual=$((actual + ${line##* }))
  done <<<"$harness_counts"
  [[ "$actual" -eq "$count" ]] ||
    fail "harness case $name: expected $count unannotated sleep(s), --print-counts summed to $actual:"$'\n'"$harness_counts"
  [[ "$run_status" -eq "$status" ]] ||
    fail "harness case $name: expected exit $status, got $run_status:"$'\n'"$harness_stderr"
  [[ -z "$harness_stdout" ]] ||
    fail "harness case $name: a plain run printed to stdout: $harness_stdout"
  for fragment in "$@"; do
    grep -qF -- "$fragment" "$dir/lint.err" ||
      fail "harness case $name: stderr lacks '$fragment':"$'\n'"$harness_stderr"
  done
  if [[ "$run_status" -eq 1 ]]; then
    grep -qF -- "$baseline" <<<"${harness_stderr%%$'\n'*}" ||
      fail "harness case $name: first failure line does not name $baseline: ${harness_stderr%%$'\n'*}"
  fi
}

# prior art, literal rows (Rust-only sleeps and `//` comments are not shell)
harness_case prior-literal-01 - 1 - - 'sleep 0.2'
harness_case prior-literal-02 - 1 - - 'sleep .2'
harness_case prior-literal-03 - 1 - - 'sleep  0.2'
harness_case prior-literal-04 - 1 - - $'sleep\t0.2'
harness_case prior-literal-05 - 1 - - 'sleep "0.2"'
harness_case prior-literal-06 - 1 - - "sleep '2'"
harness_case prior-literal-07 - 1 - - 'sleep {secs}\n\'
harness_case prior-literal-08 - 1 - - 'while [ ! -e x ]; do sleep 0.05; done'
harness_case prior-literal-09 - 1 - - 'sleep 0.2; sleep 60 &'
harness_case prior-literal-10 - 0 - - 'thread::sleep(Duration::from_secs(1)); // sleep 60 &'
harness_case prior-literal-11 - 0 - - 'sleep 60 &\n\'
harness_case prior-literal-12 - 0 - - 'while :; do sleep 60 & wait $!; done\n"'
harness_case prior-literal-13 - 0 - - 'nosleep 10'
harness_case prior-literal-14 - 0 - - 'thread_sleep 10'
harness_case prior-literal-15 - 1 - - '// sleep 5'
harness_case prior-literal-16 - 0 - - 'echo sleep'
harness_case prior-literal-17 - 0 - - 'tokio::time::sleep(Duration::from_millis(100)).await;'
harness_case prior-literal-18 - 0 - - 'time::sleep(d).await'
harness_case prior-literal-19 - 0 - - 'fn sleep_then(after: Duration, f: impl FnOnce()) {'
harness_case prior-literal-20 - 1 - - 'sleep 60 && echo'
harness_case prior-literal-21 - 1 - - 'sleep 60 &>/dev/null'
harness_case prior-literal-22 - 0 - - 'sleep 60 & wait $!'
harness_case prior-literal-23 - 0 - - 'sleep 60 &'
# prior art, Rust-only rows restated in shell terms
harness_case prior-adapted-10 - 1 - - 'time.sleep(1) # sleep 60 &'
harness_case prior-adapted-15 - 0 - - '# sleep 5'
harness_case prior-adapted-17 - 1 - - 'time.sleep(.1)'
harness_case prior-adapted-18 - 1 - - 'sleep 1'

# predicate
harness_case python-integer - 1 - - 'time.sleep(1)'
harness_case python-fraction - 1 - - 'time.sleep(.25)'
harness_case python-variable - 0 - - 'time.sleep(delay)'
harness_case python-comment - 0 - - '  # time.sleep(1)'
harness_case shell-variable - 0 - - 'sleep "$interval"'
harness_case other-sleep-after-stayalive - 1 - - 'sleep 60 & sleep .1'
harness_case quoted-sixty-not-exempt - 1 - - 'sleep "60" &'
harness_case stayalive-double-space-not-exempt - 1 - - 'sleep 60  &'

# markers
harness_case marker-same-line - 0 - - 'sleep 1 # timing-guard: reason'
harness_case marker-above - 0 - - $'# timing-guard: reason\nsleep 1'
harness_case marker-two-above - 1 - - $'# timing-guard: reason\n:\nsleep 1'
harness_case marker-no-hash - 1 - - 'sleep 1; echo "timing-guard: reason"'
harness_case marker-hash-in-string - 1 - - $'echo "# timing-guard: reason"\nsleep 1'
harness_case marker-single-string - 1 - - $'echo \'# timing-guard: reason\'\nsleep 1'
harness_case marker-quoted-before-comment - 0 - - 'echo "# not a marker"; sleep 1 # timing-guard: reason'
harness_case malformed-same-line - 1 1 $'scripts/x.test.sh 1\n' 'sleep 1 # timing-guard:' 'marker is malformed'
harness_case malformed-above - 1 1 $'scripts/x.test.sh 1\n' $'# timing-guard:\nsleep 1' 'marker is malformed'
harness_case malformed-whitespace - 1 1 $'scripts/x.test.sh 1\n' $'sleep 1 # timing-guard:  \t' 'marker is malformed'
# an unquoted `#` starts a comment only at the start of a word (PR #5433 review)
harness_case marker-hash-inside-word - 1 - - $'sleep 1; printf \'%s\\n\' foo#timing-guard: reason' 'scripts/x.test.sh:1:'
harness_case marker-hash-no-space - 0 - - 'sleep 1 #timing-guard: reason'
harness_case marker-hash-after-semicolon - 0 - - 'sleep 1;# timing-guard: reason'
harness_case marker-hash-after-brace - 0 - - '{ sleep 1; }# timing-guard: reason'
harness_case malformed-hash-inside-word-is-not-a-marker - 1 - - 'sleep 1; echo foo#timing-guard:' 'scripts/x.test.sh:1:'
# sleeps are scanned only up to the `#` comment (PR #5433 review)
harness_case comment-sleep-after-command - 0 - - 'echo ok # sleep 1'
harness_case comment-python-sleep-in-heredoc - 0 - - $'python3 - <<\'CODE\'\nx = 0  # time.sleep(1)\nCODE'
harness_case comment-after-real-sleep-still-counts - 1 - - 'sleep 1 # explanatory text' 'scripts/x.test.sh:1:'
harness_case comment-sleep-inside-word-counts - 1 - - 'sleep 1; echo foo#sleep 2' 'scripts/x.test.sh:1:'
harness_case loop-comment-sleep-only - 0 - - $'for _ in {1..3}; do\n  echo ok # sleep 1\ndone'

# fixed-count loops: the header counts as a site when the body has a sleep
harness_case loop-inline - 2 - - 'for _ in {1..3}; do sleep .1; done'
harness_case loop-multiline - 2 - - $'for _ in {1..3}; do\n  sleep .1\ndone'
harness_case loop-step - 2 - - $'for idx in {3..1..-1}; do\n  time.sleep(.1)\ndone'
harness_case loop-no-sleep - 0 - - $'for _ in {1..3}; do\n  echo ok\ndone'
harness_case loop-stayalive-only - 0 - - $'for _ in {1..3}; do\n  sleep 60 &\ndone'
harness_case loop-sleep-after - 1 - - $'for _ in {1..3}; do\n  :\ndone\nsleep 1'
harness_case loop-inner-marked - 1 - - $'for _ in {1..3}; do\n  :\n  sleep 1 # timing-guard: interval\ndone'
harness_case loop-header-marked - 1 - - $'# timing-guard: bounded fixture\nfor _ in {1..3}; do\n  :\n  sleep 1\ndone'
harness_case loop-nested-while - 2 - - $'for _ in {1..3}; do\n  while :; do\n    break\n  done\n  sleep 1\ndone'
harness_case loop-nested-until - 2 - - $'for _ in {1..3}; do\n  until false; do\n    sleep 1\n  done\ndone'
harness_case loop-nested-for - 2 - - $'for _ in {1..3}; do\n  for x in a b; do\n    :\n  done\n  sleep 1\ndone'
harness_case loop-nested-fixed - 3 - - $'for _ in {1..3}; do\n  for x in {1..2}; do\n    sleep 1\n  done\ndone'
harness_case loop-quoted-done - 2 - - $'for _ in {1..3}; do\n  echo "done"\n  sleep 1\ndone'
harness_case loop-comment-done - 2 - - $'for _ in {1..3}; do\n  # done\n  sleep 1\ndone'
# loop keywords are only keywords in command position (wave-1 regressions)
harness_case loop-done-argument - 2 - - $'for _ in {1..3}; do\n  echo done\n  sleep 1\ndone'
harness_case loop-done-argument-marked-sleep - 1 - - $'for _ in {1..3}; do\n  echo done\n  sleep 1 # timing-guard: interval\ndone'
harness_case loop-nested-bare-while - 2 - - $'for _ in {1..3}; do\n  while\n    false\n  do\n    :\n  done\n  sleep 1\ndone'
harness_case loop-until-word-argument - 1 - - $'for _ in {1..3}; do\n  echo until next time\ndone\nsleep 1'
harness_case loop-arguments-after-do-word - 1 - - $'for _ in {1..3}; do\n  echo do done\n  sleep 1 # timing-guard: interval\ndone'
harness_case loop-done-variable-assignment - 1 - - $'for _ in {1..3}; do\n  done=1\n  sleep 1 # timing-guard: interval\ndone'
harness_case loop-do-word-until-argument - 1 - - $'for _ in {1..3}; do\n  echo do until next time\ndone\nsleep 1'
harness_case loop-after-if-then - 2 - - $'if true; then for _ in {1..3}; do\n  sleep 1\ndone; fi'
harness_case loop-nested-bare-until - 2 - - $'for _ in {1..3}; do\n  until\n    true\n  do\n    :\n  done\n  sleep 1\ndone'
# functions and subshells: `)` restores command position so `f() {` opens a
# body, while a `$(…)` / `<(…)` substitution ends mid-word (PR #5433 review)
harness_case loop-in-function-inline - 1 - - $'f() { for i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone; }' 'scripts/x.test.sh:1:'
harness_case loop-in-function-newline - 1 - - $'f() {\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone\n}' 'scripts/x.test.sh:2:'
harness_case loop-nested-function-while - 1 - - $'for i in {1..3}; do\n  f() { while false; do :; done; }\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:1:'
harness_case loop-in-subshell-inline - 1 - - $'(for i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone)' 'scripts/x.test.sh:1:'
harness_case loop-in-command-substitution - 1 - - $'result=$(for i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone)' 'scripts/x.test.sh:1:'
harness_case loop-done-after-substitution - 1 - - $'for i in {1..3}; do\n  echo $(date) done\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:1:'
harness_case loop-done-after-process-substitution - 1 - - $'for i in {1..3}; do\n  diff <(echo a) done\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:1:'
harness_case loop-brace-argument - 1 - - $'for i in {1..3}; do\n  echo { done\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:1:'
# heredocs: body lines are data for loop tracking only; rules 1-2 and markers
# still scan them because `cat <<'SH'` writes executable stubs
harness_case heredoc-python-for-is-data - 1 - - $'for i in {1..3}; do\npython3 - <<\'CODE\'\nfor n in range(3):\n    print(n)\nCODE\ndone\nsleep 1' 'scripts/x.test.sh:7:'
harness_case heredoc-python-done-is-data - 1 - - $'for i in {1..3}; do\npython3 - <<\'CODE\'\nimport time\ndone = False\ntime.sleep(.1) # timing-guard: poll interval\nCODE\ndone' 'scripts/x.test.sh:1:'
harness_case heredoc-loop-header-is-data - 1 - - $'cat <<\'CODE\'\nfor i in {1..3}; do\nCODE\nsleep 1' 'scripts/x.test.sh:4:'
harness_case heredoc-quoted-loop-is-data - 1 - - $'cat <<\'CODE\'\nfor i in {1..3}; do\n  :\ndone\nCODE\nsleep 1' 'scripts/x.test.sh:6:'
harness_case heredoc-shell-sleep-still-counts - 1 - - $'cat <<\'SH\' >stub.sh\nsleep 5\nSH' 'scripts/x.test.sh:2:'
harness_case heredoc-shell-sleep-in-loop - 2 - - $'for i in {1..3}; do\n  cat <<SH >stub.sh\nsleep 5\nSH\ndone' 'scripts/x.test.sh:1:' 'scripts/x.test.sh:3:'
harness_case heredoc-python-sleep-still-counts - 1 - - $'python3 - <<PY\nimport time\ntime.sleep(2)\nPY' 'scripts/x.test.sh:3:'
harness_case heredoc-marker-still-exempts - 0 - - $'cat <<\'SH\' >stub.sh\nsleep 5 # timing-guard: stub fixture\nSH'
harness_case heredoc-dash-strips-tabs - 1 - - $'for i in {1..3}; do\n\tcat <<-EOF\n\tdone\n\tEOF\ndone\nsleep 1' 'scripts/x.test.sh:6:'
harness_case heredoc-here-string-is-not-a-heredoc - 1 - - $'for i in {1..3}; do\n  read -r x <<<"$y"\n  :\ndone\nsleep 1' 'scripts/x.test.sh:5:'
harness_case heredoc-quoted-operator-is-text - 1 - - $'for i in {1..3}; do\n  echo "<<EOF"\n  :\ndone\nsleep 1' 'scripts/x.test.sh:5:'
# `<<` inside `$((…))` / `((…))` is a shift, not a heredoc opener (PR #5433 review)
harness_case arith-shift-expansion-before-loop - 1 - - $'flags=$((1 << 2))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:2:'
harness_case arith-shift-statement-before-loop - 1 - - $'((flags = 1 << 2))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:2:'
harness_case arith-shift-no-space - 1 - - $'x=$((y<<3))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:2:'
harness_case arith-shift-nested-parens - 1 - - $'x=$(( (y<<3) + (1 << 2) ))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:2:'
harness_case arith-then-heredoc-same-line - 1 - - $'x=$((1 << 2)); cat <<EOF\ndone\nEOF\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
# a quoted or escaped delimiter is read as one shell word (PR #5433 review)
harness_case heredoc-quoted-delimiter-space - 1 - - $'cat <<\'END CODE\'\ndone\nEND CODE\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
harness_case heredoc-double-quoted-delimiter-space - 1 - - $'cat <<"END CODE"\ndone\nEND CODE\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
harness_case heredoc-dash-quoted-delimiter-space - 1 - - $'cat <<-\'END CODE\'\n\tdone\n\tEND CODE\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
harness_case heredoc-escaped-space-delimiter - 1 - - $'cat <<END\\ CODE\ndone\nEND CODE\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
harness_case heredoc-backslash-delimiter - 1 - - $'cat <<\\EOF\ndone\nEOF\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone' 'scripts/x.test.sh:4:'
# known limitations (accepted false negatives / misattributions, PR #5433
# review): these pin the CURRENT output, not the desired one. A parser change
# that flips any of them must update both the expectation here and the "Known
# limitations of rule 3" list in the lint header. The first three miss the
# unmarked fixed-count header (a correct parse would count 1, the lint counts
# 0); the fourth reports the already-closed header on line 1 because the
# `done` on line 5 falls inside the mistaken heredoc region (a correct parse
# would count 0, the lint counts 1).
harness_case known-limit-arith-multiline-expansion - 0 - - $'flags=$((\n  1 << 2\n))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone'
harness_case known-limit-arith-multiline-command - 0 - - $'((\n  flags = 1 << 2\n))\nfor i in {1..3}; do\n  :\n  sleep .1 # timing-guard: poll interval\ndone'
harness_case known-limit-case-pattern-done - 0 - - $'for i in {1..3}; do\n  case $i in\n    done) :;;\n  esac\n  sleep .1 # timing-guard: poll interval\ndone'
harness_case known-limit-arith-multiline-in-loop-misattributes - 1 - - $'for i in {1..3}; do\n  flags=$((\n    1 << 2\n  ))\ndone\nsleep 1 # timing-guard: legitimate outside wait' 'scripts/x.test.sh:1:'

# ratchet and baseline syntax
harness_case ratchet-equal - 1 0 $'scripts/x.test.sh 1\n' 'sleep 1'
harness_case ratchet-over - 2 1 $'scripts/x.test.sh 1\n' $'sleep 1\nsleep 2' \
  'scripts/x.test.sh:1:' 'scripts/x.test.sh:2:' '`scripts/x.test.sh 2`'
harness_case ratchet-under - 1 1 $'scripts/x.test.sh 2\n' 'sleep 1' 'replace its line with `scripts/x.test.sh 1`'
harness_case ratchet-zero - 0 1 $'scripts/x.test.sh 2\n' ':' 'remove its line `scripts/x.test.sh 2`'
harness_case ratchet-stale - 0 1 $'scripts/gone.test.sh 4\n' ':' 'no longer exists; remove its line `scripts/gone.test.sh 4`'
harness_case baseline-unsorted - 0 1 $'scripts/z.test.sh 1\nscripts/a.test.sh 1\n' ':' \
  "$baseline:2:" 'sorted by path and unique'
harness_case baseline-duplicate - 0 1 $'scripts/x.test.sh 1\nscripts/x.test.sh 2\n' ':' \
  "$baseline:2:" 'sorted by path and unique'
harness_case baseline-count-zero - 0 1 $'scripts/x.test.sh 0\n' ':' "$baseline:1:" 'remove "scripts/x.test.sh 0"'
harness_case baseline-nonnumeric - 0 1 $'scripts/x.test.sh many\n' ':' "$baseline:1:" 'is not a number'
harness_case baseline-no-count - 0 1 $'scripts/x.test.sh\n' ':' "$baseline:1:" 'expected `<path> <count>`'

# only scripts/*.test.sh, one level deep, minus this file
harness_case skip-self-test scripts/lint-fixed-sleeps.test.sh 0 - - 'sleep 1'
harness_case skip-recursive scripts/subdir/x.test.sh 0 - - 'sleep 1'
harness_case skip-nontest scripts/production.sh 0 - - 'sleep 1'

[[ "$harness_cases" -eq 124 ]] || fail "expected 124 harness cases, ran $harness_cases"

echo "lint-fixed-sleeps tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${LINT_FIXED_SLEEPS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as docs-check.test.sh: BASH3_BIN, bash3, Homebrew bash@3, 3.x
# /bin/bash) and require a byte-identical transcript. A missing Bash 3 is a
# skip notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to make
# it a failure instead.
bash -n "$script" || fail "lint-fixed-sleeps.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "lint-fixed-sleeps.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments and the pattern itself are not scanned, nor is the awk
# program inside the lint's `<<'AWK'` heredoc: it is awk, not bash, and its
# character classes (`[;&|()]`) read as `case` fallthrough operators. The
# heredoc lines are blanked, not dropped, so reported line numbers stay right.
gate_matches() {
  local file
  for file in "$@"; do
    sed "/<<'AWK'/,/^AWK\$/s/.*//" "$file" | grep -nE "$bash4_constructs" | sed "s|^|$file:|" || true
  done | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' | grep -v -F 'bash4_constructs' || true
}
gate_hits=$(gate_matches "$script" "${BASH_SOURCE[0]}")
[[ -z "$gate_hits" ]] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

find_bash3() {
  local candidate resolved brew_prefix
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  for candidate in "${BASH3_BIN:-}" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [[ -n "$candidate" ]] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [[ -x "$resolved" ]] || continue
    "$resolved" -c '[[ "${BASH_VERSINFO[0]}" -eq 3 ]]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  bash3_transcript=$temp_dir/bash3-transcript
  LINT_FIXED_SLEEPS_TEST_BASH="$bash3" LINT_FIXED_SLEEPS_TEST_TRANSCRIPT="$bash3_transcript" \
    "$bash3" "${BASH_SOURCE[0]}"
  cmp -s "$transcript" "$bash3_transcript" ||
    fail "lint-fixed-sleeps.sh output differs between bash $BASH_VERSION and $bash3:"$'\n'"$(diff "$transcript" "$bash3_transcript" || true)"
  echo "lint-fixed-sleeps.sh output is identical under bash $BASH_VERSION and $bash3"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "lint-fixed-sleeps tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
