> Part of the [Intent JSON-RPC protocol docs](./README.md) — §2 Authentication.

## 2. Authentication

### 2.1 Bearer token on upgrade

Every WebSocket upgrade must present a bearer token. The server checks the token **during the HTTP upgrade** (before the socket is upgraded) in this order:

1. `Authorization: Bearer <token>` header.
2. `?token=<token>` query parameter on the `/ws` (or `/tunnel`, §1.4) URL (for clients that cannot set headers).

Validation is **timing-safe** (constant-time compare) against the stored token. On failure the upgrade is rejected with `HTTP/1.1 401 Unauthorized` and the socket is destroyed.

- The token is **32 random bytes, hex-encoded (64 chars)**, generated once and persisted in the file-backed secret store. It can be rotated (regenerated) by the host application.
- If the WebSocket API is disabled in settings, upgrades are rejected with `403 Forbidden`.

### 2.2 Origin allow-list

Browser-origin upgrades are gated to prevent cross-origin attacks; native clients are allowed:

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients never send one), `file://` (desktop app renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's own hostname / `.local` form (so LAN clients connecting by advertised hostname pass).
- **Rejected (**`403`**):** `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

### 2.3 Where the token lives

The legacy owner token is persisted under `server.auth.token` in the file-backed secret store (`FileTokenStore` / `FileSecretStore`); the API-enabled flag comes from the effective settings registry. Neither is a principal credential row. Clients obtain the token out-of-band via a pairing flow (the daemon surfaces token + fingerprint together — see also `pairing.getInfo` in the §5 fast-path catalog). An operator can run `intentd pair` to print the QR code, `intent://pair` URL, bearer token, and TLS certificate fingerprint together for pairing (and `intentd pair --rotate` to regenerate the token, daemon-authoritative via `server.rotateToken`).

### 2.4 Principal-bound credentials and the `/invite` endpoint *(multiplayer, within 10.3)*

The following is the workspace-guest baseline. The capability-gated shared-host changes are in §2.5 and [§5.49](./methods/shared-host-membership.md).

The file-secret token above is the **primary** (administrator) credential; it is not the only one. Since the multiplayer stack ([intent-hq/intentd#1868](https://github.com/intent-hq/intentd/pull/1868) onward, §5.48) the upgrade gate accepts, in this order, the legacy token (constant-time compare, unchanged) **or** a per-principal bearer token looked up by hash in `principal_credential` (revoked rows are refused). Either way the connection is **bound at admission** to exactly one principal — the primary principal for the legacy token, the credential's owner otherwise — and `client.hello` cannot change that binding; `principal.me` reports it. A connection bound to a non-administrator principal is subject to the collaborator method / event allowlists (default-deny; §5.48) and to per-workspace membership. When a principal's credentials are revoked (`principal.revokeSelf`), every non-administrator (per-principal-credential) connection still bound to it is closed with WebSocket close code **1008** (a legacy-token connection never subscribes to revocation) after draining its in-flight responses, and the token is refused (`401`) on replay.

`/invite` is the one **unauthenticated** WebSocket endpoint beside `/ws` and `/tunnel` (§1.4): an invitee holds only an `intent://invite?…&inviteId=…&secret=…` link, so the upgrade skips credential resolution (the `server.enabled` flag and the §2.2 origin allow-list still apply). It serves exactly four methods (§5.48) — `invite.inspect`, `invite.accept`, `invite.challenge`, `invite.prove` — and nothing else. The host never runs an OAuth flow on the guest's behalf and never holds a guest token: a **first-time** guest proves it owns a forge account by publishing a host-issued nonce under that account (`invite.challenge` issues the nonce, the guest publishes it through its **own** daemon with `sourceControl.identityProof.create`, and `invite.prove` verifies the proof and returns the guest's new per-principal token); a **returning** guest presents the per-principal credential an earlier join minted (`invite.accept`, which answers with a fresh credential); `invite.inspect` previews the invite without spending a nonce. Every other method on that endpoint is `-32001` (`message`: `the /invite endpoint serves invite.inspect, invite.accept, invite.challenge and invite.prove only`; `invite.redeem`, the pre-#1965 two-phase device-flow join, keeps its §5 fast-path catalog entry only until the intentd pin advances past its removal), and the listener bounds anonymous load (32 concurrent connections → `503`, 16 KiB frames, per-connection in-flight / listener-wide start / outstanding-nonce caps → `invite-flow-busy`). The invitee then reconnects on `/ws` with that token (directly, or over the Tailscale route the link's `tc` names) like any other client — never on `/tunnel`: port forwarding is owner-only, and a per-principal credential is refused there with `403`.

### 2.5 Shared-host authority and personal pairing *(10.9)*

The principal ID bound at admission remains immutable. Its current **host role** is
separate: the primary is owner, active host members are non-administrator members,
and other admitted principals are workspace guests. Read `principal.me` on every
connection and refresh it on membership invalidation; no saved client category or
hello payload supplies authority. Member credentials can reach all ordinary
workspaces and `/tunnel`; workspace guests retain narrow workspace access and
remain refused by `/tunnel` with HTTP 403.

`pairing.getSelfInfo` over authenticated UDS/WSS re-encodes the **current person's**
credential in the existing persistent `intent://pair` envelope. It never exports
another person's token or changes access. Existing local-only `pairing.getInfo`,
`server.pairingInfo` and `server.rotateToken` remain owner administration.
Credential revocation/rotation closes affected live sessions as well as refusing
future upgrades; principal removal revokes all its credentials and inherited/direct
grants. Recheck socket admission against the revocation generation so an in-flight
connection cannot restore access. Close code, drain bounds and pairing rules are
specified in [§5.49](./methods/shared-host-membership.md#removal-revocation-and-ordering).

The `/invite` endpoint still serves exactly four methods. Their additive `scope`
defaults to workspace; explicit host scope is mandatory for a host invitation.
`invite.accept` in this contract reuses a valid returning credential, preserving
other devices. Authentication by GitHub/GitLab proof is independent of repository
connections; collaboration credentials remain on the signing-in person's daemon
in their separate purpose. No new unauthenticated endpoint is introduced.

### 2.6 Executor credentials

*Prepared for daemon-to-daemon remote agents; not implemented at the pinned daemon.*
An executor credential lets one backend daemon run remote agents on this
machine over the [executor link](./node-link.md#daemon-to-daemon-executor-link-nodeprotocol-6).
It is a separate credential kind, not a `principal_credential` row and not a
principal with a host role, so no collaborator or member allowlist ever sees it.

- **Minting is owner-only.** `executor.mint` ([§5.50](./methods/nodes.md#machine-methods-executor-credentials))
  is callable only from the local UDS seat or a WSS connection admitted with the
  owner token; members and guests get `-32003`. One credential is minted for one
  backend id. The token is 32 random bytes, hex-encoded, returned once and never
  logged; the machine stores only its SHA-256 hash.
- **Path-scoped admission.** On `/node/link` and `/node/git` the upgrade gate
  looks the bearer token up only among unrevoked executor credentials, after the
  enable flags and a refusal of any `Origin` header. The owner token and
  per-principal tokens are `401` there. Executor tokens are never looked up on
  `/ws` or `/tunnel`, so they are `401` there. `/invite` keeps its anonymous
  admission (§2.4): it resolves no credential, so an executor token presented
  there is ignored and confers no authority beyond the four invite methods.
  Executor connections take no guest seat and never reach the method router.
- **Scope.** The credential admits only the executor link requests (launch,
  prompt, cancel, stop, ack, capabilities, heartbeats, `workspace.call`
  responses) and git sessions for agents on its own binding. Its binding must
  name the backend id it was minted for.
- **Revocation.** `executor.revoke` closes that credential's live `/node/*`
  connections with WebSocket close code **1008** (`credential revoked`) through
  the existing revocation subscription, stops its agents, and refuses the token
  with `401` on replay. Revoking one backend leaves other backends' credentials
  valid.

Running agents means running code as the machine owner's OS user. The
credential is narrow in API terms but powerful in effect, which is why only the
owner can mint it.

### Protected bootstrap admission (prepared)

The [startup contract](./startup-readiness.md#bootstrap-boundary-and-security)
allows only the protected local UDS seat and legacy file-secret owner token to
read early aggregate progress. Supplied nonmatching tokens temporarily receive
503 because SQLite-backed credentials cannot yet be resolved; missing tokens
remain 401. No early principal/role is invented. TLS, origin, enable/bind and
credential rules remain in force, and all bootstrap seats close for fresh normal
admission at readiness. This is not an unauthenticated status endpoint.
