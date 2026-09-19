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

# The port probe budget is generous here so a loaded host never empties
# `ports`; the no-gh wall-clock bound scales with it (3 s of slack on top,
# i.e. the historical 5000 ms at the former 2 s default) so it still catches a
# missing `gh` hanging the report.
export DEV_STATUS_PORT_TIMEOUT="${DEV_STATUS_PORT_TIMEOUT:-30}"
no_gh_budget_ms=$(python3 -c 'import os; print(int(float(os.environ["DEV_STATUS_PORT_TIMEOUT"]) * 1000) + 3000)')

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
assert set(report) == {"host", "ports", "sandboxes", "repos", "docs"}
assert set(report["host"]) == {"doctorOk", "gaps", "coverageTooling"}
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
    assert {"branch", "dirty", "ahead", "behind", "pin", "gitlinkDirty"} <= set(repo)
    assert repo["pin"] is None or isinstance(repo["pin"], str)
    assert isinstance(repo["gitlinkDirty"], bool)
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

cat >"$state_dir/stale.json" <<'JSON'
{"mode":"ui","pid":99999999}
JSON
PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >/dev/null
[[ -f "$state_dir/stale.json" ]] || fail "read-only status removed stale sandbox state"
grep -q '^auth status$' "$GH_TEST_LOG" || fail "gh authentication was not checked"
! grep -q '^pr ' "$GH_TEST_LOG" || fail "PR lookup ran without authenticated gh"

# Gitlink fixture: a throwaway monorepo with real submodule checkouts, so the
# pin / gitlinkDirty fields are asserted for in-sync, moved, and uninitialized.
fixture="$temp_dir/fixture"
git_fixture() { git -c protocol.file.allow=always -C "$fixture" "$@"; }
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
mkdir -p "$fixture/scripts"
cp "$script" "$fixture/scripts/dev-status.sh"
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
print(json.dumps({k: [v["initialized"], v["pin"], v["gitlinkDirty"]] for k, v in repos.items()}, sort_keys=True))'
}

in_sync=$(fixture_status)
[[ "$in_sync" == "{\"cloudlands-fe\": [true, \"$(git_fixture rev-parse --short=7 HEAD:packages/cloudlands-fe)\", false], \"intentd\": [true, \"$intentd_pin\", false]}" ]] \
  || fail "in-sync fixture reported $in_sync"

git -C "$fixture/packages/intentd" commit -q --allow-empty -m "moved off the pin"
moved=$(fixture_status)
python3 - "$moved" "$intentd_pin" <<'PY' || fail "moved gitlink fixture reported $moved"
import json, sys
repos, pin = json.loads(sys.argv[1]), sys.argv[2]
assert repos["intentd"] == [True, pin, True], repos
assert repos["cloudlands-fe"][2] is False, repos
PY
grep -q "^Repo *intentd: .* gitlink=moved(pin $intentd_pin)" <(PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" bash "$fixture/scripts/dev-status.sh") \
  || fail "human status did not flag the moved gitlink"

git_fixture submodule deinit -q -f packages/cloudlands-fe
deinit=$(fixture_status)
python3 - "$deinit" <<'PY' || fail "uninitialized fixture reported $deinit"
import json, sys
repos = json.loads(sys.argv[1])
assert repos["cloudlands-fe"][0] is False and repos["cloudlands-fe"][2] is False, repos
assert isinstance(repos["cloudlands-fe"][1], str), repos
PY

echo "dev-status tests passed (no-gh ${elapsed_ms}ms)"