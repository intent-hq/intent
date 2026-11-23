#!/usr/bin/env python3
"""Three-way stress triage of a merge-queue ejection (`make flake-triage`).

When a PR is ejected by a test it did not touch, the question is whose fault
the failure is. This runs `make test-stress` on three intentd revisions, each
in its own detached worktree, and compares the failure counts:

  main    BASE (default: a fresh origin/main)
  merged  BASE plus the PR head (a --no-ff merge), the tree the queue tests
  pr      the PR head alone

and prints a Markdown table with one verdict per test: "fails on main",
"caused by this PR" or "inconclusive". The merged run is compared with main
(one-sided Fisher exact test on failing runs, p < 0.05); the PR-alone run only
adds notes (a failure that needs newer main, or one main already fixed).

E is a nextest filterset. RUN=<GitHub Actions run URL> reads the run's failed
logs with gh, builds E from the tests whose final status failed (a test that
passed on retry did not eject anything), and takes the PR from the merge-queue
branch name (gh-readonly-queue/main/pr-<N>-<sha>). Unless BASE is set, it then
replays that queue entry: main is the <sha> it was built on and merged is the
run's own head commit, so PRs queued ahead and later pushes to main or the PR
do not change what is compared.

The worktrees live at stable paths under GATE_CACHE_DIR/flake-triage/worktrees/
<checkout hash>/{main,merged,pr}, so a repeat run reuses their Cargo outputs; a
lock keeps two triages of one checkout apart. A revision whose tree matches one
already stressed is not run again. Each run's output and a report (report.md,
report.json) are kept under GATE_CACHE_DIR/flake-triage/runs/<id>/ for seven
days.

Exit status: 0 with a verdict, 1 when the main or merged stress run did not
complete or its load or stalls did not hold (the verdict is then
inconclusive), 2 on a usage or setup error.
"""

from __future__ import annotations

import argparse
import contextlib
from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

if __package__:
    from .nextest_stress import ANSI_RE, PASS_STATUSES
else:
    from nextest_stress import ANSI_RE, PASS_STATUSES

LABEL = "[flake-triage]"
FAILS_ON_MAIN = "fails on main"
CAUSED_BY_PR = "caused by this PR"
INCONCLUSIVE = "inconclusive"
# A test the filter selected that never failed anywhere: it takes no part in the verdict.
NO_FAILURES = "no failures"
ALPHA = 0.05
ROLES = ("main", "merged", "pr")
# make test-stress knobs passed through unchanged; make test-stress validates the rest.
STRESS_ARGS = ("COUNT", "LOAD", "LOAD_CPUS", "LOAD_CORES", "STALL", "STALL_MS", "STALL_EVERY_MS",
               "FEATURES", "HERMETIC", "TEST_THREADS", "BUILD_JOBS")
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
DEFAULT_REPO = "intent-hq/intentd"

RUN_URL_RE = re.compile(
    r"^https://github\.com/(?P<repo>[\w.-]+/[\w.-]+)/actions/runs/(?P<run>\d+)"
    r"(?:/attempts/(?P<attempt>\d+))?(?:/job/(?P<job>\d+))?(?:/attempts/(?P<attempt2>\d+))?/?(?:[?#].*)?$")
QUEUE_BRANCH_RE = re.compile(r"^gh-readonly-queue/.+/pr-(?P<pr>\d+)-(?P<base>[0-9a-f]{7,})$")
# `gh run view --log-failed` prefixes every line with "<job>\t<step>\t<timestamp> ".
LOG_PREFIX_RE = re.compile(r"^(?P<job>[^\t\n]*)\t[^\t\n]*\t\d{4}-\d\d-\d\dT[\d:.]+Z ?")
# ...and prints each color code's escape byte as the text "^[".
LOG_COLOR_RE = re.compile(r"(?:\x1b|\^\[)\[[0-9;?]*[A-Za-z]")
# A nextest status line: "  TRY 2 FAIL [   2.063s] (12042/18563) intentd::bin/intentd mod::test".
STATUS_RE = re.compile(
    r"^\s*(?:TRY \d+ )?(?P<status>[A-Z][A-Z0-9 +-]*?)\s+\[[^\]]*\]\s+(?:\[[^\]]*\]\s+)?(?:\([^)]*\)\s+)?"
    r"(?P<binary>\S+)\s+(?P<test>\S+)\s*$")
FAIL_STATUSES = {"FAIL", "FAIL + LEAK", "LEAK-FAIL", "LKFAIL", "TIMEOUT", "ABORT", "XFAIL"}
RECORD_RE = re.compile(r"^\[test-stress\] record: (?P<path>.+?)\s*$")


class TriageError(Exception):
    """A usage or setup error: nothing was stressed."""


def say(message: str) -> None:
    print(f"{LABEL} {message}", flush=True)


# --- inputs -----------------------------------------------------------------

def parse_run_url(url: str) -> tuple[str | None, str, str | None, str | None]:
    """(repo, run id, job id, attempt) of a GitHub Actions run URL or bare run id."""
    url = url.strip()
    if url.isdigit():
        return None, url, None, None
    match = RUN_URL_RE.match(url)
    if not match:
        raise TriageError(f"RUN={url!r} is not a GitHub Actions run URL "
                          "(https://github.com/<owner>/<repo>/actions/runs/<id>[/job/<id>])")
    return match["repo"], match["run"], match["job"], match["attempt"] or match["attempt2"]


def queue_pr(head_branch: str) -> int | None:
    match = QUEUE_BRANCH_RE.match(head_branch or "")
    return int(match["pr"]) if match else None


def queue_base(head_branch: str) -> str | None:
    """The commit a merge-queue entry was built on (main, or the entry queued ahead of it)."""
    match = QUEUE_BRANCH_RE.match(head_branch or "")
    return match["base"] if match else None


def failing_tests(log: str) -> list[tuple[str, str]]:
    """(binary id, test) of every test whose last status in some job's log is a failure, in first-seen order.

    --log-failed joins the logs of every failed job, so a pass in one job must not hide a failure in another.
    """
    last: dict[tuple[str, str, str], bool] = {}
    for raw in log.splitlines():
        prefix = LOG_PREFIX_RE.match(raw)
        job = prefix["job"] if prefix else ""
        line = LOG_COLOR_RE.sub("", raw[prefix.end():] if prefix else raw).replace("\r", "")
        match = STATUS_RE.match(line)
        if not match:
            continue
        status = match["status"]
        if status in PASS_STATUSES:
            failed = False
        elif status in FAIL_STATUSES or status.startswith("SIG"):
            failed = True
        else:
            continue
        last[(job, match["binary"], match["test"])] = failed
    return list(dict.fromkeys(key[1:] for key, failed in last.items() if failed))


def filterset_for(tests: list[tuple[str, str]]) -> str:
    return " | ".join(f"(binary_id(={binary}) & test(={test}))" for binary, test in tests)


def gh(*args: str) -> str:
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=300)
    except FileNotFoundError:
        raise TriageError("RUN= needs the gh CLI (run make bootstrap-dev-host, then gh auth login)") from None
    if result.returncode != 0:
        raise TriageError(f"gh {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def read_run(url: str) -> tuple[str, dict, list[tuple[str, str]]]:
    """Repo, run metadata and the failing tests of a run."""
    repo, run, job, attempt = parse_run_url(url)
    repo = repo or DEFAULT_REPO
    if repo.rsplit("/", 1)[-1] != "intentd":
        raise TriageError(f"RUN is a {repo} run, but make flake-triage stresses intentd tests")
    meta = json.loads(gh("run", "view", run, "--repo", repo, "--json", "headBranch,event,headSha,url",
                         *(["--attempt", attempt] if attempt else [])))
    if job:
        log = gh("run", "view", "--job", job, "--repo", repo, "--log-failed")
    else:
        log = gh("run", "view", run, "--repo", repo, "--log-failed", *(["--attempt", attempt] if attempt else []))
    return repo, meta, failing_tests(log)


# --- statistics and verdict -----------------------------------------------

def p_worse(failed: int, runs: int, base_failed: int, base_runs: int) -> float:
    """One-sided Fisher exact p-value that `failed/runs` fails more often than `base_failed/base_runs`."""
    total, failures = runs + base_runs, failed + base_failed
    if failures == 0 or runs == 0 or base_runs == 0:
        return 1.0
    hits = sum(math.comb(failures, k) * math.comb(total - failures, runs - k)
               for k in range(failed, min(failures, runs) + 1))
    return hits / math.comb(total, runs)


@dataclass
class Cell:
    """One test on one revision: state is ran, absent, conflict, error or invalid."""
    state: str
    runs: int = 0
    failed: int = 0
    detail: str = ""

    def text(self) -> str:
        if self.state == "ran":
            return f"{self.failed}/{self.runs}"
        return {"absent": "not present", "conflict": "merge conflict"}.get(self.state, self.state)


def significantly_worse(cell: Cell, base: Cell) -> bool:
    return (cell.failed * base.runs > base.failed * cell.runs
            and p_worse(cell.failed, cell.runs, base.failed, base.runs) < ALPHA)


def verdict(main: Cell, merged: Cell, pr: Cell) -> tuple[str, list[str]]:
    notes: list[str] = []
    treated, name = merged, "merged"
    if merged.state == "conflict":
        notes.append("the PR does not merge cleanly onto main, so the PR head stands in for the merged tree")
        treated, name = pr, "PR head"
    if main.state in ("error", "invalid"):
        return INCONCLUSIVE, notes + [f"the main run did not complete ({main.detail or main.state})"]
    if treated.state != "ran" and treated.state != "absent":
        return INCONCLUSIVE, notes + [f"the {name} run did not complete ({treated.detail or treated.state})"]
    if treated.state == "absent":
        return INCONCLUSIVE, notes + [f"the test is not in the {name} tree"]
    rate = f"{treated.failed}/{treated.runs}"
    if main.state == "absent":
        if treated.failed:
            return CAUSED_BY_PR, notes + [f"the test is not on main and fails {rate} with this PR"]
        return INCONCLUSIVE, notes + ["the test is not on main and never failed with this PR"]
    pr_ran = treated is merged and pr.state == "ran"
    if significantly_worse(treated, main):
        result = CAUSED_BY_PR
        if main.failed:
            notes.append(f"main also fails {main.failed}/{main.runs}, but this PR makes it worse ({rate})")
        if pr_ran and not significantly_worse(pr, main):
            notes.append(f"it fails only once merged with main ({rate}; PR alone {pr.failed}/{pr.runs}): "
                         "the PR interacts with a newer main change, so update the branch to reproduce it")
    elif main.failed:
        result = FAILS_ON_MAIN
    elif treated.failed:
        result = INCONCLUSIVE
        notes.append(f"{rate} with the PR against 0/{main.runs} on main is too few failures to tell; raise COUNT")
    else:
        result = INCONCLUSIVE
        notes.append("no revision failed; raise COUNT or try LOAD=1 or STALL=1")
    if result != CAUSED_BY_PR and pr_ran and pr.failed and not merged.failed:
        notes.append(f"it fails on the PR branch alone ({pr.failed}/{pr.runs}) but not merged with main: "
                     "main may already have the fix, so update the branch")
    return result, notes


def overall(verdicts: list[str]) -> str:
    if CAUSED_BY_PR in verdicts:
        return CAUSED_BY_PR
    if verdicts and all(v == FAILS_ON_MAIN for v in verdicts):
        return FAILS_ON_MAIN
    return INCONCLUSIVE


# --- git ---------------------------------------------------------------------

def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_MERGE_AUTOEDIT": "no"}
    result = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=env)
    if check and result.returncode != 0:
        raise TriageError(f"git {' '.join(args)} failed in {cwd}: {result.stderr.strip()}")
    return result


def rev_parse(cwd: Path, ref: str) -> str | None:
    result = git(cwd, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def fetch(src: Path, remote: str, refspec: str) -> bool:
    return git(src, "fetch", "--quiet", "--no-tags", remote, refspec, check=False).returncode == 0


def resolve_base(src: Path, remote: str, base: str) -> tuple[str, str]:
    base = base or f"{remote}/main"
    if base.startswith(f"{remote}/"):
        branch = base[len(remote) + 1:]
        if not fetch(src, remote, f"+refs/heads/{branch}:refs/remotes/{base}"):
            say(f"WARNING: could not fetch {base}; using the local copy")
    commit = rev_parse(src, base)
    if commit is None and fetch(src, remote, base):
        commit = rev_parse(src, "FETCH_HEAD")
    if commit is None:
        raise TriageError(f"BASE={base} is not a commit in {src} or on {remote}")
    return commit, "BASE" if commit.startswith(base.lower()) else base


def resolve_queue_commit(src: Path, remote: str, sha: str) -> str | None:
    """The merge-queue commit a run tested; its branch is usually deleted, so fetch it by SHA."""
    commit = rev_parse(src, sha)
    if commit is None and fetch(src, remote, f"+{sha}:refs/flake-triage/queue"):
        commit = rev_parse(src, "refs/flake-triage/queue")
    return commit


def resolve_pr(src: Path, remote: str, pr: int) -> str:
    ref = f"refs/flake-triage/pr-{pr}"
    if not fetch(src, remote, f"+refs/pull/{pr}/head:{ref}"):
        raise TriageError(f"could not fetch PR #{pr}'s head (refs/pull/{pr}/head) from {remote}")
    return rev_parse(src, ref)


def resolve_branch(src: Path, remote: str, branch: str) -> str:
    ref = "refs/flake-triage/branch"
    if fetch(src, remote, f"+refs/heads/{branch}:{ref}"):
        return rev_parse(src, ref)
    commit = rev_parse(src, branch)
    if commit is None:
        raise TriageError(f"BRANCH={branch} is neither on {remote} nor a local ref in {src}")
    say(f"WARNING: {branch} is not on {remote}; using the local ref")
    return commit


def worktree_root(cache_dir: Path, src: Path) -> Path:
    owner = hashlib.sha256(os.fsencode(src.resolve())).hexdigest()[:16]
    return cache_dir / "flake-triage" / "worktrees" / owner


def common_dir(path: Path) -> str | None:
    result = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def checkout(src: Path, path: Path, commit: str) -> None:
    """Detach `path` at `commit`, reusing an earlier worktree (and its ignored build outputs) when it is ours."""
    if (path / ".git").exists() and common_dir(path) == common_dir(src):
        git(path, "merge", "--abort", check=False)
        git(path, "reset", "--quiet", "--hard")
        git(path, "clean", "--quiet", "-fd")
        git(path, "checkout", "--quiet", "--detach", "--force", commit)
        return
    if path.exists():
        shutil.rmtree(path)
    git(src, "worktree", "prune")
    path.parent.mkdir(parents=True, exist_ok=True)
    git(src, "worktree", "add", "--quiet", "--detach", "--force", str(path), commit)


def merge(path: Path, head: str) -> bool:
    result = git(path, "-c", "user.name=flake-triage", "-c", "user.email=flake-triage@localhost",
                 "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                 "merge", "--quiet", "--no-ff", "--no-edit", "-m", "flake-triage: merge the PR head into main",
                 head, check=False)
    if result.returncode != 0:
        git(path, "merge", "--abort", check=False)
        return False
    return True


@contextlib.contextmanager
def triage_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with open(root / "lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TriageError(f"another make flake-triage is using {root}; wait for it to finish") from None
        yield


# --- stress runs ---------------------------------------------------------------

@dataclass
class Revision:
    role: str
    commit: str
    describe: str
    tree: str = ""
    state: str = "pending"
    detail: str = ""
    record: str = ""
    summary: dict | None = None
    same_as: str = ""

    def cell(self, test: str) -> Cell:
        if self.state != "ran":
            return Cell(self.state, detail=self.detail)
        entry = (self.summary or {}).get("by_test", {}).get(test)
        return Cell("ran", entry["runs"], entry["failed"]) if entry else Cell("absent")

    def result(self) -> str:
        if self.same_as:
            prefix = f"same tree as {self.same_as}: "
        else:
            prefix = ""
        if self.state == "ran":
            summary = self.summary or {}
            text = f"{summary.get('failed_iterations', 0)}/{summary.get('iterations', 0)} iterations failed"
        elif self.state == "absent":
            text = "the filter selects no test"
        elif self.state == "conflict":
            text = "the PR does not merge cleanly onto main"
        else:
            text = f"did not complete ({self.detail})"
        return prefix + text

    def failures(self) -> str:
        failures = (self.summary or {}).get("failures") or {}
        top = list(failures.items())[:3]
        return ", ".join(f"{where} ×{count}" for where, count in top)


def child_env() -> dict[str, str]:
    # A clean top-level make: the outer make's command-line variables must not reach it.
    return {k: v for k, v in os.environ.items() if k not in {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"}}


def stress(revision: Revision, path: Path, args, stress_args: list[str], run_dir: Path) -> None:
    command = ["make", "-C", str(args.repo_root), "--no-print-directory", "test-stress",
               f"INTENTD_DIR={path}", f"E={args.filterset}", f"GATE_CACHE_DIR={args.cache_dir}", *stress_args]
    record = None
    with open(run_dir / f"{revision.role}.log", "w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                   errors="replace", env=child_env())
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
            match = RECORD_RE.match(ANSI_RE.sub("", line))
            if match:
                record = match["path"]
        code = process.wait()
    summary = None
    if record:
        with contextlib.suppress(OSError, ValueError):
            summary = json.loads((Path(record) / "summary.json").read_text(encoding="utf-8"))
    revision.record = record or str(run_dir / f"{revision.role}.log")
    if summary is None:
        revision.state, revision.detail = "error", f"exit {code}, no stress summary; see {run_dir / revision.role}.log"
        return
    revision.summary = summary
    status = summary.get("exit_code")
    failed = any(entry.get("failed") for entry in summary.get("by_test", {}).values())
    # nextest_stress keeps exit 1 when a test failed, even if the load or stalls did not hold.
    if summary.get("load_failures"):
        invalid = "a load worker stopped early"
    elif summary.get("stall_failures"):
        invalid = "the stall helper stopped early"
    elif summary.get("stall") and summary.get("iterations") and not summary.get("stalls"):
        invalid = "no stall froze a test"
    else:
        invalid = "the load or stalls did not hold" if status == 3 else ""
    if status == 4:
        revision.state = "absent"
    elif invalid:
        revision.state, revision.detail = "invalid", f"INVALID: {invalid}; see {revision.record}"
    elif status == 0 or (status == 1 and failed):
        revision.state = "ran"
    else:
        revision.state, revision.detail = "error", f"exit {status}; see {revision.record}"


# --- report ----------------------------------------------------------------------

def prune(runs_dir: Path) -> None:
    if not runs_dir.is_dir():
        return
    cutoff = time.time() - MAX_AGE_SECONDS
    for entry in runs_dir.iterdir():
        with contextlib.suppress(OSError):
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry)


def markdown(title: str, revisions: dict[str, Revision], tests: list[dict], notes: list[str]) -> str:
    lines = [f"## {title}", "", "| revision | commit | result | failures | record |", "|---|---|---|---|---|"]
    for role in ROLES:
        rev = revisions[role]
        lines.append(f"| {role} | {rev.commit[:10]} {rev.describe} | {rev.result()} | {rev.failures()} | "
                     f"{rev.record} |")
    lines += ["", "| test | main | merged | pr | verdict |", "|---|---|---|---|---|"]
    for test in tests:
        cells = " | ".join(Cell(**test["cells"][role]).text() for role in ROLES)
        lines.append(f"| `{test['test']}` | {cells} | {test['verdict']} |")
    if notes:
        lines.append("")
        lines += [f"- {note}" for note in notes]
    return "\n".join(lines) + "\n"


def triage(args) -> int:
    for item in args.stress_arg:
        name, _, value = item.partition("=")
        if name not in STRESS_ARGS:
            raise TriageError(f"--stress-arg {name}= is not a make test-stress knob this command passes on "
                              f"({', '.join(STRESS_ARGS)})")
        if name == "COUNT" and not (value.isdigit() and int(value) > 0):
            raise TriageError(f"COUNT must be a positive integer, got {value!r}")
        if name in ("LOAD", "STALL") and value not in ("0", "1"):
            raise TriageError(f"{name} must be 0 or 1, got {value!r}")
    if args.pr and args.branch:
        raise TriageError("pass PR=<number> or BRANCH=<ref>, not both")
    if args.pr and not args.pr.isdigit():
        raise TriageError(f"PR must be a number, got {args.pr!r}")
    if args.run:
        parse_run_url(args.run)
    elif not args.filterset:
        raise TriageError("make flake-triage needs E='<nextest filterset>' or RUN=<merge_group run URL>")
    elif not (args.pr or args.branch):
        raise TriageError("make flake-triage needs PR=<number> or BRANCH=<ref> for the intentd change")

    repo = DEFAULT_REPO
    queue_head = ""
    if args.run:
        repo, meta, tests = read_run(args.run)
        head_branch = meta.get("headBranch") or ""
        say(f"run {meta.get('url') or args.run}: {meta.get('event')} on {head_branch}")
        if not (args.pr or args.branch):
            number = queue_pr(head_branch)
            if number is not None:
                args.pr = str(number)
            elif head_branch:
                args.branch = head_branch
            else:
                raise TriageError("the run names no branch; pass PR=<number> or BRANCH=<ref>")
        if not args.filterset:
            if not tests:
                raise TriageError("found no failed nextest test in the run's failed logs "
                                  "(a build or setup failure?); pass E='<nextest filterset>'")
            say("failing tests: " + ", ".join(f"{binary} {test}" for binary, test in tests))
            args.filterset = filterset_for(tests)
        # Replay the queue entry itself: its base and the merged commit it tested. An explicit BASE
        # asks for a different main, so the PR is merged onto that instead.
        if not args.base and meta.get("event") == "merge_group" and queue_base(head_branch) and meta.get("headSha"):
            args.base, queue_head = queue_base(head_branch), meta["headSha"]

    repo_root = Path(args.repo_root)
    src = (repo_root / args.intentd_dir).resolve()
    cache_dir = Path(args.cache_dir).expanduser()
    root = worktree_root(cache_dir, src)
    with triage_lock(root):
        base, base_name = resolve_base(src, args.remote, args.base)
        if args.pr:
            target = f"{repo} PR #{args.pr}"
            head = resolve_pr(src, args.remote, int(args.pr))
        else:
            target = f"{repo} {args.branch}"
            head = resolve_branch(src, args.remote, args.branch)
        revisions = {
            "main": Revision("main", base, "the queue base" if queue_head else base_name),
            "merged": Revision("merged", "", "main + the PR head, as the merge queue tests it"),
            "pr": Revision("pr", head, "the PR head"),
        }
        if queue_head:
            queued = resolve_queue_commit(src, args.remote, queue_head)
            if queued:
                revisions["merged"].commit = queued
                revisions["merged"].describe = "the merge-queue commit the run tested"
            else:
                say(f"WARNING: could not fetch the queue commit {queue_head[:10]}; "
                    "rebuilding merged as the queue base + the PR head")
        knobs = ", ".join(args.stress_arg) or "make test-stress defaults"
        say(f"{target} against {base_name} {base[:10]} ({knobs}); E={args.filterset}")
        runs_dir = cache_dir / "flake-triage" / "runs"
        prune(runs_dir)
        run_dir = runs_dir / uuid.uuid4().hex
        run_dir.mkdir(parents=True)
        seen: dict[str, Revision] = {}
        remerge = not revisions["merged"].commit
        for role in ROLES:
            rev = revisions[role]
            path = root / role
            if role == "merged" and remerge:
                checkout(src, path, base)
                if not merge(path, head):
                    rev.state = "conflict"
                    say("merged: the PR does not merge cleanly onto main; skipping it")
                    continue
                rev.commit = git(path, "rev-parse", "HEAD").stdout.strip()
            rev.tree = git(src, "rev-parse", f"{rev.commit}^{{tree}}").stdout.strip()
            if rev.tree in seen:
                same = seen[rev.tree]
                rev.same_as, rev.state, rev.detail = same.role, same.state, same.detail
                rev.summary, rev.record = same.summary, same.record
                say(f"{role}: same tree as {same.role}; not stressed again")
                continue
            if not (role == "merged" and remerge):
                checkout(src, path, rev.commit)
            say(f"{role}: stressing {rev.commit[:10]} ({rev.describe}) in {path}")
            stress(rev, path, args, args.stress_arg, run_dir)
            seen[rev.tree] = rev

    names: list[str] = []
    for role in ROLES:
        for name in (revisions[role].summary or {}).get("by_test", {}):
            if name not in names:
                names.append(name)
    tests, notes = [], []
    for name in names or ["(the selected tests)"]:
        cells = {role: revisions[role].cell(name) for role in ROLES}
        healthy = (any(c.state == "ran" for c in cells.values())
                   and all(c.state in ("ran", "absent") and not c.failed for c in cells.values()))
        if healthy:
            result, test_notes = NO_FAILURES, []
        else:
            result, test_notes = verdict(cells["main"], cells["merged"], cells["pr"])
        tests.append({"test": name, "verdict": result, "notes": test_notes,
                      "cells": {role: vars(cell) for role, cell in cells.items()}})
        prefix = f"{name}: " if len(names) > 1 else ""
        notes += [prefix + note for note in test_notes]
    deciding = [test["verdict"] for test in tests if test["verdict"] != NO_FAILURES]
    final = overall(deciding)
    if not deciding:
        notes.append("no revision failed; raise COUNT or try LOAD=1 or STALL=1")
    title = f"Flake triage: {target} vs {base_name} {base[:10]}"
    report = markdown(title, revisions, tests, notes)
    (run_dir / "report.md").write_text(report, encoding="utf-8")
    (run_dir / "report.json").write_text(json.dumps({
        "verdict": final, "repo": repo, "pr": int(args.pr) if args.pr else None, "branch": args.branch or None,
        "run": args.run or None, "base": base_name, "filterset": args.filterset, "stress_args": args.stress_arg,
        "revisions": {role: {"commit": rev.commit, "tree": rev.tree, "state": rev.state, "detail": rev.detail,
                             "same_as": rev.same_as or None, "record": rev.record, "summary": rev.summary}
                      for role, rev in revisions.items()},
        "tests": tests,
    }, indent=2) + "\n", encoding="utf-8")
    print("\n" + report, flush=True)
    say(f"verdict: {final}")
    say(f"report: {run_dir}")
    compared = revisions["pr"] if revisions["merged"].state == "conflict" else revisions["merged"]
    incomplete = any(rev.state in ("error", "invalid") for rev in (revisions["main"], compared))
    return 1 if incomplete else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--intentd-dir", default="packages/intentd")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--filterset", default="", help="nextest filterset (make E=)")
    parser.add_argument("--pr", default="", help="intentd PR number (make PR=)")
    parser.add_argument("--branch", default="", help="intentd branch or ref (make BRANCH=)")
    parser.add_argument("--run", default="", help="GitHub Actions run URL (make RUN=)")
    parser.add_argument("--base", default="", help="main revision (make BASE=; default a fresh origin/main)")
    parser.add_argument("--stress-arg", action="append", default=[], metavar="NAME=VALUE",
                        help="make test-stress variable, e.g. COUNT=200")
    args = parser.parse_args(argv)
    try:
        return triage(args)
    except TriageError as error:
        print(f"{LABEL} ERROR: {error}", file=sys.stderr, flush=True)
        return 2
    except KeyboardInterrupt:
        print(f"{LABEL} ERROR: interrupted", file=sys.stderr, flush=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
