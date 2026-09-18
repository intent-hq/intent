#!/usr/bin/env bash

set -euo pipefail

# Monorepo-owned changed-tests behaviour only: the `make test-changed` and
# `make coverage-changed` recipes wrapping intentd's scripts/changed-tests.sh,
# and the --runner hand-off into scripts/resumable_nextest.py (record/resume).
# The path -> crate mapping, fallback and grouping cases live in intentd's
# scripts/test-changed-tests.sh.

# The caller's environment must not steer the recipes under test (a shell with
# BASE=HEAD or DRY_RUN=1 exported would change every expected argv).
unset BASE DRY_RUN INTENTD_DIR BUILD_JOBS TEST_THREADS NEXTEST_SHOW_PROGRESS CARGO_TERM_PROGRESS_WHEN
unset NEXTEST_RUNNER RESUME GATE_FORCE GATE_CACHE_DIR NEXTEST_HIDE_PROGRESS_BAR MAKEFLAGS MFLAGS

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
intentd_script="$repo_root/packages/intentd/scripts/changed-tests.sh"
# The interpreter the intentd script runs under (its `#!/usr/bin/env bash`
# resolves to $bin_dir/bash) defaults to the one running this suite; the Bash
# 3.2 compatibility pass at the end re-executes the suite with a real Bash 3.
script_bash=${RUST_CHANGED_TESTS_TEST_BASH:-$BASH}
temp_dir=$(cd "$(mktemp -d)" && pwd -P)
bin_dir="$temp_dir/bin"
mkdir -p "$bin_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "rust-changed-tests test failed: $*" >&2
  exit 1
}

[[ -f "$intentd_script" ]] \
  || fail "$intentd_script is missing; initialize the intentd submodule (git submodule update --init packages/intentd)"

ln -s "$script_bash" "$bin_dir/bash"
for command in dirname mktemp rm sort; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done
# python3 runs the real record-writing runner in the end-to-end cases below;
# those are skipped when it is missing.
python3=$(command -v python3 2>/dev/null) || python3=""
[[ -z "$python3" ]] || ln -s "$python3" "$bin_dir/python3"
ln -s "$(command -v git)" "$bin_dir/git"

# Stub cargo: every invocation is appended to CARGO_TEST_LOG as "<cwd>: <argv>";
# the subcommand named by CARGO_STUB_MISSING fails like an uninstalled cargo
# subcommand (`cargo llvm-cov --version` without cargo-llvm-cov), everything
# else exits 0.
cat >"$bin_dir/cargo" <<'SH'
#!/usr/bin/env bash
printf '%s: %s\n' "$PWD" "$*" >>"$CARGO_TEST_LOG"
if [[ -n "${CARGO_STUB_MISSING-}" && "${1-}" == "$CARGO_STUB_MISSING" ]]; then
  echo "error: no such command: $1" >&2
  exit 101
fi
SH
chmod +x "$bin_dir/cargo"

# Stub make, standing in for the recipe's $(MAKE) re-entry: records its argv.
cat >"$bin_dir/make-stub" <<'SH'
#!/usr/bin/env bash
{ echo "make:"; printf '%s\n' "$@"; } >>"$PLANNER_TEST_LOG"
SH
chmod +x "$bin_dir/make-stub"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

# The recipes run from a copy of the real Makefile in a checkout whose path
# carries an apostrophe (the runner line must hand such paths over as whole
# words; nested quotes used to make the recipe itself fail to parse with exit
# 2). make -n cannot check this: the test-changed logical line contains
# $(MAKE), so -n executes it anyway. A stub planner in place of intentd's
# scripts/changed-tests.sh records its argv, the knobs the recipe exports and,
# when NEXTEST_RUNNER is set, the words the script's eval would hand the
# runner. The Makefile prepends the rustup-pinned cargo dir and CARGO_BIN_DIR
# (default ~/.cargo/bin) to every recipe's PATH, so a host cargo would outrank
# the stub; pointing CARGO_BIN_DIR at the stub dir and blanking RUSTUP_CARGO
# keeps the preflights hermetic on any host.
mk="$temp_dir/reviewer's checkout"
mkdir -p "$mk/scripts" "$mk/packages/intentd/scripts" "$mk/packages/intentd/.git"
cp "$repo_root/Makefile" "$mk/Makefile"
cat >"$mk/packages/intentd/scripts/changed-tests.sh" <<'SH'
#!/usr/bin/env bash
{
  echo "call:"
  printf '%s\n' "$@"
  for knob in BASE DRY_RUN BUILD_JOBS TEST_THREADS NEXTEST_SHOW_PROGRESS CARGO_TERM_PROGRESS_WHEN; do
    printf 'env %s=%s\n' "$knob" "${!knob-}"
  done
  if [[ -n "${NEXTEST_RUNNER-}" ]]; then
    eval "set -- $NEXTEST_RUNNER"
    echo "runner:"
    printf '%s\n' "$@"
  fi
} >>"$PLANNER_TEST_LOG"
exit "${PLANNER_STUB_EXIT:-0}"
SH
chmod +x "$mk/packages/intentd/scripts/changed-tests.sh"

make_bin=$(command -v make 2>/dev/null) || make_bin=""

# Env prefixes on the call (PLANNER_STUB_EXIT=3 run_make ...) reach the stubs;
# make variables go on the command line after the target.
run_make() {
  : >"$temp_dir/planner.log"
  : >"$temp_dir/cargo.log"
  set +e
  PATH="$bin_dir" PLANNER_TEST_LOG="$temp_dir/planner.log" CARGO_TEST_LOG="$temp_dir/cargo.log" \
    "$make_bin" -C "$mk" --no-print-directory "$@" CARGO_BIN_DIR="$bin_dir" RUSTUP_CARGO= \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr" </dev/null
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
  planner_log=$(<"$temp_dir/planner.log")
  cargo_log=$(<"$temp_dir/cargo.log")
}

expect_make_ok() {
  [[ "$status" -eq 0 ]] || fail "$case_name: make exited $status: $stderr"
}

# $1 = the planner argv line(s), $2.. = the knob values in the stub's order.
expect_planner() {
  local expected="call:"$'\n'"$1" knob
  shift
  for knob in BASE DRY_RUN BUILD_JOBS TEST_THREADS NEXTEST_SHOW_PROGRESS CARGO_TERM_PROGRESS_WHEN; do
    expected+=$'\n'"env $knob=$1"
    shift
  done
  [[ "$planner_log" == "$expected"* ]] || fail "$case_name: planner log was"$'\n'"$planner_log"$'\n'"expected to start with"$'\n'"$expected"
}

if [[ -z "$make_bin" ]]; then
  echo "rust-changed-tests tests: make not found; Makefile recipe cases skipped"
else
  case_name="test-changed recipe survives an apostrophe in GATE_CACHE_DIR"
  run_make test-changed GATE_CACHE_DIR="$mk/gate runs" RESUME=1
  expect_make_ok
  [[ "$cargo_log" == *": nextest --version" ]] \
    || fail "$case_name: stub cargo did not serve the preflight; cargo log: '$cargo_log'"
  expect_planner "" "" "" -2 -2 none never
  expected="runner:"$'\n'"python3"$'\n'"scripts/resumable_nextest.py"$'\n'"--repo-root"$'\n'"$mk"$'\n'"--intentd-dir"$'\n'"packages/intentd"$'\n'"--cache-dir"$'\n'"$mk/gate runs"$'\n'"--resume"$'\n'"1"$'\n'"--force"$'\n'"0"
  [[ "$planner_log" == *$'\n'"$expected" ]] || fail "$case_name: runner argv was"$'\n'"$planner_log"$'\n'"expected to end with"$'\n'"$expected"

  case_name="test-changed recipe passes BASE, DRY_RUN, BUILD_JOBS, TEST_THREADS and GATE_FORCE through"
  run_make test-changed BASE=other DRY_RUN=1 BUILD_JOBS=2 TEST_THREADS=1 GATE_FORCE=1
  expect_make_ok
  expect_planner "" other 1 2 1 none never
  [[ "$planner_log" == *$'\n'"--resume"$'\n'"0"$'\n'"--force"$'\n'"1" ]] || fail "$case_name: runner argv was"$'\n'"$planner_log"

  # Exit 3 (build-wide change) defers to the full `make test`: announced only
  # under DRY_RUN=1, re-entered through $(MAKE) otherwise. Any other failure
  # is the recipe's own.
  case_name="test-changed recipe announces the fallback under DRY_RUN=1"
  PLANNER_STUB_EXIT=3 run_make test-changed DRY_RUN=1 MAKE="$bin_dir/make-stub"
  expect_make_ok
  [[ "$stdout" == *"[test-changed] DRY_RUN: would fall back to the full 'make test'" ]] || fail "$case_name: stdout: $stdout"
  [[ "$planner_log" != *"make:"* ]] || fail "$case_name: re-entered make: $planner_log"

  case_name="test-changed recipe falls back to the full make test on exit 3"
  PLANNER_STUB_EXIT=3 run_make test-changed MAKE="$bin_dir/make-stub"
  expect_make_ok
  [[ "$stdout" == *"[test-changed] falling back to the full 'make test'" ]] || fail "$case_name: stdout: $stdout"
  [[ "$planner_log" == *$'\n'"make:"$'\n'"--no-print-directory"$'\n'"test" ]] || fail "$case_name: make re-entry argv was"$'\n'"$planner_log"

  case_name="test-changed recipe propagates other planner failures"
  PLANNER_STUB_EXIT=5 run_make test-changed MAKE="$bin_dir/make-stub"
  [[ "$status" -ne 0 ]] || fail "$case_name: make exited 0"
  [[ "$stderr" == *"Error 5"* ]] || fail "$case_name: stderr: $stderr"
  [[ "$stdout" != *"falling back"* && "$planner_log" != *"make:"* ]] || fail "$case_name: fell back: $stdout $planner_log"

  case_name="coverage-changed recipe passes --instrumented and the knobs"
  run_make coverage-changed BASE=other BUILD_JOBS=2 TEST_THREADS=1
  expect_make_ok
  [[ "$cargo_log" == *": nextest --version"$'\n'*": llvm-cov --version" ]] \
    || fail "$case_name: stub cargo did not serve both preflights; cargo log: '$cargo_log'"
  expect_planner "--instrumented" other "" 2 1 none never
  [[ "$planner_log" != *"runner:"* ]] || fail "$case_name: NEXTEST_RUNNER was set: $planner_log"

  case_name="coverage-changed recipe fails without cargo-llvm-cov"
  CARGO_STUB_MISSING=llvm-cov run_make coverage-changed
  [[ "$status" -ne 0 ]] || fail "$case_name: make exited 0"
  [[ "$stdout" == *"[coverage-changed] ERROR: cargo-llvm-cov is not installed"* ]] || fail "$case_name: stdout: $stdout"
  [[ -z "$planner_log" ]] || fail "$case_name: planner ran: $planner_log"

  case_name="coverage-changed recipe skips the preflight under DRY_RUN=1"
  CARGO_STUB_MISSING=llvm-cov run_make coverage-changed DRY_RUN=1
  expect_make_ok
  [[ -z "$cargo_log" ]] || fail "$case_name: cargo was invoked: $cargo_log"
  expect_planner "--instrumented" "" 1 -2 -2 none never
fi

# End to end through the real `make test-changed`: intentd's changed-tests.sh
# hands the plan to the real record-writing runner. A fixture intentd checkout
# (alpha has a lib and one integration test) carries scripts/changed-tests.sh
# as a committed symlink to the real script, so the script resolves the
# fixture as its repo root and the symlink is not an untracked change. The
# fixture monorepo carries a copy of the Makefile and the runner, and
# packages/intentd as a symlink to the fixture checkout so the runner's
# --intentd-dir resolves as the Makefile passes it. A fake cargo answers
# `nextest list` with a canned suite listing and `nextest run` with libtest
# `test ok` events for those tests (after checking the --tool-config-file the
# runner wrote exists); rustc/cargo version stubs feed the tree key.
if [[ -z "$python3" || -z "$make_bin" ]]; then
  echo "rust-changed-tests tests: python3 or make not found; record/resume end-to-end cases skipped"
else
  e2e_bin="$temp_dir/e2e-bin"
  repo="$temp_dir/e2e/intentd"
  mono="$temp_dir/e2e/mono"
  cache="$temp_dir/gate runs"
  mkdir -p "$e2e_bin" "$repo/scripts" "$repo/crates/alpha/src" "$repo/crates/alpha/tests" "$mono/packages" "$mono/scripts"
  printf '[workspace]\n' >"$repo/Cargo.toml"
  mkdir -p "$repo/.config"
  for file in Cargo.lock rust-toolchain.toml .config/nextest.toml \
    crates/alpha/Cargo.toml crates/alpha/src/lib.rs crates/alpha/tests/one.rs; do
    printf '%s\n' "$file" >"$repo/$file"
  done
  ln -s "$intentd_script" "$repo/scripts/changed-tests.sh"
  g() {
    git -C "$repo" "$@"
  }
  g init -q
  g add -A
  g commit -q -m base
  g update-ref refs/remotes/origin/main HEAD
  g checkout -q -b feature
  cp "$repo_root/Makefile" "$mono/Makefile"
  cp "$repo_root/scripts/resumable_nextest.py" "$mono/scripts/resumable_nextest.py"
  ln -s "$repo" "$mono/packages/intentd"
  printf '[submodule "packages/intentd"]\n\tpath = packages/intentd\n\turl = https://example.invalid/intentd.git\n' >"$mono/.gitmodules"
  git -C "$mono" init -q
  git -C "$mono" add -A
  git -C "$mono" commit -q -m mono
  printf '%s\n' '{"rust-suites":{"alpha::one":{"package-name":"alpha","binary-name":"one","binary-id":"alpha::one","testcases":{"passes":{},"also_passes":{}}}}}' >"$temp_dir/listing.json"
  printf '%s\n' '{"type":"suite","event":"started","test_count":2}' \
    '{"type":"test","event":"started","name":"alpha::one$passes"}' \
    '{"type":"test","event":"ok","name":"alpha::one$passes"}' \
    '{"type":"test","event":"ok","name":"alpha::one$also_passes"}' \
    '{"type":"suite","event":"ok","passed":2,"failed":0,"ignored":0}' >"$temp_dir/events.jsonl"
  export NEXTEST_STUB_LISTING="$temp_dir/listing.json" NEXTEST_STUB_EVENTS="$temp_dir/events.jsonl"
  printf '#!/usr/bin/env bash\necho "rustc 1.99.0 (stub)"\n' >"$e2e_bin/rustc"
  cat >"$e2e_bin/cargo" <<'SH'
#!/usr/bin/env bash
printf '%s: %s\n' "$PWD" "$*" >>"$CARGO_TEST_LOG"
if [[ "$1" == -V ]]; then echo "cargo 1.99.0 (stub)"; exit 0; fi
[[ "$1" == nextest ]] || { echo "cargo stub: unexpected argv: $*" >&2; exit 99; }
case "$2" in
  --version) echo "cargo-nextest 0.9.99 (stub)" ;;
  list) while IFS= read -r line; do printf '%s\n' "$line"; done <"$NEXTEST_STUB_LISTING" ;;
  run)
    config=""
    for arg in "$@"; do
      case "$arg" in intent-gate:*) config=${arg#intent-gate:} ;; esac
    done
    [[ -n "$config" && -f "$config" ]] || { echo "cargo stub: --tool-config-file is missing: '$config'" >&2; exit 98; }
    while IFS= read -r line; do printf '%s\n' "$line"; done <"$NEXTEST_STUB_EVENTS"
    ;;
  *) echo "cargo stub: unexpected argv: $*" >&2; exit 99 ;;
esac
SH
  chmod +x "$e2e_bin/rustc" "$e2e_bin/cargo"

  # $1 = RESUME, $2 = GATE_FORCE. CARGO_BIN_DIR puts the e2e stubs ahead of the
  # plain ones on the recipe's PATH.
  e2e_make() {
    : >"$temp_dir/cargo.log"
    set +e
    PATH="$bin_dir" CARGO_TEST_LOG="$temp_dir/cargo.log" \
      "$make_bin" -C "$mono" --no-print-directory test-changed CARGO_BIN_DIR="$e2e_bin" RUSTUP_CARGO= \
      GATE_CACHE_DIR="$cache" RESUME="$1" GATE_FORCE="$2" BUILD_JOBS=2 TEST_THREADS=1 \
      >"$temp_dir/stdout" 2>"$temp_dir/stderr" </dev/null
    status=$?
    set -e
    stdout=$(<"$temp_dir/stdout")
    stderr=$(<"$temp_dir/stderr")
    cargo_log=$(<"$temp_dir/cargo.log")
  }
  expect_ok() {
    [[ "$status" -eq 0 ]] || fail "$case_name: exited $status: $stderr"
    [[ -z "$stderr" ]] || fail "$case_name: unexpected stderr: $stderr"
  }
  summary_line="[test-changed] summary: 2 passed, 0 failed, 0 skipped/ignored, 0 resumed (tests already passed for this tree)"
  expect_recorded_run() {
    expect_ok
    [[ "$stdout" == *"[test-changed] cargo nextest run -p alpha --test one --build-jobs 2 --test-threads 1"$'\n'* ]] || fail "$case_name: plan line missing: $stdout"
    [[ "$stdout" == *$'\n'"$summary_line"$'\n'"[test-changed] record: $cache/"* ]] || fail "$case_name: summary/record lines missing: $stdout"
    record_dir=${stdout##*"[test-changed] record: "}
    [[ "$record_dir" == "$cache"/*/changed/* && -d "$record_dir" ]] || fail "$case_name: record dir '$record_dir' is not <cache>/<tree-key>/changed/<plan-key>"
    [[ "$cargo_log" == *"$repo: nextest list -p alpha --test one --build-jobs 2 --message-format json"$'\n'"$repo: nextest run -p alpha --test one --build-jobs 2 --test-threads 1 --tool-config-file intent-gate:$record_dir/nextest-1.toml --profile "*" --message-format libtest-json-plus --message-format-version 0.1"* ]] || fail "$case_name: cargo argv was"$'\n'"$cargo_log"
  }

  case_name="end to end: first run writes the plan record"
  echo "// changed" >>"$repo/crates/alpha/tests/one.rs"
  e2e_make 0 0
  expect_recorded_run
  for file in run.json summary.txt complete nextest-1.toml; do
    [[ -f "$record_dir/$file" ]] || fail "$case_name: $record_dir/$file is missing"
  done
  grep -q '^path = "junit-1.xml"$' "$record_dir/nextest-1.toml" || fail "$case_name: junit-1.xml is not configured: $(<"$record_dir/nextest-1.toml")"
  [[ "$(<"$record_dir/summary.txt")" == "$summary_line" ]] || fail "$case_name: summary.txt: $(<"$record_dir/summary.txt")"
  for field in '"label": "test-changed"' '"base": "origin/main"' '"-p alpha --test one"' '"exit_code": 0' '"passed": 2'; do
    grep -qF "$field" "$record_dir/run.json" || fail "$case_name: run.json lacks $field: $(<"$record_dir/run.json")"
  done
  tree_dir=${record_dir%/changed/*}
  [[ ! -e "$tree_dir/complete" ]] || fail "$case_name: a planned run wrote the full-suite complete marker"
  [[ "$(grep -c . "$tree_dir/passed.jsonl")" -eq 2 ]] || fail "$case_name: passed.jsonl: $(<"$tree_dir/passed.jsonl")"
  first_record=$record_dir

  case_name="end to end: RESUME=1 on the unchanged tree skips the run"
  e2e_make 1 0
  expect_ok
  [[ "$stdout" == *"[test-changed] cargo nextest run -p alpha --test one"*$'\n'"resumed: skipped 2 tests already passed for this tree" ]] || fail "$case_name: stdout: $stdout"
  [[ "$cargo_log" != *"nextest list"* && "$cargo_log" != *"nextest run"* ]] || fail "$case_name: cargo was invoked: $cargo_log"

  case_name="end to end: RESUME=1 after a tracked edit runs the plan again"
  echo "// changed" >>"$repo/crates/alpha/tests/one.rs"
  e2e_make 1 0
  expect_recorded_run
  [[ "$stdout" == *"[test-changed] no passed-test record for this tree; running every planned test"* ]] || fail "$case_name: stdout: $stdout"
  [[ "$record_dir" != "$first_record" ]] || fail "$case_name: the record dir did not change with the tree"
  changed_record=$record_dir

  case_name="end to end: GATE_FORCE=1 ignores the matching record"
  e2e_make 1 1
  expect_recorded_run
  [[ "$stdout" == *"[test-changed] GATE_FORCE=1: running every planned test"* ]] || fail "$case_name: stdout: $stdout"
  [[ "$record_dir" == "$changed_record" ]] || fail "$case_name: record dir moved on an unchanged tree: $record_dir"
fi

echo "rust-changed-tests tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${RUST_CHANGED_TESTS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4706). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as shipped-in.test.sh). intentd's script has its own Bash 3 gate in
# scripts/test-changed-tests.sh; this suite's rerun feeds it a Bash 3 through
# $bin_dir/bash. A missing Bash 3 is a skip notice by default; set
# REQUIRE_BASH3 to a non-empty value (CI) to make it a failure instead.
bash -n "${BASH_SOURCE[0]}" || fail "rust-changed-tests.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments, the pattern itself and the gate_sample calls below are
# not scanned.
gate_matches() {
  grep -nE "$bash4_constructs" "$@" | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' |
    grep -v -F -e 'bash4_constructs' -e 'gate_sample' || true
}
gate_sample() {
  local expected=$1 sample=$2 hit
  hit=$(printf '%s\n' "$sample" | gate_matches)
  case "$expected:${hit:+hit}" in
    hit:hit | miss:) ;;
    *) fail "gate regex $expected sample misclassified: $sample" ;;
  esac
}
gate_sample hit 'declare -A m=()'
gate_sample hit 'local -n ref=x'
gate_sample hit 'mapfile -t a'
gate_sample hit 'echo ${var,,}'
gate_sample hit 'cmd |& tee'
gate_sample hit 'x) y ;;&'
gate_sample miss 'local path=$1 rest crate sub name'
gate_sample miss 'echo ${rest%%/*}'
gate_sample miss 'echo ${path##* -> }'
gate_sample miss 'x) y ;;'
gate_sample miss '# mapfile is unavailable on Bash 3'
gate_hits=$(gate_matches "${BASH_SOURCE[0]}")
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
  RUST_CHANGED_TESTS_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "rust-changed-tests tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
