#!/bin/bash
# shellcheck source-path=SCRIPTDIR
# Install or update the macOS GitHub Actions runner slots on a Mac (Apple
# Silicon, macOS 26 or later). Idempotent: re-running reapplies the files,
# builds the VM image when provision.sh or the base changed (running jobs keep
# their VM; the next job uses the new image) and loads exactly the slots that
# /etc/github-runners/runners.env describes, draining and removing any others.
#
# Usage (as root, from a checkout of this repo):
#   sudo infra/runners/macos/install.sh [--config FILE] [--no-build] [--plan]
#
#   --config FILE  Seed /etc/github-runners/runners.env from FILE (a file under
#                  macos/hosts/); used only if none exists yet.
#   --no-build     Skip the image build (config-only change); needs an image
#                  from an earlier run.
#   --plan         Print what would be done, change nothing (root not needed).
#
# Installs tart, softnet and jq with Homebrew as MAC_HOST_USER (who owns
# ~/.tart and runs the slots), lets that user start softnet as root (Tart
# runs it with sudo), the supervisors, the image and one LaunchDaemon per
# slot. Slots load only once the credential exists at
# /etc/github-runners/credentials (owned by MAC_HOST_USER, 0600). See
# docs/GITHUB_RUNNERS.md, "macOS hosts (Tart)".
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=supervisor.sh
. "$here/supervisor.sh"

prefix="${INSTALL_PREFIX:-}"
etc_dir="$prefix/etc/github-runners"
lib_dir="$prefix/usr/local/lib/github-runners"
daemon_dir="$prefix/Library/LaunchDaemons"
log_dir="$prefix/var/log"
sudoers="$prefix/etc/sudoers.d/github-runners-softnet"
credentials="$etc_dir/credentials"
image_file="$etc_dir/macos-image"
brew_bin="${INSTALL_BREW_PREFIX:-/opt/homebrew}/bin"
brew="$brew_bin/brew"
softnet="$brew_bin/softnet"
min_macos=26
label_prefix=com.intent.github-runner

build=1
plan_only=0
seed_config="$here/hosts/intent-mac1.env"
seed_given=0

log() { echo "install: $*"; }
die() { echo "install: error: $*" >&2; exit 1; }
usage() { echo "usage: $0 [--config FILE] [--no-build] [--plan]" >&2; exit 2; }
# would MESSAGE: in --plan, print MESSAGE and return 0 (skip the step).
would() { if [ "$plan_only" = 1 ]; then echo "plan: would $*"; return 0; fi; return 1; }

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-build) build=0 ;;
      --plan) plan_only=1 ;;
      --config)
        [ "$#" -ge 2 ] || usage
        [ -f "$2" ] || die "--config: no such file $2"
        seed_config="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
        seed_given=1
        shift ;;
      -h|--help) usage ;;
      *) echo "unknown argument: $1" >&2; usage ;;
    esac
    shift
  done
}

check_host() {
  [ "$(uname -s)" = Darwin ] || die "expected macOS, found $(uname -s)"
  [ "$(uname -m)" = arm64 ] || die "expected Apple Silicon (arm64), found $(uname -m)"
  local version major
  version="$(sw_vers -productVersion)"
  major="${version%%.*}"
  # A macOS guest cannot be newer than its host; the image is macOS 26.
  if [[ ! "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt "$min_macos" ]; then
    die "expected macOS $min_macos or later, found $version"
  fi
  if [ "$plan_only" = 0 ]; then [ "$(id -u)" = 0 ] || die "run as root (sudo)"; fi
}

# The config: the installed one, else the seed. Sets the MAC_* values.
read_config() {
  config_file="$seed_config"
  if [ -f "$etc_dir/runners.env" ]; then
    config_file="$etc_dir/runners.env"
    if [ "$seed_given" = 1 ] && ! cmp -s "$seed_config" "$config_file"; then
      log "keeping existing $config_file (differs from $seed_config)"
    fi
  fi
  load_mac_config
  wanted="$(mac_plan)"
  mac_host_check
  id -u "$MAC_HOST_USER" >/dev/null 2>&1 || die "MAC_HOST_USER $MAC_HOST_USER does not exist; create the account first"
  host_uid="$(id -u "$MAC_HOST_USER")"
  host_home="$(dscl . -read "/Users/$MAC_HOST_USER" NFSHomeDirectory | awk '{ print $2 }')"
  [ -d "$host_home" ] || die "home directory of $MAC_HOST_USER not found ($host_home)"
  log "host user $MAC_HOST_USER ($host_home); slots: $(tr '\n' ' ' <<<"$wanted")"
}

# as_user CMD...: run as MAC_HOST_USER with its HOME and Homebrew on PATH.
as_user() {
  sudo -n -u "$MAC_HOST_USER" -H env "HOME=$host_home" "PATH=$brew_bin:/usr/bin:/bin:/usr/sbin:/sbin" "$@"
}

install_packages() {
  [ -x "$brew" ] || die "Homebrew is missing ($brew); install it for $MAC_HOST_USER first (https://brew.sh)"
  local missing="" tool
  for tool in tart softnet jq; do [ -x "$brew_bin/$tool" ] || missing="$missing $tool"; done
  [ -n "$missing" ] || return 0
  would "brew install:$missing (as $MAC_HOST_USER)" && return 0
  log "installing$missing with Homebrew"
  local formulas="" f
  for f in $missing; do
    case "$f" in tart|softnet) formulas="$formulas cirruslabs/cli/$f" ;; *) formulas="$formulas $f" ;; esac
  done
  # shellcheck disable=SC2086  # a word list
  as_user "$brew" install --quiet $formulas
}

# Tart starts softnet with sudo when it is not SUID root; let the host user do
# that without a password, and nothing else.
configure_softnet() {
  local tmp
  tmp="$(mktemp)"
  printf '# Written by infra/runners/macos/install.sh: Tart runs softnet as root for --net-softnet.\n%s ALL=(root) NOPASSWD: %s\n' \
    "$MAC_HOST_USER" "$softnet" > "$tmp"
  if [ -f "$sudoers" ] && cmp -s "$tmp" "$sudoers"; then rm -f "$tmp"; return 0; fi
  if would "write $sudoers: $MAC_HOST_USER may run $softnet as root"; then rm -f "$tmp"; return 0; fi
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers drop-in for softnet does not validate"; }
  install -d -m 0755 "$(dirname "$sudoers")"
  install -m 0440 "$tmp" "$sudoers"
  rm -f "$tmp"
}

check_softnet() {
  would "check that $MAC_HOST_USER can run $softnet as root without a password" && return 0
  [ -x "$softnet" ] || die "softnet is missing ($softnet)"
  as_user sudo -n -l "$softnet" >/dev/null 2>&1 || die "$MAC_HOST_USER cannot run $softnet with sudo -n; check $sudoers"
}

# Copy via a temp file and rename, so a running script keeps its old inode.
put() {
  local mode="$1" src="$2" dest="$3" tmp
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    if [ "$plan_only" = 0 ]; then chmod "$mode" "$dest"; fi
    return 1
  fi
  if would "install $dest"; then return 0; fi
  tmp="$(dirname "$dest")/.$(basename "$dest").tmp"
  install -m "$mode" "$src" "$tmp"
  mv -f "$tmp" "$dest"
  return 0
}

install_files() {
  if ! would "create $lib_dir/macos and $etc_dir (0700, owned by $MAC_HOST_USER)"; then
    install -d -m 0755 "$lib_dir" "$lib_dir/macos" "$daemon_dir" "$log_dir"
    install -d -m 0700 "$etc_dir"
    chown "$MAC_HOST_USER" "$etc_dir"
  fi
  put 0755 "$here/../supervisor.sh" "$lib_dir/supervisor.sh" || true
  put 0755 "$here/supervisor.sh" "$lib_dir/macos/supervisor.sh" || true
  if [ ! -f "$etc_dir/runners.env" ]; then
    if ! would "install $etc_dir/runners.env from $seed_config"; then
      install -m 0644 "$seed_config" "$etc_dir/runners.env"
    fi
  fi
}

build_image() {
  if [ "$build" = 0 ]; then
    [ -f "$image_file" ] || [ "$plan_only" = 1 ] || die "--no-build, but no image is recorded in $image_file yet"
    return 0
  fi
  would "build the VM image from $MAC_BASE_IMAGE as $MAC_HOST_USER (build-image.sh) and record it in $image_file" && return 0
  local name old
  name="$(as_user /bin/bash "$here/build-image.sh" "$MAC_BASE_IMAGE")" || die "image build failed (see above)"
  [[ "$name" =~ ^intent-mac-runner-[0-9a-f]{12}$ ]] || die "build-image.sh printed an unexpected name: $name"
  printf '%s\n' "$name" > "$image_file.tmp"
  chmod 0644 "$image_file.tmp"
  mv -f "$image_file.tmp" "$image_file"
  log "image $name"
  # Clones are copy-on-write copies, so a running slot does not need the
  # image it was cloned from.
  for old in $(as_user tart list --source local --quiet | grep -E '^intent-mac-runner-[0-9a-f]{12}$' || true); do
    [ "$old" = "$name" ] && continue
    log "deleting old image $old"
    as_user tart delete "$old" || log "warning: could not delete $old"
  done
}

render_plist() {
  local t
  t="$(cat "$here/com.intent.github-runner.plist")"
  t="${t//@SLOT@/$1}"
  t="${t//@USER@/$MAC_HOST_USER}"
  t="${t//@HOME@/$host_home}"
  t="${t//@SUPERVISOR@/${lib_dir#"$prefix"}/macos/supervisor.sh}"
  t="${t//@LOG@/${log_dir#"$prefix"}/github-runner-$1.log}"
  printf '%s\n' "$t"
}

loaded() { launchctl print "system/$label_prefix.$1" >/dev/null 2>&1; }

loaded_slots() {
  local f
  for f in "$daemon_dir/$label_prefix".slot-*.plist; do
    [ -e "$f" ] || continue
    f="${f##*/"$label_prefix".}"
    echo "${f%.plist}"
  done
}

credential_ok() {
  [ -f "$credentials" ] || return 1
  local mode owner
  read -r mode owner <<<"$(file_mode_uid "$credentials")"
  if [ "$owner" != "$host_uid" ] || [[ ! "$mode" =~ ^[0-7]00$ ]]; then
    die "$credentials must be owned by $MAC_HOST_USER with mode 600"
  fi
}

apply_slots() {
  local n plist tmp
  for n in $(loaded_slots); do
    grep -qx -- "$n" <<<"$wanted" && continue
    would "drain and remove slot $n" && continue
    log "draining and removing slot $n"
    launchctl bootout "system/$label_prefix.$n" >/dev/null 2>&1 || true
    rm -f "$daemon_dir/$label_prefix.$n.plist"
    as_user tart stop "intent-$n" --timeout 30 >/dev/null 2>&1 || true
    as_user tart delete "intent-$n" >/dev/null 2>&1 || true
  done
  if [ "$plan_only" = 1 ]; then
    if [ -f "$credentials" ]; then echo "plan: credential present at $credentials"; else echo "plan: credential missing at $credentials: slots would not load"; fi
  elif ! credential_ok; then
    log "credential missing: place it at $credentials (owned by $MAC_HOST_USER, 0600; see docs/GITHUB_RUNNERS.md), then re-run"
    return 0
  fi
  if ! would "apply the runner group $RUNNER_GROUP (supervisor.sh --group-apply)"; then
    as_user env RUNNERS_CONFIG="$etc_dir/runners.env" RUNNERS_CREDENTIALS="$credentials" \
      /bin/bash "$lib_dir/macos/supervisor.sh" --group-apply \
      || die "could not set up the runner group (see above); slots left unchanged"
  fi
  for n in $wanted; do
    plist="$daemon_dir/$label_prefix.$n.plist"
    tmp="$(mktemp)"
    render_plist "$n" > "$tmp"
    if [ "$plan_only" = 1 ]; then
      echo "plan: would load slot $n from $plist:"
      cat "$tmp"
      rm -f "$tmp"
      continue
    fi
    if [ -f "$plist" ] && cmp -s "$tmp" "$plist" && loaded "$n"; then rm -f "$tmp"; continue; fi
    # A loaded slot drains (finishes its job) before it reloads.
    if loaded "$n"; then
      log "reloading slot $n (waits for a running job)"
      launchctl bootout "system/$label_prefix.$n" >/dev/null 2>&1 || true
    fi
    install -m 0644 "$tmp" "$plist"
    rm -f "$tmp"
    chown root:wheel "$plist"
    touch "$log_dir/github-runner-$n.log"
    chown "$MAC_HOST_USER" "$log_dir/github-runner-$n.log"
    launchctl bootstrap system "$plist"
  done
  if [ "$plan_only" = 0 ]; then log "slots loaded: $(tr '\n' ' ' <<<"$wanted")"; fi
}

# The host never sleeps and comes back after a power cut.
configure_power() {
  would "set pmset: sleep 0, disksleep 0, autorestart 1" && return 0
  pmset -a sleep 0 disksleep 0 autorestart 1 >/dev/null
}

install_main() {
  parse_args "$@"
  check_host
  read_config
  install_packages
  configure_softnet
  check_softnet
  configure_power
  install_files
  build_image
  apply_slots
}

install_main "$@"
