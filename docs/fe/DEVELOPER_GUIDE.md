# Developer Guide

This guide reflects the current Intent repository layout and APIs as of package version `2.22.0`.

## Getting Started

### Prerequisites

- Node.js 24 (24.15.0+; 22.22.2+ and 26+ also work — node-gyp 13 builds node-pty during install and rejects older releases; `make doctor` checks this)
- Corepack with the repository-pinned `pnpm` version
- Git
- Auggie CLI for the default ACP provider workflow

### Install and Run

Agents on a remote daemon host should follow the root
[situate → act → observe → prove → hand-off loop](../../AGENTS.md#developing-on-a-remote-host).
The root section is the canonical operational recipe and health-hook source. This guide
documents frontend-specific behavior and implementation detail.

From the monorepo root, inspect the free port block the next sandbox start will use, then
start the fast component preview. The target installs locked frontend dependencies when
`node_modules` is missing or its installed lockfile no longer matches `pnpm-lock.yaml`.

```bash
make ports
make dev-sandbox-ui
```

`make ports` prints the free per-worktree `DEV_PORT`, `DEV_TCP_PORT`, `BRIDGE_PORT`, and
`CDP_PORT` block for the next start. Once a sandbox is running, its listener can move the
next free block; read the running port from `make sandbox-status` or
`.dev/sandbox/<mode>.json`. The sandbox passes the derived `DEV_PORT` to Vite, avoiding
collisions between concurrent workspaces. An explicit override remains available when needed:

```bash
make dev-sandbox-ui DEV_PORT=5291
```

From `packages/cloudlands-fe`, the equivalent fresh setup is:

```bash
corepack pnpm install --frozen-lockfile
DEV_PORT=5291 corepack pnpm run dev:ui
```

Choose the smallest launcher that includes the behavior under test:

- `dev:ui` starts the fast named-state component preview. It does not start Electron,
  native helpers, the daemon, or production application sagas.
- `dev:web` starts the complete browser renderer. Use it for browser behavior that needs
  the mock client or a daemon connection but does not need Electron APIs.
- `dev:cdp` starts the Electron development stack with Chrome DevTools Protocol support.
  Use it for main-process, preload, native, window, or Electron-shell work.
- `dev` starts the standard Electron development stack without the explicit CDP flow.

### Common Commands

```bash
corepack pnpm run dev:ui        # Fast named-state UI preview
corepack pnpm run dev:web       # Complete plain-browser renderer
corepack pnpm run dev           # Standard Electron launcher
corepack pnpm run dev:cdp       # Electron launcher with CDP support
corepack pnpm run build         # Production build
corepack pnpm run check         # Svelte + TypeScript checks
corepack pnpm run lint          # ESLint
corepack pnpm run format        # Prettier write pass
corepack pnpm run test:unit     # Vitest suite
corepack pnpm run test:playwright
```

For Loop A work against the installed daemon, use `make dev-sandbox-app`; use
`make dev-sandbox-stack` for an isolated intentd plus renderer. The stack daemon uses its
own user specialists folder (`$DEV_DATA_DIR/specialists`, recorded as
`userSpecialistsDir`), so specialist Settings edits and resets never touch
`~/.intent/specialists`. A daemon binary without `INTENTD_USER_SPECIALISTS_DIR` support
gets a startup warning and a `null` `userSpecialistsDir` instead. The first tunneled
hydration of a fresh, pre-warmed app takes roughly one to three minutes depending on host
load. Follow the root health wait and keep waiting if the splash remains.

### Open a Chat or Note in the App Sandbox

To check a change inside a real agent chat or note, open the workspace route with a
deep-link parameter instead of clicking through the UI:

```text
http://daemon.localhost:<DEV_PORT>/workspace/<workspaceId>?agent=<agentId>
http://daemon.localhost:<DEV_PORT>/workspace/<workspaceId>?note=<noteId>
```

Once the workspace has loaded, the page opens the note tab and/or the agent's chat tab
(both parameters may be combined; the chat ends up focused), then removes the parameters
from the address bar. Cross-workspace `intent://` note links use the same `?note=` URL.
Do not use `/agent/<agentId>`: it is a standalone legacy view that shows an empty
placeholder on a cold load, not the workspace chat panel.

With `make dev-sandbox-app` running against the installed daemon and the root health
wait finished, one `workspace_api` call opens and captures a chat in your own workspace
(`ws.note.list()` gives note IDs; any workspace and agent the daemon knows also work):

```javascript
const { id: workspaceId } = await ws.workspace.info();
const [agent] = await ws.agent.list();
const url = `http://daemon.localhost:<DEV_PORT>/workspace/${workspaceId}?agent=${agent.id}`;
const tabs = await ws.browser.listTabs("mine");
const tabId =
  tabs.find((t) => t.requestedUrl === url)?.tabId ??
  (await ws.browser.exec([{ action: "openTab", url }])).result.tabId;
return ws.browser.exec([
  { action: "evaluate", tabId,
    expression: "!!document.querySelector('[data-testid=chat-transcript-inner]')" },
  { action: "screenshot", tabId },
]);
```

`listTabs("mine")` reuses only your own tabs; another agent's tab at the same URL
refuses `evaluate` and `screenshot` (`not-owner`). While the first hydration runs, `evaluate` returns `false` (or the tab is still
mounting); retry from a background hook rather than reopening the tab. For a note, read
`document.querySelector('[data-note-content-surface]')?.dataset.noteContentState`
instead: `editor` (or `read-only`) means the note is loaded, `loading` means retry, and
`missing` usually means a wrong note ID and `error` a failed load. Save the screenshot with
`ws.note.saveAsset` and record it in the evidence table from the root
[`Prove`](../../AGENTS.md#prove) step. The browser tool cannot click, so to exercise a link
inside the chat, call `element.click()` on that anchor through `evaluate`; this runs the
app's real click handler, unlike calling the link handler directly.

### Remote Sandbox Internals

`scripts/dev-ports.sh` hashes the worktree's canonical path into one of 1,000 four-port
blocks beginning at 5200. The block assigns `DEV_PORT`, `DEV_TCP_PORT`, `BRIDGE_PORT`, and
`CDP_PORT` in order. If any derived port is busy, it selects the next completely free
block and prints the replacement; explicit overrides are validated and never remapped.

On readiness, each launcher atomically writes `.dev/sandbox/<mode>.json` with this schema:

| Field | Meaning |
|---|---|
| `mode`, `pid` | `ui`, `app`, or `stack`, and the owning sandbox process |
| `pidStartTime`, `pidCommandLine` | Process identity used to reject stale files after PID reuse |
| `devPort`, `tcpPort` | Resolved renderer and daemon TCP ports |
| `url`, `daemonLocalhostUrl` | Host-loopback URL and embedded-browser URL |
| `socket`, `intentdSource` | Daemon socket and `installed`, `bin`, `dev`, `release`, or `none` |
| `userSpecialistsDir` | Stack only: the daemon's isolated user specialists folder (`INTENTD_USER_SPECIALISTS_DIR`); `null` for `ui`/`app` |
| `startedAt`, `readyAt` | UTC lifecycle timestamps |
| `warm` | `{ok, ms}` readiness-gate result and duration |
| `supervisor` | Supervisor metadata when available; currently `null` |

The filename is keyed only by mode, not port or agent. A worktree can therefore track one
sandbox of each mode; starting a second same-mode sandbox overwrites that mode's identity.
Run `make sandbox-status` first and coordinate with the recorded owner, or use a separate
worktree.

Readiness also records `.dev/sandbox/<mode>.port` (`DEV_PORT=` and `DEV_TCP_PORT=` lines).
Unlike the state file, it survives every exit, so a supervised restart that starts with the
Makefile-derived ports reuses the recorded port when it is free and the tunnel URL stays
valid; an explicit `DEV_PORT=` override always wins, and `make sandbox-stop` forgets the
record. The port probe sets `SO_REUSEADDR` and treats only a live listener as busy —
`TIME_WAIT`/`CLOSE_WAIT` leftovers from a just-stopped sandbox are free — and a busy
explicit port is reported with the owning PID when it is visible.

`make sandbox-status` verifies recorded PIDs, removes stale files, and exits nonzero when
nothing is running; `SANDBOX_JSON=1 make sandbox-status` emits the live array. A clean exit
removes the owned file. `make sandbox-stop MODE=<mode>` owns unmanaged process trees and
uses TERM followed by KILL escalation. For a workspace service, use `ws.script.stop(id)`;
otherwise the external supervisor may restart the process.

App and stack enable the dev-only same-origin bridge. `GET /__sandbox/health` accepts only
loopback, same-origin requests and returns 200 only when `ok` is true, otherwise 503:

| Object | Fields |
|---|---|
| root | `ok` |
| `vite` | `ready` |
| `daemon` | `socket`, `reachable`, and optional `error` |
| `warm` | `moduleGraph`, `entriesWarm` |
| `git` | `sha`, `branch` |

The endpoint makes a bounded UDS connection. Before answering, it waits for Vite's active
warm-up requests to become idle and verifies the configured entries are in the client
module graph: the root layout, app page, and named-preview page. This endpoint is installed
only by the dev-server plugin, not production builds. The sandbox prints its single ready
line and writes state only after this gate succeeds; older frontend branches fall back to
socket and HTTP readiness probes.

`STATUS_JSON=1 make status` consumes these files and health responses into
`{setup, host, ports, sandboxes, repos, docs}`. `setup` is `{running, markers}`: `running`
is true while a `<worktree>/.intent/setup-<uuid>.sh` marker exists (the daemon keeps it
for the duration of the workspace setup script), and the human form then leads with a
provisional banner. It adds doctor gaps, `host.coverageTooling`
(`{ready, detail}` from the doctor's `[optional] cargo-llvm-cov` row; `ready` only when
cargo-llvm-cov and llvm-tools-preview are both present), submodule dirty and
ahead/behind state, the recorded gitlink `pin` with `gitlinkDirty` when the checked-out
submodule HEAD has moved off it, `behindOriginMain` (commits the checked-out submodule
HEAD lags the already-fetched local `refs/remotes/origin/main`; `null` when the submodule
is uninitialized or the ref is missing — no fetch is performed), and optional PR/check
summaries when GitHub authentication is available. `repos.monorepo`, listed first, describes
the root checkout itself: `gitState`, `gitErrors`, `branch`, `dirty` (submodule worktree
changes ignored), `ahead`/`behind`, `behindOriginMain`, `protocolDocsStale`, and
`protocolDocsChanged` — the `docs/protocol` paths `origin/main` changed since the merge-base
(`HEAD...origin/main`), so the branch's own protocol edits never count; `protocolDocsStale` is
`null` with `[]` paths when the ref is missing or has no merge-base with HEAD (for example a
shallow clone). Like `behindOriginMain`, it is relative to the last fetch. Human output adds a
`protocol-docs=` token and, when stale, a warning to read the contract with
`git show origin/main:docs/protocol/<file>` or update the branch, even when another monorepo
probe failed; a lag without protocol changes (or without a comparison) gets a milder hint. Each component includes `gitState`
(`absent`, `readable`, or `error`) and `gitErrors` (an array of `{probe, detail}` records,
empty unless a required probe fails). `absent` means its `.git` marker is missing;
`readable` means initialization, branch, HEAD, status, and parent pin probes succeeded.
A broken marker, dangling marker symlink, unreadable metadata, or failed/timed-out
required probe produces `error`, not a claim that the component is clean or absent.
`initialized` is `false` for a missing marker, `true` once Git confirms a worktree,
and `null` when initialization cannot be verified. A later failure preserves that
successful initialization and any other known observations. `dirty` and `gitlinkDirty`
are `null` when their required observations are unavailable; a failed parent pin lookup
also leaves `pin` null. Genuinely absent components retain `dirty: false` and
`gitlinkDirty: false` when the pin lookup succeeds. A successful lookup with no gitlink
(an independent clone) leaves `pin` null and `gitlinkDirty: false` once HEAD is readable.
Missing optional upstream/origin-main refs leave their counts null without making
`gitState` an error. Human output labels errors as `Git state unavailable`, names the
failed probes, and shows available worktree/pin comparisons explicitly. Diagnostic
`detail` strings have terminal escapes/control characters removed, whitespace collapsed,
and are limited to 240 characters each. Component probe errors keep the report's
best-effort exit code zero. The report is read-only, including stale sandbox state
and Git's optional index refresh (`GIT_OPTIONAL_LOCKS=0` for every Git probe).
The `ports` probe runs `scripts/dev-ports.sh` under `DEV_STATUS_PORT_TIMEOUT` seconds
(default 10, fractional allowed) and reports `{}` when that budget is exceeded. Every
other probe (doctor, sandbox status and health, git, gh) runs under
`DEV_STATUS_PROBE_TIMEOUT` seconds (default 10, fractional allowed); an exceeded budget
degrades that field (for example `sandboxes` becomes `[]`) without failing the report.
A knob value that is not a positive number of at most 86400 seconds is ignored with a
stderr warning and the default applies.

The shell suites are linted by `make lint-shell-sleeps` (part of `make check`): a fixed
`sleep <n>`, `time.sleep(<n>)`, or fixed-count poll loop in `scripts/*.test.sh` must wait
on an observable event instead, or carry `# timing-guard: <reason>` on its line or the
line above. `scripts/fixed-sleep-baseline.txt` grandfathers existing sites and only
ratchets down. The poll-loop rule tokenises line by line; its accepted blind spots
(multi-line arithmetic containing `<<`, a `case` pattern `done)`) are listed in the
header of `scripts/lint-fixed-sleeps.sh` and pinned by `scripts/lint-fixed-sleeps.test.sh`.

### Chat-motion performance traces

`pnpm perf:chat-motion` (in `packages/cloudlands-fe`) records a CDP trace of the chat
footer collapse/expand (`--scenario footer`, default) or context-well open/close
(`--scenario context-well`) against a running `make dev-sandbox-app` / `dev-sandbox-stack`,
then samples scroll geometry per animation frame. `--url` is a workspace page whose transcript
scrolls and whose footer shows its disclosure header (footer; agent-only event subscriptions render
no header and fail fast) or has a context well (context-well); `--out` must not exist. Optional: `--inflate <nodes>` (clone transcript rows
until the DOM reaches this count, 10000; donor rows need more than 20 descendants and under 2000 px
height, so a transcript rendering as one tall row fails — pass `--inflate 0` to skip), `--frames` (40),
`--scroll-up` (800 px), `--quiet-ms` (750), `--quiet-timeout` (15000), `--timeout` (180000), `--headed`
(default headless). Exit 0 writes `trace.json`, `summary.json`, `samples.json`, and screenshots
(`expanded.png` + `collapsed.png` for footer, `closed.png` + `opened.png` for context-well, plus
`scrolled-up.png`) into `--out` and prints the summary; exit 1 is a runtime failure; exit 2 is a
usage error, including an existing `--out` (`refusing to overwrite`, directory left untouched):

```bash
pnpm perf:chat-motion --url http://127.0.0.1:<DEV_PORT>/workspace/<id> --out .demo-artifacts/perf/footer-1
```

| Field | Meaning |
|---|---|
| `url`, `scenario`, `startedAt`, `nodeCounts.total` / `.transcript` | Run inputs, ISO start time, and DOM element counts after inflation |
| `motions.<mark>` | Trace events in the `windowMs` (400) after each user-timing mark (`collapse` / `expand` for footer, `open` / `close` for context-well): `taskCount`, `maxTaskMs`, `tasksOver16_7` (tasks over one 60 Hz frame), `maxUpdateLayoutTreeMs` / `maxUpdateLayoutTreeElements` (largest style recalc), `clicks`, `transitionFinishes` (offsets from the mark) |
| `scroll.<label>` | Per-frame geometry (`frames` sampled) for `pinned<Mark>`, `control`, `scrolledUp<Mark>` (e.g. `pinnedCollapse` / `scrolledUpExpand` for footer, `pinnedOpen` / `scrolledUpClose` for context-well): `beforeTop` / `afterTop`, `maxBottomGap`, `topRange`, `anchorDriftPx`, `anchorStayedConnected`, `toggled` (`true` for every toggle, `false` for `control`) |
| `quiescence` | `preTraceWaitedMs` (before the traced motions) and `waitedMs` (before the scrolled-up samples) spent waiting for scroll geometry to stay unchanged for `quietMs` |

Both quiescence waits and the no-toggle `control` exist because still-hydrating fixtures caused anchor
drift and unrelated long tasks in the [cloudlands-fe#2355](https://github.com/intent-hq/cloudlands-fe/pull/2355)
verification. The harness is report-only; judge against two clean runs. Negative control: inject a per-frame
layout thrash in the `disclosure-motion.ts` tick (~50 style-write / `scrollHeight`-read pairs; one forced read
is not enough), confirm `maxTaskMs` or `maxUpdateLayoutTreeMs` exceeds both clean runs, then revert before any gate.

## Fast UI Preview Workflow

After `make dev-sandbox-ui` prints `Sandbox ready:`, read its `devPort` from
`make sandbox-status` or `.dev/sandbox/ui.json` and open a named preview. `make ports`
shows the block the next start will use and may differ while this sandbox is running.
The examples below use `<DEV_PORT>` as the recorded running value:

```text
http://127.0.0.1:<DEV_PORT>/sandbox/button?state=default&theme=system&width=420&motion=full
http://127.0.0.1:<DEV_PORT>/sandbox/button?state=loading&theme=dark&width=420&motion=reduced
http://127.0.0.1:<DEV_PORT>/sandbox/button?state=disabled&theme=light&width=320&motion=full
http://127.0.0.1:<DEV_PORT>/sandbox/button?state=destructive&theme=dark&width=960&motion=full
http://127.0.0.1:<DEV_PORT>/sandbox/mention-agent-avatar?state=idle&theme=light&width=320&motion=full
http://127.0.0.1:<DEV_PORT>/sandbox/mention-agent-avatar?state=waiting&theme=dark&width=420&motion=reduced
http://127.0.0.1:<DEV_PORT>/sandbox/mention-agent-avatar?state=error&theme=system&width=420&motion=full
```

`theme` accepts `system`, `light`, or `dark`. `width` accepts an integer from 240 to
1600 pixels. `motion` accepts `full` or `reduced`. Keep the URL stable while you edit;
Vite hot module replacement updates the same tab.

The sandbox installs a small browser API. Run these expressions in the page:

```javascript
window.__INTENT_PREVIEW__.list();
await window.__INTENT_PREVIEW__.states("button");
window.__INTENT_PREVIEW__.current();
```

`list()` returns preview IDs. `states(id)` returns the named states for one preview.
`current()` returns the ready preview's slug, state, width, and status, or `null` while
no named preview is ready. Wait for `[data-preview-ready=true]` before inspection or
capture.

For a cold renderer launch, use the [self-checking readiness hook](https://github.com/intent-hq/cloudlands-fe/blob/main/.agents/skills/electron/SKILL.md#wait-for-renderer-readiness) instead of polling or rescheduling an expired hook.

For an agent, run the long-lived command through a workspace service script. Call
`ws.browser.listTabs` before opening the URL and reuse a matching tab. A new
`ws.browser.openTab` tab is hidden by default, but DOM, accessibility, evaluation, and
screenshot actions still work. Keep that hidden tab open during edits so Vite HMR can
update it. Call `ws.browser.showTab` only when a person wants to see it; pass
`focus: true` when it must also receive focus. Use
`http://daemon.localhost:<DEV_PORT>` in `ws.browser` URLs so the browser tool can
resolve a local or remote daemon correctly.

Run the focused avatar component test from `packages/cloudlands-fe`:

```bash
corepack pnpm run test:ct -- src/features/agent/components/agent-avatar/__tests__/agent-avatar-waiting.ct.spec.ts
```

The component-test harness defaults to port 3100; set `CT_PORT` to override it. A second
run on an occupied port waits for the `ct-<CT_PORT>` lock; pick a free `CT_PORT` to run
concurrently.

### Sandbox probe and shot options

These apply to `pnpm sandbox:probe` and `pnpm sandbox:shot` in `packages/cloudlands-fe`.

The sandbox route and Playwright CT harness use the repo-bundled `Inter Variable` font, and
capture stability waits for `document.fonts.ready`, so geometry does not depend on host fonts.
Shared options are `--theme light|dark|system` (default `light`), `--width 240..1600`
(default `720`), `--motion reduced|full` (default `reduced`), `--scale 1|2` (default
`1`), `--timeout <milliseconds>` (default `30000`), `--out <path>`, and
`--allow-console-errors`. Set `SANDBOX_DEBUG=1` for runner diagnostics.

The in-process server, like every `test/*.spec.ts` Vite harness, uses its own optimizer
cache under `node_modules/.vite-harness/<harness>` (via `test/vite-harness-cache.mjs`)
instead of the shared `node_modules/.vite`, so a probe never invalidates a running
`dev:ui` / `dev:web` server's optimized deps or vice versa. The runner fails fast with the
cause named — a `504 Outdated Optimize Dep` / `Optimize Deps Processing Error` on a module
URL, or an esbuild dependency-scan / optimizer failure from the dev-server log — instead
of a generic ready-marker timeout. `SANDBOX_GOMAXPROCS=<n>` exports `GOMAXPROCS` to the
esbuild service for that run; it is a diagnostic knob for the dependency-scan crashes in
intent-hq/intent#4617, not a fix, so leave it unset normally.

## Project Structure

The codebase is split across renderer features, Electron process code, shared types/utilities, and operational scripts.

```text
.
├── docs/                     # Product and engineering documentation
├── scripts/                  # Build, release, migration, and tooling scripts
├── src/
│   ├── features/             # Feature-first renderer modules
│   │   ├── agent/            # Agent lifecycle, orchestration, background tasks
│   │   ├── browser/          # Embedded browser tabs and browser tooling
│   │   ├── cdp/              # Chrome DevTools Protocol integration
│   │   ├── layout/           # Panel layout system and tab routing
│   │   ├── rules/            # User rules and rules IPC services
│   │   └── ...               # Many other product features
│   ├── lib/                  # Shared renderer utilities, services, stores, components
│   ├── main/                 # Electron main-process entry points and services
│   ├── preload/              # Electron preload bridge
│   ├── routes/               # SvelteKit routes and test pages
│   ├── shared/               # Cross-process config, types, constants, IPC contracts
│   └── test/                 # Test helpers, factories, and mocks
└── package.json              # Scripts, dependencies, and version metadata
```

When updating docs or adding features, verify which side of the app owns the behavior:

- `src/features/` for renderer-facing product logic
- `src/main/` for Electron and system integration
- `src/shared/` for contracts used by both sides
- `scripts/` for operational workflows such as release packaging and uploads

## Agent Creation and Integration

Use `agentFactory.createAgent(...)` for agent creation. The factory is the supported public entry point and normalizes agent config before backend creation.

```typescript
import { agentFactory } from "$features/agent/services/agent-factory";

const result = await agentFactory.createAgent(workspace, {
  name: "Review Changes",
  agentType: "task-loop",
  model: "haiku4.5",
  initialMessage: "Review the current diff and summarize the risks.",
  source: "workspace-initializer",
});
```

Important notes:

- Pass `agentType` so the backend can build the correct instructions.
- `CreateAgentOptions.systemPrompt` is deprecated; do not use it for new code.
- Valid `AgentTypeId` values include `chat`, `task-loop`, `workspace-agent`, `code-review`, `commit-message`, and `pr-description`.

## Panel Layout System

The workspace UI is driven by the `panel-layout` Redux slice (`src/store/renderer/slices/panel-layout/`), with `src/features/layout/panel-layout-adapter.ts` bridging layout operations for feature code.

Core ideas:

- Each workspace has its own layout state in the slice.
- Layouts are trees of panel nodes and split nodes.
- Split nodes can be horizontal or vertical.
- Each panel can host multiple tabs, with one active tab at a time.
- State includes focus tracking, pending focus, recently closed tabs, layout history, and focus history.
- Layout state is persisted so reopened workspaces restore their previous arrangement.

The main data model centers on:

- `WorkspacePanelLayout` for the full layout state
- `PanelState` for the tabs inside one panel
- `PanelTab` for the content metadata a tab needs to render

`PanelTab` carries type-specific identifiers such as `noteId`, `filePath`, `agentId`, `terminalId`, `diffPath`, and `browserUrl`, which let the UI route a tab to the correct feature component.

## Tab Types and Content Routing

The tab system is split into two layers:

1. `PanelTabType` in the panel-layout types (`src/store/renderer/slices/panel-layout/panel-layout-types.ts`) defines the allowed tab kinds.
2. `tabTypeRegistry` in `src/features/layout/tab-types/registry.ts` maps a tab type to its renderer component and UI metadata.

Each registered tab type provides:

- `type`
- `component`
- `icon`
- `defaultTitle`
- `categoryLabel`
- optional `sidebarTabId`
- optional `renameable`

`registerAllTabTypes()` currently registers the main built-in tabs used by the workspace UI:

- `browser`
- `terminal`
- `code-review`
- `agent-overview`
- `agent`
- `note`
- `file`
- `diff`
- `changes`
- `local-changes`
- `chat-changes`
- `activity-changes`
- `settings`
- `overview`

The broader `PanelTabType` union also includes workflow-oriented types such as `activity`, which are part of the routing model even when a specific registry entry is managed elsewhere or added later.

## Background Agents

Background tasks such as commit-message generation, PR description generation, and code review run through the `background-agent-executor` Redux slice (`src/store/renderer/slices/background-agent-executor/`) and its sagas.

Executor state tracked per run includes:

- `status`
- `messages`
- `result`
- `error`
- `progress`
- `agentId`

Background model selection is provider-aware. The `background-agent-settings` Redux slice (`src/store/renderer/slices/background-agent-settings/`) keeps:

- a default background-agent model
- per-type overrides for `commit`, `pr`, `review`, and `fast`

That allows the app to preserve different background-agent model preferences for different ACP providers.

## Provider System

ACP provider metadata is served by the daemon's `providers.catalog` RPC (monorepo [docs/protocol/methods/models-providers.md](../protocol/methods/models-providers.md) §5.38) — the single source of truth for provider identity, display names, CLI commands, default models, model tiers, and env-var/feature-code gating. There is no static provider table in the renderer.

At connect time the catalog is hydrated into the `providerCatalog` Redux slice (`src/store/renderer/slices/provider-catalog/`); renderer code reads it through the slice's selectors. Main-process call sites that cannot import the renderer store use the cached catalog accessor in `src/main/utils/provider-catalog-accessor.ts`.

Compound model ids (`provider:model`) are parsed with the pure helpers in `src/shared/utils/compound-model-id.ts`, with the catalog's default provider threaded in explicitly for bare ids.

The active provider is tracked in the `providerSettings` Redux slice; it starts empty and adopts the registry default when the catalog hydrates. When you add or update provider-sensitive UI, read the active provider and provider metadata from the store selectors rather than assuming Auggie is always selected.

## Testing and Validation

Use `pnpm` for frontend test commands.

```bash
pnpm run test:unit
pnpm run test:unit -- src/features/agent/__tests__/agent.test.ts
pnpm run test:unit:watch
pnpm run check
pnpm run lint
```

Tests and test helpers are spread across several areas of the repo:

- feature-level `__tests__` folders under `src/features/`
- Electron main-process tests under `src/main/__tests__/`
- shared tests under `src/shared/__tests__/`
- reusable mocks/factories under `src/test/`

The [transfer-selection fixture contract](../protocol/README.md#transfer-selection-fixture-contract)
defines the shared 32-case import-to-ModelPicker matrix. Its input schema tests run
from the monorepo root with `node --test scripts/check-transfer-selection-contract.test.mjs`;
`node scripts/check-transfer-selection-contract.mjs --inputs-only` validates the
matrix without a Rust build. Component harnesses must use `TRANSFER_SELECTION_FIXTURE_ROOT`
to locate the same inputs and daemon-generated public sessions, including from a
standalone checkout. Renderer tests must consume those full responses with real
identity/catalog selectors and assert the model label or Auto plus the absence of
warnings, fallback actions, model mutations and toasts. A hash check alone does not
establish daemon provenance; the connected gate must regenerate and compare outputs.

### Transfer-selection contract

From the monorepo root, with both component harnesses checked out and frontend
dependencies installed, run:

```bash
make test-transfer-selection-contract
```

This uses the maintained intentd Cargo exporter twice in a new temporary directory,
checks every normalized public response against the shared golden and actual source
revision, then passes the first fresh file directly to all 32 ModelPicker cases via
`TRANSFER_SELECTION_GENERATED`. It records full monorepo/component HEADs, both pins,
generator and consumed-file hashes. Both components must be clean and committed;
local feature heads are identified separately from caller-head/counterpart-pin runs.
It removes generated files, isolated Rust state and Node caches on success, failure,
and interruption. It never regenerates the checked-in golden. Unset
`TRANSFER_SELECTION_GENERATED` before invoking the connected target: selecting an
old file would defeat the regeneration proof.

`make consumer-checks` stays lightweight: its transfer-selection row validates shape,
coverage and provenance with Node only. The reusable component workflow runs the
connected target separately, on every successful checkout for both caller directions.
It verifies the caller's full `HEAD_SHA` and the counterpart's recorded pin before
building. A deleted/missing harness or stale response fails; there is no presence-based
skip. The existing warning on a failed monorepo checkout remains an outage exception,
not connected-test evidence. Standalone component jobs consume the checked-in golden
from one recorded monorepo main checkout; only the connected job proves freshness.

The initial introduction is staged: land the foundation contract/golden and lightweight
checks, then the daemon and renderer harnesses, wait for the automated pins, and only
then publish the separate connected-target/workflow activation. See the
[protocol rollout](../protocol/README.md#gate-rollout). Component CI continues using
main during that rollout; the reusable workflow uses its own resolved workflow commit.
To inspect prerequisites without building, run
`node scripts/test-transfer-selection-contract.mjs --preflight` at the activation
revision. Local selected-head success does not establish that earlier live pins pass.

### What verify:changed selects

The command runs scoped Prettier and ESLint,
related Vitest tests, colocated component tests that import the changed file directly or
through a host `.svelte` they import (one hop, `.svelte` imports only — a change to a `.ts`
module the host imports, or to a component two hops deep, does not select the spec), and
only the renderer/main/preload TypeScript boundaries that changed. Ambiguous or high-risk files
select a conservative suite instead of silently skipping coverage. Any code change (or a
`knip.jsonc` / `package.json` / `tsconfig*.json` change) also runs knip repo-wide (~3 s,
also chained into `pnpm run lint`): dead-code detection is a whole-program check, so it
cannot be scoped to changed files — dropping an import in one file can make an export in
another unused. knip resolves `m.*()` imports against the gitignored i18n bundle, so
`lint:dead-code` first runs `generate:i18n --if-stale`, which compiles only while the
bundle is missing or its recorded input hash no longer matches `messages/*.json`. The gate
fails when knip stops reporting its canary files
([details](../../docs/fe/DEVELOPER_GUIDE.md#changed-file-verification-receipts)).

Any renderer source change also runs `pnpm run test:ui-invariants` (chained into
`validate:architecture` too): the repo-wide UI ratchets and the component-catalog
`*.meta.ts` caller ledgers. Membership is derived, not listed:
`scripts/ui-invariant-suites.mjs` scans the vitest test files under `scripts/` and `src/`
(`*.{test,spec}.*`, minus the Playwright `*.ct.spec.*` / `*.visual.spec.*` suites), runs
every one whose leading comments carry `// @ui-invariant`, and fails when a test whose
parsed code (comments, string bodies, and regex literals never count) references
`buildUiComponentInventory` or imports a `*.meta` module and reads a `.callers` ledger has
neither that marker nor `// @ui-invariant-exempt: <reason>`. Add the marker to any new
inventory or ledger suite; `node scripts/ui-invariant-suites.mjs --list` shows the current
set and `--check` validates markers without running anything. Likewise, any code change
under `src/`, any `AGENTS.md` change (root or nested — `lint:instruction-themis-pins` scans
them all), and any edit to the `scripts/check-*.mjs` gates themselves also runs
`pnpm run lint:architecture` — the repo-wide static architecture scans CI runs through
`validate:architecture` (its only architecture step; new gates go into `lint:architecture`
in `package.json`, never into a separate workflow step, so local and CI cannot diverge —
`scripts/check-ci-architecture-gate.test.ts` fails on any other scanner or wrapper-script
step in `intent-pr.yml`, and an edit to that workflow runs it locally) —
because those scans are cross-file graph checks that per-file linting cannot see:
cloudlands-fe#2315 passed `verify:changed` locally and failed CI in
`lint:saga-watcher-ownership`. One of those gates, `lint:protocol-version-literals`, fails
any `src/` line carrying a `v`-prefixed version literal (`v10.1`), and a bare one (`10.1`)
when the same line mentions protocol/intentd/daemon(s): reference the method/field name,
the `§` section, or the capability, not protocol version numbers — they are provisional
until merge and went stale in cloudlands-fe#2447. A deliberate exception appends a
`// protocol-version-ok: <reason>` comment to the line, or puts
`// protocol-version-ok-file: <reason>` in the first 10 lines of a fixture-heavy file —
only a comment with a non-empty reason exempts; a bare token or one inside a string does
not. A
change to `scripts/type-check.ts` additionally runs `pnpm run type-check:validate`, since
`lint:architecture` omits that wrapper and the
per-boundary checks invoke `tsc` directly.

`vitest related` follows the import graph, so a suite that reads the tree from disk is
invisible to `verify:changed` (cloudlands-fe#2256 and #2314 both failed only on CI). Such a
suite declares its triggers in its leading comments —
`// @verify-changed-triggers: src/preload/index.template.ts, src/lib/components/**`
(repo-relative paths or globs; `./` and `../` entries resolve from the test file's
directory) — or opts out with `// @verify-changed-exempt: <reason>`; `// @ui-invariant`
suites are already covered by the renderer trigger. `pnpm run lint:verify-changed-triggers`
(in `validate:architecture`) fails an undeclared disk-reading suite. `src/preload/index.ts`
is untracked and generated by `pnpm run generate:ipc-channels` (run by `dev`, `build`, and
CI before it is needed), so a hand edit to it can no longer be committed by accident, and
the generator's guard rejects a locally edited copy on regeneration (cloudlands-fe#2314
edited it, and only CI caught it).

Only checks that genuinely conflict use host-wide locks, held for one check at a time:
Playwright CT uses `ct-<CT_PORT>` (default `ct-3100`) and the full Vitest fallback uses
`vitest-full`. CT runs on different ports can proceed concurrently — even within one
worktree, since the port keys the component server, the lock, and the
`playwright/.cache-<CT_PORT>` bundle cache; Svelte and TypeScript checks do not lock. The default waits are 240 seconds for CT and 120 seconds for full
Vitest. `VERIFY_CHANGED_LOCK_TIMEOUT_MS` overrides either wait but remains capped at
300000 ms, and the command never stops the process that owns a lock. Direct
`pnpm run test:ct` runs hold the same `ct-<CT_PORT>` lock (`scripts/verification-lock.mjs`),
because the CT runtime reuses any server already listening on its port — an unlocked
second run from another worktree would test that tree's component registry and then fail
with ECONNREFUSED when the first run exits (intent-hq/intent#4964). A second run on an
occupied port waits, then fails naming the owner's pid and worktree; pick a free `CT_PORT`
to run concurrently.

### Changed-file verification receipts

Each run prints `record: <path>` for its attempt under `.dev/verify-changed/attempts/`:
`run.json` holds the source, configuration, command and resolved-selection identities;
`results.jsonl` appends check outcomes and each unit file's result as it finishes; and
`coverage.json` lists every current check and resolved unit file per lane as
`executed-passed`, `resumed-passed` (with its source attempt), `failed` or `unfinished`.
The run passes only when every entry is satisfied. To continue after a failure or
interruption, rerun with `--resume`; never hand-pick stages. It reruns anything not
proven compatible. A configuration, lockfile, Node, Vitest setup or runner change voids
all credit. A non-unit check needs an identical command on identical sources. A unit
file keeps its pass unless the plan for the changes since then would select it (direct
edit, `vitest related`, declared trigger, UI invariant, full-risk fallback or deleted
module). Credit follows the file across lanes, so an edited test that moves from the
declared to the direct lane simply reruns there (cloudlands-fe#3439).
`--resolved-plan --resume` previews the continuation; `--max-unit-files` still bounds
the full resolved plan. Attempts untouched for seven days are pruned.

The dead-code gate runs knip through `scripts/check-dead-code.mjs`, which drops two
known-unused canary files under `src/lib/components/__knip-canary__/` for the run and fails when knip does not
report them — the masks fixed in cloudlands-fe#2695 (`.svelte` in vite
`resolve.extensions`, an `import.meta.glob` over the component tree, an unanchored
gitignore rule) had silently zeroed knip's Svelte coverage for months.

### Component test browser pin

CT keeps compiler/runner 1.58.2 and explicitly launches Chromium 153.0.8010.12
(revision 1243), supplied by the exact `ct-browser` alias for Playwright core 1.63.0.
`scripts/ct-browser.mjs` owns the checked identity, OS-specific executable resolution,
cache key and dependency marker. Install with
`node scripts/run-ct-tests.mjs --install-browsers chromium` (add `--with-deps` when
needed); `--print-browser-plan` reports the resolved plan. Use the same
`PLAYWRIGHT_BROWSERS_PATH` for installation and tests, including per-runner caches.
The shared fixture rejects missing installs and wrong `Browser.getVersion` results;
each attempt attaches `ct-runtime.json` with runner/browser versions and source hashes.
The two-line `playwright-core@1.58.2` patch backports error classification from
[Playwright PR 41868](https://github.com/microsoft/playwright/pull/41868), without
retaining or intercepting promises. This browser is an integration experiment for
intent-hq/intent#5481: the opt-in weak-inner-promise diagnostic still fails completion.

Traces use `retain-on-first-failure`: the original failed attempt survives a passing
retry. The opt-in `playwright-ct-evidence.config.ts` control requires a fresh
`CT_EVIDENCE_OUTPUT` directory and is expected to fail the strict flaky gate with
`--retries=1 --fail-on-flaky-tests`. The separate lifetime diagnostic config requires
`CT_LIFETIME_EXECUTABLE`, `CT_LIFETIME_VERSION` and `CT_LIFETIME_OUTPUT`; these
diagnostics are outside default discovery and do not change the ordinary pin.

### Component test fresh-context guard

Every CT spec imports `test` / `expect` from `src/test/ct-test.ts`. The module sets
`_optionContextReuseMode: 'none'` for the whole suite, so every test mounts into a fresh browser context: ct-core's
per-worker context reuse resets the page between tests, and that reset raced the next
`mount()` and surfaced as a pass-on-retry "Execution context was destroyed, most likely
because of a navigation" at the `mount(` line (intent-hq/intent#4373, #4783, #5236,
#5249, #5279, #5481). The cost is ~0.2 s per test (critical-path CI shard +10%), accepted
suite-wide; `CT_CONTEXT_REUSE=1` restores reuse for local wall-time measurement only and
is never set on CI. Two auto fixtures ride along:

- _Guard_: asserts via CDP that each test's `browserContextId` is new to the worker. A
  failure `browser context <id> was already used by an earlier test in this worker …`
  means reuse is back for the suite — typically a Playwright upgrade no longer honoring
  the private option, or `PW_TEST_REUSE_CONTEXT` in the environment — so fix the
  module, not the spec. A destroyed-context failure with the guard passing is therefore
  a residual incident to investigate, not one to quarantine or retry away.
- _Recorder_: on a failure it attaches `cdp-lifecycle.json` to the test's attachments in
  the HTML report (`playwright-report/`; nothing under `test-results/`), covering
  execution-context and navigation events from the moment the `page` fixture was ready
  — the leading `Runtime.executionContextCreated` entries replay contexts that already
  existed at attach. A `Page.frameRequestedNavigation` / `Runtime.executionContextsCleared`
  / `Page.frameNavigated` (to `about:blank` or the CT host) sequence just before the
  failing mount confirms a reuse reset; `Inspector.targetCrashed` is a renderer crash. No
  navigation or clear after attach is inconclusive, not exoneration — the recorded
  methods are a selection — so inspect a `DEBUG=pw:protocol` run or a trace before
  drawing a conclusion. The recorder never fails a test; a `cdp-lifecycle-recorder`
  annotation reports when it could not start or attach.

### Nightly browser-test reporting

All browser lanes retain JSON, HTML and traces for seven days; the nightly
manifest and per-lane outcomes distinguish missing reports from successful runs.
`nightly-browser-report.yml` processes every nightly/main manual completion,
including green runs with retries or quarantine failures. Its isolated writer
uses main's code and `MONOREPO_ISSUES_TOKEN` (central-tracker Issues write, with
permission to set Bug Type, labels and assignees). New issues go to
`intent-hq/intent`, owned by @panghy; matched issues retain their owners and human
text. Exact markers and complete open/closed issue/comment listings deduplicate
occurrences using each job's own attempt and completion time; retained shards
do not count again. Fixed regressions reopen, current duplicates follow their
canonical issue, and an explicit duplicate undo overrides old comments.
Not-planned closures stay closed with recurrence evidence. No green run
automatically closes an issue. Quarantine failures reuse an existing strong
match or an `issue`/`quarantine` annotation containing its tracking issue URL.
Missing reports or stale rerun evidence produce a separate CI incident.
Collection and publication bind the triggering attempt; a later source attempt
fails reporting with saved event/evidence-gap metadata instead of replacing it.
For read-only diagnosis, run
`node scripts/nightly-test-failures.mjs collect --run <id> --out /tmp/nightly-report`
(add `--attempt <n>` to pin the source attempt, or `--historical` for older/non-nightly artifacts).
`publish --out /tmp/nightly-report` previews issue actions; writes
require the trusted completion workflow. Its saved plan, receipts, summary and
original archives survive reporting errors; rerun that workflow after correcting
auth/API failures. Python 3 reads bounded ZIP members without extracting files.
Writers use GitHub's `concurrency.queue: max` to retain pending completions;
`.github/actionlint.yaml` ignores only actionlint's unknown-`queue` diagnostic for
this [documented key](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Debugging Notes

- `pnpm run dev:cdp` is the best default when working on browser/CDP features.
- Renderer-only issues usually live in `src/features/`, `src/lib/`, or `src/routes/`.
- IPC and desktop integration issues usually involve `src/main/`, `src/preload/`, and `src/shared/ipc` contracts.
- Release or packaging issues usually trace back to `scripts/` and `package.json` script wiring.

## Contribution Tips

1. Verify the owning feature area before editing code.
2. Use the existing store/service patterns instead of creating parallel abstractions.
3. Prefer extending typed contracts in `src/shared/` when behavior spans renderer and main.
4. Run the smallest relevant validation command before sending a change for review.
