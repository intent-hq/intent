> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.17 `client.hello` handshake & stable client identity.

### 5.17 `client.hello` handshake & stable client identity

The daemon supports a **stable, client-supplied identity** that survives reconnects; the ephemeral
per-connection id used internally for subscription bookkeeping is retained purely for transport
bookkeeping and never crosses the wire.

| Method | Params | Result |
| --- | --- | --- |
| client.hello | clientId?, name?, capabilities?, hostname? *(v9.9)*, prettyHostname? *(v9.9)*, deviceKind? *(v9.9)* | { clientId, protocolVersion, server: { locality, hasDisplay, osArch, version, buildCommit?, protocolVersion, capabilities } } |
| client.list *(v9.9)* | — (global; no `workspaceId`) | { clients: [{ clientId, name?, hostname?, prettyHostname?, deviceKind?, capabilities, connections, transports, connectedAt }] } — the **live, hello'd** connections grouped by logical `clientId`; see the `client.list` block below |

- **Global handshake.** `client.hello` does **not** require `workspaceId` (§3.6); it is the
  first call a client makes after the auth upgrade (§2) and before scoped work.
- **Client-persisted `clientId`.** The client **generates and persists its own `clientId`** (a
  UUID in its local storage) and **re-presents it on every (re)connect**. If the client omits
  `clientId`, the server generates one and returns it for the client to persist and reuse from
  then on.
- **Connection → client mapping.** The daemon maps each live connection to its logical
  `clientId`; **multiple connections may share one `clientId`** (the same client reconnecting, or
  several windows of one app).
- **Disambiguation key.** `clientId` is the key that disambiguates `drafts.*` (§5.16) and is the
  foundation for **future per-viewer read cursors** (the `attention` extension noted in §5.1). It
  also lets FE-served intents (`host.openExternal`, §5.14) and `forward.*` target the right
  client.
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

`client.list` is a **global router method** (no `workspaceId`, like `settings.list`) returning
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
