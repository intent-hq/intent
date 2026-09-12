#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/bootstrap-dev-host.sh"
temp_dir=$(mktemp -d)
bin_dir="$temp_dir/bin"
fixture="$temp_dir/repo"
intentd_dir="$fixture/packages/intentd"
fe_dir="$fixture/packages/cloudlands-fe"
pty_dir="$fe_dir/node_modules/node-pty"
output="$temp_dir/doctor.out"
mkdir -p "$bin_dir" "$intentd_dir" "$pty_dir/lib" "$temp_dir/home"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "bootstrap-dev-host test failed: $*" >&2
  if [[ -f "$output" ]]; then
    echo "--- doctor output ---" >&2
    cat "$output" >&2
  fi
  exit 1
}

bash -n "$script" || fail "script does not parse"
bash --posix -n "$script" || fail "script does not parse under bash --posix"

for command in bash cat cksum date dirname grep head id mktemp pgrep rm sed sleep tr uname; do
  ln -s "$(command -v "$command")" "$bin_dir/$command"
done

: >"$intentd_dir/.git"
: >"$fe_dir/.git"
printf '{"packageManager": "pnpm@10.30.3"}\n' >"$fe_dir/package.json"

write_launcher() {
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$bin_dir/$1"
  chmod +x "$bin_dir/$1"
}

# The node shim answers --version with the version under test and hands
# everything else (the pty.node load probe) to the real node.
real_node=$(command -v node) || fail "a real node is required to exercise the pty.node load probe"
set_node_version() {
  write_launcher node "[ \"\$1\" = --version ] && { echo v$1; exit 0; }; exec \"$real_node\" \"\$@\""
}

host_platform=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) host_arch=x64 ;;
  arm64|aarch64) host_arch=arm64 ;;
  *) host_arch=$(uname -m) ;;
esac

# A loadable pty.node cannot be fabricated without a compiler; use the one the
# repository's frontend checkout built for this host when it exists. Any
# bundled prebuild for another platform serves as the foreign binary, with a
# Mach-O header as the stand-in when none is bundled.
loadable_pty=""
foreign_pty=""
for candidate in \
  "$repo_root/packages/cloudlands-fe/node_modules/node-pty/build/Release/pty.node" \
  "$repo_root/packages/cloudlands-fe/node_modules/node-pty/prebuilds/$host_platform-$host_arch/pty.node"; do
  if [[ -z "$loadable_pty" && -f "$candidate" ]]; then
    loadable_pty=$candidate
  fi
done
for candidate in "$repo_root"/packages/cloudlands-fe/node_modules/node-pty/prebuilds/*/pty.node; do
  case "$candidate" in
    */"$host_platform-$host_arch"/*) ;;
    *)
      if [[ -z "$foreign_pty" && -f "$candidate" ]]; then
        foreign_pty=$candidate
      fi
      ;;
  esac
done
if [[ -z "$foreign_pty" ]]; then
  foreign_pty="$temp_dir/foreign-pty.node"
  printf '\317\372\355\376\007\000\000\001\003\000\000\000' >"$foreign_pty"
fi

# set_pty_binaries [source=]path...: installs each path under node_modules/node-pty,
# copied from source when given and empty otherwise.
set_pty_binaries() {
  rm -rf "$pty_dir/build" "$pty_dir/prebuilds"
  local entry source path
  for entry in "$@"; do
    case "$entry" in
      *=*) source=${entry%%=*}; path=${entry#*=} ;;
      *) source=""; path=$entry ;;
    esac
    mkdir -p "$pty_dir/$(dirname "$path")"
    if [[ -n "$source" ]]; then
      cp "$source" "$pty_dir/$path"
    else
      : >"$pty_dir/$path"
    fi
  done
}

now_ms() {
  python3 -c 'import time; print(time.monotonic_ns() // 1000000)'
}

run_doctor() {
  local started finished
  started=$(now_ms)
  PATH="$bin_dir" HOME="$temp_dir/home" INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
    BOOTSTRAP_PROBE_TIMEOUT=2 bash "$script" --check >"$output" 2>&1 || true
  finished=$(now_ms)
  elapsed_ms=$((finished - started))
}

expect_line() {
  grep -qF -- "$1" "$output" || fail "expected doctor output to contain: $1"
}

reject_line() {
  ! grep -qF -- "$1" "$output" || fail "expected doctor output not to contain: $1"
}

ok_dependencies="[ok]       frontend dependencies: packages/cloudlands-fe/node_modules with node-pty loadable on $host_platform-$host_arch"

# Healthy host: supported Node, a launcher that answers, node-pty loadable on this platform.
set_node_version 24.19.0
write_launcher corepack 'echo 0.35.0'
if [[ -n "$loadable_pty" ]]; then
  set_pty_binaries "$loadable_pty=build/Release/pty.node"
else
  echo "bootstrap-dev-host tests: no built pty.node in packages/cloudlands-fe/node_modules; loadable-binary assertions skipped" >&2
  set_pty_binaries build/Release/pty.node
fi
run_doctor
expect_line "[ok]       Node: v24.19.0"
expect_line "[ok]       Corepack: 0.35.0"
if [[ -n "$loadable_pty" ]]; then
  expect_line "$ok_dependencies"
fi
[[ "$elapsed_ms" -lt 5000 ]] || fail "healthy doctor took ${elapsed_ms}ms (expected under 5000ms)"

# A Corepack launcher that re-invokes itself fails within the probe timeout and names its path.
write_launcher corepack 'exec "$0" pnpm "$@"'
run_doctor
expect_line "[missing]  Corepack: 'corepack --version' did not finish within 2s: the launcher $bin_dir/corepack re-invokes itself or stalls."
reject_line "[ok]       Corepack:"
reject_line "Killed"
[[ "$elapsed_ms" -lt 10000 ]] || fail "recursive launcher doctor took ${elapsed_ms}ms (expected under 10000ms)"
! pgrep -f "$bin_dir/corepack" >/dev/null || fail "recursive corepack launcher was left running"

# A stalled launcher is killed together with its children.
stall_name="stalled-launcher-$(basename "$temp_dir")"
write_launcher corepack "bash -c 'exec -a $stall_name sleep 6543'; exit 1"
run_doctor
expect_line "[missing]  Corepack: 'corepack --version' did not finish within 2s: the launcher $bin_dir/corepack"
[[ "$elapsed_ms" -lt 10000 ]] || fail "stalled launcher doctor took ${elapsed_ms}ms (expected under 10000ms)"
sleep 1
! pgrep -f "$stall_name" >/dev/null || fail "stalled launcher's sleep child was left running"

# A launcher that exits non-zero reports the exit status and its first output line.
write_launcher corepack 'echo "SyntaxError: bad launcher" >&2; exit 1'
run_doctor
expect_line "[missing]  Corepack: 'corepack --version' failed with exit 1 via $bin_dir/corepack: SyntaxError: bad launcher"

# node_modules without a pty.node for this platform is an incomplete install, not a pass.
write_launcher corepack 'echo 0.35.0'
set_pty_binaries
run_doctor
expect_line "[missing]  frontend dependencies: node-pty has no pty.node for $host_platform-$host_arch under packages/cloudlands-fe/node_modules"
expect_line "corepack pnpm install --frozen-lockfile, then corepack pnpm rebuild node-pty"

# Prebuilds for other platforms do not count; the host's own prebuild does.
set_pty_binaries prebuilds/win32-x64/pty.node prebuilds/win32-arm64/pty.node
run_doctor
expect_line "[missing]  frontend dependencies: node-pty has no pty.node for $host_platform-$host_arch"
if [[ -n "$loadable_pty" ]]; then
  set_pty_binaries "$loadable_pty=prebuilds/$host_platform-$host_arch/pty.node"
  run_doctor
  expect_line "$ok_dependencies"
fi

# A pty.node that exists but cannot be loaded (truncated build output) is a gap, not a pass.
set_pty_binaries build/Release/pty.node
run_doctor
expect_line "[missing]  frontend dependencies: node cannot load node-pty/build/Release/pty.node (exit 1: "
expect_line "(built for another platform or corrupted); run corepack pnpm rebuild node-pty in packages/cloudlands-fe"
reject_line "[ok]       frontend dependencies:"

# A binary built for another platform in the generic build/Release path is a gap too.
set_pty_binaries "$foreign_pty=build/Release/pty.node"
run_doctor
expect_line "[missing]  frontend dependencies: node cannot load node-pty/build/Release/pty.node (exit 1: "
reject_line "[ok]       frontend dependencies:"

# The load probe is bounded like the launcher probes.
write_launcher node "[ \"\$1\" = --version ] && { echo v24.19.0; exit 0; }; exec sleep 6543"
run_doctor
expect_line "[missing]  frontend dependencies: loading node-pty/build/Release/pty.node with node did not finish within 2s"
[[ "$elapsed_ms" -lt 10000 ]] || fail "stalled load probe doctor took ${elapsed_ms}ms (expected under 10000ms)"
set_node_version 24.19.0

# No node_modules at all keeps the install hint.
mv "$fe_dir/node_modules" "$temp_dir/node_modules.bak"
run_doctor
expect_line "[missing]  frontend dependencies: run corepack pnpm install --frozen-lockfile in packages/cloudlands-fe"
mv "$temp_dir/node_modules.bak" "$fe_dir/node_modules"

# Node floor follows node-gyp 13's engines: ^22.22.2 || ^24.15.0 || >=26.0.0.
for version in 20.20.2 22.20.0 24.14.9 25.1.0; do
  set_node_version "$version"
  run_doctor
  expect_line "[missing]  Node: v$version is unsupported; the frontend native build (node-gyp 13) needs Node 22.22.2+, 24.15.0+ (recommended) or 26+"
done
for version in 22.22.2 24.15.0 26.0.0; do
  set_node_version "$version"
  run_doctor
  expect_line "[ok]       Node: v$version (supported: 22.22.2+, 24.15.0+ (recommended) or 26+)"
done

rm -f "$bin_dir/node"
run_doctor
expect_line "[missing]  Node: 22.22.2+, 24.15.0+ (recommended) or 26+ is required"

echo "bootstrap-dev-host tests passed"
