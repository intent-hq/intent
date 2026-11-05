> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.56 Secret requests.

## 5.56 Secret requests

This is a **shipped additive contract**: the pinned intentd and cloudlands-fe
implement it.
It lets a top-level agent on any provider ask the user for a secret (an API key
or token) through a masked input card, and use it in `ws.host.exec` without the
model ever receiving the value.

### Status and discovery

The daemon advertises `server.capabilities.secretRequests: 1` (§5.17) only when
it implements the contract below; the pinned intentd does. Missing or unknown values mean
unsupported. Clients render secret-request cards and call the `secret.*` methods
only when the capability is present. Capability describes implementation, not
permission.

### Agent feature availability

`agentFeatures.secretRequests` is a boolean Agent Feature labelled **Secret
requests**, default **false** (see [settings](./settings.md)). It follows the
captured-at-creation rule of the other agent features: each new agent session
captures the effective value, persists it in its feature snapshot, and uses it
for the prompt, MCP bridge, help and dispatch checks. A setting change applies
to new sessions only.

Because `ws.host.exec` is the only way to use a secret, the effective feature is
on only when `agentFeatures.secretRequests` is on, `agentFeatures.hostExec` is
on, and the session's help variant exposes `ws.host.exec`. A session missing any
of these never sees `ws.secret` or `secretEnv`, so an agent is never told to use
a secret it cannot use.

When the effective feature is off, omit the `ws.secret` namespace and the
`secretEnv` option from discovery and help, and reject `ws.secret.*` calls and
any `ws.host.exec` call carrying `secretEnv` with the existing feature-disabled
tool-failure convention. The `secret.*` router methods stay callable so a client
can still dismiss or forget; they never create a request.

### Storage and lifetime

Secret values live **only in intentd process memory**. They are never written
to SQLite, the secret store file, settings, logs, tracing, Sentry, events, the
transcript, or any agent-facing result. Values are wiped from memory when
dropped.

A secret is owned by the **agent that requested it**, keyed by
`(workspaceId, agentId, name)`. No other agent can use, list or forget it,
including that agent's sub-agents and other agents in the same workspace.

**Background hooks never get secrets.** Secrets are transient: the user hands one
over for the agent's own interactive work (setting it through an API, storing it
in a cluster secret), not for unattended reuse. A hook run therefore sees
`agentFeatures.secretRequests` as off whatever the setting
([§5.40 API surface per run](./hooks.md#540-background-hooks--hook-v210)): it has
no `ws.secret` namespace, and a `ws.host.exec` call with `secretEnv` is rejected.
A hook that needs a secret should return `{ dispatch: true, message }` so the
owning agent wakes and runs the command in its own turn.

A held secret is dropped when any of these happens:

- the owning agent calls `ws.secret.forget(name)`, or a client calls
  `secret.forget`;
- the owning agent is deleted or retired;
- the workspace is archived or deleted;
- intentd restarts.

A [remote agent](#remote-agents)'s secrets are held on its machine instead, with
the extra lifetime rules described there.

Pending requests are held in memory the same way and are lost on restart. There
is no time-based expiry, but an agent may hold at most **8 pending requests**.
A request for a name that already has a pending request from the same agent
returns that request's `requestId` and queues its card again at turn end (an
earlier card may have been dropped with a cancelled or very long turn). Clients key
cards by `requestId`, so the repeat shows the same request. A new request beyond the
cap fails, telling the agent to wait for the user to answer the open ones.

### Names

A secret name is 1–64 characters of `A`–`Z`, `0`–`9` and `_`, starting with a
letter, for example `OPENROUTER_API_KEY`. Names are case-sensitive and never
trimmed: any other input is rejected.

### Agent API (MCP-only)

These bindings are MCP-only; there is no wire method that creates a request,
per the §6.8 principle.

```text
ws.secret.request({ name, reason }) → { ok, requestId, message }
ws.secret.list() → { secrets, pendingRequests }
ws.secret.forget(name) → { ok, forgotten }
```

- `request` validates `name` and a non-empty trimmed `reason` (at most 500
  characters), mints a `requestId` (`sec-` followed by a random nonce), records
  a pending request for the calling agent, and registers an `AtTurnEnd` turn
  attachment (§7). It returns at once; the agent should end its turn. Only
  top-level agents may call it: sub-agent frames are denied with a redirect to
  `ws.agent.requestDiscussion` / `ws.agent.reportToParent`, like
  `ws.app.question.ask`. Background hooks have no `ws.secret` (see Storage and
  lifetime). A request for a name the agent already holds succeeds and,
  once provided, replaces the value.
- `list` returns the calling agent's own data only: `secrets: [{ name }]` and
  `pendingRequests: [{ requestId, name }]`. It never returns values.
- `forget` drops the calling agent's secret; `forgotten` is `false` when the
  agent held no secret of that name.

**Using a secret.** `ws.host.exec` accepts an additive `secretEnv` option:
either an array of names, where each environment variable has the secret's name,
or an object mapping an environment variable name to a secret name. The daemon
resolves every listed secret from the calling agent's secrets before spawning
and overlays them last, after the caller's `env`. If any listed secret is
missing, nothing is spawned and the call fails with the `secret-unavailable`
tool error below.

Every exact occurrence of a resolved value in the returned `stdout` and `stderr`
is replaced with `[secret:NAME]`, including an occurrence cut off by output
truncation. Redaction is a single left-to-right pass over the raw output that,
at each position, replaces the **longest** matching value among all resolved
secrets; replaced text is never scanned again. So when one value contains
another, the longer one is hidden whole, and a value that happens to look like a
placeholder cannot reveal part of another. Redaction covers exact bytes only: an
encoded, split or transformed value is not detected.

`secretEnv` is accepted only by the agent binding `ws.host.exec`, in the agent's
own turn; background hooks reject it. The wire `host.exec` and `host.execStream` methods (§5.14)
reject it with `-32602`, because a client connection has no agent identity.
`ws.script.create` rejects a `secretEnv` key with an error saying that secrets
work only with `ws.host.exec`; saved scripts never receive secrets.

**`secret-unavailable` tool error.** The text starts with
`secret-unavailable:` and names the missing secret, then instructs the agent:
secrets are held in memory and are lost when intentd restarts; call
`ws.secret.request` with that name and a reason, then end the turn. The same
error is returned whether the secret was never provided, was forgotten, was
lost on restart, or belongs to another agent; it never reveals which.

**Provider shells are out of scope.** Secrets are never injected into the
provider's own processes (for example Claude Code's Bash tool or Codex's exec),
and Intent cannot redact output the provider returns to its model directly.

### Remote agents

A top-level agent on a [remote machine](./nodes.md) can request and use secrets
when its machine's link negotiated
[nodeProtocol 14](../node-link.md#secrets-on-the-machine-nodeprotocol-14) or later.
The value is stored only on **its machine**, in that machine's intentd memory, for
that one agent. The backend never stores it.

- **Request.** `ws.secret.request`, `ws.secret.list` and `ws.secret.forget` are
  forwarded to the backend and run there as the agent, with a local agent's checks.
  The pending request and its card live on the backend, as for a local agent.
- **Provide.** `secret.provide` for a remote agent's request sends the value to the
  agent's machine, in memory, and waits for the machine to confirm. Only then is the
  request answered and the provided notice delivered. The backend keeps no copy.
  When the machine is not connected, is below protocol 14, or does not confirm
  within 10 s, the call fails with `-32602` and
  `data.code: "secret-delivery-failed"`, the request **stays pending**, and the user
  can try again from the same card. The backend never queues a value.
- **Use.** `ws.host.exec` with `secretEnv` runs on the machine and resolves the
  agent's values there, with the same overlay and output redaction. Other agents on
  the machine get `secret-unavailable`.
- **List.** `secret.list` and `ws.secret.list` read `secrets` from the machine;
  `pendingRequests` and `answeredRequests` come from the backend. When the machine
  is not connected, `secrets` is `[]` and the result adds
  `secretsUnavailable: "machine-offline"`.
- **Forget.** `secret.forget` and `ws.secret.forget` drop the value on the machine.
  When the machine is not connected, the backend queues the forget in memory, sends
  it when the machine is back, and returns `{ ok: true, forgotten: false, deferred: true }`.
- **Lifetime.** A remote agent's secrets are also dropped when its machine's intentd
  restarts, at its final stop, and when the machine is revoked or removed. A backend
  restart drops them too: the machine drops every value from before the restart when
  the backend reconnects. A provider restart on the same machine
  (`agent.setModel`, quota failover, a relaunch) keeps them. A remote agent never
  moves to another machine; a new agent starts with no secrets.
- **Older peers.** On a link below 14 a remote agent has no `ws.secret` and no
  `secretEnv`; a call fails with `remote-agent-unsupported:` and asks to update
  Intent on the machine and the backend.

The `secret-unavailable` text for a remote agent says the secret is held in memory
on the agent's machine and is lost when Intent restarts there or on the backend.

### Turn-end resource

Each `ws.secret.request` call drains at turn end as a trailing `resource` block
on the final persisted assistant message, in call order, exactly like question
blocks (§7):

```json
{ "type": "resource", "resource": {
    "uri": "intent-secret-request://sec-7m2k9x4q1t8a",
    "name": "OPENROUTER_API_KEY",
    "mimeType": "application/vnd.intent.secret-request+json",
    "text": "<secret request JSON>" } }
```

Decoded, `resource.text` is:

```json
{
  "requestId": "sec-7m2k9x4q1t8a",
  "agentId": "agent-…",
  "name": "OPENROUTER_API_KEY",
  "reason": "Needed to run the integration tests against OpenRouter."
}
```

The payload never contains a value.

**Attention.** Once a top-level agent's secret-request card has been persisted
at turn end (the same point a question raises it), its workspace's derived
`displayStatus` is `needs_attention` (§6.5) until the request is answered. A
request whose card never reached the transcript (for example, a cancelled turn)
does not count; re-requesting the same name reuses the request and queues its
card again. The state comes from the daemon's in-memory pending requests, not the
persisted pending-questions marker (§5.5), which secret-request blocks never
touch: it ends as soon as every request is provided, declined or lost on restart,
so a restart can never leave a workspace stuck needing the user for a request
that no longer exists. `agent.dismissQuestions` on
the message carrying the cards also declines its pending secret requests and
delivers one declined notice per request. Provided and
declined notices are **user-origin** deliveries for the turn-begin attention
clear (§6.5, agent attention details), because the user caused them.

### Client-facing router methods

| Method | Params | Result |
| --- | --- | --- |
| secret.provide | workspaceId (req), requestId (req), value (req, string) | `{ ok: true, requestId, name }` — stores the value for the request's agent and delivers the provided notice |
| secret.dismiss | workspaceId (req), requestId (req) | `{ ok: true, requestId, name }` — drops the pending request and delivers the declined notice |
| secret.list | workspaceId (req), agentId (req) | `{ secrets: [{ name }], pendingRequests: [{ requestId, name }], answeredRequests: [{ requestId, name, outcome }], secretsUnavailable? }` — names only; `outcome` is `"provided"` or `"declined"`; `secretsUnavailable: "machine-offline"` only for a [remote agent](#remote-agents) whose machine is not connected |
| secret.forget | workspaceId (req), agentId (req), name (req) | `{ ok: true, forgotten: boolean, deferred? }` — `deferred: true` only for a [remote agent](#remote-agents) whose machine is not connected |

All four require the same authority as `agent.sendMessage` to the named agent
(§5.5, §5.48); a caller without it receives `-32003`. `secret.provide` and
`secret.dismiss` take the agent from the pending request, never from params, and
check authority against the request's own workspace and agent. A request whose
workspace differs from `params.workspaceId` is treated as unknown.

`secret.provide` rules:

- `value` must be a non-empty string of at most 16 KiB (UTF-8). It is not
  trimmed.
- The request must be pending. An unknown, already answered or lost request
  fails with `-32602` and `data.code: "secret-request-unknown"`; the client
  should tell the user to ask the agent to request the secret again.
- For a [remote agent](#remote-agents), the value must reach the agent's
  machine first; otherwise the call fails with `-32602` and
  `data.code: "secret-delivery-failed"` and the request stays pending.
- Answering is single-use: the request is removed atomically, so two clients
  cannot both answer it.
- The `value` parameter is never logged or echoed. Transport request logging,
  tracing spans, error messages and Sentry breadcrumbs must omit it.

### Agent notices

After `secret.provide` or `secret.dismiss`, the daemon delivers a user-role
system message to the owning agent through the ordinary delivery path (an idle
agent starts a turn; a busy agent queues it like a question answer):

| Outcome | Text (example) | `messageMetadata` |
| --- | --- | --- |
| Provided | The user provided secret OPENROUTER_API_KEY. Use it with ws.host.exec and secretEnv: ["OPENROUTER_API_KEY"]. | `{ type: "secret_provided", source: "system", requestId, name }` |
| Declined | The user declined to provide secret OPENROUTER_API_KEY. | `{ type: "secret_declined", source: "system", requestId, name }` |

The daemon remembers each answered request's outcome in memory
(`answeredRequests`, until restart), so a client can show the right state while
the notice is still queued behind a busy turn. Clients derive a card's state in
this order:

1. a user row tagged with the card's `requestId`, or a matching
   `answeredRequests` entry: provided or declined;
2. the `requestId` is in `pendingRequests`: pending;
3. otherwise: expired, and the card tells the user to ask the agent again.

The client that answered uses its own `secret.provide` / `secret.dismiss` result
immediately.

### Verification requirements

An implementation must prove, with tests that plant a sentinel value:

- the value never appears in any agent-facing egress (`workspace_api` results,
  wake metadata, `agent.list`, `agent.getConversation`, events) for the owning
  agent or a second agent in the same workspace;
- the value never appears in the SQLite store, the secret store file, or daemon
  logs after a provide, a `ws.host.exec` use and a restart;
- a second agent's `secretEnv` use and `ws.secret.list` do not see the first
  agent's secret.
