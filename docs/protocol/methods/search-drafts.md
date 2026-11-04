> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.15 `search.*` · §5.16 `drafts.*`.

Routing-only `workspaceId?` additions below are [prepared contract fields](../workspace-routing.md), optional on direct daemons and required for future forwarded workspace calls; existing scope and results are unchanged. The optional `workspaceId` on `search.notes`, `search.messages` and `search.events` is instead a real search filter; never inject the focused workspace into a global query.

### 5.15 `search.*`

> Search is a **BE-owned namespace**: it executes on the daemon **where the code and data
> live**, so a thin client just renders results (when the daemon *is* the remote host, `rg`
> runs locally to it).

| Method | Params | Result |
| --- | --- | --- |
| search.inFiles | workspaceId (req), query (req), opts? { caseSensitive?, regex?, globs?, maxResults? }, requestId? | { requestId, matches: SearchMatch[], truncated } — ripgrep content search. `maxResults` absent → 500, larger than 2,000 → 2,000 (behaviour change: absent meant no cap); size bounds below |
| search.fileNames | workspaceId (req), pattern (req), limit?, requestId? | { requestId, files: string[], truncated } — path/glob search |
| search.messages | query (req), workspaceId?, preferWorkspaceId?, agentId?, role?, limit?, requestId? | { requestId, matches: MessageMatch[] } — **FTS5/bm25-ranked** full-text search over persisted agent transcripts (BE owns session storage). `workspaceId` is **optional**: absent → **global** search across all workspaces; present → hard scope filter. `preferWorkspaceId` is a **soft ranking boost** — matches from that workspace outrank equally-relevant matches from other workspaces, but results stay global (nothing is excluded). Matches from **archived** workspaces carry a fixed soft rank penalty, giving the default tier order preferred workspace → other active → archived (relevance can still override). `agentId`/`role` narrow further (hard filters); `limit` caps the match count (absent → 50, larger than 200 → 200, negative → 0; behaviour change: absent or negative meant no cap). Semantics block below |
| search.events | query (req), workspaceId?, limit?, requestId? | { requestId, matches: EventMatch[] } — over the BE event log. `limit` caps the match count (absent → 50, larger than 200 → 200, negative → 0; behaviour change: absent meant no cap) |
| search.notes | query (req), workspaceId?, preferWorkspaceId?, limit?, includeArchived?, requestId?, nextToken? | { requestId, matches: NoteMatch[], indexed: true, nextToken: string \| null } — **FTS5/bm25-ranked** title, body and tag search across accessible workspaces; always inline, one page at a time. `workspaceId` hard-filters; `preferWorkspaceId` softly boosts. `limit` is the page size (absent → 50, larger than 200 → 200; behaviour change: absent meant no cap); `nextToken` continues the ranked list; `includeArchived` absent → true (individual note archives). Indexed contract and compatibility below |
| search.codebase | workspaceId (req), query (req), requestId? | { requestId, matches: CodebaseMatch[] } — **ripgrep/symbol-backed** search. auggie exposes no structured codebase-retrieval CLI, so `AuggieContextEngine::retrieve()` returns `Unavailable` instantly and ripgrep is the backing; the `ContextEngine` trait is retained as forward-looking infra |
| search.cancel | requestId (req), workspaceId? | { ok: true } — aborts an in-flight search by its `requestId` |

Memories search is **daemon-internal (no wire method)**: there is no `search.memories` router arm — the memories store is queried inside the daemon (agent memory recall, §5.22), never by a client RPC.

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
  preview: string;     // the matching line (trimmed; windowed around the match to at most 400 chars plus a `…` at each cut end)
  before?: string[];   // optional context lines before
  after?: string[];    // optional context lines after
  score?: number;      // relevance (semantic/codebase results)
}
// EventMatch / MemoryMatch / CodebaseMatch are store-specific:
// each carries its entity id (eventId / memoryId / symbol),
// a `preview` snippet, and an optional `score`.

interface NoteMatch {
  noteId: string;
  preview: string;          // plain-text display snippet, never trusted HTML
  score?: number;           // indexed hits always emit -adjustedRank; higher = better
  workspaceId: string;      // identity/navigation key is (workspaceId, noteId)
  title: string;            // shortened only on a hit too large for a page:
  titleTruncated?: true;    //   then titleTruncated and titleBytes (the full
  titleBytes?: number;      //   UTF-8 length) are set; note.get reads it whole
  updatedAt: string;        // persisted note updated_at, RFC 3339
  isArchived: boolean;     // the note's own archive state
  workspaceArchived: boolean; // independently, its workspace's archive state
}

interface MessageMatch {
  agentId: string;
  messageId: string;
  preview: string;      // windowed onto the first raw-query token occurring in the text
  score?: number;       // negated adjusted bm25 rank — higher = more relevant
  workspaceId: string;  // owning workspace — makes global results navigable
  agentName: string;    // agent display name
  role: string;         // "user" | "assistant"
  timestamp: string;    // the message row's created_at
}
```

**`search.messages` semantics (FTS5, additive).** Backed by a trigger-maintained FTS5 index
over the extracted plain text of persisted `user`/`assistant` transcript rows (other roles are
not indexed), ranked by bm25 — matches order by adjusted rank, then newest-first, one match per
matching message (no per-agent collapse). `preferWorkspaceId` subtracts a fixed boost from the
bm25 rank (lower = better) of matches owned by the preferred workspace: large enough to lift a
preferred-workspace match above equally-relevant matches elsewhere, small enough that a
decisively better match from another workspace still wins. Symmetrically, matches owned by
**archived** workspaces get a fixed penalty (same bm25-unit scale as the boost) added to their
rank — applied regardless of whether `preferWorkspaceId` is set — so the default tier order is
preferred workspace → other active workspaces → archived workspaces. Both adjustments are
**soft**: a decisively more relevant match still overrides tier order, and nothing is excluded.
**User-typed queries never error:** the raw query is never handed to the FTS5 query parser
verbatim — it is reduced to its
alphanumeric tokens, each matched as a quoted phrase joined with `AND`, with the final token —
presumed mid-typing — also matching as a prefix; operators, quotes, and punctuation are
stripped rather than surfacing `fts5: syntax error`, and a query with no searchable tokens
yields empty `matches`, not an error. The enriched `MessageMatch` fields (`workspaceId`,
`agentName`, `role`, `timestamp`) are additive — pre-existing consumers of
`agentId`/`messageId`/`preview`/`score` are unaffected.

**`search.notes` semantics (indexed contract).** The request and result fields are additive;
the matching behavior deliberately changes from a case-insensitive literal substring scan to
token-based full-text search. Index the note's title, raw Markdown body and tags, not comments,
version history or attachments. Reuse the transcript query sanitizer: split on non-alphanumeric
characters, quote each token, join tokens with `AND`, and match the final token as either a
whole token or a prefix. Use the same case-insensitive `porter unicode61` tokenizer as
transcripts. Quotes and punctuation are separators; typed words such as `OR` are literal
tokens, never FTS operators. Empty, whitespace-only and punctuation-only queries succeed with
empty `matches`. Multiword matches need not be adjacent and may span title/body/tags; arbitrary
middle-of-word substrings, regex and exact-phrase search are not supported.

**Scope, archive defaults and limits.** Omit `workspaceId` to search all workspaces the caller
can access on the contacted daemon. An explicit `workspaceId` is a hard filter and requires
the same workspace access as other scoped searches. `preferWorkspaceId` changes ranking only:
it neither filters nor grants access, and an unknown/inaccessible preference has no effect.
Apply visibility, workspace and note-archive filters **before** selecting the final top-N;
inaccessible hits must neither appear nor displace accessible results. Return at most one hit
per `(workspaceId, noteId)`, since note IDs such as `spec` repeat across workspaces.

`includeArchived` defaults to `true` to preserve legacy API inclusion of individually archived
notes. Explicit `false` removes individually archived notes. This does **not** exclude archived
workspaces: accessible, non-archived notes in those workspaces remain eligible, with a soft rank
penalty and `workspaceArchived: true`. `limit` is a nonnegative integer page size: omitted
means 50, values over 200 clamp to 200, and `0` means no matches (`nextToken: null`). Optional
`null` values act as omission for all parameters. The palette sends `limit: 10`,
`includeArchived: false`, and the active workspace as `preferWorkspaceId`, leaving `workspaceId`
absent. It retains its five-row display cap in ordinary, unfiltered search.

**Ranking and previews.** Use weighted bm25 with title/body/tags weights **5/1/2**. Adjust its
rank (lower is better) by subtracting **1.0** for the preferred workspace and adding **1.0** for
an archived workspace; both adjustments compose, including when the preferred workspace is
archived. These are soft adjustments, not mandatory tiers: a sufficiently relevant result
elsewhere can win. Sort by adjusted rank ascending, then `updatedAt` descending, then
`workspaceId` and `noteId` ascending (binary string order) for deterministic ties. The emitted
`score` is the negated adjusted rank, always present on indexed hits; its optional type preserves
the legacy shape. Clients preserve the server's indexed order, rather than re-filtering body-only
hits by title or tags. Scores are not normalized or comparable across different queries.

`preview` uses the transcript-style bounded, whitespace-collapsed window around the first query
token occurring literally in the text, falling back to the beginning when stemming finds no
literal occurrence. It may contain Markdown source punctuation and must be rendered as plain
text, never injected as HTML. It supplies display context, not editor offsets or a promise of
exact-passage scrolling/highlighting. The result carries note title and archive context without
fetching the note body; workspace display names resolve through accessible workspace metadata.

**Pages.** A reply holds at most `limit` hits in ranked order and stays within 480,000
serialized result bytes, so the frame stays under 512,000. A hit cut by the byte budget is the
first hit of the next page, never dropped; every page carries at least one hit while hits
remain. `nextToken` is a string when more hits follow and `null` when the list is complete
(a page that reaches `limit` exactly may still end the list). To continue, send the same
`query`, `workspaceId`, `preferWorkspaceId` and `includeArchived` with the token (`limit` and
`requestId` may change); a malformed token or one from a different search is `-32602`
`"invalid-params"`. The token is opaque and resumes after the page's last hit by its position
in the ranked order (a keyset, not a count), re-anchoring on the page's recent hits at their
current ranks. Deleting, archiving or editing a note already served therefore normally never
skips a hit that still matches. If every recent hit of the page was deleted or edited before the
next request, the page resumes from the last hit's stored rank and may skip or repeat hits; rank
changes from other notes can rarely reorder hits across the page boundary. A page may repeat a
hit whose own rank rose, or include a note that newly matches. A hit edited to rank higher
than the page end before it is served moves onto an earlier page and is not returned again.
A single hit larger than a page (only an extremely long title can do this) keeps a shortened
`title`, cut on a UTF-8 boundary, and adds
`titleTruncated: true` and `titleBytes` (the full title's UTF-8 length); `note.get` reads the
whole title. Older clients that ignore `nextToken` see the first page.

**Delivery, errors and compatibility.** Indexed note searches always return their page inline,
even with an explicit `workspaceId` or more than 25 matches. No `search:result`
or `search:done` event is required. `requestId` is echoed when supplied and minted otherwise;
the ordinary `search.cancel` request-ID contract remains, including no-op cancellation after
completion. An existing `truncated: false` result member may remain for compatibility; reaching
the requested limit does not promise a total-count or truncation signal.

Every successful indexed response includes the literal capability marker **`indexed: true`**,
including an empty result, a punctuation-only query and `limit: 0`. Detect support from this
marker, never from match count or an enriched field on the first hit. Old daemons ignore the new
parameters and return legacy rows without the marker. When the marker is absent (or the method
is unavailable), the palette retains local fuzzy title/tag discovery and empty-query browsing;
it must not interpret legacy global rows as belonging to the current workspace. On supported
daemons it merges local discovery and indexed hits by composite identity, retaining body-only
hits. A failed request is not proof of an empty result; clients must clear stale indexed hits
and preserve local discovery. Debounce/cancellation and query/workspace generation checks must
prevent late responses after typing, closing or changing workspace from replacing current hits.

Missing/non-string `query`, non-null optional parameters with the wrong type, empty
`workspaceId`/`preferWorkspaceId`, or a negative, fractional or out-of-range signed 64-bit
`limit` yield `-32602` with `error.data.code: "invalid-params"`. An inaccessible or nonexistent
hard-scoped workspace uses the existing non-disclosing `-32602` / `"not-found"` convention.
Tokenless queries are not errors. Store/index failures propagate through the ordinary §9 error
contract; they must not silently masquerade as successful empty indexed results.

Example palette request and indexed response (illustrative score):

```json
{"jsonrpc":"2.0","id":92,"method":"search.notes","params":{"query":"release che","preferWorkspaceId":"ws-current","limit":10,"includeArchived":false,"requestId":"notes-1"}}
```

```json
{"jsonrpc":"2.0","id":92,"result":{"requestId":"notes-1","indexed":true,"matches":[{"noteId":"spec","workspaceId":"ws-other","title":"Release checklist","preview":"Verify the release checklist before promotion.","score":0.8,"updatedAt":"2026-10-01T00:00:00Z","isArchived":false,"workspaceArchived":true}],"nextToken":null}}
```

Empty indexed response (also valid for punctuation-only input or `limit: 0`):

```json
{"jsonrpc":"2.0","id":93,"result":{"requestId":"notes-2","indexed":true,"matches":[],"nextToken":null}}
```

Legacy response fixture: no marker or workspace identity, so retain local palette discovery:

```json
{"jsonrpc":"2.0","id":94,"result":{"requestId":"notes-old","matches":[{"noteId":"spec","preview":"Release checklist"}],"truncated":false}}
```

**Result delivery — direct or streamed.** Except for `search.notes` (always inline above), small result sets are returned inline in the method
result (`matches`/`files` + `truncated`). Large or long-running searches are **streamed**: the
method returns `{ requestId }` promptly and the daemon pushes incremental `search:result`
batches followed by a terminal `search:done` (§6.5), correlated by `requestId`. Either way the
final, complete answer is the `search:done` event (or the inline result when not streamed).

**Size bounds (read payload budget).** An inline reply stays under the daemon's 500 KiB read
payload budget. `search.inFiles` stops collecting once its matches would serialize past
480,000 bytes, or at `maxResults`, and answers `truncated: true` either way; a longer matching line
is windowed to a `preview` of at most 400 characters plus a `…` at each cut end (`col` still
counts from the start of the line).
`search.notes` pages instead of cutting (see its Pages paragraph above).
`search.messages`, `search.events` and `search.codebase` cut an inline `matches` array at the
same 480,000 bytes and then add `truncated: true` (absent when nothing was cut). The default
and maximum `limit` / `maxResults` above cap streamed results too. The app's palette sends
`limit: 10`, so the new defaults do not change it. Daemons with these bounds advertise
`boundedReads: 1` ([client.hello](./client-hello.md)).

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

**Errors.** Missing `query`/`pattern`/`requestId` — and `workspaceId` where required
(`search.inFiles` / `search.fileNames` / `search.codebase`) — → `-32602`. `search.cancel`
with an unknown or already-finished `requestId` is a no-op success (`{ ok: true }`). A malformed
`opts.regex` pattern yields `-32602 "Invalid regex"`. Host-API searches (PR/issue/repo) are
**not** part of `search.*` — they live on the explicit-addressing `github.*` surface
(`github.pulls.search` / `github.issues.search` / `github.repos.search`, §5.27).

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
