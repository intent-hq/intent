#!/usr/bin/env python3
"""Reject workload cloud pins while allowing only named infrastructure exceptions."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
# The probe must work when the fleet is offline; the intent-cache smoke needs a
# GitHub-hosted writer to prove self-hosted runners reuse its cache entries.
EXCEPTIONS = {('runner-route.yml', 'probe'), ('manual-signed-build.yml', 'smoke-macos'),
              ('intent-cache-smoke.yml', 'cache-writer')}
MAINTENANCE = {('m1mac-smoke.yml', 'smoke'), ('provision-m1mac.yml', 'provision'), ('provision-m1mac.yml', 'verify'), ('macos-prune.yml', 'prune'), ('tinybox-prune.yml', 'prune'), ('windows-prune.yml', 'prune'),
               ('intent-cache-smoke.yml', 'isolation'), ('intent-cache-smoke.yml', 'fresh'), ('intent-cache-smoke.yml', 'cache-reader'),
               ('intent-cache-smoke.yml', 'cache-reader-small')}


def violations(text, filename):
    errors = []
    for match in re.finditer(r'^  ([\w-]+):\s*\n(.*?)(?=^  [\w-]+:\s*$|\Z)', text.split('\njobs:\n', 1)[-1], re.M | re.S):
        job, body = match.groups()
        runner = re.search(r'^    runs-on: (.+)$', body, re.M)
        if not runner:
            continue
        runner = runner[1].strip('"\'')
        if (filename, job) in EXCEPTIONS or (job == 'route' and 'id: decide' in body and 'listSelfHostedRunnersForOrg' in body):
            continue
        if runner.startswith('[self-hosted,') and (filename, job) in MAINTENANCE:
            continue
        routed = re.fullmatch(r"\$\{\{ fromJSON\(needs\.(route|runner-route)\.outputs\.(runners|linux_labels|check_labels).*\}\}", runner)
        if not routed and not (runner == '${{ matrix.os }}' and 'needs.route.outputs.' in body):
            errors.append(job)
    return errors


class RunnerPolicy(unittest.TestCase):
    def test_all_workloads_are_routed(self):
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            with self.subTest(workflow=path.name):
                self.assertEqual(violations(path.read_text(), path.name), [])

    def test_policy_rejects_new_cloud_pins(self):
        for label in ['ubuntu-24.04', 'gh-linux-8x', 'ubuntu-latest', '${{ matrix.runner }}', '${{ needs.unrelated.outputs.runner }}']:
            self.assertEqual(violations(f'jobs:\n  new-work:\n    runs-on: {label}\n', 'new.yml'), ['new-work'])

    def test_shell_jobs_prepare_hosted_image_tools(self):
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        for job in ['shell-tests', 'shell-tests-bash3']:
            body = re.search(r'^  ' + job + r':\n(.*?)(?=^  [\w-]+:)', text, re.M | re.S)[1]
            self.assertIn('uses: actions/setup-node@', body)
            self.assertIn('uses: actions/setup-python@', body)
        lint = text.split('  shell-lint:\n')[1].split('  shell-tests-bash3:')[0]
        self.assertLess(lint.index('install -y -qq shellcheck'), lint.index('run: shellcheck --version'))

    def test_bootstrap_install_uses_isolated_sudo_container(self):
        text = (ROOT / '.github/workflows/bootstrap-install.yml').read_text()
        self.assertNotIn('    container:', text)
        self.assertIn('sudo -n docker', text)
        self.assertIn('readonly', text)
        self.assertIn('cp -a /source/. /workspace/', text)
        self.assertIn('ubuntu:24.04', text)
        self.assertIn('scripts/bootstrap-dev-host.sh --check', text)

    def test_routing_behavior(self):
        subprocess.run(['node', '--test', str(ROOT / 'scripts/runner-policy.test.cjs')], check=True)


if __name__ == '__main__':
    unittest.main()
