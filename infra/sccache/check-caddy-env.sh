#!/usr/bin/env bash
# Refuse to start Caddy with an empty or weak token: an empty token would make
# the Authorization matcher accept the bare string "Bearer ".
set -euo pipefail
for name in SCCACHE_SITE SCCACHE_RW_TOKEN SCCACHE_RO_TOKEN; do
  if [ -z "${!name:-}" ]; then
    echo "check-caddy-env: $name is empty (see /etc/sccache/caddy.env)" >&2
    exit 1
  fi
done
for name in SCCACHE_RW_TOKEN SCCACHE_RO_TOKEN; do
  value="${!name}"
  if [ "${#value}" -lt 32 ] || [[ ! "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "check-caddy-env: $name must be at least 32 characters of [A-Za-z0-9_-]" >&2
    exit 1
  fi
done
if [ "$SCCACHE_RW_TOKEN" = "$SCCACHE_RO_TOKEN" ]; then
  echo "check-caddy-env: SCCACHE_RW_TOKEN and SCCACHE_RO_TOKEN must differ" >&2
  exit 1
fi
