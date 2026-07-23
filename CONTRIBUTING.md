# Contributing to Intent

Thanks for your interest in Intent!

## Contribution posture

Intent is developed in the open, but active development currently happens at high
velocity inside this repository and its component repositories, largely driven by
AI agents working against a shared workflow. To keep review overhead manageable:

- **Issues are welcome.** Bug reports and feature requests are the most valuable
  way to contribute right now — please file them on
  [intent-hq/monorepo](https://github.com/intent-hq/monorepo/issues), the single
  tracker for all components.
- **External pull requests are deferred for now.** Unsolicited PRs may be closed
  with thanks. If you want to work on something, open an issue first so we can
  discuss it — we expect to open up to external PRs as the project matures.

The rest of this document describes how changes flow through the repositories, so
that issue discussions and any future contributions match the project's workflow.

## Repository structure

This monorepo tracks the Intent component repositories as git submodules; the code
lives in the submodule repos:

| Path | Repository | Component |
|------|------------|-----------|
| `packages/intentd` | [intent-hq/intentd](https://github.com/intent-hq/intentd) | Rust backend daemon |
| `packages/cloudlands-fe` | [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) | Electron + SvelteKit desktop frontend |
| `packages/ios` | [intent-hq/ios](https://github.com/intent-hq/ios) | SwiftUI iOS companion app |

The durable engineering docs live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(backend architecture) and [docs/PROTOCOL.md](docs/PROTOCOL.md) (the canonical
wire contract); see [docs/README.md](docs/README.md) for the docs index.

## Two-phase change workflow

Changes that touch a submodule land in two phases:

1. **Phase 1 — submodule PR.** Make scoped, conventional commits on a feature
   branch in the submodule repo (e.g. `intent-hq/intentd`), open a PR there, and
   merge it (squash merge preferred).
2. **Phase 2 — monorepo gitlink bump.** Point the submodule at the newly merged
   commit, commit the pointer change in the monorepo (e.g.
   `chore: update intentd submodule to latest main`), and open a monorepo PR that
   references the submodule PR.

Monorepo-only changes (docs, CI, templates) need only a single monorepo PR.

## Conventional commits

Commit messages and PR titles follow
[Conventional Commits](https://www.conventionalcommits.org/). CI validates PR
titles against these types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`,
`ci`, `perf`.

PRs are squash-merged (rebase is also allowed). On squash, the commit title
defaults to the commit message (or the PR title as fallback), so on
single-commit PRs make sure the branch commit message is itself a valid
conventional commit before pushing.

## CI expectations

Keep the relevant checks green before opening a PR:

- **intentd**: `cargo fmt --check`, `cargo clippy -- -D warnings`, and
  `cargo build` — the monorepo-root `Makefile` wraps these as `make check` and
  `make test`.
- **cloudlands-fe**: `pnpm run check` and `pnpm vitest run`.
- **ios**: build + test targets passing.

## Filing issues

- Use the [issue forms](https://github.com/intent-hq/monorepo/issues/new/choose)
  (bug report / feature request) and pick the affected component(s).
- **Search first** — check existing open *and* closed issues and comment on or
  link an existing issue instead of filing a duplicate.
- Issues are triaged with `component:*` labels and a severity taxonomy
  (P0 crash/data-loss, P1 broken feature, P2 papercut) described in
  [docs/README.md](docs/README.md).

## Local setup

```bash
git submodule update --init --recursive
make check
make test
```

## Security issues

Please do not report security vulnerabilities through public issues — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
