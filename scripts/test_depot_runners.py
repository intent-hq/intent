#!/usr/bin/env python3
"""Verify runner policy and Depot fallback caching."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DepotRunners(unittest.TestCase):
    def test_workloads_use_self_hosted_first_policy(self):
        subprocess.run(['python3', '-S', '-B', str(ROOT / 'scripts/test_runner_policy.py')], check=True)

    def test_connected_compilation_requires_managed_cache(self):
        workflow = (ROOT / '.github/workflows/consumer-checks.yml').read_text()
        self.assertIn('run: python3 scripts/setup-depot-sccache.py', workflow)
        self.assertLess(workflow.index('run: python3 scripts/setup-depot-sccache.py'),
                        workflow.index('name: Run the connected transfer selection contract'))
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            self.assertNotIn('Swatinem/rust-cache', path.read_text())
            self.assertNotIn('mozilla-actions/sccache-action', path.read_text())



if __name__ == '__main__':
    unittest.main()
