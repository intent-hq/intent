"""Exercise `make test-stress` against a copy of the Makefile with stub tools.

The recipe must reach scripts/resumable_nextest.py through the same caller-policy
wrapper and knobs as `make test-select`, hand E over byte-for-byte with the
stress options, and refuse a bad E, COUNT, LOAD, LOAD_CPUS or STALL* before anything runs.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

RUNNER_STUB = """import json, os, sys
with open(os.environ["TEST_STRESS_LOG"], "a") as log:
    log.write(json.dumps({"runner": sys.argv[1:], "policy": os.environ.get("POLICY_WRAPPED"),
                          "leaked": {k: os.environ.get(k) for k in ("E", "COUNT", "LOAD", "LOAD_CPUS", "LOAD_CORES",
                                                                     "STALL", "STALL_MS", "STALL_EVERY_MS")},
                          "multiplier": os.environ.get("INTENTD_TEST_TIMEOUT_MULTIPLIER")}) + "\\n")
"""
POLICY_STUB = """#!/usr/bin/env bash
POLICY_WRAPPED=1 exec "$@"
"""
# Records the Postgres feature hint's argv; HINT_STUB_EXIT makes it fail.
HINT_STUB = """import json, os, sys
with open(os.environ["HINT_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(int(os.environ.get("HINT_STUB_EXIT", "0")))
"""
CARGO_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$TEST_STRESS_CARGO_LOG"
"""


class TestStressTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "reviewer's checkout"
        scripts = self.root / "scripts"
        intentd_scripts = self.root / "packages/intentd/scripts"
        intentd_scripts.mkdir(parents=True)
        (self.root / "packages/intentd/.git").mkdir()
        scripts.mkdir()
        shutil.copy(ROOT / "Makefile", self.root / "Makefile")
        (scripts / "resumable_nextest.py").write_text(RUNNER_STUB)
        (scripts / "check_watch_capacity.py").write_text("")
        (scripts / "postgres_store_hint.py").write_text(HINT_STUB)
        shutil.copy(ROOT / "scripts/intentd_tree_preflight.py", scripts)
        (intentd_scripts / "with-test-policy.sh").write_text(POLICY_STUB)
        self.bin = Path(temporary.name) / "bin"
        self.bin.mkdir()
        cargo = self.bin / "cargo"
        cargo.write_text(CARGO_STUB)
        cargo.chmod(0o755)
        self.log = Path(temporary.name) / "runner.jsonl"
        self.cargo_log = Path(temporary.name) / "cargo.log"
        self.hint_log = Path(temporary.name) / "hint.jsonl"

    def run_make(self, *arguments, env=None):
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "E", "RESUME", "GATE_FORCE",
                                    "NO_FAIL_FAST", "FEATURES", "HERMETIC", "COMPACT", "BUILD_JOBS", "TEST_THREADS",
                                    "GATE_CACHE_DIR", "COUNT", "LOAD", "LOAD_CPUS", "LOAD_CORES", "STALL", "STALL_MS",
                                    "STALL_EVERY_MS",
                                    "INTENTD_TEST_TIMEOUT_MULTIPLIER", "BASE", "HINT_STUB_EXIT"}}
        # HERMETIC defaults from the host (Linux + working bwrap); pin the
        # unwrapped mode so the runner argv is the same on every host.
        environment.update(HERMETIC="0", TEST_STRESS_LOG=str(self.log), HINT_LOG=str(self.hint_log), TEST_STRESS_CARGO_LOG=str(self.cargo_log),
                           **(env or {}))
        result = subprocess.run(
            ["make", "--no-print-directory", "test-stress", *arguments,
             f"CARGO_BIN_DIR={self.bin}", "RUSTUP_CARGO="],
            cwd=self.root, env=environment, text=True, capture_output=True, timeout=60)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def stress_call(self, calls):
        selections = [call for call in calls if "--filterset" in call["runner"]]
        self.assertEqual(len(selections), 1, calls)
        return selections[0]

    def test_filterset_and_stress_options_reach_runner_under_caller_policy(self):
        expression = "test(/it's a $/) | (package(intent-acp) & test(=a  b))"
        result, calls = self.run_make(f"E={expression}", "COUNT=200", "LOAD=1", "LOAD_CPUS=64",
                                      "LOAD_CORES=8", "STALL=1", "STALL_MS=1100", "STALL_EVERY_MS=300",
                                      "BUILD_JOBS=3", "TEST_THREADS=4")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls[0]["runner"], ["--check-transfer-fixture", str(self.root)],
                         "the transfer fixture preflight runs first, as for test-select")
        call = self.stress_call(calls)
        argv = call["runner"]
        for flag, value in (("--filterset", expression), ("--label", "test-stress"),
                            ("--stress-count", "200"), ("--load", "1"), ("--load-cpus", "64"), ("--load-cores", "8"),
                            ("--stall", "1"), ("--stall-ms", "1100"), ("--stall-every-ms", "300"),
                            ("--build-jobs", "3"), ("--test-threads", "4"),
                            ("--repo-root", str(self.root)), ("--intentd-dir", "packages/intentd")):
            self.assertEqual(argv[argv.index(flag) + 1], value, flag)
        self.assertEqual(call["policy"], "1", "the runner must run under with-test-policy.sh")
        self.assertEqual(call["multiplier"], "3", "same 3x time-limit default as test-select")
        self.assertEqual(call["leaked"], {"E": None, "COUNT": None, "LOAD": None, "LOAD_CPUS": None,
                                          "LOAD_CORES": None, "STALL": None, "STALL_MS": None,
                                          "STALL_EVERY_MS": None})

    def test_load_cores_all_opts_out_of_pinning(self):
        result, calls = self.run_make("E=test(/one/)", "LOAD=1", "LOAD_CORES=all")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        argv = self.stress_call(calls)["runner"]
        self.assertEqual(argv[argv.index("--load-cores") + 1], "all")

    def test_defaults_are_100_iterations_without_load_or_stalls(self):
        result, calls = self.run_make("E=test(/one/)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        argv = self.stress_call(calls)["runner"]
        self.assertEqual(argv[argv.index("--stress-count") + 1], "100")
        self.assertEqual(argv[argv.index("--load") + 1], "0")
        self.assertNotIn("--load-cpus", argv)
        self.assertNotIn("--load-cores", argv, "the runner picks the default core set")
        self.assertEqual(argv[argv.index("--stall") + 1], "0")
        self.assertNotIn("--stall-ms", argv)
        self.assertNotIn("--stall-every-ms", argv)

    def test_bad_arguments_are_refused_before_anything_runs(self):
        cases = (((), None, "on the make command line"), (("E=",), None, "non-empty"),
                 ((), {"E": "test(/x/)"}, "on the make command line"),
                 (("E=test(/x/)", "COUNT=0"), None, "COUNT to be a positive integer"),
                 (("E=test(/x/)", "COUNT=abc"), None, "COUNT to be a positive integer"),
                 (("E=test(/x/)", "COUNT=1 2"), None, "COUNT to be a positive integer"),
                 (("E=test(/x/)", "COUNT=1'; touch pwned; '"), None, "COUNT to be a positive integer"),
                 (("E=test(/x/)", "LOAD=2"), None, "LOAD=0 or LOAD=1"),
                 (("E=test(/x/)", "LOAD="), None, "LOAD=0 or LOAD=1"),
                 (("E=test(/x/)", "LOAD_CPUS=-1"), None, "LOAD_CPUS to be a positive integer"),
                 (("E=test(/x/)", "LOAD_CORES=0"), None, "LOAD_CORES to be a positive integer or all"),
                 (("E=test(/x/)", "LOAD_CORES=half"), None, "LOAD_CORES to be a positive integer or all"),
                 (("E=test(/x/)", "LOAD_CORES=all all"), None, "LOAD_CORES to be a positive integer or all"),
                 (("E=test(/x/)", "LOAD_CORES=2'; touch pwned; '"), None,
                  "LOAD_CORES to be a positive integer or all"),
                 (("E=test(/x/)", "STALL=yes"), None, "STALL=0 or STALL=1"),
                 (("E=test(/x/)", "STALL="), None, "STALL=0 or STALL=1"),
                 (("E=test(/x/)", "STALL_MS=0.5"), None, "STALL_MS to be a positive integer"),
                 (("E=test(/x/)", "STALL_EVERY_MS=0"), None, "STALL_EVERY_MS to be a positive integer"))
        for arguments, env, reason in cases:
            with self.subTest(arguments=arguments, env=env):
                result, calls = self.run_make(*arguments, env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("make test-stress needs", result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertEqual(calls, [])
                self.assertFalse(self.cargo_log.exists(), "cargo ran before the usage error")
                self.assertFalse((self.root / "pwned").exists())


    def test_features_reach_the_runner_quoted_and_only_from_the_make_line(self):
        # The Postgres store tests are behind intent-store/postgres; without
        # FEATURES the filter selects nothing (and the runner fails the run).
        result, calls = self.run_make("E=test(/one/)", "FEATURES= intent-store/postgres a'b ")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        argv = self.stress_call(calls)["runner"]
        self.assertEqual(argv[argv.index("--features") + 1], "intent-store/postgres a'b",
                         "quoted byte-for-byte; the runner validates and normalizes it")
        self.log.unlink()
        result, calls = self.run_make("E=test(/one/)", "FEATURES=a/b,c ,")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        argv = self.stress_call(calls)["runner"]
        self.assertEqual(argv[argv.index("--features") + 1], "a/b c", "commas become spaces")
        for arguments, env in (((), None), ((), {"FEATURES": "intent-store/postgres"}),
                               (("FEATURES=",), None), (("FEATURES= , ,",), None)):
            with self.subTest(arguments=arguments, env=env):
                self.log.unlink(missing_ok=True)
                result, calls = self.run_make("E=test(/one/)", *arguments, env=env)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("--features", self.stress_call(calls)["runner"])

    def test_postgres_feature_hint_gets_the_selection_and_never_fails_the_run(self):
        # Without intent-store/postgres a filtered run silently skips the
        # Postgres store tests (intentd#3672); the hint names them.
        expression = "test(/it's/)"
        for arguments, base in (((), "origin/main"), (("BASE=feature base",), "feature base")):
            with self.subTest(arguments=arguments):
                self.hint_log.unlink(missing_ok=True)
                result, calls = self.run_make(f"E={expression}", "FEATURES=intent-store/postgres,b", *arguments)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                hints = [json.loads(line) for line in self.hint_log.read_text().splitlines()]
                self.assertEqual(hints, [["--label", "test-stress", "--intentd-dir", "packages/intentd",
                                          "--base", base, "--features", "intent-store/postgres b",
                                          "--filterset", expression]])
        result, calls = self.run_make("E=test(/one/)", env={"HINT_STUB_EXIT": "1"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue([call for call in calls if "--filterset" in call["runner"]], calls)

if __name__ == "__main__":
    unittest.main()
