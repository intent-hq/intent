#!/usr/bin/env bash
# Repack a released Linux musl tarball into a Debian package.
#
# Usage: scripts/build-deb.sh <tarball> <version> <deb-arch>
#   <tarball>   intentd-{x86_64,aarch64}-unknown-linux-musl.tar.xz release asset
#   <version>   Debian version, i.e. the release tag without the leading "v"
#   <deb-arch>  amd64 | arm64
#
# Produces intentd_<version>_<deb-arch>.deb in the current directory:
#   /usr/bin/intentd                       the release binary
#   /usr/lib/systemd/user/intentd.service  systemd *user* unit (packaging/deb/)
#
# The unit is NOT auto-enabled on install: maintainer scripts run as root and
# cannot enable user units for individual users. postinst prints the hint
# (systemctl --user enable --now intentd) instead.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <tarball> <version> <deb-arch>" >&2
  exit 2
fi

tarball=$1
version=$2
arch=$3

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Reject unsafe member paths (absolute or with ".." components) before
# extracting, and do not honor archived ownership/permissions — the payload
# modes are set explicitly by the install calls below.
if tar -tJf "$tarball" | grep -E '^/|(^|/)\.\.(/|$)' >/dev/null; then
  echo "error: unsafe member path in $tarball" >&2
  exit 1
fi

mkdir "$staging/extract"
tar -xJf "$tarball" -C "$staging/extract" --no-same-owner --no-same-permissions
binary=$(find "$staging/extract" -type f -name intentd | head -n1)
if [[ -z "$binary" ]]; then
  echo "error: no intentd binary found in $tarball" >&2
  exit 1
fi

pkg="$staging/pkg"
install -d "$pkg/usr/bin" "$pkg/usr/lib/systemd/user"
install -m 0755 "$binary" "$pkg/usr/bin/intentd"
install -m 0644 "$repo_root/packaging/deb/intentd.service" \
  "$pkg/usr/lib/systemd/user/intentd.service"

# Payload size only — computed before DEBIAN/ exists.
installed_size=$(du -sk "$pkg" | cut -f1)

install -d "$pkg/DEBIAN"
install -m 0755 "$repo_root/packaging/deb/postinst" "$pkg/DEBIAN/postinst"
cat >"$pkg/DEBIAN/control" <<EOF
Package: intentd
Version: $version
Architecture: $arch
Maintainer: Intent HQ <intent-hq@users.noreply.github.com>
Section: utils
Priority: optional
Installed-Size: $installed_size
Homepage: https://github.com/intent-hq/intentd
Description: Intent backend daemon
 Local-first JSON-RPC daemon for the Intent domain model. Ships a systemd
 user unit; start it at login with: systemctl --user enable --now intentd
EOF

dpkg-deb --build --root-owner-group "$pkg" "intentd_${version}_${arch}.deb"
