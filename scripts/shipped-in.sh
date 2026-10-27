#!/usr/bin/env bash
# Print the first intent-hq/cloudlands-releases tag that carries one or more
# merged commits.
#
#   scripts/shipped-in.sh <intentd|cloudlands-fe> <commit-sha> \
#     [<intentd|cloudlands-fe> <commit-sha>]... [--limit N]
#
# Each `<component> <commit-sha>` pair is checked independently; the same
# component may appear more than once with different SHAs.
# cloudlands-fe: a tag carries the commit when the GitHub compare
# `<sha>...<tag>` on intent-hq/cloudlands-fe reports `ahead` or `identical`.
# intentd: each tag's release-manifest.json names the pinned `intentdVersion`;
# the tag carries the commit when `<sha>...v<intentdVersion>` on
# intent-hq/intentd reports `ahead` or `identical`. `behind` and `diverged`
# never count. The newest N releases are scanned (default 10) and the oldest
# tag carrying EVERY pair is printed as `<tag> intentdVersion=<version>`.
# Carriage is monotonic across versioned tags (a commit carried by a tag is
# carried by every newer one), so the scan stops at the newest tag when it
# misses any pair; older tags are only inspected to find the oldest carrier.
# A release that rolls the intentd pin backwards breaks that monotonicity: the
# newest tag misses the intentd commit, so the scan stops there and exits 3
# (rather than printing an older carrying tag) until a newer release carries
# it again. This is deliberate -- the current alpha does not ship the change.
#
# Exit codes: 0 = printed a carrying tag; 3 = no scanned release carries every
# pair yet (stdout empty; stderr names the pairs the newest scanned release
# misses); 5 = same, but the release pipeline needs a human to re-run a
# workflow run named on stderr: intentd's Release-plz run for main HEAD
# failed, or the active Release Alpha run on
# intent-hq/cloudlands-fe looks stalled (a job queued longer than
# SHIPPED_IN_STALL_MINUTES, default 30; 0 disables the probe) -- stderr names
# the run, job and queue age; 6 = every uncarried pair is an intentd commit on
# main that release-plz confirmed needs no release (no package changed since
# the tag stderr names), so it rides the next intentd release -- waiting
# changes nothing until another commit lands; 4 =
# transient GitHub failure (rate limit -- including one gh masks as another
# error, detected by a follow-up REST probe --, 5xx, network) -- retry later;
# 2 = usage error; 1 = any other gh/API or manifest failure. gh's own error
# text is appended to the message on 1 and 4. The release-plz and stall probes
# are best-effort: when one fails the script still exits 3 and notes why on
# stderr.

set -euo pipefail

releases_repo=intent-hq/cloudlands-releases
fe_repo=intent-hq/cloudlands-fe
intentd_repo=intent-hq/intentd

usage() {
  echo "Usage: $0 <intentd|cloudlands-fe> <commit-sha> [<intentd|cloudlands-fe> <commit-sha>]... [--limit N]" >&2
  exit 2
}

components=("${1:-}")
shas=("${2:-}")
[[ -n "${components[0]}" && -n "${shas[0]}" ]] || usage
shift 2
limit=10
while (($# > 0)); do
  case "$1" in
    --limit)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || usage
      limit=$2
      shift 2
      ;;
    --limit=*)
      limit=${1#--limit=}
      [[ "$limit" =~ ^[1-9][0-9]*$ ]] || usage
      shift
      ;;
    -*) usage ;;
    *)
      (($# >= 2)) || usage
      components+=("$1")
      shas+=("$2")
      shift 2
      ;;
  esac
done

pair_count=${#components[@]}
for ((i = 0; i < pair_count; i++)); do
  case "${components[i]}" in
    intentd | cloudlands-fe) ;;
    *) usage ;;
  esac
  [[ "${shas[i]}" =~ ^[0-9a-fA-F]{7,40}$ ]] || usage
done

stall_minutes=${SHIPPED_IN_STALL_MINUTES:-30}
if [[ ! "$stall_minutes" =~ ^[0-9]+$ ]]; then
  echo "shipped-in: SHIPPED_IN_STALL_MINUTES must be a non-negative integer, got '$stall_minutes'" >&2
  exit 2
fi
# Force base 10 so a leading zero ("08") is not read as octal.
stall_minutes=$((10#$stall_minutes))

fail() {
  echo "shipped-in: $*" >&2
  exit 1
}

# gh stderr is captured here so failures can be classified and surfaced; the
# rate-limit probe below keeps its own file so the original text survives.
gh_err=$(mktemp)
probe_err=$(mktemp)
trap 'rm -f "$gh_err" "$probe_err"' EXIT

transient_pattern='rate limit|HTTP 429|HTTP 5[0-9]{2}|error connecting|connection (reset|refused)|timeout|no such host|network is unreachable|temporary failure|unexpected EOF'

# Report a failed gh call: exit 4 when its stderr looks transient, else 1.
# gh masks some REST 403s: under REST throttling `gh release download` and
# `gh release view` print `release not found` while `gh release list`
# (GraphQL) still lists the tag -- 2026-09-22, workspace frosty-beaver, the
# "Wait for shipped alpha" hook was evicted with exit 1. So a failure that
# does not look transient gets one REST probe on the releases repo (the same
# core quota; `gh api rate_limit` is not gated by it and kept reporting 5000
# remaining during the incident): a probe that itself fails transiently (rate
# limit, 5xx, network) turns it into exit 4 and the message names which; a
# healthy probe, or one failing for any other reason, keeps the original
# message and exit 1.
gh_fail() {
  local detail probe_detail probe_state
  detail=$(<"$gh_err")
  detail=${detail//$'\n'/ }
  if grep -qiE "$transient_pattern" "$gh_err"; then
    echo "shipped-in: $*${detail:+: $detail}" >&2
    exit 4
  fi
  if ! gh api "repos/$releases_repo" >/dev/null 2>"$probe_err" &&
    grep -qiE "$transient_pattern" "$probe_err"; then
    probe_detail=$(<"$probe_err")
    probe_detail=${probe_detail//$'\n'/ }
    if grep -qiE 'rate limit|HTTP 429' "$probe_err"; then
      probe_state="is rate limited"
    else
      probe_state="is unavailable"
    fi
    echo "shipped-in: $*${detail:+: $detail} (GitHub REST API $probe_state: $probe_detail)" >&2
    exit 4
  fi
  echo "shipped-in: $*${detail:+: $detail}" >&2
  exit 1
}

compare_status() {
  local repo=$1 sha=$2 head=$3 status
  status=$(gh api "repos/$repo/compare/$sha...$head" --jq .status 2>"$gh_err") ||
    gh_fail "gh api compare $sha...$head on $repo failed"
  printf '%s\n' "$status"
}

# Stock macOS ships Bash 3.2, which has no associative arrays: caches are
# newline-separated "<key> <value>" records in plain strings.
cache_get() {
  local record
  while IFS= read -r record; do
    if [[ "${record%% *}" == "$2" ]]; then
      printf '%s\n' "${record#* }"
      return 0
    fi
  done <<<"$1"
  return 1
}

manifest_versions=""
manifest_version() {
  local tag=$1 manifest version
  if ! version=$(cache_get "$manifest_versions" "$tag"); then
    manifest=$(gh release download "$tag" --repo "$releases_repo" \
      --pattern release-manifest.json --output - 2>"$gh_err") ||
      gh_fail "gh release download release-manifest.json for $tag on $releases_repo failed"
    version=$(printf '%s\n' "$manifest" |
      python3 -c 'import json, sys; print(json.load(sys.stdin)["intentdVersion"])' 2>/dev/null) ||
      fail "could not read intentdVersion from release-manifest.json for $tag on $releases_repo"
    [[ -n "$version" ]] || fail "release-manifest.json for $tag has an empty intentdVersion"
    manifest_versions+="$tag $version"$'\n'
  fi
  printf '%s\n' "$version"
}

carries() {
  case "$1" in
    ahead | identical) return 0 ;;
    *) return 1 ;;
  esac
}

# The distribution repo also carries rolling channel releases (alpha, beta,
# stable) that can sit anywhere in the listing, so over-fetch and take the
# newest $limit versioned tags after filtering.
release_list=$(
  gh release list --repo "$releases_repo" --limit "$((limit + 10))" --exclude-drafts \
    --json tagName --jq '.[].tagName' 2>"$gh_err"
) || gh_fail "gh release list on $releases_repo failed"
tags=()
while IFS= read -r tag; do
  tags+=("$tag")
done < <(grep -E '^v[0-9]+\.[0-9]+\.[0-9]+' <<<"$release_list" | head -n "$limit" || true)
((${#tags[@]} > 0)) || fail "gh release list on $releases_repo returned no vX.Y.Z tags"

# A single pair is reported by its sha alone; several pairs by component + sha.
describe_pair() {
  if ((pair_count == 1)); then
    printf '%s\n' "${shas[$1]}"
  else
    printf '%s %s\n' "${components[$1]}" "${shas[$1]}"
  fi
}

has_intentd=0
for ((i = 0; i < pair_count; i++)); do
  [[ "${components[i]}" != intentd ]] || has_intentd=1
done

# Several tags pin the same intentd version, so intentd compares are cached
# per "<sha>:<version>" -- two intentd pairs never share a status.
intentd_status=""
first_hit=""
newest_uncarried=""
# Indexes of the pairs the newest tag misses, for the release-plz probe.
newest_uncarried_idx=()
for tag in "${tags[@]}"; do
  version=""
  if ((has_intentd)); then
    version=$(manifest_version "$tag")
  fi
  uncarried=""
  uncarried_idx=()
  for ((i = 0; i < pair_count; i++)); do
    if [[ "${components[i]}" == intentd ]]; then
      if ! status=$(cache_get "$intentd_status" "${shas[i]}:$version"); then
        status=$(compare_status "$intentd_repo" "${shas[i]}" "v$version")
        intentd_status+="${shas[i]}:$version $status"$'\n'
      fi
    else
      status=$(compare_status "$fe_repo" "${shas[i]}" "$tag")
    fi
    if ! carries "$status"; then
      uncarried+="${uncarried:+, }$(describe_pair "$i")"
      uncarried_idx+=("$i")
    fi
  done
  if [[ -z "$uncarried" ]]; then
    first_hit=$tag
  elif [[ "$tag" == "${tags[0]}" ]]; then
    # No older tag can carry what the newest one misses.
    newest_uncarried=$uncarried
    newest_uncarried_idx=("${uncarried_idx[@]}")
    break
  fi
done

# The exit-3 probes below are best-effort: a failure keeps the plain exit 3
# and names the skipped probe, the reason and gh's text on stderr.
probe_skipped() {
  local probe=$1 detail
  shift
  detail=$(<"$gh_err")
  detail=${detail//$'\n'/ }
  echo "shipped-in: $probe skipped: $*${detail:+: $detail}" >&2
}

# Python prelude reading `gh api .../jobs --paginate` from stdin into `jobs`:
# --paginate emits one JSON object per page, back to back.
jobs_pages_py='
import json, sys
text = sys.stdin.read()
decoder = json.JSONDecoder()
pos, jobs = 0, []
while True:
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos >= len(text):
        break
    page, pos = decoder.raw_decode(text, pos)
    jobs.extend(page.get("jobs", []))
'

# Best-effort stall probe for the exit-3 path: intentd-only changes ride the
# cloudlands-fe Release Alpha run too, so its active run tells "not cut yet"
# apart from "stalled" (a job still queued past the threshold, e.g. a runner
# label nobody serves).
stall_skipped() {
  probe_skipped "Release Alpha stall probe" "$@"
}

release_alpha_stalled() {
  local run run_id run_url jobs stalled age name since
  ((stall_minutes > 0)) || return 0
  run=$(gh run list --repo "$fe_repo" --workflow "Release Alpha" --limit 5 \
    --json databaseId,status,url,displayTitle,createdAt 2>"$gh_err") ||
    { stall_skipped "gh run list on $fe_repo failed"; return 0; }
  # Release Alpha runs share the `cloudlands-release` concurrency group without
  # cancel-in-progress, so a newer run sits fully queued behind the one holding
  # the group for as long as that one takes: only the oldest active run can be
  # stalled. Run-level status is not filtered further -- a run reads `queued`
  # while its jobs are already in progress.
  run=$(printf '%s\n' "$run" | python3 -c '
import json, sys
runs = [run for run in json.load(sys.stdin) if run["status"] != "completed"]
if runs:
    run = min(runs, key=lambda run: run["createdAt"])
    print(run["databaseId"], run["url"])
' 2>"$gh_err") || { stall_skipped "could not read the active Release Alpha runs on $fe_repo"; return 0; }
  [[ -n "$run" ]] || return 0
  read -r run_id run_url <<<"$run"
  # The REST jobs payload carries created_at; `gh run view --json jobs` does
  # not.
  jobs=$(gh api "repos/$fe_repo/actions/runs/$run_id/jobs" --paginate 2>"$gh_err") ||
    { stall_skipped "gh api jobs for Release Alpha run $run_id on $fe_repo failed"; return 0; }
  stalled=$(printf '%s\n' "$jobs" | python3 -c "$jobs_pages_py"'
import datetime
threshold = int(sys.argv[1]) * 60
now = datetime.datetime.now(datetime.timezone.utc)
worst = None
for job in jobs:
    if job.get("status") != "queued" or not job.get("created_at"):
        continue
    created = datetime.datetime.fromisoformat(job["created_at"].replace("Z", "+00:00"))
    age = int((now - created).total_seconds())
    if age > threshold and (worst is None or age > worst[0]):
        worst = (age, job.get("name", ""), job["created_at"])
if worst:
    print("%d\t%s\t%s" % (worst[0] // 60, worst[1], worst[2]))
' "$stall_minutes" 2>"$gh_err") ||
    { stall_skipped "could not read the jobs of Release Alpha run $run_id on $fe_repo"; return 0; }
  [[ -n "$stalled" ]] || return 0
  IFS=$'\t' read -r age name since <<<"$stalled"
  echo "shipped-in: Release Alpha run $run_url stalled: job \"$name\" queued for $age min (since $since)" >&2
  exit 5
}

# Best-effort release-plz probe for the exit-3 path when an intentd pair is
# uncarried. It reads the newest Release-plz push run for intentd main HEAD
# and only judges the uncarried intentd commits that are on main but newer
# than the version released there (crates/intentd/Cargo.toml at HEAD) -- the
# ones only the next intentd release can carry; a tagged commit just waits on
# the fe pin:
#   - a job of that completed run failed, timed out or never started (or the
#     run itself failed): no Release PR or tag comes until someone re-runs it
#     -> exit 5. intentd#2726 waited ~6 h behind such a failure (run
#     40430078531, a crates.io network error). `cancelled` does not count: the
#     pr job's concurrency group cancels a pending job a newer push supersedes;
#   - the run succeeded with its "Release-plz no release needed:
#     v<version>@<tag commit>" job, the proof cloudlands-fe's
#     intentd-release-readiness.mjs trusts: the commits changed no released
#     package and ride the next intentd release that does -> exit 6, once
#     every uncarried pair is such a commit (an fe pair still pending keeps
#     exit 3, plus a note);
#   - otherwise, or with an open release-plz-* Release PR, or when main moved
#     during the probe -> plain exit 3.
# Commit types do not decide this: release-plz releases on package file
# changes, and test-only ranges have shipped (v0.11.22, v0.11.59).
release_plz_skipped() {
  probe_skipped "intentd release-plz probe" "$@"
}

release_plz_verdict() {
  local intentd_idx=() i head prs run run_id run_url run_state run_conclusion verdict
  local kind detail job manifest version tag_sha status pending="" pending_count=0 pending_fe=0
  for i in ${newest_uncarried_idx[@]+"${newest_uncarried_idx[@]}"}; do
    if [[ "${components[i]}" == intentd ]]; then
      intentd_idx+=("$i")
    else
      pending_fe=1
    fi
  done
  ((${#intentd_idx[@]} > 0)) || return 0
  head=$(gh api "repos/$intentd_repo/git/ref/heads/main" --jq .object.sha 2>"$gh_err") ||
    { release_plz_skipped "gh api main ref on $intentd_repo failed"; return 0; }
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] ||
    { : >"$gh_err"; release_plz_skipped "unexpected main ref '$head' on $intentd_repo"; return 0; }
  run=$(gh api "repos/$intentd_repo/actions/workflows/release-plz.yml/runs?branch=main&event=push&head_sha=$head&per_page=100" \
    2>"$gh_err") ||
    { release_plz_skipped "gh api Release-plz runs on $intentd_repo failed"; return 0; }
  run=$(printf '%s\n' "$run" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if data["total_count"] > len(data["workflow_runs"]):
    sys.exit("more Release-plz runs for HEAD than one page")
runs = [run for run in data["workflow_runs"] if run["head_sha"] == sys.argv[1]]
if runs:
    run = max(runs, key=lambda run: run["run_number"])
    print(run["id"], run["html_url"], run["status"], run.get("conclusion") or "none")
' "$head" 2>"$gh_err") ||
    { release_plz_skipped "could not read the Release-plz runs on $intentd_repo"; return 0; }
  [[ -n "$run" ]] || return 0
  read -r run_id run_url run_state run_conclusion <<<"$run"
  # A run (or re-run attempt) still in flight has no verdict yet.
  [[ "$run_state" == completed ]] || return 0
  verdict=$(gh api "repos/$intentd_repo/actions/runs/$run_id/jobs?per_page=100" --paginate 2>"$gh_err") ||
    { release_plz_skipped "gh api jobs for Release-plz run $run_id on $intentd_repo failed"; return 0; }
  # The jobs endpoint defaults to the run's latest attempt.
  verdict=$(printf '%s\n' "$verdict" | python3 -c "$jobs_pages_py"'
import re
stuck = ("failure", "timed_out", "startup_failure")
for job in jobs:
    if job.get("conclusion") in stuck:
        print("failed\t%s\t%s" % (job["conclusion"], job["name"]))
        sys.exit(0)
if sys.argv[1] in stuck:
    print("failed\t%s\tRelease-plz run" % sys.argv[1])
    sys.exit(0)
if sys.argv[1] != "success":
    sys.exit(0)
noop = re.compile(r"Release-plz no release needed: v([0-9]+\.[0-9]+\.[0-9]+)@([0-9a-f]{40})")
for job in jobs:
    match = noop.fullmatch(job["name"])
    if match and job.get("conclusion") == "success":
        print("noop\t%s\t%s" % match.groups())
' "$run_conclusion" 2>"$gh_err") ||
    { release_plz_skipped "could not read the jobs of Release-plz run $run_id on $intentd_repo"; return 0; }
  [[ -n "$verdict" ]] || return 0
  IFS=$'\t' read -r kind detail job <<<"$verdict"
  # Every open PR, like the readiness guard: search results can lag or cap.
  prs=$(gh api "repos/$intentd_repo/pulls?state=open&per_page=100" --paginate \
    --jq ".[] | select((.head.ref | startswith(\"release-plz-\")) and .head.repo.full_name == \"$intentd_repo\") | .number" \
    2>"$gh_err") ||
    { release_plz_skipped "gh api open pulls on $intentd_repo failed"; return 0; }
  [[ -z "$prs" ]] || return 0
  manifest=$(gh api "repos/$intentd_repo/contents/crates/intentd/Cargo.toml?ref=$head" \
    -H "Accept: application/vnd.github.raw+json" 2>"$gh_err") ||
    { release_plz_skipped "gh api crates/intentd/Cargo.toml on $intentd_repo main $head failed"; return 0; }
  version=$(printf '%s\n' "$manifest" | python3 -c '
import re, sys
section = None
for line in sys.stdin:
    header = re.match(r"\s*\[([^]]+)\]\s*$", line)
    if header:
        section = header.group(1).strip()
    elif section == "package":
        match = re.match(r"\s*version\s*=\s*\"([0-9]+\.[0-9]+\.[0-9]+)\"\s*$", line)
        if match:
            print(match.group(1))
            break
' 2>"$gh_err") || version=""
  [[ -n "$version" ]] ||
    { : >"$gh_err"; release_plz_skipped "could not read the intentd version on $intentd_repo main $head"; return 0; }
  if [[ "$kind" == noop ]]; then
    # The proof must name the version released at HEAD and its tag commit.
    [[ "$detail" == "$version" ]] || return 0
    tag_sha=$(gh api "repos/$intentd_repo/commits/v$version" --jq .sha 2>"$gh_err") ||
      { release_plz_skipped "gh api commit of v$version on $intentd_repo failed"; return 0; }
    [[ "$tag_sha" == "$job" ]] || return 0
  fi
  for i in "${intentd_idx[@]}"; do
    status=$(gh api "repos/$intentd_repo/compare/${shas[i]}...$head" --jq .status 2>"$gh_err") ||
      { release_plz_skipped "gh api compare ${shas[i]}...$head on $intentd_repo failed"; return 0; }
    carries "$status" || continue
    if ! status=$(gh api "repos/$intentd_repo/compare/${shas[i]}...v$version" --jq .status 2>"$gh_err"); then
      # A release merge whose tag push failed leaves HEAD at a version that
      # has no tag yet: nothing carries the commit.
      if [[ "$kind" == failed ]] && grep -qE 'HTTP 404|Not Found' "$gh_err"; then
        status=missing-tag
      else
        release_plz_skipped "gh api compare ${shas[i]}...v$version on $intentd_repo failed"
        return 0
      fi
    fi
    carries "$status" && continue
    pending+="${pending:+, }${shas[i]}"
    pending_count=$((pending_count + 1))
  done
  [[ -n "$pending" ]] || return 0
  [[ "$kind" == failed || $pending_count -eq ${#intentd_idx[@]} ]] || return 0
  # A verdict for a HEAD that moved meanwhile is stale: the next poll redoes it.
  [[ "$(gh api "repos/$intentd_repo/git/ref/heads/main" --jq .object.sha 2>"$gh_err")" == "$head" ]] || return 0
  if [[ "$kind" == failed ]]; then
    echo "shipped-in: the intentd $job job concluded $detail on main $head ($run_url); $pending wait on the next intentd release (after v$version), which cannot start until someone re-runs it" >&2
    exit 5
  fi
  echo "shipped-in: $pending: no intentd release needed -- release-plz found no package changes on main $head since v$version ($run_url); it ships with the next intentd release that changes a package" >&2
  if ((pending_fe)); then
    echo "shipped-in: still waiting on the cloudlands-fe pair(s)" >&2
    return 0
  fi
  exit 6
}

if [[ -z "$first_hit" ]]; then
  verb=is
  [[ "$newest_uncarried" != *", "* ]] || verb=are
  echo "shipped-in: $newest_uncarried $verb not carried by the newest ${#tags[@]} release(s) on $releases_repo (newest ${tags[0]})" >&2
  release_plz_verdict
  release_alpha_stalled
  exit 3
fi

hit_version=$(manifest_version "$first_hit")
printf '%s intentdVersion=%s\n' "$first_hit" "$hit_version"
