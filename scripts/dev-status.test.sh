#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/dev-status.sh"
temp_dir=$(mktemp -d)
state_dir="$temp_dir/state"
bin_dir="$temp_dir/bin"
mkdir -p "$state_dir" "$bin_dir"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "dev-status test failed: $*" >&2
  exit 1
}

write_live_state() {
  python3 - "$1" "$2" <<'PY'
import json
import os
import subprocess
import sys

path, pid = sys.argv[1], int(sys.argv[2])
stat_path = f"/proc/{pid}/stat"
if os.path.exists(stat_path):
    with open(stat_path, encoding="utf-8") as handle:
        fields = handle.read().rsplit(")", 1)[1].split()
    with open(f"/proc/{pid}/cmdline", "rb") as handle:
        command = handle.read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
    start_time = f"proc:{fields[19]}"
else:
    output = subprocess.check_output(
        ["ps", "-o", "lstart=", "-o", "command=", "-p", str(pid)], text=True
    ).strip()
    fields = output.split(None, 5)
    start_time, command = f"ps:{' '.join(fields[:5])}", fields[5]
state = {
    "mode": "ui", "pid": pid, "pidStartTime": start_time, "pidCommandLine": command,
    "devPort": 6958, "tcpPort": 6959, "url": "http://127.0.0.1:1/",
    "daemonLocalhostUrl": "http://daemon.localhost:6958/", "socket": None,
    "intentdSource": "none", "startedAt": "2026-09-03T00:00:00Z",
    "readyAt": "2026-09-03T00:00:01Z", "warm": {"ok": True, "ms": 10},
    "supervisor": {"kind": "workspace-service", "id": "fixture"},
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, separators=(",", ":"))
    handle.write("\n")
PY
}

for command in bash cksum date dirname git grep head python3 sed awk; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

# Every probe budget in dev-status.sh must come from a knob so the suite can
# raise it under load; a numeric literal reintroduces a fixed wall-clock budget.
# The embedded Python is parsed with `ast`, so any spelling of a numeric
# `timeout` keyword argument, parameter default, or assignment (`timeout = 3`,
# `timeout=.4`, `timeout=(3)`, `timeout=-1`) fails while comments and strings
# never count.
python3 - "$script" <<'PY' || fail "dev-status.sh has a numeric timeout literal; use DEV_STATUS_PORT_TIMEOUT or DEV_STATUS_PROBE_TIMEOUT"
import ast
import re
import sys

source = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"<<'PY'\n(.*?)\nPY(?:\n|\Z)", source, re.DOTALL)
assert match, "embedded Python heredoc not found"
tree = ast.parse(match.group(1), filename=sys.argv[1])


def numeric_literal(node):
    while isinstance(node, ast.UnaryOp):
        node = node.operand
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, (int, float, complex))
        and not isinstance(node.value, bool)
    )


def parameter_defaults(arguments):
    positional = arguments.posonlyargs + arguments.args
    yield from zip(positional[len(positional) - len(arguments.defaults):], arguments.defaults)
    yield from zip(arguments.kwonlyargs, arguments.kw_defaults)


literals = []
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        candidates = [(keyword.arg, keyword.value) for keyword in node.keywords]
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        candidates = [(argument.arg, default) for argument, default in parameter_defaults(node.args)]
    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        candidates = [(target.id, node.value) for target in targets if isinstance(target, ast.Name)]
    else:
        continue
    for name, value in candidates:
        if name == "timeout" and numeric_literal(value):
            literals.append(f"line {value.lineno}: {ast.unparse(value)}")
for literal in literals:
    print(f"numeric timeout literal at heredoc {literal}", file=sys.stderr)
sys.exit(1 if literals else 0)
PY

# Exercise the component contract in disposable repos, with injected failures
# restricted to the git executable used by the copied reporter.
python3 - "$script" <<'PYTEST' || fail "component Git reporting regressions"
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(sys.argv[1])
REAL_GIT = shutil.which("git")


class ComponentGitStatus(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.component = self.root / "packages/intentd"
        scripts = self.root / "scripts"
        scripts.mkdir()
        shutil.copy(SCRIPT, scripts / SCRIPT.name)
        shutil.copy(SCRIPT.parent / "github_readiness.py", scripts)
        for name, output in [("bootstrap-dev-host.sh", ""), ("dev-ports.sh", "DEV_PORT=1234"),
                             ("dev-sandbox.sh", "[]")]:
            stub = scripts / name
            stub.write_text("#!/bin/sh\nprintf '%s\\n' '" + output + "'\n")
            stub.chmod(0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text("#!/bin/sh\nexit 1\n")
        gh.chmod(0o755)
        wrapper = self.bin / "git"
        wrapper.write_text("#!" + sys.executable + r"""
import json, os, sys, time
args = sys.argv[1:]
with open(os.environ["PROBE_LOG"], "a") as log:
    log.write(json.dumps([args, os.environ.get("GIT_OPTIONAL_LOCKS")]) + "\n")
command = args[2] if args[:1] == ["-C"] else args[0]
mode = os.environ.get("FAIL_PROBE")
if mode == command or mode == "timeout:" + command:
    if mode.startswith("timeout:"):
        # timing-guard: deliberately exceed the reporter's configured probe deadline.
        time.sleep(30)
    os.write(2, b"\x1b[31mfatal:\x1b[0m injected\r\n\t" + b"x" * 1000 + b"\x00\x7f" + (b"\xff" if os.environ.get("INVALID_DIAGNOSTIC") else b""))
    sys.exit(128)
os.execv(os.environ["REAL_GIT"], [os.environ["REAL_GIT"], *args])
""")
        wrapper.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        REAL_GIT=REAL_GIT, PROBE_LOG=str(self.root / "probes.jsonl"),
                        DEV_STATUS_PROBE_TIMEOUT="5", GIT_OPTIONAL_LOCKS="1")
        self.env.pop("STATUS_JSON", None)
        self.git(self.root, "init", "-q", "-b", "main")
        self.component.mkdir(parents=True)
        self.git(self.component, "init", "-q", "-b", "main")
        (self.component / "tracked").write_text("base\n")
        self.git(self.component, "add", "tracked")
        self.git(self.component, "commit", "-qm", "component base")
        self.head = self.git(self.component, "rev-parse", "HEAD")
        self.git(self.root, "update-index", "--add", "--cacheinfo",
                 "160000," + self.head + ",packages/intentd")
        self.git(self.root, "commit", "-qm", "parent base")

    def git(self, path, *args):
        return subprocess.check_output([REAL_GIT, "-C", str(path), "-c", "user.name=Fixture",
                                        "-c", "user.email=fixture@example.invalid", *args],
                                       text=True, stderr=subprocess.PIPE).strip()

    def report(self, human=False, failure=None):
        env = dict(self.env)
        if failure:
            env["FAIL_PROBE"] = failure
        result = subprocess.run(["bash", str(self.root / "scripts/dev-status.sh"),
                                 *([] if human else ["--json"])], env=env,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return result.stdout if human else json.loads(result.stdout)["repos"]["intentd"]

    def assert_error(self, repo, probe):
        self.assertEqual(repo["gitState"], "error", repo)
        errors = {error["probe"]: error["detail"] for error in repo["gitErrors"]}
        self.assertIn(probe, errors)
        for detail in errors.values():
            self.assertTrue(0 < len(detail) <= 240, detail)
            self.assertTrue(all(c.isprintable() for c in detail), repr(detail))
            self.assertNotIn("[31m", detail)

    def assert_human_error(self, failure=None):
        text = self.report(human=True, failure=failure)
        line = next(line for line in text.splitlines() if line.startswith("Repo       intentd:"))
        self.assertIn("Git state unavailable", line)
        self.assertNotIn("uninitialized", line)
        self.assertNotIn(" detached@", line)

    def test_broken_markers_and_stale_worktree(self):
        metadata = self.component / ".git"
        saved = self.root / "component-git"
        metadata.rename(saved)
        for case in ("broken-gitdir", "dangling-marker", "empty-gitdir", "stale-worktree"):
            with self.subTest(case=case):
                if case == "broken-gitdir":
                    metadata.write_text("gitdir: /nonexistent/dev-status-fixture\n")
                elif case == "dangling-marker":
                    metadata.symlink_to(self.root / "missing")
                elif case == "empty-gitdir":
                    metadata.mkdir()
                else:
                    metadata.write_text("gitdir: " + str(saved) + "\n")
                    self.git(self.root, "--git-dir=" + str(saved), "config", "core.worktree",
                             str(self.root / "missing-worktree"))
                try:
                    repo = self.report()
                    self.assertIsNone(repo["initialized"], repo)
                    self.assertIsNone(repo["dirty"], repo)
                    self.assertIsNone(repo["gitlinkDirty"], repo)
                    self.assertEqual(repo["pin"], self.head[:7])
                    self.assert_error(repo, "initialization")
                    self.assert_human_error()
                finally:
                    if metadata.is_dir():
                        metadata.rmdir()
                    else:
                        metadata.unlink()

    def test_required_probe_failures_preserve_known_fields(self):
        for command, probe in [("status", "status"), ("rev-parse", "head"),
                               ("ls-tree", "pin"), ("branch", "branch")]:
            with self.subTest(probe=probe):
                # Fail HEAD alone, leaving initialization readable.
                wrapper = self.bin / "git"
                original = wrapper.read_text()
                if probe == "head":
                    wrapper.write_text(original.replace('if mode == command or mode == "timeout:" + command:',
                        'if command == "rev-parse" and args[-1] == "HEAD":'))
                try:
                    repo = self.report(failure=command)
                    self.assertIs(repo["initialized"], True, repo)
                    self.assertIs(repo["dirty"], None if probe == "status" else False, repo)
                    self.assertIs(repo["gitlinkDirty"], None if probe in ("head", "pin") else False, repo)
                    self.assertEqual(repo["pin"], None if probe == "pin" else self.head[:7])
                    self.assert_error(repo, probe)
                    self.assert_human_error(failure=command)
                finally:
                    wrapper.write_text(original)

    def test_invalid_diagnostic_bytes(self):
        self.env["INVALID_DIAGNOSTIC"] = "1"
        self.assert_error(self.report(failure="status"), "status")

    def test_status_timeout(self):
        self.env["DEV_STATUS_PROBE_TIMEOUT"] = "0.2"
        start = time.monotonic()
        repo = self.report(failure="timeout:status")
        self.assertLess(time.monotonic() - start, 10)
        self.assertIsNone(repo["dirty"], repo)
        self.assertIs(repo["initialized"], True, repo)
        self.assertIs(repo["gitlinkDirty"], False, repo)
        self.assert_error(repo, "status")
        self.assertIn("timed out", repo["gitErrors"][0]["detail"])
        self.assert_human_error(failure="timeout:status")

    def test_absent_and_failed_parent_pin(self):
        shutil.rmtree(self.component)
        repo = self.report()
        self.assertEqual(repo["gitState"], "absent", repo)
        self.assertEqual(repo["gitErrors"], [])
        self.assertIs(repo["initialized"], False)
        self.assertIs(repo["dirty"], False)
        self.assertIs(repo["gitlinkDirty"], False)
        self.assertIn("Repo       intentd: uninitialized", self.report(human=True))
        failed = self.report(failure="ls-tree")
        self.assert_error(failed, "pin")
        self.assertIs(failed["initialized"], False)
        self.assertIsNone(failed["gitlinkDirty"])
        self.assert_human_error(failure="ls-tree")

    def test_readable_states_and_no_optional_index_writes(self):
        def snapshot():
            return {str(p): (p.read_bytes(), p.stat().st_mtime_ns)
                    for metadata in (self.root / ".git", self.component / ".git")
                    for p in metadata.rglob("*") if p.is_file()}
        # Touch a tracked file without changing its content to tempt index refresh.
        tracked = self.component / "tracked"
        os.utime(tracked, ns=(1_000_000_000, 1_000_000_000))
        before = snapshot()
        repo = self.report()
        self.assertEqual(snapshot(), before, "report modified repository metadata/index")
        self.assertEqual(repo["gitState"], "readable", repo)
        self.assertEqual(repo["gitErrors"], [])
        self.assertIs(repo["dirty"], False)
        self.assertIs(repo["gitlinkDirty"], False)
        self.assertEqual(repo["branch"], "main")
        self.assertIsNone(repo["behindOriginMain"])
        self.assertIsNone(repo["ahead"])
        self.assertIn("main clean", self.report(human=True))
        for args, locks in map(json.loads, (self.root / "probes.jsonl").read_text().splitlines()):
            self.assertEqual(locks, "0", args)
            self.assertIn(args[2], {"ls-tree", "rev-parse", "branch", "status", "rev-list"})
        tracked.write_text("changed\n")
        self.assertIs(self.report()["dirty"], True)
        self.assertIs(self.report(failure="ls-tree")["dirty"], True)
        self.git(self.component, "add", "tracked")
        self.git(self.component, "commit", "-qm", "advance")
        self.git(self.component, "checkout", "--detach", "-q")
        repo = self.report()
        self.assertIs(repo["gitlinkDirty"], True)
        self.assertIs(self.report(failure="status")["gitlinkDirty"], True)
        self.assertIsNone(repo["branch"])
        self.assertTrue(repo["head"])
        self.assertIn("detached@", self.report(human=True))
        # A successful parent lookup with no gitlink is an independent clone.
        self.git(self.root, "update-index", "--force-remove", "packages/intentd")
        self.git(self.root, "commit", "-qm", "remove gitlink")
        repo = self.report()
        self.assertEqual(repo["gitState"], "readable")
        self.assertIsNone(repo["pin"])
        self.assertIs(repo["gitlinkDirty"], False)


unittest.main(argv=[sys.argv[0]], verbosity=2)
PYTEST

# The port probe budget is generous here so a loaded host never empties
# `ports`, and the probe budget (doctor, sandbox, git, gh) likewise never
# empties `sandboxes`. The knobs bound each call, not the report: with `gh`
# absent the no-gh run still executes the doctor probe, the port probe and the
# sandbox probe serially (git calls share the probe budget but are fast on the
# real repo), so the wall-clock bound is port + 2 × probe plus 3 s of slack
# (the historical 5000 ms at the former 2 s port default) and still catches a
# missing `gh` hanging the report.
export DEV_STATUS_PORT_TIMEOUT="${DEV_STATUS_PORT_TIMEOUT:-30}"
export DEV_STATUS_PROBE_TIMEOUT="${DEV_STATUS_PROBE_TIMEOUT:-30}"
no_gh_budget_ms=$(python3 -c 'import os; print(int((float(os.environ["DEV_STATUS_PORT_TIMEOUT"]) + 2 * float(os.environ["DEV_STATUS_PROBE_TIMEOUT"])) * 1000) + 3000)')

started_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
PATH="$bin_dir" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/empty.json"
finished_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
elapsed_ms=$((finished_ms - started_ms))
[[ "$elapsed_ms" -lt "$no_gh_budget_ms" ]] || fail "no-gh status took ${elapsed_ms}ms (expected under ${no_gh_budget_ms}ms)"
python3 - "$temp_dir/empty.json" <<'PY' || fail "empty JSON report shape was incorrect"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(report) == {"setup", "host", "ports", "sandboxes", "repos", "docs"}
assert set(report["setup"]) == {"running", "markers"}
assert isinstance(report["setup"]["running"], bool)
assert isinstance(report["setup"]["markers"], list)
assert report["setup"]["running"] is bool(report["setup"]["markers"])
assert set(report["host"]) == {"doctorOk", "gaps", "coverageTooling", "github"}
assert report["host"]["github"]["state"] == "missing_cli"
assert isinstance(report["host"]["doctorOk"], bool)
assert isinstance(report["host"]["gaps"], list)
coverage = report["host"]["coverageTooling"]
assert set(coverage) == {"ready", "detail"}
assert isinstance(coverage["ready"], bool) and isinstance(coverage["detail"], str)
assert coverage["detail"].startswith("cargo-llvm-cov: "), coverage
assert {"DEV_PORT", "DEV_TCP_PORT", "BRIDGE_PORT", "CDP_PORT"} <= set(report["ports"])
assert report["sandboxes"] == []
assert set(report["repos"]) == {"intentd", "cloudlands-fe"}
for repo in report["repos"].values():
    assert {"branch", "dirty", "ahead", "behind", "pin", "gitlinkDirty", "behindOriginMain"} <= set(repo)
    assert repo["pin"] is None or isinstance(repo["pin"], str)
    assert repo["gitState"] in {"absent", "readable", "error"}
    assert isinstance(repo["gitErrors"], list)
    for field in ("initialized", "dirty", "gitlinkDirty"):
        assert repo[field] is None or isinstance(repo[field], bool)
    assert repo["behindOriginMain"] is None or isinstance(repo["behindOriginMain"], int)
    assert "pr" not in repo
assert report["docs"]["remoteHost"] == "AGENTS.md#developing-on-a-remote-host"
PY

cat >"$bin_dir/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_TEST_LOG"
exit 1
SH
chmod +x "$bin_dir/gh"
export GH_TEST_LOG="$temp_dir/gh.log"

# The doctor probes cargo from $CARGO_HOME/bin regardless of PATH, so an empty
# CARGO_HOME with cargo off PATH is how absence is simulated (never uninstall).
mkdir -p "$temp_dir/no-cargo"
CARGO_HOME="$temp_dir/no-cargo" PATH="$bin_dir" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/no-coverage.json"
python3 - "$temp_dir/no-coverage.json" <<'PY' || fail "coverageTooling did not report cargo-llvm-cov as absent"
import json
import sys
coverage = json.load(open(sys.argv[1], encoding="utf-8"))["host"]["coverageTooling"]
assert coverage["ready"] is False, coverage
assert coverage["detail"].startswith("cargo-llvm-cov: not installed"), coverage
PY
grep -q '^Coverage   cargo-llvm-cov not installed$' \
  <(CARGO_HOME="$temp_dir/no-cargo" PATH="$bin_dir" SANDBOX_STATE_DIR="$state_dir" bash "$script") \
  || fail "human status did not report cargo-llvm-cov as not installed"

# With the host PATH restored, coverageTooling.ready must match whether this
# host can actually run cargo-llvm-cov with llvm-tools-preview on the pinned
# toolchain: the doctor probes the channel from packages/intentd/
# rust-toolchain.toml (honoring INTENTD_DIR), which may differ from the rustup
# default; without a readable pin it falls back to the active toolchain.
host_path="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
pinned_toolchain=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
  "${INTENTD_DIR:-$repo_root/packages/intentd}/rust-toolchain.toml" 2>/dev/null || true)
component_list=(rustup component list --installed)
if [[ -n "$pinned_toolchain" ]]; then
  component_list+=(--toolchain "$pinned_toolchain")
fi
expected_coverage_ready=false
if PATH="$host_path" cargo llvm-cov --version >/dev/null 2>&1 \
  && PATH="$host_path" "${component_list[@]}" 2>/dev/null | grep -q '^llvm-tools'; then
  expected_coverage_ready=true
fi

write_live_state "$state_dir/ui.json" "$$"
PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/populated.json"
python3 - "$temp_dir/populated.json" "$expected_coverage_ready" <<'PY' || fail "populated sandbox report was incorrect"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
expected_ready = sys.argv[2] == "true"
assert len(report["sandboxes"]) == 1
sandbox = report["sandboxes"][0]
assert sandbox["mode"] == "ui"
assert sandbox["supervisor"] == {"kind": "workspace-service", "id": "fixture"}
assert sandbox["health"] is None
coverage = report["host"]["coverageTooling"]
assert coverage["ready"] is expected_ready, coverage
assert coverage["detail"].startswith("cargo-llvm-cov: "), coverage
assert ("with llvm-tools-preview" in coverage["detail"]) is expected_ready, coverage
PY
if [[ "$expected_coverage_ready" == true ]]; then
  coverage_line='^Coverage   cargo-llvm-cov ready$'
else
  coverage_line='^Coverage   cargo-llvm-cov \(not installed\|installed, llvm-tools-preview missing\)$'
fi
grep -q "$coverage_line" <(PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" bash "$script") \
  || fail "human status did not print the Coverage line"
[[ -f "$state_dir/ui.json" ]] || fail "status removed a live fixture state file"

# Degraded probe budget: a budget too small for dev-sandbox.sh status empties
# `sandboxes` (the live fixture is still on disk) but the report exits 0.
DEV_STATUS_PROBE_TIMEOUT=0.001 PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/degraded.json" || fail "status exited non-zero under a tiny DEV_STATUS_PROBE_TIMEOUT"
python3 - "$temp_dir/degraded.json" <<'PY' || fail "degraded probe budget did not empty sandboxes"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["sandboxes"] == [], report["sandboxes"]
PY

# Rejected knob values (not a number; finite but too large for the subprocess
# and socket timeout APIs) are ignored with exactly one warning naming the
# fallback, and the report is still a complete, exit-0 JSON document. The
# probes then run under the fixed production default, so nothing here asserts
# that a live probe finished within it.
for rejected in abc 1e20; do
  DEV_STATUS_PROBE_TIMEOUT="$rejected" PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
    bash "$script" >"$temp_dir/invalid-probe.json" 2>"$temp_dir/invalid-probe.err" \
    || fail "status exited non-zero under DEV_STATUS_PROBE_TIMEOUT=$rejected"
  grep -q "ignoring DEV_STATUS_PROBE_TIMEOUT='$rejected' .*; using 10\$" "$temp_dir/invalid-probe.err" \
    || fail "DEV_STATUS_PROBE_TIMEOUT=$rejected was not reported on stderr with the default: $(cat "$temp_dir/invalid-probe.err")"
  [[ "$(grep -c 'ignoring DEV_STATUS_PROBE_TIMEOUT' "$temp_dir/invalid-probe.err")" == 1 ]] \
    || fail "DEV_STATUS_PROBE_TIMEOUT=$rejected warning was not printed exactly once"
  python3 - "$temp_dir/invalid-probe.json" <<'PY' || fail "report under DEV_STATUS_PROBE_TIMEOUT=$rejected was not a complete JSON document"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(report) == {"setup", "host", "ports", "sandboxes", "repos", "docs"}, set(report)
assert isinstance(report["sandboxes"], list), report["sandboxes"]
PY
done

cat >"$state_dir/stale.json" <<'JSON'
{"mode":"ui","pid":99999999}
JSON
PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >/dev/null
[[ -f "$state_dir/stale.json" ]] || fail "read-only status removed stale sandbox state"
grep -q '^api graphql ' "$GH_TEST_LOG" || fail "gh readiness was not checked"
! grep -q '^pr ' "$GH_TEST_LOG" || fail "PR lookup ran without authenticated gh"

# Gitlink fixture: a throwaway monorepo with real submodule checkouts, so the
# pin / gitlinkDirty / behindOriginMain fields are asserted for in-sync, moved,
# lagging behind origin/main, moved HEAD with a different lag than the pin,
# missing origin/main, and uninitialized.
fixture="$temp_dir/fixture"
git_fixture() { git -c protocol.file.allow=always -C "$fixture" "$@"; }
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
mkdir -p "$fixture/scripts"
cp "$script" "$fixture/scripts/dev-status.sh"
cp "$repo_root/scripts/github_readiness.py" "$fixture/scripts/github_readiness.py"
git init -q -b main "$fixture"
for name in intentd cloudlands-fe; do
  git init -q -b main "$temp_dir/src-$name"
  git -C "$temp_dir/src-$name" commit -q --allow-empty -m "$name base"
  git_fixture submodule add -q "$temp_dir/src-$name" "packages/$name"
done
git_fixture commit -q -m "fixture base"
intentd_pin=$(git_fixture rev-parse --short=7 HEAD:packages/intentd)

fixture_status() {
  PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
    bash "$fixture/scripts/dev-status.sh" | python3 -c '
import json, sys
repos = json.load(sys.stdin)["repos"]
print(json.dumps({k: [v["initialized"], v["pin"], v["gitlinkDirty"], v["behindOriginMain"]] for k, v in repos.items()}, sort_keys=True))'
}
fixture_human_status() {
  PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" bash "$fixture/scripts/dev-status.sh"
}

in_sync=$(fixture_status)
[[ "$in_sync" == "{\"cloudlands-fe\": [true, \"$(git_fixture rev-parse --short=7 HEAD:packages/cloudlands-fe)\", false, 0], \"intentd\": [true, \"$intentd_pin\", false, 0]}" ]] \
  || fail "in-sync fixture reported $in_sync"

git -C "$fixture/packages/intentd" commit -q --allow-empty -m "moved off the pin"
moved=$(fixture_status)
python3 - "$moved" "$intentd_pin" <<'PY' || fail "moved gitlink fixture reported $moved"
import json, sys
repos, pin = json.loads(sys.argv[1]), sys.argv[2]
assert repos["intentd"] == [True, pin, True, 0], repos
assert repos["cloudlands-fe"][2] is False, repos
PY
grep -q "^Repo *intentd: .* gitlink=moved(pin $intentd_pin)" <(fixture_human_status) \
  || fail "human status did not flag the moved gitlink"

# Lagging: the file remote gains commits and the submodule clone fetches them,
# so its pin sits behind the (already fetched) origin/main without any fetch
# by the status script itself.
for n in 1 2 3; do
  git -C "$temp_dir/src-cloudlands-fe" commit -q --allow-empty -m "upstream $n"
done
git -c protocol.file.allow=always -C "$fixture/packages/cloudlands-fe" fetch -q origin
lagging=$(fixture_status)
python3 - "$lagging" <<'PY' || fail "lagging fixture reported $lagging"
import json, sys
repos = json.loads(sys.argv[1])
assert repos["cloudlands-fe"][3] == 3, repos
assert repos["cloudlands-fe"][2] is False, repos
assert repos["intentd"][3] == 0, repos
PY
fixture_human_status >"$temp_dir/lagging.txt"
grep -q '^Repo *cloudlands-fe: .* behind-origin/main=3' "$temp_dir/lagging.txt" \
  || fail "human status did not print the cloudlands-fe lag token"
grep -q '^Repo *intentd: .* behind-origin/main=0' "$temp_dir/lagging.txt" \
  || fail "human status did not print behind-origin/main=0 for the in-sync intentd"
grep -A1 '^Repo *cloudlands-fe: ' "$temp_dir/lagging.txt" \
  | grep -q '^ *checked-out HEAD is 3 commit(s) behind origin/main — branch component work from origin/main' \
  || fail "human status did not print the lag hint under cloudlands-fe"
[[ "$(grep -c 'commit(s) behind origin/main' "$temp_dir/lagging.txt")" == 1 ]] \
  || fail "lag hint count was not exactly one in: $(cat "$temp_dir/lagging.txt")"

# Moved HEAD: the submodule checks out one of the fetched commits, so the count
# follows the checked-out HEAD (2 behind) rather than the recorded pin (3 behind).
cloudlands_pin=$(git_fixture rev-parse --short=7 HEAD:packages/cloudlands-fe)
git -C "$fixture/packages/cloudlands-fe" checkout -q --detach refs/remotes/origin/main~2
moved_head=$(fixture_status)
python3 - "$moved_head" "$cloudlands_pin" <<'PY' || fail "moved HEAD fixture reported $moved_head"
import json, sys
repos, pin = json.loads(sys.argv[1]), sys.argv[2]
assert repos["cloudlands-fe"] == [True, pin, True, 2], repos
PY
fixture_human_status >"$temp_dir/moved-head.txt"
grep -q "^Repo *cloudlands-fe: .* gitlink=moved(pin $cloudlands_pin) behind-origin/main=2" "$temp_dir/moved-head.txt" \
  || fail "human status did not print the moved gitlink with the HEAD-relative lag"
grep -A1 '^Repo *cloudlands-fe: ' "$temp_dir/moved-head.txt" \
  | grep -q '^ *checked-out HEAD is 2 commit(s) behind origin/main — branch component work from origin/main' \
  || fail "human status did not print the HEAD-relative lag hint under cloudlands-fe"
git_fixture submodule update -q --checkout packages/cloudlands-fe

# Missing ref: without refs/remotes/origin/main the count is unknown (null),
# rendered as "-", and the script still exits 0.
git -C "$fixture/packages/intentd" update-ref -d refs/remotes/origin/main
missing_ref=$(fixture_status)
python3 - "$missing_ref" <<'PY' || fail "missing origin/main fixture reported $missing_ref"
import json, sys
repos = json.loads(sys.argv[1])
assert repos["intentd"][3] is None, repos
assert repos["cloudlands-fe"][3] == 3, repos
PY
grep -q '^Repo *intentd: .* behind-origin/main=-' <(fixture_human_status) \
  || fail "human status did not print behind-origin/main=- for the missing ref"

git_fixture submodule deinit -q -f packages/cloudlands-fe
deinit=$(fixture_status)
python3 - "$deinit" <<'PY' || fail "uninitialized fixture reported $deinit"
import json, sys
repos = json.loads(sys.argv[1])
assert repos["cloudlands-fe"][0] is False and repos["cloudlands-fe"][2] is False, repos
assert isinstance(repos["cloudlands-fe"][1], str), repos
assert repos["cloudlands-fe"][3] is None, repos
PY

# Setup marker: the daemon keeps <worktree>/.intent/setup-<uuid>.sh in place
# only while the workspace setup script runs, so its presence flags the whole
# report as provisional; unrelated .intent files never trigger it.
fixture_setup() {
  PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
    bash "$fixture/scripts/dev-status.sh" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["setup"], sort_keys=True))'
}
banner='^SETUP SCRIPT STILL RUNNING — status below is provisional'
mkdir -p "$fixture/.intent"
printf '{}\n' >"$fixture/.intent/config.json"
printf '#!/bin/sh\n' >"$fixture/.intent/setup-wrapper-0123456789abcdef0123456789abcdef.cmd"
idle=$(fixture_setup)
[[ "$idle" == '{"markers": [], "running": false}' ]] || fail "idle setup fixture reported $idle"
fixture_human_status >"$temp_dir/idle.txt"
! grep -q "$banner" "$temp_dir/idle.txt" || fail "human status printed the provisional banner without a setup marker"
[[ "$(head -n1 "$temp_dir/idle.txt")" == "Intent worktree status" ]] \
  || fail "human status did not start with the header when idle: $(head -n1 "$temp_dir/idle.txt")"

marker=".intent/setup-0123456789abcdef0123456789abcdef.sh"
printf '#!/bin/sh\nsleep 60\n' >"$fixture/$marker"
running=$(fixture_setup)
[[ "$running" == "{\"markers\": [\"$marker\"], \"running\": true}" ]] || fail "running setup fixture reported $running"
fixture_human_status >"$temp_dir/running.txt"
[[ "$(head -n1 "$temp_dir/running.txt")" == "SETUP SCRIPT STILL RUNNING — status below is provisional ($marker)" ]] \
  || fail "human status did not lead with the provisional banner: $(head -n1 "$temp_dir/running.txt")"
grep -q '^Intent worktree status$' "$temp_dir/running.txt" || fail "provisional status dropped the regular report"

rm "$fixture/$marker"
after=$(fixture_setup)
[[ "$after" == '{"markers": [], "running": false}' ]] || fail "setup fixture after marker removal reported $after"
! grep -q "$banner" <(fixture_human_status) || fail "human status kept the provisional banner after the marker was removed"

echo "dev-status tests passed (no-gh ${elapsed_ms}ms)"
