# Initial Porting — Breadcrumbs

A living progress log for the **initial port of Intent's backend to a headless Rust daemon** (`intentd`). This is the durable trail future agents read first to understand where the port stands, and append to as work lands.

See also: [IMPLEMENTATION_SPEC.md](./IMPLEMENTATION_SPEC.md) (target architecture), [PROTOCOL.md](./PROTOCOL.md) (wire contract), and the root [AGENTS.md](../../AGENTS.md) (workflow + breadcrumb-update policy).

## Goal

Port Intent's backend to a standalone, headless Rust daemon (`intentd`) speaking **JSON-RPC 2.0 over a Unix-domain socket**, local-first. Scope of **this** effort is the **Rust backend only** — no frontend (Tauri/Svelte) yet. The Electron app in `augmentcode/intent` is the behavioral ancestor; the wire contract is defined in PROTOCOL.md.

## Current submodule HEAD

- `packages/intentd` @ `b0ca816` (after Milestone 3 — Cycle B: ACP orchestration)

## Implemented surface so far

- **JSON-RPC methods (43 request methods + 1 server-initiated notification):** full CRUD across four domains plus the event surface over UDS, backed by SQLite —
  - `workspace.*` (9): `list`, `get`, `create`, `update`, `archive`, `unarchive`, `delete`, `markSeen`, `dismissAttention`.
  - `note.*` (12): `list`, `get`, `create`, `update`, `setContent`, `add`, `edit`, `editLines`, `updateMetadata`, `listTasks`, `readAsset`, `delete`.
  - `task.*` (8): `markAsTask`, `update`, `updateStatus`, `updateNoteStatus`, `getMyTask`, `createPrerequisite`, `assignAgent`, `convertBlocks`.
  - `comment.*` (5): `add`, `list`, `getThread`, `respond`, `delete`.
  - `event.*` (7): `recentFiles`, `agentActivity`, `workspaceSummary`, `directoryChanges`, `query` (query/aggregation), plus the deprecated singular `subscribe`/`unsubscribe` aliases.
  - `events.*` (2 + notification): the `events.subscribe`/`events.unsubscribe` subscription fast-path and the server-initiated `events.event` push notification.
- **Events:** append-only `Event` domain + event-type taxonomy (`intent-core`); durable append-only event log via the `0003_events` migration + `event_repo` (`intent-store`); in-process `EventBus` + filter engine with `subscriber_count` observability (`intent-services`); bidirectional UDS transport that pushes `events.event` and serves the `events.subscribe`/`unsubscribe` fast-path (`intent-transport`); a notify-based file watcher emitting debounced `file:changed` events (`intent-services`); and the M1 workspace/note/task/comment CRUD mutations now emit change events onto the bus.
- **CLI:** `intentd serve`, `intentd call`, `intentd status`, `intentd doctor` (verifies migrations are applied incl. the `0004` agent_session gate + reports provider discovery — which providers are installed/authed), and `intentd mcp-bridge --connect <addr>` (the stdio↔TCP MCP proxy referenced from a generated `--mcp-config`).
- **Transport:** JSON-RPC 2.0 router over UDS (newline-delimited, mode `0600`, stale-socket cleanup, SIGINT/SIGTERM handling), error codes `-32700`/`-32600`/`-32601`/`-32602`/`-32603`, plus server-initiated `events.event` notifications. UDS listener + control client are `cfg`-gated so non-Unix targets (Windows) build cleanly.
- **Persistence:** SQLite via `sqlx` with embedded migrations (WAL, `foreign_keys`, `busy_timeout`), incl. the `0002_comments` and `0003_events` migrations.
- **Tests:** end-to-end UDS lifecycle + events integration tests plus camelCase wire-parity fixtures.
- **ACP foundation:** provider registry + model resolution (`intent-providers`); ACP client core — subprocess spawn, hand-rolled NDJSON JSON-RPC transport, reader/dispatch loop, `initialize` handshake, session lifecycle (`new`/`load`/`prompt`/`cancel`) with `session/update`→event-bus streaming, client-served filesystem read/write, permission-request flow, and a terminal stub (`intent-acp`); the `AgentSession` entity + `agent_repo` persistence via the `0004_agent_session` migration; and the `WorkspaceApi` trait (`intent-core`).
- **ACP orchestration (Cycle B):** the `AgentManager` multiplexer + process registry (global concurrency cap + LRU idle eviction) wired into `cmd_serve` (`intent-services`); the agent→BE **MCP callback server** (`WorkspaceMcpServer`) over the same `Arc<dyn WorkspaceApi>` the FE uses, universal MCP-config translators (`toAcpMcpServers`/`toAuggie…`/`toCodex…`/`toOpenCode…`), baseline-env injection + secret redaction, and the per-agent-type tool denylist (§18.4) (`intent-acp`); the **`agent.*` RPC surface** (24 methods); and the **live MCP spawn-wiring** — `AgentManager::create_agent` stands up a per-agent denylisted MCP server, serves it over a loopback **bridge** (`intent-acp::mcp_bridge`: a TCP NDJSON listener + the `intentd mcp-bridge` stdio↔TCP proxy), and writes the generated `--mcp-config` so a real spawned child reaches the in-process server. Proven by a hermetic spawned-child **E2E** (the `mock` provider's node agent performs a real `add_to_note` MCP `tools/call`; asserts BE state change + streamed chunks + exactly one `agent:stream:end` + persisted conversation).

## Deferred / planned (NOT yet built)

- The remaining PROTOCOL methods (106 total in the contract).
- TCP / TLS / WSS transports, mDNS discovery, bearer-token auth.
- GitHub (octocrab), context engine, PTY, search.
- A real **auggie** end-to-end turn in CI: best-effort/local only (requires auggie + login). The hermetic mock-agent E2E is the CI gate; the generated `--mcp-config` + bridge are auggie-consumable.
- Transport panic-safety via `catch_unwind` → `-32603` (currently relies on per-connection `tokio::spawn` isolation).
- Event surface follow-ups deferred (verified parity-safe): `task:ready-tasks-changed` emission, saga-driven `workspace:*` events, and the `Event.metadata` field.
- `file:*` distinct-type modelling deferred to Milestone 8 (the watcher currently emits `file:changed`).
- The entire frontend (Tauri/Svelte).

## Milestone history

### Repo & CI bootstrap

Created two **private** GitHub repos (`cloudlands-ai/monorepo`, `cloudlands-ai/intentd`), a minimal intentd, the monorepo scaffold with `packages/intentd` as a submodule, CI workflows (fmt/clippy/test + 3-target build matrix + semantic-PR-title), and `cliff.toml`.

### Crate skeleton

Scaffolded all 12 crates (per IMPLEMENTATION_SPEC §3) as compiling stubs with §3.2 dependency direction enforced. Verified (`fmt`/`clippy`/`build`).

### Core + SQLite store

`intent-core` (ids, `Error` → JSON-RPC code mapping, `Config`/paths, `Workspace`/`Note` camelCase model, `WorkspaceApi` trait) and `intent-store` (SQLite via `sqlx`, embedded migrations, WAL/`foreign_keys`/`busy_timeout`, repositories). Verified @ submodule `41fd4a6`.

### UDS JSON-RPC slice

`intent-services` (concrete `WorkspaceApi` impl), `intent-transport` (JSON-RPC 2.0 router with the five standard error codes + UDS listener, mode `0600`, newline-delimited, stale-socket cleanup, SIGINT/SIGTERM) and the `intentd` CLI (`serve`/`call`/`status`/`doctor`). Integration test over a temp UDS. Verified @ submodule `2756eb4`.

### READMEs

README.md written for both repos (intentd + monorepo). intentd HEAD `8e13a25`.

### Breadcrumbs, docs index, `make dev`

This milestone: added `docs/00_initial_porting/BREADCRUMBS.md`, `docs/README.md`, the AGENTS.md breadcrumb-update policy, and a `make dev` local dev-stack target.

### Milestone 1 — core domain CRUD

Implemented full create/read/update/delete across the four core domains over UDS: `workspace.*` (9), `note.*` (12), `task.*` (8), `comment.*` (5) — 34 JSON-RPC methods total. Added the `0002_comments` SQLite migration (comment/thread model + repo), end-to-end UDS lifecycle integration test, camelCase wire-parity fixtures, a `doctor` migration-applied check, and `cfg`-gating of the UDS listener + control client so Windows (`x86_64-pc-windows-msvc`) builds cleanly. Spans `intent-core`, `intent-services` (incl. `note_ops`), `intent-store` (incl. `comment_repo`), `intent-transport`, and the `intentd` CLI. CI green on all three build targets (incl. Windows). Submodule HEAD `c989aeb`.

### Milestone 2 — Events

Ported Intent's event system to `intentd`. Added an append-only `Event` domain + event-type taxonomy (`intent-core`) and a durable event log via the `0003_events` migration + `event_repo` (`intent-store`). Built an in-process `EventBus` + filter engine with `subscriber_count` observability (`intent-services`), and extended the UDS transport to be bidirectional — server-initiated `events.event` notifications plus an `events.subscribe`/`events.unsubscribe` subscription fast-path (`intent-transport`). Added the seven `event.*` methods (`recentFiles`, `agentActivity`, `workspaceSummary`, `directoryChanges`, `query`, plus the deprecated singular `subscribe`/`unsubscribe` aliases), a notify-based file watcher emitting debounced `file:changed` events, and wired the M1 CRUD mutations to emit change events onto the bus. Deferred parity-safe: `task:ready-tasks-changed`, saga-driven `workspace:*` events, and `Event.metadata`; distinct `file:*` event types deferred to Milestone 8. CI green on all three build targets (incl. Windows). Submodule HEAD `3238a73`.

### Milestone 3 — Cycle A (ACP foundation)

Landed the **foundation half** of Milestone 3 — the ACP integration's lower layers, ahead of the orchestration half (Cycle B). Added two new crates: `intent-providers` (ACP provider registry — config loading, argument templating, model resolution) and `intent-acp` (ACP client core — subprocess spawn, a hand-rolled NDJSON JSON-RPC transport, a background reader/dispatch loop, the `initialize` handshake; session lifecycle `new`/`load`/`prompt`/`cancel` with `session/update` notifications fanned onto the event bus; client-served filesystem read/write, the permission-request flow, and a terminal stub). Added the `AgentSession` domain entity with store persistence (`agent_repo`) via the `0004_agent_session` migration, and the `WorkspaceApi` trait abstraction (`intent-core`). Accepted deviations: hand-rolled NDJSON transport (acp-tokio 0.11/0.14 incompatible with our dependency set), intentd-new `agent:permission:*` events (sanctioned by PROTOCOL §8), and a `name_explicitly_set` column. Orchestration — AgentManager, MCP callback wiring, the `agent.*` RPC surface, and the end-to-end flow — is the upcoming **Cycle B**. CI green on all three build targets (incl. Windows). Submodule HEAD `f5d2f8f`.

### Milestone 3 — Cycle B (ACP orchestration)

Landed the **orchestration half** of Milestone 3, closing the agent loop end-to-end. Added the `AgentManager` multiplexer + process registry (global concurrency cap + LRU idle eviction) wired into `cmd_serve`; the agent→BE **MCP callback server** (`WorkspaceMcpServer`) over the same `Arc<dyn WorkspaceApi>` the FE uses, universal MCP-config translators (ACP/auggie/codex/opencode/claude), baseline-env injection + secret redaction, and the per-agent-type tool denylist (§18.4); and the full **`agent.*` RPC surface** (24 methods). Wired live MCP **spawn-wiring**: `AgentManager::create_agent` stands up a per-agent denylisted MCP server, serves it over a loopback **bridge** (`intent-acp::mcp_bridge` — a TCP NDJSON listener + the `intentd mcp-bridge` stdio↔TCP proxy), and writes the generated `--mcp-config` so a real spawned child reaches the in-process server. Authored the deterministic **mock ACP agent** (node, gated by `MOCK_AGENT_SCRIPT_PATH`) and a hermetic spawned-child **E2E** that drives a full turn whose work is a real `add_to_note` MCP `tools/call` (asserts BE state change + streamed chunks + exactly one `agent:stream:end` + persisted conversation — not an in-process shortcut). Extended `doctor` with provider discovery (installed/authed) + an explicit migration `0004` gate. A real auggie turn in CI stays deferred (best-effort/local). CI green on all three build targets (incl. Windows). Submodule HEAD `b0ca816`.

## Next steps / open questions

- Continue expanding the JSON-RPC method catalog beyond the core CRUD + event surface, driven by PROTOCOL.md.
- Harden transport panic-safety (`catch_unwind` → `-32603`) before the full method catalog.
- Revisit transports (TCP/TLS/WSS) + auth + mDNS once UDS reads/writes are solid.

## Changelog

Append a dated entry (newest first) whenever a meaningful unit of porting work lands. Keep each entry concise: what changed, which crates/methods, and the resulting submodule HEAD.

- **2026-06-19** — Milestone 3 — Cycle B (ACP orchestration): `AgentManager` + process registry (concurrency cap + LRU eviction) in `cmd_serve`; agent→BE MCP callback server (`WorkspaceMcpServer`) over the FE's `WorkspaceApi`, universal MCP-config translators + baseline-env/redaction + §18.4 tool denylist; 24 `agent.*` RPC methods; live MCP spawn-wiring — `create_agent` writes the generated `--mcp-config` and serves a per-agent denylisted MCP server over the `intent-acp::mcp_bridge` (TCP NDJSON listener + `intentd mcp-bridge` stdio↔TCP proxy); the node mock agent (gated by `MOCK_AGENT_SCRIPT_PATH`) + a hermetic spawned-child E2E doing a real `add_to_note` MCP `tools/call`; `doctor` provider discovery + migration `0004` gate. Deferred: real auggie turn in CI (best-effort/local). Touched `intent-core`, `intent-acp`, `intent-providers`, `intent-services`, `intentd`. Submodule HEAD `b0ca816`.
- **2026-06-19** — Milestone 3 — Cycle A (ACP foundation): new crates `intent-providers` (provider registry, model resolution) and `intent-acp` (client core — spawn, hand-rolled NDJSON transport, `initialize` handshake; session lifecycle `new`/`load`/`prompt`/`cancel` with `session/update`→event-bus streaming; client-served fs + permission-request flow + terminal stub); `AgentSession` entity + `agent_repo` persistence via the `0004_agent_session` migration; `WorkspaceApi` trait (`intent-core`). Deviations: hand-rolled NDJSON transport (acp-tokio 0.11/0.14 incompat), intentd-new `agent:permission:*` events (PROTOCOL §8), `name_explicitly_set` column. Foundation half; orchestration (AgentManager, MCP callback, `agent.*` RPC, E2E) is the upcoming Cycle B. Touched `intent-core`, `intent-store`, `intent-services`, `intent-providers`, `intent-acp`. Submodule HEAD `f5d2f8f`.
- **2026-06-18** — Milestone 2 — Events: append-only `Event` domain + `0003_events` log migration/repo; in-process `EventBus` + filter engine; bidirectional UDS transport (server-initiated `events.event` + `events.subscribe`/`unsubscribe` fast-path); seven `event.*` methods (incl. deprecated singular aliases); notify-based file watcher emitting `file:changed`; M1 CRUD mutations now emit change events. Deferred parity-safe: `task:ready-tasks-changed`, saga-driven `workspace:*`, `Event.metadata`; distinct `file:*` types → Milestone 8. Touched `intent-core`, `intent-store`, `intent-services`, `intent-transport`, `intentd`. Submodule HEAD `3238a73`.
- **2026-06-18** — Milestone 1 — core domain CRUD: 34 JSON-RPC methods (`workspace.*` 9, `note.*` 12, `task.*` 8, `comment.*` 5) over UDS; `0002_comments` migration; e2e UDS lifecycle test + camelCase parity fixtures; `doctor` migration check; Windows `cfg`-gating. Touched `intent-core`, `intent-services`, `intent-store`, `intent-transport`, `intentd`. Submodule HEAD `c989aeb`.
- **2026-06-17** — Breadcrumbs, docs index & `make dev`: added breadcrumbs trail, `docs/README.md` index, and AGENTS.md breadcrumb-update policy. Docs-only (monorepo); submodule HEAD unchanged @ `8e13a25`.
- **2026-06-17** — READMEs: wrote README.md for both repos. Submodule HEAD `8e13a25`.
- **UDS JSON-RPC slice** — services + transport + CLI + integration test. Submodule HEAD `2756eb4`.
- **Core + SQLite store** — `intent-core` + `intent-store` (domain model + SQLite). Submodule HEAD `41fd4a6`.
- **Crate skeleton** — Full 12-crate skeleton with stubs; dependency direction enforced.
- **Repo & CI bootstrap** — repos, scaffold, submodule, CI, cliff.toml.
