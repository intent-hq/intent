> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.14 Execution locus, locality & remote behavior.

### 5.14 Execution locus, locality & remote behavior

All side effects — PTYs, scripts, file I/O, git, ACP provider processes — run on the **daemon
host**, not on the client. A thin client is a remote viewer/driver over the wire, so the
protocol surfaces **where** execution happens and adapts when the client is not on the same
machine.

**Locality is inferred from the transport:**

- **UDS (Unix-domain socket) or explicit `--mode local` ⇒ same machine.** The desktop FE
  typically spawns `intentd` itself and connects over a local Unix socket; a UDS connection is
  the signal that GUI windows, `open`, simulators, and detected URLs are directly visible and
  usable by the user. A `server.locality = local | remote` setting (§5.12) can force this.
- **TCP / WSS ⇒ treat as remote.** Side effects happen on another machine, so GUI-spawning
  commands may not be visible and detected dev-server URLs need forwarding.

**`host.*` — capability probe + FE-served intents:**

The `Direction` column below records who initiates the JSON-RPC **request** on the wire:
`client → daemon` is a normal client-called method (client picks the `id`); `daemon → client`
is a **reverse RPC** where the *daemon* is the requester and the connected client responds
(daemon picks the `id`, always in the `rev-<n>` namespace — the mechanism is spelled out
in the bullet under this table).

| Method | Direction | Params | Result |
| --- | --- | --- | --- |
| host.status | client → daemon | — (no workspaceId) | { os, arch, hostname, prettyHostname, hasDisplay, locality, displayServer? } — host capability probe. `prettyHostname` (additive, [intent-hq/intentd#1466](https://github.com/intent-hq/intentd/pull/1466)) is the OS "pretty" device name (macOS Computer Name, e.g. "Clement's Mac Studio"), falling back to `hostname` when no pretty name is available — detect by presence |
| host.openExternal | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | url (req) | { ok: true } — **FE-served**: routes an "open in browser/app" intent back to the *user's* machine |
| host.openInEditor | **client → daemon** (trigger) *and* **daemon → client** (reverse RPC, `id: "rev-<n>"`) | editorId (req), path (req), line?, column? | { ok: true } — launches the user's editor on `path` (optional `line`/`column` hint). **Client-callable trigger**: the FE calls this like any other method; on a local connection the daemon short-circuits via the resolved `host.listInstalledEditors` entry and launches on the daemon host, on a remote connection the daemon re-dispatches the intent to the connected client as the FE-served reverse RPC so the editor opens on the user's laptop. `-32602` on missing `editorId`/`path` or an `editorId` unknown to the platform catalog; `-32603` when the editor is not installed, the local host is headless, or the launch / reverse proxy fails |
| host.pickApplication | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | path (req) | { applicationId? } — **FE-served**: "open with…" chooser. Always dispatched to the connected client, which echoes its selection back as `applicationId?` (or nothing when no chooser is available); there is no daemon-side chooser |
| host.listDirectory | client → daemon | path? | { path, parent, home, entries: [{ name, path, isDirectory, isGitRepo }], favorites: [{ id, path }] } — directory listing for the FE directory picker. `path` defaults to the daemon-host home when absent/empty, and a leading `~` / `~/` is **expanded to the daemon-host home on the daemon** (`~user` forms pass through verbatim) — so clients may send a raw typed `~/sub` even when they have no `home` to expand against (monorepo#824). `home` is always present (never null/omitted): it is the daemon-host home, falling back to `/` when no home can be resolved from the environment — the defaulted `path` and `~` expansion then resolve against `/` too. The returned `path`/`parent`/entry paths are always fully expanded; `parent` is `null` at the filesystem root; entries include hidden files (the FE filters), sorted directories-first then by name. `favorites` (additive within v7.0, [intent-hq/intentd#1268](https://github.com/intent-hq/intentd/pull/1268)) reports the standard user directories that exist on the daemon host as `{ id, path }` rows in the fixed order `home` / `desktop` / `documents` / `downloads` — `home` is always included and always leads; the rest are existence-checked (a missing directory is omitted) and resolved against the daemon-host home regardless of the listed `path`: via the XDG user-dirs config (`~/.config/user-dirs.dirs`) on Linux — so relocated/localized folders resolve correctly — falling back to the conventional home-joined names (`~/Desktop` etc.) when the config is absent, lacks an entry, or carries an invalid (unquoted/relative) or `$HOME`-disabled value (the macOS path, and the Linux default). IO failures surface as `-32603` |
| host.createDirectory | client → daemon | path (req) | { path } — creates the directory on the daemon host with parents (`create_dir_all` semantics); succeeding when the directory already exists is deliberate (idempotent). A leading `~` / `~/` is **expanded to the daemon-host home on the daemon**, exactly like `host.listDirectory` (`~user` forms pass through verbatim), and the returned `path` is always the fully expanded created path so the FE can navigate into it. `-32602` on a missing/empty `path`; IO failures surface as `-32603` with the error message |
| host.exec | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId? | { stdout, stderr, exitCode, timedOut? } — daemon-owned one-shot exec |
| host.execStream | client → daemon | command (req), args? (string[]), cwd?, env? (Record<string,string>), timeoutMs?, workspaceId?, stdin? (string), stdinBase64?, requestId? | { requestId } — daemon-owned **streaming** exec; stdout/stderr/exit surface as `host:exec:*` bus frames |
| host.execStream.write | client → daemon | requestId (req), stdin? (string), stdinBase64?, eof? (bool) | { ok: true } — write follow-up stdin to a live stream (closes the child's stdin end when `eof=true`) |
| host.execStream.cancel | client → daemon | requestId (req) | { ok: true, cancelled: bool } — reap a live stream's process group (idempotent on unknown ids) |

- `host.hasDisplay` / `host.locality` are also folded into the daemon's `status` / `doctor`
  reports, so a client can gate UI **before** connecting. When
  `hasDisplay=false`, clients should warn that GUI-spawning commands won't be visible.
- `host.openExternal` / `host.openInEditor` / `host.pickApplication` are **served by the
  frontend, not the daemon** (reverse RPCs — the *daemon* sends the JSON-RPC `request` and the
  connected client returns the `response`). Clients never call `openExternal` /
  `pickApplication` on the daemon; the daemon dispatches them to the client so these
  inherently-user-side GUI intents resolve on the user's machine. `host.openInEditor` is
  additionally **client-callable as a trigger** (the FE's "Open in editor / VS Code" buttons):
  the daemon serves the request by short-circuiting locally on a local connection, or by
  re-dispatching the same intent to the connected client as the FE-served reverse RPC on a
  remote connection. Reverse-request ids are always in the `rev-<n>` namespace (allocated
  by the daemon, distinct from the client's own `id` space) with a 30s default timeout;
  `openInEditor`'s local branch short-circuits directly on the daemon host without a wire
  round-trip (via the resolved `host.listInstalledEditors` entry). `openExternal` and
  `pickApplication` have no daemon-side production path at all — they are dispatched to
  the connected frontend exclusively.
- **`browser.exec` loopback-hostname convention — FE-side (monorepo#2323).** Because the
  CDP work is FE-served (§5.9), loopback hostnames in `navigate`/`openTab` action URLs are
  interpreted by the frontend per the reserved-hostname convention: `daemon.localhost` →
  the daemon machine, `client.localhost` → the client (user's) machine, and bare loopback
  (`127.0.0.1` / `localhost` / `[::1]`) defaults to the daemon's frame of reference —
  rewritten to the daemon host on a remote connection, with a `warning` echoed in the
  result. The daemon forwards the `browser.exec` envelope verbatim — the wire shape is
  unchanged; rewritten action results carry the additive `requestedUrl` / `finalUrl` /
  `rewritten` / `reason` echo fields. Full contract in §5.9.
- **`browser.exec` agent-scoped tab ownership — FE-enforced (monorepo#2857).** Embedded
  browser tabs carry a nullable `ownerAgentId`; agents may only manipulate tabs they
  own, may claim unowned tabs (`claimTab`, atomic first-claim-wins), and agent-owned
  tabs render under CDP viewport emulation. Enforcement lives entirely on the frontend
  that serves the reverse RPC — the daemon forwards the `browser.exec` envelope
  verbatim (agent-initiated calls always carry `agentId`; callers without `agentId`
  are the user, unrestricted) and the wire shape is unchanged. Full contract in §5.9.
- `host.exec` is a **daemon-owned one-shot exec** so the FE never spawns workspace-adjacent
  commands itself. It uses `argv` only — **no shell interpolation** — and spawns with the child
  in its own process group and `kill_on_drop` (so `timeoutMs` reaps the whole tree). The
  **child-env contract** is a strict precedence: (1) the caller-supplied `env` map wins
  outright (applied last, key by key); (2) the daemon's own process environment is inherited —
  a var already set there is **never overridden** by a captured value; (3) allow-listed
  credential env vars **captured from the user's login shell** fill the remaining gaps only
  (the Dock/auto-update launch case, where the daemon's inherited env is stripped —
  monorepo#1671); (4) `PATH` is enriched via the login-shell/known-dirs mechanism (a caller
  `env["PATH"]` still wins). The capture is unix-only, cached per daemon process, run with a
  short timeout, and empty on any failure (no shell, spawn error, timeout, non-unix). The
  allow-list is exact names `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_PROFILE`,
  `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `HF_TOKEN`,
  `HUGGING_FACE_HUB_TOKEN` plus the name prefixes `AUGGIE_*`, `CLAUDE_*`, `CODEX_*`,
  `OPENCODE_*`, `DROID_*`, `CORTEX_*`; non-allow-listed vars are discarded at parse time and
  never leave the capture. It is **secret-safe**: no env values — captured or otherwise — are
  ever logged, traced, or returned; only `stdout` / `stderr` / `exitCode` (and
  `timedOut: true` on the timeout path) cross the wire. The same captured credential gap-fill
  applies to **ACP provider spawns** (the piped-stdio agent provider processes this section
  opens with): provider registry env and per-spawn extras win, then the daemon's process env,
  then captured vars fill gaps. `cwd` requires `workspaceId` so the daemon can enforce the same lexical
  within-workspace containment guard that `file.*` uses;
  a `cwd` outside the workspace root is rejected with `-32603 "Access denied: cwd outside
  workspace"`. When `workspaceId` is present and `cwd` is **omitted**, the child runs from the
  workspace's filesystem root ([intent-hq/intentd#1410](https://github.com/intent-hq/intentd/pull/1410),
  monorepo#3231) — previously it inherited the daemon's own process cwd, so relative paths in
  the command (e.g. `git -C .worktrees/x`) silently resolved against the wrong directory. The
  default is best-effort and containment-neutral: a workspace with no resolvable filesystem
  root (remote / skip-worktree rows, or a root missing on disk) falls back to the previous
  daemon-cwd behavior rather than erroring, and requests with neither `workspaceId` nor `cwd`
  are unchanged. Missing / invalid params surface as `-32602`. Long-lived / streaming processes
  stay on `script.*` and `terminal.*` (§5.8, §5.13) — `host.exec` is one-shot only.
- `host.execStream` is the **streaming/interactive** counterpart for FE surfaces (e.g.
  `augment-cli`'s newline-delimited JSON chat) that need live stdout **and** a stdin channel —
  something neither the buffered `host.exec` nor the PTY-mangling `terminal.*` nor the
  workspace-script-lifecycle `script.*` fit. It reuses every `host.exec` guarantee (argv-only,
  process-group + `kill_on_drop` + `timeoutMs` reap, the child-env contract above — caller
  `env` > daemon process env > captured credential gap-fill, plus enriched PATH,
  workspace-containment on `cwd` and the omitted-`cwd` workspace-root default,
  secret-safe env) and adds the streaming shape from
  `git.clone` / `search.*` (§5.6 / §5.15 / §6.5): the method returns
  `{ requestId }` immediately (a `hexec-<uuid>` is minted when the caller omits one) and the
  daemon publishes one bus frame per output chunk plus one terminal exit frame, all correlated
  by `requestId`:
  - `host:exec:stdout` — `{ requestId, chunk }` where `chunk` is base64-encoded so binary
    output crosses the wire intact (mirrors `terminal:data.chunk`). **Transient /
    broadcast-only** (same publish path as `chat:stream:delta`, §7): never persisted,
    invisible to `event.query` (§5.10).
  - `host:exec:stderr` — same shape (and transience) as stdout, over the child's stderr.
  - `host:exec:exit` — terminal: `{ requestId, ok, exitCode?, timedOut?, cancelled? }`.
    Emitted exactly once (durable); subscribers unregister on receipt.
  Callers pipe stdin two ways: an optional initial `stdin`/`stdinBase64` on the request itself
  (written to the child before any reader task starts) and follow-up `host.execStream.write
  { requestId, stdin?, stdinBase64?, eof? }` calls that append bytes and optionally close the
  child's stdin end (`eof=true`) so a reader-to-EOF like `cat` / `augment-cli` finishes
  cleanly. Only one of `stdin` / `stdinBase64` may be set per request. `host.execStream.cancel
  { requestId }` reaps the whole process group (SIGTERM → grace → SIGKILL, mirroring the
  `host.exec` timeout path) and is idempotent on unknown / already-finished ids
  (`cancelled:false` still surfaces `ok:true`). Command payloads carry env values that are
  **never logged or streamed** — only `stdout` / `stderr` / exit metadata crosses the wire.
- **ACP model/readiness handshake probes ride `host.execStream`** — the four
  bidirectional-stdio provider probes (codex / claude-code / pi / droid) that R1b retired do
  **not** get a dedicated `provider.probeAcp` RPC. Every guarantee an ACP handshake needs is
  already on this surface: argv-only spawn (no shell), `PATH` enrichment, workspace-cwd
  containment, secret-safe env, initial `stdin` payload written before any reader task starts,
  `timeoutMs` reap of the whole process group, and a terminal `host:exec:exit` frame carrying
  `timedOut` / `cancelled` metadata. A thin FE probe therefore (1) calls `host.execStream`
  with `command`+`args` for the ACP CLI and the `initialize` JSON-RPC line as `stdin`,
  (2) subscribes to `host:exec:*` frames correlated by `requestId`, (3) parses the
  `\n`-terminated JSON reply out of the base64 stdout chunks, and (4) closes the child via
  `host.execStream.write { eof:true }` (clean exit) or `host.execStream.cancel` (force reap).
  The `providerId` a caller would want to tag such a probe with never needed to cross the
  wire — it stays as FE-local correlation. Retiring the pre-R1b probes in favor of this
  reuse keeps the daemon a **thin process host** and avoids duplicating spawn / reap / stdin
  plumbing behind a purpose-built RPC.

**`forward.*` — port-forwarding (remote only):**

When a script/terminal URL-detection hook (§5.8) finds a dev-server URL/port on a **remote**
daemon, the client tunnels the remote port to `localhost` so the web UI is viewable locally. On
a **local** (UDS) connection forwarding is unnecessary and these are no-ops.

| Method | Params | Result |
| --- | --- | --- |
| forward.create | remotePort (req,int), localPort? | { forwardId, localPort, remotePort } — opens a tunnel |
| forward.list | — | { forwards: [{ forwardId, localPort, remotePort, url? }] } |
| forward.close | forwardId (req) | { ok: true } |

```json
// → probe host capabilities (gate GUI / forwarding UI)
{ "jsonrpc":"2.0","id":80,"method":"host.status" }
// ← response (headless remote host)
{ "jsonrpc":"2.0","id":80,"result":{ "os":"linux","arch":"x86_64","hostname":"build-01",
  "prettyHostname":"Build Box 01","hasDisplay":false,"locality":"remote" } }
// reverse RPC — daemon → client — open a detected URL on the user's machine (FE-served)
// ← daemon sends the request (id in the `rev-<n>` namespace)
{ "jsonrpc":"2.0","id":"rev-1","method":"host.openExternal","params":{ "url":"http://localhost:3000" } }
// → client replies with the same rev-* id
{ "jsonrpc":"2.0","id":"rev-1","result":{ "ok": true } }
// client-called trigger — FE asks the daemon to open the user's editor
// (local daemon: direct launch; remote daemon: re-dispatched as the reverse RPC below)
{ "jsonrpc":"2.0","id":81,"method":"host.openInEditor","params":{
  "editorId":"vscode","path":"/repo/src/main.rs","line":12,"column":3
} }
// ← { "jsonrpc":"2.0","id":81,"result":{ "ok": true } }
// reverse RPC — daemon → client — launch the user's editor on the user's machine (FE-served; local daemons short-circuit)
// ← daemon sends the request
{ "jsonrpc":"2.0","id":"rev-2","method":"host.openInEditor","params":{
  "editorId":"vscode","path":"/repo/src/main.rs","line":12,"column":3
} }
// → client replies
{ "jsonrpc":"2.0","id":"rev-2","result":{ "ok": true } }
// reverse RPC — daemon → client — present "open with…" chooser on the user's machine (FE-served)
// ← daemon sends the request
{ "jsonrpc":"2.0","id":"rev-3","method":"host.pickApplication","params":{ "path":"/repo/README.md" } }
// → client replies with the selection
{ "jsonrpc":"2.0","id":"rev-3","result":{ "applicationId":"com.microsoft.VSCode" } }
// client-called trigger — FE binding (ws.browser.exec) asks the daemon to run CDP actions
// (daemon validates the envelope and dispatches the reverse RPC below to the same FE)
{ "jsonrpc":"2.0","id":85,"method":"browser.exec","params":{
  "actions":[{"action":"listTabs"}],"tabId":"tab-1","agentId":"agent-1","workspaceId":"ws-1"
} }
// ← single-action → the action's envelope
{ "jsonrpc":"2.0","id":85,"result":{ "action":"listTabs","success":true,"result":[{"id":"tab-1"}] } }
// reverse RPC — daemon → client — run CDP actions against the embedded browser (FE-served, §5.9)
// ← daemon sends the request (envelope forwarded verbatim)
{ "jsonrpc":"2.0","id":"rev-4","method":"browser.exec","params":{
  "actions":[{"action":"listTabs"}],"tabId":"tab-1","agentId":"agent-1","workspaceId":"ws-1"
} }
// → client replies with the raw execution envelope (daemon reshapes for the caller)
{ "jsonrpc":"2.0","id":"rev-4","result":{ "success":true,"results":[
  { "action":"listTabs","success":true,"result":[{"id":"tab-1"}] }
] } }
// AGENT-INITIATED `browser.exec` (REV-1, interim) — the MCP `ws.browser.exec`
// binding has no ambient client connection, so the daemon routes the reverse
// RPC to the FIRST-connected live client (across UDS + WSS). When that client
// disconnects the next-connected one takes over; when no client is connected
// the call fails fast with `-32603` "browser.exec: no client connected".
// Wire shape of the reverse RPC and its result is unchanged from the
// client-triggered case above.
// → daemon-owned one-shot exec (argv only, cwd validated against workspace root)
{ "jsonrpc":"2.0","id":82,"method":"host.exec","params":{
  "command":"echo","args":["hello"],"timeoutMs":5000
} }
// ← { "jsonrpc":"2.0","id":82,"result":{ "stdout":"hello\n","stderr":"","exitCode":0 } }
// → daemon-owned streaming exec (argv only, cwd validated against workspace root)
{ "jsonrpc":"2.0","id":90,"method":"host.execStream","params":{
  "command":"cat","stdin":"hello\n"
} }
// ← { "jsonrpc":"2.0","id":90,"result":{ "requestId":"hexec-<uuid>" } }
// then, correlated by requestId, subscribers see (base64 chunks):
// { "method":"events.event","params":{ "event":{ "type":"host:exec:stdout",
//   "data":{ "requestId":"hexec-<uuid>","chunk":"aGVsbG8K" } } } }
// (optionally more stdout/stderr frames)
// → follow-up stdin write, closing the child's stdin end so `cat` exits
{ "jsonrpc":"2.0","id":91,"method":"host.execStream.write","params":{
  "requestId":"hexec-<uuid>","stdin":"","eof":true
} }
// ← { "jsonrpc":"2.0","id":91,"result":{ "ok": true } }
// terminal frame (ok:true when exitCode==0):
// { "method":"events.event","params":{ "event":{ "type":"host:exec:exit",
//   "data":{ "requestId":"hexec-<uuid>","ok":true,"exitCode":0 } } } }
// → force-reap a live stream's whole process group
{ "jsonrpc":"2.0","id":92,"method":"host.execStream.cancel","params":{
  "requestId":"hexec-<uuid>"
} }
// ← { "jsonrpc":"2.0","id":92,"result":{ "ok": true, "cancelled": true } }
```

