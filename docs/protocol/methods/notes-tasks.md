> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.2 `note.*` · §5.2.1 `note.lineAttribution.*` · §5.3 `comment.*` · §5.4 `task.*`.

### 5.2 `note.*`

All `note.*` methods require `workspaceId`. All except `list` and `create` additionally require `noteId` (`list` returns every note; `create` mints a new id). The spec note is addressed with the well-known id `"spec"`.

| Method | Params | Result |
| --- | --- | --- |
| note.list | workspaceId (req), projection?: "slim" \| "full" *(v8.1)* | { notes: NoteSummary[] } — **Projection (`projection`, additive within v8.1 — [intent-hq/intentd#1508](https://github.com/intent-hq/intentd/pull/1508), monorepo#3573):** absent / `null` / `"full"` keep the full rows byte-identical to before — **full stays the default**, unlike the v8.0 conversation surfaces, because existing consumers (the iOS client) still read `content` off list rows; `"slim"` serves bounded listing rows with `content` omitted, replaced by `contentPreview` (the first 500 chars, char-boundary safe by construction) plus `contentLength` (total chars — Unicode scalar values, the same unit as the note.listVersions summaries' `contentLength` for the NUL-free content the daemon writes — note.listVersions uses SQL `LENGTH`, which stops at the first U+0000), every other Note field serializing exactly as the full row does — full responses scale with total workspace note content, so note-heavy workspaces tripped the transport's 1 MiB outbound frame warning; any other value is `-32602` (`projection must be "slim" or "full"`), never coerced. Serve-time only — stored rows are untouched. Older-daemon interop: pre-8.1 daemons read only `workspaceId` off `note.list` params and ignore unknown members, so sending `projection: "slim"` to a pre-8.1 daemon is silently ignored and serves full rows (never an error) — clients that need slim rows must gate on `protocolVersion` ≥ 8.1 (or detect `contentPreview` presence on the rows they get back). The note subscription channel gained the same projection in v8.2 — see the `note.subscribe` row in §6.9. -32602 with `error.data.code: "not-found"` when the workspace does not exist (deleted, or never created; monorepo#3404 — previously a best-effort empty list). Task-note rows with `dependsOn` edges carry the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty — see §5.4 task.setRelations). The field is guaranteed only on read/push shapes (`note.get`/`note.list` and the subscription snapshots/deltas they serve); notes embedded in mutation *responses* (e.g. `task.updateNoteStatus`'s `note`, `note.update`'s `note`) may omit it — clients should not patch caches from mutation responses expecting the projection |
| note.get | noteId (req) | { note: Note } — -32602 with `error.data.code: "not-found"` if not found. A task note with `dependsOn` edges carries the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty; read/push shapes only — see the note.list row) |
| note.create | title (req), content?, tags?: string[], parentId?, idempotencyKey? | { note, convertedCount, createdTaskNoteIds, createdTasks, warnings } — within v6.14 ([intent-hq/intentd#1162](https://github.com/intent-hq/intentd/pull/1162), monorepo#2129) the result carries the `@@@task` auto-conversion outcome for the initial content, **additive** over the old `{ note }` shape (clients reading `.note` are unaffected): same shapes and warning contract as the four content-write ops (see "`@@@task` auto-conversion on note writes" below and the `task.convertBlocks` row, §5.4), with all four fields always present (`convertedCount: 0` plus empty arrays when the content converts nothing). `note` is the refetched post-conversion row, so its `rev`/`updatedAt` reflect the conversion write. An `idempotencyKey` replay returns the stored result without re-executing; a replayed key recorded before the conversion fields existed decodes the stored bare note as a zeroed conversion outcome. `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.update | noteId (req); content? or title?/tags?; expectedVersion?: int | { note } — content present → full content replace; else metadata update. `expectedVersion` is a strict compare-and-set on **both** arms: a stale value → `-32005` Conflict with `error.data = { code: "conflict", current }` and no write (§9) — unlike `note.setContent`, the content arm never merges. `-32602` when `content` is the line-numbered `note.read` display (see "Numbered `note.read` display rejected on content writes" below) |
| note.add | noteId (req), content (req), heading?, position?: "end" \| "start" | { ok, ... } — `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.edit | noteId (req), old (req), new (req) | { ok, ... } — first exact-match replacement. `-32602` when `new` is the line-numbered `note.read` display (see below) |
| note.editLines | noteId (req), start (req,int), end (req,int), content (req) | { ok, ... } (1-based inclusive). `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.setContent | noteId (req), content (req), confirmReplacement?: boolean, expectedVersion?: int | { ok, noteId, title, previousTitle?, updatedAt, oldContent?, newContent, convertedCount, createdTaskNoteIds, createdTasks, warnings, rev } (full replace). `rev` (additive) is the note's post-write `rev` — after any `@@@task` auto-conversion refetch — i.e. the value a follow-up conditional write sends as `expectedVersion`; `newContent` is the persisted (possibly merged) text. `expectedVersion` is the base the writer read: absent or equal to the current `rev` → `content` replaces the note as-is; **stale** → the write is **merged, not rejected** (see "Three-way merge on stale `expectedVersion`" below) — the writer's intent (`diff(base → content)`, base = the retained snapshot at that rev) is applied onto the current text, or degrades to last-writer-wins when no snapshot survives for that rev. The reduction guard (`> 50 %` shorter without `confirmReplacement`, `-32603`) is measured `base → content` when a base is recoverable and `current → content` otherwise. `-32005` (no write) in exactly two cases: an `expectedVersion` **above** the current `rev` — a rev this note never served — is rejected immediately, and a bounded read-merge-persist loop (5 attempts) whose every attempt misses its rev gate surfaces the last `Conflict`. `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.updateMetadata | noteId (req), title?, tags?: string \| string[], expectedVersion?: int | { ok, noteId, title?, tags?, updatedAt?, skipped?, reason? } — metadata-only write (no version snapshot); emits `note:updated`. A stale `expectedVersion` → `-32005` Conflict with `error.data = { code: "conflict", current }` and no write (§9) |
| note.delete | noteId (req), expectedVersion?: int | { ok, noteId, deleted } — a stale `expectedVersion` → `-32005` Conflict with `error.data = { code: "conflict", current }` and no delete (§9). Emits `note:deleted`. Deleting a **task note** additionally recomputes + emits `task:ready-tasks-changed` (§6.5) after the `note:deleted`, with the additive trigger `triggeredBy: { noteId, reason: "note-deleted" }` (monorepo#1981; generalized by intentd#1121, monorepo#2006), whenever the delete actually **moves** the ready set: deleting a task that was itself ready drops its id from `readyTaskIds`, deleting the last incomplete task child of a parent readies the parent (tree rule), and deleting a task note that other tasks `dependsOn` keeps the #1981 always-emit contract — the dangling edge counts as unmet, so deleting a previously-`complete` dep drops its dependents out of `readyTaskIds`. The pre-delete and post-delete ready sets are compared, so a delete that provably cannot move the set (e.g. a terminal task nobody depends on) emits no recompute. Deleting a **`complete`** dep also re-announces each dependent task note via `note:updated` (the computed `unmetDependsOn` projection moved, monorepo#1979) after the ready-set event — same ordering as the status-transition path (`task:*` first, dependent `note:updated` last) |
| note.listTasks | noteId (req) | { tasks: [...] } (checkbox/task rows + taskNoteId). Rows with a linked task note also carry the linked task's `dependsOn?` / `conflictsWith?` / computed `unmetDependsOn?` (v6.8; presence-detected, omitted when empty — see §5.4 task.setRelations). A row's `status` word (`done` / `in-progress` / `todo`) is read from the line's checkbox marker; on a row with a `taskNoteId` that marker is the daemon-materialized projection of the task note's status (§5.4 "Linked checkboxes are projections of the task note") |
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

**Three-way merge on stale `expectedVersion` (§5.2 / A5).** `note.setContent`
is **not** last-write-wins and does **not** reject a stale base: the writer
sends the `rev` it read as `expectedVersion`, and when that is **below** the
stored `rev` the daemon recovers the writer's **base** — the retained
`note_version` snapshot for that rev (newest snapshot with `rev <= expectedVersion`,
see "Version history" above) — and applies the writer's intent
`diff(base → content)` onto the **current** stored text with a pure three-way
character merge (Myers hunks per Unicode scalar value, so a merge never splits a
code point). Non-overlapping hunks from either side apply; identical edits apply
once; hunks from both sides that overlap the same base span form one conflicting
cluster rendered as the *current* variant immediately followed by the *incoming*
variant (`WaWb`) — nothing is dropped and no markers are inserted. The one
exception is a conflicting span inside a checkbox marker: it collapses to the
*current* stored side's marker (never a doubled marker such as `[/x]`), so the
line stays parseable. The merge write itself does not re-materialize a
task-linked line — the current marker is materialization's last projection of
the linked task's status, and the next task write (`task.updateStatus`,
`task.update`, `task.updateNoteStatus`, `task.markAsTask`, `task.assignAgent`)
re-projects it. When no
snapshot survives for the stale rev (pruned past the 50-version cap or predating
the note's version history) the write degrades to honest last-writer-wins:
`content` lands verbatim. An absent `expectedVersion`, or one equal to the current
`rev`, skips the merge and replaces the note as-is. An `expectedVersion` **above**
the current `rev` is a rev this note never served, so it is the plain
optimistic-concurrency mismatch: `-32005` carrying the current entity,
immediately and without a write (it is never treated as a stale base that
resolves to the newest snapshot). The merged text is what the
daemon cleans and persists through the normal mutation flow (comment re-anchor,
version snapshot, line-attribution recompute, `@@@task` auto-conversion, one
`note:updated`). Read → merge → persist is atomic per attempt: the persist is
gated on the `rev` that was read, and a concurrent versioned write that lands in
between makes the daemon re-fetch, re-merge against the new current and retry
(bounded, 5 attempts) — `-32005` surfaces only when every attempt misses its gate,
again without a write. In summary: future revision rejects, stale recoverable
revision merges, missing base falls back to last-writer-wins, five gate misses
return `-32005`. The reduction guard is
measured against the writer's base when one is recoverable (so a small edit on a
note that another writer has since grown is not misread as a wipe) and against
the current text otherwise. The content arm of `note.update` does not merge: it is a
plain versioned write that keeps the `-32005` guard on a stale `expectedVersion`.
The surgical mutations run through the same gated loop rather than writing straight
to storage: `note.add`, `note.edit`, `note.editLines`, `task.updateStatus` and
`task.update` on an **unlinked** line apply their transform to the row they read and
persist it via the read-merge-persist loop above with that read's `rev` as the base
(a write that lands in between is merged into on the next attempt, never
overwritten); `task.convertBlocks`, `comment.add` and `task.update` on a **linked**
line (the redirect path, §5.4) persist gated on the `rev` they read and, on a miss,
re-derive from the fresh content (re-convert only blocks still present / re-anchor
the comment / re-resolve the link, the guarded target status and the projected
marker from the fresh parent) instead of merging generated ids or markers — a stale
marker projection is never textually merged onto the current line. All share the
5-attempt bound. `note.restoreVersion` is a deliberate unconditional replacement and
takes no `expectedVersion`.

**Numbered `note.read` display rejected on content writes** (behavior only, no
shape change — [intent-hq/intentd#1688](https://github.com/intent-hq/intentd/pull/1688),
monorepo#4208). The agent-facing `ws.note.read` binding returns two content fields:
`content`, a **display rendering** with every line prefixed by a 4-wide right-aligned
line number (`   1 | text`) so agents can cite lines for `editLines`, and `rawContent`,
the actual Markdown. Writing `content` back verbatim used to persist the prefixes as
literal text (headings, checkboxes and `@@@task` fences all stop parsing), so every
content-accepting write now rejects that shape with **`-32602` InvalidParams** and the
message:

```
Content looks like the line-numbered display returned by note.read (lines prefixed
with `   N | `). Writing it back would corrupt the note's Markdown, so it was rejected
and the note is unchanged. Use the `rawContent` field from note.read (or remove the
`   N | ` prefixes) and retry; wrap intentionally numbered text in a code fence.
```

Guarded params: `note.create` `content`, the content arm of `note.update`,
`note.add` `content`, `note.edit` `new`, `note.editLines` `content`,
`note.setContent` `content`, and — the one non-`note.*` method that materializes
caller-supplied note content — `task.createPrerequisite` `content`
([intent-hq/intentd#1698](https://github.com/intent-hq/intentd/pull/1698),
monorepo#4299; a rejected call creates no child task note). The other `task.*`
methods take no note content: `task.convertBlocks` reads `@@@task` blocks already
persisted through a guarded write, and `task.markAsTask` / `task.update` params are
task metadata or a single checkbox line. The check runs in the service layer before the note is
fetched and before any merge, so a rejected write touches neither the store nor
the merge state (the note is unchanged, no version is appended, no event is
emitted) and applies on every transport, including the FE editor's `note.setContent`
save path. The detector anchors on the **leading run**: the content must open with at
least two consecutive lines of the exact binding shape — a number column that is
exactly 4 wide (leading spaces + digits, unpadded once the number outgrows 4 digits)
followed by `" | "` (or a bare `" |"` for a blank line), with consecutive numbers. Whatever
follows is irrelevant, so `read.content + "\n- [ ] new item"` is still caught; a task
note's read that is only the `--- Task Metadata ---` trailer (empty body) also
counts. A single `N | text` line, ordered lists (`1. first`), GFM table rows
(`1 | Alice`, `| 1 | a |`), 4-space-indented code blocks (`    1 | listing`), `N|x`
without spaces, prose before a numbered run, and numbered listings inside a code fence
do not match. Rejecting (rather than silently stripping prefixes) is deliberate: a
false positive can never destroy legitimate content, and the message names the fix.
Clients that do read-modify-write must use `rawContent` (or `note.get`'s `note.content`,
which is never numbered); intentionally numbered text belongs in a code fence.

**`@@@task` auto-conversion on note writes.** Every content-mutating note write
(`note.add`, `note.edit`, `note.editLines`, `note.setContent`, the content arm of
`note.update`, and `note.create` on its initial content) auto-converts `@@@task` blocks
in the resulting content into linked task notes, and the write's result carries the
conversion outcome: `convertedCount`, `createdTaskNoteIds`, plus (v6.11, intentd#1133)
`createdTasks` — `[{ key?, title, noteId }]` in block order, parallel to
`createdTaskNoteIds` — and `warnings`, both always present (empty arrays when nothing
applies). `note.create` has always converted, but its result carries the outcome only
since v6.14 (intentd#1162, monorepo#2129) — earlier daemons converted and returned only
`{ note }`, silently discarding the warnings. The fence line accepts the optional
`key=` / `dependsOn=` / `conflictsWith=` / `effort=` header attributes with
convert-with-warnings semantics — grammar, resolution order, and warning contract are
documented on the `task.convertBlocks` row (§5.4).

### Revision-safe note pages (prepared additive contract)

**Prepared, not implemented at the pin.** This consistency core is independent of
editor enablement. `notePaging: 1` in `client.hello.server.capabilities` gates the
complete source/context/read, splice/status and bounded subscription contract below;
`noteAnnotations: 1` additionally gates annotation pages. Absence means unsupported:
an old daemon can ignore `page` and return a full Note. Require the expected result
discriminant before admitting a response. Never put a page in `Note.content`, treat
missing content as empty, or pass partial content to a legacy full-content writer.
Omitted `page` retains all existing results and behavior, including stale full-draft
merge, version history, task conversion, anchors and author attribution. `null`,
unknown page kinds and unsupported versions are invalid on supporting daemons.

The prepared core reserves two router methods, plus six staged-operation methods below:

| Method | Params | Result |
| --- | --- | --- |
| note.applySplices | workspaceId, noteId, noteInstanceId, backendId, baseRevision, operationId, expiresAt, payloadDigest, splices (all required; below) | `NoteCommitReceipt`; bounded typed errors, never a full Note |
| note.operationStatus | scope fields, operationId, payloadDigest (inline), or headerDigest plus payloadDigest? (staged) | `NoteOperationStatus`; authorized receipt lookup even after note deletion |

#### Identity, addresses and budgets

`NoteScope = { backendId, workspaceId, noteId, noteInstanceId }`. Capability hello
also supplies `server.capabilities.notePagingBackendId` in the `client.hello` result,
a stable opaque database namespace (survives
ordinary restart; changes on database replacement). `noteInstanceId` is a persistent
incarnation token: deleting/recreating the same note ID cannot reuse it. Tokens and
receipts are scoped to this tuple and the authenticated principal; they confer no
access. Recheck current authorization for every read, retry and status lookup.
For example, the capability subtree is `{ "notePaging": 1, "noteAnnotations": 1,
"notePagingBackendId": "db-a" }`; it is not a top-level hello field or a client
capability. Require exact integer 1 and a nonempty backend ID within the token limit;
a missing/malformed ID or unsupported version disables paging. This ID must equal
`scope.backendId` on every admitted page. Reconnect invalidates in-flight requests;
a changed backend ID invalidates clean caches and retains drafts for reconciliation.
A read-only implementation must omit `notePaging` until its entire contract is ready.
`sourceRevision` is an opaque nonempty string identifying the note's current `rev`
within that incarnation, including metadata-only revision changes. The daemon must
map it losslessly to its existing integer rev; clients compare equality only and
never compute `rev + 1`. It is not the version-history sequence `v`.

All addresses are nonnegative safe integers counting **UTF-16 code units** from
zero in exact canonical Markdown, with half-open `[start,end)` ranges. Unicode
scalars outside the BMP consume two units. Endpoints must not split a surrogate
pair; unpaired surrogates and U+0000 in new source are rejected, never normalized.
CRLF remains two units/two UTF-8 bytes; paging may split CR from LF and reassembly
must retain both. No NFC, line-ending, whitespace, Markdown or entity normalization.
Combining sequences may cross pages. `sourceLength` is UTF-16; the legacy summary
`contentLength` counts Unicode scalars and is **not** an address. Line numbers are
1-based, with LF ending a line; a CR in CRLF is not another line. Rendered-text and
ProseMirror offsets require an explicit source map, never arithmetic substitution.

Version 1 limits (transport limits, not renderer heap or total-note-size limits):

| Quantity | Hard maximum / default |
| --- | --- |
| Source text per page, or total inserted text per inline splice request | 16,384 decoded UTF-8 bytes |
| Complete JSON-RPC request/response or subscription push | 65,536 UTF-8 bytes after JSON escaping, including envelope and ID |
| Error or commit/status receipt envelope | 4,096 escaped UTF-8 bytes |
| Source/context/mapping page items | 128 items (a source page has one segment) |
| Annotation page items / requested disjoint ranges / inline splices | 64 / 32 / 32 |
| Opaque token, ID or revision | 256 decoded UTF-8 bytes each (raw task-link captures below use fragments when longer) |
| Preview text / context scalar string | 512 / 1,024 decoded UTF-8 bytes each |
| Source-page snapshot lifetime | 300 seconds, fixed from first page; no sliding renewal |

Source requests may lower `maxSourceBytes` to an integer in `[4,16384]`; all page
requests may lower `maxWireBytes` to `[4096,65536]` and `maxItems` to `[1,128]`
(annotation maximum 64). Defaults are the maxima. Count the **actual serialized
frame**, not source bytes or a pre-escape estimate. RPC IDs on this opt-in path
are safe integers or strings of at most 64 UTF-8 bytes. Reject oversized requests
before admission. Shrink a response page until every limit holds. A nonempty source
page must advance by at least one scalar; an empty page is valid only at exhaustion.
Variable-size context, mapping or annotation fields are separate paged text/range
references; an oversized item never bypasses a limit or loses data by truncation.
Previews are explicitly `preview` with `truncated: boolean`, not authoritative text.
No operation's total length is limited to a page budget.

#### Source, seek and structural context

Opt in with `note.get { workspaceId, noteId, page: { kind: "source", ... } }`.
A first read has `at?: UTF16Offset` (default 0), `direction?: "forward" | "backward"`
(default forward), and optional `sourceRevision`/`noteInstanceId` expectation.
Forward returns a segment beginning at `at`; backward returns one ending at `at`
(default `sourceLength` when backward and `at` omitted). `at=sourceLength` is valid.
Seek at a split-surrogate offset or beyond the extent is invalid; no silent rounding.
Subsequent requests send `cursor` only, plus identical budgets; first-read addressing
fields with a cursor are invalid. A fresh revision-bound seek may use
`{ snapshotId, sourceRevision, noteInstanceId, at, direction }` instead of a cursor.

```typescript
type NoteSourcePage = {
  kind: "noteSourcePage"; scope: NoteScope; sourceRevision: string;
  snapshotId: string; expiresAt: string; sourceLength: number;
  range: { start: number; end: number }; text: string;
  nextCursor: string | null; previousCursor: string | null;
  contextRef: string; // bounded reference, NOT expanded structure
  metadataRef: string; // separately paged title/tags/task metadata
};
```

There is no `note` or `content` field. `nextCursor === null` iff `range.end ===
sourceLength`; `previousCursor === null` iff `range.start === 0`. Empty source is
`[0,0)`, empty text and both cursors null. Following next concatenates exact source
without overlap/gaps; following previous prepends it. Page sizes need not match in
each direction. Cursors authenticate the scope, principal, sourceRevision,
snapshotId, expiry, index generation, kind, continuation offset/direction and
budgets. They are opaque, not encoded offsets the client may modify. Cross-note,
cross-kind, cross-principal or changed-budget reuse is invalid. Cursors from an old
revision fail `note-page-stale`; expired/restarted/evicted snapshot handles fail
`note-page-expired`. A revision is checked in the same read snapshot as the bytes.
This live paging mode invalidates on any revision advance; it does not retain old
source for arbitrary user delays. Expiry can precede the advertised time on restart
or resource eviction and is always explicit. No long SQLite transaction spans RPCs.

The client cache key includes scope, revision, snapshot and request generation.
Discard late pages after a switch, new revision or cancelled request even if their
text coincidentally matches. On stale/expired, retain dirty state, invalidate clean
pages, acquire a new snapshot and reconcile; never concatenate old/new revisions.
Metadata-only writes conservatively invalidate source pages even if bytes match.
Every legacy content writer, restore, task-marker materialization and comment-anchor
rewrite participates in this invalidation; deletion retires the incarnation.

`note.get { ..., page: { kind: "context", contextRef, cursor?, maxItems?,
maxWireBytes? } }` returns `kind: "noteContextPage"`, the same scope/revision/snapshot,
`items`, `nextCursor` (null at end). Reference and cursor must agree; source-byte
budgets are inapplicable. Context has separate item and wire budgets and is never
hidden inside a source page. Items are discriminated:

- `boundary`: `{ id, sourceRange, construct, parentRef?, continuationBefore,
  continuationAfter, detailRef?, entryPath?, tablePosition?, htmlPosition?, htmlSource?, attributesRef?, nativeRef?, sourceMapRef? }`. `construct` is a syntax category, not an editor
  node ID; `detailRef` pages large opening syntax, attributes and ancestor chains.
- `span`: `{ id, sourceRange, role, parentRef?, detailRef?, codeSource?, nativeRef?, sourceMapRef? }` for marks, delimiters, literals,
  comment markers and structural seams. IDs are snapshot-local; identical text at
  another address has another ID. `role` distinguishes source-bearing text from
  zero-width editor projections; it never fabricates source bytes.
- `sourceMap`: the window-bound canonical HTML/inline-code raw-to-rendered mapping described
  below; it never replaces canonical source pages.
- `nativeNode` and `sourcePiece`: the bounded canonical tree and provenance
  descriptors below, distinct from text mappings and session-native editor IDs.
- `fragment`: `{ id, field, offset, text, nextRef }` pages descriptor strings,
  including huge URLs/languages/attributes, with scalar-safe UTF-16 field offsets.
  `nextRef` is null at field exhaustion. Fragment text obeys the source-text limit.

Context enumeration is deterministic `(sourceRange.start, sourceRange.end, id)`
for boundaries/spans; fragments follow increasing offsets. A descriptor's range
may exceed the source page; its content must not be inlined. Ancestor references
and traversal are bounded per request, not recursive expansion. Context can cover
fences, nested lists, tables, inline marks and note primitives across any transport
seam. Consumers reconstruct source exactly and obtain the required bounded lexical
context before parsing a window; they must not parse each page as a standalone
Markdown document or fetch a whole giant construct to repair a boundary. Unknown
construct support is an integration obligation, not permission to silently omit it.
Live native table owners/seams are editor-session metadata, not durable global block
IDs or inferred fresh canonical structure.

Context version 1 uses these wire spellings (not library enum/debug strings):

| Field | Vocabulary / meaning |
| --- | --- |
| boundary.construct | `paragraph`, `heading`, `blockquote`, `codeBlock`, `list`, `listItem`, `table`, `tableHead`, `tableRow`, `tableCell`, `emphasis`, `strong`, `strikethrough`, `link`, `image`, `htmlBlock`, `footnoteDefinition`, `definitionList`, `definitionListTitle`, `definitionListDefinition`, `superscript`, `subscript`, `metadataBlock`, `htmlTable`, `htmlTableRow`, `htmlTableCell` |
| span.role | `text` (source text), `code` (inline code), `literal` (raw HTML/literal syntax), `commentMarker` (canonical anchor marker syntax), `lineBreak` (soft/hard break syntax), `rule`, `taskMarker` (checkbox syntax), `delimiter` (explicit syntax delimiter), `projection` (zero-width editor seam) |

Every item has its `kind` discriminator. Ranges address original source even when
parsed semantic attributes decode escapes; `projection` must have an empty range.
`continuationBefore`/`continuationAfter` mean the full construct starts before/ends
after the source range associated with contextRef. A parentRef resolves with the
same context request shape to its parent descriptor; detailRef resolves to a
**directory of field fragments**, not a JSON-serialized parser object. Parent and
detail references share scope/revision/snapshot/expiry and never cross an incarnation.
The transport preserves unknown future construct/role values opaquely; a renderer
that cannot interpret one must declare it unsupported, never silently drop it or
claim that arbitrary parser grammar has been implemented. Notes primitives require
an explicit renderer mapping; this vocabulary alone is not that mapping.

**Paragraph document entry path (additive, presence-detected).** An ordinary
lexical `boundary` with `construct: "paragraph"` may include
`entryPath: "markdown" | "html"`. This classifies the **whole document's parser
entry**, not the paragraph's syntax or its `contentType` metadata. The source index
computes it from the complete source under the canonical entry policy: after
applying ECMAScript `String.prototype.trim()` (including U+FEFF, excluding U+0085),
a leading `<` selects HTML unless it starts `<!--anchor:` or the complete source
contains the literal, case-sensitive substring ```` ```ws-block ```` anywhere
(not only at a parsed fence boundary); otherwise entry is Markdown. The existing empty-document
special cases remain unchanged. Consumers must use the indexed decision rather
than scanning a loaded prefix or interpreting `construct: "paragraph"` as Markdown.
A later fenced primitive opener can change the decision even outside the window.

The field shares the descriptor's scope, source revision, snapshot, incarnation
and original expiry. A source change or entry-policy/profile change invalidates
the derived projection through the existing revision/profile rules; reading the
field never renews its lifetime. It is available with bounded paragraph context
at a far source offset without hydrating the document. Absence means **unknown**
(for example an older producer), never an implicit `"markdown"`; `null`, arbitrary
strings and non-string values are invalid when the field is present.

This addition preserves `construct: "paragraph"`, `sourceRange`, `detailRef`, and
the exact raw `openingSource`/`closingSource` field fragments. It does not alias a
paragraph to a canonical native owner, introduce `markdownBlock`, or grant a
native tree, source map, profile or safe-edit proof. A consumer still needs its
own validated source/native projection and complete required lexical context
before serializing an edit. An absolute-zero loaded-source fallback does not
establish support for far paragraphs. No method or capability is added, and the
existing full `notePaging: 1` activation gate remains unchanged.

**Absolute table addresses.** Version-1 `tableHead`, `tableRow` and `tableCell`
boundaries also require an inline `tablePosition`; other constructs omit it:

```typescript
type TableRowPosition = { tableRef: string; rowIndex: number };
type TableCellPosition = TableRowPosition & {
  columnIndex: number; alignment: "none" | "left" | "center" | "right";
};
// tableHead/tableRow use TableRowPosition; tableCell uses TableCellPosition.
```

All ordinals are nonnegative safe-integer JSON numbers (not decimal strings).
`rowIndex` is absolute within the owning canonical table: its one `tableHead` is
row 0, the first body `tableRow` is row 1, and later body rows increment by one.
The Markdown delimiter/alignment line is not a row. `columnIndex` is zero-based
within that row, resets on each new row, and counts canonical parser cell events,
including empty cells that the existing GFM parser projects for short rows.
A cell in the header has rowIndex 0. Independent tables reset row/column ordinals;
nested/outer owners, where represented, never share counters. Repeated cell text,
source-piece boundaries, viewport seeks and continuation flags do not change an
address. Scalar-safe sourceRange still identifies this cell's source extent; it
may be empty for an empty cell and cannot be used to infer an ordinal.

`tableRef` is a bounded opaque **context reference to the owning table boundary**,
not its item ID, a source offset, a mutable global block ID or a preceding-row
cursor. Read it with `note.get { ..., page: { kind: "context", contextRef:
tableRef, ... } }`. Every address of that table in the same snapshot/window uses
the same tableRef; all refer to the same boundary identity. Reference bytes may
differ between windows; resolve the table boundary id within the same scope and
snapshot to compare those owners, never compare against a live editor node ID. A reference cannot
cross scope, sourceRevision, snapshot, principal or expiry; any continuation cursor
must agree with the supplied reference. ParentRef remains the direct structural
parent (a cell's row/header), with its existing semantics. A tableRef may resolve a
huge table range, but does not include the table's children, row sources, alignment
array or body. Revision advance invalidates both position and reference, even if
source happens to look identical. Reacquire the context; do not patch ordinals
from another snapshot or renumber only the currently loaded rows.

Cell-local `alignment` is the owning table's canonical column alignment, equal to
its `alignment:N` detail for N=columnIndex. `none` means no explicit alignment;
clients must not relabel it as explicit left alignment. This fixed-size value is
inline so a far column never requires enumerating earlier alignment fields.
Together, tableRef/rowIndex/columnIndex/alignment identify a far cell without
loading its earlier siblings, preceding row source, header source, whole table or
full alignment directory. The producer maintains this metadata when indexing the
revision, not by scanning a prefix on each read. TablePosition and its enclosing
frame still count toward item/token/complete escaped-wire budgets. It cannot grow
with the unloaded prefix, and page construction must shrink items if necessary.

This address contract describes the existing canonical GFM **unit-cell** table
representation. It introduces no rowSpan/colSpan fields, merged-cell grammar or
synthetic covered cells. HTML uses the separate canonical profile below; never
reuse GFM header/body ordinals for HTML or infer canonical spans from raw
HTML attributes or live editor geometry.
A reader missing a required position or unable to handle the represented grammar
must report the unsupported projection,
not fetch a preceding/full source fallback or silently guess column zero. Legacy
complete Note reads and writer/canonical-reload behavior are unchanged. Native
session seams/owners remain separate from these revision-local source addresses.

**Canonical HTML continuation.** The separate `canonicalNote` profile describes
the existing `NoteWithComments` load path: `processMarkdownToHTML` with anchor
preservation and workspace identity, `sanitizeMarkdownHTML`, then the registered
`createEditorConfig` schema. It is not unsanitized DOM parsing or a new Markdown
dialect. Version 1 is explicit as `profileVersion: 1` on HTML positions and maps; it
preserves the entry-path outcomes in these fixtures. Unknown versions are not
interpreted as version 1. The index also records the concrete parser/sanitizer/schema
build identity and relevant options in its internal profile revision; changing the
parser, sanitizer, schema or their relevant options invalidates that index and its
references before serving the new profile (`note-page-expired` for retired profile
resources, even if raw sourceRevision is unchanged). A change to the normative
projection behavior requires a new profileVersion, not silent reuse of version 1.
Producer/consumer implementations must pin and differentially test this profile,
including the existing conditional note
primitive extensions. Naming the profile does not establish implementation parity.

The current canonical sanitizer removes `colspan`/`rowspan`; canonical cells are
unit cells. Native `mergeCells` may produce spans in the live editor, while the
existing HTML-to-Markdown serializer emits GFM and fresh reload loses those spans.
This contract preserves those distinct outcomes. It never promotes a raw HTML span
attribute to canonical geometry or promises new durable merged-table persistence.
Even unit cells need indexed context: an extra earlier cell can change a far cell's
column while its source offset, source length and visible literal text are identical.

HTML table boundaries use `htmlTable`, `htmlTableRow`, and `htmlTableCell` rather
than GFM constructs. They require these bounded fields:

```typescript
type HtmlPosition = {
  profile: "canonicalNote"; profileVersion: 1;
  tableRef: string; // direct context reference, including on the table itself
  rowIndex?: number; // required on row/cell, absent on table
  columnIndex?: number; // required only on cell
  cellRole?: "data" | "header"; // required only on cell: native td / th role
};
type HtmlSource = {
  provenance: "explicit" | "implicit" | "repaired";
  openingRange: { start: number; end: number } | null;
  bodyRange: { start: number; end: number } | null;
  closingRange: { start: number; end: number } | null;
  piecesRef?: string; // required for repaired/noncontiguous source provenance
};
// Required on each HTML table boundary, alongside parentRef/detailRef:
// htmlPosition, htmlSource, attributesRef, nativeRef.
// sourceMapRef and continuation flags are required only on a window occurrence.
```

Ordinals are nonnegative safe integers in the **canonical schema output**, with
every row starting at 0 regardless of header/data role. `thead`/`tbody`/`tfoot`
wrappers are not rows; a header cell need not be in row 0. Column ordinals reset
per row and table owners reset for independent or nested tables. Direct tableRef
resolves exactly that table boundary; a cell's parentRef resolves its row. No raw
tag count, preceding-row scan, whole-grid enumeration or range-order inference is
a substitute for these indexed addresses. The canonical address has no span fields.

`sourceRange` is the exact raw envelope of an explicit source construct. An
implicit source-less node instead has an explicitly identified empty projection
anchor, not fabricated markup. Its anchor is the least source start among mapped
canonical descendants; if none exists, the end of the nearest source-bearing
ancestor's opening syntax, or 0 if no such ancestor exists. This rule is resolved
at indexing time, not by descendant traversal during reads. `htmlSource` ranges address original scalar-safe
UTF-16 source and are contained in that envelope. `bodyRange` excludes opening and
closing syntax, but includes original child markup; it is not decoded text. Null
means no corresponding contiguous literal range exists. Missing end tags and
reparented/implicit schema nodes must carry their actual provenance; a repaired
envelope never licenses rewriting that source. For repaired/noncontiguous nodes,
sourceRange is only the hull of mapped source pieces, not ownership of every byte
in that hull. Required piecesRef pages `sourcePiece` records with `{ id, nodeRef,
sourceRange, role }`, where role is `opening`, `body`, `closing`, `attribute` or
`omitted`. Ranges are exact, scalar-safe, nonempty source pieces, ordered by
`(sourceRange.start, sourceRange.end, id)`; parent/child provenance may overlap but
one node's traversal never duplicates a piece. Missing literal syntax has no piece.
When no piece exists, the repaired node uses the same empty-anchor rule as an
implicit node. Explicit/implicit nodes omit piecesRef. Attribute source ranges and values
page through detail references separately from effective attributes. Unknown or
unsupported projections must be reported explicitly, never silently represented
as successfully rendered literal text. This diagnostic does not satisfy native
rendering acceptance; supported malformed-input behavior follows the same existing
pipeline, not a new coercion or rejection policy invented by this transport.

`attributesRef` resolves with `page: { kind: "metadata", ref: attributesRef, ... }`
to the existing bounded metadata-tree shape. It has the distinct resource namespace
`context.attributes`, never the note metadata root. It contains effective schema
attributes after sanitization, not raw opening tags. Large primitive payloads,
column-width arrays, URLs and strings remain separately pageable tree branches;
clients may not drain the entire tree to admit a window. These resources share
source snapshot lifetime; the existing conservative metadata-write invalidation
still applies. Raw attribute spelling, quotes and stripped values remain exact
source provenance and must not be reconstructed from these effective values.

`sourceMapRef` resolves through `page.kind: "context"` to source-map items for the
**original admitted source window**, including necessary seam segments. Its opaque
identity binds window, owner, profile and source snapshot. Resolving it does not
enumerate a whole giant body or its preceding text. A subsequent seek obtains a
new window-bound reference; an owner identity alone is not a map-page selector.
The HTML boundary id, table/parent/native/attribute/detail references and provenance
are immutable and reusable within the snapshot. Only sourceMapRef and continuation
flags vary by admitted window. Consumers compare immutable owner fields separately
and retain map bindings under `(snapshot, window, owner)` even after owner deduplication.
Two windows in the same giant cell must neither conflict on owner identity nor
reuse the other's map binding. This HTML rule does not change GFM reference semantics.

Resolving a snapshot-stable HTML owner reference (tableRef, lexical parentRef or
an equivalent direct owner reference) returns exactly its immutable boundary
without `sourceMapRef`, `continuationBefore` or `continuationAfter`. These fields
are absent, not null or false: a direct owner request admits no source window.
The same direct request gives the same descriptor regardless of earlier, concurrent
or reordered source-window requests. It must not use connection-local last-window
state or attach an arbitrary window's mapping. By contrast the original source
page's window-bound contextRef returns boundary **occurrences** with all three
fields required. This distinction is determined by the scoped reference's resource
kind, not by client guesses from the opaque bytes; scope/revision/snapshot and
cursor validation apply to both. A consumer stores stable owner descriptors once
and retains each occurrence's map binding separately. Resolving a stable owner
cannot acquire a new mapping: seek the desired bounded source window and use its
contextRef. Direct-owner response cursors never change their resource kind or gain
a window. No new request parameter, implicit server session state or enlarged
frame budget is introduced.

```typescript
type CanonicalSourceMapItem = {
  kind: "sourceMap"; id: string; profile: "canonicalNote"; profileVersion: 1;
  ownerRef: string; textNodeId: string | null; textNodeRef: string | null;
  sourceRange: { start: number; end: number };
  renderedRange: { start: number; end: number };
  mapping: "identity" | "entity" | "normalized" | "omitted" | "projection";
  textRef: string | null;
};
```

ownerRef identifies the snapshot-stable **source-container boundary or inline-code span** whose
window issued the mapping. It is not a claim that the text remains a canonical
descendant of that source container: HTML repair/foster parenting can move it.
textNodeRef, parentRef and childIndex supply canonical ownership independently;
neither raw containment nor the old source table determines that ancestry.
Rendered offsets are scalar-safe UTF-16 within **one immutable canonical TipTap
text leaf after schema/whitespace normalization**, identified by textNodeId. ownerRef identifies source ownership independently.
They are neither raw DOM textContent offsets nor document-wide ProseMirror
positions. The latter include atoms and wrapper positions and remain session-owned.
An identity segment preserves text and length; an entity segment is an indivisible
raw-to-decoded mapping; normalized segments record actual canonical normalization.
Omitted source has an empty rendered range and null textRef; when there is no
corresponding text leaf, textNodeId is null and renderedRange is `[0,0)` rather
than naming a fabricated leaf; textNodeRef is also null in that case. All
non-omitted segments require a real textNodeId and a direct textNodeRef resolving
its `nativeNode` descriptor (the returned id equals textNodeId).
A source-less projection has an empty source range. Nonempty rendered segments use a bounded context fragment
resource `field: "renderedText"` whose offset 0 is the start of that segment, not
the whole leaf. The resolved text length equals renderedRange length.
Each complete renderedText resource is at most 16,384 decoded UTF-8 bytes, even
when a smaller requested budget splits it into several fragment frames. This is a
per-segment resource limit, not only a per-frame limit. Identity and large
normalized runs must be indexed into scalar-safe bounded segments/checkpoints;
a far-window map cannot point to an earlier giant segment and make the consumer
drain preceding rendered text to reach its window. Returned identity/omitted ranges
are clipped to the admitted window; genuinely non-bijective normalization/entity
seams retain their exact raw range and endpoint affinities. A long collapsed raw
whitespace run may have a large raw range and one bounded rendered space; locating
that seam uses the index, not a read-time scan of that run. Nonempty rendered ranges
are capped by the resource's actual UTF-8 bound, not merely its UTF-16 length.
Window intersection and required seams select checkpoints by index. Resolved
rendered offsets remain absolute within the canonical text leaf, while textRef
fragment offsets start at zero in the bounded segment. Repeated requests may
use the same indexed segments when appropriate; none requires prior-window state.
Repeated strings have distinct source identities; source-copy/search/edit coordinates always
use raw ranges. Selection affinities choose declared segment endpoints for
non-bijective mappings, never interpolate an offset inside an entity or invent
source bytes. Maps enumerate by `(sourceRange.start, sourceRange.end, id)`; browser
repair may reorder rendered leaves, so rendered order must not be inferred from it.
Map references reject other owners/windows/profiles/snapshots and stale revisions;
stable node, attribute and provenance references remain reusable in that snapshot.
item, token, decoded-fragment and complete escaped-wire limits are unchanged.

`nativeRef` resolves through `page.kind: "context"` to exactly the associated
canonical node descriptor, without expanding its children:

```typescript
type CanonicalNativeNode = {
  kind: "nativeNode"; id: string; profile: "canonicalNote"; profileVersion: 1;
  nodeType: string; nodeClass: "container" | "text" | "atom";
  parentRef: string | null; childIndex: number;
  sourceRange: { start: number; end: number };
  provenance: "explicit" | "implicit" | "repaired"; sourcePiecesRef?: string;
  attributesRef: string; marksRef?: string;
};
```

nodeType is the existing schema name (at most 1,024 UTF-8 bytes); nodeClass follows
that schema. parentRef is another direct native-node reference, null only on the
canonical `doc` root (childIndex 0). childIndex is a nonnegative safe integer in
the parent's **rendered schema children**, including text and atomic nodes. It is
not a raw-source ordinal or an offset into only loaded children. Together with
parentRef it establishes rendered ancestry/order without scanning siblings, even
when repairs reorder source. id is snapshot-local, never an editor-session node ID.
Canonical parent references are acyclic, and each `(parent node id, childIndex)`
has one child. They are distinct from lexical boundary.parentRef (for example,
HTML cell to table row versus text leaf to schema paragraph). Empty-anchor
fallback walks strictly toward a source-bearing ancestor/root at index build time;
it cannot cycle through projected children.
Provenance/envelope/anchor/sourcePiecesRef obey the same rules as HTML boundaries.
attributesRef and optional marksRef use `context.attributes` metadata trees; marks
are the ordered schema mark array, including each mark's type and attributes.
Atoms carry their real nodeType and paged attributes and have no fabricated text
leaf, rendered-text map or recursive inline payload. Text nodes resolve their
admitted text through window maps rather than a complete-leaf text property.

The original source-context query includes canonical owners of intersecting mapped
pieces, text/atomic descendants admitted by that window, and the necessary ancestor
closure. Membership is indexed by projection ownership, **not** solely by overlap
with descriptor sourceRange. Thus an implicit row/paragraph outside the far window,
or a reparented ancestor with no overlapping literal range, remains discoverable.
All descriptors still paginate under the same item/wire bounds; direct refs permit
targeted resolution without loading sibling directories or a whole subtree.

Native descendants, marks, ancestors and atomic note primitives retain their
existing typed schema ownership and paged detail/attribute resources. A cell body
range alone is not permission to flatten block content or drain a large primitive
attribute. Incomplete tags, implicit nodes, nested tables, empty/repaired cells,
entities, CRLF and sanitizer removals require differential source-map fixtures
against the actual profile before an adapter claims support. Index construction
and invalidation cost are measured separately; ordinary reads must use indexed
owners, interval overlap and checkpoints rather than scanning unloaded prefixes.

**Canonical Markdown inline-code continuation.** General Markdown `span.role:
"code"` reuses the same canonical profile, native-node, mark, mapping and fragment
resources; it is not an HTML table or a new rendering grammar. Each code span
requires these snapshot-stable fields:

```typescript
type CodeSource = {
  profile: "canonicalNote"; profileVersion: 1;
  openingRange: { start: number; end: number };
  bodyRange: { start: number; end: number };
  closingRange: { start: number; end: number };
};
// On span.role=code: codeSource: CodeSource; nativeRef: string | null.
// sourceMapRef: string is required on window occurrences, absent on direct owners.
```

Ranges are scalar-safe absolute UTF-16 addresses in original source. The nonempty
opening and closing ranges identify the exact matching backtick runs, have equal
length, and together with the untrimmed body partition sourceRange contiguously.
No delimiter bytes or entire body are inlined; enormous runs remain constant-size
addresses. An unmatched run is ordinary source under the existing parser, not a
fabricated code span. Delimiter/body addresses are computed at indexing time;
clients never scan a prefix to determine delimiter length or trim state.

nativeRef resolves the canonical text leaf carrying the existing `code` mark;
its marksRef retains all actual ordered schema marks. If canonical parsing emits
no code leaf, nativeRef is null and no leaf or code mark is invented. Adjacent
source constructs may share one canonical leaf after normalization; source owners
remain distinct and each map uses the actual leaf-local rendered offsets. The
window's maps identify raw delimiters, trimmed/removed body and normalization
seams as omitted or normalized segments. The all-space example `before ` followed
by a single-backtick-delimited three spaces and ` after` canonically becomes the
unmarked text `before after`, although a Markdown parser alone retains code spaces.
Repeated delimiters embedded inside the body are content when the canonical parser
says so; newline/CRLF normalization and surrounding trim follow the complete
Markdown-to-HTML, sanitizer and native schema pipeline, not a parser event payload.

A far window wholly inside a giant opening delimiter receives the code owner and
bounded omitted mapping; it must not fetch the whole opening run or fabricate a
visible code node. A body window receives scalar-safe bounded maps plus direct
native/mark ownership, including required schema ancestors, with no earlier-body
reads. sourceMap.ownerRef may resolve the stable code span; that lexical ownership
is independent of canonical parentRef/childIndex. The stable direct-owner response
omits sourceMapRef just as HTML direct owners do. Code spans have no continuation
flags; their exact ranges provide the source relation. Window context cursors and
map refs bind the admitted window/profile/scope/revision/snapshot; direct code
owner/native/mark refs bind the source snapshot and expire under the same profile
or source invalidation rules. This addition changes no source, copy format,
persistence, canonical parser or session-live editing policy.

Session-native merged ownership remains in the frozen operation `live` stream,
bound to editorSessionId/localEditSequence/liveGeneration. Its effective grid
origin, covered-cell ownership and span attributes must come from that frozen
native state, never canonical HTML attribute guesses. Covered positions identify
the real owner, including spans originating above a window; bounded intersecting
owner queries must not expand rows times columns or fabricate covered source cells.
Existing session history/eviction guarantees and fresh reload differences remain
unchanged. Canonical context cannot be silently relabelled as live context.

Each detail directory item is `{ kind: "fragment", id, field, offset: 0, text:
"", nextRef }`; it is an indirection descriptor (empty text is not the value).
Follow its nextRef through `page.kind: "context", contextRef: nextRef` to the
field resource. A field resource emits fragment items with increasing scalar-safe
UTF-16 offsets, a stable `field` name and exact string slices; concatenate only
within that field/resource. Empty values have one offset-0 empty fragment and
null nextRef. A nonempty value fragment advances; nextRef points to the next field
offset or is null exactly at exhaustion. No indirection cycles or zero-progress
field continuations. The item's `id` identifies that snapshot-local item, not the
field value or a durable document node. `nextCursor` enumerates the current
collection only; it is independent of the per-field `nextRef`. Never infer that a
field ended from a collection cursor being null. Directory entries order as below,
then each repeated indexed family by numeric suffix; no map-key iteration ambiguity.
All context responses retain the existing scope/revision/snapshot/expiry header.
Sum of decoded fragment text on one frame is at most 16,384 bytes; complete wire
and item budgets still apply, including directories and escaped fragment bodies.

| Detail field(s), in directory order | Encoding |
| --- | --- |
| `openingSource`, `closingSource` (every boundary, first) | Exact raw prefix before the first direct child event and suffix after the last direct child event, within the full boundary range. Without children, openingSource is the full range and closingSource is empty. Not rendered text and not an entire child/body serialization. Large prefixes still page. |
| HTML boundary: `rawAttributeStart:N`, `rawAttributeEnd:N`, `rawAttributeName:N`, `rawAttributeValue:N?` | Zero-based lexical attribute order. Start/end are unsigned decimal UTF-16 offsets of the complete original attribute spelling, excluding surrounding inter-attribute whitespace. Names/values are raw slices, not entity-decoded effective schema attributes; value excludes its quotes and is omitted when absent, including boolean attributes. Each family is ordered as listed, then by N. Large values page normally; consumers do not drain unrelated fields. |
| codeBlock: `codeStyle`, `info` (info only if fenced) | `fenced` or `indented`; info is parsed fence info text, not JSON |
| list: `listStart` | `unordered` or unsigned decimal initial ordinal |
| table: `alignment:N` | Zero-based column; `none`, `left`, `center`, `right` |
| link/image: `linkType`, `destination`, `title`, `referenceId`, `hasPothole?` | linkType is `Inline`, `Reference`, `ReferenceUnknown`, `Collapsed`, `CollapsedUnknown`, `Shortcut`, `ShortcutUnknown`, `Autolink`, `Email` or `WikiLink`; destination/title/referenceId are parsed strings, possibly empty, never quoted JSON strings. Only WikiLink includes required `hasPothole`, after referenceId: the string `"true"` when an explicit pipe separates destination and label, otherwise `"false"`. Other link types omit it; never emit library Debug enum text. |
| heading: `level`, `headingId?`, `class:N`, `attributeKey:N`, `attributeValue:N?` | level `h1`–`h6`; zero-based class/attribute order, optional absent value remains absent (not empty); each attribute key precedes its optional value |
| footnoteDefinition: `label` | Parsed label string |
| blockquote: `quoteKind?` | Optional `Note`, `Tip`, `Important`, `Warning`, `Caution` |
| metadataBlock: `metadataStyle` | `YamlStyle` or `PlusesStyle` |

Metadata keys/values below use fragment fields `key`/`value`; ordered task-link
captures use `taskNoteId`. Those field resources have the same offset/budget rules
without a boundary directory. Details are a lexical parsing aid, not replacement
source: exact copy and source maps use canonical source ranges, never reconstructed
Markdown from decoded attributes. The fixture file includes full context RPC
frames with a descriptor directory, a multi-fragment destination and empty values.

`note.get { ..., page: { kind: "metadata", ref: metadataRef, cursor?, maxItems?,
maxWireBytes? } }` returns `kind: "noteMetadataPage"`, the same scope/revision/snapshot,
`items` and `nextCursor`. Its projection includes title, tags, parent and task metadata
(including relation arrays), excluding content and annotation collections. Metadata
uses indexed tree entries `{ id, parentId, key?, keyRef?, index?, type, value?,
valueRef?, childrenRef? }`: root parentId is null; exactly key or keyRef addresses an
object member, index addresses an array member. `type` is object/array/string/number/
boolean/null. Object/array children page through childrenRef; string values page
through valueRef using context fragments; numeric/boolean/null values are inline.
Keys up to 1,024 UTF-8 bytes may be inline; longer keys use keyRef. Node IDs/references
obey token limits. No title, tag, task relation array or arbitrary metadata object
is a full-row exception. Children enumerate object keys lexicographically and array
indices numerically, with immutable snapshot-local IDs. An entry is returned exactly
once per parent traversal; clients need not hydrate siblings to inspect one branch.

#### Ordered task-link summary

`notePaging: 1` also gates `note.get { workspaceId, noteId, page: { kind:
"taskIds", sourceRevision?, noteInstanceId?, snapshotId?, maxItems?, maxWireBytes?
} }`. This is a canonical-source summary for any note, especially the spec. It
replaces full-spec hydration for sidebar ordering, not the distinct checkbox/task
rows of legacy `note.listTasks` or the workspace membership of `task.list`.
A first request without snapshotId acquires its own live source snapshot. With
snapshotId it must supply sourceRevision and noteInstanceId from that snapshot;
there is no requirement to fetch a source body first. Continuations send only
`kind: "taskIds"`, `cursor` and the identical budgets. Source lifetime, scope,
principal, sourceRevision and incarnation checks are the same as source pages.

```typescript
type NoteTaskIdsPage = {
  kind: "noteTaskIdsPage"; scope: NoteScope; sourceRevision: string;
  snapshotId: string; expiresAt: string; totalItems: number; startIndex: number;
  items: Array<{
    index: number; sourceRange: { start: number; end: number };
    taskNoteIdLength: number; // UTF-16 length of the entire raw capture
  } & ({ taskNoteId: string; taskNoteIdRef?: never }
    | { taskNoteId?: never; taskNoteIdRef: string })>;
  nextCursor: string | null;
};
```

The summary is the exact lexical result of the existing frontend
`extractOrderedSpecTaskIds` / `TASK_LINK_REGEX_FLEXIBLE`, not a Markdown AST query:

```javascript
/\[([^\]]+)\]\(intent:\/\/local\/task\/([^)]+)\)/g
```

Scan the whole raw source left to right with this ECMAScript global expression
(no extra flags); take the second capture, keep its first occurrence, and deduplicate
by exact string equality. Labels and IDs are nonempty. Include prose, every match
on one line, link-shaped code/image text, and any whitespace/newlines or escapes
accepted by that expression. Do not trim, URI-decode, case-fold, normalize, require
UUIDs, validate existence, or include workspace-qualified URLs that do not match.
Encoded IDs and decoded IDs are different; a duplicate on another source page does
not reappear. Splitting a link across source pieces cannot change membership.
`sourceRange` addresses the **second capture only**, at its first occurrence, in
UTF-16 canonical-source offsets; it is neither the label nor the whole link range.

`totalItems` is the exact deduplicated count, a safe integer maintained in the
revision's index. `startIndex` is the first ordinal on this page, from zero;
item indices are contiguous. `nextCursor` is null iff
`startIndex + items.length === totalItems`. A non-exhausted page must advance.
An empty summary returns startIndex/totalItems 0, empty items and null cursor.
A valid exhausted traversal returns startIndex equal to totalItems. No arrays of
all IDs or source content are hidden in headers. Item and complete escaped wire
budgets apply independently; the request may lower either. Indexed membership,
first-position, deduplication and totals are daemon obligations, not permission
to read/regex-scan the whole source on each page request.

Raw captures up to 256 decoded UTF-8 bytes use `taskNoteId`. Longer captures use
only `taskNoteIdRef`, a bounded opaque reference, and `taskNoteIdLength`; the raw
capture is not an opaque ID subject to truncation/rejection at 256 bytes. Read it
with `note.get { ..., page: { kind: "context", contextRef: taskNoteIdRef, ... } }`:
fragment field `taskNoteId`, offsets starting at zero, exact decoded text, and
scalar-safe continuation until length/exhaustion. It retains the same live
snapshot/scope/revision/expiry. Long IDs may require many fragments; they never
increase the frame bound. Reference identity alone is not task-ID equality.

A source or metadata revision change invalidates summary pages and ID fragments
(including after task conversion/marker projection); a comment-only epoch advance
does not. Reacquire after stale/expired and replace the old sequence only from the
new revision, never append it. FE cache ownership also includes request generation:
late pages after reconnect, note/workspace switch or cancellation cannot reorder the
current sidebar. Exhaustion distinguishes a complete empty result from not loaded;
never use partial page length as the total. Dirty local edits/history stay separate;
this endpoint promises canonical-source order, not an uncommitted session overlay.
Old daemons keep the existing full-spec compatibility path. `note.listTasks` and
`task.list` results remain unchanged; they are not substitutes for this summary.

#### Partial mutations and authoritative outcomes

`splices` is a nonempty ascending array of `{ start, end, text }`, all addressed
against **one baseRevision**, not sequential intermediate source. Validate every
range and replacement before writing. Require `0 <= start <= end <= sourceLength`,
scalar-safe endpoints, `previous.end <= next.start`, and strictly increasing starts.
Thus touching replacements are legal; two inserts at the same point or an insert
at another splice's start are ambiguous and rejected. An insert at its predecessor's
end is legal. Apply conceptually from right to left. At the caller-edit stage, source outside these
ranges remains byte-for-byte identical. The separately identified canonical-effect
stage below can change other ranges under existing note semantics; the final
receipt never conceals those changes as caller splices. Repeated text is addressed by position,
never a first-text-match search. Stale base rejects the entire batch; no automatic
three-way merge on this method and no partial mutation on overlap/validation failure.

**Numbered-read guard on logical replacements.** For a newly executed
`note.applySplices` batch, apply the existing unchanged numbered `note.read`
presentation detector above to each `splices[].text`, just as `note.edit` guards
its `new` parameter. If any replacement matches, reject the whole batch with
`-32602` InvalidParams before source, history, indexes or canonical effects mutate.
Do not strip prefixes, rewrite replacement bytes or change the payload digest.
Do not scan the assembled callerResult as an additional guard, inspect untouched
base text, or combine independent splices to detect a new leading run. A surgical
edit of existing numbered-looking source is not rejected solely because that base
already has the display shape. The detector's existing leading-run/trailer behavior
and false-positive policy remain unchanged; this is not a ban on ordinary ordered
lists, tables or single numbered lines.

Staged dirty/mutation replacements use the same detector on each complete logical
text-ID value, independent of append chunk, scalar-fragment or page boundaries.
A text value split across chunks has exactly the same validation outcome as the
same unchunked value. Validation must finish before note mutation; transport chunks
are not independently accepted or rejected as note-write replacements. This does
not require hydrating the entire text in memory or inspecting selection/live detail
text as if it were a replacement. Retained historical receipt replay and operation
mismatch handling keep their existing ordering; this guard does not turn an exact
retry into a new execution or revalidate a historical receipt against current text.

`operationId` is a canonical UUID minted once for a logical save; the stable scope and
principal form its receipt key; method is bound into the stored digest, so cross-method
reuse of that identity is a mismatch. `expiresAt` is an RFC3339 UTC millisecond
deadline no more than 24 hours after first admission. `payloadDigest` is lowercase
SHA-256 of compact canonical JSON of `{ method: "note.applySplices", backendId,
workspaceId, noteId, noteInstanceId, baseRevision, operationId, expiresAt, splices }`:
recursively sort object keys lexicographically, retain array order, use JSON string
escaping and UTF-8 with no trailing newline (same canonical JSON algorithm as the
transfer-selection fixtures). All numbers here are safe integers. Digest the exact
replacement text, not normalized Markdown. Verify it server-side. Same key/same
digest replays the original receipt, before testing the now-stale base; while its
identity record is retained, the same key
with any different payload/digest fails `note-operation-mismatch`, even if the
replacement is identical. In-flight duplicates join or return pending status.

Admission expires at the deadline; reject a new execution after it, even after
receipt pruning. Keep durable outcome/digest records through at least seven days
past that deadline. Within that retention, retries/status survive daemon restart
and unrelated writes. Replays require authorization and return the same historical
receipt, not the current revision. After pruning, status is `unknown`; a past-deadline
operation cannot be newly executed with that expired payload. IDs are never reused
by clients with another deadline/payload; after retention the server cannot prove
a pruned ID’s prior outcome or mismatch and must not claim it can. Do not invent a fresh operation ID to
resolve an uncertain result or extend its deadline. Recover/reconcile explicitly.

Source, rev, indexes, comment-anchor effects, attribution invalidation, metadata,
version snapshot, task conversion children/relations and **receipt** commit in one
transaction. Reuse existing author/50-version history and task conversion semantics,
including warnings and final converted source; existing best-effort projections into
other parent notes keep their documented semantics and are not silently made part
of this note transaction. The receipt identifies the final
post-conversion revision. Deterministic validation/conflict receipts may be stored
without any note/history/index mutation. Publish notifications only after commit;
retries emit no second history entry, child task or event. The generic helper that
writes a receipt after a callback is insufficient for crash atomicity. Transaction
failure before commit has no source/history effects; an uncertain commit must be
resolved by the durable operation record, not guessed from a network exception.

```typescript
type NoteCommitReceipt = {
  kind: "noteCommitReceipt"; outcome: "committed"; scope: NoteScope;
  operationId: string; payloadDigest: string;
  beforeRevision: string; afterRevision: string; sourceLength: number;
  mappingRef: string; effectsRef: string; inverseRef: string; receiptExpiresAt: string;
  headerDigest?: string; viewId?: string; // present for staged commits
  invalidation: "all"; // clean source/context/annotation caches must revalidate
};
type NoteOperationStatus = NoteCommitReceipt | NoteStageState | ({
  kind: "noteOperationStatus"; scope: NoteScope;
  operationId: string; payloadDigest?: string; headerDigest?: string;
  // inline: payloadDigest required; staged: headerDigest required, sealed payload when known
} & (
  | { outcome: "pending" | "unknown" }
  | { outcome: "conflict" | "rejected";
      error: { code: string; currentRevision?: string } }
));
```

Status results carry the requested scope and identity digest on every arm (staged
headerDigest before sealing; payloadDigest as well once known).
`pending` means a durable admission exists but is unsettled; recovery must settle
it after restart. `unknown` means no authoritative retained outcome was found,
**not** failure and not permission to drop drafts or repeat under another identity.
An ack lost after commit is resolved through `note.operationStatus` or exact retry.
FE outcomes distinguish committed, conflict, rejected and transport-unknown/pending;
a drained save queue, cancelled request or legacy generic `ok` is not a save receipt.
Only a matching receipt clears the acknowledged local sequence prefix. Later typing
stays dirty. Rejection/conflict retains the full draft, selection and undo journal.

`note.get { ..., page: { kind: "mapping" | "effects", operationId, ref, cursor?,
maxItems?, maxWireBytes? } }` pages immutable receipt-owned data until
`receiptExpiresAt`, independent of current live page revision. It includes scope,
operationId, beforeRevision, afterRevision, `items`, `nextCursor` and kind
`"noteMappingPage"` / `"noteEffectsPage"`. Recheck visibility even after deletion;
receipt access does not grant read access to a recreated note. For a deleted
incarnation, only its original operation principal with current workspace read
authority can read retained receipts/mappings; invisible existing incarnations
follow the ordinary not-found rule. Large deleted text
and complete post-write text never appear in acknowledgements or errors.

Mapping items `{ start, end, insertedLength }` describe the **final authoritative**
base-to-result change, including task conversion and marker projection, sorted and
nonoverlapping under the same range rule as splices. Derive them from actual edits/conversion
provenance, never ambiguous matching of repeated text. `insertedLength` counts UTF-16.
For a point before a change, add prior length deltas. At/inside a replaced range,
`affinity: "before"` maps to the new start, `"after"` to the new end; report
`deleted: true` for points strictly inside removed source. At an insertion boundary,
affinity chooses before/after inserted text. At the old nonempty end, map to the new
end then apply any next touching change using affinity. Every mapping page has
bounded items; no one-entry-per-character mapping requirement. A consumer does not
apply a prefix as a complete map. Exhaust all relevant mapping pages or invalidate
and reacquire the target. Selection direction and both endpoint affinities belong
to the session. Source position mapping alone does not restore a deleted canonical
anchor; preserved marker IDs and inverse history provenance are required.

Effects items are `{ kind: "createdTask", taskNoteId }`, `{ kind: "warning",
code, messagePreview, truncated, detailRef? }`, or `{ kind: "annotationInvalidation",
sourceRevision, attributionGeneration, commentRevision }`; large detail text uses
the context fragment form scoped to the receipt: these context pages use `sourceRevision: afterRevision`, a receipt-owned
`snapshotId` and `expiresAt: receiptExpiresAt`; they do not require the current
source revision to remain equal. Aggregate `convertedCount` is in
the effects page header, never inferred from one page. Existing convert-with-warning
behavior is preserved, not replaced with new fatal errors.

**Caller edits versus canonical effects.** Existing `auto_convert_task_blocks_after_write`
examines the entire post-write source, including a pre-existing distant `@@@task`
fence; reanchoring can repair orphan/partial anchors and scrub distant phantom UUID
markers. The partial path preserves these semantics, not a false promise that the
caller range is the complete authoritative footprint. Define immutable source states:
`base`, `callerResult` (only addressed splices), `preConversionCanonical` (completed
initial anchor repair/phantom scrub), and `final` (all existing canonical effects).
Effects pages enumerate every additional replacement as `{ kind:
"sourceEffect", reason: "task-conversion" | "anchor-repair" | "phantom-scrub" |
"task-marker-projection", inputState, outputState, range, insertedLength,
beforeDigest, afterDigest, detailRef }`. Intermediate state tokens allow multiple
ordered effect phases; ranges are in that phase's input, never silently in base
coordinates. Digests cover exact removed/inserted UTF-8 bytes; paged details carry
source/provenance when requested. Bytes outside the caller ranges are unchanged in
callerResult; bytes outside each declared effect footprint are unchanged in its
output. Final mappings compose all phases with preserved source provenance. Effects
are not permission for formatting normalization or arbitrary rewriting. Live marker
IDs with valid comments and non-UUID lookalike documentation remain intact.

A task conversion business warning preserves existing convert-with-warning behavior.
A recoverable conversion failure uses a transaction savepoint **after** initial
reanchoring/phantom scrub and its canonical write, version snapshot and comment
orphan-state updates. It rolls back only conversion/children and any subsequent
conversion-specific repair, effects and version snapshots. The final source is
`preConversionCanonical`, never the uncleaned callerResult; completed initial repair
effects, annotation invalidations and history remain. This matches the existing
write path's cleaned-content fallback when auto-conversion returns no refetched note.
No half-created child can commit. The receipt's mapping/effects/inverse references
describe this actual final source, and epochs describe only committed changes;
no transient conversion revision or child ID escapes the savepoint. Publication
and receipt remain atomic with the outer write. Fatal source/index/receipt transaction failure
rolls back everything. Existing version snapshots (including a distinct conversion
snapshot where applicable) retain their meaning inside the transaction; **one
logical editor history operation** does not mean deleting an existing version-history
snapshot. Replaying a receipt repeats neither snapshots nor canonical effects.

#### Staged frozen operations

Large edits, inverse history and explicit whole-document reads use the same scoped
operation ownership as inline writes. They never split one gesture into independent
commits, submit cropped full replacements, or accumulate a large request envelope.
The following prepared methods are all gated by `notePaging: 1`:

| Method | Params | Result |
| --- | --- | --- |
| note.operation.begin | scope fields, operationId, expiresAt, header, headerDigest | `NoteStageState` — reserves identity and immutable base view; no note mutation |
| note.operation.append | scope fields, operationId, headerDigest, stream, sequence, previousDigest, records, chunkDigest | `NoteStageAck` — durable contiguous chunk receipt; no note mutation |
| note.operation.seal | scope fields, operationId, headerDigest, manifest, payloadDigest | `NoteStageState` — validated immutable frozen view, or rejected/conflict; no note mutation |
| note.operation.read | scope fields, operationId, headerDigest (staged) or payloadDigest (inline receipt), kind, ref?, textId?, offset?, cursor?, maxItems?, maxSourceBytes?, maxWireBytes? | `NoteOperationPage` — bounded source, selection, search, inverse, mapping or effects page |
| note.operation.commit | scope fields, operationId, headerDigest, payloadDigest | `NoteCommitReceipt` — one CAS transaction, same retry/status rules as inline writes |
| note.operation.cancel | scope fields, operationId, headerDigest | `NoteOperationStatus` — closes uncommitted staging or reports the already committed outcome |

`header` is `{ baseRevision, editorSessionId, localEditSequence, liveGeneration,
selectionGeneration, action: "read" | "mutate", output: "source" |
"selectionMarkdown" | "search", selection: "all" | "ranges", query? }`.
`query` is required only for search: `{ text, caseSensitive: false,
mode: "source" | "renderedText" }`, literal search, at most 1,024 decoded UTF-8
bytes. Rendered-text search projects existing canonical text semantics across marks,
not DOM fragmentation; each hit supplies a source range and paged projection context.
Both modes include the frozen dirty prefix. `selection: "ranges"` requires the
selection stream; `all` means the complete frozen extent without enumerating it.
Native context-first selection is resolved by the client before capturing this header.

The bounded begin request is digested as canonical JSON of `{ method:
"note.operation.begin", ...scope, operationId, expiresAt, header }`. `headerDigest`
is its SHA-256. IDs, safe-integer counters, Unicode and frame budgets use the core
limits; headerDigest/chunkDigest/payloadDigest are lowercase 64-hex SHA-256 strings. Exact replay returns the same operation, even if current source later
changes; any different header under that identity is rejected. Beginning validates
baseRevision/current incarnation and pins an immutable revision root with copy-on-write
storage or equivalent retained pieces; it must not read/copy the entire source or
hold a database transaction across requests. Unlike ordinary live page cursors,
this explicit operation's retained source remains readable after a remote update.
Resource exhaustion fails explicitly without note mutation or replacing the captured
draft. No source-size cutoff or truncation is inferred from finite page budgets.

Staging expires at `expiresAt` (at most 24 hours after begin); no implicit renewal.
Streams are independently append-only, with zero-based consecutive `sequence` and
a hash chain: `previousDigest` is null for chunk zero, otherwise the preceding
chunkDigest. `chunkDigest` hashes canonical JSON `{ stream, sequence,
previousDigest, records }`. Chunks contain at most 128 records, at most 16,384 total
decoded UTF-8 text bytes and at most 65,536 escaped frame bytes. Acknowledgement
contains only `{ kind: "noteStageAck", scope, operationId, stream, sequence,
chunkDigest, nextSequence }` and fits 4,096 bytes. One request per stream and at most
two requests total are outstanding; backpressure is mandatory. Same-sequence/same
hash retries return the same ack; gaps, different content, wrong chain or writes
after sealing fail without modifying accepted chunks. Clients need not retain all
acknowledged chunks in the rendering process. Server staging uses indexed external
storage; whole-operation disk/source/output costs are disclosed separately from
bounded resident pages. Out-of-space is a typed failure, never partial publication.

Only these named streams are accepted; records are tagged and validated as follows:

- `text`: `{ kind: "text", id, offset, text }`, contiguous scalar-safe UTF-16 offsets
  per immutable text ID. Splice/selection strings refer to `{ textId, length,
  utf8Bytes, sha256 }`; this digest covers raw concatenated UTF-8, not JSON escaping.
- `dirty`: `{ kind: "splice", localSequence, ordinal, start, end, replacement }`.
  A localSequence names one native history group; its ordered, nonoverlapping ranges
  share that group's input source, and groups apply in increasing sequence order
  through exactly header.localEditSequence. Empty dirty streams are valid. `ordinal`
  starts at zero per group; groups cannot reopen. Transport batching preserves these
  original chronological history groups. A dirty record after the captured
  fence is invalid. Replacement is a text reference. This builds the frozen dirty
  view from base without saving, converting tasks or repairing source markers.
- `selection`: `{ kind: "range", ordinal, start, end, anchorAffinity, headAffinity,
  direction }`, ordered disjoint ranges in the **frozen dirty view**. Direction is
  `"forward" | "backward"`; affinities are `"before" | "after"`. Point selections
  are valid for insertion. Equal starts/overlaps are rejected; large table selections
  page here without replacing disjoint cells with their hull.
- `mutation`: `{ kind: "splice", ordinal, start, end, replacement }`, ordered,
  nonoverlapping base ranges against the **frozen dirty view**, using inline splice
  boundary rules but without an all-operation item limit. This describes an optional
  large paste/delete/format action after the captured dirty prefix. `action: "read"`
  forbids this stream; `action: "mutate"` commits the prefix plus these changes.
  Saving only the dirty prefix uses an empty mutation stream. Ordinals are consecutive.
- `live`: `{ kind: "projection", ordinal, sourceRange, role, canonicalId?, detail }`,
  in the frozen dirty view, with text-reference detail. Roles are `"selection-owner"`,
  `"paragraph-seam"`, `"inline-span"`, `"marker-occurrence"`; detail is a text-reference to a version-1 descriptor with `{ version: 1,
  nodeType, parentOrdinal, nativeRange, attributesRef? }`. nodeType is the existing
  editor schema node/mark name (at most 1,024 UTF-8 bytes), parentOrdinal is null or
  an earlier live-record ordinal (acyclic), nativeRange is `{from,to}` in the frozen
  native ProseMirror position units (UTF-16 text units, one position per leaf atom,
  and entry/exit positions for non-leaf nodes), and attributesRef names paged metadata-tree
  entries using the metadata shape above. Attribute trees are encoded as additional
  text-ID records, one canonical JSON tree entry per text ID, referenced by their IDs;
  oversized string values are separate text IDs, not nested complete strings.
  References cannot escape the sealed operation. SourceRange is always UTF-16 source;
  nativeRange is never substituted for it. The descriptor may preserve
  native same-session selection wrappers/aliases, but cannot change canonical source,
  manufacture persisted marker IDs, or authorize a new syntax/persistence format.
  The server validates references/ranges and output adapters validate role schema
  before using it; unknown versions/node types/attributes are rejected, never guessed.
  Canonical marker occurrence descriptors additionally require canonicalId and
  preserve start/end marker provenance; source-dependent details are invalid if
  their range or generation does not match the frozen view.

**Staged attribute-tree upload encoding.** This section defines upload resources
inside the existing `text` stream; it does not change server-issued metadata read
collections or introduce another stream/method/capability. A live descriptor's
`attributesRef` names an operation-owned text ID containing one canonical JSON
metadata entry of the shape above. That text ID and the entry's `id` are distinct
identities; neither is inferred from the other. The root has `parentId: null` and
no `key`, `keyRef` or `index`. Entry IDs and text references are nonempty, NUL-free,
scalar-valid strings of at most 256 UTF-8 bytes. Every reference resolves within
the same sealed operation, with the existing text-stream ownership and integrity
checks; a matching spelling in another operation is not a resource.

For uploaded object/array entries, `childrenRef` names a text ID containing exactly:

```typescript
{ kind: "metadataChildren", items: string[], nextRef: string | null }
```

Each item is a **child entry text ID**, not an entry ID, inline child object or
server-issued page cursor. `nextRef` names the next directory text ID under the
same containing entry, or is null at exhaustion. Every reconstructed entry or
directory JSON resource is at most 16,384 UTF-8 bytes, including its JSON escaping;
a directory additionally has at most 64 child IDs. These are logical resource
bounds, independent of upload chunk/escaped RPC frame limits. A resource may cross
chunks without changing its bytes, identity or validation. Canonical JSON uses the
existing `canonicalJson` encoding (recursive UTF-16 field-name sorting and compact
JSON number/string encoding) with no trailing newline. The original logical bytes
must equal that encoding; do not normalize bytes and then accept or hash the
rewritten value. Original chunk/text digests still bind the uploaded bytes;
duplicate/extra/missing fields and noncanonical encodings are invalid. Check the
logical byte bound before decoding the entry/directory. Large scalar keys/values
remain separate text resources and are not subject to that JSON-container bound.

An empty container owns one explicit directory with `items: []` and `nextRef: null`.
Every directory in a nonempty chain has at least one child; empty forward or later
terminal directories are invalid. There is no implicit empty/missing reference.
Each directory belongs to one containing entry resource. It cannot be reused as
another container's child collection. Entries retain the exact metadata fields
above: objects/arrays require `childrenRef`, strings require `valueRef`, and
number/boolean/null require the correctly typed inline `value`, without mixing
those forms. Uploaded decoded keys (inline or referenced) and raw scalar text
values are NUL-free and Unicode scalar-valid, including empty strings.
`keyRef` and `valueRef` name owned raw scalar text, not a JSON-quoted
string or a directory. An empty string remains a present empty text value; it is
not absent/null.

Children's `parentId` equals the containing **entry ID**. An object member has
exactly one of `key`/`keyRef` and no index; an array member has exactly one
nonnegative safe-integer index and no key fields. Object children are strictly
ordered by their decoded keys in Unicode scalar-value order (equivalently UTF-8
byte lexicographic order for valid strings), with shorter prefixes first, no
normalization or locale folding, and invalid Unicode scalars rejected. Array
indices are consecutive from zero. Ordering and uniqueness span every directory in the chain. This sibling-key
order is distinct from canonical JSON's ordering of the fixed entry/directory
field names; do not substitute JavaScript UTF-16 sorting or reference spelling.
Long keys must be compared through bounded storage/streaming, not hydrated as a
complete sibling set. There is no total-child count limit implied by the 64-item
directory limit.

The resolver follows explicit reachable edges only. It rejects cycles, duplicate
children or decoded keys/indices, entry IDs claimed by different entry text IDs,
multiple parents, repeated/reassigned directories, missing/foreign references and
unowned empty collections. Repeated use of the same valid root by several live
descriptors and sharing scalar text are allowed; they do not create a cycle or a
second entry identity. Use indexed external validation state for ownership,
ordering and traversal rather than scanning arbitrary uploaded text blobs for
JSON or retaining an unbounded graph in memory. Unreferenced text can belong to
other streams/replacements; its existence does not make it a metadata entry.

Graph validation is structural and does not validate a native node/mark attribute
policy or grant marker/alias authority. The existing server reference/range checks
and actual output-adapter role/schema validation remain separate requirements.

`manifest` has one fixed entry for each named stream (including empty streams):
`{ stream, chunks, records, lastDigest }`, in the order above. Empty streams use
zero counts/null digest. `payloadDigest` hashes canonical JSON `{ headerDigest,
manifest }`. Seal verifies all chains/counts/text-reference lengths and digests,
Unicode endpoints, operation order and the completed view, then atomically freezes
that manifest. Missing chunks, mismatched digest, malformed projection context and
extra streams reject without sealing or note mutation; the client may finish missing
chunks then seal the same valid manifest. Replaying a successful seal with a different
manifest is an operation mismatch. Sealed data never changes. All validation must
operate through indexed pages; a full reconstructed string in the renderer or a
full scan before each append is not licensed by this protocol.

```typescript
type NoteStageState = {
  kind: "noteStageState"; scope: NoteScope; operationId: string;
  headerDigest: string; payloadDigest?: string;
  phase: "staging" | "sealed" | "cancelled" | "expired";
  baseRevision: string; expiresAt: string; viewLength?: number;
  streams: { stream: "text" | "dirty" | "selection" | "mutation" | "live";
    nextSequence: number; lastDigest: string | null }[];
};
```

This state has exactly the five stream summaries, never chunk/text/history arrays,
and fits 4,096 escaped bytes. `note.operationStatus` accepts exactly one of inline
`payloadDigest`, or staged `headerDigest` plus optional sealed `payloadDigest`.
For staged operations it returns NoteStageState before commit admission, the typed
pending/unknown/rejected/conflict outcome after admission, or NoteCommitReceipt.
Every staged result includes headerDigest; committed receipts also include the final
payloadDigest. The receipt key is shared with inline operations: the same ID cannot
be reused through a different method. Begin/append/seal receipts and retained base
references survive daemon restart until their deadline; process restart does not
rebuild client selection/undo state or turn staging into an automatic save.

`note.operation.read` requires a sealed manifest for staged view output. Inline
receipts also permit `inverse`, `inverseText`, `mapping`, `effects` and `detail` reads by
payloadDigest without a staged header. Output is `{ kind:
"noteOperationPage", scope, operationId, headerDigest, payloadDigest, viewId,
outputKind, sourceLength, items, nextCursor, expiresAt }`. Inline receipt reads omit
headerDigest/viewId and carry beforeRevision/afterRevision instead. sourceLength is
the frozen input extent (or final extent for inverse reads); emitted text offsets
address the output stream, not necessarily that source. `viewId` binds baseRevision,
all header generations and sealed manifest; cursors additionally bind kind/budgets
and continuation. No cursor can be reused across operations or output kinds. Source
and selection output items are `{ offset, text }`, scalar-safe UTF-16 output offsets
starting at zero and contiguous; selectionMarkdown uses the existing wrapper handling,
anchor stripping and edge trimming, with only Markdown text/plain output. Large source
or selections stream through bounded parser context and external output staging;
source output is exact frozen source without selection trimming. All items use the
page bounds above. A `nextCursor: null` frame is terminal output, never a partial
success caused by resource error. Cancellation/error discards unpublished sink output.

First-read addressing is explicit (all selectors are included in cursor ownership):

| kind | Required first-read selector | Items / resource lifetime |
| --- | --- | --- |
| source, selectionMarkdown, search | No ref/textId; starts at output offset or search scan zero | Sealed frozen view until staging expiresAt; remote writes do not replace it |
| inverse, mapping, effects | `ref` equal to this receipt's inverseRef, mappingRef or effectsRef | Ordered records until receiptExpiresAt, even after staging expiry or a later source revision |
| inverseText | `ref: inverseRef`, `textId` from one of its replacement references, `offset?` (default zero) | Exact scalar-safe text fragments `{textId,offset,text}` until receiptExpiresAt |
| detail | `ref` from a search detailRef, inverse provenanceRef, receipt effect detailRef (including sourceEffect), or an already returned detail/children reference | Paged typed detail records or text fragments; inherits the issuing view's expiresAt or receipt's receiptExpiresAt |

For inverseText, offset is UTF-16 within that named text value and must be a scalar
boundary; length, UTF-8 bytes and raw SHA-256 match the inverse replacement reference.
A text ID not reachable through the given inverseRef is invalid, even if another
operation owns the same ID. Detail records use the bounded context/metadata-tree
shapes above; text-value references can be resolved with `kind: "detail", ref` and
optional scalar-safe offset, without hydrating the parent tree. Selection/source
output only accepts cursor continuation (use ordinary source seek for live browsing).
Every continuation repeats kind and the same ref/textId/budgets, omits offset, and
sends the issued cursor. A ref/cursor mismatch or a foreign scope/operation/kind is
`note-page-cursor-invalid`; expired view-owned data is `note-page-expired`, not an
empty successful page. Receipt-owned reads do not require a still-live staged view;
they validate the retained receipt/digest and inherit its expiry. For inline receipt details, the request repeats the exact operation scope,
operationId and payloadDigest, without a staged headerDigest or viewId. The ref
must be reachable from that receipt's inverse/effects or a detail already reached
from them; a same-spelled ref in another receipt is not authority. These details
expire at receiptExpiresAt, not staging expiry, and remain subject to the receipt
visibility/deleted-incarnation rules. Their existing bounded context/metadata-tree
records and scalar fragments carry writer-retained source/provenance; this does
not introduce a new provenance leaf schema, native identity or marker-alias grant.
Pending/cancelled
operations never expose a fabricated inverse. Readonly operations have no receipt
extension: their search/details expire with their pinned view.

Search items are `{ hitId, sourceRange, detailRef }`, ordered by source start then
hitId. Search pages additionally carry `scannedThrough` (UTF-16 source extent),
`count: { value, exact }`; false means matches observed so far, true only after the
entire frozen view is examined. A work-limited page may have no hits but must advance
scannedThrough or its cursor; only terminal exhaustion reports an exact total.
Target navigation uses that frozen view's source range/context. If live revisions or
dirty generations have moved, map the target through verified maps or restart search;
never install an old hit's offsets on current content. An explicit search can run
against the old frozen view and label it as such; late results cannot change a new query.

Commit is valid only for `action: "mutate"`, a sealed manifest and an unexpired
admission. It checks that current sourceRevision still equals header.baseRevision,
then composes the dirty prefix and mutation into authoritative base-addressed edits,
applies existing canonical effects and publishes source/index/metadata/history/
receipt atomically. A batched save does not merge captured native history groups;
the optional mutation stream is one additional logical gesture after that prefix.
An unrelated or conflicting remote write still returns strict
conflict; the client can create a **new** operation after explicit rebase, retaining
this draft and history. Do not relabel an uncertain old operation as that rebase.
The commit acknowledgement has the same bounded receipt as inline applySplices,
plus headerDigest and `viewId` (all receipts carry inverseRef). Mappings span original base to final,
not merely frozen dirty view to final. A frozen local prefix already committed by
another local save likewise conflicts: reconcile its receipt and rebase; never save
it twice. Pending/cancel and lost acknowledgements use the existing durable status.

`note.operation.read kind: "inverse"` (after either inline or staged commit) returns receipt-owned paged inverse
records `{ historyGroup, inputState, outputState, ordinal, start, end, replacement,
provenanceRef }`, newest history group first. `historyGroup` is a nonempty opaque
string of at most 256 UTF-8 bytes, identifying a logical history group within this
receipt. Compare its exact string value; never parse it as a number or equate it
with a frontend's local numeric history ID. A single-group inline inverse may use
`"0"`; `"0"`, `"00"` and staged identities such as `"paste"` are distinct. This
identity does not determine ordering: preserve the returned newest-first group
sequence and the original staged groups. It neither grants provenance nor permits
merging separate gestures. The first inputState is afterRevision;
each group’s ranges share its input state, and its outputState is the next group’s
input. This preserves dirty-prefix history groups separately from the final gesture;
undoing only the newest gesture does not discard earlier typing. Large removed text
is streamed by `kind: "inverseText"` using the same
text-ID offset contract. Inverse references/digests are verified just like staged
input. Undo is a new operation, never an operation-ID replay. Transform its targets
through verified later mappings; overlapping remote changes retain the journal and
surface conflict instead of reverting unrelated work. Canonical marker and alias
provenance restores original identities where valid; task-conversion side effects
follow existing task semantics (undoing a link does not silently delete a child task).
Viewport eviction/remount never deletes chronological history, selection or inverse
data. Receipt resources last at least through receiptExpiresAt; session history owners
must transfer any still-needed inverse into their indexed session journal before
that resource expires, never silently shorten undo to a page-cache/receipt horizon.
This is a session resource obligation, not a promise to restore undo after app restart.

Cancellation is serialized with commit admission. If cancellation wins, persist a
cancelled tombstone/digests through the receipt-retention period, release base/staged
resources, reject later appends/seals/commits and perform no note/history mutation.
If commit admission wins, cancellation returns pending or the committed receipt;
closing the transport is not rollback. Retrying cancel is idempotent. Cancelling a
committed operation returns its receipt and may release unneeded output staging,
never source/history or required inverse records. Expired uncommitted operations
release leases and retain an expired identity tombstone through retention; even
after tombstone pruning the deadline prevents re-execution. Lost chunk acks use the
same sequence/hash; lost begin/seal/commit acks use the same stable identity/digests.
`unknown` after retention or transient unavailability is never a failure receipt.

Only matching authoritative commit receipts clear the captured dirty prefix.
Read/clipboard/export completion clears **no** draft. Later edits remain dirty.
Output publication to clipboard/file has a separate sink receipt; the note protocol
cannot claim OS or file success. Cut waits for complete publication before submitting
its staged deletion. Source conflict after publication leaves the copied value and
source intact; publication failure must never trigger commit. Explicit raw-source
materialization uses source output and reports progress/cancellation/complete status.


#### Annotation pages and independent epochs

With `noteAnnotations: 1`, existing `note.lineAttribution.load`, `comment.list` and
`comment.getThread` accept an opt-in `page` object; omission preserves their exact
legacy payloads, including full maps/replies where currently returned. Page kinds are respectively `"attribution"`, `"comments"` and `"replies"`. Their
first request carries ranges/filters (or threadId for replies), `maxItems?` and
`maxWireBytes?`; continuation carries cursor plus identical query/epoch/budget
fields. Each snapshot has the same 300-second fixed lifetime and explicit
stale/expired behavior as source paging. All paged
requests require the four scope fields and `sourceRevision` at the top level;
query/budget fields are nested in `page`. Attribution requests additionally
carry top-level `attributionGeneration` after the first response; comment requests carry
top-level `commentRevision` after the first response. Epoch strings are opaque. Source edits
invalidate all projections; recomputation can advance attributionGeneration without
source changes; reply/resolve/delete can advance commentRevision without either
source or attribution changes. A source-writing comment action advances both source
and comment epochs. Persist these epochs atomically with their respective changes.

Range methods take `ranges: [{start,end}]`, sorted, nonempty, pairwise disjoint and
nonadjacent (client coalesces touching ranges); up to 32 intervals. An empty set is
valid and produces empty items, not a whole-note query. Cursor identity binds the
**exact admitted interval set**, filters, scope, relevant epochs, snapshot, budgets
and continuation. Do not replace a table's admitted disjoint cell ranges with their
bounding hull. An anchor/attribution interval overlaps if `start < query.end &&
end > query.start`; point anchors use `query.start <= point < query.end`. Include
anchors that start outside the viewport. Canonical IDs deduplicate repeated matches
across disjoint ranges; overlap boundaries never create synthetic comment IDs.

- Attribution page kind `noteAttributionPage`: `scope`, `sourceRevision`,
  `attributionGeneration`, `snapshotId`, `expiresAt`, `items`, `nextCursor`,
  `state: "ready" | "pending"`. Pending has no items/cursor and cannot reuse an
  old map as current. Items contain `{ id, sourceRange, startLine, endLine,
  authorRef, timestamp, turnNumber? }` with existing author semantics. Authors and
  optional scale statistics use paged `detailRef` context, never a note-wide legend.
  Publishing a computation checks its source revision transactionally; an old job
  must not overwrite a newer generation. Ranges include entire intersecting lines
  by source extent; do not decode the legacy attribution JSON then discard it.
- Comment list page kind `noteCommentPage`: `scope`, `sourceRevision`,
  `commentRevision`, `snapshotId`, `expiresAt`, `items`, `nextCursor`,
  `totalThreads`, `totalComments`. Comment status values retain all five existing
  spellings: `open`, `resolved`, `pending`, `accepted`, `rejected`; this also applies
  to reply items. These exact safe-integer totals refer to the
  filtered range set at that epoch, independent of the page; indexed aggregate
  queries must not fetch every row. Summary items have `{ threadId, rootCommentId,
  rootState: "present" | "deleted", status,
  totalComments, latestCommentId, latestCommentPreview, truncated, anchorRef,
  detailRef }`, never nested `comments` or replies. `includeComments: true` with
  `page` is invalid. An optional `anchorState: "anchored" | "orphaned" | "all"`
  filter defaults to anchored; orphaned mode is note-scoped and requires `ranges: []`.
  `all` is also explicitly note-scoped with empty ranges. An ordinary anchored
  empty-range query stays empty. Anchored rows order by first overlapping position,
  then threadId; note-scoped rows by threadId. No unstable timestamp-only cursor.
- `comment.getThread` page kind `noteReplyPage` binds threadId in addition to the
  epochs and returns bounded comment summaries in `(createdAt,commentId)` order,
  `totalComments`, `nextCursor`, plus the original `rootCommentId` and
  `rootState: "present" | "deleted"` on **every** page, including exhaustion.
  When present, the root is included once across a complete traversal as an ordinary
  item, never a full embedded exception or necessarily the first item. Each item preserves canonical
  commentId, authorPrincipalId/authorIdentity presence, status and createdAt, with
  `preview`, `truncated`, `bodyRef` and `detailRef`. A huge root, reply, author label,
  suggestion or quoted selection pages through context fragments; no truncation of
  authoritative bodies. Replies do not acquire independent source anchors.

**Paged reply author identity.** The inline types remain the existing output-only
comment attribution types. Only paged reply items add these reference alternatives:

```ts
type PagedReplyAuthor = {
  authorPrincipalId?: string;
  authorPrincipalIdRef?: string;
  authorIdentity?: { provider: "github" | "gitlab"; host: string; externalUserId: string };
  authorIdentityRef?: string;
};
```

For each logical value, exactly one of its inline field or reference is present
when that value exists on the canonical comment; both are omitted when unavailable.
Both forms together, `null`, or an empty reference are invalid. An empty stored
string is still a present string, not an absence sentinel. This encoding does not
change creation, anonymization or canonical identity semantics below, and does not
add references to legacy unpaged `Comment`/`CommentWire` responses.

An inline principal ID is at most 256 decoded UTF-8 bytes. Inline identity strings
`host` and `externalUserId` are at most 1,024 decoded UTF-8 bytes each; `provider`
retains the existing enum. Longer stored values **must use references**, not be
truncated or rejected merely for their length. A server may use references for
shorter values to fit the complete escaped JSON-RPC frame. Reference tokens remain
nonempty and at most 256 decoded UTF-8 bytes. All item and complete-frame budgets
still apply; the inline limits do not guarantee that a whole page fits.

`authorPrincipalIdRef` resolves directly to scalar-safe context fragments with
`field: "authorPrincipalId"`. `authorIdentityRef` resolves to the existing paged
field directory: exactly `provider`, `host`, `externalUserId`, in that order. Each
directory entry has `kind: "fragment", offset: 0, text: ""` and a nonempty
`nextRef` for that field's scalar fragments. Directory `nextCursor` enumerates
fields; field `nextRef` continues the value independently. An empty field value
has one fragment at offset zero, empty text and `nextRef: null`. These are exact
stored strings, not a serialized identity JSON object to decode or a whole author
map. Consumers compare the complete identity triple, never a label or preview.

Every reference is bound to the canonical comment, admitted principal, NoteScope,
sourceRevision, commentRevision, snapshotId and original expiresAt of its reply
page. Directory and value responses echo the same scope, sourceRevision,
commentRevision, snapshotId and expiresAt, including on continuations. Missing or
mismatched bindings cannot be adopted; following a reference cannot renew expiry
or switch comments, callers or epochs. These owner/caller bindings are enforced
by the server's existing reference machinery, not new caller-supplied authority
fields. Author presentation labels and authorType retain their existing detail
fields and semantics; a large label uses its own context fragments and is not an
identity key. Anchor references and canonical marker IDs remain unchanged.

**Root deletion with surviving replies.** Deleting a root does not delete its
replies or change the original thread/root identity. `rootState: "deleted"` means
the original root row is absent, not that the thread is missing or the page is
exhausted. Retain its canonical root ID (the native creation path uses that ID as
threadId); never substitute the first surviving reply's ID. Items enumerate only
surviving comments once, in the same deterministic order; totalComments counts
those survivors, with no deleted-root/tombstone item, body, preview or synthetic
author. A readable thread has totalComments greater than zero even on an exhausted
empty page. Each page repeats the same rootState and exact total for its epoch.
Thread summaries likewise count survivors and derive status/latest preview from
them. A deleted-root summary has `anchorRef: null`; it is available through the
note-scoped `anchorState: "orphaned" | "all"` queries, not range-overlap queries.
Stray source markers do not create a live root or independent reply anchors.

Read a surviving thread by its original threadId or a surviving commentId. A fresh
paged lookup after the **last** comment is deleted returns the existing typed
`-32602` / `data.code: "not-found"` category, with `data.entity: "commentThread"`;
it is not an empty successful thread. A fresh lookup by a deleted commentId uses
the same category with `entity: "comment"`; use the retained threadId to read its
surviving replies. These discriminators describe the addressed comment resource,
not deletion of its containing note. Legacy unpaged lookup errors and its
first-survivor `rootComment` fallback remain unchanged.

Each successful comment deletion advances commentRevision and shared stateGeneration.
Any old reply/summary/detail cursor, even one holding a snapshotId, becomes stale;
an old in-flight response cannot enter a cache guarded by the newer comment epoch.
Reacquire from the first page to obtain the new rootState/count. A continuation
after final deletion follows the same stale-epoch rule; a new lookup then reports
not-found. Ordinary annotation snapshots do not retain deleted root content across
epochs. Comment-only deletion leaves sourceRevision/attributionGeneration unchanged;
source pages and explicit frozen source operations retain their existing source
semantics, but do not pin comment rows or authorize old annotation replies. A later
source marker scrub advances sourceRevision and invalidates its dependent pages as
usual. Retain thread/root identity, survivor counts and root-presence state in
indexed metadata; determining these headers must not load all replies.

Annotation detail/anchor references resolve through `note.get` context pages with
the same annotation epochs and expiry. Anchor descriptors retain canonical
`commentId`, `startId`/`endId` and source marker provenance, with independently paged
occurrences `{ occurrenceId, sourceRange, canonicalId }`. Occurrence IDs are
snapshot-local; canonical IDs remain the existing embedded marker UUIDs. Native
aliases or multiple projections of one marker must not mint new persisted IDs.
An orphan is explicit, not an empty-success deletion of the comment. Undo restores
original marker identity; dirty comment drafts remain keyed by canonical IDs and
are not replaced by a stale summary. An attribution-only change does not expire a
comment cursor and vice versa. Source change expires both. Each page echoes its
relevant epochs; clients validate them AND the local request generation before use.
Bounded subscriptions and reconnect rules are in [§6](../06-events.md#prepared-note-page-subscriptions).

#### Frozen operations and implementation handoff

All-document operations capture `{ scope, sourceRevision, editorSessionId,
localEditSequence, liveGeneration, selectionGeneration, ranges, direction,
affinities }` at the gesture, including debounce-held edits. Their input is canonical
source plus exactly that dirty prefix and matching live context. Later typing does
not enter an in-flight copy/search/export. They must not silently save to obtain a
server-visible view. A logical select-all covers unloaded source without hydration;
its painting is only a viewport projection. Preserve native context-first selection
inside tables/code before document-wide expansion. Search covers unloaded and dirty
text and returns revision/view-bound source ranges, not DOM-node offsets or cross-note
FTS ranks. Hits, count completion and context are bounded/paged; a partial scan must
not claim an exact total. Source versus rendered-text mode must be explicit.

Full-source copy/export retains exact Markdown; existing selected-note copy retains
its Markdown `text/plain` behavior. No implicit rich HTML MIME addition. Streaming
output has explicit ordered pages, terminal success/error, backpressure and cancellation;
only complete publication is success. Cut publishes first, then conditionally commits
the frozen deletion: a failed clipboard write changes no source, and a source conflict
after successful copy retains source and the copied value. Do not restore an old
clipboard over a newer user's copy. Real OS publication and note transactions are
not atomic together. These are ordering requirements, not proof of an OS bridge.

**Preserved operation and lifetime policy.** These are compatibility defaults from
the existing editor and the approved Spec, not new product decisions:

- Selected copy remains trimmed Markdown `text/plain`, using the current
  `src/lib/utils/selected-note-markdown-copy.ts` wrapper/anchor behavior. No default
  rich HTML MIME is added. Full-source copy/export does not inherit selection trim.
- Explicit raw-mode entry may materialize the full frozen source into Monaco, with
  separately measured source/model/temporary memory and cancellation/progress. Its
  DOM remains virtual; ordinary rich entry/editing remains paged. The current
  `RawNoteCodeEditor.svelte` holds full draft/baseline and `CodeEditor.svelte` calls
  `getValue()` on every model change. The paged integration must use Monaco change
  deltas through the shared session, not repeat full-source extraction/replacement
  per key. Raw/rich transitions retain the session's draft, source selection and
  chronological history while their views are disposable.
- Current rich cleanup in `NoteWithComments.svelte` flushes pending saves then
  destroys its editor; raw `onDestroy` also flushes. The write service keeps pending
  content/queues/draft sequences in module Maps, and Monaco disposes its models.
  These paths provide no persisted native undo stack across process restart. The
  new session must survive viewport eviction/view remount within an open note;
  intentional session close follows the existing save/flush path with **typed**
  failure/conflict handling and retains unresolved drafts. Restart starts from
  acknowledged canonical source plus whatever existing draft recovery actually
  restores; no newly promised durable undo or new recovery format. Daemon receipt
  durability resolves unknown saves independently of the editor's undo lifetime.
- Fresh canonical reload continues through the existing Markdown parser/serializer.
  Native-live seams/owners/paragraph metadata stay session projections; a fresh parse
  is a separate oracle. Existing live/fresh span/paragraph/strike/underline differences
  are not normalized away or silently turned into persistent fields by this contract.

The staged read/commit protocol fixes ownership and failure semantics; implementations
must still prove the selected-copy serializer, raw transitions, general grammar and
native clipboard on their real paths. This is not a new prerequisite to generic
source paging, nor a waiver for enabling incomplete paged editing.

Implementation locations and required evidence (not implemented by these docs):

| Owner / seam | Required implementation and proof |
| --- | --- |
| Daemon `intent-core` types; `intent-transport/src/router.rs`; note services | Add discriminated page/receipt types and capability gates. Test old requests byte-equivalent, new request rejection on unsupported shapes, WSS escaped budgets, authorization, concurrent mutation/reconnect and every writer's invalidation. |
| `intent-store/src/note_repo.rs`, `note_version_repo.rs` | Indexed source pieces/chunks plus subtree byte/UTF-16/scalar/LF totals, revision/incarnation and bounded lexical checkpoints. Persist exact raw task-link capture membership, dedup/first-position ordinals, count and long-value fragments with the same revision; do not substitute checkbox rows. Seek must locate/decode only relevant pieces; SQL `substr` on whole TEXT or `get_note` then slice is not a complexity proof. Persist incremental context/mapping/receipt records transactionally. Keep legacy complete reads and retained history semantics; existing full snapshots/FTS/task conversion may still impose document-sized write work and require explicit measured redesign in persistence work. |
| Store attribution/comment repositories | Replace paged-path JSON/map scans with queryable source-interval/line and canonical marker occurrence indexes; independent generation tables, `(threadId,createdAt,commentId)` reply index and maintained counts. Test query plans/rows/bytes touched and stale computation publication. |
| FE `src/lib/client/app-client.ts`, `live/live-notes-client.ts`, notes-read-service and workspace-notes state | Distinct CompleteNote/NoteSourcePage types, scoped cache/requests, no partial-to-full assignability, bounded annotation ownership and invalidation. No eager spec/full-event refetch bypass. |
| FE `features/notes/notes-write-service.ts` and document session | Typed outcomes, frozen dirty sequence, atomic inverse/history ownership and live-context lifetimes; do not extend the retired saga or treat queue settlement as success. |

Measure backend query work and renderer transient/resident allocations separately.
The machine-readable [notes fixtures](../fixtures/notes/contract.json) and
`make check-note-pagination-contract` (also in `make consumer-checks`) validate this
prepared contract. `fixtureRepresentations` distinguishes full JSON-RPC frames from
result objects and record-only scenarios. Result objects are wrapped in complete
response frames before wire-budget checks; staged `appendFrames` are mandatory
inputs to stream validation, so payload hash checks cannot bypass envelope budgets.
Reply validation includes required fields and ordering across page boundaries;
subscription fixtures use the exact pageState frame in §6.
Component tests must execute the same cases against actual RPCs,
storage fault injection and FE reducers before capability advertisement.
Fixture arithmetic, encoded JSON sizes and same-process models are
**specification validation**, not proof of database isolation, heap limits, bounded
storage complexity, production editor behavior or released support.

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
(published through the same transient path as `chat:stream:delta`, §7): it is never
written to the event table, so it does not appear in `event.query` or the other §5.10
historical reads (migration `0052_delete_line_attribution_events.sql` deletes legacy rows
on existing installs). The durable state remains the `note_line_attribution` row —
one row per note (SQLite migration `0028_note_line_attribution.sql`), upserted on
each recompute so the read path is O(1) and survives restart. `note.delete` cascades.

### 5.3 `comment.*`

| Method | Params | Result |
| --- | --- | --- |
| comment.add | noteId (req), searchContext (req), commentTarget (req), comment (req), type?, author?, authorType? ("user" \| "agent", default "agent"), idempotencyKey?, commentId? (UUID) | { success, message, commentId, anchored, noteRev, location: { line, anchoredText } } (anchors by text search). A replay with the same `(workspaceId, idempotencyKey)` returns the stored result without re-executing (no duplicate comment, no second `comment:added` / `note:updated`); empty/whitespace-only keys are treated as absent. When `commentId` is supplied, the daemon uses it as the canonical id — comment row, `threadId`, anchor `startId`/`endId`, and the embedded `<!--anchor:{id}:start/end-->` markers — instead of minting a fresh UUID, so a client that already inserted optimistic editor anchors under that id converges with the daemon's note rewrite. A non-canonical-UUID value (only the hyphenated 8-4-4-4-12 form is accepted; e.g. the 32-hex simple form is rejected) or a collision with an existing comment id is rejected with `-32602` InvalidParams (after the idempotency replay check, which still returns the cached result first). Omitting it keeps the mint-a-UUID behavior. |
| comment.list | noteId (req), since?, authorType?, status?, includeComments? | `{ threads: CommentThreadSummary[], totalThreads, totalComments }` — `comments: CommentWire[]` on each summary only when `includeComments: true` |
| comment.getThread | noteId (req), threadId? or commentId? | `{ threadId, noteId, rootComment: CommentWire, replies: CommentWire[], totalComments, status }` |
| comment.respond | noteId (req), comment (req), threadId? or commentId?, type?, author?, authorType? ("user" \| "agent", default "agent"), suggestionOriginal?, suggestionProposed? | `{ success, message, comment: CommentWire, thread: { threadId, totalComments } }` — the reply carries **no** `anchor`/`anchorText` (see "Reply anchoring" below) |
| comment.delete | noteId (req), commentId (req) | { ok, ... } |

#### Qualified human comment attribution *(10.9, additive; docs lead implementation)*

The existing `author: string` is a presentation label, with the unchanged
[§5.48 caller attribution rules](./multiplayer.md#attribution--who-wrote-a-human-message):
bound humans use login, else display name, else principal ID, with
`authorType: "user"`; the unlinked primary's compatibility pass-through and
agent/daemon supplied labels and types remain intact. Do not encode a provider
or instance into that label or use it as an identity key.

Existing `Comment` entities and `CommentWire` projections add these **output-only**
fields, omitted rather than `null` when unavailable:

```ts
// Attribution fields only; all existing comment fields retain their shapes.
// Identity is the canonical safe triple from §5.48 / §5.49.
type CommentAttribution = {
  author: string;
  authorType: "user" | "agent";
  authorPrincipalId?: string;
  authorIdentity?: Identity; // { provider: "github" | "gitlab", host, externalUserId }
};
// On the existing CommentThreadSummary, alongside its other fields:
type LatestCommentAttribution = {
  latestCommentAuthor: string;
  latestCommentAuthorType: "user" | "agent";
  latestCommentAuthorPrincipalId?: string;
  latestCommentAuthorIdentity?: Identity;
};
```

`authorPrincipalId` is the admitted human's stable ID **on this daemon host**.
`authorIdentity` is the creation-time snapshot of that principal's linked
`Identity`: provider, canonical bare instance `host[:port]`, and stable
`externalUserId` as a string. It contains no token, credential reference, login
or display name. Equal handles or numeric IDs on GitHub and GitLab, or on two
GitLab instances, do not identify the same person. Compare the complete triple
and retain the host-scoped principal ID; neither is authority, an account-linking
rule, nor a source of execution credentials.

**Creation and spoofing.** On both `comment.add` and `comment.respond`, first apply
the existing caller-based label/type rules. If the admitted caller is a bound
human and the resulting `authorType` is `"user"`, persist its actual principal ID
and, only when linked, its canonical identity snapshot with the new comment.
An unlinked human (including the owner without a forge) gets the principal ID
without a fabricated identity. The legacy unlinked-primary pass-through that
produces a non-user comment retains its label/type and omits both new fields.
Agent/daemon-origin comments likewise omit them, even if their supplied
`authorType` is `"user"`; do not turn the shared execution principal into a human
author.

Client-supplied copies of either new field are **ignored**, whatever their value
or type, before deriving attribution from the admitted caller and trusted
principal state. This applies consistently to add/respond through every existing
entry point, including RPC and MCP; it extends authoritative override/ignore
semantics without adding a request requirement or a new rejection solely for
these output keys. An agent cannot stamp a human by copying the fields. Existing
validation of the other request fields and all authorization gates still apply.

**Durability and history.** Commit attribution with the comment, before publishing
its creation event. Preserve the original author label, stamp and snapshot through
comment updates, resolution/reopening, note edits, anchor repair and daemon restart;
neither the current editor nor the host execution account replaces the author.
Later profile changes, identity selection/unlinking, membership removal or an
unresolvable principal do not rewrite an already recorded safe snapshot. It
describes the author at creation, not present access. A principal-only comment
does not acquire a snapshot when that principal later links a forge.

Legacy comment records without a reliable creation stamp retain their original
labels and omit the new fields. Do not guess from a handle, provider, current owner
or later same-handle principal, mass-backfill comment history, or treat untrusted
imported extra fields as proof of attribution. Unlike transcript legacy-author
resolution, missing comment metadata never defaults to the owner.

This protection for unknown comment authors does not prohibit the separately
required [source tagging of historical human messages before workspace transfer](./workspace.md#human-authorship-in-workspace-transfers).
That rule uses trustworthy source provenance while it is available, preserves
recorded authors, and keeps irrecoverable imported history unknown. It does not
guess legacy comment authors or turn assistant/tool/system history into human
messages.

On [workspace import](./workspace.md#human-authorship-in-workspace-transfers), keep
the recorded safe identity snapshot and original label, but omit foreign
`authorPrincipalId` from comment and latest-author output. Any retained source
principal provenance is internal history, not a local principal binding. Do not
look up or recreate a destination principal by source ID, identity or handle.
This exception to copying the creation principal ID across projections prevents
foreign IDs from acquiring local meaning; it does not authorize backfilling
unknown legacy comments.

**Projection parity.** Apply the same attribution and omission rules wherever an
existing full comment is served: `comment.respond.comment`,
`comment.getThread.rootComment` and `replies`, `comment.list`'s included `comments`, and the full comments in
`comment.subscribe` snapshots and re-read deltas (§6.9). Any full comment in an
existing result/event uses the same fields and omission rules. A thread summary's
`latestCommentAuthorPrincipalId` / `latestCommentAuthorIdentity` copy the projected
fields of the **same comment** selected for `latestCommentAuthor` and
`latestCommentAuthorType`, including when `includeComments` is false; no separate
principal lookup or identity-selection rule. Omit each summary field when that
selected comment omits the corresponding field, even when another comment in
the thread has one.
Keep the existing ordering, `since` / `authorType` / `status` filters and visibility.

`comment.add` remains an acknowledgement without a full comment. Raw
`comment:added { noteId, commentId }` and
`comment:resolved { noteId, threadId, resolved }` remain ID-based durable events:
the subsequent read/subscription projection carries the attribution; no new event
or event-history backfill is implied. Old clients ignore unknown output fields;
new clients accept their absence from old hosts and legacy rows, keep the label,
and show qualified identity as unknown. This adds no RPC, capability or authority
flag. Component conformance cases are in [§5.49](./shared-host-membership.md#required-behavioral-conformance).

**Deletion notifications.** A successful `comment.delete` removes only a comment
belonging to the supplied workspace and note, then emits durable
`comment:deleted { noteId, commentId, threadId }` (§6.5). Failed deletion emits
nothing. The comment channel re-reads a surviving thread, including its count,
latest-author summary and remaining comments, or emits `removedIds: [threadId]`
when the final comment is gone (§6.9). Deleting a root while replies remain keeps
the original thread ID. Authorship on surviving comments is preserved.

#### Anchoring and updates

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
| task.updateStatus | noteId (req), taskText (req), status (req: `done` \| `todo` \| `in-progress`) | { ok, noteId, taskText, status } — rewrites the checkbox marker of the first checkbox line in `noteId` whose text matches `taskText` (exact match preferred, else the first line containing it) and emits `note:updated` for `noteId`. Any other `status` word → `-32603` (`Status must be 'done', 'todo', or 'in-progress'`); empty `taskText` → `-32603`. **Linked line ([intent-hq/intent#4255](https://github.com/intent-hq/intent/issues/4255)):** when the matched line links a task note (`[label](intent://local/task/{id})`), the write is **redirected to the task note** instead of the checkbox — see "Linked checkboxes are projections of the task note" below. The result echoes the requested `status` word either way |
| task.updateNoteStatus | noteId (req), status (req: `not_started` \| `waiting` \| `discussion_needed` \| `blocked` \| `in_progress` \| `review_required` \| `complete` \| `cancelled`), expectedVersion? | { ok, noteId, status, note, advisory? } — writes the task note's metadata status (see the vocabulary below; non-task note → `-32603 "Note is not a task. Use markAsTask() first."`). On an actual transition it emits `task:status-changed` + `task:ready-tasks-changed` (§6.5), re-announces dependents with `note:updated` when the move crosses the `complete` boundary (monorepo#1979), and may emit `workspace:displayStatus-changed`; a same-status write emits none of these. Either way it then **materializes** the status onto every checkbox line in the workspace that links the task (`[x]` / `[/]` / `[ ]`, one `note:updated` per rewritten note) — see "Linked checkboxes are projections of the task note" below. `expectedVersion?` enables optimistic concurrency against the note `rev`. **Caller-aware terminal guard** (within 9.13; additive, presence-detected): when the task is already `complete` / `cancelled` and the write is attributed to the task's OWN linked agent — the MCP `ws.task.updateNoteStatus` binding and the linked-checkbox redirects of `ws.task.updateStatus` / `ws.task.update` pass the calling agent; the session's `taskNoteId` names the task, or the agent is in the task's `assignedAgentIds` — a move to any other status is refused as a no-op: the task is not written and no `task:status-changed` / `task:ready-tasks-changed` / dependent `note:updated` fires (the checkbox materialization still runs, so a linked marker that had drifted from the terminal status is healed with one parent write + `note:updated`; an already-correct marker stays untouched), and the response answers `ok: true`, the **unchanged** `status` / `note`, plus `advisory` (`"Task is <complete\|cancelled>; a task's own linked agent cannot reopen it. Ask the coordinator or user to reopen the task if more work is needed."`). `advisory` is **absent** (never `null`) on every write that went through, so pre-guard responses are byte-identical. The router path carries no caller and is never guarded — coordinators, verifiers, and users reopen tasks exactly as before, as does any agent not linked to the task; a same-status write by the linked agent stays the ordinary no-op with no `advisory` |
| task.update | noteId (req), line (req,int), text?, status? (`todo` \| `in-progress` \| `done`), expected? | { ok, noteId, lineNumber, previousText, newText, status } (atomic single-line edit; at least one of `text` / `status` required; `expected` mismatch → `-32603 Conflict detected …` before anything is written). **Linked line (intent-hq/intent#4255):** when line `line` links a task note, a `status` write is redirected to the task note and the line's marker follows via materialization; a `text` edit on the same call lands in ONE parent write together with the materialized marker. The linked task is resolved from the **post-edit** line (the line after `text` is applied): a `text` that retargets the link from task A to task B sends the `status` write to **B** (A is untouched — it is no longer linked here) and renders B's marker, a `text`-only edit that changes the link renders the new target's **current** status marker in the same parent write, and a post-edit line with no link keeps the raw checkbox write — see "Linked checkboxes are projections of the task note" below |
| task.getMyTask | taskNoteId (req) | task note w/ metadata, dependencies, acceptance criteria. `taskMetadata` carries the stored `dependsOn?` / `conflictsWith?` relation lists and the result carries the computed `unmetDependsOn?` (v6.8; all presence-detected, omitted when empty) — see task.setRelations |
| task.markAsTask | noteId (req), status (req), acceptanceCriteria?, effort?, dependsOn?, conflictsWith? | { ok, ... } — always emits `note:updated` (the task-ness/metadata flip; without it a mark was invisible to note-driven refetches until the next unrelated note write). On a note that was **not** already a task it additionally emits `task:created` (§6.5). Re-marking an **existing** task is a status move instead: a real status change emits `task:status-changed` + `task:ready-tasks-changed` (the same pair `task.updateNoteStatus` publishes) and **no** `task:created`; re-marking at the same status emits neither — unless the re-mark's `dependsOn?` param actually changes the list, which recomputes + emits `task:ready-tasks-changed` with the `relations-changed` trigger (monorepo#1981), same as `task.setRelations`. `dependsOn?` / `conflictsWith?` (v6.8) seed/replace the task's relation lists under the same validation and cycle check as `task.setRelations`; omitted params leave an existing task's relations untouched. Every mark also **materializes** `status` onto the checkbox lines linking the note (one `note:updated` per rewritten parent, emitted after the task's own `note:updated` and before `task:created` / `task:status-changed`) — see "Linked checkboxes are projections of the task note" below |
| task.setRelations | noteId (req), dependsOn?, conflictsWith? | { ok, noteId, dependsOn, conflictsWith } *(v6.8)* — replaces the task's relation lists on `TaskMetadata` and echoes them normalized (deduped, first-seen order). An omitted param keeps the existing list; `[]` clears it. Validation (`-32603`, detail in `error.data`): every id must name a **task note in the same workspace** (missing notes and non-task notes rejected), self-edges rejected; a `dependsOn` write that would close a dependency cycle is rejected with the cycle path named (`"dependsOn would create a cycle: a -> b -> a"`); a `dependsOn` id that is a **tree ancestor or descendant** of the task (via `parent_id` chains, which may cross non-task notes) is rejected with the offending relationship named (`"dependsOn cannot reference a tree ancestor: a is an ancestor of b"` / `"… tree descendant: c is a descendant of b"`) — such an edge would permanently block readiness for both tasks (the parent waits on the child via the tree rule, the child on the parent via the edge; behavior applies to both `task.setRelations` and `task.markAsTask`, monorepo#1982). `conflictsWith` is advisory (symmetric by convention, stored one-sided) — no cycle check. Emits `note:updated` (metadata refetch, §6.5). Non-task note → `-32603 "Note is not a task"`. Readers project the relations plus the computed `unmetDependsOn` — the `dependsOn` ids whose task note is not `complete` (missing and cancelled deps count as unmet) — on `task.getMyTask`, `task.list` / `task.get` rows, and `note.listTasks` rows with a linked task note (all additive, omitted when empty). `dependsOn` also **gates readiness** (behavior only within v6.8, no event-shape change; monorepo#1974): the ready-task recomputation behind `task:ready-tasks-changed` (§6.5) generalizes the tree rule — a task is ready iff all its task children are `complete` AND its `dependsOn` list is fully satisfied (same rule as `unmetDependsOn`: missing and cancelled deps do NOT satisfy an edge), so cross-subtree ordering edges keep a task out of `readyTaskIds` until every dep completes. A write that actually **changes** `dependsOn` additionally recomputes + emits `task:ready-tasks-changed` after the `note:updated`, with the additive trigger `triggeredBy: { noteId, reason: "relations-changed" }` (monorepo#1981; §6.5) — a no-op write or a conflictsWith-only change emits no recompute |
| task.convertBlocks | noteId (req) | { ok, convertedCount, createdNoteIds, createdTasks, warnings } — each converted `@@@task` block becomes a child task note emitting `note:created` + `task:created` (§6.5). The fence line takes optional **header attributes** (v6.11, intentd#1128/#1130/#1133): `@@@task key=<token> dependsOn=<a,b> conflictsWith=<c> effort=<token>` — whitespace-separated `name=value` pairs after the keyword, bare tokens (no quoting), `dependsOn`/`conflictsWith` comma-separated and whitespace-tolerant around commas. Each `dependsOn`/`conflictsWith` reference resolves in order: sibling block `key=`s in the same conversion → exact sibling block titles → existing task-note ids in the workspace; resolved edges are written through the same validator as `task.setRelations` (cycle + tree ancestor/descendant checks), and `effort` seeds the task's `estimatedEffort`. **Convert-with-warnings:** conversion never fails on bad attributes — every block still converts, and each header parse issue, unknown/duplicate/empty attribute, unresolvable or ambiguous reference, or validator-rejected edge is skipped with one entry in `warnings` naming the block and the problem. `createdTasks` is `[{ key?, title, noteId }]` in block order, parallel to `createdNoteIds` (`key` present only when authored; idempotently reused existing children are not listed — a reused block's `effort` is dropped with a warning). `createdTasks` / `warnings` are always present (empty arrays when nothing applies) |
| task.createPrerequisite | dependentNoteId (req), title (req), content?, status? | { ok, ... } — the prerequisite note is born a task, emitting `note:created` + `task:created` (§6.5). `-32602` when `content` is the line-numbered `note.read` display (see "Numbered `note.read` display rejected on content writes", §5.2); nothing is created |
| task.assignAgent | noteId (req), agentId (req), force?: bool | { ok, noteId, agentId } — **Occupancy guard (intentd#774):** assigning a NEW agent to a task that already has a live assigned agent — loadable, not Deleted, not poisoned (the same live/resumable predicate as `agent.delegate`'s pre-gate, §5.5) — while the task status is not `complete`/`cancelled` is rejected with `-32602` (InvalidParams); the error message names the existing agent's id and name and suggests `agent.sendToTask` / `agent.wakeOrCreate` to reach it, or `force: true` to intentionally assign a second agent. Re-assigning an already-assigned agent stays idempotent-ok (no `force` needed); `force: true` bypasses the guard. Emits `note:updated` for the task note, then **materializes** the task's resulting status onto the checkbox lines linking it (one `note:updated` per rewritten parent — a `not_started → in_progress` move flips `[ ]` → `[/]`), then the `task:status-changed` + `task:ready-tasks-changed` pair when the assignment moved the status — see "Linked checkboxes are projections of the task note" below |

```json
// → request
{ "jsonrpc":"2.0","id":11,"method":"task.update",
  "params":{ "workspaceId":"ws-abc","noteId":"task-1","line":3,"status":"done" } }
// ← response
{ "jsonrpc":"2.0","id":11,"result":{ "ok": true, "lineNumber": 3, "status": "done" } }
```

**Linked checkboxes are projections of the task note** *(behavior only within 9.4, no
method-catalog or wire-shape change; [intent-hq/intent#4255](https://github.com/intent-hq/intent/issues/4255))*.
A checkbox line whose text carries a task link — `- [ ] [label](intent://local/task/{id})`,
the shape `task.convertBlocks` writes for every `@@@task` block — is a **projection of that
task note's metadata status**: the task note is the source of truth and the checkbox
marker is derived from it. Only the line's **first** task link counts; the marker
mapping is `complete` → `[x]`, `in_progress` → `[/]`, every other status
(`not_started`, `waiting`, `discussion_needed`, `blocked`, `review_required`,
`cancelled`) → `[ ]`. The contract has two halves:

- **Materialization (task → checkbox).** Every daemon-side task-note status write —
  `task.updateNoteStatus`, `task.markAsTask` (fresh mark and re-mark alike), and
  `task.assignAgent` (with the task's resulting status, whether or not the assignment
  moved it `not_started → in_progress`) — rewrites the marker of
  every checkbox line **in the workspace** whose first task link names the task, across
  every note that links it (a task linked from two notes, or twice in one note, is
  rewritten everywhere). The set of writers is closed: every other path that moves a
  task's status is a caller of one of these three — the MCP attention bindings
  `ws.agent.reportToParent` (→ `review_required`), `ws.agent.requestDiscussion`
  (→ `discussion_needed`) and `ws.agent.reportBlocker` (→ `blocked`) drive the caller's
  linked task through the `task.updateNoteStatus` writer (§5.5; skipped when the task is
  already `complete`/`cancelled` or already at the target), and `agent.delegate` /
  `agent.wakeOrCreate` assign the spawned agent through `task.assignAgent` — so, for
  example, `reportToParent` on an `in_progress` task flips its `[/]` lines to `[ ]`.
  Since the task note is **itself** a candidate parent, a task note containing a
  checkbox whose first task link names that same task has that line rewritten too, on
  the same terms as any other parent. The marker written is derived from the task note's status
  **re-read at materialization time**, not the status the caller observed, so the last
  writer always projects the task's latest status. Each rewritten note is persisted through the normal update path
  (its `rev` bumps) and takes its own `note:updated`; a note whose linked lines already
  carry the marker is **left untouched** — no write, no event, no `rev` bump (so
  `not_started → blocked`, both `[ ]`, rewrites nothing). Unlinked checkbox lines and
  lines linking other tasks are byte-for-byte unchanged. Materialization is best-effort:
  a store failure on a linked note is logged and never fails the status write that
  already succeeded.
- **Redirection (checkbox → task).** `task.updateStatus` and `task.update` on a linked
  line do **not** write the marker directly: the status word maps onto the task note —
  `done` → `complete`, `in-progress` → `in_progress`, and `todo` **reopens** a task whose
  status is `complete` or `in_progress` to `not_started` while leaving every detailed
  status that already renders as `[ ]` (`blocked`, `waiting`, `discussion_needed`,
  `review_required`, `cancelled`) **untouched** — the write goes through the same path
  as `task.updateNoteStatus` (`task:status-changed` + `task:ready-tasks-changed`,
  dependent re-announce, `displayStatus` probe), and the marker follows via
  materialization. A word the task already projects (`done` on a `complete` task,
  `todo` on a `blocked` task) writes nothing to the task and emits no `task:*` event; if
  the line's marker had **drifted** from the task's status, materialization still heals
  it in one parent write (`note:updated`), and when the marker already matches, no
  parent write happens at all. `task.update` with both `text` and `status` on a linked
  line lands the text edit and the projected marker in ONE parent write (`rev + 1`,
  one `note:updated`), then performs the task write; its `expected` check still
  conflicts before anything is written. `task.update` resolves the linked task from the
  **post-edit** line — the line after `text` is applied. If the edit retargets the link
  from task A to task B, the `status` write goes to **B** (A is untouched — it is no
  longer linked here) and the line renders B's marker; a `text`-only edit that changes
  the link likewise renders the new target's **current** status marker in the same
  parent write (no `status` word needed); a post-edit line with no link keeps the raw
  checkbox write. The RPC results are unchanged in shape and both carry the `noteId` of
  the **parent**, never the task note; their `status` words differ: `task.updateStatus`
  echoes the **requested** word, `task.update` returns the marker the line **projects**
  after the write (the two agree whenever the redirected write is accepted). **The
  caller-aware terminal guard** of `task.updateNoteStatus` applies to both redirects: a
  word that would move a `complete` / `cancelled` task, written by the task's OWN linked
  agent, is refused — the task stays where it is and no `task:*` event fires. The parent
  is left untouched (no write, no `rev` bump, no `note:updated`) only when the text is
  unchanged and the linked line already carries the terminal marker; a marker that had
  drifted is healed by the ordinary materialization (one parent write + `note:updated`),
  and a genuine `text` edit persists as usual. `task.update` resolves the guard
  **before** its parent write, so the line projects the status the task actually keeps:
  a real `text` edit lands in ONE parent write carrying the terminal marker, and the
  result's `status` is that marker (`done` for a refused `todo` against a `complete`
  task), whereas `task.updateStatus` still echoes the refused word (`todo`) with the
  task and line unchanged. **Dangling links keep the raw checkbox write:** a
  link whose id names no note in the workspace, or a note that is not a task, is not a
  projection — the marker is rewritten in place exactly as on an unlinked line
  (`note:updated` only, no `task:*` event, no task metadata created).

Read-side consequence: a `note.listTasks` row with a `taskNoteId` reports the
materialized line's `status` word (`done` / `in-progress` / `todo`), so it agrees with
the linked task's `task.get` status modulo the many-to-one `[ ]` mapping.

Event ordering per path (all after the persisted writes, before the RPC response):

- `task.updateNoteStatus` and the redirected `task.updateStatus` / `task.update`
  (transition case): `task:status-changed` → `task:ready-tasks-changed` → dependents'
  `note:updated` (complete-boundary crossing only) → `workspace:displayStatus-changed`
  (only when the rollup moved) → one `note:updated` per rewritten parent note. The
  metadata write to the task note itself emits no `note:updated` on this path — the task
  note takes one only when it is also a rewritten parent (it contains a line whose first
  task link names itself and that line's marker changed), in which case it is the
  ordinary per-parent `note:updated` at the end of the sequence; the no-transition case
  emits only the parent `note:updated` (when a marker changed).
- `task.markAsTask` and `task.assignAgent`: the task note's own `note:updated` →
  one `note:updated` per rewritten parent note → `task:created` /
  `task:status-changed` + `task:ready-tasks-changed` as documented on their rows.

**Task-note status vocabulary.** `task.updateNoteStatus` (and the task-note `status` served
by every task projection) accepts `not_started | waiting | discussion_needed | blocked |
in_progress | review_required | complete | cancelled`. `blocked` *(new in intentd)* is
raised by the MCP `ws.agent.reportBlocker` binding (§5.5 agent attention requests) when an
agent reports an infrastructure/environment blocker it cannot resolve; like
`discussion_needed`, it is non-terminal and excluded from `inProgress` in the
`computeTaskStats` rollups (§5.1 card aggregates / `task.list` stats).

**Task projections & bulk cleanup.** Two read methods project a workspace's task notes into the canonical `WorkspaceTask` shape, and one bulk write clears an agent from every task in a workspace.

| Method | Params | Result |
| --- | --- | --- |
| task.list | workspaceId (req), status? | { tasks: WorkspaceTask[], stats: WorkspaceTaskStats } — `tasks` membership is **workspace-wide** *(widened within 6.17; [intent-hq/intentd#1214](https://github.com/intent-hq/intentd/pull/1214))*: EVERY task note in the workspace (any note with task metadata except the spec itself) — direct spec children, subtasks (children of tasks), and unlinked tasks alike; stored note order, deduped by id. Each row carries the always-serialized `specLinked` flag (additive, always present): `true` iff the task id appears in the spec note body's `intent://local/task/{id}` links, `false` otherwise (including every row when the spec has no links; not conditioned on `parent_id`) — plus the additive `parentId?` field (presence-detected, omitted when the backing note has no parent): the note's parent pointer, so clients can distinguish subtasks (parent is another task) from unlinked top-level tasks and reconstruct the hierarchy from `task.list` alone. The optional `status` filter narrows `tasks` only. `stats` is UNCHANGED — still the `{ total, completed, inProgress }` aggregate over the **spec-linked** set (§5.1 card aggregates — same `computeTaskStats` projection: `cancelled` is excluded from `total`, `complete` counts as `completed`, `in_progress` + `review_required` count as `inProgress`) served alongside the filtered task list — **including its no-links fallback**: a spec with no `intent://local/task/{id}` links still counts all direct child task notes in `stats`, while every `tasks` row in that same response reports `specLinked: false` — so clients must NOT correlate `stats` membership with the `specLinked` flag in the no-links case. Each `WorkspaceTask` row also carries the relation fields `dependsOn?` / `conflictsWith?` / computed `unmetDependsOn?` (v6.8; presence-detected, omitted when empty — see task.setRelations) |
| task.get | workspaceId (req), taskNoteId (req) | { task: WorkspaceTask } — unknown id → `-32602 Task not found`. Same `specLinked` flag (computed from the spec note body), `parentId?`, and relation fields as the task.list rows (v6.8) |
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
