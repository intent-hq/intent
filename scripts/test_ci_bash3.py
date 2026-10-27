#!/usr/bin/env python3
"""Bash 3 runs on cheap Linux without dropping shell compatibility coverage."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / 'scripts/install-ci-bash3.sh'
ACTION = ROOT / '.github/actions/setup-bash3/action.yml'
SETUP_ACTION = './.github/actions/setup-bash3'

class Bash3(unittest.TestCase):
    def test_workflow_uses_linux_and_real_interpreter(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        job = workflow.split('  shell-tests-bash3:\n', 1)[1].split('\n  repo-hygiene:', 1)[0]
        self.assertIn("fromJSON(needs.runner-route.outputs.slots || '{}')['shell-tests-bash3'] || fromJSON('[\"ubuntu-24.04\"]')", job)
        # Bash 3.2 comes only from the shared cached step, before the suites.
        self.assertIn(f'        uses: {SETUP_ACTION}\n', job)
        self.assertNotIn('install-ci-bash3.sh', job)
        self.assertNotIn('apt-get', job)
        self.assertLess(job.index(f'uses: {SETUP_ACTION}'), job.index('"$BASH3_BIN" --version'))
        self.assertIn('"$BASH3_BIN" scripts/dev-sandbox.test.sh', job)
        self.assertNotIn('/bin/bash', job)
        for suite in ('ci-gate', 'consumer-checks', 'docs-check', 'dev-sandbox',
                      'lint-fixed-sleeps', 'release-status', 'rust-changed-tests', 'shipped-in'):
            line = next(line for line in job.splitlines() if f'scripts/{suite}.test.sh' in line)
            self.assertIn('REQUIRE_BASH3=1', line)
        # intentd's changed-tests suite carries its own Bash 3.2 pass; nothing
        # else runs it with a real 3.2, so the job requires it here.
        intentd_suite = 'REQUIRE_BASH3=1 bash packages/intentd/scripts/test-changed-tests.sh'
        self.assertIn(intentd_suite, [line.strip() for line in job.splitlines()])
        self.assertLess(job.index('- run: git submodule update --init --depth=1 packages/intentd'),
                        job.index(intentd_suite))

    def test_download_mismatch_prevents_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            curl = root / 'curl'
            curl.write_text('#!/bin/bash\nfor arg in "$@"; do dest=$arg; done\nprintf corrupt > "$dest"\n')
            curl.chmod(0o755)
            tar = root / 'tar'
            tar.write_text('#!/bin/bash\necho executed > "$BASH3_TEST_MARKER"\nexit 1\n')
            tar.chmod(0o755)
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                   'BASH3_TEST_MARKER': str(root / 'executed')}
            result = subprocess.run(['bash', str(ROOT/'scripts/install-ci-bash3.sh'), str(root/'install')],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('FAILED', result.stdout)
            self.assertFalse((root / 'executed').exists())

    def test_build_is_serial_even_with_inherited_parallel_flags(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stubs = {
                'curl': 'for arg in "$@"; do dest=$arg; done\nprintf source > "$dest"\n',
                'sha256sum': 'cat > /dev/null\n',
                'tar': 'mkdir -p bash-3.2.57\nprintf \'#!/bin/bash\\nexit 0\\n\' > bash-3.2.57/configure\n'
                       'chmod 755 bash-3.2.57/configure\n',
                'make': 'printf \'%s\\n\' "args=$*" "MAKEFLAGS=${MAKEFLAGS-unset}" "MFLAGS=${MFLAGS-unset}" '
                        '"GNUMAKEFLAGS=${GNUMAKEFLAGS-unset}" > "$BASH3_TEST_MAKE_LOG"\n'
                        'printf \'#!/bin/bash\\nif [[ $1 == -c ]]; then printf 3.2.57; else echo stub; fi\\n\' > bash\n'
                        'chmod 755 bash\n',
            }
            for name, body in stubs.items():
                path = root / name
                path.write_text('#!/bin/bash\nset -e\n' + body)
                path.chmod(0o755)
            log = root / 'make.log'
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                   'BASH3_TEST_MAKE_LOG': str(log), 'MAKEFLAGS': '-j8', 'MFLAGS': '-j8',
                   'GNUMAKEFLAGS': '-j8'}
            env.pop('GITHUB_ENV', None)
            result = subprocess.run(['bash', str(ROOT/'scripts/install-ci-bash3.sh'), str(root/'install')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(log.read_text().splitlines(),
                             ['args=-j1', 'MAKEFLAGS=unset', 'MFLAGS=unset', 'GNUMAKEFLAGS=unset'])
            self.assertTrue((root / 'install/bash').exists())

    def test_download_fallback_still_checks_the_pinned_checksum(self):
        self.check_download_failure(fallback_succeeds=True)

    def test_all_download_sources_failing_never_extracts(self):
        self.check_download_failure(fallback_succeeds=False)

    def check_download_failure(self, fallback_succeeds):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            curl = root / 'curl'
            curl.write_text(
                '#!/bin/bash\nset -e\n'
                'printf "%s\\n" "$*" >> "$BASH3_TEST_CURL_LOG"\n'
                'for arg in "$@"; do dest=$arg; done\n'
                'case "$*" in *ftp.gnu.org*) printf partial > "$dest"; exit 28;; esac\n'
                + ('printf corrupt > "$dest"\n' if fallback_succeeds else 'exit 28\n'))
            curl.chmod(0o755)
            tar = root / 'tar'
            tar.write_text('#!/bin/bash\ntouch "$BASH3_TEST_MARKER"\nexit 1\n')
            tar.chmod(0o755)
            log = root / 'curl.log'
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                   'BASH3_TEST_CURL_LOG': str(log), 'BASH3_TEST_MARKER': str(root / 'extracted')}
            result = subprocess.run(
                ['bash', str(ROOT / 'scripts/install-ci-bash3.sh'), str(root / 'install')],
                env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            calls = log.read_text().splitlines()
            self.assertEqual(len(calls), 2)
            self.assertIn('https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz', calls[0])
            self.assertIn('https://mirrors.kernel.org/gnu/bash/bash-3.2.57.tar.gz', calls[1])
            for call in calls:
                self.assertIn('--connect-timeout 10', call)
                self.assertIn('--max-time 120', call)
            if fallback_succeeds:
                self.assertIn('FAILED', result.stdout)
            else:
                self.assertIn('Unable to download pinned Bash 3.2', result.stderr)
            self.assertFalse((root / 'extracted').exists())


def write_stub(path, version=None, body=None):
    """An executable that answers the installer's version probe (`-c ...`)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if body is None:
        body = f'if [ "$1" = -c ]; then printf %s {version}; else echo "stub bash {version}"; fi\n'
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(0o755)
    return path


def installer(*args, env=None, script=INSTALLER):
    return subprocess.run(['bash', str(script), *args], env=env or os.environ.copy(),
                          capture_output=True, text=True, timeout=30)


def pinned_sha256():
    return re.search(r'^bash_sha256=([0-9a-f]{64})$', INSTALLER.read_text(), re.M).group(1)


class CacheModes(unittest.TestCase):
    """The installer modes behind .github/actions/setup-bash3 stay fail-closed."""

    def test_the_checksum_has_one_copy(self):
        text = INSTALLER.read_text()
        sha = pinned_sha256()
        self.assertEqual(text.count(sha), 1)
        self.assertIn('echo "$bash_sha256  bash.tar.gz" | sha256sum --check', text)

    def test_cache_key_carries_the_pin_the_installer_and_the_runner(self):
        result = installer('--cache-key')
        self.assertEqual(result.returncode, 0, result.stderr)
        key = result.stdout.strip()
        self.assertEqual(result.stdout.count('\n'), 1)
        self.assertTrue(key.startswith(f'bash3-v1-{os.uname().sysname}-{os.uname().machine}-'), key)
        self.assertIn(pinned_sha256(), key)
        self.assertEqual(key, installer('--cache-key').stdout.strip())
        with tempfile.TemporaryDirectory() as temp:
            edited = Path(temp) / 'install-ci-bash3.sh'
            edited.write_text(INSTALLER.read_text().replace('--disable-nls', '--disable-nls --enable-x'))
            other = installer('--cache-key', script=edited).stdout.strip()
            self.assertNotEqual(other, key)
            self.assertIn(pinned_sha256(), other)

    def test_check_accepts_only_the_exact_pinned_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_stub(root / 'good/bash', '3.2.57')
            self.assertEqual(installer('--check', str(root / 'good')).returncode, 0)
            cases = {
                'older-patch': '3.2.48', 'newer-major': '5.2.21', 'missing': None,
                'crashes': 'exit 127\n', 'not-executable': '3.2.57',
            }
            for name, version in cases.items():
                with self.subTest(binary=name):
                    target = root / name / 'bash'
                    if name == 'crashes':
                        write_stub(target, body=version)
                    elif version is not None:
                        write_stub(target, version)
                    if name == 'not-executable':
                        target.chmod(0o644)
                    result = installer('--check', str(root / name))
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, '')

    def install_env(self, root):
        stubs = root / 'stubs'
        write_stub(stubs / 'curl', body='touch "$BASH3_TEST_CURL"\n'
                   'for arg in "$@"; do dest=$arg; done\nprintf corrupt > "$dest"\n')
        write_stub(stubs / 'tar', body='touch "$BASH3_TEST_TAR"\nexit 1\n')
        env = {**os.environ, 'PATH': str(stubs) + os.pathsep + os.environ['PATH'],
               'BASH3_TEST_CURL': str(root / 'curl-called'), 'BASH3_TEST_TAR': str(root / 'extracted'),
               'GITHUB_ENV': str(root / 'github-env')}
        return env

    def test_a_verified_restore_is_reused_without_downloading(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            restored = write_stub(root / 'cache/bash', '3.2.57')
            result = installer(str(root / 'cache'), env=self.install_env(root))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Reusing verified Bash 3.2.57', result.stdout)
            self.assertFalse((root / 'curl-called').exists())
            self.assertEqual((root / 'github-env').read_text(), f'BASH3_BIN={restored.resolve()}\n')

    def test_a_wrong_restore_is_discarded_and_rebuilt_from_the_verified_tarball(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_stub(root / 'cache/bash', '5.2.21')
            result = installer(str(root / 'cache'), env=self.install_env(root))
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / 'curl-called').exists())
            self.assertIn('FAILED', result.stdout)
            self.assertFalse((root / 'extracted').exists())
            self.assertFalse((root / 'cache/bash').exists())
            self.assertFalse((root / 'github-env').exists())

    def test_a_build_that_is_not_the_pin_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stubs = {
                'curl': 'for arg in "$@"; do dest=$arg; done\nprintf source > "$dest"\n',
                'sha256sum': 'cat > /dev/null\n',
                'tar': 'mkdir -p bash-3.2.57\nprintf \'#!/bin/sh\\nexit 0\\n\' > bash-3.2.57/configure\n'
                       'chmod 755 bash-3.2.57/configure\n',
                'make': 'printf \'#!/bin/sh\\nprintf 3.2.48\\n\' > bash\nchmod 755 bash\n',
            }
            for name, body in stubs.items():
                write_stub(root / 'stubs' / name, body=body)
            env = {**os.environ, 'PATH': str(root / 'stubs') + os.pathsep + os.environ['PATH'],
                   'GITHUB_ENV': str(root / 'github-env')}
            result = installer(str(root / 'install'), env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Expected Bash 3.2.57', result.stderr)
            self.assertFalse((root / 'github-env').exists())


def action_steps():
    """Return [(name, block)] for the composite action's steps."""
    body = '\n' + ACTION.read_text().split('\n  steps:\n', 1)[1]
    result = []
    for chunk in body.split('\n    - ')[1:]:
        block = '    - ' + chunk
        first = chunk.split('\n', 1)[0]
        result.append((first[len('name: '):] if first.startswith('name: ') else first, block))
    return result


def action_field(block, key, indent='      '):
    for line in block.splitlines():
        if line.startswith(f'{indent}{key}: '):
            return line[len(f'{indent}{key}: '):]
    return None


class SharedCachedStep(unittest.TestCase):
    """Every Bash 3.2 build goes through one cached composite action."""

    def setUp(self):
        self.steps = action_steps()
        self.names = [name for name, _ in self.steps]
        self.blocks = dict(self.steps)

    def test_action_runs_the_installer_from_its_own_checkout(self):
        self.assertIn('  using: composite\n', ACTION.read_text())
        key = self.blocks['Compute the Bash 3.2 cache key']
        self.assertIn('id: key', key)
        self.assertIn('ACTION_PATH: ${{ github.action_path }}', key)
        self.assertIn('$ACTION_PATH/../../../scripts', key)
        self.assertIn('key=$(bash "$installer" --cache-key)', key)
        self.assertTrue((ACTION.parent / '../../../scripts/install-ci-bash3.sh').resolve().samefile(INSTALLER))

    def test_restore_probe_tools_build_save_order_and_gating(self):
        order = ['Compute the Bash 3.2 cache key', 'Restore cached Bash 3.2',
                 'Check the restored Bash 3.2', 'Install Bash build prerequisites when absent',
                 'Install pinned Bash 3.2', 'Save Bash 3.2 to the cache']
        self.assertEqual(self.names, order)
        restore, save = self.blocks[order[1]], self.blocks[order[5]]
        self.assertIn('uses: actions/cache/restore@', restore)
        self.assertIn('uses: actions/cache/save@', save)
        for block in (restore, save):
            self.assertIn('        key: ${{ steps.key.outputs.key }}\n', block)
            self.assertIn('        path: .dev/ci-bash3\n', block)
            self.assertNotIn('restore-keys', block)
        self.assertIn('bash "$INSTALLER" --check .dev/ci-bash3', self.blocks[order[2]])
        self.assertIn('id: probe', self.blocks[order[2]])
        missed = "steps.probe.outputs.reusable != 'true'"
        self.assertEqual(action_field(self.blocks[order[3]], 'if'), missed)
        self.assertEqual(action_field(save, 'if'), missed)
        self.assertIn('install -y -qq build-essential bison', self.blocks[order[3]])
        build = self.blocks[order[4]]
        self.assertIsNone(action_field(build, 'if'))
        self.assertIsNone(action_field(build, 'continue-on-error'))
        self.assertEqual(action_field(build, 'run'), 'bash "$INSTALLER" .dev/ci-bash3')

    def test_cache_dir_is_gitignored(self):
        self.assertIn('\n.dev/\n', '\n' + (ROOT / '.gitignore').read_text())

    def test_no_workflow_keeps_its_own_copy(self):
        users = []
        for workflow in sorted((ROOT / '.github/workflows').glob('*.yml')):
            text = workflow.read_text()
            with self.subTest(workflow=workflow.name):
                # Only bash3-cache.yml's push filter may name the installer.
                code = [line for line in text.splitlines() if not line.lstrip().startswith('#')
                        and line != '      - scripts/install-ci-bash3.sh']
                self.assertNotIn('install-ci-bash3', '\n'.join(code))
                self.assertNotIn('build-essential bison', text)
                if '$BASH3_BIN' in text:
                    self.assertIn(f'uses: {SETUP_ACTION}\n', text)
                    users.append(workflow.name)
        self.assertEqual(users, ['bash3-cache.yml', 'ci.yml', 'consumer-checks.yml'])

    def test_main_fills_the_cache_for_every_reader(self):
        text = (ROOT / '.github/workflows/bash3-cache.yml').read_text()
        on = text.split('\non:\n', 1)[1].split('\npermissions:', 1)[0]
        for trigger in ('  push:\n    branches: [main]', '  schedule:', '  workflow_dispatch:', '  workflow_call:'):
            self.assertIn(trigger, on)
        for path in ('.github/actions/setup-bash3/**', 'scripts/install-ci-bash3.sh',
                     '.github/workflows/bash3-cache.yml'):
            self.assertIn(f'      - {path}\n', on)
        self.assertNotIn('pull_request', on)
        self.assertNotIn('merge_group', on)
        self.assertIn('    runs-on: ubuntu-24.04\n', text)
        self.assertIn('repository: ${{ job.workflow_repository || github.repository }}', text)
        self.assertIn('ref: ${{ job.workflow_sha || github.sha }}', text)
        self.assertLess(text.index('uses: actions/checkout@'), text.index(f'uses: {SETUP_ACTION}'))


SUITES = ('ci-gate', 'consumer-checks', 'docs-check', 'lint-fixed-sleeps',
          'release-status', 'rust-changed-tests', 'shipped-in')
STUB_BASH3 = '#!/bin/sh\nexit 0\n'


def lookup_env(**extra):
    env = {k: v for k, v in os.environ.items()
           if k not in {'BASH3_BIN', 'BASH3_CACHE_DIR', 'XDG_CACHE_HOME'}}
    env.update(extra)
    return env


def run_lookup(env, body='find_bash3'):
    return subprocess.run(['bash', '-c', f'source "$1"; {body}', 'bash', str(ROOT / 'scripts/find-bash3.sh')],
                          env=env, capture_output=True, text=True)


class CachedBash3(unittest.TestCase):
    """`make bash3` builds into a persistent cache the suites find on their own."""

    def make_cache(self, root):
        cache = root / 'xdg' / 'intent-bash3'
        cache.mkdir(parents=True)
        stub = cache / 'bash'
        stub.write_text(STUB_BASH3)
        stub.chmod(0o755)
        return stub

    def test_lookup_finds_the_cache_without_bash3_bin(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = self.make_cache(Path(temp))
            result = run_lookup(lookup_env(XDG_CACHE_HOME=str(Path(temp) / 'xdg')))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(stub))

    def test_cache_dir_override_and_bash3_bin_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = self.make_cache(Path(temp))
            moved = run_lookup(lookup_env(BASH3_CACHE_DIR=str(stub.parent), XDG_CACHE_HOME=str(Path(temp) / 'none')))
            self.assertEqual(moved.stdout.strip(), str(stub))
            explicit = Path(temp) / 'explicit-bash'
            explicit.write_text(STUB_BASH3)
            explicit.chmod(0o755)
            result = run_lookup(lookup_env(XDG_CACHE_HOME=str(Path(temp) / 'xdg'), BASH3_BIN=str(explicit)))
            self.assertEqual(result.stdout.strip(), str(explicit))

    def test_lookup_skips_a_cached_binary_that_is_not_bash3(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = self.make_cache(Path(temp))
            stub.write_text('#!/bin/sh\nexit 1\n')
            result = run_lookup(lookup_env(XDG_CACHE_HOME=str(Path(temp) / 'xdg')))
            self.assertNotEqual(result.stdout.strip(), str(stub))

    def test_missing_hint_names_the_target(self):
        with tempfile.TemporaryDirectory() as temp:
            result = run_lookup(lookup_env(XDG_CACHE_HOME=temp), 'bash3_missing_hint')
            self.assertIn("run 'make bash3'", result.stdout)
            self.assertIn(f'{temp}/intent-bash3', result.stdout)

    def test_every_suite_uses_the_shared_lookup(self):
        for suite in SUITES:
            text = (ROOT / f'scripts/{suite}.test.sh').read_text()
            with self.subTest(suite=suite):
                self.assertIn('source "$repo_root/scripts/find-bash3.sh"', text)
                self.assertNotIn('find_bash3() {', text)
                self.assertNotIn('(set BASH3_BIN)', text)
                self.assertEqual(text.count('$(bash3_missing_hint)'), 2)

    def run_target(self, cached):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'scripts').mkdir()
            log = root / 'installer.log'
            installer = root / 'scripts/install-ci-bash3.sh'
            installer.write_text(f'printf "%s\\n" "$1" "${{GITHUB_ENV-unset}}" > {log}\n')
            cache = root / 'cache'
            if cached:
                cache.mkdir()
                stub = cache / 'bash'
                stub.write_text('#!/bin/sh\n[ "$1" = -c ] && exit 0\nexit 1\n')
                stub.chmod(0o755)
            elif subprocess.run(['/bin/bash', '-c', '[ "${BASH_VERSINFO[0]}" -eq 3 ]']).returncode == 0:
                self.skipTest('stock /bin/bash is Bash 3; the target builds nothing here')
            env = {k: v for k, v in os.environ.items()
                   if k not in {'MAKEFLAGS', 'MFLAGS', 'MAKELEVEL'}}
            env.update(BASH3_CACHE_DIR=str(cache), GITHUB_ENV=str(root / 'github-env'))
            result = subprocess.run(['make', '--no-print-directory', '-f', str(ROOT / 'Makefile'), 'bash3'],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout, (log.read_text().splitlines() if log.exists() else None), cache

    def test_target_builds_into_the_cache_when_empty(self):
        stdout, installer_args, cache = self.run_target(cached=False)
        self.assertEqual(installer_args, [str(cache), 'unset'])
        self.assertIn('building Bash 3.2.57', stdout)

    def test_target_is_a_no_op_once_built(self):
        stdout, installer_args, cache = self.run_target(cached=True)
        self.assertIsNone(installer_args)
        self.assertIn(f'{cache}/bash is already built', stdout)

    def test_contributing_points_at_the_target(self):
        text = (ROOT / 'CONTRIBUTING.md').read_text()
        section = text.split('### Bash 3 compatibility checks', 1)[1].split('\n#', 1)[0]
        self.assertIn('make bash3', section)
        self.assertNotIn('/tmp', section)


if __name__ == '__main__':
    unittest.main()
