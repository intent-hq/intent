# Contributing to Intent

Thanks for your interest in Intent!

## CI before and inside the merge queue

PRs run Linux metadata, formatting, static consumer contracts and workflow-policy
checks, plus each component's fast Linux correctness checks: intentd's `check`
(clippy, source lints, `cargo shear`) and `coverage-changed` (the PR's changed tests),
and the frontend's type/lint checks and unit tests. The queue reruns those on the
merged tree and adds the rest: native builds, full instrumented coverage, frontend
builds and integration tests, browser suites, and native runtime checks. In
particular, daemon lifecycle (Linux/macOS/Windows), Pi (Linux/Windows and both
supported Node versions), and PowerShell installer tests do not run on PR updates.

The frontend's path-selected browser and macOS fixture suites run in the queue;
validated release-only diffs keep their existing exemptions. Shared consumer checks
run static contracts on PRs and the connected Rust/frontend proof in the queue.
Monorepo runtime script suites and relevant clean-host bootstrap installation are
also queue checks. Manual diagnostics and scheduled maintenance remain available.

`CI Gate` remains required and rejects failed, cancelled, missing, or unexpectedly
skipped checks. A green PR gate means the code compiles, passes lint and passes its
changed or unit tests, and is ready for queued validation; it does not mean runtime
validation has completed.

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
(default `origin/main`) and falls back to the full suite for build-wide changes;
`make test-select E='<nextest filterset>'` runs just the matching tests.

These three (and `make test-intentd`, which `make test` runs, and the test
phase of `make gate`) default `INTENTD_TEST_TIMEOUT_MULTIPLIER` to `3`, the
value coverage CI and `make coverage-changed` already use, so tests'
hang-guard time limits stretch 3x. At 1x, a busy shared dev host makes correct
tests time out at budgets such as 15 s. The cost: a real hang takes 3x longer
to fail, and the few waits built from the multiplier take longer. A value you
set yourself wins unchanged, from the environment or the make command line:
`make test-select E='...' INTENTD_TEST_TIMEOUT_MULTIPLIER=1` checks the strict
budgets. Each run prints its multiplier (`[<label>] test time limits x3 ...`)
and records it in the summary and `run.json`. Resume credit is kept separate
per effective multiplier, so a pass at 3x never resumes a 1x run (or the
reverse); `3` and `3.0` share it.

Opt in to smaller local build artifacts with:

```bash
COMPACT=1 make gate
COMPACT=1 make test-changed
make -C packages/intentd test COMPACT=1
```

Compact and ordinary gates support **Python 3.10+**. The runner uses a bundled
TOML 1.1 parser offline, including under `python3 -S`; no parser installation is
needed. Compact applies to the compiler steps in `check`, `test`,
`test-changed`, `test-select` and `gate`, and to `clippy` and `lint-sources`.
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

#### Parallel compiler front end

Opt in to rustc's multi-threaded front end for local debug builds with:

```bash
PARALLEL=1 make build
PARALLEL=1 make check            # also clippy, lint-sources, gate
PARALLEL=1 make test-changed     # also test, test-select
PARALLEL=1 PARALLEL_THREADS=4 make build
```

It sets `RUSTC_WRAPPER` to `scripts/rustc-parallel.sh`, which adds
`-Zthreads=$PARALLEL_THREADS` (default 8) and `RUSTC_BOOTSTRAP=1` only to rustc
invocations for crates under `packages/intentd`. Registry and git dependencies,
their build-script probes and Cargo's `-vV`/`--print` probes run unchanged, so
dependency feature detection matches CI. A global `RUSTC_BOOTSTRAP=1
RUSTFLAGS=-Zthreads=8` would instead turn on nightly-only code in `anyhow`,
`thiserror` and `proc-macro2`; do not use it.

Measured on intentd at 1.96.0 (32-core shared host, paired against the default):
clean debug builds are about 35–40% faster; rebuilding after an
`intent-services/src/lib.rs` body edit is about 25% faster incremental and about
40% faster with `CARGO_INCREMENTAL=0`; edits to small crates and the link-heavy
`cargo test --no-run` gain little (≈0% and ≈10%). It costs 15–30% more total CPU
and 1–2 GB more peak memory per rustc process, so lower `PARALLEL_THREADS` (or
leave it off) on machines with little RAM. The nightly matching 1.96 crashed
incremental `intent-services` rebuilds even without threads, so use the pinned
stable toolchain, not nightly.

Only `PARALLEL=1` enables it; any other value, including an unrelated
`PARALLEL` from GNU parallel, is ignored. Release, coverage and other goals
reject `PARALLEL=1` before any recipe runs, and both the Makefile and the
wrapper refuse to run when `CI` or `GITHUB_ACTIONS` is set: CI and release
builds never use it. A `RUSTC_WRAPPER` you set in the environment (for example
`sccache`) is chained after the wrapper, but a `rustc-wrapper` from Cargo
configuration is bypassed while `PARALLEL=1` is on; set `RUSTC_WRAPPER=sccache`
explicitly to keep it. Resume records for `make test` are kept separate per
thread count. A compiler crash under `PARALLEL=1` should be retried without it
before it is reported.

#### Linux x64 callback gates

The full Rust suite uses the canonical ACP callback adapter fixture, which currently
supports **Linux x64 only**, with the descriptor's exact Node version. Native
macOS callback gates are not supported. Mac contributors can run the full gates on
an **existing authorized Linux x64 host** (for example, their Intent daemon host).
Use that host's normal access method; the commands below run in **Bash on Linux**,
not in the Mac terminal. This recipe does not create a host or install a native
provider. The callbacks exercise the frozen adapter/SDK with a scripted query
process, without provider credentials or a native Claude login.

Start with a complete monorepo checkout on Linux at the revision you intend to
validate. For a new checkout, replace the revision below with its full commit SHA:

```bash
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
  echo "Run this recipe on the authorized Linux x64 host." >&2
  exit 1
}
git clone https://github.com/intent-hq/intent.git intent-linux-gates
cd intent-linux-gates
git checkout --detach "<intended-monorepo-commit>"
git submodule update --init --recursive
git rev-parse HEAD
git submodule status
make bootstrap-dev-host
make doctor
```

The recorded gitlinks select the component revisions; do not advance them to
latest main or copy a Mac `node_modules` directory. Private iOS is intentionally
skipped. When testing an unmerged component change, use its reviewed branch/SHA
in this isolated checkout and record that SHA too; no manual pin-bump PR is needed.
Keep the monorepo's `docs/protocol/fixtures/transfer-selection` intact: full gates
also validate those canonical fixtures before Cargo and pass their path to tests.

Bootstrap supplies the repository Rust pin (with rustfmt/Clippy), nextest and host
prerequisites. Use **Python 3.10+** for the gate runner, even if doctor's host-status
minimum is lower. Bootstrap checks the frontend's supported Node range; it does
not promise the callback descriptor's exact version. Activate that exact Node
version using the host's existing tool manager or installed toolchain, put its
`bin` directory on `PATH`, then check it below. The descriptor currently pins
Node `v24.21.0`, npm `11.19.0` and TypeScript `6.0.3`; the checked-out descriptor is
the authority. An available npm launcher is required for the source route; the
provisioner obtains its pinned npm privately when necessary and installs the
locked TypeScript dependencies without package lifecycle scripts.

Continue in the same Linux shell from the monorepo root:

```bash
set -euo pipefail
python3 -I -B -S -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'
callback_node=$(python3 -I -B -S -c 'import json; print(json.load(open("packages/intentd/crates/intent-acp/tests/fixtures/claude-callback-adapter.json"))["tools"]["node"])')
[ "$(node --version)" = "$callback_node" ] || {
  echo "Activate descriptor-pinned Node $callback_node on this Linux host first." >&2
  exit 1
}
command -v npm

# New private directory: this run must build, not reuse an existing fixture.
callback_run=$(mktemp -d "$HOME/intent-callback-gates.XXXXXX")
callback_cache="$callback_run/cache"
printf 'Keep setup logs and test receipts under %s\n' "$callback_run"
# env -u NODE_OPTIONS: the provisioner refuses host Node preloads (e.g. a
# monitoring tracer injected into every shell); the gates clear it themselves.
INTENT_ACP_CALLBACK_ADAPTER_FIXTURE=$(env -u NODE_OPTIONS python3 -I -B -S \
  packages/intentd/scripts/prepare-acp-callback-fixture.py \
  --cache-dir "$callback_cache" --build-from-source \
  2>"$callback_run/source-build.log")
export INTENT_ACP_CALLBACK_ADAPTER_FIXTURE

# Revalidate the same cache without acquisition; stdout is only the fixture path.
callback_offline=$(env -u NODE_OPTIONS python3 -I -B -S \
  packages/intentd/scripts/prepare-acp-callback-fixture.py \
  --cache-dir "$callback_cache" --offline \
  2>"$callback_run/offline.log")
[ "$callback_offline" = "$INTENT_ACP_CALLBACK_ADAPTER_FIXTURE" ]
make check-callback-fixture check-transfer-fixture

GATE_CACHE_DIR="$callback_run/gate-runs"
export GATE_CACHE_DIR
make gate 2>&1 | tee "$callback_run/gate.log"
```

The explicit source build needs network access to the descriptor's pinned upstream
archive and npm registry. It verifies archive, patched source, lockfile, packed
artifact and runtime inventory before publishing a ready cache. Keep assignment
and `export` separate as above: `export VAR=$(...)` hides a failed provisioner's
exit status. With `set -euo pipefail`, preparation or gate failure stops the recipe
and remains a failure even through `tee`. Inspect the retained log before retrying.

For later runs, reuse the saved `callback_cache` path with `--offline`, assign and
export its returned fixture path, and rerun preflight. With the fixture variable
unset, `make test`, `make test-changed`, `make test-select` and `make gate` do this themselves for a
ready cache under `~/.cache/intent/acp-callback-fixture`, and gate preflight hides
host `NODE_OPTIONS` (such as a Datadog preload) from its checks. An empty offline cache
refuses; it never downloads. Corrupt caches, mismatched manifests/Node and injected
`NODE_OPTIONS` refuse too when you run the prepare script directly, so prefix it with
`env -u NODE_OPTIONS` on such hosts. Do not bypass validation or edit a ready cache to make it
pass. The optional `--bundle /path/to/pinned-bundle.tar.gz` route requires an
independently supplied matching local bundle; no published download URL exists.

`make gate` includes the full `make test` phase; do not repeat a successful suite.
Use `make test` when only tests are needed, or `RESUME=1 make test` to continue an
interrupted attempt with the same source/settings. The gate owns caller assertions
and validates fixtures before Cargo or resume credit. Keep the printed `record:`
path under `$GATE_CACHE_DIR` with `gate.log`, `source-build.log` and `offline.log`;
[attempt receipts](#test-attempt-receipts-and-resume-coverage) describe how to inspect
completion and failures. A preflight/check failure before the test phase has no
nextest attempt receipt. A callback-only pass does not establish a full-gate pass;
retain unrelated failures as failures.

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

Partial resume requires cargo-nextest 0.9.133 or newer. Receipt schema 3 stores
resumed identities in a tool-owned test group in the attempt's TOML, so large
histories do not exceed OS command-line limits. Only resumed tests change groups;
project default filters, user filter unions and pending tests' settings remain
in effect. The generated config and `make doctor` enforce the minimum version;
`make bootstrap-dev-host` upgrades older installations (or run
`cargo install cargo-nextest --locked`). Receipt schemas 1 and 2
remain readable under their original command/config validation, without rewriting
their files or weakening the tree fingerprint.

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

### Local Rust compiler cache

Install sccache 0.17 or newer and point it at the team's self-hosted cache
([runbook](docs/SCCACHE_SERVER.md)) with the **read-only** token, which a
maintainer shares with you out of band:

```bash
export SCCACHE_WEBDAV_ENDPOINT=https://172.96.141.217
export SCCACHE_WEBDAV_TOKEN=<read-only-cache-token>
export SCCACHE_WEBDAV_RW_MODE=READ_ONLY
make build
```

`make build` uses the configured cache when `sccache` is on `PATH`; otherwise it
builds normally. An explicitly set `RUSTC_WRAPPER` (including an empty value)
takes precedence. Keep tokens out of tracked files. If changing the endpoint
or credentials while a local sccache server is running, stop that server first
with `sccache --stop-server` so the next build picks up the new environment.

CI writes to the same cache with its own read-write token (see
[docs/RELEASING.md](docs/RELEASING.md)); its `INTENT_SCCACHE_*` settings apply
only to CI jobs. Local builds get the read-only token so developer machines
cannot write into the shared cache. sccache keys include absolute
paths, so a local build only hits entries compiled at the same checkout path;
expect a low hit rate unless your path matches a CI runner's.

### Bash 3 compatibility checks

The `shell-tests-bash3` CI job runs on GitHub-hosted Linux with a checksum-verified
Bash 3.2.57 build. It tests the shell language compatibility needed by macOS
users without consuming a macOS runner. CI runs the shell suites only in the
merge queue, so a local run is the only check before a 3.2-only breakage ejects
the PR. Run it before opening a PR that touches `scripts/*.sh`:

```bash
make bash3   # one-time build (a few minutes; make bootstrap-dev-host installs gcc, make and bison)
REQUIRE_BASH3=1 bash scripts/consumer-checks.test.sh
```

`make bash3` builds the same pinned interpreter into
`${XDG_CACHE_HOME:-~/.cache}/intent-bash3` and does nothing once it is built.
Export `BASH3_CACHE_DIR` (an absolute path) to move the cache. The suites find
the cache through the shared lookup in `scripts/find-bash3.sh`, so `BASH3_BIN`
is only needed for an interpreter elsewhere. On macOS the stock `/bin/bash` is
already 3.2, so the target builds nothing. Without `REQUIRE_BASH3`, a missing interpreter is a skip
notice rather than a failure. `scripts/dev-sandbox.test.sh` has no lookup and
must be started by the interpreter itself, as CI does:
`REQUIRE_BASH3=1 DEV_SANDBOX_TEST_STARTUP_ONLY=1 ~/.cache/intent-bash3/bash scripts/dev-sandbox.test.sh`.
The interpreter is isolated; the build does not replace the system shell.

### Script checks for your change

CI runs the shell suites only in the merge queue, so a broken suite or a new
shellcheck finding otherwise shows up after a push. Before pushing changes to
`scripts/`, the `Makefile` or `.github/workflows/ci.yml`, run:

```bash
make test-scripts-changed            # changed vs origin/main, incl. uncommitted work
DRY_RUN=1 make test-scripts-changed  # print the plan only
BASE=<ref> make test-scripts-changed # compare with another base
```

It always runs `make lint-shell`. It runs every suite in the ci.yml
`shell-tests` job (read from that job, so the lists cannot drift) when the
`Makefile`, `ci.yml`, `scripts/*.sh`, `scripts/*.py` or `scripts/fixtures/`
changed. For each changed `scripts/*.mjs` with a sibling `.test.mjs`, it runs
that test with `node --test`. Every step runs; the failures are listed at the
end. Like CI it needs node, shellcheck and the `packages/intentd`
submodule. It skips the Bash 3.2 pass (see above) and the sccache and runner
steps that download tools.

After editing anything under `.github/`, run `make lint-workflows`. It runs the
pinned actionlint (with shellcheck over `run:` scripts) over
`.github/workflows`, and CI's `workflow-lint` job runs the same check on every
PR. Main is kept finding-free, so a finding in a file you touched is new: fix
it, or add a path- and message-scoped ignore to `.github/actionlint.yaml` for a
confirmed false positive. (shellcheck is not pinned, so a newer local copy can
flag an untouched workflow that CI's does not.) `make bootstrap-dev-host` installs actionlint and shellcheck.
