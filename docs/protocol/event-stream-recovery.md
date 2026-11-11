# Generic event stream loss recovery

**Additive contract.** intentd advertises `eventStreamRecovery: 1`
in `client.hello.server.capabilities`, which announces this complete transport contract.
A numeric protocol version alone does not establish support. This extends
[events subscriptions](06-events.md) with one additional fast-path method, without changing domain events,
chat delivery, durable event queries or snapshot-channel sequences.

## Negotiation and wire format

A new client first discovers the capability on the current physical connection,
then requests `lossRecovery: 1` on each generic subscription it can recover:

```json
{"jsonrpc":"2.0","id":60,"method":"events.subscribe","params":{"eventTypes":["file:*"],"workspaceId":"ws-a","replaceGroup":"file-events","lossRecovery":1}}
{"jsonrpc":"2.0","id":60,"result":{"subscriptionId":"ws-sub-1","lossRecovery":1}}
{"jsonrpc":"2.0","method":"events.lost","params":{"subscriptionId":"ws-sub-1","generation":"1","scope":{"workspaceId":"ws-a"}}}
```

The notification has no request `id`. Its three parameters are required:

| Field | Meaning |
| --- | --- |
| `subscriptionId` | Nonempty server-assigned ID of this connection's admitted generic subscription; never an agent-owned or typed-channel subscription. |
| `generation` | Canonical decimal string in `1..18446744073709551615`, without leading zeroes. Monotonically increases per subscription lifetime, starting at `"1"`; compare using exact integer arithmetic, never JavaScript `Number`. |
| `scope.workspaceId` | The subscription's requested nonempty workspace ID, or explicit `null` for an unscoped subscription. This is a scope echo, not the workspace where a drop occurred. |

`scope` has exactly the one field above. The frame carries no missed count,
event types, event IDs, principal IDs, payload, timestamp or inferred workspace
list. The client retains the admitted request's `eventTypes`; it never treats
this marker as an event or forwards it to activity/history/UI-command handlers.
It is socket-private control, not an entry in `event-types.json` or `event.query`.
Unknown additive fields may be ignored by clients, but cannot expand admission.

On supporting servers, absent `lossRecovery` keeps the old request/result shape;
exact integer `1` opts in. Any other supplied value (including `null`, `true`,
`0`, `"1"`, or another version) returns `-32602` before creating or replacing
subscriptions. Opted-in requests require a request ID (JSON-RPC notifications
cannot establish an acknowledged recovery lease). Empty `workspaceId` is rejected
for opted-in requests; omission means unscoped. The ack adds only `lossRecovery: 1`.
Generation zero is implicit at admission; it is never sent as a loss.

| Server capability | Request/ack | Required client behavior |
| --- | --- | --- |
| Exactly integer `1` | Opt-in `1`, ack `1` | Admit markers only for this live acknowledged lease. |
| Exactly integer `1` | Old request, old ack | Legacy delivery; no `events.lost` on this lease. |
| Absent, malformed or unknown version | Omit opt-in | Preserve reconnect and explicit-refresh fallback; silent old-server losses cannot trigger automatic recovery. |
| Claimed `1`, opted in, ack missing/wrong | Unconfirmed negotiation | Do not admit markers; retire the attempted lease and establish a legacy lease once, with a diagnostic. No retry negotiation loop. |
| Any | Subscribe rejected, retired, foreign or stale ID | No marker-driven read or state mutation. |

An old server may ignore unknown request fields; therefore sending the opt-in
without capability discovery, or assuming support from an echoed ID, is unsafe.
Capabilities, IDs and generation watermarks never carry across physical reconnects.
An old client on a new server is unchanged. The security behavior for membership
watcher loss below applies even to non-opted-in clients.

## Server ordering and conservative invalidation

The broadcast bus detects lag **before** filtering by type, workspace or caller.
A primary receiver loss therefore invalidates the entire admitted subscription
scope conservatively; it does not prove that any authorized matching event was
lost. A global marker means only the current caller's admitted resources for that
subscription, never every workspace on the host. Generation counts emitted
invalidation barriers, not dropped messages or unauthorized activity volume.
False positives are expected. No replay cursor or exactly-once promise is added.

1. Wire the primary receiver (and any membership watcher) before acknowledging
   subscribe. Queue the successful response before starting notification delivery.
   Both `events.event` and `events.lost` must follow that ack on the physical wire.
   A loss between registration and ack remains pending and is emitted after ack.
2. Observe raw `Delivery::Lagged` rather than the convenience `recv` that skips it.
   Loss wakes delivery even with no later matching domain event; never wait for a
   matching event to attach the marker. Intentional documented latest-value
   conflation is not itself bus loss.
3. A loss is an ordering barrier in the **same ordered bulk lane** as this
   subscription's events. Drain all already accepted pre-loss conflated events
   before the marker; enqueue the marker before accepting post-loss domain events.
   Never send the marker on a priority lane that overtakes earlier bulk events.
   Conflation keys cannot merge across the barrier. Loss notices cannot be silently
   dropped when the output queue is full, nor conflated with domain events.
4. The forwarder may combine adjacent loss observations while no intervening
   event has been accepted, producing one next generation. Each emitted barrier
   advances generation by one. On exhaustion close the connection; never wrap.
5. Delivery under a stalled writer is bounded: allow at most 5,000 ms to drain
   pre-loss buffered items and complete the loss barrier socket write, measured
   from observing loss, then close the connection if this cannot complete.
   Queue admission alone is not completion: a queued marker retains its deadline
   until the writer confirms flush completion; a stalled writer cannot leave the
   connection live. The deadline cancels the connection task and any active socket
   send/flush out of band, drops the socket halves, and discards all unwritten
   priority/bulk/conflation buffers. Enqueuing a close frame behind a stuck send
   is insufficient. Completion means local socket flush, not peer observation;
   a broken link still requires ordinary disconnect/liveness recovery. Transport writer
   failure also closes the connection. Reconnect recovery handles a marker that
   could not arrive. A connection that remains usable must not silently lose it.
6. Unsubscribe, replacement, authority loss and disconnect retire the old
   forwarder and its pending buffers. Replacement creates a new ID and generation
   zero; no watermark transfers. Already queued old frames may still arrive after
   a priority unsubscribe/replacement reply; clients reject retired IDs locally.

There is no total order between different subscriptions. Recovery is a current
state reconciliation; it cannot recreate every transition, terminal byte, toast,
sound, navigation request or other one-shot effect that was lost.

## Membership watcher loss

A collaborator's membership watcher is an independent security input. Lag or
unexpected closure on it makes cached allow decisions unsafe, even if the primary
receiver did not lag. **Fail closed:** stop guarded forwarding, discard its
conflation buffer and membership cache, and cancel the physical connection and
active writer out of band, discarding all unwritten connection queues. Do not
continue with the watcher disabled, send an ordinary recovery marker as a substitute,
or fall back to administrator/global admission. Apply this to legacy leases too.

Prioritize observable membership changes/loss over buffered-item drain and primary
delivery. After an awaited membership check or capacity wait, recheck cancellation
and pending membership invalidation before enqueueing guarded data. No data may
be newly admitted after this failure is observed. Frames already committed to the
socket cannot be recalled; on closure the client fences all prior lifetimes and
reconciles authorized state on the replacement connection. A fresh subscribe does
not restore revoked membership: the daemon's current authorization governs every
recovery read. A scoped member removal retires that scope; global scopes may keep
other authorized workspaces only when membership continuity is known.

## Client admission and reply fencing

Install notification handling before subscribing. Capture a monotonically changing
local lifetime token for backend connection, authenticated principal and subscription
attempt. On ack, bind the subscription ID, immutable requested scope/patterns,
negotiation result and current workspace/resource ownership. Check that token
before admitting notifications, **before issuing each read**, and before applying
its response. A→B→A switches create new tokens; comparing IDs/strings alone is
insufficient. Disposal, principal replacement and connection loss cancel timers,
retire pending work and prevent old in-flight replies from writing any store.

Transport ordering does not guarantee that renderer ack handlers run before
notification callbacks. Keep at most 64 early loss markers on the current physical
connection while subscribe attempts are pending, at most the greatest generation
per candidate ID. After ack, process only matching IDs with equal immutable scope;
foreign/rejected IDs expire when all pending attempts settle. No reads occur before
admission. On staging overflow, clear the staging map and dirty all successfully
negotiated leases admitted from those pending attempts once; this is conservative
local invalidation, never trust in the discarded IDs. Retired IDs cannot be staged
back into admission. Teardown clears staging. Component tests must exercise the
ack-handler race even though wire ordering is ack-first.

Reject malformed generation/scope, wrong workspace, unknown lease, wrong transport,
old principal and retired subscription. Duplicate or lower generations do nothing;
a higher generation invalidates once even across a gap. A gap has no missed-event
count meaning. Never infer a recovery target from an untrusted frame. Derive targets
from admitted subscription patterns intersected with locally owned resources and
current authorization. For an unscoped lease, use current authorized workspace
state; an authoritative caller-relative workspace list may reconcile deletions and
membership removals before scoped recovery. Permission/not-found results retire
that resource and clear protected stale state; they do not trigger fallback reads
on another backend or principal.

## Causal recovery boundary: `events.fence`

**Fast-path method, required by `eventStreamRecovery: 1`.** Arrival-time
mutation epochs cannot distinguish an old bulk push from a fresh read returned on
the priority lane. A recovering client therefore brackets unversioned authoritative
reads with fences on **every generic lease allowed to mutate that resource**:

```json
{"jsonrpc":"2.0","id":62,"method":"events.fence","params":{"subscriptionIds":["ws-sub-1","ws-sub-global"]}}
{"jsonrpc":"2.0","id":62,"result":{"subscriptionIds":["ws-sub-1","ws-sub-global"]}}
```

`subscriptionIds` is a required array of 1–64 distinct nonempty strings. Every ID
must name a live, acknowledged, `lossRecovery: 1` generic lease on this physical
connection. Unknown, retired, foreign, legacy, typed-channel or duplicate IDs,
invalid shapes and a missing request ID do not create a fence. A request with an
ID gets `-32602` and generic message `Invalid recovery subscription set`, with no
foreign ID details. The success result has only `subscriptionIds`, in request
order; it gives no global bus cursor, activity count or new authority.

At admission, capture a finite tail boundary in the **raw bus delivery order** for
each named receiver. Carry an internal ordered barrier through the bus filtering
worker and its per-subscription delivery queue, not merely the transport queue.
Every raw item before the boundary must have been filtered/authorized, emitted,
or reported lost before that forwarder reaches its barrier. A private ordered
control item (not a published domain event) or an equivalent explicit cursor/ack
can implement this; checking an empty queue or its current length is not a fence.
Loss cannot skip a barrier: loss is emitted before its barrier, or the fence fails.
It is valid to drain conservatively past the captured boundary, but never to wait
for a future matching event or an indefinitely moving tail. This includes
transient events and events rejected by type/workspace/authorization filters.
The internal barrier itself bypasses domain filters and produces no domain
notification; it must complete when no later matching event is published.

Fence orchestration is an owned, cancellable task. The request handler validates
and starts that task, then returns to the connection loop without awaiting any
receiver drain, output capacity, writer completion or fence result. In particular,
WSS processes inbound frames and drains outbound frames in one loop: awaiting
the fence there would deadlock its own writer. The coordinator completes the
original RPC asynchronously after the barriers; replacing/revoking a named lease,
disconnect or the deadline cancels it and releases its receipts. No detached task
may publish success after cancellation.

Each forwarder flushes its pre-boundary conflation before acknowledging the
internal barrier. After **all** named barriers, enqueue the RPC success on the
same FIFO bulk lane after their preceding frames. A priority-lane success is
forbidden. Later events may interleave before the success and conservatively
invalidate the read. A lease retiring, being replaced or losing authorization
before success invalidates the whole fence; return the generic error when safe,
otherwise close. Never silently drop one ID and acknowledge a smaller set.
The existing 5,000 ms deadline covers admission through socket flush of the fence
reply and uses the same connection-wide cancellation as loss delivery.

The client recovery cycle is concrete:

1. Capture resource lifetime and the complete mutable lease set. Suppress direct
   application of unversioned pushes to this resource while recovering; they set
   a conflict/dirty bit instead. This includes overlapping leases and any still
   queued callbacks for them. Pause or retire other mutation owners that cannot
   join this boundary; a non-opted-in overlapping writer cannot be ignored.
2. Await a **begin fence** on that lease set. Its reply becomes visible to the
   recovery scheduler only after all preceding notification callbacks have been
   processed. Then reset this cycle's conflict bit and issue the authoritative
   read. Events after this boundary cannot be mistaken for older queued work.
3. Hold the read result without applying it, then issue an **end fence** for the
   same leases. Process all preceding callbacks before completing that fence.
   If any relevant domain frame or loss arrived between the observed begin/end
   replies, discard the held read and retain one paced trailing cycle. Do not
   replay an unversioned journal over it: the frame may predate the snapshot.
4. Only a successful read plus a successful end fence, with no intervening
   relevant frame/loss and unchanged lifetimes/lease set, can replace resource
   state and clear the captured dirty version. Apply it before processing frames
   following the end fence. Resume ordinary push handling after recovery settles.

These processing barriers apply across Electron main/preload/renderer as well as
the direct browser transport. Both read promises and notification callbacks must
join an ordered ingress dispatcher; physical wire ordering alone is insufficient.
A fence is reusable for concurrent recovery resources with the same lease set,
but each resource keeps its own conflict/dirty version. Fence errors/timeouts
count as cycle failures under the retry policy below, not unlimited retries.
Adding a lease that can mutate the resource changes its local lease-set epoch
and invalidates an active cycle even if every original ID remains live. A
replacement, removal or newly overlapping writer has the same effect.
Fence requests/replies/internal barriers are control-only: they do not increment
loss generations or resource dirty versions, count as conflicting events, trigger
ordinary recovery, or reset consecutive failure budgets. Only successful data
reconciliation resets that budget. Each successful single-read cycle costs exactly
three RPCs: begin fence, data read, end fence. A failed begin fence costs one;
a failed data read costs two and skips the end fence; an end-fence failure costs
three. Resource batching may share fences but may never exceed these unbatched
counts for the same attempts. The two-retry limit therefore permits at most nine
RPCs for three failing cycles, or six when each data read fails. A trailing
successful cycle after an overlapping loss adds three RPCs, not one.

This establishes a boundary for **already published** events, including old frames
still in the bus worker, conflation buffer, outbound queue or renderer callback
queue. Producers must retain existing per-resource mutation/publication ordering:
a producer that publishes obsolete full state after a newer mutation must instead
supply authoritative revisions or invalidate/refetch in its resource adapter.
The generic fence is not a source revision and cannot repair a violated producer
ordering contract. Component adoption tests must check this prerequisite for each
full-state projection. Sources without it cannot opt into direct payload replay.

## Bounded recovery policy

Resource keys include backend/principal lifetime, workspace, resource kind and any
entity/read-identity dimensions. Overlapping subscriptions share a recovery owner
per key. Loss-generation watermarks belong to individual leases, never resources:
lease A generation 1 and a later lease B generation 1 are distinct invalidations.
Translate each newly admitted marker into a locally increasing resource dirty
version; a read captures that version. Each key holds one dirty version, at most **one active read**,
one **pending trailing read bit**, and one timer; no event-sized work queue.

- The first admitted loss dirties affected active resources immediately. Inactive
  cached resources become stale and refresh on their next demand, not eagerly.
- Start the first recovery cycle immediately when idle. While it is active, any newer loss
  or snapshot conflict sets the trailing bit. Duplicates do not set it. After a
  successful read, run one trailing read if needed; enforce at least **250 ms
  between authoritative read starts** for that resource, including immediately resolving reads.
  Continuous overflow can sustain paced reads, but never polling after it stops.
- Reads retain the existing finite transport timeout; timeout is a failed read.
  Failed reads get at most **two automatic retries** after the first attempt,
  with **1,000 ms** then **4,000 ms** minimum delays measured from failure. Losses
  during failures coalesce; they cannot reset the retry budget or shorten delays.
  Three consecutive failures suspend automatic recovery for that resource for
  this lifetime, retaining stale status. More markers alone do not restart it.
  Explicit refresh, a new demand after unmount/remount, or a new connection may
  open a fresh bounded cycle. Authorization/not-found failures are not retried.
- Only a completed, conflict-free begin/read/end cycle resets the consecutive
  failure budget; a successful data read followed by a failed fence does not.
  A conflict-discarded cycle keeps the prior failure count and one paced trailing
  cycle; new domain traffic can sustain these cycles at the same 250 ms bound,
  but fence-only traffic cannot sustain them. Clear only invalidations
  included by that read; a newer loss requires the trailing read. Do not clear
  all dirty state merely because any request succeeded. Timers cancel on teardown.
- Unversioned recovery uses the begin/read/end fence cycle above. Accepted pushes
  during that cycle mark a conflict; they neither overwrite the held snapshot nor
  get replayed as if arrival time were a source revision. Resource adapters with
  proven authoritative source revisions may reject stale replies/pushes directly,
  but must test equivalent causal protection. A complete newer snapshot satisfies
  old dirtiness only for the same resource with no later loss outstanding.
- Reuse the existing authoritative read owners so explicit refresh, reconnect,
  ordinary pushes and loss recovery do not issue duplicate reads. A composite
  resource may require several RPCs, but each underlying read key obeys the same
  concurrency/pacing limits. Partial success does not mark unread parts clean.

File invalidation refreshes active tree/content/status projections even if the
lost event was the final one. Git working state and commit-history identity remain
separate: never fabricate a history identity from file activity. Recovery must
establish a fresh immutable history identity through its authoritative read before
replacing history, with existing pushed-identity and read-generation fences.
No steady-state poll, blind transcript reload or replay of one-shot actions is added.

## Consumer inventory and implementation ownership

Read-only audit of frontend `origin/main` at
`2cda0cfeff7a4d23953f2288777551926710cd51` (merged RPC optimization) and intentd at
`cccec3b2` on 2026-10-13. Paths below are relative to `packages/cloudlands-fe/src/`.
This is an implementation checklist, not a claim these clients already recover.
Use existing caller-relative read owners, pagination and visibility limits.

| Consumer / source | Recovery source and boundary |
| --- | --- |
| `store/renderer/slices/workspace-events/sagas/daemon-events-saga.ts`; `features/events/daemon-events-bridge.client.ts` | Own global firehose and scoped `file:*` leases, admission and routing. Invalidate affected resource owners, never re-run all event handlers with a synthetic event. |
| `store/renderer/slices/workspace-agents/sagas/lifecycle-read-saga.ts`; agent read services | `agent.list` with existing scope/paging, `agent.listActive`, selected `agent.get`, `agent.getQueue`, pending permissions/subscriptions and failure-registry reconciliation as owned. Preserve push journals; no transcript reload. |
| `store/renderer/slices/provider-catalog/workspace-catalog-saga.ts` | Settings/provider/model/specialist/MCP catalog read owners for mounted workspaces; include readiness and workspace-specific MCP enablement. Ordinary complete pushes remain zero-refetch. |
| `store/renderer/slices/presence/sagas/presence-saga.ts`; sharing/host-membership stores | `presence.snapshot`, authorized workspace member/invite reads and host member/invite/execution-context read owners. Presence full-roster pushes and membership profiles still supersede stale replies. |
| `store/renderer/slices/git/sagas/git-read-saga.ts`; `features/accept-changes/accept-changes.client.ts`; `lib/client/live/live-git-client.ts` | `git.status`, active file tree/content/diff reads, changes/locks/attribution and accept-status owners; immutable commit-history identity via existing history read. Inactive views stale on next demand. |
| `lib/client/live/live-scripts-client.ts`; script store | Active summary list plus selected script detail; keep archived/output views and pagination behavior. `script:state`/`script:changed` pushes must beat earlier reads. |
| Browser-client and workspace-detail projections in the bridge | `browser.listTabs`, `client.list`, active `workspace.get`, context/token-usage and browser-selection owners for fields not covered by collection snapshots. |
| `features/git-roots/git-roots-service.ts` | Own scoped `gitRoot:*`; reseed `gitRoot.list` for mounted workspace. |
| `features/pr-monitor/pr-monitor-service.ts` | Own scoped `prMonitor:*`; reseed `prMonitor.list` for mounted workspace. |
| `features/hooks/background-hooks-service.ts`; background-hooks saga | Own scoped `hook:*`; `hook.list`, including code available only in list rows. |
| `features/script-monitor/script-monitor-service.ts` | Own monitor stream; paginated active `scriptMonitor.list` plus selected `scriptMonitor.get`; fence page journals. |
| `lib/client/live/live-skills-client.ts` | Own unscoped `skills:changed` lease; recover mounted workspace skill catalogs through `skill.list { workspaceId }`. Capture demanded workspaces explicitly: the last event workspace alone cannot recover a lost first/final event. Independent lease admission and disposal fences are required. |
| `lib/client/live/live-specialists-client.ts` | Own `specialists:changed` lease and catalog snapshot callback; `specialist.list` / existing catalog read owner with its provider/workspace scope. Coalesce with a shared catalog owner only when it is actually the same resource; workspace-catalog recovery does not own this lease automatically. |
| `shared/main/host-exec-stream.ts` | One generic lease per `host.execStream`, carrying stdout/stderr/exit. Explicitly legacy/transient: no authoritative output/exit snapshot or safe automatic command replay exists. Preserve caller abort/cancel, backend-switch cancel-and-notify and disconnect/RPC-failure cleanup semantics; this task promises neither byte recovery nor recovery of an unreported lost exit. Do not opt in until a separate terminal failure policy is implemented. |
| `features/hud/hud-subscription.ts` | Own global HUD stream; shared lifecycle read owners for watched workspaces and active agents; do not multiply `agent.listActive` by workspace count. |
| `lib/client/live/live-terminals-client.ts`; `features/terminal/main/terminal.ipc.ts`; ACP terminal handler | Generic terminal stream: `terminal.list` / `terminal.getBuffer` for current state where owned. No promise of exact lost byte replay or replaying exit effects. Separate terminal owners must opt in only after handling loss. |
| Main-process `features/workspace/main/app-settings.service.ts`, `workspace-path.service.ts`, `features/browser/main/workspace-forward-cleanup.service.ts`, guest workspace lease in `features/backend/main/backend.ipc.ts` | Separate sockets/owners; settings/workspace registry reconciliation and authorization cleanup require independent adoption. Do not mistake renderer recovery for coverage of these streams. |
| `features/notifications/main/notification.service.ts`; `features/backend/main/workspace-transfer-relay.ts` | Edge notifications / transfer progress: no blind replay of toasts, sounds or transfer side effects. Reconcile current status only through existing authority; explicitly retain legacy semantics until separately adopted. |
| `lib/client/live/delta-subscription.ts` and live workspace/agent/note/comment/task clients | Typed `subscription.push` owners provide reconnect snapshots, but current backend `forward_note_subscription` / `forward_channel_subscription` use `recv_visible`, which skips lag. Sequence continuity alone does not prove no loss. Recover affected mounted collections through one coalesced owner resubscription/fresh snapshot (or a separately proven loss-aware channel), not parallel point reads. Bridge-only metadata/task links/unread/permission projections retain their read owners. |
| `lib/client/live/live-chat-client.ts` | Chat has explicit backend `Delivery::Lagged` recovery in `forward_chat_subscription`. Preserve its independent snapshots; generic loss must not trigger transcript reads. This does not establish lag recovery for other typed channels. |
| Activity timeline, stream activity and `app:ui-*` bridge handlers | Best-effort transient presentation; invalidate stale indicators or use a documented current-state read, never invent missing history or execute stale commands. |

Backend implementation owns bus raw-loss delivery, membership failure, negotiation,
wire serialization, `events.fence`, raw-bus barriers and output cancellation. Client coordinator owns transport exposure,
admission and bounded scheduler. Store integration owns the active resource adapters
above; it must record every row as adopted, independently recovered, or explicitly
legacy/transient. A global opt-in cannot claim recovered state for an unhandled
stateful projection. Separate sockets/leases do not inherit another lease's opt-in.

## Deterministic fixtures and required consumers

[The canonical corpus](fixtures/event-stream-recovery/contract.json) contains exact
wire examples and deterministic schedules. Its [static tests](fixtures/event-stream-recovery/contract.test.mjs)
validate examples, cross-references and boundary values; they do **not** prove
runtime recovery. Run `node --test docs/protocol/fixtures/event-stream-recovery/contract.test.mjs`.
Component owners must load this JSON from the monorepo checkout in integration CI,
or copy it byte-for-byte with a recorded source commit and SHA-256 check. They must
not transcribe selected expectations into a second divergent corpus.

| Owner / component suite | Cases it must execute against real code |
| --- | --- |
| Backend: `crates/intent-services/src/events/bus.rs` tests; `crates/intent-transport/src/events/tests.rs`; `crates/intentd/tests/e2e_wss_event_subscription.rs` and `e2e_wss_egress_conflation.rs` | Scoped/unscoped and legacy wire examples; bounded receiver overflow without a later match; register/ack race; output barrier and timeout; membership-only lag; replacement and generation exhaustion. Use bounded channels, barriers and paused time, not real sleeps. |
| Client coordinator: `src/store/renderer/slices/workspace-events/sagas/daemon-events-saga.test.ts`; `src/features/events/daemon-events-bridge.client.test.ts`; JSON-RPC and browser transport tests | All negotiation/admission examples; early ack callback race; retired/foreign/wrong-scope rejection; exact u64 duplicate/gap handling; IPC provenance and reconnect/principal ABA. |
| Store integration: `src/store/renderer/slices/git/sagas/git-read-saga.test.ts`; `src/lib/client/live/live-git-client.test.ts`; lifecycle, catalog, presence and new recovery-owner tests | Held reads + fake scheduler: final file/Git event lost, overlap coalescing, exact read counts, pacing, finite failures, newer push fencing, inactive invalidation, disposal/ABA, legacy reconnect and explicit refresh. Preserve merged optimization regressions. |

Each component reports fixture IDs, command, outcome and its tested head. Advertising
the capability requires the backend cases to pass; adopting opt-in requires the
corresponding client admission and resource cases. Documentation/static fixture
success alone is insufficient. This protocol-only change has no assistant-app-guide
impact; implementation owners must document any changed user-facing behavior.
