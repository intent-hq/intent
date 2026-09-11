#!/usr/bin/env bash
# Print the first intent-hq/cloudlands-releases tag that carries a merged commit.
#
#   scripts/shipped-in.sh <intentd|cloudlands-fe> <commit-sha> [--limit N]
#
# cloudlands-fe: the tag carries the commit when the GitHub compare
# `<sha>...<tag>` on intent-hq/cloudlands-fe reports `ahead` or `identical`.
# intentd: each tag's release-manifest.json names the pinned `intentdVersion`;
# the tag carries the commit when `<sha>...v<intentdVersion>` on
# intent-hq/intentd reports `ahead` or `identical`. `behind` and `diverged`
# never count. The newest N releases are scanned (default 10) and the oldest
# carrying tag is printed as `<tag> intentdVersion=<version>`.
#
# Exit codes: 0 = printed a carrying tag; 3 = no scanned release carries the
# commit yet (stdout empty); 4 = transient GitHub failure (rate limit, 5xx,
# network) -- retry later; 2 = usage error; 1 = any other gh/API or manifest
# failure. gh's own error text is appended to the message on 1 and 4.

set -euo pipefail

releases_repo=intent-hq/cloudlands-releases
fe_repo=intent-hq/cloudlands-fe
intentd_repo=intent-hq/intentd

usage() {
  echo "Usage: $0 <intentd|cloudlands-fe> <commit-sha> [--limit N]" >&2
  exit 2
}

component=${1:-}
sha=${2:-}
[[ -n "$component" && -n "$sha" ]] || usage
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
    *) usage ;;
  esac
done

case "$component" in
  intentd) compare_repo=$intentd_repo ;;
  cloudlands-fe) compare_repo=$fe_repo ;;
  *) usage ;;
esac
[[ "$sha" =~ ^[0-9a-fA-F]{7,40}$ ]] || usage

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
  local head=$1 status
  status=$(gh api "repos/$compare_repo/compare/$sha...$head" --jq .status 2>"$gh_err") ||
    gh_fail "gh api compare $sha...$head on $compare_repo failed"
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

intentd_status=""
first_hit=""
for tag in "${tags[@]}"; do
  if [[ "$component" == intentd ]]; then
    version=$(manifest_version "$tag")
    if ! status=$(cache_get "$intentd_status" "$version"); then
      status=$(compare_status "v$version")
      intentd_status+="$version $status"$'\n'
    fi
  else
    status=$(compare_status "$tag")
  fi
  carries "$status" && first_hit=$tag
done

if [[ -z "$first_hit" ]]; then
  echo "shipped-in: $sha is not carried by the newest ${#tags[@]} release(s) on $releases_repo (newest ${tags[0]})" >&2
  exit 3
fi

hit_version=$(manifest_version "$first_hit")
printf '%s intentdVersion=%s\n' "$first_hit" "$hit_version"
