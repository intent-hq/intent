#!/usr/bin/env bash
# Container entrypoint: run exactly one job from the JIT config.
# The supervisor passes the config in ACTIONS_RUNNER_INPUT_JITCONFIG (the
# runner reads ACTIONS_RUNNER_INPUT_<ARG> and clears it), so it never appears
# in a process command line.
set -euo pipefail
if [ -z "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ]; then
  echo "runner-entrypoint: ACTIONS_RUNNER_INPUT_JITCONFIG is not set" >&2
  exit 2
fi
cd /home/runner/actions-runner
exec ./run.sh
