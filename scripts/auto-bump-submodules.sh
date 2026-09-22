#!/usr/bin/env bash
# Detect submodule tip drift and land pin bumps via an auto-merged PR.
#
# For each submodule in .gitmodules, the gitlink recorded in monorepo HEAD is
# compared against the remote branch tip (git ls-remote; submodules are never
# cloned). If any pin differs, the remote tip wins (pins track main): the
# auto/submodule-bump branch is force-updated with the new gitlink(s), pushed,
# and a PR is created or updated with auto-merge (squash) enabled.
#
# When packages/intentd moves, the bump also regenerates the generated
# docs/protocol/methods/mcp-bindings.md index from the ws.* help text in
# tools.rs at the new tip (a single-blob partial fetch, no clone), so the bump
# tree already passes check-mcp-bindings. The index is only touched when it
# differs from HEAD's, and any failure along the way is a warning: the
# gitlink-only bump still lands.
#
# packages/ios is best-effort: if its remote tip cannot be read (private repo,
# no token access), it is skipped with a warning and never fails the run.
#
# When no pin is behind but an auto/submodule-bump PR is still open (main
# already carries its pins, e.g. a labeled pin PR landed the same SHA), the
# stale PR is closed with a comment and its branch deleted, so it never sits
# open and red. A missing gh or a failed close only warns.
#
# Usage: auto-bump-submodules.sh [--dry-run]
#   --dry-run  Report which pins are behind; never writes, pushes, or
#              touches PRs. Requires only ambient git auth (no gh).
set -euo pipefail

BRANCH="auto/submodule-bump"
INTENTD_PATH="packages/intentd"
TOOLS_RS="crates/intent-acp/src/mcp_server/tools.rs"
INDEX_PATH="docs/protocol/methods/mcp-bindings.md"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -f .gitmodules ]; then
  echo "error: .gitmodules not found; run from the monorepo root" >&2
  exit 1
fi

warn() { echo "warning: $*" >&2; }

# Collect drifted submodules (parallel arrays).
paths=()
names=()
olds=()
news=()
repos=()
urls=()
while read -r key path; do
  name=${key#submodule.}
  name=${name%.path}
  url=$(git config -f .gitmodules --get "submodule.$name.url")
  branch=$(git config -f .gitmodules --get "submodule.$name.branch" || true)
  branch=${branch:-main}

  if ! old=$(git rev-parse --verify --quiet "HEAD:$path"); then
    warn "$path: no gitlink recorded in HEAD; skipping"
    continue
  fi

  if ! tip_line=$(git ls-remote "$url" "refs/heads/$branch") || [ -z "$tip_line" ]; then
    if [ "$path" = "packages/ios" ]; then
      warn "$path: cannot read remote tip (no token access?); skipping"
      continue
    fi
    echo "error: $path: git ls-remote $url refs/heads/$branch failed" >&2
    exit 1
  fi
  new=${tip_line%%[[:space:]]*}

  if [ "$old" = "$new" ]; then
    echo "$path: up to date at ${old:0:7}"
    continue
  fi

  repo=${url#https://github.com/}
  repo=${repo%.git}
  echo "$path: behind (${old:0:7} -> ${new:0:7})"
  paths+=("$path")
  names+=("${path##*/}")
  olds+=("$old")
  news+=("$new")
  repos+=("$repo")
  urls+=("$url")
done < <(git config -f .gitmodules --get-regexp '^submodule\..*\.path$')

# Close a rolling PR left open once main already carries its pins; every
# failure only warns so a missing or failing gh never fails the run.
close_stale_pr() {
  local pr
  if ! command -v gh >/dev/null 2>&1; then
    warn "gh not found; cannot check for a stale $BRANCH PR"
    return 0
  fi
  if ! pr=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty'); then
    warn "could not list open $BRANCH PRs; leaving any stale PR open"
    return 0
  fi
  if [ -z "$pr" ]; then
    return 0
  fi
  if gh pr close "$pr" --delete-branch --comment "Closing: \`main\` already carries these submodule pins, so this rolling bump PR is stale. The next pin drift opens a fresh one."; then
    echo "Closed stale PR #$pr (main already carries its pins) and deleted $BRANCH."
  else
    warn "could not close stale PR #$pr; leaving it open"
  fi
}

if [ ${#paths[@]} -eq 0 ]; then
  echo "All submodule pins match their remote tips; nothing to do."
  if [ "$DRY_RUN" = 1 ]; then
    echo "dry-run: skipping the stale $BRANCH PR check (requires gh)."
    exit 0
  fi
  close_stale_pr
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "dry-run: would bump ${#paths[@]} submodule pin(s) via branch $BRANCH"
  exit 0
fi

# "intentd" / "intentd and cloudlands-fe" / "intentd, cloudlands-fe and ios"
join_names() {
  local n=${#names[@]} out i
  out=${names[0]}
  for ((i = 1; i < n - 1; i++)); do out+=", ${names[i]}"; done
  if [ "$n" -gt 1 ]; then out+=" and ${names[n - 1]}"; fi
  printf '%s' "$out"
}

plural=submodule
if [ ${#names[@]} -gt 1 ]; then plural=submodules; fi
title="chore: update $(join_names) $plural to latest main"

commit_body=""
for i in "${!paths[@]}"; do
  commit_body+="${paths[i]}: ${olds[i]:0:7} -> ${news[i]:0:7}"$'\n'
done

export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-github-actions[bot]}
export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}
export GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}

tmp_index=$(mktemp)
pr_body_file=$(mktemp)
tmp_work=$(mktemp -d)
trap 'rm -f "$tmp_index" "$pr_body_file"; rm -rf "$tmp_work"' EXIT

# Run git in another repository with the http credentials actions/checkout
# persisted for this checkout (the SUBMODULE_BUMP_TOKEN extraheader; newer
# checkout versions reach it through an includeIf, hence --includes), passed
# through the environment rather than argv.
git_with_http_config() (
  n=0
  while read -r key value; do
    export "GIT_CONFIG_KEY_$n=$key" "GIT_CONFIG_VALUE_$n=$value"
    n=$((n + 1))
  done < <(git config --includes --get-regexp '^http\..*\.extraheader$' || true)
  GIT_CONFIG_COUNT=$n exec git "$@"
)

# Regenerate the mcp-bindings index against tools.rs at the new intentd tip.
# Sets index_blob to the regenerated index's blob id when it differs from
# HEAD's; every failure only warns and leaves index_blob empty.
index_blob=""
regenerate_bindings_index() {
  local url=$1 sha=$2 repo=$tmp_work/intentd.git root=$tmp_work/root new_blob head_blob
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; $INDEX_PATH not regenerated"
    return 0
  fi
  mkdir -p "$root/${INTENTD_PATH}/${TOOLS_RS%/*}"
  # Partial fetch of one commit (trees only), then a lazy fetch of the single blob.
  if ! { git init --quiet --bare "$repo" &&
         git -C "$repo" remote add origin "$url" &&
         git_with_http_config -C "$repo" fetch --quiet --depth=1 --filter=blob:none origin "$sha" &&
         git_with_http_config -C "$repo" cat-file blob "$sha:$TOOLS_RS" > "$root/$INTENTD_PATH/$TOOLS_RS"; }; then
    warn "$INTENTD_PATH: could not fetch $TOOLS_RS at ${sha:0:7}; $INDEX_PATH not regenerated"
    return 0
  fi
  if ! git archive "$head" docs/protocol | tar -x -C "$root"; then
    warn "could not extract docs/protocol from HEAD; $INDEX_PATH not regenerated"
    return 0
  fi
  # A non-zero exit here is normally prose drift in docs/protocol, reported
  # after the index was already written; the written index is still used.
  if ! node scripts/check-mcp-bindings.mjs --write "$root"; then
    warn "check-mcp-bindings exited non-zero against intentd ${sha:0:7}; using whatever index it wrote"
  fi
  if [ ! -f "$root/$INDEX_PATH" ]; then
    warn "check-mcp-bindings did not write $INDEX_PATH; not regenerated"
    return 0
  fi
  if ! new_blob=$(git hash-object -w "$root/$INDEX_PATH") || [ -z "$new_blob" ]; then
    warn "could not store the regenerated $INDEX_PATH as a blob; not regenerated"
    return 0
  fi
  head_blob=$(git rev-parse --verify --quiet "$head:$INDEX_PATH" || true)
  if [ "$new_blob" = "$head_blob" ]; then
    echo "$INDEX_PATH: unchanged by intentd ${sha:0:7}"
  else
    index_blob=$new_blob
    echo "$INDEX_PATH: regenerated for intentd ${sha:0:7}"
  fi
}

# Build the bumped tree in a temporary index; the worktree is never touched.
head=$(git rev-parse HEAD)
GIT_INDEX_FILE=$tmp_index git read-tree "$head"
for i in "${!paths[@]}"; do
  GIT_INDEX_FILE=$tmp_index git update-index --cacheinfo "160000,${news[i]},${paths[i]}"
  if [ "${paths[i]}" = "$INTENTD_PATH" ]; then
    regenerate_bindings_index "${urls[i]}" "${news[i]}" || warn "$INDEX_PATH regeneration failed; continuing with the gitlink-only bump"
  fi
done
if [ -n "$index_blob" ]; then
  if GIT_INDEX_FILE=$tmp_index git update-index --cacheinfo "100644,$index_blob,$INDEX_PATH"; then
    commit_body+=$'\n'"$INDEX_PATH: regenerated from the new intentd ws.* help text"$'\n'
  else
    warn "could not add the regenerated $INDEX_PATH to the bump tree; continuing with the gitlink-only bump"
    index_blob=""
  fi
fi
tree=$(GIT_INDEX_FILE=$tmp_index git write-tree)

# Skip the push when the remote branch already carries this exact tree, so
# repeated runs don't churn the PR (and its CI) with identical commits.
push_needed=1
if git fetch --quiet origin "refs/heads/$BRANCH" 2>/dev/null; then
  if [ "$(git rev-parse --verify --quiet 'FETCH_HEAD^{tree}' || true)" = "$tree" ]; then
    push_needed=0
    echo "Branch $BRANCH already has the desired pins; skipping push."
  fi
fi
if [ "$push_needed" = 1 ]; then
  commit=$(git commit-tree "$tree" -p "$head" -m "$title" -m "$commit_body")
  git push --force origin "$commit:refs/heads/$BRANCH"
  echo "Pushed $commit to $BRANCH."
fi

{
  echo "Automated submodule pin bump: pins track each submodule's \`main\` branch tip."
  echo
  echo "| Submodule | Old | New | Compare |"
  echo "|---|---|---|---|"
  for i in "${!paths[@]}"; do
    compare="https://github.com/${repos[i]}/compare/${olds[i]}...${news[i]}"
    echo "| ${paths[i]} | ${olds[i]:0:7} | ${news[i]:0:7} | [${olds[i]:0:7}...${news[i]:0:7}]($compare) |"
  done
  if [ -n "$index_blob" ]; then
    echo
    echo "Also regenerates \`$INDEX_PATH\` from the new intentd \`ws.*\` help text (\`node scripts/check-mcp-bindings.mjs --write\`), so \`check-mcp-bindings\` passes on this tree."
  fi
} > "$pr_body_file"

pr=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
if [ -n "$pr" ]; then
  gh pr edit "$pr" --title "$title" --body-file "$pr_body_file"
  echo "Updated existing PR #$pr."
else
  gh pr create --head "$BRANCH" --title "$title" --body-file "$pr_body_file"
  pr=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
  echo "Created PR #$pr."
fi

# Enabling auto-merge fails when the PR is already in clean status ("Pull
# request is in clean status"); fall back to a direct squash merge so the PR
# doesn't sit open unmerged. Only if both fail do we warn and leave it open.
if ! gh pr merge "$pr" --auto --squash; then
  warn "could not enable auto-merge on PR #$pr; attempting direct merge"
  if ! gh pr merge "$pr" --squash; then
    warn "could not merge PR #$pr; leaving it open"
  fi
fi
