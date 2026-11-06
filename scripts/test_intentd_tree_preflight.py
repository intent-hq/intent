"""Exercise the intentd tree preflight the Rust gate targets run first.

A fixture monorepo records packages/intentd as a gitlink to a real fixture
intentd repository; the cases move that checkout off the pin or behind its
origin/main and run the script directly, then run `make fmt` from a copy of the
real Makefile with a stub cargo to prove the refusal happens before any cargo.
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "intentd_tree_preflight.py"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
           "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        # An apostrophe and a space in the path must not break the recipe.
        self.root = Path(os.path.realpath(temporary.name)) / "mono's root"
        self.intentd = self.root / "packages" / "intentd"
        self.intentd.mkdir(parents=True)
        self.env = {k: v for k, v in os.environ.items()
                    if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "INTENTD_DIR", "DRY_RUN",
                                 "INTENTD_TREE_CHECKED", "INTENTD_BEHIND_LIMIT"}}
        self.env.update(GIT_ENV)
        self.git(self.intentd, "init", "-q", "-b", "main")
        self.commit(self.intentd, "older")
        self.commit(self.intentd, "base")
        self.pin = self.git(self.intentd, "rev-parse", "HEAD")
        self.git(self.intentd, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.git(self.root, "init", "-q", "-b", "main")
        self.git(self.root, "-c", "advice.addEmbeddedRepo=false", "add", "packages/intentd")
        self.git(self.root, "commit", "-q", "-m", "pin")

    def git(self, path, *args):
        result = subprocess.run(["git", "-C", str(path), *args], env=self.env, text=True,
                                capture_output=True, check=True)
        return result.stdout.strip()

    def commit(self, path, message):
        self.git(path, "commit", "-q", "--allow-empty", "-m", message)

    def move_off_pin(self):
        self.git(self.intentd, "checkout", "-q", "-b", "someone-else", "HEAD~1")
        self.commit(self.intentd, "elsewhere")

    def advance_origin(self, count):
        self.git(self.intentd, "checkout", "-q", "-b", "upstream")
        for index in range(count):
            self.commit(self.intentd, f"upstream {index}")
        self.git(self.intentd, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.git(self.intentd, "checkout", "-q", "--detach", self.pin)

    def preflight(self, *args, intentd_dir="packages/intentd", origin="file"):
        return subprocess.run(
            [sys.executable, "-S", "-B", str(SCRIPT), "--repo-root", str(self.root),
             "--intentd-dir", intentd_dir, "--origin", origin, "--label", "test-changed", *args],
            env=self.env, text=True, capture_output=True, timeout=60)


class PreflightTests(Fixture):
    def test_default_checkout_at_the_pin_is_named_and_runs(self):
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"[test-changed] testing intentd: {self.intentd} main@{self.pin[:12]} "
                      "(at the monorepo pin, 0 behind origin/main)", result.stdout)

    def test_default_checkout_off_the_pin_is_refused_with_the_fixes(self):
        self.move_off_pin()
        result = self.preflight()
        self.assertEqual(result.returncode, 1)
        self.assertIn("someone-else@", result.stdout)
        self.assertIn(f"off the monorepo pin {self.pin[:12]}", result.stdout)
        self.assertIn(f"neither the monorepo pin {self.pin[:12]} nor built on it", result.stderr)
        self.assertIn("make test-changed INTENTD_DIR=/path/to/your/intentd", result.stderr)
        self.assertIn("make test-changed INTENTD_DIR=packages/intentd", result.stderr)
        self.assertIn("git submodule update --checkout packages/intentd", result.stderr)

    def test_own_commits_on_top_of_the_pin_run(self):
        self.git(self.intentd, "checkout", "-q", "-b", "my-feature")
        self.commit(self.intentd, "mine")
        self.commit(self.intentd, "mine too")
        result = self.preflight()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("my-feature@", result.stdout)
        self.assertIn("2 commits on top of the monorepo pin", result.stdout)

    def test_off_pin_checkout_runs_when_the_caller_chose_it(self):
        self.move_off_pin()
        for args, origin, note in (
            ((), "command line", "INTENTD_DIR from the command line"),
            (("--caller-cwd", str(self.intentd / "crates")), "file", "make started inside it"),
        ):
            with self.subTest(note=note):
                (self.intentd / "crates").mkdir(exist_ok=True)
                result = self.preflight(*args, origin=origin)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(note, result.stdout)

    def test_caller_outside_the_tree_does_not_count_as_choosing_it(self):
        self.move_off_pin()
        sibling = self.root / "packages" / "intentd-other"
        sibling.mkdir()
        result = self.preflight("--caller-cwd", str(sibling))
        self.assertEqual(result.returncode, 1, result.stdout)

    def test_stale_checkout_is_refused_above_the_limit_only(self):
        self.advance_origin(3)
        within = self.preflight("--behind-limit", "3")
        self.assertEqual(within.returncode, 0, within.stderr)
        self.assertIn("3 behind origin/main", within.stdout)
        beyond = self.preflight("--behind-limit", "2")
        self.assertEqual(beyond.returncode, 1)
        self.assertIn("3 commits behind origin/main (limit 2)", beyond.stderr)
        self.assertIn("git pull --rebase origin main", beyond.stderr)
        self.assertNotIn("return it to the pin", beyond.stderr)

    def test_dry_run_warns_instead_of_refusing(self):
        self.move_off_pin()
        result = self.preflight("--dry-run", "1")
        self.assertEqual(result.returncode, 0)
        self.assertIn("WARNING (DRY_RUN, not refused)", result.stderr)
        self.assertEqual(self.preflight("--dry-run", "0").returncode, 1)

    def test_explicit_worktree_elsewhere_is_named_and_runs(self):
        worktree = self.root.parent / "feature worktree"
        self.git(self.intentd, "worktree", "add", "-q", "-b", "feature", str(worktree))
        self.commit(worktree, "feature work")
        head = self.git(worktree, "rev-parse", "HEAD")
        result = self.preflight(intentd_dir=str(worktree), origin="command line")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"testing intentd: {worktree} feature@{head[:12]} "
                      "(0 behind origin/main, INTENTD_DIR from the command line)", result.stdout)

    def test_unknown_state_never_refuses(self):
        plain = self.root / "plain"
        (plain / ".git").mkdir(parents=True)
        result = self.preflight(intentd_dir="plain", origin="command line")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not a git checkout", result.stdout)
        self.git(self.intentd, "update-ref", "-d", "refs/remotes/origin/main")
        self.move_off_pin()
        self.assertEqual(self.preflight().returncode, 1)
        self.env["PATH"] = str(self.root / "no-git")
        missing_git = self.preflight()
        self.assertEqual(missing_git.returncode, 0, missing_git.stderr)

    def test_recursive_make_of_the_same_tree_is_skipped(self):
        self.move_off_pin()
        result = self.preflight("--checked", "packages/intentd", "--make-level", "1")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        self.assertEqual(self.preflight("--checked", "elsewhere", "--make-level", "1").returncode, 1)
        # A stray exported value in a top-level make is ignored.
        self.assertEqual(self.preflight("--checked", "packages/intentd", "--make-level", "0").returncode, 1)


class MakeGateTests(Fixture):
    def setUp(self):
        super().setUp()
        (self.root / "scripts").mkdir()
        shutil.copy(ROOT / "Makefile", self.root / "Makefile")
        shutil.copy(SCRIPT, self.root / "scripts" / SCRIPT.name)
        self.bin = self.root.parent / "bin"
        self.bin.mkdir()
        self.cargo_log = self.root.parent / "cargo.log"
        cargo = self.bin / "cargo"
        cargo.write_text(f'#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$*" >> "{self.cargo_log}"\n')
        cargo.chmod(0o755)

    def run_make(self, *args, cwd=None, env=None):
        return subprocess.run(
            ["make", "--no-print-directory", "-C", str(self.root), *args,
             f"CARGO_BIN_DIR={self.bin}", "RUSTUP_CARGO="],
            cwd=cwd or self.root, env={**self.env, "PWD": str(cwd or self.root), **(env or {})},
            text=True, capture_output=True, timeout=60)

    def cargo_calls(self):
        return self.cargo_log.read_text() if self.cargo_log.exists() else ""

    def test_off_pin_default_stops_before_cargo(self):
        self.move_off_pin()
        result = self.run_make("fmt")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("[fmt] testing intentd:", result.stdout)
        self.assertIn("make fmt INTENTD_DIR=packages/intentd", result.stderr)
        self.assertEqual(self.cargo_calls(), "")

    def test_command_line_or_inside_the_tree_runs_and_names_it(self):
        self.move_off_pin()
        for args, cwd in ((("INTENTD_DIR=packages/intentd",), None), ((), self.intentd)):
            with self.subTest(args=args, cwd=cwd):
                self.cargo_log.unlink(missing_ok=True)
                result = self.run_make("fmt", *args, cwd=cwd)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"[fmt] testing intentd: {self.intentd} someone-else@", result.stdout)
                self.assertIn("fmt --check", self.cargo_calls())

    def test_check_runs_the_preflight_before_its_other_steps(self):
        for goal, first_other in (("check", "--intentd-dir \"packages/intentd\""),
                                  ("gate", "--check-callback-fixture")):
            with self.subTest(goal=goal):
                result = self.run_make("-n", goal)
                self.assertEqual(result.returncode, 0, result.stderr)
                plan = result.stdout
                self.assertIn(first_other, plan)
                self.assertLess(plan.index("intentd_tree_preflight.py"), plan.index(first_other))

    def test_only_a_nested_make_skips_an_already_checked_tree(self):
        self.move_off_pin()
        checked = {"INTENTD_TREE_CHECKED": "packages/intentd"}
        stray = self.run_make("fmt", env=checked)
        self.assertNotEqual(stray.returncode, 0)
        self.assertEqual(self.cargo_calls(), "")
        nested = self.run_make("fmt", env={**checked, "MAKELEVEL": "1"})
        self.assertEqual(nested.returncode, 0, nested.stderr)
        self.assertNotIn("testing intentd", nested.stdout)
        self.assertIn("fmt --check", self.cargo_calls())

    def test_apostrophe_in_a_chosen_intentd_dir_reaches_the_script(self):
        worktree = self.root.parent / "it's tree"
        self.git(self.intentd, "worktree", "add", "-q", "-b", "feature", str(worktree))
        result = self.run_make("fmt", f"INTENTD_DIR={worktree}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"[fmt] testing intentd: {worktree} feature@", result.stdout)


if __name__ == "__main__":
    unittest.main()
