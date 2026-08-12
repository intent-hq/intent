#!/usr/bin/env bash
# Detect submodule tip drift and land pin bumps via an auto-merged PR.
#
# For each submodule in .gitmodules, the gitlink recorded in monorepo HEAD is
# compared against the remote branch tip (git ls-remote; submodules are never
# cloned). If any pin differs, the remote tip wins (pins track main): the
# auto/submodule-bump branch is force-updated with the new gitlink(s), pushed,
# and a PR is created or updated with auto-merge (squash) enabled.
#
# packages/ios is best-effort: if its remote tip cannot be read (private repo,
# no token access), it is skipped with a warning and never fails the run.
#
# Usage: auto-bump-submodules.sh [--dry-run]
#   --dry-run  Report which pins are behind; never writes, pushes, or
#              touches PRs. Requires only ambient git auth (no gh).
set -euo pipefail

BRANCH="auto/submodule-bump"
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
done < <(git config -f .gitmodules --get-regexp '^submodule\..*\.path$')

if [ ${#paths[@]} -eq 0 ]; then
  echo "All submodule pins match their remote tips; nothing to do."
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
trap 'rm -f "$tmp_index" "$pr_body_file"' EXIT

# Build the bumped tree in a temporary index; the worktree is never touched.
head=$(git rev-parse HEAD)
GIT_INDEX_FILE=$tmp_index git read-tree "$head"
for i in "${!paths[@]}"; do
  GIT_INDEX_FILE=$tmp_index git update-index --cacheinfo "160000,${news[i]},${paths[i]}"
done
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

if ! gh pr merge "$pr" --auto --squash; then
  warn "could not enable auto-merge on PR #$pr; leaving it open"
fi
