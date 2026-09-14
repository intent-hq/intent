#!/usr/bin/env python3
"""Run nextest with an opt-in, complete-tree-keyed passed-test record."""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

SCHEMA_VERSION = 1
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
KEY_RE = re.compile(r"^[0-9a-f]{64}$")
RUST_FLAG_ENV = {"RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS"}
RETRY_SUFFIX_RE = re.compile(r"#[0-9]+$")
DEFAULT_LABEL = "test-intentd"
TEST_OUTCOMES = ("ok", "failed", "ignored")
# Outcomes appended to passed.jsonl; a failure supersedes an earlier pass.
RECORDED_OUTCOMES = ("ok", "failed")


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


def load_outcomes(record: Path) -> dict[tuple[str, str], str]:
    """Latest recorded outcome per test for this tree.

    The record is append-only and shared by every run on the tree, so a later
    `failed` line supersedes an earlier pass of the same test. Lines without an
    `outcome` field predate failure recording and are passes.
    """
    outcomes: dict[tuple[str, str], str] = {}
    if not record.is_file():
        return outcomes
    with record.open(encoding="utf-8") as lines:
        for line in lines:
            try:
                item = json.loads(line)
                test = (item["binary_id"], item["test"])
                outcome = item.get("outcome", "ok")
            except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
                continue
            outcomes[test] = outcome
    return outcomes


def load_passed(record: Path) -> set[tuple[str, str]]:
    return {test for test, outcome in load_outcomes(record).items() if outcome == "ok"}


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


def parse_recorded_event(
    line: str, binary_ids: dict[tuple[str, str], str]
) -> tuple[str, str, str] | None:
    """Return (binary_id, test, outcome) for a pass or failure event, else None."""
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") != "test":
        return None
    outcome = event.get("event")
    if outcome not in RECORDED_OUTCOMES:
        return None
    suite, separator, test = event.get("name", "").partition("$")
    if not separator or not suite or not test:
        raise RuntimeError(f"unexpected nextest test identifier: {event.get('name')!r}")
    test = RETRY_SUFFIX_RE.sub("", test)
    binary_id = binary_ids.get((suite, test))
    if binary_id is None:
        raise RuntimeError(f"nextest test identifier was not listed: {event.get('name')!r}")
    return binary_id, test, outcome


def record_line(binary_id: str, test: str, outcome: str) -> str:
    item: dict[str, str] = {"binary_id": binary_id, "test": test}
    if outcome != "ok":
        item["outcome"] = outcome
    return json.dumps(item) + "\n"


def test_outcome(line: str) -> tuple[str, str] | None:
    """Return (test identifier without retry suffix, outcome) for a final test event."""
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict) or event.get("type") != "test":
        return None
    outcome = event.get("event")
    if outcome not in TEST_OUTCOMES:
        return None
    return RETRY_SUFFIX_RE.sub("", event.get("name", "")), outcome


def tally(outcomes: dict[str, str]) -> dict[str, int]:
    counts = {"passed": 0, "failed": 0, "ignored": 0}
    for outcome in outcomes.values():
        counts["passed" if outcome == "ok" else outcome] += 1
    return counts


def split_plans(plans: list[str] | None) -> list[list[str]]:
    return [shlex.split(plan) for plan in plans or []]


def plan_key(plans: list[list[str]]) -> str:
    encoded = json.dumps([" ".join(plan) for plan in plans]).encode()
    return hashlib.sha256(encoded).hexdigest()


def summary_line(label: str, counts: dict[str, int], resumed: int) -> str:
    return (
        f"[{label}] summary: {counts['passed']} passed, {counts['failed']} failed, "
        f"{counts['ignored']} skipped/ignored, {resumed} resumed "
        "(tests already passed for this tree)"
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_atomic(path: Path, text: str) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def write_tool_config(
    path: Path,
    cache_dir: Path,
    profile: str,
    passed: set[tuple[str, str]],
    junit: str = "junit.xml",
) -> None:
    lines = [
        "[store]",
        f"dir = {json.dumps(str(cache_dir))}",
        f"[profile.{profile}]",
        'inherits = "default"',
    ]
    if passed:
        lines.append(f"default-filter = {json.dumps(remaining_filter(passed))}")
    lines.extend([f"[profile.{profile}.junit]", f"path = {json.dumps(junit)}", ""])
    write_atomic(path, "\n".join(lines))


def nextest_env() -> dict[str, str]:
    env = os.environ.copy()
    env["NEXTEST_EXPERIMENTAL_LIBTEST_JSON"] = "1"
    # nextest draws its progress bar on stderr whenever stderr is a TTY; under a
    # PTY-backed script runner that fills the captured output with redraws.
    env.setdefault("NEXTEST_HIDE_PROGRESS_BAR", "1")
    return env


def invalidate_completion_markers(run_dir: Path) -> None:
    """Remove the tree-level `complete` and every planned `changed/*/complete`.

    A marker only proves that the tests it covered passed on this tree as far as
    the shared passed.jsonl records them. Once a failure is observed, or once the
    journal is about to be truncated, that evidence is gone for every run on the
    tree, so no marker may outlive it.
    """
    (run_dir / "complete").unlink(missing_ok=True)
    changed = run_dir / "changed"
    if changed.is_dir():
        for marker in changed.glob("*/complete"):
            marker.unlink(missing_ok=True)


def stream_nextest(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    binary_ids: dict[tuple[str, str], str],
    descriptor: int,
    outcomes: dict[str, str],
    run_dir: Path,
) -> int:
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE)
    assert process.stdout is not None
    try:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            outcome = test_outcome(line)
            if outcome is not None:
                outcomes[outcome[0]] = outcome[1]
            recorded = parse_recorded_event(line, binary_ids)
            if recorded is not None:
                if recorded[2] != "ok":
                    # Persist the invalidation at the moment of failure, before the
                    # journal line, so an interrupt cannot leave a marker resting on
                    # a pass this failure has just superseded.
                    invalidate_completion_markers(run_dir)
                os.write(descriptor, record_line(*recorded).encode())
        return process.wait()
    except BaseException:
        process.terminate()
        process.wait()
        raise


def previously_passed(record_dir: Path, fallback: int) -> int:
    try:
        previous = json.loads((record_dir / "run.json").read_text(encoding="utf-8"))
        return int(previous["passed"]) + int(previous["skipped_resumed"])
    except (OSError, ValueError, KeyError, TypeError):
        return fallback


class Terminated(BaseException):
    """Raised by the SIGTERM handler so `finally` blocks run before the runner exits."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"terminated by signal {signum}")
        self.signum = signum


@contextlib.contextmanager
def terminate_on_signal():
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def handler(signum, _frame):
        raise Terminated(signum)

    previous = signal.signal(signal.SIGTERM, handler)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


HANDLED_ERROR_EXIT = 2


def failure_exit_code(error: BaseException) -> int:
    """The process exit code an exception escaping the nextest phase produces."""
    if isinstance(error, subprocess.CalledProcessError):
        return error.returncode
    if isinstance(error, KeyboardInterrupt):
        return 130
    if isinstance(error, Terminated):
        return 128 + error.signum
    if isinstance(error, (OSError, RuntimeError)):
        return HANDLED_ERROR_EXIT
    # Anything else propagates unhandled, which exits the interpreter with 1.
    return 1


def run_nextest(args: argparse.Namespace) -> int:
    label = args.label
    repo_root = Path(args.repo_root).resolve()
    intentd_dir = (repo_root / args.intentd_dir).resolve()
    cache_dir = Path(args.cache_dir).expanduser().resolve()
    plans = split_plans(args.plan)
    prune(cache_dir)
    key = tree_key(repo_root, intentd_dir)
    run_dir = cache_dir / key
    run_dir.mkdir(parents=True, exist_ok=True)
    os.utime(run_dir)
    record = run_dir / "passed.jsonl"
    outcomes_by_test = load_outcomes(record)
    recorded = {test for test, outcome in outcomes_by_test.items() if outcome == "ok"}
    failed_on_tree = len(outcomes_by_test) - len(recorded)
    resumed = recorded if args.resume == "1" and args.force != "1" else set()
    if plans:
        # The full-suite `complete` marker belongs to `--workspace` runs only; a
        # planned run keeps its own marker, junit files and run.json under changed/.
        store_dir = run_dir / "changed"
        profile = plan_key(plans)
        record_dir = store_dir / profile
        record_dir.mkdir(parents=True, exist_ok=True)
        selections = plans
        scope = "every planned test"
    else:
        store_dir = cache_dir
        profile = key
        record_dir = run_dir
        selections = [["--workspace"]]
        scope = "the complete suite"
    complete = record_dir / "complete"
    resuming = args.resume == "1" and args.force != "1"
    # A completed plan may legitimately have passed nothing (every selected test
    # ignored), so the planned fast path keys on the marker alone. A test that
    # later failed on this tree (in any run sharing passed.jsonl) supersedes the
    # marker: the run proceeds and reruns whatever is no longer recorded as passed.
    if complete.is_file() and not failed_on_tree and (resuming if plans else bool(resumed)):
        skipped = previously_passed(record_dir, len(resumed)) if plans else len(resumed)
        print(f"resumed: skipped {skipped} tests already passed for this tree", flush=True)
        return 0

    # Invalidate the previous marker before nextest is invoked so a failed or
    # interrupted list step cannot leave a stale `complete` behind.
    complete.unlink(missing_ok=True)
    env = nextest_env()
    started_at = utc_now()
    results: list[dict[str, object]] = []

    def finalize(status: int | None) -> None:
        totals = {"passed": 0, "failed": 0, "ignored": 0}
        for result in results:
            for name in totals:
                totals[name] += int(result[name])
        if status == 0:
            write_atomic(complete, "complete\n")
            if resumed:
                print(
                    f"resumed: skipped {len(resumed)} tests already passed for this tree",
                    flush=True,
                )
        summary = summary_line(label, totals, len(resumed))
        write_atomic(record_dir / "summary.txt", summary + "\n")
        if plans:
            run_record = {
                "label": label,
                "base": args.base,
                "plans": [" ".join(plan) for plan in plans],
                "tree_key": key,
                "plan_key": profile,
                "started_at": started_at,
                "finished_at": utc_now(),
                "exit_code": status,
                "skipped_resumed": len(resumed),
                **totals,
                "results": results,
            }
            write_atomic(record_dir / "run.json", json.dumps(run_record, indent=2) + "\n")
        print(summary, flush=True)
        print(f"[{label}] record: {record_dir}", flush=True)

    # From the first `cargo nextest list` onwards every exit — failure,
    # KeyboardInterrupt or SIGTERM — leaves the summary/record lines and files.
    try:
        with terminate_on_signal():
            binary_ids: dict[tuple[str, str], str] = {}
            for selection in selections:
                list_output = run(
                    [
                        "cargo", "nextest", "list", *selection,
                        "--build-jobs", args.build_jobs,
                        "--message-format", "json",
                    ],
                    intentd_dir,
                    env,
                )
                binary_ids.update(test_binary_ids(list_output))
            known_tests = {(binary_id, test) for (_, test), binary_id in binary_ids.items()}
            if plans:
                # passed.jsonl is shared by every run on this tree; only the tests
                # these plans select count as resumed here.
                resumed = resumed & known_tests
            else:
                unknown = resumed - known_tests
                if unknown:
                    raise RuntimeError(
                        f"passed-test record contains {len(unknown)} unlisted tests"
                    )
            configs = []
            for index, _ in enumerate(selections, start=1):
                if plans:
                    config = record_dir / f"nextest-{index}.toml"
                    write_tool_config(
                        config, store_dir, profile, resumed, f"junit-{index}.xml"
                    )
                else:
                    config = run_dir / "nextest.toml"
                    write_tool_config(config, store_dir, profile, resumed)
                configs.append(config)

            if not resumed and not plans:
                # Truncating the shared journal discards the passes every marker on
                # this tree rests on; drop them first so an interrupted full run
                # cannot leave a marker with no evidence behind it.
                invalidate_completion_markers(run_dir)
                record.write_text("", encoding="utf-8")

            if args.resume == "1" and args.force == "1":
                print(f"[{label}] GATE_FORCE=1: running {scope}", flush=True)
            elif args.resume == "1" and not resumed:
                print(
                    f"[{label}] no passed-test record for this tree; running {scope}",
                    flush=True,
                )

            status: int | None = None
            descriptor = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                for selection, config in zip(selections, configs):
                    command = [
                        "cargo", "nextest", "run", *selection,
                        "--build-jobs", args.build_jobs,
                        "--test-threads", args.test_threads,
                        "--tool-config-file", f"intent-gate:{config}",
                        "--profile", profile,
                        "--message-format", "libtest-json-plus",
                        "--message-format-version", "0.1",
                    ]
                    if resumed:
                        command.extend(["--no-tests", "pass"])
                    outcomes: dict[str, str] = {}
                    result: dict[str, object] = {"plan": " ".join(selection)}
                    results.append(result)
                    status = None
                    try:
                        status = stream_nextest(
                            command, intentd_dir, env, binary_ids, descriptor, outcomes, run_dir
                        )
                    finally:
                        result.update(tally(outcomes), exit_code=status)
                    if status != 0:
                        break
            finally:
                os.close(descriptor)
    except subprocess.CalledProcessError as error:
        print(f"[{label}] ERROR: {error}", file=sys.stderr, flush=True)
        exit_code = failure_exit_code(error)
        finalize(exit_code)
        return exit_code
    except (KeyboardInterrupt, Terminated) as error:
        print(f"[{label}] ERROR: interrupted: {error}", file=sys.stderr, flush=True)
        exit_code = failure_exit_code(error)
        finalize(exit_code)
        return exit_code
    except BaseException as error:
        finalize(failure_exit_code(error))
        raise
    assert status is not None
    finalize(status)
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
    parser.add_argument(
        "--label", default=DEFAULT_LABEL, help="log prefix (default: %(default)s)"
    )
    parser.add_argument(
        "--plan",
        action="append",
        metavar="ARGS",
        help="nextest target selection, e.g. '-p alpha --test one'; repeatable, "
        "run in order instead of --workspace",
    )
    parser.add_argument("--base", metavar="REF", help="base ref recorded in run.json")
    args = parser.parse_args()
    try:
        return run_nextest(args)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"[{args.label}] ERROR: {error}", file=sys.stderr)
        return HANDLED_ERROR_EXIT


if __name__ == "__main__":
    raise SystemExit(main())