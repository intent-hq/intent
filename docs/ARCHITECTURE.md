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
- An **ACP client** that spawns provider CLIs (auggie, claude-code, codex, … —
  see the `intent-providers` registry for the full set) over piped stdio and
  multiplexes many concurrent agent sessions.
- An **MCP server** exposed *back to* the agents so an agent can call the same
  workspace API the FE uses (`note.*`, `task.*`, `agent.delegate`, …) — the
  agent→BE callback loop. Every agent gets its **own** bridge address so tool
  calls are attributable to the calling agent. How the bridge reaches the
  provider CLI is a per-provider capability in the `intent-providers` registry
  — four delivery mechanisms today: a `--mcp-config` temp file (auggie), an
  `OPENCODE_CONFIG_CONTENT` env `mcp` block (opencode, and unsloth, which
  rides the opencode binary — see "Local models" below), ACP `session/new`
  `mcpServers` (claude-code, codex, droid, grok), and — for pi, which has no
  native MCP support and whose pi-acp adapter drops `session/new`
  `mcpServers` — a per-agent wrapper script (set as `PI_ACP_PI_COMMAND`) that
  launches pi with a bundled extension (`pi -e`); the extension connects to
  the agent's bridge via `INTENTD_MCP_BRIDGE_ADDR` from the inherited
  environment and registers the workspace tools through `pi.registerTool`.
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
    ├── intent-git/             # git wrappers + worktree/CoW-checkout create/lock
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
| intent-git | status/stage/commit/branches, worktree create + lock, CoW reflink probe/clone (macOS `copyfile(COPYFILE_CLONE)`, Linux `ioctl(FICLONE)`) for CoW workspace checkouts and per-agent sandboxes | core |
| intent-context | ContextEngine trait + AuggieContextEngine + discovery | core |
| intent-pty | unified portable-pty host for terminals **and** scripts: scrollback ring buffers, multi-client attach, service/command modes, auto-restart, URL/port detection | core |
| intent-search | BE-owned `search.*`: ripgrep-equivalent content search (grep + ignore + globset), path/glob search, adapters over persisted sessions/events/memories/notes/codebase; per-request cancellation | core, store |
| intent-js | QuickJS-based JavaScript engine for agent-supplied code: async host bindings, wall-clock timeouts | (none — leaf) |
| intent-linear | LinearEngine + DTOs for the `linear.*` surface (typed GraphQL over reqwest) | core |
| intent-sentry | SentryEngine + DTOs for the `sentry.*` surface (REST over reqwest) | core |
| intent-transport | UDS/TCP listeners, TLS, bearer auth, origin allow-list, JSON-RPC router, heartbeat, lifecycle, `client.hello` handshake + live-connection→`clientId` map | core, services |

## Workspace checkouts & agent sandboxes (CoW)

Wire contract: PROTOCOL.md §5.1 (`checkoutMode`, `cowSupported`), §5.5/§5.5a
(sandboxes). Architectural split of responsibilities:

- **Provisioning (`workspace.create` / `workspace.duplicate`).** `intent-services`
  owns the decision matrix — `workspace.cowIsolation` off ⇒ linked worktree
  (`intent_git::worktree::provision_worktree`); on ⇒ CoW reflink probe from the
  repository directory into the workspace dir (`intent_git::cow_probe(&repo_dir,
  &ws_dir)`), then a standalone clone of the whole repository directory
  (`intent_git::cow_checkout::provision_cow_checkout`). When the probe reports
  Unsupported (or errors) — e.g. the repository lives on a different volume than
  the workspaces root, since reflinks cannot cross filesystems — provisioning
  logs a warning and falls back to the linked-worktree path (the setting is a
  preference, not a guarantee; the separate root→root probe backing the
  `cowSupported` aggregate is advisory only). Both paths run under the
  per-repository worktree lock. `workspace.duplicate` applies the same matrix when
  provisioning the copy's checkout. The setting is consulted **only** at
  provisioning time; the persisted `checkoutMode` is immutable per workspace.
- **Capability surface.** The root→root probe is cached per workspaces root by the
  shared aggregate cache (`workspace_aggregates`) and delivered two ways: as the
  `Workspace.cowSupported` enrichment on the `workspace.list`/`workspace.get` read
  paths (PROTOCOL §5.1), and workspace-independently via the `system.capabilities`
  router method (protocol 2.3) — `{ cowSupported?: boolean }`, present when the
  probe ran, omitted otherwise. The FE gates the `workspace.cowIsolation` settings
  toggle on the capability RPC, so the toggle works with no workspace loaded;
  workspace payload consumers (e.g. isolation-mode resolution) still read the
  per-workspace aggregate.
- **Deletion.** `workspace.delete`'s git-metadata phase is checkout-mode aware: a
  worktree checkout gets registration prune + guarded branch delete + rename to a
  trash path, while a CoW checkout — a standalone clone with no registration in the
  source repo — goes through `intent_git::worktree::detach_checkout_dir`, which only
  renames the directory to a trash path (filesystem work, never opens a repository).
  The recursive removal of the trash directory runs in the background outside the
  lock in both modes.
- **Agent sandboxes.** `services::sandbox_ops` provisions a per-agent CoW clone,
  resolving the **sandbox source** from the workspace's checkout mode: direct-mode
  workspaces clone from the user's repository folder; CoW-checkout workspaces clone
  from the **workspace checkout** — and the merge-back on agent completion targets
  that same directory (agent commits land in the workspace's own checkout, never the
  user's repo folder). Worktree-mode workspaces are ineligible (agents share the
  checkout).

## Local models: the unsloth provider

The `unsloth` provider runs Unsloth GGUF models fully locally. It has no agent
CLI of its own — the registry entry **rides the opencode binary** (`opencode
acp`) as its ACP runtime, pointing it at a daemon-managed local server. Three
pieces:

- **Managed server (`services::unsloth_server::UnslothServerManager`).** The
  daemon owns a singleton Unsloth server (one loaded model at a time — a
  llama.cpp constraint): on the first spawn of an unsloth agent it runs
  `unsloth run --model <repo>:<quant> --disable-tools -p <port>` (quant
  auto-picked mirroring the CLI's `--gguf-variant` defaults: `UD-Q4_K_XL` for
  `unsloth/*` repos, else `Q4_K_M`), waits for the HTTP surface, then probes
  the authed `/v1/models` endpoint until the model is loaded (the server
  requires auth even on `/v1/models`, so a 401/403 during probing is expected
  warmup — up-but-not-ready — not a credential failure; the model-ready window is
  generous because first use can mean a multi-GB download, with progress
  surfaced as `agent:stream:status` launch-phase events — PROTOCOL §6.5). The server is reused while it serves
  the requested repo, killed + respawned on model switch or a dead child, and
  killed on daemon shutdown — a shutdown latch aborts an in-flight startup at
  its next probe tick, so shutdown never waits out a download. A missing
  `unsloth` binary degrades gracefully: the spawn fails with an install hint
  (`InvalidInput`, so the message survives the JSON-RPC envelope).
- **Endpoint injection.** The daemon mints the opencode auth material via
  `unsloth start opencode --no-launch --model <repo>` and reads the generated
  `opencode.json` (baseURL, apiKey, per-model token limits);
  `build_provider_env_with_unsloth` then injects
  a custom OpenAI-compatible `provider.unsloth-studio` block (the id Unsloth
  itself generates; `npm: "@ai-sdk/openai-compatible"`) plus `model` /
  `small_model` defaults and an optional `compaction` block into
  `OPENCODE_CONFIG_CONTENT` — the same env mechanism opencode's MCP block
  already uses.
- **Catalog.** The `unsloth` model-catalog source is an HTTP fetch of the
  Hugging Face `unsloth` org's GGUF repos — one row per repo (never per
  quant), ranked by downloads, fit-filtered against ~70% of total system RAM
  via a parameter-count heuristic, with a `warning` reporting how many repos
  were hidden (wire contract: PROTOCOL §5.30).

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
