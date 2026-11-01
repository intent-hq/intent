#!/bin/bash
# Bake the macOS runner image: clone the pinned cirruslabs base, run
# provision.sh inside it, shut it down and keep it as the local Tart VM
# intent-mac-runner-<hash>, where <hash> is the first 12 hex digits of the
# SHA-256 of provision.sh and the base reference. Prints that name on stdout
# (everything else goes to stderr). Idempotent: an image with the name already
# present is kept as is.
#
# Usage: build-image.sh <base image>          e.g. ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:...
#        build-image.sh --name <base image>   print the image name only, build nothing
# Run as the host user that owns ~/.tart (install.sh does). Stock /bin/bash 3.2.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
provision="$here/provision.sh"
boot_timeout="${RUNNERS_MAC_BOOT_TIMEOUT:-300}"
poll_seconds="${RUNNERS_MAC_POLL_SECONDS:-2}"

log() { echo "build-image: $*" >&2; }
die() { echo "build-image: error: $*" >&2; exit 1; }

name_only=0
if [ "${1:-}" = --name ]; then name_only=1; shift; fi
base="${1:-}"
[[ "$base" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$ ]] || die "usage: $0 <registry>/<name>@sha256:<digest>"
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi; }
hash="$({ cat "$provision"; printf '%s\n' "$base"; } | sha256 | cut -c1-12)"
name="intent-mac-runner-$hash"
if [ "$name_only" = 1 ]; then echo "$name"; exit 0; fi
[ "$(id -u)" != 0 ] || die "run as the host user that owns ~/.tart, not root"
command -v tart >/dev/null 2>&1 || die "tart is not installed"
build="$name-build"

vm_exists() { tart list --source local --quiet 2>/dev/null | grep -qx -- "$1"; }

if vm_exists "$name"; then
  log "$name is already built"
  echo "$name"
  exit 0
fi

run_pid=""
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() {
  if vm_exists "$build"; then
    tart stop "$build" --timeout 30 >/dev/null 2>&1 || true
    tart delete "$build" >/dev/null 2>&1 || true
  fi
  if [ -n "$run_pid" ]; then kill "$run_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
cleanup

log "cloning $base (the first pull downloads about 70 GB)"
tart clone "$base" "$build" >&2
tart run --no-graphics --net-softnet "$build" </dev/null >&2 &
run_pid=$!
tart ip "$build" --wait "$boot_timeout" >/dev/null || die "VM $build got no IP address within ${boot_timeout}s"
deadline=$(($(date +%s) + boot_timeout))
until tart exec "$build" /usr/bin/true </dev/null >/dev/null 2>&1; do
  kill -0 "$run_pid" 2>/dev/null || die "VM $build stopped while booting"
  [ "$(date +%s)" -lt "$deadline" ] || die "the guest agent in $build did not answer (tart exec needs the Tart Guest Agent in the base image)"
  sleep "$poll_seconds"
done

log "provisioning $build"
tart exec -i "$build" /bin/bash -s < "$provision" >&2 || die "provision.sh failed in $build"

log "shutting down $build"
tart exec "$build" sudo -n shutdown -h now </dev/null >/dev/null 2>&1 || true
tart stop "$build" --timeout 120 >/dev/null 2>&1 || true
wait "$run_pid" 2>/dev/null || true
run_pid=""
tart rename "$build" "$name"
log "built $name"
echo "$name"
