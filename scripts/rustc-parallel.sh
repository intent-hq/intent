#!/usr/bin/env bash
# RUSTC_WRAPPER behind the opt-in `PARALLEL=1 make build|check|test...` knob
# (see CONTRIBUTING.md -> "Parallel compiler front end"). Cargo runs it as
#   rustc-parallel.sh <rustc or clippy-driver> [<rustc>] ARGS...
# For crates under INTENT_PARALLEL_ROOT (the intentd workspace, including its
# vendored path crates) it appends -Zthreads=N and sets RUSTC_BOOTSTRAP=1 for
# that one compiler process. Registry/git dependencies, their build-script
# probes and Cargo's own -vV/--print probes run unchanged, so dependency cfg
# detection (anyhow, thiserror, proc-macro2) matches a plain stable build.
# Local developer builds only: it refuses to run under CI.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "rustc-parallel.sh: usage: rustc-parallel.sh <rustc> [args...] (set as RUSTC_WRAPPER by PARALLEL=1 make ...)" >&2
  exit 2
fi
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "rustc-parallel.sh: refusing to run under CI; PARALLEL=1 is for local developer builds only" >&2
  exit 2
fi

threads=${INTENT_PARALLEL_THREADS:-8}
case $threads in
  '' | *[!0-9]* | 0)
    echo "rustc-parallel.sh: INTENT_PARALLEL_THREADS must be a positive integer, got '$threads'" >&2
    exit 2
    ;;
esac

# Chain to a wrapper the caller had already set (for example RUSTC_WRAPPER=sccache).
inner=()
self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
if [ -n "${INTENT_PARALLEL_INNER_WRAPPER:-}" ] && [ "$INTENT_PARALLEL_INNER_WRAPPER" != "$self" ]; then
  inner=("$INTENT_PARALLEL_INNER_WRAPPER")
fi

apply=1
root=${INTENT_PARALLEL_ROOT:-}
root=${root%/}
case $root in
  /?*) ;;
  *) apply=0 ;;
esac
if [ "$apply" = 1 ]; then
  case "${CARGO_MANIFEST_DIR:-}/" in
    "$root"/*) ;;
    *) apply=0 ;;
  esac
fi
if [ "$apply" = 1 ]; then
  for arg in "$@"; do
    case $arg in
      -vV | -V | --version | --print* | -) apply=0 ;;
    esac
  done
fi

if [ "$apply" = 1 ]; then
  RUSTC_BOOTSTRAP=1 exec ${inner[@]+"${inner[@]}"} "$@" "-Zthreads=$threads"
fi
exec ${inner[@]+"${inner[@]}"} "$@"
