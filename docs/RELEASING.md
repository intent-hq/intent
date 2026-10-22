# Release Engineering

Deep-detail reference for the Intent release pipeline: workflows, secrets, dispatch
types, fail-soft semantics, and guardrails. For the agent-facing rules (what you must
and must not do around releases), see the root [AGENTS.md](../AGENTS.md) → Release
Process.

Releases are per-component and channel-based: merging a release PR publishes to the
rolling **alpha** channel; **beta** and **stable** are promotions of existing releases (no new build),
each triggered by a manual workflow dispatch (`promote-beta.yml` /
`promote-stable.yml` on intentd, `promote-beta.yml` / `release-stable.yml` on
cloudlands-fe).

## Where to look

| Question | Run |
|---|---|
| Where is the release train? Latest tags and ages, alpha/beta/stable versions, the fe daemon pin, open Release and pin-bump PRs with CI Gate state and merge queue position, what the merge queue head is waiting on, unshipped commits, the last auto-cut decision line, the last auto-pin-intentd run and its failure reason, runner maintenance overrides | `make release-status` (`STATUS_JSON=1` for JSON; `NO_LOGS=1` skips the run-log fetch) |
| Which alpha carries my commit? | `make shipped-in COMPONENT=<intentd\|cloudlands-fe> SHA=<sha>` (hooks call `scripts/shipped-in.sh` for its exit codes) |

## Guarded direct release merges

Both components' `auto-cut-alpha.yml` workflows can squash-merge a verified
release metadata PR directly, avoiding a second CI run in the merge queue.
cloudlands-fe's `auto-pin-intentd.yml` merges a verified sidecar pin PR directly
the same way ([Direct sidecar pin merges](#direct-sidecar-pin-merges)). Ordinary
PRs and monorepo submodule bump PRs continue through the queue. A release or pin
PR whose diff does not match its verified shape uses the ordinary guarded queue
path too.

Direct merging requires the existing release guards to pass: the expected
same-repository release branch and author, no draft or `hold-release`, acceptable
mergeability and freshness, a successful `CI Gate` on the assessed head, and no
blocking human review threads. Existing throttle, dry-run, frontend daemon
freshness and in-flight sidecar checks still apply, including their documented
manual-dispatch overrides. Release automation does not refresh the PR branch;
release-plz or release-please owns that content.

The workflow uses the classifier from its trusted workflow revision, never a
script from the PR head, to inspect the diff. Scheduled and main-push runs use
`main`; manual dispatch uses the selected workflow ref. Only release metadata qualifies:
intentd permits independent crate version changes, matching local dependency
requirements and workspace-package lockfile versions, plus harmless TOML
formatting/comments; cloudlands-fe permits the package version and matching
release-please manifest update. Source, workflow, external dependency and sidecar
pin changes do not qualify for this release route. A classification failure cannot
enable direct merging.
The merge uses `--squash --admin --match-head-commit <assessed-head-sha>`; the
head match prevents a refreshed, unchecked PR head from being merged using the
earlier decision. Queue submission is not evidence of a completed merge or a
published alpha; confirm the PR's merged state and the release artifacts.

In intentd, every auto-cut run (cron, manual dispatch and push) also reads
main's live tip right before merging. It requires the release PR head to contain
that tip, for both the direct merge and the queue path, and the classifier diffs
against that tip. GitHub's `baseRefOid` and `mergeStateStatus` are only the PR's
last-synced view of main, and `--admin` bypasses the ruleset's strict
up-to-date rule. Cron run 39234998462 saw a stale base (b4349bb0) while main was
at 2d7c7bb0, and cut v0.11.10 (intentd#2506) one commit behind main. A change
landing in that window ships without its changelog entry or version bump. A head
that is behind, or a tip or comparison that cannot be read, never merges: push
runs retry within their polling budget. Cron and dispatch runs skip, because the
push run for the newer main commit is queued behind them and handles the wait.
release-plz rebuilds the PR on current main after every successful run, so a PR
that is behind catches up on the next refresh. In v0.11.10 that refresh never
happened because the release-plz run for 2d7c7bb0 failed on a network error.
After a failed refresh the cut now waits for the next push to main.
One race remains: main can move in the seconds between this check and the
merge, because `--match-head-commit` pins only the head.

In intentd, the release PR's own CI is shortened the same way. When the PR's
`release-fast-path` job reports a metadata-only diff, `check` and
`coverage-changed` are skipped on that PR. CI Gate accepts the skip only when
that job succeeded. Main's tip already passed both jobs in the merge queue, and
every other PR and every merge-queue run still runs them. The classifier runs
only on `release-plz-*` branches, and its own failure falls back to full CI. It
also rejects a version bump whose `Cargo.lock` does not carry the new version.
Without this, each release-plz refresh needed about 8 minutes plus 14 minutes of
CI. Main merged about every 15 minutes, so the v0.11.9 release PR (intentd#2493,
2026-10-19) went through 13 CI runs over 4 hours and was never green on current
main. Auto-cut also waits out two transient states on every run, cron included:
it re-reads `mergeable=UNKNOWN` every 30 seconds for up to 2 minutes per
episode. It also treats a missing CI Gate as running CI, with the full
`AUTO_CUT_CI_WAIT_MINUTES` budget, while other CI jobs on the head are still
queued or in progress and none has failed. CI Gate only reports after every
other CI job finishes.

### Direct sidecar pin merges

The cloudlands-fe merge queue builds one entry at a time, and an ordinary entry
takes about 45 minutes. On 2026-10-19 pin PR cloudlands-fe#3535 waited more than
3 hours behind other entries, and auto-cut deferred the alpha the whole time.
A plain pin bump already takes the CI fast path, so the queue only added wait.
`auto-pin-intentd.yml` therefore waits up to 10 minutes for `CI Gate` on the head
it pushed. `scripts/auto-pin-merge-route.mjs`, run from the workflow's trusted
checkout of main, then allows a direct merge only when all of these hold:

- `CI Gate` succeeded on that exact head, with no change request and no
  unresolved review thread (`--admin` would otherwise skip them).
- The PR's own diff matches `release-pr-fast-path.mjs --pin-only`: only
  `intentd.version` and the regenerated `source-pin` line, with regular file modes.
  A `CURRENT_PROTOCOL_VERSION` change is a protocol bump, so it takes the queue.
- Main has not changed either pin file since the PR's base. Main may otherwise
  have moved: the cloudlands-fe ruleset does not require up-to-date branches, and
  a queued pin takes the same CI fast path, so the queue would not retest it.

The merge uses `--squash --admin --match-head-commit <tested-head-sha>`. Any failed,
timed-out or unreadable guard arms auto-merge through the queue instead. A rolling
PR already in the queue locks its branch, so the run skips with a notice; the next
run after it lands advances the pin. A direct merge moves main under the queue, so
GitHub rebuilds the entry being tested at that moment, as release direct merges do.

The direct path uses the existing `intent-hq-ci` account exemption: User
`335379076`, mode `always`, on the repository **Default** ruleset in intentd and
cloudlands-fe only. The committed allowlists are
`.github/rulesets/intentd.bypass.json` and
`.github/rulesets/cloudlands-fe.bypass.json`. The organization **Default Branch**
ruleset has no exemption and continues enforcing its PR and thread-resolution
requirements; the monorepo intent ruleset has no exemption either. The live
repository exemption applies to the account, while the workflow's metadata
check limits when release automation exercises it. Main-branch rules and other
actors are unchanged.

The merge credentials must authenticate as that CI account: `RELEASE_PLZ_TOKEN`
for intentd and `RELEASE_PAT` for cloudlands-fe. Their identity is also checked
against the release PR author. Read-only CI and PR queries use the workflow's
`GITHUB_TOKEN`; the merge uses the PAT so its push triggers the downstream
release workflows. Rotating either PAT must preserve the intended identity and
repository permissions; a token with a similar name does not inherit the user's
exemption. `RULESET_ADMIN_TOKEN` is a separate administration-read credential
for drift inspection, not a release-merge credential. To record an intentional
ruleset change, run `make check-rulesets UPDATE=1` with that credential and review
the generated diff; this reads live rules and writes local snapshots only.

## Intel Mac release policy — pending rollout

The approved policy builds Intel Mac binaries only for actual tagged daemon,
sitter and desktop releases (including reruns of those releases). Intel is
optional: failed or incomplete Intel outputs are omitted without user-facing
failure notices or dangling downloads, checksums or feed entries. Apple Silicon,
Linux and Windows remain required. An optional job that is still queued can
still delay publication; this policy does not cancel jobs or change runner limits.

**Rollout status:** this monorepo change prepares cleanup and documents the
companion implementation; it does not enable optional Intel in published builds.
The existing desktop workflow requires both Mac architectures and uses one shared
Mac feed. Until both component changes ship, use the existing release procedures
below. The following behavior applies only after the coordinated rollout:

- Daemon cargo-dist planning removes Intel from PR, branch, merge-queue, cache,
  schedule and manual-test plans, including generated cross-compilation matrices.
  Tagged daemon and sitter releases may build Intel. Channel manifests and mirrors
  include only validated archives with matching checksums; an installed Intel
  daemon stays on its current version if its exact target is absent. Sitter
  `sitter-latest` and Homebrew may retain a verified older Intel archive/checksum
  pair with its actual version, never relabel it as the new release. With no valid
  prior pair, Intel is absent.
- Desktop release planning admits Intel only when the exact pinned intentd release
  contains its archive and checksum. Each included Mac build still signs,
  notarizes and validates normally; incomplete Intel output is omitted as a unit.
  Manual PR/test builds use Apple Silicon (`macos_arch=arm64`); `x64`, `both` and
  universal manual selections are rejected. Linux/Windows x64 are unaffected.
- New native ARM clients read `latest-arm64-mac.yml`. The legacy `latest-mac.yml`
  advances on a complete dual-CPU release; otherwise it retains that destination
  channel's own last compatible dual-CPU release using immutable versioned URLs.
  Alpha, beta and stable each keep their own history. Promotions advance the ARM
  feed to the selected release without borrowing alpha's legacy feed. Existing
  shared-feed ARM clients wait for a successful dual release carrying the routing
  change or install an ARM build manually; optional Intel does not wait for a
  prerequisite migration release.
- Only confirmed lack of compatible channel history permits the exact legacy
  sentinel mapping `version: 0.0.0` and `files: []`, with no other keys. It offers
  no update with downgrades disabled. Already-deployed clients can display `0.0.0`
  in a manual-check toast in that case; new clients display their installed
  version. Unreadable or malformed history stops publication. Never advertise a
  missing Intel asset as a new-version download.

**Required order:** land this cleanup compatibility change with human approval
first. Then both component owners update their `.github/workflows/cleanup-prereleases.yml`
cleanup-source pins (and intentd's exact-pin test) to the actual merged monorepo
SHA before the new feeds publish. These are script-source pins, not submodule
gitlinks; do not guess a future SHA or bypass consumer checks. Review and release
the companion intentd and cloudlands-fe changes together. The companion bundled
assistant guide section is **Mac update availability**. Record component PR links
and carrying versions at rollout; none are established by this documentation.

Enforcement lives with the implementations: intentd's
`scripts/test-optional-intel-release.py` exercises event gating, cross-target
matrix filtering and workflow restrictions; `scripts/test-optional-intel-dist.py`
tests real cargo-dist output. Desktop's `scripts/mac-release-workflows.test.ts`
executes dynamic release/manual selectors and rejects non-release Intel inputs.
Run these component gates with their companion changes; the monorepo's older
component pins do not yet contain the new policy. Cleanup's offline regression
suite is `python3 -S -B -m unittest -v scripts.test_cleanup_prereleases`.

## intentd

- release-plz maintains a release PR on `main`. Merging it cuts the `vX.Y.Z` tag,
  cargo-dist builds the artifacts, and the alpha channel manifest (`alpha.json` on the
  `channel-alpha` release) publishes automatically. Right after the alpha manifest
  publishes (source + mirror), `publish-channel-manifest.yml` sends a
  `repository_dispatch` of type `intentd-alpha-published` (`client_payload.version` =
  the released version, no leading v) to `intent-hq/cloudlands-fe`, which kicks off
  the event-chained fe pin bump + cut (see cloudlands-fe below). The dispatch
  authenticates with the `FE_DISPATCH_TOKEN` secret (fine-grained PAT with
  contents:write on `intent-hq/cloudlands-fe`) and is fail-soft: a missing secret or
  failed dispatch logs a warning and never fails the publish — the fe crons then act
  as the backstop.
- Windows lint runs in the merge queue; the rest of Windows validation is post-merge
  only. intentd PRs never use a Windows runner. Each merge-queue run has a required
  `windows-lint` job (native Windows `cargo check` and target-gated Clippy), so a
  Windows-only compile or lint error is ejected from the queue instead of landing.
  Every push to `main` runs the Windows runtime and lifecycle proofs, release build,
  `install-ps1` and Windows Pi legs, and that push run's CI Gate requires them. A
  Windows-only runtime regression therefore lands on `main` and holds releases instead
  of merges. Before merging the Release PR,
  `auto-cut-alpha.yml` reads the latest push-event `ci.yml` run on `main`'s live tip,
  which the Release PR head must contain (see
  [Guarded direct release merges](#guarded-direct-release-merges)). A green run proceeds. A queued or running
  one waits within the CI budget, then the hourly cron retries. Any other conclusion
  (failed, cancelled, timed out) skips the cut. To unblock, re-run the
  failed jobs on that `main` run or land a fix; the next attempt cuts. A human
  merging the Release PR by hand bypasses this gate on purpose.
- Stable is promotion-only and beta-first: dispatch `promote-stable.yml` with the
  `version` input, then verify `stable.json` on the `channel-stable` release. A guard
  checks the current beta channel version (`beta.json` on the fixed `channel-beta`
  release) is >= the promoted version — the invariant is that the beta channel can
  never be behind stable — and fails fast before any channel asset is touched when
  `beta.json` is missing/unparseable or the beta version is behind the promoted one.
  (Note this enforces the beta-not-behind invariant, not that the promoted version
  itself ever occupied beta — e.g. beta 2.0.2 still permits promoting stable 2.0.1.)
  The optional `skip_beta_check` boolean dispatch input (default `false`) bypasses
  the guard as an emergency escape hatch, logged as a warning.
- Daemon archives and channel manifests are **mirrored** to the public
  [intent-hq/intentd-releases](https://github.com/intent-hq/intentd-releases) repo
  (`INTENTD_RELEASES_TOKEN` secret; mirror steps are skipped with a warning if it is
  absent). Manifests are dual-published — the mirror's copy points at the mirrored
  assets, the intentd repo's copy is unchanged — and the sitter fetches the mirror
  first with a coded fallback to intentd. Daemon release notes are mirrored too
  (source changelog with download URLs rewritten to the mirror; sitter releases
  keep their purpose-written notes). `mirror-release.yml` (manual dispatch)
  backfills older releases. The `-releases` repos ([intent-hq/intentd-releases](https://github.com/intent-hq/intentd-releases)
  and [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases))
  are the **permanent** public distribution channels — manifests, download URLs, and
  the Homebrew formula keep pointing at them even after the source repos go public.
  Sitter installers (Homebrew, `.deb`, `sitter-latest`) are also mirrored to
  intentd-releases by `release-sitter.yml`, and the published install URLs (Homebrew
  formula, README curl commands) point at the mirror.

### When a published daemon reaches running installs

A sitter-supervised daemon (`intentd serve`) picks up a channel publish on a
schedule that depends on its channel. The sitter re-reads the channel at every tick
and idle request, so `intentd sitter channel` switches the schedule on a running
service.

**Stable — at most one automatic check per UTC day.** The sitter records the UTC
date of its last *successful* automatic check (`last_check_at` in `state.json`) and
makes a network check only when none is recorded for today:

- **Startup** checks only when due; when it has already checked today, the
  installed version starts with no request.
- **While running**, a local tick every 50–70 min makes the check once the UTC day
  rolls over, so rollover checks spread over the first hour after midnight UTC. A
  failed check (offline, every source down) is not recorded, so the next tick
  retries.
- A newer version is **staged** and handed to the daemon through the idle-restart
  handshake: once no agent has had a turn in flight for `updates.idleGraceSeconds`
  (default 120 s), the daemon signals the sitter (`SIGUSR2`, at most every
  `updates.idleCheckIntervalMinutes`, default 60) and restarts into the staged
  version the next moment no turn is in flight. That idle request makes no
  network check unless one is due. If the staged version is still not running,
  the first tick after it has waited 24 h forces a graceful restart.

A new stable release therefore reaches a running install in two separate steps.
**Discovery** can take up to about a day: an install that checked just before a
publish does not look again until the next UTC day, and the 50–70 min tick jitter
adds up to about an hour after the rollover. **Activation** of the staged version
then happens at the next idle moment, so an idle install switches within about an
hour; a continuously busy daemon waits for the forced restart on the first tick
after the staged version has waited 24 h (up to roughly another hour). In the worst case a busy install runs the new stable release about two
days after it is published.

**Alpha and beta — unchanged.**

- **Opportunistic, idle-triggered** — once no agent has had a turn in flight for
  `updates.idleGraceSeconds` (default 120 s), the daemon asks its sitter to check
  now (`SIGUSR2`), at most every `updates.idleCheckIntervalMinutes` (default 60).
  The sitter stages any newer version and the daemon restarts into it the next
  moment no turn is in flight, so an idle install updates within about an hour of
  the publish without interrupting a running agent.
- **Forced, periodic** — the sitter's randomized 12–24 h check: it installs a newer
  version (or one already staged) and restarts the daemon whether or not a turn is
  in flight. This is the fallback for continuously busy installs and the only path
  when `checkOnIdle` is off.

On every channel, `updates.checkOnIdle=false` (live setting, no restart; see
[protocol/methods/settings.md](./protocol/methods/settings.md)) stops the daemon's
idle requests. `intentd update` (`system.requestUpdate`, "Update now") always checks
and restarts immediately, and a manual check never counts as the day's check.
Failed-start re-checks still run on every channel.

The desktop app follows the same rule for its own updates: on **stable** it checks
at startup (10 s after launch) only if no check has succeeded that UTC day, and
its hourly tick and focus/resume checks run only once the day has rolled over.
Alpha and beta keep the startup check, the hourly check, and focus/resume checks
after 4 h. "Check for updates" and channel switches always check immediately. A
failed stable check is not recorded, so the app tries again, but automatic retries
are throttled: startup, the hourly tick and focus/resume share one limit of one
failed automatic attempt per hour, so the next focus after a failure does not
necessarily retry at once. Manual checks and channel switches bypass this limit.

### Update-check statistics (`updates.intentapp.dev`)

Both the sitter and the desktop app fetch their update feeds through
`https://updates.intentapp.dev`, a separate Vercel project
([intent-hq/intent-updates](https://github.com/intent-hq/intent-updates)). It
counts the request and answers with a `302` to the same GitHub asset as before; it
never serves a manifest or a feed itself, so GitHub stays the only source of
updates.

| | Sitter (standalone intentd) | Desktop app |
|---|---|---|
| Request | `/channel/<ch>.json` → `github.com/intent-hq/intentd-releases/releases/download/channel-<ch>/<ch>.json` | `/desktop/<ch>/<feed>.yml` and the installers it lists → `github.com/intent-hq/cloudlands-releases/releases/download/<ch>/<file>` |
| `p` platform | target triple | `<platform>-<arch>` |
| `v` version | sitter version | app version |
| `src` install source | `brew`, `deb`, `script`, `windows`, `unknown` | `dmg`, `nsis`, `appimage`, `deb`, `unknown` |
| `k` trigger | `startup`, `daily`, `idle`, `manual` | `startup`, `daily`, `periodic`, `focus`, `manual`, `channel` |
| `d` daily flag | `1` while no check has *succeeded* this UTC day (from a date in `state.json`) | same (from the `lastUpdateCheckDay` local pref) |
| Opt-out | `DO_NOT_TRACK=1`, `INTENTD_DISABLE_TELEMETRY=1`, or `telemetry = false` in `<data-dir>/sitter/config.toml` (re-read on every check, kept when `intentd sitter channel` rewrites the file); `INTENTD_SITTER_MANIFEST_BASE_URL` also skips the endpoint | **Settings → General → Updates → Share anonymous update statistics** (on by default, `shareUpdateStatistics` local pref), `DO_NOT_TRACK=1`, or a custom `AUTO_UPDATE_URL` |

No IDs, hostnames, usernames or paths are sent; the sitter's User-Agent is
`intentd-sitter/<ver> (<triple>)`. The service allowlists every value (anything
else is counted as `other`), passes Vercel only `user-agent` and `x-forwarded-for`
so Vercel can derive the country, and never logs or stores the IP. With any opt-out
the request goes straight to GitHub.

**Fallback.** Any failure of the endpoint (down, 404, slow, or an unexpected
redirect) falls back to GitHub. The endpoint records its events *before* it
returns the redirect, so a check whose GitHub fetch then fails (or that the client
retries on GitHub) may already have been counted. Counting is best effort: a
request that never reached the service, an event the service failed to record, an
opted-out install and a version older than this change are not counted:

- The sitter gives the endpoint its own 10 s timeout, then tries the existing
  `intent-hq/intentd-releases` → `intent-hq/intentd` GitHub bases.
- The desktop app retries a failed or hung check once against the GitHub feed with
  no user-visible error, then stays on GitHub for the rest of the session; a failed
  download through the endpoint also moves the session to GitHub.

**Redirect and host allowlists.**

- The sitter's endpoint client accepts a first redirect only to exactly
  `https://github.com/intent-hq/{intentd-releases,intentd}/releases/download/channel-<ch>/<ch>.json`
  for the requested channel (no query, port or userinfo), then only https hops on
  `*.githubusercontent.com`, at most 5 hops. A response that never left the endpoint
  is refused, so a compromised Vercel project cannot serve a manifest.
- The desktop app's updater session (`electron-updater` partition) cancels any
  request outside `updates.intentapp.dev/desktop/`,
  `github.com/intent-hq/cloudlands-releases/releases/download/` and
  `*.githubusercontent.com` (plus a custom `AUTO_UPDATE_URL` prefix). The macOS
  code-signature and Windows publisher checks remain the main protection.
- electron-updater attaches its persistent per-installation `.updaterId` as an
  `x-user-staging-id` header to feed requests. The app strips that header
  (case-insensitively) from every request to `updates.intentapp.dev`, including
  redirect hops back to it, so the endpoint never receives an installation ID.
  Direct GitHub requests keep it, since staged rollouts are decided locally.

**Reading the data.** Open the `updates.intentapp.dev` Vercel project →
**Analytics → Events**. The Pro plan allows two properties per event:

| Event | Properties |
|---|---|
| `intentd_update_check` / `desktop_update_check` | `platform`, `context` = `<ch>/<src>/<k>` (e.g. `stable/brew/idle`) |
| `intentd_daily_active` / `desktop_daily_active` | `platform`, `version`; fired for every request with `d=1`. The day is recorded only after a successful fetch, so an install whose checks keep failing sends `d=1` (and is counted again) on each retry that day. Treat the count as an approximation of daily active installs: retries can overcount it, and missing or opted-out telemetry undercounts it |
| `desktop_update_download` | `platform`, `version`, parsed from the artifact name; `.blockmap` files and range continuations are redirected but not counted |

Country comes from Vercel's lookup of the forwarded IP. Only sitter and desktop versions
released after this change go through the endpoint, and the desktop app's bundled
daemon does not use the sitter, so the two sources never count the same install
twice.

### Cutting a sitter release

The sitter (`crates/intentd-sitter`, installed as `intentd`) is `dist = false`: the
daemon's cargo-dist pipeline (`release.yml`) never builds it and release-plz never tags
it. It ships through its own hand-written pipeline,
[`release-sitter.yml`](../packages/intentd/.github/workflows/release-sitter.yml),
triggered by pushing a `sitter-vX.Y.Z` tag.

- **Versioning** — the sitter keeps an independent `0.1.x` line. release-plz advances
  `crates/intentd-sitter/Cargo.toml` in the ordinary intentd Release PR whenever files
  under `crates/intentd-sitter` changed since the last daemon tag (see the
  `intentd-sitter` entry in [`release-plz.toml`](../packages/intentd/release-plz.toml)),
  so no manual bump is needed for crate changes. The repo-root `scripts/install.sh` /
  `scripts/install.ps1` (republished on `sitter-latest`) are outside the crate and NOT
  detected: an installer-script-only change needs a manual
  `chore(sitter): bump intentd-sitter to X.Y.Z` PR before tagging. The workflow fails
  if the tag does not match the crate version.
- **Procedure** — after the Release PR that bumped the sitter version has merged, tag
  that `main` commit `sitter-v<Cargo.toml version>` and push the tag:

  ```bash
  cd packages/intentd && git fetch origin
  git tag sitter-v<version> <main-commit> && git push origin sitter-v<version>
  ```

- **What the run does** — builds the sitter for the same 5 targets as the daemon,
  packages archives named like daemon archives, publishes a GitHub Release on the tag
  (never marked "latest"), refreshes the fixed `sitter-latest` release (archives,
  `install.sh` / `install.ps1`), builds `.deb`s, mirrors everything to
  [intent-hq/intentd-releases](https://github.com/intent-hq/intentd-releases) (skipped
  with a warning without `INTENTD_RELEASES_TOKEN`), and pushes the Homebrew formula
  to `intent-hq/homebrew-tap` (skipped on prereleases).
- **No self-update** — running installs pick a new sitter up only by reinstalling
  (`install.sh` one-liner, `brew upgrade`, `.deb`; see the intentd README install
  section). Daemon work that needs a newer sitter — e.g. the idle-triggered handshake
  above, which requires the sitter to advertise the capability — is inert on installs
  still running an older sitter. Incident: the sitter changes merged in intentd #1920
  were assumed covered by the last sitter release (`sitter-v0.1.8`, cut before them),
  and `sitter-v0.1.14` had to be cut afterwards.
- **Is a sitter release pending?** — a non-empty
  `git log sitter-v<last>..origin/main -- crates/intentd-sitter scripts/install.sh scripts/install.ps1`
  (ignoring `chore: release` commits) means unreleased sitter work.

## cloudlands-fe

- The intentd sidecar version is pinned in `intentd.version` at the cloudlands-fe repo
  root (`packages/cloudlands-fe/` in this monorepo). The pin advances automatically
  and event-driven: `auto-pin-intentd.yml` runs on the `intentd-alpha-published`
  repository_dispatch from intentd (so the pin bumps minutes after an alpha
  publishes), with an hourly cron at :15 as the backstop when the dispatch is missed.
  Each run follows the intentd alpha channel and lands the bump via a rolling PR.
  In normal day-to-day operations everyone relies on this automated train (intentd
  alpha publish → dispatch → auto pin bump → chained fe cut; crons as backstop) and
  manual pin-bump PRs are not filed. A manual pin bump is the **emergency release**
  path, used when an intentd fix must ship immediately rather than waiting on the
  event chain / cron retries: the operator lands the fix in intentd, cuts the intentd
  release, then immediately pin-bumps `intentd.version` in cloudlands-fe via a manual
  PR (verify with `node scripts/fetch-sidecar.cjs` from that directory) and cuts the
  cloudlands-fe release.
- release-please maintains a release PR. Merging it cuts the tag and `release-alpha.yml`
  publishes to `intent-hq/cloudlands-releases`. All release assets — installers,
  update feeds, and `release-manifest.json` — live **only** on the
  [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases)
  distribution repo (same `vX.Y.Z` tag); the release on the `cloudlands-fe` source
  repo carries the changelog but **no assets**. Anything polling for release assets
  (e.g. checking `intentdVersion` in `release-manifest.json`) must query the
  distribution repo, not the source repo. (intentd differs: cargo-dist publishes
  daemon archives to the source repo's releases, and its channel manifests are
  dual-published — see the intentd section above.)
- The Release PR merge is automated by `auto-cut-alpha.yml`, which triggers
  on **any push to main**, including frontend changes and the pin-bump squash merge
  made with `RELEASE_PAT`. The cut's own `chore(release):` merge push skips the job.
  A ten-minute cron (`*/10 * * * *`) retries deferred or missed attempts. Every
  run type (push, cron, and manual dispatch) evaluates readiness once and exits
  if it is not ready, without sleeping or polling. No open Release PR means no
  cut; release-please owns the PR for unshipped releasable changes. Pushes with
  releasable changes require a refreshed Release PR head, and a push touching
  `intentd.version` requires that head to carry the pushed pin. Scheduled retries
  require the Release PR pin to match current main and its head to be at least
  as recent as the newest unshipped releasable commit. The latter check scans
  every page of the latest-release-to-main comparison, so later docs or CI
  commits do not hide a pending release-worthy change. Manual-dispatch and
  lookup-failure policies remain unchanged. A deferred run leaves the next
  attempt to a later push or cron tick. GitHub scheduling, queue
  backlog, readiness, and the subsequent alpha build and publication still
  determine when binaries ship; the ten-minute schedule is an attempt cadence.
- All automated push and cron runs defer when the latest frontend `vX.Y.Z` tag
  is less than 60 minutes old, including automated sidecar-pin updates. Pin
  advances do not bypass this hourly floor. At 60 minutes the cut is eligible
  only if the remaining readiness guards pass. Immediately before merge, the
  workflow reads the latest tag again and defers if it changed during the run.
  Existing tag/date lookup fail-open behavior remains unchanged. An explicit
  `workflow_dispatch` retains the manual throttle bypass; it does not bypass
  the Release PR readiness checks.
- All cut attempts share the `auto-cut-alpha` concurrency group with
  `cancel-in-progress: false` and `queue: max`: one runs at a time, and later
  ordinary pushes retain pending pin attempts. GitHub allows at most 100 pending
  runs and cancels additional arrivals when the queue is full; a backlog can delay
  a cut, and the ten-minute cron remains the fallback. See
  [GitHub concurrency controls](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
- Every attempt preserves the existing dependency and readiness checks:
  in-flight intentd builds, backend freshness, open pin-bump PRs, `hold-release`,
  Release PR identity and pin/head freshness, draft and mergeability checks,
  CI Gate on the current head, and unresolved review threads with human
  participation. An open pin-bump PR (branch
  `auto/intentd-pin`) defers the cut — the pin must land first so the alpha carries
  the new sidecar, and its merge push then chains into a cut. In-flight guardrail: when
  `intent-hq/intentd` has a semver tag newer than the published alpha manifest and
  the tag is younger than 90 minutes (an intentd release build is running and a pin
  bump is imminent), the cut defers instead of shipping a stale-sidecar alpha; the
  age bound stops a failed intentd build from deferring fe cuts forever, and the
  check fails open on any lookup error (missing `INTENTD_READ_PAT`, unreachable
  manifest, unreadable tags) so an unreadable intentd never blocks fe releases.
  BE-dependency freshness guardrail (intent-hq/monorepo#2985): the intentd-first
  rule orders merges, not releases, so an fe commit can merge after its intentd
  counterpart and still ship in an alpha whose pinned sidecar predates that BE
  work. Before merging, the cut resolves the pin from `intentd.version` on fe
  main and compares `v<pin>...main` on `intent-hq/intentd`: when intentd main has
  no commits after the pinned tag (the expected common case, one cheap API
  comparison) the cut proceeds unrestricted; when intentd main is ahead and the
  cut would ship fe commits merged after that tag was cut, it defers — those
  commits may depend on intentd work in no published sidecar, and the next
  intentd alpha's pin-bump push or a later cron tick re-evaluates readiness.
  A confirmed release-plz no-op also exempts this freshness deferral
  (intent-hq/intent#6045): the latest
  `release-plz.yml` main-push run must succeed for the **exact current intentd
  main SHA**, with a successful job named
  `Release-plz no release needed: <baseline-tag>@<baseline-commit-sha>` in its
  latest attempt. The producer emits that job only after the real release-pr
  action succeeds with `prs: []` and resolves the checked-out daemon package
  version to an existing ancestor release tag. The consumer requires no open
  same-repository `release-plz-*` PR and both baseline tag and commit to match
  the sidecar pin on fe main; it rechecks run, PR, tag, pin, and main identities
  before accepting proof. An absent or manually closed PR alone is insufficient.
  Pending, failed, skipped, stale, malformed, or unreadable proof retains the
  existing deferral, as do newer releases not yet pinned and release merges
  awaiting their tag. This exemption does not bypass in-flight builds, pin-bump
  PRs, holds, CI, review, or throttle guards. `workflow_dispatch` retains its
  explicit freshness override. Automation commits (the sidecar pin-bump itself,
  `chore(release):` merges) remain exempt, and the original pin, tag, comparison,
  and frontend-commit lookups still fail open — only reads of the new no-op
  proof fail closed for the exemption. Public intentd workflow and job reads
  use the existing token permissions; no new secret is needed.
- Stable: dispatch `release-stable.yml` with the `version` input. The same beta-first
  guard applies: the workflow checks the current beta channel version (the `beta`
  release's `latest-mac.yml` feed on `intent-hq/cloudlands-releases`) is >= the
  promoted version — beta can never be behind stable — and fails fast before any
  channel asset is downloaded or uploaded: a missing/unparseable beta feed or a beta
  version behind the promoted one aborts while the live stable channel is still
  untouched (same caveat as intentd: the guard enforces the beta-not-behind
  invariant, not that the promoted version itself ever occupied beta). The optional
  `skip_beta_check` boolean dispatch input (default `false`) bypasses the guard for
  emergencies, logged as a warning. After the stable feed is verified, propose the
  website release notes PR on `intent-hq/intentapp.dev` for human review (see
  [fe/RELEASING.md § Promoting to Stable](./fe/RELEASING.md#promoting-to-stable)).

## Release notifier

- Both component repos run `scripts/notify-fixed-issues.sh` from their release (tag
  build) workflows only — promotion workflows post nothing. Each release scans for
  `intent-hq/intent#N` / full issue URL references (commit messages plus
  squash-merged PR bodies, resolved via the `(#N)` subject suffix): intentd scans its
  released tag range; cloudlands-fe scans its own range plus the bundled intentd
  delta `v{prev pin}..v{new pin}`, so an fe release that merely bumps the sidecar
  still comments on intentd-fixed issues.
- Comments never name a channel and there are no beta/stable promotion comments.
  intentd posts "This fix is included in intentd vX.Y.Z."; cloudlands-fe posts
  "This fix is included in cloudlands-fe vX.Y.Z (bundles intentd vA.B.C)."
- Completeness gate ("stay silent until complete"): the range scan is only a cheap
  pre-filter that nominates candidates; the gate decides. A comment is posted only
  when **both** hold: (1) at least one PR linked to the issue via a GitHub closing
  keyword (`Fixes intent-hq/intent#N` — what `closedByPullRequestsReferences`
  reports) is merged and contained in the release, no in-scope linked fix PR is
  still open, and every merged in-scope linked fix PR is contained (linked PRs that
  were closed without merging are abandoned and ignored); and (2) the issue is
  closed at release time. A PR or commit that merely *mentions* the issue is not
  evidence of a fix — the notifier stays silent on mention-only references, and an
  open issue never gets a comment even when a linked PR is delivered. The gates
  differ in scope: intentd's gate is component-scoped — it checks only
  intentd-linked fix PRs against the released intentd tag (an intentd release still
  comments while an fe-side fix PR is open); cloudlands-fe's gate is cross-repo — fe
  PRs must be contained in the fe tag AND intentd PRs in the bundled intentd tag,
  making the fe comment the user-facing availability signal. Any in-scope open or
  not-yet-contained linked fix PR → skip; a later release whose scan re-references
  the issue picks it up. When completeness cannot be determined (API error, token
  cannot see a repo), the notifier skips with a warning rather than post a
  possibly-false claim.
- How to link a multi-PR fix: put `Fixes intent-hq/intent#N` on **every** PR of the fix
  (intentd and cloudlands-fe alike). GitHub auto-closes the issue when the first PR
  merges; that early close is expected, because the completeness gate above holds the
  cloudlands-fe comment — the user-facing signal — until every linked fix PR is merged
  and contained (the component-scoped intentd notifier may comment earlier, as the gate
  bullet describes). Do not downgrade the other PRs to `Refs` / `Part of` to avoid the
  early close: mention-only references are invisible to the gate. All-mention-only
  linkage → no auto-close and no comment at all
  ([intent-hq/intent#5383](https://github.com/intent-hq/intent/issues/5383)); mixed
  linkage (one `Fixes`, one `Refs`) → the gate cannot account for the unlinked PR and
  may post the comment before the fix has fully shipped.
- Comments embed a hidden per-component/version marker, so tag rebuilds and workflow
  re-runs never double-post. `--dry-run` prints intended comments without posting.
- Posting uses the `MONOREPO_ISSUES_TOKEN` secret (issues:write on
  `intent-hq/intent` plus pull-requests:read on `intent-hq/intentd` and
  `intent-hq/cloudlands-fe` — the PR reads power the completeness gate) in both
  component repos. Notifier steps are fail-soft (`continue-on-error`; skipped with a
  warning when the secret is absent) — they never block a release.

## Coordinated Release Ordering

The pipeline is event-chained, with cron retries as backstops: intentd release PR
merge → tag + cargo-dist build → alpha manifest publish →
`intentd-alpha-published` dispatch → cloudlands-fe pin bump
(`auto-pin-intentd.yml`) → pin push to `main` → chained cloudlands-fe cut
(`auto-cut-alpha.yml` push trigger) → promote each component's stable → monorepo
pins advance automatically via the auto-bump workflow (no manual bump PR). Every
link is fail-soft: when one is missing (e.g. `FE_DISPATCH_TOKEN` unset on intentd),
the crons (hourly at :15 for pin bumps, every ten minutes for frontend cut
attempts) retry, with automated cuts still subject to the hourly floor. A
cloudlands-fe stable promotion is followed by a website release notes PR on
`intent-hq/intentapp.dev`, proposed for human review and outside the pipeline (see
[fe/RELEASING.md § Promoting to Stable](./fe/RELEASING.md#promoting-to-stable)).

## Prerelease retention

The shared command, [`scripts/cleanup_prereleases.py`](../scripts/cleanup_prereleases.py),
removes older GitHub **release records and their assets**, preserving Git tags.
Each component owns `.github/workflows/cleanup-prereleases.yml` in its source
repository and cleans its source/mirror pair. There is no monorepo cleanup schedule.

### Policy and protected downloads

The fixed policy keeps every versioned prerelease published within the last
**30 days**, including the boundary, and at least the **newest 20 prereleases per
repository**, ordered by `published_at` (release ID breaks ties). GitHub's
`prerelease` flag determines eligibility, not a version suffix. Stable releases,
drafts, rolling channels, `sitter-*` releases and unrecognized tags are retained.
A version retained by the age/count policy or stable/draft metadata in either
source or mirror protects its counterpart too.

Protection also includes daemon channel manifests, frontend platform update
feeds, the daemon pin on frontend `main`, and daemon pins referenced by **every
extant frontend release record**, even frontend records eligible for deletion.
Channel references protect both source and mirror. Modern frontend manifests use
`intentdVersion`; when a release has no manifest, its source tag resolves to an
immutable commit whose `intentd.version` is read. Historical source-built frontend
releases are accepted only through the script's reviewed exact release/build
commit and workflow-blob identities; legacy `intentdSha` manifests also require
verified daemon commit metadata. A missing pin, unknown legacy identity or
malformed manifest is not permission to ignore a dependency. Retained Git tags
without release records are not enumerated as live dependencies.

Both `latest-mac.yml` and `latest-arm64-mac.yml` protect their independently
referenced immutable frontend versions and daemon dependencies. The ARM feed is
optional for older releases; an existing channel must still have the legacy Mac
feed. Only the exact two-key empty legacy sentinel described above has no release
dependency. Extra sentinel fields, unknown versions whose dependencies cannot be
resolved, and failed feed reads abort cleanup before deletion. Every feed must
match the supported electron-builder block mapping: scalar metadata and a `files`
list of scalar mappings (or the older `path`/`sha512` pair). Duplicate keys,
aliases, multiple documents, invalid controls and unsupported fields/shapes abort
cleanup. Local asset names are accepted; absolute `files[].url` and `path` values
must point to the same immutable frontend release version the feed declares.
Path/checksum metadata must agree with its file entry. The dependency-free parser
is deliberately limited to the emitted format; changes to that format require
new compatibility fixtures before cleanup can accept them.
Quoted strings and numeric scalars retain their types: download references must
be strings, sizes positive integers, and `stagingPercentage` a number from 0 to
100. Supported optional metadata includes single-line `releaseName`, `releaseNotes`
and `minimumSystemVersion` strings, root/file `sha2`, and file `blockMapSize`.
Multiline/structured notes and other unsupported YAML forms stop cleanup until
explicitly covered by compatibility tests.

`--max-delete` defaults to **20 release deletion attempts per invocation across
the selected pair**, not 20 versions per repository. This batch limit is separate
from the newest-20 retention floor; deleting source and mirror records consumes
two attempts. Preview lists all candidates regardless of this limit. Later runs
replan from live data and work through deferred candidates. The 30-day/newest-20
policy is not a CLI or workflow input; changing it requires a reviewed code change.

### Schedules and writer exclusion

| Source workflow repository | Daily UTC schedule | Deletion scope | Shared concurrency group |
| --- | --- | --- | --- |
| `intent-hq/cloudlands-fe` | `17 2 * * *` (02:17) | `cloudlands-fe`, `cloudlands-releases` | `cloudlands-release` |
| `intent-hq/intentd` | `17 3 * * *` (03:17) | `intentd`, `intentd-releases` | `intentd-release-writers` |

The earlier frontend run can release unused daemon pins sooner; correctness does
not depend on schedule order or punctual execution. Both workflows run only in
their canonical source repository on `refs/heads/main`; manual tag/feature-branch
dispatches skip cleanup. Manual dispatch has a `mode` choice that defaults to
`preview`. Schedules also preview until repository variable
`PRERELEASE_CLEANUP_ENABLED` is exactly `true`, then schedules apply. Manual
`mode=apply` is refused until that same activation variable is true.

Both groups use `cancel-in-progress: false` and `queue: max`. GitHub permits up to
100 pending jobs/runs per group and cancels overflow; monitor queue depth and
cancelled publishers. Queue order follows arrival at the concurrency group, not
necessarily dispatch order. See [GitHub concurrency controls](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

The lock spans inventory, protection discovery, rechecks and deletion. Daemon
`v-release.yml` holds it from dist planning through source/mirror and alpha
publication; `publish-channel-manifest.yml` inherits its caller's lock and must
not reacquire it. `mirror-release.yml`, `promote-beta.yml` and
`promote-stable.yml` hold the same group for their entire workflows. PR-only dist
plans have separate run-specific groups. After `dist generate`, run daemon
`python3 scripts/configure-release-concurrency.py` to restore the generated
workflow's lock, then `python3 scripts/configure-runner-routing.py` to restore
self-hosted-first routing. Daemon CI tests both contracts. Sitter publication only writes
excluded sitter releases and is outside this daemon-version lock.

Frontend `release-alpha.yml`, `promote-beta.yml`, `release-stable.yml` and
`release-please.yml` share the frontend group with cleanup. Including
release-please protects source release creation as well as mirror publishing.
There is no nested acquisition. The shared command's Actions/repository checks
are misuse guards, not proof of lock ownership; use the component workflows for
apply, never a stand-alone process with spoofed Actions variables.

These locks are repository-local. Before each daemon deletion the command
rereads frontend release inventories and the current main pin; changed inventory
stops the batch. Preserving all extant frontend dependencies also covers their
concurrent promotions. **Arbitrary future frontend repins or builds targeting an
old daemon are outside the guarantee**, including a new cross-repository pin
change after the last recheck. There is no cross-repository transaction. Coordinate
such repins with cleanup and verify the required assets still exist first.

### Credentials

Set a dedicated `PRERELEASE_CLEANUP_TOKEN` secret in each component repository.
Both wrappers use it for authenticated `gh` reads/deletes and the pinned
`intent-hq/intent` checkout, with `persist-credentials: false` and no submodule
checkout. There is no fallback to `GITHUB_TOKEN`. Required **effective** access:

| Component credential | Contents read/write | Contents read |
| --- | --- | --- |
| Daemon cleanup | `intent-hq/intentd`, `intent-hq/intentd-releases` | `intent-hq/cloudlands-fe`, `intent-hq/cloudlands-releases`, `intent-hq/intent` |
| Frontend cleanup | `intent-hq/cloudlands-fe`, `intent-hq/cloudlands-releases` | `intent-hq/intentd`, `intent-hq/intentd-releases`, `intent-hq/intent` |

Each invocation reads protection data from all four release repositories even
when it only deletes from one pair. Read access includes releases/assets, Git
tags/commits, workflow file contents used for historical provenance, and frontend
pins. Metadata read is implicit; no Actions, Issues, Pull requests or Workflows
write permission is needed. Missing credentials visibly fail the workflow;
denied/incomplete reads stop the script without a destructive plan.

A fine-grained PAT has **one repository permission set for all selected
repositories**; it cannot assign Contents write to two selected repositories and
Contents read to the other three. Use a dedicated identity whose underlying
repository grants limit write access to its component pair and permit reads on
the other repositories; the token cannot exceed that identity's grants. Selecting
all five repositories with Contents write on an identity that can write all five
grants broader access than this table requires. Do not describe that token as
read-only on the other three, or grant monorepo/opposite-component writes merely
to enable cleanup. Repository selection, identity grants, expiration and any
organization approval must be reviewed together. See [GitHub token permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
and [REST permission requirements](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

### Deployment and activation

1. Obtain human permission and merge the monorepo script/tests/docs PR first.
2. Replace the temporary validation SHA in **both** component cleanup wrappers
   with the final merged monorepo commit SHA. Rerun checks and review that affected
   delta. Obtain separate human authorization for each component PR merge; do not
   deploy a dependency on an unmerged monorepo branch commit. Normal automation
   advances monorepo submodule pins afterward.
3. Merge all component writer-lock changes while activation remains unset. Drain
   every running or queued publisher, mirror, promotion and cleanup run using
   older workflow definitions. Old-tag runs and reruns retain old definitions:
   **do not rerun pre-lock revisions after activation**. Frontend old-tag rebuilds
   can dispatch `release-alpha.yml` from `main` with its `tag` input. Any other old
   revision requires an explicitly coordinated maintenance window with cleanup
   disabled and drained; retaining the Git tag alone does not make a rerun safe.
4. Provision the reviewed credentials, dispatch a preview on `main` for each
   component, and inspect its audit and permission failures before enabling
   deletion. For example:

   ```bash
   gh workflow run cleanup-prereleases.yml --repo intent-hq/cloudlands-fe --ref main -f mode=preview
   gh workflow run cleanup-prereleases.yml --repo intent-hq/intentd --ref main -f mode=preview
   ```

5. Only after the old writers drain and an operator approves the preview, set
   `PRERELEASE_CLEANUP_ENABLED=true` separately in each source repository. Subsequent
   schedules apply; explicit manual `mode=apply` is now permitted on `main` under
   the same lock. Monitor initial batches and queued publishers.

### Audit, API cost and recovery

For read-only local inspection, use `python3 -S -B scripts/cleanup_prereleases.py`
(all four repositories) or add `--component intentd` / `--component cloudlands-fe`.
Python 3.11+ and authenticated `gh` are sufficient. `--component all --apply` is
rejected. CI and `make test-scripts` run offline unit and mocked functional tests;
they do not need cleanup credentials or contact live release APIs.

Daemon runs upload `cleanup-report.json` as
`intentd-prerelease-cleanup-<run_id>-<run_attempt>`; frontend runs upload
`cleanup-audit.json` as `prerelease-cleanup-<run_id>-<run_attempt>`. Both artifact
retentions are 30 days. Control/checkout failures can occur before an audit file
exists; inspect the failed step logs in that case. JSON `releases` rows identify
repository, release ID, tag, planned action and retention reasons. `action=delete`
is a candidate, not evidence of deletion. Apply adds `outcomes`: `deleted`,
`already-removed` (confirmed absent), `retained-on-recheck`, or `failed`, plus the
number `deferred`. `source_built_frontend` lists validated historical exceptions.
Exit 0 and `ok=true` mean that invocation succeeded, not that every candidate was
deleted; exit 1 indicates a failed read or partial apply, and exit 2 invalid CLI
use. Apply also flushes per-attempt JSON to stderr, including `deleting` before
the request. If interrupted, consult these logs: a pending/uncertain request is
not proof of either success or failure, and prior deletions are not rolled back.

Reads paginate completely and fail closed on malformed data or errors. A GET or
DELETE 404 counts as absence only after a successful authorized inventory proves
the release ID absent. API failures, including rate limits, stop without retry;
recheck credentials/quota and rerun later to replan. There is no automatic quota
reservation or wait-for-reset loop. Preview itself can consume substantial quota:
the offline 1,600-record fixture uses 1,122 `gh` requests for planning plus a
20-attempt daemon apply batch (400 manifest reads; test ceiling 1,150 requests).
This is a regression budget for that fixture, not a production upper bound.
Immutable pin/asset caching reduces repeated reads, but rolling assets and
frontend inventories are refreshed. Avoid overlapping full previews on the same
credential; inspect `gh api rate_limit` and wait for reset after exhaustion.

Clear or set `PRERELEASE_CLEANUP_ENABLED=false` to return future schedules to
preview and reject future manual applies; disabling the cleanup workflow stops
future scheduled runs. These controls do not stop a job that already selected
apply. Inspect running and queued cleanup runs and cancel/drain them if needed
before maintenance or reverting writer locks. Cancelling can leave a partial
batch; use the audit and a new preview to reconcile it. Never remove exclusion
while cleanup can still run. Reverting code, disabling cleanup or keeping Git
tags **cannot restore deleted binaries or release records**. Recovery requires
separately republishing known artifacts or rebuilding through a coordinated
workflow, and release IDs/metadata may differ. Old direct asset URLs and future
promotions of deleted prereleases are not preserved by this retention policy.

## Gotchas

- release-please does **not** refresh the release PR for `chore` commits (their changelog
  sections are hidden), so a sidecar pin bump never appears in the release PR
  diff/changelog. The tag is cut on the merge commit whose tree contains the pin; the
  authoritative check is `intentdVersion` in the published release's
  `release-manifest.json` on the
  [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases)
  distribution repo (same tag) — cloudlands-fe source-repo releases carry no assets.
  `scripts/shipped-in.sh intentd <sha>` (`make shipped-in`) performs this lookup and
  prints the first cloudlands-releases tag whose pin carries the commit; given several
  `<component> <sha>` pairs (`make shipped-in PAIRS="intentd:<sha> cloudlands-fe:<sha>"`)
  it prints the first tag carrying all of them. It exits 3 while a commit is uncarried,
  4 on a transient GitHub failure, and 5 when the active cloudlands-fe Release Alpha run
  has a job queued longer than 30 min (`SHIPPED_IN_STALL_MINUTES` overrides the
  threshold; `0` disables the probe) — a human must cancel and re-run the workflow run
  named on stderr.
- Commits merged after the release PR was cut ride the next release PR (e.g. intentd#517
  landed via follow-up release PR intentd#520).

## CI runner routing

intent, intentd and cloudlands-fe are public, so GitHub's standard runners are free
there. Jobs that ask for a free standard label (`ubuntu-22.04`, `ubuntu-24.04`,
`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-2022`, `windows-2025`) always run on
GitHub. Jobs that ask for a paid label prefer a compatible self-hosted runner and
burst to [WarpBuild](./GITHUB_RUNNERS.md#burst-to-warpbuild) when none is free.

All three repositories run the same probe: each has a reusable `runner-route.yml`,
and the route jobs in intentd's `ci.yml` and cloudlands-fe's `intent-pr.yml` are
inline copies (`runner-policy.test.cjs` keeps them identical). The probe runs on
GitHub-hosted `ubuntu-24.04` without checkout, so it stays available during a
self-hosted outage. intentd and cloudlands-fe pull requests also run intent's probe
through `consumer-checks.yml`. Jobs read one of three outputs, keyed by the
GitHub label they would otherwise ask for:

| Output | Gives | Used by |
|---|---|---|
| `slots[key]` | a self-hosted slot for listed jobs while the pool has one free, else the burst runner | pooled jobs that start together (`slot_jobs`) |
| `runners[label]` | the self-hosted fleet while it has room, else the burst runner | other routed jobs and matrices |
| `cloud[label]` | the burst runner only, never self-hosted | jobs that need sudo or Docker, and cloudlands-fe's Mac/Windows and release-signing jobs |

The burst runner for a paid label is its WarpBuild equivalent (`gh-linux-8x` →
`warp-ubuntu-2404-x64-8x`, `gh-linux-16x` → `-16x`, `gh-linux-arm64-8x` →
`warp-ubuntu-2404-arm64-8x`, `gh-windows-16x` → `warp-windows-2022-x64-16x`,
`macos-26-xlarge` → `warp-macos-26-arm64-6x`, `macos-15-xlarge` →
`warp-macos-15-arm64-6x`), or the GitHub label itself for fork pull requests, while
`CI_WARPBUILD_DISABLED` is `true`, or while that WarpBuild OS and architecture has a job queued
over 10 minutes. `macos-latest-large` (Intel) has no WarpBuild equivalent and bursts to
GitHub. cloudlands-fe's signed desktop Mac builds keep `macos-15-xlarge` as their
key (not `macos-26-xlarge`), because electron-builder's keychain step fails on
macOS 26 images.

The self-hosted Linux x64 fleet is pools of runner slots on the cache box and on
runner-only hosts ([GITHUB_RUNNERS.md](./GITHUB_RUNNERS.md)), all
unprivileged ephemeral containers (no sudo, no Docker socket):

| Pool | Labels | Slots | Takes jobs that ask for |
|---|---|---|---|
| heavy | `[self-hosted, linux, x64, intent-cache]` | 2 by default (`CI_LINUX_HEAVY_SLOTS`), 8 CPUs each | `gh-linux-8x`, `gh-linux-16x` |
| xl | `[self-hosted, linux, x64, intent-cache-xl]` | 0 by default (`CI_LINUX_XL_SLOTS`), 16 CPUs each | `gh-linux-16x` only |

The `intent-cache-small` slots take no routed work; only pinned smoke jobs use them.
A job asks for a larger-runner label when it compiles Rust or its recent median
duration is over about 5 minutes; that cut-off is a tunable choice. No other
self-hosted Linux runner carries these labels. Jobs that need sudo, Docker, or more
than a slot offers read `cloud`, and the policy tests list each with its reason.

The shared probe checks online runners and paginated queued/running jobs across all
three repositories. Each Linux pool bursts once its queued plus running jobs reach
the smaller of its slot count (the organization or repository variables
`CI_LINUX_HEAVY_SLOTS` and `CI_LINUX_XL_SLOTS`, defaults 2 and 0; raise them when
slots are added) and its online slot count. A `gh-linux-16x` job takes a free xl slot
first, then a free heavy slot, then bursts; a `gh-linux-8x` job never takes an xl
slot. Other platforms require explicitly idle runners with room for queued demand.
Queued jobs older than 15 minutes, missing compatible runners, unreadable capacity
(including sibling queues), or [maintenance overrides](#maintenance-overrides)
select the burst runner; each platform logs its reason. An unreadable queue keeps
WarpBuild as the burst runner. Fork PRs never select persistent runners or WarpBuild.

`CI_QUEUE_READ_TOKEN` needs organization Self-hosted runners read and Actions read
on all three repositories. The probe falls back to repository runner listing if
organization listing fails, and to burst runners when it cannot establish capacity. Keep
matching organization runner groups accessible to all three repositories; the
label probe does not prove group access. Reusable callers explicitly pass the
queue token and Actions read permission through each level. A probe-runner outage
can still fail routing itself; affected workflows require a rerun.

Infrastructure exceptions are mechanically allowlisted: routing probes run on
GitHub-hosted Linux, and the manual packaged macOS
smoke journey requires a disposable hosted machine. The frontend and intentd queue-retirement
cleanup jobs and intentd read-only credential probe remain on independent GitHub-hosted
Linux, preserving their upstream queue-recovery contract. Host maintenance stays bound
to the machine it maintains. A platform without a compatible self-hosted runner
uses its burst runner (GitHub's native Intel Mac image for Intel Macs).
Browser shards retain their worker counts and browser identities, with per-runner
browser caches and dependency installation for persistent machines.

Run `python3 -S -B scripts/test_runner_policy.py` in intent and intentd to exercise
routing fixtures and reject accidental cloud pins. The frontend's existing
hosted-runner Vitest suite and backend/monorepo runner tests invoke it in CI, and
`scripts/test_hosted_runners.py` rejects any reintroduced `depot-*` label.

### Maintenance overrides

Each override is an Actions variable. Setting it to `true` sends that platform's
routed jobs to their burst runner (WarpBuild for paid labels), whatever the machine's state. Any other value, or no
variable, restores self-hosted preference. The shared probe reads the variables of
the repository whose workflow run is executing. For a called workflow, that is the
caller: consumer checks on a cloudlands-fe pull request read cloudlands-fe's
variables. So when a machine is unhealthy, set the override in intent, intentd and
cloudlands-fe; cloudlands-fe's own `intent-pr.yml` routing reads the same Linux override.

| Variable | Runner labels covered | Route log reason when set |
|---|---|---|
| `CI_LINUX_RUNNER_DISABLED` | the heavy and xl intent-cache pools and `self-hosted, Linux, ARM64` | `linux routing: burst=true (disabled for maintenance)`; xl logs as `xl routing`, ARM64 as `arm routing` |
| `CI_WINDOWS_RUNNER_DISABLED` | `self-hosted, Windows, X64` | `windows routing: burst=true (disabled for maintenance)` |
| `CI_MACOS_RUNNER_DISABLED` | `self-hosted, macOS, ARM64` and `self-hosted, macOS, X64` | `macos routing: burst=true (disabled for maintenance)`; X64 logs as `intel routing` |
| `CI_WARPBUILD_DISABLED` | WarpBuild, for every platform | `warpbuild ubuntu-x64: off (CI_WARPBUILD_DISABLED)` (likewise `ubuntu-arm64`, `windows-x64`, `macos-arm64`); bursts and `cloud` use the GitHub labels |

When the probe itself fails (fork PRs, or runner or job listing errors), every
platform instead logs `burst=true (probe failed (...))`, with or without an
override. Read the reason from a same-repository run.

Overrides only affect routed jobs. Workflows that name a machine directly keep
targeting it: intentd's `macos-prune.yml`, `m1mac-smoke.yml`
and `provision-m1mac.yml`. `windows-prune.yml` is mixed: its `prune` job names
5090pc, but it needs the `safety-tests` job to pass first. That job asks for the free
`windows-2022` label, so it always runs on GitHub-hosted Windows: it proves the cleanup
script's Windows lock and deletion semantics, not 5090pc's state.

Turning an override on: in each repository it should cover, set the variable and
`CI_<PLATFORM>_RUNNER_DISABLED_REASON`. The reason is one line with the UTC date,
what is wrong and an evidence link (a failed run or PR). GitHub variables have no
description field, so `gh variable list` showing the two together is the only record
of why a platform is on the hosted fallback:

```bash
gh variable set CI_LINUX_RUNNER_DISABLED --repo intent-hq/<repo> --body true
gh variable set CI_LINUX_RUNNER_DISABLED_REASON --repo intent-hq/<repo> \
  --body "<YYYY-MM-DD>: <what is wrong>; see <run or PR URL>"
```

Turning it off:
1. Check the requirements below on the machine itself. Maintenance workflows may run
   their checks on GitHub-hosted runners while the override is on.
2. Delete both variables in every repository where they are set.
3. Watch the next pull request and merge-queue runs:
   - The route log reason must no longer be `disabled for maintenance`.
   - Routed jobs must land on the machine and pass.
   - Linux shows `burst=false` when the queue has room. Windows and macOS still show
     `burst=true` with a queue-depth reason whenever their single slot is busy.
4. Restore the override at the first runner-caused failure.

#### Self-hosted machine requirements

These are lasting facts about each machine. Current reasons belong in the
`*_REASON` variables, not here.

| Machine | Slots | Requirements and known limits |
|---|---|---|
| intent-cache (Linux x64) | 2 heavy (`intent-cache`, about 8 CPUs / 48 GB) and 6 fast (`intent-cache-small`, 1 CPU / 3 GB) ephemeral containers, shared by all three repositories | A fresh container per job: no state survives between jobs, so per-job caches come from the compiler cache and `actions/cache`. Runs as `runner` with no sudo or Docker; the runner image carries the build tools, OpenSSL headers, shellcheck, bison, Python 3, Node, `gh` and PowerShell. |
| 5090pc (Windows x64) | 1 | `windows-prune.yml` keeps 40 GiB free; a full disk failed Rust toolchain installs (`os error 112`). Its safety tests need PowerShell 7 (`pwsh`); without it they fail with `pwsh: command not found` and the cleanup is skipped ([run 38896319862](https://github.com/intent-hq/intentd/actions/runs/38896319862)). |
| m1mac (macOS ARM64) | 1 | Too slow for intentd's merge-queue `build (aarch64-apple-darwin)` job, even with the compiler cache: over 60 minutes cold and over 26 minutes on an unchanged rerun, against about 8 minutes on a Depot Mac with Depot's managed cache, before the move to GitHub-hosted runners ([run 39120530357](https://github.com/intent-hq/intentd/actions/runs/39120530357), [run 39124725329](https://github.com/intent-hq/intentd/actions/runs/39124725329)). Clippy compiles are not cacheable by sccache, and cache keys include the checkout path, so hosted runners' entries do not match. `actions/setup-python` cannot install there (`mkdir: /Users/runner: Permission denied`); the system Python is 3.9.6. |

A single-slot machine runs its routed jobs one after another, so the combined time
of a run's jobs on that platform must fit the merge-queue timeout.

Rust compiler caching uses the self-hosted sccache WebDAV cache
([runbook](SCCACHE_SERVER.md)) when the organization Actions variable
`INTENT_SCCACHE_ENDPOINT` (an `https://` URL) is set. `scripts/setup-sccache.py`
installs checksum-verified sccache directly (no Rust cache actions remain), then
uses the `INTENT_SCCACHE_TOKEN` secret and the optional `INTENT_SCCACHE_MODE`
variable (`READ_WRITE` by default, or `READ_ONLY`), overwriting any
`SCCACHE_WEBDAV_*` values the runner already carries. Every run that receives
secrets (main, releases, the cache producer and same-repo pull requests) writes.
Without the variable, or when the token is empty as in fork pull requests,
compilation is uncached. Compiler hit statistics, rather than a restored Actions
archive, are the evidence of reuse. The job log names the chosen backend and
mode, never the token. Reusable workflows such as `consumer-checks.yml` accept
`INTENT_SCCACHE_TOKEN` as an optional secret. Local build configuration is in
[CONTRIBUTING.md](../CONTRIBUTING.md#local-rust-compiler-cache).
