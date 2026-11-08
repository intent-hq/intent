#!/usr/bin/env python3
"""Exercise self-hosted cache selection and checksum verification without networking."""
import contextlib
import http.client
import importlib.util
import io
import re
from pathlib import Path
import ssl
import tempfile
import time
import unittest
import unittest.mock
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cache', ROOT / 'scripts/setup-sccache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)

# Values a runner image or a previous configuration may already carry.
INHERITED = {'SCCACHE_WEBDAV_ENDPOINT': 'https://inherited.example', 'SCCACHE_WEBDAV_TOKEN': 'inherited-secret',
             'SCCACHE_WEBDAV_KEY_PREFIX': 'inherited/prefix', 'SCCACHE_WEBDAV_USERNAME': 'inherited'}
SELF_HOSTED = {'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com', 'INTENT_SCCACHE_TOKEN': 'intent-secret'}


class Install(unittest.TestCase):
    def test_unset_switch_does_not_configure_wrapper(self):
        for env in ({}, INHERITED, {'INTENT_SCCACHE_TOKEN': 'intent-secret'}, {**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': ' '}):
            self.assertEqual(cache.select(env), ('uncached', None, {}))

    def test_corrupt_download_is_not_installed(self):
        def download(url, dest):
            Path(dest).write_bytes(b'corrupt archive')
        with tempfile.TemporaryDirectory() as temp, patch.object(cache, 'fetch', download):
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                cache.install(Path(temp))
            self.assertFalse((Path(temp)/'sccache').exists())

    def test_archive_uses_job_volume_instead_of_system_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'job-cache'
            def download(url, dest):
                self.assertTrue(Path(dest).is_relative_to(directory.parent))
                Path(dest).write_bytes(b'corrupt archive')
            with patch.object(cache, 'fetch', download):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    cache.install(directory)

    def test_long_compilation_does_not_expire_server(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {'RUNNER_TEMP': temp, 'GITHUB_PATH': temp + '/path',
                   'GITHUB_ENV': temp + '/env', **SELF_HOSTED}
            fake_sccache(temp, (0,))
            with patch.dict(cache.os.environ, env, clear=True), patch.object(cache, 'install', return_value=Path(temp)):
                cache.main()
            values = dict(line.split('=', 1) for line in Path(env['GITHUB_ENV']).read_text().splitlines())
            # sccache's idle clock counts requests, not active compiler time.
            self.assertEqual(values['SCCACHE_IDLE_TIMEOUT'], '0')
            self.assertGreater(int(values['SCCACHE_SERVER_PORT']), 0)

    def test_no_rust_cache_actions(self):
        for path in (ROOT/'.github').rglob('*.yml'):
            self.assertNotIn('Swatinem/rust-cache', path.read_text(), str(path))
            self.assertNotIn('mozilla-actions/sccache-action', path.read_text(), str(path))


def http_error(code):
    return cache.urllib.error.HTTPError('https://github.com/x', code, 'error', {}, None)


class Response(io.BytesIO):
    """A urlopen() response; `fail` raises after the body is read (a dropped stream)."""
    def __init__(self, body, fail=None):
        super().__init__(body)
        self.fail = fail

    def info(self):
        return {}

    def read(self, *args):
        data = super().read(*args)
        if not data and self.fail is not None:
            raise self.fail
        return data


class Download(unittest.TestCase):
    """Bounded retry around the release download (intent-hq/intent#8613)."""

    def run_download(self, failures, delays=(1, 2, 3)):
        calls, sleeps = [], []
        def fetch(url, dest):
            calls.append(url)
            if failures:
                raise failures.pop(0)
            Path(dest).write_bytes(b'ok')
        with tempfile.TemporaryDirectory() as temp, patch.object(cache, 'fetch', fetch), \
                contextlib.redirect_stderr(io.StringIO()):
            dest = Path(temp) / 'archive'
            try:
                cache.download('https://github.com/x', dest, delays=delays, sleep=sleeps.append)
                return calls, sleeps, dest.read_bytes(), None
            except Exception as error:
                return calls, sleeps, None, error

    def test_gateway_timeout_is_retried(self):
        calls, sleeps, data, error = self.run_download([http_error(504), http_error(502)])
        self.assertIsNone(error)
        self.assertEqual((len(calls), sleeps, data), (3, [1, 2], b'ok'))

    def test_network_errors_and_timeouts_are_retried(self):
        failures = [cache.urllib.error.URLError('reset'), TimeoutError('timed out'), ConnectionResetError(),
                    ssl.SSLError('bad record mac'), http.client.IncompleteRead(b'')]
        calls, sleeps, data, error = self.run_download(failures, delays=(1,) * 5)
        self.assertIsNone(error)
        self.assertEqual((len(calls), data), (6, b'ok'))

    def test_client_errors_fail_without_retry(self):
        for code in (403, 404, 429):
            calls, sleeps, data, error = self.run_download([http_error(code)])
            self.assertEqual((len(calls), sleeps), (1, []), code)
            self.assertEqual(error.code, code)

    def test_retries_are_bounded_and_last_error_raised(self):
        calls, sleeps, data, error = self.run_download([http_error(504)] * 10)
        self.assertEqual((len(calls), sleeps), (4, [1, 2, 3]))
        self.assertEqual(error.code, 504)

    def test_non_network_errors_are_not_retried(self):
        for failure in (ValueError('bad'), PermissionError('read-only volume')):
            calls, sleeps, data, error = self.run_download([failure])
            self.assertEqual((len(calls), sleeps), (1, []))
            self.assertIs(error, failure)

    def test_partial_download_is_overwritten_by_the_retry(self):
        responses = [Response(b'partial', fail=http.client.IncompleteRead(b'')), Response(b'complete')]
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(cache.urllib.request, 'urlopen', lambda url, timeout: responses.pop(0)), \
                contextlib.redirect_stderr(io.StringIO()):
            dest = Path(temp) / 'archive'
            cache.download('https://github.com/x', dest, delays=(1,), sleep=lambda delay: None)
            self.assertEqual(dest.read_bytes(), b'complete')
        self.assertEqual(responses, [])

    def test_install_survives_one_gateway_timeout(self):
        # The defect: install() made one urlretrieve attempt, so a single GitHub
        # 504 failed the cache step (runs 41999101145 and 41999539245). This
        # fails without the retry: the 504 escapes instead of the checksum error.
        responses = [http_error(504), Response(b'corrupt archive')]
        urls = []
        def urlopen(url, *args, **kwargs):
            urls.append(url)
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response
        with tempfile.TemporaryDirectory() as temp, patch.object(cache.urllib.request, 'urlopen', urlopen), \
                patch.object(time, 'sleep') as sleep, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                cache.install(Path(temp))
        self.assertEqual(len(urls), 2)
        sleep.assert_called_once_with(cache.RETRY_DELAYS[0])
        self.assertIn('/mozilla/sccache/releases/download/v', urls[0])


def fake_sccache(directory, exits):
    """An sccache stand-in exiting with exits[n] on its nth call and logging each call's arguments and env."""
    binary = Path(directory) / 'sccache'
    binary.write_text('#!/bin/sh\n'
                      'n=$(wc -l < "$0.log" 2>/dev/null || echo 0)\n'
                      'echo "$* port=$SCCACHE_SERVER_PORT idle=$SCCACHE_IDLE_TIMEOUT '
                      'endpoint=$SCCACHE_WEBDAV_ENDPOINT wrapper=$RUSTC_WRAPPER" >> "$0.log"\n'
                      f'set -- {" ".join(str(code) for code in exits)}\n'
                      'shift $((n < $# - 1 ? n : $# - 1)); exit "$1"\n')
    binary.chmod(0o755)
    return Path(str(binary) + '.log')


def run_main(env, exits=(0,), calls=None):
    with tempfile.TemporaryDirectory() as temp:
        env = {'RUNNER_TEMP': temp, 'GITHUB_PATH': temp + '/path', 'GITHUB_ENV': temp + '/env', **env}
        log = fake_sccache(temp, exits)
        out = io.StringIO()
        with patch.dict(cache.os.environ, env, clear=True), patch.object(cache, 'install', return_value=Path(temp)), \
                patch.object(cache, 'STARTUP_RETRY_DELAY', 0), contextlib.redirect_stdout(out):
            cache.main()
        if calls is not None:
            calls.extend(log.read_text().splitlines() if log.exists() else [])
        path = Path(env['GITHUB_ENV'])
        lines = path.read_text().splitlines() if path.exists() else []
        return dict(line.split('=', 1) for line in lines), out.getvalue()


class ServerStartup(unittest.TestCase):
    """A server that cannot start in sccache's fixed 10 s must not fail the build
    (cloudlands-fe merge_group run 42397918944, intentd CI runs 42356371788 and 42358341904)."""

    def test_server_is_started_with_the_job_configuration_before_any_compile(self):
        calls = []
        written, output = run_main(SELF_HOSTED, exits=(0,), calls=calls)
        self.assertEqual(written['RUSTC_WRAPPER'], 'sccache')
        self.assertEqual(len(calls), 1)
        # --show-stats would answer without ever starting a server.
        self.assertTrue(calls[0].startswith('--zero-stats '), calls[0])
        self.assertIn(f"port={written['SCCACHE_SERVER_PORT']} idle=0 endpoint=https://cache.example.com wrapper=",
                      calls[0])
        self.assertNotIn('wrapper=sccache', calls[0])
        self.assertNotIn('INTENT_SCCACHE_DISABLED', written)
        self.assertNotIn('::warning::', output)

    def test_unreachable_cache_compiles_uncached_instead_of_failing(self):
        calls = []
        written, output = run_main(SELF_HOSTED, exits=(2,), calls=calls)
        self.assertNotIn('RUSTC_WRAPPER', written)
        self.assertEqual(len(calls), cache.STARTUP_ATTEMPTS)
        self.assertIn('::warning::', output)
        self.assertIn('uncached', output)
        self.assertNotIn('intent-secret', output)
        # Cache-specific steps still see the backend; only compilation stops using it.
        self.assertEqual(written['SCCACHE_WEBDAV_ENDPOINT'], 'https://cache.example.com')
        # with-sccache.sh would otherwise re-export RUSTC_WRAPPER from the endpoint.
        self.assertEqual(written['INTENT_SCCACHE_DISABLED'], '1')

    def test_a_server_that_finishes_starting_late_is_kept(self):
        calls = []
        written, output = run_main(SELF_HOSTED, exits=(2, 0), calls=calls)
        self.assertEqual(written['RUSTC_WRAPPER'], 'sccache')
        self.assertEqual(len(calls), 2)
        self.assertNotIn('::warning::', output)

    def test_hung_or_missing_client_counts_as_a_failed_start(self):
        def hung(*args, **kwargs):
            raise cache.subprocess.TimeoutExpired(args[0], 1)
        for failure in (hung, FileNotFoundError('sccache')):
            with self.subTest(failure=failure):
                run = unittest.mock.Mock(side_effect=failure)
                self.assertFalse(cache.start_server(Path('sccache'), {}, run=run, delay=0))
                self.assertEqual(run.call_count, cache.STARTUP_ATTEMPTS)

    def test_uncached_configurations_never_start_a_server(self):
        for env in ({}, {'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'}):
            with self.subTest(env=env):
                calls = []
                run_main(env, calls=calls)
                self.assertEqual(calls, [])


class SelfHostedCache(unittest.TestCase):
    def test_endpoint_and_token_select_self_hosted(self):
        value = cache.configuration(SELF_HOSTED)
        self.assertEqual(value, {'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.example.com',
                                 'SCCACHE_WEBDAV_TOKEN': 'intent-secret', 'SCCACHE_WEBDAV_RW_MODE': 'READ_WRITE',
                                 'RUSTC_WRAPPER': 'sccache', 'CARGO_INCREMENTAL': '0', 'SCCACHE_GHA_ENABLED': 'false'})

    def test_inherited_values_are_overwritten(self):
        env = {**INHERITED, **SELF_HOSTED}
        value = cache.configuration(env)
        self.assertEqual(value['SCCACHE_WEBDAV_ENDPOINT'], 'https://cache.example.com')
        self.assertEqual(value['SCCACHE_WEBDAV_TOKEN'], 'intent-secret')
        self.assertEqual(value['SCCACHE_WEBDAV_KEY_PREFIX'], '')
        self.assertEqual(value['SCCACHE_WEBDAV_USERNAME'], '')
        self.assertNotIn('SCCACHE_WEBDAV_PASSWORD', value)

    def test_read_only_mode(self):
        value = cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_MODE': 'read_only'})
        self.assertEqual(value['SCCACHE_WEBDAV_RW_MODE'], 'READ_ONLY')

    def test_empty_mode_defaults_to_read_write(self):
        value = cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_MODE': ''})
        self.assertEqual(value['SCCACHE_WEBDAV_RW_MODE'], 'READ_WRITE')

    def test_invalid_mode_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'READ_WRITE or READ_ONLY'):
            cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_MODE': 'WRITE'})

    def test_missing_token_builds_uncached_without_inherited_fallback(self):
        # Fork pull requests get the variable but no secrets; inherited values
        # must not be reused against the self-hosted endpoint.
        for token in ('', None):
            env = {**INHERITED, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'}
            if token is not None:
                env['INTENT_SCCACHE_TOKEN'] = token
            self.assertEqual(cache.select(env), ('uncached-self-hosted', None, {}))

    def test_inherited_token_never_reaches_self_hosted_endpoint(self):
        for env in ({**INHERITED, **SELF_HOSTED}, {**INHERITED, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'}):
            written, output = run_main(env)
            self.assertNotIn('inherited-secret', ''.join(written.values()))
            self.assertNotIn('inherited-secret', output)

    def test_endpoint_must_be_https(self):
        for endpoint in ('http://cache.example.com', 'cache.example.com', 'https://'):
            with self.assertRaisesRegex(ValueError, 'https'):
                cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': endpoint})
        self.assertIn('SCCACHE_WEBDAV_ENDPOINT', cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': 'http://127.0.0.1:8080'}))

    def test_main_reports_backend_and_mode_without_token(self):
        written, output = run_main({**INHERITED, **SELF_HOSTED, 'INTENT_SCCACHE_MODE': 'READ_ONLY'})
        self.assertEqual(written['SCCACHE_WEBDAV_ENDPOINT'], 'https://cache.example.com')
        self.assertEqual(written['SCCACHE_WEBDAV_RW_MODE'], 'READ_ONLY')
        self.assertIn('self-hosted sccache at cache.example.com (READ_ONLY)', output)
        self.assertNotIn('intent-secret', output)

    def test_main_reports_uncached_when_token_missing(self):
        written, output = run_main({**INHERITED, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'})
        self.assertEqual(written, {})
        self.assertIn('INTENT_SCCACHE_TOKEN is empty', output)

    def test_unset_variable_builds_uncached(self):
        written, output = run_main(INHERITED)
        self.assertEqual(written, {})
        self.assertIn('INTENT_SCCACHE_ENDPOINT is not set', output)
        self.assertNotIn('inherited-secret', output)

    def test_no_depot_cache_path_remains(self):
        self.assertNotIn('depot', (ROOT/'scripts/setup-sccache.py').read_text().lower())
        for path in (ROOT/'.github').rglob('*.yml'):
            self.assertNotIn('DEPOT_SCCACHE_TOKEN', path.read_text(), str(path))
            self.assertNotIn('setup-depot-sccache', path.read_text(), str(path))

    def test_workflows_pass_self_hosted_inputs(self):
        # Every setup step must receive the switch, token and mode, or the
        # self-hosted cache silently stays off for that job.
        steps = 0
        for path in (ROOT/'.github').rglob('*.yml'):
            text = path.read_text()
            for match in re.finditer(r'\n(\s*)- name:[^\n]*\n((?:\1  [^\n]*\n)*?)\1  run: python3 scripts/setup-sccache\.py', text):
                steps += 1
                block = match.group(2)
                for line in ('INTENT_SCCACHE_ENDPOINT: ${{ vars.INTENT_SCCACHE_ENDPOINT }}',
                             'INTENT_SCCACHE_TOKEN: ${{ secrets.INTENT_SCCACHE_TOKEN }}',
                             'INTENT_SCCACHE_MODE: ${{ vars.INTENT_SCCACHE_MODE }}'):
                    self.assertIn(line, block, str(path))
        self.assertGreater(steps, 0)
        reusable = (ROOT/'.github/workflows/consumer-checks.yml').read_text()
        self.assertIn('      INTENT_SCCACHE_TOKEN:\n        required: false', reusable)
        self.assertIn('INTENT_SCCACHE_TOKEN: ${{ secrets.INTENT_SCCACHE_TOKEN }}', (ROOT/'.github/workflows/ci.yml').read_text())


if __name__ == '__main__':
    unittest.main()
