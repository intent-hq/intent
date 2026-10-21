#!/usr/bin/env bash
#
# Run a command, retrying it a bounded number of times with a linear backoff.
#
#   scripts/retry.sh [--attempts N] [--delay SECONDS] [--] command [args...]
#
# Meant for network downloads that a short blip can fail (toolchain installs,
# package index refreshes): a rustup fetch from static.rust-lang.org failing
# for a few seconds ejected an otherwise green PR from the merge queue
# (cloudlands-fe run 39606176278). Wrap only the download, never a real check,
# so a genuine failure is still reported on its first run.
#
# Defaults: 3 attempts, 15s base delay; attempt i waits i*delay before the next
# one (15s, then 30s), the schedule ci.yml's apt retries use. A failed attempt
# logs a warning; after the last one the error names the command and attempt
# count, and the script exits with the command's last exit status. Exit 126/127
# (not executable / not found) is never retried. Under GitHub Actions the
# messages are ::warning:: / ::error:: annotations. Bad arguments exit 2.
# RETRY_DELAY sets the default base delay (an explicit --delay wins); the
# shell suites set it to 0 so retries cost no wall time.
#
# Bash 3.2 compatible: bootstrap-dev-host.sh runs it on stock macOS bash.

set -u

usage() {
  echo "usage: retry.sh [--attempts N] [--delay SECONDS] [--] command [args...]"
}

usage_error() {
  echo "retry.sh: $1" >&2
  usage >&2
  exit 2
}

report() {
  # $1: warning|error, $2: message.
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::$1::retry.sh: $2" >&2
  elif [ "$1" = error ]; then
    echo "ERROR: retry.sh: $2" >&2
  else
    echo "WARNING: retry.sh: $2" >&2
  fi
}

attempts=3
delay=${RETRY_DELAY:-15}
while [ $# -gt 0 ]; do
  case "$1" in
    --attempts)
      [ $# -ge 2 ] || usage_error "--attempts needs a value"
      attempts=$2
      shift 2
      ;;
    --attempts=*)
      attempts=${1#--attempts=}
      shift
      ;;
    --delay)
      [ $# -ge 2 ] || usage_error "--delay needs a value"
      delay=$2
      shift 2
      ;;
    --delay=*)
      delay=${1#--delay=}
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      usage_error "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

case "$attempts" in
  '' | *[!0-9]* | 0*) usage_error "--attempts must be a positive integer, got '$attempts'" ;;
esac
case "$delay" in
  '' | *[!0-9]*) usage_error "--delay must be a non-negative integer, got '$delay'" ;;
esac
[ $# -gt 0 ] || usage_error "no command given"

command_text="$*"
attempt=1
while :; do
  status=0
  "$@" || status=$?
  [ "$status" -ne 0 ] || exit 0
  if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
    report error "not retrying (exit $status, command not runnable): $command_text"
    exit "$status"
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    report error "giving up after $attempts attempt(s), last exit $status: $command_text"
    exit "$status"
  fi
  wait_seconds=$((delay * attempt))
  report warning "attempt $attempt/$attempts failed (exit $status), retrying in ${wait_seconds}s: $command_text"
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
