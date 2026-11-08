#!/usr/bin/env bash
#
# Hermetic suite for scripts/workspace-setup.sh (the .intent/config.json
# setupScript). Every network, package-manager and cargo call is a stub on a
# minimal PATH, so this proves the branching: a host with Rust is left alone,
# a fresh node gets rustup + the cargo tools, and a node that cannot install
# them still finishes setup with a clear note. The real installers run in the
# workspace-setup job of .github/workflows/bootstrap-install.yml.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/workspace-setup.sh"
# The interpreter setup runs under; the Bash 3.2 rerun at the end sets it.
setup_bash="${WORKSPACE_SETUP_TEST_BASH:-$(command -v bash)}"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
output="$temp_dir/setup.out"
log="$temp_dir/calls.log"

fail() {
  echo "workspace-setup test failed: $*" >&2
  if [[ -f "$output" ]]; then
    echo "--- setup output ---" >&2
    cat "$output" >&2
  fi
  if [[ -f "$log" ]]; then
    echo "--- recorded calls ---" >&2
    cat "$log" >&2
  fi
  exit 1
}

bash -n "$script" || fail "script does not parse"

# The config must delegate to the script, so the job that runs the real
# setupScript exercises this file.
grep -q 'scripts/workspace-setup.sh' "$repo_root/.intent/config.json" \
  || fail ".intent/config.json setupScript does not run scripts/workspace-setup.sh"

# A stub prebuilt cargo-nextest archive, served by the curl stub.
nextest_src="$temp_dir/nextest-src"
mkdir -p "$nextest_src"
printf '#!/usr/bin/env bash\necho "cargo-nextest $*" >>"$CALL_LOG"\n' >"$nextest_src/cargo-nextest"
chmod +x "$nextest_src/cargo-nextest"
tar -czf "$temp_dir/nextest.tar.gz" -C "$nextest_src" cargo-nextest

# reset_case: a fresh fixture repo, HOME and PATH holding only base tools.
reset_case() {
  case_dir="$temp_dir/case"
  rm -rf "$case_dir"
  fixture="$case_dir/repo"
  bin_dir="$case_dir/bin"
  home="$case_dir/home"
  main_checkout="$case_dir/main"
  mkdir -p "$fixture/scripts" "$bin_dir" "$home" "$main_checkout"
  cp "$script" "$repo_root/scripts/retry.sh" "$fixture/scripts/"
  ln -s "$setup_bash" "$bin_dir/bash"
  for command in sh cat chmod cp dirname env grep mkdir mktemp mv rm sed tar gzip uname; do
    ln -s "$(command -v "$command")" "$bin_dir/$command"
  done
  : >"$log"
  : >"$output"
}

stub() {
  rm -f "$bin_dir/$1"
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$bin_dir/$1"
  chmod +x "$bin_dir/$1"
}

# Stubs that record every call; cargo install drops a binary like the real one.
stub_make() { stub make 'echo "make $*" >>"$CALL_LOG"'; }
stub_git() { stub git 'echo "git $*" >>"$CALL_LOG"'; }
cargo_stub_body='echo "cargo $*" >>"$CALL_LOG"
if [ "$1" = install ]; then
  root="${CARGO_INSTALL_ROOT:-${CARGO_HOME:-$HOME/.cargo}}/bin"; mkdir -p "$root"
  printf "#!/usr/bin/env bash\nexit 0\n" >"$root/$2"; chmod +x "$root/$2"
fi'
stub_rust() {
  stub cargo "$cargo_stub_body"
  stub rustup 'echo "rustup $*" >>"$CALL_LOG"'
  stub rustc 'exit 0'
}
stub_cc() { stub cc 'exit 0'; }
# curl -o FILE URL in any order: the rustup installer writes cargo/rustup
# stubs into CARGO_HOME/bin, nexte.st serves the archive above.
stub_curl() {
  stub curl "out=''; url=''
while [ \$# -gt 0 ]; do
  case \"\$1\" in -o) out=\$2; shift 2 ;; http*) url=\$1; shift ;; *) shift ;; esac
done
echo \"curl \$url\" >>\"\$CALL_LOG\"
case \"\$url\" in
  https://sh.rustup.rs)
    cat >\"\$out\" <<'INSTALLER'
echo \"rustup-init \$*\" >>\"\$CALL_LOG\"
bin=\"\${CARGO_HOME:-\$HOME/.cargo}/bin\"; mkdir -p \"\$bin\"
cp \"\$STUB_CARGO\" \"\$bin/cargo\"
printf '#!/usr/bin/env bash\necho \"rustup \$*\" >>\"\$CALL_LOG\"\n' >\"\$bin/rustup\"
chmod +x \"\$bin/cargo\" \"\$bin/rustup\"
INSTALLER
    ;;
  https://get.nexte.st/*) cp \"$temp_dir/nextest.tar.gz\" \"\$out\" ;;
  *) exit 22 ;;
esac"
}
# sudo -n succeeds and runs the command; apt-get installs nothing but records.
stub_root_apt() {
  stub sudo '[ "$1" = -n ] && shift; [ "$1" = true ] && exit 0; exec "$@"'
  stub apt-get 'echo "apt-get $*" >>"$CALL_LOG"'
}

printf '#!/usr/bin/env bash\n%s\n' "$cargo_stub_body" >"$temp_dir/stub-cargo"
chmod +x "$temp_dir/stub-cargo"

run_setup() {
  set +e
  env -i PATH="$bin_dir" HOME="$home" TMPDIR="$case_dir" CALL_LOG="$log" \
    STUB_CARGO="$temp_dir/stub-cargo" RETRY_DELAY=0 MAIN_CHECKOUT="$main_checkout" \
    FAKE_UID="${FAKE_UID:-1000}" \
    "$setup_bash" "$fixture/scripts/workspace-setup.sh" >"$output" 2>&1
  status=$?
  set -e
}

# id reports a non-root user unless a case opts in.
stub_id() { stub id '[ "$1" = -u ] && { echo "$FAKE_UID"; exit 0; }; exit 1'; }

assert_status() { [[ "$status" -eq "$1" ]] || fail "$2: expected exit $1, got $status"; }
assert_called() { grep -qF -- "$1" "$log" || fail "$2: expected call '$1'"; }
assert_not_called() { if grep -qF -- "$1" "$log"; then fail "$2: unexpected call '$1'"; fi; }
assert_output() { grep -qF -- "$1" "$output" || fail "$2: expected output '$1'"; }

# 1. A host that already has Rust and the cargo tools: no installer runs.
reset_case
stub_id; stub_make; stub_git; stub_rust; stub_cc; stub_curl
stub cargo-nextest 'exit 0'
stub cargo-sweep 'exit 0'
printf 'X=1\n' >"$main_checkout/.env"
run_setup
assert_status 0 "ready host"
assert_called "make ensure-submodules" "ready host"
assert_not_called "curl" "ready host"
assert_not_called "cargo install" "ready host"
assert_not_called "rustup-init" "ready host"
[[ -f "$fixture/.env" ]] || fail "ready host: .env was not copied from MAIN_CHECKOUT"

# 2. A fresh node without Rust (the exit-127 regression): rustup is installed
#    into HOME with clippy + rustfmt, cargo is on PATH for the rest of the run,
#    cargo-nextest comes from its prebuilt archive and cargo-sweep from cargo.
reset_case
stub_id; stub_make; stub_git; stub_cc; stub_curl
run_setup
assert_status 0 "fresh node"
assert_called "curl https://sh.rustup.rs" "fresh node"
assert_called "rustup-init -y --profile minimal --default-toolchain stable --component clippy --component rustfmt" "fresh node"
assert_called "curl https://get.nexte.st/" "fresh node"
assert_called "cargo install cargo-sweep --locked" "fresh node"
assert_not_called "cargo install cargo-nextest" "fresh node"
[[ -x "$home/.cargo/bin/cargo-nextest" ]] || fail "fresh node: cargo-nextest not unpacked into ~/.cargo/bin"
[[ -x "$home/.cargo/bin/cargo-sweep" ]] || fail "fresh node: cargo-sweep not installed into ~/.cargo/bin"

# 2b. A second run on that node is a no-op.
: >"$log"
run_setup
assert_status 0 "fresh node rerun"
assert_not_called "curl" "fresh node rerun"
assert_not_called "cargo install" "fresh node rerun"

# 3. A minimal node with root: missing make, curl and a C compiler come from
#    apt (one update, non-interactive), then setup proceeds through make.
reset_case
stub_id; stub_git; stub_root_apt
stub apt-get 'echo "apt-get $*" >>"$CALL_LOG"
case " $* " in *" install "*)
  d=$(dirname "$0")
  for p in "$@"; do case "$p" in
    make) printf "#!/usr/bin/env bash\necho \"make \$*\" >>\"\$CALL_LOG\"\n" >"$d/make"; chmod +x "$d/make" ;;
    curl) cp "$d/curl.real" "$d/curl" ;;
    build-essential) printf "#!/usr/bin/env bash\nexit 0\n" >"$d/cc"; chmod +x "$d/cc" ;;
  esac; done ;;
esac'
stub_curl; mv "$bin_dir/curl" "$bin_dir/curl.real"
run_setup
assert_status 0 "minimal root node"
assert_called "apt-get update" "minimal root node"
assert_called "apt-get install -y" "minimal root node"
for package in make curl ca-certificates build-essential; do
  grep -E "apt-get install .* $package( |$)" "$log" >/dev/null || fail "minimal root node: $package not installed via apt"
done
[[ $(grep -c "apt-get update" "$log") -eq 1 ]] || fail "minimal root node: apt-get update ran more than once"
assert_called "make ensure-submodules" "minimal root node"
assert_called "rustup-init" "minimal root node"
assert_called "cargo install cargo-sweep --locked" "minimal root node"

# 4. No root, no curl, no make, no cc: required submodules still initialize
#    through git, Rust is skipped with a clear note, and setup succeeds.
reset_case
stub_id; stub_git
run_setup
assert_status 0 "locked-down node"
assert_called "git submodule update --init --recursive packages/intentd packages/cloudlands-fe" "locked-down node"
assert_output "NOTE: Rust" "locked-down node"
assert_output "make bootstrap-dev-host" "locked-down node"
assert_not_called "cargo" "locked-down node"

# 5. Rust present but no C compiler: cargo-sweep (a source build) is skipped
#    with a note instead of failing setup.
reset_case
stub_id; stub_make; stub_git; stub_rust; stub_curl
stub cargo-nextest 'exit 0'
run_setup
assert_status 0 "no compiler"
assert_not_called "cargo install cargo-sweep" "no compiler"
assert_output "NOTE: cargo-sweep" "no compiler"

# 6. A failed rustup download is a note, not a setup failure.
reset_case
stub_id; stub_make; stub_git; stub_cc
stub curl 'echo "curl $*" >>"$CALL_LOG"; exit 22'
run_setup
assert_status 0 "rustup download failure"
assert_output "NOTE: Rust" "rustup download failure"

# 7. Submodule initialization is required: its failure fails setup.
reset_case
stub_id; stub_git; stub_rust; stub_cc; stub_curl
stub make 'echo "make $*" >>"$CALL_LOG"; exit 2'
run_setup
assert_status 1 "submodule failure"
assert_not_called "cargo install" "submodule failure"

# 8. rustup without a working toolchain (a host restored from an image):
#    setup selects stable and adds clippy + rustfmt instead of reinstalling.
reset_case
stub_id; stub_make; stub_git; stub_cc; stub_curl
stub rustup 'echo "rustup $*" >>"$CALL_LOG"'
stub cargo 'echo "cargo $*" >>"$CALL_LOG"; exit 1'
stub cargo-nextest 'exit 0'
stub cargo-sweep 'exit 0'
run_setup
assert_status 0 "rustup without toolchain"
assert_called "rustup default stable" "rustup without toolchain"
assert_called "rustup component add clippy rustfmt" "rustup without toolchain"
assert_not_called "rustup-init" "rustup without toolchain"

echo "workspace-setup tests passed under $("$setup_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${WORKSPACE_SETUP_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 and runs the setupScript there, so rerun the
# cases under a real Bash 3 when one can be found; REQUIRE_BASH3 (CI) makes a
# missing one a failure.
# shellcheck source=scripts/find-bash3.sh
source "$repo_root/scripts/find-bash3.sh"
if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  :
elif bash3=$(find_bash3); then
  WORKSPACE_SETUP_TEST_BASH="$bash3" bash "${BASH_SOURCE[0]}"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set ($(bash3_missing_hint))"
else
  echo "workspace-setup tests: no Bash 3 interpreter found ($(bash3_missing_hint)); real 3.2 run skipped"
fi
