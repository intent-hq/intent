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
on demand with `make ensure-ios-submodule`.
The durable engineering docs live in `docs/ARCHITECTURE.md` (backend architecture) and
`docs/protocol/` (canonical wire contract); see `docs/README.md` for the docs index.

## Developing on a remote host

Each Intent workspace is a git worktree on the daemon host. The desktop client runs the
embedded Chromium tabs and tunnels ports that listen on the daemon's loopback interface.
Always give the embedded browser `http://daemon.localhost:<port>` URLs; do not substitute
the host's address or a client-local forwarded port.

From the monorepo root, prepare the host and inspect this worktree's derived ports:

```bash
make doctor
make bootstrap-dev-host
make ports
```

`make doctor` reports required intentd and frontend tooling without changing the host.
`make bootstrap-dev-host` installs missing prerequisites after confirmation; automation
can opt into non-interactive installation with `BOOTSTRAP_YES=1`. The checks include
`pkg-config` and OpenSSL development headers, which a from-source intentd build requires
(`libssl-dev` plus `pkg-config` on Debian/Ubuntu). Re-run `make doctor` afterward and fix
every required gap. `make ports` prints stable per-worktree values for `DEV_PORT`,
`DEV_TCP_PORT`, `BRIDGE_PORT`, and `CDP_PORT`; explicit environment or command-line
overrides still win.

Choose the smallest long-running workspace service that covers the behavior under test:

- `make dev-sandbox-ui` — named component previews; no daemon or application sagas.
- `make dev-sandbox-app` — the complete web renderer against the installed Intent daemon,
  or against the socket supplied through `INTENTD_SOCKET`.
- `make dev-sandbox-stack` — an isolated intentd plus the complete web renderer. It builds
  intentd with the development profile by default; use `INTENTD_PROFILE=release` to opt
  into a release build, or `INTENTD_BIN=/path/to/intentd` to skip the build and run a
  prebuilt binary. Its data stays under this worktree's `.dev/intentd` directory.

Run the selected target as a workspace service and wait for this final line (app and
stack pre-warm Vite's module graph before printing it):

```text
Sandbox ready: http://127.0.0.1:<port>/  (open as http://daemon.localhost:<port>/ from the client)
```

Call `ws.browser.listTabs` first and reuse a matching tab; otherwise open
`http://daemon.localhost:<port>/` with `ws.browser.openTab`. A first tunneled open of a
fresh, pre-warmed app normally takes about 45–60 seconds to hydrate. Poll for the expected
DOM or accessibility content; if the splash is still visible, keep waiting instead of
restarting the service. Before module-graph pre-warming, a cold tunneled load took about
10 minutes. Keep the tab open for HMR, capture it with `ws.browser.screenshot`, and reveal
it for human review with `ws.browser.showTab`.

Remote browser sandboxes cannot exercise the Electron shell (Loop B), main/preload or
native-dialog behavior. `playwright-cli` is unavailable unless separately installed and
is not needed for the normal embedded-browser flow. Tunneled Chromium treats
`daemon.localhost` as a remote origin, so `workspace-file://` media do not load there;
they do load in Electron and must be verified in an Electron build. See the
[frontend Loop A recipe](packages/cloudlands-fe/AGENTS.md#dogfooding-a-dev-fe-against-a-daemon)
and [preview workflow](docs/fe/DEVELOPER_GUIDE.md#fast-ui-preview-workflow) for
component-specific details rather than duplicating them here.

**Security:** `dev-sandbox-app` and `dev-sandbox-stack` expose the full unauthenticated
daemon API on the Vite origin. Keep the server on loopback and access it only through the
Intent client's authenticated tunnel. Never bind a sandbox to `0.0.0.0` or expose its
origin directly to a network.

## Commit & PR Workflow

When changes span a submodule and the monorepo, land the submodule PR (Phase 1); the
monorepo pin advance (Phase 2) then happens automatically.

### Phase 1 — Submodule PRs

1. **Make scoped commits in the submodule** on a feature branch. Group related changes into
   logical commits with conventional commit messages (`feat:`, `fix:`, `chore:`, etc.).
2. **Push the feature branch** in the submodule repo.
3. **File a PR** on the submodule's repo (e.g., `intent-hq/intentd`).
4. **Merge the PR** (squash merge preferred) — **only after explicit permission from a
   human** (see Conventions → Merging). Approved + green checks is not enough.

When the change fixes a monorepo issue, reference it with the full cross-repo form —
`Fixes intent-hq/intent#N` — in the squash-commit message or PR body. GitHub
auto-closes the issue on merge, and the release notifier (see Release Process) comments
on it once a release actually contains the complete fix.

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
contents:write on `intent-hq/intent`), and are fail-soft: when the secret is absent
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
`intent-hq/ios`, plus contents:write and pull-requests:write on `intent-hq/intent`.
Like `INTENTD_RELEASES_TOKEN` / `MONOREPO_ISSUES_TOKEN`, it is fail-soft: when the
secret is absent the workflow logs a warning and exits successfully. The private
`packages/ios` submodule is best-effort — if its tip cannot be read, it is skipped
with a warning and never fails the run.

### Cross-component features (intentd + cloudlands-fe)

For features that need changes in both intentd and cloudlands-fe, development and PR
filing on both repos proceed fully in parallel — nothing serializes until merge time.
Both merges require explicit human permission (see Conventions → Merging), and the
only ordering constraint is the final merge: **do not merge the cloudlands-fe PR
(or arm auto-merge on it, or add it to the merge queue) until the intentd PR is
confirmed merged** — approved/green is not enough. This intentd-first rule applies
specifically to protocol changes (the daemon↔fe wire contract, `docs/protocol/`):
whenever a feature touches the protocol, the daemon side must land first.
Rationale: cloudlands-fe may depend on daemon
behavior/protocol that only exists once the intentd change has landed, so an fe-first
merge can break main or ship against a contract that doesn't exist yet. This rule is
about submodule PR merges, not monorepo bumps — after both are merged, the
auto-bump-submodules workflow advances both monorepo pins automatically (a single
rolling bump PR may cover both submodule refs); do not file a manual bump PR.

### Manual test builds for complex changes

For **complex features/fixes** (intentd and/or cloudlands-fe), pair the stacked PRs
with a manual test build **before merging anything**: dispatch cloudlands-fe's
`manual-signed-build.yml` on the cloudlands-fe PR branch to produce a manual `.dmg`
carrying the full stack, and hold all merges until that `.dmg` has been tested:

```bash
gh workflow run manual-signed-build.yml --repo intent-hq/cloudlands-fe \
  --ref <fe-pr-branch> -f build_macos=true -f intentd_ref=<intentd PR head SHA>
```

`intentd_ref` accepts any intent-hq/intentd git ref (full 40-char commit SHA, branch,
or tag) and compiles the intentd sidecar from source in-workflow; see
[docs/fe/DEPLOYING.md](./docs/fe/DEPLOYING.md#manual-signed-build-pr-test-builds).
**Complex cloudlands-fe-only changes** use the same route — omit `intentd_ref` to get
the pinned intentd — so PRs are not merged until the full stack is complete and a
manual `.dmg` is prepped for testing.

**Exception — SQLite schema changes:** features/fixes that add or change intent-store
migrations must **not** be tested via this manual-install route: running the
hash-built daemon applies its migrations and mutates the tester's local database,
with no rollback.

## Conventions

- **Conventional commits** are required. PR titles are validated by CI
  (`amannn/action-semantic-pull-request`) against: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `ci`, `perf`.
- **Never quote the literal breaking-change footer token.** release-please/release-plz
  treat `BREAKING CHANGE:` / `BREAKING-CHANGE:` (and `Release-As:`) appearing anywhere
  in a commit body as a real footer — a commit that merely *quotes* the token causes a
  false major bump (or, for `Release-As:`, a forced pinned version); this accidentally
  cut cloudlands-fe v3.0.0 — see intent-hq/monorepo#2988. Squash merges include every
  branch commit message in the squash body, so the token in any branch commit still
  lands on main. Never write the
  literal token in commit messages, PR titles/bodies, or review comments unless an
  actual breaking change is intended; when describing the mechanism, write "the
  breaking-change footer token" or similar instead.
- **Merging**: agents must **NEVER merge a PR, arm auto-merge, or add a PR to the
  merge queue — in this repo or any submodule repo — without explicit permission from
  a human**. Approved + green checks is not enough. Repo-owned automation is exempt
  (auto-bump-submodules, auto-pin-intentd, auto-cut-alpha, and the release PR
  workflows merge their own rolling PRs). All three repos (monorepo, intentd,
  cloudlands-fe) route `main` merges through a **merge queue** (squash method): once
  a human has given permission, `gh pr merge --squash` adds the PR to the queue, and
  the PR lands when the queue's gate passes — so merging no longer requires the
  branch to be up to date first, and there is no update-branch/re-check treadmill.
  In intentd and cloudlands-fe the queue runs CI on the actual merged tree
  (`merge_group` runs of the same required check) before landing; the monorepo
  ruleset has no required status checks, so its queue serializes merges but gates on
  nothing and lands entries without a CI run.
  `--auto` remains useful to enqueue once still-pending PR checks pass. A queue
  failure kicks the PR out of the queue (it does not land); fix and re-enqueue.
  When squash-merging, the commit title defaults to the commit message (or PR title
  as fallback), and the commit message includes all commit messages from the PR. On
  single-commit PRs, ensure the branch commit message is itself a valid conventional
  commit (amend auto-commits like "Coordinator" before pushing) to prevent
  non-conventional commits from landing on main (e.g., PR #102 incident).
- **Changelogs** are generated with `git-cliff` (see `cliff.toml`).
- **Rust**: run the package gates before opening a PR — `make check` / `make test`
  from the monorepo root; see `packages/intentd/AGENTS.md` → Gates. Coverage runs
  on CI (the `coverage-e2e` / `coverage-all` jobs in intentd's ci.yml) and can be
  reproduced locally with `make coverage-e2e` / `make coverage-all` — `make test`
  deliberately excludes these slow instrumented runs.

## Release Process

The full pipeline detail (workflows, secrets, dispatch types, fail-soft semantics,
guardrails) lives in [docs/RELEASING.md](./docs/RELEASING.md). The agent-facing rules:

- Releases are per-component and channel-based: merging a release PR publishes to the
  rolling **alpha** channel automatically; **beta** and **stable** are manual
  promotions of existing releases (no new build).
- The pipeline is fully automated and event-chained (intentd alpha publish →
  cloudlands-fe pin bump → chained fe alpha cut), with hourly crons as fail-soft
  backstops when an event link is missed.
- **Never file manual monorepo submodule-bump PRs or routine pin-bump PRs** — the
  workflows own pin advancement. For an urgent monorepo bump, dispatch the workflow
  instead (`gh workflow run auto-bump-submodules.yml`). The one sanctioned exception
  is the cloudlands-fe `intentd.version` pin under the emergency-release procedure
  in [docs/RELEASING.md](./docs/RELEASING.md).
- **Track shipped work**: a workspace that changed intentd and/or cloudlands-fe is NOT
  done when the PRs merge — monitor until the work ships in a cloudlands-fe alpha,
  then update the final workspace status message with the carrying version (e.g.
  "Shipped in cloudlands-fe vX.Y.Z (alpha)."). This applies to intentd-only changes
  too: they ride the chained cloudlands-fe alpha, and the version to report is the
  cloudlands-fe alpha — verify inclusion via `intentdVersion` in the published
  release's `release-manifest.json` on the
  [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases)
  distribution repo (same tag; cloudlands-fe source-repo releases carry no
  assets). Use background monitoring (`ws.pr.monitor` / `ws.hook.*`) — never
  block a turn polling.
- Monorepo-only work (docs, Makefile, CI, scripts) ships nothing to the alpha channel,
  so it needs no release monitoring or shipped-version status message.

## Filing Issues

When you encounter a bug or limitation while working on the codebase (including while
dogfooding intentd + cloudlands-fe for daily development work), file a GitHub issue on
[intent-hq/intent](https://github.com/intent-hq/intent/issues) — the single tracker
for all components.

- **Labels**: apply the appropriate `component:*` label (`component:intentd`,
  `component:fe`, `component:ios`) plus `agent-filed`.
- **Aggressive dedup**: search existing issues first
  (`gh issue list --repo intent-hq/intent --search "<keywords>" --state all`) and
  comment on / link the existing issue instead of filing a duplicate.
- **Cross-reference**: reference the issue number in related commits/PRs (e.g.
  `fix: correct panel focus (#123)`). In submodule PRs, use the full cross-repo form
  `Fixes intent-hq/intent#N` so the issue auto-closes on merge and the release
  notifier comments on it once a release contains the complete fix (see Release
  Process).

## Terminology

Do **not** use "wave" / "Wave N" terminology in committed documentation. It is
coordinator-internal vocabulary specific to a single agent's delegation flow and must not
leak into the repo. Describe progress as capabilities/milestones instead (e.g. "Repo & CI
bootstrap", "Crate skeleton", "Core + SQLite store", "UDS JSON-RPC slice").

## Local Setup

```bash
git submodule update --init --recursive   # skips the private packages/ios (update = none)
make doctor   # report gaps; BOOTSTRAP_YES=1 make bootstrap-dev-host installs missing prerequisites
make check
make test
```
