#!/usr/bin/env bash
# Install or update the GitHub Actions runner slots on an Ubuntu box.
# Idempotent: re-running reapplies config, rebuilds and checks the image
# (check-image.sh; running jobs keep theirs, the next job uses the new one) and enables exactly the slots
# that /etc/github-runners/runners.env describes (pools, slot counts, CPU
# sets, memory), draining and disabling any others.
#
# Usage (as root, from a checkout of this repo):
#   infra/runners/install.sh [--no-build] [--config FILE] [--skip-lockdown-check]
#   infra/runners/install.sh --retire
#
#   --no-build     Skip the image build (config-only change).
#   --config FILE  Seed /etc/github-runners/runners.env from FILE instead of
#                  runners.env (the intent-cache layout), e.g. a file under
#                  hosts/. Like the default, used only if none exists yet.
#   --retire       Take this host out of the fleet: disable and drain every
#                  slot, wait until none is running, then delete the
#                  credential and the GitHub App key it names, and print the
#                  steps left to do by hand. Re-run it to resume a wait that
#                  timed out. See "Retire a runner host" in
#                  docs/GITHUB_RUNNERS.md.
#   --skip-lockdown-check
#                  Install even though ufw does not show the host locked down
#                  (below). Only for a host firewalled some other way.
#
# Installing refuses to touch the host unless ufw is active, denies incoming traffic by
# default and allows SSH only on tailscale0 (docs/GITHUB_RUNNERS.md, Add a
# runner host, step 2): the slots hold an org runner credential. --retire
# skips this check: it only takes slots and the credential away.
#
# Runs on the cache box (intent-cache) or on a runner-only host: the cache
# services get their priority drop-in only where they are installed. The
# runners.slice memory cap follows the host's RAM, and the slots' total
# memory must fit under it.
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
meminfo="${MEMINFO:-/proc/meminfo}"
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
# --retire: how long to wait for draining slots (TimeoutStopSec is 6h, then
# ExecStopPost removes the container) and how often to check.
retire_timeout="${RETIRE_TIMEOUT_SECONDS:-22200}"
retire_poll="${RETIRE_POLL_SECONDS:-15}"

build=1
retire=0
lockdown_check=1
seed_config="$here/runners.env"

log() { echo "install: $*"; }
die() { echo "install: error: $*" >&2; exit 1; }
usage() { echo "usage: $0 [--no-build] [--config FILE] [--skip-lockdown-check] | --retire" >&2; exit 2; }

parse_args() {
  if [ "${1:-}" = --retire ]; then
    [ "$#" = 1 ] || usage
    retire=1
    return 0
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-build) build=0 ;;
      --skip-lockdown-check) lockdown_check=0 ;;
      --config)
        [ "$#" -ge 2 ] || usage
        [ -f "$2" ] || die "--config: no such file $2"
        seed_config="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
        shift ;;
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

# True if a ufw "To" field (interface already removed) admits TCP port 22: a
# port list or range holding 22, an address or Anywhere with no port (every
# port, of every protocol or of TCP), or an SSH app profile. Parenthesized
# annotations such as "(v6)" or a verbose profile name "(RemoteAdmin)" are
# dropped so the numeric port behind them decides.
admits_ssh() {
  local to="$1" spec ports part lo hi parts
  [[ "${to,,}" == *ssh* ]] && return 0
  while [[ "$to" =~ ^(.*)\ ?\([^\)]*\)(.*)$ ]]; do to="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"; done
  read -ra parts <<<"$to"
  [ "${#parts[@]}" -gt 0 ] || return 1
  spec="${parts[-1]}"
  if [[ "$spec" =~ ^[0-9]+(:[0-9]+)?(,[0-9]+(:[0-9]+)?)*(/(tcp|udp))?$ ]]; then
    [[ "$spec" == */udp ]] && return 1
    ports="${spec%/*}"
    for part in ${ports//,/ }; do
      lo="${part%%:*}"; hi="${part##*:}"
      [ "$lo" -le 22 ] && [ "$hi" -ge 22 ] && return 0
    done
    return 1
  fi
  [[ "$spec" =~ ^(Anywhere|[0-9a-fA-F.:]+(/[0-9]+)?)(/([a-z][a-z0-9]*))?$ ]] || return 1
  [[ -z "${BASH_REMATCH[4]}" || "${BASH_REMATCH[4]}" == tcp ]]
}

# The runbook's lockdown (docs/GITHUB_RUNNERS.md, Add a runner host, step 2):
# ufw active, incoming denied by default, SSH allowed only on tailscale0. Runs
# before anything changes on the host.
check_lockdown() {
  if [ "$lockdown_check" = 0 ]; then
    log "WARNING: --skip-lockdown-check: not checking that ufw keeps SSH off the public internet"
    return 0
  fi
  local fix="lock the host down first (docs/GITHUB_RUNNERS.md, Add a runner host, step 2): apt-get install -y ufw; ufw default deny incoming; ufw allow in on tailscale0 to any port 22 proto tcp; ufw enable. If the host is firewalled some other way, re-run with --skip-lockdown-check"
  command -v ufw >/dev/null 2>&1 || die "ufw is not installed, so nothing keeps SSH off the public internet; $fix"
  local status line to action direction words i open=() tailnet=0 rules=0
  status="$(LC_ALL=C ufw status verbose 2>&1)" || die "ufw status failed: $status"
  grep -qx 'Status: active' <<<"$status" || die "ufw is not active, so every listening port (SSH included) is open; $fix"
  grep -Eq '^Default: (deny|reject) \(incoming\)' <<<"$status" \
    || die "ufw does not deny incoming traffic by default ($(grep '^Default:' <<<"$status" || echo 'no Default line')); $fix"
  while IFS= read -r line; do
    if [ "$rules" = 0 ]; then
      [[ "$line" =~ ^--+\  ]] && rules=1
      continue
    fi
    # A comment ("# ...") may hold anything, including action words.
    read -ra words <<<"${line%%#*}"
    i=0
    while [ "$i" -lt "${#words[@]}" ] && [[ ! "${words[i]}" =~ ^(ALLOW|LIMIT|DENY|REJECT)$ ]]; do i=$((i + 1)); done
    if [ "$i" = 0 ] || [ "$i" = "${#words[@]}" ]; then continue; fi
    to="${words[*]:0:i}"; action="${words[i]}"; direction=IN
    [[ "${words[i + 1]:-}" =~ ^(IN|OUT|FWD)$ ]] && direction="${words[i + 1]}"
    case "$action $direction" in 'ALLOW IN'|'LIMIT IN') ;; *) continue ;; esac
    if [[ "$to" == *" on tailscale0" ]]; then
      admits_ssh "${to% on tailscale0}" && tailnet=1
      continue
    fi
    admits_ssh "${to% on *}" && open+=("$line")
  done <<<"$status"
  if [ "${#open[@]}" -gt 0 ]; then
    die "ufw allows SSH outside tailscale0: $(printf '[%s] ' "${open[@]}")- delete those rules (ufw status numbered; ufw delete N) and keep only 'ufw allow in on tailscale0 to any port 22 proto tcp'; if the host is firewalled some other way, re-run with --skip-lockdown-check"
  fi
  [ "$tailnet" = 1 ] || die "ufw has no rule allowing SSH on tailscale0; $fix"
  log "lockdown: ufw active, incoming denied, SSH only on tailscale0"
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

# Enable a unit and start it only if it is not already running. A start job
# on a running unit still queues behind pending jobs, such as a slot draining
# a job for hours.
ensure_started() {
  systemctl enable "$1" >/dev/null
  systemctl is-active --quiet "$1" || systemctl start "$1"
}

# A unit file installed by a package or by hand (systemd's search path).
unit_exists() {
  local dir
  for dir in /etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    [ -e "$prefix$dir/$1" ] && return 0
  done
  return 1
}

# runners.slice MemoryMax = host RAM (whole GiB) minus the reserve, from
# supervisor.sh --memory-cap: the cap its --host-check holds the slots to.
install_slice_memory() {
  local cap tmp
  cap="$(RUNNERS_MEMINFO="$meminfo" "$lib_dir/supervisor.sh" --memory-cap)" || die "cannot size runners.slice (see above)"
  install -d -m 0755 "$unit_dir/runners.slice.d"
  tmp="$(mktemp)"
  printf '# Written by infra/runners/install.sh: host RAM minus the reserve (supervisor.sh --memory-cap).\n[Slice]\nMemoryMax=%sG\n' \
    "$cap" > "$tmp"
  put 0644 "$tmp" "$unit_dir/runners.slice.d/memory.conf" || true
  rm -f "$tmp"
}

configure_docker() {
  install -d -m 0755 "$(dirname "$docker_conf")"
  if put 0644 "$here/daemon.json" "$docker_conf"; then
    log "docker daemon config changed; restarting docker"
    systemctl restart docker
  fi
  ensure_started docker
}

# Kernel limits the slots share; reloaded every run so a hand edit is undone.
configure_sysctl() {
  install -d -m 0755 "$prefix/etc/sysctl.d"
  put 0644 "$here/sysctl.conf" "$prefix/etc/sysctl.d/90-github-runners.conf" || true
  sysctl -q --load "$prefix/etc/sysctl.d/90-github-runners.conf"
}

install_files() {
  install -d -m 0755 "$lib_dir" "$unit_dir"
  install -d -m 0700 "$etc_dir"
  put 0755 "$here/supervisor.sh" "$lib_dir/supervisor.sh" || true
  put 0755 "$here/egress.sh" "$lib_dir/egress.sh" || true
  local unit
  for unit in github-runner@.service runners.slice github-runners-egress.service; do
    put 0644 "$here/$unit" "$unit_dir/$unit" || true
  done
  for unit in caddy.service sccache-webdav.service; do
    if ! unit_exists "$unit"; then
      log "no $unit on this host; skipping its priority drop-in"
      continue
    fi
    install -d -m 0755 "$unit_dir/$unit.d"
    put 0644 "$here/cache-priority.conf" "$unit_dir/$unit.d/runners-priority.conf" || true
  done
  install_slice_memory
  if [ ! -f "$etc_dir/runners.env" ]; then
    install -m 0644 "$seed_config" "$etc_dir/runners.env"
  elif ! cmp -s "$seed_config" "$etc_dir/runners.env"; then
    log "keeping existing $etc_dir/runners.env (differs from $seed_config)"
  fi
  systemctl daemon-reload
  # Reapply the rules directly rather than through a systemd job, which would
  # wait behind any slot that is draining a job.
  ensure_started github-runners-egress.service
  "$lib_dir/egress.sh" apply "$bridge"
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
  docker build --pull -q -t "$image:$tag" "$here" >/dev/null
  # Slots start each job from :current, so only a checked image becomes it.
  log "checking $image:$tag"
  if ! "$here/check-image.sh" "$image:$tag"; then
    docker rmi "$image:$tag" >/dev/null 2>&1 || true
    die "image check failed for $image:$tag; the slots keep the previous image"
  fi
  docker tag "$image:$tag" "$image:current"
  docker image prune -f >/dev/null
}

enabled_slots() {
  local f
  for f in "$wants_dir"/github-runner@*.service; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    f="${f##*@}"
    echo "${f%.service}"
  done | sort -V
}

credential_ok() {
  [ -f "$credentials" ] || return 1
  if [ "$(stat -c %u "$credentials")" != "$owner_uid" ] || [[ ! "$(stat -c %a "$credentials")" =~ ^[0-7]00$ ]]; then
    die "$credentials must be owned by root with mode 600"
  fi
}

apply_slots() {
  local wanted n
  wanted="$(RUNNERS_CONFIG="$etc_dir/runners.env" "$lib_dir/supervisor.sh" --plan)" \
    || die "invalid $etc_dir/runners.env (see above)"
  RUNNERS_CONFIG="$etc_dir/runners.env" RUNNERS_MEMINFO="$meminfo" "$lib_dir/supervisor.sh" --host-check \
    || die "$etc_dir/runners.env does not fit this host's CPUs or memory (see above)"
  for n in $(enabled_slots); do
    if ! grep -qx -- "$n" <<<"$wanted"; then
      log "draining and disabling slot $n"
      systemctl disable --now "github-runner@$n.service"
    fi
  done
  [ -n "$wanted" ] || { log "0 slots configured"; return 0; }
  if ! credential_ok; then
    log "credential missing: place it at $credentials (root, 0600; see docs/GITHUB_RUNNERS.md), then re-run"
    return 0
  fi
  RUNNERS_CONFIG="$etc_dir/runners.env" RUNNERS_CREDENTIALS="$credentials" "$lib_dir/supervisor.sh" --group-apply \
    || die "could not set up the runner group (see above); slots left unchanged"
  for n in $wanted; do
    # --no-block: a slot that is draining a job would hold a blocking start.
    systemctl enable "github-runner@$n.service" >/dev/null
    systemctl is-active --quiet "github-runner@$n.service" || systemctl start --no-block "github-runner@$n.service"
  done
  log "slots enabled: $(tr '\n' ' ' <<<"$wanted")"
}

# Every slot unit systemd has loaded plus every enabled one: a slot started
# by hand is not in the wants directory.
known_slots() {
  {
    enabled_slots | sed 's/.*/github-runner@&.service/'
    systemctl list-units --all --plain --no-legend 'github-runner@*.service' | awk '{print $1}'
  } | { grep -x 'github-runner@.*\.service' || true; } | sort -uV
}

# Slots not yet stopped, as "unit (state)". A draining slot is
# "deactivating", which `systemctl is-active` counts as inactive, so read
# ActiveState instead. Fails if systemd cannot be read: errexit is off where
# callers test this, and an unread state must never count as stopped.
running_slots() {
  local units unit state
  units="$(known_slots)" || return 1
  for unit in $units; do
    state="$(systemctl show -p ActiveState --value "$unit")" || return 1
    case "$state" in
      inactive|failed) ;;
      '') return 1 ;;
      *) echo "$unit ($state)" ;;
    esac
  done
}

# Delete the credential, after the GitHub App private key it names. A
# bare-token credential names no key.
remove_credential() {
  local key
  if [ ! -e "$credentials" ]; then
    log "no credential at $credentials"
    return 0
  fi
  key="$(sed -n 's/^GITHUB_APP_PRIVATE_KEY_FILE=//p' "$credentials" | tail -n 1)"
  case "$key" in
    '') ;;
    /*)
      if [ -f "$prefix$key" ]; then
        shred -u "$prefix$key"
        log "deleted GitHub App key $key"
      else
        log "GitHub App key $key is already gone"
      fi ;;
    *) log "warning: GITHUB_APP_PRIVATE_KEY_FILE=$key is not an absolute path; delete that key by hand" ;;
  esac
  shred -u "$credentials"
  log "deleted $credentials"
}

retire_host() {
  local slots running name_prefix waited=0
  slots="$(known_slots)" || die "cannot list the runner slots; keeping the credential"
  if [ -n "$slots" ]; then
    log "disabling and draining: $(tr '\n' ' ' <<<"$slots")"
    # --no-block queues every stop at once; the loop below waits. A busy
    # slot finishes its job first, an idle one deregisters within seconds.
    # shellcheck disable=SC2086
    systemctl disable --now --no-block $slots >/dev/null
  else
    log "no runner slots on this host"
  fi
  while :; do
    running="$(running_slots)" || die "cannot read the runner slots' state; keeping the credential"
    [ -n "$running" ] || break
    if [ "$waited" -ge "$retire_timeout" ]; then
      echo "install: error: slots still running after ${waited}s; keeping the credential (a draining slot needs it to deregister):" >&2
      echo "  ${running//$'\n'/$'\n  '}" >&2
      die "re-run $0 --retire once they finish (systemctl list-units 'github-runner@*')"
    fi
    log "waiting for running slots to finish their job: $(tr '\n' ' ' <<<"$running")"
    sleep "$retire_poll"
    waited=$((waited + retire_poll))
  done
  log "all slots stopped"
  remove_credential
  # The supervisor's default prefix applies only when the config exists;
  # without it, leave a placeholder rather than name another host.
  name_prefix="<host>"
  if [ -r "$etc_dir/runners.env" ]; then
    name_prefix="$(sed -n 's/^RUNNER_NAME_PREFIX=//p' "$etc_dir/runners.env" | tail -n 1)"
    name_prefix="${name_prefix:-intent-cache}"
  fi
  cat <<EOF
install: drained. The PR that removes this host's config may merge now.
Left to do by hand (docs/GITHUB_RUNNERS.md, Retire a runner host):
  1. Delete leftover runner registrations (offline runners from a crash or reboot):
       gh api --paginate orgs/intent-hq/actions/runners \\
         -q '.runners[] | select(.name | startswith("$name_prefix-")) | "\\(.id) \\(.name) \\(.status)"'
       gh api -X DELETE orgs/intent-hq/actions/runners/<id>
  2. Leave the tailnet, last (SSH reaches the box only over Tailscale):
       nohup sh -c 'sleep 2; tailscale logout' >/dev/null 2>&1 &
     then delete the machine in the Tailscale admin console, so a
     replacement can take the name.
  3. Cancel the server with the provider.
EOF
}

main() {
  parse_args "$@"
  check_os
  if [ "$retire" = 1 ]; then
    retire_host
    return 0
  fi
  check_lockdown
  install_packages
  configure_docker
  configure_sysctl
  install_files
  create_network
  build_image
  apply_slots
}

main "$@"
