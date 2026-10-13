# Cancellable note deletion (prepared protocol 13.10)

This additive contract requires exactly integer `noteDeleteGrace: 1` in
`client.hello` result `server.capabilities`. Capability absence, malformed discovery
or `-32601` leaves the note intact: clients must not fall back to immediate
`note.delete`, optional delay parameters on that method, full-body capture or
`note.create`. The existing immediate method and its revision guard are unchanged.
The independent `notePagingRead` and `noteAnnotations` capabilities are unchanged.
Numeric protocol version and documentation alone do not establish support.

Undo cancels a deletion that has not been claimed for commit. It is not undelete,
trash recovery or restoration of a historical snapshot. The original row, source,
metadata and relationships remain authoritative and addressable during the grace
period. No source is transferred or retained by these control calls. No migration
or durable deletion queue is introduced. Restart drops volatile records, but an
operation may have committed before a crash: an unknown result never proves survival.

## Wire types

All objects below have exactly their specified fields; `?` marks optional input.
Identifiers (`workspaceId`, `noteId`, `noteInstanceId`, `sourceRevision`) are nonempty
UTF-8 strings of at most 128 bytes with their existing opaque syntax. Epoch and
nonce are UUID strings. Ticks and sequences are integers from 0 through
9007199254740991. Ticks are monotonic milliseconds since this daemon epoch began;
sequences increase globally within that epoch, with overflow checked before new
mutations. `deleteAt` is a generated RFC3339 string of at most 30 UTF-8 bytes for
display only. Revision is a nonnegative safe integer.

```typescript
type OperationKey = { epoch: string; issuedTickMs: number; nonce: string };
type Identity = { noteInstanceId: string; revision: number; sourceRevision: string };
type State = 'PENDING' | 'COMMITTING' | 'CANCELLED' | 'DELETED' |
  'CONFLICT' | 'FAILED' | 'OUTCOME_UNKNOWN';
type Reason = null | 'cancelled' | 'noteChanged' | 'childChanged' | 'noteMissing' |
  'workspaceMissing' | 'authorityLost' | 'deadlineBudget' | 'storageFailure' |
  'shutdown' | 'commitOutcomeUnknown';
type Receipt = {
  operationKey: OperationKey; workspaceId: string; noteId: string; noteInstanceId: string;
  state: State; sequence: number; deadlineTickMs: number; deleteAt: string;
  expiresTickMs: number | null; reason: Reason;
};
type Unknown = {
  operationKey: OperationKey; state: 'UNKNOWN'; reason: 'previousEpoch' | 'unavailable';
};
type PublicPending = {
  operationKey: OperationKey; noteId: string; noteInstanceId: string;
  state: 'PENDING' | 'COMMITTING' | 'OUTCOME_UNKNOWN'; sequence: number;
  deadlineTickMs: number; deleteAt: string; canCancel: boolean;
};
type OperationResponse = {
  epoch: string; serverTickMs: number; sequence: number; operation: Receipt | Unknown;
};
type StatusResponse = {
  epoch: string; serverTickMs: number; sequence: number;
  current: Identity | null; pending: PublicPending[]; operation: Receipt | Unknown | null;
};
```

The response epoch is the current daemon epoch; a previous-epoch lookup can echo
an old operation key only in `Unknown`. A full receipt describes a retained entry.
`OUTCOME_UNKNOWN` is a full, physically settled but historically ambiguous receipt;
`UNKNOWN` is a minimal lookup result with no invented instance, deadline or sequence.
`canCancel` is true only for the currently authorized original stable identity while
state is `PENDING`. It is never an authority grant; every cancel is checked again.

### Methods

- `note.deleteStatus { workspaceId }` returns one workspace `StatusResponse` with
  at most 256 markers, `current: null`, `operation: null`. It includes retained
  `OUTCOME_UNKNOWN` markers as well as pending and committing operations.
- `note.deleteStatus { workspaceId, noteId }` returns small current identity or null,
  at most one marker for the **CURRENT incarnation** only, and `operation: null`.
  `current: null` implies `pending: []`.
- `note.deleteStatus { workspaceId, noteId, operationKey }` adds an authorized
  `Receipt` or `Unknown` for that exact historical key. That receipt may name an old
  incarnation even if the current row has been recreated. The `pending` array still
  filters to the current incarnation. Workspace snapshots can contain different
  incarnation-scoped entries sharing a textual note ID; never apply an old marker
  to a replacement.
- `note.deleteSchedule { workspaceId, noteId, noteInstanceId, expectedVersion,
  sourceRevision, operationKey, undoDelayMs? }` returns `OperationResponse` with a
  full receipt. A new accepted operation starts `PENDING`. Omitted delay is 15000 ms;
  otherwise it must be an integer in 1..60000 inclusive. Invalid values are rejected,
  never clamped or interpreted as immediate deletion. All identity/revision guards
  are mandatory; `sourceRevision` retains the existing opaque revision/generation
  representation. Obtain it through the small status call, not a complete note read.
- `note.deleteCancel { workspaceId, noteId, operationKey }` returns
  `OperationResponse` with a full receipt or minimal unknown lookup. It never creates
  an operation and never returns a boolean that can be mistaken for restoration.

Every serialized JSON **result object** is at most 524288 bytes (512 KiB), including
JSON escaping. Never truncate a pending snapshot or silently fetch full notes.
The JSON-RPC envelope and echoed request ID remain governed by the existing 40 MiB
transport frame limit; this contract adds no global request-ID limit or 512 KiB
full-frame restriction. Static worst-case result sizing of 256 markers is 477080
bytes under these field bounds. An illustrative full frame with a 128-byte request
ID is not a universal full-frame bound. Actual serialization must enforce both
applicable limits. No credentials, source, title or arbitrary error dumps appear.

## Admission, replay and deadlines

The full `(epoch, issuedTickMs, nonce)` tuple is the operation identity. Current
authority and the original stable caller identity are required for retained replay,
keyed receipt status and cancel; possession of a key is not authority. Workspace
snapshots and unkeyed current-identity status require current workspace authority,
not the original operation caller. Other authorized clients receive the shared
markers with `canCancel: false`. Resolve retained exact
replays **before** age validation, but require identical target, guards and effective
delay (omitted delay means 15000). Changed arguments are rejected. Replaying a key
never starts a second worker, extends its deadline or re-emits transition effects.

First admission accepts only the current epoch and a tick in `[now - 60000, now]`.
Clients use server-provided time. Settled receipts remain for 300000 ms, longer than
this admission window; once evicted, the old tuple is too old to create a new delete.
A fresh tick/nonce is a new explicit user intent. Never mint one automatically after
a timeout, unknown outcome or lost acknowledgement. Status by the original key
recovers lost schedule/cancel acknowledgements without requiring a returned handle.

`deadlineTickMs` and `deleteAt` are immutable. Client Undo time is conservatively:

```text
max(0, deadlineTickMs - serverTickMs - (responseReceiveMonotonic - requestStartMonotonic))
```

Subtract the full request round trip. Never use client wall time or start a fresh
15-second countdown on receipt arrival; hover must not extend Undo. Reaching the
client deadline is not proof that a delete committed. The daemon uses monotonic
time for admission, deadlines and expiry; wall-clock adjustments cannot extend them.

## State, cancellation and uncertainty

Claim and cancellation serialize on the same entry transition. `PENDING` can become
`CANCELLED` only if cancellation wins before claim; claim changes it to `COMMITTING`.
Cancellation after claim returns committing or the actual terminal result, never
false cancellation. An admitted operation survives the caller disconnecting.
Locks used for registry transitions/snapshots are short; status and cancel must not
wait behind the entire database transaction.

A physically unsettled delete remains `COMMITTING`, noncancellable, without expiry.
It retains capacity and exclusion against another operation for that incarnation.
The 30000 ms budget covers precommit semaphore/connection acquisition only, not an
in-flight transaction, COMMIT or callback. Never abort COMMIT to manufacture a
`FAILED` result. Owned workers settle exactly once:

| Outcome | State | Meaning |
| --- | --- | --- |
| Cancel wins before claim | CANCELLED | This operation will not delete; current original data is untouched. |
| Guard fails before deletion | CONFLICT | No deletion by this operation; current data is not reverted. |
| Proven rollback/precommit failure | FAILED | This operation did not commit deletion. |
| Known successful commit | DELETED | Deletion committed, even if a later callback or notification fails. |
| Worker settles but commit acknowledgement remains ambiguous | OUTCOME_UNKNOWN | No automatic retry, cancellation or survival claim. |

Publish a known terminal result before fallible notification work, but keep the slot
and active exclusion while owned callbacks remain unsettled. Thus `DELETED` may be
visible with `expiresTickMs: null`. Expiry starts only after **all** owned work settles,
then is fixed at settlement tick + 300000. This applies to every terminal state,
including `OUTCOME_UNKNOWN`; no worker can remain when that countdown begins.
Retained `OUTCOME_UNKNOWN` is exposed in workspace snapshots, is noncancellable,
and blocks scheduling the same incarnation until expiry. After expiry a later
explicit user intent requires fresh authoritative identity and a new key.

Shutdown fences new admissions, cancels unclaimed work and drains claimed
transactions/callbacks before store shutdown. No detached timers or workers escape
ownership. Crash rolls back uncommitted database transactions but can lose a receipt
after commit. Previous-epoch or unavailable `UNKNOWN` is not proof of cancellation,
deletion, restoration or present existence; reconcile current identity separately.

## Authorization, guards and resource bounds

Capture the original `Caller` and `WireCredential`; never elevate timers to generic
Daemon authority. Admission, status and cancel revalidate current workspace policy.
Commit revalidates current durable principal/credential/workspace authority inside
the same writer transaction, including an originally admitted Owner. An original
agent session must still exist. Legacy authority leases span commit only, not the
grace period. Revocation or loss of authority prevents deletion. Do not expose or
retain credentials inside wire receipts.

Admission reads a short coherent snapshot of the live workspace and parent
instance, numeric revision and page generation, without reading note content. The
current identity head must be available. Capture a count and SHA256 digest of sorted,
length-prefixed direct-child scalar identity/revision/generation tuples. Query at
most 257 rows to detect overflow and reject more than 256 children or missing/oversized
identity fields. Retain no child arrays or body snapshots per registry entry.

At expiry use the same `BEGIN IMMEDIATE` connection to revalidate authority, exact
parent guards and the exact direct-child set before deleting. Parent edits, child
add/remove/reparent/edit/incarnation changes, or same-ID recreation produce conflict
without rebasing. Parent deletion, legacy child-detachment triggers, pending index
rebuild and annotation finalization commit atomically with existing rollback guards.
Do not alter migration identities/bytes.

Cancellation preserves **current** original source, metadata, comments, history and
relationships, including concurrent edits; it does not roll back to scheduled state.
Successful deletion uses existing cascades and direct-child detachment. Comment-only
writes need not change note generation and may cascade when deletion commits. This
is not a claim that every relational write invalidates a schedule. Preserve existing
task readiness, dependent and display notifications after actual commit. Their
existing workspace-note scans/spec parsing remain; four workers bound concurrency,
not total graph bytes, transaction or callback runtime. No callback optimization is
part of this contract, and notification failure cannot relabel a commit as failure.

Reserve capacity before admission work: at most 256 entries per workspace and 1024
per daemon, counting reservations, pending/committing entries and terminal receipts.
Exactly one active operation per incarnation is reserved atomically. Never evict
active work or unexpired receipts to make room. At most four commit/callback workers
run concurrently; at most 1024 owned timer/entry records exist. Bounded sweeps remove
only settled expired records; there is no timer per terminal receipt. Quota rejection
must leave the request unadmitted, never perform immediate deletion.

## Events and recovery

`note:delete-operation` is a workspace-scoped invalidation with exact data:

```typescript
{ workspaceId: string; noteId: string; noteInstanceId: string; epoch: string;
  sequence: number; operationKey: OperationKey; state: State; deadlineTickMs: number }
```

It carries no caller, credential or source, and does not grant cancel authority.
Only actual committed deletion emits the existing `note:deleted` and task effects.
Subscribe before fetching a bounded workspace status snapshot. Buffer bounded latest
transitions by key/incarnation, discard same-epoch events at or below the snapshot
sequence, and reject stale transitions. Global sequence numbers are **not contiguous
per workspace**; numerical gaps alone do not establish event loss. Reconnect, epoch
mismatch or detected stream loss triggers one coalesced workspace resnapshot.

Absence from a newer snapshot retires only the old marker. It does not prove the
note survives or was deleted. A separate reconciliation-needed display gate protects
previously hidden notes until an exact cancellation or authoritative current identity
and slim state resolve existence. Never unhide a cached row solely because a marker
vanished, never describe a replacement incarnation as Undo, and retain local drafts
if the original is absent. Reconcile only the bounded previously affected set
(at most 256), through existing authoritative slim subscriptions or targeted small
status calls, at most four concurrent. Do not fan out over all sidebar rows or poll
forever; use bounded retries and explicit status recovery. Overflow must preserve
uncertainty and resnapshot, not silently drop a safety gate.

Both browser and Electron entrypoints use this same contract. Before scheduling,
settle current-generation local rich/raw edits through existing strict saves; failed
saves preserve draft/tab and send no schedule. Freeze input or preserve racing edits,
keep deletion holds through editor completion/destruction, and never issue a late
flush against a pending deletion. Only a validated pending receipt hides/closes the
initiating view and enables Undo; a lost acknowledgement preserves the current
view until status confirms the result. Remote pending events must not discard dirty
drafts. Cancellation reuses the same original ID; no create/update restoration.

## Errors and verification

Numeric codes retain the JSON-RPC error envelope. `error.data.code` is one of:

| data.code | Numeric | Meaning |
| --- | --- | --- |
| NOTE_DELETE_INVALID | -32602 | Malformed fields, unsafe numbers, bounds or delay. |
| NOTE_DELETE_UNAVAILABLE | -32602 | Missing/foreign workspace or absent schedule target; no identity leak. |
| NOTE_DELETE_STALE | -32005 | Supplied guards stale; may include small current Identity, never a full Note. |
| NOTE_DELETE_KEY_EXPIRED | -32005 | First admission has old epoch or tick outside the window. |
| NOTE_DELETE_KEY_MISMATCH | -32005 | Retained key has different target/guards/effective delay. |
| NOTE_DELETE_ALREADY_PENDING | -32005 | Another active key holds the incarnation. |
| NOTE_DELETE_QUOTA | -32603 | Entry capacity exhausted. |
| NOTE_DELETE_GRAPH_LIMIT | -32603 | Direct-child guards exceed the supported bound. |
| NOTE_DELETE_SHUTTING_DOWN | -32603 | Admission fenced during shutdown. |
| NOTE_DELETE_FORBIDDEN | -32003 | Current caller cannot access the operation in an otherwise authorized workspace. |

A rejected schedule admits **no NEW operation**. It does not prove a pre-existing
operation is absent or cancelled, especially for key mismatch or already-pending
errors. Retain the original key and reconcile. An unknown lookup is a normal typed
result, not a successful cancel or permission to mint a replacement key.

The [controlled fixtures](./fixtures/notes/delete-grace.test.mjs) check wire bounds,
identity separation, replay/retention, cancel/claim outcomes and uncertainty rules.
They are specification evidence, not a production scheduler, parser, authorization,
transaction or UI acceptance test. Component validation must separately exercise
actual UDS/WSS credential/origin paths, fault-injected transaction/commit outcomes,
resource/worker limits and browser/Electron Delete→Undo against original note data.
Additive docs land first when merging is authorized; this document grants no merge
permission and does not identify a shipped version.
