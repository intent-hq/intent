#!/usr/bin/env bash

set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
INTENTD_DIR="$ROOT_DIR/packages/intentd"
FE_DIR="$ROOT_DIR/packages/cloudlands-fe"
TOOLCHAIN_FILE="$INTENTD_DIR/rust-toolchain.toml"
PACKAGE_FILE="$FE_DIR/package.json"
CARGO_HOME=${CARGO_HOME:-"$HOME/.cargo"}
PATH="$CARGO_HOME/bin:$PATH"
export CARGO_HOME PATH

MODE=install
ASSUME_YES=${BOOTSTRAP_YES:-0}
FAILURES=0
TOOLCHAIN=""
PACKAGE_MANAGER=""
PNPM_VERSION=""
TEMP_FILE=""

cleanup() {
  if [[ -n "$TEMP_FILE" && -f "$TEMP_FILE" ]]; then
    rm -f -- "$TEMP_FILE"
  fi
}
trap cleanup EXIT

usage() {
  echo "Usage: $0 [--check] [--yes]"
  echo "  --check  Report missing requirements without changing the host"
  echo "  --yes    Install without prompting"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

ok() {
  printf '[ok]       %s\n' "$1"
}

missing() {
  printf '[missing]  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

optional() {
  printf '[optional] %s\n' "$1"
}

load_versions() {
  if [[ -f "$TOOLCHAIN_FILE" ]]; then
    TOOLCHAIN=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOOLCHAIN_FILE")
  fi
  if [[ -f "$PACKAGE_FILE" ]]; then
    PACKAGE_MANAGER=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PACKAGE_FILE" | head -n 1)
  fi
  case "$PACKAGE_MANAGER" in
    pnpm@*) PNPM_VERSION=${PACKAGE_MANAGER#pnpm@} ;;
    *) PNPM_VERSION="" ;;
  esac
}

required_submodules_ready() {
  [[ -e "$INTENTD_DIR/.git" && -e "$FE_DIR/.git" ]]
}

rust_toolchain_ready() {
  [[ -n "$TOOLCHAIN" ]] || return 1
  command -v rustup >/dev/null 2>&1 || return 1
  rustup run "$TOOLCHAIN" rustc --version >/dev/null 2>&1 || return 1
  rustup component list --toolchain "$TOOLCHAIN" --installed 2>/dev/null | grep -q '^rustfmt-' || return 1
  rustup component list --toolchain "$TOOLCHAIN" --installed 2>/dev/null | grep -q '^clippy-'
}

active_toolchain_ready() {
  [[ -n "$TOOLCHAIN" ]] || return 1
  command -v rustup >/dev/null 2>&1 || return 1
  [[ $(rustup show active-toolchain 2>/dev/null) == "$TOOLCHAIN"-* ]]
}

node_ready() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 20 ]]
}

pnpm_ready() {
  [[ -n "$PNPM_VERSION" ]] || return 1
  command -v corepack >/dev/null 2>&1 || return 1
  command -v pnpm >/dev/null 2>&1 || return 1
  local actual
  actual=$(cd "$FE_DIR" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version 2>/dev/null) || return 1
  [[ "$actual" == "$PNPM_VERSION" ]]
}

installable_gap_exists() {
  required_submodules_ready || return 0
  load_versions
  command -v rustup >/dev/null 2>&1 || return 0
  command -v cargo >/dev/null 2>&1 || return 0
  rust_toolchain_ready || return 0
  active_toolchain_ready || return 0
  cargo nextest --version >/dev/null 2>&1 || return 0
  node_ready || return 0
  command -v corepack >/dev/null 2>&1 || return 0
  pnpm_ready || return 0
  [[ -d "$FE_DIR/node_modules" ]] || return 0
  return 1
}

check_all() {
  FAILURES=0
  load_versions

  echo "Intent development host doctor"
  echo "Repository: $ROOT_DIR"
  echo

  if required_submodules_ready; then
    ok "git submodules: intentd and cloudlands-fe initialized"
  else
    missing "git submodules: initialize intentd and cloudlands-fe"
  fi

  if [[ -n "$TOOLCHAIN" ]]; then
    ok "Rust pin: $TOOLCHAIN (rustfmt, clippy)"
  else
    missing "Rust pin: cannot read packages/intentd/rust-toolchain.toml"
  fi

  if command -v rustup >/dev/null 2>&1; then
    ok "rustup: $(rustup --version 2>/dev/null | head -n 1)"
  else
    missing "rustup: required to install the pinned Rust toolchain"
  fi

  if command -v cargo >/dev/null 2>&1; then
    ok "cargo: $(cargo --version 2>/dev/null)"
  else
    missing "cargo: installed with rustup"
  fi

  if rust_toolchain_ready; then
    ok "Rust toolchain: $TOOLCHAIN with rustfmt and clippy"
  elif [[ -n "$TOOLCHAIN" ]]; then
    missing "Rust toolchain: $TOOLCHAIN with rustfmt and clippy"
  fi

  if active_toolchain_ready; then
    ok "active Rust toolchain: $TOOLCHAIN"
  elif [[ -n "$TOOLCHAIN" ]]; then
    missing "active Rust toolchain: expected $TOOLCHAIN at the repository root"
  fi

  if command -v cargo >/dev/null 2>&1 && cargo nextest --version >/dev/null 2>&1; then
    ok "cargo-nextest: $(cargo nextest --version 2>/dev/null | head -n 1)"
  else
    missing "cargo-nextest: required by make test"
  fi

  if node_ready; then
    ok "Node: $(node --version) (>= 20)"
  else
    missing "Node: version 20 or newer is required"
  fi

  if command -v corepack >/dev/null 2>&1; then
    ok "Corepack: $(corepack --version 2>/dev/null)"
  else
    missing "Corepack: required to select the frontend pnpm version"
  fi

  if [[ -z "$PACKAGE_MANAGER" ]]; then
    missing "frontend packageManager: cannot read packages/cloudlands-fe/package.json"
  elif pnpm_ready; then
    ok "frontend package manager: $PACKAGE_MANAGER via Corepack"
  else
    missing "frontend package manager: expected $PACKAGE_MANAGER via Corepack"
  fi

  if [[ -d "$FE_DIR/node_modules" ]]; then
    ok "frontend dependencies: packages/cloudlands-fe/node_modules present"
  else
    missing "frontend dependencies: run corepack pnpm install --frozen-lockfile"
  fi

  if command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      ok "GitHub CLI: present and authenticated"
    else
      missing "GitHub CLI: present but not authenticated; run gh auth login"
    fi
  else
    missing "GitHub CLI: gh is required (bootstrap does not install or authenticate it)"
  fi

  if command -v sccache >/dev/null 2>&1; then
    optional "sccache: installed"
  else
    optional "sccache: not installed (build cache only)"
  fi
  if command -v playwright-cli >/dev/null 2>&1; then
    optional "playwright-cli: installed, but not needed on a remote host; screenshots go through the client's embedded browser"
  else
    optional "playwright-cli: not needed on a remote host; screenshots go through the client's embedded browser"
  fi

  echo
  if [[ "$FAILURES" -eq 0 ]]; then
    echo "Doctor passed: this host is ready for intentd + cloudlands-fe development."
    return 0
  fi
  echo "Doctor found $FAILURES required gap(s)."
  return 1
}

as_root() {
  if [[ $(id -u) -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "ERROR: installing Node requires root privileges or Homebrew; sudo is unavailable" >&2
    return 1
  fi
}

install_submodules() {
  if required_submodules_ready; then
    echo "[skip] git submodules already initialized"
    return
  fi
  echo "[install] initializing intentd and cloudlands-fe submodules"
  git -C "$ROOT_DIR" submodule update --init --recursive packages/intentd packages/cloudlands-fe || exit 1
}

install_rust() {
  if ! command -v rustup >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install rustup" >&2; exit 1; }
    echo "[install] rustup and Rust $TOOLCHAIN"
    TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/rustup-init.XXXXXX") || exit 1
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$TEMP_FILE" || exit 1
    sh "$TEMP_FILE" -y --profile minimal --default-toolchain "$TOOLCHAIN" --component rustfmt --component clippy || exit 1
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
    hash -r
  fi

  if ! rust_toolchain_ready; then
    echo "[install] Rust $TOOLCHAIN with rustfmt and clippy"
    rustup toolchain install "$TOOLCHAIN" --profile minimal --component rustfmt --component clippy || exit 1
  else
    echo "[skip] Rust $TOOLCHAIN with rustfmt and clippy already installed"
  fi

  if ! active_toolchain_ready; then
    echo "[install] setting default Rust toolchain to $TOOLCHAIN"
    rustup default "$TOOLCHAIN" || exit 1
  else
    echo "[skip] Rust $TOOLCHAIN already active"
  fi

  if cargo nextest --version >/dev/null 2>&1; then
    echo "[skip] cargo-nextest already installed"
  else
    command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install cargo-nextest" >&2; exit 1; }
    echo "[install] cargo-nextest 0.9 from its official prebuilt archive"
    case "$(uname -s):$(uname -m)" in
      Linux:x86_64) nextest_platform=linux ;;
      Linux:aarch64|Linux:arm64) nextest_platform=linux-arm ;;
      Darwin:*) nextest_platform=mac ;;
      *) echo "ERROR: no cargo-nextest prebuilt archive for $(uname -s) $(uname -m)" >&2; exit 1 ;;
    esac
    TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/cargo-nextest.XXXXXX") || exit 1
    curl -LsSf "https://get.nexte.st/0.9/$nextest_platform" -o "$TEMP_FILE" || exit 1
    mkdir -p "$CARGO_HOME/bin" || exit 1
    tar -xzf "$TEMP_FILE" -C "$CARGO_HOME/bin" || exit 1
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=""
    hash -r
  fi
}

install_node() {
  if node_ready; then
    echo "[skip] Node $(node --version) satisfies >= 20"
    return
  fi

  echo "[install] Node >= 20"
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required to install Node on macOS" >&2; exit 1; }
      brew install node || exit 1
      ;;
    Linux)
      command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install Node" >&2; exit 1; }
      TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/nodesource.XXXXXX") || exit 1
      if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root apt-get install -y nodejs || exit 1
      elif command -v dnf >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root dnf install -y nodejs || exit 1
      elif command -v yum >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root yum install -y nodejs || exit 1
      else
        echo "ERROR: unsupported Linux package manager; install Node >= 20 and re-run" >&2
        exit 1
      fi
      rm -f -- "$TEMP_FILE"
      TEMP_FILE=""
      hash -r
      ;;
    *) echo "ERROR: only Linux and macOS are supported" >&2; exit 1 ;;
  esac
}

install_frontend() {
  if ! command -v corepack >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is required to install Corepack" >&2; exit 1; }
    echo "[install] Corepack"
    npm install --global corepack || as_root npm install --global corepack || exit 1
    hash -r
  fi

  if pnpm_ready; then
    echo "[skip] $PACKAGE_MANAGER already available via Corepack"
  else
    echo "[install] enabling Corepack and $PACKAGE_MANAGER"
    corepack enable || as_root corepack enable || exit 1
    corepack install --global "$PACKAGE_MANAGER" || exit 1
    hash -r
  fi

  if [[ -d "$FE_DIR/node_modules" ]]; then
    echo "[skip] frontend dependencies already installed"
  else
    echo "[install] frontend dependencies"
    (cd "$FE_DIR" && corepack pnpm install --frozen-lockfile) || exit 1
  fi
}

if [[ "$MODE" == check ]]; then
  check_all
  exit $?
fi

if ! installable_gap_exists; then
  echo "All installable development dependencies are already present; nothing to do."
  check_all
  exit $?
fi

if [[ "$ASSUME_YES" != 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: bootstrap needs confirmation; re-run with --yes or BOOTSTRAP_YES=1" >&2
    exit 2
  fi
  printf 'Install missing intentd + cloudlands-fe development dependencies? [y/N] '
  read -r reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Cancelled."; exit 1 ;;
  esac
fi

install_submodules
load_versions
[[ -n "$TOOLCHAIN" ]] || { echo "ERROR: cannot read Rust toolchain pin" >&2; exit 1; }
[[ -n "$PNPM_VERSION" ]] || { echo "ERROR: expected a pnpm packageManager entry" >&2; exit 1; }
install_rust
install_node
install_frontend

echo
check_all