# CI job sizing

`scripts/ci-job-sizes.py` recommends a runner size class for each CI job. It reads
the per-job resource stats the self-hosted runner slots record (see "Job stats" in
[GITHUB_RUNNERS.md](./GITHUB_RUNNERS.md)), matches each record to its GitHub Actions
job, and writes a markdown report plus one JSON size table per repository.
Standard library only; it needs `ssh` access to the runner hosts over Tailscale and
an authenticated `gh` that can read Actions runs (see "GitHub API use" below).

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
| `--max-api-calls N` | GitHub API call budget for this invocation (default 1000) |
| `--token TOKEN` | Token handed to `gh` as `GH_TOKEN` (default: the caller's `GH_TOKEN` or `gh` login). Prefer exporting `GH_TOKEN`: a command-line token shows in `ps` |
| `--cache-dir DIR`, `--no-cache` | Where completed runs' jobs are cached (default `$XDG_CACHE_HOME/ci-job-sizes`, else `~/.cache/ci-job-sizes`) |
| `--all-runs` | Read every run in the window, not only the runs a stats line can match (prices hosted-only jobs; costs far more calls) |

Each host is read with `ssh root@<host> /usr/local/lib/github-runners/supervisor.sh
--job-stats --since <since>`. An unreachable host is listed under "Collection
problems" and the report still renders.

## GitHub API use

The script shares the caller's 5000-calls-an-hour GitHub quota, so it reads as little
as it can:

- It lists only the runs created from two days before `--since` (so re-runs of older
  runs are found) to the end of the last stats line, one query per day, and stops
  paging when a day is exhausted. Listing costs one call per 100 runs.
- It reads a run's jobs (all attempts) only when the run was alive while a stats line's
  runner was, nearest start first, and stops as soon as that line's `runner_name` is
  found. One run usually matches several lines. A line with no match keeps trying
  overlapping runs until they run out or the budget does.
- A completed run's jobs never change, so they are cached on disk by run id and attempt.
  A second report over the same days reads almost no jobs; a re-run is a new attempt
  and is read again.
- It reads `/rate_limit` first (that call is free). It refuses to start when the token
  has fewer calls left than repositories to list, and lowers the budget to what is left.
  When the budget runs out, or GitHub answers with a rate-limit error, it stops and
  renders the partial report with a "stopped early" line under "Collection problems".
  It always prints `GitHub API calls used: N of B budget …` on stderr.

By default the paid-per-day column therefore counts only hosted jobs in runs that also
had a measured self-hosted job. Pass `--all-runs` to price every run in the window.

## How a job is sized

A job key is (repo, workflow, job name, matrix leg); the leg is the trailing
parenthesised part of the job name, so `Unit Tests (shard 1/4)` and `(shard 2/4)` are
sized separately. Only stats records that started inside the window are used. Every attempt is a separate run, and retries are counted. Cancelled
and skipped runs are not sized.

| Measure | Definition |
|---|---|
| Busy cores p90 / p95 | Percentiles, across runs, of each run's p95 busy CPUs |
| Saturation p90 | p90 of each run's share of samples at ≥ 90% of the slot's CPUs, also kept per slot size |
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

Saturation is judged per slot size: when a slot size's runs have p90 saturation above
0.3, the job needs the class above that slot's class, so a saturated 8-CPU heavy slot
means xl and a saturated 1-CPU small slot means at least medium. A job with fewer than 5 sized runs shows
**not enough samples** and no recommendation. Paid jobs with no stats at all (they only
ever ran hosted) are listed the same way, so expensive unmeasured jobs stay visible.

The monthly saving is 30 days of the job's paid hosted minutes repriced at the
recommended class's fallback (gh-linux-8x $0.022/min, gh-linux-16x $0.042/min, standard
runners free on the public repos). A negative saving means the job is undersized today.
Labels with no known price are listed and counted as $0.

Stats whose runner name matches no job are listed under "Unmatched stats" (the run was
deleted, belongs to a repo outside `--repos`, or the API budget ran out first).
