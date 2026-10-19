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
# The intent-cache Linux slots are unprivileged containers (no sudo, no Docker
# socket), so jobs that need either stay on a hosted runner.
HOSTED_ONLY = {
    ('bootstrap-install.yml', 'bootstrap-install'): 'runs sudo docker',
}
EXCEPTIONS |= set(HOSTED_ONLY)
MAINTENANCE = {('m1mac-smoke.yml', 'smoke'), ('provision-m1mac.yml', 'provision'), ('provision-m1mac.yml', 'verify'), ('macos-prune.yml', 'prune'), ('windows-prune.yml', 'prune'),
               ('intent-cache-smoke.yml', 'isolation'), ('intent-cache-smoke.yml', 'fresh'), ('intent-cache-smoke.yml', 'cache-reader'),
               ('intent-cache-smoke.yml', 'cache-reader-small')}


def jobs(text):
    body = text.split('\njobs:\n', 1)[-1]
    return dict(m.groups() for m in re.finditer(r'^  ([\w-]+):\s*\n(.*?)(?=^  [\w-]+:\s*$|\Z)', body, re.M | re.S))


def privileged_steps(body):
    """Steps that call Docker, or sudo outside an `if !` / `command -v ... ||` probe.

    A probe only helps when the intent-cache image already has what it checks
    for; jobs whose probe would still reach sudo there belong in HOSTED_ONLY.
    """
    found = []
    code = '\n'.join(line for line in body.splitlines() if not line.lstrip().startswith('#'))
    for step in re.split(r'^      - ', code, flags=re.M)[1:]:
        guarded = re.search(r'^\s+if ! |command -v [\w-]+ >/dev/null \|\|', step, re.M)
        if re.search(r'\bdocker\b', step) or (re.search(r'\bsudo\b', step) and not guarded):
            found.append(step.splitlines()[0])
    return found


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

    def test_routed_jobs_run_unprivileged(self):
        # A routed Linux job may land on an intent-cache slot, which has no sudo or Docker.
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            for job, body in jobs(path.read_text()).items():
                if (path.name, job) in EXCEPTIONS | MAINTENANCE or 'needs.runner-route.outputs' not in body:
                    continue
                with self.subTest(workflow=path.name, job=job):
                    self.assertEqual(privileged_steps(body), [])

    def test_hosted_only_jobs_are_pinned_to_hosted_linux(self):
        for (name, job), reason in HOSTED_ONLY.items():
            with self.subTest(workflow=name, job=job, reason=reason):
                body = jobs((ROOT / '.github/workflows' / name).read_text())[job]
                self.assertRegex(body, r'(?m)^    runs-on: ubuntu-24\.04$')
                self.assertRegex(body, r'\bsudo\b', 'drop the exception once the job is unprivileged')

    def test_privileged_step_detection(self):
        self.assertEqual(privileged_steps('      - run: |\n          if ! pkg-config --exists openssl; then\n            sudo apt-get install -y libssl-dev\n          fi\n'), [])
        self.assertEqual(len(privileged_steps('      - run: sudo apt-get install -y bison\n')), 1)
        self.assertEqual(len(privileged_steps('      - run: sudo -n docker run --rm ubuntu\n')), 1)

    def test_no_tinybox_routing(self):
        # tinybox left the rotation; Linux routing targets the intent-cache slots only.
        for path in [*(ROOT / '.github').rglob('*.yml'), *(ROOT / '.github').rglob('*.yaml')]:
            self.assertNotRegex(path.read_text(), r'(?i)tinybox', str(path))
        route = (ROOT / '.github/workflows/runner-route.yml').read_text()
        self.assertIn("linux: ['self-hosted', 'linux', 'x64', 'intent-cache'],", route)

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
