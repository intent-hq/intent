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
  "nodeProtocol": 1,
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
