> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5 Method Catalog.

### 5.48 Multiplayer — principals, invites, membership

The multi-principal surface of a daemon: who a connection *is*, which workspaces it may see, how an owner invites a second person and how that person joins. Introduced within protocol 10.3 by the intentd multiplayer stack — principals and caller binding ([intent-hq/intentd#1868](https://github.com/intent-hq/intentd/pull/1868)), message attribution ([#1869](https://github.com/intent-hq/intentd/pull/1869)), membership and capability enforcement ([#1870](https://github.com/intent-hq/intentd/pull/1870), [#1877](https://github.com/intent-hq/intentd/pull/1877), [#1871](https://github.com/intent-hq/intentd/pull/1871)), invite links and the identity-only device-flow join ([#1872](https://github.com/intent-hq/intentd/pull/1872)). The connection principal read `principal.me` is also summarized in §5.46 (client boot); presence, the ephemeral roster layered on top of membership, is §5.47.

Every method below is workspace-scoped unless stated otherwise. Two are **fast paths**: `workspace.invite.create` needs the listener's own pairing snapshot to build the link (like `pairing.getInfo`), and `invite.redeem` is the only method served on the unauthenticated `/invite` endpoint; the rest dispatch through the router.

| Method | Params | Result |
| --- | --- | --- |
| principal.me | — (daemon-global, no `workspaceId`) | `{ id, login, displayName, avatarUrl, isAdministrator }` — the principal this connection was **bound to at admission** (never what `client.hello` claimed); `login` / `displayName` / `avatarUrl` are `null` until a GitHub identity is linked. On the administrator a read also kicks a rate-limited background refresh of the primary's GitHub profile (never awaited; failures leave the cached row untouched) |
| principal.revokeSelf | — (daemon-global) | `{ revoked: true, credentials, workspaces }` — the bound **collaborator** leaves every workspace it collaborates in (`workspaces` = memberships dropped) and revokes all its credentials (`credentials` = rows revoked); the daemon then closes its connections (below). The administrator is `-32602` (rotate the server token or `github.revoke` instead) |
| workspace.members.list | workspaceId (req) | `{ members: Member[] }` — the roster, owner included; Member+ (a non-member is `-32602 { code: "not-found" }`) |
| workspace.members.remove | workspaceId (req), principalId (req) | `{ removed: boolean }` — **owner-only**; removing the owner is `-32602`; a `principalId` that is not a member is `{ removed: false }` (no error). On removal the member's queued user messages on the workspace's agents are dropped and `workspace:updated { changes: { members: true, removedPrincipalId, memberCount } }` is published |
| workspace.members.leave | workspaceId (req) | `{ left: boolean }` — the bound collaborator drops its own membership (same teardown + event as `remove`); the owner is `-32602` ("cannot leave"), a non-member `-32602 { code: "not-found" }` |
| workspace.invite.create *(fast path)* | workspaceId (req), pinLogin?: string, expiresInSecs?: integer | `{ invite: WorkspaceInvite, secret, url, hosts, port, fingerprint, version, tcAddress? }` — **owner-only**; mints a single-use, expiring invite and returns the raw `secret` **exactly once**, here. `url` is the `intent://invite` link (below); `hosts` / `port` / `fingerprint` / `tcAddress?` are the link envelope's parts and `version` its payload version (`1`). Publishes `workspace:updated { changes: { invites: true } }` |
| workspace.invite.list | workspaceId (req) | `{ invites: WorkspaceInvite[] }` — the **open** invites (not redeemed, not revoked, not expired) in `createdAt` order; **owner-only**. Secrets are never included, so a link cannot be re-copied from a `list` row |
| workspace.invite.revoke | workspaceId (req), inviteId (req) | `{ revoked: boolean }` — **owner-only**; `revoked: false` when the invite was already closed; an `inviteId` unknown to this workspace is `-32602 { code: "not-found" }`. Publishes `workspace:updated { changes: { invites: true } }` when a row changed |
| invite.redeem *(fast path, `/invite` only)* | phase 1: inviteId (req), secret (req) — phase 2: flowId (req) | Two phases on one method name (§ "Joining by invite"). **Phase 1** validates the open invite and starts an identity-only GitHub device flow → `{ flowId, userCode, verificationUri, expiresIn, interval, workspaceId, workspaceTitle }`. **Phase 2** blocks until that flow settles → `{ status: "authorized", token, principalId, login, workspaceId }` **exactly once** (the flow is forgotten once collected), or the terminal invite error (`invite-flow-denied` / `invite-flow-expired` / `invite-pin-mismatch` / the invite's closed state) |

#### Identity model

- A **principal** is a person. The daemon's existing single user is the **primary** principal — minted by migration `0125` and made the **owner** of every workspace that already existed — and every other principal is someone who joined through an invite, identified by the stable GitHub account id (`github_user_id`, one principal per account) that its identity-only device flow established (§ "Joining by invite"). `login` / `displayName` / `avatarUrl` are the cached GitHub profile.
- **Caller binding happens at the upgrade gate**, once per connection, from the presented bearer token: the legacy file token (`server.auth.token`) binds the primary principal as **administrator**; a per-principal credential (`principal_credential` row, matched by hex SHA-256 of the token) binds that principal as a **non-administrator**. An unknown token is still `401`. The binding never changes for the connection's lifetime and is never taken from `client.hello` — `principal.me` reports it. Agents (MCP) and the daemon itself act as the primary principal.
- **Roles** are per workspace: `owner` or `collaborator` (wire and stored spelling, lowercase). **Exactly one owner per workspace** — a partial unique index since migration `0126` — and there is no ownership transfer; the administrator is unconstrained by roles. `workspace.create` is administrator-only, so the owner is always the primary principal in v1.
- **Membership fields on every `Workspace` row** (§5.1) served through the service layer — `workspace.get`, `workspace.list`, the `workspace.subscribe` snapshot and deltas: `ownerPrincipalId?` (absent only on a transfer-imported row whose owner has not been re-derived yet), `myRole?` (`"owner"` | `"collaborator"`, relative to the request's bound caller; absent when the caller is not a member or no principal is bound), `memberCount` (the owner counts) and `openInviteCount`. Computed in one query per call, never per row.
- **Membership narrowing.** For a non-administrator caller `workspace.list` returns only its member workspaces, and every workspace-scoped read or write on a workspace it is not a member of is `-32602 { code: "not-found" }` — indistinguishable from a workspace that does not exist, so a guest can neither enumerate nor probe the owner's other workspaces. Owner-only operations attempted by a collaborator **member** are `-32003 Forbidden` (§ "Errors").

#### Shapes

```jsonc
// principal.me — the bound principal
{ "id": "3f1c…", "login": "octocat", "displayName": "Octo Cat", "avatarUrl": "https://…", "isAdministrator": false }

// workspace.members.list — Member rows
{ "members": [ { "principalId": "3f1c…", "login": "octocat", "displayName": "Octo Cat", "avatarUrl": "https://…",
                 "role": "collaborator", "addedAt": "2026-09-14T12:00:00.000Z" } ] }

// WorkspaceInvite — create's `invite` and list's rows; optional keys omitted when absent, never null.
// `secret` / `secretHash` are NEVER serialized as fields: the plaintext rides only inside create's
// top-level `secret` and `url`.
{ "id": "9b2e…", "workspaceId": "ws-1", "createdByPrincipalId": "3f1c…",
  "pinGithubUserId": 583231, "pinLogin": "octocat",          // only on a pinned invite
  "createdAt": "2026-09-14T12:00:00.000Z", "expiresAt": "2026-09-21T12:00:00.000Z",
  "redeemedAt": "…", "redeemedByPrincipalId": "…", "revokedAt": "…" }   // closed rows only (never on list)

// invite.redeem phase 1 — the device-flow codes the invitee enters on GitHub
{ "flowId": "…", "userCode": "ABCD-1234", "verificationUri": "https://github.com/login/device",
  "expiresIn": 900, "interval": 5, "workspaceId": "ws-1", "workspaceTitle": "Add dark mode" }

// invite.redeem phase 2 — the `authorized` result; `token` is the only copy of the new credential
{ "status": "authorized", "token": "<64 hex chars>", "principalId": "7a9d…", "login": "invitee", "workspaceId": "ws-1" }
```

#### Invite links — `workspace.invite.create`

- `expiresInSecs` defaults to **7 days** (`604800`) and must be in `[1, 2592000]` (30 days), else `-32602`. `pinLogin?` restricts redemption to one GitHub account: it is trimmed (blank ⇒ unpinned), resolved through `GET /users/{login}` **at mint time** and stored as the stable account id (`pinGithubUserId`; `pinLogin` is kept as the canonical login for display) — a login that names no account is `-32602 { code: "invite-pin-unknown" }`.
- **Inviting requires a linked GitHub identity.** The primary's cached identity alone does not qualify: `github.authStatus` must report a configured, working credential on every mint (the profile is fetched inline when the row is still unlinked), else `-32603 { code: "github-identity-required" }`. A joined collaborator's identity was proven by its own device grant and is accepted as cached — but `workspace.invite.create` is owner-only, so in v1 only the primary mints.
- **The link envelope is resolved exactly once per `create`, before the invite is minted**, so a daemon nobody can dial never stores an invite that cannot be redeemed: no TCP listener is `-32603 { code: "listener-down" }` (the `pairing.getInfo` discriminator); a listener with no dialable route (loopback-only bind and no tunnel) is `-32603` with a message naming `server.bindAddress` / `server.tunnel.enabled`. The envelope is the `intent://pair` one (§5.12 `pairing.getInfo`: loopback-free `hosts`, `port`, certificate `fingerprint`, optional tunnel `tcAddress`) **minus the bearer token**.
- **Link format** — `intent://invite?v=1&host=<ip[,ip…]>&port=<p>&fp=<sha256>&inviteId=<id>&secret=<s>[&tc=<addr>]`, with the same query encoding as `build_pairing_uri`. It never carries the daemon token: the holder can only redeem the invite.
- **Identity lock.** The first invite of a workspace also pins the workspace's *legacy author* (content authored before anyone else could have joined is the owner's — § "Attribution"). Once other principals or open invites exist, the primary's GitHub identity is load-bearing: a `GET /user` refresh that names a **different** account (the owner reconnected GitHub as someone else) leaves the cached identity untouched and fails with `-32603 { code: "primary-identity-locked" }`. While the daemon is still single-user the switch is applied as before.

#### Joining by invite — the `/invite` endpoint

`/invite` is the daemon's **one unauthenticated WebSocket endpoint** (beside `/ws` and `/tunnel`): the invitee holds only the link, so the upgrade skips credential resolution — the `server.enabled` flag and origin allow-list still apply (§2.2). It serves exactly one method — `invite.redeem` — and nothing else: any other method (request), `workspace.invite.create` included, is answered `-32001` with the message `the /invite endpoint serves invite.redeem only`; a notification is dropped without a response; and reverse RPCs, subscriptions and events never flow on it. The join is an **identity-only GitHub device flow** run by the host: the invitee authorizes on GitHub, the host uses the resulting access token **once** for `GET /user` (the stable account id) and never persists it. Every phase-1 start requires an **open invite** — the secret is hashed and compared against the row; a miss (unknown id or wrong secret) is `-32602 { code: "invite-not-found" }`, a closed invite `invite-expired` / `invite-revoked` / `invite-redeemed`, and an invite whose workspace is gone `invite-not-found` — after the transport has validated the required string params (a missing or blank one is `-32602`).

**Bounds**, because an anonymous peer must not exhaust the daemon or GitHub: at most **32** concurrent `/invite` connections (excess upgrades are refused `503`; the permit is taken before the `101` and returned when the connection task ends, however it ends), **16 KiB** inbound frames, at most **4** requests in flight per connection (each runs on its own task, so heartbeats keep flowing while a phase-2 wait blocks; excess is `-32603 { code: "invite-flow-busy" }`), a listener-wide token bucket over phase-1 starts — the requests that hash a secret and open an upstream device flow (**8** burst, one token per **5 s**; a throttled start is the same `invite-flow-busy`, answered before any store or upstream work, so a peer cannot enumerate links or churn device flows by serialising attempts or reconnecting; phase-2 waits are not counted), and at most **16** identity flows in flight daemon-wide (a start past the cap is `invite-flow-busy`; a refused start never reaches GitHub).

##### The two phases of `invite.redeem`

1. **Start — `invite.redeem { inviteId, secret }`** → `{ flowId, userCode, verificationUri, expiresIn, interval, workspaceId, workspaceTitle }`. The host opens an identity-only GitHub device flow with its configured OAuth client and polls it in the background at GitHub's `interval` until the codes expire (`expiresIn` seconds) or the grant settles; `workspaceId` / `workspaceTitle` let the invitee's client name the workspace on its consent prompt. The invitee enters `userCode` at `verificationUri`.
2. **Wait — `invite.redeem { flowId }`** blocks until the flow settles (bounded by the codes' lifetime plus a short grace; a wait that outlives it is `-32602 { code: "invite-flow-expired" }`) and answers the outcome **exactly once** — the slot is forgotten as the result is collected, so a repeated wait on the same `flowId`, or a wait on an unknown one, is `-32602 { code: "invite-flow-not-found" }` (a settled-but-uncollected outcome is kept for two minutes). Outcomes: the invitee authorized → the join commits (below) and the result is `{ status: "authorized", token, principalId, login, workspaceId }` — the **token exactly once**; the invitee denied → `invite-flow-denied`; the codes expired before authorization → `invite-flow-expired`; polling GitHub failed repeatedly → `-32603 { code: "invite-flow-error" }`; the account does not match a pinned invite → `invite-pin-mismatch`; the invite closed meanwhile → its closed state (`invite-redeemed` / `invite-revoked` / `invite-expired`). Each terminal error leaves the invite **open** except a completed join.
3. **Connect.** The invitee reconnects on `/ws` (or through the tunnel route the link's `tc` names) with `token` as the bearer — the same hosts / port / fingerprint the link carried — and is bound as a non-administrator principal: `principal.me` names it, `workspace.list` shows the joined workspace with `myRole: "collaborator"`, and every call is subject to the collaborator allowlist below.

##### The join commit

Once the grant is in hand the host reads `GET /user` with it, then re-checks the invite (still open; a pinned invite whose account differs is `-32602 { code: "invite-pin-mismatch" }`) and, in **one store transaction**, mints or reuses the principal keyed by `github_user_id` (refreshing its cached `login` / `displayName` / `avatarUrl`), marks the invite redeemed (the conditional update is the single-use guard — a concurrent join that loses it is answered with the invite's closed state, `invite-redeemed`), adds the `collaborator` membership (a returning principal re-joining a workspace it already belongs to keeps its row) and records a fresh per-principal credential (64 hex chars, stored as its SHA-256). `workspace:updated { changes: { members: true, invites: true, addedPrincipalId, memberCount } }` is published after the commit. `login` in the result is the joined principal's cached GitHub login.

**Credential revocation closes connections.** `principal.revokeSelf` (and any future revocation of a principal's credentials) broadcasts the principal id; every **non-administrator** connection still bound to it — the per-principal-credential ones; a connection admitted on the legacy token never subscribes to revocation, even when bound to the same primary principal — drains its in-flight responses (so the caller's own `revokeSelf` result is delivered, bounded to 5 s) and is then closed with WebSocket close code **1008 (policy)** and reason `credential revoked`. A replayed revoked token is refused at the upgrade gate (`401`). `workspace.members.remove` / `members.leave` do **not** close the connection: the removed member simply stops seeing the workspace — its later reads are `not-found`, its workspace-scoped subscription channels deliver nothing further, and its queued user messages on the workspace's agents are dropped.

#### The collaborator allowlist — methods (default-deny)

A connection bound to a **non-administrator** principal may only *attempt* the methods below; the check runs at the connection's single inbound chokepoint **before every classify and dispatch path** (control, server / pairing, provider setup, host, browser, forward, client, drafts, subscription channels, events, router), with aliases canonicalised first (`git.diff` → `git.diffs`, `git.log` → `git.commits`), so no fast path is reachable by a method outside the list. A miss is `-32003 "Forbidden"` (no `data`) echoing the request `id`; a notification is dropped without a response; a malformed envelope keeps its `-32600`. Because the gate precedes `-32601`, a collaborator cannot distinguish an unknown method from a refused one — see the capability probe below. Per-workspace **membership** is enforced in the service layer on top of this gate (§ "Identity model"); the list only says which methods a guest may reach. The list is frozen by a golden test in `crates/intent-transport/src/catalog.rs` (`COLLABORATOR_METHODS`, each entry with a vetting note), which also freezes the refused remainder, so a new method must be classified explicitly. **190 names** — 178 of the 376 router + fast-path names (the 2 aliases canonicalise before the gate, so they follow their targets) plus the 12 §6.9 subscription-channel methods (`workspace` / `note` / `chat` / `comment` / `task` / `note.presence` `.subscribe` + `.unsubscribe`, counted outside §5's dispatchable total) — by namespace:

| Namespace | Allowed methods |
| --- | --- |
| agent (38) | appendMessage, cancelSubscriptions, create, delegate, dismissQuestions, editAndRegenerate, editQueuedMessage, get, getConversation, getMessageBlock, getModels, getQueue, getSession, getSessionStats, getSubscriptions, list, listActive, listInterrupted, listUserMessages, markSeen, pendingPermissions, queueMessage, removeQueuedMessage, rename, resolveInterrupted, respondPermission, restore, retry, sendMessage, sendQueuedMessageNow, sendToTask, setModel, stop, subscribe, summary, unsubscribe, update, wakeOrCreate |
| chat (2) | subscribe, unsubscribe |
| client (1) | hello |
| comment (8) | add, delete, getThread, list, resolveThread, respond, subscribe, unsubscribe |
| crossWorkspace (3) | listNotes, listSiblings, readNote |
| drafts (3) | clear, get, set |
| event (3) | agentActivity, query, workspaceSummary |
| events (2) | subscribe, unsubscribe |
| file (16) | attachmentUpload.abort, attachmentUpload.begin, attachmentUpload.chunk, attachmentUpload.commit, delete, exists, getAttachmentInfo, list, mkdir, placeAttachment, read, readChunk, rename, stat, tree, write |
| git (26) | branchDiff, branchStatus, changes, checkMergeConflicts, checkoutBranch, commit, commitDetails, commits, createBranch, diffs, discard, fetch, getBranches, getConfig, getRemoteUrl, numstat, pull, push, removeLockFile, renameBranch, showFile, stage, stageHunk, status, unstage, unstageHunk |
| gitRoot (1) | list |
| hook (1) | list |
| host (2) | status, toolAvailability |
| metrics (2) | getAgentStats, getWorkspaceStats |
| models (1) | list |
| note (23) | add, create, delete, edit, editLines, get, getVersion, lineAttribution.computeNow, lineAttribution.load, list, listTasks, listVersions, presence.subscribe, presence.unsubscribe, presence.update, readAsset, restoreVersion, saveAsset, setContent, subscribe, unsubscribe, update, updateMetadata |
| pr (2) | refresh, status |
| prMonitor (1) | list |
| presence (2) | snapshot, update |
| primitive (4) | addAgentAction, addCli, addPatch, addReference |
| principal (2) | me, revokeSelf |
| providers (1) | catalog |
| search (7) | cancel, codebase, events, fileNames, inFiles, messages, notes |
| skill (1) | list |
| specialist (2) | get, list |
| stats (2) | getRateHistory, getUsage |
| system (1) | capabilities |
| task (17) | assignAgent, convertBlocks, createPrerequisite, get, getMyTask, linkAgent, list, listAgentLinks, markAsTask, removeAgentFromAllTasks, setRelations, subscribe, unlinkAgent, unsubscribe, update, updateNoteStatus, updateStatus |
| workspace (16) | dismissAttention, get, getAutoCommit, getContext, getTokenUsage, getUiContext, list, localChanges, markSeen, members.leave, members.list, subscribe, unsubscribe, update, updateContext, updateUiContext |

Owner-only by design — the **198** refused dispatchable names, frozen alongside the list: every `host.*` method but the two display probes (19), `browser.*` (7), `forward.*` (3), `terminal.*` (7), `script.*` (9); `github.*` (26) / `linear.*` (11) / `sentry.*` (8) / `voice.*` (2) — they act with the primary user's third-party credentials; `settings.*` (4), `repo.*` (3), `repoConfig.*` (4), `rules.*` (3), `mcp.*` (12), `providers.setup.*` (4), `server.*` (2) / `pairing.getInfo` / `system.*` except `system.capabilities` (5, `system.status` included), `client.list`, `debug.sampleStacks`, `unsloth.*` (2), `sandbox.*` (2), `accept-changes.*` (5), `file-tracking.*` (6); `workspace.*` outside the 16 listed (31: `create`, `archive` / `unarchive`, `delete` / `cancelDelete` / `restore` / `cleanup`, `duplicate`, `diskUsage`, `findRepositories`, `initializeRepository`, `detectProjectType`, the setup-script four, `setAutoCommit`, `getBrowserClient` / `setBrowserClient`, `export.*` / `import.*` / `transfer.plan`, `members.remove`, `invite.create` / `invite.list` / `invite.revoke`); `git.clone` / `git.agentCommit`; `agent.delete` / `cancelDelete` / `completeOnce` / `diagnostics` / `enhancePrompt` / `reportToParent` / `resolveProposal` and `agent.replaceMessages` (it persists client-supplied user rows verbatim, so a non-owner could forge attribution; collaborators keep `agent.editAndRegenerate` for the edit flow); `hook.cancel` / `hook.runNow`; `prMonitor.cancel` / `prMonitor.flush`; `specialist.create` / `edit` / `delete`; `metrics.clearAgentStats` / `getAllWorkspaceStats`; and `invite.redeem`, which is served only on `/invite`. The reverse RPCs are never issued to a collaborator connection.

Within the allowed set, three more rules apply to a collaborator caller:

- **Field-restricted writes.** `workspace.update` may touch only the workspace-card metadata `title`, `tags`, `statusMessage`, `statusImageAssetId`; `agent.update` only `name`, `nameExplicitlySet`, `isBackground`. Any other key in the delta is `-32003` (`data.detail` names the gate). `workspace.getContext` / `updateContext` and the UI-context pair are member-editable as listed.
- **Namespaced `clientId`.** `client.hello` returns (and persists) `clientId` as `{principalId}:{presented}` — idempotent, so a client that stores the returned id re-hellos to the same identity. A collaborator therefore can only ever act as a client id inside its own namespace: an id learned from another member's `draft:changed` never reaches that member's drafts or presence. The administrator, agents and the daemon keep the raw id.
- **Own-token cancellation.** `search.cancel` from a collaborator flips only searches it started; an administrator cancels any.

#### The collaborator allowlist — event types (default-deny)

A non-administrator connection receives only the event types below — live over `events.subscribe` and the §6.9 subscription channels, and durably through `event.query` / `event.agentActivity` / `event.workspaceSummary` / `search.events`, whose SQL is narrowed to the same list. Every fan-out matches the event against the list **and** the subscriber's membership in the event's workspace at delivery time (verdicts are cached briefly and invalidated by membership-changing `workspace:updated`), so a type outside the list is never delivered whatever the subscription pattern asked for — an all-disallowed subscription still gets its `subscriptionId` and simply stays silent. Global (workspace-less) events never reach a collaborator; a `workspace:updated` carrying the collaborator's own `removedPrincipalId` is delivered as its final notification for that workspace, and the global workspace channel only discloses `workspace:deleted` tombstones for workspaces the subscriber has been shown. Frozen by a golden test in `crates/intent-core/src/events.rs` (`COLLABORATOR_EVENT_TYPES`, every `ALL_EVENT_TYPES` entry classified exactly once). **94 types**:

| Family | Allowed types |
| --- | --- |
| agent | agent:attention-requested, agent:completed, agent:created, agent:delete-cancelled, agent:delete-scheduled, agent:deleted, agent:failed, agent:idle, agent:last-message, agent:message, agent:process:evicted, agent:process:queued, agent:process:resumed, agent:queue:processing, agent:queue:processing-cancelled, agent:queue:stale-message, agent:queue:updated, agent:renamed, agent:restored, agent:retired, agent:session-stats-changed, agent:started, agent:status-changed, agent:stream:activity, agent:stream:end, agent:stream:start, agent:stream:status, agent:subscriptions-changed, agent:tool:call, agent:updated, agent:user-message:sent |
| changes | changes:agent-locks, changes:git-status, changes:metrics-changed, changes:tracked |
| chat / comment / draft | chat:stream:delta, comment:added, comment:resolved, draft:changed |
| file | file:changed, file:created, file:deleted, file:renamed |
| git | git:branch, git:commit, git:merge, git:pull, git:push |
| goal / spec | goal:updated, spec:updated |
| hook | hook:cancelled, hook:dispatched, hook:evicted, hook:expired, hook:scheduled |
| note | line-attribution:updated, note:created, note:deleted, note:presence, note:updated |
| pr / prMonitor | pr:linked, pr:unlinked, pr:updated, prMonitor:cancelled, prMonitor:changed, prMonitor:completed, prMonitor:emitted, prMonitor:registered |
| presence | presence:changed |
| search | search:done, search:result |
| skills / specialists | skills:changed, specialists:changed |
| task | task:agent-linked, task:agent-unlinked, task:created, task:ready-tasks-changed, task:status-changed |
| workspace | workspace:activity, workspace:activity-changed, workspace:attention-changed, workspace:closed, workspace:context-changed, workspace:created, workspace:delete-cancelled, workspace:delete-scheduled, workspace:deleted, workspace:displayStatus-changed, workspace:opened, workspace:setup:completed, workspace:setup:started, workspace:tokenUsage-changed, workspace:updated, workspace:waiting-changed |

Owner-only (the 49 refused types, `COLLABORATOR_REFUSED_EVENT_TYPES` in the intent-core golden): `terminal:data` / `terminal:exit` (raw PTY bytes) and `terminal:command` / `terminal:cwd` / `terminal:title`, `host:exec:stdout` / `stderr` / `exit`, `script:changed` / `output` / `state`, `build:started` / `build:completed`, `test:started` / `test:completed`, `browser:tab-opened` / `tab-updated` / `tab-closed`, `client:connected` / `client:disconnected`, `hook:run-started` / `hook:run-completed` (hook code and carried state), `agent:permission:request` / `agent:permission:resolved`, the agent delivery / subscription bookkeeping `agent:message:sent` / `agent:message:received` / `agent:message:delivery-failed` / `agent:delivery-confirmed` / `agent:event-delivery-failed` / `agent:event-delivery-timeout` / `agent:subscribed` / `agent:unsubscribed` / `agent:subscriptions-restored` / `agent:woken-by-subscription`, `workspace:transfer:progress` / `ready` / `failed`, `git:clone:progress` / `git:clone:done`, `gitRoot:registered` / `updated` / `unregistered`, `app:ui-highlight` / `app:ui-navigate` / `app:workspace-open`, `settings:changed`, `github:auth-changed`, `mcp.servers:status-changed`, `mcp:notification`.

#### Attribution — who wrote a human message

- **`fromPrincipalId` stamp.** Every user-origin entry point (`agent.sendMessage`, `agent.sendToTask`, `agent.queueMessage`, `agent.editQueuedMessage`, `agent.appendMessage`, `agent.editAndRegenerate`, `agent.wakeOrCreate`, `workspace.create`'s `initialAgent` message) stamps the bound wire caller's principal id into the message **metadata** under `fromPrincipalId` *before* the payload is persisted or enqueued — overwriting whatever the client supplied; an agent / daemon / unbound caller strips the key instead. Metadata only: the content is never annotated, so prompts stay byte-identical. A non-object `messageMetadata` is `-32602` (a human send must never fall back to the workspace default because its metadata had the wrong shape).
- **`author` projection.** Every `user` row served by `agent.getConversation` (slim and full), `agent.getSession`, `agent.getQueue`, the `chat.subscribe` snapshot / deltas and the `agent:message` / `agent:last-message` echoes carries `author: { principalId, login, displayName, avatarUrl }`, resolved at serve time from the row's `fromPrincipalId`, else the workspace's **legacy author** (the primary principal for workspaces that predate migration `0125`; pinned to the owner by the workspace's first invite otherwise), else its current owner. Profile fields are `null` when the principal row is gone; `author` is absent on non-user rows. Never persisted; a transcript page resolves its distinct authors in one batched statement.
- **Comment authors.** `comment.add` / `comment.respond` from a bound wire principal persist `author` = its login (else display name, else id) and `authorType: "user"` regardless of what the client supplied; the one pass-through is the primary principal with no GitHub identity linked (a single-user daemon keeps rendering the author its client always sent). Agents and the daemon keep their supplied values.

#### Events

No new event type: membership and invite changes ride `workspace:updated` (§6.5) with these `changes` keys, and every workspace-scoped read re-derives `memberCount` / `openInviteCount` / `myRole` from the store:

| Trigger | `changes` |
| --- | --- |
| join by invite (redeem commit) | `{ members: true, invites: true, addedPrincipalId, memberCount }` |
| `workspace.members.remove` / `members.leave` / `principal.revokeSelf` (per workspace left) | `{ members: true, removedPrincipalId, memberCount }` |
| `workspace.invite.create` / `workspace.invite.revoke` (when a row changed) | `{ invites: true }` |

The removed member receives its own `removedPrincipalId` event as the last frame for that workspace (a `workspace.subscribe` delta maps it to `removedIds`); every other member sees the roster change and re-reads `workspace.members.list`.

#### Errors

| Code | `error.data` | When |
| --- | --- | --- |
| -32003 Forbidden | none | Connection-level allowlist refusal: a non-administrator called a method outside the collaborator allowlist (unknown names included) |
| -32003 Forbidden | `{ code: "forbidden", detail }` | Service-level capability refusal: a collaborator **member** attempted an owner-only operation or an owner-only field (`workspace.members.remove`, `workspace.invite.*`, restricted `workspace.update` / `agent.update` keys, …); `detail` names the gate |
| -32602 Invalid params | `{ code: "not-found" }` | The caller is not a member of `workspaceId` (indistinguishable from a nonexistent workspace); an `inviteId` unknown to the workspace; `workspace.members.leave` by a non-member |
| -32602 Invalid params | `{ code: "invalid-params" }` | `expiresInSecs` out of `[1, 2592000]`; removing the owner (`members.remove`); the owner calling `members.leave`; the administrator calling `principal.revokeSelf`; a non-object `messageMetadata` |
| -32602 | `{ code: "invite-not-found" \| "invite-expired" \| "invite-revoked" \| "invite-redeemed" \| "invite-pin-mismatch" \| "invite-pin-unknown" }` | Invite / join refusals the user can act on; `message` is the kind's fixed prose (`invalid params: invite has expired`, …). `invite-not-found` also covers a wrong secret and an invite whose workspace is gone |
| -32602 | `{ code: "invite-flow-denied" \| "invite-flow-expired" \| "invite-flow-not-found" }` | `invite.redeem` phase 2: the invitee denied the device flow; its codes expired before authorization (or the wait outlived them); no flow has this `flowId` or its result was already collected |
| -32603 | `{ code: "github-identity-required" \| "primary-identity-locked" \| "invite-flow-busy" \| "invite-flow-error" }` | Inviting without a linked GitHub identity; the primary identity reconnect guard; the `/invite` caps — 4 in flight per connection, the listener-wide token bucket over phase-1 starts, 16 identity flows in flight daemon-wide; polling the device flow failed repeatedly |
| -32603 | `{ code: "listener-down" }` | `workspace.invite.create` with no TCP listener to embed in the link (same discriminator as `pairing.getInfo`) |
| -32001 Unauthorized | none | Any method other than `invite.redeem` on the `/invite` endpoint (`message`: `the /invite endpoint serves invite.redeem only`) |
| HTTP 401 / 503 | — | Upgrade gate: unknown or revoked bearer token on `/ws` / `/tunnel`; `/invite` at its 32-connection cap |

#### Storage

Three intent-store migrations back this surface — `0125_principals.sql` (`principal`, `workspace_member` with the `owner` / `collaborator` role check, `principal_credential` keyed by token hash with `revoked_at`; `workspace.owner_principal_id` / `legacy_author_principal_id`; mints the primary principal and its owner rows), `0126_one_owner_per_workspace.sql` (partial unique index on `workspace_member (workspace_id) WHERE role = 'owner'`, repairing any duplicate owners first) and `0127_workspace_invites.sql` (`workspace_invite` with `secret_hash UNIQUE`, the pin columns and the redeemed / revoked stamps). The legacy file token is deliberately **not** copied into `principal_credential`: it stays the primary user's credential, honored beside the hashed rows. Workspace transfer nulls both principal columns and the target daemon re-derives the owner.

#### Capability probe

A successful, well-shaped `principal.me` reply proves the multiplayer surface; `isAdministrator` tells the client which side of the allowlist it is on. A refusal does not prove absence: a daemon without this surface answers `-32601` (the legacy token is the only credential it knows, so every connection is an administrator), while a multiplayer daemon answers a collaborator's unknown method with `-32003`.
