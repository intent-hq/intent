#!/usr/bin/env python3
"""intentd PRs that change the changed-tests scripts run the monorepo suites.

intentd#2720 merged green, then the monorepo merge queue ejected the pin bump
intent#7900 five times ("exec: env: not found") until intent#7905, because
scripts/rust-changed-tests.test.sh ran only in the monorepo queue. The
reusable consumer-checks workflow now runs it (and intentd's own suite) on the
intentd PR when scripts/changed-tests.sh or scripts/with-test-policy.sh
change. These tests keep those steps in place and exercise the selection.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github/workflows/consumer-checks.yml'
SELECT = ROOT / 'scripts/consumer-checks-shell-suites.sh'

SELECT_STEP = 'Select the intentd changed-tests shell suites'
PREREQ_STEP = 'Install Bash build prerequisites when absent'
BASH3_STEP = 'Install pinned Bash 3.2'
SUITES_STEP = 'Run the intentd changed-tests shell suites'
SHELL_SUITE_STEPS = (SELECT_STEP, PREREQ_STEP, BASH3_STEP, SUITES_STEP)
SELECT_IF = "inputs.component == 'intentd' && steps.monorepo.outcome == 'success'"
SELECTED_IF = "steps.shell-suites.outputs.selected == 'true' && steps.monorepo.outcome == 'success'"


def steps(text):
    """Return [(name, block)] for the consumer-checks job's named steps."""
    job = text.split('\n  consumer-checks:\n', 1)[1]
    result = []
    for chunk in job.split('\n      - ')[1:]:
        block = '      - ' + chunk
        first = chunk.split('\n', 1)[0]
        name = first[len('name: '):] if first.startswith('name: ') else first
        result.append((name, block))
    return result


def field(block, key):
    prefix = f'        {key}: '
    for line in block.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):]
    return None


def run_lines(block):
    lines = block.splitlines()
    for index, line in enumerate(lines):
        if line == '        run: |':
            return [entry.strip() for entry in lines[index + 1:] if entry.startswith('          ')]
        if line.startswith('        run: '):
            return [line[len('        run: '):]]
    return []


class WorkflowShape(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()
        self.steps = steps(self.text)
        self.names = [name for name, _ in self.steps]
        self.blocks = dict(self.steps)

    def test_steps_exist_in_order_after_the_consumer_checks(self):
        for name in SHELL_SUITE_STEPS:
            self.assertIn(name, self.names)
        positions = [self.names.index(name) for name in SHELL_SUITE_STEPS]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(positions, list(range(positions[0], positions[0] + 4)))
        self.assertLess(self.names.index('Run the consumer checks (upstream context)'), positions[0])

    def test_selection_is_for_intentd_callers_on_every_event(self):
        block = self.blocks[SELECT_STEP]
        self.assertIn('        id: shell-suites\n', block)
        self.assertEqual(field(block, 'if'), SELECT_IF)
        self.assertEqual(run_lines(block), ['bash scripts/consumer-checks-shell-suites.sh'])
        self.assertIn('          SELF_TEST: ${{ inputs.self-test }}\n', block)
        # The PR's own diff, from the caller's context: a reusable workflow's
        # github context is the caller's event.
        self.assertIn('          BASE_SHA: ${{ github.event.pull_request.base.sha || '
                      'github.event.merge_group.base_sha }}\n', block)
        self.assertIn('          TEST_SHA: ${{ github.sha }}\n', block)

    def test_selected_steps_are_gated_only_on_the_selection(self):
        for name in SHELL_SUITE_STEPS:
            block = self.blocks[name]
            with self.subTest(step=name):
                self.assertNotIn('merge_group', field(block, 'if'))
                self.assertNotIn('event_name', field(block, 'if'))
                self.assertNotIn('continue-on-error', block)
                if name != SELECT_STEP:
                    self.assertEqual(field(block, 'if'), SELECTED_IF)

    def test_bash3_is_built_after_its_prerequisites(self):
        prereq = '\n'.join(run_lines(self.blocks[PREREQ_STEP]))
        self.assertIn('install -y -qq build-essential bison', prereq)
        self.assertIn('command -v yacc', prereq)
        self.assertEqual(run_lines(self.blocks[BASH3_STEP]),
                         ['bash scripts/install-ci-bash3.sh "$RUNNER_TEMP/bash3"'])

    def test_suites_require_a_real_bash3(self):
        self.assertEqual(run_lines(self.blocks[SUITES_STEP]), [
            '"$BASH3_BIN" --version',
            'status=0',
            'REQUIRE_BASH3=1 bash scripts/rust-changed-tests.test.sh || status=1',
            'REQUIRE_BASH3=1 bash packages/intentd/scripts/test-changed-tests.sh || status=1',
            'exit "$status"',
        ])

    def test_header_documents_the_check(self):
        header = self.text.split('\nname: ', 1)[0]
        self.assertIn('Changed-tests shell suites', header)
        self.assertIn('intent#7900', header)
        self.assertIn('intent#7191', header)

    def test_monorepo_shell_tests_run_this_test(self):
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        job = ci.split('\n  shell-tests:\n', 1)[1].split('\n  shell-lint:', 1)[0]
        self.assertIn('python3 -S -B scripts/test_consumer_checks_shell_suites.py',
                      [line.strip() for line in job.splitlines()])
        # The Bash 3.2 selection case must not skip in CI.
        job = ci.split('\n  shell-tests-bash3:\n', 1)[1].split('\n  repo-hygiene:', 1)[0]
        self.assertIn('REQUIRE_BASH3=1 python3 -S -B scripts/test_consumer_checks_shell_suites.py',
                      [line.strip() for line in job.splitlines()])


GIT_ENV = {**{k: v for k, v in os.environ.items()
              if k not in ('GITHUB_OUTPUT', 'SELF_TEST', 'COMPONENT', 'INTENTD_DIR')},
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
           'GIT_COMMITTER_NAME': 'fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                          text=True, env=GIT_ENV).stdout.strip()


def commit(repo, files, message):
    for path, content in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', message)
    return git(repo, 'rev-parse', 'HEAD')


WATCHED = ('scripts/changed-tests.sh', 'scripts/with-test-policy.sh', 'scripts/test-changed-tests.sh',
           'scripts/coverage-storage.py', 'scripts/test-without-provider-clis.sh', 'Makefile')


class Selection(unittest.TestCase):
    """Run the real selection script against fixture repositories."""

    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp)
        self.origin = self.temp / 'intentd-origin'
        self.origin.mkdir()
        git(self.origin, 'init', '-q', '-b', 'main')
        git(self.origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
        self.base = commit(self.origin, {**{path: f'{path}\n' for path in WATCHED},
                                         'README.md': 'intentd\n'}, 'test: base')

    def pr(self, files, base=None):
        """A PR branch from `base` changing `files`, and GitHub's test-merge commit into main."""
        main = git(self.origin, 'rev-parse', 'main')
        git(self.origin, 'checkout', '-q', '-b', 'pr', base or main)
        commit(self.origin, files, 'test: pr')
        git(self.origin, 'checkout', '-q', 'main')
        git(self.origin, 'merge', '-q', '--no-ff', '--no-edit', 'pr')
        merge = git(self.origin, 'rev-parse', 'HEAD')
        git(self.origin, 'reset', '-q', '--hard', main)
        return main, merge

    def checkout(self, head='pr', origin_url=None):
        """The consumer job's tree: packages/intentd shallow at the caller head."""
        mono = self.temp / 'mono'
        shutil.rmtree(mono, ignore_errors=True)
        mono.mkdir()
        child = mono / 'packages/intentd'
        git(mono, 'clone', '-q', '--depth=1', '--no-checkout', f'file://{self.origin}', 'packages/intentd')
        git(child, 'fetch', '-q', '--depth=1', 'origin', git(self.origin, 'rev-parse', head))
        git(child, 'checkout', '-q', '--detach', 'FETCH_HEAD')
        if origin_url is not None:
            git(child, 'remote', 'set-url', 'origin', origin_url)
        return mono

    def select(self, mono, base='', test='', component='intentd', self_test=None, bash='bash'):
        output = self.temp / 'github-output'
        output.write_text('')
        env = {**GIT_ENV, 'GITHUB_OUTPUT': str(output), 'COMPONENT': component,
               'BASE_SHA': base, 'TEST_SHA': test}
        if self_test is not None:
            env['SELF_TEST'] = self_test
        result = subprocess.run([bash, str(SELECT)], cwd=mono, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = dict(line.split('=', 1) for line in output.read_text().splitlines())
        return values, result.stdout

    def test_unrelated_change_skips(self):
        base, merge = self.pr({'README.md': 'changed\n', 'scripts/other.sh': 'true\n'})
        values, _ = self.select(self.checkout(), base, merge)
        self.assertEqual(values['selected'], 'false')
        self.assertIn('does not touch', values['reason'])

    def test_each_watched_file_selects(self):
        for path in WATCHED:
            with self.subTest(path=path):
                base, merge = self.pr({path: 'uname >/dev/null\n'})
                values, _ = self.select(self.checkout(), base, merge)
                self.assertEqual(values['selected'], 'true')
                self.assertEqual(values['reason'], f'this change touches {path}')
                git(self.origin, 'branch', '-q', '-D', 'pr')

    def test_deleting_a_watched_script_selects(self):
        main = git(self.origin, 'rev-parse', 'main')
        git(self.origin, 'checkout', '-q', '-b', 'pr')
        git(self.origin, 'rm', '-q', 'scripts/with-test-policy.sh')
        git(self.origin, 'commit', '-qm', 'test: delete')
        git(self.origin, 'checkout', '-q', 'main')
        git(self.origin, 'merge', '-q', '--no-ff', '--no-edit', 'pr')
        merge = git(self.origin, 'rev-parse', 'HEAD')
        values, _ = self.select(self.checkout(), main, merge)
        self.assertEqual(values['selected'], 'true')

    def test_stale_branch_that_never_touched_the_scripts_skips(self):
        # main moved on with a script change after the branch was cut; the
        # branch head's scripts differ from main's, but its own change does not.
        old = self.base
        commit(self.origin, {'scripts/changed-tests.sh': 'exec env LC_ALL=C plan\n'}, 'test: main moves')
        base, merge = self.pr({'README.md': 'stale\n'}, base=old)
        mono = self.checkout()
        child = mono / 'packages/intentd'
        self.assertNotEqual(git(child, 'show', 'HEAD:scripts/changed-tests.sh'),
                            git(self.origin, 'show', f'{base}:scripts/changed-tests.sh'))
        values, _ = self.select(mono, base, merge)
        self.assertEqual(values['selected'], 'false')

    def test_merge_group_diff_selects(self):
        # The queue's base and head: the head carries the queued PRs.
        base = git(self.origin, 'rev-parse', 'main')
        head = commit(self.origin, {'scripts/changed-tests.sh': 'queued\n'}, 'test: queue head')
        values, _ = self.select(self.checkout('main'), base, head)
        self.assertEqual(values['selected'], 'true')

    def test_missing_or_malformed_shas_select_with_a_notice(self):
        base, merge = self.pr({'README.md': 'changed\n'})
        mono = self.checkout()
        for args in (('', merge), (base, ''), ('main', merge), (base, merge[:12])):
            with self.subTest(args=args):
                values, stdout = self.select(mono, *args)
                self.assertEqual(values['selected'], 'true')
                self.assertIn('::notice::', stdout)

    def test_unfetchable_commits_select_with_a_notice(self):
        base, merge = self.pr({'README.md': 'changed\n'})
        values, stdout = self.select(self.checkout(origin_url=str(self.temp / 'missing')), base, merge)
        self.assertEqual(values['selected'], 'true')
        self.assertIn('::notice::', stdout)
        self.assertIn('could not fetch intentd commit', values['reason'])

    def test_self_test_always_selects(self):
        values, _ = self.select(self.temp, self_test='true')
        self.assertEqual(values['selected'], 'true')

    def test_cloudlands_fe_never_selects(self):
        base, merge = self.pr({'scripts/changed-tests.sh': 'changed\n'})
        for self_test in ('true', 'false'):
            values, _ = self.select(self.temp, base, merge, component='cloudlands-fe', self_test=self_test)
            self.assertEqual(values['selected'], 'false')

    def test_selection_runs_under_bash3(self):
        lookup = subprocess.run(['bash', '-c', 'source "$1"; find_bash3', 'bash',
                                 str(ROOT / 'scripts/find-bash3.sh')], capture_output=True, text=True)
        bash3 = lookup.stdout.strip()
        if lookup.returncode != 0 or not bash3:
            if os.environ.get('REQUIRE_BASH3'):
                self.fail('no Bash 3 interpreter found and REQUIRE_BASH3 is set')
            self.skipTest("no Bash 3 interpreter; run 'make bash3'")
        base, merge = self.pr({'scripts/changed-tests.sh': 'changed\n'})
        mono = self.checkout()
        values, _ = self.select(mono, base, merge, bash=bash3)
        self.assertEqual(values['selected'], 'true')
        values, _ = self.select(mono, base, '', bash=bash3)
        self.assertEqual(values['selected'], 'true')


if __name__ == '__main__':
    unittest.main()
