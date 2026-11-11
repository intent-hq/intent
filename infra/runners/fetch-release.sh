#!/bin/sh
# Image build helper: fetch-release OWNER/REPO TAG ASSET OUT
# Downloads one GitHub release asset. github.com/<repo>/releases/download can
# answer 504 for hours for a single asset while the API serves the same file
# (python 3.11.18 and gh 2.102.0 did), so fall back to the API asset URL.
# The caller checks the SHA-256.
set -eu
[ $# -eq 4 ] || { echo "usage: fetch-release OWNER/REPO TAG ASSET OUT" >&2; exit 2; }
repo=$1 tag=$2 asset=$3 out=$4
get() { curl -fsSL --retry 3 --retry-all-errors --retry-delay 5 "$@"; }

if get -o "$out" "https://github.com/$repo/releases/download/$tag/$asset"; then exit 0; fi
echo "fetch-release: $repo $tag $asset failed; trying the API asset URL" >&2
id=$(get "https://api.github.com/repos/$repo/releases/tags/$tag" \
  | jq -er --arg name "$asset" '.assets[] | select(.name == $name) | .id')
get -H 'Accept: application/octet-stream' -o "$out" "https://api.github.com/repos/$repo/releases/assets/$id"
