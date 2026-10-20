#!/usr/bin/env bash
# Optional local compiler caching: never download tools or override a chosen wrapper.
set -euo pipefail
if [[ -z ${RUSTC_WRAPPER+x} && -n ${SCCACHE_WEBDAV_ENDPOINT:-} ]] && command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache SCCACHE_GHA_ENABLED=false CARGO_INCREMENTAL=0
fi
exec "$@"
