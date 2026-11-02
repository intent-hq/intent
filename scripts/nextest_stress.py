"""Stress mode for scripts/resumable_nextest.py (`make test-stress`).

Repeats one nextest filterset COUNT times with retries off, optionally under a
built-in CPU and disk load and/or random stalls (every test process frozen
with SIGSTOP for a fixed pause, then resumed, the way a briefly frozen CI
runner behaves), and prints one summary line: iterations, passes, failures and
the distinct panic locations of the failures.

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
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

# A status line of nextest's human reporter in stress mode, e.g.
# "        FAIL [   0.002s] [3/6] (2/2) crate::binary module::test". Statuses
# can contain spaces ("FAIL + LEAK").
STATUS_RE = re.compile(
    r"^\s*(?P<status>[A-Z][A-Z0-9 +-]*?)\s+\[[^\]]*\]\s+\[\s*(?P<iteration>\d+)/(?P<total>\d+|∞|inf\w*)\]\s+"
    r"(?:\(\d+/\d+\)\s+)?(?P<binary>\S+)\s+(?P<test>\S.*?)\s*$"
)
# nextest's own iteration totals, cross-checked against the per-run tally.
SUMMARY_RE = re.compile(
    r"^\s*Summary\s+\[[^\]]*\]\s+(?P<done>\d+)/(?P<total>\d+) stress run iterations?: "
    r"(?P<passed>\d+) passed(?:, (?P<failed>\d+) failed)?")
# nextest colors its output on a TTY (saved scripts are PTY-backed).
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# nextest 0.9.143 final statuses: PASS, LEAK (passed but leaked handles),
# TIMEOUT-PASS/TMPASS (slow-timeout configured to pass); everything else that
# is not progress (SLOW, START, TERMINATING, ...) is a failure: FAIL, FAIL + LEAK,
# LEAK-FAIL/LKFAIL, XFAIL (could not execute), TIMEOUT, ABORT, SIG*.
PASS_STATUSES = {"PASS", "LEAK", "TIMEOUT-PASS", "TMPASS"}
PROGRESS_PREFIXES = ("SLOW", "START", "TERMINATING", "DELAY", "RETRY", "TRY ", "SETUP", "CANCEL", "KILL")
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
        self.nextest_summary: tuple[int, int] | None = None
        self._current: tuple[int, str, str] | None = None

    def feed(self, line: str) -> None:
        line = ANSI_RE.sub("", line).replace("\r", "")
        summary = SUMMARY_RE.match(line)
        if summary:
            self.nextest_summary = (int(summary["done"]), int(summary["failed"] or 0))
            return
        match = STATUS_RE.match(line)
        if match:
            status = match["status"]
            self._current = None
            if status.startswith(PROGRESS_PREFIXES):
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
            # nextest's (iterations, failed iterations), or None if it printed no summary.
            "nextest_summary": list(self.nextest_summary) if self.nextest_summary else None,
        }


def summary_line(label: str, counts: dict[str, object], conditions: str, status: int | None = 0) -> str:
    total = counts["total_iterations"] or counts["iterations"]
    tests = counts["tests"]
    text = (
        f"[{label}] stress: {counts['iterations']}/{total} iterations "
        f"({counts['failed_iterations']} failed), {tests} test{'' if tests == 1 else 's'}, {conditions}: "
        f"{counts['passed']} passed, {counts['failed']} failed"
    )
    failures = counts["failures"]
    if failures:
        text += "; failures: " + ", ".join(f"{reason} ×{count}" for reason, count in failures.items())
    reported = counts.get("nextest_summary")
    if reported and tuple(reported) != (counts["iterations"], counts["failed_iterations"]):
        text += (f"; WARNING: nextest reported {reported[0]} iterations with {reported[1]} failed, "
                 "so the counts above missed status lines (new nextest output format?)")
    if status is None:
        text += "; ERROR: the run did not complete (see the error above)"
    elif status != 0 and not failures:
        text += f"; ERROR: exited {status} without a test failure (build, selection or setup; see output above)"
    return text


# The run's failures and passes are not evidence: the advertised load or
# stalls did not hold.
INVALID_EXIT = 3
PR_SET_PDEATHSIG = 1


def _libc_prctl():
    """Resolve prctl in the parent: a child between fork and exec must not import."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes

        return ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None


def die_with_parent(parent_pid: int, prctl, death_signal: int = signal.SIGKILL):
    """preexec_fn: signal the load process when the runner dies without cleanup (Linux).

    Load workers get SIGKILL; the stall helper gets SIGTERM, which it handles by
    resuming every process it froze before exiting.

    Registering after the runner already died would never fire, so the child
    compares getppid() with the runner's pid after registering and exits if it
    was reparented in that window. A failed registration exits too, rather than
    starting a load process nothing can reap.
    """
    def preexec() -> None:
        if prctl is None:
            return
        if prctl(PR_SET_PDEATHSIG, death_signal) != 0 or os.getppid() != parent_pid:
            os._exit(1)
    return preexec


def _stop(processes: list[subprocess.Popen]) -> None:
    for process in processes:
        if process.poll() is None:
            process.kill()
    for process in processes:
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=10)


def exited_early(processes: list[subprocess.Popen]) -> list[str]:
    """Describe load workers that stopped on their own (they never exit while healthy)."""
    return [f"{' '.join(map(str, process.args[:1]))} (pid {process.pid}) exited {process.returncode}"
            for process in processes if process.poll() is not None]


@contextlib.contextmanager
def stress_load(cpus: int, scratch: Path, stderr_path: Path | None = None):
    """Run `cpus` CPU spinners plus one fsync writer for the duration."""
    processes: list[subprocess.Popen] = []
    preexec = die_with_parent(os.getpid(), _libc_prctl())
    errors = open(stderr_path, "w", encoding="utf-8") if stderr_path else subprocess.DEVNULL
    try:
        for _ in range(cpus):
            processes.append(subprocess.Popen(
                ["yes"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=errors, preexec_fn=preexec))
        processes.append(subprocess.Popen(
            [sys.executable, "-I", "-c", FSYNC_WRITER, str(scratch / "load.bin"), str(LOAD_CHUNK_MB)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, preexec_fn=preexec))
        yield processes
    finally:
        _stop(processes)
        if stderr_path:
            errors.close()

DEFAULT_STALL_MS = 1000
DEFAULT_STALL_EVERY_MS = 2000
PROC = Path("/proc")
# The processes that run the tests rather than being tests: cargo (or the
# rustup proxy) and cargo-nextest, including its double-spawn intermediate.
# Freezing nextest itself would also stop its timers and job-control handling,
# so only processes below this chain are stalled.
STALL_SPINE = frozenset({"cargo", "cargo-nextest", "rustup"})
# Passes over the process table per stall, so a child forked during one pass
# is frozen by the next; a frozen process forks no more.
STALL_PASSES = 5
# How often the runner checks that the stall helper is still alive.
HELPER_POLL_SECONDS = 0.05


def stall_supported(proc: Path = PROC) -> bool:
    """Stalls find test processes through /proc, so they are Linux only."""
    return (proc / "self" / "stat").is_file()


def parse_stat(text: str) -> tuple[int, str, str, int] | None:
    """(ppid, comm, state, starttime) from /proc/<pid>/stat; comm may contain ")"."""
    head, _, rest = text.rpartition(")")
    fields = rest.split()
    if "(" not in head or len(fields) < 20:
        return None
    try:
        return int(fields[1]), head.partition("(")[2], fields[0], int(fields[19])
    except ValueError:
        return None


def read_processes(proc: Path = PROC) -> dict[int, tuple[int, str, str, int]]:
    table = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            parsed = parse_stat((entry / "stat").read_text())
        except OSError:
            continue
        if parsed is not None:
            table[int(entry.name)] = parsed
    return table


def stall_targets(root: int, table: dict[int, tuple[int, str, str, int]]) -> dict[int, int]:
    """pid -> starttime of every live process below the cargo/nextest chain under `root`."""
    children: dict[int, list[int]] = {}
    for pid, (ppid, *_rest) in table.items():
        children.setdefault(ppid, []).append(pid)
    targets = {}
    pending = [(root, True)]
    while pending:
        parent, on_spine = pending.pop()
        for child in children.get(parent, ()):
            _ppid, comm, state, start = table[child]
            child_on_spine = on_spine and comm in STALL_SPINE
            if not child_on_spine and state not in ("Z", "X"):
                targets[child] = start
            pending.append((child, child_on_spine))
    return targets


def signal_same(pid: int, start: int, signum: int, proc: Path = PROC) -> bool:
    """Signal `pid` only while it is still the process that started at `start` (no pid reuse)."""
    try:
        current = parse_stat((proc / str(pid) / "stat").read_text())
    except OSError:
        return False
    if current is None or current[3] != start:
        return False
    try:
        os.kill(pid, signum)
    except OSError:
        return False
    return True


def freeze(root: int, stopped: dict[int, int], proc: Path = PROC) -> None:
    """SIGSTOP every test process under `root`, recording each in `stopped` before signaling it."""
    for _ in range(STALL_PASSES):
        fresh = {pid: start for pid, start in stall_targets(root, read_processes(proc)).items()
                 if pid not in stopped}
        if not fresh:
            return
        for pid, start in fresh.items():
            # Record first: an exit signal landing between the two steps must
            # still find this pid to resume (SIGCONT on a running one is harmless).
            stopped[pid] = start
            if not signal_same(pid, start, signal.SIGSTOP, proc):
                del stopped[pid]


def thaw(stopped: dict[int, int], proc: Path = PROC) -> None:
    for pid, start in list(stopped.items()):
        signal_same(pid, start, signal.SIGCONT, proc)
    stopped.clear()


def resume_all(root: int) -> None:
    """SIGCONT every test process under `root`; harmless for the ones already running."""
    with contextlib.suppress(OSError):
        thaw(stall_targets(root, read_processes()))


def stall_gap(every_ms: int, rng: random.Random) -> float:
    """Seconds until the next stall: uniform in [every/2, 3*every/2], so stalls never merge."""
    return rng.uniform(every_ms / 2, every_ms * 1.5) / 1000


def stall_loop(root: int, pause_ms: int, every_ms: int, log, proc: Path = PROC,
               rng: random.Random | None = None, sleep=time.sleep, clock=time.monotonic) -> None:
    """Freeze the tests under `root` for pause_ms at random intervals until interrupted.

    Logs one JSON line per stall that froze anything; whatever is frozen when
    the loop is interrupted (by SystemExit from a signal) is resumed first.
    """
    rng = rng or random.Random()
    stopped: dict[int, int] = {}
    began = clock()
    try:
        while True:
            sleep(stall_gap(every_ms, rng))
            start = clock()
            freeze(root, stopped, proc)
            frozen = len(stopped)
            if frozen:
                sleep(pause_ms / 1000)
            thaw(stopped, proc)
            if frozen:
                log.write(json.dumps({"at_ms": round((start - began) * 1000), "processes": frozen,
                                      "held_ms": round((clock() - start) * 1000)}) + "\n")
                log.flush()
    finally:
        thaw(stopped, proc)


def stall_main(argv: list[str]) -> int:
    """Entry point of the stall helper process: ROOT_PID PAUSE_MS EVERY_MS LOG."""
    root, pause_ms, every_ms = (int(value) for value in argv[:3])

    def stop(signum, _frame):
        raise SystemExit(0)
    # The runner owns the helper's lifetime: SIGTERM (also the parent-death
    # signal) and SIGHUP resume and exit; a terminal ^C goes to the runner.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    with open(argv[3], "a", encoding="utf-8") as log:
        stall_loop(root, pause_ms, every_ms, log)
    return 0


def read_stalls(log_path: Path) -> list[dict[str, int]]:
    if not log_path.is_file():
        return []
    stalls = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        with contextlib.suppress(ValueError):
            stalls.append(json.loads(line))
    return stalls


class Stall:
    """STALL=1: a helper process that freezes the run's test processes at random intervals."""

    def __init__(self, pause_ms: int, every_ms: int, record_dir: Path) -> None:
        self.pause_ms = pause_ms
        self.every_ms = every_ms
        self.log_path = record_dir / "stall.log"
        self.err_path = record_dir / "stall.err"
        self.failures: list[str] = []

    def settings(self) -> str:
        return f"STALL=1 ({self.pause_ms} ms pauses every ~{self.every_ms} ms)"

    def describe(self) -> str:
        stalls = read_stalls(self.log_path)
        longest = max((stall.get("held_ms", 0) for stall in stalls), default=0)
        text = f"STALL=1 ({self.pause_ms} ms pauses every ~{self.every_ms} ms, {len(stalls)} stall"
        text += "" if len(stalls) == 1 else "s"
        return text + (f", longest {longest} ms)" if stalls else ")")

    def count(self) -> int:
        return len(read_stalls(self.log_path))

    @contextlib.contextmanager
    def attach(self, root: int):
        """Stall the tests under `root` (the nextest command) for the duration."""
        preexec = die_with_parent(os.getpid(), _libc_prctl(), signal.SIGTERM)
        with open(self.err_path, "w", encoding="utf-8") as errors:
            helper = subprocess.Popen(
                [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--stall-helper",
                 str(root), str(self.pause_ms), str(self.every_ms), str(self.log_path)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, preexec_fn=preexec)
            # The runner blocks in stream() until nextest exits, so a helper
            # killed mid-stall (e.g. by the OOM killer) is noticed here, not at
            # exit: otherwise its frozen tests would wait for a nextest timeout.
            # Polled, not wait()ed: a blocked wait() would hold Popen's lock.
            stopping = threading.Event()

            def watch() -> None:
                while not stopping.wait(HELPER_POLL_SECONDS):
                    if helper.poll() is not None:
                        self._helper_died(helper)
                        resume_all(root)
                        return
            watcher = threading.Thread(target=watch, name="stall-helper-watch", daemon=True)
            watcher.start()
            try:
                yield helper
            finally:
                stopping.set()
                watcher.join()
                if helper.poll() is not None:
                    self._helper_died(helper)
                else:
                    helper.terminate()
                    try:
                        helper.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        helper.kill()
                        helper.wait()
                # The helper resumes what it froze on SIGTERM; this sweep also
                # covers one killed in the moment before it was stopped.
                resume_all(root)

    def _helper_died(self, helper: subprocess.Popen) -> None:
        failure = f"stall helper (pid {helper.pid}) exited {helper.returncode}"
        if failure not in self.failures:
            self.failures.append(failure)


def prune(stress_dir: Path, now: float | None = None) -> None:
    cutoff = (time.time() if now is None else now) - MAX_AGE_SECONDS
    if not stress_dir.is_dir():
        return
    for entry in stress_dir.iterdir():
        if ID_RE.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)


def usable_cpus() -> int:
    """CPUs this process may run on (affinity-aware), not the whole host's."""
    counter = getattr(os, "process_cpu_count", None)
    if counter is not None:
        return counter() or 1
    with contextlib.suppress(AttributeError, OSError):
        return len(os.sched_getaffinity(0)) or 1
    return os.cpu_count() or 1


def default_load_cpus() -> int:
    return 2 * usable_cpus()


def stream(command: list[str], cwd: Path, env: dict[str, str], log, tally: StressTally,
           during=None) -> int:
    """Run nextest, teeing its output into the tally; `during(pid)` wraps the run (stalls)."""
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True, errors="replace",
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert process.stdout is not None
    try:
        # Exiting `during` first resumes any frozen test before nextest is told to cancel.
        with during(process.pid) if during else contextlib.nullcontext():
            for line in process.stdout:
                log.write(ANSI_RE.sub("", line))
                sys.stdout.write(line)
                sys.stdout.flush()
                tally.feed(line)
            return process.wait()
    except BaseException:
        # Keep draining nextest's output while it cancels: a full pipe would block
        # it before it can clean up the test processes it started.
        process.terminate()
        try:
            rest, _ = process.communicate(timeout=60)
            log.write(rest or "")
            sys.stdout.write(rest or "")
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise


def run_stress(args, gate) -> int:
    """Run args.filterset args.stress_count times; `gate` is resumable_nextest."""
    label = args.label
    repo_root = Path(args.repo_root).resolve()
    intentd_dir = (repo_root / args.intentd_dir).resolve()
    stress_dir = Path(args.cache_dir).expanduser().resolve() / "stress"
    selection = ["--workspace", "-E", args.filterset]
    env, _, _, cargo_config = gate.prepare_test_env(repo_root, intentd_dir, [selection], label)
    cpus = args.load_cpus if args.load_cpus is not None else default_load_cpus()
    load = f"LOAD=1 ({cpus} cpu + fsync)" if args.load == "1" else "LOAD=0"
    prune(stress_dir)
    record_dir = stress_dir / uuid.uuid4().hex
    record_dir.mkdir(parents=True)
    stall = (Stall(args.stall_ms or DEFAULT_STALL_MS, args.stall_every_ms or DEFAULT_STALL_EVERY_MS, record_dir)
             if args.stall == "1" else None)
    tally = StressTally()
    load_failures: list[str] = []
    status: int | None = None
    gate_lock = None
    with gate.terminate_on_signal():
        try:
            output_args = gate.isolated_output_args(intentd_dir, cargo_config, env)
            gate.apply_storage_policy(output_args, label)
            gate_lock = gate.acquire_gate_lock(output_args)
            print(f"[{label}] {gate.timeout_description(env)}", flush=True)
            # Fail before the build when this nextest cannot stress-test.
            if "--stress-count" not in gate.run(["cargo", "nextest", "run", "--help"], intentd_dir, env):
                raise RuntimeError("this cargo-nextest has no --stress-count; "
                                   "run 'cargo install cargo-nextest --locked' to upgrade")
            # Build (and list) before any load starts, so the load only slows the tests.
            gate.run(["cargo", "nextest", "list", *selection, "--build-jobs", args.build_jobs,
                      "--message-format", "json", *cargo_config, *output_args], intentd_dir, env)
            command = [
                "cargo", "nextest", "run", *selection,
                "--retries", "0", "--stress-count", str(args.stress_count), "--no-fail-fast",
                "--failure-output", "immediate", "--success-output", "never",
                # The tally counts one status line per run: never let the
                # environment or a profile hide PASS lines.
                "--status-level", "pass", "--final-status-level", "fail",
                "--build-jobs", args.build_jobs, "--test-threads", args.test_threads,
                *cargo_config, *output_args,
            ]
            (record_dir / "command.json").write_text(json.dumps(command, indent=2) + "\n")
            print(f"[{label}] {load}, {stall.settings() if stall else 'STALL=0'}; "
                  f"running {args.stress_count} iterations with retries off", flush=True)
            with open(record_dir / "output.log", "w", encoding="utf-8") as log, \
                    tempfile.TemporaryDirectory(prefix="load-", dir=stress_dir) as scratch, \
                    (stress_load(cpus, Path(scratch), record_dir / "load.err") if args.load == "1"
                     else contextlib.nullcontext([])) as workers:
                status = stream(command, intentd_dir, env, log, tally, stall.attach if stall else None)
                # A worker that died mid-run means the advertised load did not hold.
                load_failures = exited_early(workers)
        except subprocess.CalledProcessError as error:
            print(f"[{label}] ERROR: {error}", file=sys.stderr, flush=True)
            status = gate.failure_exit_code(error)
        except (KeyboardInterrupt, gate.Terminated) as error:
            print(f"[{label}] ERROR: interrupted: {error}", file=sys.stderr, flush=True)
            status = gate.failure_exit_code(error)
        finally:
            if gate_lock is not None:
                gate.release_gate_lock(gate_lock)
            counts = tally.counts()
            if status == 0 and counts["failed"]:
                status = 1
            line = summary_line(label, counts, f"{load}, {stall.describe() if stall else 'STALL=0'}", status)
            invalid = False
            if load_failures:
                invalid = True
                print(f"[{label}] ERROR: load worker(s) stopped during the run: {'; '.join(load_failures)} "
                      f"(stderr in {record_dir / 'load.err'})", file=sys.stderr, flush=True)
                line += f"; INVALID: {len(load_failures)} load worker(s) stopped early, so the load did not hold"
            if stall and stall.failures:
                invalid = True
                print(f"[{label}] ERROR: {'; '.join(stall.failures)} during the run "
                      f"(stderr in {stall.err_path})", file=sys.stderr, flush=True)
                line += "; INVALID: the stall helper stopped early, so the stalls did not hold"
            elif stall and counts["iterations"] and not stall.count():
                invalid = True
                line += ("; INVALID: no stall froze a test process "
                         "(raise COUNT or lower STALL_EVERY_MS so stalls overlap the tests)")
            if invalid and status == 0:
                status = INVALID_EXIT
            (record_dir / "summary.txt").write_text(line + "\n", encoding="utf-8")
            (record_dir / "summary.json").write_text(json.dumps({
                **counts, "filterset": args.filterset, "stress_count": args.stress_count,
                "load": args.load == "1", "load_cpus": cpus if args.load == "1" else 0,
                "load_failures": load_failures, "stall": stall is not None,
                "stall_ms": stall.pause_ms if stall else 0, "stall_every_ms": stall.every_ms if stall else 0,
                "stalls": stall.count() if stall else 0, "stall_failures": stall.failures if stall else [],
                "exit_code": status, "test_timeout_multiplier": env.get(gate.TIMEOUT_MULTIPLIER_ENV),
            }, indent=2) + "\n", encoding="utf-8")
            print(line, flush=True)
            print(f"[{label}] record: {record_dir}", flush=True)
    return status if status is not None else 1


if __name__ == "__main__":
    if sys.argv[1:2] != ["--stall-helper"] or len(sys.argv) != 6:
        sys.exit("usage: nextest_stress.py --stall-helper ROOT_PID PAUSE_MS EVERY_MS LOG "
                 "(started by make test-stress STALL=1)")
    sys.exit(stall_main(sys.argv[2:]))
