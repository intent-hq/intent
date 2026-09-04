> Part of the [Intent JSON-RPC protocol docs](./README.md) — §7 Agent Streaming.

## 7. Agent Streaming

Agent assistant output is delivered as the `agent:stream:*` event family (subscribe with `events.subscribe(["agent:stream:*"])`, optionally scoped by `workspaceId`). Note that tool-call activity is emitted as `agent:tool:call`, which the `agent:stream:*` filter does **not** match — a client that wants the full live turn (liveness + tool calls) subscribes with `["agent:stream:*", "agent:tool:call"]`. The backend maps a provider's streaming signals to these canonical event types.

**`agent:stream:chunk` → `agent:stream:activity` ([intent-hq/intentd#775](https://github.com/intent-hq/intentd/pull/775)), enriched with live-preview fields ([intent-hq/intentd#792](https://github.com/intent-hq/intentd/pull/792)).**
The externally-broadcast per-chunk event is renamed `agent:stream:activity` and **no longer
carries the per-chunk transcript delta** (the incremental `content` firehose): its payload is
`{ agentId, messageId, lastAgentResponse?,
digest?, lastToolUse? }` — a liveness signal (busy tick / stall timestamps / watched-agent refresh hints)
enriched with **server-derived live-preview fields** so a client tracking an agent's progress
(workspace cards, watched-agent footers, iOS previews) renders a live preview push-style
without an `agent.get` refetch on every tick. `lastAgentResponse` is the trailing slice —
**capped at 500 chars**, prefixed with `...` when truncated — of the turn's streamed-so-far
text blocks **clipped at the last completed newline**
([intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795)): the still-streaming
trailing partial line is excluded until it completes, so mid-turn frames never surface a
partial sentence. `digest` is the parsed digest span, derived from the **unclipped** text —
its capture requires the closing `</agent_digest>` tag, so a fully-streamed digest surfaces
immediately while an unclosed opener is stripped to end-of-text and a partial span never
leaks. Both fields use the same extraction as the §5.5 `AgentLite` live-turn preview overlay
([intent-hq/intentd#786](https://github.com/intent-hq/intentd/pull/786)), which mid-turn
applies the same newline clipping to `lastAgentResponse` (and, likewise, none to `digest`);
each field is **omitted** (never an empty string) until derivable, so a
turn that has streamed no completed line / no digest yet carries neither and clients keep
their previous preview. The content-bearing
per-chunk payload lives on the **internal** `chat:stream:delta` event (§6.5), deliberately
outside the `agent:*` family so `events.subscribe` firehose subscribers (`agent:*`,
`agent:stream:*`) never receive the raw transcript firehose — the §7.1 `chat.subscribe`
forwarder tails it unchanged, so the snapshot+delta flow is unaffected. `agent:stream:activity` is
**leading-edge throttled per agent**: the first activity of a turn emits immediately (preserving
the FE's pre-first-token status-hint clearing latency, §6.5 `agent:stream:status`), then at
most one emission per **1 s** per agent; the throttle state lives in the live-turn slot, so it
resets on stream end/failure/interrupt and the next turn's first activity is again immediate.
The event is emitted from **both** the assistant-text-chunk arm and the tool-call arm
([monorepo#1414](https://github.com/intent-hq/monorepo/issues/1414)), sharing that ONE window —
so on a tool-first turn the leading-edge ping (the one that clears the §6.5 status hint) can
arrive from a tool call **before any assistant text has streamed**, carrying `lastToolUse` and
no `lastAgentResponse`.
Both events remain **transient** (broadcast-only, never persisted). The legacy
`agent:stream:chunk` name is gone from both sides of the wire: no current client handles it
([intent-hq/cloudlands-fe#579](https://github.com/intent-hq/cloudlands-fe/pull/579) dropped the
FE compat path; [intent-hq/ios#66](https://github.com/intent-hq/ios/pull/66) dropped the iOS
activity-ping refetch fallback in favor of applying the preview payload directly).

The backend emits the **four** streaming signals in the table below in production. A fifth
event — `agent:stream:status` (§6.5), carrying both the pre-first-token startup hints and
the mid-turn `stalled` / `resumed` liveness advisories (additive within v7.4,
[intent-hq/intentd#1462](https://github.com/intent-hq/intentd/pull/1462): one advisory
`phase: "stalled"` event with the additive `silentMs` field after the stall threshold —
default 5 minutes (300000 ms), `INTENTD_STREAM_STALL_MS` — of zero `session/update`
traffic mid-turn (tool-call-aware per
[intent-hq/monorepo#3466](https://github.com/intent-hq/monorepo/issues/3466): while ≥1
recorded tool call is still open the advisory is fully suppressed regardless of silence
duration — long tool runs are expected silence, with the 30-minute prompt idle timeout as
the backstop for hung tools; once the last open call resolves, the standard threshold
applies to subsequent silence), then
`phase: "resumed"` when activity returns, re-arming the detector; advisory only, the turn
is never cancelled) — also matches the
`agent:stream:*` subscription filter and arrives on the same subscription, so clients
subscribing to the family should expect it on the wire too (it is documented in §6.5, not
repeated in the table below; note the converse quirk that `agent:tool:call`, which **is** in
the table, does *not* match the filter and must be subscribed explicitly). The formerly reserved
`agent:stream:content-blocks` / `agent:stream:message` / `agent:stream:tool_use` /
`agent:stream:tool_result` constants were never emitted and have been **removed** from the
taxonomy and `ALL_EVENT_TYPES` ([intent-hq/intentd#756](https://github.com/intent-hq/intentd/pull/756)).

**Emitted today:**

| Provider signal | Event type | data payload |
| --- | --- | --- |
| turn start (agent-initiated turns **only**) | agent:stream:start | { agentId, messageId, reason: "harness-wake" } — emitted when the daemon opens an **implicit agent-initiated turn** for an out-of-turn `session/update` burst (§6.6; [intent-hq/monorepo#855](https://github.com/intent-hq/monorepo/issues/855)). `messageId` is the assistant messageId minted for the wake turn (the same id carried by the turn's `chat:stream:delta` / `agent:stream:activity` / `agent:tool:call` events and — when the turn persists one — the persisted assistant row; a no-content wake turn skips persistence and its `agent:stream:end` omits `messageId`, §6.6). `reason` is `"harness-wake"` — the only value today. **Prompt (user-initiated) turns never emit this event**: its absence is the normal case, not an error |
| text token(s) **or tool call** — liveness signal | agent:stream:activity | { agentId, messageId, lastAgentResponse?, digest?, lastToolUse? } — liveness tick ([intent-hq/intentd#775](https://github.com/intent-hq/intentd/pull/775); renamed from `agent:stream:chunk`), leading-edge throttled per agent (first activity of a turn immediate, then ≤1/s; see the rename block above). **Emitted from BOTH the assistant-text-chunk arm and the tool-call arm** ([monorepo#1414](https://github.com/intent-hq/monorepo/issues/1414)), sharing the ONE per-agent throttle window — so a tool-heavy stretch that streams no assistant text keeps ticking (a watched-agent row no longer freezes at the turn's last text), while a turn mixing text and tool calls still emits at most one ping per second regardless of which arm opens the window. A tool-arm ping additionally carries `lastToolUse` = `{ name, status }` for the call just recorded — `name` the same derived real tool name as `agent:tool:call`'s `toolName`, `status` the same normalized `started` \| `completed` \| `error` word — **omitted entirely on text-chunk pings** (never `null`); it is a rendering hint, the canonical tool signal remains `agent:tool:call`. Both arms stamp the same server-derived live-preview fields ([intent-hq/intentd#792](https://github.com/intent-hq/intentd/pull/792)): `lastAgentResponse` = trailing ≤500 chars of the streamed-so-far text blocks clipped at the last completed newline (trailing partial line excluded — [intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795); `...`-prefixed when truncated), `digest` = the parsed digest span, derived from the **unclipped** text (its capture requires the closing tag) — same extraction as the §5.5 live-turn overlay; each field **omitted until derivable** (no completed line / no closed digest yet; never an empty string). Streamed reasoning never contributes to either field: `thinking` blocks (§7.1, additive within v6.0 — [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973)) and a pending thought buffer are excluded from the preview derivation. The raw incremental text itself flows on the internal `chat:stream:delta` event — `{ agentId, content, messageId, blockIndex, blockId, blockType, streamId? }`, enriched with the §7.1 block-identity fields (`blockType` is `"thinking"` on reasoning chunks) — which is outside the `agent:*` filter family and consumed by the §7.1 `chat.subscribe` forwarder |
| tool call | agent:tool:call | { agentId, toolName, title, toolKind, toolCallId, input, status, output?, messageId, blockIndex, blockId, resultBlockIndex?, resultBlockId?, proposalBlockIds?, registeredAttachments? } — the single tool signal; `toolName` is the **real** tool name derived from the ACP title (`intent-acp::session::derive_tool_name`), `title` the raw human-readable ACP title; for a **known** `toolCallId`, sparse `tool_call_update` fields (`title`/`toolName`/`toolKind`/`input`) are backfilled from the per-call transcript state before the event is published (§7.1, [intent-hq/intentd#551](https://github.com/intent-hq/intentd/pull/551)); `blockIndex`/`blockId` identify the `tool_use` block, and `resultBlockIndex`/`resultBlockId`/`proposalBlockIds` the `tool_result` and standalone proposal-resource blocks the SAME update materialized in the durable transcript — each present only once its block exists (a `started` or output-less update carries none), so the §7.1 `chat.subscribe` delta path stamps the real persisted ids instead of predicting them ([monorepo#2029](https://github.com/intent-hq/monorepo/issues/2029)); `registeredAttachments` is the claimed §7.1 `AtToolResult` canonical block batch, present only when the completed call claimed registered blocks (so the live `chat.subscribe` delta path attaches the SAME blocks the persisted transcript does); §7.1 `chat.subscribe` tails it to synthesize `tool_use` / `tool_result` blocks |
| complete or error | agent:stream:end | { agentId, stopReason?, finishReason?, interruptReason?, interruptedBy?, messageId?, trailingBlocks?, turnId?, lastAgentResponse?, digest? } — the turn-worker terminal emit (`agent_session.rs` `run_prompt_turn`) covers **both** normal completion **and** error-terminated turns and additively carries ([monorepo#732](https://github.com/intent-hq/monorepo/issues/732), [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)): `messageId` — the turn's assistant message id, present whenever the turn persisted an assistant message (set only **after** the successful store append, so the event can never advertise a row that was never written); and `trailingBlocks` — the drained §7.1 `AtTurnEnd` resource blocks (e.g. `ws.app.question.ask` question blocks) in registration order, **byte-identical** to the trailing blocks of the persisted message, **omitted** when none were drained. `finishReason` — the **abnormal finish reason**: present only when the turn completed with a non-`end_turn` ACP stop reason (`refusal` \| `max_tokens` \| `max_turn_requests`), carrying that stop reason verbatim; omitted on normal (`end_turn`) completions, error-terminated turns, and every non-turn-worker emit site — never `null`. When the turn persisted an assistant row, the same value is durably tagged on that row as `metadata.finishReason` (§7 transcript metadata), so a reloading client can render the ending without having seen this event. An abnormal finish reason is still a **completion** (`agent:idle` follows with its existing lifecycle `finishReason` field; no `agent:failed`); distinct from the interrupt path's `stopReason: "interrupted"` below. The two fields are not independently optional in one direction: `trailingBlocks` is a trailing slice of the persisted message's blocks, so its presence **implies** `messageId` is present (a client always has the id to associate the blocks with); the converse does not hold — `messageId` routinely appears without `trailingBlocks`. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) — the turn correlation id naming the logical turn this event closes (the same id the send/enqueue RPC returned, §5.5/§6.6), stamped on both the complete and error arms; omitted when the turn carries none, never `null`. **Final live-preview values ([intent-hq/intentd#792](https://github.com/intent-hq/intentd/pull/792)):** every transcript-bearing terminal emit — the turn-worker emit, the interrupt flush, and the harness-wake finalize — also stamps `lastAgentResponse?` / `digest?` re-derived from the turn's full streamed text (same fields, same ≤500-char cap, and same omit-until-derivable rule as the throttled `agent:stream:activity` frames above — but with **no newline clipping**: [intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795) clips only mid-turn frames, so the terminal emit carries the turn's true final text including any unterminated last line), so a client tracking the preview push-style lands on the turn's true final state without an `agent.get` refetch. The not-surfaced-by-streaming failure path (`publish_terminal_failure_events`, e.g. spawn-retry exhaustion) emits `{ agentId, turnId? }` — the same `turnId` as its paired `agent:failed`, and no preview fields (nothing streamed); the daemon never emits `content` or `streamId` on this event. The **user-interrupt path** (§7.2) additionally carries `stopReason: "interrupted"` and `interruptReason` (within v4.5, [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919): on the wire only ever `"user_stop"` \| `"preempted_by_message"` — the interrupt emit comes solely from the live-session interrupt path; the `"daemon_shutdown"` / `"agent_stopped"` teardowns flush the interrupted row without emitting this event, so those reasons appear only in row metadata (§7.2). Always present on the interrupt emit: it matches the persisted row's `metadata.interruptReason` when a row exists (`messageId` present) and is still stamped from the interruption cause when no row was persisted (`messageId` absent)), plus `interruptedBy` (only on `"preempted_by_message"` with an attributable sender: `{ kind: "user" }` or `{ kind: "agent", agentId, name? }` — §7.2), plus `messageId` when an interrupted assistant row was persisted (the id of that row — with the v4.5 always-persist marker-row semantics that is every emitting-path interrupt that found a registered live-turn slot, zero-output turns included; §7.2) and the preview fields derived from the flushed partial turn — but deliberately **no** `trailingBlocks` (the `AtTurnEnd` registry is not drained on the interrupt path; pending entries wait for the next turn's drain / the registry TTL) and no `turnId` (the interrupt emit is a manager-side flush, not the turn worker's terminal). The interrupted shape is **not** unconditional on this path ([intent-hq/intentd#1720](https://github.com/intent-hq/intentd/pull/1720)): when the interrupt flush collides with the turn's already-persisted **completed** row, the same `interrupt_inner` emit takes the normal-completion shape — `messageId` = that row's id, no `stopReason` / `interruptReason` / `interruptedBy` (§7.2 "Interrupt racing a completed turn"). Normal-completion, error, and harness-wake emits never carry `interruptReason` / `interruptedBy` (absent, never `null`). The **harness-wake turn finalize** (`agent_session.rs` `run_harness_wake_turn`, §6.6) is a fourth emit site: its payload is `{ agentId, messageId?, lastAgentResponse?, digest? }` — `messageId` present iff the wake turn persisted an assistant row, and **never** `trailingBlocks` (the wake path performs no `AtTurnEnd` drain; only `run_prompt_turn` does) or `turnId` (agent-initiated turns have no user retry record). A **prompt idle-timeout** turn ([intentd#741](https://github.com/intent-hq/intentd/pull/741), §6.6 warn-and-continue) closes through the ordinary turn-worker emit with a payload indistinguishable from a normal completion — `messageId` iff a partial assistant row was flushed (a fully silent turn carries none), `turnId` of the timed-out turn, no `stopReason` — and is followed by the persisted `[SYSTEM WARNING]` user row + redriven warning turn instead of `agent:failed` / `agent:idle`, until the consecutive-timeout cap is spent (§6.6) |

Structured consumers should prefer the §7.1 `chat.subscribe` channel (the canonical structured
transcript) over reconstructing turn state from the firehose.

Notes for client implementers:

- **Ordering.** Events for one agent arrive in emission order over a single connection. Correlate a stream with `data.agentId` (and `data.streamId` when present). Tool-call activity arrives as the single `agent:tool:call` event interleaved with the `agent:stream:activity` liveness ticks (and, on the internal chat channel, `chat:stream:delta` text); the §7.1 `chat.subscribe` channel synthesizes ordered structured blocks from these signals.
- **Agent-initiated turns.** A stream may begin with **no user send**: `agent:stream:start { agentId, messageId, reason: "harness-wake" }` announces an implicit agent-initiated turn (§6.6). Clients should open the same streaming UI as a user-initiated turn — spinner/busy state, active Stop/interrupt, autoscroll, live transcript — just with no user message row above it. A send racing an active wake turn auto-queues via the normal busy path and streams after the wake turn's `agent:stream:end`.
- **Terminal event.** `complete` and `error` are mutually exclusive and **both** map to `agent:stream:end` — there is exactly one terminal event per stream. The complete/error payloads are identical by design — both carry the additive `messageId` / `trailingBlocks` fields under the same conditions (the §7.1 `AtTurnEnd` drain deliberately runs on the error path too); the **user-interrupt** terminal emit alone adds `stopReason: "interrupted"` + `interruptReason` (and `interruptedBy` on message preemption; + `messageId` when an interrupted row was persisted — §7.2, never `trailingBlocks`), letting clients render a live, reason-specific "Stopped" indicator without a transcript re-fetch. A **harness-wake** turn's terminal emit carries `messageId` when the wake turn persisted a row and never `trailingBlocks` (§6.6; see the `agent:stream:end` row above). A client treats `stream:end` as "this turn is done" and then re-fetches the authoritative transcript via `agent.getConversation` if it needs the final, persisted message — though `trailingBlocks` lets it append the turn-end attachments to the finalized in-flight message immediately, without waiting on that re-fetch. A client that does both must not double-render: `trailingBlocks` are byte-identical to the persisted message's trailing blocks, so on re-fetch the client **replaces** the finalized in-flight message (keyed by `messageId`) with the persisted one rather than merging block lists.
- **Dedup.** The same agent output is also persisted; the live `chat:stream:delta` text (and its `agent:stream:activity` liveness ticks) is *incremental UI sugar*. Canonical state is the persisted conversation. After `stream:end` (or on reconnect) call `agent.getConversation` rather than reconstructing solely from chunks. User messages echo cross-client as the user-row `agent:message` event (`role: "user"`, carrying a stable `messageId` — §6.5/§6.6; `agent:user-message:sent` is reserved-but-unused) so other clients can de-dupe their own optimistic insert.
- **Sending input.** Use `agent.sendMessage` (auto-queues if the agent is mid-stream; with `priority: "interrupt"` it instead preempts the turn keep-alive and streams immediately — duplicate interrupt delivery with the same `messageId` is absorbed idempotently, and an interrupt landing during turn startup queues keep-alive instead of preempting), `agent.queueMessage` to explicitly enqueue, or `agent.sendQueuedMessageNow` to atomically pull one already-queued entry and deliver it immediately with interrupt priority (the rest of the queue is preserved). `agent.stop` cancels an in-flight stream. Note the wire default for an omitted `priority` is queue-if-busy; the agent-facing `ws.agent.send` / `ws.agent.sendToTask` MCP bindings instead resolve an omitted `priority` to `"interrupt"` (A2A sends interrupt by default; explicit `priority: "queue"` opts back into queue-if-busy — behavior only, within v7.0, [intentd#1292](https://github.com/intent-hq/intentd/pull/1292); §5.5).

### 7.1 `chat.subscribe` — structured live transcript channel *(new in intentd)*

The `agent:stream:*` firehose (above) stays UI sugar (§10.1): a joiner that misses earlier chunks
cannot reconstruct the turn, and the client must re-fetch `agent.getConversation` after every
`stream:end`. `chat.subscribe` is the **canonical** alternative — an **agent-scoped** channel on the
snapshot+delta subscription engine (§6.9) that delivers a self-healing transcript a thin client
can render directly, with **no follow-up fetch**. It **coexists** additively with the firehose: both
observe the same bus, and `events.subscribe(["agent:stream:*"])` is unchanged.

- **Methods:** `chat.subscribe` / `chat.unsubscribe`, intercepted on the subscription fast-path
  before the JSON-RPC dispatcher (like `events.subscribe`). `params` is
  `{ agentId, sinceMessageId?, deltaEncoding?, projection? }` — a missing/empty `agentId` is a
  `-32602` error.
  `chat.subscribe` returns `{ subscriptionId }`, then
  pushes a seq-0 `subscription.push` **snapshot**, then ordered **deltas** (seq 1, 2, …).
  `replaceGroup` (atomic swap) and per-connection cleanup behave as for the other channels (§6.1).
- **Slim projection (the wire default since v8.0; introduced opt-in within v7.1 —
  [intent-hq/intentd#1304](https://github.com/intent-hq/intentd/pull/1304)).** Every
  subscription serves the same bounded tool/image block projection as
  `agent.getConversation` (§5.5): oversized `tool_use.input` / `tool_result.output` bodies are
  replaced by bounded previews with additive `inputTruncated`/`outputTruncated` + `*Bytes` flags
  (pairing/structural fields intact), and oversized `image.data` is swapped for the write-time
  thumbnail (`dataTruncated`/`dataIsThumbnail`/`dataBytes`; legacy pre-thumbnail rows serve the
  block with `data` omitted). The projection is fixed for the subscription's lifetime and applies
  to **every frame the subscription emits** — the seq-0 snapshot, lag-recovery snapshots, live
  tool-block deltas, and the seq-0 live-turn merge — so slim snapshots and deltas agree on the
  served block shape. Absent / `null` selects slim (the v8.0 default, BREAKING over the v7.1
  "byte-identical" opt-in contract) and `projection: "slim"` is an explicit no-op; any other
  value is `-32602`, never coerced. A client holding a truncated
  slim block fetches the full body on demand via `agent.getMessageBlock` (§5.5, v7.2). Slim
  snapshots additionally inherit the **slim page byte budget** (within v7.2 —
  [intent-hq/intentd#1314](https://github.com/intent-hq/intentd/pull/1314)): the seq-0 and
  lag-recovery snapshots reuse the `agent.getConversation` read, so a snapshot page is bounded
  at `SLIM_PAGE_BUDGET_BYTES` (512 KiB) total serialized message bytes and may carry fewer than
  `limit` messages, with `nextToken` re-minted at the first excluded row (§5.5) — the client
  pages older history exactly as before, just in more round-trips. The budget covers the
  live-turn merge too: after the in-flight message is appended it anchors as the newest row
  (always served, even alone over budget — the §5.5 one-message floor), and oldest persisted
  rows are evicted until the merged page fits, with `truncated`/`nextToken` re-minted at the
  eviction boundary so the evicted rows stay reachable via `agent.getConversation`.
- **Resume via `sinceMessageId` (additive within v6.4).** A reconnecting client that already
  holds the transcript up to a known message id may pass it as the optional `sinceMessageId`
  (string). Absent / `null` / `""` all mean "no resume" — the standard snapshot below, carrying
  **no** `resumed` key at all; a present non-string value is a `-32602` error. When provided,
  the daemon reads the **same bounded newest page** as the standard snapshot (still exactly one
  conversation read — resume is a post-filter, never a second fetch; monorepo#958 cost contract)
  and then:
  - **Id found in the page** → the seq-0 snapshot's `messages[]` carries only the messages
    **after** that id (possibly empty when the id is the newest row), with `resumed: true`,
    `truncated: false`, and `nextToken: null` — no gap exists toward older history, the client
    already holds everything up to `sinceMessageId`, so no older-pages cursor is served.
    `totalMessages` stays the transcript-wide count (same semantics as the standard snapshot,
    where `messages.length` already ≠ `totalMessages` on a truncated page).
  - **Id not in the page** (unknown, pruned, or older than the bounded newest page —
    indistinguishable without an unbounded lookup, which the bounded-read contract forbids) →
    the **standard full page** is served unchanged (`truncated` / `nextToken` intact) with
    `resumed: false`: the client MUST discard its cached transcript and rehydrate from this
    snapshot as if it had subscribed fresh.
  The live-turn slot merge (in-flight or orphaned, below) and the activity-flags overlay apply
  identically in both cases, **after** the filter — a merged partial is never trimmed away.
  Deltas (seq 1, 2, …) are unaffected by resume.
- **Incremental delta encoding via `deltaEncoding` (opt-in, within v7.0;
  [intent-hq/intentd#1289](https://github.com/intent-hq/intentd/pull/1289),
  [monorepo#2675](https://github.com/intent-hq/monorepo/issues/2675)).** The optional
  `deltaEncoding` param selects how the subscription's live `text`/`thinking` chunk deltas encode
  their content. Absent / `null` / `"full"` select the default full-text mode — byte-identical to
  the pre-#2675 wire shape, where each growth re-carries the FULL accumulated `text` (O(accumulated
  text) per chunk, quadratic wire cost over a turn). `"incremental"` switches those deltas to
  append-only fragments: each entity's block carries only the new fragment as `textDelta`
  (`{ type, id, textDelta }` — never accumulated `text`), and the client appends fragments for the
  same block `id` in seq order (O(chunk) per delta, O(N) per turn). Any other value is a `-32602`
  error, never silently coerced. The encoding is fixed for the subscription's lifetime and applies
  **only** to live `text`/`thinking` chunk deltas — tool blocks, non-assistant row deltas, and the
  terminal reconcile are encoding-independent and carry full blocks in both modes, so the terminal
  frame's authoritative full `text` (never `textDelta`) keeps `stream:end` a per-turn convergence
  checkpoint under either encoding (the degraded best-effort terminal frame is likewise full-text),
  and the §7.1 invariant — seq-0 snapshot reduced with every delta equals a fresh
  `agent.getConversation` — holds with the reducer extended by one rule: a `textDelta`-bearing
  entity **appends** to the identified block's text instead of replacing it — where an `added`
  fragment (the block's first chunk, so no block exists yet) creates the block from the entity's
  `{ type, id }` with text equal to the fragment, i.e. an append onto the empty string, and an
  `updated` fragment appends to the block already known from an earlier delta or the snapshot.
  **Snapshot echo:**
  every snapshot an incremental subscription emits — the seq-0 snapshot AND any lag-recovery
  snapshot — carries `deltaEncoding: "incremental"` at the snapshot's top level, so the client can
  assert the daemon honored the mode before applying the append reducer. Full mode stamps nothing
  (default subscriptions stay byte-identical to the pre-#2675 shape), and an older daemon ignores
  the unknown param and stamps no echo, so a client that sees no echo MUST reduce full-text —
  the echo, not the request, decides the reducer. **Mid-turn
  (re)subscribe composes:** the snapshot's merged in-flight message carries the text accumulated so
  far, and subsequent deltas carry only post-snapshot fragments (in the `updated` bucket — the
  block is already known), so the client appends after the snapshot prefix; no streamed text is
  ever re-delivered. **Backpressure conflation stays lossless:** when the connection writer falls
  behind, buffered same-block chunk deltas conflate — full mode by latest-entity-wins (each entity
  already carries the full text), incremental mode by **concat-merge**: the buffered fragments
  compose in arrival order onto one pending entity's `textDelta` (associative appends — exactly as
  lossless), capped at 256 KiB per merged entity; a merge that would exceed the cap is refused, the
  pending entity seals in place, and the newer fragment starts a fresh entity (seq order
  preserved — the client simply applies more appends). Tool calls, terminal reconciles, and
  message-row deltas are conflation barriers in both modes, so a conflated fragment run never
  crosses an authoritative frame.
- **Snapshot granularity = messages; delta granularity = blocks.** The seq-0 snapshot is the newest
  `agent.getConversation` page as the `messages[]` object (the same read shape, reused verbatim).
  Each subsequent delta upserts individual **content blocks** within a message.
- **`thinking` blocks (streamed reasoning; additive within v6.0,
  [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973)).** ACP
  `agent_thought_chunk` updates accumulate into `{ type: "thinking", id, text }` content blocks —
  a first-class block kind alongside `text` / `tool_use` / `tool_result` / `resource`, persisted
  on the assistant message and **interleaved in stream order** with the other blocks. They share
  the assistant text coalescing buffer: consecutive thought chunks merge into ONE `thinking`
  block, and a thought↔text switch (either direction) closes the open block and opens a new one —
  so thought → text → thought persists three blocks. Live deltas carry them with
  `blockType: "thinking"` on `chat:stream:delta` (§6.5) and accumulate exactly like text chunks
  (`added` on first chunk, `updated` carrying the full reasoning so far in the default full-text
  encoding; under `deltaEncoding: "incremental"`, above, thinking chunks carry append-only
  `textDelta` fragments exactly like text chunks — the two block kinds always share one encoding),
  under the same stable `{messageId}:{blockIndex}` ids — so snapshot plus reduced deltas agree
  byte-for-byte with a fresh fetch as for every other block. Clients that do not render reasoning
  should ignore unknown block types as usual.
- **Reasoning never feeds the live previews.** Thought text is excluded from the server-derived
  `lastAgentResponse` / `digest` preview fields (§5.5 live-turn overlay, `agent:stream:activity`
  and the terminal `agent:stream:end`, §7) and from text-block extraction generally: `thinking`
  blocks are skipped by the block filter, and a still-pending thought buffer is neither appended
  to the preview input nor counted as an open final text block. A turn that has streamed only
  reasoning so far therefore carries no preview fields yet.
- **Stable block ids.** Every assistant block carries a synthetic `id` of `{messageId}:{blockIndex}`
  (the assistant message UUIDv7 minted at turn start + the 0-based index in the coalesced block
  array). Snapshot blocks and live deltas derive the same id, so deltas patch the snapshot exactly.
  Non-assistant blocks carry the same stable synthetic `{messageId}:{index}` id: rows persisted
  id-less get it stamped at serve time by `agent.getConversation` (§5.5;
  [monorepo#1114](https://github.com/intent-hq/monorepo/issues/1114),
  [intent-hq/intentd#781](https://github.com/intent-hq/intentd/pull/781)), so **every** block on
  the channel — snapshot or delta, any role — is id-bearing.
- **Mid-turn (re)subscribe.** When the daemon's **live-turn slot** holds a message the page does not
  already contain, the seq-0 snapshot appends it as a synthetic `assistant` message whose
  `contentBlocks` are the slot's current partial blocks, so a subscriber arriving mid-turn renders a
  coherent partial rather than a gap. On the normal path — a worker still holding the turn's busy
  claim — that message carries `isStreaming: true`, and the terminal delta clears it to
  `streamingComplete: true`. The append is idempotent against the page: once the turn's message has
  persisted, its id is already present and the slot is skipped, so a snapshot taken in the window
  between the store append and the slot clear never duplicates the row.
- **Orphaned slots are served, not hidden (`isStreaming` is derived, not a merge gate;
  [monorepo#2104](https://github.com/intent-hq/monorepo/issues/2104),
  [intent-hq/intentd#1161](https://github.com/intent-hq/intentd/pull/1161)).** The agent's busy
  claim decides the merged message's `isStreaming` flag, **not** whether the merge happens: a
  **populated** slot is merged unconditionally, with `isStreaming: false` when no worker holds the
  turn. So a client can legitimately receive a **settled, non-streaming** assistant message sourced
  from the live-turn slot — a slot whose turn is over still holds real output the user watched
  arrive. In practice that is the §7.2 interrupt flush failing on a non-UNIQUE store error, where
  the daemon deliberately keeps the slot because it is the **only** copy of the streamed content
  (a mid-turn crash normally clears its own slot as the turn guard drops, so it publishes nothing
  to merge). The invariant that survives is the narrower one the gate actually existed for: an
  orphaned slot never claims to be streaming. What a client should expect:
  - An **empty** orphan slot is skipped entirely — a turn that died before streaming anything
    contributes no blank assistant row. An empty slot belonging to a *live* turn is still merged: a
    turn that has only just begun legitimately has no blocks yet, and the client needs its id to
    reconcile the deltas that follow.
  - A merged message with `isStreaming: false` receives **no further deltas** — nothing is coming
    for a dead turn — and it is not necessarily durable: the flush-failure case is precisely one the
    store rejected, so a later `agent.getConversation` may not contain it, and the row disappears
    from subsequent snapshots once the agent's next turn replaces the slot or the daemon restarts
    (slots are not otherwise time-expired). Render it as final content; do not treat it as a row to
    reconcile against or as evidence the transcript persisted it.
  - The activity flags below stay **busy-gated**, so an orphan-sourced message normally arrives
    alongside `isResponding: false`, `turnInFlight: false`, and `lastStreamActivityAt: null`. It is
    `isStreaming` **on the message**, not the flags, that distinguishes a live partial from a
    rescued one — and the two agree by construction: both derive from the same busy read.
  - The snapshot reads the busy claim **before** the slot, and a new turn's claim clears a slot that
    outlived its turn *before* publishing the claim, so the pair (busy `true`, the **previous**
    turn's slot content) is not observable — stale content is never gilded as `isStreaming: true`.
    The two reads are ordered, not atomic; the residual interleaving is the benign mirror — a
    brand-new turn's first blocks briefly labelled settled, corrected by the next delta (the delta
    mapper learns the turn's `messageId` from the event payload) or the next snapshot.
- **Activity-flags overlay.** The seq-0 snapshot also carries the daemon-owned activity flags from
  the `AgentLite` projection (§5.5) — `isResponding`, `isWaitingOnTool`, `isWaitingForOtherAgents`,
  `waitingForAgentIds`, plus the STAB-125 turn-liveness pair `turnInFlight` /
  `lastStreamActivityAt` (`null` when no turn is in flight) — so a client arriving mid-turn renders
  the same agent state as `agent.get` without a second read. `isResponding`, `isWaitingOnTool` and
  the turn-liveness pair are gated on the agent's busy claim, so they describe **live** turn state
  only and never light up for the orphaned-slot merge above (`isWaitingForOtherAgents` /
  `waitingForAgentIds` are watch-derived and independent of any turn).

**Delta envelope.** Reuses the standard `{ added, updated, removedIds }` envelope with content blocks
as the id-bearing entities. Each entity carries the **full current block** (not a text diff) plus a
`{ agentId, messageId, role }` pointer — `role` is the row's real role: `assistant` for the stream
family, the persisted role (`user`/`system`/`tool`) for the non-assistant row deltas below — and
`messageSeq` + `timestamp` on the authoritative frames (the terminal reconcile and the
non-assistant row deltas). The one exception to full-current-block: under the opt-in
`deltaEncoding: "incremental"` (above), a live `text`/`thinking` chunk entity's block carries the
fragment-only `textDelta` instead of accumulated `text`:

- `added` — a block's first appearance this turn (e.g. a text block's first chunk, or a `tool_use`).
- `updated` — an existing block grown/changed, matched by `id` (e.g. each subsequent text chunk
  carries the full accumulated text — full-block replace is idempotent under re-delivery — or, on
  an incremental subscription, only the new `textDelta` fragment, which the client appends).
- `removedIds` — a block emitted **live** that the finally-persisted message does **not** contain.
  This is non-empty only for orphan self-heal: e.g. a trailing partial the durable turn dropped, or
  a mispredicted `tool_result` index. Clients **must** honor it when reducing deltas onto the
  snapshot.

**Non-assistant row deltas (`agent:message`, [intent-hq/intentd#747](https://github.com/intent-hq/intentd/pull/747)).**
In addition to the `agent:stream:*` family and `agent:tool:call`, the channel tails the per-persist
`agent:message` event (§6.5) — the forwarder's existing `sessionId == agentId` filter scopes it to
the subscribed agent — so persisted **non-assistant** rows (`user`/`system`/`tool`: direct sends,
queue drains, wake deliveries, model-change notices) surface as live deltas and subscribers render
new user messages with **no refetch**:

- **Assistant echoes emit nothing.** An `agent:message` whose `role` is `assistant` maps to no
  frame — the live stream + terminal reconcile owns assistant content, and emitting here would
  double-deliver — and costs no conversation read. The role is additionally re-resolved from the
  persisted row (defense-in-depth): a row that reads back as `assistant` still emits nothing.
- **Re-read, not payload.** The event payload is intentionally lean (`{ agentId, messageId,
  role, … }` — the row content is durably persisted, not enriched onto the event), so the row is
  re-read from the bounded newest `agent.getConversation` page — the same source the seq-0
  snapshot and the terminal reconcile use — keeping the emitted blocks byte-consistent with a
  fresh snapshot. Each persisted block arrives as an `added` entity carrying the row's **real**
  `role` plus the authoritative `messageSeq`, `timestamp`, and `streamingComplete: true`. When
  the persisted row carries `metadata`, each entity additionally carries it verbatim as
  `metadata` (additive — rows without metadata keep the lean entity shape), so metadata-driven
  affordances render at live delivery with no refetch (e.g. the sender attribution chip on an
  `agent_message`-tagged child→coordinator row). A
  re-read miss (a `messageId` outside the newest page, or a read error) emits **no** frame.
- **Stable ids under re-delivery.** Non-assistant rows may persist their blocks without an `id`,
  but the re-read already returns them stamped: `agent.getConversation` stamps the stable
  synthetic `{messageId}:{index}` onto id-less blocks at serve time (§5.5;
  [monorepo#1114](https://github.com/intent-hq/monorepo/issues/1114),
  [intent-hq/intentd#781](https://github.com/intent-hq/intentd/pull/781)), and the mapper keeps
  its own stamping as a defense-in-depth fallback — so a re-delivered event upserts the same
  blocks as `updated` instead of duplicating, and a fresh `agent.getConversation` / seq-0
  snapshot serves the **same** block ids the deltas carry (no snapshot/delta id-parity gap).
- **`appMessageId` on user-row entities ([monorepo#1157](https://github.com/intent-hq/monorepo/issues/1157),
  [intent-hq/intentd#781](https://github.com/intent-hq/intentd/pull/781)).** When the re-read row
  carries a top-level `appMessageId` (the lifted client-minted `userAppMessageId` — §5.5
  `agent.sendMessage`), each emitted entity carries it verbatim as `appMessageId` — present only
  when the underlying message has one, omitted entirely otherwise, **never** `null` — mirroring
  the `appMessageId` echoed on the user-row `agent:message` event, so a client's optimistic-insert
  dedup works on the delta path with no refetch.
- **Streaming state untouched.** The per-turn assistant accumulation state is neither consulted
  nor mutated: a user row landing mid-turn (e.g. a queue drain landing right before the turn's
  first chunk, or an interrupt-priority send) cannot corrupt the in-flight assistant blocks, and
  user block ids never surface as orphan `removedIds` at the terminal reconcile.
- **Not a terminal signal.** Because these entities carry `streamingComplete: true`, that flag
  alone no longer identifies the turn's terminal reconcile frame — clients discriminate the
  terminal frame on `role == "assistant"` (plus `streamingComplete`).

Ordering: a direct send persists the user row (and publishes its `agent:message`) before the turn
worker spawns, and a queue drain's persist likewise precedes the drained turn's chunks, so the
user-row delta arrives **before** its own turn's assistant chunks. The emit is **not** ordered
against the *previous* turn's terminal frames (independent async paths).

**Synthesized `tool_use` block shape.** Both the persisted transcript (`record_tool` in
`agent_session`) and the live delta stream (`tool_delta` in `intent-transport`) synthesize
`tool_use` blocks from the same `agent:tool:call` signal (§7) via a single factory —
`crates/intent-services/src/tool_block.rs::build_tool_use_block` — so seq-0 and every subsequent
delta agree byte-for-byte. ACP providers deliver a human-readable `title` (e.g.
`"sub-agent-explore: Explore the AI agent system…"`) rather than the raw tool name the model
invoked; the real name is derived at `session/update` mapping time
(`intent-acp::session::derive_tool_name`), and carried on the event as `data.toolName` with the
raw title alongside as `data.title` — the factory places `toolName` in `block.name` verbatim.
Derivation: a title of the form `<name>: <description>` — `<name>` a bare `[A-Za-z0-9_-]+`
identifier followed by `": "` or `":\t"` — is split, taking the prefix. Codex's dot-separated
MCP title form `mcp.<server>.<tool>` (server segment contains no dots; title carries no
whitespace, so prose titles containing dots never match) is rewritten to `{server}_{tool}`
and fed through the affix strip below (`mcp.workspace-mcp.workspace_api` → `workspace_api`,
`mcp.other-server.some_tool` → `other-server_some_tool`). Claude Code's
double-underscore-separated MCP title form `mcp__<server>__<tool>` (server segment runs to
the first `__`; both segments must be non-empty; title carries no whitespace, so prose
titles containing `mcp__` never match) gets the same treatment
(`mcp__workspace-mcp__workspace_api` → `workspace_api`,
`mcp__github__list_issues` → `github_list_issues`). Titles without any of these
shapes (`Edit src/lib.rs`, URLs like `https://…`, times like `10:15 sync`) pass through as
`name` unchanged. Trailing `_workspace-mcp` suffixes (one or more) are stripped: the registry
tool names carry no suffix, and auggie's `<tool>_<server>` convention appends the server
name, so stripping recovers the registry name (`add_to_note_workspace-mcp` → `add_to_note`).
The full title, when non-empty, is echoed verbatim as `input._acpTitle` so the FE classifier
has it alongside `name` for fallback rendering when raw args are missing (auggie frequently
sends `raw_input: null`); a `Null` `input` is coerced to `{}` so the marker can attach, while
non-object non-null inputs (arrays / scalars) pass through verbatim (the FE still has `title`
in the event).

**Sparse `tool_call_update` merge/backfill.** ACP providers send sparse `tool_call_update`
notifications (e.g. a status-only `completed` frame) in which absent fields map to an empty
`title` and `Null` `input`. These do **not** wipe earlier data: for a **known** `toolCallId`,
the daemon backfills the sparse event fields (`title`/`toolName`/`toolKind`/`input`) from the
per-call transcript state **before** the `agent:tool:call` event is published, and non-empty
update fields refresh the persisted `tool_use` block — a non-empty `title` refreshes
`input._acpTitle` (and `block.name` when the newly derived name is non-empty), a non-null
`input` replaces the block input (re-attaching the freshest title), and `status` always
patches. The live `tool_delta` block therefore stays byte-identical to the persisted one — the
byte-parity invariant above is maintained. The STAB-124 drop is unchanged: an update whose
`toolCallId` was never seen this turn is still dropped, never synthesized into a new block.
([intent-hq/intentd#551](https://github.com/intent-hq/intentd/pull/551))

**Tool blocks.** The channel tails the single `agent:tool:call` event and synthesizes TS-shaped
blocks matching the persisted transcript: a `tool_use` block (`{ type, id, name, input, toolCallId,
metadata:{ toolKind, status } }`) and, once the same call completes **with** output, a `tool_result`
block (`{ type, id, tool_use_id, output, is_error }`). Every synthesized block carries the id the
event states (`blockId` / `resultBlockId`) — the ids the durable transcript actually assigned. They
are never derived from one another: the `tool_result` does **not** follow its `tool_use` by one
whenever assistant text interleaved between the call and its completion, or a parallel call's
`tool_use` took the next index, and stamping a derived id there overwrote a legitimate block on
every id-keyed client until the terminal reconcile healed it
([monorepo#2029](https://github.com/intent-hq/monorepo/issues/2029)). A completion event without a
`resultBlockId` synthesizes no `tool_result` live; the terminal reconcile still delivers whatever
the turn persisted, and a genuinely orphaned live block still self-heals via `removedIds`.

**Standalone proposal-resource block.** When a completed tool's `output` array contains a
well-formed proposal resource item — `{ type: "resource", resource: { mimeType:
"application/vnd.intent.proposal+json", text: "<proposal JSON>", … } }` with `text` a string —
the daemon **additionally** appends a standalone `resource` content block right after the
`tool_result`, echoing the output item verbatim with the stable block id stamped on
(`{ type: "resource", id: "{messageId}:{index}", resource: {…} }`). The resource item stays in
`tool_result.output` untouched. This lets the FE render a `ProposalCard` from a top-level block
without digging through tool output. Both the persisted transcript (`record_tool`) and the live
delta stream (`tool_delta`, which pairs each lifted item positionally with the id the event's
`proposalBlockIds` states for it — the id `record_tool` assigned) derive the block from the same helpers
(`crates/intent-services/src/tool_block.rs::lift_proposal_resource` /
`build_proposal_resource_block`), preserving the byte-for-byte snapshot/delta invariant.
Malformed items (wrong MIME, missing or non-string `text`) are ignored —
no standalone block is emitted. The lift is gated on `status: "completed"` only: a tool that
ends in `error` never surfaces a standalone proposal block, even if its output still carries the
resource item.

*Collapsed-output fallback.* Some providers (e.g. auggie) do not echo the MCP content-item
array in `rawOutput`: they flatten the daemon's dual text+resource items into a single
`{ "output": "<stringified first text item>" }` object, dropping the resource item entirely.
When the tool output is **not** an array, the daemon falls back to recovering the proposal from
that collapsed string: the candidate is the nested `output` field inside the `tool_result`
block's `output` (i.e. `tool_result.output.output`), or `tool_result.output` itself when it is
a bare string. The fallback is **shape-based, not tool-scoped**: it applies to any completed
tool's collapsed output, with no filtering on tool name or other provenance signal. Acceptance
is gated purely on validation: the candidate string is size-capped (256 KiB), must parse as a
JSON object with `ok: true`, and its `proposal` must pass the bindings' canonical validation
(known `kind`, non-empty `preview.title`, object `payload`) — the same checks
`ws.app.proposal.show` applies before emitting, so any accepted payload is indistinguishable
from the daemon's own echo. The resource item is then rebuilt with the
bindings' own helpers (`intent-proposal://{kind}/{encoded id}` URI, name from `preview.title`,
compact proposal JSON as `text`), so the standalone block is identical to the array path.
Ordinary collapsed tool outputs never pass the guards, and the `tool_result`'s `output` stays
the collapsed object untouched.

*Pending-proposal tracking (within v8.7 — [intentd#1580](https://github.com/intent-hq/intentd/pull/1580),
[intentd#1581](https://github.com/intent-hq/intentd/pull/1581)).* When a turn persists lifted
proposal resource blocks (either path above — the array lift and the collapsed-output fallback
both land as persisted standalone blocks, so one turn-end scan covers both; the interruption
flush included), the daemon records each proposal's id — **`applyToolCallId ?? preview.title`**,
the same identity `proposal_resource_uri` encodes, parsed from the block's embedded proposal
JSON — plus the carrying `messageId` in the ordered `pendingProposals` session-metadata list,
lifted into the `AgentLite` `metadata` projection (`agent.list` / `agent.get`) with
`agent:updated` emitted on change. The list is a set (multiple proposals across turns pend
together; a re-proposed id replaces its older entry, newest wins), is reconciled after
`agent.replaceMessages` / `agent.editAndRegenerate` transcript swaps, and is drained by the
`agent.resolveProposal` RPC, which persists the outcome in the `proposalResolutions` map and
delivers a `proposal_resolved` system notice to the model on BOTH outcomes (applied and
dismissed). Full contract: §5.5 ([methods/agents.md](./methods/agents.md) — the
`agent.resolveProposal` row and the "Pending proposals" section).


**Standalone question-resource blocks (`AtTurnEnd`, [monorepo#732](https://github.com/intent-hq/monorepo/issues/732)).**
The second resource MIME type is `application/vnd.intent.question+json` — structured clarifying
questions an agent asks mid-task via the MCP `ws.app.question.ask` binding. Unlike the proposal
lift (which attaches at the registering call's `tool_result`), question attachments use the
`AtTurnEnd` policy: every question asked during a turn is drained when the turn finalizes and
appended as a trailing `resource` content block on the **same final persisted assistant message**,
in `ask()` call order. The block echoes the canonical attachment item:

```json
{ "type": "resource", "resource": {
    "uri": "intent-question://tar-3f9c2a81d0b4",
    "name": "Auth method",
    "mimeType": "application/vnd.intent.question+json",
    "text": "<question JSON>" } }
```

`resource.name` is the question's `header`; the URI reuses the daemon-minted attachment nonce.
`resource.text` is a **JSON-serialized string** (like every `resource.text`, it is a string field
holding compact JSON — not an embedded JSON object); decoded, the payload is:

```json
{
  "attachmentId": "tar-3f9c2a81d0b4",
  "header": "Auth method",
  "question": "Which authentication method should the new endpoint use?",
  "explanation": "optional longer context shown expandable",
  "options": [
    { "label": "OAuth", "description": "Standard OAuth 2.0 flow" },
    { "label": "API key", "description": "Static key in header" }
  ],
  "multiSelect": false
}
```

- `attachmentId` is the minted `tar-` nonce (the same id in the `intent-question://` URI).
- `header` and `question` are required, trimmed, non-empty strings.
- `explanation` is optional; absent/blank values are **omitted** from the payload (never `null`).
- `options` is `[{ label, description? }]` — `label` required non-empty (trimmed); `description`
  optional, omitted when blank. A free-form "Other" answer is always offered by the FE and is
  **never** listed as an option.
- `multiSelect` is always present, defaulting to `false`.

Because the drain happens at turn finalization (before the message persists), question blocks are
**not** emitted live mid-turn: `chat.subscribe` subscribers receive them in the terminal reconcile
frame (as `added` blocks with the stable `{messageId}:{blockIndex}` ids), and they are on the
persisted message via `agent.getConversation`. Firehose consumers get live delivery at turn end:
the terminal `agent:stream:end` carries the drained blocks as `trailingBlocks` (plus the turn's
`messageId` — §7 emitted-events table; [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)),
so a client that finalizes the in-flight message from accumulated chunks can append them
immediately instead of waiting for a transcript re-fetch.

*The `ws.app.question.ask` binding.* JS signature
`ws.app.question.ask({ question, header, options, explanation?, multiSelect? })` →
`{ ok: true, attachmentId, message }`. **One question per call** — the model calls it once per
question and may call it multiple times in a turn (each call queues one attachment).
**Top-level-only** (since [intent-hq/intentd#1063](https://github.com/intent-hq/intentd/pull/1063),
within v6.4): a **sub-agent** — a session with `parent_agent_id` set OR `is_background` true,
derived once at MCP-bridge creation from the persisted session (same spawn-time snapshot semantics
as the `agentFeatures` toggle capture; a later `is_background` flip via `agent.update` does not
change a live bridge's surface), and re-derived per run for background hooks from the owning
session — is gated by the same three layers as a disabled `agentFeatures.structuredQuestions`
toggle: the `ws.app.question.*` docs are pruned from the tool description, the namespace is
omitted from the JS prelude (`ws.app.question` is `undefined`), and a raw dispatch attempt is
denied with the redirect tool error `ws.app.question.ask is only available to top-level agents —
raise ws.agent.requestDiscussion when you need user/coordinator input, or report progress with
ws.agent.reportToParent` (checked BEFORE the settings toggle, so a sub-agent never sees
the misleading "disabled in settings" error; `ws.help("app.question")` returns the same
top-level-only reason). For **top-level** agents the `agentFeatures.structuredQuestions` toggle
(§5.12) still gates the binding independently, and with the toggle on the surface is
byte-identical to the pre-gate assembly. The sibling `ws.app.*` subnamespaces remain chief-only
as before. Hard validation (the call fails
with a descriptive tool-error string; nothing is queued): the single params object
(`{ question, header, options, ... }`) missing or not a JSON object, missing/empty `question` or
`header` (after trim), missing/non-array `options`, fewer than 2 options, or any option with a
missing/empty `label`. Validation imposes **no upper caps** — the ~4-questions-per-turn and
2–4-options guidance is soft advice that lives **only** in the tool description and is never
enforced — though the turn-attachment registry retains at most 32 attachments per agent, silently
evicting the oldest (asks beyond that still return `{ ok: true }` but the earliest questions are
dropped from the turn-end drain). The call also fails outside a live agent turn (no
turn-attachment registry or caller agent wired).

*Answer TEXT is plain text — an FE convention, not a wire feature.* The FE presents the turn's
questions sequentially and flattens **all** answers into ONE ordinary plain-text user message sent
via the normal `agent.sendMessage` path: blank-line-separated `Q:`/`A:` pairs, multi-select answers
comma-joined, free-form replies prefixed `(Other) `, skipped questions reported as `(skipped)`:

```text
Q: Which authentication method should the new endpoint use?
A: OAuth

Q: Which database?
A: (Other) Use both, key for internal

Q: Deploy target?
A: (skipped)
```

The daemon persists and delivers that text **verbatim** as an ordinary user message and never
inspects, parses, or correlates it — the `Q:`/`A:` format is an FE↔model convention and the daemon
is deliberately not a party to it.

*The answer message IS tagged (within v6.0, [intentd#965](https://github.com/intent-hq/intentd/pull/965)).*
What the daemon reads is the **structured tag**, never the text: the wizard's send carries
`messageMetadata { "type": "question_answers", "answeredQuestionsMessageId": "<question-bearing
assistant message id>" }` on the `agent.sendMessage` request (§5.5 opaque per-message payload,
persisted on the user row). That tag — naming exactly the marked message — is the ONLY thing that
retires the pending set, on the daemon and in every FE derivation. This supersedes the pre-#965
"no `messageMetadata`, no answer ids, no daemon-side answer intake" contract, and with it the
"any later user message supersedes the questions" rule: **pendingness is persistent**, surviving
plain user messages, the agent's subsequent turns, and daemon restarts, until the tag lands, the
user dismisses, or a newer question-bearing turn supersedes it.

*Daemon-side pending-questions marker (v2.8; delivery hold retired in v9.5).* While the questions
are pending — the persisted `pendingQuestionsMessageId` marker, minus the `agent.dismissQuestions`
dismissal marker — the daemon surfaces the Q&A as attention (`needs_attention` displayStatus,
`numQuestionsAsked`, the lifted `metadata.pendingQuestionsMessageId`) but does **not** gate
delivery: since [intentd#1710](https://github.com/intent-hq/intentd/pull/1710) (v9.5) automatic
deliveries to the asking agent (A2A sends, parent wakes, event batches, `agent.sendToTask`)
start turns as usual and the marker survives them — the wizard stays sticky on the marker, not on
the transcript tail, so a later turn cannot dismiss it. (From v2.8 through v9.4 those deliveries
parked in the queue with `heldForQuestions: true` instead; that hold and its result field are
removed from the wire.) Neither a plain user send nor an automatic delivery resolves the marker
(only the answer tag does), and `agent.dismissQuestions` resolves it — since intentd#892 (within
v4.3) the dismissal also delivers a system-origin notice to the model ("User dismissed your N
questions without answering...", `questions_dismissed` `messageMetadata`) so the agent learns
the questions were dismissed and does not re-ask. Full contract in §5.5 ("Pending questions").

*Rendering surface — wizard only (an FE convention).* Question blocks are surfaced exclusively via
the composer-area wizard: they are **never** rendered as transcript cards, whether pending or
resolved. This is an explicit contrast with proposal resource blocks, which legitimately render as
in-transcript cards. The question blocks themselves **are** persisted (they are durable trailing
blocks of the assistant message, §7) — they are merely never given a transcript-card rendering;
the **visible** in-transcript record of a Q&A exchange is the user's flattened `Q:`/`A:` reply
message ([cloudlands-fe#424](https://github.com/intent-hq/cloudlands-fe/pull/424)).

**Terminal reconcile (the invariant).** On `agent:stream:end` the channel re-reads the now-persisted
message and emits a terminal delta (every persisted block as `updated`, or `added` if never seen
live, carrying the authoritative `messageSeq`/`timestamp`/`streamingComplete:true`, plus
`removedIds` for any orphaned live block). The guarantee: **the seq-0 snapshot reduced with every
delta — honoring `removedIds` — equals a fresh `agent.getConversation` snapshot.**

#### seq-0 snapshot (`subscription.push`, messages page)

```json
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-7","kind":"snapshot","seq":0,
  "snapshot":{
    "agentId":"agent-123",
    "messages":[
      { "id":"0190a1b2-user","agentId":"agent-123","seq":0,"role":"user",
        "contentBlocks":[ { "type":"text","id":"0190a1b2-user:0","text":"Run the tests" } ],
        "timestamp":"2026-06-27T01:00:00.000Z" }
    ],
    "truncated":false,"totalMessages":1,"nextToken":null } } }
```

#### delta frame (in-flight block upsert)

```json
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-7","kind":"delta","seq":6,
  "delta":{
    "added":[],
    "updated":[
      { "agentId":"agent-123","messageId":"0190a200-asst","role":"assistant",
        "block":{ "type":"text","id":"0190a200-asst:0","text":"Let me check the logs first." } }
    ],
    "removedIds":[] } } }
```

On an incremental subscription (`deltaEncoding: "incremental"`, above) the same growth frame carries
only the new fragment — `"block":{ "type":"text","id":"0190a200-asst:0","textDelta":" the logs
first." }` — which the client appends to its accumulated text for that block id.

A block's first appearance arrives as `added` with the same `block.id`; each growth is an `updated`
carrying the **full** block (or, incremental mode, the fragment-only `textDelta`). A tool call
arrives as an `added` `tool_use` block, then a `tool_result`
block once output lands. The terminal frame (after `agent:stream:end`) carries the persisted blocks
with `streamingComplete:true` and any orphan ids in `removedIds` — full `text` in both encodings.
A persisted non-assistant row
(direct send, queue drain — the non-assistant row deltas above) arrives as `added` entities with no
live-streaming phase: the row's real `role` plus the authoritative `messageSeq`/`timestamp`/
`streamingComplete:true` (and the row's `metadata` when present) in a single frame.

### 7.2 Interrupted partial-turn persistence

On a **user interrupt** of an in-flight turn — `agent.stop`, `agent.sendQueuedMessageNow`, or `agent.sendMessage` / `agent.sendToTask` called with the request parameter `priority: "interrupt"` — the daemon persists the streamed-so-far partial assistant message **before** emitting the terminal `agent:stream:end`. The partial turn's content blocks are written to the transcript under the assistant `messageId` minted at turn start (the same id carried by the live `chat:stream:delta` / `agent:stream:activity` events, and from which the `chat.subscribe` synthetic block ids are derived as `{messageId}:{blockIndex}` — §7.1), tagged on the message row with:

- `metadata.interrupted: true`
- `metadata.stopReason: "interrupted"`
- `metadata.interruptReason` *(within v4.5, [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919))* — the machine-readable cause: `"user_stop"` (plain `agent.stop` keep-alive interrupt), `"preempted_by_message"` (an interrupt-priority send preempted the busy turn — `agent.sendMessage` / `agent.sendToTask` with `priority: "interrupt"`, or `agent.sendQueuedMessageNow`), `"daemon_shutdown"` (graceful-shutdown capture flushed the in-flight turn), or `"agent_stopped"` (hard stop/kill teardown — agent delete, or an `agent.stop` that fell back to the kill path because no live session was interruptible; clients must NOT assume every user-initiated stop carries `"user_stop"`). Rows without the field are legacy and should render a generic "Stopped".
- `metadata.interruptedBy` *(within v4.5, same PR)* — sender attribution, present **only** when `interruptReason` is `"preempted_by_message"` and the sender is attributable: `{ "kind": "user" }` for a user-origin send, or `{ "kind": "agent", "agentId": "...", "name": "..." }` for an agent-to-agent send (attributed from the §5.5 `fromAgentId`/`fromAgentName` sender-attribution metadata; `name` is omitted when the sender name is unknown). Automatic sends with no attribution carry no `interruptedBy` — the reason alone suffices.

This is the same convention as the graceful-shutdown flush of an in-flight turn (which stamps `interruptReason: "daemon_shutdown"`).

**Terminal-event payload.** The interrupt-path terminal `agent:stream:end` (§7 emitted-events table) is emitted **only** by the live-session interrupt path (`interrupt_inner`) — i.e. on the `"user_stop"` and `"preempted_by_message"` reasons; the `"daemon_shutdown"` and `"agent_stopped"` teardowns flush the interrupted row **without** emitting any `agent:stream:end`, so those two reasons exist only in persisted row metadata, never on this event. The emit carries `stopReason: "interrupted"`, plus `messageId` when an interrupted assistant row was persisted — the id of that row — so clients can flag the turn as stopped live, without waiting for the transcript re-fetch. It also **always** carries `interruptReason` (`"user_stop"` or `"preempted_by_message"` on the wire) — matching the persisted row's `metadata.interruptReason` when a row exists (`messageId` present), and still stamped from the interruption cause when the interrupt landed before any row could persist (`messageId` absent) — plus `interruptedBy` under the same presence rule as the row metadata, so clients can render the reason-specific Stopped indicator live. Normal-completion and error-terminated turn emits never carry `stopReason` / `interruptReason` / `interruptedBy`, but they **do** carry `messageId` (when the turn persisted an assistant message) and `trailingBlocks` (when §7.1 `AtTurnEnd` blocks were drained — the drain deliberately runs on the error path too; §7, [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)). The interrupt emit itself never carries `trailingBlocks`: the `AtTurnEnd` registry is **not** drained on the interrupt path — pending entries wait for the next turn's drain or the registry TTL — so there are no persisted trailing blocks for the event to mirror.

**Pre-first-token stop (always-persist marker row).** *(Changed within v4.5 by [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919) — supersedes the STAB-114 zero-output no-op flush.)* When nothing has streamed yet (no content blocks), **every** interruption that found a registered live-turn slot persists the interrupted assistant marker row anyway — `contentBlocks: []` plus the full metadata tag set above — so the transcript durably records the stop. This **row-persistence** guarantee holds on all four reasons: the plain `agent.stop` keep-alive path, interrupt-priority preemption (the empty marker row is persisted BEFORE the interrupting message's user row, so transcript order reads correctly), the graceful-shutdown capture, and the detach/kill teardown. The **event** guarantee is narrower: only the two emitting paths (`"user_stop"` / `"preempted_by_message"`, previous paragraph) carry the marker row's `messageId` on their terminal `agent:stream:end`. On those paths, an interrupt-shaped emit is missing `messageId` only in two cases: no live-turn slot existed to flush — the interrupt landed during turn startup (spawn / `initialize` / `session/new` / `session/load`), before the worker registered the turn — or the flush itself failed at the store (the slot is kept as the only copy of the content for a later teardown's retry); in either case the emit still carries `stopReason: "interrupted"` + `interruptReason`, just no `messageId`. The two UNIQUE-collision outcomes of the next paragraph never omit it. An `agent.stop` that takes the hard-kill fallback (no live connection or no `acpSessionId`) produces **no** interrupt `agent:stream:end` at all — it routes through the kill teardown, whose row flush (reason `"agent_stopped"`) is metadata-only.

**Interrupt racing a completed turn (normal-completion emit).** The interrupt path's row flush runs after the worker abort, and the worker's own turn-end append may already have landed: the flush then hits the `agent_message.id` UNIQUE collision. The collision alone does not say who won, so the daemon re-reads the durable row and branches on its `metadata.interrupted` tag. When the row is **not** tagged interrupted, it is the turn's **full** assistant row with normal metadata — the interrupt landed in the gap between that persist and the worker's exit, and the turn was never cut short. In that case `interrupt_inner` still emits the single terminal `agent:stream:end`, but in the **normal-completion shape**: `messageId` = the completed row's id, **no** `stopReason` / `interruptReason` / `interruptedBy`, preview fields (`lastAgentResponse?` / `digest?`) derived from the turn's text as on any terminal emit, and — as on every interrupt-path emit — no `trailingBlocks` / `turnId`. Clients therefore never receive `stopReason: "interrupted"` for a turn whose persisted row is not tagged `metadata.interrupted`, and must not pin a "Stopped" indicator on it; the `agent:idle` choreography that follows is unchanged. When the colliding row **is** tagged interrupted (a concurrent interrupt flush — the system-suspend enrollment — persisted it first, or the row could not be re-read), the emit keeps the interrupted shape and mirrors that row's `interruptReason` / `interruptedBy` (so `system_suspend` can appear on this emit in that race), with `messageId` = that row's id. Neither collision outcome omits `messageId`, so the `messageId`-absence rule of the previous paragraph (no slot, or flush failed at the store) is unchanged.

**Zero-output combined delivery is preserved.** The always-persist marker row does NOT break the [monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014) combined delivery on interrupt-priority sends: the preemption's "has the turn progressed" check excludes the just-persisted marker row **by id, and only while it is actually empty** — so the preempted zero-output user message still rides the interrupt turn's prompt ahead of the interrupting message (see `agent.sendMessage`, §5.5), while a marker row that caught a first block streaming in the cancel window counts as progress and blocks the re-delivery as before.

**Consequence for **`chat.subscribe`** (the terminal reconcile of §7.1):** because the partial assistant row is persisted before `agent:stream:end`, the channel's terminal reconcile re-reads a transcript that **contains** the streamed message — the streamed blocks are re-emitted as authoritative `updated` entries and are **not** wiped via `removedIds`. Clients keep the partial output visible and may render an interrupted/"Stopped" indicator from `metadata.interrupted` / `metadata.stopReason` on the persisted row (also visible via `agent.getConversation`) — reason-specific via `metadata.interruptReason` / `metadata.interruptedBy` when present. On an interrupt-priority send, the interrupted partial (or empty marker) row precedes the new user message in the transcript.

Added in [intent-hq/intentd#336](https://github.com/intent-hq/intentd/pull/336); terminal-payload `stopReason`/`messageId` and the pre-first-token empty-row persist added in [intent-hq/intentd#492](https://github.com/intent-hq/intentd/pull/492); `interruptReason`/`interruptedBy` and the always-persist marker-row semantics added in [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919); no method-surface change (additive semantics, within protocol v4.5).

### 7.3 Abnormal finish-reason persistence

A prompt turn that **completes** with a non-`end_turn` ACP stop reason — `refusal`, `max_tokens`, or `max_turn_requests` — is an *abnormal ending*: the turn succeeded at the transport level (no error, no interrupt), but the agent stopped for a reason the user should see. The daemon makes that reason durable so clients can render it after a reload, not just live:

- **Row metadata.** The turn's assistant row is tagged with `metadata.finishReason` carrying the ACP stop reason verbatim (e.g. `{ "finishReason": "refusal" }`), visible on `agent.getConversation` / `agent.getSession` transcript reads and the §7.1 `chat.subscribe` frames that carry row `metadata`. Normal (`end_turn`) completions persist **no** metadata for this — the common path stays noise-free. A **zero-output** abnormal turn (the prompt resolved abnormally before emitting any `session/update`) still persists an empty marker row — `contentBlocks: []` plus the `metadata.finishReason` tag — mirroring the §7.2 pre-first-token interrupt marker: the lifecycle events below are ephemeral, so the row is the only durable record of the ending.
- **Terminal event.** The turn-worker terminal `agent:stream:end` carries the same value as the additive `finishReason?` field (§7 emitted-events table) — present only on abnormal completions, omitted otherwise, never `null`.
- **Still a completion.** An abnormal ending follows the normal completion lifecycle: `agent:idle` fires (its existing lifecycle `finishReason` field carries the same stop reason, as it always has) and `agent:failed` does not. Distinct from §7.2's interrupt contract (`metadata.stopReason: "interrupted"` / event `stopReason: "interrupted"`): an interrupt is externally imposed mid-turn, an abnormal finish is the agent's own resolved stop reason. The ACP `cancelled` stop reason never reaches this path — cancellation routes through the §7.2 interrupt flush.

Presence-detected additive fields (row `metadata.finishReason`, event `finishReason?`) within the current protocol version; no method-catalog or wire-shape change, so no version bump.

