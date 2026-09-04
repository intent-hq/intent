# Release Process

This document describes the end-to-end release process for Intent (cloudlands-fe).

## Overview

Releases are built and published by the **Release Alpha** workflow in GitHub Actions. The `intentd` sidecar is **not built from source** — it is downloaded from the pinned `intent-hq/intentd` GitHub Release recorded in the `intentd.version` file (intentd releases on its own cycle). The workflow:

1. Reads the pinned intentd version from `intentd.version` and fetches the matching release asset via `scripts/fetch-sidecar.cjs` (sha256-verified, staged at `resources/sidecar/intentd`); it fails fast if the pinned release or its assets don't exist
2. Builds the app for all four platforms in parallel jobs — macOS (arm64), Windows (x64), Linux (x64), Linux (arm64) — each with its staged `intentd` sidecar
3. Signs and notarizes the macOS app using Apple Developer ID certificates (Windows and Linux artifacts are unsigned)
4. Generates release notes from the `cloudlands-fe` commit range; the intentd section lists the intentd commit delta between the previous release's pin (recovered from the previous release's `release-manifest.json` asset) and the current pin — falling back to a pin-only link when the previous pin can't be recovered, or to the pin line + compare link without a commit list when the intentd compare API is unavailable
5. Publishes artifacts to `intent-hq/cloudlands-releases` on GitHub, including:
   - macOS DMG installer + ZIP archive (+ blockmaps), Windows NSIS + portable `.exe` (+ blockmap), Linux AppImage/`.deb`
   - Four auto-updater feed files: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`
   - `release-manifest.json` — metadata capturing the fe tag/SHA and the pinned `intentdVersion`

The workflow is triggered by a `v*.*.*` tag push (created by release-please when its Release PR is merged) — it does not bump versions, create tags, or open version-bump PRs itself.

No tags are pushed to `intent-hq/intentd`. To ship a newer intentd, update the `intentd.version` pin on `main` via a normal PR before cutting the release.

## Prerequisites

### Required Secrets

The following secrets must be configured in the `intent-hq/cloudlands-fe` repository settings. For the canonical secret inventory and setup details, see [DEPLOYING.md § Required GitHub Secrets](./DEPLOYING.md#required-github-secrets). Quick reference:

- **`CLOUDLANDS_MACOS_CERTIFICATE`** - Base64-encoded .p12 Developer ID Application certificate
- **`CLOUDLANDS_MACOS_CERTIFICATE_PWD`** - Password for the .p12 certificate
- **`CLOUDLANDS_KEYCHAIN_PASSWORD`** - Temporary keychain password for the build runner
- **`CLOUDLANDS_APPLE_ID`** - Apple ID email for notarization
- **`CLOUDLANDS_APPLE_APP_SPECIFIC_PASSWORD`** - App-specific password for notarization
- **`CLOUDLANDS_APPLE_TEAM_ID`** - Apple Developer Team ID (e.g., `6947A73B2N`)
- **`RELEASE_PAT`** - Personal Access Token (classic or fine-grained) with:
  - Classic: `repo` scope on `intent-hq/cloudlands-fe` and `intent-hq/cloudlands-releases`
  - Fine-grained: `Contents: Read and write`, with repository access to `cloudlands-fe` (tag checkout) and `cloudlands-releases` (publishing)
- **`INTENTD_READ_PAT`** - Personal Access Token used by `scripts/fetch-sidecar.cjs` to download the pinned intentd release assets while the repo is private:
  - Fine-grained (preferred): `Contents: Read-only` with repository access to `intent-hq/intentd`
  - Classic: `repo` scope (classic scopes are write-capable; only read access is exercised — prefer fine-grained)

**Important:** If `INTENTD_READ_PAT` is invalid or expired, the workflow fails at the "Fetch pinned intentd sidecar" step — either with "Release v{X.Y.Z} not found" (GitHub returns 404 for private repos the token cannot read) or with "GitHub API error fetching release … HTTP 401/403" for bad credentials.

## Cutting a Beta Release

1. **Merge the release-please Release PR**

   The **Release Alpha** workflow triggers automatically when a `v*.*.*` tag is pushed. Tags are created by release-please when its Release PR (which bumps `package.json` and updates the changelog) is merged — releasing is a matter of merging that PR, not typing a version.

   The workflow validates the tag format, verifies the tag matches the `package.json` version at the tagged commit, and fails if a `v{version}` release already exists on `intent-hq/cloudlands-releases`.

   To rebuild an **existing** tag (e.g., after a transient build failure), use the `workflow_dispatch` fallback: go to [Actions > Release Alpha](https://github.com/intent-hq/cloudlands-fe/actions/workflows/release-alpha.yml), click "Run workflow", and enter the existing tag (e.g., `v2.1.0`). Note the duplicate-release guard: delete the failed `v{version}` release on `cloudlands-releases` first if it was partially published.

   The bundled intentd version comes from the `intentd.version` pin at the tagged commit — there are no intentd-related workflow inputs. Make sure the pinned release exists on `intent-hq/intentd` (with assets for the build targets) before releasing, or the workflow will fail fast at the fetch step.

2. **Wait for the build**

   The workflow takes approximately 15-20 minutes. Monitor progress at:
   ```
   https://github.com/intent-hq/cloudlands-fe/actions
   ```

3. **Verify the versioned release**

   Once the workflow completes successfully:

   ```bash
   VERSION="<version>"

   # View the release
   gh release view "v${VERSION}" --repo intent-hq/cloudlands-releases

   # Check assets (should include the macOS DMG/ZIP + blockmaps, Windows .exe installers + blockmap,
   # Linux AppImage/.deb, the four feed files — latest-mac.yml, latest.yml, latest-linux.yml,
   # latest-linux-arm64.yml — and release-manifest.json)
   gh release view "v${VERSION}" --repo intent-hq/cloudlands-releases --json assets --jq '.assets[].name'

   # Verify the version in each feed file (latest-mac.yml shown; repeat for
   # latest.yml, latest-linux.yml, latest-linux-arm64.yml)
   curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/v${VERSION}/latest-mac.yml" | grep version

   # Inspect the release manifest (captures fe tag/SHA and the pinned intentdVersion)
   curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/v${VERSION}/release-manifest.json" | jq .
   ```

4. **Verify the rolling beta channel**

   The workflow also updates the rolling `beta` release tag:

   ```bash
   # Check the beta feeds (latest-mac.yml shown; repeat for latest.yml,
   # latest-linux.yml, latest-linux-arm64.yml)
   curl -sL https://github.com/intent-hq/cloudlands-releases/releases/download/beta/latest-mac.yml | grep version
   ```

## Promoting to Stable

After verifying a beta release, promote it to the stable channel using the **Release Stable** workflow:

1. **Trigger the workflow**

   Go to [Actions > Release Stable](https://github.com/intent-hq/cloudlands-fe/actions/workflows/release-stable.yml) and click "Run workflow".

   Enter the version number to promote (e.g., `2.0.7`). The version must:
   - Exist as a published versioned release (`v{VERSION}`) on `intent-hq/cloudlands-releases`
   - Use stable semver format (`X.Y.Z` only — no prerelease or build suffixes)
   - Be greater than the current stable version (or be the first promotion)
   - Not be ahead of the current beta channel version (beta-first guard, see below)

2. **What the workflow does**

   The workflow automatically:
   - **Beta-first guard**: checks the current beta channel version (read from the `beta` release's `latest-mac.yml` feed) is >= the promoted version — the invariant is that beta can never be behind stable — and fails fast **before any asset is downloaded or uploaded** when the beta feed is missing or unparseable or the beta version is behind the promoted one. For an emergency promotion that must bypass the guard, re-run the workflow with the `skip_beta_check` input checked (default off) — the bypass is logged as a warning
   - Downloads all assets from the versioned release `v{VERSION}`
   - Uploads new assets to the rolling `stable` release tag with `--clobber` (versioned assets first, then `latest-mac.yml` last for atomic feed switch)
   - Deletes old versioned assets from the previous stable promotion (only after new assets are uploaded and live)
   - Verifies the `sha512` hash in `latest-mac.yml` matches the versioned release (with retries for CDN propagation)
   - Generates a leading summary section (`scripts/generate-stable-summary.mjs`): promoted version, previous stable, and a consolidated intentd delta spanning the previous stable's pin → the promoted version's pin (pins recovered from each release's `release-manifest.json`, commit list from the intentd compare API via `INTENTD_READ_PAT`)
   - Aggregates release notes from all versions in the range `(prevStable, VERSION]`, prefixed by the summary section
   - Updates the stable release body with the aggregated notes

   The summary section is **fail-soft**: missing manifests or pins degrade it to pin line(s), a failed compare fetch falls back to the pin line + compare link, and any summary failure just drops the section — a notes problem never blocks a promotion.

   The workflow is **idempotent** — re-running with the same version is safe and updates assets/notes to match.

3. **Verify the stable feed**

   ```bash
   VERSION="<version>"

   # Check version (latest-mac.yml shown; repeat for latest.yml,
   # latest-linux.yml, latest-linux-arm64.yml)
   curl -sL https://github.com/intent-hq/cloudlands-releases/releases/download/stable/latest-mac.yml | grep version

   # Verify the ZIP sha512 matches the versioned release
   VERSIONED_SHA=$(curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/v${VERSION}/latest-mac.yml" | awk '/^sha512:/{print $2; exit}')
   STABLE_SHA=$(curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/stable/latest-mac.yml" | awk '/^sha512:/{print $2; exit}')

   if [ "$VERSIONED_SHA" = "$STABLE_SHA" ]; then
     echo "✓ Stable feed matches versioned release"
   else
     echo "✗ Mismatch detected"
   fi

   # View aggregated release notes
   gh release view stable --repo intent-hq/cloudlands-releases
   ```

4. **Propose the website release notes PR**

   Once the stable feed is verified, update the Updates section of the website docs at `src/pages/docs.astro` in [intent-hq/intentapp.dev](https://github.com/intent-hq/intentapp.dev). The section is made of `<section id="latest-release">` (Latest Release) and `<section id="release-history">` (Release History). Work on a feature branch and open a PR for review; do not merge it (a human merges it).

   1. **Gather inputs.** You need the previous stable version, the newly promoted version, and the aggregated notes body. The notes on the rolling `stable` release of `intent-hq/cloudlands-releases` already span `(prevStable, VERSION]`, including the intentd delta:

      ```bash
      gh release view stable --repo intent-hq/cloudlands-releases --json body --jq .body
      ```

   2. **Generate the copy.** The prompt below carries no release context on its own and is not sufficient by itself: supply it together with the inputs from the previous step (the previous stable version, the promoted version, and the aggregated notes body). The copy must be grounded in those notes only; anything not in them is out of scope. Use this prompt:

      ```text
      What major updates went out from the last stable release to this current one?

      Respond with accessible, concise, and clear copy for the latest release section of the Intent Website docs.

      1. Match the writing style and formatting of the rest of the Intent docs
      2. Don't include emojis
      3. Don't ever use em-dashes
      4. Don't use staccato pairs (short clipped two-part rhythms like "Not bigger. Better." or "It's fast. It's simple.")
      5. Don't use antithesis reframe / negative parallelism ("It's not about X, it's about Y" or "This isn't a bug, it's a feature")
      6. Don't use isocolon metaphor-pairs (two parallel-structured metaphor clauses like "Data is the new oil, and attention is the new currency")

      Replace the latest release section of the Intent docs on the Website with this one.
      Move the previous Latest release notes into the archive with the release version and date as a subhead.
      ```

   3. **Apply the edit.** Replace the body of the Latest Release section with the new copy, keeping the existing HTML structure: a leading `<p><strong>vX.Y.Z.</strong> ...</p>`, `<p class="body-subheadline">` subheads, and `<ul>` lists. Move the previous Latest Release body into the Release History section, directly below its intro paragraph and above any older entries, under a subhead `<p class="body-subheadline">vA.B.C (YYYY-MM-DD)</p>`. The date is the day that version's `vA.B.C` release was published on `intent-hq/cloudlands-releases`, which is its alpha release date, since a promotion does not create a new release. This prints it as `YYYY-MM-DD` directly:

      ```bash
      gh release view vA.B.C --repo intent-hq/cloudlands-releases --json publishedAt --jq '.publishedAt[0:10]'
      ```

      Release History keeps the newest entry first.

   4. **Open the PR** with a conventional-commit title (e.g. `docs: release notes for vX.Y.Z`), request review, and leave the merge to a human.

   Keep at most one open site release-notes PR at a time, and always branch from the current `main` of `intent-hq/intentapp.dev`. Before opening a new one, check for an open release-notes PR on that repo (`gh pr list --repo intent-hq/intentapp.dev --search "release notes"`). If one exists, either update it instead of opening a second (rebase it on `main`, make the newest stable the Latest Release, and archive every intermediate stable in Release History, newest first) or close it as superseded and open a fresh PR from `main`. The site must never end up showing an older release as Latest.

   The site PR is review-only and independent of the release pipeline: a delayed or missing site PR never blocks or reverts a promotion.

## Troubleshooting

### Pinned intentd Release Fetch Fails

**Symptom:** "Fetch pinned intentd sidecar" step fails with one of:
- "Release v{X.Y.Z} not found in intent-hq/intentd" — the pinned release doesn't exist, **or** the token cannot read the private repo (GitHub returns 404 in both cases)
- "GitHub API error fetching release … HTTP 401/403" — invalid or expired credentials
- A missing-asset / missing-checksum error — the release exists but lacks the per-target binary or sha256 assets

**Fix:** For a genuinely missing release or assets, publish the pinned intentd release (with per-target binary + sha256 assets), or update the `intentd.version` pin to an existing release via a PR to main. For token issues (401/403, or 404 on a release that does exist), regenerate a fine-grained Personal Access Token with `Contents: Read-only` on `intent-hq/intentd` and update the `INTENTD_READ_PAT` secret in repository settings.

### RELEASE_PAT Permissions

**Symptom:** The "Checkout release tag" or a publish step fails with a permissions error (e.g., "Publish to GitHub Releases").

**Fix:** The `RELEASE_PAT` is missing required permissions:
- For the cloudlands-fe tag checkout: `Contents: Read` (fine-grained) or `repo` scope (classic) on `intent-hq/cloudlands-fe`
- For cloudlands-releases publishing: `Contents: Read and write` (fine-grained) or `repo` scope (classic) on `intent-hq/cloudlands-releases`

Update the token's permissions in GitHub settings.

### Build Fails During Notarization

**Symptom:** "Error: Notarization failed" in the build logs.

**Fix:** Check that `CLOUDLANDS_APPLE_ID` and `CLOUDLANDS_APPLE_APP_SPECIFIC_PASSWORD` are correct. The app-specific password must be generated in your Apple ID account settings.

### Duplicate Release

**Symptom:** "Release v<version> already exists on intent-hq/cloudlands-releases" error.

**Fix:** The tag was already built and published. To rebuild it (e.g., after a partial publish), delete the `v{version}` release on `intent-hq/cloudlands-releases` first, then re-run via the `workflow_dispatch` fallback with the existing tag.

### Release Notes Generation Fails

**Symptom:** Workflow fails with "No previous versioned release found on cloudlands-releases. Cannot generate release notes."

**Fix:** The workflow could not find a previous `vX.Y.Z` release on `intent-hq/cloudlands-releases` to use as the base of the fe commit range. Verify that previous versioned releases exist and that `RELEASE_PAT` can read `intent-hq/cloudlands-releases`.

### Stable Promotion SHA Mismatch

**Symptom:** "sha512 mismatch after N retries" error in the stable promotion workflow.

**Fix:** This typically indicates CDN propagation delay or incomplete asset upload. Wait a few minutes and re-run the workflow (it's idempotent). If the issue persists, verify the versioned release assets are intact and use the manual fallback procedure below.

## Manual Fallback — Stable Promotion

If the automated **Release Stable** workflow fails and cannot be fixed by re-running, you can promote manually:

1. **Download the versioned release assets**

   ```bash
   VERSION="<version>"
   mkdir -p /tmp/release-assets
   cd /tmp/release-assets
   gh release download "v${VERSION}" --repo intent-hq/cloudlands-releases
   ```

2. **Replace assets on the rolling stable release**

   Upload first (with `--clobber`), feed files last, so the current stable
   assets keep serving until each one is overwritten in place — never delete
   the old assets before their replacements are up.

   ```bash
   cd /tmp/release-assets

   # Upload binaries/manifests first (everything except the feed files)
   for f in *; do
     case "$f" in
       latest*.yml) ;;  # feeds go last
       *) gh release upload stable "$f" --repo intent-hq/cloudlands-releases --clobber ;;
     esac
   done

   # Upload feed files last for the atomic switch (loop tolerates
   # older releases that don't have all four platforms)
   for f in latest-mac.yml latest.yml latest-linux.yml latest-linux-arm64.yml; do
     [ -e "$f" ] && gh release upload stable "$f" --repo intent-hq/cloudlands-releases --clobber
   done

   # Finally, remove any stale assets left over from the previous stable
   # that are not part of the new release
   gh release view stable --repo intent-hq/cloudlands-releases --json assets --jq '.assets[].name' | \
     while read -r name; do
       [ -e "$name" ] || gh release delete-asset stable "$name" --repo intent-hq/cloudlands-releases --yes
     done
   ```

3. **Verify sha512 hash**

   ```bash
   VERSIONED_SHA=$(curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/v${VERSION}/latest-mac.yml" | awk '/^sha512:/{print $2; exit}')
   STABLE_SHA=$(curl -sL "https://github.com/intent-hq/cloudlands-releases/releases/download/stable/latest-mac.yml" | awk '/^sha512:/{print $2; exit}')

   if [ "$VERSIONED_SHA" = "$STABLE_SHA" ]; then
     echo "✓ Stable feed matches versioned release"
   else
     echo "✗ Mismatch detected — wait for CDN propagation or check assets"
   fi
   ```

4. **Update stable release notes manually (optional)**

   Download release notes from each version in the range and concatenate them, then:
   ```bash
   gh release edit stable --repo intent-hq/cloudlands-releases --notes-file aggregated-notes.md
   ```

After a manual promotion, step 4 of [Promoting to Stable](#promoting-to-stable) (the website release notes PR) still applies.

## Channel Switching in the App

Users can switch between beta and stable update channels in the app's Settings screen. The toggle writes to `local-prefs.json` and calls `autoUpdater.setFeedURL` to point to the appropriate rolling release tag (`beta` or `stable`).

## Release History

For the full release history and changelogs, see:

- [cloudlands-releases repository](https://github.com/intent-hq/cloudlands-releases/releases)
- the `release-manifest.json` asset on each versioned release (records the fe tag/SHA and the pinned `intentdVersion`)
- [CHANGELOG.md](../../packages/cloudlands-fe/CHANGELOG.md) (points to GitHub Releases for 2.x)
