> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5 Method Catalog.

### 5.46 Presence — `presence.*` / `note.presence.*`

Ephemeral who-is-here state for shared (multi-principal) workspaces ([intent-hq/intentd#1887](https://github.com/intent-hq/intentd/pull/1887)). Everything lives in **one in-memory table keyed by `(principal, connection)`**: nothing is persisted, both events are published **transient** (broadcast only — `event.query`, §5.10, never returns a presence row), and a daemon restart forgets it all. Two surfaces:

- **Workspace presence** — which members of a workspace are online, what they are looking at (`focus`) and which agent they are typing to (`typing`). Fed by the connection lifecycle (`client.hello` → online, close / heartbeat reap → offline) and by `presence.update`; read live on `presence:changed` (§6.5) or on demand with `presence.snapshot`.
- **Note presence** — who is viewing one note, with an optional caret. `note.presence.subscribe` is a §6.9 snapshot+delta channel whose subscription **is the "I am viewing" signal**: it holds a viewer **lease** for the connection, and `note.presence.update` moves the caller's caret.

| Method | Params | Result |
| --- | --- | --- |
| presence.update *(fast path)* | focus (req, array of `{ workspaceId (req), agentId?, noteId? }`), typing?: `{ agentId (req) }` \| `null` | `{ ok: true, typingSource }` — replaces the **connection's own** focus set and typing target; `typingSource` is the connection's opaque typing handle (`ts-…`), the `source` its own entry carries in every roster |
| presence.snapshot | workspaceId (req) | `{ workspaceId, members: PresenceMember[] }` — the current `presence:changed` roster of a member workspace, on demand |
| note.presence.update *(fast path)* | workspaceId (req), noteId (req), rev (req), anchor (req), head (req) — each of the three a non-negative integer | `{ ok: true }` — the caller's own caret on a note this connection is subscribed to |

The note-presence channel pair is a §6.9 subscription channel (intercepted on the subscription fast-path like `note.subscribe` / `chat.subscribe`, so it is outside the dispatchable-name count of §5):

- `note.presence.subscribe` — params `workspaceId` (req), `noteId` (req), `replaceGroup?` → `{ subscriptionId }`, then a seq-0 `{ viewers: NoteViewer[] }` snapshot (the subscriber included) and `{ kind, viewer }` deltas.
- `note.presence.unsubscribe` — params `subscriptionId` (req) → `{ success }`; releases the lease, and the viewer's `left` is published when it was the principal's last lease on the note.

#### Shapes

```jsonc
// PresenceMember — one online member of the workspace (presence:changed / presence.snapshot)
{ "principalId": "p-…", "login": "octocat", "displayName": "Octo Cat", "avatarUrl": "https://…",
  "focus":  [ { "workspaceId": "ws-1", "agentId": "agent-…" }, { "workspaceId": "ws-1", "noteId": "spec" } ],
  "typing": [ { "source": "ts-…", "agentId": "agent-…", "since": "2026-09-14T12:00:00Z", "pulse": 7 } ] }

// NoteViewer — one viewer of a note (note.presence.subscribe snapshot rows and delta `viewer`)
{ "principalId": "p-…", "login": "octocat", "displayName": "Octo Cat", "avatarUrl": "https://…",
  "cursor": { "rev": 12, "anchor": 40, "head": 52 } }
```

- `principalId` is stamped by the daemon from the connection's bound principal — never a wire parameter. `login` / `displayName` / `avatarUrl` are the principal's stored profile fields; each key is **always present** and `null` when the profile has no value. The profile is read from the store once per principal and cached while the principal is present.
- `focus` is the member's focus items **in this workspace only**, deduplicated across all of the principal's connections; `agentId` / `noteId` are present only when the client set them (never `null`).
- `typing` holds **one entry per typing connection** — two clients of one person stay two entries, keyed by `source` (that connection's `typingSource`); entries are sorted by `source`. `since` is the episode start (RFC-3339), kept while the same connection keeps naming the same agent; `pulse` is a per-connection counter that advances on **every** `presence.update` naming a typing agent. Freshness is `(source, pulse)`: a receiver restarts its expiry timer when it sees a pair it has not seen before, and never compares wall clocks — a roster re-emitted for an unrelated reason (a hello, another connection's focus change) re-projects the entry unchanged, pulse included.
- `cursor` is **always present** on a viewer row: `null` until the principal's first `note.presence.update` on the note, then `{ rev, anchor, head }` (the note `rev` the offsets are relative to, §4; `anchor` / `head` are the selection ends). The `left` delta carries `cursor: null`.

#### `presence.update` — focus & typing

- Sets the whole state for **this connection** (last write wins; an omitted `typing` or `typing: null` clears the typing target). `focus` may be empty. Items are deduplicated; the same principal on several connections is aggregated in the roster.
- Requires a **completed `client.hello` on this connection** — before it, `-32602 "presence.update requires a completed client.hello on this connection"`.
- **Member+ on every target**: every `focus[].workspaceId` and the workspace of `typing.agentId` (resolved daemon-side from the agent; an unknown agent is not-found) must be a member workspace of the caller — a non-member target is `-32602 { code: "not-found" }` and nothing is applied. The administrator passes the gate for every workspace.
- `-32602 "presence.update: …"` on a malformed body: `focus` not an array, an item not an object, a missing / empty `focus[].workspaceId`, a `focus[].agentId` / `focus[].noteId` that is neither omitted / `null` (read as absent) nor a non-empty string (`"… must be a non-empty string"`), `typing` neither an object nor `null`, or a missing `typing.agentId`.
- Publishes `presence:changed` to every workspace the connection **left or entered** (the union of its previous and new workspace sets), so a client focusing a new workspace sees its roster at once.

#### Online / offline

- A connection is **online for its principal** once its `client.hello` completes. A principal's **first** live connection publishes `presence:changed` to **every workspace it is a member of**; further connections of an already-online principal publish nothing — that client reads `presence.snapshot` for its initial roster (likewise a client that attached its `events.subscribe` after its hello).
- A connection's close — clean close, heartbeat reap (§4) and daemon shutdown alike — drops its presence row and **every note lease it held**: `left` deltas first, then `presence:changed` to every member workspace when it was the principal's **last** connection, or only to the workspaces its own focus / typing touched otherwise.
- `presence.snapshot` is Member+ (`-32602 { code: "not-found" }` for a non-member or an unknown workspace); `members` lists only the workspace's currently **online** members, each with the `PresenceMember` row above.

#### Note presence channel

- `note.presence.subscribe` runs the **join first**: it is Member+ on `workspaceId` (a non-member gets the `-32602 { code: "not-found" }` error reply and **no subscription**), registers the lease, and only then acks `{ subscriptionId }` and pushes the seq-0 snapshot. The bus subscription is opened **before** the join, so the caller's own `joined` (and any racing viewer) arrives as a delta after the snapshot — idempotent over-delivery, as with the other §6.9 channels.
- A principal is a viewer while **any** of its leases on the note is live (several tabs / connections = one viewer). `joined` is published only when the principal was not yet viewing; `left` only when its last lease goes. Snapshot rows are sorted by `principalId`.
- The lease is released — and `left` published if applicable — on `note.presence.unsubscribe`, on a `replaceGroup` replacement, on connection close (including heartbeat reap), and when the subscriber's own membership of the workspace ends (the channel's membership gate ends the forwarder).
- Deltas are **payload-only** `{ kind: "joined" | "updated" | "left", viewer: NoteViewer }` — not the `added` / `updated` / `removedIds` shape of the collection channels (§6.9); there is nothing to re-read because presence is never persisted. Events for other notes of the workspace are filtered out by `noteId`.
- `note:presence` is **channel-only**: it never travels on the `events.subscribe` firehose (owner and collaborator alike — a `note:*`, exact-type or unfiltered raw subscriber of the same workspace receives none of it); it reaches only the note's lease holders.

#### `note.presence.update` — caret

- Requires a live lease **on this connection** for `(workspaceId, noteId)`: otherwise `-32602 "note.presence.update: not subscribed to this note (note.presence.subscribe first)"`. A missing / empty `workspaceId` or `noteId` is `-32602 "note.presence.update: <name> is required"`; a missing or negative `rev` / `anchor` / `head` is `-32602 "note.presence.update: <name> must be a non-negative integer"`.
- **Member+ on every call** (`-32602 { code: "not-found" }`): a lease outlives a membership removal, so the gate re-runs per update rather than once at subscribe time.
- The daemon stamps the principal and **coalesces** the resulting `note:presence { kind: "updated" }` deltas per `(principal, note)`: at most **one per 100 ms** (≤10/s), last writer wins, with a **trailing flush** so the final position always lands. A deferred caret is **re-gated** when its flush fires — a membership removal that lands inside the window drops the pending caret instead of letting it out — and is generation-fenced, so a caret deferred by a viewer that has since left is never published. The reply is `{ ok: true }` whether the caret was published, deferred or absorbed.

#### Caller & gating

- The **writes and the join** are client-connection concerns: `presence.update`, `note.presence.subscribe` and `note.presence.update` resolve the principal from the connection's bound wire caller; an agent / daemon caller or an unbound request is refused with `-32003 Forbidden` (`data { code: "forbidden", detail }`, e.g. `"presence.update is only available to client connections"` / `"…: no caller is bound"`). **`presence.snapshot`** carries no such restriction — it is an ordinary Member+ read (`require_member`), so a bound agent or daemon caller passing the membership gate reads the roster like any other workspace read, and an unbound request fails that gate. **`note.presence.unsubscribe`** is connection-local subscription cleanup (the generic registry remove, `{ success: boolean }` — `false` for an unknown or foreign `subscriptionId`) and resolves no principal.
- All five names are callable by collaborator (non-administrator) connections; `presence:changed` and `note:presence` are workspace-scoped events deliverable to collaborators, so the membership gate narrows them like any other row. No profile field is exposed here that a member cannot already read from the workspace's member list.
