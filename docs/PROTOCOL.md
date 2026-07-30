# Intent Backend — JSON-RPC Protocol v2.7

**Protocol Version:** `2.7`

This document is the canonical wire contract between Intent clients (desktop, iOS, CLI, and agent developers building clients) and the Intent backend daemon (`intentd`): transport, JSON-RPC envelope, the full method catalog, events, agent streaming, the permission flow, error codes, and thin-client guidance. It is a **living specification**: changes land through the compatibility policy below, and the method surface is enforced by golden tests in the `intent-transport` crate.

## Table of Contents

- [Protocol Version & Compatibility](#protocol-version--compatibility)

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

## Protocol Version & Compatibility

**Version:** `2.8`

Version 2.1 was an **additive** minor bump over 2.0: it added the `pr.capabilities` router method and the provider capability gating described in §5.7. Version 2.2 is an **additive** minor bump over 2.1: it adds the `system.importLegacy` fast-path method (UDS-only — see the §5 fast-path catalog). Version 2.3 is an **additive** minor bump over 2.2: it adds the `system.capabilities` **router** method (available on both UDS and WSS — unlike the UDS-only `system.*` fast-path controls; see the §5 fast-path notes). Version 2.4 is an **additive** minor bump over 2.3: it adds the `github.repoConfig.get` router method (§5.27) — a remote repository's `.intent/config.json` fetched via the GitHub contents API without a clone. Version 2.5 is an **additive** minor bump over 2.4: it adds the `system.gitCredential` fast-path method (UDS-only — see the §5 fast-path catalog), the daemon-backed git-credential endpoint consumed by the `intentd git-credential` helper (monorepo#884), and the `unsloth.status` / `unsloth.stop` router methods (§5.37) — observability and control for the daemon-managed singleton Unsloth server (monorepo#878 follow-up). Version 2.6 is an **additive** minor bump over 2.5: it adds the `providers.catalog` router method (§5.38) — the static provider registry served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. Version 2.7 is an **additive** minor bump over 2.6: it adds the `workspace.getAutoCommit` / `workspace.setAutoCommit` router methods (§5.1) — the persisted per-workspace auto-commit override resolved against the global `git.autoCommit` setting. Version 2.8 is an **additive** minor bump over 2.7: it adds the `agent.dismissQuestions` router method and the derived **question hold** on automatic deliveries (§5.5, question hold; intentd#751) — held sends surface the additive `heldForQuestions: true` result field and queue entries surface the additive `interruptPriority?: true` wire field. No existing method changed shape in any of these bumps.

The protocol version is advertised in two places:

- `client.hello` response: `{ protocolVersion: "2.8", server: { protocolVersion: "2.8", ... }, ... }` — the top-level `protocolVersion` is an explicit copy of `server.protocolVersion` so clients can version-check without digging into the `server` block (§5.17).
- `system.status` response: `{ protocolVersion: "2.8", ... }`

### Compatibility Policy

- **Additive changes** (new methods, new optional fields, new event types) bump the **minor** version (e.g., 2.0 → 2.1).
- **Breaking changes** (removed methods, changed signatures, renamed fields) bump the **major** version (e.g., 2.0 → 3.0).

The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`. Any drift (added, removed, or renamed methods) causes CI failure with the instruction: "update `catalog.rs` + `docs/PROTOCOL.md` and bump the protocol version." Additive response fields on an existing method (e.g., the optional `system.status` resource fields, §5 fast-path notes) do not change the golden-test-enforced catalog and ship within the current version; clients must detect them by **presence**, not by protocol version.

## 1. Transport

### 1.1 Connection URL

When the WS API is enabled (`server.wsApi.enabled` — see the §1.1 UDS note below), the backend runs a dedicated **HTTPS server bound to `0.0.0.0`** (LAN-reachable) exposing a single WebSocket endpoint:

```
wss://<host>:<port>/ws
```

- **Default port:** `5181` (fixed — no port walking, no same-port backoff). The listener binds exactly this port. In the secure posture a WSS bind failure at boot is **non-fatal**: the daemon logs a warning and keeps serving UDS (`server.wsApi.enabled` stays true; toggle it to retry), and a runtime toggle-on bind failure surfaces as a `settings.update` error. Only the insecure dev listener (`--insecure`) treats a bind failure as fatal — the daemon exits non-zero with the OS bind error. Clients still SHOULD obtain the port from the QR/manual pairing payload (rendered on the daemon host via the local-only `pairing.getInfo`, §5, or `intentd token`) or a well-known override rather than hard-coding it, since the operator may reconfigure `server.wsApi.port` (or its `INTENTD_TCP_PORT` env override).
- **Scheme:** `wss://` (TLS) in the default secure posture — there is no plaintext `ws://` listener unless insecure dev mode is opted into. With `serve --insecure` (or `INTENTD_INSECURE=1`) the daemon serves plain `ws://` with TLS and bearer-token enforcement skipped; this is a development-only posture (`make dev-daemon` uses it) and logs a prominent startup warning.
- A plain HTTPS `GET /health` returns `{"status":"ok","clients":<n>}` for liveness probing.
- Any path other than `/ws` is rejected at upgrade time (socket destroyed).

> Unix-domain socket: The daemon **always** serves a UDS transport as the local-first default; the TCP/WSS listener is optional and toggled at runtime by the `server.wsApi.enabled` setting (the former `server.listenMode` setting and `--listen` serve flag are retired). The JSON-RPC envelope, method catalog, and event semantics are **identical** across UDS and TCP/TLS — only the listener differs. `system.status` reports a derived `listenMode` field (`"both"` while the WSS listener is up, `"uds"` otherwise) reflecting the live listener state.

### 1.2 TLS & fingerprint pinning

The server generates a **self-signed** EC (P-256) certificate on first start, persists it under the app's data directory (`ws-cert.pem` / `ws-key.pem`), and reuses it across restarts (10-year validity). Because it is self-signed, **clients pin the certificate** rather than relying on a CA:

- The server exposes a **SHA-256 fingerprint**, colon-separated uppercase hex (e.g. `AB:CD:EF:...`), computed over the DER body of the cert.
- Certificate SANs include `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 address on the host (LAN, Tailscale, etc.), so connecting by hostname or LAN IP validates against the SAN.
- Clients should **pin the fingerprint** (obtained out-of-band during pairing — the pairing payload carries it as `fp=`) and reject any cert whose fingerprint does not match.

### 1.3 Message size limit

Inbound JSON-RPC messages are capped at **40 MiB** (`MAX_INBOUND_MESSAGE_BYTES = 40 * 1024 * 1024` in `intent-transport`). The limit is the same on both transports; the behavior on violation differs by framing:

- **WSS:** the limit is enforced on both the WebSocket frame size and the total message size, and the connection is closed on violation. The daemon attempts to send a close frame with code **1009 (Message Too Big)** before terminating. Delivery of the close frame is best-effort: a single over-limit frame fails fast on the frame header (its payload is not buffered), and the connection teardown may race with the client's in-flight write, so the client may not observe the close frame; a fragmented message is rejected once its accumulated fragments exceed the cap (so up to the limit may be buffered before rejection), and in that case the client typically does receive the 1009 close frame.
- **UDS:** the daemon replies with a `-32600` error (`id: null`, since the request was never parsed) and then closes the connection, without draining the rest of the oversized line.

Outbound (server→client) messages are not subject to this limit.

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

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients never send one), `file://` (desktop app renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's own hostname / `.local` form (so LAN clients connecting by advertised hostname pass).
- **Rejected (**`403`**):** `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

### 2.3 Where the token lives

The token and the API-enabled flag are persisted in the daemon's settings store. Clients obtain the token out-of-band via a pairing flow (the daemon surfaces token + fingerprint together — see also `pairing.getInfo` in the §5 fast-path catalog). An operator can run `intentd token` to print the current bearer token and TLS certificate fingerprint together for pairing (and `intentd token --rotate` to regenerate the token).

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

`error.data` is optional and carries extra context — for `-32603` it may carry the original internal error message (not guaranteed: many shims pass the underlying message through as `message` directly — §9), and some errors attach a structured machine-readable payload (e.g. the `-32005` conflict object, or the `workspace.create` base-ref failure data). See §9 for the code table.

### 3.4 Notifications (no response)

A request **without an **`id`** member** is a notification: the server processes it and returnsnothing. Note the distinction required by JSON-RPC 2.0:

- `id` **absent** → notification → no response is ever sent (even on error / unknown method).
- `id: null` **present** → a normal request that **must** receive a response.

Unknown methods sent as notifications are silently ignored; unknown methods sent as requests get`-32601 Method not found`.

### 3.5 Batching

The server processes **one JSON-RPC object per WebSocket text frame**. JSON-RPC batch *arrays* are **not** supported as a batch unit: a top-level array fails envelope validation (`-32600 Invalid Request: expected an object`). Clients should send one message per frame and correlate responses by `id`. (Independent requests can be pipelined — the server does not require request/response lock-step — but each must be its own frame.)

### 3.6 `workspaceId` scoping

Most methods operate within a workspace. `workspaceId` is read from `params.workspaceId`, fallingback to a connection-level context value if the transport provides one. If neither is present, themethod returns `-32602 "workspaceId is required"`. The workspace/repo/specialist/global methods(e.g. `workspace.list`, `repo.list`, `specialist.list`, `agent.getModels`) do not require it.

## 4. Heartbeat & Lifecycle

- **Ping/pong:** The server sends a WebSocket **ping every 30s** (`HEARTBEAT_INTERVAL_MS`). Theclient's transport must answer with a standard pong frame (handled automatically by compliantWebSocket libraries). If no pong is seen within **60s** (`HEARTBEAT_TIMEOUT_MS`), the serverterminates the connection and cleans up its subscriptions.
- **Server shutdown:** On graceful stop, clients are closed with code `1001`(`"Server shutting down"`) and all transport-local subscriptions are dropped.
- **Disconnect cleanup:** On `close` or socket `error`, the server removes the client and all ofits event subscriptions. Subscriptions are **per-connection** and do **not** survive reconnects.
- **Reconnection guidance:** Clients should reconnect with backoff, re-authenticate on the newupgrade, and **re-establish all subscriptions** (re-send `events.subscribe`). Because canonicalstate lives in the backend, after reconnect a client should **re-fetch** the entities it caresabout (subscribe-then-fetch, §10) rather than assuming it missed nothing.

## 5. Method Catalog

The API exposes **308 dispatchable method names** across the following categories:

- **Router methods:** 272 methods dispatched via the main router (`router::dispatch`)
- **Fast-path methods:** 34 methods intercepted before the router for performance or per-connection state
- **Method aliases:** 2 aliases accepted on the wire (`git.diff` → `git.diffs`, `git.log` → `git.commits`)

Additionally, the protocol includes:

- **Server→client notifications:** 1 notification (`events.event`, §6.3), plus the `subscription.push` frames of the snapshot+delta channels (§6.9)
- **Client-served reverse RPCs:** 4 methods (dual-role, counted within the 308 dispatchable names: `browser.exec`, `host.openExternal`, `host.openInEditor`, `host.pickApplication` — see §5.9 and §5.14)

**Total:** 308 dispatchable names + 1 notification. The 4 reverse-RPC names are dual-role: they are dispatchable client→server methods AND are also issued daemon→client as reverse RPCs on remote connections.

The method surface is enforced by the golden tests in `crates/intent-transport/src/catalog.rs`; the per-namespace subsections below (§5.1–§5.38) carry each method's parameter and result contract.

### Router methods by namespace (272 total)

| Namespace | Count | Methods |
| --- | --- | --- |
| agent | 39 | appendMessage, cancelSubscriptions, completeOnce, create, delegate, delete, diagnostics, dismissQuestions, editAndRegenerate, editQueuedMessage, enhancePrompt, get, getConversation, getModels, getQueue, getSession, getSessionStats, getSubscriptions, list, listInterrupted, pendingPermissions, queueMessage, removeQueuedMessage, rename, replaceMessages, reportToParent, resolveInterrupted, respondPermission, retry, sendMessage, sendQueuedMessageNow, sendToTask, setModel, stop, subscribe, summary, unsubscribe, update, wakeOrCreate |
| comment | 6 | add, delete, getThread, list, resolveThread, respond |
| crossWorkspace | 3 | listNotes, listSiblings, readNote |
| event | 5 | agentActivity, directoryChanges, query, recentFiles, workspaceSummary |
| file | 9 | delete, exists, list, mkdir, read, rename, stat, tree, write |
| git | 28 | agentCommit, branchDiff, branchStatus, changes, checkMergeConflicts, checkoutBranch, clone, commit, commitDetails, commits, createBranch, diffs, discard, fetch, getBranches, getConfig, getRemoteUrl, numstat, pull, push, removeLockFile, renameBranch, showFile, stage, stageHunk, status, unstage, unstageHunk |
| github | 23 | authStatus, branches.list, cancelAuth, connect, getReviewThreads, getUser, issues.list, issues.search, listReviewComments, pulls.create, pulls.get, pulls.list, pulls.merge, pulls.search, pulls.updateBranch, replyReviewComment, repoConfig.get, repos.get, repos.list, repos.search, resolveThread, revoke, unresolveThread |
| linear | 11 | authStatus, createIssue, getIssue, listIssues, listLabels, listProjects, listTeams, listWorkflowStates, searchIssues, updateIssue, viewer |
| mcp | 11 | oauth.delete, oauth.get, oauth.list, oauth.set, servers.create, servers.delete, servers.getStatus, servers.list, servers.restart, servers.toggle, servers.update |
| metrics | 4 | clearAgentStats, getAgentStats, getAllWorkspaceStats, getWorkspaceStats |
| models | 1 | list |
| note | 18 | add, create, delete, edit, editLines, get, getVersion, lineAttribution.computeNow, lineAttribution.load, list, listTasks, listVersions, readAsset, restoreVersion, saveAsset, setContent, update, updateMetadata |
| pr | 14 | capabilities, createReview, getReviews, listCheckRuns, listComments, listReviewComments, merge, postComment, refresh, replyToReviewComment, resolveThread, status, updateBranch, waitForChanges |
| primitive | 4 | addAgentAction, addCli, addPatch, addReference |
| providers | 1 | catalog — the static provider registry served over the wire (§5.38; v2.6, daemon-global — no `workspaceId`) |
| repo | 2 | list, remove |
| repoConfig | 4 | ensureDir, get, has, save |
| rules | 3 | get, list, update |
| sandbox | 2 | discard, merge |
| script | 9 | create, list, output, remove, restart, run, start, status, stop |
| search | 7 | cancel, codebase, events, fileNames, inFiles, messages, notes |
| sentry | 8 | assignIssue, authStatus, getIssue, ignoreIssue, listIssues, listProjects, resolveIssue, searchIssues |
| settings | 4 | get, list, reset, update |
| skill | 1 | list |
| specialist | 5 | create, delete, edit, get, list |
| stats | 1 | getUsage |
| system (router) | 1 | capabilities — machine-level capabilities, no workspaceId; distinct from the `system.*` fast-path controls below (v2.3, see the note after the fast-path catalog) |
| task | 14 | assignAgent, convertBlocks, createPrerequisite, get, getMyTask, linkAgent, list, listAgentLinks, markAsTask, removeAgentFromAllTasks, unlinkAgent, update, updateNoteStatus, updateStatus |
| terminal | 7 | create, getBuffer, kill, list, readOutput, resize, write |
| unsloth | 2 | status, stop — observe / gracefully stop the daemon-managed singleton Unsloth server (§5.37; v2.5, daemon-global — no `workspaceId`) |
| workspace | 25 | archive, cleanup, create, delete, detectProjectType, dismissAttention, duplicate, findRepositories, generateSetupScript, get, getAutoCommit, getContext, getSetupScript, getTokenUsage, getUiContext, initializeRepository, list, markSeen, restore, saveSetupScript, setAutoCommit, unarchive, update, updateContext, updateUiContext |

Namespaces without their own numbered subsection below (`accept-changes.*`, `file-tracking.*`, `drafts.*`, `forward.*`, `host.*`) are covered in §5.14–§5.20; `browser.exec` is in §5.9.

### Fast-path methods (34 total)

The following 34 methods are intercepted **before** the main router for performance or to access per-connection state. They share the same JSON-RPC envelope validation but are dispatched earlier in the connection task.

browser.exec, client.hello, drafts.clear, drafts.get, drafts.set, events.subscribe, events.unsubscribe, forward.close, forward.create, forward.list, host.checkAuggie, host.checkGit, host.directoryStatus, host.env, host.exec, host.execStream, host.execStream.cancel, host.execStream.write, host.findApp, host.findBinary, host.listDirectory, host.listInstalledEditors, host.openInEditor, host.providerAuthStatus, host.providerDiscovery, host.status, host.toolAvailability, pairing.getInfo, server.pairingInfo, server.rotateToken, system.gitCredential, system.importLegacy, system.shutdown, system.status

The snapshot+delta subscription channels (`note.subscribe`, `chat.subscribe`, …, §6.9) are likewise intercepted on the subscription fast-path.

**UDS-only methods:** `system.shutdown`, `system.importLegacy` (v2.2), and `system.gitCredential` (v2.5) are only available on the Unix-domain socket transport (a remote WSS/TCP caller is rejected with `-32001`). `system.status` is available on both UDS and WSS transports. `system.status` reports daemon liveness + transport/port/client/agent/cert-fingerprint/host-capability state, and `system.shutdown` requests a graceful daemon shutdown; both are consumed by `intentd status` / `intentd stop`. `system.importLegacy` triggers a legacy workspace import (see below). `system.gitCredential` resolves the daemon-managed GitHub credential for the `intentd git-credential` helper (see below). `pairing.getInfo`, `server.pairingInfo`, and `server.rotateToken` are likewise local-only: they are gated on the real connection origin (UDS vs TCP), so a remote (TCP/WSS) caller is rejected with `-32001` regardless of locality flags.

**`system.capabilities` is a router method, not a fast-path control (v2.3).** Unlike the `system.*` fast-path methods above (which are answered by the composition root's control surface), `system.capabilities` dispatches through the main router to the service layer and is available on **both** UDS and WSS. It takes no params (no `workspaceId`) and returns machine-level capabilities:

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "system.capabilities", "params": {} }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "cowSupported": true } }
```

- `cowSupported?: boolean` — the cached CoW-reflink probe of the **workspaces root** filesystem, the same probe that fills `Workspace.cowSupported` (§5.1): `true`/`false` when the probe ran, **omitted** (never `null`) when it could not run — clients detect by presence. Because it is workspace-independent, the FE gates the `workspace.cowIsolation` opt-in toggle (§5.12) on this method rather than reading `cowSupported` off a hydrated workspace payload.

#### `drafts.*` — draft attachments (additive, optional)

`drafts.set` accepts an **optional** `attachments` param and `drafts.get` returns it when present:

| Method | Params | Result |
| --- | --- | --- |
| drafts.get | workspaceId (req), agentId (req) | `{ text, attachments?, updatedAt } \| null` — `attachments` present only when non-empty |
| drafts.set | workspaceId (req), agentId (req), text (req), attachments (opt) | `{ ok: true, updatedAt }` — emits `draft:changed` |
| drafts.clear | workspaceId (req), agentId (req) | `{ ok: true }` — emits `draft:changed` |

- **`attachments`** is an opaque **JSON array** of FE-authored objects (e.g. image context items with base64 `imageData`), stored verbatim like workspace context items. Omitted, `null`, or an **empty array** ⇒ no attachments stored.
- A `drafts.set` with empty `text` **and** no attachments is still a **clear** (row deleted); empty `text` **with** attachments persists the row.
- The serialized `attachments` payload is capped at **25 MB**; larger payloads (and non-array `attachments`) are rejected with `-32602`.
- **Additive:** draft rows written before this field existed read back with no attachments; the `draft:changed` event payload is unchanged (`hasDraft` is `true` when text **or** attachments exist — never any content).

#### `system.status` — process resource fields (additive, optional)

The `system.status` result includes two **optional** self-process resource fields alongside the existing status payload (`running`, `listenMode`, `transports`, `port`, `clients`, `agents`, `maxAgents`, `version`, `uptimeSeconds`, `fingerprint`, `protocolVersion`, `host`):

```jsonc
{
  "cpuPercent": 12.5,        // optional — daemon process CPU usage
  "memoryBytes": 104857600   // optional — daemon process resident set size (RSS), in bytes
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- `cpuPercent` uses the raw `sysinfo` convention: `100` = one full core, so values **may exceed 100** on multicore systems (not normalized to total capacity). The first sample after daemon startup **may read **`0` before a usage baseline is established.
- `memoryBytes` is the daemon process RSS in bytes.
- Both fields are **additive and optional**; clients must tolerate their absence and degrade gracefully. They shipped within protocol **v2.0** without a version bump (additive optional response fields; the method surface is unchanged) — clients must detect them by **presence**, not by protocol version.

#### `system.importLegacy` (UDS-only, v2.2)

Runs the daemon's legacy workspace import over RPC — the same engine behind the `intentd import-legacy` CLI and the first-boot hook — so a client can trigger a recovery import without shell access. Scans the default legacy roots and imports per-directory legacy workspaces (notes, comments, agent sessions, assets) into the live store.

**Request:** `{ force?: boolean }` — `force` is optional and defaults to `false`. When `true`, workspaces whose id already exists in the DB are **updated (overwritten)** instead of skipped. `force` is overwrite-only: explicit runs (this RPC and the CLI) are never gated by the first-boot completion marker, so `force` is not needed to re-run. A non-boolean `force` → `-32602 "force must be a boolean"`.

**Response:**

```json
{
  "imported": 3, "updated": 0, "skipped": 1,
  "notes": 12, "comments": 4, "agents": 2, "assets": 5,
  "skipSummary": [ { "id": "ws-existing", "reason": "already in DB" } ],
  "compatibilityFailures": false,
  "markerWritten": true
}
```

- `imported` / `updated` / `skipped` count workspaces; `notes`, `comments`, `assets` are total rows/files imported across all workspaces, and `agents` counts imported agent **sessions**.
- `skipSummary` lists the first **20** skipped workspaces as `{ id, reason }`.
- `compatibilityFailures` is `true` when any workspace was skipped for a non-operational reason (unreadable/unparseable `workspace.json`, missing id, etc.). Operational skips — `already in DB` and transient `update failed:` / `insert failed:` / `lookup failed:` — do not count.
- `markerWritten` reports whether the first-boot completion marker was (re)written after this run. The marker is **not** written when compatibility failures occur, so the first-boot hook stays armed to retry; explicit CLI/RPC runs are not gated by the marker either way.
- **UDS-only:** a remote (TCP/WSS) caller is rejected with `-32001 "system.importLegacy is available over UDS only"`.
- A run that fails outright (e.g. the store cannot be read) → `-32603` with the underlying message. Per-workspace problems are soft: they surface as skips in the result, not as errors.
- Concurrent calls are serialized behind an internal lock, so overlapping runs cannot race workspace inserts or asset copies.
- **No bus events:** the import writes to the store directly and publishes no `workspace:*` / `note:*` events; clients must refresh (e.g. `workspace.list`) to see imported workspaces.

#### `system.gitCredential` (UDS-only, v2.5)

Resolves the daemon-managed GitHub credential for the `intentd git-credential` helper (monorepo#884): the daemon-spawned children (PTY terminals, agent provider shells) run the helper as a github.com-scoped git credential helper, and the helper fetches the credential from the daemon over UDS on demand — no token bytes in child environments.

**Request:** `{ pid?: number, protocol?: string, host?: string }` — `pid` is the calling helper's self-reported process id, used only for audit logging; missing or non-numeric values are tolerated (treated as absent), never rejected. `protocol`/`host` are the git-credential attributes the helper forwards so the daemon re-checks the scope gate server-side: the credential is granted only for `protocol=https` + `host=github.com` (case-insensitive, exact host), so an arbitrary local UDS caller cannot obtain the credential for another scope (defense in depth — the helper already applies the same gate before calling).

**Response:**

```json
// ← credential available
{ "credential": { "username": "x-access-token", "password": "gho_…" } }
// ← no credential available (still a success response, not an error)
{ "credential": null }
```

- `credential` is `null` when no credential is available — the scope gate missed (`protocol`/`host` absent or not `https`/`github.com`), the `sourceControl.github.exposeGitCredentialToChildren` setting is off, or no token resolves via the `sourceControl.github.tokenSource` chain. The cases are deliberately indistinguishable on the wire.
- **UDS-only:** a remote (TCP/WSS) caller is rejected with `-32001 "system.gitCredential is available over UDS only"` — the credential must never cross the network.
- Each grant is audit-logged by the daemon (requesting pid only; the token value is never logged).

#### `pairing.getInfo` (local-only)

Returns the structured QR pairing payload so local clients (the `intentd pair` CLI, desktop GUI) can render a QR code for LAN pairing.

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "uri": "intent://pair?v=1&host=192.168.1.10,10.0.0.5&port=5181&fp=AA:BB:...&token=abab...",
  "hosts": ["192.168.1.10", "10.0.0.5"],
  "port": 5181,
  "fingerprint": "AA:BB:...",
  "token": "abab...",
  "version": 1
}
```

- `uri` is the plaintext payload encoded in the QR code: `intent://pair?v=1&host=<ip[,ip...]>&port=<p>&fp=<sha256>&token=<t>` (query values percent-encoded where needed). The component fields (`hosts`, `port`, `fingerprint`, `token`, `version`) are provided so clients can render their own payloads.
- Hosts, TLS fingerprint, and bearer token come from the same sources as `intentd token`, so all pairing surfaces stay consistent.
- **Local-only:** the payload embeds the long-lived bearer token, so remote (TCP/WSS) callers are rejected with `-32001` regardless of locality flags. Call it over UDS.
- Errors with a descriptive message when the TCP (WSS) listener is not running (no port to pair against) or when no non-loopback IPv4 address is available.

#### `server.pairingInfo` (local-only)

Returns the raw pairing/connection material — bearer token, TLS cert fingerprint, WSS port, and local addresses — so local clients can construct a remote connection or display pairing details. Unlike `pairing.getInfo`, it returns the component fields without the `intent://pair` URI envelope.

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "token": "abab...",
  "certFingerprint": "AA:BB:...",
  "port": 5181,
  "path": "/ws",
  "localIps": ["192.168.1.10", "10.0.0.5"],
  "hostname": "my-mac.local"
}
```

- `token` is the long-lived bearer token (64 hex chars, §2.1); `certFingerprint` is the SHA-256 fingerprint of the daemon's TLS certificate (§1.2).
- `port` is the bound WSS port, or `null` when the TCP (WSS) listener is not running; `path` is always `"/ws"`.
- `localIps` lists non-loopback IPv4 addresses (virtual/container interfaces such as `docker*`/`veth*` are skipped) — the same host set `pairing.getInfo` reports, so all pairing surfaces stay consistent.
- **Local-only:** gated on the real connection origin (UDS vs TCP), not locality flags — a remote (TCP/WSS) caller is rejected with `-32001 "server.* methods are local-only"`. Call it over UDS.

#### `server.rotateToken` (local-only)

Regenerates the bearer token (invalidating the previous one for new connections) and returns the updated pairing info.

**Request:** `{}` (no parameters)

**Response:** same shape as `server.pairingInfo`, with `token` set to the newly generated value.

- Rotation is rejected with `-32602 "cannot rotate token: INTENTD_AUTH_TOKEN is set (token is fixed by env)"` when the token is pinned via the `INTENTD_AUTH_TOKEN` environment variable.
- **Local-only:** same `-32001` gating as `server.pairingInfo`.

#### `host.providerAuthStatus`

Daemon-owned provider auth probes: reports whether each CLI-backed agent provider is authenticated, so clients consume verdicts instead of orchestrating auth-check commands themselves.

**Request:** `{ "providerId": "grok", "force": true }` — both parameters optional. `providerId` scopes the sweep to a single provider; it must be a non-empty string when present, and an unknown, empty, or non-string `providerId` yields `-32602`. `force` must be a boolean when present (`-32602` otherwise).

**Response:**

```json
{
  "providers": [
    { "id": "auggie", "authenticated": true },
    { "id": "claude-code", "authenticated": false },
    { "id": "grok", "authenticated": null }
  ]
}
```

- Without `providerId`, the sweep covers all probe-able providers: `auggie`, `claude-code`, `codex`, `opencode`, `droid`, `grok`, `pi`. With `providerId`, the `providers` array contains only that provider.
- `authenticated` is tri-state: `true` (probe confirmed logged in), `false` (probe confirmed logged out), `null` (unknown — probe failed or timed out, or the provider is not installed). Not-installed providers are never probed. Installed-ness comes from the daemon's provider discovery, which resolves `opencode` and `grok` from their native installer locations (`~/.opencode/bin/opencode`, `~/.grok/bin/grok`) ahead of the `PATH` scan (see §5.30), so a natively installed CLI is probed even when the daemon's `PATH` does not include it. Since intentd#725, the install gate also honors **valid `providers.paths` overrides** for the providers whose gate command is the registry primary — `auggie`, `opencode`, `droid`, `grok` — so an override-only install is probed, while an invalid override contributes nothing and the gate falls through to auto-detection. For `opencode` / `droid` / `grok` a valid override is an absolute path to an executable file (the same validation as spawn resolution); `auggie`'s gate instead follows the `host.checkAuggie` precedence (`context.auggiePath` setting → `providers.paths.auggie`, with checkAuggie's file/symlink validation) before falling through to auggie auto-detection. `claude-code`, `codex`, and `pi` gate on the real `claude` / `codex` / `pi` CLIs — distinct from the adapter binaries their `providers.paths` keys describe — so adapter overrides are ignored for their gates.
- Results are cached with a **60-second TTL** and probes are single-flighted (concurrent callers join the in-flight probe). `force: true` bypasses the cache read but still joins any in-flight probe.

#### `host.providerDiscovery`

Daemon-owned provider discovery: reports which CLI-backed agent providers are installed on the daemon host (binary resolution + npx fallback status, honoring valid `providers.paths` overrides), so clients render install state without probing `PATH` themselves.

**Request:** `{}` (no parameters)

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "unsloth",
      "displayName": "Unsloth",
      "command": "opencode",
      "installed": true,
      "resolvedPath": "/usr/local/bin/opencode",  // optional — present when the primary binary auto-detected (never an override path)
      "hasNpxFallback": false,
      "npxOnly": false,
      "secondaryCommand": "unsloth",               // optional — dual-binary providers only
      "secondaryResolved": true,                   // optional — dual-binary providers only
      "secondaryResolvedPath": "/Users/me/.unsloth/bin/unsloth"  // optional — present only when the secondary auto-detected
    },
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "command": "npx",
      "installed": true,
      "resolvedPath": "/usr/local/bin/npx",
      "hasNpxFallback": false,
      "npxOnly": true,
      "npxPackage": "@agentclientprotocol/claude-agent-acp@1.2.3"  // optional — npx-only providers only (pinned spec)
    }
  ],
  "npx": { "resolvedPath": "/usr/local/bin/npx", "version": "10.2.4", "versionOk": true }
}
```

- `providers` carries one entry per registered provider, in registry order. `installed` reflects the daemon's binary resolution, which checks Intent-managed / native installer locations (e.g. `~/.opencode/bin/opencode`, `~/.grok/bin/grok`) ahead of the `PATH` scan (see §5.30). Since intentd#717, `installed` (and `secondaryResolved`) also honor **valid `providers.paths` overrides** — an override value that is an absolute path to an executable file (the same validation as spawn resolution) counts as installed even when auto-detection finds nothing, matching what the daemon would actually launch; invalid overrides (missing, relative, non-executable) contribute nothing. Override keys follow spawn resolution: for `unsloth` the `opencode` key covers the primary binary and the `unsloth` key covers the secondary CLI.
- `resolvedPath` is **strictly auto-detected** — an override never surfaces there — so `installed: true` can coexist with `resolvedPath` absent (valid override, nothing auto-detected).
- **`secondaryCommand` / `secondaryResolved`** *(additive, monorepo#991)* — secondary-binary attribution for **dual-binary providers** (today only `unsloth`, which requires both `opencode` and `unsloth` on the daemon host). `secondaryCommand` names the required secondary CLI and `secondaryResolved` reports whether it resolved via the same discovery precedence as the primary (including valid `providers.paths` overrides, intentd#717) — so when a dual-binary provider shows `installed: false`, clients can attribute the failure to the actually-missing binary instead of the primary `command`. The two fields are always emitted **together**, and are **omitted (never null)** for providers without a secondary requirement and for gated-off providers (gated providers are never probed, so no attribution exists). Clients detect by presence.
- **`secondaryResolvedPath`** *(additive, intentd#701)* — the secondary binary's resolved **absolute path** string, sitting alongside `secondaryCommand` / `secondaryResolved` on dual-binary provider entries. Like `resolvedPath`, it is **strictly auto-detected**: present only when the secondary **auto-detected**; omitted (never null) when nothing auto-detected or the provider has no secondary requirement. Consequently `secondaryResolved: true` can coexist with `secondaryResolvedPath` absent (valid override satisfied the requirement, nothing auto-detected) — clients must not treat `secondaryResolved: true` as implying the path field.
- `gatedOff` (optional string, not shown above) is present — with a human-readable reason — only when the provider is gated off (e.g. a required env var or feature code is missing). Gated providers skip binary probing entirely, so a gated entry never carries `resolvedPath`, `secondaryCommand`, `secondaryResolved`, or `secondaryResolvedPath` and always reports `installed: false`.
- `npxOnly` is `true` for providers with no local-binary path at all (claude-code): they are launched via `npx <package>`, `installed` reflects npx resolution, and `resolvedPath` (when present) is the npx binary. `npxPackage` (the pinned package spec) is present **iff** `npxOnly` is `true`.
- `hasNpxFallback` is `true` for providers that prefer a local binary but can fall back to an npx-launched adapter when the binary is absent — so a `hasNpxFallback: true` provider with `installed: false` may still be usable if the `npx` probe below reports `versionOk: true`.
- `npx` reports the daemon's npx probe: `resolvedPath` is `null` when npx is not found; `version` is `null` when npx is missing **or** the version probe fails (a failed probe leaves `resolvedPath` set); `versionOk` is whether the resolved version meets the minimum requirement (`false` whenever `version` is `null`).

### Method aliases (2 total)

The daemon accepts these 2 alias forms and dispatches them to their canonical counterparts. The wire accepts both, but the canonical name is the documented form.

- `git.diff` → `git.diffs`
- `git.log` → `git.commits`

### Client-served reverse RPCs (4 total)

These methods are client-callable triggers whose real work happens on the connected frontend. The daemon validates the envelope, then dispatches a reverse RPC back to the client with a synthetic `rev-<n>` request id and echoes the client's result back to the original caller. These 4 method names are **dual-role**: they appear in the dispatchable method catalog AND are also issued daemon→client as reverse RPCs on remote connections.

- `browser.exec` — browser automation (Chrome DevTools) — §5.9
- `host.openExternal` — open a URL in the default browser — §5.14
- `host.openInEditor` — open a file or directory in the user's editor — §5.14
- `host.pickApplication` — prompt the user to select an application — §5.14

> **Internal, not wire (Code Changes Review).** Diff computation/versioning (`diffs.*`), agent-attribution `trackChange`, and metrics aggregation (`metrics.calculate` and the `update*` writers) run **entirely inside the backend** with no client RPC. Diff bodies are computed/stored internally and surfaced through the `file-tracking.*` reads (§5.19) plus the change events in §6.5 — clients never call a `diffs.*` method. See the cross-cutting principle in §6.8.

> **Internal, not wire (Agent Ecosystem).** Rule **injection** — assembling the system prompt from workspace files (`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization rules, and user overrides — runs **inside the backend** as agents start; only the `rules.*` read/edit methods (§5.21) cross the wire. Per-agent-type tool **denylisting** is likewise internal enforcement — there is **no** `agent.getAvailableTools` RPC. Long-term agent **memories** are an internal context source consumed by the agent runtime; no `memories.*` wire surface is exposed (see §5.22). See §6.8.

> **Internal, not wire (Integrations & Ops).** Token/credit **usage accounting** runs **inside the daemon**: usage is tallied **live** at ACP turn end from `PromptResponse.usage`, with a periodic **reconciliation scan** as fallback (§5.23); clients never trigger either — they read the result via `workspace.getTokenUsage` (§5.23) and are pushed `workspace:tokenUsage-changed`. **Observability** (tracing, structured logs, log files) is likewise daemon-internal: there is **no** `logging.*` / `telemetry.*` wire surface. See §6.8.

> Deprecated aliases. agent.subscribe/agent.unsubscribe and event.subscribe/event.unsubscribe exist in the method map but are not the canonical WebSocket subscription surface. For live event streaming use the bridge methods events.subscribe / events.unsubscribe (note the plural events.), handled directly by the server before the dispatcher — see §6. The agent./event.* variants create internal/agent-style subscriptions and do not wire a WebSocket client up to events.event notifications. (A bare `{ workspaceId }` `agent.subscribe` frame instead routes to the agent collection channel — see §6.9.)

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields`-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires`workspaceId` (see §3.6) and may return `-32603 Internal error` if the underlying service throws.

### 5.1 `workspace.*`

| Method | Params | Result |
| --- | --- | --- |
| workspace.list | includeArchived?: boolean (default false) | { workspaces: Workspace[] } — triggers background backfill: existing workspaces with a repositoryPath but missing repositoryOwner/Name are enriched from the origin remote URL (same GitHub derivation as workspace.create, non-blocking spawn, deduped per workspace per daemon lifecycle, skips non-GitHub remotes, persists updates, emits workspace:updated with changed fields) |
| workspace.get | workspaceId (req) | { workspace: Workspace } — -32602 if not found |
| workspace.create | workspace fields (incl. repositoryPath?, baseRef?, branch?, remote?, skipIsolation? (canonical; deprecated alias skipWorktree?), githubUrl?, clonePath?, isNewRepo?); optional initialAgent: { prompt, name?, model?, specialist?, provider?, behaviorPrompt?, agentType?, imageBlocks?, metadata? } — no `agentId`: agent IDs are server-assigned, and a request carrying `initialAgent.agentId` is rejected with `-32602` (see notes) | { workspace: Workspace, initialAgent?: AgentLite } — the created agent's server-minted id is `initialAgent.id`; daemon-owned orchestration inside one idempotent op (see notes: clone → checkout (worktree or CoW) → spec seed → initial agent). |
| workspace.update | workspaceId (req) + fields to change — the skip toggle uses the same wire names as create: skipIsolation? (canonical; deprecated alias skipWorktree?, either set ⇒ same behavior); the `workspace:updated { changes }` delta serializes it under the canonical skipIsolation name; `statusImageAssetId?: string \| null` is clearable (missing = untouched, `null` = clear, string = set — see the `statusImageAssetId` notes below) | { workspace: Workspace } |
| workspace.delete | workspaceId (req) | { success: true } — fast-ack: returns immediately after deleting the database row and emitting `workspace:deleted`, while filesystem cleanup runs in a background task — only the git-metadata phase (worktree-registration prune + rename of the checkout to a trash path + guarded branch delete; a CoW checkout — a standalone clone with no registration in the source repo and a branch living only inside the clone — gets just the rename, no prune and no source-repo branch delete) holds the per-repository lock; the recursive `remove_dir_all` of the renamed trash directory runs afterwards outside the lock |
| workspace.archive | workspaceId (req) | { workspace: Workspace } — returns the refreshed record with `archived: true` / `status: "Archived"` / `archivedAt` set, so callers do not need to follow up with `workspace.get`. Emits `workspace:updated` with the full applied delta `changes: { archived: true, status: "Archived", archivedAt: <ts> }` where `<ts>` is the same ISO timestamp persisted on the row (§6.5). -32602 if not found. |
| workspace.unarchive | workspaceId (req) | { workspace: Workspace } — mirror of `workspace.archive`; returns the refreshed record with `archived: false` / `status: "Active"` and `archivedAt` cleared. Emits `workspace:updated` with `changes: { archived: false, status: "Active", archivedAt: null }` — an explicit JSON `null` so clients clear the field (§6.5). -32602 if not found. |
| workspace.dismissAttention | workspaceId (req) | { workspace: Workspace } — clears `attention` to `"none"`; -32602 if not found |
| workspace.markSeen | workspaceId (req) | { workspace: Workspace } — marks the workspace seen (clears unread `attention`) |
| workspace.getContext | workspaceId (req) | { items: ContextItem[] } — persisted chat-context attachments for the workspace; empty array before the first save. -32602 if the workspace is absent. |
| workspace.updateContext | workspaceId (req), items (req): ContextItem[] | { items: ContextItem[] } — atomic full-list replacement (matches the FE's `hydrate/add/remove/update` collapsed to a single authoritative-list write). Order is preserved. Emits `workspace:context-changed` with the persisted list. -32602 on missing workspace, malformed `items`, or an item with an empty `id`. |
| workspace.getAutoCommit *(v2.7)* | workspaceId (req) | { autoCommit: { enabled: boolean, source: "workspace" \| "global" } } — the effective per-workspace auto-commit state: the persisted workspace override when set (`source: "workspace"`), else the current global `git.autoCommit` setting (`source: "global"` — pre-migration rows and the virtual Chief workspace). -32602 if the workspace is absent. |
| workspace.setAutoCommit *(v2.7)* | workspaceId (req), enabled (req): boolean | { autoCommit: { enabled: boolean, source: "workspace" } } — echoes the persisted override (`enabled` is the boolean just written; `source` is always `"workspace"`), persists it across daemon restarts, and emits `workspace:updated` with `changes: { autoCommitEnabled: boolean }` (§6.5). -32602 on missing workspace, missing/non-boolean `enabled`, or the virtual Chief workspace. |

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "workspace.list", "params": { "includeArchived": false } }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "workspaces": [ { "id": "ws-abc", "title": "My Workspace" } ] } }
```

**Branch naming (`workspace.create`).** An explicit `branch` is used untouched. Otherwise
the daemon auto-names the branch with a friendly `word-word` slug (TS parity): extracted
from `initialAgent.prompt` via local keyword heuristics when possible (`generateLocalSlug`
— e.g. "fix the auth flow" → `auth-fix`), else a random adjective-animal pair
(`generateWorkspaceSlug` — e.g. `amber-forest`). The `workspace.branchPrefix` setting
(§5.12), when set, is prepended (e.g. `aw/auth-fix`). When `repositoryPath` is a local git
repository the name is uniquified against existing local and remote-tracking branches by
appending `-2`, `-3`, … until free. The branch is never the raw workspace UUID.

**Workspace id (`workspace.create`).** The daemon derives the workspace id as a friendly
`word-word` slug (extracted from `initialAgent.prompt` when possible, else a random
adjective-animal pair), uniquified with a `-2`, `-3`, … suffix whenever the candidate id was
**ever** used — a live workspace, a previously deleted workspace (persisted delete
tombstone), or a leftover `<root>/<id>` directory on disk. Ids are therefore never recycled
across delete/recreate (reuse would collide the old workspace's agent streams and file
paths with the new one's); callers must use the id returned in the `workspace.create`
result rather than predicting it.

**Worktree provisioning (`workspace.create`).** When `repositoryPath` points at a local git
repository, the daemon provisions a linked worktree before persisting the row (TS
`createGitWorktree` parity): the worktree lives at
`<root>/<workspaceId>/<repo-slug>` — `root` is `$INTENTD_WORKSPACES_DIR`, else
`~/intent/workspaces` (the FE's `WorkspaceConfig.WORKSPACES_BASE`); the slug is the
slugified `repositoryName` (basename fallback) — checked out on the workspace `branch`
(auto-named as above when not supplied), created from `baseRef` resolved as
`refs/remotes/<remote>/<baseRef>` (remote defaults to `origin`) → `refs/heads/<baseRef>` →
any rev-parsable spec, else `HEAD`. No network fetch is performed — the base resolves from
local state. The returned `Workspace` carries `worktreePath`, `baseCommitSha` (the
checked-out tip), and `checkoutMode` (`"worktree"` here; see the CoW note below). An
unresolvable `baseRef` on a valid repo fails with `-32602` carrying the
`base-ref-unresolvable` `error.data` payload (§9).
Provisioning is skipped — prior row-only behavior — for `skipIsolation: true`
(canonical name; `skipWorktree` is accepted as a deprecated alias, either set ⇒ direct
mode), `isRemote: true`, a caller-supplied `worktreePath`, a missing `repositoryPath`, or
a `repositoryPath` that is not a local git repository (unless `isNewRepo: true`
initializes it first — see new-repository initialization below). `workspace.update` follows the
same rename: `skipIsolation` is the canonical param (deprecated alias `skipWorktree`),
and the persisted column keeps its historical `skip_worktree` name
(`Workspace.skipWorktree`) — the rename is wire-level only, no migration.

**CoW checkout provisioning (`workspace.create`, new in intentd).** The
`workspace.cowIsolation` setting (§5.12, boolean, default `false`) selects the checkout
mode, persisted on the returned `Workspace` as `checkoutMode` (`"worktree" | "cow"`;
omitted whenever provisioning was skipped per the conditions above). Off ⇒ the
linked-worktree behavior above (`checkoutMode: "worktree"`). On ⇒ the daemon first
probes CoW support from the repository directory to `<root>/<workspaceId>`: when
supported, the checkout is a **standalone copy-on-write clone** of the whole repository
directory (OS reflink primitives — macOS `clonefile(2)` whole-tree fast path with best-effort
walk fallback, Linux `ioctl(FICLONE)`) instead of a linked worktree, carrying deps/build artifacts
(`node_modules`, `target`, …) into the checkout for free; inside the clone the workspace
`branch` is created + checked out from the same `baseRef` resolution order as above,
tracked files are hard-reset to that base, untracked files are preserved, and the row
persists `checkoutMode: "cow"`. When the probe reports Unsupported (or errors) — e.g.
the repository lives on a different volume than the workspaces root, since reflinks
cannot cross filesystems — the create **falls back to the linked-worktree path**
(`checkoutMode: "worktree"`, normal worktree provisioning) with a logged warning
instead of failing: `workspace.cowIsolation` is a preference, not a guarantee. Because
a CoW checkout is a standalone clone, `workspace.delete`'s git-metadata phase skips the
worktree-registration prune and the source-repo branch-delete guard (the workspace
branch lives only inside the clone); the checkout is still renamed to a trash path and
removed in the background as usual.

**Duplication (`workspace.duplicate`).** Duplicating a local workspace off a local git
repository provisions a fresh checkout for the copy at `<root>/<newId>/<repo-slug>` on a
branch named for the new id (uniquified against the source repo's local and
remote-tracking branches), using the **same decision matrix as `workspace.create`**:
`workspace.cowIsolation` off ⇒ linked worktree (`checkoutMode: "worktree"`); on ⇒ CoW
probe from the repository directory to `<root>/<newId>` — supported ⇒ standalone CoW
clone (`checkoutMode: "cow"`), Unsupported/probe error ⇒ the duplicate **falls back to
a linked worktree** with a logged warning (same fallback semantics as create).
Provisioning is skipped for remote / skip-isolation sources and for a `repositoryPath`
that is not a local git repository. An ordinary provisioning failure is logged and
swallowed (FE parity — "continue without worktree"): the row persists without
`worktreePath`/`checkoutMode`.

**`checkoutMode` is immutable.** `workspace.cowIsolation` is consulted **only** at
provisioning time (`workspace.create` / `workspace.duplicate`); the resulting
`checkoutMode` is persisted on the row and never changes for the life of the workspace.
Toggling the setting later affects only subsequently created workspaces — existing
checkouts are not converted.

**Clone orchestration (`workspace.create`).** When `githubUrl` is set and
`repositoryPath` is not already a local git repository, the daemon clones the URL
before branch naming and worktree provisioning, reusing the streaming `git.clone`
pipeline (§5.14). The clone target is the caller-supplied `clonePath` when non-empty,
else `<workspaces_root>/clones/<derived-repo-name>` (basename of the URL with a trailing
`.git` stripped, matching `git clone` defaults); a pre-existing target fails the create
with `-32602` and `error.data = { code: "destination-exists-non-empty", detail }`
(clone failure taxonomy, §9). A leading `~` / `~/` in the caller-supplied `clonePath` or
`repositoryPath` expands to the daemon user's home directory before the existing-repo
check, clone targeting, and persistence (`~user` forms pass through unchanged) — git
would otherwise treat the tilde as a literal `./~` directory, which fails on the
packaged sidecar's read-only cwd. The persisted `repositoryPath` is always the
post-expansion value (identical to the input whenever expansion does not apply).
Expansion is best-effort: it is `/`-separated only, and when the daemon cannot resolve
a home directory from its environment it is a no-op — the verbatim tilde path is then
used as-is, so the clone fails as before (and per the clone-failure rule below, no row
is persisted). Progress streams as `git:clone:progress` frames and terminates in exactly
one `git:clone:done` — both scoped to the newly minted `workspaceId` — and a `git clone`
failure fails the whole `workspace.create` (no row persisted, no `workspace:created`)
with a classified error from the clone failure taxonomy (§9): the numeric code is
`-32602` for user-fixable inputs (`path-invalid`, `destination-exists-non-empty`) or
`-32603` otherwise (`auth-required`, `network`, `clone-failed`), `error.message` is
`workspace.create clone failed (<category>): <detail>`, and
`error.data = { code: "<category>", detail }` where `detail` is the tail of git's
stderr with any `user[:pass]@` credential fragments redacted — clients render the
detail instead of a bare "Internal error" and key behavior off `error.data.code`.
On success the checkout becomes the workspace's `repositoryPath` and, when the URL
carries an `owner/name` pair (`github.com/OWNER/REPO(.git)?` on https or ssh), the
daemon best-effort derives `repositoryOwner`/`repositoryName` from it when the caller
left them blank. Independently of cloning, any create that ends up with a local
`repositoryPath` but no caller-supplied `repositoryOwner`/`repositoryName` best-effort
derives them from the local repository's `origin` remote URL (local git config read only,
no network) when the remote is a GitHub URL (https or ssh forms, strict `github.com` host
check); non-GitHub or missing remotes leave `repositoryOwner` unset. Caller-supplied
values always win; `repositoryName` persists the path basename as a last resort when blank.

**New-repository initialization (`workspace.create`, new in intentd).** When
`isNewRepo: true` (optional boolean, default absent/`false`), `repositoryPath` is not
already a local git repository, and no non-empty `githubUrl` is supplied — clone
orchestration above takes precedence — the daemon initializes the directory as a git
repository **before** branch naming and worktree provisioning, reusing the
`workspace.initializeRepository` body: `mkdir -p`, `git init -b main`, seeded
`.gitignore` + `README.md`, and an initial commit (git identity falls back to
`Intent <intent@local>` when no global identity is configured), so downstream
provisioning sees a real checkout. This is the FE's new-project flow (monorepo#962) —
it eliminates the silent row-only workspace the legacy skip produced for non-git
folders. `isNewRepo: true` with a missing/empty `repositoryPath` is rejected with
`-32602` (`repositoryPath is required when isNewRepo is true`) rather than falling
through to the row-only skip. An initialization failure fails the whole create
pre-insert — no row persisted, no `workspace:created` — with `-32603`,
`error.message = "Internal error"`, and the cause in
`error.data` (`workspace.create: repository initialization failed: <detail>`, §9).
`isNewRepo: true` on a path already carrying a git repository with a resolvable HEAD is
a no-op; when `.git` exists but HEAD does not resolve (a previously failed init left the
directory half-initialized), the init re-runs and completes it. Absent/`false` preserves
the legacy behavior: a non-git `repositoryPath` skips provisioning and persists a
row-only workspace (worktree-provisioning skip conditions above).

**Spec note seeding (`workspace.create`).** Every successful create seeds the well-known
`spec` note in the new workspace (reference `notes.service.ts ensureSpecExists` parity):
id `"spec"`, title `"Spec"`, empty markdown body, tags `["spec"]`, pinned, default,
workspace visibility. The seed captures an initial `v1` version snapshot and publishes
`note:created` so subscribers see the standard note lifecycle. Seeding runs inside the
idempotency scope (§6.5) between `workspace:created` and initial-agent orchestration —
a replayed create returns the stored result and does not re-seed.

**Setup script persistence and execution (`workspace.create`).** When an explicit
`setupScript` parameter is supplied, the daemon writes it into
`<worktree-root>/.intent/config.json` (best-effort, warn on failure) after worktree
provisioning, using merge semantics — unrelated keys (e.g., `setupScript`, `scripts`) are preserved;
writes are no-op when the existing value is identical. The `.intent/config.json` file
becomes the sole source of truth for the setup script; the workspace DB `setup_script`
field is retired from all write paths (kept for wire compat and legacy read-only
fallback only). After the config write, if an effective setup script exists (non-empty,
resolved via worktree-first `.intent/config.json` read with legacy DB fallback), the
daemon executes it non-blocking (fire-and-forget spawn) in the worktree directory via
`/bin/sh` (POSIX; on Windows, via a discovered Git-for-Windows `sh.exe` running the same
POSIX wrapper, falling back to a `cmd.exe` `.cmd` wrapper that receives the script path
through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT` (repository root path), `WORKTREE_PATH`
(the new worktree path), `BRANCH_NAME` (workspace branch), and `SOURCE_BRANCH`
(baseRef when provided, empty string otherwise). Execution never fails workspace creation — errors are logged and
surfaced. Script output is streamed to a workspace terminal named **"Setup Script"**
(the PTY's daemon-tracked display name, surfaced by `terminal.list` — §5.9),
consistent with other workspace terminals. The script runs through a POSIX-sh timing
wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) that appends
a newline-prefixed completion summary to the scrollback —
`Setup script completed in <N>s (exit code <C>)` on success,
`Setup script failed in <N>s (exit code <C>)` on failure — preserving the script's
exit code.

**Initial-agent orchestration (`workspace.create`).** When `initialAgent` is supplied the
daemon minimally creates the agent session (honoring `name`/`model`/
`specialist`/`provider`/`behaviorPrompt`/`agentType`/`imageBlocks`/`metadata`) and
delivers the resolved `prompt` (blank/whitespace-only prompts are a no-op, no session).
When `initialAgent.name` is omitted but a `specialist` is supplied, the agent's name
defaults to the specialist's resolved display name (frontmatter `name`, 3-tier
project > user > bundled — e.g. "Coordinator" for `spec-writer`) and counts as
explicitly set (it survives the agent's guarded opening-turn self-rename, same
rename-guard semantics as `agent.create` §5.5); an unknown specialist or a resolution
failure never fails the create — the name falls back to the generated
`Agent {6-hex}` placeholder (not explicitly set).
The agent's id is **server-assigned**: whenever a session is created the daemon mints a
fresh `agent-{uuid}`, and a request carrying `initialAgent.agentId` is rejected with `-32602`
("agent IDs are server-assigned and the field must be omitted") **before any side
effect** — no workspace row, worktree, spec seed, or `workspace:created` event is
persisted.
The result's `initialAgent` is the created session's full `AgentLite` projection (its
server-minted id is `initialAgent.id`); the agent's turn starts
asynchronously (fire-and-forget) but the create call is not idempotent unless a
`idempotencyKey` is supplied — a replay with the same key returns the stored result
(carrying the originally minted `initialAgent.id`) without re-creating the
session or re-delivering the prompt.

**Delete cascade (`workspace.delete`).** Before the store cascade drops the
workspace's `agent_session` rows, the daemon sweeps every live in-memory piece of
per-session state so recreating a workspace with the same slug never surfaces ghost agents
whose workers are still draining or whose completion watches are still firing:

- list the workspace's sessions via `store.list_agent_sessions` (a store error is
  propagated with `?` — a partial teardown is worse than a failed delete);
- per session, `AgentManager::stop` aborts the in-flight turn worker, drops the
  session handle (which calls `kill_child_tree` on the ACP child on drop),
  clears the busy flag + the `agent_ws` workspace mapping, and deregisters the
  process from the LRU registry;
- drop the session's live-turn slot and pending message-queue entry in
  `Services` (both are `HashMap::remove` calls, not a drain);
- sweep the daemon-global subscription registry: completion watches whose
  **parent** session lives in the deleted workspace and delegation groups
  anchored there are dropped outright. Cross-workspace watches (a `__chief__`
  parent elsewhere watching a child here) are instead **consumed
  deterministically**: per swept session the daemon delivers the synthetic
  `agent:deleted` completion directly and synchronously (not via the bus, and
  before the store cascade removes the `agent_session` rows) — waking the chief
  parent exactly once and recording grouped children as deleted — then
  backstop-sweeps any surviving watch whose `child_workspace_id` is the deleted
  workspace (in-memory entries and persisted `completion_watch` rows), so no
  watch can reference the deleted workspace as child afterwards. Each parent
  affected by the backstop sweep gets a refreshed `agent:subscriptions-changed`
  (§6.5) so clients converge on the shrunken watch set without polling.

Best-effort teardown recovers from poisoned mutexes via `into_inner()` — this is
the last chance to unlink the workspace-scoped state, so recovery beats a panic.
The daemon emits **one `agent:deleted` per swept session BEFORE** the terminal
`workspace:deleted`, so subscribers see the per-session teardown first and can
retire agent-scoped UI (chat panes, banners) before the workspace row disappears
(§6.5).

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
  surfaces via `workspace:attention-changed` (§6.5). This is shared BE state rather than
  per-client local state (the daemon is single-user in v1; per-viewer cursors are a future
  extension).

**`status` wire form.** `Workspace.status` serializes as the PascalCase TS `WorkspaceStatus`
string enum — `"Active" | "Inactive" | "Archived" | "Deleted"` (src/shared/types.ts) — both on
the wire and as the stored DB word (matching the `PullRequestStatus` precedent). Optional
`Workspace` fields (`statusMessage`, `statusImageAssetId`, `baseRef`, `prUrl`, `prNumber`,
`prStatus`, `activePullRequest`, `pullRequests`, `archivedAt`, `cowSupported`, `checkoutMode`,
repository/worktree fields, …) are
**omitted when absent**
(`skip_serializing_if`) rather than emitted as `null`, so clients see only populated keys.

**`statusImageAssetId` (new in intentd, migration `0062`).** An agent-authored workspace
status screenshot reference (intent-hq/monorepo#997). The value is a content-addressed
asset id minted by the `note.saveAsset` machinery (§5.2); clients render it with
`note.readAsset` / the `workspace-asset://` URL scheme. Agents set or clear it via the
MCP `workspace_api` binding `ws.workspace.setStatusImage({ data, mimeType, originalName? }
| null)` — the daemon stores the image bytes as an asset first, then points the workspace
row at the resulting id (`null` clears; the binding errors when called against the
virtual chief-of-staff **workspace** — the `WorkspaceId::is_chief()` guard, same as
`archive`/`unarchive` — regardless of which agent or specialist calls it). On the wire,
`workspace.update` accepts `statusImageAssetId: string | null` with the same three
clearable forms as the PR fields below: **missing** leaves the stored value untouched,
explicit **JSON `null`** clears it, and a **present string** sets it (a whitespace-only
or empty string folds to a clear, and the delta carries the `null` clear signal). The
`workspace:updated { changes }` delta (§6.5) preserves the distinction, and the field is
omitted from `Workspace` payloads until an agent sets one.

**`cowSupported` / `checkoutMode` (new in intentd).** `cowSupported` is a BE-derived
machine-capability flag: a cached CoW-reflink probe of the **workspaces root**
filesystem (the probe creates a missing root rather than omitting), filled by the
aggregate-enrichment step on the `workspace.list` / `workspace.get` read paths —
`true` / `false` for a supported/unsupported filesystem, omitted when the probe cannot
run or exceeds the per-call budget (write-path responses such as `workspace.create` /
`update` / `archive` build the row without this enrichment, so clients read it off the
list/get poll). It reports the machine's capability independent of how the specific
workspace was provisioned; the FE gates the `workspace.cowIsolation` opt-in toggle
(§5.12) on it. **Caveat — root-scoped, not repo-scoped:** provisioning probes from the
*repository directory* into the workspaces root (§5.1), so a repository on a different
filesystem than the workspaces root (reflinks cannot cross filesystems) can still land
`workspace.create` on the worktree-fallback path (`checkoutMode: "worktree"`, §5.1)
even when `cowSupported` is `true`; `cowSupported` is a toggle-gating advisory, not a
per-repository guarantee.
`checkoutMode` (`"worktree" | "cow"`, lowercase on the wire) records how
`workspace.create` provisioned this workspace's checkout (§5.1) and is omitted for rows
without a daemon-provisioned checkout (skip-isolation/direct, remote, caller-supplied
`worktreePath`, non-git repository paths, pre-existing rows).

**`lastActivity` (BE-derived, always populated).** `Workspace.lastActivity` is the
authoritative "most recent thing that happened in this workspace" timestamp. The daemon
derives it on every path that returns a `Workspace` on the wire (`workspace.list` /
`workspace.get` / `workspace.create` / `workspace.update` / `workspace.archive` /
`workspace.unarchive`) as the **max** of the persisted `lastActivity`, `updatedAt`,
`createdAt`, every note's `updatedAt`, and every agent session's `updatedAt` (FE
`deriveWorkspaceLastActivity` parity). It is always present on the wire —
clients never need to recompute it from notes/agents.

**PR-field ownership (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`, `pullRequests`).**
These five fields are BE-owned: the daemon writes them from PR discovery / refresh
(§5.9, §6.5 `pr:*` events) and clients read them off the returned `Workspace`. All five
are `Option`s that serialize with `skip_serializing_if` (absent, not `null`). The
persisted `pullRequests: PullRequestInfo[]` (new in intentd, migration `0035`) sits
alongside `activePullRequest` and carries the reconciliation candidates the FE matches
`activePullRequest` against.

**Explicit-null clear on `workspace.update` PR fields.** On `workspace.update`, the same
five clearable PR fields (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`,
`pullRequests`) accept three wire forms: **missing** the key leaves the stored value
untouched, an explicit **JSON `null`** clears the stored value, and a **present value**
sets it. The applied `WorkspaceUpdate` delta emitted as
`workspace:updated { changes }` (§6.5) preserves this distinction — omitted keys were
untouched, `null` keys were explicit clears, present keys were sets.

**`baseRef` canonicalisation.** On `workspace.create` and `workspace.update`, an incoming
`baseRef` has any known remote prefix (`origin/`, `upstream/`, `fork/`) stripped before
persistence, so `origin/main` and `main` collapse to the same canonical `main`. The
returned `Workspace.baseRef` and the persisted DB value are always the canonical form;
values without a known prefix are stored verbatim. `git.*` methods that need the
fully-qualified remote-tracking name reconstruct it as `origin/<baseRef>` locally.

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

**Derived display status (`displayStatus`, new in intentd).** Alongside the card aggregates, the
same `workspace.list` / `workspace.get` emit path enriches each `Workspace` with a BE-owned
"current cycle" status rollup over the active/latest PR and `taskStats` — derived fresh on emit,
**never persisted**. Wire values are the snake_case strings
`"not_started" | "in_progress" | "complete" | "pr_ready" | "pr_open" | "pr_merged"`. The field is
decoded as optional and **omitted when `taskStats` is not computable** (`skip_serializing_if`,
e.g. a transient notes-read failure) rather than emitted as `null` — on a missing field clients
fall back to their local derivation, so an aggregates-free response can never misreport
`not_started` / `pr_*`. The "current cycle" precedence:

1. **Open/draft PR** — the linked `activePullRequest` when open/draft, else the most recently
   updated open/draft entry in `pullRequests` — yields `pr_ready` (`mergeable == true` and not
   draft) or `pr_open`.
2. **Open tasks remain** (`completed < total`) → `in_progress` when any task has started
   (`inProgress > 0` or `completed > 0`), else `not_started`.
3. **Latest PR merged** (the linked PR, else the most recently updated `pullRequests` entry) →
   `pr_merged`.
4. **All tasks complete** (`total > 0`, `completed == total`) → `complete`; else `not_started`.

A merged PR in history never masks an open PR (step 1 scans `pullRequests` for open/draft
entries) or open tasks (step 2 precedes the merged check). Transitions are pushed as
`workspace:displayStatus-changed` (§6.5); the emit-path enrichment also seeds the in-memory
baseline that event's recompute-and-compare runs against (a seed never emits).


```json
// → request — dismiss the blue-dot attention flag
{ "jsonrpc":"2.0","id":2,"method":"workspace.dismissAttention","params":{ "workspaceId":"ws-abc" } }
// ← response (attention reset; emits workspace:attention-changed)
{ "jsonrpc":"2.0","id":2,"result":{ "workspace":{ "id":"ws-abc","activity":"idle","attention":"none" } } }
```

**Workspace chat-context items (`workspace.getContext` / `updateContext`, new in intentd).**
Migrates the renderer-only `localStorage["workspace:context:{workspaceId}"]` store (attached
files/notes/URLs, Linear/GitHub/Sentry issues surfaced in the chat context panel) into
daemon-owned rows so the surface is queryable by MCP tools and other clients. The daemon
treats each item as an **opaque JSON blob** authored by the FE — the `ContextItem` union in
`packages/cloudlands-fe/src/features/context/types.ts` — and only pulls `id` out for keying
and ordering. `updateContext` is a full-list replacement (matches the FE's collapsed
`hydrate/add/remove/update` write pattern) and preserves the caller-supplied order. Every
successful `updateContext` emits `workspace:context-changed` with the persisted list
(§6.5), so subscribers refresh without a follow-up `getContext`.

- **ContextItem** — `{ id: string (required, non-empty), ...extras }`. `id` is the row key
  and the only field the daemon inspects; every other field (`type`, `provider`, `title`,
  `url?`, `parentNoteId?`, `createdAt`, `updatedAt`, plus provider-specific extras such as
  `identifier`, `number`, `favicon`, `noteId`, `isSpec?`, `taskStatus?`) round-trips
  verbatim. The FE's union types are the source of truth.

```json
// → request — write the authoritative list
{ "jsonrpc":"2.0","id":10,"method":"workspace.updateContext","params":{
  "workspaceId":"ws-abc",
  "items":[
    { "id":"ctx-1","type":"linear-issue","provider":"linear","title":"ENG-42",
      "identifier":"ENG-42","createdAt":"2026-07-13T00:00:00Z","updatedAt":"2026-07-13T00:00:00Z" }
  ]
} }
// ← response (emits workspace:context-changed)
{ "jsonrpc":"2.0","id":10,"result":{ "items":[ /* same list */ ] } }
```

### 5.2 `note.*`

All `note.*` methods require `workspaceId`. All except `list` and `create` additionally require `noteId` (`list` returns every note; `create` mints a new id). The spec note is addressed with the well-known id `"spec"`.

| Method | Params | Result |
| --- | --- | --- |
| note.list | workspaceId (req) | { notes: NoteSummary[] } |
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
| note.saveAsset | data (req, base64 — a `data:<mime>;base64,` URL prefix is accepted and stripped), mimeType (req), originalName? | { assetId, path, url } — **additive asset write** (no `noteId`; ports the legacy `assets:save` IPC behind note image paste/upload). Writes the decoded bytes under the workspace assets root plus an `<assetId>.meta.json` sidecar (`{ id, originalName, mimeType, size, createdAt }`); `assetId` is `<timestamp36>-<hash8><ext>` with `<ext>` derived from `mimeType` (default `.png`), `url` is `workspace-asset://<workspaceId>/<assetId>` and round-trips through `note.readAsset`. `-32602` on missing params; `-32603` on invalid base64 or when asset storage is not configured |
| note.listVersions | noteId (req) | bare array of `{ type:"snapshot", v, date, author:{id,name,type}, title, contentLength }` ascending by `v` |
| note.getVersion | noteId (req), v (req,int) | `{ type:"snapshot", v, date, author, title, content }` — -32602 if the version does not exist |
| note.restoreVersion | noteId (req), v (req,int) | { ok, noteId, restoredFrom, v, note } — resets title+content to version `v`, bumps `rev`, appends a new version capturing the restored state |

```json
// → request
{ "jsonrpc":"2.0","id":7,"method":"note.add",
  "params":{ "workspaceId":"ws-abc","noteId":"spec","content":"## Phase 2\nDraft","position":"end" } }
// ← response
{ "jsonrpc":"2.0","id":7,"result":{ "ok": true, "noteId":"spec" } }
```

**Version history (deliberate divergence from the FE).** The FE's file-based store
appended mixed snapshot/diff entries to a `.versions/<noteId>.jsonl` sidecar
(`SNAPSHOT_INTERVAL = 10` diffs between full snapshots). The daemon stores **every
version as a full snapshot** in the `note_version` table instead — content sizes are
note-scale, SQLite holds blobs natively, and full snapshots make `getVersion`/
`restoreVersion` O(1) with no diff-chain replay. The FE cap is kept: on append the
store prunes to the newest **50** versions per note (`MAX_NOTE_VERSIONS`). Versions are
captured on every content mutation (`note.create`, `note.update` with `content`,
`note.add`, `note.edit`, `note.editLines`, `note.setContent`, `note.restoreVersion`);
metadata-only updates do not create versions. `note.*` writes carry no author context
on the wire yet, so every version is stamped with the system author
(`{ id:"system", name:"intentd", type:"system" }`).

**CRDT merge on full-content writes (§5.2 / A5).** `note.setContent` and the
content arm of `note.update` are **not** last-write-wins: incoming content is
routed through a per-note `yrs` (Rust Yjs) document seeded from the note's
stored content on first touch, and each write applies a single-hunk char-level
diff (common UTF-16 prefix / suffix trimmed) inside a `yrs` transaction. The
merged `Y.Text` output is what the daemon cleans and persists, so two
concurrent full-content writes whose diffs target different regions both
survive in the stored content. The CRDT state is **session-only** — never
persisted, sweepable after 24 h idle, keyed by `(workspaceId, noteId)`. The
surgical mutations (`note.add`, `note.edit`, `note.editLines`, `note.restoreVersion`,
`task.updateStatus`, `task.update`, `task.convertBlocks`, `comment.add`) write
straight to storage and invalidate the cached session so the next full-content
write reseeds from the fresh persisted content; `note.delete` drops the
session. The wire shapes on §5.2 are unchanged.

### 5.2.1 `note.lineAttribution.*`

Per-line attribution over the daemon's full-snapshot version history (§5.2). Ports the FE
`LineAttributionService` that backed the tiptap `LineAttributionGutter`, so a client can
render "who last touched each line" without re-implementing the diff.

| Method | Params | Result |
| --- | --- | --- |
| note.lineAttribution.load | noteId (req) | `LineAttributionData \| null` — see payload below; `null` when the daemon has not computed attributions yet |
| note.lineAttribution.computeNow | noteId (req) | `{ ok: true }` — force an immediate recompute + persist + `line-attribution:updated` emit (bypasses the debounce) |

**Payload shape (`LineAttributionData`).** Identical to the FE JSON the
`line-attribution:load` IPC handler served, so `LineAttributionGutter.svelte` decodes it
unchanged:

```json
{
  "noteId": "…",
  "workspaceId": "…",
  "computedAt": "2026-07-05T12:34:56.000Z",
  "attributions": {
    "1": { "timestamp": 1720193696000,
            "author": { "id": "system", "name": "intentd", "type": "system" } },
    "2": { "timestamp": 1720193710000,
            "author": { "id": "agent-…", "name": "Assistant", "type": "agent" } }
  }
}
```

Keys of `attributions` are stringified 1-based line numbers (only lines the algorithm
attributed to a stored version are present). `timestamp` is milliseconds since the Unix
epoch. `author.type` is `user` / `agent` / `system`; `turnNumber` is emitted when
available (currently omitted because `note.*` writes still stamp the system author —
see §5.2 version-history extensions).

**Recompute lifecycle.** Every content-changing `note.*` mutation schedules a debounced
recompute (5 s, mirroring `LineAttributionService.DEBOUNCE_MS`). A fresh mutation cancels
any pending timer so a burst of writes coalesces into one persist + one
`line-attribution:updated` emit (§6.5). The emit is **transient / broadcast-only**
(published through the same transient path as `agent:stream:chunk`, §7): it is never
written to the event table, so it does not appear in `event.query` or the other §5.10
historical reads (migration `0052_delete_line_attribution_events.sql` deletes legacy rows
on existing installs). The durable state remains the `note_line_attribution` row —
one row per note (SQLite migration `0028_note_line_attribution.sql`), upserted on
each recompute so the read path is O(1) and survives restart. `note.delete` cascades.

### 5.3 `comment.*`

| Method | Params | Result |
| --- | --- | --- |
| comment.add | noteId (req), searchContext (req), commentTarget (req), comment (req), type?, author?, authorType? ("user" \| "agent", default "agent"), idempotencyKey?, commentId? (UUID) | { success, message, commentId, anchored, noteRev, location: { line, anchoredText } } (anchors by text search). A replay with the same `(workspaceId, idempotencyKey)` returns the stored result without re-executing (no duplicate comment, no second `comment:added` / `note:updated`); empty/whitespace-only keys are treated as absent. When `commentId` is supplied, the daemon uses it as the canonical id — comment row, `threadId`, anchor `startId`/`endId`, and the embedded `<!--anchor:{id}:start/end-->` markers — instead of minting a fresh UUID, so a client that already inserted optimistic editor anchors under that id converges with the daemon's note rewrite. A non-canonical-UUID value (only the hyphenated 8-4-4-4-12 form is accepted; e.g. the 32-hex simple form is rejected) or a collision with an existing comment id is rejected with `-32602` InvalidParams (after the idempotency replay check, which still returns the cached result first). Omitting it keeps the mint-a-UUID behavior. |
| comment.list | noteId (req), since?, authorType?, status?, includeComments? | { threads: [...] } |
| comment.getThread | noteId (req), threadId? or commentId? | { thread } |
| comment.respond | noteId (req), comment (req), threadId? or commentId?, type?, author?, authorType? ("user" \| "agent", default "agent"), suggestionOriginal?, suggestionProposed? | { ok, ... } — the reply carries **no** `anchor`/`anchorText` (see "Reply anchoring" below) |
| comment.delete | noteId (req), commentId (req) | { ok, ... } |

**Anchor resilience on note edits (Audit D H1+M1).** `comment.add` embeds
`<!--anchor:{commentId}:start-->` / `<!--anchor:{commentId}:end-->` markers into the
note markdown around the anchored span, and captures up to 50 characters of
surrounding text as `anchorBefore` / `anchorAfter` on the persisted comment
(reference `extractAnchoredText` in `markdown-anchor-recovery.ts`). Every
content-changing `note.*` mutation (`note.update`, `note.add`, `note.edit`,
`note.editLines`, `note.setContent`) then runs the rewritten markdown through a
recovery pass before persist: healthy anchors are left alone; partial anchors
(only one marker surviving) are relocated using the stored `anchorBefore` /
`anchorAfter` context; unrecoverable and degenerate anchors have their stray
markers scrubbed from the persisted content and the comment is flipped to
`isOrphaned: true`. Comments in the wire `Comment` shape carry an optional
`isOrphaned: bool` field (omitted when unset, `true` for orphaned comments,
`false` explicitly when a previously-orphaned comment heals).

**Overlapping ranges + phantom-marker scrub (intentd#541).** Overlapping
comment ranges are allowed: a `comment.add` target span may contain other
comments' `<!--anchor:…-->` markers, producing interleaved pairs
(`a:start … b:start … a:end … b:end`) that are valid note content — each
comment's own id still pins its markers, and interleaved anchors stay
healthy. The add embeds the raw span (contained markers intact, in place)
back between the new pair, while the STORED `anchorText` / `anchorBefore` /
`anchorAfter` fields are stripped of all `<!--anchor:…-->` substrings —
markers are stripped from the full prefix/suffix before the 50-character
context window is taken, so a marker adjacent to the span cannot leak a
clipped fragment — and raw marker text never appears in comment rows. The
recovery pass additionally scrubs **phantom markers**: after the per-comment
classification above, any UUID-format marker whose id has no live
(non-orphaned) comment row — an id with no comment row at all, or markers
left behind by a row already flagged `isOrphaned` — is removed from the
persisted content, so a polluted note self-heals on its next content-changing
`note.*` mutation. `comment.add` runs the same scrub on the fetched note
content before matching, so phantom debris can never block a new comment; the
cleaned content persists only as part of the add's atomic note rewrite (a
failed add changes nothing — no separate rev bump). Non-UUID
marker-lookalikes (documentation literals such as
`<!--anchor:{id}:start-->`) are ordinary user content: commentable, and never
scrubbed. This is also why a client-supplied `commentId` must be a
**canonical hyphenated** UUID — the phantom scrub only recognizes canonical
ids inside markers, so a looser spelling would mint markers the scrub could
never recognize or clean up once the comment row is gone.

**Note rewrite visibility (monorepo#638).** Because `comment.add` rewrites the
note markdown (anchor-marker insertion is an `update_note` that bumps the
note's `rev`), the result echoes the authoritative post-rewrite revision as
`noteRev`, and the daemon publishes a `note:updated` change event (§6.5, with
the usual `{ noteId, title, action: "update" }` payload) in addition to
`comment:added` — so subscribed clients refresh their cached note/rev instead
of hitting a spurious conflict on their next versioned write. The note rewrite
and the comment insertion commit atomically in one store transaction: a
failure can never leave anchor markers embedded in the note with no comment
row. An idempotent replay returns the cached `noteRev` and emits neither
event.

**Tolerant anchoring + actionable errors.** `comment.add` first attempts an
exact substring match of `searchContext` against the note markdown. When no
exact occurrence exists, it retries against a *plaintext projection* of the
markdown (heading/list/blockquote markers, emphasis/code delimiters, link
syntax — keeping link text — HTML comments including existing anchor markers,
and all whitespace stripped, with a byte map back to the source), so anchors
derived from an editor's rendered plain text (e.g. tiptap `textBetween`, which
joins blocks with no separator) anchor correctly onto the formatted source.
Uniqueness rules are identical on both paths: an ambiguous `searchContext` or
`commentTarget` is rejected. All anchoring failures (context not found /
ambiguous, target not in context / ambiguous) and the empty-field validations
(`comment`, `searchContext`, `commentTarget`, invalid `authorType`) return
`-32602` with a descriptive message, **not** `-32603 "Internal error"`.
`comment.respond`'s caller-input checks follow the same rule: missing
`threadId`/`commentId` (at least one is required), an empty/whitespace-only
`comment`, and `type: "suggestion"` without both `suggestionOriginal` and
`suggestionProposed` are all rejected with `-32602`. The
optional `authorType` param on `comment.add` **and** `comment.respond` sets
the persisted comment's `authorType` (defaulting `author` to `"User"` /
`"Agent"` accordingly when absent); omitting it keeps the backward-compatible
`agent` default, and an invalid value is rejected with `-32602`.
`comment.getThread` and `comment.resolveThread` apply the same missing-id
validation: providing neither `threadId` nor `commentId` is rejected with
`-32602` ("Either threadId or commentId must be provided"), and
`comment.list`'s filter validations — a non-ISO-8601 `since`, an `authorType`
other than `user`/`agent`, and a `status` other than `open`/`resolved`/
`pending` — are likewise `-32602` (monorepo#649). Lookup failures are **not**
caller-input errors and stay `-32603`: an unknown `commentId` ("Comment not
found: …") or unknown `threadId` ("Thread not found: …") on
`comment.getThread`/`comment.resolveThread` returns `-32603 Internal error`.

**Reply anchoring (monorepo#729).** Only **root** comments carry an
authoritative `anchor` / `anchorText`: `comment.add` embeds the anchor markers
and persists the anchor on the root it creates. Replies created via
`comment.respond` anchor through their thread — `threadId` / `parentId` — and
never independently, so the persisted reply has no anchor and the wire
`Comment` shape **omits** the `anchor` and `anchorText` keys (both fields are
optional on the wire). Clients resolving a thread's position in the document
must read the thread root's anchor (the FE's anchor reconciliation already
does exactly this). Replies stored before this contract change may still carry
a legacy clone of the parent's anchor; clients must treat any reply anchor as
non-authoritative.

**Thread resolution.** One additional method addresses an entire thread by `threadId` **or** `commentId`. Emits the `comment:resolved` event (§6.5).

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

**Task-note status vocabulary.** `task.updateNoteStatus` (and the task-note `status` served
by every task projection) accepts `not_started | waiting | discussion_needed | blocked |
in_progress | review_required | complete | cancelled`. `blocked` *(new in intentd)* is
raised by the MCP `ws.agent.reportBlocker` binding (§5.5 agent attention requests) when an
agent reports an infrastructure/environment blocker it cannot resolve; like
`discussion_needed`, it is non-terminal and excluded from `inProgress` in the
`computeTaskStats` rollups (§5.1 card aggregates / `task.list` stats).

**Task projections & bulk cleanup.** Two read methods project a workspace's spec-linked task notes into the canonical `WorkspaceTask` shape, and one bulk write clears an agent from every task in a workspace.

| Method | Params | Result |
| --- | --- | --- |
| task.list | workspaceId (req), status? | { tasks: WorkspaceTask[], stats: WorkspaceTaskStats } — optional `status` filter; `stats` is the `{ total, completed, inProgress }` aggregate (§5.1 card aggregates — same `computeTaskStats` projection: `cancelled` is excluded from `total`, `complete` counts as `completed`, `in_progress` + `review_required` count as `inProgress`) served alongside the filtered task list |
| task.get | workspaceId (req), taskNoteId (req) | { task: WorkspaceTask } — unknown id → `-32602 Task not found` |
| task.removeAgentFromAllTasks | workspaceId (req), agentId (req) | { ok, updatedCount } — strips `agentId` from every task-note's `assignedAgentIds` in the workspace; called from agent teardown (delete-agent, wake-or-create stale-assignment cleanup). Idempotent: absent `agentId` → `updatedCount: 0`. |
| task.linkAgent | workspaceId (req), noteId (req), taskText (req), agentId (req), taskKey? | { link: TaskAgentLink } — upsert on `(workspace_id, note_id, task_key)`. `taskKey` defaults to `taskText` when omitted, matching the FE derivation `association.taskKey ?? association.taskText`. `createdAt` is set to the current epoch-ms. Emits `task:agent-linked`. |
| task.unlinkAgent | workspaceId (req), noteId (req), taskKey (req) | { removed: boolean } — deleting an unknown row is not an error (`removed: false`); an actual delete emits `task:agent-unlinked`. |
| task.listAgentLinks | workspaceId (req) | { links: TaskAgentLink[], linksByNoteId: Record<noteId, Record<taskKey, TaskAgentLink>> } — flat oldest-first list plus the FE-parity `byNoteId → byTaskKey` map so hydration is a mechanical cut-over from `localStorage["task-agent-associations:{wsId}"]`. |

**`task.*` linkage types.** `task.linkAgent` / `unlinkAgent` / `listAgentLinks` migrate the
renderer-only `taskAgentAssociations` slice into daemon-owned rows so MCP tools and other
clients can ask "who is working on this task?".

- **TaskAgentLink** — `{ workspaceId, noteId, taskKey, taskText, agentId, createdAt }`.
  `taskKey` mirrors the FE key (`association.taskKey ?? association.taskText`);
  `taskText` records the human-readable checkbox text at link time; `createdAt` is
  epoch-ms (FE parity with `TaskAgentAssociation.createdAt: number`).

```json
// → request — link an agent to a task
{ "jsonrpc":"2.0","id":12,"method":"task.linkAgent","params":{
  "workspaceId":"ws-abc","noteId":"spec","taskText":"Ship it","agentId":"agent-alpha"
} }
// ← response (emits task:agent-linked)
{ "jsonrpc":"2.0","id":12,"result":{ "link":{
  "workspaceId":"ws-abc","noteId":"spec","taskKey":"Ship it","taskText":"Ship it",
  "agentId":"agent-alpha","createdAt":1750000000000
} } }
```

### 5.5 `agent.*`

The largest namespace. Every `agent.*` method is served daemon-primary by `intent-services` via the `intent-transport` router; no renderer-owned agent transport remains. `agentId` values are **server-assigned** and of the form `agent-{uuid}`.

| Method | Params | Result |
| --- | --- | --- |
| agent.list | workspaceId (req) | { agents: AgentLite[] } — messages/systemPrompt stripped; adds messageCount, lastAgentResponse, lastUserMessage, digest, lastActivity, isStreaming/isProcessing/isResponding, session-level contextReferences?/imageBlocks? (persisted at spawn; omitted when absent), and a nested metadata { isBackground, specialist?, createdByAgentId?, taskNoteId?, completionReport?, completionReportTimestamp?, attentionRequestKind?, attentionRequestReason?, attentionRequestTimestamp?, delegationDepth?, initialMessage? } (the P3-1.2b persistence-gap fields plus the pending attention request raised by `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` — see the agent-attention-requests block below; omitted when absent). `metadata.isBackground` is served from the persisted session flag (harvested at spawn; G-A1/P3-1.2c) so rehydrated background agents stay background. **Turn-liveness (STAB-125, additive):** `turnInFlight: bool` is `true` while an active worker is draining a `session/prompt` turn for the agent, and `lastStreamActivityAt` (RFC-3339; omitted when no turn is in flight) is the timestamp of the most recent stream event observed for that turn — a long turn persists nothing until it ends, so these let a poller tell a long-but-alive turn (timestamp advancing) from a wedged agent (timestamp pinned) while `lastActivity` stays pinned at the last persisted message. Caveat: the stamp only advances on stream traffic, so during a long silent tool call it pins too — combine with `isWaitingOnTool` to avoid misclassifying a healthy-but-slow tool turn. **Corrupted-session flag ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940), additive):** `sessionCorrupted: true` is present only when the session is parked in `error` (`status == "error"` is required for BOTH causes) AND either (a) the failure classifies as session-fatal (provider safety block, deterministic `session/prompt` 400 `invalidArgument` rejection) or (b) the consecutive-identical-failure streak hit the poisoned threshold — the structured signal that `agent.retry` will recreate the provider session (fresh `session/new`) instead of resuming, or that spawning a fresh agent is the right recovery. **Derived on emit** over the persisted (status, stop_reason) + the in-memory failure streak — never persisted as a column — and **omitted when `false`** (absent ≠ present-false on the wire) |
| agent.get | agentId (req), workspaceId? | { agent: AgentLite } — same projection as agent.list (including the STAB-125 `turnInFlight`/`lastStreamActivityAt` turn-liveness fields and the derived monorepo#940 `sessionCorrupted?` flag); -32602 if not found (falls back to disk) |
| agent.getConversation | agentId (req), limit?: number, nextToken?: string, workspaceId? | { agentId, messages, truncated, totalMessages, nextToken, turnInFlight, lastStreamActivityAt } (capped to most-recent limit; `nextToken` is the opaque cursor for the next older page — `null` when no more history remains, non-null iff `truncated` is `true`; pass it back as the `nextToken` input to fetch the next page). `turnInFlight`/`lastStreamActivityAt` are the STAB-125 turn-liveness fields (same semantics as `agent.get`; `lastStreamActivityAt` is `null` when no turn is in flight) so a conversation read mid-turn — when nothing has persisted yet — is distinguishable from a wedged agent |
| agent.create | workspaceId (req), name?, nameExplicitlySet?: bool, model?, specialistId?, idempotencyKey?, provider?, agentType?, metadata?, workspacePath?, workspaceContext?, contextReferences?, imageBlocks?, isBackground? | { agent: AgentLite } — full projection (same shape as `agent.get`); the pre-P2-12a `{ id, name }` snippet is a strict subset. The agent's id is **server-assigned**: the daemon always mints a fresh `agent-{uuid}`, and a request carrying `agentId` is rejected with `-32602` ("agent IDs are server-assigned and the field must be omitted") before any side effect; an `idempotencyKey` replay returns the stored result carrying the originally minted id. `provider` persists on the session; both the resolved provider (the explicit `provider` param or, when absent, the provider prefix derived from a compound `model` id) **and** — when the resolved model is a compound id (`provider:model`) — the model's provider prefix (validated even alongside a valid explicit `provider`, since the spawn path gives the model prefix precedence; a plain or absent `model` carries no prefix and adds no extra validation) must name a registered ACP provider: an unknown id is rejected with `-32602` (`agent.create: unknown provider: <id> (known providers: ...)`) **before any side effect** (no session row is persisted, no default-provider fallback occurs). An absent provider (defaulting) remains valid. A **bare** `model` (no `:` prefix) supplied by the client is additionally checked for ownership: evidence is the static model catalog **unioned with the daemon's cached dynamic catalogs** (the in-memory last-good `models.list` entries under each provider's current registry version key, §5.30 — read-only, never a live probe). A static-tier claim by another provider rejects with `-32602` (`agent.create: model <id> does not belong to provider <p> (providers with this model: ...)`) before any side effect, unless the effective provider (explicit `provider` param or the default) itself claims the id (static or cached). A cached-catalog claim by another provider rejects only when the effective provider's ownership is affirmatively disproven — no static claim AND its own cached catalog exists but lacks the id; with no cached entry for the effective provider (cold start) the bare id passes — absence of evidence is not a mismatch. Bare ids with no ownership evidence anywhere pass unchanged, and the literal id `"default"` is a CLI-default sentinel that passes for every provider. A mismatched bare model arriving from the **settings chain** (global default / specialist frontmatter) rather than the client is not rejected — it falls back to the provider's CLI default (`session.model` stays unset) with a daemon warn log. **Name default (specialist-derived).** When `name` is omitted but a specialist id is supplied, the agent's name defaults to the specialist's resolved display name (frontmatter `name`, 3-tier project > user > bundled — e.g. "Coordinator" for `spec-writer`); an unknown specialist or a resolution failure never fails the create — the name falls back to the generated `Agent {6-hex}` placeholder. The same derivation applies to `workspace.create`'s `initialAgent` (§5.1). `nameExplicitlySet` controls the persisted rename-guard flag: `false` marks a supplied `name` as a non-explicit placeholder so the agent's guarded opening-turn self-rename (`agent.rename` with `skipIfExplicitlySet: true`) still applies. The flag is honored independently of `name` — supplied without a `name`, it applies to the server-generated placeholder name (`nameExplicitlySet: true` with no `name` persists the guard on the placeholder). Omitted or JSON `null` both read as absent and keep the default (`true` whenever a `name` is supplied **or** a specialist-derived default name resolved — the derived default behaves like a client-supplied explicit name, matching the desktop FE which resolves it client-side; `false` otherwise, including the `Agent {6-hex}` fallback); any other non-boolean value is rejected with `-32602` ("nameExplicitlySet must be a boolean") — `null` is never rejected. `metadata` is harvested for the persisted gap fields (`delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`; P3-1.2b — plus `isBackground`, G-A1/P3-1.2c) with the top-level `contextReferences`/`imageBlocks`/`isBackground` params winning over the `metadata` copies; `isBackground` defaults to `false` when absent from both. `agentType`/`workspacePath`/`workspaceContext` remain accepted-but-unpersisted (deferred per the P2-12a audit). Emits `agent:created`. |
| agent.delegate | workspaceId (req) + delegate opts (taskNoteId?, noteId?, taskText?, agentInstructions?, specialist?, model?, behaviorPrompt?, waitMode?, skipAutoCommit?, isolation?) | `{ ok: true, agentId, name, effectiveIsolation? }` — the child session persists `metadata.initialMessage` (the resolved first message) and `metadata.delegationDepth` (parent depth + 1) so a wake-up can resume (P3-1.2b); delegated children always persist `isBackground: true` (matching the TS `DelegateTaskTool`; G-A1/P3-1.2c). **Sandbox isolation (new in intentd).** `isolation` controls whether the delegated agent runs in an isolated sandbox: `"cow"` provisions a copy-on-write directory clone (requires CoW filesystem support; see below), `"direct"` runs in the shared workspace checkout. When `isolation` is omitted, the default comes from the `workspace.cowIsolation` setting (§5.12): enabled ⇒ `"cow"`, disabled ⇒ `"direct"`. CoW sandboxes are full-directory clones of the sandbox source (including `.git` and build caches) via OS-level copy-on-write primitives (macOS `clonefile(2)` whole-tree fast path with best-effort walk fallback on APFS, Linux `ioctl(FICLONE)` on Btrfs/XFS with reflink support); the sandbox directory layout is `<workspaces_root>/<workspaceId>/sandboxes/<agentId>/<repo-slug>` with a snapshot branch `sb/<agentId>` created in the sandbox's `.git`. **Sandbox eligibility & source (checkout-mode aware).** Direct-mode workspaces (`skipIsolation`/no provisioned checkout, with a `repositoryPath`) source the sandbox from the user's repository folder; CoW-checkout workspaces (`checkoutMode: "cow"`, §5.1) source it from the **workspace checkout** (`worktreePath`). Worktree-mode workspaces (`checkoutMode: "worktree"`) are not sandbox-eligible — the agent keeps the shared checkout and the delegation proceeds without a sandbox. **Asynchronous provisioning & `effectiveIsolation` (changed by intentd#636).** Sandbox provisioning runs OFF the delegate critical path: when `isolation: "cow"` resolves and the workspace is sandbox-eligible, the daemon registers a per-agent settlement gate, kicks off the CoW clone in a background task, and returns immediately with `effectiveIsolation: "pending"` — the only value the field carries today (`"cow"` and `"direct"` are no longer returned; a large clone can take tens of seconds, which previously starved the agent-facing MCP `workspace_api` tool's per-invocation wall-clock budget — `WORKSPACE_API_TIMEOUT`, default 30s, overridable via the `INTENTD_WORKSPACE_API_TIMEOUT_MS` env var: a positive integer in milliseconds, read at MCP-server construction; unset, non-numeric, or non-positive values keep the default). `effectiveIsolation` is omitted when no CoW isolation was resolved (explicit `"direct"`, setting disabled, the worktree-mode ineligibility skip, or no sandbox source). The settled outcome is observable rather than returned: on success the child session's TOP-LEVEL fields (not nested under metadata) `sandbox_id`, `sandbox_path`, and `sandbox_branch` are persisted and served in both `AgentSession` and `AgentLite`, and a `sandbox:cow:created` event is emitted with `data { workspaceId, agentId, sandboxPath, branch, baseCommitSha, snapshotCommitSha }`; when the filesystem does not support CoW reflinks — or provisioning fails — the daemon falls back to shared (`"direct"`) mode exactly as before (no bytes copied, log-only): the session keeps no sandbox fields and no `sandbox:cow:created` fires. A third settlement outcome covers the delete race: because the clone runs off the delegate critical path, `agent.delete` can race it — when the child session is gone or soft-deleted by settlement time, the daemon discards the just-provisioned sandbox (directory + store record) instead of stranding the clone on disk; again no sandbox fields persist and no `sandbox:cow:created` fires. The child's first ACP spawn is gated on settlement: its turn worker awaits the in-flight provisioning before spawning, so the child never runs against a half-copied sandbox. The sandbox directory is never auto-cleaned once settled — except for the delete-race discard above — cleanup is otherwise the responsibility of higher-level orchestration. All agent file/exec/terminal/search operations are restricted to the sandbox path when present (logical containment guards in `intent-services`), preventing escape to the main workspace or parent directories |
| agent.sendToTask | taskNoteId (req), message (req), priority?, messageMetadata? | service result — `priority: "interrupt"` preempts the assignee's in-flight turn keep-alive (the agent process is never killed) and delivers immediately instead of the plain persist. `messageMetadata` is the same opaque per-message payload as `agent.sendMessage`, persisted on the assignee's user message row; it is threaded through both the runtime turn path and the store-only fallback (read-only wiring with no agent manager), so attribution is consistent across deployments. **Question hold (v2.8):** sendToTask is an automatic delivery by definition — while the assignee's question hold is active (see "Question hold" below) the message parks in the queue instead of delivering, `priority: "interrupt"` included (the interrupt skips the preemption entirely and parks front-of-queue with `interruptPriority: true`); the parked result is `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId? }`, on the runtime and store-only paths alike |
| agent.sendMessage | agentId (req), content (req), workspaceId (req), messageId?, imageBlocks?, fileBlocks?, priority?, noteIds?, stdinContext?, contextReferences?, messageMetadata?, model?, assistantMessageId?, assistantAppMessageId?, userAppMessageId? | { success, queued, messageId? \| queuedMessage?, turnId? } — **Unknown agent → fail closed.** A nonexistent `agentId` (e.g. a truncated id) is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE any state change — no phantom queue entry, no slot claim, no interrupt-dedup record — on both the runtime-manager and store-only paths, and the same guard applies to the SUB-1 sender auto-subscribe (the MCP `agent.send` binding's caller→target completion watch is never registered for a nonexistent target). The auto-queue-on-failure fallback below applies only to store-append failures on an EXISTING agent (e.g. a duplicate client-supplied `messageId`); an agent deleted mid-send (between the validation and the append) is also rejected with the same `-32602` instead of auto-queueing. `priority: "interrupt"` preempts an in-flight turn instead of queueing: the current turn is cancelled keep-alive (`session/cancel` + one terminal `agent:stream:end`; the agent process is never killed) and the message streams immediately as a fresh turn on the same session (`queued: false`); the pending queue is preserved and drains afterwards. On an idle agent, interrupt priority falls through to the normal send path. **Zero-output interrupt → combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)):** when the preempted turn produced no assistant output (the provider drops the cancelled prompt), the preempted user message's text and attachments are delivered AHEAD of the interrupt message inside the SAME `session/prompt`, so both messages are honored in original order — the original is NOT re-queued, the queue stays untouched, and both already-persisted user rows stay intact (the combined prompt is wire-only, never re-persisted). If the turn has already progressed (any assistant/tool/system row after the last user row), only the interrupt message is delivered. This combined-delivery behavior applies to ALL interrupt-priority sends — `agent.sendToTask` with `priority: "interrupt"` routes through the same preemption path and behaves identically. **Duplicate delivery** of the SAME interrupt (same client-supplied `messageId`) preempts exactly once: the duplicate is acknowledged idempotently as `{ success: true, queued: false, messageId, deduplicated: true }` — no second preemption, message NOT double-persisted (dedup keys on `messageId`; omit it and duplicates are indistinguishable from new sends). **During turn startup** (busy slot claimed but no cancellable turn live yet — spawn/`session/new` in flight) the preemption is skipped and the message queues keep-alive behind the starting turn (`queued: true`); the agent is never killed and never fails. **Per-turn prompt-assembly hints (Fidelity B).** `stdinContext` is prepended verbatim to the outbound prompt as a `Context:\n<stdin>\n\n---\n\n` block (reference-parity `acp-provider.ts`); when absent, one is synthesised from `contextReferences` (port of `agent-backend-handler.service.ts`’s builder — first-non-empty wins across `content` / `selectedText` / `taskText` / `codeChunk`, with per-`type` framing for `selection` / `task` / `code_chunk` / `file` / `linear-issue` / `github-issue` / `sentry-issue` / `terminal`; unknown types fall through to the raw content). `noteIds` are resolved to workspace-asset image content blocks: each note's markdown is scanned for `workspace-asset://<workspaceId>/<assetId>` URLs in the current workspace, the referenced bytes are appended as ACP `image` blocks, and a single system text notice is added noting how many images were inlined. `messageMetadata` is opaque JSON persisted on the user message row (new `agent_message.metadata` column) and echoed on read — used by clients (e.g. `{ source: "system" }`) to distinguish daemon-initiated turns; the daemon never inspects its shape. **Row identity + events.** A direct (non-queued) send persists the user row UNDER the client-supplied `messageId` when given (validated ≤ 256 bytes, `-32602` otherwise) — else a server-minted `user-msg-{uuid}` — the result `messageId` IS that persisted row id, and the daemon emits `agent:message` `{ agentId, messageId, role: "user", appMessageId? }` for the append (`appMessageId` present only when the row carries a `userAppMessageId`) (same event the queue-drain and wake-delivery persists emit), so clients converge on the canonical row without a refetch race. **Sender attribution (`agent_message`, new in intentd).** Agent-originated sends through the MCP host bindings — `ws.agent.send`, `ws.agent.sendToTask`, and the `ws.agent.create` kickoff message — are auto-tagged by the daemon with `messageMetadata = { "type": "agent_message", "fromAgentId": string, "fromAgentName": string \| null }` so recipients and clients can attribute who sent the message. An explicit caller-supplied `messageMetadata` always wins over the auto-tag (a `null` value is treated as absent and does NOT suppress it); `fromAgentName` is always present for a stable schema and is `null` when the sender's session lookup fails. Human-originated FE/RPC sends (no agent caller, no explicit metadata) stay untagged. The tag persists on the user message row and survives the busy-agent queued path — the enqueue captures it and the drain-time persist writes it — including the store-only fallback. **Client message identity (`userAppMessageId`).** The FE’s client-minted optimistic-message id is consumed by the router: it is trimmed, validated ≤ 256 bytes (`-32602` otherwise; whitespace-only reads as absent), folded into the row `messageMetadata` under `userAppMessageId` (the top-level param wins over a caller-supplied metadata copy; supplying it alongside a non-object `messageMetadata` is `-32602`), lifted back out as the top-level `appMessageId` field on `AgentMessage` reads (`agent.getConversation` / `agent.getSession`), and echoed as `appMessageId` on the user-row `agent:message` event — activating the FE’s optimistic-insert dedup guard. The id survives the busy-agent queued path (enqueue capture → drain-time persist) but is excluded from the drain persist’s in-block `messageMetadata` copy (row-level only) so queued rows’ content blocks match direct-send rows. Requests without it are byte-for-byte unchanged (no `appMessageId` key on rows or events). **Daemon-ignored fields (FE-forwarded, unwired daemon-side).** The assistant-side ids (`assistantMessageId` / `assistantAppMessageId`) are accepted by the router but not consumed: assistant rows are keyed on the server-minted row `id`. Per-turn `model` override is likewise accepted but **not extracted** by the daemon router today; the session-level model set at `agent.create` / `agent.setModel` remains authoritative (deferred pending an ACP-provider-side change to switch model mid-session). **Turn correlation (`turnId`, [monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022) / [intentd#699](https://github.com/intent-hq/intentd/pull/699)).** Every runtime result arm additionally carries `turnId` — the daemon-minted stable correlation id for the user-initiated turn. A direct (non-queued) send mints it at dispatch, BEFORE the persist, so the user-row `agent:message` echo, the RPC result, and the turn's lifecycle events all carry the SAME id; the queued arms (busy-agent, quarantined, auto-queue fallback) return the enqueued entry's `turnId` (= the entry `id` at first enqueue). The id is preserved across terminal-failure requeues — the requeued entry gets a NEW entry `id` but keeps the failed turn's ORIGINAL `turnId` — so the `agent:failed` / terminal `agent:stream:end` of the failed turn AND the `agent:queue:processing` / lifecycle events of an `agent.retry` redrive all correlate with the id the client keyed at send time (§6.5/§6.6). Exceptions: the idempotent duplicate-interrupt ack (`deduplicated: true`) and the store-only fallback's direct arm carry no `turnId` (the store-only auto-queue arm does). Always omitted when absent, never `null`. **Question hold (v2.8).** The FE/router `agent.sendMessage` front door is a **user-origin** send and is never held — it bypasses an active hold, delivers (or queues on the normal busy path), and its user row releases the hold. Internal **automatic** sends routed through the same turn machinery (MCP `ws.agent.send`, A2A wakes, event-subscription batches, scheduled deliveries) ARE gated: while the target's hold is active they park in the queue with the result `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId }` — `heldForQuestions: true` is the additive marker distinguishing a hold park from an ordinary busy-queue park, present only on held results (never `false`). An automatic `priority: "interrupt"` send is ALSO held — no exceptions — parking front-of-queue with `interruptPriority: true` (the interrupt-dedup record is still written first, so a duplicate replay while held — or after release — still acks `deduplicated: true` without double-enqueueing). See "Question hold" below the table for the derivation and release semantics |
| agent.sendQueuedMessageNow | agentId (req), messageId (req), workspaceId (req) | { success: true, queued: false, messageId, turnId } on the atomic send — the normal outcome; the full result is a union with two `{ success: true, queued: true, queuedMessage }` variants (slot-race and quarantined, described below), which carry the wire-shape `queuedMessage` (the entry, as `agent.getQueue` serves it) INSTEAD of a `messageId`, so clients must branch on `queued`. Atomically dequeues the pending-queue entry named by `messageId` and delivers it immediately with interrupt priority, **preserving the rest of the queue**. The method takes no content params: the delivered turn carries the entry's own captured payload (content, `imageBlocks`/`fileBlocks`, `messageMetadata` from enqueue time), and the result `messageId` is the entry id — which is also the persisted user row id. **Fail closed / not idempotent.** A nonexistent `agentId` is rejected with `-32602` (`unknown agent id: <id>`) BEFORE the queue is touched (same guard as `agent.sendMessage`); an absent queue entry is rejected with `-32602` (`queued message not found: <id>`) with NO side effects — deliberately NOT idempotent (unlike `agent.removeQueuedMessage`), so the client knows the atomic send did not happen. **Atomic dequeue + interrupt delivery.** The removal happens under the queue lock (no concurrent drain can deliver the same entry twice), and the shrunk queue is republished as `agent:queue:updated` (write-through persisted) before the turn starts. A busy agent is preempted keep-alive — the same `session/cancel` + worker-abort as `agent.sendMessage` with `priority: "interrupt"`; the agent process is never killed — and the zero-output combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)) applies identically: a preempted zero-output user message rides the delivered turn's prompt AHEAD of the entry content (an entry already carrying its own requeued prepend payload keeps that payload first, in transcript order). An idle agent starts the turn directly. The user row is persisted UNDER the entry id and the standard user-row `agent:message` event (`role: "user"`) is emitted; a terminal-failure requeued entry whose user row already reached the transcript is not re-appended (the delivery reuses the existing row). Stale queued-message redrives on delegated agents keep the #576 semantics documented under `agent.reportToParent` (report-clear suppression + `[SYSTEM NOTE]` annotation). **Queued outcomes (success, not errors).** When the in-flight slot cannot be claimed (turn startup, or a concurrent send won the race) the entry is restored at the FRONT of the queue — next to drain — and the result is { success: true, queued: true, queuedMessage }. A quarantined (poisoned, monorepo#840) session is not redriven: the entry stays in the queue untouched and the result is { success: true, queued: true, quarantined: true, queuedMessage } (`agent.retry` is the deliberate redrive); the absent-entry case is still `-32602`. **Never-lost guarantee.** On a user-row persist failure the entry is restored at the FRONT of the queue (durability state untouched, so a retry re-appends correctly) and `agent:queue:updated` is republished before the error surfaces. The store-only fallback (no agent manager attached) honors the same atomic contract — dequeue, persist under the entry id, emit `agent:message`, restore-at-front on failure — without starting a turn. This path emits **no** `agent:queue:processing` (§6.5 — that drain-start signal belongs to the queue-drain loop). **`turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)):** the delivered arm is `{ success: true, queued: false, messageId, turnId }` — `turnId` is the entry's preserved turn correlation id (the same id the enqueueing RPC returned), stamped on both the `agent:message` echo this delivery emits and the delivered turn's lifecycle events; the queued/quarantined arms' `queuedMessage` carries the entry's `turnId?` field per the `agent.queueMessage` wire shape; the store-only fallback's result carries no `turnId`. **Question hold (v2.8):** `agent.sendQueuedMessageNow` is an explicit user action — it is NOT gated by an active question hold, and the user row its delivery appends supersedes the pending questions (the hold derivation flips false), releasing the rest of the queue |
| agent.dismissQuestions *(v2.8)* | agentId (req), messageId (req), workspaceId (req) | { success: true, dismissedQuestionsMessageId } — dismiss the pending question set of the assistant message named by `messageId` (the message carrying the trailing `application/vnd.intent.question+json` resource blocks, §7) WITHOUT answering: persists the dismissal marker `dismissedQuestionsMessageId` in the session metadata (survives daemon restarts, so the dismissed set never re-surfaces), emits `agent:updated` with `{ agentId, dismissedQuestionsMessageId }`, and kicks the queue drain so deliveries parked by the question hold resume immediately (no waiting for the next end-of-turn drain). **The model is NOT notified** — no message is appended to the transcript, no turn starts, and the agent never learns the questions were dismissed (contrast with an answer, which is an ordinary user message). Idempotent: re-dismissing the same `messageId` succeeds and rewrites the same marker. Validation: an empty `messageId` or one exceeding 256 bytes is `-32602`; a nonexistent `agentId` or a workspace mismatch is a not-found error (fail closed, no metadata write). The `messageId` is NOT checked against the transcript — dismissing an id that carries no questions is a harmless no-op marker write (the hold derivation only consults the marker when the last non-system message actually bears question blocks) |
| agent.editAndRegenerate | agentId (req), messageId (req), content (req), workspaceId (req), imageBlocks?, fileBlocks?, model? | { success, queued: false, messageId, truncatedCount } — edit a past **user** message and regenerate from that point (additive `agent.*` extension). The result `messageId` is the freshly-minted server id of the NEW regenerated user message — NOT the input `messageId`, which names the edit target whose row (and everything after it) is dropped by the truncation; the two are never the same id. Orchestrated daemon-side, in order: (1) `messageId` is validated FIRST (must reference an existing user message in the transcript — unknown or non-user ids are rejected with `-32602` before any state changes; the transcript is untouched); (2) any in-flight turn is stopped (hard-cancel: the worker is aborted and the agent process killed) and the pending queue is discarded (a previously non-empty queue republishes `agent:queue:updated` as empty); (3) with `model` supplied, the session model is switched (same semantics as `agent.setModel`) before the regenerated turn; (4) the transcript is truncated to just BEFORE the edited message — the edited message and everything after it are dropped (destructive; fresh row ids / 0-based `seq` via the replaceMessages store machinery) and `agent:updated` is emitted with `{ truncatedCount, remainingCount }`; (5) the agent's ACP session is flagged for forced recreation — the next prompt SKIPS the `session/load` resume, opens a fresh `session/new`, and prepends the truncated prior history as `<supervisor>` XML (the provider must not retain the truncated turns in context; the forced-recreate flag survives intervening `agent.stop`s and is only consumed when a fresh session opens); (6) `content` is sent as a fresh user message (normal `agent.sendMessage` semantics; `imageBlocks`/`fileBlocks` ride along; the usual `agent:message` / `agent:stream:*` events follow) |
| agent.queueMessage | agentId (req), content (req), imageBlocks?, fileBlocks? | { success, queuedMessage, turnId } — **Unknown agent → fail closed.** A nonexistent `agentId` is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE enqueueing — no phantom queue entry that can never drain, no `agent:queue:updated` event (same guard contract as `agent.sendMessage`). QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority? } — `interruptPriority: true` (additive, v2.8) marks an entry that entered the queue via an interrupt-priority fallback (a held or slot-raced `priority: "interrupt"` send): it was inserted at the FRONT of the queue, **behind any existing interrupt-priority entries and ahead of every normal entry** (interrupts stay arrival-ordered among themselves); omitted (never `false`) on normal entries. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is the entry's turn correlation id: equal to the entry `id` for a fresh enqueue, but a terminal-failure requeue mints a NEW entry `id` while KEEPING the failed turn's original `turnId`, so a retry redrive's lifecycle events still correlate with the turn the client keyed at send time. Omitted only when the entry has no id set (every enqueue path mints one today; legacy pre-#1022 persisted rows rehydrate with `turnId = id`), never `null`. `messageMetadata` is only present when the entry was enqueued with per-message metadata (e.g. an internal wake's `event_notification` payload, or an agent-to-agent send's `agent_message` sender-attribution tag, captured while the agent was busy); user-typed `agent.queueMessage` entries never carry it. The drain-time persist writes it onto the user message row (`agent_message.metadata`) so the transcript matches a directly-delivered send |
| agent.editQueuedMessage | agentId (req), messageId (req), content (req) | { success, queuedMessage } (QueuedMessage shape as above) |
| agent.removeQueuedMessage | agentId (req), messageId (req) | service result |
| agent.getQueue | agentId (req) | { success, queue: QueuedMessage[] } — QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority? } (shape as `agent.queueMessage`, including the monorepo#1022 `turnId?` correlation id and the v2.8 `interruptPriority?` flag) |
| agent.stop | agentId (req) | { success: true } |
| agent.setModel | agentId (req), modelId (req), workspaceId (req) | service result — emits `agent:updated`. A compound `modelId` (`provider:model`) whose provider prefix is not a registered ACP provider is rejected with `-32602` (`agent.setModel: unknown provider: <id> (known providers: ...)`) before any mutation — `session.model` / `session.provider` are left untouched and no default-provider fallback occurs. A **bare** `modelId` is validated against the session's effective provider (`session.provider` → default, with legacy default-provider aliases normalized) using the same ownership check as `agent.create` — static tiers unioned with cached dynamic catalogs, with the same asymmetric-evidence rule: a bare id provably owned by other provider(s) is rejected with `-32602` (`agent.setModel: model <id> does not belong to provider <p> (providers with this model: ...)`) before any mutation; bare ids with no ownership evidence and the `"default"` sentinel pass unchanged. **Model-change transcript notice (new in intentd).** `agent.setModel` itself never writes to the transcript — the notice is deferred to the next turn start (`ensure_started`), when the turn's spawn-resolved model/provider is compared against the last **committed** turn's identity (persisted `agent_session.last_turn_model` / `last_turn_provider`, written on `ensure_started`'s success paths once the child + ACP session are up). A difference (and at least one committed prior turn) persists ONE informational row: `role: "system"`, one text block (`"Model changed from <from> to <to>."`), row `metadata = { "type": "model_changed", "from": string \| null, "to": string \| null, "fromProvider": string, "toProvider": string }` (`from`/`to` are spawn-resolved model ids; `null` = provider default), and emits the standard `agent:message` event (`role: "system"`) so clients update live. Picker toggles reverted before any message produce NO notice (nothing was committed in between); the agent's very first turn produces NO notice (no committed prior identity, the baseline just commits); a failed spawn/switch commits nothing (the notice only lands once the turn provably starts under the new identity). The row is transcript-only: system-role rows are excluded from supervisor-XML history replay (which renders only user/assistant/error) and never reach any outbound provider prompt. Covers same-provider respawn, cross-provider recreate, and idle-agent (no live handle) respawn paths alike — detection is store-based. Best-effort: a notice persist failure is logged and the turn proceeds. |
| agent.getModels | — (no workspaceId) | { models: [{ id, name, provider, description? }] } (from auggie CLI, static fallback) |
| agent.rename | agentId (req), name (req, non-empty), skipIfExplicitlySet? | { success: true, name } — an applied rename emits `agent:renamed`. With `skipIfExplicitlySet: true`, a session whose name was already explicitly set is left untouched and the result is { success: true, name: <existing>, skipped: true } (no event) |
| agent.delete | agentId (req), workspaceId? | { success: true } |
| agent.wakeOrCreate | taskNoteId (req), contextMessage (req), model?, callerAgentId?, delegationDepth?, messageMetadata?, create? { name?, specialist?, provider?, agentType?, model?, contextReferences?, metadata?, skipAutoCommit? } | { ok, agentId, agentName, created, action: "message_queued_to_active_agent" \| "woke_existing" \| "created_new", taskTitle, result, cleanedUpAgentIds?, subscriptionId?, message? } — depth-guard rejects `delegationDepth >= MAX_DELEGATION_DEPTH` with `-32602` (`MAX_DELEGATION_DEPTH` cap = 2; caller depth is otherwise inherited from `callerAgentId`'s session metadata + 1). Pre-widening 3-required-params callers stay wire-compatible; `create.*` is only consulted on the create branch and specialist/model from the newest assigned session takes precedence over `create.specialist`/`create.model` when a resumable candidate is found. Skipped poisoned sessions (repeated restore failures, monorepo#840) are quarantined out of candidate selection; on both wake and create branches each one's parked queue is migrated to the woken/created agent via an atomic durable hand-off (one transaction moves the persisted rows, so a crash leaves the messages on exactly one queue; delivery stays at-least-once) and the session is then hard-deleted with one `agent:deleted` emitted — `cleanedUpAgentIds` still lists them (monorepo#847). A failed migration is non-fatal to the wake but that id is withheld from `cleanedUpAgentIds` and its task assignment survives (messages stay durable on the poisoned queue), so the next `agent.wakeOrCreate` retries the migration + GC. **`callerAgentId`-present responses (SUB-1 auto-subscription, monorepo#926/#933):** when `callerAgentId` is provided, ALL THREE actions additionally carry `subscriptionId` — the id of the completion watch registered for the caller against the target agent (oneShot on `woke_existing` and `created_new`; NON-oneShot with a 5-minute leak-guard auto-cleanup on `message_queued_to_active_agent`, because the target's `agent:idle` for its in-flight turn fires before the queued message is processed) — and `message`, a human-readable summary of the action taken ending with "You will be notified when the agent responds.". Repeated calls for the same caller/target pair reuse an existing live ungrouped watch of matching oneShot mode instead of stacking duplicates (the queued branch re-arms the reused watch's 5-minute leak guard); the create branch always registers a fresh oneShot watch (the child id was freshly minted this call). Both fields are absent when `callerAgentId` is omitted, and likewise when the named caller's session is Deleted — no completion watch is registered for a deleted caller (intentd#667). |
| agent.summary | agentId (req) | quick summary of what the agent did |
| agent.reportToParent | report (req) | service result — -32603 if caller is not a delegated agent. Persists `metadata.completionReport` / `completionReportTimestamp` on the child session (re-served by agent.get/agent.list) and emits `agent:updated` (P3-1.2b). Delivery: a non-grouped delegated child delivers the single immediate parent wake at reportToParent time (directly to `session.parent_agent_id`, no watch required); the parent's oneShot watches are marked `report_delivered` so the child's later `agent:idle` is suppressed for that parent. `agent:failed` / `agent:deleted` after a report still deliver wakes. Children that never report keep the idle-driven wake with `lastResponseSummary`. Grouped children (`after_all`) do not get an immediate wake — the persisted report reaches the parent only inside the group's single aggregated wake (as that child's `Report:` line, which wins over `lastResponseSummary`); a late report after group delivery wakes immediately. All internal parent wakes (one-shot completion watches, the aggregated group wake, immediate reports) run a real parent turn through the runtime send-message path — normal `agent:stream:*` / `agent:idle` lifecycle, queued if the parent is mid-turn. **Stale queued-message redrives (new in intentd, #576):** a message queued to a delegated child while it was mid-turn, but drained only AFTER the child's completion report was persisted and delivered, is **stale** (the entry's `queuedAt` — the same wire field served by `agent.getQueue` — predates the session's `completionReportTimestamp`). A stale redrive's turn (1) **skips the turn-begin report clear** — the delivered report stays queryable via `agent.get`/`agent.list` and no `agent:updated` with `completionReportCleared: true` fires for that turn (a genuine re-report still overwrites it through `agent.reportToParent`) — and (2) the redriven message content gains a deterministic `[SYSTEM NOTE]` annotation (appended before the transcript persist, so the persisted user row and the provider prompt match) telling the child its report was already delivered and to re-report only if the message materially changes the outcome. The annotation is idempotent across requeues; for a requeued entry whose user row already reached the transcript (persisted requeue) the annotation is skipped — persisted rows are never mutated — but the report clear is **still suppressed**. Staleness fails open: session-lookup or timestamp-parse failures treat the message as fresh, and fresh messages / non-delegated agents keep the pre-existing behavior (report cleared at next turn begin) |
| agent.getSubscriptions | agentId (req), workspaceId (req) | { subscriptions, delegationGroups, agentStatuses, eventSubscriptions } (filter fields flattened as top-level actorIds/eventTypes per subscription; no legacy filter object). `eventSubscriptions` (additive, monorepo#947) lists the caller's live `event.subscribe`/`agent.subscribe` registrations — `{ id, workspaceId, subscriberAgentId, eventTypes, excludeSelf, batchWindow, createdAt }` per entry — so an agent can recover a lost `subscriptionId` |
| agent.cancelSubscriptions | agentId (req), workspaceId (req) | { success: true } |
| agent.subscribe (deprecated) | eventTypes (req, array), agentId?, excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — not the WS streaming surface (use events.subscribe). Registers a real internal subscription: when `agentId` names a subscriber agent, matching workspace events (category wildcards like `agent:*` or exact types) are coalesced over `batchWindow` ms (default 500) and delivered as one `[WORKSPACE EVENTS]` wake message per batch, with `event_notification` message metadata; `excludeSelf` (default true) drops the subscriber's own events. Agent-owned subscriptions persist across daemon restarts (rows whose subscriber is gone — or whose workspace no longer exists, `__chief__` exempt — are pruned at startup, monorepo#947). Live subscriptions are listed via `agent.getSubscriptions` (`eventSubscriptions`) and reported by `agent.diagnostics`. `workspace.delete` drops the workspace's event subscriptions (delivery tasks aborted, rows deleted). Without `agentId` (FE front door) the subscription is match-only in memory — no wake target. Over the MCP seam (`ws.agent.subscribe` / `ws.event.subscribe`) the subscriber is the calling agent automatically. |
| agent.unsubscribe (deprecated) | subscriptionId (req) | service result `{ success: true, subscriptionId }` — stops delivery; unknown id errors |

**Agent attention requests *(new in intentd)*.** Two MCP `workspace_api` bindings —
`ws.agent.requestDiscussion(reason)` (`kind: "discussion"`) and `ws.agent.reportBlocker(reason)`
(`kind: "blocker"`) — let an agent flag that it is stuck BEFORE ending its turn: a discussion
request when it needs user/coordinator input to proceed, a blocker report for an
infrastructure/environment problem it cannot resolve (broken sandbox, failing environment,
missing credentials). There is **no wire method** (MCP bindings only, following the §6.8
principle); both return `{ ok: true, kind, reason, savedAt }`. Available to EVERY agent —
delegated or not, with or without a linked task. `reason` is required (trimmed; empty →
`-32602`), an unknown kind is `-32602`, and a caller-context-free invocation is rejected
(agents only). One shared services op behind both bindings does five things:

1. **Session persistence** — the pending request is persisted on the caller's session as
   `attentionRequestKind` (`"discussion" | "blocker"`), `attentionRequestReason`, and
   `attentionRequestTimestamp` (= the result `savedAt`), served on BOTH the `AgentSession`
   projection (top-level fields, `agent.getSession`) and the `AgentLite` `metadata` block
   (`agent.list`/`agent.get`), omitted when absent. The raise emits `agent:updated` with
   `data { agentId, attentionRequestKind, attentionRequestTimestamp }`. The request is
   **pending state, not status**: `AgentStatus` and `stopReason` are untouched (the turn ends
   normally; no retry affordance), and the request retires as soon as the agent next receives
   a message on ANY delivery path (direct send, queue drain, parent/subscription wake) — the
   turn-begin clear emits `agent:updated` with `data { agentId, attentionRequestCleared: true }`
   and removes all three session fields (skipped silently when none is pending).
2. **Transcript notice** — a system-role message is appended with a single text block carrying
   the reason and `meta.kind = "discussion-request"` / `"blocker-report"` (the
   `InterruptionNotice` shape, §5.35), emitting the standard `agent:message`
   (`role: "system"`), so the conversation renders a distinct card that survives rehydration.
   Best-effort: an append failure is logged and swallowed (the session fields above are the
   durable contract).
3. **`agent:attention-requested` event** — the self-sufficient (§6.7) toast-driving event,
   `data { workspaceId, agentId, agentName, kind, reason }` (§6.5).
4. **Linked-task transition** — a caller with a linked task (`taskNoteId` on its session) moves
   it to `discussion_needed` (discussion) / `blocked` (blocker) through the same
   `task.updateNoteStatus` writer the router uses, so `task:status-changed` +
   `task:ready-tasks-changed` fire with the caller as `agentId`. Terminal statuses
   (`complete`/`cancelled`) are never downgraded, an already-at-target status is a no-op, and
   no linked task = skip (best-effort: failures are logged and swallowed).
5. **Parent wake** — a delegated caller's parent receives an immediate kind-flavored
   `[WORKSPACE EVENTS]` wake (`… requests a discussion: <reason>` / `… reports a blocker:
   <reason>`) with `event_notification` metadata embedding the `agent:attention-requested`
   payload. Children in an undelivered `after_all` delegation group skip the immediate wake —
   the group's single aggregated wake folds the attention request in; non-delegated callers
   have no parent to wake.

#### Question hold — automatic deliveries parked behind a pending Q&A *(v2.8, [intentd#751](https://github.com/intent-hq/intentd/pull/751))*

When an agent ends a turn by asking structured questions (§7 — the final assistant message
carries trailing `application/vnd.intent.question+json` resource blocks), delivering an automatic
message would append a user row that supersedes the pending Q&A: the FE derives pending-vs-answered
purely from "does a user message exist after the question-bearing assistant message", so the
composer wizard would silently vanish. The **question hold** closes this gap: while the hold is
active, automatic deliveries park in the agent's pending queue instead of starting a turn.

**Derivation (never stored).** The hold is `true` iff, walking back from the tail of the
transcript **past any trailing `system` rows** (e.g. the resume-interruption marker — system rows
are transparent to the derivation, same as the FE's pending-questions logic, which only resolves
on a `user` or `assistant` row), the first non-system message is an **assistant** message carrying
at least one `application/vnd.intent.question+json` resource block AND its id differs from the
session's persisted `dismissedQuestionsMessageId` marker. It is re-derived from the transcript on
every check — there is no stored hold flag or lifecycle status; an agent under hold remains
`idle`/`completed` as usual. The derivation fails open (`false`) on store read errors so a
transient failure can never wedge deliveries.

**What is held (message origin).** Only **automatic** deliveries are gated: A2A sends (the MCP
`ws.agent.send` binding / internal send paths), parent wakes (completion watches, aggregated group
wakes, `agent.reportToParent` immediate wakes), event-subscription batch deliveries,
`agent.sendToTask`, and `agent.wakeOrCreate` context messages. Automatic **interrupt-priority**
sends are held too — no exceptions — parking front-of-queue with `interruptPriority: true` (behind
existing interrupt entries, ahead of normal ones; the preemption is skipped entirely — there is
nothing to preempt, since a hold implies the question-asking turn already ended). A held park
returns `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId? }` to the
sender (the additive `heldForQuestions: true` field distinguishes it from an ordinary busy-queue
park; the store-only fallback arms may omit `turnId`) and republishes `agent:queue:updated`. The
hold is checked BEFORE the busy check, so even an idle agent parks automatic deliveries. The same
gate applies inside the queue-drain loop: while the hold is active the drain skips (parked entries
stay parked across turns and daemon restarts — the queue is the same durable `agent_queue` table),
EXCEPT that a parked **user-origin** entry (a user send that lost a busy race before the hold
began) still drains — the user answer is the hold's documented release, so it supersedes the
questions by design.

**What bypasses (user origin).** User-origin actions are never held and their user row releases
the hold: `agent.sendMessage` (the FE/router front door — the flattened `Q:`/`A:` answer message
is the normal resolution), `agent.sendQueuedMessageNow` (explicit user action on a parked entry),
and `agent.editAndRegenerate`. Any later user or assistant message flips the derivation false.

**Release.** The hold ends when (1) a **user message** lands after the question-bearing assistant
message (answering or otherwise), (2) **`agent.dismissQuestions`** persists the dismissal marker
for that message id, or (3) a later assistant message becomes the transcript tail. Both the
dismissal RPC and the end-of-turn path re-kick the queue drain, so parked entries resume promptly
FIFO (interrupt-priority entries first) without waiting for an unrelated trigger; the send-path
hold gates also re-check the hold after enqueueing and self-kick the drain if it cleared
concurrently, so a racing dismissal/answer cannot strand a just-parked entry.

```json
// → automatic A2A send while the target's question hold is active
{ "jsonrpc":"2.0","id":30,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"[WORKSPACE EVENTS] ..." } }
// ← parked, not delivered (note: only reachable via internal/MCP automatic senders —
//    the FE/router front door is user-origin and would deliver instead)
{ "jsonrpc":"2.0","id":30,"result":{ "success": true, "queued": true, "heldForQuestions": true,
  "queuedMessage": { "id":"user-msg-99..","content":"[WORKSPACE EVENTS] ...","queuedAt":"2026-07-30T01:00:00.000Z","position":0,"turnId":"user-msg-99.." },
  "turnId":"user-msg-99.." } }
```

```json
// → dismiss the pending questions without answering
{ "jsonrpc":"2.0","id":31,"method":"agent.dismissQuestions",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","messageId":"0190a1b2-assistant" } }
// ← marker persisted; agent:updated emitted; queue drain kicked (parked entries resume)
{ "jsonrpc":"2.0","id":31,"result":{ "success": true, "dismissedQuestionsMessageId":"0190a1b2-assistant" } }
```

```json
// → request
{ "jsonrpc":"2.0","id":20,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"Run the tests" } }
// ← response (agent was idle — message delivered)
{ "jsonrpc":"2.0","id":20,"result":{ "success": true, "queued": false, "messageId": "user-msg-1718...-ab12" } }
```

```json
// → agent.wakeOrCreate: wake branch (a resumable assigned agent exists — most-recent-first)
{ "jsonrpc":"2.0","id":21,"method":"agent.wakeOrCreate",
  "params":{ "workspaceId":"ws-abc","taskNoteId":"note-task-1","contextMessage":"resume","model":"opus4.7" } }
// ← response (agent was woken; earlier stale assignments are reported via cleanedUpAgentIds when present)
{ "jsonrpc":"2.0","id":21,"result":{ "ok": true, "agentId": "agent-abc", "agentName": "Task: Deploy", "created": false, "action": "woke_existing", "taskTitle": "Deploy", "result": { "success": true, "queued": false, "messageId": "user-msg-...", "action": "woke_existing" }, "cleanedUpAgentIds": ["agent-stale-1"] } }

// → agent.wakeOrCreate: create branch (no live/resumable assignment — rich payload; specialist/model from a newest assigned session would override create.specialist/create.model)
{ "jsonrpc":"2.0","id":22,"method":"agent.wakeOrCreate",
  "params":{ "workspaceId":"ws-abc","taskNoteId":"note-task-1","contextMessage":"kickoff","callerAgentId":"agent-parent","delegationDepth":1,"messageMetadata":{"type":"task_wake","source":"wake"},
             "create":{"specialist":"implementor","provider":"acp/mock","metadata":{"custom":"field"},"skipAutoCommit":true} } }
// ← response (new agent created; agent.create's rich result nested under `result`;
//    callerAgentId present → SUB-1 auto-subscription fields subscriptionId/message)
{ "jsonrpc":"2.0","id":22,"result":{ "ok": true, "agentId": "agent-new", "agentName": "Task: Deploy", "created": true, "action": "created_new", "taskTitle": "Deploy", "result": { "id": "agent-new", "text": "...", "backgrounded": true, "queued": false }, "subscriptionId": "a1b2c3d4-...-cd34", "message": "Created new agent \"agent-new\" for task \"Deploy\".\nContext message delivered.\nYou will be notified when the agent responds." } }

// → agent.wakeOrCreate: depth-guard rejection (delegationDepth >= MAX_DELEGATION_DEPTH)
// ← { "jsonrpc":"2.0","id":23,"error":{ "code": -32602, "message": "agent.wakeOrCreate: delegation depth 2 exceeds MAX_DELEGATION_DEPTH (2)" } }
```

> **Migrating off the removed FE `sendBackendInitiatedMessage`.** Callers that
> previously branched on the FE-only `errorCode: "ALREADY_STREAMING"` result
> should now treat `agent.sendMessage`'s `{ queued: true }` response as the
> "agent is mid-turn / already streaming" case: the daemon auto-queues the
> message behind the in-flight turn and returns `{ success: true, queued: true,
> messageId? }` without preempting. For the "resume or spin up the assignee for
> a `taskNoteId`" branch, use `agent.wakeOrCreate`; for a known existing
> `agentId`, use `agent.sendMessage` directly (the daemon distinguishes the
> mid-turn case via the boolean `queued` flag).

**Diagnostics & session-shape RPCs.** A sanitized diagnostics snapshot for the agent runtime — agent statuses, subscriptions, queues, delegation groups, delivery stats, recent delivery events, and stuck-risk signals. Plus four session-shape RPCs: the full-session read `agent.getSession`, the partial-mutation writer `agent.update`, and the transcript-mutation pair `agent.appendMessage` / `agent.replaceMessages`. `agent.enhancePrompt` (one-shot prompt-enhance / AI-layout generation; full contract in §5.31) is cross-referenced here as a namespace index entry. `agent.retry` redrives a failed agent spawn.

| Method | Params | Result |
| --- | --- | --- |
| agent.diagnostics | workspaceId (req), agentId?, taskNoteId?, staleRespondingAfterMs? | { diagnostics, text } — JSON snapshot plus a pre-formatted text rendering; optional filters narrow to one agent or task. The snapshot includes `eventSubscriptions` (monorepo#947): the workspace's live `event.subscribe` registrations (same per-entry shape as `agent.getSubscriptions` plus `orphaned`), counted in `summary.eventSubscriptions` and per-agent as `eventSubscriptionCount`; a subscription whose subscriber is missing or deleted raises an `orphaned-event-subscription` stuck-risk signal (live chief cross-workspace subscribers are not flagged) |
| agent.getSession | agentId (req), workspaceId? | { session: AgentSession } — full projection (superset of `AgentLite`): includes `systemPrompt`, `specialist`, the persisted metadata block, and the full `messages` log (chronological). Also carries the derived monorepo#940 `sessionCorrupted?` flag (same derive-on-emit + omitted-when-false semantics as the `AgentLite` projection, §5.5 `agent.list`) so a client rehydrating after a terminal-failure `agent:status-changed` still sees it. Backs the FE-side `loadAgent` rehydration path. `-32602 "Agent not found"` when the session is unknown |
| agent.update | agentId (req), workspaceId?, changes (req) | { success: true, agent: AgentLite } — partial update of the persisted `AgentSession` from a `changes` object. Whitelisted fields: `status`, `isActive`, `acpSessionId`, `backendSessionId`, `name`, `nameExplicitlySet`, `model`, `provider`, `systemPrompt`, `specialist`, `taskNoteId`, `skipAutoCommit`, `completionReport`, `completionReportTimestamp`, `delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`, `isBackground`. Optional-string fields accept a JSON `null` to clear. Write-once (`acpSessionId`) and immutable (`provider`) invariants are still enforced by the store. Emits `agent:updated` (or `agent:renamed` when `name` is the only mutated field). Unknown fields → `-32602`; unknown agent → `-32602 "Agent not found"` |
| agent.appendMessage | agentId (req), role (req, `user`\|`assistant`\|`tool`\|`system`), contentBlocks (req), workspaceId?, metadata? | { success: true, message: AgentMessage } — append a single message to the transcript. `metadata` persists verbatim on the row and round-trips on reads. Emits `agent:message`. Rejected with `-32602` when the agent is mid-turn (transcript mutations must not race the streaming writer) |
| agent.replaceMessages | agentId (req), messages (req, `AgentMessage[]`), workspaceId? | { success: true, messages: AgentMessage[] } — atomically swap the entire transcript. Each entry needs `role` + `contentBlocks`; `metadata` / `timestamp` are optional. Row ids and `seq` values (`0..n`) are minted by the store so callers cannot smuggle stale ids across the swap. Emits `agent:updated` with `{ replacedCount }`. Rejected with `-32602` when the agent is mid-turn (same rationale as `agent.appendMessage`) |
| agent.retry | workspaceId (req), agentId (req) | { ok: true, redriven, turnId? } \| { ok: false } — redrive a failed agent spawn. Only valid when the session status is `error`; returns the bare `{ ok: false }` otherwise. `redriven` is ALWAYS present on the `ok: true` arm (both values) and always absent on the `ok: false` arm, so clients may branch on it unconditionally once `ok` is `true`. `redriven` (STAB-54) distinguishes "a queued message is being redriven" (`true` — status cleared to `pending`, drain started) from "the queue was empty, nothing to redrive" (`false` — status cleared to `idle`; the next `agent.sendMessage` starts a fresh turn). `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is present ONLY when `redriven: true`: the head ready-to-send entry's turn correlation id, peeked BEFORE the drain pops it — because a terminal-failure requeue preserves the failed turn's original `turnId`, this is the SAME id the original send/enqueue RPC returned, so the redrive's `agent:queue:processing` and lifecycle events correlate with the turn the client already keyed (omitted when absent, never `null`). Clears the error status back to pending, emits `agent:status-changed`, tears down any stale child handle, and attempts to redrive the front-of-queue message (requeued at exhaustion) plus any subsequent messages. Reuses the spawn-retry/backoff machinery, so a retry that fails again lands back in the `error` state with the full event sequence (`agent:stream:status` retry hints, terminal `agent:failed` + `agent:stream:end`, `agent:status-changed` persisting `error`). **Poisoned-session recreate ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940)):** when the parked session classifies as corrupted/poisoned (the same classification that emits `sessionCorrupted: true` — session-fatal provider block, deterministic `session/prompt` 400 `invalidArgument` rejection, or the identical-failure streak at threshold), the retry arms the forced-recreate flag (same mechanism as `agent.editAndRegenerate`) BEFORE clearing the streak, so the redrive's session setup SKIPS the `session/load` resume — which would replay the exact context the provider deterministically rejects — and opens a fresh `session/new` with the prior history prepended as `<supervisor>` XML. Retry also clears the identical-failure streak and failure-wake dedup records (the deliberate quarantine escape hatch, monorepo#840) |
| agent.enhancePrompt | prompt (req), mode?: "enhance" \| "layout", model?, workspaceId?, timeoutMs? | { enhanced, original, mode } — one-shot prompt-enhance / AI-layout generation via a spawned `auggie --print`; no agent session is created or persisted, no events emitted. Full contract in §5.31 |

### 5.5a `sandbox.cow.*` (CoW agent sandboxes)

> **Namespace.** The `sandbox.cow.*` methods manage CoW (copy-on-write) sandboxed agent workspaces. When `agent.delegate` provisions a CoW sandbox (§5.5 — asynchronously: the delegate result reports `effectiveIsolation: "pending"` and the clone settles in a background task), the agent works in an isolated repository clone. When the agent completes, `sandbox.cow.merge` attempts to automatically merge the sandbox commits back to the canonical repository, preserving agent attribution. If the merge encounters conflicts or the canonical repository has uncommitted overlapping changes, the agent is bounced with resolution instructions or the merge is deferred to manual resolution. All `sandbox.cow.*` methods require `workspaceId`. Renamed from `sandbox.*` (intentd#730, no aliases); the bare `sandbox.*` namespace is reserved for the upcoming agentOS sandbox surface.

**Canonical repository (checkout-mode aware).** The directory a sandbox is cloned from and merged back into follows the workspace's checkout mode (§5.1): for **direct-mode** workspaces (skip-isolation / no provisioned checkout) it is the user's repository folder (`repositoryPath`); for **CoW-checkout** workspaces (`checkoutMode: "cow"`) it is the **workspace checkout** (`worktreePath`) — agent commits merge back into the workspace's own checkout, not the user's repo folder. Worktree-mode workspaces (`checkoutMode: "worktree"`) do not support sandboxes (sandbox provisioning is rejected; agents share the checkout).

| Method | Params | Result |
| --- | --- | --- |
| sandbox.cow.merge | workspaceId (req), agentId (req) | { ok: true, status, commitRange?, canonicalHead?, conflictingPaths?, reason?, overlappingPaths? } — manually merge a sandbox back to the canonical repository. `status` is `"merged"` (clean merge succeeded; returns `commitRange` + `canonicalHead`, emits `sandbox:cow:merged`, and the sandbox is discarded), `"conflict"` (merge conflicts detected; canonical left pristine; returns `conflictingPaths` + `canonicalHead`; sandbox status → `conflict_bounced`), or `"blocked"` (canonical has uncommitted changes overlapping with sandbox; returns `overlappingPaths` and `reason`; sandbox status → `merge_pending`). When `status = "merged"`, `canonicalHead` is the canonical repository HEAD SHA after the merge. `-32602` (`sandbox not found for agent <id>`) when no sandbox exists for the agent |
| sandbox.cow.discard | workspaceId (req), agentId (req) | { ok: true } — discard a sandbox without merging. Removes the sandbox directory and database record; discarding a nonexistent sandbox is a no-op success. This is the escape hatch when a sandbox is no longer needed or the agent failed |

**Automatic merge on completion.** When a sandboxed agent completes (`agent:idle` event), the daemon automatically attempts `sandbox.cow.merge`. On a clean merge, the agent's coordinator sees the `merged` sandbox status in the completion event and receives a `sandbox:cow:merged` event. On conflict, the agent is bounced with a list of conflicting paths and resolution instructions (conflict resolution is iterative; the agent re-completes after fixing conflicts). On `blocked` outcome or retry exhaustion, the completion propagates with `merge-pending` status, and the user must call `sandbox.cow.merge` manually once canonical is clean.

**Status lifecycle.** Sandbox records track status through the merge lifecycle: `created` (provisioned), `merging` (merge in progress), `merged` (successfully merged and discarded), `conflict_bounced` (conflicts detected; agent woken with paths), `merge_pending` (awaiting manual merge; blocked or retry cap hit), `discarded` (discarded without merging). The `agent:idle` completion event includes the sandbox status when applicable.

**WIP snapshot exclusion.** Sandboxes provisioned from a dirty canonical repository create a snapshot commit of the WIP state (message prefix `"WIP snapshot for"`). These snapshot commits are **never merged back** to canonical — only commits made by the agent after the snapshot are cherry-picked. This ensures the user's uncommitted work stays local.

**Attribution preservation.** Merged commits preserve the agent's original author/committer identity (from the sandbox git signature). The canonical repository gains the agent's commits as if the agent had worked directly in canonical, maintaining the audit trail.

```json
// Request: manual merge after resolution
{ "jsonrpc":"2.0","id":80,"method":"sandbox.cow.merge",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123" } }
// ← response (clean merge)
{ "jsonrpc":"2.0","id":80,"result":{
  "ok":true,"status":"merged","commitRange":"1a2b3c..4d5e6f","canonicalHead":"a1b2c3d4..." } }
// ← (also emits sandbox:cow:merged event)

// Request: discard a failed sandbox
{ "jsonrpc":"2.0","id":81,"method":"sandbox.cow.discard",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-456" } }
// ← response
{ "jsonrpc":"2.0","id":81,"result":{ "ok":true } }
```

### 5.6 `git.*`

| Method | Params | Result |
| --- | --- | --- |
| git.status | workspaceId (req) | { modified, staged, untracked, deleted, ... } |
| git.stage | paths (req, CSV string or array) | { ok, paths } — staging ./*/--all is rejected (-32603) |
| git.commit | message (req) | { ok, hash?, files? } (deprecated; prefer agentCommit) |
| git.agentCommit | message (req), files?, userRequested? | { ok, hash, files, fileCount } — commit-set selection below |
| git.checkMergeConflicts | targetBranch? | { hasConflicts, conflictedFiles, targetBranch, currentBranch, ... } |
| git.getBranches | repoPath (req), includeRemote? | { branches, remoteBranches, currentBranch, defaultBranch } — repoPath must be an existing local git repository (-32602 otherwise; see below) |

**Path-based branch reads (`git.getBranches`, `git.branchStatus`).** These two read-only methods take a filesystem `repoPath` instead of a `workspaceId` because the workspace-initializer BranchSelector lists branches for a user-picked repo *before* any workspace referencing it exists — a known-repo gate here is a chicken-and-egg failure (the create flow can never register the repo it cannot list). Mirroring the ungated legacy IPC handlers (`git:getBranches` `{ repoPath }` variant, `git:getBranchStatus`), the daemon accepts **any local path that exists and is a git repository** (registered as a workspace or not) and rejects invalid paths with distinct `-32602` errors: `Repository path does not exist: <path>` for a nonexistent path, `Path is not a git repository: <path>` for an existing non-git directory. `git.pull` (extensions table below) shares the same `repoPath` validation for the same reason — the workspace-create auto-pull runs before the repo is registered; all other mutating `git.*` methods remain workspace-scoped and are unaffected.

```json
// → request
{ "jsonrpc":"2.0","id":30,"method":"git.stage","params":{ "workspaceId":"ws-abc","paths":["src/a.ts","src/b.ts"] } }
// ← response
{ "jsonrpc":"2.0","id":30,"result":{ "ok": true, "paths": ["src/a.ts","src/b.ts"] } }
```

**`git.agentCommit` commit-set selection.** What lands in the commit depends on which of `files` / `userRequested` / the caller's agent context are present. An explicit-set commit (modes 1 and 3) is **pathspec-limited** (`git commit -- <paths>` semantics), so paths another actor pre-staged are never swept into an agent's commit; the `userRequested` checkpoint (mode 2) instead commits the index as-is — which by definition contains only staged paths:

1. **Explicit `files`** — the listed paths are committed as-is (staged and committed regardless of prior index state).
2. **No `files`, `userRequested: true`** — a user checkpoint: commits the index as-is (plain `git commit` semantics, i.e. only the **already-staged** paths — including paths another agent staged, as any `git commit` would); unstaged and untracked changes are left alone. An empty index → `-32603` "No staged changes found to commit".
3. **No `files`, agent-initiated** (an agent context is present) — commits only the paths the file-tracking attribution pipeline (§5.19) credits to the committing agent: `tracked_changes` rows at stage unstaged/staged for that `agentId`, **intersected with the actual uncommitted changes** (`git.status` files — staged, unstaged, and untracked alike), so a stale attribution row never resurrects a committed/reverted file. An empty attributed set commits nothing (`-32603` "No uncommitted changes found for this agent"). Post-commit, the committed paths' attribution rows advance unstaged/staged → committed, keeping the audit trail consistent.
4. **No `files`, no `userRequested`, no agent context** — attribution is impossible, so the commit is **refused** (`-32603`) rather than sweeping the worktree.

**Per-workspace auto-commit resolution.** The auto-commit gate (`git.commit`, `git.agentCommit`, the idle auto-commit path below, and system-prompt assembly) resolves auto-commit **per workspace**: the persisted workspace override (§5.1 `workspace.getAutoCommit` / `workspace.setAutoCommit`) when set, else the global `git.autoCommit` setting (§5.12). `workspace.create` and `workspace.duplicate` seed the override from the effective value at creation time (mirror-at-creation), so later global changes never retroactively flip existing workspaces; pre-migration rows have no override and keep following the global.

**Auto-commit on `agent:idle` (daemon-internal, not wire surface).** When an agent turn completes (`agent:idle` event) and the workspace has uncommitted changes with auto-commit enabled (per-workspace resolution above; and the session did not set `skip_auto_commit`), the daemon automatically generates a conventional-commit-formatted message via `agent.completeOnce` (§5.32) with the bundled `commit-message` instruction as system prompt. The prompt context includes: the uncommitted diff (truncated), recent commit subjects (for style mimicry), the repo-root `AGENTS.md` when present (truncated), and the task title / agent name as hints. The generated output is parsed for `<<<COMMIT_MESSAGE>>>` tags. On any generation failure, timeout, or malformed output, the daemon falls back to the deterministic subject chain (`taskTitle` → agent name → `"Agent changes"`) so auto-commit is never blocked or skipped because generation failed. The `agent.completeOnce` binary resolution order (§5.32 Execution) honors the `context.auggiePath` setting when set, ensuring hermetic e2e tests and explicit user config are respected. This internal auto-commit path has no wire RPC — clients only observe the resulting `git:commit` event (§6.5).

**Working-tree & branch operations.** The inverse of `git.stage` plus working-tree/branch reads. `git.diff` is accepted as an alias for the wire-canonical `git.diffs`, and `git.log` as an alias for `git.commits`.

| Method | Params | Result |
| --- | --- | --- |
| git.unstage | paths (req, CSV string or array) | { ok, paths } — inverse of `git.stage`; rejects `./*/--all` with `-32603`; idempotent on already-unstaged paths |
| git.discard | workspaceId (req), paths (req, CSV string or array) | { ok, paths } — discard working-tree changes: tracked paths restored from the index (equivalent to `git checkout -- <paths>`), untracked paths deleted from disk (files unlinked, directories removed recursively); staged changes are untouched. Rejects `./*/--all` with `-32603`; idempotent on already-clean tracked paths and on missing untracked paths (ENOENT parity with the reference's race-tolerant `fs.unlink`). Ports the legacy `git:discard-changes` IPC. |
| git.branchStatus | repoPath (req), branchName (req) | { branch, currentBranch, isCurrentBranch, ahead, behind, hasUncommittedChanges } — path-based like `git.getBranches` (same repoPath validation, see above); ports the legacy `git:getBranchStatus` IPC |
| git.pull | repoPath (req), branchName (req) | { ok, error? } — path-based like `git.getBranches` (same repoPath validation, see above); ports the legacy `git:pullBranch` IPC used by the workspace-create auto-pull. When `branchName` is not the checked-out branch, only `origin/<branchName>` is fetched (worktrees are created from the remote-tracking ref); when it is checked out, the equivalent of `git pull --rebase origin <branchName>` runs with auto-stash (dirty worktree stashed incl. untracked → rebase → stash popped; the stash entry is **kept** on a conflicted pop, git-CLI parity). After a successful pull, if `.gitmodules` exists, runs `git submodule update --init --recursive` (bounded 100s timeout) to sync submodule worktrees to updated gitlinks. Ordinary pull failures (conflicts, unreachable remote, stash-recovery problems, submodule sync timeout/failures) are a structured `{ ok: false, error }`, never a JSON-RPC error; `error` is omitted on success |
| git.changes | workspaceId (req) | { files: FileStatus[] } — the same working-tree list as `git.status.files` |
| git.diffs (alias git.diff) | workspaceId (req), path?, paths?: string[], staged? | per-file diff hunks (`staged: true` → HEAD→index; else index→workdir). `path` narrows to one file; `paths` narrows to a set of worktree-relative files. Both are literal pathspecs (no glob expansion), unioned when both are set, and applied daemon-side so the diff walk is pruned to the requested files; an empty/omitted narrowing set means the full tree |
| git.commits (alias git.log) | workspaceId (req), limit?, nextToken? (or nested `page: { limit, continuationToken }`) | { items: CommitSummary[], nextToken? } — paginated reverse-chronological history; remote/non-repo workspaces return empty. **Metadata-only**: each `CommitSummary` is `{ hash, sha, author, email, date, message, agentId?, linkedNoteId? }` — `hash` is the canonical full commit hash (pass it as `git.commitDetails` `commitHash`), `sha` is its 7-char abbreviation for display, and `email` carries the same value `git.commitDetails` returns as `authorEmail` (both fields kept for legacy-client parity). The walk skips per-commit tree diffs, so `files` is omitted; fetch per-file data on demand via `git.commitDetails` |
| git.commitDetails | workspaceId (req), commitHash (req) | { commitHash, author, authorEmail, date, message, files: string[], fileDetails: [{ path, additions, deletions }] } — metadata + per-file line stats for one commit (diff vs first parent; a root commit diffs against the empty tree). `commitHash` accepts anything revparse-able. `files` mirrors `fileDetails[].path` for callers that only want names. Unknown/remote/non-repo workspaces and unresolvable hashes degrade to the same shape with empty strings/arrays (echoing `commitHash`), never a JSON-RPC error; missing `commitHash` → `-32602`. This is the on-demand per-file read behind metadata-only commit lists (see CommitWithAttribution, §5.18) |
| git.showFile | workspaceId (req), filePath (req), ref (req) | { content } — file content at `ref` (`git show <ref>:<path>` semantics; ports the legacy `git:show-file` IPC behind the diff viewers / PR section / commits timeline). `filePath` may be worktree-relative or absolute (absolute paths under the worktree are made relative); `ref` accepts anything revparse-able (commit hash, branch, `HEAD`, `<hash>^`, …) plus the index ref `":0"` (stage-0 index entry). A path missing at `ref` (e.g. a new file) → `{ content: "" }`, mirroring the legacy handler; unknown/remote/non-repo workspaces → `{ content: "" }` (the same empty fallback as the other `git.*` reads); an unresolvable `ref` → `-32603` |
| git.numstat | workspaceId (req), staged?: boolean, baseRef?, baseCommitSha?, targetRef? (default `HEAD`), paths?: string[] | `[{ filePath, additions, deletions }]` — per-file added/deleted line counts, returned as a **bare array**. When a branch base is supplied (`baseRef` and/or `baseCommitSha`), the counts come from the committed two-dot `<boundary>..<targetRef>` range (branch-boundary resolution below) and `staged` is ignored; otherwise the working tree is counted, tracked files only: `staged: true` → HEAD→index, `staged: false` → index→workdir, `staged` omitted → HEAD→workdir. `paths` filters the result to the given worktree-relative paths. An unresolvable boundary, and unknown/remote/non-repo workspaces, degrade to `[]`, never a JSON-RPC error |
| git.branchDiff | workspaceId (req), baseRef? / baseCommitSha? (at least one req, else `-32602`), targetRef? (default `HEAD`), paths?: string[] | `[{ file, chunks: [], oldContent, newContent }]` — committed branch-base diff, returned as a **bare array**: one entry per changed file in the two-dot `<boundary>..<targetRef>` range (branch-boundary resolution below), carrying the full file contents at the boundary (`oldContent`) and at `targetRef` (`newContent`) so the FE branch-base viewer renders the diff from the two contents alone (parity with the legacy `batchedGitBranchBaseDiff`). `chunks` is always an empty array — the branch-base consumer ignores it. A path missing at a ref yields empty content on that side (`git.showFile` semantics: added files → empty `oldContent`, deleted files → empty `newContent`). `paths` filters the result to the given worktree-relative paths. An unresolvable boundary (including an unresolvable `targetRef`), and unknown/remote/non-repo workspaces, degrade to `[]`; git failures while reading the file contents (repository IO) → `-32603` |
| git.clone | url (req), parentDir (req), targetName?, requestId? | { requestId, targetPath } — **streaming**: returns the ack promptly and pushes `git:clone:progress` frames followed by a terminal `git:clone:done` (§6.5). A leading `~` / `~/` in `parentDir` expands to the daemon user's home directory (`~user` forms pass through unchanged; expansion is best-effort — when the daemon cannot resolve a home directory the path passes through verbatim); the ack's `targetPath` always carries the post-expansion path. `targetName` defaults to the URL basename (with `.git` stripped); rejected if it contains a path separator or would escape `parentDir`. `-32602` on missing/invalid params; `-32603` when the target path already exists or the event bus is not wired. |

**Branch-boundary resolution (`git.numstat`, `git.branchDiff`).** Both methods resolve the diff boundary the same way, and the daemon owns it (clients never compute a merge-base). When `baseRef` is set, the boundary is the **merge-base** of `targetRef` and the base branch — a bare branch name (no `/`) tries `origin/<baseRef>` first, then the local ref; a name containing `/` is tried verbatim. When `baseRef` is absent or fails to resolve, `baseCommitSha` is used **verbatim** as the boundary, but only when it is an ancestor of (or equal to) `targetRef`. If neither yields a boundary — including an unresolvable `targetRef` — the result is `[]`, never a JSON-RPC error.

**Streaming `git.clone`.** Long-running clones cannot use the buffered `host.exec` (§5.14) — the FE animates a progress bar as objects arrive. `git.clone` mirrors the `search.*` streaming shape (§5.15 / §6.5): the method returns `{ requestId, targetPath }` immediately and the daemon spawns `git clone --progress` with a piped stderr, parses the canonical phases (`starting` → `counting` → `compressing` → `receiving` → `resolving` → `checkout` → `complete`) into `git:clone:progress` frames, and emits a terminal `git:clone:done` when the child exits, times out (5 min hard cap), or fails to spawn. `GIT_LFS_SKIP_SMUDGE=1` is preserved so a missing/unreachable LFS object never fails the clone. The `url` is used only at spawn time; neither the URL nor the environment ever appears in the streamed payloads, and any `user:pass@` credential fragment in stderr is redacted before it surfaces on the `git:clone:done { error }` frame.

**Clone credential injection (private HTTPS github.com repos).** For an HTTPS `github.com` URL, the daemon resolves the stored GitHub token per `sourceControl.github.tokenSource` (§5.27 auth model: secrets store → env → `gh` CLI for `auto`) and offers it to the child git as a github.com-scoped credential helper injected via the `GIT_CONFIG_PARAMETERS` environment variable (appended after any inherited entries) — configured helpers still win, matching the `git.pull`/fetch chain. The token travels to the child through an environment variable only: it never appears in argv (process listings), persisted git config, logs, streamed payloads, or error surfaces. SSH and non-GitHub URLs skip token resolution entirely. Applies to both `git.clone` and the `workspace.create` clone orchestration (§5.1). A failed clone's `git:clone:done` frame carries an optional machine-readable `errorCode` (clone failure taxonomy, §9.1) alongside the human-readable `error`; `errorCode` is present only when the failure was classified.

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

All `pr.*` methods require an active pull request on the workspace — otherwise the underlying service throws → `-32603` — **except `pr.refresh`**, which exists to establish/repair the link and works without one (see its semantics note below), **and `pr.capabilities`** (v2.1), which reports the active provider's capability flags before any PR exists (see below).

> Host-agnostic naming. `pr.*` is the canonical wire name. Conceptually it is host-agnostic — "PR" covers pull request / merge request / change request — and in v1 it is backed by GitHub (selected via the sourceControl.activeProvider setting, §5.12). Future forges (GitLab, Bitbucket) plug in behind the same pr.* surface.

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

**Review & CI methods.** Five further methods round out the `pr.*` namespace. Three
review/CI methods map onto the `SourceControl` trait (`list_reviews` / `check_runs` /
`submit_review`) and stay host-agnostic. `pr.refresh` forces the same PR
discovery/refresh the daemon's background sweep runs for one workspace, on demand.
`pr.capabilities` (v2.1) exposes the active provider's capability flags.

| Method | Params | Result |
| --- | --- | --- |
| pr.getReviews | prNumber? (defaults to the workspace's active PR) | { reviewDecision: "APPROVED" \| "CHANGES_REQUESTED" \| null, approvalCount, changesRequestedCount, approvedBy: string[], reviews: Review[] } — see Review (§5.18 schemas) |
| pr.listCheckRuns | ref? (commit SHA; defaults to PR head) | { total, passed, failed, pending, runs: CheckRun[] } — see CheckRun (§5.18 schemas). Gated on the `checkRuns` capability (see capability gating below) |
| pr.createReview | verdict (req): "approve" \| "request-changes" \| "comment", body? | { review: Review } — submits a review on the active PR. A `"request-changes"` verdict is gated on the `reviewRequiredChanges` capability (see capability gating below); `"approve"` / `"comment"` are ungated |
| pr.refresh | — | { outcome: "skipped" \| "unchanged" \| "linked" \| "updated" \| "unlinked", prNumber: number \| null, prUrl: string \| null, prStatus: string \| null, pullRequests: PullRequestInfo[] } — the post-refresh linkage state |
| pr.capabilities | — (workspaceId only, per §3.6) | { provider, capabilities: { draftPrs, squashMerge, rebaseMerge, reviewRequiredChanges, checkRuns, issues } } — the active provider's id (e.g. `"github"`) and its boolean capability flags, so clients can gate UI before invoking gated operations |

> **`pr.capabilities` semantics (v2.1).** Requires a resolvable source-control provider but
> **not** an active PR — clients gate UI on the flags before any PR exists. The
> `workspaceId` is still validated (unknown workspace → not-found error like every other
> workspace-scoped method).

> **Capability gating (v2.1).** Operations a provider does not support fail with
> `-32603 "Internal error"` whose `error.data` carries a message with the stable prefix
> `unsupported by provider:` (per the §3.3/§9 envelope, `error.data` holds the original
> internal message for `-32603`). Gated operations: `pr.merge` with
> `mergeMethod: "squash"` (`squashMerge` flag) or `"rebase"` (`rebaseMerge` flag — a plain
> `"merge"` is ungated), `pr.createReview` with `verdict: "request-changes"`
> (`reviewRequiredChanges` flag), and `pr.listCheckRuns` (`checkRuns` flag). Clients should
> match on the `unsupported by provider:` prefix to distinguish capability failures from
> other internal errors.

> **`pr.refresh` semantics.** Unlike the rest of `pr.*`, `pr.refresh` does **not** require an
> active PR — it exists to establish/repair the link. It runs the shared refresh path
> (discovery, status update, stale-link clearing, relink-after-merge), so any
> resulting `pr:linked` / `pr:updated` / `pr:unlinked` events (§6.5) are emitted **once** by
> that path — the RPC adds no duplicate emission. The matching rule is **branch OR baseRef**:
> a PR matches a workspace when its head ref equals the workspace's own `branch`, or when it
> matches the workspace's `baseRef` (raw equality, plus the known-remote-prefix-stripped
> remainder for legacy rows persisted before write-side canonicalisation — see `baseRef`
> canonicalisation, §5.1), so review workspaces created *for* a PR link it via `baseRef`.
> Discovery (and relink-after-merge) queries by the workspace's own branch head first —
> branch match takes precedence — then falls back to one open-PR query per baseRef
> candidate (the raw stored `baseRef` plus, when it differs, its known-remote-prefix-
> stripped remainder); when several PRs match, the highest PR number wins. A stale link is
> cleared only on a **positive mismatch**: the linked PR's head ref is known, at least one
> of the workspace's `branch` / `baseRef` is known, and every known field fails to match —
> unknown inputs never unlink. This intentionally deviates from the FE guard
> (which only cleared a stale link when the workspace's own branch was present): a
> branch-less workspace whose `baseRef` positively mismatches the linked PR's head **does**
> unlink. Ineligible workspaces (remote, archived, without a repo, or — when no PR is
> linked — with neither a branch nor a baseRef) return `outcome: "skipped"` rather than
> erroring.
> Unlike the usual omitted-when-absent (`skip_serializing_if`) convention, `prNumber` /
> `prUrl` / `prStatus` are always present and serialize as literal `null` when no PR is
> linked after the refresh; `pullRequests` is always an array (possibly empty). An unknown
> `workspaceId` → `-32602 "Workspace not found"`.

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
| script.create | workspaceId (req), name (req), command (req), mode (req: `service` \| `command`), cwd?, env?, category?, autoStart?, scriptId? | { id, workspaceId, name, command, mode, source, createdAt, cwd?, env?, category?, autoStart?, updatedAt? } — the persisted `WorkspaceScript` record |
| script.remove | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.start | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.stop | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.restart | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.output | workspaceId (req), scriptId (req), maxLines? | output buffer text |
| script.status | workspaceId (req), scriptId (req) | { state, pid, exitCode, url?, ... } |
| script.run | workspaceId (req), scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } |

> **Unified PTY host (new in intentd).** Scripts run inside (possibly headless) terminals on
> the daemon and share the **unified PTY/terminal host** with interactive terminals (§5.13), so
> a script and a terminal can interact (shared env, signals, attaching to a running script's
> terminal). Live output/state stream as the `script:output` / `script:state` events (§6.5);
> `script.output` / `script.status` remain the historical poll reads. Service/command modes,
> auto-restart, and URL/port detection are preserved — a detected dev-server URL feeds the
> `forward.*` hook when the connection is remote (§5.14).

### 5.9 `browser.*`, `terminal.*`, `file.*`

| Method | Params | Result |
| --- | --- | --- |
| browser.exec | actions (req, non-empty array), tabId?, agentId?, workspaceId? | single action → the action's `{ action, success, result?, error? }` envelope; multi-action → `{ results: [...] }` — **client-callable trigger** whose real work is served by the connected FE via a reverse RPC (`browser.exec`, `id: "rev-<n>"`), see below |
| browser.docs | topic (req) | docs string — **not exposed**: no router arm; see the `browser.docs — not exposed` block below |
| terminal.list | workspaceId (req) | bare array `[{ id, name, cwd, isExecutingCommand }]` — `name` is **always present** on the wire: the PTY's daemon-tracked display name when one was assigned at spawn (e.g. **"Setup Script"** for the workspace setup terminal, §5.1/§5.25), else the constant `"Terminal"`. The underlying PTY display name is optional spawn metadata (§5.13); the `name` field is not (clients may still fall back to `"Terminal"` defensively) |
| terminal.readOutput | workspaceId (req), terminalId (req), maxLines? | output buffer text |
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

**File-explorer & metadata reads.** Three further methods: `file.tree` — a file-explorer read returning the entries directly under the given path as a **bare array**; and `file.exists` / `file.stat` — the existence probe and metadata read. The FE anchors the explorer at the workspace root and lazy-lists children via the existing `file.list`. All three share the within-workspace containment guard with the other `file.*` ops.

| Method | Params | Result |
| --- | --- | --- |
| file.tree | path? (default .) | [{ path, name, isDirectory }] — bare array; paths outside the workspace rejected |
| file.exists | path (req) | { exists, isFile, isDirectory } |
| file.stat | path (req) | { size, mtime, isFile, isDirectory, isSymlink, permissions } |

> **`browser.exec` — client-callable trigger + FE-served reverse RPC.**
> `browser.exec` is a **client-callable trigger** whose real work happens on the connected
> frontend (Chrome DevTools Protocol against embedded browser tabs — no CDP driver runs in
> the daemon). Wire pattern mirrors `host.openInEditor` (§5.14): the FE binding calls
> `browser.exec` like any other method; the daemon validates the envelope, then dispatches
> an FE-served reverse RPC (`browser.exec`, `id: "rev-<n>"`) so the CDP work resolves on the
> user's machine. `actions` must be a **non-empty array** (`-32602` otherwise); the FE's
> raw `{ success, results, error? }` envelope is reshaped for the caller — a single-action
> batch yields the action's `{ action, success, result?, error? }` envelope, a multi-action
> batch yields `{ results: [...] }` (parity with the FE `browser_exec` MCP tool).
> A closed reverse channel ("no frontend connected"), a reverse-RPC timeout, and an
> FE-reported failure envelope all surface as `-32603` carrying the underlying context.
> The FE-served reverse-RPC pattern keeps the daemon a thin proxy and the
> CDP surface an FE concern.
>
> **Agent-initiated `browser.exec` — first-client-sticky reverse dispatch (REV-1,
> interim).** When `browser.exec` is triggered by an *agent* (via the MCP
> `ws.browser.exec` binding, §6.8) rather than by a client connection, there is no
> ambient reverse channel to reuse: the caller is the daemon-hosted MCP server, not a
> client-facing socket. The daemon therefore routes the reverse RPC to the
> **first-connected live client**; if that client disconnects, the next-connected client
> takes over — failover follows connection arrival order (UDS + WSS clients share the same
> registry). When no client is connected at all the call fails fast with `-32603` and
> `browser.exec: no client connected` so the agent surfaces the same class of failure a
> closed channel already produces. This is a deliberate stopgap ahead of an explicit
> target-selection surface (§5.17 client identity): "sticky first" needs no wire
> change and is trivially observable, but it does not distinguish overlapping clients.
> Client-triggered `browser.exec` is **unchanged**: it still reverse-dispatches on the
> caller's own connection.
>
> **`browser.docs` — not exposed.** The `browser_docs` MCP tool that
> served static reference docs on-demand has no consumer in the daemon surface (skills-style
> docs stay in the FE MCP layer) and is deferred, not cancelled: revisit
> only if a future FE feature needs BE-owned browser docs. The `terminal.*` and `file.*`
> methods above are **unaffected**.

> **Interactive terminals.** `terminal.list` / `terminal.readOutput` above are the
> read-only methods. The daemon also serves interactive
> `terminal.create` / `write` / `resize` / `kill` / `getBuffer` (base64 framing) — see §5.13.
> PTYs carry an optional daemon-assigned display name (set at spawn; not a
> `terminal.create` parameter) that `terminal.list` surfaces as `name` with a
> `"Terminal"` fallback — see the `terminal.list` row above.

### 5.10 `event.*` (query/aggregation)

These are **historical/aggregate read** helpers — distinct from live streaming (§6). Each requires`workspaceId`.

> **Retention.** The high-volume live-output chunk families (`terminal:data`, `script:output`,
> `host:exec:stdout` / `host:exec:stderr`) are **transient / broadcast-only** (same publish path
> as `agent:stream:chunk`, §7): they are never written to the event table, so §5.10 historical
> reads never see them — replay comes from the owning buffer (`terminal.getBuffer` /
> `script.output`), not from events. Persisted events are pruned by the daemon's retention
> loop: the high-volume ephemeral families (`agent:stream:*`, `file:*`, plus rows of the
> now-transient chunk families persisted by older daemon versions)
> and the high-churn state-notification families (`workspace:updated`, `draft:changed`,
> `agent:status-changed`, `agent:idle`, `agent:subscriptions-changed`, `settings:changed`,
> `workspace:tokenUsage-changed`, `agent:queue:updated` — exact types; consumers take these from
> the live stream (§6) and rehydrate current state from the owning resource, never from history)
> per the stream-retention window (`events.streamRetentionHours` setting, default **72h**; `0` disables
> the sweep; `INTENTD_STREAM_RETENTION_HOURS` env override), and `agent:tool:call` rows on a
> fixed **6h TTL**. Additionally, the **persisted** `data_json` of an `agent:tool:call` event is
> capped at **16 KiB**: an over-cap payload has its free-form fields (`output`, `input`,
> `registeredAttachments`) replaced with `{ truncated: true, originalBytes, preview }` (preview =
> first 2 KiB of the field's serialized JSON) before the row is written — the live broadcast (§6/§7)
> always carries the FULL payload; only the §5.10 historical reads see the capped copy.
> Historical reads only see rows within these windows; lifecycle/audit
> families (`workspace:created`/`deleted`/`archived`, `agent:created`/`deleted`/`completed`/`failed`,
> note/task/comment/git events, ...) are not swept. The loop also reclaims freed pages via
> bounded `PRAGMA incremental_vacuum` on incremental-auto-vacuum databases. Legacy databases
> created with `auto_vacuum=NONE` are converted automatically: the daemon's write connection
> sets `PRAGMA auto_vacuum=INCREMENTAL` at connect (inert on an existing NONE-mode file by
> itself), and a one-time `VACUUM` at daemon startup rebuilds the file to apply it, so space
> reclamation applies to all databases.

| Method | Params | Result |
| --- | --- | --- |
| event.recentFiles | limit? | recently modified files |
| event.agentActivity | agentId?, minutesAgo? | activity events |
| event.workspaceSummary | minutesAgo? | aggregated activity summary |
| event.directoryChanges | dir (req), limit? | recent changes under a directory prefix |
| event.query | workspaceId (req), filter opts (eventType?, actorType?, actorId?, path?, minutesAgo?, limit?), paginate?: boolean, nextToken?: string | matching events — **legacy shape** (bare array, newest→oldest) when pagination is not engaged; **paginated envelope** `{ items, nextToken }` when either `paginate: true` or a `nextToken` is supplied (opt-in). `nextToken` is an opaque cursor for the next older page (`null` on the last page); pass it back as `nextToken` to fetch the next page. `limit` is clamped by the pagination policy when engaged. |
| event.subscribe (deprecated) | eventTypes (req, array), excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — use events.subscribe for WS streaming. Shares the one real subscription implementation with the `agent.subscribe` alias of §5.5 (matching, batching, subscriber wakes, restart persistence); over the MCP seam the subscriber is the calling agent. Note: the singular `event.subscribe` / `event.unsubscribe` methods are NOT routable on the wire (MCP bindings only) — wire callers use the `agent.subscribe` alias. |
| event.unsubscribe (deprecated) | subscriptionId (req) | service result `{ ok: true, subscriptionId }` — stops delivery; unknown id errors |

### 5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*`

| Method | Params | Result |
| --- | --- | --- |
| crossWorkspace.listSiblings | workspaceId (req) | sibling workspaces sharing the same git repository (the workspace's own repo) |
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
| repo.remove | path (req) — no workspaceId | { removed: bool } — deletes one known-repo registry entry; `false` when the path was not registered (not an error) |

```json
// → request
{ "jsonrpc":"2.0","id":50,"method":"specialist.list" }
// ← response
{ "jsonrpc":"2.0","id":50,"result":{ "specialists": [
  { "id":"implementor","name":"Implementor","description":"...","source":"bundled" } ] } }
```

**`specialist.*` full CRUD.** Beyond `specialist.list`, the namespace carries
`get` / `create` / `edit` / `delete`. Definitions resolve in **3 tiers** — **project**
(`.intent/specialists/`) overrides **user** (`~/.intent/specialists/`) overrides **bundled** — and
`scope` selects which tier a write targets (`bundled` is read-only). `list`/`get` return the
resolved view; `create`/`edit` take a full `spec` body. Malformed params → `-32602`; deleting a
non-existent or `bundled` definition → `-32602`.

- **SpecialistDef** — `{ id, name, description, codingAgent?, model?,
  modelTier?: "low"|"medium"|"high", roleReminder?, agentType?, prompt?, hidden?: boolean,
  source: "project"|"user"|"bundled", path? }`. The optional scalars (`codingAgent`, `model`,
  `modelTier`, `roleReminder`, `agentType`) are first-class **string** fields on the wire, not
  frontmatter-only: `list`/`get` emit each one when its resolved value is non-empty, and
  `create`/`edit` accept them in `spec` (they are written to the file's frontmatter). On
  `list`/`get`, `source` is the **winning** tier and `path?` the file it resolved from (omitted
  for `bundled`); on `create`/`edit` the body carries the authored fields and `scope` chooses the
  target tier.
- **`hidden?`** — optional boolean sourced from `hidden:` in the specialist file's
  frontmatter and **inherited across tiers**: a definition resolves `hidden: true` when any
  lower tier (down to the embedded bundled floor) sets `hidden: true`, unless a higher tier
  **explicitly** sets `hidden: false` — a file that omits the key inherits the lower tiers'
  effective value. Emitted on `list`/`get` only when the resolved value is true (absent ⇒ not
  hidden). On `create`/`edit` an explicit `hidden: true`/`false` is written verbatim and an
  omitted `hidden` writes no key (the resolved value then inherits); explicit `hidden: false`
  in a user/project file is the opt-out that unhides.
  Hidden specialists stay in `list`/`get` results — clients filter them out of
  specialist pickers while keeping them visible on editing surfaces (e.g. Settings → AI
  Behavior). The bundled `chief-of-staff` is flagged hidden.
- **Config scalars (`codingAgent` / `model` / `modelTier` / `agentType`)** — the four optional
  config frontmatter scalars follow the same **inherit-on-omit** fold as `hidden`, each key
  independently, across the tiers (embedded bundled floor → bundled dir → user → project): a
  file that omits the key inherits the lower tiers' effective value, and an explicit non-empty
  value in a higher tier overrides it. An explicit **empty string** (`""`) clears the inherited
  value — the string analogue of `hidden: false` — and `create`/`edit` write `key: ""` verbatim
  so the explicit clear round-trips losslessly. A bare `key:` with no value (YAML `null`) is
  parsed as an explicit empty string — the frontmatter parser takes the trimmed text after the
  colon — so it **clears** exactly like `key: ""` (it is neither an omit nor an error).
  `roleReminder` intentionally stays
  **winner-takes-all** (not inherited): it is coupled to the prompt body (itself
  winner-takes-all), so the derive-from-body fallback remains correct when a higher tier
  rewrites the body.
- The daemon watches the user (`~/.intent/specialists/`) and project
  (`<workspace>/.intent/specialists/`) tiers (using `notify` watchers, the same infrastructure as
  workspace `file:changed` events); when a specialist file is created/modified/deleted under a
  watched tier, the daemon re-resolves the specialist set for the affected workspace(s) (user-tier
  changes affect all open workspaces; project-tier changes are workspace-scoped), compares the
  newly-resolved set against the cached specialist set, and emits `specialists:changed` (§6.5) only
  if the resolved set actually changed (500ms debounce per workspace). The bundled tier (including
  its compile-time embedded floor) is static and unwatched. Clients should re-fetch via
  `specialist.list` on the event to refresh the specialist roster.

```json
// → request — author a project-scoped specialist
{ "jsonrpc":"2.0","id":51,"method":"specialist.create",
  "params":{ "id":"reviewer","scope":"project",
    "spec":{ "id":"reviewer","name":"Reviewer","description":"Reviews diffs",
      "modelTier":"high","prompt":"You review code changes…" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "specialist":{
  "id":"reviewer","name":"Reviewer","description":"Reviews diffs","modelTier":"high",
  "source":"project","path":".intent/specialists/reviewer.md" } } }
```

### 5.12 `settings.*`

> The daemon owns the settings that affect server-side behavior and lets thin clients read/mutate them over the wire. These methods are global — like specialist.list / repo.list they do not require workspaceId (§3.6).

| Method | Params | Result |
| --- | --- | --- |
| settings.list | — | { settings: SettingDefinitionWithValue[] } (sensitive values redacted; TOML-backed entries carry `origin`) |
| settings.get | path (req) | { path, value, definition, origin? } — -32602 if path is unknown |
| settings.update | changes (req, array of { path, value, reason? }) | { applied: [{ path, value }] }; triggers settings:changed |
| settings.reset | path (req) | { path, value } (restores defaultValue) — -32602 if path is unknown |

`SettingDefinition`** shape:**

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

`changes` entries use the `AppSettingChange` shape `{ path, value, reason? }` (`reason` is an optional free-text audit note). `settings.update` **validates** each change against its definition (type / enum / min / max) and **persists** atomically; an unknown `path` or a value failing validation yields `-32602` and the whole batch is rejected (nothing applied). On success it emits a `settings:changed` notification (§6.5) carrying the applied `{ path, value }` pairs (sensitive values redacted).

**Storage & the `origin` field.** Non-secret human-editable settings are **TOML-backed**: they
persist in `<data_dir>/config.toml`, layered `defaults < config.toml < startup flags/env`.
For TOML-backed paths, `settings.get` (and each `settings.list`
entry) carries an additive `origin` field naming the layer the effective value came from:
`"default"` (absent from the file), `"file"` (explicit in config.toml), or `"flag"` (pinned at
boot by a startup flag / env var, e.g. `--insecure`, `INTENTD_TCP_PORT`). Secrets and the opaque
machine-state blobs (`repos.known`, `workspace.changeHistory`, `workspaceInitializer.state`,
`permissions.rules`, `userRules` / `workspaceRules`,
`endUserRules`) have **no** `origin` — they never live in config.toml (secrets stay in
`secrets.json`, state blobs stay in SQLite).
`settings.update` on a TOML-backed key rewrites config.toml atomically (temp file + rename,
comment/layout-preserving); external hand-edits of config.toml are live-reloaded (strict
re-parse, debounced; invalid content keeps last-good values) and emit the same
`settings:changed` notification. A key pinned by a startup flag is **read-only over the wire**
while pinned: `settings.update` / `settings.reset` on it yields `-32602` with a message naming
the overriding flag ("overridden by startup flag …").

**BE-exposed setting paths.** Only settings that affect daemon behavior are exposed:

- **Providers / agents:** `providers.active`, `providers.enabled`, `providers.paths.{auggie,claude-code,codex,…}`,`model.default`, `model.providerDefaults`, `backgroundAgents.defaultModel`,`backgroundAgents.typeOverrides`, `backgroundAgents.providerSettings`, `specialists.default`. Background-agent model resolution walks `backgroundAgents.typeOverrides[agentType]` → `backgroundAgents.defaultModel` → `model.providerDefaults[provider]` → `model.default`. The former `model.workspaceOverrides` key is **retired**: it is gone from the catalog (`settings.list` never advertises it; `settings.get` / `settings.reset` yield `-32602`), but `settings.update` **tolerates-and-ignores** the retired path for old clients — the entry is skipped (never validated, persisted, echoed in `applied`, or published in `settings:changed`) instead of rejecting the batch. Any stale SQLite row is deleted at boot, and a legacy `config.toml` key is still tolerated + stripped on boot with its value discarded.
- **Workspace / git:** `workspace.branchPrefix`, `workspace.worktreesLocation`,`workspace.sshKeyPath` *(string — filesystem path to the key, not key material; the real secret is the key file on disk, so the value is read back verbatim by the FE `git`-env consumer)*, `workspace.defaultShell`, `workspace.autoFetch`,`workspace.autoCommit`, `workspace.cowIsolation` *(boolean, default `false` — CoW workspaces + per-agent sandboxes: `workspace.create`/`workspace.duplicate` provision the checkout as a standalone CoW clone instead of a linked worktree (§5.1), and `agent.delegate` defaults `isolation` to `"cow"` when the param is omitted (§5.5); consulted only at provisioning time — the resulting `checkoutMode` is immutable per workspace (§5.1); requires CoW filesystem support on the workspaces root — the FE gates the toggle on `Workspace.cowSupported`)*.
- **MCP:** `mcp.enableUserServers`, `mcp.disabledServers`, `mcp.servers` *(sensitive)*.
- **Server / transport (new in intentd):** `server.socketPath`,`server.bindAddress`, `server.port` *(legacy port key — still exposed and validated, used in the `settings.*` examples below; the live WSS listener reads `server.wsApi.port`)*, `server.wsApi.enabled`, `server.wsApi.port`, `server.tls.enabled`, `server.auth.enabled`,`server.auth.token` *(sensitive; read-only / regenerate)*, `server.originAllowList`. The UDS listener always serves; the TCP/WSS listener is toggled at runtime by `server.wsApi.enabled` (the former `server.listenMode` key is retired — a config.toml still carrying it boots, is discarded, and is stripped from the file).
- **Source control (new in intentd, provider-agnostic):** `sourceControl.activeProvider` (enum,**default **`github`; v1 ships only `github`), `sourceControl.github.tokenSource`(`auto`|`env`|`gh-cli`|`explicit`; default `auto` — secrets store → env → `gh` CLI), `sourceControl.github.token` *(sensitive)*,`sourceControl.github.apiBaseUrl` (GitHub Enterprise support), `sourceControl.github.exposeGitCredentialToChildren` *(boolean, default `true` — inject the daemon-managed GitHub credential into child process environments (PTY terminals, agent provider shells) as a scoped github.com-only credential helper; never as a raw `GITHUB_TOKEN`/`GH_TOKEN`)*. Per-provider config is namespaced as`sourceControl.<provider>.*` so future hosts slot in as `sourceControl.gitlab.*`,`sourceControl.bitbucket.*`, etc. (replaces any flat `github.*` keys).
- **Linear (new in intentd):** `linear.token` *(sensitive)* — the Linear API key, persisted to the daemon's file-backed secret store (`~/intent/secrets.json`, `0600`) under account `linear.token`, the exact entry the `linear.*` namespace's secret-store-first `auto` token resolution reads (§5.28), so `settings.update` on this path is the FE "connect Linear" flow.
- **Sentry account (new in intentd):** `accounts.sentry.token` *(sensitive)* — the Sentry API tokenused by the `sentry.*` namespace (§5.29); `accounts.sentry.organization` *(string)* — the Sentryorganization slug (non-secret companion).
- **Persisted policy & rules (new in intentd):** `permissions.rules` *(object)* — persisted commandallow/deny/ask entries; `userRules` *(object)* — global user prompt-rule content;`workspaceRules` *(object)* — workspace-scoped prompt-rule content. Each is an opaque bagvalidated by shape only; downstream consumers own the internal schema.
- **Cross-workspace repos & history (new in intentd):** `repos.known` *(object)* — the daemon-owned known-repository list; `workspace.changeHistory` *(object)* — per-workspace diff-history bags. Both are non-sensitive; the daemon persists the JSON opaquely.
- **Workspace initializer (new in intentd):** `workspaceInitializer.state` *(object, non-sensitive, default `{}`)* — persisted home-screen workspace-initializer form state, opaque bag owned by the FE.
- **Context engine (new in intentd):** `context.enabled`, `context.auggiePath`, `context.allowIndexing`.
- **Storage / runtime (new in intentd):** `storage.dataDir`, `workspaces.root`, `logging.level`,`agents.maxConcurrent`, `agents.idleReapMinutes`.
- **Notifications:** `notifications.enabled`, `notifications.soundEnabled`, `notifications.soundOnlyWhenUnfocused`, `notifications.volume` (0..=1). The four `notifications.*` keys are daemon-owned; every entry is non-secret and reset-able via `settings.reset`.
- **Tools:** `rtk.enabled` *(boolean, default `false`)* — enables RTK compressed CLI output mode in agent prompts. When true and the `rtk` binary is detected on the daemon host's PATH, the system-prompt assembly pipeline injects an instruction layer listing RTK-compatible subcommands (filtered exclusion set). The daemon caches detection per run and never blocks prompt assembly; any failure treats `rtk` as unavailable. The flag is opt-in (default off) and gated behind binary availability, so disabling or removing `rtk` restores the original prompt behavior.

**Not exposed (FE-only).** Pure frontend/display settings are **out of **`intentd`** scope** and are**not** served by `settings.*`: `theme.*`, `fonts.*`, `ui.*`, `workspaceList.*`, `openIn.*`, `keybindings.*`, `promoBanners.*`, `activityLog.presets`,`model.pickerCollapsedGroups`, `preferences.spellcheckEnabled`, `preferences.betaUpdatesEnabled`,`providers.completedSetup`, `linear.issueFilter`.

```json
// → request — list all BE-owned settings (sensitive values redacted)
{ "jsonrpc":"2.0","id":51,"method":"settings.list" }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "settings": [
  { "path":"server.port","label":"WS port","description":"TCP port for the WSS listener",
    "category":"server","type":"number","min":1024,"max":65535,"defaultValue":5181,"value":5181 },
  { "path":"sourceControl.github.token","label":"GitHub token","description":"PAT used by octocrab",
    "category":"sourceControl","type":"string","sensitive":true,"value":null } ] } }
```

```json
// → request — read one setting
{ "jsonrpc":"2.0","id":52,"method":"settings.get","params":{ "path":"sourceControl.activeProvider" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "path":"sourceControl.activeProvider","value":"github",
  "origin":"default",
  "definition":{ "path":"sourceControl.activeProvider","label":"Source-control provider",
    "description":"Active forge implementation","category":"sourceControl","type":"enum",
    "enumValues":["github"],"defaultValue":"github" } } }
```

```json
// → request — mutate settings (emits settings:changed)
{ "jsonrpc":"2.0","id":53,"method":"settings.update","params":{ "changes":[
  { "path":"server.port","value":5182 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli","reason":"use gh auth token" } ] } }
// ← response
{ "jsonrpc":"2.0","id":53,"result":{ "applied":[
  { "path":"server.port","value":5182 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli" } ] } }
```

```json
// → request — reset one setting to its default
{ "jsonrpc":"2.0","id":54,"method":"settings.reset","params":{ "path":"server.port" } }
// ← response
{ "jsonrpc":"2.0","id":54,"result":{ "path":"server.port","value":5181 } }
```

### 5.13 Interactive `terminal.*`

> Alongside the read-only methods (`terminal.list` / `terminal.readOutput`, §5.9), the
> interactive methods below let a thin client open, drive, resize, and tear down PTYs that
> run on the **daemon host**. Terminals and scripts (§5.8) share one **unified PTY/terminal
> host** (`portable-pty`), each with a server-side scrollback ring buffer for replay on
> (re)connect; multiple clients may attach to the same session. Each PTY may carry an
> optional daemon-assigned display name (internal spawn metadata, e.g. `"Setup Script"`
> for the workspace setup terminal — §5.1); `terminal.create` does **not** accept a name
> parameter, and `terminal.list` (§5.9) surfaces the name with a `"Terminal"` fallback.

| Method | Params | Result |
| --- | --- | --- |
| terminal.create | workspaceId (req), cols (req,int), rows (req,int), cwd?, command?, env? (Record<string,string>) | { terminalId } — spawns a PTY; `command` omitted → default shell; `cwd` omitted → the workspace's worktree root (falls back to the daemon's cwd when the workspace has no resolvable worktree); `env` layers onto the daemon's inherited environment (later keys override) |
| terminal.write | terminalId (req), data (req, base64) | { ok: true } — `data` is base64-encoded input bytes |
| terminal.resize | terminalId (req), cols (req,int), rows (req,int) | { ok: true } |
| terminal.kill | terminalId (req) | { ok: true } — signals the PTY; emits `terminal:exit` (§6.5) |
| terminal.getBuffer | terminalId (req), maxBytes? | { terminalId, data } — base64 scrollback for replay |

**Base64 framing.** Terminal payloads are **binary-safe**: input (`terminal.write` `data`),
scrollback (`terminal.getBuffer` `data`), and streamed output (`terminal:data` `chunk`, §6.5)
are **base64-encoded** so arbitrary bytes (control sequences, UTF-8, non-text) survive the
JSON-RPC text channel. Clients decode on receipt and encode on send.
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

### 5.14 Execution locus, locality & remote behavior

All side effects — PTYs, scripts, file I/O, git, ACP provider processes — run on the **daemon
host**, not on the client. A thin client is a remote viewer/driver over the wire, so the
protocol surfaces **where** execution happens and adapts when the client is not on the same
machine.

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
| host.openInEditor | **client → daemon** (trigger) *and* **daemon → client** (reverse RPC, `id: "rev-<n>"`) | editorId (req), path (req), line?, column? | { ok: true } — launches the user's editor on `path` (optional `line`/`column` hint). **Client-callable trigger**: the FE calls this like any other method; on a local connection the daemon short-circuits via the resolved `host.listInstalledEditors` entry and launches on the daemon host, on a remote connection the daemon re-dispatches the intent to the connected client as the FE-served reverse RPC so the editor opens on the user's laptop. `-32602` on missing `editorId`/`path` or an `editorId` unknown to the platform catalog; `-32603` when the editor is not installed, the local host is headless, or the launch / reverse proxy fails |
| host.pickApplication | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | path (req) | { applicationId? } — **FE-served**: "open with…" chooser. On a local daemon returns `applicationId?` (or nothing when no chooser is available); on a remote daemon dispatches to the connected client and echoes its selection |
| host.listDirectory | client → daemon | path? | { path, parent, home, entries: [{ name, path, isDirectory, isGitRepo }] } — directory listing for the FE directory picker. `path` defaults to the daemon-host home when absent/empty, and a leading `~` / `~/` is **expanded to the daemon-host home on the daemon** (`~user` forms pass through verbatim) — so clients may send a raw typed `~/sub` even when they have no `home` to expand against (monorepo#824). `home` is always present (never null/omitted): it is the daemon-host home, falling back to `/` when no home can be resolved from the environment — the defaulted `path` and `~` expansion then resolve against `/` too. The returned `path`/`parent`/entry paths are always fully expanded; `parent` is `null` at the filesystem root; entries include hidden files (the FE filters), sorted directories-first then by name. IO failures surface as `-32603` |
| host.exec | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId? | { stdout, stderr, exitCode, timedOut? } — daemon-owned one-shot exec |
| host.execStream | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId?, stdin? (string), stdinBase64?, requestId? | { requestId } — daemon-owned **streaming** exec; stdout/stderr/exit surface as `host:exec:*` bus frames |
| host.execStream.write | client → daemon | requestId (req), stdin? (string), stdinBase64?, eof? (bool) | { ok: true } — write follow-up stdin to a live stream (closes the child's stdin end when `eof=true`) |
| host.execStream.cancel | client → daemon | requestId (req) | { ok: true, cancelled: bool } — reap a live stream's process group (idempotent on unknown ids) |

- `host.hasDisplay` / `host.locality` are also folded into the daemon's `status` / `doctor`
  reports, so a client can gate UI **before** connecting. When
  `hasDisplay=false`, clients should warn that GUI-spawning commands won't be visible.
- `host.openExternal` / `host.openInEditor` / `host.pickApplication` are **served by the
  frontend, not the daemon** (reverse RPCs — the *daemon* sends the JSON-RPC `request` and the
  connected client returns the `response`). Clients never call `openExternal` /
  `pickApplication` on the daemon; the daemon dispatches them to the client so these
  inherently-user-side GUI intents resolve on the user's machine. `host.openInEditor` is
  additionally **client-callable as a trigger** (the FE's "Open in editor / VS Code" buttons):
  the daemon serves the request by short-circuiting locally on a local connection, or by
  re-dispatching the same intent to the connected client as the FE-served reverse RPC on a
  remote connection. Reverse-request ids are always in the `rev-<n>` namespace (allocated
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
  stay on `script.*` and `terminal.*` (§5.8, §5.13) — `host.exec` is one-shot only.
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
    output crosses the wire intact (mirrors `terminal:data.chunk`). **Transient /
    broadcast-only** (same publish path as `agent:stream:chunk`, §7): never persisted,
    invisible to `event.query` (§5.10).
  - `host:exec:stderr` — same shape (and transience) as stdout, over the child's stderr.
  - `host:exec:exit` — terminal: `{ requestId, ok, exitCode?, timedOut?, cancelled? }`.
    Emitted exactly once (durable); subscribers unregister on receipt.
  Callers pipe stdin two ways: an optional initial `stdin`/`stdinBase64` on the request itself
  (written to the child before any reader task starts) and follow-up `host.execStream.write
  { requestId, stdin?, stdinBase64?, eof? }` calls that append bytes and optionally close the
  child's stdin end (`eof=true`) so a reader-to-EOF like `cat` / `augment-cli` finishes
  cleanly. Only one of `stdin` / `stdinBase64` may be set per request. `host.execStream.cancel
  { requestId }` reaps the whole process group (SIGTERM → grace → SIGKILL, mirroring the
  `host.exec` timeout path) and is idempotent on unknown / already-finished ids
  (`cancelled:false` still surfaces `ok:true`). Command payloads carry env values that are
  **never logged or streamed** — only `stdout` / `stderr` / exit metadata crosses the wire.
- **ACP model/readiness handshake probes ride `host.execStream`** — the four
  bidirectional-stdio provider probes (codex / claude-code / pi / droid) that R1b retired do
  **not** get a dedicated `provider.probeAcp` RPC. Every guarantee an ACP handshake needs is
  already on this surface: argv-only spawn (no shell), `PATH` enrichment, workspace-cwd
  containment, secret-safe env, initial `stdin` payload written before any reader task starts,
  `timeoutMs` reap of the whole process group, and a terminal `host:exec:exit` frame carrying
  `timedOut` / `cancelled` metadata. A thin FE probe therefore (1) calls `host.execStream`
  with `command`+`args` for the ACP CLI and the `initialize` JSON-RPC line as `stdin`,
  (2) subscribes to `host:exec:*` frames correlated by `requestId`, (3) parses the
  `\n`-terminated JSON reply out of the base64 stdout chunks, and (4) closes the child via
  `host.execStream.write { eof:true }` (clean exit) or `host.execStream.cancel` (force reap).
  The `providerId` a caller would want to tag such a probe with never needed to cross the
  wire — it stays as FE-local correlation. Retiring the pre-R1b probes in favor of this
  reuse keeps the daemon a **thin process host** and avoids duplicating spawn / reap / stdin
  plumbing behind a purpose-built RPC.

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
// reverse RPC — daemon → client — open a detected URL on the user's machine (FE-served)
// ← daemon sends the request (id in the `rev-<n>` namespace)
{ "jsonrpc":"2.0","id":"rev-1","method":"host.openExternal","params":{ "url":"http://localhost:3000" } }
// → client replies with the same rev-* id
{ "jsonrpc":"2.0","id":"rev-1","result":{ "ok": true } }
// client-called trigger — FE asks the daemon to open the user's editor
// (local daemon: direct launch; remote daemon: re-dispatched as the reverse RPC below)
{ "jsonrpc":"2.0","id":81,"method":"host.openInEditor","params":{
  "editorId":"vscode","path":"/repo/src/main.rs","line":12,"column":3
} }
// ← { "jsonrpc":"2.0","id":81,"result":{ "ok": true } }
// reverse RPC — daemon → client — launch the user's editor on the user's machine (FE-served; local daemons short-circuit)
// ← daemon sends the request
{ "jsonrpc":"2.0","id":"rev-2","method":"host.openInEditor","params":{
  "editorId":"vscode","path":"/repo/src/main.rs","line":12,"column":3
} }
// → client replies
{ "jsonrpc":"2.0","id":"rev-2","result":{ "ok": true } }
// reverse RPC — daemon → client — present "open with…" chooser on the user's machine (FE-served)
// ← daemon sends the request
{ "jsonrpc":"2.0","id":"rev-3","method":"host.pickApplication","params":{ "path":"/repo/README.md" } }
// → client replies with the selection
{ "jsonrpc":"2.0","id":"rev-3","result":{ "applicationId":"com.microsoft.VSCode" } }
// client-called trigger — FE binding (ws.browser.exec) asks the daemon to run CDP actions
// (daemon validates the envelope and dispatches the reverse RPC below to the same FE)
{ "jsonrpc":"2.0","id":85,"method":"browser.exec","params":{
  "actions":[{"action":"listTabs"}],"tabId":"tab-1","agentId":"agent-1","workspaceId":"ws-1"
} }
// ← single-action → the action's envelope
{ "jsonrpc":"2.0","id":85,"result":{ "action":"listTabs","success":true,"result":[{"id":"tab-1"}] } }
// reverse RPC — daemon → client — run CDP actions against the embedded browser (FE-served, §5.9)
// ← daemon sends the request (envelope forwarded verbatim)
{ "jsonrpc":"2.0","id":"rev-4","method":"browser.exec","params":{
  "actions":[{"action":"listTabs"}],"tabId":"tab-1","agentId":"agent-1","workspaceId":"ws-1"
} }
// → client replies with the raw execution envelope (daemon reshapes for the caller)
{ "jsonrpc":"2.0","id":"rev-4","result":{ "success":true,"results":[
  { "action":"listTabs","success":true,"result":[{"id":"tab-1"}] }
] } }
// AGENT-INITIATED `browser.exec` (REV-1, interim) — the MCP `ws.browser.exec`
// binding has no ambient client connection, so the daemon routes the reverse
// RPC to the FIRST-connected live client (across UDS + WSS). When that client
// disconnects the next-connected one takes over; when no client is connected
// the call fails fast with `-32603` "browser.exec: no client connected".
// Wire shape of the reverse RPC and its result is unchanged from the
// client-triggered case above.
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

### 5.15 `search.*`

> Search is a **BE-owned namespace**: it executes on the daemon **where the code and data
> live**, so a thin client just renders results (when the daemon *is* the remote host, `rg`
> runs locally to it).

| Method | Params | Result |
| --- | --- | --- |
| search.inFiles | workspaceId (req), query (req), opts? { caseSensitive?, regex?, globs?, maxResults? }, requestId? | { requestId, matches: SearchMatch[], truncated } — ripgrep content search |
| search.fileNames | workspaceId (req), pattern (req), limit?, requestId? | { requestId, files: string[], truncated } — path/glob search |
| search.messages | workspaceId (req), query (req), agentId?, role?, limit?, requestId? | { requestId, matches: MessageMatch[] } — over persisted agent sessions (BE owns session storage) |
| search.events | query (req), workspaceId?, limit?, requestId? | { requestId, matches: EventMatch[] } — over the BE event log |
| search.memories | query (req), workspaceId?, requestId? | { requestId, matches: MemoryMatch[] } — over the BE memories store |
| search.notes | query (req), requestId? | { requestId, matches: NoteMatch[] } — over the BE notes store (global; no workspaceId) |
| search.codebase | workspaceId (req), query (req), requestId? | { requestId, matches: CodebaseMatch[] } — **ripgrep/symbol-backed** search. auggie exposes no structured codebase-retrieval CLI, so `AuggieContextEngine::retrieve()` returns `Unavailable` instantly and ripgrep is the backing; the `ContextEngine` trait is retained as forward-looking infra |
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

### 5.16 `drafts.*`

> Message drafts (typed-but-not-sent input) are BE state, keyed by
> **`(workspaceId, agentId, clientId)`** — where `clientId` is the stable client identity from
> `client.hello` (§5.17) — so each client keeps its **own private** draft that survives
> reconnects. With multiple thin clients connected to one daemon, per-client local storage
> would not survive reconnects or share across devices, and concurrent writers would clobber
> each other.

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

**Opaque keys & reserved sentinels.** `workspaceId` / `agentId` are **opaque draft keys** — the
daemon never validates them against live workspaces or agents. The FE reserves the sentinel pair
**`"__new-workspace__"` / `"__initializer__"`** for the New Workspace modal's pre-creation draft
(no workspace/agent exists yet); it is per-client like any other draft and the FE clears it on
successful `workspace.create`. The `__…__` form cannot collide with real IDs (daemon-generated
workspace slugs are lowercase alphanumerics + hyphens).

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

### 5.17 `client.hello` handshake & stable client identity

The daemon supports a **stable, client-supplied identity** that survives reconnects; the ephemeral
per-connection id used internally for subscription bookkeeping is retained purely for transport
bookkeeping and never crosses the wire.

| Method | Params | Result |
| --- | --- | --- |
| client.hello | clientId?, name?, capabilities? | { clientId, protocolVersion, server: { locality, hasDisplay, osArch, version, protocolVersion, capabilities } } |

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
  `hasDisplay` (GUI present on the daemon host), `osArch` (e.g. `darwin/arm64`), `version`
  (daemon version string), `protocolVersion` (the JSON-RPC surface version, `"2.7"`), and
  `capabilities` (feature-detection flags, e.g. `{ "liveState": true }` for the snapshot+delta
  channels of §6.9).
- **`protocolVersion`.** The top-level `protocolVersion` is an explicit copy of
  `server.protocolVersion` so clients can version-check without digging into the `server` block
  (see [Protocol Version & Compatibility](#protocol-version--compatibility)).

```json
// → first call after auth: client re-presents its persisted clientId
{ "jsonrpc":"2.0","id":1,"method":"client.hello",
  "params":{ "clientId":"cli-7f3a","name":"Intent Desktop","capabilities":{ "forward":true,"openExternal":true } } }
// ← response — capabilities of the daemon host
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-7f3a","protocolVersion":"2.7",
  "server":{ "locality":"remote","hasDisplay":false,"osArch":"linux/x86_64","version":"0.1.0",
    "protocolVersion":"2.7","capabilities":{ "liveState":true } } } }
```

```json
// → first-ever connect: no clientId yet, server mints one
{ "jsonrpc":"2.0","id":1,"method":"client.hello","params":{ "name":"Intent Desktop" } }
// ← server returns a clientId for the client to persist
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-9b21","protocolVersion":"2.7",
  "server":{ "locality":"local","hasDisplay":true,"osArch":"darwin/arm64","version":"0.1.0",
    "protocolVersion":"2.7","capabilities":{ "liveState":true } } } }
```

**Errors.** A malformed `clientId` (non-string) → `-32602`. The handshake is idempotent:
re-sending `client.hello` on the same connection updates `name` / `capabilities` and re-returns
the same `server` block.

### 5.18 `accept-changes.*`

The multi-step "accept the agent's work" workflow: the backend owns local git **and** the forge
(the `SourceControl` trait), so a thin client drives commit → push → create-PR →
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
reset-to-trunk \| rebase-onto-trunk` — except **`export` is not supported** (no UI consumer),
so `execute` rejects `action:"export"`. A step that fails sets `success:false` and the offending
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
  `{ hash, message, author, date, filesChanged?, isPushed, files?: [{ path, additions?,
  deletions?, status? }], agentId?, linkedNoteId? }`. `files` and `filesChanged` are
  emitted only when the producing walk computed per-commit tree diffs. All current
  producers are **metadata-only** (both fields omitted — the list walks skip
  per-commit diffs for performance; clients fetch per-file data on demand via
  `git.commitDetails` (§5.6)): `accept-changes.getStatus` `localCommits` and
  `file-tracking.loadCommits` (§5.19). The `changes:git-status` event (§6.5) carries
  the same reduced `WorkspaceGitStatus`.
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
  stored inside the backend; never returned by a `diffs.*` RPC.
  Diff content reaches the client only via the `file-tracking.*` reads and the §6.5 change events.

### 5.19 `file-tracking.*` (reads)

A per-file audit trail as changes move through the git stages
(`unstaged → staged → committed → pushed → pull_request → merged`) with agent attribution. Only
the **UI-invoked reads** are wire methods; the attribution writer `trackChange` is **internal**
(the backend records it as agents edit files — no client RPC; see §6.8). Every method requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| file-tracking.getChanges | workspaceId (req), filter?: { stage?, agentId?, sessionId?, turnNumber?, filePattern?, since?, until? } | { changes: TrackedChange[], truncated, totalCount } |
| file-tracking.loadCommits | workspaceId (req), limit?: number (default 50, ≤200), nextToken?, includeOlder?: boolean (default false) | { commits: CommitWithAttribution[], boundarySha, nextToken } — **metadata-only** entries (see the CommitWithAttribution schema, §5.18): the bounded walk skips per-commit tree diffs; clients fetch per-file data on demand via `git.commitDetails` (§5.6). Boundary semantics below |
| file-tracking.getLineStats | workspaceId (req) | { additions, deletions } — real-time totals across unstaged + staged + local commits |
| file-tracking.stage | workspaceId (req), paths (req): string[] | { ok: true } — stages the referenced files |
| file-tracking.unstage | workspaceId (req), paths (req): string[] | { ok: true } — unstages the referenced files |

**`file-tracking.loadCommits` boundary semantics.** The commit walk is bounded by the workspace's **boundary commit** so a workspace only surfaces its own history:

- When `includeOlder` is `false` (default), returns commits in the `boundary..HEAD` range (workspace-owned commits only).
- When `includeOlder` is `true`, returns commits before and including the workspace boundary (for "show previous" functionality; the boundary commit itself is included).
- `boundarySha` is the workspace boundary commit SHA, or `null` when the workspace has no boundary info (`baseRef` or `baseCommitSha` not set), or when boundary info exists but cannot be resolved (e.g. shallow clone, nonexistent ref, base commit not an ancestor of HEAD).
- **Fail-closed safety net:** when boundary info exists but cannot be resolved, the method returns an empty commit list (regardless of `includeOlder`) to prevent leaking arbitrary base-branch history.
- **Boundary resolution strategy:** (1) prefer the merge-base of HEAD with `origin/<baseRef>` or `<baseRef>` (rebase-resilient); (2) fall back to `baseCommitSha` if it is a valid ancestor of HEAD; (3) return `null` if neither resolves.
- `nextToken` in the result is the pagination token for the next page, or `null` when exhausted; pass it back as the `nextToken` parameter.

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

### 5.20 Change metrics (reads)

Read-only line-change aggregates. Aggregation
itself (`metrics.calculate`, the `update*` writers, `mark-agent-active`) is **internal** — the
backend computes metrics as agents work and pushes change events (§6.5); clients only **read**.
Metrics are durable (the `workspace_metrics` / `agent_metrics` tables).

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

### 5.21 `rules.*`

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
exists. The composition (with the agent-id alias map and the utility/background-agent
special-cases) remains internal — no method or shape changes.

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

### 5.22 `mcp.servers.*`

The **external** MCP-server lifecycle/config surface, backed by the `mcp.servers` setting
(**sensitive** — §5.12; secrets in `env`/`headers` are redacted on the wire). This is the
**user-facing** management surface: register, edit,
enable/disable, and restart MCP servers the daemon hosts. It is **distinct** from the **agent→BE
MCP callback**, which lets a running agent reach BE-hosted MCP tools
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
  supported — `http`/`sse` are not** (such a server returns an error status rather than
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

> **No `memories.*` wire surface.** Long-term agent **memories** exist as an internal context source the
> agent runtime consumes; they are **not** exposed over the wire (no client caller). The internal
> `memories` table ships and the internal `search.memories` path scans it; a `memories.*` namespace
> (list/create/search/delete) could be added additively later **only if** a memories UI ever ships.

#### 5.22.1 `mcp.oauth.*` — per-server OAuth token bags

Companion to §5.22: manage the OAuth token bag associated with each external MCP server id.
Bags are **secret material**; the daemon
persists them in the dedicated `mcp_oauth_tokens` table and every wire response is
**presence-only** — the bag body **never** crosses the wire (mirrors the `settings.*`
redaction seam and `mcp.servers.*` `env`/`headers` redaction). Internal daemon consumers that
need to build an outbound request read the raw bag directly from the store; there is no
"reveal" RPC. This is a separate namespace (not a `settings.*` key) because bag counts are
unbounded and rotate independently of the config surface.

| Method | Params | Result |
| --- | --- | --- |
| mcp.oauth.list | — | `{ tokens: [{ serverId, value }] }` — one entry per stored bag, `value` always the redaction placeholder |
| mcp.oauth.get | serverId (req) | `{ serverId, value }` — `value` is the placeholder when a bag exists and `null` when it does not |
| mcp.oauth.set | serverId (req), tokenBag (req) | `{ serverId, value }` — persists the bag; `value` is always the placeholder (bag itself is never echoed) |
| mcp.oauth.delete | serverId (req) | `{ success: true }` — idempotent (absent bag succeeds) |

- `tokenBag` is an opaque JSON body (object / array / scalar) so the FE's bag shape can
  evolve without a daemon change; the typical bag is
  `{ access_token, refresh_token?, expires_at?, token_type? }`.
- Missing/empty `serverId` yields `-32602`; `mcp.oauth.set` also requires `tokenBag`.
- No `mcp.oauth:*` events are emitted — token rotation is a client-driven flow and the FE
  polls / re-fetches on demand.

```json
// → request — persist an OAuth bag for one MCP server
{ "jsonrpc":"2.0","id":62,"method":"mcp.oauth.set",
  "params":{ "serverId":"srv-linear",
             "tokenBag":{ "access_token":"…","refresh_token":"…",
                          "expires_at":1750000000,"token_type":"Bearer" } } }
// ← response (bag never echoed — value is a placeholder)
{ "jsonrpc":"2.0","id":62,"result":{ "serverId":"srv-linear","value":"********" } }

// → request — list stored bags (presence only)
{ "jsonrpc":"2.0","id":63,"method":"mcp.oauth.list" }
// ← response
{ "jsonrpc":"2.0","id":63,"result":{ "tokens":[
  { "serverId":"srv-linear","value":"********" } ] } }
```

### 5.23 Usage metrics — `workspace.getTokenUsage`

The backend owns token/credit **usage accounting**. Usage is sourced **live from ACP**: at the end
of each prompt turn, the `PromptResponse.usage` report (via the agent-client-protocol
`unstable_end_turn_token_usage` feature flag) carries the session's **cumulative** counters; the
daemon persists that snapshot per session with **REPLACE semantics** (each report replaces the
session's previous snapshot — reports are never summed), mapping ACP `cachedReadTokens` →
`cacheReadTokens` and `cachedWriteTokens` → `cacheCreationTokens`, then immediately re-aggregates
per agent and per model and writes the durable `tokenUsage` field on the `Workspace`. The
turn-end bookkeeping is **detached** from the turn itself — it never delays the terminal
`agent:stream:end`, and bookkeeping for the same agent is ordered across turns — so a client
reading `workspace.getTokenUsage` immediately after `agent:stream:end` may briefly see the
previous tally; rely on `workspace:tokenUsage-changed` (§6.5) to observe the update.
**Usage survives ACP session recreation:** when a `session/load` → `session/new` ACP session
recreate swaps in a fresh ACP session id — whether via the resume-impossible fallback (a failed
`session/load`), `agent.editAndRegenerate`'s forced recreate, or the `agent.retry`
poisoned-session recreate ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940)) —
the outgoing session's
cumulative snapshot is folded into a daemon-internal per-agent **baseline** (saturating sum) and
the snapshot is cleared, atomically with the id swap — the recreated session's cumulative reports
restart from zero, so per-agent effective totals are **baseline + snapshot**. The baseline is
internal accounting only (never on the wire; `TokenUsage` shapes are unchanged), and the legacy
per-message **message-sum fallback** applies only when both baseline and snapshot are absent. A
daemon-internal periodic **scan** (300 s cadence) is demoted to a **reconciliation fallback** for
sessions the live path cannot see (providers without end-of-turn usage reports / legacy
per-message metadata); a reconciliation recount that comes back all-zero **never regresses** a
stored non-zero live tally to zero **while agent-session rows still exist** (the racing-sweep
guard). When the workspace has no sessions left (all deleted), an all-zero recount is legitimate
and writes through — clients must not assume `tokenUsage` can never drop back to zero. Only the
**read** and its change event cross the wire —
neither the live update nor the scan has an RPC (§6.8). `workspace.getTokenUsage` requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| workspace.getTokenUsage | workspaceId (req) | { tokenUsage: TokenUsage } — -32602 if the workspace is not found |

**TokenUsage** — `{ byAgentId: { [agentId]: TokenUsageTotals }, totals: TokenUsageTotals,
byModel: { [modelName]: TokenUsageTotals }, lastScanAt: string | null }`, where
**TokenUsageTotals** is the four consumption counters
`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`. `byAgentId` keys are
`agent-{uuid}`; `byModel` keys are the effective model name (`"unknown"` fallback); `lastScanAt` is
the RFC-3339 timestamp of the last recompute — a live turn-end update or a reconciliation pass
(`null` before the first). Updated values are pushed via `workspace:tokenUsage-changed` (§6.5).

```json
// → request
{ "jsonrpc":"2.0","id":62,"method":"workspace.getTokenUsage","params":{ "workspaceId":"ws-abc" } }
// ← response (pushed again as workspace:tokenUsage-changed whenever the tally changes — at turn end or after a reconciliation pass)
{ "jsonrpc":"2.0","id":62,"result":{ "tokenUsage":{
  "byAgentId":{ "agent-123":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 } },
  "byModel":{ "opus-4.8":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 } },
  "totals":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200 },
  "lastScanAt":"2026-06-17T12:00:00Z" } } }
```

### 5.24 Session stats — `agent.getSessionStats`

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

### 5.25 Worktree setup scripts — `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript`

A per-workspace **setup script** that provisions a fresh worktree (install deps, build prereqs, …),
**persisted in `.intent/config.json`** in the worktree (committable, repo-scoped). The workspace
DB `setup_script` field is retired from all write paths (kept for wire compat and legacy
read-only fallback only). `detectProjectType` inspects manifest files to classify the project;
`generateSetupScript` is the **AI-assisted** generator. Every method requires `workspaceId`.

**Setup script execution:** When a workspace is created (`workspace.create`) and an effective
setup script exists (non-empty, resolved from worktree `.intent/config.json` or legacy DB
fallback), the daemon executes it non-blocking (fire-and-forget spawn) after worktree
provisioning in the worktree directory via `/bin/sh` (POSIX; on Windows, via a discovered
Git-for-Windows `sh.exe` running the same POSIX wrapper, falling back to a `cmd.exe` `.cmd`
wrapper that receives the script path through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT`
(repository root path), `WORKTREE_PATH` (the new worktree path), `BRANCH_NAME` (workspace
branch), and `SOURCE_BRANCH` (baseRef when provided, empty string otherwise). Execution never fails workspace creation —
errors are logged and surfaced. Script output is streamed to a workspace terminal named
**"Setup Script"** (its daemon-tracked PTY display name in `terminal.list`, §5.9); a POSIX-sh
timing wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) appends a
newline-prefixed `Setup script completed in <N>s (exit code <C>)` /
`Setup script failed in <N>s (exit code <C>)` summary to the scrollback, preserving the
script's exit code (§5.1).

| Method | Params | Result |
| --- | --- | --- |
| workspace.getSetupScript | workspaceId (req) | { setupScript: SetupScript } — reads from worktree `.intent/config.json` (when present), falls back to legacy DB row `setup_script` (read-only) |
| workspace.saveSetupScript | workspaceId (req), script (req): string | { setupScript: SetupScript } — writes to worktree `.intent/config.json` (merge semantics, best-effort) and returns synthesized record; DB field is not written. Returns -32602 (invalid params) when the workspace has no `worktreePath` or `repositoryPath` |
| workspace.detectProjectType | workspaceId (req) | { projectType: ProjectType \| null } — null when no known manifest is found |
| workspace.generateSetupScript | workspaceId (req) | { setupScript: SetupScript } — AI-assisted draft (returned, not auto-saved; persist with saveSetupScript) |

- **SetupScript** — `{ script: string, projectType?: ProjectType, updatedAt: number,
  generatedBy?: "user"\|"agent" }`. `generatedBy` records whether the body was hand-written
  (`saveSetupScript`) or AI-drafted (`generateSetupScript`); `updatedAt` is the last-write epoch-ms.
  When read from `.intent/config.json`, `generatedBy` is synthesized as `"user"`.
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
> These are documented so the surface is anticipated.

> **Observability is internal, not wire.** Tracing, structured logging, and log files are
> **daemon-internal** operational concerns — there is **no** `logging.*` / `telemetry.*` wire
> surface, and none is planned for v1. Clients observe backend work through domain **events** (§6.5),
> not through a logging API.

### 5.27 `github.*` namespace

> The `github.*` namespace is served **daemon-owned** against `api.github.com` — 23 methods, with real `nextToken`/`limit` pagination on the list reads (the uniform-pagination contract described in the conventions below), reusing the `intent-sourcecontrol` **octocrab** engine — the same engine that already backs `pr.*`. The auth trio (`connect` / `cancelAuth` / `revoke`) drives a daemon-owned **OAuth device flow** (see the auth-model note below). The field names and shapes here are the source of truth for both sides.
>
> **Namespace split.** Local git operations stay on `git.*` (§5.6). Everything
> that hits `api.github.com` — repo/PR/issue browse, PR review comments + threads — plus GitHub
> **auth** and GitHub-**derived identity** live on `github.*`. The existing `pr.*` methods (§5.7) are
> deliberately **workspace/active-PR scoped** (`ws` → owner/repo/number) and are left **untouched**;
> `github.*` is the **explicit-addressing** surface — every data method takes `(owner, repo[, number])`
> rather than resolving from the workspace.

> **Auth model — OAuth device flow, daemon-owned (with env-PAT fallbacks).** `github.connect`
> starts GitHub's **OAuth device flow** (no client secret, no callback URL — only a public OAuth
> App client id, `sourceControl.github.oauthClientId`): the daemon requests a `user_code`, hands it
> to the client, and **polls GitHub in the background** until the user authorizes at
> `github.com/login/device` (or the codes expire / the user denies). On authorize the access token
> is persisted server-side under `sourceControl.github.token` — the **first slot** of the existing
> `intent-sourcecontrol` resolution chain, ahead of the `GITHUB_TOKEN` / `GH_TOKEN` env vars and
> the `gh auth token` fallback (§5.12) — so every `github.*` / `pr.*` consumer picks it up with
> zero resolution changes. Because the daemon owns the poll loop, the flow **survives client
> refreshes**: a reconnecting client re-reads the in-flight state from `github.authStatus`.
>
> - `github.authStatus` validates the resolved token via `GET /user` and reports connection state,
>   plus the in-flight device flow (if any) under `deviceFlow`.
> - `github.connect` starts the flow (or returns the **same codes** while one is still pending —
>   idempotent); terminal transitions are pushed as `github:auth-changed` events (§6.5).
> - `github.cancelAuth` aborts a pending flow; `github.revoke` deletes the **stored** token (env /
>   `gh` fallbacks are untouched — they re-resolve on the next probe).
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
missing/invalid params and "not found" (404) lookups → `-32602` **unless a method row documents a
graceful null/exists result** (e.g. `github.repos.get` → `{ repo: null }`, `github.repoConfig.get`
→ `{ config: null, exists: false }`); a token that is absent or fails `GET /user`, and any other
GitHub/service failure → `-32603` with a descriptive `message`
(e.g. `"GitHub is not configured."`). There are **no** custom numeric codes.

#### Repos & branches

| Method | Params | Result |
| --- | --- | --- |
| github.repos.list | limit?, nextToken? | { repos: GithubRepo[], nextToken? } — the authenticated user's repositories (`GET /user/repos`) |
| github.repos.search | query (req), limit?, nextToken? | { repos: GithubRepo[], nextToken? } — `GET /search/repositories` (FE rewrites `owner/name` → `name user:owner`, sorted by stars) |
| github.repos.get | owner (req), repo (req) | { repo: GithubRepo \| null } — `GET /repos/{owner}/{repo}` (repo metadata incl. `defaultBranch`) |
| github.branches.list | owner (req), repo (req), limit?, nextToken? | { branches: string[], nextToken? } — **remote** branch names (`GET /repos/{owner}/{repo}/branches`) |
| github.repoConfig.get | owner (req), repo (req), ref? | { config: RepoConfig \| null, exists: boolean } — the repo's `.intent/config.json` fetched via the contents API (`GET /repos/{owner}/{repo}/contents/.intent/config.json`, no clone; `ref` defaults to the default branch). A missing file (or missing repo/ref) → `{ config: null, exists: false }` — an **explicit exception** to the namespace's 404→`-32602` convention above: all 404s are graceful "no config" outcomes, never errors (transport/auth failures still surface as `-32603` like the other `github.*` methods). A present but invalid/mis-shaped file folds **tolerantly** to `{ config: {}, exists: true }` (mirrors the `repoConfig.get` §5.33 parse semantics). Same camelCase `RepoConfig` shape as §5.33, unknown keys preserved (v2.4) |

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| github.authStatus | — | { isConfigured, oauthUrl, configuredButNeedsUpdate, updatedScopes, deviceFlow } — `isConfigured` = a token resolves **and** `GET /user` succeeds. `deviceFlow` is `null` when no flow is in flight, else `{ status: "pending"\|"expired"\|"denied"\|"error", userCode, verificationUri, expiresIn, interval }`; while a flow is live `oauthUrl` carries the `verificationUri` (FE shape parity). `configuredButNeedsUpdate` is `false` and `updatedScopes` is `""` (kept for FE shape parity) |
| github.connect | — | { ok: true, userCode, verificationUri, expiresIn, interval } — starts the OAuth **device flow** (or returns the SAME codes while one is pending — idempotent). The daemon polls GitHub in the background; terminal transitions arrive as `github:auth-changed` events (§6.5). A missing/empty `sourceControl.github.oauthClientId` or an unreachable login host → `-32603` |
| github.cancelAuth | — | { ok: true, cancelled } — aborts a pending device flow (`cancelled: true` iff one was pending; idempotent no-op otherwise) |
| github.revoke | — | { ok: true } — deletes the **stored** `sourceControl.github.token` and aborts any in-flight flow; emits `github:auth-changed { status: "revoked" }`. Idempotent; env / `gh` fallbacks are untouched |
| github.getUser | — | { user: GithubUser \| null } — authenticated identity from `GET /user`; never includes the token |

#### Pulls

`createPullRequest` sends `head` **verbatim** (no `owner:branch` login prefix) — preserving the
FE's "bypass the buggy backend" behavior for same-repo branches.

| Method | Params | Result |
| --- | --- | --- |
| github.pulls.create | owner (req), repo (req), title (req), body (req), head (req), base (req), draft? | { pull: GithubPullRequest \| null } — `POST /repos/{owner}/{repo}/pulls` (head verbatim) |
| github.pulls.get | owner (req), repo (req), number (req) | { pull: GithubPullRequest \| null } — `GET /repos/{owner}/{repo}/pulls/{number}` |
| github.pulls.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", head?, base?, sort?: "created"\|"updated"\|"popularity"\|"long-running", direction?: "asc"\|"desc", limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /repos/{owner}/{repo}/pulls` |
| github.pulls.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"review-requested"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /search/issues?q=is:pr repo:{o}/{r} is:{state} {author\|assignee\|review-requested\|involves}:@me {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter:"all"`+`state:"open"` with no `query` delegates to `github.pulls.list` |
| github.pulls.merge | owner (req), repo (req), number (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | { merged, message, sha? } — `PUT /repos/{owner}/{repo}/pulls/{number}/merge` |
| github.pulls.updateBranch | owner (req), repo (req), number (req), expectedHeadSha? | { message, url? } — `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` |

#### Issues

| Method | Params | Result |
| --- | --- | --- |
| github.issues.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", assignee?, creator?, labels?, sort?: "created"\|"updated"\|"comments", direction?: "asc"\|"desc", limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /repos/{owner}/{repo}/issues` (items carrying `pull_request` are filtered out) |
| github.issues.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /search/issues?q=is:issue repo:{o}/{r} [state:{state}] {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter` is validated (invalid → `-32603`) but — unlike `github.pulls.search` — adds **no** `@me` qualifier yet (v1 limitation: the engine cannot express issue involvement), so only a non-blank `query` routes through `GET /search/issues`; without one the method delegates to the repo-issue listing (`GET /repos/{o}/{r}/issues`) filtered by state, regardless of `filter` |

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
// → check GitHub auth (validates the resolved token via GET /user)
{ "jsonrpc":"2.0","id":50,"method":"github.authStatus","params":{} }
// ← response (token present and valid, no flow in flight)
{ "jsonrpc":"2.0","id":50,"result":{
  "isConfigured": true, "oauthUrl": "", "configuredButNeedsUpdate": false, "updatedScopes": "",
  "deviceFlow": null } }
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
// → start the OAuth device flow (daemon polls GitHub in the background)
{ "jsonrpc":"2.0","id":53,"method":"github.connect","params":{} }
// ← response — the user enters userCode at verificationUri
{ "jsonrpc":"2.0","id":53,"result":{
  "ok": true, "userCode": "ABCD-1234", "verificationUri": "https://github.com/login/device",
  "expiresIn": 900, "interval": 5 } }
// … the user authorizes on github.com; the daemon's background poll persists
//   the token server-side and pushes the terminal transition:
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"…","event":{
  "type":"github:auth-changed", "data":{ "status":"authorized" }, "…":"…" } } }
```

### 5.28 `linear.*` namespace

> The full `linear.*` read surface — `linear.authStatus`, `linear.listIssues`, `linear.searchIssues`, `linear.getIssue`, `linear.viewer`, `linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`, `linear.listLabels` — plus the issue-write methods `linear.createIssue` / `linear.updateIssue` are served **daemon-owned** against Linear's GraphQL API (`POST https://api.linear.app/graphql`) via the `intent-linear` crate. The `filter` values map to **typed Linear GraphQL filters server-side**. Only the `linear.listComments` / `linear.createComment` comment surface (no FE shape) remains out of scope — see "Deferred — comments" below. The field names and shapes here are the source of truth for both sides.

> **Auth model — personal API key (no OAuth/device flow).** A local
> daemon has no hosted OAuth callback, so v1 authenticates with a **Linear personal API key**: the
> default `auto` resolution tries the secret-store account `linear.token` first (the daemon's
> file-backed secret store; settable via `settings.update { path: "linear.token" }`, §5.12), then falls back to the
> `LINEAR_API_KEY` environment variable. Linear is GraphQL-only; the key is sent as the **`Authorization: <key>` header
> with NO `Bearer` prefix** for `lin_api_…` personal keys (a future OAuth access token would use
> `Authorization: Bearer <token>` — the prefix differs by credential type).
>
> - `linear.authStatus` validates the resolved key via the GraphQL `viewer` probe and reports
>   connection state.
> - **There is no `linear.connect` / `linear.revoke` / `cancelAuth` wire method.** Unlike `github.*`
>   (which keeps inert no-op `connect`/`revoke` for FE shape parity), Linear exposes **nothing**
>   here: "connect" is `settings.update` on the `linear.token` catalog entry (§5.12) — or set
>   `LINEAR_API_KEY` — "revoke/logout" is `settings.reset { path: "linear.token" }`, and
>   `cancelAuth` was always a pure client-side no-op.
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
returned). The two issue reads — `linear.listIssues` and `linear.searchIssues` — are
**cursor-paginated** per the §5.5 conventions: they accept an optional **opaque base64**
`nextToken` (the token echoed by a previous page; a malformed token degrades to the first
page, matching the `github.*` reads) and return a
`{ issues: LinearIssueResult[], nextToken: string|null }` envelope where `nextToken` is an
opaque base64 string when another page exists and an explicit `null` on the last page. The
underlying Linear GraphQL `pageInfo.endCursor` / `after` cursor is a server-side detail
clients MUST treat as opaque. Every other Linear arm returns a **bare result** — either a
bare object (`linear.authStatus`, `linear.viewer`, `linear.getIssue`) or a bare array
(`linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`,
`linear.listLabels`) — with **no envelope and no cursor** (those catalogs are small and
bounded). Absent (`None`) optional fields are **omitted** from the JSON. Errors reuse the §9
conventions: missing/invalid params → `-32602` (e.g. `linear.getIssue` requires `id` **or**
`identifier`, otherwise `Missing required parameter: id`); a key that is **absent or fails the
`viewer` probe** ("not configured"), and any other Linear/service failure → `-32603` with a
descriptive `message` (e.g. `"Linear is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| linear.authStatus | — | { authenticated, login?, scopes } — `authenticated` = env key resolves **and** the GraphQL `viewer { id name email }` probe succeeds; `login` is the viewer's name/email; `scopes` is always `[]` (Linear's `viewer` returns no key scopes). Never includes the key. |

#### Issues

`filter` maps to a typed Linear GraphQL filter **server-side**.
`linear.listIssues` backs the FE's `fetchMyIssues`; `linear.searchIssues`
backs the FE's `searchIssues`. Both return the paginated `{ issues, nextToken }` envelope
(see Conventions above): pass the returned `nextToken` back as a param to fetch the next page.
`linear.getIssue` resolves a single flattened `LinearIssueResult` by UUID `id` **or** `ENG-123`-style
`identifier` (the engine picks the lookup mode by string shape); it is not consumed by the FE today
but completes the read surface.

| Method | Params | Result |
| --- | --- | --- |
| linear.listIssues | filter?: "assigned"\|"created"\|"subscribed"\|"team"\|"all" (default "assigned"), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — the authenticated viewer's issues for the typed `filter`; `nextToken` is an opaque base64 string when another page exists, else `null` |
| linear.searchIssues | query (req), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — full-text issue search, same cursor semantics |
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
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":55,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamName":"Engineering","teamKey":"ENG","priority":2,"assignee":"Ada Lovelace",
    "labels":["bug"],"url":"https://linear.app/acme/issue/ENG-123" } ],
  "nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":56,"method":"linear.searchIssues","params":{ "query":"widget","limit":20,"nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":56,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","teamKey":"ENG",
    "url":"https://linear.app/acme/issue/ENG-123" } ], "nextToken":null } }
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

### 5.29 `sentry.*` namespace

> The full `sentry.*` surface — the reads
> `sentry.authStatus`, `sentry.listIssues`, `sentry.searchIssues`,
> `sentry.listProjects`, `sentry.getIssue`; and the writes `sentry.resolveIssue`,
> `sentry.ignoreIssue`, `sentry.assignIssue` — is served **daemon-owned** against Sentry's REST
> API (`GET https://sentry.io/api/0/organizations/{org}/issues/`) via the `intent-sentry`
> crate (wire arm: `intent-services` `sentry_ops` → `intent-transport` router). The `status`
> filter maps to a **typed `is:<status>` clause** server-side, and `query` is forwarded
> verbatim as the Sentry search string. The field names and shapes here are the source of
> truth for both sides.

> **Auth model — token + org from the environment (no OAuth/device flow, no
> `connect`/`revoke`).** A local daemon has no hosted OAuth callback, so v1 authenticates with
> a **Sentry user/internal-integration auth token + organization slug resolved from the
> environment**: `SENTRY_API_TOKEN` (with an optional lower-priority secret-store account
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
returned). The two issue reads — `sentry.listIssues` and `sentry.searchIssues` — are
**cursor-paginated** per the §5.5 conventions (parity with `linear.listIssues` /
`linear.searchIssues`, §5.28): they accept an optional **opaque base64** `nextToken` (the
token echoed by a previous page; a malformed token degrades to the first page, matching the
`github.*` reads) and return a `{ issues: SentryIssueResult[], nextToken: string|null }`
envelope where `nextToken` is an opaque base64 string when another page exists and an
explicit `null` on the last page. The underlying Sentry `Link`-header page cursor is a
server-side detail clients MUST treat as opaque. Every other Sentry arm returns a **bare
result** — either a bare object (`sentry.authStatus`, `sentry.getIssue`, the P2 writes) or a
bare array (`sentry.listProjects`) — with **no envelope and no cursor**. Absent (`None`)
optional fields are **omitted** from the JSON.
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

`status` maps to a typed `is:<status>` clause **server-side**;
`query` is forwarded verbatim as the Sentry search string.
`sentry.listIssues` backs the FE's `fetchIssues`; `sentry.searchIssues` backs the FE's
`searchIssues`. Both return the paginated `{ issues, nextToken }` envelope (see Conventions
above): pass the returned `nextToken` back as a param to fetch the next page.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listIssues | project?, status?: "unresolved"\|"resolved"\|"ignored"\|"all" (default "unresolved"; any other value → `-32602`), query?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — issues matching the typed `is:<status>` clause (combined with optional `project` slug and free-text `query`); `nextToken` is an opaque base64 string when another page exists, else `null` |
| sentry.searchIssues | query (req — missing → `-32602`), project?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — full-text issue search, same cursor semantics |
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
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":71,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "type":"TypeError","filename":"src/app.ts",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ],
  "nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":72,"method":"sentry.searchIssues","params":{ "query":"TypeError","limit":20,"nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":72,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ], "nextToken":null } }
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

### 5.30 `models.list` — model catalog

The BE-owned model catalog every FE model picker reads (ModelPicker, background-agent settings,
workspace initializers, onboarding). It is the **richer, additive sibling** of `agent.getModels`
(§5.5), which keeps its lean `{ id, name, provider, description? }` rows unchanged.

| Method | Params | Result |
| --- | --- | --- |
| models.list | providerId?, forceRefresh?: boolean (default false) — no `workspaceId` | without `providerId`: { models: ModelInfo[], source: "auggie" \| "static", stale?, warning? }; with `providerId`: { providerId, models: ModelInfo[], source, stale?, warning? } |

**ModelInfo** — `{ id, name, provider, description?, modelGroupPriority?: number, costTier?: number, badges?: [{ color, label, variant? }], effortLevels?: string[], isDefault?: boolean, priority?: number }`.
`id` is the bare model id (`shortName`/`value`), `name` the display label
(`displayName`/`label`); the optional fields carry the picker metadata clients
consume (group/within-group ordering, cost tier `1..3`, badges, effort levels,
default flag). Optional fields are omitted when the provider does not report them.

**Per-provider catalog.**

```jsonc
// → request
{
  "providerId": "auggie",  // optional — per-provider catalog via the generic cache
  "forceRefresh": false    // optional, default false — skip the cache read, await a fresh probe
}
// ← response (with providerId)
{
  "providerId": "auggie",
  "models": [ /* ModelInfo rows */ ],
  "source": "auggie",          // the provider id, or "static" on fallback
  "stale": true,               // optional — present only when serving last-good after a failed probe
  "warning": "..."             // optional — human-readable reason for fallback/stale/empty data
}
```

**Semantics:**

- **One generic per-provider cache.** All `models.list` requests — with or without `providerId` — go through a shared cache keyed on `(providerId, versionKey)` with a **5-minute TTL**, persisted in the daemon data dir (`models-cache.json`) so it survives restarts. The version key is registry-defined per provider (e.g. the full pinned npx package spec for claude-code); a pin bump (or package rename) invalidates cached entries automatically. The no-`providerId` legacy path resolves the same registered auggie source as `providerId: "auggie"` — same key, same cache — so the two can never diverge.
- `forceRefresh: true` skips the cache read, awaits a fresh probe, and stores the result on success. On failure it returns the **last-good** list labeled `stale: true` plus a `warning` — stale data is never served silently.
- **Non-forced reads** within the TTL serve the cache; expired reads await a fresh probe (no stale-while-revalidate) with the same last-good + `warning` fallback on failure.
- **Probe guards.** Concurrent probes for the same provider are single-flighted (one spawn, shared result), and a failed probe is negatively cached for **60 seconds**: non-forced reads within the window serve the failed probe's degradation (static/stale) without re-probing; `forceRefresh` bypasses the negative entry.
- **Registered sources:** nine providers are registered — `auggie` (CLI discovery, below); `cortex` (feature-code-gated; when gated it returns an empty list + `warning` under `source: "cortex"`); `claude-code`, `codex`, `pi`, and `droid` (live ACP adapter probes); `opencode` and `grok` (native CLI discovery — each binary is resolved from its native installer location first, `~/.opencode/bin/opencode` and `~/.grok/bin/grok` respectively, **ahead of** the `PATH` scan, so a daemon spawned with a minimal `PATH` — e.g. from a packaged app — still finds a natively installed CLI; `~` denotes the daemon's resolved home directory (`$HOME`, or `%USERPROFILE%` on Windows), not shell expansion; on Windows only runnable `.exe`/`.cmd`/`.bat` entry points are probed — never the bare extensionless name); and `unsloth` (HTTP fetch, below — no CLI/adapter probe). Version keys are per-provider (e.g. the claude-code/codex/pi adapter version pins); the registry is designed for further providers to be added.
- **The `unsloth` source** fetches the Hugging Face `unsloth` org's GGUF repos (`https://huggingface.co/api/models?author=unsloth&filter=gguf&limit=1000`, 10s timeout) and builds **one row per repo, never per quant**: `id` is the full HF repo id (e.g. `unsloth/gemma-3-27b-it-GGUF` — the compound model id is `unsloth:<repo-id>`), `name` is the bare repo name with the trailing `-GGUF` stripped, and `description` reports the HF download count (the ranking signal); rows are sorted by downloads, ties broken by `trendingScore`. **Memory-fit filtering:** the total parameter count is parsed from the repo name (dense `27B`; MoE `35B-A3B` uses the total `35B`), the footprint is estimated at ~0.6 bytes/param (Q4-class) + 1 GiB headroom, and repos estimated to exceed **~70% of total system RAM** — or whose size cannot be parsed — are dropped, with the existing `warning` field reporting the count (`unsloth: <n> repo(s) hidden (estimated to exceed available memory, or size unknown)`); when RAM detection is unavailable the filter is skipped entirely — every repo is served, including size-unknown ones, and no hidden-count `warning` is emitted. When the filter hides **every** repo (or the response parses to zero repos), the source degrades to the "no models reported" unavailable path — matching the opencode/grok convention — rather than serving an empty success, so an empty catalog is never cached as valid. No new wire fields — the result reuses the standard `{ models, source, stale?, warning? }` shape and cache semantics.
- **Unknown/unregistered **`providerId` degrades to that provider's static tier rows (empty when it has none) with `source: "static"` and a `warning` — never an error, so model pickers keep working.
- **Legacy path.** Without `providerId`, the response omits the `providerId` field (legacy shape) but follows the same cache semantics as `providerId: "auggie"`: within the TTL the cache is served; on a failed probe the last-good list is served labeled `stale: true` + `warning` (forced or not), falling back to the static catalog (`{ models, source: "static" }`, exactly those keys) only when no last-good list exists. Because the cache is persisted, last-good entries survive daemon restarts on this path too.

**Auggie discovery** (the registered `auggie` source):

1. `auggie model list --json` — rich metadata (`id` ← `shortName`, `name` ← `displayName`).
2. Plain `auggie model list` text fallback (`- Label [model-id]` rows + optional indented
   description) when the JSON form fails or parses empty.
3. Rows flagged `isLegacyModel` are **filtered out server-side**; the survivors are sorted by
   `modelGroupPriority`, then `priority`, then `name` (missing priorities sort last). A
   successful CLI result is cached per the generic 5-minute cache above.
4. When the auggie CLI is unavailable or yields nothing parseable (and no last-good entry
   exists), the static `PROVIDER_MODEL_TIERS` catalog is returned with `source: "static"`
   (same fallback as `agent.getModels`), so the result is never empty — clients can key honest
   "live vs fallback" UI off `source`.

Errors: `-32603` only on internal failure; probe/CLI failures degrade as described above.

```json
// → request (legacy path, no providerId)
{ "jsonrpc":"2.0","id":82,"method":"models.list" }
// ← response
{ "jsonrpc":"2.0","id":82,"result":{ "source":"auggie","models":[
  { "id":"sonnet4.5","name":"Sonnet 4.5","provider":"auggie",
    "description":"Balanced general model","modelGroupPriority":1,"costTier":2,
    "badges":[{ "color":"green","label":"Auto" }],"effortLevels":["low","medium","high"],
    "isDefault":true,"priority":1 } ] } }
```

### 5.31 `agent.enhancePrompt` — one-shot prompt enhancement

Daemon-owned prompt enhance / AI-layout generation (the daemon spawns `auggie --print`; no
client-side CLI involvement). One-shot request/response: no streaming, no
agent session created or persisted, no events emitted. Part of the `agent.*`
namespace (§5.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.enhancePrompt | prompt (req), mode?: "enhance" \| "layout", model?, workspaceId?, timeoutMs? | { enhanced, original, mode } |

**Params.**

- `prompt` (required, non-empty) — in `mode: "enhance"` the raw user input to improve; in
  `mode: "layout"` the full layout-generation instruction sent verbatim.
- `mode` — `"enhance"` (default) wraps `prompt` in the enhancement template (the FE
  `getInputWithEnhancePrompt` port) and **extracts** the
  `<augment-enhanced-prompt>…</augment-enhanced-prompt>` payload from the model reply;
  `"layout"` skips the template and returns the full cleaned reply (covers the FE
  `agent:generate-layout` use). Any other value is `-32602`.
- `model` — optional auggie model id, passed as `--model`; omitted → CLI default.
- `workspaceId` — optional; when present the CLI runs with the workspace's worktree as its
  working directory (unknown workspace → `-32602`). Without it the CLI runs without a `cwd`
  (mirrors the FE, which drops `cwd` when no workspace is bound).
- `timeoutMs` — optional positive integer, default `30000` (the FE's 30-second enhancement
  timeout), capped at `120000`.

**Execution** — same one-shot CLI discipline as `workspace.generateSetupScript` (§5.25) and
`models.list` (§5.30): auggie discovery (Intent-managed binary → enhanced PATH), then
`auggie --print --mcp-config {"mcpServers":{}}` (MCP skipped for latency — enhancement needs no
tools) with the composed prompt piped over stdin (`System: <mode system prompt>\n\n<message>`,
mirroring the FE `streamChat` composition). Stdout is ANSI-stripped and cleaned (🤖-delimited
response extraction plus tool-artifact line filtering, the FE `cleanAgentMessage` port) before
the mode-specific parse.

**Errors** (§9):

- `-32602` — missing/empty `prompt`; `mode` not `"enhance"`/`"layout"`; non-positive
  `timeoutMs`; unknown `workspaceId`.
- `-32603` — auggie CLI not found / spawn failure; timeout (`data` carries
  `"…timed out after <n>ms"`); non-zero CLI exit; in `mode: "enhance"`, a reply missing the
  `<augment-enhanced-prompt>` tags (`data`: `"Failed to parse enhanced prompt from response"`).
  CLI absence is a **hard error** here (unlike §5.30) — there is no meaningful static fallback
  for enhancement.

```json
// → request
{ "jsonrpc":"2.0","id":83,"method":"agent.enhancePrompt",
  "params":{ "prompt":"make login better","model":"haiku4.5","workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":83,"result":{
  "enhanced":"Improve the login flow: add client-side validation …",
  "original":"make login better","mode":"enhance" } }
```


### 5.32 `agent.completeOnce` — one-shot prompt→completion

A stateless one-shot completion RPC (used for background requests such as slug
generation and note-status checks). The daemon owns the full
lifecycle: spawn the auggie CLI, collect its cleaned reply, reap the process on any
failure path (timeout, cancel, drop). **No agent session or in-memory state is
created**, so no client-side create→send→read→delete orchestration is needed and
there is nothing to garbage-collect on the error path. Part of the
`agent.*` namespace (§5.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.completeOnce | prompt (req), systemPrompt?, model?, workspaceId?, timeoutMs? | { text } |

**Params.**

- `prompt` (required, non-empty) — the user prompt piped verbatim to the CLI over
  stdin (composed with `systemPrompt` when supplied).
- `systemPrompt` — optional system prompt; when present the composed input becomes
  `"System: <systemPrompt>\n\n<prompt>"`, mirroring the FE `streamChat` composition
  used by §5.31. Absent/blank → `prompt` rides through unchanged.
- `model` — optional auggie model id, passed as `--model`; omitted → CLI default.
- `workspaceId` — optional; when present the CLI runs with the workspace's worktree
  as its working directory (unknown workspace → `-32602`). Without it the CLI runs
  without a `cwd`.
- `timeoutMs` — optional positive integer, default `30000` (matches §5.31 default),
  capped at `120000`. A hung CLI is reaped when the timeout elapses.

**Execution** — same one-shot CLI discipline as `agent.enhancePrompt` (§5.31): auggie
binary resolution (`Services.auggie_bin` test seam → `context.auggiePath` setting when
set and non-empty (exclusive; an invalid path is an error, no silent discovery fallback)
→ `find_auggie()` discovery via Intent-managed binary → enhanced PATH), then
`auggie --print --mcp-config {"mcpServers":{}}` (MCP skipped — completion needs no
tools) with the composed prompt piped over stdin. Stdout is ANSI-stripped and cleaned
(🤖-delimited response extraction plus tool-artifact line filtering, the FE
`cleanAgentMessage` port) before being returned verbatim as `text`. No streaming, no
events, no persistence. The binary resolution order honors the existing
`context.auggiePath` settings key so explicit user config is never ignored and hermetic
e2e tests (with `auggiePath` set to a fake fixture) never fall back to PATH-based
discovery.

**Errors** (§9):

- `-32602` — missing/empty `prompt`; non-positive `timeoutMs`; unknown `workspaceId`.
- `-32603` — auggie CLI not found / spawn failure; timeout (`data` carries
  `"…timed out after <n>ms"`); non-zero CLI exit. CLI absence is a **hard error** —
  there is no static fallback for completion.

```json
// → request
{ "jsonrpc":"2.0","id":84,"method":"agent.completeOnce",
  "params":{ "prompt":"one-line slug for: fix the login flow" } }
// ← response
{ "jsonrpc":"2.0","id":84,"result":{ "text":"fix-login-flow" } }
```

### 5.33 `repoConfig.*` — per-repository configuration

Four JSON-RPC methods for managing per-repository configuration (`.intent/config.json`) at the
repository root. Each workspace lives in a git worktree; these methods resolve the **repository**
root (via `worktreePath` → `repositoryPath` → `git_ops::worktree_path`) and read/write/check the
shared `.intent/config.json` that sits at that root. The config carries project-wide settings
(branch naming prefix, default setup script, agent instructions, repo scripts) that apply to all
workspaces cloned from the same repo.

All methods require `workspaceId` and map `Error::NotFound` to `-32602 "Workspace not found"`.

| Method | Params | Result |
| --- | --- | --- |
| repoConfig.get | workspaceId (req) | { config: RepoConfig } — reads the config from the repo root; returns default empty config if the file is absent or contains invalid JSON |
| repoConfig.save | workspaceId (req), config (req): RepoConfig | { config: RepoConfig } — writes the config, ensures `.intent/.gitignore`, and returns the persisted record |
| repoConfig.has | workspaceId (req) | { exists: boolean } — checks whether `.intent/config.json` exists at the repo root |
| repoConfig.ensureDir | workspaceId (req) | { ok: true } — creates the `.intent/` directory at the repo root if missing |

**RepoConfig** — all fields are optional; absent fields have no effect on the workspace (fallback to workspace-level or global settings):

- `branchPrefix?: string` — string prefix (e.g. `"feat/"`, `"aw/"`) prepended to auto-generated branch names in `workspace.create` (§5.1)
- `setupScript?: string` — default setup script used when `workspace.create` omits `setupScript`
- `instructions?: string` — repo-level instructions injected into agent prompts
- `runScript?: string` — optional run script (reserved, no consumer in v1)
- `archiveScript?: string` — optional archive script (reserved, no consumer in v1)
- `scripts?: Array<{ id, name, command, mode, cwd?, env?, category?, autoStart? }>` — repo script definitions used to bootstrap workspace scripts when none exist

The `defaultAutoCommit` field mentioned in early drafts was **not implemented** in the initial port.

```json
// → request — read the config
{ "jsonrpc":"2.0","id":90,"method":"repoConfig.get","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":90,"result":{ "config":{ "branchPrefix":"feature/","setupScript":"npm install","instructions":"Use TypeScript strict mode" } } }

// → request — write/update the config
{ "jsonrpc":"2.0","id":91,"method":"repoConfig.save",
  "params":{ "workspaceId":"ws-abc","config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }
// ← response
{ "jsonrpc":"2.0","id":91,"result":{ "config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }

// → request — check existence
{ "jsonrpc":"2.0","id":92,"method":"repoConfig.has","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":92,"result":{ "exists":true } }

// → request — ensure the .intent directory exists
{ "jsonrpc":"2.0","id":93,"method":"repoConfig.ensureDir","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":93,"result":{ "ok":true } }
```

### 5.34 Skills — `skill.list`

The backend exposes daemon-side skills discovery so clients can list skills for a workspace. The daemon scans the 5-tier precedence (user p1-3: `~/.agents/skills`, `~/.claude/skills`, `~/.augment/skills`; project p4-5: `<workspace>/.agents/skills`, `<workspace>/.augment/skills`) and parses `SKILL.md` frontmatter (name, description, allowedTools, compatibility). Name collisions shadow by precedence with warn logs. The discovered skill set is cached (with mtime-based fingerprints for cache invalidation) and monitored via filesystem watchers on all five scan roots; the daemon emits `skills:changed` events when SKILL.md files are created, modified, or deleted.

| Method | Params | Result |
| --- | --- | --- |
| skill.list | workspaceId (req) | bare array of `{ name, description, location, scope, allowedTools?, compatibility? }` (name-sorted, scope: "project"\|"user") — -32602 if the workspace is not found or has no worktree path |

- `name` / `description` are the parsed SKILL.md frontmatter fields; `location` is the absolute path to the SKILL.md file; `scope` is `"project"` for workspace-tier skills (p4-5) and `"user"` for user-tier skills (p1-3); `allowedTools` / `compatibility` are optional frontmatter fields.
- Skills are returned in **name-sorted** order for deterministic output. When a name collision occurs, the higher-precedence tier wins and a warn log is emitted.
- The daemon watches all five scan roots recursively (using `notify` watchers, the same infrastructure as workspace `file:changed` events); when a SKILL.md file is created/modified/deleted under a watched root, the daemon re-runs discovery for the affected workspace(s) (user-tier changes affect all workspaces; project-tier changes are workspace-scoped), compares the newly-discovered set against the cached skill set, and emits `skills:changed` (§6.5) only if the set actually changed (500ms debounce per workspace). Non-existent roots are handled gracefully by watching the nearest existing ancestor. The `skill.list` handler also performs a check-on-read as a fallback safety net.

```json
// → request
{ "jsonrpc":"2.0","id":64,"method":"skill.list","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":64,"result":[
  { "name":"python-expert","description":"Python development specialist","location":"/Users/user/.augment/skills/python-expert/SKILL.md","scope":"user" },
  { "name":"typescript-expert","description":"TypeScript specialist","location":"/workspace/.augment/skills/typescript-expert/SKILL.md","scope":"project","allowedTools":"*","compatibility":"typescript" } ] }
```

### 5.35 Interrupted-agent resumption — `agent.listInterrupted` / `agent.resolveInterrupted`

These methods manage agent resumption across daemon restarts. When `intentd` restarts, in-flight agent sessions (`active`, `processing`, `waiting` statuses) are captured as **interrupted records** before the heal sweep rewrites them to `idle`. This capture occurs on both graceful shutdown (`SIGINT`/`SIGTERM`) and crash scenarios, ensuring that agents mid-turn are always resumable. Clients discover interrupted agents via `agent.listInterrupted` and resolve them via `agent.resolveInterrupted` (resume or abandon). For headless deployments, `intentd serve --resume-all` auto-resumes all interrupted agents at startup.

#### `agent.listInterrupted`

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "agents": [
    {
      "agentId": "agent-abc123",
      "workspaceId": "ws-xyz",
      "workspaceName": "Feature: Dark mode",
      "agentName": "Implementor",
      "prevStatus": "active",
      "interruptedAt": "2026-07-16T10:15:30.123Z"
    }
  ]
}
```

Returns pending interrupted agents across all workspaces. Each `InterruptedAgent` includes:

- `agentId`, `workspaceId` — session and workspace IDs
- `workspaceName`, `agentName` — joined from workspace/agent-session tables (may be empty if session deleted after interruption)
- `prevStatus` — the agent's status before interruption (`active`, `processing`, or `waiting`)
- `interruptedAt` — ISO 8601 timestamp when the agent was interrupted

Rows with `resolution='pending'` survive multiple restarts (idempotent capture). Resolved rows (`resumed` / `abandoned`) are excluded.

#### `agent.resolveInterrupted`

**Request:**

```json
{
  "resume": ["agent-abc123"],
  "abandon": ["agent-def456"]
}
```

**Validation rules:**

- `resume` and `abandon` are **optional** parameters.
- When present, each must be an **array of strings** (non-array → `-32602 "resume/abandon must be an array"`; non-string element → `-32602 "resume[i]/abandon[i] must be a string"`).
- `null` is treated as non-array and rejected with `-32602`.
- At least one of `resume` or `abandon` **does not** need to be present; both can be absent or empty arrays (no-op).

**Response:**

```json
{
  "resumed": ["agent-abc123"],
  "abandoned": ["agent-def456"],
  "failed": []
}
```

Resolves interrupted agents:

- **Resume:** Atomically marks row `resolved='resumed'` (claim-first), re-registers parent completion watches (if delegated), delivers a continuation message (`"You were interrupted because the harness shut down. You now have a chance to continue the work — review your last steps and pick up where you left off."`) via `agent.sendMessage`. Delivery lazily respawns the ACP provider and resumes via `session/load` (with `session/new` recreate fallback). If any post-claim step fails, the row is reset to `pending` (resolution=NULL) to restore retryability, and the error is returned.
- **Abandon:** Marks row `resolved='abandoned'`, appends a system-role interruption message (text block with `meta.kind="interruption"`: `"This conversation was interrupted because intentd restarted. The agent's in-flight work was terminated."`), emits `agent:message` + `agent:updated` events.

**Errors:**

- An agent ID appearing in both `resume` and `abandon` → `-32602 "Agent id X appears in both resume and abandon"`
- Unknown or already-resolved IDs land in the `failed` array: `{ agentId, error }` (error string describes the failure reason)

Per-agent failures are isolated; other agents in the same call proceed normally.

#### Queued-message preservation

**Queues survive restarts.** The per-agent send queue (`agent.queueMessage` / `agent.getQueue`, §5.5) is persisted write-through to the `agent_queue` SQLite table: every enqueue, edit, remove, and drain mutation of the in-memory queue is mirrored to the store, so both graceful shutdowns and crashes preserve queued messages. At daemon startup, persisted queues are rehydrated into memory before RPCs are served. Rehydration alone never starts a turn; entries mid-edit at shutdown are restored as ready-to-send (`editing: false`), and attachment blocks plus metadata round-trip intact.

**Resume ordering contract:** When an interrupted agent is resumed — via `agent.resolveInterrupted { resume }` or `serve --resume-all` — the continuation message streams **first**; the preserved queue then drains FIFO in original order after that turn completes. Abandoning an interrupted agent leaves its preserved queue intact and inert (no auto-send); entries remain visible via `agent.getQueue` and removable via `agent.removeQueuedMessage`.

**Stale-redrive detection (new in intentd, #576):** every queue drain path checks, BEFORE the transcript append, whether the dequeued message is stale for a delegated agent — the entry's `queuedAt` (the same wire field served by `agent.getQueue`) predates the `completionReportTimestamp` on the child's session, i.e. the message was enqueued before the currently-persisted completion report existed, so the parent has already been woken with that report. Stale entries are redriven with a deterministic `[SYSTEM NOTE]` annotation appended to the content (idempotent across requeues) and their turn suppresses the turn-begin completion-report clear (see `agent.reportToParent`, §5.5). For a requeued entry whose user row was already persisted before a failed turn, the annotation is skipped (the transcript row is never mutated) while the report clear is still suppressed. Session-lookup or timestamp-parse failures fail open: the entry is treated as fresh and drains with today's behavior.

No RPC surface changes: `agent.getQueue`, `agent:queue:updated`, and the edit/remove/drain flows operate on the in-memory map, which is now durable.

#### Delegation-group persistence

`after_all`** groups survive restarts.** When a parent delegates children with `waitMode: "after_all"`, the delegation group is persisted in the `delegation_group` SQLite table. At daemon startup, the heal sweep rehydrates all sealed groups and re-registers the aggregated-wake delivery watch. Resumed grouped children automatically re-enroll in their persisted group; when all children complete, the daemon delivers exactly one aggregated wake to the parent containing all children's reports.

**Durable-before-observable:** Child completions are recorded durably in `delegation_group` **before** the `agent:idle` event publishes. A daemon kill between completion and event delivery cannot lose completion state — the resumed child's completion is already persisted when the daemon restarts.

**Group-wake format:** The aggregated wake is a single agent turn delivered to the parent, containing a `[WORKSPACE EVENTS]` summary block listing all children's completion reports. Each child's report line: `**{child_name}** (agent-{id}) completed. Report: {completion_report_text}`. After delivery, the group row is pruned.

#### Completion-watch persistence

**One-shot completion watches survive restarts.** Parent→child completion watches (registered by any watch-registration path — `agent.delegate` auto-watch, `agent.wakeOrCreate`, `ws.agent.create` auto-subscribe, the sender auto-subscribe, and the chief-only MCP `ws.app.agents.waitFor` binding) are persisted in the `completion_watch` SQLite table via a best-effort spawned async write (NOT durable-before-observable; `ws.app.agents.waitFor` alone awaits the write — still best-effort on failure — because its registration-time reconciliation may fire the watch immediately), and deleted when the watch fires, is cancelled, or expires. At daemon startup, surviving rows are rehydrated into the in-memory registry: rows whose parent agent is gone (or whose delegation group already settled, or whose leak-guard deadline elapsed) are pruned; each remaining watch's child is then reconciled against current agent state, so a child that completed / failed / was deleted while the daemon was down delivers a synthetic completion wake immediately instead of leaving the parent waiting forever. `ws.app.agents.waitFor` runs the same reconciliation at registration time, so waiting on an already-settled target wakes the caller right away. No RPC surface changes: the watches remain visible via `agent.getSubscriptions` and removable via `agent.cancelSubscriptions`; the subscription registry itself is daemon-level, so chief-workspace (`__chief__`) parents can hold watches on children in any workspace (non-chief parents remain scoped to their own workspace). **Watch registration fails closed on a nonexistent child.** The watch-registration op behind the `ws.agent.create` auto-subscribe (`agent.watchCompletion`) rejects a nonexistent child agent with `-32602` naming the id BEFORE any watch is registered — it no longer falls back to the call's workspace and registers a watch that can never fire (a phantom `waitingForAgentIds` entry on the parent); this mirrors the sender auto-subscribe guard on `agent.sendMessage` (§5.5). The existing deleted-parent guard (`ok: false`, no watch) is unchanged, and the child guard takes precedence when both the parent is deleted and the child is nonexistent.

#### `serve --resume-all` CLI flag

`intentd serve --resume-all` is a headless deployment flag that automatically resumes all interrupted agents at startup without waiting for the `agent.resolveInterrupted` RPC.

**Execution:** After the daemon is fully up (services wired, event bus live, RPC servers listening), a background task enumerates the interrupted set and calls the resume service operation for each pending agent. Per-agent failures are logged (warning-level) and do not crash the daemon or block startup.

**Non-blocking:** The auto-resume sweep is spawned asynchronously; the daemon is ready to serve RPCs before the sweep completes. After the sweep completes, `agent.listInterrupted` returns an empty list.

### 5.36 Agentic usage stats — `stats.getUsage`

The backend owns global **agentic usage stats** (the usage-stats cards). Recording is
daemon-internal: usage aggregates **across all workspaces** into hourly UTC buckets, one row per
UTC hour + normalized model name + resolved agent-provider id. At the end of each prompt turn
the daemon folds in the turn's
**token delta** (the difference between consecutive cumulative end-of-turn snapshots, clamped ≥ 0
per counter — never the raw cumulative report), a `runs` increment (**runs** = completed prompt
turns) and the turn's wall-clock duration MAX'd into the bucket's longest-run counter; agent
**session starts** and agent-attributed **lines added/deleted** (manual/user edits are excluded)
accrue into the same buckets as they happen. Model ids are normalized to one canonical display
name so the same model reached via different hosts lands in one row (`claude-opus-4-8`,
`anthropic/claude-opus-4.8-20260115`, and `Opus 4.8` all → `"Opus 4.8"`; unrecognized ids pass
through, blank → `"unknown"`). This store is independent of the change metrics (§5.20) and token
usage (§5.23) surfaces — clearing those never touches usage stats. Only the **read** crosses the
wire — recording has no RPC (§6.8). `stats.getUsage` is global: it takes **no** `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| stats.getUsage | period (req): "24h" \| "month" \| "year"; key: "YYYY-MM" (req for month) \| "YYYY" (req for year), ignored for 24h; tzOffsetMinutes: integer, minutes east of UTC, default 0, must be within ±840 | UsageStats — -32602 on a bad period/key/tzOffsetMinutes |

**Timezone semantics** — buckets are stored as UTC hour floors alongside a **local wall-clock
stamp** (`local_date` `"YYYY-MM-DD"` / `local_hour` 0–23) captured from the daemon's system
timezone when the bucket row is first inserted (later writes folding into the same bucket keep
the first-writer's stamp). For `month`/`year` periods, period filtering, hour-of-day / month
grouping, and `availablePeriods` follow that recorded stamp, so "1pm" means 1pm on the daemon's
machine **at the moment the activity was recorded** — immune to later DST transitions or
timezone moves. Rows whose stamp columns are NULL (written while the daemon's local offset was
indeterminate; pre-migration rows are backfilled from `bucket_utc` using the timezone in effect
at migration time) or malformed fall back to shifting `bucket_utc` by `tzOffsetMinutes`. The
`24h` period is an **absolute rolling window** — the trailing 24 hourly UTC buckets ending at
the current hour — unaffected by `tzOffsetMinutes` except that per-bucket hour labels are
rendered in local time.

**UsageStats** — `{ totals: UsageTotals, runs, sessions, longestRunMs, linesAdded, linesDeleted,
byModel: ByModelEntry[], byProvider: ByProviderEntry[], byHourOfDay: HourEntry[24],
byMonth: MonthEntry[12], availablePeriods: { months: string[], years: string[] } }`, where
**UsageTotals** is the four consumption counters `{ inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens }`:

- **totals / runs / sessions / longestRunMs / linesAdded / linesDeleted** — period rollups:
  the four token counters, completed prompt turns, agent sessions started, the longest single
  turn in milliseconds (MAX), and agent-attributed line churn.
- **byModel** — `{ model, runs } & UsageTotals` per normalized model name, sorted descending by
  total tokens (ties break on model name ascending).
- **byProvider** — `{ provider, runs } & UsageTotals` per resolved agent-provider id, sorted
  descending by total tokens (ties break on provider id ascending). The wire carries **raw
  provider ids** (`claude-code`, `codex`, `auggie`, …) — display-name mapping is a client
  concern. Rows recorded before provider attribution existed (pre-migration) — and any usage
  whose provider could not be resolved — aggregate under the id `"unknown"`; there is no
  backfill.
- **byHourOfDay** — exactly **24** entries of `{ hour } & UsageTotals`. For `month`/`year`:
  local hours of day in order (`hour` = 0–23). For `24h`: the 24 trailing hourly buckets in
  **chronological order** (oldest first), each labelled with its local-time `hour`.
- **byMonth** — exactly **12** entries of `{ month } & UsageTotals` (`month` = 1–12) covering
  the period's whole local year, independent of the (possibly narrower) month filter; zeroed
  for `24h`.
- **availablePeriods** — the distinct local `"YYYY-MM"` months and `"YYYY"` years that have any
  recorded usage, sorted ascending, computed over **all** rows regardless of the requested
  period (drives the FE period picker).

Empty periods return zeroed shapes — zero totals, empty `byModel` / `byProvider`, 24 zeroed
hours, 12 zeroed months — never an error.

```json
// → request
{ "jsonrpc":"2.0","id":94,"method":"stats.getUsage","params":{ "period":"month","key":"2026-07","tzOffsetMinutes":-420 } }
// ← response (arrays elided to the interesting entries)
{ "jsonrpc":"2.0","id":94,"result":{
  "totals":{ "inputTokens":130,"outputTokens":45,"cacheReadTokens":0,"cacheCreationTokens":0 },
  "runs":3,"sessions":1,"longestRunMs":9000,"linesAdded":10,"linesDeleted":3,
  "byModel":[
    { "model":"Opus 4.8","runs":2,"inputTokens":100,"outputTokens":40,"cacheReadTokens":0,"cacheCreationTokens":0 },
    { "model":"Sonnet 5","runs":1,"inputTokens":30,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0 } ],
  "byProvider":[
    { "provider":"claude-code","runs":2,"inputTokens":100,"outputTokens":40,"cacheReadTokens":0,"cacheCreationTokens":0 },
    { "provider":"unknown","runs":1,"inputTokens":30,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0 } ],
  "byHourOfDay":[ { "hour":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0 }, /* … 24 entries … */ ],
  "byMonth":[ { "month":1,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0 }, /* … 12 entries … */ ],
  "availablePeriods":{ "months":["2026-06","2026-07"],"years":["2026"] } } }
```

### 5.37 Managed Unsloth server — `unsloth.status` / `unsloth.stop` *(v2.5)*

The daemon owns a **singleton managed Unsloth server** (the `unsloth` CLI process plus the
`llama-server` child it spawns, which holds the model weights) backing every `unsloth`-provider
agent (model catalog §5.30; startup progress surfaces as the repeated `launch`-phase
`agent:stream:status` events, §6.5). These two router methods expose observability and control
over it. Both are **daemon-global**: they take no params and no `workspaceId` (like
`system.capabilities`), and are available on both UDS and WSS.

| Method | Params | Result |
| --- | --- | --- |
| unsloth.status | — (empty `{}`) | `{ running: boolean, repoId?, port?, pid?, uptimeSecs?, phase?, cpuPercent?, memoryBytes?, attachedAgentCount? }` |
| unsloth.stop | — (empty `{}`) | `{ stopped: boolean }` — `stopped: false` means nothing was running (a **no-op result**, never an error) |

**`unsloth.status`** — a point-in-time snapshot of the managed server. With a server up,
`running: true` and the other fields are present:

- `repoId` — full HF repo id currently served (or being started), e.g.
  `"unsloth/gemma-3-27b-it-GGUF"` (the compound model id is `unsloth:<repoId>`, §5.30).
- `port` — port the managed server listens on (default `8888`); `pid` — OS pid of the server
  child (`null` when unknown).
- `uptimeSecs` — seconds since the server child was spawned.
- `phase` — coarse startup phase: `"starting"`, `"minting"`, `"loading"`, or `"ready"`.
- `cpuPercent` / `memoryBytes` — resource usage sampled at snapshot time and **summed across the
  server's whole process tree** (root plus descendants — the `llama-server` child holds the
  model weights, so the tree total is what matters for capacity planning). `cpuPercent` follows
  the raw `sysinfo` convention (100 = one full core) and is `0.0` when the pid is unknown or the
  sample failed.
- `attachedAgentCount` — the number of currently-tracked agents spawned with the `unsloth`
  provider, counted **regardless of `running`** (a stopped-but-attached state is possible
  mid-restart). When no server is up the result degrades to
  `{ running: false, attachedAgentCount }`; a daemon whose agent manager is not attached
  (composition-root wiring — e.g. a bare test harness, or a daemon that has never spawned any
  agent infrastructure) reports exactly `{ "running": false }`.

Status reads never block behind an in-flight startup: the snapshot is served from a lock-free
identity mirror, so `unsloth.status` stays responsive even during a minutes-long first-use model
download. A dead-and-reaped server child reports as `running: false`, never as a stale identity.

**`unsloth.stop`** — gracefully terminates the managed server and its **whole process tree** if
one is running; an in-flight startup is aborted within about one probe tick rather than leaving
the stop blocked behind the startup window. `stopped: true` means a server (or in-flight
startup) was actually torn down. Stopping is **safe while agents are attached** — the daemon
neither blocks nor warns; a client that wants an "N agents are still using this server"
confirmation should check `unsloth.status`'s `attachedAgentCount` first. A later
`unsloth`-provider spawn simply starts the server again.

```json
// → request
{ "jsonrpc":"2.0","id":97,"method":"unsloth.status","params":{} }
// ← response (server up)
{ "jsonrpc":"2.0","id":97,"result":{
  "running":true,"repoId":"unsloth/gemma-3-27b-it-GGUF","port":8888,"pid":48113,
  "uptimeSecs":312,"phase":"ready","cpuPercent":184.2,"memoryBytes":17179869184,
  "attachedAgentCount":2 } }
// ← response (no server running; agent manager attached)
{ "jsonrpc":"2.0","id":97,"result":{ "running":false,"attachedAgentCount":0 } }

// → request
{ "jsonrpc":"2.0","id":98,"method":"unsloth.stop","params":{} }
// ← response
{ "jsonrpc":"2.0","id":98,"result":{ "stopped":true } }
```

### 5.38 Provider catalog — `providers.catalog` *(v2.6)*

The static provider registry (the `intent-providers` crate's `ACP_PROVIDERS` table) served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. **Daemon-global**: no params and no `workspaceId` (like `system.capabilities`), available on both UDS and WSS. The data is **compiled into the daemon** — there is no cache or TTL; the result only changes when the daemon binary does.

**Request:** `{}` (no parameters)

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "auggie",
      "displayName": "Augment Auggie",
      "shortName": "Auggie",
      "command": "auggie",
      "isDefault": true,
      "canBeDisabled": true,
      "loginCommandHint": "auggie login",           // optional
      "authErrorPatterns": ["authentication required", "auggie login", "please run `auggie login`"],  // optional
      "visible": true,
      "modelTiers": { "fast": "haiku4.5", "balanced": "sonnet4.5", "smart": "opus4.7" }  // optional — static-tier providers only
    },
    {
      "id": "claude-code",
      "displayName": "Anthropic Claude Code",
      "shortName": "Claude Code",
      "command": "claude-agent-acp",
      "isDefault": false,
      "canBeDisabled": true,
      "loginDocsUrl": "https://code.claude.com/docs/en/quickstart#step-2-log-in-to-your-account",  // optional
      "visible": true,
      "modelTiers": { "fast": "haiku", "balanced": "sonnet", "smart": "default" }
    },
    {
      "id": "cortex",
      "displayName": "Snowflake Cortex",
      "shortName": "Cortex",
      "command": "cortex-acp",
      "isDefault": false,
      "canBeDisabled": true,
      "requiresFeatureCode": "cortex",              // optional — raw gating field passed through
      "visible": false,                             // daemon-evaluated: a configured feature code default-denies
      "modelTiers": { "fast": "claude-sonnet-4-5", "balanced": "claude-opus-4-5", "smart": "claude-opus-4-5" }
    },
    // ... one row per registered provider (opencode, unsloth, pi, droid, grok, ...) ...
    {
      "id": "mock",
      "displayName": "Mock (E2E)",
      "shortName": "Mock",
      "command": "node",
      "isDefault": false,
      "canBeDisabled": true,
      "requiresEnvVar": "MOCK_AGENT_SCRIPT_PATH",   // optional — raw gating field passed through
      "visible": false                              // daemon-evaluated: env var absent in the daemon environment
    }
  ],
  "defaultProviderId": "auggie"
}
```

- `providers` carries **all** registered providers — gated-off rows included — one row per registry entry, in **registry order**. The order is informational, not a contract: clients must key rows by `id`, never by array position.
- `command` is the registry's **logical CLI name** (the `ACP_PROVIDERS` `command` field, e.g. `claude-agent-acp` for `claude-code`) — provider metadata, **not** necessarily the binary the daemon spawns. Launch resolution belongs to `host.providerDiscovery` (§5.14), whose `command` reports what the daemon actually resolves and launches — so the two can differ: an npx-only provider like `claude-code` launches via `npx <npxPackage>` and reports `command: "npx"` there. Clients must not assume the values match across the two methods.
- `visible` is the **daemon-evaluated** gating verdict: `requiresEnvVar` is checked for **presence** against the **daemon's** process environment (an empty-string value counts as set), and a configured `requiresFeatureCode` **always** gates the row off (**default-deny** — the daemon stores no feature-code enablement; the same gate `models.list` applies to `cortex`, §5.30). The raw gating fields pass through when set, so clients can either trust the verdict or re-derive it. This is the single env-var/feature-code gate shared with `host.providerDiscovery`'s `gatedOff` (§5.14).
- The optional fields (`loginCommandHint`, `loginDocsUrl`, `authErrorPatterns`, `requiresEnvVar`, `requiresFeatureCode`, `modelTiers`) are **omitted when unset, never null** — clients detect by presence.
- `modelTiers` — the `{ fast, balanced, smart }` tier→model-id map — is present **only** for providers with a static tier table (`auggie`, `claude-code`, `codex`, `cortex`). Dynamic-model providers (`opencode`, `unsloth`, `pi`, `droid`, `grok`, `mock`) omit it; their models come from `models.list` (§5.30).
- `defaultProviderId` mirrors the registry's `isDefault` entry (`auggie`).

## 6. Events & Subscriptions

Live event streaming is the **canonical** way a thin client stays in sync. It uses two server-handled methods (the plural `events.` prefix) plus a server-pushed notification.

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
    "data":{ "noteId":"spec","title":"Spec","action":"update" }
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
| note | note:created, note:updated, note:deleted | data.noteId, data.title, data.action — `{ noteId, title, action }` payload built by `note_change_event` (`intent-services/src/lib.rs`). No `path` field (never emitted). |
| line-attribution (new in intentd) | line-attribution:updated | Emitted after the daemon recomputes per-line attributions for a note (§5.2.1). data = { workspaceId, noteId, attributions } where `attributions` is the FE-parity `Record<lineNumber, { timestamp, author? }>`. Self-sufficient payload (§6.7) so the FE gutter re-renders without a follow-up `note.lineAttribution.load`. **Transient / broadcast-only** (same publish path as `agent:stream:chunk`): never persisted to the event table, so it is invisible to `event.query` / §5.10 historical reads — the durable snapshot lives in `note_line_attribution` and is served by `note.lineAttribution.load` (§5.2.1). |
| task | task:status-changed, task:ready-tasks-changed, task:agent-linked, task:agent-unlinked | status + ready-task-id list. `task:agent-linked` / `task:agent-unlinked` (new in intentd) are emitted by `task.linkAgent` / `task.unlinkAgent` (§5.4); self-sufficient payloads `{ workspaceId, noteId, taskKey, link }` and `{ workspaceId, noteId, taskKey }` so subscribers rebuild the `byNoteId → byTaskKey` map without a follow-up `listAgentLinks`. |
| agent (lifecycle) | agent:started, agent:completed, agent:failed, agent:idle, agent:created, agent:deleted, agent:restored, agent:renamed, agent:updated, agent:status-changed | `agent:updated` (new in intentd, P3-1.2b) is the generic session-mutation invalidation — emitted on `agent.setModel`, the `agent.reportToParent` completion-report persist, the `agent.dismissQuestions` marker persist (v2.8; data `{ agentId, dismissedQuestionsMessageId }`, §5.5 question hold), and the agent-attention-request raise/clear (§5.5: raise → `data { agentId, attentionRequestKind, attentionRequestTimestamp }`; turn-begin clear → `data { agentId, attentionRequestCleared: true }`); the `agent` collection channel maps it to an `updated` delta. `agent:idle` data is enriched with `agentName` (so subscribers don't fall back to a generic "Agent" label), `isBackground` (boolean, sourced from the session's persisted `is_background` flag — the same flag served as `metadata.isBackground` on `agent.list`/`agent.get`, §5.5 — so subscribers such as iOS notification routing can branch on it without a follow-up `agent.get`), and — when the child persisted one via `agent.reportToParent` — the completion report, emitted under both `completionReport` (canonical; readers should prefer it) and `report` (legacy alias, kept for back-compat) with identical values; the enrichment is emitted from both the turn-end idle and the STAB-28 interrupt-path synthetic idle, and a session-read failure is swallowed (the event still fires with the base payload, enrichment fields absent). `agent:idle` data also carries `isWaitingForOtherAgents` (boolean) — computed **at emit time** from the idle agent's pending completion watches (the same derivation as the §5.5 `AgentLite` flag) so notification clients can suppress "agent finished" alerts snapshot-consistently: a follow-up `agent.list`/`agent.get` read can race the awaited child's completion consuming the watch, but the flag frozen into the idle payload cannot. Emitted on both the prompt-turn idle and the harness-wake idle (§6.6); independent of the session read, so it is present even when the other enrichment fields are absent. The immediate `agent.reportToParent` wake's `event_notification` metadata (§5.5) carries the same dual keys on its `events[0].data`. The terminal-failure `agent:status-changed` (emitted when a spawn/turn failure parks the session in `error`) carries `data { agentId, status: "error", isActive: false, stopReason }` plus — when the failure classifies as corrupted/poisoned per monorepo#940 (session-fatal provider block, deterministic `session/prompt` 400 rejection, or the identical-failure streak at threshold) — `sessionCorrupted: true` (**omitted otherwise**, matching the derived flag on the §5.5 `AgentLite`/`AgentSession` projections), so subscribers get the structured "retry will recreate / spawn fresh" signal without parsing `stopReason`. **`agent:failed` carries `turnId?`** ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)): both emit sites — the turn-worker failure arm (`run_prompt_turn`) and the not-surfaced-by-streaming terminal path (`publish_terminal_failure_events`, e.g. spawn-retry exhaustion; its paired terminal `agent:stream:end` carries the same id) — stamp the failed turn's correlation id onto `data { agentId, error, turnId? }`, the SAME `turnId` the send/enqueue RPC returned (preserved across terminal-failure requeues), so clients attribute the failure to the exact turn instead of approximating; omitted when the turn has none (bare test wiring), never `null`. **Prompt idle timeouts suppress `agent:failed`** ([intentd#741](https://github.com/intent-hq/intentd/pull/741), §6.6 warn-and-continue): while the consecutive-timeout cap holds, a timed-out turn emits no `agent:failed` (and no `agent:idle`) at all — its `agent:stream:end` is the normal one and a warning turn is redriven; once the cap is spent, the turn worker's drain loop emits the `agent:failed` half itself (same `{ agentId, error, turnId? }` payload) before the terminal-failure requeue |
| agent (messaging) | agent:message, agent:message:sent, agent:message:received, agent:user-message:sent, agent:tool:call | `agent:message` is the emitted per-persist transcript signal — fired whenever a message row is appended (user send, `agent.appendMessage`, system markers) with `data { agentId, messageId, role, appMessageId?, turnId? }`; discriminate the user-row echo on `role == "user"`. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is the turn correlation id — present on user-row echoes emitted by a turn that carries one (direct sends, queue drains, `agent.sendQueuedMessageNow` deliveries), omitted otherwise (wake deliveries, `agent.appendMessage`, system markers; never `null`). `agent:message:sent`, `agent:message:received`, and `agent:user-message:sent` are registered in the taxonomy but **reserved-but-unused** (no emit sites today). `agent:tool:call` — see §7. |
| agent (subscriptions) | agent:subscribed, agent:unsubscribed, agent:woken-by-subscription, agent:delivery-confirmed, agent:event-delivery-failed/-timeout, agent:subscriptions-restored/-changed, agent:message:delivery-failed | `agent:subscriptions-changed` (emitted by intentd) fires when a parent's completion-watch set changes — a watch is added (`agent.delegate` auto-watch, MCP `create_agent` auto-watch) or removed by wake delivery (one-shot removal, `after_all` group clear after its aggregated wake). data = { agentId, isWaitingForOtherAgents, waitingForAgentIds } — the refreshed waiting-flag snapshot for that parent (same waiting state exposed by `agent.getSubscriptions`, §5.5); self-sufficient (§6.7) so clients converge without polling `agent.getSubscriptions` |
| agent (attention, new in intentd) | agent:attention-requested | Emitted by the agent-attention-request op behind the MCP `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` bindings (§5.5). data = { workspaceId, agentId, agentName, kind, reason } where `kind ∈ { discussion, blocker }` — self-sufficient payload (§6.7) driving the FE sticky toast without a follow-up `agent.get`. Paired with an `agent:updated` raise on the same turn (session `attentionRequest*` fields persisted) and retired by the turn-begin clear (`agent:updated` with `attentionRequestCleared: true`) when the agent next receives a message. A delegated caller's immediate parent wake embeds this event's payload in its `event_notification` metadata (`events[0]`). |
| agent (streaming) | agent:stream:start, agent:stream:chunk, agent:stream:end | see §7 — `agent:stream:start` is emitted **only** for agent-initiated (harness-wake) turns (§6.6) |
| agent (stream status, new in intentd) | agent:stream:status | Turn-startup hint — the pre-first-token status line. Emitted **before the first `agent:stream:chunk`** of every turn on each startup transition the runtime actually has. data = { agentId, workspaceId, phase, message, level, timestamp } where `phase ∈ { launch, init, session-create, session-load, prompt }` (child process about to spawn / ACP initialize handshake / session/new / session/load / session/prompt dispatched) and `timestamp` is epoch-ms. Self-sufficient payload (§6.7); the FE renders the hint next to the chat spinner and clears it on the first `agent:stream:chunk` or terminal `agent:stream:end` / `agent:failed`. The `init` phase's ACP `initialize` request has a **dedicated timeout, default 30s** (overridable via `INTENTD_ACP_INITIALIZE_TIMEOUT_MS`, positive integer ms) so slow provider cold starts under host load don't fail the spawn; all other ACP requests keep the generic 5s default. **`unsloth`-provider spawns emit repeated `launch`-phase events:** before the child spawns, the daemon starts/reuses its managed Unsloth server, and each progress transition (server starting, model preparing, plus a still-loading update every ~15s while a first-use multi-GB download runs) surfaces as an additional `phase: "launch"` / `level: "info"` event — same payload shape, higher cardinality; clients keep only the latest message per agent. A model-switch restart with live `unsloth` agents attached additionally emits one `phase: "launch"` / `level: "warning"` event **before** the restart (intentd#647), warning that those sessions will lose the loaded model. |
| agent (queue) | agent:queue:updated, agent:queue:processing, agent:queue:processing-cancelled, agent:queue:stale-message | `agent:queue:updated` → data { agentId, queue: QueuedMessage[] } — the full post-mutation queue snapshot (§5.5 wire shape, including each entry's `turnId?` and the v2.8 `interruptPriority?` flag), emitted on every enqueue/edit/remove/drain mutation — including question-hold parks (§5.5 question hold). `agent:queue:processing` *(newly emitted — [intentd#699](https://github.com/intent-hq/intentd/pull/699); the constant predates it but previously had no production emit site)* is the **drain-start signal** ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)): emitted by the queue-drain loop (all three drain arms) right after the shrunk `agent:queue:updated` and AFTER the #576 stale-redrive annotation (so `content` matches the persisted user row / provider prompt), with data { agentId, messageId, content, turnId? } (`turnId` omitted only for legacy entries without one; every enqueue path mints one today). It covers redrives whose user row is already persisted and therefore skip the duplicate `agent:message` echo — the FE keys prompt-turn start off `turnId` here. NOT emitted by `agent.sendQueuedMessageNow` (§5.5 — its RPC response carries the `turnId` instead). Audit history (never swept by the retention sweep, unlike the high-churn `agent:queue:updated`). `agent:queue:processing-cancelled` / `agent:queue:stale-message` are **reserved-but-unused** (no emit sites today). |
| workspace | workspace:created, :updated, :deleted, :opened, :closed, :activity, :activity-changed, :attention-changed, :context-changed | :created → data { workspaceId, workspace }; :updated → data { workspaceId, changes } where `changes` is the applied `WorkspaceUpdate` delta — untouched (Option::is_none) fields are omitted, but a field may also carry an explicit JSON `null` to signal a clear (the same omitted = untouched / `null` = clear / present = set tri-state as the §5.1 explicit-null-clear contract). `workspace.archive` / `workspace.unarchive` (§5.1) emit the full applied delta on this same type (no dedicated event): archive → `changes: { archived: true, status: "Archived", archivedAt: <ts> }` (`<ts>` = the persisted ISO timestamp); unarchive → `changes: { archived: false, status: "Active", archivedAt: null }` (explicit JSON `null` so clients clear the field). `updatedAt` is intentionally omitted from the delta by convention; :deleted → data { workspaceId }; :activity-changed → data { workspaceId, activity }; :attention-changed → data { workspaceId, attention }; :context-changed → data { workspaceId, items } (new in intentd — emitted by `workspace.updateContext` §5.1 with the persisted `ContextItem[]`). New in intentd; self-sufficient payloads (§6.7). **`workspace:deleted` ordering:** `workspace.delete` (§5.1) emits **one `agent:deleted` per live session first**, then the terminal `workspace:deleted` **before returning to the caller** (fast-ack) — the event and RPC response both complete before the background filesystem cleanup task finishes. Subscribers see per-session teardown and the workspace-row deletion event synchronously, while the heavy `remove_dir_all` work runs in a background task — the per-repository lock is held only for the git-metadata phase (registration prune + rename to a trash path + guarded branch delete), and the recursive removal runs after the lock is released. |
| spec/goal | spec:updated, goal:updated |  |
| comment | comment:added, comment:resolved | `comment:resolved` is emitted by `comment.resolveThread` (§5.3); self-sufficient payload `{ noteId, threadId, resolved }` lets a client flip the thread's resolved state without a follow-up read. |
| pr (new in intentd) | pr:linked, pr:updated, pr:unlinked | Emitted **only on change** by the background / on-demand PR refresh. Self-sufficient payloads: `pr:linked` → `{ workspaceId, prNumber, prUrl, prStatus, activePullRequest, pullRequests }`, `pr:updated` → `{ workspaceId, prNumber, prStatus, activePullRequest, pullRequests }`, `pr:unlinked` → `{ workspaceId }`. `pullRequests` is the daemon-owned `PullRequestInfo[]` list (every refreshed/discovered/created PR upserted by number, merged/closed PRs retained) so clients can render the full per-branch PR list without a refetch; it is always an array on the wire (`[]` when empty, never `null`). |
| agent (permission, new in intentd) | agent:permission:request, agent:permission:resolved | The interactive permission flow (§8). `agent:permission:request` carries the normalized `PermissionRequestData`; `agent:permission:resolved` carries the chosen outcome (`selected`/`cancelled`). Both are scoped to the agent (`sessionId == agentId`). |
| settings (new in intentd) | settings:changed | Emitted after settings.update (§5.12). data = { changes: [{ path, value }] }; sensitive values are redacted. |
| github (new in intentd) | github:auth-changed | Terminal transitions of the GitHub auth surface (§5.27). data = { status: "authorized"\|"expired"\|"denied"\|"error"\|"revoked" } — device-flow outcomes from the daemon's background poll, plus `revoked` from `github.revoke`. Global (no `workspaceId`, like `settings:changed`); never carries a token or code. |
| skills (new in intentd) | skills:changed | Emitted when the discovered skill set changes for a workspace. The daemon watches the 5 scan roots (user p1-3 + project p4-5) via `notify` watchers; when a SKILL.md file is created/modified/deleted, the daemon re-runs discovery for affected workspace(s) (500ms debounce), compares against the cached set, and emits this event only if the set actually changed. User-tier changes (p1-3) affect all workspaces; project-tier changes (p4-5) are workspace-scoped. data = { workspaceId }. Clients should re-fetch via `skill.list` (§5.34) to refresh the skill roster. |
| specialists (new in intentd) | specialists:changed | Emitted when the resolved specialist set changes for a workspace. The daemon watches the user (`~/.intent/specialists/`) and project (`<workspace>/.intent/specialists/`) tiers via `notify` watchers; when a specialist file is created/modified/deleted, the daemon re-resolves the specialist set for affected workspace(s) (500ms debounce), compares against the cached set, and emits this event only if the resolved set actually changed. User-tier changes affect all open workspaces (a change in `~/.intent/specialists/` emits one event per open workspace); project-tier changes are workspace-scoped. The bundled tier (including its compile-time embedded floor) is static and unwatched. Actor: system. data = { workspaceId }. Clients should re-fetch via `specialist.list` (§5.11) to refresh the specialist roster. |
| mcp | mcp:notification | data.topic, payload. The agent→BE MCP callback — distinct from the `mcp.servers.*` lifecycle surface. |
| mcp.servers (new in intentd) | mcp.servers:status-changed | Health/lifecycle of **external** MCP servers (§5.22). data = { serverId, status: McpServerStatus }. Emitted on every state transition; self-sufficient payload (§6.7). |
| git / terminal / test / build | git:, terminal:command, test:, build:* | Mostly reserved-but-unused. `git:commit` is emitted by `git.commit` / `git.agentCommit` (§5.6) with `data { workspaceId, operation: "commit", commit, message, files }` (the reserved FE `GitOperationEvent` shape); `git:pull` is emitted by `git.pull` (§5.6) on a successful pull with `data { workspaceId, operation: "pull", branch }` (same reserved shape, `commit`/`message`/`files` omitted) and requires a persisted workspace row whose `worktreePath` matches `repoPath` — the workspace-create auto-pull runs before the row exists and stays silent by design. Both successful paths also emit a follow-up `changes:git-status` so subscribers can refresh without a follow-up `git.status`. |
| git.clone (new in intentd) | git:clone:progress, git:clone:done | Streaming `git.clone` (§5.6), correlated by `data.requestId`. `git:clone:progress` → `data { requestId, phase, percent, message }` where `phase ∈ { starting, counting, compressing, receiving, resolving, checkout, complete }` and `percent` is `0..=100`. `git:clone:done` → `data { requestId, ok, error?, errorCode? }`; `error` is present iff `ok == false` and never carries the source URL or credentials; `errorCode` is present only when the failure was classified per the clone failure taxonomy (§9.1) — `path-invalid`, `askpass-missing`, `auth-required`, `repo-not-found`, `access-denied`, `network`, `destination-exists-non-empty` (the `clone-failed` catch-all is never emitted as `errorCode`; unclassified failures omit the key). |
| terminal (new in intentd) | terminal:data, terminal:exit, terminal:title, terminal:cwd | Live PTY streaming (§5.13). data.chunk (terminal:data) is base64. `terminal:data` is **transient / broadcast-only** (same publish path as `agent:stream:chunk`, §7): never persisted, invisible to `event.query` (§5.10); scrollback replay uses `terminal.getBuffer`. `terminal:exit` stays durable and is emitted after the stream task has broadcast every data chunk, so exit never overtakes data. |
| script (new in intentd) | script:output, script:state | Live script streaming (§5.8); shared PTY host. data.chunk (script:output) is base64. `script:output` is **transient / broadcast-only** (never persisted, invisible to `event.query` §5.10); replay uses `script.output`. `script:state` lifecycle transitions stay durable. |
| search (new in intentd) | search:result, search:done | Streaming search results (§5.15), correlated by data.requestId. search:result → data { requestId, matches }; search:done → data { requestId, total, truncated }. |
| drafts (new in intentd) | draft:changed | Emitted after drafts.set / drafts.clear (§5.16). data = { workspaceId, agentId, clientId, hasDraft }; **no draft text** (no leakage). |
| changes (new in intentd) | changes:tracked, changes:git-status, changes:metrics-changed | Code Changes Review (§5.18–§5.20). `changes:tracked` → data { workspaceId, changes: TrackedChange[] } (emitted as the BE records attribution internally — there is no `file-tracking.trackChange` RPC). `changes:git-status` → data { workspaceId, status: WorkspaceGitStatus }. `changes:metrics-changed` → data { workspaceId, agentId?, metrics: Metrics }. Self-sufficient payloads (§6.7). |
| workspace usage (new in intentd) | workspace:tokenUsage-changed | Token/credit usage recomputed — live at ACP turn end, or by the internal reconciliation scan (§5.23). data = { workspaceId, tokenUsage: TokenUsage }. Self-sufficient payload (§6.7). |
| workspace display status (new in intentd) | workspace:displayStatus-changed | Derived `Workspace.displayStatus` rollup transitioned (§5.1). Mutation-driven, never polled: recomputed-and-compared after the mutations that can move the derivation (task status/metadata updates, task-note creation/deletion, PR link/status changes) and emitted **only on an actual transition** — no-op recomputes stay silent. The in-memory baseline is seeded by the `workspace.list` / `workspace.get` emit-path enrichment (or lazily by the first post-mutation recompute); a first observation records without emitting, and a daemon restart re-seeds on first touch. data = { workspaceId, displayStatus }. Self-sufficient payload (§6.7). |
| agent stats (new in intentd) | agent:session-stats-changed | Per-session usage changed (§5.24). data = { sessionId, agentId?, stats: SessionStats }. Self-sufficient payload (§6.7). |
| sandbox (new in intentd) | sandbox:cow:created, sandbox:cow:merged | Emitted when `agent.delegate` resolves the `isolation` mode to `"cow"` on a sandbox-eligible workspace and the background provisioning task succeeds (§5.5 — asynchronous: the delegate result itself only ever reports `effectiveIsolation: "pending"`; this row is about the resolved request mode, not that result field) and when sandbox commits are successfully merged back to the canonical repository (§5.5a — auto-merge on completion or manual `sandbox.cow.merge`). `sandbox:cow:created` → data { workspaceId, agentId, sandboxPath, branch, baseCommitSha, snapshotCommitSha } where `sandboxPath` is the absolute filesystem path to the sandbox clone, `branch` is the sandbox snapshot branch (`sb/<agentId>`), `baseCommitSha` is the sandbox HEAD at provisioning, and `snapshotCommitSha` is the WIP-snapshot commit SHA (`null` when the source was clean). `sandbox:cow:merged` → data { workspaceId, agentId, commitRange, canonicalHead } where `commitRange` names the applied sandbox commit range and `canonicalHead` is the canonical repository HEAD SHA after the merge. Both are self-sufficient payloads (§6.7). |

### 6.6 Turn/event lifecycle & batching window

**Prompt (user-initiated) turns.** A turn opened by a daemon-dispatched `session/prompt`
(`agent.sendMessage`, queue drain, wake delivery) emits **no** `agent:stream:start` — that event
is reserved for agent-initiated (harness-wake) turns below. For a direct send or wake delivery
the client infers turn start from the user-row `agent:message` echo (`role: "user"` — the
per-persist transcript event, §6.5; the `agent:message:sent` / `agent:user-message:sent`
constants are reserved-but-unused) and the first `agent:stream:chunk` — wake deliveries share
only this start-signal inference; they carry no `turnId` (see the turn-correlation paragraph
below). **Queue-drained turns are
the one exception**: the drain loop additionally emits `agent:queue:processing` (§6.5) as an
explicit drain-start signal — see the turn-correlation paragraph below for why the echo alone is
not sufficient there. The turn streams `agent:stream:chunk` / `agent:tool:call` under the
assistant `messageId` minted at turn start, persists the assistant transcript row, emits exactly
one terminal `agent:stream:end`, then `agent:idle` (subject to the existing ready-to-send
suppression).

**Prompt idle timeout — warn-and-continue** *(new in intentd —
[intent-hq/intentd#741](https://github.com/intent-hq/intentd/pull/741))*. A prompt turn that
goes the **whole idle window silent** — no ACP `session/update` traffic for **30 minutes** by
default, overridable via `INTENTD_PROMPT_IDLE_TIMEOUT_MS` (integer ms; actively-streaming turns
reset the timer on every update and never time out) — is **not** treated as a turn failure. The
daemon cancel-and-settles the hung `session/prompt` (`session/cancel`; the child process is kept
alive, interrupt keep-alive semantics — only when the transport is already dead is the child
alone torn down, and the follow-up turn respawns it), flushes the partial assistant transcript
(if any) as an ordinary assistant row, and closes the turn with the **normal** terminal
`agent:stream:end` — `messageId` present iff a partial row was persisted (a fully silent turn
persists nothing, so its `stream:end` carries no `messageId`), `turnId` naming the timed-out
turn, no `stopReason`. **No `agent:failed`, no `agent:idle`, no terminal-failure requeue, and no
completion-watch / delegation / parent wake fires** — the busy slot stays held. The worker then
persists a **user-visible user-role warning row** — `[SYSTEM WARNING] Your turn exceeded the
inactivity timeout (<window>s of silence) and was interrupted. Assess where you left off and
continue the work.`, rendering the **actual configured window** — with the standard user-row
`agent:message` echo and a **fresh `turnId`**, and immediately dispatches it as a new
`session/prompt` turn on the same held slot; the redrive bypasses the queue drain, so **queued
messages cannot jump ahead of the warning turn**. **Consecutive-timeout cap:** at most **3**
back-to-back silent-timeout warning redrives; the 4th consecutive silent timeout takes the
terminal path — the worker emits `agent:failed` (`{ agentId, error, turnId? }`; the timed-out
turn's normal `agent:stream:end` already fired) and the standard terminal-failure handling parks
the session in `error` and requeues the message for `agent.retry`. The streak resets to zero on
any completed turn, and a timed-out turn that streamed output before going silent counts as
intervening activity — the streak **restarts at 1** rather than accumulating (so a turn
producing some output before every timeout is never capped; tracked in
[monorepo#1107](https://github.com/intent-hq/monorepo/issues/1107)).

**Turn correlation (`turnId`)** *(new in intentd —
[monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022) /
[intentd#699](https://github.com/intent-hq/intentd/pull/699))*. Every user-initiated turn carries
a daemon-minted stable correlation id, returned by the originating RPC (`agent.sendMessage` /
`agent.queueMessage` / `agent.sendQueuedMessageNow` — and `agent.retry` when `redriven: true`,
§5.5) and stamped onto the turn's wire surfaces: the user-row `agent:message` echo, the
`agent:queue:processing` drain-start signal, `agent:failed`, and the terminal `agent:stream:end`
(§6.5/§7). The `agent:stream:end` stamping covers the turn-worker terminal (complete and error
arms alike) and the not-surfaced-by-streaming terminal-failure path — but NOT the user-interrupt
flush (§7.2), which is a manager-side emit outside the turn worker and deliberately carries no
`turnId` (nor the harness-wake finalize, per the no-retry-record rule at the end of this
paragraph); see the §7 `agent:stream:end` entry for the per-emit-site payloads. The id is
**stable across terminal-failure requeues** — the requeued queue entry gets
a new entry `id` but keeps the failed turn's original `turnId` — and **survives daemon restarts**
(persisted on the `agent_queue` row; legacy pre-#1022 rows rehydrate with `turnId = id`), so a
failure and its `agent.retry` redrive correlate with the id the client keyed at send time. For a
queue-drained turn, `agent:queue:processing` is the explicit turn-start signal keyed by `turnId`
— it covers `persisted: true` redrives that skip the duplicate user-row `agent:message` echo,
which is why the echo alone is not a sufficient start signal. All `turnId` fields are additive
and omitted when absent (never `null`); agent-initiated (harness-wake) turns and wake deliveries
carry none (no user retry record exists for them).

**Agent-initiated (harness-wake) turns** *(new in intentd —
[intent-hq/monorepo#855](https://github.com/intent-hq/monorepo/issues/855))*. A provider harness
can self-wake the agent — e.g. a harness background worker finishing (the wake trigger observed
in [intent-hq/monorepo#851](https://github.com/intent-hq/monorepo/issues/851)) — and stream a
full turn of ACP `session/update`s with **no** daemon `session/prompt` in flight. The daemon
recognizes the out-of-turn burst as an **implicit agent-initiated turn** instead of letting it
buffer and flush into the next user turn:

- **Trigger.** A per-agent idle-notification listener consumes the notification channel whenever
  no prompt turn holds it (it stays disengaged during prompt turns and during the `session/load`
  resume-replay drain — replay bursts are still discarded, no change there). On the first
  out-of-turn `session/update` that **materializes transcript content** — a text chunk, or a
  tool call with a derivable non-empty `toolName` — it claims the per-agent single-flight turn
  slot and mints an assistant `messageId`. Status-only / unmappable notifications and name-less
  tool-call first-sights are consumed and dropped **without** opening a turn, so a status-only
  wake burst never produces an `agent:stream:start` (avoiding a phantom
  `stream:start`/`stream:end` pair that would pin the busy slot for the settle window).
- **Start signal.** The turn opens with `agent:stream:start`
  `{ agentId, messageId, reason: "harness-wake" }` — emitted **only** for agent-initiated turns
  (§7); prompt turns are unchanged.
- **Streaming.** The same event family as a prompt turn follows: `agent:stream:chunk` /
  `agent:tool:call` under that `messageId`, with the live-turn slot open so a mid-turn
  `chat.subscribe` (§7.1) synthesizes structured blocks normally.
- **Finalization (quiescence).** A wake turn has no `session/prompt` future to resolve, so it
  finalizes on quiescence — a fixed settle window (~2 s) with no further notifications — or
  immediately when a prompt turn needs the receiver (finalize-then-handoff, never interleave).
  Finalization persists the assistant transcript row (skipped when the burst produced no
  transcript blocks — status-only updates), emits exactly one terminal `agent:stream:end`
  (carrying `messageId` **iff** the row was persisted; a no-content wake turn's `stream:end` is
  `{ agentId }` only, and the `messageId` announced by `agent:stream:start` then never appears
  in `agent.getConversation` — clients discard the empty in-flight turn on such a
  `stream:end`), then `agent:idle` with the existing
  suppression rules.
- **Racing user sends.** A user send arriving while a wake turn is active takes the existing
  busy-agent queue path (`agent.sendMessage` → `queued: true`, §5.5) and streams only after the
  wake turn's `agent:stream:end` — never interleaved. `priority: "interrupt"` / `agent.stop`
  tears the implicit turn down like any in-flight turn, flushing the partial row per §7.2.

**Batching window.** `events.subscribe` accepts a `batchWindow` hint on the deprecated `agent.*`/`event.*` aliases; the canonical bridge delivers each accepted event **individually** as it is accepted (no server-side coalescing on the WS bridge). Clients that need coalescing should debounce on their side, keyed by `event.type` + the relevant id in `data`.

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
events, not partial deltas.)

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
writers. This keeps the FE thin: it reflects backend-owned state rather than driving it.

### 6.9 Snapshot+delta subscription channels *(new in intentd)*

The `events.subscribe` firehose (§6.1) carries every bus event; a thin client that needs **structured live state for a specific entity family** subscribes to a typed channel instead. Each channel is intercepted on the transport fast-path **before** the JSON-RPC dispatcher (alongside `events.subscribe` and `system.*`), returns a `{ subscriptionId }` ack, then pushes a seq-0 **snapshot** followed by ordered **deltas** as `subscription.push` notifications (§3.3). The firehose stays unchanged and **coexists** with these channels.

| Method | Channel | Scope | Snapshot shape (seq 0) | Notes |
| --- | --- | --- | --- | --- |
| `note.subscribe` / `note.unsubscribe` | note | per-workspace (`workspaceId` req — `-32602` if missing/empty) | array of `Note` entities (newest-first) | `note:created`/`updated`/`deleted` → `added`/`updated`/`removedIds` via a re-read of the entity. |
| `task.subscribe` / `task.unsubscribe` | task | per-workspace (`workspaceId` req) | array of `WorkspaceTask` entities | tails `task:status-changed`/`task:ready-tasks-changed`. |
| `workspace.subscribe` / `workspace.unsubscribe` | workspace | global (no `workspaceId`) — the only global channel | array of `Workspace` entities visible to the connection, **including archived workspaces** (clients filter by `status` if needed; archived workspaces remain listed) | tails `workspace:created`/`updated`/`deleted`/`activity-changed`/`attention-changed`/`displayStatus-changed`. Snapshot and deltas are consistent on archived inclusion: deltas upsert archived workspaces as `updated`, and the seq-0 snapshot carries them too (matching the legacy `workspace.list { includeArchived: true }` fetch). |
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

Agent assistant output is delivered as the `agent:stream:*` event family (subscribe with `events.subscribe(["agent:stream:*"])`, optionally scoped by `workspaceId`). Note that tool-call activity is emitted as `agent:tool:call`, which the `agent:stream:*` filter does **not** match — a client that wants the full live turn (text + tool calls) subscribes with `["agent:stream:*", "agent:tool:call"]`. The backend maps a provider's streaming signals to these canonical event types.

The backend emits the **four** streaming signals in the table below in production. A fifth
event — the pre-first-token `agent:stream:status` startup hint (§6.5) — also matches the
`agent:stream:*` subscription filter and arrives on the same subscription, so clients
subscribing to the family should expect it on the wire too (it is documented in §6.5, not
repeated in the table below; note the converse quirk that `agent:tool:call`, which **is** in
the table, does *not* match the filter and must be subscribed explicitly). The formerly reserved
`agent:stream:content-blocks` / `agent:stream:message` / `agent:stream:tool_use` /
`agent:stream:tool_result` constants were never emitted and have been **removed** from the
taxonomy and `ALL_EVENT_TYPES` ([intent-hq/intentd#756](https://github.com/intent-hq/intentd/pull/756)).

**Emitted today:**

| Provider signal | Event type | data payload |
| --- | --- | --- |
| turn start (agent-initiated turns **only**) | agent:stream:start | { agentId, messageId, reason: "harness-wake" } — emitted when the daemon opens an **implicit agent-initiated turn** for an out-of-turn `session/update` burst (§6.6; [intent-hq/monorepo#855](https://github.com/intent-hq/monorepo/issues/855)). `messageId` is the assistant messageId minted for the wake turn (the same id carried by the turn's `agent:stream:chunk` / `agent:tool:call` events and — when the turn persists one — the persisted assistant row; a no-content wake turn skips persistence and its `agent:stream:end` omits `messageId`, §6.6). `reason` is `"harness-wake"` — the only value today. **Prompt (user-initiated) turns never emit this event**: its absence is the normal case, not an error |
| text token(s) | agent:stream:chunk | { agentId, content, messageId, blockIndex, blockId, blockType, streamId? } — incremental assistant text, enriched with the §7.1 block-identity fields (`messageId`/`blockIndex`/`blockId`/`blockType`) |
| tool call | agent:tool:call | { agentId, toolName, title, toolKind, toolCallId, input, status, output?, messageId, blockIndex, blockId, registeredAttachments? } — the single tool signal; `toolName` is the **real** tool name derived from the ACP title (`intent-acp::session::derive_tool_name`), `title` the raw human-readable ACP title; for a **known** `toolCallId`, sparse `tool_call_update` fields (`title`/`toolName`/`toolKind`/`input`) are backfilled from the per-call transcript state before the event is published (§7.1, [intent-hq/intentd#551](https://github.com/intent-hq/intentd/pull/551)); `registeredAttachments` is the claimed §7.1 `AtToolResult` canonical block batch, present only when the completed call claimed registered blocks (so the live `chat.subscribe` delta path attaches the SAME blocks the persisted transcript does); §7.1 `chat.subscribe` tails it to synthesize `tool_use` / `tool_result` blocks |
| complete or error | agent:stream:end | { agentId, stopReason?, messageId?, trailingBlocks?, turnId? } — the turn-worker terminal emit (`agent_session.rs` `run_prompt_turn`) covers **both** normal completion **and** error-terminated turns and additively carries ([monorepo#732](https://github.com/intent-hq/monorepo/issues/732), [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)): `messageId` — the turn's assistant message id, present whenever the turn persisted an assistant message (set only **after** the successful store append, so the event can never advertise a row that was never written); and `trailingBlocks` — the drained §7.1 `AtTurnEnd` resource blocks (e.g. `ws.app.question.ask` question blocks) in registration order, **byte-identical** to the trailing blocks of the persisted message, **omitted** when none were drained. The two fields are not independently optional in one direction: `trailingBlocks` is a trailing slice of the persisted message's blocks, so its presence **implies** `messageId` is present (a client always has the id to associate the blocks with); the converse does not hold — `messageId` routinely appears without `trailingBlocks`. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) — the turn correlation id naming the logical turn this event closes (the same id the send/enqueue RPC returned, §5.5/§6.6), stamped on both the complete and error arms; omitted when the turn carries none, never `null`. The not-surfaced-by-streaming failure path (`publish_terminal_failure_events`, e.g. spawn-retry exhaustion) emits `{ agentId, turnId? }` — the same `turnId` as its paired `agent:failed`; the daemon never emits `content` or `streamId` on this event. The **user-interrupt path** (§7.2) additionally carries `stopReason: "interrupted"`, plus `messageId` when an interrupted assistant row was persisted (the id of that row) — but deliberately **no** `trailingBlocks` (the `AtTurnEnd` registry is not drained on the interrupt path; pending entries wait for the next turn's drain / the registry TTL) and no `turnId` (the interrupt emit is a manager-side flush, not the turn worker's terminal). The **harness-wake turn finalize** (`agent_session.rs` `run_harness_wake_turn`, §6.6) is a fourth emit site: its payload is `{ agentId, messageId? }` only — `messageId` present iff the wake turn persisted an assistant row, and **never** `trailingBlocks` (the wake path performs no `AtTurnEnd` drain; only `run_prompt_turn` does) or `turnId` (agent-initiated turns have no user retry record). A **prompt idle-timeout** turn ([intentd#741](https://github.com/intent-hq/intentd/pull/741), §6.6 warn-and-continue) closes through the ordinary turn-worker emit with a payload indistinguishable from a normal completion — `messageId` iff a partial assistant row was flushed (a fully silent turn carries none), `turnId` of the timed-out turn, no `stopReason` — and is followed by the persisted `[SYSTEM WARNING]` user row + redriven warning turn instead of `agent:failed` / `agent:idle`, until the consecutive-timeout cap is spent (§6.6) |

Structured consumers should prefer the §7.1 `chat.subscribe` channel (the canonical structured
transcript) over reconstructing turn state from the firehose.

Notes for client implementers:

- **Ordering.** Events for one agent arrive in emission order over a single connection. Correlate astream with `data.agentId` (and `data.streamId` when present). Tool-call activity arrives as the single `agent:tool:call` event interleaved with `chunk` text; the §7.1 `chat.subscribe` channel synthesizes ordered structured blocks from these signals.
- **Agent-initiated turns.** A stream may begin with **no user send**: `agent:stream:start { agentId, messageId, reason: "harness-wake" }` announces an implicit agent-initiated turn (§6.6). Clients should open the same streaming UI as a user-initiated turn — spinner/busy state, active Stop/interrupt, autoscroll, live transcript — just with no user message row above it. A send racing an active wake turn auto-queues via the normal busy path and streams after the wake turn's `agent:stream:end`.
- **Terminal event.** `complete` and `error` are mutually exclusive and **both** map to `agent:stream:end` — there is exactly one terminal event per stream. The complete/error payloads are identical by design — both carry the additive `messageId` / `trailingBlocks` fields under the same conditions (the §7.1 `AtTurnEnd` drain deliberately runs on the error path too); the **user-interrupt** terminal emit alone adds `stopReason: "interrupted"` (+ `messageId` when an interrupted row was persisted — §7.2, never `trailingBlocks`), letting clients render a live "Stopped" indicator without a transcript re-fetch. A **harness-wake** turn's terminal emit carries `messageId` when the wake turn persisted a row and never `trailingBlocks` (§6.6; see the `agent:stream:end` row above). A client treats `stream:end` as "this turn is done" and then re-fetches the authoritative transcript via `agent.getConversation` if it needs the final, persisted message — though `trailingBlocks` lets it append the turn-end attachments to the finalized in-flight message immediately, without waiting on that re-fetch. A client that does both must not double-render: `trailingBlocks` are byte-identical to the persisted message's trailing blocks, so on re-fetch the client **replaces** the finalized in-flight message (keyed by `messageId`) with the persisted one rather than merging block lists.
- **Dedup.** The same agent output is also persisted; the live `agent:stream:chunk` text is *incremental UI sugar*. Canonical state is the persisted conversation. After `stream:end` (or on reconnect) call `agent.getConversation` rather than reconstructing solely from chunks. User messages echo cross-client as the user-row `agent:message` event (`role: "user"`, carrying a stable `messageId` — §6.5/§6.6; `agent:user-message:sent` is reserved-but-unused) so other clients can de-dupe their own optimistic insert.
- **Sending input.** Use `agent.sendMessage` (auto-queues if the agent is mid-stream; with `priority: "interrupt"` it instead preempts the turn keep-alive and streams immediately — duplicate interrupt delivery with the same `messageId` is absorbed idempotently, and an interrupt landing during turn startup queues keep-alive instead of preempting), `agent.queueMessage` to explicitly enqueue, or `agent.sendQueuedMessageNow` to atomically pull one already-queued entry and deliver it immediately with interrupt priority (the rest of the queue is preserved). `agent.stop` cancels an in-flight stream.

### 7.1 `chat.subscribe` — structured live transcript channel *(new in intentd)*

The `agent:stream:*` firehose (above) stays UI sugar (§10.1): a joiner that misses earlier chunks
cannot reconstruct the turn, and the client must re-fetch `agent.getConversation` after every
`stream:end`. `chat.subscribe` is the **canonical** alternative — an **agent-scoped** channel on the
snapshot+delta subscription engine (§6.9) that delivers a self-healing transcript a thin client
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
- **Activity-flags overlay.** The seq-0 snapshot also carries the daemon-owned activity flags from
  the `AgentLite` projection (§5.5) — `isResponding`, `isWaitingOnTool`, `isWaitingForOtherAgents`,
  `waitingForAgentIds`, plus the STAB-125 turn-liveness pair `turnInFlight` /
  `lastStreamActivityAt` (`null` when no turn is in flight) — so a client arriving mid-turn renders
  the same agent state as `agent.get` without a second read.

**Delta envelope.** Reuses the standard `{ added, updated, removedIds }` envelope with content blocks
as the id-bearing entities. Each entity carries the **full current block** (not a text diff) plus a
`{ agentId, messageId, role }` pointer — `role` is the row's real role: `assistant` for the stream
family, the persisted role (`user`/`system`/`tool`) for the non-assistant row deltas below — and
`messageSeq` + `timestamp` on the authoritative frames (the terminal reconcile and the
non-assistant row deltas):

- `added` — a block's first appearance this turn (e.g. a text block's first chunk, or a `tool_use`).
- `updated` — an existing block grown/changed, matched by `id` (e.g. each subsequent text chunk
  carries the full accumulated text; full-block replace is idempotent under re-delivery).
- `removedIds` — a block emitted **live** that the finally-persisted message does **not** contain.
  This is non-empty only for orphan self-heal: e.g. a trailing partial the durable turn dropped, or
  a mispredicted `tool_result` index. Clients **must** honor it when reducing deltas onto the
  snapshot.

**Non-assistant row deltas (`agent:message`, [intent-hq/intentd#747](https://github.com/intent-hq/intentd/pull/747)).**
In addition to the `agent:stream:*` family and `agent:tool:call`, the channel tails the per-persist
`agent:message` event (§6.5) — the forwarder's existing `sessionId == agentId` filter scopes it to
the subscribed agent — so persisted **non-assistant** rows (`user`/`system`/`tool`: direct sends,
queue drains, wake deliveries, model-change notices) surface as live deltas and subscribers render
new user messages with **no refetch**:

- **Assistant echoes emit nothing.** An `agent:message` whose `role` is `assistant` maps to no
  frame — the live stream + terminal reconcile owns assistant content, and emitting here would
  double-deliver — and costs no conversation read. The role is additionally re-resolved from the
  persisted row (defense-in-depth): a row that reads back as `assistant` still emits nothing.
- **Re-read, not payload.** The event payload is intentionally lean (`{ agentId, messageId,
  role, … }` — the row content is durably persisted, not enriched onto the event), so the row is
  re-read from the bounded newest `agent.getConversation` page — the same source the seq-0
  snapshot and the terminal reconcile use — keeping the emitted blocks byte-consistent with a
  fresh snapshot. Each persisted block arrives as an `added` entity carrying the row's **real**
  `role` plus the authoritative `messageSeq`, `timestamp`, and `streamingComplete: true`. A
  re-read miss (a `messageId` outside the newest page, or a read error) emits **no** frame.
- **Stable ids under re-delivery.** Non-assistant rows may persist their blocks without an `id`;
  the mapper stamps the stable synthetic `{messageId}:{index}` onto such blocks, so a re-delivered
  event upserts the same blocks as `updated` instead of duplicating. Known follow-up
  ([monorepo#1114](https://github.com/intent-hq/monorepo/issues/1114)): a fresh
  `agent.getConversation` / seq-0 snapshot still serves those blocks **id-less** — serve-time
  stamping is proposed there to close the snapshot/delta id-parity gap.
- **Streaming state untouched.** The per-turn assistant accumulation state is neither consulted
  nor mutated: a user row landing mid-turn (e.g. a queue drain landing right before the turn's
  first chunk, or an interrupt-priority send) cannot corrupt the in-flight assistant blocks, and
  user block ids never surface as orphan `removedIds` at the terminal reconcile.
- **Not a terminal signal.** Because these entities carry `streamingComplete: true`, that flag
  alone no longer identifies the turn's terminal reconcile frame — clients discriminate the
  terminal frame on `role == "assistant"` (plus `streamingComplete`).

Ordering: a direct send persists the user row (and publishes its `agent:message`) before the turn
worker spawns, and a queue drain's persist likewise precedes the drained turn's chunks, so the
user-row delta arrives **before** its own turn's assistant chunks. The emit is **not** ordered
against the *previous* turn's terminal frames (independent async paths).

**Synthesized `tool_use` block shape.** Both the persisted transcript (`record_tool` in
`agent_session`) and the live delta stream (`tool_delta` in `intent-transport`) synthesize
`tool_use` blocks from the same `agent:tool:call` signal (§7) via a single factory —
`crates/intent-services/src/tool_block.rs::build_tool_use_block` — so seq-0 and every subsequent
delta agree byte-for-byte. ACP providers deliver a human-readable `title` (e.g.
`"sub-agent-explore: Explore the AI agent system…"`) rather than the raw tool name the model
invoked; the real name is derived at `session/update` mapping time
(`intent-acp::session::derive_tool_name`), and carried on the event as `data.toolName` with the
raw title alongside as `data.title` — the factory places `toolName` in `block.name` verbatim.
Derivation: a title of the form `<name>: <description>` — `<name>` a bare `[A-Za-z0-9_-]+`
identifier followed by `": "` or `":\t"` — is split, taking the prefix. Titles without that
shape (`Edit src/lib.rs`, URLs like `https://…`, times like `10:15 sync`) pass through as
`name` unchanged. Trailing `_workspace-mcp` suffixes (one or more) are stripped: the registry
tool names carry no suffix, and auggie's `<tool>_<server>` convention appends the server
name, so stripping recovers the registry name (`add_to_note_workspace-mcp` → `add_to_note`).
The full title, when non-empty, is echoed verbatim as `input._acpTitle` so the FE classifier
has it alongside `name` for fallback rendering when raw args are missing (auggie frequently
sends `raw_input: null`); a `Null` `input` is coerced to `{}` so the marker can attach, while
non-object non-null inputs (arrays / scalars) pass through verbatim (the FE still has `title`
in the event).

**Sparse `tool_call_update` merge/backfill.** ACP providers send sparse `tool_call_update`
notifications (e.g. a status-only `completed` frame) in which absent fields map to an empty
`title` and `Null` `input`. These do **not** wipe earlier data: for a **known** `toolCallId`,
the daemon backfills the sparse event fields (`title`/`toolName`/`toolKind`/`input`) from the
per-call transcript state **before** the `agent:tool:call` event is published, and non-empty
update fields refresh the persisted `tool_use` block — a non-empty `title` refreshes
`input._acpTitle` (and `block.name` when the newly derived name is non-empty), a non-null
`input` replaces the block input (re-attaching the freshest title), and `status` always
patches. The live `tool_delta` block therefore stays byte-identical to the persisted one — the
byte-parity invariant above is maintained. The STAB-124 drop is unchanged: an update whose
`toolCallId` was never seen this turn is still dropped, never synthesized into a new block.
([intent-hq/intentd#551](https://github.com/intent-hq/intentd/pull/551))

**Tool blocks.** The channel tails the single `agent:tool:call` event and synthesizes TS-shaped
blocks matching the persisted transcript: a `tool_use` block (`{ type, id, name, input, toolCallId,
metadata:{ toolKind, status } }`) and, once the same call completes **with** output, a `tool_result`
block (`{ type, id, tool_use_id, output, is_error }`).

**Standalone proposal-resource block.** When a completed tool's `output` array contains a
well-formed proposal resource item — `{ type: "resource", resource: { mimeType:
"application/vnd.intent.proposal+json", text: "<proposal JSON>", … } }` with `text` a string —
the daemon **additionally** appends a standalone `resource` content block right after the
`tool_result`, echoing the output item verbatim with the stable block id stamped on
(`{ type: "resource", id: "{messageId}:{index}", resource: {…} }`). The resource item stays in
`tool_result.output` untouched. This lets the FE render a `ProposalCard` from a top-level block
without digging through tool output. Both the persisted transcript (`record_tool`) and the live
delta stream (`tool_delta`, which predicts the block id at `tool_result` index + 1, self-healing
via `removedIds` on a misprediction) derive the block from the same helpers
(`crates/intent-services/src/tool_block.rs::lift_proposal_resource` /
`build_proposal_resource_block`), preserving the byte-for-byte snapshot/delta invariant.
Malformed items (wrong MIME, missing or non-string `text`) are ignored —
no standalone block is emitted. The lift is gated on `status: "completed"` only: a tool that
ends in `error` never surfaces a standalone proposal block, even if its output still carries the
resource item.

*Collapsed-output fallback.* Some providers (e.g. auggie) do not echo the MCP content-item
array in `rawOutput`: they flatten the daemon's dual text+resource items into a single
`{ "output": "<stringified first text item>" }` object, dropping the resource item entirely.
When the tool output is **not** an array, the daemon falls back to recovering the proposal from
that collapsed string: the candidate is the nested `output` field inside the `tool_result`
block's `output` (i.e. `tool_result.output.output`), or `tool_result.output` itself when it is
a bare string. The fallback is **shape-based, not tool-scoped**: it applies to any completed
tool's collapsed output, with no filtering on tool name or other provenance signal. Acceptance
is gated purely on validation: the candidate string is size-capped (256 KiB), must parse as a
JSON object with `ok: true`, and its `proposal` must pass the bindings' canonical validation
(known `kind`, non-empty `preview.title`, object `payload`) — the same checks
`ws.app.proposal.show` applies before emitting, so any accepted payload is indistinguishable
from the daemon's own echo. The resource item is then rebuilt with the
bindings' own helpers (`intent-proposal://{kind}/{encoded id}` URI, name from `preview.title`,
compact proposal JSON as `text`), so the standalone block is identical to the array path.
Ordinary collapsed tool outputs never pass the guards, and the `tool_result`'s `output` stays
the collapsed object untouched.

**Standalone question-resource blocks (`AtTurnEnd`, [monorepo#732](https://github.com/intent-hq/monorepo/issues/732)).**
The second resource MIME type is `application/vnd.intent.question+json` — structured clarifying
questions an agent asks mid-task via the MCP `ws.app.question.ask` binding. Unlike the proposal
lift (which attaches at the registering call's `tool_result`), question attachments use the
`AtTurnEnd` policy: every question asked during a turn is drained when the turn finalizes and
appended as a trailing `resource` content block on the **same final persisted assistant message**,
in `ask()` call order. The block echoes the canonical attachment item:

```json
{ "type": "resource", "resource": {
    "uri": "intent-question://tar-3f9c2a81d0b4",
    "name": "Auth method",
    "mimeType": "application/vnd.intent.question+json",
    "text": "<question JSON>" } }
```

`resource.name` is the question's `header`; the URI reuses the daemon-minted attachment nonce.
`resource.text` is a **JSON-serialized string** (like every `resource.text`, it is a string field
holding compact JSON — not an embedded JSON object); decoded, the payload is:

```json
{
  "attachmentId": "tar-3f9c2a81d0b4",
  "header": "Auth method",
  "question": "Which authentication method should the new endpoint use?",
  "explanation": "optional longer context shown expandable",
  "options": [
    { "label": "OAuth", "description": "Standard OAuth 2.0 flow" },
    { "label": "API key", "description": "Static key in header" }
  ],
  "multiSelect": false
}
```

- `attachmentId` is the minted `tar-` nonce (the same id in the `intent-question://` URI).
- `header` and `question` are required, trimmed, non-empty strings.
- `explanation` is optional; absent/blank values are **omitted** from the payload (never `null`).
- `options` is `[{ label, description? }]` — `label` required non-empty (trimmed); `description`
  optional, omitted when blank. A free-form "Other" answer is always offered by the FE and is
  **never** listed as an option.
- `multiSelect` is always present, defaulting to `false`.

Because the drain happens at turn finalization (before the message persists), question blocks are
**not** emitted live mid-turn: `chat.subscribe` subscribers receive them in the terminal reconcile
frame (as `added` blocks with the stable `{messageId}:{blockIndex}` ids), and they are on the
persisted message via `agent.getConversation`. Firehose consumers get live delivery at turn end:
the terminal `agent:stream:end` carries the drained blocks as `trailingBlocks` (plus the turn's
`messageId` — §7 emitted-events table; [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)),
so a client that finalizes the in-flight message from accumulated chunks can append them
immediately instead of waiting for a transcript re-fetch.

*The `ws.app.question.ask` binding.* JS signature
`ws.app.question.ask({ question, header, options, explanation?, multiSelect? })` →
`{ ok: true, attachmentId, message }`. **One question per call** — the model calls it once per
question and may call it multiple times in a turn (each call queues one attachment). Deliberate
deviation from the rest of `ws.app.*`: the binding is **not chief-gated** — any workspace agent
may ask (the sibling `ws.app.*` subnamespaces remain chief-only). Hard validation (the call fails
with a descriptive tool-error string; nothing is queued): the single params object
(`{ question, header, options, ... }`) missing or not a JSON object, missing/empty `question` or
`header` (after trim), missing/non-array `options`, fewer than 2 options, or any option with a
missing/empty `label`. Validation imposes **no upper caps** — the ~4-questions-per-turn and
2–4-options guidance is soft advice that lives **only** in the tool description and is never
enforced — though the turn-attachment registry retains at most 32 attachments per agent, silently
evicting the oldest (asks beyond that still return `{ ok: true }` but the earliest questions are
dropped from the turn-end drain). The call also fails outside a live agent turn (no
turn-attachment registry or caller agent wired).

*Answers are plain text — an FE convention, not a wire feature.* The FE presents the turn's
questions sequentially and flattens **all** answers into ONE ordinary plain-text user message sent
via the normal `agent.sendMessage` path: blank-line-separated `Q:`/`A:` pairs, multi-select answers
comma-joined, free-form replies prefixed `(Other) `, skipped questions reported as `(skipped)`:

```text
Q: Which authentication method should the new endpoint use?
A: OAuth

Q: Which database?
A: (Other) Use both, key for internal

Q: Deploy target?
A: (skipped)
```

There is **no** `messageMetadata`, no answer ids, and **no daemon-side answer intake**: the daemon
persists and delivers the text verbatim as a completely ordinary user message (the model has the
context to correlate). Do **not** add daemon-side inspection, parsing, or correlation of these
answers — the format is an FE↔model convention and the daemon is deliberately not a party to it.
Any later user message supersedes the questions; the FE derives pending vs. answered purely from
"does a user message exist after the question-bearing assistant message".

*Daemon-side question hold (v2.8).* While the questions are pending — the same derivation as the
FE's, plus the `agent.dismissQuestions` dismissal marker — **automatic** deliveries to the asking
agent (A2A sends, parent wakes, event batches, `agent.sendToTask`) are parked in its pending queue
instead of starting a turn, so an internal message cannot supersede the Q&A and silently dismiss
the wizard. User-origin sends (the answer path) bypass and release the hold, and
`agent.dismissQuestions` releases it without notifying the model. Full contract in §5.5
("Question hold").

*Rendering surface — wizard only (an FE convention).* Question blocks are surfaced exclusively via
the composer-area wizard: they are **never** rendered as transcript cards, whether pending or
resolved. This is an explicit contrast with proposal resource blocks, which legitimately render as
in-transcript cards. The question blocks themselves **are** persisted (they are durable trailing
blocks of the assistant message, §7) — they are merely never given a transcript-card rendering;
the **visible** in-transcript record of a Q&A exchange is the user's flattened `Q:`/`A:` reply
message ([cloudlands-fe#424](https://github.com/intent-hq/cloudlands-fe/pull/424)).

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
with `streamingComplete:true` and any orphan ids in `removedIds`. A persisted non-assistant row
(direct send, queue drain — the non-assistant row deltas above) arrives as `added` entities with no
live-streaming phase: the row's real `role` plus the authoritative `messageSeq`/`timestamp`/
`streamingComplete:true` in a single frame.

### 7.2 Interrupted partial-turn persistence

On a **user interrupt** of an in-flight turn — `agent.stop`, `agent.sendQueuedMessageNow`, or `agent.sendMessage` / `agent.sendToTask` called with the request parameter `priority: "interrupt"` — the daemon persists the streamed-so-far partial assistant message **before** emitting the terminal `agent:stream:end`. The partial turn's content blocks are written to the transcript under the assistant `messageId` minted at turn start (the same id carried by the live `agent:stream:chunk` events, and from which the `chat.subscribe` synthetic block ids are derived as `{messageId}:{blockIndex}` — §7.1), tagged on the message row with:

- `metadata.interrupted: true`
- `metadata.stopReason: "interrupted"`

This is the same convention as the graceful-shutdown flush of an in-flight turn.

**Terminal-event payload.** The interrupt path's terminal `agent:stream:end` (§7 emitted-events table) carries `stopReason: "interrupted"`, plus `messageId` when an interrupted assistant row was persisted — the id of that row — so clients can flag the turn as stopped live, without waiting for the transcript re-fetch. Normal-completion and error-terminated turn emits never carry `stopReason`, but they **do** carry `messageId` (when the turn persisted an assistant message) and `trailingBlocks` (when §7.1 `AtTurnEnd` blocks were drained — the drain deliberately runs on the error path too; §7, [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)). The interrupt emit itself never carries `trailingBlocks`: the `AtTurnEnd` registry is **not** drained on the interrupt path — pending entries wait for the next turn's drain or the registry TTL — so there are no persisted trailing blocks for the event to mirror.

**Pre-first-token stop (zero-output flush).** When nothing has streamed yet (no content blocks), whether a row is persisted — and therefore whether the terminal `agent:stream:end` carries `messageId` — depends on the interrupt path:

- **`messageId` guaranteed — plain `agent.stop` on the keep-alive interrupt path with a live-turn slot.** When a live ACP session exists to cancel (connection + `acpSessionId`) AND the turn has registered its live-turn slot (the worker reached prompt dispatch), a plain `agent.stop` persists a synthetic **empty** interrupted assistant row (`contentBlocks: []`, `metadata.interrupted: true`, `metadata.stopReason: "interrupted"`) so the transcript durably records the stop, and the terminal `agent:stream:end` carries that row's `messageId`. This is the **only** pre-first-token case that persists a row.
- **`messageId` absent — everything else.** No row is persisted when: (a) no live-turn slot exists yet (the stop landed during turn startup — spawn / `initialize` / `session/new` / `session/load` — before the worker registered the turn; the emit still carries `stopReason: "interrupted"` but no `messageId`); (b) the stop takes the hard-kill fallback (no live connection or no `acpSessionId` — that path never flushes); (c) the interrupt comes from an **interrupt-priority send** (`agent.sendMessage` / `agent.sendToTask` with `priority: "interrupt"`) or the **graceful-shutdown capture**, which keep the zero-output flush as a **no-op** (STAB-114) so no phantom empty row lands ahead of the preempted user message's redelivery. For an interrupt-priority send, that redelivery is the zero-output combined delivery — the preempted user message rides the interrupt turn's prompt (see `agent.sendMessage`, §5.5, [monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)); for the graceful-shutdown capture there is no interrupt message — the no-op flush simply keeps the transcript's last row as the user message so the post-restart redelivery isn't blocked by a phantom empty assistant row.

**Consequence for **`chat.subscribe`** (the terminal reconcile of §7.1):** because the partial assistant row is persisted before `agent:stream:end`, the channel's terminal reconcile re-reads a transcript that **contains** the streamed message — the streamed blocks are re-emitted as authoritative `updated` entries and are **not** wiped via `removedIds`. Clients keep the partial output visible and may render an interrupted/"Stopped" indicator from `metadata.interrupted` / `metadata.stopReason` on the persisted row (also visible via `agent.getConversation`). On an interrupt-priority send, the interrupted partial row precedes the new user message in the transcript.

Added in [intent-hq/intentd#336](https://github.com/intent-hq/intentd/pull/336); terminal-payload `stopReason`/`messageId` and the pre-first-token empty-row persist added in [intent-hq/intentd#492](https://github.com/intent-hq/intentd/pull/492); no method-surface change (additive semantics within protocol v2.0).

## 8. Permission Flow

When an agent's provider (e.g. auggie) wants to run a tool that requires approval, it sends an ACP`session/request_permission` request **to the backend** (over the provider's stdio channel, not theclient WebSocket). The backend mediates approval:

1. **Bypass / auto-approve.** For non-interactive providers running in `bypassPermissions` mode (orwhen the provider can't set a mode), the backend auto-selects an "allow" option and respondsimmediately — no client involvement.
2. **Interactive.** Otherwise the backend **blocks the agent's stream** and surfaces a permission request to the frontend: the daemon pushes it to subscribed clients and awaits a response.

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
> **Default policy.** The shipped default is **`AllowAll`** for reference parity with the TS
> acp-provider, selectable at runtime via **`INTENTD_PERMISSION_POLICY`**
> (`interactive|auto|allow|deny`, default `AllowAll`). Under `AllowAll`,
> `AgentManager::start_session` additionally issues a best-effort
> `session/set_mode { modeId: "bypassPermissions" }` after `session/new`,
> `session/load`, and the recreate fallback on providers that advertise
> set-mode (auggie today). Providers that don't advertise set-mode, or that
> reject the mode change, fall through to the local auto-approve inside
> `ClientRequestHandler` (the previous `AutoByRisk` default silently denied
> medium/high prompts). An **`Interactive`**
> deployment instead blocks the agent's stream and surfaces each prompt via
> `agent.pendingPermissions`, resolving it via `agent.respondPermission` (still
> bounded by the 5-minute timeout when left unanswered). **`AutoByRisk`** and
> **`DenyAll`** remain available for headless-with-guardrails deployments and
> never issue the bypass mode change.

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
| -32602 | Invalid params | Missing required param ("Missing required parameter: <name>"), bad workspaceId ("workspaceId is required"), non-array where an array is required, "not found" lookups, unauthorized repoPath, etc. A `workspace.create` failure from an unresolvable base ref keeps this code and its human message but adds `error.data = { code: "base-ref-unresolvable", baseRef }` so clients detect the condition from `error.data.code` instead of parsing the message; `baseRef` is the canonical (remote-prefix-stripped) ref — the same value interpolated into the human message (§5.1 worktree provisioning + `baseRef` canonicalisation). User-fixable clone failures (`path-invalid`, `destination-exists-non-empty`) also use this code — see the clone failure taxonomy below. |
| -32603 | Internal error | Underlying service threw. message is "Internal error" with the original message in data for unexpected throws; many shims pass the underlying message through as message directly. Classified clone failures never surface as a bare "Internal error" — see the clone failure taxonomy below. An `isNewRepo` repository-initialization failure in `workspace.create` (§5.1 new-repository initialization) keeps the bare "Internal error" message but carries the cause in `error.data` (`workspace.create: repository initialization failed: <detail>`). |
| -32005 | Conflict | Optimistic-concurrency failure: a conditional write's `expectedVersion` did not match the entity's current `rev`. `error.data = { code: "conflict", current }` carries the current entity so the client can reconcile (note conditional writes; §4, §5.6). |
| -32001 | Unauthorized | Local-only guard: a remote (TCP/WSS) caller invoked a local-only fast-path method (e.g. `pairing.getInfo`, `server.pairingInfo`, `server.rotateToken`, `system.shutdown`, `system.importLegacy`, or `system.gitCredential`, §5). |

The only custom numeric codes outside the standard `-327xx` range are `-32005` (Conflict) and `-32001` (Unauthorized, local-only guard); other server-specific conditions (e.g. "not a delegated agent", "path outside workspace", "staging `.` is blocked") are reported as `-32602`/`-32603` with a descriptive `message`. Notification-shaped requests (no `id`) never receive an error response except for parse/invalid-request failures detected before the notification status is known.

### 9.1 Clone failure taxonomy (`workspace.create`)

A failed clone/provisioning step in `workspace.create` (§5.1 clone orchestration) is classified into a typed error instead of a generic internal error (monorepo#826). The envelope is always:

- `error.message` — `workspace.create clone failed (<category>): <detail>`
- `error.data` — `{ "code": "<category>", "detail": "<detail>" }`

where `detail` is a human-readable cause: the tail of `git clone`'s stderr (bounded, ~4 KiB) with any `user[:pass]@` credential fragments in URL-like substrings redacted to `***@`. Tokens never reach the wire. The categories (`error.data.code`) and their numeric codes:

| data.code | Numeric | When |
| --- | --- | --- |
| path-invalid | -32602 | The clone destination path is missing/malformed (e.g. `clonePath` resolves to no file name) or not creatable (permission denied, read-only filesystem, could-not-create-work-tree). User-fixable: correct the path and retry. |
| destination-exists-non-empty | -32602 | The clone target already exists and is not an empty directory (detected pre-clone or reported by git). User-fixable: choose a different destination. |
| askpass-missing | -32603 | The askpass helper script could not be executed ("ssh-askpass-intent", "cannot exec … askpass", "app.asar … not a directory") — e.g. macOS quarantine relocated the app bundle so the packaged helper path is unreachable. Git's stderr drags the auth prose along with the exec failure, but this classification outranks `auth-required`: the remedy is local (move the app out of quarantine), not credentials (monorepo#837). |
| auth-required | -32603 | The remote rejected the clone for lack of credentials ("Authentication failed", "could not read Username … terminal prompts disabled", "Permission denied (publickey)", "Invalid username or password"). Shared with the credential-injection auth classification (monorepo#825). |
| repo-not-found | -32603 | The remote reports the repository does not exist ("Repository not found", HTTP 404). With credential injection in play (monorepo#825), GitHub also answers 404/not-found for private repos the presented token cannot see. |
| access-denied | -32603 | The remote refused access to an existing repository (HTTP 403, "access denied"). |
| network | -32603 | The remote could not be reached: DNS ("Could not resolve host"), connect ("Connection refused", "Network is unreachable"), timeout (including the daemon's own clone timeout), or truncated transfer ("early EOF", "remote end hung up unexpectedly"). |
| clone-failed | -32603 | Any other clone failure; `detail` still carries the sanitized stderr tail. |

Only these `data.code` values are a stable contract; clients must exact-match them and treat unknown codes as `clone-failed`. Classification is best-effort prose matching over git's stderr — the `detail` is authoritative for display, the `code` for behavior. The classified categories are shared with the streaming `git.clone` surface: a failed `git:clone:done` frame carries the same category string as `data.errorCode` when classification succeeded (§5.6, §6.5).

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
1.  pair via QR / manual entry → host:port, fp=AB:CD:..., token   (pairing payload, §2.3)
2.  WSS connect wss://host:port/ws  (pin fp)                  (§1.2)
        Authorization: Bearer <token>                        (§2.1)
3.  → events.subscribe { eventTypes:["agent:*","note:*","task:*"], workspaceId:"ws-abc" }
    ← { subscriptionId:"ws-sub-1" }                          (§6.1)
4.  → workspace.get { workspaceId:"ws-abc" }   ← { workspace }
    → note.list      { workspaceId:"ws-abc" }   ← { notes }
    → agent.list     { workspaceId:"ws-abc" }   ← { agents }
5.  → agent.sendMessage { workspaceId, agentId:"agent-123", content:"Fix the build", messageId:"m1" }
    ← { success:true, queued:false, messageId:"m1" }         (§5.5)
6.  ← events.event agent:stream:chunk* / agent:tool:call / agent:stream:end   (§7; agent:stream:start only on agent-initiated turns, §6.6)
7.  → agent.getConversation { agentId:"agent-123" }  ← { messages, ... }   (reconcile, §10.1)
8.  (permission prompt, if any) ← request_permission → respond selected/allow_once  (§8)
9.  on disconnect: reconnect, re-auth, repeat from step 3.   (§4)
```

*The canonical wire-protocol specification for the Intent backend daemon (`intentd`). The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`; changes follow the compatibility policy at the top of this document.*