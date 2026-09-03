> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.24 Session stats · §5.31 `agent.enhancePrompt` · §5.32 `agent.completeOnce` · §5.34 Skills · §5.35 Interrupted-agent resumption · §5.36 Agentic usage stats.

### 5.24 Session stats — `agent.getSessionStats`

Per-session usage rollup sourced from the auggie CLI (`session stats --json`) and cached on the
`stats` field of the `AgentSession`. `agent.getSessionStats` is a point **read**; live changes are
pushed via `agent:session-stats-changed` (§6.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.getSessionStats | sessionId (req) | { stats: SessionStats } — -32602 if the session is unknown |

**SessionStats** — `{ creditsUsed: number | null, messageCount, toolCount }`: cumulative credits
consumed (`null` until computed), user/assistant messages exchanged, and tool calls made in the
session. The same object appears as the `stats` field on `AgentSession` in `agent.*` results.

```json
// → request
{ "jsonrpc":"2.0","id":63,"method":"agent.getSessionStats","params":{ "sessionId":"sess-9" } }
// ← response
{ "jsonrpc":"2.0","id":63,"result":{ "stats":{ "creditsUsed":1.54,"messageCount":18,"toolCount":42 } } }
```

### 5.31 `agent.enhancePrompt` — one-shot prompt enhancement

Daemon-owned prompt enhance / AI-layout generation (the daemon spawns `auggie --print`; no
client-side CLI involvement). One-shot request/response: no streaming, no
agent session created or persisted, no events emitted. Part of the `agent.*`
namespace (§5.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.enhancePrompt | prompt (req), mode?: "enhance" \| "layout", model?, workspaceId?, timeoutMs? | { enhanced, original, mode } — or { available: false, reason } when the provider gate is closed |

**Provider gate ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)).** Enhance-prompt is an
auggie-specific capability, gated on auggie being the **settings-derived effective default
provider** — `model.defaultProvider` (§5.12; registry-validated, so a stale or mistyped
value reads as unset — [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)). When the effective provider is not auggie — **including
unset/undecidable settings, which resolve the gate CLOSED** rather than falling through to
the first registered provider (which would functionally reinstate the removed hardcoded
auggie default) — the method returns `{ available: false, reason }` (a typed unavailable
result, not an error) so clients hide the affordance gracefully.

**Params.**

- `prompt` (required, non-empty) — in `mode: "enhance"` the raw user input to improve; in
  `mode: "layout"` the full layout-generation instruction sent verbatim.
- `mode` — `"enhance"` (default) wraps `prompt` in the enhancement template (the FE
  `getInputWithEnhancePrompt` port) and **extracts** the
  `<augment-enhanced-prompt>…</augment-enhanced-prompt>` payload from the model reply;
  `"layout"` skips the template and returns the full cleaned reply (covers the FE
  `agent:generate-layout` use). Any other value is `-32602`.
- `model` — optional auggie model id, passed as `--model`; omitted → CLI default. Must be a
  **bare** model id: a compound `provider:model` value is rejected with `-32602` (same guard
  as §5.5, [intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)).
- `workspaceId` — optional; when present the CLI runs with the workspace's worktree as its
  working directory (unknown workspace → `-32602`). Without it the CLI runs without a `cwd`
  (mirrors the FE, which drops `cwd` when no workspace is bound).
- `timeoutMs` — optional positive integer, default `30000` (the FE's 30-second enhancement
  timeout), capped at `120000`.

**Execution** — same one-shot CLI discipline as `workspace.generateSetupScript` (§5.25) and
`models.list` (§5.30): auggie discovery (Intent-managed binary → enhanced PATH), then
`auggie --print --mcp-config {"mcpServers":{}}` (MCP skipped for latency — enhancement needs no
tools) with the composed prompt piped over stdin (`System: <mode system prompt>\n\n<message>`,
mirroring the FE `streamChat` composition). Stdout is ANSI-stripped and cleaned (🤖-delimited
response extraction plus tool-artifact line filtering, the FE `cleanAgentMessage` port) before
the mode-specific parse.

**Errors** (§9):

- `-32602` — missing/empty `prompt`; `mode` not `"enhance"`/`"layout"`; non-positive
  `timeoutMs`; unknown `workspaceId`.
- `-32603` — auggie CLI not found / spawn failure; timeout (`data` carries
  `"…timed out after <n>ms"`); non-zero CLI exit; in `mode: "enhance"`, a reply missing the
  `<augment-enhanced-prompt>` tags (`data`: `"Failed to parse enhanced prompt from response"`).
  CLI absence is a **hard error** here (unlike §5.30, which degrades to an empty list) —
  there is no meaningful fallback for enhancement.

```json
// → request
{ "jsonrpc":"2.0","id":83,"method":"agent.enhancePrompt",
  "params":{ "prompt":"make login better","model":"haiku4.5","workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":83,"result":{
  "enhanced":"Improve the login flow: add client-side validation …",
  "original":"make login better","mode":"enhance" } }
```


### 5.32 `agent.completeOnce` — one-shot prompt→completion

A stateless one-shot completion RPC (used for background requests such as slug
generation and note-status checks). The daemon owns the full
lifecycle: spawn the provider, collect its cleaned reply, reap the process on any
failure path (timeout, cancel, drop). **No agent session or in-memory state is
created**, so no client-side create→send→read→delete orchestration is needed and
there is nothing to garbage-collect on the error path. Part of the
`agent.*` namespace (§5.5).

| Method | Params | Result |
| --- | --- | --- |
| agent.completeOnce | prompt (req), systemPrompt?, model?, type?, workspaceId?, timeoutMs? | { text } — or { available: false, reason } when the provider gate is closed |

**Provider-neutral routing.** Unlike `agent.enhancePrompt` (§5.31, auggie-only), completion
is routed on the settings-derived effective default provider — `model.defaultProvider`
(§5.12; [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)):

- **auggie** → the `auggie --print` CLI path described under *Execution — auggie route*.
- **claude-code / codex / pi** → an **ephemeral ACP session** (*Execution — ACP route*).
- **anything else**, including unset/undecidable settings and a one-shot-capable provider
  whose adapter cannot be resolved → `{ available: false, reason }`.

**`{ available: false, reason }` shapes.** A typed unavailable result, never an error, so
clients hide the affordance gracefully. Three reasons cover the normal gating paths, plus
two rare defensive shapes; clients must treat `reason` as an opaque display string and
never parse or match on it:

| Condition | `reason` |
| --- | --- |
| No decidable effective default provider (`model.defaultProvider` unset/unregistered — no positional fallback, [intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)) | `completeOnce requires a decidable effective default provider` |
| Effective provider has no one-shot route (not auggie and not claude-code / codex / pi) | `completeOnce is not supported for the effective default provider: <providerId>` |
| One-shot-capable provider whose adapter resolves to nothing (no binary, and no npx for the pinned package) | `<providerId>: no adapter could be resolved (binary not found and npx unavailable)` |
| *(defensive)* ACP one-shot provider id missing from the provider registry — unreachable for the three hardcoded ids | `unknown provider: <providerId>` |
| *(defensive)* codex only: creating the isolated throwaway `CODEX_HOME` tempdir fails | `codex: failed to create isolated CODEX_HOME: <error>` |

Unset/undecidable settings resolve the gate **CLOSED** rather than falling through to the
first registered provider (which would functionally reinstate the removed hardcoded auggie
default) — same ruling as §5.31.

**Params.**

- `prompt` (required, non-empty) — the user prompt sent verbatim to the provider (piped
  over stdin on the auggie route, delivered as the single `session/prompt` text content
  block on the ACP route; composed with `systemPrompt` when supplied).
- `systemPrompt` — optional system prompt; when present the composed input becomes
  `"System: <systemPrompt>\n\n<prompt>"`, mirroring the FE `streamChat` composition
  used by §5.31. Absent/blank → `prompt` rides through unchanged. Applies to both routes.
- `model` — optional provider model id. On the auggie route it is passed as `--model`; on
  the ACP route it rides the provider's own CLI model flag when it has one, and is ignored
  silently by providers that select models through other mechanisms (claude-code and pi
  use `session/set_config_option`) — a best-effort model is never an error. When omitted
  (or blank), the daemon resolves one from the quick-action settings — see *Model
  resolution* below.
- `type` — optional quick-action type hint keying `quickActions.typeOverrides` in the model
  resolution below; conventionally `commit`, `pr`, `review`, or `fast`. Free-form on the
  wire — the key set is client-owned and never validated, so an unknown key simply misses
  the override map and falls through. Ignored entirely when `model` is supplied.
- `workspaceId` — optional; when present the provider runs with the workspace's worktree
  as its working directory (also the ACP `session/new` `cwd`; unknown workspace →
  `-32602`). Without it the auggie CLI runs without a `cwd` and the ACP adapter runs in
  the system temp dir.
- `timeoutMs` — optional positive integer, default `30000` (matches §5.31 default),
  capped at `120000`. A hung provider is reaped when the timeout elapses. On the ACP route
  this bounds the `session/prompt` phase; session setup uses the adapter's own staged
  npx-aware budgets.

**Model resolution** ([intent-hq/monorepo#1734](https://github.com/intent-hq/monorepo/issues/1734)).
The daemon — not the client — resolves the user's quick-action model settings, so **every**
client gets them for free:

1. An explicit non-blank `model` param always wins.
2. `quickActions.typeOverrides[type]` (§5.12) when `type` is supplied and the entry is
   non-blank.
3. `quickActions.defaultModel` when non-blank.
4. Otherwise none — the provider CLI's own default applies.

Steps 2–3 are provider-guarded — the settings value is user-authored and easily outlives a
provider switch, so it is never fed to a foreign CLI. An explicit `model` param must be a **bare** model id: a compound `provider:model` value
is rejected at the wire boundary with `-32602` (same guard as §5.5,
[intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)), and the bare id is passed on unchanged since the one-shot launch takes a raw model id; a prefix that is not a
registered provider id counts as foreign. A **bare** id reuses §5.5's asymmetric
cached-catalog evidence rule: it is dropped only when the effective provider's own cached
catalog affirmatively disproves ownership, so a cold start passes it through. Every drop
falls to step 4 with a daemon warn log rather than being rejected — a `-32602` here would
reject a model the caller never sent. `quickActions.providerSettings` is deliberately **not** a rung: it is
the client's opaque per-provider snapshot cache, not a precedence tier. This chain is scoped
to one-shot quick actions; agent sessions (delegated ones included) keep the
background-agnostic creation-time chain of §5.5
([intent-hq/monorepo#1729](https://github.com/intent-hq/monorepo/issues/1729)).

The daemon-internal auto-commit path (§5.10 wrap-up) calls `agent.completeOnce` with
`type: "commit"`, so it too honors the user's commit-message quick-action override.

**Execution — auggie route.** Same one-shot CLI discipline as `agent.enhancePrompt`
(§5.31): auggie binary resolution (`Services.auggie_bin` test seam → `context.auggiePath`
setting when set and non-empty (exclusive; an invalid path is an error, no silent discovery
fallback) → `find_auggie()` discovery via Intent-managed binary → enhanced PATH), then
`auggie --print --mcp-config {"mcpServers":{}}` (MCP skipped — completion needs no
tools) with the composed prompt piped over stdin. The binary resolution order honors the
existing `context.auggiePath` settings key so explicit user config is never ignored and
hermetic e2e tests (with `auggiePath` set to a fake fixture) never fall back to PATH-based
discovery.

**Execution — ACP route (ephemeral session).** The adapter launch mirrors the model probe
(§5.30): an npx-only provider (claude-code, pi) always runs its pinned package via
`npx -y <package>`; otherwise the resolved binary wins (`providers.paths[<owning
provider>]` → native install dir → enhanced PATH) with the pinned npx package as fallback.
The daemon then drives one **ephemeral** ACP session and kills the child:

1. `initialize` — no client filesystem capabilities.
2. `session/new` — **no MCP servers**, `cwd` from `workspaceId` (else the system temp dir).
3. one `session/prompt` carrying the composed prompt as a single text block; the reply is
   accumulated from the streamed `agent_message_chunk` text updates (thoughts, tool calls
   and plans are ignored).
4. the child is reaped on **every** exit path (success, timeout, error, drop) — SIGTERM to
   its process group, grace, SIGKILL, plus a descendant sweep.

Non-interactive by construction: every agent→client request is answered immediately —
`session/request_permission` resolves `cancelled`, anything else gets method-not-found — so
a one-shot can never block on a human. No session id, agent row, transcript, or event is
persisted; nothing survives the call.

**Concurrency bound — ephemeral adapters (v6.14).** Ephemeral adapters are bounded
daemon-wide by `agents.maxConcurrentAdapters` (§5.12; default `6`, range 1–64, no unlimited
value, applied at boot so a change needs a daemon restart). The bound is shared with the
model probe (§5.30) — both spawn the same provider-CLI chain (~610 MB) and neither holds an
`agents.maxConcurrent` slot, so before it a quick-action fan-out was ceilinged only by
`server.maxOutstandingRpcs` ([monorepo#2062](https://github.com/intent-hq/monorepo/issues/2062)).
At the cap a call **queues** rather than spawning:

- The queue wait is bounded by the caller's own `timeoutMs` — a **separate** budget of the
  same size, not one shared with session setup and `session/prompt`, so a queued call's
  worst-case latency grows by up to `timeoutMs` on top of the existing budgets.
- A call admitted before its budget expires proceeds normally; queuing is otherwise
  invisible on the wire.
- A call whose budget expires while queued fails with the `adapter-busy` error below.
  **Nothing was spawned and no model was asked**, so retrying once the daemon drains is
  always safe.

`models.list` is affected in one visible way: a refresh whose probe cannot get a slot falls
back to the static model list rather than failing.

Both routes clean the reply identically (ANSI-strip, 🤖-delimited response extraction plus
tool-artifact line filtering, the FE `cleanAgentMessage` port) before returning it verbatim
as `text`. No streaming, no events, no persistence on either route.

**Errors** (§9):

- `-32602` — missing/empty `prompt`; non-positive `timeoutMs`; unknown `workspaceId`.
- `-32603` — auggie route: CLI not found / spawn failure; timeout (`data` carries
  `"…timed out after <n>ms"`); non-zero CLI exit. ACP route: a **resolved** adapter that
  fails the turn — spawn failure, transport failure, setup or prompt timeout, an adapter
  JSON-RPC error, an early adapter exit, or a turn that streamed no text — with `data`
  prefixed by the provider id (`"<providerId>: …"`). Provider absence is a hard error only
  once an adapter has been resolved; an unresolvable adapter is the
  `{ available: false, reason }` case above, not a `-32603`.
- `-32603` **`adapter-busy`** *(v6.14)* — the call waited out its own `timeoutMs` queued at
  the ephemeral-adapter bound above. `error.message` is
  `no free adapter slot for <providerId> after <n>ms (agents.maxConcurrentAdapters = <limit>)`
  and `error.data` is an **object**: `{ code: "adapter-busy", provider, waitedMs, limit }`.
  This is the one `-32603` on this method whose `data` is not a bare string — clients must
  check `typeof data === "object" && data.code === "adapter-busy"` rather than assuming a
  string, and must not prose-match the message. Always safe to retry (nothing spawned).

```json
// → request
{ "jsonrpc":"2.0","id":84,"method":"agent.completeOnce",
  "params":{ "prompt":"one-line slug for: fix the login flow" } }
// ← response
{ "jsonrpc":"2.0","id":84,"result":{ "text":"fix-login-flow" } }
```

### 5.34 Skills — `skill.list`

The backend exposes daemon-side skills discovery so clients can list skills for a workspace. The daemon scans the 5-tier precedence (user p1-3: `~/.agents/skills`, `~/.claude/skills`, `~/.augment/skills`; project p4-5: `<workspace>/.agents/skills`, `<workspace>/.augment/skills`) and parses `SKILL.md` frontmatter (name, description, allowedTools, compatibility). Name collisions shadow by precedence with warn logs. The discovered skill set is cached (with mtime-based fingerprints for cache invalidation) and monitored via filesystem watchers on all five scan roots; the daemon emits `skills:changed` events when SKILL.md files are created, modified, or deleted.

| Method | Params | Result |
| --- | --- | --- |
| skill.list | workspaceId (req) | bare array of `{ name, description, location, scope, allowedTools?, compatibility? }` (name-sorted, scope: "project"\|"user") — -32602 if the workspace is not found or has no worktree path |

- `name` / `description` are the parsed SKILL.md frontmatter fields; `location` is the absolute path to the SKILL.md file; `scope` is `"project"` for workspace-tier skills (p4-5) and `"user"` for user-tier skills (p1-3); `allowedTools` / `compatibility` are optional frontmatter fields.
- Skills are returned in **name-sorted** order for deterministic output. When a name collision occurs, the higher-precedence tier wins and a warn log is emitted.
- The daemon watches all five scan roots recursively (using `notify` watchers, the same infrastructure as workspace `file:changed` events); when a SKILL.md file is created/modified/deleted under a watched root, the daemon re-runs discovery for the affected workspace(s) (user-tier changes affect all workspaces; project-tier changes are workspace-scoped), compares the newly-discovered set against the cached skill set, and emits `skills:changed` (§6.5) only if the set actually changed (500ms debounce per workspace). Non-existent roots are handled gracefully by watching the nearest existing ancestor. The `skill.list` handler also performs a check-on-read as a fallback safety net.

```json
// → request
{ "jsonrpc":"2.0","id":64,"method":"skill.list","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":64,"result":[
  { "name":"python-expert","description":"Python development specialist","location":"/Users/user/.augment/skills/python-expert/SKILL.md","scope":"user" },
  { "name":"typescript-expert","description":"TypeScript specialist","location":"/workspace/.augment/skills/typescript-expert/SKILL.md","scope":"project","allowedTools":"*","compatibility":"typescript" } ] }
```

### 5.35 Interrupted-agent resumption — `agent.listInterrupted` / `agent.resolveInterrupted`

These methods manage agent resumption across daemon restarts. When `intentd` restarts, in-flight agent sessions (`active`, `processing`, `waiting` statuses) are captured as **interrupted records** before the heal sweep rewrites them to `idle`. This capture occurs on both graceful shutdown (`SIGINT`/`SIGTERM`) and crash scenarios, ensuring that agents mid-turn are always resumable. Clients discover interrupted agents via `agent.listInterrupted` and resolve them via `agent.resolveInterrupted` (resume or abandon). For headless deployments, `intentd serve --resume-all` auto-resumes all interrupted agents at startup.

#### `agent.listInterrupted`

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "agents": [
    {
      "agentId": "agent-abc123",
      "workspaceId": "ws-xyz",
      "workspaceName": "Feature: Dark mode",
      "agentName": "Implementor",
      "prevStatus": "active",
      "interruptedAt": "2026-07-16T10:15:30.123Z"
    }
  ]
}
```

Returns pending interrupted agents across all workspaces. Each `InterruptedAgent` includes:

- `agentId`, `workspaceId` — session and workspace IDs
- `workspaceName`, `agentName` — joined from workspace/agent-session tables (may be empty if session deleted after interruption)
- `prevStatus` — the agent's status before interruption (`active`, `processing`, or `waiting`)
- `interruptedAt` — ISO 8601 timestamp when the agent was interrupted

Rows with `resolution='pending'` survive multiple restarts (idempotent capture). Resolved rows (`resumed` / `abandoned`) are excluded.

#### `agent.resolveInterrupted`

**Request:**

```json
{
  "resume": ["agent-abc123"],
  "abandon": ["agent-def456"]
}
```

**Validation rules:**

- `resume` and `abandon` are **optional** parameters.
- When present, each must be an **array of strings** (non-array → `-32602 "resume/abandon must be an array"`; non-string element → `-32602 "resume[i]/abandon[i] must be a string"`).
- `null` is treated as non-array and rejected with `-32602`.
- At least one of `resume` or `abandon` **does not** need to be present; both can be absent or empty arrays (no-op).

**Response:**

```json
{
  "resumed": ["agent-abc123"],
  "abandoned": ["agent-def456"],
  "failed": []
}
```

Resolves interrupted agents:

- **Resume:** Atomically marks row `resolved='resumed'` (claim-first), re-registers parent completion watches (if delegated), delivers a continuation message (`"You were interrupted because the harness shut down. You now have a chance to continue the work — review your last steps and pick up where you left off."`) via `agent.sendMessage`. Delivery lazily respawns the ACP provider and resumes via `session/load` (with `session/new` recreate fallback). If any post-claim step fails, the row is reset to `pending` (resolution=NULL) to restore retryability, and the error is returned.
- **Abandon:** Marks row `resolved='abandoned'`, appends a system-role interruption message (text block with `meta.kind="interruption"`: `"This conversation was interrupted because intentd restarted. The agent's in-flight work was terminated."`), emits `agent:message` + `agent:updated` events.

**Errors:**

- An agent ID appearing in both `resume` and `abandon` → `-32602 "Agent id X appears in both resume and abandon"`
- Unknown or already-resolved IDs land in the `failed` array: `{ agentId, error }` (error string describes the failure reason)

Per-agent failures are isolated; other agents in the same call proceed normally.

#### Queued-message preservation

**Queues survive restarts.** The per-agent send queue (`agent.queueMessage` / `agent.getQueue`, §5.5) is persisted write-through to the `agent_queue` SQLite table: every enqueue, edit, remove, and drain mutation of the in-memory queue is mirrored to the store, so both graceful shutdowns and crashes preserve queued messages. At daemon startup, persisted queues are rehydrated into memory before RPCs are served. Rehydration alone never starts a turn; entries mid-edit at shutdown are restored as ready-to-send (`editing: false`), and attachment blocks plus metadata round-trip intact.

**Resume ordering contract:** When an interrupted agent is resumed — via `agent.resolveInterrupted { resume }` or `serve --resume-all` — the continuation message streams **first**; the preserved queue then drains FIFO in original order after that turn completes. Abandoning an interrupted agent leaves its preserved queue intact and inert (no auto-send); entries remain visible via `agent.getQueue` and removable via `agent.removeQueuedMessage`.

**Stale-redrive detection (new in intentd, #576):** every queue drain path checks, BEFORE the transcript append, whether the dequeued message is stale for a delegated agent — the entry's `queuedAt` (the same wire field served by `agent.getQueue`) predates the `completionReportTimestamp` on the child's session, i.e. the message was enqueued before the currently-persisted completion report existed, so the parent has already been woken with that report. Stale entries are redriven with a deterministic `[SYSTEM NOTE]` annotation appended to the content (idempotent across requeues) and their turn suppresses the turn-begin completion-report clear (see `agent.reportToParent`, §5.5). For a requeued entry whose user row was already persisted before a failed turn, the annotation is skipped (the transcript row is never mutated) while the report clear is still suppressed. Session-lookup or timestamp-parse failures fail open: the entry is treated as fresh and drains with today's behavior.

No RPC surface changes: `agent.getQueue`, `agent:queue:updated`, and the edit/remove/drain flows operate on the in-memory map, which is now durable.

#### Delegation-group persistence

`after_all`** groups survive restarts.** When a parent delegates children with `waitMode: "after_all"`, the delegation group is persisted in the `delegation_group` SQLite table. At daemon startup, the heal sweep rehydrates all sealed groups and re-registers the aggregated-wake delivery watch. Resumed grouped children automatically re-enroll in their persisted group; when all children complete, the daemon delivers exactly one aggregated wake to the parent containing all children's reports.

**Durable-before-observable:** Child completions are recorded durably in `delegation_group` **before** the `agent:idle` event publishes. A daemon kill between completion and event delivery cannot lose completion state — the resumed child's completion is already persisted when the daemon restarts.

**Group-wake format:** The aggregated wake is a single agent turn delivered to the parent, containing a `[WORKSPACE EVENTS]` summary block listing all children's completion reports. Each child's report line: `**{child_name}** (agent-{id}) completed. Report: {completion_report_text}`. After delivery, the group row is pruned.

#### Delivery-time "tasks now unblocked" hints

*(behavior + additive metadata key on the opaque `event_notification` `messageMetadata` payload; no method-catalog or wire-shape change — [intent-hq/intentd#1138](https://github.com/intent-hq/intentd/pull/1138), [intent-hq/intentd#1144](https://github.com/intent-hq/intentd/pull/1144), [monorepo#2044](https://github.com/intent-hq/monorepo/issues/2044); agent-flipped completion triggers — [intent-hq/intentd#1340](https://github.com/intent-hq/intentd/pull/1340))*

When a delegated child's completion makes other tasks startable, the delegator's completion wake ends with an **advisory** section naming them. The design splits the work across the wake's lifetime:

- **Enqueue time records only the triggering fact.** Each terminal wake-composition site — the ungrouped completion-watch wake and the `after_all` aggregated group wake — stamps the settled task-linked children's task-note ids onto the wake's `event_notification` metadata under `unblockedTriggerTasks` (`[{ workspaceId, taskNoteId }]`). No readiness enumeration is computed or stored at enqueue. For grouped children the trigger is captured at group **record** time (when the child settles) on the persisted group event data, so a task-linked child deleted between its settlement and group settlement keeps its trigger, and triggers survive daemon restarts with the group. **Agent-flipped completions join the trigger set** *(behavior + persisted-store change only; the `unblockedTriggerTasks` metadata shape is unchanged)*: when an agent (typically a verifier) transitions ANOTHER task note's status ACROSS the `complete` boundary (previous ≠ `complete`, new = `complete`) via `task.updateNoteStatus` or `task.markAsTask`, the `(workspaceId, taskNoteId)` pair is recorded on the calling agent's session in the persisted `agent_flipped_completion` table (cascading with the session, so flipped triggers are restart-durable like the group-event stamp) — deduped per pair, **capped at 50 per agent** (oldest evicted), the agent's own linked task note excluded (it is already stamped separately), and user-initiated (caller-less) status writes recording nothing; a later transition OUT of `complete` removes the pair for every recording agent, and recording is best-effort (a store failure logs and never fails the status write). Both terminal stamp sites JOIN the recorded set into the wake's trigger stamp and **consume it on stamp** (the read is a single list-oldest-first-and-clear), so a later cycle never re-attributes old flips: the ungrouped completion-watch wake joins flips only on a genuine `agent:idle` completion (interim/deferred idles never consume; failure/deletion wakes stamp no flips); the `after_all` group stamp consumes at group **record** time on both record paths — live settlement and restart-rehydration reconcile, where the stamp runs AFTER the deferral checks so a deferred idle never consumes flips — meaning a member's flips are captured when it settles and survive restarts with the persisted group. The immediate `agent.reportToParent` progress wake consumes no trigger facts or flipped completions; they remain available for the terminal wake. The existing trigger collector dedups own-task + flipped pairs. Flips recorded by an agent whose session never composes a parent wake (root/user-facing agents) expire unconsumed with the session — acceptable, since the delegator's own flips are covered by the batch-delegate `unlockPlan`. **Group-event stamp key — multi-pair, back-compat:** the record-time stamp persisted on the group event data under the `unblockedTriggerTask` key changes from a single `{ workspaceId, taskNoteId }` object to an **array of pairs** (own task + consumed flips); the reader accepts both shapes, so pre-upgrade persisted group events carrying the legacy single-object stamp still resolve their trigger after an upgrade (malformed entries are skipped, never an error).
- **Delivery/render time resolves the enumeration fresh.** At every point where queued wake content is rendered for a model turn (queue drains, batch flush, direct send to an idle parent, the store-only parent-wake persist), the daemon collects the trigger ids from **all** trigger-carrying entries draining in the same batch, snapshots the named workspaces' CURRENT task state (the same snapshot the batch-delegate classification reads, so readiness semantics are identical), computes the readiness delta attributable to the triggers, and appends ONE coalesced section to the LAST trigger-carrying entry. Because the state is read at delivery, a wake that sat queued behind a busy parent never carries a stale enumeration: a task claimed or completed in the interim drops out, and a task whose other dependency completed in the interim drops in.

**Section format:** `Tasks now unblocked by this completion: [Title](intent://local/task/{id}) (deps satisfied), [Title](intent://local/task/{id}) (conflict cleared).` — plural framing (`these completions`) when the coalesced trigger set covers more than one completion. A task appears iff it is ready now (dep-satisfied and conflict-free) but was NOT ready in the counterfactual where the trigger tasks are still in flight — tasks already ready beforehand, still-blocked tasks, terminal (`complete`/`cancelled`) / `in_progress` / live-agent-assigned tasks, and the triggers themselves never show up; only triggers currently `complete` count (ids deleted or reopened between enqueue and delivery are skipped gracefully). A task sitting in an attention status (`waiting` / `discussion_needed` / `blocked` / `review_required`) stays in the delta and is annotated inline (e.g. `(deps satisfied; currently blocked — needs attention)`) rather than dropped — the delegator may want to resolve the attention state precisely because the task is otherwise unblocked. Output is sorted by title then note id.

**Strictly advisory and fail-open:** the section triggers no auto-starts and writes no task state — the delegator still calls `agent.delegate` for anything it wants started (the same contract as the batch form's `unlockPlan`). An empty delta or a snapshot failure appends nothing (the wake delivers unannotated); `persisted: true` requeues are never rewritten, and content already carrying the section (terminal-failure requeue) is never annotated twice.

#### Completion-watch persistence

**Deliver-once, queue- and busy-aware completion.** Every ungrouped completion watch — whatever path registered it (`agent.delegate` auto-watch, `agent.wakeOrCreate` SUB-1, `ws.agent.create` auto-subscribe, the sender auto-subscribe, explicit `ws.agent.watch`, the chief-only MCP `ws.app.agents.waitFor` binding) — delivers exactly one terminal completion wake and is then retired. The daemon durably queues the wake under the stable `completion-wake:<watchId>` message identity before one transaction records the stable completion or failure identity and deletes the persisted watch; the in-memory watch is removed only after commit. Delivery and settlement retries reuse the stable message identity, so they are idempotent; a failed delivery or settlement leaves the persisted watch armed as the restart-recovery record. **Completion** is the target reaching `agent:idle` with an EMPTY ready-to-send pending queue AND no in-flight turn worker, or `agent:failed` / `agent:deleted` regardless of queue/busy state (a failed child is parked; its queue never self-drains). An `agent:idle` while the target still holds ready-to-send queued messages (entries under edit don't count — the same `has_ready_to_send` gate as the idle-emit invariant), or while the target's worker is already busy in a new turn ([monorepo#1297](https://github.com/intent-hq/monorepo/issues/1297): an enqueue that raced the idle emit may have been dequeued and started before delivery, leaving the queue empty but the busy slot held), is an **interim idle**: the watch neither delivers nor retires, staying armed for the real completion after the queue drains / running turn ends — this is what makes the wakeOrCreate queued branch work with no special watch mode and no leak-guard timer. Grouped (`after_all`) watches are exempt from the interim-idle gate (group settlement accounting must see every completion) and are owned by group settlement. **Hook-waiting deferral (idle-visibility, within v3.1).** An `agent:idle` while the target still owns ACTIVE (`scheduled`/`running`) background hooks (§5.40) is likewise **not** its completion — the child will run again when a hook dispatches, fails, or expires — so completion-watch delivery for that idle is **deferred**: the watch neither delivers nor retires (no "child completed" wake fires while the child is merely waiting on a hook — though the deferral is no longer silent for the watcher: see the **monitoring-idle advisory wake** below), and — unlike the queue-interim case — grouped (`after_all`) watches defer too: a hook-waiting child does **not** count as settled and its group stays open until the child's genuine settlement (deferral is TTL-bounded: hooks expire within 24 hours and every terminal hook transition wakes the owner, whose next hookless idle settles the watch/group — so no deferral outlasts the last hook's expiry plus one child turn). The classification probes the hook store live at delivery time (an emit-time `waitingOnHooks` stamp alone never defers a child whose hooks already settled), and a probe failure reads as no hooks (fail-open: a missed deferral only yields the pre-deferral early wake). Never deferred: `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out (blocker/discussion) — only the plain `agent:idle` settlement path defers. Edge cases: an **external `hook.cancel`** (the FE path) on an idle child whose last active hook it cancels fires the deferred watch at that moment (every terminal hook transition re-runs the deferred-completion redelivery as a backstop, so a cancel with no owner wake — or a failed wake delivery — still settles it); **daemon-restart rehydration** consults active hooks the same way — the reconciliation pass and registration-time reconciliation both skip the synthetic idle-completion refire for a child that is idle with active hooks (resumed hooks keep their original `expiresAt`, so the deferral stays bounded across restarts), while failed/deleted children still reconcile immediately. **PR-monitor-waiting deferral (idle-visibility, unified external-wait, within v6.2; [intent-hq/intentd#1002](https://github.com/intent-hq/intentd/pull/1002)).** An `agent:idle` while the target still owns ACTIVE PR monitors (§5.42) is likewise **not** its completion — the child will run again when its monitored PR changes, merges/closes, or the monitor is cancelled — so completion-watch delivery for that idle **defers exactly like the hook-waiting case**: the watch neither delivers nor retires, and grouped (`after_all`) watches defer too — a pr-monitor-waiting child does **not** count as settled and its group stays open until the child's genuine settlement. The classification probes the monitor store live at delivery time (an emit-time `waitingOnPrMonitors` stamp alone never defers a child whose monitors already settled), and a probe failure reads as no monitors (fail-open, same as the hook probe). Never deferred: `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out. **Key difference from hook-waiting: no TTL.** Unlike background hooks (bounded by their 24-hour cap), PR monitors have **no TTL** (§5.42) — a monitor can sit ACTIVE indefinitely while a PR sits unreviewed — so this deferral has **no time bound of its own**. It resolves instead via one of the monitor's **terminal transitions**, each of which re-runs the deferred-completion redelivery as a backstop even when the transition itself delivers no wake: the monitor **completing** (PR merged/closed — an immediate, undebounced wake), the owner's own **`ws.pr.unmonitor`** (which delivers no self-wake, so the backstop is what settles the deferred watch), an **external `prMonitor.cancel`** (the FE path — mirrors the hook-waiting `hook.cancel` edge case; the owner does get a cancellation-notice wake here, but the backstop still runs as a safety net), the **`workspace.archive` sweep cancel** (§5.1 archive active-work teardown; [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067) — same shared cancel transition, with an archive-specific notice wake that parks behind the archived gate; the backstop still runs after the delivery attempt), and **daemon-restart rehydration** (reconciliation skips the synthetic idle-completion refire for a child that is idle with active monitors, exactly like the hook case — resumed monitors keep polling independently after restart, so there is no bounded re-arm window to preserve). Because there is no TTL, an abandoned PR with a permanently-open monitor can in principle defer forever; this mirrors the accepted trade-off already documented for the deeper agent-waiting deadlock cycles below — but the wait is no longer silent: the **monitoring-idle advisory wake** below tells each watcher once per continuous waiting period that the child is idle-but-monitoring, while every watch — grouped or not — stays armed for the child's genuine settlement. **Monitoring-idle advisory wake (idle-visibility, additive metadata within v8.6).** A live `agent:idle` whose completion-watch delivery is deferred SOLELY because the child owns active background hooks (§5.40) and/or active PR monitors (§5.42) — not queue-interim, not busy (but see the busy-slot carve-out under **Live idles only** below), not agent-waiting — additionally delivers a one-time **advisory wake** to each of the child's watchers instead of parking them in silence (the motivating case: a PR monitor has no TTL, so an ungrouped parent could otherwise wait forever with no signal). The advisory message states that the child is idle but still monitoring external conditions, enumerates what it is waiting on, and states that the watch stays armed and fires at the child's genuine settlement (the ungrouped shape names `ws.agent.unwatch` as the opt-out; the grouped shape notes the delegation group still waits). Advisory wakes carry additive metadata: `watchStillArmed: true` (both shapes — advisories never consume a watch; [intent-hq/intent#4254](https://github.com/intent-hq/intent/issues/4254)), `childExternallyWaiting: true`, `waitingOnHooks` (array of `{ hookId, name, nextRunAt?, expiresAt? }`), and `waitingOnPrMonitors` (array of `{ monitorId, repo, prNumber, title? }`); absent/empty arrays mean that source contributed nothing. **No watch is consumed** ([intent-hq/intent#4254](https://github.com/intent-hq/intent/issues/4254)): the advisory is informational on both shapes. The ungrouped watch stays armed — same id — and still delivers the genuine completion/failure/deletion wake later; the advisory is durably queued under the stable `advisory-wake:<watchId>:<eventId>` message identity (the triggering idle event's id is a per-period discriminator, because the armed watch keeps its id across waiting periods — a bare `advisory-wake:<watchId>` would be dedup-suppressed in every period after the first). Grouped (`after_all`) memberships are likewise untouched — the child still does not count as settled, the group stays open until its genuine settlement, and group settlement semantics are unchanged. Ask-registered completion-only watches (the chief `ws.app.agents.ask` shape) never receive an advisory: they defer silently, waiting strictly for terminal settlement, and neither consult nor write the once-per-period marker (this holds for watches the ask path CREATES — an `ask` that finds an existing ungrouped watch for the same parent/child pair reuses it as-is, so a prior `ws.agent.watch` on the same target keeps its advisory eligibility). **Once per waiting period**: delivery persists a marker (the `advisory_wake_delivery` table, keyed by parent + child; excluded from workspace transfer like its completion-marker counterpart) so subsequent monitoring idles in the SAME continuous waiting period defer silently exactly as before (the marker read fails closed: on a read error the advisory is skipped and the watch stays armed — see **Ordering & failure semantics** below). The period ends — and the marker clears — when the child starts a REAL turn (a best-effort by-child clear at turn start: a child that leaves monitoring-idle — user message, hook dispatch — and later stalls monitoring-idle again opens a NEW waiting period, so the still-armed watch hears a fresh advisory instead of parking in silence indefinitely) and, as a backstop, when the child's genuine completion/failure/deletion settles (a by-child clear in the non-interim settlement pass — watch or no watch, so no parent can leak a marker that would suppress a later period's advisory; the per-watch clears remain as idempotent covers: terminal wake delivery for ungrouped watches, the settlement record for grouped memberships — which can precede the aggregated seal wake). Grouped and ungrouped advisories share the marker — a parent hears at most one advisory per (parent, child) waiting period regardless of watch shape. **Ordering & failure semantics**: the advisory wake is durably queued under its stable message identity first; the shared period marker is then recorded best-effort — no watch is retired on either branch, so no retirement transaction exists. Within one period a delivery retry replays the SAME idle event and dedups on the identical stable identity; a crash or failure after the wake persists but before the marker write means the next idle's fresh event id re-sends one duplicate advisory — the accepted worst case. Marker reads fail closed (on a read error the advisory is skipped and the watch stays armed) and the turn-start/settlement marker clears are best-effort — the worst case is one duplicate or one suppressed advisory, never a lost genuine wake. A failed ungrouped advisory delivery leaves the watch armed AND schedules the per-child delivery retry (the same retry task the genuine-completion failure sites use — the advisory is the one event meant to break the parent's unbounded silent wait, so it must not wait for the child's next idle); the retry replays the advisory-allowed delivery pass, idempotent under the stable message identity. **Live idles only**: registration-time reconciliation, daemon-restart rehydration, and the terminal-transition redelivery backstops (hook cancel/expiry, monitor complete/unmonitor/cancel) never fire the advisory — they keep their existing defer-or-deliver behavior, and an already-advised watch simply defers silently for the rest of the period, staying armed for the terminal backstops to settle — with one exception: a live monitoring idle whose advisory was suppressed solely by the busy-slot interim probe ([monorepo#1297](https://github.com/intent-hq/monorepo/issues/1297): the worker publishes the terminal `agent:idle` before releasing the busy slot, so the live idle classifies busy-interim) records advisory-pending provenance on the interim-skip marker, and the worker-exit redelivery consults it and runs the advisory-ALLOWED delivery variant — the owed advisory still delivers exactly once per waiting period (the persisted `advisory_wake_delivery` marker semantics are unchanged); registration-time/boot reconciliation and all other synthetic passes keep the silent skip. **Agent-waiting deferral (behavior-only within v4.3; [monorepo#1468](https://github.com/intent-hq/monorepo/issues/1468)).** An `agent:idle` while the target itself holds live outgoing completion watches on other, unsettled agents is likewise **not** its completion — the target will run again when a watched agent completes (the motivating case: an implementor idling while it waits on its PR reviewer must not wake its coordinator into a no-progress loop). Such an agent-waiting idle defers WATCH delivery exactly like a hook-waiting one: ungrouped watches on the target neither deliver nor retire, and the target's grouped (`after_all`) memberships skip the settlement record, so its group stays open until it settles for real. The classification is probed **live at delivery time** (the emit-time `isWaitingForOtherAgents` stamp alone never defers a target whose watches already settled), counting both the target's ungrouped outgoing watches and its grouped ones (a coordinator idling while its own delegation group is open is genuinely waiting on its children); a persisted-row read failure on the startup path fails open (not waiting — a missed deferral only yields the pre-deferral early wake). **Seal-interim vs. watch-interim split:** unlike the queue/busy/hook cases, agent-waiting does NOT defer the target's OWN `after_all` group **seal** — an `after_all` coordinator always holds grouped outgoing watches on its own children, so gating the seal on agent-waiting would deadlock the group (the seal is what closes the coordinator's delegating turn); only watch delivery to the target's watchers and the target's settlement records defer. **2-cycle deadlock guard:** a mutual watch pair (A⇄B) in which BOTH sides are idle (not busy, empty ready-to-send queue) would defer forever, so an outgoing watch on a target that watches this agent back and is itself idle is NOT counted as a waiting reason — the deadlocked pair delivers as before (both watchers fire); a mutual pair whose counterpart is still busy is a genuine wait and still defers. Deeper cycles (A→B→C→A) are a **documented limitation**: they are not detected and will defer until an external event (watch removal, failure, deletion) breaks the cycle. **Redelivery backstops:** the deferral has no TTL of its own, so every path that removes the target's outgoing watches re-runs the deferred-completion redelivery — `agent.unwatch` / `ws.agent.unwatch`, `agent.cancelSubscriptions` (both the scoped and the remove-all forms), and `after_all` group settlement (which drops the parent's grouped watches) — so a deferred watcher settles when the target's last outgoing watch disappears without producing a wake (e.g. the aggregated group wake's delivery failed). Never deferred (same as hook-waiting): `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out. **Reconciliation paths across restarts:** the startup rehydration reconcile, registration-time reconciliation (`ws.agent.watch` re-arm on an already-idle target, `ws.app.agents.waitFor`), and the group-rehydration pre-publish records all apply the same predicate — an idle child holding outgoing completion watches records the interim-skip marker and leaves the watch armed / skips the group record instead of firing a synthetic completion; group rehydration uses a durable variant that falls back to persisted `completion_watch` rows because groups rehydrate before the watch registry loads. Synthetic idles from these paths stamp `isWaitingForOtherAgents` consistently with live emits; failed/deleted children still reconcile immediately. Attention events (blocker raised / discussion requested) fan out to EVERY active completion watch on the target — whatever path registered it; the `wake_on_attention` flag no longer gates the fan-out ([monorepo#3443](https://github.com/intent-hq/monorepo/issues/3443)) — WITHOUT consuming the watch — attention is not a completion; the watch still ends at the target's next completion. An agent that wants wakes for a target's future turns must re-arm (sending/waking auto-subscribes, or call `ws.agent.watch` again). **Completion watches survive restarts.** Watches are persisted in the `completion_watch` SQLite table via a best-effort spawned async write (NOT durable-before-observable; `ws.app.agents.waitFor` and `ws.agent.watch` alone AWAIT the write because registration-time reconciliation may fire the watch immediately — but both remain fail-open on a persist error: a failed write only logs, and the in-memory watch still delivers live), and cancelled watches are deleted directly. Terminal delivery follows the durable-queue-then-transactional-retirement sequence above. At daemon startup, surviving rows are rehydrated into the in-memory registry: rows whose parent agent is gone (or whose delegation group already settled) are pruned; each remaining watch's child is then reconciled against current agent state, so a child that completed / failed / was deleted while the daemon was down delivers a synthetic completion wake immediately instead of leaving the parent waiting forever. `ws.app.agents.waitFor` runs the same reconciliation at registration time, so waiting on an already-settled target wakes the caller right away. No RPC surface changes: the watches remain visible via `agent.getSubscriptions` and removable via `agent.cancelSubscriptions`; the subscription registry itself is daemon-level, so chief-workspace (`__chief__`) parents can hold watches on children in any workspace (non-chief parents remain scoped to their own workspace). **Watch registration fails closed on a nonexistent child.** The watch-registration op behind the `ws.agent.create` auto-subscribe (`agent.watchCompletion`) rejects a nonexistent child agent with `-32602` naming the id BEFORE any watch is registered — it no longer falls back to the call's workspace and registers a watch that can never fire (a phantom `waitingForAgentIds` entry on the parent); this mirrors the sender auto-subscribe guard on `agent.sendMessage` (§5.5). The existing deleted-parent guard (`ok: false`, no watch) is unchanged, and the child guard takes precedence when both the parent is deleted and the child is nonexistent.

**Pair uniqueness — at most one active watch per (parent, child)** *(new in intentd)*. A parent holds at most ONE active completion watch on a given child, across ungrouped watches and `after_all` delegation-group membership, so duplicate waits (and duplicate wakes for one completion) can never appear on the wire. Enforcement is per registration path: **explicit** registrations reject — `ws.app.agents.waitFor` on a target the caller already watches (grouped or not) is rejected with `-32602` naming the target (`already waiting on agent <id>: …`), in the same up-front validation loop as the scope gate, so the rejection is side-effect free (no group, no watches; the pre-existing watch survives unchanged; cancel it via `agent.cancelSubscriptions` to re-register). **Auto-subscribe** paths that piggyback on another operation (`agent.delegate` auto-watch, `agent.wakeOrCreate`, `ws.agent.create` auto-subscribe, the sender auto-subscribe on `agent.sendMessage`/`agent.sendToTask`) never fail the parent operation on a duplicate: the shared registration path silently ADOPTS the existing watch for the pair — returning its `subscriptionId` — and only ever strengthens it, never weakens it: a grouped (`after_all`) registration converts the existing watch into the group watch (`group_id` set) because group settlement accounting requires the grouped watch to exist — the group always wins a collision; an ungrouped registration against an existing grouped watch is a no-op; `wake_on_attention` is strengthen-only (an explicit `ws.agent.watch` sets it; a later auto registration never clears it). The adopted watch's strengthened mode is persisted (upsert on the same row id). Startup rehydration coalesces pre-invariant duplicate persisted rows: rows are loaded grouped-first (then by `created_at`, oldest first) and a row whose (parent, child) pair is already watched in memory is pruned (deleted), so the invariant holds after upgrade. The coalescing rank need not consider `wake_on_attention`: pair uniqueness shipped before the attention flag existed (migration 0072), so pre-invariant duplicate rows always carry `wake_on_attention = 0` and the ordering can never prune an attention-enabled watch in favor of a weaker one.

**Explicit agent watches — MCP `ws.agent.watch` / `ws.agent.unwatch`** *([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229); MCP bindings only, not wire-routable)*. Because agent event subscriptions are off-limits to agent callers (see the §5.5 `agent.subscribe` restriction), `ws.agent.watch(agentId)` is the sanctioned way for one agent to monitor another: it registers an explicit, ungrouped caller→target completion watch on the same `completion_watch` registry, returning `{ ok: true, subscriptionId, agentId }`. Like every ungrouped watch it is **deliver-once**: it fires exactly once at the target's completion (idle with an empty pending queue, failed, or deleted — the queue-aware contract above) and is then retired; the caller re-arms with another `ws.agent.watch` call if it wants the next turn too. Like every active completion watch, the caller is additionally woken on the target's attention events — **blocker raised, discussion requested** — and those attention wakes do NOT consume the watch; the `wake_on_attention` flag (persisted via migration 0070's `completion_watch.wake_on_attention` column) remains the durable record of an explicit registration but no longer gates the attention fan-out ([monorepo#3443](https://github.com/intent-hq/monorepo/issues/3443)). Semantics: (1) **fail closed** — a nonexistent or Deleted target is rejected with `-32602` (`unknown agent id: <id>`) before any registration, self-watching is rejected (`cannot watch yourself`), and the shared `check_watch_scope` gate rejects cross-workspace targets for non-chief callers; caller-only (the front door has no wake target). (2) **Durable registration** — the persist is AWAITED before the call returns (the registration is the caller's durable contract; contrast the best-effort spawned writes of the auto paths above — a failed write still only logs, with the in-memory watch delivering live), and the watch survives daemon restarts through the standard rehydration. (3) **Settled-target reconciliation** — after registration the target is reconciled against current agent state (the same path `ws.app.agents.waitFor` and startup rehydration use), so watching an already-settled target delivers its synthetic completion wake immediately. (4) **Pair-uniqueness adoption** — as a strengthen-only registration, an existing watch for the pair is adopted in place: `wake_on_attention` is set (a later auto registration never clears it), and a grouped watch keeps its group but gains the attention flag. (5) **Attention fan-out** — `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` (§5.5 attention-request flow, step 6) additionally wakes every active completion watch on the caller — explicit and auto-registered alike, regardless of `wake_on_attention` ([monorepo#3443](https://github.com/intent-hq/monorepo/issues/3443)) — with the kind-flavored `[WORKSPACE EVENTS]` wake (`Watched agent <name> (<id>) requests a discussion / reports a blocker: <reason>`, `event_notification` metadata embedding the `agent:attention-requested` payload), EXCLUDING the caller's parent — the direct parent wake already fired, so a parent that also explicitly watches its child never receives a duplicate; watches stay in place (attention is not a completion). (6) **Progress reports preserve completion delivery** — an `agent.reportToParent` progress wake leaves every terminal completion watch armed, including a matching explicit parent watch and third-party watches; the later terminal completion delivers to each applicable watcher and retires each one through the durable settlement protocol. (7) **Deleted-target cleanup** — `agent:deleted` is a terminal completion: the daemon durably queues the stable-id wake before the retirement transaction deletes the persisted watch, then removes the in-memory watch after commit. `ws.agent.unwatch(subscriptionId | agentId)` removes one of the **caller's own** watches, addressed by either id: an unknown/foreign `subscriptionId` is rejected with `-32602` (never removed); the `agentId` form is idempotent (`{ ok: true, removed: false }` when no matching ungrouped watch exists); grouped watches are owned by delegation-group settlement and are rejected (`use agent.cancelSubscriptions with groupId instead`). Both directions publish the standard `agent:subscriptions-changed` snapshot in the caller's home workspace, and the watches remain visible via `agent.getSubscriptions` / removable via `agent.cancelSubscriptions` like any other completion watch.

**Machine-readable watch state on agent-watch wakes — `watchStillArmed`** *(additive key on the opaque `event_notification` `messageMetadata` payload, presence-detected per the §5 convention; no method-catalog or wire-shape change — [monorepo#2060](https://github.com/intent-hq/monorepo/issues/2060); the `hookStillActive` counterpart from the §5.40 hook dispatch wakes, monorepo#1520)*. Watch-related `event_notification` metadata uses `watchStillArmed` so consumers do not parse note prose: **`false`** on the ungrouped terminal completion-wake path (idle / failed / deleted — the stable-id wake is already durable when transactional settlement retires the persisted watch, and the in-memory watch is removed only after commit), and **`true`** on the **monitoring-idle advisory wake** — grouped and ungrouped alike (advisories never consume a watch, [intent-hq/intent#4254](https://github.com/intent-hq/intent/issues/4254); the wake additionally carries `childExternallyWaiting: true` plus the `waitingOnHooks` / `waitingOnPrMonitors` arrays), on an immediate `agent.reportToParent` progress wake when a matching parent watch exists, on an immediate grouped-failure wake (the grouped watch stays armed for `after_all` settlement), and on attention fan-out wakes to watchers (every active watch since [monorepo#3443](https://github.com/intent-hq/monorepo/issues/3443); attention is not a completion). The flag rides only these watch-related wakes; the direct parent attention wake (§5.5 attention-request flow, step 5) and the `after_all` aggregated group wake are not watch wakes and do not carry it, and other `event_notification` payloads (subscription batches) are untouched.


#### `serve --resume-all` CLI flag

`intentd serve --resume-all` is a headless deployment flag that automatically resumes all interrupted agents at startup without waiting for the `agent.resolveInterrupted` RPC.

**Execution:** After the daemon is fully up (services wired, event bus live, RPC servers listening), a background task enumerates the interrupted set and calls the resume service operation for each pending agent. Per-agent failures are logged (warning-level) and do not crash the daemon or block startup.

**Non-blocking:** The auto-resume sweep is spawned asynchronously; the daemon is ready to serve RPCs before the sweep completes. After the sweep completes, `agent.listInterrupted` returns an empty list.

### 5.36 Agentic usage stats — `stats.getUsage`

The backend owns global **agentic usage stats** (the usage-stats cards). Recording is
daemon-internal: usage aggregates **across all workspaces** into hourly UTC buckets, one row per
UTC hour + normalized model name + resolved agent-provider id. At the end of each prompt turn
the daemon folds in the turn's
**token delta** (the difference between consecutive cumulative end-of-turn snapshots, clamped ≥ 0
per counter — never the raw cumulative report), a `runs` increment (**runs** = completed prompt
turns) and the turn's wall-clock duration MAX'd into the bucket's longest-run counter; agent
**session starts** and agent-attributed **lines added/deleted** (manual/user edits are excluded)
accrue into the same buckets as they happen. Model ids are normalized to one canonical display
name so the same model reached via different hosts lands in one row (`claude-opus-4-8`,
`anthropic/claude-opus-4.8-20260115`, and `Opus 4.8` all → `"Opus 4.8"`; unrecognized ids pass
through, blank → `"unknown"`). This store is independent of the change metrics (§5.20) and token
usage (§5.23) surfaces — clearing those never touches usage stats. Only the **read** crosses the
wire — recording has no RPC (§6.8). `stats.getUsage` is global: it takes **no** `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| stats.getUsage | period (req): "24h" \| "month" \| "year"; key: "YYYY-MM" (req for month) \| "YYYY" (req for year), ignored for 24h; tzOffsetMinutes: integer, minutes east of UTC, default 0, must be within ±840 | UsageStats — -32602 on a bad period/key/tzOffsetMinutes |

**Timezone semantics** — buckets are stored as UTC hour floors alongside a **local wall-clock
stamp** (`local_date` `"YYYY-MM-DD"` / `local_hour` 0–23) captured from the daemon's system
timezone when the bucket row is first inserted (later writes folding into the same bucket keep
the first-writer's stamp). For `month`/`year` periods, period filtering, hour-of-day / month
grouping, and `availablePeriods` follow that recorded stamp, so "1pm" means 1pm on the daemon's
machine **at the moment the activity was recorded** — immune to later DST transitions or
timezone moves. Rows whose stamp columns are NULL (written while the daemon's local offset was
indeterminate; pre-migration rows are backfilled from `bucket_utc` using the timezone in effect
at migration time) or malformed fall back to shifting `bucket_utc` by `tzOffsetMinutes`. The
`24h` period is an **absolute rolling window** — the trailing 24 hourly UTC buckets ending at
the current hour — unaffected by `tzOffsetMinutes` except that per-bucket hour labels are
rendered in local time.

**UsageStats** — `{ totals: UsageTotals, runs, sessions, longestRunMs, linesAdded, linesDeleted,
byModel: ByModelEntry[], byProvider: ByProviderEntry[], byHourOfDay: HourEntry[24],
byMonth: MonthEntry[12], availablePeriods: { months: string[], years: string[] } }`, where
**UsageTotals** is the consumption counters `{ inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, thoughtTokens? }`:

- **totals / runs / sessions / longestRunMs / linesAdded / linesDeleted** — period rollups:
  the token counters, completed prompt turns, agent sessions started, the longest single
  turn in milliseconds (MAX), and agent-attributed line churn.
- **byModel** — `{ model, runs } & UsageTotals` per normalized model name, sorted descending by
  total tokens — the sum of all five counters, `thoughtTokens` included. Safe because the
  stored buckets are **disjoint**: providers whose wire `thoughtTokens` is a subset of
  `outputTokens` (codex, grok) have the subset carved out of `outputTokens` at ingestion
  (intent-hq/intent#3796). Ties break on model name ascending.
- **byProvider** — `{ provider, runs } & UsageTotals` per resolved agent-provider id, sorted
  descending by the same five-counter total-token sum (ties break on provider id ascending).
  The wire carries **raw
  provider ids** (`claude-code`, `codex`, `auggie`, …) — display-name mapping is a client
  concern. Rows recorded before provider attribution existed (pre-migration) — and any usage
  whose provider could not be resolved — aggregate under the id `"unknown"`; there is no
  backfill.
- **byHourOfDay** — exactly **24** entries of `{ hour } & UsageTotals`. For `month`/`year`:
  local hours of day in order (`hour` = 0–23). For `24h`: the 24 trailing hourly buckets in
  **chronological order** (oldest first), each labelled with its local-time `hour`.
- **byMonth** — exactly **12** entries of `{ month } & UsageTotals` (`month` = 1–12) covering
  the period's whole local year, independent of the (possibly narrower) month filter; zeroed
  for `24h`.
- **availablePeriods** — the distinct local `"YYYY-MM"` months and `"YYYY"` years that have any
  recorded usage, sorted ascending, computed over **all** rows regardless of the requested
  period (drives the FE period picker).

Empty periods return zeroed shapes — zero totals, empty `byModel` / `byProvider`, 24 zeroed
hours, 12 zeroed months — never an error.

**`thoughtTokens`** *(additive within v6.2, [intent-hq/intentd#1041](https://github.com/intent-hq/intentd/pull/1041))*
is the cumulative reasoning ("thought") token count — the per-bucket counterpart of the
`TokenUsageTotals.thoughtTokens` counter (§5.23) and the `RateSample.thoughtTokens` counter
(§5.39), persisted in the hourly buckets via the additive defaulted migration
`0087_usage_stats_thought_tokens.sql` (pre-migration buckets read back as zero, exactly like an
hour in which no provider reported reasoning tokens). It is a `u64` in camelCase,
**omitted when zero or unreported** (never a fabricated `0`, never `null`) — on `totals` and on
every `byModel` / `byProvider` / `byHourOfDay` / `byMonth` cell alike — so clients written
against the pre-`thoughtTokens` shape see the previous response byte-for-byte. It aggregates
exactly like the other counters (the same clamped-≥ 0 per-turn delta folded into the same
buckets), and it is **disjoint** from `outputTokens`: providers whose wire report is a subset
(codex, grok) have it carved out of `outputTokens` at ingestion (intent-hq/intent#3796), so it
counts toward the `byModel` / `byProvider` "total tokens" ranking, which sums all five
counters, and clients may sum all five counters freely. Codex buckets recorded before the
ingestion carve-out shipped retain the subset shape (no backfill), so historical codex totals
may over-count reasoning slightly.

```json
// → request
{ "jsonrpc":"2.0","id":94,"method":"stats.getUsage","params":{ "period":"month","key":"2026-07","tzOffsetMinutes":-420 } }
// ← response (arrays elided to the interesting entries)
{ "jsonrpc":"2.0","id":94,"result":{
  "totals":{ "inputTokens":130,"outputTokens":45,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":25 },
  "runs":3,"sessions":1,"longestRunMs":9000,"linesAdded":10,"linesDeleted":3,
  "byModel":[
    { "model":"Opus 4.8","runs":2,"inputTokens":100,"outputTokens":40,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":25 },
    { "model":"Sonnet 5","runs":1,"inputTokens":30,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0 } ],
  "byProvider":[
    { "provider":"claude-code","runs":2,"inputTokens":100,"outputTokens":40,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":25 },
    { "provider":"unknown","runs":1,"inputTokens":30,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0 } ],
  "byHourOfDay":[ { "hour":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0 }, /* … 24 entries … */ ],
  "byMonth":[ { "month":1,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0 }, /* … 12 entries … */ ],
  "availablePeriods":{ "months":["2026-06","2026-07"],"years":["2026"] } } }
```

