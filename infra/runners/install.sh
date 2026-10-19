#!/usr/bin/env bash
# Install or update the GitHub Actions runner slots on an Ubuntu box.
# Idempotent: re-running reapplies config, rebuilds the image (running jobs
# keep theirs; the next job uses the new one) and sets the slot count.
#
# Usage (as root, from a checkout of this repo):
#   infra/runners/install.sh [--slots N] [--no-build]
#
#   --slots N    Number of runner slots (default 2, or the current count on
#                re-runs). 0 drains and disables every slot.
#   --no-build   Skip the image build (config-only change).
#
# Installs Docker (official apt repo) with user-namespace remapping, the
# runner image, an isolated bridge network with an egress filter, the
# supervisor and its systemd units. Slots start only once the credential
# exists at /etc/github-runners/credentials (root 0600). See
# docs/GITHUB_RUNNERS.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix="${INSTALL_PREFIX:-}"
os_release="${OS_RELEASE:-/etc/os-release}"
etc_dir="$prefix/etc/github-runners"
lib_dir="$prefix/usr/local/lib/github-runners"
unit_dir="$prefix/etc/systemd/system"
wants_dir="$unit_dir/multi-user.target.wants"
docker_conf="$prefix/etc/docker/daemon.json"
credentials="$etc_dir/credentials"
owner_uid="${INSTALL_OWNER_UID:-0}"
network=gh-runners
bridge=gh-runners0
subnet=172.30.250.0/24
image=intent-gh-runner

slots=""
build=1

log() { echo "install: $*"; }
die() { echo "install: error: $*" >&2; exit 1; }
usage() { echo "usage: $0 [--slots N] [--no-build]" >&2; exit 2; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --slots)
        if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[0-9]+$ ]]; then echo "--slots needs a number" >&2; usage; fi
        slots="$2"
        shift
        ;;
      --no-build) build=0 ;;
      -h|--help) usage ;;
      *) echo "unknown argument: $1" >&2; usage ;;
    esac
    shift
  done
}

check_os() {
  [ "$(id -u)" = 0 ] || die "run as root"
  [ -r "$os_release" ] || die "cannot read $os_release"
  local id
  # shellcheck disable=SC1090
  id="$(. "$os_release" && echo "${ID:-}")"
  [ "$id" = ubuntu ] || die "expected Ubuntu, found '${id:-unknown}'"
}

install_packages() {
  if command -v docker >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
    return 0
  fi
  log "installing Docker and tools"
  apt-get update -q
  apt-get install -y -q ca-certificates curl jq openssl
  if ! command -v docker >/dev/null 2>&1; then
    local codename
    # shellcheck disable=SC1090
    codename="$(. "$os_release" && echo "${VERSION_CODENAME:?}")"
    install -d -m 0755 "$prefix/etc/apt/keyrings"
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$prefix/etc/apt/keyrings/docker.asc"
    chmod a+r "$prefix/etc/apt/keyrings/docker.asc"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
      > "$prefix/etc/apt/sources.list.d/docker.list"
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  fi
}

# Copy via a temp file and rename, so a running script keeps its old inode.
put() {
  local mode="$1" src="$2" dest="$3" tmp
  if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(stat -c %a "$dest")" = "${mode#0}" ]; then
    return 1
  fi
  tmp="$(dirname "$dest")/.$(basename "$dest").tmp"
  install -m "$mode" "$src" "$tmp"
  mv -f "$tmp" "$dest"
  return 0
}

configure_docker() {
  install -d -m 0755 "$(dirname "$docker_conf")"
  if put 0644 "$here/daemon.json" "$docker_conf"; then
    log "docker daemon config changed; restarting docker"
    systemctl restart docker
  fi
  systemctl enable --now docker >/dev/null
}

install_files() {
  install -d -m 0755 "$lib_dir" "$unit_dir"
  install -d -m 0700 "$etc_dir"
  put 0755 "$here/supervisor.sh" "$lib_dir/supervisor.sh" || true
  put 0755 "$here/egress.sh" "$lib_dir/egress.sh" || true
  local unit
  for unit in github-runner@.service github-runners.slice github-runners-egress.service; do
    put 0644 "$here/$unit" "$unit_dir/$unit" || true
  done
  if [ ! -f "$etc_dir/runners.env" ]; then
    printf '%s\n' "# Runner slot settings (see docs/GITHUB_RUNNERS.md). Not secret." \
      "GITHUB_ORG=intent-hq" "RUNNER_GROUP_ID=1" "RUNNER_LABELS=self-hosted,linux,x64,intent-cache" \
      "RUNNER_CPUS=8" "RUNNER_MEMORY=48g" > "$etc_dir/runners.env"
    chmod 0644 "$etc_dir/runners.env"
  fi
  systemctl daemon-reload
  systemctl enable github-runners-egress.service >/dev/null
  systemctl restart github-runners-egress.service
}

create_network() {
  docker network inspect "$network" >/dev/null 2>&1 && return 0
  log "creating docker network $network ($subnet, no inter-container traffic)"
  docker network create --driver bridge --subnet "$subnet" \
    -o "com.docker.network.bridge.name=$bridge" \
    -o com.docker.network.bridge.enable_icc=false "$network" >/dev/null
}

build_image() {
  [ "$build" = 1 ] || return 0
  local tag
  tag="$(cat "$here/Dockerfile" "$here/entrypoint.sh" | sha256sum | cut -c1-12)"
  log "building $image:$tag"
  docker build --pull -q -t "$image:$tag" -t "$image:current" "$here" >/dev/null
  docker image prune -f >/dev/null
}

enabled_slots() {
  local f
  for f in "$wants_dir"/github-runner@*.service; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    f="${f##*@}"
    echo "${f%.service}"
  done | sort -n
}

credential_ok() {
  [ -f "$credentials" ] || return 1
  if [ "$(stat -c %u "$credentials")" != "$owner_uid" ] || [[ ! "$(stat -c %a "$credentials")" =~ ^[0-7]00$ ]]; then
    die "$credentials must be owned by root with mode 600"
  fi
}

apply_slots() {
  local current n
  current="$(enabled_slots | tail -n 1)"
  [ -n "$slots" ] || slots="${current:-2}"
  for n in $(enabled_slots); do
    if [ "$n" -gt "$slots" ]; then
      log "draining and disabling slot $n"
      systemctl disable --now "github-runner@$n.service"
    fi
  done
  [ "$slots" -gt 0 ] || { log "0 slots configured"; return 0; }
  if ! credential_ok; then
    log "credential missing: place it at $credentials (root, 0600; see docs/GITHUB_RUNNERS.md), then re-run"
    return 0
  fi
  for n in $(seq 1 "$slots"); do
    systemctl enable --now "github-runner@$n.service" >/dev/null
  done
  log "$slots slot(s) enabled"
}

main() {
  parse_args "$@"
  check_os
  install_packages
  configure_docker
  install_files
  create_network
  build_image
  apply_slots
}

main "$@"
