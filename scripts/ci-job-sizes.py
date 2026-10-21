#!/usr/bin/env python3
"""Recommend a runner size class for each CI job from the self-hosted job stats.

Reads the per-job resource stats every runner host records
(`supervisor.sh --job-stats`, JSON Lines, contract v1), matches each record's
runner_name to its GitHub Actions job (repo, workflow, job name, matrix leg,
conclusion), and prints a markdown report plus one JSON size table per repo.

  scripts/ci-job-sizes.py --since 2026-10-16T00:00:00Z            # SSH every host
  scripts/ci-job-sizes.py --hosts intent-ci1 --save-stats s.jsonl
  scripts/ci-job-sizes.py --from-file s.jsonl --jobs-file jobs.json --out-dir out

Hosts are `intent-cache` plus every infra/runners/hosts/<host>.env whose
RUNNER_NAME_PREFIX equals <host> (layout templates are skipped), reached as
`ssh root@<host>` over Tailscale. Jobs come from `gh api` (Actions runs and
jobs, all attempts) unless --jobs-file is given. Standard library only.
See docs/CI_JOB_SIZING.md.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SUPERVISOR = "/usr/local/lib/github-runners/supervisor.sh"
STATS_VERSION = 1
GIB = 1 << 30
MIN_RUNS = 5
SATURATED = 0.3  # p90 share of samples at >= 90% of the slot's CPUs
INSUFFICIENT = "not enough samples"
DAYS_PER_MONTH = 30
GH_ATTEMPTS = 4

# The size classes, smallest first. A job fits a class when its p90 busy cores
# and p95 peak memory are within the limits (strictly below for "small").
SIZE_CLASSES = [
    {"name": "small", "max_cores": 1.5, "max_mem_gib": 3, "strict": True, "fallback": "ubuntu-24.04"},
    {"name": "medium", "max_cores": 4, "max_mem_gib": 14, "strict": False, "fallback": "ubuntu-24.04"},
    {"name": "heavy", "max_cores": 8, "max_mem_gib": 32, "strict": False, "fallback": "gh-linux-8x"},
    {"name": "xl", "max_cores": math.inf, "max_mem_gib": math.inf, "strict": False, "fallback": "gh-linux-16x"},
]

# Hosted prices in USD per billed minute (public repos: standard runners are free).
PRICES = {"gh-linux-8x": 0.022, "gh-linux-16x": 0.042}
FREE_PREFIXES = ("ubuntu-", "windows-", "macos-")
GENERIC_LABELS = {"self-hosted", "linux", "x64", "Linux", "X64"}
NOT_SIZED = {"cancelled", "skipped"}


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def percentile(values, pct):
    """Nearest-rank percentile; None for no values."""
    ordered = sorted(v for v in values if v is not None)
    if not ordered:
        return None
    return ordered[max(0, math.ceil(pct / 100 * len(ordered)) - 1)]


def _fits(size, cores, mem_gib):
    if size["strict"]:
        return cores < size["max_cores"] and mem_gib < size["max_mem_gib"]
    return cores <= size["max_cores"] and mem_gib <= size["max_mem_gib"]


def classify(cores, mem_bytes, saturation, slot_cpus):
    """The smallest class that fits; a saturated slot needs the class above the slot's own."""
    mem_gib = mem_bytes / GIB
    index = next(i for i, size in enumerate(SIZE_CLASSES) if _fits(size, cores, mem_gib))
    if saturation is not None and saturation > SATURATED and slot_cpus:
        slot_index = next(i for i, size in enumerate(SIZE_CLASSES) if slot_cpus <= size["max_cores"])
        index = max(index, min(slot_index + 1, len(SIZE_CLASSES) - 1))
    return SIZE_CLASSES[index]


def price_per_minute(labels):
    """Hosted price of a job's labels: 0 for self-hosted or standard runners, None if unknown."""
    for label in labels:
        if label in PRICES:
            return PRICES[label]
    if "self-hosted" in labels or any(label.startswith(FREE_PREFIXES) for label in labels):
        return 0.0
    return None


def current_label(labels):
    specific = [label for label in labels if label not in GENERIC_LABELS]
    return ",".join(specific or labels) or "?"


def split_job_name(name):
    """'Unit Tests (shard 1/4)' -> ('Unit Tests', 'shard 1/4'); the leg is the trailing parentheses."""
    match = re.fullmatch(r"(.*?)\s*\(([^()]*)\)", name)
    if match and match.group(1):
        return match.group(1), match.group(2)
    return name, None


def job_repo(job):
    if job.get("repository"):
        return job["repository"]
    parts = (job.get("html_url") or "").split("/")
    return "/".join(parts[3:5]) if len(parts) > 4 else "?"


def job_minutes(job):
    if not job.get("started_at") or not job.get("completed_at"):
        return 0.0
    seconds = (parse_time(job["completed_at"]) - parse_time(job["started_at"])).total_seconds()
    return max(0.0, seconds / 60)


# ---- inputs -----------------------------------------------------------------

def _read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def _host_configs(root):
    configs = []
    default = root / "infra/runners/runners.env"
    if default.is_file():
        configs.append(("intent-cache", _read_env(default)))
    for path in sorted((root / "infra/runners/hosts").glob("*.env")):
        values = _read_env(path)
        if values.get("RUNNER_NAME_PREFIX") == path.stem:
            configs.append((path.stem, values))
    return configs


def hosts_from_configs(root=ROOT):
    """intent-cache plus each hosts/<host>.env named for its RUNNER_NAME_PREFIX."""
    hosts = ["intent-cache"]
    hosts += [name for name, _ in _host_configs(root) if name not in hosts]
    return hosts


def repos_from_configs(root=ROOT):
    repos = set()
    for _, values in _host_configs(root):
        org = values.get("GITHUB_ORG", "intent-hq")
        repos.update(f"{org}/{repo.strip()}" for repo in values.get("RUNNER_GROUP_REPOS", "").split(",") if repo.strip())
    return sorted(repos)


def parse_stats(lines, source):
    records, problems = [], []
    for number, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            problems.append(f"{source}:{number}: not JSON")
            continue
        if not isinstance(record, dict) or record.get("v") != STATS_VERSION or not record.get("runner_name"):
            problems.append(f"{source}:{number}: not a v{STATS_VERSION} job-stats record")
            continue
        records.append(record)
    return records, problems


def collect_stats(hosts, since, run=subprocess.run):
    """SSH each host for its job stats; an unreachable host becomes an error line, not a failure."""
    records, errors = [], []
    for host in hosts:
        argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", f"root@{host}",
                SUPERVISOR, "--job-stats", "--since", since]
        try:
            done = run(argv, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as error:
            errors.append(f"{host}: {error}")
            continue
        if done.returncode != 0:
            errors.append(f"{host}: ssh exited {done.returncode}: {done.stderr.strip()[:200]}")
            continue
        found, problems = parse_stats(done.stdout.splitlines(), host)
        records += found
        errors += problems
    return records, errors


def _gh_lines(argv, run, sleep):
    """Run `gh api`, retrying failures (GitHub returns transient 5xx); raise after GH_ATTEMPTS."""
    for attempt in range(1, GH_ATTEMPTS + 1):
        done = run(argv, capture_output=True, text=True, timeout=600)
        if done.returncode == 0:
            return [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
        if attempt < GH_ATTEMPTS:
            sleep(2 ** attempt)
    raise RuntimeError(f"{next(a for a in argv if a.startswith('repos/'))}: {done.stderr.strip()[:300]}")


def fetch_jobs(repos, since, run=subprocess.run, sleep=time.sleep):
    """Every job attempt of every run created since `since` (minus two days for re-runs of older runs).

    Returns (jobs, errors); a run whose jobs cannot be read is an error line, not a failure.
    """
    created = (since - timedelta(days=2)).strftime("%Y-%m-%d")
    jobs, errors = [], []
    for repo in repos:
        try:
            runs = _gh_lines(["gh", "api", "--paginate", "-X", "GET", f"repos/{repo}/actions/runs",
                              "-f", f"created=>={created}", "-f", "per_page=100",
                              "--jq", ".workflow_runs[] | {id} | tojson"], run, sleep)
        except RuntimeError as error:
            errors.append(f"{repo}: listing runs failed: {error}")
            continue

        def run_jobs(run_id, repo=repo):
            try:
                return _gh_lines(["gh", "api", "--paginate",
                                  f"repos/{repo}/actions/runs/{run_id}/jobs?filter=all&per_page=100",
                                  "--jq", ".jobs[] | tojson"], run, sleep), None
            except RuntimeError as error:
                return [], f"{repo}: {error}"

        with ThreadPoolExecutor(max_workers=8) as pool:
            for found, error in pool.map(run_jobs, [r["id"] for r in runs]):
                if error:
                    errors.append(error)
                for job in found:
                    job["repository"] = repo
                    jobs.append(job)
    return jobs, errors


# ---- report -----------------------------------------------------------------

def match_stats(stats, jobs):
    """Pair each stats record with its job by runner_name (closest start wins on reuse)."""
    by_runner = defaultdict(list)
    for job in jobs:
        if job.get("runner_name"):
            by_runner[job["runner_name"]].append(job)
    matched, unmatched = [], []
    for record in stats:
        candidates = by_runner.get(record["runner_name"])
        if not candidates:
            unmatched.append({"host": record.get("host"), "runner_name": record["runner_name"],
                              "started_at": record.get("started_at")})
            continue
        started = parse_time(record["started_at"]) if record.get("started_at") else None

        def distance(job):
            if started is None or not job.get("started_at"):
                return 0
            return abs((parse_time(job["started_at"]) - started).total_seconds())

        matched.append((record, min(candidates, key=distance)))
    return matched, unmatched


def job_key(job):
    name, leg = split_job_name(job.get("name") or "?")
    return job_repo(job), job.get("workflow_name") or "?", name, leg


def _round(value, places=2):
    return None if value is None else round(value, places)


def build_report(stats, jobs, since, until, errors=()):
    days = max((until - since).total_seconds() / 86400, 1 / 24)
    window_jobs = [j for j in jobs if j.get("started_at") and since <= parse_time(j["started_at"]) < until]
    matched, unmatched = match_stats(stats, jobs)

    samples = defaultdict(list)
    for record, job in matched:
        samples[job_key(job)].append((record, job))
    by_key = defaultdict(list)
    for job in window_jobs:
        if job.get("conclusion") != "skipped":
            by_key[job_key(job)].append(job)

    unpriced = set()
    repos = defaultdict(list)
    for key in sorted(set(samples) | set(by_key), key=lambda k: tuple(str(p) for p in k)):
        repo, workflow, name, leg = key
        api_jobs = by_key.get(key, [])
        sized = [(r, j) for r, j in samples.get(key, []) if j.get("conclusion") not in NOT_SIZED]
        records = [r for r, _ in sized]

        paid_cost = 0.0
        paid_jobs = []
        for job in api_jobs:
            price = price_per_minute(job.get("labels") or [])
            if price is None:
                unpriced.add(current_label(job.get("labels") or []))
            elif price > 0:
                billed = math.ceil(job_minutes(job))
                paid_cost += billed * price
                paid_jobs.append((billed, price))
        if not records and paid_cost == 0:
            continue  # free and unmeasured: nothing to size or save

        cores = [r.get("cores_p95") for r in records]
        mem95 = percentile([r.get("mem_peak_bytes") for r in records], 95)
        disk95 = percentile([r.get("disk_bytes") for r in records], 95)
        sats = [r.get("saturation") for r in records]
        wall_cpu = sum((r.get("wall_s") or 0) * (r.get("slot_cpus") or 0) for r in records)
        slot_cpus = Counter(r.get("slot_cpus") for r in records).most_common(1)[0][0] if records else None
        labels = Counter(current_label(j.get("labels") or []) for j in api_jobs or [j for _, j in sized])

        entry = {
            "repo": repo, "workflow": workflow, "job": name, "leg": leg,
            "runs": len(records),
            "retries": sum(1 for _, j in sized if (j.get("run_attempt") or 1) > 1),
            "conclusions": dict(Counter(j.get("conclusion") or "?" for _, j in samples.get(key, []))),
            "hosts": sorted({r.get("host") for r in records if r.get("host")}),
            "slot_cpus": slot_cpus,
            "cores_p90": _round(percentile(cores, 90)),
            "cores_p95": _round(percentile(cores, 95)),
            "saturation_p90": _round(percentile(sats, 90), 3),
            "mem_p95_gib": None if mem95 is None else _round(mem95 / GIB),
            "disk_p95_gib": None if disk95 is None else _round(disk95 / GIB),
            "cpu_efficiency": _round(sum(r.get("cpu_s") or 0 for r in records) / wall_cpu, 3) if wall_cpu else None,
            "oom_kills": sum(r.get("oom_kills") or 0 for r in records),
            "current_label": labels.most_common(1)[0][0] if labels else "?",
            "runs_per_day": _round(len(api_jobs) / days),
            "minutes_per_day": _round(sum(job_minutes(j) for j in api_jobs) / days, 1),
            "paid_per_day": _round(paid_cost / days, 4),
            "class": INSUFFICIENT, "fallback": None, "monthly_saving": None,
        }
        if len(records) >= MIN_RUNS and entry["cores_p90"] is not None and entry["mem_p95_gib"] is not None:
            size = classify(percentile(cores, 90), mem95, percentile(sats, 90), slot_cpus)
            fallback_price = price_per_minute([size["fallback"]]) or 0.0
            saving = sum(billed * (price - fallback_price) for billed, price in paid_jobs)
            entry.update({"class": size["name"], "fallback": size["fallback"],
                          "monthly_saving": _round(saving / days * DAYS_PER_MONTH)})
        repos[repo].append(entry)

    for entries in repos.values():
        entries.sort(key=lambda e: (-(e["paid_per_day"] or 0), -e["runs"], e["workflow"], e["job"], e["leg"] or ""))
    return {
        "since": iso(since), "until": iso(until), "days": round(days, 2),
        "stats_records": len(stats), "matched": len(matched),
        "repos": dict(sorted(repos.items())), "unmatched": unmatched,
        "unpriced_labels": sorted(unpriced), "errors": list(errors),
    }


def _fmt(value, suffix=""):
    return "—" if value is None else f"{value}{suffix}"


def _cell(text):
    return str(text).replace("|", "\\|")


def _money(value):
    return "—" if value is None else (f"-${-value:,.2f}" if value < 0 else f"${value:,.2f}")


def evidence(entry):
    if entry["runs"] == 0:
        return "no stats recorded"
    parts = [f"cores p90 {_fmt(entry['cores_p90'])}/p95 {_fmt(entry['cores_p95'])}",
             f"mem p95 {_fmt(entry['mem_p95_gib'])} GiB",
             f"saturation p90 {_fmt(entry['saturation_p90'])} on {_fmt(entry['slot_cpus'])} CPUs"]
    if entry["oom_kills"]:
        parts.append(f"{entry['oom_kills']} OOM kills")
    return "; ".join(parts)


def render_markdown(report):
    lines = [
        "# CI job sizes",
        "",
        f"Window {report['since']} → {report['until']} ({report['days']} days). "
        f"{report['matched']} of {report['stats_records']} stats records matched a job. "
        f"Classes need {MIN_RUNS}+ completed runs; cores are p90 of each run's p95 busy CPUs, "
        "memory is p95 of peak. Saving = 30 days of today's paid hosted minutes repriced at the "
        "recommended class's hosted fallback (negative = upsizing costs more).",
        "",
        "| Class | Busy cores (p90) | Peak memory (p95) | Hosted fallback |",
        "|---|---|---|---|",
    ]
    for size in SIZE_CLASSES:
        op = "<" if size["strict"] else "≤"
        cores = "any" if math.isinf(size["max_cores"]) else f"{op} {size['max_cores']}"
        mem = "any" if math.isinf(size["max_mem_gib"]) else f"{op} {size['max_mem_gib']} GiB"
        lines.append(f"| {size['name']} | {cores} | {mem} | {size['fallback']} |")
    lines.append(f"\nxl also takes any job with p90 saturation > {SATURATED} on a slot of 8 CPUs or fewer.")
    for repo, entries in report["repos"].items():
        lines += ["", f"## {repo}", "",
                  "| Workflow | Job | Leg | Class | Runs | Retries | Cores p90 | Cores p95 | Saturation p90 "
                  "| Mem p95 GiB | Disk p95 GiB | CPU eff. | Label | Runs/day | Paid/day | Saving/month |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for e in entries:
            lines.append(
                f"| {_cell(e['workflow'])} | {_cell(e['job'])} | {_cell(e['leg'] or '')} | {e['class']} | {e['runs']} | {e['retries']} "
                f"| {_fmt(e['cores_p90'])} | {_fmt(e['cores_p95'])} | {_fmt(e['saturation_p90'])} "
                f"| {_fmt(e['mem_p95_gib'])} | {_fmt(e['disk_p95_gib'])} | {_fmt(e['cpu_efficiency'])} "
                f"| {e['current_label']} | {_fmt(e['runs_per_day'])} | {_money(e['paid_per_day'])} "
                f"| {_money(e['monthly_saving'])} |")
        total = sum(e["monthly_saving"] or 0 for e in entries)
        lines.append(f"\nEstimated saving for {repo}: {_money(total)} a month.")
    if report["unmatched"]:
        lines += ["", f"## Unmatched stats ({len(report['unmatched'])})", "",
                  "No Actions job carries these runner names (deleted run, other repo, or outside the run window).", ""]
        lines += [f"- {u['host']}: {u['runner_name']} ({u['started_at']})" for u in report["unmatched"]]
    if report["unpriced_labels"]:
        lines += ["", "Unpriced labels (counted as $0): " + ", ".join(report["unpriced_labels"])]
    if report["errors"]:
        lines += ["", "## Collection problems", ""] + [f"- {e}" for e in report["errors"]]
    return "\n".join(lines) + "\n"


def render_json_tables(report):
    tables = {}
    for repo, entries in report["repos"].items():
        rows = [dict(e, evidence=evidence(e)) for e in entries]
        tables[repo] = {"repo": repo, "since": report["since"], "until": report["until"],
                        "min_runs": MIN_RUNS, "classes": SIZE_CLASSES_JSON, "jobs": rows}
    return tables


SIZE_CLASSES_JSON = [
    {k: (None if isinstance(v, float) and math.isinf(v) else v) for k, v in size.items()} for size in SIZE_CLASSES
]


# ---- CLI --------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--from-file", action="append", metavar="JSONL",
                        help="read saved job-stats JSON Lines instead of SSH (repeatable)")
    source.add_argument("--hosts", nargs="?", const="", metavar="H1,H2",
                        help="SSH-collect from these hosts (default: every configured host)")
    parser.add_argument("--jobs-file", metavar="JSON", help="saved Actions jobs (JSON array) instead of gh api")
    parser.add_argument("--repos", help="comma-separated owner/name (default: the runner group's repos)")
    parser.add_argument("--since", help="window start, ISO 8601 (default: 5 days ago)")
    parser.add_argument("--until", help="window end, ISO 8601 (default: now)")
    parser.add_argument("--save-stats", metavar="JSONL", help="write the collected stats here")
    parser.add_argument("--save-jobs", metavar="JSON", help="write the fetched jobs here")
    parser.add_argument("--out-dir", help="write ci-job-sizes.md and <owner>__<repo>.json here")
    parser.add_argument("--format", choices=["md", "json"], default="md", help="stdout format")
    args = parser.parse_args(argv)

    until = parse_time(args.until) if args.until else datetime.now(timezone.utc).replace(microsecond=0)
    since = parse_time(args.since) if args.since else until - timedelta(days=5)

    errors = []
    if args.from_file:
        stats = []
        for name in args.from_file:
            found, problems = parse_stats(Path(name).read_text().splitlines(), name)
            stats += found
            errors += problems
    else:
        hosts = [h for h in (args.hosts or "").split(",") if h] or hosts_from_configs()
        stats, errors = collect_stats(hosts, iso(since))
    if args.save_stats:
        Path(args.save_stats).write_text("".join(json.dumps(r) + "\n" for r in stats))

    if args.jobs_file:
        jobs = json.loads(Path(args.jobs_file).read_text())
    else:
        repos = [r for r in (args.repos or "").split(",") if r] or repos_from_configs()
        jobs, problems = fetch_jobs(repos, since)
        errors += problems
    if args.save_jobs:
        Path(args.save_jobs).write_text(json.dumps(jobs))

    report = build_report(stats, jobs, since, until, errors)
    markdown = render_markdown(report)
    tables = render_json_tables(report)
    if args.out_dir:
        out = Path(args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "ci-job-sizes.md").write_text(markdown)
        for repo, table in tables.items():
            (out / f"{repo.replace('/', '__')}.json").write_text(json.dumps(table, indent=2) + "\n")
    sys.stdout.write(json.dumps(tables, indent=2) + "\n" if args.format == "json" else markdown)
    for error in errors:
        print(f"warning: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
