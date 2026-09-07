#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "docs-check test failed: $*" >&2
  exit 1
}

mkdir -p "$temp_dir/scripts" "$temp_dir/docs/fe" "$temp_dir/packages/cloudlands-fe"
cp "$repo_root/scripts/docs-check.sh" "$temp_dir/scripts/docs-check.sh"
touch "$temp_dir/Makefile" "$temp_dir/README.md"

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

if ! pass_output=$(cd "$temp_dir" && bash scripts/docs-check.sh 2>&1); then
  fail "client-local capture guidance was rejected: $pass_output"
fi

printf '%s\n' 'Use the client-local port.' >>"$temp_dir/README.md"
if fail_output=$(cd "$temp_dir" && bash scripts/docs-check.sh 2>&1); then
  fail "client-local port guidance was accepted"
fi
grep -q 'legacy guidance is forbidden (browser-rewritten local port)' <<<"$fail_output" ||
  fail "client-local port failure did not retain its human-readable label"

: >"$temp_dir/README.md"
printf '%s\n' 'Set SANDBOX_ONLY_KNOB=1 for runner diagnostics.' >>"$temp_dir/packages/cloudlands-fe/AGENTS.md"
if fail_output=$(cd "$temp_dir" && bash scripts/docs-check.sh 2>&1); then
  fail "undeclared sandbox knob was accepted"
fi
grep -q "sandbox knob 'SANDBOX_ONLY_KNOB' is not present" <<<"$fail_output" ||
  fail "undeclared sandbox knob failure did not name the knob: $fail_output"

mkdir -p "$temp_dir/packages/cloudlands-fe/scripts/sandbox"
printf '%s\n' 'const debug = process.env.SANDBOX_ONLY_KNOB === "1";' \
  >"$temp_dir/packages/cloudlands-fe/scripts/sandbox/runner.mjs"
if ! pass_output=$(cd "$temp_dir" && bash scripts/docs-check.sh 2>&1); then
  fail "sandbox knob defined in an fe sandbox source was rejected: $pass_output"
fi

echo "docs-check tests passed"