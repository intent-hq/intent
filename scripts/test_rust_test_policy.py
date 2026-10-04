"""Real root/component launchers with fake Cargo children; no Rust build needed.

The component must be initialized for integration cases. The shell-tests CI job
runs this file directly (and requires the component); test-scripts can still run
in a submodule-free checkout.
"""
import json
import os
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
        self.fixture = Path(temporary.name) / "callback fixture"
        self.fixture.mkdir()
        (self.fixture / "valid").touch()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(
            ("CARGO_", "RUST", "NEXTEST_", "INTENTD_")) and k not in {
                "MAKEFLAGS", "MFLAGS", "MAKELEVEL", "COMPACT", "BASE", "DRY_RUN",
                "GATE_CACHE_DIR", "RESUME", "GATE_FORCE", "NO_FAIL_FAST", "PYTHONPATH"}}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        HOME=temporary.name, POLICY_LOG=str(self.log),
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.invalid",
                        GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@example.invalid",
                        INTENT_ACP_CALLBACK_ADAPTER_FIXTURE=str(self.fixture),
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
        for name in ("resumable_nextest.py", "check_watch_capacity.py"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts")
        shutil.copytree(ROOT / "scripts/_vendor", self.root / "scripts/_vendor",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copy(ROOT / "Makefile", self.root)
        shutil.copy(COMPONENT / "Makefile", self.component)
        for name in ("with-test-policy.sh", "changed-tests.sh", "coverage-all.sh", "coverage-e2e.sh"):
            shutil.copy(COMPONENT / "scripts" / name, self.component / "scripts")
        # Isolate policy/wrapper behavior from the Linux-only fixture payload.
        # Canonical inventory validation is exercised in CallbackValidatorTests.
        (self.component / "scripts/prepare-acp-callback-fixture.py").write_text('''
from pathlib import Path
DEFAULT_DESCRIPTOR = Path(__file__)
class InvalidFixture(Exception):
    pass
def platform_check():
    pass
def configuration(path):
    return {"manifest": {"sha256": "verified"}}, {}
def validate_fixture(root, descriptor, manifest):
    if not (root / "valid").is_file():
        raise InvalidFixture("invalid synthetic fixture")
def environment(work):
    return {}
def node_tool(descriptor, work, env):
    return Path(__file__)
def digest(path):
    return "verified"
''')
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
                         'fixture': os.environ.get('INTENT_ACP_CALLBACK_ADAPTER_FIXTURE'),
                         'timeout': os.environ.get('INTENTD_TEST_TIMEOUT_MULTIPLIER'),
                         'incremental': os.environ.get('CARGO_INCREMENTAL'),
                         'rustflags': os.environ.get('RUSTFLAGS'), 'test': is_test,
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

    def assert_policy(self, calls, *, inherited=None, compact=False, fixture=None):
        tests = [call for call in calls if call['test']]
        self.assertTrue(tests, calls)
        for call in tests:
            self.assertEqual(call['policy'], '1', call)
            self.assertEqual(call['fixture'], str(self.fixture) if fixture is None else fixture, call)
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

    def test_fixture_preflight_blocks_armed_resume_before_compilation(self):
        result, calls = self.make('test', policy='0')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_policy(calls, inherited='0')
        for target in ('test', 'gate'):
            with self.subTest(target=target, fixture='missing'):
                result, calls = self.make(target, override='0', extra=('RESUME=1',),
                                          env={'INTENT_ACP_CALLBACK_ADAPTER_FIXTURE': ''})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('callback fixture:', result.stderr)
                # make test checks tool availability before entering the runner;
                # no metadata, listing, compilation or test invocation may run.
                self.assertEqual([c['args'] for c in calls],
                                 [['nextest', '--version']] if target == 'test' else [])
                self.assertNotIn('resumed: skipped', result.stdout)
        (self.fixture / 'valid').unlink()
        result, calls = self.make('test', override='0', extra=('RESUME=1',))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('invalid synthetic fixture', result.stderr)
        self.assertEqual([c['args'] for c in calls], [['nextest', '--version']])
        self.assertNotIn('resumed: skipped', result.stdout)

    def test_mixed_gate_goals_preflight_before_cargo(self):
        for fixture in ('missing', 'invalid'):
            if fixture == 'invalid':
                (self.fixture / 'valid').unlink()
            env = {'INTENT_ACP_CALLBACK_ADAPTER_FIXTURE':
                   '' if fixture == 'missing' else str(self.fixture)}
            for forwarded in (False, True):
                for goals in (('gate', 'check'), ('check', 'gate')):
                    for parallel in ((), ('-j4',)):
                        with self.subTest(fixture=fixture, forwarded=forwarded,
                                          goals=goals, parallel=parallel):
                            result, calls = self.make(
                                goals[0], forwarded=forwarded, override='0',
                                extra=(goals[1], *parallel), env=env)
                            self.assertNotEqual(result.returncode, 0)
                            self.assertIn('callback fixture:', result.stderr)
                            self.assertEqual(calls, [], result.stdout + result.stderr)

    def test_standalone_check_remains_fixture_free(self):
        for forwarded in (False, True):
            with self.subTest(forwarded=forwarded):
                result, calls = self.make(
                    'check', forwarded=forwarded, override='0', extra=('-j4',),
                    env={'INTENT_ACP_CALLBACK_ADAPTER_FIXTURE': ''})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assert_policy(calls, inherited='0', fixture='')

    def test_valid_mixed_gate_goals_preserve_policy_without_duplicate_checks(self):
        for forwarded in (False, True):
            for goals in (('gate', 'check'), ('check', 'gate')):
                with self.subTest(forwarded=forwarded, goals=goals):
                    result, calls = self.make(goals[0], forwarded=forwarded,
                                              override='0', extra=(goals[1], '-j4'))
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assert_policy(calls, inherited='0')
                    for command in ('fmt', 'clippy', 'test'):
                        self.assertEqual(sum(c['args'][0] == command for c in calls), 1, calls)


if __name__ == '__main__':
    if not (COMPONENT / 'scripts/with-test-policy.sh').is_file():
        sys.exit('initialize intentd before running launcher policy integration')
    unittest.main()
