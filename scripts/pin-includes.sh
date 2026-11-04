#!/usr/bin/env bash
# Answer "does the monorepo's pinned commit of this component include commit X
# yet?" for one or more component commits.
#
#   scripts/pin-includes.sh <intentd|cloudlands-fe> <commit-sha> \
#     [<intentd|cloudlands-fe> <commit-sha>]...
#
# A monorepo PR that depends on a component change (a Makefile target or flag,
# a doc that names a new method) must not merge before the auto-bump has
# advanced the pin to a commit that carries that change (intent#8512 waited
# on cloudlands-fe#4146 with a hand-written hook). Pass the component's merge
# commit on main -- a PR branch commit is never included after a squash merge.
#
# For each pair, the gitlink packages/<component> on intent-hq/intent main is
# read through the contents API, and the pair counts as included when the
# GitHub compare `<sha>...<pin>` on intent-hq/<component> reports `ahead` or
# `identical`. `behind` means the pin has not caught up yet. `diverged` means
# the commit and the pin do not share history: when the commit is not on the
# component's main either (compare `<sha>...main`), it can never be pinned and
# the script fails; otherwise the pin sits off main and the pair keeps waiting.
#
# Exit codes: 0 = every pair is included (stdout: one
# `<component> <pin> includes <sha>` line per pair); 3 = at least one pair is
# not included yet (stdout empty; stderr names each waiting pair and the
# current pin); 4 = transient GitHub failure (rate limit, 5xx, network) --
# retry later; 2 = usage error; 1 = any other gh/API failure, an unknown
# commit, or a commit that is not on the component's main. gh's own error text
# is appended to the message on 1 and 4.
# Must parse and run under Bash 3.2 (stock macOS).

set -euo pipefail

monorepo=intent-hq/intent
monorepo_ref=main

usage() {
  echo "Usage: $0 <intentd|cloudlands-fe> <commit-sha> [<intentd|cloudlands-fe> <commit-sha>]..." >&2
  exit 2
}

(($# >= 2 && $# % 2 == 0)) || usage
components=()
shas=()
while (($# > 0)); do
  case "$1" in
    intentd | cloudlands-fe) ;;
    *) usage ;;
  esac
  [[ "$2" =~ ^[0-9a-fA-F]{7,40}$ ]] || usage
  components+=("$1")
  shas+=("$2")
  shift 2
done

gh_err=$(mktemp)
trap 'rm -f "$gh_err"' EXIT

transient_pattern='rate limit|HTTP 429|HTTP 5[0-9]{2}|error connecting|connection (reset|refused)|timeout|no such host|network is unreachable|temporary failure|unexpected EOF'

# Report a failed gh call: exit 4 when its stderr looks transient, else 1.
gh_fail() {
  local detail
  detail=$(<"$gh_err")
  detail=${detail//$'\n'/ }
  echo "pin-includes: $*${detail:+: $detail}" >&2
  if grep -qiE "$transient_pattern" "$gh_err"; then
    exit 4
  fi
  exit 1
}

fail() {
  echo "pin-includes: $*" >&2
  exit 1
}

# Sets $pin to the component's gitlink. Pins are cached per component (a
# component named twice is read once), so this runs in the current shell.
pinned_components=()
pinned_shas=()
read_pin() {
  local component=$1 i
  for ((i = 0; i < ${#pinned_components[@]}; i++)); do
    if [[ "${pinned_components[i]}" == "$component" ]]; then
      pin=${pinned_shas[i]}
      return 0
    fi
  done
  pin=$(gh api "repos/$monorepo/contents/packages/$component?ref=$monorepo_ref" \
    --jq 'select(.type == "submodule") | .sha' 2>"$gh_err") ||
    gh_fail "gh api contents packages/$component on $monorepo $monorepo_ref failed"
  [[ "$pin" =~ ^[0-9a-f]{40}$ ]] ||
    fail "packages/$component on $monorepo $monorepo_ref is not a submodule gitlink (got '$pin')"
  pinned_components+=("$component")
  pinned_shas+=("$pin")
}

compare_status() {
  local repo=$1 base=$2 head=$3 status
  if ! status=$(gh api "repos/$repo/compare/$base...$head" --jq .status 2>"$gh_err"); then
    if grep -qE 'HTTP 404|Not Found' "$gh_err"; then
      gh_fail "commit $base is unknown on $repo"
    fi
    gh_fail "gh api compare $base...$head on $repo failed"
  fi
  printf '%s\n' "$status"
}

included=()
waiting=()
for ((i = 0; i < ${#components[@]}; i++)); do
  component=${components[i]}
  sha=${shas[i]}
  repo=intent-hq/$component
  read_pin "$component"
  status=$(compare_status "$repo" "$sha" "$pin")
  case "$status" in
    ahead | identical)
      included+=("$component $pin includes $sha")
      ;;
    behind)
      waiting+=("$component $sha is not in the $monorepo $monorepo_ref pin $pin yet")
      ;;
    diverged)
      main_status=$(compare_status "$repo" "$sha" main)
      case "$main_status" in
        ahead | identical)
          waiting+=("$component $sha is not in the $monorepo $monorepo_ref pin $pin, which is not on $repo main")
          ;;
        *)
          fail "$component $sha is not on $repo main ($main_status), so no pin will include it; pass the merge commit on main, not a PR branch commit"
          ;;
      esac
      ;;
    *)
      fail "unexpected compare status '$status' for $sha...$pin on $repo"
      ;;
  esac
done

if ((${#waiting[@]} > 0)); then
  for line in "${waiting[@]}"; do
    echo "pin-includes: $line" >&2
  done
  exit 3
fi

printf '%s\n' "${included[@]}"
