> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.49 Shared host membership.

### 5.49 Shared host membership *(10.9, additive; docs lead implementation)*

This section extends [§5.48](./multiplayer.md). It is the normative contract for
host members, collaboration credentials and personal device pairing. The pinned
10.8 daemon does not yet implement it. Consumers must detect the capabilities
below; publishing these docs or seeing a version string does not enable access.

#### Authority and discovery

The host's primary principal remains its sole administrator and the owner of
every ordinary workspace, including workspaces created by a member. There is no
ownership transfer, private workspace, or per-member execution account.

`client.hello.server.capabilities` gains independently detectable integer flags:

| Flag | Value | Complete contract advertised |
| --- | --- | --- |
| `hostMembership` | `1` | Host roles, effective workspace management, scoped host invitations, removal and live invalidation in this section |
| `collaborationIdentity` | `1` | The separate `identity.*` auth surface and purpose-aware proof calls below |
| `personalPairing` | `1` | Persistent current-principal `pairing.getSelfInfo`, including live credential revocation |
| `authenticatedDevices` | `1` | Server-bound principal/role fields and visibility on `client.list` and client events |

Missing, false, unknown or malformed values do not establish support. Each flag
is advertised only after its complete server behavior is present on every
transport, not when only its router methods exist. Capabilities describe support,
not this caller's authority. They never come from the client's hello bag.

`principal.me` adds always-present `hostRole: "owner" | "member" | "guest"` and
`hostMembershipRevision: integer` (non-negative, durable, monotonic per host).
The bound principal ID is immutable for the connection, but its effective role
is read from current authority. `isAdministrator` remains truthful: member and
guest credentials always yield `false`; membership never returns the server's
administrator token. The primary remains `owner` with no linked forge profile.

| Operation | Owner | Host member | Workspace guest |
| --- | --- | --- | --- |
| List/access ordinary workspaces | All, including future workspaces | All, including future workspaces | Only explicitly granted workspaces |
| Create/duplicate a workspace | Yes | Yes, owned by the primary | No |
| Fully manage workspace content, agents, settings, lifecycle and sharing | Yes | Yes | Existing collaborator rights only |
| Host invites and membership administration | Yes | No | No |
| Host `settings.*`, repository/AI account setup, daemon controls | Yes, with existing transport guards | No | No |
| Read safe host execution setup | Yes | Yes | Existing limited model/provider reads only |
| Pair another device as oneself | Yes | Yes | Yes, retaining only existing grants |
| Read live device roster | Host-wide | Host-wide | Own principal's devices only |

Chief-of-staff and other host-administration virtual surfaces keep their existing
owner boundary; they are not ordinary workspaces. Local client preferences do
not become daemon administration. Unknown/stale role state enables no new action.

After **every connection or selected-host change**, desktop and iOS fetch hello
and `principal.me` before enabling controls. A failed/invalid principal response
is not inferred from a saved connection category, an invite, a device label, a
forge login, an empty workspace list, or the Multiplayer preference. On an older
daemon, a valid legacy `principal.me.isAdministrator` can retain existing owner
or workspace-guest behavior; absence of `hostRole` never implies host membership.
If `hostMembership: 1` is advertised but required role fields are missing, fail
closed and report an incompatible response. Old clients ignore new fields and
may show the old restricted guest UI to a member; they never receive fake owner
roles to unlock it.

#### Effective workspace membership

Every caller-relative `Workspace` projection (`get`, `list`, mutation results,
and subscription snapshots/deltas) adds **`canManage: boolean`**. It is `true`
for the owner and active host members of an ordinary workspace, `false` for a
workspace guest. `ownerPrincipalId` always names the real owner; `myRole` stays
`"owner" | "collaborator"`: an effective host member is `"collaborator"`, even
without a direct `workspace_member` row. No wire role is renamed. Legacy fallback
may use `myRole === "owner"` for old workspace controls, never to infer a member.

`workspace.members.list` returns the union of the owner, active host members and
direct workspace guests, deduplicated by principal ID. Each `Member` adds
`hostRole` using the same enum. `role` remains `owner` only for the primary and
`collaborator` otherwise. An effective member's `addedAt` is the host-membership
timestamp; a guest's is its workspace grant's timestamp. `memberCount` counts
that union. `guestCount` counts distinct direct **non-host-member** collaborators
plus open workspace invitations; host members spend no guest seats, including
when historical collaborator rows exist. Host invitations spend no workspace
seats. Presence and note viewers use the same effective membership and add
`hostRole`; several devices still produce one person in each roster.

Workspace sharing is available to owner/member callers. `principal.list` becomes
available to both and adds `hostRole` to its existing credentialed-person rows;
its exclusion of the primary and its existing profile/identity fields remain.
`workspace.members.add` of an active host member returns `{ added: false,
memberCount }` without adding a row or spending a seat. Attempting
`workspace.members.remove` against an active host member, or
`workspace.members.leave` as one, returns **`-32602 { code:
"host-membership-required" }`**: workspace access is inherited and can only be
removed through host membership. Removing/leaving the owner retains its existing
invalid-params refusal. A caller lacking sharing authority still fails its own
permission check first; a hidden workspace still returns `not-found`.

Archive continues to detach **workspace guests**, revoke open workspace invites
and perform its existing active-work teardown. It does not remove host membership
or host members' inherited access to the archived workspace. Unarchive does not
restore guest grants. Member delete/restore/cancel-delete uses the existing
incremental workspace deletion lifecycle, response and terminal-event ordering;
membership removal never invokes workspace deletion.

**Read cost and invalidation.** Store the active host-member count/revision and
workspace-local guest/open-invite counts on their mutation paths. Update affected
guest counts when a principal changes host role; do not materialize one grant per
member per workspace. List projections combine those stored scalars with the
bound caller's current role in O(rows returned), with no per-workspace membership
query, filesystem access or forge request. Explicit roster reads batch profiles.
Host membership mutations invalidate role/roster/count caches and workspace
subscriptions, including on an empty host. Reconnect always takes a fresh snapshot.

#### Host membership and invitations

All methods in this table are daemon-global and **owner-only**, except the
execution read documented later. No host method takes a `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| host.members.list | — | `{ members: HostMember[], revision }` — primary first, then active members by `addedAt`, tie-break `principalId`; no workspace-only guests |
| host.members.remove | principalId (req) | `{ removed: boolean }` — idempotent when not an active host member; the primary is `-32602 { code: "invalid-params" }`. A real removal performs the revocation transaction below |
| host.invite.create *(fast path)* | pinLogin (req), pinProvider (req, `"github"` or `"gitlab"`), pinHost? | `{ invite: HostInvite, secret, url, hosts: [], port, fingerprint, version: 1, tcAddress }` — a pinned, single-use invitation to be a host member, expiring exactly seven days after creation |
| host.invite.list | — | `{ invites: HostInvite[] }` — open host invites, ordered by `createdAt`, tie-break `id`; optional `url` follows the existing stored-secret/envelope availability rule |
| host.invite.revoke | inviteId (req) | `{ revoked: boolean }` — false if already closed; unknown/wrong-scope ID is `-32602 { code: "not-found" }` |

```ts
type HostRole = "owner" | "member" | "guest";
type Identity = { provider: "github" | "gitlab"; host: string; externalUserId: string };
type HostMember = {
  principalId: string;
  hostRole: "owner" | "member";
  login: string | null; displayName: string | null; avatarUrl: string | null;
  identity?: Identity;
  addedAt: string; // RFC 3339; principal creation for the owner
};
type HostInvite = {
  id: string; scope: "host"; role: "member"; createdByPrincipalId: string;
  pinLogin: string; pinIdentity: Identity; pinGithubUserId?: number;
  reusable: false; redemptionCount: number; // 0 or 1
  createdAt: string; expiresAt: string;
  redeemedAt?: string; redeemedByPrincipalId?: string; revokedAt?: string;
  url?: string; // always present on create; never serialize secret/hash as row fields
};
```

The creator's **Intent authority** suffices. Neither host nor workspace invitation
issuance requires a repository connection, working repository token, or external
owner profile. This intentionally replaces §5.48's live-forge prerequisite.
An unpinned workspace invite makes no forge call. A pin is resolved at issuance
to the existing provider/canonical-instance/stable-ID triple, never just a login.
For host invites `pinLogin` must be nonblank, `pinProvider` explicit, `pinHost`
defaults to `github.com` or `gitlab.com` independently of connected repositories;
GitHub accepts only an omitted host or `github.com`. A GitLab host is a canonical
bare authority, including an explicit port when needed, never a scheme/path.
Unsupported providers, malformed hosts, `workspaceId`, or `expiresInSecs` on
`host.invite.create` are `-32602 { code: "invalid-params" }`.

Existing workspace-invite pin params keep their defaults when a linked primary
identity exists; otherwise a caller pinning a workspace invite must send
`pinProvider` explicitly (`invalid-params` if absent). Both pin lookup and proof
verification try the existing public verification path first; the existing
same-instance host credential fallback may be used if configured. An instance
whose restrictions prevent verification returns the existing actionable
`-32603 { code: "identity-unverifiable", host }`; it never silently treats a
restricted response as a valid pin or requires all hosts to configure that forge.
An actually unknown account remains `invite-pin-unknown`.

Host invites reuse the **tunnel-only** invitation envelope:

```text
intent://invite?v=1&port=<p>&fp=<sha256>&inviteId=<id>&secret=<s>&tc=<addr>&scope=host
```

No direct host/IP or bearer credential is included. Resolve the running listener
and tunnel before inserting; existing `listener-down` and `tunnel-down` failures
store nothing. Workspace links keep their existing v1 format; absent URL `scope`
means workspace. `WorkspaceInvite` adds `scope: "workspace"`; its lifetime,
unpinned reuse and pinned single-use behavior remain unchanged.

#### Scoped join and compatibility

The same four `/invite` methods serve both scopes. There is no `client.hello` on
this unauthenticated endpoint. A host link is recognized by its URL scope, then
the client requires an explicit host-scoped inspect response before consent/proof.
A missing scope in that response is an incompatible host, not a workspace fallback;
this prevents an older daemon that ignores the new param from changing the grant
the client described. Local proof-purpose support is detected separately through
the signing-in daemon’s hello. Each join method accepts optional
**`scope: "workspace" | "host"`**, default **`"workspace"`**, alongside its
existing params. A host join must send `scope: "host"` on **every** call.
The server validates the secret and open state before previewing metadata, then
requires the requested scope to match the stored invitation. A mismatch is
`-32602 { code: "invite-scope-mismatch" }`, with no preview/pin/credential payload.
An old client that ignores the host-link parameter therefore cannot silently
accept broader host access. An unknown URL scope is rejected by new clients.

| Method | Additions to params | Result in this contract |
| --- | --- | --- |
| invite.inspect | scope? | `InvitePreview` below; no forge lookup |
| invite.challenge | scope? | `InvitePreview & { nonce, nonceExpiresAt }`; existing bounds, single-use proof nonce and ten-minute lifetime |
| invite.prove | scope? | `AuthorizedJoin` below; existing provider/host/proofId/gistId params and proof engines |
| invite.accept | scope? | `AuthorizedJoin` below; existing credential/pin checks, no new proof |

```ts
type InvitePreview = {
  hostname: string; prettyHostname: string; pinIdentity: Identity | null;
} & (
  { scope: "host"; role: "member"; pinIdentity: Identity }
  | { scope: "workspace"; role: "collaborator"; workspaceId: string; workspaceTitle: string }
);
type AuthorizedJoin = {
  status: "authorized"; token: string; principalId: string; login: string;
  identity: Identity; hostRole: HostRole;
} & (
  { scope: "host" }
  | { scope: "workspace"; workspaceId: string }
);
```

Host responses omit `workspaceId`/`workspaceTitle`; they never invent a workspace
to navigate to, so joining an empty host works. Workspace responses retain all
legacy required keys. `pinIdentity` retains 10.8's triple/null/legacy-omission
distinction; wrong-secret/closed-link errors reveal no metadata. Host pins are
never null. `hostRole` on success reports **effective** authority: a host member
redeeming a workspace invite remains a member, not a downgraded guest.

Proof commits resolve the existing principal by the full identity triple. A
workspace guest upgraded to host member keeps its ID and prior shares; an active
member gains no duplicate membership. Host redemption and its one-use stamp,
membership and any newly minted credential commit atomically. Concurrent losers
get `invite-redeemed`. Workspace joins keep their archived/full/pin checks; an
already-effective host member consumes no guest seat or direct collaborator row.
The primary still receives `owner-self-join`. Unknown/revoked returning credentials
still receive `credential-invalid`, with no grant and no replacement token.

**Returning credentials are reused, not silently rotated.** In this contract
`invite.accept` returns the presented valid host-issued credential as `token`.
Existing devices and persistent pairing links remain valid when another invitation
is accepted. This changes the older accept behavior without changing its response
shape. A first proof join still returns a newly minted bearer; the host never
receives the invitee's forge token. Persist invited sessions in the existing
registry, keyed by host trust identity plus principal ID, not by workspace or
forge login. Refresh authority from `principal.me` after admission.

#### Removal, revocation and ordering

`host.members.remove` of an active member, and `principal.revokeSelf` by a member,
atomically remove its host membership and all direct workspace grants, revoke
**all** its host-issued bearer credentials and all still-redeemable workspace
invitations it issued, and invalidate its queued human messages on every workspace.
The existing self-revoke result retains `revoked`, `credentials`, `workspaces`
(direct grants dropped) and adds `hostMembershipRemoved: boolean`. Owner self-revoke
is still invalid. A workspace guest's self-revoke retains existing behavior.

The invitation sweep uses the **open/usable predicate**, not `redeemedAt IS NULL`:
used reusable links remain usable and must be revoked. Already closed history,
other issuers' links and guests admitted earlier are preserved. No other person's
credentials, workspaces, notes, commits or running agents/scripts are removed.
Already-running work continues; queued user instructions from the removed person
cannot start after the revocation commit (queue drain rechecks authority).

Creation/redemption, membership removal, pairing reads, queue admission and socket
admission share a serializable authorization boundary. In particular:

- Workspace invite creation rechecks the issuer's role inside the insert
  transaction. A creation that precedes removal is swept; one after it is refused.
- A guest admitted before an issuer's removal keeps its grant. A redemption after
  removal cannot use that issuer's revoked link, including a previously used link.
- An in-flight proof snapshots the authorization generation when its challenge is
  issued and rechecks the resolved principal's revocation generation at commit.
  Removal during proof cannot recreate the removed person's credentials. Return
  `-32602 { code: "access-revoked" }`; a later fresh proof with a valid invitation
  can grant **only that invitation's scope**. `invite.accept` rechecks its bearer.
- Reads and event deliveries after removal use current authority, even before a
  socket has physically closed. Registering a connection or pairing response
  cannot race past revocation and re-establish access. Startup reuses durable state.

Close affected `/ws` and `/tunnel` connections with **1008**, reason
`credential revoked`; drain only already-admitted responses, bounded to five
seconds, so self-revoke can acknowledge. Stop forwarding/events immediately at
revocation. Replayed bearers fail the upgrade with 401. Credential-specific
rotation/revocation closes every connection using that credential (several devices
may share it); principal removal closes all that person's credentials. Server-token
rotation similarly invalidates affected owner pairing links and token-authenticated
sessions, while trusted local UDS administration remains available.

#### Member execution and safe host reads

The member transport allowlist extends the existing guest allowlist with ordinary
workspace management: agent create/delegate/configure/delete, permission prompts,
Git/PR operations, terminals, scripts, hooks/monitors, previews/browser/forwarding,
workspace create/lifecycle/settings and guest sharing. Every dispatch path and
service check enforces the same role, including fast paths, aliases, aggregate
reads, subscriptions and reverse-RPC eligibility. Method/event catalogs must
classify members separately from guests; no `isAdministrator = true` shortcut.

Host `settings.*`, `server.*`, provider/account setup and credential export,
global MCP configuration/secrets, daemon maintenance and host membership/invite
administration remain owner-only with their existing local-only guards. Workspace
MCP enable/disable follows workspace management; the global toggle stays owner-only.
`agent.replaceMessages` remains owner-only because it accepts historical user rows;
ordinary member send/edit/queue paths always derive human attribution from the
bound principal. Messages, comments and sender preambles use that actual person;
the host’s shared execution account is never substituted as the human author. Existing per-user queue privacy and search-cancellation ownership
are retained. Payload principal/author fields cannot impersonate another human.

`/tunnel` admits owner and active host-member credentials using the existing
loopback-only stream protocol, credit windows and limits; workspace guests still
receive HTTP 403. Member removal closes live tunnels. Shared host membership
permits the same loopback preview reach as the owner; it is not hostile-tenant
isolation. Browser/reverse RPCs target eligible authenticated clients and cannot
use a supplied logical client ID to impersonate another principal.

Members read `providers.catalog`, `models.list`, `agent.getModels`, provider
discovery/readiness, `repo.list`, and workspace repository configuration from the
**connected host**. They do not read `settings.*` merely to populate controls.

| Method | Params | Result |
| --- | --- | --- |
| host.executionContext | — | `{ defaultProviderId: string \| null, defaultModelId: string \| null, repositoryConnections: { provider: "github" \| "gitlab", host: string, configured: boolean }[] }` — owner/member read; guests receive Forbidden |

The context is an allowlisted projection, never a settings dump. Defaults are
host-owned effective defaults, null when unset; provider/model catalogs keep their
existing response shapes. Connection rows describe configured execution accounts,
not the caller's identity; they expose no token, auth flow, environment or secret
configuration. Readiness probes use the existing bounded caches; ordinary reads
do not synchronously contact a forge or spawn a provider. `repoConfig` reads omit
secret values; account changes and global repository administration remain owner-only.

Repository credential selection follows the repository's origin and the host's
owner-configured accounts/helpers, never a member's login or proof credential.
Existing Git author/committer and repository overrides remain authoritative.
`sourceControl.github.exposeGitCredentialToChildren` still controls managed helper
injection; other owner-configured helpers remain usable. Missing repository/AI
setup affects only operations that need it. It cannot prevent invitations,
reconnect or otherwise-supported workspace creation. A connected GitLab identity
does not establish that a native GitLab repository/MR provider is available.

#### Collaboration credential purpose

Identity proof credentials and host execution credentials are separate purposes.
The new `identity.*` methods run on the signing-in person's **own daemon**, under
its administrator authority, as the existing proof publisher does. They are not
host-member account administration on the shared host and are not served by
`/invite`. Reuse the landed forge auth and proof engines; do not introduce another
proof mechanism or allow client-supplied identity to bind a connection.

| Method | Params | Result |
| --- | --- | --- |
| identity.authStatus | provider (req), host? | Existing `sourceControl.authStatus` shape plus `purpose: "collaboration"`, `requestedScopes: string[]`, `grantedScopes: string[] \| null`; no repository/env/CLI fallback |
| identity.connect | provider (req), host?, method?: `"device"` or `"pat"`, token? | Same device/PAT result alternatives as `sourceControl.connect`, plus `purpose: "collaboration"` and `flowId: string` for a device flow |
| identity.cancelAuth | provider (req), host?, flowId (req) | `{ ok: true, cancelled: boolean }` — cancels only that collaboration flow, false if superseded/absent |
| identity.revoke | provider (req), host? | `{ ok: true }` — deletes only this collaboration credential and aborts its pending flows; no repository logout or Intent-session revocation |
| identity.getUser | provider (req), host? | `{ user: SourceControlUser \| null }` — the collaboration credential's authoritative account, using the existing DTO |
| identity.select | provider (req), host?, externalUserId (req) | `{ principal: PrincipalMe }` — explicitly selects the verified collaboration account as this daemon's primary profile; the returned principal is the complete `principal.me` shape |

`provider` and host syntax follow the generic auth contract (GitHub's host param
is omitted; GitLab defaults to `gitlab.com`, not repository settings). The secret
and flow key is `(local primary principal, provider, canonical host, purpose)`.
Repository APIs and their legacy GitHub aliases retain their old params, response
shapes and purpose. `identity.*` always means collaboration; it cannot write
`sourceControl.*.token`, change a repository's bound instance, feed repository
lookup or inject credentials into children. Do not silently copy an existing
repository token into a collaboration slot or vice versa.

For GitHub, collaboration device authorization requests `gist` for proof, never
`repo` or `workflow` merely to join. GitLab proof still requires `api` for its
public snippet; UI must explain that broader provider permission accurately.
`grantedScopes` reports the actual observed grant, null if the provider cannot
report it; never equate requested and granted scopes or describe a previously
broader grant as reduced. Device/PAT support and typed auth/scope/rate-limit errors
reuse §5.27. Unsupported device grant keeps its explicit PAT recovery. PAT support
does not expand beyond the existing provider engine's supported methods.

`sourceControl.identityProof.create` and `.delete` gain optional **`purpose:
"repository" | "collaboration"`**, default `"repository"` for old callers.
With collaboration purpose they use **only** the isolated credential and no
fallback. `create` additionally requires **`expectedIdentity: Identity`** in this
mode, checked against a fresh authoritative account and again against the
credential/selection generation before completion; a mismatch or superseded
selection is `-32602 { code: "identity-mismatch" }`. Proof cleanup stays bound to
the credential generation/account that published it; an account switch must not
delete another account's data. Result shapes, GitHub aliases and proof visibility
are unchanged. Clients send the purpose only after `collaborationIdentity: 1`;
an older daemon might ignore an unknown parameter, so falling back to repository
auth is forbidden. Offer an upgrade/recovery path without modifying repository
connections. The inviter's verification still uses only public proof/account data.

Pinned joins select the exact required provider/instance/stable ID; unpinned joins
use the person's explicitly selected identity. Missing credentials lead to
collaboration sign-in for that choice, not an implicit switch to another connected
forge. Keep 10.8's pin metadata privacy and legacy-host fallback semantics when
using the legacy flow; never interpret malformed metadata as unpinned.

Connecting/revoking a repository account or collaboration credential does **not**
implicitly re-key an existing principal, unlink its cached identity, revoke host
membership or replace valid Intent sessions. `identity.select` is the explicit
selection path and emits `principal:identity-changed`; its supplied stable ID must
match the verified account (`identity-mismatch` otherwise). A triple already bound
to another local principal is refused (`identity-in-use`), never merged. The
existing `identity.provider` setting remains an explicit legacy selection path;
ordinary token/profile refresh is not a selection. Preserve its generation fences
so an older in-flight refresh cannot undo a newer choice. Existing migrated
identities remain linked without requiring sign-in again. No automatic cross-forge
linking occurs. Identity selection changes profile identity, never the primary's
Intent principal ID/owner authority or another person's pinned invitation.

#### Persistent personal pairing and authenticated devices

| Method | Params | Result |
| --- | --- | --- |
| pairing.getSelfInfo *(fast path)* | — | Existing `pairing.getInfo` fields `{ uri, hosts, port, fingerprint, token, version: 1, tcAddress? }` plus `{ principal: PrincipalMe }`; current authenticated owner/member/guest, over UDS or WSS |

`pairing.getSelfInfo` returns the credential that admitted **this connection**.
For trusted local UDS administration it uses the existing owner pairing credential.
Target principal, role or credential override params are rejected with
`-32602 { code: "invalid-params" }`. It never mints a membership, rotates a bearer,
or exports repository/AI credentials. Retain the
admitted bearer only in protected connection memory to construct this response;
per-principal durable credentials remain hash-only. Revalidate its current
credential/authority before returning it. Invalid/revoked authority is
`-32003 { code: "access-revoked" }` and no token is returned, followed by closure.

The **same existing `intent://pair?v=1&host=…&port=…&fp=…&token=…[&tc=…]` payload**
is both QR contents and copyable link. It is persistent and reusable: displaying
or scanning never consumes it, and there is no automatic expiry, one-use ticket
or required per-device credential. Repeated calls on the same credential return
the same bearer; route changes can update the surrounding URI. Several devices
may share it across restarts. Revocation/rotation invalidates **all** uses of that
credential, including previously paired devices; member removal invalidates all
that person's credentials. Merely disconnecting one device does not revoke it.

Pairing retains direct and tunnel routes, the existing listener/no-dialable-route
failures, and TLS fingerprint verification. It does not inherit invitation
links' tunnel-only policy or seven-day lifetime. Fetch it from the selected
connected host; a local sidecar must never substitute its pairing material for a
remote-host request. Show that host and the returned current person. Profile and
role in a QR label, URL, saved record or device name are not authentication.

`client.list` rows add always-present `principalId`, `hostRole`, `login: string |
null`, `displayName: string | null`, `avatarUrl: string | null`, plus optional
`identity`, derived from the credential binding. Existing `clientId`, device
name/kind, connection count/transports and connected timestamp remain. IDs identify
logical devices, not credentials: different devices generate different IDs even
when sharing one bearer. Dedup uses the authenticated principal and logical ID;
client names/IDs/hello fields cannot claim another person. Non-owner IDs retain
their principal namespace. Owner/member callers see the host roster; guests see
only their own principal's rows. Absent identity fields on an old daemon mean
unknown, never owner. `client:connected`, `client:disconnected` and the new
`client:updated` apply the same visibility policy.

**Desktop/iOS persistence and iCloud.** On a new pairing, authenticate, pin TLS,
read `principal.me`, then classify/persist. An authoritative owner continues to
use the existing owner-backend registry and owner-backend sync service. A member
or guest uses the **existing invited-session registry and its encryption/sync
path**, including credentials and direct/tunnel routing metadata. No third
registry is introduced. Key invited records by host trust identity (including
fingerprint) **and principal ID**; the same host/fingerprint does not identify a
person. Never publish invited credentials through the owner-backend publisher or
overwrite another person's record based on host/fingerprint or a newer timestamp.
An upgraded guest keeps the same invited-session record after becoming a member.

Only after role validation may a newly scanned link be published/synced. Preserve
legacy saved owner backends and legacy owner pairing behavior, but unclassified
new credentials remain pending verification and cannot be promoted to owner by
an old record's type. On each reconnect, refresh authority and route information;
sync timestamps are not authorization. Removal tombstones and credential
revocation win over stale sync; replayed revoked credentials stay refused. Do not
log bearer URLs, credentials or personal identity in pairing diagnostics.
Owner-only legacy iOS clients retain the old owner path; shared-host personal
links require a role-aware client and must not be advertised as supported by an
older client merely because it can parse a v1 URI.

#### Live events and resynchronization

| Event type | Data | Delivery and consumer action |
| --- | --- | --- |
| `host:members-changed` | `{ revision, principalId, hostRole: "member" \| "guest", action: "added" \| "removed" }` | Durable global event; owner/active members, plus the affected principal as a final control notification on removal. Other guests cannot observe host membership. `guest` on removal describes absence of host membership, not a surviving grant or credential |
| `host:invites-changed` | `{ inviteId, action: "created" \| "revoked" \| "redeemed" }` | Durable global event, owner-only; refresh host invite list; never contains secret/link/pin |
| `host:execution-context-changed` | `host.executionContext` result | Durable global event, owner/member-only; sanitized snapshot after effective defaults/configured connection state changes, never auth-flow data |
| `identity:auth-changed` | `{ provider, host, purpose: "collaboration", status, flowId? }` | Same terminal status enum as `sourceControl:auth-changed`; signing-in daemon's owner only, separate from repository auth events |
| `client:updated` | Complete corresponding `client.list` row | Transient global event after hello metadata or effective role/profile changes; owner/member host-wide, guests self-only |

Membership revision increments once per effective membership mutation, not per
workspace. A no-op publishes nothing. Commit before publishing; invalidate access
caches **before** any post-commit read/egress. `host:members-changed` is the explicit
global invalidation exception to self-sufficient workspace deltas: consumers
re-read their principal, visible workspace snapshot and any open roster. Coalesce
refreshes; if a newer revision arrives during a read, re-read rather than apply
stale authority. The workspace subscription's server-side snapshot/delta boundary
must also reconcile newly visible/removed workspaces on an upgrade, with no lost
concurrent workspace creation and no per-member persisted grant fan-out.

Existing workspace events now reach effective members, including permission,
terminal, script, browser and preview events needed for management. Filter at
delivery and durable-query time, including aggregate queries. Guests retain the
existing event allowlist and workspace narrowing, apart from the explicit own-
device events above. Own-principal identity changes may be delivered to that
principal; unrelated global identity/settings/auth events remain hidden. Permission
requests, their filtered/aggregate snapshots and answers all use `canManage` and
the prompt's workspace (§8); guest access is not broadened by a transport allowlist.

#### Multiplayer lab rollout (client policy)

The existing saved **`labs:multiplayerEnabled`** preference is default-off; missing
or unhydrated means off. It gates the Collaboration **tab itself**, page content,
host invites/members, workspace sharing/rosters/presence entry points, joined-host
navigation, collaboration sign-in, and the new shared-host pairing/device controls.
Direct settings routes, legacy aliases, commands/search and open dialogs obey the
same selector. Disabled incoming invites offer explicit enable-Multiplayer recovery
before the join; they do not silently enable it. The GitLab lab is independent and
cannot bypass Multiplayer. Compose visibility with actual server capabilities and
current role. Enabling a local preference grants no daemon authority.

Disabling hides/dismisses experimental surfaces and stale actions without deleting
saved sessions, revoking membership, rotating links or stopping shared work. Keep
ordinary single-user controls and the legacy owner Devices/pairing flow available.
Re-enabling refreshes server authority before showing management actions.

#### Required behavioral conformance

Component implementations must add unit/functional tests and real WSS assertions
for each new method/event and these boundaries. This documentation change defines
the assertions; passing documentation gates is not runtime evidence.

| Scenario | Required observable result |
| --- | --- |
| Unlinked/no-repository owner invites GitHub and GitLab people | Pinned invite succeeds when publicly verifiable; restricted instance is typed `identity-unverifiable`; no repository setup side effect |
| Host invite sent through an old client or wrong scope | `invite-scope-mismatch`, no membership/credential; invalid secret reveals no preview/pin |
| Correct host join, wrong provider/instance/ID, duplicate concurrent redemption | Member on correct proof; mismatch refused; exactly one pinned redemption wins; empty host remains usable |
| Guest upgrade with old collaborator rows and full guest-seat usage | Same principal, all workspaces, truthful `myRole`, `canManage: true`, deduplicated roster and no guest seat spent |
| Owner/member/guest management over every WSS path | Members create/manage including prompts/terminals/previews; guests remain narrowed; settings/account/host administration remains owner-only |
| Filtered/aggregate permission reads and live answers | Owner/member can act; guest sees no unauthorized request or ID and cannot answer it |
| Repository disconnect/swap during identity proof/selection | Existing Intent identity/session survives; generations reject stale/mismatched proof; repository and collaboration secrets stay isolated |
| Remove member racing create/redeem/queue drain/pair/admission | No late credential/grant/invite resurrection; used reusable issuer links revoked, earlier admitted other guests preserved; running work survives |
| Reuse a personal QR on several devices, restart and accept another invite | Same person/credential remains usable, distinct device IDs; no countdown, proof repetition or silent rotation |
| Remove/rotate shared personal credential and reconnect every device | All affected links/sessions fail; unrelated people and work remain; TLS/route parity retained |
| Device identity spoof and guest device query/subscription | Server-derived person/role; no unrelated device/principal leak through snapshots, live or durable events |
| iOS owner/invited sync, two people on one host, stale synced bearer | Correct existing registry/publisher, no cross-person overwrite, authoritative role refresh, revocation/tombstone wins; native fixtures and real device evidence |
| Lab missing/off/on, route aliases, runtime disable, both GitLab flag states | No hidden experimental content mounts; explicit recovery; owner legacy pairing and saved access preserved |
| Old daemon/client and different local/remote host setup | Legacy owner/guest behavior only; no unsupported purpose fallback; selected host supplies roles/models/repos/pairing after every reconnect |
