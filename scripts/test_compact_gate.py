"""Compact gate contracts, with an optional offline tiny-crate Cargo smoke test."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import resumable_nextest as gate

ROOT = Path(__file__).resolve().parents[1]


class VendoredTomlTests(unittest.TestCase):
    def test_pinned_runtime_and_license_match_upstream_integrity_records(self):
        vendor = ROOT / "scripts/_vendor"
        provenance = json.loads((vendor / "tomli.provenance.json").read_text())
        self.assertEqual(provenance["repository"], "https://github.com/hukkin/tomli")
        self.assertEqual(provenance["version"], gate.cargo_toml.__version__)
        self.assertEqual(provenance["license"], "MIT")
        self.assertRegex(provenance["revision"], r"^[0-9a-f]{40}$")
        expected = {"__init__.py", "_parser.py", "_re.py", "_types.py", "LICENSE"}
        self.assertEqual(set(provenance["files"]), expected)
        self.assertEqual({path.name for path in (vendor / "tomli").iterdir() if path.is_file()}, expected)
        for name, record in provenance["files"].items():
            data = (vendor / "tomli" / name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), record["sha256"], name)
            blob = b"blob " + str(len(data)).encode() + b"\0" + data
            self.assertEqual(hashlib.sha1(blob).hexdigest(), record["git_blob_sha1"], name)
            self.assertEqual(record["source"], name if name == "LICENSE" else f"src/tomli/{name}")
            if name.endswith(".py"):
                ast.parse(data.decode(), filename=name, feature_version=(3, 10))


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
        with self.assertRaises(gate.cargo_toml.TOMLDecodeError):
            gate.compact_config(self.repo)

    def test_bom_prefixed_manifest_is_accepted(self):
        os.environ["COMPACT"] = "1"
        manifest = self.repo / "Cargo.toml"
        manifest.write_bytes(b"\xef\xbb\xbf" + manifest.read_bytes())
        self.assertEqual(self.config_values()['profile.dev.package."alpha".debug'], "0")

    def test_bom_configs_and_includes_keep_raw_hashes_in_all_modes(self):
        config_dir = self.repo / ".cargo"
        config_dir.mkdir()
        config = config_dir / "config.toml"
        included = config_dir / "included.toml"
        config.write_text('\ufeffinclude=["included.toml"]\n')
        for mode in (None, "0", "1"):
            with self.subTest(mode=mode):
                if mode is not None:
                    os.environ["COMPACT"] = mode
                included.write_text('\ufeff[profile.dev.package.bom]\ndebug=2\n')
                settings = gate.build_settings(self.repo)
                for path in (config, included):
                    self.assertEqual(settings["cargo-configs"][str(path)],
                                     hashlib.sha256(path.read_bytes()).hexdigest())
                    self.assertTrue(gate.cargo_configs(self.repo)[path].startswith(b"\xef\xbb\xbf"))
                included.write_bytes(included.read_bytes()[3:])
                # Parsing is equivalent, but resume identity hashes raw bytes.
                self.assertNotEqual(settings, gate.build_settings(self.repo))

    def test_toml_11_inline_tables_in_manifest_config_and_include(self):
        config_dir = self.repo / ".cargo"
        config_dir.mkdir()
        manifest = self.repo / "Cargo.toml"
        original_manifest = manifest.read_bytes()
        config = config_dir / "config.toml"
        included = config_dir / "included.toml"
        for inline in ("debug = 2,\n incremental = true", "debug = 2, incremental = true,"):
            for location in (manifest, config, included):
                for mode in ("0", "1"):
                    with self.subTest(inline=inline, location=location.name, mode=mode):
                        os.environ["COMPACT"] = mode
                        manifest.write_bytes(original_manifest)
                        config.write_text('include=["included.toml"]\n')
                        included.write_text("")
                        location.write_text(f'[profile]\ndev = {{ package = {{ toml11 = {{debug=2}} }}, {inline} }}\n')
                        if mode == "1":
                            self.assertIn('profile.dev.package."toml11".debug', self.config_values())
                        gate.build_settings(self.repo)

    def test_relative_cargo_home_uses_cargo_cwd_for_profiles_and_resume_key(self):
        self.assertNotEqual(Path.cwd(), self.repo)
        home = self.root / "external cargo home"
        home.mkdir()
        config = home / "config.toml"
        os.environ["CARGO_HOME"] = "../external cargo home"
        with mock.patch.object(gate, "worktree_tree", return_value="tree"), mock.patch.object(
            gate, "submodule_heads", return_value=[]
        ), mock.patch.object(gate, "required_hash", return_value="hash"), mock.patch.object(
            gate, "run", return_value="version"
        ):
            for mode in ("0", "1"):
                os.environ["COMPACT"] = mode
                source = '[profile.dev.package.external]\ndebug=2\n[build]\nrustflags=["--cfg", "first"]\n'
                config.write_text(source)
                self.assertIn(self.repo / os.environ["CARGO_HOME"] / "config.toml",
                              gate.cargo_configs(self.repo))
                if mode == "1":
                    self.assertIn('profile.dev.package."external".debug', self.config_values())
                before = gate.tree_key(self.root, self.repo)
                config.write_text(source.replace('"first"', '"second"'))
                self.assertNotEqual(before, gate.tree_key(self.root, self.repo))

    def test_symlink_config_includes_use_logical_parent_and_change_identity(self):
        os.environ["COMPACT"] = "1"
        logical = self.repo / ".cargo"
        logical.mkdir()
        dotfiles = self.root / "dotfiles"
        dotfiles.mkdir()
        source = dotfiles / "cargo.toml"
        source.write_text('include=["overrides.toml"]\n')
        (logical / "config.toml").symlink_to(source)
        (dotfiles / "overrides.toml").write_text('[profile.dev.package.wrong]\ndebug=2\n')
        included = logical / "overrides.toml"
        included.write_text('[profile.dev.package.local]\ndebug=2\n')
        values = self.config_values()
        self.assertIn('profile.dev.package."local".debug', values)
        self.assertNotIn('profile.dev.package."wrong".debug', values)
        self.assertIn(included, gate.cargo_configs(self.repo))
        before = gate.build_settings(self.repo)
        included.write_text('[profile.dev.package.local]\ndebug=1\n')
        self.assertNotEqual(before, gate.build_settings(self.repo))

    def test_symlink_include_cycle_reports_error_without_unbounded_recursion(self):
        logical = self.repo / ".cargo"
        logical.mkdir()
        config = logical / "config.toml"
        config.write_text('include=["nested/config.toml"]\n')
        (logical / "nested").symlink_to(logical, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "cyclic Cargo config include"):
            gate.cargo_configs(self.repo)

    def test_offline_script_and_package_imports_need_no_stdlib_or_installed_toml(self):
        code = f'''
import builtins, os, pathlib, runpy, sys
original_import = builtins.__import__
def without_external_toml(name, *args, **kwargs):
    if name in ("tomllib", "tomli"):
        raise ModuleNotFoundError(name)
    return original_import(name, *args, **kwargs)
builtins.__import__ = without_external_toml
sys.path.insert(0, {str(ROOT)!r})
from scripts import resumable_nextest
modules = [vars(resumable_nextest), runpy.run_path({str(ROOT / 'scripts/resumable_nextest.py')!r})]
for mode in ("0", "1"):
    os.environ["COMPACT"] = mode
    for module in modules:
        config = module["compact_config"](pathlib.Path({str(self.repo)!r}))
        assert bool(config) == (mode == "1"), (mode, config)
'''
        result = subprocess.run([sys.executable, "-S", "-B", "-c", code],
                                cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

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
            for name in ("CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR"):
                before = gate.tree_key(self.root, self.repo)
                os.environ[name] = "../other-output"
                self.assertNotEqual(before, gate.tree_key(self.root, self.repo))
            alias = self.root / "source-alias"
            alias.symlink_to(self.repo, target_is_directory=True)
            self.assertEqual(gate.tree_key(self.root, self.repo), gate.tree_key(self.root, alias))
            other = self.root / "other-source"
            other.mkdir()
            shutil.copy(self.repo / "Cargo.toml", other / "Cargo.toml")
            self.assertNotEqual(gate.tree_key(self.root, self.repo), gate.tree_key(self.root, other))


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
        shutil.copy(ROOT / "scripts/check_watch_capacity.py", self.root / "scripts")
        shutil.copytree(ROOT / "scripts/_vendor", self.root / "scripts/_vendor",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
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

    def test_gate_preserves_check_dependency_and_skip_semantics(self):
        for parallel in ([], ["-j2"]):
            for goals, checks in ((["check", "gate"], 1), (["-o", "check", "gate"], 0)):
                with self.subTest(parallel=parallel, goals=goals):
                    result, calls = self.run_make("-n", *goals, *parallel)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(result.stdout.count("cargo clippy"), checks, result.stdout)
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

    def test_relative_cargo_home_real_compiler_and_resume_identity(self):
        self.check_external_config(symlink=False)

    def test_symlink_include_real_compiler_and_resume_identity(self):
        self.check_external_config(symlink=True)

    def test_bom_manifest_config_and_include_real_cargo_in_all_modes(self):
        for mode in (None, "0", "1"):
            with self.subTest(mode=mode):
                self.check_external_config(symlink=True, bom=True, mode=mode)

    def test_toml_11_real_cargo_in_default_and_compact_modes(self):
        for inline in ("debug = 2,\n incremental = true", "debug = 2, incremental = true,"):
            for mode in ("0", "1"):
                with self.subTest(inline=inline, mode=mode):
                    self.check_external_config(symlink=True, toml11=inline, mode=mode)

    def check_external_config(self, *, symlink, bom=False, toml11=None, mode="1"):
        with tempfile.TemporaryDirectory(prefix="compact-relative-home-") as temporary:
            root = Path(temporary)
            component = root / "mono/packages/intentd"
            (component / "src").mkdir(parents=True)
            (component / "Cargo.toml").write_text('''
[package]
name = "compact-relative-home"
version = "0.0.0"
edition = "2021"
''')
            if bom:
                manifest = component / "Cargo.toml"
                manifest.write_bytes(b"\xef\xbb\xbf" + manifest.read_bytes())
            if toml11:
                with (component / "Cargo.toml").open("a") as manifest:
                    manifest.write(f'[package.metadata]\nprobe = {{ {toml11} }}\n')
            (component / "src/lib.rs").write_text('pub fn answer() -> u8 { 42 }\n')
            (component / "build.rs").write_text('fn main() {}\n')
            home = root / "cargo-home"
            home.mkdir()
            config_file = home / "config.toml"
            env = {k: v for k, v in os.environ.items() if not (
                k.startswith("CARGO_") or k.startswith("RUST") or k == "COMPACT"
            )}
            env.update(CARGO_HOME="../../../cargo-home",
                       CARGO_TARGET_DIR=str(root / "target"), RUSTUP_AUTO_INSTALL="0")
            if mode is not None:
                env["COMPACT"] = mode
            if symlink:
                logical = component / ".cargo"
                logical.mkdir()
                config_file.write_text(('\ufeff' if bom else '') + 'include=["overrides.toml"]\n')
                (logical / "config.toml").symlink_to(config_file)
                (home / "overrides.toml").write_text('[profile.dev.package.wrong]\ndebug=2\n')
                config_file = logical / "overrides.toml"
                env["CARGO_HOME"] = str(root / "empty-home")
            available = subprocess.run(["rustc", "--version"], cwd=component, env=env,
                                       capture_output=True, timeout=10)
            if available.returncode:
                self.skipTest("optional Cargo smoke test needs an installed default Rust toolchain")
            keys = []
            self.assertNotEqual(Path.cwd(), component)
            for flag in ("external_first", "external_second"):
                profile = ('[profile.dev.package.compact-relative-home]\ndebug=2\n'
                           '[profile.dev.build-override]\ndebug=2\n')
                if toml11:
                    profile = ('[profile]\ndev = { package = { compact-relative-home = { debug=2 } }, '
                               f'build-override = {{debug=2}}, {toml11} }}\n')
                config_file.write_text(
                    ('\ufeff' if bom else '') + profile + f'[build]\nrustflags=["--cfg", "{flag}"]\n'
                )
                with mock.patch.dict(os.environ, env, clear=True):
                    config = gate.compact_config(component)
                    child_env = gate.compact_env()
                    with mock.patch.object(gate, "worktree_tree", return_value="tree"), mock.patch.object(
                        gate, "submodule_heads", return_value=[]
                    ), mock.patch.object(gate, "required_hash", return_value="hash"), mock.patch.object(
                        gate, "run", return_value="version"
                    ):
                        keys.append(gate.tree_key(root / "mono", component))
                result = subprocess.run(["cargo", "check", "--offline", "-v", *config],
                                        cwd=component, env=child_env, capture_output=True,
                                        text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                for crate in ("compact_relative_home", "build_script_build"):
                    invocation = next(line for line in result.stderr.splitlines()
                                      if f"--crate-name {crate}" in line)
                    self.assertIn(f"--cfg {flag}", invocation)
                    if mode == "1":
                        self.assertNotIn("debuginfo=2", invocation)
                        self.assertNotIn("incremental=", invocation)
                    else:
                        self.assertIn("debuginfo=2", invocation)
            self.assertNotEqual(*keys)

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
