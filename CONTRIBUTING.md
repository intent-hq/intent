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
   workflow advances pins via one rolling auto-merged PR on `auto/submodule-bump`.
   Triggers are `repository_dispatch` from submodule merges, a 30-minute cron
   backstop, manual `workflow_dispatch`, and monorepo `main` pushes changing
   submodule gitlinks; this continuation picks up deferred tips after a queued
   bump merges. **Do not file manual submodule bump PRs** — for an urgent bump,
   dispatch the workflow manually
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

- **intentd**: `cargo fmt --check`, `cargo clippy -- -D warnings`, the
  repo-slug fold lint, and `cargo build` — the monorepo-root `Makefile` wraps
  these as `make check` (fmt + clippy + repo-slug fold lint) and `make build`;
  run `make test` for the test suite.
- **cloudlands-fe**: `pnpm run check` and `pnpm vitest run`.
- **ios**: build + test targets passing.

### Local Rust gates

`make gate` runs `make check` followed by the full nextest suite. `make test`
runs tests only; `make test-changed` selects tests changed against `BASE`
(default `origin/main`) and falls back to the full suite for build-wide changes.

Opt in to smaller local build artifacts with:

```bash
COMPACT=1 make gate
COMPACT=1 make test-changed
make -C packages/intentd test COMPACT=1
```

Compact and ordinary gates support **Python 3.10+**. The runner uses a bundled
TOML 1.1 parser offline, including under `python3 -S`; no parser installation is
needed. Compact applies to the compiler steps in `check`, `test`,
`test-changed` and `gate`, and to `clippy` and `lint-sources`.
It sets `CARGO_INCREMENTAL=0` and dev/test profile `debug=0`, including discovered
package and build overrides. `strip=none` preserves the existing macOS
proc-macro workaround. Test selection, changed-test fallback and failure handling
are unchanged. Leaving `COMPACT` unset or setting `COMPACT=0` keeps ordinary
gate behavior; release profiles are unaffected.

These are Cargo profile/environment settings. Caller Rust flags are preserved
with Cargo's normal precedence, including `RUSTFLAGS`,
`CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_RUSTFLAGS` and target/build flags in Cargo
configuration. An effective explicit `-C debuginfo=2` can therefore retain debug
information, and `-C incremental=/path` can re-enable incremental artifacts even
though compact sets `CARGO_INCREMENTAL=0`. Conflicting flags reduce or remove the
storage benefit. Without those overrides, compact trades source-line backtraces
and debugger detail for smaller artifacts; disabling incremental compilation can
make rebuilds slower. It neither guarantees a disk bound nor deletes existing
targets or caches. Switching modes in one target directory may retain artifacts
from both; use a task-owned `CARGO_TARGET_DIR` when measuring or isolating builds.

`RESUME=1 make test` (or `make test-changed`) skips tests recorded as passed for
the same worktree and effective build settings; `GATE_FORCE=1` runs them again.
Use `COMPACT=1 RESUME=1 make test` to resume a compact run. Compact/default runs
have separate resume identities, including profile/incremental settings and
effective Cargo config contents, so switching modes cannot reuse the other
mode's passes. Records live under `GATE_CACHE_DIR` (default
`$HOME/.cache/intent/gate-runs`). `NO_FAIL_FAST=1`
continues past failures while preserving the nonzero exit status. `make gate`
always reruns its checks before the resumable test phase.

Coverage targets (`coverage-changed`, `coverage-e2e`, `coverage-all`) reject
`COMPACT=1` before instrumentation; run them with `COMPACT=0`. At the monorepo
root, even mixed goals such as `make test coverage-all COMPACT=1` reject before
any recipe runs. The unchanged `packages/intentd` forwarder invokes separate
root makes per goal: `make -C packages/intentd test coverage-changed COMPACT=1` may
run the noncoverage goal before rejecting coverage. It still never starts compact
coverage. Use separate invocations with the appropriate mode for each goal.

### Test attempt receipts and resume coverage

Every invocation that resolves a tree/plan identity creates a new attempt:

- Full suite: `GATE_CACHE_DIR/<tree-key>/attempts/<attempt-id>/`
- Changed plan: `GATE_CACHE_DIR/<tree-key>/changed/<plan-key>/attempts/<attempt-id>/`

Normal exits, handled failures and interruptions print `[<label>] record: <path>`.
A fully resumed run also creates and prints its new record, alongside
`resumed: skipped N tests already passed for this tree`; it has no child results
or new JUnit file. Failures before identity resolution have no attempt. SIGKILL
or daemon loss can prevent final output, so inspect the attempt directories.
An active attempt can update its own files; later invocations never rewrite its
bytes or replace its files, including unfinished attempts and legacy records.
Retention is unchanged: at startup the runner prunes whole tree directories
untouched for seven days; each invocation touches its tree directory. This is
not a separate seven-day lifetime for each attempt.

`run.json` records invocation settings, selections, membership, commands,
configuration paths and observed process statuses. Top-level `exit_code` is the
runner outcome. Each result's `native_exit_code` is the observed child wait
status (negative for a signal); its `exit_code` can remain null if streaming
raised even when cleanup reaped the child. For example, an interrupted runner
can return 143 while nextest returns 100 and writes cancellation JUnit.
`finished_at` and status fields remain null when unobserved. SIGKILL may leave
only an initial receipt and partial raw events, without `coverage.json`, JUnit,
a summary or a finish time; a later run does not invent those missing facts.

`coverage.json` is the test-membership and completion authority, not a Rust code
coverage report. It reconciles exact `[binary_id, test_name]` identities from
`listing-N.json`, `events-N.jsonl`, available JUnit and eligible historical
receipts. `run.json` counters and `summary.txt` are per-child diagnostics and may
count overlapping selections more than once. The report partitions `active`
into disjoint categories:

| Category | Meaning |
|---|---|
| `executed-passed` | Passed in this invocation with no failed or unfinished selection obligation |
| `resumed-passed` | Skipped using a compatible, directly traceable recorded pass |
| `ignored` | Skipped by the selection's ignored-test policy, not merely annotated ignored |
| `failed` | An observed failure in any required selection |
| `unfinished` | Selected but not fully accounted for, including interrupted work |

`inactive_filtered` lists identities excluded from every selection. An ignored
annotation alone does not determine the category: `--run-ignored all` can execute
annotated tests and `--run-ignored only` can skip ordinary ones. Overlap counts
once globally, but every selection must satisfy its own obligations. Inspect
`membership_complete`, `complete`, `errors` and per-selection `unfinished`;
a native zero exit alone cannot prove completion.

`resume_sources` references the shared journal's tree-relative `attempt`,
1-based `selection_index` and raw `event_line` for each credited pass.
Per-selection outcomes retain retry events and identify their source as `raw`,
`junit` or `suite-summary`. JUnit is `absent`, `validated`, or
`validated-partial`: the last means cancellation JUnit corroborates captured
passes and additionally records failures for known started tests whose terminal
stdout was not captured. Those JUnit-only failures invalidate prior pass credit
via `failure_evidence` with `source: junit`; they never manufacture positive
credit or raw event references. Missing JUnit does not erase reliable streamed
passes, but cannot supply unobserved completion. The generated tool config routes
JUnit to this attempt's `junit.xml` (full) or `junit-N.xml` (planned).

The tree's `passed.jsonl` and scope-level `complete` pointers are mutable
coordination state. Resume checks compatibility and raw evidence again;
a later failure invalidates earlier credit and completion. Legacy journal rows
or completion markers without verifiable attempt references cause conservative
reruns; old receipts are retained, not upgraded. A completed shortcut revalidates
its source and writes `kind: completed-resume`, `source_attempt` and each
selection's `evidence_attempt` in the coverage report. Its pass categories are
resumed, while native outcomes still belong to that referenced source attempt.

`make test-scripts` checks receipt/resume behavior using captured nextest fixtures
and tiny Python child processes; it needs Python 3.11+, without Rust, nextest or
initialized submodules.

## Filing issues

- Use the [issue forms](https://github.com/intent-hq/intent/issues/new/choose)
  (bug report / feature request) and pick the affected component(s). The forms
  set the issue **Type** (Bug / Feature / Task) — that field is the
  classification; do not add a `bug` or `enhancement` label.
- **Search first** — check existing open *and* closed issues and comment on or
  link an existing issue instead of filing a duplicate.
- Issues are triaged with `component:*` labels, the issue **Type** field, and a
  severity taxonomy that maps onto the issue **Priority** field (Urgent
  crash/data-loss, High broken feature, Medium degraded behavior, Low papercut)
  described in [docs/README.md](docs/README.md).

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
