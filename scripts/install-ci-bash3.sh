#!/usr/bin/env bash
# Build the compatibility interpreter in an isolated directory on Linux CI.
set -euo pipefail

prefix=${1:?usage: install-ci-bash3.sh INSTALL_DIRECTORY}
mkdir -p "$prefix"
prefix=$(cd "$prefix" && pwd -P)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl --fail --location --silent --show-error --retry 3 \
  https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz --output "$scratch/bash.tar.gz"
(
  cd "$scratch"
  echo '3fa9daf85ebf35068f090ce51283ddeeb3c75eb5bc70b1a4a7cb05868bfe06a4  bash.tar.gz' | sha256sum --check
  tar -xzf bash.tar.gz
  cd bash-3.2.57
  ./configure --prefix="$prefix" --without-bash-malloc --disable-nls > configure.log 2>&1 || { cat configure.log; exit 1; }
  # Bash 3.2's readline Makefile races under parallel make (ar runs before
  # histsearch.o exists), so build serially and ignore inherited job flags.
  unset MAKEFLAGS MFLAGS GNUMAKEFLAGS
  make -j1 > build.log 2>&1 || { cat build.log; exit 1; }
  install -m 755 bash "$prefix/bash"
)
version=$("$prefix/bash" -c 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"')
[[ "$version" == 3.2 ]] || { echo "Expected Bash 3.2, got $version" >&2; exit 1; }
"$prefix/bash" --version
if [[ -n ${GITHUB_ENV:-} ]]; then
  printf 'BASH3_BIN=%s/bash\n' "$prefix" >> "$GITHUB_ENV"
fi
