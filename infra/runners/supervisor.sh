#!/usr/bin/env bash
# One runner slot, one job: register a just-in-time (JIT) org runner, run it
# in a fresh container until its single job ends, clean up and exit.
# github-runner@<pool>-<n>.service restarts this for the next job.
#
# Slots belong to pools (default: heavy, 2 x 8 CPUs, 48 GB, label intent-cache;
# small, 6 x 1 CPU, 3 GB, label intent-cache-small; other hosts may add xl,
# 16 CPUs, label intent-cache-xl). Each slot is pinned to its own CPU set from
# <POOL>_CPUSETS, so nproc and os.availableParallelism() inside a job report
# that slot's CPU count. Runners are named <RUNNER_NAME_PREFIX>-<pool>-<n>-<time>;
# each host has its own prefix, and every prefix in the fleet starts with
# RUNNER_FLEET_PREFIX.
#
# SIGTERM (systemctl stop) drains: an idle runner is deregistered and its
# container stopped at once; a busy runner finishes its job first.
#
# Job stats: while a job runs, its container's cgroup is sampled about every
# 2 seconds. When it ends, one JSON line (format v1: resource use only, never
# environment, tokens or command lines) goes to the journal and to
# /var/lib/github-runners/job-stats.jsonl (root only, rotated by size).
#
# Usage: supervisor.sh <pool>-<n>     run one job in slot n of pool
#        supervisor.sh --job-stats [--since <ISO 8601>]
#                                     print recorded job stats (JSON Lines)
#        supervisor.sh --plan         validate the config, print every slot
#        supervisor.sh --host-check   check the CPU sets against this host's CPUs
#        supervisor.sh --group-apply  create or correct the runner group
#        supervisor.sh --group-check  print the group and slot membership (JSON)
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
cpu_sysfs="${RUNNERS_SYSFS_CPU:-/sys/devices/system/cpu}"
cgroup_root="${RUNNERS_CGROUP_ROOT:-/sys/fs/cgroup}"
stats_dir="${RUNNERS_STATE_DIR:-/var/lib/github-runners}"
stats_file="$stats_dir/job-stats.jsonl"
stats_max_bytes="${RUNNERS_JOB_STATS_MAX_BYTES:-10485760}"
stats_keep="${RUNNERS_JOB_STATS_KEEP:-4}"
sample_interval="${RUNNERS_SAMPLE_INTERVAL:-2}"
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
  RUNNER_GROUP=intent-cache
  RUNNER_GROUP_REPOS=intent,intentd,cloudlands-fe
  RUNNER_NAME_PREFIX=intent-cache
  RUNNER_FLEET_PREFIX=intent-
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
    read_kv "$config_file" "GITHUB_ORG RUNNER_GROUP RUNNER_GROUP_REPOS RUNNER_NAME_PREFIX RUNNER_FLEET_PREFIX RUNNER_IMAGE RUNNER_NETWORK RUNNER_BRIDGE RUNNER_POOLS" \
      "^[A-Z][A-Z0-9]*_($POOL_KEYS)\$"
  fi
  [[ "$GITHUB_ORG" =~ ^[A-Za-z0-9-]+$ ]] || die "GITHUB_ORG is invalid"
  [[ "$RUNNER_GROUP" =~ ^[A-Za-z0-9._\ -]+$ ]] || die "RUNNER_GROUP is invalid"
  [[ "$RUNNER_GROUP_REPOS" =~ ^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$ ]] || die "RUNNER_GROUP_REPOS must be a comma-separated list of repository names"
  [[ "$RUNNER_NAME_PREFIX" =~ ^[A-Za-z0-9-]+$ ]] || die "RUNNER_NAME_PREFIX is invalid"
  [[ "$RUNNER_FLEET_PREFIX" =~ ^[A-Za-z0-9-]+$ ]] || die "RUNNER_FLEET_PREFIX is invalid"
  [[ "$RUNNER_NAME_PREFIX" == "$RUNNER_FLEET_PREFIX"* ]] || die "RUNNER_NAME_PREFIX must start with RUNNER_FLEET_PREFIX ($RUNNER_FLEET_PREFIX)"
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

# Every CPU in cpuset list $1, one per line.
cpuset_cpus() {
  local part parts c
  IFS=, read -ra parts <<<"$1"
  for part in "${parts[@]}"; do
    for ((c = ${part%-*}; c <= ${part#*-}; c++)); do echo "$c"; done
  done
}

# Check the planned CPU sets against this host: every CPU exists, and a slot
# with more than one CPU owns whole cores (each CPU's SMT siblings, from
# topology/thread_siblings_list, are in the same slot). Run on the host itself
# (install.sh does) before enabling slots on new hardware.
host_check() {
  local slot pool n sets cpus c sib planned
  planned="$(plan)" || exit 1
  for slot in $planned; do
    pool="${slot%-*}"; n="${slot##*-}"
    read -ra sets <<<"$(pool_value "$pool" CPUSETS)"
    cpus=" $(cpuset_cpus "${sets[n - 1]}" | tr '\n' ' ')"
    for c in $cpus; do
      [ -r "$cpu_sysfs/cpu$c/topology/thread_siblings_list" ] || die "slot $slot: CPU $c does not exist on this host"
      [ "$(cpuset_count "${sets[n - 1]}")" -gt 1 ] || continue
      for sib in $(cpuset_cpus "$(cat "$cpu_sysfs/cpu$c/topology/thread_siblings_list")"); do
        [[ "$cpus " == *" $sib "* ]] || die "slot $slot: CPU $c shares a core with CPU $sib, which is outside the slot (check thread_siblings_list)"
      done
    done
  done
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
  if [ "$owner" != "${RUNNERS_OWNER_UID:-$(id -u)}" ] || [[ ! "$mode" =~ ^[0-7]00$ ]]; then
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
# Every page is listed before anything is deleted: a deletion shifts later
# runners into pages already read.
remove_stale() {
  local page=1 count ids="" id
  while :; do
    api GET "/orgs/$GITHUB_ORG/actions/runners?per_page=100&page=$page"
    [ "$api_status" = 200 ] || { log "warning: listing runners failed (HTTP $api_status); skipping stale cleanup"; return 0; }
    # Exactly <prefix>-<slot>-<time>: never another host's runners, even one
    # whose prefix starts with this one.
    ids+=" $(jq -r --arg p "^$RUNNER_NAME_PREFIX-$slot-[0-9]+\$" '.runners[] | select((.name | test($p)) and .status == "offline") | .id' <<<"$api_body" | tr '\n' ' ')"
    count="$(jq '.runners | length' <<<"$api_body")"
    [ "$count" -ge 100 ] || break
    page=$((page + 1))
  done
  for id in $ids; do
    api DELETE "/orgs/$GITHUB_ORG/actions/runners/$id"
    log "removed stale runner registration $id (HTTP $api_status)"
  done
}

# Sets group_id from the RUNNER_GROUP name. Never falls back to Default, and
# refuses a group that drifted (not "selected", or repositories other than
# RUNNER_GROUP_REPOS): the repository list is the boundary on who may run code
# on this box.
resolve_group() {
  api GET "/orgs/$GITHUB_ORG/actions/runner-groups?per_page=100"
  [ "$api_status" = 200 ] || die "listing runner groups failed (HTTP $api_status)"
  local group repos want
  group="$(jq -c --arg n "$RUNNER_GROUP" '[.runner_groups[] | select(.name == $n)][0] // empty' <<<"$api_body")"
  [ -n "$group" ] || die "runner group '$RUNNER_GROUP' not found in $GITHUB_ORG (see docs/GITHUB_RUNNERS.md, Runner group)"
  group_id="$(jq -r .id <<<"$group")"
  repos="$(all_pages "/orgs/$GITHUB_ORG/actions/runner-groups/$group_id/repositories?" repositories | jq -c '[.[].name] | sort')"
  want="$(jq -c -n --arg w "$RUNNER_GROUP_REPOS" '$w | split(",") | sort')"
  if [ "$(jq -r .visibility <<<"$group")" != selected ] || [ "$repos" != "$want" ]; then
    die "runner group '$RUNNER_GROUP' drifted (visibility $(jq -r .visibility <<<"$group"), repositories $repos, expected $want); refusing to register. Run supervisor.sh --group-apply"
  fi
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

# The runner group: RUNNER_GROUP, visible only to RUNNER_GROUP_REPOS (public
# repositories allowed, since the CI repositories are public), not restricted
# to workflows. group_apply creates or corrects it; group_check prints the
# live state (no secrets) and fails on any drift or on a slot runner outside
# the group. group_check covers every host in the fleet: any runner named
# <RUNNER_FLEET_PREFIX>...-<pool>-<n>-<time>.
group_repo_ids() {
  local repo ids=()
  IFS=, read -ra repos <<<"$RUNNER_GROUP_REPOS"
  for repo in "${repos[@]}"; do
    api GET "/repos/$GITHUB_ORG/$repo"
    [ "$api_status" = 200 ] || die "repository $GITHUB_ORG/$repo not found (HTTP $api_status)"
    ids+=("$(jq -r '.id' <<<"$api_body")")
  done
  printf '%s\n' "${ids[@]}" | jq -sc .
}

find_group() {
  api GET "/orgs/$GITHUB_ORG/actions/runner-groups?per_page=100"
  [ "$api_status" = 200 ] || die "listing runner groups failed (HTTP $api_status)"
  jq -r --arg n "$RUNNER_GROUP" '[.runner_groups[] | select(.name == $n) | .id][0] // empty' <<<"$api_body"
}

group_apply() {
  local ids id settings
  ids="$(group_repo_ids)"
  id="$(find_group)"
  settings='{"visibility": "selected", "allows_public_repositories": true, "restricted_to_workflows": false}'
  if [ -z "$id" ]; then
    api POST "/orgs/$GITHUB_ORG/actions/runner-groups" \
      "$(jq -c --arg n "$RUNNER_GROUP" --argjson r "$ids" '. + {name: $n, selected_repository_ids: $r}' <<<"$settings")"
    [ "$api_status" = 201 ] || die "creating runner group '$RUNNER_GROUP' failed (HTTP $api_status)"
    log "created runner group '$RUNNER_GROUP'"
    return 0
  fi
  api PATCH "/orgs/$GITHUB_ORG/actions/runner-groups/$id" "$settings"
  [ "$api_status" = 200 ] || die "updating runner group '$RUNNER_GROUP' failed (HTTP $api_status)"
  api PUT "/orgs/$GITHUB_ORG/actions/runner-groups/$id/repositories" "$(jq -nc --argjson r "$ids" '{selected_repository_ids: $r}')"
  [ "$api_status" = 204 ] || die "setting the repositories of '$RUNNER_GROUP' failed (HTTP $api_status)"
  log "runner group '$RUNNER_GROUP' limited to $RUNNER_GROUP_REPOS"
}

# all_pages PATH? KEY: every element of .KEY across pages, as one JSON array.
# PATH must end with "?".
all_pages() {
  local page=1 acc='[]' count
  while :; do
    api GET "${1}per_page=100&page=$page"
    [ "$api_status" = 200 ] || die "GET $1 failed (HTTP $api_status)"
    acc="$(jq -c --argjson a "$acc" --arg k "$2" '$a + .[$k]' <<<"$api_body")"
    count="$(jq --arg k "$2" '.[$k] | length' <<<"$api_body")"
    [ "$count" -ge 100 ] || break
    page=$((page + 1))
  done
  echo "$acc"
}

group_check() {
  local id group repos ours members report
  id="$(find_group)"
  [ -n "$id" ] || die "runner group '$RUNNER_GROUP' not found"
  api GET "/orgs/$GITHUB_ORG/actions/runner-groups/$id"
  group="$api_body"
  repos="$(all_pages "/orgs/$GITHUB_ORG/actions/runner-groups/$id/repositories?" repositories)"
  ours="$(all_pages "/orgs/$GITHUB_ORG/actions/runners?" runners \
    | jq -c --arg p "^$RUNNER_FLEET_PREFIX([A-Za-z0-9-]*-)?[a-z][a-z0-9]*-[1-9][0-9]*-[0-9]+\$" '[.[] | select(.name | test($p)) | .name]')"
  members="$(all_pages "/orgs/$GITHUB_ORG/actions/runner-groups/$id/runners?" runners | jq -c '[.[].name]')"
  report="$(jq -n --argjson g "$group" --argjson r "$repos" --argjson o "$ours" --argjson m "$members" --arg want "$RUNNER_GROUP_REPOS" '{
    group: $g.name, id: $g.id, visibility: $g.visibility,
    allows_public_repositories: $g.allows_public_repositories,
    restricted_to_workflows: $g.restricted_to_workflows,
    repositories: ([$r[].name] | sort), expected_repositories: ($want | split(",") | sort),
    slot_runners: ($o | length), in_group: ([$o[] | select(. as $n | $m | index($n))] | length),
    outside_group: [$o[] | select(. as $n | $m | index($n) | not)]
  } | .ok = (.visibility == "selected" and .allows_public_repositories and (.restricted_to_workflows | not)
             and .repositories == .expected_repositories and (.outside_group | length) == 0)')"
  echo "$report"
  [ "$(jq -r .ok <<<"$report")" = true ] || exit 1
}

# Bytes in a Docker size such as 48g (binary units, like docker --memory).
size_bytes() {
  local n="${1%[kmg]}"
  case "$1" in *k) echo $((n << 10)) ;; *m) echo $((n << 20)) ;; *g) echo $((n << 30)) ;; *) echo "$n" ;; esac
}

# The cgroup v2 directory of container $1 (systemd or cgroupfs driver), or
# nothing while it does not exist yet.
find_cgroup() {
  local id dir
  id="$(docker container inspect --format '{{.Id}}' "$1" 2>/dev/null)" || return 0
  [[ "$id" =~ ^[0-9a-f]+$ ]] || return 0
  for dir in "$cgroup_root/runners.slice/docker-$id.scope" "$cgroup_root/runners.slice/$id"; do
    if [ -d "$dir" ]; then echo "$dir"; return 0; fi
  done
}

# One sample of cgroup $1 on one line: time (us), cpu usage_usec, memory peak,
# pids peak, IO read bytes, IO write bytes, OOM kills. Builtins only, so a
# sample costs no fork. Fails without cpu.stat (the cgroup is gone).
sample_cgroup() {
  local dir="$1" key value usage="" mem=0 pids=0 rb=0 wb=0 oom=0 field fields
  [ -r "$dir/cpu.stat" ] || return 1
  while read -r key value; do
    if [ "$key" = usage_usec ]; then usage="$value"; break; fi
  done < "$dir/cpu.stat" || true
  [[ "$usage" =~ ^[0-9]+$ ]] || return 1
  if [ -r "$dir/memory.peak" ]; then read -r mem < "$dir/memory.peak" || true
  elif [ -r "$dir/memory.current" ]; then read -r mem < "$dir/memory.current" || true; fi
  if [ -r "$dir/pids.peak" ]; then read -r pids < "$dir/pids.peak" || true
  elif [ -r "$dir/pids.current" ]; then read -r pids < "$dir/pids.current" || true; fi
  if [ -r "$dir/io.stat" ]; then
    while read -ra fields; do
      for field in "${fields[@]:1}"; do
        case "$field" in rbytes=*) rb=$((rb + ${field#*=})) ;; wbytes=*) wb=$((wb + ${field#*=})) ;; esac
      done
    done < "$dir/io.stat" || true
  fi
  if [ -r "$dir/memory.events" ]; then
    while read -r key value; do
      if [ "$key" = oom_kill ]; then oom="$value"; break; fi
    done < "$dir/memory.events" || true
  fi
  [[ "$mem" =~ ^[0-9]+$ ]] || mem=0
  [[ "$pids" =~ ^[0-9]+$ ]] || pids=0
  [[ "$oom" =~ ^[0-9]+$ ]] || oom=0
  echo "${EPOCHREALTIME/./} $usage $mem $pids $rb $wb $oom"
}

# sample_job CONTAINER PID FILE: append a sample of the container's cgroup to
# FILE every $sample_interval seconds while PID (docker run) lives.
sample_job() {
  local name="$1" pid="$2" out="$3" dir=""
  while kill -0 "$pid" 2>/dev/null; do
    [ -n "$dir" ] || dir="$(find_cgroup "$name")"
    if [ -n "$dir" ]; then sample_cgroup "$dir" >> "$out" || break; fi
    sleep "$sample_interval"
  done
}

# summarize_samples FILE SLOT_CPUS WALL_S: the measured fields of the job
# stats line. Busy cores per interval come from usage_usec deltas. Every
# counter starts at zero with the container and only grows, so each total is
# its highest sample (a sample racing the cgroup's removal may read short).
# All null when nothing was sampled.
summarize_samples() {
  jq -c -R -s --argjson cpus "$2" --argjson wall "$3" '
    def r(d): . * d | round / d;
    def pct(p): sort | .[(((p * length) | ceil) - 1) | if . < 0 then 0 else . end];
    [split("\n")[] | select(test("^[0-9]+( [0-9]+){6}$")) | split(" ") | map(tonumber)] as $s
    | [range(1; $s | length) | ($s[.][1] - $s[. - 1][1]) / ($s[.][0] - $s[. - 1][0])] as $c
    | ($s | last) as $l
    | (if $l then ([$s[][1]] | max) / 1e6 else null end) as $cpu
    | {cpu_s: (if $l then $cpu | r(10) else null end),
       cores_avg: (if $l and $wall > 0 then $cpu / $wall | r(100) else null end),
       cores_p50: (if ($c | length) > 0 then $c | pct(0.5) | r(100) else null end),
       cores_p95: (if ($c | length) > 0 then $c | pct(0.95) | r(100) else null end),
       cores_max: (if ($c | length) > 0 then $c | max | r(100) else null end),
       saturation: (if ($c | length) > 0 then ([$c[] | select(. >= 0.9 * $cpus)] | length) / ($c | length) | r(1000) else null end),
       mem_peak_bytes: (if $l then [$s[][2]] | max else null end),
       pids_peak: (if $l then [$s[][3]] | max else null end),
       io_read_bytes: (if $l then [$s[][4]] | max else null end),
       io_write_bytes: (if $l then [$s[][5]] | max else null end),
       oom_kills: (if $l then [$s[][6]] | max else null end),
       samples: ($c | length)}' < "$1"
}

# append_job_stats LINE: append under a lock, first rotating a full file to
# .1 (and .1 to .2, ...; $stats_keep old files are kept).
append_job_stats() {
  (
    umask 027
    install -d -m 0750 "$stats_dir"
    exec 9>>"$stats_dir/job-stats.lock"
    flock 9
    local size i
    size="$(stat -c %s "$stats_file" 2>/dev/null || echo 0)"
    if [ "$size" -ge "$stats_max_bytes" ]; then
      for ((i = stats_keep - 1; i >= 1; i--)); do
        if [ -f "$stats_file.$i" ]; then mv -f "$stats_file.$i" "$stats_file.$((i + 1))"; fi
      done
      if [ "$stats_keep" -ge 1 ]; then mv -f "$stats_file" "$stats_file.1"; else rm -f "$stats_file"; fi
    fi
    printf '%s\n' "$1" >> "$stats_file"
  )
}

# record_job_stats: build the v1 line from the job's samples and container
# state ($1: "SizeRw OOMKilled" from docker inspect, or empty), journal it
# and append it to the stats file.
record_job_stats() {
  local inspect="$1" disk=null docker_oom=false wall measured line
  read -r disk docker_oom <<<"$inspect" || true
  [[ "$disk" =~ ^[0-9]+$ ]] || disk=null
  wall="$(awk -v a="$job_t0" -v b="$job_t1" 'BEGIN { printf "%.1f", (b - a) / 1e6 }')"
  measured="$(summarize_samples "$stats_tmp/samples" "$slot_cpus" "$wall")"
  line="$(jq -c -n --arg host "$(hostname -s)" --arg pool "$pool" --arg slot "$slot" \
    --argjson cpus "$slot_cpus" --argjson mem "$slot_memory_bytes" --arg name "$runner_name" \
    --arg start "$started_at" --arg end "$ended_at" --argjson wall "$wall" --argjson m "$measured" \
    --argjson disk "$disk" --argjson exit "$exit_code" --arg docker_oom "$docker_oom" '
    {v: 1, host: $host, pool: $pool, slot: $slot, slot_cpus: $cpus, slot_memory_bytes: $mem,
     runner_name: $name, started_at: $start, ended_at: $end, wall_s: $wall,
     cpu_s: $m.cpu_s, cores_avg: $m.cores_avg, cores_p50: $m.cores_p50, cores_p95: $m.cores_p95,
     cores_max: $m.cores_max, saturation: $m.saturation, mem_peak_bytes: $m.mem_peak_bytes,
     pids_peak: $m.pids_peak, disk_bytes: $disk, io_read_bytes: $m.io_read_bytes,
     io_write_bytes: $m.io_write_bytes,
     oom_kills: (if $docker_oom == "true" then ([$m.oom_kills // 0, 1] | max) else $m.oom_kills end),
     exit_code: $exit, samples: $m.samples}')"
  log "job stats: $line"
  append_job_stats "$line"
}

# --job-stats [--since <ISO 8601>]: every recorded line, oldest first, with
# ended_at at or after --since. Unparsable lines are skipped.
job_stats() {
  local since="" files=() i=1
  if [ "${1:-}" = --since ] && [ -n "${2:-}" ] && [ -z "${3:-}" ]; then
    since="$(date -u -d "$2" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || die "--since: not a date: $2"
  elif [ -n "${1:-}" ]; then
    die "usage: $0 --job-stats [--since <ISO 8601>]"
  fi
  # Lock before listing the files: a rotation between the two would hide
  # the rotated file.
  if [ -r "$stats_dir/job-stats.lock" ]; then exec 9<"$stats_dir/job-stats.lock"; flock -s 9; fi
  while [ -f "$stats_file.$i" ]; do files=("$stats_file.$i" "${files[@]}"); i=$((i + 1)); done
  if [ -f "$stats_file" ]; then files+=("$stats_file"); fi
  [ "${#files[@]}" -gt 0 ] || return 0
  cat -- "${files[@]}" | jq -c -R --arg since "$since" 'fromjson? | objects | select((.ended_at // "") >= $since)'
}

container=""
draining=0
idle_stopped=0
container_name=""
sampler=""
stats_tmp=""
# Runs on every exit, including a fatal signal: the container must never
# outlive the supervisor (ExecStopPost and the next start also remove it).
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup() {
  if [ -n "$sampler" ]; then kill "$sampler" 2>/dev/null || true; fi
  if [ -n "$container_name" ]; then docker rm -f "$container_name" >/dev/null 2>&1 || true; fi
  if [ -n "$stats_tmp" ]; then rm -rf "$stats_tmp"; fi
}

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
  idle_stopped=1
  deregister
  docker stop -t 30 "$container" >/dev/null 2>&1 || true
}

main() {
  slot="${1:-}"
  case "$slot" in
    --plan) slot=plan; load_config; plan; exit 0 ;;
    --job-stats) slot=stats; shift; job_stats "$@"; exit 0 ;;
    --host-check) slot=host; load_config; host_check; exit 0 ;;
    --group-apply) slot=group; load_config; load_credentials; mint_token; group_apply; exit 0 ;;
    --group-check) slot=group; load_config; load_credentials; mint_token; group_check; exit 0 ;;
  esac
  [[ "$slot" =~ ^[a-z][a-z0-9]*-[1-9][0-9]*$ ]] || { echo "usage: $0 <pool>-<n> | --job-stats [--since <ISO 8601>] | --plan | --host-check | --group-apply | --group-check" >&2; exit 2; }
  load_config
  local planned
  planned="$(plan)"
  grep -qx -- "$slot" <<<"$planned" || die "$slot is not a configured slot (supervisor.sh --plan lists them)"
  pool="${slot%-*}"
  local n="${slot##*-}" sets
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
  resolve_group
  remove_stale

  local body jit
  runner_name="$RUNNER_NAME_PREFIX-$slot-$(date +%s)"
  body="$(jq -nc --arg name "$runner_name" --argjson group "$group_id" --arg labels "$labels" --arg work "$work_folder" \
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
  container_name="$name"
  slot_cpus="$(cpuset_count "$cpuset")"
  slot_memory_bytes="$(size_bytes "$memory")"
  stats_tmp="$(mktemp -d)"
  : > "$stats_tmp/samples"
  trap cleanup EXIT
  trap on_term TERM INT
  # No --rm: the container's disk is measured after the job, then removed.
  job_t0="${EPOCHREALTIME/./}"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ACTIONS_RUNNER_INPUT_JITCONFIG="$jit" docker run --init --name "$name" --hostname "$RUNNER_NAME_PREFIX-$slot" \
    --network "$RUNNER_NETWORK" --cgroup-parent runners.slice \
    --cpus "$slot_cpus" --cpuset-cpus "$cpuset" --memory "$memory" --memory-swap "$memory" \
    --pids-limit "${pids:-4096}" --shm-size "${shm:-64m}" --ulimit nofile=65536:65536 --ulimit core=0:0 \
    --cap-drop ALL --security-opt no-new-privileges \
    --label "intent.runner.pool=$pool" --label "intent.runner.slot=$slot" --label "intent.runner.id=$runner_id" \
    --log-opt "tag=$name" --stop-timeout 30 \
    --env ACTIONS_RUNNER_INPUT_JITCONFIG "$RUNNER_IMAGE" &
  local pid=$! rc=0 inspect
  jit=""
  sample_job "$name" "$pid" "$stats_tmp/samples" &
  sampler=$!
  while :; do
    rc=0
    wait "$pid" || rc=$?
    # wait returns >128 when a trapped signal interrupts it; the container
    # process is still running then, so keep waiting.
    kill -0 "$pid" 2>/dev/null || break
  done
  job_t1="${EPOCHREALTIME/./}"
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit_code="$rc"
  container=""
  log "container exited ($rc)"
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  sampler=""
  inspect="$(docker container inspect --size --format '{{.SizeRw}} {{.State.OOMKilled}}' "$name" 2>/dev/null)" || inspect=""
  docker rm -f "$name" >/dev/null 2>&1 || true
  container_name=""
  # Before deregister, which can die on a failed token refresh.
  if [ "$idle_stopped" = 0 ]; then
    record_job_stats "$inspect" || log "warning: could not record job stats"
  fi
  deregister
  if [ "$draining" = 1 ]; then log "drained"; fi
  exit 0
}

# Sourcing (the tests) defines the functions without running a slot.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
