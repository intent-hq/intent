#!/usr/bin/env bash

set -euo pipefail

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

for command in bash dirname git sort; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

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
# leak into the expected argv.
run_script() {
  set +e
  PATH="$bin_dir" INTENTD_DIR="${INTENTD_DIR-$repo}" BASE="${BASE-}" \
    BUILD_JOBS="${BUILD_JOBS-}" TEST_THREADS="${TEST_THREADS-}" DRY_RUN="${DRY_RUN-}" \
    CARGO_TEST_LOG="$temp_dir/cargo.log" \
    "$script_bash" "${SCRIPT_UNDER_TEST:-$script}" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
  cargo_log=$(<"$temp_dir/cargo.log")
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

case_name="benches, examples and non-crate paths are ignored"
reset_repo
edit crates/alpha/benches/bench.rs
edit crates/alpha/examples/demo.rs
edit README.md
edit docs/guide.md
edit scripts/tool.sh
write .github/workflows/ci.yml
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
case_name="build-wide change in a dry run"
reset_repo
write .cargo/audit.toml
DRY_RUN=1 run_script
[[ "$status" -eq 3 ]] || fail "$case_name exited $status (expected 3): $stderr"
[[ "$stderr" == *"  .cargo/audit.toml"* ]] || fail "$case_name stderr: $stderr"

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
for args in --bogus "--base" "--build-jobs" "extra"; do
  # shellcheck disable=SC2086
  run_script $args
  [[ "$status" -eq 2 ]] || fail "$case_name '$args' exited $status (expected 2): $stderr"
  [[ "$stderr" == "Usage: "* ]] || fail "$case_name '$args' stderr: $stderr"
done
[[ -z "$cargo_log" ]] || fail "$case_name invoked cargo: $cargo_log"

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
