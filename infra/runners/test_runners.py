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
import socket
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
EPYC_3HEAVY = HOSTS / 'epyc-4545p-3heavy.env'
# MemTotal of a 128 GB box (125 GiB after the kernel's share).
MEMINFO_128G = 'MemTotal:       131890000 kB\nMemFree:        1000 kB\n'
PAT = 'github_pat_' + 'p' * 40
JIT = 'jit' + 'j' * 60
APP_TOKEN = 'ghs_' + 'a' * 36
HAVE_TOOLS = all(shutil.which(t) for t in ('bash', 'jq', 'openssl'))

# cgroup v2 memory.stat in the kernel's order (6.8): anon, file, kernel and
# shmem come first, the slab totals much later.
MEMORY_STAT = """anon {anon}
file {file}
kernel {kernel}
kernel_stack 68894720
pagetables 631996416
sec_pagetables 0
percpu 5578992
sock 36864
vmalloc 978944
shmem {shmem}
zswap 0
zswapped 0
file_mapped 2346303488
file_dirty 2346520576
file_writeback 0
swapcached 6778880
anon_thp 41943040
file_thp 0
shmem_thp 0
inactive_anon 24566947840
active_anon 50463858688
inactive_file 21759229952
active_file 28080177152
unevictable 3145728
slab_reclaimable 5324700584
slab_unreclaimable 211739880
slab 5536440464
workingset_refault_anon 49956633
workingset_refault_file 8489198252
workingset_activate_anon 18829540
workingset_activate_file 1677394019
workingset_restore_anon 18471164
workingset_restore_file 966733016
workingset_nodereclaim 158589056
pgscan 29368345210
pgsteal 27248776726
pgscan_kswapd 25748349502
pgscan_direct 3606230337
pgscan_khugepaged 13765371
pgsteal_kswapd 24135846844
pgsteal_direct 3100773642
pgsteal_khugepaged 12156240
pgfault 1511163816303
pgmajfault 391927616
pgrefill 8241445868
pgactivate 1379134356
pgdeactivate 0
pglazyfree 205343966
pglazyfreed 1822673
zswpin 0
zswpout 0
thp_fault_alloc 186042
thp_collapse_alloc 13519
"""

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
import json, os, shutil, signal, sys, time
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
    # A cgroup v2 directory like the systemd driver's, removed when the
    # container exits; cpu.stat grows at STUB_CORES busy cores.
    cg = None
    if os.environ.get('STUB_CGROUP'):
        cg = os.path.join(os.environ['STUB_CGROUP'], 'runners.slice', f'docker-{CONTAINER_ID}.scope')
        os.makedirs(cg)
        # memory.peak is mostly page cache: working memory (anon + shmem +
        # kernel) is 1.5 GiB of the 12 GiB peak.
        for name, text in {'memory.peak': '12884901888\n', 'pids.peak': '812\n',
                           'memory.stat': f'anon {1 << 30}\nfile {11 << 30}\nkernel {256 << 20}\n'
                                          f'kernel_stack 1\npagetables 1\nshmem {256 << 20}\nslab 9\n',
                           'memory.pressure': 'some avg10=12.50 avg60=3.00 avg300=1.00 total=99\n'
                                              'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
                           'memory.events': 'low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n',
                           'io.stat': '259:0 rbytes=1000 wbytes=2000 rios=1 wios=2 dbytes=0 dios=0\n'
                                      '8:0 rbytes=24 wbytes=48 rios=1 wios=1 dbytes=0 dios=0\n'}.items():
            open(os.path.join(cg, name), 'w').write(text)
    def done(*_):
        if cg: shutil.rmtree(cg, ignore_errors=True)
        sys.exit(int(os.environ.get('STUB_RUN_RC', '0')) if not _ else 143)
    signal.signal(signal.SIGTERM, done)
    start, cores = time.time(), float(os.environ.get('STUB_CORES', '0'))
    end = start + float(os.environ.get('STUB_RUN_SECONDS', '0'))
    while time.time() < end:
        if cg:
            tmp = os.path.join(cg, '.cpu.stat')
            open(tmp, 'w').write(f'usage_usec {int((time.time() - start) * cores * 1e6)}\nuser_usec 1\nsystem_usec 1\n')
            os.replace(tmp, os.path.join(cg, 'cpu.stat'))
        time.sleep(0.01)
    done()
record()
if sys.argv[1] == 'stop' or sys.argv[1:3] == ['rm', '-f']:
    kill_run()
if ' '.join(sub) in fail.split(','): sys.exit(1)
if sub == ['container', 'inspect']:
    if '--size' in sys.argv:
        print(os.environ.get('STUB_SIZE_RW', '21474836480'), os.environ.get('STUB_OOM_KILLED', 'false'))
    else:
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


# Sampler overhead budget: under 1% of one CPU at the real 2-second interval.
SAMPLE_INTERVAL_S = 2.0
SAMPLER_CPU_BUDGET = 0.01
SAMPLER_MIN_SAMPLES = 20


def sampler_cpu_share(short, long, interval=SAMPLE_INTERVAL_S, min_samples=SAMPLER_MIN_SAMPLES):
    """Share of one CPU the sampler uses at `interval`, from (cpu_s, samples) of a
    short and a long run of the same loop: the difference cancels start-up."""
    (cpu1, n1), (cpu2, n2) = short, long
    if n2 - n1 < min_samples:
        raise ValueError(f'need at least {min_samples} more samples in the long run, got {n2 - n1}')
    return max(cpu2 - cpu1, 0.0) / (n2 - n1) / interval


def sampler_within_budget(share, budget=SAMPLER_CPU_BUDGET):
    """Strictly under the budget: a share equal to it fails."""
    return share < budget


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
        self.state = self.dir / 'state'
        self.cgroup = self.dir / 'cgroup'
        self.tmp = self.dir / 'tmp'
        self.tmp.mkdir()
        self.env.update(RUNNERS_STATE_DIR=str(self.state), RUNNERS_CGROUP_ROOT=str(self.cgroup),
                        RUNNERS_SAMPLE_INTERVAL='0.1', TMPDIR=str(self.tmp))

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
        # No --rm: the disk is measured after the job, then the container removed.
        self.assertNotIn('--rm', argv)
        docker = [c['argv'][:3] for c in self.calls('docker')]
        after = docker[docker.index(run['argv'][:3]) + 1:]
        self.assertLess(after.index(['container', 'inspect', '--size']), after.index(['rm', '-f', 'gh-runner-heavy-1']))
        self.assertEqual((self.dir / 'egress.log').read_text(), 'egress check gh-runners0\n')
        self.assert_no_secret(out, err)

    def stats_lines(self):
        path = self.state / 'job-stats.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_cleaned_up(self):
        """The container is removed, and no sampler or temporary file outlives the supervisor."""
        self.assertIn(['rm', '-f', 'gh-runner-heavy-1'],
                      [c['argv'] for c in self.calls('docker')][[c['argv'][0] for c in self.calls('docker')].index('run'):])
        deadline = time.time() + 15
        while True:
            left = [cmd for cmd in map(self.ours, os.listdir('/proc')) if cmd]
            if not left:
                break
            self.assertLess(time.time(), deadline, f'processes left behind: {left}')
            time.sleep(0.1)
        self.assertEqual([p for p in self.tmp.iterdir() if p.name.startswith('tmp.')], [], 'mktemp -d left over')

    def ours(self, pid):
        """The command line of a supervisor, sampler or container stub this test started, else None."""
        try:
            env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
            cmd = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        except OSError:
            return None
        if f'STUB_DIR={self.dir}'.encode() not in env:
            return None
        return cmd if str(SUPERVISOR).encode() in cmd or str(self.bin / 'docker').encode() in cmd else None

    def test_job_stats_line(self):
        rc, out, err = self.run_supervisor('heavy-1', STUB_CGROUP=str(self.cgroup), STUB_CORES='4',
                                           STUB_RUN_SECONDS='1.5', STUB_RUN_RC='3')
        self.assertEqual(rc, 0, err)
        [line] = self.stats_lines()
        self.assertEqual(list(line), ['v', 'host', 'pool', 'slot', 'slot_cpus', 'slot_memory_bytes', 'runner_name',
                                      'started_at', 'ended_at', 'wall_s', 'cpu_s', 'cores_avg', 'cores_p50',
                                      'cores_p95', 'cores_max', 'saturation', 'mem_peak_bytes',
                                      'mem_work_peak_bytes', 'mem_file_peak_bytes', 'mem_pressure_some_avg10_max',
                                      'pids_peak', 'disk_bytes', 'io_read_bytes', 'io_write_bytes', 'oom_kills',
                                      'exit_code', 'samples'])
        name = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])['name']
        self.assertEqual({k: line[k] for k in ('v', 'host', 'pool', 'slot', 'slot_cpus', 'slot_memory_bytes',
                                               'runner_name', 'mem_peak_bytes', 'mem_work_peak_bytes',
                                               'mem_file_peak_bytes', 'mem_pressure_some_avg10_max', 'pids_peak',
                                               'disk_bytes', 'io_read_bytes', 'io_write_bytes', 'oom_kills',
                                               'exit_code')},
                         {'v': 1, 'host': socket.gethostname().split('.')[0], 'pool': 'heavy', 'slot': 'heavy-1',
                          'slot_cpus': 8, 'slot_memory_bytes': 36 << 30, 'runner_name': name,
                          'mem_peak_bytes': 12884901888, 'mem_work_peak_bytes': 1536 << 20,
                          'mem_file_peak_bytes': 11 << 30, 'mem_pressure_some_avg10_max': 12.5,
                          'pids_peak': 812, 'disk_bytes': 21474836480,
                          'io_read_bytes': 1024, 'io_write_bytes': 2048, 'oom_kills': 1, 'exit_code': 3})
        for key in ('started_at', 'ended_at'):
            self.assertRegex(line[key], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertLessEqual(line['started_at'], line['ended_at'])
        # wall_s also covers the container's start, which is slow for the stub on a loaded host.
        self.assertGreaterEqual(line['wall_s'], 1.4)
        self.assertLess(line['wall_s'], 30)
        self.assertGreaterEqual(line['samples'], 5)
        self.assertAlmostEqual(line['cpu_s'], 6, delta=1.5)
        self.assertAlmostEqual(line['cores_p50'], 4, delta=1.5)
        self.assertGreaterEqual(line['cores_max'], line['cores_p95'])
        self.assertGreaterEqual(line['cores_p95'], line['cores_p50'])
        # Sampling jitter can push an interval to the cap now and then.
        self.assertLess(line['saturation'], 0.25)
        # cores_avg comes from the unrounded CPU time; cpu_s is rounded to 0.1 s.
        self.assertAlmostEqual(line['cores_avg'], line['cpu_s'] / line['wall_s'], delta=0.005 + 0.05 / line['wall_s'])
        # Also in the journal (the unit's stdout), as the same line.
        self.assertIn('job stats: ' + (self.state / 'job-stats.jsonl').read_text().strip(), out)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE((self.state / 'job-stats.jsonl').stat().st_mode), 0o640)
        self.assert_no_secret(out, err, (self.state / 'job-stats.jsonl').read_text())
        self.assert_cleaned_up()

    def test_job_stats_without_cgroup_or_size(self):
        rc, out, err = self.run_supervisor('heavy-3', STUB_DOCKER_FAIL='container inspect', STUB_OOM_KILLED='true')
        self.assertEqual(rc, 0, err)
        [line] = self.stats_lines()
        self.assertEqual((line['slot'], line['slot_cpus'], line['slot_memory_bytes'], line['samples']),
                         ('heavy-3', 8, 36 << 30, 0))
        for key in ('cpu_s', 'cores_avg', 'cores_p50', 'cores_p95', 'cores_max', 'saturation', 'mem_peak_bytes',
                    'mem_work_peak_bytes', 'mem_file_peak_bytes', 'mem_pressure_some_avg10_max', 'pids_peak', 'disk_bytes', 'io_read_bytes', 'io_write_bytes', 'oom_kills'):
            self.assertIsNone(line[key], key)
        self.assertIn(['rm', '-f', 'gh-runner-heavy-3'], [c['argv'] for c in self.calls('docker')])

    def test_oom_killed_container_counts_even_between_samples(self):
        rc, _, err = self.run_supervisor('heavy-1', STUB_CGROUP=str(self.cgroup), STUB_RUN_SECONDS='0.5',
                                         STUB_OOM_KILLED='true', STUB_RUN_RC='137')
        self.assertEqual(rc, 0, err)
        [line] = self.stats_lines()
        self.assertEqual((line['oom_kills'], line['exit_code']), (1, 137))

    def bash(self, script, *args, **env):
        return subprocess.run(['bash', '-c', f'source "$SUPERVISOR_SH"; {script}', 'test', *args],
                              env={**self.env, 'SUPERVISOR_SH': str(SUPERVISOR), **env},
                              capture_output=True, text=True, timeout=60)

    def test_summary_from_samples(self):
        # t (us) usage (us) mem pids rbytes wbytes oom_kill work file psi: 10
        # intervals of 2 s at 1, 2, ..., 10 busy cores on an 8-CPU slot (8, 9
        # and 10 count as saturated).
        rows = [f'{2_000_000 * i} {sum(range(1, i + 1)) * 2_000_000} {100 + i} {i} {i} {2 * i} 0 {50 + i} {40 + i} {i}'
                for i in range(11)]
        rows[4] = rows[4].replace(' 104 ', ' 900 ')
        rows[6] = rows[6].replace(' 56 ', ' 700 ')
        (self.dir / 'samples').write_text('\n'.join(rows) + '\n')
        r = self.bash('summarize_samples "$1" 8 22.0', str(self.dir / 'samples'))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {
            'cpu_s': 110.0, 'cores_avg': 5.0, 'cores_p50': 5.0, 'cores_p95': 10.0, 'cores_max': 10.0,
            'saturation': 0.3, 'mem_peak_bytes': 900, 'mem_work_peak_bytes': 700, 'mem_file_peak_bytes': 50,
            'mem_pressure_some_avg10_max': 0.1, 'pids_peak': 10, 'io_read_bytes': 10,
            'io_write_bytes': 20, 'oom_kills': 0, 'samples': 10})

    def test_summary_when_page_cache_fills_the_slot(self):
        # A 48 GiB slot that an IO-heavy job fills with page cache: memory.peak
        # sits at the limit, but working memory stays at 2-3 GiB, and reclaim
        # stalls show up in memory.pressure.
        gib, limit = 1 << 30, 48 << 30
        rows = [f'{2_000_000 * i} {2_000_000 * i} {min(limit, (2 + 6 * i) * gib)} 10 0 {i * 7 * gib} 0 '
                f'{(2 + i % 2) * gib} {min(limit - 3 * gib, 6 * i * gib)} {i * 125}' for i in range(10)]
        (self.dir / 'samples').write_text('\n'.join(rows) + '\n')
        r = self.bash('summarize_samples "$1" 8 20.0', str(self.dir / 'samples'))
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads(r.stdout)
        self.assertEqual(m['mem_peak_bytes'], limit)
        self.assertEqual(m['mem_work_peak_bytes'], 3 * gib)
        self.assertEqual(m['mem_file_peak_bytes'], 45 * gib)
        self.assertEqual(m['mem_pressure_some_avg10_max'], 11.25)

    def test_summary_without_memory_stat_or_pressure(self):
        # -1 marks a file the kernel does not have: the field is null, while
        # the other fields are still summarized.
        (self.dir / 'samples').write_text('0 0 5 1 0 0 0 -1 -1 -1\n2000000 2000000 7 1 0 0 0 -1 -1 -1\n')
        r = self.bash('summarize_samples "$1" 8 2.0', str(self.dir / 'samples'))
        self.assertEqual(r.returncode, 0, r.stderr)
        m = json.loads(r.stdout)
        self.assertEqual(m['mem_peak_bytes'], 7)
        for key in ('mem_work_peak_bytes', 'mem_file_peak_bytes', 'mem_pressure_some_avg10_max'):
            self.assertIsNone(m[key], key)

    def test_cores_avg_agrees_with_rounded_cpu_s(self):
        # cores_avg is computed from the unrounded CPU time and rounded once;
        # cpu_s is rounded to 0.1 s, so a reader recomputing cpu_s / wall_s can
        # differ by up to 0.005 + 0.05 / wall_s. Pairs on rounding boundaries,
        # the first being the merge-queue failure (3.79 vs 3.80).
        pairs = [(1.5, 5_684_000), (1.5, 5_649_999), (1.4, 5_350_000), (2.0, 7_949_999),
                 (0.7, 2_750_000), (600.0, 2_399_950_000), (3.3, 26_349_999)]
        strict_misses = 0
        for wall, usage in pairs:
            with self.subTest(wall=wall, usage=usage):
                (self.dir / 'samples').write_text(f'0 0 0 0 0 0 0 0 0 0\n{int(wall * 1e6)} {usage} 0 0 0 0 0 0 0 0\n')
                r = self.bash('summarize_samples "$1" 8 "$2"', str(self.dir / 'samples'), str(wall))
                self.assertEqual(r.returncode, 0, r.stderr)
                m = json.loads(r.stdout)
                # jq rounds halves away from zero (Python's round() goes to even).
                self.assertEqual(m['cpu_s'], (usage + 50_000) // 100_000 / 10)
                self.assertAlmostEqual(m['cores_avg'], usage / 1e6 / wall, delta=0.005 + 1e-9)
                self.assertAlmostEqual(m['cores_avg'], m['cpu_s'] / wall, delta=0.005 + 0.05 / wall + 1e-9)
                strict_misses += abs(m['cores_avg'] - m['cpu_s'] / wall) > 0.01 - 1e-9
        self.assertGreater(strict_misses, 0, 'the pairs must include a case the old 0.01 check rejected')

    def test_sampler_reads_a_cgroup(self):
        cg = self.dir / 'cg'
        cg.mkdir()
        (cg / 'cpu.stat').write_text('usage_usec 5000000\nuser_usec 1\n')
        (cg / 'memory.current').write_text('4096\n')
        (cg / 'pids.current').write_text('7\n')
        (cg / 'io.stat').write_text('8:0 rbytes=5 wbytes=6 rios=1\n8:16 rbytes=1 wbytes=1\n')
        (cg / 'memory.events').write_text('oom 1\noom_kill 2\n')
        r = self.bash('sample_cgroup "$1"', str(cg))
        self.assertEqual(r.returncode, 0, r.stderr)
        fields = r.stdout.split()
        # No memory.stat or memory.pressure: -1, summarized as null.
        self.assertEqual(fields[1:], ['5000000', '4096', '7', '6', '7', '2', '-1', '-1', '-1'])
        self.assertAlmostEqual(int(fields[0]) / 1e6, time.time(), delta=5)
        (cg / 'memory.stat').write_text(MEMORY_STAT.format(anon=3000, file=900000, kernel=200, shmem=40))
        (cg / 'memory.pressure').write_text('some avg10=7.25 avg60=1.00 avg300=0.10 total=5\n'
                                            'full avg10=3.00 avg60=0.50 avg300=0.05 total=2\n')
        fields = self.bash('sample_cgroup "$1"', str(cg)).stdout.split()
        # Working memory is anon + shmem + kernel; avg10 is in hundredths.
        self.assertEqual(fields[1:], ['5000000', '4096', '7', '6', '7', '2', '3240', '900000', '725'])
        (cg / 'cpu.stat').unlink()
        self.assertNotEqual(self.bash('sample_cgroup "$1"', str(cg)).returncode, 0)

    def test_sampler_working_memory_without_the_kernel_field(self):
        # Kernels before 6.1 have no "kernel" total: sum its main parts.
        cg = self.dir / 'cg'
        cg.mkdir()
        (cg / 'cpu.stat').write_text('usage_usec 1\n')
        (cg / 'memory.stat').write_text('anon 1000\nfile 50\nkernel_stack 1\npagetables 2\nsec_pagetables 4\n'
                                        'percpu 8\nsock 999\nvmalloc 16\nshmem 100\nslab_reclaimable 31\n'
                                        'slab_unreclaimable 1\nslab 32\npgfault 7\n')
        fields = self.bash('sample_cgroup "$1"', str(cg)).stdout.split()
        self.assertEqual(fields[7:], [str(1000 + 100 + 1 + 2 + 4 + 8 + 16 + 32), '50', '-1'])

    def test_sampler_ignores_malformed_memory_files(self):
        cg = self.dir / 'cg'
        cg.mkdir()
        (cg / 'cpu.stat').write_text('usage_usec 1\n')
        (cg / 'memory.stat').write_text('anon lots\nfile 5x\n')
        (cg / 'memory.pressure').write_text('some avg10=bogus\n')
        r = self.bash('sample_cgroup "$1"', str(cg))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split()[7:], ['-1', '-1', '-1'])

    def test_sampler_overhead_is_under_one_percent_of_a_cpu(self):
        cg = self.sampler_cgroup()
        short, long = self.run_sampler(cg, 20), self.run_sampler(cg, 120)
        share = sampler_cpu_share(short, long)
        self.assertTrue(sampler_within_budget(share),
                        f'{share:.2%} of a CPU ({short} -> {long}: cpu_s, samples)')

    def sampler_cgroup(self):
        cg = self.cgroup / 'runners.slice' / ('docker-' + 'c0ffee' * 10 + '.scope')
        cg.mkdir(parents=True, exist_ok=True)
        for name, text in {'cpu.stat': 'usage_usec 1\n', 'memory.peak': '1\n', 'pids.peak': '1\n',
                           'io.stat': '8:0 rbytes=1 wbytes=1\n', 'memory.events': 'oom_kill 0\n',
                           'memory.stat': MEMORY_STAT.format(anon=1, file=1, kernel=1, shmem=1),
                           'memory.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
                                              'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'}.items():
            (cg / name).write_text(text)
        return cg

    def run_sampler(self, cg, samples, deadline_s=120):
        """(cpu_s, samples) of sample_job sampling until the file holds `samples`
        lines, then ending the job: the count, not wall time, sets the run's
        length, so host load cannot shrink it. The job and Bash are always
        ended and reaped, even when an assertion or timeout cuts the run short."""
        out, pidfile = self.dir / f'samples-{samples}', self.dir / f'job-{samples}.pid'
        # find_cgroup runs once per job (a docker call until the cgroup
        # exists); stub it so only the steady sampling loop is measured.
        script = ('cgdir="$2"; find_cgroup() { echo "$cgdir"; }; '
                  'sleep 600 & echo $! > "$3"; sample_job gh-runner-heavy-1 $! "$1"')
        before = os.times()
        proc = subprocess.Popen(['bash', '-c', f'source "$SUPERVISOR_SH"; {script}', 'test',
                                 str(out), str(cg), str(pidfile)],
                                env={**self.env, 'SUPERVISOR_SH': str(SUPERVISOR), 'RUNNERS_SAMPLE_INTERVAL': '0.05'},
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.sampler_pids = [proc.pid]
        try:
            deadline = time.time() + deadline_s
            while not out.exists() or len(out.read_text().splitlines()) < samples:
                if proc.poll() is not None:
                    self.fail(f'sampler stopped early: {proc.communicate()}')
                self.assertLess(time.time(), deadline, 'sampler too slow')
                time.sleep(0.02)
        finally:
            job = int(pidfile.read_text()) if pidfile.exists() and pidfile.read_text().strip() else None
            if job:
                self.sampler_pids.append(job)
                try:
                    os.kill(job, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                _, err = proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                _, err = proc.communicate()
        after = os.times()
        self.assertEqual(proc.returncode, 0, err)
        cpu = (after.children_user - before.children_user) + (after.children_system - before.children_system)
        return cpu, len(out.read_text().splitlines())

    def test_sampler_run_cleans_up_when_cut_short(self):
        # The deadline cuts the run short well after Bash has started the job.
        with self.assertRaises(AssertionError):
            self.run_sampler(self.sampler_cgroup(), 10_000, deadline_s=5)
        pidfile = self.dir / 'job-10000.pid'
        self.assertTrue(pidfile.exists(), 'the job was started')
        pids = [self.sampler_pids[0], int(pidfile.read_text())]
        self.addCleanup(lambda: [os.kill(pid, signal.SIGKILL) for pid in pids if self.running(pid)])
        deadline = time.time() + 10
        while any(map(self.running, pids)):
            self.assertLess(time.time(), deadline, f'left running: {[p for p in pids if self.running(p)]}')
            time.sleep(0.1)

    @staticmethod
    def running(pid):
        try:
            return Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
        except (OSError, IndexError):
            return False

    def test_sampler_cpu_share_boundaries(self):
        # 100 extra samples costing 2 s of CPU: 20 ms each, 1% of a CPU at 2 s.
        self.assertAlmostEqual(sampler_cpu_share((0.1, 20), (2.1, 120)), 0.01)
        # The real test's check: strictly under, so exactly at the budget fails.
        self.assertFalse(sampler_within_budget(SAMPLER_CPU_BUDGET))
        self.assertTrue(sampler_within_budget(SAMPLER_CPU_BUDGET - 1e-9))
        self.assertTrue(sampler_within_budget(sampler_cpu_share((0.1, 20), (2.0, 120))))
        # Start-up cancels; a long run that measured less CPU clamps to zero.
        self.assertEqual(sampler_cpu_share((0.5, 20), (0.4, 120)), 0.0)
        # The minimum sample difference is inclusive.
        self.assertEqual(sampler_cpu_share((0, 0), (0, SAMPLER_MIN_SAMPLES)), 0.0)
        with self.assertRaises(ValueError):
            sampler_cpu_share((0, 0), (0, SAMPLER_MIN_SAMPLES - 1))

    def test_job_stats_rotation(self):
        script = 'for i in $(seq 1 12); do append_job_stats "{\\"v\\":1,\\"ended_at\\":\\"2026-10-21T14:$(printf %02d "$i"):00Z\\",\\"n\\":$i}"; done'
        r = self.bash(script, RUNNERS_JOB_STATS_MAX_BYTES='100', RUNNERS_JOB_STATS_KEEP='2')
        self.assertEqual(r.returncode, 0, r.stderr)
        files = sorted(p.name for p in self.state.iterdir() if p.name.startswith('job-stats.jsonl'))
        self.assertEqual(files, ['job-stats.jsonl', 'job-stats.jsonl.1', 'job-stats.jsonl.2'])
        for name in files:
            self.assertLessEqual((self.state / name).stat().st_size, 100 + 60)
            self.assertEqual(stat.S_IMODE((self.state / name).stat().st_mode), 0o640)
        (self.state / 'job-stats.jsonl').write_text((self.state / 'job-stats.jsonl').read_text() + 'not json\n')
        rc, out, err = self.run_supervisor('--job-stats')
        self.assertEqual(rc, 0, err)
        kept = [json.loads(line)['n'] for line in out.splitlines()]
        self.assertEqual(kept, list(range(kept[0], 13)), 'oldest first, newest last, garbage skipped')
        self.assertLess(kept[0], 10)
        rc, out, err = self.run_supervisor('--job-stats', '--since', '2026-10-21T16:11:00+02:00')
        self.assertEqual(rc, 0, err)
        self.assertEqual([json.loads(line)['n'] for line in out.splitlines()], [11, 12])
        rc, _, err = self.run_supervisor('--job-stats', '--since', 'not a date')
        self.assertNotEqual(rc, 0)
        self.assertIn('--since', err)

    def test_job_stats_survive_a_failed_deregistration(self):
        # The final token refresh (for the deregistration) fails during a GitHub
        # outage: the finished job's stats must already be on disk.
        key = self.dir / 'app.pem'
        subprocess.run(['openssl', 'genrsa', '-out', str(key), '2048'], check=True, capture_output=True)
        self.creds.write_text(f'GITHUB_APP_ID=12345\nGITHUB_APP_INSTALLATION_ID=678\nGITHUB_APP_PRIVATE_KEY_FILE={key}\n')
        self.responses['POST /app/installations/678/access_tokens'] = {'seq': [[201, {'token': APP_TOKEN}], [503, {}]]}
        rc, out, err = self.run_supervisor('heavy-1', STUB_CGROUP=str(self.cgroup), STUB_RUN_SECONDS='0.5')
        self.assertNotEqual(rc, 0)
        self.assertIn('HTTP 503', err)
        self.assertEqual(len(self.stats_lines()), 1)
        self.assert_no_secret(out, err, (self.state / 'job-stats.jsonl').read_text())
        self.assert_cleaned_up()

    def test_job_stats_reader_sees_a_rotation_it_waited_for(self):
        self.state.mkdir(mode=0o750)
        current = self.state / 'job-stats.jsonl'
        current.write_text('{"v":1,"ended_at":"2026-10-21T14:01:00Z","n":1}\n')
        lock = open(self.state / 'job-stats.lock', 'w')
        self.addCleanup(lock.close)
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX)
        reader = self.start('--job-stats')
        time.sleep(1.0)
        # A writer rotates while the reader waits for the lock.
        current.rename(self.state / 'job-stats.jsonl.1')
        current.write_text('{"v":1,"ended_at":"2026-10-21T14:02:00Z","n":2}\n')
        fcntl.flock(lock, fcntl.LOCK_UN)
        out, err = reader.communicate(timeout=30)
        self.assertEqual(reader.returncode, 0, err)
        self.assertEqual([json.loads(line)['n'] for line in out.splitlines()], [1, 2])

    def test_job_stats_with_no_file(self):
        rc, out, err = self.run_supervisor('--job-stats')
        self.assertEqual((rc, out), (0, ''), err)

    def test_early_exit_still_removes_the_container(self):
        proc = self.start('heavy-1', STUB_RUN_SECONDS='60', STUB_CGROUP=str(self.cgroup))
        self.wait_for_container(proc)
        time.sleep(0.5)
        proc.send_signal(signal.SIGHUP)
        proc.communicate(timeout=30)
        self.assert_cleaned_up()
        self.assertEqual(self.stats_lines(), [])

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
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache'])
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
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache-small'])
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
                ('HEAVY_BOGUS=1\n', 'unknown key HEAVY_BOGUS')):
            with self.subTest(config=config):
                self.config.write_text(config)
                rc, _, err = self.run_supervisor('--plan')
                self.assertNotEqual(rc, 0)
                self.assertIn(message, err)

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
        self.assertEqual(self.stats_lines(), [], 'an idle runner ran no job')
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
        self.assertEqual(len(self.stats_lines()), 1, 'the drained job is recorded')
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
        self.use_host_config(INTENT_CI1)
        self.responses['GET /orgs/example-org/actions/runners'] = [200, {'runners': []}]
        rc, out, err = self.run_supervisor('xl-1')
        self.assertEqual(rc, 0, err)
        body = json.loads([c for c in self.calls('curl') if c['method'] == 'POST'][0]['body'])
        self.assertEqual(body['labels'], ['self-hosted', 'linux', 'x64', 'intent-cache-xl'])
        self.assertEqual(body['runner_group_id'], 3)
        self.assertRegex(body['name'], r'^intent-ci1-xl-1-\d+$')
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][0]['argv'])
        for flag in ('--name gh-runner-xl-1', '--hostname intent-ci1-xl-1', '--cpus 16 --cpuset-cpus 0-7,16-23 --memory 52g',
                     '--memory-swap 52g', '--pids-limit 32768', '--shm-size 2g', '--cap-drop ALL',
                     '--security-opt no-new-privileges', '--network gh-runners', '--label intent.runner.pool=xl'):
            self.assertIn(flag, argv)
        self.assertNotIn('--privileged', argv)
        rc, out, err = self.run_supervisor('heavy-1')
        self.assertEqual(rc, 0, err)
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][-1]['argv'])
        self.assertIn('--cpus 8 --cpuset-cpus 8-11,24-27 --memory 30g', argv)
        rc, out, err = self.run_supervisor('heavy-2')
        self.assertEqual(rc, 0, err)
        argv = ' '.join([c for c in self.calls('docker') if c['argv'][0] == 'run'][-1]['argv'])
        self.assertIn('--cpus 8 --cpuset-cpus 12-15,28-31 --memory 30g', argv)

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
                (EPYC_3HEAVY, epyc, None),
                (HERE / 'runners.env', ryzen, None),
                (HERE / 'runners.env', epyc, 'slot heavy-1: CPU 0 shares a core with CPU 16'),
                (INTENT_CI1, ryzen, 'slot xl-1: CPU 0 shares a core with CPU 12'),
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

    def test_slice_memory_follows_host_ram(self):
        units = self.prefix / 'etc/systemd/system'
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
        self.assertIn("does not fit this host's CPUs", result.stderr)
        self.assertEqual(self.enabled(), before)
        self.assertFalse(any(a[0] in ('disable', 'enable') and 'runner@' in a[-1] for a in self.systemctl()))

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

    def test_smoke_limits_cover_every_host_config(self):
        text = (HERE.parents[1] / '.github/workflows/intent-cache-smoke.yml').read_text()
        rows = re.findall(r'- \{label: ([\w-]+), cpus: (\d+), memory_min: (\d+), memory_max: (\d+)\}', text)
        smoke = {label: (int(c), int(lo), int(hi)) for label, c, lo, hi in rows}
        self.assertEqual(set(smoke), {'intent-cache', 'intent-cache-xl'})
        units = {'k': 2 ** 10, 'm': 2 ** 20, 'g': 2 ** 30}
        for path in [HERE / 'runners.env', *sorted(HOSTS.glob('*.env'))]:
            env = read_env(path)
            for pool in env['RUNNER_POOLS'].split():
                p = pool.upper()
                with self.subTest(config=path.name, pool=pool):
                    label = env[f'{p}_LABELS'].split(',')[-1]
                    cpus, lo, hi = smoke[label]
                    memory = int(env[f'{p}_MEMORY'][:-1]) * units[env[f'{p}_MEMORY'][-1]]
                    self.assertTrue(lo <= memory <= hi, f'{label}: {memory} outside {lo}..{hi}')
                    for entry in env[f'{p}_CPUSETS'].split()[:int(env[f'{p}_SLOTS'])]:
                        self.assertEqual(len(expand(entry)), cpus)
        xl = text.split('  isolation-xl:')[1].split('\n  fresh:')[0]
        self.assertIn("if: github.event_name == 'workflow_dispatch' && inputs.xl", xl,
                      'the xl check runs only on request: with no xl runner online it would wait in the queue')

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

    expand = staticmethod(expand)

    @staticmethod
    def slice_cap(host_gib):
        reserve = int(re.search(r'^slice_reserve_gib=(\d+)$', INSTALL.read_text(), re.M)[1])
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
        # 16 cores / 32 threads (CPU n and n+16 share a core), 128 GB (125 GiB).
        configs = sorted(HOSTS.glob('*.env'))
        self.assertEqual(configs, sorted([INTENT_CI1, EPYC_3HEAVY]))
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
                    self.assertEqual(env[f'{p}_LABELS'], f'self-hosted,linux,x64,{label}')
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
                if path == INTENT_CI1:
                    self.assertEqual(sorted(cpus), list(range(32)), 'intent-ci1 pins every core')
                    self.assertEqual(memory, 52 + 2 * 30)
                    self.assertGreaterEqual(125 - memory, 10, 'leave about 10 GB for the system and Docker')
                else:
                    self.assertEqual(set(range(12, 16)) & {c % 16 for c in cpus}, set(), 'cores 12-15 stay unpinned')
                self.assertLessEqual(memory, self.slice_cap(125))
        ci1 = read_env(INTENT_CI1)
        self.assertEqual((ci1['RUNNER_NAME_PREFIX'], ci1['RUNNER_POOLS'], ci1['XL_SLOTS'], ci1['HEAVY_SLOTS']),
                         ('intent-ci1', 'xl heavy', '1', '2'))
        self.assertEqual(ci1['HEAVY_CPUSETS'].split(), ['8-11,24-27', '12-15,28-31'],
                         'one heavy slot per half of CCD 1, both SMT siblings of each core')
        self.assertEqual(read_env(EPYC_3HEAVY)['HEAVY_SLOTS'], '3')


if __name__ == '__main__':
    unittest.main()
