#!/usr/bin/env python3
"""Keep monorepo jobs, including reusable workflows, on Depot."""
from pathlib import Path
import re
import os
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]


def invalid_runners(text):
    return [value.strip().strip("\"'") for value in
            re.findall(r"^\s+runs-on:\s*([^\n]+)", text, re.M)
            if value.strip().strip("\"'") not in
            {"depot-ubuntu-24.04", "depot-ubuntu-24.04-8", "depot-macos-15"}]


class DepotRunners(unittest.TestCase):
    def test_all_workflows_use_depot(self):
        workflows = list((ROOT / '.github/workflows').glob('*.yml'))
        self.assertTrue(workflows)
        for path in workflows:
            with self.subTest(workflow=path.name):
                self.assertEqual(invalid_runners(path.read_text()), [])

    def test_connected_compilation_requires_managed_cache(self):
        workflow = (ROOT / '.github/workflows/consumer-checks.yml').read_text()
        action = (ROOT / '.github/actions/depot-rust-cache/action.yml').read_text()
        self.assertIn('uses: ./.github/actions/depot-rust-cache', workflow)
        self.assertLess(workflow.index('uses: ./.github/actions/depot-rust-cache'),
                        workflow.index('name: Run the connected transfer selection contract'))
        setup = textwrap.dedent(action.split('      run: |\n', 1)[1].split('    - name:', 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'env'
            env = {k: v for k, v in os.environ.items() if not k.startswith('SCCACHE_')}
            env['GITHUB_ENV'] = str(output)
            result = subprocess.run(['bash', '-eu', '-c', setup], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            env.update(SCCACHE_WEBDAV_ENDPOINT='https://cache.depot.dev', SCCACHE_WEBDAV_TOKEN='test-secret')
            result = subprocess.run(['bash', '-eu', '-c', setup], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('RUSTC_WRAPPER=sccache', output.read_text())
            self.assertNotIn('test-secret', output.read_text())

    def test_rejects_legacy_and_unreviewed_dynamic_runners(self):
        for runner in ['ubuntu-latest', 'macos-latest', '[self-hosted, Linux]',
                       '${{ matrix.runner }}', 'depot-unknown']:
            self.assertEqual(invalid_runners(f'    runs-on: {runner}\n'), [runner])

    def test_accepts_quoted_depot_and_reusable_calls(self):
        self.assertEqual(invalid_runners('    runs-on: "depot-ubuntu-24.04"\n'), [])
        self.assertEqual(invalid_runners('    uses: ./.github/workflows/consumer-checks.yml\n'), [])


if __name__ == '__main__':
    unittest.main()
