"""Watcher readiness and real doctor/Make entry points, without exhausting the host."""

import contextlib
import errno
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "scripts/check_watch_capacity.py"


class WatchProbeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("watch_capacity", PROBE)
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)

    def test_success_closes_the_actual_descriptor(self):
        reader, writer = os.pipe()
        self.addCleanup(os.close, writer)
        native = mock.Mock()
        native.inotify_init1.return_value = reader
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(
            self.probe.ctypes, "CDLL", return_value=native
        ):
            self.assertIn("opened and closed", self.probe.check())
        with self.assertRaises(OSError) as caught:
            os.fstat(reader)
        self.assertEqual(caught.exception.errno, errno.EBADF)
        native.inotify_init1.assert_called_once_with(os.O_CLOEXEC)

    def test_descriptor_zero_is_owned_and_closed(self):
        native = mock.Mock()
        native.inotify_init1.return_value = 0
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(
            self.probe.ctypes, "CDLL", return_value=native
        ), mock.patch.object(self.probe.os, "close") as close:
            self.probe.check()
        close.assert_called_once_with(0)

    def test_allocation_failures_preserve_errno_and_do_not_close(self):
        for code in (errno.EMFILE, errno.ENFILE, errno.ENOMEM, errno.EACCES):
            with self.subTest(code=code):
                native = mock.Mock()
                native.inotify_init1.return_value = -1
                with mock.patch.object(sys, "platform", "linux"), mock.patch.object(
                    self.probe.ctypes, "CDLL", return_value=native
                ), mock.patch.object(self.probe.ctypes, "get_errno", return_value=code), \
                     mock.patch.object(self.probe.os, "close") as close:
                    with self.assertRaises(RuntimeError) as caught:
                        self.probe.check()
                message = str(caught.exception)
                self.assertIn(errno.errorcode[code], message)
                self.assertIn(f"errno {code}", message)
                self.assertIn("fs.inotify.max_user_instances=", message)
                self.assertIn("fs.inotify.max_user_watches=", message)
                self.assertIn("RLIMIT_NOFILE", message)
                self.assertIn("does not distinguish", message)
                close.assert_not_called()

    def test_missing_proc_limits_do_not_hide_allocation_error(self):
        native = mock.Mock()
        native.inotify_init1.return_value = -1
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(
            self.probe.ctypes, "CDLL", return_value=native
        ), mock.patch.object(self.probe.ctypes, "get_errno", return_value=errno.EMFILE), \
             mock.patch.object(Path, "read_text", side_effect=PermissionError):
            with self.assertRaisesRegex(RuntimeError, "EMFILE.*max_user_instances=unavailable"):
                self.probe.check()

    def test_non_linux_does_not_load_libc_or_read_proc(self):
        for platform in ("darwin", "win32"):
            with self.subTest(platform=platform), mock.patch.object(sys, "platform", platform), \
                 mock.patch.object(self.probe.ctypes, "CDLL") as library, \
                 mock.patch.object(Path, "read_text") as read:
                self.assertIn("not applicable", self.probe.check())
                library.assert_not_called()
                read.assert_not_called()

    def test_cli_keeps_failures_visible_in_quiet_mode(self):
        for quiet in (False, True):
            with self.subTest(quiet=quiet), mock.patch.object(
                sys, "argv", [str(PROBE)] + (["--quiet"] if quiet else [])
            ), mock.patch.object(self.probe, "check", side_effect=RuntimeError("EMFILE")), \
                 contextlib.redirect_stderr(io.StringIO()) as output:
                self.assertEqual(self.probe.main(), 1)
                self.assertIn("[missing]", output.getvalue())

    def test_close_failure_cannot_report_ready(self):
        native = mock.Mock()
        native.inotify_init1.return_value = 42
        with mock.patch.object(sys, "platform", "linux"), mock.patch.object(
            self.probe.ctypes, "CDLL", return_value=native
        ), mock.patch.object(self.probe.os, "close", side_effect=OSError(errno.EBADF, "bad fd")):
            with self.assertRaisesRegex(RuntimeError, "EBADF"):
                self.probe.check()


class WatchEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="intent-watch-preflight-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ("bootstrap-dev-host.sh", "check_watch_capacity.py"):
            source = ROOT / "scripts" / name
            if source.exists():
                shutil.copy(source, scripts / name)
        shutil.copy(ROOT / "Makefile", self.root / "Makefile")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.started = self.root / "heavy-started"
        for component in ("intentd", "cloudlands-fe"):
            path = self.root / "packages" / component
            path.mkdir(parents=True)
            (path / ".git").touch()
        component_scripts = self.root / "packages/intentd/scripts"
        component_scripts.mkdir()
        marker = '#!/bin/sh\necho started >> "$WATCH_TEST_STARTED"\nexit 19\n'
        for name in ("changed-tests.sh", "coverage-all.sh", "coverage-e2e.sh"):
            path = component_scripts / name
            path.write_text(marker)
            path.chmod(0o755)
        self.launcher("cargo", marker)
        self.launcher("rustup", "#!/bin/sh\nexit 1\n")
        # Patch libc only inside this child; no host allocations or limits change.
        self.launcher("python3", f'''#!{sys.executable}
import ctypes, errno, os, runpy, sys
from pathlib import Path
from unittest import mock
if len(sys.argv) > 1 and Path(sys.argv[1]).name == "check_watch_capacity.py":
    sys.argv = sys.argv[1:]
    code = int(os.environ.get("WATCH_TEST_ERRNO", errno.EMFILE))
    native = mock.Mock()
    native.inotify_init1.return_value = -1 if code else os.open(os.devnull, os.O_RDONLY)
    with mock.patch("sys.platform", "linux"), mock.patch("ctypes.CDLL", return_value=native), mock.patch("ctypes.get_errno", return_value=code):
        runpy.run_path(sys.argv[0], run_name="__main__")
elif sys.argv[1:] == ["--version"]:
    print("Python 3.11.0")
else:
    Path(os.environ["WATCH_TEST_STARTED"]).write_text("python work started")
    sys.exit(19)
''')
        self.env = {k: v for k, v in os.environ.items()
                    if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "PYTHONPATH",
                                 "LD_PRELOAD", "INTENTD_DIR", "FE_DIR"}}
        self.env.update(PATH=f"{self.bin}:{os.environ['PATH']}",
                        WATCH_TEST_STARTED=str(self.started),
                        CARGO_HOME=str(self.root / "cargo"),
                        DEV_STATUS_SKIP_GITHUB="1")
        self.env.pop("WATCH_TEST_ERRNO", None)

    def launcher(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_make(self, target, *args):
        return subprocess.run(
            ["make", "--no-print-directory", target,
             f"CARGO_BIN_DIR={self.bin}", *args],
            cwd=self.root, env=self.env, text=True, capture_output=True, timeout=20,
        )

    def test_doctor_reports_unavailable_watcher(self):
        result = subprocess.run(
            ["bash", "scripts/bootstrap-dev-host.sh", "--check"],
            cwd=self.root, env=self.env, text=True, capture_output=True, timeout=20,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inotify", result.stdout + result.stderr)
        # Workspace status parses stdout for [missing] rows, not stderr.
        self.assertIn("[missing]", result.stdout)
        self.assertIn("EMFILE", result.stdout)

    def test_test_entries_refuse_before_cargo_or_test_work(self):
        for target in ("gate", "test", "test-intentd", "test-changed",
                       "coverage-changed", "coverage-all", "coverage-e2e"):
            with self.subTest(target=target):
                self.started.unlink(missing_ok=True)
                # gate retains its check prerequisite; isolate the Rust test entry.
                result = self.run_make(target, "-j2", *(["-o", "check"] if target == "gate" else []))
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.started.exists(), result.stdout + result.stderr)
                self.assertIn("EMFILE", result.stdout + result.stderr)

    def test_changed_test_dry_runs_do_not_require_a_watcher(self):
        for target in ("test-changed", "coverage-changed"):
            with self.subTest(target=target):
                result = self.run_make(target, "DRY_RUN=1")
                self.assertNotIn("EMFILE", result.stdout + result.stderr)
                self.assertTrue(self.started.exists())
                self.started.unlink()

    def test_success_allows_the_test_entry_to_continue(self):
        self.env["WATCH_TEST_ERRNO"] = "0"
        for target in ("test", "test-changed", "coverage-changed", "coverage-all", "coverage-e2e"):
            with self.subTest(target=target):
                self.started.unlink(missing_ok=True)
                result = self.run_make(target)
                # Only the downstream stand-in fails; the preflight lets it run.
                self.assertTrue(self.started.exists(), result.stdout + result.stderr)
                self.assertNotIn("[missing]", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
