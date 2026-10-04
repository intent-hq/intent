"""Real root/component launchers with fake Cargo children; no Rust build needed.

The component must be initialized for integration cases. The shell-tests CI job
runs this file directly (and requires the component); test-scripts can still run
in a submodule-free checkout.
"""
import json
import os
import shlex
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "packages/intentd"
POLICY = "INTENTD_ASSERT_BOUND_CALLER"


@unittest.skipUnless((COMPONENT / "scripts/with-test-policy.sh").is_file(),
                     "initialize intentd for real launcher integration")
class RustTestPolicyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="policy gate's ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "mono"
        self.component = self.root / "packages/intentd"
        self.bin = Path(temporary.name) / "bin"
        self.bin.mkdir()
        self.log = Path(temporary.name) / "commands.jsonl"
        self.cache = Path(temporary.name) / "gate records"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(
            ("CARGO_", "RUST", "NEXTEST_", "INTENTD_")) and k not in {
                "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "COMPACT", "BASE", "DRY_RUN",
                "GATE_CACHE_DIR", "RESUME", "GATE_FORCE", "NO_FAIL_FAST", "PYTHONPATH",
                "TRANSFER_SELECTION_FIXTURE_ROOT"}}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        HOME=temporary.name, POLICY_LOG=str(self.log),
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.invalid",
                        GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@example.invalid",
                        INTENTD_TEST_TIMEOUT_MULTIPLIER="7", RUSTFLAGS="--cfg caller")
        (self.component / "scripts").mkdir(parents=True)
        (self.root / "scripts").mkdir()
        # Keep real check/gate recipes through recursive make. Only unrelated
        # contract and shell checks are stubs; make -o does not propagate.
        (self.root / "packages/cloudlands-fe/.git").mkdir(parents=True)
        shell_check = self.root / "scripts/lint-fixed-sleeps.sh"
        shell_check.write_text('#!/bin/sh\nexit 0\n')
        shell_check.chmod(0o755)
        node = self.bin / "node"
        node.write_text('#!/bin/sh\nexit 0\n')
        node.chmod(0o755)
        self.fixtures = self.root / "docs/protocol/fixtures/transfer-selection"
        shutil.copytree(ROOT / "docs/protocol/fixtures/transfer-selection", self.fixtures)
        shutil.copy(ROOT / "scripts/check-transfer-selection-contract.mjs", self.root / "scripts")
        # Other make contract checks are synthetic; this checker is always real.
        (self.bin / "node").write_text(
            '#!/bin/sh\ncase "$1" in *check-transfer-selection-contract.mjs) exec '
            + shlex.quote(shutil.which("node")) + ' "$@";; esac\n')
        for name in ("resumable_nextest.py", "check_watch_capacity.py"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts")
        shutil.copytree(ROOT / "scripts/_vendor", self.root / "scripts/_vendor",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy(ROOT / "Makefile", self.root)
        shutil.copy(COMPONENT / "Makefile", self.component)
        for name in ("with-test-policy.sh", "changed-tests.sh", "coverage-all.sh", "coverage-e2e.sh"):
            shutil.copy(COMPONENT / "scripts" / name, self.component / "scripts")
        for name, content in {
            "Cargo.toml": '[workspace]\n', "Cargo.lock": "lock\n",
            "rust-toolchain.toml": "toolchain\n", ".config/nextest.toml": "",
            "crates/alpha/Cargo.toml": '[package]\nname="alpha"\n',
            "crates/alpha/src/lib.rs": "", "crates/alpha/tests/one.rs": "",
            # A file that a mistakenly unquoted source-lint glob would expand.
            "accidental_lint": "",
        }.items():
            path = self.component / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.git(self.component, "init", "-q")
        self.git(self.component, "add", "-A")
        self.git(self.component, "commit", "-qm", "base")
        self.git(self.component, "update-ref", "refs/remotes/origin/main", "HEAD")
        (self.root / ".gitmodules").write_text(
            '[submodule "packages/intentd"]\npath = packages/intentd\nurl = https://example.invalid/intentd\n')
        self.git(self.root, "init", "-q")
        self.git(self.root, "-c", "advice.addEmbeddedRepo=false", "add", "-A")
        self.git(self.root, "commit", "-qm", "base")
        (self.component / "crates/alpha/tests/one.rs").write_text("// changed\n")
        cargo = self.bin / "cargo"
        cargo.write_text(f"#!{sys.executable} -S\n" + r'''
import json, os, sys
args = sys.argv[1:]
is_test = args[:1] == ['test'] or args[:2] == ['nextest', 'run'] or (args[:1] == ['llvm-cov'] and 'nextest' in args)
with open(os.environ['POLICY_LOG'], 'a') as log:
    log.write(json.dumps({'args': args, 'policy': os.environ.get('INTENTD_ASSERT_BOUND_CALLER'),
                         'timeout': os.environ.get('INTENTD_TEST_TIMEOUT_MULTIPLIER'),
                         'incremental': os.environ.get('CARGO_INCREMENTAL'),
                         'rustflags': os.environ.get('RUSTFLAGS'), 'test': is_test,
                         'transfer_fixture': os.environ.get('TRANSFER_SELECTION_FIXTURE_ROOT'),
                         'stdin': sys.stdin.read() if is_test else None}) + '\n')
if args[:1] == ['metadata']:
    print(json.dumps({'target_directory': os.path.join(os.getcwd(), 'target')}))
elif args[:2] == ['nextest', 'list']:
    print(json.dumps({'rust-suites': {'alpha::one': {'package-name': 'alpha', 'binary-name': 'one',
          'binary-id': 'alpha::one', 'testcases': {'passes': {}}}}}))
elif args[:2] == ['nextest', 'run']:
    print(json.dumps({'type': 'test', 'event': 'ok', 'name': 'alpha::one$passes'}))
elif '--version' in args or args == ['-V']:
    print('stub 1.0')
if is_test:
    if os.environ.get('TEST_STDERR'): print(os.environ['TEST_STDERR'], file=sys.stderr)
    sys.exit(int(os.environ.get('TEST_EXIT', '0')))
''')
        cargo.chmod(0o755)
        for name in ("cargo-nextest", "cargo-llvm-cov", "rustc", "rustup"):
            path = self.bin / name
            path.write_text('#!/bin/sh\necho "stub 1.0 llvm-tools"\n')
            path.chmod(0o755)
        # Avoid host Python startup instrumentation in every real runner child.
        path = self.bin / "python3"
        path.write_text(f'#!/bin/sh\nexec "{sys.executable}" -S -B "$@"\n')
        path.chmod(0o755)

    def git(self, cwd, *args):
        subprocess.run(["git", *args], cwd=cwd, env=self.env, check=True,
                       capture_output=True, text=True, timeout=10)

    def make(self, target, *, policy=None, override=None, forwarded=False, compact=False,
             extra=(), input="", env=None):
        self.log.unlink(missing_ok=True)
        child_env = {**self.env, **(env or {})}
        if policy is not None:
            child_env[POLICY] = policy
        args = ["make", "--no-print-directory", target, f"CARGO_BIN_DIR={self.bin}",
                "RUSTUP_CARGO=", f"GATE_CACHE_DIR={self.cache}", "BUILD_JOBS=2", "TEST_THREADS=1",
                f"COMPACT={int(compact)}", *extra]
        if override is not None:
            args.append(f"{POLICY}={override}")
        result = subprocess.run(args, cwd=self.component if forwarded else self.root,
                                env=child_env, capture_output=True, text=True, input=input, timeout=20)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def assert_policy(self, calls, *, inherited=None, compact=False):
        tests = [call for call in calls if call['test']]
        self.assertTrue(tests, calls)
        for call in tests:
            self.assertEqual(call['policy'], '1', call)
            self.assertEqual(call['rustflags'], '--cfg caller', call)
            coverage = call['args'][0] == 'llvm-cov'
            self.assertEqual(call['timeout'], '3' if coverage else '7', call)
            self.assertEqual(call['incremental'], '0' if compact else None, call)
            if call['args'][0] == 'test':
                self.assertEqual(call['args'][call['args'].index('--test') + 1], '*_lint', call)
        # Compilation, formatting and coverage maintenance are production-like
        # children outside the test boundary. They must keep the caller's env.
        for call in calls:
            if call['args'][0] in {'clippy', 'fmt', 'build', 'run'} or call['args'][:2] in (
                    ['llvm-cov', 'clean'], ['llvm-cov', 'report']):
                self.assertEqual(call['policy'], inherited, call)
                self.assertEqual(call['timeout'], '7', call)

    def test_all_root_routes_and_forwarding_enforce_policy(self):
        routes = [(target, False) for target in (
            'test', 'test-intentd', 'test-changed', 'gate', 'lint-sources', 'check',
            'coverage-changed', 'coverage-e2e', 'coverage-all', 'lint-repo-slug',
            'lint-event-types', 'lint-fixed-sleeps', 'lint-raw-child')]
        routes += [(target, True) for target in (
            'test', 'test-changed', 'gate', 'lint-sources', 'check', 'coverage-changed')]
        for target, forwarded in routes:
            for policy in (None, '1', '', '0', 'false'):
                with self.subTest(target=target, forwarded=forwarded, policy=policy):
                    result, calls = self.make(target, policy=policy, forwarded=forwarded)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assert_policy(calls, inherited=policy)
            with self.subTest(target=target, forwarded=forwarded, command_line=True):
                result, calls = self.make(target, policy='1', override='0', forwarded=forwarded)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_policy(calls, inherited='0')

    def test_recursive_fallback_compact_and_make_override(self):
        (self.component / 'Cargo.lock').write_text('changed lock\n')
        for forwarded in (False, True):
            for compact in (False, True):
                with self.subTest(forwarded=forwarded, compact=compact):
                    result, calls = self.make('test-changed', policy='false', override='0',
                                              forwarded=forwarded, compact=compact)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("falling back to the full 'make test'", result.stdout)
                    self.assert_policy(calls, inherited='0', compact=compact)
                    self.assertTrue(any(c['args'][:3] == ['nextest', 'run', '--workspace'] for c in calls))

    def test_compact_gate_stdin_stderr_and_exit(self):
        for target in ('test', 'lint-sources', 'test-changed', 'coverage-changed', 'coverage-e2e', 'coverage-all'):
            with self.subTest(target=target):
                result, calls = self.make(target, policy='0', compact=not target.startswith('coverage'),
                                          input="input with 'quotes'\n", env={'TEST_STDERR': 'child diagnostic', 'TEST_EXIT': '37'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Error 37', result.stderr)
                self.assertIn('child diagnostic', result.stderr)
                self.assert_policy(calls, inherited='0', compact=not target.startswith('coverage'))
                self.assertEqual([c['stdin'] for c in calls if c['test']], ["input with 'quotes'\n"])
        result, calls = self.make('gate', override='false', compact=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_policy(calls, inherited='false', compact=True)

    def test_direct_records_cannot_credit_canonical_armed_verification(self):
        for target in ('test', 'test-changed'):
            for policy in (None, '', '0', 'false', '1'):
                with self.subTest(target=target, policy=policy):
                    shutil.rmtree(self.cache, ignore_errors=True)
                    self.log.unlink(missing_ok=True)
                    env = self.env.copy()
                    if policy is not None:
                        env[POLICY] = policy
                    args = [str(self.bin / 'python3'), 'scripts/resumable_nextest.py',
                            '--repo-root', str(self.root), '--intentd-dir', 'packages/intentd',
                            '--cache-dir', str(self.cache), '--build-jobs', '2', '--test-threads', '1']
                    if target == 'test-changed':
                        args += ['--plan', '-p alpha --test one', '--base', 'origin/main',
                                 '--label', 'test-changed']
                    direct = subprocess.run(args, cwd=self.root, env=env, input='',
                                            capture_output=True, text=True, timeout=20)
                    self.assertEqual(direct.returncode, 0, direct.stdout + direct.stderr)
                    calls = [json.loads(line) for line in self.log.read_text().splitlines()]
                    self.assertEqual([c['policy'] for c in calls if c['test']], [policy])
                    result, calls = self.make(target, override='0', extra=('RESUME=1',))
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    if policy == '1':
                        self.assertIn('resumed: skipped 1 tests', result.stdout)
                        self.assertFalse(any(c['test'] for c in calls))
                    else:
                        self.assert_policy(calls, inherited='0')
                        self.assertNotIn('resumed: skipped', result.stdout)
                    result, calls = self.make(target, override='false', extra=('RESUME=1',))
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('resumed: skipped 1 tests', result.stdout)
                    self.assertFalse(any(c['test'] for c in calls))

    def test_non_test_child_after_gate_keeps_parent_policy(self):
        for value in (None, '0', 'false'):
            with self.subTest(policy=value):
                result, calls = self.make('check', policy=value)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_policy(calls, inherited=value)
                child_env = self.env.copy()
                if value is not None:
                    child_env[POLICY] = value
                subprocess.run([str(self.bin / 'cargo'), 'run', '--bin', 'intentd'],
                               env=child_env, cwd=self.component, check=True,
                               capture_output=True, text=True, timeout=10)
                production = json.loads(self.log.read_text().splitlines()[-1])
                self.assertEqual(production['policy'], value)
                self.assertFalse(production['test'])

    def test_canonical_resume_survives_disabling_inherited_values(self):
        for target in ('test', 'test-changed'):
            with self.subTest(target=target):
                result, calls = self.make(target, policy='0')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_policy(calls, inherited='0')
                result, calls = self.make(target, policy='false', override='', extra=('RESUME=1',))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('resumed: skipped 1 tests', result.stdout)
                self.assertFalse(any(c['test'] for c in calls))


@unittest.skipUnless((COMPONENT / "scripts/with-test-policy.sh").is_file() and shutil.which("node"),
                     "initialize intentd and install Node for transfer launcher integration")
class RustTransferFixtureTests(unittest.TestCase):
    git = RustTestPolicyTests.git
    make = RustTestPolicyTests.make

    def setUp(self):
        RustTestPolicyTests.setUp(self)
        self.env.pop("TRANSFER_SELECTION_FIXTURE_ROOT", None)
        detached = self.root.parent / "detached daemon's checkout"
        shutil.copytree(self.component, detached)
        self.component = detached
        service = self.component / "crates/intent-services"
        (service / "src").mkdir(parents=True)
        (service / "tests").mkdir()
        (service / "Cargo.toml").write_text('[package]\nname="intent-services"\n')
        (service / "src/lib.rs").write_text("// base\n")
        (service / "tests/one.rs").write_text("// base\n")
        self.git(self.component, "add", "-A")
        self.git(self.component, "commit", "-qm", "service baseline")
        self.git(self.component, "update-ref", "refs/remotes/origin/main", "HEAD")

    def launch(self, target="test", *, extra=(), env=None):
        return self.make(target, extra=(f"INTENTD_DIR={self.component}", *extra), env=env)

    def assert_rejected(self, result, calls):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("transfer-selection fixture", result.stderr)
        self.assertIn("check-transfer-selection-contract", result.stderr)
        self.assertNotIn("resumed: skipped", result.stdout)
        # Make may probe nextest availability; no metadata, build or identity calls.
        self.assertTrue(all(c["args"] == ["nextest", "--version"] for c in calls), calls)

    def test_detached_full_changed_and_fallback_forward_default(self):
        for route in ("full", "changed", "fallback"):
            with self.subTest(route=route):
                if route == "changed":
                    (self.component / "crates/intent-services/src/lib.rs").write_text("// changed\n")
                if route == "fallback":
                    (self.component / "Cargo.lock").write_text("changed lock\n")
                result, calls = self.launch("test" if route == "full" else "test-changed")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                tests = [c for c in calls if c["test"]]
                self.assertTrue(tests, calls)
                self.assertTrue(all(c["transfer_fixture"] == str(self.fixtures) for c in tests), tests)

    def test_absolute_alias_override_is_forwarded_unchanged(self):
        alias = self.root.parent / "fixture alias with spaces"
        alias.symlink_to(self.fixtures, target_is_directory=True)
        value = str(alias) + "/"
        result, calls = self.launch(env={"TRANSFER_SELECTION_FIXTURE_ROOT": value})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([c["transfer_fixture"] for c in calls if c["test"]], [value])

    def test_invalid_overrides_reject_before_cargo(self):
        foreign = self.root.parent / "another checkout fixtures"
        shutil.copytree(self.fixtures, foreign)
        for value in ("", "docs/protocol/fixtures/transfer-selection", str(foreign), str(foreign / "missing")):
            with self.subTest(value=value):
                result, calls = self.launch(env={"TRANSFER_SELECTION_FIXTURE_ROOT": value})
                self.assert_rejected(result, calls)

    def test_recovery_command_is_supported_and_quotes_checkout_path(self):
        result, calls = self.launch(env={"TRANSFER_SELECTION_FIXTURE_ROOT": ""})
        self.assert_rejected(result, calls)
        command = next(line.strip() for line in result.stderr.splitlines()
                       if line.startswith("  TRANSFER_SELECTION_FIXTURE_ROOT="))
        recovered = subprocess.run(["sh", "-c", command], cwd=self.root.parent,
                                   env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(recovered.returncode, 0, recovered.stdout + recovered.stderr)
        self.assertIn("integrity only; freshness not checked", recovered.stdout)

    def test_missing_and_corrupt_inputs_reject_before_cargo_and_cached_credit(self):
        result, _ = self.launch()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result, calls = self.launch(extra=("RESUME=1",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("resumed: skipped", result.stdout)
        for name in ("contract.json", "public-sessions.json", "public-sessions.desktop-control-v1.json"):
            path = self.fixtures / name
            original = path.read_bytes()
            for corrupt in (None, b"", b"{}", b"not json"):
                with self.subTest(file=name, corrupt=corrupt):
                    if corrupt is None:
                        path.unlink()
                    else:
                        path.write_bytes(corrupt)
                    result, calls = self.launch(extra=("RESUME=1",))
                    self.assert_rejected(result, calls)
                    path.write_bytes(original)

    def test_changed_and_fallback_reject_corruption_before_metadata(self):
        (self.fixtures / "contract.json").write_text("{}")
        for route in ("changed", "fallback"):
            with self.subTest(route=route):
                path = ("crates/intent-services/src/lib.rs" if route == "changed" else "Cargo.lock")
                (self.component / path).write_text("changed\n")
                result, calls = self.launch("test-changed", extra=("RESUME=1",))
                self.assert_rejected(result, calls)

    def test_valid_external_symlink_edit_invalidates_completed_credit(self):
        golden = self.fixtures / "public-sessions.json"
        external = self.root.parent / "external golden.json"
        golden.rename(external)
        golden.symlink_to(external)
        result, calls = self.launch(extra=("RESUME=1",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(c["test"] for c in calls))
        result, calls = self.launch(extra=("RESUME=1",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("resumed: skipped", result.stdout)
        # Valid JSON whitespace changes content without changing the Git tree
        # (only the symlink target is tracked). Existing passes must be ineligible.
        external.write_text(external.read_text() + "\n")
        result, calls = self.launch(extra=("RESUME=1",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(c["test"] for c in calls), calls)
        self.assertNotIn("resumed: skipped", result.stdout)

    def test_gate_orders_parallel_check_before_any_cargo(self):
        (self.fixtures / "contract.json").unlink()
        result, calls = self.launch("gate", extra=("-j8", "check", "clippy"))
        self.assert_rejected(result, calls)
        self.assertEqual(calls, [])

    def test_unrelated_dry_run_and_no_changes_need_no_fixtures(self):
        shutil.rmtree(self.fixtures)
        for route in ("no changes", "unrelated", "service integration", "dry run", "dry fallback"):
            with self.subTest(route=route):
                self.git(self.component, "reset", "--hard", "origin/main")
                if route == "unrelated":
                    (self.component / "crates/alpha/tests/one.rs").write_text("// changed\n")
                elif route == "service integration":
                    (self.component / "crates/intent-services/tests/one.rs").write_text("// changed\n")
                elif route == "dry run":
                    (self.component / "crates/intent-services/src/lib.rs").write_text("// changed\n")
                elif route == "dry fallback":
                    (self.component / "Cargo.lock").write_text("changed lock\n")
                result, calls = self.launch("test-changed", extra=("DRY_RUN=1",) if route.startswith("dry") else ())
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(all(c["transfer_fixture"] is None for c in calls), calls)

    def test_direct_runner_rejects_before_any_cargo(self):
        (self.fixtures / "contract.json").unlink()
        result = subprocess.run(
            [sys.executable, "-S", "-B", str(self.root / "scripts/resumable_nextest.py"),
             "--repo-root", str(self.root), "--intentd-dir", str(self.component),
             "--cache-dir", str(self.cache), "--build-jobs", "2", "--test-threads", "1",
             "--resume", "1", "--plan=-p intent-services --lib"],
            cwd=self.root.parent, env=self.env, capture_output=True, text=True, input="", timeout=20)
        self.assert_rejected(result, [])
        self.assertFalse(self.log.exists())

    def test_direct_runner_uses_repo_root_not_current_directory(self):
        result = subprocess.run(
            [sys.executable, "-S", "-B", str(self.root / "scripts/resumable_nextest.py"),
             "--repo-root", str(self.root), "--intentd-dir", str(self.component),
             "--cache-dir", str(self.cache), "--build-jobs", "2", "--test-threads", "1",
             "--plan=-p intent-services --lib"], cwd=self.root.parent, env=self.env,
            capture_output=True, text=True, input="", timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([c["transfer_fixture"] for c in calls if c["test"]], [str(self.fixtures)])


if __name__ == '__main__':
    if not (COMPONENT / 'scripts/with-test-policy.sh').is_file():
        sys.exit('initialize intentd before running launcher policy integration')
    unittest.main()
