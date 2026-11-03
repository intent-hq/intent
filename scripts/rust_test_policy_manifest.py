#!/usr/bin/env python3
"""The intentd files scripts/test_rust_test_policy.py copies into its fake checkout.

That test drives the real root and intentd launchers in a temporary checkout.
It used to copy a hand-kept list of intentd scripts, so intentd#2896 (a new
scripts/ci-killed-rustc-retry.sh called by coverage-*.sh) merged green and the
monorepo merge queue ejected the pin bump intent#8277 31 times until intent#8301
added the file to the list. The list is now derived: the launcher entrypoints
the test drives, plus every intentd ``scripts/<name>`` file they reference,
followed transitively. A new helper is copied without a monorepo change.

scripts/consumer-checks-shell-suites.sh reads the same list (``--watched``) to
decide when an intentd PR runs the test in monorepo-consumer-checks.

Limits: only literal ``scripts/<name>`` references are followed (a computed
name such as the root Makefile's ``./scripts/$@.sh`` is not), and full-line
``#`` comments are ignored so prose mentions do not widen the list. Add a
helper reached only through a computed name to ENTRYPOINTS.

Usage: rust_test_policy_manifest.py [--component DIR] [--repo-root DIR] [--watched]
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

# Launchers the test runs directly or that the root Makefile reaches through a
# computed name (coverage-e2e / coverage-all run ./scripts/$@.sh).
ENTRYPOINTS = (
    "Makefile",
    "scripts/with-test-policy.sh",
    "scripts/changed-tests.sh",
    "scripts/coverage-all.sh",
    "scripts/coverage-e2e.sh",
)

# The test replaces this one with a synthetic stub (the real one validates a
# Linux-only payload), so the real file is never copied or watched.
STUBBED = frozenset({"scripts/prepare-acp-callback-fixture.py"})

# Root Makefile files that run intentd scripts in the test's routes.
ROOT_LAUNCHERS = ("Makefile",)

_COMPONENT_REFERENCE = re.compile(r"(?<![\w.-])scripts/([A-Za-z0-9_][A-Za-z0-9_.-]*)")
_ROOT_REFERENCE = re.compile(r"INTENTD_DIR\)?\"?/scripts/([A-Za-z0-9_][A-Za-z0-9_.-]*)")


def _code(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _references(text: str, pattern: re.Pattern[str]) -> set[str]:
    return {"scripts/" + name.rstrip(".") for name in pattern.findall(_code(text))}


def component_files(component: Path, repo_root: Path = ROOT) -> list[str]:
    """Component-relative files to copy, sorted; missing entrypoints are skipped."""
    pending = list(ENTRYPOINTS)
    for name in ROOT_LAUNCHERS:
        path = repo_root / name
        if path.is_file():
            pending += sorted(_references(path.read_text(errors="replace"), _ROOT_REFERENCE))
    found: set[str] = set()
    while pending:
        relative = pending.pop()
        if relative in found or relative in STUBBED:
            continue
        path = component / relative
        if not path.is_file():
            continue
        found.add(relative)
        pending += sorted(_references(path.read_text(errors="replace"), _COMPONENT_REFERENCE))
    return sorted(found)


def watched_files(component: Path, repo_root: Path = ROOT) -> list[str]:
    """Paths whose change can break the test: every entrypoint (added, changed or
    deleted) and every file it copies."""
    return sorted({*ENTRYPOINTS, *component_files(component, repo_root)})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--component", type=Path, default=ROOT / "packages/intentd")
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--watched", action="store_true",
                        help="print the selection watch list instead of the copy list")
    args = parser.parse_args(argv)
    if not (args.component / "scripts").is_dir():
        print(f"rust_test_policy_manifest: {args.component}/scripts is not a directory", file=sys.stderr)
        return 1
    listing = watched_files if args.watched else component_files
    for relative in listing(args.component, args.repo_root):
        print(relative)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
