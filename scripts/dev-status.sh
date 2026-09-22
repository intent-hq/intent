#!/usr/bin/env bash
# JSON schema:
# {"host":{"doctorOk":bool,"gaps":[string],
#  "coverageTooling":{"ready":bool,"detail":string}},"ports":{},"sandboxes":[],
#  "repos":{"name":{"branch":string|null,"dirty":bool,"ahead":int|null,
#  "behind":int|null,"pin":string|null,"gitlinkDirty":bool,
#  "behindOriginMain":int|null,
#  "pr?":{"number":int,"url":string,"state":string,
#  "checks":{"total":int,"passing":int,"failing":int,"pending":int}}}},
#  "docs":{"remoteHost":"AGENTS.md#developing-on-a-remote-host"}}
# Knobs: STATUS_JSON=1 (or --json) emits JSON; DEV_STATUS_PORT_TIMEOUT=<seconds>
# bounds the scripts/dev-ports.sh probe behind "ports" (default 10, fractional ok);
# DEV_STATUS_PROBE_TIMEOUT=<seconds> bounds every other probe (doctor, sandbox
# status and health, git, gh; default 10, fractional ok). Either knob is ignored
# with a warning unless it is a positive number of at most 86400 seconds.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
json_output=${STATUS_JSON:-0}
if [[ ${1:-} == --json ]]; then
  json_output=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--json]" >&2
  exit 2
fi

exec python3 - "$repo_root" "$json_output" <<'PY'
import functools
import json
import math
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

root, json_output = sys.argv[1], sys.argv[2] == "1"

# subprocess/socket timeouts overflow their C representation for huge finite
# values (1e20 raised OverflowError instead of degrading), so one day is the
# ceiling either knob accepts.
TIMEOUT_MAX = 86400.0


def timeout_from_env(name, default):
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        value = None
    if value is None or not math.isfinite(value) or value <= 0 or value > TIMEOUT_MAX:
        print(
            f"dev-status: ignoring {name}={raw!r} "
            f"(expected a positive number of seconds, at most {TIMEOUT_MAX:g}); "
            f"using {default:g}",
            file=sys.stderr,
        )
        return default
    return value


# One scripts/dev-ports.sh run costs at least one python3 startup per candidate
# port block (~0.8 s each on a loaded host, more when explicit ports are set or
# the preferred block is busy); the former 2 s budget emptied "ports" under
# load, and 10 s keeps generous headroom for loaded hosts while still bounding
# the report.
PORT_TIMEOUT_DEFAULT = 10.0

# The doctor (bootstrap-dev-host.sh --check) and dev-sandbox.sh status each
# cost ~0.9 s on a 32-core host at load average 16 and exceeded the former 3 s
# budget at load ~50, emptying "sandboxes"; 10 s matches the port knob's
# headroom. Every non-port probe (doctor, sandbox status and health, git, gh)
# shares this budget.
PROBE_TIMEOUT_DEFAULT = 10.0


@functools.lru_cache(maxsize=None)
def port_timeout():
    return timeout_from_env("DEV_STATUS_PORT_TIMEOUT", PORT_TIMEOUT_DEFAULT)


@functools.lru_cache(maxsize=None)
def probe_timeout():
    return timeout_from_env("DEV_STATUS_PROBE_TIMEOUT", PROBE_TIMEOUT_DEFAULT)


def run(command, *, cwd=root, env=None, timeout=None):
    if timeout is None:
        timeout = probe_timeout()
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


COVERAGE_UNKNOWN = {"ready": False, "detail": "unknown"}


def coverage_tooling(lines):
    # Derived from the doctor's "[optional] cargo-llvm-cov: ..." row; ready only
    # when both cargo-llvm-cov and llvm-tools-preview are present.
    for line in lines:
        detail = line.removeprefix("[optional] ").strip()
        if line.startswith("[optional] ") and detail.startswith("cargo-llvm-cov:"):
            return {"ready": "with llvm-tools-preview" in detail, "detail": detail}
    return dict(COVERAGE_UNKNOWN)


def doctor_status():
    result = run([os.path.join(root, "scripts/bootstrap-dev-host.sh"), "--check"])
    if result is None:
        return {
            "doctorOk": False,
            "gaps": ["doctor check could not complete"],
            "coverageTooling": dict(COVERAGE_UNKNOWN),
        }
    lines = result.stdout.splitlines()
    gaps = []
    for line in lines:
        if line.startswith("[missing]  "):
            gaps.append(line.removeprefix("[missing]  ").strip())
    return {
        "doctorOk": result.returncode == 0,
        "gaps": gaps,
        "coverageTooling": coverage_tooling(lines),
    }


def port_status():
    result = run([os.path.join(root, "scripts/dev-ports.sh")], timeout=port_timeout())
    ports = {}
    if result is None or result.returncode != 0:
        return ports
    for line in result.stdout.splitlines():
        name, separator, value = line.partition("=")
        if separator and value.isdigit():
            ports[name] = int(value)
    return ports


def sandbox_status():
    env = os.environ.copy()
    env["SANDBOX_JSON"] = "1"
    env["SANDBOX_STATUS_READ_ONLY"] = "1"
    result = run([os.path.join(root, "scripts/dev-sandbox.sh"), "status"], env=env)
    if result is None:
        return []
    try:
        states = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(states, list):
        return []
    for state in states:
        if isinstance(state, dict):
            state["health"] = sandbox_health(state.get("url"))
    return states


def sandbox_health(url):
    if not isinstance(url, str) or not url:
        return None
    health_url = urllib.parse.urljoin(url.rstrip("/") + "/", "__sandbox/health")
    try:
        with urllib.request.urlopen(health_url, timeout=probe_timeout()) as response:
            payload = json.load(response)
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def git_output(path, *arguments):
    result = run(["git", "-C", path, *arguments])
    if result is None or result.returncode != 0:
        return None
    return result.stdout.strip()


def check_summary(rollup):
    summary = {"total": 0, "passing": 0, "failing": 0, "pending": 0}
    failure_states = {"ACTION_REQUIRED", "CANCELLED", "FAILURE", "STALE", "TIMED_OUT"}
    for check in rollup if isinstance(rollup, list) else []:
        if not isinstance(check, dict):
            continue
        summary["total"] += 1
        status = str(check.get("status") or "").upper()
        conclusion = str(check.get("conclusion") or "").upper()
        state = str(check.get("state") or "").upper()
        if conclusion in failure_states or state in failure_states:
            summary["failing"] += 1
        elif status not in {"", "COMPLETED"} or state in {"EXPECTED", "PENDING", "QUEUED"}:
            summary["pending"] += 1
        elif conclusion or state:
            summary["passing"] += 1
        else:
            summary["pending"] += 1
    return summary


def branch_pr(path, branch):
    result = run(
        ["gh", "pr", "list", "--head", branch, "--state", "open", "--limit", "1",
         "--json", "number,url,state,statusCheckRollup"],
        cwd=path,
    )
    if result is None or result.returncode != 0:
        return None
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    if not rows:
        return None
    row = rows[0]
    return {
        "number": row["number"],
        "url": row["url"],
        "state": row["state"],
        "checks": check_summary(row.get("statusCheckRollup")),
    }


def recorded_pin(relative_path):
    entry = git_output(root, "ls-tree", "HEAD", "--", relative_path)
    if not entry:
        return None
    fields = entry.split(None, 3)
    if len(fields) < 3 or fields[0] != "160000":
        return None
    return fields[2]


def behind_origin_main(path):
    # Counts the checked-out HEAD against the already-fetched remote-tracking
    # ref only; no fetch. A missing ref fails the call and maps to None.
    count = git_output(path, "rev-list", "--count", "HEAD..refs/remotes/origin/main")
    try:
        return int(count)
    except (TypeError, ValueError):
        return None


def repo_status(relative_path, gh_ready):
    path = os.path.join(root, relative_path)
    pin = recorded_pin(relative_path)
    short_pin = pin[:7] if pin else None
    git_marker = os.path.join(path, ".git")
    inside = git_output(path, "rev-parse", "--is-inside-work-tree") if os.path.exists(git_marker) else None
    if inside != "true":
        return {
            "initialized": False,
            "branch": None,
            "dirty": False,
            "ahead": None,
            "behind": None,
            "pin": short_pin,
            "gitlinkDirty": False,
            "behindOriginMain": None,
        }

    branch = git_output(path, "branch", "--show-current") or None
    porcelain = git_output(path, "status", "--short", "--untracked-files=normal")
    head = git_output(path, "rev-parse", "HEAD")
    repo = {
        "initialized": True,
        "branch": branch,
        "dirty": bool(porcelain),
        "ahead": None,
        "behind": None,
        "pin": short_pin,
        "gitlinkDirty": bool(pin and head and head != pin),
        "behindOriginMain": behind_origin_main(path),
    }
    if branch is None:
        repo["head"] = git_output(path, "rev-parse", "--short", "HEAD")

    counts = git_output(path, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
    if counts:
        try:
            behind, ahead = (int(value) for value in counts.split())
            repo["ahead"], repo["behind"] = ahead, behind
        except (TypeError, ValueError):
            pass

    if gh_ready and branch:
        pr = branch_pr(path, branch)
        if pr is not None:
            repo["pr"] = pr
    return repo


def github_ready():
    if shutil.which("gh") is None:
        return False
    result = run(["gh", "auth", "status"])
    return result is not None and result.returncode == 0


gh_ready = github_ready()
report = {
    "host": doctor_status(),
    "ports": port_status(),
    "sandboxes": sandbox_status(),
    "repos": {
        "intentd": repo_status("packages/intentd", gh_ready),
        "cloudlands-fe": repo_status("packages/cloudlands-fe", gh_ready),
    },
    "docs": {"remoteHost": "AGENTS.md#developing-on-a-remote-host"},
}

if json_output:
    json.dump(report, sys.stdout, separators=(",", ":"))
    print()
    raise SystemExit(0)

print("Intent worktree status")
print(f"Host       doctor {'ok' if report['host']['doctorOk'] else 'has gaps'}")
for gap in report["host"]["gaps"]:
    print(f"           gap: {gap}")
coverage = report["host"]["coverageTooling"]
if coverage["ready"]:
    coverage_text = "cargo-llvm-cov ready"
elif coverage["detail"] == "unknown":
    coverage_text = "cargo-llvm-cov unknown"
elif coverage["detail"].startswith("cargo-llvm-cov: not installed"):
    coverage_text = "cargo-llvm-cov not installed"
else:
    coverage_text = "cargo-llvm-cov installed, llvm-tools-preview missing"
print(f"Coverage   {coverage_text}")
ports = report["ports"]
print("Ports      " + "  ".join(f"{name}={value}" for name, value in ports.items()))
if report["sandboxes"]:
    for state in report["sandboxes"]:
        health = state.get("health")
        health_text = "ok" if isinstance(health, dict) and health.get("ok") else "unavailable"
        supervisor = state.get("supervisor")
        supervisor_text = f" supervisor={supervisor}" if supervisor is not None else ""
        print(f"Sandbox    {state.get('mode', '?')} {state.get('url', '-')} health={health_text}{supervisor_text}")
else:
    print("Sandboxes  none")
for name, repo in report["repos"].items():
    if not repo["initialized"]:
        print(f"Repo       {name}: uninitialized")
        continue
    branch = repo["branch"] or f"detached@{repo.get('head') or '?'}"
    tracking = "-/-" if repo["ahead"] is None else f"+{repo['ahead']}/-{repo['behind']}"
    dirty = "dirty" if repo["dirty"] else "clean"
    gitlink_text = f" gitlink=moved(pin {repo['pin'] or '?'})" if repo["gitlinkDirty"] else ""
    pr = repo.get("pr")
    pr_text = ""
    if pr:
        checks = pr["checks"]
        pr_text = (
            f" PR #{pr['number']} checks={checks['passing']} pass/"
            f"{checks['pending']} pending/{checks['failing']} fail"
        )
    lag = repo["behindOriginMain"]
    lag_text = f" behind-origin/main={'-' if lag is None else lag}"
    print(f"Repo       {name}: {branch} {dirty} ahead/behind={tracking}{gitlink_text}{lag_text}{pr_text}")
    if lag:
        print(
            f"           checked-out HEAD is {lag} commit(s) behind origin/main — branch component "
            "work from origin/main; auto-bump-submodules will advance the pin"
        )
print(f"Docs       {report['docs']['remoteHost']}")
PY