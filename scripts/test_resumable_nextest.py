#!/usr/bin/env python3

import contextlib
import importlib.util
import io
from itertools import product
import json
import os
import shutil
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


def suite_event(kind="ok", crate="alpha", binary="one", **counts):
    return json.dumps({
        "type": "suite", "event": kind,
        "nextest": {"crate": crate, "test_binary": binary, "kind": "test"},
        **counts,
    }) + "\n"


def make_args(root, **overrides):
    values = dict(
        repo_root=root,
        intentd_dir="intentd",
        cache_dir=root / "cache",
        resume="0",
        force="0",
        no_fail_fast="0",
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
        self.run_environments = []
        self.stdout = io.StringIO()

    def fake_run(self, command, cwd, env=None):
        if command[:2] == ["cargo", "metadata"]:
            return json.dumps({"target_directory": str(self.root / "target")})
        assert command[:3] == ["cargo", "nextest", "list"], command
        self.list_commands.append(command)
        return LISTING

    def fake_popen(self, command, **kwargs):
        self.run_commands.append(command)
        self.run_environments.append(kwargs.get("env"))
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


class CallbackPreflightTests(unittest.TestCase):
    def test_missing_fixture_fails_before_cargo_or_resume_credit(self):
        for plans in (None, ["-p intent-acp"], ["-p intent-services --lib --bins --tests"],
                      ["-p alpha --test one", "-p intent-acp --lib"]):
            with self.subTest(plans=plans), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                record = root / "cache" / KEY
                record.mkdir(parents=True)
                (record / "complete").write_text("complete\n")
                (record / "passed.jsonl").write_text(gate.record_line("alpha::one", "passes", "ok"))
                with mock.patch.dict(os.environ, {"INTENT_ACP_CALLBACK_ADAPTER_FIXTURE": ""}), mock.patch.object(
                    gate, "isolated_output_args", return_value=[]
                ) as cargo, mock.patch.object(gate, "tree_key", return_value=KEY) as key:
                    with self.assertRaisesRegex(RuntimeError, "INTENT_ACP_CALLBACK_ADAPTER_FIXTURE"):
                        gate.run_nextest(make_args(root, plan=plans, resume="1"))
                    cargo.assert_not_called()
                    key.assert_not_called()

    def test_selection_is_conservative_but_skips_unrelated_targets(self):
        affected = [[], [["--workspace"]], [["-p", "intent-acp"]],
                    [["-p", "intent-services", "--tests"]], [["--package=intent-acp", "--lib"]],
                    [["-p", "intent-*", "--lib"]], [["-E", "test(callback)"]],
                    [["-p", "alpha", "--unknown-selector"]]]
        unrelated = [[["-p", "alpha", "--lib", "--bins", "--tests"]],
                     [["-p", "intent-acp", "--test", "wire_contract"]],
                     [["-p", "intent-services", "--bins"]],
                     [["-p", "intent-services", "--bin", "helper"]]]
        for plans in affected:
            with self.subTest(plans=plans):
                self.assertTrue(gate.needs_callback_fixture(plans))
        for plans in unrelated:
            with self.subTest(plans=plans):
                self.assertFalse(gate.needs_callback_fixture(plans))


class CallbackValidatorTests(unittest.TestCase):
    """Exercise the component verifier with its own synthetic fixture builder."""

    def setUp(self):
        path = SCRIPT.parents[1] / "packages/intentd/scripts/test-prepare-acp-callback-fixture.py"
        if not path.is_file() or sys.platform != "linux":
            self.skipTest("canonical fixture integration needs intentd and Linux")
        spec = importlib.util.spec_from_file_location("fixture_tests", path)
        fixture_tests = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_tests)
        self.validator = fixture_tests.PREP
        self.temp = tempfile.TemporaryDirectory(prefix="callback gate's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture = fixture_tests.Fixture(self.root)
        self.node = self.root / "node"
        self.node.write_text("synthetic node identity")
        self.component = self.root / "intentd"
        self.component.mkdir()
        self.patch(mock.patch.object(gate, "load_callback_validator", return_value=self.validator))
        self.patch(mock.patch.object(self.validator, "DEFAULT_DESCRIPTOR", self.fixture.descriptor_path))
        self.node_patch = mock.patch.object(self.validator, "node_tool", return_value=self.node)
        self.patch(self.node_patch)
        self.patch(mock.patch.dict(os.environ, {
            gate.CALLBACK_FIXTURE_ENV: str(self.fixture.payload), "NODE_OPTIONS": "", "COMPACT": "0",
        }))
        self.patch(mock.patch.object(self.validator.urllib.request, "urlopen",
                                     side_effect=AssertionError("preflight attempted network")))
        self.patch(mock.patch.object(self.validator, "prepare",
                                     side_effect=AssertionError("preflight attempted provisioning")))

    def patch(self, patch):
        result = patch.start()
        self.addCleanup(patch.stop)
        return result

    def identity(self):
        return gate.callback_fixture_identity(self.component)

    def test_offline_valid_fixture_and_relative_quoted_path(self):
        absolute = self.identity()
        os.environ[gate.CALLBACK_FIXTURE_ENV] = "../original"
        self.assertEqual(self.identity(), absolute)
        self.assertEqual(absolute["manifest"], self.fixture.descriptor["manifest"]["sha256"])
        self.assertEqual(absolute["root"], str(self.fixture.payload))
        self.assertEqual(absolute["node-sha256"], self.validator.digest(self.node))

    def test_cli_loads_canonical_verifier_and_checks_real_node_version_offline(self):
        scripts = self.component / "scripts"
        scripts.mkdir()
        shutil.copy(SCRIPT.parents[1] / "packages/intentd/scripts/prepare-acp-callback-fixture.py", scripts)
        config = self.component / "crates/intent-acp/tests/fixtures"
        config.mkdir(parents=True)
        shutil.copy(self.fixture.descriptor_path, config / "claude-callback-adapter.json")
        for name in ("delta.patch", "files.json"):
            shutil.copy(self.root / name, config)
        self.node.write_text(f"#!{sys.executable}\nprint('v24.21.0')\n")
        self.node.chmod(0o755)
        env = {**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"]}
        command = [sys.executable, "-S", "-B", str(SCRIPT),
                   "--check-callback-fixture", str(self.component)]
        valid = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertIn('"event": "node-tool"', valid.stderr)
        self.node.write_text(f"#!{sys.executable}\nprint('v0.0.0')\n")
        invalid = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(invalid.returncode, 2, invalid.stderr)
        self.assertIn("Node version mismatch", invalid.stderr)
        self.assertIn("No downloads or repairs were attempted", invalid.stderr)

    def test_relative_fixture_reaches_test_children_as_absolute_path(self):
        os.environ[gate.CALLBACK_FIXTURE_ENV] = "../original"
        harness = PlannedRunHarness(self.root, [([event("ok", "alpha::one$passes")], 0)])
        self.assertEqual(harness.execute(make_args(self.root, plan=["-p intent-acp --lib"])), 0)
        self.assertEqual(harness.run_environments[0][gate.CALLBACK_FIXTURE_ENV],
                         str(self.fixture.payload))
        self.assertEqual(os.environ[gate.CALLBACK_FIXTURE_ENV], "../original")

    def test_corrupt_missing_linked_extra_and_wrong_manifest_are_rejected(self):
        target = self.fixture.payload / "dist/index.js"
        original = target.read_bytes()
        target.write_bytes(b"bad fixture")
        with self.assertRaisesRegex(RuntimeError, "mismatch"):
            self.identity()
        target.write_bytes(original)
        target.unlink()
        with self.assertRaisesRegex(RuntimeError, "missing payload"):
            self.identity()
        target.symlink_to(self.node)
        with self.assertRaisesRegex(RuntimeError, "not a regular file"):
            self.identity()
        target.unlink()
        target.write_bytes(original)
        target.chmod(0o755)
        extra = self.fixture.payload / "extra"
        extra.write_text("extra")
        with self.assertRaisesRegex(RuntimeError, "extra payload"):
            self.identity()
        extra.unlink()
        (self.fixture.payload / "FIXTURE-MANIFEST.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "mismatch"):
            self.identity()

    def test_descriptor_lock_and_runtime_identity_use_canonical_checks(self):
        self.fixture.descriptor["lock_sha256"] = "0" * 64
        self.fixture.descriptor_path.write_text(json.dumps(self.fixture.descriptor))
        with self.assertRaisesRegex(RuntimeError, "manifest lock mismatch"):
            self.identity()
        self.fixture.descriptor["lock_sha256"] = self.fixture.manifest["lock_sha256"]
        self.fixture.manifest["runtime_dependencies"] = {"unexpected": {}}
        self.fixture.descriptor["expected_runtime_packages"] = 1
        self.fixture.seal()
        with self.assertRaisesRegex(RuntimeError, "installed package set mismatch"):
            self.identity()

    def test_platform_node_options_and_node_version_constraints(self):
        with mock.patch.object(self.validator.platform, "machine", return_value="aarch64"):
            with self.assertRaisesRegex(RuntimeError, "Linux x64"):
                self.identity()
        with mock.patch.dict(os.environ, {"NODE_OPTIONS": "--require unexpected"}):
            with self.assertRaisesRegex(RuntimeError, "NODE_OPTIONS"):
                self.identity()
        self.node_patch.stop()
        with mock.patch.object(self.validator.shutil, "which", return_value=str(self.node)), mock.patch.object(
            self.validator, "command", return_value="v0.0.0"
        ):
            with self.assertRaisesRegex(RuntimeError, "Node version mismatch"):
                self.identity()

    def test_corruption_after_success_cannot_get_complete_resume_credit(self):
        harness = PlannedRunHarness(self.root, [([event("ok", "alpha::one$passes")], 0)])
        for plans in (None, ["-p intent-acp --lib"]):
            with self.subTest(plans=plans):
                harness.runs = [([event("ok", "alpha::one$passes")], 0)]
                args = make_args(self.root, plan=plans)
                self.assertEqual(harness.execute(args), 0)
                self.assertEqual(harness.execute(make_args(self.root, plan=plans, resume="1")), 0)
                target = self.fixture.payload / "dist/index.js"
                original = target.read_bytes()
                target.write_bytes(b"tampered")
                with mock.patch.object(gate, "isolated_output_args") as cargo:
                    with self.assertRaisesRegex(RuntimeError, "mismatch"):
                        harness.execute(make_args(self.root, plan=plans, resume="1"))
                    cargo.assert_not_called()
                target.write_bytes(original)

    def test_verified_identity_changes_resume_key_without_weakening_other_inputs(self):
        with mock.patch.object(gate, "worktree_tree", return_value="tree"), mock.patch.object(
            gate, "submodule_heads", return_value=[]
        ), mock.patch.object(gate, "required_hash", return_value="hash"), mock.patch.object(
            gate, "run", return_value="version"
        ):
            identity = self.identity()
            key = gate.tree_key(self.root, self.component, [], identity)
            self.assertNotEqual(key, gate.tree_key(self.root, self.component, [], None))
            for field in ("root", "descriptor", "manifest", "node", "node-sha256"):
                changed = {**identity, field: "changed"}
                self.assertNotEqual(key, gate.tree_key(self.root, self.component, [], changed), field)
            self.node.write_text("replacement node, same path")
            self.assertNotEqual(identity, self.identity())
            self.assertNotEqual(key, gate.tree_key(self.root, self.component, [], self.identity()))

    def test_replacing_verified_node_cannot_resume_previous_passes(self):
        harness = PlannedRunHarness(self.root, [([event("ok", "alpha::one$passes")], 0)] * 2)
        original_key = gate.tree_key

        def key(*args):
            with mock.patch.object(gate, "worktree_tree", return_value="tree"), mock.patch.object(
                gate, "submodule_heads", return_value=[]
            ), mock.patch.object(gate, "required_hash", return_value="hash"), mock.patch.object(
                gate, "run", return_value="version"
            ):
                return original_key(*args)

        with mock.patch.object(gate, "tree_key", side_effect=key), mock.patch.object(
            gate, "run", side_effect=harness.fake_run
        ), mock.patch.object(gate.subprocess, "Popen", side_effect=harness.fake_popen), contextlib.redirect_stdout(
            harness.stdout
        ):
            args = make_args(self.root, plan=["-p intent-services --lib"], resume="1")
            self.assertEqual(gate.run_nextest(args), 0)
            self.assertEqual(gate.run_nextest(args), 0)
            self.assertEqual(len(harness.run_commands), 1)
            self.node.write_text("different verified Node bytes")
            self.assertEqual(gate.run_nextest(args), 0)
        self.assertEqual(len(harness.run_commands), 2)
        self.assertNotIn("--no-tests", harness.run_commands[1], "stale passes were credited")
        self.assertEqual(len(list((self.root / "cache").iterdir())), 2)

    def test_setup_commands_quote_paths_and_preserve_provisioner_failure(self):
        component = self.root / "repo's component"
        script = component / "scripts/prepare-acp-callback-fixture.py"
        script.parent.mkdir(parents=True)
        log = self.root / "argv.json"
        script.write_text("import json, sys\n"
                          f"open({str(log)!r}, 'w').write(json.dumps(sys.argv[1:]))\n"
                          "sys.exit(7)\n")
        with mock.patch.dict(os.environ, {"HOME": str(self.root / "user's home")}):
            commands = [line.strip() for line in gate.callback_setup_help(component).splitlines()
                        if line.startswith("    ")]
        self.assertEqual(len(commands), 3)
        for command, route in zip(commands, ("--offline", "--bundle", "--build-from-source")):
            result = subprocess.run(["sh", "-c", command], capture_output=True, text=True)
            self.assertEqual(result.returncode, 7, result.stderr)
            argv = json.loads(log.read_text())
            self.assertEqual(argv[:2], ["--cache-dir", str(self.root / "user's home/.cache/intent/acp-callback-fixture")])
            self.assertEqual(argv[2], route)


class ResumableNextestTests(unittest.TestCase):
    def setUp(self):
        # These tests isolate journaling/selection; canonical fixture coverage
        # lives in CallbackPreflightTests and CallbackValidatorTests.
        patch = mock.patch.object(gate, "callback_fixture_identity", return_value=None)
        patch.start()
        self.addCleanup(patch.stop)

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

    def test_complete_marker_fast_path_does_not_invoke_nextest(self):
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
            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=key), mock.patch.object(
                gate, "run", side_effect=AssertionError("nextest must not run")
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

    def test_suite_ignored_totals_with_missing_terminal_events(self):
        for planned, resume, individual, failed in product(
            (False, True), ("0", "1"), (False, True), (False, True)
        ):
            with self.subTest(planned=planned, resume=resume,
                              individual=individual, failed=failed), \
                    tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                args = make_args(root, resume=resume)
                if not planned:
                    args.plan = None
                run_dir = root / "cache" / KEY
                run_dir.mkdir(parents=True)
                journal = run_dir / "passed.jsonl"
                if resume == "1":
                    journal.write_text(gate.record_line("alpha::one", "passes", "ok"))
                lines = [event("started", "alpha::one$skipped")]
                if individual:
                    lines.append(event("ignored", "alpha::one$skipped"))
                if resume == "0":
                    lines.append(event("ok", "alpha::one$passes"))
                if failed:
                    lines.append(event("failed", "alpha::one$fails"))
                passed = int(resume == "0")
                status = 100 if failed else 0
                lines.append(suite_event(
                    "failed" if failed else "ok", passed=passed,
                    failed=int(failed), ignored=1, filtered_out=17,
                ))
                harness = PlannedRunHarness(root, [(lines, status)])
                self.assertEqual(harness.execute(args), status)
                record_dir = run_dir
                if planned:
                    record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(args.plan))
                    result = json.loads((record_dir / "run.json").read_text())
                    self.assertEqual(
                        (result["passed"], result["failed"], result["ignored"], result["skipped_resumed"]),
                        (passed, int(failed), 1, int(resume)),
                    )
                expected = gate.summary_line(
                    args.label, {"passed": passed, "failed": int(failed), "ignored": 1}, int(resume)
                )
                self.assertEqual((record_dir / "summary.txt").read_text(), expected + "\n")
                self.assertEqual(harness.output_lines[-2], expected)
                self.assertEqual(gate.load_passed(journal), {("alpha::one", "passes")})
                self.assertNotIn("skipped", journal.read_text())
                self.assertEqual((record_dir / "complete").exists(), not failed)

    def test_suite_ignored_totals_are_reconciled_per_suite_and_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = make_args(root, plan=["-p alpha", "-p beta"])
            summary = suite_event(ignored=1, passed=0, failed=0)
            lines = [
                event("ignored", "beta::two$skipped"),
                event("started", "alpha::one$skipped"),
                summary,
                summary,
            ]
            harness = PlannedRunHarness(root, [(lines, 0), ([summary], 0)])
            self.assertEqual(harness.execute(args), 0)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(args.plan))
            result = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(result["ignored"], 3)
            self.assertEqual([row["ignored"] for row in result["results"]], [2, 1])
            self.assertEqual((result["passed"], result["failed"]), (0, 0))

    def test_suite_ignored_count_requires_valid_terminal_summary(self):
        for kind in ("ok", "failed"):
            self.assertEqual(gate.suite_ignored_count(suite_event(kind, ignored=2)), ("alpha::one", 2))
        for line in (
            "not json", "[]", event("ignored", "alpha::one$skipped"),
            suite_event("started", ignored=1), suite_event(),
            suite_event(ignored=-1), suite_event(ignored=True),
            suite_event(ignored="1"), suite_event(ignored=1.5),
            suite_event(crate=None, ignored=1), suite_event(binary="", ignored=1),
            '{"type":"suite","event":"ok","ignored":1}',
            '{"type":"suite","event":"ok","ignored":1,"nextest":[]}',
        ):
            with self.subTest(line=line):
                self.assertIsNone(gate.suite_ignored_count(line))

    def test_suite_ignored_reconciliation_preserves_partial_and_interrupted_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def lines():
                yield event("ignored", "alpha::one$skipped")
                yield event("started", "alpha::one$missing")
                yield suite_event(ignored=2, passed=0, failed=0)
                yield event("ignored", "beta::two$skipped")
                raise KeyboardInterrupt

            args = make_args(root)
            harness = PlannedRunHarness(root, [(lines(), 0)])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(harness.execute(args), 130)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(args.plan))
            result = json.loads((record_dir / "run.json").read_text())
            self.assertEqual((result["passed"], result["failed"], result["ignored"]), (0, 0, 3))
            self.assertFalse((record_dir / "complete").exists())

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
            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=AssertionError("nextest must not run")
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

    def test_no_fail_fast_flag_is_forwarded_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            default = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(default.execute(make_args(root)), 0)
            self.assertNotIn("--no-fail-fast", default.run_commands[0])

            enabled = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(enabled.execute(make_args(root, no_fail_fast="1")), 0)
            self.assertIn("--no-fail-fast", enabled.run_commands[0])
            self.assertTrue(
                (root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"])) / "complete").is_file()
            )

            workspace = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            args = make_args(root, no_fail_fast="1", label=gate.DEFAULT_LABEL, plan=None, base=None)
            self.assertEqual(workspace.execute(args), 0)
            self.assertEqual(workspace.run_commands[0][3], "--workspace")
            self.assertIn("--no-fail-fast", workspace.run_commands[0])

    def test_no_fail_fast_runs_every_plan_and_returns_first_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plans = ["-p alpha --test one", "-p beta"]
            harness = PlannedRunHarness(
                root,
                [
                    ([event("ok", "alpha::one$passes"), event("failed", "alpha::one$fails")], 100),
                    ([event("ok", "alpha::one$skipped")], 0),
                ],
            )
            self.assertEqual(harness.execute(make_args(root, plan=plans, no_fail_fast="1")), 100)
            self.assertEqual(len(harness.run_commands), 2)
            for command in harness.run_commands:
                self.assertIn("--no-fail-fast", command)
            run_dir = root / "cache" / KEY
            record_dir = run_dir / "changed" / gate.plan_key(gate.split_plans(plans))
            self.assertFalse((record_dir / "complete").exists())
            self.assertFalse((run_dir / "complete").exists())
            run_record = json.loads((record_dir / "run.json").read_text())
            self.assertEqual(run_record["exit_code"], 100)
            self.assertEqual(
                run_record["results"],
                [
                    {"plan": plans[0], "passed": 1, "failed": 1, "ignored": 0, "exit_code": 100},
                    {"plan": plans[1], "passed": 1, "failed": 0, "ignored": 0, "exit_code": 0},
                ],
            )
            self.assertEqual(
                harness.output_lines[-2:],
                [
                    "[test-changed] summary: 2 passed, 1 failed, 0 skipped/ignored, 0 resumed "
                    "(tests already passed for this tree)",
                    f"[test-changed] record: {record_dir}",
                ],
            )
            self.assertEqual(
                gate.load_passed(run_dir / "passed.jsonl"),
                {("alpha::one", "passes"), ("alpha::one", "skipped")},
            )

            trailing = PlannedRunHarness(
                root,
                [
                    ([event("ok", "alpha::one$passes")], 0),
                    ([event("failed", "alpha::one$fails")], 100),
                    ([event("failed", "alpha::one$skipped")], 101),
                ],
            )
            three = plans + ["-p gamma"]
            self.assertEqual(trailing.execute(make_args(root, plan=three, no_fail_fast="1")), 100)
            self.assertEqual(len(trailing.run_commands), 3)
            record_three = run_dir / "changed" / gate.plan_key(gate.split_plans(three))
            results = json.loads((record_three / "run.json").read_text())["results"]
            self.assertEqual([result["exit_code"] for result in results], [0, 100, 101])
            self.assertFalse((record_three / "complete").exists())

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
            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
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
                stdout.getvalue().splitlines()[1:], [summary, f"[test-changed] record: {record_dir}"]
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
    resume="0", force="0", no_fail_fast="0", build_jobs="2", test_threads="1", label="test-changed",
    plan=["-p alpha --test one"], base=None)
with mock.patch.object(gate, "tree_key", return_value={KEY!r}), mock.patch.object(
    gate, "run", return_value={LISTING!r}
), mock.patch.object(gate, "isolated_output_args", return_value=[]
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

    def test_ignored_only_completed_plan_resumes_without_nextest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = PlannedRunHarness(root, [([event("ignored", "alpha::one$skipped")], 0)])
            self.assertEqual(harness.execute(make_args(root)), 0)
            record_dir = root / "cache" / KEY / "changed" / gate.plan_key(gate.split_plans(["-p alpha --test one"]))
            self.assertTrue((record_dir / "complete").is_file())
            self.assertEqual(gate.load_passed(root / "cache" / KEY / "passed.jsonl"), set())

            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "run", side_effect=AssertionError("nextest must not run")
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
            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
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

            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
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
            with mock.patch.object(gate, "isolated_output_args", return_value=[]), mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
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
                harness.output_lines[1:],
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


class IsolatedOutputTests(unittest.TestCase):
    def test_stable_checkout_identity_and_separate_storage_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first"
            first.mkdir()
            alias = root / "alias"
            alias.symlink_to(first, target_is_directory=True)
            metadata = {"target_directory": str(root / "target"),
                        "build_directory": str(root / "build 🚀")}
            with mock.patch.object(gate, "run", return_value=json.dumps(metadata)) as run:
                original = gate.isolated_output_args(first, ["--config", "profile.test.debug=0"], {})
                self.assertEqual(original, gate.isolated_output_args(alias, [], {}))
                with mock.patch.object(gate, "run", return_value=json.dumps({
                    "target_directory": original[1],
                    "build_directory": json.loads(original[3].split("=", 1)[1]),
                })):
                    self.assertEqual(original, gate.isolated_output_args(first, [], {}))
                parsed = tomllib.loads(original[3])
                self.assertIn("🚀", parsed["build"]["build-dir"])
                other = gate.isolated_output_args(root / "other", [], {})
                self.assertNotEqual(original[1], other[1])
                self.assertNotEqual(original[3], other[3])
                self.assertTrue(Path(original[1]).is_relative_to(root / "target"))
                self.assertTrue(Path(json.loads(original[3].split("=", 1)[1])).is_relative_to(root / "build 🚀"))
                self.assertEqual(run.call_args_list[0].args[0],
                                 ["cargo", "metadata", "--no-deps", "--format-version", "1",
                                  "--config", "profile.test.debug=0"])

    def test_invalid_output_metadata_fails_closed(self):
        for target in (None, 5, "relative"):
            with self.subTest(target=target), mock.patch.object(
                gate, "run", return_value=json.dumps({"target_directory": target})
            ):
                with self.assertRaisesRegex(RuntimeError, "invalid target_directory"):
                    gate.isolated_output_args(Path.cwd(), [], {})


class EffectiveOutputResumeTests(unittest.TestCase):
    def test_metadata_failure_cannot_accept_complete_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            harness = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)])
            self.assertEqual(harness.execute(make_args(root)), 0)
            failure = subprocess.CalledProcessError(101, ["cargo", "metadata"])
            with mock.patch.object(gate, "tree_key", return_value=KEY), mock.patch.object(
                gate, "isolated_output_args", side_effect=failure
            ), contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 101)
            self.assertIn("resolving Cargo outputs", stderr.getvalue())

    def test_resolved_output_changes_cannot_reuse_completed_record(self):
        if not shutil.which("cargo"):
            self.skipTest("real output resolution requires Cargo")
        for mode in ("cargo-home-template", "retargeted-output-symlink"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                harness = PlannedRunHarness(root, [([event("ok", "alpha::one$passes")], 0)] * 2)
                source = root / "intentd"
                (source / "src").mkdir()
                (source / "Cargo.toml").write_text('[package]\nname="probe"\nversion="0.0.0"\nedition="2021"\n')
                (source / "src/lib.rs").write_text("")
                first, second = root / "first", root / "second"
                first.mkdir()
                second.mkdir()
                alias = root / "output"
                alias.symlink_to(first, target_is_directory=True)
                env = {k: v for k, v in os.environ.items()
                       if not k.startswith(("CARGO_", "RUST", "NEXTEST_")) and k != "COMPACT"}
                env.update(CARGO_HOME=str(first), RUSTUP_AUTO_INSTALL="0")
                if mode == "cargo-home-template":
                    env["CARGO_BUILD_BUILD_DIR"] = "{cargo-cache-home}/build"
                else:
                    env["CARGO_TARGET_DIR"] = str(alias)
                real_popen = subprocess.Popen
                def run(command, cwd, env=None):
                    if command[:2] == ["cargo", "metadata"]:
                        with mock.patch.object(subprocess, "Popen", real_popen):
                            return subprocess.check_output(command, cwd=cwd, env=env, text=True, timeout=30)
                    if command[:3] == ["cargo", "nextest", "list"]:
                        return harness.fake_run(command, cwd, env)
                    return "stable tool version"
                with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
                    gate, "worktree_tree", return_value="stable source"
                ), mock.patch.object(gate, "submodule_heads", return_value="stable pins"), mock.patch.object(
                    gate, "required_hash", return_value="stable file"
                ), mock.patch.object(gate, "build_settings", return_value={}), mock.patch.object(
                    gate, "run", side_effect=run
                ), mock.patch.object(gate.subprocess, "Popen", side_effect=harness.fake_popen), contextlib.redirect_stdout(harness.stdout):
                    # Metadata must remain real even while nextest execution is stubbed.
                    with mock.patch.object(gate, "isolated_output_args", wraps=gate.isolated_output_args):
                        self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 0)
                        self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 0)
                        self.assertEqual(len(harness.run_commands), 1)
                        if mode == "cargo-home-template":
                            os.environ["CARGO_HOME"] = str(second)
                        else:
                            alias.unlink()
                            alias.symlink_to(second, target_is_directory=True)
                        self.assertEqual(gate.run_nextest(make_args(root, resume="1")), 0)
                self.assertEqual(len(harness.run_commands), 2, "changed effective outputs reused a completed record")


class SharedTargetInventoryTests(unittest.TestCase):
    def test_other_worktree_build_cannot_replace_listed_gate_inventory(self):
        """A second Cargo writer runs while nextest waits to list its first binary."""
        if not shutil.which("cargo") or not shutil.which("rustc"):
            self.skipTest("real Cargo/nextest control requires installed Rust tools")
        available = subprocess.run(["cargo", "nextest", "--version"], capture_output=True)
        if available.returncode:
            self.skipTest("real Cargo/nextest control requires installed nextest")
        for mode in ("environment", "config", "separate-build", "relative"):
            with self.subTest(mode=mode):
                self.check_other_worktree(mode)

    def check_other_worktree(self, mode):
        with tempfile.TemporaryDirectory(prefix="intent-gate-inventory-") as temporary:
            root = Path(temporary)
            first, second, target = root / "first", root / "second", root / "target"
            build = root / "build" if mode == "separate-build" else target
            first.mkdir()
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(("CARGO_", "RUST", "NEXTEST_")) and k != "COMPACT"}
            env["RUSTUP_AUTO_INSTALL"] = "0"
            if mode in {"environment", "relative"}:
                env["CARGO_TARGET_DIR"] = "../target" if mode == "relative" else str(target)
            else:
                (first / ".cargo").mkdir()
                (first / ".cargo/config.toml").write_text(
                    f'[build]\ntarget-dir={json.dumps(str(target))}\n'
                    f'build-dir={json.dumps(str(build))}\n')
            def command(args, cwd=first):
                result = subprocess.run(args, cwd=cwd, env=env, text=True,
                                        capture_output=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result.stdout
            command(["git", "init", "-q"])
            (first / "src").mkdir()
            (first / "Cargo.toml").write_text(
                '[package]\nname="inventory-probe"\nversion="0.0.0"\nedition="2021"\n')
            (first / "src/lib.rs").write_text('#[test] fn first_only() {}\n')
            command(["git", "add", "."])
            command(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                     "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"])
            command(["git", "worktree", "add", "--detach", str(second), "HEAD"])
            (second / "src/lib.rs").write_text('#[test] fn second_only() {}\n')
            host = next(line.split(": ", 1)[1] for line in command(["rustc", "-vV"]).splitlines()
                        if line.startswith("host: "))
            runner = root / "runner.py"
            runner.write_text(
                "import json, os, subprocess, sys\n"
                "from pathlib import Path\n"
                "if '--list' in sys.argv and '--ignored' not in sys.argv:\n"
                f"    Path({str(second / 'src/lib.rs')!r}).write_text('#[test] fn second_only() {{}}\\n')\n"
                "    env = {k: v for k, v in os.environ.items() if not k.startswith(('CARGO', 'NEXTEST_', 'RUST'))}\n"
                f"    env.update(CARGO_TARGET_DIR={str(target)!r}, CARGO_BUILD_BUILD_DIR={str(build)!r}, RUSTUP_AUTO_INSTALL='0', NEXTEST_EXPERIMENTAL_LIBTEST_JSON='1')\n"
                f"    result = subprocess.run(['cargo', 'nextest', 'list', '--offline', '--lib', '--message-format', 'json'], cwd={str(second)!r}, env=env, check=True, text=True, stdout=subprocess.PIPE, timeout=30)\n"
                f"    execution = subprocess.run(['cargo', 'nextest', 'run', '--offline', '--lib', '--message-format', 'libtest-json-plus', '--message-format-version', '0.1'], cwd={str(second)!r}, env=env, check=True, text=True, stdout=subprocess.PIPE, timeout=30)\n"
                "    events = [json.loads(line) for line in execution.stdout.splitlines()]\n"
                f"    with open({str(root / 'interference')!r}, 'a') as log: log.write(json.dumps([sys.argv, json.loads(result.stdout), events]) + '\\n')\n"
                "os.execv(sys.argv[1], sys.argv[1:])\n")
            env['CARGO_TARGET_' + host.upper().replace('-', '_') + '_RUNNER'] = (
                gate.shlex.join([sys.executable, str(runner)]))
            args = make_args(root, intentd_dir=first, plan=["-p inventory-probe --lib"], build_jobs="1")
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
                gate, "tree_key", return_value=KEY
            ):
                status = gate.run_nextest(args)
            self.assertEqual(status, 0)
            self.assertTrue((root / 'interference').is_file(), "second writer never ran")
            interference = [json.loads(line) for line in (root / 'interference').read_text().splitlines()]
            for argv, listing, events in interference:
                other = listing['rust-suites']['inventory-probe']
                self.assertEqual(set(other['testcases']), {'second_only'})
                self.assertNotEqual(argv[1], other['binary-path'])
                passed = [e['name'] for e in events if e.get('type') == 'test' and e.get('event') == 'ok']
                self.assertEqual(passed, ['inventory-probe::inventory_probe$second_only'])
            outcomes = gate.load_outcomes(root / "cache" / KEY / "passed.jsonl")
            self.assertEqual({name for (_, name) in outcomes}, {"first_only"})
            record = root / "cache" / KEY / "changed" / gate.plan_key([["-p", "inventory-probe", "--lib"]])
            result = json.loads((record / "run.json").read_text())
            self.assertEqual(result["passed"], 1)
            self.assertEqual(result["cargo_output_args"][0], "--target-dir")
            self.assertTrue((record / "complete").is_file())
            outputs = json.loads((record / "cargo-outputs.json").read_text())
            self.assertEqual(outputs["source_root"], str(first.resolve()))
            self.assertEqual(outputs["args"], result["cargo_output_args"])


class CallerPolicyResumeTests(unittest.TestCase):
    def test_direct_runner_policy_is_honest_and_incompatible_records_do_not_resume(self):
        # Keep all source/config/output inputs identical: only effective child
        # policy may separate these records. Direct runner use does not arm it.
        for plans in ([], ["-p alpha --test one"]):
            with self.subTest(plans=plans), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                harness = PlannedRunHarness(root, [])
                seen_env = []
                inputs = []
                dumps = json.dumps

                def capture_inputs(value, **kwargs):
                    if isinstance(value, dict) and "root-tree" in value:
                        inputs.append(value.copy())
                    return dumps(value, **kwargs)

                def run(command, cwd, env=None):
                    if command in (["rustc", "-vV"], ["cargo", "-V"], ["cargo", "nextest", "--version"]):
                        return "version"
                    return harness.fake_run(command, cwd, env)

                def popen(command, **kwargs):
                    seen_env.append(kwargs["env"].get("INTENTD_ASSERT_BOUND_CALLER"))
                    harness.run_commands.append(command)
                    return FakeProcess([event("ok", "alpha::one$passes")], 0)

                with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                    gate, "worktree_tree", return_value="tree"
                ), mock.patch.object(gate, "submodule_heads", return_value=[]), mock.patch.object(
                    gate, "required_hash", return_value="hash"
                ), mock.patch.object(gate, "build_settings", return_value={}), mock.patch.object(
                    gate, "run", side_effect=run
                ), mock.patch.object(gate.subprocess, "Popen", side_effect=popen), mock.patch.object(
                    gate.json, "dumps", side_effect=capture_inputs
                ), contextlib.redirect_stdout(harness.stdout):
                    args = make_args(root, plan=plans, resume="1")
                    for value in (None, "", "0", "false", "1"):
                        if value is None:
                            os.environ.pop("INTENTD_ASSERT_BOUND_CALLER", None)
                        else:
                            os.environ["INTENTD_ASSERT_BOUND_CALLER"] = value
                        before = len(seen_env)
                        self.assertEqual(gate.run_nextest(args), 0)
                        self.assertEqual(seen_env[before:], [value], "different policy reused passing credit")
                        self.assertEqual(gate.run_nextest(args), 0)
                        self.assertEqual(len(seen_env), before + 1, "same policy failed to resume")
                    self.assertEqual(len(list(args.cache_dir.glob("*/passed.jsonl"))), 5)
                    for value in inputs:
                        self.assertIn("test-policy", value)
                    self.assertEqual(inputs[-1]["test-policy"], {"INTENTD_ASSERT_BOUND_CALLER": "1"})

                    # Seed a genuine schema-2 input hash (no policy field), with
                    # complete evidence for both full and planned scopes.
                    legacy = inputs[-1].copy()
                    legacy.pop("test-policy")
                    legacy["schema"] = 2
                    key = gate.hashlib.sha256(dumps(legacy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                    shutil.rmtree(args.cache_dir)
                    record = args.cache_dir / key
                    record.mkdir(parents=True)
                    (record / "passed.jsonl").write_text(gate.record_line("alpha::one", "passes", "ok"))
                    (record / "complete").touch()
                    planned = record / "changed" / gate.plan_key(gate.split_plans(plans))
                    planned.mkdir(parents=True)
                    (planned / "complete").touch()
                    before = len(seen_env)
                    self.assertGreater(gate.SCHEMA_VERSION, 2)
                    self.assertEqual(gate.run_nextest(args), 0)
                    self.assertEqual(seen_env[before:], ["1"], "legacy evidence skipped armed verification")
                    self.assertEqual(gate.run_nextest(args), 0)
                    self.assertEqual(len(seen_env), before + 1)


if __name__ == "__main__":
    unittest.main()
