#!/usr/bin/env python3
"""Bash 3 runs on cheap Linux without dropping shell compatibility coverage."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class Bash3(unittest.TestCase):
    def test_workflow_uses_linux_and_real_interpreter(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        job = workflow.split('  shell-tests-bash3:\n', 1)[1].split('\n  repo-hygiene:', 1)[0]
        self.assertIn("fromJSON(needs.runner-route.outputs.slots || '{}')['shell-tests-bash3'] || fromJSON('[\"ubuntu-24.04\"]')", job)
        self.assertIn('bash scripts/install-ci-bash3.sh', job)
        self.assertLess(job.index('install -y -qq build-essential bison'), job.index('bash scripts/install-ci-bash3.sh'))
        self.assertIn('"$BASH3_BIN" scripts/dev-sandbox.test.sh', job)
        self.assertNotIn('/bin/bash', job)
        for suite in ('ci-gate', 'consumer-checks', 'docs-check', 'dev-sandbox',
                      'lint-fixed-sleeps', 'release-status', 'rust-changed-tests', 'shipped-in'):
            line = next(line for line in job.splitlines() if f'scripts/{suite}.test.sh' in line)
            self.assertIn('REQUIRE_BASH3=1', line)

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
                        'printf \'#!/bin/bash\\nif [[ $1 == -c ]]; then printf 3.2; else echo stub; fi\\n\' > bash\n'
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
