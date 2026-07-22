# Architecture

> Audience: engineers working on the `intentd` Rust backend
> (`packages/intentd`). Companion document: [PROTOCOL.md](./PROTOCOL.md) — the
> wire-protocol reference (transport, JSON-RPC envelope, method catalog,
> events). This page records the durable architecture and dependency rules;
> the historical porting spec (IMPLEMENTATION_SPEC.md) has been removed from
> the tree and remains available in git history.

## System overview

`intentd` is a long-lived local daemon that is the single source of truth for
Intent's domain model. Clients (the desktop UI, a mobile app, a CLI, or
another agent acting as an MCP client) connect over a JSON-RPC 2.0 API and
drive everything: workspaces, notes, tasks, comments, agents, git, pull
requests, scripts, terminals, files, and events.

The daemon embeds:

- A **JSON-RPC router** serving the full method catalog (see `PROTOCOL.md`),
  reusing one set of **service** implementations across every transport.
- An **ACP client** that spawns provider CLIs (auggie, claude-code, codex,
  cortex, droid, opencode) over piped stdio and multiplexes many concurrent
  agent sessions.
- An **MCP server** exposed *back to* the agents so an agent can call the same
  workspace API the FE uses (`note.*`, `task.*`, `agent.delegate`, …) — the
  agent→BE callback loop.
- A **provider-agnostic source-control** client (the `SourceControl` trait;
  `GitHubSourceControl` via octocrab) for PR/issue/review/check-run/mergeability.
- An optional **context engine** abstraction whose only current implementation
  shells out to `auggie`, degrading gracefully when unavailable.
- A **persistence layer** (SQLite + a file tree) that owns all durable state.
- An **event bus + append-only event log** delivered to subscribers as
  JSON-RPC notifications.

The overriding invariant, carried over from the original Intent Electron app:
**transports are thin; services are shared.** Every transport (UDS, TCP/TLS,
the agent-facing MCP server) dispatches into the same service layer.

## Crate layout

A single Cargo workspace with one binary crate `intentd` and library crates:

```text
packages/intentd/               # cargo workspace root
├── Cargo.toml                  # [workspace] members
└── crates/
    ├── intentd/                # binary: CLI + daemon entrypoint (clap)
    ├── intent-core/            # domain model, ids, errors, config, events (leaf)
    ├── intent-store/           # SQLite + file-tree persistence (repositories)
    ├── intent-services/        # business logic (the shared service surface)
    ├── intent-acp/             # ACP client, session multiplexing, agent→BE MCP server
    ├── intent-providers/       # provider registry, launch arg/env assembly
    ├── intent-sourcecontrol/   # SourceControl trait + GitHubSourceControl (octocrab)
    ├── intent-git/             # git wrappers + worktree create/lock
    ├── intent-context/         # ContextEngine trait + auggie impl
    ├── intent-pty/             # unified PTY host: terminals + scripts, scrollback, attach
    ├── intent-search/          # BE-owned search: ripgrep-equivalent content/path search
    │                           #   + adapters over store/session/event/memory/note data
    ├── intent-js/              # JavaScript execution engine for agent-supplied code
    │                           #   (QuickJS via rquickjs), async host bindings, timeouts
    ├── intent-linear/          # LinearEngine + DTOs for the linear.* surface
    ├── intent-sentry/          # SentryEngine + DTOs for the sentry.* surface
    └── intent-transport/       # UDS/TCP/TLS listeners, JSON-RPC router, auth,
                                #   client.hello → clientId mapping
```

Several cross-cutting features are **service modules** rather than crates,
wired per the dependency rules below: drafts (`services::drafts` over a store
table), client identity (a transport concern plus a small `client` store
table), the Code Changes Review domain (`services::file_tracking`,
`services::diffs`, `services::accept_changes`, `services::metrics`), the
Agent-Ecosystem modules (`services::rules`, `services::specialists`,
`services::mcp_servers`, `services::memories`), and the Integrations & Ops
modules (`services::token_usage`, `services::session_stats`,
`services::setup_scripts`, `services::repo_config`). They depend only on the
lower layers (store, git, sourcecontrol, context, providers) and the event
bus — never on the transport or on each other directly.

## Module responsibilities

| Module / crate | Responsibility | May depend on |
| --- | --- | --- |
| intentd (bin) | CLI parsing (serve/call/status/stop/doctor), daemonization, wiring | every crate |
| intent-core | WorkspaceId/NoteId/AgentId newtypes, Error/Result, Config, event types, traits | (none — leaf) |
| intent-store | SQLite pool, migrations, repositories, file layout, locking | core |
| intent-services | note/task/comment/workspace/agent/git/pr/script/file/event/draft logic plus the Agent-Ecosystem, Code-Changes-Review, and Integrations & Ops service modules | core, store, git, sourcecontrol, acp, context, providers, pty, search, linear, sentry |
| intent-acp | spawn providers over stdio, handshake, session new/load/prompt/cancel, streaming, client-served fs/terminal/permission, agent→BE MCP server | core, providers, pty, js; calls back into services via a trait |
| intent-providers | ProviderConfig registry, arg/env builder, model-tier table, capability/quirks | core |
| intent-sourcecontrol | SourceControl trait + GitHubSourceControl (octocrab): PR/issue/review/check-run/mergeability, retry | core |
| intent-git | status/stage/commit/branches, worktree create + lock | core |
| intent-context | ContextEngine trait + AuggieContextEngine + discovery | core |
| intent-pty | unified portable-pty host for terminals **and** scripts: scrollback ring buffers, multi-client attach, service/command modes, auto-restart, URL/port detection | core |
| intent-search | BE-owned `search.*`: ripgrep-equivalent content search (grep + ignore + globset), path/glob search, adapters over persisted sessions/events/memories/notes/codebase; per-request cancellation | core, store |
| intent-js | QuickJS-based JavaScript engine for agent-supplied code: async host bindings, wall-clock timeouts | (none — leaf) |
| intent-linear | LinearEngine + DTOs for the `linear.*` surface (typed GraphQL over reqwest) | core |
| intent-sentry | SentryEngine + DTOs for the `sentry.*` surface (REST over reqwest) | core |
| intent-transport | UDS/TCP listeners, TLS, bearer auth, origin allow-list, JSON-RPC router, heartbeat, lifecycle, `client.hello` handshake + live-connection→`clientId` map | core, services |

## Dependency-direction rules

```text
intent-core  ◄───────────────────────────────────────────────┐
   ▲ ▲ ▲ ▲ ▲ ▲ ▲ ▲                                            │
   │ │ │ │ │ │ │ └── intent-providers ◄── intent-acp          │
   │ │ │ │ │ │ │        (acp also ► pty, js)                  │
   │ │ │ │ │ │ └──── intent-context                           │
   │ │ │ │ │ └────── intent-git                               │
   │ │ │ │ └──────── intent-sourcecontrol                     │
   │ │ │ └────────── intent-pty                               │
   │ │ └──────────── intent-linear / intent-sentry            │
   │ └────────────── intent-store ◄── intent-search           │
   └── intent-services ──► (store, git, sourcecontrol, acp,   │
             ▲              context, providers, pty, search,  │
             │              linear, sentry)                   │
   intent-transport ──► services        intentd (bin) ──► all
```

(`intent-js` is a leaf with no workspace dependencies; it is consumed by
`intent-acp` and the binary.)

Rules:

1. **`intent-core` is a leaf** — no dependency on any other workspace crate.
   It defines the domain vocabulary (ids, timestamps, errors, event types) and
   *traits* (`ContextEngine`, `WorkspaceApi`) that higher layers
   implement/consume.
2. **`intent-transport` never touches `intent-store` directly.** It only
   depends on `intent-services`. This guarantees the RPC router and the agent
   MCP server share one code path.
3. **`intent-acp` calls back into business logic through a trait**
   (`WorkspaceApi`, defined in `intent-core`, implemented in
   `intent-services`) to avoid a dependency cycle `services → acp → services`.
   Concretely: `services` constructs the ACP client and hands it an
   `Arc<dyn WorkspaceApi>` so the agent→BE MCP server reuses the same logic.
4. **No cross-imports between sibling "feature" service modules.**
   `services::notes` and `services::git` communicate through the store/event
   bus, not by importing each other.
5. **The binary crate is the only place allowed to wire concrete
   implementations together** (composition root), keeping every library crate
   testable in isolation.
