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
        self.assertIn('fromJSON(needs.runner-route.outputs.runners', job)
        self.assertIn("['ubuntu-24.04']", job)
        self.assertIn('bash scripts/install-ci-bash3.sh', job)
        self.assertLess(job.index('install -y -qq build-essential bison'), job.index('bash scripts/install-ci-bash3.sh'))
        self.assertIn('"$BASH3_BIN" scripts/dev-sandbox.test.sh', job)
        self.assertNotIn('/bin/bash', job)
        for suite in ('ci-gate', 'consumer-checks', 'docs-check', 'dev-sandbox',
                      'lint-fixed-sleeps', 'rust-changed-tests', 'shipped-in'):
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

if __name__ == '__main__':
    unittest.main()
