#!/usr/bin/env python3

import importlib.util
import json
import os
from pathlib import Path
import subprocess
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
            gate.parse_passed_event(event, binary_ids), ("intentd::e2e", "module::passes")
        )
        unit_event = json.dumps(
            {"type": "test", "event": "ok", "name": "intent-core::intent_core$module::unit"}
        )
        self.assertEqual(
            gate.parse_passed_event(unit_event, binary_ids), ("intent-core", "module::unit")
        )
        expression = gate.remaining_filter(
            {("intentd::e2e", "module::passes"), ("intentd::e2e", "module::passes_two")}
        )
        self.assertEqual(
            expression,
            "not ((binary_id(/^intentd::e2e$/) and (test(/^module::passes$/) | "
            "test(/^module::passes_two$/))))",
        )
        self.assertIsNone(
            gate.parse_passed_event('{"type":"test","event":"failed"}', binary_ids)
        )

    def test_pass_event_strips_retry_suffix(self):
        binary_ids = {("intentd::e2e", "module::passes"): "intentd::e2e"}
        retried = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::passes#2"}
        )
        self.assertEqual(
            gate.parse_passed_event(retried, binary_ids), ("intentd::e2e", "module::passes")
        )
        unlisted = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::missing#2"}
        )
        with self.assertRaisesRegex(RuntimeError, "was not listed"):
            gate.parse_passed_event(unlisted, binary_ids)
        not_a_suffix = json.dumps(
            {"type": "test", "event": "ok", "name": "intentd::e2e$module::passes#2x"}
        )
        with self.assertRaisesRegex(RuntimeError, "was not listed"):
            gate.parse_passed_event(not_a_suffix, binary_ids)

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
            args = SimpleNamespace(
                repo_root=root,
                intentd_dir="intentd",
                cache_dir=root / "cache",
                resume="1",
                force="0",
                build_jobs="2",
                test_threads="1",
            )
            with mock.patch.object(gate, "tree_key", return_value=key), mock.patch.object(
                gate, "run", side_effect=AssertionError("cargo must not run")
            ):
                self.assertEqual(gate.run_nextest(args), 0)


if __name__ == "__main__":
    unittest.main()