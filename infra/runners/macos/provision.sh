#!/bin/bash
# Bake the macOS runner image: runs inside a fresh guest cloned from the
# pinned cirruslabs base (build-image.sh pipes it to `tart exec`), as the
# guest's admin user. Installs the pinned GitHub Actions runner and rustup,
# the tools routed macOS jobs call without a setup step, and the run-jit.sh
# entry point the supervisor starts each job with. Stock /bin/bash 3.2.
#
# The guest is thrown away after one job, so admin keeps the passwordless sudo
# the base image grants: actions/setup-python installs with sudo on macOS
# (the old persistent m1mac runner failed there without it).
#
# Paths: HOME=/Users/admin, runner in ~/actions-runner, jobs in ~/work,
# CARGO_HOME=~/.cargo, RUSTUP_HOME=~/.rustup.
set -euo pipefail

# Bump at least monthly with ../Dockerfile's RUNNER_VERSION (GitHub stops
# sending jobs to runners more than 30 days old). The SHA-256 is the
# osx-arm64 one from the release notes.
RUNNER_VERSION=2.338.0
RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
# rustup-init for aarch64-apple-darwin, same version as ../Dockerfile. No
# default toolchain: jobs install the one rust-toolchain.toml pins.
RUSTUP_VERSION=1.29.1
RUSTUP_SHA256=ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a
# Preinstalled on GitHub-hosted macOS images and called by routed jobs
# without a setup step (release-cache's tailcat fallback runs `brew install`).
BREW_PACKAGES="gh jq zstd git-lfs"

say() { echo "provision: $*"; }
die() { echo "provision: error: $*" >&2; exit 1; }

home=/Users/admin
runner_dir="$home/actions-runner"
[ "$(id -un)" = admin ] || die "run as the guest's admin user (found $(id -un))"
[ "$(uname -m)" = arm64 ] || die "expected an arm64 guest"
sudo -n true 2>/dev/null || die "admin needs passwordless sudo in the guest (actions/setup-python uses it)"

# check_sha256 FILE SHA
check_sha256() {
  echo "$2  $1" | shasum -a 256 -c - >/dev/null || die "checksum mismatch for $1"
}

say "power: never sleep; Spotlight indexing and automatic updates off"
sudo -n pmset -a sleep 0 displaysleep 0 disksleep 0 standby 0 powernap 0 >/dev/null
sudo -n mdutil -a -i off >/dev/null 2>&1 || true
sudo -n softwareupdate --schedule off >/dev/null 2>&1 || true

say "GitHub Actions runner $RUNNER_VERSION"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/runner.tgz" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
check_sha256 "$tmp/runner.tgz" "$RUNNER_SHA256"
rm -rf "$runner_dir"
mkdir -p "$runner_dir" "$home/work"
tar xzf "$tmp/runner.tgz" -C "$runner_dir"

say "rustup $RUSTUP_VERSION (no default toolchain)"
curl -fsSL --retry 3 -o "$tmp/rustup-init" \
  "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/aarch64-apple-darwin/rustup-init"
check_sha256 "$tmp/rustup-init" "$RUSTUP_SHA256"
chmod +x "$tmp/rustup-init"
"$tmp/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none >/dev/null

say "Homebrew packages: $BREW_PACKAGES"
brew=/opt/homebrew/bin/brew
[ -x "$brew" ] || die "Homebrew is missing from the base image ($brew)"
# shellcheck disable=SC2086  # a word list
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$brew" install --quiet $BREW_PACKAGES
"$brew" cleanup --prune=all >/dev/null 2>&1 || true

# The runner reads .path and .env from its directory; tart exec starts it with
# a bare PATH, so set the one hosted macOS runners have.
printf '%s\n' "$home/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" > "$runner_dir/.path"
cat > "$runner_dir/.env" <<'ENV'
LANG=en_US.UTF-8
ImageOS=macos26
CARGO_HOME=/Users/admin/.cargo
RUSTUP_HOME=/Users/admin/.rustup
ENV

# The supervisor's entry point: the JIT config arrives on stdin (never in
# argv), and the runner takes it from ACTIONS_RUNNER_INPUT_JITCONFIG, which it
# clears after reading. One job, then the runner exits.
cat > "$runner_dir/run-jit.sh" <<'SH'
#!/bin/bash
set -euo pipefail
if [ "$(id -u)" = 0 ]; then exec sudo -n -u admin -H "$0" "$@"; fi
IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG || true
if [ -z "$ACTIONS_RUNNER_INPUT_JITCONFIG" ]; then
  echo "run-jit: no JIT config on stdin" >&2
  exit 2
fi
export ACTIONS_RUNNER_INPUT_JITCONFIG
export HOME=/Users/admin
cd /Users/admin/actions-runner
exec ./run.sh </dev/null
SH
chmod 0755 "$runner_dir/run-jit.sh"

say "versions"
"$runner_dir/bin/Runner.Listener" --version
"$home/.cargo/bin/rustup" --version 2>/dev/null
command -v git python3 xcodebuild
say "done"
