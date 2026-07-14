# Known Issues

Live issue tracker for the **01_stabilizing** self-hosting phase.

## Intake Convention

Each issue entry includes:

- **ID** — `STAB-N` sequential numbering
- **Date** — when discovered (YYYY-MM-DD)
- **Area** — component/subsystem (e.g., `intentd note persistence`, `cloudlands-fe chat UI`, `ios sync`)
- **Severity** — P0 (crash/data-loss), P1 (broken feature), P2 (papercut)
- **Repro** — minimal steps to reproduce
- **Status** — `open` or `open (optional note)` | `fixed (PR link, date)`

---

## Open Issues

### STAB-1 (2026-07-13, area: intentd note persistence, severity: P1)

Concurrent note writes fail with JSON-RPC `-32603` `internal error: insert note_version failed: error returned from database: (code: 5) database is locked`.

**Repro:** Issue ~5 parallel `note.edit` or `note.update` calls against different notes in one workspace (e.g., via `Promise.all` in the workspace_api MCP tool). Some writes fail with SQLITE_BUSY surfaced as `-32603`.

**Expected:** Writes are serialized or retried daemon-side (busy_timeout / retry-on-busy), never surfacing SQLITE_BUSY to the client. Sequential retry succeeds.

**Status:** open

### STAB-2 (2026-07-13, area: cloudlands-fe UI — workspace timeline/feed, severity: P2)

The "workspace start" indicator renders at the bottom of the workspace view instead of marking the chronological beginning of the workspace.

**Repro:** Open a workspace with multiple activity items and locate the workspace start indicator. Observed while self-hosting: in a workspace whose first activity was the "Scaffold docs/01_stabilizing" work, the start indicator appeared way down at the bottom of the feed rather than at the top where the workspace began.

**Expected:** The indicator anchors the beginning of the workspace (before/at the first item), regardless of feed ordering.

**Status:** open

### STAB-3 (2026-07-13, area: intentd PR↔workspace linking, severity: P1)

An open PR whose head branch exactly matches the workspace branch is never linked to the workspace.

**Repro:** In a workspace on branch X, file a PR with head X via `gh`, wait >2 minutes, call `pr.status`. Observed while self-hosting: monorepo PR #98 was filed with head branch `any-fix` for the workspace on branch `any-fix`; well beyond several 60s background-refresh cycles, `pr.status` still returns `-32603` "No active PR", no `pr:linked` event is emitted, and the FE PR panel keeps showing "Create PR" instead of the open PR.

**Expected:** The 60s background + on-demand PR refresh matches the PR by `head.ref` (branch-only matching per BREADCRUMBS Milestone 4 Cycle B), persists `activePullRequest`/`prStatus`, emits `pr:linked`, and the `pr.*` surface + FE PR panel reflect the open PR.

**Status:** open

### STAB-4 (2026-07-13, area: intentd agent runtime / chat transcript (queue-flip path), severity: P1)

Messages queued while an agent is mid-turn do not appear in the conversation when they are dequeued and delivered.

**Repro:** Send message A to an agent, then send message B while the agent is still streaming A's turn; after A's turn ends, B's turn starts — B's text is absent from the transcript. Observed while self-hosting: sending a message to a busy agent queues it (expected), but when the current turn ends and the queue-flip loop flips the queued message to in-flight, the delivered user message never shows up in the conversation transcript/UI — the agent acts on it, but the transcript is missing the user message that triggered the turn.

**Expected:** On dequeue, the user message is persisted to the conversation (`agent.getConversation`) and pushed to live subscribers (`chat.subscribe` delta / `agent:stream` events) exactly like a directly-delivered message.

**Status:** open

### STAB-5 (2026-07-13, area: intentd agent events / parent notifications, severity: P2)

A child agent's completion report is re-delivered to the parent agent multiple times.

**Repro:** Delegate a task to a child agent, let it complete and deliver its report, then trigger additional parent wakes (e.g. new user messages) and observe the same completion report re-delivered. Observed while self-hosting: after a delegated implementor completed and its report was delivered and acted upon, the identical "[WORKSPACE EVENTS] Child agent ... completed. Report: ..." message was delivered to the coordinator again on two subsequent turns, hours of activity later, as if the completion event was never acknowledged/marked consumed.

**Expected:** A child-completion notification is delivered to the parent exactly once (or is idempotently deduplicated); already-consumed completion events are not replayed on later wakes.

**Status:** open

### STAB-6 (2026-07-14, area: intentd agent runtime / spawn path, severity: P1)

Agent spawn failures (session/new timeouts, handshake failures) leave the chat UI stuck on "Creating session..." with no user-visible error or recovery path.

**Repro:** Trigger a concurrent agent spawn that hits a session/new 60s timeout or an "agent stdout closed" handshake failure. Observed while self-hosting: during high workspace activity, agent spawns occasionally fail with session setup timeouts or stdout closure before the handshake completes. The queued user message is silently dropped, no agent:failed event is emitted, and the UI remains indefinitely in "Creating session..." state with no Retry button or error message.

The root causes included: (1) no retry logic—first spawn attempt was terminal; (2) spawn-retry teardown self-deadlocked on the message_queue mutex held by the caller; (3) no terminal agent:failed event or persisted 'error' status on exhaustion; (4) no user-facing retry surface.

**Expected:** Transient spawn failures (session/load or session/new timeouts, handshake failures, stdout closed) trigger automatic retry with backoff (3 attempts, 2s/5s delays, fresh child per attempt). On exhaustion, emit agent:failed with stderr-enriched error, persist 'error' status, requeue the message, and show a Retry button in the UI. The agent.retry RPC allows manual recovery.

**Status:** fixed (intent-hq/intentd#142, intent-hq/cloudlands-fe#51, 2026-07-14)

### STAB-7 (2026-07-13, area: intentd CI / intent-store SQLite contention, severity: P2)

Flaky CI test failure: `database is locked` in `workspace_duplicate_provisions_worktree_over_wss`.

**Repro:** On intentd PR #137 (https://github.com/intent-hq/intentd/pull/137), the `check` CI job failed once with `insert note_version failed: error returned from database: (code: 5) database is locked` in the `workspace_duplicate_provisions_worktree_over_wss` e2e test; a re-run passed. Intermittent under CI parallelism.

**Expected:** e2e tests ride out SQLite write contention (busy_timeout should absorb it); no intermittent `database is locked` failures.

**Status:** open

### STAB-8 (2026-07-13, area: intentd agent runtime / delegation (self-hosted stack), severity: P1)

Delegated agents stall: initial prompt never runs / agents go idle mid-flow.

**Repro:** In this workspace today, 3 of 4 delegated/created agents never started their initial prompt (agent diagnostics showed 'initial-prompt-not-running'; conversations contained only empty user messages, zero assistant turns) and required a manual wake (wakeOrCreate / send) or full re-delegation. Separately, two agents later went idle mid-task (during PR flows) without completing or reporting, and needed another wake.

**Expected:** A delegated agent starts running its initial prompt immediately after creation, and either completes its task or reports a blocker; no silent stalls.

**Status:** open

---

## Carried Over from 00_initial_porting

These items were genuinely open/deferred in [../00_initial_porting/BREADCRUMBS.md](../00_initial_porting/BREADCRUMBS.md) and remain as stabilization tasks:

### Transport panic-safety

**Area:** intentd transport  
**Severity:** P1  
**Description:** Currently relies on per-connection `tokio::spawn` isolation. Should use `catch_unwind` → `-32603` to guarantee a panicked request handler never brings down the daemon or other connections.  
**Status:** open

### Real auggie e2e in CI

**Area:** intentd CI  
**Severity:** P2  
**Description:** A real auggie turn in CI is best-effort/local only (requires auggie + login). The hermetic mock-agent E2E is the CI gate; the generated `--mcp-config` + bridge are auggie-consumable, but CI has no live auggie coverage.  
**Status:** open (best-effort/local only)

### PR↔workspace matching — branch-only

**Area:** intentd sourcecontrol  
**Severity:** P2  
**Description:** PR↔workspace matching is **branch-only** (`head.ref`) vs the reference TS branch-OR-`baseRef` match. This is an accepted deferral from Milestone 4 — Cycle B, but may surface as a papercut if workspaces don't link when expected.  
**Status:** open (intentional divergence, may revisit)

### `pr.*` single-page reads / capability gating

**Area:** intentd sourcecontrol  
**Severity:** P2  
**Description:** `pr.*` reads stay single-page (the separately-addressed `github.*` list reads gained real pagination in Milestone 11). Capability gating is deferred — no runtime detection of whether the active PR supports certain operations.  
**Status:** open (intentional deferral)

### Agent-Id / Linked-Note-Id commit trailers

**Area:** intentd git  
**Severity:** P2  
**Description:** Git commits lack `Agent-Id` and `Linked-Note-Id` trailers (no agent context at the UDS layer yet). Reference TS backend added these trailers for audit/provenance.  
**Status:** open (intentional deferral from Milestone 4)

### REV-2 — Explicit reverse-dispatch target selection

**Area:** intentd transport  
**Severity:** P2  
**Description:** REV-1 first-client-sticky reverse dispatch is an interim single-client policy while an explicit target-selection surface (REV-2 / PROTOCOL §16 client identity) is designed. Agent-initiated `browser.exec` currently goes to the first-connected client only.  
**Status:** open (design in progress)

---

## Fixed Issues

### STAB-6 (2026-07-13, area: cloudlands-fe sidecar watchdog + intentd store pool, severity: P1)

The cloudlands-fe sidecar watchdog kills the daemon while it is healthy, triggered by intentd store pool exhaustion.

**Repro:** Run under moderate workspace load (multiple agents, concurrent note writes, PR operations). Observed while self-hosting: cloudlands-fe sidecar watchdog detected that intentd stopped responding to health checks and killed the daemon; the daemon was actually alive but all SQLite pool connections were in use, blocking the health-check handler from acquiring a connection to run its trivial `SELECT 1` query, triggering the watchdog timeout.

**Expected:** Health-check requests either bypass the store pool entirely (no DB access required), use a dedicated reserved connection, or have a fast-fail timeout that lets the watchdog distinguish "slow but alive" from "dead". The daemon should never be killed while healthy.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/137, https://github.com/intent-hq/cloudlands-fe/pull/43, 2026-07-14)

### STAB-6 (2026-07-14, area: intentd CI / agent spawn retry e2e test, severity: P1)

Intermittent CI failures in `agent_retry_rpc_recovery_path_over_wss` test on main and all open PRs.

**Repro:** Test expected spawn failure after retry exhaustion, but sometimes succeeded in CI due to race between event delivery and status persistence. Test waited for `agent:stream:end` event (published before status persisted to DB), so `agent.getSession` could read stale status.

**Expected:** Test waits for `agent:status-changed` event (published AFTER `set_agent_session_status` DB write completes at agent_manager.rs:2722), guaranteeing read-after-write consistency.

**Status:** fixed ([intent-hq/intentd#149](https://github.com/intent-hq/intentd/pull/149), 2026-07-14)
