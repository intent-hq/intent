"""Stress mode for scripts/resumable_nextest.py (`make test-stress`).

Repeats one nextest filterset COUNT times with retries off, optionally under a
built-in CPU and disk load, and prints one summary line: iterations, passes,
failures and the distinct panic locations of the failures.

It reuses the gate's fixture preparation, caller environment and isolated Cargo
outputs, so fixture tests behave as under `make test-select`. It never reads
or writes the resume journal or completion markers: a stress pass is not
evidence that `RESUME=1 make test` may skip a test.

Output and a summary are kept under CACHE_DIR/stress/<id>/ (output.log,
summary.txt, summary.json); the id directory is removed after seven days.
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

# A final status line of nextest's human reporter in stress mode, e.g.
# "        FAIL [   0.002s] [3/6] (2/2) crate::binary module::test".
STATUS_RE = re.compile(
    r"^\s*(?P<status>[A-Z][A-Z0-9-]*)\s+\[[^\]]*\]\s+\[(?P<iteration>\d+)/(?P<total>\d+|∞|inf\w*)\]\s+"
    r"\(\d+/\d+\)\s+(?P<binary>\S+)\s+(?P<test>\S.*?)\s*$"
)
# Statuses that end a test run; SLOW/START/TERMINATING and friends are progress.
PASS_STATUSES = {"PASS", "LEAK"}
FAIL_STATUS_RE = re.compile(r"^(FAIL|LEAK-FAIL|TIMEOUT|ABORT|EXEC-FAIL|SIG[A-Z0-9]+)$")
PANIC_RE = re.compile(r"panicked at (?P<file>[^\s:][^:]*):(?P<line>\d+)(?::\d+)?")
LOAD_CHUNK_MB = 64
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
ID_RE = re.compile(r"^[0-9a-f]{32}$")

# The disk half of LOAD=1: write LOAD_CHUNK_MB, fsync, delete, repeat.
FSYNC_WRITER = """import os, sys
path = sys.argv[1]
block = b"\\0" * (1024 * 1024)
while True:
    with open(path, "wb") as handle:
        for _ in range(int(sys.argv[2])):
            handle.write(block)
        handle.flush()
        os.fsync(handle.fileno())
    os.unlink(path)
"""


class StressTally:
    """Accumulates final statuses and panic locations from streamed output."""

    def __init__(self) -> None:
        # (iteration, binary, test) -> status; the final summary block repeats
        # failure lines, so keying by iteration counts each run once.
        self.runs: dict[tuple[int, str, str], str] = {}
        self.locations: dict[tuple[int, str, str], str] = {}
        self.total_iterations: int | None = None
        self._current: tuple[int, str, str] | None = None

    def feed(self, line: str) -> None:
        match = STATUS_RE.match(line)
        if match:
            status = match["status"]
            self._current = None
            if status not in PASS_STATUSES and not FAIL_STATUS_RE.match(status):
                return
            key = (int(match["iteration"]), match["binary"], match["test"])
            if match["total"].isdigit():
                self.total_iterations = int(match["total"])
            self.runs.setdefault(key, status)
            if status not in PASS_STATUSES:
                self._current = key
            return
        if self._current is not None and self._current not in self.locations:
            panic = PANIC_RE.search(line)
            if panic:
                self.locations[self._current] = f"{panic['file']}:{panic['line']}"

    def counts(self) -> dict[str, object]:
        failed_keys = [key for key, status in self.runs.items() if status not in PASS_STATUSES]
        iterations = {key[0] for key in self.runs}
        failed_iterations = {key[0] for key in failed_keys}
        reasons: dict[str, int] = {}
        for key in failed_keys:
            reason = self.locations.get(key) or self.runs[key]
            reasons[reason] = reasons.get(reason, 0) + 1
        return {
            "iterations": len(iterations),
            "total_iterations": self.total_iterations,
            "failed_iterations": len(failed_iterations),
            "tests": len({key[1:] for key in self.runs}),
            "passed": len(self.runs) - len(failed_keys),
            "failed": len(failed_keys),
            "failures": dict(sorted(reasons.items(), key=lambda item: (-item[1], item[0]))),
        }


def summary_line(label: str, counts: dict[str, object], load: str) -> str:
    total = counts["total_iterations"] or counts["iterations"]
    tests = counts["tests"]
    text = (
        f"[{label}] stress: {counts['iterations']}/{total} iterations "
        f"({counts['failed_iterations']} failed), {tests} test{'' if tests == 1 else 's'}, {load}: "
        f"{counts['passed']} passed, {counts['failed']} failed"
    )
    failures = counts["failures"]
    if failures:
        text += "; failures: " + ", ".join(f"{reason} ×{count}" for reason, count in failures.items())
    return text


def _die_with_parent() -> None:
    """Linux: SIGKILL the load process if the runner dies without cleanup."""
    if sys.platform.startswith("linux"):
        try:
            import ctypes

            ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
        except (OSError, AttributeError):
            pass


def _stop(processes: list[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            process.kill()
    for process in processes:
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)


@contextlib.contextmanager
def stress_load(cpus: int, scratch: Path):
    """Run `cpus` CPU spinners plus one fsync writer for the duration."""
    processes: list[subprocess.Popen] = []
    try:
        for _ in range(cpus):
            processes.append(subprocess.Popen(
                ["yes"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, preexec_fn=_die_with_parent))
        processes.append(subprocess.Popen(
            [sys.executable, "-I", "-c", FSYNC_WRITER, str(scratch / "load.bin"), str(LOAD_CHUNK_MB)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=_die_with_parent))
        yield processes
    finally:
        _stop(processes)


def prune(stress_dir: Path, now: float | None = None) -> None:
    cutoff = (time.time() if now is None else now) - MAX_AGE_SECONDS
    if not stress_dir.is_dir():
        return
    for entry in stress_dir.iterdir():
        if ID_RE.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)


def default_load_cpus() -> int:
    return 2 * (os.cpu_count() or 1)


def stream(command: list[str], cwd: Path, env: dict[str, str], log, tally: StressTally) -> int:
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True, errors="replace",
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert process.stdout is not None
    try:
        for line in process.stdout:
            log.write(line)
            sys.stdout.write(line)
            sys.stdout.flush()
            tally.feed(line)
        return process.wait()
    except BaseException:
        process.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=30)
        if process.poll() is None:
            process.kill()
            process.wait()
        raise


def run_stress(args, gate) -> int:
    """Run args.filterset args.stress_count times; `gate` is resumable_nextest."""
    label = args.label
    repo_root = Path(args.repo_root).resolve()
    intentd_dir = (repo_root / args.intentd_dir).resolve()
    stress_dir = Path(args.cache_dir).expanduser().resolve() / "stress"
    selection = ["--workspace", "-E", args.filterset]
    fixture = gate.callback_fixture_identity(intentd_dir) if gate.needs_callback_fixture([selection]) else None
    transfer = gate.transfer_fixture_identity(repo_root) if gate.needs_transfer_fixture([selection]) else None
    cargo_config = gate.compact_config(intentd_dir)
    gate.announce_compact()
    env = gate.nextest_env()
    if fixture is not None:
        env[gate.CALLBACK_FIXTURE_ENV] = fixture["root"]
        env.pop("NODE_OPTIONS", None)
    if transfer is not None:
        env[gate.TRANSFER_FIXTURE_ENV] = transfer["root"]
    if cargo_config:
        env["CARGO_INCREMENTAL"] = "0"
    cpus = args.load_cpus if args.load_cpus is not None else default_load_cpus()
    load = f"LOAD=1 ({cpus} cpu + fsync)" if args.load == "1" else "LOAD=0"
    prune(stress_dir)
    record_dir = stress_dir / uuid.uuid4().hex
    record_dir.mkdir(parents=True)
    tally = StressTally()
    status: int | None = None
    gate_lock = None
    with gate.terminate_on_signal():
        try:
            output_args = gate.isolated_output_args(intentd_dir, cargo_config, env)
            gate_lock = gate.acquire_gate_lock(output_args)
            print(f"[{label}] {gate.timeout_description(env)}", flush=True)
            # Build (and list) before any load starts, so the load only slows the tests.
            gate.run(["cargo", "nextest", "list", *selection, "--build-jobs", args.build_jobs,
                      "--message-format", "json", *cargo_config, *output_args], intentd_dir, env)
            command = [
                "cargo", "nextest", "run", *selection,
                "--retries", "0", "--stress-count", str(args.stress_count), "--no-fail-fast",
                "--failure-output", "immediate", "--success-output", "never",
                "--build-jobs", args.build_jobs, "--test-threads", args.test_threads,
                *cargo_config, *output_args,
            ]
            (record_dir / "command.json").write_text(json.dumps(command, indent=2) + "\n")
            print(f"[{label}] {load}; running {args.stress_count} iterations with retries off", flush=True)
            with open(record_dir / "output.log", "w", encoding="utf-8") as log, \
                    tempfile.TemporaryDirectory(prefix="intent-stress-load-") as scratch, \
                    (stress_load(cpus, Path(scratch)) if args.load == "1" else contextlib.nullcontext()):
                status = stream(command, intentd_dir, env, log, tally)
        except subprocess.CalledProcessError as error:
            print(f"[{label}] ERROR: {error}", file=sys.stderr, flush=True)
            status = gate.failure_exit_code(error)
        except (KeyboardInterrupt, gate.Terminated) as error:
            print(f"[{label}] ERROR: interrupted: {error}", file=sys.stderr, flush=True)
            status = gate.failure_exit_code(error)
        finally:
            if gate_lock is not None:
                os.close(gate_lock)
            counts = tally.counts()
            if status == 0 and counts["failed"]:
                status = 1
            line = summary_line(label, counts, load)
            (record_dir / "summary.txt").write_text(line + "\n", encoding="utf-8")
            (record_dir / "summary.json").write_text(json.dumps({
                **counts, "filterset": args.filterset, "stress_count": args.stress_count,
                "load": args.load == "1", "load_cpus": cpus if args.load == "1" else 0,
                "exit_code": status, "test_timeout_multiplier": env.get(gate.TIMEOUT_MULTIPLIER_ENV),
            }, indent=2) + "\n", encoding="utf-8")
            print(line, flush=True)
            print(f"[{label}] record: {record_dir}", flush=True)
    return status if status is not None else 1
