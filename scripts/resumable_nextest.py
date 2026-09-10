#!/usr/bin/env python3
"""Run nextest with an opt-in, complete-tree-keyed passed-test record."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

SCHEMA_VERSION = 1
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
RUST_FLAG_ENV = {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS"}
RETRY_SUFFIX_RE = re.compile(r"#[0-9]+$")


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, check=True
    )
    return result.stdout.strip()


def worktree_tree(repo: Path) -> str:
    with tempfile.TemporaryDirectory(prefix="intent-gate-index-") as temp_dir:
        index = Path(temp_dir) / "index"
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(index)
        run(["git", "read-tree", "HEAD"], repo, env)
        run(["git", "add", "-A"], repo, env)
        return run(["git", "write-tree"], repo, env)


def required_hash(path: Path) -> str:
    if not path.is_file():
        raise RuntimeError(f"required tree-key input is missing: {path}")
    return run(["git", "hash-object", str(path)], path.parent)


def submodule_heads(repo_root: Path) -> list[dict[str, str]]:
    output = run(
        ["git", "config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"],
        repo_root,
    )
    heads = []
    for line in output.splitlines():
        path = line.split(maxsplit=1)[1]
        checkout = repo_root / path
        if (checkout / ".git").exists():
            head = run(["git", "rev-parse", "HEAD"], checkout)
        else:
            head = run(["git", "rev-parse", f"HEAD:{path}"], repo_root)
        heads.append({"path": path, "head": head})
    return sorted(heads, key=lambda item: item["path"])


def rust_flags() -> dict[str, str]:
    return {
        name: value
        for name, value in os.environ.items()
        if name in RUST_FLAG_ENV
        or (name.startswith("CARGO_TARGET_") and name.endswith("_RUSTFLAGS"))
    }


def tree_key(repo_root: Path, intentd_dir: Path) -> str:
    inputs = {
        "schema": SCHEMA_VERSION,
        "root-tree": worktree_tree(repo_root),
        "intentd-tree": worktree_tree(intentd_dir),
        "submodules": submodule_heads(repo_root),
        "rust-toolchain.toml": required_hash(intentd_dir / "rust-toolchain.toml"),
        "Cargo.lock": required_hash(intentd_dir / "Cargo.lock"),
        ".config/nextest.toml": required_hash(intentd_dir / ".config/nextest.toml"),
        "rustc": run(["rustc", "-vV"], intentd_dir),
        "cargo": run(["cargo", "-V"], intentd_dir),
        "nextest": run(["cargo", "nextest", "--version"], intentd_dir),
        "rustflags": rust_flags(),
    }
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def prune(cache_dir: Path, now: float | None = None) -> None:
    cutoff = (time.time() if now is None else now) - MAX_AGE_SECONDS
    if not cache_dir.exists():
        return
    for entry in cache_dir.iterdir():
        if KEY_RE.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry)


def load_passed(record: Path) -> set[tuple[str, str]]:
    passed: set[tuple[str, str]] = set()
    if not record.is_file():
        return passed
    with record.open(encoding="utf-8") as lines:
        for line in lines:
            try:
                item = json.loads(line)
                passed.add((item["binary_id"], item["test"]))
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return passed


def exact_regex(value: str) -> str:
    return "/^" + re.escape(value).replace("/", r"\/") + "$/"


def remaining_filter(passed: set[tuple[str, str]]) -> str:
    tests_by_binary: dict[str, list[str]] = {}
    for binary, test in sorted(passed):
        tests_by_binary.setdefault(binary, []).append(test)
    terms = []
    for binary, tests in tests_by_binary.items():
        test_terms = " | ".join(f"test({exact_regex(test)})" for test in tests)
        terms.append(f"(binary_id({exact_regex(binary)}) and ({test_terms}))")
    return "not (" + " | ".join(terms) + ")"


def test_binary_ids(list_output: str) -> dict[tuple[str, str], str]:
    suites = json.loads(list_output)["rust-suites"]
    binary_ids: dict[tuple[str, str], str] = {}
    for suite in suites.values():
        event_suite = f'{suite["package-name"]}::{suite["binary-name"]}'
        for test in suite["testcases"]:
            key = (event_suite, test)
            binary_id = suite["binary-id"]
            if key in binary_ids and binary_ids[key] != binary_id:
                raise RuntimeError(f"ambiguous nextest test identifier: {event_suite}${test}")
            binary_ids[key] = binary_id
    return binary_ids


def parse_passed_event(
    line: str, binary_ids: dict[tuple[str, str], str]
) -> tuple[str, str] | None:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if event.get("type") != "test" or event.get("event") != "ok":
        return None
    suite, separator, test = event.get("name", "").partition("$")
    if not separator or not suite or not test:
        raise RuntimeError(f"unexpected nextest test identifier: {event.get('name')!r}")
    test = RETRY_SUFFIX_RE.sub("", test)
    binary_id = binary_ids.get((suite, test))
    if binary_id is None:
        raise RuntimeError(f"nextest test identifier was not listed: {event.get('name')!r}")
    return binary_id, test


def write_tool_config(
    path: Path, cache_dir: Path, profile: str, passed: set[tuple[str, str]]
) -> None:
    lines = [
        "[store]",
        f"dir = {json.dumps(str(cache_dir))}",
        f"[profile.{profile}]",
        'inherits = "default"',
    ]
    if passed:
        lines.append(f"default-filter = {json.dumps(remaining_filter(passed))}")
    lines.extend([f"[profile.{profile}.junit]", 'path = "junit.xml"', ""])
    temporary = path.with_suffix(".tmp")
    temporary.write_text("\n".join(lines), encoding="utf-8")
    temporary.replace(path)


def run_nextest(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    intentd_dir = (repo_root / args.intentd_dir).resolve()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    prune(cache_dir)
    key = tree_key(repo_root, intentd_dir)
    run_dir = cache_dir / key
    run_dir.mkdir(parents=True, exist_ok=True)
    os.utime(run_dir)
    record = run_dir / "passed.jsonl"
    recorded = load_passed(record)
    resumed = recorded if args.resume == "1" and args.force != "1" else set()
    complete = run_dir / "complete"
    if resumed and complete.is_file():
        print(f"resumed: skipped {len(resumed)} tests already passed for this tree", flush=True)
        return 0

    env = os.environ.copy()
    env["NEXTEST_EXPERIMENTAL_LIBTEST_JSON"] = "1"
    list_output = run(
        [
            "cargo", "nextest", "list", "--workspace",
            "--build-jobs", args.build_jobs,
            "--message-format", "json",
        ],
        intentd_dir,
        env,
    )
    binary_ids = test_binary_ids(list_output)
    known_tests = {(binary_id, test) for (_, test), binary_id in binary_ids.items()}
    unknown = resumed - known_tests
    if unknown:
        raise RuntimeError(f"passed-test record contains {len(unknown)} unlisted tests")
    config = run_dir / "nextest.toml"
    write_tool_config(config, cache_dir, key, resumed)

    complete.unlink(missing_ok=True)
    if not resumed:
        record.write_text("", encoding="utf-8")

    if args.resume == "1" and args.force == "1":
        print("[test-intentd] GATE_FORCE=1: running the complete suite", flush=True)
    elif args.resume == "1" and not resumed:
        print(
            "[test-intentd] no passed-test record for this tree; running the complete suite",
            flush=True,
        )

    command = [
        "cargo", "nextest", "run", "--workspace",
        "--build-jobs", args.build_jobs,
        "--test-threads", args.test_threads,
        "--tool-config-file", f"intent-gate:{config}",
        "--profile", key,
        "--message-format", "libtest-json-plus",
        "--message-format-version", "0.1",
    ]
    if resumed:
        command.extend(["--no-tests", "pass"])
    process = subprocess.Popen(command, cwd=intentd_dir, env=env, text=True, stdout=subprocess.PIPE)
    assert process.stdout is not None
    descriptor = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            passed = parse_passed_event(line, binary_ids)
            if passed is not None:
                item = json.dumps({"binary_id": passed[0], "test": passed[1]}) + "\n"
                os.write(descriptor, item.encode())
        status = process.wait()
    except BaseException:
        process.terminate()
        process.wait()
        raise
    finally:
        os.close(descriptor)
    if status == 0:
        temporary = complete.with_suffix(".tmp")
        temporary.write_text("complete\n", encoding="utf-8")
        temporary.replace(complete)
        if resumed:
            print(f"resumed: skipped {len(resumed)} tests already passed for this tree", flush=True)
    return status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--intentd-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--resume", choices=("0", "1"), default="0")
    parser.add_argument("--force", choices=("0", "1"), default="0")
    parser.add_argument("--build-jobs", required=True)
    parser.add_argument("--test-threads", required=True)
    try:
        return run_nextest(parser.parse_args())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"[test-intentd] ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())