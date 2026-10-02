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

## Agent feature availability (prepared)

`agentFeatures.desktopControl` is a boolean Agent Feature labelled **Desktop
control**, default **true**, including when omitted from settings or an older
persisted feature snapshot. It is separate from protocol
`capabilities.desktopControl`, native OS readiness, remembered consent and active
session authority. Default-on exposes the API; it never grants permission.
See [settings](./settings.md) for the prepared setting definition.

Capture the effective feature at each new agent-session creation, including
creation/delegation of child agents, and use that same captured value for the
prompt, MCP bridge, help and dispatch checks. Persist the feature snapshot and
reuse it when recreating that session's bridge; an explicit persisted `false`
must not become `true` after a settings change or restart. A missing desktop key
in a legacy snapshot defaults to `true`. New sessions use their own creation-time
settings, not a parent's older snapshot. Changing the setting applies to **new
sessions only**: it neither changes an existing session's effective feature nor
revokes its active desktop authority or erases remembered consent. Use Stop or
revoke for immediate interruption; the feature toggle is not a live kill switch.

When the effective feature is off, omit the desktop namespace from discovery and
omit operational desktop prompt/help guidance. Reject startControl and every
display enumeration or screenshot/input action at the dispatch/service boundary as disabled by
`agentFeatures.desktopControl`, including forged direct dispatch and generic RPC
attempts. Denial occurs before consent prompts, preparation, native dispatch or
asset creation; remembered approval cannot override it. Use the existing
feature-disabled tool-failure convention rather than inventing a public router
method or advertising an unsupported capability.

Cleanup is an explicit exception to the feature gate: authenticated endControl
cleanup, user revoke, terminal Stop reconciliation, native Stop and lease teardown
remain available. Hiding operational discovery must not disable cleanup dispatch
from a retained binding or teardown path. This exception only releases or reports
old authority; it cannot acquire, renew or execute actions, and never bypasses
caller identity, workspace access or the terminal-report checks below. A session
with no authority can still perform the normal idempotent endControl cleanup.

Desktop consent **does not depend on structuredQuestions**. Its dedicated
permission request/decision protocol works with that feature off, including for
delegated agents whose structured questions are unavailable. When
`agentFeatures.stateSnapshot` is off, suppress automatic snapshot injection only:
the required release-control hint in active start results, grant wakes and enabled
desktop API help remains unchanged. Explicit agent snapshot calls remain available
and truthfully describe active control, including its hint. None of these feature
combinations weakens owner checks or user-only consent decisions.

## Identity, primary selection and authority

Agent calls use the prepared MCP-only desktop namespace shown below; they are
**not public router methods**. Derive the agent and workspace from authenticated
agent execution context. For this desktop feature, **agent owner** means the
persisted `workspace.owner_principal_id` of that resolved workspace, including
for delegated agents. AgentSession has no independent owner-principal field.
Read the existing store owner using `get_workspace_owner_principal_id`; the
general `require_agent_owner` helper checks workspace management and is not
sufficient for desktop authority. This is a desktop-only authority rule, not a
change to general agent ownership or workspace management.

There is no fallback to the current message sender, parent agent's caller,
workspace manager, host administrator or another connected user's principal.
An absent owner or a selected-primary connection whose admitted principal differs
fails authority checks without selecting another computer. An inaccessible or
missing workspace keeps the existing indistinguishable not-found behavior;
otherwise absent owner/mismatched principal is forbidden. A store lookup failure
is an error, never permission or an instruction to choose a fallback principal.
Reject model-supplied `agentId`, `clientId`, `workspaceId`,
`computerId`, `sessionId` or permission decisions rather than silently honoring
them. Parent agents cannot act on behalf of a child. Agent access to generic RPC,
reverse RPC, hook or settings paths must not bypass this boundary.

At start, distinguish an **assigned primary** from an unassigned routing default.
A saved `browserClientId` is assigned even when offline. Otherwise an active
workspace desktop session fixes its executor; otherwise the existing oldest
agent-owned browser-tab host is assigned (including hidden tabs and disconnected
hosts). User-owned tabs do not assign a primary. The REV-2
first-connected fallback is not an assignment. Browser calls keep their existing
[REV-2 driving-client rules](./files-terminal-browser.md); this distinction
controls desktop consent and the existing primary selector, not browser fallback.

For an assigned workspace, resolve that identity **before** testing desktop
capability/principal; offline is `desktop-offline`, incapable is
`desktop-unsupported`, wrong owner is forbidden. None selects another computer.
Consent remains bound to that assigned primary. A pin change that conflicts with
active control invalidates that control before further input. There is no separate
desktop primary field or model client selector.

For an unassigned workspace, use the candidate consent/claim flow below. Only a
human's explicit Allow may establish its saved primary; server enumeration order
and remembered consent alone cannot do so.

Bind each assigned request, unassigned candidate and activated session to
`{ workspaceId, agentId, principalId, clientId,
computerId, connectionEpoch }`. `principalId` identifies the granting human;
`connectionEpoch` is a fresh opaque daemon-issued connection incarnation. The
executor supplies a stable local `computerId` and `computerName` at preparation
(see reverse RPC). Names and logical hello IDs are display/routing data, not
authentication. The selected-primary/granting connection's admitted principal
must exactly equal that persisted workspace owner. The session's `principalId`
records this same value; workspace management alone does not grant control of
another user's desktop. Before an unassigned claim, each candidate connection
must meet that same exact-owner check. Recheck the persisted owner at consent decisions,
activation, every renewal, preparation and action dispatch. Owner changes invalidate pending requests and active sessions
with reason `owner_changed`, clear their active snapshot hints and trigger the
normal native teardown/lease invalidation path. Late approvals/readiness replies
cannot reactivate old authority. Remembered grants retain their original
principal/workspace/agent/computer tuple and never transfer to a new owner;
the new owner must obtain consent on its exact selected primary. Terminal Stop
reports are the notification-only exception: validate the retained original
granting principal and current workspace access under the reconciliation rules,
not the new owner's execution authority. They cannot control a successor.

One live session per physical interactive desktop, across agents, workspaces,
backend connections and Intent app instances. The local executor owns an atomic
desktop-wide lock; a daemon-only mutex is insufficient. The lock key and stable
computer identity must agree across those instances. Contenders get
`desktop-busy`, never a replacement session. Permission prompting does not reserve
the lock: acquire it again at activation. A busy result reveals no other
workspace's agent identity. Primary changes (including implicit resolution
changes), identity/capability changes and connection replacement invalidate the
old assigned pending request/session; never redirect or migrate live control.
Unassigned candidate removal and competing assignments follow the rules below.

## Agent API and results

The following proposed signatures are bindings, not entries in the dispatchable
catalog or the generated index of shipped MCP help. All optional fields are
omitted when absent, never null. Unknown arguments fail validation.

```ts
ws.desktop.startControl()
ws.desktop.endControl()
ws.desktop.listDisplay()
ws.desktop.screenshot(args?)
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
| `listDisplay()` | none | `DisplayListResult` below (metadata only) |
| `screenshot(args?)` | `displayId?: string, layoutId?: string` | `ScreenshotResult` below (one selected display) |
| `click(args)` | `displayId?: string, layoutId, x, y, button?: "left" \| "right", clickCount?: 1 \| 2` | `{ ok: true }` |
| `type(args)` | `text: string` | `{ ok: true }` |
| `keypress(args)` | `key: string, modifiers?: ("Shift" \| "Control" \| "Alt" \| "Meta")[]` | `{ ok: true }` |
| `scroll(args)` | `displayId?: string, layoutId, x, y, deltaX, deltaY` | `{ ok: true }` |
| `drag(args)` | `displayId?: string, layoutId, from: { x, y }, to: { x, y }` | `{ ok: true }` |

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
  | { status: "pending_permission"; requestId: string; computerName?: string }
  | { status: "active"; sessionId: string; computerName: string; hint: string };
```

For unassigned candidate consent, the agent projection omits `computerName`
until a winner is selected; never present the fallback client as a chosen machine.
A candidate UI projection may include only its own prompt computer name.
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
updates permission for the current assigned primary, or the caller's own eligible
candidate while unassigned, with the label
`Allow desktop control without asking`.

The following steps apply to an assigned primary; an unassigned start first uses
the candidate flow below and rejoins activation at step 4.

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

### Unassigned workspace: consent claims the primary

1. After caller/owner/effective-feature checks, discover connected execution
   connections with browser execution and desktop capability version 1, workspace
   access and an admitted principal exactly equal to the persisted workspace owner.
   Prepare each candidate to bind its stable computer identity and connection epoch.
   A failed preparation excludes that candidate; it never chooses another principal.
   Deduplicate connections for one logical client to its current execution epoch.
   No candidates yields an offline/unsupported error without permission or a pin.
2. Create one five-minute request for the requesting agent and a frozen set of
   prepared candidates, bound to the workspace's current primary-assignment
   generation. Other clients/principals never receive prompt data. Each targeted
   `PermissionRequest` has the same request ID but its recipient's computer fields
   and `claimsPrimary: true`. Recheck current owner, workspace access and candidate
   epoch before prompt publication and every pending read/replay; owner changes
   invalidate the cohort. Explain that Allow selects **this computer** as the
   workspace primary. The existing three decision choices remain unchanged.
   Return pending promptly and coalesce repeated starts. New connections are not
   silently added to an existing request; a new explicit start may discover them.
3. A decision identifies its candidate by the authenticated connection and retained
   epoch, never a caller-supplied client/computer selector. Recheck workspace access,
   owner, effective feature, capability, candidate eligibility, expiry and assignment
   generation. Serialize with explicit `workspace.setBrowserClient`, agent tab
   ownership/host changes, active desktop transitions and other consent requests.
   Any intervening assignment-generation change invalidates the request, even if
   a pin is set and cleared before the reply or selects the same candidate.
4. The **first valid allow** wins. In the same transaction, compare that the
   workspace is still unassigned at the captured generation, consume the request,
   persist the winner's logical client in existing `browserClientId`, and persist
   only its exact remembered tuple for `allow_future`. A failed transaction leaves
   all of these unchanged and authorizes no activation. Emit the usual committed
   `workspace:updated { changes: { browserClientId } }`; no new setter RPC or
   desktop-only pin is introduced. Invalidate other pending candidate requests in
   this workspace against the changed generation. Losing concurrent/duplicate
   replies are `desktop-stale-request`, never grant writes or a takeover.
5. Activate **only** the winner, under the existing local lock/readiness/lease and
   owner checks. The selected pin records a successful user choice, not successful
   native readiness: a later OS/busy/disconnect/activation failure leaves the saved
   pin (and explicit remembered grant) intact, reports the failure, and never tries
   another candidate. Recheck the committed selection before accepting readiness;
   an explicit switch or withdrawal cannot be undone by a delayed ACK.

A deny dismisses only its candidate's prompt, returns the existing accepted
response, and saves no grant or primary. Repeated decisions from that dismissed
candidate are stale. Other candidates can still Allow. When all candidates deny,
resolve the shared request once as denied; with no viable candidates because of
connection loss/capability loss, resolve once as invalidated instead. Expiry and
agent withdrawal terminate the entire request. Removing one disconnected candidate
invalidates its epoch only; its replacement cannot approve the old prompt.
A denied candidate's subsequent getState omits pending. Candidate denial is not a
request-wide resolved event/wake; each local UI dismisses after its decision ACK.
At terminal resolution, notify all original authorized candidate connections so
other prompts close, and enqueue just the normal single correlated agent outcome.

Remembered consent never silently claims an unassigned workspace. Even when one
or several candidate tuples are remembered, require the explicit candidate Allow.
`allow_once` leaves any prior remembered tuple unchanged; `allow_future` writes
only the winner's tuple. With an assigned primary, the existing remembered-consent
prompt bypass continues unchanged. Changing remembered permission alone never
sets a primary or starts control. No candidate flow can take over a saved pin,
active session or existing agent-browser host, including an offline assignment;
the user must explicitly switch the existing primary selector first.

### Primary selector and activity label

The workspace sidebar ellipsis always offers **Set primary client**, including
single-client, no-activity, unassigned and already-selected cases. Reuse the existing
selector/setBrowserClient flow and tab migration/explicit-switch confirmation.
Disable only when the local client is already selected or genuinely unavailable
or unauthorized, with accurate explanatory state. This UI visibility rule does
not broaden setter authorization or desktop owner checks.

Show the primary machine label only while desktop control is active or agent-owned
browser tabs exist, including hidden tabs. Active control shows its actual executor
computer even with only one eligible client; otherwise show the existing agent-tab
host. User-only tabs, pending consent and an idle saved/offline pin do not show the
label. Stop hides it when no agent tabs remain and does not clear the saved primary.
Do not infer active control from a saved pin, candidate prompt or remembered grant.

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
UI selector, scoped to that workspace and its persisted owner principal. Permission reads,
writes and decisions require the selected primary's authenticated connection,
except the explicitly bound same-owner candidates of an unassigned workspace;
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
`setPermission` compares its supplied computer ID to the current prepared primary
(or the authenticated connection's prepared local candidate while unassigned);
a stale menu cannot grant another computer. `getState` fails offline/unsupported
instead of projecting a different assigned primary. While unassigned, getState
returns only the caller's eligible prepared local permission/candidate projection,
never another candidate's pending prompt. setPermission never claims the primary.
The matching bound executor may
report its old session revoked after primary changes; it cannot revoke a successor.
Allowed report reasons are `user_stop`, `screen_locked`, `os_permission_lost`,
`lease_expired`, `executor_failed` and `unsupported_environment`.

`PermissionRequest = { requestId, workspaceId, agentId, agentName, computerId,
computerName, expiresAt, options, claimsPrimary: boolean }`; fields other than
`claimsPrimary` and `options` are strings; `options` is the ordered array
of `{ id, label }` values defined above. `expiresAt` is RFC3339 UTC.
`claimsPrimary` is false for an assigned-primary request and true for an
unassigned candidate prompt. Only the bound primary or a bound unassigned
candidate with the exact owner principal receives its own prompt data. The
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
report only after a successful authenticated, correlated acknowledgement
(`reported` true or false), or an explicit local user discard as defined below.
For user_stop, `reported: false` acknowledges a retained, previously accepted
Stop outcome after checking the same report authority; it must never mean an
unknown/deleted session, missing credential record or rejected report.

An ambiguous `not-found` response never authorizes local deletion: absent,
deleted and hidden targets remain indistinguishable on the wire. Retain the same
report ID, original tuple and credential on not-found, forbidden, authentication
failure, malformed response, timeout or transport loss. Park retries until a
same-backend reconnect, access refresh or explicit local retry; do not spin on
denials. If access is restored, resend the original report as the same principal;
an existing retained session can then acknowledge and deliver its Stop outcome.
Never try another principal/backend or reinterpret failed delivery as success.

Both ends persist terminal records through reconnects and restarts. The daemon
may remove its credential/deduplication record when the agent or workspace is
deleted, but still returns the ordinary indistinguishable not-found response;
there is no deletion-discovery API or special acknowledgement for hidden targets.
The client therefore keeps even a permanently orphaned report until an explicit
local user discard, such as removing that stored backend connection and its
pending notifications. Explain that this abandons an **undelivered** Stop
notification; never describe it as acknowledged or as proof of target deletion.
An automatic age limit, backend sign-out, lost workspace access or an inferred
target deletion must not purge pending reports. A local discard affects only
that local notification queue, not session/permission state or any successor.
Credentials remain in protected local storage, never workspace/repository files.

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
a new turn; deletion removes the server record with the agent, while the client
retains an unacknowledged report under the ambiguous-response rule above.

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

`action` is `{ kind: "listDisplay" }`, `{ kind: "screenshot", displayId?, layoutId? }`
or the matching input name (`click`, `type`, `keypress`, `scroll`, `drag`) plus that
binding's arguments. `listDisplay` execution returns `DisplayListResult`; screenshot
returns `ScreenshotResult`; input returns `{ ok: true }`. Listing uses the same
command ticket and session gates, never an unauthenticated discovery operation.
No arrays, arbitrary scripts, shell commands or raw native function names are accepted. The executor
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
or capture. For screenshot and coordinate input it additionally resolves and
binds the concrete selected display and current layout as described below; this
normalization cannot be changed at execute time. At acceptance the executor reads its local monotonic clock `M0`
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

### Display metadata and explicit selection

A display is an attached monitor on the already-authorized workspace primary
machine. Selecting a display never chooses another computer, grants permission
or changes the workspace primary. Every listing, capture and input call requires
the existing effective feature, active control, owner, connection and live lease
gates. Listing neither starts control nor bypasses consent or OS restrictions.

```ts
type DisplayMetadata = {
  displayId: string;
  width: number; height: number;
  originX: number; originY: number;
  scaleFactor: number;
};
type DisplayListResult = { layoutId: string; displays: DisplayMetadata[] };
type ScreenshotResult = {
  capturedAt: string; // RFC3339 UTC
  layoutId: string;
  displays: [DisplayCapture]; // exactly one selected display
};
type DisplayCapture = DisplayMetadata & {
  assetId: string; url: string; mimeType: "image/png";
};
```

The exact singular binding `listDisplay()` returns only current metadata at
execution time, not image bytes, assets or a permission grant. An otherwise valid
active session with no available displays returns an empty list and a current
layout token. Width/height are positive integer **image pixels**, origins are
signed physical virtual-desktop pixel offsets, and scaleFactor is positive and
finite. IDs are nonempty unique strings scoped to that active session and stable
for a continuously attached display. Do not recycle a removed display ID for a
replacement during the session. Listing order has no selection semantics.

`layoutId` is a nonempty opaque token for one coherent display topology, shared by
list and screenshot results. Change it on attachment/removal, rotation, geometry,
scaling/DPI or native mapping changes; do not reuse a prior token if topology
changes and later changes back. The same unchanged layout keeps its token across
listing and capture. Never combine metadata from different topology generations.

Screenshot accepts no argument or an object with optional `displayId` and
`layoutId`. Click, scroll and drag retain all existing coordinates and the required
`layoutId`, but their `displayId` becomes optional. Empty IDs, null fields and
unknown arguments are invalid params. Validate supplied layout before selection:
old tokens fail `desktop-stale-layout`. Then apply the same selection rule to all
four operations:

- No available display: `desktop-display-unavailable`.
- Explicit ID: select exactly that available display; unknown/disconnected IDs
  fail `desktop-display-unavailable`. Do not replace them with another display.
- Omitted ID and exactly one available display: select that display.
- Omitted ID and multiple available displays: `desktop-display-selection-required`.
  Do not choose the OS primary monitor, previous capture target or first list item.

All pre-execution selection failures use numeric `-32602` and
`execution: "not_started"`. For selection-required, `error.data.detail` is this
model guidance (the MCP failure preserves code/detail):

```text
Multiple displays are available. Call ws.desktop.listDisplay() and ask the user which screen to use, then retry with displayId.
```

The model should list metadata and clarify the intended screen with the user,
then explicitly select it. This guidance is ordinary conversation; it does not
require the structuredQuestions feature or authorize automatic screenshot retries.
A refusal performs **zero capture, asset creation, overlay pulse or injected
input**. No screenshot previews are generated to accompany a selection error.

Resolve and retain the concrete display ID and layout during `prepareCommand`,
including when screenshot omitted its layout token or the single display was
inferred. Revalidate the bound topology/ID immediately before native execution;
any intervening change is `desktop-stale-layout`, even if only one monitor remains.
The execute request cannot select a different target. Metadata enumeration itself
returns a coherent current topology at execution and has no inferred target.

An explicit screenshot captures **only the selected display**, never every display
followed by filtering. Persist exactly that image through the existing asset
pipeline and return exactly one entry in `ScreenshotResult.displays`, whose ID
and geometry match the bound selection and whose `layoutId` matches that topology.
Return the canonical `workspace-asset://<workspaceId>/<assetId>` URL unchanged,
not a worktree path. Pulse only after successful capture, authority/layout recheck
and asset save. A capture or persistence failure is an error, never a partial list.
Recheck topology after native completion: discard stale image/result and suppress
asset publication/pulse. If topology changes during input after an OS step already
occurred, report `desktop-stale-layout` with truthful partial/unknown execution,
release held input and never retry or claim rollback. Pre-execution hotplug
rejections remain not_started. Screenshot bytes, typed text and keys never appear
in lifecycle events or wakes.

Coordinates remain finite display-local image pixels: `0 <= x < width` and
`0 <= y < height`, origin at that image's top-left. The executor maps them to
native OS coordinates including mixed Windows DPI, negative monitor origins and
macOS points; never assume one global scale. Drag stays on one selected display.
Use listDisplay to learn IDs/layout/geometry and a selected screenshot when visual
content is needed. Type and keypress keep their existing focused-window semantics;
they accept no display selector and do not move focus to a requested monitor.

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
`agent_end`, `user_stop`, `primary_changed`, `owner_changed`, `disconnected`, `screen_locked`,
`os_permission_lost`, `lease_expired`, `agent_terminated`, `executor_failed`,
`unsupported_environment`, `outcome_unknown`. Emit only real transitions;
repeated start/end and duplicate revoke do not duplicate events/toasts.
The first accepted terminal Stop report emits an ended/user_stop event with its
`reportId`, including when correcting an earlier ended reason. Consumers update
that session's reason; they must not end a different current session. Duplicate
Stop reports emit nothing. No report credential is included in events.

Permission events (including durable query/search projections) are restricted
to the granting principal's bound primary, or their targeted candidate connection
for unassigned consent. Candidate requested/permission-changed projections remain
recipient-specific on live delivery, replay and reads; terminal resolved events
close all authorized candidate prompts without exposing another principal's data.
Session events are visible only to
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
| -32602 | `desktop-not-active`, `desktop-stale-request`, `desktop-stale-command` | Missing current authority or stale request/command; no execution |
| -32602 | `desktop-stale-layout` | Display topology changed; not_started before native work, partial/unknown if detected after input |
| -32602 | `desktop-display-selection-required`, `desktop-display-unavailable` | Multiple displays without a choice, or no matching available display; no capture/input or fallback |
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
Electron code, including zero/one/multiple-display metadata and selection, selected-only native
capture, unknown IDs, hotplug/rotation/DPI changes between preparation and execution,
no capture/assets/pulse/input on selection refusal, forged caller/decision paths,
stale grants, simultaneous
starts/Stop, local Stop during network loss, no replay, right click, pulse and
navigation. Packaged Electron evidence on **both macOS and Windows** must prove
native capture exclusion, permissions, mixed-DPI/multiple monitors, Unicode and
keyboard mappings, screen lock and Windows elevation/UAC/secure-desktop refusal.
Report an unavailable platform environment as a verification gap.
