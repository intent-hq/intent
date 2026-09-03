#!/usr/bin/env bash

set -u

mode=${1:-}
case "$mode" in
  ui|app|stack) ;;
  *) echo "Usage: $0 {ui|app|stack}" >&2; exit 2 ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
fe_dir=${FE_DIR:-"$repo_root/packages/cloudlands-fe"}
dev_port=${DEV_PORT:-5190}
ready_timeout=${SANDBOX_READY_TIMEOUT:-60}
warm_timeout=${SANDBOX_WARM_TIMEOUT:-60}
dev_data_dir=${DEV_DATA_DIR:-"$repo_root/.dev/intentd"}
intentd_dir=${INTENTD_DIR:-"$repo_root/packages/intentd"}
intentd_target_dir=${INTENTD_TARGET_DIR:-"$intentd_dir/target"}
intentd_profile=${INTENTD_PROFILE:-dev}
intentd_bin=${INTENTD_BIN:-}
build_jobs=${BUILD_JOBS:--2}
socket_path=${INTENTD_SOCKET:-}
fe_pid=""
daemon_pid=""
cleaning=0
child_exit_status=0

[[ "$dev_port" =~ ^[0-9]+$ ]] || { echo "[dev-sandbox-$mode] ERROR: DEV_PORT must be numeric." >&2; exit 2; }
[[ "$ready_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "[dev-sandbox-$mode] ERROR: SANDBOX_READY_TIMEOUT must be a positive integer." >&2; exit 2; }
[[ "$warm_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "[dev-sandbox-$mode] ERROR: SANDBOX_WARM_TIMEOUT must be a positive integer." >&2; exit 2; }

children_of() {
  pgrep -P "$1" 2>/dev/null || true
}

signal_tree() {
  local signal=$1 pid=$2 child
  while IFS= read -r child; do
    [[ -n "$child" ]] && signal_tree "$signal" "$child"
  done < <(children_of "$pid")
  kill "-$signal" "$pid" 2>/dev/null || true
}

cleanup() {
  local pid
  [[ "$cleaning" -eq 0 ]] || return
  cleaning=1
  for pid in "$fe_pid" "$daemon_pid"; do
    [[ -n "$pid" ]] && signal_tree TERM "$pid"
  done
  for _ in {1..50}; do
    local alive=0
    for pid in "$fe_pid" "$daemon_pid"; do
      [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ "$alive" -eq 0 ]] && break
    sleep 0.1
  done
  for pid in "$fe_pid" "$daemon_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      signal_tree KILL "$pid"
    fi
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

socket_accepts() {
  [[ -S "$socket_path" ]] || return 1
  python3 - "$socket_path" <<'PY' >/dev/null 2>&1
import socket
import sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(0.25)
s.connect(sys.argv[1])
s.close()
PY
}

http_accepts() {
  python3 - "$dev_port" <<'PY' >/dev/null 2>&1
import socket
import sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.25)
s.sendall(b"HEAD / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
ok = s.recv(16).startswith(b"HTTP/")
s.close()
raise SystemExit(0 if ok else 1)
PY
}

warm_vite() {
  echo "[dev-sandbox-$mode] Pre-warming the Vite module graph (timeout: ${warm_timeout}s)..."
  if python3 - "$dev_port" "$warm_timeout" <<'PY'
from html.parser import HTMLParser
import sys
import time
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen

origin = f"http://127.0.0.1:{sys.argv[1]}/"
deadline = time.monotonic() + int(sys.argv[2])

def fetch(url):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("warm-up deadline reached")
    with urlopen(url, timeout=max(0.1, remaining)) as response:
        return response.read().decode("utf-8", errors="replace")

class Entries(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.urls.append(values["src"])
        if tag == "link" and "modulepreload" in values.get("rel", "").split() and values.get("href"):
            self.urls.append(values["href"])

parser = Entries()
parser.feed(fetch(origin))
seen = set()
for reference in parser.urls[:32]:
    url = urljoin(origin, reference)
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.netloc != urlparse(origin).netloc or url in seen:
        continue
    seen.add(url)
    fetch(url)
print(f"fetched / and {len(seen)} entry module(s)")
PY
  then
    echo "[dev-sandbox-$mode] Vite warm-up complete."
  else
    echo "[dev-sandbox-$mode] WARNING: Vite warm-up failed or timed out; continuing." >&2
  fi
}

child_is_running() {
  local pid=$1 label=$2 status
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    status=$?
    child_exit_status=$status
    echo "[dev-sandbox-$mode] ERROR: $label exited with status $status." >&2
    return 1
  fi
  return 0
}

if [[ "$mode" == app ]]; then
  if [[ -z "$socket_path" ]]; then
    case "$(uname -s)" in
      Darwin) socket_path="$HOME/Library/Application Support/intentd/intentd.sock" ;;
      Linux) socket_path="${XDG_DATA_HOME:-$HOME/.local/share}/intentd/intentd.sock" ;;
      *) echo "[dev-sandbox-app] ERROR: unsupported platform; set INTENTD_SOCKET explicitly." >&2; exit 1 ;;
    esac
  fi
  if ! socket_accepts; then
    echo "[dev-sandbox-app] ERROR: installed daemon socket is absent or not accepting connections at $socket_path" >&2
    echo "[dev-sandbox-app] Start the installed Intent app/daemon, or set INTENTD_SOCKET." >&2
    exit 1
  fi
elif [[ "$mode" == stack ]]; then
  case "$intentd_profile" in
    dev) profile_dir=debug; profile_args=() ;;
    release) profile_dir=release; profile_args=(--release) ;;
    *) echo "[dev-sandbox-stack] ERROR: INTENTD_PROFILE must be 'dev' or 'release'." >&2; exit 2 ;;
  esac
  if [[ -n "$intentd_bin" ]]; then
    echo "[dev-sandbox-stack] Using INTENTD_BIN override: $intentd_bin (skipping build)"
  else
    command -v cargo >/dev/null 2>&1 || { echo "[dev-sandbox-stack] ERROR: cargo is required; run 'make bootstrap-dev-host'." >&2; exit 1; }
    if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists openssl; then
      echo "[dev-sandbox-stack] ERROR: pkg-config and OpenSSL development headers are required; run 'make bootstrap-dev-host'." >&2
      exit 1
    fi
    intentd_bin="$intentd_target_dir/$profile_dir/intentd"
    echo "[dev-sandbox-stack] Building intentd ($intentd_profile profile, BUILD_JOBS=$build_jobs)..."
    cargo build "${profile_args[@]}" -p intentd --manifest-path "$intentd_dir/Cargo.toml" --jobs "$build_jobs" || exit $?
  fi
  echo "[dev-sandbox-stack] Starting intentd binary: $intentd_bin"
  socket_path="$dev_data_dir/intentd.sock"
  mkdir -p "$dev_data_dir"
  daemon_args=(serve)
  if [[ ${SANDBOX_TCP:-0} == 1 ]]; then
    daemon_args+=(--insecure)
    echo "[dev-sandbox-stack] WARNING: SANDBOX_TCP=1 enables unauthenticated TCP on 0.0.0.0:${DEV_TCP_PORT:-5181}." >&2
  fi
  INTENTD_DATA_DIR="$dev_data_dir" INTENTD_TCP_PORT="${DEV_TCP_PORT:-5181}" \
    INTENTD_LEGACY_IMPORT_ROOTS="" "$intentd_bin" "${daemon_args[@]}" &
  daemon_pid=$!
fi

if [[ "$mode" != ui ]]; then
  echo "[dev-sandbox-$mode] WARNING: DEV ONLY — the Vite origin exposes the full unauthenticated daemon API. Keep it loopback-only and open it only through the client tunnel." >&2
fi

fe_script=dev:web
[[ "$mode" == ui ]] && fe_script=dev:ui
(
  cd "$fe_dir" || exit 1
  INTENTD_SOCKET="$socket_path" INTENT_DEV_DAEMON_BRIDGE=$([[ "$mode" == ui ]] && echo 0 || echo 1) \
    exec corepack pnpm run "$fe_script"
) &
fe_pid=$!

deadline=$((SECONDS + ready_timeout))
while true; do
  child_is_running "$fe_pid" "frontend" || exit "$child_exit_status"
  if [[ -n "$daemon_pid" ]]; then
    child_is_running "$daemon_pid" "intentd" || exit "$child_exit_status"
  fi
  socket_ready=1
  [[ "$mode" == ui ]] || socket_accepts || socket_ready=0
  if [[ "$socket_ready" -eq 1 ]] && http_accepts; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "[dev-sandbox-$mode] ERROR: sandbox was not ready within ${ready_timeout}s." >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "$mode" != ui ]]; then
  warm_vite
  child_is_running "$fe_pid" "frontend" || exit "$child_exit_status"
  if [[ -n "$daemon_pid" ]]; then
    child_is_running "$daemon_pid" "intentd" || exit "$child_exit_status"
  fi
fi

echo "Sandbox ready: http://127.0.0.1:${dev_port}/  (open as http://daemon.localhost:${dev_port}/ from the client)"

if [[ -z "$daemon_pid" ]]; then
  wait "$fe_pid"
  exit $?
fi

while true; do
  child_is_running "$fe_pid" "frontend" || exit "$child_exit_status"
  child_is_running "$daemon_pid" "intentd" || exit "$child_exit_status"
  sleep 0.1
done