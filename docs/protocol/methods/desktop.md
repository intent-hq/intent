> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.51 Desktop control.

## Status and discovery

This is a **prepared additive contract**, not implemented or qualified by the
current pins. Initial support requires both macOS and Windows. Linux is outside
the initial scope. No currently advertised protocol version changes here.

The daemon advertises `server.capabilities.desktopControl: 1` only when the
complete session, consent, agent-binding and revocation contract is implemented.
Electron advertises `client.hello.capabilities.desktopControl: 1` only on its
execution connection, alongside `browserExec: true`. Missing/unknown capability
versions mean unsupported. Capability describes implementation, not permission
or OS readiness. Old peers ignore the additive flag; a new daemon must never
send desktop reverse calls to an old client. The UI gates its controls on both
ends' support. Do not modify browser routing or infer desktop support from
`browserExec`, host display availability, or a protocol version number.

## Identity, primary selection and authority

Agent calls use the prepared MCP-only desktop namespace shown below; they are
**not public router methods**. Derive the agent, workspace and owning user from authenticated agent
execution context. Reject model-supplied `agentId`, `clientId`, `workspaceId`,
`computerId`, `sessionId` or permission decisions rather than silently honoring
them. Parent agents cannot act on behalf of a child. Agent access to generic RPC,
reverse RPC, hook or settings paths must not bypass this boundary.

At start, resolve the existing workspace primary using the
[REV-2 driving-client rules](./files-terminal-browser.md): workspace browser-client
pin, otherwise oldest claimed-tab host, otherwise first connected eligible browser
client. Resolve that identity **before** testing desktop capability. A pinned or
claimed primary that is offline is `desktop-offline`; an existing primary without
desktop support is `desktop-unsupported`. Neither failure selects another computer.
There is no separate desktop picker in the model API.

Bind the request/session to `{ workspaceId, agentId, principalId, clientId,
computerId, connectionEpoch }`. `principalId` identifies the granting human;
`connectionEpoch` is a fresh opaque daemon-issued connection incarnation. The
executor supplies a stable local `computerId` and `computerName` at preparation
(see reverse RPC). Names and logical hello IDs are display/routing data, not
authentication. The granting connection must be admitted as that agent owner's
principal and be the selected primary; workspace management alone does not grant
control of another user's desktop. Recheck authority at decisions and actions.

One live session per physical interactive desktop, across agents, workspaces,
backend connections and Intent app instances. The local executor owns an atomic
desktop-wide lock; a daemon-only mutex is insufficient. The lock key and stable
computer identity must agree across those instances. Contenders get
`desktop-busy`, never a replacement session. Permission prompting does not reserve
the lock: acquire it again at activation. A busy result reveals no other
workspace's agent identity. Primary changes (including implicit resolution
changes), identity/capability changes and connection replacement invalidate the
old pending request/session; never redirect or migrate live control.

## Agent API and results

The following proposed signatures are bindings, not entries in the dispatchable
catalog or the generated index of shipped MCP help. All optional fields are
omitted when absent, never null. Unknown arguments fail validation.

```ts
ws.desktop.startControl()
ws.desktop.endControl()
ws.desktop.screenshot()
ws.desktop.click(args)
ws.desktop.type(args)
ws.desktop.keypress(args)
ws.desktop.scroll(args)
ws.desktop.drag(args)
```

| Binding | Arguments | Result |
| --- | --- | --- |
| `startControl()` | none | `StartResult` below |
| `endControl()` | none | `{ ended: boolean, withdrawn: boolean }` |
| `screenshot()` | none | `ScreenshotResult` below |
| `click(args)` | `displayId, layoutId, x, y, button?: "left" \| "right", clickCount?: 1 \| 2` | `{ ok: true }` |
| `type(args)` | `text: string` | `{ ok: true }` |
| `keypress(args)` | `key: string, modifiers?: ("Shift" \| "Control" \| "Alt" \| "Meta")[]` | `{ ok: true }` |
| `scroll(args)` | `displayId, layoutId, x, y, deltaX, deltaY` | `{ ok: true }` |
| `drag(args)` | `displayId, layoutId, from: { x, y }, to: { x, y }` | `{ ok: true }` |

`StartResult` is exactly one of:

```ts
type StartResult =
  | { status: "pending_permission"; requestId: string; message: string }
  | { status: "active"; sessionId: string; alreadyGranted: boolean;
      computerName: string; message: string; hint: string };
```

Repeated start while active validates the existing session and returns the same
session with `alreadyGranted: true` and `message: "Control is already granted"`.
A fresh successful start returns `alreadyGranted: false` and
`message: "Desktop control is active"`. Repeated pending start returns the same
request ID and no extra prompt, start toast or grant claim. Concurrent starts
for the same agent coalesce, including during preparation/activation. Pending
results say: `End this turn and wait for the desktop control permission outcome.`

The required `hint` in **both** active results, grant wake and API help is:

```text
You are controlling the workspace primary desktop. Call ws.desktop.endControl() as soon as your desktop work is finished.
```

The model-facing `ws.agent.snapshot()` adds `desktopControl: DesktopState` while
this daemon supports the feature. `DesktopState` is one of:

```ts
type DesktopState =
  | { status: "inactive" }
  | { status: "pending_permission"; requestId: string; computerName: string }
  | { status: "active"; sessionId: string; computerName: string; hint: string };
```

This projection is the calling agent's current state, not remembered permission.
Ending, denial, withdrawal, expiry or revocation removes the active hint. There is
no public `agent.snapshot` router addition. A normal turn boundary does not end
ongoing desktop work; completion, cancellation, deletion, retirement and terminal
failure do. Stop or timeout must never trigger automatic restart/retry.

## Consent and lifecycle

Desktop consent is separate from [ACP tool permission](../08-permission-flow.md)
and generic agent Q&A. `AllowAll`, provider bypass mode and answers supplied by a
model cannot approve it. Persist remembered consent by the exact
`{ principalId, workspaceId, agentId, computerId }` tuple. It permits attempting
a future start, never an action or an active session by itself. Reinstallation or
another physical primary requires new consent. The agent ellipsis menu reads and
updates permission for the current primary only, with the label
`Allow desktop control without asking`.

1. Prepare the resolved desktop to learn its stable identity, supported platform
   and name. No capture, input, glow or lock is authorized by preparation.
2. Without remembered consent, create one expiring request, publish its prompt
   and promptly return `pending_permission`; do not block the agent's turn on
   human input. Prompt identifies the agent and computer and offers exactly
   `allow_once` (Allow once), `allow_future` (Allow future sessions for this agent),
   and `deny` (Deny). Expiry is five minutes after creation, not extended by a
   repeated start. Reconnecting clients may read pending state but cannot revive
   a request invalidated by execution-connection loss.
3. An authorized allow decision consumes that request exactly once. For
   `allow_future`, persist the tuple before activation; failure is an error,
   not successful permission. With an already remembered tuple, skip the prompt.
4. Acquire the physical-desktop lock and acknowledge local readiness, OS
   permissions and installed overlay before reporting active. Remembered starts
   return active once readiness is acknowledged, with a start toast and glow;
   they never claim success before the native executor is ready. OS permission
   failure returns an actionable error, not a fresh Intent consent question.
5. A pending request's eventual grant, denial, expiry or activation error queues
   one correlated agent wake. Delivery is serialized with the agent turn queue:
   approval before turn end is retained for after that turn, never lost and never
   a concurrent turn. Commit the terminal request outcome and wake identity
   together (or use a durable outbox); retries deduplicate on `requestId`.
   Revalidate state at delivery: a revoked grant cannot announce active control.
6. Denial/expiry ends the request without a session. A new explicit start may
   ask again. Late or duplicate decisions return `desktop-stale-request` and
   never save permission or activate control. A primary change, withdrawal,
   agent termination or reconnect has the same stale-decision behavior.

`endControl()` is idempotent and ownership-scoped: confirmed local teardown of
the caller's active session returns `{ ended: true, withdrawn: false }`; no
active or pending request returns `{ ended: false, withdrawn: false }`; withdrawing
only a pending request returns `{ ended: false, withdrawn: true }`. Serialize
withdrawal with activation. If activation won, tear it down and report `ended:
true`; if withdrawal won, cancel activation and reject a delayed readiness ACK.
An execution/transport/teardown failure is an error; never convert it to a
successful `ended: false` or `withdrawn: true`. Invalidate daemon authority even
when teardown confirmation fails, and let the local lease expire fail-closed.

User Stop acts **locally first**, even while offline: invalidate the session
generation, reject queued/new commands, release held buttons/keys, remove the
overlay and release the local lock. Record a terminal Stop report for delivery
now or after reconnect as specified below; local stopping never waits for a
network response. The agent wake must state
`Desktop control permission was rescinded by the user. Respect the interruption; do not automatically restart or retry desktop control.`
Stop preserves remembered consent. Turning the menu permission off affects
future starts and does not replace current-session Stop. Neither operation
automatically starts a session. Already executed OS actions cannot be undone.

## Client-facing router methods

These are user/executor control-plane methods, **not agent-callable bindings**.
All require the real `workspaceId` even on direct daemons. `agentId` here is a
UI selector, scoped to that workspace and the owning principal. Permission reads,
writes and decisions require the selected primary's authenticated connection;
revoke requires the session's bound executor connection, except for the strictly
terminal Stop reconciliation below. A foreign/missing
workspace is indistinguishable from not found. Forwarding must preserve the
original authenticated caller; routing context cannot manufacture authority.

| Method | Params | Result |
| --- | --- | --- |
| desktop.getState | workspaceId, agentId | `{ state: DesktopState, permission: PermissionState, pending?: PermissionRequest }` |
| desktop.setPermission | workspaceId, agentId, computerId, allowed: boolean | `{ permission: PermissionState }` |
| desktop.respondPermission | workspaceId, requestId, decision: "allow_once" \| "allow_future" \| "deny" | `{ accepted: true, requestId }` — accepted decision; activation outcome arrives separately |
| desktop.revoke | workspaceId, sessionId, reason, stopReport? | `{ revoked: boolean, reported: boolean }` — revoked means an active session was ended; reported means a new user-Stop outcome was durably recorded |

`PermissionState = { computerId: string, computerName: string, allowed: boolean }`.
`setPermission` compares its supplied computer ID to the current prepared primary;
a stale menu cannot grant another computer. `getState` fails offline/unsupported
instead of projecting a different primary. The matching bound executor may
report its old session revoked after primary changes; it cannot revoke a successor.
Allowed report reasons are `user_stop`, `screen_locked`, `os_permission_lost`,
`lease_expired`, `executor_failed` and `unsupported_environment`.

`PermissionRequest = { requestId, workspaceId, agentId, agentName, computerId,
computerName, expiresAt, options }`; strings except `options`, the ordered array
of `{ id, label }` values defined above. `expiresAt` is RFC3339 UTC.
Only the current bound primary/granting principal receives prompt data. The
existing ACP permission methods cannot resolve these request IDs. A duplicate
revocation is a benign no-op; a foreign session is forbidden, never a no-op.
Non-user-Stop reasons omit `stopReport`, require the original bound connection,
and return `reported: false`. User Stop always includes the report below,
including on the original connection; a retry returns both flags false after
the first accepted report, without suppressing an undelivered durable wake.

### Offline Stop reconciliation

Before sending reverse `startControl`, the daemon durably records a terminal
report credential: a fresh unpredictable 256-bit `stopReportToken` (base64url
without padding) whose stored hash is bound to `{ workspaceId, agentId,
principalId, computerId, sessionId, connectionEpoch }`. Pass the token only to the
bound native executor in startControl. It is notification-only: never expose it
to models, browser renderers, snapshots, event payloads, screenshots or logs; it
cannot authorize start, input, renewal, permission writes or any other session.
Persisting this record must succeed before activation; restart invalidates active
control but retains the terminal record.

The executor stores this credential locally before acknowledging readiness.
On local Stop it first invalidates execution, then durably queues one report
with a fresh UUID `reportId`, retaining that ID across retries. Capture the
session tuple from the Stop control at click time; never substitute the current
agent, focused workspace or a later session. A local queue persistence failure
does not undo Stop: surface the notification failure to the user and retain the
report in memory for immediate retry. Do not claim durable delivery until saved.

The full `stopReport` object is `{ reportId, computerId, connectionEpoch,
stopReportToken }`, all strings; `reason` must be `user_stop`. On either the
original or a replacement authenticated connection to the **same backend**, the
daemon requires the admitting principal to match the retained granting principal,
current access to the retained workspace, the exact old tuple, and the token
hash. Reconnect hello IDs or a supplied computerId alone never suffice. Unlike
new control, this terminal report does not require that computer to remain the
workspace primary. Missing/mismatched credentials are forbidden, an absent/hidden
workspace or session is not-found; no failed authentication consumes the report.

An accepted report can only end its own session if still active and record its
`user_stop` reason. An already-ended session still accepts its **first** valid
Stop report: `{ revoked: false, reported: true }`. The first connected Stop on an
active session returns both flags true. Commit the terminal reason, deduplication
identity and rescission wake/outbox atomically before replying. Deduplicate on
`{ sessionId, user_stop }` as well as `reportId`; another report ID or reconnect
cannot create a second wake. Preserve remembered permission. Do not invalidate,
renew, relabel or clear snapshot state for any successor session.

Retry only this terminal report after lost ACK/reconnect; this is explicitly
**not** replay of consent, activation or input. The executor removes a queued
report after either successful acknowledgement (`reported` true or false).
It never silently drops a pending report on transport failure. Both ends retain
the terminal credential/deduplication record through reconnects and restarts
until the agent or workspace is deleted; deletion yields not-found and the client
discards the orphaned report. Credentials are local protected storage, not
workspace files or repository content. Denied access leaves the report queued
for the same principal to regain access; never try another principal/backend.

`user_stop` takes precedence over an earlier `disconnected`, `lease_expired` or
other terminal reason for the **same session**. Replace any undelivered grant or
generic revocation wake with the exact rescission instruction above. If a generic
revocation was already delivered, deliver one additional correlated user-Stop
notification; retries add none. If a newer explicit session exists, the wake's
`sessionId`/inactive `state` describe only the stopped session and its message
also identifies that old session and says the newer explicit session is unchanged.
The current snapshot remains authoritative and retains the successor's active
hint. Never revive a completed/retired/deleted agent to deliver the report: retain
the notification for its existing conversation when available, without starting
a new turn; deletion removes the report with the agent.

## Client-served reverse RPC

The sole new reverse method is **`desktop.control`**, daemon→client only, using
the existing correlated JSON-RPC `rev-<n>` channel on UDS or WSS. It is not a
dispatchable client→daemon method or a generic native-command escape hatch.

Common params: `{ operation, workspaceId, agentId, principalId, connectionEpoch }`.
All fields are required, trusted daemon-generated strings. Each operation adds:

| Operation | Additional params | Result |
| --- | --- | --- |
| `prepare` | none | `{ computerId, computerName, platform: "macos" \| "windows" }` |
| `startControl` | `computerId, sessionId, agentName, leaseMs: 15000, stopReportToken` | `{ ready: true, sessionId, computerId }` |
| `renew` | `computerId, sessionId, leaseMs: 15000` | `{ renewed: true, sessionId }` |
| `endControl` | `computerId, sessionId` | `{ ended: boolean, sessionId }` |
| `prepareCommand` | `computerId, sessionId, commandId, sequence, action` | `{ commandId, sequence, deadlineId, expiresInMs: 10000 }` |
| `execute` | `computerId, sessionId, commandId, sequence, deadlineId` | `{ commandId, sequence, result }` |

`action` is `{ kind: "screenshot" }` or the matching input name (`click`, `type`,
`keypress`, `scroll`, `drag`) plus that binding's arguments. No arrays, arbitrary
scripts, shell commands or raw native function names are accepted. The executor
validates every field and operation. `startControl` grants no authority unless
received on the prepared, authenticated backend connection after daemon consent.

Session IDs are fresh opaque unpredictable strings, never reused across starts
or restarts. Every action checks the entire binding, local lock and live lease
immediately before OS execution, not only when queued. Sequence is a positive
safe integer strictly increasing per accepted `prepareCommand`; command IDs are
unique per session. The matching execute consumes that prepared sequence once.
Duplicate/out-of-order preparation or execution fails `desktop-stale-command`,
with no second execution. Recheck authority after native completion and before returning an
image/result or showing a screenshot pulse; a result racing revocation cannot
claim the session is still active. Execute serially; Stop invalidates queued and in-flight continuation
steps ahead of all input, including between drag/key down and up. Always attempt
key/button release on termination, including partial execution failure.

Renew every five seconds while authority is valid. Lease expiry uses a local
monotonic timer, 15 seconds from the last accepted start/renew. Renewal cannot
resurrect a stopped/expired generation. Socket close, backend/app restart, screen
lock, permission loss or unsupported secure desktop invalidate immediately when
observed; an undetected partition ends execution no later than lease expiry.
New connections never resume a session, even with the same logical client ID.
No command, input, consent decision or activation is replayed after reconnect.
Only notification-only terminal Stop reports may be reconciled as defined above.

### Command deadlines without synchronized clocks

Each action uses two sequential reverse requests on the bound connection:
`prepareCommand`, then `execute`. No wall-clock deadline or clock calibration is
used. Preparation validates and retains the exact action, but executes no input
or capture. At acceptance the executor reads its local monotonic clock `M0`
(milliseconds) and stores a single-use, unpredictable `deadlineId` with deadline
`M0 + 10000`. The ticket binds the entire session/connection tuple, command ID,
sequence and retained action. Return `expiresInMs: 10000` as the **original**
lifetime, not remaining time; the daemon must never start a new ten-second
lifetime from receipt of this response.

Only one unconsumed ticket may exist per session. A second preparation while it
is live fails `desktop-busy`. Duplicate preparation never refreshes its deadline;
expired, consumed or out-of-order command IDs/sequences cannot be prepared again.
The daemon cannot change the action at execute time; execute carries only the
ticket's identifiers. Unknown or foreign tickets fail `desktop-stale-command`
with `execution: "not_started"`. No preparation/calibration means no executable
ticket: absence of `deadlineId` is invalid params; an invented ID is stale.

Atomically consume the ticket before native work, only if the complete binding
matches, the session/lease is live, and local monotonic `Mnow < M0 + 10000`.
Equality is expired. An expired known ticket yields `desktop-command-expired`
with `execution: "not_started"`; retain its rejection identity until session end
(a sequence watermark may compact it). Response latency, execute transit, local
queue time and multistep work all consume the original local lifetime. Check the
same deadline before every native continuation step and before returning a
successful result; expiry after a step yields `desktop-command-expired` with
`execution: "partial"` and releases held input. Cleanup releases may run after
expiry; no new user action may. Renewing a session never renews a command ticket.

The ticket starts before the daemon can receive it and dispatch execute, so its
expiry is no later than ten seconds after execute dispatch without comparing
peer clocks. Independently, the daemon bounds the whole action call to ten
seconds on its own monotonic clock starting before sending prepareCommand. It
subtracts elapsed time before sending execute and does not dispatch if that
budget has expired. Preparation timeout cannot have executed input; a timeout
after execute was sent is an uncertain outcome, even if the daemon budget ends
before the executor's ticket. Invalidate the session and attempt local teardown;
never interpret that RPC timeout as cancellation confirmation or replay input.

Monotonic clocks must advance across suspend, or the executor must invalidate
sessions/tickets on suspend/resume before accepting further execution. Clock
regression, clock-source replacement or inability to establish that property
ends the session and returns `desktop-deadline-unavailable`. Wall-clock skew,
NTP adjustments and UTC jumps do not affect these deadlines or local leases.
No numeric clock origin crosses the wire, and no drift estimate is required.
An individual uninterruptible OS call may already have occurred when expiry is
noticed; report partial/unknown execution truthfully, never success or rollback.

Lifecycle/reverse calls also time out after ten seconds. A late readiness ACK
never activates a withdrawn/expired request; revoke its local session instead.
Timeout or connection loss with uncertain execution invalidates the session and
returns `desktop-outcome-unknown`; never retry input automatically.

## Screenshots, input and native feedback

`ScreenshotResult = { capturedAt, layoutId, displays: DisplayCapture[] }`, with
RFC3339 UTC `capturedAt`. Capture every attached supported display. Each
`DisplayCapture` has `{ displayId, width, height, originX, originY, scaleFactor,
assetId, url, mimeType: "image/png" }`. Width/height are positive integer **image
pixels**, origins are signed physical virtual-desktop pixel offsets, scaleFactor
is a positive finite number. IDs are strings scoped to that active session.
Persist images as workspace assets using the existing asset pipeline; URLs use
the returned canonical `workspace-asset://<workspaceId>/<assetId>` URL, not a
worktree file path. Screenshot bytes, typed text and keys are not copied
into lifecycle events or wake messages. Capture or asset-persistence failure is
an error; there is no successful partial display list.

Coordinates are finite display-local image pixels: `0 <= x < width` and
`0 <= y < height`, with origin at the image's top-left. `layoutId` identifies
the captured display layout; reject old IDs after rotation, monitor changes or
DPI changes with `desktop-stale-layout`. The executor maps image pixels to native
OS coordinates, including mixed Windows DPI, negative monitor origins and macOS
points. Never assume one global scale factor. Drag stays on one display in this
version. Obtain a new screenshot to learn layout/display IDs after activation.

Click defaults: left button, one click; right button and double click are
required. Scroll deltas are signed finite **image pixels**, positive right/down,
at the supplied pointer position; adapt OS wheel units without losing direction.
Drag is a left-button press/move/release from `from` to `to`. Type inserts the
exact Unicode text (maximum 16,384 UTF-8 bytes); no implicit Enter and no silent
clipboard replacement. Keypress is a press/release chord. `key` is one printable
Unicode scalar or `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Insert`,
`Home`, `End`, `PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`,
`ArrowRight`, `Space`, or `F1`–`F24`. Modifier entries must be unique; `Meta`
means Command on macOS and Windows key on Windows. Unsupported native mappings
return an error rather than silently substituting another key.

After successful activation show a non-focus-stealing, always-visible screen-edge
glow using the app primary color (yellow-green), with bottom-center
`[Stop] Intent is controlling your machine [→]`. Stop is left; navigation arrow
is right and opens the exact owning backend/workspace/agent, not the currently
focused workspace. Intensify briefly after **successful** capture and asset save,
not failed capture. Exclude the overlay from every delivered image; do not hide
the indicator while capturing as a substitute for tested native exclusion.
If native capture exclusion or local Stop cannot be provided, fail readiness.

macOS Screen Recording and Accessibility consent and Windows session lock,
elevated application, UAC and secure-desktop boundaries are native readiness/
execution checks. This contract does not promise bypassing OS restrictions.
Restricted input/capture returns `desktop-unsupported-operation` or
`desktop-os-permission-required`, with a useful message; unsupported active
desktop transitions terminate control. `{ ok: true }` means the native operation
completed, not that an application accepted text or performed its intended task.
If the executor cannot establish native completion, return an error with the
execution uncertainty field below.

## Events and agent wakes

New workspace events use the ordinary envelope and these complete data payloads:

| Event | Data |
| --- | --- |
| `desktop:permission-requested` | `PermissionRequest` |
| `desktop:permission-resolved` | `{ workspaceId, agentId, requestId, outcome, state: DesktopState, error?: DesktopError }` |
| `desktop:permission-changed` | `{ workspaceId, agentId, permission: PermissionState }` |
| `desktop:session-changed` | `{ workspaceId, agentId, sessionId, computerId, computerName, status: "active" \| "ended", reason?, reportId? }` |

`outcome` is `granted`, `denied`, `expired`, `withdrawn`, `invalidated` or `failed`.
Only `granted` carries active state, after readiness; all other outcomes carry
inactive state. Session `reason` is omitted for active; ended requires one of
`agent_end`, `user_stop`, `primary_changed`, `disconnected`, `screen_locked`,
`os_permission_lost`, `lease_expired`, `agent_terminated`, `executor_failed`,
`unsupported_environment`, `outcome_unknown`. Emit only real transitions;
repeated start/end and duplicate revoke do not duplicate events/toasts.
The first accepted terminal Stop report emits an ended/user_stop event with its
`reportId`, including when correcting an earlier ended reason. Consumers update
that session's reason; they must not end a different current session. Duplicate
Stop reports emit nothing. No report credential is included in events.

Permission events (including durable query/search projections) are restricted
to the granting principal's bound primary; session events are visible only to
that principal with workspace access. Agent wakes address only the requester.
Use event IDs for replay deduplication. Subscribe before `desktop.getState` to
recover UI state; reconcile by session/request ID and event order. Events and
snapshot reads alone never authorize native input.

The queued agent wake metadata is `{ type: "desktop_control", requestId?,
sessionId?, reportId?, outcome, state: DesktopState, message, error? }`. Request outcomes
reuse the values above; active-session loss uses `outcome: "revoked"`. Grant
includes the exact release hint in `state.hint` and message. Denial/expiry/failure
messages explicitly say control is not active. User Stop uses the exact
rescission instruction above, clears active snapshot state, and supersedes any
undelivered grant wake. Ordinary explicit end needs no extra wake. Restart may
deliver a saved denial/revocation but cannot restore active state from an old
grant wake or persisted session. Remembered permission and terminal Stop-report
credentials/deduplication records may survive; neither is execution authority.

## Errors and verification

Reuse numeric JSON-RPC errors; no new number. `DesktopError = { code, detail,
execution?: "not_started" | "partial" | "unknown" }` is `error.data` on wire
errors and the `error` field on asynchronous failure outcomes. MCP surfaces the
same code/detail as a tool failure, never `{ ok: true }`. Malformed inputs use
`-32602` with `code: "invalid-params"`; authority refusal uses `-32003` with
`code: "forbidden"` (hidden resources retain existing not-found semantics).

| Numeric | `data.code` | Meaning |
| --- | --- | --- |
| -32602 | `desktop-not-active`, `desktop-stale-request`, `desktop-stale-command`, `desktop-stale-layout` | Missing current authority or stale request/command/layout; no execution |
| -32602 | `desktop-command-expired` | Local command deadline reached; execution is not_started before the first step, partial after a step |
| -32603 | `desktop-offline`, `desktop-unsupported`, `desktop-busy` | Primary absent/incapable or physical desktop locked by another session |
| -32603 | `desktop-os-permission-required`, `desktop-unsupported-operation`, `desktop-deadline-unavailable` | Local OS/operation/monotonic deadline readiness cannot be established |
| -32603 | `desktop-execution-failed`, `desktop-outcome-unknown` | Native/asset/transport failure; action errors require execution classification, never automatic retry |

Pre-execution action refusals set `execution: "not_started"`; partial input sets
`partial`; loss of confirmation sets `unknown`. Permission persistence and local
teardown failures use `desktop-execution-failed` with an explanatory detail.

[Prepared lifecycle fixtures](../fixtures/desktop-control/lifecycle.json) and
[static contract tests](../fixtures/desktop-control/contract.test.mjs) validate
examples, required result distinctions and catalog alignment. Run:
`node --test docs/protocol/fixtures/desktop-control/contract.test.mjs`,
`make docs-check` and `make consumer-checks`.
These tests do not implement the session manager or qualify native support.
Component tests must execute those scenarios against real daemon/WSS and
Electron code, including forged caller/decision paths, stale grants, simultaneous
starts/Stop, local Stop during network loss, no replay, right click, pulse and
navigation. Packaged Electron evidence on **both macOS and Windows** must prove
native capture exclusion, permissions, mixed-DPI/multiple monitors, Unicode and
keyboard mappings, screen lock and Windows elevation/UAC/secure-desktop refusal.
Report an unavailable platform environment as a verification gap.
