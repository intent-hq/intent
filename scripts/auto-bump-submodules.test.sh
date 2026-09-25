#!/usr/bin/env bash
# Hermetic fixtures for auto-bump-submodules.sh: a bare "intentd" remote, a
# bare monorepo "origin" with a clone whose packages/intentd gitlink points at
# the intentd remote over file://, and a gh stub that logs argv and keeps one
# open auto/submodule-bump PR as state. Nothing here reaches the network.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/auto-bump-submodules.sh"
checker="$repo_root/scripts/check-mcp-bindings.mjs"
workflow="$repo_root/.github/workflows/auto-bump-submodules.yml"
gh_fixture="$repo_root/scripts/auto-bump-submodules-gh.fixture.sh"
# Sibling modules the checker imports; the fixture copies them alongside it.
checker_deps=(check-makefile-targets.mjs submodule-ref.mjs)
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
stub_dir="$temp_dir/stub"
intentd_src="$temp_dir/intentd-src"
intentd_remote="$temp_dir/intentd.git"
origin="$temp_dir/origin.git"
mono="$temp_dir/mono"
tools_rs=crates/intent-acp/src/mcp_server/tools.rs
index_path=docs/protocol/methods/mcp-bindings.md
branch=auto/submodule-bump
mkdir -p "$bin_dir" "$stub_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "auto-bump-submodules test failed: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required (the bump regenerates $index_path with it)"
command -v jq >/dev/null 2>&1 || fail "jq is required to model gh JSON responses"
# Do not inherit URL rewrites, credentials, signing, or external transports.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0
export GH_STUB_DIR="$stub_dir" GH_STUB_ORIGIN="$origin" GH_TEST_LOG="$temp_dir/gh.log"
GH_STUB_REAL_GIT=$(command -v git)
export GH_STUB_REAL_GIT

# Fixture commits use a fixed identity; the script under test picks its own
# (github-actions[bot]) from the environment defaults.
git_fx() {
  git -c user.name=fixture -c user.email=fixture@example.com -c commit.gpgsign=false "$@"
}

cp "$gh_fixture" "$bin_dir/gh"
chmod +x "$bin_dir/gh"

# Stub git for fault injection: fails the invocation whose argv contains
# GIT_STUB_FAIL (when set) and defers every other call to the real git.
real_git=$(command -v git)
cat >"$bin_dir/git" <<SH
#!/usr/bin/env bash
if [[ -n "\${GIT_STUB_FAIL:-}" && " \$* " == *"\$GIT_STUB_FAIL"* ]]; then
  printf '%s\n' "\${GIT_STUB_ERROR:-stub: failing git \$*}" >&2
  exit 1
fi
exec "$real_git" "\$@"
SH
chmod +x "$bin_dir/git"

# tools.rs with the two help-text constants the checker extracts; $1 lists
# extra API lines for the base constant.
write_tools_rs() {
  local extra=${1:-}
  mkdir -p "$intentd_src/${tools_rs%/*}"
  cat >"$intentd_src/$tools_rs" <<RS
pub const WORKSPACE_API_DESCRIPTION: &str = r#"Execute JavaScript against the workspace API.

Namespaces (index):
  ws.help(namespace?) — runtime docs

API:
  ws.help(namespace?) → string  // Offline API docs.

  ws.note.read(id) → { id, title, content }  // Read a note.
  ws.note.list(tag?) → [{ id, title }]  // List notes.
${extra}"#;

pub const WORKSPACE_API_DESCRIPTION_CHIEF: &str = r#"Chief-of-staff variant.

API:
  ws.help(namespace?) → string  // Offline API docs.
  ws.note.read(id) → { id, title, content }  // Read a note.
"#;
RS
}

git_fx init -q -b main "$intentd_src"
write_tools_rs
git_fx -C "$intentd_src" add -A
git_fx -C "$intentd_src" commit -qm "initial help text"
intentd_c0=$(git -C "$intentd_src" rev-parse HEAD)
git clone -q --bare "$intentd_src" "$intentd_remote"
# GitHub serves partial clones and any-SHA wants; the fixture remote must too.
git -C "$intentd_remote" config uploadpack.allowFilter true
git -C "$intentd_remote" config uploadpack.allowAnySHA1InWant true
intentd_url="file://$intentd_remote"

# Later intentd tips, published to the remote one case at a time.
write_tools_rs "  ws.note.delete(id) → { ok, noteId }  // Delete a note."$'\n'
git_fx -C "$intentd_src" commit -qam "add ws.note.delete"
intentd_c1=$(git -C "$intentd_src" rev-parse HEAD)
echo "# intentd" >"$intentd_src/README.md"
git_fx -C "$intentd_src" add README.md
git_fx -C "$intentd_src" commit -qm "docs only"
intentd_c2=$(git -C "$intentd_src" rev-parse HEAD)
publish_intentd() {
  git -C "$intentd_src" push -q "$intentd_remote" "$1:refs/heads/main"
}

# The monorepo: checker, protocol docs, the index generated from the OLD help
# text, and a gitlink at intentd_c0 (an empty dir stands in for the
# uninitialized submodule).
git_fx init -q -b main "$mono"
mkdir -p "$mono/scripts" "$mono/docs/protocol/methods" "$mono/packages/intentd" "$mono/.github/workflows"
cp "$script" "$mono/scripts/auto-bump-submodules.sh"
cp "$workflow" "$mono/.github/workflows/auto-bump-submodules.yml"
cp "$checker" "$mono/scripts/check-mcp-bindings.mjs"
for dep in "${checker_deps[@]}"; do cp "$repo_root/scripts/$dep" "$mono/scripts/$dep"; done
printf '# Protocol docs\n' >"$mono/docs/protocol/README.md"
printf '[submodule "intentd"]\n\tpath = packages/intentd\n\turl = %s\n' "$intentd_url" >"$mono/.gitmodules"
gen="$temp_dir/gen"
mkdir -p "$gen/packages/intentd/${tools_rs%/*}" "$gen/docs/protocol"
git -C "$intentd_remote" show "$intentd_c0:$tools_rs" >"$gen/packages/intentd/$tools_rs"
cp "$mono/docs/protocol/README.md" "$gen/docs/protocol/README.md"
node "$checker" --write "$gen" >/dev/null || fail "could not generate the fixture index"
cp "$gen/$index_path" "$mono/$index_path"
git_fx -C "$mono" add -A
git_fx -C "$mono" update-index --add --cacheinfo "160000,$intentd_c0,packages/intentd"
git_fx -C "$mono" commit -qm "monorepo at intentd ${intentd_c0:0:7}"
base=$(git -C "$mono" rev-parse HEAD)
git init -q --bare -b main "$origin"
cat >"$origin/hooks/pre-receive" <<SH
#!/usr/bin/env bash
exec bash "$gh_fixture" --receive
SH
chmod +x "$origin/hooks/pre-receive"
git -C "$mono" remote add origin "$origin"
git -C "$mono" push -q origin main

run_script() {
  set +e
  (cd "$mono" && export PATH="$bin_dir:$PATH"
    if [[ -n ${WORKFLOW_COMMAND:-} ]]; then bash -e -o pipefail -c "$WORKFLOW_COMMAND"
    else bash "$script" "$@"; fi) >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}
reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$stub_dir"
  : >"$temp_dir/gh.log"
}
bump_commit() {
  git -C "$origin" rev-parse --verify --quiet "refs/heads/$branch"
}
# Paths a commit touches, one per line, sorted.
touched_paths() {
  git -C "$origin" diff-tree --no-commit-id --name-only -r "$1" | sort
}
gitlink_at() {
  git -C "$origin" ls-tree "$1" packages/intentd | awk '$1 == "160000" { print $3 }'
}

# Fail-soft: when the regenerated index cannot be stored as a blob or added to
# the bump tree, the bump still lands gitlink-only with a warning, and neither
# the commit body nor the PR body claims a regeneration.
publish_intentd "$intentd_c1"
for fault in "hash-object -w" "update-index --cacheinfo 100644,"; do
  reset_stub
  GIT_STUB_FAIL="$fault" run_script
  [[ "$status" -eq 0 ]] || fail "bump with failing 'git $fault' exited $status: $stderr"
  [[ "$stderr" == *"warning: could not "*"$index_path"* ]] || fail "failing 'git $fault' did not warn: $stderr"
  bump=$(bump_commit) || fail "failing 'git $fault' pushed no $branch"
  [[ "$stdout" == *"Pushed $bump to $branch."* ]] || fail "failing 'git $fault' did not report the push: $stdout"
  [[ "$(gitlink_at "$bump")" == "$intentd_c1" ]] || fail "failing 'git $fault' did not move the gitlink"
  [[ "$(touched_paths "$bump")" == "packages/intentd" ]] || fail "failing 'git $fault' bump touched: $(touched_paths "$bump")"
  [[ "$(git -C "$origin" log -1 --format=%b "$bump")" != *"regenerated"* ]] || fail "failing 'git $fault' bump body mentions the index"
  [[ -f "$stub_dir/body" ]] || fail "failing 'git $fault' created no PR"
  ! grep -q "regenerates" "$stub_dir/body" || fail "failing 'git $fault' PR body claims a regeneration: $(<"$stub_dir/body")"
  git -C "$origin" update-ref -d "refs/heads/$branch"
done

# Case 1: the intentd tip adds a ws.* help line. The pushed bump commit moves
# the gitlink and regenerates the index, and the checker passes on that tree.
reset_stub
run_script
[[ "$status" -eq 0 ]] || fail "changed help text bump exited $status: $stderr"
[[ "$stdout" == *"packages/intentd: behind (${intentd_c0:0:7} -> ${intentd_c1:0:7})"* ]] || fail "drift not reported: $stdout"
[[ "$stdout" == *"$index_path: regenerated for intentd ${intentd_c1:0:7}"* ]] || fail "index regeneration not reported: $stdout"
[[ "$stderr" != *"warning:"* ]] || fail "changed help text bump warned: $stderr"
bump1=$(bump_commit) || fail "no $branch pushed to origin"
[[ "$stdout" == *"Pushed $bump1 to $branch."* ]] || fail "pushed commit not reported: $stdout"
[[ "$(gitlink_at "$bump1")" == "$intentd_c1" ]] || fail "gitlink not moved to ${intentd_c1:0:7}: $(git -C "$origin" ls-tree "$bump1" packages/intentd)"
[[ "$(touched_paths "$bump1")" == "$index_path"$'\n'"packages/intentd" ]] || fail "bump commit touched: $(touched_paths "$bump1")"
[[ "$(git -C "$origin" rev-parse "$bump1^")" == "$(git -C "$mono" rev-parse HEAD)" ]] || fail "bump commit is not a child of HEAD"
[[ "$(git -C "$origin" log -1 --format=%s "$bump1")" == "chore: update intentd submodule to latest main" ]] || fail "bump commit subject: $(git -C "$origin" log -1 --format=%s "$bump1")"
[[ "$(git -C "$origin" log -1 --format=%b "$bump1")" == *"packages/intentd: ${intentd_c0:0:7} -> ${intentd_c1:0:7}"*"$index_path: regenerated from the new intentd ws.* help text"* ]] || fail "bump commit body: $(git -C "$origin" log -1 --format=%b "$bump1")"
git -C "$origin" show "$bump1:$index_path" | grep -qF 'ws.note.delete(id) → { ok, noteId }' || fail "regenerated index lacks the new binding"
grep -q "^pr create --head $branch --title chore: update intentd submodule to latest main --body-file " "$temp_dir/gh.log" || fail "PR was not created: $(<"$temp_dir/gh.log")"
grep -q "^pr merge 42 --auto --squash$" "$temp_dir/gh.log" || fail "auto-merge was not armed: $(<"$temp_dir/gh.log")"
checkout="$temp_dir/checkout1"
mkdir -p "$checkout/packages/intentd"
git -C "$origin" archive "$bump1" | tar -x -C "$checkout"
git -C "$intentd_remote" archive "$intentd_c1" | tar -x -C "$checkout/packages/intentd"
node "$checkout/scripts/check-mcp-bindings.mjs" "$checkout" >/dev/null || fail "check-mcp-bindings fails on the bump tree"
# Sanity: the old index against the new help text is what the bump fixed.
rm -rf "$checkout/docs/protocol"
git -C "$origin" archive "$bump1^" docs/protocol | tar -x -C "$checkout"
! node "$checkout/scripts/check-mcp-bindings.mjs" "$checkout" >/dev/null 2>&1 || fail "the old index already passed against the new help text; case 1 proves nothing"

# Case 5: a rerun with the same drift builds the identical tree and skips the
# push, only refreshing the open PR.
: >"$temp_dir/gh.log"
run_script
[[ "$status" -eq 0 ]] || fail "rerun exited $status: $stderr"
[[ "$stdout" == *"Branch $branch already has the desired pins; skipping push."* ]] || fail "rerun did not skip the push: $stdout"
[[ "$stdout" != *"Pushed "* ]] || fail "rerun pushed: $stdout"
[[ "$(bump_commit)" == "$bump1" ]] || fail "rerun moved $branch"
grep -q "^pr edit 42 --title chore: update intentd submodule to latest main --body-file " "$temp_dir/gh.log" || fail "rerun did not refresh PR 42: $(<"$temp_dir/gh.log")"
! grep -q '^pr create' "$temp_dir/gh.log" || fail "rerun created a second PR"

# Case 2: the bump landed on main; the next intentd tip leaves the help text
# unchanged, so the new bump commit touches only the gitlink.
git -C "$mono" fetch -q origin "refs/heads/$branch"
git -C "$mono" reset -q --hard FETCH_HEAD
git -C "$mono" push -q origin HEAD:main
git -C "$origin" update-ref -d "refs/heads/$branch"
reset_stub
publish_intentd "$intentd_c2"
run_script
[[ "$status" -eq 0 ]] || fail "unchanged help text bump exited $status: $stderr"
[[ "$stdout" == *"$index_path: unchanged by intentd ${intentd_c2:0:7}"* ]] || fail "unchanged index not reported: $stdout"
bump2=$(bump_commit) || fail "no $branch pushed for the second bump"
[[ "$(gitlink_at "$bump2")" == "$intentd_c2" ]] || fail "gitlink not moved to ${intentd_c2:0:7}"
[[ "$(touched_paths "$bump2")" == "packages/intentd" ]] || fail "gitlink-only bump touched: $(touched_paths "$bump2")"
[[ "$(git -C "$origin" log -1 --format=%b "$bump2")" != *"regenerated"* ]] || fail "gitlink-only bump body mentions the index"
grep -q "^pr create --head $branch " "$temp_dir/gh.log" || fail "second bump did not create a PR: $(<"$temp_dir/gh.log")"

# Case 3: no pin is behind but a rolling PR is still open; it is closed with a
# comment and its branch deleted.
git -C "$mono" fetch -q origin "refs/heads/$branch"
git -C "$mono" reset -q --hard FETCH_HEAD
git -C "$mono" push -q origin HEAD:main
reset_stub
echo 7 >"$stub_dir/pr"
run_script
[[ "$status" -eq 0 ]] || fail "stale PR close exited $status: $stderr"
[[ "$stdout" == *"packages/intentd: up to date at ${intentd_c2:0:7}"*"All submodule pins match their remote tips; nothing to do."*"Closed stale PR #7 (main already carries its pins) and deleted $branch."* ]] || fail "stale PR close output: $stdout"
grep -q "^pr close 7 --delete-branch --comment Closing: " "$temp_dir/gh.log" || fail "gh pr close 7 was not invoked: $(<"$temp_dir/gh.log")"
[[ ! -f "$stub_dir/pr" ]] || fail "stub still has PR 7 open"
! bump_commit >/dev/null || fail "stale PR close left $branch on the remote"
! grep -qE '^pr (create|edit|merge)' "$temp_dir/gh.log" || fail "stale PR close touched the PR otherwise: $(<"$temp_dir/gh.log")"

# No drift and no open PR: only the list call.
reset_stub
run_script
[[ "$status" -eq 0 ]] || fail "no-drift no-PR exited $status: $stderr"
[[ "$stdout" != *"Closed stale PR"* ]] || fail "no-drift no-PR reported a close: $stdout"
[[ "$(<"$temp_dir/gh.log")" == "pr list --head $branch --state open --json number --jq .[0].number // empty" ]] || fail "no-drift no-PR gh calls: $(<"$temp_dir/gh.log")"

# Regression: intentd is current but the packages/ios tip cannot be read, so
# the open rolling PR may still carry an unlanded ios pin; it is not closed.
printf '[submodule "ios"]\n\tpath = packages/ios\n\turl = file://%s/missing-ios.git\n' "$temp_dir" >>"$mono/.gitmodules"
git_fx -C "$mono" add .gitmodules
git_fx -C "$mono" update-index --add --cacheinfo "160000,$intentd_c0,packages/ios"
git_fx -C "$mono" commit -qm "add ios submodule"
reset_stub
echo 7 >"$stub_dir/pr"
git -C "$origin" update-ref "refs/heads/$branch" "$bump2"
run_script
[[ "$status" -eq 0 ]] || fail "skipped ios read exited $status: $stderr"
[[ "$stderr" == *"warning: packages/ios: cannot read remote tip"* ]] || fail "skipped ios read did not warn: $stderr"
[[ "$stdout" == *"packages/intentd: up to date at ${intentd_c2:0:7}"*"Skipped packages/ios: "*"leaving it untouched."* ]] || fail "skipped ios read output: $stdout"
[[ "$stdout" != *"Closed stale PR"* ]] || fail "skipped ios read reported a close: $stdout"
! grep -q '^pr close' "$temp_dir/gh.log" || fail "skipped ios read closed the PR: $(<"$temp_dir/gh.log")"
[[ -f "$stub_dir/pr" ]] || fail "skipped ios read closed PR 7 in the stub"
[[ "$(bump_commit)" == "$bump2" ]] || fail "skipped ios read moved $branch"
git_fx -C "$mono" reset -q --hard HEAD~1

# Case 4: --dry-run with a stale PR present never calls gh.
reset_stub
echo 7 >"$stub_dir/pr"
run_script --dry-run
[[ "$status" -eq 0 ]] || fail "dry-run exited $status: $stderr"
[[ "$stdout" == *"All submodule pins match their remote tips; nothing to do."*"dry-run: skipping the stale $branch PR check (requires gh)."* ]] || fail "dry-run output: $stdout"
[[ ! -s "$temp_dir/gh.log" ]] || fail "dry-run invoked gh: $(<"$temp_dir/gh.log")"
[[ -f "$stub_dir/pr" ]] || fail "dry-run closed the PR"

# --dry-run with drift reports the plan and neither pushes nor calls gh.
git -C "$mono" reset -q --hard HEAD~1
git -C "$origin" update-ref -d "refs/heads/$branch"
reset_stub
run_script --dry-run
[[ "$status" -eq 0 ]] || fail "dry-run with drift exited $status: $stderr"
[[ "$stdout" == *"packages/intentd: behind (${intentd_c1:0:7} -> ${intentd_c2:0:7})"*"dry-run: would bump 1 submodule pin(s) via branch $branch"* ]] || fail "dry-run with drift output: $stdout"
! bump_commit >/dev/null || fail "dry-run with drift pushed $branch"
[[ ! -s "$temp_dir/gh.log" ]] || fail "dry-run with drift invoked gh: $(<"$temp_dir/gh.log")"

run_script --bogus
[[ "$status" -eq 2 ]] || fail "unknown argument exited $status (expected 2)"

echo "PASS: existing updater invariants"

# Each regression runs in its own subshell and restores the fixture refs.
# Run all cases even on a red implementation so failures are individually
# visible; do not mark expected regressions as skipped/xfail.
failures=0
run_case() {
  local name=$1 result
  shift
  set +e
  (set -e; "$@")
  result=$?
  set -e
  if [[ $result == 0 ]]; then echo "PASS: $name"
  else echo "FAIL: $name"; failures=$((failures+1)); fi
}
seed_pr() {
  reset_stub
  git -C "$mono" reset -q --hard "$base"
  git -C "$origin" update-ref refs/heads/main "$base"
  git -C "$origin" update-ref "refs/heads/$branch" "$bump1"
  git -C "$intentd_remote" update-ref refs/heads/main "$intentd_c1"
  echo 42 >"$stub_dir/pr"
  echo 43 >"$stub_dir/next-pr"
  echo 'Original queued title' >"$stub_dir/title"
  echo 'Original queued body' >"$stub_dir/body"
  echo 42 >"$stub_dir/auto-merge"
}
pr_snapshot() {
  local file
  for file in pr title body auto-merge; do
    printf '%s: ' "$file"
    if [[ -f $stub_dir/$file ]]; then cat "$stub_dir/$file"; else echo absent; fi
    echo
  done
}
assert_no_pr_writes() {
  ! grep -qE '^pr (create|edit|close|merge)' "$temp_dir/gh.log" || fail "mutated the PR: $(<"$temp_dir/gh.log")"
  [[ ! -f $stub_dir/invalid-mutations ]] || fail "invalid PR mutation: $(<"$stub_dir/invalid-mutations")"
}
assert_deferred() {
  [[ $(bump_commit) == "$bump1" ]] || fail "changed the queued remote commit"
  [[ $(pr_snapshot) == "$before_pr" ]] || fail "changed queued PR state: $(pr_snapshot)"
  [[ -f $stub_dir/queued ]] || fail "dequeued the PR"
  [[ $status == 0 ]] || fail "queued update exited $status instead of deferring: $stderr"
  grep -qiE 'defer|queu' <<<"$stdout $stderr" || fail "no queue/deferral diagnostic: $stdout $stderr"
  assert_no_pr_writes
}
queued_new_tip() {
  seed_pr
  touch "$stub_dir/queued"
  publish_intentd "$intentd_c2"
  before_pr=$(pr_snapshot)
  run_script
  assert_deferred
  [[ ! -s $stub_dir/pushes ]] || fail "preflight still attempted a queued push: $(<"$stub_dir/pushes")"
}
enqueue_after_check() {
  seed_pr
  touch "$stub_dir/enqueue-on-push"
  publish_intentd "$intentd_c2"
  before_pr=$(pr_snapshot)
  run_script
  [[ -s $stub_dir/pushes && -f $stub_dir/queued ]] || fail "enqueue race was not exercised"
  assert_deferred
}
queued_identical_tree() {
  seed_pr
  touch "$stub_dir/queued"
  before_pr=$(pr_snapshot)
  run_script
  assert_deferred
  [[ ! -s $stub_dir/pushes ]] || fail "identical tree attempted a push"
}
queued_current_pins() {
  seed_pr
  git -C "$mono" reset -q --hard "$bump1"
  git -C "$origin" update-ref refs/heads/main "$bump1"
  touch "$stub_dir/queued"
  before_pr=$(pr_snapshot)
  run_script
  assert_deferred
}
unqueued_stale_pr() {
  seed_pr
  git -C "$mono" reset -q --hard "$bump1"
  git -C "$origin" update-ref refs/heads/main "$bump1"
  run_script
  [[ $status == 0 ]] || fail "stale cleanup exited $status: $stderr"
  [[ ! -f $stub_dir/pr && $(<"$stub_dir/closed") == 42 ]] || fail "stale PR is still open"
  ! bump_commit >/dev/null || fail "stale branch was not deleted on the remote"
  [[ ! -s $stub_dir/pushes ]] || fail "stale cleanup pushed a commit"
}
unrelated_push_rejection() {
  seed_pr
  publish_intentd "$intentd_c2"
  before_pr=$(pr_snapshot)
  cat >"$stub_dir/reject-push" <<'ERROR'
error: GH006: Protected branch update failed for refs/heads/auto/submodule-bump.
error: Commits must have verified signatures.
ERROR
  run_script
  [[ $status != 0 ]] || fail "unrelated GH006 was swallowed as deferral"
  [[ $stderr == *'Commits must have verified signatures.'* ]] || fail "lost push rejection diagnostic: $stderr"
  [[ $(bump_commit) == "$bump1" && $(pr_snapshot) == "$before_pr" ]] || fail "failed push changed remote/PR state"
  [[ -s $stub_dir/pushes ]] || fail "push rejection was not exercised"
  assert_no_pr_writes
}
authentication_failure() {
  seed_pr
  publish_intentd "$intentd_c2"
  before_pr=$(pr_snapshot)
  GIT_STUB_FAIL='push ' GIT_STUB_ERROR='fatal: Authentication failed for fixture origin' run_script
  [[ $status != 0 ]] || fail "authentication failure was swallowed as deferral"
  [[ $stderr == *'Authentication failed'* ]] || fail "lost authentication diagnostic: $stderr"
  [[ $(bump_commit) == "$bump1" && $(pr_snapshot) == "$before_pr" ]] || fail "authentication failure changed remote/PR state"
  [[ ! -s $stub_dir/pushes ]] || fail "authentication failure reached the remote"
  assert_no_pr_writes
}
merged_during_lookup() {
  seed_pr
  touch "$stub_dir/queued" "$stub_dir/merge-on-lookup"
  run_script
  [[ -f $stub_dir/merged-42 ]] || fail "lookup race was not exercised"
  [[ $(git -C "$origin" rev-parse refs/heads/main) == "$bump1" ]] || fail "simulated merge lost the queued commit"
  [[ $status == 0 ]] || fail "merge during lookup exited $status: $stderr"
  assert_no_pr_writes
  [[ ! -f $stub_dir/pr ]] || fail "opened a duplicate PR for already merged pins"
  ! bump_commit >/dev/null || fail "recreated a stale branch after merge"
}

# Inspect the real workflow, following the block extraction convention used
# by consumer-checks.test.sh. Both block and inline scalar lists are accepted;
# unsupported filter syntax fails the contract instead of guessing semantics.
yaml_block() {
  local key=$1 indent=$2
  awk -v key="$key" -v indent="$indent" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    { n = match($0, /[^ ]/) - 1 }
    found && n <= indent { exit }
    n == indent && $0 ~ ("^ *" key ":") { found = 1; print; next }
    found { print }
  '
}
yaml_list() {
  local block
  block=$(yaml_block "$1" "$2")
  if [[ $block == *'['* ]]; then
    head -n 1 <<<"$block" | sed 's/^[^[]*\[//; s/\].*$//' | tr ',' '\n'
  else
    sed -n 's/^ *- *//p' <<<"$block"
  fi | sed "s/^[[:space:]\"']*//; s/[[:space:]\"']*$//" | sed '/^$/d'
}
workflow_step() {
  awk -v name="$1" '/^      - / { found = index($0, "- name: " name) > 0 } found { print }' "$workflow"
}
push_matches() {
  local event_branch=$1 paths=$2 push patterns pattern changed branch_ok=0
  push=$(yaml_block on 0 <"$workflow" | yaml_block push 2)
  [[ -n $push ]] || return 1
  patterns=$(yaml_list branches 4 <<<"$push")
  [[ -n $patterns ]] || branch_ok=1
  while IFS= read -r pattern; do
    # shellcheck disable=SC2053 # Workflow branch filters are glob patterns.
    [[ -z $pattern || $event_branch != $pattern ]] || branch_ok=1
  done <<<"$patterns"
  [[ $branch_ok == 1 ]] || return 1
  patterns=$(yaml_list paths 4 <<<"$push")
  [[ -n $patterns ]] || return 0
  while IFS= read -r changed; do
    while IFS= read -r pattern; do
      # shellcheck disable=SC2053 # Workflow path filters are glob patterns.
      [[ -z $pattern || $changed != $pattern ]] || return 0
    done <<<"$patterns"
  done <<<"$paths"
  return 1
}
workflow_filters() {
  local component push
  push=$(yaml_block on 0 <"$workflow" | yaml_block push 2)
  [[ -n $push ]] || fail "workflow has no push trigger to resume a merged queued bump"
  [[ $(yaml_list branches 4 <<<"$push") == main ]] || fail "continuation must be limited to main"
  [[ $(yaml_list paths 4 <<<"$push" | sort) == $'packages/cloudlands-fe\npackages/intentd\npackages/ios' ]] || fail "continuation paths must be the three gitlinks"
  ! grep -qE 'branches-ignore:|paths-ignore:' <<<"$push" || fail "unsupported negative push filters"
  for component in intentd cloudlands-fe ios; do
    push_matches main "packages/$component" || fail "merge of $component pins cannot trigger continuation"
  done
  ! push_matches main docs/protocol/methods/mcp-bindings.md || fail "docs-only push retriggers the updater"
  ! push_matches "$branch" packages/intentd || fail "updater branch push retriggers itself"
  ! push_matches unrelated packages/intentd || fail "non-main push triggers continuation"
  ! push_matches main '' || fail "no-change run retriggers itself"
}
workflow_checkout() {
  local checkout
  checkout=$(workflow_step Checkout)
  tr -d "\"'" <<<"$checkout" | grep -qE '^          ref: (refs/heads/)?main$' || fail "workflow checkout does not select current main (delayed event can be stale)"
}
workflow_existing_guards() {
  local triggers concurrency checkout bump_step
  triggers=$(yaml_block on 0 <"$workflow")
  grep -q '^  workflow_dispatch:' <<<"$triggers" || fail "lost manual dispatch"
  grep -q 'cron: "\*/30 \* \* \* \*"' <<<"$triggers" || fail "lost half-hour cron backstop"
  [[ $(yaml_block repository_dispatch 2 <<<"$triggers" | yaml_list types 4) == submodule-update ]] || fail "lost component dispatch"
  concurrency=$(yaml_block concurrency 0 <"$workflow")
  grep -q '^  group: auto-bump-submodules$' <<<"$concurrency" || fail "lost serialized updater group"
  grep -q '^  cancel-in-progress: false$' <<<"$concurrency" || fail "updater runs now cancel each other"
  checkout=$(workflow_step Checkout)
  bump_step=$(workflow_step 'Bump submodule pins')
  grep -qF 'token: ${{ secrets.SUBMODULE_BUMP_TOKEN }}' <<<"$checkout" || fail "checkout lost PAT credentials"
  grep -qF 'GH_TOKEN: ${{ secrets.SUBMODULE_BUMP_TOKEN }}' <<<"$bump_step" || fail "PR operations lost PAT credentials"
  grep -qF "if: steps.token.outputs.present == 'true'" <<<"$bump_step" || fail "lost missing-token guard"
}
simulate_merge() {
  local number commit
  number=$(<"$stub_dir/pr")
  commit=$(bump_commit)
  git -C "$origin" update-ref refs/heads/main "$commit"
  git -C "$origin" update-ref -d "refs/heads/$branch"
  echo "$commit" >"$stub_dir/merged-$number"
  rm -f "$stub_dir/pr" "$stub_dir/queued"
}
run_push_event() {
  local old=$1 event_sha=$2 changed checkout_ref command fresh
  changed=$(git -C "$origin" diff --name-only "$old" "$event_sha")
  push_matches main "$changed" || fail "merged gitlinks did not schedule automatic continuation in the real workflow"
  checkout_ref=$(workflow_step Checkout | sed -n 's/^          ref: *//p' | tr -d "\"'")
  checkout_ref=${checkout_ref:-$event_sha}
  command=$(workflow_step 'Bump submodule pins' | sed -n 's/^        run: //p')
  [[ -n $command && $command != '|' ]] || fail "update fixture runner for workflow run syntax: $command"
  fresh=$(mktemp -d "$temp_dir/fresh.XXXXXX")
  git clone -q --no-checkout "$origin" "$fresh"
  git -C "$fresh" checkout -q --detach "$checkout_ref"
  # Execute the actual workflow command in its fresh checkout, not a second
  # call against the stale fixture worktree used by the preceding run.
  local mono=$fresh
  WORKFLOW_COMMAND="$command" run_script
  [[ $status == 0 ]] || fail "automatic workflow continuation exited $status: $stderr"
}
automatic_continuation() {
  seed_pr
  touch "$stub_dir/queued"
  publish_intentd "$intentd_c2"
  simulate_merge
  # Main advances again while the first merge event is waiting for its run.
  # A checkout of the event SHA would silently discard this unrelated change.
  git -C "$mono" reset -q --hard "$bump1"
  echo 'newer main content' >"$mono/new-main.txt"
  git_fx -C "$mono" add new-main.txt
  git_fx -C "$mono" commit -qm 'advance main before delayed continuation'
  git -C "$mono" push -q origin HEAD:main
  local latest_main next
  latest_main=$(git -C "$origin" rev-parse refs/heads/main)
  run_push_event "$base" "$bump1"
  next=$(bump_commit) || fail "continuation lost pending component tip"
  [[ $(gitlink_at "$next") == "$intentd_c2" ]] || fail "continuation did not pick up pending tip"
  [[ $(git -C "$origin" rev-parse "$next^") == "$latest_main" ]] || fail "continuation used stale event SHA instead of current main"
  [[ $(git -C "$origin" show "$next:new-main.txt") == 'newer main content' ]] || fail "continuation dropped newer main content"
  [[ $(<"$stub_dir/pr") == 43 && $(<"$stub_dir/next-pr") == 44 ]] || fail "continuation must create exactly one new rolling PR"
  [[ $(<"$stub_dir/merged-42") == "$bump1" && ! -f $stub_dir/invalid-mutations ]] || fail "continuation touched the merged PR"
  simulate_merge
  : >"$temp_dir/gh.log"
  : >"$stub_dir/pushes"
  run_push_event "$latest_main" "$next"
  [[ ! -f $stub_dir/pr ]] || fail "current pins opened another PR"
  ! bump_commit >/dev/null || fail "current pins recreated the rolling branch"
  [[ ! -s $stub_dir/pushes ]] || fail "current pins produced another push event"
  [[ $(git -C "$origin" rev-parse refs/heads/main) == "$next" ]] || fail "no-op continuation changed main"
  assert_no_pr_writes
}

run_case 'queued PR with a newer tip defers before push' queued_new_tip
run_case 'enqueue after preflight defers only the queue rejection' enqueue_after_check
run_case 'queued identical-tree rerun preserves PR metadata' queued_identical_tree
run_case 'queued PR with current pins is not closed' queued_current_pins
run_case 'unqueued stale PR and remote branch are removed' unqueued_stale_pr
run_case 'unrelated GH006 push rejection remains an error' unrelated_push_rejection
run_case 'authentication failure remains an error' authentication_failure
run_case 'PR merged during lookup is not edited' merged_during_lookup
run_case 'workflow continuation filters match only main gitlinks' workflow_filters
run_case 'workflow checks out current main' workflow_checkout
run_case 'workflow retains dispatches, cron, PAT, and serialization' workflow_existing_guards
run_case 'merge event automatically carries pending tips and stops when current' automatic_continuation

[[ $failures == 0 ]] || fail "$failures regression case(s) failed"
echo "auto-bump-submodules tests passed"
