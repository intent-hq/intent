# Phase 1 private node link (prepared contract)

This is a future implementation contract, not the client WSS protocol and not a
claim about the pinned daemon. See [§5.50](./methods/nodes.md) for public methods,
placement, fields and authority. Both static nodes and the in-process local node
implement this semantic boundary; only static nodes serialize it over TLS.

## Ownership and bootstrap

Head owns SQLite, transcripts, notes/tasks, placement, lease reconciliation,
prompt assembly, hub refs, public events and publication. Node owns the provider
CLI/ACP connection, fs/terminal handlers, QuickJS workspace API evaluation, stdio
MCP, checkout, child process trees, memory budget and idle reaping. Head stores no
remote `Child`, ACP `Connection`, local PID or remote PID memory sample. Node
reports resource totals; head's local ProcessRegistry counts only local processes.

An operator starts the same installed binary as `intentd node`, with its own
private data root, TLS certificate and one-time enrollment token. Head dials
`/node`; nodes never dial head. Registration pins the supplied certificate before
sending the token (no trust-on-first-use downgrade). The token is at least 256
random bits, accepted once, never logged or returned by inventory. Node persists
its random identity and one durable head-installation owner. Head allocates
`leaseId`, `incarnation` and a fresh 256-bit lease token; enrollment stores that
binding on both sides before acknowledging success. Persist the register request
ID/receipt so a lost response can reconcile the same registration without consuming
the token twice. Ambiguous partial enrollment stays acquiring until the same
head proves ownership; another head must obtain explicit operator reset.

Lease tokens live in the existing head secret store and node private state,
excluded from snapshots, logs, events and manifests. Reconnect presents the lease
token over pinned TLS. A token is valid only for its node identity, incarnation
and head identity. Revocation fences further calls/ref writes even on an already
open socket. Node accepts one current link: head persists a monotonically
increasing `linkGeneration` before connecting, node durably accepts a greater
generation and closes the old socket. Equal/older generations cannot take over.
Restoring/cloning a node data directory requires a fresh identity/enrollment and
termination of inherited processes; never reuse a snapshot's lease identity.

After authentication both endpoints exchange:

```json
{
  "kind": "hello",
  "nodeProtocol": 2,
  "intentdVersion": "<exact installed version>",
  "buildRevision": "<exact build revision>",
  "headId": "head-1",
  "nodeId": "node-1",
  "nodeIdentity": "<node identity>",
  "leaseId": "lease-1",
  "incarnation": "<uuid>",
  "linkGeneration": "7",
  "checkpointFormat": 1,
  "journalFormat": 1
}
```

All values must match the persisted lease and exact installed release/build on
both ends, including protocol/format versions, before replay or spawn. A mismatch
marks node incompatible and fails closed; phase 1 never downloads/upgrades a binary
or halts agents for an automatic upgrade. Operators install matching versions.
The local node receives a bound identity/capability from the composition root over
an in-memory link; it uses no TLS listener, token or extra daemon. It keeps the
same ordering, scope, persistence and cancellation semantics.

## Multiplexing and RPC

WSS messages contain one frame: a four-byte big-endian JSON-header length, a UTF-8
JSON header and optional binary payload. Maximum header is 16 KiB, binary payload
64 KiB; larger logical transfers fragment into bounded frames. Required header
fields are `channel`, `streamId` (UUID), `kind`, `leaseId`, `incarnation`,
`linkGeneration`; the authenticated socket, never those untrusted fields alone,
establishes scope. Unknown channel/kind or invalid length closes the link.
Metadata-only frames have no payload. Whole logical RPC bodies cap at 8 MiB;
larger results become blob handles, not a single unbounded JSON frame.

| Channel | Initiator / direction | Contract |
| --- | --- | --- |
| control | Both | Hello/reconcile, heartbeat, window credit, prompt, cancel, stop and admission; highest priority |
| journal | Node to head; ack back | Persisted ordered agent frames/events; high priority |
| rpc | **Both**, correlated | Node coordination calls to head; head live reads, commands and target-node hook evaluation; high priority |
| git | Both | Smart Git protocol pack negotiation/bytes, scoped by repo and ref grants; low priority |
| blob | Both | Attachment, session and oversized-result bytes, verified by SHA-256; low priority |

Each endpoint has a single writer with control serviced first, then round-robin
journal/RPC, then round-robin bulk streams. Bulk frames are at most 64 KiB; cap
total queued bulk bytes at 4 MiB and per-stream unconsumed credit at 1 MiB. Control
has a separate bounded 256 KiB queue, journal/RPC 4 MiB. Never hold the writer
lock while reading a pack/blob, and never require bulk credit to send stop or
heartbeat. Socket backpressure can still delay all bytes; priority does not
promise delivery on a dead link. No `forward` tunnel or cloud channel is added in
phase 1; existing head-host browser forwarding is unchanged.

RPC request metadata: `kind: "request"`, `requestId` (UUID), `agentId`,
`workspaceId`, `method`, `timeoutMs` (1..120000), `idempotencyKey?`; payload is JSON
params. Response has `kind: "response"`, the same request ID, and a payload
containing exactly `result` or `error` (JSON-RPC error shape). `kind: "cancel"`
names that ID; cancellation is scoped to its originating endpoint, agent, lease
and generation. Requests from opposite directions have distinct ID spaces.
Timeout/cancel stops work where possible but is not rollback. Lost response to a
mutation without a durable idempotency key returns `rpc-outcome-unknown`; neither
node nor head automatically resends it as a new operation. Read retries get new
IDs; keyed mutations retain theirs. RPC results do not use journal ack as proof
that a mutation committed. Reconnect drops stale responses/stream handles.

Head validates lease ownership and current agent/workspace/repo assignment on
**every** request, including after await/admission boundaries. A node carries an
execution envelope around the existing agent caller authority; it cannot set
`Caller::Daemon`, choose a principal, claim UDS origin or become administrator.
Only bound agents may forward control-plane operations, restricted to the
intersection of their existing authority and lease grants. A wire user's live
read uses a head-issued operation capability restricted to that request; it does
not expose their credential to the node. Hooks retain their scheduling ownership
on head, but forwarded effects run under the owning agent's restricted capability,
not today's unrestricted daemon caller. Missing/stale scope is forbidden.

## Private preparation lifecycle

This section prepares **nodeProtocol 2**, replacing private version 1 for lifecycle
dispatch. It does not change the public client protocol, checkpointFormat 1 or
journalFormat 1, and does not advertise an implemented listener. Version 1 must
not accept these operations or downgrade to raw startup. The local in-process
node implements the same semantics without a token/listener.

### Authority and carriers

Head dispatches two private RPCs: `node.execution.prepare` and
`node.execution.status`. Prepare owns hydration and contained provider/ACP
startup, but delivers no prompt; there is no separate start mutation.
Node-originated RPC, agent workspace scripts, public WSS and generic namespace
forwarding cannot invoke this lifecycle. Trusted composition explicitly grants
each operation to the exact persisted owner/agent/workspace/run/assignment epoch.
A serialized assignment, `active` flag, config hash or ready receipt grants no
authority. Resolve repo grants and safe roots from that assignment and trusted
node storage, not request paths.

| Channel/kind | RequestScope.method | Meaning |
| --- | --- | --- |
| rpc/request | node.execution.prepare | Reserve or join owned preparation |
| rpc/request | node.execution.status | Read its current scoped receipt |
| control/prompt | agent.prompt | First message or resume continuation for that preparation |
| control/stop | agent.stop | Durably close that exact preparation/run |
| rpc/response | Correlated requestId | Result/error for the above operations |
| control/cancel | Original requestId, agentId and workspaceId | Cancel a still-attached request; no payload |

Prompt/Stop carry the existing full RequestScope metadata, not new fields in that
deny-unknown scope: `requestId`, `agentId`, `workspaceId`, `method`,
`timeoutMs`, `idempotencyKey`, and optional `operationCapability` under existing
rules. `streamId = requestId`; `offset`/`more` describe framing. Run, epoch and
preparation selectors belong in the **body**. Binding headers are still checked
against the authenticated connection.

Version 2 allows a Stop JSON body of at most 1 KiB in one frame
(`offset: 0, more: false`); version 1's metadata-only Stop cannot represent it.
Prompt uses bounded fragmentation up to the existing 8 MiB RPC limit. Never put
the whole prompt into the 256 KiB control queue: bounded credit and scheduling
must service stop/heartbeat before further prompt fragments. Admission frames
mapped to `agent.spawn` cannot bypass preparation and are rejected by this
lifecycle dispatcher. The private control names above are not new public methods.

### Prepare and inline configuration

Prepare's required body is illustrated below. IDs are UUIDs; hashes are lowercase
SHA-256. `assignmentEpoch` is a decimal u64 string, compared numerically. Unknown
or missing fields are invalid. RequestScope.idempotencyKey must equal
preparationId; requestId is only transport correlation.

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000001",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "checkpoint": {
    "checkpointId": "00000000-0000-4000-8000-000000000003",
    "manifestSha256": "<64 lowercase hex digits>"
  },
  "configuration": {
    "configId": "00000000-0000-4000-8000-000000000004",
    "sha256": "<SHA-256 of canonical snapshot JSON>",
    "snapshot": {
      "schemaVersion": 1,
      "providerId": "fixture-static-provider",
      "permissionPolicy": "denyAll",
      "toolProfile": "contained-v1",
      "terminal": false,
      "externalAcpMcp": []
    }
  }
}
```

The configuration snapshot travels **inline over the authenticated link**; there
is no assumed pre-staged remote config registry or general upload/fetch API.
The example provider is a test registry entry, not a production provider.
Required snapshot fields are shown. Only `model` and `reasoningEffort` are
optional additional fields, each a nonempty string of at most 256 UTF-8 bytes.
providerId is an installed registry identifier of at most 128 ASCII identifier
bytes (letters, digits, underscore or hyphen).

permissionPolicy is `interactive | autoByRisk | allowAll | denyAll`, mapping to
the existing policy only when the head's persisted assignment settings authorize
that exact choice. Interactive requires a qualified head permission-prompt route.
The head must not elevate a node/agent-supplied setting into trusted configuration.

The only toolProfile is `contained-v1`: the installed same-build contained
provider and scoped workspace API policy. terminal must be false and
externalAcpMcp must be empty. Unsupported settings fail explicitly, never silently
reduce the requested tool set. This schema does not qualify terminal, external
ACP-MCP, arbitrary plugins or portable session loading. Future support needs
typed reviewed additions.

The snapshot is at most 32 KiB of RFC 8785 canonical JSON. Reject duplicate keys
before hashing and unknown fields; use no Unicode normalization. Hash the
canonical snapshot bytes, excluding configId. IDs and hashes both participate
in the pinned intent. Reusing configId for different bytes is invalid.
No arbitrary option/environment map, executable, command, cwd, HOME, filesystem
path, URL, credential selector, package spec, token or serialized SpawnOptions
is accepted. Secret bytes are never part of this snapshot/hash/log.

Trust comes from current authenticated head dispatch and its persisted config
selection, not the digest. Node reconstructs internal typed settings using its
installed provider registry and trusted executable/helper/storage layout, then
obtains credentials via the existing scoped acquisition/validation flow.
Instructions belong to the assembled message, not a rules-file path. Persist
only the bounded secret-free snapshot and identity with preparation; status
returns configId/hash, not the snapshot. Changed settings require a new run/epoch
after the applicable fence, not mutation of an owned preparation.

Validate link/assignment, closed schema/hash, existing operation identity/conflict,
then trusted configuration choice before reserving new effects. Prepared checkpoint
metadata can be serialized/deserialized; it is **data**, not an admission
capability. Resolve and validate it through owned staging/source. Authorize parent
or prior-run source lineage separately from same-owner target staging; never
require an inherited parent to impersonate the child's execution identity.
Verify all granted repository/object closure, inherited worktree/index/submodules
and checkpoint-bound attachments before ready. No source path supplied by a
caller is opened.

### Owned states, identity and receipt

Before filesystem/native work or asynchronous fetch, durably reserve one bounded
record for owner/agent/workspace/run/epoch, preparationId and exact checkpoint,
configuration and optional resume intent. Capacity/storage exhaustion rejects
new work; never evict an owned record to make room.

- Same preparationId with changed intent is `request-id-reused`.
- Identical intent for the same live assignment joins/returns its owned operation.
  A different proposed preparationId returns the existing canonical ID; do not
  allocate an unbounded alias table.
- Different checkpoint/config/resume intent for an occupied assignment is
  `preparation-conflict`. Stale, stopped or replaced assignments cannot reopen it.
- Link generation is revalidated rather than included in the stable intent:
  an authenticated reconnect can reconcile the same run, but old generations fail.
- Retain terminal identity/tombstones until durable retirement fencing makes every
  old run/epoch request rejectable. Compaction cannot permit a duplicate spawn.

Prepare returns a current snapshot promptly after reservation, usually preparing;
the owned supervisor continues independently of its RPC waiter. Status is
read-only and never reserves/retries work. Status params are
`{ preparationId, runId, assignmentEpoch }`, without an idempotencyKey.
Both return this shape:

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000001",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "checkpoint": {
    "checkpointId": "00000000-0000-4000-8000-000000000003",
    "manifestSha256": "<64 lowercase hex digits>"
  },
  "configuration": {
    "configId": "00000000-0000-4000-8000-000000000004",
    "sha256": "<64 lowercase hex digits>"
  },
  "revision": "2",
  "state": "ready",
  "ownership": "retained"
}
```

revision is a durable per-preparation monotonically increasing decimal u64;
older receipt snapshots cannot overwrite newer ones. States are preparing, ready,
failed_retained, closing and closed. ownership is retained except when closed,
when it is released. Optional failure is `{ code, retryable: false }`, with no
path/secret/stderr. Closed may retain failure metadata and does not imply a
successful task or preparation. Optional firstDelivery and stop are defined below.

Ready requires validated complete hydration/attachments, installed required
credentials, actual contained provider startup and ACP/session/tool setup.
It is a fact about that exact owned run and baseline, **not a token or durable
admission capability**. Capture/ACK ownership remains separate: readiness or
provider idleness cannot release a capture permit, prove quiescence or advance
the durable head checkpoint pointer.

Preparing becomes ready only on that success. Cancellation/revocation/failure
starts closing; uncertain/failed cleanup is failed_retained; confirmed cleanup
and capture settlement alone permit closed. Cleanup may retry through closing,
but failed preparation never becomes ready by retrying prepare. Retain charged
native/private/capture owners until actual settlement; neither dropping a future
nor unit-return shutdown releases them.

Persist reservation before effects and ready after real startup before exposing
its receipt. Crash after spawn but before receipt is owned uncertainty, not
permission to spawn again. On restart, formerly preparing/ready records become
closing before serving status, with orphan reap/reconciliation. No serialized
receipt restores admission.

### Execution lifetime and cancellation

An incoming RequestContext is request-scoped. In the existing transport,
RunningOwner retirement cancels that context even after a normal final response.
Do not clone it into permanent preparation authority, ignore its cancellation,
or replace its token ad hoc.

While the handler is admitted, trusted composition reserves the intent and
constructs a separate **non-serializable owned execution lifetime**: exact
assignment/binding, live ExecutionAdmission, stop/closure token, scoped operation
factories and native/private/capture owners. Each later credential/RPC/effect
uses a fresh scoped context from that trusted factory and revalidates current
run/lease/generation. It cannot manufacture daemon/principal authority.

A typed transport-to-owner notification must distinguish peer cancel/deadline/
abandoned dispatch from successful response retirement. The undifferentiated
RunningOwner cancellation bit is insufficient. Serialize attached→retired versus
attached→cancelled: attached cancellation closes the shared owned attempt;
normal response retirement detaches the waiter without cancelling preparation.
After a preparing response, cancelling the completed requestId has **no lifecycle
effect**; send the exact stop below for guaranteed closure. Status cancellation
never affects preparation. Loss/uncertainty retains cleanup ownership, not a free
slot or an automatic new run. An implementation lacking safe lifetime/reconnect
composition must remain unqualified rather than weaken the authority checks.

### First delivery and resume history

First-message params are:

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000001",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "turnId": "00000000-0000-4000-8000-000000000006",
  "message": {
    "blocks": [
      {"type": "text", "text": "Review the hydrated changes."},
      {"type": "attachment", "attachmentId": "attachment-fixture"}
    ]
  }
}
```

Only text `{ type, text }` and attachment `{ type, attachmentId }` blocks are
accepted: at most 256 blocks and 8 MiB total request body, no empty total message.
Resolve attachment IDs through the authorized registry/materialization flow for
that assignment/turn and map to supported ACP content. Unsupported types or
missing attachments fail before delivery; no arbitrary resource URL/path is
accepted. RequestScope.idempotencyKey equals turnId.

Before provider dispatch, persist one bounded firstDelivery record:
`{ turnId, payloadSha256, state }` for the exact preparation/run/epoch. Hash
canonical complete prompt params. States are queued, dispatching, delivered,
failed and outcome_unknown; a failed record may include a sanitized failure code.
Receipt/status returns it. A different turnId cannot replace an unresolved first
delivery. Later ordinary turns require their separately qualified turn path.

Queued delivery waits for actual preparation within its original timeoutMs
deadline; retries/status/queued receipts never extend that deadline. Then verify
attachments and acquire current live execution/credential admission at the
delivery boundary, rechecking closure and stop tombstones. Persist dispatching
before submission, and delivered only on definitive provider acceptance.
Delivered means accepted, not completed. An uncertain acceptance becomes
outcome_unknown and is reconciled through status/journal; never automatically
redispatch. Same turnId/hash returns the existing record; changed bytes under
that ID fail. Expiry before dispatch fails the queued delivery and closes the
owned preparation. Restart reconciles an uncertain deadline conservatively.

Prompt result is `{ preparationId, runId, assignmentEpoch, turnId,
deliveryState }`; it may be queued. Only delivered settles the first-message
gate successfully. Cancelling a completed prompt request cannot recall delivery:
use exact stop to prevent future dispatch. A timeout after dispatch has begun
reports uncertainty and triggers owned halt/reconciliation, not replay.

An explicitly admitted resume adds this prepare member:

```json
{
  "resume": {
    "resumeAttemptId": "00000000-0000-4000-8000-000000000007",
    "previousRunId": "00000000-0000-4000-8000-000000000008",
    "mode": "history",
    "history": {
      "sourceLeaseId": "lease-source",
      "sourceIncarnation": "00000000-0000-4000-8000-000000000011",
      "throughJournalSeq": "42",
      "sha256": "<SHA-256 of raw UTF-8 history text>",
      "bytes": 256
    }
  }
}
```

Head persists this attempt against the interrupted run before prepare; node
persists it as part of preparation identity before spawn. History text is assembled
**on head from its authorized acknowledged transcript**, bounded and frozen before
preparation. Source lease/incarnation/cut must match the authorized interrupted
lineage and not precede the applicable checkpoint journal cut. A different source
lease requires a persisted source-reader lineage relation, not guessed equality
with the new node. Sequence/hash alone grants no access.

The corresponding Prompt body additionally contains the same resumeAttemptId and
`history: { text }`. Fresh starts forbid both. Raw UTF-8 history is at most 1 MiB;
its exact byte length and SHA-256 must match prepare.resume.history. It travels
inline over authenticated Prompt, with no new transcript-fetch RPC or hidden
registry. firstDelivery's hash binds history and continuation together.
History is context, never replayed executable tool effects. Unavailable/ungranted
history, unsupported adapter or portable-session import fails explicitly; no
silent empty continuation. Fresh inherited children start new provider sessions.

Duplicate resume intent joins the existing preparation. A changed attempt conflicts.
A surviving process on reconnect continues with its existing preparation and
receives no second first message. New-run recovery requires a new epoch and the
canonical stop/loss fence, not a request-supplied fenced boolean.

### Exact stop and cleanup-only observation

Stop's body is:

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000001",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "stopId": "00000000-0000-4000-8000-000000000009",
  "reason": "user"
}
```

reason is user, deleted, preparation_cancelled or lease_released.
RequestScope.idempotencyKey equals stopId. Head persists its tombstone before
sending. Node durably binds the exact stop intent, closes admission before cleanup,
and prevents queued first delivery. Return `{ preparationId, runId,
assignmentEpoch, stopId, state, ownership }`, never optimistic stopped:true.
Status may include `stop: { stopId, reason }`. Same stop joins; changed intent
under the same ID fails; no new ID reopens work. Late stop for an old run cannot
stop a replacement. A closed/released receipt alone acknowledges local settlement.

Ordinary authorization that requires active && !tombstoned cannot reconcile
retained cleanup unchanged. Add an explicit **cleanup-only** status/stop authorizer:
still validate the current authenticated live lease/link; match persisted owner,
agent, workspace, run, epoch and preparationId; use the retained cleanup record
when execution is closed. Return only sanitized lifecycle receipts under current
response write-policy checks. It grants no prepare/prompt, checkpoint/files,
credentials or another agent's authority. Keep all other deny behavior.
A revoked/released lease token gets no bypass; unavailable cleanup inspection
remains local/operator-managed or subject to the accepted lost-node fence.

Failed cleanup prevents reuse of **that same node's** process/root/private home,
capture owners and slot. It does not block separately authorized recovery on
another node after the [canonical loss fence](#outage-timing-and-single-resume).
Head may restore the last durable checkpoint there without acknowledgement from
the unreachable old node. Old resources remain quarantined/charged locally;
fencing does not assert deletion or successful native reap.

### Private errors and qualification

Use the existing JSON-RPC error envelope with sanitized `data.code` and optional
retryable boolean; no secrets, paths or raw stderr. Pre-reservation failures have
no record/effects. Later failures persist their owned cleanup outcome for status.

| Code | JSON-RPC code | Meaning |
| --- | --- | --- |
| invalid-params, request-id-reused | -32602 | Bad/unknown fields or changed intent under the same ID |
| preparation-conflict | -32005 | Occupied assignment with different pinned intent |
| preparation-unavailable | -32603 | Cannot reserve bounded capacity/storage; retryable only before effects |
| preparation-not-found | -32602 | Unknown/inaccessible receipt, without disclosure |
| stale-assignment | -32003 | Wrong/stopped/replaced run, epoch, owner, grant or generation |
| checkpoint-invalid, configuration-unavailable, history-unavailable | -32602 | Invalid/ungranted source, config or history |
| unsupported-node-operation | -32602 | Unsupported provider/tool/session configuration |
| preparation-not-ready | -32603 | Delivery deadline before actual readiness |
| preparation-failed, preparation-cleanup-pending | -32603 | Failed owned preparation or unsettled cleanup |
| rpc-outcome-unknown | -32603 | Lost/uncertain outcome; reconcile, never respawn automatically |

The [lifecycle corpus](./fixtures/nodes/lifecycle.json) contains prepared data and
scenario assertions, not an executed adapter or runtime qualification. Future
tests must exercise real authority/transport/cleanup boundaries, including response
retirement versus cancellation, stale ready receipts, duplicate/uncertain delivery,
and invalid source/config/history. Each fixture must register a unique root and
out-of-test-lifetime owning supervisor before effects, plus teardown on every path.
Reset only injected test faults, then perform authentic stop/settlement before
removing roots. Failure/timeout retains charged owners and safe diagnostics for
the supervisor/operator; no forced closed flag, invented ACK, deletion or dropping
native/private/capture owners. Whole-worker disposal is not cleanup-pass evidence.
No production retained-failure disposal API is added by this contract.


## Namespace routing and file contracts

Classification is by operation, not a blanket namespace proxy. Bindings are in
`intent-acp/src/mcp_server/bindings`, using `intent-js`; implementation must cover
those entry points as well as service handlers.

| Operations | Execution and authority |
| --- | --- |
| ACP fs/terminal, file read/write/list/search, Git CLI, attributed commit, host exec, scripts/PTY | Node-local, rooted at the assigned checkout; attribution/metadata updates go to head with the bound agent |
| Git root register/unregister/list | Node validates local paths; head stores repo identities and opaque node path metadata, never opens that path |
| Notes, tasks, comments, agent management, workspace metadata, subscriptions, PR snapshots/monitors | Head RPC under existing authority; head return values cannot assume a node can read a head file |
| Search over files vs notes/events/conversations | Files on node; durable coordination data on head; never fall through to head filesystem search |
| Script definitions/status, hook schedules | Durable metadata on head; script execution/output and QuickJS hook evaluation on the target node; one run ID across reconnect |
| Browser/user GUI intents | Existing authenticated frontend path; no node filesystem path passed to open-in-editor; unavailable GUI operations fail explicitly |
| MCP stdio / HTTP | Node process / direct node HTTP; per-agent supplied config, never head-local executable paths or copied login directories |
| Attachment registry / blob persistence | Head; authorized bytes materialized on node before the referencing turn starts |
| Settings/credential/host administration | Not forwarded from node agents; existing owner controls remain head-side |
| Unclassified operation | Fail closed until classified; never default to arbitrary head filesystem/host execution |

A hook resolves its owner/target's current lease at each run, runs at most once,
and stays pending while offline; no alternate-node/head fallback. Restoring script
metadata does not automatically restart an uncertain command. Services and stdio
MCP can restart after reconciliation; non-idempotent commands need explicit retry.
Child/peer agents exchange artifacts through commits, blobs or notes, not paths
into another agent's checkout, even when the static host happens to share disk.

Head keeps attachment IDs and content-addressed blobs; node fetch requires an
authorized agent/workspace attachment grant, not knowledge of a hash. Verify
length/hash, reject symlink/path escape, write a temp file then rename within
`.intent/attachments/`. Missing/deleted attachment fails the referencing turn
before provider delivery. `file.getAttachment` returns the node materialization
path, never a head path. Oversized workspace API results are stored in the node's
`tool-outputs/`; they are derived data excluded from checkpoints. Blob responses
from head are materialized there on the node. After node loss, resume notice says
prior tool outputs are gone and calls may need re-running; it never abandons the
agent for that reason. Content hashes are integrity checks, not authorization.

Phase 1 credential qualification uses an already-supported static provider API
key supplied through existing head secret configuration. Inject only the selected
provider/MCP's allowlisted variables at spawn; do not copy interactive refresh
tokens, ambient head environment or login directories. Private temporary files
are deleted on stop and excluded from Git/session snapshots. Unsupported providers
fail remote admission. Subscription-token onboarding, rotation UI, expiry warnings
and `credential.*`/credential-push APIs are not part of this phase.

Node Git credential helper `get` calls head each time with the bound agent and
granted repo; head normalizes provider/host/repo and returns only scoped fetch
credentials over the encrypted link. No generic `system.gitCredential` forwarding,
raw forge token in child environment, credential logging or cross-repo request is
permitted. Checkpoint pushes use the hub grant, not forge credentials. Where the
credential source cannot supply a repo-scoped read credential for a node, fail
remote hydration explicitly; do not export the broad head publication token.
Forge publication and the bounded gh bridge run only on head.

## Journal, crash ordering and acknowledgements

Each lease has a durable random incarnation and monotonically increasing u64
`seq`, starting at 1 and serialized as decimal strings to avoid JavaScript integer
rounding. All agents on that lease share the sequence. A record contains
`leaseId`, `incarnation`, `seq`, `agentId`, `workspaceId`, `runId` (UUID per provider
process), `turnId?`, `kind`, `recordedAt`, `payload`, `sha256` of canonical payload.
Identity is `(leaseId, incarnation, seq)`; retransmission must have identical
content. The node appends and fsyncs each record before forwarding any corresponding
ACP output/event. Raw credentials are not journaled. Large records reference
durably stored local blobs retained until their journal ack.

Head processes a contiguous prefix. In **one SQLite transaction** it inserts
dedup identity/hash, transcript/event projection, interruption effects and the
new contiguous watermark. Only after commit does it send `ack { seq }`. Public
stream events are emitted from committed records, with stable identities so a
restart cannot create duplicate transcript rows or completion deliveries. Crash
before commit produces no ack; crash after commit but before ack results in
deduped replay. Node fsyncs received ack before reclaiming acknowledged journal
segments/blobs. Never ack merely buffered frames or advance across a gap. Duplicate
identity with different bytes is corruption: halt the lease and require recovery.

On reconnect, head supplies its durable watermark. Node replays higher sequences,
then sends a `replayComplete { throughSeq }` barrier; head must commit through that
sequence before live operation/recovery continues. Node buffers new live records
behind that barrier. Head watermark behind already reclaimed node records means
state rollback/loss, not success: fail closed for reconciliation. A newer lease
incarnation never reuses the old sequence/ack state. Released/tombstoned agents'
late records may finish authorized historical transcript ingestion but cannot
resurrect execution, ref ownership or completion effects.

## Outage timing and single resume

Use monotonic time for budgets; RFC timestamps only describe incidents. Heartbeat
every 15 seconds; three consecutive missed replies declare failure at 45 seconds
after the last valid reply. EOF/TLS failure declares it immediately. Set `downAt`
once on this transition, with `graceDeadline = downAt + 90s` and
`autonomousDeadline = downAt + 30min`. Reconnect counts only after authenticated
handshake/replay succeeds, not a TCP accept; failed redials do not reset budgets.

During grace the current turn may perform node-local work. A head-dependent call
or permission prompt waits without fabricating a result or replaying a mutation;
if the call's own deadline expires earlier, return an explicit unavailable/unknown
outcome and halt. Otherwise, if still blocked at grace expiry, halt immediately.
This resolves the source draft's conflicting claims that short drops never halt
and every head-required call halts immediately: grace delays halt only while the
call can safely wait. Journal capacity/safety/user stop can halt even during grace.

After grace, a current turn needing no head may continue until it finishes or the
30-minute deadline, whichever comes first. No new turn starts offline. A subsequent
head-dependent call halts immediately. No unverified token-count estimate is a
phase 1 budget: the mandatory wall-clock/current-turn limit applies to every
provider. Journal cap is 256 MiB per lease including referenced payloads; reserve
1 MiB for stop/interruption records and halt before consuming that reserve.
Never discard unacked records to make room. An I/O/fsync failure also halts and
must be reported as journal failure on reconnect.

Halt sends ACP cancel, allows up to 5 seconds for shutdown, kills/reaps the process
tree, then durably records the interruption and retained checkout/session paths.
If the node restarts, orphan detection treats any previously live run as interrupted
and verifies/kills its processes before admission. Static nodes retain disk and
wait indefinitely; phase 1 has no suspend/freeze/cloud TTL.

Reconnect order is authenticate/fence generation → replay/commit ack → reconcile
node run IDs and stop tombstones → import interruptions → resume at most once.
Head persists a unique resume attempt ID against the interrupted run and sends it
with admission; node persists accepted IDs before spawn. Lost admission responses
reconcile that ID, never mint another live run. A current process that survived a
short outage continues without an extra prompt. A user-stopped/deleted agent is
never auto-resumed. A halted agent with known disk uses provider session/load where
supported, otherwise existing bounded history replay. Resume continuation names
the cause, outage duration and uncertain in-flight request, without automatically
reissuing its mutation.

On permanent node loss, fence the old lease before placement elsewhere. Restore
requires a confirmed stop, or a conservative wait of 45 seconds detection plus
30 minutes autonomous budget plus 5 seconds reap time after head's last observed
authenticated heartbeat. This wait assumes the node enforces the authenticated lease budget
without extension; if that cannot be established, require operator stop confirmation.
Do not infer a fence from head's shorter locally observed grace timer. Then restore
the last successful [checkpoint](./node-checkpoints.md), rematerialize attachments,
and use its session cut plus subsequent acknowledged transcript for continuation.
Report both checkpoint capture time and the interval of possibly missing work.
A five-minute checkpoint timer is **not** a five-minute loss bound: an outage or
failed capture can leave a much older successful checkpoint. Unacked journal on a
lost disk is unavailable; acknowledged transcript remains on head independently
of the filesystem checkpoint. The recovery notice explicitly distinguishes them.
