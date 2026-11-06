#!/usr/bin/env python3
"""Name the intentd tree a local Rust gate tests, and refuse a stale default one.

Every Rust gate target (fmt, shear, clippy, lint-sources, check-windows,
check-macos, test, test-changed, test-select, test-stress, coverage-*) runs this
first. It prints

    [<goal>] testing intentd: <path> <branch>@<sha> (<pin state>, <lag>)

and exits 1, naming the fix, when the caller did not choose the tree and the
default packages/intentd checkout is off the monorepo pin (neither the pin nor
a branch built on it) or lags its origin/main by more than --behind-limit
commits. Gates used to test a shared
packages/intentd left on another branch or weeks behind, so implementors
chased failures that were not theirs.

The caller chose the tree when INTENTD_DIR came from the make command line
(--origin is not "file") or make was started from inside that tree (the
packages/intentd forwarder Makefile, --caller-cwd). Under DRY_RUN the refusal
is a warning. Missing git or a non-git directory leave the state unknown, and
a missing origin/main ref leaves the lag unknown; neither unknown refuses.
--checked skips a recursive make (gate -> test, --make-level above 0) whose
parent already checked the same tree.
"""

import argparse
import os
import subprocess
import sys

DEFAULT_RELATIVE = os.path.join("packages", "intentd")


def git(path, *args):
    env = dict(os.environ)
    # Never let a non-repository fixture resolve to an enclosing checkout.
    env["GIT_CEILING_DIRECTORIES"] = os.path.dirname(path)
    try:
        result = subprocess.run(["git", "-C", path, *args], env=env, text=True,
                                capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def inside(child, parent):
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def truthy(value):
    return bool(value) and value != "0"


def tree_state(tree):
    if git(tree, "rev-parse", "--show-toplevel") != tree:
        return None
    head = git(tree, "rev-parse", "--verify", "HEAD")
    if head is None:
        return None
    lag = git(tree, "rev-list", "--count", "HEAD..refs/remotes/origin/main")
    return {
        "head": head,
        "branch": git(tree, "branch", "--show-current") or "(detached)",
        "dirty": bool(git(tree, "status", "--porcelain", "--untracked-files=no")),
        "behind": int(lag) if lag and lag.isdigit() else None,
    }


def recorded_pin(root, relative):
    entry = git(root, "ls-tree", "HEAD", "--", relative)
    fields = entry.split(None, 3) if entry else []
    return fields[2] if len(fields) >= 3 and fields[0] == "160000" else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--intentd-dir", required=True)
    parser.add_argument("--origin", default="file", help="$(origin INTENTD_DIR)")
    parser.add_argument("--caller-cwd", default="")
    parser.add_argument("--label", default="make")
    parser.add_argument("--behind-limit", default="250")
    parser.add_argument("--dry-run", default="")
    parser.add_argument("--checked", default="")
    parser.add_argument("--make-level", default="0")
    args = parser.parse_args(argv)
    try:
        limit = int(args.behind_limit)
    except ValueError:
        print(f"[{args.label}] INTENTD_BEHIND_LIMIT must be a whole number, got {args.behind_limit!r}",
              file=sys.stderr)
        return 2

    root = os.path.realpath(args.repo_root)
    tree = os.path.realpath(os.path.join(root, args.intentd_dir))
    nested = args.make_level.isdigit() and int(args.make_level) > 0
    if nested and args.checked and os.path.realpath(os.path.join(root, args.checked)) == tree:
        return 0

    default_tree = os.path.realpath(os.path.join(root, DEFAULT_RELATIVE))
    from_command_line = args.origin not in ("file", "default", "undefined")
    caller = os.path.realpath(args.caller_cwd) if args.caller_cwd else ""
    chosen = from_command_line or (caller and inside(caller, tree))
    tag = f"[{args.label}]"

    state = tree_state(tree)
    if state is None:
        print(f"{tag} testing intentd: {tree} (not a git checkout; branch and pin unknown)")
        return 0

    pin = recorded_pin(root, DEFAULT_RELATIVE) if tree == default_tree else None
    notes = []
    if tree == default_tree:
        if pin is None:
            notes.append("no recorded pin")
        elif pin == state["head"]:
            notes.append("at the monorepo pin")
        elif git(tree, "merge-base", "--is-ancestor", pin, "HEAD") is not None:
            on_top = git(tree, "rev-list", "--count", f"{pin}..HEAD")
            notes.append(f"{on_top} commits on top of the monorepo pin")
        else:
            notes.append(f"off the monorepo pin {pin[:12]}")
    if state["behind"] is not None:
        notes.append(f"{state['behind']} behind origin/main")
    if state["dirty"]:
        notes.append("uncommitted changes")
    if from_command_line:
        notes.append("INTENTD_DIR from the command line")
    elif chosen:
        notes.append("make started inside it")
    print(f"{tag} testing intentd: {tree} {state['branch']}@{state['head'][:12]}"
          + (f" ({', '.join(notes)})" if notes else ""))

    if chosen or tree != default_tree:
        return 0
    off_pin = pin is not None and notes[0].startswith("off the monorepo pin")
    stale = state["behind"] is not None and state["behind"] > limit
    if not (off_pin or stale):
        return 0

    goal = args.label
    reasons = []
    if off_pin:
        reasons.append(f"it is on {state['branch']}@{state['head'][:12]}, which is neither the monorepo pin "
                       f"{pin[:12]} nor built on it")
    if stale:
        reasons.append(f"it is {state['behind']} commits behind origin/main (limit {limit})")
    fixes = [
        f"test your own intentd worktree: make {goal} INTENTD_DIR=/path/to/your/intentd",
        f"test this checkout as it is:    make {goal} INTENTD_DIR={DEFAULT_RELATIVE} "
        f"(or run make from inside {DEFAULT_RELATIVE})",
    ]
    if off_pin:
        fixes.append(f"return it to the pin:           git submodule update --checkout {DEFAULT_RELATIVE}")
    if stale:
        fixes.append("refresh the monorepo branch:     git pull --rebase origin main && "
                     f"git submodule update --checkout {DEFAULT_RELATIVE}")
    message = (f"{tag} the default {DEFAULT_RELATIVE} may not be the tree you mean to test: "
               + "; ".join(reasons) + ".\n  Fix one of:\n"
               + "".join(f"    - {fix}\n" for fix in fixes))
    if truthy(args.dry_run):
        print(f"{tag} WARNING (DRY_RUN, not refused): " + message.split("] ", 1)[1], end="",
              file=sys.stderr)
        return 0
    print(message, end="", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
