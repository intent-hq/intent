#!/usr/bin/env bash

set -euo pipefail

readonly BASE_PORT=5200
readonly BLOCK_SIZE=4
readonly BLOCK_COUNT=1000
readonly PORT_NAMES=(DEV_PORT DEV_TCP_PORT BRIDGE_PORT CDP_PORT)

canonical_path=$(pwd -P)
path_hash=$(printf '%s' "$canonical_path" | cksum | awk '{print $1}')
preferred_block=$((path_hash % BLOCK_COUNT))

port_is_free() {
  python3 - "$1" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

explicit_value() {
  case "$1" in
    DEV_PORT) printf '%s' "${DEV_PORT-}" ;;
    DEV_TCP_PORT) printf '%s' "${DEV_TCP_PORT-}" ;;
    BRIDGE_PORT) printf '%s' "${BRIDGE_PORT-}" ;;
    CDP_PORT) printf '%s' "${CDP_PORT-}" ;;
  esac
}

validate_explicit_ports() {
  local name value normalized
  local seen_ports=" "
  for name in "${PORT_NAMES[@]}"; do
    value=$(explicit_value "$name")
    [[ -n "$value" ]] || continue
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((10#$value < 1 || 10#$value > 65535)); then
      echo "[dev-ports] ERROR: explicit $name=$value is not a valid TCP port (1-65535)." >&2
      return 1
    fi
    normalized=$((10#$value))
    if [[ "$seen_ports" == *" $normalized "* ]]; then
      echo "[dev-ports] ERROR: explicit port $normalized is assigned more than once." >&2
      return 1
    fi
    seen_ports+="$normalized "
    if ! port_is_free "$normalized"; then
      echo "[dev-ports] ERROR: explicit $name=$normalized is busy; explicit ports are never remapped." >&2
      return 1
    fi
  done
}

resolve_block() {
  local attempt base index name explicit candidate
  local -a values
  for ((attempt = 0; attempt < BLOCK_COUNT; attempt++)); do
    base=$((BASE_PORT + ((preferred_block + attempt) % BLOCK_COUNT) * BLOCK_SIZE))
    values=()
    for ((index = 0; index < ${#PORT_NAMES[@]}; index++)); do
      name=${PORT_NAMES[$index]}
      explicit=$(explicit_value "$name")
      values+=("${explicit:-$((base + index))}")
    done

    local unique=" "
    local available=1
    for candidate in "${values[@]}"; do
      candidate=$((10#$candidate))
      if [[ "$unique" == *" $candidate "* ]]; then
        available=0
        break
      fi
      unique+="$candidate "
      if ! port_is_free "$candidate"; then
        available=0
        break
      fi
    done
    ((available)) || continue

    if ((attempt > 0)); then
      echo "[dev-ports] WARNING: preferred port block is busy; using the next free block." >&2
      echo "[dev-ports] Resolved: DEV_PORT=${values[0]} DEV_TCP_PORT=${values[1]} BRIDGE_PORT=${values[2]} CDP_PORT=${values[3]}" >&2
      echo "[dev-ports] Pin it: DEV_PORT=${values[0]} DEV_TCP_PORT=${values[1]} BRIDGE_PORT=${values[2]} CDP_PORT=${values[3]} make <target>" >&2
    fi
    printf 'DEV_PORT=%s\nDEV_TCP_PORT=%s\nBRIDGE_PORT=%s\nCDP_PORT=%s\n' "${values[@]}"
    return 0
  done
  echo "[dev-ports] ERROR: no free per-worktree port block in ${BASE_PORT}-$((BASE_PORT + BLOCK_SIZE * BLOCK_COUNT - 1))." >&2
  return 1
}

command -v python3 >/dev/null 2>&1 || {
  echo "[dev-ports] ERROR: python3 is required to preflight development ports." >&2
  exit 1
}
validate_explicit_ports
resolve_block