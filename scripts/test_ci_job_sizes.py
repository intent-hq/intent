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

    def test_fetch_jobs_uses_gh_and_tags_repo(self):
        seen = []

        def fake_run(argv, **kwargs):
            seen.append(argv)
            if any(a.endswith("/actions/runs") for a in argv):
                return subprocess.CompletedProcess(argv, 0, '{"id":11}\n{"id":12}\n', "")
            run_id = [a for a in argv if "/jobs" in a][0].split("/")[5]
            row = job(f"runner-{run_id}", "check")
            return subprocess.CompletedProcess(argv, 0, json.dumps(row) + "\n", "")

        jobs, errors = sizes.fetch_jobs(["intent-hq/intentd"], sizes.parse_time(SINCE), run=fake_run)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(j["runner_name"] for j in jobs), ["runner-11", "runner-12"])
        self.assertTrue(all(j["repository"] == "intent-hq/intentd" for j in jobs))
        self.assertTrue(all(a[0] == "gh" for a in seen))
        self.assertTrue(any("filter=all" in " ".join(a) for a in seen))

    def test_fetch_jobs_retries_server_errors_then_reports(self):
        attempts = Counter()
        sleeps = []

        def fake_run(argv, **kwargs):
            if any(a.endswith("/actions/runs") for a in argv):
                return subprocess.CompletedProcess(argv, 0, '{"id":21}\n{"id":22}\n', "")
            path = [a for a in argv if "/jobs" in a][0]
            run_id = path.split("/")[5]
            attempts[run_id] += 1
            if run_id == "22" or attempts[run_id] < 3:
                return subprocess.CompletedProcess(argv, 1, "", "gh: Server Error (HTTP 502)\n")
            return subprocess.CompletedProcess(argv, 0, json.dumps(job("runner-21", "check")) + "\n", "")

        jobs, errors = sizes.fetch_jobs(["intent-hq/intentd"], sizes.parse_time(SINCE),
                                        run=fake_run, sleep=sleeps.append)
        self.assertEqual([j["runner_name"] for j in jobs], ["runner-21"])
        self.assertEqual(attempts, {"21": 3, "22": sizes.GH_ATTEMPTS})
        self.assertEqual(len(errors), 1)
        self.assertIn("runs/22/jobs", errors[0])
        self.assertIn("HTTP 502", errors[0])
        self.assertTrue(sleeps)

    def test_listing_runs_failure_is_reported(self):
        def fake_run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, "", "HTTP 404: Not Found\n")

        jobs, errors = sizes.fetch_jobs(["intent-hq/nope"], sizes.parse_time(SINCE),
                                        run=fake_run, sleep=lambda _: None)
        self.assertEqual(jobs, [])
        self.assertIn("intent-hq/nope", errors[0])


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
