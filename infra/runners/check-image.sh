#!/usr/bin/env bash
# Run the baked tools in a runner image: every Python and Node version the
# Dockerfile pins in the tool cache, gh, pwsh, the cargo tools and
# llvm-tools. install.sh runs it on each new build before tagging it current.
#
# Usage: infra/runners/check-image.sh IMAGE
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${1:?usage: check-image.sh IMAGE}"

# shellcheck disable=SC2016
check='
for v in $PYTHONS; do
  test -f "$RUNNER_TOOL_CACHE/Python/$v/x64.complete"
  "$RUNNER_TOOL_CACHE/Python/$v/x64/bin/python3" --version
done
for v in $NODES; do
  test -f "$RUNNER_TOOL_CACHE/node/$v/x64.complete"
  echo "node $("$RUNNER_TOOL_CACHE/node/$v/x64/bin/node" --version)"
done
python3 --version; node --version; gh --version | sed -n 1p; pwsh --version
cargo --version; cargo nextest --version; cargo llvm-cov --version; cargo shear --version
components=$(rustup component list --installed)
grep -E "^llvm-tools" <<<"$components"
'

dockerfile_arg() { sed -n "s/^ARG $1=//p" "$here/Dockerfile" | tr -d '"'; }

pythons="$(dockerfile_arg 'PYTHON_[0-9]*_[0-9]*_VERSION' | xargs)"
nodes="$(dockerfile_arg NODE_VERSION)"
for entry in $(dockerfile_arg NODE_TOOLCACHE); do nodes="$nodes ${entry%%=*}"; done
if [ -z "$pythons" ] || [ -z "$nodes" ]; then
  echo "check-image: error: no Python or Node versions in $here/Dockerfile" >&2
  exit 1
fi
docker run --rm --network none --entrypoint bash -e "PYTHONS=$pythons" -e "NODES=$nodes" \
  "$image" -euo pipefail -c "$check"
