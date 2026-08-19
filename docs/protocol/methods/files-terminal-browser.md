> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.9 `browser.*`, `terminal.*`, `file.*` · §5.13 Interactive `terminal.*`.

### 5.9 `browser.*`, `terminal.*`, `file.*`

| Method | Params | Result |
| --- | --- | --- |
| browser.exec | actions (req, non-empty array), tabId?, agentId?, workspaceId? | single action → the action's `{ action, success, result?, error? }` envelope; multi-action → `{ results: [...] }` — **client-callable trigger** whose real work is served by the connected FE via a reverse RPC (`browser.exec`, `id: "rev-<n>"`), see below. Tabs are **agent-scoped**: `claimTab` / `listTabs` scoping / `resizeTab` and the structured ownership errors are FE-enforced — see the tab-ownership block below (monorepo#2857) |
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
> - **`listTabs { scope? }`** — `scope: 'mine' | 'unclaimed' | 'all'` (default `all`).
>   Every returned tab carries `ownerAgentId` (`null` when unowned) plus owner display
>   info, and **sizing info**: `mode: 'native' | 'emulated'` and, when emulated, the
>   current `width` / `height` — so an agent can see a tab's current size before
>   deciding to claim or resize.
> - **Structured ownership errors** — `not-owner` (an op on a tab owned by another
>   agent) and `already-claimed` (a claim lost to an earlier claim) surface as
>   **action-result errors** — inside the per-action `{ action, success: false, error }`
>   envelope, never as JSON-RPC-level errors — and each names the owning agent.
>
> **Viewport sizing invariant.** Unowned (user) tabs are **always native**; agent-owned
> tabs are **always emulated** — the FE applies the size as CDP device-metrics viewport
> emulation, so owned tabs render deterministically offscreen without disturbing the
> user's panel layout. There is no opt-in and no clear/reset op. Agent-issued `openTab`
> accepts optional `width` / `height` and the tab is emulated from creation; omitted
> `width` defaults to a standard desktop viewport of **1280×800**.
> **`resizeTab { tabId, width, height? }`** changes an owned tab's emulated size —
> owner-only (on a non-owned tab it returns the structured `not-owner` error); there is
> no size op for unowned (user) tabs and no reset-to-native form.
>
> **Ownership lifecycle.** Ownership persists when the owning agent completes. Agent
> **deletion destroys all** the agent's tabs — self-opened and claimed alike (there is
> no release-to-unowned path, so no tab ever transitions emulated→native); workspace
> archive/delete discards all tabs. A user "close" of an agent-owned tab is a UI-level
> **hide**, not a destroy: the tab stays alive and continues to appear in `listTabs`
> for its owner. Unowned tabs close/destroy normally.
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

