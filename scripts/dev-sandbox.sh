#!/usr/bin/env bash
# State schema: intentdSource is installed|bin|dev|release|none; UI uses none
# with a null socket because it does not connect to a daemon.

set -u

mode=${1:-}
case "$mode" in
  ui|app|stack|status|stop) ;;
  *) echo "Usage: $0 {ui|app|stack|status|stop}" >&2; exit 2 ;;
esac

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
state_dir=${SANDBOX_STATE_DIR:-"$repo_root/.dev/sandbox"}
fe_dir=${FE_DIR:-"$repo_root/packages/cloudlands-fe"}
# The Makefile always passes DEV_PORT/DEV_TCP_PORT and reports where each came
# from via $(origin): "file" means the worktree-derived default, anything else
# (environment, command line) is an explicit pin that is never remapped.
dev_port_explicit=0
dev_tcp_port_explicit=0
[[ ${DEV_PORT+x} == x && ${DEV_PORT_ORIGIN:-} != file ]] && dev_port_explicit=1
[[ ${DEV_TCP_PORT+x} == x && ${DEV_TCP_PORT_ORIGIN:-} != file ]] && dev_tcp_port_explicit=1
dev_port=${DEV_PORT:-5190}
dev_tcp_port=${DEV_TCP_PORT:-5181}
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
state_file="$state_dir/$mode.json"
# The pin record outlives the state file (which is removed on every exit) so a
# supervised restart of this mode comes back on the port its tunnel URL uses.
pin_file="$state_dir/$mode.port"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
warm_ok=true
warm_ms=0
intentd_source=installed
[[ "$mode" == ui ]] && intentd_source=none

# Mirrors scripts/dev-ports.sh: busy means a live listener (loopback connect
# accepted, or a SO_REUSEADDR bind fails); TIME_WAIT/CLOSE_WAIT leftovers are free.
port_is_free() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys

port = int(sys.argv[1])
probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
probe.settimeout(0.25)
try:
    if probe.connect_ex(("127.0.0.1", port)) == 0:
        raise SystemExit(1)
finally:
    probe.close()
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

port_owner() {
  local port=$1 pid="" comm=""
  if command -v ss >/dev/null 2>&1; then
    pid=$(ss -Hltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n 1)
  fi
  if [[ -z "$pid" ]] && command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  fi
  [[ -n "$pid" ]] || return 1
  comm=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')
  printf 'PID %s%s' "$pid" "${comm:+ ($comm)}"
}

describe_busy_port() {
  local port=$1 owner
  if owner=$(port_owner "$port"); then
    echo "[dev-ports] 127.0.0.1:$port is held by $owner; stop it or choose another port." >&2
  else
    echo "[dev-ports] No listening PID is visible for 127.0.0.1:$port (another user's process, or connections still draining); retry shortly or choose another port." >&2
  fi
}

pinned_value() {
  local key=$1 line
  [[ -f "$pin_file" ]] || return 1
  while IFS= read -r line; do
    if [[ "$line" == "$key="* && "${line#*=}" =~ ^[0-9]+$ ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$pin_file"
  return 1
}

write_pin_file() {
  local temp_file="$pin_file.tmp.$$"
  printf 'DEV_PORT=%s\nDEV_TCP_PORT=%s\n' "$dev_port" "$dev_tcp_port" >"$temp_file" && mv -f "$temp_file" "$pin_file"
}

if [[ "$mode" == ui || "$mode" == app || "$mode" == stack ]]; then
  [[ "$dev_port" =~ ^[0-9]+$ ]] || { echo "[dev-sandbox-$mode] ERROR: DEV_PORT must be numeric." >&2; exit 2; }
  [[ "$dev_tcp_port" =~ ^[0-9]+$ ]] || { echo "[dev-sandbox-$mode] ERROR: DEV_TCP_PORT must be numeric." >&2; exit 2; }
  [[ "$ready_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "[dev-sandbox-$mode] ERROR: SANDBOX_READY_TIMEOUT must be a positive integer." >&2; exit 2; }
  [[ "$warm_timeout" =~ ^[1-9][0-9]*$ ]] || { echo "[dev-sandbox-$mode] ERROR: SANDBOX_WARM_TIMEOUT must be a positive integer." >&2; exit 2; }
  derived_dev_port=$dev_port
  if [[ "$dev_port_explicit" -eq 0 ]] && pinned_port=$(pinned_value DEV_PORT) && [[ "$pinned_port" != "$dev_port" ]]; then
    if [[ "$pinned_port" == "$dev_tcp_port" && "$dev_tcp_port_explicit" -eq 1 ]]; then
      echo "[dev-sandbox-$mode] WARNING: recorded DEV_PORT=$pinned_port from $pin_file collides with explicit DEV_TCP_PORT=$dev_tcp_port; starting on derived DEV_PORT=$dev_port instead." >&2
    elif port_is_free "$pinned_port"; then
      echo "[dev-sandbox-$mode] Reusing recorded DEV_PORT=$pinned_port from $pin_file (derived DEV_PORT=$dev_port not used); run 'make sandbox-stop MODE=$mode' to forget it."
      dev_port=$pinned_port
    else
      echo "[dev-sandbox-$mode] WARNING: recorded DEV_PORT=$pinned_port from $pin_file is busy; starting on derived DEV_PORT=$dev_port instead." >&2
      describe_busy_port "$pinned_port"
    fi
  fi
  if [[ "$dev_tcp_port_explicit" -eq 0 ]] && pinned_tcp_port=$(pinned_value DEV_TCP_PORT) \
    && [[ "$pinned_tcp_port" != "$dev_tcp_port" && "$pinned_tcp_port" != "$dev_port" ]]; then
    if [[ "$mode" != stack || ${SANDBOX_TCP:-0} != 1 ]] || port_is_free "$pinned_tcp_port"; then
      dev_tcp_port=$pinned_tcp_port
    fi
  fi
  if [[ "$dev_port" != "$derived_dev_port" && "$dev_port" == "$dev_tcp_port" ]]; then
    echo "[dev-sandbox-$mode] WARNING: recorded DEV_PORT=$dev_port from $pin_file collides with DEV_TCP_PORT=$dev_tcp_port; starting on derived DEV_PORT=$derived_dev_port instead." >&2
    dev_port=$derived_dev_port
  fi
  export DEV_PORT="$dev_port" DEV_TCP_PORT="$dev_tcp_port"
  if [[ "$dev_port_explicit" -eq 1 ]] && ! port_is_free "$dev_port"; then
    echo "[dev-ports] ERROR: explicit DEV_PORT=$dev_port is busy; explicit ports are never remapped." >&2
    describe_busy_port "$dev_port"
    exit 1
  fi
  if [[ "$mode" == stack && ${SANDBOX_TCP:-0} == 1 && "$dev_tcp_port_explicit" -eq 1 ]] && ! port_is_free "$dev_tcp_port"; then
    echo "[dev-ports] ERROR: explicit DEV_TCP_PORT=$dev_tcp_port is busy; explicit ports are never remapped." >&2
    describe_busy_port "$dev_tcp_port"
    exit 1
  fi
fi

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

status_sandboxes() {
  local read_only=${SANDBOX_STATUS_READ_ONLY:-0}
  [[ "$read_only" == 1 ]] || mkdir -p "$state_dir"
  python3 - "$state_dir" "${SANDBOX_JSON:-0}" "$read_only" <<'PY'
import errno
import glob
import json
import os
import subprocess
import sys

state_dir, json_output, read_only = sys.argv[1], sys.argv[2] == "1", sys.argv[3] == "1"

def process_identity(pid):
    stat_path = f"/proc/{pid}/stat"
    if os.path.exists(stat_path):
        with open(stat_path, encoding="utf-8") as handle:
            fields = handle.read().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            raise ProcessLookupError("process is a zombie")
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            command = handle.read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
        return f"proc:{fields[19]}", command
    output = subprocess.check_output(
        ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)], text=True
    ).strip()
    fields = output.split(None, 5)
    if len(fields) != 6:
        raise ProcessLookupError("process identity is unavailable")
    return f"ps:{' '.join(fields[:5])}", fields[5]

live = []
for path in sorted(glob.glob(os.path.join(state_dir, "*.json"))):
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
        pid = int(state["pid"])
        try:
            os.kill(pid, 0)
        except OSError as error:
            if error.errno != errno.EPERM:
                raise
        actual_identity = process_identity(pid)
        expected_identity = (state["pidStartTime"], state["pidCommandLine"])
        if actual_identity != expected_identity:
            raise ProcessLookupError("PID identity does not match recorded sandbox")
    except Exception as error:
        print(f"Stale sandbox state: {path} ({error})", file=sys.stderr)
        if not read_only:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        continue
    live.append(state)

if json_output:
    json.dump(live, sys.stdout, separators=(",", ":"))
    print()
else:
    for state in live:
        supervisor = state.get("supervisor")
        supervisor_hint = ""
        if isinstance(supervisor, dict):
            supervisor_hint = f" supervisor={supervisor.get('kind')}:{supervisor.get('id')}"
        print(
            f"{state['mode']}: pid={state['pid']} url={state['url']} "
            f"source={state['intentdSource']} socket={state['socket'] or '-'}"
            f"{supervisor_hint}"
        )
    if not live:
        print("No running sandboxes.", file=sys.stderr)
raise SystemExit(0 if live else 1)
PY
}

pid_is_alive() {
  local pid=$1 process_state
  kill -0 "$pid" 2>/dev/null || return 1
  process_state=$(ps -o stat= -p "$pid" 2>/dev/null) || return 1
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

pid_identity_matches() {
  python3 - "$1" "$2" "$3" <<'PY' >/dev/null 2>&1
import os
import subprocess
import sys

pid, expected_start, expected_command = int(sys.argv[1]), sys.argv[2], sys.argv[3]
stat_path = f"/proc/{pid}/stat"
if os.path.exists(stat_path):
    with open(stat_path, encoding="utf-8") as handle:
        fields = handle.read().rsplit(")", 1)[1].split()
    if fields[0] == "Z":
        raise SystemExit(1)
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
        command = handle.read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
    actual = (f"proc:{fields[19]}", command)
else:
    output = subprocess.check_output(
        ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)], text=True
    ).strip()
    fields = output.split(None, 5)
    if len(fields) != 6:
        raise SystemExit(1)
    actual = (f"ps:{' '.join(fields[:5])}", fields[5])
raise SystemExit(0 if actual == (expected_start, expected_command) else 1)
PY
}

tcp_accepts_port() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket
import sys
s = socket.socket()
s.settimeout(0.05)
status = s.connect_ex(("127.0.0.1", int(sys.argv[1])))
s.close()
raise SystemExit(0 if status == 0 else 1)
PY
}

stop_sandboxes() {
  local requested_mode=${MODE:-} path pid state_mode state_port pid_start_time pid_command_line i
  local -a paths=()
  local -a stopped_modes=() stopped_ports=() warned=()
  case "$requested_mode" in
    "") ;;
    ui|app|stack) ;;
    *) echo "sandbox-stop: MODE must be ui, app, or stack." >&2; return 2 ;;
  esac
  mkdir -p "$state_dir"
  if [[ -n "$requested_mode" ]]; then
    [[ -e "$state_dir/$requested_mode.json" ]] && paths+=("$state_dir/$requested_mode.json")
    rm -f "$state_dir/$requested_mode.port"
  else
    shopt -s nullglob
    paths=("$state_dir"/*.json)
    for path in "$state_dir"/*.port; do rm -f "$path"; done
    shopt -u nullglob
  fi
  if [[ ${#paths[@]} -eq 0 ]]; then
    echo "No running sandboxes."
    return 0
  fi
  for path in "${paths[@]}"; do
    if ! IFS=$'\t' read -r state_mode pid state_port pid_start_time pid_command_line < <(python3 - "$path" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    state = json.load(handle)
print(
    state["mode"], int(state["pid"]), int(state["devPort"]),
    state.get("pidStartTime", ""), state.get("pidCommandLine", ""), sep="\t"
)
PY
    ); then
      echo "Removing invalid sandbox state: $path" >&2
      rm -f "$path"
      continue
    fi
    if pid_is_alive "$pid" && pid_identity_matches "$pid" "$pid_start_time" "$pid_command_line"; then
      echo "Stopping sandbox pid $pid from $path"
      signal_tree TERM "$pid"
      for _ in {1..50}; do
        pid_is_alive "$pid" || break
        sleep 0.1
      done
      if pid_is_alive "$pid" && pid_identity_matches "$pid" "$pid_start_time" "$pid_command_line"; then
        signal_tree KILL "$pid"
      fi
    else
      echo "Removing stale sandbox state: $path" >&2
    fi
    rm -f "$path"
    stopped_modes+=("$state_mode")
    stopped_ports+=("$state_port")
    warned+=(0)
  done
  for _ in {1..50}; do
    for ((i = 0; i < ${#stopped_modes[@]}; i++)); do
      [[ ${warned[$i]} -eq 0 ]] || continue
      if [[ -e "$state_dir/${stopped_modes[$i]}.json" ]] || tcp_accepts_port "${stopped_ports[$i]}"; then
        echo "sandbox ${stopped_modes[$i]} restarted — it is supervised (workspace service); stop it with ws.script.stop instead" >&2
        warned[i]=1
      fi
    done
    sleep 0.1
  done
}

if [[ "$mode" == status ]]; then
  status_sandboxes
  exit $?
elif [[ "$mode" == stop ]]; then
  stop_sandboxes
  exit $?
fi

# Fork-free so it cannot fail under host load: write_state_file emits compact
# JSON, so "pid":$$, is a stable own-pid token.
remove_state_file() {
  local state_line=""
  [[ -e "$state_file" ]] || return 0
  IFS= read -r state_line 2>/dev/null <"$state_file" || true
  [[ "$state_line" == *"\"pid\":$$,"* ]] || return 0
  rm -f -- "$state_file" || echo "[dev-sandbox-$mode] WARNING: could not remove sandbox state at $state_file" >&2
}

cleanup() {
  # bash runs pending signal traps between commands even inside the EXIT trap,
  # so a repeated HUP/INT/TERM would otherwise longjmp out mid-cleanup.
  trap '' HUP INT TERM
  local pid
  [[ "$cleaning" -eq 0 ]] || return
  cleaning=1
  remove_state_file
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
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
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

sandbox_health_state() {
  python3 - "$dev_port" <<'PY' 2>/dev/null
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

try:
    response = urlopen(f"http://127.0.0.1:{sys.argv[1]}/__sandbox/health", timeout=0.25)
except HTTPError as error:
    response = error
except (OSError, URLError):
    print("pending")
    raise SystemExit

status = response.status
body = response.read().decode("utf-8", errors="replace")
try:
    payload = json.loads(body)
except json.JSONDecodeError:
    payload = None

if isinstance(payload, dict) and isinstance(payload.get("ok"), bool):
    print("ok" if payload["ok"] else "pending")
elif status in (200, 404):
    print("absent")
else:
    print("pending")
PY
}

warm_vite() {
  local warm_started warm_finished health_state deadline
  warm_started=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
  deadline=$((SECONDS + warm_timeout))
  echo "[dev-sandbox-$mode] Waiting for sandbox health and Vite warm-up (timeout: ${warm_timeout}s)..."
  while true; do
    child_is_running "$fe_pid" "frontend" || return "$child_exit_status"
    if [[ -n "$daemon_pid" ]]; then
      child_is_running "$daemon_pid" "intentd" || return "$child_exit_status"
    fi
    health_state=$(sandbox_health_state)
    case "$health_state" in
      ok)
        warm_ok=true
        echo "[dev-sandbox-$mode] Sandbox health is ok; Vite warm-up complete."
        break
        ;;
      absent)
        warm_ok=true
        echo "[dev-sandbox-$mode] Sandbox health endpoint unavailable; using socket/HTTP readiness probes."
        break
        ;;
    esac
    if (( SECONDS >= deadline )); then
      warm_ok=false
      warm_finished=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
      warm_ms=$((warm_finished - warm_started))
      echo "[dev-sandbox-$mode] ERROR: sandbox health was not ok within ${warm_timeout}s." >&2
      return 1
    fi
    sleep 0.1
  done
  warm_finished=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
  warm_ms=$((warm_finished - warm_started))
}

write_state_file() {
  local ready_at=$1 temp_file="$state_file.tmp.$$"
  mkdir -p "$state_dir"
  python3 - "$temp_file" "$state_file" "$mode" "$$" "$dev_port" "$dev_tcp_port" \
    "$socket_path" "$intentd_source" "$started_at" "$ready_at" "$warm_ok" "$warm_ms" <<'PY'
import json
import os
import subprocess
import sys

(temp_path, state_path, mode, pid, dev_port, tcp_port, socket_path,
 source, started_at, ready_at, warm_ok, warm_ms) = sys.argv[1:]
pid = int(pid)
stat_path = f"/proc/{pid}/stat"
if os.path.exists(stat_path):
    with open(stat_path, encoding="utf-8") as handle:
        fields = handle.read().rsplit(")", 1)[1].split()
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
        command = handle.read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
    pid_start_time = f"proc:{fields[19]}"
else:
    output = subprocess.check_output(
        ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)], text=True
    ).strip()
    fields = output.split(None, 5)
    if len(fields) != 6:
        raise ProcessLookupError("sandbox process identity is unavailable")
    pid_start_time = f"ps:{' '.join(fields[:5])}"
    command = fields[5]
state = {
    "mode": mode,
    "pid": pid,
    "pidStartTime": pid_start_time,
    "pidCommandLine": command,
    "devPort": int(dev_port),
    "tcpPort": int(tcp_port),
    "url": f"http://127.0.0.1:{dev_port}/",
    "daemonLocalhostUrl": f"http://daemon.localhost:{dev_port}/",
    "socket": None if mode == "ui" else socket_path,
    "intentdSource": source,
    "startedAt": started_at,
    "readyAt": ready_at,
    "warm": {"ok": warm_ok == "true", "ms": int(warm_ms)},
    "supervisor": None,
}
with open(temp_path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, separators=(",", ":"))
    handle.write("\n")
os.replace(temp_path, state_path)
PY
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
    intentd_source=bin
    echo "[dev-sandbox-stack] Using INTENTD_BIN override: $intentd_bin (skipping build)"
  else
    intentd_source=$intentd_profile
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
  INTENTD_DATA_DIR="$dev_data_dir" INTENTD_TCP_PORT="$dev_tcp_port" \
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
  warm_vite || exit $?
  child_is_running "$fe_pid" "frontend" || exit "$child_exit_status"
  if [[ -n "$daemon_pid" ]]; then
    child_is_running "$daemon_pid" "intentd" || exit "$child_exit_status"
  fi
fi

ready_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! write_state_file "$ready_at"; then
  echo "[dev-sandbox-$mode] ERROR: could not write sandbox state at $state_file" >&2
  exit 1
fi
write_pin_file || echo "[dev-sandbox-$mode] WARNING: could not record the pinned port at $pin_file" >&2
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