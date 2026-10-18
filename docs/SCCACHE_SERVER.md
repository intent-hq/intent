# sccache cache server runbook

The self-hosted sccache cache is one Ubuntu box in Los Angeles that serves
sccache's WebDAV backend to CI. Everything needed to rebuild it lives in
[`infra/sccache/`](../infra/sccache/). It is a cache: there are no backups, and
losing the disk only means a cold start that the main-branch cache producer
refills.

```
CI runner ──HTTPS + Bearer token──▶ Caddy :443 ──▶ rclone serve webdav 127.0.0.1:8080 ──▶ /srv/sccache
```

| File | Installed as | Role |
|---|---|---|
| `Caddyfile` | `/etc/caddy/Caddyfile` | Automatic TLS; token check; proxy to rclone |
| `caddy-override.conf` | `/etc/systemd/system/caddy.service.d/sccache.conf` | Loads `/etc/sccache/caddy.env`; drops `--environ` so tokens never reach the journal |
| `check-caddy-env.sh` | `/usr/local/lib/sccache/` | `ExecStartPre`: refuses empty, short, or identical tokens |
| `sccache-webdav.service` | `/etc/systemd/system/` | rclone WebDAV on loopback only, as user `sccache` |
| `prune.sh`, `sccache-prune.{service,timer}` | `/usr/local/lib/sccache/`, `/etc/systemd/system/` | Daily prune |
| `bootstrap.sh` | — | Idempotent installer for all of the above plus the firewall |
| `test_server.py` | — | Access-matrix test (runs in monorepo CI `shell-tests`) |

## Access rules

| Request | Result |
|---|---|
| Read-write token (`Authorization: Bearer <rw>`) | Any WebDAV method (GET, HEAD, PUT, MKCOL, PROPFIND, DELETE, …) |
| Read-only token, GET / HEAD / PROPFIND / OPTIONS | Allowed |
| Read-only token, any other method | 403 |
| No token, unknown token, or a non-Bearer scheme | 401 |

Caddy strips the `Authorization` header before proxying, and rclone listens on
127.0.0.1 only. The firewall allows inbound 22, 80 (ACME challenge and HTTPS
redirect) and 443 over TCP only.

CI uses the read-write token (`INTENT_SCCACHE_TOKEN`). The read-only token is
kept on the box for later uses such as dev hosts.

## Provisioning

1. Get an Ubuntu 24.04 box (current: ReliableSite Ryzen 3900X, 128 GB, 2×2 TB
   NVMe, Los Angeles). Mount the data disk(s) at `/srv/sccache` before
   bootstrapping, or the cache lands on the root filesystem. Two NVMe drives in
   RAID 0 (or one ext4/xfs volume per drive with the larger one mounted) are
   fine; redundancy buys nothing for a cache.
2. Create a DNS A (and AAAA if the box has IPv6) record, e.g.
   `cache.<our-domain>`, pointing at the box. It must resolve before Caddy can
   get a certificate.
3. On the box, from a checkout of this repo:

   ```bash
   git clone https://github.com/intent-hq/intent.git && cd intent
   sudo infra/sccache/bootstrap.sh cache.<our-domain>
   ```

   Re-running is safe: it keeps the tokens and data, reinstalls the config and
   restarts the services. `--no-firewall` skips the `ufw` step (for example on
   a box whose provider firewall already does this).
4. Confirm with the [health check](#health-check).

## Tokens

Tokens are 64-hex-character random strings generated on the box into
`/etc/sccache/caddy.env` (root-only, `0600`). They are never printed by the
bootstrap script and must never be committed.

```bash
sudo grep TOKEN /etc/sccache/caddy.env
```

Set the `SCCACHE_RW_TOKEN` value as the GitHub org secret
`INTENT_SCCACHE_TOKEN` (shared with intentd, cloudlands-fe and intent), and the
endpoint as the org Actions variable `INTENT_SCCACHE_ENDPOINT=https://cache.<our-domain>`.

### Rotation

```bash
sudo infra/sccache/bootstrap.sh cache.<our-domain> --rotate-rw   # or --rotate-ro
sudo grep SCCACHE_RW_TOKEN /etc/sccache/caddy.env
```

The old token stops working as soon as Caddy restarts, so update the
`INTENT_SCCACHE_TOKEN` org secret right away. Runs in flight with the old token
get 401s and may build uncached or fail; re-run any that failed. If a
token leaks, rotate first and update the secret second.

## Disk sizing and prune tuning

`sccache-prune.timer` runs `prune.sh` daily (randomized within an hour,
catching up after downtime). It deletes entries not read for
`SCCACHE_PRUNE_DAYS` days (default 21) and then removes empty directories
older than an hour (directories it just emptied go on the next run). If disk
use is still above `SCCACHE_MAX_USE_PERCENT` (default 70), it shortens the
window one day at a time, down to one day.

"Not read" uses file access time. Ubuntu's default `relatime` mount option
updates it at most once a day per file, which suits a day-granular window; do
not mount the data volume with `noatime`.

Tune in `/etc/sccache/prune.env` (created once by bootstrap, never
overwritten):

```bash
SCCACHE_PRUNE_DAYS=21
SCCACHE_MAX_USE_PERCENT=70
```

Check the effect with:

```bash
sudo systemctl start sccache-prune.service && journalctl -u sccache-prune -n 20
df -h /srv/sccache
sudo du -sh /srv/sccache
systemctl list-timers sccache-prune.timer
```

Sizing rule of thumb: watch `du` for a week after go-live. If steady-state use
after prune is well above 70% even at short windows, add disk; if it sits far
below, lengthen `SCCACHE_PRUNE_DAYS` for a better hit rate.

## Health check

From anywhere (replace the token with the read-only one from the box):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://cache.<our-domain>/            # expect 401
curl -sS -o /dev/null -w '%{http_code}\n' -X PROPFIND -H 'Depth: 0' \
  -H "Authorization: Bearer $RO_TOKEN" https://cache.<our-domain>/                 # expect 207
```

On the box:

```bash
systemctl status caddy sccache-webdav sccache-prune.timer
journalctl -u caddy -u sccache-webdav --since -1h
sudo ufw status verbose
```

In CI, `sccache --show-stats` should report the WebDAV cache location with no
storage read/write errors.

## Rollback

- **CI back to Depot:** delete the `INTENT_SCCACHE_ENDPOINT` org variable. The
  next run uses Depot Cache; no code change or server change is needed.
- **Bad config change on the box:** check out the previous commit of this repo
  and re-run `bootstrap.sh`; tokens and data are kept.
- **Corrupt or full cache:** `sudo systemctl stop sccache-webdav && sudo find
  /srv/sccache -mindepth 1 -delete && sudo systemctl start sccache-webdav`.
  The next main-branch runs refill it.
- **Decommission:** delete the org variable, then the `INTENT_SCCACHE_TOKEN`
  secret, then the box and DNS record.

## Testing changes

`infra/sccache/test_server.py` starts rclone and Caddy on loopback with
throwaway tokens and checks the access matrix above, plus `prune.sh` and
`check-caddy-env.sh`. Locally it skips the server tests unless `caddy` and
`rclone` are on `PATH` (or `CADDY_BIN` / `RCLONE_BIN` are set); the
`sccache server test` step of the monorepo `shell-tests` CI job installs
pinned, checksum-verified binaries so they always run there.

```bash
CADDY_BIN=/path/to/caddy RCLONE_BIN=/path/to/rclone python3 -S -B infra/sccache/test_server.py -v
shellcheck infra/sccache/*.sh
```
