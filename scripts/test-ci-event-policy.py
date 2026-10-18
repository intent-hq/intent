#!/usr/bin/env python3
"""Regression proof for the monorepo PR/queue boundary and bootstrap selection."""
from pathlib import Path
import json
import os
import re
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


def queue_job_commands():
    """Run text of every ci.yml step job that executes on merge_group."""
    commands = []
    for job in workflow('ci.yml')['jobs'].values():
        condition = job.get('if')
        if condition is None or "== 'merge_group'" in condition:
            commands += [step['run'] for step in job.get('steps', []) if 'run' in step]
    return '\n'.join(commands)


def make_rule(target):
    """Prerequisites and recipe of one root Makefile target."""
    rule, inside = [], False
    for line in (ROOT / 'Makefile').read_text().splitlines():
        if inside and line.startswith('\t'):
            rule.append(line)
            continue
        inside = False
        match = re.match(r'^([\w.-]+(?:[ \t]+[\w.-]+)*)[ \t]*:(?!=)(.*)$', line)
        if match and target in match.group(1).split():
            inside = True
            rule.append(match.group(2).split('##')[0])
    return '\n'.join(rule)


def expand_reachable(text):
    """Follow make targets and scripts/*.py|*.sh helpers the text invokes.

    This file is never expanded: it names suites in prose, not invocations.
    """
    seen = {('file', f'scripts/{Path(__file__).name}')}
    pending, reached = [('text', text)], []
    while pending:
        kind, chunk = pending.pop()
        reached.append(chunk)
        refs = [('make', t) for t in re.findall(r'(?:\bmake|\$\(MAKE\))(?:[ \t]+(?:-\S+|[A-Z_]+=\S*))*[ \t]+([a-z][\w-]*)', chunk)]
        if kind == 'rule':
            refs += [('make', t) for t in chunk.split('\n', 1)[0].split()]
        refs += [('file', f) for f in re.findall(r'scripts/[\w.-]+\.(?:py|sh)\b', chunk)]
        refs += [('file', f'scripts/{m}.py') for m in re.findall(r'\bscripts\.(test_\w+)', chunk)]
        for ref in refs:
            if ref in seen:
                continue
            seen.add(ref)
            ref_kind, name = ref
            if ref_kind == 'make':
                rule = make_rule(name)
                if rule:
                    pending.append(('rule', rule))
            elif (ROOT / name).is_file():
                pending.append(('file', (ROOT / name).read_text()))
    return '\n'.join(reached)


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
        self.assertEqual(jobs['bootstrap-install']['permissions'], {'contents': 'read', 'actions': 'read'})

    def test_every_scripts_node_suite_runs_in_the_merge_queue(self):
        # check-app-ui-targets.test.mjs landed (#6830) without any CI step, and
        # the breaking-token / submodule-pins unit suites ran only in their
        # pull_request-only jobs, so the queue never re-tested them on the
        # merged tree. Every scripts/ node:test suite must be reached from a
        # job that runs on merge_group, directly or via make / helper scripts.
        suites = sorted(p.name for p in (ROOT / 'scripts').iterdir()
                        if p.name.endswith(('.test.mjs', '.test.cjs')))
        self.assertTrue(suites)
        reached = expand_reachable(queue_job_commands())
        missing = [name for name in suites if name not in reached]
        self.assertEqual(missing, [], 'scripts/ node:test suites not run by any merge_group job in '
                         '.github/workflows/ci.yml (add a `node --test` step to a job that runs in the queue)')

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

    def test_bootstrap_container_receives_ci_without_a_terminal(self):
        steps = workflow('bootstrap-install.yml')['jobs']['bootstrap-install']['steps']
        command = next(s['run'] for s in steps if s.get('name') == 'Install and check in clean Ubuntu')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            capture = root / 'args.json'
            sudo = root / 'sudo'
            sudo.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                            'with open(os.environ["CAPTURE"], "w") as f:\n'
                            '    json.dump(sys.argv[1:], f)\n')
            sudo.chmod(0o755)
            result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command],
                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                env={**os.environ, 'PATH': temp + os.pathsep + os.environ['PATH'],
                     'CAPTURE': str(capture), 'GITHUB_WORKSPACE': '/runner/source with spaces', 'CI': 'true'})
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(capture.read_text())
            self.assertEqual(args[:4], ['-n', 'docker', 'run', '--rm'])
            options = args[4:args.index('ubuntu:24.04')]
            environment = [options[i + 1] for i, arg in enumerate(options) if arg in ('--env', '-e')]
            self.assertIn('CI=true', environment, 'Docker does not inherit the runner CI environment')
            self.assertIn('type=bind,source=/runner/source with spaces,target=/source,readonly', options)


if __name__ == '__main__':
    unittest.main()
