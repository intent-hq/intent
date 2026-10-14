#!/usr/bin/env python3
"""Exercise managed cache selection and checksum verification without networking."""
import importlib.util
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

    def test_no_rust_cache_actions(self):
        for path in (ROOT/'.github').rglob('*.yml'):
            self.assertNotIn('Swatinem/rust-cache', path.read_text(), str(path))
            self.assertNotIn('mozilla-actions/sccache-action', path.read_text(), str(path))

if __name__ == '__main__':
    unittest.main()
