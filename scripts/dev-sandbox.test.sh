#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/dev-sandbox.sh"
temp_dir=$(mktemp -d)
sandbox_pid=""
state_dir="$temp_dir/state"

cleanup() {
  if [[ -n "$sandbox_pid" ]]; then
    kill "$sandbox_pid" 2>/dev/null || true
    wait "$sandbox_pid" 2>/dev/null || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  echo "dev-sandbox test failed: $*" >&2
  exit 1
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
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

mkdir -p "$temp_dir/bin" "$temp_dir/fe"
cat >"$temp_dir/bin/corepack" <<'SH'
#!/usr/bin/env bash
exec python3 - "$DEV_PORT" <<'PY'
import http.server
import json
import os
import sys
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
required = {"mode", "pid", "devPort", "tcpPort", "url", "daemonLocalhostUrl", "socket", "intentdSource", "startedAt", "readyAt", "warm", "supervisor"}
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
kill -TERM -- "-$sandbox_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -ne 0 ]] || fail "supervised recipe unexpectedly exited successfully after TERM"
for _ in {1..50}; do
  [[ ! -e "$state_dir/ui.json" ]] && break
  sleep 0.02
done
[[ ! -e "$state_dir/ui.json" ]] || fail "state remained after external TERM of the recipe process tree"
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
dummy_pid=$!
cat >"$state_dir/ui.json" <<JSON
{"mode":"ui","pid":$dummy_pid,"devPort":$(free_port)}
JSON
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
frontend_pid=$(pgrep -P "$sandbox_pid" | head -1)
[[ -n "$frontend_pid" ]] || fail "could not find frontend child"
kill -KILL "$frontend_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -ne 0 ]] || fail "frontend child failure was not propagated"
[[ ! -e "$state_dir/ui.json" ]] || fail "state file remained after frontend child failure"

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

echo "dev-sandbox tests passed"