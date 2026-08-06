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
  `workspace_api` results are shaped by the `workspaceApi.*` settings — TOON
  encoding of object/array results plus an oversized-output redirect to the
  workspace folder's `tool-outputs/` directory (PROTOCOL.md §5.12 / §5.22).
- A **provider-agnostic source-control** client (the `SourceControl` trait;
  `GitHubSourceControl` via octocrab) for PR/issue/review/check-run/mergeability.
- An optional **context engine** abstraction whose only current implementation
  shells out to `auggie`, degrading gracefully when unavailable.
- A **persistence layer** (SQLite + a file tree) that owns all durable state.
- An **event bus + append-only event log** delivered to subscribers as
  JSON-RPC notifications.

The overriding invariant, carried over from the original Intent Electron app:
**transports are thin; services are shared.** Every transport (the local
listener — UDS on Unix, a named pipe on Windows — TCP/TLS, the agent-facing
MCP server) dispatches into the same service layer. The Windows pipe name is
derived from the resolved socket path (`\\.\pipe\intentd-<hash16>`, first 16
hex chars of SHA-256 over the normalized path — `intent-transport`'s
`pipe_name_for_socket_path`, mirrored byte-for-byte by cloudlands-fe's
`intentd-pipe-name.ts`; see PROTOCOL.md §1.1); framing and protocol are
identical on both local transports.

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
    ├── intent-git/             # git wrappers + worktree/CoW-checkout create/lock + repo cache
    ├── intent-context/         # ContextEngine trait + auggie impl
    ├── intent-pty/             # unified PTY host: terminals + scripts, scrollback, attach
    ├── intent-search/          # BE-owned search: ripgrep-equivalent content/path search
    │                           #   + adapters over store/session/event/memory/note data
    ├── intent-js/              # JavaScript execution engine for agent-supplied code
    │                           #   (QuickJS via rquickjs), async host bindings, timeouts
    ├── intent-linear/          # LinearEngine + DTOs for the linear.* surface
    ├── intent-sentry/          # SentryEngine + DTOs for the sentry.* surface
    └── intent-transport/       # local (UDS / Windows named pipe) + TCP/TLS
                                #   listeners, JSON-RPC router, auth,
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
| intent-providers | ProviderConfig registry, arg/env builder, capability/quirks (no static model catalogs — model discovery is dynamic via `models.list`, and no provider carries a default designation) | core |
| intent-sourcecontrol | SourceControl trait + GitHubSourceControl (octocrab): PR/issue/review/check-run/mergeability, retry | core |
| intent-git | status/stage/commit/branches, worktree create + lock, CoW reflink probe/clone (macOS `clonefile(2)` whole-tree fast path with best-effort walk fallback, Linux `ioctl(FICLONE)`) for CoW workspace checkouts and per-agent sandboxes, hidden repo cache (`repo_cache`) of read-only GitHub clones backing cache-hydrated workspace creation | core |
| intent-context | ContextEngine trait + AuggieContextEngine + discovery | core |
| intent-pty | unified portable-pty host for terminals **and** scripts: scrollback ring buffers, multi-client attach, service/command modes, auto-restart, URL/port detection | core |
| intent-search | BE-owned `search.*`: ripgrep-equivalent content search (grep + ignore + globset), path/glob search, adapters over persisted sessions/events/memories/notes/codebase; per-request cancellation | core, store |
| intent-js | QuickJS-based JavaScript engine for agent-supplied code: async host bindings, wall-clock timeouts | (none — leaf) |
| intent-linear | LinearEngine + DTOs for the `linear.*` surface (typed GraphQL over reqwest) | core |
| intent-sentry | SentryEngine + DTOs for the `sentry.*` surface (REST over reqwest) | core |
| intent-transport | local (UDS on Unix, named pipe on Windows) + TCP listeners, TLS, bearer auth, origin allow-list, JSON-RPC router, heartbeat, lifecycle, `client.hello` handshake + live-connection→`clientId` map | core, services |

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
- **Repo cache & cache-hydrated creation.** `intent-git::repo_cache` owns a hidden,
  daemon-managed cache of read-only GitHub clones at
  `<workspaces_root>/.repo-cache/<owner>/<repo>` (dot-prefixed so it stays invisible to
  users and to recent-repo derivation; the module never reads config — the caller passes
  the cache root). `ensure_cached_repo` is the single entry point: it serializes callers
  on a per-repo lock, then clones fresh (miss) or refreshes (`git fetch --prune`,
  `remote set-head origin --auto` so an upstream default-branch change is re-resolved,
  hard reset to that branch, then `git clean -fdx` so untracked pollution is never
  byte-copied into hydrated checkouts). **Refresh never fails the flow** — any anomaly
  (diverged history, corrupt object store, an interrupted prior clone, a vanished
  `origin/HEAD`, a mismatched `origin`) deletes the cache dir and re-clones; only a
  failed clone surfaces as an error. `intent-services` uses the cache to hydrate
  `workspace.create` when a `githubUrl` arrives without a `clonePath` (PROTOCOL §5.1):
  the checkout is always **standalone** — a CoW clone of the cache (`cow`) or a plain
  local `git clone` of it (`direct`) — never a linked worktree against the cache, whose
  hard-reset/re-clone refresh would corrupt linked worktrees. Provisioning holds the
  per-repo cache lock, and afterwards `origin` is retargeted at the real URL so the
  checkout is fully self-contained and the cache is always safe to delete. Network git
  here shells out to system `git` (fail-fast `GIT_TERMINAL_PROMPT=0`, wall-clock
  deadline kill) with any token offered through the env-backed credential helper, never
  argv.
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
  trash path, while a `cow` or `direct` checkout — a standalone clone with no
  registration in the source repo — goes through
  `intent_git::worktree::detach_checkout_dir`, which only
  renames the directory to a trash path (filesystem work, never opens a repository).
  The recursive removal of the trash directory runs in the background outside the
  lock in both modes.
- **Agent sandboxes.** `services::sandbox_ops` provisions a per-agent CoW clone,
  resolving the **sandbox source** from the workspace's checkout mode: shared-checkout
  workspaces (no `checkoutMode`) clone from the user's repository folder; `cow` and
  `direct` checkouts clone from the **workspace checkout** (a `direct` workspace with no
  provisioned checkout — an `isNewRepo` initialization — falls back to its repository
  folder) — and the merge-back on agent completion targets
  that same directory (agent commits land in the workspace's own checkout, never the
  user's repo folder). Worktree-mode workspaces are ineligible (agents share the
  checkout). **Provisioning is asynchronous** relative to `agent.delegate`
  (PROTOCOL §5.5): the delegate path registers a per-agent settlement gate
  (`Services::begin_sandbox_provisioning`), spawns the clone in a background task,
  and returns `effectiveIsolation: "pending"` immediately — a large clone can take
  tens of seconds, which previously starved the `workspace_api` MCP budget. The
  background half settles the outcome onto the child's session (sandbox fields +
  `sandbox:cow:created` event) and releases the gate via a drop guard, so it settles
  even on panic. The child's turn worker awaits the gate
  (`await_sandbox_provisioning`) **before its first ACP spawn**, so the child never
  spawns against a half-copied sandbox. Fallback semantics are unchanged: on
  reflink-unsupported filesystems or provisioning failure the child runs in shared
  mode (log-only; no sandbox fields, no event). A delete race is discarded: when
  `agent.delete` races the clone, `settle_provisioned_sandbox` finds the session
  missing/soft-deleted and removes the sandbox directory (best-effort deleting the
  store record too) instead of persisting fields or emitting the event.

## Agent default-model resolution (daemon-owned)

Wire contract: PROTOCOL.md §5.5 ("Creation-time default-model resolution") and
§5.11 (`resolvedModel`/`resolvedProvider` previews). Architecturally:

- **One resolver, daemon-side.** `agent_ops::resolve_agent_default_model` in
  `intent-services` is the single resolver behind every agent-creation path
  (`agent.create`, `agent.delegate`, `agent.wakeOrCreate`, `workspace.create`
  `initialAgent`) **and** behind the `specialist.get`/`specialist.list` preview
  decoration — so previews match what a no-model create actually pins. Clients
  are pass-through: they send a model only when the user explicitly picked one
  and never pre-resolve defaults.
- **Provider boundaries.** The model-tier concept (`fast`/`balanced`/`smart`)
  and the static per-provider tier tables are removed (intentd#922): all model
  discovery is dynamic (`models.list` probes, cached per provider), and every
  resolved candidate — specialist frontmatter `model` or a settings default —
  is provider-guarded against the cached dynamic catalogs, so a model owned by
  another provider falls through to the next step instead of leaking across
  providers. The **default provider** is settings-derived (the provider prefix
  of `model.default` when compound and registry-valid, else `providers.active`),
  bottoming out at the first registered provider as a neutral positional last
  resort — no provider carries a hardcoded default designation.
- **Pinning.** The resolved model is persisted to `session.model` at creation
  time and fixed for the session's lifetime; later settings/specialist changes
  only affect subsequently created agents (`agent.setModel` is the explicit
  mutation path). Bundled specialists carry no frontmatter `model` and inherit
  the user's configured default (or the provider CLI default).

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

## GitHub credential flow

Wire contract: PROTOCOL.md — `system.gitCredential` fast-path (§5, v2.5),
`github.*` auth model (§5.27), source-control settings keys (§5.12), clone
credential injection (§5.6). One token, three consumption paths, one trust
boundary:

- **One stored token.** The GitHub token lands in the file-backed secrets
  store (`~/intent/secrets.json`, `0600`) under account
  `sourceControl.github.token`, written by the daemon-owned OAuth device flow
  (`github.connect`) and deleted by `github.revoke`. Every consumer resolves
  it through one chain (`intent_sourcecontrol::token::resolve`, per
  `sourceControl.github.tokenSource`): `auto` (the default) tries secrets
  store → `GITHUB_TOKEN`/`GH_TOKEN` env → `gh auth token`.
- **Daemon-internal git ops** (clone/fetch/pull/push in `intent-git`): the
  resolved token is offered to the spawned `git` as a github.com-scoped
  credential helper built in-process (`intent_git::auth`). The helper config
  entry contains no token bytes — the token travels only in the
  `INTENT_GIT_GITHUB_TOKEN` environment variable of that one child, never on
  argv. The entry is appended (via `-c` or `GIT_CONFIG_PARAMETERS`) after any
  configured helpers, so the user's own helpers still win, and
  `GIT_TERMINAL_PROMPT=0` turns a would-be credential prompt into a fast
  error instead of a hang.
- **Child spawns** (PTY terminals via `services::terminal_ops`, agent
  provider processes via `services::agent_manager`): daemon-backed **helper
  mode** — zero token bytes in the child environment. The spawn appends a
  `credential.https://github.com.helper=!<intentd> git-credential` entry to
  the child's `GIT_CONFIG_PARAMETERS` (inherited entries preserved, so
  ambient user helpers keep winning); `<intentd>` is the running daemon's own
  binary (`current_exe`, sh-quoted). An unresolvable binary path or the gate
  being off simply yields no injection — a spawn never fails or blocks on it.
- **The `intentd git-credential` helper** (hidden subcommand,
  `crates/intentd/src/git_credential.rs`): speaks the line-oriented
  git-credential protocol on stdin/stdout and answers only `get` for
  `protocol=https` + `host=github.com`, fetching the credential from the
  running daemon over the UDS `system.gitCredential` RPC on each invocation.
  The RPC is UDS-only — a remote (TCP/WSS) caller is rejected with `-32001`,
  so the credential never crosses the network. Every other case —
  `store`/`erase`, other hosts, daemon not running, gate off, no token — is a
  silent exit 0, letting git fall through to its remaining helpers/prompt
  rules. The daemon audit-logs each grant/denial with the helper's
  self-reported pid; the token value is never logged.
- **Gating & revocation.** `sourceControl.github.exposeGitCredentialToChildren`
  (boolean, default `true`) gates both the child-env injection and the
  `system.gitCredential` grant. Children resolve on every `get` rather than
  holding a token snapshot, so toggling the setting off or calling
  `github.revoke` takes effect immediately — including in already-open
  terminals.
- **Security invariants.** The token never appears on argv or in logs; the
  only environment carrying it is that of the daemon's own short-lived git
  subprocesses (`INTENT_GIT_GITHUB_TOKEN`) — never a terminal or agent
  process. It is never exported as `GITHUB_TOKEN`/`GH_TOKEN` (those keys stay
  on the MCP child-env secret denylist, `intent_acp::mcp_env`, which is
  unaffected by helper injection). The trust
  boundary is the Unix-domain socket — same host, same user, filesystem
  permissions — which is why the credential surface is deliberately absent
  from WSS: remote clients drive git through the `git.*` RPCs instead.

## Background hooks

Wire contract: PROTOCOL.md §5.40 (`hook.*` methods), §6.5 (`hook:*` events).
A background hook is a small agent-authored JS script the daemon runs on a
fixed interval until it dispatches (wakes its owner), fails (evicted), or is
cancelled — letting an agent watch for a condition without burning turns
polling. The subsystem lives in `intent-services`
(`services::hook_manager`):

- **Scheduler.** Each active hook owns one tokio task that sleeps `delayMs`
  between runs; a `runNow` control frame triggers an immediate run and resets
  the inter-run timer. Scheduling is MCP-only (`ws.hook.schedule` — hooks are
  agent-authored per the PROTOCOL §6.8 principle); the FE wire surface is
  read/trigger/cancel only (`hook.list` / `hook.runNow` / `hook.cancel`). The
  first run happens **immediately at schedule time as validation**: a failing
  script rejects the call, a dispatching one wakes the owner without
  persisting a schedule.
- **Execution.** Scripts evaluate in QuickJS (`intent_js::eval`) with the
  exact same `ws.*` prelude + host dispatch the `workspace_api` MCP tool
  installs — including `ws.host.exec` — with the hook's workspace/agent
  pinned as the caller and a 60 s wall-clock budget. The return value is the
  contract: `{ dispatch: true, message }` wakes the owning agent and
  terminates the hook; `{ dispatch: false }` / `undefined` sleeps and
  re-runs; a throw or the 60 s timeout evicts the hook, persists
  `last_error`, and wakes the owner with the reason.
- **Owner wakes** go through the automatic-delivery `agent.sendMessage` path
  — queued behind an in-flight turn, question hold respected — and are
  best-effort (a delivery failure is logged, never propagated).
- **Persistence & rehydration.** Schedules persist in the SQLite `hook`
  table (migrations `0075_hook.sql` + `0076_hook_last_logs.sql`, rows
  cascade with their agent session)
  and rehydrate at boot (`Services::rehydrate_hooks`): `scheduled`/`running`
  rows respawn their tasks (`running` — daemon died mid-run — is healed back
  to `scheduled` with a fresh countdown), rows whose owning agent is gone
  are cancelled, and terminal rows (`dispatched`/`evicted`/`cancelled`) are
  kept for inspection.
- **Limits.** `[hooks] maxPerAgent` (config.toml, default 5) caps
  concurrently active (scheduled/running) hooks per agent; `delayMs` has a
  10 s floor and hook names — user-facing, human-readable descriptions of
  what the hook is waiting for — are capped at 50 characters — all enforced
  at schedule time.

## Agent completion settlement & deferrals

Wire contract: PROTOCOL.md §Completion-watch persistence and the §6.5
`agent:idle` notes. The settlement machinery lives in `intent-services`
(`deliver_completion_to_watches` in `lib.rs`, the completion-watch registry in
`agent_subscriptions.rs`): an `agent:idle` only counts as the agent's
completion — firing its watchers' deliver-once wakes and recording `after_all`
group settlement — when the agent has genuinely settled. Three deferral
classes gate this, all probed **live at delivery time** (never from emit-time
event stamps):

- **Queue/busy interim** — ready-to-send queued messages, or a worker already
  busy in a new turn. Defers ungrouped watch delivery only; grouped watches
  are exempt (group accounting must see every completion).
- **Hook-waiting** — the agent owns active background hooks. Defers both
  watch delivery and grouped settlement records; TTL-bounded by hook expiry.
- **Agent-waiting** (monorepo#1468) — the agent itself holds live outgoing
  completion watches on other, unsettled agents (ungrouped or grouped; a
  coordinator with an open delegation group is waiting on its children).
  Defers watch delivery and grouped settlement records, like hook-waiting.

Two interim notions are deliberately split: `seal_interim` (queue/busy/hook)
also blocks sealing the agent's own open `after_all` group, while
agent-waiting does **not** — an `after_all` coordinator always holds grouped
outgoing watches on its own children, so gating the seal on agent-waiting
would deadlock every group. The waiting classification
(`Services::agent_is_waiting_on_agents` / `classify_agent_waiting`) bakes in a
**2-cycle deadlock guard**: a mutual watch pair whose both sides are idle is
not a waiting reason (the pair delivers as before); deeper cycles (A→B→C→A)
are an accepted limitation, deferring until an external event breaks the
cycle. Never deferred by any class: `agent:failed` / `agent:deleted`, the
immediate `reportToParent` wake, and the attention (blocker/discussion)
fan-out.

Deferred idles record an interim-skip marker, and **redelivery backstops**
re-run the deferred completion when the deferral reason disappears without a
fresh idle: queue retraction/edit (queue interim), terminal hook transitions
(hook-waiting), and — for agent-waiting — `agent.unwatch`,
`agent.cancelSubscriptions`, and `after_all` group settlement, each of which
may remove the agent's last outgoing watch. Restart paths share the same
predicates: the startup watch reconcile, registration-time reconciliation
(re-arming a watch on an already-idle target), and group rehydration all skip
the synthetic completion for a deferred child — group rehydration via a
durable variant that reads persisted `completion_watch` rows, since groups
rehydrate before the in-memory watch registry loads.

## Agent feature toggles (`[agentFeatures]`)

Wire contract: PROTOCOL.md §5.12 (settings catalog). Eight booleans under the
`[agentFeatures]` config.toml table — `backgroundHooks`, `hostExec`, `scripts`,
`terminalAccess`, `browserAutomation`, `richChatBlocks`, `structuredQuestions`,
`attentionRequests` — all default `true`. Each toggle removes an agent-exposed
feature from both the agent's system prompt and its MCP tool surface.

- **Three MCP gating layers per feature** (defense in depth): (a) the
  `workspace_api` **tool description** is assembled from per-namespace segments
  at bridge creation (`tools::workspace_api_description`), so a disabled
  feature's docs never reach the agent; (b) the **JS prelude** omits the gated
  namespace installers (`bindings::prelude_for`), so a call fails with a clear
  `TypeError` instead of silently dispatching; (c) the **dispatch layer**
  denies the method outright (`tools::denied_feature`) with an explicit
  `disabled in settings (agentFeatures.<key> = false)` error. Parity tests in
  `tools.rs` keep description ↔ bindings segment-aware. Gating is
  namespace-level except `attentionRequests`, which is method-level
  (`ws.agent.reportBlocker` / `ws.agent.requestDiscussion` only —
  `ws.agent.reportToParent` and the rest of `ws.agent.*` stay un-gated).
- **Dynamic delegate-docs segment (specialist `modelOptions`).** The same
  per-bridge description assembly carries one dynamic segment: each visible
  specialist's `modelOptions` (PROTOCOL §5.11) is resolved through the 3-tier
  fold at bridge creation (`Services::specialist_model_options_for_workspace`
  → `specialist_model_options`, project tier derived from the stored workspace
  record — worktree path, else repository path) and injected as
  continuation-indented lines of the `ws.agent.delegate` doc entry
  (`tools::workspace_api_description_with_model_options`), composing with the
  feature pruning above. Snapshot semantics match the `[agentFeatures]`
  toggles — captured once at bridge creation, never live-read — and when no
  specialist carries options (the default) the assembled description is
  byte-identical to the plain assembly by construction.
- **Prompt-section gating.** `rules::assemble_system_prompt` threads the
  captured flags into instruction assembly (`intent-services/instructions.rs`):
  disabled features drop their bundled-instruction sections (e.g. common.md's
  "Waiting on External Conditions", "Rich Chat Rendering", and "Raising
  Attention" sections, workspace-agent.md's dev-server script guidance) and
  the rules.rs-assembled "Asking the User Questions" section
  (`structuredQuestions`). With all defaults the assembled prompt and tool
  description are byte-identical to the pre-toggle output.
- **Hook runtime.** `hook.schedule` is additionally rejected in the services
  layer when `backgroundHooks` is off, and that check reads the effective
  settings **live**. For sessions created after the flip, the MCP dispatch
  deny (captured flags) blocks the call first and the services check is
  redundant defense in depth; for pre-flip sessions — whose captured surface
  still advertises `ws.hook.*` and whose dispatch layer lets the frame
  through — the live services check is what denies it. Net effect: uniquely
  among the toggles, flipping `backgroundHooks` off denies new schedules
  immediately from **all** sessions. **Already-active hooks are unaffected by
  the toggle and run to their terminal state/TTL**.
  Hook script runs build their `ws.*` prelude from the effective flags read
  fresh per run — a hook outlives sessions and daemon restarts, so a hook run
  honors the same gates (e.g. `hostExec`) a newly created session would.
- **New sessions only.** Flags are captured once at agent-session creation
  (the assembled system prompt is persisted per-session) and at per-agent MCP
  bridge creation — never live-read per call (deliberately unlike
  `workspaceApi.toonOutput`) — so a settings change applies only to sessions
  created afterwards; existing sessions keep the surface they were created
  with.

## Read-path performance principles

Hot read RPCs — the methods clients poll or fan out on focus (`workspace.list`
/ `workspace.get`, `agent.list` / `agent.get`, conversation pagination, event
reads) — obey one invariant: **cost is O(rows returned)**. Work is
proportional to the size of the response, never to transcript length, blob
size, repository size, or history depth — and no unbounded filesystem or git
work (workdir walks, `git diff`, reflink probes) runs inline on these paths.
Every recent performance regression attached unbounded-cost computation to a
bounded-expectation read path (monorepo#958, #963, #1010, #1061, #1395/#1396);
this section records the design that prevents the next one.

Derived or enriched fields on hot read paths sit on a three-rung ladder —
prefer the highest rung that fits:

1. **Stored on write.** Maintain the derived value in the same transaction as
   the write that changes it; the read path only selects columns. Embodiment:
   the persisted `last_assistant_preview` / `last_user_preview` /
   `last_message_role` columns on `agent_session` (migrations 0066/0070) —
   `agent.list` previews are written at message-append time, so the read path
   never hydrates or decodes transcript bodies (#958).
2. **Cached with invalidation.** Compute off the hot path and serve from a
   shared cache with explicit invalidation or a TTL. Embodiments: the
   `workspace_aggregates` cache (`intent-services/src/workspace_aggregates.rs`
   — lifetime-cached CoW probe, single-flight, per-call budget), the
   `agent.list` projection cache (`agent_list_cache.rs` — event-driven
   invalidation on transcript writes, epoch-guarded against stale in-flight
   loads), and the disk-usage cache (`disk_usage.rs` — ~60 s TTL,
   stale-while-revalidate: an expired entry is served immediately while a
   single-flight background walk refreshes it).
3. **On-demand RPC.** If a field cannot be made cheap, it does not belong on
   a list payload: give it its own method the client calls when it actually
   needs the value. Embodiment: `diffSummary` was removed from workspace
   metadata payloads (its per-workspace `head_diff_rollup` pinned the
   blocking pool on every list poll, #963) in favor of on-demand `git.diffs`.

Two corollaries:

- **Degrade by omission, never by blocking.** When a cached aggregate is
  cold or over budget, the read omits the optional field and lets a detached
  task backfill the cache for the next poll (`cowSupported`'s 1.5 s budget,
  disk usage's first-poll omission) — a hot RPC never waits out a probe or a
  filesystem walk.
- **Window before materializing.** Pagination selects and decodes only the
  requested page inside SQLite (`get_agent_messages_page`; the preview
  window query runs on a covering index and never fetches `content`), rather
  than hydrating the full log and slicing in memory (#1010).

New enrichment fields on hot read paths carry the burden of proof: they must
name their rung on this ladder before they land. The companion agent-facing
contract lives in the intentd repo's AGENTS.md.

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
   (`intent-acp` additionally carries a **dev-only**, version-less
   dev-dependency on `intent-services` so its binding tests can drive the
   real service implementations — a Cargo-permitted dev-dep cycle; the
   normal-build dependency direction is unchanged.)
4. **No cross-imports between sibling "feature" service modules.**
   `services::notes` and `services::git` communicate through the store/event
   bus, not by importing each other.
5. **The binary crate is the only place allowed to wire concrete
   implementations together** (composition root), keeping every library crate
   testable in isolation.
