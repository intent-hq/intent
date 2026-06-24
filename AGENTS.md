# Agent Workflow Guide

Instructions for AI agents working in this monorepo.

## Repository Structure

This is a private monorepo that references Cloudlands component repositories as git
submodules:

- `packages/intentd` → [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd) — Rust backend daemon

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.
The engineering spec lives in `docs/00_initial_porting/IMPLEMENTATION_SPEC.md`; see
`docs/README.md` for how the porting documents relate.

## Commit & PR Workflow

When changes span a submodule and the monorepo, follow this sequence: Phase 1 → Phase 2.

### Phase 1 — Submodule PRs

1. **Make scoped commits in the submodule** on a feature branch. Group related changes into
   logical commits with conventional commit messages (`feat:`, `fix:`, `chore:`, etc.).
2. **Push the feature branch** in the submodule repo.
3. **File a PR** on the submodule's repo (e.g., `cloudlands-ai/intentd`).
4. **Merge the PR** (squash merge preferred).

### Phase 2 — Monorepo Update

1. Pull latest `main` in the updated submodule so it points to the newly merged commit.
2. **Stage the submodule ref change** in the monorepo (`git add packages/<name>`).
3. **Commit** with a message like `chore: update <name> submodule to latest main`.
4. **Push** the monorepo branch.
5. **File a PR** on the monorepo repo (`cloudlands-ai/monorepo`). Reference the submodule PR
   in the body.
6. **Merge the monorepo PR**.

## Conventions

- **Conventional commits** are required. PR titles are validated by CI
  (`amannn/action-semantic-pull-request`) against: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `ci`, `perf`.
- **Changelogs** are generated with `git-cliff` (see `cliff.toml`).
- **Rust**: keep `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo build`
  green in `packages/intentd` before opening a PR. The **monorepo-root** `Makefile` exposes
  `make check` and `make test`, which run those checks against `packages/intentd`.

## Breadcrumbs (initial porting)

For the duration of the **`00_initial_porting`** effort — the initial port of Intent's
backend to the Rust daemon (`intentd`) — keep the breadcrumb trail at
`docs/00_initial_porting/BREADCRUMBS.md` current.

- **When**: whenever you complete a meaningful unit of porting work (a crate, a method or
  group of methods, a transport/persistence change, a submodule bump).
- **What**: append a dated entry to the changelog, newest first. Keep it concise — what
  changed, which crates/methods were touched, and the resulting `packages/intentd` HEAD.
  Also update the "Current submodule HEAD" and "Implemented surface" sections when they
  change, and move items out of "Deferred / planned" as they ship.
- **Accuracy**: never overstate. Only list surface that is actually implemented; everything
  else stays under deferred/planned.
- **Scope**: this policy applies only until the initial Rust-BE port is complete; it does
  not extend to later efforts.

Breadcrumb edits are docs-only and follow the same conventional-commit / PR conventions
above (use a `docs:` commit). They typically ship in the monorepo PR that bumps the
submodule, so the recorded HEAD matches the gitlink.

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
