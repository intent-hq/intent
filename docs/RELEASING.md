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

## Guarded direct release merges

Both components' `auto-cut-alpha.yml` workflows can squash-merge a verified
release metadata PR directly, avoiding a second CI run in the merge queue.
Ordinary PRs, frontend sidecar pin PRs, and monorepo submodule bump PRs continue
through the queue. A release PR whose diff does not match the metadata shape
uses the ordinary guarded queue path too.

Direct merging requires the existing release guards to pass: the expected
same-repository release branch and author, no draft or `hold-release`, acceptable
mergeability and freshness, a successful `CI Gate` on the assessed head, and no
blocking human review threads. Existing throttle, dry-run, frontend daemon
freshness and in-flight sidecar checks still apply, including their documented
manual-dispatch overrides. Release automation does not refresh the PR branch;
release-plz or release-please owns that content.

The workflow uses the classifier from its trusted workflow revision, never a
script from the PR head, to inspect the diff. Only release metadata qualifies:
intentd permits independent crate version changes, matching local dependency
requirements and workspace-package lockfile versions, plus harmless TOML
formatting/comments; cloudlands-fe permits the package version and matching
release-please manifest update. Source, workflow, external dependency and sidecar
pin changes do not qualify. A classification failure cannot enable direct merging.
The merge uses `--squash --admin --match-head-commit <assessed-head-sha>`; the
head match prevents a refreshed, unchecked PR head from being merged using the
earlier decision. Queue submission is not evidence of a completed merge or a
published alpha; confirm the PR's merged state and the release artifacts.

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

A sitter-supervised daemon (`intentd serve`) picks up a channel publish by one of two
paths:

- **Opportunistic, idle-triggered** — once no agent has had a turn in flight for
  `updates.idleGraceSeconds` (default 120 s), the daemon asks its sitter to check
  now (`SIGUSR2`), at most every `updates.idleCheckIntervalMinutes` (default 60).
  The sitter stages any newer version and the daemon restarts into it the next
  moment no turn is in flight, so an idle install updates within about an hour of
  the publish without interrupting a running agent. `updates.checkOnIdle=false`
  (live setting, no restart; see
  [protocol/methods/settings.md](./protocol/methods/settings.md)) disables this path.
- **Forced, periodic** — the sitter's randomized 12–24 h check, unchanged: it
  installs a newer version (or one already staged) and restarts the daemon whether
  or not a turn is in flight. This is the fallback for continuously busy installs and
  the only path when `checkOnIdle` is off.

`intentd update` (`system.requestUpdate`, "Update now") still checks and restarts
immediately.

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
  event chain / hourly crons: the operator lands the fix in intentd, cuts the intentd
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
- The Release PR merge is automated by `auto-cut-alpha.yml`, which is event-chained
  with an hourly cron backstop: the pin-bump squash merge (a push to `main` touching
  `intentd.version`, made with `RELEASE_PAT` so it triggers workflows) chains straight
  into a cut run that polls (30s interval, up to 15 min) for release-please to refresh
  the Release PR and for CI Gate to go green, then merges — so an intentd change ships
  in the **same fe alpha cycle**. The hourly cron at :30 is the backstop and the
  normal path for fe-only changes; cron and manual-dispatch runs keep the
  check-once-and-exit behavior (no polling). An open pin-bump PR (branch
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
  intentd alpha's pin-bump push chains into a cut that re-evaluates (push runs
  with polling budget left retry in-run). A confirmed release-plz no-op also
  exempts this freshness deferral (intent-hq/intent#6045): the latest
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

The pipeline is event-chained, with hourly crons as backstops: intentd release PR
merge → tag + cargo-dist build → alpha manifest publish →
`intentd-alpha-published` dispatch → cloudlands-fe pin bump
(`auto-pin-intentd.yml`) → pin push to `main` → chained cloudlands-fe cut
(`auto-cut-alpha.yml` push trigger) → promote each component's stable → monorepo
pins advance automatically via the auto-bump workflow (no manual bump PR). Every
link is fail-soft: when one is missing (e.g. `FE_DISPATCH_TOKEN` unset on intentd),
the crons (:15 pin bump, :30 cut) keep everything working at cron cadence. A
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
workflow's lock; daemon CI tests this contract. Sitter publication only writes
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
