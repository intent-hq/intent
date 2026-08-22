# Deploying Intent

Intent releases are published to GitHub Releases on the public `intent-hq/cloudlands-releases` repository. The desktop app's auto-updater (electron-updater) pulls from rolling channel tags (`beta`, `stable`) on that repo.

## Release Channels

Intent uses a channel-based update model:

- **`beta`** — Rolling release tag for beta testing; auto-updater pulls from `https://github.com/intent-hq/cloudlands-releases/releases/download/beta/`
- **`stable`** — Rolling release tag for general availability; auto-updater pulls from `https://github.com/intent-hq/cloudlands-releases/releases/download/stable/`

Each channel carries **four auto-updater feed files**, one per platform/arch:

| Feed file                | Platform      |
| ------------------------ | ------------- |
| `latest-mac.yml`         | macOS (arm64) |
| `latest.yml`             | Windows (x64) |
| `latest-linux.yml`       | Linux (x64)   |
| `latest-linux-arm64.yml` | Linux (arm64) |

electron-updater's generic provider points at the channel download URL and requests the feed file for the running platform/arch automatically.

Each release also creates an immutable versioned release (`v{version}`) for archival and rollback.

## Versioning — release-please Release PRs

Version numbers are computed from conventional commits by
[release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release-please.yml`, configured via
`release-please-config.json` + `.release-please-manifest.json`). Nobody types a
version number by hand.

**Flow:**

1. On every push to `main`, release-please opens (or updates) a **Release PR**
   that bumps `package.json` and regenerates `CHANGELOG.md` from the
   conventional commits since the last `v*` tag.
2. The Release PR is auto-merged by `auto-cut-alpha.yml` when it is green —
   that is the release timing gate. The workflow is event-chained with an
   hourly cron backstop: a sidecar pin-bump squash merge (a push to `main`
   touching `intentd.version`) chains straight into a cut run that polls
   (30s interval, up to 15 min) for release-please to refresh the Release PR
   and for CI Gate to go green, then merges — so a new intentd ships in the
   same fe alpha cycle. The hourly cron at :30 is the backstop and the normal
   path for fe-only changes (check-once-and-exit, no polling); every run type
   defers the cut while an intentd release build is in flight (a semver tag on
   `intent-hq/intentd` newer than the published alpha manifest and younger
   than 90 minutes; fails open on any lookup error). The `hold-release`
   label on the Release PR pauses the auto-cut; a human can still merge
   early.
3. On the merge, release-please creates the `v{version}` tag and a GitHub
   Release on `cloudlands-fe`. The workflow authenticates with `RELEASE_PAT`
   (not the default `GITHUB_TOKEN`) so the pushed tag triggers downstream
   workflows. release-please needs contents, pull-requests, and issues write
   access (Release-PR labels go through the issues API); the classic
   `repo`-scoped `RELEASE_PAT` covers all three.

**Version math** (the app is ≥ 1.0, so full semver rules apply):

- `fix:` / `perf:` → patch (e.g. 2.0.13 → 2.0.14)
- `feat:` → minor (e.g. 2.0.13 → 2.1.0)
- `type!:` (e.g. `feat!:`) or a `BREAKING CHANGE:` footer → major
  (e.g. 2.0.13 → 3.0.0)
- `chore:`, `docs:`, `refactor:`, `style:`, `test:`, `ci:` → no release on
  their own. These types are marked `"hidden": true` in the config's
  `changelog-sections`; release-please only opens a Release PR when the
  rendered release notes are non-empty, so hidden-only pushes neither appear
  in `CHANGELOG.md` nor trigger a release proposal.

**Conventions:**

- **Breaking changes** must be marked with `!` after the type/scope
  (`feat!: drop legacy settings migration`) or a `BREAKING CHANGE:` footer, or
  the major bump will be missed.
- **intentd sidecar pin bumps** must use `fix(sidecar):` (e.g.
  `fix(sidecar): bump intentd pin to 0.4.2`) so a new pinned daemon triggers at
  least a patch release. A plain `chore:` pin bump would not produce a release.
- **Plain versions only** — no prerelease suffixes (`-beta.N`). Beta vs. stable
  remains a _promotion_ distinction on `cloudlands-releases`, not a version
  distinction.

**Why a GitHub Release on `cloudlands-fe` too?** Creating the tag via a GitHub
Release is how release-please operates, and the release body carries the
changelog for that version. It does not conflict with the publishing model:
`cloudlands-fe` is private, so user-facing artifacts live exclusively on the
public `intent-hq/cloudlands-releases` repo, while the `cloudlands-fe` release
is the internal changelog anchor for the tag.

**Bootstrap note (historical):** the pre-release-please tag `v2.0.13` points
at a commit that is not on `main` (the old workflow tagged its own bump commit
and merged a squashed copy of it), so release-please could not bound the
commit range from that tag alone. `release-please-config.json` temporarily
pinned `last-release-sha` to `562af4d2` (the `chore: bump version to 2.0.13`
commit on `main`) so the first Release PR only considered commits since
v2.0.13. Once the first release-please release (v2.1.0) was merged and tagged
on `main`, the pin was removed (#314) — release-please now bounds the range
from the release tags normally.

## Required GitHub Secrets

Release workflows require the following secrets configured on `intent-hq/cloudlands-fe`:

**macOS signing + notarization:**

- `CLOUDLANDS_MACOS_CERTIFICATE` — base64-encoded p12 certificate
- `CLOUDLANDS_MACOS_CERTIFICATE_PWD` — certificate password
- `CLOUDLANDS_KEYCHAIN_PASSWORD` — temporary keychain password
- `CLOUDLANDS_APPLE_ID` — Apple ID for notarization
- `CLOUDLANDS_APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
- `CLOUDLANDS_APPLE_TEAM_ID` — 10-character team ID

**Repository access:**

- `RELEASE_PAT` — Personal access token with `repo` scope on `cloudlands-fe` + `cloudlands-releases` (also used by release-please, which needs contents + pull-requests + issues write; `repo` scope covers all three)
- `INTENTD_READ_PAT` — Personal access token with read-only access to `intent-hq/intentd` (used to download the pinned intentd release assets while the repo is private)

Windows builds require no signing secrets — they ship **unsigned** (see
[Platform builds and runners](#platform-builds-and-runners)).

## Alpha Release Workflow

The alpha release workflow is defined in `.github/workflows/release-alpha.yml`.

**Trigger:** Push of a `v*.*.*` tag (created by release-please when its Release PR is merged). A `workflow_dispatch` fallback is available to (re)build an **existing** tag.

**Input (workflow_dispatch fallback only):**

- `tag` — existing tag to (re)build (e.g., `v2.1.0`)

**What it does:**

1. A resolve/validate job resolves the release tag (from the tag push, or the dispatch input), validates its format (supports prerelease suffixes like `v1.2.3-beta.1`), verifies the tag matches the `package.json` version at that commit (guards against tags not created by release-please), and fails if a `v{version}` release already exists on `intent-hq/cloudlands-releases` (duplicate-release protection)
2. **Per-platform build jobs** run in parallel (see [Platform builds and runners](#platform-builds-and-runners) for runners and artifacts). Each job checks out the release tag, sets up pnpm and Node.js 22, installs frontend dependencies, reads the pinned intentd version from `intentd.version`, fetches the pinned intentd sidecar for its platform/arch via `scripts/fetch-sidecar.cjs` (sha256-verified, staged at `resources/sidecar/`; fails fast if the pinned release or its assets don't exist on `intent-hq/intentd`), then builds and packages the app. The macOS job additionally imports the code signing certificate into a temporary keychain and signs + notarizes the app via the `scripts/notarize.js` afterSign hook (the staged sidecar is signed by the `scripts/sign-sidecar.js` afterPack hook); Windows and Linux artifacts are unsigned
3. A **publish job** runs only after **every** build job succeeds — any platform build failure fails the whole release; there is no partial publish. It generates release notes from the fe commit range (the intentd section lists the intentd commit delta from the previous release's pin, recovered from the previous release's `release-manifest.json` asset — falling back to a pin-only reference when the previous pin can't be recovered, or to the pin line + compare link without a commit list when the intentd compare API is unavailable) and publishes all platforms' artifacts to `intent-hq/cloudlands-releases`:
   - Creates immutable versioned release: `v{version}`
   - Updates rolling `beta` release tag (clobbers existing assets)
4. Posts workflow summary with download URLs

The workflow no longer bumps `package.json`, creates tags, or opens version-bump PRs — release-please owns versioning and tagging (no tags are pushed to `intent-hq/intentd` — it releases on its own cycle).

**Output:**

- Versioned release on `cloudlands-releases`: `https://github.com/intent-hq/cloudlands-releases/releases/tag/v{version}`
- Rolling beta channel: `https://github.com/intent-hq/cloudlands-releases/releases/tag/beta`
- Auto-updater feeds: `https://github.com/intent-hq/cloudlands-releases/releases/download/beta/` (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`)

## Promote-to-Stable Workflow

**Workflow:** `.github/workflows/release-stable.yml` (manual `workflow_dispatch` with a `version` input; the optional `skip_beta_check` boolean input, default `false`, bypasses the beta-first guard below)

The promote-to-stable workflow:

1. Validates the version and verifies the versioned release exists on `intent-hq/cloudlands-releases`
2. **Beta-first guard**: checks the current beta channel version (read from the `beta` release's `latest-mac.yml` feed) is >= the promoted version — the invariant is that beta can never be behind stable (this does not prove the promoted version itself was ever on beta; e.g. beta 2.0.2 still permits promoting stable 2.0.1). Fails fast before any channel asset is downloaded or uploaded when the beta feed is missing or unparseable or the beta version is behind the promoted one. Dispatching with `skip_beta_check: true` bypasses the guard for emergency promotions, logged as a warning
3. Reads the previous stable version from the stable channel's `latest-mac.yml` (tolerates a first promotion)
4. Copies all artifacts from the versioned release to the `stable` rolling release tag — all feed files (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`) are uploaded **last** for an atomic feed switch — then deletes superseded assets and verifies each promoted feed's `sha512`. Promoting an older mac-only release still works: missing platform feeds produce warnings, not failures
5. Builds aggregated release notes for the range `(prevStable, VERSION]`: a leading summary section (promoted version, previous stable, and a consolidated intentd pin delta recovered from the releases' `release-manifest.json` files and rendered from the intentd compare API via `scripts/generate-stable-summary.mjs`), followed by each version's release body
6. Updates the `stable` release body with the aggregated notes

The summary/notes enrichment is fail-soft — missing manifests, pins, or compare-API failures degrade the summary (down to omitting it entirely) without failing the promotion.

See [RELEASING.md](./RELEASING.md#promoting-to-stable) for the operator runbook.

## Rollback Workflow

_(Not yet implemented — planned as a separate workflow)_

The rollback workflow will restore a previous versioned release to a channel's rolling tag.

## Platform Builds and Runners

Each release ships four platform builds, produced by parallel jobs in `release-alpha.yml`:

| Platform      | Runner                                                         | Artifacts                                           | Feed file                |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------- | ------------------------ |
| macOS (arm64) | `macos-15-xlarge` (GitHub-hosted)                              | `.dmg`, `.zip` (+ blockmaps)                        | `latest-mac.yml`         |
| Windows (x64) | `gh-windows-16x` (org-hosted, Windows Server 2022 image)       | NSIS installer `.exe`, portable `.exe` (+ blockmap) | `latest.yml`             |
| Linux (x64)   | self-hosted `tinybox` (`[self-hosted, Linux, X64, tinybox]`)   | AppImage, `.deb`                                    | `latest-linux.yml`       |
| Linux (arm64) | self-hosted `comfy` (`[self-hosted, Linux, ARM64, comfy]`)     | AppImage only (`deb:arm64` temporarily disabled)    | `latest-linux-arm64.yml` |

Notes:

- **Self-hosted runner dependency**: both Linux jobs require their self-hosted runners (`tinybox` for x64 — monorepo#1340, `comfy` for arm64) to be online; a release run queues (and eventually fails) if one is unavailable. macOS uses a GitHub-hosted runner and Windows an org-hosted runner.
- **Linux arm64 temporarily ships AppImage-only**: electron-builder's bundled fpm fails to spawn on the arm64 runner, so `deb:arm64` is disabled until the runner issue is resolved (monorepo#1286).
- **Windows builds are unsigned** (first iteration). The `scripts/windows-sign.cjs` sign hook silently skips signing when `INTENT_WINDOWS_ENABLE_INTEGRATED_SIGNING` is unset; DigiCert integrated signing in releases is a follow-up. Expect SmartScreen warnings on install.
- **Linux packages are unsigned** (standard for AppImage/deb distributed outside a package repository). Snap is not built or published.
- macOS remains signed + notarized as before.

## Manual Local Build (Development / Testing)

To build the app locally for manual testing with the pinned intentd release:

```bash
# Fetch the pinned intentd sidecar (see intentd.version); set INTENTD_READ_PAT
# (or GH_TOKEN/GITHUB_TOKEN) while the intentd repo is private
node scripts/fetch-sidecar.cjs

# Build the frontend and package (point INTENTD_BIN at the staged sidecar)
pnpm run build
INTENTD_BIN="$(pwd)/resources/sidecar/intentd" pnpm run dist:mac
```

On Windows or Linux, use `pnpm run dist:win` or `pnpm run dist:linux` instead
(the staged sidecar binary is `intentd.exe` on Windows).

To build against a locally built intentd instead, point `INTENTD_BIN` at your
`cargo build --release` output (or omit it in the monorepo, where
`scripts/copy-sidecar.cjs` defaults to `packages/intentd/target/release`).

The packaged artifacts (`.dmg`/`.zip`, `.exe`, AppImage/`.deb`) will be in `dist-electron/`.

**Note:** Local builds will not be signed or notarized unless you configure the signing environment variables locally (`CLOUDLANDS_APPLE_ID`, `CLOUDLANDS_APPLE_APP_SPECIFIC_PASSWORD`, `CLOUDLANDS_APPLE_TEAM_ID`, or legacy `APPLE_*` equivalents).

## Operational Notes

- All release workflows run on GitHub Actions; there are no manual upload scripts
- Secrets are configured at the repository level and referenced in workflow YAML
- Release artifacts are public on `intent-hq/cloudlands-releases`
- The auto-updater uses the rolling channel tags (`beta`, `stable`) to find updates
- Versioned releases (`v{version}`) provide immutable archives for rollback
- Keep PATs and certificate passwords out of logs and transcripts
