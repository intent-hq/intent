#!/usr/bin/env bash
# Build the compatibility interpreter in an isolated directory on Linux CI.
#
#   install-ci-bash3.sh DIR          reuse DIR/bash when it is exactly Bash 3.2.57;
#                                    otherwise download, verify the pinned sha256
#                                    and build it into DIR. Writes BASH3_BIN to
#                                    GITHUB_ENV when set.
#   install-ci-bash3.sh --check DIR  exit 0 only when DIR/bash is exactly 3.2.57
#   install-ci-bash3.sh --cache-key  print the CI cache key for this pin
#
# CI calls it through .github/actions/setup-bash3, which restores DIR from the
# Actions cache under --cache-key first; a restored binary is trusted only
# after the same exact-version check. `make bash3` uses it for local builds.
set -euo pipefail

bash_version=3.2.57
bash_sha256=3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4

is_pinned_bash() {
  [[ -f "$1" && -x "$1" ]] || return 1
  [[ "$("$1" -c 'printf "%s" "${BASH_VERSION%%(*}"' 2>/dev/null)" == "$bash_version" ]]
}

# The key changes with the source pin, this installer (configure flags) and
# the runner image the binary was linked on.
cache_key() {
  local os_id=unknown installer
  if [[ -r /etc/os-release ]]; then
    os_id=$(. /etc/os-release && printf '%s-%s' "${ID:-unknown}" "${VERSION_ID:-unknown}")
  fi
  installer=$(sha256sum "${BASH_SOURCE[0]}")
  printf 'bash3-v1-%s-%s-%s-%s-%s\n' "$(uname -s)" "$(uname -m)" "$os_id" \
    "$bash_sha256" "${installer:0:16}"
}

case "${1:-}" in
  --cache-key)
    cache_key
    exit 0
    ;;
  --check)
    dir=${2:?usage: install-ci-bash3.sh --check INSTALL_DIRECTORY}
    if is_pinned_bash "$dir/bash"; then
      echo "Found Bash $bash_version at $dir/bash" >&2
      exit 0
    fi
    echo "No usable Bash $bash_version at $dir/bash" >&2
    exit 1
    ;;
esac

prefix=${1:?usage: install-ci-bash3.sh INSTALL_DIRECTORY}
mkdir -p "$prefix"
prefix=$(cd "$prefix" && pwd -P)

if is_pinned_bash "$prefix/bash"; then
  echo "Reusing verified Bash $bash_version at $prefix/bash"
else
  rm -f "$prefix/bash"
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  downloaded=false
  for source in \
    https://ftp.gnu.org/gnu/bash/bash-$bash_version.tar.gz \
    https://mirrors.kernel.org/gnu/bash/bash-$bash_version.tar.gz; do
    if curl --fail --location --silent --show-error --retry 2 \
      --connect-timeout 10 --max-time 120 --retry-max-time 60 \
      "$source" --output "$scratch/bash.tar.gz"; then
      downloaded=true
      break
    fi
    echo "Bash 3.2 download failed from $source; trying the next source" >&2
  done
  if [[ "$downloaded" != true ]]; then
    echo 'Unable to download pinned Bash 3.2 from any source' >&2
    exit 1
  fi
  (
    cd "$scratch"
    echo "$bash_sha256  bash.tar.gz" | sha256sum --check
    tar -xzf bash.tar.gz
    cd "bash-$bash_version"
    ./configure --prefix="$prefix" --without-bash-malloc --disable-nls > configure.log 2>&1 || { cat configure.log; exit 1; }
    # Bash 3.2's readline Makefile races under parallel make (ar runs before
    # histsearch.o exists), so build serially and ignore inherited job flags.
    unset MAKEFLAGS MFLAGS GNUMAKEFLAGS
    make -j1 > build.log 2>&1 || { cat build.log; exit 1; }
    install -m 755 bash "$prefix/bash"
  )
  is_pinned_bash "$prefix/bash" || {
    echo "Expected Bash $bash_version from the build at $prefix/bash" >&2
    exit 1
  }
fi
"$prefix/bash" --version
if [[ -n ${GITHUB_ENV:-} ]]; then
  printf 'BASH3_BIN=%s/bash\n' "$prefix" >> "$GITHUB_ENV"
fi
