#!/usr/bin/env python3
"""Bound the disk used by the Rust gates' intent-gates/<checkout-id> build trees.

`make test`, `test-changed`, `test-select` and `test-stress` build into a stable
`intent-gates/<sha256 of the checkout>` child of Cargo's target directory
(resumable_nextest.isolated_output_args). A gate holds a shared flock on that
directory from before its build until its tests and pruning finish, and stamps
the directory's mtime when it takes and releases the lock. Cargo never deletes
superseded outputs, so a tree only grows; on a shared host with many
worktrees, idle trees of 50-150 GB each filled the root filesystem (Oct 2026:
SQLITE_FULL in intentd). Every tree is regenerable cache: deleting one only
costs a rebuild, which sccache keeps cheap.

`reclaim()` deletes one tree and is the only deleting primitive. It holds the
tree's exclusive flock (so no gate of that checkout is between lock and
release), re-checks the idle stamp under that lock, takes every Cargo build lock
inside the tree, and refuses while any process executes, has open, or has its
working directory inside the tree. It renames the tree aside before deleting,
so a gate already waiting on the old directory sees a different inode and
starts a fresh tree instead of building into a deleted one (lock_shared).

Policies built on it:

* `before_build()` runs in every gate before Cargo starts. When the gate's own
  tree is larger than GATE_TREE_MAX_GB it is wiped (a long-lived checkout that
  alternates selections, profiles or lockfiles otherwise accumulates copies of
  every crate). When the filesystem has less than GATE_SWEEP_LOW_GB free, idle
  trees (other owners in the same intent-gates dir and sibling worktrees under
  WORKSPACES_DIR) are reclaimed oldest-first until GATE_SWEEP_GOAL_GB is free.
  GATE_SWEEP=0 disables both.
* `make sweep-gates` (this file's CLI) reclaims every tree idle longer than a
  cutoff, optionally stopping once a free-space goal is met; a cron or the
  daemon can run it with the same safety checks.

Only the target-directory tree carries the gate lock. A separately configured
Cargo build-dir tree is never deleted here.
"""
from __future__ import annotations

import argparse
import contextlib
import os
from pathlib import Path
import re
import shutil
import sys
import time
from typing import Callable, Iterable
import uuid

try:
    import fcntl
except ImportError:  # Windows: no flock, so never delete.
    fcntl = None

GIB = 1 << 30
TREE_RE = re.compile(r"^[0-9a-f]{64}$")
TRASH_RE = re.compile(r"^\.trash-(?P<pid>[0-9]+)-[0-9a-f]{8}$")
PARENT_NAME = "intent-gates"
# Worktree layouts under WORKSPACES_DIR (Intent uses <name>/intent; older ones <name>/monorepo).
WORKTREE_GLOBS = (f"*/intent/packages/intentd/target/{PARENT_NAME}",
                  f"*/monorepo/packages/intentd/target/{PARENT_NAME}")
DEFAULTS = {
    "GATE_SWEEP": "1",
    "GATE_SWEEP_LOW_GB": "150",
    "GATE_SWEEP_GOAL_GB": "300",
    "GATE_SWEEP_MIN_IDLE_MINUTES": "60",
    "GATE_TREE_MAX_GB": "60",
}
LOCK_ATTEMPTS = 5
# Cargo output dirs under <tree>/<profile> and <tree>/<triple>/<profile>.
ACTIVITY_GLOBS = ("*/deps", "*/.fingerprint", "*/*/deps", "*/*/.fingerprint")

Log = Callable[[str], None]


def is_tree(path: Path) -> bool:
    return (path.parent.name == PARENT_NAME and bool(TREE_RE.fullmatch(path.name))
            and path.is_dir() and not path.is_symlink())


def trees_in(parent: Path) -> list[Path]:
    try:
        return sorted(entry for entry in parent.iterdir() if is_tree(entry))
    except OSError:
        return []


def candidate_parents(workspaces_dir: Path | None, extra: Iterable[Path] = ()) -> list[Path]:
    """intent-gates dirs to consider: explicit ones plus every worktree's default target."""
    parents = [Path(path) for path in extra]
    if workspaces_dir is not None and workspaces_dir.is_dir():
        for pattern in WORKTREE_GLOBS:
            parents.extend(sorted(workspaces_dir.glob(pattern)))
    unique: dict[Path, Path] = {}
    for parent in parents:
        with contextlib.suppress(OSError):
            if parent.is_dir():
                unique.setdefault(parent.resolve(), parent.resolve())
    return list(unique.values())


def disk_usage(root: Path) -> int:
    """Allocated bytes under root (hard links counted once); 0 when unreadable."""
    seen: set[tuple[int, int]] = set()
    total = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if entry.is_dir(follow_symlinks=False):
                stack.append(Path(entry.path))
            if (info.st_dev, info.st_ino) in seen:
                continue
            seen.add((info.st_dev, info.st_ino))
            total += getattr(info, "st_blocks", 0) * 512 or info.st_size
    return total


def free_bytes(path: Path) -> int:
    """Free bytes on the filesystem holding path (or its nearest existing ancestor)."""
    for candidate in (path, *path.parents):
        with contextlib.suppress(OSError):
            stats = os.statvfs(candidate)
            return stats.f_bavail * stats.f_frsize
    raise OSError(f"no existing ancestor of {path}")


def device(path: Path) -> int | None:
    for candidate in (path, *path.parents):
        with contextlib.suppress(OSError):
            return candidate.stat().st_dev
    return None


def stamp(descriptor: int) -> None:
    """Record 'a gate used this tree now' on the locked directory itself."""
    with contextlib.suppress(OSError, NotImplementedError):
        os.utime(descriptor)


def lock_shared(root: Path) -> int | None:
    """Shared gate lock on root, retried if a sweep replaced the directory meanwhile.

    A sweep renames a tree aside while holding the exclusive lock. A gate that
    opened the old directory blocks, then wakes holding a lock on an inode no
    longer at `root`; verify the path still names the locked inode and start
    over on a fresh directory otherwise. None means no lock (Cargo still works).
    """
    if fcntl is None:
        return None
    for _ in range(LOCK_ATTEMPTS):
        try:
            root.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        except OSError:
            return None
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH)
            locked = os.fstat(descriptor)
            current = os.stat(root, follow_symlinks=False)
        except FileNotFoundError:
            os.close(descriptor)
            continue
        except OSError:
            os.close(descriptor)
            return None
        except BaseException:
            os.close(descriptor)
            raise
        if (locked.st_dev, locked.st_ino) == (current.st_dev, current.st_ino):
            stamp(descriptor)
            return descriptor
        os.close(descriptor)
    return None


def release(descriptor: int | None) -> None:
    if descriptor is None:
        return
    try:
        stamp(descriptor)
    finally:
        os.close(descriptor)


def busy(root: Path, ignore_pid: int | None = None) -> bool | None:
    """Whether any inspectable process executes, opens or sits in a path under root.

    None when this platform has no /proc to inspect: callers must then keep the tree.
    """
    proc = Path("/proc")
    if not (proc / "self" / "fd").is_dir():
        return None
    base = str(root.resolve())
    prefix = base.rstrip(os.sep) + os.sep
    skip = str(os.getpid() if ignore_pid is None else ignore_pid)
    for pid in proc.iterdir():
        if not pid.name.isdigit() or pid.name == skip:
            continue
        links = [pid / "exe", pid / "cwd"]
        with contextlib.suppress(OSError):
            links.extend((pid / "fd").iterdir())
        for link in links:
            with contextlib.suppress(OSError):
                target = os.readlink(link).removesuffix(" (deleted)")
                if target == base or target.startswith(prefix):
                    return True
    return False


def cargo_locks(root: Path) -> list[Path]:
    """Cargo's per-profile build locks (target/<profile>, target/<triple>/<profile>)."""
    found: list[Path] = []
    for pattern in ("*/.cargo*lock", "*/*/.cargo*lock"):
        with contextlib.suppress(OSError):
            found.extend(path for path in root.glob(pattern) if path.is_file())
    return sorted(found)


def reclaim(root: Path, *, idle_before: float, dry_run: bool = False) -> tuple[int | None, str]:
    """Delete one idle gate tree; return (bytes freed or that would be, reason).

    A None size means the tree was kept; the reason says why.
    """
    if fcntl is None:
        return None, "kept: no flock on this platform"
    if not is_tree(root):
        return None, "kept: not an intent-gates/<checkout-id> directory"
    try:
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as error:
        return None, f"kept: cannot open ({error.strerror})"
    trash = None
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return None, "kept: a gate is using it"
        locked = os.fstat(descriptor)
        try:
            current = os.stat(root, follow_symlinks=False)
        except FileNotFoundError:
            return None, "kept: already removed"
        if (locked.st_dev, locked.st_ino) != (current.st_dev, current.st_ino):
            return None, "kept: replaced while locking"
        if max(locked.st_mtime, last_used(root)) >= idle_before:
            return None, "kept: used recently"
        with contextlib.ExitStack() as stack:
            for lock in cargo_locks(root):
                try:
                    handle = stack.enter_context(lock.open("rb"))
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return None, "kept: Cargo is building in it"
                except OSError:
                    continue
            state = busy(root)
            if state is None:
                return None, "kept: cannot check which files are open"
            if state:
                return None, "kept: a process is using files in it"
            size = disk_usage(root)
            if dry_run:
                return size, "would delete"
            trash = root.with_name(f".trash-{os.getpid()}-{uuid.uuid4().hex[:8]}")
            os.rename(root, trash)
    finally:
        os.close(descriptor)
    shutil.rmtree(trash, ignore_errors=True)
    return size, "deleted"


def purge_trash(parent: Path) -> int:
    """Finish deleting trees an interrupted sweep renamed aside (owner process gone)."""
    freed = 0
    try:
        entries = list(parent.iterdir())
    except OSError:
        return 0
    for entry in entries:
        match = TRASH_RE.fullmatch(entry.name)
        if not match or entry.is_symlink() or not entry.is_dir():
            continue
        try:
            os.kill(int(match["pid"]), 0)
            continue
        except ProcessLookupError:
            pass
        except (PermissionError, OverflowError):
            continue
        freed += disk_usage(entry)
        shutil.rmtree(entry, ignore_errors=True)
    return freed


def last_used(tree: Path) -> float:
    """Latest of the gate stamp and Cargo's output directories' mtimes.

    Gates stamp the tree directory itself; Cargo adds entries to deps/ and
    .fingerprint/ whenever it writes new outputs, which also covers trees
    built by runners that predate the stamp. inf when the tree is unreadable.
    """
    try:
        latest = tree.stat().st_mtime
    except OSError:
        return float("inf")
    for pattern in ACTIVITY_GLOBS:
        with contextlib.suppress(OSError):
            for path in tree.glob(pattern):
                with contextlib.suppress(OSError):
                    latest = max(latest, path.stat().st_mtime)
    return latest


def sweep(parents: Iterable[Path], *, idle_seconds: float, goal_free: int | None = None,
          goal_path: Path | None = None, exclude: Iterable[Path] = (), dry_run: bool = False,
          log: Log = print, now: float | None = None) -> int:
    """Reclaim idle trees oldest-first; return bytes freed (or that would be).

    With goal_free, only trees on goal_path's filesystem count and the sweep
    stops as soon as that filesystem has goal_free bytes available.
    """
    cutoff = (time.time() if now is None else now) - idle_seconds
    excluded = {Path(path).resolve() for path in exclude}
    parents = list(parents)
    freed = 0
    for parent in parents:
        if not dry_run:
            freed += purge_trash(parent)
    goal_device = device(goal_path) if goal_path is not None else None
    trees = sorted((last_used(tree), tree) for parent in parents for tree in trees_in(parent)
                   if tree.resolve() not in excluded)
    for used, tree in trees:
        if used >= cutoff:
            break
        if goal_free is not None and goal_path is not None:
            if goal_device is not None and device(tree) != goal_device:
                continue
            if free_bytes(goal_path) + (freed if dry_run else 0) >= goal_free:
                break
        size, reason = reclaim(tree, idle_before=cutoff, dry_run=dry_run)
        idle_hours = (time.time() - used) / 3600
        shown = f"{size / GIB:.1f} GiB" if size is not None else "-"
        log(f"{reason}: {tree} (idle {idle_hours:.1f} h, {shown})")
        if size is not None:
            freed += size
    return freed


def setting(env: dict[str, str], name: str) -> float:
    value = env.get(name, "").strip() or DEFAULTS[name]
    try:
        number = float(value)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {value!r}") from None
    if number < 0:
        raise ValueError(f"{name} must not be negative, got {value!r}")
    return number


def before_build(roots: list[Path], label: str, env: dict[str, str] | None = None,
                 log: Log | None = None) -> None:
    """Storage policy a gate applies after resolving its outputs, before Cargo builds.

    roots are the gate-owned intent-gates/<checkout-id> output roots, target
    directory first. Best effort: a failure here never fails the gate.
    """
    env = os.environ if env is None else env
    log = log or (lambda message: print(f"[{label}] {message}", flush=True))
    if env.get("GATE_SWEEP", DEFAULTS["GATE_SWEEP"]) == "0" or fcntl is None or not roots:
        return
    try:
        own = roots[0]
        cap = setting(env, "GATE_TREE_MAX_GB") * GIB
        # A separate build-dir root is not covered by the gate lock; leave it alone.
        if cap and len(roots) == 1 and is_tree(own):
            size = disk_usage(own)
            if size > cap:
                log(f"gate build tree is {size / GIB:.1f} GiB, over GATE_TREE_MAX_GB="
                    f"{cap / GIB:g}; deleting it for a fresh build")
                freed, reason = reclaim(own, idle_before=float("inf"))
                log(f"{reason}: {own}" if freed is None else f"deleted {own}, {freed / GIB:.1f} GiB freed")
        low = setting(env, "GATE_SWEEP_LOW_GB") * GIB
        goal = max(setting(env, "GATE_SWEEP_GOAL_GB") * GIB, low)
        available = free_bytes(own.parent)
        if available >= low:
            return
        log(f"low disk: {available / GIB:.0f} GiB free < GATE_SWEEP_LOW_GB={low / GIB:g}; "
            f"reclaiming idle gate build trees until {goal / GIB:g} GiB are free")
        workspaces = env.get("WORKSPACES_DIR")
        parents = candidate_parents(Path(workspaces) if workspaces else None, [own.parent])
        freed = sweep(parents, idle_seconds=setting(env, "GATE_SWEEP_MIN_IDLE_MINUTES") * 60,
                      goal_free=int(goal), goal_path=own.parent, exclude=[own], log=log)
        log(f"low disk: reclaimed {freed / GIB:.1f} GiB; {free_bytes(own.parent) / GIB:.0f} GiB free")
    except (OSError, ValueError) as error:
        log(f"warning: gate storage policy skipped: {error}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Delete idle Rust gate build trees (intent-gates/<checkout-id>).")
    parser.add_argument("--workspaces-dir", type=Path,
                        help="also scan <dir>/*/{intent,monorepo}/packages/intentd/target/intent-gates")
    parser.add_argument("--parent", type=Path, action="append", default=[],
                        help="an intent-gates directory to scan (repeatable)")
    parser.add_argument("--idle-hours", type=float, default=24.0,
                        help="only delete trees no gate has used for this long (default 24)")
    parser.add_argument("--free-gb", type=float,
                        help="stop once the first scanned filesystem has this many GiB free")
    parser.add_argument("--dry-run", action="store_true", help="list what would be deleted")
    args = parser.parse_args(argv)
    if args.idle_hours < 0 or (args.free_gb is not None and args.free_gb < 0):
        parser.error("--idle-hours and --free-gb must not be negative")
    parents = candidate_parents(args.workspaces_dir, args.parent)
    if not parents:
        print("[sweep-gates] no intent-gates directories found")
        return 0
    goal_path = parents[0] if args.free_gb is not None else None
    goal = int(args.free_gb * GIB) if args.free_gb is not None else None
    freed = sweep(parents, idle_seconds=args.idle_hours * 3600, goal_free=goal, goal_path=goal_path,
                  dry_run=args.dry_run, log=lambda message: print(f"[sweep-gates] {message}", flush=True))
    verb = "would free" if args.dry_run else "freed"
    print(f"[sweep-gates] {verb} {freed / GIB:.1f} GiB across {len(parents)} intent-gates dir(s)"
          f"; {free_bytes(parents[0]) / GIB:.0f} GiB free", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
