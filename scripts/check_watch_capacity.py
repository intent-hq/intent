#!/usr/bin/env python3
"""Check current Linux watcher allocation without changing or reserving host capacity."""

import argparse
import ctypes
import errno
import os
from pathlib import Path
import sys


def limits() -> str:
    values = []
    for name in ("max_user_instances", "max_user_watches"):
        try:
            value = (Path("/proc/sys/fs/inotify") / name).read_text().strip()
        except OSError:
            value = "unavailable"
        values.append(f"fs.inotify.{name}={value}")
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        values.append(f"RLIMIT_NOFILE soft={soft} hard={hard}")
    except (ImportError, OSError, ValueError):
        values.append("RLIMIT_NOFILE unavailable")
    return "; ".join(values)


def check() -> str:
    if sys.platform != "linux":
        return "Linux inotify allocation: not applicable on this platform"
    try:
        native = ctypes.CDLL(None, use_errno=True)
        allocate = native.inotify_init1
        allocate.argtypes = [ctypes.c_int]
        allocate.restype = ctypes.c_int
        ctypes.set_errno(0)
        descriptor = allocate(os.O_CLOEXEC)
        if descriptor < 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        # A successful probe owns exactly one descriptor, including fd 0.
        os.close(descriptor)
    except (OSError, AttributeError) as error:
        code = getattr(error, "errno", None)
        label = errno.errorcode.get(code, "unknown error")
        raise RuntimeError(
            f"Linux inotify allocation/close failed: {label} (errno {code}): {error}; "
            f"{limits()}. EMFILE can mean the process descriptor limit or the "
            "same-user inotify instance limit; this probe does not distinguish them. "
            "Inspect process descriptors and same-user watcher usage before adjusting "
            "limits; see docs/ARCHITECTURE.md#file-watching-shared-os-watchers--linux-host-limits. "
            "Re-run make doctor after recovery. No host settings were changed."
        ) from error
    return "Linux inotify allocation: one instance opened and closed (capacity is not reserved)"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="only print failures")
    args = parser.parse_args()
    try:
        message = check()
    except RuntimeError as error:
        print(f"[missing]  {error}", file=sys.stderr)
        return 1
    if not args.quiet:
        print(f"[ok]       {message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
