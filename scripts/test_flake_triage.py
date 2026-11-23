"""scripts/flake_triage.py (make flake-triage): three-way stress triage of a merge-queue ejection.

The pure parts (run URL, CI log, filterset, statistics, verdict) are tested
directly. The end-to-end tests drive the script against real git repositories
with stub `make` (a fake test-stress that fails as often as the checked-out
tree says) and stub `gh` on PATH.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("flake_triage", HERE / "flake_triage.py")
triage = importlib.util.module_from_spec(spec)
sys.modules["flake_triage"] = triage
spec.loader.exec_module(triage)

# gh run view --log-failed prints the escape byte of nextest's colors as the text "^[".
ESC = "^["


def ci_line(text, job="coverage-all"):
    """One `gh run view --log-failed` line: job, step, timestamp, then nextest's colored text."""
    return f"{job}\tUNKNOWN STEP\t2026-11-22T12:11:14.3541243Z {text}"


def colored(status, binary, path, name, counter="(12042/18563)", color="31;1"):
    return (f"{ESC}[{color}m{status}{ESC}[0m [   2.063s] {counter} {ESC}[35;1m{binary}{ESC}[0m "
            f"{ESC}[36m{path}{ESC}[0m{ESC}[36m::{ESC}[0m{ESC}[34;1m{name}{ESC}[0m")


# Shaped like intentd merge_group run 45019263209: a retried failure, a flaky
# test that passed on retry, the final summary repeating the failure, plus a
# second job.
FAILED_LOG = "\n".join([
    ci_line("  SCCACHE_IDLE_TIMEOUT: 0"),
    ci_line(colored("  TRY 1 FAIL", "intent-sourcecontrol", "gitlab_auth::tests", "observed_partial",
                    counter="(───────────)", color="35;1")),
    ci_line(colored("  TRY 1 FAIL", "intentd::bin/intentd", "executor::scripts::tests", "list_race",
                    counter="(───────────)", color="35;1")),
    ci_line(colored("  TRY 2 FAIL", "intent-sourcecontrol", "gitlab_auth::tests", "observed_partial")),
    ci_line(colored("  TRY 2 PASS", "intentd::bin/intentd", "executor::scripts::tests", "list_race",
                    color="32;1")),
    ci_line(colored("        PASS", "intent-acp", "error::classifier_tests", "denylist", color="32;1")),
    ci_line(f"{ESC}[31;1m     Summary{ESC}[0m [1142.489s] 18563 tests run: 18562 passed, 1 failed, 40 skipped"),
    ci_line(colored("   FLAKY 2/2", "intentd::bin/intentd", "executor::scripts::tests", "list_race")),
    ci_line(colored("  TRY 2 FAIL", "intent-sourcecontrol", "gitlab_auth::tests", "observed_partial")),
    ci_line(colored("     TIMEOUT", "intentd-sitter::supervisor_e2e", "", "start_waits")
            .replace(f"{ESC}[36m{ESC}[0m{ESC}[36m::{ESC}[0m", "").replace(ESC, "\x1b"), job="test (ubuntu)"),
    ci_line(f"{ESC}[31;1merror{ESC}[0m: test run failed"),
])


class RunUrlTests(unittest.TestCase):
    def test_run_job_and_attempt_urls(self):
        base = "https://github.com/intent-hq/intentd/actions/runs/45019263209"
        self.assertEqual(triage.parse_run_url(base), ("intent-hq/intentd", "45019263209", None, None))
        self.assertEqual(triage.parse_run_url(base + "/job/1234?pr=9"), ("intent-hq/intentd", "45019263209", "1234", None))
        self.assertEqual(triage.parse_run_url(base + "/attempts/2"), ("intent-hq/intentd", "45019263209", None, "2"))
        self.assertEqual(triage.parse_run_url("45019263209"), (None, "45019263209", None, None))

    def test_other_urls_are_refused(self):
        for url in ("https://github.com/intent-hq/intentd/pull/3560",
                    "https://example.com/intent-hq/intentd/actions/runs/1", "run 12", ""):
            with self.subTest(url=url), self.assertRaises(triage.TriageError):
                triage.parse_run_url(url)

    def test_queue_branch_names_the_pr(self):
        self.assertEqual(triage.queue_pr("gh-readonly-queue/main/pr-3560-206285df25a90042d445f3701035b1155e6cbcce"), 3560)
        self.assertIsNone(triage.queue_pr("feat/vercel-provider"))


class CiLogTests(unittest.TestCase):
    def test_final_failures_only_in_first_seen_order(self):
        self.assertEqual(triage.failing_tests(FAILED_LOG), [
            ("intent-sourcecontrol", "gitlab_auth::tests::observed_partial"),
            ("intentd-sitter::supervisor_e2e", "start_waits"),
        ], "a test that passed on retry (FLAKY) did not eject the PR")

    def test_no_failure_lines(self):
        self.assertEqual(triage.failing_tests(ci_line("error: could not compile `intentd`")), [])

    def test_filterset_pins_binary_and_exact_test_name(self):
        self.assertEqual(
            triage.filterset_for([("intentd::bin/intentd", "executor::tests::a"), ("intent-acp", "b")]),
            "(binary_id(=intentd::bin/intentd) & test(=executor::tests::a)) | (binary_id(=intent-acp) & test(=b))")


class StatisticsTests(unittest.TestCase):
    def test_one_sided_fisher(self):
        self.assertAlmostEqual(triage.p_worse(0, 100, 0, 100), 1.0)
        self.assertAlmostEqual(triage.p_worse(1, 200, 0, 200), 0.5)
        self.assertLess(triage.p_worse(5, 100, 0, 100), 0.05)
        self.assertGreater(triage.p_worse(3, 100, 0, 100), 0.05)
        self.assertGreater(triage.p_worse(0, 100, 5, 100), 0.99)


def ran(failed, runs=200):
    return triage.Cell("ran", runs, failed)


class VerdictTests(unittest.TestCase):
    def check(self, main, merged, pr, expected, note=None):
        verdict, notes = triage.verdict(main, merged, pr)
        self.assertEqual(verdict, expected)
        if note:
            self.assertIn(note, " ".join(notes))
        return notes

    def test_fails_on_main(self):
        # intentd#3560's script list race: 54/200 on main.
        self.check(ran(54), ran(60), ran(0), triage.FAILS_ON_MAIN)
        self.check(ran(1), ran(0), ran(0), triage.FAILS_ON_MAIN)

    def test_caused_by_this_pr(self):
        self.check(ran(0), ran(80), ran(75), triage.CAUSED_BY_PR)
        self.check(ran(1), ran(177), ran(170), triage.CAUSED_BY_PR, "main also fails 1/200")
        self.check(ran(0), ran(30), ran(0), triage.CAUSED_BY_PR, "only once merged with main")
        self.check(triage.Cell("absent"), ran(1), ran(1), triage.CAUSED_BY_PR, "not on main")

    def test_inconclusive(self):
        self.check(ran(0), ran(1), ran(0), triage.INCONCLUSIVE, "raise COUNT")
        self.check(ran(0), ran(0), ran(0), triage.INCONCLUSIVE, "LOAD=1")
        self.check(ran(0), ran(0), ran(40), triage.INCONCLUSIVE, "PR branch alone")
        self.check(triage.Cell("error", detail="exit 101"), ran(9), ran(9), triage.INCONCLUSIVE, "exit 101")
        self.check(ran(0), triage.Cell("invalid"), ran(9), triage.INCONCLUSIVE, "merged")
        self.check(triage.Cell("absent"), ran(0), ran(0), triage.INCONCLUSIVE)
        self.check(ran(3), triage.Cell("absent"), ran(3), triage.INCONCLUSIVE, "merged")

    def test_conflict_compares_the_pr_head(self):
        self.check(ran(0), triage.Cell("conflict"), ran(90), triage.CAUSED_BY_PR, "does not merge cleanly")
        self.check(ran(40), triage.Cell("conflict"), ran(45), triage.FAILS_ON_MAIN)


# Fake `make test-stress`: the checked-out tree's `flaky` file holds
# "<test name> <failures>" lines (failures out of COUNT); an `absent` file
# means the filter selects nothing; a `broken` file is a build failure.
MAKE_STUB = r'''#!/usr/bin/env python3
import json, os, subprocess, sys, uuid
args = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a and not a.startswith("-"))
tree = args["INTENTD_DIR"]
head = subprocess.run(["git", "-C", tree, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "head": head,
                          "makeflags": os.environ.get("MAKEFLAGS"), "level": os.environ.get("MAKELEVEL")}) + "\n")
print("[test-stress] testing intentd: " + tree)
if os.path.exists(os.path.join(tree, "broken")):
    print("error: could not compile", file=sys.stderr)
    sys.exit(101)
count = int(args.get("COUNT", "100"))
record = os.path.join(args["GATE_CACHE_DIR"], "stress", uuid.uuid4().hex)
os.makedirs(record)
by_test, failures, failed_iterations = {}, {}, 0
status = 0
if os.path.exists(os.path.join(tree, "absent")):
    status = 4
else:
    for line in open(os.path.join(tree, "flaky")).read().splitlines():
        name, failed = line.rsplit(" ", 1)
        by_test[name] = {"runs": count, "failed": int(failed)}
        failed_iterations = max(failed_iterations, int(failed))
        if int(failed):
            failures["src/lib.rs:7"] = failures.get("src/lib.rs:7", 0) + int(failed)
            status = 1
summary = {"iterations": 0 if status == 4 else count, "failed_iterations": failed_iterations,
           "by_test": by_test, "failures": failures, "stress_count": count, "exit_code": status,
           "load": args.get("LOAD") == "1", "stall": args.get("STALL") == "1"}
json.dump(summary, open(os.path.join(record, "summary.json"), "w"))
print(f"[test-stress] stress: {count}/{count} iterations")
print(f"[test-stress] record: {record}")
sys.exit(status)
'''

GH_STUB = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps({"gh": sys.argv[1:]}) + "\n")
if "--json" in sys.argv:
    print(json.dumps({"headBranch": os.environ["STUB_HEAD_BRANCH"], "event": "merge_group",
                      "headSha": "0" * 40, "url": "https://github.com/x/y/actions/runs/1"}))
elif "--log-failed" in sys.argv:
    sys.stdout.write(open(os.environ["STUB_FAILED_LOG"]).read())
else:
    sys.exit("unexpected gh call")
'''

TEST = "intentd::bin/intentd executor::scripts::tests::list_race"


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}).stdout.strip()


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp = Path(temporary.name)
        self.root = self.tmp / "reviewer's monorepo"
        (self.root / "scripts").mkdir(parents=True)
        self.origin = self.tmp / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        self.src = self.root / "packages/intentd"
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.src)], check=True, capture_output=True)
        git(self.src, "checkout", "-q", "-b", "main")
        self.cache = self.tmp / "gate-runs"
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, body in (("make", MAKE_STUB), ("gh", GH_STUB)):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.log = self.tmp / "stub.jsonl"

    def commit(self, files, message, branch="main", parent=None):
        if parent:
            git(self.src, "checkout", "-q", "-B", branch, parent)
        else:
            git(self.src, "checkout", "-q", "-B", branch)
        for name, text in files.items():
            path = self.src / name
            if text is None:
                path.unlink()
            else:
                path.write_text(text)
        git(self.src, "add", "-A")
        git(self.src, "commit", "-q", "-m", message)
        return git(self.src, "rev-parse", "HEAD")

    def push(self, *refspecs):
        git(self.src, "push", "-q", "--force", "origin", *refspecs)

    def triage(self, *args, env=None):
        environment = {k: v for k, v in os.environ.items() if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL"}}
        environment.update(PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}", STUB_LOG=str(self.log),
                           MAKEFLAGS=" -- E=stale", MAKELEVEL="1", **(env or {}))
        result = subprocess.run(
            [sys.executable, str(HERE / "flake_triage.py"), "--repo-root", str(self.root),
             "--intentd-dir", "packages/intentd", "--cache-dir", str(self.cache), *args],
            env=environment, text=True, capture_output=True, timeout=120)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        self.log.unlink(missing_ok=True)
        return result, calls

    def stress_calls(self, calls):
        return [call for call in calls if "argv" in call]

    def verdict_line(self, result):
        lines = [line for line in result.stdout.splitlines() if line.startswith("[flake-triage] verdict:")]
        self.assertEqual(len(lines), 1, result.stdout + result.stderr)
        return lines[0]

    def report(self, result):
        line = next(line for line in result.stdout.splitlines() if line.startswith("[flake-triage] report:"))
        directory = Path(line.split(": ", 1)[1])
        return json.loads((directory / "report.json").read_text()), (directory / "report.md").read_text()

    def test_flaky_on_main_with_a_pr_number(self):
        old = self.commit({"flaky": f"{TEST} 54\n", "a": "1"}, "base")
        pr = self.commit({"feature": "x"}, "feature", branch="feature", parent=old)
        main = self.commit({"a": "2"}, "newer main", parent=old)
        self.push("main", f"{pr}:refs/pull/7/head")
        git(self.src, "checkout", "-q", "--detach", old)
        result, calls = self.triage("--pr", "7", "--filterset", "test(=list_race)",
                                    "--stress-arg", "COUNT=200", "--stress-arg", "LOAD=1")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: fails on main")
        stress = self.stress_calls(calls)
        self.assertEqual(len(stress), 3)
        main_call, merged_call, pr_call = stress
        self.assertEqual(main_call["head"], main, "BASE defaults to the freshly fetched origin/main")
        self.assertEqual(pr_call["head"], pr)
        merged_parents = git(self.src, "rev-list", "--parents", "-n1", merged_call["head"]).split()[1:]
        self.assertEqual(merged_parents, [main, pr], "merged = main + PR head, as the merge queue tests it")
        for call in stress:
            argv = call["argv"]
            self.assertIn("test-stress", argv)
            self.assertIn("E=test(=list_race)", argv)
            self.assertIn("COUNT=200", argv)
            self.assertIn("LOAD=1", argv)
            self.assertIn(f"GATE_CACHE_DIR={self.cache}", argv)
            self.assertIsNone(call["makeflags"], "the outer make's variables must not leak into the stress run")
            self.assertIsNone(call["level"])
        trees = {Path(arg.split("=", 1)[1]) for call in stress for arg in call["argv"] if arg.startswith("INTENTD_DIR=")}
        self.assertEqual(len(trees), 3, "each revision runs in its own worktree")
        self.assertEqual(git(self.src, "rev-parse", "HEAD"), old, "the source checkout is left alone")
        report, markdown = self.report(result)
        self.assertEqual(report["verdict"], "fails on main")
        self.assertEqual(report["tests"][0]["test"], TEST)
        self.assertEqual([report["tests"][0]["cells"][r]["failed"] for r in ("main", "merged", "pr")], [54, 54, 54])
        self.assertIn("| main |", markdown)
        self.assertIn("54/200", result.stdout)
        self.assertIn("src/lib.rs:7", result.stdout, "the table names where the failures panicked")

        # A second run reuses the worktrees (warm builds), even one left mid-merge.
        merged_tree = next(Path(a.split("=", 1)[1]) for a in merged_call["argv"] if a.startswith("INTENTD_DIR="))
        (merged_tree / "stray").write_text("left over")
        result, calls = self.triage("--pr", "7", "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({Path(a.split("=", 1)[1]) for c in self.stress_calls(calls) for a in c["argv"]
                          if a.startswith("INTENTD_DIR=")}, trees)
        self.assertFalse((merged_tree / "stray").exists())

    def test_caused_by_pr_skips_a_revision_with_the_same_tree(self):
        main = self.commit({"flaky": f"{TEST} 0\n"}, "base")
        pr = self.commit({"flaky": f"{TEST} 80\n"}, "break it", branch="feature", parent=main)
        self.push("main", "feature")
        result, calls = self.triage("--branch", "feature", "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: caused by this PR")
        heads = [call["head"] for call in self.stress_calls(calls)]
        self.assertEqual(len(heads), 2, "the PR alone has the merged tree, so it is not stressed twice")
        self.assertEqual(heads[0], main)
        self.assertIn("same tree as merged", result.stdout)
        report, _ = self.report(result)
        self.assertEqual(report["revisions"]["pr"]["commit"], pr)

    def test_merge_conflict_compares_the_pr_head(self):
        old = self.commit({"flaky": f"{TEST} 0\n", "a": "1"}, "base")
        self.commit({"flaky": f"{TEST} 90\n", "a": "pr"}, "pr", branch="feature", parent=old)
        self.commit({"a": "main"}, "main", parent=old)
        self.push("main", "feature:refs/pull/9/head")
        result, calls = self.triage("--pr", "9", "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: caused by this PR")
        self.assertIn("does not merge cleanly", result.stdout)
        self.assertEqual(len(self.stress_calls(calls)), 2)
        # The conflicted worktree is clean for the next run.
        result, _ = self.triage("--pr", "9", "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_older_base_and_a_test_new_in_the_pr(self):
        old = self.commit({"absent": ""}, "before the test existed")
        self.commit({"absent": None, "flaky": f"{TEST} 0\n"}, "test lands")
        pr = self.commit({"absent": None, "flaky": f"{TEST} 3\n"}, "pr", branch="feature", parent=old)
        self.push("main", f"{pr}:refs/pull/4/head")
        result, calls = self.triage("--pr", "4", "--base", old, "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stress_calls(calls)[0]["head"], old, "BASE picks the main revision")
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: caused by this PR")
        self.assertIn("not on main", result.stdout)

    def test_build_failure_is_inconclusive_and_named(self):
        main = self.commit({"flaky": f"{TEST} 5\n", "broken": ""}, "base")
        self.commit({"x": "1"}, "pr", branch="feature", parent=main)
        self.push("main", "feature")
        result, _ = self.triage("--branch", "feature", "--filterset", "test(=list_race)")
        self.assertEqual(result.returncode, 1, "a run that did not complete fails the command")
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: inconclusive")
        self.assertIn("exit 101", result.stdout)

    def test_run_url_supplies_the_filter_and_the_pr(self):
        main = self.commit({"flaky": "intent-sourcecontrol gitlab_auth::tests::observed_partial 0\n"
                                     "intentd-sitter::supervisor_e2e start_waits 12\n"}, "base")
        pr = self.commit({"flaky": "intent-sourcecontrol gitlab_auth::tests::observed_partial 60\n"
                                   "intentd-sitter::supervisor_e2e start_waits 12\n"}, "pr",
                         branch="feature", parent=main)
        self.push("main", f"{pr}:refs/pull/3560/head")
        log = self.tmp / "failed.log"
        log.write_text(FAILED_LOG)
        result, calls = self.triage(
            "--run", "https://github.com/intent-hq/intentd/actions/runs/45019263209/attempts/2/job/77",
            env={"STUB_HEAD_BRANCH": f"gh-readonly-queue/main/pr-3560-{main}", "STUB_FAILED_LOG": str(log)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        gh_calls = [call["gh"] for call in calls if "gh" in call]
        log_call = next(call for call in gh_calls if "--log-failed" in call)
        for flag, value in (("--repo", "intent-hq/intentd"), ("--job", "77")):
            self.assertEqual(log_call[log_call.index(flag) + 1], value)
        self.assertNotIn("--attempt", log_call, "a job id already names one attempt")
        meta_call = next(call for call in gh_calls if "--json" in call)
        self.assertEqual(meta_call[meta_call.index("--attempt") + 1], "2")
        expected = ("E=(binary_id(=intent-sourcecontrol) & test(=gitlab_auth::tests::observed_partial)) | "
                    "(binary_id(=intentd-sitter::supervisor_e2e) & test(=start_waits))")
        for call in self.stress_calls(calls):
            self.assertIn(expected, call["argv"])
        self.assertIn("PR #3560", result.stdout)
        report, _ = self.report(result)
        self.assertEqual({t["test"]: t["verdict"] for t in report["tests"]}, {
            "intent-sourcecontrol gitlab_auth::tests::observed_partial": "caused by this PR",
            "intentd-sitter::supervisor_e2e start_waits": "fails on main",
        })
        self.assertEqual(self.verdict_line(result), "[flake-triage] verdict: caused by this PR")

    def test_usage_errors_before_any_work(self):
        self.commit({"flaky": f"{TEST} 0\n"}, "base")
        cases = ((("--pr", "7"), "E='<nextest filterset>' or RUN="),
                 (("--filterset", "test(=x)"), "PR=<number> or BRANCH="),
                 (("--filterset", "test(=x)", "--pr", "7", "--branch", "b"), "not both"),
                 (("--filterset", "test(=x)", "--pr", "x7"), "PR must be a number"),
                 (("--filterset", "test(=x)", "--pr", "7", "--stress-arg", "COUNT=0"), "COUNT"),
                 (("--filterset", "test(=x)", "--pr", "7", "--stress-arg", "INTENTD_DIR=/x"), "INTENTD_DIR"),
                 (("--run", "https://github.com/intent-hq/intentd/pull/3"), "run URL"))
        for args, message in cases:
            with self.subTest(args=args):
                result, calls = self.triage(*args)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(message, result.stderr)
                self.assertEqual(self.stress_calls(calls), [])

    def test_a_concurrent_triage_is_refused(self):
        main = self.commit({"flaky": f"{TEST} 0\n"}, "base")
        self.commit({"x": "1"}, "pr", branch="feature", parent=main)
        self.push("main", "feature")
        lock_path = triage.worktree_root(self.cache, self.src) / "lock"
        lock_path.parent.mkdir(parents=True)
        with open(lock_path, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result, calls = self.triage("--branch", "feature", "--filterset", "test(=x)")
        self.assertEqual(result.returncode, 2)
        self.assertIn("another make flake-triage", result.stderr)
        self.assertEqual(self.stress_calls(calls), [])


class MakeTargetTests(unittest.TestCase):
    """make flake-triage hands its variables to the script byte-for-byte, only from the make line."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "reviewer's checkout"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "packages/intentd/.git").mkdir(parents=True)
        (self.root / "Makefile").write_text((HERE.parent / "Makefile").read_text())
        self.log = Path(temporary.name) / "argv.json"
        (self.root / "scripts/flake_triage.py").write_text(textwrap.dedent(f"""\
            import json, os, sys
            json.dump({{"argv": sys.argv[1:], "E": os.environ.get("E"), "PR": os.environ.get("PR")}},
                      open({str(self.log)!r}, "w"))
            """))

    def run_make(self, *arguments, env=None):
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "E", "PR", "BRANCH", "RUN", "BASE", "COUNT",
                                    "LOAD", "STALL", "FEATURES", "GATE_CACHE_DIR"}}
        environment.update(env or {})
        result = subprocess.run(["make", "--no-print-directory", "flake-triage", *arguments],
                                cwd=self.root, env=environment, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(self.log.read_text())

    def value(self, argv, flag):
        return argv[argv.index(flag) + 1]

    def test_variables_reach_the_script(self):
        expression = "test(/it's a $/) | test(=a  b)"
        call = self.run_make(f"E={expression}", "PR=3560", "BASE=abc123", "COUNT=200", "LOAD=1", "STALL=1",
                             "FEATURES=intent-store/postgres,x", "GATE_CACHE_DIR=/tmp/c d")
        argv = call["argv"]
        self.assertEqual(self.value(argv, "--filterset"), expression)
        self.assertEqual(self.value(argv, "--pr"), "3560")
        self.assertEqual(self.value(argv, "--base"), "abc123")
        self.assertEqual(self.value(argv, "--cache-dir"), "/tmp/c d")
        self.assertEqual(self.value(argv, "--repo-root"), str(self.root))
        self.assertEqual(self.value(argv, "--intentd-dir"), "packages/intentd")
        stress = [argv[i + 1] for i, a in enumerate(argv) if a == "--stress-arg"]
        self.assertEqual(stress, ["COUNT=200", "LOAD=1", "STALL=1", "FEATURES=intent-store/postgres x"])
        self.assertIsNone(call["E"])
        self.assertIsNone(call["PR"])

    def test_run_url_and_branch(self):
        url = "https://github.com/intent-hq/intentd/actions/runs/1/job/2"
        argv = self.run_make(f"RUN={url}", "BRANCH=feat/x'y")["argv"]
        self.assertEqual(self.value(argv, "--run"), url)
        self.assertEqual(self.value(argv, "--branch"), "feat/x'y")
        self.assertEqual(self.value(argv, "--filterset"), "")
        self.assertNotIn("--stress-arg", argv, "defaults are left to make test-stress")

    def test_exported_values_are_ignored(self):
        argv = self.run_make(env={"E": "test(/x/)", "PR": "1", "BRANCH": "main", "RUN": "1", "BASE": "x",
                                  "COUNT": "5"})["argv"]
        for flag in ("--filterset", "--pr", "--branch", "--run", "--base"):
            self.assertEqual(self.value(argv, flag), "", flag)
        self.assertNotIn("--stress-arg", argv)


if __name__ == "__main__":
    unittest.main()
