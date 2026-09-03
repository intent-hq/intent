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

for command in bash cksum date dirname git grep head python3 sed awk; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

started_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
PATH="$bin_dir" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/empty.json"
finished_ms=$(python3 -c 'import time; print(time.monotonic_ns() // 1000000)')
elapsed_ms=$((finished_ms - started_ms))
[[ "$elapsed_ms" -lt 5000 ]] || fail "no-gh status took ${elapsed_ms}ms (expected under 5000ms)"
python3 - "$temp_dir/empty.json" <<'PY' || fail "empty JSON report shape was incorrect"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(report) == {"host", "ports", "sandboxes", "repos", "docs"}
assert set(report["host"]) == {"doctorOk", "gaps"}
assert isinstance(report["host"]["doctorOk"], bool)
assert isinstance(report["host"]["gaps"], list)
assert {"DEV_PORT", "DEV_TCP_PORT", "BRIDGE_PORT", "CDP_PORT"} <= set(report["ports"])
assert report["sandboxes"] == []
assert set(report["repos"]) == {"intentd", "cloudlands-fe"}
for repo in report["repos"].values():
    assert {"branch", "dirty", "ahead", "behind"} <= set(repo)
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

cat >"$state_dir/ui.json" <<JSON
{"mode":"ui","pid":$$,"devPort":6958,"tcpPort":6959,"url":"http://127.0.0.1:1/","daemonLocalhostUrl":"http://daemon.localhost:6958/","socket":null,"intentdSource":"none","startedAt":"2026-09-03T00:00:00Z","readyAt":"2026-09-03T00:00:01Z","warm":{"ok":true,"ms":10},"supervisor":{"kind":"workspace-service","id":"fixture"}}
JSON
PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >"$temp_dir/populated.json"
python3 - "$temp_dir/populated.json" <<'PY' || fail "populated sandbox report was incorrect"
import json
import sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert len(report["sandboxes"]) == 1
sandbox = report["sandboxes"][0]
assert sandbox["mode"] == "ui"
assert sandbox["supervisor"] == {"kind": "workspace-service", "id": "fixture"}
assert sandbox["health"] is None
PY
[[ -f "$state_dir/ui.json" ]] || fail "status removed a live fixture state file"

cat >"$state_dir/stale.json" <<'JSON'
{"mode":"ui","pid":99999999}
JSON
PATH="$bin_dir:$PATH" SANDBOX_STATE_DIR="$state_dir" STATUS_JSON=1 \
  bash "$script" >/dev/null
[[ -f "$state_dir/stale.json" ]] || fail "read-only status removed stale sandbox state"
grep -q '^auth status$' "$GH_TEST_LOG" || fail "gh authentication was not checked"
! grep -q '^pr ' "$GH_TEST_LOG" || fail "PR lookup ran without authenticated gh"

echo "dev-status tests passed (no-gh ${elapsed_ms}ms)"