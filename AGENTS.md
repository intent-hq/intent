# Agent Workflow Guide

Instructions for AI agents working in this monorepo.

## Repository Structure

This monorepo references the Intent component repositories as git
submodules:

- `packages/intentd` → [intent-hq/intentd](https://github.com/intent-hq/intentd) — Rust backend daemon
- `packages/cloudlands-fe` → [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) — Electron + SvelteKit desktop frontend
- `packages/ios` → [intent-hq/ios](https://github.com/intent-hq/ios) — SwiftUI iOS companion app (private)

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.
`packages/ios` is private and marked `update = none` in `.gitmodules`: recursive clones and
`git submodule update --init --recursive` skip it by design, and internal devs initialize it
on demand with `make ensure-ios-submodule`. When iOS goes public, deleting the `update = none`
line is not enough for clones registered during the private period — they must also run
`git config --unset submodule.packages/ios.update`, because `git submodule init` copies the
key into the clone's local `.git/config` and `git submodule sync` does not refresh it.
The durable engineering docs live in `docs/ARCHITECTURE.md` (backend architecture) and
`docs/PROTOCOL.md` (canonical wire contract); see `docs/README.md` for the docs index.

## Commit & PR Workflow

When changes span a submodule and the monorepo, land the submodule PR (Phase 1); the
monorepo pin advance (Phase 2) then happens automatically.

### Phase 1 — Submodule PRs

1. **Make scoped commits in the submodule** on a feature branch. Group related changes into
   logical commits with conventional commit messages (`feat:`, `fix:`, `chore:`, etc.).
2. **Push the feature branch** in the submodule repo.
3. **File a PR** on the submodule's repo (e.g., `intent-hq/intentd`).
4. **Merge the PR** (squash merge preferred).

When the change fixes a monorepo issue, reference it with the full cross-repo form —
`Fixes intent-hq/monorepo#N` — in the squash-commit message or PR body. GitHub
auto-closes the issue on merge, and the release notifier (see Release Process) comments
on it when the fix ships in a release.

### Phase 2 — Monorepo pin advance (automated)

Submodule pins are advanced automatically by the `auto-bump-submodules` workflow
(`.github/workflows/auto-bump-submodules.yml`): it detects submodule tips ahead of the
recorded pins and lands the bump via a single rolling PR on the `auto/submodule-bump`
branch with auto-merge armed; repeat runs update that PR instead of opening new ones.
The workflow is triggered three ways: each submodule repo notifies the monorepo on push
to `main` via a `repository_dispatch` event (`submodule-update` type), so bumps normally
land within about a minute of a submodule merge; a cron run every 30 minutes acts as a
backstop; and manual `workflow_dispatch` is available for urgent bumps. The
`repository_dispatch` notifications are sent by the submodule repos using the
`MONOREPO_DISPATCH_TOKEN` secret (stored in each submodule repo; a fine-grained PAT with
contents:write on `intent-hq/monorepo`), and are fail-soft: when the secret is absent
the notify step logs a warning and skips, and the cron backstop still advances the pins.

**Agents (and humans) must NOT file manual submodule bump PRs on the monorepo.** The
workflow owns pin advancement. If an urgent bump is needed, dispatch the workflow
manually instead of filing a PR:

```bash
gh workflow run auto-bump-submodules.yml
```

Regular monorepo PRs for actual content changes (docs, Makefile, CI, scripts) are
unaffected and still follow the normal PR flow.

The workflow authenticates with the `SUBMODULE_BUMP_TOKEN` secret — a fine-grained PAT
with contents:read on `intent-hq/intentd`, `intent-hq/cloudlands-fe`, and
`intent-hq/ios`, plus contents:write and pull-requests:write on `intent-hq/monorepo`.
Like `INTENTD_RELEASES_TOKEN` / `MONOREPO_ISSUES_TOKEN`, it is fail-soft: when the
secret is absent the workflow logs a warning and exits successfully. The private
`packages/ios` submodule is best-effort — if its tip cannot be read, it is skipped
with a warning and never fails the run.

### Cross-component features (intentd + cloudlands-fe)

For features that need changes in both intentd and cloudlands-fe, development and PR
filing on both repos proceed fully in parallel — nothing serializes until merge time.
The only ordering constraint is the final merge: **do not merge the cloudlands-fe PR
(or arm auto-merge on it) until the intentd PR is confirmed merged** — approved/green
is not enough. This intentd-first rule applies specifically to protocol changes (the
daemon↔fe wire contract, `docs/PROTOCOL.md`): whenever a feature touches the protocol,
the daemon side must land first. Rationale: cloudlands-fe may depend on daemon
behavior/protocol that only exists once the intentd change has landed, so an fe-first
merge can break main or ship against a contract that doesn't exist yet. This rule is
about submodule PR merges, not monorepo bumps — after both are merged, the
auto-bump-submodules workflow advances both monorepo pins automatically (a single
rolling bump PR may cover both submodule refs); do not file a manual bump PR.

## Conventions

- **Conventional commits** are required. PR titles are validated by CI
  (`amannn/action-semantic-pull-request`) against: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `ci`, `perf`.
- **Merging**: The repository allows squash and rebase merges; no merge queue is enabled.
  Merge with `gh pr merge --squash` (optionally `--auto` to merge once checks pass). The
  GraphQL `enqueuePullRequest` mutation fails with "Merge queues are not enabled" — it is
  only relevant if a merge queue is enabled later. When squash-merging, the commit
  title defaults to the commit message (or PR title as fallback), and the commit message
  includes all commit messages from the PR. On single-commit PRs, ensure the branch commit
  message is itself a valid conventional commit (amend auto-commits like "Coordinator"
  before pushing) to prevent non-conventional commits from landing on main (e.g., PR #102
  incident).
- **Changelogs** are generated with `git-cliff` (see `cliff.toml`).
- **Rust**: keep `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo build`
  green in `packages/intentd` before opening a PR. The **monorepo-root** `Makefile` exposes
  `make check` and `make test`, which run those checks against `packages/intentd`.

## Release Process

Releases are per-component and channel-based: merging a release PR publishes to **beta**;
**stable** is a promotion of an existing release (no new build), triggered by a manual
workflow dispatch.

### intentd

- release-plz maintains a release PR on `main`. Merging it cuts the `vX.Y.Z` tag,
  cargo-dist builds the artifacts, and the beta manifest publishes automatically.
- Stable is promotion-only: dispatch `promote-stable.yml` with the `version` input, then
  verify `stable.json` on the `channel-stable` release.
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

### cloudlands-fe

- The intentd sidecar version is pinned in `intentd.version` at the cloudlands-fe repo
  root (`packages/cloudlands-fe/` in this monorepo). Bump it via PR and verify by running
  `node scripts/fetch-sidecar.cjs` from that directory.
- release-please maintains a release PR. Merging it cuts the tag and `release-beta.yml`
  publishes to `intent-hq/cloudlands-releases`.
- Stable: dispatch `release-stable.yml` with the `version` input.

### Release notifier

- Both component repos run `scripts/notify-fixed-issues.sh` from their release workflows.
  On beta publish it scans the released tag range (commit messages plus squash-merged PR
  bodies, resolved via the `(#N)` subject suffix) for `intent-hq/monorepo#N` / full issue
  URL references and posts "Fixed in <component> vX.Y.Z (beta)" on each referenced issue;
  on stable promotion it posts a "promoted to stable" comment covering the range since the
  previous stable. cloudlands-fe comments also name the bundled intentd version.
- Comments embed a hidden per-component/version/channel marker, so tag rebuilds and
  workflow re-runs never double-post. `--dry-run` prints intended comments without
  posting.
- Posting uses the `MONOREPO_ISSUES_TOKEN` secret (issues:write on `intent-hq/monorepo`)
  in both component repos. Notifier steps are fail-soft (`continue-on-error`; skipped
  with a warning when the secret is absent) — they never block a release or promotion.

### Coordinated Release Ordering

intentd release → promote intentd stable → cloudlands-fe pin-bump PR → cloudlands-fe
release → promote cloudlands-fe stable → monorepo pins advance automatically via the
auto-bump workflow (no manual bump PR).

### Gotchas

- release-please does **not** refresh the release PR for `chore` commits (their changelog
  sections are hidden), so a sidecar pin bump never appears in the release PR
  diff/changelog. The tag is cut on the merge commit whose tree contains the pin; the
  authoritative check is `intentdVersion` in the published release's
  `release-manifest.json`.
- Commits merged after the release PR was cut ride the next release PR (e.g. intentd#517
  landed via follow-up release PR intentd#520).

## Breadcrumbs (initial porting) — **CONCLUDED**

The initial porting effort is complete as of 2026-07-13, and its chronicle (implementation
spec, porting-era protocol, and the frozen breadcrumbs progress log) has been removed from
the tree — the original documents remain available in git history. The durable content
lives on in `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`. Do not add new breadcrumb
entries; progress is tracked via GitHub issues and PRs.

## Filing Issues

When you encounter a bug or limitation while working on the codebase (including while
dogfooding intentd + cloudlands-fe for daily development work), file a GitHub issue on
[intent-hq/monorepo](https://github.com/intent-hq/monorepo/issues) — the single tracker
for all components.

- **Labels**: apply the appropriate `component:*` label (`component:intentd`,
  `component:fe`, `component:ios`) plus `agent-filed`.
- **Aggressive dedup**: search existing issues first
  (`gh issue list --repo intent-hq/monorepo --search "<keywords>" --state all`) and
  comment on / link the existing issue instead of filing a duplicate.
- **Cross-reference**: reference the issue number in related commits/PRs (e.g.
  `fix: correct panel focus (#123)`). In submodule PRs, use the full cross-repo form
  `Fixes intent-hq/monorepo#N` so the issue auto-closes on merge and the release
  notifier comments on it when the fix ships (see Release Process).

## Terminology

Do **not** use "wave" / "Wave N" terminology in committed documentation. It is
coordinator-internal vocabulary specific to a single agent's delegation flow and must not
leak into the repo. Describe progress as capabilities/milestones instead (e.g. "Repo & CI
bootstrap", "Crate skeleton", "Core + SQLite store", "UDS JSON-RPC slice").

## Local Setup

```bash
git submodule update --init --recursive   # skips the private packages/ios (update = none)
make check
make test
```
