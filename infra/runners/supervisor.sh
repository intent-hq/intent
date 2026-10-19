#!/usr/bin/env bash
# One runner slot, one job: register a just-in-time (JIT) org runner, run it
# in a fresh container until its single job ends, clean up and exit.
# github-runner@<slot>.service restarts this for the next job.
#
# SIGTERM (systemctl stop) drains: an idle runner is deregistered and its
# container stopped at once; a busy runner finishes its job first.
#
# Usage: supervisor.sh <slot>
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

# KEY=VALUE lines only; values are taken literally (never evaluated).
read_kv() {
  local file="$1" allowed="$2" line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" == *=* ]] || die "$file: malformed line (expected KEY=VALUE)"
    key="${line%%=*}"
    value="${line#*=}"
    [[ " $allowed " == *" $key "* ]] || die "$file: unknown key $key"
    printf -v "$key" '%s' "$value"
  done < "$file"
}

load_config() {
  GITHUB_ORG=intent-hq
  RUNNER_GROUP_ID=1
  RUNNER_LABELS=self-hosted,linux,x64,intent-cache
  RUNNER_NAME_PREFIX=intent-cache
  RUNNER_IMAGE=intent-gh-runner:current
  RUNNER_NETWORK=gh-runners
  RUNNER_BRIDGE=gh-runners0
  RUNNER_CPUS=8
  RUNNER_MEMORY=48g
  RUNNER_PIDS=16384
  RUNNER_SHM=1g
  if [ -f "$config_file" ]; then
    read_kv "$config_file" "GITHUB_ORG RUNNER_GROUP_ID RUNNER_LABELS RUNNER_NAME_PREFIX RUNNER_IMAGE RUNNER_NETWORK RUNNER_BRIDGE RUNNER_CPUS RUNNER_MEMORY RUNNER_PIDS RUNNER_SHM"
  fi
  [[ "$GITHUB_ORG" =~ ^[A-Za-z0-9-]+$ ]] || die "GITHUB_ORG is invalid"
  [[ "$RUNNER_GROUP_ID" =~ ^[0-9]+$ ]] || die "RUNNER_GROUP_ID must be a number"
  [[ "$RUNNER_LABELS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || die "RUNNER_LABELS must be a comma-separated list"
  [[ "$RUNNER_NAME_PREFIX" =~ ^[A-Za-z0-9-]+$ ]] || die "RUNNER_NAME_PREFIX is invalid"
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
    for id in $ids; do
      api DELETE "/orgs/$GITHUB_ORG/actions/runners/$id"
      log "removed stale runner registration $id (HTTP $api_status)"
    done
    count="$(jq '.runners | length' <<<"$api_body")"
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
  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 <slot>" >&2; exit 2; }
  load_config
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
  body="$(jq -nc --arg name "$runner_name" --argjson group "$RUNNER_GROUP_ID" --arg labels "$RUNNER_LABELS" --arg work "$work_folder" \
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
  log "registered $runner_name (id $runner_id); starting container $name"

  container="$name"
  trap on_term TERM INT
  ACTIONS_RUNNER_INPUT_JITCONFIG="$jit" docker run --rm --init --name "$name" --hostname "$RUNNER_NAME_PREFIX-$slot" \
    --network "$RUNNER_NETWORK" --cgroup-parent github-runners.slice \
    --cpus "$RUNNER_CPUS" --memory "$RUNNER_MEMORY" --memory-swap "$RUNNER_MEMORY" \
    --pids-limit "$RUNNER_PIDS" --shm-size "$RUNNER_SHM" --ulimit nofile=65536:65536 \
    --cap-drop ALL --security-opt no-new-privileges \
    --label "intent.runner.slot=$slot" --label "intent.runner.id=$runner_id" \
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
