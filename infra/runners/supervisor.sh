#!/usr/bin/env bash
# One runner slot, one job: register a just-in-time (JIT) org runner, run it
# in a fresh container until its single job ends, clean up and exit.
# github-runner@<pool>-<n>.service restarts this for the next job.
#
# Slots belong to pools (default: heavy, 2 x 8 CPUs, 48 GB, label intent-cache;
# small, 6 x 1 CPU, 3 GB, label intent-cache-small). Each slot is pinned to its own
# CPU set from <POOL>_CPUSETS, so nproc and os.availableParallelism() inside
# a job report that slot's CPU count.
#
# SIGTERM (systemctl stop) drains: an idle runner is deregistered and its
# container stopped at once; a busy runner finishes its job first.
#
# Usage: supervisor.sh <pool>-<n>   run one job in slot n of pool
#        supervisor.sh --plan       validate the config, print every slot
# Config: /etc/github-runners/runners.env (RUNNERS_CONFIG overrides)
# Credential: /etc/github-runners/credentials, root 0600 (RUNNERS_CREDENTIALS
# overrides): the bare token on one line, GITHUB_TOKEN=<fine-grained PAT>, or GITHUB_APP_ID,
# GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_FILE. Token values
# are never printed or passed on a command line.
set -euo pipefail
set +x

config_file="${RUNNERS_CONFIG:-/etc/github-runners/runners.env}"
credentials_file="${RUNNERS_CREDENTIALS:-/etc/github-runners/credentials}"
egress="${RUNNERS_EGRESS:-/usr/local/lib/github-runners/egress.sh}"
api_url="${GITHUB_API_URL:-https://api.github.com}"
work_folder=/home/runner/work

log() { echo "runner-slot-${slot:-?}: $*"; }
die() { echo "runner-slot-${slot:-?}: error: $*" >&2; exit 1; }

POOL_KEYS='SLOTS|LABELS|CPUSETS|MEMORY|PIDS|SHM'

# KEY=VALUE lines only; values are taken literally (never evaluated). Keys
# must be listed in $2 or match the per-pool pattern in $3.
read_kv() {
  local file="$1" allowed="$2" pattern="${3:-^$}" line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || die "$file: malformed line (expected KEY=VALUE)"
    key="${line%%=*}"
    value="${line#*=}"
    [[ " $allowed " == *" $key "* || "$key" =~ $pattern ]] || die "$file: unknown key $key"
    printf -v "$key" '%s' "$value"
  done < "$file"
}

# Pool settings are read indirectly through pool_value.
# shellcheck disable=SC2034
load_config() {
  GITHUB_ORG=intent-hq
  RUNNER_GROUP_ID=1
  RUNNER_NAME_PREFIX=intent-cache
  RUNNER_IMAGE=intent-gh-runner:current
  RUNNER_NETWORK=gh-runners
  RUNNER_BRIDGE=gh-runners0
  RUNNER_POOLS="heavy small"
  HEAVY_SLOTS=2
  HEAVY_LABELS=self-hosted,linux,x64,intent-cache
  HEAVY_CPUSETS="0-3,12-15 4-7,16-19"
  HEAVY_MEMORY=48g
  HEAVY_PIDS=16384
  HEAVY_SHM=1g
  SMALL_SLOTS=6
  SMALL_LABELS=self-hosted,linux,x64,intent-cache-small
  SMALL_CPUSETS="8 9 10 20 21 22"
  SMALL_MEMORY=3g
  SMALL_PIDS=4096
  SMALL_SHM=256m
  if [ -f "$config_file" ]; then
    read_kv "$config_file" "GITHUB_ORG RUNNER_GROUP_ID RUNNER_NAME_PREFIX RUNNER_IMAGE RUNNER_NETWORK RUNNER_BRIDGE RUNNER_POOLS" \
      "^[A-Z][A-Z0-9]*_($POOL_KEYS)\$"
  fi
  [[ "$GITHUB_ORG" =~ ^[A-Za-z0-9-]+$ ]] || die "GITHUB_ORG is invalid"
  [[ "$RUNNER_GROUP_ID" =~ ^[0-9]+$ ]] || die "RUNNER_GROUP_ID must be a number"
  [[ "$RUNNER_NAME_PREFIX" =~ ^[A-Za-z0-9-]+$ ]] || die "RUNNER_NAME_PREFIX is invalid"
  [[ "$RUNNER_POOLS" =~ ^[a-z][a-z0-9]*( [a-z][a-z0-9]*)*$ ]] || die "RUNNER_POOLS must be space-separated lowercase names"
}

# pool_value POOL KEY: the value of <POOL>_<KEY>, or empty.
pool_value() {
  local var
  var="$(tr '[:lower:]' '[:upper:]' <<<"$1")_$2"
  echo "${!var:-}"
}

# Number of CPUs in a cpuset list such as 0-7 or 16,18.
cpuset_count() {
  local part n=0 a b parts
  IFS=, read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then a="${part%-*}"; b="${part#*-}"; n=$((n + b - a + 1)); else n=$((n + 1)); fi
  done
  echo "$n"
}

# Validate one pool and print its slot instances (<pool>-<n>).
plan_pool() {
  local pool="$1" slots labels cpusets memory pids shm sets n
  slots="$(pool_value "$pool" SLOTS)"; labels="$(pool_value "$pool" LABELS)"; cpusets="$(pool_value "$pool" CPUSETS)"
  memory="$(pool_value "$pool" MEMORY)"; pids="$(pool_value "$pool" PIDS)"; shm="$(pool_value "$pool" SHM)"
  [[ "$slots" =~ ^[0-9]+$ ]] || die "pool $pool: SLOTS must be a number"
  [[ "$labels" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || die "pool $pool: LABELS must be a comma-separated list"
  [[ "$memory" =~ ^[1-9][0-9]*[kmg]$ ]] || die "pool $pool: MEMORY must look like 40g"
  [[ "${pids:-4096}" =~ ^[1-9][0-9]*$ ]] || die "pool $pool: PIDS must be a number"
  [[ "${shm:-64m}" =~ ^[1-9][0-9]*[kmg]$ ]] || die "pool $pool: SHM must look like 1g"
  read -ra sets <<<"$cpusets"
  [ "${#sets[@]}" -ge "$slots" ] || die "pool $pool: $slots slots but only ${#sets[@]} entries in CPUSETS"
  for ((n = 1; n <= slots; n++)); do
    [[ "${sets[n - 1]}" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || die "pool $pool: bad CPUSETS entry '${sets[n - 1]}'"
    echo "$pool-$n"
  done
}

plan() {
  local pool
  for pool in $RUNNER_POOLS; do plan_pool "$pool"; done
}

load_credentials() {
  GITHUB_TOKEN=""
  GITHUB_APP_ID=""
  GITHUB_APP_INSTALLATION_ID=""
  GITHUB_APP_PRIVATE_KEY_FILE=""
  [ -f "$credentials_file" ] || die "missing $credentials_file (see docs/GITHUB_RUNNERS.md, Credential)"
  local mode owner
  mode="$(stat -c %a "$credentials_file")"
  owner="$(stat -c %u "$credentials_file")"
  if [ "$owner" != "$(id -u)" ] || [[ ! "$mode" =~ ^[0-7]00$ ]]; then
    die "$credentials_file must be owned by $(id -un) and not readable by others (chmod 600)"
  fi
  local first
  IFS= read -r first < "$credentials_file" || true
  if [[ "$first" =~ ^(github_pat_|ghp_)[A-Za-z0-9_]+$ ]] && [ "$(grep -cv '^[[:space:]]*$' "$credentials_file")" = 1 ]; then
    GITHUB_TOKEN="$first"
    return 0
  fi
  read_kv "$credentials_file" "GITHUB_TOKEN GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY_FILE"
  if [ -n "$GITHUB_TOKEN" ]; then return 0; fi
  if [ -z "$GITHUB_APP_ID" ] || [ -z "$GITHUB_APP_INSTALLATION_ID" ] || [ -z "$GITHUB_APP_PRIVATE_KEY_FILE" ]; then
    die "$credentials_file needs GITHUB_TOKEN, or GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY_FILE"
  fi
  [ -r "$GITHUB_APP_PRIVATE_KEY_FILE" ] || die "cannot read GITHUB_APP_PRIVATE_KEY_FILE"
}

# api METHOD PATH [JSON]: sets api_status and api_body. The token reaches curl
# through a process-substitution config file, never argv.
api() {
  local method="$1" path="$2" body="${3:-}" out
  out="$(mktemp)"
  local args=(-sS --max-time 60 -X "$method" -o "$out" -w '%{http_code}'
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  api_status="$(curl "${args[@]}" --config <(printf 'header = "Authorization: Bearer %s"\n' "$api_token") "$api_url$path")" || api_status=000
  api_body="$(cat "$out")"
  rm -f "$out"
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Sets api_token: the PAT, or a fresh one-hour GitHub App installation token.
mint_token() {
  if [ -n "$GITHUB_TOKEN" ]; then api_token="$GITHUB_TOKEN"; return 0; fi
  local now header payload jwt
  now="$(date +%s)"
  header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
  payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$GITHUB_APP_ID" | b64url)"
  jwt="$header.$payload.$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_FILE" -binary | b64url)"
  api_token="$jwt"
  api POST "/app/installations/$GITHUB_APP_INSTALLATION_ID/access_tokens"
  [ "$api_status" = 201 ] || die "GitHub App token request failed (HTTP $api_status)"
  api_token="$(jq -r '.token' <<<"$api_body")"
}

# Delete offline registrations this slot left behind (crash, reboot, kill).
remove_stale() {
  local page=1 count ids id
  while :; do
    api GET "/orgs/$GITHUB_ORG/actions/runners?per_page=100&page=$page"
    [ "$api_status" = 200 ] || { log "warning: listing runners failed (HTTP $api_status); skipping stale cleanup"; return 0; }
    ids="$(jq -r --arg p "$RUNNER_NAME_PREFIX-$slot-" '.runners[] | select((.name | startswith($p)) and .status == "offline") | .id' <<<"$api_body")"
    # Read the page size before the DELETE calls overwrite api_body.
    count="$(jq '.runners | length' <<<"$api_body")"
    for id in $ids; do
      api DELETE "/orgs/$GITHUB_ORG/actions/runners/$id"
      log "removed stale runner registration $id (HTTP $api_status)"
    done
    [ "$count" -ge 100 ] || return 0
    page=$((page + 1))
  done
}

deregister() {
  [ -n "${runner_id:-}" ] || return 0
  mint_token
  api DELETE "/orgs/$GITHUB_ORG/actions/runners/$runner_id"
  case "$api_status" in
    204|404) ;;
    *) log "warning: could not delete runner $runner_id (HTTP $api_status)" ;;
  esac
}

container=""
draining=0
# shellcheck disable=SC2317  # invoked by the TERM/INT trap
on_term() {
  draining=1
  [ -n "$container" ] || exit 0
  mint_token
  api GET "/orgs/$GITHUB_ORG/actions/runners/$runner_id"
  if [ "$api_status" = 200 ] && [ "$(jq -r '.busy' <<<"$api_body")" = true ]; then
    log "draining: waiting for the running job to finish"
    return 0
  fi
  log "stopping idle runner"
  deregister
  docker stop -t 30 "$container" >/dev/null 2>&1 || true
}

main() {
  slot="${1:-}"
  if [ "$slot" = --plan ]; then
    slot=plan
    load_config
    plan
    exit 0
  fi
  [[ "$slot" =~ ^[a-z][a-z0-9]*-[1-9][0-9]*$ ]] || { echo "usage: $0 <pool>-<n> | --plan" >&2; exit 2; }
  load_config
  local planned
  planned="$(plan)"
  grep -qx -- "$slot" <<<"$planned" || die "$slot is not a configured slot (supervisor.sh --plan lists them)"
  local pool="${slot%-*}" n="${slot##*-}" sets
  read -ra sets <<<"$(pool_value "$pool" CPUSETS)"
  local cpuset="${sets[n - 1]}" labels memory pids shm
  labels="$(pool_value "$pool" LABELS)"; memory="$(pool_value "$pool" MEMORY)"
  pids="$(pool_value "$pool" PIDS)"; shm="$(pool_value "$pool" SHM)"
  load_credentials
  "$egress" check "$RUNNER_BRIDGE" || die "egress rules missing; refusing to start a job (systemctl restart github-runners-egress)"
  docker network inspect "$RUNNER_NETWORK" >/dev/null || die "docker network $RUNNER_NETWORK is missing (re-run infra/runners/install.sh)"
  docker image inspect "$RUNNER_IMAGE" >/dev/null || die "image $RUNNER_IMAGE is missing (re-run infra/runners/install.sh)"

  local name="gh-runner-$slot"
  docker rm -f "$name" >/dev/null 2>&1 || true

  mint_token
  remove_stale

  local runner_name body jit
  runner_name="$RUNNER_NAME_PREFIX-$slot-$(date +%s)"
  body="$(jq -nc --arg name "$runner_name" --argjson group "$RUNNER_GROUP_ID" --arg labels "$labels" --arg work "$work_folder" \
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
  log "registered $runner_name (id $runner_id); starting container $name on CPUs $cpuset"

  container="$name"
  trap on_term TERM INT
  ACTIONS_RUNNER_INPUT_JITCONFIG="$jit" docker run --rm --init --name "$name" --hostname "$RUNNER_NAME_PREFIX-$slot" \
    --network "$RUNNER_NETWORK" --cgroup-parent runners.slice \
    --cpus "$(cpuset_count "$cpuset")" --cpuset-cpus "$cpuset" --memory "$memory" --memory-swap "$memory" \
    --pids-limit "${pids:-4096}" --shm-size "${shm:-64m}" --ulimit nofile=65536:65536 \
    --cap-drop ALL --security-opt no-new-privileges \
    --label "intent.runner.pool=$pool" --label "intent.runner.slot=$slot" --label "intent.runner.id=$runner_id" \
    --log-opt "tag=$name" --stop-timeout 30 \
    --env ACTIONS_RUNNER_INPUT_JITCONFIG "$RUNNER_IMAGE" &
  local pid=$! rc=0
  jit=""
  while :; do
    rc=0
    wait "$pid" || rc=$?
    # wait returns >128 when a trapped signal interrupts it; the container
    # process is still running then, so keep waiting.
    kill -0 "$pid" 2>/dev/null || break
  done
  container=""
  log "container exited ($rc)"
  deregister
  if [ "$draining" = 1 ]; then log "drained"; fi
  exit 0
}

main "$@"
