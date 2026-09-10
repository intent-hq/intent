> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.10 `event.*` (query/aggregation).

### 5.10 `event.*` (query/aggregation)

These are **historical/aggregate read** helpers — distinct from live streaming (§6). Each requires`workspaceId`.

> **Retention.** The high-volume live-output chunk families (`terminal:data`, `script:output`,
> `host:exec:stdout` / `host:exec:stderr`) are **transient / broadcast-only** (same publish path
> as `chat:stream:delta` / `agent:stream:activity`, §7): they are never written to the event table, so §5.10 historical
> reads never see them — replay comes from the owning buffer (`terminal.getBuffer` /
> `script.output`), not from events. Persisted events are pruned by the daemon's retention
> loop: the high-volume ephemeral families (`agent:stream:*`, `file:*`, plus rows of the
> now-transient chunk families persisted by older daemon versions)
> and the high-churn state-notification families (`workspace:updated`, `draft:changed`,
> `agent:status-changed`, `agent:idle`, `agent:subscriptions-changed`, `settings:changed`,
> `workspace:tokenUsage-changed`, `agent:queue:updated` — exact types; consumers take these from
> the live stream (§6) and rehydrate current state from the owning resource, never from history)
> per the stream-retention window (`events.streamRetentionHours` setting, default **72h**; `0` disables
> the sweep; `INTENTD_STREAM_RETENTION_HOURS` env override), and `agent:tool:call` rows on a
> fixed **6h TTL**. Additionally, the **persisted** `data_json` of an `agent:tool:call` event is
> capped at **16 KiB**: an over-cap payload has its free-form fields (`output`, `input`,
> `registeredAttachments`) replaced with `{ truncated: true, originalBytes, preview }` (preview =
> first 2 KiB of the field's serialized JSON) before the row is written — the live broadcast (§6/§7)
> always carries the FULL payload; only the §5.10 historical reads see the capped copy.
> Historical reads only see rows within these windows; lifecycle/audit
> families (`workspace:created`/`deleted`/`archived`, `agent:created`/`deleted`/`completed`/`failed`,
> note/task/comment/git events, ...) are not swept. The loop also reclaims freed pages via
> bounded `PRAGMA incremental_vacuum` on incremental-auto-vacuum databases. Legacy databases
> created with `auto_vacuum=NONE` are converted automatically: the daemon's write connection
> sets `PRAGMA auto_vacuum=INCREMENTAL` at connect (inert on an existing NONE-mode file by
> itself), and a one-time `VACUUM` at daemon startup rebuilds the file to apply it, so space
> reclamation applies to all databases.

> **`file:*` hybrid persistence** ([intentd#951](https://github.com/intent-hq/intentd/pull/951)).
> `file:changed` / `file:created` / `file:deleted` events are only written to the event
> table when agent-attributed (`ActorType::Agent`) — these back `event.agentActivity` and
> `event.workspaceSummary`. Watcher-observed (system/user) `file:*` events are
> **broadcast-only**: delivered live over the streaming channel (§6) with no SQLite write,
> so they are not queryable historically via `event.query` or any other §5.10 method.

| Method | Params | Result |
| --- | --- | --- |
| event.agentActivity | agentId?, minutesAgo? | activity events |
| event.workspaceSummary | minutesAgo? | aggregated activity summary |
| event.query | workspaceId (req), filter opts (eventType?, actorType?, actorId?, path?, minutesAgo?, limit?), paginate?: boolean, nextToken?: string | matching events — **legacy shape** (bare array, newest→oldest) when pagination is not engaged; **paginated envelope** `{ items, nextToken }` when either `paginate: true` or a `nextToken` is supplied (opt-in). `nextToken` is an opaque cursor for the next older page (`null` on the last page); pass it back as `nextToken` to fetch the next page. `limit` is clamped by the pagination policy when engaged. `eventType` accepts the **same glob syntax as `event.subscribe`** ([intentd#938](https://github.com/intent-hq/intentd/pull/938)): bare `*` = no type filter, `prefix:*` = category prefix match (e.g. `note:*` matches `note:created` / `note:updated` / `note:deleted`), anything else = exact match; matching is **case-sensitive** (`NOTE:*` matches nothing), mirroring subscribe's `starts_with` semantics — a `prefix:*` compiles to an index-served half-open range scan, not a `LIKE`, so `%` / `_` in a pattern are literal bytes. **Responses are size-bounded** ([monorepo#3347](https://github.com/intent-hq/monorepo/issues/3347)): when the row set would serialize past a ~700 KiB budget (sized so a full response stays below the daemon's internal 1 MiB large-frame warn threshold — a log-only diagnostic, far under the 40 MiB hard cap of §1.3), rows are walked in wire order (newest→oldest) with a running fair-share budget, and over-share rows have their unbounded fields (`data`, `metadata`, `actor`, session/correlation/parent ids) replaced by bounded structure-preserving previews — escaping-aware, so the bound holds on serialized bytes — plus **additive row-level markers** `truncated: true` and `originalBytes` (the row's full serialized size). The bounded scalar identity fields (`id`, `workspaceId`, `type`, `timestamp`, `actor.type`), row shape, and row count are always preserved (no silent row loss), and under-budget responses are byte-identical to the uncapped form. Applies to both response shapes; `nextToken` is unaffected by trimming. The **legacy (non-paginated) `limit` is clamped to [1, 500]** (default 50; previously unclamped — a negative value meant "no limit" in SQL); the paginated path keeps its [1, 200] clamp. |
| event.subscribe (deprecated) | eventTypes (req, array), excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — use events.subscribe for WS streaming. Shares the one real subscription implementation with the `agent.subscribe` alias of §5.5 (matching, batching, subscriber wakes, restart persistence) — **including the [monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229) agent-subscriber restriction** (explicit `agent:`-prefixed types and `chat:stream:delta` rejected atomically with `-32602`; bare `*` silently narrowed to the non-agent categories; match-time `exclude_agent_events` guard on rehydrated legacy rows — see the §5.5 row); over the MCP seam the subscriber is the calling agent, so `ws.event.subscribe` callers are directed to `ws.agent.watch(agentId)` for agent monitoring. Note: the singular `event.subscribe` / `event.unsubscribe` methods are NOT routable on the wire (MCP bindings only) — wire callers use the `agent.subscribe` alias. |
| event.unsubscribe (deprecated) | subscriptionId (req) | service result `{ ok: true, subscriptionId }` — stops delivery; unknown id errors |

