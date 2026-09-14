#!/usr/bin/env python3

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
import tomllib
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("resumable_nextest.py")
SPEC = importlib.util.spec_from_file_location("resumable_nextest", SCRIPT)
gate = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gate)

KEY = "a" * 64
LISTING = json.dumps(
    {
        "rust-suites": {
            "alpha::one": {
                "package-name": "alpha",
                "binary-name": "one",
                "binary-id": "alpha::one",
                "testcases": {"passes": {}, "fails": {}, "skipped": {}},
            }
        }
    }
)


def event(kind, name, **extra):
    return json.dumps({"type": "test", "event": kind, "name": name, **extra}) + "\n"


def make_args(root, **overrides):
    values = dict(
        repo_root=root,
        intentd_dir="intentd",
        cache_dir=root / "cache",
        resume="0",
        force="0",
        build_jobs="2",
        test_threads="1",
        label="test-changed",
        plan=["-p alpha --test one"],
        base="origin/main",
    )
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeProcess:
    def __init__(self, lines, status):
        self.stdout = iter(lines)
        self.status = status
        self.terminated = False

    def wait(self):
        return self.status

    def terminate(self):
        self.terminated = True


class PlannedRunHarness:
    """Mocks `tree_key`, `run` and `subprocess.Popen` around `run_nextest`."""

    def __init__(self, root, runs):
        (root / "intentd").mkdir(exist_ok=True)
        self.root = root
        self.runs = list(runs)
        self.list_commands = []
        self.run_commands = []
        self.stdout = io.StringIO()

    def fake_run(self, command, cwd, env=None):
        assert command[:3] == ["cargo", "nextest", "list"], command
        self.list_commands.append(command)
        return LISTING

    def fake_popen(self, command, **kwargs):
        self.run_commands.append(command)
        lines, status = self.runs.pop(0)
        return FakeProcess(lines, status)

    def execute(self, args):
        with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
            gate, "run", side_effect=self.fake_run
        ), mock.patch.object(
            gate.subprocess, "Popen", side_effect=self.fake_popen
        ), contextlib.redirect_stdout(self.stdout):
            return gate.run_nextest(args)

    @property
    def output_lines(self):
        return self.stdout.getvalue().splitlines()


class ResumableNextestTests(unittest.TestCase):
    def test_pass_events_and_exact_filter(self):
        binary_ids = {
            ("intentd::e2e", "module::passes"): "intentd::e2e",
            ("intent-core::intent_core", "module::unit"): "intent-core",
        }
        event = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::passes"}
        )
        self.assertEqual(
            gate.parse_recorded_event(event, binary_ids),
            ("intentd::e2e", "module::passes", "ok"),
        )
        unit_event = json.dumps(
            {"type": "test", "event": "ok", "name": "intent-core::intent_core$module::unit"}
        )
        self.assertEqual(
            gate.parse_recorded_event(unit_event, binary_ids),
            ("intent-core", "module::unit", "ok"),
        )
        failed_event = json.dumps(
            {"type": "test", "event": "failed", "name": "intentd::e2e$module::passes"}
        )
        self.assertEqual(
            gate.parse_recorded_event(failed_event, binary_ids),
            ("intentd::e2e", "module::passes", "failed"),
        )
        expression = gate.remaining_filter(
            {("intentd::e2e", "module::passes"), ("intentd::e2e", "module::passes_two")}
        )
        self.assertEqual(
            expression,
            "not ((binary_id(/^intentd::e2e$/) and (test(/^module::passes$/) | "
            "test(/^module::passes_two$/))))",
        )
        for skipped in (
            '{"type":"test","event":"ignored","name":"intentd::e2e$module::passes"}',
            '{"type":"test","event":"started","name":"intentd::e2e$module::passes"}',
            '{"type":"suite","event":"failed"}',
            "not json",
        ):
            self.assertIsNone(gate.parse_recorded_event(skipped, binary_ids))
        self.assertEqual(
            gate.record_line("intentd::e2e", "module::passes", "ok"),
            '{"binary_id": "intentd::e2e", "test": "module::passes"}\n',
        )
        self.assertEqual(
            gate.record_line("intentd::e2e", "module::passes", "failed"),
            '{"binary_id": "intentd::e2e", "test": "module::passes", "outcome": "failed"}\n',
        )

    def test_pass_event_strips_retry_suffix(self):
        binary_ids = {("intentd::e2e", "module::passes"): "intentd::e2e"}
        retried = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::passes#2"}
        )
        self.assertEqual(
            gate.parse_recorded_event(retried, binary_ids),
            ("intentd::e2e", "module::passes", "ok"),
        )
        unlisted = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::missing#2"}
        )
        with self.assertRaisesRegex(RuntimeError, "was not listed"):
            gate.parse_recorded_event(unlisted, binary_ids)
        not_a_suffix = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::passes#2x"}
        )
        with self.assertRaisesRegex(RuntimeError, "was not listed"):
            gate.parse_recorded_event(not_a_suffix, binary_ids)

    def test_list_metadata_maps_target_kinds_to_canonical_binary_ids(self):
        listing = json.dumps(
            {
                "rust-suites": {
                    "intent-core": {
                        "package-name": "intent-core",
                        "binary-name": "intent_core",
                        "binary-id": "intent-core",
                        "testcases": {"unit": {}},
                    },
                    "intentd::bin/intentd": {
                        "package-name": "intentd",
                        "binary-name": "intentd",
                        "binary-id": "intentd::bin/intentd",
                        "testcases": {"binary": {}},
                    },
                }
            }
        )
        self.assertEqual(
            gate.test_binary_ids(listing),
            {
                ("intent-core::intent_core", "unit"): "intent-core",
                ("intentd::intentd", "binary"): "intentd::bin/intentd",
            },
        )

    def test_record_load_merges_and_ignores_partial_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / "passed.jsonl"
            record.write_text(
                '{"binary_id":"one","test":"a"}\n'
                '{"binary_id":"one","test":"a"}\n'
                '{"binary_id":"two","test":"b"}\n'
                '{"binary_id":',
                encoding="utf-8",
            )
            self.assertEqual(gate.load_passed(record), {("one", "a"), ("two", "b")})

    def test_record_load_lets_a_later_failure_supersede_an_earlier_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / "passed.jsonl"
            record.write_text(
                '{"binary_id":"one","test":"a"}\n'
                '{"binary_id":"one","test":"b"}\n'
                '{"binary_id":"two","test":"c","outcome":"ok"}\n'
                '{"binary_id":"one","test":"a","outcome":"failed"}\n'
                '{"binary_id":"one","test":"never","outcome":"failed"}\n'
                '{"binary_id":"two","test":"c","outcome":"failed"}\n'
                '{"binary_id":"two","test":"c"}\n'
                "[]\n",
                encoding="utf-8",
            )
            self.assertEqual(gate.load_passed(record), {("one", "b"), ("two", "c")})

    def test_rust_flags_include_all_cargo_sources(self):
        values = {
            "RUSTFLAGS": "--cfg local",
            "CARGO_ENCODED_RUSTFLAGS": "--cfg\x1fencoded",
            "CARGO_BUILD_RUSTFLAGS": "--cfg build",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS": "--cfg target",
            "UNRELATED": "ignored",
        }
        with mock.patch.dict(os.environ, values, clear=True):
            self.assertEqual(
                gate.rust_flags(),
                {name: value for name, value in values.items() if name != "UNRELATED"},
            )

    def test_nextest_env_hides_progress_bar_unless_caller_overrides(self):
        with mock.patch.dict(os.environ, {"PATH": "/bin"}, clear=True):
            env = gate.nextest_env()
            self.assertEqual(env["NEXTEST_HIDE_PROGRESS_BAR"], "1")
            self.assertEqual(env["NEXTEST_EXPERIMENTAL_LIBTEST_JSON"], "1")
            self.assertEqual(env["PATH"], "/bin")
        with mock.patch.dict(os.environ, {"NEXTEST_HIDE_PROGRESS_BAR": "0"}, clear=True):
            self.assertEqual(gate.nextest_env()["NEXTEST_HIDE_PROGRESS_BAR"], "0")

    def test_prune_removes_only_old_key_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            old = cache / ("a" * 64)
            recent = cache / ("b" * 64)
            unrelated = cache / "keep-me"
            for path in (old, recent, unrelated):
                path.mkdir()
            old_time = time.time() - gate.MAX_AGE_SECONDS - 10
            old.touch()
            Path(old).chmod(0o700)
            os.utime(old, (old_time, old_time))
            gate.prune(cache)
            self.assertFalse(old.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(unrelated.exists())

    def test_worktree_tree_includes_untracked_files_without_touching_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "test@example.com"], cwd=repo, check=True
            )
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            (repo / "tracked.rs").write_text("fn one() {}\n", encoding="utf-8")
            subprocess.run(["git", "add", "tracked.rs"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            clean = gate.worktree_tree(repo)
            (repo / "untracked.rs").write_text("fn two() {}\n", encoding="utf-8")
            changed = gate.worktree_tree(repo)
            self.assertNotEqual(clean, changed)
            staged = subprocess.run(
                ["git", "diff", "--cached", "--quiet"], cwd=repo
            )
            self.assertEqual(staged.returncode, 0)

    def test_tool_config_writes_junit_and_remaining_filter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "tree" / "nextest.toml"
            config.parent.mkdir()
            gate.write_tool_config(config, root, "a" * 64, {("binary", "test")})
            parsed = tomllib.loads(config.read_text(encoding="utf-8"))
            profile = parsed["profile"]["a" * 64]
            self.assertEqual(profile["inherits"], "default")
            self.assertIn("binary_id(/^binary$/)", profile["default-filter"])
            self.assertEqual(profile["junit"]["path"], "junit.xml")

    def test_complete_marker_fast_path_does_not_invoke_cargo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            key = "a" * 64
            run_dir = root / "cache" / key
            run_dir.mkdir(parents=True)
            (run_dir / "passed.jsonl").write_text(
                '{"binary_id":"binary","test":"test"}\n', encoding="utf-8"
            )
            (run_dir / "complete").write_text("complete\n", encoding="utf-8")
            args = make_args(
                root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None
            )
            with mock.patch.object(gate, "tree_key", return_value=key), mock.patch.object(
                gate, "run", side_effect=AssertionError("cargo must not run")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gate.run_nextest(args), 0)
            self.assertEqual(
                stdout.getvalue(),
                "resumed: skipped 1 tests already passed for this tree\n",
            )

    def test_plans_are_split_with_shlex_and_keyed_in_order(self):
        plans = gate.split_plans(["-p alpha --test one --test two", "-p 'beta' -p gamma --tests "])
        self.assertEqual(
            plans,
            [["-p", "alpha", "--test", "one", "--test", "two"], ["-p", "beta", "-p", "gamma", "--tests"]],
        )
        self.assertEqual(gate.split_plans(None), [])
        forward = gate.plan_key(plans)
        self.assertRegex(forward, r"^[0-9a-f]{64}$")
        self.assertEqual(forward, gate.plan_key(gate.split_plans(["-p alpha  --test one --test two", "-p beta -p gamma --tests"])))
        self.assertNotEqual(forward, gate.plan_key(list(reversed(plans))))

    def test_outcome_events_count_final_attempt_only(self):
        self.assertEqual(
            gate.test_outcome(event("failed", "alpha::one$fails#1")), ("alpha::one$fails", "failed")
        )
        self.assertIsNone(gate.test_outcome(event("started", "alpha::one$fails")))
        self.assertIsNone(gate.test_outcome('{"type":"suite","event":"ok"}'))
        self.assertIsNone(gate.test_outcome("not json"))
        outcomes = {}
        for line in (
            event("failed", "alpha::one$flaky#1"),
            event("ok", "alpha::one$flaky#2"),
            event("ignored", "alpha::one$skipped"),
            event("failed", "alpha::one$fails"),
        ):
            name, outcome = gate.test_outcome(line)
            outcomes[name] = outcome
        self.assertEqual(gate.tally(outcomes), {"passed": 1, "failed": 1, "ignored": 1})

    def test_planned_run_writes_sub_record_and_never_tree_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plans = ["-p alpha --test one", "-p beta"]
            harness = PlannedRunHarness(
                root,
                [
                    ([event("ok", "alpha::one$passes"), event("ignored", "alpha::one$skipped")], 0),
                    ([event("ok", "alpha::one$fails")], 0),
                ],
            )
            self.assertEqual(harness.execute(make_args(root, plan=plans)), 0)

            run_dir = root / "cache" / KEY
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(plans))
            self.assertFalse((run_dir / "complete").exists())
            self.assertTrue((record_dir / "complete").is_file())
            self.assertEqual(
                [command[3:6] for command in harness.list_commands],
                [["-p", "alpha", "--test"], ["-p", "beta", "--build-jobs"]],
            )
            self.assertEqual(harness.run_commands[0][3:7], ["-p", "alpha", "--test", "one"])
            self.assertEqual(harness.run_commands[1][3:5], ["-p", "beta"])
            self.assertNotIn("--workspace", harness.run_commands[0])
            self.assertNotIn("--no-tests", harness.run_commands[0])

            for index in (1, 2):
                config = tomllib.loads((record_dir / f"nextest-{index}.toml").read_text())
                self.assertEqual(config["store"]["dir"], str(run_dir / "changed"))
                profile = config["profile"][record_dir.name]
                self.assertEqual(profile["junit"]["path"], f"junit-{index}.xml")
                self.assertNotIn("default-filter", profile)
                self.assertIn(
                    f"--tool-config-file", harness.run_commands[index - 1]
                )
                self.assertIn(f"intent-gate:{record_dir / f'nextest-{index}.toml'}", harness.run_commands[index - 1])
                self.assertIn(record_dir.name, harness.run_commands[index - 1])

            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["label"], "test-changed")
            self.assertEqual(run_record["base"], "origin/main")
            self.assertEqual(run_record["plans"], plans)
            self.assertEqual(run_record["tree_key"], KEY)
            self.assertEqual(run_record["plan_key"], record_dir.name)
            self.assertEqual(run_record["exit_code"], 0)
            self.assertEqual(run_record["skipped_resumed"], 0)
            self.assertEqual((run_record["passed"], run_record["failed"], run_record["ignored"]), (2, 0, 1))
            self.assertRegex(run_record["started_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            self.assertRegex(run_record["finished_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            self.assertEqual(
                run_record["results"],
                [
                    {"plan": plans[0], "passed": 1, "failed": 0, "ignored": 1, "exit_code": 0},
                    {"plan": plans[1], "passed": 1, "failed": 0, "ignored": 0, "exit_code": 0},
                ],
            )

            summary = (
                "[test-changed] summary: 2 passed, 0 failed, 1 skipped/ignored, 0 resumed "
                "(tests already passed for this tree)"
            )
            self.assertEqual((record_dir / "summary.txt").read_text(), summary + "\n")
            self.assertEqual(
                harness.output_lines[-2:], [summary, f"[test-changed] record: {record_dir}"]
            )
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"),
                {("alpha::one", "passes"), ("alpha::one", "fails")},
            )

    def test_planned_run_appends_to_shared_record_and_resumes_in_plan_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            run_dir.mkdir(parents=True)
            (run_dir / "passed.jsonl").write_text(
                '{"binary_id":"alpha::one","test":"passes"}\n'
                '{"binary_id":"other","test":"elsewhere"}\n',
                encoding="utf-8",
            )
            harness = PlannedRunHarness(root, [([event("ok", "alpha::one$fails")], 0)])
            self.assertEqual(harness.execute(make_args(root, resume="1")), 0)
            self.assertEqual(harness.run_commands[0][-2:], ["--no-tests", "pass"])
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            profile = tomllib.loads((record_dir / "nextest-1.toml").read_text())["profile"][record_dir.name]
            self.assertEqual(
                profile["default-filter"],
                "not ((binary_id(/^alpha::one$/) and (test(/^passes$/))))",
            )
            self.assertEqual(json.loads((record_dir / "run.json").read_text())["skipped_resumed"], 1)
            self.assertIn("1 resumed", harness.output_lines[-2])
            self.assertIn("resumed: skipped 1 tests already passed for this tree", harness.output_lines)
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"),
                {("alpha::one", "passes"), ("alpha::one", "fails"), ("other", "elsewhere")},
            )

    def test_planned_complete_marker_short_circuits_unless_forced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            run_dir = root / "cache" / KEY
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            record_dir.mkdir(parents=True)
            (run_dir / "passed.jsonl").write_text(
                '{"binary_id":"alpha::one","test":"passes"}\n', encoding="utf-8"
            )
            (record_dir / "complete").write_text("complete\n", encoding="utf-8")
            (record_dir / "run.json").write_text(
                json.dumps({"passed": 2, "skipped_resumed": 1}), encoding="utf-8"
            )
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=AssertionError("cargo must not run")
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("cargo must not run")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 0)
            self.assertEqual(
                stdout.getvalue(), "resumed: skipped 3 tests already passed for this tree\n"
            )

            harness = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(harness.execute(make_args(root, resume="1", force="1")), 0)
            self.assertEqual(len(harness.run_commands), 1)
            self.assertNotIn("--no-tests", harness.run_commands[0])
            self.assertIn("[test-changed] GATE_FORCE=1: running every planned test", harness.output_lines)
            self.assertEqual(harness.output_lines[-2:][1], f"[test-changed] record: {record_dir}")

    def test_failing_planned_run_records_exit_code_and_stops_at_first_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plans = ["-p alpha --test one", "-p beta"]
            harness = PlannedRunHarness(
                root,
                [([event("ok", "alpha::one$passes"), event("failed", "alpha::one$fails")], 100)],
            )
            self.assertEqual(harness.execute(make_args(root, plan=plans)), 100)
            self.assertEqual(len(harness.run_commands), 1)
            run_dir = root / "cache" / KEY
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(plans))
            self.assertFalse((record_dir / "complete").exists())
            self.assertFalse((run_dir / "complete").exists())
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], 100)
            self.assertEqual(len(run_record["results"]), 1)
            self.assertEqual(
                harness.output_lines[-2:],
                [
                    "[test-changed] summary: 1 passed, 1 failed, 0 skipped/ignored, 0 resumed "
                    "(tests already passed for this tree)",
                    f"[test-changed] record: {record_dir}",
                ],
            )
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"), {("alpha::one", "passes")}
            )

    def test_interrupted_run_terminates_cargo_and_still_prints_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def lines():
                yield event("ok", "alpha::one$passes")
                raise KeyboardInterrupt

            harness = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(harness.execute(make_args(root)), 130)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(json.loads((record_dir / "run.json").read_text())["exit_code"], 130)
            self.assertEqual(harness.output_lines[-1], f"[test-changed] record: {record_dir}")
            self.assertIn("1 passed, 0 failed", harness.output_lines[-2])
            self.assertIn("[test-changed] ERROR: interrupted", stderr.getvalue())

    def test_list_failure_still_writes_record_and_returns_its_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            failure = subprocess.CalledProcessError(101, ["cargo", "nextest", "list"])
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=failure
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("run must not start")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(
                io.StringIO()
            ) as stderr:
                self.assertEqual(gate.run_nextest(make_args(root)), 101)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            summary = (
                "[test-changed] summary: 0 passed, 0 failed, 0 skipped/ignored, 0 resumed "
                "(tests already passed for this tree)"
            )
            self.assertEqual(
                stdout.getvalue().splitlines(), [summary, f"[test-changed] record: {record_dir}"]
            )
            self.assertIn("[test-changed] ERROR:", stderr.getvalue())
            self.assertEqual((record_dir / "summary.txt").read_text(), summary + "\n")
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], 101)
            self.assertEqual(run_record["results"], [])
            self.assertFalse((record_dir / "complete").exists())

    def test_sigterm_terminates_cargo_and_finalizes_with_143(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def lines():
                yield event("ok", "alpha::one$passes")
                os.kill(os.getpid(), gate.signal.SIGTERM)
                time.sleep(5)
                raise AssertionError("SIGTERM handler did not interrupt the stream")

            previous = gate.signal.getsignal(gate.signal.SIGTERM)
            harness = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(harness.execute(make_args(root)), 143)
            self.assertIs(gate.signal.getsignal(gate.signal.SIGTERM), previous)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertFalse((record_dir / "complete").exists())
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], 143)
            self.assertEqual(run_record["results"][0]["exit_code"], None)
            self.assertEqual(run_record["passed"], 1)
            self.assertEqual(harness.output_lines[-1], f"[test-changed] record: {record_dir}")

    def test_sigterm_to_real_process_leaves_durable_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            marker = root / "terminated"
            child_code = f"""
import importlib.util, json, os, sys, time
from pathlib import Path
from unittest import mock
spec = importlib.util.spec_from_file_location("resumable_nextest", {str(SCRIPT)!r})
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
from types import SimpleNamespace

class Proc:
    def __init__(self):
        self.stdout = self.lines()
    def lines(self):
        yield {event("ok", "alpha::one$passes")!r}
        yield "entry\\n"
        while True:
            time.sleep(0.05)
    def terminate(self):
        Path({str(marker)!r}).write_text("terminated")
    def wait(self):
        return -15

args = SimpleNamespace(repo_root=Path({str(root)!r}), intentd_dir="intentd", cache_dir=Path({str(root / "cache")!r}),
    resume="0", force="0", build_jobs="2", test_threads="1", label="test-changed",
    plan=["-p alpha --test one"], base=None)
with mock.patch.object(gate, "tree_key", return_value={KEY!r}), mock.patch.object(
    gate, "run", return_value={LISTING!r}
), mock.patch.object(gate.subprocess, "Popen", side_effect=lambda *a, **k: Proc()):
    raise SystemExit(gate.run_nextest(args))
"""
            child = subprocess.Popen(
                [sys.executable, "-c", child_code],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            assert child.stdout is not None
            try:
                for line in child.stdout:
                    if line == "entry\n":
                        break
                else:
                    self.fail("child never reached the streaming loop")
                child.send_signal(gate.signal.SIGTERM)
                remaining, stderr = child.communicate(timeout=20)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertEqual(child.returncode, 143, stderr)
            self.assertTrue(marker.is_file(), "nextest child was not terminated")
            self.assertEqual(remaining.splitlines()[-1], f"[test-changed] record: {record_dir}")
            self.assertIn("1 passed, 0 failed", remaining.splitlines()[-2])
            self.assertIn("ERROR: interrupted", stderr)
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(json.loads((record_dir / "run.json").read_text())["exit_code"], 143)

    def test_ignored_only_completed_plan_resumes_without_cargo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = PlannedRunHarness(root, [([event("ignored", "alpha::one$skipped")], 0)])
            self.assertEqual(harness.execute(make_args(root)), 0)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertTrue((record_dir / "complete").is_file())
            self.assertEqual(gate.load_passed(root / "cache" / KEY / "passed.jsonl"), set())

            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=AssertionError("cargo must not run")
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("cargo must not run")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 0)
            self.assertEqual(
                stdout.getvalue(), "resumed: skipped 0 tests already passed for this tree\n"
            )

            forced = PlannedRunHarness(root, [([event("ignored", "alpha::one$skipped")], 0)])
            self.assertEqual(forced.execute(make_args(root, resume="1", force="1")), 0)
            self.assertEqual(len(forced.run_commands), 1)

    def test_forced_rerun_with_failing_list_clears_stale_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(first.execute(make_args(root)), 0)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertTrue((record_dir / "complete").is_file())

            failure = subprocess.CalledProcessError(101, ["cargo", "nextest", "list"])
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=failure
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("run must not start")
            ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                self.assertEqual(gate.run_nextest(make_args(root, resume="1", force="1")), 101)
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(json.loads((record_dir / "run.json").read_text())["exit_code"], 101)

            third = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(third.execute(make_args(root, resume="1")), 0)
            self.assertEqual(len(third.list_commands), 1)
            self.assertEqual(len(third.run_commands), 1)
            self.assertTrue((record_dir / "complete").is_file())

    def test_forced_rerun_interrupted_during_list_clears_stale_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(first.execute(make_args(root)), 0)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertTrue((record_dir / "complete").is_file())

            def terminated_list(command, cwd, env=None):
                os.kill(os.getpid(), gate.signal.SIGTERM)
                time.sleep(5)
                raise AssertionError("SIGTERM handler did not interrupt the list step")

            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=terminated_list
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("run must not start")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(
                io.StringIO()
            ):
                self.assertEqual(gate.run_nextest(make_args(root, resume="1", force="1")), 143)
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(json.loads((record_dir / "run.json").read_text())["exit_code"], 143)
            self.assertEqual(
                stdout.getvalue().splitlines()[-1], f"[test-changed] record: {record_dir}"
            )

            third = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(third.execute(make_args(root, resume="1")), 0)
            self.assertEqual(len(third.run_commands), 1)

    def test_workspace_forced_rerun_with_failing_list_clears_stale_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            run_dir = root / "cache" / KEY
            run_dir.mkdir(parents=True)
            (run_dir / "complete").write_text("complete\n", encoding="utf-8")
            (run_dir / "passed.jsonl").write_text(
                '{"binary_id":"alpha::one","test":"passes"}\n', encoding="utf-8"
            )
            failure = subprocess.CalledProcessError(101, ["cargo", "nextest", "list"])
            args = make_args(root, resume="1", force="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=failure
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=AssertionError("run must not start")
            ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                self.assertEqual(gate.run_nextest(args), 101)
            self.assertFalse((run_dir / "complete").exists())
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"), {("alpha::one", "passes")}
            )

    def test_handled_runtime_error_records_the_cli_exit_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = PlannedRunHarness(root, [([event("ok", "beta::two$unlisted")], 0)])
            argv = [
                "resumable_nextest.py",
                "--repo-root", str(root),
                "--intentd-dir", "intentd",
                "--cache-dir", str(root / "cache"),
                "--build-jobs", "2",
                "--test-threads", "1",
                "--label", "test-changed",
                "--plan", "-p alpha --test one",
            ]
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=harness.fake_run
            ), mock.patch.object(
                gate.subprocess, "Popen", side_effect=harness.fake_popen
            ), mock.patch.object(gate.sys, "argv", argv), contextlib.redirect_stdout(
                io.StringIO()
            ) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
                exit_code = gate.main()
            self.assertEqual(exit_code, 2)
            self.assertIn("ERROR: nextest test identifier was not listed", stderr.getvalue())
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], exit_code)
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(stdout.getvalue().splitlines()[-1], f"[test-changed] record: {record_dir}")

    def test_failure_exit_codes_match_main_and_interpreter(self):
        self.assertEqual(gate.failure_exit_code(RuntimeError("x")), gate.HANDLED_ERROR_EXIT)
        self.assertEqual(gate.failure_exit_code(OSError("x")), gate.HANDLED_ERROR_EXIT)
        self.assertEqual(gate.failure_exit_code(subprocess.CalledProcessError(101, ["cargo"])), 101)
        self.assertEqual(gate.failure_exit_code(KeyboardInterrupt()), 130)
        self.assertEqual(gate.failure_exit_code(gate.Terminated(gate.signal.SIGTERM)), 143)
        self.assertEqual(gate.failure_exit_code(AssertionError("x")), 1)

    def test_workspace_fast_path_still_requires_passed_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "intentd").mkdir()
            run_dir = root / "cache" / KEY
            run_dir.mkdir(parents=True)
            (run_dir / "complete").write_text("complete\n", encoding="utf-8")
            harness = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            args = make_args(root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            self.assertEqual(harness.execute(args), 0)
            self.assertEqual(len(harness.run_commands), 1)

    def test_workspace_run_keeps_default_layout_and_appends_trailing_lines(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = PlannedRunHarness(
                root,
                [([event("ok", "alpha::one$passes"), event("ignored", "alpha::one$skipped")], 0)],
            )
            args = make_args(root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            self.assertEqual(harness.execute(args), 0)
            run_dir = root / "cache" / KEY
            self.assertEqual(harness.list_commands[0][3], "--workspace")
            self.assertEqual(harness.run_commands[0][3], "--workspace")
            self.assertIn(KEY, harness.run_commands[0])
            self.assertTrue((run_dir / "complete").is_file())
            self.assertFalse((run_dir / "changed").exists())
            self.assertFalse((run_dir / "run.json").exists())
            config = tomllib.loads((run_dir / "nextest.toml").read_text())
            self.assertEqual(config["store"]["dir"], str(root / "cache"))
            self.assertEqual(config["profile"][KEY]["junit"]["path"], "junit.xml")
            summary = (
                "[test-intentd] summary: 1 passed, 0 failed, 1 skipped/ignored, 0 resumed "
                "(tests already passed for this tree)"
            )
            self.assertEqual(
                harness.output_lines,
                [
                    "[test-intentd] no passed-test record for this tree; running the complete suite",
                    event("ok", "alpha::one$passes").rstrip("\n"),
                    event("ignored", "alpha::one$skipped").rstrip("\n"),
                    summary,
                    f"[test-intentd] record: {run_dir}",
                ],
            )
            self.assertEqual((run_dir / "summary.txt").read_text(), summary + "\n")

    def test_forced_failure_supersedes_earlier_pass_so_resume_reruns_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            run_dir.mkdir(parents=True)
            (run_dir / "passed.jsonl").write_text(
                '{"binary_id":"other","test":"elsewhere"}\n', encoding="utf-8"
            )
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            passes = event("ok", "alpha::one$passes")

            first = PlannedRunHarness(root, [([passes, event("ok", "alpha::one$fails")], 0)])
            self.assertEqual(first.execute(make_args(root)), 0)
            self.assertTrue((record_dir / "complete").is_file())

            forced = PlannedRunHarness(root, [([passes, event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(forced.execute(make_args(root, resume="1", force="1")), 100)
            self.assertFalse((record_dir / "complete").exists())
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"),
                {("alpha::one", "passes"), ("other", "elsewhere")},
            )
            lines = (run_dir / "passed.jsonl").read_text().splitlines()
            self.assertEqual(
                lines[-1], '{"binary_id": "alpha::one", "test": "fails", "outcome": "failed"}'
            )

            resumed = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(resumed.execute(make_args(root, resume="1")), 100)
            self.assertEqual(len(resumed.list_commands), 1)
            self.assertEqual(len(resumed.run_commands), 1)
            profile = tomllib.loads((record_dir / "nextest-1.toml").read_text())["profile"][record_dir.name]
            self.assertEqual(
                profile["default-filter"],
                "not ((binary_id(/^alpha::one$/) and (test(/^passes$/))))",
            )
            self.assertFalse((record_dir / "complete").exists())
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], 100)
            self.assertEqual((run_record["failed"], run_record["skipped_resumed"]), (1, 1))

            fixed = PlannedRunHarness(root, [([event("ok", "alpha::one$fails")], 0)])
            self.assertEqual(fixed.execute(make_args(root, resume="1")), 0)
            self.assertEqual(len(fixed.run_commands), 1)
            self.assertTrue((record_dir / "complete").is_file())
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"),
                {("alpha::one", "passes"), ("alpha::one", "fails"), ("other", "elsewhere")},
            )

    def test_workspace_resume_excludes_test_that_failed_in_a_later_planned_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            workspace = make_args(root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            all_pass = [event("ok", "alpha::one$passes"), event("ok", "alpha::one$fails")]
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(workspace), 0)
            self.assertTrue((run_dir / "complete").is_file())

            planned = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(planned.execute(make_args(root, resume="1", force="1")), 100)
            self.assertFalse((run_dir / "complete").exists())
            self.assertEqual(gate.load_passed(run_dir / "passed.jsonl"), {("alpha::one", "passes")})

            resumed = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(resumed.execute(workspace), 100)
            self.assertEqual(len(resumed.run_commands), 1)
            self.assertEqual(resumed.run_commands[0][3], "--workspace")
            config = tomllib.loads((run_dir / "nextest.toml").read_text())
            self.assertEqual(
                config["profile"][KEY]["default-filter"],
                "not ((binary_id(/^alpha::one$/) and (test(/^passes$/))))",
            )
            self.assertFalse((run_dir / "complete").exists())
            self.assertIn("1 failed", resumed.output_lines[-2])

    def test_completed_plan_does_not_fast_path_over_a_failure_recorded_by_another_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            plan_b = make_args(root, resume="1", plan=["-p alpha"])
            record_b = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha"]))
            all_pass = [event("ok", "alpha::one$passes"), event("ok", "alpha::one$fails")]
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(plan_b), 0)
            self.assertTrue((record_b / "complete").is_file())

            plan_a = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(plan_a.execute(make_args(root, resume="1", force="1")), 100)
            self.assertFalse((record_b / "complete").exists())

            rerun = PlannedRunHarness(root, [([event("ok", "alpha::one$fails")], 0)])
            self.assertEqual(rerun.execute(plan_b), 0)
            self.assertEqual(len(rerun.list_commands), 1)
            self.assertEqual(len(rerun.run_commands), 1)
            profile = tomllib.loads((record_b / "nextest-1.toml").read_text())["profile"][record_b.name]
            self.assertEqual(
                profile["default-filter"],
                "not ((binary_id(/^alpha::one$/) and (test(/^passes$/))))",
            )
            self.assertNotIn("resumed: skipped 2 tests already passed for this tree", rerun.output_lines)
            self.assertTrue((record_b / "complete").is_file())

            skip = PlannedRunHarness(root, [])
            self.assertEqual(skip.execute(plan_b), 0)
            self.assertEqual(skip.run_commands, [])
            self.assertEqual(skip.list_commands, [])
            self.assertEqual(
                skip.output_lines, ["resumed: skipped 2 tests already passed for this tree"]
            )

    def test_invalidate_completion_markers_drops_tree_and_every_plan_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            (run_dir / "complete").write_text("complete\n", encoding="utf-8")
            for plan in ("aaaa", "bbbb"):
                (run_dir / "changed" / plan).mkdir(parents=True)
                (run_dir / "changed" / plan / "complete").write_text("complete\n", encoding="utf-8")
                (run_dir / "changed" / plan / "run.json").write_text("{}\n", encoding="utf-8")
            (run_dir / "passed.jsonl").write_text('{"binary_id":"x","test":"y"}\n', encoding="utf-8")
            gate.invalidate_completion_markers(run_dir)
            self.assertFalse((run_dir / "complete").exists())
            self.assertEqual(list((run_dir / "changed").glob("*/complete")), [])
            self.assertTrue((run_dir / "changed" / "aaaa" / "run.json").is_file())
            self.assertEqual(gate.load_passed(run_dir / "passed.jsonl"), {("x", "y")})
            gate.invalidate_completion_markers(run_dir / "missing")

    def test_observed_failure_invalidates_markers_before_the_run_finishes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            plan_b = make_args(root, resume="1", plan=["-p alpha"])
            record_b = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha"]))
            all_pass = [event("ok", "alpha::one$passes"), event("ok", "alpha::one$fails")]
            workspace = make_args(root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(workspace), 0)
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(plan_b), 0)
            self.assertTrue((run_dir / "complete").is_file())
            self.assertTrue((record_b / "complete").is_file())

            def lines():
                yield event("failed", "alpha::one$fails")
                raise KeyboardInterrupt

            forced = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(forced.execute(make_args(root, resume="1", force="1")), 130)
            self.assertFalse((run_dir / "complete").exists())
            self.assertFalse((record_b / "complete").exists())
            self.assertEqual(gate.load_passed(run_dir / "passed.jsonl"), {("alpha::one", "passes")})

    def test_truncating_the_shared_journal_drops_every_completion_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            plan_b = make_args(root, resume="1", plan=["-p alpha"])
            record_b = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha"]))
            all_pass = [event("ok", "alpha::one$passes"), event("ok", "alpha::one$fails")]
            workspace = make_args(root, resume="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(workspace), 0)
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(plan_b), 0)
            self.assertTrue((run_dir / "complete").is_file())
            self.assertTrue((record_b / "complete").is_file())

            def lines():
                raise KeyboardInterrupt
                yield

            full = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(
                    full.execute(make_args(root, label=gate.DEFAULT_LABEL, plan=None, base=None)),
                    130,
                )
            self.assertEqual(len(full.run_commands), 1)
            self.assertEqual((run_dir / "passed.jsonl").read_text(), "")
            self.assertFalse((run_dir / "complete").exists())
            self.assertFalse((record_b / "complete").exists())

            rerun = PlannedRunHarness(root, [(all_pass, 0)])
            self.assertEqual(rerun.execute(plan_b), 0)
            self.assertEqual(len(rerun.run_commands), 1)
            self.assertTrue((record_b / "complete").is_file())

    def test_plan_marker_cannot_outlive_a_failure_erased_by_an_interrupted_full_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root / "cache" / KEY
            plan_b = make_args(root, resume="1", plan=["-p alpha"])
            record_b = run_dir / "changed" / gate.plan_key(gate.split_plans(["-p alpha"]))
            all_pass = [event("ok", "alpha::one$passes"), event("ok", "alpha::one$fails")]
            self.assertEqual(PlannedRunHarness(root, [(all_pass, 0)]).execute(plan_b), 0)
            self.assertTrue((record_b / "complete").is_file())

            plan_a = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(plan_a.execute(make_args(root, resume="1", force="1")), 100)
            self.assertFalse((record_b / "complete").exists())
            self.assertIn(("alpha::one", "fails"), gate.load_outcomes(run_dir / "passed.jsonl"))

            def lines():
                yield event("ok", "alpha::one$passes")
                raise KeyboardInterrupt

            full = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(
                    full.execute(make_args(root, label=gate.DEFAULT_LABEL, plan=None, base=None)),
                    130,
                )
            self.assertEqual(gate.load_outcomes(run_dir / "passed.jsonl"), {("alpha::one", "passes"): "ok"})
            self.assertFalse((run_dir / "complete").exists())
            self.assertFalse((record_b / "complete").exists())

            resumed = PlannedRunHarness(root, [([event("failed", "alpha::one$fails")], 100)])
            self.assertEqual(resumed.execute(plan_b), 100)
            self.assertEqual(len(resumed.list_commands), 1)
            self.assertEqual(len(resumed.run_commands), 1)
            profile = tomllib.loads((record_b / "nextest-1.toml").read_text())["profile"][record_b.name]
            self.assertEqual(
                profile["default-filter"],
                "not ((binary_id(/^alpha::one$/) and (test(/^passes$/))))",
            )
            self.assertNotIn("resumed: skipped 2 tests already passed for this tree", resumed.output_lines)
            self.assertFalse((record_b / "complete").exists())



if __name__ == "__main__":
    unittest.main()