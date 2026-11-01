#!/usr/bin/env bash
#
# `make check-dry-run-targets`: every Makefile target that documents or accepts
# DRY_RUN must, under DRY_RUN=1, exit without starting a cargo / rustup
# process. `DRY_RUN=1 make coverage-e2e` used to ignore the flag and launch an
# hour-long instrumented run on a shared host, because coverage-changed
# honours DRY_RUN and its siblings did not.
#
# Checked targets (read from the Makefile, so there is no list to drift):
#   - a rule whose `##` help text mentions DRY_RUN (documents it);
#   - a rule whose recipe mentions DRY_RUN (accepts it);
#   - every coverage-* rule: the family a caller assumes is uniform.
#
# Each one really runs, from the Makefile's own directory, with DRY_RUN=1 and
# a PATH whose cargo, cargo-llvm-cov, cargo-nextest, rustup, rustc, corepack and
# pnpm are stubs that only log their argv. A target fails when any cargo-family
# stub (cargo, cargo-*, rustup, rustc) was called — even `cargo nextest
# --version`; only `rustup which`, a read-only path lookup the toolchain
# preflights use to build PATH, is allowed — or when it outlives the
# timeout. Its exit status is reported but not judged: a dry run that stops
# early (no origin/main, missing frontend toolchain) started no real work.
# Corepack/pnpm are stubbed so no frontend install or run happens; FE_DIR points
# at a stub frontend with fresh lockfiles so ensure-fe-submodule never clones.
#
# Usage: scripts/check-dry-run-targets.sh [--makefile-dir DIR]
#   DIR defaults to the repo root. DRY_RUN_CHECK_TIMEOUT (seconds, default 120)
#   bounds each target when coreutils `timeout` is available.
# Exit: 0 all clean, 1 a target ran cargo or timed out, 2 usage error.

set -euo pipefail

# Re-entry: make check-dry-run-targets documents DRY_RUN, so the check runs it
# too; a nested run (any target that calls this script) must not recurse.
if [ -n "${DRY_RUN_CHECK_LOG:-}" ]; then
  echo "check-dry-run-targets: nested run under a dry-run check; skipped"
  exit 0
fi

# The caller's environment must not steer the targets under test.
unset DRY_RUN MAKEFLAGS MFLAGS MAKELEVEL BASE FULL FE_DIR RESUME GATE_FORCE NO_FAIL_FAST HERMETIC

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
makefile_dir=$repo_root

while [ $# -gt 0 ]; do
  case "$1" in
    --makefile-dir)
      [ $# -ge 2 ] || { echo "check-dry-run-targets: --makefile-dir needs a value" >&2; exit 2; }
      makefile_dir=$2
      shift
      ;;
    -h | --help)
      sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "check-dry-run-targets: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

makefile_dir=$(cd "$makefile_dir" && pwd -P)
[ -f "$makefile_dir/Makefile" ] || { echo "check-dry-run-targets: no Makefile in $makefile_dir" >&2; exit 2; }

timeout_seconds=${DRY_RUN_CHECK_TIMEOUT:-120}
make_bin=$(command -v make) || { echo "check-dry-run-targets: make not found" >&2; exit 2; }
timeout_bin=$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)

# Rule lines are `name: [prereqs] [## help]` at column 0; target-specific
# variable assignments (`name: VAR = x`) and pattern/special targets are not
# rules to run. A recipe is the tab-indented block under a rule.
discover_targets() {
  awk '
    function flush() { if (target != "" && hit) print target }
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*:([^=]|$)/ && $0 !~ /^[^:]*:[^#]*[^:+?!]=/ {
      flush()
      target = substr($0, 1, index($0, ":") - 1)
      hit = (target ~ /^coverage-/)
      help = index($0, "##") ? substr($0, index($0, "##")) : ""
      if (help ~ /DRY_RUN/) hit = 1
      in_recipe = 1
      next
    }
    in_recipe && /^\t/ { if ($0 ~ /DRY_RUN/) hit = 1; next }
    in_recipe && /^[[:space:]]*$/ { next }
    { flush(); target = ""; hit = 0; in_recipe = 0 }
    END { flush() }
  ' "$makefile_dir/Makefile" | LC_ALL=C sort -u
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stub_bin="$work/bin"
fe_stub="$work/frontend"
mkdir -p "$stub_bin" "$fe_stub/.git" "$fe_stub/node_modules/.pnpm"
printf 'lockfileVersion: 9\n' >"$fe_stub/pnpm-lock.yaml"
cp "$fe_stub/pnpm-lock.yaml" "$fe_stub/node_modules/.pnpm/lock.yaml"

for tool in cargo cargo-llvm-cov cargo-nextest rustup rustc corepack pnpm; do
  cat >"$stub_bin/$tool" <<SH
#!/bin/sh
printf '%s %s\n' "$tool" "\$*" >>"\$DRY_RUN_CHECK_LOG"
exit 0
SH
  chmod +x "$stub_bin/$tool"
done

targets=$(discover_targets)
if [ -z "$targets" ]; then
  echo "check-dry-run-targets: no DRY_RUN targets found in $makefile_dir/Makefile"
  exit 0
fi

failures=""
for target in $targets; do
  log="$work/$target.log"
  out="$work/$target.out"
  : >"$log"
  set -- "$make_bin" -C "$makefile_dir" --no-print-directory "$target" DRY_RUN=1 \
    "CARGO_BIN_DIR=$stub_bin" RUSTUP_CARGO= "FE_DIR=$fe_stub"
  [ -z "$timeout_bin" ] || set -- "$timeout_bin" -k 5 "$timeout_seconds" "$@"
  set +e
  PATH="$stub_bin:$PATH" DRY_RUN_CHECK_LOG="$log" "$@" >"$out" 2>&1 </dev/null
  status=$?
  set -e
  cargo_calls=$(grep -E '^(cargo|cargo-[a-z-]+|rustup|rustc) ' "$log" | grep -v '^rustup which ' || true)
  if [ -n "$timeout_bin" ] && { [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; }; then
    echo "FAIL $target: still running after ${timeout_seconds}s under DRY_RUN=1"
    failures="$failures $target"
  elif [ -n "$cargo_calls" ]; then
    echo "FAIL $target: DRY_RUN=1 started cargo-family processes:"
    printf '%s\n' "$cargo_calls" | sed -n '1,5s/^/       /p'
    failures="$failures $target"
  else
    echo "ok   $target (exit $status, no cargo)"
    continue
  fi
  echo "     last output lines:"
  tail -n 5 "$out" | sed 's/^/       /'
done

if [ -n "$failures" ]; then
  echo
  echo "check-dry-run-targets: DRY_RUN=1 must print a plan and exit, or refuse, without running cargo:$failures" >&2
  echo "Guard the recipe like coverage-changed does (skip preflights and hand DRY_RUN to a script that honours it, or print the plan and exit)." >&2
  exit 1
fi
echo "check-dry-run-targets: every DRY_RUN target exits without running cargo"
