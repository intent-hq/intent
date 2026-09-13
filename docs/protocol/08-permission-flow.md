> Part of the [Intent JSON-RPC protocol docs](./README.md) — §8 Permission Flow.

## 8. Permission Flow

When an agent's provider (e.g. auggie) wants to run a tool that requires approval, it sends an ACP`session/request_permission` request **to the backend** (over the provider's stdio channel, not theclient WebSocket). The backend mediates approval:

1. **Bypass / auto-approve.** For non-interactive providers running in `bypassPermissions` mode (orwhen the provider can't set a mode), the backend auto-selects an "allow" option and respondsimmediately — no client involvement.
2. **Interactive.** Otherwise the backend **blocks the agent's stream** and surfaces a permission request to the frontend: the daemon pushes it to subscribed clients and awaits a response.

> **Implementation status.** The interactive *answer* and *recovery* RPCs are now **wired** in
> `intentd`. `agent.respondPermission { requestId, outcome }` → `{ resolved: bool }` forwards the
> chosen outcome to the blocked provider — `resolved` is `false` when no matching pending prompt
> exists, and a malformed `outcome` shape is rejected as **`-32602`**. `agent.pendingPermissions
> { agentId? }` → `{ requests: [...] }` snapshots the outstanding prompts (optionally filtered to a
> single `agentId` = `sessionId`) so a reconnecting client can re-fetch them. Both reach
> `PermissionRegistry::resolve()` / `::pending()` via `AgentManager` → `WorkspaceApi` / `Services`
> → the `agent.*` router. The normalized request payload, options normalization, `riskLevel`
> heuristic, outcome shape, and 5-minute timeout are implemented as described.
>
> **Default policy.** The shipped default is **`AllowAll`** for reference parity with the TS
> acp-provider, selectable at runtime via **`INTENTD_PERMISSION_POLICY`**
> (`interactive|auto|allow|deny`, default `AllowAll`). Under `AllowAll`,
> `AgentManager::start_session` additionally issues a best-effort
> `session/set_mode { modeId: "bypassPermissions" }` after `session/new`,
> `session/load`, and the recreate fallback on providers that advertise
> set-mode (auggie today). Providers that don't advertise set-mode, or that
> reject the mode change, fall through to the local auto-approve inside
> `ClientRequestHandler` (the previous `AutoByRisk` default silently denied
> medium/high prompts). An **`Interactive`**
> deployment instead blocks the agent's stream and surfaces each prompt via
> `agent.pendingPermissions`, resolving it via `agent.respondPermission` (still
> bounded by the 5-minute timeout when left unanswered). **`AutoByRisk`** and
> **`DenyAll`** remain available for headless-with-guardrails deployments and
> never issue the bypass mode change.

The normalized permission request payload is:

```json
{
  "requestId": "perm_1718600000000_1",
  "sessionId": "agent-123",
  "title": "Run command",
  "description": "Tool input: { \"command\": \"npm test\" }",
  "options": [
    { "id": "allow_once", "label": "Allow", "description": null, "destructive": false },
    { "id": "reject_once", "label": "Deny", "destructive": true }
  ],
  "agentName": "auggie",
  "riskLevel": "high",
  "timestamp": 1718600000000
}
```

- `options` are normalized from both ACP (`id`/`label`) and auggie (`optionId`/`name`) shapes. If aprovider sends none, the backend defaults to `allow_once` / `reject_once`.
- `riskLevel` (`low|medium|high`) is heuristically derived from the title (read/list → low;delete/execute/write/create → high).
- `sessionId` equals the `agentId`, so a client can route the prompt to the right agent view.

The frontend responds with the chosen outcome, which the backend forwards to the provider as the`session/request_permission` result:

```json
{ "requestId": "perm_1718600000000_1", "outcome": { "outcome": "selected", "optionId": "allow_once" } }
```

Outcomes: `{ "outcome": "selected", "optionId": "<id>" }`, or `{ "outcome": "cancelled" }`.Unanswered requests **time out after 5 minutes** and resolve as `cancelled`, unblocking the agent. The recoverability path (a reconnecting client re-fetching outstanding prompts via `agent.pendingPermissions` so a page refresh does not strand the agent) is **now wired** — see the implementation note above.

