# GitHub runner slots runbook (intent-cache)

The `intent-cache` box (see [SCCACHE_SERVER.md](./SCCACHE_SERVER.md#the-box))
also runs org-wide GitHub Actions Linux runners for `intent-hq`, in two pools:

| Pool | Slots | Label | Per slot |
|---|---|---|---|
| heavy | 2 | `intent-cache` | 8 CPUs = 4 whole cores (pinned 0-3,12-15 and 4-7,16-19), 48 GB |
| small | 6 | `intent-cache-small` | 1 CPU (pinned 8, 9, 10, 20, 21, 22, one each), 3 GB |

CPUs 11 and 23 (one whole core) are left to the cache and the system.

Each slot runs one job in a fresh Docker container, then starts another. Everything needed to
rebuild them lives in [`infra/runners/`](../infra/runners/).

```
github-runner@<pool>-<n>.service ─ supervisor.sh <pool>-<n> ─┬─ GitHub API: JIT registration (one job)
                                                            └─ docker run --rm intent-gh-runner:current
                                                                 └─ actions runner ─ job ─ exits ─ container removed
```

| File | Installed as | Role |
|---|---|---|
| `Dockerfile`, `entrypoint.sh` | image `intent-gh-runner:current` | One image for both pools: Ubuntu 24.04, build tools, pinned and checksummed runner, rustup, gh, Node and PowerShell; Rust toolchain baked; user `runner` (uid 1001); no sudo |
| `supervisor.sh` | `/usr/local/lib/github-runners/` | One slot, one job: JIT-register, run the pinned container, drain on stop, deregister; `--plan` validates the config and lists the slots |
| `runners.env` | `/etc/github-runners/runners.env` (once) | Pools, slot counts, labels, CPU sets, memory (not secret) |
| `github-runner@.service` | `/etc/systemd/system/` | One instance per slot (`heavy-1`, `small-3`, …); restarts the supervisor after every job |
| `runners.slice` | `/etc/systemd/system/` | Parent cgroup of the containers at the cgroup root: CPU and IO weight 10 (`system.slice`: 100), 116G cap |
| `cache-priority.conf` | `/etc/systemd/system/{caddy,sccache-webdav}.service.d/runners-priority.conf` | CPU and IO weight 1000 for the cache services |
| `egress.sh`, `github-runners-egress.service` | `/usr/local/lib/github-runners/`, `/etc/systemd/system/` | Blocks containers from private, tailnet and link-local addresses |
| `daemon.json` | `/etc/docker/daemon.json` | User-namespace remapping, journald logs, no inter-container traffic, no-new-privileges |
| `install.sh` | — | Idempotent installer for all of the above and the slot count |
| `test_runners.py` | — | Supervisor and installer tests with stubbed system commands (monorepo CI `shell-tests`) |

Logs go to journald: `journalctl -u 'github-runner@*' -f` (supervisor and the
runner output, tagged `github-runner-<pool>-<n>`).

## Design

- **Ephemeral.** Every job gets a new just-in-time runner registration and a new
  container (`--rm`), so jobs never see another job's files. Nothing persists
  between jobs, not even download caches: a shared cargo registry or rustup
  directory could be poisoned by one job for the next. The pinned Rust toolchain
  is baked into the image instead, so the common case downloads nothing.
- **Same paths as GitHub-hosted runners.** `HOME=/home/runner`, work directory
  `/home/runner/work` (so `GITHUB_WORKSPACE=/home/runner/work/<repo>/<repo>`),
  `CARGO_HOME=/home/runner/.cargo`, `RUSTUP_HOME=/home/runner/.rustup`, tool cache
  `/opt/hostedtoolcache`. sccache keys include these paths, so builds here hit
  entries written on hosted runners and vice versa. The
  [smoke workflow](../.github/workflows/intent-cache-smoke.yml) checks this.
- **Isolated.** Jobs run as `runner` with no capabilities, `no-new-privileges`,
  no sudo, no Docker socket and no host network; Docker's user-namespace remap
  maps even container root to an unprivileged host uid. They cannot see
  `/etc/sccache` or `/srv/sccache` and reach the cache only through
  `https://172.96.141.217` with the CI token, like any other runner. Containers
  use the `gh-runners` bridge (`gh-runners0`, 172.30.250.0/24) with
  inter-container traffic off; the egress filter drops traffic to
  10/8, 172.16/12, 192.168/16, 100.64/10 (tailnet), 169.254/16 and IPv6 ULA and
  link-local in the `raw` table, which Docker, Tailscale and ufw never reorder.
  The supervisor refuses to start a job if those rules are missing. No container
  publishes a port, so Docker never opens anything past ufw.
- **Pinned CPUs and limits.** Each slot is pinned to its own CPU set
  (`--cpuset-cpus`) with a matching CPU quota, so `nproc` and Node's
  `os.availableParallelism()` report 8 on a heavy slot and 1 on a small one.
  Memory has no swap: 48 GB (heavy) and 3 GB (small), 2 × 48 + 6 × 3 = 114 GB,
  leaving about 11 GB of the 125 GB for the system and page cache. Processes:
  16384 / 4096; `/dev/shm`: 1 GB / 256 MB. The box has 12 cores with two
  threads each (CPU *n* and *n*+12 share a core), so the CPU sets follow
  sibling pairs: each heavy slot owns 4 whole cores, the small pool shares
  cores 8-10, and no heavy slot shares a core with another slot. Caddy, rclone
  and the system are not pinned: core 11 (CPUs 11 and 23) is never given to a
  slot, and on the others the cache wins CPU and IO contention (weight 1000
  inside `system.slice`, which outweighs `runners.slice` 10 to 1). Check
  siblings with `cat /sys/devices/system/cpu/cpu*/topology/thread_siblings_list`
  before changing the sets on other hardware. Job disk lives in the container layer on the
  root NVMe (`/var/lib/docker`), separate from the cache disk, and disappears
  with the container.
- **Labels.** `self-hosted`, `Linux`, `X64` (GitHub adds these itself) plus
  `intent-cache` (heavy) or `intent-cache-small` (small). Target a pool
  explicitly, e.g. `runs-on: [self-hosted, intent-cache-small]`. The
  `runner-route` probe also counts every online `self-hosted`/`Linux`/`X64`
  runner, from either pool, as Linux fleet capacity unless the repository
  variable `CI_LINUX_RUNNER_DISABLED` is `true`.

## Preinstalled tools

Routed jobs call these without a setup step, as they would on GitHub-hosted
`ubuntu-24.04`: bash, git, git-lfs, curl, jq, gh, make, gcc/g++
(build-essential), bison/yacc, procps (ps, pgrep, pkill), iproute2 (ss), lsof, pkg-config, libssl-dev, shellcheck, tar, zip,
unzip, xz, zstd, rsync, file, dpkg-deb, python3 with pip and venv, Node with
npm and corepack (in `/opt/node`, owned by `runner`, so `corepack enable` and
`npm install -g` work without sudo), PowerShell (`pwsh`), and rustup with the
pinned Rust toolchain. Other versions of Node, Python and Rust come from the
usual setup actions. Pins and checksums are the `ARG`s at the top of the
`Dockerfile`; add a tool there when a routed job needs it.

## Not supported in jobs

No `sudo` (install packages in the `Dockerfile` instead), no Docker
(`container:` jobs, service containers and Docker actions fail), no access to
private or tailnet addresses.

## Runner group

Every slot registers into the org runner group named by `RUNNER_GROUP`
(`intent-cache`), never into Default. The group may be used only by the
repositories in `RUNNER_GROUP_REPOS` (`intent,intentd,cloudlands-fe`), so other
org repositories cannot target these runners. "Allow public repositories" is on
because those three are public. Workflows from forks of them can still request
the labels, so keep fork pull-request workflows behind maintainer approval in
the repository settings. If the group is missing, slots stop registering rather
than fall back to Default.

The installer applies the group (creates it, or resets its visibility,
public-repository setting, workflow restriction and repository list) before it
enables any slot. To apply or audit it by hand:

```bash
ssh root@intent-cache
/usr/local/lib/github-runners/supervisor.sh --group-apply
/usr/local/lib/github-runners/supervisor.sh --group-check   # JSON; exit 1 on drift
```

`--group-check` prints the group's visibility, settings and repositories, plus
every `intent-cache-*` runner that is outside the group. It never prints the
credential. To change the repositories, edit `RUNNER_GROUP_REPOS` and re-run the
installer.

## Credential

The supervisor registers runners through the org API, which needs a credential
with the organization permission **Self-hosted runners: read and write**:

- a fine-grained personal access token with resource owner `intent-hq` and that
  permission (an org owner may need to approve it), or
- a GitHub App installed on `intent-hq` with that permission.

Put it on the box, root-only. Never commit, print or paste it into notes:

```bash
ssh root@intent-cache
install -d -m 700 /etc/github-runners
( umask 077; cat > /etc/github-runners/credentials )   # paste, then Ctrl-D
```

The file holds either the bare token on one line, `GITHUB_TOKEN=<token>`, or
for an App:

```
GITHUB_APP_ID=<app id>
GITHUB_APP_INSTALLATION_ID=<installation id>
GITHUB_APP_PRIVATE_KEY_FILE=/etc/github-runners/app.pem
```

Both the supervisor and the installer refuse a credential file that is not
root-owned with mode 600.

**Rotate:** write the new credential to the same path. Each slot reads it at
the start of every job, so no restart is needed; revoke the old one once
`journalctl -u 'github-runner@*'` shows new registrations.

## Install or update

From a checkout of this repository on your machine:

```bash
scp -r infra/runners root@intent-cache:/root/infra/
ssh root@intent-cache /root/infra/runners/install.sh
```

The installer is idempotent. It rebuilds the image on every run; a running job
keeps its image and the next job uses the new one. Without a credential it
installs everything and leaves the slots off. `--no-build` skips the image
build for configuration-only changes.

Slot settings live in `/etc/github-runners/runners.env` (not secret; the
installer copies [`runners.env`](../infra/runners/runners.env) once and never
overwrites it): `GITHUB_ORG`, `RUNNER_GROUP` (name, default `intent-cache`), `RUNNER_GROUP_REPOS`, `RUNNER_POOLS`,
and per pool `<POOL>_SLOTS`, `_LABELS`, `_CPUSETS` (one entry per slot,
space-separated), `_MEMORY`, `_PIDS`, `_SHM`. Limits apply from each slot's
next job.

## Add or remove slots

Edit `/etc/github-runners/runners.env` (for example `SMALL_SLOTS=4`, or a new
pool added to `RUNNER_POOLS` with its own keys), check it, then apply:

```bash
ssh root@intent-cache
/usr/local/lib/github-runners/supervisor.sh --plan   # validates, lists slots
/root/infra/runners/install.sh --no-build
```

The installer enables exactly the planned slots and drains and disables the
rest; an invalid file changes nothing. Keep CPU sets disjoint, leave a CPU or
two unpinned, and keep the total memory at or below about 114 GB on this box
(raise `MemoryMax` in `runners.slice` with it).

## Drain and stop

```bash
systemctl stop github-runner@heavy-2    # one slot
systemctl stop 'github-runner@*'        # all slots
```

An idle slot deregisters and stops within seconds. A slot running a job waits
for that job (up to 6 hours, `TimeoutStopSec`), then exits. If the job runs
longer, systemd kills the supervisor and `ExecStopPost` removes the container
and its disk (the container lives in `runners.slice`, outside the unit's
cgroup); the next start deletes the leftover registration. A job assigned in
the second between the idle check and the stop fails and must be re-run.
`systemctl start` brings a slot back; `systemctl disable --now` keeps it off
across reboots.

Re-running the installer never restarts a slot: new limits and a new image
apply from each slot's next job. To apply them at once, restart the slots
(busy ones drain first). Restart them one at a time (`systemctl restart
github-runner@heavy-1`, then the next), because one `systemctl restart` across
several units holds the idle ones down until the busy ones finish.

## Upgrade the runner

GitHub stops sending jobs to runners more than 30 days behind the latest
release, so bump the pin at least monthly:

1. Take the version and the `linux-x64` SHA-256 from the
   [release notes](https://github.com/actions/runner/releases/latest).
2. Update `RUNNER_VERSION` and `RUNNER_SHA256` in `infra/runners/Dockerfile`
   (likewise `RUSTUP_*` and `RUST_TOOLCHAIN` when they change) and land the PR.
3. Re-run the installer. The smoke workflow runs on the PR when
   `infra/runners/` changes.

## Troubleshoot

| Symptom | Check |
|---|---|
| Slot restarts every few seconds | `journalctl -u github-runner@heavy-1 -n 50`: credential missing or not 600, egress rules missing (`systemctl restart github-runners-egress`), image missing (re-run the installer) |
| `JIT registration failed (HTTP 401/403)` | The credential expired or lacks **Self-hosted runners: read and write** on the org |
| `JIT registration failed (HTTP 409/422)` | Name conflict or bad labels in `runners.env` |
| `runner group 'intent-cache' not found` | The group was renamed or deleted; recreate it (see Runner group) or fix `RUNNER_GROUP` |
| `is not a configured slot` | The unit's instance is not in `supervisor.sh --plan`; re-run the installer |
| Jobs stay queued | `gh api orgs/intent-hq/actions/runners` (needs the same permission): runners online with the expected labels; the `intent-cache` runner group lists the repository; `docker ps` shows `gh-runner-<pool>-<n>` |
| Offline `intent-cache-<pool>-<n>-*` runners in the org list | Left by a crash or reboot; the slot deletes its own on its next start |
| A job cannot reach a host | Private and tailnet addresses are blocked on purpose; `iptables -t raw -S GH-RUNNERS-EGRESS` lists them |
| Cache slow while jobs run | `cat /sys/fs/cgroup/runners.slice/cpu.weight` (10) and `/sys/fs/cgroup/system.slice/caddy.service/cpu.weight` (1000); fewer slots or smaller CPU sets |

Health at a glance:

```bash
systemctl status 'github-runner@*' github-runners-egress --no-pager
docker ps --format '{{.Names}} {{.Status}}'
systemd-cgtop -1 runners.slice
```
