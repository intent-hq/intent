#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script=$repo_root/scripts/docs-check.sh
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

# The fixtures below run docs-check.sh under $script_bash and append every
# exit code + output to $transcript, so a rerun under another interpreter
# (see the Bash 3 section at the end) can be compared byte for byte.
script_bash=${DOCS_CHECK_TEST_BASH:-$BASH}
transcript=${DOCS_CHECK_TEST_TRANSCRIPT:-$temp_dir/transcript}
: >"$transcript"

fail() {
  echo "docs-check test failed: $*" >&2
  exit 1
}

run_check() {
  local status=0
  check_output=$(cd "$temp_dir" && "$script_bash" scripts/docs-check.sh 2>&1) || status=$?
  printf 'exit %s\n%s\n' "$status" "$check_output" >>"$transcript"
  return "$status"
}

mkdir -p "$temp_dir/scripts" "$temp_dir/docs/fe" "$temp_dir/packages/cloudlands-fe"
cp "$script" "$temp_dir/scripts/docs-check.sh"
touch "$temp_dir/README.md"
printf 'real-target:\n\ttrue\n' >"$temp_dir/Makefile"

cat >"$temp_dir/AGENTS.md" <<'EOF'
## Developing on a remote host
A first tunneled open takes one to three minutes.
## Next
EOF

cat >"$temp_dir/docs/fe/DEVELOPER_GUIDE.md" <<'EOF'
## Getting Started
A first tunneled open takes one to three minutes.
## Next
EOF

cat >"$temp_dir/packages/cloudlands-fe/AGENTS.md" <<'EOF'
## Fast UI preview loop
A first tunneled open takes one to three minutes.
Do not link a client-local capture.
### Next
EOF

if ! run_check; then
  fail "client-local capture guidance was rejected: $check_output"
fi

printf '%s\n' 'Use the client-local port.' >>"$temp_dir/README.md"
if run_check; then
  fail "client-local port guidance was accepted"
fi
grep -q 'legacy guidance is forbidden (browser-rewritten local port)' <<<"$check_output" ||
  fail "client-local port failure did not retain its human-readable label"

: >"$temp_dir/README.md"
printf '%s\n' 'Set SANDBOX_ONLY_KNOB=1 for runner diagnostics.' >>"$temp_dir/packages/cloudlands-fe/AGENTS.md"
if run_check; then
  fail "undeclared sandbox knob was accepted"
fi
grep -q "sandbox knob 'SANDBOX_ONLY_KNOB' is not present" <<<"$check_output" ||
  fail "undeclared sandbox knob failure did not name the knob: $check_output"

mkdir -p "$temp_dir/packages/cloudlands-fe/scripts/sandbox"
printf '%s\n' 'const debug = process.env.SANDBOX_ONLY_KNOB === "1";' \
  >"$temp_dir/packages/cloudlands-fe/scripts/sandbox/runner.mjs"
if ! run_check; then
  fail "sandbox knob defined in an fe sandbox source was rejected: $check_output"
fi

printf '%s\n' 'The first tunneled open is slow.' >>"$temp_dir/AGENTS.md"
if run_check; then
  fail "duplicate first-tunneled hydration expectation was accepted"
fi
grep -q 'expected exactly one first-tunneled hydration expectation; found 2' <<<"$check_output" ||
  fail "duplicate hydration expectation failure did not report the anchor count: $check_output"

cat >"$temp_dir/AGENTS.md" <<'EOF'
## Developing on a remote host
A first tunneled open takes one to three minutes.
## Next
EOF
if ! run_check; then
  fail "restored hydration expectation was rejected: $check_output"
fi

cat >"$temp_dir/README.md" <<'EOF'
Dropping an import in one file can make an export in another unused.
Run `make real-target` first.
```bash
make real-target
```
EOF
if ! run_check; then
  fail "prose make mention or valid code make target was rejected: $check_output"
fi

printf '%s\n' 'Then run `make missing-inline`.' >>"$temp_dir/README.md"
if run_check; then
  fail "backticked missing make target was accepted"
fi
grep -q "README.md:6: error: documented make target 'missing-inline' does not exist" <<<"$check_output" ||
  fail "backticked missing make target failure did not name the target: $check_output"

cat >"$temp_dir/README.md" <<'EOF'
~~~
make missing-fenced
~~~
EOF
if run_check; then
  fail "fenced missing make target was accepted"
fi
grep -q "README.md:2: error: documented make target 'missing-fenced' does not exist" <<<"$check_output" ||
  fail "fenced missing make target failure did not name the target: $check_output"

cat >"$temp_dir/README.md" <<'EOF'
Run `npm run lint &&
make missing-multiline` and then you can make an export.

This paragraph can make an export too.
EOF
if run_check; then
  fail "missing make target in a wrapped inline code span was accepted"
fi
grep -q "README.md:2: error: documented make target 'missing-multiline' does not exist" <<<"$check_output" ||
  fail "wrapped inline span failure did not name the target: $check_output"
grep -q "documented make target 'an'" <<<"$check_output" &&
  fail "prose after a wrapped inline span was treated as code: $check_output"

: >"$temp_dir/README.md"

echo "docs-check tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${DOCS_CHECK_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as shipped-in.test.sh: BASH3_BIN, bash3, Homebrew bash@3, 3.x
# /bin/bash) and require a byte-identical transcript. A missing Bash 3 is a
# skip notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to make
# it a failure instead.
bash -n "$script" || fail "docs-check.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "docs-check.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments, the pattern itself and the gate_sample calls below are
# not scanned.
gate_matches() {
  grep -nE "$bash4_constructs" "$@" | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' |
    grep -v -F -e 'bash4_constructs' -e 'gate_sample' || true
}
gate_sample() {
  local expected=$1 sample=$2 hit
  hit=$(printf '%s\n' "$sample" | gate_matches)
  case "$expected:${hit:+hit}" in
    hit:hit | miss:) ;;
    *) fail "gate regex $expected sample misclassified: $sample" ;;
  esac
}
gate_sample hit 'mapfile -t anchors < <(grep -ni x "$file" || true)'
gate_sample hit 'readarray a <f'
gate_sample hit 'declare -A m=()'
gate_sample hit 'echo ${var,,}'
gate_sample miss 'line=${anchors[0]%%:*}'
gate_sample miss 'local file=$1 line=$2 message=$3'
gate_sample miss '# mapfile is unavailable on Bash 3'
gate_hits=$(gate_matches "$script" "${BASH_SOURCE[0]}")
[[ -z "$gate_hits" ]] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

find_bash3() {
  local candidate resolved brew_prefix
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  for candidate in "${BASH3_BIN:-}" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [[ -n "$candidate" ]] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [[ -x "$resolved" ]] || continue
    "$resolved" -c '[[ "${BASH_VERSINFO[0]}" -eq 3 ]]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  bash3_transcript=$temp_dir/bash3-transcript
  DOCS_CHECK_TEST_BASH="$bash3" DOCS_CHECK_TEST_TRANSCRIPT="$bash3_transcript" \
    "$bash3" "${BASH_SOURCE[0]}"
  cmp -s "$transcript" "$bash3_transcript" ||
    fail "docs-check.sh output differs between bash $BASH_VERSION and $bash3:"$'\n'"$(diff "$transcript" "$bash3_transcript" || true)"
  echo "docs-check.sh output is identical under bash $BASH_VERSION and $bash3"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "docs-check tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi