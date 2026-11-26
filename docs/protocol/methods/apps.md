> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.60 Intent apps.

## 5.60 Intent apps — app library, app principal, `app.*` *(prepared)*

This is an **additive contract**, documented ahead of the implementation (docs lead
the pin). An agent builds a small static web app in a workspace. The user installs it
into the daemon's **app library**, approves its permissions, and opens it in its own
top-level window. The window talks to the daemon only through the desktop host's
`window.intent` bridge, on a connection bound to an **app principal** that has a
default-deny method allowlist per permission level.

The feature is a Labs feature. Milestone 1 (this section) covers the format, the
library, approval, app sessions, per-app storage, notifications and quick model calls.
Agent tasks and MCP connectors (M2), full access (M3) and streaming calls (M4) are
**not** part of this contract; their methods are added by a later docs change.

### Status and discovery

The daemon advertises exactly integer `server.capabilities.intentApps: 1`
([client.hello](./client-hello.md)) when it implements this section. Missing or other
values mean unsupported, and the client hides the app library. The flag grants no
permission. Catalog presence is not a support probe.

### Roles

| Party | Connection | What it does |
| --- | --- | --- |
| Library owner | Administrator connection (local UDS seat or the legacy owner token) | Installs, approves, revokes, uninstalls; opens app sessions; reads bundle files for the `intent-app://` scheme |
| Agent | MCP / `ws.rpc` (acts as the primary principal) | May call `app.install` (including `dryRun`), `app.list`, `app.get`. Refused for the user-only methods below |
| App host | The desktop main process (cloudlands-fe) | Owns the app window, the `intent-app://` scheme, the preload bridge and one app connection per open app |
| App | Renderer of the app window | Calls `window.intent` only. It never sees a token and never connects to the daemon itself |

**User-only methods.** `app.approve` and `app.session.open` are refused with
`-32003 { code: "forbidden", detail: "user-only" }` when the call comes from an agent
(an MCP tool or a `ws.rpc` proxy call). An agent can therefore never approve an app or
obtain a session token. All other `app.*` library methods are administrator methods
that agents may call.

**Guests and host members.** No `app.*` method is on the collaborator allowlist
([§5.48](./multiplayer.md#the-collaborator-allowlist--methods-default-deny)) or the
host member allowlist ([§5.49](./shared-host-membership.md)). They get the
connection-level `-32003` without `data`. The app library is daemon-global and
owner-only.

### App format

A bundle is a directory inside a workspace. It contains `intent-app.json` (the
manifest) at its root, plus static files, plus an optional detached signature file
`intent-app.sig` at its root ([Publisher and signature](#publisher-and-signature-reserved)).

#### Manifest file (intent-app.json)

```jsonc
{
  "manifestVersion": 1,                 // required, exactly 1
  "id": "pomodoro-timer",               // required, ^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$ (3–64 chars)
  "name": "Pomodoro Timer",             // required, 1–64 chars after trim, no control chars
  "version": "1.0.0",                   // required, SemVer 2.0.0, ≤ 64 chars
  "description": "A focus timer.",      // optional, ≤ 280 chars
  "icon": "icon.png",                   // optional, bundle path of a PNG (square, 256 px or more recommended)
  "entry": "index.html",                // optional, bundle path of an .html file; default "index.html"
  "permissions": {                      // required
    "level": 2,                         // required: 1 | 2 | 3
    "features": ["models", "notifications"] // optional, default []; unique values
  },
  "window": {                           // optional
    "width": 960,                       // 320–4096, default 960
    "height": 640,                      // 240–4096, default 640
    "minWidth": 320,                    // optional, 320–width
    "minHeight": 240,                   // optional, 240–height
    "resizable": true,                  // default true
    "alwaysOnTop": false                // default false; true needs the "alwaysOnTop" feature
  },
  "publisher": {                        // optional, reserved (stored, not verified in M1)
    "name": "Example Labs",             // required in the object, 1–128 chars after trim, no control chars
    "url": "https://example.com",       // optional, absolute https URL, ≤ 2048 chars
    "keyId": "ed25519:Rk9P…"            // optional, 1–256 printable ASCII chars, opaque; names the signing key
  },
  "updateUrl": "https://example.com/apps/pomodoro-timer"   // optional, reserved: absolute https URL, ≤ 2048 chars; M1 never fetches it
}
```

Unknown top-level keys, unknown keys in `permissions`, `window` or `publisher`, and
wrong types are `invalid-manifest`. A manifest without `publisher` and `updateUrl`
stays valid. A bundle path is a relative path with `/` separators, no `..`
segment, no leading `/`, no `\`, no NUL, at most 512 UTF-8 bytes, and it must name a
regular file of the bundle.

#### Validation rules

These rules apply to every limit in this section; intentd, the SDK validator and the
mock bridge must agree:

- **chars** counts Unicode code points (not UTF-16 units, not bytes). **bytes** counts
  UTF-8 bytes. "After trim" removes leading and trailing Unicode `White_Space`.
- **Control characters** are C0 (U+0000–U+001F), DEL (U+007F) and C1 (U+0080–U+009F).
  "No control chars" and the storage key rule both use this set.
- **Printable ASCII** is U+0021–U+007E (no space).
- **https URL**: printable ASCII only, at most 2048 chars, starts with the lowercase
  prefix `https://`, contains no `\`, has a character other than `/` right after the
  prefix, and parses as an absolute URL (WHATWG URL) with a non-empty host. The two
  extra rules refuse forms the parser repairs, such as `https:///path` (read as host
  `path`) and `https://\path`.
- **`intent-app.sig` limits**: at most 16384 bytes. It counts toward the 2000-file and
  64 MiB limits, but not toward `fileCount` / `sizeBytes`.
- **`signature` value**: checked only against `^[A-Za-z0-9_-]{1,1024}$`; the base64url
  length modulo 4 is not checked in M1.

#### Features

| Feature | Level | Grants | Enforced by |
| --- | --- | --- | --- |
| `notifications` | 2 | `app.notify` | intentd (service level) |
| `models` | 2 | `app.models.list`, `app.complete` | intentd (service level) |
| `globalShortcuts` | 2 | `intent.shortcuts.*` | App host |
| `alwaysOnTop` | 2 | `intent.window.setAlwaysOnTop`, `window.alwaysOnTop: true` | App host |

A level 1 manifest must have `features: []`. A level 2 or 3 manifest may list any of
the four features. Other values are `invalid-manifest`. M1 refuses a level 3 manifest
at install with `level-unavailable`.

#### Bundle limits

At most 2000 regular files, each at most 16 MiB, at most 64 MiB in total. Symlinks,
device files and sockets anywhere under the bundle root are `invalid-bundle`. Empty
directories are ignored. `intent-app.json` must be at most 64 KiB. `intent-app.sig`
must be at most 16 KiB and counts toward the file limits.

#### Bundle hash

The hash is computed over every regular file under the bundle root, the manifest
included, **except** the one root path `intent-app.sig` (a file of that name in a
subdirectory is hashed like any other). intentd, the SDK and the mock bridge must
produce the same bytes:

1. Collect each file's bundle path (relative, `/` separators, UTF-8 as stored on disk,
   no normalization).
2. Sort the paths by their UTF-8 bytes (ascending, bytewise).
3. Feed SHA-256, for each file in order: the path bytes, one `0x00` byte, the file
   length as ASCII decimal digits, one `0x00` byte, the file content bytes.
4. The hash is the string `"sha256:"` followed by the 64-char lowercase hex digest.

Approval is bound to this hash. Any change to any hashed file gives a new hash. A
change to `intent-app.sig` alone does not, so a replace install that only adds or
changes the signature keeps the approval.

#### Publisher and signature (reserved)

M1 **stores and returns** publisher and signature data, **checks only their shape**,
and **never verifies** them. Verification arrives with the package-file milestone;
until then no client may show a publisher as confirmed or treat a signature as trust.

- `publisher` is part of the manifest, so it is covered by the bundle hash.
- `intent-app.sig` is a detached signature over the bundle hash, so it does not change
  the hash it signs. It is UTF-8 JSON:

```jsonc
// intent-app.sig — every key required, no other keys
{
  "sigVersion": 1,                     // exactly 1
  "algorithm": "ed25519",              // reserved: 1–32 chars of [a-z0-9-]; "ed25519" is the only value defined
  "keyId": "ed25519:Rk9P…",            // 1–256 printable ASCII chars; should equal manifest publisher.keyId
  "bundleHash": "sha256:9f2c…",        // the bundle hash that was signed
  "signature": "q83v…"                 // base64url without padding, 1–1024 chars
}
```

- Reserved signed message (for the later milestone): the UTF-8 bytes of
  `"intent-app-sig-v1\n"` followed by the `bundleHash` string.
- A malformed `intent-app.sig` (not JSON, too large, a missing, extra or wrong-typed
  key) is `invalid-bundle` with `path: "intent-app.sig"`. A well-formed file whose
  `bundleHash` or `keyId` does not match is **not** an error in M1: it is stored and
  returned as `status: "unverified"`.
- `intent-app.sig` is stored with the app but is not a bundle file: `app.readBundle`
  answers `file-not-found` for it, and `fileCount` / `sizeBytes` exclude it.

#### Serving and isolation

- The daemon copies the bundle into its library at install, so later edits in the
  workspace do not change the installed app. Only a new `app.install` does.
- The app host serves the installed files from a main-owned `intent-app://<appId>/`
  scheme through `app.readBundle`. It never loads an app from a remote URL, a
  `file://` path or the Vite dev origin.
- Every response from the scheme carries this Content-Security-Policy:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'`.
  An app has no network access of its own. All daemon access goes through the bridge.
- Each app has its own persistent session partition `persist:intent-app-<appId>`
  (browser storage, IndexedDB). Uninstall clears it.

### Shapes

```jsonc
// App — app.list rows, app.get, app.install. Every key is always present.
{
  "id": "pomodoro-timer",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "description": "A focus timer.",           // string | null
  "icon": "icon.png",                        // bundle path | null
  "entry": "index.html",
  "bundleHash": "sha256:9f2c…",              // the installed bundle
  "fileCount": 4,
  "sizeBytes": 18234,
  "permissions": { "level": 2, "features": ["models", "notifications"] },   // requested, from the manifest
  "window": { "width": 960, "height": 640, "minWidth": null, "minHeight": null, "resizable": true, "alwaysOnTop": false },
  "approval": {
    "status": "approved",                    // "pending" | "approved" | "revoked"
    "level": 2,                              // 1 | 2 | null (null unless approved or revoked)
    "features": ["models"],                  // granted subset of permissions.features; [] unless approved or revoked
    "bundleHash": "sha256:9f2c…",            // the hash the user approved | null
    "approvedAt": "2026-11-26T12:00:00.000Z" // | null
  },
  "source": { "workspaceId": "ws-1", "path": "apps/pomodoro" },   // the install source | null when the workspace is gone
  "installedAt": "2026-11-26T11:59:00.000Z", // first install of this id
  "updatedAt": "2026-11-26T11:59:00.000Z",   // last install, approval or revoke
  "open": false,                             // a session is live for this app
  "publisher": {                             // manifest publisher as stored | null
    "name": "Example Labs", "url": "https://example.com", "keyId": "ed25519:Rk9P…",   // url, keyId: string | null
    "verified": false                        // always false in M1
  },
  "updateUrl": "https://example.com/apps/pomodoro-timer",   // manifest updateUrl | null; reserved, never fetched in M1
  "signature": {                             // intent-app.sig as stored | null when the bundle has none
    "sigVersion": 1, "algorithm": "ed25519", "keyId": "ed25519:Rk9P…",
    "bundleHash": "sha256:9f2c…", "signature": "q83v…",
    "status": "unverified",                  // M1: always "unverified". Reserved later: "valid" | "invalid" | "untrusted-key"
    "verified": false                        // true only when status is "valid"; always false in M1
  }
}

// AppSession — app.session.open result (token only here), app.session.attach result (no token)
{
  "sessionId": "as_7d1e…",
  "token": "<64 hex chars>",                 // app.session.open only
  "appId": "pomodoro-timer",
  "bundleHash": "sha256:9f2c…",
  "level": 2,
  "features": ["models"],                    // the approved features
  "entry": "index.html",
  "window": { "width": 960, "height": 640, "minWidth": null, "minHeight": null, "resizable": true, "alwaysOnTop": false }
}
```

`approval.status` rules: a new install and a replace with a new hash set `pending`
(all other approval keys reset to `null` / `[]`). A replace with the same hash keeps
the approval. `app.approve` sets `approved`. `app.revoke` sets `revoked` and keeps the
last level, features and hash for display; a later `app.approve` can approve again.

### Library methods (administrator)

| Method | Params | Result |
| --- | --- | --- |
| `app.install` | `workspaceId` (req), `path` (req), `replace?: boolean` (default false), `dryRun?: boolean` (default false) | `{ app: App, replaced: boolean, approvalReset: boolean, dryRun: boolean }` |
| `app.uninstall` | `appId` (req) | `{ removed: boolean }` |
| `app.list` | none | `{ apps: App[] }` |
| `app.get` | `appId` (req) | `{ app: App }` |
| `app.approve` | `appId` (req), `bundleHash` (req), `level` (req), `features` (req, may be `[]`) | `{ app: App }` |
| `app.revoke` | `appId` (req) | `{ app: App, revoked: boolean }` |
| `app.readBundle` | `appId` (req), `path` (req), `bundleHash?` | `{ path, mimeType, sizeBytes, contentBase64 }` |

- **`app.install`.** `path` is the bundle directory relative to the workspace root
  (`""` or `"."` is the root). After symlinks resolve, it must stay inside the root,
  else `path-not-found`. The daemon reads and validates the manifest, checks the
  limits, computes the hash and copies the files. An existing `id` without
  `replace: true` is `app-exists`. With `replace: true` the new bundle replaces the old
  one (storage is kept), every open session of the app ends, and `approvalReset` is
  true when the hash changed. `dryRun: true` validates and returns the would-be `App`
  (`approval.status: "pending"`, `open: false`) and stores nothing, ends nothing and
  publishes nothing; `app-exists` still applies so an agent learns about the conflict.
  Publishes `app:installed`, then `app:approval-changed` when `approvalReset`.
- **`app.uninstall`.** Ends every session, deletes the installed files, the approval and
  the app's `app.storage` data. The host clears the session partition when it sees
  `app:removed`. An unknown `appId` answers `{ removed: false }` and publishes nothing.
- **`app.list`.** Sorted by `name` (case-insensitive), then `id`.
- **`app.approve`.** User-only. `bundleHash` must equal the installed hash, else
  `hash-mismatch` (the user approved what they saw). `level` must equal
  `permissions.level`, else `invalid-params`. `features` must be a subset of
  `permissions.features`, else `invalid-params`; the user may decline features.
  `level: 3` is `level-unavailable` in M1. Approving an approved app with the same
  values is a no-op that publishes nothing; otherwise it publishes `app:approval-changed`.
  A change of granted features ends every open session of the app, so the host reopens
  it with the new grant.
- **`app.revoke`.** Ends every session and publishes `app:approval-changed`.
  `revoked: false` (no event) when the app was not approved.
- **`app.readBundle`.** `path` is a bundle path (`""`, `/`, a directory or an unknown
  file is `file-not-found`). With `bundleHash`, a different installed hash is
  `hash-mismatch`, so the host never mixes files of two versions in one window.
  `mimeType` comes from the extension: `.html` `text/html`, `.js` / `.mjs`
  `text/javascript`, `.css` `text/css`, `.json` / `.map` `application/json`, `.svg`
  `image/svg+xml`, `.png` `image/png`, `.jpg` / `.jpeg` `image/jpeg`, `.gif`
  `image/gif`, `.webp` `image/webp`, `.ico` `image/x-icon`, `.woff` `font/woff`,
  `.woff2` `font/woff2`, `.ttf` `font/ttf`, `.otf` `font/otf`, `.wasm`
  `application/wasm`, `.txt` `text/plain`, `.mp3` `audio/mpeg`, `.mp4` `video/mp4`,
  `.webm` `video/webm`, else `application/octet-stream`. Text types carry no charset
  parameter; the host adds `; charset=utf-8` for `text/*`. It returns a whole file
  (up to 16 MiB before base64), so intentd classifies it as `BulkTransfer` in
  `PAYLOAD_CLASSES`. Over a remote (WSS) connection the host sends it on a
  [transfer connection](./files-terminal-browser.md) and lists it in the app's
  `TRANSFER_METHODS`; over the local socket it uses its one administrator connection.

### Sessions and the app principal

| Method | Params | Result |
| --- | --- | --- |
| `app.session.open` | `appId` (req) | `AppSession` (with `token`) |
| `app.session.close` | `sessionId` (req) | `{ closed: boolean }` |
| `app.session.attach` | `token` (req) | `AppSession` (without `token`) |

**Open.** User-only, on an administrator connection. The app must be `approved` for
its installed hash, else `not-approved`. The token is 32 random bytes, hex-encoded. The
daemon keeps only its SHA-256, in memory; tokens do not survive a daemon restart. An
app has at most one session: opening a new one ends the old one first.

**Attach.** The host opens a **new** connection to the daemon (the same transport it
uses for its administrator connection: local UDS / named pipe, or WSS with the owner
token) and sends `app.session.attach { token }` as the **first** request, before
`client.hello` and before anything else. On success the connection is bound to the
app principal for the rest of its life. This is a one-way narrowing of an
administrator connection; nothing can widen it again. Rules:

- The connection must be admitted as administrator. A guest or host member
  connection gets `-32003` (the method is on no non-administrator allowlist).
- Any earlier request on the connection makes attach fail with `attach-not-first`.
- An unknown, ended or wrong token is `session-invalid`.
- On every attach failure the daemon sends the error response and then closes the
  connection.
- More than one connection may attach with the same token (a reconnect). All of them
  close when the session ends.
- `app.session.attach` is a fast-path method: it acts on per-connection state.

**Session end.** A session ends on `app.session.close`, a new `app.session.open` for
the app, `app.revoke`, `app.uninstall`, `app.install` with `replace: true`, an
`app.approve` that changes the granted features, a daemon restart, and when the
administrator connection that opened it closes. On end the daemon forgets the token and
closes every attached connection: WSS close code **1008** with reason
`app session ended`, UDS / named pipe EOF. `app.session.close` of an unknown or ended
session answers `{ closed: false }`.

**The app principal.** An attached connection is bound to
`{ kind: "app", appId, bundleHash, level, features, sessionId }`. It is a
non-administrator principal, but the collaborator allowlist does not apply: the
level allowlist below replaces it. Agents, notes and other principals never see app
connections as members or presence. `principal.me` on an app connection answers:

```jsonc
{ "kind": "app", "id": "app:pomodoro-timer", "appId": "pomodoro-timer", "bundleHash": "sha256:9f2c…",
  "level": 2, "features": ["models"], "sessionId": "as_7d1e…",
  "isAdministrator": false, "login": null, "displayName": "Pomodoro Timer", "avatarUrl": null }
```

On daemons that advertise `intentApps: 1`, `principal.me` on a person connection also
carries the additive `kind: "person"`. A missing `kind` means `"person"`.

App connections never send `client.hello`, receive no events (`events.subscribe` is
not allowlisted, and the daemon fans no event out to them) and are not counted in
`client.list`.

### The app allowlists — methods (default-deny)

The connection's single inbound chokepoint
([§5.48](./multiplayer.md#the-collaborator-allowlist--methods-default-deny)) checks an
app connection against the list for its approved `level` **before every classify and
dispatch path**. A miss, unknown names included, is `-32003 "Forbidden"` without
`data`. The lists are exact; intentd freezes them in golden tests
(`APP_LEVEL1_METHODS`, `APP_LEVEL2_METHODS`, `APP_LEVEL3_METHODS`).

**Level 1 — Default (5 methods)**

| Namespace | Allowed methods |
| --- | --- |
| app (4) | storage.delete, storage.get, storage.list, storage.set |
| principal (1) | me |

**Level 2 — App features (8 methods)**: Level 1 plus:

| Namespace | Allowed methods |
| --- | --- |
| app (3) | complete, models.list, notify |

**Level 3 — Full access (8 methods in M1)**: exactly the Level 2 list. Level 3 cannot be
approved in M1 (`level-unavailable`), so no connection is bound at level 3 yet. M3
adds its file and program methods, each behind the per-action permission flow
([§8](../08-permission-flow.md)), in a later docs change.

Everything else is refused, including `client.hello`, `events.*`, `event.*`,
`agent.*` (also `agent.completeOnce`), `models.list`, `file.*`, `host.*`, `mcp.*`,
`settings.*`, the library methods and every `app.session.*` method.

**Feature checks (service level).** Inside the allowed set, a method whose feature is
not in the session's `features` is `-32003 { code: "forbidden", detail: "feature <name> not approved" }`:
`app.notify` needs `notifications`; `app.models.list` and `app.complete` need `models`.

**Event types.** None. The app event allowlist is empty in M1.

### App methods (app principal)

These methods take the app from the bound principal. No method takes an `appId`. Any
caller that is not an app principal (the administrator included) gets
`-32003 { code: "forbidden", detail: "app principal required" }`.

| Method | Params | Result |
| --- | --- | --- |
| `app.storage.get` | `key` (req) | `{ found: boolean, value: JSON \| null }` |
| `app.storage.set` | `key` (req), `value` (req, any JSON) | `{ usedBytes: number }` |
| `app.storage.delete` | `key` (req) | `{ deleted: boolean }` |
| `app.storage.list` | `prefix?` (default `""`), `cursor?`, `limit?` (1–1000, default 100) | `{ keys: string[], nextCursor: string \| null }` |
| `app.notify` | `title` (req), `body?`, `tag?` | `{ notificationId: string }` |
| `app.models.list` | none | `{ defaultProvider: string \| null, providers: AppModelProvider[] }` |
| `app.complete` | `prompt` (req), `system?`, `provider?`, `model?`, `reasoningEffort?`, `timeoutMs?` | `{ available: true, text, provider, model }` or `{ available: false, reason }` |

**Storage.** A durable key-value store per app id, in the daemon database. It is kept
across `replace` installs and revokes and deleted by uninstall.

- `key`: 1–256 UTF-8 bytes, no control characters (C0, DEL, C1; see Validation rules), else
  `invalid-key`.
- `value`: any JSON value, `null` included. Its compact serialized form is at most
  256 KiB, else `value-too-large`.
- Quota: the sum of key bytes plus serialized value bytes is at most 10 MiB per app.
  A `set` that would exceed it is `quota-exceeded` with `{ limitBytes, usedBytes }` and
  changes nothing. `usedBytes` in the result is the total after the write.
- `list` returns keys that start with `prefix`, sorted by UTF-8 bytes. `cursor` is the
  opaque `nextCursor` of the previous page; an invalid cursor is `invalid-params`.
  `nextCursor` is `null` on the last page.

**`app.notify`.** `title`: 1–128 chars after trim. `body`: at most 1024 chars. `tag`:
1–64 chars; a later notification with the same tag replaces the earlier one. The daemon
validates, applies a limit of 10 calls per app per rolling 60 s (`rate-limited` with
`retryAfterMs`), and returns an id. **The calling app host shows the OS notification**
after a success; the daemon publishes no event and sends no push in M1. A click on the
notification focuses the app window.

**`app.models.list`.** The providers that `app.complete` can use: the one-shot-capable
providers of `agent.completeOnce` ([§5.32](./agent-aux.md#532-agentcompleteonce--one-shot-promptcompletion))
that are registered on this daemon.

```jsonc
// AppModelProvider
{ "providerId": "claude-code", "displayName": "Claude Code",
  "available": true,                    // false when the adapter cannot run
  "reason": null,                       // string when available is false (display only, never parse)
  "defaultModel": "claude-opus-5-5",    // string | null (provider default)
  "models": [ { "id": "claude-opus-5-5", "displayName": "Claude Opus 5.5" } ] }
```

`defaultProvider` is the effective default provider of `agent.completeOnce`, or `null`
when it has none or it is not one-shot-capable. Models come from the `models.list`
cache (§5.30); no refresh is forced.

**`app.complete`.** A one-shot model call on the same executors as
`agent.completeOnce` (the auggie print route or an ephemeral ACP session; no agent
session, no workspace; the daemon uses a private temporary directory as the working
directory). It is a **separate entry point** with **explicit provider routing**: it
does not call `agent.completeOnce` and does not change §5.32.

- `provider` selects the provider directly. When it is omitted, `defaultProvider` from
  `app.models.list` is used. An id not in `app.models.list` is `provider-unknown`. The
  effective default provider never overrides an explicit `provider`.
- `model` is a model id of the selected provider, resolved against that provider only
  (never against the default provider). When it is omitted, the provider's
  `defaultModel` is used. An id not in that provider's `models` is `model-unknown`.
- completeOnce's `type` (a quick-action preference key such as `commit` or `review`)
  is not used and not set by `app.complete`.
- `prompt`: 1–200000 chars. `system`: at most 50000 chars; it is the system prompt.
  `reasoningEffort` has the completeOnce meaning.
- `timeoutMs`: 1000–300000, default 120000; expiry is `-32603 { code: "timeout" }` and
  the provider process is reaped.
- At most 2 calls per app are in flight; a third is `rate-limited` with
  `retryAfterMs: 1000`.
- A selected provider whose adapter cannot run (`available: false` in
  `app.models.list`), or no provider at all (`provider` omitted and `defaultProvider`
  is `null`), is the typed `{ available: false, reason }` result, not an error.
- The result echoes the `provider` and `model` that ran. Model calls use the owner's
  provider sign-in; the daemon logs each call with `appId` for audit.

### Errors

All `app.*` refusals that a user can act on are `-32602` with `data.code`; transient or
service failures are `-32603`. `data.detail` (a string) may add context; never parse it.

| Code | `error.data` | When |
| --- | --- | --- |
| -32003 Forbidden | none | Connection-level allowlist refusal: an app connection called a method outside its level list; a guest or host member called any `app.*` method |
| -32003 Forbidden | `{ code: "forbidden", detail }` | User-only method from an agent (`detail: "user-only"`); app-principal method from another principal (`"app principal required"`); feature not approved (`"feature <name> not approved"`) |
| -32602 | `{ code: "app-not-found" }` | Unknown `appId` (every method with `appId` except `app.uninstall`) |
| -32602 | `{ code: "app-exists" }` | `app.install` of an installed `id` without `replace: true` (also on `dryRun`) |
| -32602 | `{ code: "path-not-found", detail }` | `app.install` path missing, not a directory, without `intent-app.json`, or outside the workspace root |
| -32602 | `{ code: "invalid-manifest", detail, field }` | Manifest is not JSON, too large, or breaks a field rule; `field` is a JSON pointer such as `/permissions/features/0` |
| -32602 | `{ code: "invalid-bundle", detail, path }` | Symlink or special file, too many files, a file or the total too large, a bad path; `path` is the bundle path or `null` |
| -32602 | `{ code: "level-unavailable" }` | Level 3 in `app.install` or `app.approve` (M1) |
| -32602 | `{ code: "hash-mismatch", bundleHash }` | `app.approve` / `app.readBundle` with a hash other than the installed one; `bundleHash` is the installed hash |
| -32602 | `{ code: "not-approved" }` | `app.session.open` for an app that is not approved for its installed hash |
| -32602 | `{ code: "file-not-found" }` | `app.readBundle` path that names no file of the bundle |
| -32602 | `{ code: "session-invalid" }` | `app.session.attach` with an unknown or ended token (connection then closed) |
| -32602 | `{ code: "attach-not-first" }` | `app.session.attach` after another request on the connection (connection then closed) |
| -32602 | `{ code: "invalid-key" }` / `{ code: "value-too-large" }` | Storage key or value rule broken |
| -32602 | `{ code: "quota-exceeded", limitBytes, usedBytes }` | `app.storage.set` over the per-app quota |
| -32602 | `{ code: "provider-unknown" }` / `{ code: "model-unknown" }` | `app.complete` with a provider or model not in `app.models.list` |
| -32602 | `{ code: "invalid-params", detail }` | Any other param rule (types, ranges, `level` mismatch, `features` not a subset, bad cursor) |
| -32603 | `{ code: "rate-limited", retryAfterMs }` | `app.notify` over 10 per 60 s; a third concurrent `app.complete` |
| -32603 | `{ code: "timeout" }` | `app.complete` exceeded `timeoutMs` |

### Events

All three are **daemon-global** (no `workspaceId`), persisted like other lifecycle
rows, and delivered to administrator connections only. They are not on the
collaborator or host member event allowlists, and app connections receive no events.
They are unrelated to the existing `app:ui-*` / `app:workspace-open` UI events.

| Type | `data` | Published by |
| --- | --- | --- |
| `app:installed` | `{ appId, version, bundleHash, replaced: boolean }` | `app.install` (not `dryRun`) |
| `app:removed` | `{ appId }` | `app.uninstall` that removed an app |
| `app:approval-changed` | `{ appId, bundleHash, status, level, features }` — the new `App.approval` values plus the installed hash | `app.approve` (when something changed), `app.revoke` (when it revoked), `app.install` with `approvalReset` |

Clients re-read `app.list` / `app.get` on any of them. `App.open` changes publish
nothing; the host knows its own windows.

### The app bridge (window.intent)

The app host injects `window.intent` into each app window with a preload script
(`contextBridge`, context isolation on, Node integration off, sandbox on). Each call
goes over IPC to the host main process, which forwards it on the app's attached
connection or handles it locally. The host maps only the names below; any other name
is `not-supported`. The SDK (`intent-hq/intent-apps`) wraps this object and its mock
bridge implements the same names, results and error codes.

```ts
interface IntentBridge {
  readonly bridgeVersion: 1;
  app: { info(): Promise<AppInfo> };
  storage: {
    get(key: string): Promise<unknown | undefined>;        // undefined when not found
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: string[]; nextCursor: string | null }>;
  };
  notifications: { show(n: { title: string; body?: string; tag?: string }): Promise<{ notificationId: string }> };
  models: {
    list(): Promise<{ defaultProvider: string | null; providers: AppModelProvider[] }>;
    complete(req: { prompt: string; system?: string; provider?: string; model?: string; reasoningEffort?: string; timeoutMs?: number }):
      Promise<{ text: string; provider: string; model: string }>;
  };
  window: { setAlwaysOnTop(on: boolean): Promise<void>; close(): Promise<void> };
  shortcuts: { register(accelerator: string): Promise<void>; unregister(accelerator: string): Promise<boolean>; unregisterAll(): Promise<void> };
  on(type: "shortcut" | "session-ended", listener: (data: any) => void): () => void;   // returns an unsubscribe function
}

interface AppInfo {
  appId: string; name: string; version: string; bundleHash: string;
  level: 1 | 2 | 3; features: string[];
  platform: "mac" | "windows" | "linux" | "intent-os";
  bridgeVersion: 1;
}
```

| Daemon method | Bridge call | Level / feature | Notes |
| --- | --- | --- | --- |
| `app.storage.get` | `intent.storage.get(key)` | 1 | Resolves `value`, or `undefined` when `found` is false |
| `app.storage.set` | `intent.storage.set(key, value)` | 1 | Resolves `undefined` |
| `app.storage.delete` | `intent.storage.delete(key)` | 1 | Resolves `deleted` |
| `app.storage.list` | `intent.storage.list(opts)` | 1 | Resolves the result unchanged |
| `app.notify` | `intent.notifications.show(n)` | 2 `notifications` | Host shows the OS notification after the daemon answers |
| `app.models.list` | `intent.models.list()` | 2 `models` | Resolves the result unchanged |
| `app.complete` | `intent.models.complete(req)` | 2 `models` | `{ available: false, reason }` rejects with `unavailable` (`message` = `reason`) |
| host-local | `intent.app.info()` | 1 | From the `AppSession`; no daemon call |
| host-local | `intent.window.setAlwaysOnTop(on)` | 2 `alwaysOnTop` | |
| host-local | `intent.window.close()` | 1 | Closes the window; the host closes the session |
| host-local | `intent.shortcuts.register(acc)` | 2 `globalShortcuts` | Electron accelerator syntax. Registering an accelerator the app already holds resolves (no-op). An 11th distinct accelerator: `invalid-params`. Taken by the OS or another app: `shortcut-unavailable` |
| host-local | `intent.shortcuts.unregister(acc)` / `unregisterAll()` | 2 `globalShortcuts` | All are released when the window closes |
| host-local | `intent.on("shortcut", fn)` | 2 `globalShortcuts` | `data = { accelerator }` |
| host-local | `intent.on("session-ended", fn)` | 1 | `data = { reason: "closed" \| "revoked" \| "uninstalled" \| "updated" \| "disconnected" }`; the window closes after the listeners run. `"disconnected"` only when a reopen failed (below) |

`principal.me` has no bridge call; `intent.app.info()` covers it.

**Reconnect.** When the host's administrator connection drops, the daemon ends the
host's sessions. After it reconnects, the host calls `app.session.open` again for each
open window and attaches a new app connection; when the new `AppSession` has the same
`bundleHash`, `level` and `features`, the window stays open and only calls made during
the gap reject with `disconnected`. Otherwise (or when open fails) the host emits
`session-ended` and closes the window. The reasons map from the cause of the end:
`closed` (the user or `intent.window.close()`), `revoked` (`app.revoke`), `uninstalled`
(`app.uninstall`), `updated` (a replace install or a changed feature grant),
`disconnected` (reopen failed).

**Host-local feature checks.** The host checks host-local calls against the session's
`level` and `features` and rejects a miss with `forbidden`. Daemon calls are checked by
the daemon; the host does not pre-filter them.

**IPC.** Renderer to main: `ipcRenderer.invoke("intent-app:invoke", { call, args })`,
where `call` is the bridge name without `intent.` (for example `"storage.get"`) and
`args` is the argument array. Main answers `{ ok: true, result }` or
`{ ok: false, error: { code, message, data? } }`. Main to renderer:
`"intent-app:event"` with `{ type, data }`. The host accepts these messages only from
the app window's own `webContents` and frame `intent-app://<appId>/`.

**`on()` is synchronous.** It returns the unsubscribe function. An unknown event type
throws `not-supported` synchronously; `on("shortcut", …)` without the `globalShortcuts`
feature throws `forbidden` synchronously.

**Rejection shape.** The raw `window.intent` rejects with a plain object
`{ code, message, data? }` (`data` omitted when empty), not an `Error` instance,
because only plain objects survive `contextBridge` intact. The SDK turns it into an
`IntentError`.

**Errors seen by the app.** Calls reject with `IntentError { code, message, data? }`:

| `code` | From |
| --- | --- |
| `forbidden` | Any `-32003`, or a host-local feature miss |
| the daemon `data.code` | Any `-32602` / `-32603` with a `data.code` above (`invalid-key`, `value-too-large`, `quota-exceeded`, `rate-limited`, `provider-unknown`, `model-unknown`, `timeout`, `invalid-params`, …); `data` is the daemon `error.data` without `code` |
| `unavailable` | `app.complete` answered `{ available: false, reason }` |
| `shortcut-unavailable` | Host could not register the accelerator |
| `not-supported` | Unknown bridge call, or the daemon lacks `intentApps: 1` |
| `disconnected` | The app connection closed or the session ended before the answer |
| `internal` | Anything else |

### Window identity and open entry (host contract)

Not wire surface; recorded here so the desktop and Intent OS sides agree.

- Window title `Intent App: <name>`. Wayland `app_id` / X11 `WM_CLASS`
  `intent-app-<appId>` where the platform allows it. One window per app; a second open
  focuses the open window.
- Open entry: `intent --open-app <appId>` and `intent://app/<appId>`, handled by the
  first instance.
- On Intent OS the host writes `$XDG_STATE_HOME/intent/apps.json` atomically (write a
  temp file, then rename) after each library change:
  `{ "version": 1, "apps": [{ "id", "name", "icon": "<absolute PNG path>" | null, "windowTitle": "Intent App: <name>" }] }`,
  listing approved apps sorted like `app.list`. The top bar reads only this file.

### Storage (intentd)

Informative. Installed files live under `<data dir>/apps/<appId>/<hash hex>/`; the
previous hash directory is deleted after a successful replace. App records, approvals
and `app.storage` rows are in intent-store tables keyed by `appId`. Session tokens are
memory-only.

### Capability probe

`intentApps: 1` in `client.hello` is the probe. A daemon without this section answers
`-32601` to `app.*` methods on an administrator connection.
