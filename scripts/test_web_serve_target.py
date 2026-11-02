"""Exercise `make web-serve` against a stub frontend git checkout and stub corepack."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

FAKE_SERVER = """
const keys = ['WEB_SERVE_SOCKET', 'WEB_SERVE_PORT', 'WEB_SERVE_REQUIRE_HEADER'];
console.log('SERVER ' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
"""

FAKE_COREPACK = """#!/bin/sh
echo "COREPACK $* NODE_OPTIONS=$NODE_OPTIONS"
if [ -n "$FAIL_BUILD" ]; then exit 1; fi
mkdir -p dist/web && echo built > dist/web/index.html
"""

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
}


class WebServeTargetTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.fe = self.root / "packages" / "cloudlands-fe"
        (self.fe / "scripts").mkdir(parents=True)
        (self.fe / "src").mkdir()
        (self.fe / ".gitignore").write_text("node_modules/\ndist/\n")
        (self.fe / "pnpm-lock.yaml").write_text("lock\n")
        (self.fe / "postcss.config.mjs").write_text("export default {};\n")
        (self.fe / "src" / "app.ts").write_text("export {};\n")
        (self.fe / "scripts" / "web-serve.mjs").write_text(FAKE_SERVER)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")
        (self.fe / "node_modules" / ".pnpm").mkdir(parents=True)
        (self.fe / "node_modules" / ".pnpm" / "lock.yaml").write_text("lock\n")
        stub_scripts = self.root / "scripts"
        stub_scripts.mkdir()
        bootstrap = stub_scripts / "bootstrap-dev-host.sh"
        bootstrap.write_text("#!/bin/sh\nexit 0\n")
        bootstrap.chmod(0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        corepack = self.bin / "corepack"
        corepack.write_text(FAKE_COREPACK)
        corepack.chmod(0o755)

    def tearDown(self):
        self._tmp.cleanup()

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.fe, check=True, capture_output=True,
                       env={**os.environ, **GIT_ENV})

    def run_target(self, *args, env_extra=None):
        env = {k: v for k, v in os.environ.items()
               if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL"} and not k.startswith("WEB_SERVE_")}
        env.update(GIT_ENV)
        env["PATH"] = f"{self.bin}{os.pathsep}{env['PATH']}"
        env.update(env_extra or {})
        return subprocess.run(
            ["make", "--no-print-directory", "-f", str(ROOT / "Makefile"), "web-serve", *args],
            cwd=self.root, env=env, text=True, capture_output=True, timeout=60,
        )

    def server_env(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        line = next(l for l in result.stdout.splitlines() if l.startswith("SERVER "))
        return json.loads(line[len("SERVER "):])

    def assert_built(self, result):
        self.server_env(result)
        self.assertIn("COREPACK pnpm run build:web", result.stdout)

    def assert_reused(self, result):
        self.server_env(result)
        self.assertNotIn("COREPACK", result.stdout)
        self.assertIn("dist/web matches this checkout", result.stdout)

    def test_missing_server_script_fails_with_guidance(self):
        (self.fe / "scripts" / "web-serve.mjs").unlink()
        result = self.run_target()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has no scripts/web-serve.mjs", result.stdout + result.stderr)
        self.assertNotIn("COREPACK", result.stdout)

    def test_builds_when_dist_is_missing_and_uses_default_socket(self):
        result = self.run_target()
        self.assert_built(result)
        self.assertIn("NODE_OPTIONS=--max-old-space-size=", result.stdout)
        env = self.server_env(result)
        self.assertEqual(env["WEB_SERVE_SOCKET"], str(self.root / ".dev" / "web-serve" / "web.sock"))
        self.assertIsNone(env["WEB_SERVE_PORT"])

    def test_reuses_a_build_of_the_same_checkout(self):
        self.assert_built(self.run_target())
        self.assert_reused(self.run_target())

    def test_rebuilds_after_editing_any_tracked_build_input(self):
        self.assert_built(self.run_target())
        (self.fe / "postcss.config.mjs").write_text("export default { plugins: {} };\n")
        self.assert_built(self.run_target())
        self.assert_reused(self.run_target())

    def test_rebuilds_after_adding_an_untracked_file(self):
        self.assert_built(self.run_target())
        (self.fe / "scripts" / "new-build-helper.mjs").write_text("export {};\n")
        self.assert_built(self.run_target())

    def test_rebuilds_after_a_new_commit(self):
        self.assert_built(self.run_target())
        (self.fe / "src" / "app.ts").write_text("export const x = 1;\n")
        self.git("commit", "-q", "-am", "change")
        self.assert_built(self.run_target())

    def test_rebuilds_a_dist_this_target_did_not_build(self):
        (self.fe / "dist" / "web").mkdir(parents=True)
        (self.fe / "dist" / "web" / "index.html").write_text("someone else's build\n")
        self.assert_built(self.run_target())

    def test_failed_build_is_not_reused(self):
        failed = self.run_target(env_extra={"FAIL_BUILD": "1"})
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn("SERVER ", failed.stdout)
        self.assert_built(self.run_target())

    def test_rebuild_flag_forces_a_build(self):
        self.assert_built(self.run_target())
        self.assert_built(self.run_target("WEB_SERVE_REBUILD=1"))

    def test_passes_server_settings_through(self):
        result = self.run_target(
            "WEB_SERVE_SOCKET=/tmp/custom.sock",
            "WEB_SERVE_PORT=8080",
            "WEB_SERVE_REQUIRE_HEADER=Tailscale-User-Login=me@example.com",
        )
        env = self.server_env(result)
        self.assertEqual(env, {
            "WEB_SERVE_SOCKET": "/tmp/custom.sock",
            "WEB_SERVE_PORT": "8080",
            "WEB_SERVE_REQUIRE_HEADER": "Tailscale-User-Login=me@example.com",
        })


if __name__ == "__main__":
    unittest.main()
