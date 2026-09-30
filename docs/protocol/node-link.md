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
forwarding cannot invoke these head-to-node operations. The separate
node-to-head checkpoint-read registration below has its own restricted grant.
Trusted composition explicitly grants
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
  "sourceMetadata": {
    "manifestJson": "<exact checkpointFormat 1 typed manifest JSON bytes>",
    "attachments": [
      { "id": "attachment-1", "sha256": "<64 lowercase hex digits>", "bytes": 256 }
    ]
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

### Immutable source metadata

Prepare requires `sourceMetadata: { manifestJson, attachments }` alongside the
checkpoint selector. It is request-only: status and other receipts keep their
existing selector/revision shapes and never echo these bytes. The
[lifecycle corpus](./fixtures/nodes/lifecycle.json) contains complete matching
strings, digests and descriptors; the inline schema above uses placeholders.

The authenticated head selects the exact retained source checkpoint under its
persisted current-or-inherited reader relation before dispatch. Manifest
workspace/agent/lease/incarnation/run/epoch/capture revision identify that source;
prepare's run/epoch and current assignment identify the target. Validate these
separately. Neither a hash nor deserialized PreparedCheckpoint grants access, and
a parent must not impersonate the child's target assignment. Each subsequent
source read requires fresh live source/target admission for that exact selection.

`manifestJson` is a string whose decoded UTF-8 bytes are at most 1 MiB and describe
at most 64 repositories. Its SHA-256 must equal checkpoint.manifestSha256 and its
checkpointId must match the selector. Reject unknown/missing/null members, wrong
types and duplicate keys (including escaped equivalents) at every level of both
the outer request and the enclosed JSON. Validate the closed checkpointFormat 1
manifest, including flattened repository fields, full OIDs, canonical decimal
counters, ordered submodule graph, inherited metadata and safe relative layout.

The digest remains SHA-256 of the existing checkpointFormat 1 **typed compact
serializer bytes**, not configuration's RFC 8785 encoding. The current head stores
a typed PreparedCheckpoint, not a separately addressable raw-manifest blob.
After authorized DurableStages::load validates its stored hash, head reconstructs
`serde_json::to_vec(loaded.manifest())`, checks that hash again, and sends those
exact bytes. Receiver strictly decodes the typed format, verifies the raw byte
hash, and requires byte-for-byte equality on the same typed re-encoding. Never
round-trip through a generic JSON map, pretty-print, reorder fields/arrays,
normalize Unicode/escapes or silently change optional-field omission. Equivalent
JSON with different bytes is not the selected manifest. Unsupported serializer,
build or format fails explicitly; it cannot justify a new checkpoint digest.

attachments is required (empty when the manifest has none), sorted by ID and
contains only `{ id, sha256, bytes }`. IDs are unique, nonempty and at most 128
UTF-8 bytes; hashes are lowercase SHA-256; bytes is a nonnegative integral JSON
number. At most 128 entries are allowed, with each size and the checked sum at
most 1 GiB. The ID/hash set must equal the manifest's complete attachment set.
Head selects lengths from that checkpoint's retained AttachmentInventory, never
from a current mutable registry file. Lengths are not part of the manifest hash:
pin them in the complete preparation intent and verify them against retained
inventory and actual bytes. All existing lower storage limits and the total
8 MiB RPC framing limit still apply; bulk metadata must not starve stop/heartbeat.

This data provides repository/object closure and attachment requirements, not
host paths, URLs, credentials, environment maps, retained receipt UUIDs, source
owner tokens, expiry-based authority or file payloads. Format-defined relative
repository/submodule/session layout remains inert validated metadata; never open
a supplied source path. Restore only into trusted anchored target roots. Parent
session metadata does not authorize portable import or require a fresh child to
use the parent's provider. The existing prepare.resume/Prompt.history carrier
remains the sole bounded history-text route; portable session-file import stays
unsupported when requested. No new fetch method or session carrier is introduced.

### Bounded metadata ownership

The complete immutable intent includes source metadata as well as checkpoint,
configuration and resume. Identical intent joins one owner; changed manifest
bytes, digest or attachment descriptor under the same preparation ID fails
request-id-reused, while a different intent in an occupied assignment fails
preparation-conflict. A fresh transport requestId does not create a new execution.

Do not embed the large wire member unchanged into the preparation ledger. Its
entire serialized record remains capped at **36,864 bytes**. A versioned internal
compact intent must retain small selectors/config/resume plus an opaque locally
derived metadata-object ID, source checkpoint/hash, exact lengths, descriptor
checksum and owner-binding checksum. Validate the full encoded record against
the unchanged cap before writing; never truncate or implicitly expand it.
Current full-PrepareRequest persistence and its selector-only identity require an
explicit adapter, not a DTO-only change or automatic restoration of old owners.

Store exact source bytes separately in private node-owned durable storage. Bind
the internally derived object name/header to full owner/agent/workspace/run/epoch/
preparation identity and checkpoint/hash; accept no object path/ref from wire.
Use a versioned exact descriptor encoding and local integrity checksum (not a
replacement checkpoint digest); qualify that encoding with goldens. Bounds are
1 MiB manifest, 128 KiB encoded descriptors and 4 KiB binding/header: at most
1,183,744 bytes per object. Reserve actual bytes against a 64 MiB aggregate cap
(or lower configured capacity) and no more objects than registry capacity,
which is at most 256. Pending, temporary, retained-failure and recovery-orphan
objects stay charged; no duplicate unbounded buffers or eviction of owned data.

1. Under the owning registry/storage lock, validate bounded data and current
   authorization, then durably reserve one compact preparation record and byte/
   count charge before object writes or async fetch. Its expected-but-incomplete
   object reference is not readiness or source admission; retries join the owner.
2. Write the owned temp object under current effect admission in a separate
   private no-follow store (the existing flat ledger rejects extra directories).
   Fsync files and newly created directory links, atomically rename to the derived
   immutable name, and fsync its parent before any fetch/restore depends on it.
3. Only a complete matching object and durable intent allow further preparation,
   still under fresh live admission. Missing/torn/mismatched/unpublished objects
   or uncertain publication close issuance and retain ownership/quota. Reopen
   reconciles ledger and object inventory first; unindexed leftovers remain
   quarantined/charged, never trusted or silently swept. An intact object cannot
   restore execution authority, replay a prompt or reset cancellation.
4. Cleanup closes admission and settles every native/capture/blob/repository reader
   first, removes only this preparation's object/temp files and fsyncs deletion,
   then durably records closed/released ownership and releases quota. Never delete
   its ownership record first or remove head checkpoints/other owners' data.
   Uncertain disposal retains ownership and blocks reuse of this slot/root;
   independently fenced recovery elsewhere remains allowed.

Malformed/overbudget metadata is invalid-params; mismatched digest, selector,
source or descriptor set is checkpoint-invalid; stale target authority remains
stale-assignment. Before-effects capacity failure is preparation-unavailable.
After reservation, cancellation, missing source bytes or failed persistence must
settle through owned failed/closing cleanup, retaining failed ownership when
cleanup cannot be proved. No transient object, partial closure or lost reply can
produce ready/released/ACK. Typed request retirement/cancellation, independent
execution lifetime and durable receipt revisions below remain unchanged.

### Selected checkpoint Git reads

Private version 2 adds node-to-head `rpc/request`
`node.checkpoint.read.prepare` to register/reconcile one selected-checkpoint read
attempt. Its result supplies an issued transfer ID before Git Open. Git Open uses
Service::Upload (`git-upload-pack`) with RequestScope.method
`git.checkpointUploadPack`; this is a private Git-lane discriminator, not a generic
workspace RPC. Neither name belongs in public method/routing catalogs. Version 1
rejects both. Ordinary Upload retains `git.uploadPack` and independent ordinary
grants; Receive/Stage remain unchanged.

The existing Open/RequestScope/helper Hello field sets do not change. Upload
still rejects StageBinding (`checkpoint`), operationCapability and idempotencyKey.
Only Stage accepts StageBinding. A missing source registration cannot fall back
to ordinary Upload, current-preparation lookup, today's aliases or arbitrary
manifest OIDs. Identity alone grants no authority.

#### Registration schema and direction

The closed request body is at most 2 KiB:

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000060",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "repoKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "attemptId": "00000000-0000-4000-8000-000000000051"
}
```

UUIDs are nonnil; epoch is a canonical decimal u64 string. repoKey is the exact
granted canonical repository identifier, at most 512 UTF-8 bytes, not a path or
URL; existing HubUrl canonical validation still applies. Reject unknown, missing,
null, wrong-type and duplicate/escaped-duplicate members before effects.
RequestScope supplies agent/workspace; requestId equals streamId and is transport
correlation. idempotencyKey equals attemptId; operationCapability is absent.
Registration's idempotencyKey is never copied to Git Open.

Only the trusted assigned node preparation supervisor may call this operation,
on its authenticated current link under an explicit installed method grant.
Agent scripts, public WSS, generic namespace forwarding, other nodes and the
opposite direction cannot invoke it. Head validates the exact issued preparation
record plus current source-reader and target admission; a valid lease alone is
insufficient. The source selector is derived from that record, never supplied or
replaced by registration arguments.

The closed result is at most 4 KiB; required fields are illustrated below. Only
`outcome` is additionally optional (sent, failed, cancelled, expired or unknown).
The [prepared corpus](./fixtures/nodes/lifecycle.json) supplies actual matching
hashes; the schema illustration's digest is a placeholder.

```json
{
  "preparationId": "00000000-0000-4000-8000-000000000060",
  "runId": "00000000-0000-4000-8000-000000000002",
  "assignmentEpoch": "7",
  "repoKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "attemptId": "00000000-0000-4000-8000-000000000051",
  "transferId": "00000000-0000-4000-8000-000000000052",
  "linkGeneration": "3",
  "checkpoint": {
    "checkpointId": "00000000-0000-4000-8000-000000000070",
    "manifestSha256": "<64 lowercase hex digits>"
  },
  "state": "issued",
  "ownership": "retained",
  "revision": "1",
  "expiresAt": "2026-09-30T00:02:00Z"
}
```

transferId is a head-generated globally unique UUID, used as Git streamId and
Open.request.requestId, not a bearer capability. Node checks the complete receipt
against its owned preparation, selected checkpoint/hash, repo and current binding.
States are issued, streaming, closing, closed and failed_retained. Ownership is
retained except when closed. State/outcome/ownership updates atomically advance a
durable per-attempt decimal u64 revision; receivers discard older observations
and require equal revisions to agree. These revisions are independent of the
preparation receipts below.

#### Head reservation before dispatch

Before sending lifecycle prepare, head durably reserves an issued preparation/
source record under exact head/owner/agent/workspace/preparationId. Target node,
lease/incarnation/run/epoch, source checkpoint/hash/identity and current-or-inherited
reader relation, full metadata intent digest, inventory digest and original
source-window deadline are immutable values. Changed intent under that identity
fails; retries reconcile one owner. The existing node-local registry is not this
head producer. Do not reconstruct it from an unknown Open or target singleton.

Head source records have separate, cumulative limits from transfer attempts:

| Resource | Limit |
| --- | --- |
| Head preparation/source records, including reservations and tombstones | 256 |
| Encoded bytes per source record / aggregate | 32,768 / 8 MiB |
| Repository retention grants per source record | 64, at most three selected anchors each |
| Attachment retention grants per source record | 128 |
| Explicit root/object retention references per source record | 320 |
| Identity strings | At most 512 UTF-8 bytes; stricter UUID/epoch rules still apply |

All encoded identity/reference bookkeeping counts toward the record cap. Store
identity/hash-bound references and inventory digests to the existing authorized
checkpoint objects, not another inline manifest or caller paths/credentials.
Missing/mismatched referenced metadata fails closed. Reference counts do not
bound Git object bytes: backing storage must reserve actual retained closure data
under a finite configured capacity before admitting pins. Shared objects stay
charged while any reference retains them. Missing/exhausted backing capacity
rejects admission; configured limits may be lower.

Atomically reserve the slot, maximum record allowance and required reference/data
capacity **before pin acquisition or prepare dispatch**. The durable reservation
owns partial pin acquisition. Persist the complete validated inventory before
sending prepare. Lost dispatch, publication uncertainty, interrupted acquisition
and a node that never registers any attempt remain charged. Registration cannot
implicitly create a preparation record. No acquired or uncertain ownership is
evicted to admit more work.

#### Attempt producer, installer and Open

Head registration selects only the exact immutable checkpoint HEAD/index and
optional WIP anchor names AND expected OIDs for the granted repository. Source
identity may belong to a parent/prior run; HubUrl/HubAssignment remains the target.
Never forge the parent's assignment for a child. Required inherited execution
bases must be proven in the selected closure; submodules each require their own
granted repository/attempt and parent-before-child restore validation.

Before returning a transfer ID, durably store full target/source/preparation/repo
identity, current lease/incarnation/link generation, method/service, attempt and
transfer IDs, deadlines/retry ordinal, expected immutable roots, source retention
reference, state/revision and cleanup ownership. Source pins are not selection
proof: orphan checkpoint anchors cannot substitute for an authorized successful
checkpoint. Missing mandatory anchors or OID mismatch fail checkpoint-invalid,
not partial advertisement; no union with moving aliases or unrelated hub objects.

The authenticated receipt installs a one-shot **typed local Upload grant** binding
an existing private helper capability and exact HubUrl to the issued ID, method,
current binding and owned preparation. The capability is node-local, never an
Open operationCapability. Hello, URL and CLI cannot choose the issued ID or
method. Its namespace/path remains distinguishable after consumption/expiry:
unknown, consumed or expired source grants cannot fall through to ordinary helper
capability handling. Ordinary helpers retain ordinary IDs/grants. ReceiveIntent
and ReceiveAttempt are ownership-pattern references, not Upload implementations.

NodeGitService consumes the installed source grant instead of generating an ID.
It sends the existing Git data frame with `gitOpen` metadata: service
`git-upload-pack`, exact target HubUrl and RequestScope.method
`git.checkpointUploadPack`, timeoutMs 120000, streamId equal to requestId, and no
checkpoint, operationCapability or idempotencyKey. Head checks this closed
service/method pair, current authenticated binding/generation and matching URL/
scope agent/workspace before atomically claiming issued to streaming. Unknown,
foreign, expired, already-consumed or stale IDs fail before advertisement. Issued
source IDs also fail with ordinary git.uploadPack; never relax validation to
arbitrary method strings.

Retain a distinct typed Upload owner through selected-source HubAccess, native
reads/copy/advertisement, scratch work and outgoing writes. Fresh source/target
admission is required after waits, before native reads, before each chunk enqueue
and at the actual write. Queued frames must retain an attempt-owned write guard;
a pre-enqueue check or today's unguarded Upload send is insufficient. Stop,
revocation and lease/generation closure fence admission first, then drain readers
and queued/native writes before cleanup. Already delivered bytes cannot be
recalled; no new bytes may pass after the fence.

This requires new producer/registry, method grants, typed installer, selected-source
adapter and guarded Upload composition. Existing local stage repository maps and
ordinary Git transport are not qualified remote selected-checkpoint delivery.
Registration, EOF and outcome sent prove neither node fsync nor complete local
closure, hydration, readiness or checkpoint ACK. Validate all repositories,
inherited index/worktree/submodules and attachments under live authority before
ready; existing Prompt history and unsupported portable import remain unchanged.

#### Retries, limits and reconciliation

Dedup identity is owner/agent/workspace/preparationId plus attemptId. Repo, run,
epoch, generation and source selection are immutable values, not alternate keys.
Changed values with that nonce fail request-id-reused. A repeated registration
may use fresh transport correlation but returns the same transfer ID and current
versioned receipt, never another native transfer.

Allow one unsettled attempt per preparation/repo. A different nonce while issued,
streaming, closing or failed_retained fails source-read-in-use. Duplicate Open
fails; it cannot join or restart a stream. Lost registration reply is reconciled
with the same nonce. Repeated receipts cannot reinstall a consumed local grant
or launch a second Open during active/uncertain ownership. Node retains consumed/
uncertain installer state until settlement; loss of that state requires
conservative reconciliation/retirement, not resurrection from an issued receipt.
The lane's bounded retired-stream set is not durable replay evidence.

After actual closure, allow a fresh nonce/ID only under fresh authority and the
same source. Limits are three attempts per preparation/repo across generations,
64 repository slots per preparation, 4096 total live/terminal-retained attempt
rows and 16 MiB encoded attempt storage, at most 4 KiB per row. Lower configured
caps are allowed. Reserve before returning an ID. Counters/tombstones needed for
dedup stay charged until safely compacted; reconnect cannot reset them.

The source window is at most 600000ms from initial durable head reservation. Each
attempt expires no later than 120000ms after issuance or the original source/
lease deadline, whichever is earlier; earlier preparation stop/delivery deadlines
still win. Head admission/time is authoritative; node may shorten, never extend.
Clock/restart uncertainty cannot extend deadlines. Reconnect fences old generation
IDs, helper grants and queued writes; a new generation requires actual old-owner
settlement, new nonce/ID and fresh admission within the original budgets. Disk
records do not restore a grant, authority or cancellation token after restart.

Registration cancellation before publication leaves no usable ID; uncertain
publication retains reservation for same-identity reconciliation. Normal RPC
reply retirement does not cancel an issued attempt: its lifetime is independent
of the waiter. Explicit stop/cancellation/source revocation/expiry closes it.
Known-attempt cleanup-only reconciliation may return sanitized status after
preparation tombstoning under a valid current lease/link and exact retained
owner/run/epoch. It cannot allocate, reopen, read source or change selection;
expired/released credentials are rejected. Head-local operator reconciliation is
separate.

On recovery, expiry or stop, head reconciles even records with **zero attempts**.
Durably fence registration/Open first, settle all claimed readers, native work,
scratch and queued writes, then idempotently release each recorded retention grant
by preparation/reference identity. Persist confirmed release before refunding
capacity. Uncertain claim/publication/release remains charged and failed_retained.
Expiry, waiter disappearance, disposal or deletion is not cleanup evidence. Zero
attempts removes transfer settlement only when durable state proves none was
claimed. Releasing head source pins does not declare a node checkout/process clean
or permit reuse of its slot/root. Fenced recovery elsewhere remains allowed.

After actual source/attempt settlement, compact to a charged tombstone retaining
preparation identity, immutable target/source/metadata digests, deadline, terminal
decision and nonce/retry fences (or their still-charged attempt rows). Reject
renewed registration/stale Open; compaction cannot make the identity admissible
again. Delete a tombstone only after durable retirement of its target assignment
epoch/lease makes all old requests **and issuance paths** reject before lookup,
across restart. The identity cannot be reused in a later epoch. Without that
retirement proof retain the charge and fail closed on capacity exhaustion; it
never substitutes for actual cleanup.

Registration uses the existing sanitized error envelope:

| errorCode | JSON-RPC code | Condition |
| --- | --- | --- |
| invalid-params / request-id-reused | -32602 | Invalid closed schema/identity or changed nonce intent |
| stale-assignment | -32003 | Foreign, stopped, replaced target or generation |
| checkpoint-invalid | -32602 | Invalid/ungranted source, repository or required roots |
| source-read-in-use | -32005 | Another unsettled attempt owns the exact slot |
| source-read-unavailable | -32603 | Capacity/deadline/retry budget unavailable before effects; retryable only when safe |
| rpc-outcome-unknown | -32603 | Uncertain result; reconcile its retained identity, never assume absence |

Git Open uses the existing sanitized Git-stream failure mechanism and settles
its owned attempt without partial source advertisement. No public error/event
or checkpoint/journal format is added.

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

revision is a durable per-preparation monotonically increasing decimal u64 shared
by prepare, status, Prompt and Stop result snapshots. Persist each lifecycle state,
ownership, failure, firstDelivery or stop change atomically with an increment of
that revision, before exposing the changed snapshot. Reads and identical retries
that cause no change do not increment it. Never wrap the counter; fail closed
before mutation if exhausted. Results observe a consistent persisted snapshot.

Consumers compare revisions numerically for the same preparation/run/assignment
identity across all four response kinds. Ignore observations with a lower revision;
older replies must never overwrite newer status or result observations. Equal
revisions agree on overlapping fields; a partial Prompt or Stop result does not
clear fields it omits. States are preparing, ready,
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

Prompt result is `{ preparationId, runId, assignmentEpoch, revision, turnId,
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
assignmentEpoch, revision, stopId, state, ownership }`, never optimistic stopped:true.
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
