#!/usr/bin/env bash
# Offline GitHub state and receive protection for auto-bump-submodules.test.sh.
# State lives outside the bare remote so its pre-receive hook sees the same PR.
set -euo pipefail

branch=auto/submodule-bump
state=$GH_STUB_DIR
remote_git() { "$GH_STUB_REAL_GIT" --git-dir="$GH_STUB_ORIGIN" "$@"; }

if [[ ${1:-} == --receive ]]; then
  while read -r old new ref; do
    [[ $ref == "refs/heads/$branch" ]] || continue
    printf '%s %s %s\n' "$old" "$new" "$ref" >>"$state/pushes"
    # Deterministic barrier: enqueue after the last preflight, before Git
    # accepts the update. No clocks, sleeps, or network services are involved.
    if [[ -f $state/enqueue-on-push ]]; then
      touch "$state/queued"
      rm "$state/enqueue-on-push"
    fi
    if [[ -f $state/reject-push ]]; then
      cat "$state/reject-push" >&2
      exit 1
    fi
    if [[ -f $state/queued ]]; then
      cat >&2 <<'ERROR'
error: GH006: Protected branch update failed for refs/heads/auto/submodule-bump.

- A pull request for this branch has been added to a merge queue. Branches that
  are queued for merging cannot be updated. To modify this branch, dequeue the
  associated pull request.
ERROR
      exit 1
    fi
  done
  exit 0
fi

printf '%s\n' "$*" >>"$GH_TEST_LOG"
args=("$@")
option() {
  local i
  for ((i=0; i<${#args[@]}-1; i++)); do
    if [[ ${args[i]} == "$1" ]]; then printf '%s' "${args[i+1]}"; return; fi
  done
}
field() {
  local arg
  for arg in "${args[@]}"; do
    if [[ $arg == "$1="* ]]; then printf '%s' "${arg#*=}"; return; fi
  done
}
emit() {
  local filter
  filter=$(option --jq)
  [[ -n $filter ]] || filter=$(option -q)
  if [[ -n $filter ]]; then jq -r "$filter"; else cat; fi
}
pr_json() {
  local number=$1 pr_state=CLOSED queued=false auto=false head='' title='' body=''
  [[ ! -f $state/pr || $(<"$state/pr") != "$number" ]] || pr_state=OPEN
  [[ ! -f $state/merged-$number ]] || pr_state=MERGED
  [[ ! -f $state/queued || $pr_state != OPEN ]] || queued=true
  head=$(remote_git rev-parse --verify "refs/heads/$branch" 2>/dev/null || true)
  [[ ! -f $state/merged-$number ]] || head=$(<"$state/merged-$number")
  [[ ! -f $state/auto-merge || $(<"$state/auto-merge") != "$number" ]] || auto=true
  [[ ! -f $state/title ]] || title=$(<"$state/title")
  [[ ! -f $state/body ]] || body=$(<"$state/body")
  jq -n --argjson number "$number" --arg state "$pr_state" --argjson queued "$queued" \
    --arg head "$head" --arg branch "$branch" --arg title "$title" --arg body "$body" --argjson auto "$auto" \
    '{number:$number, state:$state, headRefName:$branch, headRefOid:$head,
      title:$title, body:$body, autoMergeRequest:(if $auto then {enabledAt:"2026-01-01T00:00:00Z", mergeMethod:"SQUASH"} else null end),
      url:("https://github.com/fixture/intent/pull/" + ($number|tostring)),
      mergeStateStatus:"CLEAN", mergeQueueEntry:(if $queued then {id:"queue-entry"} else null end),
      isInMergeQueue:$queued}'
}
emit_pr() {
  local fields field
  fields=$(option --json)
  # These are real gh --json fields. Queue membership requires GraphQL;
  # accepting an invented --json mergeQueueEntry field would mask a bug.
  IFS=',' read -ra requested <<<"$fields"
  for field in "${requested[@]}"; do
    case $field in
      number|state|headRefName|headRefOid|title|body|autoMergeRequest|url|mergeStateStatus) ;;
      *) echo "stub: unsupported gh JSON field: $field" >&2; exit 1 ;;
    esac
  done
  jq --arg fields "$fields" '
    def project: with_entries(select(.key as $k | $fields | split(",") | index($k)));
    if type == "array" then map(project) else project end' | emit
}
merge_during_lookup() {
  [[ -f $state/merge-on-lookup && -f $state/pr ]] || return 0
  local number head
  number=$(<"$state/pr")
  head=$(remote_git rev-parse "refs/heads/$branch")
  remote_git update-ref refs/heads/main "$head"
  remote_git update-ref -d "refs/heads/$branch"
  printf '%s\n' "$head" >"$state/merged-$number"
  rm -f "$state/pr" "$state/queued" "$state/merge-on-lookup"
}
require_open() {
  if [[ ! -f $state/pr || $(<"$state/pr") != "$1" ]]; then
    echo "stub: attempted $2 of non-open PR #$1" >>"$state/invalid-mutations"
    cat "$state/invalid-mutations" >&2
    exit 1
  fi
}

case "$1 ${2:-}" in
  "pr list")
    result='[]'
    if [[ -f $state/pr ]]; then result=$(pr_json "$(<"$state/pr")" | jq -s .); fi
    # The response can contain a PR which merges before the subsequent query.
    merge_during_lookup
    printf '%s\n' "$result" | emit_pr
    ;;
  "pr view")
    number=$3
    [[ $number != "$branch" ]] || number=$(<"$state/pr")
    result=$(pr_json "$number")
    merge_during_lookup
    printf '%s\n' "$result" | emit_pr
    ;;
  "api graphql")
    query=$(field query)
    # Accept query/variables in either gh field syntax, but reject unrelated
    # API calls instead of silently succeeding and hiding an incomplete fake.
    [[ "$query" == *mergeQueueEntry* || "$query" == *isInMergeQueue* ]] || {
      echo "stub: unexpected GraphQL query: $query" >&2; exit 1;
    }
    number=$(field number)
    if [[ $query =~ number:[[:space:]]*\$([a-zA-Z_][a-zA-Z_0-9]*) ]]; then
      number=$(field "${BASH_REMATCH[1]}")
    elif [[ $query =~ number:[[:space:]]*([0-9]+) ]]; then
      number=${BASH_REMATCH[1]}
    fi
    if [[ $number =~ ^[0-9]+$ ]]; then
      result=$(pr_json "$number" | jq '{data:{repository:{pullRequest:.}}}')
    elif [[ $query == *pullRequests* ]]; then
      result='[]'
      [[ ! -f $state/pr ]] || result=$(pr_json "$(<"$state/pr")" | jq -s .)
      result=$(jq '{data:{repository:{pullRequests:{nodes:.}}}}' <<<"$result")
    else
      echo "stub: GraphQL lookup must identify the PR: $query" >&2; exit 1
    fi
    merge_during_lookup
    printf '%s\n' "$result" | emit
    ;;
  "pr create")
    [[ ! -f $state/pr ]] || { echo 'stub: duplicate open rolling PR' >"$state/invalid-mutations"; exit 1; }
    number=42
    [[ ! -f $state/next-pr ]] || number=$(<"$state/next-pr")
    echo "$number" >"$state/pr"
    echo "$((number+1))" >"$state/next-pr"
    option --title >"$state/title"
    cp "$(option --body-file)" "$state/body"
    ;;
  "pr edit")
    require_open "$3" edit
    option --title >"$state/title"
    cp "$(option --body-file)" "$state/body"
    ;;
  "pr close")
    require_open "$3" close
    echo "$3" >"$state/closed"
    rm -f "$state/pr" "$state/queued"
    if [[ " $* " == *' --delete-branch '* ]]; then remote_git update-ref -d "refs/heads/$branch"; fi
    ;;
  "pr merge") require_open "$3" merge; echo "$3" >"$state/auto-merge" ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
