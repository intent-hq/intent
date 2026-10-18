#!/usr/bin/env bash
# Install or update the sccache WebDAV cache server on a fresh Ubuntu box.
# Idempotent: re-running keeps existing tokens and data and reapplies config.
#
# Usage (as root, from a checkout of this repo):
#   infra/sccache/bootstrap.sh <domain> [--rotate-rw] [--rotate-ro] [--no-firewall]
#
# Installs Caddy (official apt repo), rclone, ufw; creates the `sccache`
# user and /srv/sccache; writes /etc/sccache/caddy.env (tokens, never
# printed); installs the units in this directory and enables them.
# See docs/SCCACHE_SERVER.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir=/etc/sccache
env_file="$env_dir/caddy.env"
prune_env="$env_dir/prune.env"
lib_dir=/usr/local/lib/sccache
data_dir=/srv/sccache

usage() {
  echo "usage: $0 <domain> [--rotate-rw] [--rotate-ro] [--no-firewall]" >&2
  exit 2
}

domain=""
rotate_rw=0
rotate_ro=0
firewall=1
for arg in "$@"; do
  case "$arg" in
    --rotate-rw) rotate_rw=1 ;;
    --rotate-ro) rotate_ro=1 ;;
    --no-firewall) firewall=0 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) [ -z "$domain" ] || usage; domain="$arg" ;;
  esac
done
[ -n "$domain" ] || usage
if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "bootstrap: domain must be a bare host name, e.g. cache.example.com" >&2
  exit 2
fi
[ "$(id -u)" -eq 0 ] || { echo "bootstrap: run as root" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "bootstrap: needs Ubuntu/Debian (apt-get)" >&2; exit 1; }

log() { echo "bootstrap: $*"; }

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg openssl rclone ufw debian-keyring debian-archive-keyring apt-transport-https
  local keyring=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
  if [ ! -s "$keyring" ]; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o "$keyring"
  fi
  if [ ! -s /etc/apt/sources.list.d/caddy-stable.list ]; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get install -y -q caddy
}

new_token() { openssl rand -hex 32; }

# Print the current value of KEY from the env file, or nothing.
env_get() {
  [ -f "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

write_env() {
  install -d -m 0755 -o root -g root "$env_dir"
  local rw ro
  rw="$(env_get SCCACHE_RW_TOKEN)"
  ro="$(env_get SCCACHE_RO_TOKEN)"
  if [ -z "$rw" ] || [ "$rotate_rw" -eq 1 ]; then rw="$(new_token)"; log "generated a new read-write token"; fi
  if [ -z "$ro" ] || [ "$rotate_ro" -eq 1 ]; then ro="$(new_token)"; log "generated a new read-only token"; fi
  local tmp
  tmp="$(umask 077; mktemp "$env_dir/.caddy.env.XXXXXX")"
  {
    echo "# Managed by infra/sccache/bootstrap.sh. Secrets: do not copy into the repo."
    echo "SCCACHE_SITE=$domain"
    echo "SCCACHE_RW_TOKEN=$rw"
    echo "SCCACHE_RO_TOKEN=$ro"
  } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$env_file"
  if [ ! -f "$prune_env" ]; then
    printf '%s\n' "SCCACHE_PRUNE_DAYS=21" "SCCACHE_MAX_USE_PERCENT=70" > "$prune_env"
    chmod 0644 "$prune_env"
  fi
}

install_files() {
  id sccache >/dev/null 2>&1 || useradd --system --home-dir "$data_dir" --no-create-home --shell /usr/sbin/nologin sccache
  install -d -m 0750 -o sccache -g sccache "$data_dir"
  install -d -m 0755 "$lib_dir" /etc/systemd/system/caddy.service.d
  install -m 0755 "$here/prune.sh" "$lib_dir/prune.sh"
  install -m 0755 "$here/check-caddy-env.sh" "$lib_dir/check-caddy-env.sh"
  install -m 0644 "$here/Caddyfile" /etc/caddy/Caddyfile
  install -m 0644 "$here/caddy-override.conf" /etc/systemd/system/caddy.service.d/sccache.conf
  install -m 0644 "$here/sccache-webdav.service" /etc/systemd/system/sccache-webdav.service
  install -m 0644 "$here/sccache-prune.service" /etc/systemd/system/sccache-prune.service
  install -m 0644 "$here/sccache-prune.timer" /etc/systemd/system/sccache-prune.timer
}

validate_caddy() {
  (
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    "$lib_dir/check-caddy-env.sh"
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  )
  log "Caddyfile is valid"
}

configure_firewall() {
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  log "firewall: incoming allowed only on 22, 80, 443 (tcp)"
}

start_services() {
  systemctl daemon-reload
  systemctl enable --now sccache-webdav.service
  systemctl restart sccache-webdav.service
  systemctl enable --now sccache-prune.timer
  systemctl enable caddy.service
  systemctl restart caddy.service
}

install_packages
install_files
write_env
validate_caddy
if [ "$firewall" -eq 1 ]; then configure_firewall; else log "skipping firewall (--no-firewall)"; fi
start_services
log "done. Tokens are in $env_file (root-only, 0600; systemd loads it); read them with: sudo grep TOKEN $env_file"
