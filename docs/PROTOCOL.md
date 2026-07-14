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
7. [Events & Subscriptions](#7-events--subscriptions)
8. [Error Codes](#8-error-codes)

---

## 1. Protocol Version & Compatibility

**Version:** `2.0`

The protocol version is advertised in two places:

- **`client.hello`** response: `{ server: { protocolVersion: "2.0", ... }, ... }`
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

---

## 6. Method Catalog

The API exposes **280 dispatchable method names** across the following categories:

- **Router methods:** 251 methods dispatched via the main router (`router::dispatch`)
- **Fast-path methods:** 27 methods intercepted before the router for performance or per-connection state
- **Method aliases:** 2 aliases accepted on the wire (`git.diff` → `git.diffs`, `git.log` → `git.commits`)

Additionally, the protocol includes:

- **Server→client notifications:** 1 notification (`events.event`)
- **Client-served reverse RPCs:** 4 methods (dual-role, counted within the 280 dispatchable names: `browser.exec`, `host.openExternal`, `host.openInEditor`, `host.pickApplication`)

**Total:** 280 dispatchable names + 1 notification. The 4 reverse-RPC names are dual-role: they are dispatchable client→server methods AND are also issued daemon→client as reverse RPCs on remote connections.

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields `-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires `workspaceId` (see §4.6) and may return `-32603 Internal error` if the underlying service throws.

### 6.1 Router Methods (251 total)

The following 251 methods are routed through the main dispatch match in `router.rs`.

#### `agent.*` (35 methods)

agent.appendMessage, agent.cancelSubscriptions, agent.completeOnce, agent.create, agent.delegate, agent.delete, agent.diagnostics, agent.editQueuedMessage, agent.enhancePrompt, agent.forceMessage, agent.get, agent.getConversation, agent.getModels, agent.getQueue, agent.getSession, agent.getSessionStats, agent.getSubscriptions, agent.list, agent.pendingPermissions, agent.queueMessage, agent.removeQueuedMessage, agent.rename, agent.replaceMessages, agent.reportToParent, agent.respondPermission, agent.retry, agent.sendMessage, agent.sendToTask, agent.setModel, agent.stop, agent.subscribe, agent.summary, agent.unsubscribe, agent.update, agent.wakeOrCreate

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

#### `github.*` (21 methods)

github.authStatus, github.branches.list, github.connect, github.getReviewThreads, github.getUser, github.issues.list, github.issues.search, github.listReviewComments, github.pulls.create, github.pulls.get, github.pulls.list, github.pulls.merge, github.pulls.search, github.pulls.updateBranch, github.replyReviewComment, github.repos.get, github.repos.list, github.repos.search, github.resolveThread, github.revoke, github.unresolveThread

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

#### `pr.*` (12 methods)

pr.createReview, pr.getReviews, pr.listCheckRuns, pr.listComments, pr.listReviewComments, pr.merge, pr.postComment, pr.replyToReviewComment, pr.resolveThread, pr.status, pr.updateBranch, pr.waitForChanges

#### `primitive.*` (4 methods)

primitive.addAgentAction, primitive.addCli, primitive.addPatch, primitive.addReference

#### `repo.*` (2 methods)

repo.list, repo.remove

#### `rules.*` (3 methods)

rules.get, rules.list, rules.update

#### `sandbox.*` (2 methods)

sandbox.discard, sandbox.merge

#### `script.*` (9 methods)

script.create, script.list, script.output, script.remove, script.restart, script.run, script.start, script.status, script.stop

#### `search.*` (8 methods)

search.cancel, search.codebase, search.events, search.fileNames, search.inFiles, search.memories, search.messages, search.notes

#### `sentry.*` (8 methods)

sentry.assignIssue, sentry.authStatus, sentry.getIssue, sentry.ignoreIssue, sentry.listIssues, sentry.listProjects, sentry.resolveIssue, sentry.searchIssues

#### `settings.*` (4 methods)

settings.get, settings.list, settings.reset, settings.update

#### `specialist.*` (5 methods)

specialist.create, specialist.delete, specialist.edit, specialist.get, specialist.list

#### `task.*` (14 methods)

task.assignAgent, task.convertBlocks, task.createPrerequisite, task.get, task.getMyTask, task.linkAgent, task.list, task.listAgentLinks, task.markAsTask, task.removeAgentFromAllTasks, task.unlinkAgent, task.update, task.updateNoteStatus, task.updateStatus

#### `terminal.*` (7 methods)

terminal.create, terminal.getBuffer, terminal.kill, terminal.list, terminal.readOutput, terminal.resize, terminal.write

#### `workspace.*` (21 methods)

workspace.archive, workspace.cleanup, workspace.create, workspace.delete, workspace.detectProjectType, workspace.dismissAttention, workspace.duplicate, workspace.findRepositories, workspace.generateSetupScript, workspace.get, workspace.getContext, workspace.getSetupScript, workspace.getTokenUsage, workspace.initializeRepository, workspace.list, workspace.markSeen, workspace.restore, workspace.saveSetupScript, workspace.unarchive, workspace.update, workspace.updateContext

### 6.2 Fast-Path Methods (27 total)

The following 27 methods are intercepted **before** the main router for performance or to access per-connection state. They share the same JSON-RPC envelope validation but are dispatched earlier in the connection task.

browser.exec, client.hello, drafts.clear, drafts.get, drafts.set, events.subscribe, events.unsubscribe, forward.close, forward.create, forward.list, host.checkAuggie, host.checkGit, host.directoryStatus, host.env, host.exec, host.execStream, host.execStream.cancel, host.execStream.write, host.findApp, host.findBinary, host.listDirectory, host.listInstalledEditors, host.openInEditor, host.status, host.toolAvailability, system.shutdown, system.status

**UDS-only methods:** `system.shutdown` and `system.status` are only available on the Unix-domain socket transport.

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

**Protocol v2.0** exposes **280 dispatchable method names** (251 router methods + 27 fast-path methods + 2 aliases) and **1 notification** (`events.event`). The protocol also defines **4 reverse RPCs** (`browser.exec`, `host.openExternal`, `host.openInEditor`, `host.pickApplication`) — these 4 names are dual-role: they are counted within the 280 dispatchable names AND are also issued daemon→client on remote connections.

The method surface is frozen and enforced by golden tests in `crates/intent-transport/src/catalog.rs`. Any drift causes CI failure with the instruction to update the catalog, this document, and bump the protocol version.

For implementation details and per-method signatures, see the source code in `crates/intent-transport/src/router.rs` and the fast-path modules (`client.rs`, `events.rs`, `drafts.rs`, `browser.rs`, `forward.rs`, `host.rs`, `control.rs`).
