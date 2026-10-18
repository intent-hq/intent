#!/usr/bin/env bash
# Prune the sccache store: delete entries not read for SCCACHE_PRUNE_DAYS
# days (default 21), then empty directories. If disk use is still above
# SCCACHE_MAX_USE_PERCENT (default 70), shorten the window a day at a time
# down to 1 day. Run daily by sccache-prune.timer.
#
# "Not read" uses atime. Ubuntu's default relatime updates atime at most once
# a day per file, which is enough for a day-granular window.
set -euo pipefail

data_dir="${SCCACHE_DATA_DIR:-/srv/sccache}"
days="${SCCACHE_PRUNE_DAYS:-21}"
max_use="${SCCACHE_MAX_USE_PERCENT:-70}"

case "$days" in ''|*[!0-9]*) echo "prune: SCCACHE_PRUNE_DAYS must be a positive integer" >&2; exit 2;; esac
case "$max_use" in ''|*[!0-9]*) echo "prune: SCCACHE_MAX_USE_PERCENT must be an integer" >&2; exit 2;; esac
[ "$days" -ge 1 ] || { echo "prune: SCCACHE_PRUNE_DAYS must be >= 1" >&2; exit 2; }
[ -d "$data_dir" ] || { echo "prune: $data_dir does not exist" >&2; exit 1; }

use_percent() {
  df --output=pcent "$data_dir" | tail -n 1 | tr -dc '0-9'
}

prune_older_than() {
  # -atime +N matches files last read more than N*24h ago (fractions dropped),
  # so +(days-1) means "not read in the last <days> days".
  local count
  count="$(find "$data_dir" -xdev -type f -atime +"$(($1 - 1))" -print -delete | wc -l)"
  echo "prune: removed $count entries not read in $1 days"
}

prune_older_than "$days"
while [ "$(use_percent)" -gt "$max_use" ] && [ "$days" -gt 1 ]; do
  days=$((days - 1))
  echo "prune: disk use $(use_percent)% > ${max_use}%, shortening window to $days days"
  prune_older_than "$days"
done

# Leave directories modified in the last hour alone so a concurrent MKCOL +
# PUT from sccache does not lose its freshly created parent. Directories this
# run just emptied count as modified and go on the next daily run.
find "$data_dir" -xdev -mindepth 1 -type d -empty -mmin +60 -delete
echo "prune: disk use now $(use_percent)%"
