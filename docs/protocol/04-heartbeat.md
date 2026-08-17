> Part of the [Intent JSON-RPC protocol docs](./README.md) — §4 Heartbeat & Lifecycle.

## 4. Heartbeat & Lifecycle

- **Ping/pong:** The server sends a WebSocket **ping every 30s** (`HEARTBEAT_INTERVAL_MS`). The client's transport must answer with a standard pong frame (handled automatically by compliant WebSocket libraries). If no pong is seen within **60s** (`HEARTBEAT_TIMEOUT_MS`), the server terminates the connection and cleans up its subscriptions.
- **Server shutdown:** On graceful stop, clients are closed with code `1001`(`"Server shutting down"`) and all transport-local subscriptions are dropped.
- **Disconnect cleanup:** On `close` or socket `error`, the server removes the client and all ofits event subscriptions. Subscriptions are **per-connection** and do **not** survive reconnects.
- **Reconnection guidance:** Clients should reconnect with backoff, re-authenticate on the newupgrade, and **re-establish all subscriptions** (re-send `events.subscribe`). Because canonicalstate lives in the backend, after reconnect a client should **re-fetch** the entities it caresabout (subscribe-then-fetch, §10) rather than assuming it missed nothing.

