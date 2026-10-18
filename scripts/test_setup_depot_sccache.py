#!/usr/bin/env python3
"""Exercise managed cache selection and checksum verification without networking."""
import contextlib
import importlib.util
import io
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cache', ROOT / 'scripts/setup-depot-sccache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)

class ManagedCache(unittest.TestCase):
    def test_missing_credentials_does_not_configure_wrapper(self):
        self.assertEqual(cache.configuration({}), {})

    def test_depot_job_endpoint_is_preserved(self):
        value = cache.configuration({'SCCACHE_WEBDAV_ENDPOINT': 'https://job.example/cache', 'SCCACHE_WEBDAV_TOKEN': 'job-secret'})
        self.assertEqual(value, {'RUSTC_WRAPPER': 'sccache', 'CARGO_INCREMENTAL': '0', 'SCCACHE_GHA_ENABLED': 'false'})

    def test_self_hosted_secret_uses_managed_endpoint(self):
        value = cache.configuration({'DEPOT_SCCACHE_TOKEN': 'fixture'})
        self.assertEqual(value['SCCACHE_WEBDAV_ENDPOINT'], 'https://cache.depot.dev')
        self.assertEqual(value['SCCACHE_WEBDAV_TOKEN'], 'fixture')
        self.assertNotIn('SCCACHE_DIR', value)

    def test_corrupt_download_is_not_installed(self):
        def download(url, dest):
            Path(dest).write_bytes(b'corrupt archive')
        with tempfile.TemporaryDirectory() as temp, patch.object(cache.urllib.request, 'urlretrieve', download):
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                cache.install(Path(temp))
            self.assertFalse((Path(temp)/'sccache').exists())

    def test_archive_uses_job_volume_instead_of_system_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'job-cache'
            def download(url, dest):
                self.assertTrue(Path(dest).is_relative_to(directory.parent))
                Path(dest).write_bytes(b'corrupt archive')
            with patch.object(cache.urllib.request, 'urlretrieve', download):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    cache.install(directory)

    def test_long_compilation_does_not_expire_server(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {'RUNNER_TEMP': temp, 'GITHUB_PATH': temp + '/path',
                   'GITHUB_ENV': temp + '/env', 'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.depot.dev'}
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

# Values a Depot runner injects into every job.
DEPOT_JOB = {'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.depot.dev', 'SCCACHE_WEBDAV_TOKEN': 'depot-job-secret',
             'DEPOT_SCCACHE_TOKEN': 'depot-org-secret'}
SELF_HOSTED = {'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com', 'INTENT_SCCACHE_TOKEN': 'intent-secret'}


def run_main(env):
    with tempfile.TemporaryDirectory() as temp:
        env = {'RUNNER_TEMP': temp, 'GITHUB_PATH': temp + '/path', 'GITHUB_ENV': temp + '/env', **env}
        out = io.StringIO()
        with patch.dict(cache.os.environ, env, clear=True), patch.object(cache, 'install', return_value=Path(temp)), \
                contextlib.redirect_stdout(out):
            cache.main()
        path = Path(env['GITHUB_ENV'])
        lines = path.read_text().splitlines() if path.exists() else []
        return dict(line.split('=', 1) for line in lines), out.getvalue()


class SelfHostedCache(unittest.TestCase):
    def test_endpoint_and_token_select_self_hosted(self):
        value = cache.configuration(SELF_HOSTED)
        self.assertEqual(value, {'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.example.com',
                                 'SCCACHE_WEBDAV_TOKEN': 'intent-secret', 'SCCACHE_WEBDAV_RW_MODE': 'READ_WRITE',
                                 'RUSTC_WRAPPER': 'sccache', 'CARGO_INCREMENTAL': '0', 'SCCACHE_GHA_ENABLED': 'false'})

    def test_inherited_depot_values_are_overwritten(self):
        env = {**DEPOT_JOB, 'SCCACHE_WEBDAV_KEY_PREFIX': 'depot/prefix', 'SCCACHE_WEBDAV_USERNAME': 'depot', **SELF_HOSTED}
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

    def test_missing_token_builds_uncached_without_depot_fallback(self):
        # Fork pull requests get the variable but no secrets; Depot's values
        # must not be reused against the self-hosted endpoint.
        for token in ('', None):
            env = {**DEPOT_JOB, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'}
            if token is not None:
                env['INTENT_SCCACHE_TOKEN'] = token
            self.assertEqual(cache.select(env), ('uncached-self-hosted', None, {}))

    def test_depot_token_never_reaches_self_hosted_endpoint(self):
        for env in ({**DEPOT_JOB, **SELF_HOSTED}, {**DEPOT_JOB, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'}):
            written, output = run_main(env)
            for secret in ('depot-job-secret', 'depot-org-secret'):
                self.assertNotIn(secret, ''.join(written.values()))
                self.assertNotIn(secret, output)

    def test_depot_org_token_not_copied_to_inherited_foreign_endpoint(self):
        value = cache.configuration({'SCCACHE_WEBDAV_ENDPOINT': 'https://other.example', 'DEPOT_SCCACHE_TOKEN': 'depot-org-secret'})
        self.assertNotIn('SCCACHE_WEBDAV_TOKEN', value)

    def test_endpoint_must_be_https(self):
        for endpoint in ('http://cache.example.com', 'cache.example.com', 'https://'):
            with self.assertRaisesRegex(ValueError, 'https'):
                cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': endpoint})
        self.assertIn('SCCACHE_WEBDAV_ENDPOINT', cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': 'http://127.0.0.1:8080'}))

    def test_endpoint_must_not_be_depot(self):
        with self.assertRaisesRegex(ValueError, 'Depot'):
            cache.configuration({**SELF_HOSTED, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.depot.dev'})

    def test_main_reports_backend_and_mode_without_token(self):
        written, output = run_main({**DEPOT_JOB, **SELF_HOSTED, 'INTENT_SCCACHE_MODE': 'READ_ONLY'})
        self.assertEqual(written['SCCACHE_WEBDAV_ENDPOINT'], 'https://cache.example.com')
        self.assertEqual(written['SCCACHE_WEBDAV_RW_MODE'], 'READ_ONLY')
        self.assertIn('self-hosted sccache at cache.example.com (READ_ONLY)', output)
        self.assertNotIn('intent-secret', output)

    def test_main_reports_uncached_when_token_missing(self):
        written, output = run_main({**DEPOT_JOB, 'INTENT_SCCACHE_ENDPOINT': 'https://cache.example.com'})
        self.assertEqual(written, {})
        self.assertIn('INTENT_SCCACHE_TOKEN is empty', output)

    def test_unset_variable_keeps_depot_behavior(self):
        for env in (DEPOT_JOB, {'DEPOT_SCCACHE_TOKEN': 'fixture'}, {}, {'INTENT_SCCACHE_ENDPOINT': ' ', **DEPOT_JOB},
                    {'INTENT_SCCACHE_TOKEN': 'intent-secret', 'SCCACHE_WEBDAV_ENDPOINT': 'https://cache.depot.dev'}):
            backend, _, value = cache.select(env)
            self.assertNotEqual(backend, 'self-hosted')
            self.assertNotIn('SCCACHE_WEBDAV_RW_MODE', value)
            self.assertNotIn('intent-secret', ''.join(value.values()))
        written, output = run_main(DEPOT_JOB)
        self.assertEqual(set(written), {'RUSTC_WRAPPER', 'CARGO_INCREMENTAL', 'SCCACHE_GHA_ENABLED',
                                        'SCCACHE_SERVER_PORT', 'SCCACHE_IDLE_TIMEOUT'})
        self.assertEqual(output, 'Rust compilation uses Depot managed sccache.\n')

    def test_workflows_pass_self_hosted_inputs(self):
        # Every setup step must receive the switch, token and mode, or the
        # self-hosted cache silently stays off for that job.
        steps = 0
        for path in (ROOT/'.github').rglob('*.yml'):
            text = path.read_text()
            for match in re.finditer(r'\n(\s*)- name:[^\n]*\n((?:\1  [^\n]*\n)*?)\1  run: python3 scripts/setup-depot-sccache\.py', text):
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
