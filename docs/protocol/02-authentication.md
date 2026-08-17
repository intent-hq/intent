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

