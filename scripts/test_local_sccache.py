#!/usr/bin/env python3
"""Local make build opts into the configured compiler cache without changing wrappers."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[1]

class LocalCache(unittest.TestCase):
    def run_build(self, configured=False, binary=True, wrapper=None):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'Cargo.toml').write_text('')
            for name, script in {
                'cargo': '#!/bin/sh\nprintf "wrapper=%s\\nendpoint=%s\\n" "$RUSTC_WRAPPER" "$SCCACHE_WEBDAV_ENDPOINT"\n',
                'bash': '#!/bin/sh\nexec /bin/bash "$@"\n',
                **({'sccache': '#!/bin/sh\nexit 0\n'} if binary else {}),
            }.items():
                p=root/name;p.write_text(script);p.chmod(0o755)
            env={k:v for k,v in os.environ.items() if not k.startswith(('SCCACHE_', 'RUSTC_WRAPPER'))}
            env['PATH']=temp
            if configured:env.update(SCCACHE_WEBDAV_ENDPOINT='https://cache.depot.dev',SCCACHE_WEBDAV_TOKEN='fixture-secret')
            if wrapper is not None:env['RUSTC_WRAPPER']=wrapper
            # Use the real recipe with the preflight overridden by a test-only makefile.
            fixture=root/'fixture.mk';fixture.write_text(f'include {ROOT}/Makefile\nensure-intentd-submodule: ;\n')
            result=subprocess.run(['/usr/bin/make','-s','-f',str(fixture),'build',f'INTENTD_DIR={root}',f'PATH={temp}'],env=env,cwd=ROOT,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('fixture-secret',result.stdout+result.stderr)
            return result.stdout

    def test_configured(self):self.assertIn('wrapper=sccache',self.run_build(configured=True))
    def test_unconfigured(self):self.assertIn('wrapper=\n',self.run_build())
    def test_missing_tool(self):self.assertIn('wrapper=\n',self.run_build(configured=True,binary=False))
    def test_explicit_wrapper(self):self.assertIn('wrapper=custom',self.run_build(configured=True,wrapper='custom'))
    def test_explicit_disabled_wrapper(self):self.assertIn('wrapper=\n',self.run_build(configured=True,wrapper=''))

if __name__=='__main__':unittest.main()
