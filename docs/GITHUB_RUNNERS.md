# GitHub runner slots runbook (intent-cache)

The `intent-cache` box (see [SCCACHE_SERVER.md](./SCCACHE_SERVER.md#the-box))
also runs org-wide GitHub Actions Linux runners for `intent-hq`. Each slot runs
one job in a fresh Docker container, then starts another. Everything needed to
rebuild them lives in [`infra/runners/`](../infra/runners/).

```
github-runner@N.service ─ supervisor.sh N ─┬─ GitHub API: JIT registration (one job)
                                           └─ docker run --rm intent-gh-runner:current
                                                └─ actions runner ─ job ─ exits ─ container removed
```

| File | Installed as | Role |
|---|---|---|
| `Dockerfile`, `entrypoint.sh` | image `intent-gh-runner:current` | Ubuntu 24.04, build tools, pinned runner and rustup (checksummed), Rust toolchain baked, user `runner` (uid 1001), no sudo |
| `supervisor.sh` | `/usr/local/lib/github-runners/` | One slot, one job: JIT-register, run the container, drain on stop, deregister |
| `github-runner@.service` | `/etc/systemd/system/` | One instance per slot; restarts the supervisor after every job |
| `github-runners.slice` | `/etc/systemd/system/` | Parent cgroup of the containers: CPU and IO weight 50 (cache services: 100), 100G cap |
| `egress.sh`, `github-runners-egress.service` | `/usr/local/lib/github-runners/`, `/etc/systemd/system/` | Blocks containers from private, tailnet and link-local addresses |
| `daemon.json` | `/etc/docker/daemon.json` | User-namespace remapping, journald logs, no inter-container traffic, no-new-privileges |
| `install.sh` | — | Idempotent installer for all of the above and the slot count |
| `test_runners.py` | — | Supervisor and installer tests with stubbed system commands (monorepo CI `shell-tests`) |

Logs go to journald: `journalctl -u 'github-runner@*' -f` (supervisor and the
runner output, tagged `github-runner-N`).

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
- **Limits per slot.** 8 CPUs, 48 GB memory (no swap), 16384 processes, 1 GB
  `/dev/shm`. Two slots leave 8 threads and about 30 GB for the cache and page
  cache. Job disk lives in the container layer on the root NVMe
  (`/var/lib/docker`), separate from the cache disk, and disappears with the
  container.
- **Labels.** `self-hosted`, `Linux`, `X64` (GitHub adds these itself) and
  `intent-cache`. Target them explicitly with
  `runs-on: [self-hosted, intent-cache]`. The `runner-route` probe also counts
  every online `self-hosted`/`Linux`/`X64` runner as Linux fleet capacity unless
  the repository variable `CI_LINUX_RUNNER_DISABLED` is `true`.

## Not supported in jobs

No `sudo` (install packages in the `Dockerfile` instead), no Docker
(`container:` jobs, service containers and Docker actions fail), no access to
private or tailnet addresses.

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
installer writes defaults once and never overwrites it): `GITHUB_ORG`,
`RUNNER_GROUP_ID` (1 = Default), `RUNNER_LABELS`, `RUNNER_CPUS`,
`RUNNER_MEMORY`, and optionally `RUNNER_PIDS` and `RUNNER_SHM`. Changes apply
from the next job.

## Add or remove slots

```bash
ssh root@intent-cache /root/infra/runners/install.sh --slots 3 --no-build
```

Lowering the count drains and disables the extra slots (highest numbers first);
`--slots 0` drains all. Keep `slots × RUNNER_CPUS` at or below 16 and
`slots × RUNNER_MEMORY` at or below 96 GB on this box, or lower the per-slot
limits.

## Drain and stop

```bash
systemctl stop github-runner@2          # one slot
systemctl stop 'github-runner@*'        # all slots
```

An idle slot deregisters and stops within seconds. A slot running a job waits
for that job (up to 6 hours, `TimeoutStopSec`), then exits; systemd kills
anything still running after that. A job assigned in the second between the
idle check and the stop fails and must be re-run. `systemctl start` brings a
slot back; `systemctl disable --now` keeps it off across reboots.

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
| Slot restarts every few seconds | `journalctl -u github-runner@1 -n 50`: credential missing or not 600, egress rules missing (`systemctl restart github-runners-egress`), image missing (re-run the installer) |
| `JIT registration failed (HTTP 401/403)` | The credential expired or lacks **Self-hosted runners: read and write** on the org |
| `JIT registration failed (HTTP 409/422)` | Name conflict or bad `RUNNER_GROUP_ID`/labels in `runners.env` |
| Jobs stay queued | `gh api orgs/intent-hq/actions/runners` (needs the same permission): runners online with the expected labels; the runner group allows the repository; `docker ps` shows `gh-runner-N` |
| Offline `intent-cache-N-*` runners in the org list | Left by a crash or reboot; the slot deletes its own on its next start |
| A job cannot reach a host | Private and tailnet addresses are blocked on purpose; `iptables -t raw -S GH-RUNNERS-EGRESS` lists them |
| Cache slow while jobs run | `systemctl show github-runners.slice -p CPUWeight,IOWeight`; lower `RUNNER_CPUS` or the slot count |

Health at a glance:

```bash
systemctl status 'github-runner@*' github-runners-egress --no-pager
docker ps --format '{{.Names}} {{.Status}}'
systemd-cgtop -1 github-runners.slice
```
