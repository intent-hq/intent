#!/usr/bin/env bash
# Roll this checkout's infra/runners out to the runner fleet, one host at a
# time. For each host: copy infra/runners to /root/infra/runners, run
# install.sh, check the new image (run its baked tools), and restart the idle
# slots that still run an old image. The first failure stops the rollout and
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
# Host-side steps (run as root on a host; the rollout calls them over SSH):
#   rollout.sh --check-image   Run the baked tools in intent-gh-runner:current.
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

# The baked tools, run inside the image. PYTHONS and NODES are the tool-cache
# versions the Dockerfile pins.
# shellcheck disable=SC2016
image_check='
for v in $PYTHONS; do
  test -f "$RUNNER_TOOL_CACHE/Python/$v/x64.complete"
  "$RUNNER_TOOL_CACHE/Python/$v/x64/bin/python3" --version
done
for v in $NODES; do
  test -f "$RUNNER_TOOL_CACHE/node/$v/x64.complete"
  echo "node $("$RUNNER_TOOL_CACHE/node/$v/x64/bin/node" --version)"
done
python3 --version; node --version; gh --version | sed -n 1p; pwsh --version
cargo --version; cargo nextest --version; cargo llvm-cov --version; cargo shear --version
components=$(rustup component list --installed)
grep -E "^llvm-tools" <<<"$components"
'

dockerfile_arg() { sed -n "s/^ARG $1=//p" "$here/Dockerfile" | tr -d '"'; }

check_image() {
  local pythons nodes entry
  pythons="$(dockerfile_arg 'PYTHON_[0-9]*_[0-9]*_VERSION' | xargs)"
  nodes="$(dockerfile_arg NODE_VERSION)"
  for entry in $(dockerfile_arg NODE_TOOLCACHE); do nodes="$nodes ${entry%%=*}"; done
  if [ -z "$pythons" ] || [ -z "$nodes" ]; then die "no Python or Node versions in $here/Dockerfile"; fi
  docker run --rm --network none --entrypoint bash -e "PYTHONS=$pythons" -e "NODES=$nodes" \
    "$image" -euo pipefail -c "$image_check" || die "image check failed: $image"
  log "image ok: $image"
}

restart_idle() {
  local current name id logs
  current="$(docker image inspect --format '{{.Id}}' "$image")" || die "$image is missing (re-run install.sh)"
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
  done < <(docker ps --format '{{.Names}}')
}

case "${1:-}" in
  --check-image) check_image; exit 0 ;;
  --restart-idle) restart_idle; exit 0 ;;
  -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  -*) die "unknown option $1 (see --help)" ;;
esac

mapfile -t fleet < <(python3 -S -B "$here/fleet_slots.py" --hosts)
[ "${#fleet[@]}" -gt 0 ] || die "no hosts in the committed fleet"
hosts=("$@")
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
  ssh "${ssh_opts[@]}" "root@$host" "$remote_dir/install.sh" "${config[@]}" </dev/null || failed "$host" install "$i"
  log "$host: checking the image"
  ssh "${ssh_opts[@]}" "root@$host" "$remote_dir/rollout.sh" --check-image </dev/null || failed "$host" 'image check' "$i"
  log "$host: restarting idle slots"
  ssh "${ssh_opts[@]}" "root@$host" "$remote_dir/rollout.sh" --restart-idle </dev/null || failed "$host" 'idle restart' "$i"
  log "$host: done"
done
log "rolled out to ${hosts[*]}"
