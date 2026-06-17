# Intent Rust Backend — Engineering Implementation Spec

> Status: Design / pre-implementationAudience: Rust engineers building the standalone backend daemon (intentd).Companion document: ./PROTOCOL.md — the wire-protocol reference(transport, JSON-RPC envelope, full method catalog, events, FE thin-client guidance).This document is the engineering spec: architecture, crates, modules, persistence,ACP/GitHub/context integration, deployment, testing, and a phased plan.

This spec describes a standalone **Rust backend (daemon + CLI)**, codename `intentd`,that orchestrates AI coding agents over **ACP (Agent Client Protocol)**, exposes a**JSON-RPC 2.0 API** over WebSocket / Unix-domain-socket, talks to **generic GitHub**(not Augment's proxy), optionally uses the **auggie/Augment context engine**, and**owns nearly all application state** so a future **Tauri/Svelte frontend can be extremelythin**. It is a port of the proven blueprint already living inside the Intent Electron app.

## Table of Contents

1. [Overview, Goals, Non-Goals](#1-overview-goals-non-goals)
2. [Reference-Architecture Mapping (Intent TS → Rust)](#2-reference-architecture-mapping-intent-ts--rust)
3. [Crate / Module Layout](#3-crate--module-layout)
4. [Recommended Crates + Cargo.toml Sketch](#4-recommended-crates--cargotoml-sketch)
5. [Transport & Deployment](#5-transport--deployment)
6. [ACP Integration](#6-acp-integration)
7. [Source Control (provider-agnostic; v1 GitHub via octocrab)](#7-source-control-provider-agnostic-v1-github-via-octocrab)
8. [Context Engine](#8-context-engine)
9. [State Model & Persistence](#9-state-model--persistence)
10. [Events](#10-events)
11. [Error Handling, Logging, Config, Security](#11-error-handling-logging-config-security)
12. [Terminal & Script Execution (unified, locality-aware)](#12-terminal--script-execution-unified-locality-aware)
13. [Testing Strategy & Phased Roadmap](#13-testing-strategy--phased-roadmap)
14. [Search (BE-owned)](#14-search-be-owned)
15. [Drafts (BE-persisted)](#15-drafts-be-persisted)
16. [Stable Client Identity (client.hello)](#16-stable-client-identity-clienthello)
17. [Code Changes Review (BE-owned review loop)](#17-code-changes-review-be-owned-review-loop)
18. [Agent Ecosystem (rules, specialists, MCP servers, tooling)](#18-agent-ecosystem-rules-specialists-mcp-servers-tooling)
19. [Integrations & Ops (usage metrics, session stats, worktree setup)](#19-integrations--ops-usage-metrics-session-stats-worktree-setup)

## 1. Overview, Goals, Non-Goals

### 1.1 What we are building

`intentd` is a long-lived local daemon that is the single source of truth for Intent'sdomain model. Clients (a Tauri/Svelte desktop UI, a mobile app, a CLI, or another agentacting as an MCP client) connect over a JSON-RPC 2.0 API and drive everything: workspaces,notes, tasks, comments, agents, git, pull requests, scripts, terminals, files, and events.

The daemon embeds:

- A **JSON-RPC router** serving the full method catalog (see `PROTOCOL.md`), reusing oneset of **service** implementations across every transport.
- An **ACP client** that spawns provider CLIs (auggie, claude-code, codex, droid,opencode, cortex) over piped stdio and multiplexes many concurrent agent sessions.
- An **MCP server** exposed *back to* the agents so an agent can call the same workspaceAPI the FE uses (`note.*`, `task.*`, `agent.delegate`, …) — the agent→BE callback loop.
- A **provider-agnostic source-control** client (the `SourceControl` trait; v1 impl`GitHubSourceControl` via octocrab) for PR/issue/review/check-run/mergeability.
- An optional **context engine** abstraction whose only current implementation shells outto `auggie`, degrading gracefully when unavailable.
- A **persistence layer** (SQLite + a file tree) that owns all durable state.
- An **event bus + append-only event log** delivered to subscribers as JSON-RPCnotifications.

### 1.2 Goals

| # | Goal |
| --- | --- |
| G1 | Thin-client enablement — the BE owns all state; FE holds only ephemeral UI state. |
| G2 | Transport parity — identical service logic over UDS, TCP/TLS, and SSH-tunnel. |
| G3 | Protocol fidelity — JSON-RPC method catalog matches websocket-protocol-handler.ts. |
| G4 | Provider-agnostic agents — any ACP-compliant CLI works via a config/quirks table. |
| G5 | Vendor-neutral GitHub — generic GitHub REST/GraphQL via a user token, no proxy. |
| G6 | Graceful degradation — missing context engine / GitHub token never crashes the daemon. |
| G7 | Operational robustness — single-flight start/stop, graceful shutdown, heartbeats, idle reaping. |
| G8 | Local-first security — UDS by default; TLS + bearer + origin allow-list for LAN. |

### 1.3 Non-Goals

- **No bundled LLM / no model hosting.** Models live behind provider CLIs.
- **No separable code indexer.** Retrieval is delegated to auggie; we do not build an index.
- **No Augment proxy.** GitHub access is generic; we explicitly diverge from Intent's proxy.
- **No UI.** The FE is a separate deliverable; this daemon ships headless + a CLI.
- **No multi-tenant cloud service.** Single-user, single-host (LAN-reachable) is the target.
- **Not a 1:1 internal-API clone.** We port *observable behavior* and the *wire protocol*,not Electron/Redux internals.

### 1.4 Source blueprint (`augmentcode/intent`)

> Path convention. All src/... paths in this document refer to files in the**augmentcode/intent** GitHub repository. Path citations are kept verbatim so readerscan open the exact source files.

The Intent Electron app already implements this architecture in TypeScript. The Rust portmirrors it. Primary references (all paths verified to exist in the `augmentcode/intent`repository):

- `src/main/websocket-api-server.ts` — HTTPS server on `0.0.0.0`, `/ws` endpoint, bearerauth on upgrade, 30s/60s heartbeat, origin allow-list, single-flight start/stop, portbackoff. **This is the canonical transport-hardening reference.**
- `src/main/websocket-protocol-handler.ts` — the JSON-RPC dispatcher (~106 methods).
- `src/main/websocket-event-bridge.ts` — subscribe/unsubscribe → JSON-RPC `events.event`.
- `src/main/websocket-auth.ts` — token gen/validate (timing-safe), enable/discovery flags.
- `src/main/websocket-tls.ts` — self-signed cert generation + SHA-256 fingerprint pinning.
- `src/main/websocket-discovery.ts` — Bonjour/mDNS advertisement (`_intent-ws._tcp`).
- `src/features/protocol/main/protocol-adapter.ts` — shared service entry point reused byIPC, STDIO-MCP, and WebSocket.
- `src/features/agent/main/agent-providers/acp-provider.ts` — spawns provider CLIs overstdio, ACP handshake/streaming, MCP wiring.
- `src/shared/config/provider-config.ts` — provider registry + model tiers + quirks.
- `src/features/auggie/main/execute-auggie-command.ts` — auggie discovery/exec, enhanced PATH.
- `src/shared/types.ts`, `src/shared/types/agent-session.ts` — domain types to port.

## 2. Reference-Architecture Mapping (Intent TS → Rust)

The Intent app routes **every** transport (Electron IPC, STDIO-MCP, WebSocket) through one`ProtocolAdapter` + a set of `ws-*-api.ts` modules so business logic is written once. TheRust port keeps that invariant: **transports are thin; services are shared.**

| Intent TS module (verified path) | Responsibility | Rust module |
| --- | --- | --- |
| src/main/websocket-api-server.ts | HTTPS/WSS listener, upgrade auth, heartbeat, lifecycle | transport::ws + transport::lifecycle |
| src/main/websocket-auth.ts | bearer token gen/validate, enable flags | transport::auth |
| src/main/websocket-tls.ts | self-signed cert + fingerprint | transport::tls |
| src/main/websocket-discovery.ts | Bonjour/mDNS advertise _intent-ws._tcp | transport::discovery |
| src/main/websocket-protocol-handler.ts | JSON-RPC parse + dispatch (~106 methods) | rpc::router + rpc::methods::* |
| src/main/websocket-event-bridge.ts | subscribe → events.event notifications | events::bridge |
| src/features/protocol/main/protocol-adapter.ts | shared service facade | services (trait surface) |
| src/features/mcp/main/mcp/ws-note-api.ts | note CRUD logic | services::notes |
| src/features/mcp/main/mcp/ws-agent-api.ts | agent lifecycle logic | services::agents |
| src/features/mcp/main/mcp/ws-git-api.ts | git status/stage/commit | services::git + git |
| src/features/git-tracking/main/github.service.ts | PR/issue REST (via proxy today) | sourcecontrol::github (octocrab, generic) |
| src/features/git-tracking/main/pr-comment.service.ts | PR review comments | sourcecontrol::github::reviews |
| src/features/agent/main/agent-providers/acp-provider.ts | spawn provider CLIs, ACP I/O | acp::client + acp::session |
| src/shared/config/provider-config.ts | provider registry, model tiers, quirks | providers::registry |
| src/features/agent/main/provider-registry.ts | runtime arg/env assembly | providers::launch |
| src/features/auggie/main/execute-auggie-command.ts | auggie discovery + exec | context::auggie |
| src/features/events/event-filter-engine.ts | subscription filter matching | events::filter |
| src/features/events/types.ts | event taxonomy + WorkspaceEvent | events::types |
| src/shared/types.ts (Workspace, Note, TaskMetadata) | domain entities | store::model |
| src/shared/types/agent-session.ts (AgentSession) | agent runtime state | store::model::agent |
| src/features/comments/comment-types-v2.ts (CommentV2) | comments/threads | store::model::comment |

**Key architectural carry-overs:**

1. **One service layer, many transports.** `ProtocolAdapter` is the precedent: a singlefacade invoked by IPC/MCP/WS. In Rust this becomes the `services` trait surface that the`rpc` router *and* the agent-facing MCP server both call.
2. **Transport-local subscription state.** `websocket-event-bridge.ts` keeps subscriptionsas *runtime* state (not domain state) and delivers via a registered send callback. Wereplicate this exactly: subscriptions live in the connection, the event bus is canonical.
3. **Lifecycle hardening is non-negotiable.** The TS server's single-flight start/stop,`externalStopGeneration` race guard, port backoff, and pre-`listen` error handler areported as first-class `transport::lifecycle` logic (§5.6).
4. **Provider quirks are data, not code.** `ACP_PROVIDERS` is a table; the Rust port keeps a`ProviderConfig` registry so adding a provider is a config change (§6.9).

## 3. Crate / Module Layout

A single Cargo **workspace** with one binary crate `intentd` and a small number of librarycrates. Splitting into libs keeps compile times reasonable and enforces dependencydirection; alternatively start as one crate with the module tree below and split later.

```text
intent-backend/                  # cargo workspace root
├── Cargo.toml                   # [workspace] members
├── crates/
│   ├── intentd/                 # binary: CLI + daemon entrypoint (clap)
│   │   └── src/main.rs
│   ├── intent-core/             # domain model, ids, errors, config, events
│   ├── intent-store/            # SQLite + file-tree persistence (repositories)
│   ├── intent-services/         # business logic (the shared service surface)
│   ├── intent-acp/              # ACP client, session multiplexing, MCP-back server
│   ├── intent-providers/        # provider registry, launch arg/env assembly
│   ├── intent-sourcecontrol/    # SourceControl trait + GitHubSourceControl (octocrab)
│   ├── intent-git/              # libgit2/gix wrappers + worktree locking
│   ├── intent-context/          # ContextEngine trait + auggie impl
│   ├── intent-pty/              # unified PTY host: terminals + scripts (portable-pty), scrollback, attach
│   ├── intent-search/           # BE-owned search: ripgrep-equivalent content/path search (grep + ignore) + adapters over store/session/event/memory/note data
│   └── intent-transport/        # UDS/TCP/TLS listeners, JSON-RPC router, auth, mDNS, client.hello → clientId mapping
```

Two cross-cutting concerns are **modules** rather than new crates: `search` is its own`intent-search` crate (above) because it pulls heavy ripgrep dependencies, while **drafts**are a small persisted feature — a `services::drafts` module backed by a `draft` store table(§9.10) — and **client identity** is a `transport` concern (the live-connection → logical`clientId` map, §16) plus a tiny `client` store table.

The **Code Changes Review** domain (§17) is likewise wired as a cluster of `services` modules over the existing persistence and forge layers rather than new crates: `services::file_tracking` (the agent-attribution audit pipeline + the UI-invoked read methods), `services::diffs` (internal diff computation/storage), `services::accept_changes` (the commit→push→PR→merge orchestration), and `services::metrics` (additions/deletions aggregation). Per the §3.2 dependency rules they depend **only** on `intent-store` (the `tracked_changes`/`diffs`/`workspace_metrics`/`agent_metrics` tables, §9.2/§9.11), `intent-git` (worktree/stage/commit/diff), `intent-sourcecontrol` (the `SourceControl` trait for PR creation/merge/reviews, §7), and the event bus — never on the transport or on each other directly. Their *write* paths (attribution, diff extraction, metric aggregation) are BE-internal; only their read methods are exposed over the wire (§17.1).

The **Integrations & Ops** domain (§19) follows the same pattern: `services::token_usage` (the daemon-internal periodic usage scanner + the `workspace.getTokenUsage` read), `services::session_stats` (per-session credit/message/tool stats via `auggie session stats --json` + the `agent.getSessionStats` read), and `services::setup_scripts` (worktree setup-script persistence, project-type detection, and AI-assisted generation). They depend only on `intent-store` (the durable `tokenUsage`/`setupScript` workspace fields + the new `token_usage` table, §9.13), `intent-context`/`intent-providers` (for `auggie`/AI-assisted generation), and the event bus. Usage/credit **scanning is internal** — only the reads + change events cross the wire (§19.1–19.2).

### 3.1 Module responsibilities

| Module / crate | Responsibility | May depend on |
| --- | --- | --- |
| intentd (bin) | CLI parsing (serve/call/status/stop/doctor), daemonization, wiring | every crate |
| intent-core | WorkspaceId/NoteId/AgentId newtypes, Error/Result, Config, event types, traits | (none — leaf) |
| intent-store | sqlx/rusqlite pool, migrations, repositories, file layout, locking | core |
| intent-services | note/task/comment/workspace/agent/git/pr/script/file/event/draft logic (incl. the `services::drafts` module, §9.10) plus the Agent-Ecosystem modules `services::rules`, `services::specialists`, `services::mcp_servers`, `services::memories` (§18) and the Integrations & Ops modules `services::token_usage`, `services::session_stats`, `services::setup_scripts` (§19) | core, store, git, sourcecontrol, acp, context, providers, pty, search |
| intent-acp | spawn providers over stdio, handshake, session new/load/prompt/cancel, streaming, client-served fs/terminal/permission, agent→BE MCP server | core, providers; calls back into services via a trait |
| intent-providers | ProviderConfig registry, arg/env builder, model-tier table, capability/quirks | core |
| intent-sourcecontrol | SourceControl trait + GitHubSourceControl (octocrab): PR/issue/review/check-run/mergeability, retry | core |
| intent-git | status/stage/commit/branches, worktree create + lock | core |
| intent-context | ContextEngine trait + AuggieContextEngine + discovery | core |
| intent-pty | unified portable-pty host for terminals **and** scripts: scrollback ring buffers, multi-client attach, service/command modes, auto-restart, URL/port detection (§12) | core |
| intent-search | BE-owned `search.*`: ripgrep-equivalent content search (grep + ignore + globset), path/glob search, and adapters over persisted sessions/events/memories/notes/codebase; per-request cancellation by `requestId` (§14) | core, store |
| intent-transport | UDS/TCP listeners, TLS, bearer auth, origin allow-list, JSON-RPC router, heartbeat, lifecycle, mDNS, `client.hello` handshake + live-connection→`clientId` map (§16) | core, services |

### 3.2 Dependency-direction rules

```text
intent-core  ◄───────────────────────────────────────────────┐
   ▲   ▲   ▲   ▲   ▲   ▲                                       │
   │   │   │   │   │   └── intent-providers ◄── intent-acp     │
   │   │   │   │   └────── intent-context                      │
   │   │   │   └────────── intent-git                          │
   │   │   └────────────── intent-sourcecontrol                │
   │   └────────────────── intent-store                        │
   └── intent-services ──► (store, git, sourcecontrol, acp, context, providers, pty)
                  ▲
                  │
        intent-transport ──► services        intentd (bin) ──► all
```

Rules (mirroring the `augmentcode/intent` repository's *“never import a feature's *`main/`* from renderer”* discipline):

1. `intent-core`** is a leaf** — no dependency on any other workspace crate. It defines thedomain vocabulary (ids, timestamps, errors, event types) and *traits* (`ContextEngine`,`WorkspaceApi`) that higher layers implement/consume.
2. `intent-transport`** never touches `intent-store` directly.** It only depends on`intent-services`. This guarantees the WS router and the agent MCP server share one codepath, exactly as `protocol-adapter.ts` is shared across IPC/MCP/WS today.
3. `intent-acp`** calls back into business logic through a trait** (`WorkspaceApi` defined in`intent-core`, implemented in `intent-services`) to avoid a dependency cycle`services → acp → services`. Concretely: `services` constructs the ACP client and hands itan `Arc<dyn WorkspaceApi>` so the agent→BE MCP server can reuse the same logic (§6.8).
4. **No cross-imports between sibling “feature” service modules.** `services::notes` and`services::git` communicate through the store/event bus, not by importing each other.
5. **The binary crate is the only place allowed to wire concrete implementations together**(composition root), keeping every library crate testable in isolation.

## 4. Recommended Crates + Cargo.toml Sketch

### 4.1 Crate selection rationale

| Concern | Crate(s) | Notes |
| --- | --- | --- |
| Async runtime | tokio (full) | multi-threaded runtime; required by ACP tokio SDK + axum |
| HTTP/WS server | axum + tokio-tungstenite (via axum::extract::ws) | mirrors the HTTPS+/ws design of websocket-api-server.ts |
| UDS listener | tokio::net::UnixListener | local default transport (§5.1) |
| TLS | rustls + tokio-rustls + rcgen | rcgen replaces selfsigned; pin via SHA-256 fingerprint (§5.4) |
| JSON-RPC | hand-rolled over serde_json (or jsonrpsee server) | the TS handler is hand-rolled; a thin custom router keeps full control of the 106-method catalog and notification semantics |
| Serde | serde, serde_json | domain (de)serialization; #[serde(rename_all = "camelCase")] to match the wire types |
| ACP | agent-client-protocol + agent-client-protocol-tokio | official Rust SDK; we act as the Client role (§6) |
| GitHub | octocrab | generic REST + GraphQL; user token auth (§7) |
| Git | git2 (libgit2) or gix | git2 is mature for status/commit/worktree; gix is pure-Rust. Start with git2. |
| SQLite | sqlx (sqlite, runtime-tokio-rustls) or rusqlite | sqlx for async + compile-time-checked queries + migrations; rusqlite if you prefer sync + a blocking pool |
| Migrations | sqlx::migrate! (or refinery) | embedded SQL migrations (§9.4) |
| Logging | tracing + tracing-subscriber + tracing-appender | structured logs, file rotation (§11.1) |
| CLI | clap (derive) | serve/call/status/stop/doctor (§5.5) |
| mDNS | mdns-sd | advertise _intent-ws._tcp (§5.4) |
| FS watch | notify | optional: detect external edits under workspace paths |
| IDs | uuid (v4/v7) | entity ids; v7 for time-sortable ids (§9.5) |
| Time | time or chrono | RFC-3339 timestamps to match TS toISOString() |
| Errors | thiserror (libraries) + anyhow (binary) | typed domain errors → JSON-RPC error codes (§11) |
| Config | serde + toml + directories | XDG/macOS path resolution (§11.2) |
| Process tree kill | nix (unix) / sysinfo | terminate provider process trees on cancel/reap |
| PTY / terminal host | portable-pty | cross-platform PTYs for the unified terminal + script host (§12); scrollback + multi-client attach |
| Code/file search | grep + ignore + globset | **ripgrep's own libraries** — content search with gitignore semantics and glob filtering for the `search.*` namespace (§14); avoids shelling out to the `rg` binary and removes the remote SSH-exec hack |
| Retry/backoff | backoff or hand-rolled | GitHub rate-limit + ACP spawn retries |

### 4.2 Workspace `Cargo.toml` sketch

```toml
[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
edition = "2021"
rust-version = "1.79"
license = "MIT"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["ws"] }
tokio-tungstenite = "0.23"
tokio-rustls = "0.26"
rustls = "0.23"
rcgen = "0.13"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
agent-client-protocol = "0.x"          # official ACP SDK — pin to latest 0.x
agent-client-protocol-tokio = "0.x"    # tokio bindings for the ACP SDK
octocrab = "0.39"
git2 = "0.19"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "macros", "migrate", "chrono"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
tracing-appender = "0.2"
clap = { version = "4", features = ["derive", "env"] }
mdns-sd = "0.11"
notify = "6"
uuid = { version = "1", features = ["v4", "v7", "serde"] }
time = { version = "0.3", features = ["serde", "formatting", "parsing"] }
thiserror = "1"
anyhow = "1"
toml = "0.8"
directories = "5"
nix = { version = "0.29", features = ["signal", "process"] }
portable-pty = "0.8"                    # unified PTY host for terminals + scripts (§12)
grep = "0.3"                            # ripgrep content-search library (§14)
ignore = "0.4"                          # ripgrep gitignore-aware directory walker (§14)
globset = "0.4"                         # glob filtering for search.fileNames (§14)
```

> Version note: pin agent-client-protocol / agent-client-protocol-tokio to thelatest published version on docs.rs at implementation time(github.com/agentclientprotocol/rust-sdk). The wire protocol version is 1 (stable).Verify octocrab and sqlx minor versions at build time; the numbers above are guidance.

### 4.3 Binary crate dependencies (`crates/intentd/Cargo.toml`)

```toml
[package]
name = "intentd"
version = "0.1.0"
edition.workspace = true

[dependencies]
intent-core = { path = "../intent-core" }
intent-store = { path = "../intent-store" }
intent-services = { path = "../intent-services" }
intent-transport = { path = "../intent-transport" }
intent-acp = { path = "../intent-acp" }
intent-sourcecontrol = { path = "../intent-sourcecontrol" }
intent-context = { path = "../intent-context" }
tokio = { workspace = true }
clap = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
anyhow = { workspace = true }
```

## 5. Transport & Deployment

The daemon serves the **same JSON-RPC router** over three transports. The wire framing andmethod catalog are identical across all of them (see `PROTOCOL.md`); only the listener andauth differ.

### 5.1 Transport matrix

| Transport | Default? | Use case | Auth | Framing |
| --- | --- | --- | --- | --- |
| Unix domain socket | ✅ local default | same-host FE/CLI/agent | filesystem perms (0600) + optional token | newline-delimited JSON-RPC or WS-over-UDS |
| TCP + TLS (WSS) | opt-in | LAN / remote host on trusted network | bearer token + origin allow-list + cert pin | WebSocket frames (/ws) |
| SSH tunnel | opt-in | remote over untrusted network | SSH auth + UDS-on-remote forwarded to local | as UDS |

**Local default = UDS.** Unlike the Electron app (which binds `0.0.0.0` because the rendererand mobile clients are remote-ish), a headless daemon should default to a UDS at awell-known path so nothing is network-exposed unless the user opts in. TCP/TLS is enabledonly when the user wants LAN/remote access.

- UDS path: `$XDG_RUNTIME_DIR/intentd/intentd.sock` (Linux) or`~/Library/Application Support/intentd/intentd.sock` (macOS); see §11.2.
- Socket file created with mode `0600`; refuse to start if an existing socket is live(single-instance, §5.6). Remove a stale socket whose owner process is gone.

### 5.2 TCP/TLS / WSS (LAN & remote)

Port the behavior of `src/main/websocket-api-server.ts` precisely:

- Bind an HTTPS+WebSocket listener on `0.0.0.0:<port>` (default base port `5180`).
- WebSocket endpoint at path `/ws`; a plain `GET /health` returns`{ "status": "ok", "clients": <n> }`.
- **Auto port selection**: try `5180`, then same-port EADDRINUSE backoff `[100, 200, 400]ms`,then fall through to the next port, up to **10** distinct ports(`WS_API_LISTEN_BACKOFF_MS` / `WS_API_MAX_PORT_ATTEMPTS` in the TS source).
- Advertise the bound port + cert fingerprint via mDNS (§5.4).

### 5.3 Bearer auth & origin allow-list

Port `websocket-auth.ts` + the `handleUpgrade` gate in `websocket-api-server.ts`:

- **Token**: 32 random bytes hex-encoded (64 chars), generated on first run and persisted.Validate with a **timing-safe** comparison (`subtle`/`ring::constant_time` or compare equallength then `constant_time_eq`). Mirrors `validateToken()` (`timingSafeEqual`).
- Token accepted from the `Authorization: Bearer <token>` header **or** a `?token=` queryparam (matching `extractToken()`), so browser WebSocket clients that cannot set headersstill authenticate.
- **Origin allow-list** (port `isAllowedWebSocketApiOrigin`):
  - `Origin` absent/empty → **allow** (native CLI/mobile clients never send Origin).
  - `Origin: null` → **reject** (sandboxed/`data:` contexts).
  - `file://…` → allow (desktop renderer).
  - loopback hosts (`localhost`, `127.0.0.1`, `::1`) → allow.
  - hostname == `os.hostname()` or its `.local` form → allow (LAN-by-hostname via mDNS).
  - everything else → **403**.
- On a failed upgrade: write the raw status line (`HTTP/1.1 401 Unauthorized\r\n\r\n` /`403 Forbidden`) then destroy the socket, exactly as the TS server does.
- A global **enable flag** (`isWebSocketApiEnabled()`): when disabled, reject upgrades with403 even if the listener is bound. UDS is governed by a separate enable flag.

### 5.4 TLS certificate & mDNS discovery

Port `websocket-tls.ts` + `websocket-discovery.ts`:

- **Self-signed cert** generated with `rcgen` (EC P-256, SHA-256), 10-year validity, storedunder the data dir as `ws-cert.pem` (`0644`) + `ws-key.pem` (`0600`). Reuse acrossrestarts; regenerate if expired/unparseable.
- **SAN** includes `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 of the host(so Tailscale/LAN IPs work). Skip virtual interfaces (`vmnet|bridge|veth|docker|br-`).
- **Fingerprint pinning**: expose the SHA-256 fingerprint (colon-separated hex). Clients pinit on first connect; advertise it in the mDNS TXT record.
- **mDNS** (`mdns-sd`): publish service type `_intent-ws._tcp` named`Intent on <hostname>`, port = bound port, TXT = `{ version: "1", path: "/ws", hostname: <host>, fp: <fingerprint>, os: <os>, arch: <arch>, hasDisplay: <bool>, locality: <local|remote> }` (the host-capability fields used for locality detection, §12.3). Stop/destroy on shutdown. Gate behind a discoveryenable flag (`isWebSocketApiDiscoveryEnabled()`).

### 5.5 SSH-tunnel remote model

For untrusted networks, do **not** expose TCP/TLS. Instead:

1. Run `intentd` on the remote host bound to a **UDS** (no network listener).
2. The client opens an SSH connection and forwards the remote UDS to a local UDS or localTCP port: `ssh -N -L /tmp/intentd-remote.sock:/run/user/1000/intentd/intentd.sock host`(OpenSSH ≥ 8 supports UDS forwarding) — or forward to a localhost TCP port.
3. The FE connects to the local end exactly as if the daemon were local.

This reuses SSH's auth, encryption, and host-key trust; `intentd` needs no remote-auth code.(This mirrors the `augmentcode/intent` repository's existing remote model via `ssh-manager`referenced from `acp-provider.ts`.) Document a `intentd serve --listen uds` mode that bindsonly the socket.

### 5.6 Lifecycle hardening

Port the robustness guarantees from `websocket-api-server.ts` verbatim — these prevent theEADDRINUSE / double-start / shutdown-race bugs the TS code was hardened against:

- **Single-flight start/stop.** Concurrent `start()` callers share one in-flight future;`stop()` during an in-flight `start()` cancels it. In Rust: an `Arc<Mutex<StartState>>`holding an `Option<Shared<BoxFuture>>`, plus a monotonic `external_stop_generation: AtomicU64` captured at `start()` entry and re-checked in the bind loop (the TS`externalStopGeneration` pattern).
- **Single-instance daemon.** A pidfile + UDS liveness probe; if a live daemon owns thesocket, `serve` exits with a clear message. Remove stale sockets/pidfiles.
- **Graceful shutdown ordering** (port `stop()`): (1) stop heartbeat; (2) clean up allper-client subscriptions; (3) send close (`1001 Server shutting down`) to every client;(4) remove the upgrade handler; (5) close the WS layer (terminate lingering clients first);(6) close the HTTP/UDS listener; (7) `await` both closures so a subsequent `start()` cannothit EADDRINUSE. Trigger on `SIGINT`/`SIGTERM` via `tokio::signal`.
- **Heartbeat** (port `startHeartbeat`): every **30s** ping each client; if no pong within**60s**, terminate and clean up its subscriptions. WS ping/pong frames for TCP; for UDS,an app-level `ping`/`pong` JSON-RPC notification on the same cadence.
- **Idle agent reaping** (§6.7): a periodic sweep terminates provider child processes thathave been idle past a configurable TTL, killing the whole process tree (`nix::sys::signal`to the process group), and marks the corresponding `AgentSession` reapable/resumable.
- **Post-bind error handling.** Install a durable error handler on the listener *after* asuccessful bind so runtime I/O errors are logged, never panicking the process — the Rustanalog of the TS post-`listen` `server.on('error', …)`.

### 5.7 CLI subcommands (`clap`)

`intentd` is both the daemon and its own control client.

| Subcommand | Description |
| --- | --- |
| intentd serve | Start the daemon. Flags: --listen uds |
| intentd call <method> [--params '<json>'] | One-shot JSON-RPC call to a running daemon (connects to UDS by default, or --url wss://… --token …). Prints the JSON result. Used for scripting + doctor. |
| intentd status | Show daemon liveness, transport(s), bound port, connected clients, active agents, cert fingerprint, host OS/arch + hasDisplay + derived host.locality (§12.3). (Wraps a health/workspace.list probe.) |
| intentd stop | Ask a running daemon to shut down gracefully (control RPC, then wait, then SIGTERM, then SIGKILL with timeout). |
| intentd doctor | Diagnostics: data-dir writable, SQLite openable + migrations current, provider CLIs discoverable (auggie/claude-code/…), gh/GITHUB_TOKEN present, context engine available, ports free, cert valid, host display availability (hasDisplay) + derived locality (§12.3). Exit non-zero on any failure. |

`call`/`status`/`stop` are thin clients over the same JSON-RPC protocol — proving theprotocol is complete enough for a thin FE.

### 5.8 Daemonization

- **macOS — launchd.** Ship a `LaunchAgent` plist(`~/Library/LaunchAgents/ai.intent.intentd.plist`) with `RunAtLoad`, `KeepAlive`(`Crashed=true`, `SuccessfulExit=false` so a clean `stop` does not relaunch),`ProgramArguments = [intentd, serve, --listen, uds]`, and `StandardOut/ErrorPath` to thelog dir. `intentd doctor` can install/validate it.
- **Linux — systemd user unit.** `~/.config/systemd/user/intentd.service`(`Type=simple`, `ExecStart=intentd serve`, `Restart=on-failure`,`ExecStop=intentd stop`). Enable with `systemctl --user enable --now intentd`.
- **Foreground/dev.** `intentd serve --foreground` runs in the terminal with `tracing`to stderr (the common case during development and inside container/CI).
- The daemon does not fork/double-fork itself; supervision is delegated to launchd/systemd(the modern, recommended approach). `--foreground` is the only non-supervised mode.

## 6. ACP Integration

`intentd` is an **ACP Client** that drives one or more **ACP Agents** (provider CLIs) overpiped stdio, using the official `agent-client-protocol` + `agent-client-protocol-tokio`crates. This ports `src/features/agent/main/agent-providers/acp-provider.ts` and the`acp-official/*` server. Protocol version is `1`.

### 6.1 Role & responsibilities

As the **Client**, `intentd`:

- Spawns the agent process and owns its stdin/stdout/stderr pipes.
- Sends agent-bound requests: `initialize`, `authenticate`, `session/new`, `session/load`,`session/prompt`, `session/cancel`, `session/set_mode`.
- **Serves** client-bound requests *from* the agent: `fs/read_text_file`,`fs/write_text_file`, `terminal/*` (create/output/wait/release/kill),`session/request_permission`.
- Receives streaming `session/update` notifications and routes them to subscribers.

### 6.2 Spawning piped-stdio providers

Port the spawn logic in `acp-provider.ts` and arg/env assembly in `provider-registry.ts`:

- Resolve the provider's `command` + `baseArgs` from the registry (§6.9), then appendmodel/rules/mcp/quiet flags per the provider's capability flags.
- Spawn with `tokio::process::Command`, `stdin/stdout/stderr = Stdio::piped()`,`kill_on_drop(true)`. Apply the provider env from `buildProviderEnv()` (e.g. cortex`ELECTRON_RUN_AS_NODE=1`, opencode `OPENCODE_CONFIG_CONTENT`).
- **PATH enrichment** (port `execute-auggie-command.ts` / `getAuggieExecPATH`): GUI/daemonprocesses inherit a minimal PATH. Prepend the discovered provider binary's parent dir and`~/.augment/bin` so the `#!/usr/bin/env node` shebang resolves the right `node`. Implementan `enhanced_path()` helper used for every provider spawn.
- For **remote** workspaces, spawn through the SSH transport (the `augmentcode/intent``ssh-manager` analog), piping stdio over the SSH channel.

### 6.3 Stdin write serialization

The ACP wire is NDJSON over a single stdin pipe. Concurrent writers would interleave bytesand corrupt frames. **Serialize all writes per agent process** behind one writer task:

- Spawn a dedicated `tokio` task owning the child's `stdin`; feed it via an`mpsc::Sender<String>`. Every outbound request/response/notification goes through thechannel, guaranteeing whole-line atomicity. (This is the Rust form of the TSwrite-queue/mutex around the provider stdin.)
- A matching reader task owns `stdout`, frames on `\n`, parses JSON-RPC, and dispatches:responses → pending-request map (`oneshot` per id); requests → client-served handlers;notifications → the streaming router. `stderr` is drained into a bounded ring buffer fordiagnostics and auth-error pattern matching.

### 6.4 Handshake

1. `initialize` → negotiate protocol version `1`, advertise client capabilities`{ fs: { readTextFile, writeTextFile }, terminal: true }` and receive the agent'scapabilities + auth methods.
2. If the agent reports it needs auth and the provider `supportsAuthenticate`, call`authenticate`; otherwise surface a provider-specific login hint(`getProviderAuthErrorMessage`, e.g. `auggie login`). Detect auth failures via theprovider's `authErrorPatterns` against captured stderr/responses.
3. Optionally `session/set_mode` if `supportsSetMode`.

### 6.5 Session new / load / prompt / cancel

- `session/new` with `{ cwd, mcpServers }` → returns the agent's `sessionId`. Persist itas `AgentSession.acpSessionId` (see `agent-session.ts`: written once, used for resume).
- `session/load` to resume an existing `acpSessionId` after a daemon restart (only whenthe agent advertises `loadSession` capability).
- `session/prompt` with the user content blocks → drives a turn; the agent streams`session/update`s then returns a stop reason (`end_turn`, `max_tokens`, `cancelled`, …).
- `session/cancel` to interrupt the current turn; on hard cancel/reap, kill the processtree.

### 6.6 Streaming routing

The agent emits `session/update` notifications (message chunks, tool calls, plan updates,mode changes). Map each to an internal `WorkspaceEvent` (`agent:stream:*`, `agent:tool:call`,`agent:plan:*`, see `events/types.ts`) and publish to the event bus, which the event bridge(§10) forwards to subscribed clients as `events.event` JSON-RPC notifications. Accumulatemessage chunks into the append-only `AgentSession.messages` log (provider immutable onceset). Tool-call updates carry `toolKind` (`file|terminal|search|note|git|other`) and status(`started|completed|error`) — preserve this taxonomy.

### 6.7 Client-served methods (fs / terminal / permission)

Implement handlers for the agent→client requests (port `acp-official` server +`protocol-adapter` capabilities `{ fileSystem, terminal, permissions }`):

- `fs/read_text_file`** / **`fs/write_text_file` — sandboxed to the session's workspace`cwd`/`scope`; reject path traversal outside the worktree. Writes go through the same fileservice used by `file.*` RPC so events fire identically.
- `terminal/create|output|wait_for_exit|release|kill` — fulfilled by the unified PTY host(§12): the agent's terminals are PTYs on the same host that backs interactive `terminal.*`and scripts, with a max-output scrollback ring buffer; lifetime is tied to the session soreaping a session kills its terminals.
- `session/request_permission` — the agent asks to run a risky action. Emit a permissionrequest event/notification (`agent:permission:*`); the FE responds via an `agent.*` RPCthat resolves the pending `oneshot`. Provide a configurable auto-allow/deny policy forheadless operation (default: deny destructive, allow read).
- **Idle reaping** ties in here: a session with no in-flight prompt and no open terminalspast its TTL is eligible for reaping (§5.6).

### 6.8 Session multiplexing & the agent→BE workspace API (MCP callback)

**Multiplexing.** `intentd` runs **many** agents concurrently. Each `AgentSession` maps toone provider child process (or one ACP session within a process, if the provider supportsmultiple). A central `AgentManager`:

- owns a `HashMap<AgentId, AgentHandle>` (child, writer `Sender`, pending-request map,session metadata);
- routes inbound JSON-RPC by correlating response `id`s per-connection (each agent processhas its own id space);
- enforces a global concurrency cap + per-process slot acquisition (port the`agent-process-registry` acquire/register/markActive/markIdle/deregister lifecycle);
- supports `agent.create`, `agent.delegate`, `agent.sendMessage`, `agent.queueMessage`,`agent.stop`, `agent.wakeOrCreate`, `agent.reportToParent`, etc. (full list in`PROTOCOL.md`).

**Agent→BE MCP callback (the key loop).** Agents need to call the *same* workspace API theFE uses (`note.add`, `task.update`, `agent.delegate`, `git.status`, …). Intent does this bypassing each provider an **MCP server** (`--mcp-config`) that proxies to the shared services.In Rust:

- Stand up an in-process **MCP server** (stdio or a per-agent UDS) that exposes the workspacetools. Implement it over the same `Arc<dyn WorkspaceApi>` (the `intent-services` trait) theJSON-RPC router uses — **one implementation, two front doors** (FE via JSON-RPC, agent viaMCP), exactly as `protocol-adapter.ts` is shared today.
- For providers with `supportsMcpConfig` (e.g. auggie via `--mcp-config`), write a generatedMCP config pointing at this server and pass it on spawn. For providers without native MCPconfig flags, fall back to the universal-MCP-config translation(`universal-mcp-config.ts` analog: `toAcpMcpServers` / `toCodexMcpOverrides` /`toOpenCodeMcpConfig`).
- Inject baseline env into stdio MCP servers and **redact secrets in logs** (port`mcp-env.ts` `applyBaselineEnvToStdioServers` / `redactMcpEnvForLogging`).
- Tool denylisting per agent type (coordinator vs implementor vs verifier) ports`background-agent-tool-restrictions.ts` (`CONFLICTING_BUILTIN_TOOLS`, `FILE_WRITE_TOOLS`,`SUBAGENT_TOOLS`, `getToolDenylistForAgentType`). This denylist is **enforced internally** while assembling each agent's tool set on spawn; it is **not** a client RPC — there is **no `agent.getAvailableTools` method**. The full category list and agent-type → restriction mapping is documented in §18.4.

```text
        ┌────────── FE / CLI ──────────┐        ┌────────── Agent (provider CLI) ──────┐
        │  JSON-RPC over UDS/WSS        │        │  MCP tool calls over stdio/UDS       │
        └───────────────┬──────────────┘        └───────────────┬──────────────────────┘
                        │                                        │
                   rpc::router                              acp::mcp_server
                        │                                        │
                        └──────────────►  Arc<dyn WorkspaceApi>  ◄┘   (intent-services)
                                                  │
                                    store · git · sourcecontrol · events
```

### 6.9 Provider / model registry + capability & quirks table

Port `ACP_PROVIDERS` (`provider-config.ts`) to a static `ProviderConfig` registry. Eachentry is **data**; adding a provider is a config change, not a code change.

| Provider | command | baseArgs | model flag | auth method | quirks |
| --- | --- | --- | --- | --- | --- |
| auggie (default) | auggie | --acp --allow-indexing | --model | authenticate + auggie login | supports MCP config (--mcp-config), rules (--rules), quiet (--quiet); canBeDisabled=false |
| claude-code | claude-agent-acp | (none) | — | external (claude login); authCheckArgs=[auth,status] | no MCP-config flag |
| codex | codex-acp | (none) | — | external; authCheckArgs=[login,status] | MCP via toCodexMcpOverrides |
| cortex | cortex-acp | (none) | — | feature-gated (requiresFeatureCode=cortex) | env ELECTRON_RUN_AS_NODE=1; runs script via node |
| opencode | opencode | acp | — (env) | opencode auth login/env; readiness via opencode models | model via OPENCODE_CONFIG_CONTENT env (no --model) |
| droid | droid | exec --output-format acp | --model | external; readiness via ACP probe | no models/auth status subcommand |
| mock | node | (env script) | — | authenticate | E2E only; requiresEnvVar=MOCK_AGENT_SCRIPT_PATH |

`ProviderConfig` fields to port (from `ACPProviderConfig`): `id`, `displayName`, `command`,`baseArgs`, `modelFlag?`, `defaultAgent?`, `supportsAuthenticate`, `supportsSetMode`,`supportsMcpConfig`, `supportsRulesFile`, `rulesFlag?`, `mcpConfigFlag?`, `quietFlag?`,`modeMap?`, `supportedModels?`, `isDefault`, `canBeDisabled`, `authErrorPatterns?`,`loginCommandHint?`, `requiresEnvVar?`, `requiresFeatureCode?`, `authCheckArgs?`,`loginDocsUrl?`.

**Model handling** (port the helpers): compound model ids `{providerId}:{modelId}`(`parseCompoundModelId` / `createCompoundModelId`); per-provider capability tiers`{ fast, balanced, smart }` (`PROVIDER_MODEL_TIERS`); fuzzy/tier resolution(`normalizeModelOverride`, `fuzzyMatchModelInPool`, `resolvePreferredModel`). Providers with**dynamic** model lists (opencode, droid) are intentionally absent from the tier table —fetch their models from the CLI at runtime and never hardcode.

## 7. Source Control (provider-agnostic; v1 GitHub via octocrab)

Source control — the remote **forge** API (pull/merge requests, issues, reviews, comments,CI/check status, mergeability, branch/remote helpers) — is modeled as a provider-agnostic**`SourceControl` trait** with a concrete `GitHubSourceControl` implementation backed by`octocrab`. **v1 ships GitHub only**; GitLab, Bitbucket, and other hosts are documented asfuture implementations of the *same* trait, selected at runtime by the`sourceControl.activeProvider` setting (§9.8). Local git operations(status/stage/commit/push/fetch/diff/worktree) are **not** part of this trait — they remainin the separate `git` module (`intent-git`, §3, §9.5). The Rust crate/module is`intent-sourcecontrol` (the trait plus a `sourcecontrol::github` impl).

### 7.1 Divergence from the `augmentcode/intent` Augment-proxy approach

> Explicit divergence. augmentcode/intent today calls GitHub through Augment's proxy:src/shared/augment-api/augment-api.client.ts issues agents/run-remote-tool withtool_name: "github-api", and PR features live insrc/features/git-tracking/main/github.service.ts, pr-comment.service.ts, ws-pr-api.ts,ws-git-api.ts. intentd does NOT do this. It talks to the forge directly — for GitHub,via octocrab using the user's own token. There is no Augment dependency in thesource-control path. We port the PR feature semantics (what the methods do) but replacethe transport (proxy → octocrab) and generalize it behind the SourceControl trait.

### 7.2 The `SourceControl` trait

`services` depends only on `Arc<dyn SourceControl>` — never on `octocrab` directly — so a newforge is added by writing one impl. Hosts advertise `ScCapabilities` so the FE can gate UI onwhat the active provider supports; operations a host cannot perform return a typed`Unsupported` error. This sketch is guidance for the implementor — refine signatures asneeded.

```rust
/// Identifies a repository on a forge (host-agnostic).
pub struct RepoRef { pub owner: String, pub name: String }

/// A pull/merge/change request, normalized across hosts.
pub struct PullRequest {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub body: Option<String>,
    pub state: PrState,            // Open | Closed | Merged
    pub draft: bool,
    pub source_branch: String,     // head
    pub target_branch: String,     // base
    pub author: String,
    pub mergeable: Option<bool>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

pub enum PrState { Open, Closed, Merged }
pub enum MergeMethod { Merge, Squash, Rebase }
pub enum ReviewVerdict { Approve, RequestChanges, Comment }
pub enum CheckState { Pending, Success, Failure, Neutral, Cancelled }

pub struct NewPullRequest {
    pub title: String,
    pub body: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
}

pub struct Review { pub author: String, pub verdict: ReviewVerdict, pub body: Option<String>, pub submitted_at: OffsetDateTime }
pub struct Comment { pub id: String, pub author: String, pub body: String, pub path: Option<String>, pub line: Option<u64>, pub created_at: OffsetDateTime }
pub struct CheckRun { pub name: String, pub state: CheckState, pub url: Option<String> }
pub struct Mergeability { pub mergeable: Option<bool>, pub conflicts: bool, pub required_checks_passed: bool }
pub struct Issue { pub number: u64, pub title: String, pub body: Option<String>, pub state: String, pub url: String }

/// Capabilities a concrete host may or may not support (FE can gate UI on these).
pub struct ScCapabilities {
    pub draft_prs: bool,
    pub squash_merge: bool,
    pub rebase_merge: bool,
    pub review_required_changes: bool,
    pub check_runs: bool,
    pub issues: bool,
}

#[async_trait]
pub trait SourceControl: Send + Sync {
    /// Stable id of the provider, e.g. "github".
    fn provider_id(&self) -> &'static str;
    fn capabilities(&self) -> ScCapabilities;

    /// Auth / connectivity probe (used by `settings`/`doctor`); returns the resolved login.
    async fn check_auth(&self) -> Result<AuthStatus>;

    // --- Pull/merge requests ---
    async fn create_pr(&self, repo: &RepoRef, input: NewPullRequest) -> Result<PullRequest>;
    async fn get_pr(&self, repo: &RepoRef, number: u64) -> Result<PullRequest>;
    async fn list_prs(&self, repo: &RepoRef, query: PrQuery) -> Result<Vec<PullRequest>>;
    async fn update_pr(&self, repo: &RepoRef, number: u64, patch: PrPatch) -> Result<PullRequest>;
    async fn merge_pr(&self, repo: &RepoRef, number: u64, method: MergeMethod) -> Result<MergeOutcome>;
    async fn mergeability(&self, repo: &RepoRef, number: u64) -> Result<Mergeability>;

    // --- Reviews & comments ---
    async fn submit_review(&self, repo: &RepoRef, number: u64, verdict: ReviewVerdict, body: Option<String>) -> Result<Review>;
    async fn list_reviews(&self, repo: &RepoRef, number: u64) -> Result<Vec<Review>>;
    async fn add_comment(&self, repo: &RepoRef, number: u64, body: &str, anchor: Option<CommentAnchor>) -> Result<Comment>;
    async fn list_comments(&self, repo: &RepoRef, number: u64) -> Result<Vec<Comment>>;

    // --- CI / checks ---
    async fn check_runs(&self, repo: &RepoRef, git_ref: &str) -> Result<Vec<CheckRun>>;

    // --- Issues (optional; gated by capabilities) ---
    async fn create_issue(&self, repo: &RepoRef, title: &str, body: Option<&str>) -> Result<Issue>;
    async fn get_issue(&self, repo: &RepoRef, number: u64) -> Result<Issue>;
    async fn list_issues(&self, repo: &RepoRef, query: IssueQuery) -> Result<Vec<Issue>>;
}

// Supporting param structs: PrQuery { state, base, head, author, limit },
// PrPatch { title?, body?, target_branch?, draft?, state? },
// CommentAnchor { path, line, side }, MergeOutcome { merged, sha },
// AuthStatus { authenticated, login, scopes }, IssueQuery { state, labels, limit }.
```

Notes:

- The `SourceControl` trait is the *forge* (remote) API only; local git stays in the `git`module (§9.5).
- The `pr.*` wire methods map onto these trait methods; "PR" is host-agnostic(PR / MR / change-request).
- Unsupported operations return a typed `Unsupported` error, surfaced to the FE via`capabilities()`.

### 7.3 `GitHubSourceControl` (octocrab) + auth strategy

`GitHubSourceControl` is the v1 impl. Resolve a token per `sourceControl.github.tokenSource`(§9.8):

1. `explicit` — a token stored in `intentd` settings (`sourceControl.github.token`, enteredby the user; stored in the OS keychain via a `keyring` crate, **never** in plaintext configor logs).
2. `env` — `GITHUB_TOKEN` / `GH_TOKEN` env var.
3. `gh-cli` — `gh auth token` (shell out to the GitHub CLI if installed) — the most commondev setup.

Build the client with `octocrab::Octocrab::builder().personal_token(token).build()`. Support**GitHub Enterprise** via `.base_uri(...)` driven by `sourceControl.github.apiBaseUrl`. If notoken is found, source-control features report a structured "not configured" error (mirroringthe §8.3 graceful-unavailable contract) — the daemon still runs.

### 7.4 Provider selection (`SourceControlRegistry`)

A `SourceControlRegistry` builds the active impl from `sourceControl.activeProvider` plus thatprovider's `sourceControl.<provider>.*` settings (§9.8). v1 registers only `github`; selectingan unregistered provider yields a typed configuration error. Future hosts (`gitlab`,`bitbucket`) register additional `SourceControl` impls without touching `services` or the`pr.*` wire methods. Operations the active host does not support surface as `Unsupported`,gated by `capabilities()`.

### 7.5 Coverage — `pr.*` → trait → octocrab

The wire-level `pr.*` namespace stays host-agnostic ("PR" == PR/MR/change-request) and mapsonto `SourceControl` trait methods; the GitHub impl maps those onto octocrab:

| RPC method | SourceControl method | octocrab surface (GitHub impl) |
| --- | --- | --- |
| pr.status | get_pr / mergeability | pulls().get(n) → state, draft, merged, mergeable, mergeable_state |
| pr.merge | merge_pr | pulls().merge(n) with method merge |
| pr.updateBranch | (branch helper) | pulls().update_branch(n) (REST PUT …/update-branch) |
| pr.listComments | list_comments | issues().list_comments(n) |
| pr.postComment | add_comment | issues().create_comment(n, body) |
| pr.listReviewComments | list_comments (anchored) | pulls().list_review_comments(n) (line-anchored) |
| pr.replyToReviewComment | add_comment (reply) | pulls().comment_reply(...) / REST replies endpoint |
| pr.resolveThread | (review-thread op) | GraphQL resolveReviewThread / unresolveReviewThread mutation |
| pr.waitForChanges | get_pr + check_runs (poll) | poll pr.status + checks until state/checks/commits change |
| (reviews) | submit_review / list_reviews | pulls().create_review / list reviews |
| (checks) | check_runs | checks().list_check_runs_for_ref(sha) + commit combined_status |
| (issues) | create_issue / get_issue / list_issues | issues().list/get/create/... |

Use octocrab's typed models where available and its GraphQL client (`octocrab.graphql(...)`)for review-thread resolution and mergeability detail not exposed by REST.

### 7.6 Workspace ↔ PR linkage + periodic refresh

Port the matching rule from `Workspace` (`src/shared/types.ts`): a PR belongs to a workspacewhen `pr.head.ref === workspace.branch` (the workspace's **own** branch), **not** `baseRef`(the parent it was created from). Store `prNumber`/`prUrl`/`prStatus`/`activePullRequest` onthe workspace record. A background task refreshes linked PRs on an interval (and on demand)and emits `pr:*` events so the FE updates without polling. Respect `repositoryOwner`/`repositoryName` from the workspace for the active provider's `(owner, repo)` pair.

### 7.7 Rate limiting & retry

- Read `x-ratelimit-remaining` / `x-ratelimit-reset` from responses; when low, defernon-urgent refreshes until reset.
- Retry transient failures (5xx, secondary-rate-limit `403 + Retry-After`, network errors)with exponential backoff + jitter (`backoff` crate); cap attempts and surface a structurederror on exhaustion.
- A single shared rate-limit governor across all forge calls so background refresh neverstarves interactive requests.

## 8. Context Engine

### 8.1 The `ContextEngine` trait

Code retrieval in Intent is **not** a separable indexer — it comes from auggie/Augment(`src/features/auggie/main/execute-auggie-command.ts`). Model it as an **optional**capability behind a trait so the daemon degrades gracefully when it is absent.

```rust
#[async_trait::async_trait]
pub trait ContextEngine: Send + Sync {
    /// Is a working engine available right now?
    async fn availability(&self) -> EngineAvailability;

    /// Natural-language code/context retrieval scoped to a workspace.
    async fn retrieve(&self, req: RetrieveRequest) -> Result<RetrieveResult, ContextError>;
}

pub enum EngineAvailability {
    Available { name: String, version: Option<String> },
    Unavailable { reason: String },   // never an error — a first-class state
}

pub struct RetrieveRequest {
    pub workspace_id: WorkspaceId,
    pub workspace_path: PathBuf,
    pub query: String,
    pub max_results: Option<usize>,
}
```

### 8.2 `AuggieContextEngine` impl + discovery

- **Discovery** (port `auggie-path` / `getEnhancedPath` / `findAuggiePathAsync`): search`PATH`, then `~/.augment/bin`, with an **enhanced PATH** so GUI/daemon-launched processes(minimal PATH) still find the binary and its co-located `node`. Cache the resolved path;re-probe if it disappears.
- **Execution** (port `executeAuggieCommand`): run the auggie CLI with the enhanced PATH anda timeout (default 30s). On macOS/Linux prefer `execFile`-style spawning (no shell) toavoid shells unavailable to Finder-launched apps; on Windows handle `.cmd`/`.bat` shims.Pipe queries via stdin when needed. Capture stdout/stderr; map auth-failure patterns to a"needs login" availability state.
- Retrieval may reuse the running auggie ACP session's indexing (`--allow-indexing`) ratherthan a separate process, when an agent session for that workspace already exists.

### 8.3 Graceful "not available" contract

- `availability()` returning `Unavailable { reason }` is a **normal** result, never an errorthat crashes a request. Construction of the engine never fails the daemon.
- RPC methods that depend on retrieval (e.g. an agent's context tool) return a structured,typed result: `{ available: false, reason }` so the FE/agent can show a clear message("Context engine not available: auggie not found on PATH") and continue.
- `intentd doctor` reports context-engine status as a non-fatal check.
- The daemon must be **fully functional without** a context engine — all non-retrievalfeatures (workspaces, notes, agents, git, PRs) work regardless.

## 9. State Model & Persistence

`intentd` owns all durable state. Port the entities from `src/shared/types.ts`,`src/shared/types/agent-session.ts`, and `src/features/comments/comment-types-v2.ts`.

### 9.1 Entity definitions (Rust structs)

Use `#[serde(rename_all = "camelCase")]` on every wire-facing struct so JSON matches theexisting TS types (and `PROTOCOL.md`). Timestamps are RFC-3339 strings (`time::OffsetDateTime`serialized as ISO-8601, matching TS `toISOString()`).

```rust
pub struct Workspace {
    pub id: WorkspaceId,
    pub title: String,
    pub branch: String,                 // workspace's own branch (PR match key)
    pub base_ref: Option<String>,       // parent branch it was created from
    pub base_commit_sha: Option<String>,
    pub status: WorkspaceStatus,        // Active | Archived | Deleted (lifecycle)
    pub status_message: Option<String>, // user-facing high-level message
    pub activity: WorkspaceActivity,    // Idle | AgentRunning — derived (green dot); BE-computed, read-only (§9.9)
    pub attention: WorkspaceAttention,  // None | Unread | ReviewRequired — dismissible (blue dot); server-owned, cleared via RPC (§9.9)
    pub created_at: String,
    pub updated_at: String,
    pub last_activity: Option<String>,
    pub tags: Vec<String>,
    pub path: Option<String>,
    pub repository_owner: Option<String>,
    pub repository_name: Option<String>,
    pub worktree_path: Option<String>,
    pub scope: Option<String>,          // relative subdir within worktree
    pub skip_worktree: bool,
    pub setup_script: Option<String>,
    pub is_remote: bool,
    pub default_model: Option<String>,
    pub pr_number: Option<u64>,
    pub pr_url: Option<String>,
    pub archived: bool,
    pub archived_at: Option<String>,
}

pub struct Note {
    pub id: NoteId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub content: String,
    pub content_type: ContentType,      // Markdown | PlainText | Json | Code
    pub tags: Vec<String>,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub is_default: bool,               // the workspace spec note
    pub parent_id: Option<NoteId>,      // sidebar hierarchy = task dependency graph
    pub visibility: NoteVisibility,     // Private | Workspace | Shared | Public
    pub task: Option<TaskMetadata>,     // present iff this note is a task
    pub created_at: String,
    pub updated_at: String,
}

pub struct TaskMetadata {              // tasks are notes + this metadata
    pub status: TaskStatus,            // not_started|waiting|discussion_needed|
                                       // in_progress|review_required|complete|cancelled
    pub assigned_agent_ids: Vec<AgentId>,
    pub acceptance_criteria: Vec<String>,
    pub estimated_effort: Option<String>,
    pub actual_effort: Option<String>,
    pub blocked_reason: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub peer_order: Option<i64>,       // sibling ordering (gaps of 100)
}

pub struct Comment {                   // CommentV2 union flattened
    pub id: String,
    pub thread_id: String,
    pub note_id: Option<NoteId>,
    pub kind: CommentType,             // comment|suggestion|change-request|question|session
    pub content: String,
    pub author: String,
    pub author_type: AuthorType,       // user | agent
    pub status: CommentStatus,         // open|resolved|accepted|rejected|pending
    pub parent_id: Option<String>,
    pub anchor: CommentAnchor,         // range{startId,endId} | point{pointId}
    pub anchor_text: Option<String>,
    pub anchor_before: Option<String>,
    pub anchor_after: Option<String>,
    pub suggestion_original: Option<String>, // suggestion kind
    pub suggestion_proposed: Option<String>,
    pub agent_id: Option<AgentId>,           // session kind
    pub created_at: String,
    pub updated_at: String,
}

pub struct AgentSession {
    pub id: AgentId,
    pub workspace_id: WorkspaceId,
    pub backend_session_id: Option<AgentId>,
    pub acp_session_id: Option<String>,  // ACP UUID for session/load resume
    pub name: String,
    pub name_explicitly_set: bool,
    pub model: Option<String>,
    pub provider: Option<String>,        // immutable after first real use
    pub system_prompt: Option<String>,
    pub status: AgentStatus,
    pub is_active: bool,
    pub messages: Vec<AgentMessage>,     // append-only conversation log
    pub stats: Option<SessionStats>,     // credits/message/tool stats; populated from `auggie session stats --json` (§19.2)
    pub created_at: String,
    pub updated_at: String,
}

pub struct Event {                       // append-only; see §10 / events/types.ts
    pub id: String,
    pub workspace_id: WorkspaceId,
    pub timestamp: String,
    pub event_type: String,              // e.g. "agent:tool:call", "file:changed"
    pub actor: EventActor,               // user|agent|system|git|external
    pub session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub data: serde_json::Value,         // type-specific payload
}

pub struct Settings {                    // key/value, typed accessors
    pub ws_api_enabled: bool,
    pub ws_api_token: Option<String>,    // stored in keychain, not this row, in practice
    pub discovery_enabled: bool,
    pub default_provider: String,
    pub github_base_uri: Option<String>,
    // ... extensible
}

pub struct Specialist {                  // agent role presets (coordinator/implementor/verifier)
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub default_model: Option<String>,
    pub tool_denylist: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

// --- Integrations & Ops (§19) ---

pub struct TokenUsageTotals {            // the 4 consumption counters (§19.1)
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

pub struct TokenUsage {                  // workspace.getTokenUsage result; durable `tokenUsage` workspace field (§19.1)
    pub by_agent_id: HashMap<AgentId, TokenUsageTotals>, // per-agent totals
    pub totals: TokenUsageTotals,        // workspace-wide totals
    pub by_model: HashMap<String, TokenUsageTotals>,     // keyed by effective_model_name ("unknown" fallback)
    pub last_scan_at: Option<String>,    // RFC-3339; None before the first scan
}

pub struct SessionStats {                // agent.getSessionStats result; `stats` field on AgentSession (§19.2)
    pub credits_used: Option<f64>,       // None until credits are computed
    pub message_count: u64,
    pub tool_count: u64,
}

pub enum ProjectType {                   // workspace.detectProjectType result (§19.3)
    Node, Python, Go, Rust, Ruby,
}
```

### 9.2 SQLite schema (tables, indexes)

SQLite is the system of record for structured data; large note bodies may *also* be mirroredto the file tree (§9.3) for git-friendliness, but SQLite is authoritative.

```sql
CREATE TABLE workspace (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  branch          TEXT NOT NULL,
  base_ref        TEXT,
  base_commit_sha TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  status_message  TEXT,
  attention       TEXT NOT NULL DEFAULT 'none', -- dismissible blue-dot state (server-owned; §9.9). activity is derived, not stored.
  repository_owner TEXT,
  repository_name  TEXT,
  worktree_path   TEXT,
  scope           TEXT,
  skip_worktree   INTEGER NOT NULL DEFAULT 0,
  is_remote       INTEGER NOT NULL DEFAULT 0,
  default_model   TEXT,
  pr_number       INTEGER,
  pr_url          TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',     -- JSON array
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_activity   TEXT
);

CREATE TABLE note (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'markdown',
  tags         TEXT NOT NULL DEFAULT '[]',
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  is_archived  INTEGER NOT NULL DEFAULT 0,
  is_default   INTEGER NOT NULL DEFAULT 0,
  parent_id    TEXT REFERENCES note(id) ON DELETE SET NULL,
  visibility   TEXT NOT NULL DEFAULT 'workspace',
  task_json    TEXT,                              -- serialized TaskMetadata or NULL
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_note_workspace ON note(workspace_id);
CREATE INDEX idx_note_parent    ON note(parent_id);
CREATE INDEX idx_note_task      ON note(workspace_id) WHERE task_json IS NOT NULL;

CREATE TABLE comment (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  note_id       TEXT REFERENCES note(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_type   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  parent_id     TEXT,
  anchor_json   TEXT NOT NULL,
  anchor_text   TEXT,
  extra_json    TEXT,                             -- suggestion/session-specific fields
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_comment_note   ON comment(note_id);
CREATE INDEX idx_comment_thread ON comment(thread_id);

CREATE TABLE agent_session (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  backend_session_id TEXT,
  acp_session_id     TEXT,
  name               TEXT NOT NULL,
  model              TEXT,
  provider           TEXT,
  status             TEXT NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 0,
  system_prompt      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_agent_workspace ON agent_session(workspace_id);

-- Append-only conversation log (one row per message; never updated)
CREATE TABLE agent_message (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,                    -- monotonic per agent
  role       TEXT NOT NULL,                       -- user|assistant|tool|system
  content    TEXT NOT NULL,                       -- JSON content blocks
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, seq)
);

-- Append-only event log
CREATE TABLE event (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  actor           TEXT NOT NULL,
  session_id      TEXT,
  correlation_id  TEXT,
  parent_event_id TEXT,
  data_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_event_ws_time ON event(workspace_id, timestamp);
CREATE INDEX idx_event_type    ON event(event_type);
CREATE INDEX idx_event_session ON event(session_id);

CREATE TABLE specialist (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  default_model TEXT,
  tool_denylist TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                              -- JSON-encoded value
);

-- Logical clients (stable, client-supplied identity; §16). The ephemeral
-- per-connection id (ws-<ts>-<rand>) is transport-only and never stored here.
CREATE TABLE client (
  id            TEXT PRIMARY KEY,                  -- client-persisted UUID (or server-minted)
  name          TEXT,                              -- human label from client.hello
  capabilities  TEXT NOT NULL DEFAULT '{}',        -- JSON capability bag
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

-- Per-client chat drafts (§9.10) — replaces FE localStorage chatDrafts.
CREATE TABLE draft (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,                      -- target agent/session
  client_id    TEXT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, client_id)
);
CREATE INDEX idx_draft_client ON draft(client_id);

-- Per-file agent-change audit trail (§9.11, §17.4). One row per file as it moves
-- through git stages; raw content is lazy via git blob SHAs, not inlined. Written
-- by the INTERNAL file-tracking pipeline (track-change), read over the wire.
CREATE TABLE tracked_changes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                    -- repo-relative file path
  stage         TEXT NOT NULL,                    -- unstaged|staged|committed|pushed|pr|merged
  status        TEXT NOT NULL,                    -- added|modified|deleted|renamed
  agent_id      TEXT,                             -- attribution: which agent wrote it
  session_id    TEXT,                             -- attribution: ACP/session id
  turn          INTEGER,                          -- attribution: conversation turn
  commit_hash   TEXT,                             -- set once committed
  old_blob_sha  TEXT,                             -- lazy content via git blob SHAs
  new_blob_sha  TEXT,
  additions     INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_tracked_changes_ws     ON tracked_changes(workspace_id);
CREATE INDEX idx_tracked_changes_path   ON tracked_changes(workspace_id, path);
CREATE INDEX idx_tracked_changes_commit ON tracked_changes(commit_hash);
CREATE INDEX idx_tracked_changes_agent  ON tracked_changes(agent_id);

-- Persistent diff storage (§9.11, §17.3), independent of raw git so a change's
-- before/after + hunks survive staging/commit churn. INTERNAL storage only:
-- there are NO `diffs.*` wire methods; diffs surface via file-tracking + events.
CREATE TABLE diffs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  staged        INTEGER NOT NULL DEFAULT 0,
  old_content   TEXT,                             -- nullable for adds/deletes; large blobs lazy via SHAs
  new_content   TEXT,
  hunks_json    TEXT NOT NULL DEFAULT '[]',       -- extracted change hunks
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(workspace_id, file_path, staged)
);
CREATE INDEX idx_diffs_ws ON diffs(workspace_id);

-- Aggregated per-workspace change metrics (§9.11, §17.5). Durable. Updated by the
-- INTERNAL metrics aggregator; read via metrics.getWorkspaceStats (no calculate RPC).
CREATE TABLE workspace_metrics (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  additions     INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

-- Aggregated per-agent change metrics (§9.11, §17.5). Durable; powers the
-- "by agent" breakdown. Read via metrics.getAgentStats; reset via metrics.clearAgentStats.
CREATE TABLE agent_metrics (
  agent_id      TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  additions     INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);
CREATE INDEX idx_agent_metrics_agent ON agent_metrics(agent_id);

-- Long-term agent memory (§9.12, §18.5). DEFERRED as a wire surface — there is NO `memories.*`
-- RPC in v1; rows are written/read INTERNALLY and exposed to agents through the agent→BE MCP
-- callback (§6.8) as a context source. Ports src/features/memories/main/memories.service.ts.
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE INDEX idx_memories_ws ON memories(workspace_id);

-- Cached workspace token usage (§9.13, §19.1). Durable cache of the daemon-internal
-- periodic usage scan; the `tokenUsage` workspace field is materialized from this row.
-- READ over the wire via workspace.getTokenUsage; SCANNING/writes are INTERNAL (no RPC).
-- `last_message_id` is the per-agent cache-validity token (skip re-reading a session file
-- whose last message id is unchanged), mirroring src/features/token-usage's CachedAgentTokens.
CREATE TABLE token_usage (
  workspace_id    TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,                  -- per-agent row; workspace totals are summed
  session_id      TEXT,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  by_model        TEXT NOT NULL DEFAULT '{}',     -- JSON: per-model TokenUsageTotals breakdown
  last_message_id TEXT,                            -- cache-validity token
  last_scan_at    TEXT,                            -- RFC-3339 of the last completed scan
  PRIMARY KEY (workspace_id, agent_id)
);
CREATE INDEX idx_token_usage_ws ON token_usage(workspace_id);
```

### 9.3 File layout

```text
$DATA_DIR/intentd/
├── intentd.db                 # SQLite (authoritative structured state)
├── intentd.db-wal             # WAL
├── config.toml                # user config (non-secret)
├── ws-cert.pem / ws-key.pem   # TLS cert + key (0644 / 0600)
├── intentd.sock               # UDS (runtime dir on Linux)
├── intentd.pid                # single-instance pidfile
├── logs/intentd.log           # rotated tracing logs
└── workspaces/<workspace-id>/ # optional file mirror of notes (git-friendly)
    └── .workspace/notes/*.md
```

Notes are **file-first compatible**: Intent stores notes under `<ws>/.workspace/`. `intentd`keeps SQLite authoritative but can mirror note bodies to `.workspace/notes/*.md` so they arediffable/committable. The mirror is derived state; on conflict, a configurable policy decides(DB-wins by default).

### 9.4 Migrations

Use `sqlx::migrate!` (embedded `migrations/NNNN_*.sql`). On startup, open the DB(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`), run pendingmigrations transactionally, and record the schema version. `intentd doctor` reports whethermigrations are current. Never auto-downgrade; refuse to start on a newer-than-known schema.

### 9.5 Concurrency / locking

- **DB concurrency:** WAL mode + a bounded connection pool (`sqlx::SqlitePool`). Writers areserialized by SQLite; keep transactions short. Use `busy_timeout` to ride out contention.
- **Worktree lock:** port `withGitWorktreeLock` — a per-worktree async mutex (keyed byworktree path) guards git operations (checkout, worktree add/remove, commit) so concurrentagents/operations on the same worktree never corrupt the index. Implement as a`Mutex`-per-path map (`dashmap` or a `Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>`).
- **Append-only invariants:** `agent_message` and `event` are insert-only; enforce via therepository API (no update/delete paths) and the `UNIQUE(agent_id, seq)` constraint.
- **Provider immutability:** once `agent_session.provider` is set on first real use, therepository rejects changes (mirrors the TS "provider locked after first use").

### 9.6 IDs & timestamps

- IDs are string newtypes (`WorkspaceId`, `NoteId`, `AgentId`) wrapping UUIDs. Use **UUIDv7**for time-sortable ids on append-heavy tables (`event`, `agent_message`); UUIDv4 elsewhere.Keep the branded-id discipline from `src/shared/types/branded-ids.ts`.
- Timestamps are RFC-3339 / ISO-8601 UTC strings to match the existing wire format. Provide asingle `now_iso()` helper; never format timestamps ad hoc.

### 9.7 Optional import from existing Intent workspaces

Provide `intentd import --from <intent-userData-dir>` to migrate an existing install:

- Read Intent's persisted workspaces and `<ws>/.workspace/` note files; map TS entities →Rust structs (the field mapping is 1:1 by design — see §9.1).
- Import is **idempotent** (upsert by id) and **read-only** toward the source (never mutatesthe Intent install). Report a summary (counts, skips, conflicts). Agent runtime sessionsare *not* imported live — only their persisted metadata/messages.

### 9.8 Settings store & BE-relevant configuration

`intentd` owns every setting that affects **server-side** behavior. In `augmentcode/intent`the Electron app keeps settings FE-side (electron-store / local-storage / Redux); for thedaemon, anything that changes server behavior must move into `intentd` and be mutable overthe wire via the `settings.*` namespace (see `./PROTOCOL.md` §5). Settings fall into threegroups.

**Group A — BE-owned, ported from **`augmentcode/intent` (defined in`src/shared/app-settings-schema.ts`; `intentd` must own + expose these):

| path | type | default | sensitive | source in augmentcode/intent |
| --- | --- | --- | --- | --- |
| providers.active | string | first enabled | no | src/shared/app-settings-schema.ts |
| providers.enabled | string[] | all known | no | src/shared/app-settings-schema.ts |
| providers.paths.{auggie,claude-code,codex,…} | map<string,path> | {} | no | src/shared/app-settings-schema.ts |
| model.default | string | provider default | no | src/shared/app-settings-schema.ts |
| model.providerDefaults | map | {} | no | src/shared/app-settings-schema.ts |
| model.workspaceOverrides | map | {} | no | src/shared/app-settings-schema.ts |
| backgroundAgents.defaultModel | string | — | no | src/shared/app-settings-schema.ts |
| backgroundAgents.typeOverrides | map | {} | no | src/shared/app-settings-schema.ts |
| backgroundAgents.providerSettings | map | {} | no | src/shared/app-settings-schema.ts |
| specialists.default | string | implementor | no | src/shared/app-settings-schema.ts |
| workspace.branchPrefix | string | — | no | src/shared/app-settings-schema.ts |
| workspace.worktreesLocation | path | — | no | src/shared/app-settings-schema.ts |
| workspace.sshKeyPath | path | — | yes | src/shared/app-settings-schema.ts |
| workspace.defaultShell | string | $SHELL | no | src/shared/app-settings-schema.ts |
| workspace.autoFetch | bool | true | no | src/shared/app-settings-schema.ts |
| workspace.autoCommit | bool | true | no | src/shared/app-settings-schema.ts |
| mcp.enableUserServers | bool | true | no | src/shared/app-settings-schema.ts |
| mcp.disabledServers | string[] | [] | no | src/shared/app-settings-schema.ts |
| mcp.servers | map (server config) | {} | yes | src/shared/app-settings-schema.ts |

**Group B — new **`intentd`**-only settings** (host/daemon concerns the Electron app handledimplicitly; not present in `app-settings-schema.ts`):

| path | type | default | sensitive | source |
| --- | --- | --- | --- | --- |
| server.listenMode | enum (uds|tcp|both) | uds | no | new / intentd-only |
| server.socketPath | path | XDG runtime dir | no | new / intentd-only |
| server.bindAddress | string | 0.0.0.0 | no | new / intentd-only |
| server.port | u16 | 5180 | no | new / intentd-only |
| server.tls.enabled | bool | false (auto on tcp) | no | new / intentd-only |
| server.auth.enabled | bool | true on tcp | no | new / intentd-only |
| server.auth.token | string | generated | yes (read-only / regenerate) | new / intentd-only |
| server.originAllowList | string[] | loopback / file:// / hostname | no | new / intentd-only |
| server.discovery.enabled | bool | false | no | new / intentd-only |
| sourceControl.activeProvider | enum (github) | github | no | new / intentd-only |
| sourceControl.github.tokenSource | enum (env|gh-cli|explicit) | gh-cli | no | new / intentd-only |
| sourceControl.github.token | string | — | yes | new / intentd-only |
| sourceControl.github.apiBaseUrl | url | https://api.github.com | no | new / intentd-only |
| context.enabled | bool | true | no | new / intentd-only |
| context.auggiePath | path | discovered | no | new / intentd-only |
| context.allowIndexing | bool | true | no | new / intentd-only |
| storage.dataDir | path | platform data dir (§11.2) | no | new / intentd-only |
| workspaces.root | path | — | no | new / intentd-only |
| logging.level | enum (error|warn|info|debug|trace) | info | no | new / intentd-only |
| agents.maxConcurrent | u32 | 8 | no | new / intentd-only |
| agents.idleReapMinutes | u32 | 30 | no | new / intentd-only |

Source-control provider config is namespaced as `sourceControl.<provider>.*` so future hostsslot in cleanly (e.g. `sourceControl.gitlab.{tokenSource,token,apiBaseUrl}`,`sourceControl.bitbucket.*`); `sourceControl.activeProvider` chooses the active impl (§7.4).

**Group C — FE-only (explicitly OUT of **`intentd`** scope; NOT persisted by intentd):**`theme.*`, `fonts.*`, `ui.*`, `notifications.*` (display), `workspaceList.*`, `openIn.*`,`keybindings.*`, `promoBanners.*`, `activityLog.presets`, `model.pickerCollapsedGroups`,`preferences.spellcheckEnabled`, `preferences.betaUpdatesEnabled`, `providers.completedSetup`,`accounts.sentry`, `rtk.enabled`, `linear.issueFilter`. These remain client-side UI state; thedaemon neither stores nor exposes them.

#### Persistence, validation, secrets

- **Storage.** Non-secret values persist in the `settings` table (§9.2, `key` → JSON`value`). Definitions (label, description, category, type, enum/min/max, default, sensitive,scope) are ported from `app-settings-schema.ts` as `AppSettingDefinition`s; group B adds itsown definitions. Non-secret settings may also be surfaced in `config.toml` (§11.2), but theDB row is authoritative.
- **Validation.** Every mutation is validated against its `AppSettingDefinition` (type, enummembership, numeric min/max) via the analog of `findAppSettingDefinition` before persisting;invalid changes are rejected with an `invalid params` error and nothing is written.
- **Secrets.** Settings marked **sensitive** (`workspace.sshKeyPath`, `mcp.servers`,`server.auth.token`, `sourceControl.github.token`) are stored securely in the OS keychain(`keyring` crate), never in `config.toml`, never in logs, and are **never returned inplaintext over the wire** — `settings.list`/`settings.get` redact them (presence/placeholderonly). `server.auth.token` is read-only via the API (regenerate, not set).
- **Change notification.** A successful `settings.update`/`settings.reset` persists the changeand emits a `settings:changed` event (§10) so every connected client stays in sync.

The wire methods (`settings.list`, `settings.get`, `settings.update`, `settings.reset`) andthe `settings:changed` event are specified in `./PROTOCOL.md` §5 — an **intentd-only**namespace added on top of the 106 ported methods.

### 9.9 Workspace status & attention (lightweight)

This is a **lightweight, BE-owned status model on the Workspace entity** — explicitly **not**a general notification/item store. It promotes today's per-client, localStorage-based unreadtracking (`src/store/renderer/slices/unread-tracking/`) into **shared back-end state** sothe little status dots in the FE (`src/lib/components/workspace/WorkspaceStatusIcon.svelte`,`src/lib/components/layout/sidebar-nav/cards/AllWorkspacesCard.svelte`,`src/lib/components/workspace/WorkspaceTableView.svelte`) are computed once by the daemon andstay consistent across every connected client.

Two fields are added to the `Workspace` entity (§9.1):

| Field | Type | Dot | Ownership | Semantics |
| --- | --- | --- | --- | --- |
| `activity` | `WorkspaceActivity` = `Idle \| AgentRunning` | green | **derived, read-only** | `AgentRunning` iff the workspace has **any in-flight agent session** (the daemon already tracks this in the AgentManager, §6.8). Recomputed on agent lifecycle transitions; never written by clients. |
| `attention` | `WorkspaceAttention` = `None \| Unread \| ReviewRequired` | blue | **server-owned, dismissible** | Raised by the BE when something happens a viewer should look at (e.g. an agent finished, a PR review is required). Cleared via RPC; because it lives on the server, **dismissal syncs across all clients** rather than per-browser localStorage. |

- **Derivation vs. storage.** `activity` is **derived** from live agent state and is **notpersisted** (it is recomputed on load and on every agent transition). `attention` **ispersisted** so a dismissal survives restarts and is visible to every client — see the`attention` column added to the `workspace` table (§9.2).
- **Dismissal RPC.** Attention is dismissed by an intentd-only `workspace.*` method(`workspace.dismissAttention` / `workspace.markSeen`; specified in `./PROTOCOL.md` §5 alongside theother additive namespaces). The mutation persists `attention = 'none'` and emits`workspace:attention-changed` (§10.1) so every client clears the blue dot together.
- **Change events.** `activity` and `attention` transitions emit self-sufficientevents (§10.1): `workspace:activity-changed` and `workspace:attention-changed` carrying thenew value, so the FE updates the dot directly with no follow-up fetch.
- **Scope note.** This intentionally replaces per-client unread booleans with a single sharedflag. **Per-viewer read cursors** (distinct unread state per user/device) are a deliberate**future extension**, not part of this lightweight model.

These fields and the `workspace.dismissAttention`/`workspace.markSeen` methods are **additive** on topof the 106 ported methods, consistent with the framing in §9.8 (106 ported + additive:`settings.*`, workspace status/attention, interactive `terminal.*`, `forward.*`/`host.openExternal`,`search.*`, `drafts.*`, `client.hello`).

### 9.10 Drafts (BE-persisted, per-client)

Chat **drafts** (typed-but-not-yet-sent message text) are promoted out of the FE'sper-client `localStorage` into **shared, BE-owned state**. In `augmentcode/intent` thislives entirely in the renderer: `src/store/renderer/slices/transient-ui/transient-ui-slice.ts`holds `chatDrafts: Record<agentId, string>` per workspace, persisted to `localStorage`(`workspace-transient-ui-*`); `src/lib/components/chat/ChatPanel.svelte` saves viasetChatDraft / restores via selectChatDraft and clears on send. Persisting in the BE letsa draft survive a browser refresh, follow the user across devices/windows of the *same*client, and removes the last meaningful piece of durable chat state from the thin FE.

The `Draft` entity is keyed by the triple **`(workspaceId, agentId, clientId)`** — see the`draft` table in §9.2 — so concurrent clients writing into the same agent input **do notclobber each other**. The `clientId` component is the stable logical client identity (§16);it is what makes per-client disambiguation possible at all.

```rust
pub struct Draft {
    pub workspace_id: WorkspaceId,
    pub agent_id: AgentId,
    pub client_id: ClientId,        // stable logical client (§16), not the connection id
    pub text: String,
    pub updated_at: String,
}
```

- **Default semantics: per-client private.** Each client only sees and restores its owndraft for a given `(workspaceId, agentId)`; the BE resolves `clientId` from the callingconnection's `client.hello` mapping, so the FE never passes it explicitly.
- **Cleared on send.** Sending the message (or an explicit clear) deletes the row, matchingtoday's FE behavior; an empty `drafts.set` is treated as a clear.
- **Future shared/collaborative drafts are out of scope for v1.** A future opt-in mode couldshare one draft across clients (e.g. for pairing); the `(…, clientId)` key already leavesroom for it without a schema change.

The wire methods (`drafts.get`, `drafts.set`, `drafts.clear`) and the optional`draft:changed` event are specified in `./PROTOCOL.md` §5/§6 (see §15 here for behavior) — anintentd-only namespace **additive** on top of the 106 ported methods.

### 9.11 Code-change tracking, diffs & metrics (internal pipeline)

This is the durable state behind the **Code Changes Review** domain (§17). It ports the agent-IDE review loop from `augmentcode/intent`'s `src/features/file-tracking/`, `src/features/diffs/`, and `src/features/line-changes/`. **Crucially, the *writers* of all of this state are BE-internal** (the file-tracking sync pipeline, the diff extractor, the metrics aggregator), driven by the agent/git lifecycle, not by client RPCs — the cross-cutting principle (§17.1). The FE only *reads* it (file-tracking reads, §17.4; metrics reads, §17.5) and is kept live via events.

- **`tracked_changes`** — the per-file audit trail (one row per file as it moves `unstaged → staged → committed → pushed → pr → merged`) with **agent attribution** (`agent_id`, `session_id`, `turn`) so the FE can show *who* changed *what*. Raw content is **lazy** via git blob SHAs (`old_blob_sha`/`new_blob_sha`), mirroring `file-tracking-storage.ts`'s blob-SHA strategy rather than inlining file bodies.
- **`diffs`** — **persistent diff storage**, independent of raw git, so a change's before/after + extracted hunks survive staging/commit churn (ports `src/features/diffs/main/diffs.repository.ts` + `extract-change-hunks.ts`). **Storage is internal: there are no `diffs.*` wire methods** (§17.3); diffs reach the FE through file-tracking reads and change events.
- **`workspace_metrics` / `agent_metrics`** — **durable** aggregated additions/deletions (per workspace and per agent), ported from `line-changes-main-state.ts`. **Durable is recommended over ephemeral** so cumulative attribution survives daemon restarts and the FE can render historical "lines changed by agent" without recomputation. The aggregator updates them internally; the FE reads via the metrics reads (§17.5).

**Diff persistence decision (hybrid).** Keep the diff **index + hunks in SQLite** (cheap to query for the review UI) but back full file *content* **lazily via git blob SHAs** instead of inlining large blobs — the hybrid the source already implies (`file-tracking-storage.ts`). See the `tracked_changes`, `diffs`, `workspace_metrics`, and `agent_metrics` tables in §9.2.

### 9.12 Agent-ecosystem state (rules, specialists, MCP servers, memories)

This is the persistence behind the **Agent Ecosystem** domain (§18). Three storage strategies coexist, matching how `augmentcode/intent` stores each today — **most agent-ecosystem state is file- or settings-backed, not new SQLite tables**:

- **Workspace & specialization rules — files, not DB.** Workspace rules (`AGENTS.md`, `CLAUDE.md`, `.augment/guidelines.md`, `.augment/rules/*.md`) live in the repo and are read **live** off the worktree by the rules loader (ports `src/features/agent/main/rules-loader.ts`, which fixes the precedence order); `intentd` does not copy them into the DB.
- **User-rule overrides — settings store.** The per-rule-type user overrides (`base-system-prompt`, the per-agent-type specialization rules, `workspace`, …) that `EndUserRulesManager` keeps in electron-store under `endUserRules` (ports `src/features/rules/user-rules.service.ts`) port onto the `settings` table (§9.2) under an `endUserRules` key — `{ enabled, content, updatedAt }` per rule type. This is the **only** rules data with a wire surface (`rules.*`, §18.1).
- **Specialists — files, not DB.** Specialist definitions are markdown-with-frontmatter files resolved 3-tier (project > user > bundled): `<ws>/.augment/specialists/` (project), `~/.augment/specialists/` (user), `resources/specialists/` (bundled). `specialist.*` CRUD (§18.2) writes user/project files; nothing is stored in SQLite (ports `src/features/specialists/main/specialist-file-loader.ts`).
- **External MCP servers — config in settings (sensitive).** `mcp.servers` (plus `mcp.enableUserServers`/`mcp.disabledServers`) is the `mcp.servers.*` (§18.3) source of truth and is already declared **sensitive** in §9.8 group A (stored in the OS keychain, redacted over the wire; ports `src/features/mcp/main/user-mcp-settings.ts`). Running-server status is **runtime-only** (not persisted) and surfaced via the `mcp.servers:status-changed` event.
- **`memories` table (new) — internal, deferred wire surface.** A `memories` table (§9.2) backs long-term agent memory. In v1 it has **no `memories.*` RPC** (§18.5): rows are written/read internally and exposed to agents through the agent→BE MCP callback (§6.8) as a context source. The table exists now so the surface can be promoted to RPC later without a migration.

### 9.13 Integrations & Ops state (usage metrics, session stats, setup scripts)

This is the persistence behind the **Integrations & Ops** domain (§19). It ports `src/features/token-usage/`, `src/features/session-stats/`, and `src/features/setup-scripts/`. As with the rest of the gap audit, the *producers* of usage state are BE-internal (the periodic scanner), and only reads + change events cross the wire (§19.1–19.2).

- **`tokenUsage` — durable workspace field, cached in the `token_usage` table.** Per-agent token totals (`input`/`output`/`cacheRead`/`cacheCreation`) plus a per-model breakdown are computed by the **daemon-internal periodic scan job** (ports `token-usage-scanner.ts` `scanWorkspaceTokenUsage`) and cached in the `token_usage` table (§9.2), keyed `(workspaceId, agentId)`. The materialized `TokenUsage { byAgentId, totals, byModel, lastScanAt }` (§9.1) is what `workspace.getTokenUsage` returns and is exposed as the durable `tokenUsage` workspace field; the per-agent `lastMessageId` is the cache-validity token so unchanged session files are skipped. The transient `scanning|idle` status is **runtime-only** (not persisted). **No scan/update RPC** — writes are internal; the FE reads + listens for `workspace:tokenUsage-changed` (§19.1).
- **`stats` — field on `AgentSession`, derived from the CLI.** `SessionStats { creditsUsed, messageCount, toolCount }` (§9.1) is populated by calling `auggie session stats <sessionId> --json` (ports `session-stats.service.ts` `getSessionStats`). It lives as the `stats` field on the `AgentSession` entity (§9.1) rather than a separate table — it is a per-session derived snapshot. Read via `agent.getSessionStats`; refreshed values are pushed via `agent:session-stats-changed` (§19.2). `creditsUsed` is nullable (None until computed).
- **`setupScript` — durable workspace field (already in §9.1).** The worktree setup script is the existing `setup_script: Option<String>` field on `Workspace` (§9.1); no new table. It is read/written via `workspace.getSetupScript`/`workspace.saveSetupScript` (ports `setup-scripts.ipc.ts`). `workspace.detectProjectType` returns a `ProjectType` (node|python|go|rust|ruby; the source detector additionally distinguishes package managers — `node-npm/-yarn/-pnpm`, `python-pip/-poetry` — which the BE may collapse to the coarse enum) and `workspace.generateSetupScript` produces an AI-assisted draft (§19.3).

## 10. Events

Port `src/features/events/*` + `src/main/websocket-event-bridge.ts`.

### 10.1 Internal event bus

- A process-wide async broadcast (`tokio::sync::broadcast` for fan-out, plus a bounded`mpsc` ingestion channel) carrying `WorkspaceEvent`. Producers: services (note/task/agent/git/pr/file), the ACP streaming router, and the file watcher.
- Every emitted event is **first persisted** to the append-only `event` table, **then**broadcast. This guarantees the log is the source of truth and late subscribers canback-fill via `event.query`.
- Event taxonomy ports `events/types.ts`: `WorkspaceEventBase { id, workspaceId, timestamp, type, actor, sessionId?, correlationId?, parentEventId?, metadata? }` plus typed `data`.Notable families: `file:changed` (discriminate on `data.action` =`create|modify|delete|rename`; the `file:created/deleted/renamed` strings arereserved-but-unused), `agent:*` lifecycle, `agent:tool:call` (with `toolKind`/`status`),`agent:stream:*` (high-volume chunks), `agent:permission:*`, `pr:*`, `task:*`, `note:*`,plus the workspace-status family `workspace:activity-changed` / `workspace:attention-changed`(§9.9), emitted **only on change**.
- **Event-design rule — self-sufficient payloads.** New events SHOULD carry the **changedentity/field directly in `data`** so a client can apply the update without a follow-upfetch. For example, `workspace:activity-changed` carries `{ workspaceId, activity }` and`workspace:attention-changed` carries `{ workspaceId, attention }`; the FE flips the green/bluedot straight from the notification. The existing event stream and append-only log (§10.2) areunchanged — this rule governs the *shape* of `data`, not the delivery mechanism.

### 10.2 Append-only log

- Insert-only; ordered by `(workspaceId, timestamp)` with a UUIDv7 id as tiebreaker.
- `event.query` supports filtering (type/actor/session/time range) + limit; `event.recentFiles`,`event.agentActivity`, `event.directoryChanges`, `event.workspaceSummary` are conveniencequeries over the same table (full list in `PROTOCOL.md`).
- Optional retention/compaction job trims very old `agent:stream:*` chunk events whilepreserving lifecycle/tool events.

### 10.3 Subscription filter engine

Port `event-filter-engine.ts`:

- A subscription is a set of `EventFilter { field, operator, value }` with operators`equals|not_equals|greater_than|less_than|starts_with|ends_with|contains|matches|in|not_in`.
- `eventMatchesSubscription(event, filters)` returns true iff **all** filters match. Buildfilters from the client's `eventTypes` (+ optional `workspaceId`) via the analog of`createEventTypeSubscriptionFilters` — `eventTypes` supports wildcards like `agent:*`.
- Wildcard/prefix expansion: `agent:*` → `starts_with "agent:"`.

### 10.4 Delivery as JSON-RPC notifications

Port `websocket-event-bridge.ts` exactly:

- `events.subscribe` (params `{ eventTypes: string[], workspaceId?, replaceGroup? }`) returns`{ subscriptionId }`. `replaceGroup` atomically replaces a prior subscription from the sameclient in that group (used by the FE to swap the active-workspace subscription).
- `events.unsubscribe` (params `{ subscriptionId }`) → `{ success }`.
- Matching events are delivered as a JSON-RPC **notification** (no `id`):`{ "jsonrpc": "2.0", "method": "events.event", "params": { "subscriptionId": "...", "event": { "type": "...", "workspaceId": "...", "id": "...", "timestamp": "...", "actor": {...}, "data": {...} } } }`
- **Subscriptions are transport-local runtime state**, keyed per connection, *not* domainstate — exactly the `clientSubscriptions`/`allSubscriptions` design. On disconnect, clean upall of that client's subscriptions (`cleanupClient`); on shutdown, `cleanupAllClients`.
- The bus holds a registered "send to client" callback per connection (the`registerSendCallback` pattern) so the events module never imports the transport directly.

## 11. Error Handling, Logging, Config, Security

### 11.1 Error handling & logging

- **Errors:** libraries use `thiserror` enums (`StoreError`, `AcpError`, `GithubError`,`GitError`, `ContextError`); the binary uses `anyhow` at the composition root. A centralmapping converts domain errors → **JSON-RPC error objects** with stable codes (catalog in`PROTOCOL.md`): `-32700` parse, `-32600` invalid request, `-32601` method not found,`-32602` invalid params, `-32603` internal, plus an application range (e.g. `-32000…-32099`)for `Unauthorized`, `NotFound`, `ProviderAuthRequired`, `ContextUnavailable`,`GithubNotConfigured`, `RateLimited`, `Conflict`.
- **Never panic in request handlers.** Wrap handler execution so a panic becomes a `-32603`internal error (catch via `tokio::task` + `catch_unwind` at the dispatch boundary) and islogged with the correlation id; the connection survives.
- **Logging:** `tracing` with `tracing-subscriber` (`EnvFilter` via `RUST_LOG`/config) and`tracing-appender` for rotated file logs under `logs/`. Use structured fields(`workspace_id`, `agent_id`, `method`, `correlation_id`). `--foreground` logs to stderr.Log levels mirror the TS `Logger` (debug/info/warn/error). **Redact secrets** (tokens,MCP env) in all log output (port `redactMcpEnvForLogging`).

### 11.2 Config & paths (XDG / macOS)

Resolve paths via the `directories` crate (with env overrides `INTENTD_DATA_DIR`,`INTENTD_CONFIG`):

| Purpose | macOS | Linux (XDG) |
| --- | --- | --- |
| Data (DB, certs, workspaces) | ~/Library/Application Support/intentd/ | $XDG_DATA_HOME/intentd/ (~/.local/share/intentd/) |
| Config (config.toml) | ~/Library/Application Support/intentd/ | $XDG_CONFIG_HOME/intentd/ (~/.config/intentd/) |
| Runtime (UDS, pidfile) | ~/Library/Application Support/intentd/ | $XDG_RUNTIME_DIR/intentd/ |
| Logs | ~/Library/Logs/intentd/ | $XDG_STATE_HOME/intentd/logs/ |

`config.toml` holds non-secret settings (listen mode, port, discovery, default provider,GitHub base URI, log level). Secrets (bearer token, GitHub token) live in the **OS keychain**(`keyring` crate), never in `config.toml`.

### 11.3 Security considerations

- **Local-first:** default UDS with `0600` perms means no network exposure unless explicitlyenabled. TCP/TLS requires the user to opt in.
- **Bearer auth everywhere on the network transport**, timing-safe comparison, token inkeychain. Tokens accepted via header or `?token=` query (for browser WS clients).
- **Origin allow-list** on every WS upgrade (loopback / `file://` / own hostname / no-Originnative clients) — reject cross-origin browser upgrades (§5.3).
- **TLS** self-signed + SHA-256 **fingerprint pinning** advertised over mDNS; clients pin onfirst use (TOFU).
- **Path sandboxing:** all agent fs/terminal access is constrained to the session's worktree;reject traversal outside it.
- **Process isolation & reaping:** provider children run with `kill_on_drop`; reaping killsthe whole process group so no orphaned subprocesses linger.
- **Permission gating:** destructive agent actions go through `session/request_permission`with a configurable policy; default-deny for destructive operations in headless mode.
- **Secret hygiene:** never log tokens/MCP env; redact in diagnostics; `intentd doctor`reports presence (boolean), never values.

## 12. Terminal & Script Execution (unified, locality-aware)

**Reframe: the daemon runs where the code is.** Because `intentd` owns the workspace andspawns provider CLIs, it is also the natural place to run **terminals and scripts** — theyexecute on the daemon host, against the real worktree, regardless of where the FE renders.A thin client simply attaches to output streams. This makes terminals/scripts work identicallyfor a local desktop FE and a remote/mobile client.

This section ports `src/features/terminal/main/terminal.ipc.ts`,`src/features/terminal/MainProcessTerminalManager.ts`,`src/features/scripts/main/script-process-manager.ts`, and`src/features/scripts/main/script-output-buffer.ts` into the **`intent-pty`** crate (§3) andreconciles the two into a single host. The interactive `terminal.*` methods and the existing`script.*` methods are specified in `./PROTOCOL.md` §5 (additive `terminal.*` + the ported`script.*` catalog).

### 12.1 Unified `portable-pty` host (terminals **and** scripts)

- A single host built on **`portable-pty`** owns every spawned process — **both interactiveterminals and scripts run as PTYs in the same host**. Running scripts through real PTYs (notbare piped children) means a script and a terminal are the same kind of object, so they can**interact**: shared environment and working directory, signal delivery (Ctrl-C / SIGINT,resize), and **attaching an interactive terminal to a running script's PTY**.
- **Server-side scrollback.** Each PTY has a bounded scrollback ring buffer on the daemon(porting `script-output-buffer.ts`), so output survives client disconnects and a newlyattached client can back-fill recent history before tailing live output.
- **Multi-client attach.** Output is fanned out to every attached client (the broadcastpattern from `MainProcessTerminalManager.ts`); multiple clients can watch/drive the samePTY, and input is serialized into the single PTY master.
- **Session-scoped lifetime.** A PTY's lifetime is tied to its owning session/workspace;reaping a session kills its PTYs (consistent with the ACP `terminal/*` handlers in §6.7,which are fulfilled by this same host).

### 12.2 Scripts reconciled onto the PTY host

The script runner (`script-process-manager.ts`) becomes a thin layer over the unified host,**preserving its existing behavior**:

- **Service vs. command modes** — long-running services vs. one-shot commands.
- **Auto-restart** for service-mode scripts (with the existing backoff/restart policy).
- **URL / port detection** — scan PTY output for served URLs/listening ports; these feed the`forward.*` remote mitigation (§12.4). Detection emits events consumed by the FE just astoday (`src/store/main/slices/workspace-events/sagas/event-triggered-sagas.ts`).

Because scripts are now PTYs, a user can **attach a terminal to a running script** to inspector interact with it, which the previous piped-child design could not do.

### 12.3 Locality detection & host capabilities

The daemon derives whether the FE is **co-located** (same machine) or **remote** and advertisesit so clients adapt:

- **`host.locality` = `local`** when the active transport is the **Unix domain socket**, orwhen explicitly forced via `--mode local` / the `server.locality` setting. A desktop FE may**spawn `intentd` itself over a local UDS**, which is inherently local.
- **`host.locality` = `remote`** when reached over **TCP/WSS**.
- The daemon also reports **`host.hasDisplay`** (is a GUI/display available) and **OS/arch**.
- These capabilities are surfaced via **`intentd status`**, **`intentd doctor`** (§5.7), andthe **mDNS TXT record** (`os`, `arch`, `hasDisplay`, `locality`; §5.4) so a client knowsthe host's nature before/at connect time.

### 12.4 Remote-only mitigations

When `host.locality = remote`, actions that would otherwise assume a local GUI are bridgedto the client:

- **Port-forwarding (`forward.*`).** For URLs/ports detected in script/terminal output(§12.2), the client can request a forwarded tunnel so the remote service is reachable fromthe client machine. `forward.*` is an additive intentd namespace (`./PROTOCOL.md` §5).
- **`host.openExternal` (FE-served RPC).** Opening a URL/file in the *user's* browser orapp must happen on the **client**, so the daemon issues an **`host.openExternal`** request*to* the connected FE (an FE-served method, mirroring the ACP client-served pattern) ratherthan calling the OS itself. On a local host this can resolve directly.
- **Headless GUI-warning.** When `host.hasDisplay = false` and an operation needs a display,the daemon returns/raises a clear **headless warning** instead of silently failing.

These additive namespaces (`terminal.*`, `forward.*`, `host.openExternal`) sit on top of the106 ported methods, consistent with the framing in §9.8/§9.9 (106 ported + additive:`settings.*`, workspace status/attention, interactive `terminal.*`, `forward.*`/`host.openExternal`,`search.*`, `drafts.*`, `client.hello`).

## 13. Testing Strategy & Phased Roadmap

### 13.1 Test pyramid

| Layer | Tooling | What it covers |
| --- | --- | --- |
| Unit | cargo test + #[tokio::test] | Pure logic: model resolution (parseCompoundModelId, tier fallback), event-filter engine (eventMatchesSubscription, wildcard expansion), comment-anchor (de)serialization, error→JSON-RPC code mapping, PR↔workspace match rule (head.ref === branch), path-sandbox traversal rejection, enhanced-PATH assembly. |
| Repository / store | cargo test over a temp SQLite file (or :memory:) | Migrations apply cleanly; CRUD round-trips with camelCase serde parity; append-only invariants (event, agent_message insert-only, UNIQUE(agent_id, seq)); provider-immutability enforcement; cascade deletes; worktree-lock mutual exclusion. |
| Integration (in-process) | spin up the router + services against a temp data-dir | Full JSON-RPC request→response for each method group; event subscribe → mutate → notification delivery; replaceGroup atomic swap; per-connection subscription cleanup on disconnect. |
| Protocol conformance | golden-file tests over PROTOCOL.md | Every method's request/response envelope, error codes, and event notification shape match the documented schema. Fixtures double as FE contract tests. |
| ACP integration (mock agent) | the mock provider (§6.9) driven by a scripted NDJSON fixture | Handshake (initialize/authenticate), session/new/prompt/cancel, streaming session/update → event mapping, client-served fs/* + terminal/* + session/request_permission, stdin write-serialization (no frame interleaving under concurrent sends). |
| E2E / transport | spawn a real intentd serve on UDS + TCP/TLS, drive via intentd call and a WS client | Bind/auth/origin-allow-list, TLS fingerprint, mDNS advertise/resolve, daemon status/stop/doctor, graceful shutdown + session reaping. |

### 13.2 Mock ACP agent

Build a deterministic mock agent (the `mock` provider, `requiresEnvVar=MOCK_AGENT_SCRIPT_PATH`)that replays a scripted sequence of ACP frames:

- Reads JSON-RPC requests on stdin, emits canned `session/update` notifications and a finalstop reason, and can be scripted to issue **agent→client** requests (`fs/read_text_file`,`terminal/create`, `session/request_permission`) to exercise the client-served handlersand the agent→BE MCP callback loop.
- Scenarios cover: happy-path turn, auth-required, mid-turn `session/cancel`, permissiondeny/allow, oversized terminal output (ring-buffer truncation), and malformed-framerecovery (reader resyncs on next `\n`).
- Runs in CI with no network and no real provider binaries, making ACP tests hermetic.

### 13.3 CI gates

- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --all`, and`cargo deny check` (license/advisory) on every PR.
- Coverage via `cargo llvm-cov` with a floor on the core crates (`intent-store`,`intent-acp`, `intent-rpc`, `intent-events`).
- A protocol-drift check: the golden fixtures (§13.1) must stay in sync with `PROTOCOL.md`;a failing diff blocks merge until the doc + fixtures are updated together.

### 13.4 Phased implementation roadmap

Each phase is independently shippable and ends with the listed tests green.

| Phase | Theme | Deliverables | Exit criteria / milestone |
| --- | --- | --- | --- |
| 0 — Skeleton | Project scaffolding | Workspace crates (§3), Cargo.toml (§4), clap CLI shell (serve/call/status/stop/doctor), tracing setup, config/path resolution (§11.2), CI gates (§13.3). | intentd serve --foreground boots and idles; intentd doctor runs; CI green on an empty test suite. |
| 1 — Persistence + core RPC | State engine | SQLite schema + sqlx migrations (§9.2), entity structs + repositories (§9.1), UDS transport + JSON-RPC router + auth (§5), and the workspace.* / note.* / task.* / comment.* method groups. | A client over UDS can CRUD workspaces/notes/tasks/comments; repository + integration tests green; serde camelCase parity verified. |
| 2 — Events | Reactive layer | Event bus + append-only log (§10.1–10.2), filter engine (§10.3), events.subscribe/unsubscribe + events.event notifications (§10.4), file watcher producing file:changed, event.query/recentFiles/agentActivity queries. | subscribe → mutate → notification works end-to-end; per-connection cleanup on disconnect; protocol-conformance fixtures for events pass. |
| 3 — ACP agents | Orchestration core | ACP client (handshake, session new/load/prompt/cancel §6.4–6.5), spawn + enhanced-PATH (§6.2), stdin write-serialization (§6.3), streaming→event routing (§6.6), client-served fs/terminal/permission (§6.7), AgentManager multiplexing + provider registry (§6.8–6.9), and the agent→BE MCP callback server. | Drive the mock agent through a full turn incl. agent→BE tool calls; agent.* RPCs work; ACP integration tests green. First real provider (auggie) runs an end-to-end turn locally. |
| 4 — Git, GitHub, context | External integrations | Git worktree ops + withGitWorktreeLock (§9.5), git.* RPC, SourceControl module (sourcecontrol::github, octocrab) + pr.* catalog + workspace↔PR linkage/refresh (§7), ContextEngine trait + AuggieContextEngine with graceful-unavailable contract (§8), file.* method group. | PR status/merge/review-reply against a live repo (or recorded fixtures); context retrieval works when auggie present and degrades cleanly when absent; intentd doctor validates all integrations. |
| 5 — Remote, discovery, hardening | Productionization | TCP/TLS transport + self-signed cert + fingerprint pinning (§5), origin allow-list, mDNS advertise/resolve (§5), daemonization (launchd/systemd §5.8), intentd import (§9.7), idle session reaping (§5.6), retention/compaction, full security review (§11.3), E2E transport suite. | Remote/mobile client pairs via mDNS + TOFU and drives a real agent over WSS; daemon survives restart and resumes sessions via session/load; all test layers green; ready for a thin Tauri/Svelte FE. |
| 6 — Iteration 3: terminal/PTY, status & remote UX | Unified execution + lightweight status | Unified `portable-pty` host for terminals **and** scripts (§12.1) with server-side scrollback + multi-client attach; script runner reconciled onto it preserving service/command modes, auto-restart, URL/port detection (§12.2); workspace `activity`/`attention` status model + `workspace.dismissAttention`/`workspace.markSeen` + `workspace:activity-changed`/`attention-changed` events (§9.9, §10.1); locality detection + `host.hasDisplay`/OS/arch advertised via status/doctor/mDNS (§12.3); remote-only mitigations `forward.*` + FE-served `host.openExternal` + headless warning (§12.4). | A client (local **and** remote) creates/attaches terminals and scripts with scrollback + multi-client output; attaching a terminal to a running script works; the green/blue workspace dots update from self-sufficient events and dismissal syncs across clients; a remote client opens a detected URL via `forward.*` + `host.openExternal`. |
| 7 — Iteration 4: search, drafts & client identity | BE-owned search + thin-FE state | `client.hello` handshake + live-connection→`clientId` map + `client` table (§16); `search.*` namespace via the `intent-search` crate (grep + ignore + globset) covering inFiles/fileNames/messages/events/memories/notes/codebase with `requestId` cancellation + paged/streamed results, replacing the remote SSH-exec hack and the empty `codebase:search` placeholder (§14); `drafts.*` BE persistence keyed by `(workspaceId, agentId, clientId)` + `draft` table, cleared on send (§9.10, §15). | A reconnecting client keeps a stable `clientId` and restores its own per-agent draft; `search.inFiles` runs `rg`-equivalent search locally on the daemon (incl. when the daemon is the remote host) with cancellation; concurrent clients' drafts never clobber each other; conformance fixtures for `search.*`/`drafts.*`/`client.hello` pass. |
| 8 — Iteration 5 Wave 1: code changes review | BE-owned agent-change review loop | `services::file_tracking`/`diffs`/`accept_changes`/`metrics` modules (§3, §17) over new state tables `tracked_changes`/`diffs`/`workspace_metrics`/`agent_metrics` (§9.11); UI-invoked `file-tracking.*` reads + `accept-changes.*` orchestration (commit→push→PR→merge) with agent-attribution restoration (§17.2); internal diff computation/storage + track-change + metric aggregation surfaced via events (§17.1); `pr.*` review extensions (`getReviews`/`listCheckRuns`/`createReview`) mapped onto the §7 `SourceControl` trait. | The review UI lists per-file changes with agent attribution and live line stats; an agent's work goes commit→push→PR→merge through `accept-changes.execute` with attribution preserved across rebase; diffs/metrics update from internal events with no `diffs.*`/`metrics.calculate` RPC; conformance fixtures for the new read methods + `pr.*` extensions pass. |
| 9 — Iteration 5 Wave 2: agent ecosystem | BE-owned agent control surface | `services::rules`/`specialists`/`mcp_servers`/`memories` modules (§3, §18); `rules.*` (list/get/update of user-rule overrides on the `settings` store) with the **internal** prompt-assembly/injection pipeline (§18.1); `specialist.*` full CRUD over user/project files with 3-tier (project > user > bundled) resolution (§18.2); `mcp.servers.*` external-server lifecycle (list/create/update/delete/toggle/restart) over the `mcp.servers` setting + `mcp.servers:status-changed` event, distinct from the §6.8 callback (§18.3); the **internal** tool-denylist enforcement (no `agent.getAvailableTools`, §18.4); the `memories` table created but its RPC **deferred** (§18.5). | The settings UI gets/updates user rules by type and they are injected into the right agents' prompts; specialists can be created/edited/deleted as user or project files and resolve project > user > bundled; external MCP servers can be added/toggled/restarted with live status events; agent tool sets are denylisted per agent type internally with zero new wire methods; conformance fixtures for `rules.*`/`specialist.*` CRUD/`mcp.servers.*` pass. |
| 10 — Iteration 5 Wave 3: integrations & ops | BE-owned usage/stats/setup + future stubs | `services::token_usage`/`session_stats`/`setup_scripts` modules (§3, §19) over the `token_usage` table + durable `tokenUsage`/`setupScript` workspace fields + `stats` on `AgentSession` (§9.13); the **daemon-internal** periodic usage scan job surfaced read-only via `workspace.getTokenUsage` + `workspace:tokenUsage-changed` (§19.1); `agent.getSessionStats` via `auggie session stats --json` + `agent:session-stats-changed` (§19.2); `workspace.getSetupScript`/`saveSetupScript`/`detectProjectType`/`generateSetupScript` (§19.3); the "Future integrations" stubs (Linear/Sentry re-implemented in BE, no Augment proxy; sandbox/DevContainer) (§19.4); observability documented as daemon-internal only (§19.5). | `workspace.getTokenUsage` returns per-agent/per-model totals computed by the internal scanner with zero scan RPC; an agent card shows credits/message/tool counts from `agent.getSessionStats`; a worktree's setup script can be detected/generated/saved; no `logging.*`/`telemetry.*`/`linear.*`/`sentry.*` wire surface exists in v1; conformance fixtures for the usage/stats/setup reads pass. |

### 13.5 Definition of done (whole project)

- The full `PROTOCOL.md` method catalog is implemented and conformance-tested.
- A thin client (`intentd call`, then a Tauri/Svelte FE) can drive every feature with **nobusiness logic of its own** — all domain logic lives in `intentd`.
- A real provider (auggie) and the mock agent both pass the ACP suite.
- The daemon runs unattended under launchd/systemd, owns all state, and degrades gracefullywhen optional dependencies (context engine, GitHub token) are missing.

## 14. Search (BE-owned)

**Search runs on the daemon, where the code and data already live; the FE is a thin UI thatonly renders results.** In `augmentcode/intent` search is scattered across the renderer andIPC, and — critically — *remote* workspaces today route file search over SSH. `intentd`replaces all of this with a single BE-owned `search` module (the `intent-search` crate, §3).

### 14.1 Eliminating the remote SSH-exec hack

`augmentcode/intent`'s `workspace:search-in-files` handler(`src/features/workspace/main/workspace.ipc.ts`) runs ripgrep locally(`rg -n --hidden --no-ignore -S -F -g "!node_modules" -g "!.git" …`, with a `grep`fallback), **but for remote workspaces it shells `find`/`grep` over SSH** via`rpcClient.exec({ command, timeout: 30000 })` (`isRemote → rpcClient.exec(...)`). That hackexists only because the *renderer* is not on the machine that holds the code.

In the `intentd` model **the daemon already runs where the code lives** (it owns theworktree and spawns the agents). So `search.inFiles` simply runs the ripgrep-equivalent**locally to the daemon** — even when, from the user's perspective, the daemon is "theremote." The `isRemote → rpcClient.exec(find/grep)` branch is **removed entirely**; there isno SSH-exec path in the Rust search module. (When the FE itself is remote over WSS, resultsstream back over the same JSON-RPC transport, not a second SSH channel.)

### 14.2 The `search.*` namespace

A single BE-owned namespace consolidates the scattered FE/IPC searches. Each method takes anoptional `requestId` for cancellation (§14.3); large result sets are paged or streamed (§14.4).Wire shapes are specified in `./PROTOCOL.md` §5 (methods) / §6 (streaming events); thissection is the engineering design.

| Method | Replaces (in `augmentcode/intent`) | Backed by |
| --- | --- | --- |
| `search.inFiles { workspaceId, query, opts? }` | `workspace:search-in-files` (ripgrep + SSH hack) — `workspace.ipc.ts` | `grep` + `ignore` walker over the worktree; `opts`: `caseSensitive`, `regex`, `globs`, `maxResults`. Returns matches (file, line, col, preview). |
| `search.fileNames { workspaceId, pattern, limit? }` | the `list-files`/`searchFiles` path — `src/lib/components/chat/input/context-api.ts` | `ignore` walker + `globset` path/glob matching. |
| `search.messages { workspaceId, agentId?, query, role? }` | renderer message search — `src/lib/utils/messageSearch.ts` | scan over the BE-owned append-only `agent_message` log (§9.2). |
| `search.events { workspaceId?, query, limit? }` | `src/features/events/main/event-query-engine.ts` | query over the `event` table (§9.2/§10.2). |
| `search.memories { workspaceId?, query }` | `src/features/memories/main/memories.service.ts` | scan over BE-owned memory store. |
| `search.notes { query }` | renderer note search + mentions (`src/lib/services/mentions/search-service.ts`) | query over the `note` table (§9.2). |
| `search.codebase { workspaceId, query }` | `codebase:search` **placeholder returning `[]`** — `src/features/notes/main/notes-primitives.ipc.ts` | v1: ripgrep/symbol-backed (same engine as `inFiles` + a symbol pass). Future: wired to the **Augment context engine / auggie** retrieval via the `ContextEngine` trait (§8), degrading gracefully when unavailable. |

Host-API searches (PRs, issues, repos) are **not** part of `search.*` — they stay under`pr.*` / the host-agnostic `SourceControl` trait (§7).

### 14.3 Cancellation (`requestId`)

The renderer debounces and aborts in-flight searches via `AbortController` as the usertypes. `intentd` mirrors this server-side: a long-running search may carry a `requestId`,and `search.cancel { requestId }` aborts it. Internally each search runs in a `tokio` taskwhose cancellation token is keyed by `requestId`; cancelling drops the ripgrep walk/streamand stops emitting results. Cancellation is best-effort and idempotent.

### 14.4 Paging & streaming large results

`inFiles`/`codebase` can produce very large result sets. The module supports two deliverymodes (parity with the FE's incremental rendering):

- **Paged** — `opts.maxResults` caps the response and a continuation token returns the nextpage on demand.
- **Streamed** — for live-as-you-type UIs, partial matches are emitted as`search:result { requestId, matches }` notifications terminated by`search:done { requestId, truncated }` (defined in `./PROTOCOL.md` §6), so the FE rendersincrementally and can cancel mid-stream.

`search.*` is an **intentd-only** namespace, additive on top of the 106 ported methods(framing in §9.8/§9.9/§12.4).

## 15. Drafts (BE-persisted)

Drafts move from the FE's per-client `localStorage` into shared BE state. The **state model,keying, and persistence** are defined in §9.10 (the `Draft` entity + the `draft` table in§9.2); this section covers the **behavioral/RPC design**. The wire methods and event arespecified in `./PROTOCOL.md` §5/§6.

### 15.1 Why BE-persisted, and the disambiguation problem

Today `chatDrafts` is `Record<agentId, string>` per workspace in`src/store/renderer/slices/transient-ui/transient-ui-slice.ts`, persisted to `localStorage`,with `src/lib/components/chat/ChatPanel.svelte` saving/restoring and clearing on send. Whenmultiple clients connect to one daemon and type into the *same* agent's input, a single`(workspaceId, agentId)` key cannot tell them apart. The answer is the **stable `clientId`**(§16): drafts are keyed by `(workspaceId, agentId, clientId)` so concurrent clients neverclobber one another, and a client restores exactly its own draft on reconnect.

### 15.2 `drafts.*` methods

| Method | Behavior |
| --- | --- |
| `drafts.get { workspaceId, agentId }` | Returns `{ text, updatedAt }` for the **calling client** — the BE resolves `clientId` from the connection's `client.hello` mapping (§16); the FE never sends it. |
| `drafts.set { workspaceId, agentId, text }` | Upserts the row for the calling client (debounced by the FE exactly as today). An empty `text` is treated as a clear. |
| `drafts.clear { workspaceId, agentId }` | Deletes the row — invoked on send or explicit clear. |

- **Per-client private (default).** A draft is visible only to the client that wrote it.
- **Optional awareness event.** `draft:changed { workspaceId, agentId, clientId, hasDraft }`(`./PROTOCOL.md` §6) lets other clients show "someone is composing" **without leaking text**;the owning client's *other* connections (same `clientId`) may sync the text. Kept minimal inv1.
- **Shared/collaborative drafts are out of scope for v1** (see §9.10); the `clientId` keyleaves room for an opt-in shared mode later without a schema change.

`drafts.*` is an **intentd-only** namespace, additive on top of the 106 ported methods.

## 16. Stable Client Identity (`client.hello`)

`intentd` introduces a **stable, client-supplied identity** that survives reconnects. Thisis the disambiguation key for drafts (§15) and the foundation for future per-viewer readcursors (the extension deferred from the Iter-3 `attention` model, §9.9); it also lets`host.openExternal` / `forward.*` (§12.4) target the right client.

### 16.1 Today: ephemeral, never-exposed connection id

In `augmentcode/intent`, `src/main/websocket-api-server.ts` mints a connection id on connect:`clientId = ws-${Date.now()}-${Math.random().toString(36).slice(2)}`. It is **regenerated onevery reconnect** and **never returned to the client**; `src/main/websocket-event-bridge.ts`uses it only for subscription bookkeeping (the `clientSubscriptions` map). There is thereforeno way to recognize the same logical client across connections — which is exactly whatper-client drafts and per-viewer cursors require.

### 16.2 The `client.hello` handshake

- The client **generates and persists its own `clientId`** (a UUID in its own localstorage) and presents it on connect.
- `client.hello { clientId?, name?, capabilities? }` → `{ clientId, server: { locality, hasDisplay, osArch, version } }`(specified in `./PROTOCOL.md` §5). If the client omits `clientId`, the **server mints one**and returns it for the client to persist.
- The returned `server` block reuses the host-capability fields already advertised viastatus/doctor/mDNS (§5.4, §12.3): `locality` (`local|remote`), `hasDisplay`, `osArch`, anddaemon `version` — so the FE learns the host's nature at the start of the session.

### 16.3 Logical client vs. live connection

- The daemon keeps the ephemeral per-connection id purely for **transport bookkeeping**(heartbeat, subscription cleanup), exactly as today.
- On `client.hello` it maps the **live connection → logical `clientId`** in an in-memorytable (an `intent-transport` concern, §3). **Many connections may share one `clientId`** —the same client reconnecting, or multiple windows of one desktop app — and all of them sharethat client's drafts and (future) cursors.
- Logical clients are recorded in the `client` table (§9.2) with `name`, `capabilities`,`first_seen`, `last_seen`.
- **`clientId` is the disambiguation key** for `drafts.*` (§15) and the basis for**per-viewer read cursors** — the deliberate future extension of the §9.9 `attention` modelnoted there. An optional `session.clients` / `workspace.clients` read ("who is connected")supports future shared-session awareness.

The `client.hello` handshake is an **intentd-only** addition, additive on top of the 106ported methods (framing in §9.8/§9.9/§12.4).

## 17. Code Changes Review (BE-owned review loop)

The **Code Changes Review** domain is the agent-IDE review loop: it tracks every file an agent touches, computes and stores diffs, aggregates change metrics, and orchestrates the multi-step integration workflow (commit → push → create-PR → merge) that turns an agent's work into a reviewed, merged change. It ports `src/features/accept-changes/`, `src/features/diffs/`, `src/features/file-tracking/`, `src/features/line-changes/`, and `src/features/git-tracking/` from `augmentcode/intent`. State lives in §9.11 (`tracked_changes`, `diffs`, `workspace_metrics`, `agent_metrics`); the wire methods are specified in `./PROTOCOL.md`.

### 17.1 Cross-cutting principle — autonomous work is BE-internal, not a client RPC

**Autonomous agent/pipeline work is BE-internal and surfaces to the thin FE via events (and as fields on read responses) — it is NOT a client RPC.** This is the load-bearing rule for the whole domain (and for the gap-audit generally): the daemon is where the code, the git worktree, and the running agents live, so the work of *producing* review state happens entirely inside `intentd`. The FE never drives it; it only reads the result and is kept live by events.

Internal-only (**no wire methods**), each emitting events the UI subscribes to:

- **Diff computation & storage** — extracting hunks and persisting before/after content (§17.3).
- **File-tracking attribution writes (`track-change`)** — recording which agent/session/turn produced each file change (§17.4).
- **Metrics aggregation** — rolling additions/deletions into `workspace_metrics`/`agent_metrics` (§17.5).
- (Domain-adjacent, from the same audit:) rules injection into prompts, tool-denylist enforcement, MCP lifecycle, and token/session usage scanning — all internal.

Only operations with a **validated renderer caller** become RPCs. The validated surface below was confirmed against actual UI callers (`AcceptChangesPanel.svelte` + sagas, `changes-saga`, `LineChangesClient`, `pr-status-saga.ts`); operations that exist in the source but have **no UI consumer** (e.g. `accept-changes.export`, `checkPathHasChanges`, `metrics.calculate`, file-tracking `trackChange`) are **not** exposed.

### 17.2 `accept-changes.*` — integration workflow orchestration (UI-invoked)

The accept-changes service (`src/features/accept-changes/main/accept-changes.service.ts`, `accept-changes.ipc.ts`; client `accept-changes.client.ts`; background helper `background-git-actions.service.ts`) owns the multi-step "ship this work" workflow. The BE owns both local git (`intent-git`) and the forge (`SourceControl`, §7), so the entire pipeline runs server-side with per-step progress events.

| RPC method | Behavior | Backed by |
| --- | --- | --- |
| `accept-changes.getStatus { workspaceId }` | Current `WorkspaceGitStatus`: branch, ahead/behind, uncommitted count, PR linkage (§7.6). | `intent-git` + workspace record |
| `accept-changes.prepare { workspaceId, action, files? }` | Suggestions for the chosen action: commit message, PR title/body, change stats. | git diff + metrics (§17.5) |
| `accept-changes.execute { workspaceId, action, …, options? }` | Orchestrated `commit → push → create-PR → merge` with per-step tracking; **restores agent attribution** (see below). | `intent-git` + `SourceControl` (§7) + file-tracking (§17.4) |
| `accept-changes.mergePR { workspaceId, … }` | Merge the linked PR via the active forge. | `SourceControl::merge_pr` (§7) |
| `accept-changes.addRemote { workspaceId, … }` | Add/repair the git remote needed to push/PR. | `intent-git` |

**Agent-attribution restoration in `execute`.** When the workflow rewrites history (e.g. a rebase that undoes and re-applies commits), file changes from undone commits would lose their agent attribution. `accept-changes.service.ts` repairs this by re-recording an agent write for each affected file through the attribution engine (`src/features/workspace/main/provenance/attribution-engine`, `recordAgentWrite(...)`), so the `tracked_changes` audit trail (§17.4, §9.11) stays correct across history-rewriting steps. In the Rust port this is an **internal** call into `services::file_tracking`, not a separate RPC — consistent with §17.1.

### 17.3 Diff computation & storage (INTERNAL — no wire methods)

Diffs are computed and stored entirely inside the daemon; **there is no `diffs.*` client RPC namespace** (no renderer caller exists — confirmed in the UI-driven audit). The port covers `src/features/diffs/diffs.service.ts`, `src/features/diffs/main/diffs.repository.ts`, and `src/features/diffs/main/extract-change-hunks.ts` as the internal `services::diffs` module.

- **Persistent, git-independent storage.** A change's before/after content + extracted hunks are kept in the `diffs` table (§9.2/§9.11) keyed by `(workspaceId, filePath, staged)`, so a diff survives staging/commit churn rather than being recomputed from a moving git index on every read.
- **Diff persistence decision (SQLite + lazy blob SHAs).** Store the structured diff **index and hunks in SQLite** (cheap to query for the review UI), but back full file *content* **lazily via git blob SHAs** (`old_blob_sha`/`new_blob_sha` on `tracked_changes`, §9.11) instead of inlining large blobs — matching `file-tracking-storage.ts`'s blob-SHA strategy. This keeps the DB small for big files.
- **Surfacing.** Diffs reach the FE through **file-tracking reads** (§17.4) and **change events**, never a `diffs.get` RPC.

### 17.4 `file-tracking.*` — audit-trail reads (UI-invoked) + internal track-change

File-tracking (`src/features/file-tracking/main/file-tracking.service.ts`, `file-tracking-sync.ts`, `file-tracking-storage.ts`, `git-integration.service.ts`; client `file-tracking.client.ts`; converters `change-converters.ts`) maintains a per-file audit trail as a file moves through git stages (`unstaged → staged → committed → pushed → pr → merged`) with **agent attribution** (`agentId`, `sessionId`, `turn`). It becomes the internal `services::file_tracking` module backed by the `tracked_changes` table (§9.11).

**UI-invoked reads & light staging mutations (RPCs)** — validated against `changes-saga` + `AcceptChangesPanel.svelte`:

| RPC method | Behavior |
| --- | --- |
| `file-tracking.init { workspaceId }` | Initialize/attach tracking for a workspace. |
| `file-tracking.sync { workspaceId }` | Reconcile tracked state against the live git worktree. |
| `file-tracking.load { workspaceId, filter?, limit?, offset? }` | Load tracked changes (the review list). |
| `file-tracking.loadCommits { workspaceId, limit?, offset? }` | Load commit history with attribution. |
| `file-tracking.getChanges { workspaceId, filter?, limit?, offset? }` | Per-file change records (path, stage, status, attribution, hunks). |
| `file-tracking.getLineStats { workspaceId }` | Per-file/aggregate line additions/deletions (`'file-tracking:get-line-stats'`). |
| `file-tracking.stage { workspaceId, paths }` | Stage files (drives the review workflow). |
| `file-tracking.unstage { workspaceId, paths }` | Unstage files. |

**Internal write — `trackChange` (NOT an RPC).** Recording attribution for a change is part of the autonomous pipeline (§17.1): the file watcher / sync pipeline + the attribution engine write `tracked_changes` rows as agents and git operations run. The FE never calls `trackChange`; it learns of new changes via events and re-reads via the methods above. Raw content stays **lazy** via git blob SHAs (§17.3).

### 17.5 Change metrics — reads (UI-invoked) + internal aggregation

Line-change metrics (`src/features/line-changes/line-changes.client.ts`, `line-changes.ipc.ts`, `line-changes-main-state.ts`) become the internal `services::metrics` aggregator over the **durable** `workspace_metrics` / `agent_metrics` tables (§9.11).

- **Durable, not ephemeral (decision).** Recommended **durable**: cumulative additions/deletions (overall and per agent) persist across daemon restarts, so the FE renders historical "lines changed by agent" without recomputing from git history on every connect.
- **Aggregation is internal (no `metrics.calculate` RPC).** The per-change diff math (`calculate` in `line-changes.client.ts`) runs inside the aggregator as changes are tracked; there is no client-facing `metrics.calculate`.

**UI-invoked reads** (validated against `LineChangesClient`):

| RPC method | Behavior |
| --- | --- |
| `metrics.getWorkspaceStats { workspaceId }` | `{ additions, deletions, filesChanged, byAgent }` for the workspace. |
| `metrics.getAllWorkspaceStats {}` | Metrics across all workspaces (dashboard view). |
| `metrics.getAgentStats { agentId }` | Per-agent `{ additions, deletions, filesChanged }` (`byAgent` omitted). |
| `metrics.clearAgentStats { agentId }` | Reset an agent's aggregated metrics (UI-invoked clear). |

All reads live on the dedicated `metrics.*` namespace using the source's `getWorkspaceStats`/`getAgentStats`/`getAllWorkspaceStats`/`clearAgentStats` shapes; **aggregation/update stays internal**. Metric changes emit events so the FE updates live.

### 17.6 `pr.*` review extensions (map onto the §7 `SourceControl` trait)

The review loop adds three methods to the existing (ported) `pr.*` namespace, all **UI-invoked** (validated against `pr-status-saga.ts`). They do **not** introduce a parallel forge API — they map straight onto the host-agnostic `SourceControl` trait (§7) and, for GitHub, onto octocrab (§7.5):

| RPC method | `SourceControl` method | octocrab surface (GitHub) |
| --- | --- | --- |
| `pr.getReviews { … }` | `list_reviews` | `pulls().list_reviews(n)` |
| `pr.listCheckRuns { ref }` | `check_runs` | `checks().list_check_runs_for_ref(sha)` + combined status |
| `pr.createReview { verdict: approve\|request-changes\|comment, body? }` | `submit_review` | `pulls().create_review(...)` |

These extend the §7.5 coverage table (which already lists the `(reviews)` and `(checks)` trait rows); the wire names are simply surfaced under `pr.*`. PR comment plumbing reuses `src/features/git-tracking/main/github.service.ts` / `pr-comment.service.ts` semantics via the same trait.

### 17.7 Module wiring & state (summary)

- **Modules (§3):** `services::file_tracking`, `services::diffs`, `services::accept_changes`, `services::metrics` — `services`-layer modules (not new crates), depending only on `intent-store`, `intent-git`, `intent-sourcecontrol` (§7), and the event bus, per the §3.2 dependency rules. Their write paths are internal; only the read methods above cross the wire.
- **State (§9.11 / §9.2):** `tracked_changes`, `diffs`, `workspace_metrics`, `agent_metrics`. Metrics durable; diffs hybrid (SQLite index/hunks + lazy git blob SHAs).
- **Events:** internal writes emit change events (file-tracking change, metrics change, PR/review/check updates) carrying self-sufficient payloads (§10.1 event-design rule) so the thin FE re-renders without a follow-up fetch — wire-level event names are specified in `./PROTOCOL.md`.

### 17.8 Framing

Keep **"106 ported from augmentcode/intent"** intact. The Code Changes Review domain is **additive intentd-only** surface on top of it: the new namespaces `accept-changes.*` and `file-tracking.*` (reads), the metrics reads (`metrics.*`: `getWorkspaceStats`/`getAgentStats`/`getAllWorkspaceStats`/`clearAgentStats`), and the `pr.*` review **extensions** (`getReviews`/`listCheckRuns`/`createReview`) added onto the existing ported `pr.*` namespace. Diff storage, attribution writes, and metric aggregation add **no** wire methods (internal; §17.1).

## 18. Agent Ecosystem (rules, specialists, MCP servers, tooling)

The **Agent Ecosystem** domain is `intentd`'s BE-owned control surface for *how agents behave*: the rules injected into their prompts, the specialists that define their personas, the external MCP servers that extend their tool set, and the per-agent-type tool denylist. It ports `src/features/agent/main/instruction-service.ts`, `src/features/agent/main/rules-loader.ts`, `src/features/rules/`, `src/features/specialists/`, `src/features/mcp/main/`, and `src/features/memories/` from `augmentcode/intent`. State lives in §9.12 (rules/specialists are file/settings-backed; the new `memories` table is in §9.2); the wire methods are specified in `./PROTOCOL.md`.

Like the rest of the gap audit, only operations with a **validated renderer caller** become RPCs (§17.1). The wire surface here was confirmed against `AgentRulesEditor.svelte` (rules), `AIBehaviorEditor.svelte` + the specialists sagas (specialists), and `McpServersSettings.svelte` + the MCP-settings saga (servers). Two candidate methods are deliberately **dropped/deferred**: `agent.getAvailableTools` (no UI; the tool denylist is internal, §18.4) and `memories.*` (no UI; internal context source, §18.5).

### 18.1 `rules.*` — user-rule overrides (UI-invoked) + internal injection pipeline

There are **three** kinds of rules feeding an agent's prompt, with different ownership:

1. **Workspace rules** — repo files read live off the worktree in precedence order (ports `rules-loader.ts`): a custom `--rules` path, then `CLAUDE.md`, `AGENTS.md`, `.augment/guidelines.md`, then every `.md` under `.augment/rules/` (sorted). These are **not** stored by the daemon.
2. **Specialization rules** — per-agent-type defaults (e.g. `task-loop`, `code-review`) that ship bundled and frame each agent type.
3. **User-rule overrides** — the per-type overrides a user edits in settings (`base-system-prompt`, per-agent-type specialization, `workspace`, …), persisted in the `endUserRules` settings store (ports `user-rules.service.ts` `EndUserRulesManager`, keyed by rule type → `{ enabled, content, updatedAt }`).

**Wire surface — user-rule overrides only** (validated against `AgentRulesEditor.svelte`):

| RPC method | Behavior | Backed by |
| --- | --- | --- |
| `rules.list { workspaceId? }` | The user-rule override types that have content (+ enabled flag). | `getAllRules` / `getAvailableRuleTypes` |
| `rules.get { ruleType }` | `{ enabled, content, updatedAt }` for one type. | `getRulesByType` |
| `rules.update { ruleType, content, enabled? }` | Upsert the override for a type; validates + persists to the settings store. | `updateRulesByType` (+ persist) |

**The prompt-assembly / injection pipeline is INTERNAL — not a wire surface.** When an agent is spawned, `services::rules` (porting `instruction-service.ts` + `formatUserRulesForContext`) assembles the effective system prompt by layering base-system-prompt override → specialization rules → user workspace overrides → live workspace rule files, and injects it into the provider (via the provider's `--rules`/system-prompt path, §6.9). The FE never drives this assembly; it only edits the user overrides above. Only **persistence + get/update of user-rule overrides** crosses the wire.

### 18.2 `specialist.*` — full CRUD + 3-tier resolution

`specialist.list` already exists (ported, in the 106). The Agent Ecosystem adds the rest of the CRUD, validated against `AIBehaviorEditor.svelte` + the specialists sagas (`src/store/renderer/slices/specialists/sagas/specialists-saga.ts`, `persistence-saga.ts`); it ports `src/features/specialists/main/specialist-file-loader.ts` and `specialists.ipc.ts`:

| RPC method | Behavior | Backed by |
| --- | --- | --- |
| `specialist.get { id, workspacePath? }` | Resolve one specialist via the 3-tier order below. | `loadSpecialistFile` / merged load |
| `specialist.create { id, spec, scope? }` | Write a new user/project specialist file. | `writeSpecialistFile` |
| `specialist.edit { id, spec, scope }` | Overwrite an existing user/project file. | `writeSpecialistFile` |
| `specialist.delete { id, scope, workspacePath? }` | Remove a user/project specialist file. | `deleteSpecialistFile` |

**3-tier resolution (project > user > bundled).** A specialist id resolves against three sources, higher priority winning (ports `specialists.ipc.ts`'s combined load):

| Tier | Source | Location | Writable |
| --- | --- | --- | --- |
| 1 (highest) | project | `<workspacePath>/.augment/specialists/` | yes (`scope: "project"`) |
| 2 | user | `~/.augment/specialists/` | yes (`scope: "user"`, default) |
| 3 (lowest) | bundled | `resources/specialists/` (app-shipped) | no (read-only; customize by exporting to a user file) |

Specialists are markdown files with YAML frontmatter (id, name, description, model/modelTier, codingAgent, roleReminder, behaviorPrompt). **Persistence is file-based, not SQLite** (§9.12): create/edit/delete write `user`/`project` files; bundled defaults are read-only.

### 18.3 `mcp.servers.*` — external MCP server lifecycle (distinct from the §6.8 callback)

> **Two MCP roles — do not conflate.** §6.8 describes `intentd` acting **as an MCP _server_**: an in-process MCP endpoint that exposes the *workspace API* (`note.*`, `task.*`, …) **back to** the agents it spawns (the agent→BE callback loop). This section, `mcp.servers.*`, is the opposite direction — `intentd` acting **as an MCP _client/manager_**: it manages the lifecycle of **external, user-configured MCP servers** (e.g. filesystem, GitHub, custom servers) that provide *additional* tools to agents. The §6.8 callback is internal and always-on; `mcp.servers.*` is a user-managed, persisted set.

Ports `src/features/mcp/main/hub/mcp-hub.ts` (`McpHub`), `server-manager.ts` (`ServerManager` — spawn/stop/restart), `health-monitor.ts` (`HealthMonitor` — periodic ping + auto-restart), and `user-mcp-settings.ts`. Wire surface validated against `McpServersSettings.svelte` + the MCP-settings saga:

| RPC method | Behavior | Backed by |
| --- | --- | --- |
| `mcp.servers.list { workspaceId? }` | Configured external servers + current runtime status. | `mcp.servers` setting + `McpHub.getServerStatus` |
| `mcp.servers.create { config }` | Add a server definition to the `mcp.servers` setting. | `user-mcp-settings.ts` |
| `mcp.servers.update { serverId, config }` | Edit an existing server definition. | `user-mcp-settings.ts` |
| `mcp.servers.delete { serverId }` | Remove a server definition. | `user-mcp-settings.ts` |
| `mcp.servers.toggle { serverId, enabled }` | Enable/disable a server (updates `mcp.disabledServers`); replaces start/stop. | `McpHub.startServer`/`stopServer` |
| `mcp.servers.restart { serverId }` | Restart the server process (re-check; new agents pick it up). | `ServerManager.restartServer` |

- **`toggle` replaces explicit `start`/`stop`** — the UI thinks in terms of enabling/disabling a configured server; the daemon translates that to the underlying `startServer`/`stopServer` lifecycle.
- **Status is event-driven.** Server health/lifecycle transitions (started/stopped/error/restarting, from `HealthMonitor`) are pushed as an **`mcp.servers:status-changed`** event carrying the new state (per the §10 event-design rule), so the FE re-renders without polling. An optional read **`mcp.servers.getStatus { serverId }`** is available for an on-demand snapshot.
- **Config is sensitive.** Server definitions come from the `mcp.servers` setting, declared **sensitive** in §9.8 group A (OS keychain, redacted over the wire). `mcp.enableUserServers`/`mcp.disabledServers` gate which run.

### 18.4 Tool denylist (INTERNAL enforcement — expands §6.8; no `agent.getAvailableTools` RPC)

The per-agent-type tool restriction is **hardcoded and enforced internally** while building each agent's tool set on spawn (§6.8). There is **no `agent.getAvailableTools` wire method** — the mapping is static, has zero UI consumers, and is not configurable at runtime. It ports `src/features/agent/config/background-agent-tool-restrictions.ts`, which uses a **denylist** (list tools to remove) rather than an allowlist, so new tools are denied by default for restricted agents.

**Categories** (`getToolDenylistForAgentType` composes these):

| Category | Examples | What it gates |
| --- | --- | --- |
| `FILE_WRITE_TOOLS` | `str-replace-editor`, `save-file`, `remove-files`, `create`, `apply_patch`, `write_file_workspace-mcp` | editing the codebase |
| `GIT_TOOLS` | `git_stage_workspace-mcp`, `git_commit_workspace-mcp` | mutating git state |
| `AGENT_CREATION_TOOLS` | `create_agent_workspace-mcp`, `delegate_task_workspace-mcp`, `send_message_to_agent_workspace-mcp` | spawning/messaging agents |
| `NOTE_WRITE_TOOLS` / `WORKSPACE_WRITE_TOOLS` / `UNIFIED_WORKSPACE_TOOLS` | note + workspace mutation tools | mutating notes/workspace state |
| `EXECUTION_TOOLS` | process/terminal execution tools | running commands |
| `EXTERNAL_TOOLS` | `web-fetch`, `web-search`, `github-api` | external/network access |
| `SUBAGENT_TOOLS` | `sub-agent`, `sub-agent-explore`, `sub-agent-plan`, … | nested sub-agent orchestration |
| `CONFLICTING_BUILTIN_TOOLS` | `create_agent` (built-in) | always removed (conflicts with the workspace-MCP version) |

**Agent-type → restriction mapping** (`BACKGROUND_AGENT_TOOL_DENYLISTS`):

| Agent type | Denied | Rationale |
| --- | --- | --- |
| `commit-message`, `pr-description`, `code-review`, `code-walkthrough` | **all** categories above | pure text-generation/analysis agents — no side effects; context is in the prompt |
| `task-loop`, `ralph-loop`, `chat` | `SUBAGENT_TOOLS` only | full working agents, but no nested sub-agent spawning |
| _(interactive/foreground agents, not background)_ | — | unrestricted; `getToolDenylistForAgentType` returns `[]` for non-background types |

This is the detail behind the §6.8 spawn-time denylisting bullet; in the Rust port it is an internal step in `intent-acp`/`services::rules` tool assembly, never exposed as a method.

### 18.5 `memories.*` — DEFERRED (internal context source, no v1 wire surface)

`src/features/memories/main/memories.service.ts` provides long-term agent memory (`list`/`get`/`create`/`update`/`delete`/`search`), but it has **no renderer caller** today — it is an internal/agent-MCP context source, not a user-facing feature. Accordingly, in v1 there is **no `memories.*` client RPC**. The `memories` table (§9.2/§9.12) is created now so the data model is stable; memories are written/read internally and surfaced to agents through the agent→BE MCP callback (§6.8). The `memories.*` namespace is **promoted to a wire surface only when a memories UI exists**.

### 18.6 Module wiring & state (summary)

- **Modules (§3):** `services::rules`, `services::specialists`, `services::mcp_servers`, `services::memories` — `services`-layer modules (not new crates), depending only on `intent-store` (settings/`memories` table), the event bus, and (for spawn-time injection/denylisting) `intent-acp`/`intent-providers`, per the §3.2 dependency rules. The prompt-assembly pipeline, tool denylist enforcement, and MCP process lifecycle are internal; only the read/CRUD methods below cross the wire.
- **State (§9.12 / §9.2):** user-rule overrides on the `settings` store (`endUserRules`); specialists as user/project **files** (3-tier with bundled); external MCP server config in the **sensitive** `mcp.servers` setting; the new **`memories`** table. Workspace rule files are read live and not persisted by the daemon.
- **Events:** `mcp.servers:status-changed` carries the new server status as a self-sufficient payload (§10 event-design rule); rules/specialist edits surface via the existing `settings:changed` / file-change events so the thin FE re-renders without a follow-up fetch.

### 18.7 Framing

Keep **"106 ported from augmentcode/intent"** intact. The Agent Ecosystem domain is **additive intentd-only** surface on top of it: the new namespaces `rules.*` (list/get/update of user-rule overrides) and `mcp.servers.*` (list/create/update/delete/toggle/restart), plus the `specialist.*` CRUD **extensions** (`get`/`create`/`edit`/`delete`) added onto the existing ported `specialist.list`. The prompt-assembly/injection pipeline and the per-agent-type tool denylist add **no** wire methods (internal; §18.1, §18.4); `agent.getAvailableTools` is **dropped** and `memories.*` is **deferred** (§18.5).

## 19. Integrations & Ops (usage metrics, session stats, worktree setup)

The **Integrations & Ops** domain covers the daemon's operational/observability surface: how much agents *cost* (token usage + credit-based session stats) and how a fresh worktree is *prepared* (setup scripts). It ports `src/features/token-usage/`, `src/features/session-stats/`, and `src/features/setup-scripts/` from `augmentcode/intent`. State lives in §9.13 (the durable `tokenUsage`/`setupScript` workspace fields, the `stats` field on `AgentSession`, and the cache-backing `token_usage` table); the wire methods are specified in `./PROTOCOL.md`.

Two operational concerns are deliberately **kept off the protocol**: the usage/credit **scanning itself** is BE-internal (only the reads + change events are wire surface, §19.1–19.2), and **observability/logging** is daemon-internal diagnostics, never exposed (§19.5). Two whole integration families found in the source — **Linear** and **Sentry** — are **deferred** to the Future-integrations stubs (§19.4), not v1 namespaces.

### 19.1 Usage metrics (token usage) — BE-owned v1, read-only wire surface

The token-usage feature aggregates per-agent and workspace token consumption by scanning each agent's session file. It ports `src/features/token-usage/main/token-usage-scanner.ts` (`scanWorkspaceTokenUsage`), `token-usage.ipc.ts`, and `token-usage-types.ts`.

- **Daemon-internal periodic scan job (no RPC).** A background job in `services::token_usage` periodically re-scans the workspace's agents, summing the four consumption counters (`input`/`output`/`cacheRead`/`cacheCreation`) and a per-model breakdown (keyed by `effective_model_name`, `"unknown"` fallback). It is **cache-aware**: an agent whose persisted `lastMessageId` is unchanged is served from the `token_usage` cache (§9.13) without re-reading its session file. **This scan is BE-internal — there is no scan/refresh wire method.**
- **`workspace.getTokenUsage { workspaceId }` (READ).** Returns `TokenUsage { byAgentId, totals, byModel, lastScanAt }` (§9.1) — the materialized snapshot of the durable `tokenUsage` workspace field. The transient `scanning|idle` status from the source snapshot is runtime-only and not part of the durable read.
- **Event `workspace:tokenUsage-changed`** carries the new `TokenUsage` snapshot as a self-sufficient payload (§10 event-design rule) so the thin FE (`WorkspaceTokenUsage.svelte`) re-renders without a follow-up fetch.

### 19.2 Session stats — `agent.getSessionStats` + `stats` on `AgentSession`

Session stats expose the **credit** cost of a session (distinct from raw tokens), sourced from the auggie CLI. Ports `src/features/session-stats/main/session-stats.service.ts` (`getSessionStats` → `auggie session stats <sessionId> --json`), `session-stats.ipc.ts`, and `session-stats-types.ts`.

- **`agent.getSessionStats { sessionId }` (READ).** Returns `SessionStats { creditsUsed, messageCount, toolCount }` (§9.1). `creditsUsed` is **nullable** (None until the CLI has computed credits — e.g. while a session is still in progress); the source's richer `parentCreditsUsed`/`subAgentCreditsUsed` are available from the CLI and may be surfaced, but the canonical v1 shape is the three fields above.
- **`stats` field on `AgentSession`** (§9.1) caches the latest snapshot so reads don't always shell out to the CLI.
- **Event `agent:session-stats-changed`** pushes refreshed stats so an agent card (`AgentCard.svelte`) updates live.
- **Backed by the context engine / providers layer** (`services::session_stats` calls `auggie` via the same discovery used by §8); it degrades gracefully when auggie is unavailable (stats simply unavailable, per §8.3).

### 19.3 Worktree setup scripts — get/save/detect/generate (v1)

Setup scripts run inside a freshly-created worktree (copy `.env`, install deps, …) using the variables `MAIN_CHECKOUT`/`WORKTREE_PATH`/`BRANCH_NAME`/`SOURCE_BRANCH`. Ports `src/features/setup-scripts/main/setup-scripts.ipc.ts`, `types.ts`, `index.ts`.

| RPC method | Behavior | Backed by |
| --- | --- | --- |
| `workspace.getSetupScript { workspaceId }` | Read the durable `setupScript` workspace field (§9.1). | workspace record |
| `workspace.saveSetupScript { workspaceId, script }` | Persist the setup script onto the workspace. | workspace record |
| `workspace.detectProjectType { workspaceId }` | Inspect the worktree → `ProjectType` (`node\|python\|go\|rust\|ruby`). | `detectProjectType` (`package.json`/`requirements.txt`/`go.mod`/`Cargo.toml`/`Gemfile`) |
| `workspace.generateSetupScript { workspaceId }` | **AI-assisted** draft of a setup script for the detected project type. | the agent path behind `setup-scripts:generate-with-agent` |

- **`generateSetupScript` is v1**, not future: it maps the UI's "generate with agent" action (`SetupScriptAgent.svelte` → `setup-scripts:generate-with-agent`), so it has a validated renderer caller. It runs a one-shot generation agent over the worktree and returns the drafted script; the deterministic template generator (`setup-scripts:generate` → `generateScript`) is the non-AI fallback.
- **`ProjectType` coarse enum.** The source detector distinguishes package managers (`node-npm/-yarn/-pnpm`, `python-pip/-poetry`); the wire `ProjectType` is the coarse `node|python|go|rust|ruby` enum (§9.1), with the package manager treated as an internal detail of generation.

### 19.4 Future integrations (design stubs — NOT v1)

These exist in the `augmentcode/intent` source and have renderer callers there, but per the user's scope decision they are **deferred** for v1: no `linear.*`/`sentry.*` wire methods are added now. They are documented here so the surface is anticipated, and — importantly — when built they are **re-implemented directly in the BE against the upstream provider APIs, with no Augment proxy** (mirroring the §7 GitHub divergence). They are **not** part of the "106 ported + additive" count.

- **Linear (issues).** Future basis: `src/features/linear-auth/`. A future `linear.*` namespace (authenticate, getIssues, searchIssues — the validated UI callers are `LinearAuthConnection`/`LinearPicker`/`IssueSuggestions`) would let agents reference/triage Linear issues. Designed as a BE-owned integration calling Linear's GraphQL API directly with a user token (no proxy).
- **Sentry (error tracking).** Future basis: `src/features/sentry-auth/`. A future `sentry.*` namespace (authenticate, getConfig, queryIssues — UI callers `SentryAuthConnection`/`SentryPicker`) would surface error/issue context to agents, again BE-owned against the Sentry API directly.
- **Sandbox / DevContainer workspace config.** Future basis: `src/features/sandbox/`. A future option to run a workspace inside a sandboxed/DevContainer environment (per-workspace container config). No UI evidence today; noted as a future workspace-configuration extension.

Each future integration, when promoted, would slot in as an additive intentd-only namespace plus any durable fields/settings it needs — following the same patterns (validated UI caller, self-sufficient events, sensitive auth in the OS keychain) used by the v1 surfaces above.

### 19.5 Observability stays daemon-internal (NOT exposed over the protocol)

Observability/logging is **daemon-internal diagnostics only and is NOT a wire surface.** There is **no `logging.*` or `telemetry.*` namespace** (both were explicitly **dropped** in the gap audit). Concretely:

- The daemon emits structured `tracing` logs to rotated files (`$DATA_DIR/intentd/logs/intentd.log`, §9.3) and respects the `logging.level` setting (§9.8 group B) — but that is a **config knob**, not a log-streaming RPC.
- The user-facing "Activity Log" is served entirely by the existing **`event.*`** queries over the append-only event table (§10.2), not by a logging API.
- Crash/error telemetry (the source's `accounts.sentry` FE setting) is **out of scope** for the daemon protocol; it is FE-only and listed under §9.8 group C.

This keeps the protocol surface focused on product features; operators read logs/traces out-of-band (files, `journalctl`, etc.).

### 19.6 Module wiring & state (summary)

- **Modules (§3):** `services::token_usage`, `services::session_stats`, `services::setup_scripts` — `services`-layer modules (not new crates), depending only on `intent-store` (the `token_usage` table + durable `tokenUsage`/`setupScript` fields + `AgentSession.stats`, §9.13), `intent-context`/`intent-providers` (for the `auggie` CLI calls behind session stats and AI-assisted script generation), and the event bus, per the §3.2 dependency rules. The periodic usage scan and the credit-stats refresh are **internal**; only the read methods cross the wire.
- **State (§9.13 / §9.1 / §9.2):** durable `tokenUsage` materialized from the cache-backing `token_usage` table; `stats` field on `AgentSession`; durable `setupScript` workspace field (no new table). The transient scan `status` is runtime-only.
- **Events:** `workspace:tokenUsage-changed` and `agent:session-stats-changed` carry the new value as self-sufficient payloads (§10 event-design rule); wire-level event names are specified in `./PROTOCOL.md`.

### 19.7 Framing

Keep **"106 ported from augmentcode/intent"** intact. The Integrations & Ops domain is **additive intentd-only** surface on top of it: the workspace **extensions** `workspace.getTokenUsage`, `workspace.getSetupScript`/`saveSetupScript`/`detectProjectType`/`generateSetupScript`, and the agent **extension** `agent.getSessionStats`, plus the `workspace:tokenUsage-changed` / `agent:session-stats-changed` events. Usage/credit **scanning** adds **no** wire methods (internal; §19.1–19.2). **Linear/Sentry/sandbox are deferred** future stubs (§19.4) and **observability/logging stays daemon-internal** (no `logging.*`/`telemetry.*`; §19.5) — neither is counted in the additive surface.
