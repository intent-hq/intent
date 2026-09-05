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

echo "dev-ports tests passed"