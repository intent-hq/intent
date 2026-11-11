#!/usr/bin/env bash
# Optional local compiler caching: never download tools or override a chosen wrapper.
# INTENT_SCCACHE_DISABLED is intentd's scripts/setup-sccache.py mark that the job has no
# usable server (download outage or failed start); wrapping would fail the build.
set -euo pipefail
if [[ -z ${RUSTC_WRAPPER+x} && -z ${INTENT_SCCACHE_DISABLED:-} && -n ${SCCACHE_WEBDAV_ENDPOINT:-} ]] &&
  command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache SCCACHE_GHA_ENABLED=false CARGO_INCREMENTAL=0
fi
exec "$@"
