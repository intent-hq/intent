"""Fixture tests for scripts/ci-job-sizes.py. Never contacts GitHub or a runner host."""
from collections import Counter
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ci-job-sizes.py"
SPEC = importlib.util.spec_from_file_location("ci_job_sizes", SCRIPT)
sizes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sizes)

GIB = 1 << 30
SINCE = "2026-10-20T00:00:00Z"
UNTIL = "2026-10-22T00:00:00Z"  # a two-day window


def stat(runner, *, host="intent-ci1", pool="heavy", slot_cpus=8, cores=3.0, mem_gib=10.0,
         saturation=0.0, disk_gib=20.0, wall=600.0, cpu=2400.0, started="2026-10-21T10:00:00Z", **extra):
    record = {
        "v": 1, "host": host, "pool": pool, "slot": f"{pool}-1", "slot_cpus": slot_cpus,
        "slot_memory_bytes": 32 * GIB, "runner_name": runner, "started_at": started,
        "ended_at": "2026-10-21T10:10:00Z", "wall_s": wall, "cpu_s": cpu,
        "cores_avg": cores / 2, "cores_p50": cores / 2, "cores_p95": cores, "cores_max": cores,
        "saturation": saturation, "mem_peak_bytes": int(mem_gib * GIB), "pids_peak": 100,
        "disk_bytes": None if disk_gib is None else int(disk_gib * GIB),
        "io_read_bytes": 0, "io_write_bytes": 0, "oom_kills": 0, "exit_code": 0, "samples": 300,
    }
    record.update(extra)
    return record


JOB_IDS = iter(range(1000, 100000))


def job(runner, name, *, repo="intent-hq/intentd", workflow="CI", labels=("self-hosted", "intent-cache"),
        conclusion="success", attempt=1, started="2026-10-21T10:00:00Z", minutes=10.0):
    start = sizes.parse_time(started)
    end = start + sizes.timedelta(minutes=minutes)
    job_id = next(JOB_IDS)
    return {
        "id": job_id, "run_id": job_id // 10, "run_attempt": attempt, "name": name,
        "workflow_name": workflow, "labels": list(labels), "runner_name": runner,
        "conclusion": conclusion, "status": "completed",
        "started_at": sizes.iso(start), "completed_at": sizes.iso(end),
        "html_url": f"https://github.com/{repo}/actions/runs/{job_id // 10}/job/{job_id}",
    }


def measured(prefix, count, name, *, stat_kw=None, job_kw=None):
    stats, jobs = [], []
    for index in range(count):
        runner = f"{prefix}-{index}"
        stats.append(stat(runner, **(stat_kw or {})))
        jobs.append(job(runner, name, **(job_kw or {})))
    return stats, jobs


def build(stats, jobs):
    return sizes.build_report(stats, jobs, sizes.parse_time(SINCE), sizes.parse_time(UNTIL))


def entry(report, repo, job_name, leg=None):
    found = [e for e in report["repos"][repo] if e["job"] == job_name and e["leg"] == leg]
    if len(found) != 1:
        raise AssertionError(f"{job_name} {leg}: {found}")
    return found[0]


class ClassifyTests(unittest.TestCase):
    def test_thresholds_come_from_one_table(self):
        self.assertEqual([c["name"] for c in sizes.SIZE_CLASSES], ["small", "medium", "heavy", "xl"])
        cases = [
            (1.4, 2.9, 0.0, 8, "small"),
            (1.5, 2.0, 0.0, 8, "medium"),   # small is strictly below 1.5 cores
            (1.0, 3.0, 0.0, 8, "medium"),   # and strictly below 3 GB
            (4.0, 14.0, 0.0, 8, "medium"),  # medium is inclusive
            (4.1, 1.0, 0.0, 8, "heavy"),
            (1.0, 14.5, 0.0, 8, "heavy"),
            (8.0, 32.0, 0.0, 8, "heavy"),
            (8.5, 1.0, 0.0, 16, "xl"),
            (1.0, 33.0, 0.0, 16, "xl"),
            (7.9, 10.0, 0.31, 8, "xl"),     # saturated on an 8-CPU slot
            (7.9, 10.0, 0.30, 8, "heavy"),  # at the limit is not saturated
            (0.9, 1.0, 0.5, 1, "medium"),   # saturated small slot needs the next class
            (15.0, 10.0, 0.9, 16, "xl"),    # nothing above xl
        ]
        for cores, mem, sat, slot_cpus, want in cases:
            with self.subTest(cores=cores, mem=mem, sat=sat, slot=slot_cpus):
                self.assertEqual(sizes.classify(cores, mem * GIB, {slot_cpus: sat})["name"], want)
        self.assertEqual(sizes.classify(1.0, GIB, {})["name"], "small")
        self.assertEqual(sizes.classify(1.0, GIB, {1: 0.9, 8: 0.31})["name"], "xl")

    def test_fallbacks_and_prices(self):
        by_name = {c["name"]: c["fallback"] for c in sizes.SIZE_CLASSES}
        self.assertEqual(by_name, {"small": "ubuntu-24.04", "medium": "ubuntu-24.04",
                                   "heavy": "gh-linux-8x", "xl": "gh-linux-16x"})
        self.assertEqual(sizes.price_per_minute(["gh-linux-8x"]), 0.022)
        self.assertEqual(sizes.price_per_minute(["gh-linux-16x"]), 0.042)
        self.assertEqual(sizes.price_per_minute(["ubuntu-24.04"]), 0.0)
        self.assertEqual(sizes.price_per_minute(["self-hosted", "intent-cache"]), 0.0)
        self.assertIsNone(sizes.price_per_minute(["gh-windows-16x"]))

    def test_percentile_is_nearest_rank(self):
        values = list(range(1, 21))
        self.assertEqual(sizes.percentile(values, 95), 19)
        self.assertEqual(sizes.percentile(values, 90), 18)
        self.assertEqual(sizes.percentile([7], 95), 7)
        self.assertIsNone(sizes.percentile([], 95))

    def test_job_name_splits_matrix_leg(self):
        self.assertEqual(sizes.split_job_name("Unit Tests (shard 2/4)"), ("Unit Tests", "shard 2/4"))
        self.assertEqual(sizes.split_job_name("build (ubuntu, x64)"), ("build", "ubuntu, x64"))
        self.assertEqual(sizes.split_job_name("check"), ("check", None))
        self.assertEqual(sizes.split_job_name("release / build (macos)"), ("release / build", "macos"))


class ReportTests(unittest.TestCase):
    def test_heavy_job_evidence(self):
        stats, jobs = measured("intent-ci1-heavy-1", 20, "check",
                               stat_kw={"cores": 6.0, "mem_gib": 20.0, "cpu": 2400.0, "wall": 600.0})
        stats[0]["cores_p95"] = 7.5
        stats[0]["disk_bytes"] = None
        report = build(stats, jobs)
        e = entry(report, "intent-hq/intentd", "check")
        self.assertEqual(e["class"], "heavy")
        self.assertEqual(e["fallback"], "gh-linux-8x")
        self.assertEqual(e["runs"], 20)
        self.assertEqual(e["cores_p90"], 6.0)
        self.assertEqual(e["cores_p95"], 6.0)
        self.assertAlmostEqual(e["mem_p95_gib"], 20.0, places=2)
        self.assertAlmostEqual(e["disk_p95_gib"], 20.0, places=2)
        self.assertAlmostEqual(e["cpu_efficiency"], 0.5)  # 2400 / (600 * 8)
        self.assertEqual(e["current_label"], "intent-cache")
        self.assertEqual(e["workflow"], "CI")
        self.assertEqual(e["runs_per_day"], 10.0)
        self.assertEqual(e["paid_per_day"], 0.0)  # every run was self-hosted

    def test_matrix_legs_are_separate_keys(self):
        stats_a, jobs_a = measured("a", 5, "Unit Tests (shard 1/2)", stat_kw={"cores": 1.0, "mem_gib": 1.0},
                                   job_kw={"repo": "intent-hq/cloudlands-fe"})
        stats_b, jobs_b = measured("b", 5, "Unit Tests (shard 2/2)", stat_kw={"cores": 6.0, "mem_gib": 1.0},
                                   job_kw={"repo": "intent-hq/cloudlands-fe"})
        report = build(stats_a + stats_b, jobs_a + jobs_b)
        self.assertEqual(entry(report, "intent-hq/cloudlands-fe", "Unit Tests", "shard 1/2")["class"], "small")
        self.assertEqual(entry(report, "intent-hq/cloudlands-fe", "Unit Tests", "shard 2/2")["class"], "heavy")

    def test_retried_jobs_count_each_attempt(self):
        stats, jobs = measured("r", 4, "check")
        retry_stat = stat("r-retry")
        retry_job = job("r-retry", "check", attempt=2, conclusion="success")
        report = build(stats + [retry_stat], jobs + [retry_job])
        e = entry(report, "intent-hq/intentd", "check")
        self.assertEqual(e["runs"], 5)
        self.assertEqual(e["retries"], 1)
        self.assertEqual(e["class"], "medium")

    def test_cancelled_runs_are_not_sized(self):
        stats, jobs = measured("c", 5, "check")
        jobs[0]["conclusion"] = "cancelled"
        e = entry(build(stats, jobs), "intent-hq/intentd", "check")
        self.assertEqual(e["runs"], 4)
        self.assertEqual(e["class"], sizes.INSUFFICIENT)

    def test_runner_name_reuse_picks_closest_start(self):
        stats = [stat("dup", started="2026-10-21T12:00:00Z", cores=6.0)]
        jobs = [job("dup", "old", started="2026-10-20T01:00:00Z"),
                job("dup", "new", started="2026-10-21T12:00:20Z")]
        report = build(stats, jobs)
        self.assertEqual(entry(report, "intent-hq/intentd", "new")["runs"], 1)
        self.assertEqual([e["job"] for e in report["repos"]["intent-hq/intentd"]], ["new"])
        self.assertEqual(report["unmatched"], [])

    def test_missing_jobs_are_reported_unmatched(self):
        stats, jobs = measured("m", 5, "check")
        stats.append(stat("ghost-runner", host="intent-cache"))
        report = build(stats, jobs)
        self.assertEqual(report["unmatched"], [{"host": "intent-cache", "runner_name": "ghost-runner",
                                                "started_at": "2026-10-21T10:00:00Z"}])
        self.assertEqual(entry(report, "intent-hq/intentd", "check")["runs"], 5)

    def test_not_enough_samples(self):
        stats, jobs = measured("few", 4, "lint", stat_kw={"cores": 7.0})
        e = entry(build(stats, jobs), "intent-hq/intentd", "lint")
        self.assertEqual(e["class"], sizes.INSUFFICIENT)
        self.assertIsNone(e["monthly_saving"])
        self.assertEqual(e["runs"], 4)

    def test_paid_hosted_spill_drives_saving(self):
        stats, jobs = measured("s", 5, "Type Check & Lint", stat_kw={"cores": 1.0, "mem_gib": 2.0},
                               job_kw={"repo": "intent-hq/cloudlands-fe"})
        # Two spills to gh-linux-8x of 9.5 minutes each: billed as 10 minutes each.
        jobs += [job("GitHub Actions 7", "Type Check & Lint", repo="intent-hq/cloudlands-fe",
                     labels=("gh-linux-8x",), minutes=9.5) for _ in range(2)]
        e = entry(build(stats, jobs), "intent-hq/cloudlands-fe", "Type Check & Lint")
        self.assertEqual(e["class"], "small")
        self.assertAlmostEqual(e["paid_per_day"], 2 * 10 * 0.022 / 2)
        self.assertAlmostEqual(e["monthly_saving"], 2 * 10 * 0.022 / 2 * 30)
        self.assertEqual(e["runs_per_day"], 3.5)

    def test_upsizing_shows_a_negative_saving(self):
        stats, jobs = measured("u", 5, "coverage", stat_kw={"cores": 7.9, "saturation": 0.6})
        jobs.append(job("GitHub Actions 9", "coverage", labels=("gh-linux-8x",), minutes=10))
        e = entry(build(stats, jobs), "intent-hq/intentd", "coverage")
        self.assertEqual(e["class"], "xl")
        self.assertAlmostEqual(e["monthly_saving"], 10 * (0.022 - 0.042) / 2 * 30)

    def test_unmeasured_paid_job_is_listed(self):
        jobs = [job("GitHub Actions 3", "coverage-all", labels=("gh-linux-16x",), minutes=30)]
        e = entry(build([], jobs), "intent-hq/intentd", "coverage-all")
        self.assertEqual(e["class"], sizes.INSUFFICIENT)
        self.assertEqual(e["runs"], 0)
        self.assertAlmostEqual(e["paid_per_day"], 30 * 0.042 / 2)

    def test_free_unmeasured_jobs_are_omitted(self):
        jobs = [job("GitHub Actions 3", "docs", labels=("ubuntu-24.04",))]
        self.assertEqual(build([], jobs)["repos"], {})

    def test_jobs_outside_the_window_are_ignored(self):
        stats, jobs = measured("w", 5, "check")
        jobs.append(job("GitHub Actions 1", "check", labels=("gh-linux-8x",), started="2026-10-01T00:00:00Z"))
        self.assertEqual(entry(build(stats, jobs), "intent-hq/intentd", "check")["paid_per_day"], 0.0)

    def test_markdown_and_json_render(self):
        stats, jobs = measured("x", 5, "check", stat_kw={"cores": 6.0})
        few_stats, few_jobs = measured("y", 2, "lint")
        stats.append(stat("lost"))
        report = build(stats + few_stats, jobs + few_jobs)
        report["errors"] = ["intent-cache: ssh exited 255"]
        markdown = sizes.render_markdown(report)
        self.assertIn("## intent-hq/intentd", markdown)
        self.assertIn("| CI | check |", markdown)
        self.assertIn("not enough samples", markdown)
        self.assertIn("lost", markdown)
        self.assertIn("intent-cache: ssh exited 255", markdown)
        tables = sizes.render_json_tables(report)
        self.assertEqual(set(tables), {"intent-hq/intentd"})
        json.dumps(tables)
        row = [r for r in tables["intent-hq/intentd"]["jobs"] if r["job"] == "check"][0]
        self.assertEqual(row["class"], "heavy")
        self.assertIn("evidence", row)

    def test_markdown_escapes_pipes_in_names(self):
        stats, jobs = measured("p", 5, "a | b (x|y)", job_kw={"workflow": "W|1"})
        markdown = sizes.render_markdown(build(stats, jobs))
        self.assertIn("| W\\|1 | a \\| b | x\\|y |", markdown)

    def test_stats_outside_the_window_are_not_sized(self):
        old = "2026-10-01T10:00:00Z"
        stats, jobs = measured("old", 5, "check", stat_kw={"cores": 6.0, "started": old},
                               job_kw={"started": old})
        report = build(stats, jobs)
        self.assertEqual(report["repos"], {})
        self.assertEqual(report["unmatched"], [])
        # A late window boundary excludes later stats too.
        report = sizes.build_report(stats, jobs, sizes.parse_time("2026-09-01T00:00:00Z"),
                                    sizes.parse_time("2026-09-30T00:00:00Z"))
        self.assertEqual(report["repos"], {})

    def test_saturation_is_judged_per_slot_size(self):
        heavy_stats, heavy_jobs = measured("h", 6, "mixed", stat_kw={"cores": 1.0, "mem_gib": 1.0,
                                                                     "saturation": 0.0, "slot_cpus": 8})
        small_stats, small_jobs = measured("s", 5, "mixed", stat_kw={"cores": 0.95, "mem_gib": 1.0,
                                                                     "saturation": 0.8, "slot_cpus": 1,
                                                                     "pool": "small"})
        e = entry(build(heavy_stats + small_stats, heavy_jobs + small_jobs), "intent-hq/intentd", "mixed")
        self.assertEqual(e["class"], "medium")
        self.assertEqual(e["saturation_by_slot"], {"1": 0.8, "8": 0.0})


class InputTests(unittest.TestCase):
    def test_parse_stats_skips_bad_lines(self):
        lines = [json.dumps(stat("ok")), "", "not json", json.dumps({"v": 2, "runner_name": "future"})]
        records, problems = sizes.parse_stats(lines, source="intent-ci1")
        self.assertEqual([r["runner_name"] for r in records], ["ok"])
        self.assertEqual(len(problems), 2)

    def test_hosts_from_configs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hosts = root / "infra/runners/hosts"
            hosts.mkdir(parents=True)
            (root / "infra/runners/runners.env").write_text(
                "GITHUB_ORG=intent-hq\nRUNNER_GROUP_REPOS=intent,intentd\n")
            (hosts / "intent-ci1.env").write_text(
                "GITHUB_ORG=intent-hq\nRUNNER_NAME_PREFIX=intent-ci1\nRUNNER_GROUP_REPOS=intent,cloudlands-fe\n")
            (hosts / "intent-ci2.env").write_text("RUNNER_NAME_PREFIX=intent-ci2\n")
            # A layout template is named for its layout, not a host.
            (hosts / "epyc-3heavy.env").write_text("RUNNER_NAME_PREFIX=intent-runner-1\n")
            self.assertEqual(sizes.hosts_from_configs(root), ["intent-cache", "intent-ci1", "intent-ci2"])
            self.assertEqual(sizes.repos_from_configs(root),
                             ["intent-hq/cloudlands-fe", "intent-hq/intent", "intent-hq/intentd"])

    def test_live_configs_include_both_hosts(self):
        hosts = sizes.hosts_from_configs(ROOT)
        self.assertIn("intent-cache", hosts)
        self.assertIn("intent-ci1", hosts)

    def test_collect_stats_over_ssh(self):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            if argv[-5] == "root@down":
                return subprocess.CompletedProcess(argv, 255, "", "ssh: connect timed out\n")
            return subprocess.CompletedProcess(argv, 0, json.dumps(stat("h-1")) + "\n", "")

        records, errors = sizes.collect_stats(["up", "down"], "2026-10-20T00:00:00Z", run=fake_run)
        self.assertEqual([r["runner_name"] for r in records], ["h-1"])
        self.assertEqual(len(errors), 1)
        self.assertIn("down", errors[0])
        self.assertEqual(calls[0][-5:], ["root@up", sizes.SUPERVISOR, "--job-stats",
                                         "--since", "2026-10-20T00:00:00Z"])
        self.assertIn("BatchMode=yes", calls[0])


DAY = sizes.timedelta(days=1)
MINUTE = sizes.timedelta(minutes=1)
WINDOW_SINCE = sizes.parse_time("2026-10-16T00:00:00Z")
WINDOW_UNTIL = sizes.parse_time("2026-10-21T00:00:00Z")  # a five-day window


def done(argv, code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(argv, code, stdout, stderr)


class FakeGitHub:
    """Answers the `gh api` calls the script makes, from in-memory runs, and counts them."""

    def __init__(self, runs, jobs_by_run, remaining=5000, fail=None):
        self.runs, self.jobs_by_run, self.remaining, self.fail = runs, jobs_by_run, remaining, fail
        self.calls = Counter()
        self.argvs, self.envs = [], []

    def __call__(self, argv, **kwargs):
        self.argvs.append(argv)
        self.envs.append(kwargs.get("env"))
        if argv[:3] == ["gh", "api", "rate_limit"]:
            return done(argv, stdout=json.dumps({"limit": 5000, "remaining": self.remaining, "reset": 1792604061}))
        path = argv[4]
        params = dict(argv[i + 1].split("=", 1) for i, a in enumerate(argv) if a == "-f")
        page, per_page = int(params["page"]), int(params["per_page"])
        if self.fail:
            failure = self.fail(path, self.calls)
            if failure:
                self.calls["failed"] += 1
                return done(argv, 1, stderr=failure)
        if path.endswith("/actions/runs"):
            self.calls["list"] += 1
            repo = "/".join(path.split("/")[1:3])
            lo, hi = (sizes.parse_time(t) for t in params["created"].split(".."))
            found = sorted((r for r in self.runs if r["repository"] == repo
                            and lo <= sizes.parse_time(r["created_at"]) <= hi),
                           key=lambda r: r["created_at"], reverse=True)
            rows = [{k: r[k] for k in ("id", "status", "run_attempt", "created_at", "run_started_at", "updated_at")}
                    for r in found[(page - 1) * per_page:page * per_page]]
            return done(argv, stdout=json.dumps({"total": len(found), "runs": rows}) + "\n")
        self.calls["jobs"] += 1
        self.calls[f"jobs:{path.split('/')[5]}"] += 1
        jobs = self.jobs_by_run.get(int(path.split("/")[5]), [])
        rows = [dict(j) for j in jobs[(page - 1) * per_page:page * per_page]]
        return done(argv, stdout=json.dumps({"total": len(jobs), "jobs": rows}) + "\n")


def busy_repos(repos=("intent-hq/intentd", "intent-hq/cloudlands-fe"), every_minutes=10):
    """A run every `every_minutes` per repo from two days before the window to its end, each
    20 minutes long with one self-hosted job; the stats record a few of them on two hosts."""
    runs, jobs_by_run, run_id = [], {}, 5000
    moment = WINDOW_SINCE - 2 * DAY
    while moment < WINDOW_UNTIL:
        for offset, repo in enumerate(repos):
            run_id += 1
            created = moment + offset * every_minutes / 2 * MINUTE  # repos do not start runs in lockstep
            runs.append({"id": run_id, "repository": repo, "status": "completed", "run_attempt": 1,
                         "created_at": sizes.iso(created), "run_started_at": sizes.iso(created),
                         "updated_at": sizes.iso(created + 20 * MINUTE)})
            jobs_by_run[run_id] = [dict(job(f"busy-{run_id}", "check", repo=repo,
                                            started=sizes.iso(created + 2 * MINUTE), minutes=15), run_id=run_id)]
        moment += every_minutes * MINUTE
    return runs, jobs_by_run


def stats_for(runs, jobs_by_run, picks):
    """One stats line per picked run (host, index), for its self-hosted job."""
    records = []
    for host, index in picks:
        run = runs[index]
        start = sizes.parse_time(run["created_at"]) + MINUTE
        records.append(stat(jobs_by_run[run["id"]][0]["runner_name"], host=host, started=sizes.iso(start),
                            ended_at=sizes.iso(start + 17 * MINUTE)))
    return records


def listing_pages(api):
    return api.calls["list"]


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.runs, self.jobs_by_run = busy_repos()
        window_runs = [i for i, r in enumerate(self.runs) if sizes.parse_time(r["created_at"]) >= WINDOW_SINCE]
        # Ten stats lines on each host, spread over the five days.
        self.picks = [("intent-cache" if n % 2 else "intent-ci1", window_runs[n * 70 + 3]) for n in range(20)]
        self.stats = stats_for(self.runs, self.jobs_by_run, self.picks)
        self.cache = tempfile.TemporaryDirectory()
        self.addCleanup(self.cache.cleanup)

    def fetch(self, api, budget=1000, **kwargs):
        gh = sizes.GitHub(budget, run=api, sleep=lambda _: None)
        jobs, errors, counts = sizes.fetch_jobs(gh, ["intent-hq/intentd", "intent-hq/cloudlands-fe"], self.stats,
                                                WINDOW_SINCE, WINDOW_UNTIL, cache_dir=kwargs.pop("cache", self.cache.name),
                                                **kwargs)
        return gh, jobs, errors, counts

    def test_five_days_two_hosts_reads_only_the_runs_the_stats_need(self):
        api = FakeGitHub(self.runs, self.jobs_by_run)
        self.assertGreater(len(self.runs), 1500)  # what the old script read one by one
        gh, jobs, errors, counts = self.fetch(api)
        self.assertEqual(errors, [])
        self.assertLessEqual(api.calls["jobs"], len(self.stats))
        self.assertEqual(gh.calls, api.calls["jobs"] + listing_pages(api))
        # Listing: one query per day of the stats' span plus the re-run margin, two pages each, per repo.
        span_days = 2 + (sizes.parse_time(self.stats[-1]["ended_at"]) - sizes.parse_time(self.stats[0]["started_at"])).days
        self.assertLessEqual(listing_pages(api), 2 * 2 * (span_days + 2))
        report = sizes.build_report(self.stats, jobs, WINDOW_SINCE, WINDOW_UNTIL)
        self.assertEqual(report["matched"], 20)
        self.assertEqual(report["unmatched"], [])

    def test_runs_outside_every_stats_line_are_never_read(self):
        api = FakeGitHub(self.runs, self.jobs_by_run)
        self.stats.append(stat("ghost", started="2026-10-18T12:01:00Z", ended_at="2026-10-18T12:05:00Z"))
        self.fetch(api)
        ghost_start, ghost_end = sizes.parse_time("2026-10-18T12:01:00Z"), sizes.parse_time("2026-10-18T12:05:00Z")
        for run in self.runs:
            if api.calls[f"jobs:{run['id']}"]:
                overlaps_ghost = (sizes.parse_time(run["created_at"]) <= ghost_end
                                  and sizes.parse_time(run["updated_at"]) >= ghost_start)
                needed = any(run is self.runs[i] for _, i in self.picks)
                self.assertTrue(overlaps_ghost or needed, run["id"])

    def test_no_stats_in_the_window_makes_no_calls(self):
        api = FakeGitHub(self.runs, self.jobs_by_run)
        self.stats = [stat("old", started="2026-09-01T00:00:00Z")]
        gh, jobs, errors, _ = self.fetch(api)
        self.assertEqual((gh.calls, jobs, errors), (0, [], []))

    def test_a_cached_second_run_reads_no_jobs(self):
        first = FakeGitHub(self.runs, self.jobs_by_run)
        _, jobs_first, _, _ = self.fetch(first)
        self.assertGreater(first.calls["jobs"], 0)
        second = FakeGitHub(self.runs, self.jobs_by_run)
        gh, jobs_second, errors, counts = self.fetch(second)
        self.assertEqual(second.calls["jobs"], 0)
        self.assertEqual(gh.calls, listing_pages(second))
        self.assertEqual(counts["cache_hits"], counts["runs_fetched"])
        self.assertEqual(sorted(j["id"] for j in jobs_second), sorted(j["id"] for j in jobs_first))
        self.assertTrue(all(j["repository"] for j in jobs_second))

    def test_in_progress_runs_and_new_attempts_are_not_served_from_cache(self):
        run = self.runs[self.picks[0][1]]
        run["status"] = "in_progress"
        self.fetch(FakeGitHub(self.runs, self.jobs_by_run))
        again = FakeGitHub(self.runs, self.jobs_by_run)
        self.fetch(again)
        self.assertEqual(again.calls[f"jobs:{run['id']}"], 1)
        other = self.runs[self.picks[1][1]]
        other["run_attempt"] = 2  # re-run since it was cached
        third = FakeGitHub(self.runs, self.jobs_by_run)
        self.fetch(third)
        self.assertEqual(third.calls[f"jobs:{other['id']}"], 1)

    def test_budget_guard_stops_with_partial_results(self):
        api = FakeGitHub(self.runs, self.jobs_by_run)
        gh, jobs, errors, _ = self.fetch(api, budget=12)
        self.assertEqual(gh.calls, 12)
        self.assertEqual(sum(v for k, v in api.calls.items() if k in ("list", "jobs")), 12)
        self.assertEqual(len(errors), 1)
        self.assertIn("stopped early", errors[0])
        self.assertIn("API budget of 12 calls", errors[0])

    def test_rate_limit_errors_stop_at_once(self):
        api = FakeGitHub(self.runs, self.jobs_by_run,
                         fail=lambda path, calls: "gh: API rate limit exceeded for user ID 1. (HTTP 403)"
                         if "/jobs" in path else None)
        gh, _, errors, _ = self.fetch(api)
        self.assertEqual(api.calls["failed"], 1)  # no retries, no further runs
        self.assertIn("stopped early", errors[-1])
        self.assertIn("rate limit", errors[-1])

    def test_server_errors_are_retried_then_reported(self):
        failing = self.runs[self.picks[0][1]]["id"]
        attempts = Counter()

        def fail(path, calls):
            if "/jobs" in path and int(path.split("/")[5]) == failing:
                attempts[failing] += 1
                return "gh: Server Error (HTTP 502)"
            return None

        api = FakeGitHub(self.runs, self.jobs_by_run, fail=fail)
        _, _, errors, _ = self.fetch(api)
        self.assertEqual(attempts[failing], sizes.GH_ATTEMPTS)
        self.assertTrue(any(f"runs/{failing}/jobs" in e and "HTTP 502" in e for e in errors))

    def test_listing_failure_is_reported(self):
        api = FakeGitHub(self.runs, self.jobs_by_run,
                         fail=lambda path, calls: "HTTP 404: Not Found" if "cloudlands-fe" in path else None)
        _, jobs, errors, _ = self.fetch(api)
        self.assertTrue(any("intent-hq/cloudlands-fe: listing runs failed" in e for e in errors))
        self.assertTrue(jobs)

    def test_all_runs_reads_every_run_in_the_window(self):
        api = FakeGitHub(self.runs, self.jobs_by_run)
        _, jobs, _, counts = self.fetch(api, budget=5000, all_runs=True)
        in_window = [r for r in self.runs if sizes.parse_time(r["updated_at"]) >= WINDOW_SINCE]
        self.assertEqual(counts["runs_fetched"], len(in_window))

    def test_many_jobs_are_paged(self):
        run = self.runs[self.picks[0][1]]
        extra = [job(f"extra-{n}", "matrix", started=run["created_at"]) for n in range(150)]
        self.jobs_by_run[run["id"]] = extra + self.jobs_by_run[run["id"]]
        api = FakeGitHub(self.runs, self.jobs_by_run)
        _, jobs, _, _ = self.fetch(api)
        self.assertEqual(api.calls[f"jobs:{run['id']}"], 2)
        self.assertEqual(sum(1 for j in jobs if j["runner_name"].startswith("extra-")), 150)


class CliTests(unittest.TestCase):
    def test_from_file_writes_markdown_and_json(self):
        stats, jobs = measured("cli", 6, "check (linux)", stat_kw={"cores": 2.0, "mem_gib": 4.0})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stats.jsonl").write_text("".join(json.dumps(s) + "\n" for s in stats))
            (root / "jobs.json").write_text(json.dumps(jobs))
            out = root / "out"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = sizes.main(["--from-file", str(root / "stats.jsonl"), "--jobs-file", str(root / "jobs.json"),
                                   "--since", SINCE, "--until", UNTIL, "--out-dir", str(out)])
            self.assertEqual(code, 0)
            self.assertIn("| CI | check | linux | medium |", stdout.getvalue())
            self.assertTrue((out / "ci-job-sizes.md").is_file())
            table = json.loads((out / "intent-hq__intentd.json").read_text())
            self.assertEqual(table["repo"], "intent-hq/intentd")
            self.assertEqual(table["jobs"][0]["class"], "medium")

    def test_from_file_json_format(self):
        stats, jobs = measured("j", 5, "check")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stats.jsonl").write_text("".join(json.dumps(s) + "\n" for s in stats))
            (root / "jobs.json").write_text(json.dumps(jobs))
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                sizes.main(["--from-file", str(root / "stats.jsonl"), "--jobs-file", str(root / "jobs.json"),
                            "--since", SINCE, "--until", UNTIL, "--format", "json"])
            self.assertIn("intent-hq/intentd", json.loads(stdout.getvalue()))

    def api_main(self, api, *extra):
        runs, jobs_by_run = api.runs, api.jobs_by_run
        stats = stats_for(runs, jobs_by_run, [("intent-ci1", 700), ("intent-cache", 701)])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stats.jsonl"
            path.write_text("".join(json.dumps(s) + "\n" for s in stats))
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = sizes.main(["--from-file", str(path), "--repos", "intent-hq/intentd,intent-hq/cloudlands-fe",
                                   "--since", sizes.iso(WINDOW_SINCE), "--until", sizes.iso(WINDOW_UNTIL),
                                   "--cache-dir", str(Path(directory) / "cache"), *extra],
                                  run=api, sleep=lambda _: None)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_refuses_to_start_without_quota(self):
        api = FakeGitHub(*busy_repos(), remaining=1)
        code, stdout, stderr = self.api_main(api)
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("not starting", stderr)
        self.assertEqual(api.calls["list"] + api.calls["jobs"], 0)

    def test_budget_is_capped_by_the_quota_left_and_calls_are_printed(self):
        api = FakeGitHub(*busy_repos(), remaining=3)
        code, _, stderr = self.api_main(api)
        self.assertEqual(code, 0)
        self.assertIn("budget lowered to the 3 calls left", stderr)
        self.assertIn("GitHub API calls used: 3 of 3 budget", stderr)
        self.assertIn("stopped early", stderr)

    def test_reports_calls_used(self):
        api = FakeGitHub(*busy_repos())
        code, stdout, stderr = self.api_main(api, "--max-api-calls", "100")
        self.assertEqual(code, 0)
        used = api.calls["list"] + api.calls["jobs"]
        self.assertIn(f"GitHub API calls used: {used} of 100 budget", stderr)
        self.assertLessEqual(api.calls["jobs"], 2)
        self.assertIn("2 of 2 stats records in the window matched", stdout)

    def test_token_goes_to_gh_through_the_environment_only(self):
        api = FakeGitHub(*busy_repos())
        code, stdout, stderr = self.api_main(api, "--token", "ghp_secretvalue")
        self.assertEqual(code, 0)
        self.assertTrue(api.envs and all(env and env["GH_TOKEN"] == "ghp_secretvalue" for env in api.envs))
        self.assertFalse(any("ghp_secretvalue" in " ".join(argv) for argv in api.argvs))
        self.assertNotIn("ghp_secretvalue", stdout + stderr)
        plain = FakeGitHub(*busy_repos())
        self.api_main(plain)
        self.assertTrue(all(env is None for env in plain.envs))  # gh reads GH_TOKEN or its login itself

    def test_from_file_and_hosts_are_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "s.jsonl"
            path.write_text("")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
                sizes.main(["--from-file", str(path), "--hosts"])
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
