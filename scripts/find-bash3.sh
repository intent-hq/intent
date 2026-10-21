# shellcheck shell=bash
# Shared Bash 3 interpreter lookup for the scripts/*.test.sh compatibility
# passes. Sourced, never executed; must itself parse and run under Bash 3.2.
#
# Stock macOS /bin/bash is 3.2, so the suites rerun their fixtures under a real
# Bash 3 when one can be found. Lookup order: BASH3_BIN, the `make bash3` cache
# (BASH3_CACHE_DIR, default ${XDG_CACHE_HOME:-~/.cache}/intent-bash3), a bash3
# on PATH, Homebrew bash@3, then a 3.x /bin/bash.

bash3_cache_dir() {
  printf '%s\n' "${BASH3_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-}/.cache}/intent-bash3}"
}

find_bash3() {
  local candidate resolved brew_prefix cache_bash
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  cache_bash="$(bash3_cache_dir)/bash"
  for candidate in "${BASH3_BIN:-}" "$cache_bash" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [ -n "$candidate" ] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [ -x "$resolved" ] || continue
    "$resolved" -c '[ "${BASH_VERSINFO[0]}" -eq 3 ]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

# How to get an interpreter, for the skip notice and the REQUIRE_BASH3 failure.
bash3_missing_hint() {
  printf '%s\n' "run 'make bash3' to build one into $(bash3_cache_dir), or point BASH3_BIN at one"
}
