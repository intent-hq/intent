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
every connection before enabling management; workspace controls use `canManage`,
never fake ownership or a cached connection category. Host provider/model/repository
reads and pairing requests must remain routed to that host when a different local
daemon exists. Reconcile live membership changes with a fresh bounded snapshot.

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
