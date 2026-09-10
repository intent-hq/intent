#!/usr/bin/env bash
# JSON schema:
# {"host":{"doctorOk":bool,"gaps":[string]},"ports":{},"sandboxes":[],
#  "repos":{"name":{"branch":string|null,"dirty":bool,"ahead":int|null,
#  "behind":int|null,"pr?":{"number":int,"url":string,"state":string,
#  "checks":{"total":int,"passing":int,"failing":int,"pending":int}}}},
#  "docs":{"remoteHost":"AGENTS.md#developing-on-a-remote-host"}}

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
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

root, json_output = sys.argv[1], sys.argv[2] == "1"


def run(command, *, cwd=root, env=None, timeout=3):
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


def doctor_status():
    result = run([os.path.join(root, "scripts/bootstrap-dev-host.sh"), "--check"])
    if result is None:
        return {"doctorOk": False, "gaps": ["doctor check could not complete"]}
    gaps = []
    for line in result.stdout.splitlines():
        if line.startswith("[missing]  "):
            gaps.append(line.removeprefix("[missing]  ").strip())
    return {"doctorOk": result.returncode == 0, "gaps": gaps}


def port_status():
    result = run([os.path.join(root, "scripts/dev-ports.sh")], timeout=2)
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
        with urllib.request.urlopen(health_url, timeout=0.4) as response:
            payload = json.load(response)
        return payload if isinstance(payload, dict) else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def git_output(path, *arguments):
    result = run(["git", "-C", path, *arguments], timeout=1)
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
        timeout=3,
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


def repo_status(relative_path, gh_ready):
    path = os.path.join(root, relative_path)
    git_marker = os.path.join(path, ".git")
    inside = git_output(path, "rev-parse", "--is-inside-work-tree") if os.path.exists(git_marker) else None
    if inside != "true":
        return {"initialized": False, "branch": None, "dirty": False, "ahead": None, "behind": None}

    branch = git_output(path, "branch", "--show-current") or None
    porcelain = git_output(path, "status", "--short", "--untracked-files=normal")
    repo = {
        "initialized": True,
        "branch": branch,
        "dirty": bool(porcelain),
        "ahead": None,
        "behind": None,
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
    result = run(["gh", "auth", "status"], timeout=1)
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
    pr = repo.get("pr")
    pr_text = ""
    if pr:
        checks = pr["checks"]
        pr_text = (
            f" PR #{pr['number']} checks={checks['passing']} pass/"
            f"{checks['pending']} pending/{checks['failing']} fail"
        )
    print(f"Repo       {name}: {branch} {dirty} ahead/behind={tracking}{pr_text}")
print(f"Docs       {report['docs']['remoteHost']}")
PY