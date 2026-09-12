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
#
# Exit codes: 0 = printed a carrying tag; 3 = no scanned release carries every
# pair yet (stdout empty; stderr names the pairs the newest scanned release
# misses); 4 = transient GitHub failure (rate limit, 5xx, network) -- retry
# later; 2 = usage error; 1 = any other gh/API or manifest failure. gh's own
# error text is appended to the message on 1 and 4.

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

fail() {
  echo "shipped-in: $*" >&2
  exit 1
}

# gh stderr is captured here so failures can be classified and surfaced.
gh_err=$(mktemp)
trap 'rm -f "$gh_err"' EXIT

transient_pattern='rate limit|HTTP 429|HTTP 5[0-9]{2}|error connecting|connection (reset|refused)|timeout|no such host|network is unreachable|temporary failure|unexpected EOF'

# Report a failed gh call: exit 4 when its stderr looks transient, else 1.
gh_fail() {
  local detail
  detail=$(<"$gh_err")
  detail=${detail//$'\n'/ }
  echo "shipped-in: $*${detail:+: $detail}" >&2
  if grep -qiE "$transient_pattern" "$gh_err"; then
    exit 4
  fi
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
for tag in "${tags[@]}"; do
  version=""
  if ((has_intentd)); then
    version=$(manifest_version "$tag")
  fi
  uncarried=""
  for ((i = 0; i < pair_count; i++)); do
    if [[ "${components[i]}" == intentd ]]; then
      if ! status=$(cache_get "$intentd_status" "${shas[i]}:$version"); then
        status=$(compare_status "$intentd_repo" "${shas[i]}" "v$version")
        intentd_status+="${shas[i]}:$version $status"$'\n'
      fi
    else
      status=$(compare_status "$fe_repo" "${shas[i]}" "$tag")
    fi
    carries "$status" || uncarried+="${uncarried:+, }$(describe_pair "$i")"
  done
  if [[ -z "$uncarried" ]]; then
    first_hit=$tag
  elif [[ "$tag" == "${tags[0]}" ]]; then
    newest_uncarried=$uncarried
  fi
done

if [[ -z "$first_hit" ]]; then
  verb=is
  [[ "$newest_uncarried" != *", "* ]] || verb=are
  echo "shipped-in: $newest_uncarried $verb not carried by the newest ${#tags[@]} release(s) on $releases_repo (newest ${tags[0]})" >&2
  exit 3
fi

hit_version=$(manifest_version "$first_hit")
printf '%s intentdVersion=%s\n' "$first_hit" "$hit_version"
