#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/shipped-in.sh"
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
stub_dir="$temp_dir/stub"
mkdir -p "$bin_dir" "$stub_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "shipped-in test failed: $*" >&2
  exit 1
}

for command in bash cat grep python3; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

# Stub gh: releases from $GH_STUB_DIR/releases, compare statuses from
# $GH_STUB_DIR/compare/<owner>__<repo>/<base>...<head>, manifests from
# $GH_STUB_DIR/manifest/<tag>.json. Every invocation is appended to GH_TEST_LOG.
cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
[[ "${GH_STUB_FAIL:-0}" == 1 ]] && { echo "stub: gh unavailable" >&2; exit 1; }
case "$1 $2" in
  "release list")
    [[ "$*" == *"--repo intent-hq/cloudlands-releases"* ]] || exit 1
    cat "$GH_STUB_DIR/releases" ;;
  "api repos/"*)
    path=${2#repos/}; repo=${path%%/compare/*}; range=${path##*/compare/}
    file="$GH_STUB_DIR/compare/${repo/\//__}/$range"
    [[ -f "$file" ]] || { echo "stub: 404 $2" >&2; exit 1; }
    cat "$file" ;;
  "release download")
    [[ "$*" == *"--repo intent-hq/cloudlands-releases"*"--pattern release-manifest.json"*"--output -"* ]] || exit 1
    [[ -f "$GH_STUB_DIR/manifest/$3.json" ]] || { echo "stub: no manifest $3" >&2; exit 1; }
    cat "$GH_STUB_DIR/manifest/$3.json" ;;
  *) echo "stub: unexpected gh $*" >&2; exit 1 ;;
esac
SH
chmod +x "$bin_dir/gh"

sha=66e5cb92c4858dd3119b1d12d369493bec69dfb2
fe_compare="$stub_dir/compare/intent-hq__cloudlands-fe"
intentd_compare="$stub_dir/compare/intent-hq__intentd"
manifest_dir="$stub_dir/manifest"

reset_stub() {
  rm -rf "$stub_dir"
  mkdir -p "$fe_compare" "$intentd_compare" "$manifest_dir"
  printf '%s\n' v2.3.0 v2.2.0 v2.1.0 >"$stub_dir/releases"
  for tag in v2.3.0 v2.2.0 v2.1.0; do
    printf '{"version":"%s","intentdVersion":"0.9.%s"}\n' "${tag#v}" "${tag##*.}" >"$manifest_dir/$tag.json"
  done
  : >"$temp_dir/gh.log"
}

run_script() {
  set +e
  PATH="$bin_dir" GH_STUB_DIR="$stub_dir" GH_TEST_LOG="$temp_dir/gh.log" \
    bash "$script" "$@" >"$temp_dir/stdout" 2>"$temp_dir/stderr"
  status=$?
  set -e
  stdout=$(<"$temp_dir/stdout")
  stderr=$(<"$temp_dir/stderr")
}

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 0 ]] || fail "newest-tag hit exited $status: $stderr"
[[ "$stdout" == "v2.3.0 intentdVersion=0.9.0" ]] || fail "newest-tag hit printed '$stdout'"
grep -q -- '^release list --repo intent-hq/cloudlands-releases --limit 10 ' "$temp_dir/gh.log" || fail "default limit was not 10"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
echo identical >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha" --limit 3
[[ "$status" -eq 0 ]] || fail "older-tag hit exited $status: $stderr"
[[ "$stdout" == "v2.2.0 intentdVersion=0.9.0" ]] || fail "expected the oldest carrying tag, printed '$stdout'"
grep -q -- '^release list --repo intent-hq/cloudlands-releases --limit 3 ' "$temp_dir/gh.log" || fail "--limit was not forwarded"

reset_stub
echo behind >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo behind >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "no-hit exited $status (expected 3): $stderr"
[[ -z "$stdout" ]] || fail "no-hit printed '$stdout'"
! grep -q '^release download' "$temp_dir/gh.log" || fail "no-hit downloaded a manifest"

reset_stub
echo diverged >"$fe_compare/$sha...v2.3.0"
echo behind >"$fe_compare/$sha...v2.2.0"
echo diverged >"$fe_compare/$sha...v2.1.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 3 ]] || fail "behind/diverged counted as a hit (exit $status, stdout '$stdout')"

reset_stub
echo ahead >"$fe_compare/$sha...v2.3.0"
run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "compare API failure exited $status (expected 1)"
[[ -z "$stdout" ]] || fail "compare API failure printed '$stdout'"

reset_stub
GH_STUB_FAIL=1 run_script cloudlands-fe "$sha"
[[ "$status" -eq 1 ]] || fail "gh failure exited $status (expected 1, not 3)"

reset_stub
printf '{"version":"2.3.0","intentdVersion":"0.9.5"}\n' >"$manifest_dir/v2.3.0.json"
printf '{"version":"2.2.0","intentdVersion":"0.9.5"}\n' >"$manifest_dir/v2.2.0.json"
printf '{"version":"2.1.0","intentdVersion":"0.9.4"}\n' >"$manifest_dir/v2.1.0.json"
echo ahead >"$intentd_compare/$sha...v0.9.5"
echo behind >"$intentd_compare/$sha...v0.9.4"
run_script intentd "$sha"
[[ "$status" -eq 0 ]] || fail "intentd hit exited $status: $stderr"
[[ "$stdout" == "v2.2.0 intentdVersion=0.9.5" ]] || fail "intentd hit printed '$stdout'"
[[ "$(grep -c "^api repos/intent-hq/intentd/compare/$sha...v0.9.5 " "$temp_dir/gh.log")" -eq 1 ]] || fail "intentd compare was not deduplicated per pinned version"
! grep -q '^api repos/intent-hq/cloudlands-fe/' "$temp_dir/gh.log" || fail "intentd lookup compared against cloudlands-fe"

reset_stub
echo ahead >"$intentd_compare/$sha...v0.9.0"
rm "$manifest_dir/v2.2.0.json"
run_script intentd "$sha"
[[ "$status" -eq 1 ]] || fail "missing manifest exited $status (expected 1)"

reset_stub
run_script ios "$sha"
[[ "$status" -eq 2 ]] || fail "unknown component exited $status (expected 2)"
run_script cloudlands-fe main
[[ "$status" -eq 2 ]] || fail "non-sha ref exited $status (expected 2)"
run_script cloudlands-fe "$sha" --limit 0
[[ "$status" -eq 2 ]] || fail "--limit 0 exited $status (expected 2)"
! grep -q '^release list' "$temp_dir/gh.log" || fail "usage errors reached gh"

echo "shipped-in tests passed"
