#!/usr/bin/env python3
"""The monorepo's compiler-cache setup is intentd's script, never a second copy.

A monorepo copy of scripts/setup-sccache.py missed intentd#3156 (a download
outage compiles uncached), so one GitHub 504 still ejected intentd#3174 from the
merge queue (intentd run 42572833949). The workflows now run the copy in
packages/intentd, and these tests pin the contract the monorepo depends on:
no local copy, every setup step gets its inputs after packages/intentd is
checked out, and a download outage leaves the job green and uncached for
scripts/with-sccache.sh. The script's own suite is intentd's
scripts/test-setup-sccache.py.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = 'packages/intentd/scripts/setup-sccache.py'
STEP = re.compile(r'\n(\s*)- name:[^\n]*\n((?:\1  [^\n]*\n)*?)\1  run: python3 (\S*setup-sccache\.py)')
JOB = re.compile(r'^  [\w-]+:\n', re.M)
# Ways a job makes packages/intentd available before the setup step runs.
INTENTD_CHECKOUTS = (
    re.compile(r'git submodule update --init[^\n]*packages/intentd'),
    re.compile(r'submodules: (?:true|recursive)'),
    re.compile(r'path: packages/\$\{\{ inputs\.component \}\}[\s\S]*packages/\$\{\{ steps\.component\.outputs\.other \}\}'),
)

# Runs the pinned script's main() with every download attempt answered by an
# HTTP error, so the real retry and fallback paths run without networking.
DRIVER = r'''
import importlib.util, io, sys, time, urllib.error, urllib.request
code = int(sys.argv[2])
def urlopen(url, *args, **kwargs):
    raise urllib.error.HTTPError(url, code, "simulated", {}, io.BytesIO())
urllib.request.urlopen = urlopen
time.sleep = lambda seconds: None
spec = importlib.util.spec_from_file_location("setup_sccache", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.main()
'''

SELF_HOSTED = {'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com', 'INTENT_SCCACHE_TOKEN': 'intent-secret'}
INHERITED = {'RUSTC_WRAPPER': 'sccache', 'SCCACHE_WEBDAV_ENDPOINT': 'https://inherited.example'}


def setup_steps():
    for path in sorted((ROOT/'.github').rglob('*.y*ml')):
        text = path.read_text()
        for match in STEP.finditer(text):
            yield path, text, match


class SharedScript(unittest.TestCase):
    def test_monorepo_keeps_no_copy(self):
        for name in ('setup-sccache.py', 'download_retry.py'):
            self.assertFalse((ROOT/'scripts'/name).exists(), f'scripts/{name} would drift from intentd; run {SCRIPT}')
        self.assertTrue((ROOT/SCRIPT).is_file(), 'packages/intentd is not initialized')

    def test_workflows_run_intentd_script_with_inputs(self):
        steps = 0
        for path, text, match in setup_steps():
            steps += 1
            where = f'{path.relative_to(ROOT)}: {match.group(0).strip().splitlines()[0]}'
            self.assertEqual(match.group(3), SCRIPT, where)
            # Without the switch, token and mode the self-hosted cache silently stays off.
            for line in ('INTENT_SCCACHE_ENDPOINT: ${{ vars.INTENT_SCCACHE_ENDPOINT }}',
                         'INTENT_SCCACHE_TOKEN: ${{ secrets.INTENT_SCCACHE_TOKEN }}',
                         'INTENT_SCCACHE_MODE: ${{ vars.INTENT_SCCACHE_MODE }}'):
                self.assertIn(line, match.group(2), where)
            job_start = max((job.start() for job in JOB.finditer(text, 0, match.start())), default=0)
            before = text[job_start:match.start()]
            self.assertTrue(any(pattern.search(before) for pattern in INTENTD_CHECKOUTS),
                            f'{where}: packages/intentd is not checked out earlier in the job')
        self.assertGreater(steps, 0)
        reusable = (ROOT/'.github/workflows/consumer-checks.yml').read_text()
        self.assertIn('      INTENT_SCCACHE_TOKEN:\n        required: false', reusable)
        self.assertIn('INTENT_SCCACHE_TOKEN: ${{ secrets.INTENT_SCCACHE_TOKEN }}', (ROOT/'.github/workflows/ci.yml').read_text())

    def test_no_depot_cache_path_remains(self):
        for path in (ROOT/'.github').rglob('*.yml'):
            self.assertNotIn('DEPOT_SCCACHE_TOKEN', path.read_text(), str(path))
            self.assertNotIn('setup-depot-sccache', path.read_text(), str(path))


class DownloadOutage(unittest.TestCase):
    def run_setup(self, status, extra=None):
        with tempfile.TemporaryDirectory() as temp:
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(('SCCACHE_', 'RUSTC_WRAPPER', 'INTENT_SCCACHE_', 'GITHUB_'))}
            env.update(SELF_HOSTED, **(extra or {}), RUNNER_TEMP=temp,
                       GITHUB_ENV=f'{temp}/env', GITHUB_PATH=f'{temp}/path')
            result = subprocess.run([sys.executable, '-I', '-c', DRIVER, str(ROOT/SCRIPT), str(status)],
                                    env=env, capture_output=True, text=True, timeout=60)
            env_file = Path(temp, 'env')
            written = dict(line.split('=', 1) for line in env_file.read_text().splitlines()) if env_file.exists() else {}
            return result, written, Path(temp, 'path').exists()

    def wrapped_rustc_wrapper(self, env):
        with tempfile.TemporaryDirectory() as temp:
            stub = Path(temp, 'sccache')
            stub.write_text('#!/bin/sh\nexit 0\n')
            stub.chmod(0o755)
            env = {**env, 'PATH': f'{temp}:{os.environ["PATH"]}'}
            result = subprocess.run(['bash', str(ROOT/'scripts/with-sccache.sh'), 'bash', '-c', 'printf %s "${RUSTC_WRAPPER-unset}"'],
                                    env=env, capture_output=True, text=True, check=True)
            return result.stdout

    def test_gateway_timeout_compiles_uncached_and_exits_zero(self):
        result, written, on_path = self.run_setup(504)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(written, {'INTENT_SCCACHE_DISABLED': '1'})
        self.assertFalse(on_path)
        self.assertIn('::warning::', result.stdout)
        self.assertNotIn('intent-secret', result.stdout + result.stderr)

    def test_inherited_wrapper_is_cleared_and_not_re_added(self):
        result, written, _ = self.run_setup(503, INHERITED)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(written, {'RUSTC_WRAPPER': '', 'SCCACHE_WEBDAV_ENDPOINT': '', 'INTENT_SCCACHE_DISABLED': '1'})
        base = {key: value for key, value in os.environ.items() if not key.startswith(('SCCACHE_', 'RUSTC_WRAPPER', 'INTENT_SCCACHE_'))}
        # A later step whose own env re-supplies the endpoint must still build uncached.
        job = {**base, **written, 'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.example.com'}
        job.pop('RUSTC_WRAPPER')
        self.assertEqual(self.wrapped_rustc_wrapper(job), 'unset')
        self.assertEqual(self.wrapped_rustc_wrapper({**base, 'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.example.com'}), 'sccache')

    def test_wrong_pin_still_fails(self):
        result, written, _ = self.run_setup(404)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('INTENT_SCCACHE_DISABLED', written)


if __name__ == '__main__':
    unittest.main()
