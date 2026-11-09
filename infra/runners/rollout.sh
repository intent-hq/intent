#!/usr/bin/env bash
# Roll this checkout's infra/runners out to the runner fleet, one host at a
# time. For each host: copy infra/runners to /root/infra/runners, run
# install.sh (it builds the image and tags it current only once its baked
# tools run, see check-image.sh), and restart the idle slots that still run an
# old image. The first failure stops the rollout and
# prints the command that resumes it. See docs/GITHUB_RUNNERS.md, Install or
# update.
#
# Usage (from a checkout, with root SSH to the hosts):
#   infra/runners/rollout.sh [HOST...]
#
#   HOST           A RUNNER_NAME_PREFIX of the committed fleet (runners.env and
#                  hosts/NAME.env, as fleet_slots.py reads them). Default: every
#                  host, intent-cache first.
#
# Host-side step (run as root on a host; the rollout calls it over SSH):
#   rollout.sh --restart-idle  Restart each slot whose container runs an old
#                              image and has not started a job.
#
# Tailscale SSH in check mode prints an approval link and waits; open it and
# the step continues.
# SC2029: the remote paths are meant to expand here, before ssh.
# shellcheck disable=SC2029
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image=intent-gh-runner:current
remote_dir=/root/infra/runners
ssh_opts=(-o ConnectionAttempts=3 -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=4)

log() { echo "rollout: $*"; }
die() { echo "rollout: error: $*" >&2; exit 1; }

restart_idle() {
  local current names name id logs
  current="$(docker image inspect --format '{{.Id}}' "$image")" || die "$image is missing (re-run install.sh)"
  # Listed first: a failure inside a process substitution would read as no containers.
  names="$(docker ps --format '{{.Names}}')" || die "docker ps failed"
  while read -r name; do
    case "$name" in gh-runner-*) ;; *) continue ;; esac
    id="$(docker inspect --format '{{.Image}}' "$name" 2>/dev/null)" || continue
    [ "$id" != "$current" ] || continue
    # Captured, not piped into grep -q: an early grep exit would fail the pipe and read as idle.
    logs="$(docker logs "$name" 2>&1)" || continue
    if grep -q 'Running job' <<<"$logs"; then
      log "${name#gh-runner-} is busy; it takes the new image after its job"
      continue
    fi
    # --no-block: the supervisor's stop rechecks busy through the API and drains a slot that just took a job.
    systemctl restart --no-block "github-runner@${name#gh-runner-}"
    log "restarted ${name#gh-runner-} onto the new image"
  done <<<"$names"
}

case "${1:-}" in
  --restart-idle) restart_idle; exit 0 ;;
  -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  -*) die "unknown option $1 (see --help)" ;;
esac

# Runs on the operator's machine, so Bash 3.2 (stock macOS): no mapfile, and
# empty arrays expand through ${a[@]+...} under set -u.
fleet=()
while read -r host; do fleet+=("$host"); done < <(python3 -S -B "$here/fleet_slots.py" --hosts)
[ "${#fleet[@]}" -gt 0 ] || die "no hosts in the committed fleet"
hosts=()
[ "$#" -gt 0 ] && hosts=("$@")
[ "${#hosts[@]}" -gt 0 ] || hosts=("${fleet[@]}")
for host in "${hosts[@]}"; do
  case " ${fleet[*]} " in *" $host "*) ;; *)
    die "unknown runner host '$host'; expected one of: $(printf '%s\n' "${fleet[@]}" | sort | paste -sd, - | sed 's/,/, /g')" ;;
  esac
done

failed() {
  echo "rollout: error: $1: $2 failed; resume with: infra/runners/rollout.sh ${hosts[*]:$3}" >&2
  exit 1
}

for i in "${!hosts[@]}"; do
  host="${hosts[$i]}"
  config=()
  [ "$host" = intent-cache ] || config=(--config "$remote_dir/hosts/$host.env")
  log "$host: copying infra/runners"
  tar -C "$here/.." --exclude=__pycache__ -cf - runners \
    | ssh "${ssh_opts[@]}" "root@$host" "rm -rf $remote_dir && mkdir -p ${remote_dir%/*} && tar -x -f - -C ${remote_dir%/*}" \
    || failed "$host" copy "$i"
  log "$host: installing"
  ssh "${ssh_opts[@]}" "root@$host" "$remote_dir/install.sh" ${config[@]+"${config[@]}"} </dev/null || failed "$host" install "$i"
  log "$host: restarting idle slots"
  ssh "${ssh_opts[@]}" "root@$host" "$remote_dir/rollout.sh" --restart-idle </dev/null || failed "$host" 'idle restart' "$i"
  log "$host: done"
done
log "rolled out to ${hosts[*]}"
