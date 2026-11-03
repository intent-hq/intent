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

Followed: literal ``scripts/<name>`` references, and inside scripts/ a sibling
named relative to the script's directory (``"$script_dir/x.sh"``,
``"$(dirname "$0")/x.py"``). Full-line ``#`` comments are ignored so prose
mentions do not widen the list. A computed name such as the root Makefile's
``./scripts/$@.sh`` is not followed: add such a helper to ENTRYPOINTS. The
watch list also keeps references whose file is missing, so deleting a helper
that a launcher still calls selects the test.

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

_NAME = r"([A-Za-z0-9_][A-Za-z0-9_.-]*)"
_COMPONENT_REFERENCE = re.compile(r"(?<![\w.-])scripts/" + _NAME)
# Inside scripts/: a sibling named relative to the script's own directory, as
# "$script_dir/x.sh", "${here}/x.py" or "$(dirname "${BASH_SOURCE[0]}")/x.py".
_SIBLING_REFERENCE = re.compile(
    r"(?:\$\{?\w+\}?|\))\"?/([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:sh|py|mjs|cjs|js|json))(?![\w.-])")
_ROOT_REFERENCE = re.compile(r"INTENTD_DIR\)?\"?/scripts/" + _NAME)


def _code(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _references(text: str, *patterns: re.Pattern[str]) -> set[str]:
    code = _code(text)
    names = {name.rstrip(".") for pattern in patterns for name in pattern.findall(code)}
    # A name cut short by a glob or an expansion (scripts/test-*, scripts/x-$y)
    # ends in punctuation; it names no file, so it is neither copied nor watched.
    return {"scripts/" + name for name in names if name[-1:].isalnum()}


def _scan(component: Path, repo_root: Path) -> tuple[set[str], set[str]]:
    """(files that exist and are copied, every path referenced on the way)."""
    pending = list(ENTRYPOINTS)
    for name in ROOT_LAUNCHERS:
        path = repo_root / name
        if path.is_file():
            pending += sorted(_references(path.read_text(errors="replace"), _ROOT_REFERENCE))
    referenced = set(pending)
    found: set[str] = set()
    while pending:
        relative = pending.pop()
        if relative in found or relative in STUBBED:
            continue
        path = component / relative
        if not path.is_file():
            continue
        found.add(relative)
        patterns = [_COMPONENT_REFERENCE]
        if relative.startswith("scripts/"):
            patterns.append(_SIBLING_REFERENCE)
        refs = _references(path.read_text(errors="replace"), *patterns)
        referenced |= refs
        pending += sorted(refs)
    return found, referenced - STUBBED


def component_files(component: Path, repo_root: Path = ROOT) -> list[str]:
    """Component-relative files to copy, sorted; missing references are skipped."""
    return sorted(_scan(component, repo_root)[0])


def watched_files(component: Path, repo_root: Path = ROOT) -> list[str]:
    """Paths whose change can break the test: every entrypoint and every path the
    launchers reference, whether it exists or not. A deleted helper that is
    still called stays watched, so deleting it selects the test."""
    found, referenced = _scan(component, repo_root)
    return sorted({*ENTRYPOINTS, *found, *referenced})


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
