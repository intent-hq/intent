# Multi-backend connect (FE)

How cloudlands-fe talks to **multiple intentd daemons at once** — the local
sidecar plus any number of paired remotes — under the **Open-only** model:
every window is permanently bound to one backend, "Open" is the only
cross-backend action, and there is no whole-app switch and no "active backend"
as a routing concept.

> **Scope: FE-only.** This is entirely a cloudlands-fe capability. intentd
> already serves WSS + a self-signed-cert fingerprint + a bearer token; there
> is **no daemon/protocol change**. The daemon-side wire contract this rides on
> is the canonical monorepo protocol doc set **§1.1–2.3** —
> [docs/protocol/01-transport.md](../protocol/01-transport.md) and
> [docs/protocol/02-authentication.md](../protocol/02-authentication.md)
> (Connection URL, TLS & fingerprint pinning, message size, bearer token on
> upgrade, origin allow-list, where the token lives). Read those for the
> transport; this doc covers only the FE side.

## The model

- **Window ↔ backend binding is the identity.** Every `BrowserWindow` is
  stamped at creation with the backend id its renderer talks to
  (`main/window-backend.ts`); the stamp never changes for the life of the
  window. Per-window IPC routing (`backend:request` / `backend:subscribe` /
  status pushes) resolves the sender's stamp to that backend's pooled client —
  fail-closed: a non-local id without a live client throws instead of silently
  retargeting another backend (`getBackendClientForId`).
- **One pooled JSON-RPC client per backend.** `backend.ipc.ts` keeps a
  `Map<connectionId, JsonRpcClient>`. The **local** member is always-on and
  lazily built from the env/UDS default (`getLocalBackendClient`) — main-process
  services whose data must come from the local daemon (app settings, workspace
  paths, config persistence, sidecar surfaces) pin to it. Remote members are
  built on demand from the pinned config; all of a backend's windows share its
  client.
- **"Open" is the only cross-backend action.** Opening another backend connects
  its pooled client and opens/focuses its windows *next to* your current ones;
  nothing tears down or retargets any other backend. You leave a backend by
  closing its windows.
- **No active/primary backend.** The persisted `activeId` stays on disk for
  backward compatibility but no longer drives client routing, service
  targeting, or teardown. Its remaining reads are legacy defaults: which saved
  bucket restores first at boot (its first window becomes the main window),
  the fallback backend for a fresh first window, and a couple of
  wire/on-disk compatibility shims (the `connections:add` rebuild-if-active
  check + its `switched` result field, and the browser-capture state-dir key).

## What the user sees

- The **daemon-status dropdown** (`DaemonStatusIndicator.svelte`) lists
  **"This machine (local)"** first (non-forgettable), then paired remotes.
  Per-backend actions: **Open** (connect + open/focus that backend's windows),
  **Forget** (remotes only), and **Update** for a connected remote running
  behind the app's pinned intentd version (`connections:update-backend` routes
  `system.requestUpdate` to that backend's pooled client).
- Adding a remote is manual **IP:port + token** entry with **trust-on-first-use**
  (TOFU) self-signed-cert confirmation: the FE dials the remote once, shows the
  presented certificate fingerprint, and only pins it once the user confirms.
- The **Fleet HUD is per-backend** (`main/hud-window.ts`): opening the HUD binds
  it to the opener window's backend, one HUD per backend, HUDs for different
  backends coexist. The HUD footer's status dot opens a backend menu with Open
  actions (`features/hud/components/HudBackendMenu.svelte`).
- At **boot**, every backend that had windows open is restored to its own
  windows — an unreachable backend's windows still open and sit behind the
  per-window daemon-stopped overlay until its client reconnects.

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

`features/backend/main/connections-store.ts` persists remotes to
`backend-connections.json` under `app.getPath('userData')` (separate from
`local-prefs.json`). Each remote's bearer token is encrypted at rest with
Electron **`safeStorage`** when `isEncryptionAvailable()`, with an explicit
**plaintext fallback** (`encrypted: false`) when it is not. The local sidecar
is **not** a persisted record — a synthetic, non-forgettable
"This machine (local)" entry (id `local`) is always synthesized as the first
item of `list()`. The file also carries the legacy `activeId` field (defaults
to `local`; see "The model" above for the little it still does). Tokens never
leave the main process on a returned record shape.

### Pooled clients + IPC (main)

`features/backend/main/backend.ipc.ts` owns the client pool and the
`connections:*` IPC channels (`list`, `capture-fingerprint`, `add`, `open`,
`forget`, `update-backend`, plus the keychain-sync and self-publish channels;
main→renderer push events: `connections:changed`, `connections:cert-mismatch`,
`connections:auth-rejected`, `connections:protocol-mismatch`). There is no
`switch` channel. Mutating operations run through one enqueued critical
section so concurrent backend operations cannot interleave.

- **Open** (`openBackendWindow(id)`): connect the pooled client
  (`connectBackendClient` — idempotent; concurrent connects share one
  construction), complete an **authenticated `host.status` probe** before any
  renderer is created (a cert/token failure rejects this remote only, and its
  just-built client is disposed — the always-on local member is never torn
  down), then open/focus that backend's windows.
- **Forget**: remove the stored record (keychain-sync tombstone), ensure a
  local window survives if the forgotten backend owned every live window,
  close only that backend's windows, dispose its pooled client, broadcast.
- **Last-window close**: closing a non-local backend's last window disposes
  its pooled client (`disconnectBackendClient`), and the session bucket is
  tombstoned for the rest of the session so a dock-activate restore does not
  resurrect it. Open reconnects it and restores its saved layout.
- **Re-pair in place** (`connections:add` upserts by host:port): a backend
  with a live pooled client gets that client rebuilt with the refreshed
  token/fingerprint without closing any of its windows, followed by a
  synthetic `reconnected` replay so subscriptions re-arm.

**Stable forwarders.** Long-lived main-process services (terminal registry,
script manager, notification/app-settings services, ACP terminal) attach their
reconnect / notification / status listeners **exactly once** via
`onBackendReconnected` / `onBackendNotification` / `onBackendStatus`. These
attach to persistent `EventEmitter` forwarders that **outlive every client
rebuild** (e.g. a re-pair) — not to the live client instance — and every
forwarded event carries the originating **connection id**, so services route
per backend. Each freshly built client's events are piped into the forwarders.

### Per-backend failure surfaces (main + renderer)

Cert mismatch (`PinMismatchError` → blocking modal), **auth rejected**
(HTTP 401/403 on the WSS upgrade → actionable re-pair state; retrying with the
same token cannot succeed) and **protocol mismatch** (remote's major
`protocolVersion` differs from local — warn-but-allow) are all keyed by
connection id and **scoped to the affected backend's windows only**. Each is a
one-shot event per client plus a **sticky latched copy** in main, replayed on
`connections:list` for the requesting window's backend — so a window created
or reloaded *after* the one-shot broadcast fired (e.g. boot restore connects
pooled clients before their windows exist) still surfaces the state. The latch
clears whenever a fresh client for that id is constructed.

### Backend-keyed window sessions + boot restore (main)

`main/window.ts` stores `window-sessions.json` as a **backend-keyed map**
(`Record<backendId, WindowSession[]>`); a legacy top-level array is lazily
migrated into the `local` bucket. `saveWindowSessions(backendId)` /
`loadWindowSessions(backendId)` default to `local`.

At boot (and on macOS dock-activate with no windows),
`restoreAllBackendWindowSessions` restores **every backend that has a saved
session bucket**, not just one: each bucket's pooled client is connected
(idempotent) *before* its windows open, so restored windows resolve their own
daemon. Fail-soft per bucket: a backend whose client config cannot even be
built (forgotten remote, missing token) is skipped with a log, while an
**unreachable-but-buildable** backend still restores — client construction
does not await reachability, and the per-window daemon-stopped overlay shows
until its client connects. The legacy `activeId` bucket restores first so its
first window becomes the main window. `openOrFocusWindowsForBackend` backs the
Open action; `ensureLocalWindowBeforeClosingBackend` guarantees closing one
backend can never destroy the app's final live window.

### Daemon-stopped overlay (renderer)

`features/daemon-status/DaemonStoppedOverlay.svelte` is **per-window** and
driven by the window's own backend status: it appears (after a short grace
period) while that backend's health is down and auto-dismisses when its pooled
client reconnects. Recovery actions never retarget the window:

- **Local window**: "Start local intentd" spawns the app-managed sidecar on
  demand; the window's client reconnects to the UDS socket on its own.
- **Remote window**: "Open local" (`openLocalAndSpawn`) spawns the sidecar if
  needed and opens/focuses the *local backend's* windows — this window keeps
  its own (dead) backend and its overlay. Other saved backends are offered as
  one-click **Open** actions.
- **Auth rejected**: the generic cannot-connect copy is replaced by a re-pair
  posture (re-adding the same host:port refreshes the stored token).

### Renderer (store + UI)

- `store/renderer/slices/connections/` — the connections slice, selectors, and
  types. State carries `windowBackendId` (the backend bound to this renderer's
  window), `connectedIds` (backends with a live, connected pooled client —
  gates connected-only actions like remote Update), and the per-backend
  failure events; selectors gate every per-window surface on
  `windowBackendId`, so a failure renders only in the affected backend's
  windows.
- `store/renderer/slices/connections/sagas/connections-saga.ts` — bridges the
  slice to the `connections:*` IPC channels and folds the push events back
  into the store.
- `store/renderer/seeders/connections-bridge-seeder.ts` — seeds the initial list.
- `lib/components/layout/ConnectBackendModal.svelte` — the add-remote /
  TOFU-confirm flow. `CertMismatchModal.svelte` — the blocking failure modal
  raised on `connections:cert-mismatch`. Both hang off
  `DaemonStatusIndicator.svelte`.

## Tests

- `features/backend/main/__tests__/multi-backend-connect.integration.test.ts` —
  the end-to-end journey (add → confirm → open → mismatch → failure modal)
  through the real store, plus the notification-survival guard.
- `backend-ipc-connections.test.ts`, `backend-ipc-client-robustness.test.ts` —
  pool lifecycle, open/forget teardown ordering, and the stable forwarders.
- `backend-ipc-protocol-mismatch.test.ts` — the latched per-backend
  protocol-mismatch replay.
- `connections-store.test.ts` — encrypted/plaintext token round-trips.
- `main/__tests__/window-sessions-multibackend.test.ts` — backend-keyed window
  save/restore + multi-backend boot restore.
- `main/__tests__/hud-window.test.ts` — the per-backend HUD registry.
