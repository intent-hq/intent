#!/usr/bin/env bash
#
# `make lint-workflows`: actionlint over the monorepo's own .github/workflows,
# including its shellcheck pass over `run:` scripts.
#
# Workflow YAML has no type system we control, so mistakes in it reached main
# unseen: a manual actionlint run printed self-hosted runner labels as unknown
# plus three false alarms, and a reviewer had to diff that noise against main
# by hand (found while building intent-hq/intent#7557). Main is now clean, so
# any finding is new and fails the CI `workflow-lint` job.
#
# Rule policy (runner labels, path-scoped ignores) lives in
# .github/actionlint.yaml, which actionlint reads from the repo root.
#
# Preconditions fail fast with doctor's [missing] wording instead of degrading:
#   - actionlint must be exactly the pin in scripts/bootstrap-dev-host.sh
#     (ACTIONLINT_VERSION, the one monorepo copy; cloudlands-fe pins the same);
#   - shellcheck must be on PATH. actionlint silently skips the `run:` script
#     checks without it, which would make a green run mean less on some hosts.
#
# Extra arguments are passed to actionlint (e.g. one workflow file).
# Pure Bash (3.2 compatible) apart from actionlint itself, so the self-test can
# run it under a PATH holding only stubs.

set -euo pipefail

script_dir=$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)
repo_root=$(cd "$script_dir/.." && pwd -P)
pin_file=$script_dir/bootstrap-dev-host.sh

missing() {
  echo "[missing]  $*" >&2
  exit 1
}

pin=
while IFS= read -r line || [ -n "$line" ]; do
  case $line in
    ACTIONLINT_VERSION=*)
      pin=${line#ACTIONLINT_VERSION=}
      pin=${pin//\"/}
      break
      ;;
  esac
done <"$pin_file"
if [ -z "$pin" ]; then
  echo "lint-workflows: cannot read ACTIONLINT_VERSION from $pin_file" >&2
  exit 2
fi

if ! command -v actionlint >/dev/null 2>&1; then
  missing "actionlint $pin: required by make lint-workflows; run make bootstrap-dev-host"
fi
# The first line of `actionlint --version` is the version: bare for release
# archives, v-prefixed for a `go install ...@vX.Y.Z` build.
if ! version_output=$(actionlint --version 2>/dev/null); then
  missing "actionlint: $(command -v actionlint) is on PATH but actionlint --version fails; reinstall it (run make bootstrap-dev-host)"
fi
found=${version_output%%$'\n'*}
found=${found#v}
if [ "$found" != "$pin" ]; then
  missing "actionlint: found $found; make lint-workflows pins $pin; run make bootstrap-dev-host"
fi

if ! shellcheck_path=$(command -v shellcheck 2>/dev/null); then
  missing "shellcheck: required by make lint-workflows (actionlint skips run: script checks without it); run make bootstrap-dev-host"
fi

cd "$repo_root"
status=0
actionlint -shellcheck "$shellcheck_path" "$@" || status=$?
if [ "$status" -eq 0 ]; then
  echo "lint-workflows: .github/workflows is clean (actionlint $found)"
fi
exit "$status"
