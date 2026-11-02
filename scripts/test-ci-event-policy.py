#!/usr/bin/env python3
"""Regression proof for the monorepo PR/queue boundary and bootstrap selection."""
from pathlib import Path
import functools
import json
import os
import re
import subprocess
import tempfile
import unittest
from unittest import mock
import yaml

ROOT = Path(__file__).resolve().parents[1]
QUEUE_JOBS = {'bridge-test', 'shell-tests', 'shell-tests-bash3', 'bootstrap-install'}
RUNTIME_STEPS = {'Verify connected harnesses and source revisions', 'Prepare the connected test toolchains',
                 'Configure the self-hosted compiler cache', 'Install the selected renderer dependencies',
                 'Run the connected transfer selection contract'}


def workflow(name):
    return yaml.safe_load((ROOT / '.github/workflows' / name).read_text())


NODE_SUITE_SUFFIXES = ('.test.mjs', '.test.cjs', '.test.js')
# Directories whose node:test suites must run in the queue: top-level scripts/
# only, and every depth of the protocol fixtures and workflow helper scripts.
SUITE_ROOTS = (('scripts', False), ('docs/protocol/fixtures', True), ('.github/scripts', True))
# A suite path or glob, optionally `./`-prefixed; group 1 is an opening quote,
# which is what makes bash pass `**` to node (unquoted, bash has no globstar).
SUITE_PATH = re.compile(r'(?<![\w./-])(["\']?)(?:\./)?((?:\.github/|docs/|scripts/)[\w./*?!\[\]-]*)')
MAKE_VAR = re.compile(r'^[ \t]*(\w+)=["\']?\$\{MAKE(?::-make)?\}', re.M)
SHELL_LOOP = re.compile(r'^[ \t]*for[ \t]+\w+[ \t]+in[ \t]+\$\{?(\w+)\}?[ \t]*(?:;|\n)[ \t\n]*do\b(.*?)^[ \t]*done\b',
                        re.M | re.S)
MAKE_CALL = re.compile(r'(?:\bmake|\$\(MAKE\))(?:[ \t]+(?:-[Cf][ \t]*\S+|-\S+|[A-Z_]+=\S*))*[ \t]+([a-z][\w-]*)')
SCRIPT_FILE = re.compile(r'(?<![\w./-])(?:\.github/)?scripts/[\w./-]+\.(?:py|sh)\b')
PY_MODULE = re.compile(r'\bscripts\.(test_\w+)')


def runs_on_merge_group(condition):
    """Whether a job/step `if:` can run on merge_group (False only when it pins another event)."""
    if condition is None or condition is True:
        return True
    if condition is False:
        return False
    text = re.sub(r'\s+', '', str(condition)).replace('"', "'")
    events = re.findall(r"github\.event_name(==|!=)'(\w+)'", text)
    if events and '||' in text:
        raise AssertionError(f'unsupported event condition, extend runs_on_merge_group: {condition}')
    return not any((op == '==' and event != 'merge_group') or (op == '!=' and event == 'merge_group')
                   for op, event in events)


def without_comments(text):
    return '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))


def queue_step_commands(name='ci.yml'):
    """Run text of every blocking step that can execute on merge_group, following local reusable workflows.

    In ci.yml only jobs the `gate` job needs count, and `continue-on-error`
    jobs/steps never do: a failing suite there would not block the queue.
    """
    commands = []
    jobs = workflow(name)['jobs']
    required = set(jobs['gate']['needs']) if name == 'ci.yml' else set(jobs)
    for job_name, job in jobs.items():
        if job_name not in required or job.get('continue-on-error') or not runs_on_merge_group(job.get('if')):
            continue
        uses = job.get('uses', '')
        if uses.startswith('./.github/workflows/'):
            commands += queue_step_commands(uses.rsplit('/', 1)[1])
        commands += [step['run'] for step in job.get('steps', [])
                     if 'run' in step and not step.get('continue-on-error') and runs_on_merge_group(step.get('if'))]
    return commands


@functools.lru_cache(maxsize=None)
def makefile_rules():
    """Root Makefile target -> prerequisites (first line) plus recipe, comments dropped."""
    rules, current = {}, []
    for line in (ROOT / 'Makefile').read_text().splitlines():
        if current and line.startswith('\t'):
            for target in current:
                rules[target] += '\n' + line
            continue
        if current and (not line.strip() or line.lstrip().startswith('#')):
            continue
        current = []
        match = re.match(r'^([\w.-]+(?:[ \t]+[\w.-]+)*)[ \t]*:(?![:=])(.*)$', line)
        if match:
            current = match.group(1).split()
            for target in current:
                rules[target] = rules.get(target, '') + match.group(2).split('##')[0]
    return {target: without_comments(text) for target, text in rules.items()}


def expand_reachable(commands):
    """Text executed by `commands`, following make targets and scripts/*.py|*.sh helpers.

    Make targets are followed only from CI steps and Makefile rules (helper
    prose such as "run make bootstrap-dev-host" is not an invocation); this
    file is never followed because it names suites in prose.
    """
    seen = {('file', f'scripts/{Path(__file__).name}')}
    pending = [('text', without_comments(c)) for c in commands]
    reached = []
    while pending:
        kind, chunk = pending.pop()
        reached.append(chunk)
        refs = []
        if kind in ('text', 'rule'):
            refs += [('make', t) for t in MAKE_CALL.findall(chunk)]
        if kind == 'rule':
            refs += [('make', t) for t in chunk.split('\n', 1)[0].split()]
        if kind == 'file':
            refs += [('make', t) for t in looped_make_targets(chunk)]
        refs += [('file', f) for f in SCRIPT_FILE.findall(chunk)]
        refs += [('file', f'scripts/{m}.py') for m in PY_MODULE.findall(chunk)]
        for ref in refs:
            if ref in seen:
                continue
            seen.add(ref)
            ref_kind, name = ref
            if ref_kind == 'make' and name in makefile_rules():
                pending.append(('rule', makefile_rules()[name]))
            elif ref_kind == 'file' and (ROOT / name).is_file():
                pending.append(('file', without_comments((ROOT / name).read_text())))
    return '\n'.join(reached)


def node_suites():
    """Repo-relative paths of every node:test suite under SUITE_ROOTS."""
    suites = []
    for root, recursive in SUITE_ROOTS:
        files = (ROOT / root).rglob('*') if recursive else (ROOT / root).iterdir()
        suites += [p.relative_to(ROOT).as_posix() for p in files
                   if p.is_file() and p.name.endswith(NODE_SUITE_SUFFIXES) and 'node_modules' not in p.parts]
    return sorted(suites)


def glob_regex(pattern, globstar=True):
    """Shell glob -> regex: `*`/`?` stay within one path segment; `**` crosses them only with globstar.

    Brace expansion is not modelled, so `{a,b}` stays literal and fails closed.
    """
    if not globstar:
        pattern = re.sub(r'\*{2,}', '*', pattern)
    out, i = '', 0
    while i < len(pattern):
        if pattern.startswith('**/', i):
            out, i = out + '(?:.*/)?', i + 3
        elif pattern.startswith('**', i):
            out, i = out + '.*', i + 2
        elif pattern[i] == '*':
            out, i = out + '[^/]*', i + 1
        elif pattern[i] == '?':
            out, i = out + '[^/]', i + 1
        elif pattern[i] == '[' and ']' in pattern[i + 1:]:
            end = pattern.index(']', i + 1)
            body = pattern[i + 1:end]
            body = '^' + body[1:] if body[:1] in '!^' and body else body
            out, i = out + '[' + body.replace('\\', '\\\\') + ']', end + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out)


def suite_is_run(path, text):
    """Repo-relative `path` appears whole in `text`, or a path glob in `text` matches it."""
    for quote, token in SUITE_PATH.findall(text):
        if token == path or (any(c in token for c in '*?[') and glob_regex(token, bool(quote)).fullmatch(path)):
            return True
    return False


def looped_make_targets(text):
    """Targets of a shell `for t in $LIST; do ... $make_var ...; done` where make_var=${MAKE:-make}.

    scripts/consumer-checks.sh runs its checks this way, so `make consumer-checks`
    reaches each listed target only through LIST's literal assignment.
    """
    make_vars = MAKE_VAR.findall(text)
    targets = []
    for list_var, body in SHELL_LOOP.findall(text):
        if not any(re.search(r'\$\{?' + var + r'\b', body) for var in make_vars):
            continue
        assigned = re.findall(r'^[ \t]*' + list_var + r'=(.*)$', text, re.M)
        literal = re.fullmatch(r'(["\'])([\w\s-]*)\1', assigned[0].strip()) if len(assigned) == 1 else None
        if not literal:
            raise AssertionError(f'make loop over ${list_var} needs one literal quoted assignment, '
                                 f'extend looped_make_targets: {assigned}')
        targets += literal.group(2).split()
    return targets


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
        # merged tree. Nine docs/protocol/fixtures suites likewise never ran in
        # any CI job. Every node:test suite under SUITE_ROOTS must be reached
        # from a step that runs on merge_group, directly or via make / helpers.
        suites = node_suites()
        for root, _ in SUITE_ROOTS:
            self.assertTrue(any(s.startswith(root + '/') for s in suites), root)
        reached = expand_reachable(queue_step_commands())
        missing = [path for path in suites if not suite_is_run(path, reached)]
        self.assertEqual(missing, [], 'node:test suites not run by any merge_group step of '
                         '.github/workflows/ci.yml (add a `node --test` step to a job that runs in the queue)')

    def test_queue_suite_scan_rejects_mentions_and_pr_only_steps(self):
        self.assertTrue(runs_on_merge_group(None))
        self.assertTrue(runs_on_merge_group("github.event_name == 'merge_group' && needs.x.outputs.y == 'true'"))
        self.assertTrue(runs_on_merge_group("github.event_name != 'pull_request'"))
        self.assertTrue(runs_on_merge_group("steps.check.outcome == 'failure'"))
        self.assertFalse(runs_on_merge_group("github.event_name=='pull_request'"))
        self.assertFalse(runs_on_merge_group(False))
        self.assertTrue(suite_is_run('scripts/ref.test.mjs', 'node --test scripts/ref.test.mjs'))
        self.assertFalse(suite_is_run('scripts/ref.test.mjs', 'node --test scripts/submodule-ref.test.mjs'))
        self.assertFalse(suite_is_run('scripts/a.test.mjs', 'node --test scripts/a.test.mjs.bak'))
        self.assertFalse(suite_is_run('scripts/a.test.mjs', 'node --test other/scripts/a.test.mjs'))
        self.assertTrue(suite_is_run('scripts/a.test.mjs', 'node --test scripts/*.test.mjs'))
        self.assertFalse(suite_is_run('scripts/a.test.mjs', expand_reachable(['# node --test scripts/a.test.mjs'])))
        fixture = 'docs/protocol/fixtures/nodes/enrollment.test.mjs'
        self.assertTrue(suite_is_run(fixture, f"node --test '{fixture}'"))
        self.assertTrue(suite_is_run(fixture, 'node --test docs/protocol/fixtures/nodes/*.test.mjs'))
        self.assertFalse(suite_is_run(fixture, 'node --test docs/protocol/fixtures/*.test.mjs'))
        self.assertTrue(suite_is_run(fixture, 'node --test "docs/protocol/fixtures/**/*.test.mjs"'))
        self.assertFalse(suite_is_run(fixture, 'node --test docs/protocol/fixtures/**/**/*.test.mjs'))
        self.assertTrue(suite_is_run(fixture, 'node --test docs/protocol/fixtures/**/*.test.mjs'))
        self.assertFalse(suite_is_run('docs/protocol/fixtures/a.test.mjs', 'node --test docs/protocol/fixtures/**/*.test.mjs'))
        self.assertTrue(suite_is_run(fixture, f'node --test ./{fixture}'))
        self.assertTrue(suite_is_run(fixture, 'node --test docs/protocol/fixtures/nodes/[!x]nrollment.test.mjs'))
        self.assertFalse(suite_is_run(fixture, 'node --test docs/protocol/fixtures/nodes/[!e]nrollment.test.mjs'))
        self.assertFalse(suite_is_run(fixture, 'node --test docs/protocol/fixtures/nodes/enrollment.test.mjs.orig'))
        self.assertTrue(suite_is_run('.github/scripts/t/a.test.js', 'node --test .github/scripts/t/[ab].test.js'))
        self.assertFalse(suite_is_run('.github/scripts/t/a.test.js', 'node --test scripts/t/a.test.js'))
        self.assertTrue(suite_is_run('scripts/agent-worker-contract.test.mjs',
                                     expand_reachable(['make RUSTUP_CARGO= check-agent-worker-contract'])))
        self.assertEqual(SCRIPT_FILE.findall('bash .github/scripts/t/run.sh && scripts/x.py other/scripts/y.sh'),
                         ['.github/scripts/t/run.sh', 'scripts/x.py'])
        self.assertTrue(suite_is_run('scripts/runner-policy.test.cjs',
                                     expand_reachable(['python3 -S -B scripts/test_hosted_runners.py'])))
        self.assertTrue(suite_is_run('docs/protocol/fixtures/notes/truncated-read.test.mjs',
                                     expand_reachable(['make consumer-checks'])))
        rules = makefile_rules()
        self.assertIn('check-agent-worker-contract', rules)
        self.assertNotIn('#', ''.join(line[:1] for line in rules['docs-check'].splitlines()))

    def test_queue_steps_skip_unblocking_jobs_and_steps(self):
        jobs = {'gate': {'needs': ['a', 'b']},
                'a': {'steps': [{'run': 'node --test a1'}, {'run': 'node --test a2', 'continue-on-error': True}]},
                'b': {'continue-on-error': True, 'steps': [{'run': 'node --test b'}]},
                'c': {'steps': [{'run': 'node --test c'}]}}
        with mock.patch.dict(globals(), workflow=lambda name: {'jobs': jobs}):
            self.assertEqual(queue_step_commands(), ['node --test a1'])

    def test_looped_make_targets_follow_only_make_invoking_loops(self):
        script = '\n'.join([
            'make_bin=${MAKE:-make}', 'checks="lint docs-check"', 'other="not-a-target"',
            'for t in $other; do', '  echo "$t"', 'done',
            'for target in $checks; do', '  $make_bin --no-print-directory $target || status=$?', 'done'])
        self.assertEqual(looped_make_targets(script), ['lint', 'docs-check'])
        self.assertEqual(looped_make_targets(script.replace('$make_bin', 'echo')), [])
        self.assertEqual(looped_make_targets(script.replace('$checks; do', '$checks\ndo')), ['lint', 'docs-check'])
        with self.assertRaises(AssertionError):
            looped_make_targets(script + '\nchecks="$checks extra"')
        with self.assertRaises(AssertionError):
            looped_make_targets(script.replace('checks="lint docs-check"', 'checks=$(list)'))
        self.assertIn('check-note-truncated-read-contract',
                      looped_make_targets((ROOT / 'scripts/consumer-checks.sh').read_text()))

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

    def test_python_tests_run_on_pull_requests_and_always_in_the_queue(self):
        # intent PR 8290 changed scripts/nextest_stress.py, but python-tests ran
        # only in merge_group, so its tests first ran after the PR was queued.
        doc = workflow('ci.yml')
        job = doc['jobs']['python-tests']
        self.assertNotIn('if', job)
        self.assertIn('python-tests', doc['jobs']['gate']['needs'])
        self.assertFalse(job.get('continue-on-error'))
        route = next(line for line in (ROOT / '.github/workflows/ci.yml').read_text().splitlines()
                     if '"key":"python-tests"' in line)
        self.assertNotIn('"events"', route)
        steps = job['steps']
        self.assertEqual(steps[0]['with'].get('fetch-depth'), 2)
        tests = next(s for s in steps if s.get('run') == 'make test-scripts')
        self.assertEqual(tests['if'], "steps.select.outputs.selected == 'true'")

    def test_python_tests_selection_executes_real_diff_and_fails_open(self):
        steps = workflow('ci.yml')['jobs']['python-tests']['steps']
        command = next(s['run'] for s in steps if s.get('name') == 'Select Python test changes')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def git(*args):
                return subprocess.check_output(['git', '-C', temp, *args], text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-q', '-b', 'main')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            git('config', 'commit.gpgsign', 'false')
            (root/'scripts').mkdir()
            (root/'scripts/nextest_stress.py').write_text('x = 1\n')
            (root/'docs.md').write_text('a\n')
            git('add', '.')
            git('commit', '-qm', 'test: base')
            def run(event):
                output = root/'output'
                output.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', command], cwd=root,
                    env={**os.environ, 'EVENT': event, 'GITHUB_OUTPUT': str(output)}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return output.read_text()
            def pr_merge(path, text):
                git('checkout', '-q', '-B', 'pr', 'main')
                (root/path).parent.mkdir(parents=True, exist_ok=True)
                (root/path).write_text(text)
                git('add', '.')
                git('commit', '-qm', 'test: pr ' + path)
                git('checkout', '-q', 'main')
                git('checkout', '-q', '--detach', 'main')
                git('merge', '-q', '--no-ff', '--no-edit', 'pr')
            pr_merge('docs.md', 'b\n')
            self.assertEqual(run('pull_request'), 'selected=false\n')
            self.assertEqual(run('merge_group'), 'selected=true\n')
            for path in ('scripts/nextest_stress.py', 'scripts/test_host_load.py', 'scripts/with-test-policy.sh',
                         'scripts/fixtures/a.json', 'Makefile', '.github/workflows/ci.yml'):
                pr_merge(path, 'changed ' + path + '\n')
                self.assertEqual(run('pull_request'), 'selected=true\n', path)
            git('checkout', '-q', 'main')
            self.assertEqual(run('pull_request'), 'selected=true\n', 'a non-merge checkout must run the tests')

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
