#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_root"

docs=(AGENTS.md README.md docs/fe/DEVELOPER_GUIDE.md)
fe_agents=packages/cloudlands-fe/AGENTS.md
if [[ -f "$fe_agents" ]]; then
  docs+=("$fe_agents")
else
  printf 'skipped: %s (submodule not initialized)\n' "$fe_agents"
fi

failures=0
fail() {
  local file=$1 line=$2 message=$3
  printf '%s:%s: error: %s\n' "$file" "$line" "$message" >&2
  failures=$((failures + 1))
}

while IFS=: read -r file line mention; do
  read -r _ target <<<"$mention"
  if ! grep -Eq "^${target}[[:space:]]*:" Makefile; then
    fail "$file" "$line" "documented make target '$target' does not exist"
  fi
done < <(grep -nHEo 'make[[:space:]]+[A-Za-z0-9_-]+' "${docs[@]}" || true)

section_lines() {
  local file=$1 start=$2 stop=$3
  [[ -f "$file" ]] || return
  awk -v file="$file" -v start="$start" -v stop="$stop" '
    $0 == start { active = 1; next }
    active && $0 ~ stop { exit }
    active { print file ":" FNR ":" $0 }
  ' "$file"
}

sandbox_doc_lines() {
  section_lines AGENTS.md '## Developing on a remote host' '^## '
  section_lines README.md '## Build from source' '^## '
  section_lines docs/fe/DEVELOPER_GUIDE.md '## Getting Started' '^## '
  section_lines docs/fe/DEVELOPER_GUIDE.md '## Fast UI Preview Workflow' '^Run the focused avatar component test'
  section_lines "$fe_agents" '## Fast UI preview loop' '^For focused browser validation'
  section_lines "$fe_agents" '### Loop A — web build in an embedded tab (primary; renderer/UI work)' '^### '
}

knob_sources=(Makefile scripts/dev-*.sh)
[[ -f packages/cloudlands-fe/scripts/vite-plugin-intentd-bridge.mjs ]] &&
  knob_sources+=(packages/cloudlands-fe/scripts/vite-plugin-intentd-bridge.mjs)

while IFS=: read -r file line text; do
  while IFS= read -r knob; do
    case "$knob" in
      DEVELOPER_GUIDE) continue ;;
    esac
    if ! grep -Fq "$knob" "${knob_sources[@]}"; then
      fail "$file" "$line" "sandbox knob '$knob' is not present in the Makefile, dev scripts, or bridge plugin"
    fi
  done < <(printf '%s\n' "$text" | tr -cs 'A-Z0-9_' '\n' | grep -E '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$' | sort -u || true)
done < <(sandbox_doc_lines)

check_banned() {
  local label=$1 pattern=$2 file line text
  while IFS=: read -r file line text; do
    fail "$file" "$line" "legacy guidance is forbidden ($label)"
  done < <(grep -nHiE "$pattern" "${docs[@]}" || true)
}

check_banned 'fixed bridge port' '51337'
check_banned 'manual forward creation' 'mint(s|ed|ing)?[[:space:]]+(a[[:space:]]+)?forward'
check_banned 'browser-rewritten local port' 'client[- ]local'
check_banned 'remote websocket override' 'VITE_INTENTD_WS_URL'
check_banned 'coordinator-only sequencing label' '(^|[^[:alpha:]])w[a]ve([[:space:]]+N)?([^[:alpha:]]|$)'

hydration_docs=(AGENTS.md docs/fe/DEVELOPER_GUIDE.md)
[[ -f "$fe_agents" ]] && hydration_docs+=("$fe_agents")
canonical_range=
for file in "${hydration_docs[@]}"; do
  mapfile -t anchors < <(grep -ni 'first tunneled' "$file" || true)
  if ((${#anchors[@]} != 1)); then
    fail "$file" 1 "expected exactly one first-tunneled hydration expectation; found ${#anchors[@]}"
    continue
  fi
  line=${anchors[0]%%:*}
  block=$(sed -n "${line},$((line + 3))p" "$file" | tr '\n' ' ')
  range=$(printf '%s\n' "$block" | grep -Eo '[[:alnum:]]+[[:space:]]+to[[:space:]]+[[:alnum:]]+[[:space:]]+minutes?' | head -n 1 || true)
  if [[ -z "$range" ]]; then
    fail "$file" "$line" 'hydration expectation must contain a numeric or worded minute range'
  elif [[ -z "$canonical_range" ]]; then
    canonical_range=$range
  elif [[ "$range" != "$canonical_range" ]]; then
    fail "$file" "$line" "hydration range '$range' differs from '$canonical_range'"
  fi
done

if ((failures > 0)); then
  printf 'docs-check: %d error(s)\n' "$failures" >&2
  exit 1
fi

printf 'docs-check: checked %d docs; all invariants passed\n' "${#docs[@]}"