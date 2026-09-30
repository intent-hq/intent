> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.5b Worker observations (prepared additive extension).

### 5.5b Read-only Codex worker observations

**Prepared, not implemented by the pinned components.** This contract defines a
bounded projection of provider reports, not a process monitor. It adds no output
reader, filesystem access, stop control, heartbeat, process-exit guarantee or
worker-count contribution to parent-agent activity. It does not close issue #851.
The [executable model](../../../scripts/agent-worker-contract.mjs) and
[goldens](../fixtures/agent-workers/v1/corpus.json) are synthetic specification
examples, not captured sessions or certification of live provider behavior.

#### Negotiation and evidence boundary

A future daemon advertises `server.capabilities.agentWorkers: 1` in
[client.hello](./client-hello.md) only after implementing the complete contract.
A client without that flag shows **unavailable** and does not call these methods.
An unexpected `-32601` after advertisement also falls back to unavailable; do not
poll other methods or infer support from protocol version or catalog presence.

Server support is distinct from support for the selected provider session. V1
allows only verified `@agentclientprotocol/codex-acp` **1.13.1**, with the AIR
extension requested in ACP initialize:

```json
{"clientCapabilities":{"_meta":{"jetbrains":{"air":{"version":1,"capabilities":["asyncTasks"]}}}}}
```

The daemon records a successful initialization with that requested extension and
its verified adapter identity. There is no invented per-worker capability ack.
Neither standard `terminal: true`, the display name “Codex”, nor receipt of a
structured-looking frame is sufficient. Other adapter versions require review
before allowlisting. Claude and every other provider are unsupported in V1;
Claude 0.81.1 can emit the same spawn from typed SDK data and parsed tool prose.
The adapter's permitted Codex dependency range does not certify every resolved
Codex runtime. No extension is enabled by this documentation change.

Evidence reviewed at intentd `e7cf50288a4a948be10e7b0a1079dbee07be310e`:
Codex adapter published gitHead `b1b8490cd165c18626dc3fe83836cdacdef94cd3`,
`dist/index.js` SHA256
`4c1f6c00e67c2ace5a96f0e0fe6e812502a48827a403014d4b68373464f55fce`.
Its tracker consumes typed background-terminal lists; unchanged successful
reconciliation emits no heartbeat. Listing failure can also emit nothing.
The same `async_task_state_update` shape covers item failure and blanket
app-server failure (`finishAllAsyncTasks("failed")`); provider replacement emits
`stopped` before replacement. The wire exposes no cause or internal epoch.
These source observations explain the deliberately limited claims below.

#### Methods, ownership and fallback

| Method | Params | Result |
| --- | --- | --- |
| agent.workers.list | workspaceId (req), agentId (req) | `WorkerSnapshot` below; memory-only read, no provider calls |
| agent.workers.subscribe | workspaceId (req), agentId (req) | `{ subscriptionId }`, then `subscription.push` complete snapshots |

Both require existing workspace-read authority and an agent belonging to that
workspace. Agent callers additionally remain constrained by their existing
workspace scope; this surface grants no new cross-workspace authority. Validate
ownership before returning provider support, data or a subscription ID. Missing,
empty or malformed required IDs yield `-32602` with `data.code: "invalid-params"`.
An absent agent, inaccessible workspace or agent from another workspace yields
indistinguishable `-32602` with `data.code: "not-found"`; do not leak its existence.
Authority revocation tears down the subscription and the client clears its rows.
The client must clear the view on permission failure, not display a cached count.

Subscription creation is connection-local and atomically captures the initial
snapshot and registers subsequent changes. Ack precedes seq-0 snapshot; subsequent
frames use increasing safe-integer `seq` and `kind: "snapshot"`. Every frame is a
**complete replacement**, not a worker append or transcript delta. Use existing
`events.unsubscribe { subscriptionId, workspaceId }` for teardown; unknown or
another connection's ID returns `{ success: false }`. Disconnect drops it.
The [§6.9](../06-events.md#69-snapshotdelta-subscription-channels-new-in-intentd)
connection cleanup rules apply. V1 admits at most eight worker subscriptions per
connection; overflow returns `-32602` with `data.code: "capacity"` and creates no
subscription. Teardown releases the slot; this is not a limit on worker processes.

On reconnect, subscribe anew: seq starts at zero under a new subscription ID.
Only the currently acknowledged subscription may update the view; discard frames
with an old ID, duplicate or decreasing seq. The initial accepted seq must be zero.
A later seq gap is safe because the frame is a complete replacement. A list read
must not overwrite a newer subscribed view; use it only before subscription or
discard it once a subscription is accepted. No event replay cursor is promised.

The transient `agent:workers-changed` event carries `data: WorkerSnapshot` for
workspace-authorized firehose observers. The dedicated subscription is the UI's
canonical source; do not combine both streams. The event is not persisted for
`event.query`, does not trigger agent completion watches, and must not open chat
turns or alter agent/task/script status. Emit a replacement on accepted state,
support, continuity, capacity/eviction, generation or freshness changes. An
unchanged list read, replay or unrelated ACP event does not emit a worker change.

#### Snapshot and row shapes

`WorkerSnapshot` has these required fields:

| Field | Meaning |
| --- | --- |
| workspaceId, agentId, provider, acpSessionId, connectionGeneration | Trusted receiving scope; last two are `null` before an ACP session exists |
| support | `{ status: "supported" }`, `{ status: "unsupported", reason: "provider" \| "adapter-version" \| "not-negotiated" }`, or `{ status: "unavailable", reason: "no-session" \| "continuity-lost" }` |
| continuity | `continuous`, `disconnected`, or `lost` — observation channel, never worker health |
| asOf | Daemon projection time, integer Unix milliseconds; not worker evidence |
| freshnessMs | Exactly `60000` in V1 |
| truncated | Boolean, latched true once this generation loses rows or rejects an unseen ID for capacity; not a known total |
| workers | Array in admission order, at most 256 `WorkerObservation` rows; unsupported/no-session snapshots are empty |

Before a session exists, support is unavailable/no-session, continuity is lost,
truncated is false and workers is empty. Unsupported support reasons are selected
in order provider, adapter-version, not-negotiated. Unknown provider identity is
represented by the selected provider's configured ID, never guessed as Codex.

Each `WorkerObservation` contains:

| Field | Meaning |
| --- | --- |
| identity | `{ workspaceId, agentId, provider, acpSessionId, connectionGeneration, asyncTaskId }` — the full tuple is the key |
| toolCallId? | Optional exact originating tool correlation within this same scope; never a daemon terminal or script ID |
| name? | Untrusted plain-text label, control characters replaced by spaces and UTF-8 truncated to at most 512 bytes on a codepoint boundary |
| firstObservedAt | Receipt time of the first accepted frame for this identity |
| observedAt | Receipt time of its last **accepted distinct state**; duplicates and snapshots preserve it |
| providerState | `running`, `completed`, `failed`, or `stopped` |
| source | Exactly `codex-air` |
| cause | Exactly `unavailable`; no claim of user cancellation, command failure or successful exit |
| exitEvidence | Exactly `{ kind: "unknown" }` in this slice; an independently owned and correlated process-exit lane is a separate future contract |
| status | `running`, `completed`, `failed`, `stopped`, or `unknown`, derived below |
| freshUntil? | `observedAt + 60000` for providerState running only; preserved on every copy |
| unknownReason? | Required iff status unknown: `stale`, `disconnected`, or `lost` |

Every identity component and optional toolCallId is a nonempty string of at most
256 UTF-8 bytes without ASCII control characters. Invalid mandatory IDs reject
the frame atomically before allocating a ledger entry. Invalid supplied toolCallId
also rejects it; absent toolCallId remains valid. Optional unknown metadata is
ignored, never copied wholesale. No command output, processId, path, canStop or
showInTranscript field is projected; in particular an output path authorizes no read.
Timestamps are nonnegative safe integers; reject out-of-range values/overflow.

#### Freshness and provider ordering

At the live, authenticated receiving boundary, accept only the bound session's
`async_task_spawned` with `taskType: "shell"` (providerState running) and
`async_task_state_update` with state completed/failed/stopped. Paused and progress
are not supported by this slice. Reject cross-session frames, including unknown
child sessions, even when asyncTaskId has a plausible `threadId:itemId` prefix.
Workspace, agent, provider and generation come from the receiving context, not
payload claims. A provider ID alone is never a global worker key.

For a first live frame of a new identity, record receipt time. A terminal frame
before spawn creates a terminal-only row. A running row may transition once to a
terminal state and receive a new observedAt. Retain the original ingress timestamp
even when processing was delayed past a newer list read; reject a state frame
whose ingress timestamp precedes that row's accepted observation. **First terminal wins**: later spawn,
duplicate terminal and conflicting terminal frames cannot rewrite state, title,
correlation or timestamps. This conservative policy avoids inventing chronology
without an upstream sequence/epoch. It can retain a less precise earlier report.
Known transcript/history replay is never ingress, including an unseen ID. The
adapter cannot identify every undetectable upstream replay: a first frame on an
otherwise live connection is only a newly received provider report, not proof the
process currently exists. No adapter timestamp is fabricated.

For providerState running, status is unknown if continuity is disconnected/lost;
otherwise it is unknown/stale at **age >= 60000 ms**, running before that boundary.
Continuity takes precedence over age for unknownReason. Provider terminal rows
retain their reported status regardless of age, always with worker exit unknown.
Freshness expiry changes neither providerState nor observedAt. Schedule the expiry
transition even if no further provider traffic arrives. A still-running long task
can become unknown and may never be reconfirmed in this generation.

Use monotonic elapsed time anchored to daemon receipt time; retain a nondecreasing
projection clock. Client timers use daemon asOf plus monotonic time elapsed after
receipt, never a possibly skewed client wall clock. Clock rollback, view remount,
refetch, same-generation frontend reconnect, subscription snapshot and successful
unchanged reconciliation cannot reset observedAt/freshUntil or promote stale rows.
A disconnected frontend locally shows running rows as unknown/disconnected until
a new snapshot; that snapshot still carries the original evidence deadline.

#### Generation, continuity and bounded retention

connectionGeneration is a fresh daemon-minted opaque token for each **outer ACP
connection initialization**. A frontend reconnect does not change it. Replacement
of Codex's internal app-server may retain ACP session and connection: do not invent
a new generation or an observed process exit in response to failed/stopped frames.
Internal epochs, PID recovery and globally unique provider task IDs are unavailable.

Outer provider disconnect immediately marks live rows unknown/disconnected. A
purported same-generation resume without guaranteed ingest continuity marks them
unknown/lost and support unavailable/continuity-lost; it cannot admit frames until
a real new outer initialization. Losing projection state is the same failure, not
permission to recreate it from list snapshots or transcript replay. An in-memory
handoff may restore the exact rows, seen-ID ledger, clock and continuity unchanged.
That checkpoint is internal model state, not an additional wire/persistence API.
Daemon restart requires a real new initialization; no cached old row becomes live.

Each scoped generation admits at most **1024 distinct asyncTaskIds**, retaining
at most **256 rows**. On row overflow, evict the oldest admitted row regardless of
state; never claim its process ended. Retain its seen-ID tombstone until generation
end, so repeated spawn or terminal frames cannot recreate it. When the ledger
fills, reject unseen IDs and latch truncated; existing retained running rows can
still receive their terminal transition. A new generation atomically clears old
rows, tombstones and the truncated flag; old-generation frames are rejected before
allocation. The empty new snapshot means “no observations yet”, not “zero running
processes”. A fresh frame in the new generation may reuse a provider ID but is a
different identity. Session/agent disposal releases the bounded projection. No
unbounded pending-state, marker cache, historical generation archive or process scan
is introduced. List is O(retained rows), never a provider reconciliation call.

#### Tool-marker regression boundary

Codex sends this before its worker announcement:

```json
{"sessionUpdate":"tool_call_update","toolCallId":"call-A","_meta":{"jetbrains":{"air":{"asyncTasks":{"backgrounded":true}}}}}
```

Consume this **metadata-only** marker before generic tool mapping can default an
absent status to started. No row, transcript block, turn, busy flag or tool state
may be created/changed from the marker alone. An existing completed/error tool and
its output remain unchanged after marker and spawn. Duplicate/idle/missing-followup
markers have no effect. No pending hint cache is needed for V1: spawn carries its
own correlation. The subsequent validated spawn creates a separate worker row.

For a mixed marker with explicit status/title/kind/rawInput/rawOutput/content/locations,
retain all genuine tool fields and their ordinary processing. Only an **explicit**
status may change tool status; recognizing background metadata must not discard
real data or synthesize a started state. The marker's handling gives no worker
liveness credit. Parent-turn cancellation, tool completion, stop acknowledgement,
terminal-output metadata and unrelated traffic never settle or refresh workers.

#### Delivery split and required implementation proof

Land this additive contract before daemon adoption, then implement the bounded
daemon parser/projection and real WSS list/subscription/ownership tests. Only then
land the frontend selected-agent list, using dedicated subscriptions, explicit
unsupported/loading/error/unknown states, evidence age and optional tool links.
Show “provider reported failed/stopped; worker exit unknown”; even completed is
provider completion, never exit zero. A truncated or unavailable view cannot make
an exhaustive running-count claim. No runtime support is certified by these model tests.

Coordinate runtime edits with [terminal replay PR](https://github.com/intent-hq/intentd/pull/2193),
[transcript PR](https://github.com/intent-hq/cloudlands-fe/pull/2875) and
[script history PR](https://github.com/intent-hq/cloudlands-fe/pull/3041)
(workspaces-littered). Provider worker identity/output is separate from daemon PTY
replay cursors and saved-script history. This milestone changes none of those paths.

`make check-agent-worker-contract` runs goldens, model regressions and deliberate
mutation sensitivity checks. Runtime acceptance additionally requires real parser
and live/idle dispatch regression tests, exact WSS envelopes and cross-workspace
revocation, expiry scheduling, atomic subscribe/initialization races and bounded
memory tests; frontend mock-wire/reducer, reconnect, keyboard/accessibility and
browser checks follow. No paid provider sessions or arbitrary output-file reads
are prerequisites for the synthetic checks. Human merge permission is separate.
