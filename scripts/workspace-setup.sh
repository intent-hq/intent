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
#   4. install cargo-nextest (prebuilt) and cargo-sweep (cargo install).
# Missing system tools (make, curl, a C compiler) come from apt-get when the
# node has root or passwordless sudo. Steps 3-4 are optional: a failure prints
# a NOTE naming `make bootstrap-dev-host` and setup still succeeds.
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

APT_UPDATED=0
TEMP_FILE=""
trap 'if [ -n "$TEMP_FILE" ]; then rm -f -- "$TEMP_FILE"; fi' EXIT

say() { printf '[setup] %s\n' "$*"; }
note() { printf '[setup] NOTE: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

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
  # shellcheck disable=SC2086
  retry $root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
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
      || ! retry sh "$TEMP_FILE" -y --profile minimal --default-toolchain stable --component clippy --component rustfmt; then
      note "Rust installation failed; run make bootstrap-dev-host"
      return 1
    fi
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
  else
    say "rustup has no working toolchain; installing stable"
    if ! retry rustup default stable || ! retry rustup component add clippy rustfmt; then
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
    cargo install cargo-nextest --locked && return 0
  fi
  note "cargo-nextest could not be installed; run make bootstrap-dev-host"
}

install_sweep() {
  have cargo-sweep && return 0
  if ! have cc; then
    note "cargo-sweep needs a C compiler to build and none is installed; run make bootstrap-dev-host"
    return 0
  fi
  cargo install cargo-sweep --locked || note "cargo-sweep could not be installed; run make bootstrap-dev-host"
}

copy_config_files
install_system_tools
init_submodules || { echo "[setup] ERROR: submodule initialization failed" >&2; exit 1; }
if install_rust; then
  install_nextest
  install_sweep
fi
say "workspace setup complete"
