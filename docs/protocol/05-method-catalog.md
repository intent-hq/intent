> Part of the [Intent JSON-RPC protocol docs](./README.md) — §5 Method Catalog.

## 5. Method Catalog

The API exposes **335 dispatchable method names** across the following categories:

- **Router methods:** 296 methods dispatched via the main router (`router::dispatch`)
- **Fast-path methods:** 37 methods intercepted before the router for performance or per-connection state
- **Method aliases:** 2 aliases accepted on the wire (`git.diff` → `git.diffs`, `git.log` → `git.commits`)

Additionally, the protocol includes:

- **Server→client notifications:** 1 notification (`events.event`, §6.3), plus the `subscription.push` frames of the snapshot+delta channels (§6.9)
- **Client-served reverse RPCs:** 4 methods total — 2 are **dual-role** and counted within the 335 dispatchable names (`browser.exec`, `host.openInEditor`), and 2 are **daemon→client-only** reverse RPCs not in the dispatchable catalog (`host.openExternal`, `host.pickApplication`) — see §5.9 and §5.14

**Total:** 335 dispatchable names + 1 notification. Of the 4 reverse-RPC names, 2 (`browser.exec`, `host.openInEditor`) are dual-role — dispatchable client→server methods that are also issued daemon→client as reverse RPCs on remote connections — and 2 (`host.openExternal`, `host.pickApplication`) are daemon→client-only reverse RPCs, never dispatched client→server.

The method surface is enforced by the golden tests in `crates/intent-transport/src/catalog.rs`; the per-namespace subsections below (§5.1–§5.43) carry each method's parameter and result contract.

### Router methods by namespace (296 total)

| Namespace | Count | Methods |
| --- | --- | --- |
| agent | 44 | appendMessage, cancelDelete, cancelSubscriptions, completeOnce, create, delegate, delete, diagnostics, dismissQuestions, editAndRegenerate, editQueuedMessage, enhancePrompt, get, getConversation, getMessageBlock, getModels, getQueue, getSession, getSessionStats, getSubscriptions, list, listActive, listInterrupted, listUserMessages, markSeen, pendingPermissions, queueMessage, removeQueuedMessage, rename, replaceMessages, reportToParent, resolveInterrupted, respondPermission, retry, sendMessage, sendQueuedMessageNow, sendToTask, setModel, stop, subscribe, summary, unsubscribe, update, wakeOrCreate |
| comment | 6 | add, delete, getThread, list, resolveThread, respond |
| crossWorkspace | 3 | listNotes, listSiblings, readNote |
| debug | 1 | sampleStacks — point-in-time sample of the daemon's own thread stacks rendered as a text report (§5.43; v6.3, daemon-global — no `workspaceId`) |
| event | 3 | agentActivity, query, workspaceSummary |
| file | 16 | attachmentUpload.abort, attachmentUpload.begin, attachmentUpload.chunk, attachmentUpload.commit, delete, exists, getAttachmentInfo, list, mkdir, placeAttachment, read, readChunk, rename, stat, tree, write |
| git | 28 | agentCommit, branchDiff, branchStatus, changes, checkMergeConflicts, checkoutBranch, clone, commit, commitDetails, commits, createBranch, diffs, discard, fetch, getBranches, getConfig, getRemoteUrl, numstat, pull, push, removeLockFile, renameBranch, showFile, stage, stageHunk, status, unstage, unstageHunk |
| gitRoot | 1 | list — the workspace's registered secondary git roots (§5.6; v6.15, `workspaceId` req). No wire register/unregister method: registration is MCP-only (`ws.git.registerRoot` / `ws.git.unregisterRoot`), per the §6.8 principle |
| github | 24 | authStatus, branches.list, branches.listCached, cancelAuth, connect, getReviewThreads, getUser, issues.list, issues.search, listReviewComments, pulls.create, pulls.get, pulls.list, pulls.merge, pulls.search, pulls.updateBranch, replyReviewComment, repoConfig.get, repos.get, repos.list, repos.search, resolveThread, revoke, unresolveThread |
| hook | 3 | cancel, list, runNow — background-hook management (§5.40; v2.10). No `hook.schedule` on the wire: scheduling is MCP-only (`ws.hook.schedule`), per the §6.8 principle |
| linear | 11 | authStatus, createIssue, getIssue, listIssues, listLabels, listProjects, listTeams, listWorkflowStates, searchIssues, updateIssue, viewer |
| mcp | 12 | oauth.delete, oauth.get, oauth.list, oauth.set, servers.create, servers.delete, servers.getStatus, servers.list, servers.restart, servers.toggle, servers.update, testConnection |
| metrics | 4 | clearAgentStats, getAgentStats, getAllWorkspaceStats, getWorkspaceStats |
| models | 1 | list |
| note | 18 | add, create, delete, edit, editLines, get, getVersion, lineAttribution.computeNow, lineAttribution.load, list, listTasks, listVersions, readAsset, restoreVersion, saveAsset, setContent, update, updateMetadata |
| pr | 2 | refresh, status — the 11 other `pr.*` methods were removed in v5.0 (§5.7) |
| prMonitor | 3 | list, cancel, flush — the FE surface over centralized PR monitors (§5.42; v6.1). No wire registration method: monitors are agent-owned via the MCP `ws.pr.monitor` binding only, per the §6.8 principle (like `hook.*` vs `ws.hook.schedule`) |
| primitive | 4 | addAgentAction, addCli, addPatch, addReference |
| providers | 1 | catalog — the static provider registry served over the wire (§5.38; v2.6, daemon-global — no `workspaceId`) |
| repo | 3 | list, remove, warmCache — opportunistic background repo-cache refresh for one GitHub repo (§5.11; v6.10, daemon-global — no `workspaceId`) |
| repoConfig | 4 | ensureDir, get, has, save |
| rules | 3 | get, list, update |
| sandbox | 2 | discard, merge |
| script | 9 | create, list, output, remove, restart, run, start, status, stop |
| search | 7 | cancel, codebase, events, fileNames, inFiles, messages, notes |
| sentry | 8 | assignIssue, authStatus, getIssue, ignoreIssue, listIssues, listProjects, resolveIssue, searchIssues |
| settings | 4 | get, list, reset, update |
| skill | 1 | list |
| specialist | 5 | create, delete, edit, get, list |
| stats | 2 | getRateHistory (§5.39; v2.9, daemon-global — no `workspaceId`), getUsage |
| system (router) | 1 | capabilities — machine-level capabilities, no workspaceId; distinct from the `system.*` fast-path controls below (v2.3, see the note after the fast-path catalog) |
| task | 15 | assignAgent, convertBlocks, createPrerequisite, get, getMyTask, linkAgent, list, listAgentLinks, markAsTask, removeAgentFromAllTasks, setRelations, unlinkAgent, update, updateNoteStatus, updateStatus |
| terminal | 7 | create, getBuffer, kill, list, readOutput, resize, write |
| unsloth | 2 | status, stop — observe / gracefully stop the daemon-managed singleton Unsloth server (§5.37; v2.5, daemon-global — no `workspaceId`) |
| voice | 2 | getWorkspaceVocabulary — the auto-derived per-workspace vocabulary served for client-side transcription engines (§5.41; v5.1, `workspaceId` req), transcribe — daemon-owned speech-to-text via the configured provider (§5.41; v4.3, daemon-global — no required `workspaceId`; optional `workspaceId?` workspace-vocabulary injection since v5.1) |
| workspace | 36 | archive, cancelDelete, cleanup, create, delete, detectProjectType, diskUsage, dismissAttention, duplicate, export.abort, export.finalize, export.read, export.start, findRepositories, generateSetupScript, get, getAutoCommit, getContext, getSetupScript, getTokenUsage, getUiContext, import.abort, import.begin, import.chunk, import.commit, initializeRepository, list, markSeen, restore, saveSetupScript, setAutoCommit, transfer.plan, unarchive, update, updateContext, updateUiContext |

Namespaces without their own numbered subsection below (`accept-changes.*`, `file-tracking.*`, `drafts.*`, `forward.*`, `host.*`) are covered in §5.14–§5.20; `browser.exec` is in §5.9.

### Fast-path methods (37 total)

The following 37 methods are intercepted **before** the main router for performance or to access per-connection state. They share the same JSON-RPC envelope validation but are dispatched earlier in the connection task.

browser.exec, client.hello, drafts.clear, drafts.get, drafts.set, events.subscribe, events.unsubscribe, forward.close, forward.create, forward.list, host.checkAuggie, host.checkGh, host.checkGit, host.checkNode, host.createDirectory, host.directoryStatus, host.env, host.exec, host.execStream, host.execStream.cancel, host.execStream.write, host.findApp, host.findBinary, host.listDirectory, host.listInstalledEditors, host.openInEditor, host.providerAuthStatus, host.providerDiscovery, host.status, host.toolAvailability, pairing.getInfo, server.pairingInfo, server.rotateToken, system.gitCredential, system.importLegacy, system.shutdown, system.status

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

#### `system.status` — child-process tree fields (additive, v6.13)

The `system.status` result additionally reports the daemon's **whole descendant process tree** — the cost `memoryBytes` above does not capture:

```jsonc
{
  "childProcesses": 24,                // process count in the daemon's descendant tree; null until first sample
  "childMemoryBytes": 5090787328,      // aggregate RSS of those processes, in bytes; null until first sample
  "childMemoryPeakBytes": 23085449216  // high-water mark of the daemon's sampled tree memory since daemon start; null until first sample
  // ...existing status fields (cpuPercent, memoryBytes, running, listenMode, ...)
}
```

- `childProcesses` counts the OS processes in the daemon's descendant tree: agent provider CLIs and everything they spawn (ACP adapters, MCP bridges, an agent's own tool children), the Unsloth server, and `host.exec` children.
- `childMemoryBytes` is the aggregate resident memory of those processes. This is the daemon's real cost to the machine; the existing `memoryBytes` covers only the daemon binary and understates it by more than an order of magnitude once agents are live (measured on a dev seat: a 183 MB daemon owning a 21.5 GB tree). A client cannot attribute system memory pressure to agents without it.
- `childMemoryPeakBytes` is the high-water mark of the daemon's **sampled** descendant-tree memory since daemon start. It is **not** simply the maximum of the `childMemoryBytes` values a client has seen: the tree is swept every **500 ms** while an ephemeral ACP adapter chain holds a slot in the daemon-wide adapter bound (`agents.maxConcurrentAdapters`, §5.12) — one-shot `agent.completeOnce` on ACP providers, and model probes — against the 5 s cadence `childProcesses` / `childMemoryBytes` are published at, so **the peak can legitimately exceed every instantaneous value ever published**. That is deliberate: those chains live only seconds, so by the time a debug bundle is captured the instantaneous value has drained back to baseline (intentd#1139, monorepo#2107; fast cadence introduced by [intent-hq/intentd#1167](https://github.com/intent-hq/intentd/pull/1167) — measured, a 16-chain burst peaked at 6.97 GB while `childMemoryBytes` read 0 at every published sample).
- The fast cadence applies **only** to descendants spawned through the ephemeral-adapter bound — the one-shot ACP runner and the model probe. Everything else in the tree — the **auggie** route of the same quick actions (it spawns its CLI directly and takes no slot), `host.exec` children, PTY sessions, MCP bridge servers, the Unsloth server, and the tool children a long-lived agent runs — is sampled at the 5 s baseline only, so a burst from one of those that spikes and drains inside one baseline interval may not appear in the peak.
- The tree's baseline sampling cadence is **5s**. All three keys are always present on the wire and are `null` — never `0` — until the first sample lands (~5s after daemon start); `0` is a real measurement meaning an empty tree. Clients must detect them by **presence**, not by protocol version.

#### `system.status` — aggregate memory budget fields (additive)

When the aggregate agent memory budget is on (`agents.memoryBudgetMb` > 0, §5.12; [intent-hq/monorepo#2063](https://github.com/intent-hq/monorepo/issues/2063)), the `system.status` result additionally reports the budget's live admission state:

```jsonc
{
  "agentMemoryBudgetBytes": 21474836480, // installed budget (agents.memoryBudgetMb, in bytes)
  "agentMemoryChargedBytes": 3221225472, // what admission actually compares: last tree sample + pending correction
  "queuedSpawns": 1                      // spawns currently queued behind the admission gate
  // ...existing status fields (childMemoryBytes, running, listenMode, ...)
}
```

- `agentMemoryBudgetBytes` is the installed budget in bytes.
- `agentMemoryChargedBytes` is the byte count admission actually compares against the budget: the last descendant-tree memory sample **plus the provisional correction** for spawns admitted / processes released since that sample was taken — not the raw `childMemoryBytes` value, which lags the truth by up to one sampling period. It is additionally **absent while the budget is on but no tree sample has landed yet** (~5s after daemon start): the budget is inert until the first sample, and the field says so by omission.
- `queuedSpawns` counts the agent spawns currently parked in the admission wait queue — whether they queued on the concurrency slot cap or on the memory budget. `0` means nothing is waiting.
- Unlike the child-tree fields above (always present, `null` until sampled), all three follow the **presence-detection convention**: when the budget is off (`agents.memoryBudgetMb = 0`, the default) they are **absent** — never `null`. Reading them never perturbs admission state. Additive response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version.

#### `system.status` — workspaces-root disk fields (additive)

The `system.status` result additionally reports the disk space of the **volume containing the daemon's resolved workspaces root** — the parent directory `workspace.create` provisions new checkouts under, resolved with the create path's precedence: startup-pinned `workspaces.root` (`INTENTD_WORKSPACES_DIR`) wins, then a non-empty absolute `workspace.worktreesLocation` setting, then the `~/intent/workspaces` default (resolved once at boot; a `worktreesLocation` change applies on restart) — so a client can warn when workspace provisioning is about to run out of space:

```jsonc
{
  "workspacesDiskAvailableBytes": 250790436864, // available bytes on the workspaces-root volume
  "workspacesDiskTotalBytes": 994662584320      // total bytes of that volume
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- The values describe the **mounted volume** containing the workspaces root (longest-mount-point match against the canonicalized root), not the directory's own usage — the same numbers `df` reports for that path.
- Served from a background sampler (~30s cadence, first sample taken synchronously at startup), so the status read path never touches the OS; a large delete or download may take one refresh interval to appear.
- Both fields follow the **presence-detection convention**: **absent** — never `null` or `0` — until the sampler's first sample lands, or when no mounted volume matches the root (e.g. an empty disks list in a locked-down container, or an unmounted drive letter on Windows; a merely not-yet-created root still matches its would-be volume, so absence does **not** imply the directory is missing). Additive response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version.

#### `system.status` — daemon routing fields (additive)

The `system.status` result also includes two **additive** routing fields so an authenticated client — including a **remote WSS** caller — can discover every route to the daemon and the host's name without the local-only `server.pairingInfo` / `pairing.getInfo` methods:

```jsonc
{
  "localIps": ["192.168.1.10", "10.0.0.5"], // non-loopback IPv4 addresses (same source as server.pairingInfo)
  "hostname": "studio.local",               // local OS hostname
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- `localIps` lists the host's non-loopback IPv4 addresses (virtual/container interfaces skipped) — the same list `server.pairingInfo` returns. It may be **empty** on a host with no routable interface, but is always an array, never `null`. The daemon serves it from a background-refreshed cache (~15s TTL), so a freshly changed interface list may take one refresh interval to appear.
- `hostname` is the local OS hostname (falls back to `intent` when unresolvable), matching `server.pairingInfo` / `host.status`.
- Both fields are **additive** response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version. Rationale: the caller already holds the bearer token, so serving the listen addresses on `system.status` lets a remote client (e.g. the iOS app) refresh its stored alternative routes for reconnect racing on every successful connect, while `server.pairingInfo` / `pairing.getInfo` (which also carry the token and cert fingerprint) stay local-only.

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
- Hosts, TLS fingerprint, and bearer token come from the same sources as `intentd pair`, so all pairing surfaces stay consistent.
- **Local-only:** the payload embeds the long-lived bearer token, so remote (TCP/WSS) callers are rejected with `-32001` regardless of locality flags. Call it over UDS.
- Errors with a descriptive message when the TCP (WSS) listener is not running (no port to pair against) or when no non-loopback IPv4 address is available. The listener-down failure carries the machine-readable discriminator `error.data = { "code": "listener-down" }` on the otherwise-unchanged `-32603` envelope ([intent-hq/intentd#1065](https://github.com/intent-hq/intentd/pull/1065); monorepo#1822) — clients (e.g. the `intentd pair` auto-enable flow) match `error.data.code` first and keep the message-prose match only as a fallback for older daemons that predate the discriminator. The no-address failure keeps its plain descriptive message.

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

#### `host.checkAuggie`

Resolves the auggie CLI on the daemon host. **Resolution-only** ([intent-hq/intentd#977](https://github.com/intent-hq/intentd/pull/977)): no `--version` spawn and no `version` field.

**Request:** `{}` (no parameters)

**Response:**

```json
{ "available": true, "path": "/Users/me/.local/bin/auggie" }
```

- `available` is `true` **iff** a path resolved; `path` accompanies it and is **omitted** when `available` is `false`.
- Resolution precedence is unchanged: the `context.auggiePath` setting (accepted when it is an existing file or symlink) → `providers.paths.auggie` → auggie auto-detection. Because nothing is executed, `available: true` means "the binary is where we would launch it from", not "the binary runs" — readiness and auth are separate concerns served by `host.providerDiscovery` and `host.providerAuthStatus` below.

#### `host.checkGit` / `host.checkNode` / `host.checkGh` *(checkNode/checkGh: v6.4)*

Detects the `git` / `node` / `gh` binary on the daemon host: PATH resolution (plus OS-common install dirs) followed by a `<path> --version` probe on a blocking thread.

**Request:** `{}` (no parameters)

**Response:**

```json
{ "available": true, "version": "2.43.0", "path": "/usr/bin/git" }
```

- `available` is `true` **iff** a path resolved **and** the `--version` probe answered — a resolved binary that fails the probe reads as `{ "available": false }` (never an RPC error). `version` (trimmed probe output) and `path` accompany `available: true` and are **omitted** otherwise — unlike `host.findBinary`, whose probe is best-effort on top of resolution.
- All three probes are **uncached** — no cache anywhere on the path ([intent-hq/intentd#1064](https://github.com/intent-hq/intentd/pull/1064), unlike the 60-second positive cache on `host.findBinary` / `host.toolAvailability`) — so a fresh install is seen immediately on the next call; the FE setup checks rely on this ([intent-hq/cloudlands-fe#979](https://github.com/intent-hq/cloudlands-fe/pull/979)).

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
- **Probe mechanics.** CLI-probed providers run their registry `auth_check_args`; `auggie`, `claude-code`, and `codex` ride a **generic exit-code arm** — exit 0 ⇒ `true`, non-zero ⇒ `false` — with the child's stdout and stderr **discarded**, never captured, logged, or surfaced. `grok` and `opencode` keep bespoke output-sniffing arms (their stdout is piped: `grok models` exits 0 in both auth states so its output is parsed for explicit auth markers, and `opencode models` requires at least one `provider/model` line beyond exit 0), while `droid` and `pi` probe via their adapters instead of `auth_check_args`. `auggie` probes with `auggie token print` ([intent-hq/intentd#977](https://github.com/intent-hq/intentd/pull/977)): it has no bespoke probe any more, and the discarded output matters here because the command prints the auth session secret. The former `auggie model list` output-sniffing probe is retired.
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
    },
    {
      "id": "pi",
      "displayName": "Pi",
      "command": "npx",
      "installed": false,
      "resolvedPath": "/usr/local/bin/npx",
      "hasNpxFallback": false,
      "npxOnly": true,
      "npxPackage": "pi-acp@0.0.33",
      "cliCommand": "pi",                          // pi row only — the probed `pi` CLI command
      "cliResolved": true,
      "cliResolvedPath": "/usr/local/bin/pi",      // optional — present only when the CLI resolved
      "cliVersion": "0.79.0",                      // optional — present only when the version probe succeeded
      "cliVersionOk": false,
      "cliRequirement": "Pi CLI 0.80.4+",
      "unavailableReason": "pi CLI 0.79.0 is too old — Pi CLI 0.80.4+ is required by pi-acp@0.0.33"  // optional — present iff the CLI gate fires
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
- **`pi` CLI verdict fields** *(additive, intentd#1044 / monorepo#1662)* — the `pi` row additionally folds in a probe of the real `pi` CLI (the binary the pinned `pi-acp` adapter spawns — distinct from npx, which only launches the adapter). These fields appear **only** on the pi row, and only when it is not `gatedOff` (gated rows are never probed). The probed pi row **always** carries `cliCommand` (the command probed: a non-empty `PI_ACP_PI_COMMAND` daemon-env override, else bare `pi`), `cliResolved` (whether the command resolved to an executable), `cliVersionOk` (`true` **iff** the probe confirmed the minimum version or newer), and `cliRequirement` (the human-readable requirement, `"Pi CLI 0.80.4+"`). `cliResolvedPath` (absolute path) is present only when the CLI resolved, and `cliVersion` (the trimmed first line of `pi --version` output) only when the version probe succeeded — both **omitted (never null)** otherwise. A bare command name is resolved against the **spawn-time enhanced PATH** (npx's parent dir and `~/.augment/bin` ahead of the enriched/inherited dirs), so the probe reports the same binary the spawned pi-acp child would actually exec.
- **`pi` CLI gating** — a **missing** or **confirmed-too-old** CLI marks the pi row unavailable (it never sets `gatedOff`, which stays reserved for the env-var/feature-code mechanism above): `installed` is forced to `false` and `unavailableReason` (optional string, pi row only) carries an actionable message naming the found version (when too old), the requirement, and the adapter pin (e.g. `"pi CLI not found — Pi CLI 0.80.4+ is required by pi-acp@0.0.33"`). An **inconclusive** probe — spawn failure, timeout, unparseable `--version` output, or a relative separator-carrying `PI_ACP_PI_COMMAND` override that did not resolve from the daemon's CWD — is **permissive**: the daemon logs a WARN and does not gate, so `cliVersionOk` is `false` but `installed` is untouched and `unavailableReason` is omitted (a changed `--version` format never false-negatives the provider). Invariant: `unavailableReason` present ⇒ `installed: false` and `cliVersionOk: false`. The same gate fails agent creation fast with a clear error (instead of a silent hang) when a Pi agent is spawned against a missing/too-old CLI.
- `npx` reports the daemon's npx probe: `resolvedPath` is `null` when npx is not found; `version` is `null` when npx is missing **or** the version probe fails (a failed probe leaves `resolvedPath` set); `versionOk` is whether the resolved version meets the minimum requirement (`false` whenever `version` is `null`).

### Method aliases (2 total)

The daemon accepts these 2 alias forms and dispatches them to their canonical counterparts. The wire accepts both, but the canonical name is the documented form.

- `git.diff` → `git.diffs`
- `git.log` → `git.commits`

### Client-served reverse RPCs (4 total)

Of these 4 method names, `browser.exec` and `host.openInEditor` are **client-callable triggers**: the daemon validates the envelope, then serves the request. `browser.exec`'s real work always happens on the connected frontend via a reverse RPC (synthetic `rev-<n>` request id) whose result is echoed back to the original caller. `host.openInEditor`'s real work happens on the daemon host on a local connection (no reverse RPC is dispatched, §5.14) and on the connected frontend via that same reverse RPC mechanism on a remote connection. These 2 method names are **dual-role**: they appear in the dispatchable method catalog AND are also issued daemon→client as reverse RPCs on remote connections. `host.openExternal` and `host.pickApplication` are **daemon→client-only**: they are never dispatched client→server and do not appear in the dispatchable method catalog. On a remote connection the daemon is always the requester (synthetic `rev-<n>` id) and the connected client returns the result; on a local connection the daemon serves the intent directly on the daemon host without a reverse dispatch (§5.14).

- `browser.exec` — browser automation (Chrome DevTools) — §5.9 (dual-role)
- `host.openExternal` — open a URL in the default browser — §5.14 (daemon→client only)
- `host.openInEditor` — open a file or directory in the user's editor — §5.14 (dual-role)
- `host.pickApplication` — prompt the user to select an application — §5.14 (daemon→client only)

> **Internal, not wire (Code Changes Review).** Diff computation/versioning (`diffs.*`), agent-attribution `trackChange`, and metrics aggregation (`metrics.calculate` and the `update*` writers) run **entirely inside the backend** with no client RPC. Diff bodies are computed/stored internally and surfaced through the `file-tracking.*` reads (§5.19) plus the change events in §6.5 — clients never call a `diffs.*` method. See the cross-cutting principle in §6.8.

> **Internal, not wire (Agent Ecosystem).** Rule **injection** — assembling the system prompt from workspace files (`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization rules, and user overrides — runs **inside the backend** as agents start; only the `rules.*` read/edit methods (§5.21) cross the wire. Per-agent-type tool **denylisting** is likewise internal enforcement — there is **no** `agent.getAvailableTools` RPC. Long-term agent **memories** are an internal context source consumed by the agent runtime; no `memories.*` wire surface is exposed (see §5.22). See §6.8.

> **Internal, not wire (Integrations & Ops).** Token/credit **usage accounting** runs **inside the daemon**: usage is tallied **live** at ACP turn end from `PromptResponse.usage`, with a periodic **reconciliation scan** as fallback (§5.23); clients never trigger either — they read the result via `workspace.getTokenUsage` (§5.23) and are pushed `workspace:tokenUsage-changed`. **Observability** (tracing, structured logs, log files) is likewise daemon-internal: there is **no** `logging.*` / `telemetry.*` wire surface. See §6.8.

> Deprecated aliases. agent.subscribe/agent.unsubscribe and event.subscribe/event.unsubscribe exist in the method map but are not the canonical WebSocket subscription surface. For live event streaming use the bridge methods events.subscribe / events.unsubscribe (note the plural events.), handled directly by the server before the dispatcher — see §6. The agent./event.* variants create internal/agent-style subscriptions and do not wire a WebSocket client up to events.event notifications. (A bare `{ workspaceId }` `agent.subscribe` frame instead routes to the agent collection channel — see §6.9.)

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields`-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires`workspaceId` (see §3.6) and may return `-32603 Internal error` if the underlying service throws.

### §5.x subsection index

The per-namespace subsections (§5.1–§5.43) live in the [methods/](./methods/) directory; the canonical § → file map is the [§5.x subsections table in the README](./README.md#5x-subsections-methods).
