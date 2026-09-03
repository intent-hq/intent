> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.2 `note.*` · §5.2.1 `note.lineAttribution.*` · §5.3 `comment.*` · §5.4 `task.*`.

### 5.2 `note.*`

All `note.*` methods require `workspaceId`. All except `list` and `create` additionally require `noteId` (`list` returns every note; `create` mints a new id). The spec note is addressed with the well-known id `"spec"`.

| Method | Params | Result |
| --- | --- | --- |
| note.list | workspaceId (req), projection?: "slim" \| "full" *(v8.1)* | { notes: NoteSummary[] } — **Projection (`projection`, additive within v8.1 — [intent-hq/intentd#1508](https://github.com/intent-hq/intentd/pull/1508), monorepo#3573):** absent / `null` / `"full"` keep the full rows byte-identical to before — **full stays the default**, unlike the v8.0 conversation surfaces, because existing consumers (the iOS client) still read `content` off list rows; `"slim"` serves bounded listing rows with `content` omitted, replaced by `contentPreview` (the first 500 chars, char-boundary safe by construction) plus `contentLength` (total chars — Unicode scalar values, the same unit as the note.listVersions summaries' `contentLength` for the NUL-free content the daemon writes — note.listVersions uses SQL `LENGTH`, which stops at the first U+0000), every other Note field serializing exactly as the full row does — full responses scale with total workspace note content, so note-heavy workspaces tripped the transport's 1 MiB outbound frame warning; any other value is `-32602` (`projection must be "slim" or "full"`), never coerced. Serve-time only — stored rows are untouched. Older-daemon interop: pre-8.1 daemons read only `workspaceId` off `note.list` params and ignore unknown members, so sending `projection: "slim"` to a pre-8.1 daemon is silently ignored and serves full rows (never an error) — clients that need slim rows must gate on `protocolVersion` ≥ 8.1 (or detect `contentPreview` presence on the rows they get back). The note subscription channel gained the same projection in v8.2 — see the `note.subscribe` row in §6.9. -32602 with `error.data.code: "not-found"` when the workspace does not exist (deleted, or never created; monorepo#3404 — previously a best-effort empty list). Task-note rows with `dependsOn` edges carry the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty — see §5.4 task.setRelations). The field is guaranteed only on read/push shapes (`note.get`/`note.list` and the subscription snapshots/deltas they serve); notes embedded in mutation *responses* (e.g. `task.updateNoteStatus`'s `note`, `note.update`'s `note`) may omit it — clients should not patch caches from mutation responses expecting the projection |
| note.get | noteId (req) | { note: Note } — -32602 with `error.data.code: "not-found"` if not found. A task note with `dependsOn` edges carries the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty; read/push shapes only — see the note.list row) |
| note.create | title (req), content?, tags?: string[], parentId?, idempotencyKey? | { note, convertedCount, createdTaskNoteIds, createdTasks, warnings } — within v6.14 ([intent-hq/intentd#1162](https://github.com/intent-hq/intentd/pull/1162), monorepo#2129) the result carries the `@@@task` auto-conversion outcome for the initial content, **additive** over the old `{ note }` shape (clients reading `.note` are unaffected): same shapes and warning contract as the four content-write ops (see "`@@@task` auto-conversion on note writes" below and the `task.convertBlocks` row, §5.4), with all four fields always present (`convertedCount: 0` plus empty arrays when the content converts nothing). `note` is the refetched post-conversion row, so its `rev`/`updatedAt` reflect the conversion write. An `idempotencyKey` replay returns the stored result without re-executing; a replayed key recorded before the conversion fields existed decodes the stored bare note as a zeroed conversion outcome. `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.update | noteId (req); content? or title?/tags? | { note } — content present → full setContent; else metadata update. `-32602` when `content` is the line-numbered `note.read` display (see "Numbered `note.read` display rejected on content writes" below) |
| note.add | noteId (req), content (req), heading?, position?: "end" \| "start" | { ok, ... } — `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.edit | noteId (req), old (req), new (req) | { ok, ... } — first exact-match replacement. `-32602` when `new` is the line-numbered `note.read` display (see below) |
| note.editLines | noteId (req), start (req,int), end (req,int), content (req) | { ok, ... } (1-based inclusive). `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.setContent | noteId (req), content (req), confirmReplacement?: boolean | { ok, ... } (full replace). `-32602` when `content` is the line-numbered `note.read` display (see below) |
| note.updateMetadata | noteId (req), title?, tags?: string | string[] |
| note.delete | noteId (req) | { ok, noteId, deleted } — emits `note:deleted`. Deleting a **task note** additionally recomputes + emits `task:ready-tasks-changed` (§6.5) after the `note:deleted`, with the additive trigger `triggeredBy: { noteId, reason: "note-deleted" }` (monorepo#1981; generalized by intentd#1121, monorepo#2006), whenever the delete actually **moves** the ready set: deleting a task that was itself ready drops its id from `readyTaskIds`, deleting the last incomplete task child of a parent readies the parent (tree rule), and deleting a task note that other tasks `dependsOn` keeps the #1981 always-emit contract — the dangling edge counts as unmet, so deleting a previously-`complete` dep drops its dependents out of `readyTaskIds`. The pre-delete and post-delete ready sets are compared, so a delete that provably cannot move the set (e.g. a terminal task nobody depends on) emits no recompute. Deleting a **`complete`** dep also re-announces each dependent task note via `note:updated` (the computed `unmetDependsOn` projection moved, monorepo#1979) after the ready-set event — same ordering as the status-transition path (`task:*` first, dependent `note:updated` last) |
| note.listTasks | noteId (req) | { tasks: [...] } (checkbox/task rows + taskNoteId). Rows with a linked task note also carry the linked task's `dependsOn?` / `conflictsWith?` / computed `unmetDependsOn?` (v6.8; presence-detected, omitted when empty — see §5.4 task.setRelations) |
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
fetched and before the CRDT merge, so a rejected write touches neither the store nor
the `yrs` document (the note is unchanged, no version is appended, no event is
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
| task.getMyTask | taskNoteId (req) | task note w/ metadata, dependencies, acceptance criteria. `taskMetadata` carries the stored `dependsOn?` / `conflictsWith?` relation lists and the result carries the computed `unmetDependsOn?` (v6.8; all presence-detected, omitted when empty) — see task.setRelations |
| task.markAsTask | noteId (req), status (req), acceptanceCriteria?, effort?, dependsOn?, conflictsWith? | { ok, ... } — always emits `note:updated` (the task-ness/metadata flip; without it a mark was invisible to note-driven refetches until the next unrelated note write). On a note that was **not** already a task it additionally emits `task:created` (§6.5). Re-marking an **existing** task is a status move instead: a real status change emits `task:status-changed` + `task:ready-tasks-changed` (the same pair `task.updateNoteStatus` publishes) and **no** `task:created`; re-marking at the same status emits neither — unless the re-mark's `dependsOn?` param actually changes the list, which recomputes + emits `task:ready-tasks-changed` with the `relations-changed` trigger (monorepo#1981), same as `task.setRelations`. `dependsOn?` / `conflictsWith?` (v6.8) seed/replace the task's relation lists under the same validation and cycle check as `task.setRelations`; omitted params leave an existing task's relations untouched |
| task.setRelations | noteId (req), dependsOn?, conflictsWith? | { ok, noteId, dependsOn, conflictsWith } *(v6.8)* — replaces the task's relation lists on `TaskMetadata` and echoes them normalized (deduped, first-seen order). An omitted param keeps the existing list; `[]` clears it. Validation (`-32603`, detail in `error.data`): every id must name a **task note in the same workspace** (missing notes and non-task notes rejected), self-edges rejected; a `dependsOn` write that would close a dependency cycle is rejected with the cycle path named (`"dependsOn would create a cycle: a -> b -> a"`); a `dependsOn` id that is a **tree ancestor or descendant** of the task (via `parent_id` chains, which may cross non-task notes) is rejected with the offending relationship named (`"dependsOn cannot reference a tree ancestor: a is an ancestor of b"` / `"… tree descendant: c is a descendant of b"`) — such an edge would permanently block readiness for both tasks (the parent waits on the child via the tree rule, the child on the parent via the edge; behavior applies to both `task.setRelations` and `task.markAsTask`, monorepo#1982). `conflictsWith` is advisory (symmetric by convention, stored one-sided) — no cycle check. Emits `note:updated` (metadata refetch, §6.5). Non-task note → `-32603 "Note is not a task"`. Readers project the relations plus the computed `unmetDependsOn` — the `dependsOn` ids whose task note is not `complete` (missing and cancelled deps count as unmet) — on `task.getMyTask`, `task.list` / `task.get` rows, and `note.listTasks` rows with a linked task note (all additive, omitted when empty). `dependsOn` also **gates readiness** (behavior only within v6.8, no event-shape change; monorepo#1974): the ready-task recomputation behind `task:ready-tasks-changed` (§6.5) generalizes the tree rule — a task is ready iff all its task children are `complete` AND its `dependsOn` list is fully satisfied (same rule as `unmetDependsOn`: missing and cancelled deps do NOT satisfy an edge), so cross-subtree ordering edges keep a task out of `readyTaskIds` until every dep completes. A write that actually **changes** `dependsOn` additionally recomputes + emits `task:ready-tasks-changed` after the `note:updated`, with the additive trigger `triggeredBy: { noteId, reason: "relations-changed" }` (monorepo#1981; §6.5) — a no-op write or a conflictsWith-only change emits no recompute |
| task.convertBlocks | noteId (req) | { ok, convertedCount, createdNoteIds, createdTasks, warnings } — each converted `@@@task` block becomes a child task note emitting `note:created` + `task:created` (§6.5). The fence line takes optional **header attributes** (v6.11, intentd#1128/#1130/#1133): `@@@task key=<token> dependsOn=<a,b> conflictsWith=<c> effort=<token>` — whitespace-separated `name=value` pairs after the keyword, bare tokens (no quoting), `dependsOn`/`conflictsWith` comma-separated and whitespace-tolerant around commas. Each `dependsOn`/`conflictsWith` reference resolves in order: sibling block `key=`s in the same conversion → exact sibling block titles → existing task-note ids in the workspace; resolved edges are written through the same validator as `task.setRelations` (cycle + tree ancestor/descendant checks), and `effort` seeds the task's `estimatedEffort`. **Convert-with-warnings:** conversion never fails on bad attributes — every block still converts, and each header parse issue, unknown/duplicate/empty attribute, unresolvable or ambiguous reference, or validator-rejected edge is skipped with one entry in `warnings` naming the block and the problem. `createdTasks` is `[{ key?, title, noteId }]` in block order, parallel to `createdNoteIds` (`key` present only when authored; idempotently reused existing children are not listed — a reused block's `effort` is dropped with a warning). `createdTasks` / `warnings` are always present (empty arrays when nothing applies) |
| task.createPrerequisite | dependentNoteId (req), title (req), content?, status? | { ok, ... } — the prerequisite note is born a task, emitting `note:created` + `task:created` (§6.5). `-32602` when `content` is the line-numbered `note.read` display (see "Numbered `note.read` display rejected on content writes", §5.2); nothing is created |
| task.assignAgent | noteId (req), agentId (req), force?: bool | { ok, noteId, agentId } — **Occupancy guard (intentd#774):** assigning a NEW agent to a task that already has a live assigned agent — loadable, not Deleted, not poisoned (the same live/resumable predicate as `agent.delegate`'s pre-gate, §5.5) — while the task status is not `complete`/`cancelled` is rejected with `-32602` (InvalidParams); the error message names the existing agent's id and name and suggests `agent.sendToTask` / `agent.wakeOrCreate` to reach it, or `force: true` to intentionally assign a second agent. Re-assigning an already-assigned agent stays idempotent-ok (no `force` needed); `force: true` bypasses the guard |

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

