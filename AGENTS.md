# Agent Workflow Guide

Instructions for AI agents working in this monorepo.

## Repository Structure

This monorepo references the Intent component repositories as git
submodules:

- `packages/intentd` → [intent-hq/intentd](https://github.com/intent-hq/intentd) — Rust backend daemon
- `packages/cloudlands-fe` → [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) — Electron + SvelteKit desktop frontend
- `packages/ios` → [intent-hq/ios](https://github.com/intent-hq/ios) — SwiftUI iOS companion app

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.
The engineering spec lives in `docs/00_initial_porting/IMPLEMENTATION_SPEC.md`; see
`docs/README.md` for how the porting documents relate.

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

## Breadcrumbs (initial porting) — **CONCLUDED**

The **`00_initial_porting`** effort is complete as of 2026-07-13.
`docs/00_initial_porting/BREADCRUMBS.md` is now **frozen** as a historical record. No
new breadcrumb entries should be added to that file.

The policy was:
- **When**: whenever you complete a meaningful unit of porting work (a crate, a method or
  group of methods, a transport/persistence change, a submodule bump).
- **What**: append a dated entry to the changelog, newest first. Keep it concise — what
  changed, which crates/methods were touched, and the resulting `packages/intentd` HEAD.
  Also update the "Current submodule HEAD" and "Implemented surface" sections when they
  change, and move items out of "Deferred / planned" as they ship.
- **Accuracy**: never overstate. Only list surface that is actually implemented; everything
  else stays under deferred/planned.

Breadcrumb edits were docs-only and followed the same conventional-commit / PR conventions
(using a `docs:` commit). They typically shipped in the monorepo PR that bumped the
submodule, so the recorded HEAD matched the gitlink.

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
