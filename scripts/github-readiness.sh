#!/usr/bin/env bash
# Shell entry point for the same classifier imported by dev-status's Python.
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 "$script_dir/github_readiness.py" "$@"
