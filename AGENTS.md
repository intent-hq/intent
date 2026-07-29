# Agent Workflow Guide

Instructions for AI agents working in this monorepo.

## Repository Structure

This monorepo references the Intent component repositories as git
submodules:

- `packages/intentd` → [intent-hq/intentd](https://github.com/intent-hq/intentd) — Rust backend daemon
- `packages/cloudlands-fe` → [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) — Electron + SvelteKit desktop frontend
- `packages/ios` → [intent-hq/ios](https://github.com/intent-hq/ios) — SwiftUI iOS companion app

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.
The durable engineering docs live in `docs/ARCHITECTURE.md` (backend architecture) and
`docs/PROTOCOL.md` (canonical wire contract); see `docs/README.md` for the docs index.

## Commit & PR Workflow

When changes span a submodule and the monorepo, follow this sequence: Phase 1 → Phase 2.

### Phase 1 — Submodule PRs

1. **Make scoped commits in the submodule** on a feature branch. Group related changes into
   logical commits with conventional commit messages (`feat:`, `fix:`, `chore:`, etc.).
2. **Push the feature branch** in the submodule repo.
3. **File a PR** on the submodule's repo (e.g., `intent-hq/intentd`).
4. **Merge the PR** (squash merge preferred).

### Phase 2 — Monorepo Update

1. Pull latest `main` in the updated submodule so it points to the newly merged commit.
2. **Stage the submodule ref change** in the monorepo (`git add packages/<name>`).
3. **Commit** with a message like `chore: update <name> submodule to latest main`.
4. **Push** the monorepo branch.
5. **File a PR** on the monorepo repo (`intent-hq/monorepo`). Reference the submodule PR
   in the body.
6. **Merge the monorepo PR**.

## Conventions

- **Conventional commits** are required. PR titles are validated by CI
  (`amannn/action-semantic-pull-request`) against: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `ci`, `perf`.
- **Merging**: The repository allows squash and rebase merges. When squash-merging, the
  commit title defaults to the commit message (or PR title as fallback), and the commit
  message includes all commit messages from the PR. On single-commit PRs, ensure the branch
  commit message is itself a valid conventional commit (amend auto-commits like
  "Coordinator" before pushing) to prevent non-conventional commits from landing on main
  (e.g., PR #102 incident).
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
  first with a coded fallback to intentd. `mirror-release.yml` (manual dispatch)
  backfills older releases. The mirror is temporary until intentd is open-sourced.
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

### Coordinated Release Ordering

intentd release → promote intentd stable → cloudlands-fe pin-bump PR → cloudlands-fe
release → promote cloudlands-fe stable → monorepo submodule bump PR.

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
  `fix: correct panel focus (#123)`).

## Terminology

Do **not** use "wave" / "Wave N" terminology in committed documentation. It is
coordinator-internal vocabulary specific to a single agent's delegation flow and must not
leak into the repo. Describe progress as capabilities/milestones instead (e.g. "Repo & CI
bootstrap", "Crate skeleton", "Core + SQLite store", "UDS JSON-RPC slice").

## Local Setup

```bash
git submodule update --init --recursive
make check
make test
```
