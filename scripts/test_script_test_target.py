"""Exercise the CI Make target with isolated passing/failing suite fixtures."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ScriptTestTargetTests(unittest.TestCase):
    def run_target(self, cleanup_passes):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            (scripts / "__init__.py").touch()
            for source in ROOT.glob("scripts/test_*.py"):
                succeeds = cleanup_passes or source.name != "test_cleanup_prereleases.py"
                (scripts / source.name).write_text(
                    "import unittest\n"
                    "class Fixture(unittest.TestCase):\n"
                    f"    def test_{source.stem}(self):\n"
                    f"        self.assertTrue({succeeds!r})\n"
                )
            env = {k: v for k, v in os.environ.items()
                   if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "PYTHONPATH"}}
            return subprocess.run(
                ["make", "--no-print-directory", "-f", str(ROOT / "Makefile"), "test-scripts"],
                cwd=root, env=env, text=True, capture_output=True, timeout=30,
            )

    def test_cleanup_suite_runs_without_submodules(self):
        result = self.run_target(True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("test_test_cleanup_prereleases", result.stderr)
        self.assertIn("test_test_watch_capacity", result.stderr)
        self.assertIn("test_test_rust_test_policy", result.stderr)

    def test_cleanup_failure_fails_ci_target(self):
        result = self.run_target(False)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("FAIL: test_test_cleanup_prereleases", result.stderr)


if __name__ == "__main__":
    unittest.main()
