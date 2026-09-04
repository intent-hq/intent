# Contributing to Intent

Thanks for your interest in Intent!

## Contribution posture

<!-- This section states the current posture. When the project opens up to
     external pull requests, update this section only — the rest of this
     document already describes the workflow that contributions will follow. -->

Development happens in the `intent-hq` repositories at high velocity, largely
driven by AI agents working against a shared workflow. At launch, the public
repository is a **read-only snapshot mirror** of that development.

- **Bug reports and feature requests are very welcome.** Please file them via
  the [issue forms](https://github.com/intent-hq/intent/issues/new/choose) on
  [intent-hq/intent](https://github.com/intent-hq/intent/issues), the single
  tracker for all components.
- **External pull requests are not being accepted yet.** PRs will be closed
  with thanks. We expect this posture to change post-launch as the project
  matures — if you want to work on something in the meantime, open an issue so
  we can discuss it.

The rest of this document describes how changes flow through the repositories, so
that issue discussions and any future contributions match the project's workflow.

## Repository structure

This monorepo tracks the Intent component repositories as git submodules; the code
lives in the submodule repos:

| Path | Repository | Component |
|------|------------|-----------|
| `packages/intentd` | [intent-hq/intentd](https://github.com/intent-hq/intentd) | Rust backend daemon |
| `packages/cloudlands-fe` | [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) | Electron + SvelteKit desktop frontend |
| `packages/ios` | [intent-hq/ios](https://github.com/intent-hq/ios) | SwiftUI iOS companion app (private) |

`packages/ios` is private and marked `update = none` in `.gitmodules`, so
recursive clones and submodule updates skip it by default; internal developers
with access initialize it via `make ensure-ios-submodule`.

The durable engineering docs live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(backend architecture) and [docs/protocol/](docs/protocol/README.md) (the canonical
wire contract); see [docs/README.md](docs/README.md) for the docs index.

## Two-phase change workflow

Changes that touch a submodule land in two phases:

1. **Phase 1 — submodule PR.** Make scoped, conventional commits on a feature
   branch in the submodule repo (e.g. `intent-hq/intentd`), open a PR there, and
   merge it (squash merge preferred).
2. **Phase 2 — automated monorepo pin advance.** The `auto-bump-submodules`
   workflow (triggered by `repository_dispatch` from submodule merges for
   ~1-minute latency, with a 30-minute cron backstop, plus manual dispatch)
   advances the monorepo's submodule pins to the merged tips via a single
   rolling auto-merged PR on the `auto/submodule-bump` branch. **Do not file
   manual submodule bump PRs** — if an urgent bump is needed, dispatch the
   workflow manually
   (`gh workflow run auto-bump-submodules.yml`) instead of opening a PR.

Monorepo-only changes (docs, Makefile, CI, scripts, templates) are unaffected by
the automation and need only a single normal monorepo PR.

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
  `cargo build` — the monorepo-root `Makefile` wraps these as `make check`
  (fmt + clippy) and `make build`; run `make test` for the test suite.
- **cloudlands-fe**: `pnpm run check` and `pnpm vitest run`.
- **ios**: build + test targets passing.

## Filing issues

- Use the [issue forms](https://github.com/intent-hq/intent/issues/new/choose)
  (bug report / feature request) and pick the affected component(s).
- **Search first** — check existing open *and* closed issues and comment on or
  link an existing issue instead of filing a duplicate.
- Issues are triaged with `component:*` labels and a severity taxonomy that
  maps onto the issue **Priority** field (Urgent crash/data-loss, High broken
  feature, Medium degraded behavior, Low papercut) described in
  [docs/README.md](docs/README.md).

## Local setup

```bash
git submodule update --init --recursive   # skips the private packages/ios by design
make check
make test
```

## Security issues

Please do not report security vulnerabilities through public issues — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
