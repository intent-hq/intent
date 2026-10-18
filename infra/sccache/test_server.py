#!/usr/bin/env python3
"""sccache cache server: Caddy token check in front of rclone WebDAV.

Starts rclone + Caddy on loopback with throwaway tokens and checks the access
matrix. Uses CADDY_BIN / RCLONE_BIN or `caddy` / `rclone` on PATH; the
server tests skip when either is missing. The prune and env-check tests need
only bash and coreutils.
"""
from pathlib import Path
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
CADDYFILE = HERE / 'Caddyfile'
RW = 'rw' + 'a' * 40
RO = 'ro' + 'b' * 40
CADDY = os.environ.get('CADDY_BIN') or shutil.which('caddy')
RCLONE = os.environ.get('RCLONE_BIN') or shutil.which('rclone')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def request(url, method, token=None, body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def caddy_env(site, upstream, home):
    env = {k: v for k, v in os.environ.items() if not k.startswith('SCCACHE_')}
    env.update(SCCACHE_SITE=site, SCCACHE_UPSTREAM=upstream, SCCACHE_RW_TOKEN=RW,
               SCCACHE_RO_TOKEN=RO, CADDY_ADMIN='off', HOME=home,
               XDG_DATA_HOME=home, XDG_CONFIG_HOME=home)
    return env


@unittest.skipUnless(CADDY, 'caddy not installed (set CADDY_BIN)')
class Validate(unittest.TestCase):
    def test_caddyfile_validates_for_tls_site(self):
        with tempfile.TemporaryDirectory() as home:
            env = caddy_env('cache.example.com', '127.0.0.1:8080', home)
            del env['CADDY_ADMIN']
            result = subprocess.run([CADDY, 'validate', '--adapter', 'caddyfile', '--config', str(CADDYFILE)],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(RW, result.stdout + result.stderr)


@unittest.skipUnless(CADDY and RCLONE, 'caddy and rclone not installed (set CADDY_BIN, RCLONE_BIN)')
class AccessMatrix(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.data = root / 'data'
        cls.data.mkdir()
        (root / 'home').mkdir()
        dav, front = free_port(), free_port()
        cls.base = f'http://127.0.0.1:{front}'
        cls.procs = [
            subprocess.Popen([RCLONE, 'serve', 'webdav', str(cls.data), '--addr', f'127.0.0.1:{dav}',
                              '--dir-cache-time', '1s', '--poll-interval', '0', '--config', '/dev/null'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
            subprocess.Popen([CADDY, 'run', '--adapter', 'caddyfile', '--config', str(CADDYFILE)],
                             env=caddy_env(cls.base, f'127.0.0.1:{dav}', str(root / 'home')),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
        ]
        deadline = time.monotonic() + 20
        while True:
            try:
                if request(cls.base + '/', 'PROPFIND', RW, headers={'Depth': '0'})[0] == 207:
                    break
            except OSError:
                pass
            if time.monotonic() > deadline or any(p.poll() is not None for p in cls.procs):
                cls.tearDownClass()
                raise RuntimeError('caddy/rclone did not become ready')
            time.sleep(0.2)
        status, _ = request(cls.base + '/seed', 'MKCOL', RW)
        assert status == 201, status
        status, _ = request(cls.base + '/seed/obj', 'PUT', RW, b'seed-bytes')
        assert status in (201, 204), status

    @classmethod
    def tearDownClass(cls):
        for p in cls.procs:
            p.terminate()
        for p in cls.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        cls.tmp.cleanup()

    def test_read_write_token(self):
        self.assertEqual(request(self.base + '/rw', 'MKCOL', RW)[0], 201)
        self.assertIn(request(self.base + '/rw/a', 'PUT', RW, b'payload')[0], (201, 204))
        self.assertEqual(request(self.base + '/rw/a', 'GET', RW), (200, b'payload'))
        self.assertEqual(request(self.base + '/rw/', 'PROPFIND', RW, headers={'Depth': '1'})[0], 207)
        self.assertEqual((self.data / 'rw' / 'a').read_bytes(), b'payload')

    def test_read_only_token_reads(self):
        self.assertEqual(request(self.base + '/seed/obj', 'GET', RO), (200, b'seed-bytes'))
        self.assertEqual(request(self.base + '/seed/obj', 'HEAD', RO)[0], 200)
        self.assertEqual(request(self.base + '/seed/', 'PROPFIND', RO, headers={'Depth': '1'})[0], 207)
        self.assertLess(request(self.base + '/', 'OPTIONS', RO)[0], 400)

    def test_read_only_token_cannot_write(self):
        for method, path, body in (('PUT', '/seed/ro', b'x'), ('MKCOL', '/ro-dir', None),
                                   ('DELETE', '/seed/obj', None), ('MOVE', '/seed/obj', None),
                                   ('PROPPATCH', '/seed/obj', b'<x/>')):
            with self.subTest(method=method):
                self.assertIn(request(self.base + path, method, RO, body)[0], (401, 403))
        self.assertFalse((self.data / 'seed' / 'ro').exists())
        self.assertFalse((self.data / 'ro-dir').exists())
        self.assertEqual((self.data / 'seed' / 'obj').read_bytes(), b'seed-bytes')

    def test_missing_or_unknown_token_is_401(self):
        for token in (None, '', 'wrong', RW + 'x', RW[:-1], RO.upper()):
            for method in ('GET', 'PROPFIND', 'PUT', 'MKCOL', 'OPTIONS'):
                with self.subTest(token=token, method=method):
                    self.assertEqual(request(self.base + '/seed/obj', method, token, b'x' if method == 'PUT' else None)[0], 401)
        self.assertEqual(request(self.base + '/seed/obj', 'GET', headers={'Authorization': RW})[0], 401)
        self.assertEqual(request(self.base + '/seed/obj', 'GET', headers={'Authorization': f'Basic {RW}'})[0], 401)

    def test_token_is_not_forwarded_upstream(self):
        status, body = request(self.base + '/seed/obj', 'GET', RW)
        self.assertEqual(status, 200)
        self.assertNotIn(RW.encode(), body)


class EnvCheck(unittest.TestCase):
    def run_check(self, **env):
        base = {k: v for k, v in os.environ.items() if not k.startswith('SCCACHE_')}
        base.update(env)
        return subprocess.run(['bash', str(HERE / 'check-caddy-env.sh')], env=base, capture_output=True, text=True)

    def test_accepts_valid(self):
        self.assertEqual(self.run_check(SCCACHE_SITE='cache.example.com', SCCACHE_RW_TOKEN=RW, SCCACHE_RO_TOKEN=RO).returncode, 0)

    def test_rejects_empty_short_or_equal(self):
        for env in ({'SCCACHE_SITE': 'c', 'SCCACHE_RW_TOKEN': RW},
                    {'SCCACHE_SITE': 'c', 'SCCACHE_RW_TOKEN': RW, 'SCCACHE_RO_TOKEN': ''},
                    {'SCCACHE_SITE': 'c', 'SCCACHE_RW_TOKEN': 'short', 'SCCACHE_RO_TOKEN': RO},
                    {'SCCACHE_SITE': 'c', 'SCCACHE_RW_TOKEN': RW + '*', 'SCCACHE_RO_TOKEN': RO},
                    {'SCCACHE_SITE': 'c', 'SCCACHE_RW_TOKEN': RW, 'SCCACHE_RO_TOKEN': RW}):
            with self.subTest(env=env):
                result = self.run_check(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(RW, result.stderr)


FAKE_DF = """#!/usr/bin/env bash
# df stand-in: a FAKE_DF_SIZE-byte filesystem whose only content is the data dir.
dir="${@: -1}"
echo "1B-blocks Used"
echo "$FAKE_DF_SIZE $(du -sB1 "$dir" | cut -f1)"
"""


class Prune(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / 'data'
        self.data.mkdir()
        self.bin = root / 'bin'
        self.bin.mkdir()
        (self.bin / 'df').write_text(FAKE_DF)
        (self.bin / 'df').chmod(0o755)
        self.now = time.time()

    def tearDown(self):
        self.tmp.cleanup()

    def entry(self, rel, read_days_ago, size=4096):
        p = self.data / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b'x' * size)
        os.utime(p, (self.now - read_days_ago * 86400, self.now - 40 * 86400))
        return p

    def used(self):
        return int(subprocess.run(['du', '-sB1', str(self.data)], capture_output=True, text=True).stdout.split()[0])

    def run_prune(self, size=None, **env):
        full = dict(os.environ, SCCACHE_DATA_DIR=str(self.data), **env)
        if size is not None:
            full.update(PATH=f'{self.bin}:{os.environ["PATH"]}', FAKE_DF_SIZE=str(size))
        else:
            full.setdefault('SCCACHE_MAX_USE_PERCENT', '100')
            full.setdefault('SCCACHE_TARGET_USE_PERCENT', '100')
        result = subprocess.run(['bash', str(HERE / 'prune.sh')], env=full, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('entry-', result.stdout + result.stderr)
        return result.stdout

    def fresh_entries(self, n):
        # entry-00 was read longest ago (10 days), entry-<n-1> most recently.
        return [self.entry(f'ab/entry-{i:02d}', 10 - i * 10 / n) for i in range(n)]

    def test_prunes_unread_entries_and_empty_dirs(self):
        files = {'old/entry-a': 30, 'old/entry-b': 22, 'edge/entry-c': 20, 'fresh/entry-d': 0}
        for rel, age in files.items():
            self.entry(rel, age)
        (self.data / 'empty-old').mkdir()
        (self.data / 'empty-new').mkdir()
        for d in ('old', 'empty-old'):
            os.utime(self.data / d, (self.now - 2 * 86400, self.now - 2 * 86400))
        out = self.run_prune(SCCACHE_PRUNE_DAYS='21')
        self.assertIn('age: removed 2 entries', out)
        self.assertEqual(list((self.data / 'old').iterdir()), [])
        self.assertFalse((self.data / 'empty-old').exists())
        self.assertTrue((self.data / 'empty-new').exists())
        self.assertTrue((self.data / 'edge/entry-c').exists())
        self.assertTrue((self.data / 'fresh/entry-d').exists())

    def test_under_threshold_no_size_prune(self):
        files = self.fresh_entries(20)
        out = self.run_prune(size=self.used() * 100 // 65)
        self.assertIn('age: removed 0 entries (0 bytes)', out)
        self.assertIn('nothing to do', out)
        self.assertTrue(all(f.exists() for f in files))

    def test_over_threshold_prunes_oldest_read_to_low_mark(self):
        files = self.fresh_entries(40)
        size = self.used() * 100 // 80
        out = self.run_prune(size=size)
        self.assertRegex(out, r'size: disk use 8[01]% > 70%')
        remaining = [f.exists() for f in files]
        removed = remaining.index(True)
        self.assertGreater(removed, 0)
        self.assertEqual(remaining, [False] * removed + [True] * (len(files) - removed), 'must remove oldest-read first')
        self.assertIn(f'removed {removed} least-recently-read entries ({removed * 4096} bytes)', out)
        self.assertLessEqual(self.used(), size * 60 // 100)
        self.assertGreater(self.used() + 4096, size * 60 // 100, 'must stop at the low mark')

    def test_age_prune_sufficient_no_size_prune(self):
        old = [self.entry(f'cd/entry-old-{i:02d}', 30) for i in range(20)]
        fresh = self.fresh_entries(20)
        out = self.run_prune(size=self.used() * 100 // 80, SCCACHE_PRUNE_DAYS='21')
        self.assertIn('age: removed 20 entries (81920 bytes)', out)
        self.assertIn('nothing to do', out)
        self.assertFalse(any(f.exists() for f in old))
        self.assertTrue(all(f.exists() for f in fresh))

    def test_insufficient_reclaim_empties_cache_and_warns(self):
        files = self.fresh_entries(10)
        used = self.used()
        # Fake df adds 90% of the filesystem as non-cache data, so even an
        # empty cache stays above the cap.
        (self.bin / 'df').write_text(FAKE_DF.replace('$(du -sB1 "$dir" | cut -f1)', '$(( $(du -sB1 "$dir" | cut -f1) + FAKE_DF_SIZE * 9 / 10 ))'))
        full = dict(os.environ, SCCACHE_DATA_DIR=str(self.data), PATH=f'{self.bin}:{os.environ["PATH"]}', FAKE_DF_SIZE=str(used * 20))
        result = subprocess.run(['bash', str(HERE / 'prune.sh')], env=full, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('removed 10 least-recently-read entries', result.stdout)
        self.assertFalse(any(f.exists() for f in files))
        self.assertIn('warning: disk use is still above 70%', result.stderr)
        self.assertNotIn('entry-', result.stdout + result.stderr)

    def test_thresholds_configurable(self):
        files = self.fresh_entries(40)
        size = self.used() * 100 // 80
        out = self.run_prune(size=size, SCCACHE_MAX_USE_PERCENT='90', SCCACHE_TARGET_USE_PERCENT='50')
        self.assertIn('nothing to do', out)
        out = self.run_prune(size=size, SCCACHE_MAX_USE_PERCENT='75', SCCACHE_TARGET_USE_PERCENT='50')
        self.assertIn('> 75%', out)
        self.assertLessEqual(self.used(), size // 2)
        self.assertTrue(files[-1].exists())

    def test_rejects_bad_settings(self):
        for env in ({'SCCACHE_PRUNE_DAYS': '0'}, {'SCCACHE_PRUNE_DAYS': 'abc'}, {'SCCACHE_PRUNE_DAYS': '-3'},
                    {'SCCACHE_MAX_USE_PERCENT': '101'}, {'SCCACHE_MAX_USE_PERCENT': '0'},
                    {'SCCACHE_MAX_USE_PERCENT': '70', 'SCCACHE_TARGET_USE_PERCENT': '80'},
                    {'SCCACHE_TARGET_USE_PERCENT': 'x'}):
            with self.subTest(env=env):
                full = dict(os.environ, SCCACHE_DATA_DIR=str(self.data), **env)
                result = subprocess.run(['bash', str(HERE / 'prune.sh')], env=full, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stdout)


STUB = """#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$STUB_DIR/calls.log"
key="$name"
case "$name" in lsblk) for a in TYPE MOUNTPOINT NAME FSTYPE; do case "$*" in *" $a "*) key="lsblk.$a";; esac; done;; esac
[ -f "$STUB_DIR/$key.out" ] && cat "$STUB_DIR/$key.out"
exit "$(cat "$STUB_DIR/$key.rc" 2>/dev/null || echo 0)"
"""
STUBBED = ('ip', 'ufw', 'tailscale', 'lsblk', 'pvs', 'vgs', 'lvs', 'wipefs', 'pvcreate', 'vgcreate', 'lvcreate',
           'blkid', 'mkfs.ext4', 'mountpoint', 'mount', 'df')


class Bootstrap(unittest.TestCase):
    """Sources bootstrap.sh (which then runs nothing) and calls single functions
    with system commands stubbed; main() is never run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        for name in STUBBED:
            p = self.dir / name
            p.write_text(STUB)
            p.chmod(0o755)
        (self.dir / 'fstab').write_text('')
        (self.dir / 'data').mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def stub(self, key, out=None, rc=None):
        if out is not None:
            (self.dir / f'{key}.out').write_text(out)
        if rc is not None:
            (self.dir / f'{key}.rc').write_text(str(rc))

    def calls(self):
        log = self.dir / 'calls.log'
        return log.read_text().splitlines() if log.exists() else []

    def run_fn(self, script, env=None):
        prelude = (f'source {HERE / "bootstrap.sh"}; fstab={self.dir}/fstab; data_dir={self.dir}/data; '
                   f'os_release={self.dir}/os-release; is_block() {{ [ "$1" != /dev/missing ]; }}; ')
        full_env = {k: v for k, v in os.environ.items() if k != 'SSH_CONNECTION'}
        full_env.update(PATH=f'{self.dir}:{os.environ["PATH"]}', STUB_DIR=str(self.dir), **(env or {}))
        return subprocess.run(['bash', '-c', prelude + script], env=full_env, capture_output=True, text=True)

    def test_sourcing_runs_nothing(self):
        result = self.run_fn('echo sourced')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'sourced\n')
        self.assertEqual(self.calls(), [])

    def test_parse_args(self):
        ok = self.run_fn('parse_args cache.example.com --format-disk /dev/nvme1n1 --format-disk /dev/nvme0n1p4 --no-firewall; '
                         'echo "$domain|${format_disks[*]}|$firewall"')
        self.assertEqual(ok.stdout.strip(), 'cache.example.com|/dev/nvme1n1 /dev/nvme0n1p4|0', ok.stderr)
        for args in ('', '--format-disk', '--format-disk nvme1n1 cache.example.com', 'a b', 'https://x', '--bogus x'):
            with self.subTest(args=args):
                self.assertEqual(self.run_fn(f'parse_args {args}').returncode, 2)

    def test_check_os(self):
        (self.dir / 'os-release').write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
        result = self.run_fn('check_os')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ubuntu 24.04', result.stdout)
        (self.dir / 'os-release').write_text('ID=debian\nVERSION_ID="12"\n')
        result = self.run_fn('check_os')
        self.assertEqual(result.returncode, 1)
        self.assertIn('expected Ubuntu', result.stderr)

    def test_firewall_refuses_without_tailscale(self):
        self.stub('ip', rc=1)
        for fn in ('check_firewall_preconditions', 'configure_firewall'):
            with self.subTest(fn=fn):
                result = self.run_fn(fn)
                self.assertEqual(result.returncode, 1)
                self.assertIn('tailscale0 not found', result.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith('ufw')])
        self.assertEqual(self.run_fn('firewall=0; check_firewall_preconditions').returncode, 0)

    def test_firewall_ssh_only_on_tailscale(self):
        result = self.run_fn('configure_firewall')
        self.assertEqual(result.returncode, 0, result.stderr)
        ufw = [c for c in self.calls() if c.startswith('ufw ')]
        self.assertIn('ufw default deny incoming', ufw)
        self.assertIn('ufw allow 80/tcp', ufw)
        self.assertIn('ufw allow 443/tcp', ufw)
        tailnet = ufw.index('ufw allow in on tailscale0 to any port 22 proto tcp')
        self.assertLess(tailnet, ufw.index('ufw delete allow 22/tcp'))
        self.assertIn('ufw delete allow OpenSSH', ufw)
        allows = [c for c in ufw if c.startswith('ufw allow')]
        self.assertEqual(sorted(allows), sorted(['ufw allow in on tailscale0 to any port 22 proto tcp',
                                                 'ufw allow 80/tcp', 'ufw allow 443/tcp']))
        self.assertEqual(ufw[-1], 'ufw --force enable')

    def test_preflight_passes_without_ssh_connection(self):
        self.stub('tailscale', '100.101.2.3\n')
        result = self.run_fn('check_firewall_preconditions')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('warning', result.stdout)

    def test_preflight_requires_running_tailscale(self):
        for out, rc in (('', 1), ('', 0), ('192.0.2.1\n', 0)):
            with self.subTest(out=out, rc=rc):
                self.stub('tailscale', out, rc)
                result = self.run_fn('check_firewall_preconditions')
                self.assertEqual(result.returncode, 1)
                self.assertIn('no Tailscale IPv4 address', result.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith('ufw')])

    def test_public_ssh_session_warns(self):
        self.stub('tailscale', '100.101.2.3\n')
        public = self.run_fn('check_firewall_preconditions', {'SSH_CONNECTION': '203.0.113.5 5555 172.96.141.217 22'})
        self.assertEqual(public.returncode, 0, public.stderr)
        self.assertIn('not over Tailscale', public.stdout)
        tailnet = self.run_fn('check_firewall_preconditions', {'SSH_CONNECTION': '100.101.2.3 5555 100.64.0.9 22'})
        self.assertNotIn('warning', tailnet.stdout)

    def disk(self, type_='disk', names='nvme1n1\n', mounts='\n', fstype='\n', pv='', vgs_rc=5):
        self.stub('lsblk.TYPE', type_ + '\n')
        self.stub('lsblk.NAME', names)
        self.stub('lsblk.MOUNTPOINT', mounts)
        self.stub('lsblk.FSTYPE', fstype)
        self.stub('pvs', pv, 0 if pv else 5)
        self.stub('vgs', rc=vgs_rc)

    def test_check_disk_refuses_unsafe_devices(self):
        cases = {
            'not a block device': ({}, '/dev/missing'),
            'mounted': ({'mounts': '\n/boot\n', 'names': 'nvme1n1\n'}, '/dev/nvme1n1'),
            'partitions': ({'names': 'nvme1n1\nnvme1n1p1\n'}, '/dev/nvme1n1'),
            "volume group 'ubuntu-vg'": ({'pv': '  ubuntu-vg\n'}, '/dev/nvme1n1'),
            'RAID member': ({'fstype': 'linux_raid_member\n'}, '/dev/nvme1n1'),
            "'rom' device": ({'type_': 'rom'}, '/dev/nvme1n1'),
            'already exists without': ({'vgs_rc': 0}, '/dev/nvme1n1'),
        }
        for message, (kw, dev) in cases.items():
            with self.subTest(message):
                self.disk(**kw)
                result = self.run_fn(f'check_disk {dev}')
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)

    def test_setup_volume_creates_once(self):
        self.disk()
        self.stub('lvs', rc=5)
        self.stub('mountpoint', rc=1)
        result = self.run_fn('format_disks=(/dev/nvme1n1 /dev/nvme0n1p4); setup_volume')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        for expected in ('wipefs -a /dev/nvme1n1', 'pvcreate -y /dev/nvme0n1p4',
                         'vgcreate sccache /dev/nvme1n1 /dev/nvme0n1p4',
                         'lvcreate -y -n cache -l 100%FREE sccache',
                         'mkfs.ext4 -q -L sccache -m 0 /dev/sccache/cache'):
            self.assertIn(expected, calls)
        self.assertTrue(any(c.startswith('mount ') for c in calls))
        fstab = (self.dir / 'fstab').read_text()
        self.assertEqual(fstab, f'/dev/sccache/cache {self.dir}/data ext4 defaults,relatime,nofail 0 2\n')

        (self.dir / 'calls.log').unlink()
        self.disk(pv='  sccache\n', vgs_rc=0)
        self.stub('lvs', rc=0)
        self.stub('blkid', 'ext4\n')
        self.stub('mountpoint', rc=0)
        result = self.run_fn('format_disks=(/dev/nvme1n1 /dev/nvme0n1p4); setup_volume')
        self.assertEqual(result.returncode, 0, result.stderr)
        destructive = [c for c in self.calls() if c.split()[0] in ('wipefs', 'pvcreate', 'vgcreate', 'lvcreate', 'mkfs.ext4', 'mount')]
        self.assertEqual(destructive, [])
        self.assertEqual((self.dir / 'fstab').read_text(), fstab)

    def test_no_format_disk_touches_no_disk(self):
        self.stub('mountpoint', rc=1)
        result = self.run_fn('setup_volume')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('uses the root filesystem', result.stdout)
        self.assertEqual([c.split()[0] for c in self.calls()], ['mountpoint'])


if __name__ == '__main__':
    unittest.main()
