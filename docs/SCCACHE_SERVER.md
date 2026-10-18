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
| `prune.sh`, `sccache-prune.{service,timer}` | `/usr/local/lib/sccache/`, `/etc/systemd/system/` | Daily prune: age window, then a hard cap on disk use |
| `bootstrap.sh` | — | Idempotent installer for all of the above, the cache volume (`--format-disk`) and the firewall |
| `test_server.py` | — | Access-matrix test (runs in monorepo CI `shell-tests`) |

## Access rules

| Request | Result |
|---|---|
| Read-write token (`Authorization: Bearer <rw>`) | Any WebDAV method (GET, HEAD, PUT, MKCOL, PROPFIND, DELETE, …) |
| Read-only token, GET / HEAD / PROPFIND / OPTIONS | Allowed |
| Read-only token, any other method | 403 |
| No token, unknown token, or a non-Bearer scheme | 401 |

Caddy strips the `Authorization` header before proxying, and rclone listens on
127.0.0.1 only. The firewall allows SSH (22) only on the Tailscale interface
`tailscale0`, and 80 (ACME challenge and HTTPS redirect) and 443 over TCP from
the public internet; everything else inbound is denied.

CI uses the read-write token (`INTENT_SCCACHE_TOKEN`). The read-only token is
kept on the box for later uses such as dev hosts.

## The box

| | |
|---|---|
| Provider | ReliableSite, Los Angeles |
| Hostname | `intent-cache` |
| Public IP | `172.96.141.217` |
| Hardware | AMD Ryzen 9 3900X, 128 GB RAM, two separate 2 TB NVMe drives |
| Network | 1 Gbps unmetered port |
| OS | Ubuntu LTS (the bootstrap detects the release and refuses non-Ubuntu) |
| SSH | Over Tailscale only (`tailscale0`) |

The 1 Gbps port (about 110 MB/s) is the likely bottleneck: many parallel CI
jobs fetching or uploading large objects at once can saturate it, which shows up
as slow cache reads rather than errors. The cutover benchmark task measures
this; if it saturates, the options are a faster port or fewer parallel jobs on
cold caches.

## Provisioning

1. Install Ubuntu LTS with the OS on the first NVMe drive (`/dev/nvme0n1`) and
   leave the second drive (`/dev/nvme1n1`) untouched. Optionally leave free
   space on the first drive and create an unused partition there (for example
   `/dev/nvme0n1p4`) to add to the cache volume.
2. Join the tailnet: install Tailscale
   (`curl -fsSL https://tailscale.com/install.sh | sh`), run `sudo tailscale up`
   and approve the node, then reconnect over its Tailscale address or
   MagicDNS name. Do this before the bootstrap: once the firewall applies,
   public SSH is refused (the current session stays up). The bootstrap refuses
   to touch the firewall if `tailscale0` does not exist.
3. No DNS name is needed: CI reaches the cache at `https://172.96.141.217`.
   Caddy gets a certificate for the IP itself from Let's Encrypt (see
   [TLS certificate](#tls-certificate)); port 80 must be reachable from the
   internet for the HTTP-01 challenge, which the firewall allows.
4. On the box, from a checkout of this repo:

   ```bash
   git clone https://github.com/intent-hq/intent.git && cd intent
   lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT   # confirm which device is unused
   sudo infra/sccache/bootstrap.sh 172.96.141.217 --format-disk /dev/nvme1n1
   # or combine with a free partition on the OS drive:
   sudo infra/sccache/bootstrap.sh 172.96.141.217 --format-disk /dev/nvme1n1 --format-disk /dev/nvme0n1p4
   ```

   The first argument is the site address that Caddy serves and gets a
   certificate for: the IP, or a host name if one is added later. The
   bootstrap stops if the installed Caddy is older than 2.10, which lacks ACME
   profiles.

   Re-running is safe: it keeps the tokens, data and volume, reinstalls the
   config and restarts the services. `--no-firewall` skips the `ufw` step.
5. Confirm with the [health check](#health-check).

## TLS certificate

Let's Encrypt issues certificates for IP addresses only under its `shortlived`
profile ([announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)),
so the Caddyfile asks for that profile explicitly. Without it, Caddy would use
its internal CA for an IP site, which sccache rejects. The certificates last
about 6 days, and Caddy renews them automatically every few days, over HTTP-01
(port 80) or TLS-ALPN-01 (port 443).

If renewal fails for longer than the certificate's remaining life (at most
about 6 days), clients reject the certificate. sccache then reports storage
errors and CI builds uncached until it renews. Watch the expiry with the
[health check](#health-check), and look for `obtain` / `renew` errors with
`journalctl -u caddy`. Typical causes: port 80 or 443 blocked, the box being
down, or Let's Encrypt rate limits.

## Disks

The cache lives on an LVM volume `/dev/sccache/cache` (ext4, label `sccache`,
no reserved blocks) mounted at `/srv/sccache` through `/etc/fstab` (`nofail`,
so a dead cache disk does not block boot). Devices are concatenated, not
mirrored: the data is a cache, so there is no redundancy, and losing a drive
means recreating the volume and a cold start.

Nothing is formatted unless it is named with `--format-disk`. Even then the
bootstrap refuses a device that is not a block device, is mounted or used as
swap, has partitions or holders, is a RAID member, or belongs to another LVM
volume group. Devices already in the `sccache` volume group are left alone, so
re-running with the same flags is a no-op for the disks. Without
`--format-disk` the bootstrap warns if `/srv/sccache` is not a separate volume
and uses the root filesystem.

To add a device to an existing volume later (the bootstrap refuses this, to
keep it from growing the volume by accident):

```bash
sudo wipefs -a /dev/<dev> && sudo pvcreate /dev/<dev>
sudo vgextend sccache /dev/<dev>
sudo lvextend -r -l +100%FREE sccache/cache
```

## Tokens

Tokens are 64-hex-character random strings generated on the box into
`/etc/sccache/caddy.env` (root-only, `0600`). They are never printed by the
bootstrap script and must never be committed.

```bash
sudo grep TOKEN /etc/sccache/caddy.env
```

Set the `SCCACHE_RW_TOKEN` value as the GitHub org secret
`INTENT_SCCACHE_TOKEN` (shared with intentd, cloudlands-fe and intent), and the
endpoint as the org Actions variable `INTENT_SCCACHE_ENDPOINT=https://172.96.141.217`.

### Rotation

```bash
sudo infra/sccache/bootstrap.sh 172.96.141.217 --rotate-rw   # or --rotate-ro
sudo grep SCCACHE_RW_TOKEN /etc/sccache/caddy.env
```

The old token stops working as soon as Caddy restarts, so update the
`INTENT_SCCACHE_TOKEN` org secret right away. Runs in flight with the old token
get 401s and may build uncached or fail; re-run any that failed. If a
token leaks, rotate first and update the secret second.

## Disk sizing and prune tuning

`sccache-prune.timer` runs `prune.sh` daily (randomized within an hour,
catching up after downtime). Each run:

1. **Age:** deletes entries not read for `SCCACHE_PRUNE_DAYS` days (default 21).
2. **Hard cap:** if disk use is still above `SCCACHE_MAX_USE_PERCENT` (default
   70), deletes the least-recently-read entries (oldest access time first)
   until use is at or below `SCCACHE_TARGET_USE_PERCENT` (default 60).
3. **Empty directories:** removes those not modified in the last hour
   (directories it just emptied go on the next run).

It logs counts and bytes for each step, never entry names. Use is measured for
the whole filesystem, which is why the cache gets its own volume (see
[Disks](#disks)): on a shared filesystem, other data counts against the cap and
can push the whole cache out. The run logs a warning when use is still above
the cap after pruning.

"Not read" uses file access time. Ubuntu's default `relatime` mount option
updates it at most once a day per file, which suits a day-granular window; do
not mount the data volume with `noatime`.

Tune in `/etc/sccache/prune.env` (created once by bootstrap, never
overwritten):

```bash
SCCACHE_PRUNE_DAYS=21
SCCACHE_MAX_USE_PERCENT=70
SCCACHE_TARGET_USE_PERCENT=60
```

`SCCACHE_TARGET_USE_PERCENT` must not exceed `SCCACHE_MAX_USE_PERCENT`; the
gap between them sets how much headroom one size prune frees.

Check the effect with:

```bash
sudo systemctl start sccache-prune.service && journalctl -u sccache-prune -n 20
df -h /srv/sccache
sudo du -sh /srv/sccache
systemctl list-timers sccache-prune.timer
```

Sizing rule of thumb: watch the prune log for a week after go-live. If the
size step runs most days, the age window is longer than the disk can hold, so
the cap is evicting entries that are still in use: add disk or accept the lower
hit rate. If use sits far below the cap, lengthen `SCCACHE_PRUNE_DAYS` for a
better hit rate.

## Health check

From anywhere (replace the token with the read-only one from the box):

```bash
echo | openssl s_client -connect 172.96.141.217:443 2>/dev/null \
  | openssl x509 -noout -issuer -enddate                                        # Let's Encrypt; notAfter a few days out
curl -sS -o /dev/null -w '%{http_code}\n' https://172.96.141.217/            # expect 401
curl -sS -o /dev/null -w '%{http_code}\n' -X PROPFIND -H 'Depth: 0' \
  -H "Authorization: Bearer $RO_TOKEN" https://172.96.141.217/                 # expect 207
```

On the box (over Tailscale: `ssh intent-cache`):

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
  secret, then the box.

## Testing changes

`infra/sccache/test_server.py` starts rclone and Caddy on loopback with
throwaway tokens and checks the access matrix above, plus `prune.sh`,
`check-caddy-env.sh`, and the bootstrap's argument parsing, OS check, disk
safety checks, volume setup and firewall rules (sourced with system commands
stubbed; it never runs the installer). Locally it skips the server tests unless `caddy` and
`rclone` are on `PATH` (or `CADDY_BIN` / `RCLONE_BIN` are set); the
`sccache server test` step of the monorepo `shell-tests` CI job installs
pinned, checksum-verified binaries so they always run there.

```bash
CADDY_BIN=/path/to/caddy RCLONE_BIN=/path/to/rclone python3 -S -B infra/sccache/test_server.py -v
shellcheck infra/sccache/*.sh
```
