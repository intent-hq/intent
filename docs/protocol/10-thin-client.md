> Part of the [Intent JSON-RPC protocol docs](./README.md) — §10 Thin-Client Guidance.

## 10. Thin-Client Guidance

The backend is the **single source of truth**; clients should hold only ephemeral UI state.

### 10.1 Canonical state lives in the backend

Never treat streamed deltas as authoritative. `chat:stream:delta` text, `agent:stream:activity` ticks, optimistic note edits, and local task toggles are **UI sugar** — the persisted entity (fetched via `note.get`,`agent.getConversation`, `note.listTasks`, …) is canonical. Reconcile to it after each mutation/turn.

### 10.2 Subscribe-then-fetch

1. Connect + authenticate (§2), pin the cert (§1.2).
2. `events.subscribe` for the slices you render (e.g. `["note:*","task:*","agent:*"]`) **before**fetching, so no change is missed in the gap.
3. Fetch the current state (`workspace.get`, `note.list`, `agent.list`, …).
4. Apply incoming `events.event` notifications to your local cache; de-dupe on `event.id`.
5. On reconnect, **re-subscribe and re-fetch** — subscriptions do not survive disconnects.

#### Repository context lifecycle

The [repository context contract](methods/workspace.md#repository-context)
requires the following client behavior. This specifies integration obligations;
it does not claim the frontend already implements them.

1. Capture the actual authenticated connection and feature-detect its
   [`repositoryContext: 1` capability](methods/client-hello.md#repository-context-capability).
   Install a handler for its [private retirement feed](06-events.md#private-repository-context-retirement)
   **before** calling capture. Keep the original connection, workspace and optional
   root filter together; a logical `clientId` or matching bearer is insufficient.
2. Call `workspace.repositoryContext.capture` and retain notices arriving while it
   awaits. Reconcile the returned `lifetimeId`, scope, coverage and
   `retirementSequence` with that original feed. A retirement of the returned ID,
   an unexplained cursor gap, terminal notice or feed loss makes the result unusable.
   Notices at or before the returned cursor do not authorize a retired ID; a larger
   cursor alone need not retire an unrelated ID. Compare canonical decimal values
   without rounding, and honor terminal exhaustion even at an unchanged MAX cursor.
3. Read with `workspace.repositoryContext`, using the exact captured workspace,
   root filter and `repositoryLifetimeId`, one read at a time. Accept a result only
   while its original lifecycle is current; check its scope/epoch and reconcile
   intervening notices. Revision ordering exists only within equal scope/epoch.
   Never turn a refused read into a refreshed old reference.
4. Release through `workspace.repositoryContext.release` on that same captured
   connection when the view is discarded. If capture completes after local
   cancellation/disposal, discard the result and release its returned ID through
   the original connection if still usable. A disconnect does not authorize
   sending this cleanup through a replacement connection.
5. On terminal loss/gap, discard every original reference and stop queued reads.
   Reconnection requires a new capture and reconciliation on the new physical
   connection; do not retarget old work or infer authority from a prior TTL,
   revision, selection or account identity. Server entry/final validation remains
   authoritative regardless of notification timing.

#### Repository selection lifecycle

The [repository selection contract](methods/workspace.md#repository-selection)
requires the following client behavior. It does not claim a frontend implementation
or grant write permission through the existing context read lifecycle.

1. Capture the actual confirmed physical connection, feature-detect its
   [`repositorySelection: 1` capability](methods/client-hello.md#repository-selection-capability),
   and install its [private selection retirement handler](06-events.md#private-repository-selection-retirement)
   before calling capture. Keep the connection and exact workspace/root together;
   omitted or null `gitRootId` selects Primary, not an inventory. Keep backend
   correlation and handles private to the client's main process; reject renderer
   overrides of caller, scope, snapshot, revision or backend identity.
2. Call `workspace.repositorySelection.capture` **before user confirmation**.
   Retain notices received while it awaits, then reconcile the returned selection
   ID, scope, root and retirement cursor before exposing an editing handle. An
   unexplained gap, terminal notice, feed loss or retirement of that ID prevents
   using it for a new command. A larger cursor for another ID does not alone retire
   this one. Honor terminal MAX without an increment and compare decimals exactly.
   If capture completes after disposal/cancellation, release only through that
   original connection if still usable; never retarget cleanup to another host.
3. Submit one immutable save or reset using that captured handle and snapshot.
   Never silently recapture between the displayed edit and confirmation. Keep one
   client operation in flight per handle. Identical repeats only observe the
   original attempt; they are not a write retry. A changed command is invalid.
   A conflict requires a new explicit user action based on a fresh editing capture.
4. Preserve a received historical receipt before deciding whether the current UI
   may apply it. Keep `result`, `persistence` and current disclosure/application
   separate: failed projection can coexist with committed persistence, and a
   historical snapshot is not necessarily today's selection. Normal retirement
   means no further effect admission, not effect failure or receipt deletion.
5. Observe pending/settled attempts through `workspace.repositorySelection.reconcile`
   only on the original connection with valid disclosure authority. It never
   writes or revives admission. Cancellation/timeout of a waiter does not stop an
   admitted Store worker or justify replay. Socket/process loss before a known
   receipt leaves the effect uncertain; reading current selection after reconnect
   cannot establish whether that old operation committed. Keep known receipts
   when switching hosts or views, without applying them to a replacement context.
6. Release through `workspace.repositorySelection.release` on the captured
   connection when the editing reference is no longer needed. Release does not
   cancel a worker or erase its retained receipt. Never send late cleanup or
   reconciliation on a newly selected connection. Terminal/gapped/lost feeds
   invalidate all original references and stop queued commands; they do not turn
   known commits into rollback. A fresh explicit action needs its own valid capture.

For these operations, an RPC error or lost connection alone is insufficient to
classify an unknown outcome as no effect or roll back a known committed result.
There is no promised durable receipt lookup across connections. Server manager,
root/credential and final disclosure checks remain authoritative; capability,
read inventory, counters and prior TTLs cannot replace them.

#### Native review lifecycle

The [native review contract](methods/change-tracking.md#native-review-preparation-and-receipts)
requires the following client behavior. It does not claim an existing frontend
implementation or unconditional admission from apparently stable inputs.

1. Capture the original confirmed physical connection and feature-detect its
   [`nativeReview: 1` capability](methods/client-hello.md#native-review-capability).
   Install its [private retirement handler](06-events.md#private-native-review-retirement)
   before preparation. Keep original caller, workspace and explicit root bound
   together; reject renderer overrides of server-owned scope, account or receipt.
2. Prepare the intended action/flags/root/choice **before user confirmation**.
   Reconcile notices received across that await against the returned operation ID
   and retirement cursor before exposing a confirmation handle. A notice for
   another ID alone does not retire this one; an unexplained gap, terminal feed
   or disposal does. Compare decimal cursors exactly, including terminal MAX.
   Release a late preparation only on that original connection if still usable.
3. Confirm one immutable execute command against that exact preparation. Do not
   silently recapture or replace the connection between display and confirmation.
   Keep one client operation in flight per handle. An identical repeat only
   observes the original attempt; changing the command is invalid. A refusal
   before admission may retain a failed outcome and requires a new explicit user
   action if another attempt is desired. Stable public facts are not a grant.
4. Retain received completed Git receipts, review outcome and publication facts
   independently of current UI eligibility. A separate commit and create do not
   share receipts. Publication is not inferred from push/create success or review
   HEAD. Preserve known effects if later bookkeeping, provider work or final
   disclosure fails; neither `success: false` nor an RPC error implies rollback.
5. Observe pending/settled execution through `accept-changes.reconcile` only on
   the original connection with valid disclosure authority. Cancellation or an
   expired timer may retire future stages while the owned worker continues to
   actual completion. The fixed 15-second first-admission deadline, 120-second
   entered-stage timer, 360-second execute wait and 600-second post-settlement
   retention describe different boundaries; none promises worker completion.
   Do not replay a write because its reply is pending or missing.
6. Release through `accept-changes.release` on the captured connection. Release
   does not erase retained receipts or prove an admitted effect stopped. Normal
   operation retirement closes admission, not historical receipt storage. Feed
   loss/terminal or socket loss closes original references; never retarget late
   cleanup or reconciliation to a newly selected host/socket. A missing original
   receipt remains uncertain, and later matching provider state does not prove
   which old operation created it. Keep already known receipts as history without
   applying them to a replacement context.

For this workflow, optimistic UI rollback rules below do not classify unknown
effects or erase known completed ones. There is no durable cross-socket receipt
lookup or automatic write retry. Actual Member execution checks and
administrator-only public connection disclosure remain separate; capability,
context/selection IDs and prepared observations cannot replace either.

#### Commit companion lifecycle

These are client obligations for the [commit companion contract](methods/change-tracking.md#commit-companion-preparation),
not a claim that the frontend implements it.

1. Retain the original physical connection, sender/frame/document, main-process
   session and private feed before the marked parent preparation. Check
   [`nativeReviewCompanion: 1`](methods/client-hello.md#commit-companion-capability)
   alongside `nativeReview: 1`. Bind the intended target before confirmation;
   never replace it from later selection/account state or renderer-supplied IDs.
2. Confirm the staged-only parent commit separately. Retain its actual receipt
   independently of current UI eligibility. Only eligible original completion
   and guarded reply transfer allow a companion; pending, lost, refused or
   cancelled delivery does not. Reconciliation cannot convert history into a
   grant, and client receipt observation is not the server's transfer boundary.
3. Offer at most one optional companion preparation action on that original
   main-process session. Construct `afterCommit` internally with its parent
   operation and main-owned capture ID; coalesce local duplicate actions to the
   same promise. The backend permits one capture, retains failed claims and
   rejects duplicate/concurrent captures. Never recapture on another socket,
   retry the claim, or use public account/HEAD data as authority.
4. Keep parent and child sessions/history separate. Reconcile notices across the
   child preparation await before exposing its new confirmation handle. Confirm
   a new immutable text-only create command using the child's returned operation.
   It has its own receipt and fixed lease; no parent commit receipt is copied and
   no push is implied. Never chain another companion from that child.
5. Respect the fixed parent deadline for both child acquisition and publication,
   then the published child's independent lease. Distinguish
   [normal parent write retirement from companion closure](06-events.md#commit-companion-retirement).
   Never revive a retired write handle. Release/dispose on the original connection;
   release late results there only if it remains usable. Explicit release or
   context/authority/socket loss retires future linked admission, while an
   already-admitted worker remains owned until completion. Feed loss/terminal or
   an unexplained gap closes original references; a new connection cannot resume
   or replay them. Preserve known effects and uncertainty separately.

Fresh server checks remain authoritative at child capture, publication, stage and
disclosure. Stable display facts and a previous successful action cannot authorize
another one. Neither this workflow nor its capability establishes live provider
readiness or unconditional native admission.

#### GitLab checkout lifecycle (prepared)

The [pre-workspace checkout contract](methods/repository-checkout.md) requires
exactly integer [`gitlabCheckout: 1`](methods/client-hello.md#gitlab-checkout-capability)
on the selected connection before capture. This describes client obligations for
project and branch selection before a workspace exists. It does not establish
support on an older daemon, enable the GitLab experiment, or grant access through
a guest's collaboration identity.
Keep the destination daemon and its authorized repository connection bound to
the whole flow; a forge URL is not a daemon routing address. Do not invent a
workspace ID to authorize browsing or silently move a pending action to the
currently focused host.

Keep the full HTTPS instance identity, including its port and installation
prefix, together with the full project path and selected branch. A different
prefix on the same host is a different instance. Preserve the project and branch
when navigating back or restoring a draft, but revalidate their authority before
warming a cache or creating a workspace. A stored draft is selection intent,
not a credential or permission grant.

Connection setup, status, cancellation and reconnection retain that same full
root through the [prepared public auth contract](methods/integrations.md#full-instance-gitlab-authentication-prepared-v135).
Honor the actual `cancelled` result: `false` does not undo a begun or settled PAT
write, and closing the form does not prove cancellation. Preserve the connect
result and current status before starting a new checkout capture.

Project and branch pagination must expose choices beyond the first page.
Keep each cursor with its original connection, project and query; switching any
of them starts a new listing. Discard late responses after a connection,
credential, project or query change. Do not substitute the default branch when
the user selected a different branch, or infer a default from an empty list.
Distinguish an empty project, no default, no branches, denied access, disconnected
account, disabled feature and rate limit so recovery does not select a different
repository or account.

A fresh cache and a matching remote origin do not override known denial or a
retired credential. Cached branches and contents must remain unavailable after
revocation or replacement, and late work under the old authority cannot publish
into the new flow. This does not require a network permission probe on every
cache hit. Direct and cached creation must both check out the selected branch;
show clone progress and errors without presenting an incomplete checkout as
ready.

For a project, merge-request or issue URL, display the resolved target project
and preserve the original link context, including query and fragment. A
merge-request URL selects its target project and the user's selected branch or
the project's real default; it does not request the source fork or merge-request
head. An unknown instance must not fall back to GitHub or another configured
account. Preserve the existing GitHub and local-Git paths independently.

### 10.3 Optimistic UI

For mutations, optimistically apply locally, send the request, and reconcile when (a) the methodresult returns and (b) the corresponding `events.event` arrives. Roll back on error. Use the stable`messageId` you pass to `agent.sendMessage` (and the echoed `agent:user-message:sent` event) tomatch your optimistic message against the canonical one and avoid duplicates across clients.

### 10.4 Minimal client session walkthrough

```text
1.  pair via QR / manual entry → host:port, fp=AB:CD:..., token   (pairing payload, §2.3)
2.  WSS connect wss://host:port/ws  (pin fp)                  (§1.2)
        Authorization: Bearer <token>                        (§2.1)
3.  → events.subscribe { eventTypes:["agent:*","note:*","task:*"], workspaceId:"ws-abc" }
    ← { subscriptionId:"ws-sub-1" }                          (§6.1)
4.  → workspace.get { workspaceId:"ws-abc" }   ← { workspace }
    → note.list      { workspaceId:"ws-abc" }   ← { notes }
    → agent.list     { workspaceId:"ws-abc" }   ← { agents }
5.  → agent.sendMessage { workspaceId, agentId:"agent-123", content:"Fix the build", messageId:"m1" }
    ← { success:true, queued:false, messageId:"m1" }         (§5.5)
6.  ← events.event agent:stream:activity* / agent:tool:call / agent:stream:end   (§7; agent:stream:start only on agent-initiated turns, §6.6)
7.  → agent.getConversation { agentId:"agent-123" }  ← { messages, ... }   (reconcile, §10.1)
8.  (permission prompt, if any) ← request_permission → respond selected/allow_once  (§8)
9.  on disconnect: reconnect, re-auth, repeat from step 3.   (§4)
```

*The canonical wire-protocol specification for the Intent backend daemon (`intentd`). The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`; changes follow the compatibility policy at the top of this document.*

### Shared-host role hydration and rollout *(10.9)*

[§5.49](./methods/shared-host-membership.md) is the authoritative contract for
connected-host roles, safe execution reads, invited-session storage and personal
pairing. Hydrate hello capabilities and `principal.me` from the selected host on
every connection before enabling management; workspace controls use `canManage`
together with the operation's host-role and transport limits, never fake ownership
or a cached connection category. Honor an explicit false even when `myRole` is
owner. A retained guest workspace owner receives permission request/resolved events
only for workspaces they currently manage, matching snapshot/answer authority (§8).
That grant does not admit host creation/administration, guest-denied script RPCs,
or unrelated management events.
Host provider/model/repository
reads and pairing requests must remain routed to that host when a different local
daemon exists. Reconcile live membership changes with a fresh bounded snapshot.

Read `host.executionContext.enabledProviderIds` for the host's effective execution
enablement policy and combine it with that host's catalog/discovery/readiness.
If this projection is missing or malformed, preserve the current agent/model
display but withhold unsupported cross-provider choices. Never infer enablement
from local settings, installation or all known providers. Refresh on committed
`providers.enabled` changes, reconnect and host switch; fence responses/events
from old connections and reads superseded by execution-context invalidation.
Ordinary owner/legacy setup remains separate.

Read `host.executionContext.gitCredentialPolicy` to explain the host owner's
managed GitHub helper switch, without reading settings or credentials. Refresh
that context and provider readiness after reconnect and execution-context events;
configured does not mean authorized. Handle `ExecutionAuthorizationFailure` with
owner-directed Git/AI recovery; retain alternate-helper support and never use the
member's local credentials as a fallback.

Keep the existing default-off Multiplayer selector around the Collaboration tab,
its content, every experimental entry point and direct/legacy route. Runtime
disable dismisses stale dialogs/actions without deleting saved access. The GitLab
lab is an additional independent gate, not a bypass. Preserve ordinary owner
pairing and single-user preferences. iOS classifies personal pairings from the
server role before persisting/publishing, preserving owner/invited sync separation
and distinct principal IDs on a shared host.

Desktop and iOS share §5.49's invited-session **payload v2**, person-qualified
opaque digest account encoding, legacy-alias migration and independent immutable
removal records, within
`com.cloudlands.intent.guest-sessions`. The owner-backend service/schema and the
pairing URI both remain v1. A payload version bump alone cannot fence old writers
at legacy host-only accounts: follow the full migration/old-write precedence and
mixed-version fixture. New clients never publish a live v1 invited mirror or
route invited credentials through the owner publisher. Unknown/newer records
remain frozen and preserved. Sync metadata cannot establish host authority.
Read all removal records before considering live imports; the mutable session's
cached floor is insufficient because a stale whole-item upsert can erase it.
Create-only removal writes survive session compaction and an offline deleting
device. Old readers can overwrite alias markers through cross-account tombstone
propagation; canonical state and restoration handle that write. Digest accounts
prevent old warning logs from printing raw/reversible identity tuples. Delivery
remains eventual; client forgetting is separate from server credential revocation.
