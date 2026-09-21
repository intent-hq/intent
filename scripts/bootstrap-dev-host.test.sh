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

# write_package_json [engines.node]: a prettier-shaped package.json with the
# pinned packageManager and, when given, an engines block declaring the range.
write_package_json() {
  {
    echo '{'
    echo '  "name": "cloudlands-fe",'
    echo '  "packageManager": "pnpm@10.30.3",'
    if [[ $# -gt 0 ]]; then
      echo '  "engines": {'
      printf '    "node": "%s"\n' "$1"
      echo '  },'
    fi
    echo '  "devDependencies": {'
    echo '    "@types/node": "^24.10.0"'
    echo '  }'
    echo '}'
  } >"$fe_dir/package.json"
}
write_package_json

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
    CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL= \
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
# timing-guard: placeholder lifetime
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

# A host that injects tracing into Node logs its startup configuration to stdout
# before the launcher answers --version (intent-hq/intent#5509): the version is
# the semver-shaped line, not the first line.
dd_banner='DATADOG TRACER CONFIGURATION - {"date":"2026-09-20T00:00:00.000Z","lang":"nodejs","service":"intent"}'
write_launcher corepack "echo '$dd_banner'; echo 0.35.0"
run_doctor
expect_line "[ok]       Corepack: 0.35.0"
reject_line "[ok]       Corepack: DATADOG"

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
# timing-guard: placeholder lifetime
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

# The Node range comes from the frontend's engines.node; each ^X.Y.Z clause
# keeps its major and >=X is open-ended.
default_range="^22.22.2 || ^24.15.0 || >=26"
write_package_json "$default_range"
for version in 22.22.1 23.0.0 24.14.9 25.0.0; do
  set_node_version "$version"
  run_doctor
  expect_line "[missing]  Node: v$version is unsupported; the frontend native build (node-gyp 13) needs Node $default_range"
done
for version in 22.22.2 24.15.0 26.0.0; do
  set_node_version "$version"
  run_doctor
  expect_line "[ok]       Node: v$version (supported: $default_range)"
done

# A different declared range moves the floors and the printed requirement.
write_package_json "^20.19.0 || >=23.1"
set_node_version 20.19.0
run_doctor
expect_line "[ok]       Node: v20.19.0 (supported: ^20.19.0 || >=23.1)"
set_node_version 22.22.2
run_doctor
expect_line "[missing]  Node: v22.22.2 is unsupported; the frontend native build (node-gyp 13) needs Node ^20.19.0 || >=23.1"
set_node_version 23.1.0
run_doctor
expect_line "[ok]       Node: v23.1.0 (supported: ^20.19.0 || >=23.1)"

# Without an engines.node field, or with a clause the parser does not know,
# the built-in range applies.
set_node_version 24.15.0
write_package_json
run_doctor
expect_line "[ok]       Node: v24.15.0 (supported: $default_range)"
write_package_json ">=22 <25"
run_doctor
expect_line "[ok]       Node: v24.15.0 (supported: $default_range)"
set_node_version 24.14.9
run_doctor
expect_line "[missing]  Node: v24.14.9 is unsupported; the frontend native build (node-gyp 13) needs Node $default_range"

# Only the two-character || separates clauses: a single pipe, a trailing
# separator, or an empty clause makes the range unparseable and falls back to
# the built-in range instead of being silently normalized.
for range in "^20.19.0|>=23.1" "^22.22.2 ||" "^22.22.2 || || >=26"; do
  write_package_json "$range"
  set_node_version 24.14.9
  run_doctor
  expect_line "[missing]  Node: v24.14.9 is unsupported; the frontend native build (node-gyp 13) needs Node $default_range"
  reject_line "supported: $range"
  set_node_version 24.15.0
  run_doctor
  expect_line "[ok]       Node: v24.15.0 (supported: $default_range)"
done

# A missing package.json (submodule not initialized) keeps the Node check working.
mv "$fe_dir/package.json" "$temp_dir/package.json.bak"
set_node_version 24.15.0
run_doctor
expect_line "[missing]  frontend packageManager: cannot read packages/cloudlands-fe/package.json"
expect_line "[ok]       Node: v24.15.0 (supported: $default_range)"
mv "$temp_dir/package.json.bak" "$fe_dir/package.json"
write_package_json "$default_range"

rm -f "$bin_dir/node"
run_doctor
expect_line "[missing]  Node: $default_range is required"

# jq is required; without it the doctor names the suites that need it.
expect_line "[missing]  jq: required by the release-notifier test suites"
write_launcher jq '[ "$1" = --version ] && { echo jq-1.7.1; exit 0; }; exit 1'
run_doctor
expect_line "[ok]       jq: jq-1.7.1"
reject_line "[missing]  jq:"

# A jq on PATH that cannot run is a broken install, not a pass.
write_launcher jq 'echo "cannot execute" >&2; exit 1'
run_doctor
expect_line "[missing]  jq: $bin_dir/jq is on PATH but jq --version fails"
reject_line "[ok]       jq:"
rm -f "$bin_dir/jq"

# A caller cargo that does not run the pinned toolchain draws a warning naming
# the binary and both versions, without counting as a gap.
printf '[toolchain]\nchannel = "1.96.0"\ncomponents = ["rustfmt", "clippy"]\n' >"$intentd_dir/rust-toolchain.toml"
write_launcher cargo 'echo "cargo 1.98.0 (0123abcd 2026-01-01) (Homebrew)"'
run_doctor
expect_line "[warn]     cargo: plain cargo is $bin_dir/cargo (1.98.0), not the pinned Rust 1.96.0"
expect_line "put rustup's proxy directory first on PATH"
gaps_shadowed=$(grep -F 'Doctor found' "$output") || fail "expected a gap summary alongside the shadowed-cargo warning"

# A caller cargo honoring the pin is silent, and the warning above did not
# change the failure count.
write_launcher cargo 'echo "cargo 1.96.0 (0123abcd 2026-01-01)"'
run_doctor
reject_line "[warn]     cargo:"
gaps_matching=$(grep -F 'Doctor found' "$output") || fail "expected a gap summary with the matching cargo"
[[ "$gaps_shadowed" == "$gaps_matching" ]] || fail "shadowed-cargo warning changed the gap count: '$gaps_shadowed' vs '$gaps_matching'"

# Under make (MAKELEVEL set) the Makefile's rustup/cargo-bin PATH prepend is
# stripped, so the warning reflects the caller's own shell resolution even
# though the script itself sees the pinned toolchain first.
toolchain_bin="$temp_dir/rustup-toolchain/bin"
mkdir -p "$toolchain_bin"
printf '#!/usr/bin/env bash\necho "cargo 1.96.0 (feedface 2026-01-01)"\n' >"$toolchain_bin/cargo"
chmod +x "$toolchain_bin/cargo"
write_launcher rustup "[ \"\$1\" = which ] && { echo $toolchain_bin/cargo; exit 0; }; exit 1"
write_launcher cargo 'echo "cargo 1.98.0 (0123abcd 2026-01-01) (Homebrew)"'
make_path="$toolchain_bin/:$temp_dir/home/.cargo/bin:$bin_dir"
PATH="$make_path" HOME="$temp_dir/home" INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
  CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL=1 \
  BOOTSTRAP_PROBE_TIMEOUT=2 bash "$script" --check >"$output" 2>&1 || true
expect_line "[warn]     cargo: plain cargo is $bin_dir/cargo (1.98.0), not the pinned Rust 1.96.0"

# Without MAKELEVEL the same PATH is the caller's own: the pinned toolchain
# cargo is first, so the check is silent.
PATH="$make_path" HOME="$temp_dir/home" INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
  CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL= \
  BOOTSTRAP_PROBE_TIMEOUT=2 bash "$script" --check >"$output" 2>&1 || true
reject_line "[warn]     cargo:"

# A caller-exported CARGO_BIN_DIR overrides the Makefile's default bin dir; the
# strip must honor it, or the make-injected prefix survives and the check goes
# silent on the pinned toolchain cargo instead of warning on the caller's.
custom_cargo_bin="$temp_dir/custom-cargo-bin"
mkdir -p "$custom_cargo_bin"
PATH="$toolchain_bin/:$custom_cargo_bin:$bin_dir" HOME="$temp_dir/home" \
  INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
  CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL=1 \
  CARGO_BIN_DIR="$custom_cargo_bin" \
  BOOTSTRAP_PROBE_TIMEOUT=2 bash "$script" --check >"$output" 2>&1 || true
expect_line "[warn]     cargo: plain cargo is $bin_dir/cargo (1.98.0), not the pinned Rust 1.96.0"
rm -f "$bin_dir/rustup" "$bin_dir/cargo"

# A non-exact channel pin (named or partial) is not comparable to
# `cargo --version` output: the check skips silently instead of warning
# permanently on a pin-honoring rustup proxy.
write_launcher cargo 'echo "cargo 1.98.0 (0123abcd 2026-01-01) (Homebrew)"'
for channel in stable 1.96; do
  printf '[toolchain]\nchannel = "%s"\ncomponents = ["rustfmt", "clippy"]\n' "$channel" >"$intentd_dir/rust-toolchain.toml"
  run_doctor
  reject_line "[warn]     cargo:"
done
printf '[toolchain]\nchannel = "1.96.0"\ncomponents = ["rustfmt", "clippy"]\n' >"$intentd_dir/rust-toolchain.toml"
run_doctor
expect_line "[warn]     cargo: plain cargo is $bin_dir/cargo (1.98.0), not the pinned Rust 1.96.0"
rm -f "$bin_dir/cargo"

# Coverage tooling is optional. A cargo that answers `llvm-cov --version` and a
# rustup listing the pin plus the llvm-tools component print the version row.
# The pinned probe only runs once `rustup toolchain list` names the pin.
toolchain_listed='[ "$1" = toolchain ] && [ "$2" = list ] && { echo "1.96.0-x86_64-unknown-linux-gnu (default)"; exit 0; }'
row_ready="[optional] cargo-llvm-cov: cargo-llvm-cov 0.9.0 with llvm-tools-preview (make coverage-e2e / coverage-all)"
row_no_llvm_tools="[optional] cargo-llvm-cov: cargo-llvm-cov 0.9.0, but llvm-tools-preview is missing; run rustup component add llvm-tools-preview --toolchain 1.96.0"
row_not_installed="[optional] cargo-llvm-cov: not installed (only make coverage-e2e / coverage-all need it); run BOOTSTRAP_COVERAGE=1 make bootstrap-dev-host, or cargo install cargo-llvm-cov --locked && rustup component add llvm-tools-preview --toolchain 1.96.0"
pinned_cargo='echo "cargo 1.96.0 (0123abcd 2026-01-01)"'
write_launcher cargo "[ \"\$1\" = llvm-cov ] && { echo \"cargo-llvm-cov 0.9.0\"; exit 0; }; $pinned_cargo"
write_launcher rustup "$toolchain_listed"'; [ "$1" = component ] && { echo "llvm-tools-x86_64-unknown-linux-gnu"; exit 0; }; exit 1'
run_doctor
expect_line "$row_ready"
reject_line "[missing]  cargo-llvm-cov"
gaps_coverage_ready=$(grep -F 'Doctor found' "$output") || fail "expected a gap summary with coverage tooling present"

# Without the llvm-tools component the row names the rustup command for the
# pinned toolchain, which is the one the probe checked.
write_launcher rustup 'exit 1'
run_doctor
expect_line "$row_no_llvm_tools"
reject_line "[missing]  cargo-llvm-cov"
gaps_no_llvm_tools=$(grep -F 'Doctor found' "$output") || fail "expected a gap summary without llvm-tools"

# The probe and the remediation agree on the pinned toolchain in both
# directions: a component present only on the pin is ready, one present only
# on the rustup default is not, and the command then targets the pin.
write_launcher rustup "$toolchain_listed"'; if [ "$1" = component ] && [ "$2" = list ]; then case " $* " in *" --toolchain 1.96.0 "*) echo "llvm-tools-x86_64-unknown-linux-gnu"; exit 0 ;; esac; fi; exit 1'
run_doctor
expect_line "$row_ready"
write_launcher rustup "$toolchain_listed"'; if [ "$1" = component ] && [ "$2" = list ]; then case " $* " in *" --toolchain "*) exit 1 ;; esac; echo "llvm-tools-x86_64-unknown-linux-gnu"; exit 0; fi; exit 1'
run_doctor
expect_line "$row_no_llvm_tools"

# Without a readable pin the probe falls back to the active toolchain and the
# command stays unqualified.
mv "$intentd_dir/rust-toolchain.toml" "$temp_dir/rust-toolchain.toml.bak"
run_doctor
expect_line "$row_ready"
write_launcher rustup 'exit 1'
run_doctor
expect_line "[optional] cargo-llvm-cov: cargo-llvm-cov 0.9.0, but llvm-tools-preview is missing; run rustup component add llvm-tools-preview"
mv "$temp_dir/rust-toolchain.toml.bak" "$intentd_dir/rust-toolchain.toml"

# A cargo without the llvm-cov subcommand (exit 101, as cargo reports an
# unknown command) yields the not-installed row naming both install routes.
# None of the three states prints [missing] or changes the gap count.
write_launcher rustup '[ "$1" = component ] && { echo "llvm-tools-x86_64-unknown-linux-gnu"; exit 0; }; exit 1'
write_launcher cargo "[ \"\$1\" = llvm-cov ] && { echo \"error: no such command: llvm-cov\" >&2; exit 101; }; $pinned_cargo"
run_doctor
expect_line "$row_not_installed"
reject_line "[missing]  cargo-llvm-cov"
gaps_coverage_missing=$(grep -F 'Doctor found' "$output") || fail "expected a gap summary with coverage tooling absent"
[[ "$gaps_coverage_ready" == "$gaps_coverage_missing" && "$gaps_coverage_ready" == "$gaps_no_llvm_tools" ]] \
  || fail "coverage tooling changed the gap count: '$gaps_coverage_ready' vs '$gaps_no_llvm_tools' vs '$gaps_coverage_missing'"

# Without any cargo the row degrades to not-installed instead of failing.
rm -f "$bin_dir/cargo" "$bin_dir/rustup"
run_doctor
expect_line "$row_not_installed"
reject_line "[missing]  cargo-llvm-cov"

# Recent rustup auto-installs a named-but-absent toolchain on `rustup run` and
# `rustup component list --toolchain`, and even `rustup toolchain list` when
# RUSTUP_AUTO_INSTALL is unset and the cwd pins an absent override. The doctor
# is read-only: with the pin absent from `rustup toolchain list` the
# toolchain-specific probes never run, and every rustup invocation sees
# RUSTUP_AUTO_INSTALL=0. Both sub-cases run the script with
# RUSTUP_AUTO_INSTALL=1 inherited so the sentinel only passes because the
# script exports 0 itself, not because the test runner already had it set.
# write_rustup_stub [toolchain...]: a rustup that logs each argv line (plus a
# sentinel when RUSTUP_AUTO_INSTALL is not 0), lists the given toolchains, and
# answers every probe as if the pin were complete.
rustup_log="$temp_dir/rustup.log"
rustup_toolchains="$temp_dir/rustup-toolchains"
write_rustup_stub() {
  : >"$rustup_toolchains"
  local toolchain
  for toolchain in "$@"; do
    printf '%s\n' "$toolchain" >>"$rustup_toolchains"
  done
  cat >"$bin_dir/rustup" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$rustup_log"
[ "\${RUSTUP_AUTO_INSTALL-unset}" = 0 ] || echo "RUSTUP_AUTO_INSTALL=\${RUSTUP_AUTO_INSTALL-unset}" >>"$rustup_log"
case "\$1 \${2-}" in
  "--version ") echo "rustup 1.29.0 (stub 2026-03-05)"; exit 0 ;;
  "toolchain list") cat "$rustup_toolchains"; exit 0 ;;
  "show active-toolchain") echo "1.96.0-x86_64-unknown-linux-gnu (default)"; exit 0 ;;
  "run 1.96.0") echo "rustc 1.96.0 (stub 2026-01-01)"; exit 0 ;;
  "component list") printf '%s\n' rustfmt-x86_64-unknown-linux-gnu clippy-x86_64-unknown-linux-gnu llvm-tools-x86_64-unknown-linux-gnu; exit 0 ;;
esac
exit 1
EOF
  chmod +x "$bin_dir/rustup"
}
write_launcher cargo "[ \"\$1\" = llvm-cov ] && { echo \"cargo-llvm-cov 0.9.0\"; exit 0; }; $pinned_cargo"
write_rustup_stub "stable-x86_64-unknown-linux-gnu" "1.95.0-x86_64-unknown-linux-gnu (active, default)"
: >"$rustup_log"
RUSTUP_AUTO_INSTALL=1 run_doctor
expect_line "[missing]  Rust toolchain: 1.96.0 with rustfmt and clippy"
reject_line "[ok]       Rust toolchain:"
expect_line "$row_no_llvm_tools"
reject_line "$row_ready"
grep -qx 'toolchain list' "$rustup_log" || fail "doctor did not consult rustup toolchain list: $(cat "$rustup_log")"
! grep -q '^run ' "$rustup_log" || fail "doctor ran rustup run against an absent pin: $(cat "$rustup_log")"
! grep -q 'component list --toolchain 1.96.0' "$rustup_log" || fail "doctor listed components of an absent pin: $(cat "$rustup_log")"
! grep -q '^RUSTUP_AUTO_INSTALL=' "$rustup_log" || fail "rustup ran without RUSTUP_AUTO_INSTALL=0: $(grep '^RUSTUP_AUTO_INSTALL=' "$rustup_log" | head -n 1)"

# With the pin installed the same probes run, so the gate does not silently
# disable the toolchain and coverage checks.
write_rustup_stub "stable-x86_64-unknown-linux-gnu" "1.96.0-x86_64-unknown-linux-gnu (active, default)"
: >"$rustup_log"
RUSTUP_AUTO_INSTALL=1 run_doctor
expect_line "[ok]       Rust toolchain: 1.96.0 with rustfmt and clippy"
expect_line "[ok]       active Rust toolchain: 1.96.0"
expect_line "$row_ready"
grep -qx 'run 1.96.0 rustc --version' "$rustup_log" || fail "doctor skipped rustup run on an installed pin: $(cat "$rustup_log")"
grep -qx 'component list --toolchain 1.96.0 --installed' "$rustup_log" || fail "doctor skipped component list on an installed pin: $(cat "$rustup_log")"
! grep -q '^RUSTUP_AUTO_INSTALL=' "$rustup_log" || fail "rustup ran without RUSTUP_AUTO_INSTALL=0: $(grep '^RUSTUP_AUTO_INSTALL=' "$rustup_log" | head -n 1)"
rm -f "$bin_dir/cargo" "$bin_dir/rustup"

# install_coverage_tooling is a no-op unless opted in; opted in, it skips a
# complete host and runs cargo install / rustup component add for the gaps.
bootstrap_funcs="$temp_dir/bootstrap-funcs.sh"
sed '/^if \[\[ "\$MODE" == check \]\]; then$/,$d' "$script" >"$bootstrap_funcs"
grep -q '^install_coverage_tooling() {' "$bootstrap_funcs" || fail "could not extract bootstrap functions for the install_coverage_tooling fixture"
tool_log="$temp_dir/tool.log"
run_install_coverage() {
  : >"$tool_log"
  PATH="$bin_dir" HOME="$temp_dir/home" INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
    CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL= TOOL_LOG="$tool_log" BOOTSTRAP_COVERAGE="$1" \
    bash -c 'funcs=$1; set --; source "$funcs"; load_versions; install_coverage_tooling' bash "$bootstrap_funcs" >"$output" 2>&1 \
    || fail "install_coverage_tooling exited non-zero with BOOTSTRAP_COVERAGE=$1"
}
write_launcher cargo "[ \"\$1\" = install ] && { echo \"cargo \$*\" >>\"\$TOOL_LOG\"; exit 0; }; [ \"\$1\" = llvm-cov ] && exit 101; $pinned_cargo"
write_launcher rustup '[ "$1" = component ] && [ "$2" = add ] && { echo "rustup $*" >>"$TOOL_LOG"; exit 0; }; exit 1'
run_install_coverage 0
[[ ! -s "$output" ]] || fail "default bootstrap mentioned coverage tooling: $(cat "$output")"
[[ ! -s "$tool_log" ]] || fail "default bootstrap installed coverage tooling: $(cat "$tool_log")"
run_install_coverage 1
expect_line "[install] cargo-llvm-cov"
expect_line "[install] llvm-tools-preview component for Rust 1.96.0"
grep -qx 'cargo install cargo-llvm-cov --locked' "$tool_log" || fail "opt-in bootstrap did not run cargo install cargo-llvm-cov --locked: $(cat "$tool_log")"
grep -qx 'rustup component add --toolchain 1.96.0 llvm-tools-preview' "$tool_log" || fail "opt-in bootstrap did not add llvm-tools-preview: $(cat "$tool_log")"
write_launcher cargo "[ \"\$1\" = llvm-cov ] && { echo \"cargo-llvm-cov 0.9.0\"; exit 0; }; $pinned_cargo"
write_launcher rustup "$toolchain_listed"'; [ "$1" = component ] && [ "$2" = list ] && { echo "llvm-tools-x86_64-unknown-linux-gnu"; exit 0; }; exit 1'
run_install_coverage 1
expect_line "[skip] cargo-llvm-cov 0.9.0 with llvm-tools-preview already installed"
reject_line "[install]"
rm -f "$bin_dir/cargo" "$bin_dir/rustup"

# pnpm_ready (install mode) probes `pnpm --version` and compares the pinned
# version against the semver-shaped output line, so a tracer's startup log
# ahead of it (intent-hq/intent#5509) does not report pnpm as not ready.
run_pnpm_ready() {
  PATH="$bin_dir" HOME="$temp_dir/home" INTENTD_DIR="$intentd_dir" FE_DIR="$fe_dir" \
    CARGO_HOME="$temp_dir/home/.cargo" CARGO_INSTALL_ROOT= MAKELEVEL= BOOTSTRAP_PROBE_TIMEOUT=2 \
    bash -c 'funcs=$1; set --; source "$funcs"; load_versions; pnpm_ready; status=$?; printf "%s\n" "$PROBE_OUTPUT"; exit "$status"' bash "$bootstrap_funcs" >"$output" 2>&1
}
write_launcher corepack 'echo 0.35.0'
write_launcher pnpm "echo '$dd_banner'; echo 10.30.3"
run_pnpm_ready || fail "pnpm_ready rejected the pinned pnpm behind a startup banner: $(cat "$output")"
expect_line "10.30.3"
write_launcher pnpm "echo '$dd_banner'; echo 10.29.0"
! run_pnpm_ready || fail "pnpm_ready accepted pnpm 10.29.0 against the 10.30.3 pin"
expect_line "10.29.0"
write_launcher pnpm "echo '$dd_banner'"
! run_pnpm_ready || fail "pnpm_ready accepted a launcher that printed only a startup banner"
rm -f "$bin_dir/pnpm"

echo "bootstrap-dev-host tests passed"
