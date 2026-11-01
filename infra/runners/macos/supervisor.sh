#!/bin/bash
# shellcheck source-path=SCRIPTDIR
# One macOS runner slot, one job: boot a fresh Tart VM cloned from the baked
# image, register a just-in-time (JIT) org runner inside it, run its single
# job, then stop and delete the VM and exit. The slot's LaunchDaemon
# (com.intent.github-runner.slot-<n>) restarts this for the next job.
#
# The macOS counterpart of ../supervisor.sh, whose credential, GitHub API and
# runner-group helpers it sources. Runs on the host's stock /bin/bash 3.2 as
# MAC_HOST_USER, the account that owns ~/.tart (never root).
#
# Slots: slot-1 and slot-2 at most (Apple's licence and Virtualization.framework
# allow two macOS guests per host). Runners are named
# <RUNNER_NAME_PREFIX>-slot-<n>-<time> and register MAC_LABELS plus the host
# label intent-host-<RUNNER_NAME_PREFIX>. Each VM is intent-slot-<n>, gets
# MAC_VM_CPU vCPUs and MAC_VM_MEMORY_MB of memory, and runs on softnet, which
# keeps the guest off the host's LAN and private ranges (the counterpart of
# ../egress.sh).
#
# SIGTERM (launchctl bootout) drains: an idle runner is deregistered and its VM
# stopped at once; a busy runner finishes its job first. The VM is stopped and
# deleted on every exit.
#
# Usage: supervisor.sh slot-<n>       run one job in slot n
#        supervisor.sh --plan         validate the config, print every slot
#        supervisor.sh --host-check   check the slots' vCPUs and memory against this Mac
#        supervisor.sh --group-apply  create or correct the runner group
#        supervisor.sh --group-check  print the group and slot membership (JSON)
# Config: /etc/github-runners/runners.env (RUNNERS_CONFIG overrides); the
# baked image's name: /etc/github-runners/macos-image (RUNNERS_MAC_IMAGE_FILE).
# Credential: /etc/github-runners/credentials, owned by MAC_HOST_USER, 0600
# (RUNNERS_CREDENTIALS overrides), in any form ../supervisor.sh accepts.
set -euo pipefail
set +x

mac_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../supervisor.sh
. "${RUNNERS_SHARED_SUPERVISOR:-$mac_dir/../supervisor.sh}"

mac_image_file="${RUNNERS_MAC_IMAGE_FILE:-/etc/github-runners/macos-image}"
# Apple's macOS licence (and Virtualization.framework) allow two macOS guests.
mac_max_slots=2
# Left to the host by --host-check: two cores and 12 GiB.
mac_cpu_reserve=2
mac_memory_reserve_mb=12288
mac_memory_min_mb=4096
mac_boot_timeout="${RUNNERS_MAC_BOOT_TIMEOUT:-180}"
mac_poll_seconds="${RUNNERS_MAC_POLL_SECONDS:-2}"
# Baked by provision.sh: reads the JIT config from stdin and runs one job.
guest_runner=/Users/admin/actions-runner/run-jit.sh
# Read by the shared JIT body below.
work_folder=/Users/admin/work
MAC_KEYS="GITHUB_ORG RUNNER_GROUP RUNNER_GROUP_REPOS RUNNER_NAME_PREFIX RUNNER_FLEET_PREFIX MAC_SLOTS MAC_LABELS MAC_VM_CPU MAC_VM_MEMORY_MB MAC_HOST_USER MAC_BASE_IMAGE"

lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }

load_mac_config() {
  GITHUB_ORG=intent-hq
  RUNNER_GROUP=intent-cache
  RUNNER_GROUP_REPOS=intent,intentd,cloudlands-fe
  RUNNER_NAME_PREFIX=intent-mac
  RUNNER_FLEET_PREFIX=intent-
  MAC_SLOTS=2
  MAC_LABELS=self-hosted,macOS,ARM64,intent-mac
  MAC_VM_CPU=6
  MAC_VM_MEMORY_MB=24576
  MAC_HOST_USER=""
  MAC_BASE_IMAGE=""
  if [ -f "$config_file" ]; then read_kv "$config_file" "$MAC_KEYS"; fi
  validate_common_config
  [[ "$MAC_SLOTS" =~ ^[0-9]+$ ]] || die "MAC_SLOTS must be a number"
  [ "$MAC_SLOTS" -ge 1 ] || die "MAC_SLOTS must be at least 1"
  [ "$MAC_SLOTS" -le "$mac_max_slots" ] || die "MAC_SLOTS=$MAC_SLOTS, but a Mac runs at most $mac_max_slots macOS guests (Apple's licence, enforced by Virtualization.framework)"
  [[ "$MAC_LABELS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || die "MAC_LABELS must be a comma-separated list"
  local labels need
  labels=",$(lower "$MAC_LABELS"),"
  # runner-route's macOS fleet is every online runner carrying all three.
  for need in self-hosted macos arm64; do
    [[ "$labels" == *",$need,"* ]] || die "MAC_LABELS must include self-hosted, macOS and ARM64 (runner-route's macOS fleet matches all three)"
  done
  [[ "$labels" != *,intent-host-* ]] || die "MAC_LABELS must not include a host label (the supervisor adds intent-host-<RUNNER_NAME_PREFIX>)"
  [[ "$labels" != *,m1mac,* ]] || die "MAC_LABELS must not include m1mac (macos-prune.yml and provision-m1mac.yml target the old persistent runner by it)"
  [[ "$MAC_VM_CPU" =~ ^[1-9][0-9]?$ ]] || die "MAC_VM_CPU must be a number of vCPUs"
  if [[ ! "$MAC_VM_MEMORY_MB" =~ ^[1-9][0-9]{0,6}$ ]] || [ "$MAC_VM_MEMORY_MB" -lt "$mac_memory_min_mb" ]; then
    die "MAC_VM_MEMORY_MB must be a number of MiB, at least $mac_memory_min_mb"
  fi
  if [[ ! "$MAC_HOST_USER" =~ ^[a-z_][a-z0-9_.-]*$ ]] || [ "$MAC_HOST_USER" = root ]; then
    die "MAC_HOST_USER must name the account that owns ~/.tart (not root)"
  fi
  [[ "$MAC_BASE_IMAGE" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$ ]] \
    || die "MAC_BASE_IMAGE must be an OCI image pinned by digest (<registry>/<name>@sha256:<64 hex>)"
}

mac_plan() {
  local n=1
  while [ "$n" -le "$MAC_SLOTS" ]; do
    echo "slot-$n"
    n=$((n + 1))
  done
}

# Every slot busy at once must leave the host mac_cpu_reserve cores and
# mac_memory_reserve_mb of memory (sysctl hw.ncpu and hw.memsize).
mac_host_check() {
  local cores bytes mem_mb cpu_need mem_need
  cores="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  [[ "$cores" =~ ^[0-9]+$ ]] || die "cannot read hw.ncpu"
  [[ "$bytes" =~ ^[0-9]+$ ]] || die "cannot read hw.memsize"
  mem_mb=$((bytes / 1048576))
  cpu_need=$((MAC_SLOTS * MAC_VM_CPU))
  mem_need=$((MAC_SLOTS * MAC_VM_MEMORY_MB))
  [ "$cpu_need" -le $((cores - mac_cpu_reserve)) ] \
    || die "slots need $cpu_need vCPUs ($MAC_SLOTS x $MAC_VM_CPU) but this Mac has $cores, and $mac_cpu_reserve stay with the host; lower MAC_VM_CPU or MAC_SLOTS"
  [ "$mem_need" -le $((mem_mb - mac_memory_reserve_mb)) ] \
    || die "slots need $mem_need MiB ($MAC_SLOTS x $MAC_VM_MEMORY_MB) but this Mac has $mem_mb MiB, and $mac_memory_reserve_mb MiB stay with the host; lower MAC_VM_MEMORY_MB or MAC_SLOTS"
}

# Sets MAC_IMAGE: the baked image install.sh recorded.
read_image() {
  [ -r "$mac_image_file" ] || die "no VM image recorded in $mac_image_file (re-run infra/runners/macos/install.sh)"
  MAC_IMAGE=""
  IFS= read -r MAC_IMAGE < "$mac_image_file" || true
  [[ "$MAC_IMAGE" =~ ^intent-mac-runner-[0-9a-f]{12}$ ]] || die "$mac_image_file must name an intent-mac-runner-<hash> image"
  vm_exists "$MAC_IMAGE" || die "VM image $MAC_IMAGE is missing (re-run infra/runners/macos/install.sh)"
}

vm_exists() { tart list --source local --quiet 2>/dev/null | grep -qx -- "$1"; }

# Stop and delete a VM if it exists; never fails.
remove_vm() {
  vm_exists "$1" || return 0
  tart stop "$1" --timeout 30 >/dev/null 2>&1 || true
  tart delete "$1" >/dev/null 2>&1 || log "warning: could not delete VM $1"
}

# Wait until the guest agent answers tart exec (it starts after the IP).
wait_for_guest() {
  local deadline=$(($(date +%s) + mac_boot_timeout))
  tart ip "$vm" --wait "$mac_boot_timeout" >/dev/null || die "VM $vm got no IP address within ${mac_boot_timeout}s"
  until tart exec "$vm" /usr/bin/true </dev/null >/dev/null 2>&1; do
    kill -0 "$vm_pid" 2>/dev/null || die "VM $vm stopped while booting"
    [ "$(date +%s)" -lt "$deadline" ] || die "the guest agent in VM $vm did not answer within ${mac_boot_timeout}s (tart exec needs the Tart Guest Agent in the image)"
    sleep "$mac_poll_seconds"
  done
}

vm=""
vm_pid=""
runner_pid=""
draining=0

# Deregister this run's runner once, from whichever exit path comes first
# (end of job, TERM/INT on an idle runner, or the EXIT trap). Best effort: a
# failure leaves an offline registration that the slot's next start removes.
deregister_once() {
  [ -n "${runner_id:-}" ] || return 0
  ( deregister ) || log "warning: could not deregister runner $runner_id"
  runner_id=""
}

# Runs on every exit, including a fatal signal: the VM must never outlive the
# supervisor (the next start removes a leftover one too), and this run's
# runner is deregistered.
# shellcheck disable=SC2317  # invoked by the EXIT trap
mac_cleanup() {
  if [ -n "$vm" ]; then
    tart stop "$vm" --timeout 30 >/dev/null 2>&1 || true
    tart delete "$vm" >/dev/null 2>&1 || true
  fi
  if [ -n "$vm_pid" ]; then kill "$vm_pid" 2>/dev/null || true; fi
  deregister_once
}

# shellcheck disable=SC2317  # invoked by the TERM/INT trap
mac_on_term() {
  draining=1
  [ -n "$runner_pid" ] || exit 0
  mint_token
  api GET "/orgs/$GITHUB_ORG/actions/runners/$runner_id"
  if [ "$api_status" = 200 ] && [ "$(jq -r '.busy' <<<"$api_body")" = true ]; then
    log "draining: waiting for the running job to finish"
    return 0
  fi
  log "stopping idle runner"
  deregister_once
  tart stop "$vm" --timeout 30 >/dev/null 2>&1 || true
}

mac_main() {
  slot="${1:-}"
  case "$slot" in
    --plan) slot=plan; load_mac_config; mac_plan; exit 0 ;;
    --host-check) slot=host; load_mac_config; mac_host_check; exit 0 ;;
    --group-apply) slot=group; load_mac_config; load_credentials; mint_token; group_apply; exit 0 ;;
    --group-check) slot=group; load_mac_config; load_credentials; mint_token; group_check; exit 0 ;;
  esac
  [[ "$slot" =~ ^slot-[1-9][0-9]*$ ]] || { echo "usage: $0 slot-<n> | --plan | --host-check | --group-apply | --group-check" >&2; exit 2; }
  load_mac_config
  mac_plan | grep -qx -- "$slot" || die "$slot is not a configured slot (supervisor.sh --plan lists them)"
  [ "$(id -un)" = "$MAC_HOST_USER" ] || die "run as $MAC_HOST_USER (MAC_HOST_USER), the account that owns ~/.tart"
  load_credentials
  command -v tart >/dev/null 2>&1 || die "tart is not installed (re-run infra/runners/macos/install.sh)"
  read_image

  vm="intent-$slot"
  trap mac_cleanup EXIT
  trap mac_on_term TERM INT
  remove_vm "$vm"

  mint_token
  resolve_group
  remove_stale

  log "cloning $MAC_IMAGE to $vm ($MAC_VM_CPU vCPUs, $MAC_VM_MEMORY_MB MiB)"
  tart clone "$MAC_IMAGE" "$vm" || die "tart clone $MAC_IMAGE failed"
  tart set "$vm" --cpu "$MAC_VM_CPU" --memory "$MAC_VM_MEMORY_MB" || die "tart set $vm failed"
  # softnet: the guest reaches the internet but not the host's LAN or private
  # ranges (see docs/GITHUB_RUNNERS.md, macOS hosts).
  tart run --no-graphics --net-softnet "$vm" </dev/null &
  vm_pid=$!
  wait_for_guest

  local runner_name body jit
  runner_name="$RUNNER_NAME_PREFIX-$slot-$(date +%s)"
  body="$(jq -nc --arg name "$runner_name" --argjson group "$group_id" --arg labels "$MAC_LABELS,intent-host-$RUNNER_NAME_PREFIX" --arg work "$work_folder" \
    '{name: $name, runner_group_id: $group, labels: ($labels | split(",")), work_folder: $work}')"
  api POST "/orgs/$GITHUB_ORG/actions/runners/generate-jitconfig" "$body"
  if [ "$api_status" != 201 ]; then
    log "JIT registration failed (HTTP $api_status): $(jq -r '.message? // empty' <<<"$api_body" 2>/dev/null || true)"
    sleep "${RUNNERS_RETRY_DELAY:-30}"
    exit 1
  fi
  runner_id="$(jq -r '.runner.id' <<<"$api_body")"
  jit="$(jq -r '.encoded_jit_config' <<<"$api_body")"
  api_body=""
  log "registered $runner_name (id $runner_id); starting the runner in $vm"

  # The JIT config reaches the guest only on stdin: printf is a builtin, so it
  # is never in a host process's argv or environment.
  printf '%s\n' "$jit" | tart exec -i "$vm" "$guest_runner" &
  runner_pid=$!
  jit=""
  local rc=0
  while :; do
    rc=0
    wait "$runner_pid" || rc=$?
    # wait returns >128 when a trapped signal interrupts it; the runner is
    # still running then, so keep waiting.
    kill -0 "$runner_pid" 2>/dev/null || break
  done
  runner_pid=""
  log "runner exited ($rc)"
  tart stop "$vm" --timeout 30 >/dev/null 2>&1 || true
  wait "$vm_pid" 2>/dev/null || true
  vm_pid=""
  tart delete "$vm" >/dev/null 2>&1 || log "warning: could not delete VM $vm"
  vm=""
  deregister_once
  if [ "$draining" = 1 ]; then log "drained"; fi
  exit 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then mac_main "$@"; fi
