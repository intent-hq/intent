#!/usr/bin/env python3
"""GitHub runner slots: supervisor and installer against stubbed system commands.

`curl`, `docker`, `systemctl` and friends are replaced by stubs on PATH that
log their calls, so no network, Docker or root is needed. Needs bash, jq and
openssl (the GitHub App path signs a real JWT).
"""
from pathlib import Path
import base64
import json
import re
import os
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SUPERVISOR = HERE / 'supervisor.sh'
INSTALL = HERE / 'install.sh'
PAT = 'github_pat_' + 'p' * 40
JIT = 'jit' + 'j' * 60
APP_TOKEN = 'ghs_' + 'a' * 36
HAVE_TOOLS = all(shutil.which(t) for t in ('bash', 'jq', 'openssl'))

CURL_STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
method, out, body, auth, url = 'GET', None, None, None, None
i = 0
while i < len(args):
    a = args[i]
    if a == '-X': method = args[i + 1]; i += 1
    elif a == '-o': out = args[i + 1]; i += 1
    elif a == '--data-binary': body = args[i + 1]; i += 1
    elif a == '--config':
        for line in open(args[i + 1]):
            if line.startswith('header = "Authorization: Bearer '):
                auth = line.split('Bearer ', 1)[1].rstrip().rstrip('"')
        i += 1
    elif a in ('-w', '-H', '--max-time'): i += 1
    elif not a.startswith('-'): url = a
    i += 1
path = url.split('https://api.test', 1)[1]
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'cmd': 'curl', 'method': method, 'path': path, 'auth': auth,
                          'body': body, 'argv': sys.argv[1:]}) + '\n')
responses = json.load(open(os.environ['STUB_RESPONSES']))
status, payload = responses.get(method + ' ' + path) or responses.get(method + ' ' + path.split('?')[0], [404, {'message': 'Not Found'}])
open(out, 'w').write('' if payload is None else json.dumps(payload))
sys.stdout.write(str(status))
'''

DOCKER_STUB = r'''#!/usr/bin/env python3
import json, os, signal, sys, time
log = os.environ['STUB_LOG']
pidfile = os.environ['STUB_DIR'] + '/run.pid'
def record(**kw):
    kw.update(cmd='docker', argv=sys.argv[1:])
    with open(log, 'a') as f: f.write(json.dumps(kw) + '\n')
sub = sys.argv[1:3]
fail = os.environ.get('STUB_DOCKER_FAIL', '')
if sys.argv[1] == 'run':
    record(jit=os.environ.get('ACTIONS_RUNNER_INPUT_JITCONFIG'))
    open(pidfile, 'w').write(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
    time.sleep(float(os.environ.get('STUB_RUN_SECONDS', '0')))
    sys.exit(0)
record()
if sys.argv[1] == 'stop':
    try: os.kill(int(open(pidfile).read()), signal.SIGTERM)
    except (OSError, ValueError): pass
if ' '.join(sub) in fail.split(','): sys.exit(1)
'''

LOG_STUB = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['STUB_LOG'], 'a') as f:
    f.write(json.dumps({'cmd': os.path.basename(sys.argv[0]), 'argv': sys.argv[1:]}) + '\n')
'''

# Shell, not Python: egress.sh makes dozens of iptables calls.
SH_LOG_STUB = r'''#!/bin/sh
args=""
for a in "$@"; do args="$args${args:+, }\"$a\""; done
printf '{"cmd": "%s", "argv": [%s]}\n' "$(basename "$0")" "$args" >> "$STUB_LOG"
'''

# systemctl: enable/disable maintain the wants/ symlinks like the real one.
SYSTEMCTL_STUB = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['STUB_LOG'], 'a') as f:
    f.write(json.dumps({'cmd': 'systemctl', 'argv': sys.argv[1:]}) + '\n')
wants = os.environ['INSTALL_PREFIX'] + '/etc/systemd/system/multi-user.target.wants'
args = [a for a in sys.argv[1:] if not a.startswith('--')]
if args and args[0] in ('enable', 'disable'):
    os.makedirs(wants, exist_ok=True)
    for unit in args[1:]:
        link = os.path.join(wants, unit)
        if args[0] == 'enable' and not os.path.lexists(link): os.symlink('/dev/null', link)
        if args[0] == 'disable' and os.path.lexists(link): os.remove(link)
'''


def write_exe(path, text):
    path.write_text(text)
    path.chmod(0o755)


class Stubbed(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.bin = self.dir / 'bin'
        self.bin.mkdir()
        self.log = self.dir / 'log.jsonl'
        self.log.touch()
        write_exe(self.bin / 'curl', CURL_STUB)
        write_exe(self.bin / 'docker', DOCKER_STUB)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('GITHUB_', 'RUNNER'))}
        self.env.update(PATH=f'{self.bin}:{os.environ["PATH"]}', STUB_LOG=str(self.log),
                        STUB_DIR=str(self.dir), GITHUB_API_URL='https://api.test')

    def calls(self, cmd=None):
        rows = [json.loads(line) for line in self.log.read_text().splitlines()]
        return [r for r in rows if cmd is None or r['cmd'] == cmd]


@unittest.skipUnless(HAVE_TOOLS, 'needs bash, jq and openssl')
class Supervisor(Stubbed):
    def setUp(self):
        super().setUp()
        self.egress = self.dir / 'egress.sh'
        write_exe(self.egress, '#!/bin/sh\necho "egress $*" >> "$STUB_DIR/egress.log"\nexit "${STUB_EGRESS_RC:-0}"\n')
        self.creds = self.dir / 'credentials'
        self.creds.write_text(f'# org runner credential\nGITHUB_TOKEN={PAT}\n')
        self.creds.chmod(0o600)
        self.config = self.dir / 'runners.env'
        self.config.write_text('GITHUB_ORG=example-org\n')
        self.responses = {
            'GET /orgs/example-org/actions/runners': [200, {'runners': [
                {'id': 11, 'name': 'intent-cache-heavy-1-100', 'status': 'offline'},
                {'id': 12, 'name': 'intent-cache-heavy-1-200', 'status': 'online'},
                {'id': 13, 'name': 'intent-cache-heavy-2-100', 'status': 'offline'},
                {'id': 14, 'name': 'intent-cache-heavy-10-100', 'status': 'offline'},
            ]}],
            'GET /orgs/example-org/actions/runner-groups': [200, {'runner_groups': [
                {'id': 1, 'name': 'Default', 'visibility': 'all'},
                {'id': 3, 'name': 'intent-cache', 'visibility': 'selected'}]}],
            'GET /orgs/example-org/actions/runner-groups/3/repositories': [200, {'repositories': [
                {'name': 'intent'}, {'name': 'intentd'}, {'name': 'cloudlands-fe'}]}],
            'DELETE /orgs/example-org/actions/runners/11': [204, None],
            'POST /orgs/example-org/actions/runners/generate-jitconfig': [201, {
                'runner': {'id': 42, 'name': 'intent-cache-heavy-1-x'}, 'encoded_jit_config': JIT}],
            'GET /orgs/example-org/actions/runners/42': [200, {'id': 42, 'busy': False}],
            'DELETE /orgs/example-org/actions/runners/42': [204, None],
        }
        self.env.update(RUNNERS_CONFIG=str(self.config), RUNNERS_CREDENTIALS=str(self.creds),
                        RUNNERS_EGRESS=str(self.egress), RUNNERS_RETRY_DELAY='0',
                        STUB_RESPONSES=str(self.dir / 'responses.json'))

    def start(self, *args, **env):
        (self.dir / 'responses.json').write_text(json.dumps(self.responses))
        return subprocess.Popen(['bash', str(SUPERVISOR), *args], env={**self.env, **env},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def run_supervisor(self, *args, **env):
        proc = self.start(*args, **env)
        out, err = proc.communicate(timeout=60)
        return proc.returncode, out, err

    def assert_no_secret(self, *texts):
        for text in texts:
            for secret in (PAT, JIT, APP_TOKEN):
                self.assertNotIn(secret, text)

    def test_one_job_lifecycle(self):
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        api = [(c['method'], c['path']) for c in self.calls('curl')]
        self.assertEqual(api, [
            ('GET', '/orgs/example-org/actions/runner-groups?per_page=100'),
            ('GET', '/orgs/example-org/actions/runner-groups/3/repositories?per_page=100&page=1'),
            ('GET', '/orgs/example-org/actions/runners?per_page=100&page=1'),
            ('DELETE', '/orgs/example-org/actions/runners/11'),
            ('POST', '/orgs/example-org/actions/runners/generate-jitconfig'),
            ('DELETE', '/orgs/example-org/actions/runners/42'),
        ])
        for call in self.calls('curl'):
            self.assertEqual(call['auth'], PAT)
            self.assertNotIn(PAT, ' '.join(call['argv']))
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache'])
        self.assertEqual(body['runner_group_id'], 3, 'registers into the intent-cache group, never Default')
        self.assertEqual(body['work_folder'], '/home/runner/work')
        self.assertRegex(body['name'], r'^intent-cache-heavy-1-\d+$')
        run = [c for c in self.calls('docker') if c['argv'][0] == 'run'][0]
        self.assertEqual(run['jit'], JIT)
        argv = run['argv']
        self.assertNotIn(JIT, ' '.join(argv))
        for flag in (['--rm'], ['--init'], ['--name', 'gh-runner-heavy-1'], ['--network', 'gh-runners'],
                     ['--cpus', '8'], ['--cpuset-cpus', '0-3,12-15'], ['--memory', '48g'], ['--memory-swap', '48g'],
                     ['--pids-limit', '16384'],
                     ['--cgroup-parent', 'runners.slice'], ['--cap-drop', 'ALL'],
                     ['--security-opt', 'no-new-privileges'], ['--env', 'ACTIONS_RUNNER_INPUT_JITCONFIG']):
            self.assertIn(' '.join(flag), ' '.join(argv))
        self.assertEqual(argv[-1], 'intent-gh-runner:current')
        for forbidden in ('-p', '--publish', '--privileged', '-v', '--volume', '--mount', '/var/run/docker.sock'):
            self.assertNotIn(forbidden, argv)
        self.assertNotIn('host', [argv[i + 1] for i, a in enumerate(argv) if a == '--network'])
        self.assertIn(['rm', '-f', 'gh-runner-heavy-1'], [c['argv'] for c in self.calls('docker')])
        self.assertEqual((self.dir / 'egress.log').read_text(), 'egress check gh-runners0\n')
        self.assert_no_secret(out, err)

    def test_stale_cleanup_reads_every_page(self):
        page1 = [{'id': 1000 + i, 'name': f'other-{i}', 'status': 'online'} for i in range(99)]
        page1.append({'id': 11, 'name': 'intent-cache-heavy-1-100', 'status': 'offline'})
        self.responses['GET /orgs/example-org/actions/runners?per_page=100&page=1'] = [200, {'runners': page1}]
        self.responses['GET /orgs/example-org/actions/runners?per_page=100&page=2'] = [200, {'runners': [
            {'id': 21, 'name': 'intent-cache-heavy-1-300', 'status': 'offline'}]}]
        self.responses['DELETE /orgs/example-org/actions/runners/21'] = [204, None]
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        api = [(c['method'], c['path']) for c in self.calls('curl')]
        # Deleting shifts later runners into pages already read, so every page
        # is listed before anything is deleted.
        lists = [i for i, call in enumerate(api) if call[1].startswith('/orgs/example-org/actions/runners?')]
        deletes = [i for i, call in enumerate(api) if call[0] == 'DELETE']
        self.assertLess(max(lists), min(deletes))
        self.assertIn(('GET', '/orgs/example-org/actions/runners?per_page=100&page=2'), api)
        self.assertIn(('DELETE', '/orgs/example-org/actions/runners/11'), api)
        self.assertIn(('DELETE', '/orgs/example-org/actions/runners/21'), api)
        self.assertNotIn(('GET', '/orgs/example-org/actions/runners?per_page=100&page=3'), api)

    def group_fixture(self, groups):
        for i, repo in enumerate(('intent', 'intentd', 'cloudlands-fe')):
            self.responses[f'GET /repos/example-org/{repo}'] = [200, {'id': 101 + i, 'name': repo}]
        self.responses['GET /orgs/example-org/actions/runner-groups'] = [200, {'runner_groups': groups}]
        self.responses['POST /orgs/example-org/actions/runner-groups'] = [201, {'id': 3, 'name': 'intent-cache'}]
        self.responses['PATCH /orgs/example-org/actions/runner-groups/3'] = [200, {'id': 3}]
        self.responses['PUT /orgs/example-org/actions/runner-groups/3/repositories'] = [204, None]

    def test_group_apply_creates_a_missing_group(self):
        self.group_fixture([{'id': 1, 'name': 'Default'}])
        rc, out, err = self.run_supervisor('--group-apply')
        self.assertEqual(rc, 0, err)
        post = [c for c in self.calls('curl') if c['method'] == 'POST']
        self.assertEqual(json.loads(post[0]['body']), {
            'name': 'intent-cache', 'visibility': 'selected', 'allows_public_repositories': True,
            'restricted_to_workflows': False, 'selected_repository_ids': [101, 102, 103]})
        self.assertFalse([c for c in self.calls('curl') if c['method'] in ('PATCH', 'PUT', 'DELETE')])
        self.assertEqual(self.calls('docker'), [])
        self.assert_no_secret(out, err)

    def test_group_apply_corrects_an_existing_group(self):
        self.group_fixture([{'id': 1, 'name': 'Default'}, {'id': 3, 'name': 'intent-cache'}])
        self.config.write_text('GITHUB_ORG=example-org\nRUNNER_GROUP_REPOS=intent,cloudlands-fe\n')
        rc, out, err = self.run_supervisor('--group-apply')
        self.assertEqual(rc, 0, err)
        calls = {c['method']: c for c in self.calls('curl') if c['method'] != 'GET'}
        self.assertEqual(set(calls), {'PATCH', 'PUT'})
        self.assertEqual(json.loads(calls['PATCH']['body']), {
            'visibility': 'selected', 'allows_public_repositories': True, 'restricted_to_workflows': False})
        self.assertEqual(json.loads(calls['PUT']['body']), {'selected_repository_ids': [101, 103]})
        self.assertNotIn(('GET', '/repos/example-org/intentd'), [(c['method'], c['path']) for c in self.calls('curl')])

    def test_group_apply_twice_converges(self):
        # The group already matches; repeated applies must succeed, create
        # nothing and write the same desired state each time.
        self.group_fixture([{'id': 3, 'name': 'intent-cache', 'visibility': 'selected'}])
        writes = []
        for attempt in (1, 2):
            self.log.write_text('')
            rc, out, err = self.run_supervisor('--group-apply')
            self.assertEqual(rc, 0, f'apply {attempt}: {err}')
            calls = [c for c in self.calls('curl') if c['method'] != 'GET']
            self.assertEqual([c['method'] for c in calls], ['PATCH', 'PUT'], f'apply {attempt}')
            writes.append([(c['method'], c['path'], json.loads(c['body'])) for c in calls])
        self.assertEqual(writes[0], writes[1])
        self.assertEqual(writes[1], [
            ('PATCH', '/orgs/example-org/actions/runner-groups/3',
             {'visibility': 'selected', 'allows_public_repositories': True, 'restricted_to_workflows': False}),
            ('PUT', '/orgs/example-org/actions/runner-groups/3/repositories', {'selected_repository_ids': [101, 102, 103]})])

    def test_group_apply_fails_on_unknown_repository(self):
        self.group_fixture([{'id': 3, 'name': 'intent-cache'}])
        self.config.write_text('GITHUB_ORG=example-org\nRUNNER_GROUP_REPOS=intent,nope\n')
        rc, _, err = self.run_supervisor('--group-apply')
        self.assertNotEqual(rc, 0)
        self.assertIn('repository example-org/nope not found', err)
        self.assertFalse([c for c in self.calls('curl') if c['method'] != 'GET'])

    def check_fixture(self, members, **group):
        self.group_fixture([{'id': 1, 'name': 'Default'}, {'id': 3, 'name': 'intent-cache'}])
        self.responses['GET /orgs/example-org/actions/runner-groups/3'] = [200, {
            'id': 3, 'name': 'intent-cache', 'visibility': 'selected', 'allows_public_repositories': True,
            'restricted_to_workflows': False, **group}]
        self.responses['GET /orgs/example-org/actions/runner-groups/3/repositories'] = [200, {'repositories': [
            {'name': 'intentd'}, {'name': 'intent'}, {'name': 'cloudlands-fe'}]}]
        self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': [
            {'name': 'intent-cache-heavy-1-1'}, {'name': 'intent-cache-small-1-1'}, {'name': 'depot-x'}]}]
        self.responses['GET /orgs/example-org/actions/runner-groups/3/runners'] = [200, {'runners': [
            {'name': n} for n in members]}]

    def test_group_check_passes_when_every_slot_is_in_the_group(self):
        self.check_fixture(['intent-cache-heavy-1-1', 'intent-cache-small-1-1'])
        rc, out, err = self.run_supervisor('--group-check')
        self.assertEqual(rc, 0, err)
        report = json.loads(out)
        self.assertEqual(report['repositories'], ['cloudlands-fe', 'intent', 'intentd'])
        self.assertEqual((report['slot_runners'], report['in_group'], report['outside_group'], report['ok']), (2, 2, [], True))
        self.assertFalse([c for c in self.calls('curl') if c['method'] != 'GET'], 'check never changes anything')
        self.assert_no_secret(out, err)

    def test_group_check_fails_on_drift(self):
        for members, group, field in ((['intent-cache-heavy-1-1'], {}, 'outside_group'),
                                      (['intent-cache-heavy-1-1', 'intent-cache-small-1-1'], {'visibility': 'all'}, 'visibility'),
                                      (['intent-cache-heavy-1-1', 'intent-cache-small-1-1'], {'restricted_to_workflows': True}, 'restricted_to_workflows')):
            with self.subTest(field=field):
                self.log.write_text('')
                self.check_fixture(members, **group)
                rc, out, _ = self.run_supervisor('--group-check')
                self.assertEqual(rc, 1)
                self.assertFalse(json.loads(out)['ok'])
        self.assertEqual(json.loads(out)['outside_group'], [])
        self.check_fixture(['intent-cache-heavy-1-1'])
        rc, out, _ = self.run_supervisor('--group-check')
        self.assertEqual(json.loads(out)['outside_group'], ['intent-cache-small-1-1'])

    def test_refuses_to_register_into_a_drifted_group(self):
        cases = {
            'an extra repository': ('selected', ['intent', 'intentd', 'cloudlands-fe', 'other']),
            'a missing repository': ('selected', ['intent', 'intentd']),
            'visibility all': ('all', ['intent', 'intentd', 'cloudlands-fe']),
        }
        for case, (visibility, repos) in cases.items():
            with self.subTest(case=case):
                self.log.write_text('')
                self.responses['GET /orgs/example-org/actions/runner-groups'] = [200, {'runner_groups': [
                    {'id': 3, 'name': 'intent-cache', 'visibility': visibility}]}]
                self.responses['GET /orgs/example-org/actions/runner-groups/3/repositories'] = [200, {
                    'repositories': [{'name': r} for r in repos]}]
                rc, out, err = self.run_supervisor('heavy-1')
                self.assertNotEqual(rc, 0)
                self.assertIn("runner group 'intent-cache' drifted", err)
                self.assertIn('--group-apply', err)
                self.assertFalse([c for c in self.calls('curl') if c['method'] != 'GET'], 'nothing registered or deleted')
                self.assertNotIn('run', [c['argv'][0] for c in self.calls('docker')])

    def test_missing_runner_group_never_falls_back_to_default(self):
        self.responses['GET /orgs/example-org/actions/runner-groups'] = [200, {'runner_groups': [{'id': 1, 'name': 'Default'}]}]
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assertIn("runner group 'intent-cache' not found", err)
        self.assertFalse([c for c in self.calls('curl') if c['method'] == 'POST'])

    def test_small_pool_slot(self):
        rc, out, err = self.run_supervisor('small-3')
        self.assertEqual(rc, 0, err)
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache-small'])
        self.assertRegex(body['name'], r'^intent-cache-small-3-\d+$')
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][0]['argv'])
        for flag in ('--name gh-runner-small-3', '--cpus 1 ', '--cpuset-cpus 10 ', '--memory 3g',
                     '--pids-limit 4096', '--shm-size 256m'):
            self.assertIn(flag, argv)

    def test_plan_lists_every_slot(self):
        rc, out, err = self.run_supervisor('--plan')
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.split(), ['heavy-1', 'heavy-2'] + [f'small-{n}' for n in range(1, 7)])
        self.assertEqual(self.calls(), [], 'planning touches neither GitHub nor Docker')
        self.config.write_text('GITHUB_ORG=example-org\nRUNNER_POOLS=big\nBIG_SLOTS=2\nBIG_LABELS=self-hosted,big\nBIG_CPUSETS=0-3,12-15 4-7,16-19\nBIG_MEMORY=8g\n')
        rc, out, err = self.run_supervisor('--plan')
        self.assertEqual((rc, out.split()), (0, ['big-1', 'big-2']), err)
        rc, out, err = self.run_supervisor('big-2')
        self.assertEqual(rc, 0, err + out)
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][0]['argv'])
        self.assertIn('--cpus 8 --cpuset-cpus 4-7,16-19 --memory 8g', argv)

    def test_plan_rejects_bad_pools(self):
        for config, message in (
                ('HEAVY_SLOTS=3\n', 'only 2 entries in CPUSETS'),
                ('SMALL_CPUSETS=1 2 x 4 5 6\n', "bad CPUSETS entry 'x'"),
                ('HEAVY_MEMORY=lots\n', 'MEMORY must look like 40g'),
                ('RUNNER_POOLS=heavy extra\n', 'pool extra: SLOTS must be a number'),
                ('HEAVY_BOGUS=1\n', 'unknown key HEAVY_BOGUS')):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, _, err = self.run_supervisor('--plan')
                self.assertNotEqual(rc, 0)
                self.assertIn(message, err)

    def test_unconfigured_slot(self):
        for slot in ('heavy-3', 'small-7', 'other-1'):
            with self.subTest(slot=slot):
                rc, _, err = self.run_supervisor(slot)
                self.assertNotEqual(rc, 0)
                self.assertIn('not a configured slot', err)
                self.assertEqual(self.calls('curl'), [])

    def test_refuses_without_egress_rules(self):
        rc, out, err = self.run_supervisor('heavy-1', STUB_EGRESS_RC='1')
        self.assertNotEqual(rc, 0)
        self.assertIn('egress rules missing', err)
        self.assertEqual(self.calls('curl'), [])
        self.assertEqual(self.calls('docker'), [])

    def test_bare_token_credential(self):
        self.creds.write_text(PAT + '\n')
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        self.assertTrue(all(c['auth'] == PAT for c in self.calls('curl')))
        self.assert_no_secret(out, err)
        self.creds.write_text(PAT + '\nextra\n')
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assert_no_secret(out, err)

    def test_refuses_readable_credential(self):
        self.creds.chmod(0o644)
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assertIn('chmod 600', err)
        self.assertEqual(self.calls('curl'), [])
        self.assert_no_secret(out, err)

    def test_missing_credential(self):
        self.creds.unlink()
        rc, _, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assertIn('missing', err)

    def test_config_values_are_not_evaluated(self):
        marker = self.dir / 'pwned'
        self.config.write_text(f'HEAVY_LABELS=$(touch {marker})\n')
        rc, _, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assertFalse(marker.exists())
        self.config.write_text('UNKNOWN=1\n')
        rc, _, err = self.run_supervisor('heavy-1')
        self.assertNotEqual(rc, 0)
        self.assertIn('unknown key UNKNOWN', err)

    def test_bad_slot(self):
        for slot in ('', '0', 'a', '1', 'heavy-0', 'heavy-1;x', 'Heavy-1'):
            with self.subTest(slot=slot):
                rc, _, _ = self.run_supervisor(slot)
                self.assertEqual(rc, 2)

    def test_registration_failure_exits_nonzero(self):
        self.responses['POST /orgs/example-org/actions/runners/generate-jitconfig'] = [403, {'message': 'Resource not accessible'}]
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 1)
        self.assertIn('HTTP 403', out)
        self.assertNotIn('run', [c['argv'][0] for c in self.calls('docker')])

    def test_missing_image(self):
        rc, _, err = self.run_supervisor('heavy-1', STUB_DOCKER_FAIL='image inspect')
        self.assertNotEqual(rc, 0)
        self.assertIn('image intent-gh-runner:current is missing', err)

    def wait_for_container(self, proc):
        deadline = time.time() + 20
        while not (self.dir / 'run.pid').exists():
            if proc.poll() is not None:
                self.fail(f'supervisor exited early: {proc.communicate()}')
            self.assertLess(time.time(), deadline)
            time.sleep(0.05)

    def test_drain_idle_runner_stops_at_once(self):
        proc = self.start('heavy-1', STUB_RUN_SECONDS='60')
        self.wait_for_container(proc)
        start = time.time()
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0, err)
        self.assertLess(time.time() - start, 20)
        self.assertIn(['stop', '-t', '30', 'gh-runner-heavy-1'], [c['argv'] for c in self.calls('docker')])
        self.assertIn(('DELETE', '/orgs/example-org/actions/runners/42'),
                      [(c['method'], c['path']) for c in self.calls('curl')])
        self.assertIn('drained', out)

    def test_drain_busy_runner_waits_for_job(self):
        self.responses['GET /orgs/example-org/actions/runners/42'] = [200, {'id': 42, 'busy': True}]
        proc = self.start('heavy-1', STUB_RUN_SECONDS='3')
        self.wait_for_container(proc)
        start = time.time()
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 0, err)
        self.assertGreater(time.time() - start, 1.5)
        self.assertNotIn('stop', [c['argv'][0] for c in self.calls('docker')])
        self.assertIn('waiting for the running job', out)
        self.assertIn('drained', out)

    def test_github_app_credential(self):
        key = self.dir / 'app.pem'
        subprocess.run(['openssl', 'genrsa', '-out', str(key), '2048'], check=True, capture_output=True)
        self.creds.write_text(f'GITHUB_APP_ID=12345\nGITHUB_APP_INSTALLATION_ID=678\nGITHUB_APP_PRIVATE_KEY_FILE={key}\n')
        self.responses['POST /app/installations/678/access_tokens'] = [201, {'token': APP_TOKEN}]
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        calls = self.calls('curl')
        self.assertEqual(calls[0]['path'], '/app/installations/678/access_tokens')
        header, payload, sig = calls[0]['auth'].split('.')
        pad = lambda s: s + '=' * (-len(s) % 4)
        self.assertEqual(json.loads(base64.urlsafe_b64decode(pad(header))), {'alg': 'RS256', 'typ': 'JWT'})
        claims = json.loads(base64.urlsafe_b64decode(pad(payload)))
        self.assertEqual(claims['iss'], '12345')
        self.assertLess(claims['exp'] - claims['iat'], 601)
        pub = self.dir / 'pub.pem'
        subprocess.run(['openssl', 'rsa', '-in', str(key), '-pubout', '-out', str(pub)], check=True, capture_output=True)
        (self.dir / 'sig').write_bytes(base64.urlsafe_b64decode(pad(sig)))
        (self.dir / 'msg').write_text(f'{header}.{payload}')
        verify = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(pub), '-signature',
                                 str(self.dir / 'sig'), str(self.dir / 'msg')], capture_output=True)
        self.assertEqual(verify.returncode, 0, verify.stderr)
        org_calls = [c for c in calls if c['path'].startswith('/orgs/')]
        self.assertTrue(org_calls)
        for call in org_calls:
            self.assertEqual(call['auth'], APP_TOKEN)
        self.assert_no_secret(out, err)


@unittest.skipUnless(HAVE_TOOLS, 'needs bash, jq and openssl')
class Installer(Stubbed):
    def setUp(self):
        super().setUp()
        self.prefix = self.dir / 'root'
        self.prefix.mkdir()
        for name in ('apt-get', 'dpkg', 'chown'):
            write_exe(self.bin / name, LOG_STUB)
        for name in ('iptables', 'ip6tables'):
            write_exe(self.bin / name, SH_LOG_STUB)
        write_exe(self.bin / 'systemctl', SYSTEMCTL_STUB)
        write_exe(self.bin / 'id', '#!/bin/sh\necho 0\n')
        os_release = self.dir / 'os-release'
        os_release.write_text('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
        responses = self.dir / 'responses.json'
        responses.write_text(json.dumps({
            **{f'GET /repos/intent-hq/{r}': [200, {'id': 101 + i}] for i, r in enumerate(('intent', 'intentd', 'cloudlands-fe'))},
            'GET /orgs/intent-hq/actions/runner-groups': [200, {'runner_groups': [{'id': 3, 'name': 'intent-cache'}]}],
            'PATCH /orgs/intent-hq/actions/runner-groups/3': [200, {'id': 3}],
            'PUT /orgs/intent-hq/actions/runner-groups/3/repositories': [204, None]}))
        self.env.update(INSTALL_PREFIX=str(self.prefix), OS_RELEASE=str(os_release),
                        INSTALL_OWNER_UID=str(os.getuid()), RUNNERS_OWNER_UID=str(os.getuid()),
                        STUB_RESPONSES=str(responses),
                        STUB_DOCKER_FAIL='network inspect')
        self.creds = self.prefix / 'etc/github-runners/credentials'
        self.env_file = self.prefix / 'etc/github-runners/runners.env'

    def install(self, *args, **env):
        result = subprocess.run(['bash', str(INSTALL), *args], env={**self.env, **env},
                                capture_output=True, text=True, timeout=300)
        return result

    def systemctl(self):
        return [c['argv'] for c in self.calls('systemctl')]

    def enabled(self):
        wants = self.prefix / 'etc/systemd/system/multi-user.target.wants'
        return sorted(p.name for p in wants.glob('github-runner@*')) if wants.exists() else []

    def place_credential(self, mode=0o600):
        self.creds.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.creds.write_text(f'GITHUB_TOKEN={PAT}\n')
        self.creds.chmod(mode)

    def test_fresh_install_without_credential(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        lib = self.prefix / 'usr/local/lib/github-runners'
        for name in ('supervisor.sh', 'egress.sh'):
            self.assertEqual((lib / name).read_bytes(), (HERE / name).read_bytes())
            self.assertTrue((lib / name).stat().st_mode & stat.S_IXUSR)
        units = self.prefix / 'etc/systemd/system'
        for name in ('github-runner@.service', 'runners.slice', 'github-runners-egress.service'):
            self.assertEqual((units / name).read_bytes(), (HERE / name).read_bytes())
        for name in ('caddy.service', 'sccache-webdav.service'):
            self.assertEqual((units / f'{name}.d/runners-priority.conf').read_bytes(), (HERE / 'cache-priority.conf').read_bytes())
        daemon = json.loads((self.prefix / 'etc/docker/daemon.json').read_text())
        self.assertEqual(daemon['userns-remap'], 'default')
        self.assertFalse(daemon['icc'])
        self.assertEqual(stat.S_IMODE((self.prefix / 'etc/github-runners').stat().st_mode), 0o700)
        self.assertEqual(self.env_file.read_bytes(), (HERE / 'runners.env').read_bytes())
        self.assertIn(['restart', 'docker'], self.systemctl())
        self.assertIn(['-w', '-t', 'raw', '-A', 'GH-RUNNERS-EGRESS', '-d', '100.64.0.0/10', '-j', 'DROP'],
                      [c['argv'] for c in self.calls('iptables')], 'the installer reapplies the egress rules itself')
        self.assertFalse([a for a in self.systemctl() if a[0] == 'reload'], 'no systemd job that waits behind draining slots')
        self.assertNotIn(['enable', '--now', 'docker'], self.systemctl(),
                         'a start job on running docker queues behind draining slots')
        self.assertNotIn(['start', 'docker'], self.systemctl(), 'docker is already active (stub)')
        self.assertFalse([a for a in self.systemctl() if a[0] == 'restart' and a[1] != 'docker'],
                         'the installer never restarts the egress unit or a slot, which would drain running jobs')
        docker = [c['argv'] for c in self.calls('docker')]
        create = [a for a in docker if a[:2] == ['network', 'create']][0]
        self.assertIn('com.docker.network.bridge.enable_icc=false', create)
        self.assertIn('com.docker.network.bridge.name=gh-runners0', create)
        self.assertTrue(any(a[0] == 'build' and 'intent-gh-runner:current' in a for a in docker))
        self.assertEqual(self.enabled(), [])
        self.assertIn('credential missing', result.stdout)

    def test_slots_follow_credential_and_config(self):
        self.place_credential()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        default = ['github-runner@heavy-1.service', 'github-runner@heavy-2.service'] + \
            [f'github-runner@small-{n}.service' for n in range(1, 7)]
        self.assertEqual(self.enabled(), sorted(default))
        self.assertIn(['enable', 'github-runner@small-6.service'], self.systemctl())
        rows = [json.loads(line) for line in self.log.read_text().splitlines()]
        put = [i for i, r in enumerate(rows) if r['cmd'] == 'curl' and r['method'] == 'PUT']
        enable = [i for i, r in enumerate(rows) if r['cmd'] == 'systemctl' and r['argv'][0] == 'enable' and 'runner@' in r['argv'][-1]]
        self.assertTrue(put and enable and max(put) < min(enable), 'the group is applied before any slot is enabled')
        self.assertFalse([a for a in self.systemctl() if a[:2] == ['enable', '--now']], 'no blocking starts')

        self.log.write_text('')
        self.env_file.write_text(self.env_file.read_text().replace('SMALL_SLOTS=6', 'SMALL_SLOTS=2'))
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), ['github-runner@heavy-1.service', 'github-runner@heavy-2.service',
                                          'github-runner@small-1.service', 'github-runner@small-2.service'])
        self.assertIn(['disable', '--now', 'github-runner@small-3.service'], self.systemctl())
        self.assertFalse(any(c['argv'][0] == 'build' for c in self.calls('docker')))
        self.assertNotIn(['restart', 'docker'], self.systemctl())

        self.env_file.write_text('RUNNER_POOLS=heavy\nHEAVY_SLOTS=0\n')
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), [])

    def test_group_failure_leaves_slots_alone(self):
        self.place_credential()
        self.env['STUB_RESPONSES'] = str(self.dir / 'empty.json')
        (self.dir / 'empty.json').write_text('{}')
        result = self.install('--no-build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not set up the runner group', result.stderr)
        self.assertEqual(self.enabled(), [])

    def test_invalid_config_changes_nothing(self):
        self.place_credential()
        self.assertEqual(self.install('--no-build').returncode, 0)
        before = self.enabled()
        self.env_file.write_text('HEAVY_SLOTS=5\n')
        self.log.write_text('')
        result = self.install('--no-build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('only 2 entries in CPUSETS', result.stderr)
        self.assertEqual(self.enabled(), before)
        self.assertFalse(any(a[0] == 'disable' for a in self.systemctl()))

    def test_rerun_keeps_config_and_does_not_restart_docker(self):
        self.assertEqual(self.install().returncode, 0)
        env_file = self.env_file
        env_file.write_text('GITHUB_ORG=intent-hq\nHEAVY_MEMORY=30g\n')
        self.log.write_text('')
        result = self.install('--no-build', STUB_DOCKER_FAIL='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(env_file.read_text(), 'GITHUB_ORG=intent-hq\nHEAVY_MEMORY=30g\n')
        self.assertNotIn(['restart', 'docker'], self.systemctl())
        self.assertFalse(any(c['argv'][:2] == ['network', 'create'] for c in self.calls('docker')))

    def test_refuses_readable_credential(self):
        self.install()
        self.place_credential(0o644)
        result = self.install('--no-build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('mode 600', result.stderr)
        self.assertEqual(self.enabled(), [])

    def test_refuses_non_ubuntu_and_bad_args(self):
        other = self.dir / 'debian'
        other.write_text('ID=debian\n')
        result = self.install(OS_RELEASE=str(other))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected Ubuntu, found 'debian'", result.stderr)
        self.assertEqual(self.calls(), [])
        for args in (['--slots', '2'], ['--bogus']):
            with self.subTest(args=args):
                self.assertEqual(self.install(*args).returncode, 2)


class Static(unittest.TestCase):
    def test_runner_and_rustup_are_pinned_with_checksums(self):
        text = (HERE / 'Dockerfile').read_text()
        self.assertRegex(text, r'FROM ubuntu:24\.04@sha256:[0-9a-f]{64}')
        self.assertRegex(text, r'ARG RUNNER_VERSION=\d+\.\d+\.\d+')
        self.assertRegex(text, r'ARG RUNNER_SHA256=[0-9a-f]{64}')
        for tool in ('RUNNER', 'RUSTUP', 'GH', 'NODE', 'PWSH'):
            self.assertRegex(text, rf'ARG {tool}_SHA256=[0-9a-f]{{64}}')
        self.assertEqual(text.count('sha256sum -c'), 5)

    def test_paths_match_hosted_runners(self):
        text = (HERE / 'Dockerfile').read_text()
        for needle in ('--uid 1001', 'HOME=/home/runner', 'CARGO_HOME=/home/runner/.cargo',
                       'RUSTUP_HOME=/home/runner/.rustup', '/home/runner/work', 'USER runner'):
            self.assertIn(needle, text)
        code = '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotRegex(code, r'\bsudo\b')

    def test_image_has_tools_routed_jobs_call_without_setup(self):
        text = (HERE / 'Dockerfile').read_text()
        packages = text.split('apt-get install -y --no-install-recommends')[1].split('&&')[0].split()
        for package in ('bison', 'build-essential', 'git', 'iproute2', 'jq', 'lsof', 'procps', 'python3-pip', 'python3-venv',
                        'rsync', 'shellcheck', 'unzip', 'xz-utils', 'zip', 'zstd'):
            self.assertIn(package, packages)
        for tool in ('GH', 'NODE', 'PWSH'):
            self.assertIn(f'ARG {tool}_VERSION=', text)

    def test_egress_blocks_private_and_tailnet(self):
        text = (HERE / 'egress.sh').read_text()
        for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7'):
            self.assertIn(net, text)
        self.assertIn('-t raw', text)

    def test_unit_drains_on_stop(self):
        text = (HERE / 'github-runner@.service').read_text()
        self.assertIn('KillMode=mixed', text)
        # The container lives in runners.slice, outside the service cgroup, so
        # a stop that times out must remove it explicitly.
        self.assertIn('ExecStopPost=-/usr/bin/docker rm -f gh-runner-%i', text)
        self.assertIn('Restart=always', text)
        self.assertIn('Requires=docker.service\n', text)
        self.assertIn('Wants=github-runners-egress.service', text)
        self.assertNotRegex(text, r'Requires=.*egress', 'a Requires= on the egress unit restarts every slot with it')
        self.assertNotRegex(text, r'After=.*egress', 'ordering after the egress unit makes its jobs wait behind draining slots')
        self.assertIn('ExecReload=', (HERE / 'github-runners-egress.service').read_text())

    def test_slice_sits_at_the_cgroup_root(self):
        # systemd nests a slice named a-b.slice under a.slice, where its low
        # weight would only compete with its siblings, not with system.slice.
        slices = [p.name for p in HERE.glob('*.slice')]
        self.assertEqual(slices, ['runners.slice'])
        self.assertIn('--cgroup-parent runners.slice', (HERE / 'supervisor.sh').read_text())

    def test_cache_outranks_runners(self):
        slice_text = (HERE / 'runners.slice').read_text()
        prio = (HERE / 'cache-priority.conf').read_text()
        weight = lambda text, key: int(re.search(rf'^{key}=(\d+)$', text, re.M)[1])
        for key in ('CPUWeight', 'IOWeight'):
            self.assertGreaterEqual(weight(prio, key), 10 * weight(slice_text, key))

    @staticmethod
    def expand(entry):
        out = []
        for part in entry.split(','):
            a, _, b = part.partition('-')
            out += range(int(a), int(b or a) + 1)
        return out

    def test_default_pools_fit_the_box(self):
        env = dict(line.split('=', 1) for line in (HERE / 'runners.env').read_text().splitlines()
                   if line and not line.startswith('#'))
        cpus, memory = [], 0
        for pool in env['RUNNER_POOLS'].split():
            p = pool.upper()
            sets = env[f'{p}_CPUSETS'].split()[:int(env[f'{p}_SLOTS'])]
            for entry in sets:
                for part in entry.split(','):
                    a, _, b = part.partition('-')
                    cpus += list(range(int(a), int(b or a) + 1))
            memory += int(env[f'{p}_SLOTS']) * int(env[f'{p}_MEMORY'].rstrip('g'))
        self.assertEqual(len(cpus), len(set(cpus)), 'slots must not share CPUs')
        self.assertEqual(sorted(cpus), [c for c in range(24) if c not in (11, 23)],
                         'core 11 (CPUs 11 and 23) stays unpinned for the cache and system')
        heavy = [set(self.expand(e)) for e in env['HEAVY_CPUSETS'].split()]
        for cpu_set in heavy:
            self.assertEqual(cpu_set, {c + 12 for c in cpu_set if c < 12} | {c for c in cpu_set if c < 12},
                             'each heavy slot owns whole cores (CPU n with its sibling n+12)')
        self.assertEqual(memory, 2 * 48 + 6 * 3)
        self.assertLessEqual(memory, 125 - 10, 'leave about 11 GB of the 125 GB for the system and page cache')
        slice_max = int(re.search(r'^MemoryMax=(\d+)G$', (HERE / 'runners.slice').read_text(), re.M)[1])
        self.assertGreaterEqual(slice_max, memory)
        self.assertLess(slice_max, 125)


if __name__ == '__main__':
    unittest.main()
