# Intent Backend — JSON-RPC Protocol v2.0

**Protocol Version:** `2.0`  
**Status:** Frozen as of 2026-07-14

This document specifies the wire contract between Intent clients (desktop, iOS, CLI) and the Intent backend daemon (`intentd`). The protocol surface is frozen at v2.0 and enforced by golden tests in the `intent-transport` crate.

## Table of Contents

1. [Protocol Version & Compatibility](#1-protocol-version--compatibility)
2. [Transport](#2-transport)
3. [Authentication](#3-authentication)
4. [Message Envelope (JSON-RPC 2.0)](#4-message-envelope-json-rpc-20)
5. [Heartbeat & Lifecycle](#5-heartbeat--lifecycle)
6. [Method Catalog](#6-method-catalog)
   - 6.1 [Router Methods](#61-router-methods-262-total)
   - 6.2 [Fast-Path Methods](#62-fast-path-methods-29-total)
   - 6.3 [Method Aliases](#63-method-aliases-2-total)
   - 6.4 [Server→Client Notifications](#64-serverclient-notifications-1-total)
   - 6.5 [Client-Served Reverse RPCs](#65-client-served-reverse-rpcs-4-total)
   - 6.6 [Interrupted-Agent Resumption](#66-interrupted-agent-resumption-v20-additions)
   - 6.7 [`models.list` Per-Provider Catalog](#67-modelslist-per-provider-catalog-v20-additions)
7. [Events & Subscriptions](#7-events--subscriptions)
8. [Error Codes](#8-error-codes)

---

## 1. Protocol Version & Compatibility

**Version:** `2.0`

The protocol version is advertised in two places:

- **`client.hello`** response: `{ protocolVersion: "2.0", server: { protocolVersion: "2.0", ... }, ... }` — the top-level `protocolVersion` is an explicit copy of `server.protocolVersion` so clients can version-check without digging into the `server` block.
- **`system.status`** response: `{ protocolVersion: "2.0", ... }`

### Compatibility Policy

- **Additive changes** (new methods, new optional fields, new event types) bump the **minor** version (e.g., 2.0 → 2.1).
- **Breaking changes** (removed methods, changed signatures, renamed fields) bump the **major** version (e.g., 2.0 → 3.0).

The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`. Any drift (added, removed, or renamed methods) causes CI failure with the instruction: "update `catalog.rs` + `docs/PROTOCOL.md` and bump the protocol version."

---

## 2. Transport

### 2.1 Connection URL

The backend runs an **HTTPS server** bound to `0.0.0.0` (LAN-reachable) exposing a single WebSocket endpoint:

```
wss://<host>:<port>/ws
```

- **Default port:** `5181` (fixed; the daemon exits if the port is in use).
- **Scheme:** `wss://` (TLS) in the default secure posture. Plain `ws://` is available only in insecure dev mode (`--insecure` / `INTENTD_INSECURE=1`), which disables TLS and bearer-token enforcement and logs a prominent warning.
- **Health check:** `GET /health` → `{"status":"ok","clients":<n>}` for liveness probing.
- Any path other than `/ws` is rejected at upgrade time.

**Unix-domain socket (UDS):** The daemon also supports a UDS transport for the local-first default. The JSON-RPC envelope, method catalog, and event semantics are **identical** across UDS and WSS — only the listener differs.

### 2.2 TLS & Fingerprint Pinning

The server generates a **self-signed** EC (P-256) certificate on first start, persists it under the app's data directory (`ws-cert.pem` / `ws-key.pem`), and reuses it across restarts (10-year validity).

- **SHA-256 fingerprint:** Clients pin the certificate by its SHA-256 fingerprint (colon-separated uppercase hex, e.g., `AB:CD:EF:...`), computed over the DER body of the cert.
- **SANs:** The cert includes `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 address on the host (LAN, Tailscale, etc.).
- Clients should **reject** any cert whose fingerprint does not match.

### 2.3 mDNS / Bonjour Discovery

When discovery is enabled, the server advertises a Bonjour/DNS-SD service:

- **Service type:** `_intent-ws._tcp`
- **Service name:** `Intent on <hostname>`
- **Port:** the bound WSS port
- **TXT record keys:**
  - `version` — `"1"`
  - `path` — `"/ws"`
  - `hostname` — `os.hostname()`
  - `fp` — the TLS cert SHA-256 fingerprint (for pinning)

---

## 3. Authentication

### 3.1 Bearer Token on Upgrade

Every WebSocket upgrade must present a bearer token. The server checks the token **during the HTTP upgrade** (before the socket is upgraded) in this order:

1. `Authorization: Bearer <token>` header
2. `?token=<token>` query parameter on the `/ws` URL (for clients that cannot set headers)

Validation is **timing-safe** (constant-time compare). On failure, the upgrade is rejected with `HTTP/1.1 401 Unauthorized`.

- The token is **32 random bytes, hex-encoded (64 chars)**, generated once and persisted in app settings. It can be rotated by the host application.
- If the WebSocket API is disabled in settings, upgrades are rejected with `403 Forbidden`.

### 3.2 Origin Allow-List

Browser-origin upgrades are gated to prevent cross-origin attacks; native clients are allowed:

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients), `file://` (Electron renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's own hostname / `.local` form.
- **Rejected** (`403`): `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

---

## 4. Message Envelope (JSON-RPC 2.0)

All application messages are **JSON-RPC 2.0** text frames.

### 4.1 Request

```json
{ "jsonrpc": "2.0", "id": 1, "method": "note.list", "params": { "workspaceId": "ws-abc" } }
```

- `jsonrpc` — **must** be the string `"2.0"`. Otherwise → `-32600 Invalid Request`.
- `method` — **must** be a non-empty string. Otherwise → `-32600`.
- `id` — string, number, or `null`. Any other type → `-32600`.
- `params` — object (named) or array (positional). **Named (object) params are required by this API.** Positional arrays are accepted per spec but coerced to `{}`. Non-object/array `params` → `-32602 Invalid params`.

### 4.2 Success Response

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "notes": [ /* ... */ ] } }
```

`result` is always a JSON **object** (never a bare array/scalar); list endpoints wrap their array under a named key (e.g., `{ "notes": [...] }`, `{ "agents": [...] }`).

### 4.3 Error Response

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Missing required parameter: noteId" } }
```

`error.data` is optional and carries extra context (e.g., the original internal error message for `-32603`). See §8 for the code table.

### 4.4 Notifications (No Response)

A request **without an `id` member** is a notification: the server processes it and returns nothing. Note the distinction required by JSON-RPC 2.0:

- `id` **absent** → notification → no response is ever sent (even on error / unknown method).
- `id: null` **present** → a normal request that **must** receive a response.

Unknown methods sent as notifications are silently ignored; unknown methods sent as requests get `-32601 Method not found`.

### 4.5 Batching

The server processes **one JSON-RPC object per WebSocket text frame**. JSON-RPC batch *arrays* are **not** supported: a top-level array fails envelope validation (`-32600 Invalid Request: expected an object`). Clients should send one message per frame and correlate responses by `id`. Independent requests can be pipelined.

### 4.6 `workspaceId` Scoping

Most methods operate within a workspace. `workspaceId` is read from `params.workspaceId`, falling back to a connection-level context value if the transport provides one. If neither is present, the method returns `-32602 "workspaceId is required"`. Workspace/repo/specialist/global methods (e.g., `workspace.list`, `repo.list`, `specialist.list`, `agent.getModels`) do not require it.

---

## 5. Heartbeat & Lifecycle

- **Ping/pong:** The server sends a WebSocket **ping every 30s**. The client's transport must answer with a standard pong frame. If no pong is seen within **60s**, the server terminates the connection and cleans up its subscriptions.
- **Server shutdown:** On graceful stop, clients are closed with code `1001` (`"Server shutting down"`) and all transport-local subscriptions are dropped.
- **Disconnect cleanup:** On `close` or socket `error`, the server removes the client and all of its event subscriptions. Subscriptions are **per-connection** and do **not** survive reconnects.
- **Reconnection guidance:** Clients should reconnect with backoff, re-authenticate on the new upgrade, and **re-establish all subscriptions** (re-send `events.subscribe`). After reconnect, a client should **re-fetch** the entities it cares about rather than assuming it missed nothing.

### 5.19 `file-tracking.loadCommits`

Returns commit history with attribution and workspace boundary information.

**Request:**

```jsonc
{
  "workspaceId": "workspace-abc",
  "limit": 50,           // optional, default 50
  "nextToken": "...",    // optional, for pagination
  "includeOlder": false  // optional, default false - when true, returns commits before and including the boundary
}
```

**Result:**

```jsonc
{
  "commits": [
    {
      "hash": "abc123...",
      "message": "feat: add feature",
      "author": "...",
      "date": "...",
      "files": ["..."],
      "filesChanged": 3,
      "isPushed": true,
      "agentId": "agent-...",      // optional
      "linkedNoteId": "note-..."   // optional
    }
  ],
  "boundarySha": "def456...",  // workspace boundary commit SHA, or null when no boundary info or unresolvable
  "nextToken": "..."            // pagination token, or null
}
```

**Boundary Semantics:**

- When `includeOlder` is `false` (default), returns commits in the `boundary..HEAD` range (workspace-owned commits only)
- When `includeOlder` is `true`, returns commits before and including the workspace boundary (for "show previous" functionality; the boundary commit itself is included)
- `boundarySha` is `null` when:
  - The workspace has no boundary info (`baseRef` or `baseCommitSha` not set), OR
  - Boundary info exists but cannot be resolved (e.g., shallow clone, nonexistent ref, base commit not an ancestor of HEAD)
- **Fail-closed safety net:** When boundary info exists but cannot be resolved, the method returns an empty commit list (regardless of `includeOlder` value) to prevent leaking arbitrary base-branch history

**Boundary Resolution Strategy:**

1. Prefer merge-base of HEAD with `origin/<baseRef>` or `<baseRef>` (rebase-resilient)
2. Fall back to `baseCommitSha` if it is a valid ancestor of HEAD
3. Return `null` if neither resolves

---

## 6. Method Catalog

The API exposes **293 dispatchable method names** across the following categories:

- **Router methods:** 262 methods dispatched via the main router (`router::dispatch`)
- **Fast-path methods:** 29 methods intercepted before the router for performance or per-connection state
- **Method aliases:** 2 aliases accepted on the wire (`git.diff` → `git.diffs`, `git.log` → `git.commits`)

Additionally, the protocol includes:

- **Server→client notifications:** 1 notification (`events.event`)
- **Client-served reverse RPCs:** 4 methods (dual-role, counted within the 293 dispatchable names: `browser.exec`, `host.openExternal`, `host.openInEditor`, `host.pickApplication`)

**Total:** 293 dispatchable names + 1 notification. The 4 reverse-RPC names are dual-role: they are dispatchable client→server methods AND are also issued daemon→client as reverse RPCs on remote connections.

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields `-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires `workspaceId` (see §4.6) and may return `-32603 Internal error` if the underlying service throws.

### 6.1 Router Methods (262 total)

The following 262 methods are routed through the main dispatch match in `router.rs`.

#### `agent.*` (38 methods)

agent.appendMessage, agent.cancelSubscriptions, agent.completeOnce, agent.create, agent.delegate, agent.delete, agent.diagnostics, agent.editAndRegenerate, agent.editQueuedMessage, agent.enhancePrompt, agent.forceMessage, agent.get, agent.getConversation, agent.getModels, agent.getQueue, agent.getSession, agent.getSessionStats, agent.getSubscriptions, agent.list, agent.listInterrupted, agent.pendingPermissions, agent.queueMessage, agent.removeQueuedMessage, agent.rename, agent.replaceMessages, agent.reportToParent, agent.resolveInterrupted, agent.respondPermission, agent.retry, agent.sendMessage, agent.sendToTask, agent.setModel, agent.stop, agent.subscribe, agent.summary, agent.unsubscribe, agent.update, agent.wakeOrCreate

#### `comment.*` (6 methods)

comment.add, comment.delete, comment.getThread, comment.list, comment.resolveThread, comment.respond

#### `crossWorkspace.*` (3 methods)

crossWorkspace.listNotes, crossWorkspace.listSiblings, crossWorkspace.readNote

#### `event.*` (5 methods)

event.agentActivity, event.directoryChanges, event.query, event.recentFiles, event.workspaceSummary

#### `file.*` (9 methods)

file.delete, file.exists, file.list, file.mkdir, file.read, file.rename, file.stat, file.tree, file.write

#### `git.*` (28 methods)

git.agentCommit, git.branchDiff, git.branchStatus, git.changes, git.checkMergeConflicts, git.checkoutBranch, git.clone, git.commit, git.commitDetails, git.commits, git.createBranch, git.diffs, git.discard, git.fetch, git.getBranches, git.getConfig, git.getRemoteUrl, git.numstat, git.pull, git.push, git.removeLockFile, git.renameBranch, git.showFile, git.stage, git.stageHunk, git.status, git.unstage, git.unstageHunk

#### `github.*` (22 methods)

github.authStatus, github.branches.list, github.cancelAuth, github.connect, github.getReviewThreads, github.getUser, github.issues.list, github.issues.search, github.listReviewComments, github.pulls.create, github.pulls.get, github.pulls.list, github.pulls.merge, github.pulls.search, github.pulls.updateBranch, github.replyReviewComment, github.repos.get, github.repos.list, github.repos.search, github.resolveThread, github.revoke, github.unresolveThread

#### `linear.*` (11 methods)

linear.authStatus, linear.createIssue, linear.getIssue, linear.listIssues, linear.listLabels, linear.listProjects, linear.listTeams, linear.listWorkflowStates, linear.searchIssues, linear.updateIssue, linear.viewer

#### `mcp.*` (11 methods)

mcp.oauth.delete, mcp.oauth.get, mcp.oauth.list, mcp.oauth.set, mcp.servers.create, mcp.servers.delete, mcp.servers.getStatus, mcp.servers.list, mcp.servers.restart, mcp.servers.toggle, mcp.servers.update

#### `metrics.*` (4 methods)

metrics.clearAgentStats, metrics.getAgentStats, metrics.getAllWorkspaceStats, metrics.getWorkspaceStats

#### `models.*` (1 method)

models.list

#### `note.*` (18 methods)

note.add, note.create, note.delete, note.edit, note.editLines, note.get, note.getVersion, note.lineAttribution.computeNow, note.lineAttribution.load, note.list, note.listTasks, note.listVersions, note.readAsset, note.restoreVersion, note.saveAsset, note.setContent, note.update, note.updateMetadata

#### `pr.*` (13 methods)

pr.createReview, pr.getReviews, pr.listCheckRuns, pr.listComments, pr.listReviewComments, pr.merge, pr.postComment, pr.refresh, pr.replyToReviewComment, pr.resolveThread, pr.status, pr.updateBranch, pr.waitForChanges

#### `primitive.*` (4 methods)

primitive.addAgentAction, primitive.addCli, primitive.addPatch, primitive.addReference

#### `repo.*` (2 methods)

repo.list, repo.remove

#### `repoConfig.*` (4 methods)

repoConfig.ensureDir, repoConfig.get, repoConfig.has, repoConfig.save

#### `rules.*` (3 methods)

rules.get, rules.list, rules.update

#### `sandbox.*` (2 methods)

sandbox.discard, sandbox.merge

#### `script.*` (9 methods)

script.create, script.list, script.output, script.remove, script.restart, script.run, script.start, script.status, script.stop

#### `search.*` (7 methods)

search.cancel, search.codebase, search.events, search.fileNames, search.inFiles, search.messages, search.notes

#### `sentry.*` (8 methods)

sentry.assignIssue, sentry.authStatus, sentry.getIssue, sentry.ignoreIssue, sentry.listIssues, sentry.listProjects, sentry.resolveIssue, sentry.searchIssues

#### `settings.*` (4 methods)

settings.get, settings.list, settings.reset, settings.update

#### `skill.*` (1 method)

skill.list

#### `specialist.*` (5 methods)

specialist.create, specialist.delete, specialist.edit, specialist.get, specialist.list

#### `task.*` (14 methods)

task.assignAgent, task.convertBlocks, task.createPrerequisite, task.get, task.getMyTask, task.linkAgent, task.list, task.listAgentLinks, task.markAsTask, task.removeAgentFromAllTasks, task.unlinkAgent, task.update, task.updateNoteStatus, task.updateStatus

#### `terminal.*` (7 methods)

terminal.create, terminal.getBuffer, terminal.kill, terminal.list, terminal.readOutput, terminal.resize, terminal.write

#### `workspace.*` (23 methods)

workspace.archive, workspace.cleanup, workspace.create, workspace.delete, workspace.detectProjectType, workspace.dismissAttention, workspace.duplicate, workspace.findRepositories, workspace.generateSetupScript, workspace.get, workspace.getContext, workspace.getSetupScript, workspace.getTokenUsage, workspace.getUiContext, workspace.initializeRepository, workspace.list, workspace.markSeen, workspace.restore, workspace.saveSetupScript, workspace.unarchive, workspace.update, workspace.updateContext, workspace.updateUiContext

### 6.2 Fast-Path Methods (29 total)

The following 29 methods are intercepted **before** the main router for performance or to access per-connection state. They share the same JSON-RPC envelope validation but are dispatched earlier in the connection task.

browser.exec, client.hello, drafts.clear, drafts.get, drafts.set, events.subscribe, events.unsubscribe, forward.close, forward.create, forward.list, host.checkAuggie, host.checkGit, host.directoryStatus, host.env, host.exec, host.execStream, host.execStream.cancel, host.execStream.write, host.findApp, host.findBinary, host.listDirectory, host.listInstalledEditors, host.openInEditor, host.providerDiscovery, host.status, host.toolAvailability, pairing.getInfo, system.shutdown, system.status

**UDS-only method:** `system.shutdown` is only available on the Unix-domain socket transport. `system.status` is available on both UDS and WSS transports.

#### `system.status` — process resource fields (additive, optional)

The `system.status` result includes two **optional** self-process resource fields alongside the existing status payload (`running`, `listenMode`, `transports`, `port`, `clients`, `agents`, `maxAgents`, `version`, `uptimeSeconds`, `fingerprint`, `protocolVersion`, `host`):

```jsonc
{
  "cpuPercent": 12.5,        // optional — daemon process CPU usage
  "memoryBytes": 104857600   // optional — daemon process resident set size (RSS), in bytes
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- **`cpuPercent`** uses the raw `sysinfo` convention: `100` = one full core, so values **may exceed 100** on multicore systems (not normalized to total capacity). The first sample after daemon startup **may read `0`** before a usage baseline is established.
- **`memoryBytes`** is the daemon process RSS in bytes.
- Both fields are **additive and optional**; clients must tolerate their absence and degrade gracefully.
- **Versioning:** these fields shipped within protocol **v2.0** — the daemon still advertises `protocolVersion: "2.0"`. They add optional response fields to an existing method without changing the method surface (the golden-test-enforced catalog is unchanged), so no version bump was made; clients must detect them by **presence**, not by protocol version.

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

### 6.3 Method Aliases (2 total)

The daemon accepts these 2 alias forms and dispatches them to their canonical counterparts. The wire accepts both, but the canonical name is the documented form.

- **`git.diff`** → `git.diffs`
- **`git.log`** → `git.commits`

### 6.4 Server→Client Notifications (1 total)

The daemon sends the following notification (unsolicited, no request `id`) to connected clients:

- **`events.event`** — event notification envelope (see §7)

### 6.5 Client-Served Reverse RPCs (4 total)

These methods are client-callable triggers whose real work happens on the connected frontend. The daemon validates the envelope, then dispatches a reverse RPC back to the client with a synthetic `rev-<n>` request id and echoes the client's result back to the original caller.

These 4 method names are **dual-role**: they appear in the dispatchable method catalog (§6.1 or §6.2) AND are also issued daemon→client as reverse RPCs on remote connections.

- **`browser.exec`** — browser automation (Chrome DevTools)
- **`host.openExternal`** — open a URL in the default browser
- **`host.openInEditor`** — open a file or directory in the user's editor
- **`host.pickApplication`** — prompt the user to select an application

---

### 6.6 Interrupted-Agent Resumption (v2.0 additions)

The following methods manage agent resumption across daemon restarts. When `intentd` restarts, in-flight agent sessions (`active`, `processing`, `waiting` statuses) are captured as **interrupted records** before the heal sweep rewrites them to `idle`. This capture occurs on both graceful shutdown (`SIGINT`/`SIGTERM`) and crash scenarios, ensuring that agents mid-turn are always resumable. Clients discover interrupted agents via `agent.listInterrupted` and resolve them via `agent.resolveInterrupted` (resume or abandon). For headless deployments, `intentd serve --resume-all` auto-resumes all interrupted agents at startup.

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

#### Queued-Message Preservation

**Queues survive restarts.** The per-agent send queue (`agent.queueMessage` / `agent.getQueue`) is persisted write-through to the `agent_queue` SQLite table: every enqueue, edit, remove, and drain mutation of the in-memory queue is mirrored to the store, so both graceful shutdowns and crashes preserve queued messages. At daemon startup, persisted queues are rehydrated into memory before RPCs are served. Rehydration alone never starts a turn; entries mid-edit at shutdown are restored as ready-to-send (`editing: false`), and attachment blocks plus metadata round-trip intact.

**Resume ordering contract:** When an interrupted agent is resumed — via `agent.resolveInterrupted { resume }` or `serve --resume-all` — the continuation message streams **first**; the preserved queue then drains FIFO in original order after that turn completes. Abandoning an interrupted agent leaves its preserved queue intact and inert (no auto-send); entries remain visible via `agent.getQueue` and removable via `agent.removeQueuedMessage`.

No RPC surface changes: `agent.getQueue`, `agent:queue:updated`, and the edit/remove/drain flows operate on the in-memory map, which is now durable.

#### Delegation-Group Persistence

**`after_all` groups survive restarts.** When a parent delegates children with `waitMode: "after_all"`, the delegation group is persisted in the `delegation_group` SQLite table. At daemon startup, the heal sweep rehydrates all sealed groups and re-registers the aggregated-wake delivery watch. Resumed grouped children automatically re-enroll in their persisted group; when all children complete, the daemon delivers exactly one aggregated wake to the parent containing all children's reports.

**Durable-before-observable:** Child completions are recorded durably in `delegation_group` **before** the `agent:idle` event publishes. A daemon kill between completion and event delivery cannot lose completion state — the resumed child's completion is already persisted when the daemon restarts.

**Group-wake format:** The aggregated wake is a single agent turn delivered to the parent, containing a `[WORKSPACE EVENTS]` summary block listing all children's completion reports. Each child's report line: `**{child_name}** (agent-{id}) completed. Report: {completion_report_text}`. After delivery, the group row is pruned.

#### `serve --resume-all` CLI Flag

`intentd serve --resume-all` is a headless deployment flag that automatically resumes all interrupted agents at startup without waiting for `agent.resolveInterrupted` RPC.

**Execution:** After the daemon is fully up (services wired, event bus live, RPC servers listening), a background task enumerates `agent.listInterrupted` and calls the resume service operation for each pending agent. Per-agent failures are logged (warning-level) and do not crash the daemon or block startup.

**Non-blocking:** The auto-resume sweep is spawned asynchronously; the daemon is ready to serve RPCs before the sweep completes.

**Logged output:**
- `INFO`: `--resume-all: enumerating interrupted agents`
- `INFO`: `--resume-all: resuming interrupted agents` (with `count` field)
- `INFO`: `--resume-all: resumed agent` (per success; includes `agent_id`, `workspace`)
- `WARN`: `--resume-all: failed to resume agent` (per failure; includes `agent_id`, `error`)
- `INFO`: `--resume-all: auto-resume sweep complete` (with `resumed`, `failed` counts)

After the sweep completes, `agent.listInterrupted` returns an empty list.

### 6.7 `models.list` Per-Provider Catalog (v2.0 additions)

`models.list` (§5.30 of the porting-era protocol, `docs/00_initial_porting/PROTOCOL.md`) accepts two additive **optional** parameters. With both omitted the required keys of the ported contract are unchanged: the auggie catalog (`auggie model list --json` → plain-text fallback → static `PROVIDER_MODEL_TIERS` catalog), returning `{ models: ModelInfo[], source: "auggie" | "static" }` and no `workspaceId` — though the optional `stale` / `warning` fields may now appear on probe-failure degradation (see the legacy-path bullet below).

**Request:**

```jsonc
{
  "providerId": "auggie",  // optional — per-provider catalog via the generic cache
  "forceRefresh": false    // optional, default false — skip the cache read, await a fresh probe
}
```

**Response (with `providerId`):**

```jsonc
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
- **`forceRefresh: true`** skips the cache read, awaits a fresh probe, and stores the result on success. On failure it returns the **last-good** list labeled `stale: true` plus a `warning` — stale data is never served silently.
- **Non-forced reads** within the TTL serve the cache; expired reads await a fresh probe (no stale-while-revalidate) with the same last-good + `warning` fallback on failure.
- **Probe guards.** Concurrent probes for the same provider are single-flighted (one spawn, shared result), and a failed probe is negatively cached for **60 seconds**: non-forced reads within the window serve the failed probe's degradation (static/stale) without re-probing; `forceRefresh` bypasses the negative entry.
- **Registered sources:** seven providers are registered — `auggie` (CLI discovery, as above); `cortex` (feature-code-gated; when gated it returns an empty list + `warning` under `source: "cortex"`); `claude-code`, `codex`, `pi`, and `droid` (live ACP adapter probes); and `opencode` (native CLI discovery). Version keys are per-provider (e.g. the claude-code/codex/pi adapter version pins); the registry is designed for further providers to be added.
- **Unknown/unregistered `providerId`** degrades to that provider's static tier rows (empty when it has none) with `source: "static"` and a `warning` — never an error, so model pickers keep working.
- **Legacy path.** Without `providerId`, the response omits the `providerId` field (legacy shape) but follows the same cache semantics as `providerId: "auggie"`: within the TTL the cache is served; on a failed probe the last-good list is served labeled `stale: true` + `warning` (forced or not), falling back to the static catalog (`{ models, source: "static" }`, exactly those keys) only when no last-good list exists. Because the cache is persisted, last-good entries survive daemon restarts on this path too.
- **Errors:** `-32603` only on internal failure; probe/CLI failures degrade as described above.

---

## 7. Events & Subscriptions

Clients subscribe to events via the **`events.subscribe`** method (fast-path, not routed). The server sends matching events as **`events.event`** notifications (no request `id`).

### 7.1 `events.subscribe`

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "events.subscribe",
  "params": {
    "eventTypes": ["agent:*", "workspace:*"],
    "workspaceId": "ws-abc",
    "excludeSelf": true,
    "batchWindow": 500
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 100,
  "result": {
    "subscriptionId": "sub-xyz",
    "eventTypes": ["agent:*", "workspace:*"]
  }
}
```

- `eventTypes` (required): array of event type patterns (e.g., `"agent:*"`, `"file:*"`, `"workspace:created"`)
- `excludeSelf` (optional, default `true`): filter out events caused by this connection
- `batchWindow` (optional, default `500`ms): batch events within this window

Subscriptions are **per-connection** and do **not** survive reconnects. On disconnect, the server cleans up all subscriptions for that connection.

### 7.2 `events.unsubscribe`

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "events.unsubscribe",
  "params": {
    "subscriptionId": "sub-xyz"
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "result": {
    "ok": true,
    "subscriptionId": "sub-xyz"
  }
}
```

### 7.3 `events.event` Notification

The daemon sends **`events.event`** notifications (no request `id`) to subscribed clients:

```json
{
  "jsonrpc": "2.0",
  "method": "events.event",
  "params": {
    "subscriptionId": "sub-xyz",
    "event": {
      "type": "agent:created",
      "workspaceId": "ws-abc",
      "id": "evt-123",
      "timestamp": "2026-07-14T12:00:00.000Z",
      "actor": {
        "type": "agent",
        "id": "agent-456"
      },
      "data": {
        "agentId": "agent-456",
        "name": "New Agent"
      }
    }
  }
}
```

- `subscriptionId`: the ID returned by `events.subscribe`
- `event`: the event payload
  - `type`: event type (e.g., `"agent:created"`, `"workspace:updated"`, `"note:changed"`)
  - `workspaceId`: workspace the event belongs to (empty string for global events)
  - `id`: unique event ID
  - `timestamp`: ISO 8601 timestamp
  - `actor`: who/what caused the event (`{ type: "user" | "agent" | "system", id?: string }`)
  - `data`: event-specific payload

### 7.4 Event Type Taxonomy

Event types follow the pattern `<category>:<action>`. Common categories:

- **`agent:*`** — agent lifecycle (created, updated, renamed, deleted, idle, stream:*, failed, etc.)
- **`workspace:*`** — workspace changes (created, updated, deleted, activity-changed, attention-changed, etc.)
- **`note:*`** — note mutations (created, updated, changed, deleted, etc.)
- **`task:*`** — task updates (status-changed, agent-linked, agent-unlinked, etc.)
- **`file:*`** — file system changes (created, modified, deleted, etc.)
- **`git:*`** — git operations (commit, stage, push, pull, clone:progress, clone:done, etc.)
- **`terminal:*`** — terminal activity (created, output, closed, etc.)
- **`comment:*`** — comment lifecycle (added, resolved, deleted, etc.)
- **`pr:*`** — pull request events (created, merged, checks-updated, etc.)
- **`search:*`** — search results (result, done, etc.)
- **`sandbox:*`** — sandbox lifecycle (created, merged, etc.)
- **`mcp:*`** — MCP server status changes (status-changed, etc.)
- **`spec:*`** — spec note events
- **`goal:*`** — goal tracking events
- **`github:*`** — GitHub auth surface: `github:auth-changed` carries `data = { status: "authorized" | "expired" | "denied" | "error" | "revoked" }` on device-flow terminal transitions and `github.revoke`; global (empty `workspaceId`), never carries a token or code

### 7.5 Interrupted Partial-Turn Persistence

On a **user interrupt** of an in-flight turn — `agent.stop`, `agent.forceMessage`, or `agent.sendMessage` / `agent.sendToTask` with `priority: "interrupt"` — the daemon persists the streamed-so-far partial assistant message **before** emitting the terminal `agent:stream:end`. The partial turn's content blocks are written to the transcript under the assistant `messageId` minted at turn start (the same id carried by the live `agent:stream:chunk` events, and from which the `chat.subscribe` synthetic block ids are derived as `{messageId}:{blockIndex}` — §7.1 of the porting-era protocol), tagged on the message row with:

- `metadata.interrupted: true`
- `metadata.stopReason: "interrupted"`

This is the same convention as the graceful-shutdown flush of an in-flight turn. The flush is a no-op when the partial has no content blocks (nothing streamed yet).

**Consequence for `chat.subscribe` (the terminal reconcile of §7.1 in the porting-era protocol, `docs/00_initial_porting/PROTOCOL.md`):** because the partial assistant row is persisted before `agent:stream:end`, the channel's terminal reconcile re-reads a transcript that **contains** the streamed message — the streamed blocks are re-emitted as authoritative `updated` entries and are **not** wiped via `removedIds`. Clients keep the partial output visible and may render an interrupted/"Stopped" indicator from `metadata.interrupted` / `metadata.stopReason` on the persisted row (also visible via `agent.getConversation`). On an interrupt-priority send, the interrupted partial row precedes the new user message in the transcript.

Added in [intent-hq/intentd#336](https://github.com/intent-hq/intentd/pull/336); no method-surface change (additive persistence semantics within protocol v2.0).

---

## 8. Error Codes

The daemon uses the following JSON-RPC 2.0 error codes:

| Code | Meaning | Description |
|------|---------|-------------|
| `-32700` | Parse error | Invalid JSON was received by the server. |
| `-32600` | Invalid Request | The JSON sent is not a valid Request object. |
| `-32601` | Method not found | The method does not exist / is not available. |
| `-32602` | Invalid params | Invalid method parameter(s). The `message` field provides details (e.g., `"Missing required parameter: noteId"`). |
| `-32603` | Internal error | Internal JSON-RPC error. The `error.data` field may carry the original internal error message. |

**Domain-specific errors** (e.g., "workspace not found", "agent already running") return `-32603` with a descriptive `message` rather than custom error codes. The `message` field is the canonical error text; clients should display it to users.

---

## Summary

**Protocol v2.0** exposes **293 dispatchable method names** (262 router methods + 29 fast-path methods + 2 aliases) and **1 notification** (`events.event`). The protocol also defines **4 reverse RPCs** (`browser.exec`, `host.openExternal`, `host.openInEditor`, `host.pickApplication`) — these 4 names are dual-role: they are counted within the 293 dispatchable names AND are also issued daemon→client on remote connections.

The method surface is frozen and enforced by golden tests in `crates/intent-transport/src/catalog.rs`. Any drift causes CI failure with the instruction to update the catalog, this document, and bump the protocol version.

For implementation details and per-method signatures, see the source code in `crates/intent-transport/src/router.rs` and the fast-path modules (`client.rs`, `events.rs`, `drafts.rs`, `browser.rs`, `forward.rs`, `host.rs`, `control.rs`, `pairing.rs`).
