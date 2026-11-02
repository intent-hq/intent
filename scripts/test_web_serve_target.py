"""Exercise `make web-serve` against a stub frontend checkout and stub corepack."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]

FAKE_SERVER = """
const keys = ['WEB_SERVE_SOCKET', 'WEB_SERVE_PORT', 'WEB_SERVE_REQUIRE_HEADER'];
console.log('SERVER ' + JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
"""

FAKE_COREPACK = """#!/bin/sh
echo "COREPACK $* NODE_OPTIONS=$NODE_OPTIONS"
mkdir -p dist/web && echo built > dist/web/index.html
"""


class WebServeTargetTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.fe = self.root / "packages" / "cloudlands-fe"
        (self.fe / "scripts").mkdir(parents=True)
        (self.fe / "src").mkdir()
        (self.fe / ".git").write_text("gitdir: elsewhere\n")
        (self.fe / "pnpm-lock.yaml").write_text("lock\n")
        (self.fe / "node_modules" / ".pnpm").mkdir(parents=True)
        (self.fe / "node_modules" / ".pnpm" / "lock.yaml").write_text("lock\n")
        (self.fe / "src" / "app.ts").write_text("export {};\n")
        (self.fe / "scripts" / "web-serve.mjs").write_text(FAKE_SERVER)
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
        old = time.time() - 3600
        for path in self.fe.rglob("*"):
            os.utime(path, (old, old))

    def tearDown(self):
        self._tmp.cleanup()

    def run_target(self, *args, env_extra=None):
        env = {k: v for k, v in os.environ.items()
               if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL"} and not k.startswith("WEB_SERVE_")}
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

    def make_dist(self, age_seconds):
        """Write dist/web/index.html stamped relative to the hour-old fixture sources."""
        dist = self.fe / "dist" / "web"
        dist.mkdir(parents=True, exist_ok=True)
        index = dist / "index.html"
        index.write_text("old\n")
        stamp = time.time() - 3600 + age_seconds
        os.utime(index, (stamp, stamp))

    def test_missing_server_script_fails_with_guidance(self):
        (self.fe / "scripts" / "web-serve.mjs").unlink()
        result = self.run_target()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has no scripts/web-serve.mjs", result.stdout + result.stderr)
        self.assertNotIn("COREPACK", result.stdout)

    def test_builds_when_dist_is_missing_and_uses_default_socket(self):
        result = self.run_target()
        env = self.server_env(result)
        self.assertIn("COREPACK pnpm run build:web NODE_OPTIONS=--max-old-space-size=", result.stdout)
        self.assertEqual(env["WEB_SERVE_SOCKET"], str(self.root / ".dev" / "web-serve" / "web.sock"))
        self.assertIsNone(env["WEB_SERVE_PORT"])

    def test_skips_build_when_dist_is_newer_than_sources(self):
        self.make_dist(age_seconds=60)
        result = self.run_target()
        self.server_env(result)
        self.assertNotIn("COREPACK", result.stdout)
        self.assertIn("dist/web is up to date", result.stdout)

    def test_rebuilds_when_a_source_is_newer(self):
        self.make_dist(age_seconds=60)
        os.utime(self.fe / "src" / "app.ts")
        result = self.run_target()
        self.server_env(result)
        self.assertIn("COREPACK pnpm run build:web", result.stdout)

    def test_rebuild_flag_forces_a_build(self):
        self.make_dist(age_seconds=60)
        result = self.run_target("WEB_SERVE_REBUILD=1")
        self.server_env(result)
        self.assertIn("COREPACK pnpm run build:web", result.stdout)

    def test_passes_server_settings_through(self):
        self.make_dist(age_seconds=60)
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
