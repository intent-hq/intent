#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/dev-sandbox.sh"
temp_dir=$(mktemp -d)
sandbox_pid=""
foreign_pid=""
listener_pid=""
state_dir="$temp_dir/state"

cleanup() {
  if [[ -n "$sandbox_pid" ]]; then
    kill "$sandbox_pid" 2>/dev/null || true
    wait "$sandbox_pid" 2>/dev/null || true
  fi
  if [[ -n "$foreign_pid" ]]; then
    kill "$foreign_pid" 2>/dev/null || true
    wait "$foreign_pid" 2>/dev/null || true
  fi
  if [[ -n "$listener_pid" ]]; then
    kill "$listener_pid" 2>/dev/null || true
    wait "$listener_pid" 2>/dev/null || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  echo "dev-sandbox test failed: $*" >&2
  exit 1
}

# errexit exits silently on a plain command failure, leaving an empty log with
# status 1. Name the command before that happens. The trap stays quiet inside
# the deliberate `set +e … wait … set -e` windows, and bash already skips it in
# the same conditional contexts (&&, ||, if, while, !) in which errexit is
# suppressed, so helpers that return non-zero on purpose do not report.
report_unexpected_failure() {
  local status=$1 line=$2 command=$3 pipestatus=$4
  [[ $- == *e* ]] || return 0
  echo "dev-sandbox test: unexpected failure (status $status, pipestatus [$pipestatus]) at line $line: $command" >&2
}
set -o errtrace
trap 'report_unexpected_failure "$?" "$LINENO" "$BASH_COMMAND" "${PIPESTATUS[*]}"' ERR

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

write_live_state() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json
import os
import subprocess
import sys

path, mode, pid, port = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
stat_path = f"/proc/{pid}/stat"
if os.path.exists(stat_path):
    with open(stat_path, encoding="utf-8") as handle:
        fields = handle.read().rsplit(")", 1)[1].split()
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
        command = handle.read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
    start_time = f"proc:{fields[19]}"
else:
    output = subprocess.check_output(
        ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)], text=True
    ).strip()
    fields = output.split(None, 5)
    start_time, command = f"ps:{' '.join(fields[:5])}", fields[5]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "mode": mode, "pid": pid, "devPort": port,
        "pidStartTime": start_time, "pidCommandLine": command,
    }, handle)
    handle.write("\n")
PY
}

wait_for_ready() {
  local output=$1
  for _ in {1..100}; do
    grep -q '^Sandbox ready:' "$output" 2>/dev/null && return 0
    kill -0 "$sandbox_pid" 2>/dev/null || return 1
    sleep 0.05
  done
  return 1
}

# Print the pid of the fake frontend (`python3 - <port>`) running under the
# sandbox script. A no-match pgrep exits 1, so a bare `$(pgrep -P … | head -1)`
# assignment tripped errexit/pipefail on a transient miss before the caller's
# `fail` guard could run; the lookup is retried for up to 2s instead, matching
# the command line so a transient sibling child is never chosen, and fails only
# after the deadline (or once the sandbox has died) with the child listing and
# the sandbox output dumped.
find_frontend_pid() {
  local parent=$1 port=$2 output=$3 matches
  for _ in {1..100}; do
    matches=$(pgrep -P "$parent" -f "python3 - $port" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      echo "${matches%%$'\n'*}"
      return 0
    fi
    kill -0 "$parent" 2>/dev/null || break
    sleep 0.02
  done
  echo "children of sandbox pid $parent (alive: $(kill -0 "$parent" 2>/dev/null && echo yes || echo no)):" >&2
  ps -eo pid,ppid,stat,command | awk -v pp="$parent" 'NR == 1 || $2 == pp' >&2
  echo "sandbox output:" >&2
  cat "$output" >&2 || true
  return 1
}

mkdir -p "$temp_dir/bin" "$temp_dir/fe"
cat >"$temp_dir/bin/corepack" <<'SH'
#!/usr/bin/env bash
exec python3 - "$DEV_PORT" <<'PY'
import http.server
import json
import os
import signal
import sys
if os.environ.get("FE_IGNORE_TERM") == "1":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()
    def do_GET(self):
        if self.path == "/__sandbox/health":
            mode = os.environ.get("HEALTH_MODE", "absent")
            if mode == "absent":
                self.send_error(404)
                return
            payload = json.dumps({"ok": mode == "ok"}).encode()
            self.send_response(200 if mode == "ok" else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b'<script type="module" src="/entry.js"></script>')
server = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
print(f"Local: http://127.0.0.1:{sys.argv[1]}/", flush=True)
server.serve_forever()
PY
SH
chmod +x "$temp_dir/bin/corepack"

cat >"$temp_dir/bin/pkg-config" <<'SH'
#!/usr/bin/env bash
[[ ${PKG_CONFIG_FAIL:-0} != 1 && "$*" == "--exists openssl" ]]
SH
chmod +x "$temp_dir/bin/pkg-config"

cat >"$temp_dir/bin/cargo" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CARGO_LOG"
profile=debug
[[ " $* " == *" --release "* ]] && profile=release
mkdir -p "$INTENTD_TARGET_DIR/$profile"
cp "$FAKE_INTENTD_SOURCE" "$INTENTD_TARGET_DIR/$profile/intentd"
chmod +x "$INTENTD_TARGET_DIR/$profile/intentd"
SH
chmod +x "$temp_dir/bin/cargo"

busy_port=$(free_port)
busy_ready="$temp_dir/busy-ready"
python3 - "$busy_port" "$busy_ready" <<'PY' &
import pathlib
import socket
import sys
import time

sock = socket.socket()
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen()
pathlib.Path(sys.argv[2]).touch()
time.sleep(30)
PY
listener_pid=$!
for _ in {1..100}; do
  [[ -e "$busy_ready" ]] && break
  sleep 0.01
done
[[ -e "$busy_ready" ]] || fail "busy-port listener did not start"
if PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$busy_port" \
  SANDBOX_STATE_DIR="$state_dir" bash "$script" ui >"$temp_dir/busy-port.out" 2>&1; then
  fail "UI sandbox accepted a busy explicit DEV_PORT"
fi
grep -q "explicit DEV_PORT=$busy_port is busy; explicit ports are never remapped" "$temp_dir/busy-port.out" \
  || fail "busy explicit port error was not actionable"
grep -q "127.0.0.1:$busy_port is held by PID $listener_pid" "$temp_dir/busy-port.out" \
  || fail "busy explicit port error did not name the owning PID"
kill "$listener_pid"
wait "$listener_pid" 2>/dev/null || true
listener_pid=""

cat >"$temp_dir/fake-intentd" <<'SH'
#!/usr/bin/env bash
exec python3 - "$INTENTD_DATA_DIR/intentd.sock" <<'PY'
import os
import socket
import sys
path = sys.argv[1]
try: os.unlink(path)
except FileNotFoundError: pass
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen()
while True:
    connection, _ = server.accept()
    connection.close()
PY
SH
chmod +x "$temp_dir/fake-intentd"
mkdir -p "$temp_dir/intentd"
touch "$temp_dir/intentd/Cargo.toml"

missing_prereq_log="$temp_dir/missing-prereq-cargo.log"
set +e
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" \
  SANDBOX_STATE_DIR="$state_dir" INTENTD_DIR="$temp_dir/intentd" INTENTD_TARGET_DIR="$temp_dir/target" PKG_CONFIG_FAIL=1 \
  CARGO_LOG="$missing_prereq_log" FAKE_INTENTD_SOURCE="$temp_dir/fake-intentd" \
  bash "$script" stack >"$temp_dir/missing-prereq.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "missing OpenSSL metadata returned $status instead of 1"
[[ ! -e "$missing_prereq_log" ]] || fail "cargo ran before the OpenSSL prerequisite check"
grep -q "run 'make bootstrap-dev-host'" "$temp_dir/missing-prereq.out" || fail "missing prerequisite message was not actionable"

port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_TCP_PORT=43210 \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" ui >"$temp_dir/ui.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/ui.out" || fail "UI sandbox did not become ready"
[[ $(grep -c '^Sandbox ready:' "$temp_dir/ui.out") -eq 1 ]] || fail "UI ready line was not printed exactly once"
[[ -f "$state_dir/ui.json" ]] || fail "UI state file was not written on readiness"
SANDBOX_STATE_DIR="$state_dir" SANDBOX_JSON=1 bash "$script" status >"$temp_dir/status.json"
python3 - "$temp_dir/status.json" "$sandbox_pid" "$port" <<'PY' || fail "sandbox status JSON shape was incorrect"
import json
import sys
states = json.load(open(sys.argv[1], encoding="utf-8"))
required = {"mode", "pid", "pidStartTime", "pidCommandLine", "devPort", "tcpPort", "url", "daemonLocalhostUrl", "socket", "intentdSource", "startedAt", "readyAt", "warm", "supervisor"}
assert len(states) == 1 and required <= states[0].keys()
assert states[0]["pid"] == int(sys.argv[2])
assert states[0]["devPort"] == int(sys.argv[3]) and states[0]["tcpPort"] == 43210
assert states[0]["intentdSource"] == "none" and states[0]["socket"] is None
assert states[0]["supervisor"] is None
assert set(states[0]["warm"]) == {"ok", "ms"}
PY
MODE=ui SANDBOX_STATE_DIR="$state_dir" bash "$script" stop >"$temp_dir/stop.out"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -eq 143 ]] || fail "UI SIGTERM returned $status instead of 143"
[[ ! -e "$state_dir/ui.json" ]] || fail "UI state file remained after sandbox-stop"
MODE=ui SANDBOX_STATE_DIR="$state_dir" bash "$script" stop >/dev/null || fail "sandbox-stop failed when nothing was running"
if SANDBOX_STATE_DIR="$state_dir" bash "$script" status >"$temp_dir/stopped-status.out" 2>&1; then
  fail "sandbox status succeeded after stop"
fi
python3 - "$port" <<'PY' || fail "UI listener remained after sandbox-stop"
import socket
import sys
s = socket.socket()
s.settimeout(0.2)
assert s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0
s.close()
PY

# Regression: a second TERM landing while cleanup waits on a TERM-ignoring
# frontend must not abort cleanup; the KILL escalation still has to run. The
# state file disappearing proves cleanup has started, and the frontend holds
# it in its 50x0.1s wait loop, so 0.2s later the second TERM lands mid-loop.
port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" FE_IGNORE_TERM=1 \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" ui >"$temp_dir/double-term.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/double-term.out" || fail "double-TERM sandbox did not become ready"
frontend_pid=$(find_frontend_pid "$sandbox_pid" "$port" "$temp_dir/double-term.out") \
  || fail "could not find double-TERM frontend child"
kill -TERM "$sandbox_pid"
for _ in {1..100}; do
  [[ ! -e "$state_dir/ui.json" ]] && break
  sleep 0.02
done
if [[ -e "$state_dir/ui.json" ]]; then
  kill -KILL "$frontend_pid" 2>/dev/null || true
  fail "double-TERM cleanup did not remove the state file within 2s"
fi
sleep 0.2
kill -TERM "$sandbox_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
frontend_alive=0
kill -0 "$frontend_pid" 2>/dev/null && frontend_alive=1
kill -KILL "$frontend_pid" 2>/dev/null || true
[[ "$status" -eq 143 ]] || fail "double TERM returned $status instead of 143"
[[ "$frontend_alive" -eq 0 ]] || fail "second TERM during cleanup aborted the KILL escalation; frontend $frontend_pid survived"
[[ ! -e "$state_dir/ui.json" ]] || fail "UI state file remained after double TERM"
python3 - "$port" <<'PY' || fail "double-TERM listener remained after the sandbox exited"
import socket
import sys
s = socket.socket()
s.settimeout(0.2)
assert s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0
s.close()
PY

# Regression: bash checks pending signal traps before the first command of the
# EXIT trap string, so a second TERM that is already pending when the first
# TERM's `exit` starts the EXIT trap used to longjmp out before cleanup ran,
# leaving the state file and the frontend behind (pre-fix ~65% of iterations).
# The signal traps now run cleanup themselves. Two back-to-back TERMs to the
# script pid hit that window; the loop makes a regression practically certain.
for iteration in $(seq 1 20); do
  port=$(free_port)
  PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" \
    SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 \
    bash "$script" ui >"$temp_dir/signal-window.out" 2>&1 &
  sandbox_pid=$!
  wait_for_ready "$temp_dir/signal-window.out" || fail "signal-window sandbox did not become ready (iteration $iteration)"
  frontend_pid=$(find_frontend_pid "$sandbox_pid" "$port" "$temp_dir/signal-window.out") \
    || fail "could not find signal-window frontend child (iteration $iteration)"
  kill -TERM "$sandbox_pid"
  kill -TERM "$sandbox_pid" 2>/dev/null || true
  set +e
  wait "$sandbox_pid"
  status=$?
  set -e
  sandbox_pid=""
  frontend_alive=0
  kill -0 "$frontend_pid" 2>/dev/null && frontend_alive=1
  kill -KILL "$frontend_pid" 2>/dev/null || true
  if [[ -e "$state_dir/ui.json" || "$frontend_alive" -ne 0 ]]; then
    echo "residual $state_dir/ui.json (iteration $iteration, script exit $status):" >&2
    cat "$state_dir/ui.json" >&2 2>/dev/null || echo "(absent)" >&2
    echo "signal-window sandbox output:" >&2
    cat "$temp_dir/signal-window.out" >&2 || true
    rm -f "$state_dir/ui.json"
    fail "second TERM in the exit path skipped cleanup (iteration $iteration; frontend alive: $frontend_alive)"
  fi
  [[ "$status" -eq 143 ]] || fail "signal-window TERM returned $status instead of 143 (iteration $iteration)"
done

cat >"$temp_dir/supervised.mk" <<'MAKE'
supervised-ui:
	@exec bash "$(SCRIPT)" ui
MAKE
port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 SCRIPT="$script" \
  setsid make -f "$temp_dir/supervised.mk" supervised-ui >"$temp_dir/supervised.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/supervised.out" || fail "supervised recipe sandbox did not become ready"
state_pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$state_dir/ui.json")
state_ppid=$(ps -o ppid= -p "$state_pid" | tr -d ' ')
[[ "$state_ppid" == "$sandbox_pid" ]] || fail "recipe shell did not exec the sandbox script"
supervised_pgid=$sandbox_pid
kill -TERM -- "-$sandbox_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -ne 0 ]] || fail "supervised recipe unexpectedly exited successfully after TERM"
# GNU make blocks on its local child when TERMed, so once wait returns the
# script's EXIT trap has already run: the script must be gone and the state
# file removed. The deadlines are generous so timing only matters when
# cleanup is genuinely broken.
dump_supervised_residue() {
  echo "residual $state_dir/ui.json:" >&2
  cat "$state_dir/ui.json" >&2 2>/dev/null || echo "(absent)" >&2
  echo "processes in group $supervised_pgid:" >&2
  ps -eo pid,ppid,pgid,stat,command | awk -v pg="$supervised_pgid" 'NR == 1 || $3 == pg' >&2
  echo "supervised recipe output:" >&2
  cat "$temp_dir/supervised.out" >&2 || true
}
for _ in {1..500}; do
  kill -0 "$state_pid" 2>/dev/null || break
  sleep 0.02
done
if kill -0 "$state_pid" 2>/dev/null; then
  dump_supervised_residue
  fail "sandbox script pid $state_pid still alive 10s after the supervised recipe exited"
fi
for _ in {1..500}; do
  [[ ! -e "$state_dir/ui.json" ]] && break
  sleep 0.02
done
if [[ -e "$state_dir/ui.json" ]]; then
  dump_supervised_residue
  fail "state remained after external TERM of the recipe process tree"
fi
python3 - "$port" <<'PY' || fail "supervised recipe listener remained after TERM"
import socket
import sys
s = socket.socket()
s.settimeout(0.2)
assert s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0
s.close()
PY

cat >"$state_dir/stale.json" <<'JSON'
{"mode":"ui","pid":99999999}
JSON
if SANDBOX_STATE_DIR="$state_dir" bash "$script" status >"$temp_dir/stale.out" 2>"$temp_dir/stale.err"; then
  fail "sandbox status succeeded for a stale pid"
fi
[[ ! -e "$state_dir/stale.json" ]] || fail "stale state file was not removed"
grep -q 'Stale sandbox state:' "$temp_dir/stale.err" || fail "stale state file was not reported"

sleep 30 &
foreign_pid=$!
foreign_port=$(free_port)
cat >"$state_dir/foreign.json" <<JSON
{"mode":"ui","pid":$foreign_pid,"devPort":$foreign_port,"pidStartTime":"proc:not-this-process","pidCommandLine":"dev-sandbox.sh ui"}
JSON
if SANDBOX_STATE_DIR="$state_dir" bash "$script" status >"$temp_dir/foreign-status.out" 2>"$temp_dir/foreign-status.err"; then
  fail "sandbox status accepted a foreign live PID"
fi
grep -q 'PID identity does not match recorded sandbox' "$temp_dir/foreign-status.err" \
  || fail "foreign live PID was not reported as stale"
kill -0 "$foreign_pid" 2>/dev/null || fail "sandbox status signalled a foreign live PID"
cat >"$state_dir/ui.json" <<JSON
{"mode":"ui","pid":$foreign_pid,"devPort":$foreign_port,"pidStartTime":"proc:not-this-process","pidCommandLine":"dev-sandbox.sh ui"}
JSON
MODE=ui SANDBOX_STATE_DIR="$state_dir" bash "$script" stop >"$temp_dir/foreign-stop.out" 2>"$temp_dir/foreign-stop.err"
grep -q 'Removing stale sandbox state:' "$temp_dir/foreign-stop.err" \
  || fail "sandbox-stop did not report the foreign PID state as stale"
kill -0 "$foreign_pid" 2>/dev/null || fail "sandbox-stop signalled a foreign live PID"
kill "$foreign_pid"
wait "$foreign_pid" 2>/dev/null || true
foreign_pid=""

sleep 30 &
dummy_pid=$!
write_live_state "$state_dir/ui.json" ui "$dummy_pid" "$(free_port)"
(
  while [[ -e "$state_dir/ui.json" ]]; do sleep 0.05; done
  printf '%s\n' '{"mode":"ui","pid":99999999,"devPort":1}' >"$state_dir/ui.json"
) &
restart_writer_pid=$!
MODE=ui SANDBOX_STATE_DIR="$state_dir" bash "$script" stop >"$temp_dir/restart-stop.out" 2>"$temp_dir/restart-stop.err"
wait "$dummy_pid" 2>/dev/null || true
wait "$restart_writer_pid"
grep -q 'sandbox ui restarted .* stop it with ws.script.stop instead' "$temp_dir/restart-stop.err" || fail "supervised restart warning was not printed"
rm -f "$state_dir/ui.json"

port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" SANDBOX_STATE_DIR="$state_dir" \
  SANDBOX_READY_TIMEOUT=5 bash "$script" ui >"$temp_dir/child-failure.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/child-failure.out" || fail "child-failure sandbox did not become ready"
frontend_pid=$(find_frontend_pid "$sandbox_pid" "$port" "$temp_dir/child-failure.out") \
  || fail "could not find frontend child"
kill -KILL "$frontend_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -ne 0 ]] || fail "frontend child failure was not propagated"
[[ ! -e "$state_dir/ui.json" ]] || fail "state file remained after frontend child failure"
[[ -f "$state_dir/ui.port" ]] || fail "pinned port record was not written on readiness"
grep -qx "DEV_PORT=$port" "$state_dir/ui.port" || fail "pinned port record did not hold the ready DEV_PORT"

# Regression for intent-hq/intent#4619: a supervised restart with a derived
# (Makefile-default) port comes back on the recorded port, even when the derived
# block moved, so the existing tunnel URL stays valid.
pinned_port=$port
derived_port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$derived_port" DEV_PORT_ORIGIN=file \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 bash "$script" ui >"$temp_dir/pinned-restart.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/pinned-restart.out" || fail "pinned restart sandbox did not become ready"
grep -q "Reusing recorded DEV_PORT=$pinned_port from $state_dir/ui.port" "$temp_dir/pinned-restart.out" \
  || fail "pinned restart did not report the reused port"
grep -q "^Sandbox ready: http://127.0.0.1:$pinned_port/" "$temp_dir/pinned-restart.out" \
  || fail "pinned restart did not come back on the recorded port"
python3 - "$state_dir/ui.json" "$pinned_port" <<'PY' || fail "pinned restart state did not record the reused port"
import json
import sys
assert json.load(open(sys.argv[1], encoding="utf-8"))["devPort"] == int(sys.argv[2])
PY
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""
[[ -f "$state_dir/ui.port" ]] || fail "pinned port record did not survive a TERM exit"

# A busy recorded port falls back to the derived port and names the holder.
python3 - "$pinned_port" "$busy_ready.pinned" <<'PY' &
import pathlib
import socket
import sys
import time

sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen()
pathlib.Path(sys.argv[2]).touch()
time.sleep(30)
PY
listener_pid=$!
for _ in {1..100}; do
  [[ -e "$busy_ready.pinned" ]] && break
  sleep 0.01
done
[[ -e "$busy_ready.pinned" ]] || fail "pinned-port listener did not start"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$derived_port" DEV_PORT_ORIGIN=file \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 bash "$script" ui >"$temp_dir/pinned-busy.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/pinned-busy.out" || fail "sandbox with a busy recorded port did not become ready"
grep -q "recorded DEV_PORT=$pinned_port from $state_dir/ui.port is busy; starting on derived DEV_PORT=$derived_port" "$temp_dir/pinned-busy.out" \
  || fail "busy recorded port fallback was not reported"
grep -q "127.0.0.1:$pinned_port is held by PID $listener_pid" "$temp_dir/pinned-busy.out" \
  || fail "busy recorded port did not name the owning PID"
grep -q "^Sandbox ready: http://127.0.0.1:$derived_port/" "$temp_dir/pinned-busy.out" \
  || fail "busy recorded port did not fall back to the derived port"
grep -qx "DEV_PORT=$derived_port" "$state_dir/ui.port" || fail "pinned port record was not re-pointed at the fallback port"
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""
kill "$listener_pid"
wait "$listener_pid" 2>/dev/null || true
listener_pid=""

# A recorded DEV_PORT that equals an explicit DEV_TCP_PORT is never reused: the
# resolved pair must stay unique. The record now points at $derived_port.
collide_port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$collide_port" DEV_PORT_ORIGIN=file \
  DEV_TCP_PORT="$derived_port" DEV_TCP_PORT_ORIGIN="command line" \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 bash "$script" ui >"$temp_dir/pinned-collide.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/pinned-collide.out" || fail "sandbox with a colliding recorded port did not become ready"
grep -q "recorded DEV_PORT=$derived_port from $state_dir/ui.port collides with explicit DEV_TCP_PORT=$derived_port; starting on derived DEV_PORT=$collide_port" "$temp_dir/pinned-collide.out" \
  || fail "colliding recorded port was not reported"
! grep -q 'Reusing recorded DEV_PORT' "$temp_dir/pinned-collide.out" || fail "recorded DEV_PORT was reused despite colliding with DEV_TCP_PORT"
grep -q "^Sandbox ready: http://127.0.0.1:$collide_port/" "$temp_dir/pinned-collide.out" \
  || fail "colliding recorded port was not replaced by the derived port"
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""

# An explicit port always wins over the recorded one.
explicit_port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$explicit_port" DEV_PORT_ORIGIN="command line" \
  SANDBOX_STATE_DIR="$state_dir" SANDBOX_READY_TIMEOUT=5 bash "$script" ui >"$temp_dir/explicit-restart.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/explicit-restart.out" || fail "explicit-port sandbox did not become ready"
grep -q "^Sandbox ready: http://127.0.0.1:$explicit_port/" "$temp_dir/explicit-restart.out" \
  || fail "explicit DEV_PORT was overridden by the recorded port"
! grep -q 'Reusing recorded DEV_PORT' "$temp_dir/explicit-restart.out" || fail "explicit DEV_PORT reported a recorded-port reuse"
MODE=ui SANDBOX_STATE_DIR="$state_dir" bash "$script" stop >/dev/null
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""
[[ ! -e "$state_dir/ui.port" ]] || fail "sandbox-stop did not forget the pinned port record"

if PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" \
  SANDBOX_STATE_DIR="$state_dir" INTENTD_SOCKET="$temp_dir/missing.sock" bash "$script" app >"$temp_dir/app.out" 2>&1; then
  fail "app sandbox accepted a missing daemon socket"
fi
grep -q 'absent or not accepting connections' "$temp_dir/app.out" || fail "missing socket error was unclear"

port=$(free_port)
data_dir="$temp_dir/data"
cargo_log="$temp_dir/dev-cargo.log"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_DATA_DIR="$data_dir" \
  DEV_TCP_PORT=43211 SANDBOX_STATE_DIR="$state_dir" \
  INTENTD_DIR="$temp_dir/intentd" INTENTD_TARGET_DIR="$temp_dir/target" BUILD_JOBS=8 \
  CARGO_LOG="$cargo_log" FAKE_INTENTD_SOURCE="$temp_dir/fake-intentd" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/stack.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/stack.out" || fail "stack sandbox did not become ready"
[[ $(grep -c '^Sandbox ready:' "$temp_dir/stack.out") -eq 1 ]] || fail "stack ready line was not printed exactly once"
python3 - "$state_dir/stack.json" <<'PY' || fail "dev stack state metadata was incorrect"
import json
import sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
assert state["intentdSource"] == "dev" and state["tcpPort"] == 43211
assert isinstance(state["socket"], str) and state["socket"].endswith("/intentd.sock")
PY
grep -q -- '-p intentd .*--jobs 8' "$cargo_log" || fail "dev build did not honor BUILD_JOBS"
! grep -q -- '--release' "$cargo_log" || fail "default build unexpectedly used release profile"
grep -q "Starting intentd binary: $temp_dir/target/debug/intentd" "$temp_dir/stack.out" || fail "default binary path was not target/debug/intentd"
grep -q 'Sandbox health endpoint unavailable; using socket/HTTP readiness probes.' "$temp_dir/stack.out" || fail "legacy health fallback was not reported"
python3 - "$data_dir/intentd.sock" <<'PY' || fail "stack socket was not connectable"
import socket
import sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
s.close()
PY
kill -TERM "$sandbox_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -eq 143 ]] || fail "stack SIGTERM returned $status instead of 143"
[[ ! -e "$state_dir/stack.json" ]] || fail "stack state file remained after SIGTERM"
sleep 0.2
pgrep -f "$temp_dir/fake-intentd|$data_dir/intentd.sock" >/dev/null && fail "stack left an intentd descendant"
pgrep -f "python3 - $port" >/dev/null && fail "stack left a frontend descendant"

port=$(free_port)
cargo_log="$temp_dir/release-cargo.log"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_DATA_DIR="$temp_dir/release-data" \
  SANDBOX_STATE_DIR="$state_dir" \
  INTENTD_DIR="$temp_dir/intentd" INTENTD_TARGET_DIR="$temp_dir/target" INTENTD_PROFILE=release \
  CARGO_LOG="$cargo_log" FAKE_INTENTD_SOURCE="$temp_dir/fake-intentd" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/release.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/release.out" || fail "release-profile stack did not become ready"
grep -q -- '--release' "$cargo_log" || fail "release profile did not pass --release"
grep -q "Starting intentd binary: $temp_dir/target/release/intentd" "$temp_dir/release.out" || fail "release binary path was incorrect"
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""

port=$(free_port)
override_log="$temp_dir/override-cargo.log"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_DATA_DIR="$temp_dir/override-data" \
  SANDBOX_STATE_DIR="$state_dir" \
  INTENTD_BIN="$temp_dir/fake-intentd" CARGO_LOG="$override_log" HEALTH_MODE=ok SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/override.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/override.out" || fail "INTENTD_BIN override stack did not become healthy"
[[ ! -e "$override_log" ]] || fail "INTENTD_BIN override did not skip cargo build"
grep -q "Using INTENTD_BIN override: $temp_dir/fake-intentd" "$temp_dir/override.out" || fail "INTENTD_BIN override was not echoed"
grep -q 'Sandbox health is ok; Vite warm-up complete.' "$temp_dir/override.out" || fail "healthy warm-up was not logged"
python3 - "$state_dir/stack.json" <<'PY' || fail "healthy warm-up state was incorrect"
import json
import sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
assert state["intentdSource"] == "bin"
assert state["warm"]["ok"] is True and state["warm"]["ms"] >= 0
PY
warm_line=$(grep -n 'Sandbox health is ok' "$temp_dir/override.out" | cut -d: -f1)
ready_line=$(grep -n '^Sandbox ready:' "$temp_dir/override.out" | cut -d: -f1)
[[ "$warm_line" -lt "$ready_line" ]] || fail "readiness was announced before warm-up finished"
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""

set +e
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" DEV_DATA_DIR="$temp_dir/unhealthy-data" \
  SANDBOX_STATE_DIR="$state_dir" INTENTD_BIN="$temp_dir/fake-intentd" HEALTH_MODE=pending \
  SANDBOX_READY_TIMEOUT=5 SANDBOX_WARM_TIMEOUT=1 \
  bash "$script" stack >"$temp_dir/unhealthy.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "unhealthy sandbox returned $status instead of 1"
grep -q 'sandbox health was not ok within 1s' "$temp_dir/unhealthy.out" || fail "health timeout was not reported"
! grep -q '^Sandbox ready:' "$temp_dir/unhealthy.out" || fail "readiness was announced while health was not ok"

cat >"$temp_dir/failing-intentd" <<'SH'
#!/usr/bin/env bash
exit 7
SH
chmod +x "$temp_dir/failing-intentd"
set +e
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" DEV_DATA_DIR="$temp_dir/fail-data" \
  SANDBOX_STATE_DIR="$state_dir" INTENTD_BIN="$temp_dir/failing-intentd" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/fail.out" 2>&1
status=$?
set -e
[[ "$status" -eq 7 ]] || fail "intentd child status was not propagated (got $status)"

bootstrap_root="$temp_dir/bootstrap-root"
bootstrap_bin="$temp_dir/bootstrap-bin"
corepack_cache="$temp_dir/corepack-cache"
mkdir -p "$bootstrap_root/scripts" "$bootstrap_root/packages/intentd" \
  "$bootstrap_root/packages/cloudlands-fe" "$bootstrap_bin" "$corepack_cache"
cp "$repo_root/scripts/bootstrap-dev-host.sh" "$bootstrap_root/scripts/bootstrap-dev-host.sh"
touch "$bootstrap_root/packages/intentd/.git" "$bootstrap_root/packages/cloudlands-fe/.git"
printf 'channel = "1.96.0"\n' >"$bootstrap_root/packages/intentd/rust-toolchain.toml"
printf '{"packageManager":"pnpm@10.30.3"}\n' >"$bootstrap_root/packages/cloudlands-fe/package.json"
cat >"$bootstrap_bin/corepack" <<'SH'
#!/usr/bin/env bash
printf '0.35.0\n'
SH
cat >"$bootstrap_bin/pnpm" <<'SH'
#!/usr/bin/env bash
mkdir -p "$COREPACK_HOME/v1/pnpm/10.30.3"
touch "$COREPACK_HOME/v1/pnpm/10.30.3/downloaded"
printf '10.30.3\n'
SH
write_gh_stub() {
  cat >"$bootstrap_bin/gh" <<SH
#!/usr/bin/env bash
case "\$1 \${2:-}" in
  "--version ") printf 'gh version $1 (2025-01-01)\nhttps://github.com/cli/cli/releases/tag/v$1\n' ;;
  "auth status") exit $2 ;;
  *) exit 2 ;;
esac
SH
  chmod +x "$bootstrap_bin/gh"
}
write_gh_stub 2.45.0 1
chmod +x "$bootstrap_bin/corepack" "$bootstrap_bin/pnpm"
set +e
COREPACK_HOME="$corepack_cache" PATH="$bootstrap_bin:$PATH" \
  bash "$bootstrap_root/scripts/bootstrap-dev-host.sh" --check >"$temp_dir/bootstrap-check.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "fixture doctor returned $status instead of reporting its expected gaps"
[[ -z $(find "$corepack_cache" -mindepth 1 -print -quit) ]] \
  || fail "check-only pnpm probe invoked the Corepack shim and populated its cache"
grep -q '^\[missing\]  GitHub CLI: gh 2\.45\.0 is below the required 2\.94\.0' "$temp_dir/bootstrap-check.out" \
  || fail "outdated gh 2.45.0 was not reported as a missing gap naming 2.94.0"

write_gh_stub 2.100.0 0
set +e
COREPACK_HOME="$corepack_cache" PATH="$bootstrap_bin:$PATH" \
  bash "$bootstrap_root/scripts/bootstrap-dev-host.sh" --check >"$temp_dir/bootstrap-check-gh-ok.out" 2>&1
set -e
grep -q '^\[ok\]       GitHub CLI: gh 2\.100\.0 (>= 2\.94\.0), authenticated' "$temp_dir/bootstrap-check-gh-ok.out" \
  || fail "gh 2.100.0 was not accepted as satisfying >= 2.94.0"
! grep -q '^\[missing\]  GitHub CLI' "$temp_dir/bootstrap-check-gh-ok.out" \
  || fail "gh 2.100.0 was reported as a missing gap"

write_gh_stub 2.94.0 0
set +e
COREPACK_HOME="$corepack_cache" PATH="$bootstrap_bin:$PATH" \
  bash "$bootstrap_root/scripts/bootstrap-dev-host.sh" --check >"$temp_dir/bootstrap-check-gh-min.out" 2>&1
set -e
grep -q '^\[ok\]       GitHub CLI: gh 2\.94\.0 (>= 2\.94\.0), authenticated' "$temp_dir/bootstrap-check-gh-min.out" \
  || fail "gh 2.94.0 (exact minimum) was not accepted as satisfying >= 2.94.0"

write_gh_stub 2.94.0-rc.1 0
set +e
COREPACK_HOME="$corepack_cache" PATH="$bootstrap_bin:$PATH" \
  bash "$bootstrap_root/scripts/bootstrap-dev-host.sh" --check >"$temp_dir/bootstrap-check-gh-rc.out" 2>&1
set -e
grep -q '^\[missing\]  GitHub CLI: gh 2\.94\.0-rc\.1 is below the required 2\.94\.0' "$temp_dir/bootstrap-check-gh-rc.out" \
  || fail "prerelease gh 2.94.0-rc.1 was not reported as a missing gap below 2.94.0"

write_gh_stub 2.95.0-rc.1 0
set +e
COREPACK_HOME="$corepack_cache" PATH="$bootstrap_bin:$PATH" \
  bash "$bootstrap_root/scripts/bootstrap-dev-host.sh" --check >"$temp_dir/bootstrap-check-gh-next-rc.out" 2>&1
set -e
grep -q '^\[ok\]       GitHub CLI: gh 2\.95\.0-rc\.1 (>= 2\.94\.0), authenticated' "$temp_dir/bootstrap-check-gh-next-rc.out" \
  || fail "prerelease gh 2.95.0-rc.1 of a newer release was not accepted as satisfying >= 2.94.0"

# install_gh on macOS: exercise the function alone with a stubbed uname/brew/gh.
bootstrap_funcs="$temp_dir/bootstrap-funcs.sh"
sed '/^if \[\[ "\$MODE" == check \]\]; then$/,$d' "$bootstrap_root/scripts/bootstrap-dev-host.sh" >"$bootstrap_funcs"
grep -q '^install_gh() {' "$bootstrap_funcs" || fail "could not extract bootstrap functions for the install_gh fixture"
! grep -q '^install_gh$' "$bootstrap_funcs" || fail "bootstrap function extraction kept the main install flow"
brew_bin="$temp_dir/brew-bin"
mkdir -p "$brew_bin"
printf '#!/usr/bin/env bash\nprintf "Darwin\\n"\n' >"$brew_bin/uname"
cat >"$brew_bin/brew" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$BREW_LOG"
case "$*" in
  "list --versions gh") [[ "$BREW_OWNS_GH" == 1 ]] ;;
  "install gh"|"upgrade gh") [[ -n "${BREW_GH_RESULT:-}" ]] && "$BREW_WRITE_GH_STUB" "$BREW_GH_RESULT" 0; exit 0 ;;
  *) exit 2 ;;
esac
SH
cat >"$brew_bin/write-gh-stub" <<SH
#!/usr/bin/env bash
bootstrap_bin="$bootstrap_bin"
$(declare -f write_gh_stub)
write_gh_stub "\$@"
SH
chmod +x "$brew_bin/uname" "$brew_bin/brew" "$brew_bin/write-gh-stub"
run_install_gh() {
  BREW_LOG="$temp_dir/brew.log" BREW_OWNS_GH="$1" BREW_GH_RESULT="${2:-}" BREW_WRITE_GH_STUB="$brew_bin/write-gh-stub" \
    PATH="$brew_bin:$bootstrap_bin:$PATH" \
    bash -c 'funcs=$1; set --; source "$funcs"; install_gh' bash "$bootstrap_funcs" >"$temp_dir/install-gh.out" 2>&1
}

write_gh_stub 2.45.0 0
: >"$temp_dir/brew.log"
set +e
run_install_gh 0 2.100.0
status=$?
set -e
[[ "$status" -eq 0 ]] || fail "install_gh failed ($status) when brew install produced a current gh: $(cat "$temp_dir/install-gh.out")"
grep -qx 'install gh' "$temp_dir/brew.log" || fail "a gh not owned by Homebrew did not trigger brew install gh"
! grep -qx 'upgrade gh' "$temp_dir/brew.log" || fail "brew upgrade gh ran for a gh the gh formula does not own"

write_gh_stub 2.45.0 0
: >"$temp_dir/brew.log"
set +e
run_install_gh 1 2.100.0
status=$?
set -e
[[ "$status" -eq 0 ]] || fail "install_gh failed ($status) when brew upgrade produced a current gh: $(cat "$temp_dir/install-gh.out")"
grep -qx 'upgrade gh' "$temp_dir/brew.log" || fail "a Homebrew-owned gh did not trigger brew upgrade gh"
! grep -qx 'install gh' "$temp_dir/brew.log" || fail "brew install gh ran for a gh the gh formula already owns"

write_gh_stub 2.45.0 0
: >"$temp_dir/brew.log"
set +e
run_install_gh 0
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "install_gh returned $status instead of 1 when a stale gh kept shadowing the installed one"
grep -q "^ERROR: gh 2\.45\.0 ($bootstrap_bin/gh) is still below 2\.94\.0 after install\." "$temp_dir/install-gh.out" \
  || fail "shadowed gh error did not name the stale binary and version: $(cat "$temp_dir/install-gh.out")"
grep -q 'shadows the new one.*https://github.com/cli/cli#installation' "$temp_dir/install-gh.out" \
  || fail "shadowed gh error did not explain PATH shadowing with the install URL"

# Frontend-toolchain preflight (bootstrap-dev-host.sh --check-frontend and the
# dev-sandbox.sh guard). The fixtures are self-contained under $temp_dir and run
# on a sanitized PATH so the host's real corepack/pnpm — present or absent —
# cannot decide the outcome.
fe_root="$temp_dir/fe-preflight-root"
fe_stub_bin="$temp_dir/fe-preflight-bin"
sanitized_bin="$temp_dir/fe-preflight-sanitized-bin"
fe_cargo_home="$temp_dir/fe-preflight-cargo-home"
fe_bootstrap="$fe_root/scripts/bootstrap-dev-host.sh"
mkdir -p "$fe_root/scripts" "$fe_root/packages/intentd" "$fe_root/packages/cloudlands-fe" \
  "$fe_stub_bin" "$sanitized_bin"
cp "$repo_root/scripts/bootstrap-dev-host.sh" "$fe_bootstrap"
touch "$fe_root/packages/intentd/.git" "$fe_root/packages/cloudlands-fe/.git"
printf 'channel = "1.96.0"\n' >"$fe_root/packages/intentd/rust-toolchain.toml"
printf '{"packageManager":"pnpm@10.30.3"}\n' >"$fe_root/packages/cloudlands-fe/package.json"
for tool in bash sh env sed head grep find cat rm mkdir mktemp touch dirname date sleep tr uname ps pgrep python3; do
  tool_path=$(command -v "$tool" 2>/dev/null) || continue
  [[ "$tool_path" == /* ]] || continue
  ln -sf "$tool_path" "$sanitized_bin/$tool"
done
if (PATH="$sanitized_bin"; command -v corepack >/dev/null 2>&1); then
  fail "sanitized PATH still resolves corepack; the absent-corepack fixtures would be meaningless"
fi
cat >"$fe_stub_bin/corepack" <<'SH'
#!/usr/bin/env bash
printf '0.35.0\n'
SH
cat >"$fe_stub_bin/pnpm" <<'SH'
#!/usr/bin/env bash
mkdir -p "$COREPACK_HOME/v1/pnpm/10.30.3"
touch "$COREPACK_HOME/v1/pnpm/10.30.3/downloaded"
printf '10.30.3\n'
SH
chmod +x "$fe_stub_bin/corepack" "$fe_stub_bin/pnpm"

ready_cache="$temp_dir/fe-preflight-cache-ready"
mkdir -p "$ready_cache/v1/pnpm/10.30.3"
touch "$ready_cache/v1/pnpm/10.30.3/.corepack"
set +e
PATH="$fe_stub_bin:$sanitized_bin" COREPACK_HOME="$ready_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check-frontend >"$temp_dir/fe-ready.out" 2>&1
status=$?
set -e
[[ "$status" -eq 0 ]] || fail "--check-frontend returned $status on a ready frontend toolchain"
[[ ! -s "$temp_dir/fe-ready.out" ]] || fail "--check-frontend was not silent on a ready frontend toolchain"
[[ ! -e "$ready_cache/v1/pnpm/10.30.3/downloaded" ]] \
  || fail "--check-frontend invoked the Corepack pnpm shim instead of reading its cache metadata"

no_corepack_cache="$temp_dir/fe-preflight-cache-no-corepack"
mkdir -p "$no_corepack_cache"
set +e
PATH="$sanitized_bin" COREPACK_HOME="$no_corepack_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check-frontend >"$temp_dir/fe-no-corepack.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "--check-frontend returned $status instead of 1 without corepack"
grep -qx '\[missing\]  Corepack: required to select the frontend pnpm version' "$temp_dir/fe-no-corepack.out" \
  || fail "--check-frontend did not report the missing Corepack in doctor's wording"
grep -qx 'run: make bootstrap-dev-host' "$temp_dir/fe-no-corepack.out" \
  || fail "--check-frontend did not name the fix (make bootstrap-dev-host)"

unpinned_cache="$temp_dir/fe-preflight-cache-unpinned"
mkdir -p "$unpinned_cache"
set +e
PATH="$fe_stub_bin:$sanitized_bin" COREPACK_HOME="$unpinned_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check-frontend >"$temp_dir/fe-unpinned.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "--check-frontend returned $status instead of 1 without the pinned pnpm"
grep -q 'frontend package manager: expected pnpm@10.30.3 via Corepack' "$temp_dir/fe-unpinned.out" \
  || fail "--check-frontend did not report the unpinned frontend package manager"
! grep -q 'Corepack: required to select' "$temp_dir/fe-unpinned.out" \
  || fail "--check-frontend reported Corepack missing while it was on PATH"
[[ -z $(find "$unpinned_cache" -mindepth 1 -print -quit) ]] \
  || fail "--check-frontend populated the Corepack cache while reporting the pinned pnpm gap"

# Drift guard: doctor and the preflight must print the same [missing] lines for
# the two frontend items, byte for byte, on the same fixture.
set +e
PATH="$sanitized_bin" COREPACK_HOME="$no_corepack_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check >"$temp_dir/fe-doctor.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "fixture doctor returned $status instead of reporting the frontend gaps"
fe_missing_pattern='^\[missing\]  (Corepack|frontend package manager|frontend packageManager):'
grep -E "$fe_missing_pattern" "$temp_dir/fe-doctor.out" >"$temp_dir/fe-doctor.lines" \
  || fail "fixture doctor printed no frontend [missing] lines"
grep -E "$fe_missing_pattern" "$temp_dir/fe-no-corepack.out" >"$temp_dir/fe-preflight.lines" \
  || fail "--check-frontend printed no frontend [missing] lines"
[[ $(wc -l <"$temp_dir/fe-doctor.lines") -eq 2 ]] \
  || fail "fixture doctor did not report both frontend items as missing"
cmp -s "$temp_dir/fe-doctor.lines" "$temp_dir/fe-preflight.lines" \
  || fail "doctor and --check-frontend disagree on the frontend [missing] wording"

# A Corepack that is on PATH but fails its bounded launcher probe
# (intent-hq/intent#4635) is a third outcome: both modes must report the probe
# error itself, in the same words, rather than claiming Corepack is absent.
broken_stub_bin="$temp_dir/fe-preflight-broken-bin"
mkdir -p "$broken_stub_bin"
cat >"$broken_stub_bin/corepack" <<'SH'
#!/usr/bin/env bash
echo "corepack: cannot find dist/corepack.js" >&2
exit 1
SH
chmod +x "$broken_stub_bin/corepack"
broken_cache="$temp_dir/fe-preflight-cache-broken"
mkdir -p "$broken_cache"
set +e
PATH="$broken_stub_bin:$sanitized_bin" COREPACK_HOME="$broken_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check-frontend >"$temp_dir/fe-broken.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "--check-frontend returned $status instead of 1 on a failing Corepack probe"
grep -q "\[missing\]  Corepack: 'corepack --version' failed with exit 1 via $broken_stub_bin/corepack" \
  "$temp_dir/fe-broken.out" || fail "--check-frontend did not report the Corepack probe error"
! grep -q 'Corepack: required to select' "$temp_dir/fe-broken.out" \
  || fail "--check-frontend claimed Corepack was absent while it was on PATH but broken"
set +e
PATH="$broken_stub_bin:$sanitized_bin" COREPACK_HOME="$broken_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check >"$temp_dir/fe-broken-doctor.out" 2>&1
set -e
grep -E "$fe_missing_pattern" "$temp_dir/fe-broken-doctor.out" >"$temp_dir/fe-broken-doctor.lines" \
  || fail "fixture doctor printed no frontend [missing] lines on a failing Corepack probe"
grep -E "$fe_missing_pattern" "$temp_dir/fe-broken.out" >"$temp_dir/fe-broken-preflight.lines" \
  || fail "--check-frontend printed no frontend [missing] lines on a failing Corepack probe"
cmp -s "$temp_dir/fe-broken-doctor.lines" "$temp_dir/fe-broken-preflight.lines" \
  || fail "doctor and --check-frontend disagree on the Corepack probe-error wording"

# Corepack installed but never `corepack enable`d: no pnpm shim on PATH, yet the
# pinned version sits in the Corepack cache, so `corepack pnpm run ...` — the
# command the guarded targets actually run — works. The preflight must not be
# stricter than the command it guards, while doctor keeps requiring the shim for
# the bare-pnpm targets (fe-launch, dev, run-fe-local).
corepack_only_bin="$temp_dir/fe-preflight-corepack-only-bin"
mkdir -p "$corepack_only_bin"
cp "$fe_stub_bin/corepack" "$corepack_only_bin/corepack"
chmod +x "$corepack_only_bin/corepack"
if (PATH="$corepack_only_bin:$sanitized_bin"; command -v pnpm >/dev/null 2>&1); then
  fail "the shim-less fixture still resolves a pnpm shim"
fi
shimless_cache="$temp_dir/fe-preflight-cache-shimless"
mkdir -p "$shimless_cache/v1/pnpm/10.30.3"
touch "$shimless_cache/v1/pnpm/10.30.3/.corepack"
set +e
PATH="$corepack_only_bin:$sanitized_bin" COREPACK_HOME="$shimless_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check-frontend >"$temp_dir/fe-shimless.out" 2>&1
status=$?
set -e
[[ "$status" -eq 0 ]] || fail "--check-frontend returned $status without a pnpm shim that corepack pnpm does not need"
[[ ! -s "$temp_dir/fe-shimless.out" ]] || fail "--check-frontend was not silent without a pnpm shim"
set +e
PATH="$corepack_only_bin:$sanitized_bin" COREPACK_HOME="$shimless_cache" CARGO_HOME="$fe_cargo_home" \
  bash "$fe_bootstrap" --check >"$temp_dir/fe-shimless-doctor.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "fixture doctor returned $status instead of flagging the absent pnpm shim"
grep -qx '\[missing\]  frontend package manager: expected pnpm@10.30.3 via Corepack' \
  "$temp_dir/fe-shimless-doctor.out" \
  || fail "doctor stopped requiring the pnpm shim its bare-pnpm targets need"

no_corepack_state="$temp_dir/no-corepack-state"
set +e
PATH="$sanitized_bin" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" \
  SANDBOX_STATE_DIR="$no_corepack_state" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" ui >"$temp_dir/no-corepack-ui.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "UI sandbox returned $status instead of 1 without corepack"
grep -q "\[dev-sandbox-ui\] ERROR: corepack is required to run the frontend; run 'make bootstrap-dev-host'." \
  "$temp_dir/no-corepack-ui.out" || fail "missing corepack message did not name the fix"
[[ ! -e "$no_corepack_state" ]] || fail "UI sandbox wrote state before failing the corepack preflight"

echo "dev-sandbox tests passed (daemon, cargo, and pnpm behavior stubbed)"
