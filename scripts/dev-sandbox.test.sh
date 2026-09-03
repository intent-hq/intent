#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/dev-sandbox.sh"
temp_dir=$(mktemp -d)
sandbox_pid=""

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
import os
import sys
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()
    def do_GET(self):
        if os.environ.get("WARM_FAIL") == "1":
            self.send_error(503)
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
  INTENTD_DIR="$temp_dir/intentd" INTENTD_TARGET_DIR="$temp_dir/target" PKG_CONFIG_FAIL=1 \
  CARGO_LOG="$missing_prereq_log" FAKE_INTENTD_SOURCE="$temp_dir/fake-intentd" \
  bash "$script" stack >"$temp_dir/missing-prereq.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || fail "missing OpenSSL metadata returned $status instead of 1"
[[ ! -e "$missing_prereq_log" ]] || fail "cargo ran before the OpenSSL prerequisite check"
grep -q "run 'make bootstrap-dev-host'" "$temp_dir/missing-prereq.out" || fail "missing prerequisite message was not actionable"

port=$(free_port)
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" ui >"$temp_dir/ui.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/ui.out" || fail "UI sandbox did not become ready"
[[ $(grep -c '^Sandbox ready:' "$temp_dir/ui.out") -eq 1 ]] || fail "UI ready line was not printed exactly once"
kill -TERM "$sandbox_pid"
set +e
wait "$sandbox_pid"
status=$?
set -e
sandbox_pid=""
[[ "$status" -eq 143 ]] || fail "UI SIGTERM returned $status instead of 143"

if PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" \
  INTENTD_SOCKET="$temp_dir/missing.sock" bash "$script" app >"$temp_dir/app.out" 2>&1; then
  fail "app sandbox accepted a missing daemon socket"
fi
grep -q 'absent or not accepting connections' "$temp_dir/app.out" || fail "missing socket error was unclear"

port=$(free_port)
data_dir="$temp_dir/data"
cargo_log="$temp_dir/dev-cargo.log"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_DATA_DIR="$data_dir" \
  INTENTD_DIR="$temp_dir/intentd" INTENTD_TARGET_DIR="$temp_dir/target" BUILD_JOBS=8 \
  CARGO_LOG="$cargo_log" FAKE_INTENTD_SOURCE="$temp_dir/fake-intentd" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/stack.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/stack.out" || fail "stack sandbox did not become ready"
[[ $(grep -c '^Sandbox ready:' "$temp_dir/stack.out") -eq 1 ]] || fail "stack ready line was not printed exactly once"
grep -q -- '-p intentd .*--jobs 8' "$cargo_log" || fail "dev build did not honor BUILD_JOBS"
! grep -q -- '--release' "$cargo_log" || fail "default build unexpectedly used release profile"
grep -q "Starting intentd binary: $temp_dir/target/debug/intentd" "$temp_dir/stack.out" || fail "default binary path was not target/debug/intentd"
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
sleep 0.2
pgrep -f "$temp_dir/fake-intentd|$data_dir/intentd.sock" >/dev/null && fail "stack left an intentd descendant"
pgrep -f "python3 - $port" >/dev/null && fail "stack left a frontend descendant"

port=$(free_port)
cargo_log="$temp_dir/release-cargo.log"
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$port" DEV_DATA_DIR="$temp_dir/release-data" \
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
  INTENTD_BIN="$temp_dir/fake-intentd" CARGO_LOG="$override_log" WARM_FAIL=1 SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/override.out" 2>&1 &
sandbox_pid=$!
wait_for_ready "$temp_dir/override.out" || fail "INTENTD_BIN override stack did not become ready after failed warm-up"
[[ ! -e "$override_log" ]] || fail "INTENTD_BIN override did not skip cargo build"
grep -q "Using INTENTD_BIN override: $temp_dir/fake-intentd" "$temp_dir/override.out" || fail "INTENTD_BIN override was not echoed"
grep -q 'WARNING: Vite warm-up failed or timed out; continuing.' "$temp_dir/override.out" || fail "failed warm-up was not logged"
warm_line=$(grep -n 'WARNING: Vite warm-up failed' "$temp_dir/override.out" | cut -d: -f1)
ready_line=$(grep -n '^Sandbox ready:' "$temp_dir/override.out" | cut -d: -f1)
[[ "$warm_line" -lt "$ready_line" ]] || fail "readiness was announced before warm-up finished"
kill -TERM "$sandbox_pid"
wait "$sandbox_pid" 2>/dev/null || true
sandbox_pid=""

cat >"$temp_dir/failing-intentd" <<'SH'
#!/usr/bin/env bash
exit 7
SH
chmod +x "$temp_dir/failing-intentd"
set +e
PATH="$temp_dir/bin:$PATH" FE_DIR="$temp_dir/fe" DEV_PORT="$(free_port)" DEV_DATA_DIR="$temp_dir/fail-data" \
  INTENTD_BIN="$temp_dir/failing-intentd" SANDBOX_READY_TIMEOUT=5 \
  bash "$script" stack >"$temp_dir/fail.out" 2>&1
status=$?
set -e
[[ "$status" -eq 7 ]] || fail "intentd child status was not propagated (got $status)"

echo "dev-sandbox tests passed"