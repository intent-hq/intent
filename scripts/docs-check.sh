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

# Emit `file:line:make <target>` for every mention that appears in code: lines
# inside fenced code blocks and the contents of inline backtick spans. Prose
# mentions such as "can make an export" are ignored. An inline span may wrap
# onto following lines within the same paragraph; a blank line ends it.
code_make_mentions() {
  awk '
    function emit(text,   rest) {
      rest = text
      while (match(rest, /make[[:space:]]+[A-Za-z0-9_-]+/)) {
        print FILENAME ":" FNR ":" substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
    function fence_run(line,   run) {
      if (match(line, /^[ \t]*(```+|~~~+)/)) {
        run = substr(line, RSTART, RLENGTH)
        sub(/^[ \t]+/, "", run)
        return run
      }
      return ""
    }
    FNR == 1 { in_fence = 0; open_tick = "" }
    {
      run = fence_run($0)
      if (in_fence) {
        if (run != "" && substr(run, 1, 1) == substr(fence, 1, 1) &&
            length(run) >= length(fence) && $0 ~ /^[ \t]*(`+|~+)[ \t]*$/) {
          in_fence = 0
          next
        }
        emit($0)
        next
      }
      if (run != "") { in_fence = 1; fence = run; open_tick = ""; next }
      if ($0 ~ /^[ \t]*$/) open_tick = ""
      rest = $0
      if (open_tick != "") {
        close_pos = index(rest, open_tick)
        if (close_pos == 0) { emit(rest); next }
        emit(substr(rest, 1, close_pos - 1))
        rest = substr(rest, close_pos + length(open_tick))
        open_tick = ""
      }
      while (match(rest, /`+/)) {
        tick = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        close_pos = index(rest, tick)
        if (close_pos == 0) { open_tick = tick; emit(rest); break }
        emit(substr(rest, 1, close_pos - 1))
        rest = substr(rest, close_pos + length(tick))
      }
    }
  ' "${docs[@]}"
}

while IFS=: read -r file line mention; do
  read -r _ target <<<"$mention"
  if ! grep -Eq "^${target}[[:space:]]*:" Makefile; then
    fail "$file" "$line" "documented make target '$target' does not exist"
  fi
done < <(code_make_mentions)

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
fe_knob_sources=(
  packages/cloudlands-fe/scripts/vite-plugin-intentd-bridge.mjs
  packages/cloudlands-fe/scripts/sandbox/*.mjs
  packages/cloudlands-fe/vite.config.mjs
  packages/cloudlands-fe/package.json
  packages/cloudlands-fe/src/lib/component-catalog/geometry-snapshot.ts
)
for source in "${fe_knob_sources[@]}"; do
  [[ -f "$source" ]] && knob_sources+=("$source")
done

while IFS=: read -r file line text; do
  while IFS= read -r knob; do
    case "$knob" in
      DEVELOPER_GUIDE) continue ;;
    esac
    if ! grep -Fq "$knob" "${knob_sources[@]}"; then
      fail "$file" "$line" "sandbox knob '$knob' is not present in the Makefile, dev scripts, or cloudlands-fe sandbox sources"
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
check_banned 'browser-rewritten local port' 'client[- ]local[[:space:]]+(port|ports|url|urls|host|address|origin|localhost)'
check_banned 'remote websocket override' 'VITE_INTENTD_WS_URL'
check_banned 'coordinator-only sequencing label' '(^|[^[:alpha:]])w[a]ve([[:space:]]+N)?([^[:alpha:]]|$)'

hydration_docs=(AGENTS.md docs/fe/DEVELOPER_GUIDE.md)
[[ -f "$fe_agents" ]] && hydration_docs+=("$fe_agents")
canonical_range=
for file in "${hydration_docs[@]}"; do
  # Read lines into the array with a loop: stock macOS ships Bash 3.2, which
  # lacks the Bash 4 array-fill builtin (intent-hq/intent#4759).
  anchors=()
  while IFS= read -r anchor; do
    anchors+=("$anchor")
  done < <(grep -ni 'first tunneled' "$file" || true)
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