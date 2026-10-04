> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.17 `client.hello` handshake & stable client identity · §5.46 Connection principal — `principal.me`.

Routing-only `workspaceId?` additions below are [prepared contract fields](../workspace-routing.md), optional on direct daemons and required for future forwarded workspace calls; existing scope and results are unchanged.

### 5.17 `client.hello` handshake & stable client identity

**Shared-host extension (10.9).** [§5.49](./shared-host-membership.md) adds server
capability flags `hostMembership: 1`, `collaborationIdentity: 1`,
`personalPairing: 1`, `authenticatedDevices: 1`. Each means full support for its
contract, not caller authority. The legacy examples below remain valid for older
daemons. On each connection, read `principal.me` before activating member controls;
never infer the role from this client's capabilities or its saved registry category.

**Submission correlation (prepared).**
`server.capabilities.submissionCorrelation: 1` gates the complete
[optimistic submission contract](./agents.md#submission-correlation-and-optimistic-display-prepared-additive-extension):
optional queue `messageId`, full submission alias sets across replies/queue/delivery,
per-source `recoverySources` for combined retries, and trustworthy live-row merge
eligibility with false flags on draining overlays. Enable queue optimism only for exact integer
`1`; missing, malformed and unknown versions use confirmed queue display.
The numeric protocol version and a partially present field are not support tests.

**Direct agent retirement (10.10).** `server.capabilities.agentRetire: 1` advertises
support for [§5.5 `agent.retire`](./agents.md#direct-user-retirement), including stopping
a running target and cancelling its wake sources. Clients enable the retirement action
only when this capability is present; older daemons omit it. This is a server support
flag, independent of the model's `agentFeatures.peerAgents` gate, and does not grant
caller authority: workspace lifecycle permissions still apply.

The daemon supports a **stable, client-supplied identity** that survives reconnects; the ephemeral
per-connection id used internally for subscription bookkeeping is retained purely for transport
bookkeeping and never crosses the wire.

**Script lifecycle (10.11 implemented candidate).**
`server.capabilities.scriptLifecycle: 1` advertises the complete saved/one-off,
archive/restore, list filtering, result persistence and agent-binding contract
in [§5.8](./scripts.md#saved-scripts-and-one-off-history-1011-implemented-candidate).
The verified candidate implements this capability; current pins and deployed
clients are not thereby upgraded. Older daemons omit it; clients must not assume
an unknown create option was
honored just because creation succeeded. Gate lifecycle controls/options on this
capability, independently of numeric version.

**Worker observations (prepared additive extension).**
`server.capabilities.agentWorkers: 1` advertises the read-only list/subscription
contract in [§5.5b](./agent-workers.md), not process liveness or exit evidence.
Provider-session support is reported independently; older daemons omit this flag.

**Service readiness (prepared additive extension).**
`server.capabilities.scriptReadiness: 1` advertises the complete persisted
health/pattern readiness contract in
[§5.8](./scripts.md#service-readiness-prepared-additive-extension), including
per-process resets, bounded local checks and agent bindings. It is independent
of `scriptLifecycle`. Without it, clients must not send readiness options or
interpret successful creation/URL detection as proof of readiness. Scripts
without a contract omit `ready` and `readiness` even when support is advertised.

**Desktop control (prepared additive extension).**
`server.capabilities.desktopControl: 1` and the execution connection’s
`capabilities.desktopControl: 1` gate [§5.51](./desktop.md) independently.
Resolve the existing workspace primary before testing this capability; never
choose another computer because the primary lacks support. The flag grants no
permission and does not assert current native readiness. Current browser-only
capability behavior below remains unchanged until this extension is implemented.

**Script run monitoring (prepared additive extension).**
`server.capabilities.scriptMonitors: 1` advertises the entire
[§5.8a contract](./script-monitors.md): durable run identity, required one-shot
TTL, optional single-line regex/line-count triggers, single-owner registration,
guarded run cancellation and silent lifecycle
cleanup including queued wakes. Independent of scriptLifecycle/scriptReadiness;
absence means unavailable, not permission to infer support from version numbers.

| Method | Params | Result |
| --- | --- | --- |
| client.hello | clientId?, name?, capabilities?, hostname? *(v9.9)*, prettyHostname? *(v9.9)*, deviceKind? *(v9.9)* | { clientId, protocolVersion, server: { locality, hasDisplay, osArch, version, buildCommit?, protocolVersion, capabilities } } |
| client.list *(v9.9)* | workspaceId? | { clients: [{ clientId, name?, hostname?, prettyHostname?, deviceKind?, capabilities, connections, transports, connectedAt }] } — the **live, hello'd** connections grouped by logical `clientId`; see the `client.list` block below |

- **Global handshake.** `client.hello` does **not** require `workspaceId` (§3.6); it is the
  first call a client makes after the auth upgrade (§2) and before scoped work.
- **Client-persisted `clientId`.** The client **generates and persists its own `clientId`** (a
  UUID in its local storage) and **re-presents it on every (re)connect**. If the client omits
  `clientId`, the server generates one and returns it for the client to persist and reuse from
  then on. On a connection bound to a **non-administrator principal** (§2.4 / §5.48) the returned
  `clientId` is namespaced as `{principalId}:{presented}` — idempotent, so a client that persists
  the returned id re-hellos to the same identity — and a collaborator can only ever act as a
  client id inside its own namespace; the administrator, agents and the daemon keep the raw id.
- **Connection → client mapping.** The daemon maps each live connection to its logical
  `clientId`; **multiple connections may share one `clientId`** (the same client reconnecting, or
  several windows of one app).
- **Disambiguation key.** `clientId` is the key that disambiguates `drafts.*` (§5.16) and is the
  foundation for **future per-viewer read cursors** (the `attention` extension noted in §5.1). It
  also lets FE-served intents (`host.openExternal`, §5.14) target the right client.
- **`server` block.** The result advertises daemon capabilities so a client can gate UI right
  after the handshake (mirrors `host.status`, §5.14): `locality` (`local` | `remote`),
  `hasDisplay` (GUI present on the daemon host), `osArch` (e.g. `darwin/arm64`), `version`
  (daemon version string), optional `buildCommit` (the source commit embedded at daemon build
  time; omitted, never `null`, when unavailable), `protocolVersion` (the current JSON-RPC
  surface version from [Protocol Version & Compatibility](../versioning.md)), and
  `capabilities` (feature-detection flags, e.g. `{ "liveState": true }` for the snapshot+delta
  channels of §6.9).
- **`protocolVersion`.** The top-level `protocolVersion` is an explicit copy of
  `server.protocolVersion` so clients can version-check without digging into the `server` block
  (see [Protocol Version & Compatibility](../versioning.md)).

```json
// → first call after auth: client re-presents its persisted clientId
{ "jsonrpc":"2.0","id":1,"method":"client.hello",
  "params":{ "clientId":"cli-7f3a","name":"Intent Desktop","capabilities":{ "forward":true,"openExternal":true } } }
// ← response — capabilities of the daemon host
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-7f3a","protocolVersion":"<current>",
  "server":{ "locality":"remote","hasDisplay":false,"osArch":"linux/x86_64","version":"0.1.0",
    "protocolVersion":"<current>","capabilities":{ "liveState":true } } } }
```

```json
// → first-ever connect: no clientId yet, server mints one
{ "jsonrpc":"2.0","id":1,"method":"client.hello","params":{ "name":"Intent Desktop" } }
// ← server returns a clientId for the client to persist
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-9b21","protocolVersion":"<current>",
  "server":{ "locality":"local","hasDisplay":true,"osArch":"darwin/arm64","version":"0.1.0",
    "protocolVersion":"<current>","capabilities":{ "liveState":true } } } }
```

**Errors.** A malformed `clientId` (non-string) → `-32602`; a persistence failure → `-32603`.
The handshake is idempotent: re-sending `client.hello` on the same connection updates `name` /
`capabilities` / host identification and re-returns the same `server` block.

#### GitLab checkout capability

**Prepared additive contract, protocol 13.5.**
`server.capabilities.gitlabCheckout: 1` announces the complete
[pre-workspace project checkout contract](repository-checkout.md). Accept exactly
integer `1` on the selected destination's original physical connection. The
capability does not enable the GitLab experiment, grant host membership or prove
that a configured account can access a project. A higher protocol version, the
existing repository resource/context capabilities, or a guest's collaboration
identity cannot substitute for it.

Require this same capability before sending `instanceBaseUrl` to the
[prepared full-instance auth operations](integrations.md#full-instance-gitlab-authentication-prepared-v135),
including auth-status reads. An older parser may ignore an unknown field;
request success alone cannot establish full-root support. Its historical
bare-host behavior does not authorize a prefix-bearing instance.

Capture before browsing and retain the original destination through pagination,
warming, creation and release. Reconnect, host/auth/settings changes or
retirement require a new capture; a stable client ID cannot transfer the old
reference. See the [client lifecycle](../10-thin-client.md#gitlab-checkout-lifecycle-prepared).

#### Repository context capability

**Prepared additive contract.** `server.capabilities.repositoryContext: 1`
announces the complete context-read lifecycle. Feature-detect the capability
on the physical connection captured for the
[repository context lifecycle](workspace.md#repository-context).
It announces support, not workspace membership, provider permission or a portable
lease. Re-hello on that socket does not renew a lease. A shared stable `clientId`,
bearer or principal cannot transfer a lifetime to another socket; reconnect needs
a fresh capture. Install the original connection's
[private retirement handler](../10-thin-client.md#repository-context-lifecycle)
before acquiring a lifetime. These are client obligations, not a claim that current
frontend clients implement the feature.

#### Repository selection capability

**Prepared additive contract.** `server.capabilities.repositorySelection: 1`
is separate from `repositoryContext: 1`.
Feature-detect it on the original confirmed physical connection used for the
[selection editing operation](workspace.md#repository-selection).
It announces support, not workspace-manager permission or a transferable write
grant; context read permission is insufficient.

Install that connection's [private selection retirement handler](../06-events.md#private-repository-selection-retirement)
before capture, and capture the editing snapshot before user confirmation.
Re-hello, a stable `clientId`, matching principal or bearer cannot renew or move
the operation to a replacement socket. Keep original receipts independently of
current UI state; reconnect cannot reconcile an unknown old effect. The
[client lifecycle](../10-thin-client.md#repository-selection-lifecycle)
specifies required integration behavior, not an already shipped frontend flow.

#### Native review capability

**Prepared additive contract.** `server.capabilities.nativeReview: 1` announces
qualified native review preparation, execution and receipts. Feature-detect it on
the original confirmed physical connection before the
[qualified native review workflow](change-tracking.md#native-review-preparation-and-receipts).
It announces the contract, not current host/workspace permission, configured
provider readiness or unconditional admission. Prepared facts and the public
capability cannot replace fresh server checks.

Install that connection's [private retirement handler](../06-events.md#private-native-review-retirement)
before preparation, and retain the same connection through confirmation,
execution, reconciliation and release. Re-hello, a stable `clientId`, matching
principal or bearer cannot renew or transfer an operation. Native execution uses
actual Member permission; administrator-only connection metadata disclosure is a
separate check. The [client lifecycle](../10-thin-client.md#native-review-lifecycle)
describes required integration behavior, not a shipped frontend or normal-daemon
provider guarantee. Capabilities, rather than an older experimental version number, gate support.

#### Commit companion capability

**Prepared additive contract.** `server.capabilities.nativeReviewCompanion: 1`
is advertised alongside `nativeReview: 1`.
Check the companion capability on the original confirmed physical connection
**before** a [marked commit preparation](change-tracking.md#commit-companion-preparation).
The earlier capability alone does not support the new strict forms. Do not infer
support from a current host selection, matching identity or account, or retry a
refused form as an ordinary/GitHub/MCP request.

The capability announces a conditional contract, not provider readiness,
permission, successful commit completion or child eligibility. Retain the same
connection and main-process session through the original reply and separately
confirmed child. Re-hello or reconnect cannot transfer that authority. The
[client lifecycle](../10-thin-client.md#commit-companion-lifecycle)
states integration obligations, not an existing frontend or deployed runtime
guarantee. The companion does not add method or notification names.

#### Resource-read capability

**Prepared additive contract.** The hello response advertises
`result.server.capabilities.repositoryResourceRead: 1` for the
[explicit GitLab resource-read contract](repository-resources.md). Documentation alone does not establish availability. Detect support on the original physical connection before
capture and install that connection's [private retirement handler](../06-events.md#private-resource-read-retirement)
first. A capability announces a supported contract, not current host/workspace
permission, configured account readiness or access to the requested project.
An absent or unsupported capability disables these reads; it does not select a
generic, legacy or other-provider read fallback.

Keep capture, detail, release and late cleanup on that same connection. A matching
logical client ID, principal or bearer on a replacement socket cannot move or
renew the lifetime. Repository inventory, selected-workspace observation and
native review capabilities do not imply this explicit-resource capability.
These are client integration obligations, not a shipped frontend guarantee;
documentation alone does not establish deployed availability.

#### Client identity, capabilities & device identification (REV-2, v9.9)

`client.hello` is where a connection acquires the **logical-client identity** the daemon uses
for REV-2 reverse-dispatch target selection (§5.9), the browser-tab registry (§5.45) and the
per-workspace browser-client pin (§5.1 `workspace.setBrowserClient`) — [intent-hq/intentd#1756](https://github.com/intent-hq/intentd/pull/1756),
[intent-hq/intentd#1760](https://github.com/intent-hq/intentd/pull/1760).

- **`capabilities.browserExec`.** A connection is **eligible** to serve daemon-initiated
  `browser.exec` reverse RPCs only once its hello advertised `capabilities.browserExec === true`.
  Un-hello'd sockets (CLIs, dev tooling, an iOS app that never sends hello) and connections
  whose hello omitted the flag (e.g. an FE auxiliary connection) are never candidates, regardless
  of arrival order. Any other member of `capabilities` is stored verbatim and reported back by
  `client.list`; the daemon interprets only `browserExec`. An omitted `capabilities` is stored
  as `{}`.
- **Device identification.** `hostname`, `prettyHostname` and `deviceKind` are the client's own
  device identification — the same triple the daemon reports about itself in `host.status` /
  `server.pairingInfo` (§5.14). Each is optional and taken **only when a string** (any other JSON
  value reads as omitted). They are persisted on the logical `client` row and surfaced by
  `client.list` so a user can tell "MacBook Pro" from "iPhone" when choosing a browser client.
- **Re-hello replaces, never merges.** A repeated `client.hello` on the same connection (or the
  same `clientId` from another connection) overwrites the persisted `name` / `capabilities` /
  `hostname` / `prettyHostname` / `deviceKind` with the new hello's values — an **omitted field
  clears** the stored value. Send the full set on every hello.
- **Hello provenance.** The daemon records when a `clientId` last completed a real
  `client.hello`. A `client` row can also come into existence *without* a hello (an anonymous
  connection's `drafts.*` calls, §5.16, key their row by `clientId`); such never-hello'd rows are
  **not** pinnable (`workspace.setBrowserClient` rejects them with `-32602`, §5.1) and cannot
  host tabs (§5.45). Upgrading an existing daemon backfills the provenance stamp only for rows
  that carry a `name` — a heuristic proxy, since the anonymous-draft placeholder is always minted
  nameless while `client.hello` is optional-`name` but in practice always sends one. Legacy
  nameless rows (draft-only placeholders, or a pre-upgrade hello'd client that omitted `name`)
  fail closed — not pinnable, cannot host — until their next `client.hello`, which stamps them.
- **Logical-client transitions.** The daemon publishes the global events `client:connected`
  (a `clientId` gained its **first** live hello'd connection) and `client:disconnected` (it lost
  its **last** — explicit close, re-hello under a different `clientId`, or connection abort
  alike) with data `{ clientId, name?, capabilities }` (§6.5). Additional connections of an
  already-connected client, and a re-hello that changes only `name` / `capabilities`, emit
  nothing; the transitions are recorded in registry mutation order, so a stale
  `client:disconnected` can never overtake the `client:connected` of a same-client reconnect.

#### `client.list` — live logical clients (v9.9)

`client.list` is a **global router method** (optional `workspaceId` is routing context only, like `settings.list`) returning
every logical client that currently holds **at least one live, hello'd connection** — one entry
per `clientId`, ordered by each client's first (oldest live) connection. Un-hello'd connections
are omitted entirely. Clients **without** `browserExec` are included: this is the presence
projection, not the eligibility set.

```json
// → global read, no params
{ "jsonrpc":"2.0","id":7,"method":"client.list" }
// ← one entry per logical client with a live hello'd connection
{ "jsonrpc":"2.0","id":7,"result":{ "clients":[
  { "clientId":"cli-7f3a","name":"Intent Desktop","hostname":"studio.local","prettyHostname":"Studio",
    "deviceKind":"desktop","capabilities":{ "browserExec":true,"forward":true },
    "connections":2,"transports":["uds","wss"],"connectedAt":"2026-09-06T21:14:02.118Z" },
  { "clientId":"ios-4c11","name":"Intent iOS","deviceKind":"phone",
    "capabilities":{ "browserExec":false },
    "connections":1,"transports":["wss"],"connectedAt":"2026-09-06T21:20:40.003Z" } ] } }
```

Per entry:

- `clientId` — the logical identity (§ above).
- `name?`, `hostname?`, `prettyHostname?`, `deviceKind?` — presence-detected (omitted, never
  `null`); taken from the client's **newest hello** across its live connections (newest by hello
  order, not by connection registration order).
- `capabilities` — the newest hello's bag, **always present**, with **`browserExec` always
  present** and replaced by the per-client aggregate: `true` when **any** of the client's live
  connections advertised it. So a later auxiliary socket that omits the flag never masks an
  earlier eligible connection, and the flag agrees with what §5.9 target selection would route
  to.
- `connections` — the number of live hello'd connections sharing the `clientId`.
- `transports` — the wire spelling (`"uds"` | `"wss"`) of each live connection, oldest first
  (`transports.length === connections`).
- `connectedAt` — ISO-8601 registration time of the client's oldest live connection.

The workspace-scoped counterpart — which client an agent's `browser.exec` would reach for one
workspace right now — is `workspace.getBrowserClient` (§5.1); `client.list` is the picker's
source of candidates for `workspace.setBrowserClient`.

**Antigravity setup capability (9.8).** The server advertises
`capabilities.antigravitySetup: 1`. A dedicated local app connection requests
this capability in its hello before using the connection-owned setup methods.
See [§5.44](./models-providers.md#544-guided-antigravity-setup). A new hello
revokes the preceding setup operation on that connection. WSS cannot gain
setup access by advertising the capability.

#### Authenticated device roster additions *(10.9)*

With `authenticatedDevices: 1`, every `client.list` row adds `principalId`,
`hostRole`, `login: string | null`, `displayName: string | null`,
`avatarUrl: string | null` and optional `identity`, all from the admitted credential.
Owner/member callers see the host roster; a workspace guest sees only its own
principal's logical devices. The same filtering applies to live and durable client
events. New `client:updated` carries the full row after metadata/role/profile changes;
`client:connected`/`disconnected` retain their existing keys and add the principal
projection. Logical IDs distinguish devices/windows, not credentials; multiple
devices can share one persistent personal credential. Claimed person/role fields
in hello are never trusted. See [§5.49](./shared-host-membership.md#persistent-personal-pairing-and-authenticated-devices)
for selected-host pairing and iOS persistence/sync requirements.

### 5.46 Connection principal — `principal.me` *(v10.3; [intent-hq/intentd#1869](https://github.com/intent-hq/intentd/pull/1869))*

Every connection is bound to a **principal** at admission, for the life of the connection —
identity is never taken from `client.hello` (§5.17), which carries only the logical client id.
UDS connections and the legacy bearer token (`server.auth.token`) bind the **primary user**
as administrator; a hashed per-principal credential (`principal_credential` row, matched by
the SHA-256 of the presented token) binds **its principal** as a non-administrator.
`principal.me` returns that binding. Daemon-global — no `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| principal.me | — (no params; daemon-global, no `workspaceId`) | { id, login: string \| null, displayName: string \| null, avatarUrl: string \| null, isAdministrator } |

```json
// → no params
{ "jsonrpc":"2.0","id":3,"method":"principal.me" }
// ← the connection's bound principal
{ "jsonrpc":"2.0","id":3,"result":{ "id":"prn-9c2e","login":"octocat","displayName":"The Octocat",
  "avatarUrl":"https://avatars.githubusercontent.com/u/583231","isAdministrator":true } }
// ← before any GitHub identity has been cached: the profile fields are PRESENT as null
{ "jsonrpc":"2.0","id":4,"method":"principal.me" }
{ "jsonrpc":"2.0","id":4,"result":{ "id":"prn-9c2e","login":null,"displayName":null,"avatarUrl":null,"isAdministrator":true } }
```

**Result:**

- `id: string` — the principal id the connection was bound to.
- `login`, `displayName`, `avatarUrl: string | null` — the principal's **cached** GitHub
  identity, served offline from the store. **Always present, `null` when unknown** (the
  pre-profile state, or a principal whose identity was never fetched); never omitted.
  Reading the primary principal also triggers a rate-limited, detached background refresh
  of its identity from GitHub `GET /user` — the read never waits on it, and any failure (not
  configured, offline, timeout) leaves the cached row untouched, so a later call may return
  filled fields where an earlier one returned `null`.
- `isAdministrator: boolean` — `true` for the primary user (UDS / legacy token), `false` for
  a per-principal-credential connection.

**Caller resolution.** A wire caller resolves to the principal bound at admission. Agent
callers (MCP) and daemon-internal callers resolve to the primary principal, with
`isAdministrator` = that principal's `is_primary` flag.

**Errors.** Fail-closed: a request with no bound caller — a connection admitted unbound
because the composition root exposes no principal store — is `-32603` (`message` "Internal
error", `data` = `"forbidden: request is not bound to a principal"`; §9). No `-32602` arm:
params are ignored.

**Shared-host fields (10.9).** The full `PrincipalMe` shape is the existing result
plus `identity?: { provider, host, externalUserId }` (10.8), `hostRole: "owner" |
"member" | "guest"` and `hostMembershipRevision: integer` (10.9). The profile may
remain unlinked/null for an owner; no repository connection is needed. A member
has `isAdministrator: false`; cached roles are refreshed on reconnect and
`host:members-changed`. The principal ID remains immutable while effective host
role is current. [§5.49](./shared-host-membership.md#authority-and-discovery) gives
the fail-closed compatibility rules when fields/capabilities are missing.
