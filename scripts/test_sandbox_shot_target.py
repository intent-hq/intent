"""Exercise `make sandbox-shot` against a copy of the Makefile with stub tools.

The recipe must forward PREVIEW, STATE, THEME, WIDTH and OUT to
`pnpm sandbox:shot` as separate arguments, refuse a missing PREVIEW or STATE
before running pnpm, and ignore those names when they only come from the
caller's environment.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

COREPACK_STUB = """#!/usr/bin/env bash
printf '%s\\n' "$@" >"$SANDBOX_SHOT_LOG"
"""


class SandboxShotTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "checkout"
        fe = self.root / "packages/cloudlands-fe"
        (fe / ".git").mkdir(parents=True)
        (fe / "node_modules/.pnpm").mkdir(parents=True)
        (fe / "pnpm-lock.yaml").write_text("lock\n")
        (fe / "node_modules/.pnpm/lock.yaml").write_text("lock\n")
        scripts = self.root / "scripts"
        scripts.mkdir()
        bootstrap = scripts / "bootstrap-dev-host.sh"
        bootstrap.write_text("#!/usr/bin/env bash\nexit 0\n")
        bootstrap.chmod(0o755)
        shutil.copy(ROOT / "Makefile", self.root / "Makefile")
        self.bin = Path(temporary.name) / "bin"
        self.bin.mkdir()
        corepack = self.bin / "corepack"
        corepack.write_text(COREPACK_STUB)
        corepack.chmod(0o755)
        self.log = Path(temporary.name) / "corepack.log"

    def run_make(self, *arguments, env=None):
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL",
                                    "PREVIEW", "STATE", "THEME", "WIDTH", "OUT"}}
        environment["PATH"] = f"{self.bin}{os.pathsep}{environment['PATH']}"
        environment["SANDBOX_SHOT_LOG"] = str(self.log)
        environment.update(env or {})
        return subprocess.run(["make", "--no-print-directory", "-C", str(self.root),
                               "sandbox-shot", *arguments],
                              env=environment, capture_output=True, text=True, timeout=60)

    def pnpm_arguments(self):
        return self.log.read_text().splitlines()

    def test_forwards_every_option_as_one_argument(self):
        result = self.run_make("PREVIEW=browser viewer", "STATE=mirror agent", "THEME=dark",
                               "WIDTH=420", "OUT=shots/a b.png")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.pnpm_arguments(), [
            "pnpm", "--silent", "sandbox:shot", "browser viewer", "--state", "mirror agent",
            "--theme", "dark", "--width", "420", "--out", "shots/a b.png",
        ])

    def test_omits_unset_options(self):
        result = self.run_make("PREVIEW=button", "STATE=default")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.pnpm_arguments(),
                         ["pnpm", "--silent", "sandbox:shot", "button", "--state", "default"])

    def test_missing_preview_or_state_fails_before_pnpm(self):
        for arguments in (["STATE=default"], ["PREVIEW=button"], []):
            with self.subTest(arguments=arguments):
                result = self.run_make(*arguments)
                self.assertEqual(result.returncode, 2)
                self.assertIn("usage: make sandbox-shot PREVIEW=<id> STATE=<state>", result.stderr)
                self.assertFalse(self.log.exists())

    def test_ignores_environment_values(self):
        result = self.run_make("PREVIEW=button", "STATE=default",
                               env={"THEME": "dark", "WIDTH": "999", "OUT": "x.png"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.pnpm_arguments(),
                         ["pnpm", "--silent", "sandbox:shot", "button", "--state", "default"])
        missing = self.run_make(env={"PREVIEW": "button", "STATE": "default"})
        self.assertEqual(missing.returncode, 2)


if __name__ == "__main__":
    unittest.main()
