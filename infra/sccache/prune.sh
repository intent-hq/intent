#!/usr/bin/env bash
# Prune the sccache store, run daily by sccache-prune.timer:
#   1. Delete entries not read for SCCACHE_PRUNE_DAYS days (default 21).
#   2. Hard cap: if disk use is still above SCCACHE_MAX_USE_PERCENT (default
#      70), delete least-recently-read entries (oldest atime first) until use
#      is at or below SCCACHE_TARGET_USE_PERCENT (default 60).
#   3. Remove empty directories.
# Logs counts and bytes only, never entry names. Use is measured for the whole
# filesystem, so the cache should have a dedicated volume (bootstrap.sh
# --format-disk); on a shared filesystem other data can push it out entirely.
#
# "Read" uses atime. Ubuntu's default relatime updates atime at most once a
# day per file, which is enough for a day-granular window and for ordering.
set -euo pipefail

data_dir="${SCCACHE_DATA_DIR:-/srv/sccache}"
days="${SCCACHE_PRUNE_DAYS:-21}"
max_use="${SCCACHE_MAX_USE_PERCENT:-70}"
target_use="${SCCACHE_TARGET_USE_PERCENT:-60}"

fail() { echo "prune: $*" >&2; exit 2; }
for pair in "SCCACHE_PRUNE_DAYS=$days" "SCCACHE_MAX_USE_PERCENT=$max_use" "SCCACHE_TARGET_USE_PERCENT=$target_use"; do
  case "${pair#*=}" in ''|*[!0-9]*) fail "${pair%%=*} must be a non-negative integer";; esac
done
[ "$days" -ge 1 ] || fail "SCCACHE_PRUNE_DAYS must be >= 1"
if [ "$max_use" -lt 1 ] || [ "$max_use" -gt 100 ]; then fail "SCCACHE_MAX_USE_PERCENT must be 1-100"; fi
if [ "$target_use" -lt 1 ] || [ "$target_use" -gt "$max_use" ]; then fail "SCCACHE_TARGET_USE_PERCENT must be 1-SCCACHE_MAX_USE_PERCENT"; fi
[ -d "$data_dir" ] || { echo "prune: $data_dir does not exist" >&2; exit 1; }

# Prints "<size bytes> <used bytes>" for the filesystem holding data_dir.
fs_bytes() {
  df -B1 --output=size,used "$data_dir" | tail -n 1 | awk '{print $1, $2}'
}

use_percent() {
  local size used
  read -r size used < <(fs_bytes)
  echo $(( (used * 100 + size - 1) / size ))
}

# Step 1: -atime +N matches files last read more than N*24h ago (fractions
# dropped), so +(days-1) means "not read in the last <days> days".
count=0
bytes=0
while IFS=' ' read -r -d '' blocks path; do
  rm -f -- "$path"
  count=$((count + 1))
  bytes=$((bytes + blocks * 512))
done < <(find "$data_dir" -xdev -type f -atime +"$((days - 1))" -printf '%b %p\0')
echo "prune: age: removed $count entries ($bytes bytes) not read in $days days"

# Step 2: hard cap on disk use.
use="$(use_percent)"
if [ "$use" -gt "$max_use" ]; then
  read -r size used < <(fs_bytes)
  need=$(( used - size * target_use / 100 ))
  count=0
  bytes=0
  while IFS=' ' read -r -d '' _atime blocks path; do
    [ "$bytes" -lt "$need" ] || break
    rm -f -- "$path"
    count=$((count + 1))
    bytes=$((bytes + blocks * 512))
  done < <(find "$data_dir" -xdev -type f -printf '%A@ %b %p\0' | sort -z -n)
  echo "prune: size: disk use ${use}% > ${max_use}%; removed $count least-recently-read entries ($bytes bytes) to reach ${target_use}%"
else
  echo "prune: size: disk use ${use}% <= ${max_use}%; nothing to do"
fi

# Step 3: leave directories modified in the last hour alone so a concurrent
# MKCOL + PUT from sccache does not lose its freshly created parent.
# Directories this run just emptied count as modified and go on the next run.
dirs="$(find "$data_dir" -xdev -mindepth 1 -type d -empty -mmin +60 -print -delete | wc -l)"
use="$(use_percent)"
echo "prune: removed $dirs empty directories; disk use now ${use}%"
if [ "$use" -gt "$max_use" ]; then
  echo "prune: warning: disk use is still above ${max_use}% with the cache pruned; data outside the cache fills this filesystem (use a dedicated volume)" >&2
fi
