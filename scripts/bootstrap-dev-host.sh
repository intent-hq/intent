#!/usr/bin/env bash

set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
INTENTD_DIR=${INTENTD_DIR:-"$ROOT_DIR/packages/intentd"}
FE_DIR=${FE_DIR:-"$ROOT_DIR/packages/cloudlands-fe"}
TOOLCHAIN_FILE="$INTENTD_DIR/rust-toolchain.toml"
PACKAGE_FILE="$FE_DIR/package.json"
CARGO_HOME=${CARGO_HOME:-"$HOME/.cargo"}
PATH="$CARGO_HOME/bin:$PATH"
export CARGO_HOME PATH

# Minimum GitHub CLI: `gh issue create --type` and a `gh pr edit` that survives
# the projectCards API deprecation both need this release or newer.
GH_MIN_VERSION="2.94.0"
GH_INSTALL_URL="https://github.com/cli/cli#installation"

# jq: the release-notifier test suites parse GitHub API fixtures with it
# (intentd scripts/test-notify-fixed-issues.sh via make test, cloudlands-fe pnpm test:unit).
JQ_INSTALL_URL="https://jqlang.github.io/jq/download/"

# Minimum Node: the frontend install builds node-pty (and cpu-features) with
# node-gyp 13, whose engines.node is "^22.22.2 || ^24.15.0 || >=26.0.0"; its undici
# dependency throws on Node 20 (intent-hq/intent#4669). fe CI runs Node 24.
NODE_REQUIREMENT="22.22.2+, 24.15.0+ (recommended) or 26+"
NODE_INSTALL_MAJOR=24

# Corepack/pnpm launcher probes run under this bound (seconds) so a launcher that
# re-invokes itself or stalls fails with a diagnosis instead of hanging the doctor
# (intent-hq/intent#4635).
PROBE_TIMEOUT=${BOOTSTRAP_PROBE_TIMEOUT:-20}
PROBE_OUTPUT=""
PROBE_ERROR=""

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

node_version() {
  command -v node >/dev/null 2>&1 || return 1
  local line
  line=$(node --version 2>/dev/null) || return 1
  [[ "$line" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+) ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

node_version_supported() {
  case "${1%%.*}" in
    22) version_ge "$1" "22.22.2" ;;
    24) version_ge "$1" "24.15.0" ;;
    *) [[ "${1%%.*}" -ge 26 ]] ;;
  esac
}

node_ready() {
  local version
  version=$(node_version) || return 1
  node_version_supported "$version"
}

python_ready() {
  command -v python3 >/dev/null 2>&1
}

kill_process_tree() {
  local pid=$1 child
  kill -STOP "$pid" 2>/dev/null
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_process_tree "$child"
  done
  kill -KILL "$pid" 2>/dev/null
}

# run_bounded <seconds> <dir> <command...>: runs the command in <dir> with stdin
# closed, leaves its combined output in PROBE_OUTPUT and returns its status, or
# 124 after killing its whole process tree once <seconds> have elapsed.
run_bounded() {
  local seconds=$1 dir=$2 output marker pid watchdog status
  shift 2
  output=$(mktemp "${TMPDIR:-/tmp}/bootstrap-probe.XXXXXX") || return 1
  marker="$output.timeout"
  (cd "$dir" && exec "$@") </dev/null >"$output" 2>&1 &
  pid=$!
  (
    trap - EXIT
    sleeper=""
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    sleep "$seconds" &
    sleeper=$!
    wait "$sleeper"
    : >"$marker"
    kill_process_tree "$pid"
  ) </dev/null >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null
  status=$?
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  PROBE_OUTPUT=$(cat "$output" 2>/dev/null)
  [[ -e "$marker" ]] && status=124
  rm -f -- "$output" "$marker"
  return "$status"
}

# launcher_probe <dir> <launcher> <args...>: runs a package-manager launcher under
# PROBE_TIMEOUT. On success PROBE_OUTPUT holds its first output line; otherwise
# PROBE_ERROR names the launcher path and what went wrong.
launcher_probe() {
  local dir=$1 launcher=$2 path status
  shift 2
  PROBE_OUTPUT=""
  PROBE_ERROR=""
  path=$(command -v "$launcher" 2>/dev/null) || { PROBE_ERROR="$launcher is not on PATH"; return 1; }
  run_bounded "$PROBE_TIMEOUT" "$dir" "$@"
  status=$?
  case "$status" in
    0)
      PROBE_OUTPUT=$(printf '%s\n' "$PROBE_OUTPUT" | head -n 1)
      return 0
      ;;
    124)
      PROBE_ERROR="'$*' did not finish within ${PROBE_TIMEOUT}s: the launcher $path re-invokes itself or stalls. Inspect that file (a valid launcher execs Corepack's dist/corepack.js, never itself), restore it or reinstall Node, then re-run"
      return 1
      ;;
    *)
      PROBE_ERROR="'$*' failed with exit $status via $path: $(printf '%s\n' "$PROBE_OUTPUT" | head -n 1)"
      return 1
      ;;
  esac
}

host_platform() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) uname -s | tr '[:upper:]' '[:lower:]' ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    arm64|aarch64) echo arm64 ;;
    *) uname -m ;;
  esac
}

# node-pty's loader (lib/utils.js) tries build/Release, build/Debug, then the
# prebuild for this platform and architecture; node-pty is a Node-API addon, so
# the same binary serves Node and Electron. An interrupted or script-less
# install leaves node_modules without any of them.
node_pty_binary() {
  local dir="$FE_DIR/node_modules/node-pty" candidate
  for candidate in \
    "$dir/build/Release/pty.node" \
    "$dir/build/Debug/pty.node" \
    "$dir/prebuilds/$(host_platform)-$(host_arch)/pty.node"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# node_pty_loadable: the binary node-pty would pick must actually load on this
# host. build/Release and build/Debug are not platform-specific paths, so a tree
# copied from another machine (or a truncated build output) passes the file
# check but fails dlopen at runtime. Loads it with node under PROBE_TIMEOUT;
# on failure PROBE_ERROR says why.
node_pty_loadable() {
  local binary relative status reason
  PROBE_ERROR=""
  binary=$(node_pty_binary) || { PROBE_ERROR="node-pty has no pty.node for $(host_platform)-$(host_arch)"; return 1; }
  relative=${binary#"$FE_DIR/node_modules/"}
  command -v node >/dev/null 2>&1 || { PROBE_ERROR="node is not on PATH, so $relative cannot be load-tested"; return 1; }
  run_bounded "$PROBE_TIMEOUT" "$FE_DIR" node -e 'require(process.argv[1])' "$binary"
  status=$?
  case "$status" in
    0) return 0 ;;
    124) PROBE_ERROR="loading $relative with node did not finish within ${PROBE_TIMEOUT}s" ;;
    *)
      reason=$(printf '%s\n' "$PROBE_OUTPUT" | grep '^Error: ' | head -n 1 | sed 's/^Error: //')
      [[ -n "$reason" ]] || reason=$(printf '%s\n' "$PROBE_OUTPUT" | grep -v '^$' | head -n 1)
      reason=${reason#"$binary: "}
      PROBE_ERROR="node cannot load $relative (exit $status${reason:+: $reason})"
      ;;
  esac
  return 1
}

frontend_dependencies_ready() {
  [[ -d "$FE_DIR/node_modules" ]] && node_pty_loadable
}

corepack_home() {
  if [[ -n ${COREPACK_HOME:-} ]]; then
    printf '%s\n' "$COREPACK_HOME"
  elif [[ -n ${XDG_CACHE_HOME:-} ]]; then
    printf '%s/node/corepack\n' "$XDG_CACHE_HOME"
  elif [[ -n ${LOCALAPPDATA:-} ]]; then
    printf '%s/node/corepack\n' "$LOCALAPPDATA"
  else
    printf '%s/.cache/node/corepack\n' "$HOME"
  fi
}

pnpm_ready() {
  [[ -n "$PNPM_VERSION" ]] || return 1
  command -v corepack >/dev/null 2>&1 || return 1
  command -v pnpm >/dev/null 2>&1 || return 1
  if [[ "$MODE" == check ]]; then
    local metadata
    for metadata in "$(corepack_home)"/v*/pnpm/"$PNPM_VERSION"/.corepack; do
      [[ -f "$metadata" ]] && return 0
    done
    return 1
  fi
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 launcher_probe "$FE_DIR" pnpm pnpm --version || return 1
  [[ "$PROBE_OUTPUT" == "$PNPM_VERSION" ]]
}

openssl_dev_ready() {
  command -v pkg-config >/dev/null 2>&1 && pkg-config --exists openssl
}

gh_version() {
  command -v gh >/dev/null 2>&1 || return 1
  local line
  line=$(gh --version 2>/dev/null | head -n 1)
  [[ "$line" =~ ^gh\ version\ ([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?) ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

version_ge() {
  local IFS=.
  local -a have want
  read -r -a have <<<"$1"
  read -r -a want <<<"$2"
  local i
  for i in 0 1 2; do
    if (( 10#${have[i]:-0} > 10#${want[i]:-0} )); then return 0; fi
    if (( 10#${have[i]:-0} < 10#${want[i]:-0} )); then return 1; fi
  done
  return 0
}

gh_ready() {
  local version base
  version=$(gh_version) || return 1
  base=${version%%-*}
  version_ge "$base" "$GH_MIN_VERSION" || return 1
  # A prerelease sorts below its stable release: 2.94.0-rc.1 is still short of 2.94.0.
  [[ "$version" == "$base" || "$base" != "$GH_MIN_VERSION" ]]
}

jq_version() {
  command -v jq >/dev/null 2>&1 || return 1
  local output
  output=$(jq --version 2>/dev/null) || return 1
  printf '%s\n' "${output%%$'\n'*}"
}

# A jq pathname on PATH is not enough: a broken or stale shim passes command -v
# but cannot run, so require jq --version to succeed.
jq_ready() {
  jq_version >/dev/null
}

installable_gap_exists() {
  required_submodules_ready || return 0
  load_versions
  command -v rustup >/dev/null 2>&1 || return 0
  command -v cargo >/dev/null 2>&1 || return 0
  python_ready || return 0
  openssl_dev_ready || return 0
  rust_toolchain_ready || return 0
  active_toolchain_ready || return 0
  cargo nextest --version >/dev/null 2>&1 || return 0
  node_ready || return 0
  command -v corepack >/dev/null 2>&1 || return 0
  pnpm_ready || return 0
  frontend_dependencies_ready || return 0
  gh_ready || return 0
  jq_ready || return 0
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

  if python_ready; then
    ok "Python: $(python3 --version 2>&1)"
  else
    missing "Python 3: required to preflight development ports"
  fi

  if openssl_dev_ready; then
    ok "pkg-config + OpenSSL development headers"
  else
    missing "pkg-config + OpenSSL development headers: Debian/Ubuntu run sudo apt-get install -y libssl-dev pkg-config"
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

  local node_found
  if node_ready; then
    ok "Node: v$(node_version) (supported: $NODE_REQUIREMENT)"
  elif node_found=$(node_version); then
    missing "Node: v$node_found is unsupported; the frontend native build (node-gyp 13) needs Node $NODE_REQUIREMENT"
  else
    missing "Node: $NODE_REQUIREMENT is required (node-gyp 13 builds the frontend native modules)"
  fi

  if ! command -v corepack >/dev/null 2>&1; then
    missing "Corepack: required to select the frontend pnpm version"
  elif launcher_probe "$ROOT_DIR" corepack corepack --version; then
    ok "Corepack: $PROBE_OUTPUT"
  else
    missing "Corepack: $PROBE_ERROR"
  fi

  if [[ -z "$PACKAGE_MANAGER" ]]; then
    missing "frontend packageManager: cannot read packages/cloudlands-fe/package.json"
  elif pnpm_ready; then
    ok "frontend package manager: $PACKAGE_MANAGER via Corepack"
  else
    missing "frontend package manager: expected $PACKAGE_MANAGER via Corepack"
  fi

  if [[ ! -d "$FE_DIR/node_modules" ]]; then
    missing "frontend dependencies: run corepack pnpm install --frozen-lockfile in packages/cloudlands-fe"
  elif ! node_pty_binary >/dev/null; then
    missing "frontend dependencies: node-pty has no pty.node for $(host_platform)-$(host_arch) under packages/cloudlands-fe/node_modules (interrupted or script-less install); run corepack pnpm install --frozen-lockfile, then corepack pnpm rebuild node-pty if it is still missing"
  elif node_pty_loadable; then
    ok "frontend dependencies: packages/cloudlands-fe/node_modules with node-pty loadable on $(host_platform)-$(host_arch)"
  else
    missing "frontend dependencies: $PROBE_ERROR under packages/cloudlands-fe/node_modules (built for another platform or corrupted); run corepack pnpm rebuild node-pty in packages/cloudlands-fe"
  fi

  local gh_found
  if ! command -v gh >/dev/null 2>&1; then
    missing "GitHub CLI: gh >= $GH_MIN_VERSION is required (gh pr edit, gh issue create --type); run make bootstrap-dev-host"
  elif ! gh_ready; then
    gh_found=$(gh_version || echo unknown)
    missing "GitHub CLI: gh $gh_found is below the required $GH_MIN_VERSION; run make bootstrap-dev-host (apt via https://cli.github.com/packages, dnf via gh-cli repo, or brew upgrade gh)"
  else
    gh_found=$(gh_version)
    if gh auth status >/dev/null 2>&1; then
      ok "GitHub CLI: gh $gh_found (>= $GH_MIN_VERSION), authenticated"
    else
      ok "GitHub CLI: gh $gh_found (>= $GH_MIN_VERSION)"
      optional "GitHub CLI: not authenticated; PR reporting is disabled until gh auth login"
    fi
  fi

  if ! command -v jq >/dev/null 2>&1; then
    missing "jq: required by the release-notifier test suites (intentd scripts/test-notify-fixed-issues.sh via make test, cloudlands-fe pnpm test:unit); run make bootstrap-dev-host"
  elif ! jq_ready; then
    missing "jq: $(command -v jq) is on PATH but jq --version fails; reinstall it (run make bootstrap-dev-host)"
  else
    ok "jq: $(jq_version)"
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
    echo "ERROR: installing system packages requires root privileges; sudo is unavailable" >&2
    return 1
  fi
}

install_python() {
  if python_ready; then
    echo "[skip] Python 3 already installed"
    return
  fi

  echo "[install] Python 3"
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required to install Python on macOS" >&2; exit 1; }
      brew install python || exit 1
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        as_root apt-get install -y python3 || exit 1
      elif command -v dnf >/dev/null 2>&1; then
        as_root dnf install -y python3 || exit 1
      elif command -v yum >/dev/null 2>&1; then
        as_root yum install -y python3 || exit 1
      else
        echo "ERROR: unsupported Linux package manager; install Python 3 and re-run" >&2
        exit 1
      fi
      ;;
    *) echo "ERROR: only Linux and macOS are supported" >&2; exit 1 ;;
  esac
  hash -r
}

install_native_build_dependencies() {
  if openssl_dev_ready; then
    echo "[skip] pkg-config and OpenSSL development headers already installed"
    return
  fi
  if [[ $(uname -s) == Linux ]] && command -v apt-get >/dev/null 2>&1; then
    echo "[install] pkg-config and OpenSSL development headers"
    as_root apt-get install -y libssl-dev pkg-config || exit 1
    return
  fi
  echo "[manual] install pkg-config and OpenSSL development headers for your platform, then re-run make doctor"
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
    echo "[skip] Node v$(node_version) is supported ($NODE_REQUIREMENT)"
    return
  fi

  echo "[install] Node $NODE_INSTALL_MAJOR (supported: $NODE_REQUIREMENT)"
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required to install Node on macOS" >&2; exit 1; }
      brew install node || exit 1
      ;;
    Linux)
      command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install Node" >&2; exit 1; }
      TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/nodesource.XXXXXX") || exit 1
      if command -v apt-get >/dev/null 2>&1; then
        curl -fsSL "https://deb.nodesource.com/setup_$NODE_INSTALL_MAJOR.x" -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root apt-get install -y nodejs || exit 1
      elif command -v dnf >/dev/null 2>&1; then
        curl -fsSL "https://rpm.nodesource.com/setup_$NODE_INSTALL_MAJOR.x" -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root dnf install -y nodejs || exit 1
      elif command -v yum >/dev/null 2>&1; then
        curl -fsSL "https://rpm.nodesource.com/setup_$NODE_INSTALL_MAJOR.x" -o "$TEMP_FILE" || exit 1
        as_root bash "$TEMP_FILE" || exit 1
        as_root yum install -y nodejs || exit 1
      else
        echo "ERROR: unsupported Linux package manager; install Node $NODE_REQUIREMENT and re-run" >&2
        exit 1
      fi
      rm -f -- "$TEMP_FILE"
      TEMP_FILE=""
      hash -r
      ;;
    *) echo "ERROR: only Linux and macOS are supported" >&2; exit 1 ;;
  esac
}

install_gh() {
  if gh_ready; then
    echo "[skip] GitHub CLI $(gh_version) satisfies >= $GH_MIN_VERSION"
    return
  fi

  echo "[install] GitHub CLI >= $GH_MIN_VERSION"
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required to install the GitHub CLI on macOS; see $GH_INSTALL_URL" >&2; exit 1; }
      # A gh on PATH may come from Nix, MacPorts, or a manual install; only the formula can be upgraded.
      if brew list --versions gh >/dev/null 2>&1; then
        brew upgrade gh || exit 1
      else
        brew install gh || exit 1
      fi
      ;;
    Linux)
      command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required to install the GitHub CLI" >&2; exit 1; }
      if command -v apt-get >/dev/null 2>&1; then
        TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/githubcli-archive-keyring.XXXXXX") || exit 1
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$TEMP_FILE" || exit 1
        as_root install -D -m 0644 "$TEMP_FILE" /usr/share/keyrings/githubcli-archive-keyring.gpg || exit 1
        printf 'deb [arch=%s signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
          "$(dpkg --print-architecture)" | as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null || exit 1
        as_root apt-get update || exit 1
        as_root apt-get install -y gh || exit 1
      elif command -v dnf >/dev/null 2>&1; then
        TEMP_FILE=$(mktemp "${TMPDIR:-/tmp}/gh-cli.repo.XXXXXX") || exit 1
        curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o "$TEMP_FILE" || exit 1
        as_root install -D -m 0644 "$TEMP_FILE" /etc/yum.repos.d/gh-cli.repo || exit 1
        if rpm -q gh >/dev/null 2>&1; then
          as_root dnf update -y gh --repo gh-cli || exit 1
        else
          as_root dnf install -y gh --repo gh-cli || exit 1
        fi
      else
        echo "ERROR: unsupported Linux package manager; install gh >= $GH_MIN_VERSION from $GH_INSTALL_URL and re-run" >&2
        exit 1
      fi
      rm -f -- "$TEMP_FILE"
      TEMP_FILE=""
      ;;
    *) echo "ERROR: only Linux and macOS are supported; install gh >= $GH_MIN_VERSION from $GH_INSTALL_URL" >&2; exit 1 ;;
  esac
  hash -r
  gh_ready && return

  local gh_path gh_found
  gh_path=$(command -v gh || echo "no gh on PATH")
  gh_found=$(gh_version || echo unknown)
  echo "ERROR: gh $gh_found ($gh_path) is still below $GH_MIN_VERSION after install." >&2
  echo "       A gh not installed by the package manager sits earlier on PATH and shadows the new one; remove it or move the package-manager gh ahead of it on PATH, then re-run. See $GH_INSTALL_URL" >&2
  exit 1
}

install_jq() {
  if jq_ready; then
    echo "[skip] jq $(jq_version) already installed"
    return
  fi

  echo "[install] jq"
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew is required to install jq on macOS; see $JQ_INSTALL_URL" >&2; exit 1; }
      brew install jq || exit 1
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        as_root apt-get install -y jq || exit 1
      elif command -v dnf >/dev/null 2>&1; then
        as_root dnf install -y jq || exit 1
      elif command -v yum >/dev/null 2>&1; then
        as_root yum install -y jq || exit 1
      else
        echo "ERROR: unsupported Linux package manager; install jq from $JQ_INSTALL_URL and re-run" >&2
        exit 1
      fi
      ;;
    *) echo "ERROR: only Linux and macOS are supported; install jq from $JQ_INSTALL_URL" >&2; exit 1 ;;
  esac
  hash -r
}

install_frontend() {
  if ! command -v corepack >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || { echo "ERROR: npm is required to install Corepack" >&2; exit 1; }
    echo "[install] Corepack"
    npm install --global corepack || as_root npm install --global corepack || exit 1
    hash -r
  fi
  launcher_probe "$ROOT_DIR" corepack corepack --version || { echo "ERROR: Corepack: $PROBE_ERROR" >&2; exit 1; }

  if pnpm_ready; then
    echo "[skip] $PACKAGE_MANAGER already available via Corepack"
  else
    echo "[install] enabling Corepack and $PACKAGE_MANAGER"
    corepack enable || as_root corepack enable || exit 1
    corepack install --global "$PACKAGE_MANAGER" || exit 1
    hash -r
    pnpm_ready || { echo "ERROR: frontend package manager: expected $PACKAGE_MANAGER via Corepack${PROBE_ERROR:+; $PROBE_ERROR}" >&2; exit 1; }
  fi

  if frontend_dependencies_ready; then
    echo "[skip] frontend dependencies already installed"
  else
    echo "[install] frontend dependencies"
    (cd "$FE_DIR" && corepack pnpm install --frozen-lockfile) || exit 1
    if ! node_pty_loadable; then
      echo "[install] node-pty native module for $(host_platform)-$(host_arch): $PROBE_ERROR"
      (cd "$FE_DIR" && corepack pnpm rebuild node-pty) || exit 1
      node_pty_loadable || { echo "ERROR: frontend dependencies: $PROBE_ERROR after corepack pnpm rebuild node-pty" >&2; exit 1; }
    fi
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
install_python
install_native_build_dependencies
install_rust
install_node
install_frontend
install_gh
install_jq

echo
check_all