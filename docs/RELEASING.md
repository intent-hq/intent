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
  with polling budget left retry in-run). Automation commits (the sidecar
  pin-bump itself, `chore(release):` merges) are exempt from the freshness test,
  and the check fails open on any lookup error (missing `INTENTD_READ_PAT`,
  unreadable pin/tags/comparison) — same convention as the in-flight guardrail.
- Stable: dispatch `release-stable.yml` with the `version` input. The same beta-first
  guard applies: the workflow checks the current beta channel version (the `beta`
  release's `latest-mac.yml` feed on `intent-hq/cloudlands-releases`) is >= the
  promoted version — beta can never be behind stable — and fails fast before any
  channel asset is downloaded or uploaded: a missing/unparseable beta feed or a beta
  version behind the promoted one aborts while the live stable channel is still
  untouched (same caveat as intentd: the guard enforces the beta-not-behind
  invariant, not that the promoted version itself ever occupied beta). The optional
  `skip_beta_check` boolean dispatch input (default `false`) bypasses the guard for
  emergencies, logged as a warning.

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
- Completeness gate ("stay silent until complete"): a comment is posted only when
  every linked fix PR the gate considers is merged and contained. The gates differ
  in scope: intentd's gate is component-scoped — it checks only intentd-linked fix
  PRs against the released intentd tag (an intentd release still comments while an
  fe-side fix PR is open); cloudlands-fe's gate is cross-repo — fe PRs must be
  contained in the fe tag AND intentd PRs in the bundled intentd tag, making the fe
  comment the user-facing availability signal. Any in-scope open or
  not-yet-contained linked fix PR → skip; a later release whose scan re-references
  the issue picks it up. When completeness cannot be determined (API error, token
  cannot see a repo), the notifier skips with a warning rather than post a
  possibly-false claim. Issues with no linked fix PRs at all fall back to the
  range-scan evidence (best effort).
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
the crons (:15 pin bump, :30 cut) keep everything working at cron cadence.

## Gotchas

- release-please does **not** refresh the release PR for `chore` commits (their changelog
  sections are hidden), so a sidecar pin bump never appears in the release PR
  diff/changelog. The tag is cut on the merge commit whose tree contains the pin; the
  authoritative check is `intentdVersion` in the published release's
  `release-manifest.json` on the
  [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases)
  distribution repo (same tag) — cloudlands-fe source-repo releases carry no assets.
- Commits merged after the release PR was cut ride the next release PR (e.g. intentd#517
  landed via follow-up release PR intentd#520).
