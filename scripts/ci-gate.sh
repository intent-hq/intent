#!/usr/bin/env bash
#
# CI Gate result matrix for .github/workflows/ci.yml.
#
# The `gate` job (the single `CI Gate` context the main ruleset requires) runs
# this script with the workflow event and the `needs` context; it decides
# whether the run counts as green. The rules, mirrored by scripts/ci-gate.test.sh:
#   - every always-on job must have result `success` on every event;
#   - the pull_request-only jobs (they read PR metadata that merge_group does
#     not carry) must be `success` on pull_request and job-`skipped` on
#     merge_group — a skip on pull_request or a run on merge_group is a
#     misconfiguration and fails;
#   - anything else — failure, cancelled, an empty or missing result, a job
#     absent from the input, an event other than the two above — fails, naming
#     the offending job or event.
#
# Inputs (environment):
#   GATE_EVENT       `github.event_name`
#   GATE_NEEDS_JSON  `toJSON(needs)`: an object keyed by job id, each value an
#                    object with a string `result` (pretty-printed or compact).
#
# `--list-jobs` prints the job ids the gate knows, one per line; the self-test
# diffs that against the gate job's `needs` list in ci.yml so a job added to one
# side but not the other fails CI.
#
# Bash 3.2 compatible (stock macOS /bin/bash); POSIX awk only, no jq or node.

set -euo pipefail

always_on_jobs="bridge-test docs-check event-catalog-check shell-tests shell-tests-bash3 repo-hygiene ruleset-check triage-parser-test"
pull_request_only_jobs="pr-title breaking-token submodule-pins"

if [ "${1:-}" = "--list-jobs" ]; then
  for job in $always_on_jobs $pull_request_only_jobs; do
    printf '%s\n' "$job"
  done
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "usage: GATE_EVENT=<event> GATE_NEEDS_JSON='<toJSON(needs)>' $0 | $0 --list-jobs" >&2
  exit 2
fi

event=${GATE_EVENT:-}
needs_json=${GATE_NEEDS_JSON:-}

case "$event" in
  pull_request) pr_only_expected=success ;;
  merge_group) pr_only_expected=skipped ;;
  "")
    echo "ci-gate: GATE_EVENT is empty" >&2
    exit 1
    ;;
  *)
    echo "ci-gate: unknown event '$event' (expected pull_request or merge_group)" >&2
    exit 1
    ;;
esac
if [ -z "$needs_json" ]; then
  echo "ci-gate: GATE_NEEDS_JSON is empty" >&2
  exit 1
fi

# Flatten `{"<job>": {"result": "<value>", ...}, ...}` into `<job>\t<value>`
# lines: a character scanner that tracks string literals and object depth, so
# it reads pretty-printed and compact JSON alike and ignores a `result` key
# nested deeper (e.g. inside `outputs`). A non-string `result` prints nothing.
job_results=$(printf '%s' "$needs_json" | awk '
  { buf = buf $0 "\n" }
  END {
    n = length(buf); depth = 0; in_str = 0; str = ""; pending = ""; key = ""; job = ""; want_value = 0
    for (i = 1; i <= n; i++) {
      c = substr(buf, i, 1)
      if (in_str) {
        if (c == "\\") { str = str c substr(buf, i + 1, 1); i++; continue }
        if (c == "\"") {
          in_str = 0
          if (want_value) {
            if (depth == 2 && key == "result" && job != "") print job "\t" str
            want_value = 0
          } else {
            pending = str
          }
          str = ""
          continue
        }
        str = str c
        continue
      }
      if (c == "\"") { in_str = 1; continue }
      if (c == ":") { key = pending; want_value = 1; if (depth == 1) job = key; continue }
      if (c == "{") { depth++; want_value = 0; continue }
      if (c == "}") { depth--; continue }
      if (c ~ /[[:space:]]/) continue
      want_value = 0
    }
  }
')

tab=$(printf '\t')
result_of() {
  local job=$1 line
  while IFS= read -r line; do
    if [ "${line%%"$tab"*}" = "$job" ]; then
      printf '%s' "${line#*"$tab"}"
      return 0
    fi
  done <<EOF
$job_results
EOF
  return 1
}

fail=0
for job in $always_on_jobs; do
  if ! result=$(result_of "$job"); then
    echo "ci-gate: $job is missing from the needs results"
    fail=1
  elif [ "$result" != "success" ]; then
    echo "ci-gate: $job did not succeed (result: '$result')"
    fail=1
  fi
done
for job in $pull_request_only_jobs; do
  if ! result=$(result_of "$job"); then
    echo "ci-gate: $job is missing from the needs results"
    fail=1
  elif [ "$result" != "$pr_only_expected" ]; then
    echo "ci-gate: $job must be $pr_only_expected on $event (result: '$result')"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "ci-gate: FAILED on $event"
  exit 1
fi
echo "ci-gate: all jobs green on $event"
