> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.9 `browser.*`, `terminal.*`, `file.*` · §5.13 Interactive `terminal.*`.

### 5.9 `browser.*`, `terminal.*`, `file.*`

| Method | Params | Result |
| --- | --- | --- |
| browser.exec | actions (req, non-empty array), tabId?, agentId?, workspaceId? | single action → the action's `{ action, success, result?, error? }` envelope; multi-action → `{ results: [...] }` — **client-callable trigger** whose real work is served by the connected FE via a reverse RPC (`browser.exec`, `id: "rev-<n>"`), see below. Tabs are **agent-scoped**: `claimTab` / `listTabs` scoping / `resizeTab` and the structured ownership errors are FE-enforced — see the tab-ownership block below (monorepo#2857). Agent tabs are **hidden by default**: `openTab` `visible?`, `showTab`, and the `listTabs` `visibility` / `displayed` fields — see the hidden-by-default block below (monorepo#3045). **Agent-initiated** calls (no client connection to answer on) are routed to the workspace's **driving client** under the REV-2 rules — `capabilities.browserExec` gate, `workspace.setBrowserClient` pin, claimed-tab host, first-connected eligible — and `listTabs` is answered by the daemon from the tab registry (§5.45); see the REV-2 block below (v9.9–v9.11) |
| browser.listTabs *(v9.10)*, browser.upsertTab *(v9.10)*, browser.removeTab *(v9.10)*, browser.syncTabs *(v9.10)*, browser.navigateTab *(v9.11)*, browser.closeTab *(v9.11)* | see §5.45 | the daemon-owned **browser tab registry** — fast-path methods (no `workspaceId` envelope requirement; the host-only reports are keyed by the connection's `client.hello` identity). Documented in §5.45 at the end of this file |
| browser.docs | topic (req) | docs string — **not exposed**: no router arm; see the `browser.docs — not exposed` block below |
| terminal.list | workspaceId (req) | `{ terminals: [{ id, name, cwd, isExecutingCommand }], daemonBootId }` (v4.0 envelope — the pre-4.0 bare terminals array is retired; monorepo#1334). `daemonBootId` is the daemon's per-boot identifier (UUID v4, minted once per daemon process; never persisted): stable within one daemon lifetime and fresh after a restart, so equal values across responses prove the same daemon lifetime and an **empty `terminals` list is authoritative** for that lifetime (not a restarted daemon that lost its PTYs). `name` is **always present** on each entry: the PTY's daemon-tracked display name when one was assigned at spawn (e.g. **"Setup Script"** for the workspace setup terminal, §5.1/§5.25), else the constant `"Terminal"`. The underlying PTY display name is optional spawn metadata (§5.13); the `name` field is not (clients may still fall back to `"Terminal"` defensively). The agent-facing MCP `ws.terminal.list` binding unwraps the envelope internally — agents still see the bare terminals array (§6.8) |
| terminal.readOutput | workspaceId (req), terminalId (req), maxLines? | output buffer text |
| file.read | path (req) | file contents — paths outside the workspace rejected (-32603) |
| file.readChunk *(v6.18)* | path (req), offset (req; 0-based byte offset), length (req; positive, ≤ 16 MiB decoded) | { content (base64), bytesRead, size } — one offset-windowed slice of the file's raw bytes (the binary counterpart of the UTF-8-only `file.read`; monorepo#2458). `size` is the file's total byte length; a window at/past EOF is `{ content: "", bytesRead: 0, size }` (never an error) and a window crossing EOF returns just the remaining bytes. Zero/over-cap `length` and directory paths are -32602 naming the cause; paths outside the workspace rejected (-32603); missing file → -32603 per the file-op convention |
| file.write | path (req), content (req) | { ok, path, size } |
| file.list | path? (default .) | [{ name, type }] |
| file.delete | path (req) | { ok, path, deleted } |
| file.mkdir | path (req) | { ok, path, created? |
| file.rename | oldPath (req), newPath (req) | { ok, oldPath, newPath } |
| file.placeAttachment | fileName (req), data? (base64), sourcePath? (absolute host path) — exactly one of data/sourcePath; mimeType? (v6.12) | { ok, path, fileName, size, attachmentId, mimeType?, uploadedAt } — `path` is workspace-relative under `.intent/attachments/`, `size` is the placed byte length (v6.5; monorepo#1948). `attachmentId` / `mimeType?` / `uploadedAt` (v6.12) are the additive attachment-registry fields (presence-detected; pre-6.12 daemons omit them): the daemon-minted UUID the placement was registered under, the client-supplied MIME type echoed back (omitted when not supplied), and the ISO registration timestamp |
| file.getAttachmentInfo | attachmentId (req) | { attachmentId, fileName, mimeType?, size, uploadedAt, path, exists } — attachment-registry metadata lookup (v6.12): `path` is the stored workspace-relative path (under `.intent/attachments/`) and `exists` reflects whether the file is still on disk at read time (the registry row survives an out-of-band delete). Unknown id → -32602 naming the id ("unknown attachment id") |
| file.attachmentUpload.begin *(v6.16)* | fileName (req), sizeBytes (req; positive, ≤ 1 GiB), sha256 (req; 64-hex of the complete payload), mimeType? | { uploadId, maxChunkBytes } — opens a staged chunked attachment upload session (16 MiB decoded per chunk); the workspace must exist, `fileName` must pass the same basename sanitization placement applies (fail-early: a name commit would reject fails here, before any bytes are staged), and validation failures are -32602 naming the specifics. A workspace holds at most **4** live sessions (monorepo#2275): a begin at the cap is -32602 naming the live count ("commit or abort one before beginning another"), and every begin first sweeps idle-expired sessions (15-minute idle TTL — see the session-bounds block below) so expired sessions never hold cap slots |
| file.attachmentUpload.chunk *(v6.16)* | uploadId (req), seq (req; 0-based), data (req; base64) | { uploadId, seq, receivedBytes } — stages one seq-numbered slice; per-seq retry is idempotent (the same seq overwrites the same chunk file; only new bytes count against the declared total) and chunks may arrive in any order. Over-cap chunks and totals beyond `sizeBytes` are -32602; unknown uploadId → -32602 ("no attachment upload in progress"); a chunk on an idle-expired session is -32602 ("expired after Ns of inactivity — begin a new upload", monorepo#2275) |
| file.attachmentUpload.commit *(v6.16)* | uploadId (req) | { ok, path, fileName, size, attachmentId, mimeType?, uploadedAt } — byte-shape-identical to a successful file.placeAttachment result: verifies staged bytes = sizeBytes with gap-free seqs from 0 and a matching SHA-256, then places through the same collision-safe placement + attachment-registry path. A failed commit leaves the session alive for retry or abort (and refreshes the idle clock, monorepo#2275); incomplete/gapped/mismatched payloads are -32602. A commit on an idle-expired session is -32602 ("expired … — begin a new upload"), and a commit racing an in-flight chunk (the pipelined chunk+commit race) is -32602 advising to wait for the chunk call to return and retry — the reserved-but-unwritten guise was formerly -32603 Internal; the partially-written guise was already -32602 and gains the retry advice (monorepo#2275) |
| file.attachmentUpload.abort *(v6.16)* | uploadId (req) | { uploadId, aborted } — drops the session and its staging directory; idempotent (an unknown id returns `aborted: false` instead of erroring) |

```json
// → request
{ "jsonrpc":"2.0","id":40,"method":"file.write",
  "params":{ "workspaceId":"ws-abc","path":"notes/out.txt","content":"hello" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "ok": true, "path": "notes/out.txt", "size": 5 } }
```

> **`file.placeAttachment` — daemon-mediated attachment placement (v6.5;
> [monorepo#1948](https://github.com/intent-hq/monorepo/issues/1948)).** Places a chat
> attachment into the workspace's `.intent/attachments/` directory and returns the
> workspace-relative path, so a client can hand an agent a readable on-disk path instead
> of rejecting an oversized inline upload. Exactly one payload source is required:
> `data` — the base64-encoded bytes (an optional `data:<mime>;base64,` URL prefix is
> tolerated, mirroring `note.saveAsset`) — or `sourcePath` — an **absolute** host-local
> file path the daemon copies directly (the same-host FE fast path; the bytes never
> cross the wire). Zero or both sources, undecodable base64, or a relative `sourcePath`
> are `-32602`; the inbound transport cap (§2) bounds the `data` variant like any other
> frame. `fileName` is reduced to a safe basename (path components are stripped; a name
> that reduces to nothing is `-32602`) and collides safely: the first placement keeps
> the name, later ones get `<stem>-2<ext>`, `<stem>-3<ext>`, … (multi-dot names suffix
> before the final extension: `dump.tar.gz` → `dump.tar-2.gz`). The result's `fileName`
> is the name actually chosen and `path` is always `.intent/attachments/<fileName>`.
> **Exclusion contract:** the daemon ensures the `.intent/` directory and its default
> `.gitignore` (ignore everything except `config.json`) exist before placing, and
> additionally drops an ignore-all `.gitignore` inside `attachments/` itself (covering
> repos with a customized `.intent/.gitignore`), so placed attachments never reach git
> tracking, idle auto-commit, or agent attribution. The
> directory is transient scratch space — clients/agents may delete placed files when
> done (`file.delete` works on the returned path).

> **Attachment registry (v6.12).** Every placement is additionally registered in the
> daemon's SQLite `attachments` table under a daemon-minted UUID — `{ id, workspaceId,
> fileName (the collision-safe placed name), mimeType?, size, uploadedAt, storedPath }` —
> and the registry fields ride the result additively (`attachmentId`, `mimeType?`,
> `uploadedAt`; presence-detected, so pre-6.12 clients are unaffected). The optional
> `mimeType` request param is recorded verbatim (blank collapses to absent). Registry
> rows are insert-only and survive an out-of-band delete of the stored file:
> `file.getAttachmentInfo` serves the row with `exists` reflecting the file on disk at
> read time (clients resolve a chip click to the current path this way), and the
> agent-side MCP `ws.file.getAttachment` binding copies the stored file into the
> calling agent's own working directory — the canonical checkout for shared-mode agents,
> the sandbox clone for CoW-sandboxed agents — returning the two failure modes
> distinctly: unknown id vs. registry row whose file was deleted (the latter names the
> original `fileName` + `uploadedAt` and instructs the model to continue without the
> file). The registry id is what the v6.12 attachment-reference file blocks (§5.5) carry
> in place of inline base64 `data`.

> **MCP `ws.file.getAttachment(attachmentId, destDir?)` (v6.12).** MCP-only (no wire
> method, per the §6.8 principle); requires an agent caller context. `attachmentId`
> (required) names the registry row — a cross-workspace id reads as unknown (the
> registry is workspace-scoped). The **source** is always the canonical workspace
> store (`stored path` inside the canonical root — containment-guarded, so a
> tampered registry row can never read outside it); the **destination root** is the
> caller's working directory (the sandbox clone for CoW-sandboxed agents, else the
> canonical checkout), with `destDir` (default `.intent/attachments`) resolved
> within it under the same containment guard, created on demand, and seeded with an
> ignore-all `.gitignore` marker so retrieved copies stay out of git tracking.
> Success returns `{ path, fileName, mimeType?, size, uploadedAt }` — `path`
> relative to the destination root, `mimeType` omitted when the row has none; the
> copy is skipped when the destination already holds a byte-identical file, and a
> partial copy is removed on failure. The two failure modes stay distinct: an
> **unknown id** errors as `unknown attachment id: <id>`, while a registry row
> whose **file was deleted** from the store errors naming the original `fileName` +
> `uploadedAt` and instructing the model to continue without the file rather than
> retry.

> **`file.attachmentUpload.*` — staged chunked attachment upload (v6.16;
> [monorepo#2262](https://github.com/intent-hq/monorepo/issues/2262)).** The
> large-payload counterpart of `file.placeAttachment`, following the v6.9
> `workspace.import.*` staged-session precedent: against a remote daemon the
> single-shot `sourcePath` arm is unusable (the file lives on the client host) and
> the inline `data` arm is bounded by the §1.3 frame cap, so payloads larger than
> one RPC frame travel as a staged session instead. `begin` validates the header
> before any disk side effect — the workspace must exist (unknown → -32602 naming
> the id), `fileName` non-empty, `sizeBytes` positive and at most **1 GiB**
> (`1073741824` bytes), `sha256` exactly 64 hex chars (case-insensitive, stored
> lowercased) — and opens an in-memory session with a staging directory under
> `<workspaces_root>/.attachment-upload-staging/<uploadId>/`, returning
> `{ uploadId, maxChunkBytes }` where `maxChunkBytes` is the **decoded** per-chunk
> cap (16 MiB — base64 inflates ~4/3 on the wire, keeping frames under the §1.3
> inbound cap). `chunk` writes each decoded slice to its own seq-numbered chunk
> file: retrying a seq **overwrites** the same file (idempotent; only the new
> bytes count against the declared total, so a retry never double-counts), chunks
> may arrive in any order, and empty data, over-cap slices, or totals exceeding
> `sizeBytes` are -32602 naming the numbers. `commit` requires the staged bytes to
> equal `sizeBytes` exactly with a gap-free seq range from 0 (`-32602` naming the
> received/expected bytes or the gapped seq list otherwise), reassembles and
> SHA-256-verifies the payload (mismatch → -32602 naming both digests), then
> delegates to the same collision-safe placement + attachment-registry path as
> `file.placeAttachment` — the commit result is **byte-shape-identical** to a
> successful `placeAttachment` result, including the v6.12 registry fields. A
> failed commit (checksum mismatch, incomplete staging, placement failure) leaves
> the session **alive** for retry-after-more-chunks or abort; a successful commit
> retires it and deletes the staging directory. `abort` is idempotent: it drops
> the session and staging dir, returning `{ uploadId, aborted }` with
> `aborted: false` for an unknown/already-settled id instead of erroring. While a
> commit is verifying/placing, concurrent `chunk`/`abort`/`commit` calls on the
> same uploadId are rejected (-32602 naming the in-flight commit) so nothing
> mutates the files being hashed. Sessions are **in-memory only**: a daemon
> restart drops them (the client simply restarts the upload; an unknown uploadId
> is -32602 "no attachment upload in progress"), orphaned staging dirs are swept
> lazily by the next `begin`, and nothing is visible — no placed file, no
> registry row — until commit succeeds. Placement failures are logged at WARN in
> the daemon (monorepo#2144); caller errors are always coded -32602 with a
> reason, never a bare Internal error.

> **Session bounds — per-workspace cap + idle TTL
> ([monorepo#2275](https://github.com/intent-hq/monorepo/issues/2275);
> [intent-hq/intentd#1217](https://github.com/intent-hq/intentd/pull/1217)).**
> Upload sessions are bounded two ways. **Cap:** a workspace may hold at most
> **4** live sessions; a `begin` at the cap is -32602 — `workspace <id> already
> has N attachment uploads in progress (max 4) — commit or abort one before
> beginning another`. The expired-session drain, the per-workspace count, and the
> new session's insertion happen under one registry lock hold, so concurrent
> begins serialize and cannot overshoot the cap. **Idle TTL:** a session with no
> begin/chunk/commit activity for **15 minutes** expires lazily, mirroring the
> orphaned-staging sweep — the next `begin` (any workspace) drains expired
> sessions and reclaims their staging dirs (outside the lock; expired sessions
> never hold cap slots), while a late `chunk`/`commit` on an expired id gets
> -32602 — `attachment upload <id> expired after Ns of inactivity — begin a new
> upload`. Each successful `begin`/`chunk` refreshes the idle clock; a session is
> **never expired while a commit is in flight**, and a *failed* commit (checksum
> mismatch, incomplete staging) refreshes the clock, so the documented
> retry-after-more-chunks window is a fresh 15 minutes even when the commit
> itself outlived the TTL. **Pipelined-race errors:** a commit that catches a
> reserved-but-unwritten or partially-written chunk (a `chunk` call still in
> flight when `commit` fires) is a caller-sequencing error, not a daemon fault —
> both guises are -32602 with retry advice (`chunk N is still being written —
> wait for the chunk call to return, then retry the commit` / `assembled
> attachment is N bytes, expected M — a chunk may still be being written; …`).
> The reserved-but-unwritten guise is a reclassification (formerly -32603
> Internal); the partially-written guise was already -32602 and gains the retry
> advice. Either way the session stays alive and the retry succeeds once the
> chunk lands.

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
> **Agent-initiated `browser.exec` — REV-2 target selection (v9.9–v9.11;
> [intent-hq/intentd#1756](https://github.com/intent-hq/intentd/pull/1756),
> [intent-hq/intentd#1760](https://github.com/intent-hq/intentd/pull/1760),
> [intent-hq/intentd#1770](https://github.com/intent-hq/intentd/pull/1770); supersedes the
> REV-1 "first-client-sticky" interim).** When `browser.exec` is triggered by an *agent*
> (via the MCP `ws.browser.exec` binding, §6.8) there is no ambient reverse channel to
> reuse: the caller is the daemon-hosted MCP server, not a client-facing socket. The
> daemon selects the **driving client** of the agent's workspace and dispatches the
> reverse RPC to one of that client's live connections. (The direct, tab-addressed RPCs
> `browser.navigateTab` / `browser.closeTab` are **not** governed by this paragraph — any
> connected client may call them with a bare `tabId`, and §5.45 defines their routing: a
> claimed tab goes to its workspace's driving client per the rules below, an unclaimed tab
> to its physical host.)
>
> 1. **Eligibility gate (v9.9).** Only connections that completed `client.hello` with
>    `capabilities.browserExec: true` (§5.17) are ever candidates. Un-hello'd sockets and
>    hello'd connections without the flag are invisible to every rule below, regardless
>    of arrival order — an iOS app or a CLI connecting first no longer captures agent
>    browser traffic.
> 2. **Workspace pin (v9.9).** If the workspace carries `browserClientId`
>    (`workspace.setBrowserClient`, §5.1), the target is that logical client: its
>    **newest** eligible live connection. A pinned client with **no** eligible live
>    connection is a hard failure — `-32603` `browser.exec: browser client "<name>"
>    (<clientId>) for this workspace is not connected` (`browser client <clientId> for
>    this workspace is not connected` when no name is known) — **never** a silent
>    fallback to another client. The name is the client's last hello `name`, read from
>    the persisted `client` row when the connection registry no longer knows it.
> 3. **Claimed-tab host (v9.11).** Unpinned, but the workspace has at least one
>    **claimed** registry tab (`ownerAgentId` set, §5.45): the target is the host client
>    of the oldest claimed tab — the workspace's agent tabs all live on one client. Offline
>    ⇒ the same `… for this workspace is not connected` `-32603`.
> 4. **Default (v9.9).** Otherwise the **first-connected eligible** connection (registration
>    order; UDS + WSS share one registry); if it drops, the next eligible connection takes
>    over. No eligible connection at all ⇒ `-32603` `browser.exec: no client connected` —
>    the same class of failure a closed channel already produces.
>
> `workspace.getBrowserClient` (§5.1) runs the same resolution without dispatching
> (`resolved: null` for the two offline outcomes). The virtual Chief workspace cannot be
> pinned and always resolves under rule 4. Client-triggered `browser.exec` is
> **unchanged**: it still reverse-dispatches on the caller's own connection, whatever
> the workspace's pin says.
>
> **Registry-backed agent actions (v9.11).** Because the daemon owns the tab registry
> (§5.45), two parts of an agent's batch are handled daemon-side before / after the
> reverse dispatch — the `actions` vocabulary and the reverse-RPC wire shape are
> unchanged:
>
> - **`tabId` pre-check.** Every `tabId` the batch names (per action or as the
>   top-level `tabId`) must be an **open registry tab of the request's workspace**;
>   otherwise `-32602` `browser.exec: tab not found: <tabId>` before anything is
>   dispatched.
> - **`listTabs` is answered by the daemon**, never forwarded: the result is every open
>   registry tab of the workspace **across all hosts**, filtered by `scope`
>   (`"mine"` / `"unclaimed"` / `"all"`, default `all`; any other value ⇒ `-32602`),
>   each entry in the FE's field names (`tabId`, `workspaceId`, `url`, `requestedUrl?`,
>   `title?`, `ownerAgentId` — `null` when unowned —, `ownerAgentName?`,
>   `mode: "native" | "emulated"` with `width` / `height` when emulated, `visibility`,
>   `displayed?` — the host-reported layout fact as the host last reported it, omitted
>   whenever the daemon holds **no current report** for it (not yet reported, cleared
>   by a later report that omitted it, or lost to a daemon restart) — *unknown*,
>   never a default `false`; within v9.12,
>   [intent-hq/intent#4835](https://github.com/intent-hq/intent/issues/4835))
>   **plus** `hostClientId`, `hostName?` (the host's hello `name` while it is live) and
>   `hostConnected` (whether the host currently has a live hello'd connection). A
>   `listTabs` batch must contain **only** `listTabs` actions (`-32602` otherwise); its
>   result envelope shape is unchanged (single action → the action envelope, several →
>   `{ results }`). `scope: "mine"` without an `agentId` caller is the FE's structured
>   action error (`success: false`), not a JSON-RPC error.
> - **`claimTab` re-homes the row.** After the driving client reports a **successful**
>   `claimTab`, the daemon moves that tab's registry row to the workspace's driving
>   client **as re-resolved at commit time** (so a claim that overlapped a
>   `workspace.setBrowserClient` lands on the new pin, not on the client that happened to
>   execute it) and records the caller as `ownerAgentId`, publishing one
>   `browser:tab-updated { changes: { hostClientId, ownerAgentId } }` (only
>   `ownerAgentId` when the host is unchanged; nothing when the row is already in the
>   target state) — §6.5.
>
> **Loopback-hostname interpretation — FE-side, wire shape unchanged (monorepo#2323).**
> URL hostnames in `navigate` / `openTab` action URLs are interpreted **on the frontend
> that serves the reverse RPC**, per the reserved-hostname convention (RFC 6761
> `*.localhost` names): `daemon.localhost` targets the **daemon machine** (rewritten to
> `127.0.0.1` on a local daemon, to the daemon host — the sanitized transport target —
> on a remote one); `client.localhost` targets the **client (user's) machine** (always
> rewritten to `127.0.0.1`); **bare loopback** (`127.0.0.1` / `localhost` / `[::1]`) is
> ambiguous and defaults to the agent's frame of reference — the daemon: unchanged on a
> local daemon, rewritten to the daemon host on a remote one. (Degenerate case: when
> the remote daemon host cannot be determined from the transport state, daemon-targeting
> URLs are left unchanged — non-rewritten, no echo fields.) The daemon remains a
> **thin proxy**: no rewrite happens daemon-side and the `browser.exec` request /
> reverse-RPC wire shape is unchanged — the convention is entirely FE-served. Rewritten
> actions echo **additive fields** in their result payload: `requestedUrl` (the URL as
> requested), `finalUrl` (the URL actually loaded), `rewritten: true`, and a
> human-readable `reason`; ambiguous bare-loopback rewrites additionally carry a
> `warning` naming the explicit `daemon.localhost` / `client.localhost` forms.
> Non-rewritten URLs keep a byte-identical result shape (no echo fields). Only the
> hostname is rewritten (scheme, port, path, query, and hash are preserved), and only
> top-level `navigate` / `openTab` URLs are interpreted — never URLs inside pages
> (redirects, fetches, links).
>
> **Agent-scoped tab ownership — FE-enforced (monorepo#2857).** Every embedded browser
> tab carries a **nullable `ownerAgentId`**. User-opened tabs start **unowned**
> (`ownerAgentId: null`); agent-opened tabs are owned by the opening agent from
> creation. Agents may only manipulate (navigate / close / evaluate / screenshot / …)
> tabs they own — other agents' tabs are visible in `listTabs` but not manipulable.
> Caller attribution rides the existing envelope: agent-initiated `browser.exec` (the
> MCP `ws.browser.exec` binding, §6.8) **always carries `agentId`**; a call without
> `agentId` is the **user**, who is unrestricted (no ownership checks apply). Ownership
> is enforced **entirely on the frontend** that serves the reverse RPC: the action
> vocabulary is FE-served, the daemon remains a thin proxy, and the `browser.exec`
> request / reverse-RPC **wire shape is unchanged** — no daemon change is involved.
>
> - **`claimTab { tabId, width, height? }`** — claims an **unowned** tab for the calling
>   agent. `width` is **required** (a claim without `width` is a validation error);
>   `height` is optional. Claims are **atomic, first-claim-wins**: a successful claim
>   transfers ownership *and* enables viewport emulation at the given size in one step.
>   There is **no stealing** — a claim on an already-owned tab fails with the structured
>   `already-claimed` error naming the owning agent. Unowned tabs can only originate
>   from users.
> - **`openTab` dedupe is per-agent** — an agent re-opening the same `requestedUrl`
>   reuses its own existing tab; tabs owned by other agents (or unowned tabs) are
>   never reused, so two agents opening the same URL get two tabs.
> - **`listTabs { scope? }`** — `scope: 'mine' | 'unclaimed' | 'all'` (default `all`).
>   Every returned tab carries `ownerAgentId` (`null` when unowned) plus owner display
>   info, **sizing info**: `mode: 'native' | 'emulated'` and, when emulated, the
>   current `width` / `height` — so an agent can see a tab's current size before
>   deciding to claim or resize — and **`visibility: 'visible' | 'hidden'`** plus
>   **`displayed?: boolean`** — a **layout contract**, not a paint guarantee: true
>   when the tab is not hidden AND is the active tab of the panel that holds it in
>   the workspace's saved layout; hidden tabs are `displayed: false` whenever the
>   field is present. The field is **present only while the daemon holds a current
>   host report** for it (the daemon answers `listTabs` from the registry, §5.45, and
>   keeps `displayed` process-local): it is absent before the host first reports it,
>   after a later upsert / sync that omitted it cleared it, and after a daemon
>   restart until the host's connect-time `browser.syncTabs` re-reports it — absent
>   means *unknown*, never `false`, and says nothing about whether the field was
>   ever reported; the caller re-reads with `listTabs`
>   ([intent-hq/intent#4835](https://github.com/intent-hq/intent/issues/4835)).
>   What a `displayed: true` tab can actually paint is stated once in the
>   **capture ops and workspace visibility** contract below (monorepo#3045).
> - **Structured ownership errors** — `not-owner` (an op on a tab the caller does not
>   own — another agent's tab, or an unowned tab the caller has not claimed) and
>   `already-claimed` (a claim lost to an earlier claim) surface as **action-result
>   errors**: inside the per-action `{ action, success: false, error }` envelope, never
>   as JSON-RPC-level errors. Each names the owning agent when the tab has one; a
>   `not-owner` on an **unowned** tab carries no owner info (there is no agent to
>   name — the remedy is `claimTab`). Ownership failures are **never** reported as the
>   FE's top-level failure envelope (`success: false` + top-level `error`, which the
>   daemon maps to `-32603`, see above): the FE reports the batch as executed with the
>   failing action's envelope in `results`, so the error reaches the caller through
>   the normal single-/multi-action reshape.
>
> **Hidden-by-default agent tabs — FE-enforced (monorepo#3045).** Agent-opened tabs
> start **hidden by default**: not mounted into the user's panel layout and never
> stealing focus. Unowned (user) tabs are always `visibility: 'visible'` — hidden is
> an agent-owned-tab state only. Like ownership, visibility is FE-served —
> `visible?` / `focus?` and `showTab` are action-vocabulary fields inside the opaque
> `actions` array, not `browser.exec` method params, so the `browser.exec` request /
> reverse-RPC **wire shape is unchanged**, the daemon stays a thin proxy, and there
> is **no method-catalog or protocol-version change** (same as the #2857 ownership
> vocabulary above).
>
> - **`openTab { url, visible?, width?, height? }`** — `visible` is optional and
>   defaults to **`false`**: the tab is created **hidden** — alive, owned by the
>   opener, emulated (sizing invariant unchanged), returned by `listTabs` (with
>   `visibility: 'hidden'`), and its webview renders offscreen — with **no panel
>   mount and no focus or active-tab change**. `visible: true` on a **fresh** open
>   opts into opening directly into the panel layout: the tab is mounted per the
>   requested `position` (`adjacent`, `same`, or the new-tab fallback of `replace`)
>   **and activated in its panel** (made the panel's active tab in the saved
>   layout) **without** moving panel/keyboard focus on **every** placement, and the
>   action's `result` carries an **optional `displayed?: boolean`** (the same
>   layout meaning as `listTabs`, read from the layout after the open): **present
>   only when the FE confirmed the tab's layout state** from a fresh tab list;
>   **absent when that state is unknown** (stale or unavailable list, tab not
>   listed) — absence means *unknown*, never `false`, and the caller re-reads it
>   with `listTabs`. Default hidden opens (`visible` omitted/`false`) and reuses
>   without `visible: true` **omit** the field. Per-agent
>   dedupe (above) is unaffected by visibility — a same-URL reopen reuses the
>   agent's tab whether hidden or visible — and a
>   dedupe hit **never changes the reused tab's visibility**: a hidden tab stays
>   hidden even when the `openTab` carried `visible: true`, and a visible tab stays
>   visible. A dedupe hit under `visible: true` carries the same optional
>   `displayed?` for the reused tab (`false` for a hidden tab when confirmed,
>   absent when unknown). Revealing an existing tab is **`showTab`-only**.
> - **`showTab { tabId, focus? }`** — **activates** an owned tab in a visible panel:
>   reveals a hidden tab, or brings a visible-but-inactive tab to the front of its
>   panel; **owner-only** (on a tab the caller does not own it returns the
>   structured `not-owner` error, per the ownership rules above). `focus` is optional
>   and defaults to **`false`**: the tab is activated in a visible panel **without**
>   moving panel/keyboard focus and **without** displacing the currently-viewed
>   conversation — the reveal targets a panel other than the focused one, splitting
>   the layout when no other panel qualifies. Activation is part of the reveal in
>   both flavors: a non-active tab renders nothing in the tabless UI, so a reveal
>   that merely mounted without activating had no user-visible effect
>   (cloudlands-fe#1560, monorepo#3112). `focus: true` reveals, activates, **and**
>   focuses — the tab becomes its panel's active tab and the panel takes focus. The
>   reveal is **persisted**: a revealed tab stays visible across app restarts rather
>   than reverting to hidden. `showTab` is
>   **idempotent** on an already-**displayed** tab (visible AND its panel's active
>   tab): with `focus: false` it is a no-op success; with `focus: true` it still
>   focuses its panel. `visibility: 'visible'` alone does not mean displayed: a
>   visible tab that is not its panel's active tab is in the layout but sits behind
>   another tab and is not painted on screen (`visibility: 'visible', displayed:
>   false`; a capture op may still mount it on demand, see below), and
>   `showTab` on it (default `focus: false`) brings it to the front without moving
>   focus. `displayed: true` is a layout state, not a paint guarantee — see the
>   capture-ops contract below. `showTab` succeeds only
>   once a fresh tab list confirms the tab as not hidden **and** its panel's active
>   tab; otherwise it fails as an action-result error.
>   An unknown `tabId` fails as an **action-result error** (the per-action
>   `{ action, success: false, error }` envelope naming the unknown id — never a
>   JSON-RPC-level or FE top-level error), like the structured ownership errors above.
> - **`focusTab` is unchanged for visible tabs** (activate + focus the panel). On a
>   **hidden** tab it fails with an action-result error directing the caller to
>   `showTab` — there is no focusTab overload that reveals a hidden tab.
>
> **Capture ops and workspace visibility — one contract (monorepo#3045,
> [intent-hq/intent#4103](https://github.com/intent-hq/intent/issues/4103),
> [intent-hq/intent#4835](https://github.com/intent-hq/intent/issues/4835)).**
> Agent tab operations do **not** require the tab's workspace to be currently
> open/visible in the FE. Layout-only actions (`openTab` hidden or visible,
> `closeTab`, `showTab`, `focusTab`, `claimTab`, `resizeTab`, …) apply their effects
> to the **persisted layout state** so the layout is correct when the user next
> opens the workspace, and `displayed` reports that persisted state — it can be
> `true` for a tab in a workspace that is not currently in view. When the workspace
> is **not** visible in the UI, no actual UI focus/activation side effect is
> attempted: `showTab { focus: true }`, `focusTab`, and `openTab { visible: true }`
> **succeed**, skip the UI focus attempt, and the action's `result` carries an
> **additive human-readable `warning` string** saying the workspace is not visible
> so no UI focus was attempted — the same additive-`warning` channel as the
> bare-loopback rewrite warning above (monorepo#2323). The warning never rides
> `error`, never fails the action, and is absent when the workspace is visible.
>
> **Capture ops** (`screenshot`, `getAccessibilityTree`, `evaluate`) and `navigate`
> (which runs through `evaluate`) need a **mounted webview**. A tab whose webview is
> not mounted — typically a **visible** tab whose workspace is not in view or that
> sits behind another tab in its panel, but also a tab opened while its workspace
> was not in view, whatever its `visibility` — is **mounted on demand** by the op
> itself: the FE hydrates the workspace layout and waits for the offscreen host to
> register the tab. For the three capture ops the whole pipeline — mount, a wait
> for the guest to finish loading, then the capture — is bounded by **one request
> deadline** (the reverse-RPC timeout minus a transport margin; each stage gets the
> lesser of its own cap and the budget remaining), so a capture op is designed not
> to outlive the daemon's reverse request. `navigate` runs only the mount step: it
> passes no deadline (its mount wait is bounded by that stage's own cap alone), does
> not wait for the guest to settle, and performs no origin check. `snapshot` does
> not go through the mount path at all. A mount on demand against a not-in-view
> workspace succeeds with the same additive `warning` string as above; a hidden tab
> in a displayed workspace mounts with no warning.
>
> When a mount, settle, or paint cannot happen, the op fails as an **action-result
> error** (the per-action `{ action, success: false, error }` envelope) whose
> human-readable `error` names the cause and remedy, and which carries an
> **additive structured `errorCode`** when the cause is one of:
>
> - `workspace-not-visible` — the tab could not be mounted on demand while the
>   workspace is not **displayed** in any window: either no window hosts the
>   workspace at all (the hydration nudge reaches no renderer, so the op fails fast
>   instead of waiting), or a background window does host it but the offscreen
>   registration wait ran out at its own cap. Retry shortly or `listTabs` to confirm
>   the tab still exists; if the workspace is open nowhere, open it in a window and
>   retry.
> - `deadline-exhausted` — (capture ops only) the request deadline ran out at a
>   named stage (before or during the mount, the load settle, or the capture
>   itself); retry the capture.
> - `still-loading` — (capture ops only) the guest was still loading after the
>   bounded settle wait; retry, or `snapshot` with `waitFor: { networkIdle }` first.
> - `navigated-away` — (capture ops only, and **only after a mount on demand**) the
>   freshly mounted guest shows a different **origin** than the tab list recorded
>   for the tab; same-origin URL drift is not reported, and origin drift on an
>   already-mounted guest is not checked. The remedy is `navigate` back, or
>   `listTabs` to re-check the tab.
> - `not-painting` — (capture ops only) the webview is mounted but its surface has
>   not painted, detected either way: `capturePage` did not return within the
>   capture stage's **own** cap (when that cap, not the request deadline, is the
>   binding bound), **or** it returned an empty / empty-encoded image, which is
>   reported as soon as it is observed (e.g. a `displayed: false` tab behind a
>   sibling, or a `displayed: true` tab whose panel is hidden by zoom); the remedy
>   is `showTab` (activate without moving focus) or `focusTab` (activate and
>   focus), then capture again.
>
> Other failures (unknown tab, a CDP error outside these stages) carry no
> `errorCode`; ownership failures keep their own `not-owner` / `already-claimed`
> codes. One exception to the action-result rule: should a batch still not have
> settled shortly **after** the request deadline (a stage that takes no deadline,
> such as `navigate`'s mount or its evaluate), the FE's executor backstop answers
> with the **top-level** failure envelope (`success: false`, `results: []`, `error`
> naming the "action execution" stage, no per-action `errorCode`) before the daemon
> gives up — which the daemon maps to `-32603` as above. `displayed: true` never
> guarantees a paint by itself; it says the tab is the active tab of its panel in
> the saved layout, and the op supplies the mount when the workspace is not in view.
>
> **Viewport sizing invariant.** Every tab has a persisted viewport mode. **Fit panel**
> is the default: a visible tab follows the panel's webview area with no fixed frame or
> letterboxing. Agent-owned fit tabs remain CDP-emulated at the reported panel bounds;
> hidden/offscreen owned fit tabs use their last emulated size or **1280×800** when none
> was recorded. Unowned fit tabs stay native. Preset/custom modes use exact dimensions
> with scale-to-fit when the panel is smaller, for both owned and unowned tabs.
> Everywhere explicit dimensions appear
> (`claimTab` / `openTab` / `resizeTab`), `width` and `height` are **integers within
> 320–3840** (CSS px, inclusive), enforced up-front by action-sequence schema
> validation: fractional, non-finite, or out-of-range values (below 320 — which
> covers zero and negatives — or above 3840) reject the **whole batch before any
> action executes**, surfacing through the FE top-level failure envelope
> (`success: false` + top-level `error`, `Invalid action sequence: …`) that the
> daemon maps to `-32603` (see above) — an emulated tab can never carry a
> disabling zero size. Agent-issued
> `openTab` accepts optional `width` / `height`: omitting both selects Fit panel;
> specifying either selects custom mode, with the omitted axis defaulting to **1280**
> (width) or **800** (height). `claimTab` with omitted `height` likewise defaults to
> **800**. `listTabs` reports `mode: "emulated"` plus the effective width/height for
> emulated tabs (current bounds for visible owned fit tabs, fallback size offscreen,
> exact dimensions for preset/custom); unowned fit tabs report `mode: "native"`.
> **`resizeTab { tabId, width, height? }`** switches an owned tab to its persisted
> per-tab **custom** viewport mode at the requested width and requested height. When
> `height` is omitted, the action uses the tab's retained emulated height — the last
> height explicitly requested by `openTab`, `claimTab`, `resizeTab`, or a user-selected
> preset/custom viewport, or the **800** default — never a live Fit-panel measurement,
> so the resulting custom size remains
> within the validated 320–3840 range. The user can return the tab to **Fit panel**
> from the viewport menu. The action is owner-only (on
> a tab the caller does not own it returns the structured `not-owner` error); there is
> no agent action for unowned (user) tabs, though users may still select preset/custom
> or Fit panel.
>
> **Ownership lifecycle.** Ownership is **FE-persisted** alongside the tab and survives
> app restarts — an owned tab never silently reverts to unowned on relaunch. Ownership
> persists when the owning agent completes. Agent **deletion destroys all** the agent's
> tabs — self-opened and claimed alike (there is no release-to-unowned path, so no tab
> ever transitions emulated→native); destruction happens when the deletion **commits**:
> an `agent.delete` still inside its `undoDelayMs` grace window (§5.5) leaves the tabs
> untouched, and `agent.cancelDelete` restores the agent with its tabs intact.
> Workspace archive/delete discards all tabs. A user "close" of an agent-owned tab is a
> UI-level **hide**, not a destroy: the tab **returns to hidden** (`visibility:
> 'hidden'`, monorepo#3045) — it stays alive, continues to appear in `listTabs` for
> its owner, and can be revealed again via `showTab` (or restored from the sidebar
> owner group). The destroy paths are unchanged: only agent deletion / workspace
> archive-delete destroy owned tabs. Unowned tabs close/destroy normally.
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
> `terminal.create` parameter) that `terminal.list` surfaces as `name` (on each
> `terminals[]` entry of the v4.0 envelope) with a `"Terminal"` fallback — see the
> `terminal.list` row above.

### 5.13 Interactive `terminal.*`

> Alongside the read-only methods (`terminal.list` — the v4.0 `{ terminals, daemonBootId }`
> envelope — and `terminal.readOutput`, §5.9), the
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

### 5.45 Browser tab registry — `browser.listTabs` / `upsertTab` / `removeTab` / `syncTabs` / `navigateTab` / `closeTab`

The daemon owns a persisted **browser tab registry** (`browser_tab` table; REV-2,
v9.10 registry [intent-hq/intentd#1763](https://github.com/intent-hq/intentd/pull/1763),
v9.11 routing [intent-hq/intentd#1770](https://github.com/intent-hq/intentd/pull/1770),
[intent-hq/intent#461](https://github.com/intent-hq/intent/issues/461)): one row per
logical embedded-browser tab, keyed by `tabId`, bound to the `workspaceId` that created it
and to the **host** — the logical client (`clientId`, §5.17) whose webview renders it. The
registry is the shared source of truth every client renders from: a host reports its own
tabs, any client reads the workspace's tabs across hosts, and navigation / close requests
about a tab are **routed** by the daemon to the client that must perform them. All six
methods are **fast-path** (§5 catalog): the host-only reports are keyed by the
connection's `client.hello` identity, never by a wire parameter.

| Method | Params | Result |
| --- | --- | --- |
| browser.listTabs *(v9.10)* | workspaceId (req) | { tabs: (BrowserTab & { hostConnected: boolean, hostName? })[] } — every **open** registry tab of the workspace, oldest first (`createdAt`, then `tabId`), any client may call it. `hostConnected` is whether the tab's host has a live hello'd connection right now; `hostName` is that host's hello `name` (omitted while the host is offline or nameless). Tombstoned rows (see `browser.closeTab`) are excluded. -32602 on a missing/empty `workspaceId`. |
| browser.upsertTab *(v9.10)* | workspaceId (req), tab (req): BrowserTabInput | { tab: BrowserTab } — **host-only** report of an opened / navigated / re-titled / re-owned / shown-hidden / displayed-or-not / resized tab. The caller's `client.hello` `clientId` is the host (-32602 `browser.upsertTab: client.hello is required before hosting tabs` on an un-hello'd connection); the envelope `workspaceId` is required and is **injected into** `tab` before parsing (so `tab.workspaceId` may be omitted and is overridden when present). Unknown `tabId` ⇒ new row (`browser:tab-opened`); known row of this host ⇒ the host-reported fields are replaced and, when anything differed, `browser:tab-updated { changes }` is emitted (an identical report writes nothing and emits nothing). -32602 when the tab is hosted by **another** client (`browser tab <id> is hosted by client <clientId>`), when it is **tombstoned** (`… was closed by the daemon; drop it (browser.syncTabs reports it in drop)`), when the report names another `workspaceId` for a known tab (`tabs do not move between workspaces`), or on a malformed `tab` (non-object; `tabId` missing, non-string or empty; `url` missing or non-string — an **empty** `url` string is accepted; a wrong-typed optional field; the remaining `BrowserTabInput` fields are optional and `visibility` defaults). |
| browser.removeTab *(v9.10)* | tabId (req) | { ok: true } — **host-only** report that the tab is gone. Deletes the row (an open row emits `browser:tab-closed`; a tombstone is purged silently — the host has acknowledged the daemon-side close). Unknown ids are an idempotent no-op. -32602 on an un-hello'd connection or a tab hosted by another client. |
| browser.syncTabs *(v9.10)* | tabs (req): BrowserTabInput[] | { drop: tabId[] } — **host-only** full-snapshot reconciliation of the host's tab set **across all workspaces** (each entry carries its own `workspaceId`; duplicate ids after the first are ignored), one transaction — nothing is written when any entry is rejected. Per entry: unknown ⇒ created (`browser:tab-opened`); open and hosted by this host ⇒ refreshed (`browser:tab-updated { changes }` when anything differed; another `workspaceId` for a known tab rejects the **whole** snapshot with -32602); tombstoned or hosted **elsewhere** ⇒ untouched and listed in `drop` (a tab has exactly one host; the tombstone is retained, so a repeated stale snapshot keeps answering `drop` instead of reviving the tab). Every row of this host **absent** from the snapshot is deleted — open rows emit `browser:tab-closed`, tombstones are purged silently. Hosts send it on connect / reconnect and after a `client:disconnected`-worthy gap. -32602 on an un-hello'd connection, a non-array `tabs`, or a malformed entry (non-object; `tabId` / `workspaceId` missing, non-string or empty — here `workspaceId` **is** required per entry, there being no envelope value to inject; `url` missing or non-string, an empty `url` being accepted). |
| browser.navigateTab *(v9.11)* | tabId (req), url (req) | the routed `navigate` action's `{ action, success, result?, error? }` envelope — any client. The daemon looks the tab up (-32602 `browser.navigateTab: tab not found: <tabId>` for an unknown or tombstoned id) and dispatches a reverse `browser.exec { workspaceId, tabId, actions: [{ action: "navigate", tabId, url }] }` to the tab's **routing target**: a **claimed** tab (`ownerAgentId` set) goes to its workspace's driving client (§5.9 REV-2 rules), an **unclaimed** one to its physical host. The host then reports the resulting navigation via `browser.upsertTab` and every client follows the canonical row. -32603 `browser.navigateTab: browser client "<name>" (<clientId>) for this workspace is not connected` when the target is offline; `browser.navigateTab: no client connected` when no eligible client exists at all. |
| browser.closeTab *(v9.11)* | tabId (req), force?: boolean | { ok: true } — any client. Without `force`: the close is routed exactly like `browser.navigateTab` (reverse `browser.exec { action: "closeTab" }`, same -32602 / -32603 outcomes) and the host's own `browser.removeTab` deletes the row. With `force: true`: a best-effort routed close is attempted when the target is reachable (its failure is ignored), then the row is **tombstoned daemon-side** regardless — it disappears from every list now, `browser:tab-closed` is published, and the host is told to `drop` the id on its next `browser.syncTabs` (a stale `browser.upsertTab` for it is -32602 until then). -32602 on a non-boolean `force`. |

**`BrowserTab` (wire, camelCase).**

```ts
interface BrowserTabInput {            // host-reported fields
  tabId: string;                       // host-minted id, stable for the tab's lifetime
  workspaceId: string;                 // bound at creation; a later report may not change it.
                                       // Required per entry in browser.syncTabs; in browser.upsertTab
                                       // the envelope workspaceId is injected here (may be omitted)
  url: string;                         // the URL actually loaded (may be "")
  requestedUrl?: string | null;        // the URL as requested (loopback rewrite echo, §5.9)
  title?: string | null;
  ownerAgentId?: string | null;        // omitted / null = unowned (user tab), §5.9 tab ownership
  ownerAgentName?: string | null;
  visibility?: "visible" | "hidden";   // default "visible" when omitted; null is REJECTED (-32602);
                                       // §5.9 hidden-by-default block
  emulatedSize?: { width: number, height: number } | null;   // omitted / null = native viewport
  displayed?: boolean | null;          // §5.9 layout fact: not hidden AND the active tab of its
                                       // panel in the workspace's saved layout; omitted / null =
                                       // no value, clears a previously reported one
                                       // (within v9.12, intent-hq/intent#4835)
}
// Input nullability: the six nullable report fields above accept an explicit null
// (≡ omitted). The canonical BrowserTab row (below, list results, event `tab`) never
// carries null — a cleared field is omitted; only the browser:tab-updated `changes`
// diff uses explicit null to signal a clear.
interface BrowserTab {                 // canonical row — non-null; cleared fields are omitted
  tabId: string;
  workspaceId: string;
  hostClientId: string;                // the logical client rendering the tab (§5.17)
  url: string;
  requestedUrl?: string;
  title?: string;
  ownerAgentId?: string;               // omitted = unowned
  ownerAgentName?: string;
  visibility: "visible" | "hidden";    // always present on read
  emulatedSize?: { width: number, height: number };
  displayed?: boolean;                 // as the host last reported it; omitted = no current report
                                       // (unknown — NOT a default false; detect by presence, and do
                                       // not infer report history from absence)
  createdAt: string;                   // ISO-8601
  updatedAt: string;
}
```

`BrowserTab` is the `tab` payload of the three `browser:tab-*` events (§6.5) and, decorated
with `hostConnected` / `hostName?`, the `browser.listTabs` entry. The agent-facing
`listTabs` action (§5.9) projects the same rows into the FE's field names instead
(`mode` + `width` / `height` in place of `emulatedSize`, `ownerAgentId: null` when
unowned) plus `hostClientId` / `hostName?` / `hostConnected`; `displayed?` rides both
projections unchanged.

**`displayed` is process-local, not persisted** ([intent-hq/intent#4835](https://github.com/intent-hq/intent/issues/4835)).
Every other host-reported field is a `browser_tab` column; `displayed` is a layout fact of
the live host process, so the daemon keeps it in a process-local overlay keyed by `tabId`
rather than a column — no schema migration. It is diffed, applied and read back exactly
like the other fields (an identical report is still a no-op; a later upsert / sync that
omits or nulls it **clears** it within the same daemon lifetime, `changes: { displayed:
null }`, and the row reads with `displayed` absent again), and it does not survive a daemon
restart: after a restart every row reads with `displayed` **absent** until its host
re-reports it — which the host's connect-time `browser.syncTabs` does for its whole tab
set, so the fact is truthful again as soon as the host reconnects. Absence therefore always
means "no current report" (unknown), whatever the cause; clients see that rather than a
value the daemon can no longer vouch for, and must not read report history into it. Hosts MUST include
`displayed` on every upsert / sync entry they can compute it for and re-report whenever
the layout fact changes (panel active tab, visibility, workspace layout).

**Host vs. driving client.** A tab's **host** is the physical client rendering it — set
at creation from the reporting connection and only ever changed by the daemon: an agent's
successful `claimTab` re-homes the row to the workspace's **driving client** (§5.9
REV-2 rule order; `browser:tab-updated { changes: { hostClientId, ownerAgentId } }`), and
`workspace.setBrowserClient` (§5.1) moves **every claimed tab** of the workspace to the
new pin (`changes: { hostClientId }` per moved tab; clearing the pin moves nothing).
Unclaimed (user) tabs never move. A host that receives a `browser:tab-updated` naming
another `hostClientId` for one of its tabs stops treating that tab as its own; the new
host materialises it from the canonical row.

**Events (§6.5).** `browser:tab-opened` / `browser:tab-closed` carry `data: { tab }`;
`browser:tab-updated` carries `data: { tab, changes }` where `changes` is the
**field-wise diff** — the host-reported fields that differed (`url`, `requestedUrl`,
`title`, `ownerAgentId`, `ownerAgentName`, `visibility`, `emulatedSize`, `displayed`; a
cleared optional field appears as an explicit `null`) or, for daemon-side re-homing,
`hostClientId` / `ownerAgentId`. All three are **workspace-scoped** (the tab's
`workspaceId`) with actor `{ type: "user", id: <hostClientId> }` — the reporting host —
and are tailed by an ordinary `events.subscribe` on the workspace. A report that changes
nothing emits nothing.

```json
// → host reports a freshly opened agent tab (connection hello'd as clientId "cli-7f3a")
{ "jsonrpc":"2.0","id":80,"method":"browser.upsertTab",
  "params":{ "workspaceId":"ws-abc","tab":{ "tabId":"tab-3","workspaceId":"ws-abc",
    "url":"http://127.0.0.1:5173/","requestedUrl":"http://daemon.localhost:5173/",
    "title":"Dev server","ownerAgentId":"agent-1","ownerAgentName":"Implementor",
    "visibility":"hidden","emulatedSize":{ "width":1280,"height":800 },"displayed":false } } }
// ← { "jsonrpc":"2.0","id":80,"result":{ "tab":{ "tabId":"tab-3","workspaceId":"ws-abc",
//      "hostClientId":"cli-7f3a","url":"http://127.0.0.1:5173/", ..., "createdAt":"…","updatedAt":"…" } } }
// ← every workspace subscriber: browser:tab-opened { tab }
// → an iOS viewer (any client) asks to navigate that tab
{ "jsonrpc":"2.0","id":81,"method":"browser.navigateTab",
  "params":{ "tabId":"tab-3","url":"http://127.0.0.1:5173/settings" } }
// ← the routed navigate action's envelope, from the driving client (the tab is claimed)
{ "jsonrpc":"2.0","id":81,"result":{ "action":"navigate","success":true,"result":{ "url":"http://127.0.0.1:5173/settings" } } }
// ← then, from the host's follow-up upsertTab: browser:tab-updated { tab, changes: { url: "…/settings" } }
// → host reconnects and reconciles its full snapshot
{ "jsonrpc":"2.0","id":82,"method":"browser.syncTabs","params":{ "tabs":[ { "tabId":"tab-3", ... } ] } }
// ← { "jsonrpc":"2.0","id":82,"result":{ "drop":[] } }
```

