# GitHub runner slots runbook

Org-wide GitHub Actions Linux runners for `intent-hq` run on a small fleet of
hosts. The `intent-cache` box (see [SCCACHE_SERVER.md](./SCCACHE_SERVER.md#the-box))
runs them next to the sccache server; runner-only hosts run nothing else. All
of them register into one runner group and share the pool labels, so a job
targeting a label runs on whichever host has a free slot.

| Host | Location | Hardware | Pools (slots) | Labels | Name prefix | Config |
|---|---|---|---|---|---|---|
| intent-cache | ReliableSite, Los Angeles | Ryzen 9 3900X, 12 cores / 24 threads, 128 GB | heavy (2), small (6) | `intent-cache`, `intent-cache-small` | `intent-cache` | [`runners.env`](../infra/runners/runners.env) |
| intent-ci1 | ReliableSite, Los Angeles | EPYC 4545P, 16 cores / 32 threads, 128 GB | xl (1), heavy (2) | `intent-cache-xl`, `intent-cache` | `intent-ci1` | [`hosts/intent-ci1.env`](../infra/runners/hosts/intent-ci1.env) |

| Pool | Label | Hosted fallback | Per slot |
|---|---|---|---|
| heavy | `intent-cache` | `gh-linux-8x` | 8 CPUs = 4 whole cores; 48 GB on intent-cache, 30 GB on intent-ci1, 32 GB in the three-heavy EPYC layout |
| xl | `intent-cache-xl` | `gh-linux-16x` | 16 CPUs = 8 whole cores (one CCD), 52 GB |
| small | `intent-cache-small` | — | 1 CPU, 3 GB (intent-cache only) |

On intent-cache the heavy slots are pinned to 0-3,12-15 and 4-7,16-19, the
small ones to 8, 9, 10, 20, 21 and 22, and CPUs 11 and 23 (one whole core) are
left to the cache and the system. On intent-ci1 the xl slot owns cores 0-7
(CPUs 0-7,16-23, 52 GB) and the two heavy slots split CCD 1: cores 8-11
(8-11,24-27) and 12-15 (12-15,28-31), 30 GB each. Every core is pinned; about
13 GB stays with the system and Docker. [`hosts/epyc-4545p-3heavy.env`](../infra/runners/hosts/epyc-4545p-3heavy.env)
is the other EPYC layout: three heavy slots (cores 0-3, 4-7, 8-11), 32 GB each.

The routing probe (`runner-route.yml`) caps how many jobs it sends to each
pool with GitHub Actions variables (repository overrides organization), so a
new host only adds capacity once its variable is raised:

| Variable | Default | Pool |
|---|---|---|
| `CI_LINUX_HEAVY_SLOTS` | 2 | heavy |
| `CI_LINUX_XL_SLOTS` | 0 (xl off) | xl |
| `CI_LINUX_SMALL_SLOTS` | 6 | small |
| `CI_LINUX_RUNNER_DISABLED` | unset | `true` sends every job, xl included, to hosted runners |

Each slot runs one job in a fresh Docker container, then starts another. Everything needed to
rebuild them lives in [`infra/runners/`](../infra/runners/).

```
github-runner@<pool>-<n>.service ─ supervisor.sh <pool>-<n> ─┬─ GitHub API: JIT registration (one job)
                                                            ├─ docker run intent-gh-runner:current
                                                            │    └─ actions runner ─ job ─ exits
                                                            └─ job stats (cgroup samples, disk) ─ container removed
```

| File | Installed as | Role |
|---|---|---|
| `Dockerfile`, `entrypoint.sh` | image `intent-gh-runner:current` | One image for both pools: Ubuntu 24.04, build tools, pinned and checksummed runner, rustup, gh, Node and PowerShell; Rust toolchain baked; user `runner` (uid 1001); no sudo |
| `supervisor.sh` | `/usr/local/lib/github-runners/` | One slot, one job: JIT-register, run the pinned container, drain on stop, deregister; `--plan` validates the config and lists the slots; `--host-check` checks the CPU sets against the host's cores |
| `runners.env` | `/etc/github-runners/runners.env` (once) | intent-cache's pools, slot counts, labels, CPU sets, memory (not secret) |
| `hosts/*.env` | `/etc/github-runners/runners.env` (once, `install.sh --config`) | The same for runner-only hosts, one file per layout |
| `github-runner@.service` | `/etc/systemd/system/` | One instance per slot (`heavy-1`, `small-3`, …); restarts the supervisor after every job |
| `runners.slice` | `/etc/systemd/system/` | Parent cgroup of the containers at the cgroup root: CPU and IO weight 10 (`system.slice`: 100); `runners.slice.d/memory.conf` caps it at the host's RAM minus 9 GiB (116G on a 128 GB box) |
| `cache-priority.conf` | `/etc/systemd/system/{caddy,sccache-webdav}.service.d/runners-priority.conf` | CPU and IO weight 1000 for the cache services (skipped where a service is not installed) |
| `egress.sh`, `github-runners-egress.service` | `/usr/local/lib/github-runners/`, `/etc/systemd/system/` | Blocks containers from private, tailnet and link-local addresses |
| `daemon.json` | `/etc/docker/daemon.json` | User-namespace remapping, journald logs, no inter-container traffic, no-new-privileges, three public DNS resolvers |
| `install.sh` | — | Idempotent installer for all of the above and the slot count |
| `test_runners.py` | — | Supervisor and installer tests with stubbed system commands (monorepo CI `shell-tests`) |

Logs go to journald: `journalctl -u 'github-runner@*' -f` (supervisor and the
runner output, tagged `github-runner-<pool>-<n>`).

## Design

- **Ephemeral.** Every job gets a new just-in-time runner registration and a new
  container, removed when the job ends, so jobs never see another job's files. Nothing persists
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
  Docker's embedded DNS forwards container lookups to three public resolvers
  (1.1.1.1, 8.8.8.8, 9.9.9.9, set in `daemon.json`) rather than the host's
  single link resolver, so one resolver miss does not fail a job.
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
  before changing the sets on other hardware; the installer runs
  `supervisor.sh --host-check`, which refuses a slot whose CPUs do not exist or
  that splits a core with another slot. On the EPYC 4545P CPU *n* and *n*+16
  share a core. Job disk lives in the container layer on the
  root NVMe (`/var/lib/docker`), separate from the cache disk, and disappears
  with the container.
- **Labels.** `self-hosted`, `Linux`, `X64` (GitHub adds these itself) plus
  `intent-cache` (heavy), `intent-cache-xl` (xl) or `intent-cache-small`
  (small), whichever host the slot is on. Target a pool explicitly, e.g.
  `runs-on: [self-hosted, intent-cache-small]`. The
  `runner-route` probe also counts every online `self-hosted`/`Linux`/`X64`
  runner, from any pool, as Linux fleet capacity unless the variable
  `CI_LINUX_RUNNER_DISABLED` is `true`. A `gh-linux-16x` job takes a free xl
  slot first, then a free heavy slot, then goes hosted; a `gh-linux-8x` job
  never takes an xl slot.
- **Slot fitting.** The probe hands out at most as many slots per run as a
  pool has free: online slots (capped by the organization or repository
  variables `CI_LINUX_HEAVY_SLOTS` / `CI_LINUX_XL_SLOTS` /
  `CI_LINUX_SMALL_SLOTS`, defaults 2 / 0 / 6) minus jobs queued or running on
  that pool. A workflow lists the pooled jobs
  that start together (`slot_jobs` input of `runner-route.yml`, or `SLOT_JOBS`
  in an inline probe); each reads `outputs.slots[key]`. Free slots go to
  Rust-compiling jobs first (`"rust": true`, they reuse the slot's local
  cache), then the longest (`minutes`), then list order; `shards: N` or
  `legs: [a, b]` gives each matrix leg its own key (`key-1`..`key-N`, or
  `key-a`, `key-b`) and `events` keeps a job that skips the event from holding
  a slot. Every other listed job gets its hosted label, and unlisted jobs use
  the pool only while a slot is still free. Any unreadable runner list or job
  count sends every job hosted. `scripts/test_runner_policy.py` fails a
  workflow whose unlisted pooled jobs (or matrix legs) can run at the same
  time, so they must be listed.
  Two runs probing at the same moment can claim the same free slot, so a pool
  may briefly run a job or two past its slot count; that job waits for the
  next free slot.

## Preinstalled tools

Routed jobs call these without a setup step, as they would on GitHub-hosted
`ubuntu-24.04`: bash, git, git-lfs, curl, jq, gh, make, gcc/g++
(build-essential), bison/yacc, procps (ps, pgrep, pkill), iproute2 (ss), lsof, pkg-config, libssl-dev, shellcheck, tar, zip,
unzip, xz, zstd, rsync, file, dpkg-deb, python3 with pip and venv, Node with
npm and corepack (in `/opt/node`, owned by `runner`, so `corepack enable` and
`npm install -g` work without sudo), PowerShell (`pwsh`), and rustup with the
pinned Rust toolchain. Other versions of Node, Python and Rust come from the
usual setup actions. The apt package lists are kept, as on hosted runners, so
`apt-get install -s` (for example `playwright install-deps --dry-run`) works.
Core dumps are off (`--ulimit core=0:0`): the host's relative `core_pattern`
would otherwise write multi-GB core files into the checkout. Pins and checksums are the `ARG`s at the top of the
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
every fleet runner that is outside the group. Fleet runners are the ones named
`<prefix>-<pool>-<n>-<time>` where the prefix starts with `RUNNER_FLEET_PREFIX`
(`intent-`), so the check on any host covers every host. It never prints the
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
overwrites it; `--config FILE` seeds it from another file, such as one under
`hosts/`): `GITHUB_ORG`, `RUNNER_GROUP` (name, default `intent-cache`), `RUNNER_GROUP_REPOS`,
`RUNNER_NAME_PREFIX` (default `intent-cache`; unique per host),
`RUNNER_FLEET_PREFIX` (default `intent-`; every host's prefix starts with it), `RUNNER_POOLS`,
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
two unpinned, and keep the total memory under the `runners.slice` cap (the
host's RAM minus 9 GiB: 116G on a 128 GB box).

## Add a runner host

1. **Provision** an Ubuntu 24.04 box and pick its name (`intent-ci2`, …). Note
   its cores, threads and RAM, and read its SMT layout:
   `cat /sys/devices/system/cpu/cpu*/topology/thread_siblings_list`.
2. **Lock down SSH to Tailscale.** Join the tailnet (`tailscale up --ssh`
   with a tagged auth key), then close public SSH: `apt-get install -y ufw`
   (a minimal image may not ship it), `ufw default deny incoming`,
   `ufw allow in on tailscale0 to any port 22 proto tcp`, `ufw enable`, and confirm
   `ssh root@<host>` works over the tailnet before ending the provider's
   console session. Runner jobs never reach the tailnet (the egress filter
   drops 100.64/10).
3. **Write its config.** Copy the closest file in `infra/runners/hosts/`, set
   `RUNNER_NAME_PREFIX` to the host's name (it must start with `intent-` and be
   unique in the fleet), and fit the CPU sets and memory to the host: whole
   cores per multi-CPU slot, a few cores unpinned, total memory under the
   host's RAM minus 9 GiB. Check it with
   `RUNNERS_CONFIG=<file> infra/runners/supervisor.sh --plan`, add a test case
   in `test_runners.py` if it is a new layout, and land it with a row in the
   fleet table above.
4. **Place the credential** at `/etc/github-runners/credentials` (see
   Credential). Each host may use the same App or token; slots on every host
   register into the `intent-cache` group.
5. **Install:**

   ```bash
   scp -r infra/runners root@<host>:/root/infra/
   ssh root@<host> /root/infra/runners/install.sh --config /root/infra/runners/hosts/<host>.env
   ```

   On a host without the cache services the installer skips their drop-ins.
   It runs `supervisor.sh --host-check` and changes no slot if the CPU sets do
   not fit the host.
6. **Smoke test.** Run `supervisor.sh --group-check` (every fleet runner in the
   group), then dispatch the
   [smoke workflow](../.github/workflows/intent-cache-smoke.yml)
   (`gh workflow run intent-cache-smoke.yml --repo intent-hq/intent`, plus
   `-f xl=true` for a host with an xl slot) and check
   `journalctl -u 'github-runner@*'` on the new host shows it ran jobs. The
   smoke checks each pool's memory against a range that covers every host
   config (heavy: 32-48 GiB); a new per-slot size needs the range widened.
7. **Route jobs to it** by raising `CI_LINUX_HEAVY_SLOTS` / `CI_LINUX_XL_SLOTS`
   to the fleet's total slots per pool (see the variables above).

## Job stats

Every slot records what each job used, so job sizes can follow evidence. While
the job runs, the supervisor samples the container's cgroup about every 2
seconds (`cpu.stat` `usage_usec` deltas give busy cores; a sample is a few file
reads with no fork beyond `sleep`, far under 1% of a CPU). When the container
exits, it measures the container's disk (`docker container inspect --size`),
removes the container, and writes one JSON line (format `v: 1`) to the journal
(`job stats: ...`) and to `/var/lib/github-runners/job-stats.jsonl` (directory
0750, file 0640, root). That file rotates at 10 MB to `.1` ... `.4`.

```bash
/usr/local/lib/github-runners/supervisor.sh --job-stats                     # every line, oldest first
/usr/local/lib/github-runners/supervisor.sh --job-stats --since 2026-10-21  # ended at or after
journalctl -u 'github-runner@*' -g 'job stats' --since today
```

| Field | Meaning |
|---|---|
| `host`, `pool`, `slot`, `runner_name` | Where it ran; `runner_name` matches `runner_name` in the Actions jobs API |
| `slot_cpus`, `slot_memory_bytes` | The slot's CPU set size and memory limit |
| `started_at`, `ended_at`, `wall_s` | Container start and exit (UTC) |
| `cpu_s` | CPU seconds used by the container |
| `cores_avg`, `cores_p50`, `cores_p95`, `cores_max` | Busy cores: `cpu_s / wall_s`, and percentiles over the 2-second samples |
| `saturation` | Share of samples at 0.9 × `slot_cpus` or more |
| `mem_peak_bytes`, `pids_peak` | `memory.peak` and `pids.peak` (the highest sampled `*.current` on kernels without them). `memory.peak` counts page cache, so an IO-heavy job can reach the slot limit here without needing that memory |
| `mem_work_peak_bytes` | Highest sampled working memory: `memory.stat` `anon + shmem + kernel` (on kernels without `kernel`, the sum of `kernel_stack`, `pagetables`, `sec_pagetables`, `percpu`, `vmalloc` and `slab`). Leaves out reclaimable page cache, so it is the figure to size `slot_memory_bytes` from |
| `mem_file_peak_bytes` | Highest sampled `memory.stat` `file`: page cache, including `shmem` (tmpfs) |
| `mem_pressure_some_avg10_max` | Highest sampled `memory.pressure` `some avg10`: the percentage of the last 10 seconds in which some task stalled waiting for memory (reclaim or swap). Near 0 means cache filled the slot harmlessly; sustained high values mean the limit is slowing the job |
| `disk_bytes` | The container's writable layer at exit (checkout, build output); null if it could not be measured |
| `io_read_bytes`, `io_write_bytes` | Block IO from `io.stat` |
| `oom_kills` | `memory.events` `oom_kill`, at least 1 if Docker reports the container OOM-killed |
| `exit_code`, `samples` | The container's exit status; number of 2-second intervals measured |

Only resource figures are recorded: never environment variables, tokens or
command lines. Measured fields are null when the cgroup was never sampled (a
container that failed to start); `mem_work_peak_bytes`, `mem_file_peak_bytes`
and `mem_pressure_some_avg10_max` are also null on a kernel without
`memory.stat` or `memory.pressure` (PSI disabled). These three were added
without changing `v`, so lines written before them lack the keys, and readers
should treat a missing key like null. The percentiles and `saturation` are
null for a job shorter than one interval. Growth in the last 2 seconds before
exit can be missed, and so can a working-memory or pressure spike between two
samples (`memory.peak` is a kernel high-water mark and misses nothing). An idle runner stopped by a drain ran no job and writes no line.
The container is removed after the measurement and on every supervisor exit,
including a fatal signal; `ExecStopPost` and the next start remove it if the
supervisor is killed outright.

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
| Offline `<prefix>-<pool>-<n>-*` runners in the org list | Left by a crash or reboot; the slot deletes its own (same prefix and slot only) on its next start |
| `does not fit this host's CPUs` | `supervisor.sh --host-check` names the slot: a CPU the host lacks, or a slot that splits a core; fix the CPU sets for this host's `thread_siblings_list` |
| A job cannot reach a host | Private and tailnet addresses are blocked on purpose; `iptables -t raw -S GH-RUNNERS-EGRESS` lists them |
| Cache slow while jobs run | `cat /sys/fs/cgroup/runners.slice/cpu.weight` (10) and `/sys/fs/cgroup/system.slice/caddy.service/cpu.weight` (1000); fewer slots or smaller CPU sets |

Health at a glance:

```bash
systemctl status 'github-runner@*' github-runners-egress --no-pager
docker ps --format '{{.Names}} {{.Status}}'
systemd-cgtop -1 runners.slice
```
