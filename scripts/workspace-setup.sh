#!/usr/bin/env bash
#
# Intent workspace setup for this monorepo (.intent/config.json setupScript).
#
# Must succeed on a fresh node (an E2B sandbox, a minimal Debian image) as well
# as on a configured host, where it is a no-op:
#   1. copy local env files from $MAIN_CHECKOUT;
#   2. initialize the submodules (required: a failure fails setup);
#   3. install rustup (stable, minimal profile + clippy/rustfmt) into HOME when
#      cargo is missing, and put it on PATH;
#   4. install cargo-nextest (prebuilt) and cargo-sweep (cargo install);
#   5. install the Node the ACP callback fixture pins (Linux) under
#      ~/.nvm/versions/node, where scripts/prepare-acp-callback-fixture.py
#      looks for it.
# Missing system tools (make, curl, a C compiler) come from apt-get when the
# node has root or passwordless sudo. Steps 3-5 are optional: a failure prints
# a NOTE naming `make bootstrap-dev-host` and setup still succeeds.
#
# The output is a log (Intent keeps it as setup.log): each step prints a start
# line and "done in Ns", the run ends with its total time, and the installers
# run quietly. Progress bars and colors are off when stdout is not a terminal
# or the run is on an Intent remote machine (a PTY whose output is only
# logged); warnings and errors stay visible.
#
# Tests: scripts/workspace-setup.test.sh (hermetic) and the workspace-setup job
# in .github/workflows/bootstrap-install.yml (real installers, clean container).
# Bash 3.2 compatible: macOS hosts run it with the stock bash.

set -u

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT_DIR="$ROOT_DIR/scripts"
cd "$ROOT_DIR" || exit 1

CARGO_HOME_BIN="${CARGO_HOME:-$HOME/.cargo}/bin"
CARGO_INSTALL_BIN="${CARGO_INSTALL_ROOT:-${CARGO_HOME:-$HOME/.cargo}}/bin"
export PATH="$CARGO_INSTALL_BIN:$CARGO_HOME_BIN:$PATH"

if [ ! -t 1 ] || [ -n "${INTENT_REMOTE_MACHINE:-}" ]; then
  export CARGO_TERM_PROGRESS_WHEN="${CARGO_TERM_PROGRESS_WHEN:-never}"
  export CARGO_TERM_COLOR="${CARGO_TERM_COLOR:-never}"
  export RUSTUP_TERM_PROGRESS_WHEN="${RUSTUP_TERM_PROGRESS_WHEN:-never}"
  export RUSTUP_TERM_COLOR="${RUSTUP_TERM_COLOR:-never}"
fi

APT_UPDATED=0
TEMP_FILE=""
APT_LOG=""
trap 'rm -f -- ${TEMP_FILE:+"$TEMP_FILE"} ${APT_LOG:+"$APT_LOG"}' EXIT

say() { printf '[setup] %s\n' "$*"; }
note() { printf '[setup] NOTE: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# step NAME COMMAND...: runs COMMAND between a start line and a line with its
# elapsed time ($SECONDS: Bash 3.2 has no sub-second clock); keeps its status.
step() {
  local name=$1 start=$SECONDS status
  shift
  say "$name ..."
  "$@"
  status=$?
  if [ "$status" = 0 ]; then
    say "$name done in $((SECONDS - start))s"
  else
    say "$name failed after $((SECONDS - start))s"
  fi
  return "$status"
}

retry() { bash "$SCRIPT_DIR/retry.sh" -- "$@"; }

# root_prefix: prints "" as root, "sudo -n" with passwordless sudo, fails otherwise.
root_prefix() {
  [ "$(id -u)" = 0 ] && return 0
  have sudo && sudo -n true >/dev/null 2>&1 && echo "sudo -n"
}

# apt_install PACKAGE...: best effort; fails when the node has no apt-get or
# no root access.
apt_install() {
  local root
  have apt-get || return 1
  root=$(root_prefix) || return 1
  # shellcheck disable=SC2086 # root is empty or "sudo -n"
  if [ "$APT_UPDATED" = 0 ]; then
    retry $root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 1
    APT_UPDATED=1
  fi
  say "installing $* with apt-get"
  # dpkg prints a line per unpacked file and database percentage on stdout;
  # keep it only to show on failure. Warnings and errors go to stderr.
  APT_LOG=$(mktemp "${TMPDIR:-/tmp}/apt-get.XXXXXX") || return 1
  # shellcheck disable=SC2086
  if ! retry $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o Dpkg::Use-Pty=0 --no-install-recommends "$@" >"$APT_LOG"; then
    cat -- "$APT_LOG"
    rm -f -- "$APT_LOG"
    APT_LOG=""
    return 1
  fi
  rm -f -- "$APT_LOG"
  APT_LOG=""
}

copy_config_files() {
  local file
  [ -n "${MAIN_CHECKOUT:-}" ] || return 0
  for file in .env .env.local .envrc .tool-versions; do
    if [ -f "$MAIN_CHECKOUT/$file" ]; then
      cp "$MAIN_CHECKOUT/$file" "./$file" && say "copied $file"
    fi
  done
}

install_system_tools() {
  local packages=""
  have make || packages="$packages make"
  have curl || packages="$packages curl ca-certificates"
  have cc || packages="$packages build-essential"
  [ -n "$packages" ] || return 0
  # shellcheck disable=SC2086 # word-split the package list
  apt_install $packages || note "could not install$packages (no apt-get or no root access); dependent steps fall back or are skipped"
  hash -r
}

init_submodules() {
  if have make; then
    make ensure-submodules || return 1
  else
    say "make is unavailable; initializing the required submodules with git"
    git submodule update --init --recursive packages/intentd packages/cloudlands-fe || return 1
  fi
}

install_rust() {
  if have cargo && cargo --version >/dev/null 2>&1; then
    return 0
  fi
  if ! have rustup; then
    if ! have curl; then
      note "Rust is not installed and curl is unavailable to fetch rustup; run make bootstrap-dev-host"
      return 1
    fi
    say "installing rustup and stable Rust into ${CARGO_HOME:-$HOME/.cargo}"
    TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/rustup-init.XXXXXX") || return 1
    if ! retry curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$TEMP_FILE" \
      || ! retry sh "$TEMP_FILE" -y --profile minimal --default-toolchain stable --component clippy --component rustfmt --quiet; then
      note "Rust installation failed; run make bootstrap-dev-host"
      return 1
    fi
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
  else
    say "rustup has no working toolchain; installing stable"
    if ! retry rustup --quiet default stable || ! retry rustup --quiet component add clippy rustfmt; then
      note "Rust toolchain installation failed; run make bootstrap-dev-host"
      return 1
    fi
  fi
  hash -r
  have cargo || { note "Rust installed but cargo is not on PATH; run make bootstrap-dev-host"; return 1; }
}

install_nextest() {
  local platform
  have cargo-nextest && return 0
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) platform=linux ;;
    Linux:aarch64|Linux:arm64) platform=linux-arm ;;
    Darwin:*) platform=mac ;;
    *) platform="" ;;
  esac
  if [ -n "$platform" ] && have curl; then
    say "installing cargo-nextest from its prebuilt archive"
    TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/cargo-nextest.XXXXXX") || return 1
    if retry curl --proto '=https' --tlsv1.2 -LsSf "https://get.nexte.st/0.9/$platform" -o "$TEMP_FILE" \
      && mkdir -p "$CARGO_HOME_BIN" && tar -xzf "$TEMP_FILE" -C "$CARGO_HOME_BIN"; then
      rm -f -- "$TEMP_FILE"
      TEMP_FILE=""
      hash -r
      return 0
    fi
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
  fi
  if have cc; then
    cargo install cargo-nextest --locked --quiet && return 0
  fi
  note "cargo-nextest could not be installed; run make bootstrap-dev-host"
}

install_sweep() {
  have cargo-sweep && return 0
  if ! have cc; then
    note "cargo-sweep needs a C compiler to build and none is installed; run make bootstrap-dev-host"
    return 0
  fi
  cargo install cargo-sweep --locked --quiet || note "cargo-sweep could not be installed; run make bootstrap-dev-host"
}

# The Node the callback fixture descriptor pins, e.g. 24.21.0; empty when the
# descriptor is missing.
pinned_node_version() {
  sed -n 's/.*"node_version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' \
    "$ROOT_DIR/packages/intentd/scripts/claude-callback-runtime.json" 2>/dev/null | head -n 1
}

install_pinned_node() {
  local version arch name dir sums
  [ "$(uname -s)" = Linux ] || return 0
  version=$(pinned_node_version)
  [ -n "$version" ] || return 0
  dir="${NVM_DIR:-$HOME/.nvm}/versions/node/v$version"
  [ -x "$dir/bin/node" ] && return 0
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) note "no prebuilt Node $version for $(uname -m); install it for the test gates"; return 0 ;;
  esac
  have curl && have tar || { note "Node $version needs curl and tar; install it for the test gates"; return 0; }
  name="node-v$version-linux-$arch"
  say "installing Node $version into $dir"
  TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/node.XXXXXX") || return 1
  sums=$(mktemp "${TMPDIR:-/tmp}/node-sums.XXXXXX") || return 1
  if retry curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v$version/$name.tar.gz" -o "$TEMP_FILE" \
    && retry curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$sums" \
    && node_checksum_matches "$TEMP_FILE" "$sums" "$name.tar.gz" \
    && mkdir -p "$dir" && tar -xzf "$TEMP_FILE" -C "$dir" --strip-components=1; then
    rm -f -- "$TEMP_FILE" "$sums"
    TEMP_FILE=""
    say "Node $version is under $dir/bin; put it first on PATH for the test gates"
    return 0
  fi
  rm -rf -- "$TEMP_FILE" "$sums" "$dir"
  TEMP_FILE=""
  note "Node $version could not be installed; the test gates need it (see CONTRIBUTING.md#linux-x64-callback-gates)"
}

# node_checksum_matches FILE SUMS NAME: FILE's sha256 is NAME's line in SUMS.
node_checksum_matches() {
  local expected actual
  expected=$(sed -n "s/^\([0-9a-f]\{64\}\)  $3\$/\1/p" "$2" | head -n 1)
  [ -n "$expected" ] || return 1
  if have sha256sum; then
    actual=$(sha256sum "$1" | cut -d' ' -f1)
  elif have shasum; then
    actual=$(shasum -a 256 "$1" | cut -d' ' -f1)
  else
    return 1
  fi
  [ "$actual" = "$expected" ]
}

step "env files" copy_config_files
step "system tools" install_system_tools
step "submodules" init_submodules || { echo "[setup] ERROR: submodule initialization failed" >&2; exit 1; }
if step "rust toolchain" install_rust; then
  step "cargo-nextest" install_nextest
  step "cargo-sweep" install_sweep
fi
step "pinned node" install_pinned_node
say "workspace setup complete in ${SECONDS}s"
