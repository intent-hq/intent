#!/usr/bin/env bash
# Hermetic fixtures for auto-bump-submodules.sh: a bare "intentd" remote, a
# bare monorepo "origin" with a clone whose packages/intentd gitlink points at
# the intentd remote over file://, and a gh stub that logs argv and keeps one
# open auto/submodule-bump PR as state. Nothing here reaches the network.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/auto-bump-submodules.sh"
checker="$repo_root/scripts/check-mcp-bindings.mjs"
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

# Fixture commits use a fixed identity; the script under test picks its own
# (github-actions[bot]) from the environment defaults.
git_fx() {
  git -c user.name=fixture -c user.email=fixture@example.com -c commit.gpgsign=false "$@"
}

# Stub gh: `pr list` prints the open PR number kept in $GH_STUB_DIR/pr (the
# post-`--jq` output the script reads), `pr create` opens PR 42, `pr close`
# removes it; everything else succeeds. Every invocation is appended to
# GH_TEST_LOG.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
case "$1 $2" in
  "pr list") [[ -f "$GH_STUB_DIR/pr" ]] && cat "$GH_STUB_DIR/pr"; exit 0 ;;
  "pr create") echo 42 >"$GH_STUB_DIR/pr" ;;
  "pr close") rm -f "$GH_STUB_DIR/pr" ;;
  "pr edit" | "pr merge") ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
SH
chmod +x "$bin_dir/gh"

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
mkdir -p "$mono/scripts" "$mono/docs/protocol/methods" "$mono/packages/intentd"
cp "$checker" "$mono/scripts/check-mcp-bindings.mjs"
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
git init -q --bare "$origin"
git -C "$mono" remote add origin "$origin"
git -C "$mono" push -q origin main

run_script() {
  set +e
  (cd "$mono" && PATH="$bin_dir:$PATH" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" \
    bash "$script" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr")
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}
reset_stub() {
  rm -f "$stub_dir/pr"
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

# Case 1: the intentd tip adds a ws.* help line. The pushed bump commit moves
# the gitlink and regenerates the index, and the checker passes on that tree.
reset_stub
publish_intentd "$intentd_c1"
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
[[ "$(bump_commit)" == "$bump2" ]] || fail "stale PR close moved $branch"
! grep -qE '^pr (create|edit|merge)' "$temp_dir/gh.log" || fail "stale PR close touched the PR otherwise: $(<"$temp_dir/gh.log")"

# No drift and no open PR: only the list call.
reset_stub
run_script
[[ "$status" -eq 0 ]] || fail "no-drift no-PR exited $status: $stderr"
[[ "$stdout" != *"Closed stale PR"* ]] || fail "no-drift no-PR reported a close: $stdout"
[[ "$(<"$temp_dir/gh.log")" == "pr list --head $branch --state open --json number --jq .[0].number // empty" ]] || fail "no-drift no-PR gh calls: $(<"$temp_dir/gh.log")"

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

echo "auto-bump-submodules tests passed"
