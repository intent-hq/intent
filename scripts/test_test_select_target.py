"""Exercise `make test-select` against a copy of the Makefile with stub tools.

The recipe must hand E to scripts/resumable_nextest.py byte-for-byte (regex
anchors, spaces, parens, apostrophes) through the caller-policy wrapper, with
the same knobs as `make test`, and refuse a missing E before anything runs.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

# Records every runner invocation (fixture preflights included) as JSON lines.
RUNNER_STUB = """import json, os, sys
with open(os.environ["TEST_SELECT_LOG"], "a") as log:
    log.write(json.dumps({"runner": sys.argv[1:], "policy": os.environ.get("POLICY_WRAPPED"),
                          "e": os.environ.get("E")}) + "\\n")
"""
POLICY_STUB = """#!/usr/bin/env bash
POLICY_WRAPPED=1 exec "$@"
"""
CARGO_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$TEST_SELECT_CARGO_LOG"
"""


class TestSelectTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        # An apostrophe in the checkout path must not break the recipe either.
        self.root = Path(temporary.name) / "reviewer's checkout"
        scripts = self.root / "scripts"
        intentd_scripts = self.root / "packages/intentd/scripts"
        intentd_scripts.mkdir(parents=True)
        (self.root / "packages/intentd/.git").mkdir()
        scripts.mkdir()
        shutil.copy(ROOT / "Makefile", self.root / "Makefile")
        (scripts / "resumable_nextest.py").write_text(RUNNER_STUB)
        (scripts / "check_watch_capacity.py").write_text("")
        policy = intentd_scripts / "with-test-policy.sh"
        policy.write_text(POLICY_STUB)
        self.bin = Path(temporary.name) / "bin"
        self.bin.mkdir()
        cargo = self.bin / "cargo"
        cargo.write_text(CARGO_STUB)
        cargo.chmod(0o755)
        self.log = Path(temporary.name) / "runner.jsonl"
        self.cargo_log = Path(temporary.name) / "cargo.log"

    def run_make(self, *arguments, env=None):
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "E", "RESUME", "GATE_FORCE",
                                    "NO_FAIL_FAST", "HERMETIC", "COMPACT", "BUILD_JOBS",
                                    "TEST_THREADS", "GATE_CACHE_DIR"}}
        environment.update(TEST_SELECT_LOG=str(self.log), TEST_SELECT_CARGO_LOG=str(self.cargo_log),
                           **(env or {}))
        result = subprocess.run(
            ["make", "--no-print-directory", "test-select", *arguments,
             f"CARGO_BIN_DIR={self.bin}", "RUSTUP_CARGO="],
            cwd=self.root, env=environment, text=True, capture_output=True, timeout=60)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def selection_call(self, calls):
        selections = [call for call in calls if "--filterset" in call["runner"]]
        self.assertEqual(len(selections), 1, calls)
        return selections[0]

    def test_filterset_reaches_runner_byte_for_byte_under_caller_policy(self):
        expression = "test(/it's a $/) | (package(intent-acp) & test(=a  b))"
        result, calls = self.run_make(f"E={expression}", "RESUME=1", "NO_FAIL_FAST=1",
                                      "GATE_FORCE=1", "BUILD_JOBS=3", "TEST_THREADS=4")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls[0]["runner"], ["--check-transfer-fixture", str(self.root)],
                         "the transfer fixture preflight runs first, as for make test")
        call = self.selection_call(calls)
        argv = call["runner"]
        self.assertEqual(argv[argv.index("--filterset") + 1], expression)
        self.assertEqual(argv[argv.index("--label") + 1], "test-select")
        for flag, value in (("--resume", "1"), ("--force", "1"), ("--no-fail-fast", "1"),
                            ("--build-jobs", "3"), ("--test-threads", "4"),
                            ("--repo-root", str(self.root)), ("--intentd-dir", "packages/intentd")):
            self.assertEqual(argv[argv.index(flag) + 1], value, flag)
        self.assertNotIn("--plan", argv)
        self.assertEqual(call["policy"], "1", "the runner must run under with-test-policy.sh")

    def test_missing_blank_or_exported_filterset_is_refused_before_anything_runs(self):
        cases = (((), None, "on the make command line"), (("E=",), None, "non-empty"),
                 (("E=   ",), None, "non-empty"),
                 # A stray exported E is not a selection.
                 ((), {"E": "test(/repository_selection/)"}, "on the make command line"))
        for arguments, env, reason in cases:
            with self.subTest(arguments=arguments, env=env):
                result, calls = self.run_make(*arguments, env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("make test-select needs", result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertEqual(calls, [])
                self.assertFalse(self.cargo_log.exists(), "cargo ran before the usage error")

    def test_filterset_is_not_exported_to_children(self):
        result, calls = self.run_make("E=test(/one/)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["e"] for call in calls], [None] * len(calls))


if __name__ == "__main__":
    unittest.main()
