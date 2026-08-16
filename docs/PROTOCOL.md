# Intent Backend — JSON-RPC Protocol v7.0

**Protocol Version:** `7.0`

This document is the canonical wire contract between Intent clients (desktop, iOS, CLI, and agent developers building clients) and the Intent backend daemon (`intentd`): transport, JSON-RPC envelope, the full method catalog, events, agent streaming, the permission flow, error codes, and thin-client guidance. It is a **living specification**: changes land through the compatibility policy below, and the method surface is enforced by golden tests in the `intent-transport` crate.

## Table of Contents

- [Protocol Version & Compatibility](#protocol-version--compatibility)

1. [Transport](#1-transport)
2. [Authentication](#2-authentication)
3. [Message Envelope (JSON-RPC 2.0)](#3-message-envelope-json-rpc-20)
4. [Heartbeat & Lifecycle](#4-heartbeat--lifecycle)
5. [Method Catalog](#5-method-catalog)
6. [Events & Subscriptions](#6-events--subscriptions)
7. [Agent Streaming](#7-agent-streaming)
8. [Permission Flow](#8-permission-flow)
9. [Error Codes](#9-error-codes)
10. [Thin-Client Guidance](#10-thin-client-guidance)

## Protocol Version & Compatibility

**Version:** `7.0`

Version 2.1 was an **additive** minor bump over 2.0: it added the `pr.capabilities` router method and the provider capability gating described in §5.7. Version 2.2 is an **additive** minor bump over 2.1: it adds the `system.importLegacy` fast-path method (UDS-only — see the §5 fast-path catalog). Version 2.3 is an **additive** minor bump over 2.2: it adds the `system.capabilities` **router** method (available on both UDS and WSS — unlike the UDS-only `system.*` fast-path controls; see the §5 fast-path notes). Version 2.4 is an **additive** minor bump over 2.3: it adds the `github.repoConfig.get` router method (§5.27) — a remote repository's `.intent/config.json` fetched via the GitHub contents API without a clone. Version 2.5 is an **additive** minor bump over 2.4: it adds the `system.gitCredential` fast-path method (UDS-only — see the §5 fast-path catalog), the daemon-backed git-credential endpoint consumed by the `intentd git-credential` helper (monorepo#884), and the `unsloth.status` / `unsloth.stop` router methods (§5.37) — observability and control for the daemon-managed singleton Unsloth server (monorepo#878 follow-up). Version 2.6 is an **additive** minor bump over 2.5: it adds the `providers.catalog` router method (§5.38) — the static provider registry served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. Version 2.7 is an **additive** minor bump over 2.6: it adds the `workspace.getAutoCommit` / `workspace.setAutoCommit` router methods (§5.1) — the persisted per-workspace auto-commit override resolved against the global `git.autoCommit` setting. Version 2.8 is an **additive** minor bump over 2.7: it adds the `agent.dismissQuestions` router method and the derived **question hold** on automatic deliveries (§5.5, question hold; intentd#751) — held sends surface the additive `heldForQuestions: true` result field and queue entries surface the additive `interruptPriority?: true` wire field. Version 2.9 is an **additive** minor bump over 2.8: it adds the `stats.getRateHistory` router method (§5.39) — the global per-minute token-rate history behind the HUD TOK/MIN chart — and the optional `parentAgentId` field on `agentSummary.agents[]` entries (§5.1 `WorkspaceAgentInfo`) — the delegation parent already surfaced as `metadata.createdByAgentId` on full agent loads — so clients can rebuild the delegation tree from the summary alone. Version 2.10 is an **additive** minor bump over 2.9: it adds the background-hook management router methods `hook.list` / `hook.cancel` / `hook.runNow` (§5.40) and the `hook:*` event family (§6.5) — hook **scheduling** deliberately stays MCP-only (`ws.hook.schedule`, per the §6.8 principle: hooks are agent-authored background work; the FE reads, triggers, and cancels but never authors). No existing method changed shape in any of the 2.x bumps. Version 3.0 is a **breaking** major bump over 2.10: it **removes** the `pr.waitForChanges` router method (§5.7) — superseded by background hooks (§5.40), which watch PR conditions without holding a request open — and additively extends the Hook shape with `lastState?` plus the run-to-run `state` carry-over contract (§5.40). Version 3.1 is an **additive** minor bump over 3.0: it adds the hook TTL (§5.40) — the optional `ttlMs` schedule param (clamped to the 60-minute cap), the `expiresAt` field on the Hook shape, the new terminal `expired` state, and the `hook:expired` event in the `hook:*` family (§6.5); on expiry the owner is woken (`reason: "expired"`) so it can consciously reschedule. Within 3.1 (additive response fields, presence-detected per the convention below): idle-visibility for hook-owning agents — `waitingOnHooks?: [{ hookId, name, nextRunAt?, expiresAt? }]` (active = `scheduled`/`running` hooks; light metadata only, omitted when empty) on the `agent:idle` event payload (§6.5), the `AgentLite` projection served by `agent.list`/`agent.get` (§5.5), and `agent.diagnostics` agent rows (also §5.5) — so a parent or client can tell a hook-waiting idle agent from a stalled one; completion-watch and `after_all` **settlement additionally defers** on such an idle (the hook-waiting deferral, §Completion-watch persistence): an `agent:idle` while the child still owns active hooks is not its completion — watches stay armed and groups stay open until the child settles for real (bounded by the hook TTL), while `agent:failed` / `agent:deleted` and the attention/report immediate wakes are never deferred. Version 4.0 is a **breaking** major bump over 3.1: it changes the `terminal.list` response shape (§5.9/§5.13; monorepo#1334) — the bare terminals array is retired in favor of the `{ terminals: [{ id, name, cwd, isExecutingCommand }], daemonBootId }` envelope, where `daemonBootId` is the daemon's per-boot identifier (UUID v4, minted once per daemon process; never persisted): stable within one daemon lifetime and fresh after a restart, so equal `daemonBootId` values across responses prove the same daemon lifetime — which makes an **empty `terminals` list authoritative** for that lifetime (the terminals are really gone, as opposed to a restarted daemon that lost its PTYs). No method-catalog change. The agent-facing MCP `ws.terminal.list` binding unwraps the envelope internally, so the agent-visible contract stays the bare terminals array (§6.8). Version 4.1 is an **additive** minor bump over 4.0: it adds the `agent.listActive` router method (§5.5, monorepo#1395) — the daemon-global mid-turn agent list served from the runtime manager's in-memory busy set (no persisted-session scan). Within 4.1 (no wire change): the `agent.list`/`agent.get` store reads behind the `AgentLite` projection skip the `system_prompt` column entirely, and concurrent disk-usage walks are globally serialized (max 1 at a time) — both internal perf changes (intentd#881). Version 4.2 is an **additive** minor bump over 4.1: it adds the `workspace.diskUsage` router method (§5.1, monorepo#1396) — the on-demand poll for a workspace's cached disk footprint — and **stops populating** `Workspace.diskUsage` on `workspace.list` / `workspace.get` rows (and the workspace-subscription emit path). The field was optional (`skip_serializing_if`), so existing row decoders remain valid — it is simply never present anymore; clients that need the footprint call `workspace.diskUsage` instead. Within 4.2 (behavior only, no wire change): `workspace.archive` gracefully interrupts the workspace's in-flight agent turns and cancels its ACTIVE background hooks, queued messages and wakes park while the workspace stays archived (drained again after `workspace.unarchive`), and `workspace.delete` eagerly aborts live hook scheduler tasks before the store cascade — [intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896); see the §5.1 archive active-work teardown / delete cascade blocks and §5.40. Version 4.3 is an **additive** minor bump over 4.2: it adds the `voice.transcribe` router method (§5.41) — daemon-owned speech-to-text behind a pluggable provider seam (ElevenLabs Scribe / OpenAI), with the provider API keys resolved from the daemon's file-backed secret store via the `voice.*` settings paths (§5.12) so they never reach clients. Within 4.3 (no method-catalog or wire-shape change — the notice rides the existing opaque `messageMetadata` per-message payload and the v2.8 `interruptPriority?` queue flag): `agent.dismissQuestions` now **notifies the model** of the dismissal (intentd#892; §5.5 "Question hold", §7) — after the marker persist and hold release, a system-origin notice ("User dismissed your N questions without answering. Do not re-ask; continue with your best judgment.", count-aware wording) is delivered to the agent, carrying `messageMetadata { type: "questions_dismissed", source: "system", dismissedQuestionsMessageId }`, visible on the queued entry while undelivered (`agent.getQueue`) and persisted on the delivered user row; idle agents get it as an immediate turn, busy/still-held agents get it promoted to the queue head with `interruptPriority: true`; idempotent (no duplicate notice on re-dismiss) and fail-soft (a notice delivery error never fails the RPC). This supersedes the pre-#892 "the model is NOT notified" contract documented since v2.8. Also within 4.3 (behavior only, no wire change; [monorepo#1468](https://github.com/intent-hq/monorepo/issues/1468)): the **agent-waiting deferral** — an `agent:idle` for a child that itself holds live outgoing completion watches on other, unsettled agents is not its completion; completion-watch delivery and `after_all` settlement records defer exactly like the hook-waiting case (§Completion-watch persistence), with a 2-cycle deadlock guard and without deferring the child's own `after_all` group seal. Version 4.4 is an **additive**-style minor bump over 4.3: the `voice.transcribe` **no-API-key** failure (§5.41) now carries structured `error.data` — `{ "code": "voice-no-api-key", "detail": "<descriptive message>" }` — instead of the former plain string (monorepo#1448; intentd#902), following the `{ code, detail }` data-code precedent (`CloneFailed`, monorepo#826; `base-ref-unresolvable`, monorepo#761). The envelope is otherwise unchanged (`-32603`, `"Internal error"`), and `data.detail` is **byte-identical** to the pre-4.4 plain-string `data`, so clients that sniffed the message keep working; every other `voice.transcribe` failure is untouched (provider HTTP failures keep plain-string `data`, the `-32602` caller errors are unchanged). Version 4.5 is an **additive** minor bump over 4.4: it adds the `agent.markSeen` router method (§5.5) — the per-conversation **seen marker**: persists `lastSeenMessageId` (the id of the newest transcript message the user has seen) in the agent session metadata (survives daemon restarts), advances **monotonically** (naming a message older than the current marker is a no-op returning the current marker), emits `agent:updated` with `{ agentId, lastSeenMessageId }` (§6.5), and serves the marker as `metadata.lastSeenMessageId?` on the `AgentLite` projection (`agent.list` / `agent.get`) and `agent.getSession` (presence-detected additive response field, omitted when nothing was marked seen). Within 4.5 (additive metadata/event-payload fields, presence-detected per the convention below; [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919)): the **interruption-reason contract** (§7.2) — every interrupted turn's persisted marker row and interrupt terminal `agent:stream:end` carry the machine-readable `interruptReason` (`user_stop` / `preempted_by_message` / `daemon_shutdown` / `agent_stopped`), `interruptedBy` (`{ kind: "user" }` or `{ kind: "agent", agentId, name? }`) rides along only on `preempted_by_message`, and every interruption that found a registered live-turn slot now **always persists** the interrupted assistant marker row (empty `contentBlocks` included) so the interrupt `agent:stream:end` reliably carries `messageId` — superseding the STAB-114 zero-output no-op flush; the monorepo#1014 zero-output combined delivery is preserved by excluding the still-empty marker row from the turn-progress check. Version 5.0 is a **breaking** major bump over 4.5: it **removes** 11 caller-less `pr.*` router methods (§5.7) — `pr.capabilities`, `pr.createReview`, `pr.getReviews`, `pr.listCheckRuns`, `pr.listComments`, `pr.listReviewComments`, `pr.merge`, `pr.postComment`, `pr.replyToReviewComment`, `pr.resolveThread`, and `pr.updateBranch` — left dead after agent GitHub workflows moved to the `gh` CLI and the `ws.pr.*` MCP surface shrank to snapshot-only ([intent-hq/intentd#918](https://github.com/intent-hq/intentd/pull/918)). `pr.status` and `pr.refresh` survive unchanged, and the explicit-addressing `github.*` surface (§5.27) and the MCP `ws.pr.snapshot` binding (§5.7) are untouched. Calling a removed method now returns `-32601` (Method not found). Follows the v3.0 `pr.waitForChanges` precedent — a caller-less method is deleted outright with a major bump rather than deprecated in place ([intent-hq/intentd#921](https://github.com/intent-hq/intentd/pull/921); monorepo#1506). Version 5.1 is an **additive** minor bump over 5.0: it adds the optional `workspaceId?` param on `voice.transcribe` (§5.41) — when present, the daemon injects the workspace's auto-derived vocabulary into the transcription bias, merged as user `voice.vocabulary` → workspace auto-terms → request `context.keyterms` under the existing dedup/cap rules (case-insensitive dedup, first spelling wins, ≤ 100 terms total, ≤ 50 chars each); an absent or stale `workspaceId` is tolerated (never an error), a non-string value is `-32602` — plus the `voice.getWorkspaceVocabulary` router method (§5.41), serving the derived terms for client-side (OS-engine) transcription and Settings previews, and the `voice.workspaceVocabulary.maxTerms` settings-catalog entry (§5.12; number, default 50, min 0, max 100, TOML-backed under `[voice]`; `0` disables derivation and injection). Within 5.1 (behavior only, no method-catalog or wire-shape change — `name` remains a required string; only the schedule-time validation cap changed): the `ws.hook.schedule` hook-name cap is raised from 19 to 50 characters, and the name is reframed as a short human-readable, user-facing description of what the hook is waiting for (§5.40; [intent-hq/intentd#929](https://github.com/intent-hq/intentd/pull/929)). Within 5.1 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#932](https://github.com/intent-hq/intentd/pull/932)): the script **was-running marker** (§5.8) — `ScriptRuntimeState` gains the optional `previouslyRunning: true` field (omitted when false), served by `script.status`, the runtime part of `script.list` entries, and `script:state` events (§6.5), marking a **service-mode** script that was running when the daemon last stopped so clients can re-render its tab as idle after a restart. The marker is persisted on the script row (workspace-scoped), set on a service script's successful start/restart, cleared on user stop / natural exit / `script.remove` (and reset by a `script.create` upsert), and survives repeated daemon restarts until the script is started or explicitly stopped; `script.stop` on a non-running marked script is the **dismiss** affordance — it clears the marker (best-effort row write, like every other marker transition), emits a `script:state` snapshot, and returns ok instead of erroring. Version 5.2 is an **additive** minor bump over 5.1: it adds the first-class **`reasoningEffort` session field** (§5.5) — the reasoning-effort level requested for an agent session (e.g. `low` / `medium` / `high` / `xhigh`), stored **as-is** (providers own the vocabulary; the daemon never normalizes it) and applied on the next prompt send. Accepted as an optional `reasoningEffort?` param on `agent.create` (empty/whitespace-only collapses to unset; a non-empty level is validated against the resolved model's cached `effortLevels` under the §5.11 "Delegation reasoning-effort resolution" contract — `-32602` naming the valid values, before any side effect, and pass-through when there is no cached evidence), patchable via the `agent.update` `changes` whitelist (`reasoningEffort` — JSON `null` or an empty string clears it; no validation at the patch seam), and served as `reasoningEffort?` on both the `AgentSession` (`agent.getSession`) and `AgentLite` (`agent.list` / `agent.get` / `agent.create` / `agent.update` results) projections — presence-detected additive response field, **omitted when unset** (absent, never `null`). Legacy codex sessions whose stored model id embedded the effort as a compound `{base}/{effort}` suffix (the pre-5.2 codex effort-variant catalog rows) are normalized by a one-time store migration: the id splits into the base model plus `reasoningEffort`, guarded on a known codex effort suffix AND codex evidence (provider column, `codex:` compound prefix, or a known effort-variant base model) so slash-bearing non-codex ids (e.g. HuggingFace-style unsloth ids) are untouched. The codex spawn path applies the session field as the `-c model_reasoning_effort=…` config override (an effort still embedded in a compound model id wins over the session field; the `CODEX_REASONING_EFFORT` env seam remains the last-resort fallback). No method-catalog change. Within 5.2 (behavior only, no method-catalog or wire-shape change — the wire `hook.cancel` params/result are untouched; [intent-hq/intentd#953](https://github.com/intent-hq/intentd/pull/953), monorepo#1563): **hook cancel is ownership-scoped on the MCP side** (§5.40) — hooks are agent-owned, so `ws.hook.cancel` now only cancels the calling agent's own hooks (a non-owner cancel fails with a tool error naming the owner, leaving the hook active and emitting no `hook:cancelled`; the binding requires an agent caller context, mirroring `ws.hook.schedule`), while the caller-less wire/FE path still cancels any hook in the workspace and wakes its owner with the cancellation notice; an owner's own cancel still delivers no self-wake. Version 6.0 is a **breaking** major bump over 5.2: it **removes** the `event.recentFiles` and `event.directoryChanges` router methods (§5.10) — superseded end-to-end by the hybrid `file:*` event persistence introduced in the same change ([intent-hq/intentd#951](https://github.com/intent-hq/intentd/pull/951)). Calling either removed method now returns `-32601` (Method not found). Follows the v3.0 `pr.waitForChanges` and v5.0 `pr.*` removal precedents — a superseded method is deleted outright with a major bump rather than deprecated in place ([intent-hq/intentd#967](https://github.com/intent-hq/intentd/pull/967)). Within 6.0 (additive content-block kind and response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973)): **streamed reasoning** — ACP `agent_thought_chunk` updates now materialize as `thinking` content blocks (`{ type: "thinking", id, text }`) interleaved in stream order on the persisted assistant message and streamed live with `blockType: "thinking"` on `chat:stream:delta` / the §7.1 block deltas under the same stable `{messageId}:{blockIndex}` ids (§7.1); the server-derived live previews (`lastAgentResponse` / `digest`) deliberately **exclude** reasoning text; and `TokenUsageTotals` (§5.23) gains the optional `thoughtTokens` counter — camelCase `u64`, **omitted when zero/absent** (never `0`, never `null`), aggregated with the same saturating sum as the other counters, so clients that predate the field see the previous shape byte-for-byte. Also within 6.0 (additive settings-catalog entry, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#970](https://github.com/intent-hq/intentd/pull/970), [intent-hq/intentd#974](https://github.com/intent-hq/intentd/pull/974)): the `model.defaultReasoningEffort` setting (§5.12; string, default unset, TOML-backed under `[model]` as `defaultReasoningEffort`, stored as-is with a blank value reading as unset) — the last rung of the creation-time reasoning-effort chain (§5.5 "Creation-time reasoning-effort resolution"), applied only when no explicit param / specialist model-option / specialist frontmatter effort decided the level **and** the session's model itself resolved from the settings default chain; unlike the caller- and specialist-supplied rungs it is **lenient** — a level the resolved model's cached `effortLevels` provably does not list is dropped with a daemon warn log instead of raising `-32602`. Also within 6.0 (additive settings-catalog entry plus an MCP-only tool binding and prompt decoration — no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#971](https://github.com/intent-hq/intentd/pull/971)): the **per-turn agent state snapshot** (§5.5 "Per-turn agent state snapshot") — the `ws.agent.snapshot()` MCP binding serving the calling agent's own compact state digest (`time` plus the non-zero `hooks` / `agentWatches` / `queuedMessages` / `eventSubscriptions` / `runningSubAgents` / `numQuestionsAsked` / `pendingAttention` fields) and the `current ws.agent.snapshot() => {…}` line prefixed to every outbound turn prompt (skipped when the snapshot is trivial, never persisted), gated by the new `agentFeatures.stateSnapshot` setting (§5.12; boolean, default `true`, TOML-backed under `[agentFeatures]`) — the first `agentFeatures` toggle read **LIVE each turn** rather than captured at session creation, and one that gates the injection only: the MCP tool itself is never gated (the LIVE-read exception was later retired within 7.0 — [intent-hq/intentd#1273](https://github.com/intent-hq/intentd/pull/1273), below — so the toggle is now captured at session creation like the others). Also within 6.0 (no method-catalog change, so no version bump — [intent-hq/intentd#977](https://github.com/intent-hq/intentd/pull/977)): **auggie folded onto the generic provider path** — `host.checkAuggie` is now resolution-only (§5 fast-path notes), serving `{ available, path? }` with the `version` field **retired** and no `--version` spawn (the field was best-effort/optional and its only consumer, the FE's auggie version gate, was removed in the same change, [intent-hq/cloudlands-fe#824](https://github.com/intent-hq/cloudlands-fe/pull/824)); and the auggie auth probe behind `host.providerAuthStatus` is now the registry `auth_check_args` command `auggie token print` on the generic exit-code arm (stdout/stderr discarded — the command's output is the auth session secret), replacing the bespoke `auggie model list` output-sniffing probe. Also within 6.0 (additive Hook/event fields plus an MCP-only schedule param; no method-catalog change, so no version bump — [intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979)): **perpetual background hooks** (§5.40) — the optional `perpetual` param on `ws.hook.schedule` (default `false`; omitting it — or passing `false` — reproduces the one-shot *behavioral* contract, where the first dispatch retires the hook) makes a dispatch **non-terminal**, re-arming the hook to `scheduled` with a fresh `nextRunAt` until TTL expiry, cancel, or eviction, so `hook:dispatched` may repeat for one hook (§6.5); a dispatching schedule-time validation run on a perpetual hook wakes the owner AND persists the active schedule (`{ hook, dispatched: true }`); the Hook shape and every `hook:*` payload gain the always-present `perpetual` (bool) and `dispatchCount` (fires so far for every hook created or updated from v6.0 on — only a perpetual hook ever exceeds 1) fields, backed by the additive defaulted migration `0084_hook_perpetual.sql`, which backfills pre-existing rows to `perpetual: false` / `dispatchCount: 0` unconditionally (so a retained pre-migration row that had already dispatched reads back `dispatchCount: 0` despite having fired); and a perpetual hook's TTL-expiry notice reports `"N runs, M dispatches"` instead of the one-shot `"N runs completed without a dispatch"`. Also within 6.0 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#987](https://github.com/intent-hq/intentd/pull/987)): the `models.list` catalog cache (§5.30) **drops its 5-minute TTL** — cached entries are served indefinitely, and a probe now runs only on a true cache miss (first use, or a registry version-key mismatch after e.g. an adapter pin bump) or `forceRefresh: true` (the picker's refresh button); the 60-second negative cache, single-flight, cross-restart persistence, empty-success-never-cached, and stale last-good fallback (+ `warning`) semantics are unchanged. Version 6.1 is an **additive** minor bump over 6.0: it adds **centralized PR monitoring** ([intent-hq/intentd#989](https://github.com/intent-hq/intentd/pull/989)) — the `prMonitor.list` / `prMonitor.cancel` / `prMonitor.flush` router methods (§5.42; the FE read/cancel/flush surface over the agent-owned monitors), the `prMonitor:*` event category (§6.5: `registered` / `changed` / `emitted` / `completed` / `cancelled`), the additive `requirements` merge-requirements checklist on the MCP `ws.pr.snapshot` result (§5.7), the agent-side MCP bindings `ws.pr.monitor` / `ws.pr.unmonitor` / `ws.pr.monitors` (§5.42 — registration deliberately stays MCP-only per the §6.8 principle, like `ws.hook.schedule`), the `[prMonitor]` settings (`prMonitor.debounceSeconds` / `prMonitor.pollSeconds`, §5.12), and the `agentFeatures.prMonitor` toggle (§5.12) — 270 router methods, 307 total. Within 6.1 (additive field on the opaque `hook_wake` `messageMetadata` payload, presence-detected per the convention below; no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1027](https://github.com/intent-hq/intentd/pull/1027)): hook **dispatch wakes** carry `hookStillActive` (§5.40) — present only on `reason: "dispatched"` wakes (`true` for a re-armed perpetual dispatch that keeps running on its cadence, `false` for a retiring one: a one-shot fire, or a perpetual fire landing at/after `expiresAt`), absent on `evicted` / `expired` / `cancelled` wakes — so consumers can tell the two dispatch outcomes apart without parsing the note text; the two dispatched-wake state notes are also shortened (retiring: `[This hook is now retired and will not run again — reschedule via ws.hook.schedule if still needed.]`; re-armed perpetual: `[This hook remains active until <expiresAt> — cancel via ws.hook.cancel when no longer needed.]`), with the evicted/expired/cancelled note wording unchanged. Version 6.2 is an **additive** minor bump over 6.1: it unifies the external-wait classification, extending the v3.1 hook-waiting idle-visibility/deferral machinery to PR monitors ([intent-hq/intentd#1002](https://github.com/intent-hq/intentd/pull/1002), [intent-hq/intentd#1007](https://github.com/intent-hq/intentd/pull/1007)). Within 6.2 (additive response fields, presence-detected per the convention below): `waitingOnPrMonitors?: [{ monitorId, repo, prNumber, title? }]` — light metadata for the agent's ACTIVE PR monitors (§5.42), **omitted when empty** — on the `agent:idle` event payload (§6.5), the `AgentLite` projection served by `agent.list`/`agent.get` (§5.5), and `agent.diagnostics` agent rows (also §5.5), mirroring `waitingOnHooks` exactly so a parent or client can tell a PR-monitor-waiting idle agent from a stalled one. Completion-watch and `after_all` **settlement additionally defers** on such an idle (the pr-monitor-waiting deferral, §Completion-watch persistence): an `agent:idle` while the child still owns active PR monitors is not its completion — watches stay armed and groups stay open until the child settles for real. Unlike hook-waiting, PR monitors carry **no TTL** (§5.42), so this deferral is unbounded in principle rather than time-bounded; it resolves instead via one of the monitor's own **terminal transitions** — the monitor completing (PR merged/closed), the owner's own `ws.pr.unmonitor`, an external (FE) `prMonitor.cancel`, or owner-gone daemon-restart rehydration reconciliation — each of which re-runs the deferred-completion redelivery as a backstop even when that transition delivers no wake of its own. `agent:failed` / `agent:deleted` and the attention/report immediate wakes are never deferred, matching the hook-waiting precedent. Also within 6.2 (additive optional request param, presence-detected per the convention below; no method-catalog change and no new capability to gate, so no version bump — [intent-hq/intentd#1012](https://github.com/intent-hq/intentd/pull/1012)): **daemon-side quick-action model resolution** for `agent.completeOnce` (§5.32) — the optional `type` hint (`commit` / `pr` / `review` / `fast`; free-form, never validated) keys `quickActions.typeOverrides` in a daemon-owned chain (explicit `model` → `quickActions.typeOverrides[type]` → `quickActions.defaultModel` → provider CLI default, provider-guarded with every drop falling through on a warn log). Omitting `type` reproduces the pre-#1012 request byte-for-byte, and an older daemon that ignores it still serves the completion on its own default, so the param needs no client-side gate — clients that care whether the settings were honored read the model off the completion result path as before. Also within 6.2 (additive error code and settings-catalog entry; no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1013](https://github.com/intent-hq/intentd/pull/1013), [monorepo#1745](https://github.com/intent-hq/monorepo/issues/1745)): the **outstanding-RPC cap** — one daemon-wide limiter shared by the UDS and WSS listeners bounds the detached-spawn slow paths (`host.*`, `browser.*`, and the router dispatcher), sized by the new `server.maxOutstandingRpcs` setting (§5.12; number, default 256, `0` = unlimited, range 0..=100000, TOML-backed under `[server]`, read at boot so a change requires a daemon restart). At the cap an id-bearing request is rejected immediately with the new `-32011` "Server overloaded" error (§9) echoing its id instead of being queued, and a notification-shaped frame is dropped without a response; envelope validation runs before a permit is claimed, so `-32700`/`-32600` frames are answered inline exactly as before under load, and the inline fast paths are never gated. Also within 6.2 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036), [monorepo#1814](https://github.com/intent-hq/monorepo/issues/1814)): **active PR monitors fold into the workspace `displayStatus` running promotion** (§5.1 step 3, mirroring the intentd#856 active-hook fold) — an idle agent still watching a PR via `ws.pr.monitor` reads as `in_progress` — and every monitor lifecycle transition that can move the derivation recomputes-and-compares `workspace:displayStatus-changed` (§6.5): register (including the idempotent re-arm), the owner (`ws.pr.unmonitor`) and FE (`prMonitor.cancel`) cancels, the poll loop's terminal completion (PR merged/closed), and the boot-rehydration owner-gone cancels. Also within 6.2 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1041](https://github.com/intent-hq/intentd/pull/1041)): `UsageTotals` (§5.36) gains the optional `thoughtTokens` counter — camelCase `u64`, **omitted when zero/absent** (never `0`, never `null`), following the §5.23 `TokenUsageTotals.thoughtTokens` precedent — present on `totals` and every `byModel` / `byProvider` / `byHourOfDay` / `byMonth` cell, persisted in the hourly buckets via the additive defaulted migration `0087_usage_stats_thought_tokens.sql` (pre-migration buckets read back as zero and keep omitting the field), and counted by the `byModel` / `byProvider` "total tokens" ranking, which now sums all five counters ([monorepo#1635](https://github.com/intent-hq/monorepo/issues/1635)). Also within 6.2 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1039](https://github.com/intent-hq/intentd/pull/1039), [monorepo#1597](https://github.com/intent-hq/monorepo/issues/1597)): the `AgentLite` `lastMessageId?` field (§5.5) — the id of the session's newest **user/assistant** transcript message (system rows transparent, omitted when absent), denormalized at message-write time alongside the v2.x-era `lastMessageRole` and served on `agent.list` / `agent.get`; deliberately **no live-turn overlay** (unlike `lastMessageRole`), it is the structured signal behind the client-side per-agent **unread** derivation against the v4.5 `metadata.lastSeenMessageId` seen marker — equality semantics, absent marker counts as unread; see the §5.5 `agent.list` entry for the full contract. Also within 6.2 — and the change that carries the daemon's `6.2` protocol-constant bump ([intent-hq/intentd#1040](https://github.com/intent-hq/intentd/pull/1040)) — the method catalog gains the `github.branches.listCached` router method (§5.27): the **read-only, no-network** branch listing served from the daemon's local repo cache (`.repo-cache/<owner>/<repo>`) — `{ cached, branches, defaultBranch? }` (`defaultBranch` omitted when unresolvable), with a cold cache or foreign-origin repo folding gracefully to `{ cached: false, branches: [] }` (never an error; invalid `owner`/`repo` path segments → `-32602`) — consumed cached-first by the FE branch picker ([intent-hq/cloudlands-fe#860](https://github.com/intent-hq/cloudlands-fe/pull/860)) — 271 router methods, 308 total. Also within 6.2 (additive response fields, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1044](https://github.com/intent-hq/intentd/pull/1044), [monorepo#1662](https://github.com/intent-hq/monorepo/issues/1662)): the **`pi` CLI verdict fields** on the `host.providerDiscovery` pi row (§5 fast-path notes) — the daemon probes the real `pi` CLI (the binary the pinned pi-acp adapter spawns) once per discovery call and folds the verdict into the pi row: always-present `cliCommand` / `cliResolved` / `cliVersionOk` / `cliRequirement` plus `cliResolvedPath?` / `cliVersion?` when known; a **missing** or **confirmed-too-old** CLI (< 0.80.4) marks the row unavailable (never via `gatedOff`) — `installed` forced to `false` plus an actionable `unavailableReason` naming the found version, the requirement, and the adapter pin — while an **inconclusive** probe is permissive (WARN log, never gated), and the same gate fails Pi agent creation fast with a clear error instead of a silent hang. Version 6.3 is an **additive** minor bump over 6.2: it adds the `debug.sampleStacks` router method (§5.43; [monorepo#1755](https://github.com/intent-hq/monorepo/issues/1755)) — a point-in-time sample of the daemon's own thread stacks, captured in-process over a short clamped window and returned as a rendered human-readable text report, backing the FE Help menu's "Sample intentd Process" flow — 272 router methods, 309 total. Version 6.4 is an **additive** minor bump over 6.3: it adds the `host.checkNode` and `host.checkGh` fast-path methods (§5 fast-path catalog; [monorepo#1891](https://github.com/intent-hq/monorepo/issues/1891), [intent-hq/intentd#1064](https://github.com/intent-hq/intentd/pull/1064)) — **uncached** node/gh detection mirroring `host.checkGit`: resolver + `--version` probe on a blocking thread, `{ available, version?, path? }` result (`version`/`path` omitted when unresolved), with no cache anywhere on the path so a fresh install is seen immediately — consumed by the FE setup checks in place of its former process-lifetime binary caching ([intent-hq/cloudlands-fe#979](https://github.com/intent-hq/cloudlands-fe/pull/979)) — 272 router methods, 311 total. Also within 6.4 (agent-facing MCP surface only — no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1063](https://github.com/intent-hq/intentd/pull/1063)): `ws.app.question.ask` is **top-level-only** (§7) — a sub-agent (session with `parent_agent_id` set OR `is_background` true, including background hooks owned by such a session) has the `ws.app.question.*` docs pruned from its tool description and the namespace omitted from its JS prelude, and a dispatch attempt is denied with a redirect error naming `ws.agent.requestDiscussion` / `ws.agent.reportToParent`; top-level agents with `agentFeatures.structuredQuestions` enabled are byte-identical to the pre-gate surface. Also within 6.4 (additive `error.data` on an existing failure; no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1065](https://github.com/intent-hq/intentd/pull/1065), [monorepo#1822](https://github.com/intent-hq/monorepo/issues/1822)): the `pairing.getInfo` **listener-down** failure (§5 fast-path catalog) carries the machine-readable discriminator `error.data = { "code": "listener-down" }` on the otherwise-unchanged `-32603` envelope (same human message), so clients (the `intentd pair` auto-enable flow) match `error.data.code` first and keep the message-prose match only as a fallback for older daemons. Also within 6.4 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067), [monorepo#1828](https://github.com/intent-hq/monorepo/issues/1828)): the `workspace.archive` sweep now also **cancels the workspace's ACTIVE PR monitors** (§5.1 archive active-work teardown; §5.42) — the counterpart to the v4.2 hook sweep: state persisted to `cancelled`, `prMonitor:cancelled` emitted, owner woken with an archive-specific notice that parks behind the archived gate, terminal monitors untouched, unarchive never resurrects, fail-soft per monitor — and the sweep's per-cancel transition-only `displayStatus` recompute demotes the rollup so an archived workspace no longer reads `in_progress` off a stale active-monitor signal. Also within 6.4 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1072](https://github.com/intent-hq/intentd/pull/1072)): the `github.branches.listCached` **ls-remote fallback** (§5.27) — a cold cache or foreign-origin repo now falls back to a single `git ls-remote --symref` against the GitHub remote (token offered via env like the clone pipeline, never argv) instead of returning the bare miss, and the response gains the optional `source?: "cache" | "ls-remote"` discriminator — `"cache"` on a warm-cache hit, `"ls-remote"` on a successful fallback, omitted on a failed fallback (offline, missing repo, no access), which keeps the graceful `{ cached: false, branches: [] }` shape (never an error). Also within 6.4 (additive optional request param; no method-catalog or response-shape change, so no version bump — [intent-hq/intentd#1081](https://github.com/intent-hq/intentd/pull/1081)): the optional `prefix?` param on `github.branches.list` (§5.27) — a non-blank prefix switches the read to the git refs API (`GET /git/matching-refs/heads/{prefix}`) with the `(limit, nextToken)` window applied client-side (GitHub ignores pagination on that endpoint), while an absent or blank prefix reproduces the pre-#1081 unfiltered listing byte-for-byte; an older daemon that ignores the param still serves the unfiltered listing, so the param needs no client-side gate. Version 6.5 is an **additive** minor bump over 6.4: it adds the `file.placeAttachment` router method (§5.9; [monorepo#1948](https://github.com/intent-hq/monorepo/issues/1948)) — daemon-mediated placement of a chat attachment into the workspace's git-ignored `.intent/attachments/` directory with collision-safe naming, accepting exactly one of a base64 `data` payload or a same-host absolute `sourcePath` to copy, and returning the workspace-relative `{ ok, path, fileName, size }` so clients hand agents a readable path instead of rejecting oversized uploads — 273 router methods, 312 total. Also within 6.5 (additive response fields plus structured `error.data` on an existing failure, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1095](https://github.com/intent-hq/intentd/pull/1095), [monorepo#1739](https://github.com/intent-hq/monorepo/issues/1739)): the **gitlink-aware git surface** (§5.6) — submodule (gitlink) entries in `git.status` / `git.changes` `FileStatus` rows carry the additive gitlink metadata `mode: "160000"` / `oldSha?` / `newSha?` (all three omitted on regular file entries, so pre-#1739 clients see the previous shape byte-for-byte); `git.diffs` renders a submodule pin change as the same one-line `Subproject commit <sha>` pseudo-hunk `git diff` prints (synthesized daemon-side from the pin SHAs, on both the staged and unstaged paths) and `git.branchDiff` yields the matching `Subproject commit <sha>\n` pseudo-content on a gitlink side instead of failing the call; and a `git.showFile` path resolving to a non-blob tree entry (a `160000` gitlink or a `040000` tree) is now `-32602` with machine-readable `error.data = { code: "not-a-file", path, mode }` (§9) — superseding the pre-#1739 behavior of silently returning `{ content: "" }` for tree entries and an opaque internal error for gitlinks. Version 6.6 is an **additive** minor bump over 6.5: it adds the `workspace.transfer.plan` router method (§5.1; [intent-hq/intentd#1092](https://github.com/intent-hq/intentd/pull/1092)) — the read-only transfer preview for the Transfer/Download feature: `{ plan: TransferPlan }` where the plan carries the versioned export manifest (`formatVersion` — `TRANSFER_FORMAT_VERSION`, currently 1 — plus `creatingIntentdVersion`, per-table row stats with the `event` table deliberately excluded, the asset list with sizes, and the git summary: branch, dirty files, live sandbox branches), the size estimate (`totalSizeBytes = dbRowBytes + assetBytes + estimatedGitBundleBytes`, the bundle estimated via `git rev-list --disk-usage`), and non-blocking pre-flight `warnings` (`{ code, message }` — e.g. agents running, uncommitted changes, unmerged sandboxes); read-only (no side effects), and the virtual Chief workspace is rejected — 274 router methods, 313 total. Version 6.7 is an **additive** minor bump over 6.6: it adds the **delete grace window** for workspaces and agents (§5.1 / §5.5; [intent-hq/intentd#1096](https://github.com/intent-hq/intentd/pull/1096)) — the optional `undoDelayMs` param on `workspace.delete` and `agent.delete` (a non-negative integer; `> 0` schedules an **in-memory** pending deletion instead of committing, returning `{ success: true, scheduled: true, deleteAt }` with the ISO commit deadline; absent, `null`, or `0` keeps the immediate-delete behavior byte-identical, and a non-integer is `-32602`), the `workspace.cancelDelete` / `agent.cancelDelete` router methods (`{ cancelled: boolean }` — `false` is the race-safe non-error for an already-committed or never-scheduled deletion, and a stale or cross-workspace-scoped `agent.cancelDelete` is rejected before touching the registry), the self-sufficient `workspace:delete-scheduled` / `workspace:delete-cancelled` (`{ workspaceId, deleteAt }` / `{ workspaceId }`) and `agent:delete-scheduled` / `agent:delete-cancelled` (`{ agentId, workspaceId, deleteAt }` / `{ agentId, workspaceId }`) events (§6.5), and the optional presence-detected `pendingDeleteAt?` field (ISO deadline; omitted — never `null` — when no deletion is pending) on `Workspace` rows (`workspace.list` / `workspace.get`) and the `AgentLite` / `AgentSession` projections (§5.5). Pending deletions are never persisted — a daemon restart drops them and the rows survive; re-scheduling the same key is idempotent under the registry lock (the existing deadline is returned, no second timer); scheduling an agent delete does NOT stop the agent (the deadline commit does); and a workspace delete — immediate or committed-from-pending — supersedes pending agent deletes inside it — 276 router methods, 315 total. Version 6.8 is an **additive** minor bump over 6.7: it adds the `task.setRelations` router method (§5.4; [intent-hq/intentd#1100](https://github.com/intent-hq/intentd/pull/1100), monorepo#1974) — writes the first-class `dependsOn` (hard ordering edges, cycle-checked with the cycle path named in the rejection) / `conflictsWith` (advisory) task relations on `TaskMetadata` (replace semantics: omitted param → kept, `[]` → cleared; echoed normalized — deduped, first-seen order; emits `note:updated`), which `task.getMyTask` / `task.list` / `task.get` / `note.listTasks` project together with the computed `unmetDependsOn` (dependency ids whose task note is not `complete`; missing and cancelled deps count as unmet) — all presence-detected, omitted when empty; `task.markAsTask` accepts the same optional `dependsOn?` / `conflictsWith?` params under identical validation (omitted params leave an existing task's relations untouched) — 277 router methods, 316 total. Within 6.8 (additive optional request params + a new batch result shape on an existing method, presence-detected per the convention below; no method-catalog change, so no version bump): the **batch `agent.delegate` form** (§5.5) — the optional `tasks: [taskNoteId]` + `greedy?: bool` (default false) params switch `agent.delegate` to an idempotent batch start: every listed task is classified (`started` / `held:blocked-on-deps` / `held:conflict` / `skipped` / `error`) as a pure, stateless function of current state, only the eligible subset is delegated (through the unchanged single-task path), and the result enumerates every task with its disposition + reason plus the `unlockPlan` projected from the dependency graph; single-task calls (`tasks` absent) are byte-identical to the pre-batch contract, and the single-task-only params `agentInstructions` / `force` are rejected when combined with `tasks`. Also within 6.8 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [monorepo#1979](https://github.com/intent-hq/monorepo/issues/1979)): **`unmetDependsOn` on note-shaped payloads** (§5.2) — a task note with `dependsOn` edges carries the computed `metadata.task.unmetDependsOn` (same rule as the task.list projection: a dep is unmet unless its task note is `complete`; missing and cancelled deps count as unmet) on `note.get` / `note.list` reads, `note`/`task` subscription snapshots and deltas (§6), and cross-workspace note reads; the field is computed at read/push time (never persisted into `task_json`) and omitted when empty, so dep-less tasks and plain notes are byte-identical to the pre-#1979 shape. A dependency's task-status transition additionally re-announces each dependent task note via `note:updated` (§6.5) after the `task:status-changed` + `task:ready-tasks-changed` pair, so note-channel subscribers refetch the moved projection. Also within 6.8 (additive response field + admission-order behavior on the batch form, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1112](https://github.com/intent-hq/intentd/pull/1112)): **effort-weighted greedy-off admission** (§5.5) — under `greedy: false` (the default) startable tasks are admitted in effort-weighted critical-path priority order rather than list order (free-form task `estimatedEffort` strings are parsed best-effort — units min/h/d with a day = 8 work-hours, ranges → midpoint, unparseable/missing → a neutral 30-minute default, parsed values clamped to a 175,200-minute cap; ties break by most distinct dependents unlocked, then shortest own effort, then task id — fully deterministic), and `unlockPlan` gains the optional `criticalPathMinutes` field — the longest effort-weighted `dependsOn` chain through the requested tasks and their downstream dependents, present only when the chain attaining the reported max carries at least one parsed estimate (a number that would be pure 30-minute defaults is suppressed, even when an unrelated requested subtree is estimated) and echoed into `unlockPlan.message` as "~N min of serial work remains on the critical path"; deliberately downstream-only — an incomplete upstream dependency outside the requested set is not counted, so partial batches can understate total remaining serial time. Also within 6.8 (additive `triggeredBy` payload variant plus two new emission points on an existing event; no method-catalog or event-catalog change, so no version bump — [monorepo#1981](https://github.com/intent-hq/monorepo/issues/1981)): **ready-set recompute on relation writes and dep deletion** — `task:ready-tasks-changed` (§6.5) is now also emitted when a `task.setRelations` write actually **changes** the task's `dependsOn` list (right after the write's `note:updated`; a no-op or conflictsWith-only write emits no recompute) and when `note.delete` removes a task note that other tasks `dependsOn` (right after `note:deleted`; the dangling edge counts as unmet, so deleting a previously-`complete` dep drops its dependents out of `readyTaskIds` — deleting a task note nobody depends on emits no recompute). These non-status triggers carry the additive `triggeredBy` variant `{ noteId, reason: "relations-changed" | "note-deleted" }` — no status fields — while status-change emissions keep the existing `{ noteId, previousStatus, newStatus }` shape byte-for-byte, so consumers discriminate on the presence of `reason`. Also within 6.8 (behavior only — new emission points on the existing event and trigger shape, no method-catalog or event-catalog change, so no version bump — [intent-hq/intentd#1121](https://github.com/intent-hq/intentd/pull/1121), [monorepo#2006](https://github.com/intent-hq/monorepo/issues/2006)): **ready-set recompute on any set-moving task-note delete** — `note.delete` now emits `task:ready-tasks-changed` (reason: `note-deleted`) whenever deleting a task note actually **moves** the ready set, not just when other tasks `dependsOn` it: deleting a task that was itself ready drops its id from `readyTaskIds`, and deleting the last incomplete task child of a parent readies the parent under the tree rule. The pre-delete and post-delete ready sets are compared, so a delete that provably cannot move the set (e.g. a terminal task nobody depends on) still emits no recompute — superseding the #1981 "deleting a task note nobody depends on emits no recompute" carve-out — while deleting a task note that other tasks `dependsOn` keeps the #1981 always-emit contract (the dangling edge counts as unmet). Version 6.9 is an **additive** minor bump over 6.8: it adds the staged workspace-import surface `workspace.import.begin` / `.chunk` / `.commit` / `.abort` (§5.1; [intent-hq/intentd#1101](https://github.com/intent-hq/intentd/pull/1101)) — target-side chunked, idempotent upload of a workspace-transfer zip archive (the §5.1 `workspace.transfer.plan` counterpart) with an atomic checksum-verified commit: `begin` validates the manifest header (format version, exact creating-intentd-version match, id collision) and opens a staged session returning `{ importId, maxChunkBytes }`; `chunk` stages seq-numbered base64 slices (per-seq retry is idempotent, any-order arrival); `commit` reassembles, SHA-256-verifies, unzips, and imports atomically (rows in one transaction, then assets, git materialization, and boot-style rehydration); `abort` cleans up the staging directory — nothing is visible in `workspace.list` until commit succeeds — 281 router methods, 320 total. Version 6.10 is an **additive** minor bump over 6.9: it adds the `repo.warmCache` router method (§5.11; [intent-hq/intentd#1105](https://github.com/intent-hq/intentd/pull/1105)) — opportunistic background refresh of the daemon-managed repo cache (`.repo-cache/<owner>/<repo>`) for one GitHub repo: `{ githubUrl }` (required; no `workspaceId`) returns `{ started: true, owner, repo }` immediately while the fetch runs detached with **no events** (no `git:clone:*` frames); at most one opportunistic warm runs daemon-wide (global single-flight, never queued) — a second call while one is in flight is rejected with `-32603` (`"repo cache warm already in flight for <owner>/<repo>"`) carrying machine-readable `error.data = { code: "warm-in-flight", owner, repo }`, a `githubUrl` with no owner/repo pair (or an invalid path segment) is `-32602` and never claims the slot, and `workspace.create` is never blocked by a warm — its cache ensure simply serializes behind an in-flight warm for the same repo on the per-repo cache lock — 282 router methods, 321 total. Version 6.11 is an **additive** minor bump over 6.10: it adds the source-side workspace-export surface `workspace.export.start` / `.read` / `.finalize` / `.abort` (§5.1; [intent-hq/intentd#1118](https://github.com/intent-hq/intentd/pull/1118)) — the source half of the FE-mediated workspace transfer (the counterpart of the v6.9 `workspace.import.*` surface; there is no daemon-to-daemon connection — the FE relays chunks) — and the `workspace:transfer:progress` / `workspace:transfer:ready` / `workspace:transfer:failed` events (§6.5). `start` stops the workspace's agents (in-flight agents captured as pending `interrupted_agent` rows that ride the archive as the target's resumption offers), kicks off the background zip-archive build under `<workspaces_root>/.export-staging/<exportId>/`, and returns `{ exportId, maxChunkBytes }` immediately — progress and outcome travel on the transfer events (`:ready` carries the manifest plus `archiveSizeBytes` / `archiveSha256` / `maxChunkBytes` / `totalChunks`, everything the FE hands to `workspace.import.begin` on the target); `read` serves the sealed archive in seq-numbered base64 chunks, idempotently and in any order; `finalize` settles the source after a successful relay (optional final status message + `archiveSource` archive, then WIP-snapshot unwind and staging cleanup); `abort` cancels and cleans up, leaving the workspace usable (agents stay stopped). Export sessions are in-memory only — a daemon restart drops them and the boot/lazy sweep clears orphaned staging dirs — 286 router methods, 325 total. Within 6.11 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump): the single-task `agent.delegate` result carries `provider?` (§5.5) — the resolved ACP provider persisted on the created session (the same value `AgentLite.provider` serves), so clients can render the correct provider affordance immediately, before the agent session loads; omitted — never `null` — when the session has no persisted provider (the spawn path's own last resort applies). The batch form's `started` rows are unchanged. Also within 6.11 (additive response fields, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1128](https://github.com/intent-hq/intentd/pull/1128), [intent-hq/intentd#1130](https://github.com/intent-hq/intentd/pull/1130), [intent-hq/intentd#1133](https://github.com/intent-hq/intentd/pull/1133), [monorepo#2018](https://github.com/intent-hq/monorepo/issues/2018)): **inline `@@@task` relations** — the `@@@task` fence line accepts the optional header attributes `key=<token>` / `dependsOn=<a,b>` / `conflictsWith=<c>` / `effort=<token>` (bare tokens, comma-separated lists, whitespace-tolerant), with `dependsOn`/`conflictsWith` references resolved sibling `key=`s → exact sibling titles → existing task-note ids and written through the `task.setRelations` validator, under **convert-with-warnings** semantics (blocks always convert; bad attributes/references/edges are skipped, each adding one `warnings` entry); the `task.convertBlocks` result (§5.4) and every auto-converting note-write result (§5.2) gain the always-present `createdTasks` (`[{ key?, title, noteId }]`, block order) and `warnings` (string[]) arrays — `#[serde(default)]`-backed, so decoders tolerate their absence from older daemons, while new responses always serialize them (empty when nothing applies). Version 6.12 is an **additive** minor bump over 6.11: it adds the **attachment registry** (§5.9) — `file.placeAttachment` gains the optional `mimeType?` param and registers every placement in the daemon's `attachments` table under a daemon-minted UUID, additively returning `{ attachmentId, mimeType?, uploadedAt }` alongside the existing `{ ok, path, fileName, size }` (presence-detected; old clients unaffected); the new `file.getAttachmentInfo` router method serves the registry row as `{ attachmentId, fileName, mimeType?, size, uploadedAt, path, exists }` (`exists` reflects the file on disk at read time; unknown id → -32602); the message **file blocks** (`fileBlocks` on `agent.sendMessage` / `agent.queueMessage` / `agent.editAndRegenerate`, `agent.create`'s session field, and the `workspace.create` initial-agent flow) gain the **attachment-reference variant** `{ type: "file", attachmentId, fileName, mimeType?, size? }` — exactly one of `data` / `attachmentId` per entry, both-or-neither is `-32602` before any side effect (§5.5); prompt assembly renders a reference block as a text attachment notice directing the model to the new MCP `ws.file.getAttachment(attachmentId, destDir?)` binding (§6.8), which copies the registered file from the canonical store into the calling agent's own working directory (sandbox clone for CoW-sandboxed callers) and keeps the two failure modes distinct (unknown id vs. file deleted from disk — the latter names `fileName` + `uploadedAt` and instructs the model to continue without the file) — 287 router methods, 326 total. Also within 6.12 (additive manifest/plan fields on existing methods, presence-detected per the convention below; no method-catalog change, so no version bump): **attachments ride the workspace transfer** (§5.1) — the `workspace.transfer.plan` manifest gains the `attachments: [{ id, fileName, sizeBytes, exists }]` list and the plan gains the `attachmentBytes` addend (`totalSizeBytes` now sums it), the export archive carries `attachments/<attachmentId>` file entries for the registry rows whose stored file still exists (the `.intent/attachments/` store is git-ignored and never rides the git bundle, so the archive carries the files explicitly; a file missing at plan or write time is skipped, never an export failure), and `workspace.import.commit` materializes them into the target checkout's canonical store (containment-guarded, all-or-nothing with rollback) before the row insert — a registry row without a file entry is the deleted-is-deleted state and imports as a row without a file. Also within 6.12 (behavior plus an additive key on the opaque `event_notification` `messageMetadata` payload, presence-detected per the convention below; no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1138](https://github.com/intent-hq/intentd/pull/1138), [intent-hq/intentd#1144](https://github.com/intent-hq/intentd/pull/1144), [monorepo#2044](https://github.com/intent-hq/monorepo/issues/2044)): **delivery-time "tasks now unblocked" hints** (§Delivery-time "tasks now unblocked" hints) — completion wakes to a delegator (ungrouped watch wakes, the `after_all` aggregated wake, the immediate `agent.reportToParent` wake) stamp the settled children's task-note ids on the wake metadata as `unblockedTriggerTasks` (`[{ workspaceId, taskNoteId }]`) at enqueue, and the delivering render appends ONE coalesced advisory section — `Tasks now unblocked by this completion: [Title](intent://local/task/{id}) (deps satisfied | conflict cleared)` — computed fresh against the CURRENT task snapshot at delivery time (never a stale enqueue-time enumeration), with attention-status tasks annotated inline rather than dropped; strictly advisory (no auto-starts, no status writes) and fail-open (empty delta or snapshot failure appends nothing). Version 6.13 is an **additive** minor bump over 6.12: it adds the `childProcesses` / `childMemoryBytes` / `childMemoryPeakBytes` result fields to `system.status` (§5.7) — `childProcesses` is the count of OS processes in the daemon's descendant tree (agent provider CLIs and everything they spawn — ACP adapters, MCP bridges, an agent's own tool children — the Unsloth server, and `host.exec` children); `childMemoryBytes` is the aggregate resident memory of those processes, which is the daemon's real cost to the machine (the existing `memoryBytes` covers only the daemon binary and understates it by more than an order of magnitude once agents are live — measured on a dev seat, a 183 MB daemon owning a 21.5 GB tree); and `childMemoryPeakBytes` is the high-water mark of `childMemoryBytes` since daemon start, carried separately because ephemeral quick-action and model-probe adapter chains live only seconds, so by the time a debug bundle is captured the instantaneous value has drained back to baseline. All three are `null` until the first sample lands (~5s after daemon start), never `0`. No method-catalog change — 287 router methods, 326 total. Version 6.14 is an **additive** minor bump over 6.13: it adds the `adapter-busy` error shape to `agent.completeOnce` (§5.32) — [intent-hq/intentd#1146](https://github.com/intent-hq/intentd/pull/1146), [monorepo#2062](https://github.com/intent-hq/monorepo/issues/2062). The daemon now bounds concurrently live **ephemeral ACP adapters** — the one-shot completions and model probes that spawn a provider-CLI chain without holding an agent slot — with a daemon-wide cap (`agents.maxConcurrentAdapters`, §5.12; default `6`, range 1–64, no unlimited value, read at boot so a change applies on daemon restart). An over-limit call **queues** instead of spawning and waits at most its own `timeoutMs`; a call whose budget expires while queued is rejected with `-32603` carrying **object-shaped** `error.data = { code: "adapter-busy", provider, waitedMs, limit }` and the human message `no free adapter slot for <providerId> after <n>ms (agents.maxConcurrentAdapters = <limit>)`. The object shape is the contract change worth reading twice: every other `-32603` on this method carries a bare **string** `data`, so a client that treats `data` as a string must presence-check `data.code` first. Nothing is spawned and no model is asked when this error is returned, so a retry is always safe; the other visible effect under the cap is a `models.list` refresh whose probe cannot get a slot falling back to the static model list. No method-catalog change — 287 router methods, 326 total. Also within 6.14 (behavior only on an existing optional response field — no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1160](https://github.com/intent-hq/intentd/pull/1160), [monorepo#2128](https://github.com/intent-hq/monorepo/issues/2128)): the batch `agent.delegate` `unlockPlan.criticalPathMinutes` emission condition (§5.5) is relaxed for mixed-estimate graphs — the reported number is now the max over requested tasks whose max-attaining chain carries at least one parsed estimate, so a longer chain of pure 30-min defaults no longer suppresses an estimated chain's minutes (the number reflects only estimated chains and can understate when an unestimated chain is longer); pure-defaults-only graphs still omit the field. Also within 6.14 (additive response fields, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1162](https://github.com/intent-hq/intentd/pull/1162), [monorepo#2129](https://github.com/intent-hq/monorepo/issues/2129)): the `note.create` result (§5.2) gains the `@@@task` auto-conversion outcome for the note's initial content — `convertedCount`, `createdTaskNoteIds`, `createdTasks`, `warnings`, same shapes and always-present semantics as the four content-write results — additive over the old `{ note }` shape (clients reading `.note` are unaffected), with `note` remaining the refetched post-conversion row; the MCP `ws.note.create` binding result appends the same four fields, and an idempotency replay of a key recorded before the fields existed decodes the stored bare note as a zeroed conversion outcome. Also within 6.14 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1167](https://github.com/intent-hq/intentd/pull/1167), [monorepo#2107](https://github.com/intent-hq/monorepo/issues/2107)): the **child-tree burst sampling cadence** (§5.7) — while an ephemeral ACP adapter chain holds a slot in the daemon-wide adapter bound (`agents.maxConcurrentAdapters` above), the descendant-tree sampler sweeps every **500 ms** instead of the 5 s baseline, so `childMemoryPeakBytes` is now the high-water mark of the **sampled** tree memory and can legitimately exceed every value `childProcesses` / `childMemoryBytes` (still published at the 5 s cadence) ever report — superseding the v6.13 description of the peak as simply "the high-water mark of `childMemoryBytes` since daemon start". The fast cadence covers only descendants spawned through the adapter bound — the one-shot ACP runner and the model probe; everything else in the tree stays baseline-sampled (see §5.7 for the full coverage list). Also within 6.14 (additive key on the opaque `event_notification` `messageMetadata` payload, presence-detected per the convention below; no method-catalog or wire-shape change, so no version bump — [monorepo#2060](https://github.com/intent-hq/monorepo/issues/2060)): agent-watch wakes carry **`watchStillArmed`** (§Completion-watch persistence) — the machine-readable twin of the wake text's watch-state notes (monorepo#2051) and the counterpart of the hook wakes' `hookStillActive` (v6.1): `false` on the ungrouped deliver-once completion wake (the watch was just retired), `true` on the immediate grouped-failure wake and the attention fan-out wakes (the watch remains armed); absent on non-watch wakes (the direct parent attention wake, the `after_all` aggregated group wake, subscription batches). Version 6.15 is an **additive** minor bump over 6.14: it adds **multi git root tracking** (§5.6; [monorepo#2053](https://github.com/intent-hq/monorepo/issues/2053)) — the `gitRoot.list` router method (the workspace's registered secondary git roots as `{ gitRoots: [...] }`, each row the persisted `WorkspaceGitRoot` plus a live-read `branch?`), the optional `gitRootId?` param on six git reads — `git.status`, `git.changes`, `git.diffs` (alias `git.diff`), `git.commits` (alias `git.log`), `git.showFile`, and `git.branchStatus` (where `workspaceId` + `gitRootId` may stand in for the required `repoPath`; `repoPath` wins when both are supplied, keeping existing callers byte-identical) — scoping the read to a registered root: an unknown id **and** a root belonging to another workspace are both `-32602` with the identical message (`Unknown git root: <id>`), so foreign roots are not probeable, and an empty/whitespace-only `gitRootId` reads as absent (primary-worktree behavior). It also adds the `gitRoot:registered` / `gitRoot:updated` / `gitRoot:unregistered` event family (§6.5) and the MCP-only registration surface `ws.git.registerRoot` / `ws.git.unregisterRoot` / `ws.git.listRoots` (§5.6 — registration deliberately stays MCP-only per the §6.8 principle: secondary roots are agent-registered working state, so the FE reads via `gitRoot.list` and subscribes to `gitRoot:*` but never registers). The daemon additionally auto-detects the worktree's initialized git submodules as `source: "auto"` roots, auto-prunes roots whose path no longer exists on disk, and runs the same background PR discovery on each root as on the primary workspace root (the `WorkspaceGitRoot` PR fields mirror the `Workspace` PR fields) — 288 router methods, 327 total. Version 6.16 is an **additive** minor bump over 6.15: it adds the staged chunked attachment upload surface `file.attachmentUpload.begin` / `.chunk` / `.commit` / `.abort` (§5.9; [intent-hq/monorepo#2262](https://github.com/intent-hq/monorepo/issues/2262)) — the large-payload counterpart of the single-shot `file.placeAttachment`, following the v6.9 `workspace.import.*` staged-session precedent, so attachments larger than one RPC frame can be placed against a remote daemon: `begin` validates the header (existing workspace, a `fileName` that placement's basename sanitization accepts — non-empty, basename not reducing to `.`/`..`/nothing — so a doomed name fails at begin instead of after staging, positive `sizeBytes` within the 1 GiB per-attachment cap, 64-hex `sha256`) and opens an in-memory staging session returning `{ uploadId, maxChunkBytes }` (16 MiB decoded per chunk); `chunk` stages seq-numbered base64 slices (per-seq retry is idempotent — the same seq overwrites the same chunk file and only the new bytes count against the declared total — and chunks may arrive in any order); `commit` requires the staged bytes to equal `sizeBytes` with a gap-free seq range from 0, reassembles, SHA-256-verifies, and places the payload through the same collision-safe placement + attachment-registry path as `file.placeAttachment`, so the commit result is byte-shape-identical to a successful `placeAttachment` result (`{ ok, path, fileName, size, attachmentId, mimeType?, uploadedAt }`); `abort` drops the session and staging directory (idempotent — an unknown id returns `{ uploadId, aborted: false }` instead of erroring). Caller errors are `-32602` naming the specifics and an unknown `uploadId` is `-32602` ("no attachment upload in progress"); sessions are in-memory only — a daemon restart drops them (the client restarts the upload) and orphaned staging dirs under `<workspaces_root>/.attachment-upload-staging/` are swept lazily by the next `begin` — and nothing is visible (no file, no registry row) until commit succeeds — 292 router methods, 331 total. Also within 6.16 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [monorepo#2063](https://github.com/intent-hq/monorepo/issues/2063), [intent-hq/intentd#1201](https://github.com/intent-hq/intentd/pull/1201)): `agent.diagnostics` agent rows (§5.5) gain the optional `subtreeMemoryBytes` field — the resident bytes of the agent's descendant process tree, attributed by nearest registered agent root from the same sampler sweep behind `system.status`'s `childMemoryBytes` (v6.13, §5.7) — **omitted** when the agent has no attributed bytes (not spawned, no sample yet, or no runtime manager attached; absent, never `0`/`null`). Diagnostics-only by design: the field deliberately stays off the hot `agent.list`/`agent.get` list payloads. Also within 6.16 (new WebSocket endpoint, not a JSON-RPC method — no method-catalog change, so no version bump — [intent-hq/intentd#1205](https://github.com/intent-hq/intentd/pull/1205), [monorepo#2323](https://github.com/intent-hq/monorepo/issues/2323)): the **`/tunnel` WebSocket endpoint** (§1.4) — the binary loopback port-forwarding surface on the same WSS listener as `/ws`, sharing the §2.1 bearer-token upgrade gate and the §4 heartbeat/shutdown lifecycle but speaking binary mux frames (`[opcode u8][streamId u32 BE][payload]`; `OPEN`/`OPEN_OK`/`OPEN_ERR`/`DATA`/`EOF`/`CLOSE`) instead of JSON-RPC; connects are restricted to the daemon's own loopback (`127.0.0.1:<port>`). Intended consumer: the Electron FE's `browser.exec` tunnel fallback when a remote-rewritten loopback URL fails its reachability probe (§5.9). Version 6.17 is an **additive** minor bump over 6.16: it adds the daemon-owned orthogonal `waiting` flag on `Workspace` projections (§5.1; [intent-hq/intentd#1207](https://github.com/intent-hq/intentd/pull/1207)) — `true` when the workspace has any ACTIVE background hook (§5.40), ACTIVE PR monitor (§5.42), or waiting agent subscription (an undelivered child completion watch held by a top-level foreground agent, anchored in the parent's home workspace, §Completion-watch persistence) — presence-detected (**omitted when `false`**, never `false`/`null`; clients treat an absent field as not waiting, so older daemons interoperate fail-open), derived on the same `workspace.list` / `workspace.get` / subscription emit path as `displayStatus` (never persisted), and **orthogonal** to `displayStatus` (a workspace can read `complete` or `pr_ready` and still be waiting) — plus the self-sufficient `workspace:waiting-changed` event (§6.5; data `{ workspaceId, waiting }`), emitted **only on an actual transition** against a last-observed per-workspace baseline mirroring `workspace:displayStatus-changed`, and tailed by the global `workspace` subscription channel (§6.9). The same bump carries a **deliberate behavior change**: the three wait signals **no longer fold into the `displayStatus` `in_progress` promotion** (§5.1 step 3) — the intentd#856 active-hook fold, the [intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036) active-PR-monitor fold, and the child-completion-watch fold are unwound, so only a truly running agent promotes to `in_progress` and an idle-but-watching workspace reads its real rollup (`complete`, a PR stage, `idle`) with `waiting: true` alongside — restoring the pre-#856 promotion semantics; the `failed` > `blocked` > `needs_attention` > `in_progress` > PR/task-rollup precedence is otherwise unchanged. No method-catalog change — 292 router methods, 331 total. Also within 6.17 (additive always-serialized response field plus a deliberate membership widening on an existing method; no method-catalog change, so no version bump — [intent-hq/intentd#1214](https://github.com/intent-hq/intentd/pull/1214)): **workspace-wide `task.list` membership + the `specLinked` flag** (§5.4) — `task.list` `tasks` now returns EVERY task note in the workspace (any note with task metadata except the spec itself: direct spec children, subtasks, and unlinked tasks alike; stored note order, deduped by id), retiring both the spec-linked membership filter and the no-links direct-child fallback, and every `WorkspaceTask` row (`task.list` and `task.get`) carries the new always-present `specLinked` boolean — `true` iff the task id appears in the spec note body's `intent://local/task/{id}` links, `false` otherwise (including every row when the spec has no links; not conditioned on `parent_id`) — plus the additive `parentId?` field (presence-detected, omitted when the backing note has no parent), so clients can rebuild the former spec-linked view with a client-side filter and distinguish subtasks from unlinked top-level tasks without a `note.list` read. The `task.list` `stats` aggregate is deliberately UNCHANGED (still the spec-linked `computeTaskStats` rollup — **including its no-links fallback**, which still counts direct spec children while every row reports `specLinked: false`, so `stats` membership must not be correlated with the flag in that case), as are `note.listTasks` and the §6.9 task subscription channel (whose snapshot/deltas send task-filtered wire `Note`s, not `WorkspaceTask` rows; those rows have since gained the same `specLinked` stamp — [intent-hq/intentd#1218](https://github.com/intent-hq/intentd/pull/1218) — and spec-body edits now refresh flipped flags with `updated` rows instead of the former `removedIds: ["spec"]` mapping — [intent-hq/intentd#1224](https://github.com/intent-hq/intentd/pull/1224), fixes [monorepo#2407](https://github.com/intent-hq/monorepo/issues/2407); see §6.9). Also within 6.17 (additive event-payload field on an existing event, presence-detected per the convention below; no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1216](https://github.com/intent-hq/intentd/pull/1216)): **auto-unarchive on agent turn start** (§5.1) — when a real agent turn begins in an Archived workspace (the turn-start choke point where the in-flight slot is claimed: direct sends, queue drains, wake deliveries, send-now redrives — never mere enqueue), the daemon flips the workspace back to Active through the same machinery as `workspace.unarchive` (row flip, parked-queue drain re-kick, `lastActivity` derivation) and the emitted `workspace:updated` delta additionally carries `autoUnarchive: { reason: "agent_activity", agentId, agentName }` inside `changes` (§6.5; `agentName` is `null` when the session-name lookup fails — display-only, never blocks the unarchive). The stamp is **absent** on manual `workspace.unarchive` / `workspace.restore` (absent ≠ present-false; older clients ignore the unknown field), the enqueue-side archived gates are untouched (queued wakes keep parking, so archiving remains sticky absent a real turn start), the virtual chief workspace is skipped, and the whole path is best-effort — a workspace-read or unarchive failure logs a warning and the turn proceeds. Also within 6.17 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1217](https://github.com/intent-hq/intentd/pull/1217), [monorepo#2275](https://github.com/intent-hq/monorepo/issues/2275)): **attachment upload session bounds** (§5.9) — the `file.attachmentUpload.*` staged sessions gain a per-workspace cap of **4** live sessions (a `begin` at the cap is -32602 naming the live count and advising commit/abort) and a **15-minute idle TTL** expired lazily (the next `begin` drains expired sessions and reclaims their staging dirs so they never hold cap slots; a late `chunk`/`commit` on an expired id is -32602 "expired after Ns of inactivity — begin a new upload"); a session never expires while a commit is in flight, and a failed commit refreshes the idle clock so the retry-after-more-chunks window is fresh; and the pipelined chunk+commit race gets clear caller-error treatment: a commit catching a reserved-but-unwritten chunk is reclassified from -32603 Internal to -32602, and the partially-written-chunk guise (already -32602) gains the same retry advice — wait for the chunk call to return, then retry the commit. Also within 6.17 (behavior only on an existing optional response field, following the v4.2 `Workspace.diskUsage` precedent; no method-catalog or wire-shape change, so no version bump): the `AgentLite` projection (`agent.list` / `agent.get` / `agent.create` / `agent.update` results, and the `initialAgent` echoed by `workspace.create`) **stops serving** the session-level `imageBlocks` field (§5.5) — the spawn-time blocks are potentially large base64 blobs with no list-read consumer, so hydrating them made every `agent.list` scale with pasted-image bytes (the RPC cost contract; the store's summary reads now skip the column entirely, like `system_prompt` since v4.1). The field was optional (`skip_serializing_if`), so existing row decoders remain valid — it is simply never present anymore; the blocks stay persisted and are still served on the full `agent.getSession` projection, `agent.update`'s `imageBlocks` patch still writes them, and queue-entry `imageBlocks` (`agent.getQueue` / `agent.queueMessage`) are untouched. Version 6.18 is an **additive** minor bump over 6.17: it adds the `file.readChunk` router method (§5.9; [intent-hq/monorepo#2458](https://github.com/intent-hq/monorepo/issues/2458)) — one offset-windowed slice of a workspace file's raw bytes served FE-ward as `{ content (base64), bytesRead, size }`, the binary counterpart of the UTF-8-only `file.read` (whose `read_to_string` fails on binary content), so clients can download binary files (e.g. attachments resolved via `file.getAttachmentInfo`) from a remote daemon by iterating offset windows. Same within-workspace containment guard as the other `file.*` ops (traversal → -32603 "Access denied"); `length` is required, positive, and capped at 16 MiB decoded per call (the base64-encoded ~21.4 MiB frame stays under the §1.3 outbound cap; zero or over-cap → -32602 naming the cap); a directory path is -32602 naming the cause; a missing file is -32603 per the existing file-op convention; a window at/past EOF returns `{ content: "", bytesRead: 0, size }` (never an error) and a window crossing EOF returns just the remaining bytes — `size` is always the file's total byte length, so the client can plan the next window — 293 router methods, 332 total. Version 7.0 reworks the **batch `agent.delegate` form** (breaking; §5.5, part 2 of [monorepo#2457](https://github.com/intent-hq/monorepo/issues/2457)): each `tasks` entry now accepts a bare taskNoteId string OR an object `{ taskNoteId, specialist?, model?, reasoningEffort? }` whose per-task options override the call's top-level defaults (additive half), while the `greedy` batch param is REMOVED — a request passing it (any value) is rejected with `-32602` ("greedy was removed; delegate a held task individually to force it past the conflict hold"), the batch result no longer echoes `greedy`, `started` rows never carry conflict overlap, and the `held:conflict` reason now points at delegating the held task individually — no method-catalog change, 293 router methods, 332 total. Also within 7.0 (additive response field, presence-detected per the convention below; no method-catalog change, so no version bump — [intent-hq/intentd#1237](https://github.com/intent-hq/intentd/pull/1237), part 3 of [monorepo#2457](https://github.com/intent-hq/monorepo/issues/2457)): the batch `agent.delegate` **relation-less annotation** (§5.5) — a requested task's result row carries `relationsUnknown: true` when the relation graph does not cover the task: its own `dependsOn` and `conflictsWith` are both empty AND it is not referenced by any other requested task's relations (references count from REQUESTED tasks only, so an edge from an unrequested note does not cover a requested one). Presence-detected — omitted when the graph covers the task (absent, never `false`) — and annotation only: the flag never changes a disposition. When any flagged tasks actually start, the `unlockPlan.message` additionally appends `N of M started tasks carry no relations — the graph does not cover them.`, so a caller can tell "ready by the graph" apart from "the graph says nothing about this task". Also within 7.0 (additive response fields — always served, see the harness-versioning notes in §5.5; no method-catalog change, so no version bump — [intent-hq/intentd#1255](https://github.com/intent-hq/intentd/pull/1255), [monorepo#2459](https://github.com/intent-hq/monorepo/issues/2459)): **harness versioning** (§5.5 "Harness versioning") — every agent session is permanently stamped at creation with `harnessVersion` (string, currently `"1.0"`; immutable for the session's life — a daemon upgrade never changes it and there is no upgrade/migration/pinning op; pre-feature rows backfill to `"1.0"`, migration 0096) and `harnessFeatures` (a JSON snapshot of the effective `agentFeatures` on/off values at creation — camelCase keys per the §5.12 `agentFeatures.*` catalog; immutable like the version: later settings changes affect only new sessions, and session respawns read the snapshot so a restarted session's runtime surface matches what the wire reports), both served on the `AgentSession` (`agent.getSession`) and `AgentLite` (`agent.list` / `agent.get` / `agent.create` / `agent.update` results) projections — `harnessVersion` always present (older persisted payloads deserialize as `"1.0"`), `harnessFeatures` always carrying a value on the wire (a legacy pre-snapshot row follows the live effective settings on read until its first post-launch activation freezes the snapshot once — see §5.5). Delegation mints the CURRENT latest version — a child never inherits the delegating parent's pin, so mixed-version agent trees within one workspace are expected and supported. The harness version pins **doctrine** (the instruction/prompt text and feature values the session was created under) as a permanent creation-time stamp; the **reference layer** — the wire protocol and method catalog, MCP tool schemas, runtime semantics — always tracks the live binary and is never versioned, which is why these fields ship within 7.0 rather than bumping it. Also within 7.0 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1263](https://github.com/intent-hq/intentd/pull/1263)): **remote MCP server support** (§5.22) — `http`/`sse` MCP server configs are now started and health-checked by **probing the endpoint from the daemon host** instead of returning the former unconditional "unsupported transport" error status: `http` runs the full MCP handshake over streamable HTTP POST (`initialize` → `notifications/initialized` → `tools/list`, serving the advertised `toolCount`), `sse` is a reachability probe only (GET with `Accept: text/event-stream` must answer 2xx; no `toolCount`), probes are bounded (10 s per request, 15 s overall) and never follow redirects, a failed probe keeps the entry tracked in `error` with an actionable `lastError` (unlike a failed stdio spawn, which drops back to `stopped`), and the 30 s health sweep **re-probes** remote servers concurrently and flips status on transition — never auto-restarts them (no process to manage) — emitting `mcp.servers:status-changed` (§6.5) only on an actual state transition with `startedAt` preserved across consecutive `running` probes; `mcp.servers.update` restarts any tracked server (running, or a remote in `error`) so an updated URL/headers re-probes immediately. The `McpServerConfig` / `McpServerStatus` wire shapes are unchanged (`pid` stays stdio-only, `toolCount`/`lastError`/`startedAt` were already optional). Also within 7.0 (additive response field — always present in the result, older clients ignore it; no method-catalog change, so no version bump — [intent-hq/intentd#1268](https://github.com/intent-hq/intentd/pull/1268)): the `host.listDirectory` result gains the **`favorites`** array (§5.14) — `{ id, path }` rows for the standard user directories that exist on the daemon host, in the fixed order `home` / `desktop` / `documents` / `downloads`: `home` is always included and always leads, and the rest are **existence-checked** — a missing directory is omitted, so the FE directory picker can render favorites without probing. On Linux, `desktop`/`documents`/`downloads` resolve via the XDG user-dirs config (`~/.config/user-dirs.dirs`), so relocated/localized folders resolve correctly, with the conventional home-joined names (`~/Desktop` etc.) as fallback when the config is absent, lacks an entry, or carries an invalid (unquoted/relative) or `$HOME`-disabled value; on macOS the config does not exist, so the conventional names apply — existence-checked either way. Also within 7.0 (behavior only, no method-catalog or wire-shape change, so no version bump — [intent-hq/intentd#1273](https://github.com/intent-hq/intentd/pull/1273)): the per-turn state-snapshot injection (§5.5 "Per-turn agent state snapshot") is now gated on the session's **captured harness feature snapshot** (`harnessFeatures.stateSnapshot`, §5.5 "Harness versioning") like every other `agentFeatures` toggle — flipping `agentFeatures.stateSnapshot` applies to **new sessions only**, superseding the v6.0 "read LIVE each turn" exception; a legacy pre-snapshot row (NULL `harness_features`) keeps following the live setting until its first-activation freeze, and the `ws.agent.snapshot()` MCP tool remains never gated. `agentFeatures.backgroundHooks`' live services-layer `hook.schedule` check is now the one documented live-read exception (§5.12).
The protocol version is advertised in two places:

- `client.hello` response: `{ protocolVersion: "7.0", server: { protocolVersion: "7.0", ... }, ... }` — the top-level `protocolVersion` is an explicit copy of `server.protocolVersion` so clients can version-check without digging into the `server` block (§5.17).
- `system.status` response: `{ protocolVersion: "7.0", ... }`

### Compatibility Policy

- **Additive changes** (new methods, new optional fields, new event types) bump the **minor** version (e.g., 2.0 → 2.1).
- **Breaking changes** (removed methods, changed signatures, renamed fields) bump the **major** version (e.g., 2.0 → 3.0).

The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`. Any drift (added, removed, or renamed methods) causes CI failure with the instruction: "update `catalog.rs` + `docs/PROTOCOL.md` and bump the protocol version." Additive response fields on an existing method (e.g., the optional `system.status` resource fields, §5 fast-path notes) do not change the golden-test-enforced catalog and ship within the current version; clients must detect them by **presence**, not by protocol version.

## 1. Transport

### 1.1 Connection URL

When the WS API is enabled (`server.wsApi.enabled` — see the §1.1 UDS note below), the backend runs a dedicated **HTTPS server bound to `0.0.0.0`** (LAN-reachable) exposing the JSON-RPC WebSocket endpoint:

```
wss://<host>:<port>/ws
```

- **Default port:** `5181` (fixed — no port walking, no same-port backoff). The listener binds exactly this port. In the secure posture a WSS bind failure at boot is **non-fatal**: the daemon logs a warning and keeps serving UDS (`server.wsApi.enabled` stays true; toggle it to retry), and a runtime toggle-on bind failure surfaces as a `settings.update` error. Only the insecure dev listener (`--insecure`) treats a bind failure as fatal — the daemon exits non-zero with the OS bind error. Clients still SHOULD obtain the port from the QR/manual pairing payload (rendered on the daemon host via the local-only `pairing.getInfo`, §5, or `intentd pair`) or a well-known override rather than hard-coding it, since the operator may reconfigure `server.wsApi.port` (or its `INTENTD_TCP_PORT` env override).
- **Scheme:** `wss://` (TLS) in the default secure posture — there is no plaintext `ws://` listener unless insecure dev mode is opted into. With `serve --insecure` (or `INTENTD_INSECURE=1`) the daemon serves plain `ws://` with TLS and bearer-token enforcement skipped; this is a development-only posture (`make dev-daemon` uses it) and logs a prominent startup warning.
- A plain HTTPS `GET /health` returns `{"status":"ok","clients":<n>}` for liveness probing.
- The same listener also serves the non-JSON-RPC `/tunnel` WebSocket endpoint — the binary loopback port-forwarding surface (§1.4).
- Any path other than `/ws` and `/tunnel` is rejected at upgrade time (socket destroyed).

> Local transport (UDS / Windows named pipe): The daemon **always** serves a local transport as the local-first default — a **Unix-domain socket** on Unix, a **named pipe** on Windows (where UDS is unavailable); the TCP/WSS listener is optional and toggled at runtime by the `server.wsApi.enabled` setting (the former `server.listenMode` setting and `--listen` serve flag are retired). The JSON-RPC envelope, method catalog, event semantics, and the newline-delimited framing are **identical** across UDS, the named pipe, and TCP/TLS — only the listener differs; everywhere this document says "UDS" the Windows named pipe is implied. `system.status` reports a derived `listenMode` field (`"both"` while the WSS listener is up, `"uds"` otherwise) reflecting the live listener state.
>
> **Windows pipe-name contract:** the pipe name is derived from the resolved socket path, so every data dir (prod vs dev vs tests) gets its own isolated pipe with no extra coordination state: `\\.\pipe\intentd-<hash16>`, where `<hash16>` = the first 16 hex chars of the SHA-256 over the UTF-8 bytes of the socket path normalized as absolute form, backslash separators, lowercased. Both sides implement the derivation independently and must agree byte-for-byte: `intent-transport`'s `pipe_name_for_socket_path` (daemon + `intentd` CLI client) and cloudlands-fe's `intentd-pipe-name.ts` (FE local connect), each pinned by mirrored unit-test vectors.

### 1.2 TLS & fingerprint pinning

The server generates a **self-signed** EC (P-256) certificate on first start, persists it under the app's data directory (`ws-cert.pem` / `ws-key.pem`), and reuses it across restarts (10-year validity). Because it is self-signed, **clients pin the certificate** rather than relying on a CA:

- The server exposes a **SHA-256 fingerprint**, colon-separated uppercase hex (e.g. `AB:CD:EF:...`), computed over the DER body of the cert.
- Certificate SANs include `localhost`, `127.0.0.1`, `::1`, and every non-internal IPv4 address on the host (LAN, Tailscale, etc.), so connecting by hostname or LAN IP validates against the SAN.
- Clients should **pin the fingerprint** (obtained out-of-band during pairing — the pairing payload carries it as `fp=`) and reject any cert whose fingerprint does not match.

### 1.3 Message size limit

Inbound JSON-RPC messages are capped at **40 MiB** (`MAX_INBOUND_MESSAGE_BYTES = 40 * 1024 * 1024` in `intent-transport`). The limit is the same on both transports; the behavior on violation differs by framing:

- **WSS:** the limit is enforced on both the WebSocket frame size and the total message size, and the connection is closed on violation. The daemon attempts to send a close frame with code **1009 (Message Too Big)** before terminating. Delivery of the close frame is best-effort: a single over-limit frame fails fast on the frame header (its payload is not buffered), and the connection teardown may race with the client's in-flight write, so the client may not observe the close frame; a fragmented message is rejected once its accumulated fragments exceed the cap (so up to the limit may be buffered before rejection), and in that case the client typically does receive the 1009 close frame.
- **UDS / named pipe:** the daemon replies with a `-32600` error (`id: null`, since the request was never parsed) and then closes the connection, without draining the rest of the oversized line.

Outbound (server→client) messages are capped at the same size (`MAX_OUTBOUND_MESSAGE_BYTES = MAX_INBOUND_MESSAGE_BYTES`, 40 MiB — intentd#743; an unscoped `git.diffs` on a huge dirty worktree once produced a 277 MiB message that HOL'd the connection writer for ~38s). Like the inbound cap, the limit applies to the **serialized JSON-RPC message**, before any WebSocket fragmentation — fragmenting a message cannot bypass it. The cap is enforced at two layers:

- **RPC responses** are checked at router serialization time, where the request id is known: an over-cap response is replaced with a **`-32010`** error echoing the request id, so the client fails fast instead of hitting its RPC timeout on a silently dropped message (§9).
- **Non-response messages** (subscription pushes, `events.event` notifications) are dropped by the connection writer task with an error log — a last-resort backstop, identical on UDS and WSS.

### 1.4 `/tunnel` — loopback port-forwarding endpoint

Beside `/ws`, the same WSS listener exposes a second WebSocket endpoint ([intent-hq/monorepo#2323](https://github.com/intent-hq/monorepo/issues/2323); [intent-hq/intentd#1205](https://github.com/intent-hq/intentd/pull/1205)):

```
wss://<host>:<port>/tunnel
```

`/tunnel` is the **loopback port-forwarding** surface: a remote client that cannot reach a daemon-host port directly (server bound to `127.0.0.1`, firewall) opens **one** `/tunnel` connection and multiplexes TCP streams over it. It is **not** a JSON-RPC transport — frames are **binary** mux frames, and a text frame is a protocol violation (`1002` close).

- **Auth & upgrade gate — identical to `/ws` (§2):** the enable flag (`403` when the WS API is disabled), the Origin allow-list (`403`), then the same bearer token (`Authorization: Bearer <token>` header or `?token=` query parameter; timing-safe compare; `401` on failure) — all checked before the WebSocket handshake completes. Insecure dev mode (`--insecure`) serves it as plain `ws://` with TLS and auth skipped, like `/ws`.
- **Shared connection lifecycle (§4):** tunnel connections live in the same client registry as `/ws` connections — the 30s-ping / 60s-pong-timeout heartbeat reaps them, graceful shutdown closes them with `1001` (`"Server shutting down"`), and they count toward the `/health` `clients` number.

**Frame format.** Each WebSocket **binary message** carries exactly one mux frame — the WebSocket provides message boundaries, so there is no length prefix:

```
[opcode u8][streamId u32 BE][payload...]
```

| Opcode | Name | Payload | Direction |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | port `u16` BE | client → daemon |
| `0x02` | `OPEN_OK` | (empty) | daemon → client |
| `0x03` | `OPEN_ERR` | UTF-8 message | daemon → client |
| `0x04` | `DATA` | raw bytes (may be empty) | both |
| `0x05` | `EOF` | (empty) | both |
| `0x06` | `CLOSE` | (empty) | both |

Malformed frames — shorter than the 5-byte header, an unknown opcode, an `OPEN` payload that is not exactly 2 bytes, a payload on a payload-less opcode (`OPEN_OK` / `EOF` / `CLOSE`), or a non-UTF-8 `OPEN_ERR` message — and the daemon-only opcodes (`OPEN_OK` / `OPEN_ERR`) arriving from the client end the whole **connection** with a `1002 Protocol Error` close naming the violation.

**Stream lifecycle** (`OPEN → OPEN_OK | OPEN_ERR → DATA* / EOF → CLOSE`). The client picks a `streamId` and sends `OPEN` with the target port; the daemon TCP-connects `127.0.0.1:<port>` and answers `OPEN_OK` (data may now flow both ways) or `OPEN_ERR` carrying the connect error:

- **Loopback-only connect policy.** Connect targets are hard-limited to the daemon's IPv4 loopback (`127.0.0.1:<port>`) by construction — the client supplies only a port, never a host. A service bound only to `::1` is intentionally out of scope.
- **`OPEN_ERR` is terminal** for an `OPEN` that never produced a stream (connect refused/failed, connect timeout, duplicate `streamId`, stream cap exceeded) — no `CLOSE` follows. A failed connect leaves the id free for reuse; a **duplicate-id** rejection frees nothing — the already-open stream keeps owning that id until its own final `CLOSE`.
- **`EOF` half-closes one direction:** client `EOF` ⇒ the daemon shuts down the TCP write side; TCP read EOF (or a read error, e.g. RST) ⇒ the daemon sends `EOF`. The other direction keeps flowing until it too ends. `DATA` after the sender's own `EOF` is a client error and is dropped.
- **`CLOSE` tears the stream down fully** (both directions), and the daemon **always sends a final `CLOSE` when an established stream ends for any reason** — including confirming a client `CLOSE` — after which the `streamId` may be reused. A daemon-side teardown can race the client's frames, so frames for unknown stream ids are **ignored** (a duplicate `CLOSE` is harmless).
- Client `CLOSE` is handled **out-of-band** — never queued behind pending `DATA` — so it is the client's escape hatch for a stream wedged on a stalled consumer.

**Caps & timeouts** (per connection unless noted):

| Limit | Value | On violation / expiry |
| --- | --- | --- |
| Concurrent streams | 32 | further `OPEN`s answered with `OPEN_ERR` until a stream closes |
| `DATA` payload (client → daemon) | 1 MiB | `1002` protocol close (whole connection) |
| Inbound WebSocket message | 5-byte header + 1 MiB | `1009 Message Too Big` close — tunnel-specific cap, **not** the 40 MiB JSON-RPC cap (§1.3) |
| TCP connect deadline | 10 s | `OPEN_ERR` naming the timeout |
| Idle stream (no data either way; also bounds one blocked TCP write) | 300 s | stream torn down (final `CLOSE`) |
| Wedged-stream forward deadline | 15 s | a stream whose full queue parks the mux is killed (final `CLOSE`) so pings keep flowing inside the heartbeat window |

Flow control is per-connection (bounded frame queues both ways; daemon-side TCP reads are chunked into one `DATA` frame per 16 KiB read), not per-stream, so one stream with a stalled consumer can briefly head-of-line-block its siblings' inbound frames — the caps above bound the wedge on every axis.

**FE fallback usage (Electron only).** The intended consumer is the `browser.exec` loopback-rewrite **tunnel fallback** (§5.9, §5.14; monorepo#2323): when a remote-rewritten `navigate` / `openTab` reachability probe fails, the Electron FE forwards the daemon port over `/tunnel` — a local TCP listener on the client machine relays to a tunnel stream — and navigates to `http://127.0.0.1:<localPort>` instead, echoing `tunneled: true` in the action result. Web builds cannot host a local TCP listener and keep the explanatory probe error.

## 2. Authentication

### 2.1 Bearer token on upgrade

Every WebSocket upgrade must present a bearer token. The server checks the token **during theHTTP upgrade** (before the socket is upgraded) in this order:

1. `Authorization: Bearer <token>` header.
2. `?token=<token>` query parameter on the `/ws` (or `/tunnel`, §1.4) URL (for clients that cannot set headers).

Validation is **timing-safe** (constant-time compare) against the stored token. On failure theupgrade is rejected with `HTTP/1.1 401 Unauthorized` and the socket is destroyed.

- The token is **32 random bytes, hex-encoded (64 chars)**, generated once and persisted in appsettings. It can be rotated (regenerated) by the host application.
- If the WebSocket API is disabled in settings, upgrades are rejected with `403 Forbidden`.

### 2.2 Origin allow-list

Browser-origin upgrades are gated to prevent cross-origin attacks; native clients are allowed:

- **Allowed:** missing/empty `Origin` (native iOS/CLI clients never send one), `file://` (desktop app renderer), loopback hosts (`localhost`, `127.0.0.1`, `[::1]`), and the host's own hostname / `.local` form (so LAN clients connecting by advertised hostname pass).
- **Rejected (**`403`**):** `Origin: null` (sandboxed/`data:` contexts) and any other cross-origin host.

### 2.3 Where the token lives

The token and the API-enabled flag are persisted in the daemon's settings store. Clients obtain the token out-of-band via a pairing flow (the daemon surfaces token + fingerprint together — see also `pairing.getInfo` in the §5 fast-path catalog). An operator can run `intentd pair` to print the QR code, `intent://pair` URL, bearer token, and TLS certificate fingerprint together for pairing (and `intentd pair --rotate` to regenerate the token, daemon-authoritative via `server.rotateToken`).

## 3. Message Envelope (JSON-RPC 2.0)

All application messages are **JSON-RPC 2.0** text frames. The handler is transport-agnostic: ittakes a message string and returns a response string (or `null` for notifications).

### 3.1 Request

```json
{ "jsonrpc": "2.0", "id": 1, "method": "note.list", "params": { "workspaceId": "ws-abc" } }
```

- `jsonrpc` — **must** be the string `"2.0"`. Otherwise → `-32600 Invalid Request`.
- `method` — **must** be a non-empty string. Otherwise → `-32600`.
- `id` — string, number, or `null`. Any other type → `-32600`.
- `params` — object (named) or array (positional). **Named (object) params are required by thisAPI.** Positional arrays are *accepted* per spec but coerced to `{}` (so the call runs with noargs). Non-object/array `params` → `-32602 Invalid params`.

### 3.2 Success response

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "notes": [ /* ... */ ] } }
```

`result` is always a JSON **object** (never a bare array/scalar); list endpoints wrap their arrayunder a named key (e.g. `{ "notes": [...] }`, `{ "agents": [...] }`).

### 3.3 Error response

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Missing required parameter: noteId", "data": { "code": "invalid-params" } } }
```

`error.data` is optional and carries extra context — for `-32603` it may carry the original internal error message (not guaranteed: many shims pass the underlying message through as `message` directly — §9), and some errors attach a structured machine-readable payload (e.g. the `-32005` conflict object, or the `workspace.create` base-ref failure data). **All** `-32602` errors carry an `error.data.code` discriminator: `"not-found"` (the addressed entity does not exist) or `"invalid-params"` (bad/missing parameters), except errors that already attach a more specific code (`base-ref-unresolvable`, `path-invalid`, `destination-exists-non-empty`, `not-a-file`), which keep theirs. Fast-path connection-scope methods handled before the dispatcher (subscriptions, `drafts.*`, `forward.*`, `host.*`, `browser.exec`, `client.hello`) always emit `"invalid-params"`. **Client rule:** the deleted-entity flow requires `error.data.code === "not-found"`; only that code may be treated as "entity deleted" — see §9. See §9 for the code table.

### 3.4 Notifications (no response)

A request **without an **`id`** member** is a notification: the server processes it and returnsnothing. Note the distinction required by JSON-RPC 2.0:

- `id` **absent** → notification → no response is ever sent (even on error / unknown method).
- `id: null` **present** → a normal request that **must** receive a response.

Unknown methods sent as notifications are silently ignored; unknown methods sent as requests get`-32601 Method not found`.

### 3.5 Batching

The server processes **one JSON-RPC object per WebSocket text frame**. JSON-RPC batch *arrays* are **not** supported as a batch unit: a top-level array fails envelope validation (`-32600 Invalid Request: expected an object`). Clients should send one message per frame and correlate responses by `id`. (Independent requests can be pipelined — the server does not require request/response lock-step — but each must be its own frame.)

### 3.6 `workspaceId` scoping

Most methods operate within a workspace. `workspaceId` is read from `params.workspaceId`, fallingback to a connection-level context value if the transport provides one. If neither is present, themethod returns `-32602 "workspaceId is required"`. The workspace/repo/specialist/global methods(e.g. `workspace.list`, `repo.list`, `specialist.list`, `agent.getModels`) do not require it.

## 4. Heartbeat & Lifecycle

- **Ping/pong:** The server sends a WebSocket **ping every 30s** (`HEARTBEAT_INTERVAL_MS`). Theclient's transport must answer with a standard pong frame (handled automatically by compliantWebSocket libraries). If no pong is seen within **60s** (`HEARTBEAT_TIMEOUT_MS`), the serverterminates the connection and cleans up its subscriptions.
- **Server shutdown:** On graceful stop, clients are closed with code `1001`(`"Server shutting down"`) and all transport-local subscriptions are dropped.
- **Disconnect cleanup:** On `close` or socket `error`, the server removes the client and all ofits event subscriptions. Subscriptions are **per-connection** and do **not** survive reconnects.
- **Reconnection guidance:** Clients should reconnect with backoff, re-authenticate on the newupgrade, and **re-establish all subscriptions** (re-send `events.subscribe`). Because canonicalstate lives in the backend, after reconnect a client should **re-fetch** the entities it caresabout (subscribe-then-fetch, §10) rather than assuming it missed nothing.

## 5. Method Catalog

The API exposes **332 dispatchable method names** across the following categories:

- **Router methods:** 293 methods dispatched via the main router (`router::dispatch`)
- **Fast-path methods:** 37 methods intercepted before the router for performance or per-connection state
- **Method aliases:** 2 aliases accepted on the wire (`git.diff` → `git.diffs`, `git.log` → `git.commits`)

Additionally, the protocol includes:

- **Server→client notifications:** 1 notification (`events.event`, §6.3), plus the `subscription.push` frames of the snapshot+delta channels (§6.9)
- **Client-served reverse RPCs:** 4 methods total — 2 are **dual-role** and counted within the 332 dispatchable names (`browser.exec`, `host.openInEditor`), and 2 are **daemon→client-only** reverse RPCs not in the dispatchable catalog (`host.openExternal`, `host.pickApplication`) — see §5.9 and §5.14

**Total:** 332 dispatchable names + 1 notification. Of the 4 reverse-RPC names, 2 (`browser.exec`, `host.openInEditor`) are dual-role — dispatchable client→server methods that are also issued daemon→client as reverse RPCs on remote connections — and 2 (`host.openExternal`, `host.pickApplication`) are daemon→client-only reverse RPCs, never dispatched client→server.

The method surface is enforced by the golden tests in `crates/intent-transport/src/catalog.rs`; the per-namespace subsections below (§5.1–§5.43) carry each method's parameter and result contract.

### Router methods by namespace (293 total)

| Namespace | Count | Methods |
| --- | --- | --- |
| agent | 42 | appendMessage, cancelDelete, cancelSubscriptions, completeOnce, create, delegate, delete, diagnostics, dismissQuestions, editAndRegenerate, editQueuedMessage, enhancePrompt, get, getConversation, getModels, getQueue, getSession, getSessionStats, getSubscriptions, list, listActive, listInterrupted, markSeen, pendingPermissions, queueMessage, removeQueuedMessage, rename, replaceMessages, reportToParent, resolveInterrupted, respondPermission, retry, sendMessage, sendQueuedMessageNow, sendToTask, setModel, stop, subscribe, summary, unsubscribe, update, wakeOrCreate |
| comment | 6 | add, delete, getThread, list, resolveThread, respond |
| crossWorkspace | 3 | listNotes, listSiblings, readNote |
| debug | 1 | sampleStacks — point-in-time sample of the daemon's own thread stacks rendered as a text report (§5.43; v6.3, daemon-global — no `workspaceId`) |
| event | 3 | agentActivity, query, workspaceSummary |
| file | 16 | attachmentUpload.abort, attachmentUpload.begin, attachmentUpload.chunk, attachmentUpload.commit, delete, exists, getAttachmentInfo, list, mkdir, placeAttachment, read, readChunk, rename, stat, tree, write |
| git | 28 | agentCommit, branchDiff, branchStatus, changes, checkMergeConflicts, checkoutBranch, clone, commit, commitDetails, commits, createBranch, diffs, discard, fetch, getBranches, getConfig, getRemoteUrl, numstat, pull, push, removeLockFile, renameBranch, showFile, stage, stageHunk, status, unstage, unstageHunk |
| gitRoot | 1 | list — the workspace's registered secondary git roots (§5.6; v6.15, `workspaceId` req). No wire register/unregister method: registration is MCP-only (`ws.git.registerRoot` / `ws.git.unregisterRoot`), per the §6.8 principle |
| github | 24 | authStatus, branches.list, branches.listCached, cancelAuth, connect, getReviewThreads, getUser, issues.list, issues.search, listReviewComments, pulls.create, pulls.get, pulls.list, pulls.merge, pulls.search, pulls.updateBranch, replyReviewComment, repoConfig.get, repos.get, repos.list, repos.search, resolveThread, revoke, unresolveThread |
| hook | 3 | cancel, list, runNow — background-hook management (§5.40; v2.10). No `hook.schedule` on the wire: scheduling is MCP-only (`ws.hook.schedule`), per the §6.8 principle |
| linear | 11 | authStatus, createIssue, getIssue, listIssues, listLabels, listProjects, listTeams, listWorkflowStates, searchIssues, updateIssue, viewer |
| mcp | 11 | oauth.delete, oauth.get, oauth.list, oauth.set, servers.create, servers.delete, servers.getStatus, servers.list, servers.restart, servers.toggle, servers.update |
| metrics | 4 | clearAgentStats, getAgentStats, getAllWorkspaceStats, getWorkspaceStats |
| models | 1 | list |
| note | 18 | add, create, delete, edit, editLines, get, getVersion, lineAttribution.computeNow, lineAttribution.load, list, listTasks, listVersions, readAsset, restoreVersion, saveAsset, setContent, update, updateMetadata |
| pr | 2 | refresh, status — the 11 other `pr.*` methods were removed in v5.0 (§5.7) |
| prMonitor | 3 | list, cancel, flush — the FE surface over centralized PR monitors (§5.42; v6.1). No wire registration method: monitors are agent-owned via the MCP `ws.pr.monitor` binding only, per the §6.8 principle (like `hook.*` vs `ws.hook.schedule`) |
| primitive | 4 | addAgentAction, addCli, addPatch, addReference |
| providers | 1 | catalog — the static provider registry served over the wire (§5.38; v2.6, daemon-global — no `workspaceId`) |
| repo | 3 | list, remove, warmCache — opportunistic background repo-cache refresh for one GitHub repo (§5.11; v6.10, daemon-global — no `workspaceId`) |
| repoConfig | 4 | ensureDir, get, has, save |
| rules | 3 | get, list, update |
| sandbox | 2 | discard, merge |
| script | 9 | create, list, output, remove, restart, run, start, status, stop |
| search | 7 | cancel, codebase, events, fileNames, inFiles, messages, notes |
| sentry | 8 | assignIssue, authStatus, getIssue, ignoreIssue, listIssues, listProjects, resolveIssue, searchIssues |
| settings | 4 | get, list, reset, update |
| skill | 1 | list |
| specialist | 5 | create, delete, edit, get, list |
| stats | 2 | getRateHistory (§5.39; v2.9, daemon-global — no `workspaceId`), getUsage |
| system (router) | 1 | capabilities — machine-level capabilities, no workspaceId; distinct from the `system.*` fast-path controls below (v2.3, see the note after the fast-path catalog) |
| task | 15 | assignAgent, convertBlocks, createPrerequisite, get, getMyTask, linkAgent, list, listAgentLinks, markAsTask, removeAgentFromAllTasks, setRelations, unlinkAgent, update, updateNoteStatus, updateStatus |
| terminal | 7 | create, getBuffer, kill, list, readOutput, resize, write |
| unsloth | 2 | status, stop — observe / gracefully stop the daemon-managed singleton Unsloth server (§5.37; v2.5, daemon-global — no `workspaceId`) |
| voice | 2 | getWorkspaceVocabulary — the auto-derived per-workspace vocabulary served for client-side transcription engines (§5.41; v5.1, `workspaceId` req), transcribe — daemon-owned speech-to-text via the configured provider (§5.41; v4.3, daemon-global — no required `workspaceId`; optional `workspaceId?` workspace-vocabulary injection since v5.1) |
| workspace | 36 | archive, cancelDelete, cleanup, create, delete, detectProjectType, diskUsage, dismissAttention, duplicate, export.abort, export.finalize, export.read, export.start, findRepositories, generateSetupScript, get, getAutoCommit, getContext, getSetupScript, getTokenUsage, getUiContext, import.abort, import.begin, import.chunk, import.commit, initializeRepository, list, markSeen, restore, saveSetupScript, setAutoCommit, transfer.plan, unarchive, update, updateContext, updateUiContext |

Namespaces without their own numbered subsection below (`accept-changes.*`, `file-tracking.*`, `drafts.*`, `forward.*`, `host.*`) are covered in §5.14–§5.20; `browser.exec` is in §5.9.

### Fast-path methods (37 total)

The following 37 methods are intercepted **before** the main router for performance or to access per-connection state. They share the same JSON-RPC envelope validation but are dispatched earlier in the connection task.

browser.exec, client.hello, drafts.clear, drafts.get, drafts.set, events.subscribe, events.unsubscribe, forward.close, forward.create, forward.list, host.checkAuggie, host.checkGh, host.checkGit, host.checkNode, host.createDirectory, host.directoryStatus, host.env, host.exec, host.execStream, host.execStream.cancel, host.execStream.write, host.findApp, host.findBinary, host.listDirectory, host.listInstalledEditors, host.openInEditor, host.providerAuthStatus, host.providerDiscovery, host.status, host.toolAvailability, pairing.getInfo, server.pairingInfo, server.rotateToken, system.gitCredential, system.importLegacy, system.shutdown, system.status

The snapshot+delta subscription channels (`note.subscribe`, `chat.subscribe`, …, §6.9) are likewise intercepted on the subscription fast-path.

**UDS-only methods:** `system.shutdown`, `system.importLegacy` (v2.2), and `system.gitCredential` (v2.5) are only available on the Unix-domain socket transport (a remote WSS/TCP caller is rejected with `-32001`). `system.status` is available on both UDS and WSS transports. `system.status` reports daemon liveness + transport/port/client/agent/cert-fingerprint/host-capability state, and `system.shutdown` requests a graceful daemon shutdown; both are consumed by `intentd status` / `intentd stop`. `system.importLegacy` triggers a legacy workspace import (see below). `system.gitCredential` resolves the daemon-managed GitHub credential for the `intentd git-credential` helper (see below). `pairing.getInfo`, `server.pairingInfo`, and `server.rotateToken` are likewise local-only: they are gated on the real connection origin (UDS vs TCP), so a remote (TCP/WSS) caller is rejected with `-32001` regardless of locality flags.

**`system.capabilities` is a router method, not a fast-path control (v2.3).** Unlike the `system.*` fast-path methods above (which are answered by the composition root's control surface), `system.capabilities` dispatches through the main router to the service layer and is available on **both** UDS and WSS. It takes no params (no `workspaceId`) and returns machine-level capabilities:

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "system.capabilities", "params": {} }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "cowSupported": true } }
```

- `cowSupported?: boolean` — the cached CoW-reflink probe of the **workspaces root** filesystem, the same probe that fills `Workspace.cowSupported` (§5.1): `true`/`false` when the probe ran, **omitted** (never `null`) when it could not run — clients detect by presence. Because it is workspace-independent, the FE gates the `workspace.cowIsolation` opt-in toggle (§5.12) on this method rather than reading `cowSupported` off a hydrated workspace payload.

#### `drafts.*` — draft attachments (additive, optional)

`drafts.set` accepts an **optional** `attachments` param and `drafts.get` returns it when present:

| Method | Params | Result |
| --- | --- | --- |
| drafts.get | workspaceId (req), agentId (req) | `{ text, attachments?, updatedAt } \| null` — `attachments` present only when non-empty |
| drafts.set | workspaceId (req), agentId (req), text (req), attachments (opt) | `{ ok: true, updatedAt }` — emits `draft:changed` |
| drafts.clear | workspaceId (req), agentId (req) | `{ ok: true }` — emits `draft:changed` |

- **`attachments`** is an opaque **JSON array** of FE-authored objects (e.g. image context items with base64 `imageData`), stored verbatim like workspace context items. Omitted, `null`, or an **empty array** ⇒ no attachments stored.
- A `drafts.set` with empty `text` **and** no attachments is still a **clear** (row deleted); empty `text` **with** attachments persists the row.
- The serialized `attachments` payload is capped at **25 MB**; larger payloads (and non-array `attachments`) are rejected with `-32602`.
- **Additive:** draft rows written before this field existed read back with no attachments; the `draft:changed` event payload is unchanged (`hasDraft` is `true` when text **or** attachments exist — never any content).

#### `system.status` — process resource fields (additive, optional)

The `system.status` result includes two **optional** self-process resource fields alongside the existing status payload (`running`, `listenMode`, `transports`, `port`, `clients`, `agents`, `maxAgents`, `version`, `uptimeSeconds`, `fingerprint`, `protocolVersion`, `host`):

```jsonc
{
  "cpuPercent": 12.5,        // optional — daemon process CPU usage
  "memoryBytes": 104857600   // optional — daemon process resident set size (RSS), in bytes
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- `cpuPercent` uses the raw `sysinfo` convention: `100` = one full core, so values **may exceed 100** on multicore systems (not normalized to total capacity). The first sample after daemon startup **may read **`0` before a usage baseline is established.
- `memoryBytes` is the daemon process RSS in bytes.
- Both fields are **additive and optional**; clients must tolerate their absence and degrade gracefully. They shipped within protocol **v2.0** without a version bump (additive optional response fields; the method surface is unchanged) — clients must detect them by **presence**, not by protocol version.

#### `system.status` — child-process tree fields (additive, v6.13)

The `system.status` result additionally reports the daemon's **whole descendant process tree** — the cost `memoryBytes` above does not capture:

```jsonc
{
  "childProcesses": 24,                // process count in the daemon's descendant tree; null until first sample
  "childMemoryBytes": 5090787328,      // aggregate RSS of those processes, in bytes; null until first sample
  "childMemoryPeakBytes": 23085449216  // high-water mark of the daemon's sampled tree memory since daemon start; null until first sample
  // ...existing status fields (cpuPercent, memoryBytes, running, listenMode, ...)
}
```

- `childProcesses` counts the OS processes in the daemon's descendant tree: agent provider CLIs and everything they spawn (ACP adapters, MCP bridges, an agent's own tool children), the Unsloth server, and `host.exec` children.
- `childMemoryBytes` is the aggregate resident memory of those processes. This is the daemon's real cost to the machine; the existing `memoryBytes` covers only the daemon binary and understates it by more than an order of magnitude once agents are live (measured on a dev seat: a 183 MB daemon owning a 21.5 GB tree). A client cannot attribute system memory pressure to agents without it.
- `childMemoryPeakBytes` is the high-water mark of the daemon's **sampled** descendant-tree memory since daemon start. It is **not** simply the maximum of the `childMemoryBytes` values a client has seen: the tree is swept every **500 ms** while an ephemeral ACP adapter chain holds a slot in the daemon-wide adapter bound (`agents.maxConcurrentAdapters`, §5.12) — one-shot `agent.completeOnce` on ACP providers, and model probes — against the 5 s cadence `childProcesses` / `childMemoryBytes` are published at, so **the peak can legitimately exceed every instantaneous value ever published**. That is deliberate: those chains live only seconds, so by the time a debug bundle is captured the instantaneous value has drained back to baseline (intentd#1139, monorepo#2107; fast cadence introduced by [intent-hq/intentd#1167](https://github.com/intent-hq/intentd/pull/1167) — measured, a 16-chain burst peaked at 6.97 GB while `childMemoryBytes` read 0 at every published sample).
- The fast cadence applies **only** to descendants spawned through the ephemeral-adapter bound — the one-shot ACP runner and the model probe. Everything else in the tree — the **auggie** route of the same quick actions (it spawns its CLI directly and takes no slot), `host.exec` children, PTY sessions, MCP bridge servers, the Unsloth server, and the tool children a long-lived agent runs — is sampled at the 5 s baseline only, so a burst from one of those that spikes and drains inside one baseline interval may not appear in the peak.
- The tree's baseline sampling cadence is **5s**. All three keys are always present on the wire and are `null` — never `0` — until the first sample lands (~5s after daemon start); `0` is a real measurement meaning an empty tree. Clients must detect them by **presence**, not by protocol version.

#### `system.status` — aggregate memory budget fields (additive)

When the aggregate agent memory budget is on (`agents.memoryBudgetMb` > 0, §5.12; [intent-hq/monorepo#2063](https://github.com/intent-hq/monorepo/issues/2063)), the `system.status` result additionally reports the budget's live admission state:

```jsonc
{
  "agentMemoryBudgetBytes": 21474836480, // installed budget (agents.memoryBudgetMb, in bytes)
  "agentMemoryChargedBytes": 3221225472, // what admission actually compares: last tree sample + pending correction
  "queuedSpawns": 1                      // spawns currently queued behind the admission gate
  // ...existing status fields (childMemoryBytes, running, listenMode, ...)
}
```

- `agentMemoryBudgetBytes` is the installed budget in bytes.
- `agentMemoryChargedBytes` is the byte count admission actually compares against the budget: the last descendant-tree memory sample **plus the provisional correction** for spawns admitted / processes released since that sample was taken — not the raw `childMemoryBytes` value, which lags the truth by up to one sampling period. It is additionally **absent while the budget is on but no tree sample has landed yet** (~5s after daemon start): the budget is inert until the first sample, and the field says so by omission.
- `queuedSpawns` counts the agent spawns currently parked in the admission wait queue — whether they queued on the concurrency slot cap or on the memory budget. `0` means nothing is waiting.
- Unlike the child-tree fields above (always present, `null` until sampled), all three follow the **presence-detection convention**: when the budget is off (`agents.memoryBudgetMb = 0`, the default) they are **absent** — never `null`. Reading them never perturbs admission state. Additive response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version.

#### `system.status` — workspaces-root disk fields (additive)

The `system.status` result additionally reports the disk space of the **volume containing the daemon's resolved workspaces root** — the parent directory `workspace.create` provisions new checkouts under, resolved with the create path's precedence: startup-pinned `workspaces.root` (`INTENTD_WORKSPACES_DIR`) wins, then a non-empty absolute `workspace.worktreesLocation` setting, then the `~/intent/workspaces` default (resolved once at boot; a `worktreesLocation` change applies on restart) — so a client can warn when workspace provisioning is about to run out of space:

```jsonc
{
  "workspacesDiskAvailableBytes": 250790436864, // available bytes on the workspaces-root volume
  "workspacesDiskTotalBytes": 994662584320      // total bytes of that volume
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- The values describe the **mounted volume** containing the workspaces root (longest-mount-point match against the canonicalized root), not the directory's own usage — the same numbers `df` reports for that path.
- Served from a background sampler (~30s cadence, first sample taken synchronously at startup), so the status read path never touches the OS; a large delete or download may take one refresh interval to appear.
- Both fields follow the **presence-detection convention**: **absent** — never `null` or `0` — until the sampler's first sample lands, or when no mounted volume matches the root (e.g. an empty disks list in a locked-down container, or an unmounted drive letter on Windows; a merely not-yet-created root still matches its would-be volume, so absence does **not** imply the directory is missing). Additive response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version.

#### `system.status` — daemon routing fields (additive)

The `system.status` result also includes two **additive** routing fields so an authenticated client — including a **remote WSS** caller — can discover every route to the daemon and the host's name without the local-only `server.pairingInfo` / `pairing.getInfo` methods:

```jsonc
{
  "localIps": ["192.168.1.10", "10.0.0.5"], // non-loopback IPv4 addresses (same source as server.pairingInfo)
  "hostname": "studio.local",               // local OS hostname
  // ...existing status fields (running, listenMode, transports, port, ...)
}
```

- `localIps` lists the host's non-loopback IPv4 addresses (virtual/container interfaces skipped) — the same list `server.pairingInfo` returns. It may be **empty** on a host with no routable interface, but is always an array, never `null`. The daemon serves it from a background-refreshed cache (~15s TTL), so a freshly changed interface list may take one refresh interval to appear.
- `hostname` is the local OS hostname (falls back to `intent` when unresolvable), matching `server.pairingInfo` / `host.status`.
- Both fields are **additive** response fields shipped without a version bump (the method surface is unchanged); clients must detect them by **presence**, not by protocol version. Rationale: the caller already holds the bearer token, so serving the listen addresses on `system.status` lets a remote client (e.g. the iOS app) refresh its stored alternative routes for reconnect racing on every successful connect, while `server.pairingInfo` / `pairing.getInfo` (which also carry the token and cert fingerprint) stay local-only.

#### `system.importLegacy` (UDS-only, v2.2)

Runs the daemon's legacy workspace import over RPC — the same engine behind the `intentd import-legacy` CLI and the first-boot hook — so a client can trigger a recovery import without shell access. Scans the default legacy roots and imports per-directory legacy workspaces (notes, comments, agent sessions, assets) into the live store.

**Request:** `{ force?: boolean }` — `force` is optional and defaults to `false`. When `true`, workspaces whose id already exists in the DB are **updated (overwritten)** instead of skipped. `force` is overwrite-only: explicit runs (this RPC and the CLI) are never gated by the first-boot completion marker, so `force` is not needed to re-run. A non-boolean `force` → `-32602 "force must be a boolean"`.

**Response:**

```json
{
  "imported": 3, "updated": 0, "skipped": 1,
  "notes": 12, "comments": 4, "agents": 2, "assets": 5,
  "skipSummary": [ { "id": "ws-existing", "reason": "already in DB" } ],
  "compatibilityFailures": false,
  "markerWritten": true
}
```

- `imported` / `updated` / `skipped` count workspaces; `notes`, `comments`, `assets` are total rows/files imported across all workspaces, and `agents` counts imported agent **sessions**.
- `skipSummary` lists the first **20** skipped workspaces as `{ id, reason }`.
- `compatibilityFailures` is `true` when any workspace was skipped for a non-operational reason (unreadable/unparseable `workspace.json`, missing id, etc.). Operational skips — `already in DB` and transient `update failed:` / `insert failed:` / `lookup failed:` — do not count.
- `markerWritten` reports whether the first-boot completion marker was (re)written after this run. The marker is **not** written when compatibility failures occur, so the first-boot hook stays armed to retry; explicit CLI/RPC runs are not gated by the marker either way.
- **UDS-only:** a remote (TCP/WSS) caller is rejected with `-32001 "system.importLegacy is available over UDS only"`.
- A run that fails outright (e.g. the store cannot be read) → `-32603` with the underlying message. Per-workspace problems are soft: they surface as skips in the result, not as errors.
- Concurrent calls are serialized behind an internal lock, so overlapping runs cannot race workspace inserts or asset copies.
- **No bus events:** the import writes to the store directly and publishes no `workspace:*` / `note:*` events; clients must refresh (e.g. `workspace.list`) to see imported workspaces.

#### `system.gitCredential` (UDS-only, v2.5)

Resolves the daemon-managed GitHub credential for the `intentd git-credential` helper (monorepo#884): the daemon-spawned children (PTY terminals, agent provider shells) run the helper as a github.com-scoped git credential helper, and the helper fetches the credential from the daemon over UDS on demand — no token bytes in child environments.

**Request:** `{ pid?: number, protocol?: string, host?: string }` — `pid` is the calling helper's self-reported process id, used only for audit logging; missing or non-numeric values are tolerated (treated as absent), never rejected. `protocol`/`host` are the git-credential attributes the helper forwards so the daemon re-checks the scope gate server-side: the credential is granted only for `protocol=https` + `host=github.com` (case-insensitive, exact host), so an arbitrary local UDS caller cannot obtain the credential for another scope (defense in depth — the helper already applies the same gate before calling).

**Response:**

```json
// ← credential available
{ "credential": { "username": "x-access-token", "password": "gho_…" } }
// ← no credential available (still a success response, not an error)
{ "credential": null }
```

- `credential` is `null` when no credential is available — the scope gate missed (`protocol`/`host` absent or not `https`/`github.com`), the `sourceControl.github.exposeGitCredentialToChildren` setting is off, or no token resolves via the `sourceControl.github.tokenSource` chain. The cases are deliberately indistinguishable on the wire.
- **UDS-only:** a remote (TCP/WSS) caller is rejected with `-32001 "system.gitCredential is available over UDS only"` — the credential must never cross the network.
- Each grant is audit-logged by the daemon (requesting pid only; the token value is never logged).

#### `pairing.getInfo` (local-only)

Returns the structured QR pairing payload so local clients (the `intentd pair` CLI, desktop GUI) can render a QR code for LAN pairing.

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "uri": "intent://pair?v=1&host=192.168.1.10,10.0.0.5&port=5181&fp=AA:BB:...&token=abab...",
  "hosts": ["192.168.1.10", "10.0.0.5"],
  "port": 5181,
  "fingerprint": "AA:BB:...",
  "token": "abab...",
  "version": 1
}
```

- `uri` is the plaintext payload encoded in the QR code: `intent://pair?v=1&host=<ip[,ip...]>&port=<p>&fp=<sha256>&token=<t>` (query values percent-encoded where needed). The component fields (`hosts`, `port`, `fingerprint`, `token`, `version`) are provided so clients can render their own payloads.
- Hosts, TLS fingerprint, and bearer token come from the same sources as `intentd pair`, so all pairing surfaces stay consistent.
- **Local-only:** the payload embeds the long-lived bearer token, so remote (TCP/WSS) callers are rejected with `-32001` regardless of locality flags. Call it over UDS.
- Errors with a descriptive message when the TCP (WSS) listener is not running (no port to pair against) or when no non-loopback IPv4 address is available. The listener-down failure carries the machine-readable discriminator `error.data = { "code": "listener-down" }` on the otherwise-unchanged `-32603` envelope ([intent-hq/intentd#1065](https://github.com/intent-hq/intentd/pull/1065); monorepo#1822) — clients (e.g. the `intentd pair` auto-enable flow) match `error.data.code` first and keep the message-prose match only as a fallback for older daemons that predate the discriminator. The no-address failure keeps its plain descriptive message.

#### `server.pairingInfo` (local-only)

Returns the raw pairing/connection material — bearer token, TLS cert fingerprint, WSS port, and local addresses — so local clients can construct a remote connection or display pairing details. Unlike `pairing.getInfo`, it returns the component fields without the `intent://pair` URI envelope.

**Request:** `{}` (no parameters)

**Response:**

```json
{
  "token": "abab...",
  "certFingerprint": "AA:BB:...",
  "port": 5181,
  "path": "/ws",
  "localIps": ["192.168.1.10", "10.0.0.5"],
  "hostname": "my-mac.local"
}
```

- `token` is the long-lived bearer token (64 hex chars, §2.1); `certFingerprint` is the SHA-256 fingerprint of the daemon's TLS certificate (§1.2).
- `port` is the bound WSS port, or `null` when the TCP (WSS) listener is not running; `path` is always `"/ws"`.
- `localIps` lists non-loopback IPv4 addresses (virtual/container interfaces such as `docker*`/`veth*` are skipped) — the same host set `pairing.getInfo` reports, so all pairing surfaces stay consistent.
- **Local-only:** gated on the real connection origin (UDS vs TCP), not locality flags — a remote (TCP/WSS) caller is rejected with `-32001 "server.* methods are local-only"`. Call it over UDS.

#### `server.rotateToken` (local-only)

Regenerates the bearer token (invalidating the previous one for new connections) and returns the updated pairing info.

**Request:** `{}` (no parameters)

**Response:** same shape as `server.pairingInfo`, with `token` set to the newly generated value.

- Rotation is rejected with `-32602 "cannot rotate token: INTENTD_AUTH_TOKEN is set (token is fixed by env)"` when the token is pinned via the `INTENTD_AUTH_TOKEN` environment variable.
- **Local-only:** same `-32001` gating as `server.pairingInfo`.

#### `host.checkAuggie`

Resolves the auggie CLI on the daemon host. **Resolution-only** ([intent-hq/intentd#977](https://github.com/intent-hq/intentd/pull/977)): no `--version` spawn and no `version` field.

**Request:** `{}` (no parameters)

**Response:**

```json
{ "available": true, "path": "/Users/me/.local/bin/auggie" }
```

- `available` is `true` **iff** a path resolved; `path` accompanies it and is **omitted** when `available` is `false`.
- Resolution precedence is unchanged: the `context.auggiePath` setting (accepted when it is an existing file or symlink) → `providers.paths.auggie` → auggie auto-detection. Because nothing is executed, `available: true` means "the binary is where we would launch it from", not "the binary runs" — readiness and auth are separate concerns served by `host.providerDiscovery` and `host.providerAuthStatus` below.

#### `host.checkGit` / `host.checkNode` / `host.checkGh` *(checkNode/checkGh: v6.4)*

Detects the `git` / `node` / `gh` binary on the daemon host: PATH resolution (plus OS-common install dirs) followed by a `<path> --version` probe on a blocking thread.

**Request:** `{}` (no parameters)

**Response:**

```json
{ "available": true, "version": "2.43.0", "path": "/usr/bin/git" }
```

- `available` is `true` **iff** a path resolved **and** the `--version` probe answered — a resolved binary that fails the probe reads as `{ "available": false }` (never an RPC error). `version` (trimmed probe output) and `path` accompany `available: true` and are **omitted** otherwise — unlike `host.findBinary`, whose probe is best-effort on top of resolution.
- All three probes are **uncached** — no cache anywhere on the path ([intent-hq/intentd#1064](https://github.com/intent-hq/intentd/pull/1064), unlike the 60-second positive cache on `host.findBinary` / `host.toolAvailability`) — so a fresh install is seen immediately on the next call; the FE setup checks rely on this ([intent-hq/cloudlands-fe#979](https://github.com/intent-hq/cloudlands-fe/pull/979)).

#### `host.providerAuthStatus`

Daemon-owned provider auth probes: reports whether each CLI-backed agent provider is authenticated, so clients consume verdicts instead of orchestrating auth-check commands themselves.

**Request:** `{ "providerId": "grok", "force": true }` — both parameters optional. `providerId` scopes the sweep to a single provider; it must be a non-empty string when present, and an unknown, empty, or non-string `providerId` yields `-32602`. `force` must be a boolean when present (`-32602` otherwise).

**Response:**

```json
{
  "providers": [
    { "id": "auggie", "authenticated": true },
    { "id": "claude-code", "authenticated": false },
    { "id": "grok", "authenticated": null }
  ]
}
```

- Without `providerId`, the sweep covers all probe-able providers: `auggie`, `claude-code`, `codex`, `opencode`, `droid`, `grok`, `pi`. With `providerId`, the `providers` array contains only that provider.
- `authenticated` is tri-state: `true` (probe confirmed logged in), `false` (probe confirmed logged out), `null` (unknown — probe failed or timed out, or the provider is not installed). Not-installed providers are never probed. Installed-ness comes from the daemon's provider discovery, which resolves `opencode` and `grok` from their native installer locations (`~/.opencode/bin/opencode`, `~/.grok/bin/grok`) ahead of the `PATH` scan (see §5.30), so a natively installed CLI is probed even when the daemon's `PATH` does not include it. Since intentd#725, the install gate also honors **valid `providers.paths` overrides** for the providers whose gate command is the registry primary — `auggie`, `opencode`, `droid`, `grok` — so an override-only install is probed, while an invalid override contributes nothing and the gate falls through to auto-detection. For `opencode` / `droid` / `grok` a valid override is an absolute path to an executable file (the same validation as spawn resolution); `auggie`'s gate instead follows the `host.checkAuggie` precedence (`context.auggiePath` setting → `providers.paths.auggie`, with checkAuggie's file/symlink validation) before falling through to auggie auto-detection. `claude-code`, `codex`, and `pi` gate on the real `claude` / `codex` / `pi` CLIs — distinct from the adapter binaries their `providers.paths` keys describe — so adapter overrides are ignored for their gates.
- **Probe mechanics.** CLI-probed providers run their registry `auth_check_args`; `auggie`, `claude-code`, and `codex` ride a **generic exit-code arm** — exit 0 ⇒ `true`, non-zero ⇒ `false` — with the child's stdout and stderr **discarded**, never captured, logged, or surfaced. `grok` and `opencode` keep bespoke output-sniffing arms (their stdout is piped: `grok models` exits 0 in both auth states so its output is parsed for explicit auth markers, and `opencode models` requires at least one `provider/model` line beyond exit 0), while `droid` and `pi` probe via their adapters instead of `auth_check_args`. `auggie` probes with `auggie token print` ([intent-hq/intentd#977](https://github.com/intent-hq/intentd/pull/977)): it has no bespoke probe any more, and the discarded output matters here because the command prints the auth session secret. The former `auggie model list` output-sniffing probe is retired.
- Results are cached with a **60-second TTL** and probes are single-flighted (concurrent callers join the in-flight probe). `force: true` bypasses the cache read but still joins any in-flight probe.

#### `host.providerDiscovery`

Daemon-owned provider discovery: reports which CLI-backed agent providers are installed on the daemon host (binary resolution + npx fallback status, honoring valid `providers.paths` overrides), so clients render install state without probing `PATH` themselves.

**Request:** `{}` (no parameters)

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "unsloth",
      "displayName": "Unsloth",
      "command": "opencode",
      "installed": true,
      "resolvedPath": "/usr/local/bin/opencode",  // optional — present when the primary binary auto-detected (never an override path)
      "hasNpxFallback": false,
      "npxOnly": false,
      "secondaryCommand": "unsloth",               // optional — dual-binary providers only
      "secondaryResolved": true,                   // optional — dual-binary providers only
      "secondaryResolvedPath": "/Users/me/.unsloth/bin/unsloth"  // optional — present only when the secondary auto-detected
    },
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "command": "npx",
      "installed": true,
      "resolvedPath": "/usr/local/bin/npx",
      "hasNpxFallback": false,
      "npxOnly": true,
      "npxPackage": "@agentclientprotocol/claude-agent-acp@1.2.3"  // optional — npx-only providers only (pinned spec)
    },
    {
      "id": "pi",
      "displayName": "Pi",
      "command": "npx",
      "installed": false,
      "resolvedPath": "/usr/local/bin/npx",
      "hasNpxFallback": false,
      "npxOnly": true,
      "npxPackage": "pi-acp@0.0.33",
      "cliCommand": "pi",                          // pi row only — the probed `pi` CLI command
      "cliResolved": true,
      "cliResolvedPath": "/usr/local/bin/pi",      // optional — present only when the CLI resolved
      "cliVersion": "0.79.0",                      // optional — present only when the version probe succeeded
      "cliVersionOk": false,
      "cliRequirement": "Pi CLI 0.80.4+",
      "unavailableReason": "pi CLI 0.79.0 is too old — Pi CLI 0.80.4+ is required by pi-acp@0.0.33"  // optional — present iff the CLI gate fires
    }
  ],
  "npx": { "resolvedPath": "/usr/local/bin/npx", "version": "10.2.4", "versionOk": true }
}
```

- `providers` carries one entry per registered provider, in registry order. `installed` reflects the daemon's binary resolution, which checks Intent-managed / native installer locations (e.g. `~/.opencode/bin/opencode`, `~/.grok/bin/grok`) ahead of the `PATH` scan (see §5.30). Since intentd#717, `installed` (and `secondaryResolved`) also honor **valid `providers.paths` overrides** — an override value that is an absolute path to an executable file (the same validation as spawn resolution) counts as installed even when auto-detection finds nothing, matching what the daemon would actually launch; invalid overrides (missing, relative, non-executable) contribute nothing. Override keys follow spawn resolution: for `unsloth` the `opencode` key covers the primary binary and the `unsloth` key covers the secondary CLI.
- `resolvedPath` is **strictly auto-detected** — an override never surfaces there — so `installed: true` can coexist with `resolvedPath` absent (valid override, nothing auto-detected).
- **`secondaryCommand` / `secondaryResolved`** *(additive, monorepo#991)* — secondary-binary attribution for **dual-binary providers** (today only `unsloth`, which requires both `opencode` and `unsloth` on the daemon host). `secondaryCommand` names the required secondary CLI and `secondaryResolved` reports whether it resolved via the same discovery precedence as the primary (including valid `providers.paths` overrides, intentd#717) — so when a dual-binary provider shows `installed: false`, clients can attribute the failure to the actually-missing binary instead of the primary `command`. The two fields are always emitted **together**, and are **omitted (never null)** for providers without a secondary requirement and for gated-off providers (gated providers are never probed, so no attribution exists). Clients detect by presence.
- **`secondaryResolvedPath`** *(additive, intentd#701)* — the secondary binary's resolved **absolute path** string, sitting alongside `secondaryCommand` / `secondaryResolved` on dual-binary provider entries. Like `resolvedPath`, it is **strictly auto-detected**: present only when the secondary **auto-detected**; omitted (never null) when nothing auto-detected or the provider has no secondary requirement. Consequently `secondaryResolved: true` can coexist with `secondaryResolvedPath` absent (valid override satisfied the requirement, nothing auto-detected) — clients must not treat `secondaryResolved: true` as implying the path field.
- `gatedOff` (optional string, not shown above) is present — with a human-readable reason — only when the provider is gated off (e.g. a required env var or feature code is missing). Gated providers skip binary probing entirely, so a gated entry never carries `resolvedPath`, `secondaryCommand`, `secondaryResolved`, or `secondaryResolvedPath` and always reports `installed: false`.
- `npxOnly` is `true` for providers with no local-binary path at all (claude-code): they are launched via `npx <package>`, `installed` reflects npx resolution, and `resolvedPath` (when present) is the npx binary. `npxPackage` (the pinned package spec) is present **iff** `npxOnly` is `true`.
- `hasNpxFallback` is `true` for providers that prefer a local binary but can fall back to an npx-launched adapter when the binary is absent — so a `hasNpxFallback: true` provider with `installed: false` may still be usable if the `npx` probe below reports `versionOk: true`.
- **`pi` CLI verdict fields** *(additive, intentd#1044 / monorepo#1662)* — the `pi` row additionally folds in a probe of the real `pi` CLI (the binary the pinned `pi-acp` adapter spawns — distinct from npx, which only launches the adapter). These fields appear **only** on the pi row, and only when it is not `gatedOff` (gated rows are never probed). The probed pi row **always** carries `cliCommand` (the command probed: a non-empty `PI_ACP_PI_COMMAND` daemon-env override, else bare `pi`), `cliResolved` (whether the command resolved to an executable), `cliVersionOk` (`true` **iff** the probe confirmed the minimum version or newer), and `cliRequirement` (the human-readable requirement, `"Pi CLI 0.80.4+"`). `cliResolvedPath` (absolute path) is present only when the CLI resolved, and `cliVersion` (the trimmed first line of `pi --version` output) only when the version probe succeeded — both **omitted (never null)** otherwise. A bare command name is resolved against the **spawn-time enhanced PATH** (npx's parent dir and `~/.augment/bin` ahead of the enriched/inherited dirs), so the probe reports the same binary the spawned pi-acp child would actually exec.
- **`pi` CLI gating** — a **missing** or **confirmed-too-old** CLI marks the pi row unavailable (it never sets `gatedOff`, which stays reserved for the env-var/feature-code mechanism above): `installed` is forced to `false` and `unavailableReason` (optional string, pi row only) carries an actionable message naming the found version (when too old), the requirement, and the adapter pin (e.g. `"pi CLI not found — Pi CLI 0.80.4+ is required by pi-acp@0.0.33"`). An **inconclusive** probe — spawn failure, timeout, unparseable `--version` output, or a relative separator-carrying `PI_ACP_PI_COMMAND` override that did not resolve from the daemon's CWD — is **permissive**: the daemon logs a WARN and does not gate, so `cliVersionOk` is `false` but `installed` is untouched and `unavailableReason` is omitted (a changed `--version` format never false-negatives the provider). Invariant: `unavailableReason` present ⇒ `installed: false` and `cliVersionOk: false`. The same gate fails agent creation fast with a clear error (instead of a silent hang) when a Pi agent is spawned against a missing/too-old CLI.
- `npx` reports the daemon's npx probe: `resolvedPath` is `null` when npx is not found; `version` is `null` when npx is missing **or** the version probe fails (a failed probe leaves `resolvedPath` set); `versionOk` is whether the resolved version meets the minimum requirement (`false` whenever `version` is `null`).

### Method aliases (2 total)

The daemon accepts these 2 alias forms and dispatches them to their canonical counterparts. The wire accepts both, but the canonical name is the documented form.

- `git.diff` → `git.diffs`
- `git.log` → `git.commits`

### Client-served reverse RPCs (4 total)

Of these 4 method names, `browser.exec` and `host.openInEditor` are **client-callable triggers**: the daemon validates the envelope, then serves the request. `browser.exec`'s real work always happens on the connected frontend via a reverse RPC (synthetic `rev-<n>` request id) whose result is echoed back to the original caller. `host.openInEditor`'s real work happens on the daemon host on a local connection (no reverse RPC is dispatched, §5.14) and on the connected frontend via that same reverse RPC mechanism on a remote connection. These 2 method names are **dual-role**: they appear in the dispatchable method catalog AND are also issued daemon→client as reverse RPCs on remote connections. `host.openExternal` and `host.pickApplication` are **daemon→client-only**: they are never dispatched client→server and do not appear in the dispatchable method catalog. On a remote connection the daemon is always the requester (synthetic `rev-<n>` id) and the connected client returns the result; on a local connection the daemon serves the intent directly on the daemon host without a reverse dispatch (§5.14).

- `browser.exec` — browser automation (Chrome DevTools) — §5.9 (dual-role)
- `host.openExternal` — open a URL in the default browser — §5.14 (daemon→client only)
- `host.openInEditor` — open a file or directory in the user's editor — §5.14 (dual-role)
- `host.pickApplication` — prompt the user to select an application — §5.14 (daemon→client only)

> **Internal, not wire (Code Changes Review).** Diff computation/versioning (`diffs.*`), agent-attribution `trackChange`, and metrics aggregation (`metrics.calculate` and the `update*` writers) run **entirely inside the backend** with no client RPC. Diff bodies are computed/stored internally and surfaced through the `file-tracking.*` reads (§5.19) plus the change events in §6.5 — clients never call a `diffs.*` method. See the cross-cutting principle in §6.8.

> **Internal, not wire (Agent Ecosystem).** Rule **injection** — assembling the system prompt from workspace files (`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization rules, and user overrides — runs **inside the backend** as agents start; only the `rules.*` read/edit methods (§5.21) cross the wire. Per-agent-type tool **denylisting** is likewise internal enforcement — there is **no** `agent.getAvailableTools` RPC. Long-term agent **memories** are an internal context source consumed by the agent runtime; no `memories.*` wire surface is exposed (see §5.22). See §6.8.

> **Internal, not wire (Integrations & Ops).** Token/credit **usage accounting** runs **inside the daemon**: usage is tallied **live** at ACP turn end from `PromptResponse.usage`, with a periodic **reconciliation scan** as fallback (§5.23); clients never trigger either — they read the result via `workspace.getTokenUsage` (§5.23) and are pushed `workspace:tokenUsage-changed`. **Observability** (tracing, structured logs, log files) is likewise daemon-internal: there is **no** `logging.*` / `telemetry.*` wire surface. See §6.8.

> Deprecated aliases. agent.subscribe/agent.unsubscribe and event.subscribe/event.unsubscribe exist in the method map but are not the canonical WebSocket subscription surface. For live event streaming use the bridge methods events.subscribe / events.unsubscribe (note the plural events.), handled directly by the server before the dispatcher — see §6. The agent./event.* variants create internal/agent-style subscriptions and do not wire a WebSocket client up to events.event notifications. (A bare `{ workspaceId }` `agent.subscribe` frame instead routes to the agent collection channel — see §6.9.)

Conventions used below: parameters marked **(req)** are required (a missing/`null` value yields`-32602 "Missing required parameter: <name>"`). Unless stated otherwise, every method also requires`workspaceId` (see §3.6) and may return `-32603 Internal error` if the underlying service throws.

### 5.1 `workspace.*`

| Method | Params | Result |
| --- | --- | --- |
| workspace.list | includeArchived?: boolean (default false) | { workspaces: Workspace[] } — triggers background backfill: existing workspaces with a repositoryPath but missing repositoryOwner/Name are enriched from the origin remote URL (same GitHub derivation as workspace.create, non-blocking spawn, deduped per workspace per daemon lifecycle, skips non-GitHub remotes, persists updates, emits workspace:updated with changed fields) |
| workspace.get | workspaceId (req) | { workspace: Workspace } — -32602 if not found |
| workspace.create | workspace fields (incl. repositoryPath?, baseRef?, branch?, remote?, skipIsolation? (canonical; deprecated alias skipWorktree?), githubUrl?, clonePath?, isNewRepo?, progressId? (string — arms the unified provisioning progress stream; see notes)); optional initialAgent: { prompt, name?, model?, specialist?, provider?, behaviorPrompt?, agentType?, imageBlocks?, fileBlocks? *(v6.12; same per-entry exactly-one-of-`data`/`attachmentId` validation as `agent.sendMessage`, `-32602` before any side effect — §5.5)*, metadata? } — no `agentId`: agent IDs are server-assigned, and a request carrying `initialAgent.agentId` is rejected with `-32602` (see notes) | { workspace: Workspace, initialAgent?: AgentLite } — the created agent's server-minted id is `initialAgent.id`; daemon-owned orchestration inside one idempotent op (see notes: clone → checkout (worktree or CoW) → spec seed → initial agent). |
| workspace.update | workspaceId (req) + fields to change — the skip toggle uses the same wire names as create: skipIsolation? (canonical; deprecated alias skipWorktree?, either set ⇒ same behavior); the `workspace:updated { changes }` delta serializes it under the canonical skipIsolation name; `statusImageAssetId?: string \| null` is clearable (missing = untouched, `null` = clear, string = set — see the `statusImageAssetId` notes below) | { workspace: Workspace } |
| workspace.delete | workspaceId (req), undoDelayMs? *(v6.7)* | { success: true } — fast-ack: returns immediately after deleting the database row and emitting `workspace:deleted`, while filesystem cleanup runs in a background task — only the git-metadata phase (worktree-registration prune + rename of the checkout to a trash path + guarded branch delete; a CoW or `direct` checkout — a standalone clone with no registration in the source repo and a branch living only inside the clone — gets just the rename, no prune and no source-repo branch delete, and **only when it sits in the daemon-owned `<root>/<workspaceId>/<repo-slug>` layout**: a standalone checkout outside that layout — the `isNewRepo` direct shape, where the checkout IS the user's chosen repository folder (§5.1) — is left untouched, deletion removes only the workspace row) holds the per-repository lock; the recursive `remove_dir_all` of the renamed trash directory runs afterwards outside the lock. **Delete grace window (v6.7, [intent-hq/intentd#1096](https://github.com/intent-hq/intentd/pull/1096)):** `undoDelayMs > 0` (non-negative integer; a non-integer value is `-32602`; values above the 60 000 ms cap are silently clamped, never rejected — `deleteAt` reflects the clamped value) schedules an **in-memory** pending deletion instead of committing — returns `{ success: true, scheduled: true, deleteAt }` (ISO commit deadline), emits `workspace:delete-scheduled { workspaceId, deleteAt }` (§6.5), and serves `pendingDeleteAt` on the row until the deadline commits the real delete (which then runs the full teardown above) or `workspace.cancelDelete` cancels it. Absent, `null`, or `0` keeps the immediate-delete behavior byte-identical. Pending deletions are never persisted (a daemon restart drops them; the workspace survives); re-scheduling is idempotent under the registry lock (returns the existing deadline, no second timer); a committed workspace delete supersedes pending agent deletes inside the workspace |
| workspace.cancelDelete *(v6.7)* | workspaceId (req) | { cancelled: boolean } — cancels a pending (grace-window) deletion scheduled by `workspace.delete` with `undoDelayMs`. `true` clears the pending deletion, emits `workspace:delete-cancelled { workspaceId }` (§6.5), and drops `pendingDeleteAt` from the row; `false` is the race-safe non-error when no deletion is pending (never scheduled, already cancelled, or already committed) |
| workspace.archive | workspaceId (req) | { workspace: Workspace } — returns the refreshed record with `archived: true` / `status: "Archived"` / `archivedAt` set, so callers do not need to follow up with `workspace.get`. Emits `workspace:updated` with the full applied delta `changes: { archived: true, status: "Archived", archivedAt: <ts> }` where `<ts>` is the same ISO timestamp persisted on the row (§6.5). **Archive stops active work** ([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896); PR monitors: [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)): in-flight agent turns are gracefully interrupted, ACTIVE background hooks and ACTIVE PR monitors (§5.42) are cancelled, and queued messages/wakes park while the workspace stays archived — see the archive active-work teardown block below. -32602 if not found. |
| workspace.unarchive | workspaceId (req) | { workspace: Workspace } — mirror of `workspace.archive`; returns the refreshed record with `archived: false` / `status: "Active"` and `archivedAt` cleared. Emits `workspace:updated` with `changes: { archived: false, status: "Active", archivedAt: null }` — an explicit JSON `null` so clients clear the field (§6.5). Re-kicks the queue drains parked by the archived gates so parked messages deliver without a manual kick; cancelled hooks and PR monitors are NOT resurrected (see the archive active-work teardown block below). The same delta shape is also emitted by the turn-start **auto-unarchive** (see the auto-unarchive block below), which additionally stamps the additive `autoUnarchive` field into `changes` — the stamp is never present on this manual path (or `workspace.restore`). -32602 if not found. |
| workspace.dismissAttention | workspaceId (req) | { workspace: Workspace } — clears `attention` to `"none"`; -32602 if not found |
| workspace.markSeen | workspaceId (req) | { workspace: Workspace } — marks the workspace seen (clears unread `attention`) |
| workspace.getContext | workspaceId (req) | { items: ContextItem[] } — persisted chat-context attachments for the workspace; empty array before the first save. -32602 if the workspace is absent. |
| workspace.updateContext | workspaceId (req), items (req): ContextItem[] | { items: ContextItem[] } — atomic full-list replacement (matches the FE's `hydrate/add/remove/update` collapsed to a single authoritative-list write). Order is preserved. Emits `workspace:context-changed` with the persisted list. -32602 on missing workspace, malformed `items`, or an item with an empty `id`. |
| workspace.getAutoCommit *(v2.7)* | workspaceId (req) | { autoCommit: { enabled: boolean, source: "workspace" \| "global" } } — the effective per-workspace auto-commit state: the persisted workspace override when set (`source: "workspace"`), else the current global `git.autoCommit` setting (`source: "global"` — pre-migration rows and the virtual Chief workspace). -32602 if the workspace is absent. |
| workspace.setAutoCommit *(v2.7)* | workspaceId (req), enabled (req): boolean | { autoCommit: { enabled: boolean, source: "workspace" } } — echoes the persisted override (`enabled` is the boolean just written; `source` is always `"workspace"`), persists it across daemon restarts, and emits `workspace:updated` with `changes: { autoCommitEnabled: boolean }` (§6.5). -32602 on missing workspace, missing/non-boolean `enabled`, or the virtual Chief workspace. |
| workspace.diskUsage *(v4.2)* | workspaceId (req) | { diskUsage?: { bytes, fileCount, computedAt, breakdown }, refreshing: boolean } — on-demand poll of the workspace's cached whole-directory disk footprint (see the workspace-disk-usage block below for the payload shape and cache semantics). `diskUsage` is **omitted** (absent, never `null`) until the first walk completes and for non-qualifying rows; `refreshing: true` means a background walk is in flight (stale or first-ever poll — poll again shortly). Non-qualifying workspaces — remote, skip-isolation, the virtual Chief workspace, or a never-provisioned directory — answer `{ refreshing: false }` with the field omitted, without arming a walk. -32602 if the workspace is absent. |
| workspace.transfer.plan *(v6.6)* | workspaceId (req) | { plan: TransferPlan } — read-only transfer preview for the Transfer/Download feature ([intent-hq/intentd#1092](https://github.com/intent-hq/intentd/pull/1092)): `plan.manifest` is the versioned export manifest — `{ formatVersion, creatingIntentdVersion, workspaceId, createdAt, tables: [{ name, rowCount, approxBytes }], assets: [{ id, sizeBytes }], git: { hasRepository, branch?, dirtyFiles, sandboxBranches } }`, where `formatVersion` is `TRANSFER_FORMAT_VERSION` (currently 1; the import side refuses archives whose format version it does not understand), `creatingIntentdVersion` is the exact daemon version (`CARGO_PKG_VERSION`; import gates on exact match), `tables` covers every workspace-scoped table with the `event` table deliberately excluded (event history stays on the source; `approxBytes` sums column byte lengths cast to BLOB — a serialized-payload estimate, not on-disk size), and `git.branch?` is omitted when unresolvable — plus the additive `attachments: [{ id, fileName, sizeBytes, exists }]` manifest list (attachment-transfer support): one entry per `attachments`-registry row (§5.9), probing the stored file in the workspace's canonical `.intent/attachments/` store at plan time — `exists: false` (with `sizeBytes: 0`) marks a row whose file was already deleted (deleted-is-deleted is a first-class state: the row transfers, no file rides, and a missing file never fails a plan or an export) — plus the size estimate `totalSizeBytes = dbRowBytes + assetBytes + attachmentBytes + estimatedGitBundleBytes` (bundle estimated via `git rev-list --disk-usage`; each addend also served — `attachmentBytes` sums only the attachment files the archive will actually carry) and the non-blocking pre-flight `warnings: [{ code, message }]` (`code` machine-readable and stable — e.g. agents running, uncommitted changes, unmerged sandboxes). No side effects; the virtual Chief workspace is rejected. -32602 if the workspace is absent |
| workspace.import.begin *(v6.9)* | manifest (req, object), archiveSizeBytes (req, u64), archiveSha256 (req) — no workspaceId (the target id lives inside the manifest) | { importId, maxChunkBytes } — opens a staged workspace import of a transfer zip archive ([intent-hq/intentd#1101](https://github.com/intent-hq/intentd/pull/1101); the target-side counterpart of `workspace.transfer.plan`). Validates the manifest header BEFORE any bytes are staged: `formatVersion` must be understood, `creatingIntentdVersion` must match this daemon's `CARGO_PKG_VERSION` **exactly** (the error names both versions), the virtual Chief workspace is rejected, and the manifest's workspace id must not collide with an existing row OR another pending import. Staging lives under `<workspaces_root>/.import-staging/<importId>/`; `maxChunkBytes` is the per-chunk decoded cap (16 MiB, under the 40 MiB frame cap) |
| workspace.import.chunk *(v6.9)* | importId (req), seq (req, u64), data (req, base64) | { importId, seq, receivedBytes } — stages one seq-numbered slice of the archive as a per-seq file. Chunks may arrive in any order; retrying a seq is **idempotent** (per-seq overwrite, no double-count); the declared `archiveSizeBytes` guards against over-staging |
| workspace.import.commit *(v6.9)* | importId (req) | { workspace, importedRows, interruptedAgents, rehydrated } — reassembles the staged chunks → verifies the SHA-256 against `begin`'s `archiveSha256` → unzips (zip-slip-safe extract) → checks the embedded manifest equals the `begin` manifest → applies row transforms (path rewrite against the target `workspaces_root`, agent sessions forced to stopped with `interrupted_agent` rows for in-flight agents, `event` rows skipped) → git materialization → attachment materialization (each `attachments/<attachmentId>` archive entry lands at the `stored_path` its registry row records, resolved against the materialized checkout with the within-workspace containment guard — an escaping `stored_path` fails the commit — dropping the ignore-all `.gitignore` marker in the store dir; a registry row with no archive entry is the deleted-is-deleted state and imports as a row without a file; a later failure unwinds every placed file) → single-transaction row insert + asset placement → boot-style rehydration (hooks, event subscriptions, PR monitors). **Atomic:** nothing is visible in `workspace.list` until commit succeeds |
| workspace.import.abort *(v6.9)* | importId (req) | { importId, aborted } — deletes the staged session and its staging directory; idempotent (`aborted: false` when the session no longer exists, not an error) |
| workspace.export.start *(v6.11)* | workspaceId (req) | { exportId, maxChunkBytes } — opens the source-side export of the FE-mediated workspace transfer ([intent-hq/intentd#1118](https://github.com/intent-hq/intentd/pull/1118); the source counterpart of the v6.9 `workspace.import.*` surface) and kicks off the background archive build — the result returns immediately, and progress/outcome travel on the `workspace:transfer:*` events (§6.5). Build stages (each emits `workspace:transfer:progress` before it runs): `stopping-agents` — in-flight agents are captured as pending `interrupted_agent` rows BEFORE the stop (they ride the archive as the target's resumption offers, and equally cover the source if the export is aborted; durable queues untouched) — then `exporting-rows` — the manifest (built by the `workspace.transfer.plan` op; the copy embedded in the zip byte-matches the one the `:ready` event carries) plus the row export — then `bundling-git` (skipped when the workspace has no repository; a dirty worktree and live sandboxes are snapshotted as WIP commits that stay in place while the archive is served and are unwound when the export settles) — then `writing-archive` (zip sealed + SHA-256 hashed). Archive layout (shared with the import side): `manifest.json`, `rows/<table>.jsonl` (only tables with rows), `assets/<assetId>`, `attachments/<attachmentId>` (the registered attachment files that still exist in the git-ignored `.intent/attachments/` store — they never ride the git bundle, so the archive carries them explicitly; a registry row whose file was deleted rides the rows payload with no file entry, and a file that vanishes between plan and write is skipped with a warning, never an export failure), and — when the workspace has a repository — `git/repo.bundle` + `git/refs.json`. Staging lives under `<workspaces_root>/.export-staging/<exportId>/`; sessions are **in-memory only** (a daemon restart drops them; the boot/lazy sweep clears orphaned staging dirs). `maxChunkBytes` is the per-chunk pre-base64 cap (16 MiB, matching the import side so the FE can pipe `read` chunks straight into `workspace.import.chunk`; the encoded frame stays under the 40 MiB cap, §1.3). -32602 on the virtual Chief workspace, an unknown workspaceId, or a second concurrent export of the same workspace (the error names the in-flight exportId) |
| workspace.export.read *(v6.11)* | exportId (req), seq (req, u64) — no workspaceId (the export session, addressed by `exportId`, already binds the workspace) | { exportId, seq, totalChunks, data } — serves one seq-numbered chunk of the sealed archive as base64. **Idempotent**: any seq may be re-requested in any order (same seq, same bytes). -32602 while the session is still building (wait for `workspace:transfer:ready`), on an out-of-range seq (the error names the chunk count), or on an unknown exportId |
| workspace.export.finalize *(v6.11)* | exportId (req), archiveSource? (bool, default false), finalStatusMessage? (string) — no workspaceId (export-session-scoped, like `workspace.export.read`) | { exportId, finalized: true, workspace } — settles the source after a successful relay: applies the optional final status message, archives the workspace when `archiveSource: true` (otherwise it stays active), then unwinds the WIP snapshot commits and deletes staging. The workspace mutations run BEFORE the session is retired, so a failed mutation leaves the export intact and finalize can be retried. Only valid on a ready session — -32602 while still building or on an unknown exportId |
| workspace.export.abort *(v6.11)* | exportId (req) — no workspaceId (export-session-scoped, like `workspace.export.read`) | { exportId, aborted } — cancels an export: a still-building session is flagged and the build task cleans up when it next checks between stages (quiet — no `workspace:transfer:failed`); a ready session is cleaned up inline (WIP snapshots unwound, staging deleted). **Idempotent** — an unknown exportId returns `{ aborted: false }`, not an error. The workspace stays usable; agents stay stopped (the user restarts them) |

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "workspace.list", "params": { "includeArchived": false } }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "workspaces": [ { "id": "ws-abc", "title": "My Workspace" } ] } }
```

**Branch naming (`workspace.create`).** An explicit `branch` is used untouched. Otherwise
the daemon auto-names the branch with a friendly `word-word` slug (TS parity): extracted
from `initialAgent.prompt` via local keyword heuristics when possible (`generateLocalSlug`
— e.g. "fix the auth flow" → `auth-fix`), else a random adjective-animal pair
(`generateWorkspaceSlug` — e.g. `amber-forest`). The `workspace.branchPrefix` setting
(§5.12), when set, is prepended (e.g. `aw/auth-fix`). When `repositoryPath` is a local git
repository the name is uniquified against existing local and remote-tracking branches by
appending `-2`, `-3`, … until free. The branch is never the raw workspace UUID.

**Workspace id (`workspace.create`).** The daemon derives the workspace id as a friendly
`word-word` slug (extracted from `initialAgent.prompt` when possible, else a random
adjective-animal pair), uniquified with a `-2`, `-3`, … suffix whenever the candidate id was
**ever** used — a live workspace, a previously deleted workspace (persisted delete
tombstone), or a leftover `<root>/<id>` directory on disk. Ids are therefore never recycled
across delete/recreate (reuse would collide the old workspace's agent streams and file
paths with the new one's); callers must use the id returned in the `workspace.create`
result rather than predicting it.

**Worktree provisioning (`workspace.create`).** When `repositoryPath` points at a local git
repository, the daemon provisions a linked worktree before persisting the row (TS
`createGitWorktree` parity): the worktree lives at
`<root>/<workspaceId>/<repo-slug>` — `root` is `$INTENTD_WORKSPACES_DIR`, else
`~/intent/workspaces` (the FE's `WorkspaceConfig.WORKSPACES_BASE`); the slug is the
slugified `repositoryName` (basename fallback) — checked out on the workspace `branch`
(auto-named as above when not supplied), created from `baseRef` resolved as
`refs/remotes/<remote>/<baseRef>` (remote defaults to `origin`) → `refs/heads/<baseRef>` →
any rev-parsable spec, else `HEAD`. No network fetch is performed — the base resolves from
local state. The returned `Workspace` carries `worktreePath`, `baseCommitSha` (the
checked-out tip), and `checkoutMode` (`"worktree"` here; see the CoW and cache-hydration
notes below). An
unresolvable `baseRef` on a valid repo fails with `-32602` carrying the
`base-ref-unresolvable` `error.data` payload (§9).
Provisioning is skipped — prior row-only behavior — for `skipIsolation: true`
(canonical name; `skipWorktree` is accepted as a deprecated alias, either set ⇒ direct
mode), `isRemote: true`, a caller-supplied `worktreePath`, a missing `repositoryPath`, or
a `repositoryPath` that is not a local git repository (unless `isNewRepo: true`
initializes it first — see new-repository initialization below). `workspace.update` follows the
same rename: `skipIsolation` is the canonical param (deprecated alias `skipWorktree`),
and the persisted column keeps its historical `skip_worktree` name
(`Workspace.skipWorktree`) — the rename is wire-level only, no migration.

**CoW checkout provisioning (`workspace.create`, new in intentd).** The
`workspace.cowIsolation` setting (§5.12, boolean, default `false`) selects the checkout
mode, persisted on the returned `Workspace` as `checkoutMode`
(`"worktree" | "cow" | "direct"`; omitted whenever provisioning was skipped per the
conditions above — see the cache-hydration and new-repository notes below for the
`"direct"` producers). Off ⇒ the
linked-worktree behavior above (`checkoutMode: "worktree"`). On ⇒ the daemon first
probes CoW support from the repository directory to `<root>/<workspaceId>`: when
supported, the checkout is a **standalone copy-on-write clone** of the whole repository
directory (OS reflink primitives — macOS `clonefile(2)` whole-tree fast path with best-effort
walk fallback, Linux `ioctl(FICLONE)`) instead of a linked worktree, carrying deps/build artifacts
(`node_modules`, `target`, …) into the checkout for free; inside the clone the workspace
`branch` is created + checked out from the same `baseRef` resolution order as above,
tracked files are hard-reset to that base, untracked files are preserved, and the row
persists `checkoutMode: "cow"`. When the probe reports Unsupported (or errors) — e.g.
the repository lives on a different volume than the workspaces root, since reflinks
cannot cross filesystems — the create **falls back to the linked-worktree path**
(`checkoutMode: "worktree"`, normal worktree provisioning) with a logged warning
instead of failing: `workspace.cowIsolation` is a preference, not a guarantee. Because
a CoW checkout is a standalone clone, `workspace.delete`'s git-metadata phase skips the
worktree-registration prune and the source-repo branch-delete guard (the workspace
branch lives only inside the clone); the checkout is still renamed to a trash path and
removed in the background as usual.

**Duplication (`workspace.duplicate`).** Duplicating a local workspace off a local git
repository provisions a fresh checkout for the copy at `<root>/<newId>/<repo-slug>` on a
branch named for the new id (uniquified against the source repo's local and
remote-tracking branches). The decision depends on whether the **source** checkout is
standalone:

- **Standalone source** (the source's own `checkoutMode` is `"cow"` or `"direct"`, which
  includes every cache-hydrated workspace and an `isNewRepo` `direct` workspace): the
  duplicate is **always standalone too, and never a linked worktree**. The clone source
  is the source's **own checkout** (`worktreePath`, or `repositoryPath` when the
  repository itself is the checkout), not the source's `repositoryPath`. A CoW probe from
  that checkout to `<root>/<newId>` decides the mode: supported ⇒ CoW clone
  (`checkoutMode: "cow"`); Unsupported ⇒ a **plain local `git clone`** of the source
  checkout (`checkoutMode: "direct"`), and the same local-clone fallback is taken — with a
  logged warning — on a probe error or when a CoW clone still reports Unsupported despite a
  passing probe. A source checkout whose `.git` is a gitfile skips the probe and goes
  straight to the local clone (also warned). `workspace.cowIsolation`
  is **ignored** for standalone sources (parity with cache-hydrated create). Like a
  hydrated create, the checkout *is* the repository: the duplicate persists
  `repositoryPath` = its **own** checkout path, so nothing in the row references the source
  workspace's directory. The `direct` local-clone path additionally **resolves `origin`**
  (a CoW clone is a byte copy and keeps the source's `.git/config` verbatim): a network URL
  and an absolute local path carry over as-is, a relative local path is absolutized against
  the source repository so it still names the same upstream, and the remote is **removed**
  when the source has no `origin` or when `origin` resolves to the source checkout itself.
  The local-clone fallback carries **committed state only** —
  uncommitted/untracked work in the source is not copied. Rationale
  ([intent-hq/monorepo#1560](https://github.com/intent-hq/monorepo/issues/1560)): a linked
  worktree rooted in a sibling workspace's checkout is orphaned when that workspace is
  deleted (the checkout dir is detached), and deleting the duplicate would mutate the
  source's checkout.
- **Shared-checkout source** (no `checkoutMode` — a worktree-mode or shared workspace):
  the **same decision matrix as `workspace.create`** applies against the source's
  `repositoryPath` — `workspace.cowIsolation` off ⇒ linked worktree
  (`checkoutMode: "worktree"`); on ⇒ CoW probe from the repository directory to
  `<root>/<newId>` — supported ⇒ standalone CoW clone (`checkoutMode: "cow"`),
  Unsupported/probe error ⇒ fall back to a linked worktree with a logged warning.

Provisioning is skipped for remote / skip-isolation sources and when the resolved source
directory is not a local git repository. An ordinary provisioning failure is logged and
swallowed (FE parity — "continue without worktree"): the row persists without
`worktreePath`/`checkoutMode`. For a standalone source the inherited `repositoryPath` is
also **cleared** in that case, so a checkout-less duplicate never points at the source
workspace's directory.

**`checkoutMode` is immutable.** `workspace.cowIsolation` is consulted **only** at
provisioning time (`workspace.create` / `workspace.duplicate`); the resulting
`checkoutMode` is persisted on the row and never changes for the life of the workspace.
Toggling the setting later affects only subsequently created workspaces — existing
checkouts are not converted.

**Cache-hydrated creation (`workspace.create`, new in intentd —
[intent-hq/intentd#944](https://github.com/intent-hq/intentd/pull/944)).** When
`githubUrl` is set, `repositoryPath` is not already a local git repository, and the
caller supplies **no** `clonePath`, the daemon provisions the workspace from a hidden,
daemon-managed **repo cache** instead of cloning into `<workspaces_root>/clones/`. The
cache lives at `<workspaces_root>/.repo-cache/<owner>/<repo>` (dot-prefixed so it stays
invisible to users and to recent-repo derivation) and holds a read-only clone with the
remote's default branch checked out. Flow:

1. **Ensure the cache** — the only network-bound phase. Cache miss ⇒ full clone; cache
   hit ⇒ `git fetch --prune origin`, `git remote set-head origin --auto` (a fetch alone
   never re-resolves `origin/HEAD`, so an upstream default-branch change is picked up
   here), a hard reset to that remote default branch, and `git clean -fdx` (a hard reset
   alone leaves untracked pollution — e.g. from a process killed mid-checkout — that
   would be byte-copied into every hydrated checkout).
   **Refresh never fails the flow:** any anomaly (diverged history, corrupt object store,
   an interrupted prior clone, a vanished `origin/HEAD`, or an `origin` that no longer
   matches the requested URL) deletes the cache directory and re-clones from scratch.
   Only a failed *clone* surfaces as an error. Concurrent creates for the same repo
   serialize on a per-repo lock; different repos never contend.
2. **Provision a standalone checkout** at `<root>/<workspaceId>/<repo-slug>` — the same
   location a linked worktree would use, but **never a linked worktree against the
   cache** (a cache refresh hard-resets/re-clones the cache directory, which would
   corrupt linked worktrees). A CoW probe from the cache into `<root>/<workspaceId>`
   decides the mode: supported ⇒ a copy-on-write clone of the cache
   (`checkoutMode: "cow"`, same reflink primitives as the CoW note above); unsupported,
   probe error, or a CoW clone that still reports Unsupported ⇒ a plain local
   `git clone <cache-path>` (`checkoutMode: "direct"`). Provisioning runs under the
   per-repo cache lock so a concurrent create's refresh cannot mutate the cache
   mid-copy.
3. **Detach from the cache.** `origin` is retargeted at the real GitHub URL (the checkout
   never references the cache, so deleting the cache is always safe), the cache's
   remote-tracking refs are copied in so any `baseRef` resolves, and the workspace
   `branch` is created + checked out with the same `baseRef` resolution order as the
   worktree path above.

The workspace's `repositoryPath` **is** the checkout (`worktreePath` carries the same
path), `baseCommitSha` is the checked-out tip, and `repositoryOwner`/`repositoryName`
derive from the URL when the caller left them blank. Progress streams through the same
`git:clone:progress` / `git:clone:done` frame shapes as a network clone (scoped to the
newly minted `workspaceId`). Without a `progressId` the legacy framing applies: **synthetic
milestones** rather than parsed git percentages — `starting` at 0% before the cache
ensure, `checkout` at 90% once the cache is ready, then the terminal `git:clone:done` —
the local checkout provisioning that follows emits nothing, matching the legacy flow
where worktree provisioning runs after `git:clone:done`. With a `progressId` the frames
route through the unified provisioning progress reporter instead (see the block below):
the cache ensure **streams real progress** — a cache miss's full clone parses git's
stderr phases (submodule-aware), a cache hit's refresh emits per-step `cache` /
`submodules` milestones (fetch, branch reset, submodule sync/update, clean) — followed
by the provisioning-tail milestones (`cow-copy` / `checkout`, streamed `submodules`
population on the `direct` arm, `finalizing`), with the terminal `git:clone:done` owned
by the create wrapper. A cache failure fails the whole create pre-insert with the
same clone-failure taxonomy as below (no row persisted, no `workspace:created`).
Hydration is skipped — the legacy network clone below applies unchanged — for an
explicit non-empty `clonePath`, a URL carrying no `owner/repo` pair, and creates that
provision no checkout (`isRemote: true`, `skipIsolation`/`skipWorktree`, or a
caller-supplied `worktreePath`).

**Clone orchestration (`workspace.create`).** When `githubUrl` is set,
`repositoryPath` is not already a local git repository, and cache hydration above does
not apply, the daemon clones the URL
before branch naming and worktree provisioning, reusing the streaming `git.clone`
pipeline (§5.6) — with `--recurse-submodules` (new in intentd,
[intent-hq/intentd#1069](https://github.com/intent-hq/intentd/pull/1069)), so the
checkout lands with populated submodule work trees like the repo-cache path, and the
progress stream can carry an aggregated `submodules` phase ("Cloning submodules (N/M)")
after the superproject phases — the create-orchestrated clone is the only caller that
recurses; the standalone `git.clone` RPC (§5.6) is unchanged. The clone target is the
caller-supplied `clonePath` when non-empty,
else `<workspaces_root>/clones/<derived-repo-name>` (basename of the URL with a trailing
`.git` stripped, matching `git clone` defaults); a pre-existing target fails the create
with `-32602` and `error.data = { code: "destination-exists-non-empty", detail }`
(clone failure taxonomy, §9). A leading `~` / `~/` in the caller-supplied `clonePath` or
`repositoryPath` expands to the daemon user's home directory before the existing-repo
check, clone targeting, and persistence (`~user` forms pass through unchanged) — git
would otherwise treat the tilde as a literal `./~` directory, which fails on the
packaged sidecar's read-only cwd. The persisted `repositoryPath` is always the
post-expansion value (identical to the input whenever expansion does not apply).
Expansion is best-effort: it is `/`-separated only, and when the daemon cannot resolve
a home directory from its environment it is a no-op — the verbatim tilde path is then
used as-is, so the clone fails as before (and per the clone-failure rule below, no row
is persisted). Progress streams as `git:clone:progress` frames and terminates in exactly
one `git:clone:done` — both scoped to the newly minted `workspaceId`; with a
`progressId` the frames route through the unified provisioning progress reporter below
(normalized percent, `data.progressId` echo, terminal done owned by the create wrapper) —
and a `git clone`
failure fails the whole `workspace.create` (no row persisted, no `workspace:created`)
with a classified error from the clone failure taxonomy (§9): the numeric code is
`-32602` for user-fixable inputs (`path-invalid`, `destination-exists-non-empty`) or
`-32603` otherwise (`auth-required`, `network`, `clone-failed`), `error.message` is
`workspace.create clone failed (<category>): <detail>`, and
`error.data = { code: "<category>", detail }` where `detail` is the tail of git's
stderr with any `user[:pass]@` credential fragments redacted — clients render the
detail instead of a bare "Internal error" and key behavior off `error.data.code`.
On success the checkout becomes the workspace's `repositoryPath` and, when the URL
carries an `owner/name` pair (`github.com/OWNER/REPO(.git)?` on https or ssh), the
daemon best-effort derives `repositoryOwner`/`repositoryName` from it when the caller
left them blank. Independently of cloning, any create that ends up with a local
`repositoryPath` but no caller-supplied `repositoryOwner`/`repositoryName` best-effort
derives them from the local repository's `origin` remote URL (local git config read only,
no network) when the remote is a GitHub URL (https or ssh forms, strict `github.com` host
check); non-GitHub or missing remotes leave `repositoryOwner` unset. Caller-supplied
values always win; `repositoryName` persists the path basename as a last resort when blank.

**Unified provisioning progress (`workspace.create { progressId }`, new in intentd —
[intent-hq/intentd#1062](https://github.com/intent-hq/intentd/pull/1062),
[#1069](https://github.com/intent-hq/intentd/pull/1069)).** The optional `progressId`
parameter (string; trimmed, empty-after-trim treated as absent) is a **client-minted
correlation id** that arms a per-create progress reporter. Every `git:clone:progress` /
`git:clone:done` frame the create emits then echoes the id verbatim as
`data.progressId` (§6.5), letting the client correlate the asynchronous frames to its
own request without knowing the server-minted `requestId` or the not-yet-known
`workspaceId`. Absent a `progressId` the reporter is never constructed and every event
path behaves exactly as before (the field is additive; rollback-safe). With a reporter
armed:

- **One normalized 0–100 scale.** Percent is normalized across the whole provisioning
  pipeline into a single **non-decreasing** series: the network/cache segment maps into
  0–85 (superproject clone stderr phases into 0–70, aggregated submodule progress into
  70–85; the warm-refresh `cache` milestones span the whole 0–85 segment — its late
  steps, e.g. clean at 84 and "Repository cache ready" at 85, sit inside the 70–85
  band), and the local provisioning tail (checkout / CoW copy / worktree / finalizing)
  fills 85–100. Clone stderr phases are weighted inside their segment (receiving
  dominates; counting/compressing are cheap), the percent is clamped monotonically
  non-decreasing within the create, identical consecutive frames are deduped, and the
  clone's own terminal `complete` frame is re-labeled `checkout` at 85 ("Repository
  cloned") — only the create's own terminal frame carries `complete 100`
  ("Workspace ready").
- **Every mode emits.** Provisioning paths that historically streamed nothing emit
  coarse milestones through the same reporter: `starting 0` once armed, then per mode —
  a network clone streams the parsed git phases (plus the aggregated `submodules`
  phase); cache hydration streams the cache ensure for real (`cache` phase — a miss's
  full clone parses stderr, a hit's refresh emits per-step milestones for fetch/branch
  reset/submodule sync + update/clean) and then the provisioning tail (`cow-copy` or
  `checkout` at 88, streamed `submodules` population inside 89–94 on the `direct` arm);
  a local-repo create emits `worktree` ("Creating linked worktree...") or `cow-copy`
  ("Copying repository (CoW)...") at a nominal 30 (no clone segment ran before it; after
  a network clone the monotonic clamp lifts a later milestone into the 85+ tail
  automatically); an `isNewRepo` `direct` create emits `checkout` (branch checkout) at a
  nominal 50; every mode ends with `finalizing 95` before the row insert.
- **Exactly one terminal done.** The create wrapper owns the terminal frame: exactly one
  `git:clone:done` per create — `{ ok: true }` after the final `complete 100` on any
  successful create, `{ ok: false, error, errorCode? }` on any failure (sanitized detail,
  credential fragments redacted; `errorCode` present only for classified clone failures,
  §9.1) — in **every** checkout mode, including failures that occur before any
  clone/cache work started (an early config or idempotency-store error synthesizes a
  reporter so the stream still closes; no `workspaceId` exists yet on those paths, so
  that frame publishes under the empty sentinel id). **Idempotent replays emit
  nothing** — the cached success result is the answer; no progress or done frames are
  re-emitted.

**New-repository initialization (`workspace.create`, new in intentd).** When
`isNewRepo: true` (optional boolean, default absent/`false`), `repositoryPath` is not
already a local git repository, and no non-empty `githubUrl` is supplied — clone
orchestration above takes precedence — the daemon initializes the directory as a git
repository **before** branch naming and worktree provisioning, reusing the
`workspace.initializeRepository` body: `mkdir -p`, `git init -b main`, seeded
`.gitignore` + `README.md`, and an initial commit (git identity falls back to
`Intent <intent@local>` when no global identity is configured), so downstream
provisioning sees a real checkout. This is the FE's new-project flow (monorepo#962) —
it eliminates the silent row-only workspace the legacy skip produced for non-git
folders. `isNewRepo: true` with a missing/empty `repositoryPath` is rejected with
`-32602` (`repositoryPath is required when isNewRepo is true`) rather than falling
through to the row-only skip. An initialization failure fails the whole create
pre-insert — no row persisted, no `workspace:created` — with `-32603`,
`error.message = "Internal error"`, and the cause in
`error.data` (`workspace.create: repository initialization failed: <detail>`, §9).
`isNewRepo: true` on a path already carrying a git repository with a resolvable HEAD is
a no-op; when `.git` exists but HEAD does not resolve (a previously failed init left the
directory half-initialized), the init re-runs and completes it. Absent/`false` preserves
the legacy behavior: a non-git `repositoryPath` skips provisioning and persists a
row-only workspace (worktree-provisioning skip conditions above).
An `isNewRepo` create that would otherwise be provisioned persists
**`checkoutMode: "direct"`** (intentd#944): no worktree and no CoW clone is provisioned —
the workspace works directly in the initialized repository folder, where the workspace
`branch` is created (at `baseRef` when supplied, else from `HEAD`) and checked out so
agents land on `branch` as in every other checkout mode. `repositoryPath` **is** the
checkout and `worktreePath` carries the same path (standalone-row parity with cache
hydration, monorepo#2611 — previously `worktreePath` stayed unset, which left agent
spawn cwd resolution and the workspace file watcher without a checkout path). Because
the folder is user-chosen — never daemon-provisioned — `workspace.delete` removes only
the row: the standalone-checkout cleanup is gated on the daemon-owned
`<root>/<workspaceId>/<repo-slug>` layout, which the repository folder never matches.
The `"direct"` arm is gated on the same
provisioning-skip conditions as the worktree path above — an `isNewRepo` create with
`isRemote: true`, `skipIsolation`/`skipWorktree`, or a caller-supplied `worktreePath`
still initializes the repository but persists **no** `checkoutMode` and creates no
workspace branch.

**Spec note seeding (`workspace.create`).** Every successful create seeds the well-known
`spec` note in the new workspace (reference `notes.service.ts ensureSpecExists` parity):
id `"spec"`, title `"Spec"`, empty markdown body, tags `["spec"]`, pinned, default,
workspace visibility. The seed captures an initial `v1` version snapshot and publishes
`note:created` so subscribers see the standard note lifecycle. Seeding runs inside the
idempotency scope (§6.5) between `workspace:created` and initial-agent orchestration —
a replayed create returns the stored result and does not re-seed.

**Setup script execution (`workspace.create`).** The `setupScript` parameter is
**execute-only**: when supplied, the daemon executes the script as provided for that
creation (taking precedence over the committed repo config; an empty supplied script is
treated as omitted) but **never persists** it —
nothing is written to `<worktree-root>/.intent/config.json`, and the create path
performs no workspace DB `setup_script` write (the field is retired from all write
paths, kept for wire compat and legacy read-only fallback only). The worktree
`.intent/config.json` remains the sole persisted source of truth, mutated only by the
explicit write paths `workspace.saveSetupScript` (§5.25) and `repoConfig.save` (§5.33).
When the parameter is omitted, the effective script resolves via the unchanged
worktree-first `.intent/config.json` read with legacy DB fallback. FE contract:
cloudlands-fe always sends the script shown in the create form, except when it is the
unedited repo-config script (so the committed config stays authoritative); the
"last used for this repo" default is kept client-side. If an effective setup script
exists (non-empty), the daemon executes it non-blocking (fire-and-forget spawn) after
worktree provisioning in the worktree directory via
`/bin/sh` (POSIX; on Windows, via a discovered Git-for-Windows `sh.exe` running the same
POSIX wrapper, falling back to a `cmd.exe` `.cmd` wrapper that receives the script path
through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT` (repository root path), `WORKTREE_PATH`
(the new worktree path), `BRANCH_NAME` (workspace branch), and `SOURCE_BRANCH`
(baseRef when provided, empty string otherwise). Execution never fails workspace creation — errors are logged and
surfaced. Script output is streamed to a workspace terminal named **"Setup Script"**
(the PTY's daemon-tracked display name, surfaced by `terminal.list` — §5.9),
consistent with other workspace terminals. The script runs through a POSIX-sh timing
wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) that appends
a newline-prefixed completion summary to the scrollback —
`Setup script completed in <N>s (exit code <C>)` on success,
`Setup script failed in <N>s (exit code <C>)` on failure — preserving the script's
exit code.
The setup stage additionally publishes the **setup lifecycle events** (§6.5, additive):
`workspace:setup:started` fires iff an effective script was resolved and a spawn will
be attempted, and exactly one `workspace:setup:completed` fires per logical create on
every terminal path of the setup stage — script ran to exit (`ranScript: true` +
`exitCode`), spawn/pre-spawn failure (`ranScript: false`), no effective script,
`skipIsolation`/no worktree, and `workspace.duplicate` (immediate
`completed { ranScript: false }`). Idempotent replays publish nothing (same as
`workspace:created`). The daemon's own file watcher keys off the completion: a created
workspace's watcher registration (file watcher, git-metadata watcher,
skills/specialists) is **deferred** until `workspace:setup:completed` is observed for
it, so setup-script churn is dropped — never published, never buffered (no `file:*`
events exist for the setup window) — with a 60s backstop that starts the watchers
anyway (WARN) if no completion is observed; a script outliving the backstop emits its
remaining churn. A `workspace.open` during the setup window likewise supersedes the
deferral and starts the watchers immediately (the user is in the workspace), so a
still-running script's remaining churn surfaces from that point on.

**Initial-agent orchestration (`workspace.create`).** When `initialAgent` is supplied the
daemon minimally creates the agent session (honoring `name`/`model`/
`specialist`/`provider`/`behaviorPrompt`/`agentType`/`imageBlocks`/`metadata`) and
delivers the resolved `prompt` (blank/whitespace-only prompts are a no-op, no session).
An omitted `initialAgent.model` resolves through the same daemon-side creation-time
default-model chain as `agent.create` (§5.5 "Creation-time default-model resolution").
When `initialAgent.name` is omitted but a `specialist` is supplied, the agent's name
defaults to the specialist's resolved display name (frontmatter `name`, 3-tier
project > user > bundled — e.g. "Coordinator" for `spec-writer`) and counts as
explicitly set (it survives the agent's guarded opening-turn self-rename, same
rename-guard semantics as `agent.create` §5.5); an unknown specialist or a resolution
failure never fails the create — the name falls back to the generated
`Agent {6-hex}` placeholder (not explicitly set).
The agent's id is **server-assigned**: whenever a session is created the daemon mints a
fresh `agent-{uuid}`, and a request carrying `initialAgent.agentId` is rejected with `-32602`
("agent IDs are server-assigned and the field must be omitted") **before any side
effect** — no workspace row, worktree, spec seed, or `workspace:created` event is
persisted.
The result's `initialAgent` is the created session's full `AgentLite` projection (its
server-minted id is `initialAgent.id`); the agent's turn starts
asynchronously (fire-and-forget) but the create call is not idempotent unless a
`idempotencyKey` is supplied — a replay with the same key returns the stored result
(carrying the originally minted `initialAgent.id`) without re-creating the
session or re-delivering the prompt.
The daemon stamps the reference-parity `isInitialAgent`/`isFirstWorkspaceAgent` flags on
the created session's raw metadata JSON, and the strict `AgentLite.metadata` projection
surfaces `isInitialAgent?: true` (presence-detected, `true`-only — §5.5) on the
`initialAgent` result and every later `agent.list`/`agent.get` read of that agent;
agents created any other way omit the key.

**Archive active-work teardown (`workspace.archive` / `workspace.unarchive`)**
*([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896); behavior only,
no wire-shape change).* Archiving stops the workspace's active work without destroying
any of it — unlike the delete cascade below, nothing is deleted:

- **In-flight agents are gracefully interrupted.** After the archived row is persisted
  (so a concurrent queue-drain kick observes the flag and parks instead of respawning a
  turn), the daemon sweeps every agent with an in-flight turn in the workspace through
  the `agent.stop` keep-alive semantics (§5.5): the turn is cancelled over the wire, the
  draining worker is aborted, and the terminal `agent:stream:end` is emitted with
  `stopReason: "interrupted"` (§7). The provider child process, ACP session, session
  rows, transcripts, completion watches, and pending message queues all **survive for
  unarchive to resume**; no `agent:deleted` fires. Read-only wiring (no agent manager
  attached) still archives without error.
- **Queued messages and wakes park while archived.** Both gated delivery arms check the
  archived flag: the automatic queue drain and wake delivery (hook wakes,
  `agent.wakeOrCreate` context messages) refuse to start a turn in an archived
  workspace — entries stay parked in the pending queue (still visible via
  `agent.getQueue`, §5.5). Completion-watch wakes take a different arm
  (`send_message`) that carries no archived gate — a watched child completing elsewhere
  can still wake an idle parent in an archived workspace. The virtual chief workspace
  skips the row read (never archived), and a row-lookup error fails open so a transient
  store error cannot strand a queue. `workspace.unarchive` re-kicks the drain for every
  workspace agent with ready-to-send work (the drain re-checks its own gates), so
  parked queues deliver after unarchive without a manual kick.
- **Active background hooks are cancelled.** Every ACTIVE (`scheduled`/`running`) hook
  in the workspace (§5.40) goes through the `hook.cancel` machinery: scheduler task
  aborted, state persisted to `cancelled`, `hook:cancelled` emitted (§6.5), and the
  owner woken with an archive-specific notice — the wake itself parks behind the
  archived gate above, so it queues at most and never starts a turn while archived.
  Terminal hooks are untouched, and **unarchive does not resurrect cancelled hooks** —
  the notice ("This hook was cancelled because its workspace was archived.") explains
  why the watch stopped; the owner is expected to reschedule if the condition still
  matters. Best-effort per hook: a store failure is logged and the sweep moves on
  (archiving never fails because one hook row would not update).
- **Active PR monitors are cancelled** *([intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067); monorepo#1828)*.
  Every ACTIVE PR monitor in the workspace (§5.42) goes through the same core cancel
  transition as `prMonitor.cancel`, mirroring the hook sweep: state persisted to
  `cancelled` (guarded CAS — a concurrent cancel/complete winning the race is fine),
  `prMonitor:cancelled` emitted (§6.5), and the owner woken with an archive-specific
  notice ("This monitor was cancelled because its workspace was archived — it will not
  report again.") that parks behind the archived gate above. Terminal
  (`completed`/`cancelled`) monitors are untouched, and **unarchive does not resurrect
  cancelled monitors** — the owner re-registers via `ws.pr.monitor` if the PR still
  matters. Each cancel transition ends with the transition-only
  `workspace:displayStatus-changed` and `workspace:waiting-changed` recomputes (§6.5) —
  the drop lands with the sweep's last cancel — so an archived workspace no longer
  reads `waiting` indefinitely off a stale active-monitor signal (since v6.17 the
  monitor signal feeds the orthogonal `waiting` flag rather than the `displayStatus`
  promotion, §5.1 step 3).
  Fail-soft per monitor: one row's cancel failure is logged and never aborts
  the sweep or the archive.

One residual race is a deliberate trade-off: a drain that read the workspace row before
the archive persisted can claim the in-flight slot after the sweep's busy-list snapshot,
spawning one stray turn the sweep misses — the window is a few statements wide, the
stray turn runs to completion once, and every subsequent drain/wake parks behind the
archived gates, so the sweep accepts it rather than adding a post-claim re-check to the
hot drain path.

**Auto-unarchive on agent turn start**
*([intent-hq/intentd#1216](https://github.com/intent-hq/intentd/pull/1216); additive
event-payload field within v6.17).* Archiving is sticky against queued/background
activity but not against a **real turn start**: when an agent turn actually begins in an
Archived workspace — at the turn-start choke point where the in-flight slot is claimed,
covering direct sends, queue drains, wake deliveries, and send-now redrives, but never
mere enqueue (the archived gates above keep parking queued wakes) — the daemon
automatically flips the workspace back to Active through the same machinery as
`workspace.unarchive` (row flip, parked-queue drain re-kick, `lastActivity` derivation)
and publishes ONE `workspace:updated` delta (§6.5) whose `changes` additionally carry
the **additive** stamp:

```json
{
  "archived": false,
  "status": "Active",
  "archivedAt": null,
  "autoUnarchive": { "reason": "agent_activity", "agentId": "agent-…", "agentName": "…" }
}
```

`autoUnarchive` is **absent** on manual `workspace.unarchive` / `workspace.restore`
(absent ≠ present-false), so clients that predate the field see the previous delta shape
byte-for-byte; `agentName` is `null` when the agent's session-name lookup fails
(display-only — a lookup failure never blocks the unarchive). The virtual chief
workspace is skipped without a read, and the whole path is **best-effort**: a
workspace-read or unarchive failure logs a warning and the turn proceeds anyway — a
workspace stuck Archived is strictly better than a lost turn. Non-archived workspaces
pay one point read per turn start and nothing else. Concurrent turn starts are not
serialized: two agents winning the slot near-simultaneously in the same archived
workspace can each observe `archived: true` and both emit a stamped delta — the row
writes are idempotent, so consumers keying UI (e.g. a toast) on the stamp should dedup
per workspace. The residual-race stray turn above passes through the same choke point:
when its claim observes the already-persisted archived row it auto-unarchives like any
other turn start (only a claim that raced ahead of the archive persist still runs
archived once).

**Delete cascade (`workspace.delete`).** Before the store cascade drops the
workspace's `agent_session` rows, the daemon sweeps every live in-memory piece of
per-session state so recreating a workspace with the same slug never surfaces ghost agents
whose workers are still draining or whose completion watches are still firing:

- list the workspace's sessions via `store.list_agent_sessions` (a store error is
  propagated with `?` — a partial teardown is worse than a failed delete);
- per session, `AgentManager::stop` aborts the in-flight turn worker, drops the
  session handle (which calls `kill_child_tree` on the ACP child on drop),
  clears the busy flag + the `agent_ws` workspace mapping, and deregisters the
  process from the LRU registry;
- drop the session's live-turn slot and pending message-queue entry in
  `Services` (both are `HashMap::remove` calls, not a drain);
- sweep the daemon-global subscription registry: completion watches whose
  **parent** session lives in the deleted workspace and delegation groups
  anchored there are dropped outright. Cross-workspace watches (a `__chief__`
  parent elsewhere watching a child here) are instead **consumed
  deterministically**: per swept session the daemon delivers the synthetic
  `agent:deleted` completion directly and synchronously (not via the bus, and
  before the store cascade removes the `agent_session` rows) — waking the chief
  parent exactly once and recording grouped children as deleted — then
  backstop-sweeps any surviving watch whose `child_workspace_id` is the deleted
  workspace (in-memory entries and persisted `completion_watch` rows), so no
  watch can reference the deleted workspace as child afterwards. Each parent
  affected by the backstop sweep gets a refreshed `agent:subscriptions-changed`
  (§6.5) so clients converge on the shrunken watch set without polling;
- eagerly abort the workspace's live background-hook scheduler tasks
  ([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896)): the store
  cascade drops the hook rows themselves, but without this sweep a live task would only
  exit lazily at its next tick (the pre-run re-read finds the row gone). Task-abort
  only — no `hook:cancelled` is emitted and no owner wake fires (unlike the archive
  cancel sweep above); best-effort: a hook-list failure is logged and skipped, leaving
  the lazy next-tick exit.

Best-effort teardown recovers from poisoned mutexes via `into_inner()` — this is
the last chance to unlink the workspace-scoped state, so recovery beats a panic.
The daemon emits **one `agent:deleted` per swept session BEFORE** the terminal
`workspace:deleted`, so subscribers see the per-session teardown first and can
retire agent-scoped UI (chat panes, banners) before the workspace row disappears
(§6.5).

**Workspace status fields (new in intentd).** Three BE-owned fields appear on `Workspace`
objects returned by `workspace.*` — lightweight status metadata, **not** a notification store —
each with a dedicated change event (§6.5) that carries the new value:

- `activity` — **derived, read-only (green dot).** In-flight agent state, e.g.
  `"idle" | "agent_running"`. The BE computes it from agent state; clients never set or
  recompute it. It has no setter; it surfaces in `workspace.*` results and via
  `workspace:activity-changed` (§6.5).
- `attention` — **dismissible (blue dot).** A small flag raised by BE transitions, e.g.
  `"none" | "unread" | "review_required"`. Server-owned, so dismissing it from any client
  clears it for all clients. The two clears are **not** interchangeable (intentd#945):
  `workspace.dismissAttention` retires the flag whatever its value, while
  `workspace.markSeen` is **guarded on `unread`** — it clears the turn-end blue dot and
  leaves a persistent `review_required` in place (see the attention-flag write guard under
  the derived `displayStatus` block below). Both surface via
  `workspace:attention-changed` (§6.5). This is shared BE state rather than
  per-client local state (the daemon is single-user in v1; per-viewer cursors are a future
  extension).
- `waiting?` — **derived, read-only, orthogonal wait flag (v6.17).** `true` when the
  workspace has any of: an ACTIVE (`scheduled`/`running`) background hook (§5.40), an
  ACTIVE PR monitor (§5.42), or a **waiting agent subscription** — an undelivered child
  completion watch (`report_delivered` excluded, matching the settlement predicate) held
  by a **top-level foreground** agent, anchored in the parent's home workspace
  (§Completion-watch persistence) — i.e. the workspace is watching an external condition
  without needing a running agent turn. **Presence-detected**: emitted only as `waiting:
  true` and **omitted when `false`** (`skip_serializing_if`; never `false`/`null`), so
  clients treat an absent field as not waiting and older daemons interoperate fail-open.
  **Orthogonal to `displayStatus`** — a workspace can read `complete` or `pr_ready` and
  still be waiting; since v6.17 the three wait signals no longer feed the `displayStatus`
  derivation at all (see step 3 below). Derived on the same `workspace.list` /
  `workspace.get` / subscription emit path as `displayStatus` (never persisted; the
  enrichment also seeds the transition baseline for `workspace:waiting-changed`, §6.5),
  short-circuiting on the first live signal, and each probe is best-effort — a store read
  failure fails open to `false`, so emission is never wedged and waiting is never
  fabricated. Transitions surface via `workspace:waiting-changed` (§6.5).

**`status` wire form.** `Workspace.status` serializes as the PascalCase TS `WorkspaceStatus`
string enum — `"Active" | "Inactive" | "Archived" | "Deleted"` (src/shared/types.ts) — both on
the wire and as the stored DB word (matching the `PullRequestStatus` precedent). Optional
`Workspace` fields (`statusMessage`, `statusImageAssetId`, `baseRef`, `prUrl`, `prNumber`,
`prStatus`, `activePullRequest`, `pullRequests`, `archivedAt`, `cowSupported`, `checkoutMode`,
repository/worktree fields, …) are
**omitted when absent**
(`skip_serializing_if`) rather than emitted as `null`, so clients see only populated keys.

**`statusImageAssetId` (new in intentd, migration `0062`).** An agent-authored workspace
status screenshot reference (intent-hq/monorepo#997). The value is a content-addressed
asset id minted by the `note.saveAsset` machinery (§5.2); clients render it with
`note.readAsset` / the `workspace-asset://` URL scheme. Agents set or clear it via the
MCP `workspace_api` binding `ws.workspace.setStatusImage({ data, mimeType, originalName? }
| null)` — the daemon stores the image bytes as an asset first, then points the workspace
row at the resulting id (`null` clears; the binding errors when called against the
virtual chief-of-staff **workspace** — the `WorkspaceId::is_chief()` guard, same as
`archive`/`unarchive` — regardless of which agent or specialist calls it). On the wire,
`workspace.update` accepts `statusImageAssetId: string | null` with the same three
clearable forms as the PR fields below: **missing** leaves the stored value untouched,
explicit **JSON `null`** clears it, and a **present string** sets it (a whitespace-only
or empty string folds to a clear, and the delta carries the `null` clear signal). The
`workspace:updated { changes }` delta (§6.5) preserves the distinction, and the field is
omitted from `Workspace` payloads until an agent sets one.

**`cowSupported` / `checkoutMode` (new in intentd).** `cowSupported` is a BE-derived
machine-capability flag: a cached CoW-reflink probe of the **workspaces root**
filesystem (the probe creates a missing root rather than omitting), filled by the
aggregate-enrichment step on the `workspace.list` / `workspace.get` read paths —
`true` / `false` for a supported/unsupported filesystem, omitted when the probe cannot
run or exceeds the per-call budget (write-path responses such as `workspace.create` /
`update` / `archive` build the row without this enrichment, so clients read it off the
list/get poll). It reports the machine's capability independent of how the specific
workspace was provisioned; the FE gates the `workspace.cowIsolation` opt-in toggle
(§5.12) on it. **Caveat — root-scoped, not repo-scoped:** provisioning probes from the
*repository directory* into the workspaces root (§5.1), so a repository on a different
filesystem than the workspaces root (reflinks cannot cross filesystems) can still land
`workspace.create` on the worktree-fallback path (`checkoutMode: "worktree"`, §5.1)
even when `cowSupported` is `true`; `cowSupported` is a toggle-gating advisory, not a
per-repository guarantee.
`checkoutMode` (`"worktree" | "cow" | "direct"`, lowercase on the wire) records how
`workspace.create` provisioned this workspace's checkout (§5.1): `"worktree"` a linked
worktree, `"cow"` a standalone copy-on-write clone, `"direct"` a standalone plain local
clone (the cache-hydration fallback when CoW is unsupported) or an `isNewRepo`
initialization working in the repository folder itself. It is omitted for rows
without a daemon-provisioned checkout (skip-isolation, remote, caller-supplied
`worktreePath`, non-git repository paths, pre-existing rows). `"cow"` and `"direct"` are
both **standalone** repositories: `workspace.delete` skips the worktree-registration
prune and the source-repo branch-delete guard for both, and both are sandbox-eligible
(§5.5).

**`lastActivity` (BE-derived, always populated).** `Workspace.lastActivity` is the
authoritative "most recent thing that happened in this workspace" timestamp. The daemon
derives it on every path that returns a `Workspace` on the wire (`workspace.list` /
`workspace.get` / `workspace.create` / `workspace.update` / `workspace.archive` /
`workspace.unarchive`) as the **max** of the persisted `lastActivity`, `updatedAt`,
`createdAt`, every note's `updatedAt`, and every agent session's `updatedAt` (FE
`deriveWorkspaceLastActivity` parity). It is always present on the wire —
clients never need to recompute it from notes/agents.

**PR-field ownership (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`, `pullRequests`).**
These five fields are BE-owned: the daemon writes them from PR discovery / refresh
(§5.9, §6.5 `pr:*` events) and clients read them off the returned `Workspace`. All five
are `Option`s that serialize with `skip_serializing_if` (absent, not `null`). The
persisted `pullRequests: PullRequestInfo[]` (new in intentd, migration `0035`) sits
alongside `activePullRequest` and carries the reconciliation candidates the FE matches
`activePullRequest` against.

**Explicit-null clear on `workspace.update` PR fields.** On `workspace.update`, the same
five clearable PR fields (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`,
`pullRequests`) accept three wire forms: **missing** the key leaves the stored value
untouched, an explicit **JSON `null`** clears the stored value, and a **present value**
sets it. The applied `WorkspaceUpdate` delta emitted as
`workspace:updated { changes }` (§6.5) preserves this distinction — omitted keys were
untouched, `null` keys were explicit clears, present keys were sets.

**`baseRef` canonicalisation.** On `workspace.create` and `workspace.update`, an incoming
`baseRef` has any known remote prefix (`origin/`, `upstream/`, `fork/`) stripped before
persistence, so `origin/main` and `main` collapse to the same canonical `main`. The
returned `Workspace.baseRef` and the persisted DB value are always the canonical form;
values without a known prefix are stored verbatim. `git.*` methods that need the
fully-qualified remote-tracking name reconstruct it as `origin/<baseRef>` locally.

**Card aggregates (`taskStats` / `agentSummary` / `diffSummary`).** `workspace.list` and
`workspace.get` enrich each `Workspace` with the nested rollup objects the iOS coverflow cards
read, computed fresh from live state on the emit path (never persisted). They are decoded as
optional by iOS and each is **omitted when not computable** (`skip_serializing_if`) rather than
emitted as `null`, so absent simply yields a sparser card. Since intentd#743 only `taskStats`
and `agentSummary` are actually attached on these read paths — `diffSummary` is **always
omitted** (see its bullet below):

- `taskStats: { total, completed, inProgress }` — ports the canonical `computeTaskStats`
  (`task-stats.ts`) over the spec-linked direct-child task notes: `cancelled` is excluded from
  `total`, `complete` counts as `completed`, and `in_progress` + `review_required` count as
  `inProgress`. The renderer-only per-task `tasks` array is omitted.
- `agentSummary: { count, agents: WorkspaceAgentInfo[], agentIds: string[] }` where
  `WorkspaceAgentInfo = { id, name, status, specialist?, lastActivity?, isStreaming, isResponding, parentAgentId? }`.
  This matches the **live iOS `WorkspaceStore.parseWorkspace` consumer** (the richer
  `{ count, agents }` form); `agentIds` is additionally emitted alongside it for forward-compat with
  the slim TS `WorkspaceAgentIdSummary { agentIds }` (a future desktop-on-intentd reads
  `agentSummary?.agentIds ?? []`) and lists the same agents (same order) used to build `agents`.
  `status` carries the same wire strings as `agent.list`; `isStreaming`/`isResponding` are always
  `false` (the headless backend has no live stream state — `status` carries liveness, matching the
  `AgentLite` decision); `lastActivity` is the session `updatedAt`; `parentAgentId` (v2.9, additive)
  is the delegating/spawning agent's id — the same session value surfaced as
  `metadata.createdByAgentId` on `agent.get`/`agent.list` loads (§5.5) — **omitted** for root
  agents, so clients can rebuild the delegation tree from the summary alone.
- `diffSummary: { schemaVersion, updatedAt, totalFiles, totalAdditions, totalDeletions, files }` —
  **never emitted since intentd#743**: the per-workspace head-diff rollup is omitted on the
  `workspace.list` / `workspace.get` / workspace-subscription emit paths (recomputing it for every
  workspace on every enrichment pass pinned the blocking pool on large workspace sets). The field
  stays on the wire shape as optional for decoder compatibility; clients that need diff data fetch
  it on demand (path-scoped `git.diffs` / `git.numstat`, §5.6) instead of reading it off a hydrated
  workspace payload.

**Workspace disk usage (`workspace.diskUsage`, on-demand since v4.2).** The **cached**
whole-workspace disk footprint —
`diskUsage: { bytes, fileCount, computedAt, breakdown: [{ name, bytes, fileCount }] }` —
is served exclusively by the dedicated `workspace.diskUsage` method (the §5.1 table above);
since v4.2 the `workspace.list` / `workspace.get` read paths (and the workspace-subscription
emit path) **never populate** `Workspace.diskUsage` (monorepo#1396 — recomputing/serving it
on every hot list pass was needless enrichment weight; the field stays on the row shape as
optional for decoder compatibility, it is simply never present). The method returns
`{ diskUsage?, refreshing }`: `diskUsage` is **omitted when no computed value exists yet**
(absent, never `null`; the value is never persisted — in-memory cache only), and
`refreshing: true` reports an in-flight background walk (first-ever poll, or a stale entry
being revalidated) so clients know to poll again shortly. Only rows with a daemon-managed
directory qualify: remote / skip-isolation rows and the virtual Chief workspace — plus any
row whose directory was never provisioned on disk — answer `{ refreshing: false }` with the
field omitted, without touching the cache (a walk against a missing directory would fail
and report `refreshing` forever-true). An unknown `workspaceId` is `-32602` (NotFound).
Payload and cache semantics:

- **Scope — the whole per-workspace folder.** The walk covers
  `<workspaces_root>/<workspaceId>` in its entirety: the repo checkout **plus** tool
  outputs, agent sandboxes, and any other content of the workspace directory — not just
  the checkout.
- **Physical (allocated) usage, not apparent size.** `bytes` sums allocated blocks
  (`st_blocks * 512`), so sparse regions don't count. Hard-linked files are deduped by
  `(st_dev, st_ino)` within a walk — a multi-linked inode counts once, toward whichever
  breakdown bucket encounters it first. Symlinks are never followed (only the link's own
  allocation counts) and directory-inode allocation is excluded. **CoW caveat
  (best-effort):** clone-shared extents (APFS `clonefile`, btrfs/XFS reflink) are counted
  at **full** allocated size in every workspace that references them — excluding them
  would need a per-file extent enumeration that blows the walk budget — so for
  CoW-provisioned workspaces the value is a documented **upper bound**, not exact
  exclusive usage.
- `fileCount` counts the regular files that contributed bytes (hard-link duplicates
  once); `computedAt` is the RFC-3339 wall-clock time the walk completed — clients can
  render staleness from it.
- `breakdown` carries one `{ name, bytes, fileCount }` entry per **top-level directory**
  of the workspace folder, sorted by `bytes` descending (name ascending on ties), plus a
  synthetic `"other"` bucket aggregating loose top-level files when non-empty.
- **~60s cache / stale-while-revalidate / single-flight / serialized walks.** The walk
  never runs on the request path. Each workspace's value has a ~60-second TTL: a fresh
  entry is served as-is with `refreshing: false`; an expired entry is served
  **immediately** with `refreshing: true` while a single background walk refreshes it for
  the next poll (stale-while-revalidate); refreshes are single-flight per workspace, so
  concurrent `workspace.diskUsage` polls coalesce into one walk — and walks across
  **different** workspaces are additionally globally serialized (max 1 concurrent walk,
  intentd#881: usage is stale-while-revalidate and first paint omits it, so concurrent
  full-tree walks only create disk contention). The first-ever poll finds no entry — the
  field is **omitted**, `refreshing: true` is reported, and the computed value backfills
  for the next poll. A failed walk keeps the last-good value (retried on the next poll).

**Derived display status (`displayStatus`, new in intentd).** Alongside the card aggregates, the
same `workspace.list` / `workspace.get` emit path — and the lite `workspace.subscribe` seq-0
snapshot (§6.9, intentd#743) — enriches each `Workspace` with a BE-owned
"current cycle" status rollup over the active/latest PR and `taskStats` — derived fresh on emit,
**never persisted**. Wire values are the snake_case strings
`"failed" | "blocked" | "needs_attention" | "in_progress" | "not_started" | "idle" | "complete" | "pr_ready" | "pr_open" | "pr_merged"`
(`"idle"` new in intentd#793, `"needs_attention"` new in intentd; `"failed"` / `"blocked"`
new in intentd#945 — added without a protocol bump per the same precedent, since
clients degrade unrecognized values neutrally, see below; the intentd#945 `"unread"`
value is **removed** — the `unread` attention flag is no longer a displayStatus axis, so
the value simply never reaches the wire, which is client-compatible per the same
precedent — the flag itself, its turn-end raise, and `workspace.markSeen` are the unread
contract, §5.1 `attention`). The field is
**authoritative**: clients render it as-is and
perform **no local derivation** (ios#59, cloudlands-fe#560; the former FE sidebar
running/idle grouping overlay is deleted, cloudlands-fe#578). It is decoded as optional and
**omitted when `taskStats` is not computable** (`skip_serializing_if`, e.g. a transient
notes-read failure) rather than emitted as `null`. The two degenerate cases are **distinct**
(ios#81): an **absent** field defaults the display to `not_started`, while a **present but
unrecognized** wire value — a newer daemon emitting a variant this client build predates —
degrades to a **neutral unknown** treatment (a placeholder rendering, sorted last), never to
`not_started` or any other real status. Clients must not conflate the two: a value the build
does not know is not evidence that work has not started. The derivation is the
**canonical precedence** (intentd#945) — `failed` > `blocked` > `needs_attention` >
`in_progress` (running agent) > the PR/task rollup — folding the attention axes
and live agent activity around the "current cycle" rollup:

The attention axes (steps 0–2) are probed per workspace
over its **top-level foreground** sessions — no `parentAgentId`, not background
(`isBackground`), and not deleted — plus the dismissible workspace `attention` flag
(`review_required` only — the `unread` flag never feeds the derivation). Child
and background sessions never count: their attention surface is the parent/subscriber (the
§5.5 attention-retire taxonomy). Best-effort: a store read failure fails open to `false`
(the question-hold derivation fails open itself), so list/get emission is never wedged and
attention is never fabricated.

0. **Failed** *(new in intentd#945)* — a top-level foreground agent is parked in `error`
   (the mid-turn failure park, awaiting `agent.retry` — §5.5) → `failed`,
   **unconditionally** (outranks everything, including `blocked` and the running
   promotion): the workspace cannot make progress until the user redrives.
1. **Blocked** *(new in intentd#945)* — a top-level pending **blocker** attention request
   (`attentionRequestKind = "blocker"`, raised via `ws.agent.reportBlocker`, §5.5 — an
   infrastructure/environment problem) → `blocked`. Previously folded into
   `needs_attention`; now its own rung above it.
2. **Needs attention** *(new in intentd)* — a top-level foreground agent is waiting on
   the user → `needs_attention`. A session counts when it either (a) carries a pending
   non-blocker **attention request** (`attentionRequestKind = "discussion"`, raised via
   `ws.agent.requestDiscussion`, §5.5) or (b) has **pending structured questions** — the
   same question-hold derivation as §5.5 (the persisted `pendingQuestionsMessageId` marker
   is set and differs from the `dismissedQuestionsMessageId` marker; within v6.0 this is a
   metadata read, not a transcript tail walk — modulo the one-time pre-upgrade fallback,
   §5.5 — and pendingness survives later user messages
   and agent turns) — or (c, new in intentd#945) the workspace
   `attention` flag reads `review_required`. The cheap session-metadata check (attention
   requests) runs over every candidate first; question-hold probes only
   happen when no session already flagged.
3. **Agent running** —
   any agent running in
   the workspace (the same signal behind `activity == "agent_running"`)
   → `in_progress`, **unconditionally over everything below** (overrides the
   PR stages and `complete`). **Since v6.17 only a truly running agent promotes.** The
   external-wait signals that previously folded into this step — the active-hook fold
   (intentd#856), the active-PR-monitor fold
   ([intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036);
   [monorepo#1814](https://github.com/intent-hq/monorepo/issues/1814)), and the
   child-completion-watch fold — are **unwound**: an idle agent still watching via a
   background hook (§5.40), a PR monitor (§5.42), or delegated-child completion
   watches (§Completion-watch persistence) no longer reads as `in_progress`. Those
   three signals surface exclusively as the orthogonal `Workspace.waiting` flag
   (see the workspace status fields above) — the same probes, anchored the same way
   (watches in the **parent's home workspace**, the watch's `parent_workspace_id`,
   never the child's; watches held by child or background agents never count), all
   best-effort with a store read failure failing open to `false` — so an
   idle-but-watching workspace reads its real rollup (`complete`, a PR stage, `idle`)
   with `waiting: true` alongside. This restores the pre-#856 promotion semantics;
   the `activity` field's semantics are unchanged.
4. **Not running** — the "current cycle" precedence:
   1. **Open/draft PR** — the linked `activePullRequest` when open/draft, else the most
      recently updated open/draft entry in `pullRequests` — yields `pr_ready`
      (`mergeable == true` and not draft) or `pr_open`.
   2. **Open tasks remain** (`completed < total`) → `in_progress` when any task has started
      (`inProgress > 0` or `completed > 0`), else `not_started`.
   3. **Latest PR merged** (the linked PR, else the most recently updated `pullRequests`
      entry) → `pr_merged`.
   4. **All tasks complete** (`total > 0`, `completed == total`) → `complete`; else
      `not_started`.
5. **Idle demotion** — when not running and step 4 yields `in_progress` or `not_started`,
   the result is demoted to `idle`; the PR stages and `complete` pass through.

The dismissible `unread` workspace attention flag (the server-owned turn-end blue dot,
§5.1 `attention`) **never feeds the derivation** — the intentd#945 step-6 unread
promotion is removed, so the rollup always reflects the workspace's real state and the
flag surfaces exclusively through `Workspace.attention` and
`workspace:attention-changed` (§6.5).

`not_started` and a non-running `in_progress` are therefore **no longer emitted**; those enum
variants are retained for wire back-compat (older daemons / client decode paths — they still
decode, and clients keep their `not_started` default for an **absent** field; an unrecognized
value takes the neutral unknown treatment instead).

**Attention-flag write guard (intentd#945).** The turn-end automatic `unread` raise fires
only when a **top-level foreground** agent's queue drains (intentd#1021): child agents
(`parent_agent_id` set) and background agents never raise it — their completions surface
to their parent/coordinator, not the user. A `NotFound` session load (deleted agent)
skips the raise too, while a genuine store error fails open (raise + warn). The raise is
further guarded on the stored flag being `none`: it never downgrades a persistent
`review_required` (no `workspace:attention-changed`), and `workspace.markSeen` — guarded
on `unread` — leaves `review_required` in place; only `workspace.dismissAttention`
retires that flag (its documented contract).

A merged PR in history never masks an open PR (step 4.1 scans `pullRequests` for open/draft
entries) or open tasks (step 4.2 precedes the merged check). Transitions are pushed as
`workspace:displayStatus-changed` (§6.5), which since intentd#793 also fires on agent
start/stop: the 0→1 running transition recomputes-and-emits immediately, and the
running→not-running recompute runs after the same debounce grace window as
`workspace:activity-changed` (emitting whatever the not-running derivation yields — `idle`,
a PR stage, or `complete`), so the two stay in lockstep. The hook / PR-monitor /
completion-watch lifecycle transitions still recompute-and-compare at every choke point,
but since v6.17 those signals move the orthogonal `waiting` flag, not the rollup — each
site runs **both** transition-only recomputes (`workspace:displayStatus-changed` and
`workspace:waiting-changed`, §6.5), and with the fold unwound the displayStatus half is
normally a silent no-op there while the waiting half emits. Hook lifecycle transitions
(intentd#856 established the sites): a hook **schedule** (a newly persisted active
hook can raise `waiting`) and every hook **settlement** — dispatch, eviction, cancel, expiry, on
both the synchronous ops and the spawned-task run paths — so `waiting` drops when the
workspace's last active hook settles. PR-monitor lifecycle transitions
([intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036) established the sites):
a monitor **register** (`ws.pr.monitor` — a newly persisted active monitor can raise;
the idempotent re-arm recomputes too, staying a silent no-op) and every monitor
**settlement** — an owner cancel (`ws.pr.unmonitor`), an external FE cancel
(`prMonitor.cancel`), the `workspace.archive` sweep cancels (§5.1 archive active-work
teardown; [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)),
the poll loop's terminal completion (PR merged/closed), and the
boot-rehydration owner-gone cancels — so `waiting` drops when the workspace's last
active monitor settles. Completion-watch lifecycle transitions
recompute too, always in the parent's home workspace: a
watch **register/adopt** (the `agent.delegate` auto-watch, `after_all` group enrollment,
explicit `ws.agent.watch` — a newly armed watch can raise) and every watch
**settlement** — the deliver-once retirement at the child's completion, `after_all`
group settlement (the aggregated wake clearing the grouped watches), a scoped or
unscoped `agent.cancelSubscriptions` / `ws.agent.unwatch` cancel, and the
workspace-delete subscription sweeps (a deleted child's watches settling on surviving
parents) — the same choke points that publish `agent:subscriptions-changed` (§6.5) — so
`waiting` drops when the parent's last active watch settles. The attention axes add
their own recompute-and-compare points: an attention **raise** (`ws.agent.requestDiscussion`
/ `ws.agent.reportBlocker` — a child/background raise stays silent, since the derivation
ignores those sessions and the transition-only emission suppresses the no-op) and its
**retire** (the turn-begin clear on a qualifying delivery, §5.5); a **question-asking turn
end** (the turn-end `pendingQuestionsMessageId` marker write arms the question-hold
derivation) and each question-hold **release** — within v6.0 only a `question_answers`-tagged
user row naming the marked message, `agent.dismissQuestions`, or a NEWER question-bearing
assistant turn releases it (§5.5). The recompute-and-compare still runs after every
user-row persist (`agent.sendMessage` direct send, `agent.sendQueuedMessageNow`,
`agent.editAndRegenerate`'s regenerated message, a drained user-origin queue entry) and
every transcript mutation via `agent.appendMessage` / `agent.replaceMessages` (§5.5), but
an untagged row leaves the marker armed, so those paths now emit only when the derivation
actually flipped (intentd#833; intentd#965). The intentd#945 axes add theirs: the mid-turn **Error park** (the
`failed` promotion — the recompute runs as the park persists, so the turn-end debounce
never hides it) and its retires — `agent.retry` (the redrive clears the park and the
recompute runs before the worker starts, emitting `failed → in_progress` immediately)
and the fresh-`agent.sendMessage` recovery path (recomputed after the user-row persist —
the earlier turn-begin recompute still reads `error` and would stay silent); every
workspace **attention-flag write that can move the `review_required` axis** —
`workspace.dismissAttention` and a `workspace.update` carrying `attention` (the turn-end
`raise_attention` writes only `unread` — a guarded no-op when the flag is not `none`, and
skipped entirely when the workspace is `Archived` at drain time — fail-open on a
workspace-read error;
[intent-hq/intentd#1075](https://github.com/intent-hq/intentd/pull/1075) — and
`workspace.markSeen` only clears `unread`; neither feeds the derivation, so both skip the
recompute). The emit-path
enrichment (both the enriched list/get path and the lite
snapshot path) also seeds the in-memory baselines both events' recompute-and-compare runs
against — the displayStatus baseline and the v6.17 `waiting` baseline alike (a seed never
emits); `workspace.delete` evicts both.


```json
// → request — dismiss the blue-dot attention flag
{ "jsonrpc":"2.0","id":2,"method":"workspace.dismissAttention","params":{ "workspaceId":"ws-abc" } }
// ← response (attention reset; emits workspace:attention-changed)
{ "jsonrpc":"2.0","id":2,"result":{ "workspace":{ "id":"ws-abc","activity":"idle","attention":"none" } } }
```

**Workspace chat-context items (`workspace.getContext` / `updateContext`, new in intentd).**
Migrates the renderer-only `localStorage["workspace:context:{workspaceId}"]` store (attached
files/notes/URLs, Linear/GitHub/Sentry issues surfaced in the chat context panel) into
daemon-owned rows so the surface is queryable by MCP tools and other clients. The daemon
treats each item as an **opaque JSON blob** authored by the FE — the `ContextItem` union in
`packages/cloudlands-fe/src/features/context/types.ts` — and only pulls `id` out for keying
and ordering. `updateContext` is a full-list replacement (matches the FE's collapsed
`hydrate/add/remove/update` write pattern) and preserves the caller-supplied order. Every
successful `updateContext` emits `workspace:context-changed` with the persisted list
(§6.5), so subscribers refresh without a follow-up `getContext`.

- **ContextItem** — `{ id: string (required, non-empty), ...extras }`. `id` is the row key
  and the only field the daemon inspects; every other field (`type`, `provider`, `title`,
  `url?`, `parentNoteId?`, `createdAt`, `updatedAt`, plus provider-specific extras such as
  `identifier`, `number`, `favicon`, `noteId`, `isSpec?`, `taskStatus?`) round-trips
  verbatim. The FE's union types are the source of truth.

```json
// → request — write the authoritative list
{ "jsonrpc":"2.0","id":10,"method":"workspace.updateContext","params":{
  "workspaceId":"ws-abc",
  "items":[
    { "id":"ctx-1","type":"linear-issue","provider":"linear","title":"ENG-42",
      "identifier":"ENG-42","createdAt":"2026-07-13T00:00:00Z","updatedAt":"2026-07-13T00:00:00Z" }
  ]
} }
// ← response (emits workspace:context-changed)
{ "jsonrpc":"2.0","id":10,"result":{ "items":[ /* same list */ ] } }
```

### 5.2 `note.*`

All `note.*` methods require `workspaceId`. All except `list` and `create` additionally require `noteId` (`list` returns every note; `create` mints a new id). The spec note is addressed with the well-known id `"spec"`.

| Method | Params | Result |
| --- | --- | --- |
| note.list | workspaceId (req) | { notes: NoteSummary[] } — task-note rows with `dependsOn` edges carry the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty — see §5.4 task.setRelations). The field is guaranteed only on read/push shapes (`note.get`/`note.list` and the subscription snapshots/deltas they serve); notes embedded in mutation *responses* (e.g. `task.updateNoteStatus`'s `note`, `note.update`'s `note`) may omit it — clients should not patch caches from mutation responses expecting the projection |
| note.get | noteId (req) | { note: Note } — -32602 with `error.data.code: "not-found"` if not found. A task note with `dependsOn` edges carries the computed `metadata.task.unmetDependsOn` (within v6.8, monorepo#1979; presence-detected, omitted when empty; read/push shapes only — see the note.list row) |
| note.create | title (req), content?, tags?: string[], parentId?, idempotencyKey? | { note, convertedCount, createdTaskNoteIds, createdTasks, warnings } — within v6.14 ([intent-hq/intentd#1162](https://github.com/intent-hq/intentd/pull/1162), monorepo#2129) the result carries the `@@@task` auto-conversion outcome for the initial content, **additive** over the old `{ note }` shape (clients reading `.note` are unaffected): same shapes and warning contract as the four content-write ops (see "`@@@task` auto-conversion on note writes" below and the `task.convertBlocks` row, §5.4), with all four fields always present (`convertedCount: 0` plus empty arrays when the content converts nothing). `note` is the refetched post-conversion row, so its `rev`/`updatedAt` reflect the conversion write. An `idempotencyKey` replay returns the stored result without re-executing; a replayed key recorded before the conversion fields existed decodes the stored bare note as a zeroed conversion outcome |
| note.update | noteId (req); content? or title?/tags? | { note } — content present → full setContent; else metadata update |
| note.add | noteId (req), content (req), heading?, position?: "end" | "start" |
| note.edit | noteId (req), old (req), new (req) | { ok, ... } — first exact-match replacement |
| note.editLines | noteId (req), start (req,int), end (req,int), content (req) | { ok, ... } (1-based inclusive) |
| note.setContent | noteId (req), content (req), confirmReplacement?: boolean | { ok, ... } (full replace) |
| note.updateMetadata | noteId (req), title?, tags?: string | string[] |
| note.delete | noteId (req) | { ok, noteId, deleted } — emits `note:deleted`. Deleting a **task note** additionally recomputes + emits `task:ready-tasks-changed` (§6.5) after the `note:deleted`, with the additive trigger `triggeredBy: { noteId, reason: "note-deleted" }` (monorepo#1981; generalized by intentd#1121, monorepo#2006), whenever the delete actually **moves** the ready set: deleting a task that was itself ready drops its id from `readyTaskIds`, deleting the last incomplete task child of a parent readies the parent (tree rule), and deleting a task note that other tasks `dependsOn` keeps the #1981 always-emit contract — the dangling edge counts as unmet, so deleting a previously-`complete` dep drops its dependents out of `readyTaskIds`. The pre-delete and post-delete ready sets are compared, so a delete that provably cannot move the set (e.g. a terminal task nobody depends on) emits no recompute. Deleting a **`complete`** dep also re-announces each dependent task note via `note:updated` (the computed `unmetDependsOn` projection moved, monorepo#1979) after the ready-set event — same ordering as the status-transition path (`task:*` first, dependent `note:updated` last) |
| note.listTasks | noteId (req) | { tasks: [...] } (checkbox/task rows + taskNoteId). Rows with a linked task note also carry the linked task's `dependsOn?` / `conflictsWith?` / computed `unmetDependsOn?` (v6.8; presence-detected, omitted when empty — see §5.4 task.setRelations) |
| note.readAsset | asset (req) — asset id or workspace-asset:// URL | { assetId, mimeType, data, sizeKb } (image assets returned as data) |
| note.saveAsset | data (req, base64 — a `data:<mime>;base64,` URL prefix is accepted and stripped), mimeType (req), originalName? | { assetId, path, url } — **additive asset write** (no `noteId`; ports the legacy `assets:save` IPC behind note image paste/upload). Writes the decoded bytes under the workspace assets root plus an `<assetId>.meta.json` sidecar (`{ id, originalName, mimeType, size, createdAt }`); `assetId` is `<timestamp36>-<hash8><ext>` with `<ext>` derived from `mimeType` (default `.png`), `url` is `workspace-asset://<workspaceId>/<assetId>` and round-trips through `note.readAsset`. `-32602` on missing params; `-32603` on invalid base64 or when asset storage is not configured |
| note.listVersions | noteId (req) | bare array of `{ type:"snapshot", v, date, author:{id,name,type}, title, contentLength }` ascending by `v` |
| note.getVersion | noteId (req), v (req,int) | `{ type:"snapshot", v, date, author, title, content }` — -32602 if the version does not exist |
| note.restoreVersion | noteId (req), v (req,int) | { ok, noteId, restoredFrom, v, note } — resets title+content to version `v`, bumps `rev`, appends a new version capturing the restored state |

```json
// → request
{ "jsonrpc":"2.0","id":7,"method":"note.add",
  "params":{ "workspaceId":"ws-abc","noteId":"spec","content":"## Phase 2\nDraft","position":"end" } }
// ← response
{ "jsonrpc":"2.0","id":7,"result":{ "ok": true, "noteId":"spec" } }
```

**Version history (deliberate divergence from the FE).** The FE's file-based store
appended mixed snapshot/diff entries to a `.versions/<noteId>.jsonl` sidecar
(`SNAPSHOT_INTERVAL = 10` diffs between full snapshots). The daemon stores **every
version as a full snapshot** in the `note_version` table instead — content sizes are
note-scale, SQLite holds blobs natively, and full snapshots make `getVersion`/
`restoreVersion` O(1) with no diff-chain replay. The FE cap is kept: on append the
store prunes to the newest **50** versions per note (`MAX_NOTE_VERSIONS`). Versions are
captured on every content mutation (`note.create`, `note.update` with `content`,
`note.add`, `note.edit`, `note.editLines`, `note.setContent`, `note.restoreVersion`);
metadata-only updates do not create versions. `note.*` writes carry no author context
on the wire yet, so every version is stamped with the system author
(`{ id:"system", name:"intentd", type:"system" }`).

**CRDT merge on full-content writes (§5.2 / A5).** `note.setContent` and the
content arm of `note.update` are **not** last-write-wins: incoming content is
routed through a per-note `yrs` (Rust Yjs) document seeded from the note's
stored content on first touch, and each write applies a single-hunk char-level
diff (common UTF-16 prefix / suffix trimmed) inside a `yrs` transaction. The
merged `Y.Text` output is what the daemon cleans and persists, so two
concurrent full-content writes whose diffs target different regions both
survive in the stored content. The CRDT state is **session-only** — never
persisted, sweepable after 24 h idle, keyed by `(workspaceId, noteId)`. The
surgical mutations (`note.add`, `note.edit`, `note.editLines`, `note.restoreVersion`,
`task.updateStatus`, `task.update`, `task.convertBlocks`, `comment.add`) write
straight to storage and invalidate the cached session so the next full-content
write reseeds from the fresh persisted content; `note.delete` drops the
session. The wire shapes on §5.2 are unchanged.

**`@@@task` auto-conversion on note writes.** Every content-mutating note write
(`note.add`, `note.edit`, `note.editLines`, `note.setContent`, the content arm of
`note.update`, and `note.create` on its initial content) auto-converts `@@@task` blocks
in the resulting content into linked task notes, and the write's result carries the
conversion outcome: `convertedCount`, `createdTaskNoteIds`, plus (v6.11, intentd#1133)
`createdTasks` — `[{ key?, title, noteId }]` in block order, parallel to
`createdTaskNoteIds` — and `warnings`, both always present (empty arrays when nothing
applies). `note.create` has always converted, but its result carries the outcome only
since v6.14 (intentd#1162, monorepo#2129) — earlier daemons converted and returned only
`{ note }`, silently discarding the warnings. The fence line accepts the optional
`key=` / `dependsOn=` / `conflictsWith=` / `effort=` header attributes with
convert-with-warnings semantics — grammar, resolution order, and warning contract are
documented on the `task.convertBlocks` row (§5.4).

### 5.2.1 `note.lineAttribution.*`

Per-line attribution over the daemon's full-snapshot version history (§5.2). Ports the FE
`LineAttributionService` that backed the tiptap `LineAttributionGutter`, so a client can
render "who last touched each line" without re-implementing the diff.

| Method | Params | Result |
| --- | --- | --- |
| note.lineAttribution.load | noteId (req) | `LineAttributionData \| null` — see payload below; `null` when the daemon has not computed attributions yet |
| note.lineAttribution.computeNow | noteId (req) | `{ ok: true }` — force an immediate recompute + persist + `line-attribution:updated` emit (bypasses the debounce) |

**Payload shape (`LineAttributionData`).** Identical to the FE JSON the
`line-attribution:load` IPC handler served, so `LineAttributionGutter.svelte` decodes it
unchanged:

```json
{
  "noteId": "…",
  "workspaceId": "…",
  "computedAt": "2026-07-05T12:34:56.000Z",
  "attributions": {
    "1": { "timestamp": 1720193696000,
            "author": { "id": "system", "name": "intentd", "type": "system" } },
    "2": { "timestamp": 1720193710000,
            "author": { "id": "agent-…", "name": "Assistant", "type": "agent" } }
  }
}
```

Keys of `attributions` are stringified 1-based line numbers (only lines the algorithm
attributed to a stored version are present). `timestamp` is milliseconds since the Unix
epoch. `author.type` is `user` / `agent` / `system`; `turnNumber` is emitted when
available (currently omitted because `note.*` writes still stamp the system author —
see §5.2 version-history extensions).

**Recompute lifecycle.** Every content-changing `note.*` mutation schedules a debounced
recompute (5 s, mirroring `LineAttributionService.DEBOUNCE_MS`). A fresh mutation cancels
any pending timer so a burst of writes coalesces into one persist + one
`line-attribution:updated` emit (§6.5). The emit is **transient / broadcast-only**
(published through the same transient path as `chat:stream:delta`, §7): it is never
written to the event table, so it does not appear in `event.query` or the other §5.10
historical reads (migration `0052_delete_line_attribution_events.sql` deletes legacy rows
on existing installs). The durable state remains the `note_line_attribution` row —
one row per note (SQLite migration `0028_note_line_attribution.sql`), upserted on
each recompute so the read path is O(1) and survives restart. `note.delete` cascades.

### 5.3 `comment.*`

| Method | Params | Result |
| --- | --- | --- |
| comment.add | noteId (req), searchContext (req), commentTarget (req), comment (req), type?, author?, authorType? ("user" \| "agent", default "agent"), idempotencyKey?, commentId? (UUID) | { success, message, commentId, anchored, noteRev, location: { line, anchoredText } } (anchors by text search). A replay with the same `(workspaceId, idempotencyKey)` returns the stored result without re-executing (no duplicate comment, no second `comment:added` / `note:updated`); empty/whitespace-only keys are treated as absent. When `commentId` is supplied, the daemon uses it as the canonical id — comment row, `threadId`, anchor `startId`/`endId`, and the embedded `<!--anchor:{id}:start/end-->` markers — instead of minting a fresh UUID, so a client that already inserted optimistic editor anchors under that id converges with the daemon's note rewrite. A non-canonical-UUID value (only the hyphenated 8-4-4-4-12 form is accepted; e.g. the 32-hex simple form is rejected) or a collision with an existing comment id is rejected with `-32602` InvalidParams (after the idempotency replay check, which still returns the cached result first). Omitting it keeps the mint-a-UUID behavior. |
| comment.list | noteId (req), since?, authorType?, status?, includeComments? | { threads: [...] } |
| comment.getThread | noteId (req), threadId? or commentId? | { thread } |
| comment.respond | noteId (req), comment (req), threadId? or commentId?, type?, author?, authorType? ("user" \| "agent", default "agent"), suggestionOriginal?, suggestionProposed? | { ok, ... } — the reply carries **no** `anchor`/`anchorText` (see "Reply anchoring" below) |
| comment.delete | noteId (req), commentId (req) | { ok, ... } |

**Anchor resilience on note edits (Audit D H1+M1).** `comment.add` embeds
`<!--anchor:{commentId}:start-->` / `<!--anchor:{commentId}:end-->` markers into the
note markdown around the anchored span, and captures up to 50 characters of
surrounding text as `anchorBefore` / `anchorAfter` on the persisted comment
(reference `extractAnchoredText` in `markdown-anchor-recovery.ts`). Every
content-changing `note.*` mutation (`note.update`, `note.add`, `note.edit`,
`note.editLines`, `note.setContent`) then runs the rewritten markdown through a
recovery pass before persist: healthy anchors are left alone; partial anchors
(only one marker surviving) are relocated using the stored `anchorBefore` /
`anchorAfter` context; unrecoverable and degenerate anchors have their stray
markers scrubbed from the persisted content and the comment is flipped to
`isOrphaned: true`. Comments in the wire `Comment` shape carry an optional
`isOrphaned: bool` field (omitted when unset, `true` for orphaned comments,
`false` explicitly when a previously-orphaned comment heals).

**Overlapping ranges + phantom-marker scrub (intentd#541).** Overlapping
comment ranges are allowed: a `comment.add` target span may contain other
comments' `<!--anchor:…-->` markers, producing interleaved pairs
(`a:start … b:start … a:end … b:end`) that are valid note content — each
comment's own id still pins its markers, and interleaved anchors stay
healthy. The add embeds the raw span (contained markers intact, in place)
back between the new pair, while the STORED `anchorText` / `anchorBefore` /
`anchorAfter` fields are stripped of all `<!--anchor:…-->` substrings —
markers are stripped from the full prefix/suffix before the 50-character
context window is taken, so a marker adjacent to the span cannot leak a
clipped fragment — and raw marker text never appears in comment rows. The
recovery pass additionally scrubs **phantom markers**: after the per-comment
classification above, any UUID-format marker whose id has no live
(non-orphaned) comment row — an id with no comment row at all, or markers
left behind by a row already flagged `isOrphaned` — is removed from the
persisted content, so a polluted note self-heals on its next content-changing
`note.*` mutation. `comment.add` runs the same scrub on the fetched note
content before matching, so phantom debris can never block a new comment; the
cleaned content persists only as part of the add's atomic note rewrite (a
failed add changes nothing — no separate rev bump). Non-UUID
marker-lookalikes (documentation literals such as
`<!--anchor:{id}:start-->`) are ordinary user content: commentable, and never
scrubbed. This is also why a client-supplied `commentId` must be a
**canonical hyphenated** UUID — the phantom scrub only recognizes canonical
ids inside markers, so a looser spelling would mint markers the scrub could
never recognize or clean up once the comment row is gone.

**Note rewrite visibility (monorepo#638).** Because `comment.add` rewrites the
note markdown (anchor-marker insertion is an `update_note` that bumps the
note's `rev`), the result echoes the authoritative post-rewrite revision as
`noteRev`, and the daemon publishes a `note:updated` change event (§6.5, with
the usual `{ noteId, title, action: "update" }` payload) in addition to
`comment:added` — so subscribed clients refresh their cached note/rev instead
of hitting a spurious conflict on their next versioned write. The note rewrite
and the comment insertion commit atomically in one store transaction: a
failure can never leave anchor markers embedded in the note with no comment
row. An idempotent replay returns the cached `noteRev` and emits neither
event.

**Tolerant anchoring + actionable errors.** `comment.add` first attempts an
exact substring match of `searchContext` against the note markdown. When no
exact occurrence exists, it retries against a *plaintext projection* of the
markdown (heading/list/blockquote markers, emphasis/code delimiters, link
syntax — keeping link text — HTML comments including existing anchor markers,
and all whitespace stripped, with a byte map back to the source), so anchors
derived from an editor's rendered plain text (e.g. tiptap `textBetween`, which
joins blocks with no separator) anchor correctly onto the formatted source.
Uniqueness rules are identical on both paths: an ambiguous `searchContext` or
`commentTarget` is rejected. All anchoring failures (context not found /
ambiguous, target not in context / ambiguous) and the empty-field validations
(`comment`, `searchContext`, `commentTarget`, invalid `authorType`) return
`-32602` with a descriptive message, **not** `-32603 "Internal error"`.
`comment.respond`'s caller-input checks follow the same rule: missing
`threadId`/`commentId` (at least one is required), an empty/whitespace-only
`comment`, and `type: "suggestion"` without both `suggestionOriginal` and
`suggestionProposed` are all rejected with `-32602`. The
optional `authorType` param on `comment.add` **and** `comment.respond` sets
the persisted comment's `authorType` (defaulting `author` to `"User"` /
`"Agent"` accordingly when absent); omitting it keeps the backward-compatible
`agent` default, and an invalid value is rejected with `-32602`.
`comment.getThread` and `comment.resolveThread` apply the same missing-id
validation: providing neither `threadId` nor `commentId` is rejected with
`-32602` ("Either threadId or commentId must be provided"), and
`comment.list`'s filter validations — a non-ISO-8601 `since`, an `authorType`
other than `user`/`agent`, and a `status` other than `open`/`resolved`/
`pending` — are likewise `-32602` (monorepo#649). Lookup failures are **not**
caller-input errors and stay `-32603`: an unknown `commentId` ("Comment not
found: …") or unknown `threadId` ("Thread not found: …") on
`comment.getThread`/`comment.resolveThread` returns `-32603 Internal error`.

**Reply anchoring (monorepo#729).** Only **root** comments carry an
authoritative `anchor` / `anchorText`: `comment.add` embeds the anchor markers
and persists the anchor on the root it creates. Replies created via
`comment.respond` anchor through their thread — `threadId` / `parentId` — and
never independently, so the persisted reply has no anchor and the wire
`Comment` shape **omits** the `anchor` and `anchorText` keys (both fields are
optional on the wire). Clients resolving a thread's position in the document
must read the thread root's anchor (the FE's anchor reconciliation already
does exactly this). Replies stored before this contract change may still carry
a legacy clone of the parent's anchor; clients must treat any reply anchor as
non-authoritative.

**Thread resolution.** One additional method addresses an entire thread by `threadId` **or** `commentId`. Emits the `comment:resolved` event (§6.5).

| Method | Params | Result |
| --- | --- | --- |
| comment.resolveThread | noteId (req), threadId? or commentId?, resolved?: bool (default true) | { ok, ... } — marks every comment in the thread (un)resolved |

### 5.4 `task.*`

| Method | Params | Result |
| --- | --- | --- |
| task.updateStatus | noteId (req), taskText (req), status (req: done | todo |
| task.updateNoteStatus | noteId (req), status (req: not_started | waiting |
| task.update | noteId (req), line (req,int), text?, status?, expected? | { ok, lineNumber, ... } (atomic single-line edit) |
| task.getMyTask | taskNoteId (req) | task note w/ metadata, dependencies, acceptance criteria. `taskMetadata` carries the stored `dependsOn?` / `conflictsWith?` relation lists and the result carries the computed `unmetDependsOn?` (v6.8; all presence-detected, omitted when empty) — see task.setRelations |
| task.markAsTask | noteId (req), status (req), acceptanceCriteria?, effort?, dependsOn?, conflictsWith? | { ok, ... } — always emits `note:updated` (the task-ness/metadata flip; without it a mark was invisible to note-driven refetches until the next unrelated note write). On a note that was **not** already a task it additionally emits `task:created` (§6.5). Re-marking an **existing** task is a status move instead: a real status change emits `task:status-changed` + `task:ready-tasks-changed` (the same pair `task.updateNoteStatus` publishes) and **no** `task:created`; re-marking at the same status emits neither — unless the re-mark's `dependsOn?` param actually changes the list, which recomputes + emits `task:ready-tasks-changed` with the `relations-changed` trigger (monorepo#1981), same as `task.setRelations`. `dependsOn?` / `conflictsWith?` (v6.8) seed/replace the task's relation lists under the same validation and cycle check as `task.setRelations`; omitted params leave an existing task's relations untouched |
| task.setRelations | noteId (req), dependsOn?, conflictsWith? | { ok, noteId, dependsOn, conflictsWith } *(v6.8)* — replaces the task's relation lists on `TaskMetadata` and echoes them normalized (deduped, first-seen order). An omitted param keeps the existing list; `[]` clears it. Validation (`-32603`, detail in `error.data`): every id must name a **task note in the same workspace** (missing notes and non-task notes rejected), self-edges rejected; a `dependsOn` write that would close a dependency cycle is rejected with the cycle path named (`"dependsOn would create a cycle: a -> b -> a"`); a `dependsOn` id that is a **tree ancestor or descendant** of the task (via `parent_id` chains, which may cross non-task notes) is rejected with the offending relationship named (`"dependsOn cannot reference a tree ancestor: a is an ancestor of b"` / `"… tree descendant: c is a descendant of b"`) — such an edge would permanently block readiness for both tasks (the parent waits on the child via the tree rule, the child on the parent via the edge; behavior applies to both `task.setRelations` and `task.markAsTask`, monorepo#1982). `conflictsWith` is advisory (symmetric by convention, stored one-sided) — no cycle check. Emits `note:updated` (metadata refetch, §6.5). Non-task note → `-32603 "Note is not a task"`. Readers project the relations plus the computed `unmetDependsOn` — the `dependsOn` ids whose task note is not `complete` (missing and cancelled deps count as unmet) — on `task.getMyTask`, `task.list` / `task.get` rows, and `note.listTasks` rows with a linked task note (all additive, omitted when empty). `dependsOn` also **gates readiness** (behavior only within v6.8, no event-shape change; monorepo#1974): the ready-task recomputation behind `task:ready-tasks-changed` (§6.5) generalizes the tree rule — a task is ready iff all its task children are `complete` AND its `dependsOn` list is fully satisfied (same rule as `unmetDependsOn`: missing and cancelled deps do NOT satisfy an edge), so cross-subtree ordering edges keep a task out of `readyTaskIds` until every dep completes. A write that actually **changes** `dependsOn` additionally recomputes + emits `task:ready-tasks-changed` after the `note:updated`, with the additive trigger `triggeredBy: { noteId, reason: "relations-changed" }` (monorepo#1981; §6.5) — a no-op write or a conflictsWith-only change emits no recompute |
| task.convertBlocks | noteId (req) | { ok, convertedCount, createdNoteIds, createdTasks, warnings } — each converted `@@@task` block becomes a child task note emitting `note:created` + `task:created` (§6.5). The fence line takes optional **header attributes** (v6.11, intentd#1128/#1130/#1133): `@@@task key=<token> dependsOn=<a,b> conflictsWith=<c> effort=<token>` — whitespace-separated `name=value` pairs after the keyword, bare tokens (no quoting), `dependsOn`/`conflictsWith` comma-separated and whitespace-tolerant around commas. Each `dependsOn`/`conflictsWith` reference resolves in order: sibling block `key=`s in the same conversion → exact sibling block titles → existing task-note ids in the workspace; resolved edges are written through the same validator as `task.setRelations` (cycle + tree ancestor/descendant checks), and `effort` seeds the task's `estimatedEffort`. **Convert-with-warnings:** conversion never fails on bad attributes — every block still converts, and each header parse issue, unknown/duplicate/empty attribute, unresolvable or ambiguous reference, or validator-rejected edge is skipped with one entry in `warnings` naming the block and the problem. `createdTasks` is `[{ key?, title, noteId }]` in block order, parallel to `createdNoteIds` (`key` present only when authored; idempotently reused existing children are not listed — a reused block's `effort` is dropped with a warning). `createdTasks` / `warnings` are always present (empty arrays when nothing applies) |
| task.createPrerequisite | dependentNoteId (req), title (req), content?, status? | { ok, ... } — the prerequisite note is born a task, emitting `note:created` + `task:created` (§6.5) |
| task.assignAgent | noteId (req), agentId (req), force?: bool | { ok, noteId, agentId } — **Occupancy guard (intentd#774):** assigning a NEW agent to a task that already has a live assigned agent — loadable, not Deleted, not poisoned (the same live/resumable predicate as `agent.delegate`'s pre-gate, §5.5) — while the task status is not `complete`/`cancelled` is rejected with `-32602` (InvalidParams); the error message names the existing agent's id and name and suggests `agent.sendToTask` / `agent.wakeOrCreate` to reach it, or `force: true` to intentionally assign a second agent. Re-assigning an already-assigned agent stays idempotent-ok (no `force` needed); `force: true` bypasses the guard |

```json
// → request
{ "jsonrpc":"2.0","id":11,"method":"task.update",
  "params":{ "workspaceId":"ws-abc","noteId":"task-1","line":3,"status":"done" } }
// ← response
{ "jsonrpc":"2.0","id":11,"result":{ "ok": true, "lineNumber": 3, "status": "done" } }
```

**Task-note status vocabulary.** `task.updateNoteStatus` (and the task-note `status` served
by every task projection) accepts `not_started | waiting | discussion_needed | blocked |
in_progress | review_required | complete | cancelled`. `blocked` *(new in intentd)* is
raised by the MCP `ws.agent.reportBlocker` binding (§5.5 agent attention requests) when an
agent reports an infrastructure/environment blocker it cannot resolve; like
`discussion_needed`, it is non-terminal and excluded from `inProgress` in the
`computeTaskStats` rollups (§5.1 card aggregates / `task.list` stats).

**Task projections & bulk cleanup.** Two read methods project a workspace's task notes into the canonical `WorkspaceTask` shape, and one bulk write clears an agent from every task in a workspace.

| Method | Params | Result |
| --- | --- | --- |
| task.list | workspaceId (req), status? | { tasks: WorkspaceTask[], stats: WorkspaceTaskStats } — `tasks` membership is **workspace-wide** *(widened within 6.17; [intent-hq/intentd#1214](https://github.com/intent-hq/intentd/pull/1214))*: EVERY task note in the workspace (any note with task metadata except the spec itself) — direct spec children, subtasks (children of tasks), and unlinked tasks alike; stored note order, deduped by id. Each row carries the always-serialized `specLinked` flag (additive, always present): `true` iff the task id appears in the spec note body's `intent://local/task/{id}` links, `false` otherwise (including every row when the spec has no links; not conditioned on `parent_id`) — plus the additive `parentId?` field (presence-detected, omitted when the backing note has no parent): the note's parent pointer, so clients can distinguish subtasks (parent is another task) from unlinked top-level tasks and reconstruct the hierarchy from `task.list` alone. The optional `status` filter narrows `tasks` only. `stats` is UNCHANGED — still the `{ total, completed, inProgress }` aggregate over the **spec-linked** set (§5.1 card aggregates — same `computeTaskStats` projection: `cancelled` is excluded from `total`, `complete` counts as `completed`, `in_progress` + `review_required` count as `inProgress`) served alongside the filtered task list — **including its no-links fallback**: a spec with no `intent://local/task/{id}` links still counts all direct child task notes in `stats`, while every `tasks` row in that same response reports `specLinked: false` — so clients must NOT correlate `stats` membership with the `specLinked` flag in the no-links case. Each `WorkspaceTask` row also carries the relation fields `dependsOn?` / `conflictsWith?` / computed `unmetDependsOn?` (v6.8; presence-detected, omitted when empty — see task.setRelations) |
| task.get | workspaceId (req), taskNoteId (req) | { task: WorkspaceTask } — unknown id → `-32602 Task not found`. Same `specLinked` flag (computed from the spec note body), `parentId?`, and relation fields as the task.list rows (v6.8) |
| task.removeAgentFromAllTasks | workspaceId (req), agentId (req) | { ok, updatedCount } — strips `agentId` from every task-note's `assignedAgentIds` in the workspace; called from agent teardown (delete-agent, wake-or-create stale-assignment cleanup). Idempotent: absent `agentId` → `updatedCount: 0`. |
| task.linkAgent | workspaceId (req), noteId (req), taskText (req), agentId (req), taskKey? | { link: TaskAgentLink } — upsert on `(workspace_id, note_id, task_key)`. `taskKey` defaults to `taskText` when omitted, matching the FE derivation `association.taskKey ?? association.taskText`. `createdAt` is set to the current epoch-ms. Emits `task:agent-linked`. |
| task.unlinkAgent | workspaceId (req), noteId (req), taskKey (req) | { removed: boolean } — deleting an unknown row is not an error (`removed: false`); an actual delete emits `task:agent-unlinked`. |
| task.listAgentLinks | workspaceId (req) | { links: TaskAgentLink[], linksByNoteId: Record<noteId, Record<taskKey, TaskAgentLink>> } — flat oldest-first list plus the FE-parity `byNoteId → byTaskKey` map so hydration is a mechanical cut-over from `localStorage["task-agent-associations:{wsId}"]`. |

**`task.*` linkage types.** `task.linkAgent` / `unlinkAgent` / `listAgentLinks` migrate the
renderer-only `taskAgentAssociations` slice into daemon-owned rows so MCP tools and other
clients can ask "who is working on this task?".

- **TaskAgentLink** — `{ workspaceId, noteId, taskKey, taskText, agentId, createdAt }`.
  `taskKey` mirrors the FE key (`association.taskKey ?? association.taskText`);
  `taskText` records the human-readable checkbox text at link time; `createdAt` is
  epoch-ms (FE parity with `TaskAgentAssociation.createdAt: number`).

```json
// → request — link an agent to a task
{ "jsonrpc":"2.0","id":12,"method":"task.linkAgent","params":{
  "workspaceId":"ws-abc","noteId":"spec","taskText":"Ship it","agentId":"agent-alpha"
} }
// ← response (emits task:agent-linked)
{ "jsonrpc":"2.0","id":12,"result":{ "link":{
  "workspaceId":"ws-abc","noteId":"spec","taskKey":"Ship it","taskText":"Ship it",
  "agentId":"agent-alpha","createdAt":1750000000000
} } }
```

### 5.5 `agent.*`

The largest namespace. Every `agent.*` method is served daemon-primary by `intent-services` via the `intent-transport` router; no renderer-owned agent transport remains. `agentId` values are **server-assigned** and of the form `agent-{uuid}`.

| Method | Params | Result |
| --- | --- | --- |
| agent.list | workspaceId (req) | { agents: AgentLite[] } — messages/systemPrompt stripped; adds messageCount, lastAgentResponse, lastUserMessage, lastMessageRole?, digest, lastActivity, isStreaming/isProcessing/isResponding, session-level contextReferences?/fileBlocks? (persisted at spawn; omitted when absent — session-level `imageBlocks` are deliberately NOT served on this projection: they are potentially large base64 blobs with no list-read consumer, so they live on `agent.getSession` only; the field was optional/presence-detected, so existing row decoders remain valid — it is simply never present anymore), the session-discovered `effortLevels?` (the provider's `thought_level` values captured at the most recent session open — see "Session-discovered effort levels" below; omitted when the provider advertises none), the harness stamp `harnessVersion` + `harnessFeatures` (within v7.0 — the creation-time harness version and captured `agentFeatures` snapshot, §5.5 "Harness versioning"; `harnessVersion` always present, `harnessFeatures` always carries a value: a legacy pre-snapshot row follows live settings on read until its first activation freezes the snapshot), and a nested metadata { isBackground, specialist?, createdByAgentId?, taskNoteId?, completionReport?, completionReportTimestamp?, attentionRequestKind?, attentionRequestReason?, attentionRequestTimestamp?, delegationDepth?, initialMessage?, dismissedQuestionsMessageId?, lastSeenMessageId?, isInitialAgent? } (the P3-1.2b persistence-gap fields plus the pending attention request raised by `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` — see the agent-attention-requests block below — plus the v2.8 question-dismissal marker, the v4.5 per-conversation seen marker (`agent.markSeen`), and the initial-agent flag `isInitialAgent?: true` — presence-detected from the raw session metadata the `workspace.create` initial-agent orchestration stamps (§5.1), present only as `true` and omitted otherwise (never `false`, never `null`); omitted when absent). `metadata.isBackground` is served from the persisted session flag (harvested at spawn; G-A1/P3-1.2c) so rehydrated background agents stay background. **Live-turn preview overlay ([intent-hq/intentd#786](https://github.com/intent-hq/intentd/pull/786), read-path):** while a turn is in flight (`isResponding` with the live-turn slot held by a busy worker — orphan slots without a busy worker are ignored, the same gate as the STAB-125 turn-liveness reads below), `lastAgentResponse`/`digest` are derived from the live turn's streamed-so-far text (the same extraction that derives the persisted-preview fields from the newest assistant row) instead of the persisted last-assistant-message preview, with a **per-field** fallback: a turn that has streamed no text (or no digest) yet keeps the persisted value, so an early turn never blanks the previous preview. Mid-turn `lastAgentResponse` is additionally **clipped at the last completed newline** ([intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795)) — the still-streaming trailing partial line is excluded, and a turn with no completed line yet keeps the persisted value (same per-field fallback); `digest` derives from the **unclipped** text, since its capture requires the closing tag (an unclosed opener never leaks). Terminal `agent:stream:end` and persisted previews are unclipped (§7). Read-path only — nothing new is persisted, and idle agents serve the persisted newest-assistant-message preview exactly as before. **`lastMessageRole` ([intent-hq/intentd#807](https://github.com/intent-hq/intentd/pull/807), additive):** `"user" \| "assistant"` — the role of the session's newest user/assistant transcript message; system (and any other) rows are transparent, and the field is **omitted** when the transcript has neither (absent, never `null`) — the structured signal behind conversation previews (was the last word the user's or the agent's?). Denormalized onto the session row at message-write time, so the full-transcript and transcript-free projection paths serve the same value. **Live-turn read-path overlay:** while a turn is in flight the field flips to `"assistant"` exactly when the live `lastAgentResponse` overlay applies (the in-flight turn has derivable streamed text — same per-field gate as above), since the newest live message is then the assistant's; a turn that has not streamed derivable text yet serves the persisted value (typically `"user"`) unchanged. **`lastMessageId` ([intent-hq/intentd#1039](https://github.com/intent-hq/intentd/pull/1039), additive; [monorepo#1597](https://github.com/intent-hq/monorepo/issues/1597)):** the row id of the session's newest **user/assistant** transcript message — the same row whose role `lastMessageRole` reports, with the same transparency rule (system and any other rows are transparent) — and the field is **omitted** when the transcript has no user/assistant message (absent, never `null`). Denormalized onto the session row at message-write time alongside `lastMessageRole` (migration `0088_agent_session_last_message_id.sql`, one-time backfill from the newest user/assistant row; a NULL column degrades to omission without in-place repair and converges on the next user/assistant append), so the full-transcript and transcript-free projection paths serve the same value with no transcript hydration. **NO live-turn overlay** — deliberately unlike `lastMessageRole`: a streaming assistant message has no persisted row id yet, so mid-turn the field keeps naming the last persisted user/assistant row while `lastMessageRole` may already have flipped to `"assistant"` — the pair is NOT mutually consistent mid-turn. That staleness is acceptable by design: clients rank a running turn (`isResponding` / `turnInFlight`) above unread, so the field only needs to be right at rest. **Seen-marker comparison (equality semantics):** the intended client-side per-agent **unread** derivation against the v4.5 `metadata.lastSeenMessageId` seen marker (`agent.markSeen`, below) is `hasUnread = lastMessageRole === "assistant" && lastMessageId != null && lastMessageId !== metadata.lastSeenMessageId` — an **absent marker counts as unread**, and an absent `lastMessageId` (older daemon) derives `false` so pre-existing client heuristics keep working. Caveat: the seen marker names "the newest transcript message the user has seen", which can be a **system/tool row id** that `lastMessageId` never equals — a naive equality check against such a marker can stick unread forever. Clients should therefore prefer passing user/assistant row ids to `agent.markSeen` — equality is the ONLY sound comparison. Id ordering is deliberately NOT a fallback: message ids are not uniformly UUIDv7 (server-minted user rows are `user-msg-{uuid}`, and `agent.sendMessage` accepts arbitrary client-supplied `messageId` values), and even among v7 ids mint time is not persist order (an assistant id is minted at turn start but persisted at turn end, so a mid-turn system row's persist-time id can out-sort it) — use the transcript `seq`/position where ordering is needed, never the id. **Turn-liveness (STAB-125, additive):** `turnInFlight: bool` is `true` while an active worker is draining a `session/prompt` turn for the agent, and `lastStreamActivityAt` (RFC-3339; omitted when no turn is in flight) is the timestamp of the most recent stream event observed for that turn — a long turn persists nothing until it ends, so these let a poller tell a long-but-alive turn (timestamp advancing) from a wedged agent (timestamp pinned) while `lastActivity` stays pinned at the last persisted message. Caveat: the stamp only advances on stream traffic, so during a long silent tool call it pins too — combine with `isWaitingOnTool` to avoid misclassifying a healthy-but-slow tool turn. **Corrupted-session flag ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940), additive):** `sessionCorrupted: true` is present only when the session is parked in `error` (`status == "error"` is required for BOTH causes) AND either (a) the failure classifies as session-fatal (provider safety block, deterministic `session/prompt` 400 `invalidArgument` rejection) or (b) the consecutive-identical-failure streak hit the poisoned threshold — the structured signal that `agent.retry` will recreate the provider session (fresh `session/new`) instead of resuming, or that spawning a fresh agent is the right recovery. **Derived on emit** over the persisted (status, stop_reason) + the in-memory failure streak — never persisted as a column — and **omitted when `false`** (absent ≠ present-false on the wire). **Idle-visibility (within v3.1, additive):** `waitingOnHooks?: [{ hookId, name, nextRunAt?, expiresAt? }]` — light metadata for the agent's ACTIVE (`scheduled`/`running`) background hooks (§5.40), **omitted when empty** (absent, never `[]`; no code/lastState/logs), overlaid at serve time from one workspace-batched hook query (per-agent on `agent.get`) so clients can tell a hook-waiting idle agent from a stalled one; the same list is stamped on the `agent:idle` event payload and `agent.diagnostics` agent rows (§6.5). **Idle-visibility, unified external-wait (within v6.2, additive):** `waitingOnPrMonitors?: [{ monitorId, repo, prNumber, title? }]` — the same light-metadata treatment for the agent's ACTIVE PR monitors (§5.42), **omitted when empty**, overlaid at serve time from one workspace-batched monitor query (per-agent on `agent.get`), mirroring `waitingOnHooks` field-for-field; also stamped on `agent:idle` and `agent.diagnostics` agent rows |
| agent.listActive *(v4.1)* | — (daemon-global; accepts an empty params object, no `workspaceId`) | { streams: [{ agentId, sessionId, workspaceId, startTime }] } — the daemon-global list of **mid-turn** agents, served from the runtime manager's in-memory busy set (never a persisted-workspace/session scan; monorepo#1395 — the cheap poll behind "which agents are streaming right now?"). `sessionId` mirrors `agentId` (one session per agent). `startTime` is **epoch milliseconds** (i64, not RFC-3339): derived from the session's `updated_at`, which the turn-claim (`try_begin`) touches when the Active transition persists — so it approximates the current turn's start without a dedicated column (claim-time semantics; the wire name is part of the 4.1 contract). Entries are sorted by `agentId`; a busy agent whose session row is gone (e.g. a concurrent `agent.delete` mid-turn) is skipped rather than failing the response. `{ "streams": [] }` when no manager is attached or nothing is mid-turn. |
| agent.get | agentId (req), workspaceId? | { agent: AgentLite } — same projection as agent.list (including the intentd#786 live-turn preview overlay on `lastAgentResponse`/`digest`, the intentd#807 `lastMessageRole?` field with its live-turn flip, the intentd#1039 `lastMessageId?` field (deliberately no live-turn overlay), the STAB-125 `turnInFlight`/`lastStreamActivityAt` turn-liveness fields, the derived monorepo#940 `sessionCorrupted?` flag, and the session-discovered `effortLevels?`); -32602 with `error.data.code: "not-found"` if not found (falls back to disk) |
| agent.getConversation | agentId (req), limit?: number, nextToken?: string, aroundMessageId?: string, workspaceId? | { agentId, messages, truncated, totalMessages, nextToken, turnInFlight, lastStreamActivityAt } (capped to most-recent limit; `nextToken` is the opaque cursor for the next older page — `null` when no more history remains, non-null iff `truncated` is `true`; pass it back as the `nextToken` input to fetch the next page). **Seek (`aroundMessageId`, additive):** when present it takes precedence over any token and resolves to the page **containing** that message — half the (clamped) page budget goes to rows older than the target and the rest to the target and newer rows, clamped at either edge so the page stays full whenever the transcript has ≥ `limit` rows. An unknown message id is rejected with `-32602` naming the id (`unknown message id: <id>`). Seek pages — and the forward continuations minted from them — additionally carry `prevToken`: an opaque **forward** cursor that walks newer toward the live tail (`null` once the newest message has been returned); pass its value back as the `nextToken` input to fetch the next newer page. Their `nextToken` stays the standard backward cursor, so older continuation is ordinary paging (and `truncated` remains tied to older history alone). Both cursors index from the oldest end, so both are append-stable. Absent the param (and any seek-minted forward token), the response is **byte-identical** to before — the `prevToken` key is never added on legacy backward pages. `turnInFlight`/`lastStreamActivityAt` are the STAB-125 turn-liveness fields (same semantics as `agent.get`; here `lastStreamActivityAt` is always present and `null` when no turn is in flight — a deliberate surface asymmetry with the `AgentLite` projection of `agent.list`/`agent.get`, which **omits** the field instead) so a conversation read mid-turn — when nothing has persisted yet — is distinguishable from a wedged agent. **Serve-time block ids ([monorepo#1114](https://github.com/intent-hq/monorepo/issues/1114), [intent-hq/intentd#781](https://github.com/intent-hq/intentd/pull/781)):** every served content block carries an `id` — a block persisted id-less (non-assistant rows: `user`/`system`/`tool`) is stamped with the stable synthetic `{messageId}:{index}` (the row id + the block's 0-based index in the served array, stamped after the anonymous-tool-block strip) at serve time; assistant blocks always persist with ids, so the pass is a no-op for them. Serve-time only — stored rows are untouched, reads stay idempotent, no migration. Because the §7.1 seq-0 chat snapshot and the delta path's re-read both go through this method, snapshots, `agent.getConversation`, and §7.1 deltas agree byte-for-byte on block identity |
| agent.create | workspaceId (req), name?, nameExplicitlySet?: bool, model?, reasoningEffort? *(v5.2)*, specialistId?, idempotencyKey?, provider?, agentType?, metadata?, workspacePath?, workspaceContext?, contextReferences?, imageBlocks?, fileBlocks? *(v6.12)*, isBackground? | { agent: AgentLite } — full projection (same shape as `agent.get`); the pre-P2-12a `{ id, name }` snippet is a strict subset. `reasoningEffort` (v5.2) persists on the session **as-is** (the caller's spelling; providers interpret the level); an empty or whitespace-only value collapses to unset (an explicit clear that stops the resolution chain), and the created `AgentLite` echoes it. `effortLevels` is absent on the create result — the field is session-discovered at session open (see "Session-discovered effort levels" below), so it appears on subsequent `AgentLite` reads once the provider's first session open advertises its `thought_level` values. When the param is absent the effort resolves through the named specialist's model-option effort, then its `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12) — which applies only when the session's model itself resolved from the settings default chain, never alongside a caller-supplied `model` or a specialist model pin, and is dropped with a daemon warn log rather than rejected when the resolved model does not support it — then unset. The full chain is "Creation-time reasoning-effort resolution" below. A non-empty level is **validated against the resolved model's cached `effortLevels`** under the same contract as `agent.delegate` / `agent.wakeOrCreate` (§5.11 "Delegation reasoning-effort resolution"): evidence is the daemon's cached dynamic catalogs only (never a live probe), matching is case-insensitive, a level outside the listed values is rejected with `-32602` naming the model and the valid values **before any side effect** (no session row is persisted), and with no evidence — no resolved model, no cached row, or a row declaring no levels — the value passes through unvalidated. The agent's id is **server-assigned**: the daemon always mints a fresh `agent-{uuid}`, and a request carrying `agentId` is rejected with `-32602` ("agent IDs are server-assigned and the field must be omitted") before any side effect; an `idempotencyKey` replay returns the stored result carrying the originally minted id. `provider` persists on the session; both the resolved provider (the explicit `provider` param or, when absent, the provider prefix derived from a compound `model` id) **and** — when the resolved model is a compound id (`provider:model`) — the model's provider prefix (validated even alongside a valid explicit `provider`, since the spawn path gives the model prefix precedence; a plain or absent `model` carries no prefix and adds no extra validation) must name a registered ACP provider: an unknown id is rejected with `-32602` (`agent.create: unknown provider: <id> (known providers: ...)`) **before any side effect** (no session row is persisted, no default-provider fallback occurs). An absent provider (defaulting) remains valid. A **bare** `model` (no `:` prefix) supplied by the client is additionally checked for ownership: evidence is **the daemon's cached dynamic catalogs only** (the in-memory last-good `models.list` entries under each provider's current registry version key, §5.30 — read-only, never a live probe; the former static-tier evidence path went with the tier tables, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)). The effective provider for the check is the explicit `provider` param, else the settings-derived default (provider of `model.default`, else `providers.active`), bottoming out at the first registered provider. A cached-catalog claim by another provider rejects with `-32602` (`agent.create: model <id> does not belong to provider <p> (providers with this model: ...)`) before any side effect, but only when the effective provider's ownership is affirmatively disproven — its own cached catalog exists but lacks the id; with no cached entry for the effective provider (cold start) the bare id passes — absence of evidence is not a mismatch. Bare ids with no ownership evidence anywhere pass unchanged, and the literal id `"default"` is a CLI-default sentinel that passes for every provider. A mismatched bare model arriving from the **settings chain** (global default / specialist frontmatter) rather than the client is not rejected — it falls back to the provider's CLI default (`session.model` stays unset) with a daemon warn log. **Name default (specialist-derived).** When `name` is omitted but a specialist id is supplied, the agent's name defaults to the specialist's resolved display name (frontmatter `name`, 3-tier project > user > bundled — e.g. "Coordinator" for `spec-writer`); an unknown specialist or a resolution failure never fails the create — the name falls back to the generated `Agent {6-hex}` placeholder. The same derivation applies to `workspace.create`'s `initialAgent` (§5.1). `nameExplicitlySet` controls the persisted rename-guard flag: `false` marks a supplied `name` as a non-explicit placeholder so the agent's guarded opening-turn self-rename (`agent.rename` with `skipIfExplicitlySet: true`) still applies. The flag is honored independently of `name` — supplied without a `name`, it applies to the server-generated placeholder name (`nameExplicitlySet: true` with no `name` persists the guard on the placeholder). Omitted or JSON `null` both read as absent and keep the default (`true` whenever a `name` is supplied **or** a specialist-derived default name resolved — the derived default behaves like a client-supplied explicit name, matching the desktop FE which resolves it client-side; `false` otherwise, including the `Agent {6-hex}` fallback); any other non-boolean value is rejected with `-32602` ("nameExplicitlySet must be a boolean") — `null` is never rejected. `metadata` is harvested for the persisted gap fields (`delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`, `fileBlocks` (v6.12); P3-1.2b — plus `isBackground`, G-A1/P3-1.2c) with the top-level `contextReferences`/`imageBlocks`/`fileBlocks`/`isBackground` params winning over the `metadata` copies; `isBackground` defaults to `false` when absent from both. `fileBlocks` entries (v6.12) are validated at the create seam under the same exactly-one-of-`data`/`attachmentId` rule as `agent.sendMessage` (`-32602` before any side effect). `agentType`/`workspacePath`/`workspaceContext` remain accepted-but-unpersisted (deferred per the P2-12a audit). Emits `agent:created`. |
| agent.delegate | workspaceId (req) + delegate opts (taskNoteId?, noteId?, taskText?, agentInstructions?, specialist?, model?, reasoningEffort?, behaviorPrompt?, waitMode?, skipAutoCommit?, isolation?, force?: bool, tasks?: [taskNoteId | { taskNoteId, specialist?, model?, reasoningEffort? }]) | `{ ok: true, agentId, name, provider?, effectiveIsolation? }` (single-task form; see the batch form below) — **Reasoning effort (additive).** `reasoningEffort` sets the child session's reasoning level (§5.5); when omitted it resolves through the chosen specialist model option's `reasoningEffort`, then the specialist's `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12; only when the session's model itself resolved from the settings chain — and dropped with a warn instead of rejected when unsupported), then unset. Whatever resolves is validated against the cached catalog's `effortLevels` for the resolved model and a level outside that list is rejected with `-32602` naming the valid values **before any side effect**; with no cached evidence the value passes through (full contract in §5.11 "Delegation reasoning-effort resolution"). the child session persists `metadata.initialMessage` (the resolved first message) and `metadata.delegationDepth` (parent depth + 1) so a wake-up can resume (P3-1.2b); delegated children always persist `isBackground: true` (matching the TS `DelegateTaskTool`; G-A1/P3-1.2c). **Provider resolution when `model` is omitted (new in intentd).** `agent.delegate` has no `provider` param on the wire, so a caller that supplies no `model` resolves the delegated agent's provider itself, in order: (1) the specialist's frontmatter `codingAgent` (or, if unset, the provider prefix of its frontmatter `model` when compound) — 3-tier resolved (project > user > bundled); (2) otherwise the settings-derived default: the provider prefix of `model.default` when compound and registry-valid, else `providers.active` (§5.12; [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)); (3) if neither is set, `provider` is left unresolved and the spawn path's own last resort applies (the first registered provider — a neutral positional fallback; no provider carries a default designation). Whichever provider is resolved by (1) or (2) MUST be a known, available provider (per the daemon's provider discovery) — an unavailable resolved provider fails the call with `-32602` naming it, rather than silently substituting another provider. A `model` explicitly supplied by the caller (bare or compound) opts out of this resolution entirely, unchanged. **`provider` result field (additive response field, presence-detected).** The single-task result surfaces the resolved ACP provider persisted on the created session (the same value `AgentLite.provider` serves) as `provider?: "<id>"` — so clients can render the correct provider affordance immediately, before the agent session loads. Omitted — never `null` — when the session has no persisted provider (resolution step (3): the spawn path's own last resort applies). The batch form's `started` rows are unchanged (`agentId`/`agentName` only). **Occupancy guard (intentd#774).** A task note that already has a live assigned agent cannot be silently double-delegated: when the target task's newest assigned agent is live — loadable, not Deleted, not poisoned (the same live/resumable predicate as `agent.wakeOrCreate`'s newest-first scan) — and the task status is not `complete`/`cancelled`, the call is rejected with `-32602` (InvalidParams); the error message names the existing agent's id and name and suggests `agent.sendToTask` / `agent.wakeOrCreate` to reach it, or `force: true` to intentionally add a second agent. The guard runs BEFORE any side-effectful work (child creation, group enrollment), so a rejection leaves no orphaned child. `force: true` bypasses the guard; `agent.wakeOrCreate`'s behavior is unchanged (it already routes to the existing live agent). `task.assignAgent` applies the same guard when assigning a NEW agent to an occupied task (§5.4). **Sandbox isolation (new in intentd).** `isolation` controls whether the delegated agent runs in an isolated sandbox: `"cow"` provisions a copy-on-write directory clone (requires CoW filesystem support; see below), `"direct"` runs in the shared workspace checkout. When `isolation` is omitted, the default comes from the `workspace.cowIsolation` setting (§5.12): enabled ⇒ `"cow"`, disabled ⇒ `"direct"`. CoW sandboxes are full-directory clones of the sandbox source (including `.git` and build caches) via OS-level copy-on-write primitives (macOS `clonefile(2)` whole-tree fast path with best-effort walk fallback on APFS, Linux `ioctl(FICLONE)` on Btrfs/XFS with reflink support); the sandbox directory layout is `<workspaces_root>/<workspaceId>/sandboxes/<agentId>/<repo-slug>` with a snapshot branch `sb/<agentId>` created in the sandbox's `.git`. **Sandbox eligibility & source (checkout-mode aware).** Shared-checkout workspaces (`skipIsolation`/no provisioned checkout, i.e. no `checkoutMode`, with a `repositoryPath`) source the sandbox from the user's repository folder; CoW-checkout workspaces (`checkoutMode: "cow"`, §5.1) source it from the **workspace checkout** (`worktreePath`); `checkoutMode: "direct"` workspaces (standalone plain clone) source it from the workspace checkout when one was provisioned (cache hydration), else from the repository folder itself (`isNewRepo` initialization). Worktree-mode workspaces (`checkoutMode: "worktree"`) are not sandbox-eligible — the agent keeps the shared checkout and the delegation proceeds without a sandbox. **Asynchronous provisioning & `effectiveIsolation` (changed by intentd#636).** Sandbox provisioning runs OFF the delegate critical path: when `isolation: "cow"` resolves and the workspace is sandbox-eligible, the daemon registers a per-agent settlement gate, kicks off the CoW clone in a background task, and returns immediately with `effectiveIsolation: "pending"` — the only value the field carries today (`"cow"` and `"direct"` are no longer returned; a large clone can take tens of seconds, which previously starved the agent-facing MCP `workspace_api` tool's per-invocation wall-clock budget — `WORKSPACE_API_TIMEOUT`, default 30s, overridable via the `INTENTD_WORKSPACE_API_TIMEOUT_MS` env var: a positive integer in milliseconds, read at MCP-server construction; unset, non-numeric, or non-positive values keep the default). `effectiveIsolation` is omitted when no CoW isolation was resolved (explicit `"direct"`, setting disabled, the worktree-mode ineligibility skip, or no sandbox source). The settled outcome is observable rather than returned: on success the child session's TOP-LEVEL fields (not nested under metadata) `sandbox_id`, `sandbox_path`, and `sandbox_branch` are persisted and served in both `AgentSession` and `AgentLite`, and a `sandbox:cow:created` event is emitted with `data { workspaceId, agentId, sandboxPath, branch, baseCommitSha, snapshotCommitSha }`; when the filesystem does not support CoW reflinks — or provisioning fails — the daemon falls back to shared (`"direct"`) mode exactly as before (no bytes copied, log-only): the session keeps no sandbox fields and no `sandbox:cow:created` fires. A third settlement outcome covers the delete race: because the clone runs off the delegate critical path, `agent.delete` can race it — when the child session is gone or soft-deleted by settlement time, the daemon discards the just-provisioned sandbox (directory + store record) instead of stranding the clone on disk; again no sandbox fields persist and no `sandbox:cow:created` fires. The child's first ACP spawn is gated on settlement: its turn worker awaits the in-flight provisioning before spawning, so the child never runs against a half-copied sandbox. The sandbox directory is never auto-cleaned once settled — except for the delete-race discard above — cleanup is otherwise the responsibility of higher-level orchestration. All agent file/exec/terminal/search operations are restricted to the sandbox path when present (logical containment guards in `intent-services`), preventing escape to the main workspace or parent directories. **Batch form (`tasks`, within v6.8; reworked in v7.0 — part 2 of monorepo#2457).** `tasks: [entry, ...]` (non-empty; each entry either a bare taskNoteId string or an object `{ taskNoteId, specialist?, model?, reasoningEffort? }` whose per-task options override the call's top-level defaults for that task only; every named id must be a task note in the workspace, else `-32602` naming the unknown ids; mutually exclusive with `taskNoteId`/`noteId`/`taskText` — mixing rejects with `-32602`) switches the call to batch mode with the result shape `{ ok: true, tasks: [row], startedTaskIds, unlockPlan: { unlockedBySettlement, message, criticalPathMinutes? } }` — every supplied task is enumerated (deduped, order-preserving), nothing silently omitted. Classification is a PURE, STATELESS function of current state (task statuses, `dependsOn`/`conflictsWith` edges, live assigned agents — the same live/resumable predicate as the occupancy guard above); the call writes NO scheduler state, which is what makes re-supplying the same list idempotent. Each row carries `taskNoteId`, `title`, `disposition`, `reason` (on every non-started row), and per-disposition fields: `started` (delegated through the unchanged single-task path — per-task agent creation and group enrollment honoring `waitMode`, with `behaviorPrompt`/`skipAutoCommit`/`isolation` inherited per task and `specialist`/`model`/`reasoningEffort` resolved per task — the entry's own value when present, else the call's top-level default; carries `agentId`/`agentName`); `held:blocked-on-deps` (`unmetDependsOn` names the incomplete dependency ids; the `decisionNeeded` subset names cancelled/missing dependencies that can never complete on their own — surfaced in the reason as "decision needed"; failed/cancelled dependencies need no special wake path — they simply reappear here on the next call); `held:conflict` (`conflictsWith` names the running/starting tasks whose symmetric `conflictsWith` closure overlaps this one; the reason points at delegating the held task individually to force it — the conflict relation is evaluated symmetrically over ALL workspace task notes, so a running non-listed task still holds a listed one, and tasks started earlier in the same batch count toward the running set for later entries. **Admission order (within v6.8, [intent-hq/intentd#1112](https://github.com/intent-hq/intentd/pull/1112)):** startable tasks are admitted in **effort-weighted critical-path priority order**, not list order — a deterministic list-scheduling heuristic, deliberately not an exact solver (makespan minimization under `dependsOn` + `conflictsWith` is NP-complete). Each workable task's priority is its own effort plus the longest effort-weighted chain of workable dependents downstream of it (one topological pass over the reverse-`dependsOn` graph); efforts come from a best-effort parse of the task's free-form `estimatedEffort` string — units min/h/d with a day counted as 8 work-hours (e.g. `"30 min"`, `"2h"`, `"~45m"`, `"1h 30m"`, `"1d"`), hyphenated ranges → midpoint (`"1-2h"` → 90; a failed range parse falls through to a plain parse, so `"90-minute"` → 90), parsed values clamped to a 175,200-minute cap (a year of 8-hour workdays), unparseable/missing estimates defaulting to a neutral 30 minutes. Startable tasks are admitted in descending priority, holding any whose `conflictsWith` closure intersects the admitted/running set — so a conflict resolves in favor of the task heading the longest remaining dependent chain, not the one listed first; ties break by most distinct dependents unlocked (`dependsOn` edges deduped per note), then shortest own effort, then task id — fully deterministic); `skipped` (already running — carries the live `agentId`/`agentName` — or task status `complete`/`cancelled`); or `error` (a start-classified task whose individual delegation failed; earlier rows may already have started — the batch never rolls back). **Relation-less annotation (within v7.0, part 3 of monorepo#2457 — [intent-hq/intentd#1237](https://github.com/intent-hq/intentd/pull/1237)).** A row whose task the relation graph does not cover — its own `dependsOn` and `conflictsWith` both empty AND not referenced by any other REQUESTED task's relations (references count from requested tasks only, so an edge from an unrequested note does not cover a requested one) — additionally carries `relationsUnknown: true` (presence-detected additive field; omitted when the graph covers the task, never `false`). Annotation only: classification is untouched — the flag never changes a disposition — and when any flagged tasks actually start, `unlockPlan.message` additionally appends `N of M started tasks carry no relations — the graph does not cover them.`, so a caller can tell "ready by the graph" apart from "the graph says nothing about this task". `unlockPlan.unlockedBySettlement` projects from the dependency graph — by simulating the ACTUALLY-started set (a start whose delegation errored never counts) plus EVERY workable task with a live assigned agent, requested or not, completing — which held tasks become startable at settlement, and `message` instructs the caller to re-call `agent.delegate` then (same list or a subset; classification is recomputed every call). `unlockPlan.criticalPathMinutes` (optional, within v6.8 — [intent-hq/intentd#1112](https://github.com/intent-hq/intentd/pull/1112)) is the remaining serial work: the longest effort-weighted `dependsOn` chain through the requested tasks (their critical-path priority already spans all downstream dependents), also echoed into `message` as `~N min of serial work remains on the critical path.`. Present only when at least one requested task's max-attaining chain carries a parsed estimate: the max is taken over estimated chains only (within v6.14, [intent-hq/intentd#1160](https://github.com/intent-hq/intentd/pull/1160), monorepo#2128 — previously the single global max chain had to be estimated, so a longer chain of pure 30-min defaults suppressed the estimate entirely), so a pure-defaults-only graph still omits the field (never `null` or `0`), a longer unestimated chain neither suppresses nor inflates the estimated one, and the reported number reflects only estimated chains — it can understate when an unestimated chain is longer. Deliberately downstream-only: an incomplete upstream dependency outside the requested set does NOT count toward the estimate, so partial batches can understate total remaining serial time. Response text only — the field changes no wake or settlement behavior. The daemon NEVER auto-starts held tasks; the existing delegation-group settlement wake (`waitMode: "after_all"`) is the resume signal. The delegation-depth and watch-scope guards run once up front (`-32602` before any child is created). Batch mode rejects `agentInstructions` (top-level AND per-entry) and `force: true` with `-32602` rather than silently dropping them (each started task's first message resolves from its own task note, and occupied tasks classify as `skipped` — use the single-task form to force a second agent). **`greedy` removed (v7.0, breaking).** The former batch-level conflict override is gone: a request passing `greedy` (any value) is rejected with `-32602` ("greedy was removed; delegate a held task individually to force it past the conflict hold"), the result no longer echoes `greedy`, and `started` rows never carry conflict overlap — the single-task form already bypasses classification, so it is the one force path. Single-task calls (`tasks` absent) are byte-identical to the pre-batch contract above |
| agent.sendToTask | taskNoteId (req), message (req), priority?, messageMetadata? | service result — `priority: "interrupt"` preempts the assignee's in-flight turn keep-alive (the agent process is never killed) and delivers immediately instead of the plain persist. `messageMetadata` is the same opaque per-message payload as `agent.sendMessage`, persisted on the assignee's user message row; it is threaded through both the runtime turn path and the store-only fallback (read-only wiring with no agent manager), so attribution is consistent across deployments. **Question hold (v2.8):** sendToTask is an automatic delivery by definition — while the assignee's question hold is active (see "Question hold" below) the message parks in the queue instead of delivering, `priority: "interrupt"` included (the interrupt skips the preemption entirely and parks front-of-queue with `interruptPriority: true`); the parked result is `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId? }`, on the runtime and store-only paths alike |
| agent.sendMessage | agentId (req), content (req), workspaceId (req), messageId?, imageBlocks?, fileBlocks?, priority?, noteIds?, stdinContext?, contextReferences?, messageMetadata?, model?, assistantMessageId?, assistantAppMessageId?, userAppMessageId? | { success, queued, messageId? \| queuedMessage?, turnId? } — **Unknown agent → fail closed.** A nonexistent `agentId` (e.g. a truncated id) is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE any state change — no phantom queue entry, no slot claim, no interrupt-dedup record — on both the runtime-manager and store-only paths, and the same guard applies to the SUB-1 sender auto-subscribe (the MCP `ws.agent.send` binding's caller→target completion watch is never registered for a nonexistent target). **SUB-1 sender auto-subscribe is one-directional (parent→child only).** The MCP `ws.agent.send` / `ws.agent.sendToTask` bindings register a caller→target completion watch for the sender UNLESS the sender is a **child of the target** — the caller session's `parent_agent_id` equals the target, falling back to the metadata `createdByAgentId` linkage — so a child messaging its own parent registers NO watch and the send result carries no `subscriptionId`/notification blurb (the watch op returns `{ ok: false, subscriptionId: null }`, the same skip shape as the delegated-background-task-sender and undelivered-`after_all`-group suppressions). The auto-queue-on-failure fallback below applies only to store-append failures on an EXISTING agent (e.g. a duplicate client-supplied `messageId`); an agent deleted mid-send (between the validation and the append) is also rejected with the same `-32602` instead of auto-queueing. `priority: "interrupt"` preempts an in-flight turn instead of queueing: the current turn is cancelled keep-alive (`session/cancel` + one terminal `agent:stream:end`; the agent process is never killed) and the message streams immediately as a fresh turn on the same session (`queued: false`); the pending queue is preserved and drains afterwards. On an idle agent, interrupt priority falls through to the normal send path. **Zero-output interrupt → combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)):** when the preempted turn produced no assistant output (the provider drops the cancelled prompt), the preempted user message's text and attachments are delivered AHEAD of the interrupt message inside the SAME `session/prompt`, so both messages are honored in original order — the original is NOT re-queued, the queue stays untouched, and both already-persisted user rows stay intact (the combined prompt is wire-only, never re-persisted). If the turn has already progressed (any assistant/tool/system row after the last user row — excluding the still-empty interrupted marker row the preemption itself just persisted, §7.2 always-persist semantics within v4.5), only the interrupt message is delivered. This combined-delivery behavior applies to ALL interrupt-priority sends — `agent.sendToTask` with `priority: "interrupt"` routes through the same preemption path and behaves identically. **Duplicate delivery** of the SAME interrupt (same client-supplied `messageId`) preempts exactly once: the duplicate is acknowledged idempotently as `{ success: true, queued: false, messageId, deduplicated: true }` — no second preemption, message NOT double-persisted (dedup keys on `messageId`; omit it and duplicates are indistinguishable from new sends). **During turn startup** (busy slot claimed but no cancellable turn live yet — spawn/`session/new` in flight) the preemption is skipped and the message queues keep-alive behind the starting turn (`queued: true`); the agent is never killed and never fails. **Per-turn prompt-assembly hints (Fidelity B).** `stdinContext` is prepended verbatim to the outbound prompt as a `Context:\n<stdin>\n\n---\n\n` block (reference-parity `acp-provider.ts`); when absent, one is synthesised from `contextReferences` (port of `agent-backend-handler.service.ts`’s builder — first-non-empty wins across `content` / `selectedText` / `taskText` / `codeChunk`, with per-`type` framing for `selection` / `task` / `code_chunk` / `file` / `linear-issue` / `github-issue` / `sentry-issue` / `terminal`; unknown types fall through to the raw content). `noteIds` are resolved to workspace-asset image content blocks: each note's markdown is scanned for `workspace-asset://<workspaceId>/<assetId>` URLs in the current workspace, the referenced bytes are appended as ACP `image` blocks, and a single system text notice is added noting how many images were inlined. `messageMetadata` is JSON persisted on the user message row (new `agent_message.metadata` column) and echoed on read — used by clients (e.g. `{ source: "system" }`) to distinguish daemon-initiated turns. Non-reserved fields are opaque (never inspected by the daemon), but a few reserved fields ARE read or written daemon-side: `fromAgentId`/`fromAgentName` are daemon-stamped on agent-origin sends (the sender-attribution block below) and `userAppMessageId` is validated/folded by the router (the client-message-identity block below). **Row identity + events.** A direct (non-queued) send persists the user row UNDER the client-supplied `messageId` when given (validated ≤ 256 bytes, `-32602` otherwise) — else a server-minted `user-msg-{uuid}` — the result `messageId` IS that persisted row id, and the daemon emits `agent:message` `{ agentId, messageId, role: "user", appMessageId? }` for the append (`appMessageId` present only when the row carries a `userAppMessageId`) (same event the queue-drain and wake-delivery persists emit), so clients converge on the canonical row without a refetch race. **Sender attribution (`agent_message`, new in intentd).** Agent-originated sends through the MCP host bindings — `ws.agent.send`, `ws.agent.sendToTask`, and the `ws.agent.create` kickoff message — are auto-tagged by the daemon with `messageMetadata = { "type": "agent_message", "fromAgentId": string, "fromAgentName": string \| null }` so recipients and clients can attribute who sent the message. An explicit caller-supplied `messageMetadata` keeps its own fields, but the attribution fields (`fromAgentId`/`fromAgentName`) are **daemon-stamped** for agent callers — always overwritten with the real caller identity, since [intentd#816](https://github.com/intent-hq/intentd/pull/816) made `fromAgentId` security-relevant (single-pending-send guard + `ws.agent.removeQueuedMessage` ownership; a `null` metadata value is treated as absent and does NOT suppress the auto-tag); `fromAgentName` is always present for a stable schema and is `null` when the sender's session lookup fails. Human-originated FE/RPC sends (no agent caller, no explicit metadata) stay untagged. The tag persists on the user message row and survives the busy-agent queued path — the enqueue captures it and the drain-time persist writes it — including the store-only fallback. **Client message identity (`userAppMessageId`).** The FE’s client-minted optimistic-message id is consumed by the router: it is trimmed, validated ≤ 256 bytes (`-32602` otherwise; whitespace-only reads as absent), folded into the row `messageMetadata` under `userAppMessageId` (the top-level param wins over a caller-supplied metadata copy; supplying it alongside a non-object `messageMetadata` is `-32602`), lifted back out as the top-level `appMessageId` field on `AgentMessage` reads (`agent.getConversation` / `agent.getSession`), and echoed as `appMessageId` on the user-row `agent:message` event — activating the FE’s optimistic-insert dedup guard. The id survives the busy-agent queued path (enqueue capture → drain-time persist) but is excluded from the drain persist’s in-block `messageMetadata` copy (row-level only) so queued rows’ content blocks match direct-send rows. Requests without it are byte-for-byte unchanged (no `appMessageId` key on rows or events). **Daemon-ignored fields (FE-forwarded, unwired daemon-side).** The assistant-side ids (`assistantMessageId` / `assistantAppMessageId`) are accepted by the router but not consumed: assistant rows are keyed on the server-minted row `id`. Per-turn `model` override is likewise accepted but **not extracted** by the daemon router today; the session-level model set at `agent.create` / `agent.setModel` remains authoritative (deferred pending an ACP-provider-side change to switch model mid-session). **Turn correlation (`turnId`, [monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022) / [intentd#699](https://github.com/intent-hq/intentd/pull/699)).** Every runtime result arm additionally carries `turnId` — the daemon-minted stable correlation id for the user-initiated turn. A direct (non-queued) send mints it at dispatch, BEFORE the persist, so the user-row `agent:message` echo, the RPC result, and the turn's lifecycle events all carry the SAME id; the queued arms (busy-agent, quarantined, auto-queue fallback) return the enqueued entry's `turnId` (= the entry `id` at first enqueue). The id is preserved across terminal-failure requeues — the requeued entry gets a NEW entry `id` but keeps the failed turn's ORIGINAL `turnId` — so the `agent:failed` / terminal `agent:stream:end` of the failed turn AND the `agent:queue:processing` / lifecycle events of an `agent.retry` redrive all correlate with the id the client keyed at send time (§6.5/§6.6). Exceptions: the idempotent duplicate-interrupt ack (`deduplicated: true`) and the store-only fallback's direct arm carry no `turnId` (the store-only auto-queue arm does). Always omitted when absent, never `null`. **Question hold (v2.8).** The FE/router `agent.sendMessage` front door is a **user-origin** send and is never held — it bypasses an active hold and delivers (or queues on the normal busy path); with a parked ready backlog under the `"all"` flush mode the delivery takes the queue route instead of a direct turn ([monorepo#1791](https://github.com/intent-hq/monorepo/issues/1791) FIFO restore, [intentd#1059](https://github.com/intent-hq/intentd/pull/1059)): the send converts to a user-origin enqueue + drain kick returning the ordinary `{ success: true, queued: true, queuedMessage, turnId }` (no `heldForQuestions`), and the parked entries ride the same combined flush turn FIFO ahead of it — see the §5.5 Question-hold "What bypasses" block. Bypassing is **not** releasing (within v6.0, [intentd#965](https://github.com/intent-hq/intentd/pull/965)): a plain user row leaves the hold armed, and only a row whose `messageMetadata` is `{ type: "question_answers", answeredQuestionsMessageId }` naming exactly the marked assistant message retires it (the answer intake runs on every user-row persist path, so an answer that auto-queued behind a busy turn still releases on drain). Internal **automatic** sends routed through the same turn machinery (MCP `ws.agent.send`, A2A wakes, event-subscription batches, internal continuations) ARE gated: while the target's hold is active they park in the queue with the result `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId }` — `heldForQuestions: true` is the additive marker distinguishing a hold park from an ordinary busy-queue park, present only on held results (never `false`). An automatic `priority: "interrupt"` send is ALSO held — no exceptions — parking front-of-queue with `interruptPriority: true` (the interrupt-dedup record is still written first, so a duplicate replay while held — or after release — still acks `deduplicated: true` without double-enqueueing). See "Question hold" below the table for the derivation and release semantics |
| agent.sendQueuedMessageNow | agentId (req), messageId (req), workspaceId (req) | { success: true, queued: false, messageId, turnId } on the atomic send — the normal outcome; the full result is a union with two `{ success: true, queued: true, queuedMessage }` variants (slot-race and quarantined, described below), which carry the wire-shape `queuedMessage` (the entry, as `agent.getQueue` serves it) INSTEAD of a `messageId`, so clients must branch on `queued`. Atomically dequeues the pending-queue entry named by `messageId` and delivers it immediately with interrupt priority, **preserving the rest of the queue**. The method takes no content params: the delivered turn carries the entry's own captured payload (content, `imageBlocks`/`fileBlocks`, `messageMetadata` from enqueue time), and the result `messageId` is the entry id — which is also the persisted user row id. **Fail closed / not idempotent.** A nonexistent `agentId` is rejected with `-32602` (`unknown agent id: <id>`) BEFORE the queue is touched (same guard as `agent.sendMessage`); an absent queue entry is rejected with `-32602` (`queued message not found: <id>`) with NO side effects — deliberately NOT idempotent (unlike `agent.removeQueuedMessage`), so the client knows the atomic send did not happen. **Atomic dequeue + interrupt delivery.** The removal happens under the queue lock (no concurrent drain can deliver the same entry twice), and the shrunk queue is republished as `agent:queue:updated` (write-through persisted) before the turn starts. A busy agent is preempted keep-alive — the same `session/cancel` + worker-abort as `agent.sendMessage` with `priority: "interrupt"`; the agent process is never killed — and the zero-output combined delivery ([monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014)) applies identically: a preempted zero-output user message rides the delivered turn's prompt AHEAD of the entry content (an entry already carrying its own requeued prepend payload keeps that payload first, in transcript order). An idle agent starts the turn directly. The user row is persisted UNDER the entry id and the standard user-row `agent:message` event (`role: "user"`) is emitted; a terminal-failure requeued entry whose user row already reached the transcript is not re-appended (the delivery reuses the existing row). Stale queued-message redrives on delegated agents keep the #576 semantics documented under `agent.reportToParent` (report-clear suppression + `[SYSTEM NOTE]` annotation). **Queued outcomes (success, not errors).** When the in-flight slot cannot be claimed (turn startup, or a concurrent send won the race) the entry is restored at the FRONT of the queue — next to drain — and the result is { success: true, queued: true, queuedMessage }. A quarantined (poisoned, monorepo#840) session is not redriven: the entry stays in the queue untouched and the result is { success: true, queued: true, quarantined: true, queuedMessage } (`agent.retry` is the deliberate redrive); the absent-entry case is still `-32602`. **Never-lost guarantee.** On a user-row persist failure the entry is restored at the FRONT of the queue (durability state untouched, so a retry re-appends correctly) and `agent:queue:updated` is republished before the error surfaces. The store-only fallback (no agent manager attached) honors the same atomic contract — dequeue, persist under the entry id, emit `agent:message`, restore-at-front on failure — without starting a turn. This path emits **no** `agent:queue:processing` (§6.5 — that drain-start signal belongs to the queue-drain loop). **`turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)):** the delivered arm is `{ success: true, queued: false, messageId, turnId }` — `turnId` is the entry's preserved turn correlation id (the same id the enqueueing RPC returned), stamped on both the `agent:message` echo this delivery emits and the delivered turn's lifecycle events; the queued/quarantined arms' `queuedMessage` carries the entry's `turnId?` field per the `agent.queueMessage` wire shape; the store-only fallback's result carries no `turnId`. **Question hold (v2.8):** `agent.sendQueuedMessageNow` is an explicit user action — it is NOT gated by an active question hold. Within v6.0 the delivered row releases the hold only when it carries the `question_answers` answer tag for the marked message (the same intake as every other user-row persist path); an untagged entry delivers with the hold still armed |
| agent.dismissQuestions *(v2.8; model notice added within v4.3, intentd#892)* | agentId (req), messageId (req), workspaceId (req) | { success: true, dismissedQuestionsMessageId } — dismiss the pending question set of the assistant message named by `messageId` (the message carrying the trailing `application/vnd.intent.question+json` resource blocks, §7) WITHOUT answering: persists the dismissal marker `dismissedQuestionsMessageId` in the session metadata (survives daemon restarts, so the dismissed set never re-surfaces), emits `agent:updated` with `{ agentId, dismissedQuestionsMessageId }`, and kicks the queue drain so deliveries parked by the question hold resume immediately (no waiting for the next end-of-turn drain). **The model IS notified** (intentd#892; supersedes the pre-#892 no-notify contract): after the marker persist and hold release, the daemon delivers a **system-origin notice** to the agent — "User dismissed your N questions without answering. This is an informative notice only — do not re-ask and do not proceed with any work; end your turn and wait for the user's next message." (informative-only wording since intentd#930; the pre-#930 notice told the agent to "continue with your best judgment") — with count-aware wording (singular "1 question", plural "N questions", and a countless fallback when the dismissed message's question-block count cannot be derived; the count is computed at bounded cost — index seek + single-row page, no transcript hydration). The notice carries `messageMetadata { "type": "questions_dismissed", "source": "system", "dismissedQuestionsMessageId": "<id>" }`, exposed on the queued entry while undelivered (`agent.getQueue`) and persisted on the delivered user row (row `metadata` and served block metadata). Delivery: an **idle** agent receives the notice as an immediate turn (the wake-delivery path); when it must queue (agent busy, or a NEWER question still holds automatic deliveries), the entry is **promoted to the absolute queue head** (position 0) with `interruptPriority: true` — unlike the normal interrupt insertion order (which slots behind existing interrupt-priority entries, see `agent.queueMessage`), the promotion places the notice ahead of EVERY parked entry, including pre-existing interrupts. The ordering is best-effort under a concurrent drain race: the promotion is a separate queue-lock acquisition from the enqueue, so a racing drain may pop a previously parked entry (or the notice itself) in the window between them — the notice still delivers, just not strictly first. **Idempotent**: re-dismissing the same `messageId` succeeds, rewrites the same marker, and sends NO duplicate notice — guarded by the persisted dismissal marker (written before the notice is enqueued so the hold cannot re-park it) plus an in-memory per-agent notice registry that also covers re-dismissing an OLDER message id after the single-slot marker was overwritten by a newer dismissal (the registry is process-local; the marker alone guards across restarts). **Fail-soft**: notice delivery errors are logged; the RPC never fails because of the notice. Validation: an empty `messageId` or one exceeding 256 bytes is `-32602`; a nonexistent `agentId` or a workspace mismatch is a not-found error (fail closed, no metadata write). The `messageId` is NOT checked against the transcript — dismissing an id that carries no questions is a harmless no-op marker write (the hold releases only when the dismissal marker matches the `pendingQuestionsMessageId` marker the asking turn wrote) |
| agent.markSeen *(v4.5)* | agentId (req), messageId (req), workspaceId (req) | { success: true, lastSeenMessageId } — advance the per-conversation **seen marker** to `messageId` (the newest transcript message the user has seen): persists `lastSeenMessageId` in the session metadata (survives daemon restarts), emits `agent:updated` with `{ agentId, lastSeenMessageId }` (§6.5), and serves the marker as `metadata.lastSeenMessageId?` on the `AgentLite` projection (`agent.list` / `agent.get`) and `agent.getSession` (omitted when nothing was marked seen). Clients use it to render a "New messages" divider after the last-seen message on conversation entry; marker updates from other clients converge via `agent:updated`. The marker is also one side of the client-side per-agent **unread** derivation against `lastMessageId` (intentd#1039 — see the `agent.list` row above): `hasUnread = lastMessageRole === "assistant" && lastMessageId != null && lastMessageId !== lastSeenMessageId`, with an **absent marker counting as unread**; because the newest user/assistant id can differ from the marker via system/tool rows, clients should mark user/assistant row ids seen where possible — equality is the only sound comparison; id ordering is NOT a valid fallback (ids are not uniformly UUIDv7 and v7 mint time is not persist order — see the `agent.list` row above). **Monotonic**: when both the named message and the current marker resolve to transcript positions and the named one is OLDER, the call is a no-op returning the CURRENT marker (`lastSeenMessageId` in the result is the unchanged current value; no write, no event) — the marker never moves backwards, including under concurrent callers (the persist is an atomic single-key compare-and-set on the marker's current value; a raced write re-reads and re-applies the gate). **Idempotent**: re-marking the already-persisted id succeeds without a write or a duplicate event. **Dangling ids are tolerated** (same laxity as `agent.dismissQuestions`): the `messageId` is NOT checked against the transcript — an unknown id (or one whose row was truncated by `agent.editAndRegenerate`) is persisted as a dangling marker (clients fall back to their no-marker behavior when the id no longer resolves), and a dangling CURRENT marker never blocks an advance (the monotonicity comparison only applies when both sides resolve). Bounded cost: a metadata-only session lookup plus at most two index seeks — no transcript hydration. Validation: an empty `messageId` or one exceeding 256 bytes is `-32602`; a nonexistent `agentId` or a workspace mismatch is a not-found error (fail closed, no metadata write). Does NOT touch the workspace-level `unread` attention flag — `workspace.markSeen` (§5.1) stays independent |
| agent.editAndRegenerate | agentId (req), messageId (req), content (req), workspaceId (req), imageBlocks?, fileBlocks?, model? | { success, queued: false, messageId, truncatedCount } — edit a past **user** message and regenerate from that point (additive `agent.*` extension). The result `messageId` is the freshly-minted server id of the NEW regenerated user message — NOT the input `messageId`, which names the edit target whose row (and everything after it) is dropped by the truncation; the two are never the same id. Orchestrated daemon-side, in order: (1) `messageId` is validated FIRST (must reference an existing user message in the transcript — unknown or non-user ids are rejected with `-32602` before any state changes; the transcript is untouched); (2) any in-flight turn is stopped (hard-cancel: the worker is aborted and the agent process killed) and the pending queue is discarded (a previously non-empty queue republishes `agent:queue:updated` as empty); (3) with `model` supplied, the session model is switched (same semantics as `agent.setModel`) before the regenerated turn; (4) the transcript is truncated to just BEFORE the edited message — the edited message and everything after it are dropped (destructive; fresh row ids / 0-based `seq` via the replaceMessages store machinery) and `agent:updated` is emitted with `{ truncatedCount, remainingCount }`; (5) the agent's ACP session is flagged for forced recreation — the next prompt SKIPS the `session/load` resume, opens a fresh `session/new`, and prepends the truncated prior history as `<supervisor>` XML (the provider must not retain the truncated turns in context; the forced-recreate flag survives intervening `agent.stop`s and is only consumed when a fresh session opens); (6) `content` is sent as a fresh user message (normal `agent.sendMessage` semantics; `imageBlocks`/`fileBlocks` ride along; the usual `agent:message` / `agent:stream:*` events follow) |
| agent.queueMessage | agentId (req), content (req), imageBlocks?, fileBlocks? | { success, queuedMessage, turnId } — **Unknown agent → fail closed.** A nonexistent `agentId` is rejected with `-32602` naming the id (`unknown agent id: <id>`) BEFORE enqueueing — no phantom queue entry that can never drain, no `agent:queue:updated` event (same guard contract as `agent.sendMessage`). QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority? } — `interruptPriority: true` (additive, v2.8) marks an entry that entered the queue via an interrupt-priority fallback (a held or slot-raced `priority: "interrupt"` send): it was inserted at the FRONT of the queue, **behind any existing interrupt-priority entries and ahead of every normal entry** (interrupts stay arrival-ordered among themselves); omitted (never `false`) on normal entries. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is the entry's turn correlation id: equal to the entry `id` for a fresh enqueue, but a terminal-failure requeue mints a NEW entry `id` while KEEPING the failed turn's original `turnId`, so a retry redrive's lifecycle events still correlate with the turn the client keyed at send time. Omitted only when the entry has no id set (every enqueue path mints one today; legacy pre-#1022 persisted rows rehydrate with `turnId = id`), never `null`. `messageMetadata` is only present when the entry was enqueued with per-message metadata (e.g. an internal wake's `event_notification` payload, or an agent-to-agent send's `agent_message` sender-attribution tag, captured while the agent was busy); user-typed `agent.queueMessage` entries never carry it. The drain-time persist writes it onto the user message row (`agent_message.metadata`) so the transcript matches a directly-delivered send |
| agent.editQueuedMessage | agentId (req), messageId (req), content (req) | { success, queuedMessage } (QueuedMessage shape as above) |
| agent.removeQueuedMessage | agentId (req), messageId (req) | service result |
| agent.getQueue | agentId (req) | { success, queue: QueuedMessage[] } — QueuedMessage = { id, content, queuedAt, position, turnId?, imageBlocks?, fileBlocks?, messageMetadata?, interruptPriority? } (shape as `agent.queueMessage`, including the monorepo#1022 `turnId?` correlation id and the v2.8 `interruptPriority?` flag). A parked dismissal notice (intentd#892, within v4.3) surfaces here with its `questions_dismissed` `messageMetadata` and `interruptPriority: true` at the queue head — promoted to position 0 ahead of even pre-existing interrupt-priority entries, unlike the normal interrupt insertion order; see `agent.dismissQuestions` |
| agent.stop | agentId (req) | { success: true } |
| agent.setModel | agentId (req), modelId (req), workspaceId (req), providerId? | service result — emits `agent:updated`. A compound `modelId` (`provider:model`) whose provider prefix is not a registered ACP provider is rejected with `-32602` (`agent.setModel: unknown provider: <id> (known providers: ...)`) before any mutation — `session.model` / `session.provider` are left untouched and no default-provider fallback occurs. A **bare** `modelId` (with no `providerId`) is validated against the session's effective provider (`session.provider` → settings-derived default, with legacy default-provider aliases normalized) using the same ownership check as `agent.create` — cached dynamic catalogs only ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)), with the same asymmetric-evidence rule: a bare id provably owned by other provider(s) is rejected with `-32602` (`agent.setModel: model <id> does not belong to provider <p> (providers with this model: ...); pass providerId to select the intended provider` — the trailing hint is new with the `providerId` param, [intent-hq/intentd#986](https://github.com/intent-hq/intentd/pull/986)) before any mutation; bare ids with no ownership evidence and the `"default"` sentinel pass unchanged. **Explicit provider (`providerId`, additive — [intent-hq/intentd#986](https://github.com/intent-hq/intentd/pull/986), [intent-hq/monorepo#1657](https://github.com/intent-hq/monorepo/issues/1657)).** `providerId` optionally names the intended provider explicitly, so a client that knows which provider group the user picked (e.g. the FE model picker, whose default-provider options carry bare ids) can state it on the wire instead of relying on compound-id encoding or session-provider inference. Optional string: JSON `null`, an empty string, and a whitespace-only value all read as absent (the value is trimmed), keeping older clients that send a blank field on the historical path; a present non-string value is rejected with `-32602` (`agent.setModel: providerId must be a string`) at the router boundary. When present it must name a registered ACP provider — an unknown id is rejected with `-32602` (`agent.setModel: unknown provider: <id> (known providers: ...)`) before any mutation. A compound `modelId`'s provider prefix must agree with it (after prefix normalization) — a conflict is rejected with `-32602` (`agent.setModel: modelId <id> names provider <p> but providerId is <q>`) before any mutation, rather than guessing which provider was meant. A **bare** `modelId` is then validated against the GIVEN provider instead of the session's effective one (same cached-catalog asymmetric-evidence ownership check as above), and on success `session.provider` is reconciled to `providerId` — the same narrow `set_agent_session_model` write path as the compound-prefix reconcile — so the next spawn runs the intended binary. Absent `providerId` ⇒ prior behavior unchanged byte-for-byte. **Model-change transcript notice (new in intentd).** `agent.setModel` itself never writes to the transcript — the notice is deferred to the next turn start (`ensure_started`), when the turn's spawn-resolved model/provider is compared against the last **committed** turn's identity (persisted `agent_session.last_turn_model` / `last_turn_provider`, written on `ensure_started`'s success paths once the child + ACP session are up). A difference (and at least one committed prior turn) persists ONE informational row: `role: "system"`, one text block (`"Model changed from <from> to <to>."`), row `metadata = { "type": "model_changed", "from": string \| null, "to": string \| null, "fromProvider": string, "toProvider": string }` (`from`/`to` are spawn-resolved model ids; `null` = provider default), and emits the standard `agent:message` event (`role: "system"`) so clients update live. Picker toggles reverted before any message produce NO notice (nothing was committed in between); the agent's very first turn produces NO notice (no committed prior identity, the baseline just commits); a failed spawn/switch commits nothing (the notice only lands once the turn provably starts under the new identity). The row is transcript-only: system-role rows are excluded from supervisor-XML history replay (which renders only user/assistant/error) and never reach any outbound provider prompt. Covers same-provider respawn, cross-provider recreate, and idle-agent (no live handle) respawn paths alike — detection is store-based. Best-effort: a notice persist failure is logged and the turn proceeds. |
| agent.getModels | — (no workspaceId) | { models: [{ id, name, provider, description? }] } (from auggie CLI; an unavailable CLI yields an **empty** list — no static fallback catalog, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)) |
| agent.rename | agentId (req), name (req, non-empty), skipIfExplicitlySet? | { success: true, name } — an applied rename emits `agent:renamed`. With `skipIfExplicitlySet: true`, a session whose name was already explicitly set is left untouched and the result is { success: true, name: <existing>, skipped: true } (no event) |
| agent.delete | agentId (req), workspaceId?, undoDelayMs? *(v6.7)* | { success: true } — **Delete grace window (v6.7, [intent-hq/intentd#1096](https://github.com/intent-hq/intentd/pull/1096)):** `undoDelayMs > 0` (non-negative integer; a non-integer value is `-32602`; values above the 60 000 ms cap are silently clamped, never rejected — `deleteAt` reflects the clamped value) schedules an **in-memory** pending deletion instead of committing — returns `{ success: true, scheduled: true, deleteAt }` (ISO commit deadline), emits `agent:delete-scheduled { agentId, workspaceId, deleteAt }` (§6.5), and serves `pendingDeleteAt` on the `AgentLite` / `AgentSession` projections until the deadline commits the real delete or `agent.cancelDelete` cancels it. Scheduling does NOT stop the agent — only the deadline commit does. Absent, `null`, or `0` keeps the immediate-delete behavior byte-identical. Pending deletions are never persisted (a daemon restart drops them; the session survives); re-scheduling is idempotent under the registry lock (returns the existing deadline, no second timer); a workspace delete — immediate or committed-from-pending — supersedes pending agent deletes inside it |
| agent.cancelDelete *(v6.7)* | agentId (req), workspaceId? | { cancelled: boolean } — cancels a pending (grace-window) deletion scheduled by `agent.delete` with `undoDelayMs`. A caller-declared `workspaceId` is validated against the session row BEFORE touching the registry (mirroring `agent.delete`), so a stale or cross-workspace-scoped cancel returns NotFound instead of cancelling another workspace's pending deletion. `true` clears the pending deletion, emits `agent:delete-cancelled { agentId, workspaceId }` (§6.5), and drops `pendingDeleteAt` from the projections; `false` is the race-safe non-error when no deletion is pending (never scheduled, already cancelled, or already committed) |
| agent.wakeOrCreate | taskNoteId (req), contextMessage (req), model?, reasoningEffort?, callerAgentId?, delegationDepth?, messageMetadata?, create? { name?, specialist?, provider?, agentType?, model?, reasoningEffort?, contextReferences?, metadata?, skipAutoCommit? } | { ok, agentId, agentName, created, action: "message_queued_to_active_agent" \| "woke_existing" \| "created_new", taskTitle, result, cleanedUpAgentIds?, subscriptionId?, message? } — depth-guard rejects `delegationDepth >= MAX_DELEGATION_DEPTH` with `-32602` (`MAX_DELEGATION_DEPTH` cap = 2; caller depth is otherwise inherited from `callerAgentId`'s session metadata + 1). Pre-widening 3-required-params callers stay wire-compatible; `create.*` is only consulted on the create branch and specialist/model from the newest assigned session takes precedence over `create.specialist`/`create.model` when a resumable candidate is found. **Reasoning effort (additive, create branch only):** the top-level `reasoningEffort` wins over `create.reasoningEffort`, then the chosen specialist model option's effort, then the specialist's `reasoningEffort` frontmatter scalar, then the settings `model.defaultReasoningEffort` (§5.12) — which applies only when the child's model itself resolved from the settings default chain, never alongside a caller-supplied model or a specialist model pin — then unset. A level from the param / model-option / frontmatter rungs is validated against the cached catalog's `effortLevels` for the resolved model exactly as on `agent.delegate` (§5.11 "Delegation reasoning-effort resolution"), with the `-32602` raised before the child is created; a settings-derived level is instead dropped with a daemon warn log when unsupported, never rejected. The wake branch never changes an existing session's effort. Skipped poisoned sessions (repeated restore failures, monorepo#840) are quarantined out of candidate selection; on both wake and create branches each one's parked queue is migrated to the woken/created agent via an atomic durable hand-off (one transaction moves the persisted rows, so a crash leaves the messages on exactly one queue; delivery stays at-least-once) and the session is then hard-deleted with one `agent:deleted` emitted — `cleanedUpAgentIds` still lists them (monorepo#847). A failed migration is non-fatal to the wake but that id is withheld from `cleanedUpAgentIds` and its task assignment survives (messages stay durable on the poisoned queue), so the next `agent.wakeOrCreate` retries the migration + GC. **`callerAgentId`-present responses (SUB-1 auto-subscription, monorepo#926/#933):** when `callerAgentId` is provided, ALL THREE actions additionally carry `subscriptionId` — the id of the deliver-once completion watch registered for the caller against the target agent — and `message`, a human-readable summary of the action taken ending with "You will be notified when the agent responds.". The queued branch (`message_queued_to_active_agent`) needs no special watch mode: queue-aware completion (§Completion-watch persistence) means the target's `agent:idle` for its in-flight turn is an interim idle (the queued message is still pending) and neither delivers nor retires the watch — the wake fires at the real completion after the queued turn, with no leak-guard timer. Repeated calls for the same caller/target pair reuse (or adopt, per the pair-uniqueness invariant in §Completion-watch persistence) the existing watch under the same `subscriptionId` instead of stacking duplicates; the create branch always registers a fresh watch (the child id was freshly minted this call). Both fields are absent when `callerAgentId` is omitted, and likewise when the named caller's session is Deleted — no completion watch is registered for a deleted caller (intentd#667). |
| agent.summary | agentId (req) | quick summary of what the agent did |
| agent.reportToParent | report (req) | service result — -32603 if caller is not a delegated agent. Persists `metadata.completionReport` / `completionReportTimestamp` on the child session (re-served by agent.get/agent.list) and emits `agent:updated` (P3-1.2b). Delivery: a non-grouped delegated child delivers the single immediate parent wake at reportToParent time (directly to `session.parent_agent_id`, no watch required); the parent's ungrouped watches on the child are marked `report_delivered` (synced through to the persisted `completion_watch` row) so the child's later `agent:idle` is suppressed for that parent — the suppressed watch is still retired at the child's completion. A `report_delivered` watch is also excluded from the parent's waiting projection — the `AgentLite` `isWaitingForOtherAgents` / `waitingForAgentIds` flags, the emit-time `agent:idle` stamp, and the `agent:subscriptions-changed` snapshot (§6.5) — the same exclusion the settlement predicate applies ([monorepo#1649](https://github.com/intent-hq/monorepo/issues/1649), [intent-hq/intentd#1017](https://github.com/intent-hq/intentd/pull/1017)), so a parent whose only remaining watches are `report_delivered` no longer displays as waiting on the already-reported child. The marking is scoped to the parent's watches ONLY, so third-party watchers — including explicit `ws.agent.watch` watchers ([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229), §Completion-watch persistence) — still receive the idle-driven completion wake. `agent:failed` / `agent:deleted` after a report still deliver wakes. Children that never report keep the idle-driven wake with `lastResponseSummary`. Grouped children (`after_all`) do not get an immediate wake — the persisted report reaches the parent only inside the group's single aggregated wake (as that child's `Report:` line, which wins over `lastResponseSummary`); a late report after group delivery wakes immediately. All internal parent wakes (completion watches, the aggregated group wake, immediate reports) run a real parent turn through the runtime send-message path — normal `agent:stream:*` / `agent:idle` lifecycle, queued if the parent is mid-turn. **Stale queued-message redrives (new in intentd, #576):** a message queued to a delegated child while it was mid-turn, but drained only AFTER the child's completion report was persisted and delivered, is **stale** (the entry's `queuedAt` — the same wire field served by `agent.getQueue` — predates the session's `completionReportTimestamp`). A stale redrive's turn (1) **skips the turn-begin report clear** — the delivered report stays queryable via `agent.get`/`agent.list` and no `agent:updated` with `completionReportCleared: true` fires for that turn (a genuine re-report still overwrites it through `agent.reportToParent`) — and (2) the redriven message content gains a deterministic `[SYSTEM NOTE]` annotation (appended before the transcript persist, so the persisted user row and the provider prompt match) telling the child its report was already delivered and to re-report only if the message materially changes the outcome. The annotation is idempotent across requeues; for a requeued entry whose user row already reached the transcript (persisted requeue) the annotation is skipped — persisted rows are never mutated — but the report clear is **still suppressed**. Staleness fails open: session-lookup or timestamp-parse failures treat the message as fresh, and fresh messages / non-delegated agents keep the pre-existing behavior (report cleared at next turn begin) |
| agent.getSubscriptions | agentId (req), workspaceId (req) | { subscriptions, delegationGroups, agentStatuses, eventSubscriptions } (filter fields flattened as top-level actorIds/eventTypes per subscription; no legacy filter object). `eventSubscriptions` (additive, monorepo#947) lists the caller's live `event.subscribe`/`agent.subscribe` registrations — `{ id, workspaceId, subscriberAgentId, eventTypes, excludeSelf, batchWindow, createdAt }` per entry — so an agent can recover a lost `subscriptionId` |
| agent.cancelSubscriptions | agentId (req), workspaceId (req), subscriptionId?, groupId? | { success: true } — unscoped (neither optional param) cancels EVERYTHING the agent registered (all completion watches, all delegation groups it parents — persisted `delegation_group` rows are swept best-effort so cancelled groups don't rehydrate on restart — and all event subscriptions), idempotent, exactly as before the params existed. Scoped *(new in intentd)*: `subscriptionId` cancels exactly that completion watch; `groupId` cancels that delegation group plus its grouped watches (removed together in one registry critical section); both may be combined. Cancelling a GROUPED watch by `subscriptionId` also drops that child from its group's expected set — group settlement is driven by the grouped watches, so the group must not stall on a cancelled child — then attempts to fire the group, since the shrunk group may now be sealed and complete; a group whose expected set becomes empty is removed outright. Each scoped removal deletes the matching persisted `completion_watch` / `delegation_group` row(s) — the group-row delete is durable-before-observable (awaited before any in-memory removal; a failed delete errors the call with the registry untouched) — and publishes the standard `agent:subscriptions-changed` snapshot (§6.5) in the parent's home workspace; event subscriptions are untouched (use `agent.unsubscribe`). An id that does not name a watch/group owned by `agentId` is rejected with `-32602` (`unknown subscription id: <id>` / `unknown delegation group id: <id>`) BEFORE anything is removed, so a combined call is all-or-nothing; a present-but-non-string id is likewise rejected with `-32602` (`subscriptionId must be a string` / `groupId must be a string`) rather than being coerced into an unscoped cancel |
| agent.subscribe (deprecated) | eventTypes (req, array), agentId?, excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — not the WS streaming surface (use events.subscribe). Registers a real internal subscription: when `agentId` names a subscriber agent, matching workspace events (category wildcards or exact types) are coalesced over `batchWindow` ms (default 500) and delivered as one `[WORKSPACE EVENTS]` wake message per batch, with `event_notification` message metadata; `excludeSelf` (default true) drops the subscriber's own events. **Agent events are off-limits to agent subscribers ([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229)):** when the call carries a subscriber agent, every explicit `agent:`-prefixed entry — exact types, the `agent:*` wildcard itself, and the observability events — plus `chat:stream:delta` is rejected with `-32602` at subscribe time, atomically (a mixed list like `["note:*", "agent:*"]` registers NOTHING; the error text redirects to `ws.agent.watch(agentId)` and lists the non-agent categories that remain available). A bare `*` is NOT rejected: it silently narrows to the non-agent category wildcards at resolution time (front-door `*` expansion is unchanged and still includes `agent:*`). A **match-time guard** backs the subscribe-time one: agent-owned delivery filters set `exclude_agent_events`, so legacy `agent:*` rows persisted before the guard existed never deliver agent events after a daemon restart. Subscriber-less (FE front-door) subscriptions are exempt from all of this and keep the full stream. Agent-owned subscriptions persist across daemon restarts (rows whose subscriber is gone — or whose workspace no longer exists, `__chief__` exempt — are pruned at startup, monorepo#947). Live subscriptions are listed via `agent.getSubscriptions` (`eventSubscriptions`) and reported by `agent.diagnostics`. `workspace.delete` drops the workspace's event subscriptions (delivery tasks aborted, rows deleted). Without `agentId` (FE front door) the subscription is match-only in memory — no wake target. Over the MCP seam (`ws.agent.subscribe` / `ws.event.subscribe`) the subscriber is the calling agent automatically (so the restriction applies; the MCP binding's `*` expansion moved into the daemon for the per-subscriber resolution). |
| agent.unsubscribe (deprecated) | subscriptionId (req) | service result `{ success: true, subscriptionId }` — stops delivery; unknown id errors |

**Creation-time default-model resolution (daemon-owned, [intent-hq/intentd#852](https://github.com/intent-hq/intentd/pull/852)).**
Every creation path — `agent.create`, `agent.delegate`, `agent.wakeOrCreate`, and
`workspace.create`'s `initialAgent` (§5.1) — resolves the session's model through ONE
daemon-side resolver when the client supplies no explicit `model`. Clients are pass-through:
they send a model only when the user explicitly picked one, and never pre-resolve defaults.
Precedence, first match wins:

1. **Explicit client `model`** — validated per the `agent.create` rules above (unknown
   compound provider prefix / provably-mismatched bare id → `-32602` before any side effect).
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
4. **None** — `session.model` stays unset; the provider CLI's own default applies.

The former specialist frontmatter `modelTier` step is **retired** (tolerated-and-ignored,
§5.11): a specialist's model is either an explicit frontmatter `model` pin or inherited via
the settings chain. The static tier tables themselves are **removed** ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922))
— `providers.catalog` (§5.38) no longer serves `modelTiers`, and no tier concept
participates anywhere in resolution.

Specialist `modelOptions` (§5.11) likewise adds **no resolver step**: the list is advisory
— surfaced to delegating agents in the `workspace_api` tool description's
`ws.agent.delegate` docs — and a chosen option is sent as the explicit client `model`, i.e.
step 1 above, which remains the first-match step exactly as before. A caller that omits
`model` resolves through steps 2–4 unchanged, regardless of any `modelOptions`. The
per-option `reasoningEffort` (§5.11) is likewise not a resolver step for `model` — it only
feeds the separate delegation reasoning-effort resolution.

The resolved provider is the explicit `provider` param, else the compound-`model` prefix,
else the **settings-derived default** — the provider prefix of `model.default` when compound
and registry-valid, else `providers.active`, each validated against the provider registry so
a stale or mistyped id falls through — bottoming out at the first registered provider (a
neutral positional last resort; no provider carries a hardcoded default designation,
[intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)). Legacy
default-provider aliases are normalized. The resolved model is
persisted to `session.model` at creation time, **pinning it for the session's lifetime**:
later settings/specialist changes only affect agents created afterwards, and an existing
agent's model changes only via explicit `agent.setModel`. Bundled specialists ship with no
frontmatter `model`, so they inherit the user's configured default (step 3) or the provider
CLI default. `specialist.get`/`specialist.list` preview this resolution via the additive
`resolvedModel`/`resolvedProvider` fields (§5.11), computed by the same resolver.

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
   or a fall-through to the provider CLI default all leave the effort unset here.
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
compound model id wins over the session field; the `CODEX_REASONING_EFFORT` env seam remains
the last-resort fallback). **Legacy compound ids.** Pre-5.2 codex sessions whose
`session.model` embedded the effort as a `{base}/{effort}` suffix (the retired effort-variant
catalog rows, §5.30) are normalized by a one-time store migration into the base model plus
`reasoningEffort`; the split is guarded on a known codex effort suffix AND codex evidence
(the provider column, a `codex:` compound prefix, or a known effort-capable base model), so
slash-bearing non-codex ids (e.g. HuggingFace-style unsloth ids) are untouched.

**Session-discovered effort levels — `effortLevels` *(additive; no version bump)*.**
`effortLevels?: string[]` is an optional, daemon-owned field served on both the
`AgentSession` (`agent.getSession`) and `AgentLite` (`agent.list` / `agent.get` /
`agent.update` results) projections — presence-detected, **omitted when
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
  created under, currently `"1.0"`. **Immutable for the session's life**: a daemon
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
    "prMonitor": true, "taskGraph": false
  }
  ```

  Immutable like the version — later settings changes affect only new sessions — and
  **the snapshot is what the session actually runs with**: session (re)spawns resolve
  the agent's MCP tool surface and prompt assembly from the persisted snapshot rather
  than the live settings, so a settings flip never alters an existing session's tools
  and the wire report never disagrees with the runtime surface. This covers the
  per-turn snapshot-line injection too: `agentFeatures.stateSnapshot` gates it from
  the captured snapshot like every other toggle
  ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)). One documented
  exception stays live: `agentFeatures.backgroundHooks` is
  re-checked live in the services layer on every `hook.schedule` (defense in depth
  behind the MCP dispatch deny) — a flip to `false` denies new schedules from ALL
  sessions regardless of their snapshot, while already-active hooks are unaffected and
  run to their terminal state/TTL. There, the captured value records the
  creation-time setting without freezing the behavior. The pre-existing per-session
  `taskGraph` pin folds into the snapshot: readers prefer `harnessFeatures.taskGraph`,
  falling back to the legacy per-session column for older rows (behavior identical).
  The wire always carries a value: a legacy pre-snapshot row (NULL in the store)
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
(agents only). One shared services op behind both bindings does five things:

1. **Session persistence** — the pending request is persisted on the caller's session as
   `attentionRequestKind` (`"discussion" | "blocker"`), `attentionRequestReason`, and
   `attentionRequestTimestamp` (= the result `savedAt`), served on BOTH the `AgentSession`
   projection (top-level fields, `agent.getSession`) and the `AgentLite` `metadata` block
   (`agent.list`/`agent.get`), omitted when absent. The raise emits `agent:updated` with
   `data { agentId, attentionRequestKind, attentionRequestTimestamp }`. The request is
   **pending state, not status**: `AgentStatus` and `stopReason` are untouched (the turn ends
   normally; no retry affordance), and the request retires when the agent next receives a
   **user-origin** delivery — `agent.sendMessage` (the FE/router front door),
   `agent.sendQueuedMessageNow`, `agent.editAndRegenerate`, or a drained user-origin queue
   entry (the same origin taxonomy as the §5.5 question hold). For **child**
   (`parent_agent_id` set) and **background** (`is_background`) sessions, **automatic**
   deliveries (A2A sends, parent/subscription wakes, `agent.sendToTask`,
   `agent.wakeOrCreate` context messages, drained automatic queue entries) **ALSO** retire
   it — the parent/coordinator is those agents' attention surface, so its follow-up is the
   acknowledgement. For top-level foreground agents, automatic deliveries do **NOT** retire
   it (their turns run with the request left pending) — an automatic message must never
   dismiss a request the user has not seen. The turn-begin clear emits `agent:updated` with
   `data { agentId, attentionRequestCleared: true }` and removes all three session fields
   (skipped silently when none is pending); no new wire surface is introduced by the
   child/background automatic retire. Both the raise and the retire also
   recompute-and-compare the workspace's derived `displayStatus` — a top-level foreground
   agent's pending request promotes it to `blocked` (kind `blocker`) or `needs_attention`
   (kind `discussion`) (§5.1 steps 1–2), pushed as
   `workspace:displayStatus-changed` on an actual transition (§6.5).
2. **Transcript notice** — a system-role message is appended with a single text block carrying
   the reason and `meta.kind = "discussion-request"` / `"blocker-report"` (the
   `InterruptionNotice` shape, §5.35), emitting the standard `agent:message`
   (`role: "system"`), so the conversation renders a distinct card that survives rehydration.
   Best-effort: an append failure is logged and swallowed (the session fields above are the
   durable contract).
3. **`agent:attention-requested` event** — the self-sufficient (§6.7) toast-driving event,
   `data { workspaceId, agentId, agentName, kind, reason, parentAgentId? }` (§6.5).
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
6. **Watcher fan-out** ([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229)) —
   every `wake_on_attention` completion watch on the caller (the explicit
   `ws.agent.watch` watches, §Completion-watch persistence) receives the same kind-flavored
   `[WORKSPACE EVENTS]` wake (`Watched agent <name> (<id>) requests a discussion / reports a
   blocker: <reason>`) with `event_notification` metadata embedding the step-3 payload — the
   caller's parent is excluded (step 5 already woke it directly, so a parent that ALSO
   explicitly watches its child never receives a duplicate attention wake). Watches are left
   in place: attention is not a completion.

**Agent-facing queue visibility & sender hygiene *(new in intentd, [intentd#816](https://github.com/intent-hq/intentd/pull/816))*.**
Agents get visibility into pending message queues plus a guard against queue-flooding on A2A
sends. **MCP-only surface changes** (§6.8 principle) — no new wire methods; the existing
`agent.getQueue` / `agent.removeQueuedMessage` wire RPCs (§5.5 table above) are unchanged.

- **`ws.agent.getQueue(agentId)` MCP binding** → `{ ok, agentId, queueLength, queue }` — any
  workspace agent's full pending queue in **actual drain order** (position 0 = next delivery:
  interrupt-priority entries first in arrival order, then normal FIFO; entries under edit are
  flagged `editing: true` and sorted last, since the drain skips them). Each entry:
  `{ id, content, queuedAt, position, turnId?, interruptPriority?, editing?, fromAgentId?,
  fromAgentName? }` — sender attribution is **lifted to top level** from the entry's
  `agent_message` auto-tag (`messageMetadata.fromAgentId`/`fromAgentName`, §5.5
  `agent.sendMessage`) and is absent for user-sent entries. Note the MCP presentation differs
  cosmetically from the services-layer snapshot the guard refusal and `agent.diagnostics`
  embed: both truncate `content` to 200 chars (with a `…` ellipsis) and drop the bulky
  `imageBlocks`/`fileBlocks` payloads, but the MCP view lifts attribution top-level while
  the internal snapshot leaves it inside `messageMetadata` — same entries, same order,
  different attribution placement.
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
  the drain skips them). The refusal echoes the target's full queue plus remediation:
  keep the pending message, or retract it via `ws.agent.removeQueuedMessage` and resend —
  noting a retract-and-resend lands at the END of the queue. Different senders may still
  each have one pending entry; the guard is per sender/target pair, and is advisory
  check-then-send hygiene (not an atomically enforced invariant — concurrent sends from
  one caller can race past it).
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
  FIFO-restore branch — is treated like an immediate delivery (no note, no `queueInfo`
  stamp), so instant queue hops never render a "waited 0s" chip. Alongside the content
  note, the drained entry's `messageMetadata` is stamped with structured queue info —
  `queueInfo: { "queuedAt": "<ISO enqueue timestamp>", "waitedMs": <non-negative millis> }`
  — persisted on the user transcript row and round-tripping on chat reads
  (`agent.getConversation` / `chat.subscribe`) like the A2A sender-attribution metadata, so
  clients can render the wait without parsing the note text. Same guards as the note: an
  existing `queueInfo` is never overwritten (first-delivery numbers stay across requeues),
  `persisted: true` requeues are never stamped, and an unparseable `queuedAt` skips the
  stamp; negative waits (clock skew) sit below the threshold and skip the annotation
  entirely.
- **`agent.diagnostics` queues fill** — the per-agent `queues` snapshots are now real
  (previously hardcoded `[]`), using the same drain-order sorting.

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
  `agent.subscribe`), `runningSubAgents` (delegated children not yet settled — counted over
  the caller's `parent_agent_id` children **unscoped by workspace**, so a chief parent's
  cross-workspace delegates count too), `numQuestionsAsked` (structured questions still
  pending presentation/answer, §5.5 question hold), and `pendingAttention`
  (`"blocker"` / `"discussion"` when the caller has an unresolved attention request, §5.5
  attention-request flow). Every field except `time` is **omitted when zero/absent** (never
  `0`, never `null`). A workspace mismatch on the resolved session fails closed as
  `NotFound` (defense-in-depth against bare-id probes, like `getSessionStats`). The cheap
  counterpart to `ws.agent.diagnostics`, which is unchanged and remains the deep-dive tool.
- **Per-turn injection** — when not skipped, `build_turn_prompt` prefixes the outbound prompt
  with the single line `current ws.agent.snapshot() => {json}` (the same JSON object,
  serialized on one line), followed by a blank line. It is the outermost **recurring** per-turn
  decoration — ahead of the context block, naming, and the specialist role reminder, and inside
  only the fire-once first-turn `<system>` prepend — is rebuilt every turn for **all** agents
  (specialist and non-specialist, unlike the role reminder), and is **never persisted**: the
  transcript's user row keeps the undecorated content.
- **Skipped when trivial** — when every field other than `time` would be omitted (all counts
  zero, no pending attention) the whole line is dropped, so `time` alone never forces an
  injection and an idle agent's prompt stays byte-identical to pre-feature output. Building
  the snapshot **fails open**: a store error yields no line rather than failing the turn.
- **Toggle** — the injection (and only the injection) is gated by
  `agentFeatures.stateSnapshot` (§5.12), resolved from the session's **captured harness
  feature snapshot** like every other toggle
  ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)): flipping the setting
  applies to **new sessions only**, and a legacy pre-snapshot row (NULL in the store)
  follows the live setting until its first-activation freeze (see "Harness versioning"
  above). The
  `ws.agent.snapshot()` tool itself is **never** gated and stays callable either way.

#### Queued-message flush — combined turn on idle *(new in intentd, [intentd#876](https://github.com/intent-hq/intentd/pull/876); mode enum added in [intentd#895](https://github.com/intent-hq/intentd/pull/895))*

When an agent goes idle with **more than one** ready-to-send queued entry, the queue drain may
deliver several of them as ONE combined provider turn instead of one turn per message. The mode
is controlled by the `agents.flushQueuedMessages` setting (§5.12 — enum `"all" | "systemOnly" |
"off"`, default `"all"`, mutable via `settings.update`; read at drain time). `settings.update`
only accepts the three string values (validated as an enum — a boolean `value` is rejected with
`-32602`); the legacy boolean shape (`true` → `"all"`, `false` → `"off"`) is accepted **only**
when parsing an on-disk `config.toml` written by an older daemon, so an existing boolean survives
upgrade but a client cannot write one back over the wire:

- **`"all"`** — every ready entry batches into one combined turn (≥2 ready entries required; the
  original boolean-`true` behavior).
- **`"systemOnly"`** — when ≥2 ready **system-origin** entries exist anywhere in the queue, ALL
  of them batch into one combined turn, preserving their relative order but skipping over any
  interleaved user-origin entries — a system batch may therefore deliver ahead of an
  earlier-queued user message. User-origin entries always deliver individually, FIFO among
  themselves, and are never folded into a system batch. A single ready system entry — even
  with other ready user entries also present — has nothing to batch with, so it delivers via
  the same single-entry drain path as `"off"` (one turn for just that entry); only ≥2 ready
  system entries trigger a combined batch.
- **`"off"`** — the legacy one-message-per-turn drain: every ready entry starts its own turn
  (the original boolean-`false` behavior).

With only a single ready entry — regardless of mode — the legacy one-message-per-turn drain path
runs exactly as before. Interrupt-priority preemption, `agent.sendQueuedMessageNow`,
question-hold derivation, and queue persistence/rehydration are all untouched by any mode.

- **Wire-only combined prompt.** The model receives ONE message beginning with the header
  `N queued messages while you were working`, followed by each entry under a `Message #k:`
  label in delivery order. Entry contents already carry their per-entry annotations — the
  dequeue-wait note (original `queuedAt` + wait duration; only for waits at/above the
  5-second threshold, monorepo#2353) and, where applicable, the #576 stale-redrive note —
  applied per entry in the same order as the single-entry drain arms.
  The combined prompt exists **only on the wire**: it is never persisted as a transcript row.
- **Per-entry transcript rows.** Each flushed entry persists as its own user message row (own
  id, own `messageMetadata` — including the `queueInfo` stamp when the entry's wait met the
  5-second threshold above), so the transcript and UI show
  the same N messages as individual stacked user rows — identical to what a one-at-a-time
  drain would have persisted. Entries already persisted by a terminal-failure requeue
  (`persisted: true`) are not re-appended.
- **Events.** A flush emits ONE `agent:queue:updated` (the fully-shrunk queue snapshot) and
  ONE `agent:queue:processing` for the HEAD entry — the combined turn's drain-start signal —
  then each row persist emits its normal `agent:message` echo (§6.5), so clients render N
  stacked user rows.
- **Turn correlation (monorepo#1022).** The combined turn runs under the HEAD entry's
  `turnId`, and ALL flushed rows persist — and their `agent:message` echoes are stamped —
  under that same combined `turnId` (not each entry's own), so all N echoes correlate with
  the single `agent:queue:processing` / `agent:stream:*` lifecycle. The queue entries
  themselves keep their own `turnId`s (entry ids / `messageMetadata` / `queueInfo` are
  untouched). The merged turn options carry attachments and prepend payloads from all entries
  in message order, the head entry's `queuedAt` / `interruptPriority` / `messageMetadata`,
  and a user origin when ANY flushed entry is user-origin (a user message is being
  delivered); the turn-begin report clear is suppressed only when EVERY entry is a #576
  stale redrive.
- **Editing-entry exclusion.** Entries flagged `editing: true` are never flushed and remain
  queued (same rule as the single-entry drain).
- **Question hold.** Under an active question hold (below), the flush fires only when a
  ready **user-origin** entry exists — an automatic delivery still never STARTS a turn over
  the pending Q&A. In `"all"` mode the flush then carries EVERY ready entry — parked
  automatic entries included — FIFO in the user-led combined turn, so an older parked wake is
  never bypassed by a newer user message ([monorepo#1791](https://github.com/intent-hq/monorepo/issues/1791),
  [intentd#1059](https://github.com/intent-hq/intentd/pull/1059); before #1059 only
  user-origin entries were eligible to flush). In `"systemOnly"` mode no batching occurs
  under a hold at all — the hold's release is a user-origin entry, which `systemOnly` by
  definition excludes — so eligible user-origin entries drain solo, FIFO, exactly like the
  single-entry path, and automatic entries stay parked.
- **Never-lost requeue.** If an entry's row append exhausts the bounded persist retry
  (#547), the agent parks in `Error` and the drained entries are requeued in their original
  order — the failed entry at the queue front of its slice with `persisted: false`, entries
  whose rows already reached the transcript carrying `persisted: true` so the retry drain
  never double-appends (STAB-51) — and the fully-restored queue is republished as
  `agent:queue:updated`. Queued messages are never dropped.

#### Question hold — automatic deliveries parked behind a pending Q&A *(v2.8, [intentd#751](https://github.com/intent-hq/intentd/pull/751))*

When an agent ends a turn by asking structured questions (§7 — the final assistant message
carries trailing `application/vnd.intent.question+json` resource blocks), an automatic delivery
would start an unrelated turn on top of the pending Q&A, burying the composer wizard behind the
agent's subsequent output. The **question hold** closes this gap: while the hold is active,
automatic deliveries park in the agent's pending queue instead of starting a turn. Since
[intentd#965](https://github.com/intent-hq/intentd/pull/965) (within v6.0) the pendingness the
hold tracks is **persisted**, not re-derived from the transcript tail — see the derivation below.
Since [intentd#1063](https://github.com/intent-hq/intentd/pull/1063) (within v6.4)
`ws.app.question.ask` is **top-level-only** (§7), so a **new** hold can only arise on an agent
whose MCP bridge was created top-level — per the §7 spawn-time snapshot semantics, an agent
flipped to background via `agent.update` after bridge creation keeps its question-enabled bridge
(and can still arm a hold) until it respawns; a marker persisted by a pre-gate sub-agent turn
keeps holding until released as below.

**Derivation (persisted marker; within v6.0, [intentd#965](https://github.com/intent-hq/intentd/pull/965)).**
The hold is `true` iff the session's persisted `pendingQuestionsMessageId` marker is set AND
differs from the `dismissedQuestionsMessageId` marker. The marker is written at turn end whenever
the just-persisted assistant tail carries `application/vnd.intent.question+json` resource blocks
(single slot — a newer question-bearing turn overwrites an older marker, which is the "newest set
supersedes" rule), and written as the **empty string** to clear (authoritative "nothing pending",
and still marker-aware). So pendingness **survives** later plain user messages, the agent's
subsequent turns, and daemon restarts — the check is a bounded single-row metadata read, not a
transcript walk. There is still no hold flag or lifecycle status: an agent under hold remains
`idle`/`completed` as usual. The derivation fails open (`false`) on store read errors so a
transient failure can never wedge deliveries. Unlike `dismissedQuestionsMessageId` /
`lastSeenMessageId` the marker is NOT lifted into the structured `AgentLite` `metadata`
projection (`agent.list` / `agent.get`). It does ride the raw free-form `metadata` object
`agent.getSession` serves — like every session-metadata key, whether set or cleared to the
empty string — but it is **daemon-internal**: clients must NOT derive pendingness from it.
They derive it from the transcript plus the answer tag below (and read the daemon's verdict
through `displayStatus`, §5.1 step 2).

*Pre-upgrade fallback.* A session whose marker key is **absent entirely** (the daemon never wrote
it) falls back once to the legacy transcript tail walk — walking back past any trailing `system`
rows, hold when the first non-system row is an un-dismissed question-bearing assistant message —
and the derived hold is immediately **materialized** as a marker, so a hold that was live across
the upgrade is not lost on the next plain user row. A marker written as the empty string does NOT
fall back.

*Marker re-derivation on transcript swaps.* `agent.editAndRegenerate` truncation and
`agent.replaceMessages` re-mint row ids, so any surviving marker is dangling by construction: both
re-derive it over the post-swap transcript (newest question-bearing assistant row not answered
below it) and clear it when there is none, then recompute displayStatus and kick the drain.

**What is held (message origin).** Only **automatic** deliveries are gated: A2A sends (the MCP
`ws.agent.send` binding / internal send paths), parent wakes (completion watches, aggregated group
wakes, `agent.reportToParent` immediate wakes), event-subscription batch deliveries,
`agent.sendToTask`, and `agent.wakeOrCreate` context messages. Automatic **interrupt-priority**
sends are held too — no exceptions — parking front-of-queue with `interruptPriority: true` (behind
existing interrupt entries, ahead of normal ones; the preemption is skipped entirely — there is
nothing to preempt, since a hold implies the question-asking turn already ended). A held park
returns `{ success: true, queued: true, heldForQuestions: true, queuedMessage, turnId? }` to the
sender (the additive `heldForQuestions: true` field distinguishes it from an ordinary busy-queue
park; the wake-delivery and store-only arms may omit `turnId`) and republishes `agent:queue:updated`. The
hold is checked BEFORE the busy check, so even an idle agent parks automatic deliveries. The same
gate applies inside the queue-drain loop: while the hold is active the drain skips (parked entries
stay parked across turns and daemon restarts — the queue is the same durable `agent_queue` table),
EXCEPT that a parked **user-origin** entry (a user send that lost a busy race before the hold
began) still drains — it may itself carry the answer that releases the hold.

**What bypasses (user origin).** User-origin actions are never held: `agent.sendMessage` (the
FE/router front door), `agent.sendQueuedMessageNow` (explicit user action on a parked entry), and
`agent.editAndRegenerate`. Bypassing is **not** releasing (within v6.0): a plain user row leaves
the marker exactly as it was, and the agent's reply to it does too — only the answer tag below
retires the hold. **FIFO restore with a parked backlog** ([monorepo#1791](https://github.com/intent-hq/monorepo/issues/1791),
[intentd#1059](https://github.com/intent-hq/intentd/pull/1059)): under the `"all"` flush mode
(the default), a user-origin `agent.sendMessage` to an agent whose hold has parked
ready-to-send entries no longer runs a DIRECT turn past them — the send converts to a
user-origin enqueue + immediate drain kick, returning the ordinary queued result
`{ success: true, queued: true, queuedMessage, turnId }` (an existing union member; NO
`heldForQuestions` marker — this is not a hold park), and the batch flush delivers the older
parked entries FIFO in the SAME combined turn as the user message (see the Queued-message
flush "Question hold" bullet above). The conversion applies only when entries are parked, the
flush mode is `"all"`, and the session is not parked in `Error` (whose documented recovery is
the direct fresh send); under `"systemOnly"`/`"off"` — where no combined turn exists to carry
the parked entries — the direct-send bypass stands unchanged.

**Release.** The hold ends when (1) a user row lands whose `messageMetadata` is
`{ "type": "question_answers", "answeredQuestionsMessageId": "<marked assistant message id>" }`
naming **exactly** the marked message — the FE composer wizard tags its flattened `Q:`/`A:` answer
message this way; the daemon never inspects the answer TEXT, and a missing / foreign / stale
`answeredQuestionsMessageId` (e.g. an answer for a set a newer turn already superseded) is a no-op,
so a late answer can neither release a newer hold nor re-arm an old one. The intake runs on every
user-row persist path (direct send, queue drain, wake delivery), so an answer that was auto-queued
behind a busy turn still releases on drain; (2) **`agent.dismissQuestions`** persists the dismissal
marker for that message id — since intentd#892 (within v4.3) the dismissal additionally delivers the
system-origin **dismissal notice** to the model (immediate turn when idle; otherwise promoted to
the absolute queue head with `interruptPriority: true`, ahead of every parked entry including
pre-existing interrupts, so the model learns of the dismissal before the released backlog drains
— best-effort under a concurrent drain race; see the `agent.dismissQuestions` row for
the wording, `questions_dismissed` metadata, ordering, idempotency, and fail-soft contract); or (3)
a **newer** question-bearing assistant turn overwrites the single-slot marker. Both the
dismissal RPC and the end-of-turn path re-kick the queue drain, so parked entries resume promptly
FIFO (interrupt-priority entries first) without waiting for an unrelated trigger; the send-path
hold gates also re-check the hold after enqueueing and self-kick the drain if it cleared
concurrently, so a racing dismissal/answer cannot strand a just-parked entry. The hold also
feeds the workspace's derived `displayStatus`: a top-level foreground agent under hold
promotes it to `needs_attention` (§5.1 step 2), and each hold flip — the question-asking
turn end and every release path above — recomputes-and-compares, pushed as
`workspace:displayStatus-changed` on an actual transition (§6.5).

```json
// → automatic A2A send while the target's question hold is active
{ "jsonrpc":"2.0","id":30,"method":"agent.sendMessage",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-123","content":"[WORKSPACE EVENTS] ..." } }
// ← parked, not delivered (note: only reachable via internal/MCP automatic senders —
//    the FE/router front door is user-origin and would deliver instead)
{ "jsonrpc":"2.0","id":30,"result":{ "success": true, "queued": true, "heldForQuestions": true,
  "queuedMessage": { "id":"user-msg-99..","content":"[WORKSPACE EVENTS] ...","queuedAt":"2026-07-30T01:00:00.000Z","position":0,"turnId":"user-msg-99.." },
  "turnId":"user-msg-99.." } }
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
| agent.diagnostics | workspaceId (req), agentId?, taskNoteId?, staleRespondingAfterMs? | { diagnostics, text } — JSON snapshot plus a pre-formatted text rendering; optional filters narrow to one agent or task. The snapshot includes `eventSubscriptions` (monorepo#947): the workspace's live `event.subscribe` registrations (same per-entry shape as `agent.getSubscriptions` plus `orphaned`), counted in `summary.eventSubscriptions` and per-agent as `eventSubscriptionCount`; a subscription whose subscriber is missing or deleted raises an `orphaned-event-subscription` stuck-risk signal (live chief cross-workspace subscribers are not flagged). The `queues` snapshots are real ([intentd#816](https://github.com/intent-hq/intentd/pull/816) — previously hardcoded `[]`): each agent's pending entries in drain order (interrupt-priority first, then FIFO; `editing: true` entries last), `content` truncated to 200 chars with a `…` ellipsis, bulky `imageBlocks`/`fileBlocks` dropped, attribution left in `messageMetadata` (the services-layer presentation — see the agent-facing queue visibility block above the Question hold section). Agent rows carry `waitingOnHooks?` (idle-visibility, within v3.1) — the same active-hook metadata list as the §5.5 `AgentLite` projection, omitted when empty — and `waitingOnPrMonitors?` (idle-visibility, unified external-wait, within v6.2) — the same active-PR-monitor metadata list, omitted when empty. Agent rows also carry `subtreeMemoryBytes?` (within v6.16; monorepo#2063) — the resident bytes of the agent's descendant process tree (each descendant's RSS credited to its nearest registered agent root, from the same sweep as `system.status`'s `childMemoryBytes`, §5.7), **omitted** when the agent has no attributed bytes (not spawned, no sample yet — the first sweep lands within the sampler's current cadence (~5s baseline, 500 ms while an ephemeral ACP adapter holds a slot, §5.7) — or no runtime manager attached; absent, never `0`/`null`). **Diagnostics-only by design**: the field never rides the hot `agent.list`/`agent.get` payloads (§5.5 `AgentLite`) — measurement/observability only, nothing enforces per-agent limits with it |
| agent.getSession | agentId (req), workspaceId? | { session: AgentSession } — full projection (superset of `AgentLite`): includes `systemPrompt`, `specialist`, the persisted metadata block, and the full `messages` log (chronological). Also carries the derived monorepo#940 `sessionCorrupted?` flag (same derive-on-emit + omitted-when-false semantics as the `AgentLite` projection, §5.5 `agent.list`) so a client rehydrating after a terminal-failure `agent:status-changed` still sees it. Both projections serve the persisted top-level `stopReason?` and — additive — `stopReasonTimestamp?` (the ISO timestamp the stop reason was recorded; persisted alongside `stop_reason`, cleared wherever it clears — turn begin, `agent.retry` — and omitted when absent, never `null`), so clients can render how long ago a parked-in-error session failed. Both projections also serve the top-level `reasoningEffort?` (v5.2) — the session's persisted reasoning-effort level, omitted when unset — and the session-discovered `effortLevels?` (§5.5 "Session-discovered effort levels"; omitted when the provider advertises none). Both projections also serve the harness stamp `harnessVersion` + `harnessFeatures` (within v7.0, §5.5 "Harness versioning") — the immutable creation-time harness version (always present) and the captured `agentFeatures` snapshot (always carries a value on the wire; a legacy pre-snapshot row follows live settings on read until its first activation freezes the snapshot). Backs the FE-side `loadAgent` rehydration path. `-32602 "Agent not found"` when the session is unknown |
| agent.update | agentId (req), workspaceId?, changes (req) | { success: true, agent: AgentLite } — partial update of the persisted `AgentSession` from a `changes` object. Whitelisted fields: `status`, `isActive`, `acpSessionId`, `backendSessionId`, `name`, `nameExplicitlySet`, `model`, `reasoningEffort` *(v5.2)*, `provider`, `systemPrompt`, `specialist`, `taskNoteId`, `skipAutoCommit`, `completionReport`, `completionReportTimestamp`, `delegationDepth`, `initialMessage`, `contextReferences`, `imageBlocks`, `isBackground`. Optional-string fields accept a JSON `null` to clear; `reasoningEffort` additionally treats an empty/whitespace-only string as a clear (stored as-is otherwise — no vocabulary validation, providers interpret the level; applied on the next prompt send). `effortLevels` is NOT whitelisted (daemon-discovered at session open, never client-written — §5.5 "Session-discovered effort levels"); the result `AgentLite` still serves it when present. Write-once (`acpSessionId`) and immutable (`provider`) invariants are still enforced by the store. Emits `agent:updated` (or `agent:renamed` when `name` is the only mutated field). Unknown fields → `-32602`; unknown agent → `-32602 "Agent not found"` |
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

### 5.6 `git.*`

| Method | Params | Result |
| --- | --- | --- |
| git.status | workspaceId (req), gitRootId? (v6.15, see "Scoping a read to a registered git root" below) | { branch, ahead, behind, diverged, files: FileStatus[], hasUncommittedChanges, hasUntrackedFiles }. Each `FileStatus` is `{ path, status, staged }` plus, on submodule (gitlink) entries only, the additive gitlink metadata (monorepo#1739): `mode: "160000"`, `oldSha?` (pre-change pin; omitted for a newly added submodule), `newSha?` (post-change pin; omitted for a deleted submodule, or when libgit2 cannot resolve the workdir side). All three fields are omitted on regular file entries, so pre-#1739 clients see the previous shape byte-for-byte |
| git.stage | paths (req, CSV string or array) | { ok, paths } — staging ./*/--all is rejected (-32603) |
| git.commit | message (req) | { ok, hash?, files? } (deprecated; prefer agentCommit) |
| git.agentCommit | message (req), files?, userRequested? | { ok, hash, files, fileCount } — commit-set selection below; `userRequested: true` also bypasses the auto-commit-disabled gate (wrap-up semantics below) |
| git.checkMergeConflicts | targetBranch? | { hasConflicts, conflictedFiles, targetBranch, currentBranch, ... } |
| git.getBranches | repoPath (req), includeRemote? | { branches, remoteBranches, currentBranch, defaultBranch } — repoPath must be an existing local git repository (-32602 otherwise; see below) |

**Path-based branch reads (`git.getBranches`, `git.branchStatus`).** These two read-only methods take a filesystem `repoPath` instead of a `workspaceId` because the workspace-initializer BranchSelector lists branches for a user-picked repo *before* any workspace referencing it exists — a known-repo gate here is a chicken-and-egg failure (the create flow can never register the repo it cannot list). Mirroring the ungated legacy IPC handlers (`git:getBranches` `{ repoPath }` variant, `git:getBranchStatus`), the daemon accepts **any local path that exists and is a git repository** (registered as a workspace or not) and rejects invalid paths with distinct `-32602` errors: `Repository path does not exist: <path>` for a nonexistent path, `Path is not a git repository: <path>` for an existing non-git directory. `git.pull` (extensions table below) shares the same `repoPath` validation for the same reason — the workspace-create auto-pull runs before the repo is registered; all other mutating `git.*` methods remain workspace-scoped and are unaffected.

```json
// → request
{ "jsonrpc":"2.0","id":30,"method":"git.stage","params":{ "workspaceId":"ws-abc","paths":["src/a.ts","src/b.ts"] } }
// ← response
{ "jsonrpc":"2.0","id":30,"result":{ "ok": true, "paths": ["src/a.ts","src/b.ts"] } }
```

**`git.agentCommit` commit-set selection.** What lands in the commit depends on which of `files` / `userRequested` / the caller's agent context are present. An explicit-set commit (modes 1 and 3) is **pathspec-limited** (`git commit -- <paths>` semantics), so paths another actor pre-staged are never swept into an agent's commit; the `userRequested` checkpoint (mode 2) instead commits the index as-is — which by definition contains only staged paths:

1. **Explicit `files`** — the listed paths are committed as-is (staged and committed regardless of prior index state).
2. **No `files`, `userRequested: true`** — a user checkpoint: commits the index as-is (plain `git commit` semantics, i.e. only the **already-staged** paths — including paths another agent staged, as any `git commit` would); unstaged and untracked changes are left alone. An empty index → `-32603` "No staged changes found to commit".
3. **No `files`, agent-initiated** (an agent context is present) — commits only the paths the file-tracking attribution pipeline (§5.19) credits to the committing agent: `tracked_changes` rows at stage unstaged/staged for that `agentId`, **intersected with the actual uncommitted changes** (`git.status` files — staged, unstaged, and untracked alike), so a stale attribution row never resurrects a committed/reverted file. An empty attributed set commits nothing (`-32603` "No uncommitted changes found for this agent"). Post-commit, the committed paths' attribution rows advance unstaged/staged → committed, keeping the audit trail consistent.
4. **No `files`, no `userRequested`, no agent context** — attribution is impossible, so the commit is **refused** (`-32603`) rather than sweeping the worktree.

**Per-workspace auto-commit resolution.** The auto-commit gate (`git.commit`, `git.agentCommit`, the idle wrap-up path below, and system-prompt assembly) resolves auto-commit **per workspace**: the persisted workspace override (§5.1 `workspace.getAutoCommit` / `workspace.setAutoCommit`) when set, else the global `git.autoCommit` setting (§5.12). `workspace.create` and `workspace.duplicate` seed the override from the effective value at creation time (mirror-at-creation), so later global changes never retroactively flip existing workspaces; pre-migration rows have no override and keep following the global.

**Wrap-up semantics (what the auto-commit state means).** Auto-commit is an **end-of-turn wrap-up** model, not a prohibition on agent commits. **ON:** when the agent's turn ends, the daemon commits the agent's remaining attributed changes — the paths the attribution pipeline credits to that agent, per commit-set rule 3 above, not the whole worktree (the idle wrap-up path below), and agents are also free to commit mid-turn themselves via `git.commit` / `git.agentCommit` (the agent-facing MCP `ws.git.commit`). **OFF:** no wrap-up runs, and agent-initiated commits are **rejected by the gate** (`-32603`) — the rejection message tells the agent the user has turned off agent commits for this workspace, not to work around the gate (no raw `git commit` or other means), and to retry with `userRequested: true` only when the user has explicitly asked for a commit. `userRequested: true` is that explicit-user-ask bypass: it is the only way an agent-initiated commit lands while auto-commit is OFF.

**Commit-policy prompt layer (status-neutral).** The system prompt's commit-policy layer does **not** branch on the auto-commit state (and ignores the session `skipAutoCommit` flag): every agent receives the same single clause in both states — commit through `ws.git.commit` (never raw `git commit` unless the user explicitly asks for a git workflow it cannot express), commit when it makes sense for the work, and the system may automatically commit any remaining changes when the turn ends. Enforcement of the OFF state lives entirely in the gate above, not in the prompt; the effective state (per-workspace resolution, provided the session has not opted out via `skipAutoCommit`) still drives the top-level-agent suggested-prompts footer. A user who wants zero agent commits expresses that through rules/`AGENTS.md`, not this layer.

**Wrap-up on `agent:idle` (daemon-internal, not wire surface).** When an agent turn completes (`agent:idle` event) and the workspace has uncommitted changes with auto-commit enabled (per-workspace resolution above; and the session did not set `skip_auto_commit`), the daemon automatically generates a conventional-commit-formatted message via `agent.completeOnce` (§5.32) with the bundled `commit-message` instruction as system prompt. The prompt context includes: the uncommitted diff (truncated), recent commit subjects (for style mimicry), the repo-root `AGENTS.md` when present (truncated), and the task title / agent name as hints. The generated output is parsed for `<<<COMMIT_MESSAGE>>>` tags. On any generation failure, timeout, or malformed output, the daemon falls back to the deterministic subject chain (`taskTitle` → agent name → `"Agent changes"`) so auto-commit is never blocked or skipped because generation failed. The `agent.completeOnce` binary resolution order (§5.32 Execution) honors the `context.auggiePath` setting when set, ensuring hermetic e2e tests and explicit user config are respected. This internal auto-commit path has no wire RPC — clients only observe the resulting `git:commit` event (§6.5).

**Working-tree & branch operations.** The inverse of `git.stage` plus working-tree/branch reads. `git.diff` is accepted as an alias for the wire-canonical `git.diffs`, and `git.log` as an alias for `git.commits`.

| Method | Params | Result |
| --- | --- | --- |
| git.unstage | paths (req, CSV string or array) | { ok, paths } — inverse of `git.stage`; rejects `./*/--all` with `-32603`; idempotent on already-unstaged paths |
| git.discard | workspaceId (req), paths (req, CSV string or array) | { ok, paths } — discard working-tree changes: tracked paths restored from the index (equivalent to `git checkout -- <paths>`), untracked paths deleted from disk (files unlinked, directories removed recursively); staged changes are untouched. Rejects `./*/--all` with `-32603`; idempotent on already-clean tracked paths and on missing untracked paths (ENOENT parity with the reference's race-tolerant `fs.unlink`). Ports the legacy `git:discard-changes` IPC. |
| git.branchStatus | repoPath (req unless `gitRootId` is supplied), branchName (req); or workspaceId + gitRootId (v6.15) | { branch, currentBranch, isCurrentBranch, ahead, behind, hasUncommittedChanges } — path-based like `git.getBranches` (same repoPath validation, see above); ports the legacy `git:getBranchStatus` IPC. **Registered-root addressing (v6.15):** `workspaceId` + `gitRootId` may stand in for `repoPath` — the registered root resolves to its canonical path (unknown/foreign id → `-32602`, see "Scoping a read to a registered git root" below). `repoPath` wins when both are supplied, so existing callers are byte-identical; neither supplied → the pre-existing missing-`repoPath` `-32602` |
| git.pull | repoPath (req), branchName (req) | { ok, error? } — path-based like `git.getBranches` (same repoPath validation, see above); ports the legacy `git:pullBranch` IPC used by the workspace-create auto-pull. When `branchName` is not the checked-out branch, only `origin/<branchName>` is fetched (worktrees are created from the remote-tracking ref); when it is checked out, the equivalent of `git pull --rebase origin <branchName>` runs with auto-stash (dirty worktree stashed incl. untracked → rebase → stash popped; the stash entry is **kept** on a conflicted pop, git-CLI parity). After a successful pull, if `.gitmodules` exists, runs `git submodule update --init --recursive` (bounded 100s timeout) to sync submodule worktrees to updated gitlinks. Ordinary pull failures (conflicts, unreachable remote, stash-recovery problems, submodule sync timeout/failures) are a structured `{ ok: false, error }`, never a JSON-RPC error; `error` is omitted on success |
| git.changes | workspaceId (req), gitRootId? (v6.15, see below) | { files: FileStatus[] } — the same working-tree list as `git.status.files` (including the monorepo#1739 gitlink metadata fields on submodule entries) |
| git.diffs (alias git.diff) | workspaceId (req), path?, paths?: string[], staged?, gitRootId? (v6.15, see below) | per-file diff hunks (`staged: true` → HEAD→index; else index→workdir). `path` narrows to one file; `paths` narrows to a set of worktree-relative files. Both are literal pathspecs (no glob expansion), unioned when both are set, and applied daemon-side so the diff walk is pruned to the requested files; an empty/omitted narrowing set means the full tree. **Absolute-path normalization (defense-in-depth):** an entry (in `path` or `paths`) that is absolute and lies under the **selected root** — the workspace worktree, or the registered root's path when `gitRootId` scopes the read (v6.15) — is stripped to its root-relative form before narrowing — the same conversion `git.showFile` applies to `filePath` — so it returns the same narrowed result as the relative form and coalesces with it in flight; an absolute entry outside the selected root passes through verbatim and matches nothing. Result `path` values are always relative to the selected root regardless of the request form. **Response budget (intentd#743):** a single file whose serialized hunks exceed **512 KiB** keeps its `path` but carries an empty `hunks` array; once the whole-response budget of **4 MiB** is spent, every further file is likewise emitted as a path-only entry with empty `hunks` — no entries are dropped and file order is preserved, so the client still sees the full changed-path set. Truncation is silent on the wire (daemon-side warn log only); a client that needs an empty-`hunks` file's content re-requests with `path`/`paths` scoped to it. Binary files also yield empty `hunks`, so empty hunks alone do not imply truncation. **Submodule (gitlink) entries (monorepo#1739):** a submodule pin change yields the same one-line `Subproject commit <sha>` pseudo-hunk `git diff` prints — a deletion line for the old pin and/or an addition line for the new pin (either side absent for an added/deleted submodule) — synthesized daemon-side from the pin SHAs, since the pins are commits in the submodule's odb, not blobs the superproject could hydrate; present on both the staged (HEAD→index) and unstaged (index→workdir) paths |
| git.commits (alias git.log) | workspaceId (req), limit?, nextToken? (or nested `page: { limit, continuationToken }`), gitRootId? (v6.15, see below) | { items: CommitSummary[], nextToken? } — paginated reverse-chronological history; remote/non-repo workspaces return empty. **Metadata-only**: each `CommitSummary` is `{ hash, sha, author, email, date, message, agentId?, linkedNoteId? }` — `hash` is the canonical full commit hash (pass it as `git.commitDetails` `commitHash`), `sha` is its 7-char abbreviation for display, and `email` carries the same value `git.commitDetails` returns as `authorEmail` (both fields kept for legacy-client parity). The walk skips per-commit tree diffs, so `files` is omitted; fetch per-file data on demand via `git.commitDetails` |
| git.commitDetails | workspaceId (req), commitHash (req) | { commitHash, author, authorEmail, date, message, files: string[], fileDetails: [{ path, additions, deletions }] } — metadata + per-file line stats for one commit (diff vs first parent; a root commit diffs against the empty tree). `commitHash` accepts anything revparse-able. `files` mirrors `fileDetails[].path` for callers that only want names. Unknown/remote/non-repo workspaces and unresolvable hashes degrade to the same shape with empty strings/arrays (echoing `commitHash`), never a JSON-RPC error; missing `commitHash` → `-32602`. This is the on-demand per-file read behind metadata-only commit lists (see CommitWithAttribution, §5.18) |
| git.showFile | workspaceId (req), filePath (req), ref (req), gitRootId? (v6.15, see below) | { content } — file content at `ref` (`git show <ref>:<path>` semantics; ports the legacy `git:show-file` IPC behind the diff viewers / PR section / commits timeline). `filePath` may be relative to the selected root (the workspace worktree, or the registered root when `gitRootId` is set — v6.15) or absolute (absolute paths under the selected root are made relative); `ref` accepts anything revparse-able (commit hash, branch, `HEAD`, `<hash>^`, …) plus the index ref `":0"` (stage-0 index entry). A path missing at `ref` (e.g. a new file) → `{ content: "" }`, mirroring the legacy handler; unknown/remote/non-repo workspaces → `{ content: "" }` (the same empty fallback as the other `git.*` reads); an unresolvable `ref` → `-32603`. **Non-blob paths (monorepo#1739):** a path that resolves to a non-blob tree entry — a `160000` gitlink (submodule pin) or a `040000` tree — is `-32602` with machine-readable `error.data = { code: "not-a-file", path, mode }` (`mode` is the octal tree-entry mode string, e.g. `"160000"`), at both revparse-able refs and the index ref, so clients route submodule entries to a dedicated presentation instead of receiving empty content (the pre-#1739 behavior silently returned `{ content: "" }` for tree entries and an opaque internal error for gitlinks) |
| git.numstat | workspaceId (req), staged?: boolean, baseRef?, baseCommitSha?, targetRef? (default `HEAD`), paths?: string[] | `[{ filePath, additions, deletions }]` — per-file added/deleted line counts, returned as a **bare array**. When a branch base is supplied (`baseRef` and/or `baseCommitSha`), the counts come from the committed two-dot `<boundary>..<targetRef>` range (branch-boundary resolution below) and `staged` is ignored; otherwise the working tree is counted, tracked files only: `staged: true` → HEAD→index, `staged: false` → index→workdir, `staged` omitted → HEAD→workdir. `paths` filters the result to the given worktree-relative paths. An unresolvable boundary, and unknown/remote/non-repo workspaces, degrade to `[]`, never a JSON-RPC error |
| git.branchDiff | workspaceId (req), baseRef? / baseCommitSha? (at least one req, else `-32602`), targetRef? (default `HEAD`), paths?: string[] | `[{ file, chunks: [], oldContent, newContent }]` — committed branch-base diff, returned as a **bare array**: one entry per changed file in the two-dot `<boundary>..<targetRef>` range (branch-boundary resolution below), carrying the full file contents at the boundary (`oldContent`) and at `targetRef` (`newContent`) so the FE branch-base viewer renders the diff from the two contents alone (parity with the legacy `batchedGitBranchBaseDiff`). `chunks` is always an empty array — the branch-base consumer ignores it. A path missing at a ref yields empty content on that side (`git.showFile` semantics: added files → empty `oldContent`, deleted files → empty `newContent`). A gitlink (submodule, mode `160000`) side yields the synthesized `Subproject commit <sha>\n` pseudo-content instead of blob contents — the pin is a commit SHA, not a blob, so the daemon renders the same one-line form `git.diffs` uses rather than failing the call. `paths` filters the result to the given worktree-relative paths. An unresolvable boundary (including an unresolvable `targetRef`), and unknown/remote/non-repo workspaces, degrade to `[]`; git failures while reading the file contents (repository IO) → `-32603` |
| git.clone | url (req), parentDir (req), targetName?, requestId? | { requestId, targetPath } — **streaming**: returns the ack promptly and pushes `git:clone:progress` frames followed by a terminal `git:clone:done` (§6.5). A leading `~` / `~/` in `parentDir` expands to the daemon user's home directory (`~user` forms pass through unchanged; expansion is best-effort — when the daemon cannot resolve a home directory the path passes through verbatim); the ack's `targetPath` always carries the post-expansion path. `targetName` defaults to the URL basename (with `.git` stripped); rejected if it contains a path separator or would escape `parentDir`. `-32602` on missing/invalid params; `-32603` when the target path already exists or the event bus is not wired. |

**Branch-boundary resolution (`git.numstat`, `git.branchDiff`).** Both methods resolve the diff boundary the same way, and the daemon owns it (clients never compute a merge-base). When `baseRef` is set, the boundary is the **merge-base** of `targetRef` and the base branch — a bare branch name (no `/`) tries `origin/<baseRef>` first, then the local ref; a name containing `/` is tried verbatim. When `baseRef` is absent or fails to resolve, `baseCommitSha` is used **verbatim** as the boundary, but only when it is an ancestor of (or equal to) `targetRef`. If neither yields a boundary — including an unresolvable `targetRef` — the result is `[]`, never a JSON-RPC error.

**Streaming `git.clone`.** Long-running clones cannot use the buffered `host.exec` (§5.14) — the FE animates a progress bar as objects arrive. `git.clone` mirrors the `search.*` streaming shape (§5.15 / §6.5): the method returns `{ requestId, targetPath }` immediately and the daemon spawns `git clone --progress` with a piped stderr, parses the canonical phases (`starting` → `counting` → `compressing` → `receiving` → `resolving` → `checkout` → `complete`) into `git:clone:progress` frames, and emits a terminal `git:clone:done` when the child exits, times out (5 min hard cap), or fails to spawn. `GIT_LFS_SKIP_SMUDGE=1` is preserved so a missing/unreachable LFS object never fails the clone. The `url` is used only at spawn time; neither the URL nor the environment ever appears in the streamed payloads, and any `user:pass@` credential fragment in stderr is redacted before it surfaces on the `git:clone:done { error }` frame.

**Clone credential injection (private HTTPS github.com repos).** For an HTTPS `github.com` URL, the daemon resolves the stored GitHub token per `sourceControl.github.tokenSource` (§5.27 auth model: secrets store → env → `gh` CLI for `auto`) and offers it to the child git as a github.com-scoped credential helper injected via the `GIT_CONFIG_PARAMETERS` environment variable (appended after any inherited entries) — configured helpers still win, matching the `git.pull`/fetch chain. The token travels to the child through an environment variable only: it never appears in argv (process listings), persisted git config, logs, streamed payloads, or error surfaces. SSH and non-GitHub URLs skip token resolution entirely. Applies to both `git.clone` and the `workspace.create` clone orchestration (§5.1). A failed clone's `git:clone:done` frame carries an optional machine-readable `errorCode` (clone failure taxonomy, §9.1) alongside the human-readable `error`; `errorCode` is present only when the failure was classified.

```json
// → request
{ "jsonrpc":"2.0","id":40,"method":"git.clone",
  "params":{ "url":"https://github.com/example/repo.git","parentDir":"/tmp/wt","targetName":"repo","requestId":"clone-1" } }
// ← prompt ack — the clone runs in the background
{ "jsonrpc":"2.0","id":40,"result":{ "requestId":"clone-1","targetPath":"/tmp/wt/repo" } }
// ← incremental progress (§6.5), correlated by requestId
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"git:clone:progress","workspaceId":"","id":"evt-a1",
    "timestamp":"2026-07-01T05:01:00.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"clone-1","phase":"receiving","percent":45,"message":"Receiving objects: 45%" } } } }
// ← terminal event — clone finished
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"git:clone:done","workspaceId":"","id":"evt-a2",
    "timestamp":"2026-07-01T05:01:12.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"clone-1","ok":true } } } }
```

**Multi git root tracking (v6.15, monorepo#2053).** A workspace can track **secondary git roots** — additional local git repositories relevant to its work (an agent-created subtree checkout, an initialized submodule, or a sibling clone anywhere on the host) — alongside its implicit primary worktree. Each root is a persisted `WorkspaceGitRoot` row (rows cascade with their workspace):

```json
{
  "id": "wgr-7f3a…",              // WorkspaceGitRootId
  "workspaceId": "ws-abc",
  "path": "/home/user/checkouts/intentd",  // canonicalized absolute repo-root path
  "source": "agent",               // "agent" (ws.git.registerRoot) | "auto" (submodule auto-detect)
  "repoOwner": "intent-hq",        // optional; detected from the root's `origin` remote (https / git@host:path / ssh:// GitHub URL forms; non-GitHub remotes leave both unset)
  "repoName": "intentd",           // optional; detected from the root's `origin` remote
  "registeredByAgentIds": ["agent-…"],  // omitted when empty; registration order, deduped
  "registeredCommitSha": "abc123…",     // optional; the root's HEAD commit SHA when the value was FIRST captured — at registration (agent or auto-detect) going forward, or at the sweep's best-effort backfill for rows that predate the field / had an unreadable HEAD at registration (backfilled rows carry the backfill-time HEAD, NOT registration-time provenance) — immutable once set (re-registration/merges never overwrite it); omitted while still unknown
  "prNumber": 123,                 // optional; per-root PR discovery (§7.6 fields, mirroring Workspace)
  "prUrl": "https://github.com/…", // optional
  "prStatus": "open",              // optional; PullRequestStatus (§7.6)
  "pullRequests": [ … ],           // optional; PullRequestInfo[] for the root's current branch (§7.6)
  "createdAt": "2026-08-13T00:00:00.000Z",
  "updatedAt": "2026-08-13T00:00:00.000Z"
}
```

| Method | Params | Result |
| --- | --- | --- |
| gitRoot.list | workspaceId (req) | { gitRoots: [WorkspaceGitRoot…] } — every registered root for the workspace (agent-registered and auto-detected). Each wire row is the persisted shape above **plus a live-read `branch?`** (the root's current HEAD branch, read per call — never persisted, since HEAD moves outside the daemon's control; omitted when unreadable). Missing/unknown workspace → `-32602` |

**Registration is MCP-only (§6.8 principle).** There is no wire register/unregister method — secondary roots are agent-registered working state, so agents author them via the MCP bindings and the FE reads (`gitRoot.list`) and subscribes (`gitRoot:*`, §6.5) but never registers: `ws.git.registerRoot(path)` registers an existing git repo root (a **relative** path resolves against the workspace worktree — the caller is an agent whose cwd is the worktree, so resolving against the daemon's own cwd would be surprising — while an absolute path passes through untouched; the resolved path must exist and carry a `.git` entry — a directory for a normal clone, a file for linked worktrees and submodule checkouts; it is canonicalized and may live anywhere on the host; the workspace's own primary root is rejected — it is tracked implicitly) and returns the wire row; idempotent by canonical `(workspaceId, path)` — re-registering merges the caller into `registeredByAgentIds` and upgrades an auto-detected row to `source: "agent"` (emitting `gitRoot:updated` rather than a duplicate). `ws.git.unregisterRoot(path)` removes a root by path → `{ ok, gitRootId, path }` (errors when no root is registered for the path). `ws.git.listRoots()` returns the bare array (`gitRoots` unwrapped), same rows as `gitRoot.list`.

**Scoping a read to a registered git root (`gitRootId?`).** Six git reads accept the optional `gitRootId` param: `git.status`, `git.changes`, `git.diffs` (alias `git.diff`), `git.commits` (alias `git.log`), `git.showFile`, and `git.branchStatus` (registered-root addressing above — `workspaceId` + `gitRootId` stand in for `repoPath`, with `repoPath` winning when both are supplied). When set, the read runs against the registered root's path instead of the workspace worktree; all other parameters and the result shape are unchanged. An unknown id **and** an id registered to another workspace both fail `-32602` with the **identical** message (`Unknown git root: <id>`) — a foreign root is deliberately not distinguishable from a nonexistent one, so roots cannot be probed through a foreign workspace. An empty or whitespace-only `gitRootId` is treated as absent (primary-worktree behavior), and omitting it reproduces the pre-6.15 behavior byte-for-byte.

**Background sweep (daemon-internal, no wire surface).** The background PR-refresh loop sweeps each workspace's roots after the workspace's own PR refresh: it **auto-detects** the worktree's initialized git submodules (`.gitmodules` entries with a nested `.git`) and registers them as `source: "auto"` roots (idempotent — already-tracked paths are untouched; a root removed via `ws.git.unregisterRoot` is re-added while the submodule exists on disk), **auto-prunes** roots whose path no longer exists on disk (emitting `gitRoot:unregistered`), **best-effort-backfills** a surviving root whose `registeredCommitSha` is still unknown by stamping it with the root's CURRENT HEAD (rows predating the field, or whose HEAD was unreadable at registration — a going-forward boundary: backfilled rows carry backfill-time provenance, not the HEAD at their original registration, so clients must not read the field as registration-time provenance for them; the write is guarded so a set value is never overwritten, and a successful stamp emits `gitRoot:updated`), and **refreshes each root's PR linkage** by its current branch against its detected repo — the same discovery that fills the workspace's own PR fields (§7.6), bounded per root by the same fetch timeout. Fail-soft per root: a bad root is logged and never aborts the sweep. Clients observe the sweep only through `gitRoot:*` events (§6.5).

### 5.7 `pr.*`

The namespace holds the **two** workspace/active-PR-scoped methods that survived the v5.0 removal: `pr.status` (requires an active pull request on the workspace — otherwise the underlying service throws → `-32603`) and `pr.refresh` (exists to establish/repair the link and works without one — see its semantics note below).

> Host-agnostic naming. `pr.*` is the canonical wire name. Conceptually it is host-agnostic — "PR" covers pull request / merge request / change request — and in v1 it is backed by GitHub (selected via the sourceControl.activeProvider setting, §5.12). Future forges (GitLab, Bitbucket) plug in behind the same pr.* surface.

> **Removed in v5.0 ([intent-hq/intentd#921](https://github.com/intent-hq/intentd/pull/921); monorepo#1506).** The 11 other `pr.*` methods — `pr.capabilities`, `pr.createReview`, `pr.getReviews`, `pr.listCheckRuns`, `pr.listComments`, `pr.listReviewComments`, `pr.merge`, `pr.postComment`, `pr.replyToReviewComment`, `pr.resolveThread`, and `pr.updateBranch` — were left caller-less after agent GitHub workflows moved to the `gh` CLI and the `ws.pr.*` MCP surface shrank to snapshot-only ([intent-hq/intentd#918](https://github.com/intent-hq/intentd/pull/918)), and are deleted from the wire (calling one returns `-32601` Method not found — same precedent as the v3.0 `pr.waitForChanges` removal). The v2.1 provider capability gating went with them (no gated `pr.*` operation remains). Equivalent PR read/write operations live on the explicit-addressing `github.*` surface (§5.27 — e.g. `github.pulls.merge`, `github.pulls.updateBranch`, `github.getReviewThreads`, `github.listReviewComments`, `github.replyReviewComment`, `github.resolveThread` / `github.unresolveThread`); agents use `gh` on the host plus the read-only MCP `ws.pr.snapshot` binding (below).

| Method | Params | Result |
| --- | --- | --- |
| pr.status | — | { prNumber, title, url, state, mergeable, mergeableState, hasConflicts, isDraft, isMerged, isClosed, summary } |
| pr.refresh | — | { outcome: "skipped" \| "unchanged" \| "linked" \| "updated" \| "unlinked", prNumber: number \| null, prUrl: string \| null, prStatus: string \| null, pullRequests: PullRequestInfo[] } — the post-refresh linkage state. Forces the same PR discovery/refresh the daemon's background sweep runs for one workspace, on demand |

> **`pr.refresh` semantics.** Unlike `pr.status`, `pr.refresh` does **not** require an
> active PR — it exists to establish/repair the link. It runs the shared refresh path
> (discovery, status update, stale-link clearing, relink-after-merge), so any
> resulting `pr:linked` / `pr:updated` / `pr:unlinked` events (§6.5) are emitted **once** by
> that path — the RPC adds no duplicate emission. The matching rule is **branch OR baseRef**:
> a PR matches a workspace when its head ref equals the workspace's own `branch`, or when it
> matches the workspace's `baseRef` (raw equality, plus the known-remote-prefix-stripped
> remainder for legacy rows persisted before write-side canonicalisation — see `baseRef`
> canonicalisation, §5.1), so review workspaces created *for* a PR link it via `baseRef`.
> Discovery (and relink-after-merge) queries by the workspace's own branch head first —
> branch match takes precedence — then falls back to one open-PR query per baseRef
> candidate (the raw stored `baseRef` plus, when it differs, its known-remote-prefix-
> stripped remainder); when several PRs match, the highest PR number wins. A stale link is
> cleared only on a **positive mismatch**: the linked PR's head ref is known, at least one
> of the workspace's `branch` / `baseRef` is known, and every known field fails to match —
> unknown inputs never unlink. This intentionally deviates from the FE guard
> (which only cleared a stale link when the workspace's own branch was present): a
> branch-less workspace whose `baseRef` positively mismatches the linked PR's head **does**
> unlink. Ineligible workspaces (remote, archived, without a repo, or — when no PR is
> linked — with neither a branch nor a baseRef) return `outcome: "skipped"` rather than
> erroring.
> Unlike the usual omitted-when-absent (`skip_serializing_if`) convention, `prNumber` /
> `prUrl` / `prStatus` are always present and serialize as literal `null` when no PR is
> linked after the refresh; `pullRequests` is always an array (possibly empty). An unknown
> `workspaceId` → `-32602 "Workspace not found"`.

```json
// → request — the active PR's status
{ "jsonrpc":"2.0","id":40,"method":"pr.status","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "prNumber":12,"title":"Add review wire surface",
  "url":"https://github.com/octo/repo/pull/12","state":"open","mergeable":true,
  "mergeableState":"clean","hasConflicts":false,"isDraft":false,"isMerged":false,
  "isClosed":false,"summary":"..." } }
```

> **`ws.pr.snapshot(prNumber, { repo? })` — agent MCP binding *(new in intentd,
> [intentd#887](https://github.com/intent-hq/intentd/pull/887); repo override + echo
> [intentd#911](https://github.com/intent-hq/intentd/pull/911))*.** Since
> [intentd#918](https://github.com/intent-hq/intentd/pull/918) the snapshot is the
> read-only one-shot `ws.pr.*` MCP binding: agent GitHub workflows are **`gh`-CLI-based**
> (PR creation, status/checks, reviews, comments, thread resolution, branch updates, and
> merging all go through `gh` on the host). Since v6.1 the `ws.pr.*` family also carries
> the monitoring bindings `ws.pr.monitor` / `ws.pr.unmonitor` / `ws.pr.monitors` (§5.42)
> — for PR *watching* agents prefer `ws.pr.monitor` (daemon-run polling, no TTL);
> the snapshot survives as the current-state-once read and remains usable from
> **hook-based PR monitoring**
> (§5.40): a hook calls it each run, compares the result against the previous run's
> carry-over `hookState`, and dispatches only on meaningful change. There is **no wire
> method** (MCP-only, per the §6.8 principle — PR watching is agent-authored background
> work; FE clients keep using `pr.status` and the explicit-addressing `github.*` reads, §5.27).
> `prNumber` is **required** (a positive number —
> missing, non-numeric, or `<= 0` values are rejected with a validation error) and
> there is **no active-PR fallback**: the snapshot is scoped to the workspace's
> repository unless `repo: "owner/name"` overrides it (e.g. a submodule's repo), and
> the result echoes the resolved `repo` so a wrong-repo read is detectable.
> Result shape: `{ repo, prNumber, title, url, state, isDraft, isMerged, isClosed, headSha,
> updatedAt, mergeable, mergeableState, mergeBlockedReason, checks: { total, passed,
> failed, pending, failedNames }, reviews: { decision, approvals, changesRequested },
> comments: { conversationCount, reviewCommentCount, unresolvedThreadCount,
> totalCount }, requirements: MergeRequirements }`. **`requirements`** *(additive in v6.1,
> [intentd#989](https://github.com/intent-hq/intentd/pull/989))* is the full
> merge-requirements checklist (§5.42 — "what is still needed to merge this PR"), the
> SAME canonical object `ws.pr.monitor` returns (its `requirements` result field) and
> the monitor loop's change detection diffs — `ws.pr.monitors` rows carry only the
> reduced `lastSnapshot` summary of it (§5.42), and monitor wakes carry the derived
> change lines; the top-level `checks` / `reviews` / `comments` blocks are the compact
> projection of the same read. `mergeBlockedReason` is a human-readable
> reason and is non-`null` exactly when the PR is open (draft included) and cannot be
> merged. `checks` tallies the runs on the PR head (SHA, else source branch); a
> provider without the `checkRuns` capability — or a PR whose head cannot be
> determined — reports an empty tally rather than failing the snapshot.
> **`reviews.decision`** *(changed in intentd,
> [intentd#942](https://github.com/intent-hq/intentd/pull/942);
> [intent-hq/monorepo#1524](https://github.com/intent-hq/monorepo/issues/1524))*
> is derived from the forge's authoritative review-requirement verdict (GitHub's
> GraphQL `reviewDecision`) when available: `approved`, `changes_requested`, or
> `review_required` (the last only for an open PR, draft included) map directly.
> When the provider signal is unavailable — no review requirement configured on
> the base branch, a host without the capability, or a failed fetch — the
> decision falls back to the aggregated actionable reviews; a provider
> `review_required` on a merged/closed PR is likewise discarded and falls back
> to the aggregate. That fallback yields `changes_requested`,
> else `approved`, else `none`; the fallback path never yields
> `review_required`. REST `mergeable_state` is **no longer consulted** for this
> field — its `blocked` value conflates required checks, merge queues, and
> token-access gaps with an actual review requirement, and previously caused
> `review_required` to appear on PRs with no reviews or requirement at all.
> `comments.reviewCommentCount` counts every inline thread comment **including
> replies** (threads come from GraphQL when available, else the REST list
> grouped by reply parent), and `totalCount = conversationCount +
> reviewCommentCount`, so a new reply anywhere moves the counter a hook can
> diff. `comments.unresolvedThreadCount` reflects real per-thread resolution
> state from the GraphQL threads; on the REST fallback (grouped by reply parent)
> no resolution state is available, so every thread counts as unresolved — that
> fallback is logged at warn level with the underlying GraphQL error
> *(intentd, [intentd#949](https://github.com/intent-hq/intentd/pull/949))*.

### 5.8 `script.*`

| Method | Params | Result |
| --- | --- | --- |
| script.list | workspaceId (req) | { scripts: [...] } |
| script.create | workspaceId (req), name (req), command (req), mode (req: `service` \| `command`), cwd?, env?, category?, autoStart?, scriptId? | { id, workspaceId, name, command, mode, source, createdAt, cwd?, env?, category?, autoStart?, updatedAt? } — the persisted `WorkspaceScript` record |
| script.remove | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.start | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.stop | workspaceId (req), scriptId (req) | { ok, scriptId } — on a **non-running** script that carries the was-running marker this is the **dismiss** affordance: it clears `previouslyRunning` (in memory plus a best-effort row write), emits a `script:state` snapshot (§6.5), and returns ok instead of erroring |
| script.restart | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.output | workspaceId (req), scriptId (req), maxLines? | output buffer text |
| script.status | workspaceId (req), scriptId (req) | { state, pid, exitCode, url?, previouslyRunning?, ... } — the `ScriptRuntimeState` snapshot; the runtime status value is one of `idle \| running \| restarting \| exited`. `restarting` (new in intentd, monorepo#1318) is the transient restart-in-flight state between an exit and the next spawn attempt — the service auto-restart backoff window and the `script.restart` stop→start gap — so a poll taken mid-restart never reads as a final `exited`/`idle`; the respawn flips it back to `running`. `previouslyRunning?: true` (new in intentd, within v5.1) marks a script that was running when the daemon last stopped — see the was-running marker note below |
| script.run | workspaceId (req), scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } |

> **Unified PTY host (new in intentd).** Scripts run inside (possibly headless) terminals on
> the daemon and share the **unified PTY/terminal host** with interactive terminals (§5.13), so
> a script and a terminal can interact (shared env, signals, attaching to a running script's
> terminal). Live output/state stream as the `script:output` / `script:state` events (§6.5);
> `script.output` / `script.status` remain the historical poll reads. Service/command modes,
> auto-restart, and URL/port detection are preserved — a detected dev-server URL feeds the
> `forward.*` hook when the connection is remote (§5.14).
>
> **Runtime status values.** The `ScriptRuntimeState` served by `script.status` (and as the
> runtime part of `script.list` entries) and carried on `script:state` events reports one of
> `idle | running | restarting | exited`. `restarting` (new in intentd, monorepo#1318) covers
> the restart-in-flight window — a service auto-restart's backoff between an exit and the next
> spawn attempt, and `script.restart`'s stop→start gap — distinguishing it from a final exit;
> the respawn flips it back to `running`.
>
> **Was-running marker (`previouslyRunning?`, new in intentd, within v5.1).** Closing the app
> stops the daemon and kills every running script, and boot hydration previously loaded all
> persisted definitions as plain `idle` — so clients could not tell which scripts were live
> before the shutdown. The daemon now persists a was-running marker on the script row
> (stored-on-write) and surfaces it as the optional `previouslyRunning: true` field on
> `ScriptRuntimeState` — served by `script.status`, the runtime part of `script.list` entries,
> and `script:state` events (§6.5). It is **omitted when false**, so clients detect it by
> presence, not by protocol version.
>
> Semantics:
>
> - **Service-mode only.** A successful start/restart of a `service` script sets the marker;
>   `command`-mode scripts never set it.
> - **Cleared** on a user `script.stop`, on natural exit, and on `script.remove` (the row goes
>   with it); a `script.create` upsert resets it. Starting a marked script clears it — the
>   hydrated `previouslyRunning` drops as the state flips to `running` (an auto-restart's
>   respawn re-sets the marker).
> - **Survives repeated daemon restarts** untouched: a marked row keeps hydrating as `idle`
>   with `previouslyRunning: true` until the script is started or explicitly stopped.
> - **Dismiss:** `script.stop` on a non-running script that carries the marker clears it —
>   in memory and, via the same best-effort persist as every other transition, on the row —
>   and returns ok (instead of erroring), and **emits a `script:state` event** carrying the
>   cleared state, so other subscribers do not retain a stale `previouslyRunning: true`.
> - **Workspace-scoped.** The runtime registry permits the same client-supplied `scriptId` in
>   separate workspaces, so marker reads and writes are qualified by `workspaceId` — setting
>   or clearing the marker in one workspace never touches a same-id script in another.
> - Marker writes are **best-effort**: a failed bookkeeping write is logged and never fails the
>   runtime transition or its `script:state` event. Persistence is therefore not guaranteed on
>   any path, dismiss included — if the clearing write fails, the marker stays on the row and
>   rehydrates as `previouslyRunning: true` after the next daemon restart, and the client can
>   dismiss it again.

### 5.9 `browser.*`, `terminal.*`, `file.*`

| Method | Params | Result |
| --- | --- | --- |
| browser.exec | actions (req, non-empty array), tabId?, agentId?, workspaceId? | single action → the action's `{ action, success, result?, error? }` envelope; multi-action → `{ results: [...] }` — **client-callable trigger** whose real work is served by the connected FE via a reverse RPC (`browser.exec`, `id: "rev-<n>"`), see below |
| browser.docs | topic (req) | docs string — **not exposed**: no router arm; see the `browser.docs — not exposed` block below |
| terminal.list | workspaceId (req) | `{ terminals: [{ id, name, cwd, isExecutingCommand }], daemonBootId }` (v4.0 envelope — the pre-4.0 bare terminals array is retired; monorepo#1334). `daemonBootId` is the daemon's per-boot identifier (UUID v4, minted once per daemon process; never persisted): stable within one daemon lifetime and fresh after a restart, so equal values across responses prove the same daemon lifetime and an **empty `terminals` list is authoritative** for that lifetime (not a restarted daemon that lost its PTYs). `name` is **always present** on each entry: the PTY's daemon-tracked display name when one was assigned at spawn (e.g. **"Setup Script"** for the workspace setup terminal, §5.1/§5.25), else the constant `"Terminal"`. The underlying PTY display name is optional spawn metadata (§5.13); the `name` field is not (clients may still fall back to `"Terminal"` defensively). The agent-facing MCP `ws.terminal.list` binding unwraps the envelope internally — agents still see the bare terminals array (§6.8) |
| terminal.readOutput | workspaceId (req), terminalId (req), maxLines? | output buffer text |
| file.read | path (req) | file contents — paths outside the workspace rejected (-32603) |
| file.readChunk *(v6.18)* | path (req), offset (req; 0-based byte offset), length (req; positive, ≤ 16 MiB decoded) | { content (base64), bytesRead, size } — one offset-windowed slice of the file's raw bytes (the binary counterpart of the UTF-8-only `file.read`; monorepo#2458). `size` is the file's total byte length; a window at/past EOF is `{ content: "", bytesRead: 0, size }` (never an error) and a window crossing EOF returns just the remaining bytes. Zero/over-cap `length` and directory paths are -32602 naming the cause; paths outside the workspace rejected (-32603); missing file → -32603 per the file-op convention |
| file.write | path (req), content (req) | { ok, path, size } |
| file.list | path? (default .) | [{ name, type }] |
| file.delete | path (req) | { ok, path, deleted } |
| file.mkdir | path (req) | { ok, path, created? |
| file.rename | oldPath (req), newPath (req) | { ok, oldPath, newPath } |
| file.placeAttachment | fileName (req), data? (base64), sourcePath? (absolute host path) — exactly one of data/sourcePath; mimeType? (v6.12) | { ok, path, fileName, size, attachmentId, mimeType?, uploadedAt } — `path` is workspace-relative under `.intent/attachments/`, `size` is the placed byte length (v6.5; monorepo#1948). `attachmentId` / `mimeType?` / `uploadedAt` (v6.12) are the additive attachment-registry fields (presence-detected; pre-6.12 daemons omit them): the daemon-minted UUID the placement was registered under, the client-supplied MIME type echoed back (omitted when not supplied), and the ISO registration timestamp |
| file.getAttachmentInfo | attachmentId (req) | { attachmentId, fileName, mimeType?, size, uploadedAt, path, exists } — attachment-registry metadata lookup (v6.12): `path` is the stored workspace-relative path (under `.intent/attachments/`) and `exists` reflects whether the file is still on disk at read time (the registry row survives an out-of-band delete). Unknown id → -32602 naming the id ("unknown attachment id") |
| file.attachmentUpload.begin *(v6.16)* | fileName (req), sizeBytes (req; positive, ≤ 1 GiB), sha256 (req; 64-hex of the complete payload), mimeType? | { uploadId, maxChunkBytes } — opens a staged chunked attachment upload session (16 MiB decoded per chunk); the workspace must exist, `fileName` must pass the same basename sanitization placement applies (fail-early: a name commit would reject fails here, before any bytes are staged), and validation failures are -32602 naming the specifics. A workspace holds at most **4** live sessions (monorepo#2275): a begin at the cap is -32602 naming the live count ("commit or abort one before beginning another"), and every begin first sweeps idle-expired sessions (15-minute idle TTL — see the session-bounds block below) so expired sessions never hold cap slots |
| file.attachmentUpload.chunk *(v6.16)* | uploadId (req), seq (req; 0-based), data (req; base64) | { uploadId, seq, receivedBytes } — stages one seq-numbered slice; per-seq retry is idempotent (the same seq overwrites the same chunk file; only new bytes count against the declared total) and chunks may arrive in any order. Over-cap chunks and totals beyond `sizeBytes` are -32602; unknown uploadId → -32602 ("no attachment upload in progress"); a chunk on an idle-expired session is -32602 ("expired after Ns of inactivity — begin a new upload", monorepo#2275) |
| file.attachmentUpload.commit *(v6.16)* | uploadId (req) | { ok, path, fileName, size, attachmentId, mimeType?, uploadedAt } — byte-shape-identical to a successful file.placeAttachment result: verifies staged bytes = sizeBytes with gap-free seqs from 0 and a matching SHA-256, then places through the same collision-safe placement + attachment-registry path. A failed commit leaves the session alive for retry or abort (and refreshes the idle clock, monorepo#2275); incomplete/gapped/mismatched payloads are -32602. A commit on an idle-expired session is -32602 ("expired … — begin a new upload"), and a commit racing an in-flight chunk (the pipelined chunk+commit race) is -32602 advising to wait for the chunk call to return and retry — the reserved-but-unwritten guise was formerly -32603 Internal; the partially-written guise was already -32602 and gains the retry advice (monorepo#2275) |
| file.attachmentUpload.abort *(v6.16)* | uploadId (req) | { uploadId, aborted } — drops the session and its staging directory; idempotent (an unknown id returns `aborted: false` instead of erroring) |

```json
// → request
{ "jsonrpc":"2.0","id":40,"method":"file.write",
  "params":{ "workspaceId":"ws-abc","path":"notes/out.txt","content":"hello" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "ok": true, "path": "notes/out.txt", "size": 5 } }
```

> **`file.placeAttachment` — daemon-mediated attachment placement (v6.5;
> [monorepo#1948](https://github.com/intent-hq/monorepo/issues/1948)).** Places a chat
> attachment into the workspace's `.intent/attachments/` directory and returns the
> workspace-relative path, so a client can hand an agent a readable on-disk path instead
> of rejecting an oversized inline upload. Exactly one payload source is required:
> `data` — the base64-encoded bytes (an optional `data:<mime>;base64,` URL prefix is
> tolerated, mirroring `note.saveAsset`) — or `sourcePath` — an **absolute** host-local
> file path the daemon copies directly (the same-host FE fast path; the bytes never
> cross the wire). Zero or both sources, undecodable base64, or a relative `sourcePath`
> are `-32602`; the inbound transport cap (§2) bounds the `data` variant like any other
> frame. `fileName` is reduced to a safe basename (path components are stripped; a name
> that reduces to nothing is `-32602`) and collides safely: the first placement keeps
> the name, later ones get `<stem>-2<ext>`, `<stem>-3<ext>`, … (multi-dot names suffix
> before the final extension: `dump.tar.gz` → `dump.tar-2.gz`). The result's `fileName`
> is the name actually chosen and `path` is always `.intent/attachments/<fileName>`.
> **Exclusion contract:** the daemon ensures the `.intent/` directory and its default
> `.gitignore` (ignore everything except `config.json`) exist before placing, and
> additionally drops an ignore-all `.gitignore` inside `attachments/` itself (covering
> repos with a customized `.intent/.gitignore`), so placed attachments never reach git
> tracking, idle auto-commit, or agent attribution. The
> directory is transient scratch space — clients/agents may delete placed files when
> done (`file.delete` works on the returned path).

> **Attachment registry (v6.12).** Every placement is additionally registered in the
> daemon's SQLite `attachments` table under a daemon-minted UUID — `{ id, workspaceId,
> fileName (the collision-safe placed name), mimeType?, size, uploadedAt, storedPath }` —
> and the registry fields ride the result additively (`attachmentId`, `mimeType?`,
> `uploadedAt`; presence-detected, so pre-6.12 clients are unaffected). The optional
> `mimeType` request param is recorded verbatim (blank collapses to absent). Registry
> rows are insert-only and survive an out-of-band delete of the stored file:
> `file.getAttachmentInfo` serves the row with `exists` reflecting the file on disk at
> read time (clients resolve a chip click to the current path this way), and the
> agent-side MCP `ws.file.getAttachment` binding copies the stored file into the
> calling agent's own working directory — the canonical checkout for shared-mode agents,
> the sandbox clone for CoW-sandboxed agents — returning the two failure modes
> distinctly: unknown id vs. registry row whose file was deleted (the latter names the
> original `fileName` + `uploadedAt` and instructs the model to continue without the
> file). The registry id is what the v6.12 attachment-reference file blocks (§5.5) carry
> in place of inline base64 `data`.

> **MCP `ws.file.getAttachment(attachmentId, destDir?)` (v6.12).** MCP-only (no wire
> method, per the §6.8 principle); requires an agent caller context. `attachmentId`
> (required) names the registry row — a cross-workspace id reads as unknown (the
> registry is workspace-scoped). The **source** is always the canonical workspace
> store (`stored path` inside the canonical root — containment-guarded, so a
> tampered registry row can never read outside it); the **destination root** is the
> caller's working directory (the sandbox clone for CoW-sandboxed agents, else the
> canonical checkout), with `destDir` (default `.intent/attachments`) resolved
> within it under the same containment guard, created on demand, and seeded with an
> ignore-all `.gitignore` marker so retrieved copies stay out of git tracking.
> Success returns `{ path, fileName, mimeType?, size, uploadedAt }` — `path`
> relative to the destination root, `mimeType` omitted when the row has none; the
> copy is skipped when the destination already holds a byte-identical file, and a
> partial copy is removed on failure. The two failure modes stay distinct: an
> **unknown id** errors as `unknown attachment id: <id>`, while a registry row
> whose **file was deleted** from the store errors naming the original `fileName` +
> `uploadedAt` and instructing the model to continue without the file rather than
> retry.

> **`file.attachmentUpload.*` — staged chunked attachment upload (v6.16;
> [monorepo#2262](https://github.com/intent-hq/monorepo/issues/2262)).** The
> large-payload counterpart of `file.placeAttachment`, following the v6.9
> `workspace.import.*` staged-session precedent: against a remote daemon the
> single-shot `sourcePath` arm is unusable (the file lives on the client host) and
> the inline `data` arm is bounded by the §1.3 frame cap, so payloads larger than
> one RPC frame travel as a staged session instead. `begin` validates the header
> before any disk side effect — the workspace must exist (unknown → -32602 naming
> the id), `fileName` non-empty, `sizeBytes` positive and at most **1 GiB**
> (`1073741824` bytes), `sha256` exactly 64 hex chars (case-insensitive, stored
> lowercased) — and opens an in-memory session with a staging directory under
> `<workspaces_root>/.attachment-upload-staging/<uploadId>/`, returning
> `{ uploadId, maxChunkBytes }` where `maxChunkBytes` is the **decoded** per-chunk
> cap (16 MiB — base64 inflates ~4/3 on the wire, keeping frames under the §1.3
> inbound cap). `chunk` writes each decoded slice to its own seq-numbered chunk
> file: retrying a seq **overwrites** the same file (idempotent; only the new
> bytes count against the declared total, so a retry never double-counts), chunks
> may arrive in any order, and empty data, over-cap slices, or totals exceeding
> `sizeBytes` are -32602 naming the numbers. `commit` requires the staged bytes to
> equal `sizeBytes` exactly with a gap-free seq range from 0 (`-32602` naming the
> received/expected bytes or the gapped seq list otherwise), reassembles and
> SHA-256-verifies the payload (mismatch → -32602 naming both digests), then
> delegates to the same collision-safe placement + attachment-registry path as
> `file.placeAttachment` — the commit result is **byte-shape-identical** to a
> successful `placeAttachment` result, including the v6.12 registry fields. A
> failed commit (checksum mismatch, incomplete staging, placement failure) leaves
> the session **alive** for retry-after-more-chunks or abort; a successful commit
> retires it and deletes the staging directory. `abort` is idempotent: it drops
> the session and staging dir, returning `{ uploadId, aborted }` with
> `aborted: false` for an unknown/already-settled id instead of erroring. While a
> commit is verifying/placing, concurrent `chunk`/`abort`/`commit` calls on the
> same uploadId are rejected (-32602 naming the in-flight commit) so nothing
> mutates the files being hashed. Sessions are **in-memory only**: a daemon
> restart drops them (the client simply restarts the upload; an unknown uploadId
> is -32602 "no attachment upload in progress"), orphaned staging dirs are swept
> lazily by the next `begin`, and nothing is visible — no placed file, no
> registry row — until commit succeeds. Placement failures are logged at WARN in
> the daemon (monorepo#2144); caller errors are always coded -32602 with a
> reason, never a bare Internal error.

> **Session bounds — per-workspace cap + idle TTL
> ([monorepo#2275](https://github.com/intent-hq/monorepo/issues/2275);
> [intent-hq/intentd#1217](https://github.com/intent-hq/intentd/pull/1217)).**
> Upload sessions are bounded two ways. **Cap:** a workspace may hold at most
> **4** live sessions; a `begin` at the cap is -32602 — `workspace <id> already
> has N attachment uploads in progress (max 4) — commit or abort one before
> beginning another`. The expired-session drain, the per-workspace count, and the
> new session's insertion happen under one registry lock hold, so concurrent
> begins serialize and cannot overshoot the cap. **Idle TTL:** a session with no
> begin/chunk/commit activity for **15 minutes** expires lazily, mirroring the
> orphaned-staging sweep — the next `begin` (any workspace) drains expired
> sessions and reclaims their staging dirs (outside the lock; expired sessions
> never hold cap slots), while a late `chunk`/`commit` on an expired id gets
> -32602 — `attachment upload <id> expired after Ns of inactivity — begin a new
> upload`. Each successful `begin`/`chunk` refreshes the idle clock; a session is
> **never expired while a commit is in flight**, and a *failed* commit (checksum
> mismatch, incomplete staging) refreshes the clock, so the documented
> retry-after-more-chunks window is a fresh 15 minutes even when the commit
> itself outlived the TTL. **Pipelined-race errors:** a commit that catches a
> reserved-but-unwritten or partially-written chunk (a `chunk` call still in
> flight when `commit` fires) is a caller-sequencing error, not a daemon fault —
> both guises are -32602 with retry advice (`chunk N is still being written —
> wait for the chunk call to return, then retry the commit` / `assembled
> attachment is N bytes, expected M — a chunk may still be being written; …`).
> The reserved-but-unwritten guise is a reclassification (formerly -32603
> Internal); the partially-written guise was already -32602 and gains the retry
> advice. Either way the session stays alive and the retry succeeds once the
> chunk lands.

**File-explorer & metadata reads.** Three further methods: `file.tree` — a file-explorer read returning the entries directly under the given path as a **bare array**; and `file.exists` / `file.stat` — the existence probe and metadata read. The FE anchors the explorer at the workspace root and lazy-lists children via the existing `file.list`. All three share the within-workspace containment guard with the other `file.*` ops.

| Method | Params | Result |
| --- | --- | --- |
| file.tree | path? (default .) | [{ path, name, isDirectory }] — bare array; paths outside the workspace rejected |
| file.exists | path (req) | { exists, isFile, isDirectory } |
| file.stat | path (req) | { size, mtime, isFile, isDirectory, isSymlink, permissions } |

> **`browser.exec` — client-callable trigger + FE-served reverse RPC.**
> `browser.exec` is a **client-callable trigger** whose real work happens on the connected
> frontend (Chrome DevTools Protocol against embedded browser tabs — no CDP driver runs in
> the daemon). Wire pattern mirrors `host.openInEditor` (§5.14): the FE binding calls
> `browser.exec` like any other method; the daemon validates the envelope, then dispatches
> an FE-served reverse RPC (`browser.exec`, `id: "rev-<n>"`) so the CDP work resolves on the
> user's machine. `actions` must be a **non-empty array** (`-32602` otherwise); the FE's
> raw `{ success, results, error? }` envelope is reshaped for the caller — a single-action
> batch yields the action's `{ action, success, result?, error? }` envelope, a multi-action
> batch yields `{ results: [...] }` (parity with the FE `browser_exec` MCP tool).
> A closed reverse channel ("no frontend connected"), a reverse-RPC timeout, and an
> FE-reported failure envelope all surface as `-32603` carrying the underlying context.
> The FE-served reverse-RPC pattern keeps the daemon a thin proxy and the
> CDP surface an FE concern.
>
> **Agent-initiated `browser.exec` — first-client-sticky reverse dispatch (REV-1,
> interim).** When `browser.exec` is triggered by an *agent* (via the MCP
> `ws.browser.exec` binding, §6.8) rather than by a client connection, there is no
> ambient reverse channel to reuse: the caller is the daemon-hosted MCP server, not a
> client-facing socket. The daemon therefore routes the reverse RPC to the
> **first-connected live client**; if that client disconnects, the next-connected client
> takes over — failover follows connection arrival order (UDS + WSS clients share the same
> registry). When no client is connected at all the call fails fast with `-32603` and
> `browser.exec: no client connected` so the agent surfaces the same class of failure a
> closed channel already produces. This is a deliberate stopgap ahead of an explicit
> target-selection surface (§5.17 client identity): "sticky first" needs no wire
> change and is trivially observable, but it does not distinguish overlapping clients.
> Client-triggered `browser.exec` is **unchanged**: it still reverse-dispatches on the
> caller's own connection.
>
> **Loopback-hostname interpretation — FE-side, wire shape unchanged (monorepo#2323).**
> URL hostnames in `navigate` / `openTab` action URLs are interpreted **on the frontend
> that serves the reverse RPC**, per the reserved-hostname convention (RFC 6761
> `*.localhost` names): `daemon.localhost` targets the **daemon machine** (rewritten to
> `127.0.0.1` on a local daemon, to the daemon host — the sanitized transport target —
> on a remote one); `client.localhost` targets the **client (user's) machine** (always
> rewritten to `127.0.0.1`); **bare loopback** (`127.0.0.1` / `localhost` / `[::1]`) is
> ambiguous and defaults to the agent's frame of reference — the daemon: unchanged on a
> local daemon, rewritten to the daemon host on a remote one. (Degenerate case: when
> the remote daemon host cannot be determined from the transport state, daemon-targeting
> URLs are left unchanged — non-rewritten, no echo fields.) The daemon remains a
> **thin proxy**: no rewrite happens daemon-side and the `browser.exec` request /
> reverse-RPC wire shape is unchanged — the convention is entirely FE-served. Rewritten
> actions echo **additive fields** in their result payload: `requestedUrl` (the URL as
> requested), `finalUrl` (the URL actually loaded), `rewritten: true`, and a
> human-readable `reason`; ambiguous bare-loopback rewrites additionally carry a
> `warning` naming the explicit `daemon.localhost` / `client.localhost` forms.
> Non-rewritten URLs keep a byte-identical result shape (no echo fields). Only the
> hostname is rewritten (scheme, port, path, query, and hash are preserved), and only
> top-level `navigate` / `openTab` URLs are interpreted — never URLs inside pages
> (redirects, fetches, links).
>
> **`browser.docs` — not exposed.** The `browser_docs` MCP tool that
> served static reference docs on-demand has no consumer in the daemon surface (skills-style
> docs stay in the FE MCP layer) and is deferred, not cancelled: revisit
> only if a future FE feature needs BE-owned browser docs. The `terminal.*` and `file.*`
> methods above are **unaffected**.

> **Interactive terminals.** `terminal.list` / `terminal.readOutput` above are the
> read-only methods. The daemon also serves interactive
> `terminal.create` / `write` / `resize` / `kill` / `getBuffer` (base64 framing) — see §5.13.
> PTYs carry an optional daemon-assigned display name (set at spawn; not a
> `terminal.create` parameter) that `terminal.list` surfaces as `name` (on each
> `terminals[]` entry of the v4.0 envelope) with a `"Terminal"` fallback — see the
> `terminal.list` row above.

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
| event.query | workspaceId (req), filter opts (eventType?, actorType?, actorId?, path?, minutesAgo?, limit?), paginate?: boolean, nextToken?: string | matching events — **legacy shape** (bare array, newest→oldest) when pagination is not engaged; **paginated envelope** `{ items, nextToken }` when either `paginate: true` or a `nextToken` is supplied (opt-in). `nextToken` is an opaque cursor for the next older page (`null` on the last page); pass it back as `nextToken` to fetch the next page. `limit` is clamped by the pagination policy when engaged. `eventType` accepts the **same glob syntax as `event.subscribe`** ([intentd#938](https://github.com/intent-hq/intentd/pull/938)): bare `*` = no type filter, `prefix:*` = category prefix match (e.g. `note:*` matches `note:created` / `note:updated` / `note:deleted`), anything else = exact match; matching is **case-sensitive** (`NOTE:*` matches nothing), mirroring subscribe's `starts_with` semantics — a `prefix:*` compiles to an index-served half-open range scan, not a `LIKE`, so `%` / `_` in a pattern are literal bytes. |
| event.subscribe (deprecated) | eventTypes (req, array), excludeSelf?, batchWindow? | service result `{ subscriptionId, eventTypes }` — use events.subscribe for WS streaming. Shares the one real subscription implementation with the `agent.subscribe` alias of §5.5 (matching, batching, subscriber wakes, restart persistence) — **including the [monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229) agent-subscriber restriction** (explicit `agent:`-prefixed types and `chat:stream:delta` rejected atomically with `-32602`; bare `*` silently narrowed to the non-agent categories; match-time `exclude_agent_events` guard on rehydrated legacy rows — see the §5.5 row); over the MCP seam the subscriber is the calling agent, so `ws.event.subscribe` callers are directed to `ws.agent.watch(agentId)` for agent monitoring. Note: the singular `event.subscribe` / `event.unsubscribe` methods are NOT routable on the wire (MCP bindings only) — wire callers use the `agent.subscribe` alias. |
| event.unsubscribe (deprecated) | subscriptionId (req) | service result `{ ok: true, subscriptionId }` — stops delivery; unknown id errors |

### 5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*`

| Method | Params | Result |
| --- | --- | --- |
| crossWorkspace.listSiblings | workspaceId (req) | sibling workspaces sharing the same git repository (the workspace's own repo) |
| crossWorkspace.readNote | targetWorkspaceId (req), noteId (req) | note from a sibling workspace |
| crossWorkspace.listNotes | targetWorkspaceId (req) | notes in a sibling workspace |
| primitive.addReference | noteId (req), semanticId (req), description (req), snapshot? | { ok, primitiveId, noteId } |
| primitive.addCli | noteId (req), command (req), description (req), workingDirectory? | { ok, primitiveId, noteId } |
| primitive.addPatch | noteId (req), filePath (req), diff (req), description (req) | { ok, primitiveId, noteId } |
| primitive.addAgentAction | noteId (req), agentId (req), goal (req), description (req) | { ok, primitiveId, noteId } |
| specialist.list | provider? — no workspaceId | { specialists: SpecialistDef[] } (user files override bundled) — each entry may carry the additive `resolvedModel`/`resolvedProvider` preview fields (below); unknown `provider` → -32602 |
| specialist.get | id (req), workspacePath?, provider? | { specialist: SpecialistDef } — resolved view, with the `resolvedModel`/`resolvedProvider` preview fields when applicable; -32602 if not found; unknown `provider` → -32602 |
| specialist.create | id (req), spec (req): SpecialistDef, scope?: "project"\|"user" (default "user") | { specialist: SpecialistDef } |
| specialist.edit | id (req), spec (req): SpecialistDef, scope (req): "project"\|"user" | { specialist: SpecialistDef } |
| specialist.delete | id (req), scope (req): "project"\|"user", workspacePath? | { success: true } — `bundled` definitions are read-only |
| repo.list | — (no workspaceId) | { repos: [...] } |
| repo.remove | path (req) — no workspaceId | { removed: bool } — deletes one known-repo registry entry; `false` when the path was not registered (not an error) |
| repo.warmCache *(v6.10)* | githubUrl (req) — no workspaceId | { started: true, owner, repo } — opportunistic **background** refresh of the daemon-managed repo cache (`.repo-cache/<owner>/<repo>`; [intent-hq/intentd#1105](https://github.com/intent-hq/intentd/pull/1105)): the RPC returns immediately while the fetch (the same `ensure_cached_repo` pipeline `workspace.create` hydrates from — fetch + prune + hard reset + recursive submodule sync, self-healing by re-clone; token resolution matching `workspace.create`) runs as a detached task. Deliberately **silent**: no `git:clone:*` frames and no events are emitted — the outcome is only logged daemon-side. **Global single-flight (never queued):** at most one opportunistic warm runs daemon-wide; a second call while one is in flight is rejected with `-32603` (`"repo cache warm already in flight for <owner>/<repo>"`) carrying machine-readable `error.data = { code: "warm-in-flight", owner, repo }` naming the repo currently being warmed, so clients key off `error.data.code` instead of prose. A missing/non-string `githubUrl`, a URL with no owner/repo pair, or an invalid owner/repo path segment (empty, `.`/`..`, leading `-`, separators) is `-32602` and never claims the single-flight slot, so a malformed URL can never block valid warms. **Never blocks `workspace.create`:** the create path is not gated by the in-flight flag — its cache ensure simply serializes behind an in-flight warm for the same repo on the existing per-repo cache lock |

```json
// → request — `provider` is the optional resolution context for the preview fields
{ "jsonrpc":"2.0","id":50,"method":"specialist.list","params":{ "provider":"codex" } }
// ← response — resolvedModel/resolvedProvider omitted when the provider CLI default applies
{ "jsonrpc":"2.0","id":50,"result":{ "specialists": [
  { "id":"implementor","name":"Implementor","description":"...","source":"bundled",
    "reasoningEffort":"high",
    "resolvedModel":"gpt-5.3-codex","resolvedProvider":"codex" } ] } }
```

**`specialist.*` full CRUD.** Beyond `specialist.list`, the namespace carries
`get` / `create` / `edit` / `delete`. Definitions resolve in **3 tiers** — **project**
(`.intent/specialists/`) overrides **user** (`~/.intent/specialists/`) overrides **bundled** — and
`scope` selects which tier a write targets (`bundled` is read-only). `list`/`get` return the
resolved view; `create`/`edit` take a full `spec` body. Malformed params → `-32602`; deleting a
non-existent or `bundled` definition → `-32602`.

- **SpecialistDef** — `{ id, name, description, codingAgent?, model?, reasoningEffort?,
  roleReminder?, agentType?, prompt?, hidden?: boolean,
  modelOptions?: [{ model, hint, reasoningEffort? }],
  source: "project"|"user"|"bundled", path?, resolvedModel?, resolvedProvider? }`. The optional
  scalars (`codingAgent`, `model`, `reasoningEffort`, `roleReminder`, `agentType`) are
  first-class **string** fields on the wire, not
  frontmatter-only: `list`/`get` emit each one when its resolved value is non-empty, and
  `create`/`edit` accept them in `spec` (they are written to the file's frontmatter). On
  `list`/`get`, `source` is the **winning** tier and `path?` the file it resolved from (omitted
  for `bundled`); on `create`/`edit` the body carries the authored fields and `scope` chooses the
  target tier.
- **`modelTier` is retired** (tolerated-and-ignored, like the retired
  `model.workspaceOverrides` setting in §5.12): a `modelTier` in a `create`/`edit` `spec` or
  in an existing file's frontmatter never errors, but the key is stripped on parse — never
  echoed by `list`/`get`, never written by `create`/`edit` (an existing frontmatter line is
  dropped on the file's next rewrite) — and never participates in model resolution (§5.5).
- **`resolvedModel?` / `resolvedProvider?` (additive preview, [intent-hq/intentd#852](https://github.com/intent-hq/intentd/pull/852))** —
  on `list`/`get` only, the daemon decorates each definition with the model a **no-model
  `agent.create`** for that specialist would actually pin, computed by the same daemon-side
  resolver as agent creation (§5.5 "Creation-time default-model resolution", steps 2–4 — a
  preview has no client-picked model, so step 1 never applies). The optional `provider`
  request param supplies the resolution context: absent/empty defaults to the
  settings-derived default provider (provider of `model.default`, else `providers.active`,
  else the first registered provider — [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922));
  an unknown id is rejected with `-32602` (`unknown provider: <p>`) on both
  methods. **Both fields are omitted** (never `null`) when resolution falls to the provider
  CLI default — clients render "Provider default". A specialist with no model config
  previews the user's `model.providerDefaults` / `model.default` settings chain (the
  quick-action model settings never participate,
  [intent-hq/monorepo#1729](https://github.com/intent-hq/monorepo/issues/1729)). Over the WSS router, `specialist.list` resolves with no
  project tier (no `workspacePath` param, matching its live wire signature); `specialist.get`
  passes its `workspacePath?` through to the resolver.
- **`hidden?`** — optional boolean sourced from `hidden:` in the specialist file's
  frontmatter and **inherited across tiers**: a definition resolves `hidden: true` when any
  lower tier (down to the embedded bundled floor) sets `hidden: true`, unless a higher tier
  **explicitly** sets `hidden: false` — a file that omits the key inherits the lower tiers'
  effective value. Emitted on `list`/`get` only when the resolved value is true (absent ⇒ not
  hidden). On `create`/`edit` an explicit `hidden: true`/`false` is written verbatim and an
  omitted `hidden` writes no key (the resolved value then inherits); explicit `hidden: false`
  in a user/project file is the opt-out that unhides.
  Hidden specialists stay in `list`/`get` results — clients filter them out of
  specialist pickers while keeping them visible on editing surfaces (e.g. Settings → AI
  Behavior). The bundled `chief-of-staff` is flagged hidden.
- **Config scalars (`codingAgent` / `model` / `reasoningEffort` / `agentType`)** — the four
  optional config frontmatter scalars follow the same **inherit-on-omit** fold as `hidden`, each key
  independently, across the tiers (embedded bundled floor → bundled dir → user → project): a
  file that omits the key inherits the lower tiers' effective value, and an explicit non-empty
  value in a higher tier overrides it. An explicit **empty string** (`""`) clears the inherited
  value — the string analogue of `hidden: false` — and `create`/`edit` write `key: ""` verbatim
  so the explicit clear round-trips losslessly. A bare `key:` with no value (YAML `null`) is
  parsed as an explicit empty string — the frontmatter parser takes the trimmed text after the
  colon — so it **clears** exactly like `key: ""` (it is neither an omit nor an error).
  `roleReminder` intentionally stays
  **winner-takes-all** (not inherited): it is coupled to the prompt body (itself
  winner-takes-all), so the derive-from-body fallback remains correct when a higher tier
  rewrites the body.
  `reasoningEffort` is the specialist's default reasoning level (§5.5) — stored as-is, no
  vocabulary validation at this seam; it is the frontmatter rung of the delegation
  reasoning-effort resolution below.
- **`modelOptions?` (additive, [intent-hq/intentd#900](https://github.com/intent-hq/intentd/pull/900) /
  [intent-hq/intentd#908](https://github.com/intent-hq/intentd/pull/908))** — the ordered list of **delegation
  model options** a specialist's author suggests: `[{ model, hint, reasoningEffort? }]` entries where `model` is
  the model id to pass on delegation — typically an internal compound id (e.g.
  `opencode:kimi-k3`); validation requires only a non-empty string — and `hint` is the author's
  free-text guidance for choosing that option (`""` when none was given). Carried additively on
  `specialist.get`/`list`/`create`/`edit` — emitted when the resolved list is non-empty, omitted
  otherwise (never `null`/`[]` on the wire) — and accepted in `create`/`edit` `spec` bodies. In
  the file it is a frontmatter scalar encoded as a **single-line JSON array**
  (`modelOptions: [{"model":"opencode:kimi-k3","hint":"cheap"}]`) so it fits the line-based
  frontmatter parser and round-trips parse→write→parse losslessly. Resolution follows the same
  3-tier **inherit-on-omit** fold as the config scalars above, with **`[]` as the explicit
  clear** (the array analogue of `key: ""`): an omitted key inherits the lower tiers' effective
  list, an explicit `[]` clears it, and a non-empty list overrides **wholesale** — entries never
  merge across tiers. Reads are **lenient** (files are never rejected): an unparseable scalar or
  a non-array is treated as an omitted key (inherits), and unusable entries — non-objects, or no
  non-empty string `model` — are skipped individually (a non-string `hint` alone does not make
  an entry unusable on read — it is coerced to `""`); only a **literal `[]`** clears — a
  non-empty array whose entries are ALL unusable is treated as omitted (falls through to
  inheritance), so one bad hand-authored entry never silently drops an inherited list. Writes
  are **strict**: `create`/`edit` validate the `spec` value before writing — it must be a JSON
  array of objects, each with a non-empty string `model`; `hint` must be a string when present
  (defaults to `""`), and `reasoningEffort` must be a string when present — and any invalid
  shape → `-32602` with nothing written. An entry's optional `reasoningEffort` is the effort
  level that option implies; it is carried only when non-empty (omitted otherwise) and is
  rendered in the injected docs block as `effort: <level>` inside the option's parenthetical.
  The list adds
  **no resolver step** (§5.5 "Creation-time default-model resolution"): it is advisory — the
  daemon injects each visible specialist's options into the delegating agent's `workspace_api`
  tool description (the `ws.agent.delegate` docs), and the delegating agent passes its pick as
  the explicit `model` param (resolution step 1).
- **Delegation reasoning-effort resolution (additive)** — `agent.delegate` and
  `agent.wakeOrCreate`'s create branch resolve the child's `reasoningEffort` (§5.5) in this
  order: (1) the caller's explicit `reasoningEffort` param — an empty/whitespace-only value is
  an explicit clear and does **not** fall through; (2) the `reasoningEffort` of the chosen
  specialist model option whose `model` matches the resolved model; (3) the specialist's
  `reasoningEffort` frontmatter scalar; (4) the settings `model.defaultReasoningEffort`
  (§5.12), applied only when the session's model itself resolved from the settings chain;
  (5) unset. The resolved level is then **validated
  against cached-catalog evidence**: when the resolved model has a non-empty `effortLevels`
  list in the daemon's cached model catalog (§5.30 — read-only, never a live probe), a level
  outside that list is rejected with `-32602` naming the valid values, before any side effect
  (no child session is created). Matching is case-insensitive and the caller's spelling is
  what persists. With **no evidence** — no resolved model, no cached row, or a row that
  declares no `effortLevels` — the value passes through unvalidated, mirroring the
  bare-model ownership guard's "absence of evidence is not a mismatch" rule (§5.5). The
  settings rung (4) is the one exception to the rejection: a level the resolved model provably
  does not support is **dropped with a daemon warn log** rather than rejected — only
  caller-supplied and specialist-derived levels raise `-32602`.
  `agent.create` walks the **same chain** against its own resolved model (§5.5
  "Creation-time reasoning-effort resolution"): its `reasoningEffort` param is step (1), a
  `specialistId` it names supplies steps (2)–(3), and the settings default is step (4) — the
  delegate / wakeOrCreate seams simply pre-resolve (2)–(3) and hand the result down as the
  param, so the rungs are resolved exactly once.
- The daemon watches the user (`~/.intent/specialists/`) and project
  (`<workspace>/.intent/specialists/`) tiers (using `notify` watchers, the same infrastructure as
  workspace `file:changed` events); when a specialist file is created/modified/deleted under a
  watched tier, the daemon re-resolves the specialist set for the affected workspace(s) (user-tier
  changes affect all open workspaces; project-tier changes are workspace-scoped), compares the
  newly-resolved set against the cached specialist set, and emits `specialists:changed` (§6.5) only
  if the resolved set actually changed (500ms debounce per workspace). The bundled tier (including
  its compile-time embedded floor) is static and unwatched. Clients should re-fetch via
  `specialist.list` on the event to refresh the specialist roster.

```json
// → request — author a project-scoped specialist
{ "jsonrpc":"2.0","id":51,"method":"specialist.create",
  "params":{ "id":"reviewer","scope":"project",
    "spec":{ "id":"reviewer","name":"Reviewer","description":"Reviews diffs",
      "model":"opus4.5","prompt":"You review code changes…" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "specialist":{
  "id":"reviewer","name":"Reviewer","description":"Reviews diffs","model":"opus4.5",
  "source":"project","path":".intent/specialists/reviewer.md" } } }
```

### 5.12 `settings.*`

> The daemon owns the settings that affect server-side behavior and lets thin clients read/mutate them over the wire. These methods are global — like specialist.list / repo.list they do not require workspaceId (§3.6).

| Method | Params | Result |
| --- | --- | --- |
| settings.list | — | { settings: SettingDefinitionWithValue[] } (sensitive values redacted; TOML-backed entries carry `origin`) |
| settings.get | path (req) | { path, value, definition, origin? } — -32602 if path is unknown |
| settings.update | changes (req, array of { path, value, reason? }) | { applied: [{ path, value }] }; triggers settings:changed |
| settings.reset | path (req) | { path, value } (restores defaultValue) — -32602 if path is unknown |

`SettingDefinition`** shape:**

```ts
interface SettingDefinition {
  path: string;            // dotted key, e.g. "server.port" or "sourceControl.github.token"
  label: string;          // human-readable name
  description: string;    // help text
  category: string;       // grouping, e.g. "server", "sourceControl", "providers"
  type: "boolean" | "number" | "string" | "enum" | "object";
  enumValues?: string[];  // present when type === "enum"
  min?: number;           // numeric bound (type === "number")
  max?: number;           // numeric bound (type === "number")
  defaultValue?: unknown; // value used by settings.reset
  sensitive?: boolean;    // when true, value is redacted in settings.list / settings.get
}
// SettingDefinitionWithValue = SettingDefinition & { value: unknown }  // current value (redacted if sensitive)
```

`changes` entries use the `AppSettingChange` shape `{ path, value, reason? }` (`reason` is an optional free-text audit note). `settings.update` **validates** each change against its definition (type / enum / min / max) and **persists** atomically; an unknown `path` or a value failing validation yields `-32602` and the whole batch is rejected (nothing applied). On success it emits a `settings:changed` notification (§6.5) carrying the applied `{ path, value }` pairs (sensitive values redacted).

**Storage & the `origin` field.** Non-secret human-editable settings are **TOML-backed**: they
persist in `<data_dir>/config.toml`, layered `defaults < config.toml < startup flags/env`.
For TOML-backed paths, `settings.get` (and each `settings.list`
entry) carries an additive `origin` field naming the layer the effective value came from:
`"default"` (absent from the file), `"file"` (explicit in config.toml), or `"flag"` (pinned at
boot by a startup flag / env var, e.g. `--insecure`, `INTENTD_TCP_PORT`). Secrets and the opaque
machine-state blobs (`repos.known`, `workspace.changeHistory`, `workspaceInitializer.state`,
`hardwareConsole.state`, `permissions.rules`, `userRules` / `workspaceRules`,
`endUserRules`, `voice.vocabulary`) have **no** `origin` — they never live in config.toml
(secrets stay in `secrets.json`, state blobs stay in SQLite).
`settings.update` on a TOML-backed key rewrites config.toml atomically (temp file + rename,
comment/layout-preserving); external hand-edits of config.toml are live-reloaded (strict
re-parse, debounced; invalid content keeps last-good values) and emit the same
`settings:changed` notification. A key pinned by a startup flag is **read-only over the wire**
while pinned: `settings.update` / `settings.reset` on it yields `-32602` with a message naming
the overriding flag ("overridden by startup flag …").

**BE-exposed setting paths.** Only settings that affect daemon behavior are exposed:

- **Providers / agents:** `providers.active`, `providers.enabled`, `providers.paths.{auggie,claude-code,codex,…}`,`model.default`, `model.providerDefaults`, `model.defaultReasoningEffort`, `quickActions.defaultModel`,`quickActions.typeOverrides`, `quickActions.providerSettings`, `specialists.default`. `model.defaultReasoningEffort` ([intent-hq/intentd#970](https://github.com/intent-hq/intentd/pull/970)) is an optional string persisted in `config.toml` under the `[model]` table as `defaultReasoningEffort` — the fallback reasoning effort for newly created agents, stored **as-is** (providers own the level vocabulary; the daemon never normalizes it) with a blank or whitespace-only value reading as unset (default: unset). It is the last rung of the creation-time reasoning-effort chain (§5.5 "Creation-time reasoning-effort resolution"), applying only when no explicit param / specialist model-option / specialist frontmatter effort decided the level **and** the session's model itself resolved from the settings chain; a level the resolved model's cached `effortLevels` provably does not list is dropped with a daemon warn log rather than rejected (§5.11). Agent model resolution walks `model.providerDefaults[provider]` → `model.default` (the settings-chain step of the daemon-side creation-time resolver, §5.5 — specialist frontmatter `model` takes precedence over this chain, and every result is provider-guarded). The `quickActions.*` keys ([intent-hq/monorepo#1729](https://github.com/intent-hq/monorepo/issues/1729)) scope **only** to single-shot quick actions (commit messages, PR descriptions, quick tasks) and are never consulted for an agent session, delegated ones included; they were named `backgroundAgents.*` before that rename, and the old paths are **retired** — gone from the catalog (`settings.list` never advertises them; `settings.get` / `settings.reset` yield `-32602`) but tolerated-and-ignored by `settings.update`, while a `config.toml` still carrying `[backgroundAgents]` has its values carried over once at boot — per member (`defaultModel` / `typeOverrides` / `providerSettings` are applied individually, so one malformed legacy value never discards its valid siblings), into each `quickActions.*` key still at its **schema default**, so an already-migrated or deliberately re-picked value is never clobbered, and a legacy member with no `quickActions.*` counterpart is dropped with a warning — before the legacy table is stripped. These two keys also derive the **effective default provider** ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)): the provider prefix of `model.default` when it is a compound id naming a registered provider, else `providers.active` (registry-validated, so a stale/mistyped value falls through), else no derived default — resolution bottoms out at the first registered provider (no provider carries a hardcoded default designation). The former `model.workspaceOverrides` key is **retired**: it is gone from the catalog (`settings.list` never advertises it; `settings.get` / `settings.reset` yield `-32602`), but `settings.update` **tolerates-and-ignores** the retired path for old clients — the entry is skipped (never validated, persisted, echoed in `applied`, or published in `settings:changed`) instead of rejecting the batch. Any stale SQLite row is deleted at boot, and a legacy `config.toml` key is still tolerated + stripped on boot with its value discarded.
- **Workspace / git:** `workspace.branchPrefix`, `workspace.worktreesLocation`,`workspace.sshKeyPath` *(string — filesystem path to the key, not key material; the real secret is the key file on disk, so the value is read back verbatim by the FE `git`-env consumer)*, `workspace.defaultShell`, `workspace.autoCommit`, `workspace.cowIsolation` *(boolean, default `false` — CoW workspaces + per-agent sandboxes: `workspace.create`/`workspace.duplicate` provision the checkout as a standalone CoW clone instead of a linked worktree (§5.1), and `agent.delegate` defaults `isolation` to `"cow"` when the param is omitted (§5.5); ignored by cache-hydrated creation and by `workspace.duplicate` of a standalone-checkout source, which are always standalone (§5.1); consulted only at provisioning time — the resulting `checkoutMode` is immutable per workspace (§5.1); requires CoW filesystem support on the workspaces root — the FE gates the toggle on `Workspace.cowSupported`)*.
- **MCP:** `mcp.enableUserServers`, `mcp.disabledServers`, `mcp.servers` *(sensitive)*.
- **Server / transport (new in intentd):** `server.socketPath`,`server.bindAddress`, `server.port` *(legacy port key — still exposed and validated, used in the `settings.*` examples below; the live WSS listener reads `server.wsApi.port`)*, `server.wsApi.enabled`, `server.wsApi.port`, `server.tls.enabled`, `server.auth.enabled`,`server.auth.token` *(sensitive; read-only / regenerate)*, `server.originAllowList`, `server.maxOutstandingRpcs` *(number, default `256`, min `0`, max `100000`, TOML-backed under `[server]` — the daemon-wide cap on outstanding slow-path RPCs shared across every connection and both transports; over-limit requests are rejected with `-32011` "Server overloaded" (§9) and `0` disables the cap. Read once at boot: a change applies on daemon restart)*. The UDS listener always serves; the TCP/WSS listener is toggled at runtime by `server.wsApi.enabled` (the former `server.listenMode` key is retired — a config.toml still carrying it boots, is discarded, and is stripped from the file).
- **Source control (new in intentd, provider-agnostic):** `sourceControl.activeProvider` (enum,**default **`github`; v1 ships only `github`), `sourceControl.github.tokenSource`(`auto`|`env`|`gh-cli`|`explicit`; default `auto` — secrets store → env → `gh` CLI), `sourceControl.github.token` *(sensitive)*,`sourceControl.github.apiBaseUrl` (GitHub Enterprise support), `sourceControl.github.exposeGitCredentialToChildren` *(boolean, default `true` — inject the daemon-managed GitHub credential into child process environments (PTY terminals, agent provider shells) as a scoped github.com-only credential helper; never as a raw `GITHUB_TOKEN`/`GH_TOKEN`)*. Per-provider config is namespaced as`sourceControl.<provider>.*` so future hosts slot in as `sourceControl.gitlab.*`,`sourceControl.bitbucket.*`, etc. (replaces any flat `github.*` keys).
- **Linear (new in intentd):** `linear.token` *(sensitive)* — the Linear API key, persisted to the daemon's file-backed secret store (`~/intent/secrets.json`, `0600`) under account `linear.token`, the exact entry the `linear.*` namespace's secret-store-first `auto` token resolution reads (§5.28), so `settings.update` on this path is the FE "connect Linear" flow.
- **Sentry account (new in intentd):** `accounts.sentry.token` *(sensitive)* — the Sentry API tokenused by the `sentry.*` namespace (§5.29); `accounts.sentry.organization` *(string)* — the Sentryorganization slug (non-secret companion).
- **Voice (new in intentd):** `voice.provider` (enum: `elevenlabs` | `openai`, default `elevenlabs`) — the transcription provider `voice.transcribe` uses when the call carries no per-call `provider` override (§5.41); `voice.language` *(string, optional — no default)* — the default transcription language hint (ISO-639-1 code, e.g. `"en"`) applied when a `voice.transcribe` call carries no per-call `language` (or a blank one — per-call values are trimmed and blank behaves like omitted; §5.41 "Language resolution"; TOML-backed under the `[voice]` section of config.toml, like `voice.provider`; unset or blank means provider auto-detection); `voice.openai.model` (enum: `gpt-4o-transcribe` | `gpt-4o-mini-transcribe` | `whisper-1`, default `gpt-4o-transcribe`) — the transcription model the OpenAI provider posts (§5.41 "Providers"; TOML-backed under the `[voice]` section of config.toml, like `voice.provider`); `voice.vocabulary` *(object, non-sensitive — a JSON string array; default = `["Intent"]`, see §5.41 "Context mapping")* — the user-editable vocabulary biased into every `voice.transcribe` call, read per call and merged ahead of `context.keyterms` (§5.41; SQLite-backed like the other opaque bags — no `origin`; a stored value exactly matching the retired 17-term seed default is deleted on daemon start so the new default applies — user-modified lists are never touched); `voice.workspaceVocabulary.maxTerms` *(number, default `50`, min `0`, max `100`; v5.1)* — the cap on the auto-derived workspace vocabulary injected into `voice.transcribe` calls carrying a `workspaceId` and served by `voice.getWorkspaceVocabulary` (§5.41 "Workspace vocabulary"; TOML-backed under the `[voice]` section of config.toml, like `voice.provider`; `0` disables workspace vocabulary entirely — no derivation, no injection; a change takes effect on the next derivation); `voice.elevenlabs.apiKey` *(sensitive)* and `voice.openai.apiKey` *(sensitive)* — the provider API keys, persisted to the daemon's file-backed secret store (`~/intent/secrets.json`, `0600`) like `linear.token`. Key resolution is secret store first, then the `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` environment variable fallback; the keys are never logged, echoed, or returned over the wire (redacted in `settings.list` / `settings.get` like every sensitive path).
- **Persisted policy & rules (new in intentd):** `permissions.rules` *(object)* — persisted commandallow/deny/ask entries; `userRules` *(object)* — global user prompt-rule content;`workspaceRules` *(object)* — workspace-scoped prompt-rule content. Each is an opaque bagvalidated by shape only; downstream consumers own the internal schema.
- **Cross-workspace repos & history (new in intentd):** `repos.known` *(object)* — the daemon-owned known-repository list; `workspace.changeHistory` *(object)* — per-workspace diff-history bags. Both are non-sensitive; the daemon persists the JSON opaquely.
- **Workspace initializer (new in intentd):** `workspaceInitializer.state` *(object, non-sensitive, default `{}`)* — persisted home-screen workspace-initializer form state, opaque bag owned by the FE.
- **Hardware console (new in intentd):** `hardwareConsole.state` *(object, non-sensitive, default `{}`)* — persisted hardware-console device configuration (key assignments, action mappings, prompt-picker limit), opaque bag owned by the FE.
- **Context engine (new in intentd):** `context.enabled`, `context.auggiePath`, `context.allowIndexing`.
- **Storage / runtime (new in intentd):** `storage.dataDir`, `workspaces.root`, `logging.level`,`agents.maxConcurrent`, `agents.maxConcurrentAdapters` *(number, default `6`, min `1`, max `64`, TOML-backed under `[agents]` — the daemon-wide cap on concurrently live ephemeral ACP adapters: the one-shot `agent.completeOnce` completions (§5.32) and model probes (§5.30) that spawn a provider-CLI chain without holding an `agents.maxConcurrent` slot. Over-limit calls queue instead of spawning and are rejected with `-32603` `adapter-busy` (§9) if their own `timeoutMs` expires while queued. Deliberately **no `0` = unlimited** escape hatch, unlike `server.maxOutstandingRpcs` — an unbounded adapter spawn is the failure this bound fixes, and an out-of-range value is rejected rather than booting uncapped. Read once at boot: a change applies on daemon restart)*, `agents.idleReapMinutes`, `agents.flushQueuedMessages` *(enum `"all" | "systemOnly" | "off"`, default `"all"` — controls how the queue drain batches ready-to-send queued messages into a combined provider turn when an agent goes idle; §5.5 "Queued-message flush". `"all"`: batch every ready entry into ONE combined turn. `"systemOnly"`: batch ALL ready system-origin entries (anywhere in the queue, relative order preserved) into ONE combined turn while user-origin entries still deliver individually, FIFO. `"off"`: the legacy one-message-per-turn drain. Read at drain time, so a `settings.update` takes effect on the next drain. `settings.update` validates the `value` as one of the three strings and rejects a boolean with `-32602`; the legacy boolean shape (`true` → `"all"`, `false` → `"off"`) is accepted only when parsing an existing on-disk `config.toml` from an older daemon, not over `settings.update`)*.
- **Notifications:** `notifications.enabled`, `notifications.soundEnabled`, `notifications.soundOnlyWhenUnfocused`, `notifications.volume` (0..=1). The four `notifications.*` keys are daemon-owned; every entry is non-secret and reset-able via `settings.reset`.
- **Workspace API tool output (new in intentd):** `workspaceApi.maxOutputChars` *(number, default `100000`; `0` = unlimited, otherwise `1000..=10000000` — a non-zero value below 1000 rejects with `-32602`)*, `workspaceApi.toonOutput` *(boolean, default `true`)*. TOML-backed under a `[workspaceApi]` config.toml section; they shape the plain success body of the agent-facing MCP `workspace_api` tool — the oversized-output redirect and TOON encoding described in §5.22.
- **Tools:** `rtk.enabled` *(boolean, default `false`)* — enables RTK compressed CLI output mode in agent prompts. When true and the `rtk` binary is detected on the daemon host's PATH, the system-prompt assembly pipeline injects an instruction layer listing RTK-compatible subcommands (filtered exclusion set). The daemon caches detection per run and never blocks prompt assembly; any failure treats `rtk` as unavailable. The flag is opt-in (default off) and gated behind binary availability, so disabling or removing `rtk` restores the original prompt behavior.
- **Agent features (new in intentd):** `agentFeatures.backgroundHooks`, `agentFeatures.hostExec`, `agentFeatures.scripts`, `agentFeatures.terminalAccess`, `agentFeatures.browserAutomation`, `agentFeatures.richChatBlocks`, `agentFeatures.structuredQuestions`, `agentFeatures.attentionRequests`, `agentFeatures.stateSnapshot`, `agentFeatures.prMonitor` *(v6.1)*, `agentFeatures.taskGraph` — eleven booleans, TOML-backed under an `[agentFeatures]` config.toml section. The first ten default `true`; `taskGraph` is opt-in and defaults `false`. Per-feature toggles for what agents see and may call: background hooks (`ws.hook.*`), one-shot host command execution (`ws.host.exec`), saved scripts (`ws.script.*`), terminal read access (`ws.terminal.*`), browser automation (`ws.browser.*`), rich chat block prompt guidance (mermaid / ws-block / nav-link), structured questions (`ws.app.question.ask` — additionally **top-level-only** regardless of this toggle: a sub-agent bridge prunes/denies the binding with the §7 top-level-only redirect error, never the settings error; [intent-hq/intentd#1063](https://github.com/intent-hq/intentd/pull/1063)), attention requests (`ws.agent.reportBlocker` / `ws.agent.requestDiscussion` — `ws.agent.reportToParent` and the rest of `ws.agent.*` stay un-gated), the per-turn agent state snapshot injection (the `current ws.agent.snapshot() => {…}` prompt prefix; §5.5 "Per-turn agent state snapshot"), and centralized PR monitoring (`ws.pr.monitor` / `ws.pr.unmonitor` / `ws.pr.monitors`, §5.42 — `ws.pr.snapshot` stays un-gated, and turning the toggle off also scrubs the "prefer `ws.pr.monitor`" cross-references from the `ws.hook.schedule` and `ws.pr.snapshot` doc entries). `taskGraph` is the opt-in setting for task-graph delegation prompt and tool-description guidance; it does not deny dispatch of task-graph parameters. Unblocked-wake teaching uses the `taskGraph` value captured when the parent agent session is created, not the effective setting at wake delivery, so flipping the toggle never changes an existing session's wakes. Toggles are captured at agent-session creation (system prompt) and at per-agent MCP bridge creation (tool surface) — never live-read per call — so a change applies to **new sessions only** unless noted otherwise below; existing sessions keep the surface they were created with. One deliberate exception: `hook.schedule` also checks `agentFeatures.backgroundHooks` live in the services layer, so flipping it off denies **new** hook schedules immediately from all sessions (including pre-flip ones that still advertise `ws.hook.*`); already-active hooks are unaffected and run to their terminal state/TTL. `agentFeatures.stateSnapshot` follows the same captured-at-creation rule as the other toggles ([intentd#1273](https://github.com/intent-hq/intentd/pull/1273)) — it gates the prompt injection only, and the `ws.agent.snapshot()` MCP tool is never gated and stays callable either way.
- **PR monitor (v6.1):** `prMonitor.debounceSeconds` *(number, default `60`, minimum `10`)* — the quiet window a changed PR must observe before its consolidated wake is delivered — and `prMonitor.pollSeconds` *(number, default `30`, minimum `10`)* — how often the centralized loop polls each monitored PR (§5.42). TOML-backed under a `[prMonitor]` config.toml section. Both are read **live** by the loop (no daemon restart needed); sub-floor values are clamped at read time, and `settings.update` rejects values below the floor.

**Not exposed (FE-only).** Pure frontend/display settings are **out of **`intentd`** scope** and are**not** served by `settings.*`: `theme.*`, `fonts.*`, `ui.*`, `workspaceList.*`, `openIn.*`, `keybindings.*`, `promoBanners.*`, `activityLog.presets`,`model.pickerCollapsedGroups`, `preferences.spellcheckEnabled`, `preferences.betaUpdatesEnabled`,`providers.completedSetup`, `linear.issueFilter`.

```json
// → request — list all BE-owned settings (sensitive values redacted)
{ "jsonrpc":"2.0","id":51,"method":"settings.list" }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "settings": [
  { "path":"server.port","label":"WS port","description":"TCP port for the WSS listener",
    "category":"server","type":"number","min":1024,"max":65535,"defaultValue":5181,"value":5181 },
  { "path":"sourceControl.github.token","label":"GitHub token","description":"PAT used by octocrab",
    "category":"sourceControl","type":"string","sensitive":true,"value":null } ] } }
```

```json
// → request — read one setting
{ "jsonrpc":"2.0","id":52,"method":"settings.get","params":{ "path":"sourceControl.activeProvider" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "path":"sourceControl.activeProvider","value":"github",
  "origin":"default",
  "definition":{ "path":"sourceControl.activeProvider","label":"Source-control provider",
    "description":"Active forge implementation","category":"sourceControl","type":"enum",
    "enumValues":["github"],"defaultValue":"github" } } }
```

```json
// → request — mutate settings (emits settings:changed)
{ "jsonrpc":"2.0","id":53,"method":"settings.update","params":{ "changes":[
  { "path":"server.port","value":5182 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli","reason":"use gh auth token" } ] } }
// ← response
{ "jsonrpc":"2.0","id":53,"result":{ "applied":[
  { "path":"server.port","value":5182 },
  { "path":"sourceControl.github.tokenSource","value":"gh-cli" } ] } }
```

```json
// → request — reset one setting to its default
{ "jsonrpc":"2.0","id":54,"method":"settings.reset","params":{ "path":"server.port" } }
// ← response
{ "jsonrpc":"2.0","id":54,"result":{ "path":"server.port","value":5181 } }
```

### 5.13 Interactive `terminal.*`

> Alongside the read-only methods (`terminal.list` — the v4.0 `{ terminals, daemonBootId }`
> envelope — and `terminal.readOutput`, §5.9), the
> interactive methods below let a thin client open, drive, resize, and tear down PTYs that
> run on the **daemon host**. Terminals and scripts (§5.8) share one **unified PTY/terminal
> host** (`portable-pty`), each with a server-side scrollback ring buffer for replay on
> (re)connect; multiple clients may attach to the same session. Each PTY may carry an
> optional daemon-assigned display name (internal spawn metadata, e.g. `"Setup Script"`
> for the workspace setup terminal — §5.1); `terminal.create` does **not** accept a name
> parameter, and `terminal.list` (§5.9) surfaces the name with a `"Terminal"` fallback.

| Method | Params | Result |
| --- | --- | --- |
| terminal.create | workspaceId (req), cols (req,int), rows (req,int), cwd?, command?, env? (Record<string,string>) | { terminalId } — spawns a PTY; `command` omitted → default shell; `cwd` omitted → the workspace's worktree root (falls back to the daemon's cwd when the workspace has no resolvable worktree); `env` layers onto the daemon's inherited environment (later keys override) |
| terminal.write | terminalId (req), data (req, base64) | { ok: true } — `data` is base64-encoded input bytes |
| terminal.resize | terminalId (req), cols (req,int), rows (req,int) | { ok: true } |
| terminal.kill | terminalId (req) | { ok: true } — signals the PTY; emits `terminal:exit` (§6.5) |
| terminal.getBuffer | terminalId (req), maxBytes? | { terminalId, data } — base64 scrollback for replay |

**Base64 framing.** Terminal payloads are **binary-safe**: input (`terminal.write` `data`),
scrollback (`terminal.getBuffer` `data`), and streamed output (`terminal:data` `chunk`, §6.5)
are **base64-encoded** so arbitrary bytes (control sequences, UTF-8, non-text) survive the
JSON-RPC text channel. Clients decode on receipt and encode on send.
`terminal.readOutput` (§5.9) stays a plaintext convenience read.

```json
// → create an 80×24 PTY running the default shell
{ "jsonrpc":"2.0","id":70,"method":"terminal.create",
  "params":{ "workspaceId":"ws-abc","cols":80,"rows":24 } }
// ← response
{ "jsonrpc":"2.0","id":70,"result":{ "terminalId":"term-1" } }
// → send input "ls\n" (base64 of "ls\n" is "bHMK")
{ "jsonrpc":"2.0","id":71,"method":"terminal.write","params":{ "terminalId":"term-1","data":"bHMK" } }
// ← { "jsonrpc":"2.0","id":71,"result":{ "ok": true } }
// ← server pushes output as it arrives (§6.5); chunk is base64
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"terminal:data","workspaceId":"ws-abc","id":"evt-901",
    "timestamp":"2026-06-17T05:00:00.000Z","actor":{ "type":"system" },
    "data":{ "terminalId":"term-1","chunk":"bHMKZmlsZS50eHQK" } } } }
```

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
| host.status | client → daemon | — (no workspaceId) | { os, arch, hostname, hasDisplay, locality, displayServer? } — host capability probe |
| host.openExternal | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | url (req) | { ok: true } — **FE-served**: routes an "open in browser/app" intent back to the *user's* machine |
| host.openInEditor | **client → daemon** (trigger) *and* **daemon → client** (reverse RPC, `id: "rev-<n>"`) | editorId (req), path (req), line?, column? | { ok: true } — launches the user's editor on `path` (optional `line`/`column` hint). **Client-callable trigger**: the FE calls this like any other method; on a local connection the daemon short-circuits via the resolved `host.listInstalledEditors` entry and launches on the daemon host, on a remote connection the daemon re-dispatches the intent to the connected client as the FE-served reverse RPC so the editor opens on the user's laptop. `-32602` on missing `editorId`/`path` or an `editorId` unknown to the platform catalog; `-32603` when the editor is not installed, the local host is headless, or the launch / reverse proxy fails |
| host.pickApplication | **daemon → client** (reverse RPC, `id: "rev-<n>"`) | path (req) | { applicationId? } — **FE-served**: "open with…" chooser. On a local daemon returns `applicationId?` (or nothing when no chooser is available); on a remote daemon dispatches to the connected client and echoes its selection |
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
  by the daemon, distinct from the client's own `id` space) with a 30s default timeout; the
  local branch short-circuits directly on the daemon host without a wire round-trip (via
  `OsOpener` for `openExternal`, the resolved `host.listInstalledEditors` entry for
  `openInEditor`, and — when available — a native chooser for `pickApplication`).
- **`browser.exec` loopback-hostname convention — FE-side (monorepo#2323).** Because the
  CDP work is FE-served (§5.9), loopback hostnames in `navigate`/`openTab` action URLs are
  interpreted by the frontend per the reserved-hostname convention: `daemon.localhost` →
  the daemon machine, `client.localhost` → the client (user's) machine, and bare loopback
  (`127.0.0.1` / `localhost` / `[::1]`) defaults to the daemon's frame of reference —
  rewritten to the daemon host on a remote connection, with a `warning` echoed in the
  result. The daemon forwards the `browser.exec` envelope verbatim — the wire shape is
  unchanged; rewritten action results carry the additive `requestedUrl` / `finalUrl` /
  `rewritten` / `reason` echo fields. Full contract in §5.9.
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
  workspace"`. Missing / invalid params surface as `-32602`. Long-lived / streaming processes
  stay on `script.*` and `terminal.*` (§5.8, §5.13) — `host.exec` is one-shot only.
- `host.execStream` is the **streaming/interactive** counterpart for FE surfaces (e.g.
  `augment-cli`'s newline-delimited JSON chat) that need live stdout **and** a stdin channel —
  something neither the buffered `host.exec` nor the PTY-mangling `terminal.*` nor the
  workspace-script-lifecycle `script.*` fit. It reuses every `host.exec` guarantee (argv-only,
  process-group + `kill_on_drop` + `timeoutMs` reap, the child-env contract above — caller
  `env` > daemon process env > captured credential gap-fill, plus enriched PATH,
  workspace-containment on `cwd`, secret-safe env) and adds the streaming shape from
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
  "hasDisplay":false,"locality":"remote" } }
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

### 5.15 `search.*`

> Search is a **BE-owned namespace**: it executes on the daemon **where the code and data
> live**, so a thin client just renders results (when the daemon *is* the remote host, `rg`
> runs locally to it).

| Method | Params | Result |
| --- | --- | --- |
| search.inFiles | workspaceId (req), query (req), opts? { caseSensitive?, regex?, globs?, maxResults? }, requestId? | { requestId, matches: SearchMatch[], truncated } — ripgrep content search |
| search.fileNames | workspaceId (req), pattern (req), limit?, requestId? | { requestId, files: string[], truncated } — path/glob search |
| search.messages | query (req), workspaceId?, preferWorkspaceId?, agentId?, role?, limit?, requestId? | { requestId, matches: MessageMatch[] } — **FTS5/bm25-ranked** full-text search over persisted agent transcripts (BE owns session storage). `workspaceId` is **optional**: absent → **global** search across all workspaces; present → hard scope filter. `preferWorkspaceId` is a **soft ranking boost** — matches from that workspace outrank equally-relevant matches from other workspaces, but results stay global (nothing is excluded). Matches from **archived** workspaces carry a fixed soft rank penalty, giving the default tier order preferred workspace → other active → archived (relevance can still override). `agentId`/`role` narrow further (hard filters); `limit` caps the match count (absent → no cap). Semantics block below |
| search.events | query (req), workspaceId?, limit?, requestId? | { requestId, matches: EventMatch[] } — over the BE event log |
| search.memories | query (req), workspaceId?, requestId? | { requestId, matches: MemoryMatch[] } — over the BE memories store |
| search.notes | query (req), requestId? | { requestId, matches: NoteMatch[] } — over the BE notes store (global; no workspaceId) |
| search.codebase | workspaceId (req), query (req), requestId? | { requestId, matches: CodebaseMatch[] } — **ripgrep/symbol-backed** search. auggie exposes no structured codebase-retrieval CLI, so `AuggieContextEngine::retrieve()` returns `Unavailable` instantly and ripgrep is the backing; the `ContextEngine` trait is retained as forward-looking infra |
| search.cancel | requestId (req) | { ok: true } — aborts an in-flight search by its `requestId` |

**`requestId` & cancellation.** Every search method accepts an optional caller-supplied
`requestId` (echoed in the result and in every streamed event). It is the handle used by
`search.cancel` and the correlation key for `search:result` / `search:done` events — mirroring
the renderer's `AbortController` debounce/cancel today. If the client omits it the server mints
one and returns it in the result.

**Match / result shape.** Content-style matches (`SearchMatch`) carry enough to render a hit
without a follow-up fetch:

```ts
interface SearchMatch {
  file: string;        // workspace-relative path
  line: number;        // 1-based line number
  col: number;         // 1-based column of the match start
  preview: string;     // the matching line (trimmed for display)
  before?: string[];   // optional context lines before
  after?: string[];    // optional context lines after
  score?: number;      // relevance (semantic/codebase results)
}
// EventMatch / MemoryMatch / NoteMatch / CodebaseMatch are store-specific:
// each carries its entity id (eventId / memoryId / noteId / symbol),
// a `preview` snippet, and an optional `score`.

interface MessageMatch {
  agentId: string;
  messageId: string;
  preview: string;      // windowed onto the first raw-query token occurring in the text
  score?: number;       // negated adjusted bm25 rank — higher = more relevant
  workspaceId: string;  // owning workspace — makes global results navigable
  agentName: string;    // agent display name
  role: string;         // "user" | "assistant"
  timestamp: string;    // the message row's created_at
}
```

**`search.messages` semantics (FTS5, additive).** Backed by a trigger-maintained FTS5 index
over the extracted plain text of persisted `user`/`assistant` transcript rows (other roles are
not indexed), ranked by bm25 — matches order by adjusted rank, then newest-first, one match per
matching message (no per-agent collapse). `preferWorkspaceId` subtracts a fixed boost from the
bm25 rank (lower = better) of matches owned by the preferred workspace: large enough to lift a
preferred-workspace match above equally-relevant matches elsewhere, small enough that a
decisively better match from another workspace still wins. Symmetrically, matches owned by
**archived** workspaces get a fixed penalty (same bm25-unit scale as the boost) added to their
rank — applied regardless of whether `preferWorkspaceId` is set — so the default tier order is
preferred workspace → other active workspaces → archived workspaces. Both adjustments are
**soft**: a decisively more relevant match still overrides tier order, and nothing is excluded.
**User-typed queries never error:** the raw query is never handed to the FTS5 query parser
verbatim — it is reduced to its
alphanumeric tokens, each matched as a quoted phrase joined with `AND`, with the final token —
presumed mid-typing — also matching as a prefix; operators, quotes, and punctuation are
stripped rather than surfacing `fts5: syntax error`, and a query with no searchable tokens
yields empty `matches`, not an error. The enriched `MessageMatch` fields (`workspaceId`,
`agentName`, `role`, `timestamp`) are additive — pre-existing consumers of
`agentId`/`messageId`/`preview`/`score` are unaffected.

**Result delivery — direct or streamed.** Small result sets are returned inline in the method
result (`matches`/`files` + `truncated`). Large or long-running searches are **streamed**: the
method returns `{ requestId }` promptly and the daemon pushes incremental `search:result`
batches followed by a terminal `search:done` (§6.5), correlated by `requestId`. Either way the
final, complete answer is the `search:done` event (or the inline result when not streamed).

```json
// → content search across a workspace
{ "jsonrpc":"2.0","id":90,"method":"search.inFiles",
  "params":{ "workspaceId":"ws-abc","query":"TODO","requestId":"srch-1",
    "opts":{ "caseSensitive":false,"regex":false,"maxResults":500 } } }
// ← prompt ack (large result set → streamed)
{ "jsonrpc":"2.0","id":90,"result":{ "requestId":"srch-1","matches":[],"truncated":false } }
// ← incremental results (§6.5), correlated by requestId
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"search:result","workspaceId":"ws-abc","id":"evt-910",
    "timestamp":"2026-06-17T05:01:00.000Z","actor":{ "type":"system" },
    "data":{ "requestId":"srch-1","matches":[
      { "file":"src/main.rs","line":42,"col":3,"preview":"// TODO: handle error" } ] } } } }
// ← terminal event — search finished
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"search:done","workspaceId":"ws-abc","id":"evt-911",
    "timestamp":"2026-06-17T05:01:00.200Z","actor":{ "type":"system" },
    "data":{ "requestId":"srch-1","total":17,"truncated":false } } } }
```

```json
// → cancel an in-flight search
{ "jsonrpc":"2.0","id":91,"method":"search.cancel","params":{ "requestId":"srch-1" } }
// ← { "jsonrpc":"2.0","id":91,"result":{ "ok": true } }
```

**Errors.** Missing `query`/`pattern`/`requestId` — and `workspaceId` where required
(`search.inFiles` / `search.fileNames` / `search.codebase`) — → `-32602`. `search.cancel`
with an unknown or already-finished `requestId` is a no-op success (`{ ok: true }`). A malformed
`opts.regex` pattern yields `-32602 "Invalid regex"`. Host-API searches (PR/issue/repo) are
**not** part of `search.*` — they live on the explicit-addressing `github.*` surface
(`github.pulls.search` / `github.issues.search` / `github.repos.search`, §5.27).

### 5.16 `drafts.*`

> Message drafts (typed-but-not-sent input) are BE state, keyed by
> **`(workspaceId, agentId, clientId)`** — where `clientId` is the stable client identity from
> `client.hello` (§5.17) — so each client keeps its **own private** draft that survives
> reconnects. With multiple thin clients connected to one daemon, per-client local storage
> would not survive reconnects or share across devices, and concurrent writers would clobber
> each other.

| Method | Params | Result |
| --- | --- | --- |
| drafts.get | workspaceId (req), agentId (req) | { text, updatedAt } \| null — the draft for the **calling client** (resolved from its `clientId`); `null` if none |
| drafts.set | workspaceId (req), agentId (req), text (req) | { ok: true, updatedAt } — upsert for the calling client; emits `draft:changed` |
| drafts.clear | workspaceId (req), agentId (req) | { ok: true } — delete on send / explicit clear; emits `draft:changed` |

**Implicit client keying.** The `clientId` is **not** a parameter — it is resolved from the
calling connection's logical client (established by `client.hello`, §5.17). A connection that
never completed the handshake is treated as an anonymous, connection-scoped client (its drafts
do not survive reconnect). The FE debounces `drafts.set` exactly as it debounces the local-only
save today, and calls `drafts.clear` on send.

**Per-client private by default.** Each client restores only its own draft on reconnect; drafts
are never returned to a different `clientId`. A future opt-in **shared-draft** (collaborative)
mode is noted but **out of scope for v1**.

**Opaque keys & reserved sentinels.** `workspaceId` / `agentId` are **opaque draft keys** — the
daemon never validates them against live workspaces or agents. The FE reserves the sentinel pair
**`"__new-workspace__"` / `"__initializer__"`** for the New Workspace modal's pre-creation draft
(no workspace/agent exists yet); it is per-client like any other draft and the FE clears it on
successful `workspace.create`. The `__…__` form cannot collide with real IDs (daemon-generated
workspace slugs are lowercase alphanumerics + hyphens).

**`draft:changed` event — no text leakage.** `drafts.set` / `drafts.clear` emit
`draft:changed { workspaceId, agentId, clientId, hasDraft }` (§6.5). The payload deliberately
**omits the draft text** — it lets other clients optionally show a "someone is composing"
affordance without leaking content, and lets the owning client's *other* connections (same
`clientId`) know to re-fetch their own text via `drafts.get`. Kept minimal in v1.

```json
// → restore this client's draft on (re)connect
{ "jsonrpc":"2.0","id":95,"method":"drafts.get","params":{ "workspaceId":"ws-abc","agentId":"agent-1" } }
// ← response (a draft exists)
{ "jsonrpc":"2.0","id":95,"result":{ "text":"half-written question…","updatedAt":"2026-06-17T05:02:00.000Z" } }
// → save (debounced) as the user types
{ "jsonrpc":"2.0","id":96,"method":"drafts.set",
  "params":{ "workspaceId":"ws-abc","agentId":"agent-1","text":"half-written question…" } }
// ← { "jsonrpc":"2.0","id":96,"result":{ "ok":true,"updatedAt":"2026-06-17T05:02:00.000Z" } }
// ← event — other connections learn a draft exists (no text)
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"ws-sub-1",
  "event":{ "type":"draft:changed","workspaceId":"ws-abc","id":"evt-920",
    "timestamp":"2026-06-17T05:02:00.000Z","actor":{ "type":"user" },
    "data":{ "workspaceId":"ws-abc","agentId":"agent-1","clientId":"cli-7f3a","hasDraft":true } } } }
// → clear on send
{ "jsonrpc":"2.0","id":97,"method":"drafts.clear","params":{ "workspaceId":"ws-abc","agentId":"agent-1" } }
// ← { "jsonrpc":"2.0","id":97,"result":{ "ok":true } }
```

**Errors.** Missing `workspaceId` / `agentId` (all three methods) or `text` (`drafts.set`) →
`-32602`. `drafts.get` for a non-existent draft returns `null` (not an error); `drafts.clear`
on a non-existent draft is a no-op success.

### 5.17 `client.hello` handshake & stable client identity

The daemon supports a **stable, client-supplied identity** that survives reconnects; the ephemeral
per-connection id used internally for subscription bookkeeping is retained purely for transport
bookkeeping and never crosses the wire.

| Method | Params | Result |
| --- | --- | --- |
| client.hello | clientId?, name?, capabilities? | { clientId, protocolVersion, server: { locality, hasDisplay, osArch, version, protocolVersion, capabilities } } |

- **Global handshake.** `client.hello` does **not** require `workspaceId` (§3.6); it is the
  first call a client makes after the auth upgrade (§2) and before scoped work.
- **Client-persisted `clientId`.** The client **generates and persists its own `clientId`** (a
  UUID in its local storage) and **re-presents it on every (re)connect**. If the client omits
  `clientId`, the server generates one and returns it for the client to persist and reuse from
  then on.
- **Connection → client mapping.** The daemon maps each live connection to its logical
  `clientId`; **multiple connections may share one `clientId`** (the same client reconnecting, or
  several windows of one app).
- **Disambiguation key.** `clientId` is the key that disambiguates `drafts.*` (§5.16) and is the
  foundation for **future per-viewer read cursors** (the `attention` extension noted in §5.1). It
  also lets FE-served intents (`host.openExternal`, §5.14) and `forward.*` target the right
  client.
- **`server` block.** The result advertises daemon capabilities so a client can gate UI right
  after the handshake (mirrors `host.status`, §5.14): `locality` (`local` | `remote`),
  `hasDisplay` (GUI present on the daemon host), `osArch` (e.g. `darwin/arm64`), `version`
  (daemon version string), `protocolVersion` (the JSON-RPC surface version, `"6.14"`), and
  `capabilities` (feature-detection flags, e.g. `{ "liveState": true }` for the snapshot+delta
  channels of §6.9).
- **`protocolVersion`.** The top-level `protocolVersion` is an explicit copy of
  `server.protocolVersion` so clients can version-check without digging into the `server` block
  (see [Protocol Version & Compatibility](#protocol-version--compatibility)).

```json
// → first call after auth: client re-presents its persisted clientId
{ "jsonrpc":"2.0","id":1,"method":"client.hello",
  "params":{ "clientId":"cli-7f3a","name":"Intent Desktop","capabilities":{ "forward":true,"openExternal":true } } }
// ← response — capabilities of the daemon host
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-7f3a","protocolVersion":"6.14",
  "server":{ "locality":"remote","hasDisplay":false,"osArch":"linux/x86_64","version":"0.1.0",
    "protocolVersion":"6.14","capabilities":{ "liveState":true } } } }
```

```json
// → first-ever connect: no clientId yet, server mints one
{ "jsonrpc":"2.0","id":1,"method":"client.hello","params":{ "name":"Intent Desktop" } }
// ← server returns a clientId for the client to persist
{ "jsonrpc":"2.0","id":1,"result":{ "clientId":"cli-9b21","protocolVersion":"6.14",
  "server":{ "locality":"local","hasDisplay":true,"osArch":"darwin/arm64","version":"0.1.0",
    "protocolVersion":"6.14","capabilities":{ "liveState":true } } } }
```

**Errors.** A malformed `clientId` (non-string) → `-32602`. The handshake is idempotent:
re-sending `client.hello` on the same connection updates `name` / `capabilities` and re-returns
the same `server` block.

### 5.18 `accept-changes.*`

The multi-step "accept the agent's work" workflow: the backend owns local git **and** the forge
(the `SourceControl` trait), so a thin client drives commit → push → create-PR →
merge through a handful of calls. `execute` runs the orchestrated pipeline and **restores agent
attribution** from `file-tracking` (§5.19) on each step. Every method requires `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| accept-changes.getStatus | workspaceId (req) | WorkspaceGitStatus (schema below) |
| accept-changes.prepare | workspaceId (req), action (req), files?: string[] | PrepareResult { valid, warnings[], errors[], suggestedCommitMessage?, suggestedPRTitle?, suggestedPRBody?, filesCount, additions, deletions, files: [{ path, additions, deletions, staged }] } |
| accept-changes.execute | workspaceId (req), action (req), files?, commitMessage?, prTitle?, prBody?, targetBranch?, mergeStrategy?: "merge"\|"squash"\|"rebase", upToCommitHash?, undoCommitsMetadata?, options?: { stageUnstaged?, pushAfterCommit?, createPRAfterPush?, rebaseFirst?, localOnly? } | AcceptChangesResult { success, steps: [{ id, name, status, message?, error? }], result?: { commitHash?, prNumber?, prUrl?, mergeCommitHash?, … }, error? } |
| accept-changes.mergePR | workspaceId (req), prNumber (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | AcceptChangesResult |
| accept-changes.addRemote | workspaceId (req), remoteUrl (req) | WorkspaceGitStatus (refreshed after adding `origin`) |

`action` is one of `commit \| push \| create-pr \| merge \| export \| undo-push \| undo-commit \|
reset-to-trunk \| rebase-onto-trunk` — except **`export` is not supported** (no UI consumer),
so `execute` rejects `action:"export"`. A step that fails sets `success:false` and the offending
`steps[].status:"failed"` with `error`; malformed params → `-32602`, underlying service throws →
`-32603`.

```json
// → request — prepare a commit for the staged files
{ "jsonrpc":"2.0","id":50,"method":"accept-changes.prepare",
  "params":{ "workspaceId":"ws-abc","action":"commit" } }
// ← response
{ "jsonrpc":"2.0","id":50,"result":{
  "valid":true,"warnings":[],"errors":[],
  "suggestedCommitMessage":"Add review wire surface",
  "filesCount":2,"additions":140,"deletions":12,
  "files":[{ "path":"docs/rust-backend/PROTOCOL.md","additions":140,"deletions":12,"staged":true }] } }
```

**Shared schemas (Code Changes Review).** Defined once here; referenced by §5.19, §5.20.

- **WorkspaceGitStatus** — `{ branch, trunkBranch, aheadOfTrunk, behindTrunk, hasRemote,
  isPushed, uncommittedCount, stagedCount, localCommits: CommitWithAttribution[],
  existingPR?: { number, url, htmlUrl, title, state: "open"|"closed"|"merged"|"draft" } }`.
- **CommitWithAttribution** — a local commit carrying agent provenance:
  `{ hash, message, author, date, filesChanged?, isPushed, files?: [{ path, additions?,
  deletions?, status? }], agentId?, linkedNoteId? }`. `files` and `filesChanged` are
  emitted only when the producing walk computed per-commit tree diffs. All current
  producers are **metadata-only** (both fields omitted — the list walks skip
  per-commit diffs for performance; clients fetch per-file data on demand via
  `git.commitDetails` (§5.6)): `accept-changes.getStatus` `localCommits` and
  `file-tracking.loadCommits` (§5.19). The `changes:git-status` event (§6.5) carries
  the same reduced `WorkspaceGitStatus`.
- **TrackedChange** — one file's audit record through the git stages (see §5.19):
  `{ id, file, relativePath, stage: "unstaged"|"staged"|"committed"|"pushed"|"pull_request"|
  "merged"|"trunk", status?: "added"|"modified"|"deleted"|"renamed",
  stats: { additions, deletions, binary? },
  attribution: { agent?: { agentId, agentName, sessionId, turnNumber, messageId?, toolCallId?,
  timestamp }, manual?, timestamp } }`.
- **Review** — `{ author, verdict: "approve"|"request-changes"|"comment", body?, submittedAt }`
  (host-agnostic; GitHub's `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED` map onto `verdict`).
- **CheckRun** — `{ name, state: "pending"|"success"|"failure"|"neutral"|"cancelled", url? }`.
- **Metrics** — line-change totals: `{ additions, deletions, filesChanged, byAgent }` (workspace-level
  stats include `byAgent`; per-agent stats may omit `byAgent`; see §5.20).
- **DiffChunk / DiffDetail** *(internal — no wire method)* — old/new content + hunks, computed and
  stored inside the backend; never returned by a `diffs.*` RPC.
  Diff content reaches the client only via the `file-tracking.*` reads and the §6.5 change events.

### 5.19 `file-tracking.*` (reads)

A per-file audit trail as changes move through the git stages
(`unstaged → staged → committed → pushed → pull_request → merged`) with agent attribution. Only
the **UI-invoked reads** are wire methods; the attribution writer `trackChange` is **internal**
(the backend records it as agents edit files — no client RPC; see §6.8). Every method requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| file-tracking.getChanges | workspaceId (req), filter?: { stage?, agentId?, sessionId?, turnNumber?, filePattern?, since?, until? } | { changes: TrackedChange[], truncated, totalCount } |
| file-tracking.loadCommits | workspaceId (req), limit?: number (default 50, ≤200), nextToken?, includeOlder?: boolean (default false) | { commits: CommitWithAttribution[], boundarySha, nextToken } — **metadata-only** entries (see the CommitWithAttribution schema, §5.18): the bounded walk skips per-commit tree diffs; clients fetch per-file data on demand via `git.commitDetails` (§5.6). Boundary semantics below |
| file-tracking.getLineStats | workspaceId (req) | { additions, deletions } — real-time totals across unstaged + staged + local commits |
| file-tracking.stage | workspaceId (req), paths (req): string[] | { ok: true } — stages the referenced files |
| file-tracking.unstage | workspaceId (req), paths (req): string[] | { ok: true } — unstages the referenced files |

**`file-tracking.loadCommits` boundary semantics.** The commit walk is bounded by the workspace's **boundary commit** so a workspace only surfaces its own history:

- When `includeOlder` is `false` (default), returns commits in the `boundary..HEAD` range (workspace-owned commits only).
- When `includeOlder` is `true`, returns commits before and including the workspace boundary (for "show previous" functionality; the boundary commit itself is included).
- `boundarySha` is the workspace boundary commit SHA, or `null` when the workspace has no boundary info (`baseRef` or `baseCommitSha` not set), or when boundary info exists but cannot be resolved (e.g. shallow clone, nonexistent ref, base commit not an ancestor of HEAD).
- **Fail-closed safety net:** when boundary info exists but cannot be resolved, the method returns an empty commit list (regardless of `includeOlder`) to prevent leaking arbitrary base-branch history.
- **Boundary resolution strategy:** (1) prefer the merge-base of HEAD with `origin/<baseRef>` or `<baseRef>` (rebase-resilient); (2) fall back to `baseCommitSha` if it is a valid ancestor of HEAD; (3) return `null` if neither resolves.
- `nextToken` in the result is the pagination token for the next page, or `null` when exhausted; pass it back as the `nextToken` parameter.

```json
// → request — load committed changes for one agent
{ "jsonrpc":"2.0","id":51,"method":"file-tracking.getChanges",
  "params":{ "workspaceId":"ws-abc","filter":{ "stage":"committed","agentId":"agent-123" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "changes":[
  { "id":"git-1-src/x.ts","file":"/ws/src/x.ts","relativePath":"src/x.ts",
    "stage":"committed","status":"modified","stats":{ "additions":10,"deletions":2 },
    "attribution":{ "agent":{ "agentId":"agent-123","agentName":"Coordinator",
      "sessionId":"sess-9","turnNumber":4,"timestamp":1750000000000 },"timestamp":1750000000000 } } ],
  "truncated":false,"totalCount":1 } }
```

### 5.20 Change metrics (reads)

Read-only line-change aggregates. Aggregation
itself (`metrics.calculate`, the `update*` writers, `mark-agent-active`) is **internal** — the
backend computes metrics as agents work and pushes change events (§6.5); clients only **read**.
Metrics are durable (the `workspace_metrics` / `agent_metrics` tables).

| Method | Params | Result |
| --- | --- | --- |
| metrics.getWorkspaceStats | workspaceId (req) | Metrics \| null — `{ additions, deletions, filesChanged, byAgent }` for the workspace |
| metrics.getAgentStats | agentId (req) | Metrics \| null — `{ additions, deletions, filesChanged }` for one agent (`byAgent` omitted) |
| metrics.getAllWorkspaceStats | — | { [workspaceId]: Metrics } — all workspaces |
| metrics.clearAgentStats | agentId (req) | { success: boolean } — resets one agent's counters |

```json
// → request
{ "jsonrpc":"2.0","id":52,"method":"metrics.getWorkspaceStats","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "additions":140,"deletions":12,"filesChanged":3,
  "byAgent":{ "agent-123":{ "additions":140,"deletions":12,"filesChanged":3 } } } }
```

### 5.21 `rules.*`

The backend owns prompt **rules**: the workspace rule files
(`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization
rules attached to a specialist, and **user-rule overrides** persisted by the daemon. `list`/`get`
are reads; `update` is the UI-invoked op that edits the **user-override** content. Assembling these
into an agent's system prompt (the **injection pipeline**) runs **internally** as agents start —
there is no wire method for it (§6.8). Every method requires `workspaceId` except where noted.

Within that internal pipeline the **per-agent-type specialization** layer is **not settings-only**:
it resolves through a **3-tier fallback** (highest priority first) — the `endUserRules`
**user-settings override** (edited via `rules.update`) **>** the **workspace file**
`.augment/agent-rules/{agentType}.md` **>** the compiled-in **bundled built-in** template — so a
workspace rule file and a bundled default both back the per-agent-type key when no settings override
exists. The composition (with the agent-id alias map and the utility/background-agent
special-cases) remains internal — no method or shape changes.

| Method | Params | Result |
| --- | --- | --- |
| rules.list | workspaceId? | { rules: RuleSet } — all rule sources for the workspace (or global when omitted) |
| rules.get | workspaceId (req), ruleType (req): user-override key — "base-system-prompt", a per-agent-type specialization key, "workspace", … | { enabled, content, updatedAt } for that one user-override type |
| rules.update | workspaceId (req), ruleType (req): user-override key (as in rules.get), content (req): string, enabled?: boolean | { rules: RuleSet } — upserts the user-override body (+ enabled) and re-reads the set |

**RuleSet** — `{ workspaceId?, rules: RuleEntry[] }` where **RuleEntry** =
`{ ruleType: string, source: string, path?, content, enabled: boolean, updatedAt: number,
editable: boolean }`. `ruleType` is the user-override key the entry is stored under (e.g.
`"base-system-prompt"`, a per-agent-type specialization key, or `"workspace"`); `source` names the
origin (e.g. `"AGENTS.md"`, `".augment/guidelines.md"`, a specialist id, or `"user-override"`);
`path?` is the backing file when one exists; `enabled` toggles whether the override is applied and
`updatedAt` is its last-write epoch-ms; only `user-override` entries are `editable` (the target of
`rules.update`). File-sourced entries are read-only over the wire — edit the files directly.

```json
// → request — set the user-rule override for a workspace
{ "jsonrpc":"2.0","id":60,"method":"rules.update",
  "params":{ "workspaceId":"ws-abc","ruleType":"workspace","enabled":true,
    "content":"Always run the linter before committing." } }
// ← response
{ "jsonrpc":"2.0","id":60,"result":{ "rules":{ "workspaceId":"ws-abc","rules":[
  { "ruleType":"base-system-prompt","source":"user-override","content":"…",
    "enabled":false,"updatedAt":1750000000000,"editable":true },
  { "ruleType":"workspace","source":"user-override",
    "content":"Always run the linter before committing.","enabled":true,
    "updatedAt":1750000000000,"editable":true } ] } } }
```

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

### 5.23 Usage metrics — `workspace.getTokenUsage`

The backend owns token/credit **usage accounting**. Usage is sourced **live from ACP**: at the end
of each prompt turn, the `PromptResponse.usage` report (via the agent-client-protocol
`unstable_end_turn_token_usage` feature flag) carries the session's **cumulative** counters; the
daemon persists that snapshot per session with **REPLACE semantics** (each report replaces the
session's previous snapshot — reports are never summed), mapping ACP `cachedReadTokens` →
`cacheReadTokens` and `cachedWriteTokens` → `cacheCreationTokens`, then immediately re-aggregates
per agent and per model and writes the durable `tokenUsage` field on the `Workspace`. The
turn-end bookkeeping is **detached** from the turn itself — it never delays the terminal
`agent:stream:end`, and bookkeeping for the same agent is ordered across turns — so a client
reading `workspace.getTokenUsage` immediately after `agent:stream:end` may briefly see the
previous tally; rely on `workspace:tokenUsage-changed` (§6.5) to observe the update.
**Usage survives ACP session recreation:** when a `session/load` → `session/new` ACP session
recreate swaps in a fresh ACP session id — whether via the resume-impossible fallback (a failed
`session/load`), `agent.editAndRegenerate`'s forced recreate, or the `agent.retry`
poisoned-session recreate ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940)) —
the outgoing session's
cumulative snapshot is folded into a daemon-internal per-agent **baseline** (saturating sum) and
the snapshot is cleared, atomically with the id swap — the recreated session's cumulative reports
restart from zero, so per-agent effective totals are **baseline + snapshot**. The baseline is
internal accounting only (never on the wire; `TokenUsage` shapes are unchanged), and the legacy
per-message **message-sum fallback** applies only when both baseline and snapshot are absent. A
daemon-internal periodic **scan** (300 s cadence) is demoted to a **reconciliation fallback** for
sessions the live path cannot see (providers without end-of-turn usage reports / legacy
per-message metadata); a reconciliation recount that comes back all-zero **never regresses** a
stored non-zero live tally to zero **while agent-session rows still exist** (the racing-sweep
guard). When the workspace has no sessions left (all deleted), an all-zero recount is legitimate
and writes through — clients must not assume `tokenUsage` can never drop back to zero. Only the
**read** and its change event cross the wire —
neither the live update nor the scan has an RPC (§6.8). `workspace.getTokenUsage` requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| workspace.getTokenUsage | workspaceId (req) | { tokenUsage: TokenUsage } — -32602 if the workspace is not found |

**TokenUsage** — `{ byAgentId: { [agentId]: TokenUsageTotals }, totals: TokenUsageTotals,
byModel: { [modelName]: TokenUsageTotals }, lastScanAt: string | null }`, where
**TokenUsageTotals** is the consumption counters plus an optional cost —
`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, thoughtTokens?,
cost?: { amount: number, currency: string } }`. `byAgentId` keys are
`agent-{uuid}`; `byModel` keys are the effective model name (`"unknown"` fallback); `lastScanAt` is
the RFC-3339 timestamp of the last recompute — a live turn-end update or a reconciliation pass
(`null` before the first). Updated values are pushed via `workspace:tokenUsage-changed` (§6.5).

**Cost** is sourced from the ACP `usage_update` session notification's `cost` object
(`{ amount, currency }`, `currency` an ISO 4217 code) and is therefore present **only for
providers that report it** — the field is **omitted** (never `null`, never a fabricated `0`)
on any bucket no contributing session reported a cost for, so clients written against the
pre-cost shape are unaffected. Like the token counters, `usage_update` cost is **cumulative
per ACP session**, so each report REPLACES the session's previous cost and an ACP session
recreate folds it into the same internal baseline as the counters (no reset-to-zero loss, no
double count). The two reports are independent: a turn carrying only a cost never zeroes the
counters, and a turn carrying only counters never drops a cost already reported. Aggregation
sums amounts per currency within each bucket (`totals`, each `byAgentId` entry, each `byModel`
entry); in the pathological case of a bucket mixing currencies, the currency with the largest
sum wins — the daemon never converts between currencies.

**`thoughtTokens`** *(additive within v6.0, [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973))*
is the cumulative reasoning ("thought") token count, sourced from the ACP `usage_update`
report's `thoughtTokens` field for the providers that break reasoning out of `outputTokens`.
It is a `u64` in camelCase, **omitted when zero or unreported** (never a fabricated `0`, never
`null`), so clients written against the pre-`thoughtTokens` shape are unaffected. It aggregates
exactly like the other counters — saturating sum into `totals` / each `byAgentId` entry / each
`byModel` entry, saturating subtraction for the per-turn delta against the previous cumulative
snapshot (clamped ≥ 0), and folded into the ACP-session-recreate baseline the same way. A tally
whose ONLY non-zero counter is `thoughtTokens` still counts as a real token report, so it does
not fall through to the legacy per-message usage fallback.

```json
// → request
{ "jsonrpc":"2.0","id":62,"method":"workspace.getTokenUsage","params":{ "workspaceId":"ws-abc" } }
// ← response (pushed again as workspace:tokenUsage-changed whenever the tally changes — at turn end or after a reconciliation pass)
{ "jsonrpc":"2.0","id":62,"result":{ "tokenUsage":{
  "byAgentId":{ "agent-123":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } } },
  "byModel":{ "opus-4.8":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } } },
  "totals":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } },
  "lastScanAt":"2026-06-17T12:00:00Z" } } }
```

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

### 5.25 Worktree setup scripts — `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript`

A per-workspace **setup script** that provisions a fresh worktree (install deps, build prereqs, …),
**persisted in `.intent/config.json`** in the worktree (committable, repo-scoped). The workspace
DB `setup_script` field is retired from all write paths (kept for wire compat and legacy
read-only fallback only). `detectProjectType` inspects manifest files to classify the project;
`generateSetupScript` is the **AI-assisted** generator. Every method requires `workspaceId`.

**Setup script execution:** When a workspace is created (`workspace.create`) and an effective
setup script exists (non-empty, resolved from an explicit `setupScript` param — execute-only,
never persisted, §5.1 — else from worktree `.intent/config.json` or legacy DB
fallback), the daemon executes it non-blocking (fire-and-forget spawn) after worktree
provisioning in the worktree directory via `/bin/sh` (POSIX; on Windows, via a discovered
Git-for-Windows `sh.exe` running the same POSIX wrapper, falling back to a `cmd.exe` `.cmd`
wrapper that receives the script path through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT`
(repository root path), `WORKTREE_PATH` (the new worktree path), `BRANCH_NAME` (workspace
branch), and `SOURCE_BRANCH` (baseRef when provided, empty string otherwise). Execution never fails workspace creation —
errors are logged and surfaced. Script output is streamed to a workspace terminal named
**"Setup Script"** (its daemon-tracked PTY display name in `terminal.list`, §5.9); a POSIX-sh
timing wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) appends a
newline-prefixed `Setup script completed in <N>s (exit code <C>)` /
`Setup script failed in <N>s (exit code <C>)` summary to the scrollback, preserving the
script's exit code (§5.1).

| Method | Params | Result |
| --- | --- | --- |
| workspace.getSetupScript | workspaceId (req) | { setupScript: SetupScript } — reads from worktree `.intent/config.json` (when present), falls back to legacy DB row `setup_script` (read-only) |
| workspace.saveSetupScript | workspaceId (req), script (req): string | { setupScript: SetupScript } — writes to worktree `.intent/config.json` (merge semantics, best-effort) and returns synthesized record; DB field is not written. Returns -32602 (invalid params) when the workspace has no `worktreePath` or `repositoryPath` |
| workspace.detectProjectType | workspaceId (req) | { projectType: ProjectType \| null } — null when no known manifest is found |
| workspace.generateSetupScript | workspaceId (req) | { setupScript: SetupScript } — AI-assisted draft (returned, not auto-saved; persist with saveSetupScript) |

- **SetupScript** — `{ script: string, projectType?: ProjectType, updatedAt: number,
  generatedBy?: "user"\|"agent" }`. `generatedBy` records whether the body was hand-written
  (`saveSetupScript`) or AI-drafted (`generateSetupScript`); `updatedAt` is the last-write epoch-ms.
  When read from `.intent/config.json`, `generatedBy` is synthesized as `"user"`.
- **ProjectType** — `"node" | "python" | "go" | "rust" | "ruby"` (detected from `package.json`,
  `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, and `Gemfile` respectively).

```json
// → request — detect the project type, then generate a draft script
{ "jsonrpc":"2.0","id":64,"method":"workspace.detectProjectType","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":64,"result":{ "projectType":"rust" } }
// → request
{ "jsonrpc":"2.0","id":65,"method":"workspace.generateSetupScript","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":65,"result":{ "setupScript":{
  "script":"#!/usr/bin/env bash\nset -euo pipefail\ncargo fetch\n",
  "projectType":"rust","updatedAt":1750000000000,"generatedBy":"agent" } } }
```

### 5.26 Future integrations & observability *(design notes — NOT v1 wire surface)*

> **Future integrations (design stubs — NOT v1).** Of the original design stubs, **Sandbox /
> DevContainer** workspace configuration remains a future per-workspace execution-environment
> surface — anticipated but **not** exposed over the protocol in v1, folded into the same future
> track.
>
> **Linear** (issue tracking) is re-implemented daemon-owned against Linear's GraphQL API
> (**no Augment proxy**) as the `linear.*` namespace — **specified as a TARGET contract — see §5.28**.
>
> **Sentry** (error tracking) is re-implemented daemon-owned against Sentry's REST API
> (**no Augment proxy**) as the `sentry.*` namespace — **specified as a TARGET contract — see §5.29**.
>
> These are documented so the surface is anticipated.

> **Observability is internal, not wire.** Tracing, structured logging, and log files are
> **daemon-internal** operational concerns — there is **no** `logging.*` / `telemetry.*` wire
> surface, and none is planned for v1. Clients observe backend work through domain **events** (§6.5),
> not through a logging API.

### 5.27 `github.*` namespace

> The `github.*` namespace is served **daemon-owned** against `api.github.com` — 24 methods (23 network reads/writes plus the cached-first `github.branches.listCached` — one-shot ls-remote fallback on a miss — v6.2), with real `nextToken`/`limit` pagination on the list reads (the uniform-pagination contract described in the conventions below), reusing the `intent-sourcecontrol` **octocrab** engine — the same engine that already backs `pr.*`. The auth trio (`connect` / `cancelAuth` / `revoke`) drives a daemon-owned **OAuth device flow** (see the auth-model note below). The field names and shapes here are the source of truth for both sides.
>
> **Namespace split.** Local git operations stay on `git.*` (§5.6). Everything
> that hits `api.github.com` — repo/PR/issue browse, PR review comments + threads — plus GitHub
> **auth** and GitHub-**derived identity** live on `github.*`. The surviving `pr.*` methods (§5.7 —
> `pr.status` / `pr.refresh` since the v5.0 removal) are deliberately **workspace/active-PR scoped**
> (`ws` → owner/repo/number) and are left **untouched**;
> `github.*` is the **explicit-addressing** surface — every data method takes `(owner, repo[, number])`
> rather than resolving from the workspace.

> **Auth model — OAuth device flow, daemon-owned (with env-PAT fallbacks).** `github.connect`
> starts GitHub's **OAuth device flow** (no client secret, no callback URL — only a public OAuth
> App client id, `sourceControl.github.oauthClientId`): the daemon requests a `user_code`, hands it
> to the client, and **polls GitHub in the background** until the user authorizes at
> `github.com/login/device` (or the codes expire / the user denies). On authorize the access token
> is persisted server-side under `sourceControl.github.token` — the **first slot** of the existing
> `intent-sourcecontrol` resolution chain, ahead of the `GITHUB_TOKEN` / `GH_TOKEN` env vars and
> the `gh auth token` fallback (§5.12) — so every `github.*` / `pr.*` consumer picks it up with
> zero resolution changes. Because the daemon owns the poll loop, the flow **survives client
> refreshes**: a reconnecting client re-reads the in-flight state from `github.authStatus`.
> On authorize the daemon also **best-effort** authenticates a locally installed `gh` CLI with the
> stored token (piped via stdin only, never argv or logs; skipped when `gh` is absent or already
> logged in — an existing `gh` login is never overwritten; a sync failure never affects the device
> flow — behavior-only, no wire-shape change).
>
> - `github.authStatus` validates the resolved token via `GET /user` and reports connection state,
>   plus the in-flight device flow (if any) under `deviceFlow`.
> - `github.connect` starts the flow (or returns the **same codes** while one is still pending —
>   idempotent); terminal transitions are pushed as `github:auth-changed` events (§6.5).
> - `github.cancelAuth` aborts a pending flow; `github.revoke` deletes the **stored** token (env /
>   `gh` fallbacks are untouched — they re-resolve on the next probe).
> - **Identity** is GitHub-derived: `github.getUser` returns the authenticated user from `GET /user`.
>
> **🔒 Secret guardrail.** The PAT is a secret: it is **never logged, echoed, or returned** over the
> wire. Only **derived identity** fields (login, avatar, profile URL) and the boolean
> connection state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `shared/types.ts` GitHub shapes
(`GithubRepo` / `GithubUser` / `GithubPullRequest` / `GithubIssue`, and the review-comment /
review-thread shapes) **field-for-field**, rendered in this protocol's **camelCase** convention
(serde `rename_all = "camelCase"`, matching `pr.*` in §5.7 and the rest of the catalog). The FE's
Augment-proxy passthrough exposed GitHub-native **snake_case**; on the `github.*` wire those keys
are normalized to camelCase: `html_url → htmlUrl`, `created_at → createdAt`, `updated_at → updatedAt`,
`merged_at → mergedAt`, `closed_at → closedAt`, `default_branch → defaultBranch`, `head_ref → headRef`,
`base_ref → baseRef`, `head_sha → headSha`, `base_sha → baseSha`, `mergeable_state → mergeableState`,
`review_comments → reviewComments`, `changed_files → changedFiles`, `avatar_url → avatarUrl`,
`in_reply_to_id → inReplyToId`. The set of fields is otherwise identical to the FE types.

**Conventions.** Unless noted, `owner` + `repo` are **(req)** string params (and `number` is the
**(req)** PR/issue number where applicable). Reads that paginate follow the uniform pagination
contract: an optional `limit` (default **50**, max **200**) plus an opaque `nextToken` cursor echoed
in the result (`nextToken: null` when there are no further pages). Errors reuse the §9 conventions:
missing/invalid params and "not found" (404) lookups → `-32602` **unless a method row documents a
graceful null/exists result** (e.g. `github.repos.get` → `{ repo: null }`, `github.repoConfig.get`
→ `{ config: null, exists: false }`); a token that is absent or fails `GET /user`, and any other
GitHub/service failure → `-32603` with a descriptive `message`
(e.g. `"GitHub is not configured."`). There are **no** custom numeric codes.

#### Repos & branches

| Method | Params | Result |
| --- | --- | --- |
| github.repos.list | limit?, nextToken? | { repos: GithubRepo[], nextToken? } — the authenticated user's repositories (`GET /user/repos`) |
| github.repos.search | query (req), limit?, nextToken? | { repos: GithubRepo[], nextToken? } — `GET /search/repositories` (FE rewrites `owner/name` → `name user:owner`, sorted by stars) |
| github.repos.get | owner (req), repo (req) | { repo: GithubRepo \| null } — `GET /repos/{owner}/{repo}` (repo metadata incl. `defaultBranch`) |
| github.branches.list | owner (req), repo (req), prefix?, limit?, nextToken? | { branches: string[], nextToken? } — **remote** branch names. Absent or blank `prefix` → the unfiltered listing (`GET /repos/{owner}/{repo}/branches`), paged upstream exactly as before. A non-blank `prefix` → server-side prefix search via the git refs API (`GET /repos/{owner}/{repo}/git/matching-refs/heads/{prefix}`; slashes in the prefix preserved as path separators, other characters percent-encoded), mapping `refs/heads/<name>` onto branch names — GitHub ignores `per_page`/`page` on that endpoint and returns the entire match set, so the daemon applies the `(limit, nextToken)` window client-side (an exactly-full final page ends with no `nextToken`; pages past the end are empty). Response shape is unchanged either way (prefix intentd#1081) |
| github.branches.listCached | owner (req), repo (req) | { cached: boolean, source?: "cache" \| "ls-remote", branches: string[], defaultBranch? } — **cached-first with a one-shot ls-remote fallback**: a warm cache serves branch names from the daemon's local repo cache (`.repo-cache/{owner}/{repo}`) with no network I/O — remote-tracking names (`refs/remotes/origin/*`, the `HEAD` symref excluded), sorted, as `{ cached: true, source: "cache", … }`; `defaultBranch` derives from the `origin/HEAD` symref — recorded at clone time and re-resolved on every cache refresh (`git remote set-head origin --auto`), so it tracks upstream default-branch changes — and is **omitted when unresolvable**. A cold cache or foreign-origin repo falls back to a single `git ls-remote --symref` against the GitHub remote (token offered via env like the clone pipeline, never argv; intentd#1072) → `{ cached: false, source: "ls-remote", branches, defaultBranch? }` — branch short names sorted, `defaultBranch` from the remote `HEAD` symref (omitted when not advertised). A failed fallback (offline, missing repo, no access) → `{ cached: false, branches: [] }` with `source` omitted — graceful, **never an error** (an explicit exception to the namespace's error conventions above, like `github.repoConfig.get`); invalid `owner`/`repo` path segments → `-32602`. FE consumption is cached-first: the branch picker renders a warm-cache result instantly, and the fallback means a cold cache still paints real branches; `github.branches.list` (and the repo's `defaultBranch`) remain the paged authoritative read (v6.2; fallback + additive `source` field intentd#1072) |
| github.repoConfig.get | owner (req), repo (req), ref? | { config: RepoConfig \| null, exists: boolean } — the repo's `.intent/config.json` fetched via the contents API (`GET /repos/{owner}/{repo}/contents/.intent/config.json`, no clone; `ref` defaults to the default branch). A missing file (or missing repo/ref) → `{ config: null, exists: false }` — an **explicit exception** to the namespace's 404→`-32602` convention above: all 404s are graceful "no config" outcomes, never errors (transport/auth failures still surface as `-32603` like the other `github.*` methods). A present but invalid/mis-shaped file folds **tolerantly** to `{ config: {}, exists: true }` (mirrors the `repoConfig.get` §5.33 parse semantics). Same camelCase `RepoConfig` shape as §5.33, unknown keys preserved (v2.4) |

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| github.authStatus | — | { isConfigured, oauthUrl, configuredButNeedsUpdate, updatedScopes, deviceFlow } — `isConfigured` = a token resolves **and** `GET /user` succeeds. `deviceFlow` is `null` when no flow is in flight, else `{ status: "pending"\|"expired"\|"denied"\|"error", userCode, verificationUri, expiresIn, interval }`; while a flow is live `oauthUrl` carries the `verificationUri` (FE shape parity). `configuredButNeedsUpdate` is `false` and `updatedScopes` is `""` (kept for FE shape parity) |
| github.connect | — | { ok: true, userCode, verificationUri, expiresIn, interval } — starts the OAuth **device flow** (or returns the SAME codes while one is pending — idempotent). The daemon polls GitHub in the background; terminal transitions arrive as `github:auth-changed` events (§6.5). A missing/empty `sourceControl.github.oauthClientId` or an unreachable login host → `-32603` |
| github.cancelAuth | — | { ok: true, cancelled } — aborts a pending device flow (`cancelled: true` iff one was pending; idempotent no-op otherwise) |
| github.revoke | — | { ok: true } — deletes the **stored** `sourceControl.github.token` and aborts any in-flight flow; emits `github:auth-changed { status: "revoked" }`. Idempotent; env / `gh` fallbacks are untouched. Also best-effort logs a locally installed `gh` out of github.com, but **only** when gh's active token exactly matches the token being revoked — i.e. the login the authorize-side sync created; any other gh login is never touched, and a logout failure never affects the revoke (behavior-only, no wire-shape change) |
| github.getUser | — | { user: GithubUser \| null } — authenticated identity from `GET /user`; never includes the token |

#### Pulls

`createPullRequest` sends `head` **verbatim** (no `owner:branch` login prefix) — preserving the
FE's "bypass the buggy backend" behavior for same-repo branches.

| Method | Params | Result |
| --- | --- | --- |
| github.pulls.create | owner (req), repo (req), title (req), body (req), head (req), base (req), draft? | { pull: GithubPullRequest \| null } — `POST /repos/{owner}/{repo}/pulls` (head verbatim) |
| github.pulls.get | owner (req), repo (req), number (req) | { pull: GithubPullRequest \| null } — `GET /repos/{owner}/{repo}/pulls/{number}` |
| github.pulls.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", head?, base?, sort?: "created"\|"updated"\|"popularity"\|"long-running", direction?: "asc"\|"desc", limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /repos/{owner}/{repo}/pulls` |
| github.pulls.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"review-requested"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /search/issues?q=is:pr repo:{o}/{r} is:{state} {author\|assignee\|review-requested\|involves}:@me {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter:"all"`+`state:"open"` with no `query` delegates to `github.pulls.list` |
| github.pulls.merge | owner (req), repo (req), number (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | { merged, message, sha? } — `PUT /repos/{owner}/{repo}/pulls/{number}/merge` |
| github.pulls.updateBranch | owner (req), repo (req), number (req), expectedHeadSha? | { message, url? } — `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` |

#### Issues

| Method | Params | Result |
| --- | --- | --- |
| github.issues.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", assignee?, creator?, labels?, sort?: "created"\|"updated"\|"comments", direction?: "asc"\|"desc", limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /repos/{owner}/{repo}/issues` (items carrying `pull_request` are filtered out) |
| github.issues.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /search/issues?q=is:issue repo:{o}/{r} [state:{state}] {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter` is validated (invalid → `-32603`) but — unlike `github.pulls.search` — adds **no** `@me` qualifier yet (v1 limitation: the engine cannot express issue involvement), so only a non-blank `query` routes through `GET /search/issues`; without one the method delegates to the repo-issue listing (`GET /repos/{o}/{r}/issues`) filtered by state, regardless of `filter` |

#### Review comments & threads

Review **comments** are the REST inline comments (`/pulls/{n}/comments`); review **threads** are the
GraphQL `pullRequest.reviewThreads` with resolve state — `resolveThread` / `unresolveThread` map to
the GraphQL `resolveReviewThread` / `unresolveReviewThread` mutations (parity with the FE's
`pr-comment.service.ts`).

| Method | Params | Result |
| --- | --- | --- |
| github.listReviewComments | owner (req), repo (req), number (req), limit?, nextToken? | { comments: ReviewComment[], nextToken? } — `GET /repos/{owner}/{repo}/pulls/{number}/comments` |
| github.replyReviewComment | owner (req), repo (req), number (req), commentId (req), body (req) | { comment: ReviewComment } — `POST /repos/{owner}/{repo}/pulls/{number}/comments` (`inReplyToId = commentId`) |
| github.getReviewThreads | owner (req), repo (req), number (req), limit?, nextToken? | { threads: ReviewThread[], nextToken? } — GraphQL `pullRequest.reviewThreads` |
| github.resolveThread | threadId (req) | { isResolved: true } — GraphQL `resolveReviewThread` |
| github.unresolveThread | threadId (req) | { isResolved: false } — GraphQL `unresolveReviewThread` |

#### DTO schemas

```ts
interface GithubRepo {
  owner: string;
  name: string;
  htmlUrl?: string;
  createdAt?: string;     // ISO 8601
  updatedAt?: string;     // ISO 8601
  defaultBranch?: string;
}

interface GithubUser {     // derived identity — never carries the PAT
  login: string;
  avatarUrl: string;
  htmlUrl: string;
}

interface GithubPullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  user: GithubUser;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  draft: boolean;
  mergeable?: boolean | null;
  mergeableState?: string;
  labels: string[];
  assignees?: GithubUser[];
  comments: number;
  reviewComments: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  user: GithubUser;
  labels: string[];
  comments: number;
  owner?: string;          // repository owner (echoed for convenience)
  repo?: string;           // repository name
}

interface ReviewComment {  // REST inline review comment
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
  inReplyToId?: number;
  htmlUrl: string;
}

interface ReviewThread {   // GraphQL review thread
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

interface ReviewThreadComment {
  id: string;
  body: string;
  author: { login: string };
  path: string;
  line: number | null;
  createdAt: string;
}
```

#### Examples

```json
// → check GitHub auth (validates the resolved token via GET /user)
{ "jsonrpc":"2.0","id":50,"method":"github.authStatus","params":{} }
// ← response (token present and valid, no flow in flight)
{ "jsonrpc":"2.0","id":50,"result":{
  "isConfigured": true, "oauthUrl": "", "configuredButNeedsUpdate": false, "updatedScopes": "",
  "deviceFlow": null } }
```

```json
// → derived identity (no token ever returned)
{ "jsonrpc":"2.0","id":51,"method":"github.getUser","params":{} }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "user":{
  "login":"octocat","avatarUrl":"https://avatars.githubusercontent.com/u/1","htmlUrl":"https://github.com/octocat" } } }
```

```json
// → create a PR with the head ref sent verbatim (no login prefix)
{ "jsonrpc":"2.0","id":52,"method":"github.pulls.create",
  "params":{ "owner":"octocat","repo":"hello","title":"Add feature","body":"…",
    "head":"feature/x","base":"main","draft":false } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "pull":{
  "number":42,"title":"Add feature","state":"open","htmlUrl":"https://github.com/octocat/hello/pull/42",
  "headRef":"feature/x","baseRef":"main","draft":false,"merged":false,
  "user":{ "login":"octocat","avatarUrl":"…","htmlUrl":"…" } } } }
```

```json
// → start the OAuth device flow (daemon polls GitHub in the background)
{ "jsonrpc":"2.0","id":53,"method":"github.connect","params":{} }
// ← response — the user enters userCode at verificationUri
{ "jsonrpc":"2.0","id":53,"result":{
  "ok": true, "userCode": "ABCD-1234", "verificationUri": "https://github.com/login/device",
  "expiresIn": 900, "interval": 5 } }
// … the user authorizes on github.com; the daemon's background poll persists
//   the token server-side and pushes the terminal transition:
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"…","event":{
  "type":"github:auth-changed", "data":{ "status":"authorized" }, "…":"…" } } }
```

### 5.28 `linear.*` namespace

> The full `linear.*` read surface — `linear.authStatus`, `linear.listIssues`, `linear.searchIssues`, `linear.getIssue`, `linear.viewer`, `linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`, `linear.listLabels` — plus the issue-write methods `linear.createIssue` / `linear.updateIssue` are served **daemon-owned** against Linear's GraphQL API (`POST https://api.linear.app/graphql`) via the `intent-linear` crate. The `filter` values map to **typed Linear GraphQL filters server-side**. Only the `linear.listComments` / `linear.createComment` comment surface (no FE shape) remains out of scope — see "Deferred — comments" below. The field names and shapes here are the source of truth for both sides.

> **Auth model — personal API key (no OAuth/device flow).** A local
> daemon has no hosted OAuth callback, so v1 authenticates with a **Linear personal API key**: the
> default `auto` resolution tries the secret-store account `linear.token` first (the daemon's
> file-backed secret store; settable via `settings.update { path: "linear.token" }`, §5.12), then falls back to the
> `LINEAR_API_KEY` environment variable. Linear is GraphQL-only; the key is sent as the **`Authorization: <key>` header
> with NO `Bearer` prefix** for `lin_api_…` personal keys (a future OAuth access token would use
> `Authorization: Bearer <token>` — the prefix differs by credential type).
>
> - `linear.authStatus` validates the resolved key via the GraphQL `viewer` probe and reports
>   connection state.
> - **There is no `linear.connect` / `linear.revoke` / `cancelAuth` wire method.** Unlike `github.*`
>   (which keeps inert no-op `connect`/`revoke` for FE shape parity), Linear exposes **nothing**
>   here: "connect" is `settings.update` on the `linear.token` catalog entry (§5.12) — or set
>   `LINEAR_API_KEY` — "revoke/logout" is `settings.reset { path: "linear.token" }`, and
>   `cancelAuth` was always a pure client-side no-op.
>
> **🔒 Secret guardrail.** The API key is a secret: it is **never logged, echoed, or returned** over
> the wire. Only **derived identity** (the `login` from `viewer`) and the boolean connection state
> cross the wire — never the key itself.

**Field naming.** The DTOs below mirror the FE `src/features/linear-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all = "camelCase"`,
matching `github.*` §5.27 and the rest of the catalog). The wire returns the **flattened
`LinearIssueResult`** — the exact shape the FE's `fetchMyIssues` / `searchIssues` already consume —
so the rewire is zero-FE-change: nested Linear relations (`team` / `state` / `assignee` / `creator`
/ `project` / `labels`) are pre-flattened to scalar / `string[]` fields server-side. Absent
(`None`) optional fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). The two issue reads — `linear.listIssues` and `linear.searchIssues` — are
**cursor-paginated** per the §5.5 conventions: they accept an optional **opaque base64**
`nextToken` (the token echoed by a previous page; a malformed token degrades to the first
page, matching the `github.*` reads) and return a
`{ issues: LinearIssueResult[], nextToken: string|null }` envelope where `nextToken` is an
opaque base64 string when another page exists and an explicit `null` on the last page. The
underlying Linear GraphQL `pageInfo.endCursor` / `after` cursor is a server-side detail
clients MUST treat as opaque. Every other Linear arm returns a **bare result** — either a
bare object (`linear.authStatus`, `linear.viewer`, `linear.getIssue`) or a bare array
(`linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`,
`linear.listLabels`) — with **no envelope and no cursor** (those catalogs are small and
bounded). Absent (`None`) optional fields are **omitted** from the JSON. Errors reuse the §9
conventions: missing/invalid params → `-32602` (e.g. `linear.getIssue` requires `id` **or**
`identifier`, otherwise `Missing required parameter: id`); a key that is **absent or fails the
`viewer` probe** ("not configured"), and any other Linear/service failure → `-32603` with a
descriptive `message` (e.g. `"Linear is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| linear.authStatus | — | { authenticated, login?, scopes } — `authenticated` = env key resolves **and** the GraphQL `viewer { id name email }` probe succeeds; `login` is the viewer's name/email; `scopes` is always `[]` (Linear's `viewer` returns no key scopes). Never includes the key. |

#### Issues

`filter` maps to a typed Linear GraphQL filter **server-side**.
`linear.listIssues` backs the FE's `fetchMyIssues`; `linear.searchIssues`
backs the FE's `searchIssues`. Both return the paginated `{ issues, nextToken }` envelope
(see Conventions above): pass the returned `nextToken` back as a param to fetch the next page.
`linear.getIssue` resolves a single flattened `LinearIssueResult` by UUID `id` **or** `ENG-123`-style
`identifier` (the engine picks the lookup mode by string shape); it is not consumed by the FE today
but completes the read surface.

| Method | Params | Result |
| --- | --- | --- |
| linear.listIssues | filter?: "assigned"\|"created"\|"subscribed"\|"team"\|"all" (default "assigned"), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — the authenticated viewer's issues for the typed `filter`; `nextToken` is an opaque base64 string when another page exists, else `null` |
| linear.searchIssues | query (req), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — full-text issue search, same cursor semantics |
| linear.getIssue | id \| identifier (one required — UUID `id` or `ENG-123`-style `identifier`) | LinearIssueResult — one flattened issue |

#### Viewer & catalogs

`linear.viewer` returns the authenticated user as a bare `LinearUser`; the four list methods return
small bounded catalogs (teams, workflow states, projects, labels) as bare DTO arrays. All four
lists accept an optional `limit`. None of these reads are currently consumed by the FE — they are
forward-looking surface for a future create/edit UI.

| Method | Params | Result |
| --- | --- | --- |
| linear.viewer | — | LinearUser — the authenticated user |
| linear.listTeams | limit? | LinearTeam[] |
| linear.listWorkflowStates | limit? | LinearWorkflowState[] |
| linear.listProjects | limit? | LinearProject[] |
| linear.listLabels | limit? | LinearLabel[] |

#### DTO schemas

```ts
interface AuthStatus {          // shared with the auth probe; never carries the API key
  authenticated: boolean;
  login?: string;               // viewer name or email
  scopes: string[];             // always [] — Linear's viewer returns no key scopes
}

interface LinearIssueResult {   // flattened UI shape — matches the FE verbatim
  id: string;
  identifier: string;           // e.g. "ENG-123"
  title: string;
  description?: string;
  url?: string;
  teamName?: string;
  teamKey?: string;             // e.g. "ENG"
  state?: string;               // workflow-state name
  priority?: number;            // Linear priority 0–4
  assignee?: string;            // assignee display name
  labels?: string[];            // label names
  project?: string;             // project name
  creator?: string;             // creator name
  createdAt?: string;           // ISO 8601
  updatedAt?: string;           // ISO 8601
}

interface LinearUser {          // linear.viewer
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

interface LinearTeam {          // linear.listTeams entry
  id: string;
  key: string;                  // e.g. "ENG"
  name: string;
  description?: string;
}

interface LinearWorkflowState { // linear.listWorkflowStates entry
  id: string;
  name: string;
  type: string;                 // "backlog" | "unstarted" | "started" | "completed" | "canceled"
  description?: string;
  color?: string;
}

interface LinearProject {       // linear.listProjects entry
  id: string;
  name: string;
  description?: string;
  state: string;                // "backlog" | "planned" | "started" | "paused" | "completed" | "canceled"
  url?: string;
}

interface LinearLabel {         // linear.listLabels entry
  id: string;
  name: string;
  description?: string;
  color?: string;
}
```

#### Examples

```json
// → check Linear auth (validates the env key via the GraphQL viewer probe)
{ "jsonrpc":"2.0","id":54,"method":"linear.authStatus","params":{} }
// ← response (LINEAR_API_KEY present and valid)
{ "jsonrpc":"2.0","id":54,"result":{ "authenticated": true, "login": "Ada Lovelace", "scopes": [] } }
```

```json
// → issues assigned to the authenticated viewer (typed filter, no NL prompt)
{ "jsonrpc":"2.0","id":55,"method":"linear.listIssues","params":{ "filter":"assigned","limit":50 } }
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":55,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamName":"Engineering","teamKey":"ENG","priority":2,"assignee":"Ada Lovelace",
    "labels":["bug"],"url":"https://linear.app/acme/issue/ENG-123" } ],
  "nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":56,"method":"linear.searchIssues","params":{ "query":"widget","limit":20,"nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":56,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","teamKey":"ENG",
    "url":"https://linear.app/acme/issue/ENG-123" } ], "nextToken":null } }
```

```json
// → one issue by ENG-123 identifier (or pass `id` for a UUID)
{ "jsonrpc":"2.0","id":57,"method":"linear.getIssue","params":{ "identifier":"ENG-123" } }
// ← response (single flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":57,"result":
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamKey":"ENG","url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → the authenticated user
{ "jsonrpc":"2.0","id":58,"method":"linear.viewer","params":{} }
// ← response (bare LinearUser; absent optionals omitted)
{ "jsonrpc":"2.0","id":58,"result":
  { "id":"u1","name":"Ada Lovelace","displayName":"ada","email":"ada@example.com" } }
```

```json
// → list teams (bare array; optional limit caps the result)
{ "jsonrpc":"2.0","id":59,"method":"linear.listTeams","params":{ "limit":50 } }
// ← response (bare LinearTeam[])
{ "jsonrpc":"2.0","id":59,"result":[
  { "id":"t1","key":"ENG","name":"Engineering" } ] }
```

#### Writes — P2 (createIssue / updateIssue)

`linear.createIssue` runs the `issueCreate` GraphQL mutation; `linear.updateIssue` runs
`issueUpdate`. The router validates the required wire fields up front — `createIssue` requires a
non-empty `title` **and** `teamId`, `updateIssue` requires a non-empty `issueId` (otherwise
`-32602` `Missing required parameter: <field>`) — and forwards only the fields present. Both return
the **flattened `LinearIssueResult`** (the same shape as the reads). A key that is **absent or
fails the `viewer` probe** ("not configured"), and any other Linear/service failure → `-32603`.
🔒 The API key is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| linear.createIssue | title (req), teamId (req), description?, assigneeId?, stateId?, priority?, labelIds? | LinearIssueResult — the created issue, flattened |
| linear.updateIssue | issueId (req), title?, description?, assigneeId?, stateId?, priority? | LinearIssueResult — the updated issue, flattened |

##### DTO schemas

```ts
interface CreateIssueRequest {  // linear.createIssue — `title` + `teamId` required
  title: string;
  teamId: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
  labelIds?: string[];
}

interface UpdateIssueRequest {  // linear.updateIssue — `issueId` required; rest optional
  issueId: string;
  title?: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
}
```

##### Examples

```json
// → create an issue (title + teamId required)
{ "jsonrpc":"2.0","id":60,"method":"linear.createIssue",
  "params":{ "title":"New issue","teamId":"team-uuid","priority":2,"labelIds":["l1"] } }
// ← response (flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":60,"result":
  { "id":"a1b2","identifier":"ENG-200","title":"New issue","teamKey":"ENG","priority":2,
    "url":"https://linear.app/acme/issue/ENG-200" } }
```

```json
// → missing required `teamId` → -32602
{ "jsonrpc":"2.0","id":61,"method":"linear.createIssue","params":{ "title":"X" } }
// ← error
{ "jsonrpc":"2.0","id":61,"error":{ "code":-32602,"message":"Missing required parameter: teamId" } }
```

```json
// → update an issue (issueId required; only present fields are sent through IssueUpdateInput)
{ "jsonrpc":"2.0","id":62,"method":"linear.updateIssue",
  "params":{ "issueId":"uuid-1","title":"Updated","stateId":"s1" } }
// ← response (flattened LinearIssueResult)
{ "jsonrpc":"2.0","id":62,"result":
  { "id":"uuid-1","identifier":"ENG-123","title":"Updated","state":"Done",
    "url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → not-configured (no LINEAR_API_KEY, or the viewer probe fails) → -32603
{ "jsonrpc":"2.0","id":63,"method":"linear.createIssue","params":{ "title":"X","teamId":"t1" } }
// ← error
{ "jsonrpc":"2.0","id":63,"error":{ "code":-32603,"message":"Linear is not configured." } }
```

#### Deferred — comments (NOT in this phase)

The read surface (P0 + P1) and the P2 issue writes ship now (above). Only the comment surface
remains **out of scope** and is listed so it is anticipated:

- **Comments (no FE shape):** `linear.listComments` / `linear.createComment` — comments are not
  modeled in the FE at all. Do **not** build unless a feature requires them.

When built, the comment methods extend this `linear.*` namespace additively (with their own §9
error rows and any events) and do not change the contract above.

### 5.29 `sentry.*` namespace

> The full `sentry.*` surface — the reads
> `sentry.authStatus`, `sentry.listIssues`, `sentry.searchIssues`,
> `sentry.listProjects`, `sentry.getIssue`; and the writes `sentry.resolveIssue`,
> `sentry.ignoreIssue`, `sentry.assignIssue` — is served **daemon-owned** against Sentry's REST
> API (`GET https://sentry.io/api/0/organizations/{org}/issues/`) via the `intent-sentry`
> crate (wire arm: `intent-services` `sentry_ops` → `intent-transport` router). The `status`
> filter maps to a **typed `is:<status>` clause** server-side, and `query` is forwarded
> verbatim as the Sentry search string. The field names and shapes here are the source of
> truth for both sides.

> **Auth model — token + org from the environment (no OAuth/device flow, no
> `connect`/`revoke`).** A local daemon has no hosted OAuth callback, so v1 authenticates with
> a **Sentry user/internal-integration auth token + organization slug resolved from the
> environment**: `SENTRY_API_TOKEN` (with an optional lower-priority secret-store account
> `sentry.token`) plus `SENTRY_ORG` (organization slug). Sentry is REST-only; the token is sent
> as the **`Authorization: Bearer <token>`** header.
>
> - `sentry.authStatus` validates the resolved pair via `GET /organizations/{org}/` and reports
>   connection state.
> - **There is no `sentry.connect` / `sentry.revoke` / `cancelAuth` wire method.** As with
>   `linear.*`, Sentry exposes **nothing** here: "connect" becomes "set `SENTRY_API_TOKEN` +
>   `SENTRY_ORG` and restart", "revoke/logout" is a local "forget token" action, and `cancelAuth`
>   was always a pure client-side no-op. The settings UI buttons are inert.
>
> **🔒 Secret guardrail.** The auth token is a secret: it is **never logged, echoed, or returned**
> over the wire. Only **derived identity** (the `organization` slug) and the boolean connection
> state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `src/features/sentry-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all =
"camelCase"`, matching `github.*` §5.27 / `linear.*` §5.28 and the rest of the catalog). The
wire returns the **flattened `SentryIssueResult`** — the exact shape the FE's `fetchIssues` /
`searchIssues` already consume — so the rewire is zero-FE-change: nested Sentry relations
(`project` → `projectName`/`projectSlug`, `metadata` → `type`/`value`/`filename`/`function`,
`permalink` → `url`) are pre-flattened to scalar fields server-side. Absent (`None`) optional
fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). The two issue reads — `sentry.listIssues` and `sentry.searchIssues` — are
**cursor-paginated** per the §5.5 conventions (parity with `linear.listIssues` /
`linear.searchIssues`, §5.28): they accept an optional **opaque base64** `nextToken` (the
token echoed by a previous page; a malformed token degrades to the first page, matching the
`github.*` reads) and return a `{ issues: SentryIssueResult[], nextToken: string|null }`
envelope where `nextToken` is an opaque base64 string when another page exists and an
explicit `null` on the last page. The underlying Sentry `Link`-header page cursor is a
server-side detail clients MUST treat as opaque. Every other Sentry arm returns a **bare
result** — either a bare object (`sentry.authStatus`, `sentry.getIssue`, the P2 writes) or a
bare array (`sentry.listProjects`) — with **no envelope and no cursor**. Absent (`None`)
optional fields are **omitted** from the JSON.
Errors reuse the §9 conventions: missing/invalid params → `-32602` (e.g. `sentry.searchIssues`
requires `query`, otherwise `Missing required parameter: query`; an invalid `status` not in
`unresolved`|`resolved`|`ignored`|`all` → `Invalid params: status must be one of: unresolved,
resolved, ignored, all`); a credential pair that is **absent or fails the org probe** ("not
configured"), and any other Sentry/service failure → `-32603` with a descriptive `message`
(e.g. `"Sentry is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| sentry.authStatus | — | { authenticated, organization?, error? } — `authenticated` = env credential pair resolves **and** the `GET /organizations/{org}/` probe succeeds; `organization` is the resolved org slug (derived identity only — never the token); `error` is a descriptive failure string when the probe fails. Never includes the token. |

#### Issues

`status` maps to a typed `is:<status>` clause **server-side**;
`query` is forwarded verbatim as the Sentry search string.
`sentry.listIssues` backs the FE's `fetchIssues`; `sentry.searchIssues` backs the FE's
`searchIssues`. Both return the paginated `{ issues, nextToken }` envelope (see Conventions
above): pass the returned `nextToken` back as a param to fetch the next page.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listIssues | project?, status?: "unresolved"\|"resolved"\|"ignored"\|"all" (default "unresolved"; any other value → `-32602`), query?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — issues matching the typed `is:<status>` clause (combined with optional `project` slug and free-text `query`); `nextToken` is an opaque base64 string when another page exists, else `null` |
| sentry.searchIssues | query (req — missing → `-32602`), project?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — full-text issue search, same cursor semantics |
| sentry.getIssue | id \| shortId (one required — UUID/numeric `id` or `WEB-1`-style `shortId`; both missing → `-32602`) | SentryIssueResult — one flattened issue |

#### Projects (P1)

`sentry.listProjects` returns the configured organization's projects as a bare `SentryProject[]`
(parity with `linear.listTeams` / `linear.listProjects`); it accepts an optional `limit`. Not
consumed by the FE today — forward-looking surface for a future project picker.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listProjects | limit? | SentryProject[] |

#### Writes — P2 (resolve / ignore / assign)

`sentry.resolveIssue` / `sentry.ignoreIssue` mutate the issue's status (`resolved` / `ignored`);
`sentry.assignIssue` sets the assignee. All three require a **non-empty `id`** (otherwise `-32602`
`Missing required parameter: id`); `assignIssue`'s `assignedTo` is **optional — an absent value
unassigns** the issue. Each returns the updated flattened `SentryIssueResult`. A credential pair
that is **absent or fails the org probe** ("not configured"), and any other Sentry/service failure
→ `-32603`. 🔒 The auth token is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| sentry.resolveIssue | id (req) | SentryIssueResult — the issue with `status: "resolved"` |
| sentry.ignoreIssue | id (req) | SentryIssueResult — the issue with `status: "ignored"` |
| sentry.assignIssue | id (req), assignedTo? (absent = unassign) | SentryIssueResult — the issue after (un)assignment |

#### DTO schemas

```ts
interface SentryAuthState {       // shared with the auth probe; never carries the token
  authenticated: boolean;
  organization?: string;          // resolved org slug (derived identity only)
  error?: string;                 // descriptive failure when the probe fails
}

interface SentryProject {         // sentry.listProjects entry
  id: string;
  slug: string;
  name: string;
  platform?: string;
  isMember?: boolean;
}

interface SentryIssueResult {     // flattened UI shape — matches the FE verbatim
  id: string;
  shortId: string;                // e.g. "PROJ-1"
  title: string;
  culprit?: string;
  status: "unresolved" | "resolved" | "ignored";
  level: "error" | "warning" | "info" | "fatal" | "debug";
  count: string;                  // total event count (Sentry returns a string)
  userCount: number;
  firstSeen: string;              // RFC-3339
  lastSeen: string;               // RFC-3339
  projectName: string;
  projectSlug: string;
  url?: string;                   // Sentry `permalink`
  type?: string;                  // metadata.type, e.g. "TypeError"
  value?: string;                 // metadata.value
  filename?: string;              // metadata.filename
  function?: string;              // metadata.function
}
```

#### Examples

```json
// → check Sentry auth (validates the env credential pair via the GET /organizations/{org}/ probe)
{ "jsonrpc":"2.0","id":70,"method":"sentry.authStatus","params":{} }
// ← response (SENTRY_API_TOKEN + SENTRY_ORG present and valid)
{ "jsonrpc":"2.0","id":70,"result":{ "authenticated": true, "organization": "acme" } }
```

```json
// → unresolved issues across the org (typed `is:unresolved` clause, no NL prompt)
{ "jsonrpc":"2.0","id":71,"method":"sentry.listIssues","params":{ "status":"unresolved","limit":50 } }
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":71,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "type":"TypeError","filename":"src/app.ts",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ],
  "nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":72,"method":"sentry.searchIssues","params":{ "query":"TypeError","limit":20,"nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":72,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ], "nextToken":null } }
```

```json
// → missing required `query` → -32602
{ "jsonrpc":"2.0","id":73,"method":"sentry.searchIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":73,"error":{ "code":-32602,"message":"Missing required parameter: query" } }
```

```json
// → invalid `status` → -32602 (verbatim message)
{ "jsonrpc":"2.0","id":74,"method":"sentry.listIssues","params":{ "status":"bogus" } }
// ← error
{ "jsonrpc":"2.0","id":74,"error":{
  "code":-32602,"message":"status must be one of: unresolved, resolved, ignored, all" } }
```

```json
// → not-configured (no SENTRY_API_TOKEN/SENTRY_ORG, or org probe fails) → -32603
{ "jsonrpc":"2.0","id":75,"method":"sentry.listIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":75,"error":{ "code":-32603,"message":"Sentry is not configured." } }
```

```json
// → one issue by shortId (or pass `id` for a UUID/numeric id)
{ "jsonrpc":"2.0","id":76,"method":"sentry.getIssue","params":{ "shortId":"WEB-1" } }
// ← response (single flattened SentryIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":76,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → getIssue with neither `id` nor `shortId` → -32602
{ "jsonrpc":"2.0","id":77,"method":"sentry.getIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":77,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

```json
// → list the org's projects (bare SentryProject[]; optional limit caps the result)
{ "jsonrpc":"2.0","id":78,"method":"sentry.listProjects","params":{ "limit":25 } }
// ← response (bare SentryProject[]; absent optionals omitted)
{ "jsonrpc":"2.0","id":78,"result":[
  { "id":"1","slug":"web","name":"Web","platform":"javascript","isMember":true } ] }
```

```json
// → resolve an issue (id required) → updated flattened issue with status "resolved"
{ "jsonrpc":"2.0","id":79,"method":"sentry.resolveIssue","params":{ "id":"1" } }
// ← response
{ "jsonrpc":"2.0","id":79,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"resolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → assign an issue; omit `assignedTo` to unassign
{ "jsonrpc":"2.0","id":80,"method":"sentry.assignIssue","params":{ "id":"1","assignedTo":"user-1" } }
// ← response (updated flattened SentryIssueResult)
{ "jsonrpc":"2.0","id":80,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → a write with a missing/empty `id` → -32602
{ "jsonrpc":"2.0","id":81,"method":"sentry.resolveIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":81,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

### 5.30 `models.list` — model catalog

The BE-owned model catalog every FE model picker reads (ModelPicker, background-agent settings,
workspace initializers, onboarding). It is the **richer, additive sibling** of `agent.getModels`
(§5.5), which keeps its lean `{ id, name, provider, description? }` rows unchanged.

| Method | Params | Result |
| --- | --- | --- |
| models.list | providerId?, forceRefresh?: boolean (default false) — no `workspaceId` | without `providerId`: { models: ModelInfo[], source: "auggie" \| "static", stale?, warning? }; with `providerId`: { providerId, models: ModelInfo[], source, stale?, warning? } |

**ModelInfo** — `{ id, name, provider, description?, modelGroupPriority?: number, costTier?: number, badges?: [{ color, label, variant? }], effortLevels?: string[], isDefault?: boolean, priority?: number }`.
`id` is the bare model id (`shortName`/`value`), `name` the display label
(`displayName`/`label`); the optional fields carry the picker metadata clients
consume (group/within-group ordering, cost tier `1..3`, badges, effort levels,
default flag). Optional fields are omitted when the provider does not report them.
`effortLevels` (v5.2) is the model's reasoning-effort vocabulary — the values a
client may offer for the `reasoningEffort` session field (§5.5) and the evidence
the daemon validates delegation/create-time levels against (§5.11 "Delegation
reasoning-effort resolution"). It is sourced from the adapter-advertised
`supportedEffortLevels` on the raw ACP model entry, with codex's known
effort-capable base models falling back to their fixed level set; effort-capable
models are served as **one base row** carrying the list — the pre-5.2 codex
`{model}/{effort}` variant rows are retired. Catalog `effortLevels` are
static/probe metadata, distinct from the session-scoped `effortLevels` served on
the `AgentSession`/`AgentLite` projections (§5.5 "Session-discovered effort
levels") — clients prefer the session-advertised levels for a live session's
picker and fall back to the catalog when the session advertises none.

**Per-provider catalog.**

```jsonc
// → request
{
  "providerId": "auggie",  // optional — per-provider catalog via the generic cache
  "forceRefresh": false    // optional, default false — skip the cache read, await a fresh probe
}
// ← response (with providerId)
{
  "providerId": "auggie",
  "models": [ /* ModelInfo rows */ ],
  "source": "auggie",          // the provider id, or "static" on fallback
  "stale": true,               // optional — present only when serving last-good after a failed probe
  "warning": "..."             // optional — human-readable reason for fallback/stale/empty data
}
```

**Semantics:**

- **One generic per-provider cache.** All `models.list` requests — with or without `providerId` — go through a shared cache keyed on `(providerId, versionKey)`, persisted in the daemon data dir (`models-cache.json`) so it survives restarts. Cached entries have **no TTL** and are served indefinitely (behavior within v6.0, [intent-hq/intentd#987](https://github.com/intent-hq/intentd/pull/987) — previously a 5-minute TTL). The version key is registry-defined per provider (e.g. the full pinned npx package spec for claude-code); a pin bump (or package rename) invalidates cached entries automatically — the only automatic invalidation. The no-`providerId` legacy path resolves the same registered auggie source as `providerId: "auggie"` — same key, same cache — so the two can never diverge.
- `forceRefresh: true` skips the cache read, awaits a fresh probe, and stores the result on success. On failure it returns the **last-good** list labeled `stale: true` plus a `warning` — stale data is never served silently. It is the FE model picker's refresh button — the only client-driven way to re-probe a cached provider.
- **Non-forced reads** serve any cached entry regardless of age; a probe runs only on a **true cache miss** — first use, or a version-key mismatch (e.g. after an adapter pin bump) — awaited inline (no stale-while-revalidate) with the same last-good + `warning` fallback on failure.
- **Probe guards.** Concurrent probes for the same provider are single-flighted (one spawn, shared result), and a failed probe is negatively cached for **60 seconds**: non-forced reads within the window serve the failed probe's degradation (static/stale) without re-probing; `forceRefresh` bypasses the negative entry.
- **Registered sources:** nine providers are registered — `auggie` (CLI discovery, below); `cortex` (un-gated as of monorepo#1902; with the static tier catalog retired it serves an empty list with no `warning` under `source: "cortex"`: the provider CLI owns model selection); `claude-code`, `codex`, `pi`, and `droid` (live ACP adapter probes); `opencode` and `grok` (native CLI discovery — each binary is resolved from its native installer location first, `~/.opencode/bin/opencode` and `~/.grok/bin/grok` respectively, **ahead of** the `PATH` scan, so a daemon spawned with a minimal `PATH` — e.g. from a packaged app — still finds a natively installed CLI; `~` denotes the daemon's resolved home directory (`$HOME`, or `%USERPROFILE%` on Windows), not shell expansion; on Windows only runnable `.exe`/`.cmd`/`.bat` entry points are probed — never the bare extensionless name); and `unsloth` (HTTP fetch, below — no CLI/adapter probe). Version keys are per-provider (e.g. the claude-code/codex/pi adapter version pins); the registry is designed for further providers to be added.
- **The `unsloth` source** fetches the Hugging Face `unsloth` org's GGUF repos (`https://huggingface.co/api/models?author=unsloth&filter=gguf&limit=1000`, 10s timeout) and builds **one row per repo, never per quant**: `id` is the full HF repo id (e.g. `unsloth/gemma-3-27b-it-GGUF` — the compound model id is `unsloth:<repo-id>`), `name` is the bare repo name with the trailing `-GGUF` stripped, and `description` reports the HF download count (the ranking signal); rows are sorted by downloads, ties broken by `trendingScore`. **Memory-fit filtering:** the total parameter count is parsed from the repo name (dense `27B`; MoE `35B-A3B` uses the total `35B`), the footprint is estimated at ~0.6 bytes/param (Q4-class) + 1 GiB headroom, and repos estimated to exceed **~70% of total system RAM** — or whose size cannot be parsed — are dropped, with the existing `warning` field reporting the count (`unsloth: <n> repo(s) hidden (estimated to exceed available memory, or size unknown)`); when RAM detection is unavailable the filter is skipped entirely — every repo is served, including size-unknown ones, and no hidden-count `warning` is emitted. When the filter hides **every** repo (or the response parses to zero repos), the source degrades to the "no models reported" unavailable path — matching the opencode/grok convention — rather than serving an empty success, so an empty catalog is never cached as valid. No new wire fields — the result reuses the standard `{ models, source, stale?, warning? }` shape and cache semantics.
- **Unknown/unregistered **`providerId` degrades to an **empty list** with `source: "static"` and a `warning` — never an error, so model pickers keep working. (The former static tier rows went with the tier tables, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922); `source: "static"` survives as the degradation label only.)
- **Legacy path.** Without `providerId`, the response omits the `providerId` field (legacy shape) but follows the same cache semantics as `providerId: "auggie"`: a cached entry is served indefinitely; on a failed probe the last-good list is served labeled `stale: true` + `warning` (forced or not), falling back to an **empty list** (`{ models: [], source: "static" }`, exactly those keys) only when no last-good list exists. Because the cache is persisted, last-good entries survive daemon restarts on this path too.

**Auggie discovery** (the registered `auggie` source):

1. `auggie model list --json` — rich metadata (`id` ← `shortName`, `name` ← `displayName`).
2. Plain `auggie model list` text fallback (`- Label [model-id]` rows + optional indented
   description) when the JSON form fails or parses empty.
3. Rows flagged `isLegacyModel` are **filtered out server-side**; the survivors are sorted by
   `modelGroupPriority`, then `priority`, then `name` (missing priorities sort last). A
   successful CLI result is cached per the generic per-provider cache above.
4. When the auggie CLI is unavailable or yields nothing parseable (and no last-good entry
   exists), an **empty list** is returned with `source: "static"` — there is no static
   fallback catalog (the provider CLI owns model discovery, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922));
   clients can key honest "live vs fallback" UI off `source`.

Errors: `-32603` only on internal failure; probe/CLI failures degrade as described above.

```json
// → request (legacy path, no providerId)
{ "jsonrpc":"2.0","id":82,"method":"models.list" }
// ← response
{ "jsonrpc":"2.0","id":82,"result":{ "source":"auggie","models":[
  { "id":"sonnet4.5","name":"Sonnet 4.5","provider":"auggie",
    "description":"Balanced general model","modelGroupPriority":1,"costTier":2,
    "badges":[{ "color":"green","label":"Auto" }],"effortLevels":["low","medium","high"],
    "isDefault":true,"priority":1 } ] } }
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
provider** — the provider prefix of `model.default` when compound and registry-valid, else
`providers.active` (§5.12). When the effective provider is not auggie — **including
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
- `model` — optional auggie model id, passed as `--model`; omitted → CLI default.
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
is routed on the settings-derived effective default provider — the provider prefix of
`model.default` when compound and registry-valid, else `providers.active` (§5.12):

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
| No decidable effective default provider (both `model.default` prefix and `providers.active` unset/unregistered) | `completeOnce requires a decidable effective default provider` |
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
provider switch, so it is never fed to a foreign CLI. A **compound** id
(`{provider}:{model}`) must name the resolved effective provider, and is passed on **bare**
(prefix stripped) since the one-shot launch takes a raw model id; a prefix that is not a
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

### 5.33 `repoConfig.*` — per-repository configuration

Four JSON-RPC methods for managing per-repository configuration (`.intent/config.json`) at the
repository root. Each workspace lives in a git worktree; these methods resolve the **repository**
root (via `worktreePath` → `repositoryPath` → `git_ops::worktree_path`) and read/write/check the
shared `.intent/config.json` that sits at that root. The config carries project-wide settings
(branch naming prefix, default setup script, agent instructions, repo scripts) that apply to all
workspaces cloned from the same repo.

All methods require `workspaceId` and map `Error::NotFound` to `-32602 "Workspace not found"`.

| Method | Params | Result |
| --- | --- | --- |
| repoConfig.get | workspaceId (req) | { config: RepoConfig } — reads the config from the repo root; returns default empty config if the file is absent or contains invalid JSON |
| repoConfig.save | workspaceId (req), config (req): RepoConfig | { config: RepoConfig } — writes the config, ensures `.intent/.gitignore`, and returns the persisted record |
| repoConfig.has | workspaceId (req) | { exists: boolean } — checks whether `.intent/config.json` exists at the repo root |
| repoConfig.ensureDir | workspaceId (req) | { ok: true } — creates the `.intent/` directory at the repo root if missing |

**RepoConfig** — all fields are optional; absent fields have no effect on the workspace (fallback to workspace-level or global settings):

- `branchPrefix?: string` — string prefix (e.g. `"feat/"`, `"aw/"`) prepended to auto-generated branch names in `workspace.create` (§5.1)
- `setupScript?: string` — default setup script used when `workspace.create` omits `setupScript`
- `instructions?: string` — repo-level instructions injected into agent prompts
- `runScript?: string` — optional run script (reserved, no consumer in v1)
- `archiveScript?: string` — optional archive script (reserved, no consumer in v1)
- `scripts?: Array<{ id, name, command, mode, cwd?, env?, category?, autoStart? }>` — repo script definitions used to bootstrap workspace scripts when none exist

The `defaultAutoCommit` field mentioned in early drafts was **not implemented** in the initial port.

```json
// → request — read the config
{ "jsonrpc":"2.0","id":90,"method":"repoConfig.get","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":90,"result":{ "config":{ "branchPrefix":"feature/","setupScript":"npm install","instructions":"Use TypeScript strict mode" } } }

// → request — write/update the config
{ "jsonrpc":"2.0","id":91,"method":"repoConfig.save",
  "params":{ "workspaceId":"ws-abc","config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }
// ← response
{ "jsonrpc":"2.0","id":91,"result":{ "config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }

// → request — check existence
{ "jsonrpc":"2.0","id":92,"method":"repoConfig.has","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":92,"result":{ "exists":true } }

// → request — ensure the .intent directory exists
{ "jsonrpc":"2.0","id":93,"method":"repoConfig.ensureDir","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":93,"result":{ "ok":true } }
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

*(behavior + additive metadata key on the opaque `event_notification` `messageMetadata` payload; no method-catalog or wire-shape change — [intent-hq/intentd#1138](https://github.com/intent-hq/intentd/pull/1138), [intent-hq/intentd#1144](https://github.com/intent-hq/intentd/pull/1144), [monorepo#2044](https://github.com/intent-hq/monorepo/issues/2044))*

When a delegated child's completion makes other tasks startable, the delegator's completion wake ends with an **advisory** section naming them. The design splits the work across the wake's lifetime:

- **Enqueue time records only the triggering fact.** Each wake-composition site — the ungrouped completion-watch wake, the `after_all` aggregated group wake, and the immediate `agent.reportToParent` parent wake — stamps the settled task-linked children's task-note ids onto the wake's `event_notification` metadata under `unblockedTriggerTasks` (`[{ workspaceId, taskNoteId }]`). No readiness enumeration is computed or stored at enqueue. For grouped children the trigger is captured at group **record** time (when the child settles) on the persisted group event data, so a task-linked child deleted between its settlement and group settlement keeps its trigger, and triggers survive daemon restarts with the group.
- **Delivery/render time resolves the enumeration fresh.** At every point where queued wake content is rendered for a model turn (queue drains, batch flush, direct send to an idle parent, the store-only parent-wake persist), the daemon collects the trigger ids from **all** trigger-carrying entries draining in the same batch, snapshots the named workspaces' CURRENT task state (the same snapshot the batch-delegate classification reads, so readiness semantics are identical), computes the readiness delta attributable to the triggers, and appends ONE coalesced section to the LAST trigger-carrying entry. Because the state is read at delivery, a wake that sat queued behind a busy parent never carries a stale enumeration: a task claimed or completed in the interim drops out, and a task whose other dependency completed in the interim drops in.

**Section format:** `Tasks now unblocked by this completion: [Title](intent://local/task/{id}) (deps satisfied), [Title](intent://local/task/{id}) (conflict cleared).` — plural framing (`these completions`) when the coalesced trigger set covers more than one completion. A task appears iff it is ready now (dep-satisfied and conflict-free) but was NOT ready in the counterfactual where the trigger tasks are still in flight — tasks already ready beforehand, still-blocked tasks, terminal (`complete`/`cancelled`) / `in_progress` / live-agent-assigned tasks, and the triggers themselves never show up; only triggers currently `complete` count (ids deleted or reopened between enqueue and delivery are skipped gracefully). A task sitting in an attention status (`waiting` / `discussion_needed` / `blocked` / `review_required`) stays in the delta and is annotated inline (e.g. `(deps satisfied; currently blocked — needs attention)`) rather than dropped — the delegator may want to resolve the attention state precisely because the task is otherwise unblocked. Output is sorted by title then note id.

**Strictly advisory and fail-open:** the section triggers no auto-starts and writes no task state — the delegator still calls `agent.delegate` for anything it wants started (the same contract as the batch form's `unlockPlan`). An empty delta or a snapshot failure appends nothing (the wake delivers unannotated); `persisted: true` requeues are never rewritten, and content already carrying the section (terminal-failure requeue) is never annotated twice.

#### Completion-watch persistence

**Deliver-once, queue- and busy-aware completion.** Every ungrouped completion watch — whatever path registered it (`agent.delegate` auto-watch, `agent.wakeOrCreate` SUB-1, `ws.agent.create` auto-subscribe, the sender auto-subscribe, explicit `ws.agent.watch`, the chief-only MCP `ws.app.agents.waitFor` binding) — delivers exactly one completion wake and is then retired (removed before delivery, per STAB-18). **Completion** is the target reaching `agent:idle` with an EMPTY ready-to-send pending queue AND no in-flight turn worker, or `agent:failed` / `agent:deleted` regardless of queue/busy state (a failed child is parked; its queue never self-drains). An `agent:idle` while the target still holds ready-to-send queued messages (entries under edit don't count — the same `has_ready_to_send` gate as the idle-emit invariant), or while the target's worker is already busy in a new turn ([monorepo#1297](https://github.com/intent-hq/monorepo/issues/1297): an enqueue that raced the idle emit may have been dequeued and started before delivery, leaving the queue empty but the busy slot held), is an **interim idle**: the watch neither delivers nor retires, staying armed for the real completion after the queue drains / running turn ends — this is what makes the wakeOrCreate queued branch work with no special watch mode and no leak-guard timer. Grouped (`after_all`) watches are exempt from the interim-idle gate (group settlement accounting must see every completion) and are owned by group settlement. **Hook-waiting deferral (idle-visibility, within v3.1).** An `agent:idle` while the target still owns ACTIVE (`scheduled`/`running`) background hooks (§5.40) is likewise **not** its completion — the child will run again when a hook dispatches, fails, or expires — so completion-watch delivery for that idle is **deferred**: the watch neither delivers nor retires (no "child completed" wake fires while the child is merely waiting on a hook), and — unlike the queue-interim case — grouped (`after_all`) watches defer too: a hook-waiting child does **not** count as settled and its group stays open until the child's genuine settlement (deferral is TTL-bounded: hooks expire within 60 minutes and every terminal hook transition wakes the owner, whose next hookless idle settles the watch/group — so no deferral outlasts the last hook's expiry plus one child turn). The classification probes the hook store live at delivery time (an emit-time `waitingOnHooks` stamp alone never defers a child whose hooks already settled), and a probe failure reads as no hooks (fail-open: a missed deferral only yields the pre-deferral early wake). Never deferred: `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out (blocker/discussion) — only the plain `agent:idle` settlement path defers. Edge cases: an **external `hook.cancel`** (the FE path) on an idle child whose last active hook it cancels fires the deferred watch at that moment (every terminal hook transition re-runs the deferred-completion redelivery as a backstop, so a cancel with no owner wake — or a failed wake delivery — still settles it); **daemon-restart rehydration** consults active hooks the same way — the reconciliation pass and registration-time reconciliation both skip the synthetic idle-completion refire for a child that is idle with active hooks (resumed hooks keep their original `expiresAt`, so the deferral stays bounded across restarts), while failed/deleted children still reconcile immediately. **PR-monitor-waiting deferral (idle-visibility, unified external-wait, within v6.2; [intent-hq/intentd#1002](https://github.com/intent-hq/intentd/pull/1002)).** An `agent:idle` while the target still owns ACTIVE PR monitors (§5.42) is likewise **not** its completion — the child will run again when its monitored PR changes, merges/closes, or the monitor is cancelled — so completion-watch delivery for that idle **defers exactly like the hook-waiting case**: the watch neither delivers nor retires, and grouped (`after_all`) watches defer too — a pr-monitor-waiting child does **not** count as settled and its group stays open until the child's genuine settlement. The classification probes the monitor store live at delivery time (an emit-time `waitingOnPrMonitors` stamp alone never defers a child whose monitors already settled), and a probe failure reads as no monitors (fail-open, same as the hook probe). Never deferred: `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out. **Key difference from hook-waiting: no TTL.** Unlike background hooks (bounded by their 60-minute cap), PR monitors have **no TTL** (§5.42) — a monitor can sit ACTIVE indefinitely while a PR sits unreviewed — so this deferral has **no time bound of its own**. It resolves instead via one of the monitor's **terminal transitions**, each of which re-runs the deferred-completion redelivery as a backstop even when the transition itself delivers no wake: the monitor **completing** (PR merged/closed — an immediate, undebounced wake), the owner's own **`ws.pr.unmonitor`** (which delivers no self-wake, so the backstop is what settles the deferred watch), an **external `prMonitor.cancel`** (the FE path — mirrors the hook-waiting `hook.cancel` edge case; the owner does get a cancellation-notice wake here, but the backstop still runs as a safety net), the **`workspace.archive` sweep cancel** (§5.1 archive active-work teardown; [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067) — same shared cancel transition, with an archive-specific notice wake that parks behind the archived gate; the backstop still runs after the delivery attempt), and **daemon-restart rehydration** (reconciliation skips the synthetic idle-completion refire for a child that is idle with active monitors, exactly like the hook case — resumed monitors keep polling independently after restart, so there is no bounded re-arm window to preserve). Because there is no TTL, an abandoned PR with a permanently-open monitor can in principle defer forever; this mirrors the accepted trade-off already documented for the deeper agent-waiting deadlock cycles below. **Agent-waiting deferral (behavior-only within v4.3; [monorepo#1468](https://github.com/intent-hq/monorepo/issues/1468)).** An `agent:idle` while the target itself holds live outgoing completion watches on other, unsettled agents is likewise **not** its completion — the target will run again when a watched agent completes (the motivating case: an implementor idling while it waits on its PR reviewer must not wake its coordinator into a no-progress loop). Such an agent-waiting idle defers WATCH delivery exactly like a hook-waiting one: ungrouped watches on the target neither deliver nor retire, and the target's grouped (`after_all`) memberships skip the settlement record, so its group stays open until it settles for real. The classification is probed **live at delivery time** (the emit-time `isWaitingForOtherAgents` stamp alone never defers a target whose watches already settled), counting both the target's ungrouped outgoing watches and its grouped ones (a coordinator idling while its own delegation group is open is genuinely waiting on its children); a persisted-row read failure on the startup path fails open (not waiting — a missed deferral only yields the pre-deferral early wake). **Seal-interim vs. watch-interim split:** unlike the queue/busy/hook cases, agent-waiting does NOT defer the target's OWN `after_all` group **seal** — an `after_all` coordinator always holds grouped outgoing watches on its own children, so gating the seal on agent-waiting would deadlock the group (the seal is what closes the coordinator's delegating turn); only watch delivery to the target's watchers and the target's settlement records defer. **2-cycle deadlock guard:** a mutual watch pair (A⇄B) in which BOTH sides are idle (not busy, empty ready-to-send queue) would defer forever, so an outgoing watch on a target that watches this agent back and is itself idle is NOT counted as a waiting reason — the deadlocked pair delivers as before (both watchers fire); a mutual pair whose counterpart is still busy is a genuine wait and still defers. Deeper cycles (A→B→C→A) are a **documented limitation**: they are not detected and will defer until an external event (watch removal, failure, deletion) breaks the cycle. **Redelivery backstops:** the deferral has no TTL of its own, so every path that removes the target's outgoing watches re-runs the deferred-completion redelivery — `agent.unwatch` / `ws.agent.unwatch`, `agent.cancelSubscriptions` (both the scoped and the remove-all forms), and `after_all` group settlement (which drops the parent's grouped watches) — so a deferred watcher settles when the target's last outgoing watch disappears without producing a wake (e.g. the aggregated group wake's delivery failed). Never deferred (same as hook-waiting): `agent:failed` / `agent:deleted`, the immediate `agent.reportToParent` wake, and the attention fan-out. **Reconciliation paths across restarts:** the startup rehydration reconcile, registration-time reconciliation (`ws.agent.watch` re-arm on an already-idle target, `ws.app.agents.waitFor`), and the group-rehydration pre-publish records all apply the same predicate — an idle child holding outgoing completion watches records the interim-skip marker and leaves the watch armed / skips the group record instead of firing a synthetic completion; group rehydration uses a durable variant that falls back to persisted `completion_watch` rows because groups rehydrate before the watch registry loads. Synthetic idles from these paths stamp `isWaitingForOtherAgents` consistently with live emits; failed/deleted children still reconcile immediately. Attention events (blocker raised / discussion requested) fan out to `wake_on_attention` watchers WITHOUT consuming the watch — attention is not a completion; the watch still ends at the target's next completion. An agent that wants wakes for a target's future turns must re-arm (sending/waking auto-subscribes, or call `ws.agent.watch` again). **Completion watches survive restarts.** Watches are persisted in the `completion_watch` SQLite table via a best-effort spawned async write (NOT durable-before-observable; `ws.app.agents.waitFor` and `ws.agent.watch` alone AWAIT the write because registration-time reconciliation may fire the watch immediately — but both remain fail-open on a persist error: a failed write only logs, and the in-memory watch still delivers live), and deleted when the watch fires or is cancelled. At daemon startup, surviving rows are rehydrated into the in-memory registry: rows whose parent agent is gone (or whose delegation group already settled) are pruned; each remaining watch's child is then reconciled against current agent state, so a child that completed / failed / was deleted while the daemon was down delivers a synthetic completion wake immediately instead of leaving the parent waiting forever. `ws.app.agents.waitFor` runs the same reconciliation at registration time, so waiting on an already-settled target wakes the caller right away. No RPC surface changes: the watches remain visible via `agent.getSubscriptions` and removable via `agent.cancelSubscriptions`; the subscription registry itself is daemon-level, so chief-workspace (`__chief__`) parents can hold watches on children in any workspace (non-chief parents remain scoped to their own workspace). **Watch registration fails closed on a nonexistent child.** The watch-registration op behind the `ws.agent.create` auto-subscribe (`agent.watchCompletion`) rejects a nonexistent child agent with `-32602` naming the id BEFORE any watch is registered — it no longer falls back to the call's workspace and registers a watch that can never fire (a phantom `waitingForAgentIds` entry on the parent); this mirrors the sender auto-subscribe guard on `agent.sendMessage` (§5.5). The existing deleted-parent guard (`ok: false`, no watch) is unchanged, and the child guard takes precedence when both the parent is deleted and the child is nonexistent.

**Pair uniqueness — at most one active watch per (parent, child)** *(new in intentd)*. A parent holds at most ONE active completion watch on a given child, across ungrouped watches and `after_all` delegation-group membership, so duplicate waits (and duplicate wakes for one completion) can never appear on the wire. Enforcement is per registration path: **explicit** registrations reject — `ws.app.agents.waitFor` on a target the caller already watches (grouped or not) is rejected with `-32602` naming the target (`already waiting on agent <id>: …`), in the same up-front validation loop as the scope gate, so the rejection is side-effect free (no group, no watches; the pre-existing watch survives unchanged; cancel it via `agent.cancelSubscriptions` to re-register). **Auto-subscribe** paths that piggyback on another operation (`agent.delegate` auto-watch, `agent.wakeOrCreate`, `ws.agent.create` auto-subscribe, the sender auto-subscribe on `agent.sendMessage`/`agent.sendToTask`) never fail the parent operation on a duplicate: the shared registration path silently ADOPTS the existing watch for the pair — returning its `subscriptionId` — and only ever strengthens it, never weakens it: a grouped (`after_all`) registration converts the existing watch into the group watch (`group_id` set) because group settlement accounting requires the grouped watch to exist — the group always wins a collision; an ungrouped registration against an existing grouped watch is a no-op; `wake_on_attention` is strengthen-only (an explicit `ws.agent.watch` sets it; a later auto registration never clears it). The adopted watch's strengthened mode is persisted (upsert on the same row id). Startup rehydration coalesces pre-invariant duplicate persisted rows: rows are loaded grouped-first (then by `created_at`, oldest first) and a row whose (parent, child) pair is already watched in memory is pruned (deleted), so the invariant holds after upgrade. The coalescing rank need not consider `wake_on_attention`: pair uniqueness shipped before the attention flag existed (migration 0072), so pre-invariant duplicate rows always carry `wake_on_attention = 0` and the ordering can never prune an attention-enabled watch in favor of a weaker one.

**Explicit agent watches — MCP `ws.agent.watch` / `ws.agent.unwatch`** *([monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229); MCP bindings only, not wire-routable)*. Because agent event subscriptions are off-limits to agent callers (see the §5.5 `agent.subscribe` restriction), `ws.agent.watch(agentId)` is the sanctioned way for one agent to monitor another: it registers an explicit, ungrouped caller→target completion watch on the same `completion_watch` registry, returning `{ ok: true, subscriptionId, agentId }`. Like every ungrouped watch it is **deliver-once**: it fires exactly once at the target's completion (idle with an empty pending queue, failed, or deleted — the queue-aware contract above) and is then retired; the caller re-arms with another `ws.agent.watch` call if it wants the next turn too. What distinguishes it is the `wake_on_attention` flag (persisted via migration 0070's `completion_watch.wake_on_attention` column): the caller is additionally woken on the target's attention events — **blocker raised, discussion requested** — and those attention wakes do NOT consume the watch. Semantics: (1) **fail closed** — a nonexistent or Deleted target is rejected with `-32602` (`unknown agent id: <id>`) before any registration, self-watching is rejected (`cannot watch yourself`), and the shared `check_watch_scope` gate rejects cross-workspace targets for non-chief callers; caller-only (the front door has no wake target). (2) **Durable registration** — the persist is AWAITED before the call returns (the registration is the caller's durable contract; contrast the best-effort spawned writes of the auto paths above — a failed write still only logs, with the in-memory watch delivering live), and the watch survives daemon restarts through the standard rehydration. (3) **Settled-target reconciliation** — after registration the target is reconciled against current agent state (the same path `ws.app.agents.waitFor` and startup rehydration use), so watching an already-settled target delivers its synthetic completion wake immediately. (4) **Pair-uniqueness adoption** — as a strengthen-only registration, an existing watch for the pair is adopted in place: `wake_on_attention` is set (a later auto registration never clears it), and a grouped watch keeps its group but gains the attention flag. (5) **Attention fan-out** — `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` (§5.5 attention-request flow, step 6) additionally wakes every `wake_on_attention` watcher of the caller with the kind-flavored `[WORKSPACE EVENTS]` wake (`Watched agent <name> (<id>) requests a discussion / reports a blocker: <reason>`, `event_notification` metadata embedding the `agent:attention-requested` payload), EXCLUDING the caller's parent — the direct parent wake already fired, so a parent that also explicitly watches its child never receives a duplicate; watches stay in place (attention is not a completion). (6) **Parent-scoped reportToParent idle suppression** — the `agent.reportToParent` `report_delivered` marking applies to the parent's ungrouped watches on the child (§5.5), so a third-party `ws.agent.watch` watcher still receives the target's idle-driven completion wake; a parent's own explicit watch is suppressed like any parent watch (and still retired at the child's completion). (7) **Deleted-target cleanup** — on the target's `agent:deleted` the watch delivers its wake and is removed with the standard remove-before-delivery protocol (it can never fire again, so it must not leak). `ws.agent.unwatch(subscriptionId | agentId)` removes one of the **caller's own** watches, addressed by either id: an unknown/foreign `subscriptionId` is rejected with `-32602` (never removed); the `agentId` form is idempotent (`{ ok: true, removed: false }` when no matching ungrouped watch exists); grouped watches are owned by delegation-group settlement and are rejected (`use agent.cancelSubscriptions with groupId instead`). Both directions publish the standard `agent:subscriptions-changed` snapshot in the caller's home workspace, and the watches remain visible via `agent.getSubscriptions` / removable via `agent.cancelSubscriptions` like any other completion watch.

**Machine-readable watch state on agent-watch wakes — `watchStillArmed`** *(additive key on the opaque `event_notification` `messageMetadata` payload, presence-detected per the §5 convention; no method-catalog or wire-shape change — [monorepo#2060](https://github.com/intent-hq/monorepo/issues/2060); the `hookStillActive` counterpart from the §5.40 hook dispatch wakes, monorepo#1520)*. Every agent-watch wake's `event_notification` metadata carries the boolean `watchStillArmed`, mirroring what the wake text already states so consumers don't parse the note prose: **`false`** on the ungrouped completion-wake path (idle / failed / deleted — `remove_watch` retired the deliver-once watch just before delivery, matching the "the watch is now retired" / "cannot be re-watched" text suffixes, monorepo#2051), **`true`** on the immediate grouped-failure wake (the grouped watch stays armed for `after_all` settlement) and on the attention fan-out wakes to `wake_on_attention` watchers (the "Your watch on this agent remains armed" wording above — attention is not a completion). The flag rides only these watch-delivered wakes; the direct parent attention wake (§5.5 attention-request flow, step 5) and the `after_all` aggregated group wake are not watch wakes and do not carry it, and other `event_notification` payloads (subscription batches) are untouched.


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
  total tokens — the sum of all five counters, `thoughtTokens` included (ties break on model
  name ascending).
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
hour in which no provider broke reasoning out of `outputTokens`). It is a `u64` in camelCase,
**omitted when zero or unreported** (never a fabricated `0`, never `null`) — on `totals` and on
every `byModel` / `byProvider` / `byHourOfDay` / `byMonth` cell alike — so clients written
against the pre-`thoughtTokens` shape see the previous response byte-for-byte. It aggregates
exactly like the other counters (the same clamped-≥ 0 per-turn delta folded into the same
buckets), and it counts toward the `byModel` / `byProvider` "total tokens" ranking, which sums
all five counters.

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

### 5.37 Managed Unsloth server — `unsloth.status` / `unsloth.stop` *(v2.5)*

The daemon owns a **singleton managed Unsloth server** (the `unsloth` CLI process plus the
`llama-server` child it spawns, which holds the model weights) backing every `unsloth`-provider
agent (model catalog §5.30; startup progress surfaces as the repeated `launch`-phase
`agent:stream:status` events, §6.5). These two router methods expose observability and control
over it. Both are **daemon-global**: they take no params and no `workspaceId` (like
`system.capabilities`), and are available on both UDS and WSS.

| Method | Params | Result |
| --- | --- | --- |
| unsloth.status | — (empty `{}`) | `{ running: boolean, repoId?, port?, pid?, uptimeSecs?, phase?, cpuPercent?, memoryBytes?, attachedAgentCount? }` |
| unsloth.stop | — (empty `{}`) | `{ stopped: boolean }` — `stopped: false` means nothing was running (a **no-op result**, never an error) |

**`unsloth.status`** — a point-in-time snapshot of the managed server. With a server up,
`running: true` and the other fields are present:

- `repoId` — full HF repo id currently served (or being started), e.g.
  `"unsloth/gemma-3-27b-it-GGUF"` (the compound model id is `unsloth:<repoId>`, §5.30).
- `port` — port the managed server listens on (default `8888`); `pid` — OS pid of the server
  child (`null` when unknown).
- `uptimeSecs` — seconds since the server child was spawned.
- `phase` — coarse startup phase: `"starting"`, `"minting"`, `"loading"`, or `"ready"`.
- `cpuPercent` / `memoryBytes` — resource usage sampled at snapshot time and **summed across the
  server's whole process tree** (root plus descendants — the `llama-server` child holds the
  model weights, so the tree total is what matters for capacity planning). `cpuPercent` follows
  the raw `sysinfo` convention (100 = one full core) and is `0.0` when the pid is unknown or the
  sample failed.
- `attachedAgentCount` — the number of currently-tracked agents spawned with the `unsloth`
  provider, counted **regardless of `running`** (a stopped-but-attached state is possible
  mid-restart). When no server is up the result degrades to
  `{ running: false, attachedAgentCount }`; a daemon whose agent manager is not attached
  (composition-root wiring — e.g. a bare test harness, or a daemon that has never spawned any
  agent infrastructure) reports exactly `{ "running": false }`.

Status reads never block behind an in-flight startup: the snapshot is served from a lock-free
identity mirror, so `unsloth.status` stays responsive even during a minutes-long first-use model
download. A dead-and-reaped server child reports as `running: false`, never as a stale identity.

**`unsloth.stop`** — gracefully terminates the managed server and its **whole process tree** if
one is running; an in-flight startup is aborted within about one probe tick rather than leaving
the stop blocked behind the startup window. `stopped: true` means a server (or in-flight
startup) was actually torn down. Stopping is **safe while agents are attached** — the daemon
neither blocks nor warns; a client that wants an "N agents are still using this server"
confirmation should check `unsloth.status`'s `attachedAgentCount` first. A later
`unsloth`-provider spawn simply starts the server again.

```json
// → request
{ "jsonrpc":"2.0","id":97,"method":"unsloth.status","params":{} }
// ← response (server up)
{ "jsonrpc":"2.0","id":97,"result":{
  "running":true,"repoId":"unsloth/gemma-3-27b-it-GGUF","port":8888,"pid":48113,
  "uptimeSecs":312,"phase":"ready","cpuPercent":184.2,"memoryBytes":17179869184,
  "attachedAgentCount":2 } }
// ← response (no server running; agent manager attached)
{ "jsonrpc":"2.0","id":97,"result":{ "running":false,"attachedAgentCount":0 } }

// → request
{ "jsonrpc":"2.0","id":98,"method":"unsloth.stop","params":{} }
// ← response
{ "jsonrpc":"2.0","id":98,"result":{ "stopped":true } }
```

### 5.38 Provider catalog — `providers.catalog` *(v2.6; wire shape changed by [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922))*

The static provider registry (the `intent-providers` crate's `ACP_PROVIDERS` table) served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. **Daemon-global**: no params and no `workspaceId` (like `system.capabilities`), available on both UDS and WSS. The data is **compiled into the daemon** — there is no cache or TTL; the result only changes when the daemon binary does.

**Request:** `{}` (no parameters)

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "auggie",
      "displayName": "Augment Auggie",
      "shortName": "Auggie",
      "command": "auggie",
      "canBeDisabled": true,
      "loginCommandHint": "auggie login",           // optional
      "loginDocsUrl": "https://docs.augmentcode.com/cli/overview",  // optional
      "authErrorPatterns": ["authentication required", "auggie login", "please run `auggie login`"],  // optional
      "visible": true
    },
    {
      "id": "claude-code",
      "displayName": "Anthropic Claude Code",
      "shortName": "Claude Code",
      "command": "claude-agent-acp",
      "canBeDisabled": true,
      "loginDocsUrl": "https://code.claude.com/docs/en/quickstart#step-2-log-in-to-your-account",  // optional
      "visible": true
    },
    {
      "id": "cortex",
      "displayName": "Snowflake Cortex",
      "shortName": "Cortex",
      "command": "cortex-acp",
      "canBeDisabled": true,
      "visible": true                               // un-gated (monorepo#1902) — no gating fields
    },
    // ... one row per registered provider (opencode, unsloth, pi, droid, grok, ...) ...
    {
      "id": "mock",
      "displayName": "Mock (E2E)",
      "shortName": "Mock",
      "command": "node",
      "canBeDisabled": true,
      "requiresEnvVar": "MOCK_AGENT_SCRIPT_PATH",   // optional — raw gating field passed through
      "visible": false                              // daemon-evaluated: env var absent in the daemon environment
    }
  ]
}
```

- `providers` carries **all** registered providers — gated-off rows included — one row per registry entry, in **registry order**. The order is informational, not a contract: clients must key rows by `id`, never by array position.
- `command` is the registry's **logical CLI name** (the `ACP_PROVIDERS` `command` field, e.g. `claude-agent-acp` for `claude-code`) — provider metadata, **not** necessarily the binary the daemon spawns. Launch resolution belongs to `host.providerDiscovery` (§5.14), whose `command` reports what the daemon actually resolves and launches — so the two can differ: an npx-only provider like `claude-code` launches via `npx <npxPackage>` and reports `command: "npx"` there. Clients must not assume the values match across the two methods.
- `visible` is the **daemon-evaluated** gating verdict: `requiresEnvVar` is checked for **presence** against the **daemon's** process environment (an empty-string value counts as set), and a configured `requiresFeatureCode` **always** gates the row off (**default-deny** — the daemon stores no feature-code enablement; no registered provider currently carries one — cortex was un-gated per monorepo#1902 — but the mechanism remains for future providers). The raw gating fields pass through when set, so clients can either trust the verdict or re-derive it. This is the single env-var/feature-code gate shared with `host.providerDiscovery`'s `gatedOff` (§5.14).
- The optional fields (`loginCommandHint`, `loginDocsUrl`, `authErrorPatterns`, `requiresEnvVar`, `requiresFeatureCode`) are **omitted when unset, never null** — clients detect by presence.
- **No default designation, no model metadata ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)).** Rows carry no `isDefault` flag, the payload carries no top-level `defaultProviderId`, and the former per-row `modelTiers` (`{ fast, balanced, smart }` tier→model-id map) is gone — the static tier tables were removed with the model-tier concept. Model discovery is fully dynamic via `models.list` (§5.30). Clients derive the **effective default provider** from settings: the provider prefix of `model.default` when it is a compound id naming a registered provider, else `providers.active` (§5.12), else the first registered provider — the same derivation the daemon applies (§5.5 "Creation-time default-model resolution").

### 5.39 Token-rate history — `stats.getRateHistory` *(v2.9)*

The backend owns a global **per-minute token-rate history** (the HUD TOK/MIN chart).
Recording is daemon-internal and rides the same turn-end bookkeeping as the hourly usage
stats (§5.36): at the end of each prompt turn the daemon folds the turn's clamped **token
delta** — the identical delta that feeds `usage_stats_hourly`, never a raw cumulative
snapshot — into a `usage_rate_minutely` row keyed by the RFC-3339 **UTC minute floor**
(`"YYYY-MM-DDTHH:MM:00Z"`). Rates aggregate **across all workspaces**: there is
deliberately no workspace / model / provider dimension. All-zero deltas are skipped. The
table is capped by retention: an hourly reaper deletes buckets at or older than the
**24h** cutoff (inclusive, so a boundary-aligned sweep still holds the cap), bounding it
at ≤ 1440 rows. Only the **read** crosses the wire — recording has no RPC.
`stats.getRateHistory` is global: it takes **no** `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| stats.getRateHistory | limit: integer 1–1440, default 60 — the number of trailing minute samples | `{ samples: RateSample[] }` — -32602 on a non-integer or out-of-range limit |

**RateSample** — `{ bucketUtc, inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, thoughtTokens }`:

- **samples** — exactly `limit` entries in **chronological order** (oldest first), one per
  minute, ending at the **current UTC minute floor**. Minutes with no recorded activity
  are **zero-filled**, so the array is always a gap-free minute-by-minute series; an empty
  store returns all-zero samples, never an error.
- **bucketUtc** — the sample's UTC minute floor (`"2026-07-30T14:07:00Z"`). Keys sort
  lexicographically in chronological order.
- The token counters are the minute's accumulated per-turn deltas (same clamped-≥ 0
  semantics as §5.36's UsageTotals).
- **thoughtTokens** *(additive within v6.0, [intent-hq/intentd#976](https://github.com/intent-hq/intentd/pull/976))*
  — the minute's accumulated reasoning ("thought") token deltas, the per-minute counterpart
  of the `TokenUsageTotals.thoughtTokens` counter (§5.31). Unlike that omitted-when-zero
  field, samples here are **dense**: every counter is always present, so a minute with no
  reasoning tokens (including every bucket recorded before this field shipped) emits
  `"thoughtTokens": 0`. Clients written against the pre-`thoughtTokens` shape are
  unaffected — the counter is additional, never carved out of `outputTokens` by the daemon.

Note the trailing-window semantics: like §5.36's `24h` period this is an **absolute
rolling window** ending at the current minute; there is no timezone parameter — samples
are UTC and any local-time rendering is a client concern.

```json
// → request
{ "jsonrpc":"2.0","id":95,"method":"stats.getRateHistory","params":{ "limit":3 } }
// ← response
{ "jsonrpc":"2.0","id":95,"result":{ "samples":[
  { "bucketUtc":"2026-07-30T14:05:00Z","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":0 },
  { "bucketUtc":"2026-07-30T14:06:00Z","inputTokens":7,"outputTokens":2,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":0 },
  { "bucketUtc":"2026-07-30T14:07:00Z","inputTokens":100,"outputTokens":40,"cacheReadTokens":20,"cacheCreationTokens":10,"thoughtTokens":15 } ] } }
```

### 5.40 Background hooks — `hook.*` *(v2.10)*

A **background hook** is a small agent-authored JS script the daemon runs on a fixed
interval until it *dispatches* (wakes its owning agent with a message and ends), fails
(is *evicted* and wakes the owner with the error), is *cancelled*, or *expires* (its
TTL passes — v3.1). Hooks let an agent
watch for a condition (CI results, file changes) without burning turns polling. (For PR
watching specifically, agents are steered to the centralized `ws.pr.monitor` instead —
§5.42, v6.1 — since a hook's TTL expires while a PR sits blocked and a monitor's does
not.)
Per the §6.8 principle, **scheduling is not on the wire**: hooks are created only by
agents via the `ws.hook.schedule` MCP binding (`{ name ≤ 50 chars, code, delayMs ≥
10000, ttlMs?, perpetual? }` — `name` is a short human-readable description shown to the user
(cap raised from 19 within v5.1, intentd#929); the first run happens immediately as validation — a failing script rejects the
call, a dispatching one wakes without persisting a schedule — unless the hook is
**perpetual**, whose dispatching validation run wakes the owner AND persists the active
schedule (see the perpetual block below); per-agent cap on active
hooks, default 5). Every hook carries a **TTL** (v3.1) counted from creation, not the
last run: `ttlMs` defaults to and is capped at 3 600 000 (60 minutes; values are
clamped into `[10000, 3600000]`, never rejected), and `expiresAt = createdAt + ttlMs`
persists on the Hook. When the deadline passes the daemon stops the hook (terminal
state `expired`, `nextRunAt` cleared), emits `hook:expired` (§6.5), and wakes the owner
(`messageMetadata.reason: "expired"`) naming the hook and its `runCount` so the model
can consciously reschedule — a perpetual hook, which may have fired repeatedly before
expiring, reports both tallies instead (`"N runs, M dispatches"` in place of the
one-shot `"N runs completed without a dispatch"`). A run is never *started* at/after
`expiresAt`; a run already
in flight when the TTL passes completes normally — its dispatch still wins, but a
`{ dispatch: false }` return expires the hook instead of rescheduling it; a **perpetual**
dispatch landing at/after `expiresAt` likewise wins and is then terminalized rather than
re-armed (owner woken with the dispatch, then the expiry notice). Restarts do
not reset the TTL (a resumed hook keeps its original `expiresAt`; a hook whose deadline
passed while the daemon was down is expired at boot, owner woken then too). Workspace
teardown also ends hooks ([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896)):
`workspace.archive` cancels every ACTIVE hook in the workspace (`hook:cancelled`
emitted, owner woken with an archive notice; unarchive does not resurrect them — §5.1
archive active-work teardown), and `workspace.delete` eagerly aborts live hook
scheduler tasks before the store cascade drops their rows (no event, no wake — §5.1
delete cascade). The FE
**reads, triggers, and cancels**:

| Method | Params | Result |
| --- | --- | --- |
| hook.list | workspaceId (req) | `{ hooks: Hook[] }` — every hook in the workspace, all states |
| hook.cancel | workspaceId (req), hookId (req) | `{ ok: true, hook }` — the cancelled Hook; the wire path may cancel **any** hook in the workspace and the owning agent is woken with a cancellation notice (an owner-initiated `ws.hook.cancel` does not self-wake — see the ownership scoping below) |
| hook.runNow | workspaceId (req), hookId (req) | `{ ok: true, hookId }` — ack only; the triggered run's outcome surfaces as `hook:*` events. The hook's inter-run timer resets after the run |

**Hook** — `{ hookId, workspaceId, agentId, name, code, delayMs, state, createdAt,
expiresAt?, lastRunAt?, nextRunAt?, runCount, perpetual, dispatchCount, lastError?,
lastLogs?, lastState? }` with
`state ∈ scheduled | running | dispatched | evicted | cancelled | expired`
(`scheduled`/`running` are the active states;
`runCount` includes the schedule-time validation run; `lastError` is set on eviction).
`perpetual` (bool) and `dispatchCount` (number) are the perpetual-hook fields
([intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979)): `dispatchCount`
counts **fires so far** for every hook created or updated from v6.0 on — a one-shot hook's
sole fire counts too, so only a perpetual hook ever exceeds 1 — and both are always present
(the additive defaulted migration backfills pre-existing rows to `perpetual: false` /
`dispatchCount: 0` unconditionally, so a retained pre-migration row that had already
dispatched reads back `dispatchCount: 0` despite having fired — the "fires so far" contract
only holds going forward, not retroactively for that one field on migrated rows).
`expiresAt` (v3.1) is the TTL deadline (`createdAt` + clamped `ttlMs`, ≤ 60 minutes from
creation); it is set on every hook scheduled from v3.1 on and absent only on pre-TTL
legacy rows, which never expire.
`lastLogs` is the **last run's** `console.log/info/warn/error` output (newline-joined,
overwritten each run; absent when the run logged nothing) — the capture is capped at 100
lines / 8 KiB per run, head-truncated with an `[earlier log lines truncated]` marker. A
timed-out run's logs are lost (the eval is killed before the capture can be returned), so
`lastLogs` then keeps the previous run's value. `lastState` (v3.0) is the JSON
serialization of the `state` field the last completed run returned — the **carry-over
state**: it is injected into the next run as the `hookState` global (`null` when unset),
an omitted `state` keeps the previous value, `state: null` clears it, and a value whose
JSON serialization exceeds ~16 KiB is dropped (the previous state is kept and a warning
line is appended to that run's `lastLogs`). The schedule-time validation run persists
its returned state too. `hook:*` event payloads (§6.5) stay light
and do **not** carry `lastLogs` or `lastState` (they do carry `perpetual`/`dispatchCount`);
clients read the heavy fields via `hook.list`.

**Perpetual hooks: dispatch is non-terminal** (behavior only, no method-catalog or
wire-shape change beyond the two additive Hook/event fields above;
[intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979)). The optional
`perpetual` schedule param (MCP-only, like the rest of `ws.hook.schedule`) defaults to
`false`; omitting it — or passing `false` — reproduces the one-shot **behavioral** contract
above (the first dispatch retires the hook) — the two additive Hook/event fields above are
the only wire-shape change, present on every hook and payload regardless of `perpetual`:

- **Dispatch re-arms instead of retiring.** A `{ dispatch: true, message }` run on a
  perpetual hook wakes the owner exactly as usual (`messageMetadata.reason: "dispatched"`,
  `[hook logs]` conventions unchanged), bumps `dispatchCount`, and returns the hook to
  `scheduled` with a fresh `nextRunAt`, keeping its scheduler loop alive. The hook ends
  only on TTL expiry, cancel, or eviction — one hook can therefore report a stream of
  changes rather than a single fire.
- **Wake note distinguishes the two dispatch outcomes** (wording shortened within v6.1;
  [intent-hq/intentd#1027](https://github.com/intent-hq/intentd/pull/1027)). The one-shot
  dispatch wake's state note reads `[This hook is now retired and will not run again —
  reschedule via ws.hook.schedule if still needed.]`; a re-armed perpetual dispatch
  instead ends with `[This hook remains active until <expiresAt> — cancel via
  ws.hook.cancel when no longer needed.]`. The dispatch-at-expiry case is exempt: a fire
  that terminalizes the hook keeps the retiring phrasing so it cannot contradict the
  expiry notice that follows.
- **`hookStillActive` metadata** (additive within v6.1;
  [intent-hq/intentd#1027](https://github.com/intent-hq/intentd/pull/1027)). Dispatch
  wakes carry `hookStillActive` (boolean) in the `hook_wake` `messageMetadata` — present
  ONLY on `reason: "dispatched"` wakes: `true` for the re-armed perpetual branch, `false`
  for a retiring dispatch (a one-shot fire, or a perpetual fire landing at/after
  `expiresAt`); absent on `evicted` / `expired` / `cancelled` wakes — so consumers can
  tell a re-armed dispatch from a retiring one without parsing the note text.
- **Dispatching validation run persists.** Unlike one-shot, a perpetual hook whose
  schedule-time validation run dispatches wakes the owner **and** persists the active
  schedule — `ws.hook.schedule` returns `{ hook, dispatched: true }` with the hook
  `scheduled` (`dispatchCount: 1`) and `hook:scheduled` emitted after the dispatch.
- **Event ordering.** On both the validation and scheduler-loop dispatch paths the
  post-dispatch outcome (`scheduled` with a fresh `nextRunAt`, or `expired`) is resolved
  and persisted **before** `hook:run-completed` / `hook:dispatched` are emitted, so those
  payloads carry the real post-dispatch `state`, never the transient `running`.
- **Everything else is unchanged.** TTL semantics (60-minute cap; perpetual does not
  extend it), eviction, cancel, the per-agent active-hook cap (a perpetual hook counts
  once, like any other active hook), the cadence floor, and the `hookState` carry-over
  contract all behave exactly as documented above.

**Cancel is ownership-scoped on the MCP side** (within v5.2, behavior only;
[intent-hq/intentd#953](https://github.com/intent-hq/intentd/pull/953)). Hooks are
agent-owned (`Hook.agentId`), and the cancel operation takes the cancelling agent as an
optional caller:

- **MCP `ws.hook.cancel` (agent caller).** An agent may cancel only its **own** hooks.
  Cancelling a hook owned by another agent fails with a tool error naming the owning
  agent, raised before any state change — the hook stays active with its scheduler task
  alive, and no `hook:cancelled` is emitted. Like `ws.hook.schedule`, the binding
  **requires** an agent caller context: a call without one is rejected rather than
  falling back to the unscoped path. An owner cancelling its own hook is **not** woken
  (no self-wake) — the cancel is already an act of the owner.
- **Wire `hook.cancel` (no agent caller, the FE/system path).** Unchanged: it may cancel
  **any** hook in the workspace, and the owning agent **is** woken with a cancellation
  notice so the model learns its watch stopped. The archive sweep (§5.1) rides the same
  unscoped path.

The wire contract is untouched (`hook.cancel` params/result unchanged); the scoping is
purely on the agent-facing MCP binding. Cross-agent hook cleanup is therefore a
coordination act, not a unilateral one: `hook.list` returns every hook in the workspace
with its owning `agentId`, so an agent that wants a sibling's hook stopped asks the owner
(or the user does it from the FE) instead of cancelling it silently.

Errors: a missing `workspaceId`/`hookId` and an unknown, foreign-workspace, or inactive
(`cancel`/`runNow` on a non-active state) `hookId` all surface as `-32602` (§9;
`NotFound` maps to invalid params like the other id-addressed namespaces). Lifecycle
transitions emit the `hook:*` event family (§6.5): `hook:scheduled`, `hook:run-started`,
`hook:run-completed`, `hook:dispatched`, `hook:evicted`, `hook:cancelled`,
`hook:expired` — subscribe
with a `hook:*` prefix filter (`hook:*` is not part of the bare-`*` category expansion
applied by the internal `agent.subscribe`/`event.subscribe` aliases, §5.5/§5.10; the
wire `events.subscribe` matches the `eventTypes` patterns as given, §6.4).

```json
// → request
{ "jsonrpc":"2.0","id":96,"method":"hook.list","params":{ "workspaceId":"ws-1" } }
// ← response
{ "jsonrpc":"2.0","id":96,"result":{ "hooks":[
  { "hookId":"hook-01…","workspaceId":"ws-1","agentId":"agent-3f…","name":"ci-watch",
    "code":"const s = await ws.pr.snapshot(887); if (hookState && JSON.stringify(s) !== JSON.stringify(hookState)) return { dispatch: true, message: 'PR #887 changed' }; return { dispatch: false, state: s };","delayMs":60000,"state":"scheduled",
    "createdAt":"2026-07-31T10:00:00Z","expiresAt":"2026-07-31T11:00:00Z",
    "lastRunAt":"2026-07-31T10:05:00Z",
    "nextRunAt":"2026-07-31T10:06:00Z","runCount":6,"perpetual":false,"dispatchCount":0 } ] } }
```

### 5.41 Voice transcription — `voice.transcribe` / `voice.getWorkspaceVocabulary` *(v4.3; workspace vocabulary v5.1)*

Daemon-owned speech-to-text behind a pluggable provider seam: the client records audio
(e.g. the desktop push-to-talk flow), ships it base64-encoded, and the daemon calls the
configured transcription provider — **ElevenLabs Scribe** (`scribe_v2`) or **OpenAI**
(the configured `voice.openai.model`, default `gpt-4o-transcribe`; `whisper-1`
fallback) — and returns the transcript. Daemon-owned so the provider API keys live in
the daemon's file-backed secret store and **never reach clients** (the same 🔒 secret
guardrail as `linear.token`, §5.28: keys are never logged, echoed, or returned over the
wire). **Daemon-global**: no required `workspaceId` (like `stats.getRateHistory`,
§5.39) — since v5.1 `voice.transcribe` accepts an **optional** `workspaceId?` that
opts the call into workspace-vocabulary injection (see "Workspace vocabulary" below),
and the companion read RPC `voice.getWorkspaceVocabulary` is workspace-scoped
(`workspaceId` req).

| Method | Params | Result |
| --- | --- | --- |
| voice.transcribe | audio (req), mimeType?, language?, provider?, context?, workspaceId? *(v5.1)* | `{ text, provider, durationMs }` — `durationMs` always present, `null` when unknown |
| voice.getWorkspaceVocabulary *(v5.1)* | workspaceId (req) | `{ terms: string[] }` — the auto-derived workspace vocabulary, derived terms only (the user's `voice.vocabulary` is not merged in) |

**Params:**

- `audio` (req) — the recorded audio bytes, **base64-encoded** (standard alphabet,
  padded). Typically webm/opus (the FE `MediaRecorder` default) or wav; the daemon
  forwards the bytes to the provider unchanged. Missing, blank, invalid base64, or a
  payload that decodes to zero bytes → `-32602`. Capped at **25 MB decoded**
  (`26,214,400` bytes), enforced twice — pre-decode on the base64 text length and
  post-decode on the byte length — so an over-cap payload is rejected before any
  provider call (see errors below).
- `mimeType?` — the audio container MIME type (e.g. `"audio/webm"`, `"audio/wav"`);
  defaults to `"audio/webm"` when omitted or blank.
- `language?` — optional language hint, forwarded to the provider. When absent or
  blank, the `voice.language` setting (§5.12) fills the gap — see "Language
  resolution" below.
- `provider?` — per-call provider override: `"elevenlabs" | "openai"` (the same enum as
  the `voice.provider` setting); any other value → `-32602`. Absent → the
  `voice.provider` setting (§5.12) selects the provider.
- `context?` — `{ prompt?: string, keyterms?: string[] }` — optional domain-vocabulary
  hints for transcription accuracy (e.g. workspace title, branch name, agent names).
  `keyterms` must be an array of strings (a non-array or non-string element →
  `-32602`; an explicit `null` is treated as absent). Mapped per provider — see
  "Context mapping" below.
- `workspaceId?` *(v5.1)* — opt-in workspace-vocabulary injection: when present and
  naming a known workspace, the daemon merges that workspace's auto-derived
  vocabulary into the transcription bias (see "Workspace vocabulary" below).
  **Tolerant by design**: an absent, unknown, or stale `workspaceId` (e.g. a
  workspace deleted since the client cached it) is never an error — the call behaves
  exactly like a no-`workspaceId` call; only a wrong **type** (a non-string value)
  → `-32602`.

**Result:**

- `text` — the transcript.
- `provider` — the provider that actually served the request (`"elevenlabs"` or
  `"openai"`), so clients can attribute the result when the setting (not a per-call
  override) chose it.
- `durationMs` — the transcribed **audio duration** in milliseconds as reported by the
  provider (ElevenLabs: the last word's `end` timestamp; OpenAI: the response
  `duration` field — not request latency). **Always present, `null` when the provider
  does not report it** (unlike the §5.39-style omitted-when-unset convention).

**Context mapping (per provider).** The daemon biases every transcription with the
user-editable **`voice.vocabulary`** setting (§5.12 — a string array defaulting to
`["Intent"]`; users add their own terms, the shipped default is minimal),
**read per call** — an absent or non-array stored value degrades to an empty list and
non-string elements are skipped, never an error — plus a fixed style hint ("Technical dictation in a
software-engineering app; preserve code identifiers and file paths verbatim.") — and,
when the call carries a `workspaceId` naming a known workspace, the auto-derived
**workspace vocabulary** (v5.1; see "Workspace vocabulary" below) — and merges the
request's `context` into it, in the fixed order user `voice.vocabulary` → workspace
auto-terms → `context.keyterms`:

- **OpenAI** — composed into the API's single free-form `prompt` parameter: the style
  hint, then `" Vocabulary: <terms comma-joined>."` (configured vocabulary +
  workspace auto-terms + `context.keyterms`, in that order), then `context.prompt`
  appended.
- **ElevenLabs** — the configured vocabulary and `context.keyterms` feed Scribe v2
  **keyterm prompting** (repeated `keyterms` form fields; requires `model_id:
  scribe_v2`): vocabulary first, then workspace auto-terms, then request keyterms;
  case-insensitive dedup (first
  spelling wins); blank and > 50-char terms skipped; hard cap of 100 total.
  `context.prompt` has no ElevenLabs equivalent and is **ignored** for this provider.

**Workspace vocabulary (v5.1).** When `voice.transcribe` carries a `workspaceId`, the
daemon injects that workspace's **auto-derived vocabulary** — unique/non-dictionary
and rare terms mined from the workspace's own docs, so project-specific identifiers
(e.g. "intentd", "clippy") transcribe correctly with no manual `voice.vocabulary`
entry — into the merge, between the user vocabulary and the request keyterms: user
`voice.vocabulary` → workspace auto-terms → `context.keyterms`, under the existing
rules above (case-insensitive dedup, first spelling wins; blank and > 50-char terms
skipped; hard cap of 100 total). Derivation sources are the workspace's root
`README` / `AGENTS` docs, the same docs one directory level down (e.g.
`packages/*/README.md`-style direct children), and the workspace's spec note; the
derived list is capped by the `voice.workspaceVocabulary.maxTerms` setting (§5.12 —
default 50, `0` disables derivation and injection entirely) and **content-hash
cached**: unchanged sources mean no re-extraction on subsequent calls (a source edit
or a `maxTerms` change takes effect on the next derivation). Per the `workspaceId?`
param above, a stale or unknown id degrades to no injection — never an error.

**Providers.** Both are typed REST engines over `reqwest` (the `intent-linear` /
`intent-sentry` pattern):

- **ElevenLabs** — multipart `POST https://api.elevenlabs.io/v1/speech-to-text` with
  `model_id: scribe_v2` (required for keyterm prompting).
- **OpenAI** — multipart `POST https://api.openai.com/v1/audio/transcriptions` with
  `model:` the configured `voice.openai.model` setting (§5.12; `gpt-4o-transcribe` |
  `gpt-4o-mini-transcribe` | `whisper-1`, default `gpt-4o-transcribe`), with a one-shot
  `whisper-1` fallback when the selected model is unavailable on the account (404 /
  model-not-found) — skipped when `whisper-1` itself is the selected model.

**Language resolution.** The language hint the daemon forwards to the provider is
resolved as: per-call `language` → the `voice.language` setting (§5.12) → none
(provider auto-detection). Both rungs are trimmed and a blank value behaves like
omitted — a whitespace-only per-call `language` falls through to the setting, and a
blank stored setting is treated as unset. The setting is an optional ISO-639-1 string
with no default, TOML-backed under `[voice]` like `voice.provider`.

**Settings & secrets (§5.12).** `voice.provider` (enum: `elevenlabs` | `openai`, default
`elevenlabs`; an invalid stored value silently falls back to the default) selects the
provider when the call carries no override — selection order: per-call `provider` →
`voice.provider` setting → `elevenlabs`. `voice.language` supplies the default
transcription language hint (see "Language resolution" above). `voice.openai.model`
selects the OpenAI
transcription model (see "Providers" above). `voice.workspaceVocabulary.maxTerms`
caps the auto-derived workspace vocabulary (v5.1; see "Workspace vocabulary" above).
The API keys are the **sensitive** catalog
entries `voice.elevenlabs.apiKey` / `voice.openai.apiKey`, persisted to the daemon's
file-backed secret store (`~/intent/secrets.json`, `0600`) and settable via
`settings.update` — the FE "connect" flow, exactly like `linear.token`. Key resolution
is **secret store first, then env fallback** (`ELEVENLABS_API_KEY` / `OPENAI_API_KEY`);
empty/whitespace-only values are treated as absent at both levels.

**Errors** (§9):

- Caller-input problems — missing/blank/invalid-base64/zero-byte `audio`, an unknown
  `provider` value, a malformed `context.keyterms`, a non-string `workspaceId`
  *(v5.1)* — → `-32602` with the generic `error.data.code: "invalid-params"`
  discriminator (no voice-specific `-32602` data codes). A **stale or unknown**
  `workspaceId` is deliberately NOT among these — it is tolerated (see "Workspace
  vocabulary" above); only the wrong type errors.
- **Audio too large** (over the 25 MB cap, either enforcement point) → `-32602`
  (`"audio exceeds the 25 MB limit"`) — rejected before any provider call.
- **No API key configured** for the selected provider → `-32603` with the generic
  `"Internal error"` message and **structured** `error.data` *(v4.4;
  monorepo#1448)*: `{ "code": "voice-no-api-key", "detail": "<descriptive message>" }`.
  Clients match `data.code` to surface an actionable "configure in Settings" hint
  (the `detail` names the provider and both key sources), keeping a message sniff on
  the detail text only as a fallback for pre-4.4 daemons — whose `error.data` was the
  same descriptive text as a plain string, byte-identical to today's `data.detail`:

  ```json
  { "code": -32603, "message": "Internal error",
    "data": { "code": "voice-no-api-key",
      "detail": "voice not configured: voice: no API key found for elevenlabs (set voice.elevenlabs.apiKey or ELEVENLABS_API_KEY)" } }
  ```

  This is the **only** voice-specific data code; no other `voice.transcribe` failure
  carries one.
- **Provider HTTP failure** (auth rejection, rate limit, 5xx, decode errors) →
  `-32603` with the provider's error detail in `error.data` (a plain string,
  unchanged in 4.4 — e.g.
  `"voice auth error: elevenlabs returned 401 Unauthorized: …"`); the API key
  never appears in the error.

```json
// → request
{ "jsonrpc":"2.0","id":97,"method":"voice.transcribe","params":{
  "audio":"GkXfo59ChoEBQveBAULygQRC…","mimeType":"audio/webm","language":"en",
  "workspaceId":"ws-abc",
  "context":{ "keyterms":["cloudlands-fe","submodule","clippy"] } } }
// ← response
{ "jsonrpc":"2.0","id":97,"result":{
  "text":"Bump the cloudlands-fe submodule and rerun clippy.",
  "provider":"elevenlabs","durationMs":3200 } }
```

**`voice.getWorkspaceVocabulary` *(v5.1)*.** The read RPC serving a workspace's
auto-derived vocabulary — the **derived terms only** (the user's `voice.vocabulary`
is a separate §5.12 setting and is not merged in) — for clients that transcribe
**outside** the daemon (e.g. the desktop OS-engine dictation path) and for Settings
previews, so both engines bias with the same terms. The response is served from the
same content-hash cache the `voice.transcribe` injection uses (unchanged sources ⇒
no re-extraction), already capped by `voice.workspaceVocabulary.maxTerms`
(`{ "terms": [] }` when the setting is `0` or nothing derives). Unlike the tolerant
`workspaceId?` on `voice.transcribe`, the param here is **required** and validated:
an unknown `workspaceId` is the standard not-found error (`-32602` with
`error.data.code: "not-found"`, §9).

```json
// → request
{ "jsonrpc":"2.0","id":98,"method":"voice.getWorkspaceVocabulary","params":{
  "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":98,"result":{
  "terms":["intentd","clippy","cloudlands-fe","TOON"] } }
```

### 5.42 Centralized PR monitoring — `prMonitor.*` *(v6.1)*

Centralized PR monitoring ([intent-hq/intentd#989](https://github.com/intent-hq/intentd/pull/989)): an agent registers a **daemon-run monitor** on a PR via the MCP `ws.pr.monitor` binding, and one shared daemon loop polls every active monitor (every `prMonitor.pollSeconds`, §5.12, read live, floor 10s), diffs a **merge-requirements checklist** against the monitor's persisted **emit baseline** — the PR state as of the last delivered wake (or registration) — and wakes the owning agent with a **single consolidated, debounced notification** once the PR has been quiet for `prMonitor.debounceSeconds` (§5.12) — a busy PR that never goes quiet still gets its wake via the max-latency bound (5 debounce windows since the oldest un-emitted change; late, never starved — conditional on the coalesced set staying continuously non-empty: a full revert empties the set and re-arms the clock, by design). The pending set is a **coalesced net diff, recomputed against the emit baseline on every poll — never an accumulated log**: a field that moved A→B→C reports one initial→final line, a field that reverted to its baseline value drops out of the set, and a PR that fully reverts within the debounce window empties the set — nothing pending, debounce anchors reset, **no wake sent**. Each delivered wake advances the baseline to the delivered snapshot, so the next wake reports only what moves from there; a merged/closed PR terminalizes the monitor with an immediate, undebounced final wake (state `completed` — the row is retained so merged PRs stay visible) whose "changes since the last report" section coalesces the same way. Monitors are persisted (SQLite `pr_monitor` table), **survive daemon restarts** via boot rehydration with catch-up delivery (the net diff against the pre-restart baseline fires on the first post-restart poll — only when non-empty), and have **no TTL** — this is why agents are steered to `ws.pr.monitor` over a self-authored §5.40 snapshot-diffing hook. Store writes are guarded compare-and-swap, so concurrent flush / cancel / re-register / poll never clobber each other. Safe when source control is unconfigured (the tick logs and returns).

**Registration is MCP-only** (per the §6.8 principle — PR watching is agent-authored background work; the same split as `hook.*` vs `ws.hook.schedule`): `ws.pr.monitor(prNumber, { repo? })` registers (or idempotently re-arms, refreshing the baseline — never a second monitor) the caller's monitor, scoped to the workspace repo unless `repo: "owner/name"` overrides it, and returns `{ ok, monitor, requirements }`; active monitors are capped at 5 per agent (`-32602`-style validation error beyond the cap). `ws.pr.unmonitor(prNumber, { repo? })` cancels the caller's **own** active monitor (unknown/foreign PR → not-found error; an owner's own cancel never self-wakes). `ws.pr.monitors()` lists the caller's active and completed monitors. The three bindings are gated by `agentFeatures.prMonitor` (§5.12).

The **wire surface is read/cancel/flush only** (the FE view over agent-owned monitors):

| Method | Params | Result |
| --- | --- | --- |
| prMonitor.list | workspaceId | { monitors: PrMonitor[] } — the workspace-wide view (every agent's monitors); `cancelled` rows are excluded, `completed` rows retained so merged PRs stay visible |
| prMonitor.cancel | workspaceId, monitorId | { ok, monitor } — cancels **any** monitor in the workspace by id and wakes the owning agent with a cancellation notice (unlike the agent's own `ws.pr.unmonitor`, which never self-wakes — the same one-directional visibility as `hook.cancel`, §5.40) |
| prMonitor.flush | workspaceId, monitorId, check? | { ok, flushed } — delivers a monitor's pending consolidated wake **now**, bypassing the remaining debounce window; `flushed: false` when nothing was pending (a no-op, not an error). `check?: boolean` *(additive; default `false`)* — when `true`, the daemon first performs an **immediate on-demand poll** of that one monitor (fresh snapshot fetched from the forge, coalesced pending set recomputed against the emit baseline through the same guarded CAS write as the loop, terminalizing with the final wake if the PR merged/closed), then flushes whatever is pending — so the flush covers changes the poll loop has not seen yet; the recomputed set being empty returns `flushed: false` with no wake. A forge fetch failure during the check records the monitor's `lastError` (baseline untouched) and returns an error. Omitting `check` (or `false`) preserves the pre-check semantics exactly; a non-boolean value is `-32602` |

**`PrMonitor` wire shape** (shared by `prMonitor.list`, the `ws.pr.monitor` / `ws.pr.unmonitor` results, and `ws.pr.monitors` rows): `{ monitorId, workspaceId, agentId, repo, prNumber, state, pendingChanges, hasPendingChanges, createdAt, updatedAt, pendingSince?, lastChangeAt?, lastPolledAt?, lastError?, title?, url?, lastSnapshot? }` — `repo` is the combined `"owner/name"` string; `state ∈ { active, completed, cancelled }`; `pendingChanges` is the human-readable **net** change lines since the last delivered wake — the coalesced diff against the emit baseline, recomputed each poll (awaiting the debounce window; it shrinks or empties when changes revert; `[]` when nothing is pending); `lastError` is the most recent forge-poll error (cleared by a successful poll — a failing poll never kills the loop); `title` / `url` / `lastSnapshot` are present once the monitor has a successful poll baseline, `lastSnapshot` being the last-refresh checklist summary `{ state, isDraft, hasConflicts, isBehind, mergeable, mergeBlockedReason, checks: { total, passed, failed, pending, failingRequired, pendingRequired, requiredKnown }, approvals: { decision, have, needed, changesRequested }, threads: { unresolved, resolutionRequired }, rulesKnown }`.

**`MergeRequirements` checklist** — "what is needed to merge this PR", the reusable object backing `ws.pr.monitor` (the `requirements` result field), the monitor loop's change detection, and the additive `requirements` block on `ws.pr.snapshot` (§5.7) — one canonical shape across all three surfaces. Shape: `{ state, isDraft, hasConflicts, isBehind, mergeable?, checks: { total, passed, failed, pending, items: [{ name, status, required, url? }], failingRequired, pendingRequired, requiredKnown }, approvals: { decision, have, needed?, changesRequested }, threads: { unresolved, resolutionRequired? }, mergeStateStatus?, mergeBlockedReason?, rulesKnown }`. `state` is the 4-value lifecycle word; `mergeable` is the forge's tri-state (omitted while still computing); each `checks.items[]` entry reports `status ∈ { passed, failed, pending }` and its own `required` flag, with `failingRequired` / `pendingRequired` naming the required checks that are failing/still running; `approvals.decision` is the §5.7 `ws.pr.snapshot` decision wire word, `have` counts distinct approving reviewers, `needed` the base branch's required approvals; `mergeStateStatus` is the host's raw merge-state status (GitHub GraphQL `mergeStateStatus`) — the residual signal for rules with no finer detail (merge queue, signed commits, hooks). Degradation is **per-signal, never fatal**: a host that reports no check rollup yields `checks.requiredKnown: false` (every `required` flag `false`, tallies fall back to the REST check runs), unreadable branch rules yield `rulesKnown: false` with `approvals.needed` / `threads.resolutionRequired` omitted, and a fully failed probe still produces the state / conflicts / approvals / threads rows from the snapshot alone.

**Wake deliveries** ride the automatic `agent.sendMessage` path (queued behind an in-flight turn, never interrupting) and tag the persisted user block with `messageMetadata { type: "pr_monitor_wake", monitorId, repo, prNumber, reason, url? }` — `repo` is the combined `"owner/name"` string, `reason ∈ { changed, completed, cancelled }` names why the owner was woken (the consolidated change emit — debounce elapsed, max-latency bound, restart catch-up, or a `prMonitor.flush` —, the PR-merged/closed final wake, or an FE `prMonitor.cancel` notice), and `url` *(additive, presence-detected)* is the PR's HTML URL read off the monitor's persisted baseline snapshot — the key is **omitted** (never `null`) when the monitor has no baseline yet.

Lifecycle is observable via the `prMonitor:*` event category (§6.5), and each agent's per-turn snapshot lists its active monitors (one `"owner/name#number"` label per monitor, suffixed `" (changes pending)"` while a debounced emit is accumulating).

**Idle-visibility & completion-watch deferral (unified external-wait, v6.2; [intent-hq/intentd#1002](https://github.com/intent-hq/intentd/pull/1002), [intent-hq/intentd#1007](https://github.com/intent-hq/intentd/pull/1007)).** An agent's ACTIVE PR monitors are surfaced the same way as its active background hooks (§5.40): the light `waitingOnPrMonitors?: [{ monitorId, repo, prNumber, title? }]` list on `agent:idle` (§6.5), the `AgentLite` projection (§5.5), and `agent.diagnostics` agent rows — and completion-watch / `after_all` settlement defers on such an idle exactly like the hook-waiting case (§Completion-watch persistence), with one key difference: PR monitors have **no TTL**, so the deferral is unbounded except by the monitor's own terminal transitions (complete, owner `ws.pr.unmonitor`, external `prMonitor.cancel`, the `workspace.archive` sweep cancel — §5.1 archive active-work teardown, [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067) — or owner-gone restart rehydration).

```json
// → request — the FE's workspace-wide monitor list
{ "jsonrpc":"2.0","id":99,"method":"prMonitor.list","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":99,"result":{ "monitors":[ {
  "monitorId":"prm-1","workspaceId":"ws-abc","agentId":"agent-1",
  "repo":"octo/repo","prNumber":12,"state":"active",
  "pendingChanges":["check ci: pending → failed"],"hasPendingChanges":true,
  "pendingSince":"2026-08-07T12:00:00.000Z","lastChangeAt":"2026-08-07T12:00:00.000Z",
  "lastPolledAt":"2026-08-07T12:00:30.000Z","title":"Add review wire surface",
  "url":"https://github.com/octo/repo/pull/12",
  "lastSnapshot":{ "state":"open","isDraft":false,"hasConflicts":false,"isBehind":false,
    "mergeable":true,"mergeBlockedReason":"1 required check failing (ci)",
    "checks":{ "total":3,"passed":2,"failed":1,"pending":0,
      "failingRequired":["ci"],"pendingRequired":[],"requiredKnown":true },
    "approvals":{ "decision":"approved","have":1,"needed":1,"changesRequested":0 },
    "threads":{ "unresolved":0,"resolutionRequired":true },"rulesKnown":true },
  "createdAt":"2026-08-07T11:58:00.000Z","updatedAt":"2026-08-07T12:00:30.000Z" } ] } }

// → request — deliver the pending consolidated wake now
{ "jsonrpc":"2.0","id":100,"method":"prMonitor.flush","params":{
  "workspaceId":"ws-abc","monitorId":"prm-1" } }
// ← response
{ "jsonrpc":"2.0","id":100,"result":{ "ok":true,"flushed":true } }

// → request — re-poll the PR on demand first, then flush (check-and-flush)
{ "jsonrpc":"2.0","id":101,"method":"prMonitor.flush","params":{
  "workspaceId":"ws-abc","monitorId":"prm-1","check":true } }
// ← response — nothing changed vs. the emit baseline: no wake
{ "jsonrpc":"2.0","id":101,"result":{ "ok":true,"flushed":false } }
```

### 5.43 Daemon stack sampling — `debug.sampleStacks` *(v6.3)*

Point-in-time sample of the daemon's **own** thread stacks ([monorepo#1755](https://github.com/intent-hq/monorepo/issues/1755)), the backend of the FE Help menu's "Sample intentd Process" flow (the Activity Monitor "Sample Process" analogue): the daemon captures its own thread backtraces in-process over a short window and returns the rendered, human-readable text report — no debugger, no shelling out to `/usr/bin/sample`, works over UDS and WSS alike (including remote daemons). Daemon-global — no `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| debug.sampleStacks | durationMs?, frequencyHz? | { report, durationMs, frequencyHz, sampleCount, distinctStacks } |

**Params** (both optional; a present non-numeric value — other than `null`, which reads as absent — is `-32602`):

- `durationMs?: number` — the sampling window in milliseconds, **clamped server-side** into [100, 10000]; default 1000. The RPC blocks for (at least) the effective window, so clients should size their request timeout accordingly.
- `frequencyHz?: number` — the sampling frequency in Hz, clamped into [1, 250]; default 99 (the conventional off-by-one from 100 that avoids lockstep with periodic work).

**Result:**

- `report: string` — the rendered text report: a header line stating the effective parameters and totals, then one block per distinct stack (highest sample count first), each naming its thread (name + id) and frames (symbol, and source file:line where available). **Never empty** — the header always renders; when no samples landed the report says so explicitly.
- `durationMs` / `frequencyHz: number` — the **effective** (clamped/defaulted) parameters the capture actually used.
- `sampleCount: number` — total samples captured across all threads.
- `distinctStacks: number` — number of distinct (thread, stack) entries in the report.

**Semantics & caveats:**

- **CPU-time sampling** (Unix `setitimer(ITIMER_PROF)` + `SIGPROF`, via the in-process `pprof` sampler): samples land on threads in proportion to CPU consumed, so a busy/spinning thread dominates the report and blocked/idle threads accumulate none — a fully idle daemon can legitimately return `sampleCount: 0`. This is exactly the right bias for the motivating diagnoses (CPU pegs, busy stalls); it does **not** enumerate parked threads the way macOS `sample` does.
- **One session at a time**: the profiler's signal handler is process-global, so a concurrent call fails immediately with `-32603` ("a stack sampling session is already in progress") rather than queueing.
- **The daemon never hangs while sampling**: the capture runs on the blocking pool; the async runtime and every other RPC proceed normally during the window.
- **Platform support**: Unix only (macOS, Linux). On other platforms (Windows) the method returns `-32603` with a message naming the limitation ("not supported on this platform") — clients should treat this as "hide/disable the menu item", keyed off the platform they already know.

```json
// → request
{ "jsonrpc":"2.0","id":1,"method":"debug.sampleStacks","params":{ "durationMs":1000,"frequencyHz":99 } }
// ← response
{ "jsonrpc":"2.0","id":1,"result":{
  "report":"intentd stack sample — 87 samples, 5 distinct stacks (1000 ms at 99 Hz, CPU-time sampling: idle/blocked threads accumulate no samples)\n\n61 samples — thread \"tokio-runtime-w\" (id 6154):\n    0: intent_services::disk_usage::walk (crates/intent-services/src/disk_usage.rs:118)\n  ...",
  "durationMs":1000,"frequencyHz":99,"sampleCount":87,"distinctStacks":5 } }
```

## 6. Events & Subscriptions

Live event streaming is the **canonical** way a thin client stays in sync. It uses two server-handled methods (the plural `events.` prefix) plus a server-pushed notification.

### 6.1 `events.subscribe`

```json
// → request
{ "jsonrpc":"2.0","id":60,"method":"events.subscribe",
  "params":{ "eventTypes":["agent:*","note:*"], "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":60,"result":{ "subscriptionId":"ws-sub-1" } }
```

Params:

- `eventTypes` (req) — **non-empty array** of event-type strings. Empty/missing → error(`-32602` over the wire). Supports exact types (`note:updated`) and `:*`** wildcards**(`agent:*`, `file:*`) — see §6.4.
- `workspaceId?` — scopes delivery to one workspace. Omit to receive matching events across allworkspaces the connection can see.
- `replaceGroup?` — if set, any existing subscription from the **same connection** with the same`replaceGroup` is removed first (useful for "switch the active workspace" without leaking subs).

A connection may hold **multiple** subscriptions. Each is identified by a server-assigned`subscriptionId` (`ws-sub-<n>`). Subscriptions are **per-connection** and are dropped on disconnect.

The [monorepo#1229](https://github.com/intent-hq/monorepo/issues/1229) agent-subscriber restriction (§5.5 `agent.subscribe`) does **not** apply here: `events.subscribe` is the FE/client bridge with no subscriber agent, so `agent:*` (and every other family) remains fully subscribable on this surface.

### 6.2 `events.unsubscribe`

```json
{ "jsonrpc":"2.0","id":61,"method":"events.unsubscribe","params":{ "subscriptionId":"ws-sub-1" } }
// ← { "jsonrpc":"2.0","id":61,"result":{ "success": true } }
```

`success` is `false` if the subscription id is unknown for this connection.

### 6.3 `events.event` notification (server → client)

Matching events are pushed as JSON-RPC **notifications** (no `id`):

```json
{ "jsonrpc":"2.0","method":"events.event","params":{
  "subscriptionId":"ws-sub-1",
  "event":{
    "type":"note:updated",
    "workspaceId":"ws-abc",
    "id":"evt-789",
    "timestamp":"2026-06-17T04:35:04.055Z",
    "actor":{ "type":"agent","id":"agent-123","name":"Coordinator" },
    "data":{ "noteId":"spec","title":"Spec","action":"update" }
  } } }
```

The `event` object carries exactly: `type`, `workspaceId`, `id`, `timestamp`, `actor`, `data`.If one event matches several of a client's subscriptions, the client receives **one notificationper matching subscription** (each tagged with its `subscriptionId`). Clients should de-dupe on`event.id` when they hold overlapping subscriptions.

### 6.4 Filter semantics

`eventTypes` is compiled to a type filter (and an optional `workspaceId` equality filter):

- **Single exact type** → equality match.
- **Multiple exact types** → membership (`in`) match.
- **Single **`prefix:*` → `starts_with "prefix:"`.
- **Multiple wildcards / mixed wildcard+exact** → a regex anchored match combining the prefixesand exact types.

All filters on a subscription are combined with **AND**. Delivery is gated *only* by this filtermatch — the bridge does not maintain any additional allow/deny list.

### 6.5 Event taxonomy

`actor.type` is one of `user | agent | system | external | tool`. Common event types(`namespace:name`) a client will encounter:

| Namespace | Types (selected) | Notes |
| --- | --- | --- |
| file | file:changed, file:created, file:deleted, file:renamed | `file:changed` is the canonical type — discriminate on `data.action = create\|modify\|delete\|rename`. `file:created` and `file:deleted` are emitted by the watcher alongside `file:changed` (new in intentd); `file:renamed` is registered in the taxonomy but **reserved-but-unused** (no emitter today — `rename` is surfaced through `file:changed` with `data.action = rename`). |
| note | note:created, note:updated, note:deleted | data.noteId, data.title, data.action — `{ noteId, title, action }` payload built by `note_change_event` (`intent-services/src/lib.rs`). No `path` field (never emitted). |
| line-attribution (new in intentd) | line-attribution:updated | Emitted after the daemon recomputes per-line attributions for a note (§5.2.1). data = { workspaceId, noteId, attributions } where `attributions` is the FE-parity `Record<lineNumber, { timestamp, author? }>`. Self-sufficient payload (§6.7) so the FE gutter re-renders without a follow-up `note.lineAttribution.load`. **Transient / broadcast-only** (same publish path as `chat:stream:delta`): never persisted to the event table, so it is invisible to `event.query` / §5.10 historical reads — the durable snapshot lives in `note_line_attribution` and is served by `note.lineAttribution.load` (§5.2.1). |
| task | task:created, task:status-changed, task:ready-tasks-changed, task:agent-linked, task:agent-unlinked | status + ready-task-id list. **`task:ready-tasks-changed`** data = `{ readyTaskIds, triggeredBy, computedAt }`. `triggeredBy` has two shapes, discriminated on the presence of `reason`: status-change emissions (the `task.updateNoteStatus` / `task.markAsTask` re-mark paths, §5.4) carry `{ noteId, previousStatus, newStatus }`, and non-status triggers (monorepo#1981) carry the additive `{ noteId, reason: "relations-changed" \| "note-deleted" }` — `relations-changed` when a `task.setRelations` write (or a same-status `task.markAsTask` re-mark, where no status-shaped emission runs) actually changed the task's `dependsOn` list (`noteId` = the rewritten task), `note-deleted` when a `note.delete` of a task note moved the ready set (`noteId` = the deleted note; monorepo#1981, generalized by intentd#1121 — the deleted task was itself ready, its removal readied its parent, or other tasks `dependsOn` it, where the dangling edge counts as unmet). Status shapes are byte-identical to the pre-#1981 contract. **`task:created`** ([intent-hq/intentd#978](https://github.com/intent-hq/intentd/pull/978)) fires when a note **becomes** a task, so subscribers (e.g. the FE HUD feed) see new tasks without inferring task-ness from a `note:created`/`note:updated` payload. data = `{ noteId, noteTitle, status, createdAt, agentId? }` — a self-sufficient payload (§6.7); `status` is the task-note status word (§5.4 vocabulary) and `createdAt` is the timestamp the note **became a task** — the note's own `createdAt` on the born-a-task paths (`task.convertBlocks`, `task.createPrerequisite`, where the two coincide) and the mark timestamp (the note's freshly written `updatedAt`) on `task.markAsTask`, where an ordinary note created earlier becomes a task now. It is a task-creation timestamp, never a note-creation timestamp, so ordering a feed by it is always ordering by when task-ness appeared. Like `task:status-changed`, the event carries the **agent** actor plus `agentId` when the creation is agent-attributed and the **system** actor otherwise (`agentId` omitted, never `null`). Emitted **exactly once per note becoming a task**, on every creation path: `@@@task` block conversion (`task.convertBlocks`, including the auto-convert hook after a note mutation — one event per converted block, carrying the outer write's caller), `task.createPrerequisite`, and `task.markAsTask` on a note that was not already a task. Re-marking an existing task publishes no `task:created` — it is a status move (§5.4). `task:agent-linked` / `task:agent-unlinked` (new in intentd) are emitted by `task.linkAgent` / `task.unlinkAgent` (§5.4); self-sufficient payloads `{ workspaceId, noteId, taskKey, link }` and `{ workspaceId, noteId, taskKey }` so subscribers rebuild the `byNoteId → byTaskKey` map without a follow-up `listAgentLinks`. |
| agent (lifecycle) | agent:started, agent:completed, agent:failed, agent:idle, agent:created, agent:deleted, agent:delete-scheduled *(v6.7)*, agent:delete-cancelled *(v6.7)*, agent:restored, agent:renamed, agent:updated, agent:status-changed | `agent:delete-scheduled` / `agent:delete-cancelled` (v6.7, §5.5 delete grace window) carry self-sufficient payloads — `{ agentId, workspaceId, deleteAt }` (ISO commit deadline) / `{ agentId, workspaceId }` — so clients flip the pending-delete state without a follow-up read; the committed deletion still emits the ordinary `agent:deleted`. `agent:updated` (new in intentd, P3-1.2b) is the generic session-mutation invalidation — emitted on `agent.setModel`, the `agent.reportToParent` completion-report persist, the `agent.dismissQuestions` marker persist (v2.8; data `{ agentId, dismissedQuestionsMessageId }`, §5.5 question hold), the `agent.markSeen` marker persist (v4.5; data `{ agentId, lastSeenMessageId }`, §5.5 — not emitted on the monotonic older-message no-op or the idempotent re-mark), and the agent-attention-request raise/clear (§5.5: raise → `data { agentId, attentionRequestKind, attentionRequestTimestamp }`; turn-begin clear → `data { agentId, attentionRequestCleared: true }`); the `agent` collection channel maps it to an `updated` delta. `agent:idle` data is enriched with `agentName` (so subscribers don't fall back to a generic "Agent" label), `isBackground` (boolean, sourced from the session's persisted `is_background` flag — the same flag served as `metadata.isBackground` on `agent.list`/`agent.get`, §5.5 — so subscribers such as iOS notification routing can branch on it without a follow-up `agent.get`), and — when the child persisted one via `agent.reportToParent` — the completion report, emitted under both `completionReport` (canonical; readers should prefer it) and `report` (legacy alias, kept for back-compat) with identical values; the enrichment is emitted from both the turn-end idle and the STAB-28 interrupt-path synthetic idle, and a session-read failure is swallowed (the event still fires with the base payload, enrichment fields absent). `agent:idle` data also carries `isWaitingForOtherAgents` (boolean) — computed **at emit time** from the idle agent's pending completion watches (the same derivation as the §5.5 `AgentLite` flag; watches already marked `report_delivered` — the `agent.reportToParent` parent wake already fired, §5.5 — are excluded, matching the settlement predicate, [monorepo#1649](https://github.com/intent-hq/monorepo/issues/1649)) so notification clients can suppress "agent finished" alerts snapshot-consistently: a follow-up `agent.list`/`agent.get` read can race the awaited child's completion consuming the watch, but the flag frozen into the idle payload cannot. Emitted on both the prompt-turn idle and the harness-wake idle (§6.6); independent of the session read, so it is present even when the other enrichment fields are absent. The rehydration-reconciliation and group-rehydration synthetic idles stamp the same flag (raw pending-watch derivation), so subscribers see it consistently across live and synthesized emits. **An idle stamped `isWaitingForOtherAgents: true` is generally not a completion for watches or `after_all` settlement** (the agent-waiting deferral, §Completion-watch persistence; behavior-only within v4.3, [monorepo#1468](https://github.com/intent-hq/monorepo/issues/1468)) — the agent will run again when a watched target completes, so watch delivery and group settlement records defer until it settles for real; note the deferral decision itself is a live delivery-time classification with a 2-cycle deadlock guard, NOT the raw emit-time stamp (a mutual-idle watch pair delivers despite carrying the stamp), so the flag is a rendering/suppression hint, not the settlement predicate. **`agent:idle` carries `waitingOnHooks?`** (idle-visibility, within v3.1): `[{ hookId, name, nextRunAt?, expiresAt? }]` — light metadata for the idle agent's ACTIVE (`scheduled`/`running`) background hooks (§5.40), stamped **at emit time** on every idle emit site (prompt-turn idle, harness-wake idle, STAB-28 interrupt-path idle, the queue-retraction synthesized idle, and rehydration-reconciliation synthetic idles) so subscribers can tell a hook-waiting idle agent (it will wake again when a hook dispatches, fails, or expires) from a stalled one; **omitted when the agent owns no active hook** (absent, never `[]`), payload deliberately excludes code/lastState/logs, and a hook-store read failure is swallowed (the event fires without the field). For completion watches and `after_all` groups such an idle is **not** a completion at all — delivery/settlement defers until the child goes idle with no active hooks (the hook-waiting deferral, §Completion-watch persistence), so no parent wake carries the stamp mid-wait. The same `waitingOnHooks` list is served on the §5.5 `AgentLite` projection (`agent.list`/`agent.get`, one workspace-batched hook query for list) and on `agent.diagnostics` agent rows, omitted when empty in all three surfaces. The immediate `agent.reportToParent` wake's `event_notification` metadata (§5.5) carries the same dual keys on its `events[0].data`. **`agent:idle` carries `waitingOnPrMonitors?`** (idle-visibility, unified external-wait, within v6.2; [intent-hq/intentd#1007](https://github.com/intent-hq/intentd/pull/1007)): `[{ monitorId, repo, prNumber, title? }]` — the same light-metadata treatment as `waitingOnHooks`, mirroring it field-for-field, for the idle agent's ACTIVE PR monitors (§5.42): stamped **at emit time** on every idle emit site, **omitted when the agent owns no active monitor** (absent, never `[]`; no `lastSnapshot`/`pendingChanges`), and a monitor-store read failure is swallowed (the event fires without the field). For completion watches and `after_all` groups such an idle is likewise **not** a completion — delivery/settlement defers until the child goes idle with no active PR monitors (the pr-monitor-waiting deferral, §Completion-watch persistence). The same list is served on the §5.5 `AgentLite` projection and `agent.diagnostics` agent rows, omitted when empty in all three surfaces. **`agent:idle` carries `workspaceArchived?`** (additive optional field, presence-detected per the §5 convention): `true` iff the emitting workspace's lifecycle status (§5.1 `workspace.archive`) is `Archived` at emit time, **omitted otherwise** (absent, never `false` — older daemons never send it, so clients treat an absent field as not archived), stamped on every published idle emit site (prompt-turn idle, harness-wake idle, the STAB-28 interrupt-path synthetic idle — the idle that fires in a just-archived workspace, since `workspace.archive` persists `Archived` before gracefully interrupting in-flight turns — and the queue-retraction synthesized idle) so notification clients can suppress "agent finished" alerts for parked workspaces without a follow-up `workspace.get` read; a workspace read failure is swallowed (the event fires without the field). The `agent:idle` event itself is NEVER suppressed for archived workspaces — completion watches, activity reconciliation, and chat UI still depend on it; the daemon-side companion is the turn-end unread gate (the `raise_attention` write described on the `workspace:displayStatus-changed` row below): a turn finishing in an archived workspace also skips the `WorkspaceAttention::Unread` raise (fail-open: a store error on the workspace read raises anyway), so no blue dot appears until unarchive. The terminal-failure `agent:status-changed` (emitted when a spawn/turn failure parks the session in `error`) carries `data { agentId, status: "error", isActive: false, stopReason, stopReasonTimestamp }` — `stopReasonTimestamp` is the ISO timestamp the failure was persisted (the same value written to `agent_session.stop_reason_timestamp` alongside `stop_reason`, and served as `stopReasonTimestamp` on the §5.5 `AgentSession`/`AgentLite` projections, omitted when absent), so clients can render how long ago a parked-in-error session failed; wherever a status change sets or clears `stopReason` on the wire, `stopReasonTimestamp` rides along with the same set/`null` semantics (cleared on turn begin and `agent.retry`) — plus, when the failure classifies as corrupted/poisoned per monorepo#940 (session-fatal provider block, deterministic `session/prompt` 400 rejection, or the identical-failure streak at threshold), `sessionCorrupted: true` (**omitted otherwise**, matching the derived flag on the §5.5 `AgentLite`/`AgentSession` projections), so subscribers get the structured "retry will recreate / spawn fresh" signal without parsing `stopReason`. Each **distinct** terminal failure also appends a durable system-role transcript notice — a single text block carrying the error text with `meta.kind = "turn-failure"` (the `InterruptionNotice` shape, §5.35), emitting the standard `agent:message` (`role: "system"`) with agent-list cache invalidation, best-effort (an append failure is logged and swallowed; the persisted status/stopReason is the durable contract) — so the failure survives rehydration as a transcript card; a repeat of the **identical** failure text with **no intervening `agent.retry` or successful turn** (e.g. repeated fresh `agent.sendMessage` redrives of an ordinary error session) does NOT append a duplicate notice — but `agent.retry` resets the dedup streak (the deliberate quarantine escape hatch), so an identical failure immediately after a retry DOES get its own fresh notice (the user acted and it failed again, which is new information). **`agent:failed` carries `turnId?`** ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)): both emit sites — the turn-worker failure arm (`run_prompt_turn`) and the not-surfaced-by-streaming terminal path (`publish_terminal_failure_events`, e.g. spawn-retry exhaustion; its paired terminal `agent:stream:end` carries the same id) — stamp the failed turn's correlation id onto `data { agentId, error, turnId?, parentAgentId? }`, the SAME `turnId` the send/enqueue RPC returned (preserved across terminal-failure requeues), so clients attribute the failure to the exact turn instead of approximating; omitted when the turn has none (bare test wiring), never `null`. **`agent:failed` carries `parentAgentId?`** ([intentd#788](https://github.com/intent-hq/intentd/pull/788)): enriched centrally at publish time from the failing session's `parent_agent_id`, so EVERY emit site (turn-worker failure arm, spawn-retry terminal path, idle-timeout cap) carries it; present only when the failing agent is a delegated/parented agent and omitted entirely otherwise — never `null`, and when present always the parent's non-empty agent id, never `""` (a best-effort session-read failure also leaves the base payload untouched). The FE skips its failure-toast bookkeeping (`recordAgentFailure`) when the field is present (its non-empty-string check is defensive hardening, not a contract carve-out) — delegated-child failures surface through the parent wake instead of a user-facing toast. **Prompt idle timeouts suppress `agent:failed`** ([intentd#741](https://github.com/intent-hq/intentd/pull/741), §6.6 warn-and-continue): while the consecutive-timeout cap holds, a timed-out turn emits no `agent:failed` (and no `agent:idle`) at all — its `agent:stream:end` is the normal one and a warning turn is redriven; once the cap is spent, the turn worker's drain loop emits the `agent:failed` half itself (same `{ agentId, error, turnId?, parentAgentId? }` payload) before the terminal-failure requeue |
| agent (messaging) | agent:message, agent:message:sent, agent:message:received, agent:user-message:sent, agent:tool:call | `agent:message` is the emitted per-persist transcript signal — fired whenever a message row is appended (user send, `agent.appendMessage`, system markers) with `data { agentId, messageId, role, appMessageId?, turnId? }`; discriminate the user-row echo on `role == "user"`. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) is the turn correlation id — present on user-row echoes emitted by a turn that carries one (direct sends, queue drains, `agent.sendQueuedMessageNow` deliveries), omitted otherwise (wake deliveries, `agent.appendMessage`, system markers; never `null`). `agent:message:sent`, `agent:message:received`, and `agent:user-message:sent` are registered in the taxonomy but **reserved-but-unused** (no emit sites today). `agent:tool:call` — see §7. |
| agent (subscriptions) | agent:subscribed, agent:unsubscribed, agent:woken-by-subscription, agent:delivery-confirmed, agent:event-delivery-failed/-timeout, agent:subscriptions-restored/-changed, agent:message:delivery-failed | `agent:subscriptions-changed` (emitted by intentd) fires when a parent's completion-watch set changes — a watch is added (`agent.delegate` auto-watch, MCP `create_agent` auto-watch) or removed by wake delivery (deliver-once retirement of an ungrouped watch, `after_all` group clear after its aggregated wake). data = { agentId, isWaitingForOtherAgents, waitingForAgentIds } — the refreshed waiting-flag snapshot for that parent (same waiting state exposed by `agent.getSubscriptions`, §5.5; `report_delivered` watches are excluded, the same exclusion as the §5.5 `AgentLite` flags and the settlement predicate — [monorepo#1649](https://github.com/intent-hq/monorepo/issues/1649)); self-sufficient (§6.7) so clients converge without polling `agent.getSubscriptions` |
| agent (attention, new in intentd) | agent:attention-requested | Emitted by the agent-attention-request op behind the MCP `ws.agent.requestDiscussion` / `ws.agent.reportBlocker` bindings (§5.5). data = { workspaceId, agentId, agentName, kind, reason, parentAgentId? } where `kind ∈ { discussion, blocker }` — self-sufficient payload (§6.7) driving the FE sticky toast without a follow-up `agent.get`. `parentAgentId` ([intentd#788](https://github.com/intent-hq/intentd/pull/788)) is present only when the caller is a delegated/parented agent (the session's `parent_agent_id`) and omitted entirely otherwise — never `null`, and when present always the parent's non-empty agent id, never `""`; the FE suppresses the sticky toast when the field is present (its non-empty-string check is defensive hardening, not a contract carve-out; the parent wake below is the delegated child's attention surface). Paired with an `agent:updated` raise on the same turn (session `attentionRequest*` fields persisted) and retired by the turn-begin clear (`agent:updated` with `attentionRequestCleared: true`) when the agent next receives a **user-origin** delivery (`agent.sendMessage`, `agent.sendQueuedMessageNow`, `agent.editAndRegenerate`, or a drained user-origin queue entry — same origin taxonomy as the §5.5 question hold) — or, for **child** (`parent_agent_id` set) / **background** (`is_background`) sessions, an **automatic** delivery too (A2A sends, parent/subscription wakes, `agent.sendToTask`, `agent.wakeOrCreate` context messages, drained automatic entries; the parent/coordinator is those agents' attention surface, §5.5). For top-level foreground agents automatic deliveries do NOT retire it. A delegated caller's immediate parent wake embeds this event's payload in its `event_notification` metadata (`events[0]`). |
| agent (streaming) | agent:stream:start, agent:stream:activity, agent:stream:end | see §7 — `agent:stream:activity` is the rename of `agent:stream:chunk` ([intent-hq/intentd#775](https://github.com/intent-hq/intentd/pull/775)) that dropped the per-chunk transcript delta (the incremental `content` firehose, which moved to the internal `chat:stream:delta`); it (and the terminal `agent:stream:end`) carries the server-derived live-preview fields `lastAgentResponse?` / `digest?` ([intent-hq/intentd#792](https://github.com/intent-hq/intentd/pull/792)) — a capped derived preview, not the raw delta stream; it is emitted from both the text-chunk arm and the tool-call arm sharing one throttle window, the tool arm additionally carrying `lastToolUse?` ([monorepo#1414](https://github.com/intent-hq/monorepo/issues/1414), §7); `agent:stream:start` is emitted **only** for agent-initiated (harness-wake) turns (§6.6) |
| chat (internal content feed, new in intentd) | chat:stream:delta | The content-bearing per-chunk stream payload ([intent-hq/intentd#775](https://github.com/intent-hq/intentd/pull/775) — where the former `agent:stream:chunk` content moved). data = { agentId, content, messageId, blockIndex, blockId, blockType, streamId? } (the §7.1 block-identity enrichment). `blockType` is `"text"` for assistant text, `"thinking"` for streamed reasoning (ACP `agent_thought_chunk`, additive within v6.0 — [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973); it rides the same chunk shape and the same stable `{messageId}:{blockIndex}` id), or the passthrough block's own type otherwise. Deliberately **outside** the `agent:*` family so `agent:*` / `agent:stream:*` `events.subscribe` filters never receive the high-volume transcript firehose — external subscribers get the throttled `agent:stream:activity` signal (liveness plus the capped server-derived preview fields, §7) instead; the §7.1 `chat.subscribe` forwarder is its one consumer. **Transient / broadcast-only** (§7): never persisted, invisible to `event.query` (§5.10) |
| agent (stream status, new in intentd) | agent:stream:status | Turn-startup hint — the pre-first-token status line. Emitted **before the first `agent:stream:activity`** of every turn on each startup transition the runtime actually has. data = { agentId, workspaceId, phase, message, level, timestamp } where `phase ∈ { launch, init, session-create, session-load, prompt }` (child process about to spawn / ACP initialize handshake / session/new / session/load / session/prompt dispatched) and `timestamp` is epoch-ms. Self-sufficient payload (§6.7); the FE renders the hint next to the chat spinner and clears it on the first `agent:stream:activity` or terminal `agent:stream:end` / `agent:failed` — note that since [monorepo#1414](https://github.com/intent-hq/monorepo/issues/1414) that first activity may come from the tool-call arm, so a tool-first turn clears the hint before any assistant text has streamed (by design: the tool call is real progress). The `init` phase's ACP `initialize` request has a **dedicated timeout, default 30s** (overridable via `INTENTD_ACP_INITIALIZE_TIMEOUT_MS`, positive integer ms) so slow provider cold starts under host load don't fail the spawn; all other ACP requests keep the generic 5s default. **`unsloth`-provider spawns emit repeated `launch`-phase events:** before the child spawns, the daemon starts/reuses its managed Unsloth server, and each progress transition (server starting, model preparing, plus a still-loading update every ~15s while a first-use multi-GB download runs) surfaces as an additional `phase: "launch"` / `level: "info"` event — same payload shape, higher cardinality; clients keep only the latest message per agent. A model-switch restart with live `unsloth` agents attached additionally emits one `phase: "launch"` / `level: "warning"` event **before** the restart (intentd#647), warning that those sessions will lose the loaded model. |
| agent (queue) | agent:queue:updated, agent:queue:processing, agent:queue:processing-cancelled, agent:queue:stale-message | `agent:queue:updated` → data { agentId, queue: QueuedMessage[] } — the full post-mutation queue snapshot (§5.5 wire shape, including each entry's `turnId?` and the v2.8 `interruptPriority?` flag), emitted on every enqueue/edit/remove/drain mutation — including question-hold parks (§5.5 question hold). `agent:queue:processing` *(newly emitted — [intentd#699](https://github.com/intent-hq/intentd/pull/699); the constant predates it but previously had no production emit site)* is the **drain-start signal** ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)): emitted by the queue-drain loop (all three drain arms) right after the shrunk `agent:queue:updated` and AFTER the #576 stale-redrive annotation (so `content` matches the persisted user row / provider prompt), with data { agentId, messageId, content, turnId? } (`turnId` omitted only for legacy entries without one; every enqueue path mints one today). It covers redrives whose user row is already persisted and therefore skip the duplicate `agent:message` echo — the FE keys prompt-turn start off `turnId` here. NOT emitted by `agent.sendQueuedMessageNow` (§5.5 — its RPC response carries the `turnId` instead). **Batch flush ([intentd#876](https://github.com/intent-hq/intentd/pull/876)):** a combined-turn flush (§5.5 "Queued-message flush") emits ONE `agent:queue:updated` (the fully-shrunk queue) and ONE `agent:queue:processing` for the HEAD entry — whose `turnId` is the combined turn's id — followed by per-row `agent:message` echoes all stamped with that same combined `turnId`. Audit history (never swept by the retention sweep, unlike the high-churn `agent:queue:updated`). `agent:queue:processing-cancelled` / `agent:queue:stale-message` are **reserved-but-unused** (no emit sites today). |
| agent (process registry, new in intentd) | agent:process:queued, agent:process:resumed, agent:process:evicted | Process-cap lifecycle of the daemon-global agent process registry (the `agents.maxConcurrent` cap, §5.12; monorepo#2063). Emitted when a spawn queues for admission, when a queued spawn resumes, and when the registry evicts the LRU idle process to admit a new one. All three carry the self-sufficient payload (§6.7) `data { agentId, used, cap, reason }` — `used` is the registered process count at emit time, `cap` the global slot cap, and `reason` (additive, monorepo#2063) is `"slots"` (the concurrency slot cap: all slots active / a slot freed) or `"memory-budget"` (the aggregate memory budget over the daemon's descendant tree, active only when a budget is installed and sampling). A queued waiter remembers the reason it parked under, so its matching `agent:process:resumed` echoes the same value; an eviction is labeled by the constraint that forced it, and when both constraints bind at once the budget wins the label (a freed slot alone cannot clear it). Best-effort publish: the payload needs a workspace lookup from the agent's session row, so an event for an agent whose session is missing (mid-create or already deleted) is skipped rather than blocking the registry path. Actor: agent (the affected agent's id). |
| workspace | workspace:created, :updated, :deleted, :delete-scheduled *(v6.7)*, :delete-cancelled *(v6.7)*, :opened, :closed, :activity, :activity-changed, :attention-changed, :context-changed | :delete-scheduled / :delete-cancelled (v6.7, §5.1 delete grace window) → data { workspaceId, deleteAt } / { workspaceId } — self-sufficient payloads so clients flip the pending-delete state without a follow-up read; the committed deletion still emits the ordinary `workspace:deleted`. :created → data { workspaceId, workspace }; :updated → data { workspaceId, changes } where `changes` is the applied `WorkspaceUpdate` delta — untouched (Option::is_none) fields are omitted, but a field may also carry an explicit JSON `null` to signal a clear (the same omitted = untouched / `null` = clear / present = set tri-state as the §5.1 explicit-null-clear contract). `workspace.archive` / `workspace.unarchive` (§5.1) emit the full applied delta on this same type (no dedicated event): archive → `changes: { archived: true, status: "Archived", archivedAt: <ts> }` (`<ts>` = the persisted ISO timestamp); unarchive → `changes: { archived: false, status: "Active", archivedAt: null }` (explicit JSON `null` so clients clear the field), additionally stamped `autoUnarchive: { reason: "agent_activity", agentId, agentName }` when the unarchive was the turn-start **auto-unarchive** (§5.1 auto-unarchive block; `agentName` is `null` on a failed session-name lookup) — the stamp is absent on manual `workspace.unarchive` / `workspace.restore` (absent ≠ present-false, so pre-stamp clients see the previous delta shape byte-for-byte). `updatedAt` is intentionally omitted from the delta by convention; :deleted → data { workspaceId }; :activity-changed → data { workspaceId, activity }; :attention-changed → data { workspaceId, attention }; :context-changed → data { workspaceId, items } (new in intentd — emitted by `workspace.updateContext` §5.1 with the persisted `ContextItem[]`). New in intentd; self-sufficient payloads (§6.7). **`workspace:deleted` ordering:** `workspace.delete` (§5.1) emits **one `agent:deleted` per live session first**, then the terminal `workspace:deleted` **before returning to the caller** (fast-ack) — the event and RPC response both complete before the background filesystem cleanup task finishes. Subscribers see per-session teardown and the workspace-row deletion event synchronously, while the heavy `remove_dir_all` work runs in a background task — the per-repository lock is held only for the git-metadata phase (registration prune + rename to a trash path + guarded branch delete), and the recursive removal runs after the lock is released. |
| workspace setup (new in intentd) | workspace:setup:started, workspace:setup:completed | Setup-stage lifecycle of `workspace.create` (§5.1 setup script execution; additive). `workspace:setup:started` → data `{ workspaceId }` — fires iff an effective setup script was resolved and a spawn will be attempted. `workspace:setup:completed` → data `{ workspaceId, ranScript, exitCode? }` — exactly one per logical create, on every terminal path of the setup stage: `ranScript` is `true` only when the script's terminal actually spawned, and `exitCode` (u32) is present only when the script ran to exit and its status was observable — **omitted (never `null`) otherwise**, so `{ ranScript: false }` covers the no-script, `skipIsolation`/no-worktree, pre-spawn-failure, and `workspace.duplicate` paths (duplicate emits an immediate `completed { ranScript: false }` under the duplicate's id, no `started`). Idempotent `workspace.create` replays publish neither event. Actor: system; self-sufficient payloads (§6.7). Consumed internally by the watcher registry: per-workspace watcher registration after `workspace:created` is deferred until this completion (60s backstop; a `workspace.open` during the setup window supersedes the deferral and starts the watchers immediately), so setup-window file churn never surfaces as `file:*` unless the backstop fires or the workspace is opened mid-setup. |
| spec/goal | spec:updated, goal:updated |  |
| comment | comment:added, comment:resolved | `comment:resolved` is emitted by `comment.resolveThread` (§5.3); self-sufficient payload `{ noteId, threadId, resolved }` lets a client flip the thread's resolved state without a follow-up read. |
| pr (new in intentd) | pr:linked, pr:updated, pr:unlinked | Emitted **only on change** by the background / on-demand PR refresh. Self-sufficient payloads: `pr:linked` → `{ workspaceId, prNumber, prUrl, prStatus, activePullRequest, pullRequests }`, `pr:updated` → `{ workspaceId, prNumber, prStatus, activePullRequest, pullRequests }`, `pr:unlinked` → `{ workspaceId }`. `pullRequests` is the daemon-owned `PullRequestInfo[]` list (every refreshed/discovered/created PR upserted by number, merged/closed PRs retained) so clients can render the full per-branch PR list without a refetch; it is always an array on the wire (`[]` when empty, never `null`). |
| agent (permission, new in intentd) | agent:permission:request, agent:permission:resolved | The interactive permission flow (§8). `agent:permission:request` carries the normalized `PermissionRequestData`; `agent:permission:resolved` carries the chosen outcome (`selected`/`cancelled`). Both are scoped to the agent (`sessionId == agentId`). |
| settings (new in intentd) | settings:changed | Emitted after settings.update (§5.12). data = { changes: [{ path, value }] }; sensitive values are redacted. |
| github (new in intentd) | github:auth-changed | Terminal transitions of the GitHub auth surface (§5.27). data = { status: "authorized"\|"expired"\|"denied"\|"error"\|"revoked" } — device-flow outcomes from the daemon's background poll, plus `revoked` from `github.revoke`. Global (no `workspaceId`, like `settings:changed`); never carries a token or code. |
| skills (new in intentd) | skills:changed | Emitted when the discovered skill set changes for a workspace. The daemon watches the 5 scan roots (user p1-3 + project p4-5) via `notify` watchers; when a SKILL.md file is created/modified/deleted, the daemon re-runs discovery for affected workspace(s) (500ms debounce), compares against the cached set, and emits this event only if the set actually changed. User-tier changes (p1-3) affect all workspaces; project-tier changes (p4-5) are workspace-scoped. data = { workspaceId }. Clients should re-fetch via `skill.list` (§5.34) to refresh the skill roster. |
| specialists (new in intentd) | specialists:changed | Emitted when the resolved specialist set changes for a workspace. The daemon watches the user (`~/.intent/specialists/`) and project (`<workspace>/.intent/specialists/`) tiers via `notify` watchers; when a specialist file is created/modified/deleted, the daemon re-resolves the specialist set for affected workspace(s) (500ms debounce), compares against the cached set, and emits this event only if the resolved set actually changed. User-tier changes affect all open workspaces (a change in `~/.intent/specialists/` emits one event per open workspace); project-tier changes are workspace-scoped. The bundled tier (including its compile-time embedded floor) is static and unwatched. Actor: system. data = { workspaceId }. Clients should re-fetch via `specialist.list` (§5.11) to refresh the specialist roster. |
| mcp | mcp:notification | data.topic, payload. The agent→BE MCP callback — distinct from the `mcp.servers.*` lifecycle surface. |
| mcp.servers (new in intentd) | mcp.servers:status-changed | Health/lifecycle of **external** MCP servers (§5.22). data = { serverId, status: McpServerStatus }. Emitted on every state transition; self-sufficient payload (§6.7). |
| git / terminal / test / build | git:, terminal:command, test:, build:* | Mostly reserved-but-unused. `git:commit` is emitted by `git.commit` / `git.agentCommit` (§5.6) with `data { workspaceId, operation: "commit", commit, message, files }` (the reserved FE `GitOperationEvent` shape); `git:pull` is emitted by `git.pull` (§5.6) on a successful pull with `data { workspaceId, operation: "pull", branch }` (same reserved shape, `commit`/`message`/`files` omitted) and requires a persisted workspace row whose `worktreePath` matches `repoPath` — the workspace-create auto-pull runs before the row exists and stays silent by design. Both successful paths also emit a follow-up `changes:git-status` so subscribers can refresh without a follow-up `git.status`. |
| git.clone (new in intentd) | git:clone:progress, git:clone:done | Streaming `git.clone` (§5.6), correlated by `data.requestId`; the same frames also carry `workspace.create` provisioning progress (§5.1). `git:clone:progress` → `data { requestId, phase, percent, message, progressId? }` where `phase ∈ { starting, counting, compressing, receiving, resolving, checkout, complete }` — plus, on `workspace.create` streams, `submodules` (aggregated `--recurse-submodules` progress, "Cloning submodules (N/M)"; appears on the create-orchestrated clone with or without a `progressId`) and, under a `progressId` only, `cache` (repo-cache ensure/refresh), `cow-copy` (CoW checkout copy), `worktree` (linked-worktree add), and `finalizing` (post-provisioning bookkeeping) — and `percent` is `0..=100`. `git:clone:done` → `data { requestId, ok, error?, errorCode?, progressId? }`; `error` is present iff `ok == false` and never carries the source URL or credentials; `errorCode` is present only when the failure was classified per the clone failure taxonomy (§9.1) — `path-invalid`, `askpass-missing`, `auth-required`, `repo-not-found`, `access-denied`, `network`, `destination-exists-non-empty` (the `clone-failed` catch-all is never emitted as `errorCode`; unclassified failures omit the key). `data.progressId` (additive, [intent-hq/intentd#1062](https://github.com/intent-hq/intentd/pull/1062)) is present on both frame types iff the frames belong to a `workspace.create` that supplied a `progressId` (§5.1 unified provisioning progress): the client-minted id is echoed verbatim on **every** frame of that create's stream, percent is normalized to one non-decreasing 0–100 scale (superproject clone phases 0–70, submodules 70–85, `cache` milestones anywhere in 0–85, provisioning tail 85–100), and exactly one terminal `git:clone:done` closes the stream per create — including error paths — while idempotent replays emit nothing. Standalone `git.clone` frames never carry the key. |
| terminal (new in intentd) | terminal:data, terminal:exit, terminal:title, terminal:cwd | Live PTY streaming (§5.13). data.chunk (terminal:data) is base64. `terminal:data` is **transient / broadcast-only** (same publish path as `chat:stream:delta`, §7): never persisted, invisible to `event.query` (§5.10); scrollback replay uses `terminal.getBuffer`. `terminal:exit` stays durable and is emitted after the stream task has broadcast every data chunk, so exit never overtakes data. |
| script (new in intentd) | script:output, script:state | Live script streaming (§5.8); shared PTY host. data.chunk (script:output) is base64. `script:output` is **transient / broadcast-only** (never persisted, invisible to `event.query` §5.10); replay uses `script.output`. `script:state` lifecycle transitions stay durable; the status value is one of `idle \| running \| restarting \| exited` (§5.8) — `restarting` (new in intentd, monorepo#1318) marks the transient restart-in-flight window (auto-restart backoff between an exit and the next spawn attempt, and the `script.restart` stop→start gap). The carried `ScriptRuntimeState` also surfaces the optional `previouslyRunning: true` was-running marker (§5.8; omitted when false), including the dismiss path — `script.stop` on a non-running marked script emits a `script:state` snapshot with the marker cleared, so other subscribers never retain a stale `previouslyRunning: true`. |
| search (new in intentd) | search:result, search:done | Streaming search results (§5.15), correlated by data.requestId. search:result → data { requestId, matches }; search:done → data { requestId, total, truncated }. |
| drafts (new in intentd) | draft:changed | Emitted after drafts.set / drafts.clear (§5.16). data = { workspaceId, agentId, clientId, hasDraft }; **no draft text** (no leakage). |
| changes (new in intentd) | changes:tracked, changes:git-status, changes:metrics-changed | Code Changes Review (§5.18–§5.20). `changes:tracked` → data { workspaceId, changes: TrackedChange[] } (emitted as the BE records attribution internally — there is no `file-tracking.trackChange` RPC). `changes:git-status` → data { workspaceId, status: WorkspaceGitStatus }. `changes:metrics-changed` → data { workspaceId, agentId?, metrics: Metrics }. Self-sufficient payloads (§6.7). |
| workspace usage (new in intentd) | workspace:tokenUsage-changed | Token/credit usage recomputed — live at ACP turn end, or by the internal reconciliation scan (§5.23). data = { workspaceId, tokenUsage: TokenUsage }. Self-sufficient payload (§6.7). |
| workspace display status (new in intentd) | workspace:displayStatus-changed | Derived `Workspace.displayStatus` rollup transitioned (§5.1). Mutation-driven, never polled: recomputed-and-compared after the mutations that can move the derivation (task status/metadata updates, task-note creation/deletion, PR link/status changes) — and, since intentd#793, on agent start/stop transitions: the 0→1 agent-running flip recomputes-and-emits immediately (normally the promotion to `in_progress`; a pending higher-precedence attention axis — `failed`/`blocked`/`needs_attention`, §5.1 — still outranks it and the transition-only emission suppresses the no-op), and the running→not-running recompute runs after the same debounce grace window as `workspace:activity-changed` (emitting whatever the not-running derivation yields — `idle`, a PR stage, or `complete`) — and on the watch/monitor/hook lifecycle transitions listed on the `workspace:waiting-changed` row below (since v6.17 those signals feed the orthogonal `waiting` flag, not this derivation — §5.1 step 3 — so this event's recompute-and-compare still runs at every one of those choke points but is normally a silent no-op there) — and, for the `needs_attention`/`blocked` axes (§5.1), on attention raises (`ws.agent.requestDiscussion` / `ws.agent.reportBlocker`) and retires (the turn-begin clear), question-asking turn ends (the turn-end `pendingQuestionsMessageId` marker write), and question-hold releases — within v6.0 only a `question_answers`-tagged user row naming the marked message, `agent.dismissQuestions`, or a NEWER question-bearing assistant turn releases the hold (§5.5); the recompute-and-compare still runs after every user-row persist by the send/drain paths (`agent.sendMessage` direct send, `agent.sendQueuedMessageNow`, `agent.editAndRegenerate`'s regenerated message, a drained user-origin queue entry) and every transcript mutation via the RPCs `agent.appendMessage` / `agent.replaceMessages` (§5.5) after persisting (intentd#833; intentd#965), so the trigger taxonomy holds unconditionally — an untagged row simply leaves the marker armed and the recompute a no-op — and, for the `failed` axis (§5.1, intentd#945), on the mid-turn Error park (recomputed as the park persists) and its retires: `agent.retry` (recomputed before the redriven worker starts, so the `failed → in_progress` transition emits immediately) and the fresh-`agent.sendMessage` recovery (recomputed after the user-row persist) — and, for the `review_required`-driven `needs_attention` (§5.1, intentd#945; the `unread` flag never feeds the derivation), on the workspace attention-flag writes that can move that axis: `workspace.dismissAttention` and `workspace.update { attention }` — the turn-end `raise_attention` writes only `unread` (fired only when a **top-level foreground** agent's queue drains, never for child (`parent_agent_id`) or background agents (intentd#1021), and skipped when the workspace is `Archived` at drain time (fail-open on a workspace-read error; [intent-hq/intentd#1075](https://github.com/intent-hq/intentd/pull/1075)); guarded no-op when the stored flag is not `none`) and `workspace.markSeen` only clears `unread`, so neither feeds the derivation and both skip the recompute — and emitted **only on an actual transition** — no-op recomputes stay silent. The in-memory baseline is seeded by the `workspace.list` / `workspace.get` emit-path enrichment (or lazily by the first post-mutation recompute); a first observation records without emitting, and a daemon restart re-seeds on first touch. data = { workspaceId, displayStatus }. Self-sufficient payload (§6.7). |
| workspace waiting (new in intentd, v6.17) | workspace:waiting-changed | The orthogonal `Workspace.waiting` flag transitioned (§5.1) — the workspace gained its first, or settled its last, live wait signal (ACTIVE background hook §5.40, ACTIVE PR monitor §5.42, or waiting agent subscription §Completion-watch persistence). Mutation-driven, never polled, and emitted **only on an actual transition** against a per-workspace last-observed baseline (the same transition-only + best-effort contract as `workspace:displayStatus-changed` above; no-op recomputes stay silent). Recomputed-and-compared at every choke point that can move a wait signal — **hooks** (intentd#856 established the sites): schedule (all validation-run outcomes) and every settlement — dispatch-retire, eviction, cancel (owner/FE/`workspace.archive` sweep), expiry, on both the synchronous ops and the spawned-task run paths, plus the boot-rehydration owner-gone cancel; **PR monitors** ([intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036) established the sites): register (`ws.pr.monitor`, including the idempotent re-arm), the owner (`ws.pr.unmonitor`) and FE (`prMonitor.cancel`) cancels, the `workspace.archive` sweep cancels ([intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)), the poll loop's terminal completion (PR merged/closed), and the boot-rehydration owner-gone cancels; **completion watches**, recomputed in the parent's home workspace: watch register/adopt (the `agent.delegate` auto-watch, `after_all` group enrollment, explicit `ws.agent.watch`), the deliver-once watch retirement at the child's completion, `after_all` group settlement, `agent.cancelSubscriptions` / `ws.agent.unwatch` cancels, and the workspace-delete subscription sweeps — the same choke points that publish `agent:subscriptions-changed`. Each site runs this recompute alongside the `workspace:displayStatus-changed` one; since v6.17 the waiting half is the one that normally emits there. The in-memory baseline is seeded by the `workspace.list` / `workspace.get` emit-path enrichment (a seed never emits; `workspace.delete` evicts it, and a daemon restart re-seeds on first touch). data = { workspaceId, waiting } — `waiting` is a plain boolean here (both values on the wire, unlike the presence-detected `Workspace` field). Self-sufficient payload (§6.7): clients flip the wait indicator directly, no follow-up fetch. Tailed by the global `workspace` subscription channel (§6.9). |
| agent stats (new in intentd) | agent:session-stats-changed | Per-session usage changed (§5.24). data = { sessionId, agentId?, stats: SessionStats }. Self-sufficient payload (§6.7). |
| sandbox (new in intentd) | sandbox:cow:created, sandbox:cow:merged | Emitted when `agent.delegate` resolves the `isolation` mode to `"cow"` on a sandbox-eligible workspace and the background provisioning task succeeds (§5.5 — asynchronous: the delegate result itself only ever reports `effectiveIsolation: "pending"`; this row is about the resolved request mode, not that result field) and when sandbox commits are successfully merged back to the canonical repository (§5.5a — auto-merge on completion or manual `sandbox.cow.merge`). `sandbox:cow:created` → data { workspaceId, agentId, sandboxPath, branch, baseCommitSha, snapshotCommitSha } where `sandboxPath` is the absolute filesystem path to the sandbox clone, `branch` is the sandbox snapshot branch (`sb/<agentId>`), `baseCommitSha` is the sandbox HEAD at provisioning, and `snapshotCommitSha` is the WIP-snapshot commit SHA (`null` when the source was clean). `sandbox:cow:merged` → data { workspaceId, agentId, commitRange, canonicalHead } where `commitRange` names the applied sandbox commit range and `canonicalHead` is the canonical repository HEAD SHA after the merge. Both are self-sufficient payloads (§6.7). |
| hook (new in intentd, v2.10) | hook:scheduled, hook:run-started, hook:run-completed, hook:dispatched, hook:evicted, hook:cancelled, hook:expired | Background-hook lifecycle (§5.40). All carry data { workspaceId, agentId, hookId, name, state, perpetual, dispatchCount } plus per-type extras: `hook:run-completed` adds `nextRunAt` when the hook stays scheduled; `hook:evicted` adds `lastError`; `hook:dispatched` fires when a run returns `{ dispatch: true }` (including the schedule-time validation run: a **retiring** (one-shot, or perpetual landing at/after `expiresAt`) validation dispatch emits `hook:run-completed` + `hook:dispatched` with **no** preceding `hook:scheduled`; a **persisting** validation dispatch — one-shot-shaped non-dispatch, or any perpetual dispatch that stays active — emits `hook:run-completed` then `hook:scheduled`, with a perpetual dispatch additionally emitting `hook:dispatched` between the two, per the §5.40 event-ordering note). `hook:expired` (v3.1) fires when the hook's TTL deadline passes (§5.40) — payload shape parity with `hook:cancelled` (the base data object, no extras); the owner is woken with `reason: "expired"`. **`perpetual` / `dispatchCount` ride on EVERY emission of the family** ([intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979); `dispatchCount` counts fires so far for every hook, so only a perpetual hook ever exceeds 1) so a subscriber can tell a non-terminal perpetual `hook:dispatched` from a terminal one-shot dispatch without a follow-up `hook.list`: **for a perpetual hook `hook:dispatched` is non-terminal and may repeat** — the hook re-arms (a `hook:scheduled` with a fresh `nextRunAt` follows each fire) and keeps running until TTL expiry, cancel, or eviction, so the sequence `hook:run-completed` → `hook:dispatched` → `hook:scheduled` recurs once per dispatching cadence tick. The post-dispatch state is resolved and persisted before those events are emitted, so their `state` is the real outcome (`scheduled`, or `expired` for a dispatch landing at/after `expiresAt`), never the transient `running`. Actor: system; the owner's agent id rides in `data.agentId` (the event row's internal session id is not part of the §6.3 wire object). Subscribe with a `hook:*` prefix filter — the family is **not** part of the bare-`*` category expansion applied by the internal `agent.subscribe`/`event.subscribe` aliases (§5.5/§5.10). |
| prMonitor (new in intentd, v6.1) | prMonitor:registered, prMonitor:changed, prMonitor:emitted, prMonitor:completed, prMonitor:cancelled | Centralized PR-monitor lifecycle (§5.42). All carry the canonical data { workspaceId, agentId, monitorId, repo, prNumber, state } (`repo` is the combined `"owner/name"` string; the owning agent's id rides in `data.agentId`); `prMonitor:changed` additionally carries `changes` (the coalesced net pending change lines). `registered` fires on registration **and** on an idempotent re-arm; `changed` on each poll where the net set changes — the set is the recomputed diff against the emit baseline (§5.42), so it can shrink or empty (`changes: []`) when changes revert; `emitted` when the consolidated wake is delivered (debounce elapsed, max-latency bound, restart catch-up, or a `prMonitor.flush` — never when the net set is empty: a fully reverted PR wakes nobody); `completed` when the PR merges/closes (monitoring stops with the immediate final wake); `cancelled` on an agent (`ws.pr.unmonitor`) or FE (`prMonitor.cancel`) cancel, and on each monitor swept by `workspace.archive` (§5.1 archive active-work teardown; [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)). Actor: system. |
| gitRoot (new in intentd, v6.15) | gitRoot:registered, gitRoot:updated, gitRoot:unregistered | Workspace-git-root lifecycle (multi git root tracking, §5.6; [monorepo#2053](https://github.com/intent-hq/monorepo/issues/2053)). Self-sufficient payloads (§6.7): `gitRoot:registered` fires when a secondary root is first registered (agent `ws.git.registerRoot` or the sweep's submodule auto-detect) and `gitRoot:updated` when an existing row changes (re-registration attribution merge / auto→agent source upgrade, the sweep's PR-field refresh, the sweep's `registeredCommitSha` backfill stamp) — both carry data { workspaceId, gitRoot } where `gitRoot` is the full persisted `WorkspaceGitRoot` row (§5.6; **no** live-read `branch` — that field is read per call on the serving surfaces only). `gitRoot:unregistered` fires on an explicit `ws.git.unregisterRoot` and on the sweep's auto-prune of a missing path — data { workspaceId, gitRootId, path }, so clients drop the row without a re-list. Actor: system. |
| workspace transfer (new in intentd, v6.11) | workspace:transfer:progress, workspace:transfer:ready, workspace:transfer:failed | Source-side workspace-export lifecycle (§5.1 `workspace.export.*`; [intent-hq/intentd#1118](https://github.com/intent-hq/intentd/pull/1118)). Self-sufficient payloads (§6.7) so the FE transfer wizard renders progress with no follow-up read. `workspace:transfer:progress` → data { workspaceId, exportId, stage, bytesWritten? } where `stage ∈ { stopping-agents, exporting-rows, bundling-git, writing-archive }` — emitted before each build stage runs, and `bytesWritten` rides only the final post-seal `writing-archive` emission. `workspace:transfer:ready` → data { workspaceId, exportId, manifest, archiveSizeBytes, archiveSha256, maxChunkBytes, totalChunks } — the sealed archive's manifest (byte-identical to the copy embedded in the zip) plus everything the FE hands to `workspace.import.begin` on the target. `workspace:transfer:failed` → data { workspaceId, exportId, reason } — staging cleaned, WIP snapshots unwound, workspace intact; the session is removed, so a retry is a fresh `workspace.export.start`. An aborted build emits **neither** `:ready` nor `:failed` (quiet cleanup). Actor: system. |

### 6.6 Turn/event lifecycle & batching window

**Prompt (user-initiated) turns.** A turn opened by a daemon-dispatched `session/prompt`
(`agent.sendMessage`, queue drain, wake delivery) emits **no** `agent:stream:start` — that event
is reserved for agent-initiated (harness-wake) turns below. For a direct send or wake delivery
the client infers turn start from the user-row `agent:message` echo (`role: "user"` — the
per-persist transcript event, §6.5; the `agent:message:sent` / `agent:user-message:sent`
constants are reserved-but-unused) and the first `agent:stream:activity` — wake deliveries share
only this start-signal inference; they carry no `turnId` (see the turn-correlation paragraph
below). **Queue-drained turns are
the one exception**: the drain loop additionally emits `agent:queue:processing` (§6.5) as an
explicit drain-start signal — see the turn-correlation paragraph below for why the echo alone is
not sufficient there. The turn streams `chat:stream:delta` (content, internal — §7) + the
throttled `agent:stream:activity` signal / `agent:tool:call` under the
assistant `messageId` minted at turn start, persists the assistant transcript row, emits exactly
one terminal `agent:stream:end`, then `agent:idle` (subject to the existing ready-to-send
suppression).

**Prompt idle timeout — warn-and-continue** *(new in intentd —
[intent-hq/intentd#741](https://github.com/intent-hq/intentd/pull/741))*. A prompt turn that
goes the **whole idle window silent** — no ACP `session/update` traffic for **30 minutes** by
default, overridable via `INTENTD_PROMPT_IDLE_TIMEOUT_MS` (integer ms; actively-streaming turns
reset the timer on every update and never time out) — is **not** treated as a turn failure. The
daemon cancel-and-settles the hung `session/prompt` (`session/cancel`; the child process is kept
alive, interrupt keep-alive semantics — only when the transport is already dead is the child
alone torn down, and the follow-up turn respawns it), flushes the partial assistant transcript
(if any) as an ordinary assistant row, and closes the turn with the **normal** terminal
`agent:stream:end` — `messageId` present iff a partial row was persisted (a fully silent turn
persists nothing, so its `stream:end` carries no `messageId`), `turnId` naming the timed-out
turn, no `stopReason`. **No `agent:failed`, no `agent:idle`, no terminal-failure requeue, and no
completion-watch / delegation / parent wake fires** — the busy slot stays held. The worker then
persists a **user-visible user-role warning row** — `[SYSTEM WARNING] Your turn exceeded the
inactivity timeout (<window>s of silence) and was interrupted. Assess where you left off and
continue the work.`, rendering the **actual configured window** — with the standard user-row
`agent:message` echo and a **fresh `turnId`**, and immediately dispatches it as a new
`session/prompt` turn on the same held slot; the redrive bypasses the queue drain, so **queued
messages cannot jump ahead of the warning turn**. **Consecutive-timeout cap:** at most **3**
back-to-back silent-timeout warning redrives; the 4th consecutive silent timeout takes the
terminal path — the worker emits `agent:failed` (`{ agentId, error, turnId? }`; the timed-out
turn's normal `agent:stream:end` already fired) and the standard terminal-failure handling parks
the session in `error` and requeues the message for `agent.retry`. The streak resets to zero on
any completed turn, and a timed-out turn that streamed output before going silent counts as
intervening activity — the streak **restarts at 1** rather than accumulating (so a turn
producing some output before every timeout is never capped; tracked in
[monorepo#1107](https://github.com/intent-hq/monorepo/issues/1107)).

**Turn correlation (`turnId`)** *(new in intentd —
[monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022) /
[intentd#699](https://github.com/intent-hq/intentd/pull/699))*. Every user-initiated turn carries
a daemon-minted stable correlation id, returned by the originating RPC (`agent.sendMessage` /
`agent.queueMessage` / `agent.sendQueuedMessageNow` — and `agent.retry` when `redriven: true`,
§5.5) and stamped onto the turn's wire surfaces: the user-row `agent:message` echo, the
`agent:queue:processing` drain-start signal, `agent:failed`, and the terminal `agent:stream:end`
(§6.5/§7). The `agent:stream:end` stamping covers the turn-worker terminal (complete and error
arms alike) and the not-surfaced-by-streaming terminal-failure path — but NOT the user-interrupt
flush (§7.2), which is a manager-side emit outside the turn worker and deliberately carries no
`turnId` (nor the harness-wake finalize, per the no-retry-record rule at the end of this
paragraph); see the §7 `agent:stream:end` entry for the per-emit-site payloads. The id is
**stable across terminal-failure requeues** — the requeued queue entry gets
a new entry `id` but keeps the failed turn's original `turnId` — and **survives daemon restarts**
(persisted on the `agent_queue` row; legacy pre-#1022 rows rehydrate with `turnId = id`), so a
failure and its `agent.retry` redrive correlate with the id the client keyed at send time. For a
queue-drained turn, `agent:queue:processing` is the explicit turn-start signal keyed by `turnId`
— it covers `persisted: true` redrives that skip the duplicate user-row `agent:message` echo,
which is why the echo alone is not a sufficient start signal. For a **batch-flushed** turn
(§5.5 "Queued-message flush") the combined turn's id is the HEAD entry's `turnId`: the single
`agent:queue:processing` and every flushed row's `agent:message` echo carry that same id, so
all N rows correlate with the one turn lifecycle. All `turnId` fields are additive
and omitted when absent (never `null`); agent-initiated (harness-wake) turns and wake deliveries
carry none (no user retry record exists for them).

**Agent-initiated (harness-wake) turns** *(new in intentd —
[intent-hq/monorepo#855](https://github.com/intent-hq/monorepo/issues/855))*. A provider harness
can self-wake the agent — e.g. a harness background worker finishing (the wake trigger observed
in [intent-hq/monorepo#851](https://github.com/intent-hq/monorepo/issues/851)) — and stream a
full turn of ACP `session/update`s with **no** daemon `session/prompt` in flight. The daemon
recognizes the out-of-turn burst as an **implicit agent-initiated turn** instead of letting it
buffer and flush into the next user turn:

- **Trigger.** A per-agent idle-notification listener consumes the notification channel whenever
  no prompt turn holds it (it stays disengaged during prompt turns and during the `session/load`
  resume-replay drain — replay bursts are still discarded, no change there). On the first
  out-of-turn `session/update` that **materializes transcript content** — a text chunk, or a
  tool call with a derivable non-empty `toolName` — it claims the per-agent single-flight turn
  slot and mints an assistant `messageId`. Status-only / unmappable notifications and name-less
  tool-call first-sights are consumed and dropped **without** opening a turn, so a status-only
  wake burst never produces an `agent:stream:start` (avoiding a phantom
  `stream:start`/`stream:end` pair that would pin the busy slot for the settle window).
- **Start signal.** The turn opens with `agent:stream:start`
  `{ agentId, messageId, reason: "harness-wake" }` — emitted **only** for agent-initiated turns
  (§7); prompt turns are unchanged.
- **Streaming.** The same event family as a prompt turn follows: `chat:stream:delta` +
  throttled `agent:stream:activity` / `agent:tool:call` under that `messageId`, with the
  live-turn slot open so a mid-turn `chat.subscribe` (§7.1) synthesizes structured blocks
  normally.
- **Finalization (quiescence).** A wake turn has no `session/prompt` future to resolve, so it
  finalizes on quiescence — a fixed settle window (~2 s) with no further notifications — or
  immediately when a prompt turn needs the receiver (finalize-then-handoff, never interleave).
  Finalization persists the assistant transcript row (skipped when the burst produced no
  transcript blocks — status-only updates), emits exactly one terminal `agent:stream:end`
  (carrying `messageId` **iff** the row was persisted; a no-content wake turn's `stream:end` is
  `{ agentId }` only, and the `messageId` announced by `agent:stream:start` then never appears
  in `agent.getConversation` — clients discard the empty in-flight turn on such a
  `stream:end`), then `agent:idle` with the existing
  suppression rules.
- **Racing user sends.** A user send arriving while a wake turn is active takes the existing
  busy-agent queue path (`agent.sendMessage` → `queued: true`, §5.5) and streams only after the
  wake turn's `agent:stream:end` — never interleaved. `priority: "interrupt"` / `agent.stop`
  tears the implicit turn down like any in-flight turn, flushing the partial row per §7.2.

**Batching window.** `events.subscribe` accepts a `batchWindow` hint on the deprecated `agent.*`/`event.*` aliases; the canonical bridge delivers each accepted event **individually** as it is accepted (no server-side coalescing on the WS bridge). Clients that need coalescing should debounce on their side, keyed by `event.type` + the relevant id in `data`.

### 6.7 Event-design rule: self-sufficient payloads *(new in intentd)*

New event types SHOULD carry a **self-sufficient payload** — the changed entity or field — so a
thin client can update its local state **directly from the event, with no follow-up fetch**. The
intentd status events follow this rule:

- `workspace:activity-changed` → `{ workspaceId, activity }` (derived green-dot state)
- `workspace:attention-changed` → `{ workspaceId, attention }` (dismissible blue-dot state)
- `workspace:waiting-changed` → `{ workspaceId, waiting }` (orthogonal wait flag, v6.17 — §5.1)

Each is emitted **only on change** and carries the new value, so the FE re-renders the
green/blue dot immediately without a `workspace.get` round-trip. The existing WS event stream
(`agent:*`, `task:*`, `pr:*`, `note:*`, …) is **unchanged** and remains the UI's primary feed;
this rule is guidance for new event types, not a change to existing ones. (Incremental token
streams like `chat:stream:delta` stay UI sugar — §10.1 — the rule applies to state-change
events, not partial deltas.)

### 6.8 Cross-cutting principle: autonomous backend work surfaces via events, not RPC *(new in intentd)*

Work the backend performs **on its own** — as agents and pipelines run — is **not** exposed as a
client RPC. It runs internally and reaches the thin client through **events** (and as fields on
read responses), following the self-sufficient-payload rule (§6.7). Concretely, these have **no
wire method**:

- **Agent-attribution tracking** (`file-tracking.trackChange`) — recorded as agents edit files;
  surfaced via `changes:tracked` and the `file-tracking.*` reads (§5.19).
- **Diff computation/versioning** (`diffs.*`) — computed/stored internally; diff bodies reach the
  client only through `file-tracking.*` reads and change events (§5.18 schemas note).
- **Metrics aggregation** (`metrics.calculate`, the `update*` writers, agent-active tracking) —
  computed as work happens; surfaced via `changes:metrics-changed` and the metrics **reads**
  (§5.20).
- **Secondary git root registration** (v6.15) — agent-registered working state, authored via the
  MCP-only `ws.git.registerRoot` / `ws.git.unregisterRoot` bindings (with `ws.git.listRoots` as
  the agent-side read; §5.6) plus the daemon's own submodule auto-detect/auto-prune sweep;
  surfaced to clients via `gitRoot:*` events (§6.5) and the `gitRoot.list` read.

Clients **read** current state and **subscribe** to changes; they never invoke the internal
writers. This keeps the FE thin: it reflects backend-owned state rather than driving it.

### 6.9 Snapshot+delta subscription channels *(new in intentd)*

The `events.subscribe` firehose (§6.1) carries every bus event; a thin client that needs **structured live state for a specific entity family** subscribes to a typed channel instead. Each channel is intercepted on the transport fast-path **before** the JSON-RPC dispatcher (alongside `events.subscribe` and `system.*`), returns a `{ subscriptionId }` ack, then pushes a seq-0 **snapshot** followed by ordered **deltas** as `subscription.push` notifications (§3.3). The firehose stays unchanged and **coexists** with these channels.

| Method | Channel | Scope | Snapshot shape (seq 0) | Notes |
| --- | --- | --- | --- | --- |
| `note.subscribe` / `note.unsubscribe` | note | per-workspace (`workspaceId` req — `-32602` if missing/empty) | array of `Note` entities (newest-first) | `note:created`/`updated`/`deleted` → `added`/`updated`/`removedIds` via a re-read of the entity. |
| `task.subscribe` / `task.unsubscribe` | task | per-workspace (`workspaceId` req) | array of task-note entities — wire `Note` shape stamped with the additive `specLinked` flag, NOT the §5.4 `WorkspaceTask` projection | tails `task:status-changed`/`task:ready-tasks-changed`. Snapshot rows and delta `added`/`updated` rows carry the additive `specLinked` flag with the same semantics as `task.list` (§5.4) — `true` iff the task id appears in the spec note body's `intent://local/task/{id}` links — so a live task update no longer drops the flag until the next `task.list` refetch; degrades to `false` when the spec note is unreadable (matching `task.list`; a transient spec-read failure on the per-task stamping path likewise degrades rather than dropping the delta, while a read failure on the spec-event path below drops that delta and keeps the tracked set, reconverging on the next spec read). Spec-body edits refresh flipped flags *(within 6.17; [intent-hq/intentd#1224](https://github.com/intent-hq/intentd/pull/1224), fixes [monorepo#2407](https://github.com/intent-hq/monorepo/issues/2407))*: the forwarder tracks the spec's `intent://local/task/{id}` link set for the life of the subscription, and a spec `note:updated` / `note:deleted` diffs the current link set against the tracked one and emits `updated` rows (fresh row + current `specLinked`) for exactly the tasks whose linkage flipped — the spec's own `note:updated` no longer maps to the junk `removedIds: ["spec"]`, a spec edit that leaves the link set unchanged emits no delta (unrelated tasks are never re-emitted on spec keystrokes), a flipped link to a nonexistent task note flips silently (no row to refresh, but the tracked set still advances), and spec **deletion** re-emits every previously linked task with `specLinked: false`. Per-task events stamp only their own note id into the tracked set, so a task event whose fresh spec read races ahead of the spec's own `note:updated` cannot swallow another task's flip. Cost contract: the flag is derived from ONE spec-note read per snapshot / per delta batch (O(rows) overall), and a spec event costs one `list_notes` read that yields both the new link set and the rows to re-emit (O(rows), same as the snapshot — no per-task scans). |
| `workspace.subscribe` / `workspace.unsubscribe` | workspace | global (no `workspaceId`) — the only global channel | array of **lite** `Workspace` projections visible to the connection (see notes), **including archived workspaces** (clients filter by `status` if needed; archived workspaces remain listed) | tails `workspace:created`/`updated`/`deleted`/`activity-changed`/`attention-changed`/`displayStatus-changed`/`waiting-changed` *(v6.17)*. Snapshot and deltas are consistent on archived inclusion: deltas upsert archived workspaces as `updated`, and the seq-0 snapshot carries them too (matching the legacy `workspace.list { includeArchived: true }` fetch). **Lite seq-0 snapshot (intentd#743):** snapshot rows are store rows + live `activity` + the cheap status aggregates — each row carries `taskStats` (store-level counting query, no note-body hydration), `displayStatus` (same derivation as the enriched path; authoritative when present — clients must not re-derive, §5.1), `waiting` when `true` (v6.17; same presence-detected derivation as the enriched path, §5.1), and `cowSupported` (lifetime-cached probe), while the heavy `agentSummary` and `diffSummary` are **always omitted** (a stats-read failure degrades that row to absent `taskStats` + `displayStatus`, same as the enriched path). The omitted aggregates arrive via the enriched follow-ups: each delta upserts the full `workspace.get` projection (`agentSummary` present; `diffSummary` stays omitted everywhere, §5.1), and clients can call `workspace.get` directly. This keeps seq-0 at tens of KB instead of multi-MB (an enriched ~80-workspace snapshot was ~4.5 MiB and HOL'd the connection writer). |
| `comment.subscribe` / `comment.unsubscribe` | comment | per-workspace (`workspaceId` req); `noteId` optional narrowing | array of `Comment` entities | tails `comment:added`/`resolved`. |
| `agent.subscribe` / `agent.unsubscribe` (no `eventTypes`) | agent | per-workspace (`workspaceId` req) | array of `AgentLite` entities | **Disambiguated by params** from the deprecated service-alias `agent.subscribe` of §5.5: an `eventTypes`-bearing frame falls through to the router (alias); a bare `{ workspaceId }` frame routes to this collection channel. Likewise `agent.unsubscribe` without `workspaceId` is the channel form. |
| `chat.subscribe` / `chat.unsubscribe` | chat | per-agent (`agentId` req — `-32602` if missing/empty); `sinceMessageId` optional (resume, §7.1) | newest `agent.getConversation` page — or, on a successful resume, only the messages after `sinceMessageId` (`resumed: true`) — plus a synthetic in-flight assistant message when one is streaming | The structured alternative to the `agent:stream:*` firehose (§7.1). |

**Frame shapes.** Every push is a JSON-RPC notification with method `subscription.push`:

```json
// seq-0 snapshot
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-1","kind":"snapshot","seq":0,
  "snapshot":[ /* entities */ ] } }

// delta (seq 1, 2, …)
{ "jsonrpc":"2.0","method":"subscription.push","params":{
  "subscriptionId":"sub-1","kind":"delta","seq":1,
  "delta":{ "added":[…], "updated":[…], "removedIds":[…] } } }
```

`added`/`updated`/`removedIds` are each present only when non-empty; the **invariant** is that the seq-0 snapshot reduced with every delta (honoring `removedIds`) equals a fresh full read of the channel. `*.unsubscribe` takes `{ subscriptionId }` and returns `{ success }` (`false` if the id is unknown for this connection). Subscriptions are **per-connection** and are dropped on disconnect.

`note` and `task` entities carry an explicit `rev` (the optimistic-concurrency version, §4); `workspace`, `comment`, `agent`, and `chat` entities deliberately do **not** carry `rev`.

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
event — the pre-first-token `agent:stream:status` startup hint (§6.5) — also matches the
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
| complete or error | agent:stream:end | { agentId, stopReason?, finishReason?, interruptReason?, interruptedBy?, messageId?, trailingBlocks?, turnId?, lastAgentResponse?, digest? } — the turn-worker terminal emit (`agent_session.rs` `run_prompt_turn`) covers **both** normal completion **and** error-terminated turns and additively carries ([monorepo#732](https://github.com/intent-hq/monorepo/issues/732), [intent-hq/intentd#575](https://github.com/intent-hq/intentd/pull/575)): `messageId` — the turn's assistant message id, present whenever the turn persisted an assistant message (set only **after** the successful store append, so the event can never advertise a row that was never written); and `trailingBlocks` — the drained §7.1 `AtTurnEnd` resource blocks (e.g. `ws.app.question.ask` question blocks) in registration order, **byte-identical** to the trailing blocks of the persisted message, **omitted** when none were drained. `finishReason` — the **abnormal finish reason**: present only when the turn completed with a non-`end_turn` ACP stop reason (`refusal` \| `max_tokens` \| `max_turn_requests`), carrying that stop reason verbatim; omitted on normal (`end_turn`) completions, error-terminated turns, and every non-turn-worker emit site — never `null`. When the turn persisted an assistant row, the same value is durably tagged on that row as `metadata.finishReason` (§7 transcript metadata), so a reloading client can render the ending without having seen this event. An abnormal finish reason is still a **completion** (`agent:idle` follows with its existing lifecycle `finishReason` field; no `agent:failed`); distinct from the interrupt path's `stopReason: "interrupted"` below. The two fields are not independently optional in one direction: `trailingBlocks` is a trailing slice of the persisted message's blocks, so its presence **implies** `messageId` is present (a client always has the id to associate the blocks with); the converse does not hold — `messageId` routinely appears without `trailingBlocks`. `turnId` ([monorepo#1022](https://github.com/intent-hq/monorepo/issues/1022)) — the turn correlation id naming the logical turn this event closes (the same id the send/enqueue RPC returned, §5.5/§6.6), stamped on both the complete and error arms; omitted when the turn carries none, never `null`. **Final live-preview values ([intent-hq/intentd#792](https://github.com/intent-hq/intentd/pull/792)):** every transcript-bearing terminal emit — the turn-worker emit, the interrupt flush, and the harness-wake finalize — also stamps `lastAgentResponse?` / `digest?` re-derived from the turn's full streamed text (same fields, same ≤500-char cap, and same omit-until-derivable rule as the throttled `agent:stream:activity` frames above — but with **no newline clipping**: [intent-hq/intentd#795](https://github.com/intent-hq/intentd/pull/795) clips only mid-turn frames, so the terminal emit carries the turn's true final text including any unterminated last line), so a client tracking the preview push-style lands on the turn's true final state without an `agent.get` refetch. The not-surfaced-by-streaming failure path (`publish_terminal_failure_events`, e.g. spawn-retry exhaustion) emits `{ agentId, turnId? }` — the same `turnId` as its paired `agent:failed`, and no preview fields (nothing streamed); the daemon never emits `content` or `streamId` on this event. The **user-interrupt path** (§7.2) additionally carries `stopReason: "interrupted"` and `interruptReason` (within v4.5, [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919): on the wire only ever `"user_stop"` \| `"preempted_by_message"` — the interrupt emit comes solely from the live-session interrupt path; the `"daemon_shutdown"` / `"agent_stopped"` teardowns flush the interrupted row without emitting this event, so those reasons appear only in row metadata (§7.2). Always present on the interrupt emit: it matches the persisted row's `metadata.interruptReason` when a row exists (`messageId` present) and is still stamped from the interruption cause when no row was persisted (`messageId` absent)), plus `interruptedBy` (only on `"preempted_by_message"` with an attributable sender: `{ kind: "user" }` or `{ kind: "agent", agentId, name? }` — §7.2), plus `messageId` when an interrupted assistant row was persisted (the id of that row — with the v4.5 always-persist marker-row semantics that is every emitting-path interrupt that found a registered live-turn slot, zero-output turns included; §7.2) and the preview fields derived from the flushed partial turn — but deliberately **no** `trailingBlocks` (the `AtTurnEnd` registry is not drained on the interrupt path; pending entries wait for the next turn's drain / the registry TTL) and no `turnId` (the interrupt emit is a manager-side flush, not the turn worker's terminal). Normal-completion, error, and harness-wake emits never carry `interruptReason` / `interruptedBy` (absent, never `null`). The **harness-wake turn finalize** (`agent_session.rs` `run_harness_wake_turn`, §6.6) is a fourth emit site: its payload is `{ agentId, messageId?, lastAgentResponse?, digest? }` — `messageId` present iff the wake turn persisted an assistant row, and **never** `trailingBlocks` (the wake path performs no `AtTurnEnd` drain; only `run_prompt_turn` does) or `turnId` (agent-initiated turns have no user retry record). A **prompt idle-timeout** turn ([intentd#741](https://github.com/intent-hq/intentd/pull/741), §6.6 warn-and-continue) closes through the ordinary turn-worker emit with a payload indistinguishable from a normal completion — `messageId` iff a partial assistant row was flushed (a fully silent turn carries none), `turnId` of the timed-out turn, no `stopReason` — and is followed by the persisted `[SYSTEM WARNING]` user row + redriven warning turn instead of `agent:failed` / `agent:idle`, until the consecutive-timeout cap is spent (§6.6) |

Structured consumers should prefer the §7.1 `chat.subscribe` channel (the canonical structured
transcript) over reconstructing turn state from the firehose.

Notes for client implementers:

- **Ordering.** Events for one agent arrive in emission order over a single connection. Correlate a stream with `data.agentId` (and `data.streamId` when present). Tool-call activity arrives as the single `agent:tool:call` event interleaved with the `agent:stream:activity` liveness ticks (and, on the internal chat channel, `chat:stream:delta` text); the §7.1 `chat.subscribe` channel synthesizes ordered structured blocks from these signals.
- **Agent-initiated turns.** A stream may begin with **no user send**: `agent:stream:start { agentId, messageId, reason: "harness-wake" }` announces an implicit agent-initiated turn (§6.6). Clients should open the same streaming UI as a user-initiated turn — spinner/busy state, active Stop/interrupt, autoscroll, live transcript — just with no user message row above it. A send racing an active wake turn auto-queues via the normal busy path and streams after the wake turn's `agent:stream:end`.
- **Terminal event.** `complete` and `error` are mutually exclusive and **both** map to `agent:stream:end` — there is exactly one terminal event per stream. The complete/error payloads are identical by design — both carry the additive `messageId` / `trailingBlocks` fields under the same conditions (the §7.1 `AtTurnEnd` drain deliberately runs on the error path too); the **user-interrupt** terminal emit alone adds `stopReason: "interrupted"` + `interruptReason` (and `interruptedBy` on message preemption; + `messageId` when an interrupted row was persisted — §7.2, never `trailingBlocks`), letting clients render a live, reason-specific "Stopped" indicator without a transcript re-fetch. A **harness-wake** turn's terminal emit carries `messageId` when the wake turn persisted a row and never `trailingBlocks` (§6.6; see the `agent:stream:end` row above). A client treats `stream:end` as "this turn is done" and then re-fetches the authoritative transcript via `agent.getConversation` if it needs the final, persisted message — though `trailingBlocks` lets it append the turn-end attachments to the finalized in-flight message immediately, without waiting on that re-fetch. A client that does both must not double-render: `trailingBlocks` are byte-identical to the persisted message's trailing blocks, so on re-fetch the client **replaces** the finalized in-flight message (keyed by `messageId`) with the persisted one rather than merging block lists.
- **Dedup.** The same agent output is also persisted; the live `chat:stream:delta` text (and its `agent:stream:activity` liveness ticks) is *incremental UI sugar*. Canonical state is the persisted conversation. After `stream:end` (or on reconnect) call `agent.getConversation` rather than reconstructing solely from chunks. User messages echo cross-client as the user-row `agent:message` event (`role: "user"`, carrying a stable `messageId` — §6.5/§6.6; `agent:user-message:sent` is reserved-but-unused) so other clients can de-dupe their own optimistic insert.
- **Sending input.** Use `agent.sendMessage` (auto-queues if the agent is mid-stream; with `priority: "interrupt"` it instead preempts the turn keep-alive and streams immediately — duplicate interrupt delivery with the same `messageId` is absorbed idempotently, and an interrupt landing during turn startup queues keep-alive instead of preempting), `agent.queueMessage` to explicitly enqueue, or `agent.sendQueuedMessageNow` to atomically pull one already-queued entry and deliver it immediately with interrupt priority (the rest of the queue is preserved). `agent.stop` cancels an in-flight stream.

### 7.1 `chat.subscribe` — structured live transcript channel *(new in intentd)*

The `agent:stream:*` firehose (above) stays UI sugar (§10.1): a joiner that misses earlier chunks
cannot reconstruct the turn, and the client must re-fetch `agent.getConversation` after every
`stream:end`. `chat.subscribe` is the **canonical** alternative — an **agent-scoped** channel on the
snapshot+delta subscription engine (§6.9) that delivers a self-healing transcript a thin client
can render directly, with **no follow-up fetch**. It **coexists** additively with the firehose: both
observe the same bus, and `events.subscribe(["agent:stream:*"])` is unchanged.

- **Methods:** `chat.subscribe` / `chat.unsubscribe`, intercepted on the subscription fast-path
  before the JSON-RPC dispatcher (like `events.subscribe`). `params` is
  `{ agentId, sinceMessageId? }` — a missing/empty `agentId` is a `-32602` error.
  `chat.subscribe` returns `{ subscriptionId }`, then
  pushes a seq-0 `subscription.push` **snapshot**, then ordered **deltas** (seq 1, 2, …).
  `replaceGroup` (atomic swap) and per-connection cleanup behave as for the other channels (§6.1).
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
  (`added` on first chunk, `updated` carrying the full reasoning so far), under the same stable
  `{messageId}:{blockIndex}` ids — so snapshot and deltas agree byte-for-byte as for every other
  block. Clients that do not render reasoning should ignore unknown block types as usual.
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
non-assistant row deltas):

- `added` — a block's first appearance this turn (e.g. a text block's first chunk, or a `tool_use`).
- `updated` — an existing block grown/changed, matched by `id` (e.g. each subsequent text chunk
  carries the full accumulated text; full-block replace is idempotent under re-delivery).
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

*Daemon-side question hold (v2.8).* While the questions are pending — the persisted
`pendingQuestionsMessageId` marker, minus the `agent.dismissQuestions` dismissal marker —
**automatic** deliveries to the asking
agent (A2A sends, parent wakes, event batches, `agent.sendToTask`) are parked in its pending queue
instead of starting a turn, so an internal message cannot bury the Q&A and silently dismiss
the wizard. User-origin sends bypass the hold but do not release it (only the answer tag does), and
`agent.dismissQuestions` releases it — since intentd#892 (within v4.3) the dismissal also
delivers a system-origin notice to the model ("User dismissed your N questions without
answering...", `questions_dismissed` `messageMetadata`) so the agent learns the questions were
dismissed and does not re-ask. Full contract in §5.5 ("Question hold").

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

A block's first appearance arrives as `added` with the same `block.id`; each growth is an `updated`
carrying the **full** block. A tool call arrives as an `added` `tool_use` block, then a `tool_result`
block once output lands. The terminal frame (after `agent:stream:end`) carries the persisted blocks
with `streamingComplete:true` and any orphan ids in `removedIds`. A persisted non-assistant row
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

**Pre-first-token stop (always-persist marker row).** *(Changed within v4.5 by [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919) — supersedes the STAB-114 zero-output no-op flush.)* When nothing has streamed yet (no content blocks), **every** interruption that found a registered live-turn slot persists the interrupted assistant marker row anyway — `contentBlocks: []` plus the full metadata tag set above — so the transcript durably records the stop. This **row-persistence** guarantee holds on all four reasons: the plain `agent.stop` keep-alive path, interrupt-priority preemption (the empty marker row is persisted BEFORE the interrupting message's user row, so transcript order reads correctly), the graceful-shutdown capture, and the detach/kill teardown. The **event** guarantee is narrower: only the two emitting paths (`"user_stop"` / `"preempted_by_message"`, previous paragraph) carry the marker row's `messageId` on their terminal `agent:stream:end`. On those paths, `messageId` is absent only when no live-turn slot existed to flush — the interrupt landed during turn startup (spawn / `initialize` / `session/new` / `session/load`), before the worker registered the turn — in which case the emit still carries `stopReason: "interrupted"` + `interruptReason`, just no `messageId`. An `agent.stop` that takes the hard-kill fallback (no live connection or no `acpSessionId`) produces **no** interrupt `agent:stream:end` at all — it routes through the kill teardown, whose row flush (reason `"agent_stopped"`) is metadata-only.

**Zero-output combined delivery is preserved.** The always-persist marker row does NOT break the [monorepo#1014](https://github.com/intent-hq/monorepo/issues/1014) combined delivery on interrupt-priority sends: the preemption's "has the turn progressed" check excludes the just-persisted marker row **by id, and only while it is actually empty** — so the preempted zero-output user message still rides the interrupt turn's prompt ahead of the interrupting message (see `agent.sendMessage`, §5.5), while a marker row that caught a first block streaming in the cancel window counts as progress and blocks the re-delivery as before.

**Consequence for **`chat.subscribe`** (the terminal reconcile of §7.1):** because the partial assistant row is persisted before `agent:stream:end`, the channel's terminal reconcile re-reads a transcript that **contains** the streamed message — the streamed blocks are re-emitted as authoritative `updated` entries and are **not** wiped via `removedIds`. Clients keep the partial output visible and may render an interrupted/"Stopped" indicator from `metadata.interrupted` / `metadata.stopReason` on the persisted row (also visible via `agent.getConversation`) — reason-specific via `metadata.interruptReason` / `metadata.interruptedBy` when present. On an interrupt-priority send, the interrupted partial (or empty marker) row precedes the new user message in the transcript.

Added in [intent-hq/intentd#336](https://github.com/intent-hq/intentd/pull/336); terminal-payload `stopReason`/`messageId` and the pre-first-token empty-row persist added in [intent-hq/intentd#492](https://github.com/intent-hq/intentd/pull/492); `interruptReason`/`interruptedBy` and the always-persist marker-row semantics added in [intent-hq/intentd#919](https://github.com/intent-hq/intentd/pull/919); no method-surface change (additive semantics, within protocol v4.5).

### 7.3 Abnormal finish-reason persistence

A prompt turn that **completes** with a non-`end_turn` ACP stop reason — `refusal`, `max_tokens`, or `max_turn_requests` — is an *abnormal ending*: the turn succeeded at the transport level (no error, no interrupt), but the agent stopped for a reason the user should see. The daemon makes that reason durable so clients can render it after a reload, not just live:

- **Row metadata.** The turn's assistant row is tagged with `metadata.finishReason` carrying the ACP stop reason verbatim (e.g. `{ "finishReason": "refusal" }`), visible on `agent.getConversation` / `agent.getSession` transcript reads and the §7.1 `chat.subscribe` frames that carry row `metadata`. Normal (`end_turn`) completions persist **no** metadata for this — the common path stays noise-free. A **zero-output** abnormal turn (the prompt resolved abnormally before emitting any `session/update`) still persists an empty marker row — `contentBlocks: []` plus the `metadata.finishReason` tag — mirroring the §7.2 pre-first-token interrupt marker: the lifecycle events below are ephemeral, so the row is the only durable record of the ending.
- **Terminal event.** The turn-worker terminal `agent:stream:end` carries the same value as the additive `finishReason?` field (§7 emitted-events table) — present only on abnormal completions, omitted otherwise, never `null`.
- **Still a completion.** An abnormal ending follows the normal completion lifecycle: `agent:idle` fires (its existing lifecycle `finishReason` field carries the same stop reason, as it always has) and `agent:failed` does not. Distinct from §7.2's interrupt contract (`metadata.stopReason: "interrupted"` / event `stopReason: "interrupted"`): an interrupt is externally imposed mid-turn, an abnormal finish is the agent's own resolved stop reason. The ACP `cancelled` stop reason never reaches this path — cancellation routes through the §7.2 interrupt flush.

Presence-detected additive fields (row `metadata.finishReason`, event `finishReason?`) within the current protocol version; no method-catalog or wire-shape change, so no version bump.

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

## 9. Error Codes

Errors use the standard JSON-RPC 2.0 `error` object `{ code, message, data? }`.

| Code | Name | When |
| --- | --- | --- |
| -32700 | Parse error | Body is not valid JSON. Always answered (id null), even for would-be notifications. |
| -32600 | Invalid Request | Not an object, jsonrpc !== "2.0", missing/empty method, or bad id type. |
| -32601 | Method not found | Unknown method (only for requests; unknown notifications are dropped). |
| -32602 | Invalid params | Missing required param ("Missing required parameter: <name>"), bad workspaceId ("workspaceId is required"), non-array where an array is required, "not found" lookups, unauthorized repoPath, etc. **All** `-32602` errors carry an `error.data.code` discriminator: `"not-found"` when the addressed entity does not exist, or `"invalid-params"` for bad/missing parameters; fast-path connection-scope methods handled before the dispatcher (subscriptions, `drafts.*`, `forward.*`, `host.*`, `browser.exec`, `client.hello`) always emit `"invalid-params"`. **Client rule:** the deleted-entity flow requires `error.data.code === "not-found"`; only that code means the entity is absent (deleted); any other code must not be treated as deletion. Errors that already attach a more specific `error.data.code` keep theirs: a `workspace.create` failure from an unresolvable base ref keeps this numeric code and its human message but adds `error.data = { code: "base-ref-unresolvable", baseRef }` so clients detect the condition from `error.data.code` instead of parsing the message; `baseRef` is the canonical (remote-prefix-stripped) ref — the same value interpolated into the human message (§5.1 worktree provisioning + `baseRef` canonicalisation). User-fixable clone failures (`path-invalid`, `destination-exists-non-empty`) also use this numeric code — see the clone failure taxonomy below. A `git.showFile` path resolving to a non-blob tree entry (a `160000` gitlink / submodule pin, or a `040000` tree) also uses this numeric code with `error.data = { code: "not-a-file", path, mode }` — `mode` is the octal tree-entry mode string (monorepo#1739; §5.6). |
| -32603 | Internal error | Underlying service threw. message is "Internal error" with the original message in data for unexpected throws; many shims pass the underlying message through as message directly. Classified clone failures never surface as a bare "Internal error" — see the clone failure taxonomy below. An `isNewRepo` repository-initialization failure in `workspace.create` (§5.1 new-repository initialization) keeps the bare "Internal error" message but carries the cause in `error.data` (`workspace.create: repository initialization failed: <detail>`). The `voice.transcribe` no-API-key failure (§5.41; v4.4) keeps the bare "Internal error" message but attaches structured `error.data = { code: "voice-no-api-key", detail }` with the descriptive cause in `detail`. The `pairing.getInfo` listener-down failure (§5 fast-path catalog; intentd#1065, monorepo#1822) keeps its human message but attaches `error.data = { code: "listener-down" }` so `intentd pair` detects the condition without prose-matching. The `repo.warmCache` busy rejection (§5.11; v6.10, intentd#1105) keeps its human message (`"repo cache warm already in flight for <owner>/<repo>"`) and attaches `error.data = { code: "warm-in-flight", owner, repo }` naming the repo currently being warmed, so clients stay silent without matching on prose. The `agent.completeOnce` adapter-busy rejection (§5.32; v6.14, intentd#1146) keeps its human message (`"no free adapter slot for <providerId> after <n>ms (agents.maxConcurrentAdapters = <limit>)"`) and attaches `error.data = { code: "adapter-busy", provider, waitedMs, limit }` — `provider` is the effective provider id, `waitedMs` the **measured** time spent queued before giving up (the caller's own `timeoutMs` bounds it, so it lands at ~that value) and `limit` the effective `agents.maxConcurrentAdapters`. Note the shape: this `data` is an **object** while every other `-32603` from `agent.completeOnce` carries a bare string, so a client reading `data` as a string must presence-check `data.code` first. Nothing was spawned when it is returned, so the call is always safe to retry. |
| -32005 | Conflict | Optimistic-concurrency failure: a conditional write's `expectedVersion` did not match the entity's current `rev`. `error.data = { code: "conflict", current }` carries the current entity so the client can reconcile (note conditional writes; §4, §5.6). |
| -32001 | Unauthorized | Local-only guard: a remote (TCP/WSS) caller invoked a local-only fast-path method (e.g. `pairing.getInfo`, `server.pairingInfo`, `server.rotateToken`, `system.shutdown`, `system.importLegacy`, or `system.gitCredential`, §5). |
| -32010 | Oversized response | The serialized response to a successful request exceeded the outbound message cap (`MAX_OUTBOUND_MESSAGE_BYTES`, 40 MiB on the serialized JSON-RPC message — §1.3; intentd#743). The response is replaced at router serialization — where the request id is known — with this error echoing the id, so the client fails fast instead of hitting its RPC timeout on a silently dropped message. `message` names the method and serialized size (verbatim daemon string: `"response for <method> exceeds maximum outbound frame size: <n> bytes > <limit> bytes"`); `error.data = { code: "oversized-response", method, responseBytes, limit }`. Clients should re-request with narrower scope (e.g. path-scoped `git.diffs`, §5.6). The connection-writer cap remains a last-resort backstop for non-response messages (subscription pushes/events), which are dropped, never errored (§1.3). |
| -32011 | Server overloaded | The daemon-wide cap on outstanding slow-path RPCs (`server.maxOutstandingRpcs`, §5.12; default 256, `0` = unlimited, range 0..=100000) is reached, so the request is rejected immediately rather than queued. The cap is shared across every connection and both transports, and covers only the detached-spawn slow paths (`host.*`, `browser.*`, and router-dispatched methods); every inline fast-path method (subscriptions, `system.*`, `server.*`, `pairing.getInfo`, `forward.*`, `drafts.*`, `client.hello`, reverse-response routing) is never rejected. `message` is the fixed string `"Server overloaded"` with no `error.data`. Notification-shaped frames (no `id`) are dropped without a response. Parse/envelope validation runs **before** a permit is claimed, so a malformed or invalid frame is still answered inline with `-32700`/`-32600` at the cap — the error matrix does not change under load. Clients should back off and retry. Changing the cap takes effect on daemon restart. |

The only custom numeric codes outside the standard `-327xx` range are `-32005` (Conflict), `-32001` (Unauthorized, local-only guard), `-32010` (Oversized response), and `-32011` (Server overloaded); other server-specific conditions (e.g. "not a delegated agent", "path outside workspace", "staging `.` is blocked") are reported as `-32602`/`-32603` with a descriptive `message`. Notification-shaped requests (no `id`) never receive an error response except for parse/invalid-request failures detected before the notification status is known.

### 9.1 Clone failure taxonomy (`workspace.create`)

A failed clone/provisioning step in `workspace.create` (§5.1 clone orchestration) is classified into a typed error instead of a generic internal error (monorepo#826). The envelope is always:

- `error.message` — `workspace.create clone failed (<category>): <detail>`
- `error.data` — `{ "code": "<category>", "detail": "<detail>" }`

where `detail` is a human-readable cause: the tail of `git clone`'s stderr (bounded, ~4 KiB) with any `user[:pass]@` credential fragments in URL-like substrings redacted to `***@`. Tokens never reach the wire. The categories (`error.data.code`) and their numeric codes:

| data.code | Numeric | When |
| --- | --- | --- |
| path-invalid | -32602 | The clone destination path is missing/malformed (e.g. `clonePath` resolves to no file name) or not creatable (permission denied, read-only filesystem, could-not-create-work-tree). User-fixable: correct the path and retry. |
| destination-exists-non-empty | -32602 | The clone target already exists and is not an empty directory (detected pre-clone or reported by git). User-fixable: choose a different destination. |
| askpass-missing | -32603 | The askpass helper script could not be executed ("ssh-askpass-intent", "cannot exec … askpass", "app.asar … not a directory") — e.g. macOS quarantine relocated the app bundle so the packaged helper path is unreachable. Git's stderr drags the auth prose along with the exec failure, but this classification outranks `auth-required`: the remedy is local (move the app out of quarantine), not credentials (monorepo#837). |
| auth-required | -32603 | The remote rejected the clone for lack of credentials ("Authentication failed", "could not read Username … terminal prompts disabled", "Permission denied (publickey)", "Invalid username or password"). Shared with the credential-injection auth classification (monorepo#825). |
| repo-not-found | -32603 | The remote reports the repository does not exist ("Repository not found", HTTP 404). With credential injection in play (monorepo#825), GitHub also answers 404/not-found for private repos the presented token cannot see. |
| access-denied | -32603 | The remote refused access to an existing repository (HTTP 403, "access denied"). |
| network | -32603 | The remote could not be reached: DNS ("Could not resolve host"), connect ("Connection refused", "Network is unreachable"), timeout (including the daemon's own clone timeout), or truncated transfer ("early EOF", "remote end hung up unexpectedly"). |
| clone-failed | -32603 | Any other clone failure; `detail` still carries the sanitized stderr tail. |

Only these `data.code` values are a stable contract; clients must exact-match them and treat unknown codes as `clone-failed`. Classification is best-effort prose matching over git's stderr — the `detail` is authoritative for display, the `code` for behavior. The classified categories are shared with the streaming `git.clone` surface: a failed `git:clone:done` frame carries the same category string as `data.errorCode` when classification succeeded (§5.6, §6.5).

## 10. Thin-Client Guidance

The backend is the **single source of truth**; clients should hold only ephemeral UI state.

### 10.1 Canonical state lives in the backend

Never treat streamed deltas as authoritative. `chat:stream:delta` text, `agent:stream:activity` ticks, optimistic note edits, and local task toggles are **UI sugar** — the persisted entity (fetched via `note.get`,`agent.getConversation`, `note.listTasks`, …) is canonical. Reconcile to it after each mutation/turn.

### 10.2 Subscribe-then-fetch

1. Connect + authenticate (§2), pin the cert (§1.2).
2. `events.subscribe` for the slices you render (e.g. `["note:*","task:*","agent:*"]`) **before**fetching, so no change is missed in the gap.
3. Fetch the current state (`workspace.get`, `note.list`, `agent.list`, …).
4. Apply incoming `events.event` notifications to your local cache; de-dupe on `event.id`.
5. On reconnect, **re-subscribe and re-fetch** — subscriptions do not survive disconnects.

### 10.3 Optimistic UI

For mutations, optimistically apply locally, send the request, and reconcile when (a) the methodresult returns and (b) the corresponding `events.event` arrives. Roll back on error. Use the stable`messageId` you pass to `agent.sendMessage` (and the echoed `agent:user-message:sent` event) tomatch your optimistic message against the canonical one and avoid duplicates across clients.

### 10.4 Minimal client session walkthrough

```text
1.  pair via QR / manual entry → host:port, fp=AB:CD:..., token   (pairing payload, §2.3)
2.  WSS connect wss://host:port/ws  (pin fp)                  (§1.2)
        Authorization: Bearer <token>                        (§2.1)
3.  → events.subscribe { eventTypes:["agent:*","note:*","task:*"], workspaceId:"ws-abc" }
    ← { subscriptionId:"ws-sub-1" }                          (§6.1)
4.  → workspace.get { workspaceId:"ws-abc" }   ← { workspace }
    → note.list      { workspaceId:"ws-abc" }   ← { notes }
    → agent.list     { workspaceId:"ws-abc" }   ← { agents }
5.  → agent.sendMessage { workspaceId, agentId:"agent-123", content:"Fix the build", messageId:"m1" }
    ← { success:true, queued:false, messageId:"m1" }         (§5.5)
6.  ← events.event agent:stream:activity* / agent:tool:call / agent:stream:end   (§7; agent:stream:start only on agent-initiated turns, §6.6)
7.  → agent.getConversation { agentId:"agent-123" }  ← { messages, ... }   (reconcile, §10.1)
8.  (permission prompt, if any) ← request_permission → respond selected/allow_once  (§8)
9.  on disconnect: reconnect, re-auth, repeat from step 3.   (§4)
```

*The canonical wire-protocol specification for the Intent backend daemon (`intentd`). The method surface is enforced by golden tests in `crates/intent-transport/src/catalog.rs`; changes follow the compatibility policy at the top of this document.*