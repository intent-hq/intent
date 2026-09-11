#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/dev-ports.sh"
temp_dir=$(mktemp -d)
listener_pid=""

cleanup() {
  if [[ -n "$listener_pid" ]]; then
    kill "$listener_pid" 2>/dev/null || true
    wait "$listener_pid" 2>/dev/null || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  echo "dev-ports test failed: $*" >&2
  exit 1
}

make_bin=$(command -v make)

value_of() {
  local output=$1 key=$2 line
  while IFS= read -r line; do
    [[ "$line" == "$key="* ]] && printf '%s\n' "${line#*=}" && return 0
  done <<<"$output"
  return 1
}

mkdir -p "$temp_dir/worktree with spaces"
first=$(cd "$temp_dir/worktree with spaces" && bash "$script")
second=$(cd "$temp_dir/worktree with spaces" && bash "$script")
[[ "$first" == "$second" ]] || fail "the same path did not resolve deterministically"

ln -s "$temp_dir/worktree with spaces" "$temp_dir/worktree-link"
via_link=$(cd "$temp_dir/worktree-link" && bash "$script")
[[ "$first" == "$via_link" ]] || fail "a symlink did not hash its canonical path"

override=$(cd "$temp_dir" && DEV_PORT=61000 DEV_TCP_PORT=61001 BRIDGE_PORT=61002 CDP_PORT=61003 bash "$script")
[[ "$(value_of "$override" DEV_PORT)" == 61000 ]] || fail "DEV_PORT override lost"
[[ "$(value_of "$override" DEV_TCP_PORT)" == 61001 ]] || fail "DEV_TCP_PORT override lost"
[[ "$(value_of "$override" BRIDGE_PORT)" == 61002 ]] || fail "BRIDGE_PORT override lost"
[[ "$(value_of "$override" CDP_PORT)" == 61003 ]] || fail "CDP_PORT override lost"

preferred=$(cd "$temp_dir" && bash "$script")
busy_port=$(value_of "$preferred" DEV_PORT)
ready_file="$temp_dir/listener-ready"
python3 - "$busy_port" "$ready_file" <<'PY' &
import pathlib
import socket
import sys
import time

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(("127.0.0.1", int(sys.argv[1])))
sock.listen()
pathlib.Path(sys.argv[2]).touch()
time.sleep(30)
PY
listener_pid=$!
for _ in {1..100}; do
  [[ -e "$ready_file" ]] && break
  sleep 0.01
done
[[ -e "$ready_file" ]] || fail "test listener did not start"

remapped=$(cd "$temp_dir" && bash "$script" 2>"$temp_dir/remap.stderr")
[[ "$(value_of "$remapped" DEV_PORT)" != "$busy_port" ]] || fail "busy preferred port was not skipped"
grep -q 'WARNING: preferred port block is busy' "$temp_dir/remap.stderr" || fail "busy-port remap was silent"
grep -q 'DEV_PORT=.* make <target>' "$temp_dir/remap.stderr" || fail "remap did not print a pinning command"

if (cd "$temp_dir" && DEV_PORT="$busy_port" bash "$script" >"$temp_dir/explicit.stdout" 2>"$temp_dir/explicit.stderr"); then
  fail "busy explicit port was remapped instead of rejected"
fi
grep -q 'explicit DEV_PORT=.* is busy' "$temp_dir/explicit.stderr" || fail "busy explicit port error was unclear"

# Regression for intent-hq/intent#4619: a connection accepted and closed by a
# now-gone listener leaves TIME_WAIT state on the port, which is not a listener.
timewait_port=$(python3 - <<'PY'
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen()
port = server.getsockname()[1]
client = socket.create_connection(("127.0.0.1", port))
accepted, _ = server.accept()
accepted.close()
client.close()
server.close()
print(port)
PY
)
python3 - "$timewait_port" <<'PY' || fail "TIME_WAIT probe port unexpectedly accepts connections"
import socket
import sys
s = socket.socket()
s.settimeout(0.2)
assert s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0
s.close()
PY
timewait_output=$(cd "$temp_dir" && DEV_PORT="$timewait_port" bash "$script" 2>"$temp_dir/timewait.stderr") \
  || fail "a closed connection's TIME_WAIT state was reported as a busy port: $(cat "$temp_dir/timewait.stderr")"
[[ "$(value_of "$timewait_output" DEV_PORT)" == "$timewait_port" ]] || fail "TIME_WAIT port was not kept as the explicit DEV_PORT"

default_output=$(cd "$repo_root" && "$make_bin" -n)
grep -q 'cargo build --workspace' <<<"$default_output" || fail "plain make no longer selects the build target"
[[ $(head -n 1 <<<"$default_output") != 'set -- .dev/sandbox/'* ]] || fail "plain make still selects the ports target"

mkdir -p "$temp_dir/safe-bin" "$temp_dir/safe-home/.cargo/bin"
for command in bash cksum awk dirname; do
  ln -s "$(command -v "$command")" "$temp_dir/safe-bin/$command"
done
for target in help check doctor bootstrap-dev-host sandbox-stop; do
  HOME="$temp_dir/safe-home" PATH="$temp_dir/safe-bin" "$make_bin" -C "$repo_root" -n "$target" >/dev/null \
    || fail "make -n $target required Python during Makefile parsing"
done

mkdir -p "$temp_dir/busy-bin" "$temp_dir/busy-home/.cargo/bin"
for command in bash cksum awk dirname; do
  ln -s "$(command -v "$command")" "$temp_dir/busy-bin/$command"
done
cat >"$temp_dir/busy-bin/python3" <<'SH'
#!/usr/bin/env bash
: >"$PORT_PROBE_LOG"
exit 1
SH
chmod +x "$temp_dir/busy-bin/python3"
for target in help doctor sandbox-stop; do
  HOME="$temp_dir/busy-home" PATH="$temp_dir/busy-bin" PORT_PROBE_LOG="$temp_dir/port-probe.log" \
    "$make_bin" -C "$repo_root" -n "$target" >/dev/null \
    || fail "make -n $target required an available default port range"
done
[[ ! -e "$temp_dir/port-probe.log" ]] || fail "a non-listener target probed the default port range"

ports_output=$(cd "$repo_root" && "$make_bin" --no-print-directory ports)
for name in DEV_PORT DEV_TCP_PORT BRIDGE_PORT CDP_PORT; do
  grep -Eq "^$name=[0-9]+$" <<<"$ports_output" || fail "make ports did not resolve $name"
done
sandbox_dry_run=$(cd "$repo_root" && "$make_bin" --no-print-directory -n dev-sandbox-app)
grep -Eq 'DEV_PORT="[0-9]+" DEV_TCP_PORT="[0-9]+"' <<<"$sandbox_dry_run" \
  || fail "make -n dev-sandbox-app did not resolve its listener ports"

echo "dev-ports tests passed"
