# Intent Backend — Wire-Protocol Reference

> Status: Design / pre-implementation reference.Audience: Frontend (Tauri/Svelte, mobile, CLI) and agent developers building clientsagainst the Intent backend daemon (intentd).Companion document: ./IMPLEMENTATION_SPEC.md — theengineering spec (architecture, crates, persistence, ACP/GitHub integration, roadmap).This document is the wire contract: transport, JSON-RPC envelope, the full methodcatalog, events, agent streaming, the permission flow, error codes, and thin-client guidance.

This protocol is **observably defined** by the Intent Electron app's WebSocket API — the`augmentcode/intent` repository — and is the contract theRust backend must reproduce byte-for-byte. The authoritative TypeScript sources are listed below.

> Source convention: All src/... paths in this document refer to files in theaugmentcode/intent repository (the Electron reference implementation). A rust-backend/source tree does not exist yet — it ships only when intentd is implemented.

- `src/main/websocket-api-server.ts` — HTTPS/WSS listener, `/ws` endpoint, upgrade auth,origin allow-list, 30s/60s heartbeat, `events.subscribe`/`events.unsubscribe` fast-path.
- `src/main/websocket-protocol-handler.ts` — the JSON-RPC dispatcher (**106 methods**).
- `src/main/websocket-event-bridge.ts` — subscription tracking → `events.event` notifications.
- `src/main/websocket-auth.ts` — bearer token gen/validate (timing-safe), enable/discovery flags.
- `src/main/websocket-tls.ts` — self-signed cert generation + SHA-256 fingerprint pinning.
- `src/main/websocket-discovery.ts` — Bonjour/mDNS advertisement (`_intent-ws._tcp`).
- `src/features/events/types.ts`, `event-filter-engine.ts` — event taxonomy + filter semantics.
- `src/features/agent/main/agent-providers/acp-provider.ts` — ACP streaming + permission flow.

## Table of Contents

1. [Transport](#1-transport)
2. [Authentication](#2-authentication)
3. [Message Envelope (JSON-RPC 2.0)](#3-message-envelope-json-rpc-20)
4. [Heartbeat & Lifecycle](#4-heartbeat--lifecycle)
5. [Method Catalog](#5-method-catalog)
6. [Events & Subscriptions](#6-events--subscriptions)
7. [Agent Streaming](#7-agent-streaming)
8. [Permission Flow](#8-permission-flow)
9. [Error Codes](#9-error-codes)
10. [Thin-Client Guidance](#10-thin-client-guidance)

## 1. Transport

### 1.1 Connection URL

The backend runs a dedicated **HTTPS server bound to **`0.0.0.0` (LAN-reachable) exposing asingle WebSocket endpoint:

```
wss://<host>:<port>/ws
```

- **Default port:** `5180`. If busy, the server walks forward up to `WS_API_MAX_PORT_ATTEMPTS`(10) ports with same-port backoff (`[100, 200, 400]ms`) before advancing — so clients shouldtreat the port as **discovered**, not hard-coded (see §1.4 mDNS, or the `/health` probe).
- **Scheme is always **`wss://` (TLS). There is no plaintext `ws://` listener.
- A plain HTTPS `GET /health` returns `{"status":"ok","clients":<n>}` for liveness probing.
- Any path other than `/ws` is rejected at upgrade time (socket destroyed).

> Unix-domain socket: The Rust daemon (intentd) additionally targets a UDS transportfor the local-first default (see IMPLEMENTATION_SPEC.md §5). The JSON-RPC envelope, methodcatalog, and event semantics are identical across UDS and TCP/TLS — only the listener differs.The Electron reference implementation today ships the TCP/TLS/WSS listener only.

### 1.2 TLS & fingerprint pinning

The server generates a **self-signed** EC (P-256) certificate on first start, persists it underthe app's userData dir (`ws-cert.pem` / `ws-key.pem`), and reuses it across restarts (10-yearvalidity). Because it is self-signed, **clients pin the certificate** rather than relying on a CA:

- The server exposes a **SHA-256 fingerprint**, colon-separated uppercase hex(e.g. `AB:CD:EF:...`), computed over the DER body of the cert.
- Certificate SANs include `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 addresson the host (LAN, Tailscale, etc.), so connecting by hostname or LAN IP validates against the SAN.
- Clients should **pin the fingerprint** (obtained out-of-band during pairing, or from the mDNSTXT record `fp=` below) and reject any cert whose fingerprint does not match.

### 1.3 mDNS / Bonjour discovery

When discovery is enabled the server advertises a Bonjour/DNS-SD service so mobile/LAN clients canauto-discover the running instance:

- **Service type:** `_intent-ws._tcp`
- **Service name:** `Intent on <hostname>`
- **Port:** the bound WSS port.
- **TXT record keys:**
  - `version` — `"1"`
  - `path` — `"/ws"`
  - `hostname` — `os.hostname()`
  - `fp` — the TLS cert SHA-256 fingerprint (present when a cert exists; used for pinning)

A client resolves the service, reads `fp` for pinning, and connects to `wss://<resolved-host>:<port>/ws`.

## 2. Authentication

### 2.1 Bearer token on upgrade

Every WebSocket upgrade must present a bearer token. The server checks the token **during theHTTP upgrade** (before the socket is upgraded) in this order:

1. `Authorization: Bearer <token>` header.
2. `?token=<token>` query parameter on the `/ws` URL (for clients that cannot set headers).

Validation is **timing-safe** (constant-time compare) against the stored token. On failure theupgrade is rejected with `HTTP/1.1 401 Unauthorized` and the socket is destroyed.

- The token is **32 random bytes, hex-encoded (64 chars)**, generated once and persisted in appsettings. It can be rotated (regenerated) by the host application.
- If the WebSocket API is disabled in settings, upgrades are rejected with `403 Forbidden`.

### 2.2 Origin allow-list

Browser-origin upgrades are gated to prevent cross-origin attacks; native clients are allowed:

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients never send one), `file://`(Electron renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's ownhostname / `.local` form (so LAN clients connecting by advertised hostname pass).
- **Rejected (**`403`**):** `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

### 2.3 Where the token lives

The token, the API-enabled flag, and the discovery-enabled flag are persisted in the host app'ssettings store (electron-store in the reference impl). Clients obtain the token out-of-band via apairing flow (the host surfaces token + fingerprint together). In intentd, an operator can run `intentd token` to print the current bearer token and TLS certificate fingerprint together for pairing (and `intentd token --rotate` to regenerate the token).

## 3. Message Envelope (JSON-RPC 2.0)

All application messages are **JSON-RPC 2.0** text frames. The handler is transport-agnostic: ittakes a message string and returns a response string (or `null` for notifications).

### 3.1 Request

```json
{ "jsonrpc": "2.0", "id": 1, "method": "note.list", "params": { "workspaceId": "ws-abc" } }
```

- `jsonrpc` — **must** be the string `"2.0"`. Otherwise → `-32600 Invalid Request`.
- `method` — **must** be a non-empty string. Otherwise → `-32600`.
- `id` — string, number, or `null`. Any other type → `-32600`.
- `params` — object (named) or array (positional). **Named (object) params are required by thisAPI.** Positional arrays are *accepted* per spec but coerced to `{}` (so the call runs with noargs). Non-object/array `params` → `-32602 Invalid params`.

### 3.2 Success response

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "notes": [ /* ... */ ] } }
```

`result` is always a JSON **object** (never a bare array/scalar); list endpoints wrap their arrayunder a named key (e.g. `{ "notes": [...] }`, `{ "agents": [...] }`).

### 3.3 Error response

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Missing required parameter: noteId" } }
```

`error.data` is optional and carries extra context (e.g. the original internal error message for`-32603`). See §9 for the code table.

### 3.4 Notifications (no response)

A request **without an **`id`** member** is a notification: the server processes it and returnsnothing. Note the distinction required by JSON-RPC 2.0:

- `id` **absent** → notification → no response is ever sent (even on error / unknown method).
- `id: null` **present** → a normal request that **must** receive a response.

Unknown methods sent as notifications are silently ignored; unknown methods sent as requests get`-32601 Method not found`.

### 3.5 Batching

The reference server processes **one JSON-RPC object per WebSocket text frame**. JSON-RPC batch*arrays* are **not** supported as a batch unit: a top-level array fails envelope validation(`-32600 Invalid Request: expected an object`). Clients should send one message per frame andcorrelate responses by `id`. (Independent requests can be pipelined — the server does not requirerequest/response lock-step — but each must be its own frame.)

### 3.6 `workspaceId` scoping

Most methods operate within a workspace. `workspaceId` is read from `params.workspaceId`, fallingback to a connection-level context value if the transport provides one. If neither is present, themethod returns `-32602 "workspaceId is required"`. The workspace/repo/specialist/global methods(e.g. `workspace.list`, `repo.list`, `specialist.list`, `agent.getModels`) do not require it.

## 4. Heartbeat & Lifecycle

- **Ping/pong:** The server sends a WebSocket **ping every 30s** (`HEARTBEAT_INTERVAL_MS`). Theclient's transport must answer with a standard pong frame (handled automatically by compliantWebSocket libraries). If no pong is seen within **60s** (`HEARTBEAT_TIMEOUT_MS`), the serverterminates the connection and cleans up its subscriptions.
- **Server shutdown:** On graceful stop, clients are closed with code `1001`(`"Server shutting down"`) and all transport-local subscriptions are dropped.
- **Disconnect cleanup:** On `close` or socket `error`, the server removes the client and all ofits event subscriptions. Subscriptions are **per-connection** and do **not** survive reconnects.
- **Reconnection guidance:** Clients should reconnect with backoff, re-authenticate on the newupgrade, and **re-establish all subscriptions** (re-send `events.subscribe`). Because canonicalstate lives in the backend, after reconnect a client should **re-fetch** the entities it caresabout (subscribe-then-fetch, §10) rather than assuming it missed nothing.

## 5. Method Catalog

The API exposes **104 JSON-RPC methods** across 15 namespaces, **ported from **`augmentcode/intent`**'sElectron WebSocket API** (`getSupportedMethods()` on the reference server returns 106 method names; the two `browser.*` methods are explicit **won't-port-v1** in intentd — §5.9 — so the counts below sum to **104**). On top of the ported surface `intentd` adds **additive, intentd-only methods and events** that are *not* part of the verified ported surface, so the ported count stays intact. The additive surface is:

- `settings.*` — 4 methods (§5.12), server-side settings.
- `workspace.dismissAttention` / `workspace.markSeen` (§5.1) — mutate the workspace `attention` field; the derived `activity` field is read-only.
- interactive `terminal.*` — `create` / `write` / `resize` / `kill` / `getBuffer` (§5.13); the ported `terminal.list` / `terminal.readOutput` stay in the 104.
- `host.*` / `forward.*` (§5.14) — host-capability probe, FE-served open-external, and remote port-forwarding.
- `search.*` (§5.15) — 8 BE-owned search methods (`inFiles`, `fileNames`, `messages`, `events`, `memories`, `notes`, `codebase`, `cancel`); search runs on the daemon, where the code/data live, with `search:result` / `search:done` streaming.
- `drafts.*` (§5.16) — 3 methods (`get` / `set` / `clear`) for BE-persisted, per-client message drafts, with the `draft:changed` event.
- `client.hello` (§5.17) — stable client-identity handshake; the disambiguation key for `drafts.*` and future per-viewer read cursors.
- `system.status` / `system.shutdown` (control fast-path) — a **UDS-only** transport/process-control pair: `system.status` reports daemon liveness + transport/port/client/agent/cert-fingerprint/host-capability state, and `system.shutdown` requests a graceful daemon shutdown. Like `events.subscribe`/`unsubscribe`, they are intercepted **before** the JSON-RPC dispatcher; they are intentd-only ops methods, **not** part of the ported 104 and **not** advertised by `getSupportedMethods`. Consumed by `intentd status` / `intentd stop`.
- **Catalog parity additions** — small additive read/write methods routed alongside the ported surface and **not** counted in the ported 104: `comment.resolveThread` (§5.3); `task.list` / `task.get` (§5.4); `agent.diagnostics` (§5.5); `git.unstage`, `git.changes`, `git.diffs` (alias `git.diff`), `git.commits` (alias `git.log`) (§5.6); `file.tree` (§5.9). See each per-namespace table for shapes.
- **Code Changes Review** — the agent-change review loop. `accept-changes.*` (§5.18) — `getStatus` / `prepare` / `execute` / `mergePR` / `addRemote`; `file-tracking.*` **reads** (§5.19) — `init` / `sync` / `load` / `loadCommits` / `getChanges` / `getLineStats` / `stage` / `unstage`; change-metrics **reads** (§5.20) — `getWorkspaceStats` / `getAgentStats` / `getAllWorkspaceStats` / `clearAgentStats`; and `pr.*` **extensions** — `getReviews` / `listCheckRuns` / `createReview` (folded into the existing `pr.*` table, §5.7). Backed by the `SourceControl` trait (IMPLEMENTATION_SPEC.md §7) for the forge calls.
- **Agent Ecosystem** — the BE-owned agent control surface. `rules.*` (§5.21) — `list` / `get` / `update` (workspace + specialization rules and user-rule overrides; the prompt-assembly/injection pipeline itself is **internal**, not a wire method); `specialist.*` **full CRUD** — `get` / `create` / `edit` / `delete` extend the ported `specialist.list` into a managed namespace (§5.11); and `mcp.servers.*` (§5.22) — `list` / `create` / `update` / `delete` / `toggle` / `restart` for **external** MCP-server lifecycle/config (distinct from the agent→BE MCP callback, IMPLEMENTATION_SPEC.md §6.8), with the `mcp.servers:status-changed` health event.
- **Integrations & Ops** — the BE-owned usage & worktree-setup surface. Usage metrics — `workspace.getTokenUsage` (§5.23) + the `tokenUsage` field on workspace, with the `workspace:tokenUsage-changed` event (the periodic usage/credit **scan job** is daemon-internal — no RPC); session stats — `agent.getSessionStats` (§5.24) + the `stats` field on `AgentSession`, with the `agent:session-stats-changed` event; and worktree setup — `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript` (§5.25) + the `setupScript` field on workspace. **Sentry/sandbox** integrations and **observability/logging** are explicitly **not** wire surface in v1 (§5.26); **Linear** is specified as a daemon-owned TARGET contract (`linear.*`, §5.28).

> **Internal, not wire (Code Changes Review).** Diff computation/versioning (`diffs.*`), agent-attribution `trackChange`, and metrics aggregation (`metrics.calculate` and the `update*` writers) run **entirely inside the backend** with no client RPC. Diff bodies are computed/stored internally and surfaced through the `file-tracking.*` reads above plus the change events in §6.5 — clients never call a `diffs.*` method. See the cross-cutting principle in §6.8.

> **Internal, not wire (Agent Ecosystem).** Rule **injection** — assembling the system prompt from workspace files (`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization rules, and user overrides — runs **inside the backend** as agents start; only the `rules.*` read/edit methods (§5.21) cross the wire. Per-agent-type tool **denylisting** is likewise internal enforcement — there is **no** `agent.getAvailableTools` RPC. Long-term agent **memories** are an internal context source consumed by the agent runtime; no `memories.*` wire surface is exposed — it is **not ported** (a vestigial in-memory stub; cancelled, not deferred — see §5.22). See §6.8.

> **Internal, not wire (Integrations & Ops).** The periodic **usage/credit scan job** that tallies token usage per agent and per model runs **inside the daemon** on a timer; clients never trigger it — they read the result via `workspace.getTokenUsage` (§5.23) and are pushed `workspace:tokenUsage-changed`. **Observability** (tracing, structured logs, log files) is likewise daemon-internal: there is **no** `logging.*` / `telemetry.*` wire surface. **Linear** is now specified as a daemon-owned TARGET contract (`linear.*`, §5.28); **Sentry** integration remains **deferred** (no `sentry.*` methods in v1) — see the future-integrations note (§5.26). See §6.8.

Framing stays: **"104 ported from `augmentcode/intent` (the reference 106 minus the two `browser.*` methods, explicit won't-port-v1) + additive intentd-only surface (`settings.*`, workspace status/attention, interactive `terminal.*`, `host.*`/`forward.*`, `search.*`, `drafts.*`, `client.hello`, the Code Changes Review surface: `accept-changes.*`, `file-tracking.*` reads, change-metrics reads, `pr.*` extensions; and the Agent Ecosystem surface: `rules.*`, `specialist.*` CRUD extensions, `mcp.servers.*`; and the Integrations & Ops surface: `workspace.getTokenUsage`, `agent.getSessionStats`, `workspace.getSetupScript`/`saveSetupScript`/`detectProjectType`/`generateSetupScript`; plus the catalog-parity additions enumerated above)"**. The ported 104 count is unchanged — every namespace in the count table below is part of the verified ported surface; the additive intentd-only surface is deliberately **not** in that table. The three `pr.*` extension methods are additive and do **not** change the ported `pr` count of 9; likewise the four `specialist.*` CRUD methods are additive and do **not** change the ported `specialist` count of 1, and `rules.*` / `mcp.servers.*` are entirely new additive namespaces. The Integrations & Ops usage/setup-script methods are additive onto existing namespaces and do **not** change the ported counts: `workspace.getTokenUsage` / `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript` leave the ported `workspace` count of 7 intact, and `agent.getSessionStats` leaves the ported `agent` count of 24 intact. The catalog-parity additions (`comment.resolveThread`, `task.list`/`task.get`, `agent.diagnostics`, `git.unstage`/`git.changes`/`git.diffs`/`git.commits`, `file.tree`) are likewise additive and leave the ported `comment`/`task`/`agent`/`git`/`file` counts unchanged.

| Namespace | Count | Methods |
| --- | --- | --- |
| workspace | 7 | list, get, create, update, delete, archive, unarchive |
| note | 12 | list, get, create, update, add, edit, editLines, setContent, updateMetadata, delete, listTasks, readAsset |
| comment | 5 | add, list, getThread, respond, delete |
| task | 8 | updateStatus, updateNoteStatus, update, getMyTask, markAsTask, convertBlocks, createPrerequisite, assignAgent |
| agent | 24 | delegate, sendToTask, subscribe*, unsubscribe*, wakeOrCreate, summary, reportToParent, list, get, getConversation, sendMessage, queueMessage, editQueuedMessage, removeQueuedMessage, getQueue, stop, forceMessage, getModels, setModel, getSubscriptions, cancelSubscriptions, create, rename, delete |
| git | 6 | status, stage, commit, agentCommit, checkMergeConflicts, getBranches |
| pr | 9 | merge, status, updateBranch, waitForChanges, listReviewComments, replyToReviewComment, resolveThread, listComments, postComment |
| script | 9 | list, create, remove, start, stop, restart, output, status, run |
| terminal | 2 | list, readOutput |
| file | 6 | read, write, list, delete, mkdir, rename |
| event | 7 | recentFiles, agentActivity, workspaceSummary, directoryChanges, query, subscribe*, unsubscribe* |
| crossWorkspace | 3 | listSiblings, readNote, listNotes |
| primitive | 4 | addReference, addCli, addPatch, addAgentAction |
| specialist | 1 | list |
| repo | 1 | list |

> Deprecated aliases. agent.subscribe/agent.unsubscribe and event.subscribe/event.unsubscribe exist in the method map but are not the canonical WebSocket subscriptionsurface. For live event streaming use the bridge methods events.subscribe /events.unsubscribe (note the plural events.), handled directly by the server before thedispatcher — see §6. The agent./event.* variants create internal/agent-style subscriptionsand do not wire a WebSocket client up to events.event notifications.

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields`-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires`workspaceId` (see §3.6) and may return `-32603 Internal error` if the underlying service throws.

### 5.1 `workspace.*`

| Method | Params | Result |
| --- | --- | --- |
| workspace.list | includeArchived?: boolean (default false) | { workspaces: Workspace[] } |
| workspace.get | workspaceId (req) | { workspace: Workspace } — -32602 if not found |
| workspace.create | workspace fields; optional initialAgent: { agentId, prompt, name?, model?, specialist?, provider?, behaviorPrompt?, agentType?, imageBlocks?, metadata? } | { workspace: Workspace } (initial agent is activated async, fire-and-forget) |
| workspace.update | workspaceId (req) + fields to change | { workspace: Workspace } |
| workspace.delete | workspaceId (req) | { success: true } |
| workspace.archive | workspaceId (req) | { success: true } |
| workspace.unarchive | workspaceId (req) | { success: true } |
| workspace.dismissAttention | workspaceId (req) | { workspace: Workspace } — clears `attention` to `"none"`; -32602 if not found |
| workspace.markSeen | workspaceId (req) | { workspace: Workspace } — marks the workspace seen (clears unread `attention`) |

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "workspace.list", "params": { "includeArchived": false } }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "workspaces": [ { "id": "ws-abc", "title": "My Workspace" } ] } }
```

**Workspace status fields (new in intentd).** Two BE-owned fields appear on every `Workspace`
object returned by `workspace.*` — lightweight status metadata, **not** a notification store —
each with a dedicated change event (§6.5) that carries the new value:

- `activity` — **derived, read-only (green dot).** In-flight agent state, e.g.
  `"idle" | "agent_running"`. The BE computes it from agent state; clients never set or
  recompute it. It has no setter; it surfaces in `workspace.*` results and via
  `workspace:activity-changed` (§6.5).
- `attention` — **dismissible (blue dot).** A small flag raised by BE transitions, e.g.
  `"none" | "unread" | "review_required"`. Server-owned, so dismissing it from any client
  clears it for all clients. Cleared via `workspace.dismissAttention` / `workspace.markSeen`;
  surfaces via `workspace:attention-changed` (§6.5). This folds the reference app's per-client
  localStorage "unread" into shared BE state (the daemon is single-user in v1; per-viewer
  cursors are a future extension).

**`status` wire form.** `Workspace.status` serializes as the PascalCase TS `WorkspaceStatus`
string enum — `"Active" | "Inactive" | "Archived" | "Deleted"` (src/shared/types.ts) — both on
the wire and as the stored DB word (matching the `PullRequestStatus` precedent). Optional
`Workspace` fields (`statusMessage`, `baseRef`, `prNumber`, `prStatus`, `activePullRequest`,
`lastActivity`, `archivedAt`, repository/worktree fields, …) are **omitted when absent**
(`skip_serializing_if`) rather than emitted as `null`, so clients see only populated keys.

**Card aggregates (`taskStats` / `agentSummary` / `diffSummary`).** `workspace.list` and
`workspace.get` enrich each `Workspace` with the nested rollup objects the iOS coverflow cards
read, computed fresh from live state on the emit path (never persisted). They are decoded as
optional by iOS and each is **omitted when not computable** (`skip_serializing_if`) rather than
emitted as `null`, so absent simply yields a sparser card:

- `taskStats: { total, completed, inProgress }` — ports the canonical `computeTaskStats`
  (`task-stats.ts`) over the spec-linked direct-child task notes: `cancelled` is excluded from
  `total`, `complete` counts as `completed`, and `in_progress` + `review_required` count as
  `inProgress`. The renderer-only per-task `tasks` array is omitted.
- `agentSummary: { count, agents: WorkspaceAgentInfo[], agentIds: string[] }` where
  `WorkspaceAgentInfo = { id, name, status, specialist?, lastActivity?, isStreaming, isResponding }`.
  This matches the **live iOS `WorkspaceStore.parseWorkspace` consumer** (the richer
  `{ count, agents }` form); `agentIds` is additionally emitted alongside it for forward-compat with
  the slim TS `WorkspaceAgentIdSummary { agentIds }` (a future desktop-on-intentd reads
  `agentSummary?.agentIds ?? []`) and lists the same agents (same order) used to build `agents`.
  `status` carries the same wire strings as `agent.list`; `isStreaming`/`isResponding` are always
  `false` (the headless backend has no live stream state — `status` carries liveness, matching the
  `AgentLite` decision); `lastActivity` is the session `updatedAt`.
- `diffSummary: { schemaVersion, updatedAt, totalFiles, totalAdditions, totalDeletions, files }` —
  ports the on-demand `computeWorkspaceDiffSummary` (`workspace-summaries.ts`): `totalFiles` counts
  changed-vs-`HEAD` (staged+unstaged) plus untracked files; line totals sum the tracked diff;
  `files` mirrors the on-demand source (empty array). Omitted entirely when the workspace has no git
  worktree or no changes.

See IMPLEMENTATION_SPEC.md §9.1 (Workspace entity) for the persisted field definitions and
§10 (Events) for emission.

```json
// → request — dismiss the blue-dot attention flag
{ "jsonrpc":"2.0","id":2,"method":"workspace.dismissAttention","params":{ "workspaceId":"ws-abc" } }
// ← response (attention reset; emits workspace:attention-changed)
{ "jsonrpc":"2.0","id":2,"result":{ "workspace":{ "id":"ws-abc","activity":"idle","attention":"none" } } }
```

### 5.2 `note.*`

All `note.*` methods require `workspaceId` + `noteId` (except `list`/`create`). The spec note isaddressed with the well-known id `"spec"`.

| Method | Params | Result |
| --- | --- | --- |
| note.list | — | { notes: NoteSummary[] } |
| note.get | noteId (req) | { note: Note } — -32602 if not found |
| note.create | title (req), content?, tags?: string[], parentId? | { note: Note } |
| note.update | noteId (req); content? or title?/tags? | { note } — content present → full setContent; else metadata update |
| note.add | noteId (req), content (req), heading?, position?: "end" | "start" |
| note.edit | noteId (req), old (req), new (req) | { ok, ... } — first exact-match replacement |
| note.editLines | noteId (req), start (req,int), end (req,int), content (req) | { ok, ... } (1-based inclusive) |
| note.setContent | noteId (req), content (req), confirmReplacement?: boolean | { ok, ... } (full replace) |
| note.updateMetadata | noteId (req), title?, tags?: string | string[] |
| note.delete | noteId (req) | { ok, noteId, deleted } |
| note.listTasks | noteId (req) | { tasks: [...] } (checkbox/task rows + taskNoteId) |
| note.readAsset | asset (req) — asset id or workspace-asset:// URL | { assetId, mimeType, data, sizeKb } (image assets returned as data) |

```json
// → request
{ "jsonrpc":"2.0","id":7,"method":"note.add",
  "params":{ "workspaceId":"ws-abc","noteId":"spec","content":"## Phase 2\nDraft","position":"end" } }
// ← response
{ "jsonrpc":"2.0","id":7,"result":{ "ok": true, "noteId":"spec" } }
```

### 5.3 `comment.*`

| Method | Params | Result |
| --- | --- | --- |
| comment.add | noteId (req), searchContext (req), commentTarget (req), comment (req), type?, author? | { ok, ... } (anchors by text search) |
| comment.list | noteId (req), since?, authorType?, status?, includeComments? | { threads: [...] } |
| comment.getThread | noteId (req), threadId? or commentId? | { thread } |
| comment.respond | noteId (req), comment (req), threadId?/commentId?, type?, author?, suggestionOriginal?, suggestionProposed? | { ok, ... } |
| comment.delete | noteId (req), commentId (req) | { ok, ... } |

**`comment.*` extensions (new in intentd — additive; do not change the ported count of 5).** One additional method addresses an entire thread by `threadId` **or** `commentId`. Emits the `comment:resolved` event (§6.5).

| Method | Params | Result |
| --- | --- | --- |
| comment.resolveThread | noteId (req), threadId? or commentId?, resolved?: bool (default true) | { ok, ... } — marks every comment in the thread (un)resolved |

### 5.4 `task.*`

| Method | Params | Result |
| --- | --- | --- |
| task.updateStatus | noteId (req), taskText (req), status (req: done | todo |
| task.updateNoteStatus | noteId (req), status (req: not_started | waiting |
| task.update | noteId (req), line (req,int), text?, status?, expected? | { ok, lineNumber, ... } (atomic single-line edit) |
| task.getMyTask | taskNoteId (req) | task note w/ metadata, dependencies, acceptance criteria |
| task.markAsTask | noteId (req), status (req), acceptanceCriteria?, effort? | { ok, ... } |
| task.convertBlocks | noteId (req) | { convertedCount, createdNoteIds } |
| task.createPrerequisite | dependentNoteId (req), title (req), content?, status? | { ok, ... } |
| task.assignAgent | noteId (req), agentId (req) | { ok, noteId, agentId } |

```json
// → request
{ "jsonrpc":"2.0","id":11,"method":"task.update",
  "params":{ "workspaceId":"ws-abc","noteId":"task-1","line":3,"status":"done" } }
// ← response
{ "jsonrpc":"2.0","id":11,"result":{ "ok": true, "lineNumber": 3, "status": "done" } }
```

**`task.*` extensions (new in intentd — additive; do not change the ported count of 8).** Two read methods project a workspace's spec-linked task notes into the canonical `WorkspaceTask` shape.

| Method | Params | Result |
| --- | --- | --- |
| task.list | workspaceId (req), status? | { tasks: WorkspaceTask[] } — optional `status` filter |
| task.get | workspaceId (req), taskNoteId (req) | { task: WorkspaceTask } — unknown id → `-32602 Task not found` |

### 5.5 `agent.*`

The largest namespace. Methods split into **collaboration shims** (forward to the `ws.agent.*`service) and **lifecycle/runtime** methods (route through the `AgentBackendHandler` singleton).`agentId` values are of the form `agent-{uuid}`.

| Method | Params | Result |
| --- | --- | --- |
| agent.list | workspaceId (req) | { agents: AgentLite[] } — messages/systemPrompt stripped; adds messageCount, lastAgentResponse, lastUserMessage, digest, lastActivity, isStreaming/isProcessing/isResponding, and a nested metadata { isBackground, specialist?, createdByAgentId?, taskNoteId? } |
| agent.get | agentId (req), workspaceId? | { agent: AgentLite } — same projection as agent.list; -32602 if not found (falls back to disk) |
| agent.getConversation | agentId (req), limit?: number, workspaceId? | { agentId, messages, truncated, totalMessages } (capped to most-recent limit) |
| agent.create | workspaceId (req), name?, model?, specialistId?, agentId?, idempotencyKey?, provider?, agentType?, metadata?, workspacePath?, workspaceContext? | { agent: AgentLite } — full projection (same shape as `agent.get`); the pre-P2-12a `{ id, name }` snippet is a strict subset. `agentId` (when supplied) is honored verbatim (`agent-{uuid}`) so the caller can address `agent.sendMessage` at the same id; malformed values surface as `-32602`. `provider` persists on the session; `agentType`/`metadata`/`workspacePath`/`workspaceContext` are accepted for the widened FE seam but not yet persisted (deferred per the P2-12a audit). |
| agent.delegate | workspaceId (req) + delegate opts (taskNoteId?, noteId?, taskText?, agentInstructions?, specialist?, model?, behaviorPrompt?, waitMode?, skipAutoCommit?) | service result |
| agent.sendToTask | taskNoteId (req), message (req), priority? | service result |
| agent.sendMessage | agentId (req), content (req), workspaceId (req), messageId?, imageBlocks? | { success, queued, messageId? |
| agent.forceMessage | agentId (req), messageId (req), content (req), workspaceId (req), imageBlocks?, noteIds? | service result (stops current stream first) |
| agent.queueMessage | agentId (req), content (req), imageBlocks? | { success, queuedMessage } — QueuedMessage = { id, content, queuedAt, position, imageBlocks? } |
| agent.editQueuedMessage | agentId (req), messageId (req), content (req) | { success, queuedMessage } (QueuedMessage shape as above) |
| agent.removeQueuedMessage | agentId (req), messageId (req) | service result |
| agent.getQueue | agentId (req) | { success, queue: QueuedMessage[] } — QueuedMessage = { id, content, queuedAt, position, imageBlocks? } |
| agent.stop | agentId (req) | { success: true } |
| agent.setModel | agentId (req), modelId (req), workspaceId (req) | service result |
| agent.getModels | — (no workspaceId) | { models: [{ id, name, provider, description? }] } (from auggie CLI, static fallback) |
| agent.rename | agentId (req), name (req, non-empty) | { success: true, name } |
| agent.delete | agentId (req), workspaceId? | { success: true } |
| agent.wakeOrCreate | taskNoteId (req), contextMessage (req), model? | service result (resumes/creates assigned agent) |
| agent.summary | agentId (req) | quick summary of what the agent did |
| agent.reportToParent | report (req) | service result — -32603 if caller is not a delegated agent |
| agent.getSubscriptions | agentId (req), workspaceId (req) | { subscriptions, delegationGroups, agentStatuses } (filter fields flattened; legacy filter kept) |
| agent.cancelSubscriptions | agentId (req), workspaceId (req) | { success: true } |
| agent.subscribe (deprecated) | eventTypes (req, array), excludeSelf?, batchWindow? | service result — not the WS streaming surface (use events.subscribe) |
| agent.unsubscribe (deprecated) | subscriptionId (req) | service result |

```json
// → request
{ "jsonrpc":"2.0","id":20,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"Run the tests" } }
// ← response (agent was idle — message delivered)
{ "jsonrpc":"2.0","id":20,"result":{ "success": true, "queued": false, "messageId": "user-msg-1718...-ab12" } }
```

**`agent.*` extensions (new in intentd — additive; do not change the ported count of 24).** A sanitized diagnostics snapshot for the agent runtime — agent statuses, subscriptions, queues, delegation groups, delivery stats, recent delivery events, and stuck-risk signals.

| Method | Params | Result |
| --- | --- | --- |
| agent.diagnostics | workspaceId (req), agentId?, taskNoteId?, staleRespondingAfterMs? | { diagnostics, text } — JSON snapshot plus a pre-formatted text rendering; optional filters narrow to one agent or task |

### 5.6 `git.*`

| Method | Params | Result |
| --- | --- | --- |
| git.status | workspaceId (req) | { modified, staged, untracked, deleted, ... } |
| git.stage | paths (req, CSV string or array) | { ok, paths } — staging ./*/--all is rejected (-32603) |
| git.commit | message (req) | { ok, hash?, files? } (deprecated; prefer agentCommit) |
| git.agentCommit | message (req), files?, userRequested? | { ok, hash, files, fileCount } |
| git.checkMergeConflicts | targetBranch? | { hasConflicts, conflictedFiles, targetBranch, currentBranch, ... } |
| git.getBranches | repoPath (req), includeRemote? | { branches, remoteBranches, currentBranch, defaultBranch } — repoPath must be a known repo (-32602) |

```json
// → request
{ "jsonrpc":"2.0","id":30,"method":"git.stage","params":{ "workspaceId":"ws-abc","paths":["src/a.ts","src/b.ts"] } }
// ← response
{ "jsonrpc":"2.0","id":30,"result":{ "ok": true, "paths": ["src/a.ts","src/b.ts"] } }
```

**`git.*` extensions (new in intentd — additive; do not change the ported count of 6).** The inverse of `git.stage` plus three working-tree reads. `git.diff` is accepted as an alias for the wire-canonical `git.diffs`, and `git.log` as an alias for `git.commits`.

| Method | Params | Result |
| --- | --- | --- |
| git.unstage | paths (req, CSV string or array) | { ok, paths } — inverse of `git.stage`; rejects `./*/--all` with `-32603`; idempotent on already-unstaged paths |
| git.changes | workspaceId (req) | { files: FileStatus[] } — the same working-tree list as `git.status.files` |
| git.diffs (alias git.diff) | workspaceId (req), path?, staged? | per-file diff hunks (`staged: true` → HEAD→index; else index→workdir; optional `path` narrows to one file) |
| git.commits (alias git.log) | workspaceId (req), limit?, nextToken? (or nested `page: { limit, continuationToken }`) | { items: CommitSummary[], nextToken? } — paginated reverse-chronological history; remote/non-repo workspaces return empty |
| git.clone | url (req), parentDir (req), targetName?, requestId? | { requestId, targetPath } — **streaming**: returns the ack promptly and pushes `git:clone:progress` frames followed by a terminal `git:clone:done` (§6.5). `targetName` defaults to the URL basename (with `.git` stripped); rejected if it contains a path separator or would escape `parentDir`. `-32602` on missing/invalid params; `-32603` when the target path already exists or the event bus is not wired. |

**Streaming `git.clone`.** Long-running clones cannot use the buffered `host.exec` (§5.14) — the FE animates a progress bar as objects arrive. `git.clone` mirrors the `search.*` streaming shape (§5.15 / §6.5): the method returns `{ requestId, targetPath }` immediately and the daemon spawns `git clone --progress` with a piped stderr, parses the canonical phases (`starting` → `counting` → `compressing` → `receiving` → `resolving` → `checkout` → `complete`) into `git:clone:progress` frames, and emits a terminal `git:clone:done` when the child exits, times out (5 min hard cap), or fails to spawn. `GIT_LFS_SKIP_SMUDGE=1` is preserved so a missing/unreachable LFS object never fails the clone. The `url` is used only at spawn time; neither the URL nor the environment ever appears in the streamed payloads, and any `user:pass@` credential fragment in stderr is redacted before it surfaces on the `git:clone:done { error }` frame.

```json
// → request
{ "jsonrpc":"2.0","id":40,"method":"git.clone",
  "params":{ "url":"https://github.com/example/repo.git","parentDir":"/tmp/wt","targetName":"repo","requestId":"clone-1" } }
// ← prompt ack — the clone runs in the background
{ "jsonrpc":"2.0","id":40,"result":{ "requestId":"clone-1","targetPath":"/tmp/wt/repo" } }
// ← incremental progress (§6.5), correlated by requestId
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"git:clone:progress","workspaceId":"","id":"evt-a1",
    "timestamp":"2026-07-01T05:01:00.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"clone-1","phase":"receiving","percent":45,"message":"Receiving objects: 45%" } } } }
// ← terminal event — clone finished
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"git:clone:done","workspaceId":"","id":"evt-a2",
    "timestamp":"2026-07-01T05:01:12.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"clone-1","ok":true } } } }
```

### 5.7 `pr.*`

All `pr.*` methods require an active pull request on the workspace; otherwise the underlyingservice throws → `-32603`.

> Host-agnostic naming. pr.* is the ported wire name from augmentcode/intent and isnot renamed. Conceptually it is host-agnostic — "PR" covers pull request / merge request /change request — and in v1 it is backed by GitHub (selected via the sourceControl.activeProvidersetting, §5.12). Future forges (GitLab, Bitbucket) plug in behind the same pr.* surface.

| Method | Params | Result |
| --- | --- | --- |
| pr.merge | mergeMethod?: "merge" | "squash" |
| pr.status | — | { prNumber, title, url, state, mergeable, mergeableState, hasConflicts, isDraft, isMerged, isClosed, summary } |
| pr.updateBranch | — | service result |
| pr.waitForChanges | timeoutSeconds?, pollIntervalSeconds?, watch?: "any" | "checks" |
| pr.listReviewComments | path?, status?: "unresolved" | "resolved" |
| pr.replyToReviewComment | commentId (req), body (req) | service result |
| pr.resolveThread | threadId (req), action?: "resolve" | "unresolve" |
| pr.listComments | count? | conversation-level comments |
| pr.postComment | body (req) | service result |

**`pr.*` extensions (new in intentd — additive; do not change the ported count of 9).** Three
review/CI methods extend the existing `pr.*` namespace; they map onto the `SourceControl` trait
(`list_reviews` / `check_runs` / `submit_review` — IMPLEMENTATION_SPEC.md §7) and stay
host-agnostic.

| Method | Params | Result |
| --- | --- | --- |
| pr.getReviews | prNumber? (defaults to the workspace's active PR) | { reviewDecision: "APPROVED" \| "CHANGES_REQUESTED" \| null, approvalCount, changesRequestedCount, approvedBy: string[], reviews: Review[] } — see Review (§5.18 schemas) |
| pr.listCheckRuns | ref? (commit SHA; defaults to PR head) | { total, passed, failed, pending, runs: CheckRun[] } — see CheckRun (§5.18 schemas) |
| pr.createReview | verdict (req): "approve" \| "request-changes" \| "comment", body? | { review: Review } — submits a review on the active PR |

```json
// → request — submit an approving review on the active PR
{ "jsonrpc":"2.0","id":40,"method":"pr.createReview",
  "params":{ "workspaceId":"ws-abc","verdict":"approve","body":"LGTM" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "review":{
  "author":"octocat","verdict":"approve","body":"LGTM","submittedAt":"2026-06-17T05:00:00.000Z" } } }
```

### 5.8 `script.*`

| Method | Params | Result |
| --- | --- | --- |
| script.list | workspaceId (req) | { scripts: [...] } |
| script.create | name (req), command (req), mode (req: service | command), cwd?, env?, category?, autoStart?, scriptId? |
| script.remove | scriptId (req) | { ok, scriptId } |
| script.start | scriptId (req) | { ok, scriptId } |
| script.stop | scriptId (req) | { ok, scriptId } |
| script.restart | scriptId (req) | { ok, scriptId } |
| script.output | scriptId (req), maxLines? | output buffer text |
| script.status | scriptId (req) | { state, pid, exitCode, url?, ... } |
| script.run | scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } |

> **Unified PTY host (new in intentd).** Scripts run inside (possibly headless) terminals on
> the daemon and share the **unified PTY/terminal host** with interactive terminals (§5.13), so
> a script and a terminal can interact (shared env, signals, attaching to a running script's
> terminal). Live output/state stream as the `script:output` / `script:state` events (§6.5);
> `script.output` / `script.status` remain the historical poll reads. Service/command modes,
> auto-restart, and URL/port detection are preserved — a detected dev-server URL feeds the
> `forward.*` hook when the connection is remote (§5.14). See IMPLEMENTATION_SPEC.md — Terminal
> & script execution (unified PTY host).

### 5.9 `browser.*`, `terminal.*`, `file.*`

| Method | Params | Result |
| --- | --- | --- |
| browser.exec | actions (req, array), tabId? | single result or results[] (CDP automation) |
| browser.docs | topic (req) | docs string |
| terminal.list | workspaceId (req) | { terminals: [...] } |
| terminal.readOutput | terminalId (req), maxLines? | output buffer text |
| file.read | path (req) | file contents — paths outside the workspace rejected (-32603) |
| file.write | path (req), content (req) | { ok, path, size } |
| file.list | path? (default .) | [{ name, type }] |
| file.delete | path (req) | { ok, path, deleted } |
| file.mkdir | path (req) | { ok, path, created? |
| file.rename | oldPath (req), newPath (req) | { ok, oldPath, newPath } |

```json
// → request
{ "jsonrpc":"2.0","id":40,"method":"file.write",
  "params":{ "workspaceId":"ws-abc","path":"notes/out.txt","content":"hello" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "ok": true, "path": "notes/out.txt", "size": 5 } }
```

**`file.*` extensions (new in intentd — additive; do not change the ported count of 6).** A file-explorer P0 read returning the entries directly under the given path as a **bare array**; the FE anchors the explorer at the workspace root and lazy-lists children via the existing `file.list`. Shares the within-workspace containment guard with the other `file.*` ops.

| Method | Params | Result |
| --- | --- | --- |
| file.tree | path? (default .) | [{ path, name, isDirectory }] — bare array; paths outside the workspace rejected |

> **`browser.*` — NOT PORTING (v1): won't port.** `browser.exec` (Chrome DevTools Protocol
> automation) and `browser.docs` are **not implemented** in `intentd` and are **not v1 wire
> surface** — the headless backend port has no consumer for them, and `browser.exec` would need
> a dedicated CDP driver. They are **won't-port-v1** (deferred, not cancelled): revisit only if a
> future frontend feature needs in-app browser automation — see the future-integrations note
> (§5.26). The two `browser.*` methods are the reason the ported count is 104 rather than the
> reference 106; the `terminal.*` and `file.*` methods above are **unaffected** and stay in the 104.

> **Interactive terminals.** `terminal.list` / `terminal.readOutput` above are the ported,
> read-only methods (part of the 104). `intentd` adds interactive
> `terminal.create` / `write` / `resize` / `kill` / `getBuffer` (base64 framing) — see §5.13.

### 5.10 `event.*` (query/aggregation)

These are **historical/aggregate read** helpers — distinct from live streaming (§6). Each requires`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| event.recentFiles | limit? | recently modified files |
| event.agentActivity | agentId?, minutesAgo? | activity events |
| event.workspaceSummary | minutesAgo? | aggregated activity summary |
| event.directoryChanges | dir (req), limit? | recent changes under a directory prefix |
| event.query | filter opts (eventType?, actorType?, actorId?, path?, minutesAgo?, limit?) | matching events |
| event.subscribe (deprecated) | eventTypes (req, array), excludeSelf?, batchWindow? | service result — use events.subscribe for WS streaming |
| event.unsubscribe (deprecated) | subscriptionId (req) | service result |

### 5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*`

| Method | Params | Result |
| --- | --- | --- |
| crossWorkspace.listSiblings | workspaceId (req) | sibling workspaces sharing the same git repository (the workspace's own repo — unrelated to augmentcode/intent) |
| crossWorkspace.readNote | targetWorkspaceId (req), noteId (req) | note from a sibling workspace |
| crossWorkspace.listNotes | targetWorkspaceId (req) | notes in a sibling workspace |
| primitive.addReference | noteId (req), semanticId (req), description (req), snapshot? | { ok, primitiveId, noteId } |
| primitive.addCli | noteId (req), command (req), description (req), workingDirectory? | { ok, primitiveId, noteId } |
| primitive.addPatch | noteId (req), filePath (req), diff (req), description (req) | { ok, primitiveId, noteId } |
| primitive.addAgentAction | noteId (req), agentId (req), goal (req), description (req) | { ok, primitiveId, noteId } |
| specialist.list | — (no workspaceId) | { specialists: SpecialistDef[] } (user files override bundled) |
| specialist.get | id (req), workspacePath? | { specialist: SpecialistDef } — resolved view; -32602 if not found |
| specialist.create | id (req), spec (req): SpecialistDef, scope?: "project"\|"user" (default "user") | { specialist: SpecialistDef } |
| specialist.edit | id (req), spec (req): SpecialistDef, scope (req): "project"\|"user" | { specialist: SpecialistDef } |
| specialist.delete | id (req), scope (req): "project"\|"user", workspacePath? | { success: true } — `bundled` definitions are read-only |
| repo.list | — (no workspaceId) | { repos: [...] } |

```json
// → request
{ "jsonrpc":"2.0","id":50,"method":"specialist.list" }
// ← response
{ "jsonrpc":"2.0","id":50,"result":{ "specialists": [
  { "id":"implementor","name":"Implementor","description":"...","source":"bundled" } ] } }
```

**`specialist.*` full CRUD** *(new in intentd — not part of the ported 104).* `specialist.list` is
the ported method; `get` / `create` / `edit` / `delete` are **additive** and do not change the
ported `specialist` count of 1. Definitions resolve in **3 tiers** — **project**
(`.augment/specialists/`) overrides **user** (`~/.augment/specialists/`) overrides **bundled** — and
`scope` selects which tier a write targets (`bundled` is read-only). `list`/`get` return the
resolved view; `create`/`edit` take a full `spec` body. Malformed params → `-32602`; deleting a
non-existent or `bundled` definition → `-32602`.

- **SpecialistDef** — `{ id, name, description, modelTier?: "low"|"medium"|"high", prompt?,
  source: "project"|"user"|"bundled", path? }`. On `list`/`get`, `source` is the **winning** tier
  and `path?` the file it resolved from (omitted for `bundled`); on `create`/`edit` the body
  carries the authored fields and `scope` chooses the target tier.

```json
// → request — author a project-scoped specialist
{ "jsonrpc":"2.0","id":51,"method":"specialist.create",
  "params":{ "id":"reviewer","scope":"project",
    "spec":{ "id":"reviewer","name":"Reviewer","description":"Reviews diffs",
      "modelTier":"high","prompt":"You review code changes…" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "specialist":{
  "id":"reviewer","name":"Reviewer","description":"Reviews diffs","modelTier":"high",
  "source":"project","path":".augment/specialists/reviewer.md" } } }
```

### 5.12 `settings.*` *(new in intentd — not part of the ported 104)*

> New namespace. The settings.* methods are new in intentd and are not among the106 methods ported from augmentcode/intent's Electron WS API. The Electron app keeps itssettings on the frontend (electron-store / local-storage / Redux); intentd must instead ownthe settings that affect server-side behavior and let thin clients read/mutate them over the wire.These methods are global — like specialist.list / repo.list they do not requireworkspaceId (§3.6).

| Method | Params | Result |
| --- | --- | --- |
| settings.list | — | { settings: SettingDefinitionWithValue[] } (sensitive values redacted) |
| settings.get | path (req) | { path, value, definition } — -32602 if path is unknown |
| settings.update | changes (req, array of { path, value, reason? }) | { applied: [{ path, value }] }; triggers settings:changed |
| settings.reset | path (req) | { path, value } (restores defaultValue) — -32602 if path is unknown |

`SettingDefinition`** shape** — mirrors `augmentcode/intent`'s `src/shared/app-settings-schema.ts`(`AppSettingDefinition` / `findAppSettingDefinition`):

```ts
interface SettingDefinition {
  path: string;            // dotted key, e.g. "server.port" or "sourceControl.github.token"
  label: string;          // human-readable name
  description: string;    // help text
  category: string;       // grouping, e.g. "server", "sourceControl", "providers"
  type: "boolean" | "number" | "string" | "enum" | "object";
  enumValues?: string[];  // present when type === "enum"
  min?: number;           // numeric bound (type === "number")
  max?: number;           // numeric bound (type === "number")
  defaultValue?: unknown; // value used by settings.reset
  sensitive?: boolean;    // when true, value is redacted in settings.list / settings.get
}
// SettingDefinitionWithValue = SettingDefinition & { value: unknown }  // current value (redacted if sensitive)
```

`changes` entries use the ported `AppSettingChange` shape `{ path, value, reason? }` (`reason` is anoptional free-text audit note). `settings.update` **validates** each change against its definition(type / enum / min / max) and **persists** atomically; an unknown `path` or a value failingvalidation yields `-32602` and the whole batch is rejected (nothing applied). On success it emits a`settings:changed` notification (§6.5) carrying the applied `{ path, value }` pairs (sensitive valuesredacted).

**BE-exposed setting paths.** Only settings that affect daemon behavior are exposed. These are theported, BE-owned settings (group A) plus `intentd`-specific host/daemon settings (group B):

- **Providers / agents:** `providers.active`, `providers.enabled`, `providers.paths.{auggie,claude-code,codex,…}`,`model.default`, `model.providerDefaults`, `model.workspaceOverrides`, `backgroundAgents.defaultModel`,`backgroundAgents.typeOverrides`, `backgroundAgents.providerSettings`, `specialists.default`.
- **Workspace / git:** `workspace.branchPrefix`, `workspace.worktreesLocation`,`workspace.sshKeyPath` *(sensitive)*, `workspace.defaultShell`, `workspace.autoFetch`,`workspace.autoCommit`.
- **MCP:** `mcp.enableUserServers`, `mcp.disabledServers`, `mcp.servers` *(sensitive)*.
- **Server / transport (new in intentd):** `server.listenMode` (`uds`|`tcp`), `server.socketPath`,`server.bindAddress`, `server.port`, `server.tls.enabled`, `server.auth.enabled`,`server.auth.token` *(sensitive; read-only / regenerate)*, `server.originAllowList`,`server.discovery.enabled` (mDNS).
- **Source control (new in intentd, provider-agnostic):** `sourceControl.activeProvider` (enum,**default **`github`; v1 ships only `github`), `sourceControl.github.tokenSource`(`env`|`gh-cli`|`explicit`), `sourceControl.github.token` *(sensitive)*,`sourceControl.github.apiBaseUrl` (GitHub Enterprise support). Per-provider config is namespaced as`sourceControl.<provider>.*` so future hosts slot in as `sourceControl.gitlab.*`,`sourceControl.bitbucket.*`, etc. (replaces any flat `github.*` keys).
- **Context engine (new in intentd):** `context.enabled`, `context.auggiePath`, `context.allowIndexing`.
- **Storage / runtime (new in intentd):** `storage.dataDir`, `workspaces.root`, `logging.level`,`agents.maxConcurrent`, `agents.idleReapMinutes`.

**Not exposed (FE-only).** Pure frontend/display settings are **out of **`intentd`** scope** and are**not** served by `settings.*`: `theme.*`, `fonts.*`, `ui.*`, `notifications.*` (display),`workspaceList.*`, `openIn.*`, `keybindings.*`, `promoBanners.*`, `activityLog.presets`,`model.pickerCollapsedGroups`, `preferences.spellcheckEnabled`, `preferences.betaUpdatesEnabled`,`providers.completedSetup`, `accounts.sentry`, `rtk.enabled`, `linear.issueFilter`.

```json
// → request — list all BE-owned settings (sensitive values redacted)
{ "jsonrpc":"2.0","id":51,"method":"settings.list" }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "settings": [
  { "path":"server.port","label":"WS port","description":"TCP port for the WSS listener",
    "category":"server","type":"number","min":1024,"max":65535,"defaultValue":5180,"value":5180 },
  { "path":"sourceControl.github.token","label":"GitHub token","description":"PAT used by octocrab",
    "category":"sourceControl","type":"string","sensitive":true,"value":null } ] } }
```

```json
// → request — read one setting
{ "jsonrpc":"2.0","id":52,"method":"settings.get","params":{ "path":"sourceControl.activeProvider" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "path":"sourceControl.activeProvider","value":"github",
  "definition":{ "path":"sourceControl.activeProvider","label":"Source-control provider",
    "description":"Active forge implementation","category":"sourceControl","type":"enum",
    "enumValues":["github"],"defaultValue":"github" } } }
```

```json
// → request — mutate settings (emits settings:changed)
{ "jsonrpc":"2.0","id":53,"method":"settings.update","params":{ "changes":[
  { "path":"server.port","value":5181 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli","reason":"use gh auth token" } ] } }
// ← response
{ "jsonrpc":"2.0","id":53,"result":{ "applied":[
  { "path":"server.port","value":5181 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli" } ] } }
```

```json
// → request — reset one setting to its default
{ "jsonrpc":"2.0","id":54,"method":"settings.reset","params":{ "path":"server.port" } }
// ← response
{ "jsonrpc":"2.0","id":54,"result":{ "path":"server.port","value":5180 } }
```

### 5.13 Interactive `terminal.*` *(new in intentd — not part of the ported 104)*

> **New methods.** The `augmentcode/intent` WS API exposes terminals **read-only**
> (`terminal.list` / `terminal.readOutput`, §5.9 — both stay in the 104). `intentd` adds the
> interactive methods below so a thin client can open, drive, resize, and tear down PTYs that
> run on the **daemon host**. Terminals and scripts (§5.8) share one **unified PTY/terminal
> host** (`portable-pty`), each with a server-side scrollback ring buffer for replay on
> (re)connect; multiple clients may attach to the same session. See IMPLEMENTATION_SPEC.md —
> Terminal & script execution (unified PTY host) and §6.7 (ACP client-served `terminal/*`).

| Method | Params | Result |
| --- | --- | --- |
| terminal.create | workspaceId (req), cols (req,int), rows (req,int), cwd?, command?, env? (Record<string,string>) | { terminalId } — spawns a PTY; `command` omitted → default shell; `env` layers onto the daemon's inherited environment (later keys override) |
| terminal.write | terminalId (req), data (req, base64) | { ok: true } — `data` is base64-encoded input bytes |
| terminal.resize | terminalId (req), cols (req,int), rows (req,int) | { ok: true } |
| terminal.kill | terminalId (req) | { ok: true } — signals the PTY; emits `terminal:exit` (§6.5) |
| terminal.getBuffer | terminalId (req), maxBytes? | { terminalId, data } — base64 scrollback for replay |

**Base64 framing.** Terminal payloads are **binary-safe**: input (`terminal.write` `data`),
scrollback (`terminal.getBuffer` `data`), and streamed output (`terminal:data` `chunk`, §6.5)
are **base64-encoded** so arbitrary bytes (control sequences, UTF-8, non-text) survive the
JSON-RPC text channel. Clients decode on receipt and encode on send. The ported
`terminal.readOutput` (§5.9) stays a plaintext convenience read.

```json
// → create an 80×24 PTY running the default shell
{ "jsonrpc":"2.0","id":70,"method":"terminal.create",
  "params":{ "workspaceId":"ws-abc","cols":80,"rows":24 } }
// ← response
{ "jsonrpc":"2.0","id":70,"result":{ "terminalId":"term-1" } }
// → send input "ls\n" (base64 of "ls\n" is "bHMK")
{ "jsonrpc":"2.0","id":71,"method":"terminal.write","params":{ "terminalId":"term-1","data":"bHMK" } }
// ← { "jsonrpc":"2.0","id":71,"result":{ "ok": true } }
// ← server pushes output as it arrives (§6.5); chunk is base64
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"terminal:data","workspaceId":"ws-abc","id":"evt-901",
    "timestamp":"2026-06-17T05:00:00.000Z","actor":{ "type":"system" },
    "data":{ "terminalId":"term-1","chunk":"bHMKZmlsZS50eHQK" } } } }
```

### 5.14 Execution locus, locality & remote behavior *(new in intentd)*

All side effects — PTYs, scripts, file I/O, git, ACP provider processes — run on the **daemon
host**, not on the client. A thin client is a remote viewer/driver over the wire, so the
protocol surfaces **where** execution happens and adapts when the client is not on the same
machine. See IMPLEMENTATION_SPEC.md §5.1 (transport matrix) and §5.5 (remote model).

**Locality is inferred from the transport:**

- **UDS (Unix-domain socket) or explicit `--mode local` ⇒ same machine.** The desktop FE
  typically spawns `intentd` itself and connects over a local Unix socket; a UDS connection is
  the signal that GUI windows, `open`, simulators, and detected URLs are directly visible and
  usable by the user. A `server.locality = local | remote` setting (§5.12) can force this.
- **TCP / WSS ⇒ treat as remote.** Side effects happen on another machine, so GUI-spawning
  commands may not be visible and detected dev-server URLs need forwarding.

**`host.*` — capability probe + FE-served intents:**

The `Direction` column below records who initiates the JSON-RPC **request** on the wire:
`client → daemon` is a normal client-called method (client picks the `id`); `daemon → client`
is a **reverse RPC** where the *daemon* is the requester and the connected client responds
(daemon picks the `id`, always in the `rev-<n>` namespace — the mechanism is spelled out
in the bullet under this table).

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| host.status | client → daemon | — (no workspaceId) | { os, arch, hostname, hasDisplay, locality, displayServer? } — host capability probe |
| host.openExternal | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | url (req) | { ok: true } — **FE-served**: routes an "open in browser/app" intent back to the *user's* machine |
| host.openInEditor | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | editorId (req), path (req), line?, column? | { ok: true } — **FE-served**: launches the user's editor on `path` (optional `line`/`column` hint). On a local daemon the launch short-circuits via the resolved `host.listInstalledEditors` entry; on a remote daemon the intent is dispatched to the connected client so the editor opens on the user's laptop |
| host.pickApplication | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | path (req) | { applicationId? } — **FE-served**: "open with…" chooser. On a local daemon returns `applicationId?` (or nothing when no chooser is available); on a remote daemon dispatches to the connected client and echoes its selection |
| host.exec | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId? | { stdout, stderr, exitCode, timedOut? } — daemon-owned one-shot exec |
| host.execStream | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId?, stdin? (string), stdinBase64?, requestId? | { requestId } — daemon-owned **streaming** exec; stdout/stderr/exit surface as `host:exec:*` bus frames |
| host.execStream.write | client → daemon | requestId (req), stdin? (string), stdinBase64?, eof? (bool) | { ok: true } — write follow-up stdin to a live stream (closes the child's stdin end when `eof=true`) |
| host.execStream.cancel | client → daemon | requestId (req) | { ok: true, cancelled: bool } — reap a live stream's process group (idempotent on unknown ids) |

- `host.hasDisplay` / `host.locality` are also folded into the daemon's `status` / `doctor`
  reports and the mDNS TXT record (§1.3), so a client can gate UI **before** connecting. When
  `hasDisplay=false`, clients should warn that GUI-spawning commands won't be visible.
- `host.openExternal` / `host.openInEditor` / `host.pickApplication` are **served by the
  frontend, not the daemon** (reverse RPCs — the *daemon* sends the JSON-RPC `request` and the
  connected client returns the `response`). Clients never call these methods on the daemon;
  the daemon dispatches them to the client so these inherently-user-side GUI intents resolve
  on the user's machine. Reverse-request ids are always in the `rev-<n>` namespace (allocated
  by the daemon, distinct from the client's own `id` space) with a 30s default timeout; the
  local branch short-circuits directly on the daemon host without a wire round-trip (via
  `OsOpener` for `openExternal`, the resolved `host.listInstalledEditors` entry for
  `openInEditor`, and — when available — a native chooser for `pickApplication`).
- `host.exec` is a **daemon-owned one-shot exec** so the FE never spawns workspace-adjacent
  commands itself. It uses `argv` only — **no shell interpolation** — spawns with the child in
  its own process group and `kill_on_drop` (so `timeoutMs` reaps the whole tree), enriches
  `PATH` with the daemon's host PATH, and merges caller-supplied `env` on top. It is
  **secret-safe**: no env values are logged or returned; only `stdout` / `stderr` / `exitCode`
  (and `timedOut: true` on the timeout path) cross the wire. `cwd` requires `workspaceId` so
  the daemon can enforce the same lexical within-workspace containment guard that `file.*` uses;
  a `cwd` outside the workspace root is rejected with `-32603 "Access denied: cwd outside
  workspace"`. Missing / invalid params surface as `-32602`. Long-lived / streaming processes
  stay on `script.*` and `terminal.*` (§5.8, §12) — `host.exec` is one-shot only.
- `host.execStream` is the **streaming/interactive** counterpart for FE surfaces (e.g.
  `augment-cli`'s newline-delimited JSON chat) that need live stdout **and** a stdin channel —
  something neither the buffered `host.exec` nor the PTY-mangling `terminal.*` nor the
  workspace-script-lifecycle `script.*` fit. It reuses every `host.exec` guarantee (argv-only,
  process-group + `kill_on_drop` + `timeoutMs` reap, enriched PATH, caller `env` on top,
  workspace-containment on `cwd`, secret-safe env) and adds the streaming shape from
  `git.clone` / `search.*` (§5.6 / §5.15 / §6.5): the method returns
  `{ requestId }` immediately (a `hexec-<uuid>` is minted when the caller omits one) and the
  daemon publishes one bus frame per output chunk plus one terminal exit frame, all correlated
  by `requestId`:
  - `host:exec:stdout` — `{ requestId, chunk }` where `chunk` is base64-encoded so binary
    output crosses the wire intact (mirrors `terminal:data.chunk`).
  - `host:exec:stderr` — same shape as stdout, over the child's stderr.
  - `host:exec:exit` — terminal: `{ requestId, ok, exitCode?, timedOut?, cancelled? }`.
    Emitted exactly once; subscribers unregister on receipt.
  Callers pipe stdin two ways: an optional initial `stdin`/`stdinBase64` on the request itself
  (written to the child before any reader task starts) and follow-up `host.execStream.write
  { requestId, stdin?, stdinBase64?, eof? }` calls that append bytes and optionally close the
  child's stdin end (`eof=true`) so a reader-to-EOF like `cat` / `augment-cli` finishes
  cleanly. Only one of `stdin` / `stdinBase64` may be set per request. `host.execStream.cancel
  { requestId }` reaps the whole process group (SIGTERM → grace → SIGKILL, mirroring the
  `host.exec` timeout path) and is idempotent on unknown / already-finished ids
  (`cancelled:false` still surfaces `ok:true`). Command payloads carry env values that are
  **never logged or streamed** — only `stdout` / `stderr` / exit metadata crosses the wire.

**`forward.*` — port-forwarding (remote only):**

When a script/terminal URL-detection hook (§5.8) finds a dev-server URL/port on a **remote**
daemon, the client tunnels the remote port to `localhost` so the web UI is viewable locally. On
a **local** (UDS) connection forwarding is unnecessary and these are no-ops.

| Method | Params | Result |
| --- | --- | --- |
| forward.create | remotePort (req,int), localPort? | { forwardId, localPort, remotePort } — opens a tunnel |
| forward.list | — | { forwards: [{ forwardId, localPort, remotePort, url? }] } |
| forward.close | forwardId (req) | { ok: true } |

```json
// → probe host capabilities (gate GUI / forwarding UI)
{ "jsonrpc":"2.0","id":80,"method":"host.status" }
// ← response (headless remote host)
{ "jsonrpc":"2.0","id":80,"result":{ "os":"linux","arch":"x86_64","hostname":"build-01",
  "hasDisplay":false,"locality":"remote" } }
// → open a detected URL on the user's machine (FE-served)
{ "jsonrpc":"2.0","id":81,"method":"host.openExternal","params":{ "url":"http://localhost:3000" } }
// ← { "jsonrpc":"2.0","id":81,"result":{ "ok": true } }
// → launch the user's editor on the user's machine (FE-served; local daemons short-circuit)
{ "jsonrpc":"2.0","id":83,"method":"host.openInEditor","params":{
  "editorId":"vscode","path":"/repo/src/main.rs","line":12,"column":3
} }
// ← { "jsonrpc":"2.0","id":83,"result":{ "ok": true } }
// → present "open with…" chooser on the user's machine (FE-served)
{ "jsonrpc":"2.0","id":84,"method":"host.pickApplication","params":{ "path":"/repo/README.md" } }
// ← { "jsonrpc":"2.0","id":84,"result":{ "applicationId":"com.microsoft.VSCode" } }
// → daemon-owned one-shot exec (argv only, cwd validated against workspace root)
{ "jsonrpc":"2.0","id":82,"method":"host.exec","params":{
  "command":"echo","args":["hello"],"timeoutMs":5000
} }
// ← { "jsonrpc":"2.0","id":82,"result":{ "stdout":"hello\n","stderr":"","exitCode":0 } }
// → daemon-owned streaming exec (argv only, cwd validated against workspace root)
{ "jsonrpc":"2.0","id":90,"method":"host.execStream","params":{
  "command":"cat","stdin":"hello\n"
} }
// ← { "jsonrpc":"2.0","id":90,"result":{ "requestId":"hexec-<uuid>" } }
// then, correlated by requestId, subscribers see (base64 chunks):
// { "method":"events.event","params":{ "event":{ "type":"host:exec:stdout",
//   "data":{ "requestId":"hexec-<uuid>","chunk":"aGVsbG8K" } } } }
// (optionally more stdout/stderr frames)
// → follow-up stdin write, closing the child's stdin end so `cat` exits
{ "jsonrpc":"2.0","id":91,"method":"host.execStream.write","params":{
  "requestId":"hexec-<uuid>","stdin":"","eof":true
} }
// ← { "jsonrpc":"2.0","id":91,"result":{ "ok": true } }
// terminal frame (ok:true when exitCode==0):
// { "method":"events.event","params":{ "event":{ "type":"host:exec:exit",
//   "data":{ "requestId":"hexec-<uuid>","ok":true,"exitCode":0 } } } }
// → force-reap a live stream's whole process group
{ "jsonrpc":"2.0","id":92,"method":"host.execStream.cancel","params":{
  "requestId":"hexec-<uuid>"
} }
// ← { "jsonrpc":"2.0","id":92,"result":{ "ok": true, "cancelled": true } }
```

### 5.15 `search.*` *(new in intentd — not part of the ported 104)*

> **New namespace.** In `augmentcode/intent` search is FE/IPC-driven and scattered
> (`workspace:search-in-files` via ripgrep, the `list-files` filename path, an empty
> `codebase:search` placeholder, plus in-renderer event/memory/message search), and *remote*
> workspaces route content search through an SSH `rpcClient.exec(find/grep)` hack. `intentd`
> makes search a **BE-owned namespace**: it executes on the daemon **where the code and data
> live**, so a thin client just renders results and the remote SSH-exec hack disappears (when
> the daemon *is* the remote host, `rg` runs locally to it). See IMPLEMENTATION_SPEC.md —
> Search (BE-owned), Drafts, and stable Client identity.

| Method | Params | Result |
| --- | --- | --- |
| search.inFiles | workspaceId (req), query (req), opts? { caseSensitive?, regex?, globs?, maxResults? }, requestId? | { requestId, matches: SearchMatch[], truncated } — ripgrep content search (ports `workspace:search-in-files`) |
| search.fileNames | workspaceId (req), pattern (req), limit?, requestId? | { requestId, files: string[], truncated } — path/glob search (ports the `list-files` path) |
| search.messages | workspaceId (req), query (req), agentId?, role?, limit?, requestId? | { requestId, matches: MessageMatch[] } — over persisted agent sessions (BE owns session storage) |
| search.events | query (req), workspaceId?, limit?, requestId? | { requestId, matches: EventMatch[] } — over the BE event log (§10.2 of IMPLEMENTATION_SPEC.md) |
| search.memories | query (req), workspaceId?, requestId? | { requestId, matches: MemoryMatch[] } — over the BE memories store |
| search.notes | query (req), requestId? | { requestId, matches: NoteMatch[] } — over the BE notes store (global; no workspaceId) |
| search.codebase | workspaceId (req), query (req), requestId? | { requestId, matches: CodebaseMatch[] } — **ripgrep/symbol-backed** search; replaces the empty `codebase:search` placeholder (a never-implemented stub with no caller). auggie exposes no structured codebase-retrieval CLI, so `AuggieContextEngine::retrieve()` returns `Unavailable` instantly and ripgrep is the backing; the `ContextEngine` trait (§8 of IMPLEMENTATION_SPEC.md) is retained as forward-looking infra |
| search.cancel | requestId (req) | { ok: true } — aborts an in-flight search by its `requestId` |

**`requestId` & cancellation.** Every search method accepts an optional caller-supplied
`requestId` (echoed in the result and in every streamed event). It is the handle used by
`search.cancel` and the correlation key for `search:result` / `search:done` events — mirroring
the renderer's `AbortController` debounce/cancel today. If the client omits it the server mints
one and returns it in the result.

**Match / result shape.** Content-style matches (`SearchMatch`) carry enough to render a hit
without a follow-up fetch:

```ts
interface SearchMatch {
  file: string;        // workspace-relative path
  line: number;        // 1-based line number
  col: number;         // 1-based column of the match start
  preview: string;     // the matching line (trimmed for display)
  before?: string[];   // optional context lines before
  after?: string[];    // optional context lines after
  score?: number;      // relevance (semantic/codebase results)
}
// MessageMatch / EventMatch / MemoryMatch / NoteMatch / CodebaseMatch are store-specific:
// each carries its entity id (agentId+messageId / eventId / memoryId / noteId / symbol),
// a `preview` snippet, and an optional `score`.
```

**Result delivery — direct or streamed.** Small result sets are returned inline in the method
result (`matches`/`files` + `truncated`). Large or long-running searches are **streamed**: the
method returns `{ requestId }` promptly and the daemon pushes incremental `search:result`
batches followed by a terminal `search:done` (§6.5), correlated by `requestId`. Either way the
final, complete answer is the `search:done` event (or the inline result when not streamed).

```json
// → content search across a workspace
{ "jsonrpc":"2.0","id":90,"method":"search.inFiles",
  "params":{ "workspaceId":"ws-abc","query":"TODO","requestId":"srch-1",
    "opts":{ "caseSensitive":false,"regex":false,"maxResults":500 } } }
// ← prompt ack (large result set → streamed)
{ "jsonrpc":"2.0","id":90,"result":{ "requestId":"srch-1","matches":[],"truncated":false } }
// ← incremental results (§6.5), correlated by requestId
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"search:result","workspaceId":"ws-abc","id":"evt-910",
    "timestamp":"2026-06-17T05:01:00.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"srch-1","matches":[
      { "file":"src/main.rs","line":42,"col":3,"preview":"// TODO: handle error" } ] } } } }
// ← terminal event — search finished
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"search:done","workspaceId":"ws-abc","id":"evt-911",
    "timestamp":"2026-06-17T05:01:00.200Z","actor":{ "type":"system" },
    "data":{ "requestId":"srch-1","total":17,"truncated":false } } } }
```

```json
// → cancel an in-flight search
{ "jsonrpc":"2.0","id":91,"method":"search.cancel","params":{ "requestId":"srch-1" } }
// ← { "jsonrpc":"2.0","id":91,"result":{ "ok": true } }
```

**Errors.** Missing `query`/`pattern`/`workspaceId`/`requestId` → `-32602`. `search.cancel`
with an unknown or already-finished `requestId` is a no-op success (`{ ok: true }`). A malformed
`opts.regex` pattern yields `-32602 "Invalid regex"`. Host-API searches (PR/issue/repo) are
**not** part of `search.*` — they stay under `pr.*` / the provider-agnostic `SourceControl`
(§5.7, host-agnostic).

### 5.16 `drafts.*` *(new in intentd — not part of the ported 104)*

> **New namespace.** In `augmentcode/intent`, message drafts (typed-but-not-sent input) live in
> per-client `localStorage` (`transient-ui-slice` `chatDrafts: Record<agentId, string>`,
> restored by `ChatPanel.svelte`). With multiple thin clients connected to one daemon that does
> not survive reconnects or share across devices, and concurrent writers clobber each other.
> `intentd` moves drafts into BE state, keyed by **`(workspaceId, agentId, clientId)`** — where
> `clientId` is the stable client identity from `client.hello` (§5.17) — so each client keeps
> its **own private** draft. See IMPLEMENTATION_SPEC.md — Search (BE-owned), Drafts, and stable
> Client identity.

| Method | Params | Result |
| --- | --- | --- |
| drafts.get | workspaceId (req), agentId (req) | { text, updatedAt } \| null — the draft for the **calling client** (resolved from its `clientId`); `null` if none |
| drafts.set | workspaceId (req), agentId (req), text (req) | { ok: true, updatedAt } — upsert for the calling client; emits `draft:changed` |
| drafts.clear | workspaceId (req), agentId (req) | { ok: true } — delete on send / explicit clear; emits `draft:changed` |

**Implicit client keying.** The `clientId` is **not** a parameter — it is resolved from the
calling connection's logical client (established by `client.hello`, §5.17). A connection that
never completed the handshake is treated as an anonymous, connection-scoped client (its drafts
do not survive reconnect). The FE debounces `drafts.set` exactly as it debounces the local-only
save today, and calls `drafts.clear` on send.

**Per-client private by default.** Each client restores only its own draft on reconnect; drafts
are never returned to a different `clientId`. A future opt-in **shared-draft** (collaborative)
mode is noted but **out of scope for v1**.

**`draft:changed` event — no text leakage.** `drafts.set` / `drafts.clear` emit
`draft:changed { workspaceId, agentId, clientId, hasDraft }` (§6.5). The payload deliberately
**omits the draft text** — it lets other clients optionally show a "someone is composing"
affordance without leaking content, and lets the owning client's *other* connections (same
`clientId`) know to re-fetch their own text via `drafts.get`. Kept minimal in v1.

```json
// → restore this client's draft on (re)connect
{ "jsonrpc":"2.0","id":95,"method":"drafts.get","params":{ "workspaceId":"ws-abc","agentId":"agent-1" } }
// ← response (a draft exists)
{ "jsonrpc":"2.0","id":95,"result":{ "text":"half-written question…","updatedAt":"2026-06-17T05:02:00.000Z" } }
// → save (debounced) as the user types
{ "jsonrpc":"2.0","id":96,"method":"drafts.set",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-1","text":"half-written question…" } }
// ← { "jsonrpc":"2.0","id":96,"result":{ "ok":true,"updatedAt":"2026-06-17T05:02:00.000Z" } }
// ← event — other connections learn a draft exists (no text)
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"draft:changed","workspaceId":"ws-abc","id":"evt-920",
    "timestamp":"2026-06-17T05:02:00.000Z","actor":{ "type":"user" },
    "data":{ "workspaceId":"ws-abc","agentId":"agent-1","clientId":"cli-7f3a","hasDraft":true } } } }
// → clear on send
{ "jsonrpc":"2.0","id":97,"method":"drafts.clear","params":{ "workspaceId":"ws-abc","agentId":"agent-1" } }
// ← { "jsonrpc":"2.0","id":97,"result":{ "ok":true } }
```

**Errors.** Missing `workspaceId` / `agentId` (all three methods) or `text` (`drafts.set`) →
`-32602`. `drafts.get` for a non-existent draft returns `null` (not an error); `drafts.clear`
on a non-existent draft is a no-op success.

### 5.17 `client.hello` handshake & stable client identity *(new in intentd — not part of the ported 104)*

> **New handshake.** In `augmentcode/intent` the WS server mints an **ephemeral**
> `clientId = ws-${Date.now()}-${rand}` per connection (`websocket-api-server.ts`), uses it only
> for internal subscription bookkeeping (`websocket-event-bridge.ts`), and **never returns it to
> the client** — so there is no stable, client-visible identity. `intentd` introduces a
> **stable, client-supplied identity** that survives reconnects; the ephemeral per-connection id
> is retained purely for transport bookkeeping. See IMPLEMENTATION_SPEC.md — Search (BE-owned),
> Drafts, and stable Client identity.

| Method | Params | Result |
| --- | --- | --- |
| client.hello | clientId?, name?, capabilities? | { clientId, server: { locality, hasDisplay, osArch, version } } |

- **Global handshake.** `client.hello` does **not** require `workspaceId` (§3.6); it is the
  first call a client makes after the auth upgrade (§2) and before scoped work.
- **Client-persisted `clientId`.** The client **generates and persists its own `clientId`** (a
  UUID in its local storage) and **re-presents it on every (re)connect**. If the client omits
  `clientId`, the server generates one and returns it for the client to persist and reuse from
  then on.
- **Connection → client mapping.** The daemon maps each live connection to its logical
  `clientId`; **multiple connections may share one `clientId`** (the same client reconnecting, or
  several windows of one app).
- **Disambiguation key.** `clientId` is the key that disambiguates `drafts.*` (§5.16) and is the
  foundation for **future per-viewer read cursors** (the `attention` extension noted in §5.1). It
  also lets FE-served intents (`host.openExternal`, §5.14) and `forward.*` target the right
  client.
- **`server` block.** The result advertises daemon capabilities so a client can gate UI right
  after the handshake (mirrors `host.status`, §5.14): `locality` (`local` | `remote`),
  `hasDisplay` (GUI present on the daemon host), `osArch` (e.g. `darwin/arm64`), and `version`
  (daemon version string).

```json
// → first call after auth: client re-presents its persisted clientId
{ "jsonrpc":"2.0","id":1,"method":"client.hello",
  "params":{ "clientId":"cli-7f3a","name":"Intent Desktop","capabilities":{ "forward":true,"openExternal":true } } }
// ← response — capabilities of the daemon host
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-7f3a",
  "server":{ "locality":"remote","hasDisplay":false,"osArch":"linux/x86_64","version":"0.1.0" } } }
```

```json
// → first-ever connect: no clientId yet, server mints one
{ "jsonrpc":"2.0","id":1,"method":"client.hello","params":{ "name":"Intent Desktop" } }
// ← server returns a clientId for the client to persist
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-9b21",
  "server":{ "locality":"local","hasDisplay":true,"osArch":"darwin/arm64","version":"0.1.0" } } }
```

**Errors.** A malformed `clientId` (non-string) → `-32602`. The handshake is idempotent:
re-sending `client.hello` on the same connection updates `name` / `capabilities` and re-returns
the same `server` block.

### 5.18 `accept-changes.*` *(new in intentd — not part of the ported 104)*

The multi-step "accept the agent's work" workflow: the backend owns local git **and** the forge
(`SourceControl`, IMPLEMENTATION_SPEC.md §7), so a thin client drives commit → push → create-PR →
merge through a handful of calls. `execute` runs the orchestrated pipeline and **restores agent
attribution** from `file-tracking` (§5.19) on each step. Every method requires `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| accept-changes.getStatus | workspaceId (req) | WorkspaceGitStatus (schema below) |
| accept-changes.prepare | workspaceId (req), action (req), files?: string[] | PrepareResult { valid, warnings[], errors[], suggestedCommitMessage?, suggestedPRTitle?, suggestedPRBody?, filesCount, additions, deletions, files: [{ path, additions, deletions, staged }] } |
| accept-changes.execute | workspaceId (req), action (req), files?, commitMessage?, prTitle?, prBody?, targetBranch?, mergeStrategy?: "merge"\|"squash"\|"rebase", upToCommitHash?, undoCommitsMetadata?, options?: { stageUnstaged?, pushAfterCommit?, createPRAfterPush?, rebaseFirst?, localOnly? } | AcceptChangesResult { success, steps: [{ id, name, status, message?, error? }], result?: { commitHash?, prNumber?, prUrl?, mergeCommitHash?, … }, error? } |
| accept-changes.mergePR | workspaceId (req), prNumber (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | AcceptChangesResult |
| accept-changes.addRemote | workspaceId (req), remoteUrl (req) | WorkspaceGitStatus (refreshed after adding `origin`) |

`action` is one of `commit \| push \| create-pr \| merge \| export \| undo-push \| undo-commit \|
reset-to-trunk \| rebase-onto-trunk` — except **`export` is NOT PORTING** (no UI consumer; absent
from the new FE), so `execute` rejects `action:"export"`. A step that fails sets `success:false` and the offending
`steps[].status:"failed"` with `error`; malformed params → `-32602`, underlying service throws →
`-32603`.

```json
// → request — prepare a commit for the staged files
{ "jsonrpc":"2.0","id":50,"method":"accept-changes.prepare",
  "params":{ "workspaceId":"ws-abc","action":"commit" } }
// ← response
{ "jsonrpc":"2.0","id":50,"result":{
  "valid":true,"warnings":[],"errors":[],
  "suggestedCommitMessage":"Add review wire surface",
  "filesCount":2,"additions":140,"deletions":12,
  "files":[{ "path":"docs/rust-backend/PROTOCOL.md","additions":140,"deletions":12,"staged":true }] } }
```

**Shared schemas (Code Changes Review).** Defined once here; referenced by §5.7, §5.19, §5.20.

- **WorkspaceGitStatus** — `{ branch, trunkBranch, aheadOfTrunk, behindTrunk, hasRemote,
  isPushed, uncommittedCount, stagedCount, localCommits: CommitWithAttribution[],
  existingPR?: { number, url, htmlUrl, title, state: "open"|"closed"|"merged"|"draft" } }`.
- **CommitWithAttribution** — a local commit carrying agent provenance:
  `{ hash, message, author, date, filesChanged, isPushed, files?: [{ path, additions?,
  deletions?, status? }], agentId?, linkedNoteId? }`.
- **TrackedChange** — one file's audit record through the git stages (see §5.19):
  `{ id, file, relativePath, stage: "unstaged"|"staged"|"committed"|"pushed"|"pull_request"|
  "merged"|"trunk", status?: "added"|"modified"|"deleted"|"renamed",
  stats: { additions, deletions, binary? },
  attribution: { agent?: { agentId, agentName, sessionId, turnNumber, messageId?, toolCallId?,
  timestamp }, manual?, timestamp } }`.
- **Review** — `{ author, verdict: "approve"|"request-changes"|"comment", body?, submittedAt }`
  (host-agnostic; GitHub's `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED` map onto `verdict`).
- **CheckRun** — `{ name, state: "pending"|"success"|"failure"|"neutral"|"cancelled", url? }`.
- **Metrics** — line-change totals: `{ additions, deletions, filesChanged, byAgent }` (workspace-level
  stats include `byAgent`; per-agent stats may omit `byAgent`; see §5.20).
- **DiffChunk / DiffDetail** *(internal — no wire method)* — old/new content + hunks, computed and
  stored inside the backend (IMPLEMENTATION_SPEC.md §9 `diffs`); never returned by a `diffs.*` RPC.
  Diff content reaches the client only via the `file-tracking.*` reads and the §6.5 change events.

### 5.19 `file-tracking.*` (reads) *(new in intentd — not part of the ported 104)*

A per-file audit trail as changes move through the git stages
(`unstaged → staged → committed → pushed → pull_request → merged`) with agent attribution. Only
the **UI-invoked reads** are wire methods; the attribution writer `trackChange` is **internal**
(the backend records it as agents edit files — no client RPC; see §6.8). Every method requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| file-tracking.init | workspaceId (req) | { ok: true } — initializes/attaches the tracker for the workspace |
| file-tracking.sync | workspaceId (req), force?: boolean (default false) | { success, … } — reconciles tracked changes against live git |
| file-tracking.load | workspaceId (req) | { changes: TrackedChange[], truncated, totalCount } |
| file-tracking.getChanges | workspaceId (req), filter?: { stage?, agentId?, sessionId?, turnNumber?, filePattern?, since?, until? } | { changes: TrackedChange[], truncated, totalCount } |
| file-tracking.loadCommits | workspaceId (req), limit?: number (≤200) | { commits: CommitWithAttribution[] } |
| file-tracking.getLineStats | workspaceId (req) | { additions, deletions } — real-time totals across unstaged + staged + local commits |
| file-tracking.stage | workspaceId (req), paths (req): string[] | { ok: true } — stages the referenced files |
| file-tracking.unstage | workspaceId (req), paths (req): string[] | { ok: true } — unstages the referenced files |

```json
// → request — load committed changes for one agent
{ "jsonrpc":"2.0","id":51,"method":"file-tracking.getChanges",
  "params":{ "workspaceId":"ws-abc","filter":{ "stage":"committed","agentId":"agent-123" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "changes":[
  { "id":"git-1-src/x.ts","file":"/ws/src/x.ts","relativePath":"src/x.ts",
    "stage":"committed","status":"modified","stats":{ "additions":10,"deletions":2 },
    "attribution":{ "agent":{ "agentId":"agent-123","agentName":"Coordinator",
      "sessionId":"sess-9","turnNumber":4,"timestamp":1750000000000 },"timestamp":1750000000000 } } ],
  "truncated":false,"totalCount":1 } }
```

### 5.20 Change metrics (reads) *(new in intentd — not part of the ported 104)*

Read-only line-change aggregates (ported from the reference `line-changes` module). Aggregation
itself (`metrics.calculate`, the `update*` writers, `mark-agent-active`) is **internal** — the
backend computes metrics as agents work and pushes change events (§6.5); clients only **read**.
Metrics are recommended durable (IMPLEMENTATION_SPEC.md §9 `workspace_metrics` / `agent_metrics`).

| Method | Params | Result |
| --- | --- | --- |
| metrics.getWorkspaceStats | workspaceId (req) | Metrics \| null — `{ additions, deletions, filesChanged, byAgent }` for the workspace |
| metrics.getAgentStats | agentId (req) | Metrics \| null — `{ additions, deletions, filesChanged }` for one agent (`byAgent` omitted) |
| metrics.getAllWorkspaceStats | — | { [workspaceId]: Metrics } — all workspaces |
| metrics.clearAgentStats | agentId (req) | { success: boolean } — resets one agent's counters |

```json
// → request
{ "jsonrpc":"2.0","id":52,"method":"metrics.getWorkspaceStats","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "additions":140,"deletions":12,"filesChanged":3,
  "byAgent":{ "agent-123":{ "additions":140,"deletions":12,"filesChanged":3 } } } }
```

### 5.21 `rules.*` *(new in intentd — not part of the ported 104)*

The backend owns prompt **rules**: the workspace rule files
(`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization
rules attached to a specialist, and **user-rule overrides** persisted by the daemon. `list`/`get`
are reads; `update` is the UI-invoked op that edits the **user-override** content. Assembling these
into an agent's system prompt (the **injection pipeline**) runs **internally** as agents start —
there is no wire method for it (§6.8). Every method requires `workspaceId` except where noted.

Within that internal pipeline the **per-agent-type specialization** layer is **not settings-only**:
it resolves through a **3-tier fallback** (highest priority first) — the `endUserRules`
**user-settings override** (edited via `rules.update`) **>** the **workspace file**
`.augment/agent-rules/{agentType}.md` **>** the compiled-in **bundled built-in** template — so a
workspace rule file and a bundled default both back the per-agent-type key when no settings override
exists. This is a faithful port of the reference `getInstructionWithCommon` composition (with the
agent-id alias map and the utility/background-agent special-cases) and remains internal — no method
or shape changes (intentd PR #73).

| Method | Params | Result |
| --- | --- | --- |
| rules.list | workspaceId? | { rules: RuleSet } — all rule sources for the workspace (or global when omitted) |
| rules.get | workspaceId (req), ruleType (req): user-override key — "base-system-prompt", a per-agent-type specialization key, "workspace", … | { enabled, content, updatedAt } for that one user-override type |
| rules.update | workspaceId (req), ruleType (req): user-override key (as in rules.get), content (req): string, enabled?: boolean | { rules: RuleSet } — upserts the user-override body (+ enabled) and re-reads the set |

**RuleSet** — `{ workspaceId?, rules: RuleEntry[] }` where **RuleEntry** =
`{ ruleType: string, source: string, path?, content, enabled: boolean, updatedAt: number,
editable: boolean }`. `ruleType` is the user-override key the entry is stored under (e.g.
`"base-system-prompt"`, a per-agent-type specialization key, or `"workspace"`); `source` names the
origin (e.g. `"AGENTS.md"`, `".augment/guidelines.md"`, a specialist id, or `"user-override"`);
`path?` is the backing file when one exists; `enabled` toggles whether the override is applied and
`updatedAt` is its last-write epoch-ms; only `user-override` entries are `editable` (the target of
`rules.update`). File-sourced entries are read-only over the wire — edit the files directly.

```json
// → request — set the user-rule override for a workspace
{ "jsonrpc":"2.0","id":60,"method":"rules.update",
  "params":{ "workspaceId":"ws-abc","ruleType":"workspace","enabled":true,
    "content":"Always run the linter before committing." } }
// ← response
{ "jsonrpc":"2.0","id":60,"result":{ "rules":{ "workspaceId":"ws-abc","rules":[
  { "ruleType":"base-system-prompt","source":"user-override","content":"…",
    "enabled":false,"updatedAt":1750000000000,"editable":true },
  { "ruleType":"workspace","source":"user-override",
    "content":"Always run the linter before committing.","enabled":true,
    "updatedAt":1750000000000,"editable":true } ] } } }
```

### 5.22 `mcp.servers.*` *(new in intentd — not part of the ported 104)*

The **external** MCP-server lifecycle/config surface, backed by the `mcp.servers` setting
(**sensitive** — §5.12; secrets in `env`/`headers` are redacted on the wire). This is the
**user-facing** management surface (the reference `McpServersSettings.svelte`): register, edit,
enable/disable, and restart MCP servers the daemon hosts. It is **distinct** from the **agent→BE
MCP callback** (IMPLEMENTATION_SPEC.md §6.8), which lets a running agent reach BE-hosted MCP tools
and surfaces as the `mcp:notification` event — that callback has no `mcp.servers.*` method. Health
and lifecycle transitions are pushed via `mcp.servers:status-changed` (§6.5).

| Method | Params | Result |
| --- | --- | --- |
| mcp.servers.list | workspaceId? | { servers: McpServerConfig[] } — sensitive `env`/`headers` redacted |
| mcp.servers.create | config (req): McpServerConfig | { server: McpServerConfig } |
| mcp.servers.update | serverId (req), config (req): McpServerConfig | { server: McpServerConfig } |
| mcp.servers.delete | serverId (req) | { success: true } |
| mcp.servers.toggle | serverId (req), enabled (req): boolean | { status: McpServerStatus } — enable starts the server, disable stops it (replaces start/stop) |
| mcp.servers.restart | serverId (req) | { status: McpServerStatus } — stop-then-start |
| mcp.servers.getStatus | serverId (req) | { status: McpServerStatus } — optional point read; live updates arrive via `mcp.servers:status-changed` |

- **McpServerConfig** — `{ id, name, transport: "stdio"|"http"|"sse", command?, args?: string[],
  env?: object, url?, headers?: object, enabled: boolean, scope?: "user"|"workspace" }`. `command`
  / `args` / `env` apply to `stdio`; `url` / `headers` describe `http`/`sse`. **Only `stdio` is
  ported — `http`/`sse` are NOT PORTING** (such a server returns an error status rather than
  connecting). Sensitive `env` and
  `headers` values are **redacted** (presence/placeholder only) on `list`/`create`/`update`
  responses, mirroring `settings.*` (§5.12).
- **McpServerStatus** — `{ serverId, state: "stopped"|"starting"|"running"|"error", pid?,
  toolCount?, lastError?, startedAt? }`. `toolCount` is the number of tools the server advertised
  once connected.

```json
// → request — enable (start) an MCP server
{ "jsonrpc":"2.0","id":61,"method":"mcp.servers.toggle",
  "params":{ "serverId":"srv-fs","enabled":true } }
// ← response (emits mcp.servers:status-changed)
{ "jsonrpc":"2.0","id":61,"result":{ "status":{
  "serverId":"srv-fs","state":"running","pid":4821,"toolCount":7,"startedAt":1750000000000 } } }
```

> **NOT PORTED: `memories.*`.** Long-term agent **memories** exist as an internal context source the
> agent runtime consumes; they are **not** exposed over the wire (no renderer caller, and the original
> `augmentcode/intent` feature is a vestigial non-persisted in-memory stub). The `memories.*` RPC is
> **cancelled, not deferred** — it is not on the porting roadmap. The §9 `memories` table ships and the
> internal `search.memories` path (IMPLEMENTATION_SPEC.md §5.15) scans it; a `memories.*` namespace
> (list/create/search/delete) could be added additively later **only if** a memories UI ever ships.

### 5.23 Usage metrics — `workspace.getTokenUsage` *(new in intentd — not part of the ported 104)*

The backend owns token/credit **usage accounting**. A daemon-internal periodic **scan job** tallies
usage per agent and per model and writes the durable `tokenUsage` field on the `Workspace`; only the
**read** and its change event cross the wire — the scan job itself has **no** RPC (§6.8).
`workspace.getTokenUsage` requires `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| workspace.getTokenUsage | workspaceId (req) | { tokenUsage: TokenUsage } — -32602 if the workspace is not found |

**TokenUsage** — `{ byAgentId: { [agentId]: TokenUsageTotals }, totals: TokenUsageTotals,
byModel: { [modelName]: TokenUsageTotals }, lastScanAt: string | null }`, where
**TokenUsageTotals** is the four consumption counters
`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`. `byAgentId` keys are
`agent-{uuid}`; `byModel` keys are the effective model name (`"unknown"` fallback); `lastScanAt` is
the RFC-3339 timestamp of the last internal scan (`null` before the first scan). Updated values are
pushed via `workspace:tokenUsage-changed` (§6.5).

```json
// → request
{ "jsonrpc":"2.0","id":62,"method":"workspace.getTokenUsage","params":{ "workspaceId":"ws-abc" } }
// ← response (emitted again as workspace:tokenUsage-changed after each internal scan)
{ "jsonrpc":"2.0","id":62,"result":{ "tokenUsage":{
  "byAgentId":{ "agent-123":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 } },
  "byModel":{ "opus-4.8":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 } },
  "totals":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 },
  "lastScanAt":"2026-06-17T12:00:00Z" } } }
```

### 5.24 Session stats — `agent.getSessionStats` *(new in intentd — not part of the ported 104)*

Per-session usage rollup sourced from the auggie CLI (`session stats --json`) and cached on the
`stats` field of the `AgentSession`. `agent.getSessionStats` is a point **read**; live changes are
pushed via `agent:session-stats-changed` (§6.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.getSessionStats | sessionId (req) | { stats: SessionStats } — -32602 if the session is unknown |

**SessionStats** — `{ creditsUsed: number | null, messageCount, toolCount }`: cumulative credits
consumed (`null` until computed), user/assistant messages exchanged, and tool calls made in the
session. The same object appears as the `stats` field on `AgentSession` in `agent.*` results.

```json
// → request
{ "jsonrpc":"2.0","id":63,"method":"agent.getSessionStats","params":{ "sessionId":"sess-9" } }
// ← response
{ "jsonrpc":"2.0","id":63,"result":{ "stats":{ "creditsUsed":1.54,"messageCount":18,"toolCount":42 } } }
```

### 5.25 Worktree setup scripts — `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript` *(new in intentd — not part of the ported 104)*

A per-workspace **setup script** that provisions a fresh worktree (install deps, build prereqs, …),
persisted on the durable `setupScript` field of the `Workspace`. `detectProjectType` inspects
manifest files to classify the project; `generateSetupScript` is the **AI-assisted** generator —
this maps the reference UI's `generateWithAgent` (`SetupScriptAgent.svelte`) and **is v1**. Every
method requires `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| workspace.getSetupScript | workspaceId (req) | { setupScript: SetupScript } |
| workspace.saveSetupScript | workspaceId (req), script (req): string | { setupScript: SetupScript } — persists the body and returns the stored record |
| workspace.detectProjectType | workspaceId (req) | { projectType: ProjectType \| null } — null when no known manifest is found |
| workspace.generateSetupScript | workspaceId (req) | { setupScript: SetupScript } — AI-assisted draft (returned, not auto-saved; persist with saveSetupScript) |

- **SetupScript** — `{ script: string, projectType?: ProjectType, updatedAt: number,
  generatedBy?: "user"\|"agent" }`. `generatedBy` records whether the body was hand-written
  (`saveSetupScript`) or AI-drafted (`generateSetupScript`); `updatedAt` is the last-write epoch-ms.
- **ProjectType** — `"node" | "python" | "go" | "rust" | "ruby"` (detected from `package.json`,
  `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, and `Gemfile` respectively).

```json
// → request — detect the project type, then generate a draft script
{ "jsonrpc":"2.0","id":64,"method":"workspace.detectProjectType","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":64,"result":{ "projectType":"rust" } }
// → request
{ "jsonrpc":"2.0","id":65,"method":"workspace.generateSetupScript","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":65,"result":{ "setupScript":{
  "script":"#!/usr/bin/env bash\nset -euo pipefail\ncargo fetch\n",
  "projectType":"rust","updatedAt":1750000000000,"generatedBy":"agent" } } }
```

### 5.26 Future integrations & observability *(design notes — NOT v1 wire surface)*

> **Future integrations (design stubs — NOT v1).** Of the original design stubs, **Sandbox /
> DevContainer** workspace configuration remains a future per-workspace execution-environment
> surface — anticipated but **not** exposed over the protocol in v1, folded into the same future
> track.
>
> **Linear** (issue tracking) is re-implemented daemon-owned against Linear's GraphQL API
> (**no Augment proxy**) as the `linear.*` namespace — **specified as a TARGET contract — see §5.28**.
>
> **Sentry** (error tracking) is re-implemented daemon-owned against Sentry's REST API
> (**no Augment proxy**) as the `sentry.*` namespace — **specified as a TARGET contract — see §5.29**.
>
> These are documented so the surface is anticipated; the deferral honors the Iteration-5 scope
> decision.

> **Observability is internal, not wire.** Tracing, structured logging, and log files are
> **daemon-internal** operational concerns — there is **no** `logging.*` / `telemetry.*` wire
> surface, and none is planned for v1. Clients observe backend work through domain **events** (§6.5),
> not through a logging API.

### 5.27 `github.*` namespace *(new in intentd — not part of the ported 104)*

> **✅ SHIPPED.** The `github.*` namespace is fully implemented and wired end-to-end (engine: GH-ENG; wire arms: GH-WIRE-A / GH-WIRE-B) — 21 methods routed daemon-owned against `api.github.com`, with real `nextToken`/`limit` pagination on the list reads (the uniform-pagination contract described in §5.27 conventions below). The field names and shapes here remain the source of truth for both sides.

> **New namespace — replaces the Augment Cloud proxy.** In `augmentcode/intent` the GitHub +
> identity surface is served by the Augment Cloud `augment-api.client.ts` (a hosted proxy +
> `agents/run-remote-tool` `github-api` bypass). `intentd` re-provides that surface **daemon-owned**
> against `api.github.com` directly, reusing the existing `intent-sourcecontrol` **octocrab** engine
> (IMPLEMENTATION_SPEC.md §7) — the same engine that already backs `pr.*`.
>
> **Namespace split (decided 2026-06-27).** Local git operations stay on `git.*` (§5.6). Everything
> that hits `api.github.com` — repo/PR/issue browse, PR review comments + threads — plus GitHub
> **auth** and GitHub-**derived identity** live on `github.*`. The existing `pr.*` methods (§5.7) are
> deliberately **workspace/active-PR scoped** (`ws` → owner/repo/number) and are left **untouched**;
> `github.*` is the **explicit-addressing** surface — every data method takes `(owner, repo[, number])`
> rather than resolving from the workspace.

> **Auth model — PAT from the environment (no OAuth/device flow, no credential store).** A local
> daemon has no hosted OAuth callback, so v1 authenticates with a **Personal Access Token resolved
> from the environment**: `GITHUB_TOKEN`, falling back to `GH_TOKEN` (the existing
> `intent-sourcecontrol` token resolution; explicit `sourceControl.github.token` / `gh auth token`
> remain as lower-priority fallbacks per §5.12).
>
> - `github.authStatus` validates the resolved token via `GET /user` and reports connection state.
> - `github.connect` / `github.revoke` are **no-ops / guidance** (the FE buttons are inert, like
>   Linear): there is nothing to connect/revoke when the token comes from the environment.
> - **Identity** is GitHub-derived: `github.getUser` returns the authenticated user from `GET /user`.
>
> **🔒 Secret guardrail.** The PAT is a secret: it is **never logged, echoed, or returned** over the
> wire. Only **derived identity** fields (login, avatar, profile URL) and the boolean
> connection state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `shared/types.ts` GitHub shapes
(`GithubRepo` / `GithubUser` / `GithubPullRequest` / `GithubIssue`, and the review-comment /
review-thread shapes) **field-for-field**, rendered in this protocol's **camelCase** convention
(serde `rename_all = "camelCase"`, matching `pr.*` in §5.7 and the rest of the catalog). The FE's
Augment-proxy passthrough exposed GitHub-native **snake_case**; on the `github.*` wire those keys
are normalized to camelCase: `html_url → htmlUrl`, `created_at → createdAt`, `updated_at → updatedAt`,
`merged_at → mergedAt`, `closed_at → closedAt`, `default_branch → defaultBranch`, `head_ref → headRef`,
`base_ref → baseRef`, `head_sha → headSha`, `base_sha → baseSha`, `mergeable_state → mergeableState`,
`review_comments → reviewComments`, `changed_files → changedFiles`, `avatar_url → avatarUrl`,
`in_reply_to_id → inReplyToId`. The set of fields is otherwise identical to the FE types.

**Conventions.** Unless noted, `owner` + `repo` are **(req)** string params (and `number` is the
**(req)** PR/issue number where applicable). Reads that paginate follow the uniform pagination
contract: an optional `limit` (default **50**, max **200**) plus an opaque `nextToken` cursor echoed
in the result (`nextToken: null` when there are no further pages). Errors reuse the §9 conventions:
missing/invalid params and "not found" (404) lookups → `-32602`; a token that is absent or fails
`GET /user`, and any other GitHub/service failure → `-32603` with a descriptive `message`
(e.g. `"GitHub is not configured."`). There are **no** custom numeric codes.

#### Repos & branches

| Method | Params | Result |
| --- | --- | --- |
| github.repos.list | limit?, nextToken? | { repos: GithubRepo[], nextToken? } — the authenticated user's repositories (`GET /user/repos`) |
| github.repos.search | query (req), limit?, nextToken? | { repos: GithubRepo[], nextToken? } — `GET /search/repositories` (FE rewrites `owner/name` → `name user:owner`, sorted by stars) |
| github.repos.get | owner (req), repo (req) | { repo: GithubRepo \| null } — `GET /repos/{owner}/{repo}` (repo metadata incl. `defaultBranch`) |
| github.branches.list | owner (req), repo (req), limit?, nextToken? | { branches: string[], nextToken? } — **remote** branch names (`GET /repos/{owner}/{repo}/branches`) |

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| github.authStatus | — | { isConfigured, oauthUrl, configuredButNeedsUpdate, updatedScopes } — `isConfigured` = env PAT resolves **and** `GET /user` succeeds. `oauthUrl` is `""` and `configuredButNeedsUpdate` is `false` in the PAT-from-env model (fields kept for FE shape parity) |
| github.connect | — | { ok: false, guidance } — **no-op**; `guidance` explains setting `GITHUB_TOKEN` (no OAuth/device flow) |
| github.revoke | — | { ok: false, guidance } — **no-op**; token is environment-owned, nothing to revoke |
| github.getUser | — | { user: GithubUser \| null } — authenticated identity from `GET /user`; never includes the PAT |

#### Pulls

`createPullRequest` sends `head` **verbatim** (no `owner:branch` login prefix) — preserving the
FE's "bypass the buggy backend" behavior for same-repo branches.

| Method | Params | Result |
| --- | --- | --- |
| github.pulls.create | owner (req), repo (req), title (req), body (req), head (req), base (req), draft? | { pull: GithubPullRequest \| null } — `POST /repos/{owner}/{repo}/pulls` (head verbatim) |
| github.pulls.get | owner (req), repo (req), number (req) | { pull: GithubPullRequest \| null } — `GET /repos/{owner}/{repo}/pulls/{number}` |
| github.pulls.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", head?, base?, sort?: "created"\|"updated"\|"popularity"\|"long-running", direction?: "asc"\|"desc", limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /repos/{owner}/{repo}/pulls` |
| github.pulls.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"review-requested"\|"involves", state?: "open"\|"closed", limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /search/issues?q=is:pr repo:{o}/{r} is:{state} {author\|assignee\|review-requested\|involves}:@me`; `filter:"all"`+`state:"open"` delegates to `github.pulls.list` |
| github.pulls.merge | owner (req), repo (req), number (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | { merged, message, sha? } — `PUT /repos/{owner}/{repo}/pulls/{number}/merge` |
| github.pulls.updateBranch | owner (req), repo (req), number (req), expectedHeadSha? | { message, url? } — `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` |

#### Issues

| Method | Params | Result |
| --- | --- | --- |
| github.issues.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", assignee?, creator?, labels?, sort?: "created"\|"updated"\|"comments", direction?: "asc"\|"desc", limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /repos/{owner}/{repo}/issues` (items carrying `pull_request` are filtered out) |
| github.issues.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"involves", state?: "open"\|"closed", limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /search/issues?q=is:issue repo:{o}/{r} …` |

#### Review comments & threads

Review **comments** are the REST inline comments (`/pulls/{n}/comments`); review **threads** are the
GraphQL `pullRequest.reviewThreads` with resolve state — `resolveThread` / `unresolveThread` map to
the GraphQL `resolveReviewThread` / `unresolveReviewThread` mutations (parity with the FE's
`pr-comment.service.ts`).

| Method | Params | Result |
| --- | --- | --- |
| github.listReviewComments | owner (req), repo (req), number (req), limit?, nextToken? | { comments: ReviewComment[], nextToken? } — `GET /repos/{owner}/{repo}/pulls/{number}/comments` |
| github.replyReviewComment | owner (req), repo (req), number (req), commentId (req), body (req) | { comment: ReviewComment } — `POST /repos/{owner}/{repo}/pulls/{number}/comments` (`inReplyToId = commentId`) |
| github.getReviewThreads | owner (req), repo (req), number (req), limit?, nextToken? | { threads: ReviewThread[], nextToken? } — GraphQL `pullRequest.reviewThreads` |
| github.resolveThread | threadId (req) | { isResolved: true } — GraphQL `resolveReviewThread` |
| github.unresolveThread | threadId (req) | { isResolved: false } — GraphQL `unresolveReviewThread` |

#### DTO schemas

```ts
interface GithubRepo {
  owner: string;
  name: string;
  htmlUrl?: string;
  createdAt?: string;     // ISO 8601
  updatedAt?: string;     // ISO 8601
  defaultBranch?: string;
}

interface GithubUser {     // derived identity — never carries the PAT
  login: string;
  avatarUrl: string;
  htmlUrl: string;
}

interface GithubPullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  user: GithubUser;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  draft: boolean;
  mergeable?: boolean | null;
  mergeableState?: string;
  labels: string[];
  assignees?: GithubUser[];
  comments: number;
  reviewComments: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  user: GithubUser;
  labels: string[];
  comments: number;
  owner?: string;          // repository owner (echoed for convenience)
  repo?: string;           // repository name
}

interface ReviewComment {  // REST inline review comment
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
  inReplyToId?: number;
  htmlUrl: string;
}

interface ReviewThread {   // GraphQL review thread
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

interface ReviewThreadComment {
  id: string;
  body: string;
  author: { login: string };
  path: string;
  line: number | null;
  createdAt: string;
}
```

#### Examples

```json
// → check GitHub auth (validates the env PAT via GET /user)
{ "jsonrpc":"2.0","id":50,"method":"github.authStatus","params":{} }
// ← response (GITHUB_TOKEN present and valid)
{ "jsonrpc":"2.0","id":50,"result":{
  "isConfigured": true, "oauthUrl": "", "configuredButNeedsUpdate": false, "updatedScopes": "" } }
```

```json
// → derived identity (no token ever returned)
{ "jsonrpc":"2.0","id":51,"method":"github.getUser","params":{} }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "user":{
  "login":"octocat","avatarUrl":"https://avatars.githubusercontent.com/u/1","htmlUrl":"https://github.com/octocat" } } }
```

```json
// → create a PR with the head ref sent verbatim (no login prefix)
{ "jsonrpc":"2.0","id":52,"method":"github.pulls.create",
  "params":{ "owner":"octocat","repo":"hello","title":"Add feature","body":"…",
    "head":"feature/x","base":"main","draft":false } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "pull":{
  "number":42,"title":"Add feature","state":"open","htmlUrl":"https://github.com/octocat/hello/pull/42",
  "headRef":"feature/x","baseRef":"main","draft":false,"merged":false,
  "user":{ "login":"octocat","avatarUrl":"…","htmlUrl":"…" } } } }
```

```json
// → connect is inert in the PAT-from-env model
{ "jsonrpc":"2.0","id":53,"method":"github.connect","params":{} }
// ← response (guidance only — nothing to connect)
{ "jsonrpc":"2.0","id":53,"result":{
  "ok": false, "guidance": "GitHub uses a Personal Access Token from the environment. Set GITHUB_TOKEN (or GH_TOKEN) and restart." } }
```

### 5.28 `linear.*` namespace *(new in intentd — not part of the ported 104)*

> **✅ SHIPPED (P0 + P1 reads + P2 writes).** The full `linear.*` read surface — `linear.authStatus`, `linear.listIssues`, `linear.searchIssues`, `linear.getIssue`, `linear.viewer`, `linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`, `linear.listLabels` — plus the P2 issue-write methods `linear.createIssue` / `linear.updateIssue` are implemented and wired end-to-end (engine: LIN-ENG; wire arm: LIN-WIRE; P2 writes: intentd PR #71), daemon-owned against Linear's GraphQL API. Only the `linear.listComments` / `linear.createComment` comment surface (no FE shape) remains out of scope — see "Deferred — comments" below. The field names and shapes here remain the source of truth for both sides.

> **New namespace — replaces the Augment Cloud proxy.** In `augmentcode/intent` the Linear surface
> is **read-only** and brokered by the Augment Cloud remote-tool proxy
> (`agents/run-remote-tool`, `tool_id = 12`), which sends a **natural-language prompt** to a hosted
> LLM tool and **best-effort parses** the loosely-structured output. `intentd` re-provides that
> surface **daemon-owned** against Linear's GraphQL API (`POST https://api.linear.app/graphql`)
> directly — **no Augment proxy, no NL prompt** — via the new `intent-linear` crate. The `filter`
> values map to **typed Linear GraphQL filters server-side**, removing the parse-the-LLM-output
> fragility.

> **Auth model — API key from the environment (no OAuth/device flow, no credential store).** A local
> daemon has no hosted OAuth callback, so v1 authenticates with a **Linear personal API key resolved
> from the environment**: `LINEAR_API_KEY` (with an optional lower-priority keychain account
> `linear.token`). Linear is GraphQL-only; the key is sent as the **`Authorization: <key>` header
> with NO `Bearer` prefix** for `lin_api_…` personal keys (a future OAuth access token would use
> `Authorization: Bearer <token>` — the prefix differs by credential type).
>
> - `linear.authStatus` validates the resolved key via the GraphQL `viewer` probe and reports
>   connection state.
> - **There is no `linear.connect` / `linear.revoke` / `cancelAuth` wire method.** Unlike `github.*`
>   (which keeps inert no-op `connect`/`revoke` for FE shape parity), Linear exposes **nothing**
>   here: "connect" becomes "set `LINEAR_API_KEY` and restart", "revoke/logout" is a local
>   "forget token" action, and `cancelAuth` was always a pure client-side no-op. The settings UI
>   buttons are inert.
>
> **🔒 Secret guardrail.** The API key is a secret: it is **never logged, echoed, or returned** over
> the wire. Only **derived identity** (the `login` from `viewer`) and the boolean connection state
> cross the wire — never the key itself.

**Field naming.** The DTOs below mirror the FE `src/features/linear-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all = "camelCase"`,
matching `github.*` §5.27 and the rest of the catalog). The wire returns the **flattened
`LinearIssueResult`** — the exact shape the FE's `fetchMyIssues` / `searchIssues` already consume —
so the rewire is zero-FE-change: nested Linear relations (`team` / `state` / `assignee` / `creator`
/ `project` / `labels`) are pre-flattened to scalar / `string[]` fields server-side. Absent
(`None`) optional fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). Unlike the uniform-pagination reads elsewhere in the catalog (the `{ items, nextToken }` envelope used by `agent.getConversation`, `event.query`, `git.commits`, the `github.*` list reads, etc.), every Linear arm returns a **bare result** —
either a bare object (`linear.authStatus`, `linear.viewer`, `linear.getIssue`) or a bare array
(`linear.listIssues`, `linear.searchIssues`, `linear.listTeams`, `linear.listWorkflowStates`,
`linear.listProjects`, `linear.listLabels`) — there is **no `{ items, nextToken }` envelope and no
cursor** (the consumed Linear surface is small and bounded; cursor pagination is not part of this
phase). Absent (`None`) optional fields are **omitted** from the JSON. Errors reuse the §9
conventions: missing/invalid params → `-32602` (e.g. `linear.getIssue` requires `id` **or**
`identifier`, otherwise `Missing required parameter: id`); a key that is **absent or fails the
`viewer` probe** ("not configured"), and any other Linear/service failure → `-32603` with a
descriptive `message` (e.g. `"Linear is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| linear.authStatus | — | { authenticated, login?, scopes } — `authenticated` = env key resolves **and** the GraphQL `viewer { id name email }` probe succeeds; `login` is the viewer's name/email; `scopes` is always `[]` (Linear's `viewer` returns no key scopes). Never includes the key. |

#### Issues

`filter` maps to a typed Linear GraphQL filter **server-side** (replacing the reference impl's
natural-language prompt). `linear.listIssues` backs the FE's `fetchMyIssues`; `linear.searchIssues`
backs the FE's `searchIssues`. Both return the flattened `LinearIssueResult[]` directly.
`linear.getIssue` resolves a single flattened `LinearIssueResult` by UUID `id` **or** `ENG-123`-style
`identifier` (the engine picks the lookup mode by string shape); it is not consumed by the FE today
but completes the read surface.

| Method | Params | Result |
| --- | --- | --- |
| linear.listIssues | filter?: "assigned"\|"created"\|"subscribed"\|"team"\|"all" (default "assigned"), limit? | LinearIssueResult[] — the authenticated viewer's issues for the typed `filter` |
| linear.searchIssues | query (req), limit? | LinearIssueResult[] — full-text issue search |
| linear.getIssue | id \| identifier (one required — UUID `id` or `ENG-123`-style `identifier`) | LinearIssueResult — one flattened issue |

#### Viewer & catalogs

`linear.viewer` returns the authenticated user as a bare `LinearUser`; the four list methods return
small bounded catalogs (teams, workflow states, projects, labels) as bare DTO arrays. All four
lists accept an optional `limit`. None of these reads are currently consumed by the FE — they are
forward-looking surface for a future create/edit UI.

| Method | Params | Result |
| --- | --- | --- |
| linear.viewer | — | LinearUser — the authenticated user |
| linear.listTeams | limit? | LinearTeam[] |
| linear.listWorkflowStates | limit? | LinearWorkflowState[] |
| linear.listProjects | limit? | LinearProject[] |
| linear.listLabels | limit? | LinearLabel[] |

#### DTO schemas

```ts
interface AuthStatus {          // shared with the auth probe; never carries the API key
  authenticated: boolean;
  login?: string;               // viewer name or email
  scopes: string[];             // always [] — Linear's viewer returns no key scopes
}

interface LinearIssueResult {   // flattened UI shape — matches the FE verbatim
  id: string;
  identifier: string;           // e.g. "ENG-123"
  title: string;
  description?: string;
  url?: string;
  teamName?: string;
  teamKey?: string;             // e.g. "ENG"
  state?: string;               // workflow-state name
  priority?: number;            // Linear priority 0–4
  assignee?: string;            // assignee display name
  labels?: string[];            // label names
  project?: string;             // project name
  creator?: string;             // creator name
  createdAt?: string;           // ISO 8601
  updatedAt?: string;           // ISO 8601
}

interface LinearUser {          // linear.viewer
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

interface LinearTeam {          // linear.listTeams entry
  id: string;
  key: string;                  // e.g. "ENG"
  name: string;
  description?: string;
}

interface LinearWorkflowState { // linear.listWorkflowStates entry
  id: string;
  name: string;
  type: string;                 // "backlog" | "unstarted" | "started" | "completed" | "canceled"
  description?: string;
  color?: string;
}

interface LinearProject {       // linear.listProjects entry
  id: string;
  name: string;
  description?: string;
  state: string;                // "backlog" | "planned" | "started" | "paused" | "completed" | "canceled"
  url?: string;
}

interface LinearLabel {         // linear.listLabels entry
  id: string;
  name: string;
  description?: string;
  color?: string;
}
```

#### Examples

```json
// → check Linear auth (validates the env key via the GraphQL viewer probe)
{ "jsonrpc":"2.0","id":54,"method":"linear.authStatus","params":{} }
// ← response (LINEAR_API_KEY present and valid)
{ "jsonrpc":"2.0","id":54,"result":{ "authenticated": true, "login": "Ada Lovelace", "scopes": [] } }
```

```json
// → issues assigned to the authenticated viewer (typed filter, no NL prompt)
{ "jsonrpc":"2.0","id":55,"method":"linear.listIssues","params":{ "filter":"assigned","limit":50 } }
// ← response (flattened LinearIssueResult[]; absent optionals omitted)
{ "jsonrpc":"2.0","id":55,"result":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamName":"Engineering","teamKey":"ENG","priority":2,"assignee":"Ada Lovelace",
    "labels":["bug"],"url":"https://linear.app/acme/issue/ENG-123" } ] }
```

```json
// → full-text issue search
{ "jsonrpc":"2.0","id":56,"method":"linear.searchIssues","params":{ "query":"widget","limit":20 } }
// ← response
{ "jsonrpc":"2.0","id":56,"result":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","teamKey":"ENG",
    "url":"https://linear.app/acme/issue/ENG-123" } ] }
```

```json
// → one issue by ENG-123 identifier (or pass `id` for a UUID)
{ "jsonrpc":"2.0","id":57,"method":"linear.getIssue","params":{ "identifier":"ENG-123" } }
// ← response (single flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":57,"result":
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamKey":"ENG","url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → the authenticated user
{ "jsonrpc":"2.0","id":58,"method":"linear.viewer","params":{} }
// ← response (bare LinearUser; absent optionals omitted)
{ "jsonrpc":"2.0","id":58,"result":
  { "id":"u1","name":"Ada Lovelace","displayName":"ada","email":"ada@example.com" } }
```

```json
// → list teams (bare array; optional limit caps the result)
{ "jsonrpc":"2.0","id":59,"method":"linear.listTeams","params":{ "limit":50 } }
// ← response (bare LinearTeam[])
{ "jsonrpc":"2.0","id":59,"result":[
  { "id":"t1","key":"ENG","name":"Engineering" } ] }
```

#### Writes — P2 (createIssue / updateIssue)

`linear.createIssue` runs the `issueCreate` GraphQL mutation; `linear.updateIssue` runs
`issueUpdate`. The router validates the required wire fields up front — `createIssue` requires a
non-empty `title` **and** `teamId`, `updateIssue` requires a non-empty `issueId` (otherwise
`-32602` `Missing required parameter: <field>`) — and forwards only the fields present. Both return
the **flattened `LinearIssueResult`** (the same shape as the reads). A key that is **absent or
fails the `viewer` probe** ("not configured"), and any other Linear/service failure → `-32603`.
🔒 The API key is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| linear.createIssue | title (req), teamId (req), description?, assigneeId?, stateId?, priority?, labelIds? | LinearIssueResult — the created issue, flattened |
| linear.updateIssue | issueId (req), title?, description?, assigneeId?, stateId?, priority? | LinearIssueResult — the updated issue, flattened |

##### DTO schemas

```ts
interface CreateIssueRequest {  // linear.createIssue — `title` + `teamId` required
  title: string;
  teamId: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
  labelIds?: string[];
}

interface UpdateIssueRequest {  // linear.updateIssue — `issueId` required; rest optional
  issueId: string;
  title?: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
}
```

##### Examples

```json
// → create an issue (title + teamId required)
{ "jsonrpc":"2.0","id":60,"method":"linear.createIssue",
  "params":{ "title":"New issue","teamId":"team-uuid","priority":2,"labelIds":["l1"] } }
// ← response (flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":60,"result":
  { "id":"a1b2","identifier":"ENG-200","title":"New issue","teamKey":"ENG","priority":2,
    "url":"https://linear.app/acme/issue/ENG-200" } }
```

```json
// → missing required `teamId` → -32602
{ "jsonrpc":"2.0","id":61,"method":"linear.createIssue","params":{ "title":"X" } }
// ← error
{ "jsonrpc":"2.0","id":61,"error":{ "code":-32602,"message":"Missing required parameter: teamId" } }
```

```json
// → update an issue (issueId required; only present fields are sent through IssueUpdateInput)
{ "jsonrpc":"2.0","id":62,"method":"linear.updateIssue",
  "params":{ "issueId":"uuid-1","title":"Updated","stateId":"s1" } }
// ← response (flattened LinearIssueResult)
{ "jsonrpc":"2.0","id":62,"result":
  { "id":"uuid-1","identifier":"ENG-123","title":"Updated","state":"Done",
    "url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → not-configured (no LINEAR_API_KEY, or the viewer probe fails) → -32603
{ "jsonrpc":"2.0","id":63,"method":"linear.createIssue","params":{ "title":"X","teamId":"t1" } }
// ← error
{ "jsonrpc":"2.0","id":63,"error":{ "code":-32603,"message":"Linear is not configured." } }
```

#### Deferred — comments (NOT in this phase)

The read surface (P0 + P1) and the P2 issue writes ship now (above). Only the comment surface
remains **out of scope** and is listed so it is anticipated:

- **Comments (no FE shape):** `linear.listComments` / `linear.createComment` — comments are not
  modeled in the FE at all. Do **not** build unless a feature requires them.

When built, the comment methods extend this `linear.*` namespace additively (with their own §9
error rows and any events) and do not change the contract above.

### 5.29 `sentry.*` namespace *(new in intentd — not part of the ported 104)*

> **✅ SHIPPED (P0 + P1 reads + P2 writes).** The full `sentry.*` surface — the P0 reads
> `sentry.authStatus`, `sentry.listIssues`, `sentry.searchIssues`; the P1 reads
> `sentry.listProjects`, `sentry.getIssue`; and the P2 writes `sentry.resolveIssue`,
> `sentry.ignoreIssue`, `sentry.assignIssue` — is implemented and wired end-to-end (engine: the
> new `intent-sentry` crate; wire arm: `intent-services` `sentry_ops` → `intent-transport`
> router; P1 reads + P2 writes: intentd PR #72), daemon-owned against Sentry's REST API. The
> field names and shapes here remain the source of truth for both sides.

> **New namespace — replaces the Augment Cloud proxy.** In `augmentcode/intent` the Sentry
> surface is **read-only** and brokered by the Augment Cloud remote-tool proxy (the same
> `agents/run-remote-tool` mechanism Linear used), which sends a **natural-language prompt** to a
> hosted LLM tool and **best-effort parses** the loosely-structured output. `intentd` re-provides
> that surface **daemon-owned** against Sentry's REST API
> (`GET https://sentry.io/api/0/organizations/{org}/issues/`) directly — **no Augment proxy, no
> NL prompt** — via the new `intent-sentry` crate. The `status` filter maps to a **typed
> `is:<status>` clause** server-side, and `query` is forwarded verbatim as the Sentry search
> string, removing the parse-the-LLM-output fragility.

> **Auth model — token + org from the environment (no OAuth/device flow, no
> `connect`/`revoke`).** A local daemon has no hosted OAuth callback, so v1 authenticates with
> a **Sentry user/internal-integration auth token + organization slug resolved from the
> environment**: `SENTRY_API_TOKEN` (with an optional lower-priority keychain account
> `sentry.token`) plus `SENTRY_ORG` (organization slug). Sentry is REST-only; the token is sent
> as the **`Authorization: Bearer <token>`** header.
>
> - `sentry.authStatus` validates the resolved pair via `GET /organizations/{org}/` and reports
>   connection state.
> - **There is no `sentry.connect` / `sentry.revoke` / `cancelAuth` wire method.** As with
>   `linear.*`, Sentry exposes **nothing** here: "connect" becomes "set `SENTRY_API_TOKEN` +
>   `SENTRY_ORG` and restart", "revoke/logout" is a local "forget token" action, and `cancelAuth`
>   was always a pure client-side no-op. The settings UI buttons are inert.
>
> **🔒 Secret guardrail.** The auth token is a secret: it is **never logged, echoed, or returned**
> over the wire. Only **derived identity** (the `organization` slug) and the boolean connection
> state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `src/features/sentry-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all =
"camelCase"`, matching `github.*` §5.27 / `linear.*` §5.28 and the rest of the catalog). The
wire returns the **flattened `SentryIssueResult`** — the exact shape the FE's `fetchIssues` /
`searchIssues` already consume — so the rewire is zero-FE-change: nested Sentry relations
(`project` → `projectName`/`projectSlug`, `metadata` → `type`/`value`/`filename`/`function`,
`permalink` → `url`) are pre-flattened to scalar fields server-side. Absent (`None`) optional
fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). Unlike the uniform-pagination reads elsewhere in the catalog (the `{ items,
nextToken }` envelope used by `agent.getConversation`, `event.query`, `git.commits`, the
`github.*` list reads, etc.), every Sentry arm returns a **bare result** — either a bare object
(`sentry.authStatus`) or a bare array (`sentry.listIssues`, `sentry.searchIssues`) — there is
**no `{ items, nextToken }` envelope and no cursor** (parity with `linear.*`; cursor pagination
is not part of this phase). Absent (`None`) optional fields are **omitted** from the JSON.
Errors reuse the §9 conventions: missing/invalid params → `-32602` (e.g. `sentry.searchIssues`
requires `query`, otherwise `Missing required parameter: query`; an invalid `status` not in
`unresolved`|`resolved`|`ignored`|`all` → `Invalid params: status must be one of: unresolved,
resolved, ignored, all`); a credential pair that is **absent or fails the org probe** ("not
configured"), and any other Sentry/service failure → `-32603` with a descriptive `message`
(e.g. `"Sentry is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| sentry.authStatus | — | { authenticated, organization?, error? } — `authenticated` = env credential pair resolves **and** the `GET /organizations/{org}/` probe succeeds; `organization` is the resolved org slug (derived identity only — never the token); `error` is a descriptive failure string when the probe fails. Never includes the token. |

#### Issues

`status` maps to a typed `is:<status>` clause **server-side** (replacing the reference impl's
natural-language prompt); `query` is forwarded verbatim as the Sentry search string.
`sentry.listIssues` backs the FE's `fetchIssues`; `sentry.searchIssues` backs the FE's
`searchIssues`. Both return the flattened `SentryIssueResult[]` directly.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listIssues | project?, status?: "unresolved"\|"resolved"\|"ignored"\|"all" (default "unresolved"; any other value → `-32602`), query?, limit? | SentryIssueResult[] — issues matching the typed `is:<status>` clause (combined with optional `project` slug and free-text `query`) |
| sentry.searchIssues | query (req — missing → `-32602`), project?, limit? | SentryIssueResult[] — full-text issue search |
| sentry.getIssue | id \| shortId (one required — UUID/numeric `id` or `WEB-1`-style `shortId`; both missing → `-32602`) | SentryIssueResult — one flattened issue |

#### Projects (P1)

`sentry.listProjects` returns the configured organization's projects as a bare `SentryProject[]`
(parity with `linear.listTeams` / `linear.listProjects`); it accepts an optional `limit`. Not
consumed by the FE today — forward-looking surface for a future project picker.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listProjects | limit? | SentryProject[] |

#### Writes — P2 (resolve / ignore / assign)

`sentry.resolveIssue` / `sentry.ignoreIssue` mutate the issue's status (`resolved` / `ignored`);
`sentry.assignIssue` sets the assignee. All three require a **non-empty `id`** (otherwise `-32602`
`Missing required parameter: id`); `assignIssue`'s `assignedTo` is **optional — an absent value
unassigns** the issue. Each returns the updated flattened `SentryIssueResult`. A credential pair
that is **absent or fails the org probe** ("not configured"), and any other Sentry/service failure
→ `-32603`. 🔒 The auth token is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| sentry.resolveIssue | id (req) | SentryIssueResult — the issue with `status: "resolved"` |
| sentry.ignoreIssue | id (req) | SentryIssueResult — the issue with `status: "ignored"` |
| sentry.assignIssue | id (req), assignedTo? (absent = unassign) | SentryIssueResult — the issue after (un)assignment |

#### DTO schemas

```ts
interface SentryAuthState {       // shared with the auth probe; never carries the token
  authenticated: boolean;
  organization?: string;          // resolved org slug (derived identity only)
  error?: string;                 // descriptive failure when the probe fails
}

interface SentryProject {         // sentry.listProjects entry
  id: string;
  slug: string;
  name: string;
  platform?: string;
  isMember?: boolean;
}

interface SentryIssueResult {     // flattened UI shape — matches the FE verbatim
  id: string;
  shortId: string;                // e.g. "PROJ-1"
  title: string;
  culprit?: string;
  status: "unresolved" | "resolved" | "ignored";
  level: "error" | "warning" | "info" | "fatal" | "debug";
  count: string;                  // total event count (Sentry returns a string)
  userCount: number;
  firstSeen: string;              // RFC-3339
  lastSeen: string;               // RFC-3339
  projectName: string;
  projectSlug: string;
  url?: string;                   // Sentry `permalink`
  type?: string;                  // metadata.type, e.g. "TypeError"
  value?: string;                 // metadata.value
  filename?: string;              // metadata.filename
  function?: string;              // metadata.function
}
```

#### Examples

```json
// → check Sentry auth (validates the env credential pair via the GET /organizations/{org}/ probe)
{ "jsonrpc":"2.0","id":70,"method":"sentry.authStatus","params":{} }
// ← response (SENTRY_API_TOKEN + SENTRY_ORG present and valid)
{ "jsonrpc":"2.0","id":70,"result":{ "authenticated": true, "organization": "acme" } }
```

```json
// → unresolved issues across the org (typed `is:unresolved` clause, no NL prompt)
{ "jsonrpc":"2.0","id":71,"method":"sentry.listIssues","params":{ "status":"unresolved","limit":50 } }
// ← response (flattened SentryIssueResult[]; absent optionals omitted)
{ "jsonrpc":"2.0","id":71,"result":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "type":"TypeError","filename":"src/app.ts",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ] }
```

```json
// → full-text issue search (forwarded verbatim as the Sentry search string)
{ "jsonrpc":"2.0","id":72,"method":"sentry.searchIssues","params":{ "query":"TypeError","limit":20 } }
// ← response
{ "jsonrpc":"2.0","id":72,"result":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ] }
```

```json
// → missing required `query` → -32602
{ "jsonrpc":"2.0","id":73,"method":"sentry.searchIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":73,"error":{ "code":-32602,"message":"Missing required parameter: query" } }
```

```json
// → invalid `status` → -32602 (verbatim message)
{ "jsonrpc":"2.0","id":74,"method":"sentry.listIssues","params":{ "status":"bogus" } }
// ← error
{ "jsonrpc":"2.0","id":74,"error":{
  "code":-32602,"message":"status must be one of: unresolved, resolved, ignored, all" } }
```

```json
// → not-configured (no SENTRY_API_TOKEN/SENTRY_ORG, or org probe fails) → -32603
{ "jsonrpc":"2.0","id":75,"method":"sentry.listIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":75,"error":{ "code":-32603,"message":"Sentry is not configured." } }
```

```json
// → one issue by shortId (or pass `id` for a UUID/numeric id)
{ "jsonrpc":"2.0","id":76,"method":"sentry.getIssue","params":{ "shortId":"WEB-1" } }
// ← response (single flattened SentryIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":76,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → getIssue with neither `id` nor `shortId` → -32602
{ "jsonrpc":"2.0","id":77,"method":"sentry.getIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":77,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

```json
// → list the org's projects (bare SentryProject[]; optional limit caps the result)
{ "jsonrpc":"2.0","id":78,"method":"sentry.listProjects","params":{ "limit":25 } }
// ← response (bare SentryProject[]; absent optionals omitted)
{ "jsonrpc":"2.0","id":78,"result":[
  { "id":"1","slug":"web","name":"Web","platform":"javascript","isMember":true } ] }
```

```json
// → resolve an issue (id required) → updated flattened issue with status "resolved"
{ "jsonrpc":"2.0","id":79,"method":"sentry.resolveIssue","params":{ "id":"1" } }
// ← response
{ "jsonrpc":"2.0","id":79,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"resolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → assign an issue; omit `assignedTo` to unassign
{ "jsonrpc":"2.0","id":80,"method":"sentry.assignIssue","params":{ "id":"1","assignedTo":"user-1" } }
// ← response (updated flattened SentryIssueResult)
{ "jsonrpc":"2.0","id":80,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → a write with a missing/empty `id` → -32602
{ "jsonrpc":"2.0","id":81,"method":"sentry.resolveIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":81,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

## 6. Events & Subscriptions

Live event streaming is the **canonical** way a thin client stays in sync. It uses twoserver-handled methods (the plural `events.` prefix) plus a server-pushed notification.

### 6.1 `events.subscribe`

```json
// → request
{ "jsonrpc":"2.0","id":60,"method":"events.subscribe",
  "params":{ "eventTypes":["agent:*","note:*"], "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":60,"result":{ "subscriptionId":"ws-sub-1" } }
```

Params:

- `eventTypes` (req) — **non-empty array** of event-type strings. Empty/missing → error(`-32602` over the wire). Supports exact types (`note:updated`) and `:*`** wildcards**(`agent:*`, `file:*`) — see §6.4.
- `workspaceId?` — scopes delivery to one workspace. Omit to receive matching events across allworkspaces the connection can see.
- `replaceGroup?` — if set, any existing subscription from the **same connection** with the same`replaceGroup` is removed first (useful for "switch the active workspace" without leaking subs).

A connection may hold **multiple** subscriptions. Each is identified by a server-assigned`subscriptionId` (`ws-sub-<n>`). Subscriptions are **per-connection** and are dropped on disconnect.

### 6.2 `events.unsubscribe`

```json
{ "jsonrpc":"2.0","id":61,"method":"events.unsubscribe","params":{ "subscriptionId":"ws-sub-1" } }
// ← { "jsonrpc":"2.0","id":61,"result":{ "success": true } }
```

`success` is `false` if the subscription id is unknown for this connection.

### 6.3 `events.event` notification (server → client)

Matching events are pushed as JSON-RPC **notifications** (no `id`):

```json
{ "jsonrpc":"2.0","method":"events.event","params":{
  "subscriptionId":"ws-sub-1",
  "event":{
    "type":"note:updated",
    "workspaceId":"ws-abc",
    "id":"evt-789",
    "timestamp":"2026-06-17T04:35:04.055Z",
    "actor":{ "type":"agent","id":"agent-123","name":"Coordinator" },
    "data":{ "noteId":"spec","action":"update","path":"spec.md" }
  } } }
```

The `event` object carries exactly: `type`, `workspaceId`, `id`, `timestamp`, `actor`, `data`.If one event matches several of a client's subscriptions, the client receives **one notificationper matching subscription** (each tagged with its `subscriptionId`). Clients should de-dupe on`event.id` when they hold overlapping subscriptions.

### 6.4 Filter semantics

`eventTypes` is compiled to a type filter (and an optional `workspaceId` equality filter):

- **Single exact type** → equality match.
- **Multiple exact types** → membership (`in`) match.
- **Single **`prefix:*` → `starts_with "prefix:"`.
- **Multiple wildcards / mixed wildcard+exact** → a regex anchored match combining the prefixesand exact types.

All filters on a subscription are combined with **AND**. Delivery is gated *only* by this filtermatch — the bridge does not maintain any additional allow/deny list.

### 6.5 Event taxonomy

`actor.type` is one of `user | agent | system | external | tool`. Common event types(`namespace:name`) a client will encounter:

| Namespace | Types (selected) | Notes |
| --- | --- | --- |
| file | file:changed, file:created, file:deleted, file:renamed | `file:changed` is the canonical type — discriminate on `data.action = create\|modify\|delete\|rename`. `file:created` and `file:deleted` are emitted by the watcher alongside `file:changed` (new in intentd); `file:renamed` is registered in the taxonomy but **reserved-but-unused** (no emitter today — `rename` is surfaced through `file:changed` with `data.action = rename`). |
| note | note:created, note:updated, note:deleted | data.noteId, data.action, data.path |
| task | task:status-changed, task:ready-tasks-changed | status + ready-task-id list |
| agent (lifecycle) | agent:started, agent:completed, agent:failed, agent:idle, agent:created, agent:deleted, agent:restored, agent:renamed, agent:status-changed |  |
| agent (messaging) | agent:message:sent, agent:message:received, agent:user-message:sent, agent:tool:call |  |
| agent (subscriptions) | agent:subscribed, agent:unsubscribed, agent:woken-by-subscription, agent:delivery-confirmed, agent:event-delivery-failed/-timeout, agent:subscriptions-restored/-changed, agent:message:delivery-failed |  |
| agent (streaming) | agent:stream:start, agent:stream:chunk, agent:stream:content-blocks, agent:stream:message, agent:stream:tool_use, agent:stream:tool_result, agent:stream:end | see §7 |
| agent (queue) | agent:queue:updated, agent:queue:processing, agent:queue:processing-cancelled, agent:queue:stale-message |  |
| workspace | workspace:created, :updated, :deleted, :opened, :closed, :activity, :activity-changed, :attention-changed | :activity-changed → data { workspaceId, activity }; :attention-changed → data { workspaceId, attention }. New in intentd; self-sufficient payloads (§6.7) |
| spec/goal | spec:updated, goal:updated |  |
| comment | comment:added, comment:resolved | `comment:resolved` is emitted by `comment.resolveThread` (§5.3); self-sufficient payload `{ noteId, threadId, resolved }` lets a client flip the thread's resolved state without a follow-up read. |
| pr (new in intentd) | pr:linked, pr:updated, pr:unlinked | Emitted **only on change** by the background / on-demand PR refresh. Self-sufficient payloads: `pr:linked` → `{ workspaceId, prNumber, prUrl, prStatus, activePullRequest }`, `pr:updated` → `{ workspaceId, prNumber, prStatus, activePullRequest }`, `pr:unlinked` → `{ workspaceId }`. |
| agent (permission, new in intentd) | agent:permission:request, agent:permission:resolved | The interactive permission flow (§8). `agent:permission:request` carries the normalized `PermissionRequestData`; `agent:permission:resolved` carries the chosen outcome (`selected`/`cancelled`). Both are scoped to the agent (`sessionId == agentId`). |
| settings (new in intentd) | settings:changed | Emitted after settings.update (§5.12). data = { changes: [{ path, value }] }; sensitive values are redacted. New in intentd — not part of the ported reference taxonomy. |
| mcp | mcp:notification | data.topic, payload. The agent→BE MCP callback (IMPLEMENTATION_SPEC.md §6.8) — distinct from the `mcp.servers.*` lifecycle surface. |
| mcp.servers (new in intentd) | mcp.servers:status-changed | Health/lifecycle of **external** MCP servers (§5.22). data = { serverId, status: McpServerStatus }. Emitted on every state transition; self-sufficient payload (§6.7). |
| git / terminal / test / build | git:, terminal:command, test:, build:* | Reserved-but-unused in the reference impl — subscribing yields zero events today. |
| git.clone (new in intentd) | git:clone:progress, git:clone:done | Streaming `git.clone` (§5.6), correlated by `data.requestId`. `git:clone:progress` → `data { requestId, phase, percent, message }` where `phase ∈ { starting, counting, compressing, receiving, resolving, checkout, complete }` and `percent` is `0..=100`. `git:clone:done` → `data { requestId, ok, error? }`; `error` is present iff `ok == false` and never carries the source URL or credentials. |
| terminal (new in intentd) | terminal:data, terminal:exit, terminal:title, terminal:cwd | Live PTY streaming (§5.13). data.chunk (terminal:data) is base64. |
| script (new in intentd) | script:output, script:state | Live script streaming (§5.8); shared PTY host. data.chunk (script:output) is base64. |
| search (new in intentd) | search:result, search:done | Streaming search results (§5.15), correlated by data.requestId. search:result → data { requestId, matches }; search:done → data { requestId, total, truncated }. |
| drafts (new in intentd) | draft:changed | Emitted after drafts.set / drafts.clear (§5.16). data = { workspaceId, agentId, clientId, hasDraft }; **no draft text** (no leakage). |
| changes (new in intentd) | changes:tracked, changes:git-status, changes:metrics-changed | Code Changes Review (§5.18–§5.20). `changes:tracked` → data { workspaceId, changes: TrackedChange[] } (emitted as the BE records attribution internally — there is no `file-tracking.trackChange` RPC). `changes:git-status` → data { workspaceId, status: WorkspaceGitStatus }. `changes:metrics-changed` → data { workspaceId, agentId?, metrics: Metrics }. Self-sufficient payloads (§6.7). |
| workspace usage (new in intentd) | workspace:tokenUsage-changed | Token/credit usage recomputed by the internal scan job (§5.23). data = { workspaceId, tokenUsage: TokenUsage }. Self-sufficient payload (§6.7). |
| agent stats (new in intentd) | agent:session-stats-changed | Per-session usage changed (§5.24). data = { sessionId, agentId?, stats: SessionStats }. Self-sufficient payload (§6.7). |

### 6.6 Batching window

`events.subscribe` accepts a `batchWindow` hint on the deprecated `agent.*`/`event.*` aliases; thecanonical bridge delivers each accepted event **individually** as it is accepted (no server-sidecoalescing on the WS bridge). Clients that need coalescing should debounce on their side, keyed by`event.type` + the relevant id in `data`.

### 6.7 Event-design rule: self-sufficient payloads *(new in intentd)*

New event types SHOULD carry a **self-sufficient payload** — the changed entity or field — so a
thin client can update its local state **directly from the event, with no follow-up fetch**. The
intentd status events follow this rule:

- `workspace:activity-changed` → `{ workspaceId, activity }` (derived green-dot state)
- `workspace:attention-changed` → `{ workspaceId, attention }` (dismissible blue-dot state)

Each is emitted **only on change** and carries the new value, so the FE re-renders the
green/blue dot immediately without a `workspace.get` round-trip. The existing WS event stream
(`agent:*`, `task:*`, `pr:*`, `note:*`, …) is **unchanged** and remains the UI's primary feed;
this rule is guidance for new event types, not a change to existing ones. (Incremental token
streams like `agent:stream:chunk` stay UI sugar — §10.1 — the rule applies to state-change
events, not partial deltas.) See IMPLEMENTATION_SPEC.md §10 (Events).

### 6.8 Cross-cutting principle: autonomous backend work surfaces via events, not RPC *(new in intentd)*

Work the backend performs **on its own** — as agents and pipelines run — is **not** exposed as a
client RPC. It runs internally and reaches the thin client through **events** (and as fields on
read responses), following the self-sufficient-payload rule (§6.7). Concretely, these have **no
wire method**:

- **Agent-attribution tracking** (`file-tracking.trackChange`) — recorded as agents edit files;
  surfaced via `changes:tracked` and the `file-tracking.*` reads (§5.19).
- **Diff computation/versioning** (`diffs.*`) — computed/stored internally; diff bodies reach the
  client only through `file-tracking.*` reads and change events (§5.18 schemas note).
- **Metrics aggregation** (`metrics.calculate`, the `update*` writers, agent-active tracking) —
  computed as work happens; surfaced via `changes:metrics-changed` and the metrics **reads**
  (§5.20).

Clients **read** current state and **subscribe** to changes; they never invoke the internal
writers. This keeps the FE thin: it reflects backend-owned state rather than driving it. See
IMPLEMENTATION_SPEC.md §9 (state model) and §10 (Events).

### 6.9 Snapshot+delta subscription channels *(new in intentd)*

The `events.subscribe` firehose (§6.1) carries every bus event; a thin client that needs **structured live state for a specific entity family** subscribes to a typed channel instead. Each channel is intercepted on the transport fast-path **before** the JSON-RPC dispatcher (alongside `events.subscribe` and `system.*`), returns a `{ subscriptionId }` ack, then pushes a seq-0 **snapshot** followed by ordered **deltas** as `subscription.push` notifications (§3.3). The firehose stays unchanged and **coexists** with these channels.

| Method | Channel | Scope | Snapshot shape (seq 0) | Notes |
| --- | --- | --- | --- | --- |
| `note.subscribe` / `note.unsubscribe` | note | per-workspace (`workspaceId` req — `-32602` if missing/empty) | array of `Note` entities (newest-first) | `note:created`/`updated`/`deleted` → `added`/`updated`/`removedIds` via a re-read of the entity. |
| `task.subscribe` / `task.unsubscribe` | task | per-workspace (`workspaceId` req) | array of `WorkspaceTask` entities | tails `task:status-changed`/`task:ready-tasks-changed`. |
| `workspace.subscribe` / `workspace.unsubscribe` | workspace | global (no `workspaceId`) — the only global channel | array of `Workspace` entities visible to the connection | tails `workspace:created`/`updated`/`deleted`/`activity-changed`/`attention-changed`. |
| `comment.subscribe` / `comment.unsubscribe` | comment | per-workspace (`workspaceId` req); `noteId` optional narrowing | array of `Comment` entities | tails `comment:added`/`resolved`. |
| `agent.subscribe` / `agent.unsubscribe` (no `eventTypes`) | agent | per-workspace (`workspaceId` req) | array of `AgentLite` entities | **Disambiguated by params** from the deprecated service-alias `agent.subscribe` of §5.5: an `eventTypes`-bearing frame falls through to the router (alias); a bare `{ workspaceId }` frame routes to this collection channel. Likewise `agent.unsubscribe` without `workspaceId` is the channel form. |
| `chat.subscribe` / `chat.unsubscribe` | chat | per-agent (`agentId` req — `-32602` if missing/empty) | newest `agent.getConversation` page, plus a synthetic in-flight assistant message when one is streaming | The structured alternative to the `agent:stream:*` firehose (§7.1). |

**Frame shapes.** Every push is a JSON-RPC notification with method `subscription.push`:

```json
// seq-0 snapshot
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-1","kind":"snapshot","seq":0,
  "snapshot":[ /* entities */ ] } }

// delta (seq 1, 2, …)
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-1","kind":"delta","seq":1,
  "delta":{ "added":[…], "updated":[…], "removedIds":[…] } } }
```

`added`/`updated`/`removedIds` are each present only when non-empty; the **invariant** is that the seq-0 snapshot reduced with every delta (honoring `removedIds`) equals a fresh full read of the channel. `*.unsubscribe` takes `{ subscriptionId }` and returns `{ success }` (`false` if the id is unknown for this connection). Subscriptions are **per-connection** and are dropped on disconnect.

`note` and `task` entities carry an explicit `rev` (the optimistic-concurrency version, §4); `workspace`, `comment`, `agent`, and `chat` entities deliberately do **not** carry `rev`.

## 7. Agent Streaming

Agent assistant output is delivered as the `agent:stream:*` event family (subscribe with`events.subscribe(["agent:stream:*"])`, optionally scoped by `workspaceId`). The backend maps aprovider's streaming signals to these canonical event types.

The backend currently emits **three** signals in production; the remaining `agent:stream:*`
event types are defined as constants (and registered in `ALL_EVENT_TYPES`) but have **no
production emit site** today and are reserved for future use.

**Emitted today:**

| Provider signal | Event type | data payload |
| --- | --- | --- |
| text token(s) | agent:stream:chunk | { agentId, content, messageId, blockIndex, blockId, blockType, streamId? } — incremental assistant text, enriched with the §7.1 block-identity fields (`messageId`/`blockIndex`/`blockId`/`blockType`) |
| tool call | agent:tool:call | the single tool signal; §7.1 `chat.subscribe` tails it to synthesize `tool_use` / `tool_result` blocks |
| complete or error | agent:stream:end | { agentId, content, streamId? } |

**Reserved / not currently emitted** — the following constants exist and are registered in
`ALL_EVENT_TYPES`, but the backend does **not** emit them today:

| Event type | intended meaning |
| --- | --- |
| agent:stream:start | stream start |
| agent:stream:content-blocks | structured blocks (e.g. thinking / tool-call) |
| agent:stream:message | assistant message |
| agent:stream:tool_use | tool call |
| agent:stream:tool_result | tool result |

Structured consumers should prefer the §7.1 `chat.subscribe` channel (the canonical structured
transcript) over reconstructing turn state from the firehose.

Notes for client implementers:

- **Ordering.** Events for one agent arrive in emission order over a single connection. Correlate astream with `data.agentId` (and `data.streamId` when present). Tool-call activity arrives as the single `agent:tool:call` event interleaved with `chunk` text; the §7.1 `chat.subscribe` channel synthesizes ordered structured blocks from these signals.
- **Terminal event.** `complete` and `error` are mutually exclusive and **both** map to`agent:stream:end` — there is exactly one terminal event per stream. Today the payloads areidentical by design; a client treats `stream:end` as "this turn is done" and then re-fetches theauthoritative transcript via `agent.getConversation` if it needs the final, persisted message.
- **Dedup.** The same agent output is also persisted; the live `agent:stream:chunk` text is*incremental UI sugar*. Canonical state is the persisted conversation. After `stream:end` (or onreconnect) call `agent.getConversation` rather than reconstructing solely from chunks. Usermessages echo cross-client as `agent:user-message:sent` (carrying a stable `messageId`) so otherclients can de-dupe their own optimistic insert.
- **Sending input.** Use `agent.sendMessage` (auto-queues if the agent is mid-stream),`agent.queueMessage` to explicitly enqueue, or `agent.forceMessage` to interrupt the currentstream and deliver immediately. `agent.stop` cancels an in-flight stream.

### 7.1 `chat.subscribe` — structured live transcript channel *(new in intentd)*

The `agent:stream:*` firehose (above) stays UI sugar (§10.1): a joiner that misses earlier chunks
cannot reconstruct the turn, and the client must re-fetch `agent.getConversation` after every
`stream:end`. `chat.subscribe` is the **canonical** alternative — an **agent-scoped** channel on the
snapshot+delta subscription engine (§6, TB-0) that delivers a self-healing transcript a thin client
can render directly, with **no follow-up fetch**. It **coexists** additively with the firehose: both
observe the same bus, and `events.subscribe(["agent:stream:*"])` is unchanged.

- **Methods:** `chat.subscribe` / `chat.unsubscribe`, intercepted on the subscription fast-path
  before the JSON-RPC dispatcher (like `events.subscribe`). `params` is `{ agentId }` — a
  missing/empty `agentId` is a `-32602` error. `chat.subscribe` returns `{ subscriptionId }`, then
  pushes a seq-0 `subscription.push` **snapshot**, then ordered **deltas** (seq 1, 2, …).
  `replaceGroup` (atomic swap) and per-connection cleanup behave as for the other channels (§6.1).
- **Snapshot granularity = messages; delta granularity = blocks.** The seq-0 snapshot is the newest
  `agent.getConversation` page as the `messages[]` object (the same read shape, reused verbatim).
  Each subsequent delta upserts individual **content blocks** within a message.
- **Stable block ids.** Every assistant block carries a synthetic `id` of `{messageId}:{blockIndex}`
  (the assistant message UUIDv7 minted at turn start + the 0-based index in the coalesced block
  array). Snapshot blocks and live deltas derive the same id, so deltas patch the snapshot exactly.
- **Mid-turn (re)subscribe.** When a turn is streaming, the seq-0 snapshot appends a synthetic
  in-flight `assistant` message (`isStreaming: true`) whose `contentBlocks` are the current partial
  blocks, so a subscriber arriving mid-turn renders a coherent partial rather than a gap. The
  terminal delta clears it to `streamingComplete: true`.

**Delta envelope.** Reuses the frozen `{ added, updated, removedIds }` envelope with content blocks
as the id-bearing entities. Each entity carries the **full current block** (not a text diff) plus a
`{ agentId, messageId, role }` pointer (and `messageSeq` + `timestamp` on the authoritative terminal
frame):

- `added` — a block's first appearance this turn (e.g. a text block's first chunk, or a `tool_use`).
- `updated` — an existing block grown/changed, matched by `id` (e.g. each subsequent text chunk
  carries the full accumulated text; full-block replace is idempotent under re-delivery).
- `removedIds` — a block emitted **live** that the finally-persisted message does **not** contain.
  This is non-empty only for orphan self-heal: e.g. a trailing partial the durable turn dropped, or
  a mispredicted `tool_result` index. Clients **must** honor it when reducing deltas onto the
  snapshot.

**Tool blocks.** The channel tails the single `agent:tool:call` event and synthesizes TS-shaped
blocks matching the persisted transcript: a `tool_use` block (`{ type, id, name, input, toolCallId,
metadata:{ toolKind, status } }`) and, once the same call completes **with** output, a `tool_result`
block (`{ type, id, tool_use_id, output, is_error }`).

**Terminal reconcile (the invariant).** On `agent:stream:end` the channel re-reads the now-persisted
message and emits a terminal delta (every persisted block as `updated`, or `added` if never seen
live, carrying the authoritative `messageSeq`/`timestamp`/`streamingComplete:true`, plus
`removedIds` for any orphaned live block). The guarantee: **the seq-0 snapshot reduced with every
delta — honoring `removedIds` — equals a fresh `agent.getConversation` snapshot.**

#### seq-0 snapshot (`subscription.push`, messages page)

```json
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-7","kind":"snapshot","seq":0,
  "snapshot":{
    "agentId":"agent-123",
    "messages":[
      { "id":"0190a1b2-user","agentId":"agent-123","seq":0,"role":"user",
        "contentBlocks":[ { "type":"text","id":"0190a1b2-user:0","text":"Run the tests" } ],
        "timestamp":"2026-06-27T01:00:00.000Z" }
    ],
    "truncated":false,"totalMessages":1,"nextToken":null } } }
```

#### delta frame (in-flight block upsert)

```json
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-7","kind":"delta","seq":6,
  "delta":{
    "added":[],
    "updated":[
      { "agentId":"agent-123","messageId":"0190a200-asst","role":"assistant",
        "block":{ "type":"text","id":"0190a200-asst:0","text":"Let me check the logs first." } }
    ],
    "removedIds":[] } } }
```

A block's first appearance arrives as `added` with the same `block.id`; each growth is an `updated`
carrying the **full** block. A tool call arrives as an `added` `tool_use` block, then a `tool_result`
block once output lands. The terminal frame (after `agent:stream:end`) carries the persisted blocks
with `streamingComplete:true` and any orphan ids in `removedIds`.

## 8. Permission Flow

When an agent's provider (e.g. auggie) wants to run a tool that requires approval, it sends an ACP`session/request_permission` request **to the backend** (over the provider's stdio channel, not theclient WebSocket). The backend mediates approval:

1. **Bypass / auto-approve.** For non-interactive providers running in `bypassPermissions` mode (orwhen the provider can't set a mode), the backend auto-selects an "allow" option and respondsimmediately — no client involvement.
2. **Interactive.** Otherwise the backend **blocks the agent's stream** and surfaces a permissionrequest to the frontend. In the Electron reference this is an IPC push to the renderer; a Rustbackend exposing this over the wire would push it to subscribed clients and await a response.

> **Implementation status.** The interactive *answer* and *recovery* RPCs are now **wired** in
> `intentd`. `agent.respondPermission { requestId, outcome }` → `{ resolved: bool }` forwards the
> chosen outcome to the blocked provider — `resolved` is `false` when no matching pending prompt
> exists, and a malformed `outcome` shape is rejected as **`-32602`**. `agent.pendingPermissions
> { agentId? }` → `{ requests: [...] }` snapshots the outstanding prompts (optionally filtered to a
> single `agentId` = `sessionId`) so a reconnecting client can re-fetch them. Both reach
> `PermissionRegistry::resolve()` / `::pending()` via `AgentManager` → `WorkspaceApi` / `Services`
> → the `agent.*` router. The normalized request payload, options normalization, `riskLevel`
> heuristic, outcome shape, and 5-minute timeout are implemented as described.
>
> **Default policy.** The production default is now **`AutoByRisk`** (auto-allow low-risk / reads,
> auto-deny medium/high), selectable at runtime via **`INTENTD_PERMISSION_POLICY`**
> (`interactive|auto|allow|deny`, default `AutoByRisk`). An **`Interactive`** deployment instead
> blocks the agent's stream and surfaces each prompt via `agent.pendingPermissions`, resolving it
> via `agent.respondPermission` (still bounded by the 5-minute timeout when left unanswered).
> **`AllowAll`** and **`DenyAll`** remain available for fully-headless deployments.

The normalized permission request payload is:

```json
{
  "requestId": "perm_1718600000000_1",
  "sessionId": "agent-123",
  "title": "Run command",
  "description": "Tool input: { \"command\": \"npm test\" }",
  "options": [
    { "id": "allow_once", "label": "Allow", "description": null, "destructive": false },
    { "id": "reject_once", "label": "Deny", "destructive": true }
  ],
  "agentName": "auggie",
  "riskLevel": "high",
  "timestamp": 1718600000000
}
```

- `options` are normalized from both ACP (`id`/`label`) and auggie (`optionId`/`name`) shapes. If aprovider sends none, the backend defaults to `allow_once` / `reject_once`.
- `riskLevel` (`low|medium|high`) is heuristically derived from the title (read/list → low;delete/execute/write/create → high).
- `sessionId` equals the `agentId`, so a client can route the prompt to the right agent view.

The frontend responds with the chosen outcome, which the backend forwards to the provider as the`session/request_permission` result:

```json
{ "requestId": "perm_1718600000000_1", "outcome": { "outcome": "selected", "optionId": "allow_once" } }
```

Outcomes: `{ "outcome": "selected", "optionId": "<id>" }`, or `{ "outcome": "cancelled" }`.Unanswered requests **time out after 5 minutes** and resolve as `cancelled`, unblocking the agent. The recoverability path (a reconnecting client re-fetching outstanding prompts via `agent.pendingPermissions` so a page refresh does not strand the agent) is **now wired** — see the implementation note above.

## 9. Error Codes

Errors use the standard JSON-RPC 2.0 `error` object `{ code, message, data? }`.

| Code | Name | When |
| --- | --- | --- |
| -32700 | Parse error | Body is not valid JSON. Always answered (id null), even for would-be notifications. |
| -32600 | Invalid Request | Not an object, jsonrpc !== "2.0", missing/empty method, or bad id type. |
| -32601 | Method not found | Unknown method (only for requests; unknown notifications are dropped). |
| -32602 | Invalid params | Missing required param ("Missing required parameter: <name>"), bad workspaceId ("workspaceId is required"), non-array where an array is required, "not found" lookups, unauthorized repoPath, etc. |
| -32603 | Internal error | Underlying service threw. message is "Internal error" with the original message in data for unexpected throws; many shims pass the underlying message through as message directly. |
| -32005 | Conflict | Optimistic-concurrency failure: a conditional write's `expectedVersion` did not match the entity's current `rev`. `error.data = { code: "conflict", current }` carries the current entity so the client can reconcile (note conditional writes; §4, §5.6). |

The only custom numeric code outside the standard `-327xx` range is `-32005` (Conflict, above); other server-specificconditions (e.g. "not a delegated agent", "path outside workspace", "staging `.` is blocked") arereported as `-32602`/`-32603` with a descriptive `message`. Notification-shaped requests (no `id`)never receive an error response except for parse/invalid-request failures detected before thenotification status is known.

## 10. Thin-Client Guidance

The backend is the **single source of truth**; clients should hold only ephemeral UI state.

### 10.1 Canonical state lives in the backend

Never treat streamed deltas as authoritative. `agent:stream:chunk` text, optimistic note edits, andlocal task toggles are **UI sugar** — the persisted entity (fetched via `note.get`,`agent.getConversation`, `note.listTasks`, …) is canonical. Reconcile to it after each mutation/turn.

### 10.2 Subscribe-then-fetch

1. Connect + authenticate (§2), pin the cert (§1.2).
2. `events.subscribe` for the slices you render (e.g. `["note:*","task:*","agent:*"]`) **before**fetching, so no change is missed in the gap.
3. Fetch the current state (`workspace.get`, `note.list`, `agent.list`, …).
4. Apply incoming `events.event` notifications to your local cache; de-dupe on `event.id`.
5. On reconnect, **re-subscribe and re-fetch** — subscriptions do not survive disconnects.

### 10.3 Optimistic UI

For mutations, optimistically apply locally, send the request, and reconcile when (a) the methodresult returns and (b) the corresponding `events.event` arrives. Roll back on error. Use the stable`messageId` you pass to `agent.sendMessage` (and the echoed `agent:user-message:sent` event) tomatch your optimistic message against the canonical one and avoid duplicates across clients.

### 10.4 Minimal client session walkthrough

```text
1.  resolve _intent-ws._tcp  → host:port, fp=AB:CD:...        (mDNS, §1.3)
2.  WSS connect wss://host:port/ws  (pin fp)                  (§1.2)
        Authorization: Bearer <token>                        (§2.1)
3.  → events.subscribe { eventTypes:["agent:*","note:*","task:*"], workspaceId:"ws-abc" }
    ← { subscriptionId:"ws-sub-1" }                          (§6.1)
4.  → workspace.get { workspaceId:"ws-abc" }   ← { workspace }
    → note.list      { workspaceId:"ws-abc" }   ← { notes }
    → agent.list     { workspaceId:"ws-abc" }   ← { agents }
5.  → agent.sendMessage { workspaceId, agentId:"agent-123", content:"Fix the build", messageId:"m1" }
    ← { success:true, queued:false, messageId:"m1" }         (§5.5)
6.  ← events.event agent:stream:start  / :chunk* / :tool_use / :tool_result / :end   (§7)
7.  → agent.getConversation { agentId:"agent-123" }  ← { messages, ... }   (reconcile, §10.1)
8.  (permission prompt, if any) ← request_permission → respond selected/allow_once  (§8)
9.  on disconnect: reconnect, re-auth, repeat from step 3.   (§4)
```

*Generated as a wire-protocol reference for the Intent Rust backend. For architecture, persistence,ACP/GitHub integration, and the phased build plan, see*`./IMPLEMENTATION_SPEC.md`*.*