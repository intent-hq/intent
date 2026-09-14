#!/usr/bin/env bash

set -euo pipefail

# The caller's environment must not steer the script under test (a shell with
# BASE=HEAD or DRY_RUN=1 exported would change every expected argv).
unset BASE DRY_RUN INTENTD_DIR BUILD_JOBS TEST_THREADS NEXTEST_SHOW_PROGRESS CARGO_TERM_PROGRESS_WHEN
unset NEXTEST_RUNNER RESUME GATE_FORCE GATE_CACHE_DIR NEXTEST_HIDE_PROGRESS_BAR

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/rust-changed-tests.sh"
# The interpreter that runs the script under test defaults to the one running
# this suite; the Bash 3.2 compatibility pass at the end re-executes the suite
# with it set to a real Bash 3.
script_bash=${RUST_CHANGED_TESTS_TEST_BASH:-$BASH}
temp_dir=$(cd "$(mktemp -d)" && pwd -P)
bin_dir="$temp_dir/bin"
# The fixture checkout sits where the script's INTENTD_DIR default resolves
# relative to a symlinked copy of the script under $temp_dir/scripts.
repo="$temp_dir/packages/intentd"
mkdir -p "$bin_dir" "$repo" "$temp_dir/scripts"
ln -s "$script" "$temp_dir/scripts/rust-changed-tests.sh"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "rust-changed-tests test failed: $*" >&2
  exit 1
}

for command in bash dirname mktemp rm sort; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done
# python3 runs the real record-writing runner in the end-to-end cases below;
# those are skipped when it is missing.
python3=$(command -v python3 2>/dev/null) || python3=""
[[ -z "$python3" ]] || ln -s "$python3" "$bin_dir/python3"

# git wrapper: the subcommand named by GIT_STUB_FAIL fails like a broken
# checkout would; everything else reaches the real git.
real_git=$(command -v git)
cat >"$bin_dir/git" <<SH
#!/usr/bin/env bash
if [[ -n "\${GIT_STUB_FAIL-}" && "\${1-}" == "\$GIT_STUB_FAIL" ]]; then
  echo "fatal: stubbed git \$1 failure" >&2
  exit 128
fi
exec "$real_git" "\$@"
SH
chmod +x "$bin_dir/git"

# Stub cargo: every invocation is appended to CARGO_TEST_LOG as "<cwd>: <argv>"
# and exits with CARGO_STUB_EXIT (default 0). It drains stdin like a real
# nextest child could, so the script must not feed it the remaining plans.
cat >"$bin_dir/cargo" <<'SH'
#!/usr/bin/env bash
printf '%s: %s\n' "$PWD" "$*" >>"$CARGO_TEST_LOG"
while IFS= read -r _; do :; done
exit "${CARGO_STUB_EXIT:-0}"
SH
chmod +x "$bin_dir/cargo"

# Stub runner: appends "call:" plus one line per argv word to RUNNER_TEST_LOG
# and exits with RUNNER_STUB_EXIT (default 0).
cat >"$bin_dir/runner" <<'SH'
#!/usr/bin/env bash
{ echo "call:"; printf '%s\n' "$@"; } >>"$RUNNER_TEST_LOG"
exit "${RUNNER_STUB_EXIT:-0}"
SH
chmod +x "$bin_dir/runner"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

g() {
  git -C "$repo" "$@"
}

# Fixture workspace: alpha has a lib and two integration tests with shared
# helpers, beta is a binary-only crate, gamma mirrors alpha's smoke test name.
write() {
  mkdir -p "$repo/$(dirname "$1")"
  printf '%s\n' "${2:-$1}" >"$repo/$1"
}
write Cargo.toml '[workspace]'
write Cargo.lock
write rust-toolchain.toml
write .config/nextest.toml
write .cargo/config.toml
write crates/alpha/Cargo.toml
write crates/alpha/src/lib.rs
write crates/alpha/src/util/mod.rs
write crates/alpha/tests/one.rs
write crates/alpha/tests/two.rs
write crates/alpha/tests/common/mod.rs
write crates/alpha/tests/fixtures/data.json
write crates/alpha/tests/fixtures/café.json
write crates/alpha/benches/bench.rs
write crates/alpha/examples/demo.rs
write crates/beta/Cargo.toml
write crates/beta/build.rs
write crates/beta/src/main.rs
write crates/beta/tests/smoke.rs
write crates/beta/migrations/001.sql
write crates/gamma/Cargo.toml
write crates/gamma/src/lib.rs
write crates/gamma/tests/smoke.rs
write README.md
write docs/guide.md
write scripts/tool.sh
g init -q
g add -A
g commit -q -m base
g update-ref refs/remotes/origin/main HEAD
g checkout -q -b feature

reset_repo() {
  g reset -q --hard refs/remotes/origin/main
  g clean -fdq
  : >"$temp_dir/cargo.log"
  : >"$temp_dir/runner.log"
}

edit() {
  echo "// changed" >>"$repo/$1"
}

commit_all() {
  g add -A
  g commit -q -m "${1:-change}"
}

# Env prefixes on the call (DRY_RUN=1 run_script ...) reach the script; the
# inputs it reads default to unset here so the suite's own environment cannot
# leak into the expected argv. PATH_UNDER_TEST prepends extra stub directories.
run_script() {
  set +e
  PATH="${PATH_UNDER_TEST:+$PATH_UNDER_TEST:}$bin_dir" INTENTD_DIR="${INTENTD_DIR-$repo}" BASE="${BASE-}" \
    BUILD_JOBS="${BUILD_JOBS-}" TEST_THREADS="${TEST_THREADS-}" DRY_RUN="${DRY_RUN-}" \
    NEXTEST_RUNNER="${NEXTEST_RUNNER-}" \
    CARGO_TEST_LOG="$temp_dir/cargo.log" RUNNER_TEST_LOG="$temp_dir/runner.log" \
    "$script_bash" "${SCRIPT_UNDER_TEST:-$script}" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
  cargo_log=$(<"$temp_dir/cargo.log")
  runner_log=$(<"$temp_dir/runner.log")
}

expect_cargo() {
  local expected="" line
  for line in "$@"; do
    expected+="$repo: nextest run $line"$'\n'
  done
  [[ "$cargo_log" == "${expected%$'\n'}" ]] || fail "$case_name: cargo argv was"$'\n'"$cargo_log"$'\n'"expected"$'\n'"${expected%$'\n'}"
}

expect_plan() {
  local line
  for line in "$@"; do
    [[ "$stdout" == *"[test-changed] cargo nextest run $line"* ]] || fail "$case_name: plan is missing '$line':"$'\n'"$stdout"
  done
  [[ "$(grep -c '^\[test-changed\] cargo nextest run ' <<<"$stdout")" -eq $# ]] || fail "$case_name: expected $# plan line(s):"$'\n'"$stdout"
}

expect_ok() {
  [[ "$status" -eq 0 ]] || fail "$case_name: exited $status: $stderr"
  [[ -z "$stderr" ]] || fail "$case_name: unexpected stderr: $stderr"
}


case_name="clean tree"
reset_repo
run_script
expect_ok
[[ "$stdout" == "[test-changed] nothing to test (no Rust changes vs origin/main)" ]] || fail "$case_name printed '$stdout'"
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"

case_name="committed single test file"
reset_repo
edit crates/alpha/tests/one.rs
commit_all
run_script
expect_ok
expect_plan "-p alpha --test one"
expect_cargo "-p alpha --test one"
[[ "$stdout" != *"note:"* ]] || fail "$case_name printed the src note: $stdout"

case_name="unstaged, staged and untracked edits"
reset_repo
edit crates/alpha/tests/one.rs
edit crates/alpha/tests/two.rs
g add crates/alpha/tests/two.rs
write crates/gamma/tests/fresh.rs
run_script
expect_ok
expect_cargo "-p alpha --test one --test two" "-p gamma --test fresh"

case_name="committed change under a feature branch with main moved on"
reset_repo
edit crates/alpha/tests/one.rs
commit_all
g checkout -q --detach refs/remotes/origin/main
edit crates/beta/tests/smoke.rs
commit_all "main moved on"
g update-ref refs/remotes/origin/main HEAD
g checkout -q feature
run_script
expect_ok
expect_cargo "-p alpha --test one"

case_name="shared test helpers select every integration test of the crate"
reset_repo
edit crates/alpha/tests/common/mod.rs
edit crates/alpha/tests/one.rs
run_script
expect_ok
expect_plan "-p alpha --tests"
expect_cargo "-p alpha --tests"

case_name="test fixture selects every integration test of the crate"
reset_repo
edit crates/alpha/tests/fixtures/data.json
run_script
expect_ok
expect_cargo "-p alpha --tests"

# Git C-quotes such names in line-oriented output; the script must read raw
# NUL-delimited paths (verifier repro on 91fb6b0).
case_name="untracked fixture with a space in its name"
reset_repo
write "crates/alpha/tests/fixtures/new fixture.json"
run_script
expect_ok
expect_cargo "-p alpha --tests"

case_name="tracked fixture with a non-ASCII name"
reset_repo
edit crates/alpha/tests/fixtures/café.json
run_script
expect_ok
expect_cargo "-p alpha --tests"

# Both sides of a rename count as changed (rename detection is off), so a
# moved test is a deleted one plus a new one.
case_name="renamed integration test counts the old and new path"
reset_repo
g mv crates/alpha/tests/one.rs crates/alpha/tests/moved.rs
run_script
expect_ok
expect_cargo "-p alpha --tests"

case_name="file moved from src into tests keeps the src selection"
reset_repo
g mv crates/alpha/src/util/mod.rs crates/alpha/tests/old.rs
run_script
expect_ok
expect_plan "-p alpha --lib --bins --tests"
expect_cargo "-p alpha --lib --bins --tests"
[[ "$stdout" == *"note: crates/alpha/src changed"* ]] || fail "$case_name: no src note: $stdout"

case_name="deleted integration test falls back to --tests"
reset_repo
g rm -q crates/alpha/tests/two.rs
run_script
expect_ok
expect_cargo "-p alpha --tests"

case_name="src change selects lib, bins and integration tests with a note"
reset_repo
edit crates/alpha/src/util/mod.rs
edit crates/alpha/tests/one.rs
run_script
expect_ok
expect_plan "-p alpha --lib --bins --tests"
expect_cargo "-p alpha --lib --bins --tests"
[[ "$stdout" == *"[test-changed] note: crates/alpha/src changed; only alpha's own tests run (downstream crates are not selected)"* ]] || fail "$case_name: no src note: $stdout"
[[ "$(grep -c 'note:' <<<"$stdout")" -eq 1 ]] || fail "$case_name: note printed more than once: $stdout"

case_name="src change in a crate without a lib drops --lib"
reset_repo
edit crates/beta/src/main.rs
run_script
expect_ok
expect_cargo "-p beta --bins --tests"

case_name="other crate file selects every test target and subsumes the rest"
reset_repo
edit crates/beta/migrations/001.sql
edit crates/beta/src/main.rs
edit crates/beta/tests/smoke.rs
run_script
expect_ok
expect_plan "-p beta"
expect_cargo "-p beta"
[[ "$stdout" != *"note:"* ]] || fail "$case_name printed the src note for a subsumed selection: $stdout"

case_name="benches, examples and inert non-crate paths are ignored"
reset_repo
edit crates/alpha/benches/bench.rs
edit crates/alpha/examples/demo.rs
edit README.md
edit docs/guide.md
write .github/workflows/x.yml
write LICENSE
write NOTICE
write .gitignore
write deny.toml
write release-plz.toml
write dist-workspace.toml
run_script
expect_ok
[[ "$stdout" == *"nothing to test"* ]] || fail "$case_name printed '$stdout'"
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"

case_name="crates with different selections run separately, identical ones share"
reset_repo
edit crates/alpha/tests/common/mod.rs
write crates/gamma/tests/fixtures/x.json
edit crates/beta/src/main.rs
run_script
expect_ok
expect_plan "-p alpha -p gamma --tests" "-p beta --bins --tests"
expect_cargo "-p alpha -p gamma --tests" "-p beta --bins --tests"

case_name="same-named test files across crates share one invocation"
reset_repo
edit crates/beta/tests/smoke.rs
edit crates/gamma/tests/smoke.rs
run_script
expect_ok
expect_cargo "-p beta -p gamma --test smoke"

case_name="different test files across crates stay separate"
reset_repo
edit crates/alpha/tests/one.rs
edit crates/gamma/tests/smoke.rs
run_script
expect_ok
expect_cargo "-p alpha --test one" "-p gamma --test smoke"

case_name="build-jobs and test-threads are appended"
reset_repo
edit crates/alpha/tests/one.rs
BUILD_JOBS=-2 TEST_THREADS=4 run_script
expect_ok
expect_plan "-p alpha --test one --build-jobs -2 --test-threads 4"
expect_cargo "-p alpha --test one --build-jobs -2 --test-threads 4"
reset_repo
edit crates/alpha/tests/one.rs
run_script --build-jobs 3 --test-threads=num-cpus
expect_ok
expect_cargo "-p alpha --test one --build-jobs 3 --test-threads num-cpus"

case_name="dry run prints the plan without invoking cargo"
reset_repo
edit crates/alpha/tests/one.rs
edit crates/beta/src/main.rs
DRY_RUN=1 run_script
expect_ok
expect_plan "-p alpha --test one" "-p beta --bins --tests"
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
run_script --dry-run
expect_ok
[[ -z "$cargo_log" ]] || fail "$case_name (--dry-run) invoked cargo: $cargo_log"
DRY_RUN=0 run_script
expect_ok
expect_cargo "-p alpha --test one" "-p beta --bins --tests"

case_name="cargo failure stops the run and propagates its exit code"
reset_repo
edit crates/alpha/tests/one.rs
edit crates/beta/src/main.rs
CARGO_STUB_EXIT=100 run_script
[[ "$status" -eq 100 ]] || fail "$case_name exited $status (expected 100): $stderr"
expect_cargo "-p alpha --test one"
[[ "$stderr" == "[test-changed] cargo nextest run -p alpha --test one exited 100" ]] || fail "$case_name stderr: $stderr"

# With a runner the script plans as usual, then hands every plan to one
# runner invocation instead of calling cargo itself.
expect_runner() {
  local expected="call:"$'\n' word
  for word in "$@"; do
    expected+="$word"$'\n'
  done
  [[ "$runner_log" == "${expected%$'\n'}" ]] || fail "$case_name: runner argv was"$'\n'"$runner_log"$'\n'"expected"$'\n'"${expected%$'\n'}"
  [[ -z "$cargo_log" ]] || fail "$case_name invoked cargo alongside the runner: $cargo_log"
}

case_name="runner receives every plan in one invocation"
reset_repo
edit crates/alpha/tests/one.rs
write crates/gamma/tests/fresh.rs
NEXTEST_RUNNER="$bin_dir/runner" BUILD_JOBS=-2 TEST_THREADS=4 run_script
expect_ok
expect_plan "-p alpha --test one --build-jobs -2 --test-threads 4" "-p gamma --test fresh --build-jobs -2 --test-threads 4"
expect_runner --plan "-p alpha --test one" --plan "-p gamma --test fresh" \
  --base origin/main --label test-changed --build-jobs -2 --test-threads 4
[[ "$(grep -c '^call:$' <<<"$runner_log")" -eq 1 ]] || fail "$case_name: runner called more than once: $runner_log"

case_name="runner command line is shell-quoted and gets the explicit BASE"
reset_repo
edit crates/alpha/tests/one.rs
commit_all
g branch -q -f other HEAD
edit crates/gamma/tests/smoke.rs
run_script --base other --runner "'$bin_dir/runner' --cache-dir '/tmp/gate runs'"
expect_ok
expect_runner --cache-dir "/tmp/gate runs" --plan "-p gamma --test smoke" --base other --label test-changed

case_name="runner failure propagates its exit code"
reset_repo
edit crates/alpha/tests/one.rs
NEXTEST_RUNNER="$bin_dir/runner" RUNNER_STUB_EXIT=7 run_script
[[ "$status" -eq 7 ]] || fail "$case_name exited $status (expected 7): $stderr"
[[ -z "$stderr" ]] || fail "$case_name: unexpected stderr: $stderr"
expect_runner --plan "-p alpha --test one" --base origin/main --label test-changed

case_name="runner is not invoked for a dry run, an empty plan or a fallback"
reset_repo
edit crates/alpha/tests/one.rs
NEXTEST_RUNNER="$bin_dir/runner" DRY_RUN=1 run_script
expect_ok
expect_plan "-p alpha --test one"
[[ -z "$runner_log$cargo_log" ]] || fail "$case_name (dry run) invoked: $runner_log$cargo_log"
reset_repo
NEXTEST_RUNNER="$bin_dir/runner" run_script
expect_ok
[[ "$stdout" == *"nothing to test"* ]] || fail "$case_name (empty) printed '$stdout'"
[[ -z "$runner_log$cargo_log" ]] || fail "$case_name (empty) invoked: $runner_log$cargo_log"
reset_repo
edit Cargo.lock
NEXTEST_RUNNER="$bin_dir/runner" run_script
[[ "$status" -eq 3 ]] || fail "$case_name (fallback) exited $status (expected 3): $stderr"
[[ -z "$runner_log$cargo_log" ]] || fail "$case_name (fallback) invoked: $runner_log$cargo_log"

# The Makefile names its paths as "$VAR" references inside the runner string
# (expanded by the script's eval), so apostrophes and spaces in the repo root
# or GATE_CACHE_DIR reach the runner as single words.
case_name="runner string expands quoted env references to whole words"
reset_repo
edit crates/alpha/tests/one.rs
export GATE_REPO_ROOT="/tmp/reviewer's repo" GATE_CACHE_DIR="/tmp/reviewer's gate runs"
NEXTEST_RUNNER='"$RUNNER_BIN" --repo-root "$GATE_REPO_ROOT" --cache-dir "$GATE_CACHE_DIR" --resume "$RESUME"' \
  RUNNER_BIN="$bin_dir/runner" RESUME=1 run_script
unset GATE_REPO_ROOT GATE_CACHE_DIR
expect_ok
expect_runner --repo-root "/tmp/reviewer's repo" --cache-dir "/tmp/reviewer's gate runs" --resume 1 \
  --plan "-p alpha --test one" --base origin/main --label test-changed

# The actual `make test-changed` recipe must hand such paths over intact: a
# copy of the real Makefile runs with a stub planner that evals NEXTEST_RUNNER
# the way the script does and records the words (nested quotes used to make
# the recipe itself fail to parse with exit 2 here). make -n cannot check this:
# the recipe's logical line contains $(MAKE), so -n executes it anyway.
# The Makefile prepends the rustup-pinned cargo dir and CARGO_BIN_DIR (default
# ~/.cargo/bin) to every recipe's PATH, so a host cargo would outrank the stub;
# pointing CARGO_BIN_DIR at the stub dir and blanking RUSTUP_CARGO keeps the
# recipe's `cargo nextest --version` preflight hermetic on any host.
make_bin=$(command -v make 2>/dev/null) || make_bin=""
if [[ -n "$make_bin" ]]; then
  case_name="Makefile test-changed recipe survives an apostrophe in GATE_CACHE_DIR"
  mk="$temp_dir/reviewer's checkout"
  mkdir -p "$mk/scripts" "$mk/packages/intentd/.git"
  cp "$repo_root/Makefile" "$mk/Makefile"
  cat >"$mk/scripts/rust-changed-tests.sh" <<'SH'
#!/usr/bin/env bash
eval "set -- $NEXTEST_RUNNER"
{ echo "call:"; printf '%s\n' "$@"; } >>"$RUNNER_TEST_LOG"
SH
  chmod +x "$mk/scripts/rust-changed-tests.sh"
  : >"$temp_dir/runner.log"
  : >"$temp_dir/cargo.log"
  set +e
  PATH="$bin_dir" RUNNER_TEST_LOG="$temp_dir/runner.log" CARGO_TEST_LOG="$temp_dir/cargo.log" \
    "$make_bin" -C "$mk" --no-print-directory test-changed CARGO_BIN_DIR="$bin_dir" RUSTUP_CARGO= \
    GATE_CACHE_DIR="$mk/gate runs" RESUME=1 \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr" </dev/null
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || fail "$case_name: make exited $status: $(<"$temp_dir/stderr")"
  cargo_log=$(<"$temp_dir/cargo.log")
  [[ "$cargo_log" == *": nextest --version" ]] \
    || fail "$case_name: stub cargo did not serve the preflight; cargo log: '$cargo_log'"
  runner_log=$(<"$temp_dir/runner.log")
  expected="call:"$'\n'"python3"$'\n'"scripts/resumable_nextest.py"$'\n'"--repo-root"$'\n'"$mk"$'\n'"--intentd-dir"$'\n'"packages/intentd"$'\n'"--cache-dir"$'\n'"$mk/gate runs"$'\n'"--resume"$'\n'"1"$'\n'"--force"$'\n'"0"
  [[ "$runner_log" == "$expected" ]] || fail "$case_name: runner argv was"$'\n'"$runner_log"$'\n'"expected"$'\n'"$expected"
fi

# Build-wide files make the subset unreliable: exit 3 names them and defers to
# the full `make test` (the Makefile target turns 3 into that run).
for path in Cargo.toml Cargo.lock rust-toolchain.toml .config/nextest.toml .cargo/config.toml \
  crates/alpha/Cargo.toml crates/beta/build.rs; do
  case_name="build-wide change $path"
  reset_repo
  edit "$path"
  edit crates/alpha/tests/one.rs
  run_script
  [[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
  [[ -z "$stdout" ]] || fail "$case_name printed '$stdout'"
  [[ "$stderr" == *"need the full suite -- run 'make test':"*"  $path"* ]] || fail "$case_name stderr: $stderr"
  [[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
done
# Tests read repo files outside crates/ through CARGO_MANIFEST_DIR
# (scripts/install.sh, repo-wide lints), so any non-inert path out there also
# defers to the full suite, even alongside a precisely mapped test change.
for path in scripts/install.sh scripts/tool.sh packaging/deb/control unknown.toml; do
  case_name="non-crate change $path"
  reset_repo
  write "$path" "// changed"
  edit crates/alpha/tests/one.rs
  run_script
  [[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
  [[ -z "$stdout" ]] || fail "$case_name printed '$stdout'"
  [[ "$stderr" == *"need the full suite -- run 'make test':"*"  $path"* ]] || fail "$case_name stderr: $stderr"
  [[ "$stderr" != *"crates/alpha/tests/one.rs"* ]] || fail "$case_name listed a mapped path: $stderr"
  [[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
done
case_name="untracked build-wide file with a non-ASCII name"
reset_repo
write .cargo/café.toml
run_script
[[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
[[ "$stderr" == *"  .cargo/café.toml"* ]] || fail "$case_name stderr: $stderr"
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
case_name="build-wide change in a dry run"
reset_repo
write .cargo/audit.toml
DRY_RUN=1 run_script
[[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
[[ "$stderr" == *"  .cargo/audit.toml"* ]] || fail "$case_name stderr: $stderr"
for rename in "Cargo.lock Cargo.lock.backup" "crates/beta/build.rs crates/beta/retired.rs"; do
  case_name="renamed build-wide file ($rename) still needs the full suite"
  reset_repo
  # shellcheck disable=SC2086
  g mv $rename
  run_script
  [[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
  [[ -z "$stdout" ]] || fail "$case_name printed '$stdout'"
  [[ "$stderr" == *"  ${rename%% *}"* ]] || fail "$case_name stderr: $stderr"
  [[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
done

# A failing git command is an error, never an empty change set.
for subcommand in diff ls-files; do
  case_name="git $subcommand failure"
  reset_repo
  edit crates/alpha/tests/one.rs
  GIT_STUB_FAIL=$subcommand run_script
  [[ "$status" -eq 2 ]] || fail "$case_name exited $status (expected 2): $stderr"
  [[ -z "$stdout" ]] || fail "$case_name printed '$stdout'"
  [[ "$stderr" == "fatal: stubbed git $subcommand failure"$'\n'"[test-changed] git $subcommand "*" failed in $repo (exit 128)" ]] || fail "$case_name stderr: $stderr"
  [[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
done

case_name="unresolvable BASE"
reset_repo
edit crates/alpha/tests/one.rs
BASE=origin/nope run_script
[[ "$status" -eq 2 ]] || fail "$case_name exited $status (expected 2): $stderr"
[[ -z "$stdout" ]] || fail "$case_name printed '$stdout'"
[[ "$stderr" == "[test-changed] cannot resolve BASE 'origin/nope' in $repo; run 'git -C $repo fetch origin main' or set BASE=<ref>" ]] || fail "$case_name stderr: $stderr"
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"
run_script --base origin/nope
[[ "$status" -eq 2 ]] || fail "$case_name (--base) exited $status (expected 2): $stderr"

case_name="explicit BASE"
reset_repo
edit crates/alpha/tests/one.rs
commit_all
g branch -q -f other HEAD
edit crates/gamma/tests/smoke.rs
commit_all
BASE=other run_script
expect_ok
expect_cargo "-p gamma --test smoke"
run_script --base=other --dry-run
expect_ok
expect_plan "-p gamma --test smoke"

case_name="INTENTD_DIR that is not a checkout"
reset_repo
INTENTD_DIR="$temp_dir/missing" run_script
[[ "$status" -eq 2 ]] || fail "$case_name (missing) exited $status (expected 2): $stderr"
[[ "$stderr" == *"intentd checkout not found at $temp_dir/missing (set INTENTD_DIR)"* ]] || fail "$case_name (missing) stderr: $stderr"
INTENTD_DIR="$bin_dir" run_script
[[ "$status" -eq 2 ]] || fail "$case_name (not git) exited $status (expected 2): $stderr"
[[ "$stderr" == *"$bin_dir is not a git checkout (set INTENTD_DIR)"* ]] || fail "$case_name (not git) stderr: $stderr"

case_name="INTENTD_DIR defaults to packages/intentd next to the script"
reset_repo
edit crates/alpha/tests/one.rs
INTENTD_DIR="" SCRIPT_UNDER_TEST="$temp_dir/scripts/rust-changed-tests.sh" run_script
expect_ok
expect_cargo "-p alpha --test one"
INTENTD_DIR="" run_script --intentd-dir "$repo" --dry-run
expect_ok
expect_plan "-p alpha --test one"

case_name="usage errors"
reset_repo
edit crates/alpha/tests/one.rs
for args in --bogus "--base" "--build-jobs" "--runner" "extra"; do
  # shellcheck disable=SC2086
  run_script $args
  [[ "$status" -eq 2 ]] || fail "$case_name '$args' exited $status (expected 2): $stderr"
  [[ "$stderr" == "Usage: "* ]] || fail "$case_name '$args' stderr: $stderr"
done
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"

# End to end with the real record-writing runner: a fake cargo answers
# `nextest list` with a canned suite listing and `nextest run` with libtest
# `test ok` events for those tests (after checking the --tool-config-file the
# runner wrote exists); rustc/cargo version stubs feed the tree key. The
# fixture monorepo carries packages/intentd as a symlink to $repo so the
# runner's --intentd-dir resolves as the Makefile passes it.
if [[ -z "$python3" ]]; then
  echo "rust-changed-tests tests: python3 not found; record/resume end-to-end cases skipped"
else
  e2e_bin="$temp_dir/e2e-bin"
  mono="$temp_dir/mono"
  cache="$temp_dir/gate runs"
  mkdir -p "$e2e_bin" "$mono/packages"
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

  # $1 = RESUME, $2 = GATE_FORCE; the runner line mirrors the Makefile's.
  e2e_run() {
    PATH_UNDER_TEST="$e2e_bin" BUILD_JOBS=2 TEST_THREADS=1 \
      NEXTEST_RUNNER="python3 '$repo_root/scripts/resumable_nextest.py' --repo-root '$mono' --intentd-dir packages/intentd --cache-dir '$cache' --resume $1 --force $2" \
      run_script
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
  reset_repo
  edit crates/alpha/tests/one.rs
  e2e_run 0 0
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
  : >"$temp_dir/cargo.log"
  e2e_run 1 0
  expect_ok
  [[ "$stdout" == *"[test-changed] cargo nextest run -p alpha --test one"*$'\n'"resumed: skipped 2 tests already passed for this tree" ]] || fail "$case_name: stdout: $stdout"
  [[ "$cargo_log" != *"nextest list"* && "$cargo_log" != *"nextest run"* ]] || fail "$case_name: cargo was invoked: $cargo_log"

  case_name="end to end: RESUME=1 after a tracked edit runs the plan again"
  edit crates/alpha/tests/one.rs
  e2e_run 1 0
  expect_recorded_run
  [[ "$stdout" == *"[test-changed] no passed-test record for this tree; running every planned test"* ]] || fail "$case_name: stdout: $stdout"
  [[ "$record_dir" != "$first_record" ]] || fail "$case_name: the record dir did not change with the tree"
  changed_record=$record_dir

  case_name="end to end: GATE_FORCE=1 ignores the matching record"
  e2e_run 1 1
  expect_recorded_run
  [[ "$stdout" == *"[test-changed] GATE_FORCE=1: running every planned test"* ]] || fail "$case_name: stdout: $stdout"
  [[ "$record_dir" == "$changed_record" ]] || fail "$case_name: record dir moved on an unchanged tree: $record_dir"
fi

echo "rust-changed-tests tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${RUST_CHANGED_TESTS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4706). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as shipped-in.test.sh).
bash -n "$script" || fail "rust-changed-tests.sh does not parse"
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
  RUST_CHANGED_TESTS_TEST_BASH="$bash3" "$bash3" "${BASH_SOURCE[0]}"
else
  echo "rust-changed-tests tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
