> Part of the [Intent JSON-RPC protocol docs](./README.md) — §1 Transport.

## 1. Transport

### 1.1 Connection URL

When the WS API is enabled (`server.wsApi.enabled` — see the §1.1 UDS note below), the backend runs a dedicated **HTTPS server bound to `0.0.0.0`** (LAN-reachable) exposing the JSON-RPC WebSocket endpoint:

```
wss://<host>:<port>/ws
```

- **Default port:** `5181` (fixed — no port walking, no same-port backoff). The listener binds exactly this port. In the secure posture a WSS bind failure at boot is **non-fatal**: the daemon logs a warning and keeps serving UDS (`server.wsApi.enabled` stays true; toggle it to retry), and a runtime toggle-on bind failure surfaces as a `settings.update` error. Only the insecure dev listener (`--insecure`) treats a bind failure as fatal — the daemon exits non-zero with the OS bind error. Clients still SHOULD obtain the port from the QR/manual pairing payload (rendered on the daemon host via the local-only `pairing.getInfo`, §5, or `intentd pair`) or a well-known override rather than hard-coding it, since the operator may reconfigure `server.wsApi.port` (or its `INTENTD_TCP_PORT` env override).
- **Scheme:** `wss://` (TLS) in the default secure posture — there is no plaintext `ws://` listener unless insecure dev mode is opted into. With `serve --insecure` (or `INTENTD_INSECURE=1`) the daemon serves plain `ws://` with TLS and bearer-token enforcement skipped; this is a development-only posture (`make dev-daemon` uses it) and logs a prominent startup warning.
- A plain HTTPS `GET /health` returns `{"status":"ok","clients":<n>}` for liveness probing.
- The same listener also serves the non-JSON-RPC `/tunnel` WebSocket endpoint — the binary loopback port-forwarding surface (§1.4).
- Any path other than `/ws` and `/tunnel` is rejected at upgrade time (socket destroyed).

> Local transport (UDS / Windows named pipe): The daemon **always** serves a local transport as the local-first default — a **Unix-domain socket** on Unix, a **named pipe** on Windows (where UDS is unavailable); the TCP/WSS listener is optional and toggled at runtime by the `server.wsApi.enabled` setting (the former `server.listenMode` setting and `--listen` serve flag are retired). The JSON-RPC envelope, method catalog, event semantics, and the newline-delimited framing are **identical** across UDS, the named pipe, and TCP/TLS — only the listener differs; everywhere this document says "UDS" the Windows named pipe is implied. `system.status` reports a derived `listenMode` field (`"both"` while the WSS listener is up, `"uds"` otherwise) reflecting the live listener state.
>
> **Windows pipe-name contract:** the pipe name is derived from the resolved socket path, so every data dir (prod vs dev vs tests) gets its own isolated pipe with no extra coordination state: `\\.\pipe\intentd-<hash16>`, where `<hash16>` = the first 16 hex chars of the SHA-256 over the UTF-8 bytes of the socket path normalized as absolute form, backslash separators, lowercased. Both sides implement the derivation independently and must agree byte-for-byte: `intent-transport`'s `pipe_name_for_socket_path` (daemon + `intentd` CLI client) and cloudlands-fe's `intentd-pipe-name.ts` (FE local connect), each pinned by mirrored unit-test vectors.

### 1.2 TLS & fingerprint pinning

The server generates a **self-signed** EC (P-256) certificate on first start, persists it under the app's data directory (`ws-cert.pem` / `ws-key.pem`), and reuses it across restarts (10-year validity). Because it is self-signed, **clients pin the certificate** rather than relying on a CA:

- The server exposes a **SHA-256 fingerprint**, colon-separated uppercase hex (e.g. `AB:CD:EF:...`), computed over the DER body of the cert.
- Certificate SANs include `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 address on the host (LAN, Tailscale, etc.), so connecting by hostname or LAN IP validates against the SAN.
- Clients should **pin the fingerprint** (obtained out-of-band during pairing — the pairing payload carries it as `fp=`) and reject any cert whose fingerprint does not match.

### 1.3 Message size limit

Inbound JSON-RPC messages are capped at **40 MiB** (`MAX_INBOUND_MESSAGE_BYTES = 40 * 1024 * 1024` in `intent-transport`). The limit is the same on both transports; the behavior on violation differs by framing:

- **WSS:** the limit is enforced on both the WebSocket frame size and the total message size, and the connection is closed on violation. The daemon attempts to send a close frame with code **1009 (Message Too Big)** before terminating. Delivery of the close frame is best-effort: a single over-limit frame fails fast on the frame header (its payload is not buffered), and the connection teardown may race with the client's in-flight write, so the client may not observe the close frame; a fragmented message is rejected once its accumulated fragments exceed the cap (so up to the limit may be buffered before rejection), and in that case the client typically does receive the 1009 close frame.
- **UDS / named pipe:** the daemon replies with a `-32600` error (`id: null`, since the request was never parsed) and then closes the connection, without draining the rest of the oversized line.

Outbound (server→client) messages are capped at the same size (`MAX_OUTBOUND_MESSAGE_BYTES = MAX_INBOUND_MESSAGE_BYTES`, 40 MiB — intentd#743; an unscoped `git.diffs` on a huge dirty worktree once produced a 277 MiB message that HOL'd the connection writer for ~38s). Like the inbound cap, the limit applies to the **serialized JSON-RPC message**, before any WebSocket fragmentation — fragmenting a message cannot bypass it. The cap is enforced at two layers:

- **RPC responses** are checked at router serialization time, where the request id is known: an over-cap response is replaced with a **`-32010`** error echoing the request id, so the client fails fast instead of hitting its RPC timeout on a silently dropped message (§9).
- **Non-response messages** (subscription pushes, `events.event` notifications) are dropped by the connection writer task with an error log — a last-resort backstop, identical on UDS and WSS.

### 1.4 `/tunnel` — loopback port-forwarding endpoint

Beside `/ws`, the same WSS listener exposes a second WebSocket endpoint ([intent-hq/monorepo#2323](https://github.com/intent-hq/monorepo/issues/2323); [intent-hq/intentd#1205](https://github.com/intent-hq/intentd/pull/1205)):

```
wss://<host>:<port>/tunnel
```

`/tunnel` is the **loopback port-forwarding** surface: a remote client that cannot reach a daemon-host port directly (server bound to `127.0.0.1`, firewall) opens **one** `/tunnel` connection and multiplexes TCP streams over it. It is **not** a JSON-RPC transport — frames are **binary** mux frames, and a text frame is a protocol violation (`1002` close).

- **Auth & upgrade gate — identical to `/ws` (§2):** the enable flag (`403` when the WS API is disabled), the Origin allow-list (`403`), then the same bearer token (`Authorization: Bearer <token>` header or `?token=` query parameter; timing-safe compare; `401` on failure) — all checked before the WebSocket handshake completes. Insecure dev mode (`--insecure`) serves it as plain `ws://` with TLS and auth skipped, like `/ws`.
- **Shared connection lifecycle (§4):** tunnel connections live in the same client registry as `/ws` connections — the 30s-ping / 60s-pong-timeout heartbeat reaps them, graceful shutdown closes them with `1001` (`"Server shutting down"`), and they count toward the `/health` `clients` number.

**Frame format.** Each WebSocket **binary message** carries exactly one mux frame — the WebSocket provides message boundaries, so there is no length prefix:

```
[opcode u8][streamId u32 BE][payload...]
```

| Opcode | Name | Payload | Direction |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | port `u16` BE | client → daemon |
| `0x02` | `OPEN_OK` | (empty) | daemon → client |
| `0x03` | `OPEN_ERR` | UTF-8 message | daemon → client |
| `0x04` | `DATA` | raw bytes (may be empty) | both |
| `0x05` | `EOF` | (empty) | both |
| `0x06` | `CLOSE` | (empty) | both |

Malformed frames — shorter than the 5-byte header, an unknown opcode, an `OPEN` payload that is not exactly 2 bytes, a payload on a payload-less opcode (`OPEN_OK` / `EOF` / `CLOSE`), or a non-UTF-8 `OPEN_ERR` message — and the daemon-only opcodes (`OPEN_OK` / `OPEN_ERR`) arriving from the client end the whole **connection** with a `1002 Protocol Error` close naming the violation.

**Stream lifecycle** (`OPEN → OPEN_OK | OPEN_ERR → DATA* / EOF → CLOSE`). The client picks a `streamId` and sends `OPEN` with the target port; the daemon TCP-connects `127.0.0.1:<port>` and answers `OPEN_OK` (data may now flow both ways) or `OPEN_ERR` carrying the connect error:

- **Loopback-only connect policy.** Connect targets are hard-limited to the daemon's IPv4 loopback (`127.0.0.1:<port>`) by construction — the client supplies only a port, never a host. A service bound only to `::1` is intentionally out of scope.
- **`OPEN_ERR` is terminal** for an `OPEN` that never produced a stream (connect refused/failed, connect timeout, duplicate `streamId`, stream cap exceeded) — no `CLOSE` follows. A failed connect leaves the id free for reuse; a **duplicate-id** rejection frees nothing — the already-open stream keeps owning that id until its own final `CLOSE`.
- **`EOF` half-closes one direction:** client `EOF` ⇒ the daemon shuts down the TCP write side; TCP read EOF (or a read error, e.g. RST) ⇒ the daemon sends `EOF`. The other direction keeps flowing until it too ends. `DATA` after the sender's own `EOF` is a client error and is dropped.
- **`CLOSE` tears the stream down fully** (both directions), and the daemon **always sends a final `CLOSE` when an established stream ends for any reason** — including confirming a client `CLOSE` — after which the `streamId` may be reused. A daemon-side teardown can race the client's frames, so frames for unknown stream ids are **ignored** (a duplicate `CLOSE` is harmless).
- Client `CLOSE` is handled **out-of-band** — never queued behind pending `DATA` — so it is the client's escape hatch for a stream wedged on a stalled consumer.

**Caps & timeouts** (per connection unless noted):

| Limit | Value | On violation / expiry |
| --- | --- | --- |
| Concurrent streams | 32 | further `OPEN`s answered with `OPEN_ERR` until a stream closes |
| `DATA` payload (client → daemon) | 1 MiB | `1002` protocol close (whole connection) |
| Inbound WebSocket message | 5-byte header + 1 MiB | `1009 Message Too Big` close — tunnel-specific cap, **not** the 40 MiB JSON-RPC cap (§1.3) |
| TCP connect deadline | 10 s | `OPEN_ERR` naming the timeout |
| Idle stream (no data either way; also bounds one blocked TCP write) | 300 s | stream torn down (final `CLOSE`) |
| Wedged-stream forward deadline | 15 s | a stream whose full queue parks the mux is killed (final `CLOSE`) so pings keep flowing inside the heartbeat window |

Flow control is per-connection (bounded frame queues both ways; daemon-side TCP reads are chunked into one `DATA` frame per 16 KiB read), not per-stream, so one stream with a stalled consumer can briefly head-of-line-block its siblings' inbound frames — the caps above bound the wedge on every axis.

**FE fallback usage (Electron only).** The intended consumer is the `browser.exec` loopback-rewrite **tunnel fallback** (§5.9, §5.14; monorepo#2323): when a remote-rewritten `navigate` / `openTab` reachability probe fails, the Electron FE forwards the daemon port over `/tunnel` — a local TCP listener on the client machine relays to a tunnel stream — and navigates to `http://127.0.0.1:<localPort>` instead, echoing `tunneled: true` in the action result. Web builds cannot host a local TCP listener and keep the explanatory probe error.

