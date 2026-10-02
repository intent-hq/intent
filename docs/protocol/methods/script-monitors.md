> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.8a Script run monitors (prepared additive extension).

### 5.8a Script run monitors

**Prepared contract, not implemented by the pinned components.** Advertise
`client.hello.server.capabilities.scriptMonitors: 1` only when the entire contract,
including durable identity, output triggers, lifecycle cleanup, queue deduplication
and MCP helpers, is implemented. Allocate the next additive minor against daemon main then.
This flag is independent of `scriptLifecycle` and `scriptReadiness`. Without it,
clients hide monitor controls and do not call these methods. Unexpected `-32601`
also disables them for that connection. Existing script operations and explicit
polling hooks remain available; do not silently install a hook as a fallback.

#### Surfaces and authority

Registration is agent-authored, MCP-only, following §6.8; no wire registration
method or client-supplied owner is added. All helpers use the caller's workspace
and authenticated agent identity, including chief callers (no scope escape).

| Agent helper | Result |
| --- | --- |
| `ws.script.monitor(scriptId, { ttlMs, runId?, outputPattern?, lineCount? })` | `{ ok: true, monitor }` or the refusal below; nonblocking registration, never starts or waits for a process |
| `ws.script.monitors()` | `ScriptMonitor[]`, caller's active and retained terminal rows |
| `ws.script.unmonitor(monitorId)` | `{ ok: true, monitor }`; stops observation silently, never the process |

`ttlMs` is **required**, an integer in `[1, 86400000]` (at most 24 hours).
Missing, null, fractional, zero, negative, nonnumeric or larger values fail
with `-32602`; no clamping/default. `runId`, when provided, is a nonempty opaque
string. Validation precedes any mutation, including on an idempotent retry.
A valid retry never changes the original deadline, run binding, output window or
options. Optional `outputPattern` and `lineCount` are validated before retries
too; their exact syntax, limits and framing are defined below.

| Method | Params | Result |
| --- | --- | --- |
| scriptMonitor.list | workspaceId (req), agentId? | `{ monitors: ScriptMonitor[] }`; all retained workspace rows, optionally filtered to an owner |
| scriptMonitor.cancel | workspaceId (req), monitorId (req) | `{ ok: true, monitor }`; stop observation silently, same transition as the owner helper |
| scriptMonitor.cancelRun | workspaceId (req), monitorId (req) | `{ ok: true, monitor, runStopped: boolean }`; stop only the active monitor's bound run and notify its owner |

List requires workspace read authority; both mutations require the existing
workspace script-control authority. A monitor belongs to exactly one workspace;
foreign IDs are indistinguishable from unknown IDs (`-32602`). The agent helper
can cancel only its own monitor; otherwise `-32602` names the existing owner.
Wire callers may control another agent's monitor within their authorized
workspace, like existing hook/PR controls. Unknown owners in list filters return
an empty list; no agent metadata from another workspace is exposed.

A fresh registration requires an existing, nondeleted, nonretired owner in an
active workspace. A failed/inert owner cannot register. A temporarily busy,
question-held or idle owner is eligible. Lifecycle/read/persistence errors fail
closed; never return success for a memory-only registration. There is one active
monitor per **(workspaceId, scriptId)**, irrespective of runId. Registration and
retirement enforce this atomically, including concurrent calls and recovery.
Same-owner registration returns the existing active row, with no extra event or
wake; an explicitly different runId is rejected (`-32602`), never rebound.
A different owner's request returns this ordinary result, without a second row:

```json
{"ok":false,"refused":true,"reason":"already-monitored","ownerAgentId":"agent-a","ownerAgentName":"Builder","monitorId":"monitor-a","workspaceId":"ws-a","scriptId":"check","runId":"run-a","instruction":"Ask the owner to relay results or stop monitoring before registering."}
```

`ownerAgentName` is omitted when unknown. All other keys above are required;
`instruction` is human-readable, not a discriminator. There is **no adoption or
parent takeover** in v1, unlike PR monitors: lifecycle cleanup releases ownership.
A different script ID or workspace does not contend for this ownership slot.

#### Run identity and fast completion

Add `runId?: string` to `script.start` / `script.restart` replies and to
`ScriptRuntimeState` (`script.status`, list runtime, `script:state`). Supporting
daemons always return runId when a run is accepted or an already-live start is
a no-op. Runtime carries the latest accepted runId until definition replacement
or removal; it remains present after exit, stop, archive and marker dismissal.
A never-started definition omits it. Add `runId?` to `lastRun` for newly settled
command runs; do not invent IDs for legacy results. Unset fields are omitted,
never null. No existing status, lastRun outcome or script.run response changes.

A runId is a durable, nonreused opaque token allocated **before acceptance**, not
a pid, startedAt timestamp, daemon boot ID or in-memory generation. Persist the
latest admitted token for both command and service scripts. The current command
admission token can be reused; services need equivalent durable admission.
In-memory generation checks still fence supervisors and definition replacements.
The logical run includes its launch reservation, startup and teardown. For a
service it includes every automatic respawn under the same supervisor; a brief
`exited` event before automatic backoff is not a final result. Readiness never
settles a monitor. Output may consume a monitor through its explicit optional
triggers below; that does not end the run. A **run-finished**
result settles only when the supervisor has made its final retry decision and
released process ownership (including exhausted/too-fast exits).

An explicit manual restart settles the old run before admitting a **new** token;
if the predecessor is unfinished its outcome is `cancelled`, otherwise retain its
already-recorded result. A no-op start on a live run retains its token. Service
restoration after daemon restart admits a new run, never continues the old one.
Upsert/remove settle any unfinished predecessor as `cancelled` with an error
naming replacement/removal before discarding its definition. Ordinary script
archive/restore does not change a run or monitor; workspace archive is different.

Registration without runId binds atomically to the **latest accepted run** at
registration, including a retained final result after a fast exit or stop. It
must not infer completion from status `idle` alone. A never-run script, a legacy
result without a token, or an unavailable explicit run fails `-32602` with no
monitor. To avoid binding a concurrent successor, pass runId from start/restart.
An explicit ID must be the current/latest retained run, or the caller's retained
completed monitor binding (returned idempotently); no historical run lookup
service is added. Once bound, a monitor
keeps its own identity/result even if the definition is removed or replaced.

A fresh registration against an already-final run durably creates and completes
one monitor immediately, queues its one wake, and returns that terminal row.
While retained, repeating registration for the same owner/run whose monitor
**completed** returns that row without another wake. Active ownership is checked
first, so another owner's active monitor is still refused. After `expired`, `triggered` or
`cancelled`, explicit registration creates a fresh watch with a fresh TTL and
new-output window; this
is the intentional re-arm boundary, not an extension of the old watch. A missing
runId cannot recover an older run after a successor is admitted. Retained-row
idempotency ends when that row is pruned; it is not permanent request deduplication.

#### Canonical row and terminal result

`ScriptMonitor` is the identical full object returned by helpers, wire methods
and lifecycle events. List order is ascending `(createdAt, monitorId)`.

| Field | Type and meaning |
| --- | --- |
| monitorId, workspaceId, agentId, scriptId, runId | Required nonempty strings; immutable identity and owner |
| scriptName | Required string; name captured at registration, for display even after removal |
| mode | Required `command` or `service`, captured at registration |
| state | Required `active`, `completed`, `expired`, `triggered`, or `cancelled` |
| outputPattern, lineCount | Optional immutable trigger configuration, present only when supplied and validated below |
| createdAt, expiresAt | Required RFC 3339 UTC timestamps; expiresAt = createdAt + accepted ttlMs |
| settledAt | RFC 3339 UTC timestamp; required on terminal rows, absent on active rows |
| reason | Required on terminal rows: `finished` for completed, `ttl-expired` for expired; triggered uses `output-match` or `line-count`; cancelled uses `unmonitored`, `owner-deleted`, `owner-retired`, `workspace-archived`, or `workspace-deleted`; absent while active |
| result | Required only on completed rows: compact `ScriptMonitorResult` below; omitted otherwise |
| trigger | Required only on triggered rows: `{ observedLineCount, matchedLine? }`; observedLineCount is an integer, matchedLine is required (including empty string) only for output-match and omitted for line-count |

`ScriptMonitorResult` has required `outcome` (`succeeded`, `failed`, `cancelled`,
`interrupted`) and `stoppedAt`, and optional `exitCode`, `startedAt`, `error`.
Times are RFC 3339 UTC. This is the existing compact command lastRun meaning,
also available for services, without a run history/output ledger. `succeeded`
requires exitCode 0 and no error; nonzero process exit is `failed`. A spawn failure
is `failed` with exitCode -1 and error. A lost exit/daemon interruption is
`interrupted` with exitCode -1 and error. The sentinel -1 is never an observed
process code. Cancellation before launch omits startedAt and exitCode; after
launch preserve the observed code if any, never fabricate 0 or -1 for cancellation.
Cancellation includes an error describing user stop, timeout, replacement or
removal. A completed monitor can therefore have result.outcome `cancelled`;
monitor state `cancelled` means observation ended without a result wake.
Completion/TTL/cancellation rows and wakes contain no output. The sole output
exception is one bounded `trigger.matchedLine` on an opt-in regex trigger, also
present in its lifecycle snapshot; it is untrusted script text. No full stdout,
stderr, output buffer, command text, environment, cwd or scrollback is included. Read output explicitly via script.output;
existing output lifetimes still apply and bytes may belong to a newer run.

#### Optional output triggers and line framing

`outputPattern?: string` is a **single-line regular expression**, not a substring
or JavaScript regex object. `lineCount?: integer` is in `[1, 1000000]`. Either or
both may be supplied. They are OR conditions alongside run completion/failure and
mandatory TTL; the **first qualifying event consumes the monitor**, wakes once,
and leaves the script running. To continue observation explicitly register again.
No polling, callback code, repeat flag, readiness latch or recurring wake is added.

Reject null/wrong types, an empty pattern, patterns over **1024 UTF-8 bytes**,
literal CR/LF in a pattern, invalid regex syntax, unsupported constructs and
out-of-range/noninteger lineCount with `-32602` before mutation. Use the Rust
`regex` crate's Unicode, case-sensitive syntax with its normal inline flags;
lookaround and backreferences are unsupported. Match/search the normalized whole
line, never concatenate lines; anchors refer to that one line. Compilation must
use a **1 MiB compiled-size limit, 1 MiB DFA cache limit and nesting limit 128**;
limit failures reject registration. Use a finite-automata, nonbacktracking engine
with bounded compilation; do not run user regexes in JavaScript's backtracking
engine or shell tools. Regex compile diagnostics must not include script output.
`^$` may match an empty line; an unanchored pattern searches within a line.

**Fresh window.** Observe the PTY's combined stdout/stderr bytes **accepted by the
daemon after registration**, scoped to workspace, definition generation, runId
and process attempt. Establish the cursor atomically with registration under the
run's output/admission ordering. Do not replay existing scrollback, attachment
backlogs or bytes already admitted but waiting for processing. If a logical line
was already in progress, discard its remainder through the next delimiter; its
suffix neither matches nor counts. If registration is at a line boundary, the
next empty or nonempty line qualifies. An active same-owner retry preserves the
window/count; after a trigger, rearming resets the count to zero and starts a new
window with the same boundary rule. Service automatic respawns stay in the run,
but reset the decoder/partial-line state between attempts, never join attempts'
fragments. Supervisor separator/status messages are not process output.

**Normalization.** Use a streaming UTF-8 decoder across chunks; replace invalid
sequences with U+FFFD; preserve U+FEFF as ordinary text. Strip ANSI CSI sequences (ESC `[` through final byte
0x40–0x7e), OSC (ESC `]` through BEL or ST), and DCS/SOS/PM/APC (ESC `P`/`X`/`^`/`_`
through ST, ESC followed by backslash). Preserve decoder/control state across
chunk boundaries. Strip other ESC sequences and C0/C1 controls except HT, CR and
LF; preserve HT. Do not simulate cursor motion or backspace editing. Strip control
strings incrementally without retaining their contents; incomplete controls are
discarded at EOF. Control bytes inside an ANSI string do not delimit text lines.

CR or LF ends a logical line; a CRLF pair is **one delimiter**, even split across
chunks. Consecutive nonpaired delimiters produce empty lines. Bare CR progress
updates therefore count as separate lines. Delimiters are not in matchedLine.
Only complete logical lines are evaluated while the process is live; do not fire
on a partial match. At each process attempt's actual EOF, flush one **nonempty**
normalized trailing partial line before that attempt's final-exit decision. There
is no extra line after a trailing delimiter and no flush on TTL, unmonitor,
lifecycle cleanup, output loss, or rearm. After EOF, never accept late bytes from
that attempt; automatic respawn starts clean. A cancel-run intent that has already
won arbitration suppresses competing output, including an EOF partial flush.

**Bounds and loss.** Retain at most **4096 normalized UTF-8 bytes per line** plus
constant-sized decoder/control state. An overlong line is discarded for regex
matching (never match a truncated prefix), but counts as one observed line at
its delimiter/EOF. Do not retain an output ledger. Count normalized logical lines,
including empty/overlong ones, from zero, saturating at 2147483647; thresholds
are at most one million, so count-trigger wakes report exactly lineCount. Regex
wakes report the count at the matching line, including that line. A stream gap or
lag discards the current partial line and skips through the next delimiter to
regain framing; previously counted complete lines remain counted. Missing lines
are not invented, and buffered scrollback never fills the gap: observedLineCount
is the count actually observed, not the process's total. No match may bridge a gap.

Process at most 16 KiB of input or 64 framed lines per scheduling slice, then
yield while preserving order. Use the existing bounded PTY stream, not an
unbounded per-monitor queue; handle its lag indication as the gap rule above.
An overlong control string needs only parser state, not a growing buffer.
Completion/TTL/cleanup must remain schedulable under sustained output. A monitor
without either output option does not accumulate line text or count.

Example agent use (prepared helper, same mandatory TTL in every case):

```javascript
const { scriptId, runId } = await ws.script.start("checks");
await ws.script.monitor(scriptId, { ttlMs: 600000, runId, outputPattern: "^Ready on .+$", lineCount: 200 });
```

A regex trigger produces state `triggered`, reason `output-match`, and
`trigger: { observedLineCount: 7, matchedLine: "Ready on port 3000" }`.
A threshold trigger produces state `triggered`, reason `line-count`, and
`trigger: { observedLineCount: 200 }`. Neither has result/exitCode or asserts that
the script finished. Both release ownership and active waiting state. The FE may
show the configured conditions and winning reason; output remains opt-in except
for the requested single matching line.

#### Terminal arbitration and safe cancellation

Completion, output triggers, expiry, observation cancellation and run cancellation
serialize against run admission/replacement and lifecycle teardown. They compete for one
persisted active-to-terminal transition. Duplicate callbacks, restart recovery,
reconnects and repeated cancel requests cannot emit a second logical wake.
Terminal mutations return the retained row unchanged; `cancelRun` then reports
runStopped false and does not touch any process (including a run still live after
TTL expiry or an output trigger). To stop that process use explicit script
controls or re-arm first.

Expiry examines the bound run in the same arbitration step. If its final result
was already durably recorded, completion wins; otherwise at/after expiresAt the
monitor expires and wakes once, **leaving the script running**. No renewed TTL or
automatic re-registration. A delayed timer cannot replace an already-final row.
All run inputs/control operations enter one serialization order, not UI/event-bus
arrival order. Before considering a new input: apply lifecycle fencing, honor an
already-reserved cancellation/terminal transition, then use any **previously
durable** final result, then expire if now is at/after expiresAt. At the exact TTL
boundary, newly considered output/completion/cancel inputs therefore lose to TTL;
an earlier durable result still wins. Before the deadline, process admitted output
in byte/line order. On the **same line**, regex wins over lineCount; otherwise the
first qualifying line wins. Flush an eligible EOF partial before considering a
new final-run result, so an EOF match wins over that completion. User cancel and
other inputs compete by this same admission order; a committed cancellation
intent excludes later output/expiry. These priorities are deterministic for a
given ordered input stream, independent of how chunks or UI events are delivered.

`cancelRun` must atomically compare the bound durable token and definition
generation **before** requesting stop under the same admission exclusion used by
restart/upsert/remove. Never implement it as status-read followed by script.stop.
It cancels startup reservations as well as spawned processes, disables service
auto-restart, waits for the owned teardown, then returns the settled completed
monitor with a cancelled result and runStopped true. Persist cancellation intent
before side effects so a crash cannot lose the run binding or later stop a
successor. Once that intent wins arbitration it reserves the terminal decision:
expiry and exit callbacks cannot substitute another outcome during teardown.
On a stop failure, release/reconcile that reservation without claiming success.
If natural completion won first, return its result and runStopped false.
A stale binding reconciles its predecessor's captured result (or `interrupted`
with -1 and an explanatory error if it was lost), returns runStopped false, and
never signals the replacement. A stop failure must not claim cancellation:
return an RPC error and retain/reconcile the watch. The user can retry safely.
Owner unmonitor and wire cancel stop observation only, silently, even if a
process is still running; they release ownership and waiting-state deferrals.

#### Events, wake queue and agent waiting state

New event types: `scriptMonitor:registered`, `scriptMonitor:completed`,
`scriptMonitor:expired`, `scriptMonitor:triggered`, `scriptMonitor:cancelled`. Use the §6.3 workspace envelope,
actor `system`, and **data `{ monitor: ScriptMonitor }`** with the full committed
row. Registration emits once (active snapshot); fast completion follows it with
the completed snapshot. Every successful terminal transition emits exactly one
corresponding event, including silent cleanup (workspace deletion may drop events
with the workspace). No per-line progress event is introduced; triggered is one terminal snapshot. Subscribe with
`scriptMonitor:*`; do not add this family to the agent bare-`*` expansion.

Completed/expired/triggered transitions enqueue one automatic, noninterrupting
owner wake.
Its messageMetadata is exactly this shape (optional fields omitted):

```json
{"type":"script_monitor_wake","source":"system","monitorId":"monitor-a","workspaceId":"ws-a","agentId":"agent-a","scriptId":"check","runId":"run-a","scriptName":"Checks","mode":"command","reason":"finished","expiresAt":"2026-10-02T10:01:00Z","settledAt":"2026-10-02T10:00:02Z","result":{"outcome":"succeeded","exitCode":0,"startedAt":"2026-10-02T10:00:00Z","stoppedAt":"2026-10-02T10:00:02Z"}}
```

For expiry reason is `ttl-expired` and result is omitted. For output reasons
`output-match` / `line-count`, result is omitted and the same `trigger` object as
on the row is required. All other identity/timing keys in the example remain
required; only output-match carries matchedLine. Human-readable text states the
script/run and winning condition, that monitoring ended, and how to read output
or re-arm. Only a regex wake includes the matched line, clearly marked as
untrusted script output; other reasons contain no output. Do not set a user-origin attribution
or wake/create a different agent. Busy/question-held owners receive a queued
wake through normal automatic-delivery rules, not an interrupt.

Persist terminal state and a stable wake identity derived from monitorId as one
recoverable transition (transactional outbox or equivalent). Queue admission and
conversation delivery use that same identity to deduplicate retries; crash after
enqueue/before retirement must not duplicate the user message. Events are UI
observations, never the source of truth for wake dispatch. A process/model turn
cannot be guaranteed to execute exactly once across a crash; the promise is one
logical notification and one durable message, not exactly-once model execution.
Do not copy PR monitor's best-effort send-after-persist path for this guarantee.

Add `waitingOnScriptMonitors?: [{ monitorId, scriptId, runId, scriptName, expiresAt }]`
to AgentLite (agent.list/get), diagnostics rows, agent:idle, and monitoring-idle
completion-watch advisories. Omit when empty, never null. Only active rows count.
As with hooks, an idle owner with an active script monitor is externally waiting:
completion watches/after_all defer and may send their existing one-per-waiting-
period advisory (`watchStillArmed: true`, `childExternallyWaiting: true`). Terminal
retirement re-evaluates deferred settlement; a queued wake keeps the owner pending
until delivered. Silent cancellation must also re-evaluate settlement.

The FE reconciles rows by monitorId after reconnect/list and subscribes before
its initial read; do not let a pending list overwrite newer terminal events.
Rows in the chat monitoring controls expose existing pane/bottom-panel script
navigation plus separate stop-monitoring and cancel-run actions. Opening is
script-scoped, not historical run output. Disable open when the definition is
gone and explain that a rerun may have replaced the buffer. Never translate the
monitor cancel-run control into an unguarded script.stop call.

#### Lifecycle, recovery and bounded retention

Owner deletion/retirement and workspace archive/delete silently cancel active
watches, release ownership/waiting state and remove **all undelivered script
monitor wakes**, including output-match/line-count wakes for already-terminal rows. No cancellation wake
and no post-unarchive/restore summary of these watches. Preserve already-delivered
conversation history. Deleting/retiring an owner adds no new script-stop policy. Workspace teardown keeps its existing script shutdown
behavior; cancel/suppress watches before those stops can publish completion.

Guard registration, terminal transition, enqueue, queue drain and actual worker
admission against owner/workspace lifecycle. Cleanup and admission share a fence:
a completion enqueued immediately before cleanup is removed; one arriving after
cleanup is suppressed. Generic archived/retired queue parking is insufficient.
Fail closed on lifecycle-read errors. These guards and suppression are durable;
recovery, unarchive, agent restoration or a delete undo never resurrect cancelled
watches or pending wakes. Do not delete unrelated queued user/agent messages.

Persist accepted run identity, deadlines, monitor configuration/state/result or
trigger (including the one matched line), cancellation intent and pending wake
identity. In-flight decoder fragments/counts need not persist: prior-boot runs
settle on recovery, never resume their output window or replay scrollback.
At recovery, first apply lifecycle cleanup,
then reconcile each active binding: replay a persisted final result; otherwise
a run from a prior daemon boot becomes `interrupted` (-1 plus error). It cannot
attach to an autostart/restored service's new token. If expiresAt has already
passed and no final result was durably recorded before recovery, expire the
monitor instead; do not synthesize a success, stop a successor or reset TTL.
Recovering a persisted cancel intent reconciles only its recorded run and never
signals a replacement. A persisted final row's pending wake is delivered with its
stable identity after lifecycle checks, without re-emitting terminal transitions.

Retain only the latest admitted run token and compact result per script; a new
admission overwrites that slot **after** capturing any predecessor result needed
by its monitors. Monitor rows pin their own small result or trigger (at most one 4096-byte matched
line), not PTYs or output buffers.
V1 limits are five active monitors per owner and **1000 total retained monitor
rows per workspace**, including pending wake/cancellation records and their bounded trigger payloads. Before a fresh
registration prune oldest terminal rows whose wake is durably delivered or
suppressed, retaining at most seven days from settledAt and evicting such rows
earlier if needed for capacity (order settledAt, monitorId). Never evict an active
row or undelivered wake to admit a new monitor: refuse `-32602` naming the exhausted
limit instead. A same-owner retry is checked before limits and consumes no slot.
This bounds monitor-specific backlog without imposing a new transcript retention
policy or dropping promised wakes for a busy agent. Sweep eligible aged rows on
startup and at least hourly. Cancel/lookup after pruning returns unknown ID,
never resolves an ID to a newer run. No retention work touches script.output.

#### Verification boundary

[Monitor fixtures](../fixtures/scripts/monitors.json) and their
[executable model/tests](../fixtures/scripts/monitors.test.mjs) specify boundary
values, identity, ownership, terminal races, output framing/OR triggers, cleanup and recovery. Run
`node --test docs/protocol/fixtures/scripts/monitors.test.mjs` (also in
`make consumer-checks`). They are synthetic contract tests, **not proof of daemon
locking, SQL durability, queue delivery or frontend integration**. Component unit
and real WSS tests must execute the same cases with controlled admission, exit,
persistence, cancellation, cleanup and delivery barriers; include actual service
backoff, script.run reservations, before-spawn cancellation, Rust-regex compile limits, split UTF-8/ANSI/CRLF,
overlong lines, output gaps, fresh rearm windows, storage failures and
crashes before/after terminal commit and queue admission. FE interaction tests
must cover capability absence, both navigation placements, owner rows and stale
cancel clicks after restart, plus reconnect/list/event races.
