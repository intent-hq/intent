#!/usr/bin/env bash
#
# Monorepo consumer checks: the set the ci.yml `docs-check` job runs, each as
# its own make target so a failure names the check and the monorepo file(s) to
# update. Every check runs even after a failure; a summary table follows.
# Used by `make consumer-checks` (the monorepo CI job) and by the reusable
# upstream workflow, so the two lists cannot drift.
#
# `docs-check` keeps its Makefile prerequisites (event-catalog-check and
# check-mcp-bindings) for standalone `make docs-check`; here both run as their
# own rows first and docs-check is invoked with `make -o <prerequisite>`
# (--assume-old), which tells make the prerequisite is already up to date so
# only scripts/docs-check.sh runs. That is what lets check-mcp-bindings be
# advisory on its own without touching the Makefile graph.
#
# Options (each also settable through the environment):
#   --advisory=<targets>   CONSUMER_CHECKS_ADVISORY  space-separated targets
#                          whose failure prints a ::warning:: line and does not
#                          affect the exit code
#   --context <name>       CONSUMER_CHECKS_CONTEXT   `monorepo` (default) or
#                          `upstream`, which appends the fix-order line
#   MAKE                   make binary (defaults to `make`; tests stub it)
#
# Every make call carries `RUSTUP_CARGO=` on its command line: the Makefile
# otherwise resolves cargo from packages/intentd/rust-toolchain.toml and puts
# that toolchain's bin/ first on every recipe's PATH. Upstream that file is the
# caller's PR head, so a `[toolchain] path = ...` entry there would let the
# caller substitute the `node` (and cargo) the checks run. A command-line
# variable beats the Makefile's assignment, and none of these checks needs
# cargo, so the checkers run with the caller's PATH untouched; the Makefile's
# own development toolchain pinning is unchanged.
#
# Exit status: 1 iff a non-advisory check failed; 2 on a usage error.
# Bash 3.2 compatible (stock macOS /bin/bash).

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo_root"

checks="event-catalog-check check-mcp-bindings docs-check check-protocol-catalog check-makefile-targets check-protocol-field-parity"
advisory=${CONSUMER_CHECKS_ADVISORY:-}
context=${CONSUMER_CHECKS_CONTEXT:-monorepo}
make_bin=${MAKE:-make}
make_overrides="RUSTUP_CARGO="

usage() {
  echo "usage: $0 [--advisory=<targets>] [--context monorepo|upstream]" >&2
  echo "checks: $checks" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --advisory=*) advisory=${1#--advisory=} ;;
    --advisory) [ "$#" -ge 2 ] || usage; advisory=$2; shift ;;
    --context=*) context=${1#--context=} ;;
    --context) [ "$#" -ge 2 ] || usage; context=$2; shift ;;
    -h | --help) usage ;;
    *) echo "consumer-checks: unknown argument '$1'" >&2; usage ;;
  esac
  shift
done

case "$context" in
  monorepo | upstream) ;;
  *) echo "consumer-checks: unknown context '$context' (expected monorepo or upstream)" >&2; usage ;;
esac

is_listed() {
  local needle=$1 word
  shift
  for word in "$@"; do
    [ "$word" = "$needle" ] && return 0
  done
  return 1
}

# shellcheck disable=SC2086
for target in $advisory; do
  is_listed "$target" $checks ||
    { echo "consumer-checks: unknown advisory target '$target'" >&2; usage; }
done

fix_path() {
  case "$1" in
    event-catalog-check) echo "docs/protocol/event-types.json + docs/protocol/06-events.md" ;;
    check-mcp-bindings) echo "docs/protocol/methods/mcp-bindings.md (make mcp-bindings-doc) + prose under docs/protocol/" ;;
    docs-check) echo "AGENTS.md / README.md / docs/fe/DEVELOPER_GUIDE.md (make targets, sandbox knobs) + docs/protocol/methods/files-terminal-browser.md (browser errorCode contract)" ;;
    check-protocol-catalog) echo "docs/protocol/05-method-catalog.md + docs/protocol/methods/*.md" ;;
    check-makefile-targets) echo "Makefile intentd crate / --test references (must exist at the pinned intentd gitlink in the monorepo / at the caller head upstream)" ;;
    check-protocol-field-parity) echo "scripts/check-protocol-field-parity.mjs PAIRS (ignore manifest) or the cloudlands-fe type that consumes the row struct" ;;
    *) echo "unknown check" ;;
  esac
}

# Upstream, packages/intentd is the caller's own checkout (a PR head, not the
# pin), so check-makefile-targets asks whether that head still provides the
# Makefile's crates / --test targets; in fe upstream context intentd sits at
# the pin, so HEAD == pin. The monorepo keeps the strict pinned-gitlink read.
make_args() {
  case "$1" in
    docs-check) echo "-o event-catalog-check -o check-mcp-bindings docs-check" ;;
    check-makefile-targets)
      if [ "$context" = "upstream" ]; then
        echo "CHECK_MAKEFILE_TARGETS_GITLINK=HEAD $1"
      else
        echo "$1"
      fi ;;
    *) echo "$1" ;;
  esac
}

results=""
failed=0
# shellcheck disable=SC2086
for target in $checks; do
  args=$(make_args "$target")
  echo "==> make $make_overrides $args"
  status=0
  $make_bin --no-print-directory $make_overrides $args || status=$?
  if [ "$status" -eq 0 ]; then
    result=pass
  elif is_listed "$target" $advisory; then
    result=warn
    echo "::warning::consumer check '$target' failed (advisory); fix in the monorepo: $(fix_path "$target")"
  else
    result=FAIL
    failed=1
  fi
  results="$results$target $result
"
done

echo
echo "consumer-checks summary"
printf '  %-28s %-6s %s\n' CHECK RESULT "FIX IN MONOREPO"
printf '%s' "$results" | while read -r target result; do
  printf '  %-28s %-6s %s\n' "$target" "$result" "$(fix_path "$target")"
done
if [ "$failed" -ne 0 ]; then
  echo "consumer-checks: FAILED"
else
  echo "consumer-checks: all checks passed"
fi
if [ "$context" = "upstream" ]; then
  echo "Fix order: additions land the monorepo docs change first (docs may lead the pin); removals land the component first and drop the docs entry after the bump; then re-run this job."
fi
exit "$failed"
