#!/usr/bin/env python3
"""The intentd files the callback fixture tests copy into their fake checkout.

CallbackValidatorTests in scripts/test_resumable_nextest.py runs the real
prepare-acp-callback-fixture.py (and changed-tests.sh) from a temporary
intentd checkout. It used to copy a hand-kept list, so intentd#3103 (the
prepare script now loads a sibling download_retry.py) broke four tests on
every Linux x64 checkout with intentd, while CI, which runs them without the
submodule, skipped them. The list is now derived: the entrypoints plus every
intentd file they reference, followed transitively by the reference scan in
scripts/rust_test_policy_manifest.py.

scripts/consumer-checks-shell-suites.sh reads the watch list (``--watched``)
to decide when an intentd PR runs these tests in monorepo-consumer-checks.
The watch list adds test-prepare-acp-callback-fixture.py, which the tests load
in place, and keeps references whose file is missing.

Usage: callback_fixture_manifest.py [--component DIR] [--watched]
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "rust_test_policy_manifest", Path(__file__).with_name("rust_test_policy_manifest.py"))
_policy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_policy)

PREPARE = ("scripts/prepare-acp-callback-fixture.py",)
# Copied into the fake checkout by at least one test.
ENTRYPOINTS = (*PREPARE, "scripts/changed-tests.sh")
# Loaded from the real checkout; watched, never copied.
IN_PLACE = ("scripts/test-prepare-acp-callback-fixture.py",)


def component_files(component: Path, entrypoints=ENTRYPOINTS) -> list[str]:
    """Component-relative files to copy, sorted; missing references are skipped."""
    return sorted(_policy.reference_closure(component, entrypoints)[0])


def watched_files(component: Path) -> list[str]:
    """Every entrypoint and every path they reference, whether it exists or not."""
    entrypoints = (*ENTRYPOINTS, *IN_PLACE)
    found, referenced = _policy.reference_closure(component, entrypoints)
    return sorted({*entrypoints, *found, *referenced})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--component", type=Path, default=ROOT / "packages/intentd")
    parser.add_argument("--watched", action="store_true",
                        help="print the selection watch list instead of the copy list")
    args = parser.parse_args(argv)
    if not (args.component / "scripts").is_dir():
        print(f"callback_fixture_manifest: {args.component}/scripts is not a directory", file=sys.stderr)
        return 1
    listing = watched_files if args.watched else component_files
    for relative in listing(args.component):
        print(relative)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
