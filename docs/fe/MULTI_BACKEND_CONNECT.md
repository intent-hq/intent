# Multi-backend connect (FE)

How cloudlands-fe connects to a **remote intentd** (another machine) alongside
the local sidecar, and how the active backend is switched at runtime.

> **Scope: FE-only.** This is entirely a cloudlands-fe capability. intentd
> already serves WSS + a self-signed-cert fingerprint + a bearer token; there
> is **no daemon/protocol change**. The daemon-side wire contract this rides on
> is the canonical monorepo protocol doc set **§1.1–2.3** —
> [docs/protocol/01-transport.md](../protocol/01-transport.md) and
> [docs/protocol/02-authentication.md](../protocol/02-authentication.md)
> (Connection URL, TLS & fingerprint pinning, message size, bearer token on
> upgrade, origin allow-list, where the token lives). Read those for the
> transport; this doc covers only the FE side.

## What it does

The **daemon-status dropdown** (`DaemonStatusIndicator.svelte`) gains a
"Connect to another intentd" action and a past-connections list:

- The list's first, non-forgettable entry is **"This machine (local)"** (the UDS
  sidecar, which always keeps running). Remote connections are added after it.
- Adding a remote is manual **IP:port + token** entry with **trust-on-first-use**
  (TOFU) self-signed-cert confirmation: the FE dials the remote once, shows the
  presented certificate fingerprint, and only pins it once the user confirms.
- Switching the active backend is a **clean full teardown + reload** that is
  **multi-backend aware** for window/session state — the old daemon is fully
  disconnected before the new one connects, and each backend restores its own
  window layout.

## Pieces

### Transport (main)

`features/backend/main/backend-connection.ts` resolves a `BackendConnectionConfig`
(`uds` | `ws` | `tcp` | `wss`). The new work is the **pinned `wss` client**:

- `captureFingerprint(...)` — the TOFU probe. Opens the remote's TLS WebSocket,
  reads the presented cert's SHA-256 fingerprint (PROTOCOL §1.2 canonical
  colon-hex uppercase, via `normalizeFingerprint`), and closes. Returns a
  structured `{ ok: false, code }` on timeout / connect-failed / no-certificate.
- The pinned `wss` transport compares the presented fingerprint against the
  stored pin on **every** (re)connect. A mismatch throws `PinMismatchError`
  (`{ expected, actual }`) rather than silently re-trusting a changed cert.

### Connections store (main)

`features/backend/main/connections-store.ts` persists remotes + the active
selection to `backend-connections.json` under `app.getPath('userData')`
(separate from `local-prefs.json`). Each remote's bearer token is encrypted at
rest with Electron **`safeStorage`** when `isEncryptionAvailable()`, with an
explicit **plaintext fallback** (`encrypted: false`) when it is not. The local
sidecar is **not** a persisted record — a synthetic, non-forgettable
"This machine (local)" entry (id `local`) is always synthesized as the first
item of `list()`, and `activeId` defaults to `local`. Tokens never leave the
main process on a returned record shape.

### Switch orchestration + IPC (main)

`features/backend/main/backend.ipc.ts` owns the `connections:*` IPC channels
(`list`, `capture-fingerprint`, `add`, `forget`, `switch`; plus the main→renderer
push events `connections:changed` and `connections:cert-mismatch`) and the
`switchBackend(id)` orchestration:

1. **Resolve + validate the target first** (`buildConfigForConnection`) — a bad
   id or missing token throws _before_ any teardown, leaving the live backend
   untouched.
2. **Capture + close** the outgoing backend's windows while they are still live
   (T4 hook `captureAndCloseWindowsForBackendSwitch`).
3. **Dispose** the previous JSON-RPC client and all its subscriptions **before**
   the new target connects — no leaked socket/timers/listeners.
4. **Flip** the persisted active id and **build + start** the new client from
   the pinned config (or the local/env default for a switch back to local).
5. **Restore** the incoming backend's windows (T4 hook
   `restoreWindowsForBackend`), then broadcast the changed list.

`forget` of the _active_ remote falls back to a full switch to local rather than
stranding the FE. At boot, `reconcileActiveConnectionOnBoot()` resets a stale
persisted remote `activeId` to `local` (the live client is always built from the
local default at startup, and a remote may be unreachable).

**Stable forwarders (T8/T9).** Long-lived main-process services (terminal
registry, script manager, notification/app-settings services, ACP terminal)
attach their reconnect / notification / status listeners **exactly once** via
`onBackendReconnected` / `onBackendNotification` / `onBackendStatus`. These
attach to persistent `EventEmitter` forwarders that **outlive every client
swap** — not to the live client instance — so a post-switch daemon event still
drives terminal output/exit, script state, `agent:idle`, and `settings:changed`.
Each freshly built client's events are piped into the forwarders, and
`switchBackend` nudges the reconnect forwarder once so services resubscribe
against the new target. Without this, a service's listener would strand on the
disposed client and its events would be silently dropped for the rest of the
session.

### Backend-keyed window sessions (main)

`main/window.ts` stores `window-sessions.json` as a **backend-keyed map**
(`Record<backendId, WindowSession[]>`) instead of a single global array, so each
backend restores its own window layout on switch. A legacy top-level array is
lazily migrated into the `local` bucket. `saveWindowSessions(backendId)` /
`loadWindowSessions(backendId)` default to `local`; the switch hooks
(`captureAndCloseWindowsForBackendSwitch` / `restoreWindowsForBackend`) persist
the outgoing bucket and restore the incoming one (or open a fresh window).

### Renderer (store + UI)

- `store/renderer/slices/connections/` — the connections slice, selectors, and
  types (list + active selection + pairing/switch UI state).
- `store/renderer/slices/connections/sagas/connections-saga.ts` — bridges the
  slice to the `connections:*` IPC channels and folds `connections:changed` /
  `connections:cert-mismatch` push events back into the store.
- `store/renderer/seeders/connections-bridge-seeder.ts` — seeds the initial list.
- `lib/components/layout/ConnectBackendModal.svelte` — the add-remote /
  TOFU-confirm flow. `CertMismatchModal.svelte` — the blocking failure modal
  raised on `connections:cert-mismatch`. Both hang off
  `DaemonStatusIndicator.svelte`.

## Tests

- `features/backend/main/__tests__/multi-backend-connect.integration.test.ts` —
  the end-to-end journey (add → confirm → switch → back → mismatch → failure
  modal) through the real store, plus the T9 notification-survival guard.
- `backend-ipc-connections.test.ts`, `backend-ipc-switch-robustness.test.ts` —
  switch teardown ordering, boot reconciliation, and the stable forwarders.
- `connections-store.test.ts` — encrypted/plaintext token round-trips.
- `main/__tests__/window-sessions-multibackend.test.ts` — backend-keyed window
  save/restore + switch hooks.
