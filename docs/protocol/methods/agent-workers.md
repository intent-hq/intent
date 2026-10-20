> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.5b Worker observations (prepared additive extension).

### 5.5b Provider worker observations and stop

**Prepared, not implemented by the pinned components.** This contract defines a
bounded projection of provider reports about background work (shell commands,
and for Claude also workflows and monitors) plus a provider-mediated stop
request. It is not a process monitor: it adds no output reader, filesystem
access, heartbeat, process-exit guarantee or worker-count contribution to
parent-agent activity. Implementing it in the daemon and frontend is intended to
close issue #851.
The [executable model](../../../scripts/agent-worker-contract.mjs) and
[goldens](../fixtures/agent-workers/v1/corpus.json) are synthetic specification
examples, not captured sessions or certification of live provider behavior.

#### Negotiation and evidence boundary

A future daemon advertises `server.capabilities.agentWorkers: 1` in
[client.hello](./client-hello.md) only after implementing the complete contract,
including `agent.workers.stop`. A client without that flag shows **unavailable**
and does not call these methods. An unexpected `-32601` after advertisement also
falls back to unavailable; do not poll other methods or infer support from
protocol version or catalog presence.

Server support is distinct from support for the selected provider session. V1
allows exactly these reviewed adapter pins, each with the AIR extension
requested in ACP initialize:

| Provider ID | Adapter | Version | Row `source` |
| --- | --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` | **2.2.2** | `codex-air` |
| `claude-code` | `@agentclientprotocol/claude-agent-acp` | **0.81.1** | `claude-air` |

The table matches the **base** provider ID: a provider profile reference such as
`claude-code@work` uses the part before `@` for support, source and task-type
rules, while row identity and the snapshot keep the full reference.

```json
{"clientCapabilities":{"_meta":{"jetbrains":{"air":{"version":1,"capabilities":["asyncTasks"]}}}}}
```

The daemon merges this object into any other `clientCapabilities._meta` keys it
already sends; it never replaces them. It records a successful initialization
with that requested extension and its verified adapter identity. There is no
invented per-worker capability ack. Neither standard `terminal: true`, a display
name, nor receipt of a structured-looking frame is sufficient. Other adapter
versions and providers require review before allowlisting. The adapter's
permitted dependency range does not certify every resolved runtime.

Requesting the extension is not free for Codex: codex-acp treats any client that
sends `_meta.jetbrains.air` as an AIR client and switches its general tool-call
rendering (legacy standard-field overrides, command output and permission
metadata) to the AIR form. A daemon must not request the extension from Codex
until its Codex tool-call mapping is proven against that form. For Claude the
extension is gated per capability and changes nothing else. No extension is
enabled by this documentation change.

Evidence reviewed from the published npm packages (no `gitHead` is published):
codex-acp 2.2.2 `dist/index.js` SHA256
`6b1bb4e7e9caaf4aeca1042ae4aec2dc2433b0b0e4b1614b38a4d41699902aaa`;
claude-agent-acp 0.81.1 `dist/acp-agent.js` SHA256
`fdc6fdd16d47eac5ae1998b40aaccf1e675431fbe66c0ab064f4592dcdd1d8e3` and
`dist/async-tasks.js` SHA256
`2040c18b05ccf4b89c98a69623307201b95b81d7b470e376a5a62d93439b3f06`.
Codex's tracker consumes typed background-terminal lists and emits only
`taskType: "shell"`; unchanged successful reconciliation emits no heartbeat and
listing failure can emit nothing. The same `async_task_state_update` shape
covers item failure and blanket app-server failure; provider replacement emits
`stopped` before replacement. Claude reports SDK background tasks (`shell`,
`workflow`, `monitor`, or another task type) and excludes subagents itself; a
replace-semantics task level can end a task as `stopped` before its
authoritative completion arrives. Neither wire exposes a cause or internal
epoch. Both adapters answer `_session/async_task/stop` with `{ stopped }` and
publish the terminal `stopped` frame before that answer. These source
observations explain the deliberately limited claims below.

#### Methods, ownership and fallback

| Method | Params | Result |
| --- | --- | --- |
| agent.workers.list | workspaceId (req), agentId (req) | `WorkerSnapshot` below; memory-only read, no provider calls |
| agent.workers.subscribe | workspaceId (req), agentId (req) | `{ subscriptionId }`, then `subscription.push` complete snapshots; a fast-path method (per-connection state), not a router method |
| agent.workers.stop | workspaceId (req), agentId (req), connectionGeneration (req), asyncTaskId (req) | `{ asyncTaskId, stopped }`; see Stop below |

List and subscribe require existing workspace-read authority and an agent
belonging to that workspace. Stop requires the same authority as `agent.stop`
for that agent; read authority alone never confers it. Agent callers
additionally remain constrained by their existing workspace scope; this surface
grants no new cross-workspace authority. Validate ownership before returning
provider support, data, a subscription ID or a stop decision. Missing, empty or
malformed required IDs yield `-32602` with `data.code: "invalid-params"`. An
absent agent, inaccessible workspace, agent from another workspace, or a stop
caller without control authority yields indistinguishable `-32602` with
`data.code: "not-found"`; do not leak existence.
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
Only the currently acknowledged subscription may update the view. Its ID must be
a nonempty string of at most 256 UTF-8 bytes without ASCII control characters; a
malformed acknowledgement leaves the existing binding and sequence untouched.
Before acknowledgement or after disconnect, reject every push, including one
with a null/missing ID. Discard frames with an old ID, duplicate or decreasing seq.
The initial accepted seq must be zero.
A later seq gap is safe because the frame is a complete replacement. A list read
must not overwrite a newer subscribed view; use it only before subscription or
discard it once a subscription is accepted. No event replay cursor is promised.

The transient `agent:workers-changed` event carries `data: WorkerSnapshot` for
workspace-authorized firehose observers. The dedicated subscription is the UI's
canonical source; do not combine both streams. The event is not persisted for
`event.query`, does not trigger agent completion watches, and must not open chat
turns or alter agent/task/script status. Emit a replacement on accepted state,
support, continuity, capacity/eviction or generation changes. An unchanged list
read, replay, stop decision or unrelated ACP event does not emit a worker change.

#### Stop

`agent.workers.stop` asks the provider to stop one worker without cancelling the
agent's turn. The caller passes the row's `identity.connectionGeneration`
because a provider may reuse a task ID in a new generation: after authorization
(above), a generation other than the current one, or an unknown `asyncTaskId`
in it, yields `-32602` with `data.code: "not-found"`, so a stale row can never
stop a different worker. The daemon then decides without changing any row:

- It answers `{ asyncTaskId, stopped: false }` **without a provider call** when
  support is not `supported`, continuity is not `continuous`, the row's
  providerState is not `running`, or the row's `canStop` is false.
- Otherwise it sends exactly one ACP request
  `_session/async_task/stop { sessionId, asyncTaskId }` on the connection of
  the generation it decided on and answers `{ asyncTaskId, stopped }`, where
  `stopped` is true only for an exact provider `{ stopped: true }`; any other
  answer, including a malformed one, is `false`.
- If that connection has disconnected or been replaced before the request is
  written, the daemon sends nothing. That case, and a provider JSON-RPC error,
  timeout or connection loss during the request, yields `-32603` with
  `data.code: "provider-error"`; the row is unchanged.

The stop answer is not worker evidence: only the provider's own
`async_task_state_update` ends a row, normally `stopped`, which both reviewed
adapters publish before answering. A concurrent duplicate stop is answered
`stopped: false` by the provider. Clients show a pending state while the request
is in flight and leave the row to the next snapshot.

#### Snapshot and row shapes

`WorkerSnapshot` has these required fields:

| Field | Meaning |
| --- | --- |
| workspaceId, agentId, provider, acpSessionId, connectionGeneration | Trusted receiving scope; last two are `null` before an ACP session exists |
| support | `{ status: "supported" }`, `{ status: "unsupported", reason: "provider" \| "adapter-version" \| "not-negotiated" }`, or `{ status: "unavailable", reason: "no-session" \| "continuity-lost" }` |
| continuity | `continuous`, `disconnected`, or `lost` — observation channel, never worker health |
| asOf | Daemon projection time, integer Unix milliseconds; not worker evidence |
| truncated | Boolean, latched true once this generation loses rows or rejects an unseen ID for capacity; not a known total |
| workers | Array in admission order, at most 256 `WorkerObservation` rows; unsupported/no-session snapshots are empty |

Before a session exists, support is unavailable/no-session, continuity is lost,
truncated is false and workers is empty. Unsupported support reasons are selected
in order provider, adapter-version, not-negotiated. Unknown provider identity is
represented by the selected provider's configured ID, never guessed.

Each `WorkerObservation` contains:

| Field | Meaning |
| --- | --- |
| identity | `{ workspaceId, agentId, provider, acpSessionId, connectionGeneration, asyncTaskId }` — the full tuple is the key |
| toolCallId? | Optional exact originating tool correlation within this same scope; never a daemon terminal or script ID |
| name? | Untrusted plain-text label, control characters replaced by spaces and UTF-8 truncated to at most 512 bytes on a codepoint boundary |
| taskType? | Untrusted plain-text provider task type from the spawn (`shell` for Codex; e.g. `shell`, `workflow`, `monitor` for Claude): control characters replaced by spaces, truncated to 64 bytes, then trimmed; absent on a terminal-only row |
| canStop | Boolean; true only when the spawn carried exactly `canStop: true`; false for terminal-only rows |
| firstObservedAt | Receipt time of the first accepted frame for this identity; clients show "started X ago" from it |
| observedAt | Receipt time of its last **accepted distinct state**; duplicates and snapshots preserve it |
| providerState | `running`, `completed`, `failed`, or `stopped` |
| source | `codex-air` or `claude-air`, from the receiving provider (table above) |
| cause | Exactly `unavailable`; no claim of user cancellation, command failure or successful exit |
| exitEvidence | Exactly `{ kind: "unknown" }` in this slice; an independently owned and correlated process-exit lane is a separate future contract |
| status | `running`, `completed`, `failed`, `stopped`, or `unknown`, derived below |
| unknownReason? | Required iff status unknown: `disconnected` or `lost` |

Every identity component and optional toolCallId is a nonempty string of at most
256 UTF-8 bytes without ASCII control characters. Invalid mandatory IDs reject
the frame atomically before allocating a ledger entry. Invalid supplied toolCallId
also rejects it; absent toolCallId remains valid. Optional unknown metadata is
ignored, never copied wholesale. No command output, processId, path or
showInTranscript field is projected; in particular an output path authorizes no read.
Timestamps are nonnegative safe integers; reject anything else.

#### Liveness and provider ordering

At the live, authenticated receiving boundary, accept only the bound session's
`async_task_spawned` (providerState running) and `async_task_state_update` with
state completed/failed/stopped. Judge `taskType` only after sanitizing it as in
the row table: a Codex spawn's must be `shell`; a Claude spawn's must be nonblank
and neither `agent` nor `local_agent` (subagents are agent sessions, not
workers). Non-terminal state
updates (`running`, `paused`) and `async_task_progress` are not supported by this
slice and change nothing. Reject cross-session frames, including unknown child
sessions, even when asyncTaskId has a plausible `threadId:itemId` prefix.
Workspace, agent, provider and generation come from the receiving context, not
payload claims. A provider ID alone is never a global worker key.

For a first live frame of a new identity, record receipt time. A terminal frame
before spawn creates a terminal-only row. A running row may transition once to a
terminal state and receive a new observedAt. Retain the original ingress timestamp
even when processing was delayed past a newer list read; reject a state frame
whose ingress timestamp precedes that row's accepted observation. **First terminal wins**: later spawn,
duplicate terminal and conflicting terminal frames cannot rewrite state, title,
correlation or timestamps. This conservative policy avoids inventing chronology
without an upstream sequence/epoch. It can retain a less precise earlier report
(for example Claude's best-effort `stopped` before a late `completed`).
Known transcript/history replay is never ingress, including an unseen ID. The
adapter cannot identify every undetectable upstream replay: a first frame on an
otherwise live connection is only a newly received provider report, not proof the
process currently exists. No adapter timestamp is fabricated.

**Running means "announced and not reported ended".** Neither adapter sends a
heartbeat, so evidence age never demotes a row: a long-running dev server stays
`running` for as long as the provider connection is continuous. For
providerState running, status is unknown only when continuity is disconnected or
lost, with that continuity as unknownReason. Provider terminal rows retain their
reported status, always with worker exit unknown. Clients may show how long ago
the worker started (firstObservedAt) but must not present it as a liveness check.

The accepted cost of no staleness: a worker whose end report never arrives (for
example a lost Codex terminal-list reconciliation) stays `running` until the
provider connection ends. Codex's own list reconciliation and Claude's task
level normally end such rows, a Stop on one returns `stopped: false` from the
provider, and a new generation clears it. No daemon-side process scan is added.

Retain a nondecreasing daemon projection clock; clock rollback cannot rewind
asOf or observation times. View remount, refetch, same-generation frontend
reconnect, subscription snapshot and successful unchanged reconciliation cannot
reset observedAt. A disconnected frontend locally shows running rows as
unknown/disconnected until a new snapshot arrives.

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
at most **256 rows**. On row overflow, evict the oldest admitted row whose
providerState is terminal; only when no retained row has ended, evict the oldest
running row. Never claim an evicted worker's process ended. Retain its seen-ID tombstone until generation
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

Both adapters send this before or with their worker announcement:

```json
{"sessionUpdate":"tool_call_update","toolCallId":"call-A","_meta":{"jetbrains":{"air":{"asyncTasks":{"backgrounded":true}}}}}
```

Consume this **metadata-only** marker before generic tool mapping can default an
absent status to started. No row, transcript block, turn, busy flag or tool state
may be created/changed from the marker alone. An existing completed/error tool and
its output remain unchanged after marker and spawn. Duplicate/idle/missing-followup
markers have no effect. No pending hint cache is needed for V1: spawn carries its
own correlation. The subsequent validated spawn creates a separate worker row.

For a mixed marker with explicit status/title/kind/rawInput/rawOutput/content/locations
(Claude attaches the marker to the tool result update), retain all genuine tool
fields and their ordinary processing. Only an **explicit** status may change
tool status; recognizing background metadata must not discard real data or
synthesize a started state. The marker's handling gives no worker liveness
credit. Parent-turn cancellation, tool completion, stop answers, terminal-output
metadata and unrelated traffic never settle or refresh workers.

#### Delivery split and required implementation proof

Land this additive contract before daemon adoption, then implement the bounded
daemon parser/projection, the stop request and real WSS
list/subscription/stop/ownership tests. Enable the extension for Claude with
that daemon change; enable it for Codex only together with its AIR tool-call
mapping. Only then land the frontend selected-agent rows, using dedicated
subscriptions, explicit unsupported/loading/error/unknown states, started time,
optional tool links and a Stop action shown only for running rows with
`canStop`. Show “provider reported failed/stopped; worker exit unknown”; even
completed is provider completion, never exit zero. A truncated or unavailable
view cannot make an exhaustive running-count claim. No runtime support is
certified by these model tests.

Coordinate runtime edits with [terminal replay PR](https://github.com/intent-hq/intentd/pull/2193),
[transcript PR](https://github.com/intent-hq/cloudlands-fe/pull/2875) and
[script history PR](https://github.com/intent-hq/cloudlands-fe/pull/3041)
(workspaces-littered). Provider worker identity/output is separate from daemon PTY
replay cursors and saved-script history. This milestone changes none of those paths.

`make check-agent-worker-contract` runs goldens, model regressions and deliberate
mutation sensitivity checks. Runtime acceptance additionally requires real parser
and live/idle dispatch regression tests, exact WSS envelopes (including the stop
request forwarded to the provider) and cross-workspace revocation, atomic
subscribe/initialization races and bounded memory tests; frontend
mock-wire/reducer, reconnect, keyboard/accessibility and browser checks follow.
No paid provider sessions or arbitrary output-file reads are prerequisites for
the synthetic checks. Human merge permission is separate.
