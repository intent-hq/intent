# Agent Workflow Guide

Instructions for AI agents working in this monorepo.

## Repository Structure

This is a private monorepo that references Cloudlands component repositories as gitsubmodules:

- `packages/intentd` → [intent-hq/intentd](https://github.com/intent-hq/intentd) — Rust backend daemon
- `packages/cloudlands-fe` → [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) — Electron + SvelteKit desktop frontend
- `packages/ios` → [intent-hq/ios](https://github.com/intent-hq/ios) — SwiftUI iOS companion app

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.The engineering spec lives in `docs/00_initial_porting/IMPLEMENTATION_SPEC.md`; see`docs/README.md` for how the porting documents relate.

## Commit & PR Workflow

When changes span a submodule and the monorepo, follow this sequence: Phase 1 → Phase 2.

### Phase 1 — Submodule PRs

1. **Make scoped commits in the submodule** on a feature branch. Group related changes intological commits with conventional commit messages (`feat:`, `fix:`, `chore:`, etc.).
2. **Push the feature branch** in the submodule repo.
3. **File a PR** on the submodule's repo (e.g., `intent-hq/intentd`).
4. **Merge the PR** (squash merge preferred).

### Phase 2 — Monorepo Update

1. Pull latest `main` in the updated submodule so it points to the newly merged commit.
2. **Stage the submodule ref change** in the monorepo (`git add packages/<name>`).
3. **Commit** with a message like `chore: update <name> submodule to latest main`.
4. **Push** the monorepo branch.
5. **File a PR** on the monorepo repo (`intent-hq/monorepo`). Reference the submodule PRin the body.
6. **Merge the monorepo PR**.

## Conventions

- **Conventional commits** are required. PR titles are validated by CI(`amannn/action-semantic-pull-request`) against: `feat`, `fix`, `chore`, `docs`,`refactor`, `test`, `ci`, `perf`.
- **Changelogs** are generated with `git-cliff` (see `cliff.toml`).
- **Rust**: keep `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo build`green in `packages/intentd` before opening a PR. The **monorepo-root** `Makefile` exposes`make check` and `make test`, which run those checks against `packages/intentd`.

## Breadcrumbs (initial porting) — **CONCLUDED**

The `00_initial_porting` effort is complete as of 2026-07-13.`docs/00_initial_porting/BREADCRUMBS.md` is now **frozen** as a historical record. Nonew breadcrumb entries should be added to that file.

The policy was:

- **When**: whenever you complete a meaningful unit of porting work (a crate, a method orgroup of methods, a transport/persistence change, a submodule bump).
- **What**: append a dated entry to the changelog, newest first. Keep it concise — whatchanged, which crates/methods were touched, and the resulting `packages/intentd` HEAD.Also update the "Current submodule HEAD" and "Implemented surface" sections when theychange, and move items out of "Deferred / planned" as they ship.
- **Accuracy**: never overstate. Only list surface that is actually implemented; everythingelse stays under deferred/planned.

Breadcrumb edits were docs-only and followed the same conventional-commit / PR conventions(using a `docs:` commit). They typically shipped in the monorepo PR that bumped thesubmodule, so the recorded HEAD matched the gitlink.

## Known Issues (stabilization)

For the `01_stabilizing` phase — ongoing stabilization and hardening on theself-hosted stack — keep the issue tracker at `docs/01_stabilizing/KNOWN_ISSUES.md`current.

- **When to file**: whenever you discover a bug while dogfooding (using intentd +cloudlands-fe for daily development work).
- **What to file**: document with id `STAB-N`, date (YYYY-MM-DD), area(component/subsystem), severity (P0 crash/data-loss, P1 broken feature, P2 papercut),repro steps, and status (`open` | `fixed (PR link, date)`).
- **When to update**: when you fix an issue, mark it fixed with the PR link and resolutiondate.
- **Accuracy**: file issues as you encounter them; update status when PRs land. Knownissues should reflect the current state of the app.

Issue-tracker edits follow the same conventional-commit / PR conventions above. When theKNOWN_ISSUES.md update is standalone (documenting a newly-discovered bug), use a `docs:`commit. When the tracker update rides along in the same PR as the actual code fix (markingan issue fixed), the PR/commit type follows the code change (`fix:`, `feat:`, etc.).

## Terminology

Do **not** use "wave" / "Wave N" terminology in committed documentation. It iscoordinator-internal vocabulary specific to a single agent's delegation flow and must notleak into the repo. Describe progress as capabilities/milestones instead (e.g. "Repo & CIbootstrap", "Crate skeleton", "Core + SQLite store", "UDS JSON-RPC slice").

## Local Setup

```bash
git submodule update --init --recursive
make check
make test
```