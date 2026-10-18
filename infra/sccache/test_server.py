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


class Prune(unittest.TestCase):
    def test_prunes_unread_entries_and_empty_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            now = time.time()
            day = 86400
            files = {'old/a': 30, 'old/b': 22, 'edge/c': 20, 'fresh/d': 0}
            for rel, age in files.items():
                p = data / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b'x')
                os.utime(p, (now - age * day, now - 40 * day))
            (data / 'empty-old').mkdir()
            (data / 'empty-new').mkdir()
            for d in ('old', 'empty-old'):
                os.utime(data / d, (now - 2 * day, now - 2 * day))
            env = dict(os.environ, SCCACHE_DATA_DIR=tmp, SCCACHE_PRUNE_DAYS='21', SCCACHE_MAX_USE_PERCENT='100')
            result = subprocess.run(['bash', str(HERE / 'prune.sh')], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('removed 2 entries', result.stdout)
            self.assertEqual(list((data / 'old').iterdir()), [])
            self.assertFalse((data / 'empty-old').exists())
            self.assertTrue((data / 'empty-new').exists())
            self.assertTrue((data / 'edge/c').exists())
            self.assertTrue((data / 'fresh/d').exists())

    def test_rejects_bad_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            for days in ('0', 'abc', '-3'):
                with self.subTest(days=days):
                    env = dict(os.environ, SCCACHE_DATA_DIR=tmp, SCCACHE_PRUNE_DAYS=days)
                    result = subprocess.run(['bash', str(HERE / 'prune.sh')], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
