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
| host.executionContext | — | `{ defaultProviderId: string \| null, defaultModelId: string \| null, enabledProviderIds: string[], repositoryConnections: { provider: "github" \| "gitlab", host: string, configured: boolean }[], gitCredentialPolicy: GitCredentialPolicy }` — owner/member read; guests receive Forbidden |

The context is an allowlisted projection, never a settings dump. Defaults are
host-owned effective defaults, null when unset; provider/model catalogs keep their
existing response shapes. Connection rows describe configured execution accounts,
not the caller's identity; they expose no token, auth flow, environment or secret
configuration. **`configured` is not an authorization check**: a stored token can
be expired, revoked or lack access to the requested repository. Readiness probes
use the existing bounded caches; ordinary reads
do not synchronously contact a forge or spawn a provider. `repoConfig` reads omit
secret values; account changes and global repository administration remain owner-only.

`enabledProviderIds` is always present on supporting hosts. It contains unique,
canonical IDs from the connected host's provider registry in deterministic order,
derived from the host's existing execution enablement gate:

- A registered provider that can be disabled is excluded only when its effective
  `providers.enabled[id]` entry is explicitly `false`. An absent map or absent
  entry means enabled; an explicit `true` also means enabled.
- Registered providers that cannot be disabled remain included, even if their
  map entry is `false`. Unknown map keys never add a provider to the result.

This projection reports execution enablement policy only. It does not report
installation, environment or feature gates, authentication, or current readiness.
An installed provider can be disabled; an enabled provider can be unavailable.
Members combine it with that host's existing catalog, discovery and readiness
surfaces when offering provider/model choices. The raw settings map and account
setup remain owner-only, and the owner's existing enablement policy is unchanged.

If `enabledProviderIds` is missing or malformed, including on an older host,
members treat enablement as unknown. Never infer enabled choices from local
settings, installation/discovery, defaults, or all known providers. Preserve the
current agent/provider/model display while withholding unsupported cross-provider
choices until a valid projection from the current connection is available.
Ordinary owner and legacy setup continue through their separate existing paths.

`GitCredentialPolicy` is this non-secret, always-present projection of the
connected host's effective managed-helper policy:

```typescript
type GitCredentialPolicy = {
  provider: "github";
  protocol: "https";
  host: "github.com";
  managedHelperEnabled: boolean;
  setting: "sourceControl.github.exposeGitCredentialToChildren";
};
```

`managedHelperEnabled` reports the effective switch used for child-process helper
injection and `system.gitCredential`, not whether a token resolves or a Git
operation will succeed. It reveals no helper command, environment, token source,
credential or account identity. `system.gitCredential` remains UDS-only and its
`credential: null` cases remain indistinguishable; members never call it to
diagnose policy. `settings.*` and account setup remain owner-only.

Repository credential selection follows the repository's origin and the host's
owner-configured accounts/helpers, never a member's login or proof credential.
Existing Git author/committer and repository overrides remain authoritative.
`sourceControl.github.exposeGitCredentialToChildren` still controls managed helper
injection; other owner-configured helpers remain usable. Missing repository/AI
setup affects only operations that need it. It cannot prevent invitations,
reconnect or otherwise-supported workspace creation. A connected GitLab identity
does not establish that a native GitLab repository/MR provider is available.

When managed injection is disabled, member Git/terminal/agent surfaces explain:
“This host's owner disabled Intent's managed GitHub credential helper with
`sourceControl.github.exposeGitCredentialToChildren`. Ask the owner to review
that setting or the host's other Git authorization.” This is a policy hint, not
a ban on Git or proof that authorization is absent. Other owner-configured
helpers, SSH and unauthenticated operations remain usable; do not block an
operation solely because the switch is off or `configured` is false. Never
automatically enable it, initiate member account setup, or substitute a member's
repository/collaboration credential.

For a daemon-classified missing/rejected Git or AI execution authorization,
member-facing failures carry this safe diagnostic:

```typescript
type ExecutionAuthorizationFailure = {
  resource: "git" | "ai";
  reason: "missing" | "rejected" | "insufficient-scope";
  providerId: string | null; // selected execution provider, null if not determined
  host: string | null; // canonical forge host for Git, null for AI/unknown host
  recovery: {
    actor: "host-owner";
    action: "check-git-authorization" | "check-ai-authorization";
    setting?: "sourceControl.github.exposeGitCredentialToChildren";
  };
};
```

Existing object-shaped typed auth errors keep their numeric code and `data.code`
and add `data.executionAuthorization`. Previously untyped authorization failures
on the new member execution paths use `-32603` with
`data: { code: "host-execution-authorization", executionAuthorization }`.
Existing owner/legacy error contracts are unchanged. An asynchronous AI failure
adds the same optional `executionAuthorization` to the existing `agent:failed`
data, with the same workspace visibility filter. The diagnostic never contains
provider response bodies, secret URLs or credential values. `rejected` includes
expired/revoked credentials without claiming to distinguish those causes.
Only classified authorization failures use it: network failures, rate limits,
missing repositories and provider availability keep their existing errors.

Recovery must name the **connected host** and ask its owner to configure missing
Git/AI execution authorization or renew/check rejected authorization and scopes,
then retry the affected operation. For an operation in the managed helper's
HTTPS `github.com` scope, include `recovery.setting` when that switch is disabled;
explain the alternative-helper option
without asserting no alternative exists. Arbitrary terminal output is not a
structured authorization result: retain the policy hint and ordinary command
output, never guess an auth diagnosis merely from a nonzero exit. Missing/revoked
AI authorization cannot be recovered with a member's local provider account.

Refresh `host.executionContext` and the existing provider readiness reads from
the selected host after **every reconnect** and host switch. Discard responses
and events from an earlier connection/host; old enablement must not authorize
choices while the new context is loading. `host:execution-context-changed` carries
the complete context, including `enabledProviderIds`, and invalidates these reads
after committed `providers.enabled` changes (including entry removal or map
reset), defaults/helper-policy changes, repository connect/revoke/token-source
changes, AI account/setup changes, and an observed authorization/readiness
transition (including an operation discovering a revoked credential). A read
started before an invalidation must not overwrite the newer context; discard it
and refresh for the current connection. Emit the sanitized event even when the
configured flags remain unchanged. Unknown or stale readiness is not success;
external revocation becomes observable through bounded readiness refresh or the
affected operation, not a promise of instant push from the provider. Raw
settings/auth-flow events remain owner-only.

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

#### Desktop/iOS invited-session sync format

On a new pairing, authenticate, pin TLS, read `principal.me`, then classify and
persist. An authoritative owner continues to use the existing owner-backend
registry, **`com.cloudlands.intent.backends` service and payload v1 unchanged**.
A member or guest uses the existing invited-session registry, local credential
encryption and **`com.cloudlands.intent.guest-sessions`** synchronizable Keychain
service in the existing shared access group. There is no third registry/service.
Desktop and iOS implement the same **invited payload v2** below; version dispatch
must be service-specific, not a bump to the shared owner payload constant.
The persistent **pairing URI remains v1**; its version is unrelated to this
Keychain JSON payload version.

The baseline desktop invited payload is already v1 with optional `principalId`
and `login`. Its reconciler indexes by normalized `host:port`, merges by
fingerprint, and its store can replace a surviving row's principal/token. Its
parser returns `newer-version` for `v > 1` before parsing record fields, but the
ordinary reconciliation loop skips **only that exact account**. This is not a
write barrier: a v1 tombstone at another address can match a local row by
fingerprint and propagate a tombstone over the skipped account without checking
its frozen status. The old reader also logs every newer-version **account name**.
Pinned iOS's v1 fingerprint/address parser and publisher serve the owner registry.
Consequently neither additional v1 fields nor only a v2 version bump establishes
safe invited-person coexistence or diagnostic privacy.

##### Account and payload

The sole invited-person identity is **(TLS certificate SHA-256 fingerprint,
Intent principal ID)**. Normalize the fingerprint to 64 lowercase hex digits
(accept the existing colon-separated hex spelling; reject malformed/absent
pins). Treat `principalId` as a nonempty opaque UTF-8 string: no trimming,
case-folding or Unicode normalization; reject invalid Unicode scalar sequences.
All **new accounts** use opaque SHA-256 digests, with these exact byte encodings
shared by desktop and iOS:

```text
LP(s) = U32BE(byteLength(UTF8(s))) || UTF8(s)
I = HEX_DECODE(fingerprint) || LP(principalId)
S = SHA256(ASCII("intent.invited-sync/v2/session") || 0x00 || I)
sessionAccount = "invited-v2-s:" || LOWER_HEX(S)

A = U32BE(legacyAccounts.length) || LP(legacyAccounts[0]) || ...
R = SHA256(ASCII("intent.invited-sync/v2/removal") || 0x00 || I
           || UUID_BYTES(removalId) || U64BE(removedThrough) || A)
removalAccount = "invited-v2-r:" || LOWER_HEX(R)
```

`||` concatenates bytes; integer encodings are unsigned, big-endian and fixed
width. The fingerprint decodes to exactly 32 bytes. UUIDs use the 16 bytes in
canonical textual hex order, never platform-native GUID byte order. The digest
uses all 32 output bytes (64 lowercase hex digits), without truncation. Array
entries are unique and sorted by unsigned UTF-8 byte order; no JSON serialization
or locale-dependent ordering enters the hash. A removal's immutable fields are
defined below. Both the full and compact mutable session use `sessionAccount`.
Each independent removal uses `removalAccount`; live/route writes never address
that namespace. These derivations are verified against every decoded record's
identity and, for live admission, against the authenticated `principal.me`.

The session key is used for local person matching, import and credential
replacement. No host, port, login, external identity, role or timestamp
participates in that key. B and C on one fingerprint have different keys; route
changes and guest-to-member upgrade keep the person's key. A certificate change
requires explicit trust validation and cannot merge people merely because a
route is unchanged.

The old reader's warning receives only a digest account, with no raw fingerprint
or reversibly encoded principal, for **session, compact-session and immutable
removal** records. Digests are correlatable identifiers, not secrets or anonymity
against someone who already knows the inputs. New clients still redact these
keys from diagnostics. Legacy-alias markers reuse an **existing** v1 host:port
account, rather than creating a new account namespace, and contain only opaque
session-key references; no identity tuple is added to that old account name.

Encoding vectors use fingerprint hex `ab` repeated 32 times. The removal vector
uses principal `B`, `removalId: "00000000-0000-4000-8000-000000000001"`,
`removedThrough: 200` and `legacyAccounts: ["old.example:443"]`:

| Record / principal UTF-8 bytes | Exact account |
| --- | --- |
| Session B / `42` | `invited-v2-s:8e4ca5301c7e9fdeb66c53a80eb0c36dcd84707596e010f972342e9631b39c02` |
| Session C / `43` | `invited-v2-s:8b7992fc9596dc890a8acb87157e82a26cbf1cea7e7f3cf1d6747198b3db5015` |
| Session é (U+00E9) / `c3 a9` | `invited-v2-s:397d72f58023e3b4931f01f0f521bdb0cb82260caedf458af7c2a0c57e22ab78` |
| Independent removal B / inputs above | `invited-v2-r:afb2ccf2baac828571f18cf41dc2df0f1e6938f53476efeda9aad4738b4ef56f` |

The mutable JSON at `sessionAccount` is a `session` or compact `removed` record.
The independent, token-free `removal` record is stored at its own account:

```typescript
type InvitedSessionV2 = {
  v: 2;
  kind: "session";
  fingerprint: string; // canonical 64 lowercase hex digits
  principalId: string;
  label: string;
  login: string | null; // display only; a missing profile cannot imply owner
  host: string;
  hosts: string[];
  port: number;
  hostname: string | null;
  detectHosts: boolean;
  tcAddress: string | null;
  tcUpdatedAt: number | null;
  token: string; // nonempty when live; exactly "" when deleted
  updatedAt: number;
  pairedAt: number;
  removedThrough: number; // cached floor only; 0 until a removal is observed
  deleted: boolean;
  deletedAt: number | null; // set iff deleted
  legacyAccounts: string[];
};
type RemovedInvitedSessionV2 = {
  v: 2;
  kind: "removed";
  fingerprint: string;
  principalId: string;
  token: "";
  updatedAt: number;
  removedThrough: number;
  legacyAccounts: string[];
};
type InvitedRemovalV2 = {
  v: 2;
  kind: "removal";
  fingerprint: string;
  principalId: string;
  removalId: string; // canonical lowercase UUID v4, persisted once per removal
  removedThrough: number; // positive safe-integer clock, fixed for this removal
  legacyAccounts: string[]; // immutable snapshot, sorted as specified above
};
```

All fields above are required. Session records preserve existing optional `accent`,
`detectedDeviceKind` and `deviceIcon` preferences with their existing enum values;
they have no identity/authority effect. Immutable removals contain no bearer,
profile or current-route fields. Ports are integers in 1–65535. Clocks
are finite safe-integer epoch milliseconds, never JSON booleans or numeric
strings; `removedThrough: 0` is the no-removal sentinel only in mutable records.
`legacyAccounts` is a sorted unique set of retired v1 account strings, whose historical normalization
remains `host.trim().toLowerCase() + ":" + port`. Validate the canonical account
against the exact derivation before applying or writing any record. A mismatch,
malformed payload, unsupported version/kind, or newer payload freezes that
account: preserve its bytes, do not purge, pull as live, downgrade or overwrite.
A frozen session account also blocks publication/import for that person
through any legacy alias; do not evade the freeze by changing the account key.
An unreadable/unknown row in the `invited-v2-r:` removal namespace must not be
treated as an empty removal set:
preserve it and defer invited-session import/publication until it can be read
or recovered, without erasing existing local sessions or touching owner sync.

No synced role is authority. A synced candidate remains pending until the
credential authenticates against the pinned host and `principal.me` matches the
record's principal and an invited role. A mismatched/unknown role cannot re-key
the record or promote it into the owner publisher. New pairings and v1 live
migrations must pass the same check before first publication. Failed local
encryption or Keychain access never authorizes plaintext persistence. A list
failure/locked or unavailable Keychain is unknown state, not an empty registry
or a signal to erase local records.

##### Clocks, routes and deletion

Within one person, retain last-writer-wins `updatedAt`, monotonic local mutation
clocks (`max(now, all observed clocks + 1)`) and deletion winning an equal-clock
live/deleted tie. On every successful list, discover and validate **all removal
records before considering live records**, independently of whether any session
or alias item is present. Fold `removedThrough` by **maximum** across immutable
removals, local durable removal observations and mutable caches for that person;
fold `legacyAccounts` by **set union** across them before selecting a winner. A newer
route or label edit cannot discard either. Select the credential from the
greatest admissible `pairedAt` before merging metadata by `updatedAt`; a later
route edit of an older pairing cannot replace a newer bearer. Among equal-clock
live route variants, the lexicographically larger normalized legacy `host:port`
wins as in v1. Equal route/clock copies are otherwise unchanged; do not rotate
credentials on a read.

`pairedAt` is the saved clock of the last deliberate, authenticated pairing or
rejoin, not a foreground/reconnect/route-edit time. Forgetting a person or
observing applicable authoritative revocation first records a durable local
removal/outbox entry for that exact person: new monotonic `removedThrough`, one
random UUID v4 `removalId`, and the known legacy-account snapshot. Retries reuse
these **same immutable fields and account**; they never create a fresh clock.
Persist local forgetting before any sync attempt, including while offline or
sync-disabled. Publication must successfully insert the independent removal
record **before** writing the mutable session tombstone or retiring aliases.
The tombstone is a cache with `updatedAt = removedThrough`, empty token and
`deletedAt = now`; its presence alone is not a completed shared removal.

Removal publication uses a **create-only** Keychain insertion. On a duplicate,
read and validate the existing record: equivalent known immutable fields are an
idempotent success with stored bytes left untouched; disagreement, unknown/newer
format or invalid data is a preserved conflict requiring recovery. Do not use
the existing helper's generic duplicate-to-`SecItemUpdate` path for removals;
implement the create-only operation on both platforms. A read followed by that
blind upsert is not compare-and-swap. Hashing all known immutable removal fields
also gives independently created removals distinct accounts; no live/route writer
or compactor may update or delete one. This rule applies across shared/default
access groups, with successful destination insertion before any group cleanup.

A live copy with `pairedAt <=` the merged removal floor cannot restore
that person, **even with a later route `updatedAt`**. Keep the winning removal
locally when credential storage or a later sync write fails. Only an explicit
authenticated re-pair/rejoin may set a new `pairedAt >` all currently observed
removal floors, after a successful complete invited-service read. It retains
the removal memory; it neither deletes immutable removals nor makes routes a
new pairing intent. A later-delivered higher removal floor is still applied.
Offline retries, ordinary reconnects and delayed publications cannot manufacture
that intent.
An unclassified network/availability failure is not authoritative revocation.
Apply a failed reconnect's revocation only if its principal, bearer and saved
`pairedAt` still match the current record; a late failure from a superseded
credential cannot tombstone a newer successful pairing.

The existing 30-day `deletedAt` window still controls retention of full deleted
session details. That mutable item may compact to `kind: "removed"`, retaining
the person key, cached floor, `updatedAt`, empty token and legacy-account set.
The **independent removal records are already minimal and remain immutable
indefinitely**, including after re-pair, session compaction or loss/overwrite of
the mutable cache. Do not TTL-purge them, consolidate them into a replaceable
maximum-floor item, or delete earlier removals because a later one exists.
Legacy-alias markers are also retained. Owner-backend tombstone rules are unchanged.

For example, X may read B's live `pairedAt: 100, removedThrough: 0`, while Y
inserts B's removal at 200 and goes offline. X's delayed whole-item route write
may replace the mutable session with `updatedAt: 300, pairedAt: 100, removedThrough: 0`.
That overwrite is allowed by the storage primitive; it **cannot address the
separate removal account**. A fresh importer that receives both records folds
floor 200 and rejects B's live record, even after the session cache was compacted
and without Y reconnecting. Repair of the mutable cache is optional to this
decision; C's independent person state is unaffected.

This is durable retention and convergent import, **not globally atomic iCloud
delivery**. Keychain insertion success means local durable publication queued
for synchronization, not that every device has received the removal. A device
may see stale live data before the removal arrives; once it observes the removal,
it must retain/apply that floor on later passes even if a subsequent list omits
it. Interrupted publication remains locally suppressed and visibly pending until
the immutable write succeeds. Client forgetting does not revoke a still-valid
server bearer; explicit host revocation is separate and rejects that bearer
regardless of sync delivery. Tests must cover both cases without substituting
server rejection for the client-forgetting assertion.

Preserve candidate direct hosts, port, hostname, host detection and opaque,
case-sensitive tunnel addresses. Unknown/missing v1 `tcAddress` becomes
`tcAddress: null, tcUpdatedAt: null`; a known v1 address carries its original
record clock. Unknown routing never clears a known route at an equal clock.
In v2 an observed route update or conclusive clear has a new `tcUpdatedAt`
(`tcAddress: null` with a non-null clock means clear); higher route clock wins,
and a clear wins an equal route-clock tie. A route-only publication merges into
the current surviving person record, retaining its credential, `pairedAt` and
cached floor. A stale write may still replace that cache; it cannot make an old
pairing admissible once the independent removal is observed. Import must also
retain any newer pairing already observed instead of replacing it with a stale
route writer's bearer.
On every reconnect, revalidate role/credential and refresh direct/tunnel routes;
sync clocks and cached profiles do not grant access. Server revocation still
refuses a replayed bearer even before its tombstone reaches another device.

##### Migrating v1 and coexisting with old writers

Do a successful complete list of the invited service and inspect all local and
remote copies (including legacy access-group copies) **before** migration writes.
Build person candidates and retirement metadata first; row iteration order must
not decide which person or tombstone survives. Continue the existing fail-soft
shared-access-group migration: publish the surviving record successfully before
deleting a legacy-group copy, scope deletes to its group, preserve any unknown
copy, and stop side effects when sync is disabled. No migration mutates the
owner service or creates an owner entry from an invited token.

| v1 state | Required migration |
| --- | --- |
| Live with fingerprint and `principalId` | Authenticate and require the same principal from `principal.me`. Group only that fingerprint/principal, preserve routes/metadata, choose the v1 LWW winner with delete-on-tie and the existing host-account tie-break. Publish at its v2 person key. Keep the original pairing clock if available, otherwise the winning legacy `updatedAt`; a zero pre-sync clock is stamped once at first validated publication, after checking removals |
| Live without `principalId` (or without a usable pin) | Keep encrypted and pending; never infer person from host, login, another person's record or registry category. Only a successful pinned authentication may fill the principal. Without a trustworthy pin require explicit re-pair/trust recovery. Offline/unverifiable entries are not published as v2 live |
| Unexpired deleted record with fingerprint and `principalId` | Apply the legacy LWW/deletion tie rule only within that person, then durably insert an independent v2 removal before publishing its cached tombstone. Preserve the winning removal clock (use 1 for a legacy zero clock); persist the chosen removal ID before retrying. It cannot delete another person at the same host |
| Deleted record without `principalId` | Resolve only through previously saved, unambiguous **exact legacy-account-to-person provenance**. Host/fingerprint matching or “the only current person” is insufficient. Without provenance, preserve/quarantine it and withhold ambiguous v1 live migration under that alias; offer explicit re-pair/forget recovery, never a host-wide delete |
| Expired v1 tombstone or route-convergence tombstone older than a surviving live record | Keep the v1 TTL/LWW result; do not turn a losing cleanup marker into a new person removal. Previously observed local removal suppressions still win over stale live publication |
| Existing v2 person state, independent removal or retired alias, alongside v1 copies | The v2 state/retirement fence wins **regardless of the v1 clock**. Never import a delayed v1 live record, credential replacement, route edit or deletion over it |

Persist the full attributable candidate set and removal observations locally
before publishing v2. For each migrated person retain every known legacy account
in `legacyAccounts` (including accounts from stale route copies). After the
affected canonical v2 records/removals are durable, retire each fully classified
legacy account in place with this token-free payload in the **same service**:

```typescript
type InvitedLegacyAliasV2 = {
  v: 2;
  kind: "legacy-alias";
  personKeys: string[]; // sorted union of canonical person keys using this alias
};
```

This is a migration marker, never a credential or a host-wide deletion. The
account name stays the old normalized `host:port`; the pinned v1 parser therefore
sees `v > 1` and the ordinary **same-account loop skips it**. However, the pinned
v1 reconciler's cross-account tombstone path can still overwrite a visible
marker: it matches a live local row by fingerprint and calls
`pushTombstone(match.account, ...)` without checking the destination's frozen
status. An account shared by B and C can name both; it never merges their
canonical records. Do not replace an unresolved/malformed/newer legacy record
merely to install a marker.
Preserve unknown fields/versions rather than rewriting them as known v2.

The marker is a compatibility aid, not a lock: besides that cross-account write,
an old writer may have read before migration, write while offline, or invent a
new host account after a route change.
New clients must ignore such v1 writes when either the legacy alias is retired
(derive retirement from **all canonical sessions, independent removals and
markers**) or the verified person already has any v2 state, including a compact
session cache or independent removal. Ignore legacy tombstones in the same way;
they cannot delete C while retiring B. Restore
known alias markers after delayed or cross-account v1 writes, preserving the
union of opaque session keys; never overwrite an unknown/newer value. Do not
synthesize a newer live clock to
“win” against legacy data. Unknown or missing-person v1 records stay quarantined
until classified; they cannot bypass a canonical freeze or retirement fence.

New clients publish no live v1 mirror and never let the old host/fingerprint
matcher run on v2 invited records. Old desktop clients may continue using their
already saved, still-authorized local credentials, but cannot edit, forget or
add people in a migrated shared registry reliably; those cross-device actions
require upgrading. An old writer's deletion after migration does not become a
new person-wide deletion. Owner-only legacy iOS clients retain their old owner
path; personal shared-host links require a role-aware client and cannot be
advertised as supported merely because it parses a v1 URI. Do not log bearer
URLs, credentials, identity tuples or account keys in new pairing/sync diagnostics.
Supported old readers still log account names; the digest encoding above is what
keeps those old warnings from exposing the tuple, not new-client redaction.

##### Required mixed-version fixture

Desktop and native iOS must consume matching fixture vectors for encoding,
parsing, local-store application and reconciliation, including the pinned v1
parser/reconciler as the old writer, with a recording logger. Execute both
platform encoders against the other decoder and the exact account vectors above,
reorder input rows and interrupt/retry writes. This is a future
component test requirement, not a claim of runtime or physical iCloud evidence.

| Fixture step | Required observation |
| --- | --- |
| Owner A plus legacy guest B, and new member C on the same fingerprint/host | A's owner service/payload stays byte-compatible v1. B and C have distinct deterministic v2 keys/credentials; both direct and tunnel routes survive |
| Actual pinned old reader lists live/compact session, immutable removal and legacy-alias records | Newer-version warnings still occur. All new account names are opaque digests; the warning arguments/log entry contain neither raw fingerprint/principal nor reversible tuple encoding. Legacy markers add no identity to the existing route account name; verify both ASCII and multibyte key vectors |
| v1 B live/deleted ties and stale route aliases; missing-principal live/deleted records | Unexpired attributable delete wins only for B; older cleanup/expired tombstones do not delete a newer B. Pending/missing identity is not guessed from C; exact saved provenance is required for an identity-less deletion |
| Upgrade B, publish C; run actual old reader with a visible alias plus local B, then a v1 tombstone at another address with the same fingerprint | Ordinary same-account write is skipped, but cross-account tombstone propagation **overwrites the visible alias with v1**. Assert that actual old write, no write to canonical B/C or independent removals, then canonical-state preservation and restoration of the marker by the new reader. Repeat with delayed live writes and newly changed route accounts |
| Forget B while C changes direct/tunnel routes; replay B's old token and a route edit clock newer than B's deletion | Once observed, B's independent removal floor beats stale pairing intent despite v1 or route-only v2 writes. C keeps its token, role and new routes |
| X reads B live at pairing 100/floor 0 and pauses before its route upsert; Y inserts removal 200, then stays offline; X blindly writes live route 300/pairing 100/floor 0; a fresh importer reads the resulting service | The mutable item really is overwritten. The independent removal is unchanged and visible to the fresh importer, which rejects B despite a server-valid token and without Y returning. C is unchanged. A mere pre-write reread is not the test; pause after any such read |
| Repeat that interleaving after 30-day session compaction, with interrupted/retried removal inserts, multiple removers and reordered delivery | Immutable removals survive compaction and duplicate insertion without replacement. Fresh import folds their maximum before live candidates. Failed publication stays locally suppressed/pending. If live data arrives before a removal, assert convergence once the removal arrives, not globally atomic iCloud visibility |
| Restart/fresh-device import, including a delayed old write and unknown v3/malformed records | Independent removals and retired aliases suppress stale import when observed; unknown/frozen bytes survive untouched, including across access groups and create-only duplicate handling. Failed list/write/encryption does not erase or downgrade local credentials |
| Remove C on the host, reconnect both people from stale synced data, then deliberately rejoin B with valid new authorization | C's revoked credential is refused and its person-specific removal persists. Only explicit verified B rejoin may pass B's removal floor; reconnect cannot do so. No owner promotion or cross-person mutation |
| Unknown/equal-clock tunnel route versus a known route, explicit clear, and route update racing credential replacement | Preserve unknown-vs-clear semantics, deterministic route ties and the newer credential; route publication neither recreates a deletion nor erases `pairedAt`/removal metadata |

#### Live events and resynchronization

| Event type | Data | Delivery and consumer action |
| --- | --- | --- |
| `host:members-changed` | `{ revision, principalId, hostRole: "member" \| "guest", action: "added" \| "removed" }` | Durable global event; owner/active members, plus the affected principal as a final control notification on removal. Other guests cannot observe host membership. `guest` on removal describes absence of host membership, not a surviving grant or credential |
| `host:invites-changed` | `{ inviteId, action: "created" \| "revoked" \| "redeemed" }` | Durable global event, owner-only; refresh host invite list; never contains secret/link/pin |
| `host:execution-context-changed` | Complete `host.executionContext` result, including `enabledProviderIds` and `gitCredentialPolicy` | Durable global event, owner/member-only; sanitized snapshot after committed provider enablement, defaults, helper policy, repository/AI setup or observed authorization/readiness changes; invalidate enablement/readiness reads even when configured flags are unchanged, never expose raw settings or auth-flow data |
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
| Provider enablement map absent, empty, explicit true/false, non-disableable false, or unknown keys | Context and complete event contain the same unique canonical provider IDs in deterministic order: only explicit false excludes a disableable registered provider; non-disableable providers remain; unknown keys add nothing. No settings/auth access is granted |
| Installed but disabled provider, or enabled provider with a closed feature/environment gate or missing installation/auth/readiness | Member choices combine connected-host enablement with existing catalog/discovery/readiness; no surface substitutes one condition for another or changes owner enablement policy |
| Owner commits provider enablement changes, removes an entry or resets the map while a member read is in flight | Complete sanitized execution-context event refreshes member choices even if configured/readiness flags are unchanged; a stale read cannot undo the newer snapshot |
| Missing/malformed enablement projection, reconnect or switch to a differently configured host | Preserve current agent/model display; withhold unsupported cross-provider choices until current-host enablement is known. Reject old connection responses/events and never substitute local settings, installation or all known providers; owner/legacy setup is unchanged |
| Managed GitHub helper enabled/disabled, each with and without an alternative owner helper | Member reads the exact effective switch and setting name from the connected host; disabled never supplies the daemon credential to children. Git still succeeds with an authorized alternative helper; disabled/no helper explains owner recovery without member auth fallback |
| Configured but expired/revoked/under-scoped Git or AI authorization; missing authorization | Classified operation failure carries `ExecutionAuthorizationFailure` (including asynchronous AI failure); asks that host's owner to repair authorization. Configured/readiness cache is not proof of validity; unrelated operations and invitations remain usable |
| Owner toggles helper policy, changes repository/AI authorization, or a probe/operation discovers revocation | Sanitized execution-context invalidation refreshes member policy/readiness without exposing settings or auth flows. Reconnect/host switch discards old responses and reads the selected host, including when local setup differs |
| Filtered/aggregate permission reads and live answers | Owner/member can act; guest sees no unauthorized request or ID and cannot answer it |
| Repository disconnect/swap during identity proof/selection | Existing Intent identity/session survives; generations reject stale/mismatched proof; repository and collaboration secrets stay isolated |
| Remove member racing create/redeem/queue drain/pair/admission | No late credential/grant/invite resurrection; used reusable issuer links revoked, earlier admitted other guests preserved; running work survives |
| Reuse a personal QR on several devices, restart and accept another invite | Same person/credential remains usable, distinct device IDs; no countdown, proof repetition or silent rotation |
| Remove/rotate shared personal credential and reconnect every device | All affected links/sessions fail; unrelated people and work remain; TLS/route parity retained |
| Device identity spoof and guest device query/subscription | Server-derived person/role; no unrelated device/principal leak through snapshots, live or durable events |
| Desktop/iOS invited v2 migration and mixed-version fixture above | Both codecs/stores follow identical opaque keys, legacy alias recovery, independent removal retention and route/clock semantics; owner service remains v1. Run the complete old-reader logging/B/C/stale-writer fixture, then collect physical device sync evidence separately |
| Lab missing/off/on, route aliases, runtime disable, both GitLab flag states | No hidden experimental content mounts; explicit recovery; owner legacy pairing and saved access preserved |
| Old daemon/client and different local/remote host setup | Legacy owner/guest behavior only; no unsupported purpose fallback; selected host supplies roles/models/repos/pairing after every reconnect |
