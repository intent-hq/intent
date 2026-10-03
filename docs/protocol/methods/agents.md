> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.5 `agent.*` · §5.5a `sandbox.cow.*` (CoW agent sandboxes).

Routing-only `workspaceId?` additions below are [prepared contract fields](../workspace-routing.md), optional on direct daemons and required for future forwarded workspace calls; existing scope and results are unchanged.

### 5.5 `agent.*`

The largest namespace. Every `agent.*` method is served daemon-primary by `intent-services` via the `intent-transport` router; no renderer-owned agent transport remains. `agentId` values are **server-assigned** and of the form `agent-{uuid}`.

| Method | Params | Result |
| --- | --- | --- |
| agent.list | workspaceId (req), includeRetired? *(v7.5)*, retiredOnly? *(v8.3)*, scope? *(within 10.3)*, parentAgentId? *(within 10.3)*, orphanedOnly? *(within 10.7)* | { agents: AgentLite[], retiredCount, scopeCounts, delegatedCounts } — **Soft retire (v7.5; see the agent.restore row below):** soft-retired sessions (`retiredAt` set) are EXCLUDED from the default read via an SQL-side filter (cost stays O(rows returned)); `includeRetired: true` serves every row, retired ones carrying the additive presence-detected `retiredAt` field (ISO timestamp; omitted on active rows, never `null`). **Retired-bin read (v8.3; [intent-hq/intentd#1523](https://github.com/intent-hq/intentd/pull/1523)):** `retiredOnly: true` serves ONLY the workspace's soft-retired sessions — the same SQL-side filter shape (`retired_at IS NOT NULL`) over the same summary projection, so cost stays O(rows returned), with every returned row carrying `retiredAt`; the `waitingOnHooks` / `waitingOnPrMonitors` idle-visibility overlays (see below) are skipped on this scope, since retire cancels the owner's hooks and PR monitors (see the agent.restore row below) — retired rows always read empty, so the workspace-wide overlay queries are never run for rows that cannot carry any (RPC cost contract). `includeRetired: true` + `retiredOnly: true` together is contradictory → `-32602` (`includeRetired and retiredOnly are mutually exclusive`); both flags are deliberately lenient on type — a non-bool value coerces to `false` (the documented `includeRetired` precedent), never `-32602`, unlike the v8.1 `note.list` `projection` param. **`retiredCount` (v8.3, always-present):** EVERY response variant (default / `includeRetired` / `retiredOnly`) carries `retiredCount` — the number of soft-retired sessions in the workspace, one SQL `COUNT(*)` over the partial covering index `idx_agent_workspace_retired` (migration `0104_agent_session_retired_index.sql`; an index-only scan over exactly the retired rows — O(retired rows), O(1) for the common empty-bin workspace) — so clients render a collapsed retired bin from the count alone and fetch the rows only on expand (`retiredOnly: true`). The count is a second statement after the rows read with no snapshot isolation across the two: a retire/restore landing between them can skew `retiredCount` off the returned rows by one — tolerated by design, since the paired `agent:retired` / `agent:restored` events (§6.5) let clients reconcile. **Row scope (within 10.3; [intent-hq/intent#5383](https://github.com/intent-hq/intent/issues/5383)):** `scope?: "all" \| "topLevel" \| "delegated" \| "background"` selects ONE bin of the workspace's NON-retired sessions — absent / `null` / `"all"` is today's read (old clients unaffected). The three bins are a **partition** of the `retired_at IS NULL` rows — `topLevel` = `parent_agent_id IS NULL AND is_background = 0` (the rows the FE lists by default), `delegated` = `parent_agent_id IS NOT NULL` (a background CHILD is delegated, not background), `background` = `parent_agent_id IS NULL AND is_background <> 0` (unparented background agents) — so `topLevel ∪ delegated ∪ background` is exactly the default read's row set and the bins are pairwise disjoint; retired sessions are their own bin (`retiredOnly`), never part of any scope. Each scope is an SQL-side predicate on BOTH the summary read and the message-projection aggregate (the same shape as the retired filters; cost O(rows returned), and the active-only projection cache is bypassed — a scoped read never loads the full workspace's projections), answered by an index SEARCH on `idx_agent_workspace` (or `idx_agent_parent` when parent-narrowed) — no dedicated covering index: the bins split the same index entries the default read visits, and a covering index over `(workspace_id, retired_at, parent_agent_id, is_background)` would only trade one row fetch per session for write amplification on every session mutation (pinned by a plan-shape test). Scoped rows are the default read's rows unchanged (same list projection, caps and strips). `parentAgentId?` (a canonical `agent-{uuid}`) narrows a `delegated` read to that parent's DIRECT sub-agents (`parent_agent_id = ?` on top of the delegated predicate — delegated agents are pulled **by parent**); without it `delegated` returns every delegated row in the workspace. `orphanedOnly?: true` (within 10.7) narrows a `delegated` read the other way — to the workspace's **orphaned** delegated rows only, the row set `delegatedCounts.orphaned` below counts (a non-retired parented row whose parent is not a live session of the workspace), the rows a workspace-level delegated bin lists directly; the same SQL-side predicate shape (the parent-liveness LEFT JOIN on top of the delegated predicate) over the same summary projection, cost O(rows returned), and the returned rows are the default read's rows unchanged. Omitted, `delegated` is the whole-bin read byte-for-byte. `orphanedOnly` is a filter on the ROWS only — `scopeCounts`, `delegatedCounts` and `retiredCount` stay workspace-wide. Older daemons ignore the key (they serve the whole bin), so a client sends it only after gating on `delegatedCounts.orphaned` presence. **`scopeCounts` (within 10.3, always-present):** EVERY response variant (default / `scope` / `includeRetired` / `retiredOnly`) carries `scopeCounts: { topLevel, delegated, background }` — the per-bin counts of the workspace's non-retired sessions, one grouped SQL aggregate next to `retiredCount` — so a client renders the collapsed bins from the counts alone and fetches a bin's rows only on expand (the same pattern as the v8.3 retired bin) — for the delegated bin, `scopeCounts.delegated` is the badge source only as the whole-bin fallback when `delegatedCounts.orphaned` (below) is absent; when present, the workspace-level delegated bin renders from `orphaned` and `scopeCounts.delegated` remains the workspace-wide total it always was; `scopeCounts.delegated` stays the **workspace-wide** count even when the rows read was narrowed by `parentAgentId` (per-parent collapsed groups render from the delegation counts clients already hold). Same no-snapshot-isolation tolerance as `retiredCount` (a create/delete/retire landing between the two statements can skew a count off the returned rows by one; the paired `agent:created` / `agent:deleted` / `agent:retired` / `agent:restored` events let clients reconcile). **`delegatedCounts` (additive, always-present):** EVERY response variant (default / `scope` / `includeRetired` / `retiredOnly`) carries `delegatedCounts: { running, byParent: { [parentAgentId]: { total, running } }, orphaned: { total, running } }` — the workspace's non-retired **delegated** sessions (the `delegated` bin above, `parent_agent_id IS NOT NULL`) counted per DIRECT parent — so a client renders every top-level agent's collapsed "N delegated" / "R / N delegated running" group from the counts alone, before any delegated row is loaded, and pulls one parent's children only on expand (`scope: "delegated"` + `parentAgentId` — the by-parent read this row was designed for); the workspace-level collapsed delegated bin renders its running count from `delegatedCounts.running` the same way — as the whole-bin FALLBACK only, when `delegatedCounts.orphaned` (below) is absent; when `orphaned` is present that bin's count AND running badge both come from `orphaned`, never from `scopeCounts.delegated` / `delegatedCounts.running` (which keep their workspace-wide meanings and keep feeding the per-parent groups' running sum). `byParent[p].total` is the number of non-retired sessions whose `parent_agent_id = p` (direct children only — a grandchild counts under its own parent, never the grandparent) and `byParent[p].running` the subset that is running; the top-level `running` is the workspace-wide running delegated count, `Σ byParent[*].running`. A parent with no non-retired children has NO `byParent` entry (absent, never `{ total: 0, running: 0 }`), so a workspace with no delegated sessions serves exactly `{ running: 0, byParent: {}, orphaned: { total: 0, running: 0 } }` — `byParent` is always an object, never omitted or `null` (`orphaned` is described in its own block below). **Invariant:** `Σ byParent[*].total === scopeCounts.delegated` — the same row set `scopeCounts.delegated` totals, counted by parent (pinned by a test; see the tolerance below for the only skew). **Cost:** one grouped SQL aggregate over the workspace's non-retired rows with `parent_agent_id IS NOT NULL` (`GROUP BY parent_agent_id`), a third statement next to `retiredCount` / `scopeCounts` — O(delegated rows), the same order as the default read, and NO row is hydrated (the RPC cost contract); like `scopeCounts.delegated`, the counts stay **workspace-wide** even when the rows read was narrowed by `scope` or `parentAgentId`. It rides the result envelope beside `scopeCounts`, OUTSIDE the rows array the frame budget below measures — ≈ 70 bytes per `byParent` entry (`"agent-<uuid>":{"total":N,"running":N}`), so the counts stay within the envelope's ≈ 24 KiB headroom up to ≈ 350 distinct parents with live delegated children; the frame-budget fit does not measure them (like the request `id`), and a workspace past that scale is already in the "NOT a hard bound" regime the fit documents (each such parent is typically a ≈ 1.1 KB row of its own), where only paging bounds the frame. **`running` rule:** a delegated session counts as running when its PERSISTED `status` is `pending`, `active` or the legacy capitalized `Processing` (the daemon's `AgentStatus::is_running_turn` rule in intent-core — an exhaustive match pinned by the `agent_status_running_turn_golden` test, from which the SQL aggregate's status list is generated; `AgentStatus` serializes the legacy variant as `"Processing"`, never lowercase) — the persisted approximation of the client-side liveness derivation (the FE's `isAgentRunning`, which also reads the live-turn fields): it can lag a turn's in-memory start or end by the status persist, so loaded rows stay authoritative once a parent's children are hydrated (daemon-served counts until the lazy by-parent read lands, loaded rows afterwards — per parent). **Cross-workspace parents:** `byParent` keys are the raw `parent_agent_id` values of this workspace's rows, so a key may name a parent that is NOT among this workspace's sessions (cross-workspace delegation — e.g. a chief-of-staff parent delegating into a project workspace); clients render the entries whose key matches a row they hold and ignore unknown keys. Same no-snapshot-isolation tolerance as `scopeCounts` (a create/delete/retire/restore landing between the statements can skew a count off the returned rows — or `Σ byParent[*].total` off `scopeCounts.delegated` — by one; the paired `agent:created` / `agent:deleted` / `agent:retired` / `agent:restored` events let clients reconcile). Presence-detected, no protocol version bump (the `retiredCount` / `scopeCounts` precedent): an older client reads the key as an unknown field, and a client against an older daemon (key absent) keeps deriving the groups from loaded rows exactly as before. **`delegatedCounts.orphaned` (within 10.7, additive, always-present):** `delegatedCounts` additionally carries `orphaned: { total, running }` — the **orphaned** subset of the same delegated row set, counted workspace-wide. **Orphan rule (daemon-owned):** a non-retired session with `parent_agent_id` set whose parent is NOT a non-retired `agent_session` row of the same workspace — the parent row was deleted, is soft-retired, or is absent from the workspace's sessions (so a cross-workspace `byParent` key above names an orphan's parent). A child of a live standalone **background** parent is NOT an orphan (its parent is live; it nests under that parent's group in the `background` bin), and a child of an orphan is NOT an orphan either (its parent is live, if orphaned — it nests under the orphan's own group inside the delegated bin): orphan-hood is decided by the DIRECT parent's liveness only, never inherited. The daemon owns the classification because neither a client nor the wire can otherwise tell whether a `byParent` key names a live, collapsed-background, retired or deleted session without hydrating every bin. `orphaned.running` is the orphan subset that is running under the same **`running` rule** above (`AgentStatus::is_running_turn`, the status list `running` / `byParent[*].running` use). Always present — `{ total: 0, running: 0 }` when the workspace has no orphaned delegated session (never omitted, never `null`). **Invariant:** `orphaned.total ≤ scopeCounts.delegated` — a subset of the row set `scopeCounts.delegated` totals (pinned by a test; the same one-off skew tolerance as `Σ byParent[*].total`). **Cost:** the same `idx_agent_workspace` search as `byParent`, one grouped statement (a LEFT JOIN on the parent row — non-retired, same workspace — keeping the `p.id IS NULL` rows) — O(delegated rows), NO row hydrated, and workspace-wide regardless of `scope` / `parentAgentId` / `orphanedOnly` on the rows read. **Client use:** when `orphaned` is present the workspace-level delegated bin renders its count and running badge from `orphaned` (and is hidden when `orphaned.total === 0`), listing its rows through the `orphanedOnly` read above, while per-parent groups keep rendering from `byParent`; a delegated row whose parent is live is reachable only through that parent's group. Orphan counts are not nudged from lifecycle events client-side (a parent's deletion or retire turns its children into orphans, which a client cannot classify locally) — they re-baseline on the list refetch those events trigger. Presence-detected, no protocol version bump (the `delegatedCounts` precedent): an older client reads `orphaned` as an unknown field, and a client against an older daemon (`orphaned` absent — that daemon also ignores `orphanedOnly`) keeps the whole-bin behaviour. The §6.9 agent collection channel and the MCP `ws.agent.list` binding are unchanged — neither surfaces the counts. Unlike the lenient retired flags, `scope` is strict: an unknown string OR a non-string value is `-32602` (`scope must be "all", "topLevel", "delegated" or "background"`), never coerced; a bin scope combined with `includeRetired` or `retiredOnly` is `-32602` (`scope "<scope>" cannot be combined with includeRetired or retiredOnly: retired sessions are their own bin` — the `includeRetired` + `retiredOnly` contradiction is checked first and wins); a non-canonical or non-string `parentAgentId` is `-32602` (`parentAgentId must be a canonical agent-{uuid} id`); and `parentAgentId` with any scope other than `"delegated"` — including the default — is `-32602` (`parentAgentId requires scope "delegated"`). `orphanedOnly` (within 10.7) follows the `parentAgentId` shape: `orphanedOnly: true` with any scope other than `"delegated"` — including the default — is `-32602`, and `orphanedOnly` combined with `parentAgentId` is `-32602` (the two sub-filters of the delegated bin are mutually exclusive — an orphan's DIRECT children are pulled by parent, never by `orphanedOnly`); both are rejected before any read, like every other `agent.list` param error. The §6.9 agent collection channel takes NO list params (`workspaceId` + `replaceGroup` only; unknown keys ignored), so it is unscoped: its seq-0 snapshot is the default read and its deltas cover every bin — a client that lists by scope pulls the bins and tracks the counts from the agent lifecycle events, or subscribes unscoped. The MCP `ws.agent.list` binding keeps its own option names: `scope: "subagents"` and a bare `parentAgentId` are served by the wire's `delegated` scope, while its `"top-level"` (no parent — WIDER than the wire's `topLevel` bin, since it keeps unparented background agents) stays a client-side filter over the default read. `agent.get` / `agent.getSession` always serve `retiredAt` regardless, so clients can render a retired session's preserved conversation read-only. Messages/systemPrompt stripped; adds messageCount, lastAgentResponse, lastUserMessage, lastMessageRole?, digest, lastActivity, isStreaming/isProcessing/isResponding, session-level contextReferences?/fileBlocks? (**`agent.get` only since the intent#5383 detail-only strip below — never on `agent.list` rows**; persisted at spawn; omitted when absent; `fileBlocks` entries are attachment references — the only shape the create seam accepts since v10.0, see `agent.create` — though a session row persisted before 10.0 may still hold a legacy inline entry — session-level `imageBlocks` are deliberately NOT served on this projection: they are potentially large base64 blobs with no list-read consumer, so they live on `agent.getSession` only; the field was optional/presence-detected, so existing row decoders remain valid — it is simply never present anymore), the session-discovered `effortLevels?` (`agent.get` only — stripped from list rows, see the detail-only strip below; the provider's `thought_level` values captured at the most recent session open — see "Session-discovered effort levels" below; omitted when the provider advertises none), the harness stamp `harnessVersion` + `harnessFeatures` (within v7.0 — the creation-time harness version and captured `agentFeatures` snapshot, §5.5 "Harness versioning"; `harnessVersion` is always present on BOTH reads — it is the small string behind the "Harness vX.Y" list label — while `harnessFeatures` is **`agent.get` only** since the intent#5383 strip: absent on every `agent.list` row, and on `agent.get` it always carries a value — a legacy pre-snapshot row follows live settings on read until its first activation freezes the snapshot), and a nested metadata { isBackground, specialist?, createdByAgentId?, taskNoteId?, completionReport?, completionReportTimestamp?, attentionRequestKind?, attentionRequestReason?, attentionRequestTimestamp?, delegationDepth?, dismissedQuestionsMessageId?, pendingQuestionsMessageId?, pendingProposals? *(`agent.get` only)*, proposalResolutions? *(`agent.get` only)*, lastSeenMessageId?, isInitialAgent?, sponsorAgentId? } (the P3-1.2b persistence-gap fields plus the pending attention request raised by `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` — see the agent-attention-requests block below — plus the v2.8 question-dismissal marker, the authoritative pending-question marker `pendingQuestionsMessageId?` (lifted into the structured projection by [intentd#1350](https://github.com/intent-hq/intentd/pull/1350) — present whenever the marker was ever written: a non-empty message id means that message's questions are pending, the empty string is the authoritative "nothing pending" clear; omitted only for legacy sessions the daemon never marker-wrote, where clients fall back to the transcript derivation — see §5.5 "Pending questions" below), the pending-proposals list `pendingProposals?` (within v8.7, [intentd#1580](https://github.com/intent-hq/intentd/pull/1580)) — the ordered `{ proposalId, messageId }` entries still awaiting an Apply/Dismiss resolution (see §5.5 "Pending proposals" below; omitted when empty, never `[]`) — the resolved-proposal outcomes map `proposalResolutions?` (within v8.7, [intentd#1581](https://github.com/intent-hq/intentd/pull/1581)) — `proposalId -> "applied" | "dismissed"`, recording how each formerly pending proposal was resolved via `agent.resolveProposal` (read-filtered against the two known outcomes, so caller-seeded session metadata cannot smuggle an unknown value into the projection; omitted when empty) — the v4.5 per-conversation seen marker (`agent.markSeen`), the initial-agent flag `isInitialAgent?: true` — presence-detected from the raw session metadata the `workspace.create` initial-agent orchestration stamps (§5.1), present only as `true` and omitted otherwise (never `false`, never `null`) — and the peer-spawn attribution `sponsorAgentId?` (within v7.5): the sponsoring caller's agent id stamped by `ws.agent.create({ topLevel: true })` (originally `ws.agent.spawnPeer`, merged into `create` within v8.1; see the "Peer agents" block below) — attribution ONLY, never a parent linkage (a sponsored top-level agent is a parentless depth-0 row), present only on agent-created top-level agents; omitted when absent). **`metadata.initialMessage` is deliberately NOT served on the `AgentLite` projection — `agent.list` AND `agent.get` rows** ([intent-hq/intentd#1337](https://github.com/intent-hq/intentd/pull/1337) removed it from list rows, [monorepo#2932](https://github.com/intent-hq/monorepo/issues/2932); [intent-hq/intentd#1542](https://github.com/intent-hq/intentd/pull/1542) extended the strip to the whole projection): the full spawn-time first message persisted at `agent.create`/`agent.delegate` is unbounded and was the single largest per-session field on real workspaces (~29% of a ~1 MiB 178-session list frame), with no client read-side consumer at all — it is served by `agent.getSession` only (the value stays persisted; nothing changes at write time — `agent.create`/`agent.delegate`/`agent.update` still accept and persist it). Same shape-compat argument as the session-level `imageBlocks` carve-out above (v6.17): the field was optional/presence-detected (`skip_serializing_if`), so existing row decoders remain valid — on `AgentLite` rows it is simply never present anymore (and it is deliberately absent from the metadata enumeration above; `agent.get` no longer adds it back — intentd#1542 removed the former list/detail asymmetry). **List-row preview cap ([intent-hq/intentd#1422](https://github.com/intent-hq/intentd/pull/1422), [monorepo#3275](https://github.com/intent-hq/monorepo/issues/3275)):** every render-preview field on a list row — `lastAgentResponse`, `lastUserMessage`, `digest`, `lastToolUse`, and `metadata.completionReport` — is bounded to `AGENT_LIST_PREVIEW_BUDGET_BYTES` (**400 bytes per field**), extending the monorepo#2932 list-payload cost contract: these fields exist to render a one-line summary in list contexts (sidebar rows, HUD cells), and unbounded values pushed real ~250-session `agent.list` frames past the transport's 1 MiB outbound warn. String fields are truncated char-boundary safe against their JSON-**serialized** size (escaping-heavy content counts its escaped bytes against the budget, so the wire bound holds); an over-budget `lastToolUse.input` is replaced by the same structure-preserving `cap_json_value` preview as the slim conversation projection with `inputTruncated: true` stamped alongside and `inputBytes` recording the ORIGINAL input's serialized size — a write-time `inputBytes` on an already-flagged persisted preview is kept, and `name` is never touched — so the documented `{ name, input?, inputTruncated?, inputBytes? }` preview contract above survives the re-cap and the FE's `classifyTool(name, input)` keeps working. (One hedge on the "400 bytes per field" bound: for `lastToolUse` the budget governs the **input preview** — the envelope keys `name` / `inputTruncated` / `inputBytes` sit outside it, and the structure-preserving `cap_json_value` preview lands within a small constant factor of the budget rather than strictly ≤ 400 serialized bytes; the four string fields are strict.) The string-field truncation is silent (no flag marks a capped `lastAgentResponse` / `lastUserMessage` / `digest` / `completionReport` — they are render previews, not data reads). **Row-budget extension ([intent-hq/intent#5383](https://github.com/intent-hq/intent/issues/5383)):** the same silent, serialized-bytes, char-boundary-safe truncation also bounds every remaining free-text string a list row carries, each at a cap sized for the field — `metadata.attentionRequestReason` (a long reason blew the per-row budget in production) at the same **400 bytes**, `name` and `model` at **128 bytes** (`AGENT_LIST_NAME_CAP_BYTES`: a 1–5 word label / a provider model slug), and `metadata.sandboxPath` and `metadata.sandboxBranch` at **256 bytes** (`AGENT_LIST_PATH_CAP_BYTES`: a filesystem path / a branch name) — so no string field on a list row is unbounded; a worst-case-realistic row (every field present, every capped string at its cap, two hooks and two PR monitors) is pinned at or under `AGENT_LIST_ROW_BUDGET_BYTES` by a row-budget golden, and a key-allowlist golden (`AGENT_LIST_ROW_KEYS` / `AGENT_LIST_ROW_METADATA_KEYS` in intent-core) pins the exact set of keys a list row may carry — adding a key to a list row is a wire-contract change that must update the allowlist and this row together. Serve-time projection bound only — nothing changes at write time, and the cap runs AFTER the intentd#786 live-turn preview overlay below, so live streamed text is bounded identically to persisted text. The detail reads — `agent.get` / `agent.getSession` — never apply it (the deliberate list/detail asymmetry; see the agent.get row below): the string previews are served at full length there, and `lastToolUse` is served as the persisted preview unchanged — still subject to its own write-time 2 KiB slim-projection bound (see the `lastToolUse` field below), just never the tighter list re-cap. **Response-level frame budget ([intent-hq/intent#5531](https://github.com/intent-hq/intent/issues/5531), [intent-hq/intentd#2039](https://github.com/intent-hq/intentd/pull/2039)):** the per-field and per-row caps above bound each ROW, not the RESPONSE — a 459-session workspace whose rows all sat inside the row contract (~2.3 KB/row) still encoded the default read to ~1.07 MB, past the transport's 1 MiB outbound frame warn. After the per-row strip + cap pass, every `agent.list` variant (default / `scope` / `includeRetired` / `retiredOnly`) measures the serialized rows array against `AGENT_LIST_FRAME_BUDGET_BYTES` (**1,000 KiB** — ≈ 24 KiB of headroom under the warn threshold for the `{ jsonrpc, id, result: { agents, retiredCount, scopeCounts, delegatedCounts } }` envelope; a client-chosen multi-KiB request `id` adds its own bytes on top) and, when over budget, re-caps every row's preview fields (the same six slots the 400-byte cap governs: `lastAgentResponse`, `lastUserMessage`, `digest`, `lastToolUse.input`, `metadata.completionReport`, `metadata.attentionRequestReason`) at a halved budget — **400 → 200 → 100 → 50 bytes** (`AGENT_LIST_PREVIEW_FLOOR_BYTES`) — stopping at the first cap that fits. Row shape is unchanged and no NEW key is introduced — the same allowlisted keys ride with harder silent truncation — with one presence effect, entirely inside the documented `lastToolUse` `{ name, input?, inputTruncated?, inputBytes? }` contract: an `input` that passed the 400-byte list cap unflagged and is truncated by a tighter re-cap (200 / 100 / 50) gains `inputTruncated: true` + `inputBytes` (the ORIGINAL serialized size), exactly as the normal cap stamps them, so consumers already tolerate those optional keys; it is therefore not a wire change and needs no protocol version bump; a small workspace's response is byte-identical to before (the cap is never tightened when the rows already fit). The fit is O(rows) — at most four serialization passes, no extra SQL — and a tightened response is logged daemon-side with the row count, bytes before/after and the applied preview budget. NOT a hard bound: the fit stops at the 50-byte floor so every row keeps a one-line-render-sized preview, and the non-preview part of a row (ids, timestamps, flags) is ≈ 1.1 KB, so a workspace of ≈ 900+ non-retired sessions still overflows the frame with previews at the floor — bounding THAT needs paging `agent.list` (a protocol change, not in scope). `agent.get` / `agent.getSession` are untouched (the list/detail asymmetry above). **Detail-only fields stripped from list rows ([intent-hq/intent#5383](https://github.com/intent-hq/intent/issues/5383)):** `agent.list` rows (every scope — default / `includeRetired` / `retiredOnly`) OMIT `harnessFeatures`, `effortLevels`, `contextReferences`, `fileBlocks`, `stats`, `metadata.pendingProposals` and `metadata.proposalResolutions` — absent, never `null` — while `agent.get` / `agent.getSession` keep serving every one of them unchanged. Their only client readers are open-agent (detail) contexts — the replace-agent eligibility gate and harness-features modal (`harnessFeatures`), the open agent's effort picker (`effortLevels`), the open chat's proposal cards (`proposalResolutions`) — so they belong on rung 3 of the derived-field ladder (consumed on detail only: fetch `agent.get` on demand), and `harnessFeatures` alone was the largest fixed-size field on every list row. Same shape-compat argument as the `imageBlocks` / `initialMessage` carve-outs above: every stripped field was optional/presence-detected (`skip_serializing_if`), so existing row decoders remain valid and no protocol version bump is needed — on list rows they are simply never present anymore; nothing changes at write time. The §6.9 agent collection channel does NOT inherit the split: its seq-0 snapshot rows are `agent.list` rows (capped and stripped), and its `added` / `updated` deltas — re-read through `agent.get` — are projected onto the SAME list shape before push (the identical strip + cap pass), so every pushed agent row satisfies the `AGENT_LIST_ROW_KEYS` / `AGENT_LIST_ROW_METADATA_KEYS` allowlist and the `AGENT_LIST_ROW_BUDGET_BYTES` row budget; the detail-only fields reach a client only via a direct `agent.get` / `agent.getSession`. `metadata.isBackground` is served from the persisted session flag (harvested at spawn; G-A1/P3-1.2c) so rehydrated background agents stay background. **`notificationsMuted` (additive, always present):** top-level boolean on every `AgentLite` / `AgentSession` projection (`agent.list`, `agent.get`, `agent.getSession`, and the `agent.create` / `agent.update` results) — the daemon-owned per-session notification mute (migration `0123_agent_session_notifications_muted.sql`, `agent_session.notifications_muted`, default `false`), written only through `agent.update { changes: { notificationsMuted } }` (see the `agent.update` row) so every client (desktop, HUD, iOS) reads the same state and it survives daemon restart. The flag reaches event payloads two ways (§6.5): the **conditional stamp** — `notificationsMuted: true`, omitted when false — on `agent:idle` and `agent:attention-requested` event data, and the **written value** — `true` or `false` — on the `agent:updated` a mute toggle emits, whose data is `{ agentId, ...changes }` (the mutated fields, like every `agent.update` emit). It is a client-notification preference, NOT an agent-visible fact: every `ws.agent.*` MCP binding result (`status`, `list`, `create`, `delegate`, `wakeOrCreate`, …) and every `ws.event.*` read result (`query` — flat and paginated — and `agentActivity`, which replay those persisted `agent:updated` / `agent:idle` / `agent:attention-requested` payloads) strips the key from every one of these shapes, however deeply nested, before it reaches the calling agent. The same holds for agent-facing **wake `messageMetadata`**: the `event_notification` metadata that completion / watch / attention wakes (`ws.agent.watch`, delegation and group settlement wakes, `reportBlocker` / `requestDiscussion` fan-out) build from `agent:*` event data is scrubbed of the agent hidden fields before delivery, so a watching parent never learns a child's mute preference through its transcript either. **Live-turn preview overlay ([intent-hq/intentd#786](https://github.com/intent-hq/intentd/pull/786), read-path):** while a turn is in flight (`isResponding` with the live-turn slot held by a busy worker — orphan slots without a busy worker are ignored, the same gate as the STAB-125 turn-liveness reads below), `lastAgentResponse`/`digest` are derived from the live turn's streamed-so-far text (the same extraction that derives the persisted-preview fields from the newest assistant row) instead of the persisted last-assistant-message preview, with a **per-field** fallback: a turn that has streamed no text (or no digest) yet keeps the persisted value, so an early turn never blanks the previous preview. Mid-turn `lastAgentResponse` is additionally **clipped at the last completed newline** ([intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795)) — the still-streaming trailing partial line is excluded, and a turn with no completed line yet keeps the persisted value (same per-field fallback); `digest` derives from the **unclipped** text, since its capture requires the closing tag (an unclosed opener never leaks). Terminal `agent:stream:end` and persisted previews are unclipped (§7). Read-path only — nothing new is persisted, and idle agents serve the persisted newest-assistant-message preview exactly as before. **`lastMessageRole` ([intent-hq/intentd#807](https://github.com/intent-hq/intentd/pull/807), additive):** `"user" \| "assistant"` — the role of the session's newest user/assistant transcript message; system (and any other) rows are transparent, and the field is **omitted** when the transcript has neither (absent, never `null`) — the structured signal behind conversation previews (was the last word the user's or the agent's?). Denormalized onto the session row at message-write time, so the full-transcript and transcript-free projection paths serve the same value. **Live-turn read-path overlay:** while a turn is in flight the field flips to `"assistant"` exactly when the live `lastAgentResponse` overlay applies (the in-flight turn has derivable streamed text — same per-field gate as above), since the newest live message is then the assistant's; a turn that has not streamed derivable text yet serves the persisted value (typically `"user"`) unchanged. **`lastMessageId` ([intent-hq/intentd#1039](https://github.com/intent-hq/intentd/pull/1039), additive; [monorepo#1597](https://github.com/intent-hq/monorepo/issues/1597)):** the row id of the session's newest **user/assistant** transcript message — the same row whose role `lastMessageRole` reports, with the same transparency rule (system and any other rows are transparent) — and the field is **omitted** when the transcript has no user/assistant message (absent, never `null`). Denormalized onto the session row at message-write time alongside `lastMessageRole` (migration `0088_agent_session_last_message_id.sql`, one-time backfill from the newest user/assistant row; a NULL column degrades to omission without in-place repair and converges on the next user/assistant append), so the full-transcript and transcript-free projection paths serve the same value with no transcript hydration. **NO live-turn overlay** — deliberately unlike `lastMessageRole`: a streaming assistant message has no persisted row id yet, so mid-turn the field keeps naming the last persisted user/assistant row while `lastMessageRole` may already have flipped to `"assistant"` — the pair is NOT mutually consistent mid-turn. That staleness is acceptable by design: clients rank a running turn (`isResponding` / `turnInFlight`) above unread, so the field only needs to be right at rest. **Seen-marker comparison (equality semantics):** the intended client-side per-agent **unread** derivation against the v4.5 `metadata.lastSeenMessageId` seen marker (`agent.markSeen`, below) is `hasUnread = lastMessageRole === "assistant" && lastMessageId != null && lastMessageId !== metadata.lastSeenMessageId` — an **absent marker counts as unread**, and an absent `lastMessageId` (older daemon) derives `false` so pre-existing client heuristics keep working. Caveat: the seen marker names "the newest transcript message the user has seen", which can be a **system/tool row id** that `lastMessageId` never equals — a naive equality check against such a marker can stick unread forever. Clients should therefore prefer passing user/assistant row ids to `agent.markSeen` — equality is the ONLY sound comparison. Id ordering is deliberately NOT a fallback: message ids are not uniformly UUIDv7 (server-minted user rows are `user-msg-{uuid}`, and `agent.sendMessage` accepts arbitrary client-supplied `messageId` values), and even among v7 ids mint time is not persist order (an assistant id is minted at turn start but persisted at turn end, so a mid-turn system row's persist-time id can out-sort it) — use the transcript `seq`/position where ordering is needed, never the id. **`lastToolUse` (additive):** preview of the newest user/assistant message's LAST `tool_use` block — `{ name, input?, inputTruncated?, inputBytes? }` with `input` bounded by the §5.5 slim-projection budget (2 KiB): an under-budget input passes through whole (no flags), an over-budget one is replaced by the same structure-preserving capped preview as the slim conversation projection with `inputTruncated: true` + `inputBytes` (original serialized size) alongside — so the small scalar keys the FE's `classifyTool(name, input)` reads survive giant blob siblings. On `agent.list` rows the served `input` is additionally re-capped to the tighter 400-byte list-row preview budget (intentd#1422 — see the list-row preview cap block above; the flags contract is preserved, and `agent.get` serves the persisted 2 KiB-bounded preview unchanged). Same transparency rule as `lastMessageRole`/`lastMessageId` (system and other rows transparent), **omitted** when the newest user/assistant message carries no `tool_use` block or no such message exists (absent, never `null`). Denormalized onto the session row at message-write time (migration `0098_agent_session_last_tool_use_preview.sql`, one-time backfill from the newest user/assistant row — with one bounded divergence: the SQL backfill stores only the flags for an over-budget input, no capped `input`; such rows converge to the full capped form on the next user/assistant append; a corrupt column degrades to omission without in-place repair), so the full-transcript and transcript-free projection paths serve the same value with no transcript hydration. **NO live-turn overlay** — like `lastMessageId`: the persisted column only moves on message persists; the live mid-turn tool signal remains `agent:stream:activity`'s `lastToolUse` (`{ name, status }`, §7 — a different, lighter shape). The same preview rides on every user/assistant `agent:last-message` event (§6.5), where its ABSENCE means the preview was just cleared. **Turn-liveness (STAB-125, additive):** `turnInFlight: bool` is `true` while an active worker is draining a `session/prompt` turn for the agent, and `lastStreamActivityAt` (RFC-3339; omitted when no turn is in flight) is the timestamp of the most recent stream event observed for that turn — a long turn persists nothing until it ends, so these let a poller tell a long-but-alive turn (timestamp advancing) from a wedged agent (timestamp pinned) while `lastActivity` stays pinned at the last persisted message. Caveat: the stamp only advances on stream traffic, so during a long silent tool call it pins too — combine with `isWaitingOnTool` to avoid misclassifying a healthy-but-slow tool turn. **Context-window occupancy (intent-hq/intent#3797, additive):** `contextUsage?: { used, size, updatedAt }` — the latest ACP `usage_update` notification's required context-occupancy fields for the agent's live session: `used` is the token count currently occupying the model's context window (input + cache — point-in-time occupancy, NOT a cumulative consumption counter), `size` is the model's total context window, and `updatedAt` (RFC-3339) stamps the report the snapshot came from. **Latest-wins per live session, held in-memory only**: each report replaces the previous value wholesale, nothing is persisted, and a daemon restart, session recreate (agent respawn), or the session's deletion drops it — the field is **omitted** until the next report (absent, never `null`), so clients written against the pre-field shape are unaffected. Deliberately DISJOINT from the token tallies: `used`/`size` never feed `workspace.getTokenUsage` (§5.23) — only the same notification's optional `cost` object does — so occupancy is a UI signal (e.g. a context-fullness meter), not a billing counter. **Corrupted-session flag ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940), additive):** `sessionCorrupted: true` is present only when the session is parked in `error` (`status == "error"` is required for BOTH causes) AND either (a) the failure classifies as session-fatal (provider safety block, deterministic `session/prompt` 400 `invalidArgument` rejection) or (b) the consecutive-identical-failure streak hit the poisoned threshold — the structured signal that `agent.retry` will recreate the provider session (fresh `session/new`) instead of resuming, or that spawning a fresh agent is the right recovery. **Derived on emit** over the persisted (status, stop_reason) + the in-memory failure streak — never persisted as a column — and **omitted when `false`** (absent ≠ present-false on the wire). **Idle-visibility (within v3.1, additive):** `waitingOnHooks?: [{ hookId, name, nextRunAt?, expiresAt? }]` — light metadata for the agent's ACTIVE (`scheduled`/`running`) background hooks (§5.40), **omitted when empty** (absent, never `[]`; no code/lastState/logs), overlaid at serve time from one workspace-batched hook query (per-agent on `agent.get`) so clients can tell a hook-waiting idle agent from a stalled one; the same list is stamped on the `agent:idle` event payload and `agent.diagnostics` agent rows (§6.5). **Idle-visibility, unified external-wait (within v6.2, additive):** `waitingOnPrMonitors?: [{ monitorId, repo, prNumber, title? }]` — the same light-metadata treatment for the agent's ACTIVE PR monitors (§5.42), **omitted when empty**, overlaid at serve time from one workspace-batched monitor query (per-agent on `agent.get`), mirroring `waitingOnHooks` field-for-field; also stamped on `agent:idle` and `agent.diagnostics` agent rows |
| agent.listActive *(v4.1)* | — (daemon-global; accepts an empty params object, no `workspaceId`) | { streams: [{ agentId, sessionId, workspaceId, startTime }] } — the daemon-global list of **mid-turn** agents, served from the runtime manager's in-memory busy set (never a persisted-workspace/session scan; monorepo#1395 — the cheap poll behind "which agents are streaming right now?"). `sessionId` mirrors `agentId` (one session per agent). `startTime` is **epoch milliseconds** (i64, not RFC-3339): derived from the session's `updated_at`, which the turn-claim (`try_begin`) touches when the Active transition persists — so it approximates the current turn's start without a dedicated column (claim-time semantics; the wire name is part of the 4.1 contract). Entries are sorted by `agentId`; a busy agent whose session row is gone (e.g. a concurrent `agent.delete` mid-turn) is skipped rather than failing the response. `{ "streams": [] }` when no manager is attached or nothing is mid-turn. |
| agent.get | agentId (req), workspaceId? | { agent: AgentLite } — same projection as agent.list (including the intentd#786 live-turn preview overlay on `lastAgentResponse`/`digest`, the intentd#807 `lastMessageRole?` field with its live-turn flip, the intentd#1039 `lastMessageId?` field (deliberately no live-turn overlay), the STAB-125 `turnInFlight`/`lastStreamActivityAt` turn-liveness fields, and the derived monorepo#940 `sessionCorrupted?` flag) — including the `metadata.initialMessage` strip: the field is deliberately absent here too, not just on `agent.list` rows ([intent-hq/intentd#1542](https://github.com/intent-hq/intentd/pull/1542) extended the monorepo#2932 carve-out to the whole projection; the persisted value is served by `agent.getSession` only — see the agent.list row) — **plus the detail-only fields the intent#5383 strip removes from list rows** (`harnessFeatures`, `effortLevels?`, `contextReferences?`, `fileBlocks?`, `stats?`, `metadata.pendingProposals?`, `metadata.proposalResolutions?` — all served here exactly as before; see the detail-only strip block on the agent.list row), and **without** the intentd#1422 list-row preview cap or its intent#5383 row-budget extension (the deliberate list/detail asymmetry; see the list-row preview cap block on the agent.list row): `lastAgentResponse` / `lastUserMessage` / `digest` / `metadata.completionReport` / `metadata.attentionRequestReason` / `name` / `model` / `metadata.sandboxPath` / `metadata.sandboxBranch` are served at full length here, and `lastToolUse` is served as the persisted preview unchanged — still bounded by its write-time 2 KiB slim-projection budget (with the `{ name, input?, inputTruncated?, inputBytes? }` flags contract), just never the tighter 400-byte list re-cap; -32602 with `error.data.code: "not-found"` if not found (falls back to disk) |
| agent.getConversation | agentId (req), limit?: number, nextToken?: string, aroundMessageId?: string, aroundIndex?: number, projection?: "slim", workspaceId? | { agentId, messages, truncated, totalMessages, nextToken, turnInFlight, lastStreamActivityAt } (capped to most-recent limit; `nextToken` is the opaque cursor for the next older page — `null` when no more history remains, non-null iff `truncated` is `true`; pass it back as the `nextToken` input to fetch the next page). **Seek (`aroundMessageId`, additive):** when present it takes precedence over any token and resolves to the page **containing** that message — half the (clamped) page budget goes to rows older than the target and the rest to the target and newer rows, clamped at either edge so the page stays full whenever the transcript has ≥ `limit` rows. An unknown message id is rejected with `-32602` naming the id (`unknown message id: <id>`). **Ordinal seek (`aroundIndex`, additive within v7.1):** the 0-based ordinal from the OLDEST message — the direct-position counterpart for clients that know *where* in the transcript they want to land (e.g. the page at ~80%) but not *which* message is there. Resolves to the page **containing** that ordinal with the identical centered split and the identical dual-cursor contract as `aroundMessageId`. Out-of-range values **clamp** into `[0, totalMessages - 1]` (client estimates are approximate — an overshooting or stale estimate is never an error; integers beyond `i64::MAX` clamp the same way, and an **empty** conversation — `totalMessages: 0` — returns the ordinary empty page with both cursors `null`, never a rejection); a negative or non-integer value is `-32602` naming the param; supplying both seek params is `-32602` naming the conflict (`aroundMessageId and aroundIndex are mutually exclusive`); either seek param takes precedence over a simultaneously supplied `nextToken`. Seek pages — and the forward continuations minted from them — additionally carry `prevToken`: an opaque **forward** cursor that walks newer toward the live tail (`null` once the newest message has been returned); pass its value back as the `nextToken` input to fetch the next newer page. Their `nextToken` stays the standard backward cursor, so older continuation is ordinary paging (and `truncated` remains tied to older history alone). Both cursors index from the oldest end, so both are append-stable. Absent both seek params (and any seek-minted forward token), the response is **byte-identical** to before — the `prevToken` key is never added on legacy backward pages. `turnInFlight`/`lastStreamActivityAt` are the STAB-125 turn-liveness fields (same semantics as `agent.get`; here `lastStreamActivityAt` is always present and `null` when no turn is in flight — a deliberate surface asymmetry with the `AgentLite` projection of `agent.list`/`agent.get`, which **omits** the field instead) so a conversation read mid-turn — when nothing has persisted yet — is distinguishable from a wedged agent. **Serve-time block ids ([monorepo#1114](https://github.com/intent-hq/monorepo/issues/1114), [intent-hq/intentd#781](https://github.com/intent-hq/intentd/pull/781)):** every served content block carries an `id` — a block persisted id-less (non-assistant rows: `user`/`system`/`tool`) is stamped with the stable synthetic `{messageId}:{index}` (the row id + the block's 0-based index in the served array, stamped after the anonymous-tool-block strip) at serve time; assistant blocks always persist with ids, so the pass is a no-op for them. Serve-time only — stored rows are untouched, reads stay idempotent, no migration. Because the §7.1 seq-0 chat snapshot and the delta path's re-read both go through this method, snapshots, `agent.getConversation`, and §7.1 deltas agree byte-for-byte on block identity. **Legacy inline file blocks (v10.0; [intent-hq/intentd#1878](https://github.com/intent-hq/intentd/pull/1878)):** a persisted pre-10.0 user-row block `{ type: "file", data, … }` with no non-empty `attachmentId` is served as `{ type: "text", text: "Attached file: <fileName>" }` (`"Attached file"` when `fileName` is missing or blank) — bytes dropped, the block's `id` carried over when it has one — in BOTH projections, before the synthetic-id stamp; attachment-reference file blocks and every other block type pass through untouched (serve-time only, stored rows never rewritten — see the file-block contract on `agent.sendMessage`). **Slim projection (the wire default since v8.0; introduced opt-in as `projection` within v7.1 — [intent-hq/intentd#1304](https://github.com/intent-hq/intentd/pull/1304)):** the read serves bounded tool/image block bodies so large transcripts never produce multi-MB RPC frames. Absent / `null` selects slim (the v8.0 default — BREAKING over the v7.1 byte-identical opt-in contract, so the unbudgeted full read is unreachable over the wire) and `projection: "slim"` is an explicit no-op; any other value is `-32602`, never coerced. Under slim: an oversized `tool_use.input` / `tool_result.output` body (over the ~2 KiB `SLIM_PROJECTION_BUDGET_BYTES` budget) is replaced by a bounded preview with the additive flags `inputTruncated: true` + `inputBytes` (resp. `outputTruncated` + `outputBytes` — the byte size of the full body), object inputs keep their keys (entries admitted smallest-value-first within the budget, so classifyTool's small scalar keys survive giant blob siblings) and the structural/pairing fields (`name`, `toolCallId`, `tool_use_id`, `is_error`, block `id`) always pass through untouched; an oversized `image.data` is replaced by the write-time thumbnail persisted at message-append time (max 256px edge; `dataTruncated: true`, `dataIsThumbnail: true`, `dataBytes` = full size), and a legacy pre-thumbnail row serves the block with `data` **omitted** (`dataTruncated: true`, no `dataIsThumbnail`); under-budget blocks are byte-identical with no flags. The same param on `chat.subscribe` (§7.1) fixes the projection for a subscription's snapshots and live deltas, so slim snapshots and deltas agree. Fetch a truncated block's full body on demand via `agent.getMessageBlock` (below). **Image dimension sidecar (v10.7, additive; presence-detected — stable inline chat image sizing):** two optional fields let a client reserve a correctly sized box before image bytes arrive; the message text is never rewritten. (1) A `text` block gains `media?: { [src: string]: { width, height } }` — one entry per Markdown image reference (the `![alt]` form; its parenthesized target is the `src`) in the block's `text` whose source could be probed, keyed by the `src` string **exactly as written** (pre any client rewriting; the client looks up the rendered image by that same string), valued by the intrinsic pixel `width` / `height` read from the image header (no full decode). Probed sources: `workspace-asset://<wsId>/<assetId>` (the assets root), `intent://local/[<wsId>/]file/<path>` and bare workspace-relative paths (resolved within the workspace root); `http(s)://` and `data:` sources are never probed and never appear. **Omitted when nothing resolved** — never `{}` or `null`. On the live `chat.subscribe` path each text chunk delta carries only the entries that chunk resolved and the client unions them (§7.1 "Text-block `media` on live deltas"); the persisted block's `media` is that union, so snapshot and reduced deltas agree. (2) An `image` block gains `width?` / `height?` — the intrinsic pixel dimensions of the **original** image, stamped when the block is persisted; omitted when they could not be read. **Slim projection keeps both:** `media` is not a body and passes through untouched, and `width` / `height` pass through alongside `dataTruncated` / `dataIsThumbnail` — they always describe the original, never the 256px thumbnail, so a client sizes the box from them regardless of which `data` it holds. **Computed on the write/stream path, never on read:** a text reference is probed as the streaming text completes it — before the corresponding `chat.subscribe` delta is emitted — and the accumulated `media` union is what gets persisted; an `image` block's `width` / `height` are stamped once, when the block is persisted. This read and the `chat.subscribe` snapshot serve the stored JSON as-is — no read-time probe, no backfill — so rows persisted before v10.7 carry neither field and clients fall back to their previous rendering. **Slim page byte budget (introduced additive — [intent-hq/intentd#1314](https://github.com/intent-hq/intentd/pull/1314)):** the served page is additionally bounded by `SLIM_PAGE_BUDGET_BYTES` (512 KiB) total serialized message bytes — the per-block budget caps each body, but `limit` counts messages and a message can carry hundreds of capped blocks, so a message-counted slim page could still serialize to multiple MB. `limit` is therefore a **maximum**: the read stops early once the page would exceed the budget, keeping the page's anchor end (newest for legacy backward pages, oldest for `prevToken` forward continuations, the target message — grown outward within budget — for seek pages) and always serving at least one message (a single over-budget message serves alone; never an empty page or a token loop). The continuation cursor(s) — `nextToken`, and `prevToken` on the seek path — are re-minted at the first excluded row, so an existing token walk resumes seamlessly and reconstructs the identical sequence as unbudgeted paging, just in more round-trips. Frame ceiling = budget + the slim size of the last admitted message — NOT a hard bound: the ≥1-message floor means a single message with enough capped blocks can alone exceed the budget (and even the transport's 1 MiB large-frame warn), so the budget bounds the typical page at ~512 KiB but the worst case degrades to one whole message per page rather than a guaranteed frame size. `totalMessages` / `truncated` semantics are unchanged (transcript-wide, not page-length), and the seq-0 `chat.subscribe` snapshot inherits the bound automatically (it reuses this read) — since v8.0 every wire read is a slim read, so every wire read is budgeted |
| agent.getMessageBlock *(v7.2)* | agentId (req), messageId (req), blockId (req), workspaceId? | { block } — one **FULL** content block of one persisted message, by block id: the on-demand counterpart of the slim projection above — a client holding a `*Truncated` slim block fetches the complete body here. The row is served through the same anonymous-tool-block strip, v10.0 legacy-inline-file-block text projection (a persisted `{ type: "file", data, … }` block with no non-empty `attachmentId` resolves as its `{ type: "text", text: "Attached file: <fileName>" }` projection — the bytes are never served; see the `agent.getConversation` row), and synthetic-id stamp passes as `agent.getConversation` (NEVER the slim bounding), so block identity matches the served conversation byte-for-byte: persisted assistant block ids and the serve-time synthetic `{messageId}:{index}` ids (monorepo#1114) both resolve, and the returned block is the full, unprojected body — no `*Truncated`/`*Bytes` flags (for a retained body; see the retention-pruned case below), images carry the original `data`, never the thumbnail, and the v10.7 image dimension sidecar fields (`media` on a `text` block, `width` / `height` on an `image` block — see `agent.getConversation`) are served exactly as persisted. Bounded cost (the RPC cost contract): a metadata-only session scope check plus one primary-key message lookup with bounded full-payload and pruned-kind side-row reads, all from the same store snapshot (the pruned-kind read runs for every existing message, not only pruned ones; see the retention-pruned case below) — at most ONE message is decoded and the transcript is never hydrated. Errors: an unknown `messageId` (or one belonging to another agent) is `-32602` naming the id (`unknown message id: <id>`); a `blockId` that resolves no block in that message (including an out-of-range synthetic index) is `-32602` naming the id (`unknown block id: <id>`); an unknown `agentId` or a `workspaceId` mismatch is the not-found error (`-32602` with `error.data.code: "not-found"`, fail closed — same scope guard as `agent.getConversation`). A block whose serialized response exceeds the 40 MiB outbound frame cap (§1) surfaces as the standard `-32010` oversized-response error naming `responseBytes` and the limit — explicit, not a hang; such a block is rare by construction (the matching inbound cap bounds what clients can persist) and is equally unservable via unprojected `agent.getConversation`, where it takes the whole page down rather than just itself. The slim flags (`inputBytes`/`outputBytes`/`dataBytes`) carry the full body size, so a client can predict the fetch size before calling. **Retention-pruned bodies ([intent-hq/intentd#1757](https://github.com/intent-hq/intentd/pull/1757), additive):** when the `agents.toolPayloadRetentionDays` sweep (§5.12) has compacted a `tool_use` input / `tool_result` output side-table body into its replay-shaped preview, the full body no longer exists anywhere, so the "full body, no flags" guarantee above applies only to **retained** bodies. Such a block is served as the stored slim preview with its `inputTruncated` / `outputTruncated` (+ `inputBytes` / `outputBytes`) flags intact, PLUS the additive presence-detected `inputPruned: true` (on a `tool_use` block) / `outputPruned: true` (on a `tool_result` block). Two distinct preview shapes exist and this method serves only the first: the **write-time slim preview** (the head of the body kept inline in `agent_message.content`, the same shape `agent.getConversation` pages serve) and the **replay preview** the sweep stores in its place (a head/tail middle-truncated string at `agents.historyReplayToolContentChars` plus the original character count) — the latter is consumed only by the recovery replay that rebuilds a lost ACP session and is never returned over the wire — so a client can tell "the full output is no longer retained" from "the fetch returned the full body" and does not re-request in a loop. The flag is decided from **store-side compaction metadata** read from the SAME store snapshot as the body — a `*_replay` side row present for that block's field with no full-body row — never inferred from surviving `*Truncated` flags: a retained full-body row that fails to decode, or a body that arrived pre-flagged and was never externalized, is served flags-and-all exactly as before and is **never** flagged pruned; retained bodies carry neither key (absent, never `false`), so with the sweep disabled (`agents.toolPayloadRetentionDays = 0`, the default) the response is byte-identical to the pre-#1757 shape — and a pruned block stays pruned after the setting is turned back off (the deleted body is not restored) and across `agent.editAndRegenerate` (suffix-only truncation: the kept prefix keeps its ids, `seq` and side rows, `*_replay` included, untouched). `agent.getConversation` output is unchanged for pruned and unpruned blocks (the slim projection already served the same preview + flags, and pruning never touches the inline `agent_message.content` column) |
| agent.listUserMessages *(v7.4)* | agentId (req), previewChars?: number, workspaceId? | { agentId, items: [{ id, preview, createdAt, metadata? }], total } — all **user-role** messages of one agent as lightweight index items, oldest→newest (transcript `seq` order); non-user rows are never included. `preview` is the message's extracted plain text (a bare-string `content` passes through, a block array joins its `text` fields, any other shape falls back to its compact JSON encoding — the same extraction the FTS index uses) truncated to `previewChars` characters (default 300, server-clamped into [1, 2000]; truncation is char-boundary safe — SQLite `substr` counts characters, not bytes). **Lenient `previewChars` parsing (deliberate):** the param follows the standard `opt_int` transport convention — a non-numeric value (e.g. a string) is treated as absent → default 300, and a float truncates toward zero — which diverges from the stricter v7.1 `aroundIndex` convention ("a negative or non-integer value is `-32602`"); out-of-range numbers clamp, never reject. **Unpaged + verbatim `metadata` (deliberate):** the index has no LIMIT/paging — every user row is returned — and `metadata` is the caller-supplied opaque `messageMetadata` persisted on the row, passed through **verbatim** when present (omitted when absent, never `null`), so clients can distinguish automated rows (e.g. `{ source: "system" }` wakes); it is bounded only by the inbound frame cap at persist time, so clients must treat it as potentially large. Bounded cost (the RPC cost contract): a metadata-only session scope check plus ONE role-filtered SQL read whose previews are extracted and truncated **inside SQLite** — full `content` blobs never leave the database and the transcript is never hydrated, so per-row cost is O(previewChars) regardless of message size. Errors: an unknown `agentId` or a `workspaceId` mismatch is the not-found error (`-32602` with `error.data.code: "not-found"`, fail closed — same scope guard as `agent.getMessageBlock`); a missing `agentId` is `-32602` |
| agent.getCreationPreferences | workspaceId (req) | { specialistId?: string or null } — last explicitly remembered manual specialist in this workspace. Missing means no preference; null means General. Shared by clients and durable across daemon restart. No provider, model, or effort is remembered. Workspace membership required. |
| agent.create | workspaceId (req), name?, nameExplicitlySet?: bool, model?, reasoningEffort? *(v5.2)*, specialistId?, idempotencyKey?, provider?, agentType?, metadata?, workspacePath?, workspaceContext?, contextReferences?, imageBlocks?, fileBlocks? *(v6.12; attachment references only since v10.0)*, isBackground?, rememberSpecialist? (boolean; [manual memory](#manual-specialist-memory)) | { agent: AgentLite } — full projection (same shape as `agent.get`); the pre-P2-12a `{ id, name }` snippet is a strict subset. `reasoningEffort` (v5.2) persists on the session **as-is** (the caller's spelling; providers interpret the level); an empty or whitespace-only value collapses to unset (an explicit clear that stops the resolution chain), and the created `AgentLite` echoes it. `effortLevels` is absent on the create result — the field is session-discovered at session open (see "Session-discovered effort levels" below), so it appears on subsequent `AgentLite` reads once the provider's first session open advertises its `thought_level` values. When the param is absent the effort resolves through the named specialist's model-option effort, then its `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12) — which applies only when the session's model itself resolved from the settings default chain, never alongside a caller-supplied `model` or a specialist model pin, and is dropped with a daemon warn log rather than rejected when the resolved model does not support it — then unset. The full chain is "Creation-time reasoning-effort resolution" below. A non-empty level is **validated against the resolved model's cached `effortLevels`** under the same contract as `agent.delegate` / `agent.wakeOrCreate` (§5.11 "Delegation reasoning-effort resolution"): evidence is the daemon's cached dynamic catalogs only (never a live probe), matching is case-insensitive, a level outside the listed values is rejected with `-32602` naming the model and the valid values **before any side effect** (no session row is persisted), and with no evidence — no resolved model, no cached row, or a row declaring no levels — the value passes through unvalidated. The agent's id is **server-assigned**: the daemon always mints a fresh `agent-{uuid}`, and a request carrying `agentId` is rejected with `-32602` ("agent IDs are server-assigned and the field must be omitted") before any side effect; an `idempotencyKey` replay returns the stored result carrying the originally minted id. `provider` persists on the session. `model` must be a **bare** model id ([intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)): a compound `provider:model` value is rejected at the wire boundary with `-32602` (`model must be a bare model id without ':' (got "<value>"); pass the provider separately alongside the bare model`) **before any side effect** — the compound-id encoding is retired; pass `provider` separately. An explicit `provider` must name a registered ACP provider: an unknown id is rejected with `-32602` (`agent.create: unknown provider: <id> (known providers: ...)`) **before any side effect** (no session row is persisted, no default-provider fallback occurs). An absent `provider` is valid only when the settings-derived default (`model.defaultProvider`, §5.12) resolves: with neither set the call is rejected with `-32602` (`agent.create: no default provider/model is configured — no explicit provider or model was given and model.defaultProvider is not set. Choose a provider in Settings > Agents, or pass an explicit provider/model.`) rather than persisting a session that could never resolve a spawn provider ([intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044); [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)). A **bare** `model` (no `:` prefix) supplied by the client is additionally checked for ownership: evidence is **the daemon's cached dynamic catalogs only** (the in-memory last-good `models.list` entries under each provider's current registry version key, §5.30 — read-only, never a live probe; the former static-tier evidence path went with the tier tables, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)). The effective provider for the check is the explicit `provider` param, else the settings-derived default (`model.defaultProvider`, §5.12 — [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648); `providers.active` is retired and there is no positional last resort, [intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)). A cached-catalog claim by another provider rejects with `-32602` (`agent.create: model <id> does not belong to provider <p> (providers with this model: ...)`) before any side effect, but only when the effective provider's ownership is affirmatively disproven — its own cached catalog exists but lacks the id; with no cached entry for the effective provider (cold start) the bare id passes — absence of evidence is not a mismatch. Bare ids with no ownership evidence anywhere pass unchanged, and the literal id `"default"` is a CLI-default sentinel that passes for every provider. A mismatched bare model arriving from the **settings chain** (global default / specialist frontmatter) rather than the client is not rejected — it falls back to the provider's CLI default (`session.model` stays unset) with a daemon warn log. **Specialist validation (strict, monorepo#3497).** A supplied `specialistId` must resolve into the `specialist.list` catalog: an alias is canonicalized to the claiming specialist's canonical id before persistence (e.g. `"coordinator"` persists `"spec-writer"`), a directly-known cataloged id passes through unchanged, and any other id — one that resolves to no known id or alias across the 3-tier catalog (project > user > bundled), or resolves only to an id the catalog excludes (the retired `ralph`) — is rejected with `-32602` (`unknown specialist: <id> (known specialists: ...; aliases are accepted)`) **before any side effect** (no session row is persisted); the advertised known-id list is exactly the `specialist.list` catalog, so the validator accepts nothing the list does not advertise. The same strict validation applies at every spawn/update seam that accepts a specialist id: `agent.delegate` (the top-level `specialist` — on the batch form it is the shared default and an unknown value fails the whole call with one `-32602` before any row starts, like the top-level `provider`; an unknown per-`tasks`-entry override stays a per-row `error` disposition; on the single-task form it is rejected before provider/effort resolution), `agent.wakeOrCreate`'s create branch (`create.specialist`, validated even when an inherited specialist takes precedence, and before the stale-assignment purge so a rejection leaves task state untouched), `workspace.create`'s `initialAgent.specialist` (§5.1), and `agent.update`'s `specialist` field — with one carve-out: a STALE specialist inherited from a previous session by `agent.wakeOrCreate` (persisted before this validation, or whose user/project file was since deleted) is dropped with a daemon warn log instead of failing the wake (legacy stored state is never client input), falling back to the already-validated `create.specialist` when one was supplied, else no specialist. **Name default (specialist-derived).** When `name` is omitted but a specialist id is supplied, the agent's name defaults to the specialist's resolved display name (frontmatter `name`, 3-tier project > user > bundled — e.g. "Coordinator" for `spec-writer`); a resolution failure on a known specialist never fails the create — the name falls back to the generated `Agent {6-hex}` placeholder. The same derivation applies to `workspace.create`'s `initialAgent` (§5.1). `nameExplicitlySet` controls the persisted rename-guard flag: `false` marks a supplied `name` as a non-explicit placeholder so the agent's guarded opening-turn self-rename (`agent.rename` with `skipIfExplicitlySet: true`) still applies. The flag is honored independently of `name` — supplied without a `name`, it applies to the server-generated placeholder name (`nameExplicitlySet: true` with no `name` persists the guard on the placeholder). Omitted or JSON `null` both read as absent and keep the default (`true` whenever a `name` is supplied; `false` for an omitted name, including specialist-derived display names and the `Agent {6-hex}` fallback); any other non-boolean value is rejected with `-32602` ("nameExplicitlySet must be a boolean") — `null` is never rejected. `metadata` is harvested for the persisted gap fields (`delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`, `fileBlocks` (v6.12); P3-1.2b — plus `isBackground`, G-A1/P3-1.2c) with the top-level `contextReferences`/`imageBlocks`/`fileBlocks`/`isBackground` params winning over the `metadata` copies; `isBackground` defaults to `false` when absent from both. `fileBlocks` entries (v6.12; attachment references only since v10.0 — every entry must carry a non-empty `attachmentId`, and an entry carrying inline `data` or missing `attachmentId` is `-32602` naming the block index; see the file-block contract on `agent.sendMessage`) and `imageBlocks` entries (within v7.4, monorepo#3338; exactly one of `data` / `attachmentId`) are validated at the create seam under the same rules as `agent.sendMessage` (`-32602` before any side effect; image references additionally validated against the attachment registry — see the image-reference block on `agent.sendMessage`). `agentType`/`workspacePath`/`workspaceContext` remain accepted-but-unpersisted (deferred per the P2-12a audit). Emits `agent:created`. |
| agent.delegate | workspaceId (req) + delegate opts (taskNoteId?, noteId?, taskText?, agentInstructions?, specialist?, model?, provider?, reasoningEffort?, behaviorPrompt?, waitMode?, skipAutoCommit?, isolation?, force?: bool, tasks?: [taskNoteId | { taskNoteId, specialist?, model?, provider?, reasoningEffort? }]) | `{ ok: true, agentId, name, provider?, effectiveIsolation? }` (single-task form; see the batch form below) — **Reasoning effort (additive).** `reasoningEffort` sets the child session's reasoning level (§5.5); when omitted it resolves through the chosen specialist model option's `reasoningEffort`, then the specialist's `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12; only when the session's model itself resolved from the settings chain — and dropped with a warn instead of rejected when unsupported), then unset. Whatever resolves is validated against the cached catalog's `effortLevels` for the resolved model and a level outside that list is rejected with `-32602` naming the valid values **before any side effect**; with no cached evidence the value passes through (full contract in §5.11 "Delegation reasoning-effort resolution"). the child session persists the resolved first message as `AgentSession.initialMessage` (served by `agent.getSession` only — off the `AgentLite` projection, intentd#1542) and `metadata.delegationDepth` (parent depth + 1) so a wake-up can resume (P3-1.2b); delegated children always persist `isBackground: true` (matching the TS `DelegateTaskTool`; G-A1/P3-1.2c). **Explicit `provider` param (additive; [intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)).** `provider?` names the delegated child's ACP provider explicitly — the disambiguator for models that exist under multiple providers (a bare `model` plus `provider` runs that model on the named provider). It outranks every derived resolution rung below (specialist frontmatter, settings default). It must name a known, available provider — an unknown id is rejected with `-32602` naming the known providers, and a known-but-unavailable one with `-32602` naming it — and `model` must be a **bare** model id: a compound `provider:model` value — top-level or per-`tasks` entry, where the offending param is named `tasks[<i>].model` — is rejected with `-32602` (`model must be a bare model id without ':' (got "<value>"); pass the provider separately alongside the bare model`) ([intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)). All rejections land **before any side effect** (no child session is created). On the batch form the top-level `provider` is the batch default and a per-entry `provider` overrides it for that task only, inherited field-by-field exactly like `specialist`/`model`/`reasoningEffort`. **Derived provider resolution when `provider` and `model` are both omitted.** A caller that supplies neither `provider` nor `model` resolves the delegated agent's provider itself, in order ([intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)): (1) the specialist's frontmatter `codingAgent` — 3-tier resolved (project > user > bundled; a legacy compound frontmatter `model` splits on read into `codingAgent` plus the bare `model`, the prefix winning, [intent-hq/intentd#1654](https://github.com/intent-hq/intentd/pull/1654)); (2) otherwise the settings-derived default `model.defaultProvider` (§5.12; registry-validated and whitespace-trimmed, so a stale or mistyped value reads as unset); (3) if neither resolves, the call fails with `-32602` (`agent.delegate: no default provider/model is configured — no explicit provider or model was given and model.defaultProvider is not set. Choose a provider in Settings > Agents, or pass an explicit provider/model.`) — the former positional last resort (the first registered provider) is removed ([intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)): resolution that falls through entirely now fails loudly at the front door instead of leaving `provider` unset and silently spawning a binary that may not be installed. Whichever provider is resolved by (1) or (2) MUST be a known, available provider (per the daemon's provider discovery) — an unavailable resolved provider fails the call with `-32602` naming it, rather than silently substituting another provider. A `model` explicitly supplied by the caller (always a bare id) opts out of this derived resolution entirely, unchanged — and an explicit `provider` param short-circuits it outright (see above). **`provider` result field (additive response field, presence-detected).** The single-task result surfaces the resolved ACP provider persisted on the created session (the same value `AgentLite.provider` serves) as `provider?: "<id>"` — so clients can render the correct provider affordance immediately, before the agent session loads. Omitted — never `null` — when the session has no persisted provider (possible only for a session created with an explicit `model`, which opts out of derived provider resolution). The batch form's `started` rows are unchanged (`agentId`/`agentName` only). **Occupancy guard (intentd#774).** A task note that already has a live assigned agent cannot be silently double-delegated: when the target task's newest assigned agent is live — loadable, not Deleted, not poisoned (the same live/resumable predicate as `agent.wakeOrCreate`'s newest-first scan) — and the task status is not `complete`/`cancelled`, the call is rejected with `-32602` (InvalidParams); the error message names the existing agent's id and name and suggests `agent.sendToTask` / `agent.wakeOrCreate` to reach it, or `force: true` to intentionally add a second agent. The guard runs BEFORE any side-effectful work (child creation, group enrollment), so a rejection leaves no orphaned child. `force: true` bypasses the guard; `agent.wakeOrCreate`'s behavior is unchanged (it already routes to the existing live agent). `task.assignAgent` applies the same guard when assigning a NEW agent to an occupied task (§5.4). **Sandbox isolation (new in intentd).** `isolation` controls whether the delegated agent runs in an isolated sandbox: `"cow"` provisions a copy-on-write directory clone (requires CoW filesystem support; see below), `"direct"` runs in the shared workspace checkout. When `isolation` is omitted, the default comes from the `workspace.cowIsolation` setting (§5.12): enabled ⇒ `"cow"`, disabled ⇒ `"direct"`. CoW sandboxes are full-directory clones of the sandbox source (including `.git` and build caches) via OS-level copy-on-write primitives (macOS `clonefile(2)` whole-tree fast path with best-effort walk fallback on APFS, Linux `ioctl(FICLONE)` on Btrfs/XFS with reflink support); the sandbox directory layout is `<workspaces_root>/<workspaceId>/sandboxes/<agentId>/<repo-slug>` with a snapshot branch `sb/<agentId>` created in the sandbox's `.git`. **Sandbox eligibility & source (checkout-mode aware).** Shared-checkout workspaces (`skipIsolation`/no provisioned checkout, i.e. no `checkoutMode`, with a `repositoryPath`) source the sandbox from the user's repository folder; CoW-checkout workspaces (`checkoutMode: "cow"`, §5.1) source it from the **workspace checkout** (`worktreePath`); `checkoutMode: "direct"` workspaces (standalone plain clone) source it from the workspace checkout when one was provisioned (cache hydration), else from the repository folder itself (`isNewRepo` initialization). Worktree-mode workspaces (`checkoutMode: "worktree"`) are not sandbox-eligible — the agent keeps the shared checkout and the delegation proceeds without a sandbox. **Asynchronous provisioning & `effectiveIsolation` (changed by intentd#636).** Sandbox provisioning runs OFF the delegate critical path: when `isolation: "cow"` resolves and the workspace is sandbox-eligible, the daemon registers a per-agent settlement gate, kicks off the CoW clone in a background task, and returns immediately with `effectiveIsolation: "pending"` — the only value the field carries today (`"cow"` and `"direct"` are no longer returned; a large clone can take tens of seconds, which previously starved the agent-facing MCP `workspace_api` tool's per-invocation wall-clock budget — `WORKSPACE_API_TIMEOUT`, default 30s, overridable via the `INTENTD_WORKSPACE_API_TIMEOUT_MS` env var: a positive integer in milliseconds, read at MCP-server construction; unset, non-numeric, or non-positive values keep the default). `effectiveIsolation` is omitted when no CoW isolation was resolved (explicit `"direct"`, setting disabled, the worktree-mode ineligibility skip, or no sandbox source). The settled outcome is observable rather than returned: on success the child session's TOP-LEVEL fields (not nested under metadata) `sandbox_id`, `sandbox_path`, and `sandbox_branch` are persisted and served in both `AgentSession` and `AgentLite`, and a `sandbox:cow:created` event is emitted with `data { workspaceId, agentId, sandboxPath, branch, baseCommitSha, snapshotCommitSha }`; when the filesystem does not support CoW reflinks — or provisioning fails — the daemon falls back to shared (`"direct"`) mode exactly as before (no bytes copied, log-only): the session keeps no sandbox fields and no `sandbox:cow:created` fires. A third settlement outcome covers the delete race: because the clone runs off the delegate critical path, `agent.delete` can race it — when the child session is gone or soft-deleted by settlement time, the daemon discards the just-provisioned sandbox (directory + store record) instead of stranding the clone on disk; again no sandbox fields persist and no `sandbox:cow:created` fires. The child's first ACP spawn is gated on settlement: its turn worker awaits the in-flight provisioning before spawning, so the child never runs against a half-copied sandbox. The sandbox directory is never auto-cleaned once settled — except for the delete-race discard above — cleanup is otherwise the responsibility of higher-level orchestration. All agent file/exec/terminal/search operations are restricted to the sandbox path when present (logical containment guards in `intent-services`), preventing escape to the main workspace or parent directories. **Batch form (`tasks`, within v6.8; reworked in v7.0 — part 2 of monorepo#2457).** `tasks: [entry, ...]` (non-empty; each entry either a bare taskNoteId string or an object `{ taskNoteId, specialist?, model?, provider?, reasoningEffort? }` whose per-task options override the call's top-level defaults for that task only; every named id must be a task note in the workspace, else `-32602` naming the unknown ids; mutually exclusive with `taskNoteId`/`noteId`/`taskText` — mixing rejects with `-32602`) switches the call to batch mode with the result shape `{ ok: true, tasks: [row], startedTaskIds, summary: { started, held, skipped, errors }, warning?, unlockPlan: { unlockedBySettlement, message, criticalPathMinutes? } }` — every supplied task is enumerated (deduped, order-preserving), nothing silently omitted. **Zero-started summary + warning (within v7.0, additive — [intent-hq/intentd#1442](https://github.com/intent-hq/intentd/pull/1442), [monorepo#3334](https://github.com/intent-hq/monorepo/issues/3334)).** `summary` carries the top-level disposition counts (`held` totals both hold flavors) so a shallow read of the result surfaces the outcome without parsing the rows; counts always sum to the deduped row count. `warning` is present ONLY when `started == 0` (presence-detected; never `null` or empty): a prominent `NO TASKS STARTED — <breakdown>...` string naming the per-reason breakdown (held on unmet dependencies / held on conflicts / skipped / failed to start) and instructing the caller to resolve the holds and re-call `agent.delegate`. Additionally, a zero-started batch under `waitMode: "after_all"` owes the caller a settlement wake that can never arrive (no child enrolled, so no delegation group was formed or extended): when the calling agent has no OPEN delegation group left over from earlier delegations, the daemon delivers an immediate advisory wake message to the caller (best-effort — a delivery failure is logged and never fails the call) naming the same breakdown, so the silence cannot become a permanent stall; when an open group exists, its eventual settlement is the wake and no advisory is sent. Classification is a PURE, STATELESS function of current state (task statuses, `dependsOn`/`conflictsWith` edges, live assigned agents — the same live/resumable predicate as the occupancy guard above); the call writes NO scheduler state, which is what makes re-supplying the same list idempotent. Each row carries `taskNoteId`, `title`, `disposition`, `reason` (on every non-started row), and per-disposition fields: `started` (delegated through the unchanged single-task path — per-task agent creation and group enrollment honoring `waitMode`, with `behaviorPrompt`/`skipAutoCommit`/`isolation` inherited per task and `specialist`/`model`/`provider`/`reasoningEffort` resolved per task — the entry's own value when present, else the call's top-level default; carries `agentId`/`agentName`); `held:blocked-on-deps` (`unmetDependsOn` names the incomplete dependency ids; the `decisionNeeded` subset names cancelled/missing dependencies that can never complete on their own — surfaced in the reason as "decision needed"; failed/cancelled dependencies need no special wake path — they simply reappear here on the next call); `held:conflict` (`conflictsWith` names the running/starting tasks whose symmetric `conflictsWith` closure overlaps this one; the reason points at delegating the held task individually to force it — the conflict relation is evaluated symmetrically over ALL workspace task notes, so a running non-listed task still holds a listed one, and tasks started earlier in the same batch count toward the running set for later entries. **Admission order (within v6.8, [intent-hq/intentd#1112](https://github.com/intent-hq/intentd/pull/1112)):** startable tasks are admitted in **effort-weighted critical-path priority order**, not list order — a deterministic list-scheduling heuristic, deliberately not an exact solver (makespan minimization under `dependsOn` + `conflictsWith` is NP-complete). Each workable task's priority is its own effort plus the longest effort-weighted chain of workable dependents downstream of it (one topological pass over the reverse-`dependsOn` graph); efforts come from a best-effort parse of the task's free-form `estimatedEffort` string — units min/h/d with a day counted as 8 work-hours (e.g. `"30 min"`, `"2h"`, `"~45m"`, `"1h 30m"`, `"1d"`), hyphenated ranges → midpoint (`"1-2h"` → 90; a failed range parse falls through to a plain parse, so `"90-minute"` → 90), parsed values clamped to a 175,200-minute cap (a year of 8-hour workdays), unparseable/missing estimates defaulting to a neutral 30 minutes. Startable tasks are admitted in descending priority, holding any whose `conflictsWith` closure intersects the admitted/running set — so a conflict resolves in favor of the task heading the longest remaining dependent chain, not the one listed first; ties break by most distinct dependents unlocked (`dependsOn` edges deduped per note), then shortest own effort, then task id — fully deterministic); `skipped` (already running — carries the live `agentId`/`agentName` — or task status `complete`/`cancelled`); or `error` (a start-classified task whose individual delegation failed; earlier rows may already have started — the batch never rolls back). **Relation-less annotation (within v7.0, part 3 of monorepo#2457 — [intent-hq/intentd#1237](https://github.com/intent-hq/intentd/pull/1237)).** A row whose task the relation graph does not cover — its own `dependsOn` and `conflictsWith` both empty AND not referenced by any other REQUESTED task's relations (references count from requested tasks only, so an edge from an unrequested note does not cover a requested one) — additionally carries `relationsUnknown: true` (presence-detected additive field; omitted when the graph covers the task, never `false`). Annotation only: classification is untouched — the flag never changes a disposition — and when any flagged tasks actually start, `unlockPlan.message` additionally appends `N of M started tasks carry no relations — the graph does not cover them.`, so a caller can tell "ready by the graph" apart from "the graph says nothing about this task". `unlockPlan.unlockedBySettlement` projects from the dependency graph — by simulating the ACTUALLY-started set (a start whose delegation errored never counts) plus EVERY workable task with a live assigned agent, requested or not, completing — which held tasks become startable at settlement, and `message` instructs the caller to re-call `agent.delegate` then (same list or a subset; classification is recomputed every call). `unlockPlan.criticalPathMinutes` (optional, within v6.8 — [intent-hq/intentd#1112](https://github.com/intent-hq/intentd/pull/1112)) is the remaining serial work: the longest effort-weighted `dependsOn` chain through the requested tasks (their critical-path priority already spans all downstream dependents), also echoed into `message` as `~N min of serial work remains on the critical path.`. Present only when at least one requested task's max-attaining chain carries a parsed estimate: the max is taken over estimated chains only (within v6.14, [intent-hq/intentd#1160](https://github.com/intent-hq/intentd/pull/1160), monorepo#2128 — previously the single global max chain had to be estimated, so a longer chain of pure 30-min defaults suppressed the estimate entirely), so a pure-defaults-only graph still omits the field (never `null` or `0`), a longer unestimated chain neither suppresses nor inflates the estimated one, and the reported number reflects only estimated chains — it can understate when an unestimated chain is longer. Deliberately downstream-only: an incomplete upstream dependency outside the requested set does NOT count toward the estimate, so partial batches can understate total remaining serial time. Response text only — the field changes no wake or settlement behavior. The daemon NEVER auto-starts held tasks; the existing delegation-group settlement wake (`waitMode: "after_all"`) is the resume signal. The delegation-depth and watch-scope guards run once up front (`-32602` before any child is created). Batch mode rejects `agentInstructions` (top-level AND per-entry) and `force: true` with `-32602` rather than silently dropping them (each started task's first message resolves from its own task note, and occupied tasks classify as `skipped` — use the single-task form to force a second agent). **`greedy` removed (v7.0, breaking).** The former batch-level conflict override is gone: a request passing `greedy` (any value) is rejected with `-32602` ("greedy was removed; delegate a held task individually to force it past the conflict hold"), the result no longer echoes `greedy`, and `started` rows never carry conflict overlap — the single-task form already bypasses classification, so it is the one force path. Single-task calls (`tasks` absent) are byte-identical to the pre-batch contract above |
| agent.sendToTask | taskNoteId (req), message (req), priority?, messageMetadata? | service result — `priority: "interrupt"` preempts the assignee's in-flight turn keep-alive (the agent process is never killed) and delivers immediately instead of the plain persist. **MCP binding default (behavior only, within v7.0 — [intentd#1292](https://github.com/intent-hq/intentd/pull/1292)):** the agent-facing `ws.agent.sendToTask` binding resolves an omitted (or `null`) `priority` to `"interrupt"` before calling this RPC — the explicit `priority: "queue"` opt-out restores queue-if-busy delivery by mapping to `"normal"`, and every other explicit value passes through unchanged; the wire default for an omitted `priority` on this RPC itself is unchanged (plain persist / queue-if-busy). `messageMetadata` is the same opaque per-message payload as `agent.sendMessage`, persisted on the assignee's user message row; it is threaded through both the runtime turn path and the store-only fallback (read-only wiring with no agent manager), so attribution is consistent across deployments. **Pending questions (v9.5, [intentd#1710](https://github.com/intent-hq/intentd/pull/1710)):** the assignee's pending structured-question marker (§5.5 "Pending questions") does not gate this delivery — the message delivers (or queues on the ordinary busy path) on the runtime and store-only paths alike, and the marker survives it; the v2.8 `heldForQuestions: true` park result is retired |
| agent.sendMessage | agentId (req), content (req), workspaceId (req), messageId?, imageBlocks?, fileBlocks?, priority?, noteIds?, stdinContext?, contextReferences?, messageMetadata?, model?, assistantMessageId?, assistantAppMessageId?, userAppMessageId? | { success, queued, messageId? \| queuedMessage?, turnId? } — **Unknown agent → fail closed.** A nonexistent `agentId` (e.g. a truncated id) is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE any state change — no phantom queue entry, no slot claim, no interrupt-dedup record — on both the runtime-manager and store-only paths, and the same guard applies to the SUB-1 sender auto-subscribe (the MCP `ws.agent.send` binding's caller→target completion watch is never registered for a nonexistent target). **SUB-1 sender auto-subscribe is one-directional (parent→child only).** The MCP `ws.agent.send` / `ws.agent.sendToTask` bindings register a caller→target completion watch for the sender UNLESS the sender is a **child of the target** — the caller session's `parent_agent_id` equals the target, falling back to the metadata `createdByAgentId` linkage — so a child messaging its own parent registers NO watch and the send result carries no `subscriptionId`/notification blurb (the watch op returns `{ ok: false, subscriptionId: null }`, the same skip shape as the delegated-background-task-sender and undelivered-`after_all`-group suppressions). **SUB-1 target-side gate — independent peers (behavior only, within v7.5).** The auto-watch is armed ONLY when the target is a **child agent** — parent linkage (`parent_agent_id` or the metadata `createdByAgentId`) or `delegationDepth` ≥ 1 — or a **background** agent (the persisted session flag or metadata `isBackground`): the send-and-await-result worker shapes the SUB-1 watch exists for. A send to a top-level (depth-0) **foreground** target — a user-created coordinator, or a peer created via `ws.agent.create({ topLevel: true })` (foreground by default; "Peer agents" block below) — registers NO watch and the send result omits the `subscriptionId`/"You will be notified when the agent responds." blurb (the same `{ ok: false, subscriptionId: null }` skip shape as the child-of-target suppression): messaging a co-equal peer must not passively subscribe the sender to its completion — watch a peer explicitly with `ws.agent.watch`. The auto-queue-on-failure fallback below applies only to store-append failures on an EXISTING agent (e.g. a duplicate client-supplied `messageId`); an agent deleted mid-send (between the validation and the append) is also rejected with the same `-32602` instead of auto-queueing. `priority: "interrupt"` preempts an in-flight turn instead of queueing: the current turn is cancelled keep-alive (`session/cancel` + one terminal `agent:stream:end`; the agent process is never killed) and the message streams immediately as a fresh turn on the same session (`queued: false`); the pending queue is preserved and drains afterwards. On an idle agent, interrupt priority falls through to the normal send path. **MCP binding default (behavior only, within v7.0 — [intentd#1292](https://github.com/intent-hq/intentd/pull/1292)):** the agent-facing `ws.agent.send` / `ws.agent.sendToTask` bindings resolve an omitted (or `null`) `priority` to `"interrupt"` at the binding layer — A2A sends interrupt by default — with the explicit `priority: "queue"` opt-out mapping to `"normal"` (queue-if-busy) and every other explicit value passing through unchanged. Binding-local by design: the wire default for an omitted `priority` on this RPC (the FE front door, internal wakes, automated deliveries) remains queue-if-busy. **Zero-output interrupt → combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)):** when the preempted turn produced no assistant output (the provider drops the cancelled prompt), the preempted user message's text and attachments are delivered AHEAD of the interrupt message inside the SAME `session/prompt`, so both messages are honored in original order — the original is NOT re-queued, the queue stays untouched, and both already-persisted user rows stay intact (the combined prompt is wire-only, never re-persisted). If the turn has already progressed (any assistant/tool/system row after the last user row — excluding the still-empty interrupted marker row the preemption itself just persisted, §7.2 always-persist semantics within v4.5), only the interrupt message is delivered. This combined-delivery behavior applies to ALL interrupt-priority sends — `agent.sendToTask` with `priority: "interrupt"` routes through the same preemption path and behaves identically. **Duplicate delivery** of the SAME interrupt (same client-supplied `messageId`) preempts exactly once: the duplicate is acknowledged idempotently as `{ success: true, queued: false, messageId, deduplicated: true }` — no second preemption, message NOT double-persisted (dedup keys on `messageId`; omit it and duplicates are indistinguishable from new sends). **During turn startup** (busy slot claimed but no cancellable turn live yet — spawn/`session/new` in flight) the preemption is skipped and the message queues keep-alive behind the starting turn (`queued: true`); the agent is never killed and never fails. **Per-turn prompt-assembly hints (Fidelity B).** `stdinContext` is prepended verbatim to the outbound prompt as a `Context:\n<stdin>\n\n---\n\n` block (reference-parity `acp-provider.ts`); when absent, one is synthesised from `contextReferences` (port of `agent-backend-handler.service.ts`’s builder — first-non-empty wins across `content` / `selectedText` / `taskText` / `codeChunk`, with per-`type` framing for `selection` / `task` / `code_chunk` / `file` / `linear-issue` / `github-issue` / `sentry-issue` / `terminal`; unknown types fall through to the raw content). `noteIds` are resolved to workspace-asset image content blocks: each note's markdown is scanned for `workspace-asset://<workspaceId>/<assetId>` URLs in the current workspace, the referenced bytes are appended as ACP `image` blocks, and a single system text notice is added noting how many images were inlined. `messageMetadata` is JSON persisted on the user message row (new `agent_message.metadata` column) and echoed on read — used by clients (e.g. `{ source: "system" }`) to distinguish daemon-initiated turns. Non-reserved fields are opaque (never inspected by the daemon), but a few reserved fields ARE read or written daemon-side: `fromAgentId`/`fromAgentName` are daemon-stamped on agent-origin sends (the sender-attribution block below) and `userAppMessageId` is validated/folded by the router (the client-message-identity block below). **File blocks (v6.12; attachment references only since v10.0 — [intent-hq/intentd#1878](https://github.com/intent-hq/intentd/pull/1878)).** Every `fileBlocks` entry is an attachment-registry reference `{ type: "file", attachmentId, fileName, mimeType?, size? }` (v6.12 registry, `file.placeAttachment` / `file.attachmentUpload.*`, §5.9) and must carry a non-empty `attachmentId`. The pre-10.0 inline arm (`{ type: "file", data, mimeType, fileName }`, exactly one of `data` / `attachmentId`) is removed outright: an entry carrying `data` — with or without a reference — is `-32602` naming the block index (`` {method}: fileBlocks[{i}] carries inline `data`; inline file data is no longer accepted — upload the file and reference it by `attachmentId` ``), and an entry with no non-empty `attachmentId` is `-32602` naming the index (`` {method}: fileBlocks[{i}] must carry a non-empty `attachmentId`; inline file data is no longer accepted ``), both BEFORE any state change and on every seam that accepts `fileBlocks` (`agent.sendMessage`, `agent.queueMessage`, `agent.editAndRegenerate`, `agent.create`, `agent.update`, `workspace.create`'s `initialAgent`). Prompt assembly renders a reference block as a text attachment notice directing the model to the MCP `ws.file.getAttachment(attachmentId, destDir?)` binding (§6.8) — file bytes never ride the prompt, and no ACP `resource` blob is emitted from a file block. **Legacy inline blocks on read (v10.0):** persisted pre-10.0 user rows are NOT rewritten (no migration); instead every conversation read surface — `agent.getConversation` in both projections, the `chat.subscribe` seq-0 snapshot and delta re-reads (§7.1), and `agent.getMessageBlock` — serves a persisted `{ type: "file", data, … }` block that has no non-empty `attachmentId` as `{ type: "text", text: "Attached file: <fileName>" }` (`"Attached file"` when `fileName` is missing or blank), bytes dropped, the block's `id` carried over when it has one; attachment-reference file blocks and every other block type pass through untouched, so no wire read ever carries a `type: "file"` block with a `data` key. **Image-reference blocks (within v7.4, monorepo#3338).** An `imageBlocks` entry may carry an attachment-registry `attachmentId` reference (v6.12 registry, `file.placeAttachment` / `file.attachmentUpload.*`) in place of inline base64 `data` — `{ type: "image", attachmentId, mimeType? }` — under a per-entry exactly-one-of-`data`/`attachmentId` rule (the rule the v6.12 `fileBlocks` contract introduced; `imageBlocks` keep both arms after v10.0 retired the file inline arm): both or neither is `-32602` naming the block index, BEFORE any state change. The reference is additionally validated at the RPC seam: an `attachmentId` not naming a registered attachment is `-32602` naming the id (registry-wide lookup by design — `workspace.create`'s `initialAgent` references attachments placed before the new workspace exists), and a registered size over 30 MiB is `-32602` (30 MiB raw = 40 MiB base64, the inbound frame cap that already bounds inline blocks) — the cap applies per reference AND in **aggregate** across all references in the array (individually-valid references whose recorded sizes sum past 30 MiB are `-32602`), so a small request cannot name many attachments that expand one prompt past the transport bound. Resolution happens daemon-side at prompt assembly — the single choke point covering every delivery path (direct send, queue drain, wakes, interrupts, the initial-agent turn): bytes are read from the attachment's canonical workspace root (same within-root containment guard as `file.getAttachment`), base64-encoded, and threaded to the ACP exactly as an inline image block, with MIME resolving block `mimeType` > registry `mime_type` > extension inference; a row/file that vanished after ingress validation is skipped fail-soft with a daemon warn (same convention as note-image resolution). Persistence keeps the REFERENCE: the session `imageBlocks` and the user transcript row carry `{ type: "image", attachmentId, mimeType? }` with no `data`, so `agent.getSession` / `agent.getConversation` payloads stay constant-size. The same contract applies everywhere `imageBlocks` are accepted: `agent.queueMessage`, `agent.editAndRegenerate`, `agent.create`, the `agent.update` `imageBlocks` patch, and `workspace.create`'s `initialAgent` (§5.1). Inline `data` entries are byte-for-byte unchanged. **Pending human append.** A send that falls back to the pending queue follows [Shared pending human queue](#shared-pending-human-queue); its queued result identifies the surviving entry and its turn, which may predate this request. Directly delivered messages are unchanged. **Row identity + events.** A direct (non-queued) send persists the user row UNDER the client-supplied `messageId` when given (validated ≤ 256 bytes, `-32602` otherwise) — else a server-minted `user-msg-{uuid}` — the result `messageId` IS that persisted row id, and the daemon emits `agent:message` `{ agentId, messageId, role: "user", appMessageId? }` for the append (`appMessageId` present only when the row carries a `userAppMessageId`) (same event the queue-drain and wake-delivery persists emit), so clients converge on the canonical row without a refetch race. **Sender attribution (`agent_message`, new in intentd).** Agent-originated sends through the MCP host bindings — `ws.agent.send`, `ws.agent.sendToTask`, and the `ws.agent.create` kickoff message — are auto-tagged by the daemon with `messageMetadata = { "type": "agent_message", "fromAgentId": string, "fromAgentName": string \| null }` so recipients and clients can attribute who sent the message. An explicit caller-supplied `messageMetadata` keeps its own fields, but the attribution fields (`fromAgentId`/`fromAgentName`) are **daemon-stamped** for agent callers — always overwritten with the real caller identity, since [intentd#816](https://github.com/intent-hq/intentd/pull/816) made `fromAgentId` security-relevant (single-pending-send guard + `ws.agent.removeQueuedMessage` ownership; a `null` metadata value is treated as absent and does NOT suppress the auto-tag); `fromAgentName` is always present for a stable schema and is `null` when the sender's session lookup fails. Human-originated FE/RPC sends (no agent caller, no explicit metadata) stay untagged. The tag persists on the user message row and survives the busy-agent queued path — the enqueue captures it and the drain-time persist writes it — including the store-only fallback. Within intentd ([intent-hq/intent#3721](https://github.com/intent-hq/intent/issues/3721)) the same stamped attribution is additionally rendered into the model-visible content as the daemon-prepended `[MESSAGE FROM AGENT …]` header — see the "A2A sender header" block under "Agent-facing queue visibility & sender hygiene" below. **Client message identity (`userAppMessageId`).** The FE’s client-minted optimistic-message id is consumed by the router: it is trimmed, validated ≤ 256 bytes (`-32602` otherwise; whitespace-only reads as absent), folded into the row `messageMetadata` under `userAppMessageId` (the top-level param wins over a caller-supplied metadata copy; supplying it alongside a non-object `messageMetadata` is `-32602`), lifted back out as the top-level `appMessageId` field on `AgentMessage` reads (`agent.getConversation` / `agent.getSession`), and echoed as `appMessageId` on the user-row `agent:message` event — activating the FE’s optimistic-insert dedup guard. The id survives the busy-agent queued path (enqueue capture → drain-time persist) but is excluded from the drain persist’s in-block `messageMetadata` copy (row-level only) so queued rows’ content blocks match direct-send rows. Requests without it are byte-for-byte unchanged (no `appMessageId` key on rows or events). **Daemon-ignored fields (FE-forwarded, unwired daemon-side).** The assistant-side ids (`assistantMessageId` / `assistantAppMessageId`) are accepted by the router but not consumed: assistant rows are keyed on the server-minted row `id`. Per-turn `model` override is likewise accepted but **not extracted** by the daemon router today; the session-level model set at `agent.create` / `agent.setModel` remains authoritative (deferred pending an ACP-provider-side change to switch model mid-session). **Turn correlation (`turnId`, [monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022) / [intentd#699](https://github.com/intent-hq/intentd/pull/699)).** Every runtime result arm additionally carries `turnId` — the daemon-minted stable correlation id for the user-initiated turn. A direct (non-queued) send mints it at dispatch, BEFORE the persist, so the user-row `agent:message` echo, the RPC result, and the turn's lifecycle events all carry the SAME id; the queued arms (busy-agent, quarantined, auto-queue fallback) return the enqueued entry's `turnId` (= the entry `id` at first enqueue). The id is preserved across terminal-failure requeues — the requeued entry gets a NEW entry `id` but keeps the failed turn's ORIGINAL `turnId` — so the `agent:failed` / terminal `agent:stream:end` of the failed turn AND the `agent:queue:processing` / lifecycle events of an `agent.retry` redrive all correlate with the id the client keyed at send time (§6.5/§6.6). Exceptions: the idempotent duplicate-interrupt ack (`deduplicated: true`) and the store-only fallback's direct arm carry no `turnId` (the store-only auto-queue arm does). Always omitted when absent, never `null`. **Pending questions (v2.8; delivery hold retired in v9.5, [intentd#1710](https://github.com/intent-hq/intentd/pull/1710)).** A pending structured-question set (the persisted `pendingQuestionsMessageId` marker, §5.5 "Pending questions") never gates delivery: user-origin sends (this FE/router front door) and internal **automatic** sends routed through the same turn machinery (MCP `ws.agent.send`, A2A wakes, event-subscription batches, internal continuations) alike deliver immediately on an idle target or queue on the ordinary busy path, `priority: "interrupt"` sends preempt as usual, and the result union is unchanged — the v2.8 `heldForQuestions: true` park result and the monorepo#1791 pending-questions FIFO conversion are gone from the wire. Delivering is **not** resolving (within v6.0, [intentd#965](https://github.com/intent-hq/intentd/pull/965)): a plain user row — and any automatic row — leaves the marker armed, and only a user row whose `messageMetadata` is `{ type: "question_answers", answeredQuestionsMessageId }` naming exactly the marked assistant message resolves it (the answer intake runs on every user-row persist path, so an answer that auto-queued behind a busy turn still resolves on drain). See "Pending questions" below the table for the derivation and resolution semantics |
| agent.sendQueuedMessageNow | agentId (req), messageId (req), workspaceId (req) | { success: true, queued: false, messageId, turnId } on the atomic send — the normal outcome; the full result is a union with two `{ success: true, queued: true, queuedMessage }` variants (slot-race and quarantined, described below), which carry the wire-shape `queuedMessage` (the raw entry in the `agent.queueMessage` shape — `author: null`, NOT the resolved, caller-projected `author` the `agent.getQueue` row serves; the same holds for the `queuedMessage` returned by `agent.queueMessage` and `agent.editQueuedMessage`, so read attribution from `agent.getQueue` / `agent:queue:updated`) INSTEAD of a `messageId`, so clients must branch on `queued`. Atomically dequeues the pending-queue entry named by `messageId` and delivers it immediately with interrupt priority, **preserving the rest of the queue**. The method takes no content params: the delivered turn carries the entry's own captured payload (content, `imageBlocks`/`fileBlocks`, `messageMetadata` from enqueue time), and the result `messageId` is the entry id — which is also the persisted user row id. **Fail closed / not idempotent.** A nonexistent `agentId` is rejected with `-32602` (`unknown agent id: <id>`) BEFORE the queue is touched (same guard as `agent.sendMessage`); an absent queue entry is rejected with `-32602` (`queued message not found: <id>`) with NO side effects — deliberately NOT idempotent (unlike `agent.removeQueuedMessage`), so the client knows the atomic send did not happen. **Send-now authority is separate from shared reads:** the current host owner may force-send any ordinary local entry; other wire callers may force-send only their own human entries or genuinely automatic/agent entries. A foreign or unknown-human entry is `-32602` (`queued message not found: <id>`) with NO side effects even though it is visible in the shared queue. Imported unbound human entries additionally obey [§5.1's transfer rule](./workspace.md#human-authorship-in-workspace-transfers): only an affirmative current host-owner send may pop them, preserving original `humanAuthor`; automatic/agent/daemon delivery cannot bypass that check. **Atomic dequeue + interrupt delivery.** The removal happens under the queue lock (no concurrent drain can deliver the same entry twice); the shrunk queue is write-through persisted at removal and republished as `agent:queue:updated` after the entry's user row is appended (and its `question_answers` intake has run — §6.5 drain ordering contract), still before the turn starts. A busy agent is preempted keep-alive — the same `session/cancel` + worker-abort as `agent.sendMessage` with `priority: "interrupt"`; the agent process is never killed — and the zero-output combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)) applies identically: a preempted zero-output user message rides the delivered turn's prompt AHEAD of the entry content (an entry already carrying its own requeued prepend payload keeps that payload first, in transcript order). An idle agent starts the turn directly. The user row is persisted UNDER the entry id and the standard user-row `agent:message` event (`role: "user"`) is emitted; a terminal-failure requeued entry whose user row already reached the transcript is not re-appended (the delivery reuses the existing row). Stale queued-message redrives on delegated agents keep the #576 semantics documented under `agent.reportToParent` (report-clear suppression + `[SYSTEM NOTE]` annotation). **Queued outcomes (success, not errors).** When the in-flight slot cannot be claimed (turn startup, or a concurrent send won the race) the entry is restored at the FRONT of the queue — next to drain — and the result is { success: true, queued: true, queuedMessage }. A quarantined (poisoned, monorepo#840) session is not redriven: the entry stays in the queue untouched and the result is { success: true, queued: true, quarantined: true, queuedMessage } (`agent.retry` is the deliberate redrive); the absent-entry case is still `-32602`. **Never-lost guarantee.** On a user-row persist failure the entry is restored at the FRONT of the queue (durability state untouched, so a retry re-appends correctly) and `agent:queue:updated` is republished before the error surfaces. The store-only fallback (no agent manager attached) honors the same atomic contract — dequeue, persist under the entry id, emit `agent:message`, restore-at-front on failure — without starting a turn. The runtime path emits the additive canonical `queuedMessages` processing snapshot only after slot admission and successful transcript persistence (or reuse of an already-persisted row); lost claims and store-error restorations emit none. The store-only success path likewise publishes its canonical snapshot after successful persistence, without claiming a provider turn was dispatched (§6.5 and [Processing entry snapshots](#shared-pending-human-queue)). **`turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)):** the delivered arm is `{ success: true, queued: false, messageId, turnId }` — `turnId` is the entry's preserved turn correlation id (the same id the enqueueing RPC returned), stamped on both the `agent:message` echo this delivery emits and the delivered turn's lifecycle events; the queued/quarantined arms' `queuedMessage` carries the entry's `turnId?` field per the `agent.queueMessage` wire shape; the store-only fallback's result carries no `turnId`. **Pending questions (v2.8):** `agent.sendQueuedMessageNow` is an explicit user action, so its delivered row is user-origin. Within v6.0 that row resolves the pending question set only when it carries the `question_answers` answer tag for the marked message (the same intake as every other user-row persist path); an untagged entry delivers with the marker still armed |
| agent.sendQueuedMessagesNow | agentId (req), workspaceId (req), messageIds (req, nonempty array of distinct nonempty strings) | `{ success: true, queued, messageIds, turnId?, quarantined? }`. Explicitly sends exactly the selected ready entries as one batch in existing queue order, with at most one keep-alive preemption. Validates the whole selection under the queue lock before dequeue or preemption: missing/stale/foreign IDs, duplicates, editing entries, unexpired holds, imported unbound human instructions and script-monitor wake entries (`messageMetadata.type: "script_monitor_wake"` with `monitorId`) return `-32602` without sending any selected entry. Script-monitor wakes retain their individual monitor admission and lifecycle fence. Guest collaborators may select only entries visible in their `agent.getQueue`; original authorship, attachments and per-entry transcript rows are preserved. Unselected and later-arriving entries remain queued. `queued: false` carries the head entry’s `turnId`; all row echoes share it and precede the single shrunk `agent:queue:updated`, with one `agent:queue:processing` event. `queued: true` omits `turnId`: a startup/slot race restores the complete batch at the queue front; a partial transcript persistence failure parks the agent in Error and restores the batch in order, retaining entry IDs and skipping already-persisted rows on retry. Quarantine returns `queued: true, quarantined: true` without popping or preempting. `messageIds` always lists the selected IDs in queue order. A repeated request after delivery returns `-32602`; clients must refresh the queue rather than retry blindly. Requires the runtime agent manager; store-only configurations return unsupported without changing the queue. |
| agent.dismissQuestions *(v2.8; model notice added within v4.3, intentd#892)* | agentId (req), messageId (req), workspaceId (req) | { success: true, dismissedQuestionsMessageId } — dismiss the pending question set of the assistant message named by `messageId` (the message carrying the trailing `application/vnd.intent.question+json` resource blocks, §7) WITHOUT answering: persists the dismissal marker `dismissedQuestionsMessageId` in the session metadata (survives daemon restarts, so the dismissed set never re-surfaces), emits `agent:updated` with `{ agentId, dismissedQuestionsMessageId, pendingQuestionsMessageId? }` — `pendingQuestionsMessageId?` (additive, [monorepo#3180](https://github.com/intent-hq/monorepo/issues/3180)) echoes the session's pending-questions marker (§5.5 "Pending questions") so the event is self-contained (clients re-derive pendingness from this one event without an `agent.get` round-trip): present whenever the marker was ever written, with the empty string as the authoritative "nothing pending" clear, and omitted entirely for legacy marker-less sessions (same projection rule as the `AgentLite` `metadata.pendingQuestionsMessageId`) — and kicks the queue drain so entries parked for other reasons (a busy race, the notice below) resume immediately (no waiting for the next end-of-turn drain). **The model IS notified** (intentd#892; supersedes the pre-#892 no-notify contract): after the marker persist, the daemon delivers a **system-origin notice** to the agent — "User dismissed your N questions without answering. This is an informative notice only — do not re-ask and do not proceed with any work; end your turn and wait for the user's next message." (informative-only wording since intentd#930; the pre-#930 notice told the agent to "continue with your best judgment") — with count-aware wording (singular "1 question", plural "N questions", and a countless fallback when the dismissed message's question-block count cannot be derived; the count is computed at bounded cost — index seek + single-row page, no transcript hydration). The notice carries `messageMetadata { "type": "questions_dismissed", "source": "system", "dismissedQuestionsMessageId": "<id>" }`, exposed on the queued entry while undelivered (`agent.getQueue`) and persisted on the delivered user row (row `metadata` and served block metadata). Delivery: an **idle** agent receives the notice as an immediate turn (the wake-delivery path); when it must queue (agent busy, or the store-append fallback), the entry is **promoted to the absolute queue head** (position 0) with `interruptPriority: true` — unlike the normal interrupt insertion order (which slots behind existing interrupt-priority entries, see `agent.queueMessage`), the promotion places the notice ahead of EVERY parked entry, including pre-existing interrupts. The ordering is best-effort under a concurrent drain race: the promotion is a separate queue-lock acquisition from the enqueue, so a racing drain may pop a previously parked entry (or the notice itself) in the window between them — the notice still delivers, just not strictly first. **Idempotent**: re-dismissing the same `messageId` succeeds, rewrites the same marker, and sends NO duplicate notice — guarded by the persisted dismissal marker (written before the notice is enqueued so the notice's turn observes the dismissed state) plus an in-memory per-agent notice registry that also covers re-dismissing an OLDER message id after the single-slot marker was overwritten by a newer dismissal (the registry is process-local; the marker alone guards across restarts). **Fail-soft**: notice delivery errors are logged; the RPC never fails because of the notice. Validation: an empty `messageId` or one exceeding 256 bytes is `-32602`; a nonexistent `agentId` or a workspace mismatch is a not-found error (fail closed, no metadata write). The `messageId` is NOT checked against the transcript — dismissing an id that carries no questions is a harmless no-op marker write (the pending set resolves only when the dismissal marker matches the `pendingQuestionsMessageId` marker the asking turn wrote) |
| agent.resolveProposal *(v8.7, [intentd#1581](https://github.com/intent-hq/intentd/pull/1581))* | agentId (req), proposalId (req), outcome (req: `"applied"` \| `"dismissed"`), detail?, workspaceId (req) | { success: true, proposalId, outcome } — record the user's resolution of a pending proposal (see §5.5 "Pending proposals" below). Persists the `proposalId -> outcome` entry in the `proposalResolutions` session-metadata map, THEN removes the entry from the session's `pendingProposals` list (two atomic single-key writes in that order, so a failure between them leaves the entry pending with its outcome recorded and a retry converges instead of losing the resolution; sibling metadata keys preserved), emits `agent:updated` carrying both (`{ agentId, pendingProposals, proposalResolutions }`), and delivers the **proposal-resolved system notice** to the model for BOTH outcomes — applied: "User applied the proposal 'Title'." (with the caller-supplied `detail` appended verbatim when present — e.g. the created workspace id); dismissed: "User dismissed the proposal 'Title' without applying it. This is an informative notice only — do not re-propose it; continue with your other work or end your turn." The notice names the proposal by its `preview.title` recovered from the carrying message's proposal resource block at bounded cost (index seek + single-row page, mirroring the `agent.dismissQuestions` count derivation), falling back to the proposal id when the message is gone or carries no title. The notice carries `messageMetadata { "type": "proposal_resolved", "source": "system", "proposalId": "<id>", "outcome": "<outcome>" }` and follows the `agent.dismissQuestions` delivery mechanics: an **idle** agent receives it as an immediate turn (the wake-delivery path); a busy agent gets the entry promoted to the queue front. **Fail-soft**: notice delivery errors are logged, never surfaced to the RPC — the persisted resolution is the source of truth. **The Apply itself stays client-driven**: the daemon executes nothing on `outcome: "applied"` — the client runs its own apply flow first and calls this RPC to record the outcome and notify the model. **Idempotent**: re-resolving an id that is no longer pending but present in the resolutions map succeeds, echoing the CURRENT persisted outcome (no rewrite, no duplicate notice or event); the whole read-modify-write is serialized per agent on the same mutation lock as the pending-proposals writers, so a concurrent double-resolve races to a single winner and the loser takes the idempotent path. **Bounded retention**: the `proposalResolutions` map is capped at 100 entries — past the cap the OLDEST entries are evicted on insert (the map is insertion-ordered), so the persisted blob and the `AgentLite` projection lifting it into hot `agent.list` / `agent.get` payloads never grow without bound; re-resolving an evicted id degrades to not-found (acceptable — the entry is long-resolved and no longer renderable as a pending card). A re-proposed id re-enters the pending list; its re-resolution overwrites the earlier outcome (latest wins). Validation: the `proposalId` is matched VERBATIM against the recorded pending entries (recording preserves `applyToolCallId` / `preview.title` exactly as proposed, so no normalization); an empty/whitespace-only `proposalId` or one exceeding 256 bytes is `-32602`, an `outcome` other than the two literals is `-32602`, and `detail` is trimmed (empty collapses to absent) and capped at 2000 bytes (`-32602` past it — it is appended verbatim to the applied notice, so it is bounded against oversized payloads riding into the transcript). An id that was never pending and never resolved, a nonexistent `agentId`, or a workspace mismatch is a not-found error |
| agent.markSeen *(v4.5)* | agentId (req), messageId (req), workspaceId (req) | { success: true, lastSeenMessageId } — advance the per-conversation **seen marker** to `messageId` (the newest transcript message the user has seen): persists `lastSeenMessageId` in the session metadata (survives daemon restarts), emits `agent:updated` with `{ agentId, lastSeenMessageId }` (§6.5), and serves the marker as `metadata.lastSeenMessageId?` on the `AgentLite` projection (`agent.list` / `agent.get`) and `agent.getSession` (omitted when nothing was marked seen). Clients use it to render a "New messages" divider after the last-seen message on conversation entry; marker updates from other clients converge via `agent:updated`. The marker is also one side of the client-side per-agent **unread** derivation against `lastMessageId` (intentd#1039 — see the `agent.list` row above): `hasUnread = lastMessageRole === "assistant" && lastMessageId != null && lastMessageId !== lastSeenMessageId`, with an **absent marker counting as unread**; because the newest user/assistant id can differ from the marker via system/tool rows, clients should mark user/assistant row ids seen where possible — equality is the only sound comparison; id ordering is NOT a valid fallback (ids are not uniformly UUIDv7 and v7 mint time is not persist order — see the `agent.list` row above). **Monotonic**: when both the named message and the current marker resolve to transcript positions and the named one is OLDER, the call is a no-op returning the CURRENT marker (`lastSeenMessageId` in the result is the unchanged current value; no write, no event) — the marker never moves backwards, including under concurrent callers (the persist is an atomic single-key compare-and-set on the marker's current value; a raced write re-reads and re-applies the gate). **Idempotent**: re-marking the already-persisted id succeeds without a write or a duplicate event. **Dangling ids are tolerated** (same laxity as `agent.dismissQuestions`): the `messageId` is NOT checked against the transcript — an unknown id (or one whose row was truncated by `agent.editAndRegenerate`) is persisted as a dangling marker (clients fall back to their no-marker behavior when the id no longer resolves), and a dangling CURRENT marker never blocks an advance (the monotonicity comparison only applies when both sides resolve). Bounded cost: a metadata-only session lookup plus at most two index seeks — no transcript hydration. Validation: an empty `messageId` or one exceeding 256 bytes is `-32602`; a nonexistent `agentId` or a workspace mismatch is a not-found error (fail closed, no metadata write). **Settles the derived workspace `unread`** (§5.1): after a marker write the daemon re-derives the workspace-level unread state (any top-level non-background non-deleted non-retired non-muted session with an unseen assistant last message — a soft-retired session, `retiredAt` set, or a muted one, `notificationsMuted`, never counts) and, when this advance read the LAST unread session — an unread→none transition — clears the stored legacy flag (guarded on `unread`; `review_required` survives; the clear re-checks the derivation atomically inside the guarded write, so an assistant message racing the settlement is never retired) and emits ONE `workspace:attention-changed { none }`; partial reads (other sessions still unread) and no-op calls (monotonic/idempotent — no marker write) stay silent at the workspace level. `workspace.markSeen` (§5.1) is the mark-ALL-conversations-seen composite built on this op |
| agent.editAndRegenerate | agentId (req), messageId (req), content (req), workspaceId (req), imageBlocks?, fileBlocks? *(attachment references only since v10.0; see the file-block contract on `agent.sendMessage`)*, model? | { success, queued: false, messageId, truncatedCount } — edit a past **user** message and regenerate from that point (additive `agent.*` extension). The result `messageId` is the freshly-minted server id of the NEW regenerated user message — NOT the input `messageId`, which names the edit target whose row (and everything after it) is dropped by the truncation; the two are never the same id. Orchestrated daemon-side, in order: (1) `messageId` is validated FIRST (must reference an existing user message in the transcript — unknown or non-user ids are rejected with `-32602` before any state changes; the transcript is untouched); (2) any in-flight turn is stopped (hard-cancel: the worker is aborted and the agent process killed) and the pending queue is discarded (a previously non-empty queue republishes `agent:queue:updated` as empty); (3) with `model` supplied — a **bare** model id; a compound `provider:model` value is rejected with `-32602` before any of these effects ([intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)) — the session model is switched (same semantics as `agent.setModel`) before the regenerated turn; (4) the transcript is truncated to just BEFORE the edited message — the edited message and everything after it are dropped (destructive, suffix-only: only rows at or after the edited message are deleted, in one write transaction; the kept prefix **retains its `messageId`s and `seq`** and every stored side row — full tool bodies, retention `*_replay` previews, thumbnails — as-is, and the session's last-message preview columns are recomputed from the surviving rows; since intentd#1757 — previously the kept prefix was reminted through the `agent.replaceMessages` store path with fresh ids / 0-based `seq`, which `agent.replaceMessages` itself still does) and `agent:updated` is emitted with `{ truncatedCount, remainingCount }`; (5) the agent's ACP session is flagged for forced recreation — the next prompt SKIPS the `session/load` resume, opens a fresh `session/new`, and prepends the truncated prior history as `<supervisor>` XML (the provider must not retain the truncated turns in context; the forced-recreate flag survives intervening `agent.stop`s and is only consumed when a fresh session opens); (6) `content` is sent as a fresh user message (normal `agent.sendMessage` semantics; `imageBlocks`/`fileBlocks` ride along; the usual `agent:message` / `agent:stream:*` events follow) |
| agent.queueMessage | agentId (req), content (req), messageId? *(prepared submission correlation v1, below)*, imageBlocks?, fileBlocks? *(attachment references only since v10.0; an inline-`data` entry is `-32602` naming the index BEFORE enqueueing — see the file-block contract on `agent.sendMessage`)*, messageMetadata?, workspaceId? | { success, queuedMessage, turnId } — May append to an existing pending human entry; `queuedMessage` and `turnId` then identify the surviving entry, not a new entry. See [Shared pending human queue](#shared-pending-human-queue). **Unknown agent → fail closed.** A nonexistent `agentId` is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE enqueueing — no phantom queue entry that can never drain, no `agent:queue:updated` event (same guard contract as `agent.sendMessage`). QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority?, editing?, editingMessageId? } — `fileBlocks` echoes the entry's captured attachment-reference blocks (reference-only since v10.0; the seam rejects inline `data`, so no queue row minted on a 10.0 daemon carries file bytes); `interruptPriority: true` (additive, v2.8) marks an entry that entered the queue via an interrupt-priority fallback (a parked — archived-workspace, quarantine, append-failure — or slot-raced `priority: "interrupt"` send): a newly created entry is inserted at the FRONT of the queue, **behind any existing interrupt-priority entries and ahead of every normal entry** (interrupts stay arrival-ordered among themselves); a same-author append retains its survivor's priority and position instead. The flag is omitted (never `false`) on normal entries. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is the entry's turn correlation id: equal to the entry `id` for a fresh enqueue, but a terminal-failure requeue mints a NEW entry `id` while KEEPING the failed turn's original `turnId`, so a retry redrive's lifecycle events still correlate with the turn the client keyed at send time. Omitted only when the entry has no id set (every enqueue path mints one today; legacy pre-#1022 persisted rows rehydrate with `turnId = id`), never `null`. `messageMetadata` is only present when the entry was enqueued with per-message metadata — the caller's own `messageMetadata` param (additive within v9.11; previously dropped, so user-typed entries never carried it), an internal wake's `event_notification` payload, or an agent-to-agent send's `agent_message` sender-attribution tag captured while the agent was busy. **Caller `messageMetadata` (within v9.11).** Same contract as the `agent.sendMessage` param: an opaque JSON object captured on the queued entry (echoed on the result's `queuedMessage` and by `agent.getQueue`), subject to the reserved attribution and daemon-owned aggregate rules below; appends preserve conflicting originals in `mergedMessageMetadata`, with the reserved attribution fields `fromAgentId` / `fromAgentName` stripped at this user-origin front door; `null` / omitted reads as absent (no `messageMetadata` key on the entry); any other non-object value is `-32602` (`messageMetadata must be an object`) before any state change. The drain-time persist writes it onto the user message row (`agent_message.metadata`) so the transcript matches a directly-delivered send — and because the answer intake runs on every user-row persist path, an entry queued with `{ type: "question_answers", answeredQuestionsMessageId }` naming the marked assistant message resolves the pending question set on drain exactly as a direct tagged `agent.sendMessage` does (§5.5 "Pending questions"). **User-origin.** `agent.queueMessage` is the FE's front door for a reply typed while the agent is mid-turn, so its entries are recorded **user-origin**: the drained entry retires a pending attention request exactly like a direct `agent.sendMessage` (the "Attention requests" block, step 1) and qualifies for the archived-workspace drain exemption ([intent-hq/intent#3883](https://github.com/intent-hq/intent/issues/3883)) |
| agent.editQueuedMessage | agentId (req), messageId (req), content (req), editing?, workspaceId? | { success, queuedMessage } (QueuedMessage shape as above). **Author-only for human entries**, independently of shared queue visibility; a displaced editor alias additionally fails the stale-edit conflict check described below: another principal's entry cannot be edited or restamped, including by an owner. Unknown-human entries cannot establish authorship and are refused to every wire caller. Unauthorized edits have no side effects: a non-host-owner wire caller gets `-32602` (`queued message not found: <id>`), even though the entry is visible; a host owner gets `-32602` (`queued message <id> can only be edited by its author`). Agent/daemon callers and genuinely automatic/agent entries retain their existing rules; imported-human delivery restrictions are separate. An unbound wire request fails the membership gate ahead of this check with `-32003 Forbidden` (§5.48). A nonexistent id keeps its existing error. See [Shared pending human queue](#shared-pending-human-queue) |
| agent.removeQueuedMessage | agentId (req), messageId (req), workspaceId? | { success: true }. **Human entries: author or owner only**, independently of shared queue visibility. Other participants cannot remove someone else's entry, even when its id and content are visible. Unauthorized removal is `-32602` (`queued message not found: <id>`) with no side effects. Automatic/agent entries keep their existing mutation policy. Removal of a nonexistent id remains an idempotent success. See [Shared pending human queue](#shared-pending-human-queue) |
| agent.getQueue | agentId (req), workspaceId? | { success, queue: QueuedMessage[] } — QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority?, editing?, editingMessageId?, author? } (shape as `agent.queueMessage`, including attachment-reference-only `fileBlocks` and the multiplayer `author` projection, §5.48). **Shared queue:** every caller with access to the workspace receives the full queue, including other participants' messages and the owner's. `position` is the zero-based index in the full queue. `agent.diagnostics` queue entries and the `agent:queue:updated` / `agent:queue:processing` events use the same shared-read policy (§6.5). Reading an entry does not authorize editing, removal or immediate delivery; see [Shared pending human queue](#shared-pending-human-queue). Attribution still distinguishes a resolved principal, an unknown human and an automatic/agent entry; missing identity never grants authorship. [Imported unbound human queues](./workspace.md#human-authorship-in-workspace-transfers) retain their historical author, remain held against automatic delivery, and require affirmative current host-owner authorization for an explicit send. A parked dismissal notice (intentd#892, within v4.3) surfaces here with its `questions_dismissed` `messageMetadata` and `interruptPriority: true` at the queue head — promoted to position 0 ahead of even pre-existing interrupt-priority entries, unlike the normal interrupt insertion order; see `agent.dismissQuestions` |
| agent.stop | agentId (req), workspaceId? | { success: true } |
| agent.setModel | agentId (req), modelId (req), workspaceId (req), providerId? | service result — emits `agent:updated`. `modelId` must be a **bare** model id ([intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)): a compound `provider:model` value is rejected at the router boundary with `-32602` (`modelId must be a bare model id without ':' (got "<value>"); pass the provider separately alongside the bare model`) before any mutation — `session.model` / `session.provider` are left untouched; pass `providerId` to name the intended provider. A `modelId` without `providerId` is validated against the session's effective provider (`session.provider` → the settings-derived default `model.defaultProvider`, §5.12; with neither set the call fails with `-32602` (`agent.setModel: no default provider/model is configured …`) instead of validating against a positional default — [intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044), [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)) using the same ownership check as `agent.create` — cached dynamic catalogs only ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)), with the same asymmetric-evidence rule: a bare id provably owned by other provider(s) is rejected with `-32602` (`agent.setModel: model <id> does not belong to provider <p> (providers with this model: ...); pass providerId to select the intended provider` — the trailing hint is new with the `providerId` param, [intent-hq/intentd#986](https://github.com/intent-hq/intentd/pull/986)) before any mutation; bare ids with no ownership evidence and the `"default"` sentinel pass unchanged. **Explicit provider (`providerId`, additive — [intent-hq/intentd#986](https://github.com/intent-hq/intentd/pull/986), [intent-hq/monorepo#1657](https://github.com/intent-hq/monorepo/issues/1657)).** `providerId` optionally names the intended provider explicitly, so a client that knows which provider group the user picked (e.g. the FE model picker, whose default-provider options carry bare ids) can state it on the wire instead of relying on session-provider inference (compound-id encoding is retired — see the bare-`modelId` rule above). Optional string: JSON `null`, an empty string, and a whitespace-only value all read as absent (the value is trimmed), keeping older clients that send a blank field on the historical path; a present non-string value is rejected with `-32602` (`agent.setModel: providerId must be a string`) at the router boundary. When present it must name a registered ACP provider — an unknown id is rejected with `-32602` (`agent.setModel: unknown provider: <id> (known providers: ...)`) before any mutation. When `providerId` is present the `modelId` is validated against the GIVEN provider instead of the session's effective one (same cached-catalog asymmetric-evidence ownership check as above), and on success `session.provider` is reconciled to `providerId` — a narrow `set_agent_session_model` write — so the next spawn runs the intended binary. Absent `providerId` ⇒ prior behavior unchanged byte-for-byte. **Cross-provider availability gate (behavior only, within v9.13 — [intent-hq/intentd#1823](https://github.com/intent-hq/intentd/pull/1823), [intent-hq/intent#4455](https://github.com/intent-hq/intent/issues/4455)).** When `providerId` names a provider **different from the session's current one** (a switch that actually MOVES the session), the target is held to the same availability bar as the `agent.create` / `agent.delegate` front door — disabled in settings → not authenticated → not installed, one distinct `-32602` each, prefixed `agent.setModel:` (e.g. `agent.setModel: provider "<id>" (<Name>) is not enabled`) — and rejected BEFORE any mutation, so a client can no longer park a session on a switched-off, logged-out, or uninstalled provider only to have the failure surface a turn later as a raw spawn error with nothing tying it back to the `setModel`; `session.model` / `session.provider` are left untouched. The gate runs AFTER the model-ownership check, so the existing error precedence is unchanged: a `modelId` the target provider does not own is still rejected for THAT reason, available or not. Deliberately NOT applied to a same-provider model change (`providerId` naming the provider the session is already on) nor to the no-`providerId` form — an agent already running on a provider must stay able to change its model even while that provider's availability probe is unhappy (a hard-`false` cached auth verdict, a provider disabled after the agent was created). "Already on" means the session's **effective** provider — the one the next spawn would actually run — not the raw `provider` column: a legacy alias (`acp` / `default` / `augment`) normalizes through the provider config exactly as the spawn path and the model-ownership check do, and a NULL column resolves to the settings-derived default, so an explicit `providerId: "auggie"` against a session stored as `acp` or with no column at all is a same-provider model change and stays ungated. This is the front-door counterpart of the additive `errorCode: "quota-exceeded"` / `providerId` pair on `agent:failed` (§6): a client steering a quota-failed agent onto another provider gets a structured rejection at the switch instead of a second failed turn. **Model-change transcript notice (new in intentd).** `agent.setModel` itself never writes to the transcript — the notice is deferred to the next turn start (`ensure_started`), when the turn's spawn-resolved model/provider is compared against the last **committed** turn's identity (persisted `agent_session.last_turn_model` / `last_turn_provider`, written on `ensure_started`'s success paths once the child + ACP session are up). A difference (and at least one committed prior turn) persists ONE informational row: `role: "system"`, one text block (`"Model changed from <from> to <to>."`), row `metadata = { "type": "model_changed", "from": string \| null, "to": string \| null, "fromProvider": string, "toProvider": string }` (`from`/`to` are spawn-resolved model ids; `null` = provider default), and emits the standard `agent:message` event (`role: "system"`) so clients update live. Picker toggles reverted before any message produce NO notice (nothing was committed in between); the agent's very first turn produces NO notice (no committed prior identity, the baseline just commits); a failed spawn/switch commits nothing (the notice only lands once the turn provably starts under the new identity). The row is transcript-only: system-role rows are excluded from supervisor-XML history replay (which renders only user/assistant/error) and never reach any outbound provider prompt **via history replay** — the one qualification is the `auto_unarchived` notice (§5.1 auto-unarchive transcript-notice block), whose text is additionally injected as a trailing prompt block on its TRIGGERING turn only, through a separate one-shot mechanism; history replay itself still excludes every system row, the `model_changed` notice included. Covers same-provider respawn, cross-provider recreate, and idle-agent (no live handle) respawn paths alike — detection is store-based. Best-effort: a notice persist failure is logged and the turn proceeds. |
| agent.getModels | workspaceId? | { models: [{ id, name, provider, description? }] } (from auggie CLI; an unavailable CLI yields an **empty** list — no static fallback catalog, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)) |
| agent.rename | agentId (req), name (req, non-empty), skipIfExplicitlySet?, workspaceId? | { success: true, name } — an applied rename emits `agent:renamed`. With `skipIfExplicitlySet: true`, a session whose name was already explicitly set is left untouched and the result is { success: true, name: <existing>, skipped: true } (no event) |
| agent.delete | agentId (req), workspaceId?, undoDelayMs? *(v6.7)* | { success: true } — **Delete grace window (v6.7, [intent-hq/intentd#1096](https://github.com/intent-hq/intentd/pull/1096)):** `undoDelayMs > 0` (non-negative integer; a non-integer value is `-32602`; values above the 60 000 ms cap are silently clamped, never rejected — `deleteAt` reflects the clamped value) schedules an **in-memory** pending deletion instead of committing — returns `{ success: true, scheduled: true, deleteAt }` (ISO commit deadline), emits `agent:delete-scheduled { agentId, workspaceId, deleteAt }` (§6.5), and serves `pendingDeleteAt` on the `AgentLite` / `AgentSession` projections until the deadline commits the real delete or `agent.cancelDelete` cancels it. Scheduling does NOT stop the agent — only the deadline commit does. Absent, `null`, or `0` keeps the immediate-delete behavior byte-identical. Pending deletions are never persisted (a daemon restart drops them; the session survives); re-scheduling is idempotent under the registry lock (returns the existing deadline, no second timer); a workspace delete — immediate or committed-from-pending — supersedes pending agent deletes inside it |
| agent.cancelDelete *(v6.7)* | agentId (req), workspaceId? | { cancelled: boolean } — cancels a pending (grace-window) deletion scheduled by `agent.delete` with `undoDelayMs`. A caller-declared `workspaceId` is validated against the session row BEFORE touching the registry (mirroring `agent.delete`), so a stale or cross-workspace-scoped cancel returns NotFound instead of cancelling another workspace's pending deletion. `true` clears the pending deletion, emits `agent:delete-cancelled { agentId, workspaceId }` (§6.5), and drops `pendingDeleteAt` from the projections; `false` is the race-safe non-error when no deletion is pending (never scheduled, already cancelled, or already committed) |
| agent.retire *(v10.10)* | agentId (req), workspaceId?, reason? | { success: true, retiredAt: string, alreadyRetired?: true } — user-initiated soft retirement; `retiredAt` is the persisted ISO timestamp. Stops the target if running after the active-descendant guard passes, cancels its wake sources, and preserves its conversation. Repeating retirement returns the original timestamp with `alreadyRetired: true`, without another transition or event. See "Direct user retirement" and "Retire cascade & cleanup" below; independent of `agentFeatures.peerAgents`. |
| agent.restore *(v7.5)* | agentId (req), workspaceId? | { success: true, restored: boolean } — **soft-retire undo**: clears the session's `retiredAt` mark, returning it to normal service (the row and its full conversation were never touched — soft retire keeps everything). `restored: true` means a mark was actually cleared: emits `agent:restored { agentId, agentName }` (§6.5) and the row rejoins the default `agent.list` read, the `agentSummary` card aggregate, and the workspace attention / unread derivations (§5.1) — a restored session parked in `error` or holding a pending blocker / discussion / question feeds the `displayStatus` attention rungs again (the restore op recomputes-and-compares `displayStatus`, so a rung it reintroduces emits `workspace:displayStatus-changed`). **Restore is SILENT for the workspace `unread` state**: no stored-flag write and no `workspace:attention-changed` — `workspace.get` / `workspace.list` simply re-derive `attention: "unread"` for a restored session whose newest assistant message is still unseen. `restored: false` is the documented no-op on a non-retired session (idempotent-friendly for double-clicks/replays; no event). A caller-declared `workspaceId` is validated against the session row (mirroring `agent.cancelDelete`), so a cross-workspace restore is NotFound. **Retirement** is available through user/FE `agent.retire` above and the self-scoped MCP `ws.agent.retire(reason?)` binding (the latter is present only when `agentFeatures.peerAgents` is on, §5.12). Both soft-retire the selected session — setting `retiredAt` (migration `0102_agent_session_retired_at.sql`), emitting `agent:retired { agentId, agentName, retiredAt, reason? }` (§6.5), preserving the conversation (still searchable). Retirement is idempotent (a re-retire keeps the original timestamp, no re-emit), and makes the target session **inert** — excluded from default `agent.list` reads and from the workspace-level derivations (it no longer feeds the §5.1 `unread` derivation, the `displayStatus` attention rungs `failed` / `blocked` / `needs_attention`, or `agentSummary`; a session retired mid-turn skips the turn-end unread raise at drain end; retiring the LAST unread top-level session settles the stored flag with ONE `workspace:attention-changed { none }` — see "Retire cascade & cleanup" below), unreachable on the agent-facing MCP surfaces (`ws.agent.status` / `readConversation` / `summary` / `getQueue` reject it; `ws.agent.list` never shows it), and every interaction path fails closed with a clear "agent is retired; restore it with agent.restore" `-32602` (sends, queueing, watches, `agent.retry`, task assignment; queued entries park undrained until restore; `agent.wakeOrCreate` treats a retired assignee as a stale assignment and spawns fresh — a retired session is never resumed and never GC'd by the poisoned-session cleanup). The wire-level detail reads deliberately still serve retired rows — `agent.get` / `agent.getSession` (carrying `retiredAt`) and `agent.getConversation` — so the FE can render the preserved conversation read-only. Users can retire a target directly; MCP agents can retire only themselves. Only the user/FE restores (no MCP restore binding); cancelled hooks, monitors, subscriptions and outgoing watches/groups are not restored |
| agent.wakeOrCreate | taskNoteId (req), contextMessage (req), model?, reasoningEffort?, callerAgentId?, delegationDepth?, messageMetadata?, create? { name?, specialist?, provider?, agentType?, model?, reasoningEffort?, contextReferences?, metadata?, skipAutoCommit? } | { ok, agentId, agentName, created, action: "message_queued_to_active_agent" \| "woke_existing" \| "created_new", taskTitle, result, cleanedUpAgentIds?, subscriptionId?, message? } — depth-guard rejects `delegationDepth >= MAX_DELEGATION_DEPTH` with `-32602` (`MAX_DELEGATION_DEPTH` cap = 2; caller depth is otherwise inherited from `callerAgentId`'s session metadata + 1). Both `model` params (top-level and `create.model`) must be **bare** model ids — a compound `provider:model` value is rejected with `-32602` naming the offending param ([intent-hq/intentd#1647](https://github.com/intent-hq/intentd/pull/1647)). Pre-widening 3-required-params callers stay wire-compatible; `create.*` is only consulted on the create branch and specialist/model from the newest assigned session takes precedence over `create.specialist`/`create.model` when a resumable candidate is found. **Reasoning effort (additive, create branch only):** the top-level `reasoningEffort` wins over `create.reasoningEffort`, then the chosen specialist model option's effort, then the specialist's `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12) — which applies only when the child's model itself resolved from the settings default chain, never alongside a caller-supplied model or a specialist model pin — then unset. A level from the param / model-option / frontmatter rungs is validated against the cached catalog's `effortLevels` for the resolved model exactly as on `agent.delegate` (§5.11 "Delegation reasoning-effort resolution"), with the `-32602` raised before the child is created; a settings-derived level is instead dropped with a daemon warn log when unsupported, never rejected. The wake branch never changes an existing session's effort. Skipped poisoned sessions (repeated restore failures, monorepo#840) are quarantined out of candidate selection; on both wake and create branches each one's parked queue is migrated to the woken/created agent via an atomic durable hand-off (one transaction moves the persisted rows, so a crash leaves the messages on exactly one queue; delivery stays at-least-once) and the session is then hard-deleted with one `agent:deleted` emitted — `cleanedUpAgentIds` still lists them (monorepo#847). A failed migration is non-fatal to the wake but that id is withheld from `cleanedUpAgentIds` and its task assignment survives (messages stay durable on the poisoned queue), so the next `agent.wakeOrCreate` retries the migration + GC. **`callerAgentId`-present responses (SUB-1 auto-subscription, monorepo#926/#933):** when `callerAgentId` is provided, ALL THREE actions additionally carry `subscriptionId` — the id of the deliver-once completion watch registered for the caller against the target agent — and `message`, a human-readable summary of the action taken ending with "You will be notified when the agent responds.". The queued branch (`message_queued_to_active_agent`) needs no special watch mode: queue-aware completion (§Completion-watch persistence) means the target's `agent:idle` for its in-flight turn is an interim idle (the queued message is still pending) and neither delivers nor retires the watch — the wake fires at the real completion after the queued turn, with no leak-guard timer. Repeated calls for the same caller/target pair reuse (or adopt, per the pair-uniqueness invariant in §Completion-watch persistence) the existing watch under the same `subscriptionId` instead of stacking duplicates; the create branch always registers a fresh watch (the child id was freshly minted this call). Both fields are absent when `callerAgentId` is omitted, and likewise when the named caller's session is Deleted — no completion watch is registered for a deleted caller (intentd#667). |
| agent.summary | agentId (req) | quick summary of what the agent did |
| agent.reportToParent | report (req) | service result — -32603 if caller is not a delegated agent. Persists `metadata.completionReport` / `completionReportTimestamp` on the child session (re-served by agent.get/agent.list) and emits `agent:updated` (P3-1.2b). Delivery: a non-grouped delegated child delivers one immediate **progress** wake at reportToParent time (directly to `session.parent_agent_id`, no watch required). This progress wake does not suppress, consume, or retire the parent's terminal completion watch; when a matching watch exists, its `event_notification` metadata carries `watchStillArmed: true`. The child's later genuine `agent:idle`, `agent:failed`, or `agent:deleted` completion therefore still delivers the terminal wake to the parent and any third-party watchers. The daemon durably queues that wake under the stable `completion-wake:<watchId>` message identity before a transaction records the stable completion or failure identity and deletes the persisted watch; only after that commit does it remove the in-memory watch. A delivery or settlement retry reuses the stable message identity, and a replayed completion identity is suppressed without consuming a re-armed watch for a future completion. Children that never report keep the same terminal wake with `lastResponseSummary`. Grouped children (`after_all`) do not get an immediate progress wake — the persisted report reaches the parent only inside the group's single aggregated wake (as that child's `Report:` line, which wins over `lastResponseSummary`); a late report after group delivery wakes immediately. All internal parent wakes (completion watches, the aggregated group wake, immediate reports) run a real parent turn through the runtime send-message path — normal `agent:stream:*` / `agent:idle` lifecycle, queued if the parent is mid-turn. **Stale queued-message redrives (new in intentd, #576):** a message queued to a delegated child while it was mid-turn, but drained only AFTER the child's completion report was persisted and delivered, is **stale** (the entry's `queuedAt` — the same wire field served by `agent.getQueue` — predates the session's `completionReportTimestamp`). A stale redrive's turn (1) **skips the turn-begin report clear** — the delivered report stays queryable via `agent.get`/`agent.list` and no `agent:updated` with `completionReportCleared: true` fires for that turn (a genuine re-report still overwrites it through `agent.reportToParent`) — and (2) the redriven message content gains a deterministic `[SYSTEM NOTE]` annotation (appended before the transcript persist, so the persisted user row and the provider prompt match) telling the child its report was already delivered and to re-report only if the message materially changes the outcome. The annotation is idempotent across requeues; for a requeued entry whose user row already reached the transcript (persisted requeue) the annotation is skipped — persisted rows are never mutated — but the report clear is **still suppressed**. Staleness fails open: session-lookup or timestamp-parse failures treat the message as fresh, and fresh messages / non-delegated agents keep the pre-existing behavior (report cleared at next turn begin) |
| agent.getSubscriptions | agentId (req), workspaceId (req) | { subscriptions, delegationGroups, agentStatuses, eventSubscriptions, agents: AgentLite[] } — `agents` is the additive slim participant projection described [below](#bundled-subscription-agents-additive-docs-lead-implementation). (filter fields flattened as top-level actorIds/eventTypes per subscription; no legacy filter object). `eventSubscriptions` (additive, monorepo#947) lists the caller's live `event.subscribe`/`agent.subscribe` registrations — `{ id, workspaceId, subscriberAgentId, eventTypes, excludeSelf, batchWindow, createdAt }` per entry — so an agent can recover a lost `subscriptionId` |
| agent.cancelSubscriptions | agentId (req), workspaceId (req), subscriptionId?, groupId? | { success: true } — unscoped (neither optional param) cancels EVERYTHING the agent registered (all completion watches, all delegation groups it parents — persisted `delegation_group` rows are swept best-effort so cancelled groups don't rehydrate on restart — and all event subscriptions), idempotent, exactly as before the params existed. Scoped *(new in intentd)*: `subscriptionId` cancels exactly that completion watch; `groupId` cancels that delegation group plus its grouped watches (removed together in one registry critical section); both may be combined. Cancelling a GROUPED watch by `subscriptionId` also drops that child from its group's expected set — group settlement is driven by the grouped watches, so the group must not stall on a cancelled child — then attempts to fire the group, since the shrunk group may now be sealed and complete; a group whose expected set becomes empty is removed outright. Each scoped removal deletes the matching persisted `completion_watch` / `delegation_group` row(s) — the group-row delete is durable-before-observable (awaited before any in-memory removal; a failed delete errors the call with the registry untouched) — and publishes the standard `agent:subscriptions-changed` snapshot (§6.5) in the parent's home workspace; event subscriptions are untouched (use `agent.unsubscribe`). An id that does not name a watch/group owned by `agentId` is rejected with `-32602` (`unknown subscription id: <id>` / `unknown delegation group id: <id>`) BEFORE anything is removed, so a combined call is all-or-nothing; a present-but-non-string id is likewise rejected with `-32602` (`subscriptionId must be a string` / `groupId must be a string`) rather than being coerced into an unscoped cancel |
| agent.subscribe (deprecated) | workspaceId (req), eventTypes (req, array), agentId?, excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — not the WS streaming surface (use events.subscribe). Registers a real internal subscription: when `agentId` names a subscriber agent, matching workspace events (category wildcards or exact types) are coalesced over `batchWindow` ms (default 500) and delivered as one `[WORKSPACE EVENTS]` wake message per batch, with `event_notification` message metadata; `excludeSelf` (default true) drops the subscriber's own events. **Agent events are off-limits to agent subscribers ([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229)):** when the call carries a subscriber agent, every explicit `agent:`-prefixed entry — exact types, the `agent:*` wildcard itself, and the observability events — plus `chat:stream:delta` is rejected with `-32602` at subscribe time, atomically (a mixed list like `["note:*", "agent:*"]` registers NOTHING; the error text redirects to `ws.agent.watch(agentId)` and lists the non-agent categories that remain available). A bare `*` is NOT rejected: it silently narrows to the non-agent category wildcards at resolution time (front-door `*` expansion is unchanged and still includes `agent:*`). A **match-time guard** backs the subscribe-time one: agent-owned delivery filters set `exclude_agent_events`, so legacy `agent:*` rows persisted before the guard existed never deliver agent events after a daemon restart. Subscriber-less (FE front-door) subscriptions are exempt from all of this and keep the full stream. Agent-owned subscriptions persist across daemon restarts (rows whose subscriber is gone — or whose workspace no longer exists, `__chief__` exempt — are pruned at startup, monorepo#947). Live subscriptions are listed via `agent.getSubscriptions` (`eventSubscriptions`) and reported by `agent.diagnostics`. `workspace.delete` drops the workspace's event subscriptions (delivery tasks aborted, rows deleted). Without `agentId` (FE front door) the subscription is match-only in memory — no wake target. Over the MCP seam (`ws.agent.subscribe` / `ws.event.subscribe`) the subscriber is the calling agent automatically (so the restriction applies; the MCP binding's `*` expansion moved into the daemon for the per-subscriber resolution). |
| agent.unsubscribe (deprecated) | workspaceId (req), subscriptionId (req) | service result `{ success: true, subscriptionId }` — stops delivery; unknown id errors |

#### Bundled subscription agents (additive, docs lead implementation)

`agent.getSubscriptions` adds `agents: AgentLite[]` to its existing result. On a
supporting daemon the array is always present, including `[]` when there are no
resolvable participants; it is never `null`. This is a prepared additive contract,
not a claim that the pinned daemon or an installed release already serves it.

- **Membership:** one row per distinct ID in the union of
  `subscriptions[*].actorIds` and `delegationGroups[*].expectedAgentIds`. An ID
  appearing in several watches, in several groups, or in both appears once.
  The requesting `agentId` is included only if it belongs to that union; event
  subscription registrations do not add participants. Completed group members
  remain eligible while they remain in `expectedAgentIds`. Row order is
  unspecified; consumers join by `id`, never by array position.
- **Missing and retired participants:** a missing session row (including a
  hard-deleted agent), or a session summary that cannot be decoded, is omitted
  without removing its references from watches or groups. An existing decodable
  row with stored status `Deleted` is not separately excluded; it uses the
  canonical list projection, including any runtime pending-delete overlay.
  Existing `completedAgentIds` and `deletedAgentIds` retain their meaning.
  A soft-retired participant whose session still exists is included with
  `retiredAt`, using the same row projection as an `agent.list` read that includes
  retired sessions. Absence from `agents` is not a deletion event and must not
  evict a cached session or rewrite group membership.
- **Ownership:** each row retains its actual `workspaceId`, even when different
  from the request's `workspaceId` or the watch's parent workspace. In particular,
  a Chief watch into a project workspace returns that participant's project
  workspace ID. The request and subscription anchors keep their existing routing
  and ownership meaning; clients must not relabel returned rows into the caller's
  workspace. Agent IDs and cached rows remain scoped to the connected backend.
- **Projection and read cost:** rows use the slim `agent.list` projection above,
  including its live-turn/waiting flags and active hook/PR-monitor overlays, with
  the same omitted-when-empty fields. Read only the referenced IDs in batches
  (chunking at database bind limits is allowed), using session summaries and
  message preview projections. Do not hydrate full transcripts, call `agent.get`
  once per participant, or list every agent in each participant workspace.
  `harnessFeatures`, `effortLevels`, `contextReferences`, `fileBlocks`, `stats`,
  and `metadata.pendingProposals` / `metadata.proposalResolutions` are stripped
  as on list rows; no transcript or system prompt is added.
- **Bounds:** apply the list caps after runtime overlays: 400-byte render-preview
  and attention-reason caps, 128-byte name/model caps, and 256-byte sandbox
  path/branch caps, with the same JSON-serialized-size, character-boundary and
  `lastToolUse` envelope caveats as `agent.list`. The existing 6 KiB representative
  row golden applies; it is not a universal hard row limit. Apply the same
  response-level preview fit to the `agents` array (1,000 KiB target, preview caps
  reduced down to the 50-byte floor as needed). This never drops participants.
  The target covers the array only: subscriptions, groups, statuses, event
  registrations and the RPC envelope add bytes. Neither the target nor the row
  golden guarantees a hard bound on the whole response for arbitrarily many
  participants.

`subscriptions`, `delegationGroups`, `agentStatuses`, and `eventSubscriptions`
are preserved. In particular, `agentStatuses` still covers the requester plus
watched/group participants using its existing normalized status vocabulary and
missing/deleted-status handling; it is not narrowed to the new array's membership
or replaced by `AgentLite.status`. Existing events and invalidation/reconnect
behavior remain unchanged.

Compatibility is presence-detected, with no new request parameter, capability or
protocol-version bump. Older clients ignore the extra result key. Against an older
daemon, a client must accept an absent `agents` key and retain its existing cached
row/detail-read fallback. When present, merge slim rows without erasing cached
transcripts or detail-only fields, before publishing subscription readiness.
This supplies participant cards; it does not replace the open chat's own detail
refresh. Existing detail reads remain available for uncached participant details.

**Assistant prompt-version marker (additive, presence-detected; [intent#5830](https://github.com/intent-hq/intent/issues/5830)).**
The `agent.list` / `agent.get` metadata shape above additionally includes
`chiefPromptVersion?: number`. This is a caller-supplied version of the built-in
Assistant's creation-time instructions, not the daemon protocol or harness version.
The internal specialist id stays `chief-of-staff`.

- **Create:** `agent.create` accepts `metadata.chiefPromptVersion` alongside the
  caller's `metadata.behaviorPrompt`. A non-null marker must be a positive integer
  in `1..=4294967295` (`u32`); a string, boolean, fractional number, zero, negative
  number, or out-of-range value is rejected with `-32602` before persistence.
  An omitted or `null` marker means no marker. The daemon never assigns a current
  version merely because the request names the Assistant specialist.
- **Read:** the valid numeric marker is returned on the `agent.create` and
  `agent.update` results, `agent.get`, every `agent.list` scope, and the §6.9 agent
  collection's snapshots and deltas. Missing, null, or invalid legacy markers are
  omitted from `AgentLite`, never coerced from strings or inferred from creation
  time. `agent.getSession` retains the raw persisted metadata. No history or saved
  prompt is rewritten and no existing session is backfilled.
- **Invalidation:** `agent.update` clears the marker when `systemPrompt` or the
  canonical specialist actually changes. A no-op patch, name change, or model
  change preserves it. Updating arbitrary metadata (including `behaviorPrompt`
  or the marker) remains unsupported; a client cannot promote an old session by
  patching the marker alone. Later stale session writes must not restore a cleared
  marker. Create a new session to apply a new version of the instructions.
- **Cost and durability:** the marker lives in the existing session metadata JSON
  and survives daemon restart. The existing summary SQL already reads that metadata;
  no additional query or schema change is needed. The wire projection adds only a
  bounded scalar to `AGENT_LIST_ROW_METADATA_KEYS`; the list-row and frame budgets
  still apply. This is a persisted-on-write field (RPC cost ladder rung 1), with no
  transcript or system-prompt hydration on list reads.
- **Client compatibility:** compare the returned numeric marker with the client's
  current prompt version, together with `metadata.specialist === "chief-of-staff"`.
  Reuse additionally requires an empty conversation. An old or absent marker must
  not qualify, even when `createdAt` is recent or in the future. Older daemons omit
  the projected marker, so updated clients decline reuse rather than guess. Older
  clients ignore the new field. Explicit selection and deep links to old threads
  remain valid; this contract does not delete, rename, or migrate those threads.

**Progress wakes and durable final wakes.** This is the current delivery contract and
supersedes the older report-delivery wording in the method-table row above.
`agent.reportToParent` persists the report and, for an ungrouped child, sends one immediate
**progress** wake to the parent. This wake does not consume the terminal completion watch. Its
`event_notification` metadata carries
`watchStillArmed: true` when that watch exists; grouped reports remain deferred to the one
`after_all` aggregate. The later terminal idle/failure/deletion wake carries
`watchStillArmed: false` and retires the watch only after the wake is durably queued. A stable
`completion-wake:<watchId>` message identity makes retry idempotent. The daemon atomically stores
the delivered completion identity and removes the watch; if settlement fails, the persisted
watch remains the restart-recovery record. Replayed completion or failure identities are
suppressed, so restart recovery does not duplicate a final wake.

An `after_all` aggregate uses the stable `completion-group-wake:<groupId>` identity. The daemon
durably queues that wake before it atomically deletes the group and retires its watches; a
failed settlement leaves the complete group restart-recoverable. Immediate progress,
attention, grouped-failure, and monitoring-idle advisory notifications (the advisory leaves the
watch armed on both the ungrouped and grouped shapes — see agent-aux.md → Completion-watch
persistence) can also carry `watchStillArmed: true`; they never claim terminal retirement.

**Creation-time default-model resolution (daemon-owned, [intent-hq/intentd#852](https://github.com/intent-hq/intentd/pull/852)).**
Every creation path — `agent.create`, `agent.delegate`, `agent.wakeOrCreate`, and
`workspace.create`'s `initialAgent` (§5.1) — resolves the session's model through ONE
daemon-side resolver when the client supplies no explicit `model`. Clients are pass-through:
they send a model only when the user explicitly picked one, and never pre-resolve defaults.
Precedence, first match wins:

1. **Explicit client `model`** — always a bare id (compound `provider:model` values are
   rejected at the wire boundary, see the `agent.create` rules above) — validated per those
   rules (provably-mismatched bare id → `-32602` before any side effect).
2. **Specialist frontmatter `model`** (3-tier resolved, project > user > bundled) — used only
   if it belongs to the resolved provider (cached dynamic catalogs, same ownership evidence
   as `agent.create`); a model owned by another provider falls through instead of leaking
   cross-provider.
3. **Settings chain** — `model.providerDefaults[resolved provider]`, then `model.default`
   (§5.12). Provider-guarded like step 2: a configured default owned by
   another provider is dropped with a daemon warn log (falling to step 4) rather than
   rejected — a `-32602` here would reject a model the caller never sent. The chain is
   background-agnostic ([intent-hq/monorepo#1729](https://github.com/intent-hq/monorepo/issues/1729)):
   the `quickActions.*` model settings scope to single-shot quick actions only and are
   never consulted for an agent session, delegated ones included — the former
   `backgroundAgents.typeOverrides[agentType]` / `backgroundAgents.defaultModel` rungs are
   **removed**.
4. **Cached catalog default ([intent-hq/intentd#1279](https://github.com/intent-hq/intentd/pull/1279))** —
   the `id` of the resolved provider's cached catalog row marked `isDefault: true` (§5.30).
   Cache-only and probe-free: the rung reads the in-memory/persisted last-good `models.list`
   entry under the provider's current registry version key and NEVER triggers a probe
   (subprocess spawn) on the creation path or on the `specialist.list`/`specialist.get`
   previews. A cold cache, a stale-pin entry, or a catalog without a marked row falls
   through to step 5 — byte-identical to the pre-rung behavior. Pinning the row's id to
   `session.model` freezes the model for the session's lifetime even if the provider later
   changes its own default, so the model shown in previews is the model the agent actually
   runs. This is NOT a settings default: the settings default reasoning effort
   (`model.defaultReasoningEffort`, below) does not apply to it.
5. **None** — `session.model` stays unset; the provider CLI's own default applies.

The former specialist frontmatter `modelTier` step is **retired** (tolerated-and-ignored,
§5.11): a specialist's model is either an explicit frontmatter `model` pin or inherited via
the settings chain. The static tier tables themselves are **removed** ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922))
— `providers.catalog` (§5.38) no longer serves `modelTiers`, and no tier concept
participates anywhere in resolution.

Specialist `modelOptions` (§5.11) likewise adds **no resolver step**: the list is advisory
— surfaced to delegating agents in the `workspace_api` tool description's
`ws.agent.delegate` docs — and a chosen option is sent as the explicit client `model`, i.e.
step 1 above, which remains the first-match step exactly as before. A caller that omits
`model` resolves through steps 2–5 unchanged, regardless of any `modelOptions`. The
per-option `reasoningEffort` (§5.11) is likewise not a resolver step for `model` — it only
feeds the separate delegation reasoning-effort resolution.

The resolved provider is the explicit `provider` param, else the **settings-derived
default** — `model.defaultProvider` (§5.12; [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)), registry-validated and
whitespace-trimmed on read so a stale or mistyped id reads as unset. The retired
`providers.active` key is never consulted (a legacy value is carried into
`model.defaultProvider` by a one-time boot migration, [intent-hq/intentd#1658](https://github.com/intent-hq/intentd/pull/1658)), and there is no
positional last resort: no provider carries a hardcoded default designation, and
resolution that falls through entirely fails loudly with `-32602` at the creation seams
([intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)). The resolved model is
persisted to `session.model` at creation time, **pinning it for the session's lifetime**:
later settings/specialist changes only affect agents created afterwards, and an existing
agent's model changes only via explicit `agent.setModel`. Bundled specialists ship with no
frontmatter `model`, so they inherit the user's configured default (step 3), the cached
catalog default (step 4), or the provider CLI default. `specialist.get`/`specialist.list`
preview this resolution via the additive `resolvedModel`/`resolvedProvider` fields (§5.11),
computed by the same resolver.

**Creation-time reasoning-effort resolution (daemon-owned, [intent-hq/intentd#970](https://github.com/intent-hq/intentd/pull/970) / [#974](https://github.com/intent-hq/intentd/pull/974)).**
Every creation path resolves the session's `reasoningEffort` through one daemon-side chain,
parallel to the default-model resolver above. Precedence, first match wins:

1. **Explicit caller `reasoningEffort`** (`agent.create`, `agent.delegate`,
   `agent.wakeOrCreate`'s create branch — where the top-level param wins over
   `create.reasoningEffort`). A **present** value is the caller's decision and never falls
   through: an empty or whitespace-only value is an explicit clear that leaves the session
   effort unset (it does not reach the rungs below).
2. **Specialist `modelOptions` effort** — the `reasoningEffort` of the chosen model option
   whose `model` matches the resolved model (§5.11).
3. **Specialist frontmatter `reasoningEffort`** scalar (3-tier resolved).
4. **Settings `model.defaultReasoningEffort`** (§5.12) — applied only when no rung above
   decided AND the session's **model itself resolved from the settings chain** (step 3 of
   the default-model resolver above). A caller-supplied model, a specialist frontmatter pin,
   a catalog-default-resolved model (step 4), or a fall-through to the provider CLI default
   all leave the effort unset here.
5. **Unset** — the provider's own default applies.

Rungs 2–3 apply on `agent.create` too when it names a `specialistId` and the caller supplied
no `reasoningEffort` (the delegate / wakeOrCreate seams pre-resolve them and pass the result
down as the param, so they are resolved exactly once).

**Validation is asymmetric by source.** A level resolved from rungs 1–3 is validated against
the resolved model's cached `effortLevels` and a level outside that list is rejected with
`-32602` naming the model and the valid values, before any side effect (§5.11 "Delegation
reasoning-effort resolution"). The **settings** rung is lenient in the same way the settings
default-model chain is: a level the resolved model's cached catalog provably does not list is
**dropped with a daemon warn log** (the session effort stays unset), never a `-32602` — a
rejection there would fail a creation over a value the caller never sent. With no cached
evidence — no resolved model, no cached row, or a row declaring no `effortLevels` — the level
passes through unvalidated on every rung.

**Reasoning effort — session field & application *(v5.2)*.** `reasoningEffort` is a
first-class `AgentSession` field (set at `agent.create` / `agent.delegate` /
`agent.wakeOrCreate`'s create branch, patchable via `agent.update`, served on both the
`AgentSession` and `AgentLite` projections, omitted when unset). It is persisted **as-is** —
providers own the level vocabulary (`effortLevels`, §5.30) and the daemon never normalizes
the caller's spelling. Application is **generic and provider-agnostic**: at session open (and
resume) the daemon records whichever `configOptions` entry the adapter advertised under
`category: "thought_level"` (e.g. claude-agent-acp's `effort`, codex-acp's
`reasoning_effort`) and applies the stored level through
`session/set_config_option` under that adapter's own config id — no provider capability flag,
and a provider that advertises no such option silently ignores the field. The application is
idempotent and change-driven: the daemon tracks the value the adapter is on, skips a re-apply
when nothing changed, and skips a level the select does not accept (so a stale level from
another provider's vocabulary is never sent). Matching against the advertised values is
**case-insensitive** and the adapter's own spelling is what gets sent — the stored level keeps
the caller's spelling (validation is case-insensitive too), so a persisted `"HIGH"` reaches a
`["low","high"]` select as `"high"`. **Clearing** `reasoningEffort` restores the provider's own
default — the value the adapter reported at session open — so the clear takes effect on the
live session instead of leaving the last applied level in place. A mid-session `reasoningEffort` change needs
**no respawn** — it is re-applied on the live session at the next turn start, so it takes
effect for the next prompt. Failures are logged and never fail session startup or the turn:
the provider simply keeps its current effort. The codex spawn path additionally passes the
level as the `-c model_reasoning_effort=…` config override (an effort still embedded in a
legacy `{base}/{effort}` model id wins over the session field; the `CODEX_REASONING_EFFORT` env seam remains
the last-resort fallback). **Legacy compound ids.** Pre-5.2 codex sessions whose
`session.model` embedded the effort as a `{base}/{effort}` suffix (the retired effort-variant
catalog rows, §5.30) are normalized by a one-time store migration into the base model plus
`reasoningEffort`; the split is guarded on a known codex effort suffix AND codex evidence
(the provider column, a legacy `codex:` compound prefix, or a known effort-capable base
model), so slash-bearing non-codex ids (e.g. HuggingFace-style unsloth ids) are untouched.
A separate one-time store migration splits any persisted legacy compound
`provider:model` session ids into the `(provider, model)` column pair
([intent-hq/intentd#1653](https://github.com/intent-hq/intentd/pull/1653)), so stored session models are bare ids too.

**Effort-change transcript notice (additive; no version bump).** At the next successful
turn start, a change from the last committed reasoning-effort choice persists one
informational message with `role: "system"`, one readable text block (for example,
`"Effort changed from Medium to High."`), and row metadata:

```json
{
  "type": "effort_changed",
  "from": "medium",
  "to": "high"
}
```

Both `from` and `to` are present and each is `string | null`: strings are provider-owned
effort values, with no closed enumeration; `null` means **Auto / provider default**.
The explicit string `"none"` means **Off**, and must not be collapsed into `null`.
These values describe the confirmed effort choice, not a guess at the provider's
internal reasoning budget. Clients may format known levels for display and must keep
arbitrary provider values readable; the text block is the fallback for clients that
do not recognize `metadata.type`.

The daemon emits the ordinary `agent:message` event with `role: "system"` for the
persisted row. The same row and metadata are returned in transcript history, so live
delivery and a reload show the same notice at the turn that uses the changed effort.
There is no new event type or client-generated transient notice.

The notice follows the application rules above; changing the picker or persisting
`reasoningEffort` with `agent.update` never emits it immediately. In particular, an
in-flight response must not appear to have used a newly selected effort. The daemon
compares with the last successfully committed effort baseline at turn start:

| Situation | Effort notice and baseline |
|---|---|
| First successfully observed effort for the session | Establish the baseline silently; no notice. |
| Next turn successfully uses a different choice, including a clear to Auto | Persist one notice and advance the baseline. |
| Unchanged choice, or a change of casing only | No notice; effort matching is case-insensitive. |
| Change away and back before the next turn | No notice; compare with the committed baseline, not intermediate picker updates. |
| Spawn or effort application fails, or the provider does not support the option/value | No notice and no advance of the confirmed effort baseline; existing fail-soft effort application is unchanged. |

The committed baseline survives daemon restarts and session resume/recreation; a
later turn must not repeat a change already committed. Notice persistence is
best-effort, like the model-change notice: a storage failure is logged and does not
fail the turn. These rows are transcript-only: they are excluded from provider history
replay and never injected into outbound prompts. Existing model/provider-change
notices keep their own behavior and may accompany an effort notice at the same turn.

**Session-discovered effort levels — `effortLevels` *(additive; no version bump)*.**
`effortLevels?: string[]` is an optional, daemon-owned field served on both the
`AgentSession` (`agent.getSession`) and `AgentLite` (`agent.get` / `agent.update`
results — NOT `agent.list` rows, which strip it as detail-only since intent#5383; see
the `agent.list` row) projections — presence-detected, **omitted when
the provider advertises no such option** (absent, never `null` or `[]`). The
`agent.create` result never carries it: a freshly created agent has no session yet, so
discovery has not run — the field first appears after the first session open, via the
`agent:updated` emit below and subsequent `agent.get` / `agent.list` reads. It is
**session-scoped truth**: the values the provider's `category: "thought_level"`
`configOptions` select advertised at the **most recent session open** (the same discovery
that backs the `reasoningEffort` application above), with the adapter's `"default"`
sentinel filtered out case-insensitively — clients render their own leading "Default"
step that maps to a clear — and an empty post-filter list treated as no-support (field
omitted). The persisted set is **replaced wholesale at every session open/resume/recreate**
(cleared when the new session advertises no `thought_level` option), so a provider/model
switch never leaves stale levels, and when an open changes the persisted set the daemon
emits `agent:updated` so clients pick up the change without a reload. The field is
daemon-discovered, never client-written: `effortLevels` is not in the `agent.update`
`changes` whitelist. **Client precedence:** session-advertised `effortLevels` are
authoritative for the reasoning-effort picker on a live session; the catalog `effortLevels`
on `ModelInfo` (§5.30) remain the static/probe metadata the daemon validates
delegation/create-time levels against (§5.11 "Delegation reasoning-effort resolution") and
the picker fallback when the session advertises none.

**Harness versioning — `harnessVersion` & `harnessFeatures` *(within v7.0; [monorepo#2459](https://github.com/intent-hq/monorepo/issues/2459), [intent-hq/intentd#1255](https://github.com/intent-hq/intentd/pull/1255))*.**
Every agent session is permanently stamped **at creation** with the daemon's current
harness version and a snapshot of the effective `agentFeatures` values, and both are
served on the `AgentSession` (`agent.getSession`) and `AgentLite` (`agent.list` /
`agent.get` / `agent.create` / `agent.update` results) projections:

- `harnessVersion` (string, always present) — the harness version the session was
  created under, currently `"2.4"`. **Immutable for the session's life**: a daemon
  upgrade never changes it, and there is no upgrade/migration/pinning op — new sessions
  always get the latest version. The stamp depends only on creation time, never on the
  creator: a delegated child mints the CURRENT version regardless of the delegating
  parent's pin, so mixed-version agent trees within one workspace are expected and
  supported. Pre-feature rows backfill to `"1.0"` (migration 0096; the same serde
  default covers pre-feature persisted payloads), and legacy imports stamp the literal
  `"1.0"` — never the current constant — so pre-harness sessions are never mislabeled
  after a version bump.
- `harnessFeatures` (JSON object) — the effective `agentFeatures` on/off values captured
  at session creation, camelCase keys mirroring the §5.12 `agentFeatures.*` settings
  catalog, e.g.:

  ```json
  {
    "backgroundHooks": true, "hostExec": true, "scripts": true,
    "terminalAccess": true, "browserAutomation": true, "richChatBlocks": true,
    "structuredQuestions": true, "attentionRequests": true, "stateSnapshot": true,
    "prMonitor": true, "taskGraph": true, "peerAgents": true, "mcpTools": true
  }
  ```

  Immutable like the version — later settings changes affect only new sessions — and
  **the snapshot is what the session actually runs with**: session (re)spawns resolve
  the agent's MCP tool surface and prompt assembly from the persisted snapshot rather
  than the live settings, so a settings flip never alters an existing session's tools
  and the wire report never disagrees with the runtime surface. This covers the
  per-turn snapshot-line injection too: `agentFeatures.stateSnapshot` gates it from
  the captured snapshot like every other toggle
  ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)). Two documented
  exceptions stay live: `agentFeatures.backgroundHooks` is
  re-checked live in the services layer on every `hook.schedule` (defense in depth
  behind the MCP dispatch deny) — a flip to `false` denies new schedules from ALL
  sessions regardless of their snapshot, while already-active hooks are unaffected and
  run to their terminal state/TTL — and `agentFeatures.mcpTools`
  ([intentd#1483](https://github.com/intent-hq/intentd/pull/1483)) is re-checked
  live in the services layer on every forwarded `ws.mcp.*` call (alongside the
  `mcp.enableUserServers` master switch and per-server disabled state) — a flip to
  `false` denies MCP tool calls immediately from ALL sessions, including pre-flip
  ones whose snapshot still advertises `ws.mcp.*`. For both, the captured value
  records the creation-time setting without freezing the behavior. The pre-existing per-session
  `taskGraph` pin folds into the snapshot: readers prefer `harnessFeatures.taskGraph`,
  falling back to the legacy per-session column for older rows (behavior identical).
  The detail reads (`agent.get` / `agent.getSession` / the `agent.create` result) always
  carry a value — `agent.list` rows omit `harnessFeatures` entirely since the
  intent#5383 detail-only strip (see the `agent.list` row; `harnessVersion` stays on
  list rows): a legacy pre-snapshot row (NULL in the store)
  follows the LIVE effective settings on read until its first post-launch activation
  (`ensure_started` — the choke point every turn funnels through: first spawn, resume,
  respawn, wake), which materializes the snapshot ONCE from the resolved live values —
  with the legacy per-session `taskGraph` pin winning over the live setting — and
  persists it (idempotent: the store write is guarded on `harness_features IS NULL`,
  so the first write wins and a concurrent activation never rewrites). From then on
  the row reads its frozen snapshot like any new session; `harnessVersion` stays
  `"1.0"` — only the flags freeze.

**Doctrine vs. reference.** The harness version identifies the **doctrine** a session is
pinned to — the instruction/prompt text and the feature values it was created under — as
a permanent creation-time stamp, not a reference that upgrades with the daemon. The
**reference layer** — the wire protocol and method catalog, MCP tool schemas, and runtime
semantics — always tracks the live binary and is **never versioned**: `harnessVersion` /
`harnessFeatures` are additive response fields within protocol 7.0, and a future harness
version bump (when doctrine text or feature defaults change materially) is independent of
the protocol version.

**Agent attention requests *(new in intentd)*.** Two MCP `workspace_api` bindings —
`ws.agent.requestDiscussion(reason)` (`kind: "discussion"`) and `ws.agent.reportBlocker(reason)`
(`kind: "blocker"`) — let an agent flag that it is stuck BEFORE ending its turn: a discussion
request when it needs user/coordinator input to proceed, a blocker report for an
infrastructure/environment problem it cannot resolve (broken sandbox, failing environment,
missing credentials). There is **no wire method** (MCP bindings only, following the §6.8
principle); both return `{ ok: true, kind, reason, savedAt }`. Available to EVERY agent —
delegated or not, with or without a linked task. `reason` is required (trimmed; empty →
`-32602`), an unknown kind is `-32602`, and a caller-context-free invocation is rejected
(agents only). One shared services op behind both bindings does six things:

1. **Session persistence** — the pending request is persisted on the caller's session as
   `attentionRequestKind` (`"discussion" | "blocker"`), `attentionRequestReason`, and
   `attentionRequestTimestamp` (= the result `savedAt`), served on BOTH the `AgentSession`
   projection (top-level fields, `agent.getSession`) and the `AgentLite` `metadata` block
   (`agent.list`/`agent.get`), omitted when absent. The persist is immediate; the paired
   `agent:updated` raise emit — `data { agentId, attentionRequestKind,
   attentionRequestTimestamp }` — is part of the idle-deferred surfacing bundle (see the
   block after step 6) when the raise comes from inside a live turn. The request is
   **pending state, not status**: `AgentStatus` and `stopReason` are untouched (the turn ends
   normally; no retry affordance), and the request retires when the agent next receives a
   **user-origin** delivery — `agent.sendMessage` (the FE/router front door),
   `agent.sendQueuedMessageNow`, `agent.editAndRegenerate`, or a drained user-origin queue
   entry — a user-typed `agent.queueMessage` entry or a parked user `agent.sendMessage`
   (the same origin taxonomy as the §5.5 pending-questions answer intake). For **child**
   (`parent_agent_id` set) and **background** (`is_background`) sessions, **automatic**
   deliveries (A2A sends, parent/subscription wakes, `agent.sendToTask`,
   `agent.wakeOrCreate` context messages, drained automatic queue entries) **ALSO** retire
   it — the parent/coordinator is those agents' attention surface, so its follow-up is the
   acknowledgement. For top-level foreground agents, automatic deliveries do **NOT** retire
   it (their turns run with the request left pending) — an automatic message must never
   dismiss a request the user has not seen. The turn-begin clear emits `agent:updated` with
   `data { agentId, attentionRequestCleared: true }` and removes all three session fields
   (skipped silently when none is pending); no new wire surface is introduced by the
   child/background automatic retire. Both the surfacing and the retire also
   recompute-and-compare the workspace's derived `displayStatus` — a top-level foreground
   agent's pending request promotes it to `blocked` (kind `blocker`) or `needs_attention`
   (kind `discussion`) (§5.1 steps 1–2), pushed as
   `workspace:displayStatus-changed` on an actual transition (§6.5); for a mid-turn raise
   the raise-side recompute runs at the turn-end flush, not at tool-call time — a pending
   request whose surfacing is still parked does not feed the derivation (idle-deferred
   surfacing, below).
2. **Transcript notice** — a system-role message is appended with a single text block carrying
   the reason and `meta.kind = "discussion-request"` / `"blocker-report"` (the
   `InterruptionNotice` shape, §5.35), emitting the standard `agent:message`
   (`role: "system"`), so the conversation renders a distinct card that survives rehydration.
   Best-effort: an append failure is logged and swallowed (the session fields above are the
   durable contract). Appended at surfacing time — deferred to turn end for mid-turn raises
   (idle-deferred surfacing, below), so the notice lands after the turn's own output rather
   than interleaved with it.
3. **`agent:attention-requested` event** — the self-sufficient (§6.7) toast-driving event,
   `data { workspaceId, agentId, agentName, kind, reason, parentAgentId? }` (§6.5), emitted
   at surfacing time (deferred to turn end for mid-turn raises — idle-deferred surfacing,
   below).
   `parentAgentId` ([intentd#788](https://github.com/intent-hq/intentd/pull/788)) is present
   only when the caller is a delegated/parented agent (the session's `parent_agent_id`) and
   **omitted entirely otherwise — never `null`, and when present always the parent's
   non-empty agent id (never `""`)**; the FE suppresses its sticky attention toast when the
   field is present (its non-empty-string check is defensive hardening, not a contract
   carve-out; the parent wake in step 5 is the delegated child's attention surface, not a
   user-facing toast).
4. **Linked-task transition** — a caller with a linked task (`taskNoteId` on its session) moves
   it to `discussion_needed` (discussion) / `blocked` (blocker) through the same
   `task.updateNoteStatus` writer the router uses, so `task:status-changed` +
   `task:ready-tasks-changed` fire with the caller as `agentId`. Terminal statuses
   (`complete`/`cancelled`) are never downgraded, an already-at-target status is a no-op, and
   no linked task = skip (best-effort: failures are logged and swallowed).
5. **Parent wake** — a delegated caller's parent receives an immediate kind-flavored
   `[WORKSPACE EVENTS]` wake (`… requests a discussion: <reason>` / `… reports a blocker:
   <reason>`) with `event_notification` metadata embedding the `agent:attention-requested`
   payload (the same enriched payload as step 3, `parentAgentId` included). The wake is
   immediate even for children in an undelivered `after_all` delegation
   group — unlike a grouped child's completion report, which reaches the parent only inside
   the group's single aggregated wake (`agent.reportToParent`, §5.5 table above), an attention
   request is an alert the parent must hear now; the aggregated group wake still folds the
   attention request into that child's line as the record. Non-delegated callers have no
   parent to wake.
6. **Watcher fan-out** ([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229);
   widened by [monorepo#3443](https://github.com/intent-hq/monorepo/issues/3443)) —
   every active completion watch on the caller — whatever path registered it (explicit
   `ws.agent.watch`, delegate auto-watch, wakeOrCreate SUB-1, sender auto-subscribe;
   §Completion-watch persistence), regardless of the `wake_on_attention` flag, which
   remains only the persisted record of an explicit registration — receives the same kind-flavored
   `[WORKSPACE EVENTS]` wake (`Watched agent <name> (<id>) requests a discussion / reports a
   blocker: <reason>`) with `event_notification` metadata embedding the step-3 payload — the
   caller's parent is excluded (step 5 already woke it directly, so a parent that ALSO
   explicitly watches its child never receives a duplicate attention wake). Watches are left
   in place: attention is not a completion.

**Idle-deferred surfacing *(new in intentd —
[intent-hq/intentd#1639](https://github.com/intent-hq/intentd/pull/1639))*.** A raise from
inside a live turn does NOT surface to the user at tool-call time. The op splits in two:
the **immediate** half — the step-1 session persist, the step-4 linked-task transition,
the step-5 parent wake, and the step-6 watcher fan-out — runs at the raise as before,
while the **user-facing surfacing bundle** — the `agent:attention-requested` event
(step 3), the paired `agent:updated` attention-fields emit (step 1), the transcript
notice (step 2), and the `displayStatus` recompute/promotion — is parked on an in-memory
deferred-attention marker and flushed when the raising agent goes idle: clean prompt-turn
settlement, harness-wake idle, user interrupt, or terminal turn failure, ordered
BEFORE the paired `agent:idle` / `agent:failed` emit so subscribers never see a quiet
idle that later grows an attention card (one exception: the §6.6 idle-timeout-cap
failure, where the drain loop publishes its own `agent:failed` before the
terminal-failure handler's flush, so the surfacing lands just AFTER that emit).
A raise with no in-flight turn surfaces
immediately, as before. While the marker is parked the workspace's `displayStatus`
derivation skips the pending request; the request feeds the derivation from the flush
onward, subject to the ordinary §5.1 precedence and eligibility rules — the typical
sequence for a top-level foreground caller is `in_progress` while the raising turn runs,
then `blocked` / `needs_attention` at the flush (§5.1 steps 1–2), but a higher-precedence
axis still outranks it (a terminal-failure flush's `error` park reads `failed`, §5.1
step 0) and a child/background caller's request never feeds the derivation at all.
A request **cleared before its flush** — a mid-turn user-origin
delivery, or an interrupt-with-message whose follow-up delivery clears it at turn
begin — retires the marker WITHOUT surfacing: no toast, no transcript notice, only the
plain `attentionRequestCleared` turn-begin emit. The marker is in-memory only: the
persisted session fields survive a daemon restart and keep feeding reads and the
`displayStatus` derivation, but a parked toast/notice lost to a restart is not replayed.

#### Direct user retirement

`agent.retire` is an additive user/FE lifecycle method, available through the JSON-RPC
router on UDS and authenticated WSS. The daemon advertises support through
`client.hello.server.capabilities.agentRetire: 1`; clients enable the action only when
that flag is present. A protocol version alone is not a support probe, and an absent
flag leaves the action unavailable. It takes a required canonical `agentId`, optional
`workspaceId`, and optional string `reason`. The daemon resolves the target session's
workspace when `workspaceId` is omitted; a supplied workspace must match the session
row (a mismatch is NotFound). Workspace context never grants access by itself.

Authorization follows the existing agent lifecycle steering rules: the administrator,
workspace owner, or a collaborator with access to the target workspace can retire its
agents. A non-member cannot retire an agent by guessing its ID or supplying a different
workspace ID. The daemon enforces these permissions before lifecycle mutation.
This direct user control does **not** consult the model's `agentFeatures.peerAgents`
feature gate. It does not send a chat message, create a model turn, or ask the target to
call MCP. Clients should request user confirmation before issuing the call.

A successful transition returns `{ success: true, retiredAt: "<ISO timestamp>" }` and
emits the existing `agent:retired { agentId, agentName, retiredAt, reason? }` event (§6.5).
`reason` is optional event context, not a prompt sent to the target. An already-retired
target returns `{ success: true, retiredAt: "<original timestamp>", alreadyRetired: true }`;
the original mark is preserved and no retirement event is re-emitted. `alreadyRetired`
is omitted on a new transition.

The active-descendant refusal below runs **before stopping the target or making any
retirement mutation**, including cleanup or cascade. If that guard passes, retirement
stops a running target and makes it inert: no subsequent turn or automatic wake may
start while its retirement mark remains. Hooks, PR monitors, event subscriptions and
outgoing completion watches/groups are cancelled or removed as described below.
Conversation history remains readable, and `agent.restore` is the explicit undo;
restoration does not restart the interrupted turn or resurrect cancelled wake sources.

This wire response is distinct from the MCP `ws.agent.retire(reason?)` response
`{ ok: true, agentId, retired: true, retiredAt, reason? }`. The MCP binding remains
self-only, terminal for its caller, and feature-gated; adding a user route does not grant
agents an MCP operation to retire another agent.

**Peer agents *(within v7.5; reshaped within v8.1 — `spawnPeer` merged into `create`)*.** Two
MCP `workspace_api` surfaces — the `topLevel: true` option on `ws.agent.create` and the
`ws.agent.retire` binding — let agents create independent co-equal top-level agents and retire
their own sessions. These agent-facing controls are **MCP-only** (§6.8 principle);
the separate user/FE `agent.retire` and `agent.restore` methods are documented above.
The shared retirement projections — `retiredAt`, `includeRetired`, and
`agent:retired`/`agent:restored` — are on the `agent.list` / `agent.restore` rows and §6.5.
Originally shipped within v7.5 as the standalone
`ws.agent.spawnPeer(name, message, opts?)` MCP binding; within v8.1
([intent-hq/intentd#1520](https://github.com/intent-hq/intentd/pull/1520)) that binding was
**removed** (no compatibility alias) and its behavior folded into `ws.agent.create` behind the
`topLevel` option. Both surfaces are **feature-gated behind `agentFeatures.peerAgents`**
(§5.12; boolean, default **`true`** — an explicit `false` opts out),
captured at session/bridge creation like the other `agentFeatures` toggles, so a flip applies
to new sessions only; for `create` the gate is **arg-conditional** at the dispatch layer —
only `topLevel: true` calls are denied when the toggle is off, with an error naming the
setting ("`agent.create` with topLevel: true is disabled in settings (agentFeatures.peerAgents
= false)"), and plain `create` is never feature-gated. `create({ topLevel: true })` is
additionally restricted to **FOREGROUND TOP-LEVEL callers** (stricter than the v7.5
`spawnPeer`, which denied only sub-agents; parity with `ws.workspace.proposeSibling`): a
sub-agent is denied at the dispatch layer with the actionable redirect ("ws.agent.create with
topLevel: true is only available to top-level agents — use ws.agent.create (without topLevel)
or ws.agent.delegate to start sub-agents instead" — the redirect wins over the feature-gate
denial, like the `ws.app.question` gate, so a sub-agent gets the actionable message rather
than a settings complaint), and a background top-level caller is denied at the handler layer
by reading the caller's persisted `isBackground` metadata ("create with topLevel: true is only
available to foreground top-level agents — background agents cannot create independent
top-level agents; use ws.agent.create or ws.agent.delegate to start sub-agents instead").
Unlike the removed binding — which a sub-agent bridge omitted from its tool surface/docs — the
`topLevel` option stays visible in sub-agent tool docs (the `ws.agent.create` doc line
documents it on every bridge); the runtime denial is the enforcement. The co-gated
`ws.agent.retire` keeps its method-level gate and stays available to sub-agents.

- **`ws.agent.create({ topLevel: true, ... })`** →
  `{ ok: true, id, agentId, name, sponsorAgentId }` (`id`/`agentId` both carry the new agent's
  id; `sponsorAgentId` echoes the caller; **no `subscriptionId`**, unlike the child-create
  result) — create an **INDEPENDENT top-level agent**: a co-equal peer, not a sub-agent. The
  agent is created exactly like a user-created top-level agent — depth 0, **no
  `parentAgentId`**, no `createdByAgentId` — so the delegation depth guard, child-linkage
  suppressions, and `reportToParent` plumbing never see the sponsor, and the caller gets **NO
  completion watch** on the new agent (watch explicitly with `ws.agent.watch`; the SUB-1
  target-side gate on the `agent.sendMessage` row above keeps later sends to it watch-free
  too). Requires an agent caller identity ("create with topLevel: true requires an agent
  caller identity" otherwise); `name` and `message` are required (MCP tool errors naming the
  missing arg otherwise); `taskNoteId` is **rejected** ("topLevel: true cannot be combined
  with taskNoteId — a top-level agent is independent; use ws.agent.delegate (or create without
  topLevel) to assign a task" — task assignment stays a delegation concept). The other options
  keep their spawnPeer semantics: `specialist`, `model`, `provider`, `reasoningEffort`,
  `behaviorPrompt`, `isBackground` (default **`false`** — agent-created top-level agents are
  FOREGROUND by default), and `idempotencyKey` (defaulted when omitted). The caller is
  recorded as the new agent's `metadata.sponsorAgentId` (**attribution only** — served on the
  `AgentLite`/`AgentSession` metadata blocks, see the `agent.list` row) and a daemon-prepended
  **sponsor preamble** is prefixed to the delivered initial message, naming the sponsor (name
  + id), stating the agent's independent co-equal standing (no parent, no reporting obligation
  — `reportToParent` does not apply), and pointing at `ws.agent.list` / `ws.agent.send` for
  coordination. The composed kickoff (preamble + caller message) is persisted as
  `AgentSession.initialMessage` (served by `agent.getSession` only — off the `AgentLite`
  projection, intentd#1542) AND delivered, so the stored copy matches what the agent received
  (parity with the child-create path), and the kickoff carries the standard daemon-stamped
  `agent_message` sender attribution. **Runaway-spawn guard:** the call is refused with a
  clear error when the workspace's live top-level population is already at the
  `agents.maxTopLevelAgents` cap (§5.12; default 20, minimum 1, no unlimited value) — "Cannot
  create top-level agent: the workspace already has {live} live top-level agents, at the
  `agents.maxTopLevelAgents` cap ({cap}). Retire or delete an agent, or raise the cap in
  settings." — where "live top-level" counts non-deleted, non-retired, parentless depth-0
  sessions, so retired/deleted agents free their slots. Advisory check-then-create (bounds
  runaway spawn loops, not an atomically enforced invariant), enforced only on this
  top-level-create path — user-created agents are never blocked by the cap. The depth guard
  never applies (the new agent is depth 0, so chains of agent-created top-level agents always
  spawn, each bounded by the cap). `topLevel: false` or absent → the existing child-creation
  behavior, byte-for-byte identical results.
- **`ws.agent.retire(reason?)` MCP binding** →
  `{ ok: true, agentId, retired: true, retiredAt, reason? }` — **self-retire only**: soft-retires
  the CALLER's own session (no target parameter; other agents can never be retired this way,
  and a caller-context-free invocation is rejected). TERMINAL for the caller — the mark is
  set immediately and nothing after the call runs, so agents should hand off first (report,
  update task notes). The full soft-retire contract — `retiredAt` persistence, the
  `agent:retired` event with the optional `reason`, idempotency, inertness rules
  (excluded from default `agent.list` reads, unreachable by agents and user chat/wake, every
  interaction path failing closed with the "agent is retired; restore it with
  `agent.restore`" `-32602`), conversation preservation (readable via
  `agent.get`/`agent.getSession`/`agent.getConversation`, still searchable), and the
  user/FE-only `agent.restore` undo — is on the `agent.restore` row in the table above.

**Retire cascade & cleanup.** Retiring a session is more than the `retiredAt` mark — the
shared retire operation guards on, cascades over, and cleans up around the retiring
agent's live work for both direct user retirement and MCP self-retirement:

- **Active-descendant guard**: the retire FAILS (`-32602`, nothing mutated — no partial
  cascade, target stop, or wake-source cancellation) while any descendant — transitive over `parent_agent_id`, grandchildren
  included — is still running a turn, with the error naming each active child
  (`cannot retire: N active child agent(s) still running a turn: <name> (<id>), …`).
  Retired descendants are inert and never count; idle/waiting children pass the guard.
- **Child cascade**: on success every non-terminal, not-already-retired descendant is
  cascade-retired with the parent, each through the same full per-session cleanup and its
  own `agent:retired` emit with `reason: "parent <name> retired"`. A child that started a
  turn AFTER the guard passed is skipped (left running, un-retired) rather than stopped —
  best-effort per child, a failure logs and moves on. Restoring the parent does NOT
  restore cascaded children; each row is individually restorable via `agent.restore`.
- **Hook / PR-monitor sweep**: the retiring session's ACTIVE background hooks (§5.40) and
  PR monitors (§5.42) are cancelled through the shared cancel transitions —
  `hook:cancelled` / `prMonitor:cancelled` emitted — with NO wake notice parked (the owner
  is retired and inert; mirrors the `workspace.archive` sweeps). Its event
  subscriptions are dropped the same way; the pending message queue is kept (restore may
  drain it later).
- **Outgoing-watch cleanup**: the retiring session's own completion watches and
  delegation groups are removed, so they cannot keep retrying wakes for an inert owner.
  This is separate from settling other agents' incoming watches on the target.
- **Incoming-watch settlement**: `agent:retired` is a terminal completion signal for the
  AS-3 delivery loop — watchers holding a completion watch on the retiring agent get ONE
  wake noting the retirement (the retired-notice tail: the watch is consumed and "The
  agent retired and cannot be re-watched or woken again" — no re-arm pointer, since
  `agent.watch` rejects retired targets), and a retired child records in its parent's
  `after_all` group like a deletion (terminal, non-completing), so groups never hang on it.
- **Workspace unread settle**: a retired session drops out of the §5.1 `unread`
  derivation, so the retire op probes the derived unread BEFORE the retire write and,
  when the retiring session was the LAST unread top-level session, runs the same atomic
  guarded settle as the last seen-marker advance (`agent.markSeen`): the stored `unread`
  flag is cleared and exactly ONE `workspace:attention-changed { none }` is emitted
  (`review_required` is never touched; a workspace still unread through another session
  stays silent). Runs after the `displayStatus` recompute, so the attention rungs settle
  before the blue dot; cascaded children retire through the same path, and the guarded
  write ensures the clear emits at most once per actual transition.
- **Restore does not resurrect**: `agent.restore` clears the mark only — cancelled hooks
  and PR monitors stay `cancelled` (the agent re-registers if the condition still
  matters, the unarchive precedent). Dropped event subscriptions and outgoing
  completion watches/groups remain removed; consumed incoming watches stay consumed (a watcher
  re-arms with `ws.agent.watch`). Restore is likewise silent for the workspace `unread`
  state — no stored-flag write, no `workspace:attention-changed`; reads re-derive (see
  the `agent.restore` row above).

#### Shared pending human queue

**Same-author append (additive metadata; docs lead implementation).** `agent.queueMessage` and user-origin `agent.sendMessage`
queue fallbacks select the latest pending human submission for that agent by
**arrival order**, independently of drain position or interrupt priority. When its
resolved authenticated principal matches the new submission, append the new text
as `oldContent + "\n\n" + newContent`, retaining the original entry's `id`,
`turnId`, `queuedAt` and queue position. The separator is exactly two newline
characters; existing text is not trimmed. A later human entry from another
principal blocks the append. Automatic/system and agent-sent entries are skipped
when finding the latest human submission, remain separate, and retain their own
order. A successful append records the new human arrival while retaining the
survivor's delivery position; priority reordering never permits skipping a later
human author. Arrival order is unambiguous under concurrent submissions and
survives restart without depending on timestamp ties.

| Pending entries before submission | New submission | Pending entries after submission |
|---|---|---|
| A: first | A: second | A: `first\n\nsecond` |
| A: first, B: reply | A: second | A: first, B: reply, A: second |
| A: first, system: notice | A: second | A: `first\n\nsecond`, system: notice |
| A: first normal, then B: reply interrupt (B drains first) | A: second normal | Three entries; B remains a human barrier despite its earlier drain position |

These examples concern pending entries only. Already delivered transcript rows
are never rewritten by append. The author comparison uses a trusted principal
identity, not a display name, forge handle, client-supplied attribution, or an
imported historical author's identity. Unknown humans never match a current
principal just because their author projection is missing or null.

**Trusted human classification.** Authenticated human identity and server-known
origin take precedence over caller-provided metadata labels. A human submission
with `type: "custom"` is still human, and a human B's `source: "system"` cannot
hide B's entry, make it editable by A, or allow A to merge across it. Custom
semantic metadata is preserved without granting it authorship or ordering
control. Genuine daemon/agent input remains nonhuman even if it supplies forged
human attribution. Legacy unstamped entries use the existing safe authorship
fallback; an unresolved or imported human never becomes automatic merely because
its current-local principal cannot be established.

**Archive wake eligibility.** The surviving entry's `queuedAt` remains its original
enqueue time, including when a fresh human submission is appended after archival.
The daemon persists an optional latest trusted human-submission timestamp
(`latest_human_submission_at` internally; no new wire field) separately from the
original enqueue time. A fresh human entry may use its server-assigned `queuedAt`
without a separate timestamp until a merge needs a distinct time. When the optional
timestamp is absent, including on legacy entries, `queuedAt` is the effective
human-submission time; a present but malformed timestamp fails the eligibility
check instead of falling back. Append and handback coalescing retain the latest
valid submission time across the combined human contributions. Automatic input
cannot advance or supply this signal. Queue persistence, restart, edits and
failure/interrupt handbacks preserve it rather than replacing it with recovery
time. Replaying a pending submission's existing message ID is deduplicated before
a new timestamp is assigned, so a duplicate cannot mint fresh archive eligibility.

The archived-workspace gate compares that effective human-submission time with
`archivedAt`, while still requiring a ready user-origin entry and the other drain
gates (§5.1). Thus A1 queued before archive plus same-author A2 submitted after
archive remains one entry with A1's identity and `queuedAt`, yet qualifies to wake
the workspace through A2's fresh human action. A pre-archive entry restored or
appended to by automatic activity alone does not qualify. This signal controls
archive eligibility only; it does not change delivery position, the original
queue-wait timestamp, arrival-order barriers or held/imported-entry restrictions.

**Attachments and metadata.** Append `imageBlocks` and `fileBlocks` in submission
order, keeping each reference/block intact and preserving the original author's
principal stamp. A different interrupt priority does not move the surviving entry
or reorder the entries around it. Captured interrupt carry-over remains separate
from newly appended text so already persisted content is not written again.

Per-message metadata differences do not split otherwise mergeable human input.
The survivor keeps its top-level `messageMetadata`. On append, the additive
`messageMetadata.mergedMessageMetadata` array records the original survivor
metadata followed by every appended submission's metadata in arrival order,
including identical values. Each element is a captured metadata object or JSON
`null` for absent metadata (verified principal stamps normally make both
contributions objects). Repeated appends extend one flat array rather than
nesting aggregates. A human-origin retry may resubmit the canonical
`mergedMessageMetadata` array: human ingress accepts only an array whose elements
are metadata objects or JSON `null`, rejecting malformed shapes before queue mutation. Every object is
sanitized with the same authenticated-caller attribution rules as the root
metadata, preserving its question-answer tags and custom fields while preventing
copied attribution from impersonating another principal. Nested
`mergedMessageMetadata` keys are removed from contribution objects; arbitrary
nested objects are not recursively interpreted as metadata. Append flattens the
accepted contributions into the survivor's aggregate. Queue persistence and
authorized edits retain that aggregate, so retrying a merged message preserves
all of its structured answers. Non-user-origin ingress removes the aggregate
entirely; this semantic answer round trip is restricted to human input.

For example, two same-author submissions with `messageMetadata.topic` values
`"first"` and `"second"` keep `topic: "first"` at the top level and preserve both
original objects in `mergedMessageMetadata`, including their trusted attribution.
The aggregate survives queue persistence and drain onto the delivered row. Known
semantic consumers inspect the top-level metadata and every contribution. In
particular, a `question_answers` tag resolves the currently marked question set
when **any** contribution names that assistant message in
`answeredQuestionsMessageId`; an unrelated contribution must not clear a
different question set. Clients that do not inspect structured metadata continue
to render the single combined message. This additive metadata contract lands in
the protocol docs before its component implementation.

**Edits in progress.** Appending to an entry under edit keeps `editing: true`;
it does not make the entry ready to drain. The daemon preserves text appended
after the editor opened and text restored ahead of the edited contribution by an
undelivered handback. Saving or cancelling a stale draft preserves these surrounding
contributions exactly once. Repeating `editing: true` reaffirms the same hold;
it must not consume the retained prefix/suffix or reset the editor's identity.
Clients keep the exact local unsaved draft stable when a queue snapshot changes.
Finishing the edit with `editing: false` keeps the existing self-drain behavior.

When retained prefix/suffix contributions exist, an `editing: true` acquisition
or reaffirmation must supply the exact represented held draft baseline: the
canonical content excluding those tracked surrounding contributions. A combined
queue snapshot or a changed draft is not a replacement baseline. A mismatch
returns the `-32602` queued-edit conflict described below without changing the
entry, hold or retained contributions. Existing editors can still save or cancel
their draft; an update omitting `editing` preserves the hold bookkeeping. Text
occurrences are never deduplicated: separately submitted identical text remains
distinct input. A rejected acquisition retains the client's draft/input and
shows a recoverable error, without reporting a successful hold or allowing an
unsafe save.

**Authoritative editor mapping (additive; docs lead implementation).**
`QueuedMessage.editingMessageId?: string` identifies the original held editor
message, not a second queue row. It is a non-empty string on every
`editing: true` row, omitted otherwise (never `null` or an empty string). On an
ordinary hold its value is the entry's own `id`; when an undelivered handback
absorbs the held entry, the surviving row keeps
its canonical `id` and carries the held identity in `editingMessageId`. A client
uses an exact ID match to retain its existing draft on that row and submits the
save/cancel against the original held identity. The canonical survivor's author
controls authorization; the alias itself grants no rights. Reaffirming a migrated
hold, saving or cancelling it must address that `editingMessageId`, rather than
another absorbed ID or the survivor's different canonical ID. Repeated holds keep
the same alias. Releasing the hold removes the field, and daemon restart clears
it with the existing editing-hold reset. A client without an existing local draft
for the mapped identity disables new edit initiation on a migrated held row until
release: the combined canonical content is not the original contribution's draft
baseline. A client already editing that exact mapped identity may continue.

For example, with A2 held for editing, A1's handback produces a single row
`{ id: "A1", editing: true, editingMessageId: "A2", ... }`. The A2 editor keeps
its exact unsaved draft; A1's earlier text and later concurrent appends are retained
by the daemon when A2 is saved or cancelled. Clients never infer this mapping from
author equality, content equality, timestamps or row position.

**Distinct held drafts.** If two held identities are combined, the single mapping
selects the oldest held editor identity. A different open local draft stays
visible and recoverable in a conflict state bound to its original ID. The client
explains that queued messages were combined, blocks unsafe save, and offers a
retain/copy or deliberate discard/reapply path. It must neither silently erase
that draft nor submit it against another row. The daemon independently rejects a
save through a displaced edit alias when it would overwrite another contribution,
even for the actual author; knowing an absorbed submission ID is not sufficient
edit authority. The existing RPC error envelope carries `-32602` and the message
`queued edit conflict: this draft was combined into another queued message; refresh before editing`.
The failed request changes neither the entry nor its hold. After release, an
absorbed edit alias is stale: refresh and reacquire the canonical entry before
editing again. Absorbed IDs may still identify that pending survivor for retry,
delete and send-now under those operations' independent authorization rules;
this does not make them freely editable. Deleting a row likewise never retargets
its draft to an unrelated same-author row.

Multiple same-principal clients editing an **unchanged canonical identity** retain
the existing compatible shared hold and last-save-wins semantics, subject to the
baseline check above when surrounding contributions exist. A migrated identity has a
narrower lifetime: after one client releases its hold, another client's save via
the old migrated alias conflicts instead of replacing the full combined content.
That client retains its draft and refreshes before a deliberate reapply. There is
no per-client edit lock, per-alias editable range, or plural editor-ID field in
this contract. Once the survivor is delivered or removed, a stale alias cannot
modify a different entry or resurrect the removed draft.

An entry already persisted to the transcript and requeued after failure is not a
merge target: its delivered history and original retry-turn identity stay intact.
It remains a human barrier, rather than allowing append to skip to an older entry.

**Results and events.** No new method or event is introduced. An append returns
the existing `queuedMessage` result with the surviving entry's complete content,
attachments and position, and its existing `turnId`; queued `agent.sendMessage`
results likewise use the surviving entry's identity. `agent:queue:updated` carries
the post-mutation snapshot with one surviving entry. Clients reconcile optimistic
entries by the returned identity and treat the server snapshot as authoritative;
they must not leave a second row for the new submission. Mutation results use the
existing raw `queuedMessage` projection (`author: null`); resolved attribution comes
from `agent.getQueue` / `agent:queue:updated`. Append alone emits no transcript
`agent:message` or drain-start event. On later delivery the existing
`queuedMessageId` link, turn correlation and persist-before-queue-shrink ordering
still apply (§6.5).

**Processing entry snapshots (additive; docs lead implementation).**
`agent:queue:processing.data.queuedMessages?: QueuedMessage[]` carries the
resolved canonical snapshots of the exact consumed local entries used for that
processing event, never a later queue lookup. When present, the array is nonempty:
one row for ordinary drain or send-now, and every consumed row in delivery order
for a batch. Each row retains its canonical queue `id`, `turnId`, `content`,
ordered `imageBlocks` and `fileBlocks`, contribution metadata and author projection.
There is no synthetic combined single-author row or parallel singular field. The
array is omitted by older daemons, never `null` or empty; existing top-level
fields remain unchanged, so older consumers can ignore the addition.

A batch still emits one processing event. Its top-level `messageId` and `content`
identify the head entry, and its top-level `turnId` identifies the actual combined
provider turn. Array rows retain their individual queue identities and turn IDs;
a client must associate them with that provider turn explicitly without assigning
one row's author or metadata to another. The array preserves all consumed rows,
not just the head, without pretending to be the concatenated provider prompt.

These are attempted-processing entry snapshots, not confirmation of successful
provider delivery or a copy of the whole provider prompt. Ordinary drain publishes
before transcript persistence; a failed persist may restore those entries to the
queue. `agent.sendQueuedMessageNow` instead publishes the single-row array only
after slot admission and successful transcript persistence (or reuse of an
already-persisted row). Lost slot claims and store-error restorations emit no
send-now processing event. The store-only send-now success path publishes its
canonical snapshot after successful persistence too, without starting a provider
turn. Recovery must preserve queue/retry state without making a still-queued entry
appear successfully delivered.

For explicitly matching processed entries/attempts and their provider turn,
clients retain the complete snapshots as authoritative retry data, including
non-head batch contributions. Later stale queue snapshots and delayed enqueue
acknowledgements must not replace them, nor may a later payload-free send-now
success action erase them. A later processing event for a recovered entry in the
same turn may replace earlier authoritative processing state when it represents
the newer attempt; authority is not permanently frozen at the first event.
Correlation uses explicit message, turn and attempt identities, never content equality or deep object equality; a later
identical-text attempt must remain independent. When the array is absent, legacy
fallback cannot treat an unversioned queue snapshot as known newer merely because
it arrived later. The protocol addition lands in the docs first, then the daemon,
then dependent frontend behavior.

**Atomicity and recovery.** Selection and append are one queue mutation, serialized
with concurrent enqueue, edit, remove and drain. Concurrent accepted submissions
retain all text in their serialized order. If drain wins, append cannot rewrite the
popped entry or its transcript row. A provisionally popped human entry remains
an arrival-order barrier until delivery or restoration settles: A1 still pending,
B2 provisionally popped, then A3 arriving must not combine A3 with A1 across B2.
If an undelivered provisional pop is returned to the queue, restoration normalizes
same-author pending contributions atomically using their original arrival order,
without bypassing another human or already-persisted history. For A1 popped, A2
queued, then A1 returned, the result is one entry with A1's surviving identity and
`A1\n\nA2` content, not two adjacent entries. The merged queue payload is durable and
rehydrates as one entry; append does not alter the existing restart rules for
editing holds or imported-human delivery holds. Absorbed submission IDs are kept
with the surviving pending entry for retry deduplication: enqueueing the same
stable ID again returns that entry without appending its content or attachments
twice, including after queue rehydration. This is a pending-entry guarantee,
not a global exactly-once delivery promise. Without the prepared submission
correlation capability below, `agent.queueMessage` has no client-supplied message
ID, so repeating that RPC is a new submission; identical text alone is never a
deduplication key. The JSON-RPC request `id` is only
request/response correlation and does not provide this retry identity.

**Shared reads and separate mutation authority.** All authorized workspace
participants can read every queued entry, including owner-authored, foreign-human
and unknown-human entries. This applies to `agent.getQueue`, `agent.diagnostics`
and both content-bearing queue events. Workspace admission and subscription scope
are unchanged. The human author alone may edit their entry; ownership does not
grant editing rights over another person's words. Authors may delete their own
entries. The actual workspace owner may delete other people's entries even on a
non-host-owner connection, and the existing host administrator bypass remains.
A host member's general workspace management capability (`canManage`) alone is
insufficient for this moderation right. Shared visibility grants no additional
send-now authority. Agent/daemon operations and operations on genuinely
automatic/agent entries retain their existing rules.

Attribution still has three distinct cases: a trusted principal stamp stays
attributed to that principal even if its profile lookup fails; an unstamped legacy
human entry uses the workspace author fallback, becoming unknown human if that
fails; only a genuinely nonhuman entry is unattributed. Imported historical human
entries keep their safe author snapshot and `author.principalId: null`, never fall
back to the receiving owner, and remain subject to the explicit imported-human
send gate. Unknown-human entries are readable but cannot be edited or merged as
if authored by the current user. Mutation checks run against the current entry
inside the same atomic queue operation; admission to a workspace is not enough
to satisfy another person's per-entry author gate.

| Wire caller relative to a human entry | Read | Edit | Delete | Send now |
|---|---|---|---|---|
| Resolved author | Yes | Yes | Yes | Yes |
| Workspace owner, another author | Yes | No | Yes | Only if also host owner |
| Host owner, another author | Yes | No | Yes | Yes |
| Other workspace participant | Yes | No | No | No |
| Unknown human author | Yes | No caller can establish authorship | Workspace or host owner | Current host owner, including the imported-entry authorization gate |

This table covers human entries only. Workspace access is a prerequisite for every
row. Agent/daemon and genuinely nonhuman entry rules are unchanged.

**Required contract scenarios.** Backend and frontend regression fixtures must
cover these observations; passing documentation checks alone is not runtime
evidence.

| Fixture | Required observation |
|---|---|
| Same human, arbitrary `type: "custom"` metadata | One appended human entry; author identity and custom metadata survive |
| A, authenticated B with `source: "system"`, A | Three human contributions remain separated by B; all participants see B |
| Genuine automatic/agent input with spoofed human fields | Trusted origin stays nonhuman; forged attribution grants no edit/merge rights |
| A1 normal, B1 interrupt, A2 normal; repeat after restart | B1 remains the human barrier even when priority places it first to drain |
| A1 pending, B2 provisionally popped, A3 arrives, B2 restored | A3 cannot merge across B2 during the pop window or restoration |
| Undelivered A1 popped, same-author A2 queued, A1 restored | One survivor with A1 identity and arrival-ordered text/attachments/metadata; no loss or duplicate delivery |
| Repeated `editing: true` while more input appends | Repeating the hold does not consume preserved text; later save/cancel keeps every append exactly once |
| Hold A2, restore undelivered A1 into it, append A3, save/cancel using A2 | One A1 row maps `editingMessageId: A2`; exact local draft survives; A1/A3 contributions remain once; authorization checks A1's real author |
| Two distinct held rows combine while their editors contain unsaved text | Oldest held identity remains mapped; unmapped local draft is recoverable under its original ID; unsafe save is blocked by client and daemon, even for its author |
| Same principal, two clients editing the same unchanged canonical identity | Shared hold and existing last-save-wins behavior; repeated holds do not consume surrounding text |
| Client A holds `one`, `two` appends, client B acquires using combined `one\n\ntwo`; repeat with stale B snapshot after `three` appends | B receives `-32602` queued-edit conflict without mutation; B's input stays recoverable and no successful hold is reported; A can still save/cancel while preserving each append once |
| Reaffirm a held baseline after identical text appends more than once; also update with `editing` omitted | Exact baseline reaffirmation remains valid and bookkeeping survives omitted `editing`; save/cancel retains every distinct identical contribution without occurrence deduplication |
| Two clients share migrated A2 alias; first client releases, second saves | Alias field is absent after release; second save returns the stale-edit conflict without mutation and keeps the local draft recoverable |
| New client sees a migrated held row without an existing mapped draft | New edit initiation is disabled until release; existing correctly mapped local editors continue |
| Restart while a migrated edit hold exists | Editing hold and editor alias reset together; an old absorbed edit alias cannot overwrite the combined canonical entry |
| A1 queued, workspace archived, same-author A2 appended | One entry keeps A1 identity/queuedAt but its latest-human-submission time qualifies it for archive wake once ready |
| Post-archive human append followed by handback, failure recovery or restart | Latest human signal survives coalescing and durable recovery; recovery does not replace it with the current time |
| Only pre-archive human input plus post-archive automatic activity, including forged metadata | Automatic input neither supplies nor advances the human signal; workspace remains parked |
| Fresh or legacy user entry without the optional latest-human-submission timestamp | Original queuedAt is the effective submission time; no implicit fresh submission is minted on restart |
| Edit or duplicate retry of a pre-archive pending message ID | Original human signal remains unchanged; no fresh archive eligibility is minted |
| Present malformed latest-human-submission timestamp | Entry does not qualify; a valid queuedAt cannot override the malformed present timestamp |
| Foreign caller, displaced alias, removed survivor, or deleted original editor row | No unauthorized mutation, draft resurrection or guessed migration; a stale alias never targets an unrelated row |
| Persisted failed-turn row restored beside fresh human input | Delivered history stays immutable and cannot become a merge target or a skipped human barrier |
| Processing snapshot, stale queue snapshot and newer enqueue ACK in both arrival orders, through event bridge and both send paths | Matching processed retry retains exact processing text, ordered attachments and answer contributions; later ACK/snapshot cannot overwrite it |
| Multi-row A+B flush with different authors, files/images and answer contributions | One processing event; queuedMessages contains every consumed row in delivery order with original identities/payloads; top-level turnId identifies the provider turn and retry retains non-head contributions |
| Independent attempts with identical content | Explicit message/turn/attempt identities prevent processing data from overwriting another attempt |
| Legacy processing event without queuedMessages | Existing fields remain usable; unversioned snapshot arrival order is not proof of payload freshness |
| Ordinary merged drain, recovered queue and persistence-failure/handback paths | Emitted processing snapshots come from consumed local entries, not a later lookup; recovery cannot make a still-queued entry appear delivered |
| Send-now runtime/store-only success, lost slot claim and store-failure handback | Runtime emits after slot admission and successful transcript persistence/reuse; store-only emits after successful persistence without provider dispatch; lost claim/store-error restoration emits none; later payload-free success retains the authoritative array |
| Same-turn recovery emits a newer processing attempt | Newer explicit attempt replaces prior processing authority; stale snapshots/ACKs still cannot overwrite it |

**Agent-facing queue visibility & sender hygiene *(new in intentd, [intentd#816](https://github.com/intent-hq/intentd/pull/816))*.**
Agents get visibility into pending message queues plus a guard against queue-flooding on A2A
sends. **MCP-only surface changes** (§6.8 principle) — no new wire methods; the existing
`agent.getQueue` / `agent.removeQueuedMessage` wire RPCs (§5.5 table above) are unchanged
here (their shared-read / separate mutation semantics are documented on their rows).

- **`ws.agent.getQueue(agentId)` MCP binding** → `{ ok, agentId, queueLength, queue }` — any
  workspace agent's **full** pending queue (the same shared visibility as
  `agent.getQueue`, with the MCP presentation below) in
  **actual drain order** (position 0 = next delivery:
  interrupt-priority entries first in arrival order, then normal FIFO; entries under edit are
  flagged `editing: true` and sorted last, since the drain skips them). Each entry:
  `{ id, content, queuedAt, position, turnId?, interruptPriority?, editing?, fromAgentId?,
  fromAgentName? }` — sender attribution is **lifted to top level** from the entry's
  `agent_message` auto-tag (`messageMetadata.fromAgentId`/`fromAgentName`, §5.5
  `agent.sendMessage`) and is absent for user-sent entries. Note the MCP presentation differs
  cosmetically from the services-layer snapshot `agent.diagnostics` embeds (the guard
  refusal embeds this presented view, not the internal snapshot): both truncate `content`
  to 200 chars (with a `…` ellipsis) and drop the bulky `imageBlocks`/`fileBlocks`
  payloads, but the MCP view lifts attribution top-level while the internal snapshot
  leaves it inside `messageMetadata` — same entries, same order, different attribution
  placement.
- **Queue merged into `ws.agent.status`** — the target's pending queue rides the status
  result inline as `queue` + `queueLength` (same entry shape and drain-order sorting as
  `ws.agent.getQueue`, `content` truncated to 200 chars), so one status call shows both
  liveness and backlog.
- **`ws.agent.removeQueuedMessage(agentId, messageId)` MCP binding** — retract **your own**
  pending message before delivery. Ownership is the entry's `messageMetadata.fromAgentId`
  equalling the caller's agent id; entries from other senders or the user (no `fromAgentId`
  auto-tag = unowned) are rejected with a clear error. The underlying wire RPC keeps its
  caller-agnostic idempotent semantics — the ownership rule is enforced in the MCP binding
  layer, where a caller identity exists. Because `fromAgentId` is now security-relevant
  (guard + ownership), sender attribution on agent-origin sends is **daemon-stamped**: an
  explicit caller-supplied `messageMetadata` keeps its own fields, but the
  `fromAgentId`/`fromAgentName` fields are always overwritten with the real caller identity
  (omitting metadata cannot evade the guard; spoofing cannot misattribute or transfer
  removal rights). This supersedes the earlier "explicit metadata always wins" precedence
  for the attribution fields only — non-attribution fields still win.
- **Single-pending-message guard on `ws.agent.send` / `ws.agent.sendToTask`** — a second
  agent-origin send while the caller already has a pending entry on the target's queue is
  **refused** (agent-origin sends only: FE/user sends and internal wakes are unaffected;
  `priority: "interrupt"` is included — no bypass; `editing: true` entries don't count,
  the drain skips them). The refusal is a successful tool result with `ok: false` and —
  since [intentd#1439](https://github.com/intent-hq/intentd/pull/1439) — the unmissable
  `refused: true` discriminator (present only on guard refusals, so a naive sender can
  tell "refused, act on the instruction" apart from other `ok: false` shapes), echoing
  the target's presented queue (drain order, content truncated), the caller's pending
  entry id as `pendingMessageId`, and a remediation `instruction`: keep the existing
  entry as-is, or re-send ONE message combining everything with `replacePending: true`
  (below). Manual `ws.agent.removeQueuedMessage` + re-send still works but is **NOT
  atomic** — the pending entry is gone even if the re-send then fails — and either way a
  re-sent message lands at the END of the queue. Different senders may still
  each have one pending entry; the guard is per sender/target pair, and is advisory
  check-then-send hygiene (not an atomically enforced invariant — concurrent sends from
  one caller can race past it). *(Refusal shape clarified in
  [intentd#1440](https://github.com/intent-hq/intentd/pull/1440).)*
- **`replacePending` replace-and-send *([intentd#1445](https://github.com/intent-hq/intentd/pull/1445))*** —
  `replacePending: true` (options-object third argument on `ws.agent.send` /
  `ws.agent.sendToTask`) turns the guard refusal into a **lossless replace**: the NEW
  message is sent FIRST and the pending entry retracted after, so a failed send never
  discards the pending entry. The result reports the outcome: retraction success →
  `replaced: true` + `replacedMessageId` (the retracted entry's id); otherwise
  `replaced: false` + `replaceOutcome` — `"drained"` (the entry delivered between the
  guard check and the retraction — nothing left to retract), `"none"` (nothing to
  replace: the option was passed but the caller had no pending entry), `"reassigned"`
  (`sendToTask` only: the task's assignee changed mid-call, so the new message went to
  the new assignee while the pending entry was left untouched in the old assignee's
  queue), or `"error"` (the retraction failed for a reason other than draining — logged,
  never masquerading as a drained race). The new message is sent in every arm, so the
  caller never has to re-drive the sequence; an agent caller passing the option always
  gets a replace report (fall-through paths report `replaceOutcome: "none"` rather than
  silently ignoring it). The refusal `instruction` recommends `replacePending` as the
  atomic remediation over manual remove + re-send.
- **`delivery` outcome on send success *([intentd#1439](https://github.com/intent-hq/intentd/pull/1439))*** —
  every successful `ws.agent.send` / `ws.agent.sendToTask` result carries a top-level
  `delivery: "delivered" | "queued"` classification, so `ok: true` +
  silently-queued is unambiguous even to a sender that only glances at the result:
  `"queued"` = parked in the target's queue (busy target / non-interrupt
  send — but ALSO the indefinite parks `quarantined: true` and `archivedParked: true`,
  whose underlying flags stay in the result for callers that need the distinction);
  `"delivered"` = the message is driving a turn now — claimed only on a `turnId`-bearing
  result (plus the interrupt dedup replay, `deduplicated: true`, whose original delivery
  did run), so the store-only fallback's persist-only success (`queued: false`, no
  `turnId`) gets NO `delivery` claim rather than a false "delivered". Non-success shapes
  (guard refusals, sendToTask's "No agent assigned to task") carry no `delivery` field.
  The former third outcome `"held"` (a park behind the target's question hold, flagged
  `heldForQuestions: true`) was retired with the hold in v9.5
  ([intentd#1710](https://github.com/intent-hq/intentd/pull/1710); §5.5 "Pending
  questions") — a pending question set no longer gates delivery, so the union is
  two-valued.
  Like the guard itself, all three are **MCP-only surface changes** (§6.8 principle) —
  the wire `agent.sendMessage` / `agent.sendToTask` RPCs and their result shapes are
  unchanged.
- **Dequeue-wait annotation** — every drain path (worker drain arms, pre-release drain,
  `agent.sendQueuedMessageNow`) appends a deterministic system note to the delivered
  content — `[SYSTEM NOTE] This message was queued at <queuedAt> and waited <duration>
  before delivery.` — so the target knows the message's age (same placement contract as the
  #576 stale-redrive note; both may appear). Idempotent across requeues via the stable
  prefix (a terminal-failure requeue keeps its first-delivery numbers); `persisted: true`
  requeues are never rewritten (the delivered prompt stays byte-identical to the durable
  row); an unparseable `queuedAt` fails open (content untouched). Messages delivered
  immediately (never queued) are not annotated, and neither are entries whose wait fell
  below the **5-second annotation threshold** (monorepo#2353): a sub-threshold hop —
  e.g. a question-wizard answer converted into an enqueue + immediate drain by the #1791
  FIFO-restore branch — is treated like an immediate delivery (no note, no wait stamp —
  the `queueInfo` object itself still appears, carrying only the threshold-independent
  `queuedMessageId` identity link below and, for a multi-message batch flush, `batchId`),
  so instant queue hops never render a "waited 0s" chip. Alongside the content
  note, the drained entry's `messageMetadata` is stamped with structured queue info —
  `queueInfo: { "queuedMessageId": "<queue entry id>", "queuedAt": "<ISO enqueue timestamp>"?,
  "waitedMs": <non-negative millis>?, "batchId": "<opaque id>"? }`
  — persisted on the user transcript row and round-tripping on chat reads
  (`agent.getConversation` / `chat.subscribe`) like the A2A sender-attribution metadata, so
  clients can render the wait without parsing the note text. **`queuedMessageId`** (drain
  identity link, within v9.11 — [intent-hq/intentd#1783](https://github.com/intent-hq/intentd/pull/1783))
  is the `QueuedMessage.id` of the entry the row was drained from, stamped on EVERY
  queue-drained user row (all three drain arms — single, worker, batch — and
  `agent.sendQueuedMessageNow`) regardless of the wait threshold, and lifted onto the row's
  user-row `agent:message` echo as `queuedMessageId?` (§6.5). On the three queue-drain arms
  the row's own `id` is freshly minted — never the entry id — so there this stamp is the
  only link between the persisted row and the entry still listed in `agent:queue:updated`
  until the shrunk snapshot lands (§6.5 drain ordering contract); on both
  `agent.sendQueuedMessageNow` paths (runtime and store-only fallback) the row is persisted
  UNDER the entry id, so `row.id`, `queueInfo.queuedMessageId`, and the result `messageId`
  all coincide and the stamp is redundant-but-uniform. Either way a client that mirrors the
  queue can match `row.metadata.queueInfo.queuedMessageId == queueEntry.id` and drop its
  queued rendering the moment the row arrives, without special-casing the send-now path.
  Unlike the wait/batch stamps it is always (re)written to the
  entry delivering now (a requeue re-drained under a fresh entry id re-links to that id);
  `persisted: true` requeues are never stamped and rows persisted by older daemons lack it.
  `queueInfo` is daemon-reserved: a caller-supplied `messageMetadata.queueInfo` that is
  absent, `null`, or not an object is replaced by a fresh object carrying the link (an object
  is merged into), so every drained row names its entry — clients must not rely on a
  non-object `queueInfo` surviving the drain.
  Rows never queued (direct `agent.sendMessage` deliveries, wake deliveries,
  `agent.appendMessage`) carry no `queueInfo` at all. `batchId` is an **optional
  string**, present on every user row drained together in one multi-message batch flush
  ("Queued-message flush" below): all rows of one flush share the same value, so clients
  can group the stacked rows of a batch (each row's `queuedMessageId` still distinguishes
  them); it is absent on single-entry drains and on rows persisted by older daemons.
  Entries whose wait fell below the 5-second annotation threshold carry a `queueInfo`
  containing only `queuedMessageId` (plus `batchId` when part of a batch flush) — no
  `queuedAt`/`waitedMs`, no content note. Same guards as the note for the wait fields: an
  existing `queuedAt`/`waitedMs` pair is never overwritten (first-delivery numbers stay
  across requeues), `persisted: true` requeues are never stamped, and an unparseable
  `queuedAt` skips the wait stamp; negative waits (clock skew) sit below the threshold and
  skip the annotation entirely.
- **A2A sender header *(new in intentd, [intent-hq/intent#3721](https://github.com/intent-hq/intent/issues/3721))*** —
  agent-origin sends additionally render the sender attribution into the **model-visible
  content**: the send front doors prepend the single-line header `[MESSAGE FROM AGENT
  {fromAgentName} ({fromAgentId})]` (name-absent shape `[MESSAGE FROM AGENT
  ({fromAgentId})]`) plus a blank line above the caller's text, so the recipient model —
  not just FE chrome reading `messageMetadata` — knows who sent the message (parity with
  the `[WORKSPACE EVENTS]` wake notes, which already name their origin agent). The header
  is **daemon-owned and spoof-resistant**: it is rendered exclusively from the
  daemon-stamped `fromAgentId`/`fromAgentName` attribution fields (the `agent_message`
  auto-tag above — always overwritten with the real caller identity for agent callers),
  never from caller-supplied text, and the gate is that stamped `fromAgentId` — sends
  without it (the human FE/RPC `agent.sendMessage` front door, internal event wakes) stay
  **byte-identical**, and a body that self-claims a sender identity gains nothing. Two
  enforcement details make the gate hold: the user-origin RPC front doors
  (`agent.sendMessage`, `agent.sendToTask`, `agent.wakeOrCreate`) **strip** the reserved
  `fromAgentId`/`fromAgentName` fields from caller-supplied `messageMetadata` at the
  router ingress (a wire caller cannot forge an agent-origin send; all other metadata
  fields pass through untouched), and the rendered display name is **sanitized** —
  newlines/control characters collapse to single spaces (a name that sanitizes to empty
  renders the name-absent shape), so the header always stays single-line. Applied
  BEFORE persist/enqueue on every agent-origin path (direct sends, busy-queue and
  archived-workspace parks, the store-only fallback, `ws.agent.create` kickoffs and
  `ws.agent.wakeOrCreate` context wakes), so the persisted user row, chat reads, queue
  snapshots, and the delivered prompt all agree. **Idempotent across requeues and layered
  front doors** by **exact header match**: the annotation rebuilds the header this
  entry's stamped attribution would render and skips only when the content already
  starts with exactly that header + blank line, so a terminal-failure requeue, a parked
  entry drained later, or a batch flush never stacks a second header — byte-stable
  because the name is re-read from the same stamped metadata, never a live lookup (same
  contract as the dequeue-wait note). A caller-authored lookalike first line (any other
  `[MESSAGE FROM AGENT…` text) does NOT suppress annotation: the genuine header is
  prepended ABOVE it, so a spoof visibly sits below the real attribution.
  `messageMetadata` is **never modified** by the annotation — the
  attribution fields keep driving the single-pending-message guard,
  `ws.agent.removeQueuedMessage` ownership, and the question-answer intake exactly as
  before, and they remain the authoritative attribution for clients (the header is a
  prompt-visibility rendering of the same stamped fields, not a new source of truth).
- **`agent.diagnostics` queues fill** — the per-agent `queues` snapshots are now real
  (previously hardcoded `[]`), using the same drain-order sorting.

**Interrupt-by-default A2A sends *(behavior only, within v7.0, [intentd#1292](https://github.com/intent-hq/intentd/pull/1292))*.**
The `ws.agent.send` / `ws.agent.sendToTask` MCP bindings now deliver with **interrupt priority
by default**: an omitted (or `null`) `priority` resolves to `"interrupt"` at the binding layer,
the explicit `priority: "queue"` opt-out restores queue-if-busy delivery by mapping to
`"normal"` (any non-`"interrupt"` value is non-interrupt at the service layer), and every other
explicit value passes through unchanged. **MCP-only surface change** (§6.8 principle — no wire
change): the `agent.sendMessage` / `agent.sendToTask` RPC defaults for an omitted `priority`
(the FE front door, internal wakes, automated deliveries) remain queue-if-busy. Every existing
interrupt constraint applies to these default-interrupt sends unchanged: the
single-pending-message guard above (interrupt included — no bypass), the archived-workspace
park (§5.1 — an automatic interrupt-priority send into an archived workspace parks
front-of-queue with `interruptPriority: true`), and the turn-startup fallback (an interrupt
landing while the target's turn is starting queues keep-alive instead of preempting —
`agent.sendMessage` row above). The question hold that formerly parked automatic interrupts
behind a pending Q&A was retired in v9.5 ("Pending questions" below).

#### Submission correlation and optimistic display (prepared additive extension)

**Support gate.** `client.hello.server.capabilities.submissionCorrelation: 1`
advertises this complete contract, including every human send/queue ingress,
mutation reply, resolved queue snapshot, processing snapshot and transcript
persist/echo path described here (runtime and store-only paths alike). Enable
queue optimism only for the exact integer `1`; absent, null, malformed, `true`
and unknown future versions mean unsupported. Public protocol **13.4** is allocated
to this additive extension; numeric protocol version alone never enables this
feature or the independently prepared Home 13.2 and GitLab 13.3 additions. See
[version allocation](../versioning.md#protocol-version--compatibility).
These docs do not claim a carrying release.
No method/event names, queue scheduling rules or mutation permissions change.

**Wire additions.** Optional fields preserve old payloads. Under the capability,
new human submissions carry the correlation fields on all applicable surfaces;
legacy rows lacking trustworthy data may omit them and must remain recognizable
as uncorrelated. A partial implementation must not advertise the capability.

| Surface | Additive field | Meaning |
|---|---|---|
| `agent.queueMessage` params | `messageId?: string` | Caller-generated, nonempty opaque submission ID, like `agent.sendMessage.messageId`; omission keeps server allocation. Invalid supplied values return `-32602` before mutation. |
| `QueuedMessage` | `submissionIds?: string[]` | For an ordinary single-source row, the complete, nonempty set of nonempty opaque strings: its canonical ID and absorbed submission aliases, without duplicates. Omitted on a combined recovery row; use `recoverySources` below. Array order has no meaning. Reuse internal `submission_ids()` / `merged_submission_ids`; do not derive IDs from text or metadata. |
| Combined recovery `QueuedMessage`, deduplicated `agent.sendMessage` result, persisted row `metadata`, and `agent:message.data` | `recoverySources?: RecoverySource[]` | Nonempty flat list of original sources, each retaining its own aliases, trusted author and lifecycle origin; mutually exclusive with top-level `submissionIds`. See normalization below. |
| `QueuedMessage` in `agent.getQueue` and `agent:queue:updated.data.queue` | `mergeEligible?: boolean` | Daemon-computed eligibility for a future submission by this row's trusted author. At most one row is true in a coherent full snapshot; false is explicit, omission means unknown. |
| `agent.sendMessage` success result | `submissionIds?: string[]` | Direct delivery: singleton submitted/server-allocated message ID. Ordinary queued fallback: complete surviving entry alias set, including the submitted ID, even when result `messageId` names an older survivor. A combined recovery acknowledgement uses `recoverySources` instead. Existing `queued`, `messageId`, `turnId` and result arms remain unchanged. |
| Persisted human transcript row `metadata` | `submissionIds?: string[]` | Direct delivery: singleton ID. Ordinary queue delivery: complete consumed entry alias set, captured before removal; each batch row keeps its own set. Combined recovery uses `recoverySources` instead. Round-trips on `agent.getConversation`, `agent.getSession` and `chat.subscribe` reads. |
| Human `agent:message.data` | `submissionIds?: string[]` | Same alias set as the persisted row, alongside existing `messageId`, `appMessageId?`, `queuedMessageId?`, `turnId?` and resolved author. |

`QueuedMessage.submissionIds` applies uniformly to the existing `queuedMessage`
mutation results (enqueue/edit), full queue reads/updates and every consumed row
in `agent:queue:processing.data.queuedMessages`. No top-level processing alias
union is introduced: a batch can have different authors. Processing snapshots
carry `mergeEligible: false`; they are not live merge targets. Mutation replies
may omit `mergeEligible` and keep the existing raw `author: null` projection;
clients never replace a resolved author or a full snapshot's eligibility using
these partial replies. Do not add arrival timestamps, a second alias registry,
or a public submission-order counter. `userAppMessageId` / `appMessageId` retain
their existing single-row behavior; the new alias set correlates *all* absorbed
submissions and does not replace that compatibility field.

**Trusted scope.** Generate a fresh high-entropy ID once per accepted local
submission, before uploads, session preparation or RPC dispatch, and retain it
across a direct-send-to-queue fallback. Two identical texts or attachment lists
are separate submissions with different IDs. Match evidence within the same
daemon authority, workspace, agent and authenticated principal; principal
identity is the daemon-resolved `author.principalId`, never a display name,
forge identity, `clientId`, metadata label or caller-supplied author. A reply can
correlate its own request using that captured authenticated scope despite raw
`author: null`; shared events/reads require a matching non-null trusted principal.
Identity changes clear the old scope's optimistic projection.

Caller-supplied `messageMetadata.submissionIds` and `messageMetadata.recoverySources`
(also inside `mergedMessageMetadata`) cannot create correlation: strip both on
human and automatic ingress and stamp only daemon-owned data on persistence.
Top-level caller copies are never used as authority either. Automatic/agent input
cannot acquire human correlation or merge authority by supplying these fields. Preserve unknown and
imported historical humans as barriers with `mergeEligible: false`, never infer
the current principal from null authorship. A supplied ID already owned by a
*different* principal in the pending/draining alias registry returns `-32602`
without appending, returning a deduplicated success, or changing that entry.
Same-principal replay against a retained pending/draining alias returns the
survivor without a second append or fresh human-arrival time. For a combined
recovery row, check the matching source principal rather than the head author;
the reply uses `recoverySources` instead of a flat `submissionIds` on any surface
that returns this row or its correlation (including a deduplicated send result).
This acknowledgement grants no right to mutate or send the combined entry.
This scoped pending replay protection does not promise deduplication after delivery/removal.

**Combined failure recovery.** Keep the existing ordinary failed-flush policy:
one combined retry entry, with the head entry's execution/mutation authority,
combined prompt, attachments and original turn identity. Do not split execution
or grant another source's author edit/remove/send rights. The new correlation
field is presentation evidence only, not an ACL or a replacement for the entry's
existing metadata/origin. Context-size and partial-persist failures retain their
existing individual-entry restoration behavior.

```typescript
type RecoverySource = {
  messageId: string;             // original source entry ID, not retry wrapper ID
  submissionIds?: string[];      // complete aliases; absent for unknown legacy data
  author: MessageAuthor | null;  // existing trusted author projection for THIS source
  origin: "user" | "automatic"; // stored MessageOrigin / user_origin, not a metadata label
};
```

Build `recoverySources` from the consumed `flushed_entries` before discarding
individual entries. An ordinary source contributes its canonical ID, complete
aliases, trusted author snapshot and stored lifecycle origin. `author: null`
means genuine nonhuman input; unknown/imported humans keep the existing author
object with null principal, never the retry head's principal. Authorship and
origin are independent: a trusted human-authored wake can have
`origin: "automatic"`. The origin values mirror existing `MessageOrigin::User/Automatic`
and do not change wake/archive or access rules. Source author projections retain
their captured principal/snapshot even in raw mutation replies whose outer
`author` is null. Imported provenance follows the existing unbound historical
human rules for each source, never importing a foreign principal as current.

Normalize in source delivery order. If an entry already has `recoverySources`,
flatten those original leaves instead of wrapping them or adding the retry
entry ID as a new submission. Preserve distinct leaves even for the same author.
Repeated occurrences of the same original `messageId`, trusted principal/unknown
human identity and origin coalesce at their first position with the union of
known aliases; duplicates never grow on each failure. If any occurrence has an
unknown alias set, the result stays uncorrelated (omit its `submissionIds`). Never
combine different principals/origins, restamp sources to the head, or recover
identity from text. The aliases are those captured by the source, not the new
retry entry's ID. No nested recovery list, source content copy or per-attempt
wrapper history is retained. If legacy data cannot establish provenance, retain
an uncorrelated legacy source rather than claiming complete matching.

Persist the normalized leaves with the retry's existing durable queue payload;
thread them through turn options, restart, redrive, subsequent batching, failure
and processing snapshots. Internal requeue copies these captured leaves; it does
not reconstruct them from caller metadata. Repeated ordinary failure may allocate a new retry
entry ID but preserves the same leaves. A successful redrive of an already
persisted entry creates no duplicate transcript row. If existing recovery policy
requires a new transcript row (for example a context-size recovery marker), stamp
its `metadata.recoverySources` and echo `data.recoverySources`, omitting inherited
head `submissionIds`. All ordinary queue/read/reply/processing projections of the
combined entry expose that same normalized field and omit top-level
`submissionIds`; never flatten A/B/automatic aliases under A's author. Original
per-source transcript rows and aliases remain unchanged. This retention is tied
to owning queue/transcript rows, not a separate global ledger. Match a human
pending submission against a recovery leaf only via that leaf's non-null trusted
`author.principalId` and the surrounding daemon/workspace/agent scope. Recovery
metadata is never client-authored and never changes queue permissions.

**Merge eligibility.** Full `agent.getQueue` / `agent:queue:updated` snapshots
include draining overlays first, then live entries, as today. Deduplicate an
overlay already represented by a restored/coalesced live row using the existing
canonical/absorbed-ID or turn-ID rule; the live row wins. Compute the snapshot and
flags under the same draining-then-live queue synchronization used for selection.
Every overlay row has `mergeEligible: false`, even when its provisional flag has
settled but its guard has not yet been dropped. Select candidates ONLY from LIVE
human entries by internal `submission_order`, skipping genuine nonhuman entries,
not humans carrying custom/system-looking metadata. Only that live human can be
true: it must have a trusted current principal, not be imported/unbound, and not
already be persisted to the transcript. A later provisional human in the draining
registry blocks it; a settled draining row does not. Combined persisted retries
are not merge targets. Unknown/incomplete legacy ordering is conservative: mark
false until eligibility is established. This reuses `can_merge_pending()` and
the existing provisional-barrier rule. An editing hold alone does **not** prevent
append; existing draft/prefix/suffix protection still applies.

Recompute flags after enqueue/append, pop, restore/coalesce, edit and removal,
including when a provisional barrier settles without changing visible text.
A renderer may provisionally append only to a true row whose resolved principal
matches its submitting principal, using the existing two-newline separator and
ordered attachment concatenation. Keep every pending contribution separately;
never mutate confirmed content to achieve the visual merge. A newer foreign
human may split that projection on confirmation. Queue position, original
`queuedAt`, alias-array order and text equality are never arrival evidence.
A flag predicts eligibility at its snapshot instant; it reserves no queue slot.

**Evidence and races.** A submission has one provisional location across chat
and queue. Initial intent is not the final destination. Apply correlated queue
acceptance and removal of the conversation placeholder together; rebuild the
queue from confirmed entries plus still-unconfirmed contributions. The following
precedence is per submission, not a global ordering of unrelated turns:

| Evidence order | Required display result |
|---|---|
| Queue event containing alias, then enqueue/send reply | One canonical queue contribution; reply acknowledges but does not append again or overwrite a newer snapshot. |
| Reply, then queue event containing alias | Replace provisional content with the canonical aggregate; never duplicate its absorbed contributions. |
| Conversation placeholder, then `queued: true` or matching queue event | Move the same submission to queue, honoring the confirmed survivor and author; later evidence can split a provisional same-author merge. |
| Processing snapshot, then late enqueue reply | Retain the consumed snapshot/aliases; do not recreate an ordinary queued entry from that reply. Processing is an attempt, not proof of transcript persistence or provider success. |
| Persisted transcript echo/read, then late enqueue reply or known-stale read | Keep history; suppress duplicate optimistic content and stale mutation seeds. Do not delete confirmed queue entries just because their aliases occur in history. |
| Processing, failed persistence, authoritative restoration | Restore the actual queued entry and its aliases; processing alone must not suppress that recovery. |
| Persisted transcript row, then a current full queue containing that source | Preserve BOTH history and confirmed queue/retry state, even for the same entry ID with no `requeuedAfterFailure` marker. Remove only the duplicate optimistic contribution. |
| Mixed-author batch persisted, then ordinary failure | Retain every original history row plus ONE combined retry entry with per-source `recoverySources`; a late original ACK cannot replace that entry. |
| Transport timeout/disconnect, then matching queue or transcript evidence | Mark delivery uncertain until evidence arrives; reconcile by scoped aliases without resending. |

**Observable recovery and freshness.** Keep confirmed transcript rows, confirmed
queue entries/controls and local optimistic contributions as separate state.
Correlation removes only the last of these; it does not prove that confirmed
queue work is obsolete. A `requeuedAfterFailure: true` row positively describes a
retry, but absence is not proof against restoration: partial flush persistence
can restore an already-persisted head under its original ID, with no retry flag,
while a tail remains unpersisted. Both rows must remain queued. A full queue can
also contain an overlay whose history row just persisted; the existing later
queue shrink retires that overlay, not alias-based deletion by the renderer.

There is no new restoration event, queue revision or public live/overlay bit.
Use actual `agent:queue:updated`, `agent:queue:processing`, `agent:message`, existing
turn failure/end/status signals, and `agent.getQueue` / history reads. A lifecycle
failure alone neither invents a retry row nor proves restoration complete. After
processing/persistence, a queue update that might be an old overlay or a restored
same-ID row triggers a fresh queue read; preserve the last confirmed queue while
resolving that ambiguity and disable unsafe controls/speculative merges. Capture
a local observation generation when issuing each read after the triggering event;
if a relevant queue/processing/history/lifecycle event arrives while that read is
outstanding, do not let its result replace newer observed state: repeat the read.
A full read issued after those observations, with no intervening invalidation,
establishes current queue membership at the read instant, including overlapping
history and any remaining overlays. Keep every returned row. If an attempt is
still active or live-versus-overlay remains unknown, retain its processing/checking
presentation and gate unsafe controls until lifecycle settlement/current refresh;
`mergeEligible: false` does not itself distinguish an overlay from live retry work.
This is local request fencing, not a claim of global snapshot/event ordering.

Delayed mutation replies only acknowledge their original submissions once queue,
processing or history evidence has been seen; they cannot seed or replace the
confirmed queue. Old read responses whose requests preceded these observations
are similarly fenced. Event timestamps/IDs are not revisions. Ambiguous event
arrival order requires refresh, not erasing a row with known history. Queue
absence alone is not delivery proof: removal, pop and failed persistence also
cause absence. Never use an empty snapshot to declare an uncertain send rejected.
After reconnect, get current queue AND history before speculative merging; those
reads may legitimately contain the same source IDs. Persist-before-queue-shrink
ordering remains unchanged; processing precedes persistence on ordinary drain
and follows it on send-now. No globally exactly-once delivery guarantee is added.

**Failure and retention.** A proven pre-acceptance rejection or local preparation
failure affects only its pending submission and preserves earlier confirmed
content and newer drafts. A timeout, lost acknowledgement, disconnect or
unclassified server error is uncertain delivery, not success or proven rejection.
Keep its recoverable content visible; do not automatically resend, even with the
same ID. Explicit retry after proven rejection starts a fresh submission ID.
For uncertain delivery, first reconcile; if the user explicitly chooses to resend
without confirmation, warn of possible duplicate delivery and use a fresh ID.
Queue edit/remove/send-now controls must wait or operate on a confirmed snapshot
that includes every affected contribution; they must not discard unconfirmed text.

Pending daemon alias sets live only with their owning queued/draining entries
and their existing durable queue payloads. Preserve the complete set through
append, handback/coalescing, persistence, restart and failure requeue (using
per-source recovery leaves for combined retries); never trim live aliases and
then advertise complete correlation. Delivered sets live on ordinary transcript rows under existing transcript retention, not in a new
permanent deduplication ledger. Older delivered/requeued rows may remain
uncorrelated; do not fabricate historical aliases. The renderer keeps terminal
correlation tombstones for at most 10 minutes and at most 1024 submissions per
agent/scope, evicting oldest first; protect unresolved RPC callbacks separately
with their original operation identity so eviction cannot let an old reply
create a new optimistic entry. Bound unsettled local submissions with admission
backpressure (preserve the unsent draft when full), never silent eviction or
automatic retry. No durable frontend outbox or global exactly-once guarantee is
introduced. On retention loss/reload, refresh authoritative data and leave
unproven delivery uncertain rather than claiming successful deduplication.

**Legacy fallback and verification.** On unsupported daemons retain confirmed
queue rendering and existing direct-send optimism; never infer this contract
from an ignored request field, an isolated alias array or a numeric version.
On a supporting daemon, an uncorrelated legacy row renders normally but cannot
absorb an optimistic contribution. Synthetic examples and invariant checks live
in `docs/protocol/fixtures/submission-correlation/` and run in `make consumer-checks`.
They specify wire/display expectations, not runtime acceptance: component tests
must exercise actual locking, trusted identity, persistence, restart, batches,
send-now/store-only paths and delayed response/event permutations before the
capability is advertised. Docs land first, then daemon, then dependent frontend,
with separate human authorization for each merge.

#### Per-turn agent state snapshot *(new in intentd, [intentd#971](https://github.com/intent-hq/intentd/pull/971))*

Outbound turn prompts are prefixed with a compact, machine-readable digest of the agent's own
runtime state — unless the toggle is off, the digest is trivial, or building it failed (all
three skip cases below) — and the same digest is callable on demand. **MCP-only surface** (§6.8
principle) — there is **no wire method**: the FE neither reads nor renders snapshots, and none
are persisted.

- **`ws.agent.snapshot()` MCP binding** → the CALLER's own digest as a plain JSON object (no
  target argument — always self-scoped; an invocation without an agent caller context is
  rejected). Fields: `time` (current UTC, whole-second RFC-3339 — **always present**),
  `hooks` (active `scheduled`/`running` background hooks owned by the caller, §5.40),
  `agentWatches` (the caller's active outgoing completion watches, §Completion-watch
  persistence), `queuedMessages` (pending entries in the caller's OWN delivery queue),
  `eventSubscriptions` (the caller's active workspace event subscriptions, §5.5
  `agent.subscribe`), `activeSubAgents` (delegated children executing a live runtime turn),
  `unsettledSubAgents` (all nonterminal delegated children, including idle/background waiters),
  and legacy `runningSubAgents` (children whose persisted status is `pending`, `active`,
  `Processing`, or `Waiting`). `runningSubAgents` preserves the existing fresh-main persisted
  in-flight status meaning; it is **not** an alias of `unsettledSubAgents`. All three child
  counts are over the caller's `parent_agent_id` children without workspace scoping, so a chief
  parent's cross-workspace delegates count too. Other fields are `numQuestionsAsked`
  (structured questions still pending presentation/answer, §5.5 "Pending questions"),
  `prMonitors` (the caller's active PR monitors as labels — see below),
  `prs` (the workspace's tracked open PRs grouped by state — see below),
  `tasks` (the workspace's task-note counts per non-terminal status — see below), and
  `pendingAttention`
  (`"blocker"` / `"discussion"` when the caller has an unresolved attention request, §5.5
  attention-request flow). Every field except `time` is **omitted when zero/absent** (never
  `0`, never `null`). A workspace mismatch on the resolved session fails closed as
  `NotFound` (defense-in-depth against bare-id probes, like `getSessionStats`). The cheap
  counterpart to `ws.agent.diagnostics`, which is unchanged and remains the deep-dive tool.
- **`prMonitors` — the caller's active PR monitors** — a list of `"<owner>/<name>#<number>"`
  labels, one per ACTIVE monitor the caller owns (§5.42 centralized PR monitoring), each
  suffixed `" (changes pending)"` while a debounced emit is accumulating (the monitor holds
  observed changes not yet delivered as a wake). Distinct from `prs` below: `prs` covers the
  WORKSPACE's tracked open PRs grouped by state, `prMonitors` THIS AGENT's registered
  monitors. Best-effort — a monitor store read failure reads as empty rather than failing
  the snapshot build — and omitted when the caller monitors nothing, so a non-empty
  `prMonitors` alone makes an otherwise-trivial snapshot non-trivial and forces the
  per-turn injection line below.
- **`prs` — tracked open PRs grouped by state** — `prs?: { draft?, blocked?, mergeable?,
  unknown? }`, each group a list of `"<owner>/<name>#<number>"` labels (the same base label
  shape as `prMonitors` above, though `prs` labels never carry the pending-changes
  suffix). Sourced from **known git roots only** — persisted columns, no forge
  calls, no per-PR statements (RPC cost contract): the workspace row's discovered
  `pullRequests` under its `repositoryOwner`/`repositoryName`, plus each registered git
  root's `pullRequests` under its `repoOwner`/`repoName` (a root without repo identity is
  skipped — no label can be formed). Merged/closed PRs are excluded entirely; each open PR
  lands in exactly one group by precedence `draft` > `blocked` > `mergeable` > `unknown`
  (draft when `isDraft` or status `Draft`; blocked on a `blocked`/`dirty`/`behind`
  `mergeableState` or `mergeable: false`; mergeable on a `clean`/`unstable`/`has_hooks`
  `mergeableState` or `mergeable: true`; otherwise unknown). PRs are deduped by
  `(owner, name, number)` with the workspace pool taking priority over a git-root duplicate.
  Empty groups are omitted, and the whole field is omitted when no open PR survives — so a
  non-empty `prs` alone makes an otherwise-trivial snapshot non-trivial and forces the
  per-turn injection line below.
- **`tasks` — workspace task-note counts per status** — `tasks?: { [status]: count }`, an
  object keyed by the wire `snake_case` task status string (`not_started`, `waiting`,
  `discussion_needed`, `blocked`, `in_progress`, `review_required`) mapping to the number of
  task notes in that status, e.g. `{"in_progress":2,"review_required":1}`. Scope is
  **every task note in the caller's workspace** (any parent, archived included — the same
  workspace-wide population as `task.list`'s `tasks` membership, NOT the spec-linked set
  behind the §5.1 `taskStats` card aggregate), not only the caller's own or spec-linked
  tasks. The terminal statuses `complete` and `cancelled` are **never listed**,
  statuses with a zero count are never listed, and the whole field is omitted when nothing
  qualifies — so a non-empty `tasks` alone makes an otherwise-trivial snapshot non-trivial
  and forces the per-turn injection line below. Backed by exactly one aggregate statement
  over the task-status column (no note bodies are read — RPC cost contract) and
  best-effort: a store failure reads as empty (field omitted) rather than failing the
  snapshot build.
- **Per-turn injection** — when not skipped, `build_turn_prompt` prefixes the outbound prompt
  with the single line `current ws.agent.snapshot() => {json}` (the same JSON object,
  serialized on one line), followed by a blank line. It is the outermost **recurring** per-turn
  decoration — ahead of the context block, naming, and the specialist role reminder, and inside
  only the fire-once first-turn `<system>` prepend — is rebuilt every turn for **all** agents
  (specialist and non-specialist, unlike the role reminder), and is **never persisted**: the
  transcript's user row keeps the undecorated content.
- **Skipped when trivial** — when every field other than `time` would be omitted (all counts
  zero, no active PR monitors, no tracked open PRs, no non-terminal task notes, no pending
  attention) the whole line is dropped, so `time` alone never forces an injection and an
  idle agent's prompt stays byte-identical to pre-feature output. Building the snapshot
  **fails open**: a store error yields no line rather than failing the turn (and
  `prMonitors` / `prs` / `tasks` are themselves best-effort — a monitor store read failure
  reads `prMonitors` as empty, a workspace or git-root lookup failure skips that `prs`
  pool, and a task-count aggregate failure reads `tasks` as empty, rather than failing the
  build).
- **Toggle** — the injection (and only the injection) is gated by
  `agentFeatures.stateSnapshot` (§5.12), resolved from the session's **captured harness
  feature snapshot** like every other toggle
  ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)): flipping the setting
  applies to **new sessions only**, and a legacy pre-snapshot row (NULL in the store)
  follows the live setting until its first-activation freeze (see "Harness versioning"
  above). The
  `ws.agent.snapshot()` tool itself is **never** gated and stays callable either way.

#### Queued-message flush — combined turn on idle

When an agent goes idle with **more than one** ready-to-send queued entry, the queue drain
batches eligible entries into ONE combined provider turn in queue order. Batching is always
on; the retired `agents.flushQueuedMessages` preference no longer controls delivery
(§5.12). A single ready entry uses the existing single-entry drain path.

Script-monitor wakes retain their individual admission and lifecycle fence. When a ready
script-monitor wake is present, the automatic drain uses the single-entry path rather than
combining it with other work. Explicit `agent.sendQueuedMessagesNow` rejects a selection
containing such an entry, as documented in the method contract above.

- **Wire-only combined prompt.** The model receives ONE message beginning with the header
  `N queued messages while you were working`, followed by each entry under a `Message #k:`
  label in delivery order. Entry contents already carry their per-entry annotations — the
  dequeue-wait note (original `queuedAt` + wait duration; only for waits at/above the
  5-second threshold, monorepo#2353) and, where applicable, the #576 stale-redrive note —
  applied per entry in the same order as the single-entry drain arms.
  The combined prompt exists **only on the wire**: it is never persisted as a transcript row.
- **Per-entry transcript rows.** Each flushed entry persists as its own user message row (own
  id, own `messageMetadata` — including the `queueInfo` stamp: the shared `batchId` on every
  row of the flush, each row's own `queuedMessageId` identity link, plus `queuedAt`/`waitedMs`
  when the entry's wait met the 5-second threshold above), so the transcript and UI show
  the same N messages as individual stacked user rows — identical to what a one-at-a-time
  drain would have persisted. Entries already persisted by a terminal-failure requeue
  (`persisted: true`) are not re-appended.
- **Events.** A flush emits ONE `agent:queue:processing` for the HEAD entry — the combined
  turn's drain-start signal — then each row persist emits its normal `agent:message` echo,
  then ONE `agent:queue:updated` (the fully-shrunk queue snapshot) once every row is
  persisted (§6.5 drain ordering contract), so clients render N stacked user rows before the
  entries leave the mirrored queue.
- **Turn correlation (monorepo#1022).** The combined turn runs under the HEAD entry's
  `turnId`, and ALL flushed rows persist — and their `agent:message` echoes are stamped —
  under that same combined `turnId` (not each entry's own), so all N echoes correlate with
  the single `agent:queue:processing` / `agent:stream:*` lifecycle. The queue entries
  themselves keep their own `turnId`s and ids; the only metadata mutation beyond the
  single-drain annotations is the shared `queueInfo.batchId` grouping stamp on every entry
  of the batch. The merged turn options carry attachments and prepend payloads from all entries
  in message order, the head entry's `queuedAt` / `interruptPriority` / `messageMetadata`,
  and a user origin when ANY flushed entry is user-origin (a user message is being
  delivered); the turn-begin report clear is suppressed only when EVERY entry is a #576
  stale redrive.
- **Editing-entry exclusion.** Entries flagged `editing: true` are never flushed and remain
  queued (same rule as the single-entry drain).
- **Pending questions.** A pending structured-question set (below) does NOT gate the flush
  (v9.5, [intentd#1710](https://github.com/intent-hq/intentd/pull/1710)): ready entries of
  any origin drain and batch under the ordinary eligibility rules while the marker is set. The
  pre-9.5 hold rule — flush only on a ready user-origin entry, parked automatic entries
  riding the user-led combined turn FIFO ([monorepo#1791](https://github.com/intent-hq/monorepo/issues/1791),
  [intentd#1059](https://github.com/intent-hq/intentd/pull/1059)) — survives only in its
  archived-workspace form below.
- **Archived workspace.** The §5.1 archived gate is the one origin-aware drain gate
  ([intent-hq/intentd#1587](https://github.com/intent-hq/intentd/pull/1587); fixes
  intent-hq/intent#3883): while the workspace is archived the drain proceeds only when a
  ready **user-origin** entry carries a trusted human submission at or after the
  archive. Compare its durable latest-human-submission time with `archivedAt`,
  falling back to original `queuedAt` when the optional timestamp is absent
  ([archive wake eligibility](#shared-pending-human-queue), above). A fresh human
  append qualifies even when the survivor's original `queuedAt` predates archival.
  A user send made INTO the archived workspace is the explicit resurrection signal;
  a pre-archive entry with no new human submission does not qualify, and without a
  qualifying entry everything stays parked (no regression on the intentd#1293 archive/auto-unarchive
  loop fix). The flush then carries eligible ready entries — parked
  consolidated `workspace_archive_wake` notice for cancelled hooks / PR monitors
  included (§5.1 archive active-work teardown) — FIFO in the user-led combined turn, whose claim
  performs the §5.1 auto-unarchive at the turn-start choke point, so an older parked wake
  is never bypassed by a newer user message; the batch and single-entry dequeues require
  user-origin under this exemption. Script-monitor wake isolation still applies.
- **Never-lost requeue.** If an entry's row append exhausts the bounded persist retry
  (#547), the agent parks in `Error` and the drained entries are requeued in their original
  order — the failed entry at the queue front of its slice with `persisted: false`, entries
  whose rows already reached the transcript carrying `persisted: true` so the retry drain
  never double-appends (STAB-51) — and the fully-restored queue is republished as
  `agent:queue:updated`. Queued messages are never dropped.

#### Pending questions — the persisted question marker *(v2.8, [intentd#751](https://github.com/intent-hq/intentd/pull/751); delivery hold retired in v9.5, [intentd#1710](https://github.com/intent-hq/intentd/pull/1710))*

When an agent ends a turn by asking structured questions (§7 — the final assistant message
carries trailing `application/vnd.intent.question+json` resource blocks), the daemon records the
question set as **pending** on the session until the user answers it, dismisses it, or a newer
question-bearing turn supersedes it. Pendingness is a persisted **marker**, not a delivery gate:
it drives the workspace's `needs_attention` derivation (§5.1 step 2), the `numQuestionsAsked`
per-turn snapshot field, the `ws.agent.watch` idle-target acceptance, and the FE composer wizard
(which stays sticky on `pendingQuestionsMessageId`), and it **never** parks or delays a delivery.
Since [intentd#965](https://github.com/intent-hq/intentd/pull/965) (within v6.0) pendingness is
**persisted**, not re-derived from the transcript tail — see the derivation below. Since
[intentd#1063](https://github.com/intent-hq/intentd/pull/1063) (within v6.4)
`ws.app.question.ask` is **top-level-only** (§7), so a **new** pending set can only arise on an
agent whose MCP bridge was created top-level — per the §7 spawn-time snapshot semantics, an agent
flipped to background via `agent.update` after bridge creation keeps its question-enabled bridge
(and can still arm the marker) until it respawns; a marker persisted by a pre-gate sub-agent turn
stays pending until resolved as below.

*History — the retired question hold (v2.8 → v9.4).* From v2.8 ([intentd#751](https://github.com/intent-hq/intentd/pull/751))
through v9.4 the marker ALSO gated delivery: while questions were pending, every **automatic**
delivery (A2A sends, `agent.sendToTask`, parent/subscription wakes, `agent.wakeOrCreate` context
messages, interrupt-priority sends included) parked in the agent's queue with the additive
`heldForQuestions: true` result flag (the MCP `delivery: "held"` outcome), the queue drain skipped
automatic entries, and a user-origin send to an agent with a parked backlog converted to a
queued entry so the backlog flushed FIFO in the combined turn ([monorepo#1791](https://github.com/intent-hq/monorepo/issues/1791),
[intentd#1059](https://github.com/intent-hq/intentd/pull/1059)). **v9.5 retires the hold
outright** ([intentd#1710](https://github.com/intent-hq/intentd/pull/1710)): automatic
deliveries — the queue drain included — proceed while the marker is set (an idle asking agent
starts the turn immediately; a busy one queues under the ordinary busy rule), `heldForQuestions`
is never produced and is **removed from the wire**, the `"held"` MCP delivery outcome is gone
(`ws.agent.send` / `ws.agent.sendToTask` report `"delivered"` or `"queued"` only), and the
monorepo#1791 pending-questions conversion is gone with it (its archived-workspace sibling,
[intentd#1587](https://github.com/intent-hq/intentd/pull/1587), stands — see the "Archived
workspace" flush bullet above). The archived-workspace park is now the only origin-aware
delivery gate. The marker survives such a delivery and the agent's reply to it: only the
resolution paths below clear it.

**Derivation (persisted marker; within v6.0, [intentd#965](https://github.com/intent-hq/intentd/pull/965)).**
Questions are pending iff the session's persisted `pendingQuestionsMessageId` marker is set AND
differs from the `dismissedQuestionsMessageId` marker. The marker is written at turn end whenever
the just-persisted assistant tail carries `application/vnd.intent.question+json` resource blocks
(single slot — a newer question-bearing turn overwrites an older marker, which is the "newest set
supersedes" rule), and written as the **empty string** to clear (authoritative "nothing pending",
and still marker-aware). So pendingness **survives** later plain user messages, automatic
deliveries, the agent's subsequent turns, and daemon restarts — the check is a bounded single-row
metadata read, not a transcript walk. There is no pending flag or lifecycle status: an agent with
pending questions remains `idle`/`completed` as usual. The derivation fails open (`false`) on
store read errors so a transient failure can never fabricate attention. Like
`dismissedQuestionsMessageId` / `lastSeenMessageId` the marker IS lifted into the structured
`AgentLite` `metadata` projection (`agent.list` / `agent.get`) as
`metadata.pendingQuestionsMessageId?` since
[intentd#1350](https://github.com/intent-hq/intentd/pull/1350), which superseded the original
daemon-internal contract (the marker previously rode only the raw free-form `metadata` object
`agent.getSession` serves — it still does, like every session-metadata key, whether set or
cleared to the empty string). Presence rule: the field is present whenever the marker was ever
written — a non-empty message id means that message's questions are pending, the empty string
is the authoritative "nothing pending" clear — and omitted only for legacy sessions the daemon
never marker-wrote (the same rule the `agent.dismissQuestions` `agent:updated` event field
follows, so events and reads agree). Clients may re-derive pendingness from the lifted marker
exactly as the daemon does (set AND ≠ `dismissedQuestionsMessageId`); when the field is
omitted (legacy) they fall back to the transcript plus the answer tag below, and the daemon's
own verdict is always readable through `displayStatus` (§5.1 step 2).

Frontends must test field presence, not truthiness: render only the question set named by a
present non-empty marker (unless dismissed), and treat a present empty string as authoritative
"nothing pending" without re-deriving a set from the transcript. Transcript-tail derivation is
only a fallback for an absent field.

*Pre-upgrade fallback.* A session whose marker key is **absent entirely** (the daemon never wrote
it) falls back once to the legacy transcript tail walk — walking back past any trailing `system`
rows, pending when the first non-system row is an un-dismissed question-bearing assistant message
— and the derived pending set is immediately **materialized** as a marker, so a set that was live
across the upgrade is not lost on the next plain user row. A marker written as the empty string
does NOT fall back.

*Client compatibility.* A new frontend connected to an old daemon that does not project the
marker sees the field as absent and uses that same non-system transcript-tail rule. An old
frontend connected to a new daemon remains wire-compatible because the marker and its
`agent:updated` payload field are additive. The daemon still owns marker persistence and
resolution, but it cannot make an old frontend honor a written-empty clear or a specific
non-empty marker. Such a frontend can only derive from the transcript rows it loaded: it can
re-show an answered question when the answer row is outside its page, and it cannot recover a
marked question-bearing row that is off-page. Pending questions do not hold deliveries on
current daemons (v9.5+), regardless of frontend version.

*Marker re-derivation on transcript swaps.* `agent.replaceMessages` re-mints row ids, so any
surviving marker is dangling by construction; `agent.editAndRegenerate` truncation keeps the kept
prefix's ids (suffix-only delete, intentd#1757) but may have dropped the marked row. Neither path
tolerates a possibly-dangling marker: both re-derive it over the post-swap transcript (newest
question-bearing assistant row not answered below it) and clear it when there is none, then
recompute displayStatus and kick the queue drain (a best-effort nudge for entries parked by other
gates — these paths start no turn of their own).

**Message origin.** The user/automatic origin taxonomy still matters for pending questions in one
direction only: a **user-origin** row (`agent.sendMessage` — the FE/router front door,
`agent.sendQueuedMessageNow`, `agent.editAndRegenerate`, or a drained user-origin queue entry) is
the only carrier of the answer tag below, and a plain user row is **not** an answer — it leaves the
marker exactly as it was, as does the agent's reply to it. Automatic deliveries (A2A sends, parent
wakes, event-subscription batches, `agent.sendToTask`, `agent.wakeOrCreate` context messages) are
neither gated by the marker nor able to resolve it. Origin otherwise keeps its unrelated roles:
the attention-request retire (§5.5 above) and the archived-workspace exemption.

**Resolution.** The pending set clears when (1) a user row lands whose `messageMetadata` is
`{ "type": "question_answers", "answeredQuestionsMessageId": "<marked assistant message id>" }`
naming **exactly** the marked message — the FE composer wizard tags its flattened `Q:`/`A:` answer
message this way; the daemon never inspects the answer TEXT, and a missing / foreign / stale
`answeredQuestionsMessageId` (e.g. an answer for a set a newer turn already superseded) is a no-op,
so a late answer can neither resolve a newer pending set nor re-arm an old one. The intake runs on
every user-row persist path (direct send, queue drain, wake delivery), so an answer that was
auto-queued behind a busy turn still resolves on drain; (2) **`agent.dismissQuestions`** persists
the dismissal marker for that message id — since intentd#892 (within v4.3) the dismissal
additionally delivers the system-origin **dismissal notice** to the model (immediate turn when
idle; otherwise promoted to the absolute queue head with `interruptPriority: true`, ahead of every
queued entry including pre-existing interrupts — best-effort under a concurrent drain race; see
the `agent.dismissQuestions` row for the wording, `questions_dismissed` metadata, ordering,
idempotency, and fail-soft contract); or (3) a **newer** question-bearing assistant turn
overwrites the single-slot marker. The dismissal RPC kicks the queue drain so entries parked for
other reasons (a busy race, the notice enqueued by the dismissal itself) resume without waiting
for the next end-of-turn drain. Pendingness feeds the workspace's derived `displayStatus`: a
top-level foreground agent with pending questions promotes it to `needs_attention` (§5.1 step 2),
and each marker flip — the question-asking turn end and every resolution path above —
recomputes-and-compares, pushed as `workspace:displayStatus-changed` on an actual transition
(§6.5).

```json
// → automatic A2A send while the target has pending questions (idle target)
{ "jsonrpc":"2.0","id":30,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"[WORKSPACE EVENTS] ..." } }
// ← delivered immediately (v9.5): the pending marker does not gate delivery and survives the turn;
//    a BUSY target would answer the ordinary busy-queue result { success, queued: true, queuedMessage, turnId }
{ "jsonrpc":"2.0","id":30,"result":{ "success": true, "queued": false, "messageId":"user-msg-99..", "turnId":"user-msg-99.." } }
```

```json
// → dismiss the pending questions without answering
{ "jsonrpc":"2.0","id":31,"method":"agent.dismissQuestions",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","messageId":"0190a1b2-assistant" } }
// ← marker persisted; agent:updated emitted; queue drain kicked (parked entries resume);
//    dismissal notice delivered to the model (immediate turn when idle, else promoted to the
//    absolute queue head with interruptPriority, ahead of pre-existing interrupts — intentd#892),
//    carrying messageMetadata:
//    { "type":"questions_dismissed", "source":"system", "dismissedQuestionsMessageId":"0190a1b2-assistant" }
{ "jsonrpc":"2.0","id":31,"result":{ "success": true, "dismissedQuestionsMessageId":"0190a1b2-assistant" } }
```

### Pending proposals (within v8.7 — [intentd#1580](https://github.com/intent-hq/intentd/pull/1580), [intentd#1581](https://github.com/intent-hq/intentd/pull/1581))

Session-metadata tracking for the **proposal resource blocks** an agent's turns produce (§7.1 — `application/vnd.intent.proposal+json`, emitted by `ws.app.proposal.show` and `ws.workspace.proposeSibling`), so a proposal buried in scrollback stays discoverable and clients can render pending proposals in a dedicated surface (e.g. a composer-slot tray) instead of relying on transcript scan alone.

- **Recording.** When a turn persists lifted proposal resource blocks, the daemon records each block's proposal id plus the carrying `messageId` in the ordered `pendingProposals` list in session metadata: `[{ "proposalId": string, "messageId": string }, ...]`. The proposal identity is **`applyToolCallId ?? preview.title`** — the same identity `proposal_resource_uri` encodes — parsed from the block's embedded proposal JSON; blocks with neither are not recorded. Both persist paths are covered (the registry/array path and the wrapped-echo path both land as lifted standalone blocks in the persisted array), including the **interruption flush** — a preempted turn's already-streamed proposal blocks are scanned when the partial message persists.
- **Set semantics.** Unlike the single-slot question marker, the list is a set: multiple proposals across turns stay pending together. New entries append last, in block order; a **re-proposed id replaces its older entry** (dedupe by `proposalId`, newest entry wins and moves to the tail with the new carrying `messageId`).
- **Projection & events.** The list is lifted into the structured `AgentLite` `metadata.pendingProposals?` (`agent.get` only — stripped from `agent.list` rows as detail-only since intent#5383, see the `agent.list` row; omitted when empty), and every committed change emits `agent:updated` carrying the new list (`{ agentId, pendingProposals }` — the resolve path also carries `proposalResolutions`), so clients re-read the projection without a transcript scan. An unchanged list (same ids already recorded under the same message) writes and emits nothing.
- **Transcript-swap reconciliation.** `agent.replaceMessages` re-mints row ids, leaving surviving entries' `messageId`s dangling by construction; `agent.editAndRegenerate` truncation keeps the kept prefix's ids (suffix-only delete, intentd#1757) but may have truncated a carrying row away. After either swap the list is rebuilt against the post-swap transcript: each pending entry is remapped to the **newest** assistant row still carrying its proposal block (under stable ids a surviving entry maps onto itself), and an entry whose block no longer exists anywhere in the transcript is dropped. Resolution state is preserved — entries the list no longer holds are never re-added, even when their blocks survive the swap.
- **Durability.** Writes are atomic single-key `json_set` updates (sibling metadata keys preserved), serialized per agent on the same mutation lock as the question markers. Best-effort: a persist failure is logged and never fails the turn.
- **Resolution.** `agent.resolveProposal` (method table above) moves an entry out of the list into the `proposalResolutions` map (`proposalId -> "applied" | "dismissed"`, capped at 100 entries, oldest evicted) and notifies the model on both outcomes. Besides the client-driven Apply, the proposing agent itself is a second resolver of its own pending list: on the user's explicit chat instruction, `ws.workspace.applyProposal` (MCP-only; see "Agent apply" in [workspace.md](./workspace.md)) creates the `workspace-create` proposal's workspace under the stored idempotency key and then calls this same path requesting `applied`, so the `agent:updated` emit and the `proposal_resolved` notice are identical to a card Apply. Because the resolver echoes an already-persisted outcome instead of rewriting it, a card resolution that landed from the UI while the create was in flight is kept and reported as the binding's `outcome`: a concurrent non-applied resolution (`dismissed`) comes back with the created workspace retained and a `resolveWarning` saying the workspace exists, while a concurrent UI `applied` comes back as `applied` with no warning. There is **no delivery hold**: unlike pending questions, pending proposals do not park automatic deliveries — the proposing agent keeps working.

```json
// → resolve a pending proposal after the client-side Apply succeeded
{ "jsonrpc":"2.0","id":32,"method":"agent.resolveProposal",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","proposalId":"call-789",
             "outcome":"applied","detail":"Created workspace ws-def." } }
// ← resolution persisted in proposalResolutions, entry removed from pendingProposals;
//    agent:updated emitted carrying both; applied notice delivered to the model
//    ("User applied the proposal 'Title'. Created workspace ws-def." — immediate turn when
//    idle, else promoted to the queue front), carrying messageMetadata:
//    { "type":"proposal_resolved", "source":"system", "proposalId":"call-789", "outcome":"applied" }
{ "jsonrpc":"2.0","id":32,"result":{ "success": true, "proposalId":"call-789", "outcome":"applied" } }
```


```json
// → request
{ "jsonrpc":"2.0","id":20,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"Run the tests" } }
// ← response (agent was idle — message delivered)
{ "jsonrpc":"2.0","id":20,"result":{ "success": true, "queued": false, "messageId": "user-msg-1718...-ab12" } }
```

```json
// → agent.wakeOrCreate: wake branch (a resumable assigned agent exists — most-recent-first)
{ "jsonrpc":"2.0","id":21,"method":"agent.wakeOrCreate",
  "params":{ "workspaceId":"ws-abc","taskNoteId":"note-task-1","contextMessage":"resume","model":"opus4.7" } }
// ← response (agent was woken; earlier stale assignments are reported via cleanedUpAgentIds when present)
{ "jsonrpc":"2.0","id":21,"result":{ "ok": true, "agentId": "agent-abc", "agentName": "Task: Deploy", "created": false, "action": "woke_existing", "taskTitle": "Deploy", "result": { "success": true, "queued": false, "messageId": "user-msg-...", "action": "woke_existing" }, "cleanedUpAgentIds": ["agent-stale-1"] } }

// → agent.wakeOrCreate: create branch (no live/resumable assignment — rich payload; specialist/model from a newest assigned session would override create.specialist/create.model)
{ "jsonrpc":"2.0","id":22,"method":"agent.wakeOrCreate",
  "params":{ "workspaceId":"ws-abc","taskNoteId":"note-task-1","contextMessage":"kickoff","callerAgentId":"agent-parent","delegationDepth":1,"messageMetadata":{"type":"task_wake","source":"wake"},
             "create":{"specialist":"implementor","provider":"acp/mock","metadata":{"custom":"field"},"skipAutoCommit":true} } }
// ← response (new agent created; agent.create's rich result nested under `result`;
//    callerAgentId present → SUB-1 auto-subscription fields subscriptionId/message)
{ "jsonrpc":"2.0","id":22,"result":{ "ok": true, "agentId": "agent-new", "agentName": "Task: Deploy", "created": true, "action": "created_new", "taskTitle": "Deploy", "result": { "id": "agent-new", "text": "...", "backgrounded": true, "queued": false }, "subscriptionId": "a1b2c3d4-...-cd34", "message": "Created new agent \"agent-new\" for task \"Deploy\".\nContext message delivered.\nYou will be notified when the agent responds." } }

// → agent.wakeOrCreate: depth-guard rejection (delegationDepth >= MAX_DELEGATION_DEPTH)
// ← { "jsonrpc":"2.0","id":23,"error":{ "code": -32602, "message": "agent.wakeOrCreate: delegation depth 2 exceeds MAX_DELEGATION_DEPTH (2)" } }
```

> **Migrating off the removed FE `sendBackendInitiatedMessage`.** Callers that
> previously branched on the FE-only `errorCode: "ALREADY_STREAMING"` result
> should now treat `agent.sendMessage`'s `{ queued: true }` response as the
> "agent is mid-turn / already streaming" case: the daemon auto-queues the
> message behind the in-flight turn and returns `{ success: true, queued: true,
> messageId? }` without preempting. For the "resume or spin up the assignee for
> a `taskNoteId`" branch, use `agent.wakeOrCreate`; for a known existing
> `agentId`, use `agent.sendMessage` directly (the daemon distinguishes the
> mid-turn case via the boolean `queued` flag).

**Diagnostics & session-shape RPCs.** A sanitized diagnostics snapshot for the agent runtime — agent statuses, subscriptions, queues, delegation groups, delivery stats, recent delivery events, and stuck-risk signals. Plus four session-shape RPCs: the full-session read `agent.getSession`, the partial-mutation writer `agent.update`, and the transcript-mutation pair `agent.appendMessage` / `agent.replaceMessages`. `agent.enhancePrompt` (one-shot prompt-enhance / AI-layout generation; full contract in §5.31) is cross-referenced here as a namespace index entry. `agent.retry` redrives a failed agent spawn.

| Method | Params | Result |
| --- | --- | --- |
| agent.diagnostics | workspaceId (req), agentId?, taskNoteId?, staleRespondingAfterMs? | { diagnostics, text } — JSON snapshot plus a pre-formatted text rendering; optional filters narrow to one agent or task. The snapshot includes `eventSubscriptions` (monorepo#947): the workspace's live `event.subscribe` registrations (same per-entry shape as `agent.getSubscriptions` plus `orphaned`), counted in `summary.eventSubscriptions` and per-agent as `eventSubscriptionCount`; a subscription whose subscriber is missing or deleted raises an `orphaned-event-subscription` stuck-risk signal (live chief cross-workspace subscribers are not flagged). The `queues` snapshots are real ([intentd#816](https://github.com/intent-hq/intentd/pull/816) — previously hardcoded `[]`): each agent's pending entries in drain order (interrupt-priority first, then FIFO; `editing: true` entries last), `content` truncated to 200 chars with a `…` ellipsis, bulky `imageBlocks`/`fileBlocks` dropped, attribution left in `messageMetadata` (the services-layer presentation — see the agent-facing queue visibility block above the Pending questions section). Agent rows carry `waitingOnHooks?` (idle-visibility, within v3.1) — the same active-hook metadata list as the §5.5 `AgentLite` projection, omitted when empty — and `waitingOnPrMonitors?` (idle-visibility, unified external-wait, within v6.2) — the same active-PR-monitor metadata list, omitted when empty. Agent rows also carry `subtreeMemoryBytes?` (within v6.16; monorepo#2063) — the resident bytes of the agent's descendant process tree (each descendant's RSS credited to its nearest registered agent root, from the same sweep as `system.status`'s `childMemoryBytes`, §5.7), **omitted** when the agent has no attributed bytes (not spawned, no sample yet — the first sweep lands within the sampler's current cadence (~5s baseline, 500 ms while an ephemeral ACP adapter holds a slot, §5.7) — or no runtime manager attached; absent, never `0`/`null`). **Diagnostics-only by design**: the field never rides the hot `agent.list`/`agent.get` payloads (§5.5 `AgentLite`) — measurement/observability only, nothing enforces per-agent limits with it |
| agent.memoryUsage *(v10.4)* | — (daemon-global; accepts an empty params object, no `workspaceId`) | { sampledAt, totalBytes, agents: [{ agentId, agentName, workspaceId, provider, model?, rootPid, processCount, memoryBytes, processes: [{ pid, parentPid, name, cmdline, memoryBytes }] }] } — per-agent memory attribution from the same descendant-tree sweep behind `system.status`'s `childMemoryBytes` / `agentMemoryBytes` (§5.7) and `agent.diagnostics`' `subtreeMemoryBytes` (above): one row per spawned agent whose root pid was alive in the sweep, each descendant's RSS credited to its nearest registered agent root, so a client can name WHICH agent (and which process under it) holds the memory rather than only how much the tree holds. Rows sort by `memoryBytes` descending (ties by `agentId`); each row's `processes` sort the same way. `memoryBytes` is the sum of the row's `processes[].memoryBytes` and `totalBytes` the sum over rows (equal to `system.status.agentMemoryBytes` for the same sweep). `provider` is the session row's provider id (the value `agent.get` reports, e.g. `mock`), falling back to the live handle's spawn-time command only for a row that never recorded one; `model` is the spawn-time value from the live handle, falling back to the session row (omitted when neither knows it, never `null`); `agentName` / `workspaceId` come from the session row, and a bucket whose session row is gone (deleted mid-sweep) is **omitted** — from the list and from `totalBytes`; `rootPid` is the handle's child pid, falling back to the one row in the bucket no other row parents (a handle the exit watcher already removed). `sampledAt` (RFC-3339 UTC) stamps the sweep the rows came from — stamp and rows are read from the sampler as one value, so a sweep landing mid-request never pairs one sweep's stamp with the next sweep's processes; a read is up to one baseline period (~5s) old. A session lookup that fails for any reason other than the row being gone is an error (`-32603`), never a silently shorter list. **Before the first sample lands, or when no tree probe is installed** (bare wiring), the result is exactly `{ sampledAt: null, totalBytes: null, agents: [] }`; a sampled daemon with no live agent serves `totalBytes: 0` and an empty list. Point-in-time and best-effort: a pid may be dead by the time the client reads it, and descendants under no registered root (one-shot adapter chains, `host.exec` children) never appear here — they count only in `childMemoryBytes`. Owner-only on the transport allowlist (daemon-wide read, no membership filter), like `system.status` |
| agent.getSession | agentId (req), workspaceId? | { session: AgentSession } — full projection (superset of `AgentLite`): includes `systemPrompt`, `specialist`, the persisted metadata block, and the full `messages` log (chronological). Also carries the derived monorepo#940 `sessionCorrupted?` flag (same derive-on-emit + omitted-when-false semantics as the `AgentLite` projection, §5.5 `agent.list`) so a client rehydrating after a terminal-failure `agent:status-changed` still sees it. Both projections serve the persisted top-level `stopReason?` and — additive — `stopReasonTimestamp?` (the ISO timestamp the stop reason was recorded; persisted alongside `stop_reason`, cleared wherever it clears — turn begin, `agent.retry` — and omitted when absent, never `null`), so clients can render how long ago a parked-in-error session failed. Both projections also serve the top-level `reasoningEffort?` (v5.2) — the session's persisted reasoning-effort level, omitted when unset — and the session-discovered `effortLevels?` (§5.5 "Session-discovered effort levels"; omitted when the provider advertises none). Both projections also serve the harness stamp `harnessVersion` + `harnessFeatures` (within v7.0, §5.5 "Harness versioning") — the immutable creation-time harness version (always present) and the captured `agentFeatures` snapshot (always carries a value on the wire; a legacy pre-snapshot row follows live settings on read until its first activation freezes the snapshot). "Both projections" here means this read and `agent.get` — `agent.list` rows strip `effortLevels`, `harnessFeatures`, `contextReferences`, `fileBlocks`, `stats` and `metadata.pendingProposals` / `proposalResolutions` as detail-only (intent#5383; see the `agent.list` row). Backs the FE-side `loadAgent` rehydration path. `-32602 "Agent not found"` when the session is unknown |
| agent.update | agentId (req), workspaceId?, changes (req) | { success: true, agent: AgentLite } — partial update of the persisted `AgentSession` from a `changes` object. Whitelisted fields (plus `rememberSpecialist` alongside `specialist`, see [manual memory](#manual-specialist-memory)): `status`, `isActive`, `acpSessionId`, `backendSessionId`, `name`, `nameExplicitlySet`, `model`, `reasoningEffort` *(v5.2)*, `provider`, `systemPrompt`, `specialist`, `taskNoteId`, `skipAutoCommit`, `completionReport`, `completionReportTimestamp`, `delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`, `fileBlocks`, `isBackground`, `notificationsMuted`. `notificationsMuted` must be a JSON boolean — any other value (including `null`) is `-32602` (``agent.update: `notificationsMuted` must be a boolean``) with the session untouched; `true` mutes, `false` clears, the result `AgentLite` echoes the new value, and the ordinary `agent:updated` is emitted (see the §5.5 `agent.list` row for the field's projection and MCP-strip contract). **A muted session is excluded from every workspace-level rollup** (§5.1): the derived workspace `unread`, the `displayStatus` attention axes (`failed` / `blocked` / `needs_attention`, incl. pending structured questions), and the turn-end automatic `unread` raise all skip it, exactly like a background or soft-retired session. A mute toggle that actually changes the flag recomputes-and-compares `displayStatus` (§6.5 step 0) so muting the only attention-raising agent emits `workspace:displayStatus-changed`; muting the LAST unread top-level session additionally settles the derived workspace `unread` like the last seen-marker advance (stored flag cleared, ONE `workspace:attention-changed { none }`, `review_required` untouched). Unmuting writes nothing at the workspace level beyond the `displayStatus` recompute — an unmuted session with an unseen assistant tail re-derives `unread` on the next read (the `agent.restore` precedent). `workspace.markSeen` still advances a muted session's seen marker. Optional-string fields accept a JSON `null` to clear; `fileBlocks` accepts a JSON `null` to clear and is otherwise validated under the v10.0 file-block contract on `agent.sendMessage` (attachment references only; an entry carrying inline `data` or missing a non-empty `attachmentId` is `-32602` naming the block index, with the session untouched); `reasoningEffort` additionally treats an empty/whitespace-only string as a clear (stored as-is otherwise — no vocabulary validation, providers interpret the level; applied on the next prompt send). `specialist` follows the §5.5 `agent.create` strict-validation contract (monorepo#3497): an alias is canonicalized to the claiming specialist's canonical id before persistence, and an unknown id is rejected with `-32602` (`unknown specialist: <id> (known specialists: ...)`) with the session untouched; `null` still clears the field. `effortLevels` is NOT whitelisted (daemon-discovered at session open, never client-written — §5.5 "Session-discovered effort levels"); the result `AgentLite` still serves it when present. Write-once (`acpSessionId`) and immutable (`provider`) invariants are still enforced by the store. Emits `agent:updated` (or `agent:renamed` when `name` is the only mutated field). Unknown fields → `-32602`; unknown agent → `-32602 "Agent not found"` |
| agent.appendMessage | agentId (req), role (req, `user`\|`assistant`\|`tool`\|`system`), contentBlocks (req), workspaceId?, metadata? | { success: true, message: AgentMessage } — append a single message to the transcript. `metadata` persists verbatim on the row and round-trips on reads. Emits `agent:message`. Rejected with `-32602` when the agent is mid-turn (transcript mutations must not race the streaming writer) |
| agent.replaceMessages | agentId (req), messages (req, `AgentMessage[]`), workspaceId? | { success: true, messages: AgentMessage[] } — atomically swap the entire transcript. Each entry needs `role` + `contentBlocks`; `metadata` / `timestamp` are optional. Row ids and `seq` values (`0..n`) are minted by the store so callers cannot smuggle stale ids across the swap. Emits `agent:updated` with `{ replacedCount }`. Rejected with `-32602` when the agent is mid-turn (same rationale as `agent.appendMessage`) |
| agent.retry | workspaceId (req), agentId (req) | { ok: true, redriven, turnId? } \| { ok: false } — redrive a failed agent spawn. Only valid when the session status is `error`; returns the bare `{ ok: false }` otherwise. `redriven` is ALWAYS present on the `ok: true` arm (both values) and always absent on the `ok: false` arm, so clients may branch on it unconditionally once `ok` is `true`. `redriven` (STAB-54) distinguishes "a queued message is being redriven" (`true` — status cleared to `pending`, drain started) from "the queue was empty, nothing to redrive" (`false` — status cleared to `idle`; the next `agent.sendMessage` starts a fresh turn). `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is present ONLY when `redriven: true`: the head ready-to-send entry's turn correlation id, peeked BEFORE the drain pops it — because a terminal-failure requeue preserves the failed turn's original `turnId`, this is the SAME id the original send/enqueue RPC returned, so the redrive's `agent:queue:processing` and lifecycle events correlate with the turn the client already keyed (omitted when absent, never `null`). Clears the error status back to pending, emits `agent:status-changed`, tears down any stale child handle, and attempts to redrive the front-of-queue message (requeued at exhaustion) plus any subsequent messages. Reuses the spawn-retry/backoff machinery, so a retry that fails again lands back in the `error` state with the full event sequence (`agent:stream:status` retry hints, terminal `agent:failed` + `agent:stream:end`, `agent:status-changed` persisting `error`). **Poisoned-session recreate ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940)):** when the parked session classifies as corrupted/poisoned (the same classification that emits `sessionCorrupted: true` — session-fatal provider block, deterministic `session/prompt` 400 `invalidArgument` rejection, or the identical-failure streak at threshold), the retry arms the forced-recreate flag (same mechanism as `agent.editAndRegenerate`) BEFORE clearing the streak, so the redrive's session setup SKIPS the `session/load` resume — which would replay the exact context the provider deterministically rejects — and opens a fresh `session/new` with the prior history prepended as `<supervisor>` XML. Retry also clears the identical-failure streak and failure-wake dedup records (the deliberate quarantine escape hatch, monorepo#840) |
| agent.enhancePrompt | prompt (req), mode?: "enhance" \| "layout", model?, workspaceId?, timeoutMs? | { enhanced, original, mode } — one-shot prompt-enhance / AI-layout generation via a spawned `auggie --print`; no agent session is created or persisted, no events emitted. Full contract in §5.31 |

### 5.5a `sandbox.cow.*` (CoW agent sandboxes)

> **Namespace.** The `sandbox.cow.*` methods manage CoW (copy-on-write) sandboxed agent workspaces. When `agent.delegate` provisions a CoW sandbox (§5.5 — asynchronously: the delegate result reports `effectiveIsolation: "pending"` and the clone settles in a background task), the agent works in an isolated repository clone. When the agent completes, `sandbox.cow.merge` attempts to automatically merge the sandbox commits back to the canonical repository, preserving agent attribution. If the merge encounters conflicts or the canonical repository has uncommitted overlapping changes, the agent is bounced with resolution instructions or the merge is deferred to manual resolution. All `sandbox.cow.*` methods require `workspaceId`. Renamed from `sandbox.*` (intentd#730, no aliases); the bare `sandbox.*` namespace is reserved for the upcoming agentOS sandbox surface.

**Canonical repository (checkout-mode aware).** The directory a sandbox is cloned from and merged back into follows the workspace's checkout mode (§5.1): for **shared-checkout** workspaces (skip-isolation / no provisioned checkout, no `checkoutMode`) it is the user's repository folder (`repositoryPath`); for **CoW-checkout** workspaces (`checkoutMode: "cow"`) it is the **workspace checkout** (`worktreePath`) — agent commits merge back into the workspace's own checkout, not the user's repo folder; for **`checkoutMode: "direct"`** workspaces (standalone plain clone) it is the workspace checkout when one was provisioned (cache hydration), else the repository folder itself (`isNewRepo` initialization). Worktree-mode workspaces (`checkoutMode: "worktree"`) do not support sandboxes (sandbox provisioning is rejected; agents share the checkout).

| Method | Params | Result |
| --- | --- | --- |
| sandbox.cow.merge | workspaceId (req), agentId (req) | { ok: true, status, commitRange?, canonicalHead?, conflictingPaths?, reason?, overlappingPaths? } — manually merge a sandbox back to the canonical repository. `status` is `"merged"` (clean merge succeeded; returns `commitRange` + `canonicalHead`, emits `sandbox:cow:merged`, and the sandbox is discarded), `"conflict"` (merge conflicts detected; canonical left pristine; returns `conflictingPaths` + `canonicalHead`; sandbox status → `conflict_bounced`), or `"blocked"` (canonical has uncommitted changes overlapping with sandbox; returns `overlappingPaths` and `reason`; sandbox status → `merge_pending`). When `status = "merged"`, `canonicalHead` is the canonical repository HEAD SHA after the merge. `-32602` (`sandbox not found for agent <id>`) when no sandbox exists for the agent |
| sandbox.cow.discard | workspaceId (req), agentId (req) | { ok: true } — discard a sandbox without merging. Removes the sandbox directory and database record; discarding a nonexistent sandbox is a no-op success. This is the escape hatch when a sandbox is no longer needed or the agent failed |

**Automatic merge on completion.** When a sandboxed agent completes (`agent:idle` event), the daemon automatically attempts `sandbox.cow.merge`. On a clean merge, the agent's coordinator sees the `merged` sandbox status in the completion event and receives a `sandbox:cow:merged` event. On conflict, the agent is bounced with a list of conflicting paths and resolution instructions (conflict resolution is iterative; the agent re-completes after fixing conflicts). On `blocked` outcome or retry exhaustion, the completion propagates with `merge-pending` status, and the user must call `sandbox.cow.merge` manually once canonical is clean.

**Status lifecycle.** Sandbox records track status through the merge lifecycle: `created` (provisioned), `merging` (merge in progress), `merged` (successfully merged and discarded), `conflict_bounced` (conflicts detected; agent woken with paths), `merge_pending` (awaiting manual merge; blocked or retry cap hit), `discarded` (discarded without merging). The `agent:idle` completion event includes the sandbox status when applicable.

**WIP snapshot exclusion.** Sandboxes provisioned from a dirty canonical repository create a snapshot commit of the WIP state (message prefix `"WIP snapshot for"`). These snapshot commits are **never merged back** to canonical — only commits made by the agent after the snapshot are cherry-picked. This ensures the user's uncommitted work stays local.

**Attribution preservation.** Merged commits preserve the agent's original author/committer identity (from the sandbox git signature). The canonical repository gains the agent's commits as if the agent had worked directly in canonical, maintaining the audit trail.

```json
// Request: manual merge after resolution
{ "jsonrpc":"2.0","id":80,"method":"sandbox.cow.merge",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123" } }
// ← response (clean merge)
{ "jsonrpc":"2.0","id":80,"result":{
  "ok":true,"status":"merged","commitRange":"1a2b3c..4d5e6f","canonicalHead":"a1b2c3d4..." } }
// ← (also emits sandbox:cow:merged event)

// Request: discard a failed sandbox
{ "jsonrpc":"2.0","id":81,"method":"sandbox.cow.discard",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-456" } }
// ← response
{ "jsonrpc":"2.0","id":81,"result":{ "ok":true } }
```


### Prepared node placement and CoW retirement

[§5.50](./nodes.md) defines additive placement on existing creation/delegation
paths, node/lease/checkpoint fields, new halted/resuming statuses, and replacement
hub operations. These fields are not implemented at the pin. Current CoW methods
and behavior above remain until the separately versioned removal lands; the final
removal has no alias or live-sandbox migration.

### Prepared model platform routing (11.2)

[Model-directed routing](../model-platform-routing.md) specifies the widened
placement object on create/delegate/batch and wakeOrCreate.create, optional durable
idempotency keys, exact batch retry behavior and actual MCP forwarding (including
the compatible trailing wake options argument). It preserves existing model/provider
resolution and assigned-agent wake semantics. Architecture-only inputs require
agentPlatformRouting 1, not merely agentNodes 1. Discovery/errors must render safe
correlated platform pairs through the model-visible String boundary.

For effective placed operations under agentPlatformRouting 1, the exact
[per-method launch responses](../model-platform-routing.md#per-method-launch-responses)
retain all required success fields in the tables above. Without a real persisted
agent, pending/failed/uncertain is a structured -32603 error, never an invented
agent or partial success. Batch error rows carry typed launch correlation; keyed
retries preserve held/skipped classification and only reconcile already owned
pending rows, overriding stateless batch reclassification for that scoped path.
Legacy unplaced calls retain their existing envelopes and retry behavior.

### Manual specialist memory

`agent.create` accepts optional `rememberSpecialist: boolean` (default false).
When true, successful manual foreground creation atomically stores the canonical
`specialistId` (or null for General) with the new session. `agent.update` accepts
`changes.rememberSpecialist: boolean` alongside an explicitly supplied
`changes.specialist: string | null`, for the welcome-screen specialist picker.
The update and remembered preference commit together. For an opted-in welcome
selection, a generated non-explicit placeholder name follows the selected
specialist display name (General becomes `Agent`); explicit names, intentional
custom/task names, and names supplied in the same update are preserved. The
existing `agent:updated` event includes a changed generated name. Non-boolean values are
rejected with `-32602`; update opt-in without `changes.specialist` is also rejected.
Omitted/null/false flags leave memory unchanged.

Parented, task-linked, background, and agent-created sessions do not change manual
memory, even when the flag is supplied. Delegation does not opt in. A rejected
creation or update changes no preference. Clients must not opt in on cancelled
selections or transient empty placeholders. Workspace deletion removes its memory.

Clients read `agent.getCreationPreferences` when opening manual creation surfaces.
A remembered specialist that no longer exists falls back through the existing
valid defaults; explicit General remains General. Provider, model, and effort
continue to resolve from current Settings and specialist defaults each time,
never from the previous agent. This addition emits no preference-specific event.

A name derived from the specialist display name is generated (`nameExplicitlySet:
false`); an explicit user name retains the existing protection against guarded
opening-turn renames. Generated names may receive the first-message task-naming
instruction independently of workspace naming.
