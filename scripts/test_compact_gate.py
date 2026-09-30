"""Compact gate contracts, with an optional offline tiny-crate Cargo smoke test."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from unittest import mock

from scripts import resumable_nextest as gate

ROOT = Path(__file__).resolve().parents[1]


class CompactSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.root)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        (self.repo / "Cargo.toml").write_text('''
[profile.dev]
debug = "line-tables-only"
[profile.dev.package.alpha]
debug = 2
[profile.dev.package."*"]
debug = false
strip = "none"
[profile.test.package.beta]
debug = 1
''')

    def config_values(self):
        args = gate.compact_config(self.repo)
        self.assertTrue(all(arg == "--config" for arg in args[::2]))
        return dict(value.split("=", 1) for value in args[1::2])

    def test_default_and_zero_do_not_change_settings(self):
        for value in (None, "0"):
            if value is not None:
                os.environ["COMPACT"] = value
            before = dict(os.environ)
            self.assertEqual(gate.compact_config(self.repo), [])
            self.assertEqual(gate.compact_env(), before)

    def test_compact_overrides_inherited_packages_and_build_scripts(self):
        os.environ["COMPACT"] = "1"
        values = self.config_values()
        for profile in ("dev", "test"):
            for suffix in ("", ".build-override", '.package."*"', '.package."alpha"', '.package."beta"'):
                self.assertEqual(values[f"profile.{profile}{suffix}.debug"], "0")
                self.assertEqual(values[f"profile.{profile}{suffix}.strip"], '"none"')
        self.assertEqual(gate.compact_env()["CARGO_INCREMENTAL"], "0")

    def test_flag_sources_and_wrappers_are_untouched(self):
        values = {
            "COMPACT": "1", "CARGO_INCREMENTAL": "1",
            "RUSTFLAGS": "--cfg plain -C debuginfo=2",
            "CARGO_ENCODED_RUSTFLAGS": '--cfg\x1fencoded="has space"\x1f-Cdebuginfo=1',
            "CARGO_BUILD_RUSTFLAGS": "--cfg build",
            "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS": "--cfg target",
            "RUSTC_WRAPPER": "/some wrapper", "RUSTC_WORKSPACE_WRAPPER": "/another",
        }
        os.environ.update(values)
        self.assertEqual(gate.compact_env(), {**os.environ, "CARGO_INCREMENTAL": "0"})
        self.assertEqual(os.environ["CARGO_INCREMENTAL"], "1")
        self.assertFalse(any("rustflags" in value for value in gate.compact_config(self.repo)))

    def test_cargo_config_package_entries_and_legacy_precedence(self):
        os.environ["COMPACT"] = "1"
        config_dir = self.root / ".cargo"
        config_dir.mkdir()
        (config_dir / "config").write_text('[profile.dev.package."gamma:1.0.0"]\ndebug=2\n')
        (config_dir / "config.toml").write_text('[profile.dev.package.ignored]\ndebug=2\n')
        values = self.config_values()
        self.assertIn('profile.test.package."gamma:1.0.0".debug', values)
        self.assertNotIn('profile.dev.package."ignored".debug', values)

    def test_included_configs_and_cargo_home_are_tracked(self):
        os.environ["COMPACT"] = "1"
        home = self.root / "custom cargo home"
        home.mkdir()
        os.environ["CARGO_HOME"] = str(home)
        (home / "config.toml").write_text('include=["shared.toml"]\n')
        included = home / "shared.toml"
        included.write_text('[profile.test.package.included]\ndebug=2\n')
        self.assertIn('profile.dev.package."included".debug', self.config_values())
        before = gate.build_settings(self.repo)
        included.write_text('[profile.test.package.included]\ndebug=1\n')
        self.assertNotEqual(before, gate.build_settings(self.repo))

    def test_invalid_compact_config_fails_before_cargo(self):
        os.environ["COMPACT"] = "1"
        (self.repo / "Cargo.toml").write_text('invalid = [')
        with self.assertRaises(tomllib.TOMLDecodeError):
            gate.compact_config(self.repo)

    def test_python_without_tomllib_keeps_default_gates_and_rejects_compact(self):
        with mock.patch.object(gate, "tomllib", None):
            self.assertEqual(gate.compact_config(self.repo), [])
            self.assertEqual(gate.build_settings(self.repo)["compact-config"], [])
            os.environ["COMPACT"] = "1"
            with self.assertRaisesRegex(RuntimeError, "requires Python 3.11"):
                gate.compact_config(self.repo)

    def test_resume_identity_separates_modes_flags_and_external_config(self):
        with mock.patch.object(gate, "worktree_tree", return_value="tree"), mock.patch.object(
            gate, "submodule_heads", return_value=[]
        ), mock.patch.object(gate, "required_hash", return_value="hash"), mock.patch.object(
            gate, "run", return_value="version"
        ):
            default = gate.tree_key(self.root, self.repo)
            os.environ["COMPACT"] = "0"
            self.assertEqual(default, gate.tree_key(self.root, self.repo))
            os.environ["COMPACT"] = "1"
            compact = gate.tree_key(self.root, self.repo)
            self.assertNotEqual(default, compact)
            os.environ["CARGO_ENCODED_RUSTFLAGS"] = "--cfg\x1fflag"
            flags = gate.tree_key(self.root, self.repo)
            self.assertNotEqual(compact, flags)
            config_dir = self.root / ".cargo"
            config_dir.mkdir()
            (config_dir / "config.toml").write_text('[build]\nrustflags=["--cfg", "config"]\n')
            self.assertNotEqual(flags, gate.tree_key(self.root, self.repo))
            os.environ["COMPACT"] = "0"
            before = gate.tree_key(self.root, self.repo)
            os.environ["CARGO_PROFILE_TEST_DEBUG"] = "2"
            self.assertNotEqual(before, gate.tree_key(self.root, self.repo))
            before = gate.tree_key(self.root, self.repo)
            os.environ["CARGO_INCREMENTAL"] = "1"
            self.assertNotEqual(before, gate.tree_key(self.root, self.repo))


class CompactMakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="compact gate's ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.component = self.root / "packages/intentd"
        (self.component / ".git").mkdir(parents=True)
        (self.component / "Cargo.toml").write_text('[profile.dev.package.alpha]\ndebug=2\n')
        (self.root / "scripts").mkdir()
        shutil.copy(ROOT / "Makefile", self.root)
        shutil.copy(ROOT / "scripts/resumable_nextest.py", self.root / "scripts")
        self.log = self.root / "commands.jsonl"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        cargo = self.bin / "cargo"
        cargo.write_text('#!' + shutil.which("python3") + '\n' + '''
import json, os, sys
with open(os.environ["COMPACT_TEST_LOG"], "a") as log:
    log.write(json.dumps({"args": sys.argv[1:], "env": dict(os.environ)}) + "\\n")
sys.exit(int(os.environ.get("STUB_EXIT", "0")))
''')
        cargo.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items() if key not in {
            "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "COMPACT", "CARGO_INCREMENTAL",
            "CARGO_HOME", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
        }}
        self.env.update(HOME=str(self.root), COMPACT_TEST_LOG=str(self.log))
        # Contract/formatting tools are unrelated to this fixture; retain the
        # real check prerequisites and real clippy/lint-sources recipes.
        self.skips = ["-o", "check-makefile-targets", "-o", "check-protocol-field-parity",
                      "-o", "lint-shell-sleeps", "-o", "fmt"]

    def run_make(self, *args, env=None, cwd=None):
        self.log.unlink(missing_ok=True)
        result = subprocess.run(
            ["make", "--no-print-directory", *self.skips, *args,
             f"CARGO_BIN_DIR={self.bin}", "RUSTUP_CARGO="],
            cwd=cwd or self.root, env={**self.env, **(env or {})},
            capture_output=True, text=True, timeout=20,
        )
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_check_prerequisites_get_compact_settings_and_keep_rustflags(self):
        for mode in (None, "0", "1"):
            with self.subTest(mode=mode):
                result, calls = self.run_make("check", *([] if mode is None else [f"COMPACT={mode}"]),
                                               env={"RUSTFLAGS": "--cfg caller -C debuginfo=2"})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual([call["args"][0] for call in calls], ["clippy", "test"])
                for call in calls:
                    self.assertEqual(call["env"]["RUSTFLAGS"], "--cfg caller -C debuginfo=2")
                    self.assertEqual("--config" in call["args"], mode == "1")
                    self.assertEqual(call["env"].get("CARGO_INCREMENTAL"), "0" if mode == "1" else None)
                if mode == "1":
                    self.assertLess(calls[0]["args"].index("--config"), calls[0]["args"].index("--"))
                    self.assertIn("COMPACT=1", result.stdout)

    def test_coverage_rejects_before_any_goal_or_prerequisite(self):
        for target in ("coverage-changed", "coverage-e2e", "coverage-all"):
            for goals in ((target,), ("check", target), (target, "gate")):
                result, calls = self.run_make(*goals, "COMPACT=1", "-j4")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("COMPACT=1", result.stderr)
                self.assertIn("coverage", result.stderr)
                self.assertEqual(calls, [])

    def test_compiler_failure_remains_failure(self):
        for target in ("check", "gate"):
            result, calls = self.run_make(target, "COMPACT=1", env={"STUB_EXIT": "101"})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Error 101", result.stderr)
            self.assertEqual(len(calls), 1)


@unittest.skipUnless(shutil.which("cargo") and shutil.which("rustc"), "optional real Cargo smoke test")
class CompactCargoTests(unittest.TestCase):
    """Offline tiny crate: prove actual Cargo precedence, not a flag-merging mock."""

    def test_actual_cargo_preserves_config_environment_and_encoded_precedence(self):
        with tempfile.TemporaryDirectory(prefix="compact-cargo-") as temporary:
            root = Path(temporary)
            (root / "src").mkdir()
            (root / ".cargo").mkdir()
            (root / "Cargo.toml").write_text('''
[package]
name = "compact-fixture"
version = "0.0.0"
edition = "2021"
[profile.dev.package.compact-fixture]
debug = 2
''')
            (root / "src/lib.rs").write_text('pub fn answer() -> u8 { 42 }\n')
            wrapper = root / "rustc-wrapper"
            wrapper.write_text('#!' + shutil.which("python3") + '\n' + '''
import json, os, sys
with open(os.environ["COMPACT_TEST_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
''')
            wrapper.chmod(0o755)
            # The crate and all artifacts are private temporary fixtures; no
            # repository target or shared cache is modified or removed.
            env = {k: v for k, v in os.environ.items() if not (
                k.startswith("CARGO_") or k.startswith("RUST") or k == "COMPACT"
            )}
            log = root / "rustc.jsonl"
            env.update(COMPACT="1", CARGO_HOME=str(root / "cargo-home"),
                       CARGO_TARGET_DIR=str(root / "target"), RUSTC_WRAPPER=str(wrapper),
                       COMPACT_TEST_LOG=str(log), CARGO_INCREMENTAL="1",
                       CARGO_PROFILE_DEV_DEBUG="2", CARGO_PROFILE_TEST_DEBUG="2",
                       RUSTUP_AUTO_INSTALL="0")
            available = subprocess.run(["rustc", "--version"], cwd=root, env=env,
                                       capture_output=True, timeout=10)
            if available.returncode:
                self.skipTest("optional Cargo smoke test needs an installed default Rust toolchain")
            cargo = shutil.which("cargo")
            build_config = '[build]\nrustflags=["--cfg", "build_config"]\n'
            target_config = build_config + '[target.\'cfg(all())\']\nrustflags=["--cfg", "target_config"]\n'
            cases = [
                ({}, "build_config", "0", build_config),
                ({}, "target_config", "0", target_config),
                ({"CARGO_BUILD_RUSTFLAGS": "--cfg build_env"}, "build_env", "0", build_config),
                ({"RUSTFLAGS": "--cfg environment -Cdebuginfo=1"}, "environment", "1", target_config),
                ({"RUSTFLAGS": "--cfg environment", "CARGO_ENCODED_RUSTFLAGS": '--cfg\x1fencoded="has space"\x1f-Cdebuginfo=2'}, 'encoded="has space"', "2", target_config),
                ({"CARGO_ENCODED_RUSTFLAGS": ""}, None, "0", target_config),
            ]
            for extra, expected, debug, source_config in cases:
                with self.subTest(extra=extra):
                    (root / ".cargo/config.toml").write_text(source_config)
                    with mock.patch.dict(os.environ, {**env, **extra}, clear=True):
                        config = gate.compact_config(root)
                        child_env = gate.compact_env()
                    log.unlink(missing_ok=True)
                    result = subprocess.run([cargo, "check", "--offline", *config], cwd=root,
                                            env=child_env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    commands = [json.loads(line) for line in log.read_text().splitlines()]
                    args = next(command for command in commands if "compact_fixture" in command)
                    expected_flags = {expected}
                    if expected == "build_env":
                        # Cargo merges build.rustflags arrays from config and
                        # CARGO_BUILD_RUSTFLAGS; unlike RUSTFLAGS, it is additive.
                        expected_flags.add("build_config")
                    for flag in ("build_config", "target_config", "build_env", "environment", 'encoded="has space"'):
                        self.assertEqual(flag in args, flag in expected_flags, args)
                    codegen = [args[index + 1] if arg == "-C" else arg.removeprefix("-C")
                               for index, arg in enumerate(args) if arg.startswith("-C")]
                    debug_flags = [arg.split("=", 1)[1] for arg in codegen if arg.startswith("debuginfo=")]
                    self.assertEqual(debug_flags[-1] if debug_flags else "0", debug)
                    self.assertFalse(any(arg.startswith("incremental=") for arg in codegen))
                    self.assertFalse(any(arg.startswith("strip=") for arg in codegen))


if __name__ == "__main__":
    unittest.main()
