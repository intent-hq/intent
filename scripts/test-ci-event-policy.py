#!/usr/bin/env python3
"""Regression proof for the monorepo PR/queue boundary and bootstrap selection."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
QUEUE_JOBS = {'bridge-test', 'python-tests', 'shell-tests', 'shell-tests-bash3', 'bootstrap-install'}
RUNTIME_STEPS = {'Verify connected harnesses and source revisions', 'Prepare the connected test toolchains',
                 'Configure Depot managed compiler cache', 'Install the selected renderer dependencies',
                 'Run the connected transfer selection contract'}


def workflow(name):
    return yaml.safe_load((ROOT / '.github/workflows' / name).read_text())


class EventPolicy(unittest.TestCase):
    def test_queue_jobs_are_reachable_and_required_without_pr_execution(self):
        jobs = workflow('ci.yml')['jobs']
        for name in QUEUE_JOBS:
            self.assertEqual(jobs[name]['if'], "github.event_name == 'merge_group'")
            self.assertIn(name, jobs['gate']['needs'])
            self.assertFalse(jobs[name].get('continue-on-error'))
        self.assertEqual(jobs['consumer-checks-exercise']['if'], "github.event_name == 'merge_group' && needs.consumer-checks-prepare.outputs.selected == 'true'")
        self.assertIn('consumer-checks-exercise', jobs['gate']['needs'])
        self.assertEqual(jobs['bootstrap-install']['uses'], './.github/workflows/bootstrap-install.yml')

    def test_reusable_contract_has_static_pr_checks_and_required_queue_runtime(self):
        jobs = workflow('consumer-checks.yml')['jobs']
        steps = {s.get('name'): s for s in jobs['consumer-checks']['steps']}
        self.assertEqual(steps['Run the consumer checks (upstream context)']['if'], "steps.monorepo.outcome == 'success'")
        for name in RUNTIME_STEPS:
            self.assertEqual(steps[name]['if'], "github.event_name == 'merge_group' && steps.monorepo.outcome == 'success'")
            self.assertFalse(steps[name].get('continue-on-error'))

    def test_bootstrap_is_queue_callable_and_remains_scheduled_and_manual(self):
        doc = workflow('bootstrap-install.yml')
        self.assertEqual(set(doc.get('on', doc.get(True))), {'workflow_call', 'workflow_dispatch', 'schedule'})
        steps = doc['jobs']['bootstrap-install']['steps']
        install = next(s for s in steps if s.get('name') == 'Install and check in clean Ubuntu')
        self.assertEqual(install['if'], "steps.select.outputs.selected == 'true'")
        self.assertFalse(install.get('continue-on-error'))

    def test_bootstrap_selection_executes_real_diff_and_fails_closed(self):
        steps = workflow('bootstrap-install.yml')['jobs']['bootstrap-install']['steps']
        command = next(s['run'] for s in steps if s.get('name') == 'Select bootstrap changes')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def git(*args):
                return subprocess.check_output(['git', '-C', temp, *args], text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-q')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            git('config', 'commit.gpgsign', 'false')
            git('commit', '-q', '--allow-empty', '-m', 'test: base')
            base = git('rev-parse', 'HEAD')
            def run(event, head, queue_base=base):
                output = root/'output'
                output.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command], cwd=root,
                    env={**os.environ, 'EVENT':event, 'QUEUE_BASE':queue_base, 'QUEUE_HEAD':head, 'GITHUB_OUTPUT':str(output)}, capture_output=True)
                return result.returncode, output.read_text() if output.exists() else ''
            self.assertEqual(run('merge_group', base), (0, 'selected=false\n'))
            (root/'scripts').mkdir()
            file = root/'scripts/bootstrap-dev-host.sh'
            file.write_text('fixture')
            git('add', '.')
            git('commit', '-qm', 'test: relevant')
            head = git('rev-parse', 'HEAD')
            self.assertEqual(run('merge_group', head), (0, 'selected=true\n'))
            for event in ('schedule','workflow_dispatch'):
                self.assertEqual(run(event, ''), (0, 'selected=true\n'))
            for bad_base, bad_head in [('',head), ('f'*40,head), (base,'e'*40)]:
                status, output = run('merge_group',bad_head,bad_base)
                self.assertNotEqual(status,0)
                self.assertEqual(output,'')
            git('rm','scripts/bootstrap-dev-host.sh')
            git('commit','-qm','test: removal')
            self.assertEqual(run('merge_group',git('rev-parse','HEAD'),head), (0, 'selected=true\n'))


if __name__ == '__main__':
    unittest.main()
