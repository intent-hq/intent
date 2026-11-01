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
HOSTS = HERE / 'hosts'
INTENT_CI1 = HOSTS / 'intent-ci1.env'
INTENT_CI2 = HOSTS / 'intent-ci2.env'
INTENT_CI3 = HOSTS / 'intent-ci3.env'
INTENT_CI4 = HOSTS / 'intent-ci4.env'
EPYC_3HEAVY = HOSTS / 'epyc-4545p-3heavy.env'
# MemTotal of a 128 GB box (125 GiB after the kernel's share).
MEMINFO_128G = 'MemTotal:       131890000 kB\nMemFree:        1000 kB\n'
# MemTotal of intent-ci3's 64 GB (60 GiB after the kernel's and firmware's share).
MEMINFO_64G = 'MemTotal:       63370000 kB\nMemFree:        1000 kB\n'
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
reply = responses.get(method + ' ' + path) or responses.get(method + ' ' + path.split('?')[0], [404, {'message': 'Not Found'}])
if isinstance(reply, dict):
    # {"seq": [first, second, ...]}: one reply per call, the last repeating.
    counter = os.path.join(os.environ['STUB_DIR'], 'seq-' + (method + path).replace('/', '_'))
    n = int(open(counter).read()) if os.path.exists(counter) else 0
    open(counter, 'w').write(str(n + 1))
    reply = reply['seq'][min(n, len(reply['seq']) - 1)]
status, payload = reply
open(out, 'w').write('' if payload is None else json.dumps(payload))
sys.stdout.write(str(status))
'''

DOCKER_STUB = r'''#!/usr/bin/env python3
import json, os, signal, sys, time
log = os.environ['STUB_LOG']
pidfile = os.environ['STUB_DIR'] + '/run.pid'
CONTAINER_ID = 'c0ffee' * 10
def record(**kw):
    kw.update(cmd='docker', argv=sys.argv[1:])
    with open(log, 'a') as f: f.write(json.dumps(kw) + '\n')
def kill_run():
    try: os.kill(int(open(pidfile).read()), signal.SIGTERM)
    except (OSError, ValueError): pass
sub = sys.argv[1:3]
fail = os.environ.get('STUB_DOCKER_FAIL', '')
if sys.argv[1] == 'run':
    record(jit=os.environ.get('ACTIONS_RUNNER_INPUT_JITCONFIG'))
    open(pidfile, 'w').write(str(os.getpid()))
    def done(*_):
        sys.exit(int(os.environ.get('STUB_RUN_RC', '0')) if not _ else 143)
    signal.signal(signal.SIGTERM, done)
    end = time.time() + float(os.environ.get('STUB_RUN_SECONDS', '0'))
    while time.time() < end:
        time.sleep(0.01)
    done()
record()
if sys.argv[1] == 'stop' or sys.argv[1:3] == ['rm', '-f']:
    kill_run()
if ' '.join(sub) in fail.split(','): sys.exit(1)
if sub == ['container', 'inspect']:
    print(CONTAINER_ID)
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


def fake_cpus(root, cores, sibling_offset):
    """A /sys/devices/system/cpu tree: `cores` cores, CPU n and n+offset siblings."""
    shutil.rmtree(root, ignore_errors=True)
    for core in range(cores):
        for cpu in (core, core + sibling_offset):
            topo = root / f'cpu{cpu}' / 'topology'
            topo.mkdir(parents=True)
            (topo / 'thread_siblings_list').write_text(f'{core},{core + sibling_offset}\n')
    return root


# Heavy slots at or above this carry intent-cache-bigmem (supervisor.sh bigmem_min_kib).
BIGMEM_MIN = 30 * 2 ** 30


def memory_bytes(size):
    """Bytes in a Docker memory size such as 12g, 512m or 1024k (supervisor.sh memory_kib)."""
    return int(size[:-1]) * {'k': 2 ** 10, 'm': 2 ** 20, 'g': 2 ** 30}[size[-1]]


def read_env(path):
    return dict(line.split('=', 1) for line in Path(path).read_text().splitlines()
                if line and not line.startswith('#'))


def expand(entry):
    out = []
    for part in entry.split(','):
        a, _, b = part.partition('-')
        out += range(int(a), int(b or a) + 1)
    return out


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
        # A 128 GB host, so --host-check does not depend on this machine's RAM.
        self.meminfo = self.dir / 'meminfo'
        self.meminfo.write_text(MEMINFO_128G)
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
                        RUNNERS_EGRESS=str(self.egress), RUNNERS_RETRY_DELAY='0', RUNNERS_MEMINFO=str(self.meminfo),
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
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache', 'intent-cache-bigmem', 'intent-host-intent-cache'])
        self.assertEqual(body['runner_group_id'], 3, 'registers into the intent-cache group, never Default')
        self.assertEqual(body['work_folder'], '/home/runner/work')
        self.assertRegex(body['name'], r'^intent-cache-heavy-1-\d+$')
        run = [c for c in self.calls('docker') if c['argv'][0] == 'run'][0]
        self.assertEqual(run['jit'], JIT)
        argv = run['argv']
        self.assertNotIn(JIT, ' '.join(argv))
        for flag in (['--init'], ['--name', 'gh-runner-heavy-1'], ['--network', 'gh-runners'],
                     ['--cpus', '8'], ['--cpuset-cpus', '0-3,12-15'], ['--memory', '36g'], ['--memory-swap', '36g'],
                     ['--pids-limit', '16384'],
                     ['--cgroup-parent', 'runners.slice'], ['--cap-drop', 'ALL'],
                     ['--security-opt', 'no-new-privileges'], ['--env', 'ACTIONS_RUNNER_INPUT_JITCONFIG'],
                     # No core files: the host core_pattern is relative, so a crash
                     # would drop a multi-GB core into the checkout.
                     ['--ulimit', 'core=0:0']):
            self.assertIn(' '.join(flag), ' '.join(argv))
        self.assertEqual(argv[-1], 'intent-gh-runner:current')
        for forbidden in ('-p', '--publish', '--privileged', '-v', '--volume', '--mount', '/var/run/docker.sock'):
            self.assertNotIn(forbidden, argv)
        self.assertNotIn('host', [argv[i + 1] for i, a in enumerate(argv) if a == '--network'])
        # No --rm: the supervisor removes the container itself once the job ends.
        self.assertNotIn('--rm', argv)
        docker = [c['argv'] for c in self.calls('docker')]
        self.assertIn(['rm', '-f', 'gh-runner-heavy-1'], docker[docker.index(run['argv']) + 1:])
        self.assertEqual((self.dir / 'egress.log').read_text(), 'egress check gh-runners0\n')
        self.assert_no_secret(out, err)

    def assert_cleaned_up(self):
        """The container is removed, and no supervisor or container process outlives the test."""
        self.assertIn(['rm', '-f', 'gh-runner-heavy-1'],
                      [c['argv'] for c in self.calls('docker')][[c['argv'][0] for c in self.calls('docker')].index('run'):])
        deadline = time.time() + 15
        while True:
            left = [cmd for cmd in map(self.ours, os.listdir('/proc')) if cmd]
            if not left:
                break
            self.assertLess(time.time(), deadline, f'processes left behind: {left}')
            time.sleep(0.1)

    def ours(self, pid):
        """The command line of a supervisor or container stub this test started, else None."""
        try:
            env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
            cmd = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        except OSError:
            return None
        if f'STUB_DIR={self.dir}'.encode() not in env:
            return None
        return cmd if str(SUPERVISOR).encode() in cmd or str(self.bin / 'docker').encode() in cmd else None

    def test_early_exit_still_removes_the_container(self):
        proc = self.start('heavy-1', STUB_RUN_SECONDS='60')
        self.wait_for_container(proc)
        time.sleep(0.5)
        proc.send_signal(signal.SIGHUP)
        proc.communicate(timeout=30)
        self.assert_cleaned_up()

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

    def test_third_heavy_slot_takes_the_last_four_cores(self):
        rc, out, err = self.run_supervisor('heavy-3')
        self.assertEqual(rc, 0, err)
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache', 'intent-cache-bigmem', 'intent-host-intent-cache'])
        self.assertRegex(body['name'], r'^intent-cache-heavy-3-\d+$')
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][0]['argv'])
        for flag in ('--name gh-runner-heavy-3', '--cpus 8 --cpuset-cpus 8-11,20-23 --memory 36g',
                     '--pids-limit 16384', '--shm-size 1g'):
            self.assertIn(flag, argv)

    def test_single_cpu_pool_slot(self):
        # No committed host has a 1-CPU pool any more (those jobs run on free
        # GitHub-hosted runners), but a config may still define one.
        self.config.write_text('GITHUB_ORG=example-org\nRUNNER_POOLS=small\nSMALL_SLOTS=2\n'
                               'SMALL_LABELS=self-hosted,linux,x64,intent-cache-small\nSMALL_CPUSETS=9 10\n'
                               'SMALL_MEMORY=3g\nSMALL_PIDS=4096\nSMALL_SHM=256m\n')
        rc, out, err = self.run_supervisor('small-2')
        self.assertEqual(rc, 0, err)
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache-small', 'intent-host-intent-cache'])
        self.assertRegex(body['name'], r'^intent-cache-small-2-\d+$')
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][0]['argv'])
        for flag in ('--name gh-runner-small-2', '--cpus 1 ', '--cpuset-cpus 10 ', '--memory 3g',
                     '--pids-limit 4096', '--shm-size 256m'):
            self.assertIn(flag, argv)

    def test_plan_lists_every_slot(self):
        rc, out, err = self.run_supervisor('--plan')
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.split(), ['heavy-1', 'heavy-2', 'heavy-3'])
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
                ('HEAVY_SLOTS=4\n', 'only 3 entries in CPUSETS'),
                ('HEAVY_CPUSETS=0-3,12-15 x 8-11,20-23\n', "bad CPUSETS entry 'x'"),
                ('HEAVY_MEMORY=lots\n', 'MEMORY must look like 40g'),
                ('RUNNER_POOLS=heavy extra\n', 'pool extra: SLOTS must be a number'),
                ('HEAVY_BOGUS=1\n', 'unknown key HEAVY_BOGUS'),
                # The supervisor adds the host label itself; a pool must not claim one.
                ('HEAVY_LABELS=self-hosted,intent-cache,intent-host-intent-ci3\n', 'LABELS must not include a host label'),
                # The default heavy labels include intent-cache-bigmem, so a small slot must drop it.
                ('HEAVY_MEMORY=12g\n', 'pool heavy: intent-cache-bigmem needs MEMORY of at least 30g'),
                ('HEAVY_MEMORY=31457279k\n', 'pool heavy: intent-cache-bigmem needs MEMORY of at least 30g'),
                ('RUNNER_POOLS=xl\nXL_SLOTS=1\nXL_LABELS=self-hosted,intent-cache-bigmem,x\nXL_CPUSETS=0-3\nXL_MEMORY=29g\n',
                 'pool xl: intent-cache-bigmem needs MEMORY of at least 30g')):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, _, err = self.run_supervisor('--plan')
                self.assertNotEqual(rc, 0)
                self.assertIn(message, err)

    def test_plan_accepts_bigmem_at_30g_and_small_slots_without_it(self):
        for config in ('HEAVY_MEMORY=30g\n', 'HEAVY_MEMORY=31457280k\n',
                       'HEAVY_MEMORY=12g\nHEAVY_LABELS=self-hosted,linux,x64,intent-cache\n'):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, out, err = self.run_supervisor('--plan')
                self.assertEqual(rc, 0, err)
                self.assertEqual(out.split(), ['heavy-1', 'heavy-2', 'heavy-3'])

    def test_unconfigured_slot(self):
        for slot in ('heavy-4', 'small-1', 'other-1'):
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
        self.assert_cleaned_up()

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
        self.assert_cleaned_up()

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


    def use_host_config(self, path):
        self.config.write_text(path.read_text().replace('GITHUB_ORG=intent-hq', 'GITHUB_ORG=example-org'))

    def test_committed_layouts_plan(self):
        for path, slots in ((HERE / 'runners.env', ['heavy-1', 'heavy-2', 'heavy-3']),
                            (INTENT_CI1, ['xl-1', 'heavy-1', 'heavy-2']),
                            (INTENT_CI2, ['xl-1', 'heavy-1', 'heavy-2']),
                            (INTENT_CI3, ['heavy-1', 'heavy-2', 'heavy-3', 'heavy-4']),
                            (EPYC_3HEAVY, ['heavy-1', 'heavy-2', 'heavy-3'])):
            with self.subTest(config=path.name):
                rc, out, err = self.run_supervisor('--plan', RUNNERS_CONFIG=str(path))
                self.assertEqual((rc, out.split()), (0, slots), err)
        self.assertEqual(self.calls(), [])

    def test_intent_cache_config_matches_the_defaults(self):
        # The committed intent-cache file and the built-in defaults describe
        # the same slots, so hosts without RUNNER_NAME_PREFIX keep their names.
        env = read_env(HERE / 'runners.env')
        self.assertNotIn('RUNNER_NAME_PREFIX', env)
        self.assertNotIn('RUNNER_FLEET_PREFIX', env)
        text = SUPERVISOR.read_text()
        for key, value in env.items():
            self.assertRegex(text, rf'\n  {key}="?{re.escape(value)}"?\n', key)
        self.assertIn('\n  RUNNER_NAME_PREFIX=intent-cache\n', text)

    def test_xl_pool_slot(self):
        # intent-ci1, intent-ci2 and intent-ci4 share this layout: one xl slot and two 30 GB heavy slots.
        for config, host in ((INTENT_CI1, 'intent-ci1'), (INTENT_CI4, 'intent-ci4')):
            with self.subTest(host=host):
                self.use_host_config(config)
                self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': []}]
                rc, out, err = self.run_supervisor('xl-1')
                self.assertEqual(rc, 0, err)
                body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][-1]['body'])
                self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache-xl', f'intent-host-{host}'])
                self.assertEqual(body['runner_group_id'], 3)
                self.assertRegex(body['name'], rf'^{host}-xl-1-\d+$')
                argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][-1]['argv'])
                for flag in ('--name gh-runner-xl-1', f'--hostname {host}-xl-1', '--cpus 16 --cpuset-cpus 0-7,16-23 --memory 52g',
                             '--memory-swap 52g', '--pids-limit 32768', '--shm-size 2g', '--cap-drop ALL',
                             '--security-opt no-new-privileges', '--network gh-runners', '--label intent.runner.pool=xl'):
                    self.assertIn(flag, argv)
                self.assertNotIn('--privileged', argv)
                for slot, cpuset in (('heavy-1', '8-11,24-27'), ('heavy-2', '12-15,28-31')):
                    rc, out, err = self.run_supervisor(slot)
                    self.assertEqual(rc, 0, err)
                    body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][-1]['body'])
                    self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache', 'intent-cache-bigmem', f'intent-host-{host}'])
                    argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][-1]['argv'])
                    self.assertIn(f'--cpus 8 --cpuset-cpus {cpuset} --memory 30g', argv)

    def test_four_heavy_slots_on_the_64g_host(self):
        config, host = INTENT_CI3, 'intent-ci3'
        self.use_host_config(config)
        self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': []}]
        for n, cpuset in enumerate(('0-3,16-19', '4-7,20-23', '8-11,24-27', '12-15,28-31'), 1):
            with self.subTest(slot=f'heavy-{n}'):
                rc, out, err = self.run_supervisor(f'heavy-{n}')
                self.assertEqual(rc, 0, err)
                body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][-1]['body'])
                self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache', f'intent-host-{host}'])
                self.assertRegex(body['name'], rf'^{host}-heavy-{n}-\d+$')
                argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][-1]['argv'])
                for flag in (f'--hostname {host}-heavy-{n}', f'--cpus 8 --cpuset-cpus {cpuset} --memory 12g',
                             '--memory-swap 12g', '--pids-limit 16384', '--shm-size 1g'):
                    self.assertIn(flag, argv)
        rc, _, err = self.run_supervisor('xl-1')
        self.assertNotEqual(rc, 0, f'{host} has no xl slot')
        self.assertIn('is not a configured slot', err)

    def test_host_label_follows_the_name_prefix(self):
        # Each slot also registers intent-host-<RUNNER_NAME_PREFIX>, so a job
        # (the smoke workflow's host input) can target one host; pool labels
        # stay first and unchanged, so routing by pool label is unaffected.
        for path, prefix in ((HERE / 'runners.env', 'intent-cache'), (INTENT_CI1, 'intent-ci1'),
                             (INTENT_CI2, 'intent-ci2'), (INTENT_CI3, 'intent-ci3'), (INTENT_CI4, 'intent-ci4')):
            with self.subTest(config=path.name):
                self.use_host_config(path)
                self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': []}]
                rc, _, err = self.run_supervisor('heavy-1')
                self.assertEqual(rc, 0, err)
                body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][-1]['body'])
                pool = read_env(path)['HEAVY_LABELS'].split(',')
                self.assertEqual(body['labels'], [*pool, f'intent-host-{prefix}'])
                self.assertNotIn(f'intent-host-{prefix}', pool)

    def test_stale_cleanup_only_takes_this_hosts_slot(self):
        self.use_host_config(INTENT_CI1)
        names = {
            21: 'intent-ci1-heavy-1-100',              # this slot: removed
            22: 'intent-cache-heavy-1-100',            # another host, same slot
            23: 'intent-ci10-heavy-1-100',             # a host whose prefix extends this one
            24: 'intent-ci1-heavy-1-heavy-1-100',      # host intent-ci1-heavy-1, slot heavy-1
            25: 'intent-ci1-heavy-10-100',             # another slot
            26: 'intent-ci1-xl-1-100',                 # another pool
        }
        self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': [
            {'id': i, 'name': n, 'status': 'offline'} for i, n in names.items()]}]
        self.responses['DELETE /orgs/example-org/actions/runners/21'] = [204, None]
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        deletes = [c['path'] for c in self.calls('curl') if c['method'] == 'DELETE']
        self.assertEqual(deletes, ['/orgs/example-org/actions/runners/21', '/orgs/example-org/actions/runners/42'])
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertRegex(body['name'], r'^intent-ci1-heavy-1-\d+$')

    def test_group_check_covers_every_fleet_host(self):
        self.check_fixture(['intent-cache-heavy-1-1', 'intent-cache-small-1-1', 'intent-runner-1-heavy-3-9'])
        self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': [
            {'name': n} for n in ('intent-cache-heavy-1-1', 'intent-cache-small-1-1', 'intent-ci1-xl-1-5',
                                  'intent-runner-1-heavy-3-9', 'depot-x', 'intent-laptop', 'intent-ci1-xl-1')]}]
        for config in ('GITHUB_ORG=example-org\n', 'GITHUB_ORG=example-org\nRUNNER_NAME_PREFIX=intent-ci1\n'):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, out, _ = self.run_supervisor('--group-check')
                self.assertEqual(rc, 1, 'one fleet runner is outside the group')
                report = json.loads(out)
                self.assertEqual((report['slot_runners'], report['in_group'], report['outside_group']),
                                 (4, 3, ['intent-ci1-xl-1-5']))

    def test_prefixes_are_validated(self):
        for config, message in (('RUNNER_NAME_PREFIX=ci1\n', 'must start with RUNNER_FLEET_PREFIX'),
                                ('RUNNER_FLEET_PREFIX=a.b\n', 'RUNNER_FLEET_PREFIX is invalid'),
                                ('RUNNER_NAME_PREFIX=intent_ci1\n', 'RUNNER_NAME_PREFIX is invalid')):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, _, err = self.run_supervisor('--plan')
                self.assertNotEqual(rc, 0)
                self.assertIn(message, err)
        self.config.write_text('RUNNER_FLEET_PREFIX=acme-\nRUNNER_NAME_PREFIX=acme-ci1\n')
        self.assertEqual(self.run_supervisor('--plan')[0], 0)

    def test_host_check(self):
        epyc = fake_cpus(self.dir / 'epyc', 16, 16)
        ryzen = fake_cpus(self.dir / 'ryzen', 12, 12)
        small = fake_cpus(self.dir / 'small', 8, 16)
        for config, sysfs, message in (
                (INTENT_CI1, epyc, None),
                (INTENT_CI2, epyc, None),
                (INTENT_CI3, epyc, None),
                (INTENT_CI4, epyc, None),
                (EPYC_3HEAVY, epyc, None),
                (HERE / 'runners.env', ryzen, None),
                (HERE / 'runners.env', epyc, 'slot heavy-1: CPU 0 shares a core with CPU 16'),
                (INTENT_CI1, ryzen, 'slot xl-1: CPU 0 shares a core with CPU 12'),
                (INTENT_CI2, ryzen, 'slot xl-1: CPU 0 shares a core with CPU 12'),
                (INTENT_CI3, ryzen, 'slot heavy-1: CPU 0 shares a core with CPU 12'),
                (INTENT_CI3, small, 'slot heavy-3: CPU 8 does not exist'),
                (EPYC_3HEAVY, ryzen, 'slot heavy-1: CPU 0 shares a core with CPU 12'),
                (EPYC_3HEAVY, small, 'slot heavy-3: CPU 8 does not exist')):
            with self.subTest(config=config.name, host=sysfs.name):
                rc, _, err = self.run_supervisor('--host-check', RUNNERS_CONFIG=str(config), RUNNERS_SYSFS_CPU=str(sysfs))
                if message is None:
                    self.assertEqual(rc, 0, err)
                else:
                    self.assertNotEqual(rc, 0)
                    self.assertIn(message, err)
        self.config.write_text('HEAVY_SLOTS=4\n')
        rc, _, err = self.run_supervisor('--host-check', RUNNERS_SYSFS_CPU=str(ryzen))
        self.assertNotEqual(rc, 0)
        self.assertIn('only 3 entries in CPUSETS', err)
        self.assertEqual(self.calls(), [])

    def host_check(self, config, sysfs, meminfo):
        self.meminfo.write_text(meminfo)
        return self.run_supervisor('--host-check', RUNNERS_CONFIG=str(config), RUNNERS_SYSFS_CPU=str(sysfs))

    def test_host_check_passes_committed_configs_on_their_hosts(self):
        epyc = fake_cpus(self.dir / 'epyc', 16, 16)
        ryzen = fake_cpus(self.dir / 'ryzen', 12, 12)
        hosts = {HERE / 'runners.env': (ryzen, MEMINFO_128G), INTENT_CI1: (epyc, MEMINFO_128G),
                 INTENT_CI2: (epyc, MEMINFO_128G), INTENT_CI3: (epyc, MEMINFO_64G),
                 INTENT_CI4: (epyc, MEMINFO_128G), EPYC_3HEAVY: (epyc, MEMINFO_128G)}
        self.assertEqual(sorted(hosts), sorted([HERE / 'runners.env', *HOSTS.glob('*.env')]))
        for config, (sysfs, meminfo) in hosts.items():
            with self.subTest(config=config.name):
                rc, _, err = self.host_check(config, sysfs, meminfo)
                self.assertEqual(rc, 0, err)

    def test_host_check_refuses_slots_over_the_memory_cap(self):
        # intent-hq/intent#7865: 4 x 13g was planned for intent-ci3, whose
        # 60 GiB of RAM leaves runners.slice 51 GiB.
        epyc = fake_cpus(self.dir / 'epyc', 16, 16)
        ci3_13g = self.dir / 'ci3-13g.env'
        ci3_13g.write_text(INTENT_CI3.read_text().replace('HEAVY_MEMORY=12g', 'HEAVY_MEMORY=13g'))
        self.assertIn('HEAVY_MEMORY=13g', ci3_13g.read_text())
        for config, meminfo, message in (
                (ci3_13g, MEMINFO_64G, 'slots need 52 GiB in total (heavy 4 x 13g) but runners.slice allows 51 GiB '
                                       'on this host (60 GiB RAM minus 9 GiB reserve); lower HEAVY_MEMORY or HEAVY_SLOTS'),
                (INTENT_CI1, MEMINFO_64G, 'slots need 112 GiB in total (xl 1 x 52g, heavy 2 x 30g) but runners.slice '
                                          'allows 51 GiB on this host (60 GiB RAM minus 9 GiB reserve); '
                                          'lower XL_MEMORY, XL_SLOTS, HEAVY_MEMORY or HEAVY_SLOTS'),
                (EPYC_3HEAVY, MEMINFO_64G, 'slots need 96 GiB in total (heavy 3 x 32g)')):
            with self.subTest(config=config.name):
                rc, _, err = self.host_check(config, epyc, meminfo)
                self.assertNotEqual(rc, 0)
                self.assertIn('runner-slot-host: error: ' + message, err)
        self.assertEqual(self.calls(), [])

    def test_host_check_memory_boundary_and_units(self):
        # Three heavy slots on a 60 GiB host (51 GiB cap): 51 GiB fits, any more does not.
        ryzen = fake_cpus(self.dir / 'ryzen', 12, 12)
        for memory, total in (('17g', None), ('17408m', None), ('17825792k', None),
                              ('17409m', '51.01'), ('18g', '54'), ('17825793k', '51.01')):
            with self.subTest(memory=memory):
                # 17g slots are below the bigmem floor, so they carry only intent-cache.
                self.config.write_text(f'GITHUB_ORG=example-org\nHEAVY_MEMORY={memory}\nHEAVY_LABELS=self-hosted,linux,x64,intent-cache\n')
                rc, _, err = self.host_check(self.config, ryzen, MEMINFO_64G)
                if total is None:
                    self.assertEqual(rc, 0, err)
                else:
                    self.assertNotEqual(rc, 0)
                    self.assertIn(f'slots need {total} GiB in total (heavy 3 x {memory}) but runners.slice allows 51 GiB', err)
        self.config.write_text('GITHUB_ORG=example-org\nRUNNER_POOLS=heavy xl\nXL_SLOTS=0\nXL_LABELS=x\nXL_MEMORY=900g\n')
        rc, _, err = self.host_check(self.config, ryzen, MEMINFO_128G)
        self.assertEqual(rc, 0, 'a pool with no slots needs no memory: ' + err)
        # 2^43 GiB is 2^63 KiB: unbounded digits would wrap the sum negative and pass.
        for memory in ('8796093022208g', '1000000000k'):
            with self.subTest(memory=memory):
                self.config.write_text(f'GITHUB_ORG=example-org\nHEAVY_MEMORY={memory}\n')
                rc, _, err = self.host_check(self.config, ryzen, MEMINFO_128G)
                self.assertNotEqual(rc, 0)
                self.assertIn('MEMORY must look like 40g (at most 9 digits)', err)

    def test_host_check_needs_host_ram(self):
        ryzen = fake_cpus(self.dir / 'ryzen', 12, 12)
        for meminfo, message in (('MemFree: 1 kB\n', 'cannot read MemTotal'), ('MemTotal: 8000000 kB\n', 'host has 7 GiB')):
            with self.subTest(meminfo=meminfo):
                rc, _, err = self.host_check(self.config, ryzen, meminfo)
                self.assertNotEqual(rc, 0)
                self.assertIn(message, err)

    def test_memory_cap(self):
        for meminfo, cap in ((MEMINFO_128G, '116'), (MEMINFO_64G, '51'), ('MemTotal: 263800000 kB\n', '242')):
            with self.subTest(cap=cap):
                self.meminfo.write_text(meminfo)
                rc, out, err = self.run_supervisor('--memory-cap')
                self.assertEqual((rc, out), (0, cap + '\n'), err)
        self.meminfo.write_text('MemFree: 1 kB\n')
        rc, out, err = self.run_supervisor('--memory-cap')
        self.assertNotEqual(rc, 0)
        self.assertIn('cannot read MemTotal', err)


@unittest.skipUnless(HAVE_TOOLS, 'needs bash, jq and openssl')
class Installer(Stubbed):
    def setUp(self):
        super().setUp()
        self.prefix = self.dir / 'root'
        self.prefix.mkdir()
        for name in ('apt-get', 'dpkg', 'chown', 'sysctl'):
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
        self.meminfo = self.dir / 'meminfo'
        self.meminfo.write_text(MEMINFO_128G)
        # The cache box by default: its 12-core CPU and the cache services.
        self.sysfs = fake_cpus(self.dir / 'cpu', 12, 12)
        for unit in ('lib/systemd/system/caddy.service', 'etc/systemd/system/sccache-webdav.service'):
            (self.prefix / unit).parent.mkdir(parents=True, exist_ok=True)
            (self.prefix / unit).write_text('[Service]\n')
        self.env.update(INSTALL_PREFIX=str(self.prefix), OS_RELEASE=str(os_release),
                        INSTALL_OWNER_UID=str(os.getuid()), RUNNERS_OWNER_UID=str(os.getuid()),
                        STUB_RESPONSES=str(responses), MEMINFO=str(self.meminfo),
                        RUNNERS_SYSFS_CPU=str(self.sysfs),
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

    def test_sysctl_drop_in_is_installed_and_loaded_every_run(self):
        # Slots share one host user's inotify instances (userns-remap), so the
        # host limit must cover coverage-all's 4096 plus the other slots.
        conf = self.prefix / 'etc/sysctl.d/90-github-runners.conf'
        loads = []
        for _ in range(2):
            result = self.install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(conf.read_bytes(), (HERE / 'sysctl.conf').read_bytes())
            self.assertEqual(stat.S_IMODE(conf.stat().st_mode), 0o644)
            loads = [c['argv'] for c in self.calls('sysctl')]
        self.assertEqual(loads, [['-q', '--load', str(conf)]] * 2, 'reloaded on every run, even when unchanged')

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
        self.assertIn('\nMemoryMax=116G\n', (units / 'runners.slice.d/memory.conf').read_text(),
                      'intent-cache (125 GiB) keeps its 116G cap')
        daemon = json.loads((self.prefix / 'etc/docker/daemon.json').read_text())
        self.assertEqual(daemon['userns-remap'], 'default')
        self.assertFalse(daemon['icc'])
        self.assertEqual(daemon['dns'], ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
                         'containers resolve through three public resolvers, not the host link DNS')
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
        default = [f'github-runner@heavy-{n}.service' for n in range(1, 4)]
        self.assertEqual(self.enabled(), default)
        self.assertIn(['enable', 'github-runner@heavy-3.service'], self.systemctl())
        rows = [json.loads(line) for line in self.log.read_text().splitlines()]
        put = [i for i, r in enumerate(rows) if r['cmd'] == 'curl' and r['method'] == 'PUT']
        enable = [i for i, r in enumerate(rows) if r['cmd'] == 'systemctl' and r['argv'][0] == 'enable' and 'runner@' in r['argv'][-1]]
        self.assertTrue(put and enable and max(put) < min(enable), 'the group is applied before any slot is enabled')
        self.assertFalse([a for a in self.systemctl() if a[:2] == ['enable', '--now']], 'no blocking starts')

        self.log.write_text('')
        self.env_file.write_text(self.env_file.read_text().replace('HEAVY_SLOTS=3', 'HEAVY_SLOTS=2'))
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), ['github-runner@heavy-1.service', 'github-runner@heavy-2.service'])
        self.assertIn(['disable', '--now', 'github-runner@heavy-3.service'], self.systemctl())
        self.assertFalse(any(c['argv'][0] == 'build' for c in self.calls('docker')))
        self.assertNotIn(['restart', 'docker'], self.systemctl())

        self.env_file.write_text('RUNNER_POOLS=heavy\nHEAVY_SLOTS=0\n')
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), [])

    def test_retiring_the_small_pool_drains_it_and_starts_heavy_3(self):
        # The intent-cache rollout: the host still runs the old 2 heavy + 6
        # small layout; replacing /etc/github-runners/runners.env with the
        # committed file disables every small slot and enables heavy-3, and the
        # cache keeps its CPU and IO weight drop-ins.
        self.place_credential()
        self.env_file.parent.mkdir(parents=True, exist_ok=True)
        self.env_file.write_text(
            'RUNNER_POOLS=heavy small\nHEAVY_SLOTS=2\nHEAVY_CPUSETS=0-3,12-15 4-7,16-19\nHEAVY_MEMORY=48g\n'
            'SMALL_SLOTS=6\nSMALL_LABELS=self-hosted,linux,x64,intent-cache-small\n'
            'SMALL_CPUSETS=8 9 10 20 21 22\nSMALL_MEMORY=3g\n')
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), sorted(['github-runner@heavy-1.service', 'github-runner@heavy-2.service'] +
                                                [f'github-runner@small-{n}.service' for n in range(1, 7)]))

        self.log.write_text('')
        self.env_file.write_bytes((HERE / 'runners.env').read_bytes())
        result = self.install('--no-build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), [f'github-runner@heavy-{n}.service' for n in range(1, 4)])
        for n in range(1, 7):
            self.assertIn(['disable', '--now', f'github-runner@small-{n}.service'], self.systemctl())
        self.assertIn(['enable', 'github-runner@heavy-3.service'], self.systemctl())
        self.assertFalse([a for a in self.systemctl() if a[0] == 'restart' and a[1] != 'docker'],
                         'heavy-1 and heavy-2 keep their running jobs')
        units = self.prefix / 'etc/systemd/system'
        for name in ('caddy.service', 'sccache-webdav.service'):
            self.assertEqual((units / f'{name}.d/runners-priority.conf').read_bytes(), (HERE / 'cache-priority.conf').read_bytes(),
                             'with no reserved core, the cache relies on its CPU and IO weights')

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
        self.assertIn('only 3 entries in CPUSETS', result.stderr)
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

    def test_runner_only_host(self):
        for unit in ('lib/systemd/system/caddy.service', 'etc/systemd/system/sccache-webdav.service'):
            (self.prefix / unit).unlink()
        fake_cpus(self.sysfs, 16, 16)
        self.place_credential()
        result = self.install('--config', str(INTENT_CI1))
        self.assertEqual(result.returncode, 0, result.stderr)
        units = self.prefix / 'etc/systemd/system'
        for name in ('caddy.service', 'sccache-webdav.service'):
            self.assertFalse((units / f'{name}.d').exists(), f'no drop-in for the absent {name}')
            self.assertIn(f'no {name} on this host', result.stdout)
        self.assertEqual(self.env_file.read_bytes(), INTENT_CI1.read_bytes())
        self.assertEqual(self.enabled(), ['github-runner@heavy-1.service', 'github-runner@heavy-2.service',
                                          'github-runner@xl-1.service'])
        self.assertIn('\nMemoryMax=116G\n', (units / 'runners.slice.d/memory.conf').read_text())
        self.assertEqual((units / 'runners.slice').read_bytes(), (HERE / 'runners.slice').read_bytes())
        self.assertTrue(any(a[0] == 'build' for a in [c['argv'] for c in self.calls('docker')]))
        self.assertIn(['-w', '-t', 'raw', '-A', 'GH-RUNNERS-EGRESS', '-d', '100.64.0.0/10', '-j', 'DROP'],
                      [c['argv'] for c in self.calls('iptables')], 'same egress filter as the cache box')
        # --config only seeds: an existing file is kept.
        result = self.install('--no-build', '--config', str(EPYC_3HEAVY))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_file.read_bytes(), INTENT_CI1.read_bytes())
        self.assertIn('keeping existing', result.stdout)
        self.assertEqual(self.enabled(), ['github-runner@heavy-1.service', 'github-runner@heavy-2.service',
                                          'github-runner@xl-1.service'])

    def test_three_heavy_layout_on_an_epyc(self):
        fake_cpus(self.sysfs, 16, 16)
        self.place_credential()
        result = self.install('--no-build', '--config', str(EPYC_3HEAVY))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.enabled(), [f'github-runner@heavy-{n}.service' for n in (1, 2, 3)])

    def test_four_heavy_layout_on_a_64g_epyc(self):
        for unit in ('lib/systemd/system/caddy.service', 'etc/systemd/system/sccache-webdav.service'):
            (self.prefix / unit).unlink()
        self.meminfo.write_text(MEMINFO_64G)
        fake_cpus(self.sysfs, 16, 16)
        self.place_credential()
        result = self.install('--no-build', '--config', str(INTENT_CI3))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_file.read_bytes(), INTENT_CI3.read_bytes())
        self.assertEqual(self.enabled(), [f'github-runner@heavy-{n}.service' for n in (1, 2, 3, 4)])
        self.assertIn('\nMemoryMax=51G\n', (self.prefix / 'etc/systemd/system/runners.slice.d/memory.conf').read_text())

    def test_slice_memory_follows_host_ram(self):
        units = self.prefix / 'etc/systemd/system'
        # One 36g slot fits even the 53G cap, so --host-check passes at every size.
        self.env_file.parent.mkdir(mode=0o700, parents=True)
        self.env_file.write_text('HEAVY_SLOTS=1\n')
        for kb, cap in ((65_800_000, '53G'), (263_800_000, '242G'), (131_890_000, '116G')):
            with self.subTest(kb=kb):
                self.meminfo.write_text(f'MemTotal: {kb} kB\n')
                result = self.install('--no-build')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'\nMemoryMax={cap}\n', (units / 'runners.slice.d/memory.conf').read_text())
        self.assertNotRegex((units / 'runners.slice').read_text(), r'(?m)^MemoryMax=')
        for text, message in (('MemFree: 1 kB\n', 'cannot read MemTotal'), ('MemTotal: 8000000 kB\n', 'host has 7 GiB')):
            with self.subTest(meminfo=text):
                self.meminfo.write_text(text)
                result = self.install('--no-build')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_config_that_does_not_fit_the_cpus_changes_nothing(self):
        self.place_credential()
        self.assertEqual(self.install('--no-build').returncode, 0)
        before = self.enabled()
        self.assertEqual(len(before), 3)
        fake_cpus(self.sysfs, 16, 16)  # the intent-cache layout splits cores on this topology
        self.log.write_text('')
        result = self.install('--no-build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not fit this host's CPUs or memory", result.stderr)
        self.assertEqual(self.enabled(), before)
        self.assertFalse(any(a[0] in ('disable', 'enable') and 'runner@' in a[-1] for a in self.systemctl()))

    def test_config_that_does_not_fit_the_memory_changes_nothing(self):
        for unit in ('lib/systemd/system/caddy.service', 'etc/systemd/system/sccache-webdav.service'):
            (self.prefix / unit).unlink()
        self.meminfo.write_text(MEMINFO_64G)
        fake_cpus(self.sysfs, 16, 16)
        self.place_credential()
        self.assertEqual(self.install('--no-build', '--config', str(INTENT_CI3)).returncode, 0)
        before = self.enabled()
        self.assertEqual(before, [f'github-runner@heavy-{n}.service' for n in (1, 2, 3, 4)])
        # intent-hq/intent#7865: the 4 x 13g layout first planned for intent-ci3.
        self.env_file.write_text(INTENT_CI3.read_text().replace('HEAVY_MEMORY=12g', 'HEAVY_MEMORY=13g'))
        self.log.write_text('')
        result = self.install('--no-build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('slots need 52 GiB in total (heavy 4 x 13g) but runners.slice allows 51 GiB', result.stderr)
        self.assertIn("does not fit this host's CPUs or memory", result.stderr)
        self.assertEqual(self.enabled(), before)
        self.assertFalse(any(a[0] in ('disable', 'enable', 'start', 'stop') and 'runner@' in a[-1] for a in self.systemctl()))
        self.assertIn('\nMemoryMax=51G\n', (self.prefix / 'etc/systemd/system/runners.slice.d/memory.conf').read_text())

    def test_refuses_non_ubuntu_and_bad_args(self):
        other = self.dir / 'debian'
        other.write_text('ID=debian\n')
        result = self.install(OS_RELEASE=str(other))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected Ubuntu, found 'debian'", result.stderr)
        self.assertEqual(self.calls(), [])
        for args in (['--slots', '2'], ['--bogus'], ['--config']):
            with self.subTest(args=args):
                self.assertEqual(self.install(*args).returncode, 2)


class Static(unittest.TestCase):
    def test_sysctl_limits(self):
        values = dict(line.split(' = ') for line in (HERE / 'sysctl.conf').read_text().splitlines()
                      if line and not line.startswith('#'))
        # 4096 per heavy or xl slot (coverage-all, at most 3 per host), with more than half spare.
        self.assertGreaterEqual(int(values['fs.inotify.max_user_instances']), 32768)
        self.assertGreaterEqual(int(values['fs.inotify.max_user_watches']), 1048576)

    def test_smoke_can_launch_chromium(self):
        text = (HERE.parents[1] / '.github/workflows/intent-cache-smoke.yml').read_text()
        self.assertIn("if: github.event_name == 'workflow_dispatch' && inputs.chromium", text)
        self.assertIn('chromium.launch()', text)
        self.assertIn('max_user_instances', text)

    def test_image_has_chromium_libraries(self):
        # Browser jobs (cloudlands-fe component tests) cannot apt-get without sudo.
        dockerfile = (HERE / 'Dockerfile').read_text()
        # Playwright's ubuntu24.04-x64 chromium list (unchanged from 1.58 through 1.63)
        # plus its non-font tools; one missing .so stops Chromium at launch.
        for package in ('libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2',
                        'libcups2t64', 'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0t64', 'libnspr4', 'libnss3',
                        'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6',
                        'libxfixes3', 'libxkbcommon0', 'libxrandr2', 'libfontconfig1', 'libfreetype6', 'xvfb'):
            self.assertRegex(dockerfile, rf'\s{re.escape(package)}(\s|$)', package)

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

    def test_smoke_checks_core_dumps_and_apt_lists(self):
        text = (HERE.parents[1] / '.github/workflows/intent-cache-smoke.yml').read_text()
        self.assertIn('[ "$(ulimit -c)" = 0 ]', text)
        self.assertIn('apt-get install -s', text)

    def test_bigmem_label_marks_exactly_the_heavy_slots_with_30_gib(self):
        # runner-route sends gh-linux-16x overflow only to intent-cache-bigmem slots:
        # one rustc in intentd's check passed 12 GB and was OOM-killed on intent-ci3.
        # One floor: supervisor.sh --plan refuses less, on live hosts as well as here.
        self.assertIn(f'bigmem_min_kib=$(({BIGMEM_MIN // 2 ** 30} * 1048576))', (HERE / 'supervisor.sh').read_text())
        for path in [HERE / 'runners.env', *sorted(HOSTS.glob('*.env'))]:
            env = read_env(path)
            for pool in env['RUNNER_POOLS'].split():
                p = pool.upper()
                with self.subTest(config=path.name, pool=pool):
                    labels = env[f'{p}_LABELS'].split(',')
                    big = pool == 'heavy' and memory_bytes(env[f'{p}_MEMORY']) >= BIGMEM_MIN
                    self.assertEqual('intent-cache-bigmem' in labels, big, f'{env[f"{p}_MEMORY"]} per slot')
                    if big:
                        self.assertEqual(labels[-2:], ['intent-cache', 'intent-cache-bigmem'])

    def smoke_plan(self, *args):
        result = subprocess.run([sys.executable, '-S', '-B', str(HERE / 'smoke_plan.py'), *args],
                                capture_output=True, text=True)
        outputs = dict(line.split('=', 1) for line in result.stdout.splitlines())
        return result.returncode, {k: v if k == 'host' or not v else json.loads(v) for k, v in outputs.items()}, result.stderr

    def test_smoke_default_limits_cover_every_host_config(self):
        # Without a host, each pool's range is exactly the span of every
        # committed config's slots, computed from the files, so it can never
        # go stale; CPU counts are per pool.
        units = {'k': 2 ** 10, 'm': 2 ** 20, 'g': 2 ** 30}
        seen = {}
        for path in [HERE / 'runners.env', *sorted(HOSTS.glob('*.env'))]:
            env = read_env(path)
            for pool in env['RUNNER_POOLS'].split():
                p = pool.upper()
                memory = int(env[f'{p}_MEMORY'][:-1]) * units[env[f'{p}_MEMORY'][-1]]
                for entry in env[f'{p}_CPUSETS'].split()[:int(env[f'{p}_SLOTS'])]:
                    # Keyed by the pool's own label; extra labels (intent-cache-bigmem) may follow it.
                    label = {'heavy': 'intent-cache', 'xl': 'intent-cache-xl'}[pool]
                    self.assertIn(label, env[f'{p}_LABELS'].split(','))
                    seen.setdefault(label, []).append((len(expand(entry)), memory))
        self.assertEqual(set(seen), {'intent-cache', 'intent-cache-xl'})
        rc, out, err = self.smoke_plan('--xl', 'true')
        self.assertEqual(rc, 0, err)
        legs = out['isolation']['include'] + out['isolation_xl']['include']
        self.assertEqual(len(legs), 2)
        for leg in legs:
            with self.subTest(label=leg['label']):
                sizes = seen[leg['label']]
                self.assertEqual({c for c, _ in sizes}, {leg['cpus']})
                self.assertEqual((leg['memory_min'], leg['memory_max']), (min(m for _, m in sizes), max(m for _, m in sizes)))
                self.assertEqual(leg['runs_on'], ['self-hosted', leg['label']], 'any host with a free slot')
        self.assertEqual(out['heavy'], ['self-hosted', 'intent-cache'])
        self.assertEqual(out['readers'], ['1', '2', '3'])
        self.assertEqual(out['host'], '')
        rc, out, err = self.smoke_plan()
        self.assertEqual(rc, 0, err)
        self.assertEqual(out['isolation_xl'], '', 'the xl pool is checked only on request')

    def test_smoke_host_checks_that_hosts_own_config(self):
        # With a host, every leg targets intent-host-<host> (supervisor.sh
        # registers it), one leg per slot, and the limits are that host's exactly.
        gib = 2 ** 30
        expected = {'intent-cache': (3, 36, 0), 'intent-ci1': (2, 30, 1), 'intent-ci2': (2, 30, 1), 'intent-ci3': (4, 12, 0),
                    'intent-ci4': (2, 30, 1)}
        for host, (heavy, heavy_gib, xl) in expected.items():
            with self.subTest(host=host):
                rc, out, err = self.smoke_plan('--host', host)
                self.assertEqual(rc, 0, err)
                self.assertEqual(out['host'], host)
                label = f'intent-host-{host}'
                legs = out['isolation']['include']
                self.assertEqual(len(legs), heavy, 'one isolation leg per heavy slot')
                for leg in legs:
                    self.assertEqual((leg['cpus'], leg['memory_min'], leg['memory_max']), (8, heavy_gib * gib, heavy_gib * gib))
                    self.assertEqual(leg['runs_on'], ['self-hosted', 'intent-cache', label])
                self.assertEqual(out['heavy'], ['self-hosted', 'intent-cache', label])
                self.assertEqual(out['readers'], [str(n) for n in range(1, heavy + 1)], 'every heavy slot busy at once')
                if xl:
                    (leg,) = out['isolation_xl']['include']
                    self.assertEqual((leg['cpus'], leg['memory_min'], leg['memory_max']), (16, 52 * gib, 52 * gib))
                    self.assertEqual(leg['runs_on'], ['self-hosted', 'intent-cache-xl', label])
                else:
                    self.assertEqual(out['isolation_xl'], '')
        # Every committed host is reachable by name; the layout template is not a host.
        names = {read_env(p).get('RUNNER_NAME_PREFIX', 'intent-cache') for p in [HERE / 'runners.env', *HOSTS.glob('*.env')]
                 if p.name == 'runners.env' or p.stem == read_env(p)['RUNNER_NAME_PREFIX']}
        self.assertEqual(names, set(expected))
        for host in ('intent-ci9', read_env(EPYC_3HEAVY)['RUNNER_NAME_PREFIX'], 'intent-ci3; rm -rf /'):
            with self.subTest(host=host):
                rc, out, err = self.smoke_plan('--host', host)
                self.assertNotEqual(rc, 0)
                self.assertIn(f"unknown runner host '{host}'", err)
                self.assertIn('intent-ci3', err)
                self.assertEqual(out, {})

    def smoke_plan_in(self, files, *args):
        # The plan against a scratch config tree: runners.env plus hosts/.
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        (root / 'hosts').mkdir()
        shutil.copy(HERE / 'smoke_plan.py', root)
        shutil.copy(HERE / 'runners.env', root)
        for name, text in files.items():
            (root / 'hosts' / name).write_text(text)
        result = subprocess.run([sys.executable, '-S', '-B', str(root / 'smoke_plan.py'), *args],
                                capture_output=True, text=True)
        outputs = dict(line.split('=', 1) for line in result.stdout.splitlines())
        return result.returncode, {k: v if k == 'host' or not v else json.loads(v) for k, v in outputs.items()}, result.stderr

    def test_smoke_plan_edge_cases(self):
        ci1 = INTENT_CI1.read_text()
        gib = 2 ** 30
        # A layout template is not a host: it neither widens nor breaks the fleet range.
        rc, out, err = self.smoke_plan_in({'intent-ci1.env': ci1, 'template.env': ci1.replace(
            'RUNNER_NAME_PREFIX=intent-ci1', 'RUNNER_NAME_PREFIX=intent-runner-9').replace(
            'HEAVY_MEMORY=30g', 'HEAVY_MEMORY=64g').replace('HEAVY_CPUSETS=8-11,24-27 12-15,28-31', 'HEAVY_CPUSETS=8-11 12-15')})
        self.assertEqual(rc, 0, err)
        (leg,) = out['isolation']['include']
        self.assertEqual((leg['cpus'], leg['memory_min'], leg['memory_max']), (8, 30 * gib, 36 * gib))
        # A drained pool (SLOTS=0) gets no legs instead of an empty matrix.
        rc, out, err = self.smoke_plan_in({'intent-ci1.env': ci1.replace('XL_SLOTS=1', 'XL_SLOTS=0')}, '--host', 'intent-ci1')
        self.assertEqual(rc, 0, err)
        self.assertEqual(out['isolation_xl'], '')
        rc, out, err = self.smoke_plan_in({'intent-ci1.env': ci1.replace('XL_SLOTS=1', 'XL_SLOTS=0'),
                                           'intent-ci2.env': INTENT_CI2.read_text()}, '--xl', 'true')
        self.assertEqual(rc, 0, err)
        self.assertEqual(out['isolation_xl']['include'][0]['memory_min'], 52 * gib, 'other xl hosts still count')
        rc, out, err = self.smoke_plan_in({'intent-ci1.env': ci1.replace('XL_SLOTS=1', 'XL_SLOTS=0')}, '--xl', 'true')
        self.assertNotEqual(rc, 0)
        self.assertIn('no committed host has a xl slot', err)
        rc, out, err = self.smoke_plan_in({'intent-ci1.env': ci1.replace('HEAVY_SLOTS=2', 'HEAVY_SLOTS=0')}, '--host', 'intent-ci1')
        self.assertNotEqual(rc, 0)
        self.assertIn('intent-ci1 has no heavy slot', err)
        # Asking for xl on a host without an xl slot is an error, not a silent skip.
        rc, out, err = self.smoke_plan('--host', 'intent-ci3', '--xl', 'true')
        self.assertNotEqual(rc, 0)
        self.assertIn('intent-ci3 has no xl slot', err)
        rc, out, err = self.smoke_plan('--host', 'intent-ci1', '--xl', 'true')
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(out['isolation_xl']['include']), 1)

    def test_smoke_jobs_follow_the_plan(self):
        text = (HERE.parents[1] / '.github/workflows/intent-cache-smoke.yml').read_text()
        jobs = dict(re.findall(r'\n  ([\w-]+):\n(.*?)(?=\n  [\w-]+:\n|\Z)', '\n' + text.split('\njobs:\n', 1)[1], re.S))
        self.assertEqual(set(jobs), {'plan', 'isolation', 'isolation-xl', 'fresh', 'cache-writer', 'cache-reader'})
        self.assertIn('      host:\n', text.split('\njobs:')[0], 'the dispatch takes an optional host')
        self.assertIn("if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository",
                      jobs['plan'], 'never run pull-request code from forks on the self-hosted box')
        self.assertIn('smoke_plan.py --host "$HOST"', jobs['plan'])
        # No self-hosted job hard-codes its labels: all of them follow the plan,
        # so a host input reaches every one, and every one waits for the plan.
        self.assertNotIn('runs-on: [self-hosted', text)
        self.assertIn('runs-on: ${{ matrix.runs_on }}', jobs['isolation'])
        self.assertIn('matrix: ${{ fromJSON(needs.plan.outputs.isolation) }}', jobs['isolation'])
        self.assertIn('matrix: ${{ fromJSON(needs.plan.outputs.isolation_xl) }}', jobs['isolation-xl'])
        self.assertIn("if: needs.plan.outputs.isolation_xl != ''", jobs['isolation-xl'],
                      'the xl check runs only on request: with no xl runner online it would wait in the queue')
        for job in ('fresh', 'cache-reader'):
            self.assertIn('runs-on: ${{ fromJSON(needs.plan.outputs.heavy) }}', jobs[job])
        self.assertIn('slot: ${{ fromJSON(needs.plan.outputs.readers) }}', jobs['cache-reader'])
        guard = "if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository"
        for name, job in jobs.items():
            with self.subTest(job=name):
                if name in ('plan', 'cache-writer'):
                    # The hosted writer starts at once, without waiting for the plan.
                    self.assertIn(guard, job)
                    self.assertNotIn('needs:', job)
                    self.assertNotIn('SMOKE_HOST:', job)
                else:
                    # Every self-hosted job waits for the plan and knows the host.
                    self.assertRegex(job, r'needs: (plan|\[plan, [\w-]+\])\n')
                    self.assertIn('      SMOKE_HOST: ${{ needs.plan.outputs.host }}\n', job)
        # Each self-hosted job proves it ran on the requested host, comparing
        # the host as a literal prefix of the runner name.
        check = jobs['isolation'].split('run: &host-check |', 1)[1].split('\n      - ', 1)[0]
        self.assertIn('slot="${RUNNER_NAME#"$SMOKE_HOST"-}"', check)
        self.assertNotIn('=~ ^${', check)
        self.assertIn("if: env.SMOKE_HOST != ''\n        run: *host-check", jobs['fresh'])
        self.assertIn("if: env.SMOKE_HOST != ''\n        run: *host-check", jobs['cache-writer'])
        self.assertIn('steps: *cache-build', jobs['cache-reader'])
        self.assertIn('steps: *isolation-steps', jobs['isolation-xl'])
        # A host whose label no online runner carries fails in the plan instead
        # of leaving every job queued.
        self.assertIn('select(.status == "online")', jobs['plan'])
        self.assertIn('LABEL: intent-host-${{ steps.plan.outputs.host }}', jobs['plan'])

    def test_docker_dns_is_public_and_not_filtered(self):
        # Docker's embedded DNS forwards to these instead of the host's single
        # link resolver; the egress filter must not drop them.
        import ipaddress
        servers = json.loads((HERE / 'daemon.json').read_text())['dns']
        self.assertGreaterEqual(len(servers), 3)
        egress = (HERE / 'egress.sh').read_text()
        dropped = [ipaddress.ip_network(n) for n in re.findall(r'\b(\d+\.\d+\.\d+\.\d+/\d+)\b', egress)]
        self.assertTrue(dropped, 'egress.sh lists the IPv4 ranges it drops')
        for server in servers:
            address = ipaddress.ip_address(server)
            self.assertTrue(address.is_global, server)
            self.assertFalse(any(address in net for net in dropped), f'{server} is dropped by the egress filter')

    def test_image_keeps_apt_package_lists(self):
        # Hosted ubuntu-24.04 keeps them; `apt-get install -s` (playwright
        # install-deps --dry-run) fails without them.
        text = (HERE / 'Dockerfile').read_text()
        self.assertNotIn('/var/lib/apt/lists', text)

    def test_image_has_tools_routed_jobs_call_without_setup(self):
        text = (HERE / 'Dockerfile').read_text()
        packages = text.split('apt-get install -y --no-install-recommends')[1].split('&&')[0].split()
        # gcc-mingw-w64-x86-64: intentd's windows-cross-lint (Clippy for
        # x86_64-pc-windows-gnu) needs the target C compiler and cannot apt-get.
        for package in ('bison', 'build-essential', 'gcc-mingw-w64-x86-64', 'git', 'iproute2', 'jq', 'lsof', 'procps',
                        'python3-pip', 'python3-venv', 'rsync', 'shellcheck', 'unzip', 'xz-utils', 'zip', 'zstd'):
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

    expand = staticmethod(expand)

    @staticmethod
    def slice_cap(host_gib):
        reserve = int(re.search(r'^slice_reserve_gib=(\d+)$', SUPERVISOR.read_text(), re.M)[1])
        return host_gib - reserve

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
        # Every CPU is pinned: the cache shares CPUs with the slots and wins
        # contention by cgroup weight (test_cache_outranks_runners), not by a
        # reserved core.
        self.assertEqual(sorted(cpus), list(range(24)), 'intent-cache pins all 24 CPUs to heavy slots')
        self.assertEqual(env['RUNNER_POOLS'], 'heavy', 'no 1-CPU pool: those jobs run on free GitHub-hosted runners')
        self.assertEqual(int(env['HEAVY_SLOTS']), 3)
        heavy = [set(self.expand(e)) for e in env['HEAVY_CPUSETS'].split()]
        for cpu_set in heavy:
            self.assertEqual(cpu_set, {c + 12 for c in cpu_set if c < 12} | {c for c in cpu_set if c < 12},
                             'each heavy slot owns whole cores (CPU n with its sibling n+12)')
        self.assertEqual(memory, 3 * 36)
        self.assertLessEqual(memory, 125 - 10, 'leave about 11 GB of the 125 GB for the system and page cache')
        self.assertEqual(self.slice_cap(125), 116, 'the installer keeps the 116G slice cap on intent-cache')
        self.assertGreaterEqual(self.slice_cap(125), memory)

    def test_host_configs_fit_an_epyc_4545p(self):
        # 16 cores / 32 threads (CPU n and n+16 share a core), 128 GB (125 GiB);
        # intent-ci3 has 64 GB (60 GiB).
        configs = sorted(HOSTS.glob('*.env'))
        # Host RAM in GiB and, for hosts that pin every core, the slots' total memory.
        hosts = {INTENT_CI1: (125, 52 + 2 * 30), INTENT_CI2: (125, 52 + 2 * 30), INTENT_CI3: (60, 4 * 12),
                 INTENT_CI4: (125, 52 + 2 * 30), EPYC_3HEAVY: (125, None)}
        self.assertEqual(configs, sorted(hosts))
        shape = {'xl': (16, 'intent-cache-xl'), 'heavy': (8, 'intent-cache')}
        for path in configs:
            with self.subTest(config=path.name):
                env = read_env(path)
                self.assertRegex(env['RUNNER_NAME_PREFIX'], r'^intent-')
                self.assertEqual(env['RUNNER_GROUP'], 'intent-cache')
                cpus, memory = [], 0
                for pool in env['RUNNER_POOLS'].split():
                    p = pool.upper()
                    cpus_per_slot, label = shape[pool]
                    self.assertIn(env[f'{p}_LABELS'], {f'self-hosted,linux,x64,{label}', f'self-hosted,linux,x64,{label},intent-cache-bigmem'})
                    for entry in env[f'{p}_CPUSETS'].split()[:int(env[f'{p}_SLOTS'])]:
                        cpu_set = set(expand(entry))
                        self.assertEqual(len(cpu_set), cpus_per_slot, entry)
                        self.assertEqual(cpu_set, {c % 16 for c in cpu_set} | {c % 16 + 16 for c in cpu_set},
                                         f'{entry}: whole cores only')
                        self.assertTrue(all(c % 16 < 8 for c in cpu_set) or all(c % 16 >= 8 for c in cpu_set),
                                        f'{entry}: one CCD')
                        cpus += cpu_set
                    memory += int(env[f'{p}_SLOTS']) * int(env[f'{p}_MEMORY'].rstrip('g'))
                self.assertEqual(len(cpus), len(set(cpus)), 'slots must not share CPUs')
                self.assertTrue(all(c < 32 for c in cpus))
                gib, total = hosts[path]
                if total is not None:
                    self.assertEqual(sorted(cpus), list(range(32)), f'{path.stem} pins every core')
                    self.assertEqual(memory, total)
                    self.assertGreaterEqual(gib - memory, 10, 'leave about 10 GB for the system and Docker')
                else:
                    self.assertEqual(set(range(12, 16)) & {c % 16 for c in cpus}, set(), 'cores 12-15 stay unpinned')
                self.assertLessEqual(memory, self.slice_cap(gib))
        ci1 = read_env(INTENT_CI1)
        self.assertEqual((ci1['RUNNER_NAME_PREFIX'], ci1['RUNNER_POOLS'], ci1['XL_SLOTS'], ci1['HEAVY_SLOTS']),
                         ('intent-ci1', 'xl heavy', '1', '2'))
        self.assertEqual(ci1['HEAVY_CPUSETS'].split(), ['8-11,24-27', '12-15,28-31'],
                         'one heavy slot per half of CCD 1, both SMT siblings of each core')
        self.assertEqual(read_env(EPYC_3HEAVY)['HEAVY_SLOTS'], '3')
        ci3 = read_env(INTENT_CI3)
        self.assertEqual((ci3['RUNNER_NAME_PREFIX'], ci3['RUNNER_POOLS'], ci3['HEAVY_SLOTS'], ci3['HEAVY_MEMORY']),
                         ('intent-ci3', 'heavy', '4', '12g'))
        self.assertNotIn('XL_SLOTS', ci3, 'intent-ci3 has no xl slot')

    def test_twin_hosts_match_but_their_name(self):
        # intent-ci2 and intent-ci4 are copies of intent-ci1:
        # same hardware, same slots; only the runner name prefix (and the host
        # name in comments) differs.
        for twin, twin_name in ((INTENT_CI2, 'intent-ci2'), (INTENT_CI4, 'intent-ci4')):
            with self.subTest(twin=twin_name):
                self.assertEqual(read_env(twin)['RUNNER_NAME_PREFIX'], twin_name)
                self.assertEqual(twin.read_text().replace(twin_name, 'intent-ci1'), INTENT_CI1.read_text())
        prefixes = [read_env(path).get('RUNNER_NAME_PREFIX', 'intent-cache')
                    for path in [HERE / 'runners.env', *sorted(HOSTS.glob('*.env'))]]
        self.assertEqual(len(prefixes), len(set(prefixes)), 'every host has its own name prefix')

if __name__ == '__main__':
    unittest.main()
