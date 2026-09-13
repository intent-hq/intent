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

# Browser-tab contract surfaces: protocol doc (canonical), fe executor union +
# CaptureErrorCode alias, and the intentd overview text.
protocol_doc=docs/protocol/methods/files-terminal-browser.md
fe_executor=packages/cloudlands-fe/src/features/browser/main/browser-action-executor.ts
fe_cdp=packages/cloudlands-fe/src/features/browser/main/embedded-browser-cdp-service.ts
intentd_overview=packages/intentd/crates/intent-acp/src/mcp_server/bindings/browser_docs/overview.md
mkdir -p "$temp_dir/$(dirname "$protocol_doc")" "$temp_dir/$(dirname "$fe_executor")" \
  "$temp_dir/$(dirname "$intentd_overview")"

write_protocol_doc() {
  cat >"$temp_dir/$protocol_doc" <<'EOF'
> The op fails as an action-result error which carries an
> **additive structured `errorCode`** when the cause is one of:
>
> - `workspace-not-visible` — the tab could not be mounted while the workspace
>   is not **displayed** in any window.
> - `deadline-exhausted` — the request deadline ran out.
> - `still-loading` — the guest was still loading.
> - `navigated-away` — the guest shows a different origin.
> - `not-painting` — the surface has not painted.
>
> Ownership failures keep their own `not-owner` / `already-claimed` codes.
EOF
}

write_fe_executor() {
  cat >"$temp_dir/$fe_executor" <<'EOF'
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return { success: false, error: 'still loading', errorCode: 'still-loading' };
  displayed?: boolean;
  errorCode?:
    | 'not-owner'
    | 'already-claimed'
    | 'workspace-not-visible'
    | 'still-loading'
    | 'navigated-away'
    | CaptureErrorCode;
  ownerAgentId?: string | null;
  return { errorCode: 'deadline-exhausted' as const };
EOF
}

write_fe_cdp() {
  printf '%s\n' "export type CaptureErrorCode = 'not-painting' | 'deadline-exhausted';" >"$temp_dir/$fe_cdp"
}

write_intentd_overview() {
  cat >"$temp_dir/$intentd_overview" <<'EOF'
Ownership: `not-owner` / `already-claimed`. `displayed` is a layout fact.
Capture ops fail with `workspace-not-visible`, `deadline-exhausted`,
`still-loading`, `navigated-away`, or `not-painting`.
EOF
}

write_protocol_doc
write_fe_executor
write_fe_cdp
write_intentd_overview

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

if ! run_check; then
  fail "browser contract surfaces in sync were rejected: $check_output"
fi

sed -i.bak 's/`deadline-exhausted`/`deadline-exhaust`/' "$temp_dir/$intentd_overview"
rm -f "$temp_dir/$intentd_overview.bak"
if run_check; then
  fail "errorCode token missing from the intentd overview was accepted"
fi
grep -q "$protocol_doc:6: error: browser errorCode 'deadline-exhausted' is not documented in $intentd_overview" <<<"$check_output" ||
  fail "missing intentd overview token failure did not name the token and file: $check_output"
write_intentd_overview

# Remove only the union member; the runtime `errorCode: 'still-loading'`
# literal outside the declaration stays and must not mask the removal.
grep -v "^    | 'still-loading'$" "$temp_dir/$fe_executor" >"$temp_dir/$fe_executor.tmp"
mv "$temp_dir/$fe_executor.tmp" "$temp_dir/$fe_executor"
grep -q "errorCode: 'still-loading'" "$temp_dir/$fe_executor" ||
  fail "fixture lost its runtime still-loading literal"
if run_check; then
  fail "errorCode token missing from the fe union was accepted"
fi
grep -q "$protocol_doc:7: error: browser errorCode 'still-loading' is not declared in the errorCode union / CaptureErrorCode alias in $fe_executor $fe_cdp" <<<"$check_output" ||
  fail "missing fe union token failure did not name the token and files: $check_output"
write_fe_executor

# Same for the alias: the executor's runtime `'deadline-exhausted'` literal
# must not stand in for a removed CaptureErrorCode member.
printf '%s\n' "export type CaptureErrorCode = 'not-painting';" >"$temp_dir/$fe_cdp"
if run_check; then
  fail "errorCode token missing from the CaptureErrorCode alias was accepted"
fi
grep -q "$protocol_doc:6: error: browser errorCode 'deadline-exhausted' is not declared in the errorCode union / CaptureErrorCode alias in $fe_executor $fe_cdp" <<<"$check_output" ||
  fail "missing CaptureErrorCode member failure did not name the token and files: $check_output"
write_fe_cdp

sed -i.bak "s/    | 'navigated-away'/    | 'navigated-away'\\
    | 'tab-crashed'/" "$temp_dir/$fe_executor"
rm -f "$temp_dir/$fe_executor.bak"
if run_check; then
  fail "fe errorCode literal absent from the protocol doc was accepted"
fi
grep -q "$fe_executor:10: error: browser errorCode 'tab-crashed' is not documented in $protocol_doc" <<<"$check_output" ||
  fail "undocumented fe literal failure did not name the token and file: $check_output"
grep -q "$fe_executor:10: error: browser errorCode 'tab-crashed' is not documented in $intentd_overview" <<<"$check_output" ||
  fail "undocumented fe literal failure did not name the intentd overview: $check_output"
write_fe_executor

rm -rf "$temp_dir/packages/intentd"
if ! run_check; then
  fail "missing intentd submodule was not skipped: $check_output"
fi
grep -q "skipped: $intentd_overview (submodule not initialized)" <<<"$check_output" ||
  fail "missing intentd submodule did not print the skipped line: $check_output"
mkdir -p "$temp_dir/$(dirname "$intentd_overview")"
write_intentd_overview

grep -v '^> - ' "$temp_dir/$protocol_doc" >"$temp_dir/$protocol_doc.tmp"
mv "$temp_dir/$protocol_doc.tmp" "$temp_dir/$protocol_doc"
if run_check; then
  fail "empty protocol errorCode bullet list was accepted"
fi
grep -q "$protocol_doc:1: error: expected a backticked errorCode bullet list" <<<"$check_output" ||
  fail "empty bullet list failure was not reported: $check_output"
write_protocol_doc

grep -v 'displayed' "$temp_dir/$fe_executor" >"$temp_dir/$fe_executor.tmp"
mv "$temp_dir/$fe_executor.tmp" "$temp_dir/$fe_executor"
if run_check; then
  fail "fe executor without the displayed field was accepted"
fi
grep -q "$fe_executor:1: error: browser tab field 'displayed' is not mentioned" <<<"$check_output" ||
  fail "missing displayed field failure was not reported: $check_output"
write_fe_executor

if ! run_check; then
  fail "restored browser contract surfaces were rejected: $check_output"
fi

echo "docs-check tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${DOCS_CHECK_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as shipped-in.test.sh) and require a byte-identical transcript.
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
else
  echo "docs-check tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi