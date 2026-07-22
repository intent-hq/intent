Ships `.deb` packages for intentd releases so Linux users get `systemctl --user enable --now intentd` from the package — replacing the `intentd service install` self-installer being removed in the parallel service-subcommand-removal PR.

## What

cargo-dist has no native .deb installer, so this adds a custom post-announce job (same pattern as `./publish-channel-manifest`) that repacks the released musl tarballs into Debian packages and uploads them onto the same GitHub release:

- **`packaging/deb/intentd.service`** — systemd **user** unit mirroring the exact semantics `service install` generated (`Type=simple`, `ExecStart=/usr/bin/intentd serve`, `ExecStop=/usr/bin/intentd stop`, `Restart=on-failure`, `WantedBy=default.target`).
- **`packaging/deb/postinst`** — prints the enable hint; deliberately does **not** auto-enable (maintainer scripts run as root and cannot enable user units per user).
- **`scripts/build-deb.sh`** — repacks a musl tarball into `intentd_<version>_{amd64,arm64}.deb` via `dpkg-deb` (binary at `/usr/bin/intentd`, unit at `/usr/lib/systemd/user/intentd.service`).
- **`.github/workflows/build-deb.yml`** — reusable workflow declared via `post-announce-jobs` in `dist-workspace.toml` and materialized into `release.yml` with `dist generate` (no manual release.yml edits). Downloads both musl tarballs, builds + verifies the .debs (`dpkg-deb --info/--contents/--field` assertions), uploads via `gh release upload`. Dry-runnable via `workflow_dispatch` (existing tag + `upload=false` attaches workflow artifacts instead of touching the release).
- **`ci.yml`** — new `deb-packaging` job: asserts unit content line-by-line and builds a stub .deb through `scripts/build-deb.sh` on every PR.
- **README** — Debian/Ubuntu install section.

Non-goals (per task): apt repo hosting, system-level (root) unit, rpm.

## Verification

- `dist generate` regenerated `release.yml`; diff is exactly the new `custom-build-deb` post-announce job.
- Smoke test against the real v0.1.1 release tarballs in a `debian:bookworm` container (both arches built; arm64 installed natively):

```
dpkg-deb: building package 'intentd' in 'intentd_0.1.1_amd64.deb'.
dpkg-deb: building package 'intentd' in 'intentd_0.1.1_arm64.deb'.
...
Setting up intentd (0.1.1) ...
intentd installed. To start it now and at every login, run as your user:
    systemctl --user enable --now intentd
$ test -f /usr/lib/systemd/user/intentd.service && /usr/bin/intentd --version
intentd 0.1.1
```

- Control fields verified: `Package: intentd`, `Version: 0.1.1`, `Architecture: amd64/arm64`, `Homepage`, `Description`.

## Notes for reviewers

- The release-side path (download → build → upload) only fully exercises on the next tagged release; it can be dry-run first via the `workflow_dispatch` mode against `v0.1.1`.
- Coordinated with the parallel `service` subcommand removal PR: both touch the README — whichever lands second rebases (section-scoped edits, no expected conflict beyond adjacency).
