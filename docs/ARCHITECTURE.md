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

- A **JSON-RPC router** serving the full method catalog (see the
  [protocol docs](./protocol/README.md)),
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

- **Provisioning (`workspace.create`).** `intent-services`
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
  per-repository worktree lock. The setting is consulted **only** at
  provisioning time; the persisted `checkoutMode` is immutable per workspace.
- **Duplication (`workspace.duplicate`).** Applies that matrix only for
  shared-checkout (worktree-mode) sources. A **standalone** source — the source's
  own `checkoutMode` is `cow` or `direct` — always duplicates as a standalone
  checkout, cloned from the source's own checkout rather than from its
  `repositoryPath`: CoW probe ⇒ `cow` clone, Unsupported/probe error ⇒ a plain
  local clone of the source checkout persisted as `direct`
  (`intent_git::cow_checkout::provision_local_clone_checkout`, which carries
  committed state only and resolves `origin` so no relative or self-referencing
  URL survives into the duplicate — the CoW path copies `.git/config` verbatim
  instead). `workspace.cowIsolation` is **ignored** for such sources
  (parity with cache-hydrated create), and the duplicate persists
  `repository_path` = its **own** checkout so it is fully self-contained. A linked
  worktree rooted in a sibling workspace's checkout is never provisioned: the
  source's deletion detaches that directory and would orphan the duplicate, and
  deleting the duplicate would mutate the source (intent-hq/monorepo#1560). If
  provisioning fails, the inherited `repository_path` is cleared for standalone
  sources so no checkout-less row references the source's directory.
- **Unified provisioning progress.** `intent-services::create_progress` owns the
  per-create progress reporter armed by a `workspace.create { progressId }` (PROTOCOL
  §5.1/§6.5): it echoes the client-minted id on every `git:clone:progress`/`git:clone:done`
  frame, normalizes percent across the whole pipeline (network clone, cache
  ensure/refresh, submodule population, CoW copy / worktree add / branch checkout,
  finalizing) onto one monotonically non-decreasing 0–100 scale, and dedupes identical
  consecutive frames. The `workspace.create` wrapper owns the exactly-one terminal
  `git:clone:done` per create (success and every error path; idempotent replays emit
  nothing). `clone_ops::SubmoduleAwareParser` folds a `--recurse-submodules` stderr
  stream into one aggregated `submodules` phase — the create-orchestrated clone recurses
  submodules ([intent-hq/intentd#1069](https://github.com/intent-hq/intentd/pull/1069));
  the standalone `git.clone` RPC does not. Without a `progressId` every path keeps its
  legacy framing (the field is additive).
- **Repo cache & cache-hydrated creation.** `intent-git::repo_cache` owns a hidden,
  daemon-managed cache of read-only GitHub clones at
  `<workspaces_root>/.repo-cache/<owner>/<repo>` (dot-prefixed so it stays invisible to
  users and to recent-repo derivation; the module never reads config — the caller passes
  the cache root). `ensure_cached_repo` is the single entry point: it serializes callers
  on a per-repo lock, then clones fresh (miss; `--recurse-submodules`, so the cache
  carries populated submodule work trees and their module git dirs) or refreshes
  (`git fetch --prune`, `remote set-head origin --auto` so an upstream default-branch
  change is re-resolved, hard reset to that branch, `submodule sync` + `submodule update
  --init --recursive --force` so gitlink bumps, URL changes, and newly added submodules
  are followed, then `git clean -ffdx` plus a per-submodule recursive clean so untracked
  pollution — including orphaned submodule checkouts — is never byte-copied into
  hydrated checkouts). **Refresh never fails the flow** — any anomaly
  (diverged history, corrupt object store, an interrupted prior clone, a vanished
  `origin/HEAD`, a mismatched `origin`) deletes the cache dir and re-clones; only a
  failed clone surfaces as an error. `intent-services` uses the cache to hydrate
  `workspace.create` when a `githubUrl` arrives without a `clonePath` (PROTOCOL §5.1):
  the checkout is always **standalone** — a CoW clone of the cache (`cow`) or a plain
  local `git clone` of it (`direct`) — never a linked worktree against the cache, whose
  hard-reset/re-clone refresh would corrupt linked worktrees. Both paths populate
  submodule work trees from the cache's local module git dirs alone (the CoW byte copy
  carries them; `direct` copies `.git/modules` before the update), and the populating
  `submodule update` runs **strictly offline** (`--no-fetch`, every clone transport
  refused): hydration never touches the network — a gitlink the cache does not hold
  degrades to an unpopulated submodule with a warning, and no submodule anomaly ever
  fails `workspace.create`. Provisioning holds the per-repo cache lock, and afterwards
  `origin` is retargeted at the real URL (submodule URLs re-synced to their
  `.gitmodules` resolution) so the checkout is fully self-contained and the cache is
  always safe to delete. Network git here shells out to system `git` (fail-fast
  `GIT_TERMINAL_PROMPT=0`, wall-clock deadline kill) with any token offered through the
  env-backed credential helper, never argv; the helper config propagates to submodule
  child fetches during cache clone/refresh via `GIT_CONFIG_PARAMETERS`, the token only
  via the inherited env var.
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
  The standalone rename is gated on the daemon-owned
  `<root>/<workspaceId>/<repo-slug>` layout: an `isNewRepo` direct checkout —
  where the checkout IS the user's chosen repository folder, outside that
  layout — is never renamed or removed; deletion removes only the workspace
  row. The recursive removal of the trash directory runs in the background
  outside the lock in both modes.
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
  persisting a schedule — except for a perpetual hook, which persists and
  schedules anyway (see below).
- **Execution.** Scripts evaluate in QuickJS (`intent_js::eval`) with the
  exact same `ws.*` prelude + host dispatch the `workspace_api` MCP tool
  installs — including `ws.host.exec` — with the hook's workspace/agent
  pinned as the caller and a 60 s wall-clock budget. The return value is the
  contract: `{ dispatch: true, message }` wakes the owning agent and
  terminates the hook — unless the hook is perpetual, which counts the fire
  and returns to `scheduled`; `{ dispatch: false }` / `undefined` sleeps and
  re-runs; a throw or the 60 s timeout evicts the hook, persists
  `last_error`, and wakes the owner with the reason.
- **Perpetual hooks** ([intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979)).
  The optional `perpetual` schedule param (default `false` — one-shot
  behavior is unchanged) makes dispatch **non-terminal**: the run wakes the
  owner as usual, bumps `dispatch_count`, and re-arms the hook to `scheduled`
  with a fresh `next_run_at`, so it keeps running on its cadence until TTL
  expiry, cancel, or eviction. The re-armed wake's state note says the hook
  remains active until its `expiresAt` with a `ws.hook.cancel` pointer —
  replacing the one-shot retired-with-reschedule-pointer note — and dispatch
  wakes carry the `hookStillActive` boolean in the `hook_wake`
  messageMetadata (`true` only for the re-armed perpetual branch; absent on
  non-dispatch wakes) so consumers need not parse the note text
  ([intent-hq/intentd#1027](https://github.com/intent-hq/intentd/pull/1027));
  a dispatch landing at/after `expiresAt` still wins but terminalizes the
  hook (dispatch wake, then the expiry notice), and keeps the one-shot
  phrasing so the two notices cannot contradict each other. Both paths
  resolve and
  persist the post-dispatch state before emitting `hook:run-completed` /
  `hook:dispatched`, so those payloads carry the real outcome. `perpetual`
  and `dispatch_count` persist as defaulted columns
  (`0084_hook_perpetual.sql`) and surface on `hook.list` plus every `hook:*`
  payload as `perpetual` / `dispatchCount`; the TTL-expiry notice reports
  "N runs, M dispatches" for a perpetual hook.
- **Ownership scoping.** Hooks are agent-owned, and `hook_cancel` takes the
  cancelling agent as `caller: Option<AgentId>`. The MCP binding passes the
  calling agent's id (`Some`) — and, like `ws.hook.schedule`, rejects a call
  with no agent caller context outright — so an agent can only cancel its
  own hooks; a non-owner cancel is rejected with an error naming the owning
  agent, before any state change. The FE wire path (`hook.cancel`) passes
  `None`: it may cancel any hook in the workspace. Cancels are visible in
  exactly one direction: an owner's own cancel delivers no self-wake, while
  a `None`-caller cancel wakes the owner with a notice
  ([intent-hq/intentd#953](https://github.com/intent-hq/intentd/pull/953)).
- **Owner wakes** go through the automatic-delivery `agent.sendMessage` path
  — queued behind an in-flight turn, question hold respected — and are
  best-effort (a delivery failure is logged, never propagated).
- **Persistence & rehydration.** Schedules persist in the SQLite `hook`
  table (migrations `0075_hook.sql` + `0076_hook_last_logs.sql` +
  `0084_hook_perpetual.sql`, rows cascade with their agent session)
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

## Centralized PR monitoring

Wire contract: PROTOCOL.md §5.42 (`prMonitor.*` methods, the
merge-requirements checklist) and §6.5 (`prMonitor:*` events). The subsystem
lives in `intent-services` (`services::pr_monitor`): agents register monitors
via the MCP `ws.pr.monitor` binding (registration is MCP-only, like
`ws.hook.schedule`; the FE wire surface is `prMonitor.list` / `cancel` /
`flush`), and **one shared daemon loop** (`spawn_pr_monitor_loop`, wired in
`main.rs` beside the PR-refresh sweep) polls every active monitor on the live
`prMonitor.pollSeconds` cadence, diffs the merge-requirements checklist
(checks, reviews, threads, mergeability, branch rules — composed in
`pr_ops::merge_requirements` with per-signal, never-fatal degradation) against
the monitor's persisted **emit baseline** (the PR state as of the last
delivered wake, or registration), and wakes the owning agent with a single
consolidated notification once the PR has been quiet for
`prMonitor.debounceSeconds` (with a max-latency bound so a never-quiet PR
whose pending set stays continuously non-empty is late, never starved — a
full revert empties the set and re-arms the clock, by design). The pending
set is a coalesced net diff, recomputed
against the emit baseline on every poll rather than accumulated as a log: a
field that moved A→B→C reports one initial→final line, a reverted field drops
out, and a PR that fully reverts within the debounce window empties the set —
anchors reset, no wake sent. Each delivered wake advances the baseline to the
delivered snapshot. Monitors persist in the SQLite `pr_monitor` table
(migration `0085_pr_monitor.sql`, rows cascade with their agent session; the
emit baseline column arrived in `0089_pr_monitor_baseline.sql`, whose
backfill pairs with a rehydration path that delivers any pre-coalescing
pending log as-is rather than letting the first recomputing poll drop it),
survive daemon restarts via boot rehydration with catch-up delivery, and
terminalize on merge/close with an immediate final wake (`completed` rows are
retained so merged PRs stay visible). Store writes are guarded
compare-and-swap so concurrent flush / cancel / re-register / poll never
clobber each other; owner wakes go through the same automatic-delivery path
as hook wakes. The agent surface (`ws.pr.monitor` / `ws.pr.unmonitor` /
`ws.pr.monitors`) is gated by `agentFeatures.prMonitor`; `ws.pr.snapshot`
stays un-gated and always carries its `requirements` block — the toggle only
scrubs the "prefer `ws.pr.monitor`" cross-references from the surviving doc
entries.

## Multi git root tracking

Wire contract: PROTOCOL.md §5.6 ("Multi git root tracking" — the
`gitRoot.list` method, the `gitRootId?` param on the git reads, the
`WorkspaceGitRoot` wire shape) and §6.5 (`gitRoot:*` events). A workspace can
track **secondary git roots** — agent-created subtree checkouts, initialized
submodules, or sibling clones anywhere on the host — alongside its implicit
primary worktree. Rows persist in the SQLite `workspace_git_root` table
(migration `0093_workspace_git_root.sql`, `intent-store`'s
`workspace_git_root_repo`; rows cascade with their workspace), keyed by
canonicalized absolute path and idempotent per `(workspaceId, path)`.
Registration is MCP-only (`ws.git.registerRoot` / `ws.git.unregisterRoot` /
`ws.git.listRoots` in `intent-acp`'s git bindings, per the §6.8 principle) —
the FE reads via `gitRoot.list` and subscribes to `gitRoot:registered` /
`gitRoot:updated` / `gitRoot:unregistered`. The background PR-refresh loop
additionally sweeps each workspace's roots: it auto-detects the worktree's
initialized submodules as `source: "auto"` rows, auto-prunes rows whose path
vanished from disk, and runs the same per-branch PR discovery on each root as
on the primary workspace root (the row's PR fields mirror the `Workspace` PR
fields), fail-soft per root. Six git reads (`git.status`, `git.changes`,
`git.diffs`, `git.commits`, `git.showFile`, `git.branchStatus`) accept an
optional `gitRootId` that re-points the read at the registered root's path;
an unknown or foreign-workspace id is `-32602` with an identical message, so
roots are not probeable across workspaces.

## Agent completion settlement & deferrals

Wire contract: PROTOCOL.md §Completion-watch persistence and the §6.5
`agent:idle` notes. The settlement machinery lives in `intent-services`
(`deliver_completion_to_watches` in `lib.rs`, the completion-watch registry in
`agent_subscriptions.rs`): an `agent:idle` only counts as the agent's
completion — firing its watchers' deliver-once wakes and recording `after_all`
group settlement — when the agent has genuinely settled. Four deferral
classes gate this, all probed **live at delivery time** (never from emit-time
event stamps):

- **Queue/busy interim** — ready-to-send queued messages, or a worker already
  busy in a new turn. Defers ungrouped watch delivery only; grouped watches
  are exempt (group accounting must see every completion).
- **Hook-waiting** — the agent owns active background hooks. Defers both
  watch delivery and grouped settlement records; TTL-bounded by hook expiry.
- **PR-monitor-waiting** (unified external-wait; intentd#1002) — the agent
  owns active PR monitors (§Centralized PR monitoring). Defers watch delivery
  and grouped settlement records exactly like hook-waiting, but has **no
  TTL** of its own (PR monitors don't expire) — it resolves only via the
  monitor's own terminal transitions (completion, owner `ws.pr.unmonitor`,
  external `prMonitor.cancel`, the `workspace.archive` sweep cancel
  (intentd#1067), or restart rehydration), each of which re-runs the
  redelivery backstop.
- **Agent-waiting** (monorepo#1468) — the agent itself holds live outgoing
  completion watches on other, unsettled agents (ungrouped or grouped; a
  coordinator with an open delegation group is waiting on its children).
  Defers watch delivery and grouped settlement records, like hook-waiting.

Two interim notions are deliberately split: `seal_interim`
(queue/busy/hook/PR-monitor) also blocks sealing the agent's own open
`after_all` group, while agent-waiting does **not** — an `after_all`
coordinator always holds grouped outgoing watches on its own children, so
gating the seal on agent-waiting would deadlock every group. The waiting
classification (`Services::agent_is_waiting_on_agents` /
`classify_agent_waiting`) bakes in a **2-cycle deadlock guard**: a mutual
watch pair whose both sides are idle is not a waiting reason (the pair
delivers as before); deeper cycles (A→B→C→A) are an accepted limitation,
deferring until an external event breaks the cycle. Never deferred by any
class: `agent:failed` / `agent:deleted`, the immediate `reportToParent`
wake, and the attention (blocker/discussion) fan-out.

Deferred idles record an interim-skip marker, and **redelivery backstops**
re-run the deferred completion when the deferral reason disappears without a
fresh idle: queue retraction/edit (queue interim), terminal hook transitions
(hook-waiting), terminal PR-monitor transitions (PR-monitor-waiting), and —
for agent-waiting — `agent.unwatch`, `agent.cancelSubscriptions`, and
`after_all` group settlement, each of which may remove the agent's last
outgoing watch. Restart paths share the same predicates: the startup watch
reconcile, registration-time reconciliation (re-arming a watch on an
already-idle target), and group rehydration all skip the synthetic
completion for a deferred child — group rehydration via a durable variant
that reads persisted `completion_watch` rows, since groups rehydrate before
the in-memory watch registry loads.

## Agent feature toggles (`[agentFeatures]`)

Wire contract: PROTOCOL.md §5.12 (settings catalog). Booleans under the
`[agentFeatures]` config.toml table — `backgroundHooks`, `hostExec`, `scripts`,
`terminalAccess`, `browserAutomation`, `richChatBlocks`, `structuredQuestions`,
`attentionRequests`, `stateSnapshot`, `prMonitor`, `taskGraph`, `peerAgents`,
`mcpTools`. All default `true` except the opt-in `peerAgents` (default
`false`). Each toggle removes
an agent-exposed feature from the agent's system prompt, its MCP tool surface,
or (for `stateSnapshot`) its per-turn prompt decoration. `taskGraph` is a
docs/prompt-only gate: it never dispatch-denies `tasks` or `greedy`, and its
unblocked-wake teaching uses the value captured when the parent session is
created rather than the live setting at wake delivery. `mcpTools` gates the
`ws.mcp.*` namespace (external MCP server tool forwarding,
[intentd#1483](https://github.com/intent-hq/intentd/pull/1483)) and is both
captured at bridge creation like the other toggles AND enforced live
server-side on every forwarded call in the services layer — which also honors
the `mcp.enableUserServers` master switch and the per-server disabled state
(`enabled: false` / `mcp.disabledServers`) — so the bridge-creation capture is
defense in depth for that toggle.

- **Three MCP gating layers per feature** (defense in depth): (a) the
  `workspace_api` **tool description** is assembled from per-namespace segments
  at bridge creation (`tools::workspace_api_description`), so a disabled
  feature's docs never reach the agent; (b) the **JS prelude** omits the gated
  namespace installers (`bindings::prelude_for`), so a call fails with a clear
  `TypeError` instead of silently dispatching; (c) the **dispatch layer**
  denies the method outright (`tools::denied_feature`) with an explicit
  `disabled in settings (agentFeatures.<key> = false)` error. Parity tests in
  `tools.rs` keep description ↔ bindings segment-aware. Gating is
  namespace-level except `attentionRequests` and `prMonitor`, which are
  method-level (`ws.agent.reportBlocker` / `ws.agent.requestDiscussion` only —
  `ws.agent.reportToParent` and the rest of `ws.agent.*` stay un-gated; and
  `ws.pr.monitor` / `ws.pr.unmonitor` / `ws.pr.monitors` only —
  `ws.pr.snapshot` stays un-gated).
- **Sub-agent question gate — top-level-only `ws.app.question.ask`
  ([intentd#1063](https://github.com/intent-hq/intentd/pull/1063)).** The same
  three layers also enforce a caller-identity gate (not a settings toggle):
  `WorkspaceMcpServer` carries an `is_sub_agent` flag (`with_sub_agent`),
  threaded into the workspace-host dispatch via
  `make_workspace_host_for_bridge`, derived once at bridge creation in
  `agent_manager` from
  the persisted session (`parent_agent_id.is_some() || is_background`; same
  spawn-time snapshot semantics as the toggle capture — `is_background` can
  flip via `agent.update`, but the bridge keeps its surface until the next
  respawn). For layers (a) and (b) the flag reuses the toggle machinery: a
  sub-agent bridge's *effective* features force `structuredQuestions` off
  (`effective_agent_features`), pruning the `ws.app.question.*` docs from the
  description and omitting the prelude installer (`ws.app.question` is
  `undefined`). Layer (c) checks `is_sub_agent` FIRST and denies
  `app.question.*` frames with the redirect error naming
  `ws.agent.requestDiscussion` / `ws.agent.reportToParent`
  (`dispatch::SUB_AGENT_QUESTION_DENIED`), so a sub-agent never sees the
  misleading "disabled in settings" denial; `ws.help("app.question")` takes
  the same branch and returns the honest top-level-only reason. Hook runs
  re-derive the owner's sub-agent status per run
  (`hook_manager::hook_owner_is_sub_agent`) and thread it through the
  `prelude_for_bridge` / `make_workspace_host_for_bridge` entry points, so a
  sub-agent-owned hook gets the same pruning and denial as its owner's
  bridge. A genuinely disabled `structuredQuestions` toggle keeps the
  settings error for every top-level caller, and a top-level bridge with the
  toggle on is byte-identical to the pre-gate assembly.
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
  through — the live services check is what denies it. Net effect: flipping
  `backgroundHooks` off denies new schedules immediately from **all** sessions.
  **Already-active hooks are unaffected by the toggle and run to their terminal
  state/TTL**.
  Hook script runs build their `ws.*` prelude from the effective flags read
  fresh per run — a hook outlives sessions and daemon restarts, so a hook run
  honors the same gates (e.g. `hostExec`) a newly created session would.
- **Per-turn state-snapshot injection (`stateSnapshot`).** The one toggle that
  gates neither a prompt section nor a tool: it governs only the
  `current ws.agent.snapshot() => {…}` line that
  `AgentManager::build_turn_prompt` prefixes to outbound turn prompts
  (PROTOCOL §5.5 "Per-turn agent state snapshot"). `stateSnapshot` is resolved
  in `Services::agent_state_snapshot_line` from the session's captured harness
  feature snapshot (`Services::session_agent_features`) like every other
  toggle ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)), so
  a flip applies to new sessions only; a legacy NULL-snapshot row falls back
  to the live settings until its first-activation freeze. The
  `ws.agent.snapshot()` MCP binding is deliberately never gated (no
  description/prelude/dispatch pruning), so the tool stays callable either way.
  The line is rebuilt per turn from live sources (hook store, watch registry,
  queue registry, event subscriptions, unsettled-children aggregate, pending
  questions, the session's attention request), skipped when the snapshot is
  trivial, and never persisted — the transcript row keeps the undecorated
  content, and all three skip paths (toggle off, trivial snapshot, build
  failure) leave the prompt byte-identical to pre-feature output.
- **New sessions only (except the live services-layer checks).** Flags are captured once
  at agent-session creation (the assembled system prompt is persisted
  per-session) and at per-agent MCP bridge creation — never live-read per call
  (deliberately unlike `workspaceApi.toonOutput`) — so a settings change
  applies only to sessions created afterwards; existing sessions keep the
  surface they were created with. The two exceptions above (`hook.schedule`'s
  `backgroundHooks` check and the per-call `mcpTools` check on forwarded
  `ws.mcp.*` calls) act on existing sessions immediately.

## Agent process-tree memory: characteristics & tuning knobs

Wire contract: PROTOCOL.md §5 (`system.status` — child-process tree fields).
The daemon's cost to the machine is its **descendant process tree**, not its
own heap: a 183 MB `intentd` binary was measured owning a 21.5 GB / 95-process
tree (monorepo#2063). An operator diagnosing memory pressure reads
`childProcesses` / `childMemoryBytes`; `memoryBytes` covers only the daemon
binary and understates the real footprint by more than an order of magnitude.
Each claim below carries the issue holding the capture it came from
(monorepo#2062, #2063, #2107, #2109), so a reader can check the method without
re-deriving the numbers. The handful of figures that are **arithmetic on**
those captures rather than captures themselves — a 20-agent seat's ~12 GB,
three concurrent test runs at ~29 GB, the 256-adapter ~156 GB ceiling — are
marked as projections where they appear.

**What an agent costs.** Per-agent cost spans a 22× range, so agent count is
not a predictor of memory and `agents.maxConcurrent` is a **concurrency cap,
not a resource cap** (monorepo#2063):

| Subtree | RSS | Notes |
| --- | ---: | --- |
| Idle / conversing agent (median of 7) | **~660 MB** | range 436–756 MB; `npm exec` → node ACP adapter → provider CLI → mcp-bridge |
| — provider CLI alone | 427–518 MB | |
| Agent running `vitest` | **9,617 MB** | 19 procs; 6 node workers at 0.8–2.3 GB each |
| Agent running `cargo check --workspace` | 2,087 MB | 24 procs |
| Agent running `pnpm run test:unit` | 1,154 MB | 10 procs |
| Ephemeral adapter chain (one-shot completion / model probe) | **~610 MB** | monorepo#2062; holds no agent slot, bounded lifetime |

A single agent therefore spans 0.44 GB → 9.6 GB, and the top of that range is
reached by an agent doing exactly what agents are for — three concurrent test
runs projects to ~29 GB (3 × the measured 9.6 GB, not itself a capture), an
ordinary coordinator fan-out.

**The tree is retained, not leaked.** Every agent touched inside the
`agents.idleReapMinutes` window stays resident (monorepo#2109, measured on
real `claude-code` chains, 10 agents driven to idle then left alone):

| `idleReapMinutes` | After idle | Result |
| --- | --- | --- |
| **30 (default until monorepo#2109)** | 10 minutes | **40 procs / 5.85 GB, flat — zero processes exited** |
| 2 | 122 s after last turn | **0 procs / 0 GB — drained completely** |

Retention claims in this section describe the **idle-reap sweep** in isolation.
The shipped default for `memoryBudgetMb` is auto (a RAM-derived budget), which
adds a second, independent eviction path: `ProcessRegistry::evict_idle` takes
no TTL and drops the LRU idle subtree to admit a spawn, so an idle tree can go
before its TTL and none of the retention figures below are guaranteed floors.
To observe the sweep-only behavior (no budget eviction), set
`memoryBudgetMb = 0`.

The reaper works; it was simply not asked to run for half an hour. That
measurement is what moved the shipped default to **10 minutes**: the same tree
begins draining once the window passes rather than holding 5.85 GB for a
further 20 minutes, and the 30-minute row above now describes the old default
rather than the shipped one.

> **On upgrade, an existing seat keeps the value its `config.toml` already
> carries — permanently.** The 10-minute default applies to **new installs**:
> the config template is written only when the file is absent, and every
> install created before this change has an explicit `idleReapMinutes = 30` in
> it, which wins over the shipped default. There is **no migration** — that 30
> stays until someone edits the file, by decision (monorepo#2109): a boot
> rewrite cannot tell a deliberate 30 from one the old template baked in, and
> silently overriding the former was judged worse than leaving the latter.
>
> So if your seat is accumulating memory right now, **upgrading will not change
> that — open `config.toml` and set `idleReapMinutes` yourself.**

An agent
becomes a candidate at the TTL and is picked up by the next sweep (interval
`ttl/4` clamped to `[30s, 300s]`, `reap_timings` in the `intentd` binary
crate), so **selection** is bounded by TTL + one sweep — but release is not
the same instant: `ProcessRegistry::evict_idle_older_than` awaits each kill
serially and each carries a SIGTERM→SIGKILL grace plus a descendant sweep, so
a large idle set drains over a tail rather than all at once. Only processes
idle past the TTL are candidates, and the sweep skips any agent the manager
reports busy when it checks (`AgentManager::reap_idle_older_than`'s
eligibility predicate).
Consequence for sizing: with the budget off, a seat that touches 20 agents
within the window holds all 20 subtrees at once even if only one is active —
projecting to ~12 GB at the measured ~0.6 GB idle median, more if any of them
ran a test suite.

**The knobs**, all under the `[agents]` table in `config.toml` (each is
self-described at the point of use in `DEFAULT_CONFIG_TEMPLATE`,
`intent-core/src/settings_file.rs`; all take effect on daemon restart):

| Knob | Default | Bounds |
| --- | --- | --- |
| `idleReapMinutes` | `10` (new installs; an existing `config.toml` keeps its own value — see above) | How long an idle agent subtree is retained (`0` disables the idle-reap **sweep** — it does not guarantee idle trees survive, since a non-zero `memoryBudgetMb` can still evict them at admission). **The lever for a memory-constrained seat.** |
| `memoryBudgetMb` | auto: `(RAM − 8 GB) / 2`, min 4 GB (absent key) | Aggregate RSS of the whole child tree, as a soft admission gate on new spawns. Absent key (the default) = auto (RAM-derived); explicit `0` = off (preserved for existing config files); positive value = budget in MB. Catalog max is the machine's own physical RAM, capped at 1,024,000 MB. |
| `maxConcurrentAdapters` | `6` (on) | Concurrently live ephemeral adapter chains (quick actions, model probes). |
| `maxConcurrent` | `0` (auto from RAM) | Agent **slots**. Not a memory bound — see the 22× range above. |

- **`memoryBudgetMb` is a soft admission gate, not a ceiling**
  (monorepo#2063, validated end-to-end against real agents). Set to 1500 MB,
  a 20-agent simultaneous burst peaked at **3.06 GB** against **12.37 GB**
  unbounded, and settled at 1.73 GB against 11.56 GB; the same-budget 8-agent
  burst peaked at 2.47 GB and 3.09 GB across two runs — i.e. **the bound does
  not scale with demand**, a 4× larger request peaks the same (3.06 vs 3.09
  GB). The costs: transient overshoot of **65–105%** and
  steady state **~16% over**. The overshoot is structural rather than
  accidental (`live == 0` always admits, the provisional charge is a fixed
  `PROVISIONAL_AGENT_BYTES` = 660 MB, and `budget_pending_bytes` resets when a
  new sample seq lands while a just-spawned agent's RSS is still ramping —
  `ProcessRegistry` in `intent-services/src/agent_manager.rs`), so it is a
  **fixed offset, not proportional to demand**: budget for roughly 2× the
  configured value as the transient. That sizing rule covers the **admission**
  transient the measurement exercised — a burst of comparable agents — and is
  not a runtime ceiling. The gate runs at spawn only: an already-admitted
  agent whose own workload grows (the 9.6 GB `vitest` case above) is never
  re-checked and can carry the tree past the budget by itself, and the gate's
  only lever against that is refusing later spawns and evicting idle trees.
  Admission only — nothing running is ever killed, and all turns complete.
  The settings catalog advertises the bound as `min 0` / `max` = detected
  physical RAM in MB, **capped at 1,024,000 MB** — which is also the value used
  where detection is unavailable (it is Linux/macOS only) and the static bound
  `config.toml` parsing enforces. So a client renders a slider over the range
  the setting can meaningfully take, and on a seat with more than ~1 TB of RAM
  the cap binds instead of the RAM figure. The cap is not cosmetic: the
  catalog bound must never exceed the parse bound, or `settings.update` would
  accept a value that the same schema then rejects on the way to disk. The
  parse bound itself stays static and machine-independent, so a `config.toml`
  written on one seat still parses on another — meaning the divergence runs
  one way only, and a config carrying a budget above *this* machine's RAM
  still loads and is reported with a `value` above the advertised `max`.
- **`maxConcurrentAdapters` closes the quick-action burst path**
  (monorepo#2062). One-shot completions and model probes never enter
  `ProcessRegistry`, so they consume no `maxConcurrent` slot and do not appear
  in `system.status.agents` — before the bound the only ceiling was
  `server.maxOutstandingRpcs` (256), which projects to ~156 GB of adapter
  chains. **Once a burst exceeds the cap**, peak live chains equal the cap
  exactly and are invariant to how much bigger the burst is (a 16-call burst
  at cap 6 peaked at 3.57 GB); a burst smaller than the cap is unaffected and
  simply peaks at its own size. Over-limit callers queue FIFO on the
  semaphore in `intent-services/src/acp_adapter.rs` and, if their own timeout
  expires first, fail with `-32603` and
  `error.data.code = "adapter-busy"` **having spawned nothing** — a retry is
  always safe.

**Caveat: do not judge a burst from `childMemoryPeakBytes`** until
monorepo#2107 is fixed. The high-water mark is a maximum over 5 s samples
(`CHILD_TREE_SAMPLE_SECS`), so a burst that peaks between ticks is never seen.
Measured against a 1 Hz `ps` descendant walk:

| Run | `ps` @ 1 Hz | `childMemoryPeakBytes` | Under-report |
| --- | ---: | ---: | ---: |
| bounded (cap 6, 16 calls) | 3.57 GB | 3.57 GB | 0% |
| unbounded (cap 64, 16 calls) | 7.00 GB | 3.48 GB | **−50%** |
| unbounded (cap 64, 16 calls, repeat) | 8.97 GB | 5.43 GB | **−39%** |

Read from telemetry alone, **the unbounded run looks cheaper than the bounded
one** — the inverted conclusion. Steady state is accurate (a running soak read
5.85 GB by both methods); the field aliases only on transients, which is
precisely the case it was introduced for.

**`idleReapMinutes` now defaults to 10, not 30** — on new installs; see the
upgrade note above for why an existing seat is unaffected (monorepo#2109,
reversing the earlier decision on that issue to leave defaults alone). The
reasoning that originally argued for holding still is unchanged and is what
keeps the new default off the floor: reaping earlier costs every user a warm
process on next
use, and the measured accumulation is a function of how many agents a seat
touches — which differs enormously between a single-agent user and a
coordinator fanning out a dozen. What changed is the read on where the
midpoint sits. 30 minutes is long enough that the two cases converge in the
worst direction — with the budget off, the coordinator holds every subtree it
touched anywhere in that half-hour window, re-extending it on each fan-out (the
5.85 GB flat row above measured 10 minutes of that, not a whole session), while
the single-agent
user gains a warm process they were unlikely to return to that late anyway. 10
minutes keeps the warm path for the case that actually re-enters an agent while
bounding what a fan-out retains, and `0` still turns the sweep off entirely for
anyone who wants the old behaviour — with the caveat above that `0` stops the
sweep, not every path that can reclaim an idle tree. A seat still hitting the
accumulation path should reach for `idleReapMinutes` first, then
`memoryBudgetMb`.

## File watching: shared OS watchers & Linux host limits

Wire contract: PROTOCOL.md §5 (`system.status` — file-watch coverage fields).
File events (`file:*`, plus the skills/specialists rescans) come from recursive
`notify` watchers over watch roots. Watchers are **shared streams**: one OS
watcher serves many roots, with a demux narrowing each event to the
subscriber's own root. Grouping is per platform — on macOS (FSEvents) roots
group per parent directory; on **Linux (inotify) ALL roots share a single
global stream** ([intent-hq/intentd#1550](https://github.com/intent-hq/intentd/pull/1550)).
That matters because every `notify` watcher costs one inotify **instance**
(one fd, capped by `fs.inotify.max_user_instances`, default 128): the earlier
per-parent-directory grouping made the instance count scale with the workspace
count and exhausted the cap on multi-workspace hosts
([intent-hq/intent#3708](https://github.com/intent-hq/intent/issues/3708));
the single global stream keeps it at one instance total.

Recursive **watches** still scale with directory count: on Linux each watched
directory consumes one slot of `fs.inotify.max_user_watches` (default 8192 on
many distros, 65536 on newer kernels) regardless of how streams are grouped,
so a host with many or large checkouts can exhaust the watch cap even with a
single inotify instance.

**Tuning a multi-workspace Linux host:**

- Raise `fs.inotify.max_user_watches` — e.g. `1048576` (each slot costs ~1 KB
  of kernel memory only while in use):

  ```bash
  sudo sysctl fs.inotify.max_user_watches=1048576
  echo fs.inotify.max_user_watches=1048576 | sudo tee /etc/sysctl.d/60-inotify.conf
  ```

- Check the daemon's open-file limit (`ulimit -n` / `nofile`): the global
  watch group holds inotify instances at one, but sockets, PTYs, and child
  pipes still consume fds — a low `nofile` (1024 on some distros) surfaces as
  the same class of resource failures on busy multi-workspace hosts.

**Symptoms of exhausted limits.** Watch-coverage degradation is WARN-logged;
the creation/registration WARNs carry the live `/proc/sys/fs/inotify` limits
(as `os_watch_limits: inotify max_user_instances=… max_user_watches=…`) so an
operator can judge at a glance whether a failure is cap exhaustion:

- `"shared watcher creation failed; roots in this group are unwatched until a
  retry succeeds"` — the OS watcher itself could not be created (e.g. inotify
  instance exhaustion). Creation is retried with capped exponential backoff
  (about once a minute at the cap), and the group's roots are re-registered
  once it succeeds.
- `"shared watch registration failed"` — one root's recursive registration
  failed (e.g. `ENOSPC` watch-slot exhaustion, or the directory vanished).
- `"shared watcher callback error; events may be missed"` — the live watcher
  reported an error on its event stream (e.g. `notify`'s "OS file watch limit
  reached").

The same degradation is surfaced on the wire as the `system.status`
`fileWatch` object (`failedRoots > 0`, or `activeStreams` below the expected
count — `0` while `totalRoots > 0` under creation failure), so coverage loss
is visible to clients, not just in the daemon log.

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
