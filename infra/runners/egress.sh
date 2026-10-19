#!/usr/bin/env bash
# Block runner containers from private, tailnet and link-local networks.
#
# Rules live in the raw table (PREROUTING), which Docker, Tailscale and ufw do
# not reorder or flush, so they apply before any of their FORWARD/INPUT
# accepts. Runners still reach the internet and the cache's public IP.
# Usage: egress.sh [apply|check] [bridge]  (default: apply gh-runners0)
set -euo pipefail

mode="${1:-apply}"
bridge="${2:-gh-runners0}"
chain=GH-RUNNERS-EGRESS
blocked=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 0.0.0.0/8 127.0.0.0/8 224.0.0.0/4 240.0.0.0/4)
blocked6=(fc00::/7 fe80::/10 ::1/128 ff00::/8)

ipt() { "$1" -w -t raw "${@:2}"; }

apply() {
  local tool="$1"; shift
  ipt "$tool" -N "$chain" 2>/dev/null || ipt "$tool" -F "$chain"
  local net
  for net in "$@"; do ipt "$tool" -A "$chain" -d "$net" -j DROP; done
  ipt "$tool" -C PREROUTING -i "$bridge" -j "$chain" 2>/dev/null || ipt "$tool" -I PREROUTING 1 -i "$bridge" -j "$chain"
}

check() {
  local tool="$1"; shift
  ipt "$tool" -C PREROUTING -i "$bridge" -j "$chain" 2>/dev/null || return 1
  local net
  for net in "$@"; do ipt "$tool" -C "$chain" -d "$net" -j DROP 2>/dev/null || return 1; done
}

case "$mode" in
  apply)
    apply iptables "${blocked[@]}"
    apply ip6tables "${blocked6[@]}"
    echo "egress: blocked private destinations for $bridge"
    ;;
  check)
    if ! check iptables "${blocked[@]}" || ! check ip6tables "${blocked6[@]}"; then
      echo "egress: rules for $bridge are missing" >&2
      exit 1
    fi
    ;;
  *) echo "usage: $0 [apply|check] [bridge]" >&2; exit 2 ;;
esac
