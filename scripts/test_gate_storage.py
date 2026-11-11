"""Gate build-tree storage policy: safe idle reclaim, low-disk sweep and size cap."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from scripts import gate_storage as storage
from scripts import resumable_nextest as gate

GIB = storage.GIB
OLD = time.time() - 7 * 24 * 3600
HAS_PROC = Path("/proc/self/fd").is_dir()


@unittest.skipIf(storage.fcntl is None, "gate trees are never deleted without flock")
class GateStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gate storage ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.parent = self.root / "ws" / "a" / "intent/packages/intentd/target/intent-gates"
        self.logs: list[str] = []

    def tree(self, name="a", parent=None, size=1 << 20, mtime=OLD):
        root = (parent or self.parent) / (name * 64)[:64]
        deps = root / "debug" / "deps"
        deps.mkdir(parents=True)
        (deps / "suite-0123456789abcdef").write_bytes(b"x" * size)
        (root / "debug" / ".cargo-lock").touch()
        for path in (deps, root):
            os.utime(path, (mtime, mtime))
        return root

    def log(self, message):
        self.logs.append(message)

    def test_reclaims_an_idle_tree_without_leaving_trash(self):
        root = self.tree()
        size, reason = storage.reclaim(root, idle_before=time.time() - 3600)
        self.assertEqual(reason, "deleted")
        self.assertGreaterEqual(size, 1 << 20)
        self.assertFalse(root.exists())
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_cargo_output_activity_counts_as_use_for_unstamped_trees(self):
        root = self.tree()
        (root / "debug" / "deps" / "fresh-0123456789abcdef").touch()
        self.assertGreater(storage.last_used(root), time.time() - 60)
        self.assertEqual(storage.reclaim(root, idle_before=time.time() - 3600),
                         (None, "kept: used recently"))
        self.assertTrue(root.is_dir())

    def test_dry_run_reports_without_deleting(self):
        root = self.tree()
        size, reason = storage.reclaim(root, idle_before=time.time(), dry_run=True)
        self.assertEqual(reason, "would delete")
        self.assertGreaterEqual(size, 1 << 20)
        self.assertTrue(root.is_dir())

    def test_active_gate_lock_keeps_the_tree_and_release_restarts_idle_time(self):
        root = self.tree()
        lock = storage.lock_shared(root)
        self.assertIsNotNone(lock)
        try:
            self.assertEqual(storage.reclaim(root, idle_before=float("inf")),
                             (None, "kept: a gate is using it"))
        finally:
            storage.release(lock)
        self.assertGreater(root.stat().st_mtime, time.time() - 60)
        self.assertEqual(storage.reclaim(root, idle_before=time.time() - 3600),
                         (None, "kept: used recently"))
        self.assertTrue(root.is_dir())

    def test_runner_gate_lock_uses_the_same_protocol(self):
        root = self.tree()
        output_args = ["--target-dir", str(root), "--config", f'build.build-dir="{root}"']
        lock = gate.acquire_gate_lock(output_args)
        try:
            self.assertGreater(root.stat().st_mtime, time.time() - 60, "acquire stamps the tree")
            self.assertEqual(storage.reclaim(root, idle_before=float("inf"))[1], "kept: a gate is using it")
        finally:
            gate.release_gate_lock(lock)

    def test_runner_gate_lock_covers_a_separate_build_dir_tree(self):
        target = self.tree("a")
        build = self.tree("b", parent=self.root / "build/intent-gates")
        output_args = ["--target-dir", str(target), "--config", f'build.build-dir="{build}"']
        lock = gate.acquire_gate_lock(output_args)
        try:
            for root in (target, build):
                self.assertEqual(storage.reclaim(root, idle_before=float("inf")),
                                 (None, "kept: a gate is using it"), root)
        finally:
            gate.release_gate_lock(lock)
        self.assertEqual(storage.reclaim(build, idle_before=time.time() - 3600),
                         (None, "kept: used recently"), "release restamps the build tree too")
        self.assertTrue(target.is_dir() and build.is_dir())

    def test_held_cargo_build_lock_keeps_the_tree(self):
        root = self.tree()
        with (root / "debug" / ".cargo-lock").open("rb") as handle:
            storage.fcntl.flock(handle, storage.fcntl.LOCK_EX)
            self.assertEqual(storage.reclaim(root, idle_before=time.time()),
                             (None, "kept: Cargo is building in it"))
        self.assertTrue(root.is_dir())

    @unittest.skipUnless(HAS_PROC, "needs /proc")
    def test_processes_using_the_tree_keep_it(self):
        root = self.tree()
        target = root / "debug" / "deps" / "suite-0123456789abcdef"
        for name, kwargs in (
            ("cwd", {"cwd": root / "debug"}),
            ("open file", {"args": [sys.executable, "-c",
                                    f"import sys,time; f=open({str(target)!r}); print(1, flush=True); time.sleep(60)"]}),
        ):
            with self.subTest(name):
                args = kwargs.pop("args", [sys.executable, "-c", "import time; print(1, flush=True); time.sleep(60)"])
                child = subprocess.Popen(args, stdout=subprocess.PIPE, **kwargs)
                try:
                    child.stdout.readline()
                    self.assertTrue(storage.busy(root))
                    self.assertEqual(storage.reclaim(root, idle_before=time.time()),
                                     (None, "kept: a process is using files in it"))
                finally:
                    child.kill()
                    child.wait()
                    child.stdout.close()
        self.assertFalse(storage.busy(root))

    def test_unknown_open_files_keep_the_tree(self):
        root = self.tree()
        with mock.patch.object(storage, "busy", return_value=None):
            self.assertEqual(storage.reclaim(root, idle_before=time.time()),
                             (None, "kept: cannot check which files are open"))

    def test_gate_waiting_on_a_reclaimed_tree_starts_a_fresh_one(self):
        root = self.tree()
        old_inode = root.stat().st_ino
        real_flock = storage.fcntl.flock
        calls = []

        def sweep_wins(descriptor, operation):
            # The sweep renames the tree between the gate's open() and flock().
            if not calls:
                root.rename(root.with_name(".trash-1-deadbeef"))
            calls.append(operation)
            return real_flock(descriptor, operation)

        with mock.patch.object(storage.fcntl, "flock", side_effect=sweep_wins):
            lock = storage.lock_shared(root)
        try:
            self.assertIsNotNone(lock)
            self.assertEqual(len(calls), 2, "the gate must retry on the replacement directory")
            self.assertEqual(os.fstat(lock).st_ino, root.stat().st_ino)
            self.assertNotEqual(root.stat().st_ino, old_inode)
        finally:
            storage.release(lock)

    def test_non_tree_paths_are_never_deleted(self):
        other = self.parent / "not-a-checkout-id"
        other.mkdir(parents=True)
        self.assertIsNone(storage.reclaim(other, idle_before=float("inf"))[0])
        stray = self.root / ("b" * 64)
        stray.mkdir()
        self.assertIsNone(storage.reclaim(stray, idle_before=float("inf"))[0])
        self.assertTrue(other.is_dir() and stray.is_dir())

    def test_sweep_deletes_oldest_idle_trees_until_the_goal(self):
        now = time.time()
        oldest = self.tree("a", mtime=now - 30 * 3600)
        middle = self.tree("b", mtime=now - 20 * 3600)
        recent = self.tree("c", mtime=now - 60)
        excluded = self.tree("d", mtime=now - 40 * 3600)
        free = iter([10 * GIB, 400 * GIB])
        with mock.patch.object(storage, "free_bytes", side_effect=lambda _p: next(free)):
            freed = storage.sweep([self.parent], idle_seconds=3600, goal_free=300 * GIB,
                                  goal_path=self.parent, exclude=[excluded], log=self.log, now=now)
        self.assertGreater(freed, 0)
        self.assertFalse(oldest.exists())
        self.assertTrue(middle.is_dir() and recent.is_dir() and excluded.is_dir())
        self.assertEqual(len(self.logs), 1, self.logs)
        self.assertIn("deleted", self.logs[0])

    def test_sweep_without_goal_deletes_every_tree_past_the_cutoff(self):
        now = time.time()
        stale = [self.tree(name, mtime=now - 48 * 3600) for name in "ab"]
        fresh = self.tree("c", mtime=now - 3600)
        storage.sweep([self.parent], idle_seconds=24 * 3600, log=self.log, now=now)
        self.assertTrue(all(not tree.exists() for tree in stale))
        self.assertTrue(fresh.is_dir())

    def test_interrupted_sweep_trash_is_purged_only_when_its_owner_is_gone(self):
        self.parent.mkdir(parents=True)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        orphan = self.parent / f".trash-{dead.pid}-0123abcd"
        live = self.parent / f".trash-{os.getpid()}-0123abcd"
        for path in (orphan, live):
            (path / "debug").mkdir(parents=True)
        storage.sweep([self.parent], idle_seconds=0, log=self.log)
        self.assertFalse(orphan.exists())
        self.assertTrue(live.is_dir())

    def test_candidate_parents_cover_both_worktree_layouts(self):
        workspaces = self.root / "ws"
        intent = self.tree("a")
        legacy = self.tree("b", parent=workspaces / "b/monorepo/packages/intentd/target/intent-gates")
        extra = self.root / "shared" / "intent-gates"
        extra.mkdir(parents=True)
        parents = storage.candidate_parents(workspaces, [extra, extra])
        self.assertEqual(parents, [extra.resolve(), intent.parent.resolve(), legacy.parent.resolve()])
        self.assertEqual(storage.candidate_parents(self.root / "missing"), [])

    def test_disk_usage_counts_hard_links_once(self):
        root = self.tree(size=1 << 20)
        single = storage.disk_usage(root)
        os.link(root / "debug/deps/suite-0123456789abcdef", root / "debug/suite")
        self.assertEqual(storage.disk_usage(root), single)

    def test_before_build_wipes_an_oversized_own_tree(self):
        own = self.tree(size=2 << 20)
        storage.before_build([own], "test", {"GATE_TREE_MAX_GB": str(1 / 1024), "GATE_SWEEP_LOW_GB": "0"},
                             log=self.log)
        self.assertFalse(own.exists())
        self.assertIn("over GATE_TREE_MAX_GB", self.logs[0])
        small = self.tree("b", size=1024)
        storage.before_build([small], "test", {"GATE_TREE_MAX_GB": str(1 / 1024), "GATE_SWEEP_LOW_GB": "0"},
                             log=self.log)
        self.assertTrue(small.is_dir())

    def test_before_build_leaves_a_separate_build_dir_layout_alone(self):
        own = self.tree(size=2 << 20)
        build = self.tree("b", parent=self.root / "build/intent-gates", size=2 << 20)
        storage.before_build([own, build], "test", {"GATE_TREE_MAX_GB": str(1 / 1024), "GATE_SWEEP_LOW_GB": "0"},
                             log=self.log)
        self.assertTrue(own.is_dir() and build.is_dir())

    def test_before_build_sweeps_idle_siblings_only_when_disk_is_low(self):
        workspaces = self.root / "ws"
        own = self.tree("a", mtime=OLD)
        sibling = self.tree("b", parent=workspaces / "b/intent/packages/intentd/target/intent-gates")
        env = {"WORKSPACES_DIR": str(workspaces), "GATE_SWEEP_LOW_GB": "150", "GATE_SWEEP_GOAL_GB": "300"}
        with mock.patch.object(storage, "free_bytes", return_value=500 * GIB):
            storage.before_build([own], "test", env, log=self.log)
        self.assertTrue(sibling.is_dir())
        self.assertEqual(self.logs, [])
        free = iter([100 * GIB, 100 * GIB, 350 * GIB])
        with mock.patch.object(storage, "free_bytes", side_effect=lambda _p: next(free)):
            storage.before_build([own], "test", env, log=self.log)
        self.assertFalse(sibling.exists())
        self.assertTrue(own.is_dir(), "a gate never sweeps its own tree for space")
        self.assertIn("low disk", self.logs[0])

    def test_before_build_can_be_disabled_and_never_raises(self):
        own = self.tree(size=2 << 20)
        storage.before_build([own], "test", {"GATE_SWEEP": "0", "GATE_TREE_MAX_GB": str(1 / 1024)}, log=self.log)
        self.assertTrue(own.is_dir())
        storage.before_build([own], "test", {"GATE_TREE_MAX_GB": "lots"}, log=self.log)
        self.assertTrue(own.is_dir())
        self.assertIn("GATE_TREE_MAX_GB must be a number", self.logs[-1])

    def test_cli_dry_run_lists_and_keeps(self):
        stale = self.tree("a")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(storage.main(["--parent", str(self.parent), "--idle-hours", "1", "--dry-run"]), 0)
        self.assertIn("would delete", out.getvalue())
        self.assertIn("would free", out.getvalue())
        self.assertTrue(stale.is_dir())
        with contextlib.redirect_stdout(io.StringIO()):
            storage.main(["--workspaces-dir", str(self.root / "ws"), "--idle-hours", "1"])
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
