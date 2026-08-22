> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.22 `mcp.servers.*`.

### 5.22 `mcp.servers.*`

The **external** MCP-server lifecycle/config surface, backed by the `mcp.servers` setting
(**sensitive** — §5.12; secrets in `env`/`headers` are redacted on the wire). This is the
**user-facing** management surface: register, edit,
enable/disable, and restart MCP servers the daemon hosts. It is **distinct** from the **agent→BE
MCP callback**, which lets a running agent reach BE-hosted MCP tools
and surfaces as the `mcp:notification` event — that callback has no `mcp.servers.*` method. Health
and lifecycle transitions are pushed via `mcp.servers:status-changed` (§6.5).

> **`workspace_api` output shaping (agent callback, new in intentd).** Two `workspaceApi.*`
> settings (§5.12) shape the plain success body of the agent-facing MCP `workspace_api` tool;
> both are read live per invocation (a settings-read failure falls back to the catalog
> defaults). **TOON encoding** (`workspaceApi.toonOutput`, default `true`): object/array JS
> results are TOON-encoded (token-efficient) instead of pretty JSON; scalars, strings,
> booleans, numbers, and `null` keep pretty JSON, a value the TOON encoder rejects falls
> back to pretty JSON, and setting the knob `false` restores pretty JSON for everything.
> **Oversized-output redirect** (`workspaceApi.maxOutputChars`, default `100000`, `0` =
> unlimited): when the final rendered text body (post-TOON) exceeds the limit, the FULL
> output is written to `<workspace-folder>/tool-outputs/<utc-timestamp>-<short-id>.<toon|json>`
> — the workspace's own folder (today's layout: `<workspaces-root>/<workspace-name>/tool-outputs/`),
> a **sibling of the repo checkout**, never inside the git tree, so it needs no git
> exclusion and the worktree-rooted `ws.file.*` surface cannot reach it — and the tool
> returns a pointer message instead, carrying the total character count, the configured
> limit, the absolute file path, a **2,000-char head preview**, and inspection hints
> (grep/head/tail/ranged reads rather than reading the file whole). Error results and the
> `__mcpContentItems` resource pass-through are exempt from both knobs, and a redirect
> that cannot be written (e.g. no resolvable workspace directory) returns the untruncated
> output — the tool call never fails because of the redirect.

| Method | Params | Result |
| --- | --- | --- |
| mcp.servers.list | workspaceId? | { servers: McpServerConfig[] } — sensitive `env`/`headers` redacted |
| mcp.servers.create | config (req): McpServerConfig | { server: McpServerConfig } |
| mcp.servers.update | serverId (req), config (req): McpServerConfig | { server: McpServerConfig } |
| mcp.servers.delete | serverId (req) | { success: true } |
| mcp.servers.toggle | serverId (req), enabled (req): boolean | { status: McpServerStatus } — enable starts the server, disable stops it (replaces start/stop) |
| mcp.servers.restart | serverId (req) | { status: McpServerStatus } — stop-then-start |
| mcp.servers.getStatus | serverId (req) | { status: McpServerStatus } — optional point read; live updates arrive via `mcp.servers:status-changed` |

- **McpServerConfig** — `{ id, name, transport: "stdio"|"http"|"sse", command?, args?: string[],
  env?: object, url?, headers?: object, enabled: boolean, scope?: "user"|"workspace" }`. `command`
  / `args` / `env` apply to `stdio`; `url` / `headers` describe `http`/`sse`. All three
  transports are supported: `stdio` servers are spawned as daemon child processes, while
  `http`/`sse` servers are **probed from the daemon host** (see "Remote transports" below) —
  the daemon never proxies agent traffic to them through this surface; it verifies and reports
  their health. Sensitive `env` and
  `headers` values are **redacted** (presence/placeholder only) on `list`/`create`/`update`
  responses, mirroring `settings.*` (§5.12).
- **McpServerStatus** — `{ serverId, state: "stopped"|"starting"|"running"|"error", pid?,
  toolCount?, lastError?, startedAt? }`. `toolCount` is the number of tools the server advertised
  once connected. `pid` is stdio-only (remote servers have no process). For remote servers,
  `state: "running"` means the probe succeeded, `state: "error"` carries the probe failure in
  `lastError`, and `startedAt` is the first successful probe time — preserved across consecutive
  `running` re-probes, so it reads as "reachable since".
- **Remote transports (`http`/`sse`)** — starting a remote config (via `toggle`/`restart`/boot
  autostart) runs a network probe from the daemon host instead of spawning a process:
  - `http` runs the full MCP handshake over streamable HTTP POST — `initialize` (required; the
    response envelope is validated as JSON-RPC 2.0 with a `result`, so a non-MCP JSON endpoint
    is never reported `running`) → `notifications/initialized` (best-effort) → `tools/list`
    (best-effort; on success its length is served as `toolCount`, otherwise `toolCount` is
    omitted). The `Mcp-Session-Id` issued by `initialize` is echoed on follow-ups and the
    session is torn down with a best-effort HTTP `DELETE` so periodic re-probes don't
    accumulate server-side sessions; a negotiated protocol version is echoed back as
    `MCP-Protocol-Version` on follow-ups.
  - `sse` is a **reachability probe only**: a GET with `Accept: text/event-stream` must answer
    2xx (the stream body is never read; full SSE sessions are out of scope), so an `sse`
    server's `running` status never carries `toolCount`.
  - Bounds and failure shaping: each request is bounded at 10 s and the whole probe at 15 s;
    redirects are **never followed** (configured `headers` may carry credentials that would
    otherwise be forwarded cross-host); failures map to actionable `lastError` strings —
    connect failure → "unreachable from daemon host: <url>", timeout → "timed out connecting
    to <url>", HTTP 401/403 → "authentication failed (HTTP <code>) — check configured
    headers", 5xx → "server error (HTTP <code>)".
  - Lifecycle differences from stdio: a **failed probe keeps the entry tracked in `error`**
    (unlike a failed stdio spawn, which drops back to `stopped`), so the health sweep re-probes
    it; the periodic health sweep (30 s cadence) **re-probes** remote servers concurrently
    (each bounded by the 15 s probe timeout, so a slow endpoint cannot starve the stdio pings)
    and flips status on transition — remote servers are **never auto-restarted** and have no
    consecutive-failure count (there is no process to restart, only status to flip);
    `mcp.servers:status-changed` (§6.5) is emitted only on an actual state transition, with
    `startedAt` preserved across consecutive `running` probes. `mcp.servers.update` restarts
    any **tracked** server (running, or a remote in `error`) so an error-state remote re-probes
    the updated URL/headers immediately instead of keeping the old config until the next sweep;
    `restart` on a remote server is a re-probe.

```json
// → request — enable (start) an MCP server
{ "jsonrpc":"2.0","id":61,"method":"mcp.servers.toggle",
  "params":{ "serverId":"srv-fs","enabled":true } }
// ← response (emits mcp.servers:status-changed)
{ "jsonrpc":"2.0","id":61,"result":{ "status":{
  "serverId":"srv-fs","state":"running","pid":4821,"toolCount":7,"startedAt":1750000000000 } } }
```

> **No `memories.*` wire surface.** Long-term agent **memories** exist as an internal context source the
> agent runtime consumes; they are **not** exposed over the wire (no client caller). The internal
> `memories` table ships and the internal `search.memories` path scans it; a `memories.*` namespace
> (list/create/search/delete) could be added additively later **only if** a memories UI ever ships.

#### 5.22.1 `mcp.oauth.*` — per-server OAuth token bags

Companion to §5.22: manage the OAuth token bag associated with each external MCP server id.
Bags are **secret material**; the daemon
persists them in the dedicated `mcp_oauth_tokens` table and every wire response is
**presence-only** — the bag body **never** crosses the wire (mirrors the `settings.*`
redaction seam and `mcp.servers.*` `env`/`headers` redaction). Internal daemon consumers that
need to build an outbound request read the raw bag directly from the store; there is no
"reveal" RPC. This is a separate namespace (not a `settings.*` key) because bag counts are
unbounded and rotate independently of the config surface.

| Method | Params | Result |
| --- | --- | --- |
| mcp.oauth.list | — | `{ tokens: [{ serverId, value }] }` — one entry per stored bag, `value` always the redaction placeholder |
| mcp.oauth.get | serverId (req) | `{ serverId, value }` — `value` is the placeholder when a bag exists and `null` when it does not |
| mcp.oauth.set | serverId (req), tokenBag (req) | `{ serverId, value }` — persists the bag; `value` is always the placeholder (bag itself is never echoed) |
| mcp.oauth.delete | serverId (req) | `{ success: true }` — idempotent (absent bag succeeds) |

- `tokenBag` is an opaque JSON body (object / array / scalar) so the FE's bag shape can
  evolve without a daemon change; the typical bag is
  `{ access_token, refresh_token?, expires_at?, token_type? }`.
- Missing/empty `serverId` yields `-32602`; `mcp.oauth.set` also requires `tokenBag`.
- No `mcp.oauth:*` events are emitted — token rotation is a client-driven flow and the FE
  polls / re-fetches on demand.

```json
// → request — persist an OAuth bag for one MCP server
{ "jsonrpc":"2.0","id":62,"method":"mcp.oauth.set",
  "params":{ "serverId":"srv-linear",
             "tokenBag":{ "access_token":"…","refresh_token":"…",
                          "expires_at":1750000000,"token_type":"Bearer" } } }
// ← response (bag never echoed — value is a placeholder)
{ "jsonrpc":"2.0","id":62,"result":{ "serverId":"srv-linear","value":"********" } }

// → request — list stored bags (presence only)
{ "jsonrpc":"2.0","id":63,"method":"mcp.oauth.list" }
// ← response
{ "jsonrpc":"2.0","id":63,"result":{ "tokens":[
  { "serverId":"srv-linear","value":"********" } ] } }
```

#### 5.22.2 `mcp.testConnection` — one-shot connection/auth probe

Probe an HTTP/SSE MCP endpoint **from the daemon host** to detect whether it is reachable
and whether it requires authentication, so clients never contact MCP server URLs directly
(new in v7.3). One JSON-RPC `initialize` POST is sent to the URL (MCP servers answer an
auth error before processing, and even a 404/405 proves the host is up); only the HTTP
status is inspected — the response body is never read, no session is established, and
nothing is registered or persisted. Distinct from the `mcp.servers.*` lifecycle probe
(§5.22 "Remote transports"), which runs the full MCP handshake against a **saved** config;
this is a stateless pre-save check for any URL.

| Method | Params | Result |
| --- | --- | --- |
| mcp.testConnection | url (req), headers?: object, serverName? | { status: "connected"\|"auth_required"\|"error", statusCode?, errorMessage? } |

- **Params** — `url` is required and non-empty (missing/empty → `-32602`). `headers` is an
  optional object of extra request headers (non-string values are serialized, mirroring
  the §5.22 `headers` handling). `serverName` optionally names an external MCP server id:
  when present and no explicit `Authorization` header was supplied, the daemon reads the
  stored `mcp.oauth.*` bag for that id (§5.22.1) and injects
  `Authorization: <token_type> <access_token>` (a lowercase `bearer` is capitalized;
  `token_type` defaults to `Bearer`) — the bag never crosses the wire in either direction.
  Injection is **guarded by a same-origin check**: the bearer token is attached only when
  the probe `url` shares the saved server config's origin (scheme + host + port, default
  ports normalized), so a saved server id cannot be paired with an arbitrary URL to send
  its token elsewhere. An unknown `serverName`, absent bag, missing saved config, or
  origin mismatch is not an error; the probe simply runs without the header.
- **Status mapping** — HTTP 401/403 → `auth_required`; any other status **below 500**
  (2xx–4xx) → `connected` (the server is reachable — 404/405 just mean the endpoint shape
  differs); 5xx → `error`. All three carry `statusCode`. A transport failure — connect
  failure, timeout (requests are bounded at 10 s), or invalid URL — is `error` with
  **no** `statusCode` and the same actionable `errorMessage` strings as the §5.22 probe
  (`unreachable from daemon host: <url>`, `timed out connecting to <url>`).
  `errorMessage` is present on `auth_required` and `error`, never on `connected`.
- **Never a JSON-RPC error for probe outcomes** — the RPC itself only fails on caller
  errors (`-32602`); every probe outcome, including unreachable hosts, is a success
  response with the mapped `status`. Redirects are never followed (headers may carry
  credentials that would otherwise be forwarded cross-host).

```json
// → request — probe an MCP endpoint, reusing the stored OAuth bag
{ "jsonrpc":"2.0","id":64,"method":"mcp.testConnection",
  "params":{ "url":"https://mcp.example.com/mcp","serverName":"srv-linear" } }
// ← response — reachable but wants credentials
{ "jsonrpc":"2.0","id":64,"result":{ "status":"auth_required","statusCode":401,
  "errorMessage":"authentication required (HTTP 401) — check configured headers" } }
```

