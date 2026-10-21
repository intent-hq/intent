# CI job sizing

`scripts/ci-job-sizes.py` recommends a runner size class for each CI job. It reads
the per-job resource stats the self-hosted runner slots record (see "Job stats" in
[GITHUB_RUNNERS.md](./GITHUB_RUNNERS.md)), matches each record to its GitHub Actions
job, and writes a markdown report plus one JSON size table per repository.
Standard library only; it needs `ssh` access to the runner hosts over Tailscale and
an authenticated `gh` that can read Actions runs.

## Run it

```bash
# Collect from every host and the Actions API, last 5 days, keep the raw inputs.
scripts/ci-job-sizes.py --save-stats /tmp/stats.jsonl --save-jobs /tmp/jobs.json --out-dir /tmp/sizes

# Re-render offline from the saved inputs.
scripts/ci-job-sizes.py --from-file /tmp/stats.jsonl --jobs-file /tmp/jobs.json \
  --since 2026-10-16T00:00:00Z --until 2026-10-21T00:00:00Z --format json
```

| Option | Meaning |
|---|---|
| `--hosts [h1,h2]` | SSH-collect (the default). With no list: `intent-cache` plus each `infra/runners/hosts/<host>.env` whose `RUNNER_NAME_PREFIX` is `<host>`; layout templates are skipped |
| `--from-file JSONL` | Read saved job-stats lines instead (repeatable) |
| `--jobs-file JSON` | Read saved Actions jobs (a JSON array) instead of `gh api` |
| `--repos a/b,c/d` | Repositories to read jobs from (default: every `RUNNER_GROUP_REPOS`) |
| `--since`, `--until` | Window, ISO 8601 (default: the last 5 days) |
| `--out-dir DIR` | Write `ci-job-sizes.md` and `<owner>__<repo>.json` |
| `--format md\|json` | What goes to stdout |

Each host is read with `ssh root@<host> /usr/local/lib/github-runners/supervisor.sh
--job-stats --since <since>`. An unreachable host is listed under "Collection
problems" and the report still renders. Jobs come from every run created since two
days before `--since` (so re-runs of older runs are found), with all attempts.

## How a job is sized

A job key is (repo, workflow, job name, matrix leg); the leg is the trailing
parenthesised part of the job name, so `Unit Tests (shard 1/4)` and `(shard 2/4)` are
sized separately. Every attempt is a separate run, and retries are counted. Cancelled
and skipped runs are not sized.

| Measure | Definition |
|---|---|
| Busy cores p90 / p95 | Percentiles, across runs, of each run's p95 busy CPUs |
| Saturation p90 | p90 of each run's share of samples at ≥ 90% of the slot's CPUs |
| Memory p95, disk p95 | p95 of each run's peak memory and disk use (disk may be missing) |
| CPU efficiency | Σ CPU seconds ÷ Σ (wall seconds × slot CPUs) |
| Label | The most common runs-on label in the window |
| Paid per day | Billed hosted minutes (each job rounded up to a minute) × price, ÷ days |

The thresholds live in `SIZE_CLASSES` at the top of the script:

| Class | Busy cores (p90) | Peak memory (p95) | Hosted fallback |
|---|---|---|---|
| small | < 1.5 | < 3 GiB | ubuntu-24.04 (free) |
| medium | ≤ 4 | ≤ 14 GiB | ubuntu-24.04 (free) |
| heavy | ≤ 8 | ≤ 32 GiB | gh-linux-8x |
| xl | larger | larger | gh-linux-16x |

A job whose p90 saturation is above 0.3 needs the class above its slot's class, so a
saturated 8-CPU heavy slot means xl. A job with fewer than 5 sized runs shows
**not enough samples** and no recommendation. Paid jobs with no stats at all (they only
ever ran hosted) are listed the same way, so expensive unmeasured jobs stay visible.

The monthly saving is 30 days of the job's paid hosted minutes repriced at the
recommended class's fallback (gh-linux-8x $0.022/min, gh-linux-16x $0.042/min, standard
runners free on the public repos). A negative saving means the job is undersized today.
Labels with no known price are listed and counted as $0.

Stats whose runner name matches no job are listed under "Unmatched stats" (the run was
deleted, belongs to a repo outside `--repos`, or started outside the jobs window).
