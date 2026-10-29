#!/usr/bin/env python3
"""Stress mode of scripts/resumable_nextest.py (make test-stress)."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stress = load("nextest_stress")
gate = load("resumable_nextest")

# Captured from cargo-nextest 0.9.143 on a scratch crate (--stress-count 3
# --failure-output immediate), plus a TIMEOUT and progress-only lines.
OUTPUT = """\
 Stress test iteration 1/3 (00:00:00 elapsed so far, 3 iterations remaining)
        PASS [   0.002s] [1/3] (1/2) probe stable
        FAIL [   0.002s] [1/3] (2/2) probe flaky
  stderr ───

    thread 'flaky' (1588021) panicked at src/lib.rs:1:121:
    unlucky 714882060
    thread 'flaky' (1588021) panicked at src/other.rs:9:1:
    second panic is not the location

 Stress test [   0.003s] iteration 1/3: 2 tests run: 1 passed, 1 failed, 0 skipped
 Stress test iteration 2/3 (00:00:00 elapsed so far, 2 iterations remaining)
        SLOW [> 60.000s] [2/3] (1/2) probe stable
        PASS [  61.002s] [2/3] (1/2) probe stable
     TIMEOUT [ 120.000s] [2/3] (2/2) probe flaky
 Stress test iteration 3/3 (00:00:00 elapsed so far, 1 iteration remaining)
        PASS [   0.002s] [3/3] (1/2) probe flaky
        FAIL [   0.002s] [3/3] (2/2) probe stable
  stderr ───
    thread 'stable' (77) panicked at src/lib.rs:1:121:
    boom
     Summary [   0.017s] 3/3 stress run iterations: 0 passed, 3 failed
        FAIL [   0.002s] [1/3] (2/2) probe flaky
     TIMEOUT [ 120.000s] [2/3] (2/2) probe flaky
        FAIL [   0.002s] [3/3] (2/2) probe stable
"""


def tally(text):
    result = stress.StressTally()
    for line in text.splitlines(keepends=True):
        result.feed(line)
    return result.counts()


class TallyTests(unittest.TestCase):
    def test_counts_runs_once_and_groups_failures_by_first_panic_location(self):
        counts = tally(OUTPUT)
        self.assertEqual(counts["iterations"], 3)
        self.assertEqual(counts["total_iterations"], 3)
        self.assertEqual(counts["failed_iterations"], 3)
        self.assertEqual(counts["tests"], 2)
        self.assertEqual(counts["passed"], 3)
        self.assertEqual(counts["failed"], 3, "the repeated summary block must not double count")
        self.assertEqual(counts["failures"], {"src/lib.rs:1": 2, "TIMEOUT": 1})

    def test_summary_line_names_iterations_counts_and_locations(self):
        line = stress.summary_line("test-stress", tally(OUTPUT), "LOAD=1 (4 cpu + fsync)")
        self.assertEqual(
            line,
            "[test-stress] stress: 3/3 iterations (3 failed), 2 tests, LOAD=1 (4 cpu + fsync): "
            "3 passed, 3 failed; failures: src/lib.rs:1 ×2, TIMEOUT ×1")

    def test_clean_run_has_no_failure_clause(self):
        text = "".join(f"        PASS [   0.002s] [{i}/2] (1/1) probe one\n" for i in (1, 2))
        self.assertEqual(stress.summary_line("s", tally(text), "LOAD=0"),
                         "[s] stress: 2/2 iterations (0 failed), 1 test, LOAD=0: 2 passed, 0 failed")

    def test_every_nextest_final_status_is_classified(self):
        statuses = {"PASS": True, "LEAK": True, "TIMEOUT-PASS": True, "TMPASS": True,
                    "FAIL": False, "FAIL + LEAK": False, "LEAK-FAIL": False, "LKFAIL": False,
                    "XFAIL": False, "TIMEOUT": False, "ABORT": False, "SIGSEGV": False}
        text = "".join(f"  {status} [   0.002s] [{i}/{len(statuses)}] (1/1) probe one\n"
                       for i, status in enumerate(statuses, 1))
        text += "        SLOW [> 60.000s] [1/12] (1/1) probe one\n TERMINATING [> 90.000s] [9/12] (1/1) probe one\n"
        counts = tally(text)
        self.assertEqual((counts["iterations"], counts["passed"], counts["failed"]), (12, 4, 8))
        self.assertEqual(sum(counts["failures"].values()), 8)
        self.assertIn("FAIL + LEAK", counts["failures"])

    def test_disagreement_with_nextest_summary_is_flagged(self):
        self.assertEqual(tally(OUTPUT)["nextest_summary"], [3, 3])
        self.assertNotIn("WARNING", stress.summary_line("s", tally(OUTPUT), "LOAD=0"))
        # A status line the parser cannot read (here: a future format) must not
        # silently shrink the counts.
        drifted = tally("        PASS [   0.002s] [1/2] (1/1) probe one\n"
                        "        FAIL <0.002s> {2/2} probe one\n"
                        "     Summary [   0.017s] 2/2 stress run iterations: 1 passed, 1 failed\n")
        self.assertIn("WARNING: nextest reported 2 iterations with 1 failed",
                      stress.summary_line("s", drifted, "LOAD=0"))

    def test_unfinished_run_is_flagged(self):
        line = stress.summary_line("s", tally(""), "LOAD=0", None)
        self.assertTrue(line.endswith("; ERROR: the run did not complete (see the error above)"), line)

    def test_default_load_follows_usable_cpus(self):
        with mock.patch.object(stress, "usable_cpus", return_value=8):
            self.assertEqual(stress.default_load_cpus(), 16)
        self.assertLessEqual(stress.usable_cpus(), os.cpu_count())

    def test_colored_single_test_output_from_a_pty_is_parsed(self):
        # Captured from make test-stress under a ws.script PTY (nextest 0.9.143):
        # colors on, and no "(k/M)" column when one test is selected.
        text = ("\x1b[31;1m        FAIL\x1b[0m [   2.350s] [\x1b[1m20\x1b[0m/\x1b[1m20\x1b[0m] "
                "\x1b[35;1mintent-services\x1b[0m \x1b[36mdesktop::tests::workspace_lifecycle\x1b[0m"
                "\x1b[36m::\x1b[0m\x1b[34;1mwatchdog_ends_control_once\x1b[0m\r\n"
                "  thread 'w' (9) panicked at crates/intent-services/src/desktop/tests/"
                "workspace_lifecycle.rs:68:5:\r\n"
                "\x1b[32;1m        PASS\x1b[0m [   2.1s] [\x1b[1m19\x1b[0m/\x1b[1m20\x1b[0m] "
                "\x1b[35;1mintent-services\x1b[0m \x1b[36mdesktop::tests::workspace_lifecycle::"
                "watchdog_ends_control_once\x1b[0m\r\n")
        # Iterations below 10 are space-padded in a 20-iteration run.
        text += ("        PASS [   2.998s] [ 2/20] intent-services desktop::tests::workspace_lifecycle::"
                 "watchdog_ends_control_once\n")
        counts = tally(text)
        self.assertEqual((counts["iterations"], counts["total_iterations"], counts["tests"]), (3, 20, 1))
        self.assertEqual((counts["passed"], counts["failed"]), (2, 1))
        self.assertEqual(counts["failures"],
                         {"crates/intent-services/src/desktop/tests/workspace_lifecycle.rs:68": 1})

    def test_panic_outside_a_failure_block_is_ignored(self):
        text = ("        PASS [   0.002s] [1/1] (1/1) probe one\n"
                "thread 'x' panicked at src/a.rs:3:4:\n")
        self.assertEqual(tally(text)["failures"], {})


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill(0); it is dead for our purposes.
    with contextlib.suppress(OSError):
        if Path(f"/proc/{pid}/stat").read_text().split()[2] == "Z":
            return False
    return True


def marked(marker):
    """Live processes whose environment carries `marker`."""
    found = []
    for environ in Path("/proc").glob("[0-9]*/environ"):
        with contextlib.suppress(OSError):
            if marker.encode() in environ.read_bytes().split(b"\0") and alive(int(environ.parent.name)):
                found.append(int(environ.parent.name))
    return found


class LoadTests(unittest.TestCase):
    def test_load_processes_stop_on_exit_and_on_error(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as scratch:
                pids = []
                with contextlib.suppress(RuntimeError):
                    with stress.stress_load(2, Path(scratch)) as processes:
                        pids = [process.pid for process in processes]
                        self.assertEqual(len(pids), 3, "two spinners plus the fsync writer")
                        self.assertTrue(all(alive(pid) for pid in pids))
                        if fail:
                            raise RuntimeError("test failure")
                self.assertEqual([pid for pid in pids if alive(pid)], [])

    def test_child_exits_if_the_runner_died_before_registration(self):
        # The startup window: the runner was SIGKILLed after fork but before the
        # child registered its parent-death signal, so the child is reparented.
        calls = []
        for parent, registered, exits in ((4242, 0, False), (1, 0, True), (4242, -1, True)):
            with self.subTest(parent=parent, registered=registered), \
                    mock.patch.object(stress.os, "getppid", return_value=parent), \
                    mock.patch.object(stress.os, "_exit", side_effect=SystemExit) as exit_:
                preexec = stress.die_with_parent(4242, lambda o, s, r=registered: calls.append((o, s)) or r)
                if exits:
                    with self.assertRaises(SystemExit):
                        preexec()
                    exit_.assert_called_once_with(1)
                else:
                    preexec()
                    exit_.assert_not_called()
        self.assertTrue(all(call == (stress.PR_SET_PDEATHSIG, stress.signal.SIGKILL) for call in calls))

    @unittest.skipUnless(sys.platform.startswith("linux"), "parent-death signal is Linux only")
    def test_load_never_survives_a_runner_killed_during_startup(self):
        # Kill the runner while it is still spawning workers, at varied points;
        # every worker inherits a marker so stragglers can be found in /proc.
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import nextest_stress as s, time; "
                "from pathlib import Path\n"
                "with s.stress_load(50, Path(sys.argv[2])) as p:\n    time.sleep(60)\n")
        for delay in (0.02, 0.1, 0.3):
            marker = f"INTENT_STRESS_TEST_MARKER={os.getpid()}-{delay}"
            with self.subTest(delay=delay), tempfile.TemporaryDirectory() as scratch:
                runner = subprocess.Popen([sys.executable, "-c", code, str(HERE), scratch],
                                          env={**os.environ, "INTENT_STRESS_TEST_MARKER": marker.split("=", 1)[1]})
                time.sleep(delay)
                runner.kill()
                runner.wait()
                for _ in range(100):
                    if not marked(marker):
                        break
                    time.sleep(0.05)
                self.assertEqual(marked(marker), [])

    @unittest.skipUnless(sys.platform.startswith("linux"), "parent-death signal is Linux only")
    def test_load_dies_with_a_killed_runner(self):
        code = ("import sys, time; sys.path.insert(0, sys.argv[1]); import nextest_stress as s; "
                "from pathlib import Path\n"
                "with s.stress_load(1, Path(sys.argv[2])) as p:\n"
                "    print(' '.join(str(x.pid) for x in p), flush=True); time.sleep(60)\n")
        with tempfile.TemporaryDirectory() as scratch:
            runner = subprocess.Popen([sys.executable, "-c", code, str(HERE), scratch],
                                      stdout=subprocess.PIPE, text=True)
            pids = [int(pid) for pid in runner.stdout.readline().split()]
            runner.kill()
            runner.wait()
            runner.stdout.close()
            for _ in range(100):
                if not any(alive(pid) for pid in pids):
                    break
                time.sleep(0.05)
            self.assertEqual([pid for pid in pids if alive(pid)], [])


FAKE_CARGO = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_CARGO_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "fixture": os.environ.get("FIXTURE")}) + "\\n")
if sys.argv[2:4] == ["run", "--help"]:
    print(os.environ.get("FAKE_CARGO_HELP", "--retries <N>\\n--stress-count <COUNT>"))
elif sys.argv[2] == "run":
    import time
    time.sleep(float(os.environ.get("FAKE_CARGO_SLEEP", "0")))
    sys.stderr.write(os.environ["FAKE_CARGO_OUTPUT"])
    sys.exit(int(os.environ.get("FAKE_CARGO_EXIT", "0")))
"""


class RunStressTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "packages/intentd").mkdir(parents=True)
        self.cache = self.root / "cache"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        cargo = bin_dir / "cargo"
        cargo.write_text(FAKE_CARGO)
        cargo.chmod(0o755)
        self.log = self.root / "cargo.jsonl"
        patcher = mock.patch.dict(os.environ, {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "FAKE_CARGO_LOG": str(self.log)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_gate(self):
        def prepare_test_env(_repo, _intentd, plans, _label):
            self.prepared = plans
            return {**os.environ, "FIXTURE": "set"}, None, None, []
        return SimpleNamespace(
            prepare_test_env=prepare_test_env, TIMEOUT_MULTIPLIER_ENV=gate.TIMEOUT_MULTIPLIER_ENV,
            isolated_output_args=lambda *_: ["--target-dir", str(self.root / "target")],
            acquire_gate_lock=lambda _o: None, timeout_description=gate.timeout_description,
            run=gate.run, terminate_on_signal=gate.terminate_on_signal,
            failure_exit_code=gate.failure_exit_code, Terminated=gate.Terminated)

    def run_stress(self, output, exit_code=0, help_text=None, sleep=0, **overrides):
        args = SimpleNamespace(label="test-stress", repo_root=str(self.root),
                               intentd_dir="packages/intentd", cache_dir=str(self.cache),
                               filterset="test(/it's $/)", stress_count=3, load="0",
                               load_cpus=None, build_jobs="2", test_threads="5")
        vars(args).update(overrides)
        stdout = io.StringIO()
        fake = {"FAKE_CARGO_OUTPUT": output, "FAKE_CARGO_EXIT": str(exit_code),
                "FAKE_CARGO_SLEEP": str(sleep)}
        if help_text is not None:
            fake["FAKE_CARGO_HELP"] = help_text
        with mock.patch.dict(os.environ, fake), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
            status = stress.run_stress(args, self.fake_gate())
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return status, stdout.getvalue(), calls

    def test_builds_first_then_runs_with_retries_off_and_records_a_summary(self):
        status, stdout, calls = self.run_stress(OUTPUT, exit_code=100)
        self.assertEqual(status, 100)
        self.assertEqual([call["argv"][:3] for call in calls],
                         [["nextest", "run", "--help"], ["nextest", "list", "--workspace"],
                          ["nextest", "run", "--workspace"]])
        self.assertEqual(self.prepared, [["--workspace", "-E", "test(/it's $/)"]],
                         "fixtures come from the gate's shared preparation")
        run = calls[2]["argv"]
        self.assertEqual(run[2:5], ["--workspace", "-E", "test(/it's $/)"])
        for flag, value in (("--retries", "0"), ("--stress-count", "3"), ("--failure-output", "immediate"),
                            ("--build-jobs", "2"), ("--test-threads", "5"), ("--status-level", "pass")):
            self.assertEqual(run[run.index(flag) + 1], value, flag)
        self.assertIn("--no-fail-fast", run)
        self.assertEqual(calls[2]["fixture"], "set")
        self.assertIn("[test-stress] stress: 3/3 iterations (3 failed), 2 tests, LOAD=0: "
                      "3 passed, 3 failed; failures: src/lib.rs:1 ×2, TIMEOUT ×1", stdout)
        records = list((self.cache / "stress").iterdir())
        self.assertEqual(len(records), 1)
        summary = json.loads((records[0] / "summary.json").read_text())
        self.assertEqual((summary["failed"], summary["exit_code"], summary["load"]), (3, 100, False))
        self.assertIn("panicked at src/lib.rs", (records[0] / "output.log").read_text())
        self.assertEqual(sorted(p.name for p in self.cache.iterdir()), ["stress"],
                         "stress runs never write resume journals or completion markers")

    def test_a_parsed_failure_makes_the_exit_non_zero(self):
        status, _, _ = self.run_stress(OUTPUT, exit_code=0)
        self.assertEqual(status, 1)

    def test_clean_run_under_load_exits_zero(self):
        text = "".join(f"        PASS [   0.002s] [{i}/3] (1/1) probe one\n" for i in (1, 2, 3))
        status, stdout, _ = self.run_stress(text, load="1", load_cpus=2)
        self.assertEqual(status, 0)
        self.assertIn("3/3 iterations (0 failed), 1 test, LOAD=1 (2 cpu + fsync): 3 passed, 0 failed", stdout)

    def test_nextest_without_stress_support_fails_before_the_build(self):
        with self.assertRaisesRegex(RuntimeError, "no --stress-count"):
            self.run_stress("", help_text="--retries <N>")
        calls = [json.loads(line)["argv"][:2] for line in self.log.read_text().splitlines()]
        self.assertEqual(calls, [["nextest", "run"]], "nothing is built when stress mode is unsupported")

    def test_exit_without_a_test_failure_is_not_reported_as_clean(self):
        status, stdout, _ = self.run_stress("error: no tests to run\n", exit_code=4)
        self.assertEqual(status, 4)
        self.assertIn("0 passed, 0 failed; ERROR: exited 4 without a test failure", stdout)

    def test_a_load_worker_that_dies_mid_run_invalidates_the_run(self):
        # e.g. the fsync writer hitting ENOSPC while nextest is still running.
        text = "".join(f"        PASS [   0.002s] [{i}/3] (1/1) probe one\n" for i in (1, 2, 3))
        failing_writer = "import sys; sys.stderr.write('No space left on device'); sys.exit(28)"
        with mock.patch.object(stress, "FSYNC_WRITER", failing_writer):
            status, stdout, _ = self.run_stress(text, load="1", load_cpus=1, sleep=1)
        self.assertEqual(status, stress.LOAD_INVALID_EXIT)
        self.assertIn("3 passed, 0 failed; INVALID: 1 load worker(s) stopped early", stdout)
        record = next((self.cache / "stress").iterdir())
        self.assertIn("No space left on device", (record / "load.err").read_text())
        summary = json.loads((record / "summary.json").read_text())
        self.assertEqual(summary["exit_code"], stress.LOAD_INVALID_EXIT)
        self.assertEqual(len(summary["load_failures"]), 1)
        self.assertIn("exited 28", summary["load_failures"][0])

    def test_real_gate_provides_every_helper_stress_mode_uses(self):
        for name in vars(self.fake_gate()):
            self.assertTrue(hasattr(gate, name), name)


class ArgumentTests(unittest.TestCase):
    def main(self, *argv):
        base = ["resumable_nextest.py", "--repo-root", ".", "--intentd-dir", "x", "--cache-dir", "c",
                "--build-jobs", "1", "--test-threads", "1"]
        with mock.patch.object(sys, "argv", base + list(argv)), \
                mock.patch("nextest_stress.run_stress", return_value=7) as run_stress, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            try:
                status = gate.main()
            except SystemExit as error:
                status = error.code
        return status, run_stress, stderr.getvalue()

    def test_stress_dispatches_with_parsed_options(self):
        status, run_stress, _ = self.main("--filterset", "test(/a/)", "--stress-count", "20",
                                          "--load", "1", "--load-cpus", "8")
        self.assertEqual(status, 7)
        args = run_stress.call_args.args[0]
        self.assertEqual((args.stress_count, args.load, args.load_cpus, args.filterset),
                         (20, "1", 8, "test(/a/)"))

    def test_bad_stress_arguments_are_refused(self):
        for argv, message in ((("--stress-count", "5"), "needs --filterset"),
                              (("--filterset", "test(/a/)", "--stress-count", "0"), "positive integer"),
                              (("--filterset", "test(/a/)", "--stress-count", "x"), "positive integer"),
                              (("--filterset", "test(/a/)", "--load", "1"), "need --stress-count"),
                              (("--filterset", " ", "--stress-count", "2"), "filterset expression")):
            with self.subTest(argv=argv):
                status, run_stress, stderr = self.main(*argv)
                self.assertEqual(status, 2)
                self.assertIn(message, stderr)
                run_stress.assert_not_called()


if __name__ == "__main__":
    unittest.main()
