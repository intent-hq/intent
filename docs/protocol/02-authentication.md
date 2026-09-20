> Part of the [Intent JSON-RPC protocol docs](./README.md) — §2 Authentication.

## 2. Authentication

### 2.1 Bearer token on upgrade

Every WebSocket upgrade must present a bearer token. The server checks the token **during the HTTP upgrade** (before the socket is upgraded) in this order:

1. `Authorization: Bearer <token>` header.
2. `?token=<token>` query parameter on the `/ws` (or `/tunnel`, §1.4) URL (for clients that cannot set headers).

Validation is **timing-safe** (constant-time compare) against the stored token. On failure the upgrade is rejected with `HTTP/1.1 401 Unauthorized` and the socket is destroyed.

- The token is **32 random bytes, hex-encoded (64 chars)**, generated once and persisted in appsettings. It can be rotated (regenerated) by the host application.
- If the WebSocket API is disabled in settings, upgrades are rejected with `403 Forbidden`.

### 2.2 Origin allow-list

Browser-origin upgrades are gated to prevent cross-origin attacks; native clients are allowed:

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients never send one), `file://` (desktop app renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's own hostname / `.local` form (so LAN clients connecting by advertised hostname pass).
- **Rejected (**`403`**):** `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

### 2.3 Where the token lives

The token and the API-enabled flag are persisted in the daemon's settings store. Clients obtain the token out-of-band via a pairing flow (the daemon surfaces token + fingerprint together — see also `pairing.getInfo` in the §5 fast-path catalog). An operator can run `intentd pair` to print the QR code, `intent://pair` URL, bearer token, and TLS certificate fingerprint together for pairing (and `intentd pair --rotate` to regenerate the token, daemon-authoritative via `server.rotateToken`).

### 2.4 Principal-bound credentials and the `/invite` endpoint *(multiplayer, within 10.3)*

The settings-store token above is the **primary** (administrator) credential; it is not the only one. Since the multiplayer stack ([intent-hq/intentd#1868](https://github.com/intent-hq/intentd/pull/1868) onward, §5.48) the upgrade gate accepts, in this order, the legacy token (constant-time compare, unchanged) **or** a per-principal bearer token looked up by hash in `principal_credential` (revoked rows are refused). Either way the connection is **bound at admission** to exactly one principal — the primary principal for the legacy token, the credential's owner otherwise — and `client.hello` cannot change that binding; `principal.me` reports it. A connection bound to a non-administrator principal is subject to the collaborator method / event allowlists (default-deny; §5.48) and to per-workspace membership. When a principal's credentials are revoked (`principal.revokeSelf`), every non-administrator (per-principal-credential) connection still bound to it is closed with WebSocket close code **1008** (a legacy-token connection never subscribes to revocation) after draining its in-flight responses, and the token is refused (`401`) on replay.

`/invite` is the one **unauthenticated** WebSocket endpoint beside `/ws` and `/tunnel` (§1.4): an invitee holds only an `intent://invite?…&inviteId=…&secret=…` link, so the upgrade skips credential resolution (the `server.enabled` flag and the §2.2 origin allow-list still apply). It serves exactly one method (§5.48), `invite.redeem`, in two phases on the same name: `{ inviteId, secret }` validates the link and starts an identity-only GitHub device flow run by the host (the invitee authorizes it in a browser with the returned `userCode` / `verificationUri`), and `{ flowId }` waits for that flow to settle and returns the invitee's new per-principal token **exactly once**. Every other method on that endpoint is `-32001` (`message`: `the /invite endpoint serves invite.redeem only`), and the listener bounds anonymous load (32 concurrent connections → `503`, 16 KiB frames, per-connection / listener-wide / identity-flow caps → `invite-flow-busy`). The invitee then reconnects on `/ws` with that token (directly, or over the Tailscale route the link's `tc` names) like any other client — never on `/tunnel`: port forwarding is owner-only, and a per-principal credential is refused there with `403`.
