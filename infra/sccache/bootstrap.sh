#!/usr/bin/env bash
# Install or update the sccache WebDAV cache server on an Ubuntu LTS box.
# Idempotent: re-running keeps existing tokens, data and volume and reapplies
# config.
#
# Usage (as root, from a checkout of this repo):
#   infra/sccache/bootstrap.sh <site> [--format-disk <dev>]... \
#     [--rotate-rw] [--rotate-ro] [--no-firewall]
#
#   --format-disk <dev>  Use <dev> (a whole unpartitioned disk such as
#                        /dev/nvme1n1, or an unused partition) for the cache
#                        volume. Repeat to combine several devices into one
#                        LVM volume. DESTROYS any data on <dev>; nothing is
#                        ever formatted without this flag. Devices already in
#                        the cache volume are left alone on re-runs.
#   --rotate-rw/-ro      Replace the read-write / read-only token.
#   --no-firewall        Do not touch ufw.
#
# <site> is the public IP (e.g. 172.96.141.217) or a host name; Caddy gets
# its certificate from Let's Encrypt's shortlived profile (needs Caddy >= 2.10).
#
# Installs Caddy (official apt repo), rclone, ufw and lvm2; creates the
# `sccache` user and /srv/sccache; writes /etc/sccache/caddy.env (tokens,
# never printed); installs the units in this directory and enables them.
# The firewall allows SSH only on tailscale0 and 80/443 from anywhere; it
# refuses to apply when tailscale0 is missing. See docs/SCCACHE_SERVER.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_dir=/etc/sccache
env_file="$env_dir/caddy.env"
prune_env="$env_dir/prune.env"
lib_dir=/usr/local/lib/sccache
data_dir=/srv/sccache
os_release=/etc/os-release
fstab=/etc/fstab
vg=sccache
lv=cache
lv_path="/dev/$vg/$lv"

domain=""
rotate_rw=0
rotate_ro=0
firewall=1
format_disks=()

log() { echo "bootstrap: $*"; }
die() { echo "bootstrap: error: $*" >&2; exit 1; }

usage() {
  echo "usage: $0 <site> [--format-disk <dev>]... [--rotate-rw] [--rotate-ro] [--no-firewall]" >&2
  exit 2
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --rotate-rw) rotate_rw=1 ;;
      --rotate-ro) rotate_ro=1 ;;
      --no-firewall) firewall=0 ;;
      --format-disk)
        if [ "$#" -lt 2 ] || [[ "$2" != /dev/* ]]; then echo "--format-disk needs a /dev/... path" >&2; usage; fi
        format_disks+=("$2")
        shift
        ;;
      -h|--help) usage ;;
      -*) echo "unknown option: $1" >&2; usage ;;
      *) [ -z "$domain" ] || usage; domain="$1" ;;
    esac
    shift
  done
  [ -n "$domain" ] || usage
  if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "bootstrap: site must be a bare IP address or host name, e.g. 172.96.141.217" >&2
    exit 2
  fi
}

# Ubuntu of any release; the LTS version is detected, not hardcoded.
check_os() {
  [ -r "$os_release" ] || die "cannot read $os_release"
  local id version
  # shellcheck disable=SC1090
  id="$(. "$os_release" && echo "${ID:-}")"
  # shellcheck disable=SC1090
  version="$(. "$os_release" && echo "${VERSION_ID:-unknown}")"
  [ "$id" = ubuntu ] || die "expected Ubuntu, found '${id:-unknown}' in $os_release"
  log "detected Ubuntu $version"
}

has_iface() { ip link show "$1" >/dev/null 2>&1; }
is_block() { [ -b "$1" ]; }

# Fail before changing anything if the firewall would lock out SSH.
check_firewall_preconditions() {
  [ "$firewall" -eq 1 ] || return 0
  has_iface tailscale0 || die "tailscale0 not found. The firewall allows SSH only over Tailscale, so applying it now would lock out SSH. Join the tailnet first (tailscale up), or re-run with --no-firewall."
  # The interface alone does not prove the node is logged in: require an
  # assigned tailnet (100.64.0.0/10) address too.
  local ts_ip
  ts_ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  [[ "$ts_ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] || die "tailscale0 exists but the node has no Tailscale IPv4 address (not logged in?). Run 'tailscale up' and confirm 'ssh <user>@$(hostname)' works over the tailnet, or re-run with --no-firewall."
  local conn="${SSH_CONNECTION:-}"
  local client="${conn%% *}"
  if [ -n "$conn" ] && [[ ! "$client" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] && [[ "$client" != fd7a:115c:a1e0:* ]]; then
    log "warning: this SSH session ($client) is not over Tailscale; after the firewall applies, new public SSH connections are refused (this session stays up)"
  fi
}

# Refuse anything that is mounted, partitioned, or already in use.
check_disk() {
  local dev="$1" type pv_vg
  is_block "$dev" || die "$dev is not a block device"
  pv_vg="$(pvs --noheadings -o vg_name "$dev" 2>/dev/null | tr -d '[:space:]' || true)"
  [ "$pv_vg" = "$vg" ] && return 0
  [ -z "$pv_vg" ] || die "$dev belongs to LVM volume group '$pv_vg'; refusing"
  if vgs "$vg" >/dev/null 2>&1; then
    die "volume group '$vg' already exists without $dev; extend it by hand (see docs/SCCACHE_SERVER.md, Disks)"
  fi
  type="$(lsblk -ndro TYPE "$dev")"
  case "$type" in disk|part) ;; *) die "$dev is a '$type' device; pass a whole disk or a partition" ;; esac
  if lsblk -nro MOUNTPOINT "$dev" | grep -q .; then die "$dev (or a partition on it) is mounted or used as swap; refusing"; fi
  if [ "$(lsblk -nro NAME "$dev" | wc -l)" -gt 1 ]; then
    die "$dev has partitions or holders; pass an unused partition instead, or clear it yourself (wipefs -a) if it is really unused"
  fi
  if lsblk -nro FSTYPE "$dev" | grep -qx linux_raid_member; then die "$dev is a RAID member; refusing"; fi
}

setup_volume() {
  if [ "${#format_disks[@]}" -eq 0 ]; then
    if ! mountpoint -q "$data_dir"; then
      log "warning: $data_dir is not a separate volume; the cache uses the root filesystem (see --format-disk)"
    fi
    return 0
  fi
  local dev
  for dev in "${format_disks[@]}"; do check_disk "$dev"; done
  if ! vgs "$vg" >/dev/null 2>&1; then
    for dev in "${format_disks[@]}"; do
      log "wiping $dev and adding it to volume group $vg"
      wipefs -a "$dev"
      pvcreate -y "$dev"
    done
    vgcreate "$vg" "${format_disks[@]}"
  fi
  if ! lvs "$vg/$lv" >/dev/null 2>&1; then
    lvcreate -y -n "$lv" -l 100%FREE "$vg"
  fi
  if [ -z "$(blkid -o value -s TYPE "$lv_path" || true)" ]; then
    log "creating ext4 on $lv_path"
    mkfs.ext4 -q -L sccache -m 0 "$lv_path"
  fi
  if ! grep -qE "^${lv_path}[[:space:]]" "$fstab"; then
    echo "$lv_path $data_dir ext4 defaults,relatime,nofail 0 2" >> "$fstab"
  fi
  mkdir -p "$data_dir"
  mountpoint -q "$data_dir" || mount "$data_dir"
  log "cache volume $lv_path mounted at $data_dir ($(df -h --output=size "$data_dir" | tail -n 1 | tr -d ' '))"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg openssl rclone ufw lvm2 debian-keyring debian-archive-keyring apt-transport-https
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

# ACME profiles (Let's Encrypt `shortlived`, required for IP certificates)
# arrived in Caddy 2.10.
min_caddy_minor=10
check_caddy_version() {
  local version major minor
  version="$(caddy version 2>/dev/null | awk '{print $1}')"
  if [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
  else
    die "could not read the Caddy version (got '${version:-nothing}')"
  fi
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt "$min_caddy_minor" ]; }; then
    die "Caddy $version is too old: IP certificates need ACME profiles (Caddy >= 2.$min_caddy_minor). Install Caddy from the official repo (see docs/SCCACHE_SERVER.md)."
  fi
  log "Caddy $version supports ACME profiles"
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
    printf '%s\n' "SCCACHE_PRUNE_DAYS=21" "SCCACHE_MAX_USE_PERCENT=70" "SCCACHE_TARGET_USE_PERCENT=60" > "$prune_env"
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

# SSH only over Tailscale; 80/443 from anywhere. The tailnet rule is added
# before any public SSH rule is removed.
configure_firewall() {
  has_iface tailscale0 || die "tailscale0 not found; refusing to apply firewall rules that would block SSH"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  local rule
  for rule in 22/tcp 22 OpenSSH; do
    ufw delete allow "$rule" >/dev/null 2>&1 || true
  done
  ufw --force enable >/dev/null
  log "firewall: SSH only on tailscale0; 80 and 443 (tcp) from anywhere"
}

start_services() {
  systemctl daemon-reload
  systemctl enable --now sccache-webdav.service
  systemctl restart sccache-webdav.service
  systemctl enable --now sccache-prune.timer
  systemctl enable caddy.service
  systemctl restart caddy.service
}

main() {
  parse_args "$@"
  [ "$(id -u)" -eq 0 ] || die "run as root"
  check_os
  check_firewall_preconditions
  install_packages
  check_caddy_version
  setup_volume
  install_files
  write_env
  validate_caddy
  if [ "$firewall" -eq 1 ]; then configure_firewall; else log "skipping firewall (--no-firewall)"; fi
  start_services
  log "done. Tokens are in $env_file (root-only, 0600; systemd loads it); read them with: sudo grep TOKEN $env_file"
}

# Sourcing (tests) defines the functions without running anything.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
