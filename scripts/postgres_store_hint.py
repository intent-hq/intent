#!/usr/bin/env python3
"""Warn when a filtered Rust test run leaves out the Postgres store tests.

    postgres_store_hint.py --label L --intentd-dir DIR --base REF
                           [--features "F ..."] [--filterset E]

The intent-store backend tests (tests/postgres_backend*, tests/postgres_neki.rs,
src/postgres/) and the intentd-orchestrator crate build only with a `postgres`
feature, so without it they compile to empty binaries and a filtered run
silently skips them: intentd#3672 lost a new parity test from a 365-test
`make test-select` until FEATURES=intent-store/postgres was set. Called by
`make test-select`, `test-stress` and `test-changed`, this prints a warning to
stderr when
  1. the intentd branch (committed, staged, unstaged or untracked work since
     merge-base(HEAD, REF)) changes such a path and FEATURES lacks the feature;
  2. E names Postgres-gated tests (not the lint binaries) and FEATURES lacks
     the feature; or
  3. FEATURES has the feature but INTENT_STORE_TEST_PG_URL is unset (the
     backend tests then skip) and INTENT_STORE_REQUIRE_PG is not 1.
It always exits 0: a git failure (unknown REF, no checkout) prints nothing.
"""
import argparse
import os
import re
import shlex
import subprocess
import sys

STORE = "intent-store"
ORCHESTRATOR = "intentd-orchestrator"
GATED = (
    (STORE, "crates/intent-store/src/postgres/"),
    (STORE, "crates/intent-store/tests/postgres_backend.rs"),
    (STORE, "crates/intent-store/tests/postgres_backend/"),
    (STORE, "crates/intent-store/tests/postgres_neki.rs"),
    (ORCHESTRATOR, "crates/intentd-orchestrator/"),
)
# Filterset terms for gated tests; postgres_backend_lint and
# postgres_tenant_schema_lint build without the feature.
FILTERSET_NAMES = (
    (STORE, re.compile(r"postgres_backend(?!_lint)|postgres_neki|postgres::", re.IGNORECASE)),
    (ORCHESTRATOR, re.compile(r"intentd-orchestrator|intentd_orchestrator")),
)


def git(intentd_dir, *args):
    return subprocess.run(["git", "-C", intentd_dir, *args], check=True, capture_output=True,
                          text=True, timeout=30).stdout


def changed_paths(intentd_dir, base):
    try:
        merge_base = git(intentd_dir, "merge-base", "HEAD", base).strip()
        diff = git(intentd_dir, "diff", "--name-only", merge_base, "--")
        untracked = git(intentd_dir, "ls-files", "--others", "--exclude-standard")
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted(set((diff + untracked).splitlines()))


def gated_changes(paths):
    found = {}
    for path in paths:
        for package, prefix in GATED:
            if path == prefix or (prefix.endswith("/") and path.startswith(prefix)):
                found.setdefault(package, []).append(path)
    return found


def hint(label, intentd_dir, base, features, filterset):
    enabled = set(features.replace(",", " ").split())
    covered = set()
    if f"{ORCHESTRATOR}/postgres" in enabled:
        covered |= {STORE, ORCHESTRATOR}
    if f"{STORE}/postgres" in enabled:
        covered.add(STORE)
    lines = []
    missing = {package: paths for package, paths in gated_changes(changed_paths(intentd_dir, base)).items()
               if package not in covered}
    if missing:
        paths = [path for package in sorted(missing) for path in missing[package]]
        shown = ", ".join(paths[:5]) + (f" and {len(paths) - 5} more" if len(paths) > 5 else "")
        feature = f"{ORCHESTRATOR}/postgres" if ORCHESTRATOR in missing else f"{STORE}/postgres"
        expression = " | ".join(f"package({package})" for package in sorted(missing))
        lines += [
            f"WARNING: this intentd branch changes Postgres-gated code ({shown}).",
            "Its tests build only with the postgres feature, so this run leaves them out. Run them with:",
            f"  INTENT_STORE_TEST_PG_URL=postgres://... make test-select FEATURES={feature} E={shlex.quote(expression)}",
        ]
    elif filterset:
        named = [package for package, pattern in FILTERSET_NAMES
                 if package not in covered and pattern.search(filterset)]
        if named:
            feature = f"{ORCHESTRATOR}/postgres" if ORCHESTRATOR in named else f"{STORE}/postgres"
            lines += [f"WARNING: E names Postgres tests, which build only with FEATURES={feature};"
                      " without it they are left out of this run."]
    if (STORE in covered and not os.environ.get("INTENT_STORE_TEST_PG_URL")
            and os.environ.get("INTENT_STORE_REQUIRE_PG") != "1"):
        lines += ["WARNING: INTENT_STORE_TEST_PG_URL is unset, so the Postgres backend tests skip (and pass)."
                  " Point it at a Postgres server, or set INTENT_STORE_REQUIRE_PG=1 to fail them instead."]
    for line in lines:
        print(f"[{label}] {line}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--label", required=True)
    parser.add_argument("--intentd-dir", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--features", default="")
    parser.add_argument("--filterset")
    args = parser.parse_args()
    hint(args.label, args.intentd_dir, args.base, args.features, args.filterset)
    return 0


if __name__ == "__main__":
    sys.exit(main())
