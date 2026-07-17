# Known Issues

Live issue tracker for the **01_stabilizing** self-hosting phase.

**Next available ID:** STAB-62 (as of 2026-07-17)

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

### STAB-60 (2026-07-15, area: prompt assembly / settings, severity: P1)

RTK prompt optimization silently stopped working when prompt assembly moved daemon-side.

**Repro:** The RTK command-output optimization (injecting an instruction to prefix supported commands with `rtk` for compressed, LLM-friendly output) was broken in the intentd stack. Root cause: the porting spec classified `rtk.enabled` as FE-only (PROTOCOL.md §5.12 "Not exposed"), but prompt assembly moved daemon-side (`intent-services/src/rules.rs::assemble_system_prompt`), stranding the feature. The FE injection point (`cloudlands-fe src/features/agent/main/instructions/base-system-prompt.ts` → `getRtkPromptInstruction()`) sat on a dead path — `InstructionService.buildSystemPrompt` was only invoked by the sandbox preview, never for real agents spawned by intentd. Additionally, the FE toggle (`RtkSettings.svelte`) persisted to renderer `localStorage` while the detector (`rtk-detector.ts`) read main-process `local-prefs.json`, so the toggle and injector didn't even share a store.

**Expected:** With `rtk.enabled = true` (daemon setting) and `rtk` on the daemon host's PATH, newly spawned agents' persisted `systemPrompt` contains the RTK instruction line with the filtered subcommand list. With the flag off (default) or rtk missing, prompts are unchanged.

**Status:** fixed ([intent-hq/intentd#190](https://github.com/intent-hq/intentd/pull/190), [intent-hq/cloudlands-fe#89](https://github.com/intent-hq/cloudlands-fe/pull/89), [intent-hq/cloudlands-fe#90](https://github.com/intent-hq/cloudlands-fe/pull/90), 2026-07-16) — intentd now owns rtk.enabled as a daemon settings-catalog key (default false), detects/parses rtk on the daemon host, and injects the RTK prompt layer in assemble_system_prompt; cloudlands-fe toggle rewired to daemon settings.get/update, dead injection path and rtk-detector.ts removed, legacy-bridge mapping added, wire-contract test at transport boundary

### STAB-56 (2026-07-16, area: intentd intent-acp / agent-log file permissions, severity: P2)

Captured child stderr log files (`<data_dir>/agent-logs/<agent-id>/<YYYY-MM-DD>.log`, shipped in STAB-53) are created with default umask permissions. On typical Unix systems this can leave the log files world-readable, exposing potentially sensitive stderr content (auth tokens echoed by a crashing provider, file paths, prompt fragments, etc.) to any local user on shared or multi-user hosts.

**Repro:** On a Unix host, run any agent so that at least one line of stderr is captured, then `ls -l <data_dir>/agent-logs/<agent-id>/`. The directory and daily log file are created with the process umask, which is commonly `022` → files `0644`, directories `0755` (world-readable).

**Expected:** On Unix, the per-agent directory is created with mode `0700` and each daily log file with mode `0600` as a best-effort hardening step (ignore-if-fails on non-Unix or on filesystems that don't honor mode bits). Preserve the "capture never blocks the agent runtime" invariant from STAB-53.

**Reference:** post-merge Copilot comment on [intent-hq/intentd#203](https://github.com/intent-hq/intentd/pull/203) touching `crates/intent-acp/src/transport.rs`.

**Status:** open

### STAB-55 (2026-07-16, area: cloudlands-fe chat send / transcript hydration, severity: P1)

Chat transcript renders empty after sending a message to a non-hydrated agent.

**Repro:** Have an agent in `error` state with existing message history in the DB. With the workspace already selected before a daemon restart (do NOT refresh), type a new message and send. The chat view goes blank — no prior messages, no user echo, no assistant reply — even though the daemon processes normally. Cmd-R refresh rehydrates the transcript correctly. Root cause is twofold: (1) `initializeChatRequested` only fires on ChatPanel mount/rebind, so hydration was never triggered for the pre-selected workspace; (2) the send path's session restore (`agent-mutation-service.handleRestore`) refetched `agent.get` — an AgentLite projection (PROTOCOL §5.5) with `messages` normalized to `[]` — and persisted it as-is, clobbering the transcript and seeding an empty one, while the queue-vs-send decision read stale pre-restart streaming flags.

**Expected:** Sending to an agent whose transcript is not hydrated triggers hydration first (`loadChatTranscript`: session + `chat.subscribe` seq-0 snapshot + BE-owned streaming flags), and the restore/activate refetch paths preserve existing store messages when the fetched AgentLite projection carries none, so a mid-send restore can never clobber a hydrated transcript.

**Status:** fixed ([intent-hq/cloudlands-fe#86](https://github.com/intent-hq/cloudlands-fe/pull/86), 2026-07-16)

### STAB-54 (2026-07-16, area: intentd intent-services + cloudlands-fe / agent.retry RPC contract, severity: P1)

`agent.retry` was a visible no-op when the retry queue was empty: the RPC returned `{ ok: true }` but the agent stayed parked in `status=Error` (STAB-52 gate) and the FE couldn't tell whether a message had actually been redriven, so the retry button appeared to do nothing.

**Repro:** Drive an agent into `Error` with no queued ready-to-send messages (e.g. after a terminal spawn failure whose message the user then discarded). Click Retry. Backend returns `ok` but session stays in Error and no turn runs; FE shows no feedback.

**Expected:** `agent.retry` returns `{ ok: true, redriven: bool }`. When the queue is empty, the backend clears `Error → Idle` and returns `redriven: false`; when a queued message is present, it flips to `Pending` and drains, returning `redriven: true`. FE converges local session status from the ack and shows an info toast when `redriven === false` so the user knows the retry cleared the error but had no queued work.

**Status:** fixed ([intent-hq/intentd#206](https://github.com/intent-hq/intentd/pull/206), 2026-07-16) — FE half in-review at [intent-hq/cloudlands-fe#88](https://github.com/intent-hq/cloudlands-fe/pull/88); race-condition and WSS e2e follow-ups will land in a subsequent intentd PR

### STAB-53 (2026-07-16, area: intentd intent-acp / agent child diagnostics, severity: P2)

ACP child stderr is lost when the child dies: the transport keeps only a 5-entry in-memory ring buffer, so a crashed auggie/claude/gemini/codex child ("agent stdout closed") leaves no diagnosable trace on disk.

**Repro:** Run any agent whose ACP child crashes mid-turn (e.g., the STAB-50 V8 OOM). The daemon WARN says "agent turn failed terminally" but the child's stderr — the only record of why it died — is gone with the process; nothing is persisted.

**Expected:** Every spawned child's stderr is captured to `<data_dir>/agent-logs/<agent-id>/<YYYY-MM-DD>.log` (daily rotation, best-effort, never blocks the agent runtime), files older than 7 days are pruned on the daemon's hourly reaper cadence, and terminal-failure WARN lines point at the capture path when the child died.

**Status:** fixed ([intent-hq/intentd#203](https://github.com/intent-hq/intentd/pull/203), 2026-07-16)

### STAB-52 (2026-07-16, area: intentd intent-services / agent_manager queue drain, severity: P1)

Agent crash-loop after a terminal spawn/turn failure leaks `is_active=1`: the failed message is requeued and the session parked in `status=Error, is_active=0`, but `try_drain_queue` did not consult the persisted status, so any queue kick (`agent.queueMessage`, edit-save, wake delivery) re-claimed the in-flight slot and re-spawned the same failing turn indefinitely.

**Repro:** Send a message to an agent whose spawn or `run_turn` always fails terminally (e.g., provider binary missing). `handle_terminal_spawn_failure` / `handle_terminal_turn_failure` → `persist_error_and_requeue` parks the row in `Error` and requeues the message — then a queue-updated kick reaches `try_drain_queue`, which re-claims the slot and re-spawns the failing turn in a loop, flapping `is_active` and leaking `is_active=1` whenever the cycle is interrupted mid-claim.

**Expected:** A session parked in `Error` is never auto-redriven. `try_drain_queue` bails when the persisted status is `AgentStatus::Error`; redriving is a deliberate act — `agent.retry` (which resets the status to `Pending` before draining) or a fresh `agent.sendMessage`. After a single terminal failure the row lands in exactly `status=Error, is_active=0` with the message requeued once.

**Status:** fixed ([intent-hq/intentd#202](https://github.com/intent-hq/intentd/pull/202), 2026-07-16)

### STAB-51 (2026-07-16, area: intent-services / agent_manager (persistence + retry), severity: P2)

User message can disappear from the transcript on retry after a transient `persist_user` failure.

**Repro:** Force a transient sqlx error on the `persist_user` path, then trigger a mid-turn failure, then retry via `agent.retry`. Observed: the user message is missing from the transcript on final success.

**Root cause:** In the terminal-requeue path (`handle_terminal_spawn_failure` etc. — see [intent-hq/intentd#196](https://github.com/intent-hq/intentd/pull/196)), the requeued message is marked `persisted: true` unconditionally. However, `persist_user` is best-effort and can silently fail (transient SQLite error). When the user then runs `agent.retry`, the drain path skips `persist_user` because `persisted: true`, so the user message never lands in the transcript even though the retry succeeds.

**Fix sketch:** Make `persist_user` return `bool` (or an `Option<MessageId>`) indicating durability. Thread that through the terminal-requeue callers and only set `persisted: true` on confirmed durability.

**Reference:** Copilot review thread on PR #196 (https://github.com/intent-hq/intentd/pull/196#discussion_r3591844297).

**Status:** open

### STAB-45 (2026-07-15, area: intentd auto-commit / commit message generation, severity: P2)

Auto-commit subject was the agent/task title — e.g. commits titled "Coordinator" — ignoring conventional-commit conventions.

**Repro:** Before the LLM auto-commit message generation fix, the daemon's auto-commit path (`intent-services/src/auto_commit.rs`) used a deterministic fallback chain (task title → agent name → "Agent changes") without LLM involvement. This resulted in commits with messages like "Coordinator" or the raw task title, which violate conventional-commit conventions required by the monorepo CI.

**Expected:** Auto-commit messages should be conventional-commit-formatted (e.g., `feat:`, `fix:`, `chore:`) derived from the actual diff.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/186, 2026-07-15)

### STAB-46 (2026-07-16, area: intentd runtime listener control, severity: P1)

Sidecar/dev build (FE spawns `intentd serve --listen uds`) — toggling `server.wsApi.enabled=true` fails with Internal("WSS listener not available...") and reverts.

**Repro:**
1. Start intentd in sidecar mode (FE spawns `intentd serve --listen uds` in dev OR packaged builds)
2. Open Settings UI → WebSocket API
3. Toggle `server.wsApi.enabled` to `true`
4. **Expected:** WSS listener starts, bound port visible in system.status
5. **Actual:** Error: "WSS listener not available (daemon started with --listen uds)", setting reverted

**Root cause:** `main.rs` only constructed `WsRuntimeControl` when `serve_tcp_enabled` (`--listen tcp/both`). Under `--listen uds`, `DaemonControl.ws_runtime` was `None`, so `start_ws_listener` failed with the error above.

**Status:** fixed ([intent-hq/intentd#195](https://github.com/intent-hq/intentd/pull/195), 2026-07-16)



### STAB-1 (2026-07-13, area: intentd note persistence, severity: P1)

Concurrent note writes fail with JSON-RPC `-32603` `internal error: insert note_version failed: error returned from database: (code: 5) database is locked`.

**Repro:** Issue ~5 parallel `note.edit` or `note.update` calls against different notes in one workspace (e.g., via `Promise.all` in the workspace_api MCP tool). Some writes fail with SQLITE_BUSY surfaced as `-32603`.

**Expected:** Writes are serialized or retried daemon-side (busy_timeout / retry-on-busy), never surfacing SQLITE_BUSY to the client. Sequential retry succeeds.

**Status:** fixed ([intent-hq/intentd#138](https://github.com/intent-hq/intentd/pull/138), 2026-07-14)



### STAB-3 (2026-07-13, area: intentd PR↔workspace linking, severity: P1)

An open PR whose head branch exactly matches the workspace branch is never linked to the workspace.

**Repro:** In a workspace on branch X, file a PR with head X via `gh`, wait >2 minutes, call `pr.status`. Observed while self-hosting: monorepo PR #98 was filed with head branch `any-fix` for the workspace on branch `any-fix`; well beyond several 60s background-refresh cycles, `pr.status` still returns `-32603` "No active PR", no `pr:linked` event is emitted, and the FE PR panel keeps showing "Create PR" instead of the open PR.

**Expected:** The 60s background + on-demand PR refresh matches the PR by `head.ref` (branch-only matching per BREADCRUMBS Milestone 4 Cycle B), persists `activePullRequest`/`prStatus`, emits `pr:linked`, and the `pr.*` surface + FE PR panel reflect the open PR.

**Status:** fixed ([intent-hq/intentd#131](https://github.com/intent-hq/intentd/pull/131), 2026-07-13)

### STAB-4 (2026-07-13, area: intentd agent runtime / chat transcript (queue-flip path), severity: P1)

Messages queued while an agent is mid-turn do not appear in the conversation when they are dequeued and delivered.

**Repro:** Send message A to an agent, then send message B while the agent is still streaming A's turn; after A's turn ends, B's turn starts — B's text is absent from the transcript. Observed while self-hosting: sending a message to a busy agent queues it (expected), but when the current turn ends and the queue-flip loop flips the queued message to in-flight, the delivered user message never shows up in the conversation transcript/UI — the agent acts on it, but the transcript is missing the user message that triggered the turn.

**Expected:** On dequeue, the user message is persisted to the conversation (`agent.getConversation`) and pushed to live subscribers (`chat.subscribe` delta / `agent:stream` events) exactly like a directly-delivered message.

**Status:** fixed ([intent-hq/intentd#132](https://github.com/intent-hq/intentd/pull/132), 2026-07-14)

### STAB-5 (2026-07-13, area: intentd agent events / parent notifications, severity: P2)

A child agent's completion report is re-delivered to the parent agent multiple times.

**Repro:** Delegate a task to a child agent, let it complete and deliver its report, then trigger additional parent wakes (e.g. new user messages) and observe the same completion report re-delivered. Observed while self-hosting: after a delegated implementor completed and its report was delivered and acted upon, the identical "[WORKSPACE EVENTS] Child agent ... completed. Report: ..." message was delivered to the coordinator again on two subsequent turns, hours of activity later, as if the completion event was never acknowledged/marked consumed.

**Expected:** A child-completion notification is delivered to the parent exactly once (or is idempotently deduplicated); already-consumed completion events are not replayed on later wakes.

**Status:** fixed ([intent-hq/intentd#143](https://github.com/intent-hq/intentd/pull/143), 2026-07-14)

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

**Status:** fixed ([intent-hq/intentd#147](https://github.com/intent-hq/intentd/pull/147), 2026-07-14)

### STAB-8 (2026-07-13, area: intentd agent runtime / delegation (self-hosted stack), severity: P1)

Delegated agents stall: initial prompt never runs / agents go idle mid-flow.

**Repro:** In this workspace today, 3 of 4 delegated/created agents never started their initial prompt (agent diagnostics showed 'initial-prompt-not-running'; conversations contained only empty user messages, zero assistant turns) and required a manual wake (wakeOrCreate / send) or full re-delegation. Separately, two agents later went idle mid-task (during PR flows) without completing or reporting, and needed another wake.

**Expected:** A delegated agent starts running its initial prompt immediately after creation, and either completes its task or reports a blocker; no silent stalls.

**Status:** fixed (intent-hq/intentd#148, 2026-07-14)

### STAB-10 (2026-07-14, area: cloudlands-fe workspace context — git config still FS-backed, severity: P2)

The `context.*` and `git.config` MCP tools still read directly from the filesystem instead of using daemon RPCs.

**Repro:** Following cloudlands-fe PR #60 (STAB-25, retire FileSystemWorkspaceRepository disk reads), workspace metadata reads now go through intentd `workspace.*` RPCs. However, the `context.*` and `git.config` tools in the workspace API MCP server still read git config directly from `.git/config` on disk rather than calling daemon RPCs.

**Expected:** All workspace state comes from intentd. The daemon should provide RPCs for git configuration (PROTOCOL §5.1) and the FE tools should consume them instead of reading the filesystem.

**Status:** fixed ([intent-hq/intentd#159](https://github.com/intent-hq/intentd/pull/159), [intent-hq/cloudlands-fe#70](https://github.com/intent-hq/cloudlands-fe/pull/70), [intent-hq/intentd#175](https://github.com/intent-hq/intentd/pull/175), [intent-hq/cloudlands-fe#73](https://github.com/intent-hq/cloudlands-fe/pull/73), 2026-07-14/15) — git.getConfig RPC (intentd#159) adopted with FS fallback only when workspaceId unavailable (cloudlands-fe#70); workspace.getUiContext/updateUiContext RPCs (intentd#175) adopted with one-time FS→daemon migration and FS fallback (cloudlands-fe#73)

### STAB-37 (2026-07-15, area: cloudlands-fe change-history persistence / init race, severity: P2)

Repeated "Change history not initialized" warnings when change history is accessed before initialization completes.

**Repro:** During app startup or workspace switch, change-history accessors (`getChangeHistoryForWorkspace`, `getAllChangeHistory`, `setChangeHistoryForWorkspace`) are called from `change-detector-manager-impl.ts` (lines 923, 944, 987) and `workspace.service.ts` (line 314) before `initChangeHistory()` completes its async fetch from daemon `settings.get`. Observed while dogfooding: console logs show multiple "Change history not initialized, returning empty history for <workspaceId>" warnings from `change-history-persistence.ts:72` (`warnIfUninitialized` helper). The module fires `initChangeHistory()` asynchronously in `workspace.ipc.ts:280` at app startup, but callers do not await the `initPromise` — they synchronously access the cache while it is still initializing.

**Status:** fixed ([intent-hq/cloudlands-fe#75](https://github.com/intent-hq/cloudlands-fe/pull/75), 2026-07-15) — Made change-history accessors async and added ensureInitialized() helper to gate access until initialization completes. Updated all call sites to await accessors. Added regression test.

### STAB-38 (2026-07-15, area: cloudlands-fe chat send path + intentd agent runtime / interrupt priority, severity: P1)

Force-send during agent processing queues the message instead of interrupting; repeated force-send enqueues duplicates.

**Repro:** Observed 2026-07-15 in cloudlands-fe chat UI: when an agent is busy in a long tool-heavy turn, the user pressed force-send (⌘Enter) twice on a new message. Both messages appeared under "Queued messages (2)" with identical content; the running turn was not interrupted. The chat UI `ChatPanel.svelte` `handleForceSubmit` (lines 2571–2614) dispatches `sendMessage` with `forceSubmit: true` and `skipQueueCheck: true`, which flows through `chat-send-service.ts` to `agent-stream-lifecycle.ts` `sendMessage` (lines 687+), then via `AGENT_BACKEND_CHANNELS.STREAM_MESSAGE` IPC to the daemon's `agent.sendMessage` RPC. PROTOCOL.md §5.5 specifies that `priority: "interrupt"` preempts an in-flight turn (§7: "with `priority: "interrupt"` it instead preempts the turn keep-alive and streams immediately") — but the FE send path does not set `priority` in the IPC call (`agent-stream-lifecycle.ts:1423` invokes with `content`, `workspaceId`, `model`, `contextReferences`, `imageBlocks`, `fileBlocks`, `noteIds`, `personality`, `stdinContext`, `messages`, `resetHistory` — no `priority` field). Without `priority: "interrupt"`, the daemon treats force-send as a normal message and queues it when the agent is mid-turn, per the auto-queue fallback (§5.5: "auto-queues if the agent is mid-stream"). Repeated force-send with no dedup passes the same text again, creating duplicate queue entries.

**Expected:** Force-send interrupts the current turn and delivers immediately when the agent is streaming (one interrupt, even if pressed multiple times before the turn ends). The FE send path should pass `priority: "interrupt"` to `agent.sendMessage` when `forceSubmit: true`, and the daemon should deduplicate repeated interrupt delivery with the same client-supplied `messageId` per PROTOCOL.md §5.5 ("duplicate interrupt delivery with the same `messageId` is absorbed idempotently as `{ success: true, queued: false, messageId, deduplicated: true }`").

**Status:** fixed ([intent-hq/cloudlands-fe#77](https://github.com/intent-hq/cloudlands-fe/pull/77), 2026-07-15) — Root cause: FE middleware never extracted `forceSubmit` from the action payload or set `priority: "interrupt"` on the IPC call. Fixed by threading `forceSubmit` through `dispatchToLifecycle`, bypassing queue-on-send check when true, and passing `priority: forceSubmit ? "interrupt" : undefined` to the daemon. Also added `priority` field to `AgentBackendStreamMessageSchema` so Zod doesn't strip it. Regression test added asserting force-send bypasses queue and passes priority to lifecycle.

### STAB-39 (2026-07-15, area: cloudlands-fe CI / auto-update-channel-persist test temp-dir cleanup race, severity: P2)

Flaky test failure: `auto-update-channel-persist.test.ts` fails intermittently in CI with temp-directory cleanup race.

**Repro:** The test suite's `afterEach` hook (line 58) calls `fs.rm(testUserDataPath, { recursive: true, force: true })` to clean up the temp directory created by `fs.mkdtemp` in `beforeEach` (line 47). This cleanup can race with async write operations that are still in flight when the test completes, causing intermittent failures. Observed 2026-07-15 on cloudlands-fe [#75](https://github.com/intent-hq/cloudlands-fe/pull/75): the test failed 5 times across CI runs while being completely unrelated to that PR's changes (change-history init race fix). Each test case in the suite (`setChannel(beta)`, `setChannel(stable)`, `loadChannelFromSettings`, etc.) uses `await expect.poll()` to wait for `local-prefs.json` writes, but the service's async file operations may not fully settle before `afterEach` fires, creating a race between cleanup and pending writes.

**Expected:** Test is deterministic. Temp directories are created and cleaned per-test without cross-test races. The `afterEach` cleanup waits for all async operations to settle (e.g., explicit service teardown, extended poll timeout, or coordinated flush) before removing the temp directory.

**Status:** fixed ([intent-hq/cloudlands-fe#76](https://github.com/intent-hq/cloudlands-fe/pull/76), 2026-07-15)

### STAB-40 (2026-07-15, area: intentd CI / coverage instrumentation, severity: P2)

Flaky test failure: `wss_integration::wss_note_save_asset_round_trip` under cargo-llvm-cov instrumentation.

**Repro:** The `wss_integration::wss_note_save_asset_round_trip` test passed reliably when run standalone (`cargo test`) but flaked intermittently when run under coverage instrumentation (`cargo llvm-cov`). Observed on intentd PR #179 coverage-e2e CI runs (https://github.com/intent-hq/intentd/pull/179) — test passed consistently in the standalone `check` job but occasionally failed in the `coverage-e2e` job. The flake is no longer reproducible in 10/10 consecutive runs (both standalone and under llvm-cov); root cause remains unknown.

**Expected:** Test passes reliably under both standalone and instrumented execution. Coverage instrumentation should not introduce timing-dependent failures.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/214, 2026-07-17) — flake no longer reproducible after 10+ consecutive runs; skip removed from coverage-e2e.sh and continuing to monitor

### STAB-41 (2026-07-15, area: intentd CI / intent-pty host tests, severity: P2)

Flaky test failure: `intent-pty host::tests::kill_scope_leaves_no_process_group_orphan` on GitHub Actions runners.

**Repro:** The `kill_scope_leaves_no_process_group_orphan` test in intent-pty failed once on a GitHub Actions runner with "grandchild pid printed" panic (run 29397285947, https://github.com/intent-hq/intentd/actions/runs/29397285947). Root cause: grandchild PID print raced a fixed 5s deadline on slow GitHub Actions runners.

**Expected:** Test passes reliably across all runner environments. Process group cleanup assertions should be robust to timing variations.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/214, 2026-07-17) — changed from fixed 5s sleep to bounded polling (100ms intervals, 5s max) to detect PID print reliably across runner speeds

### STAB-42 (2026-07-15, area: intentd CI / uds_concurrent_dispatch test, severity: P2)

Flaky test failure: `uds_concurrent_dispatch::slow_host_exec_does_not_block_fast_workspace_list` under cargo-llvm-cov instrumentation.

**Repro:** The `slow_host_exec_does_not_block_fast_workspace_list` test in `crates/intentd/tests/uds_concurrent_dispatch.rs` failed consistently under coverage instrumentation (`cargo llvm-cov`) with "timed out waiting for a frame: Elapsed(())" panic at line 63. Root cause: test used single-threaded `#[tokio::test]` since inception (45b25e3 / PR #79), serializing spawned tasks. The test never actually passed standalone — the KNOWN_ISSUES claim that it "passes standalone" was incorrect. Production dispatch is concurrent (daemon uses multi-threaded `#[tokio::main]`).

**Expected:** Test passes reliably under both standalone and instrumented execution.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/214, 2026-07-17) — changed test to use multi-threaded runtime via `#[tokio::test(flavor = "multi_thread")]`; skips removed from coverage-all.sh and coverage-e2e.sh

### STAB-43 (2026-07-15, area: intentd CI / intent-core unit test, severity: P2)

Flaky test failure: `path_utils::tests::capture_login_shell_path_with_fake_shell` in both plain CI and coverage runs.

**Repro:** The `capture_login_shell_path_with_fake_shell` test in `crates/intent-core/src/path_utils.rs` failed intermittently in CI: once in the standalone `check` job (intentd PR #186) and intermittently in coverage-all runs (PRs #182, #183). Root cause: fake shell fixture file writes were not flushed before exec, causing intermittent reads of incomplete script content.

**Expected:** Test passes reliably in CI without intermittent failures.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/214, 2026-07-17) — added `sync_all()` flush after writing the fake shell script; skip removed from coverage-all.sh

### STAB-44 (2026-07-15, area: intentd CI / WSS e2e test, severity: P2)

Flaky test failure: `e2e_mock_agent_workspace_api_bindings::seeded_conversation_rehydrates_over_wss` timeout under coverage instrumentation.

**Repro:** The `seeded_conversation_rehydrates_over_wss` test in `crates/intentd/tests/e2e_mock_agent_workspace_api_bindings.rs` timed out intermittently under coverage instrumentation (`cargo llvm-cov`). Root cause: llvm-cov instrumentation overhead exceeded the test's fixed timeout.

**Expected:** Test passes reliably under both standalone and instrumented execution.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/214, 2026-07-17) — introduced `INTENTD_TEST_TIMEOUT_MULTIPLIER` env var (default 1, coverage scripts set to 3); test harness now scales all timeouts by this multiplier; skip removed from coverage-e2e.sh


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

### STAB-61 (2026-07-17, area: cloudlands-fe repo / nested submodule gitlink, severity: P2)

The cloudlands-fe repo carried an orphaned `intentd` submodule gitlink (mode `160000`) with no matching entry in its `.gitmodules`, breaking `git submodule update --init --recursive` in the parent monorepo.

**Repro:** From a fresh monorepo clone, run `git submodule update --init --recursive`. It aborts with `fatal: No url found for submodule path 'packages/cloudlands-fe/intentd' in .gitmodules`, leaving `packages/ios` unpinned (checked out to `main` tip instead of the recorded commit) and `packages/intentd` with an empty working tree (index populated but files not extracted). `git -C packages/cloudlands-fe ls-files -s intentd` showed mode `160000` (gitlink) → commit `befdb2371f292ecd93886ffeee2d236123ee493b`, but `packages/cloudlands-fe/.gitmodules` had no entry for `intentd`.

**Expected:** `git submodule update --init --recursive` from a fresh clone succeeds end-to-end, initializing all three top-level submodules at their pinned commits.

**Root cause:** Leftover nested-submodule gitlink in the cloudlands-fe repo from before the monorepo restructure. Nothing in cloudlands-fe references the `intentd/` path anymore — the FE resolves the intentd binary by walking up from `process.cwd()` to `packages/intentd/target/{release,debug}/intentd`, and `scripts/copy-sidecar.cjs` targets a gitignored `resources/sidecar/intentd` staging path.

**Status:** fixed ([intent-hq/cloudlands-fe#92](https://github.com/intent-hq/cloudlands-fe/pull/92), 2026-07-17) — `git rm --cached intentd` in cloudlands-fe removes the stray gitlink; monorepo submodule bump follows.

### STAB-59 (2026-07-16, area: WSS listener settings / Settings UI, severity: P2)

Enabling the WebSocket API with the port already in use failed silently (error only in daemon stderr; no toast) and the port was not editable in the UI.

**Repro:** Start intentd, enable the WebSocket API via Settings UI while another process is already bound to the default port (5181). Observed while dogfooding: the toggle appeared to enable but the listener never started (error only in daemon stderr: "Address already in use"); no user-facing error toast was shown. Additionally, the port input field was disabled/non-editable in the Settings UI, so there was no way to change the port to an available one without manually editing the daemon settings file.

**Expected:** When enabling the WebSocket API fails (e.g., port in use), show a user-facing error toast with the failure reason. The port input field should always be editable regardless of the toggle state, allowing the user to pick a different port before retrying.

**Status:** fixed ([intent-hq/intentd#201](https://github.com/intent-hq/intentd/pull/201), [intent-hq/cloudlands-fe#85](https://github.com/intent-hq/cloudlands-fe/pull/85), 2026-07-16)

### STAB-58 (2026-07-15, area: intentd agent spawn / provider binary resolution, severity: P1)

Agent spawn fails with `spawn provider failed: claude-agent-acp: No such file or directory` when the provider CLI is not in the daemon's inherited PATH.

**Repro:** Create a blank agent using the claude-code provider (or any ACP provider) when the provider binary exists only in a non-standard location (e.g., Reve's private app dir `~/Library/Application Support/revedev-52ae4245/bin`) not in the daemon's PATH and not in `~/.augment/bin`. Observed while self-hosting: attempting to spawn an agent with `claude-agent-acp` or `auggie` from the dogfooding daemon failed with `ENOENT` errors because both binaries existed only in Reve's private bin directory, which was not on the daemon's PATH. The spawn path called `Command::new(opts.provider.command)` with bare command names and never populated `SpawnOptions.provider_binary`, so `enhanced_path(None)` only searched `~/.augment/bin` (empty on this machine) + generic node/homebrew dirs + inherited PATH. The agent never responded and remained stuck.

**Expected:** The daemon resolves provider binaries to absolute paths using 3-tier precedence: (1) `providers.paths.<id>` setting, (2) `~/.augment/bin/<command>`, (3) enhanced PATH directory scan (including discovery logic from `find_auggie` / `resolve_on_path`). The resolved absolute path is used for `Command::new` AND passed as `SpawnOptions.provider_binary` so `enhanced_path` prepends its parent directory (ensuring co-located node resolves for shebang scripts). If resolution fails at all three tiers, spawn proceeds with bare name (backward-compatible fallback). Uniform across all providers — no per-provider special cases. Spawn failure errors name the unresolvable command.

**Status:** fixed ([intent-hq/intentd#189](https://github.com/intent-hq/intentd/pull/189), 2026-07-16) — generalized provider binary discovery with settings → managed bin → PATH-scan precedence, wired into agent spawn

### STAB-2 (2026-07-13, area: cloudlands-fe UI — workspace timeline/feed, severity: P2)

The "workspace start" indicator renders at the bottom of the workspace view instead of marking the chronological beginning of the workspace.

**Repro:** Open a workspace with multiple activity items and locate the workspace start indicator. Observed while self-hosting: in a workspace whose first activity was the "Scaffold docs/01_stabilizing" work, the start indicator appeared way down at the bottom of the feed rather than at the top where the workspace began.

**Expected:** The indicator anchors the beginning of the workspace (before/at the first item), regardless of feed ordering.

**Status:** fixed ([intent-hq/cloudlands-fe#72](https://github.com/intent-hq/cloudlands-fe/pull/72), 2026-07-14) — timeline reducers sorted events by string localeCompare instead of Date.getTime()

### STAB-33 (2026-07-14, area: intentd intent-acp session lifecycle, severity: P2)

Fixed 1-hour prompt timeout kills healthy long turns.

**Repro:** Any agent turn exceeding 60 minutes dies with "request `session/prompt` timed out" even while actively streaming session/updates. Observed 2026-07-14 when an implementor turn combining a CI watch (`gh pr checks --watch`) with a 20-thread review sweep exceeded the fixed `PROMPT_TIMEOUT` (intent-acp/src/session.rs, 60*60s). The deadline never resets on streaming activity, so busy and wedged turns are indistinguishable.

**Expected:** Use activity-based idle timeout instead of fixed deadline — reset the timer on every streaming update so actively-working turns never time out. Only kill sessions that are truly silent/wedged.

**Status:** fixed ([intent-hq/intentd#169](https://github.com/intent-hq/intentd/pull/169), 2026-07-14) — activity-based idle timeout, 15min default via INTENTD_PROMPT_IDLE_TIMEOUT_MS, replaces the fixed 1h ceiling

### STAB-11 (2026-07-13, area: cloudlands-fe sidecar watchdog + intentd store pool, severity: P1)
*(Renumbered from STAB-6 to resolve duplicate)*

The cloudlands-fe sidecar watchdog kills the daemon while it is healthy, triggered by intentd store pool exhaustion.

**Repro:** Run under moderate workspace load (multiple agents, concurrent note writes, PR operations). Observed while self-hosting: cloudlands-fe sidecar watchdog detected that intentd stopped responding to health checks and killed the daemon; the daemon was actually alive but all SQLite pool connections were in use, blocking the health-check handler from acquiring a connection to run its trivial `SELECT 1` query, triggering the watchdog timeout.

**Expected:** Health-check requests either bypass the store pool entirely (no DB access required), use a dedicated reserved connection, or have a fast-fail timeout that lets the watchdog distinguish "slow but alive" from "dead". The daemon should never be killed while healthy.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/137, https://github.com/intent-hq/cloudlands-fe/pull/43, 2026-07-14)

### STAB-9 (2026-07-14, area: intentd CI / agent spawn retry e2e test, severity: P1)

Intermittent CI failures in `agent_retry_rpc_recovery_path_over_wss` test on main and all open PRs.

**Repro:** Test expected spawn failure after retry exhaustion, but sometimes succeeded in CI due to race between event delivery and status persistence. Test waited for `agent:stream:end` event (published before status persisted to DB), so `agent.getSession` could read stale status. Additionally, the test broke early on the first `agent:status-changed` event without waiting for all three terminal events (`agent:failed`, `agent:stream:end`, `agent:status-changed`), causing flakiness when event delivery order varied.

**Expected:** Test waits for ALL three terminal events (order-independent) and uses `agent:status-changed` (published AFTER `set_agent_session_status` DB write completes) to guarantee read-after-write consistency.

**Status:** fixed ([intent-hq/intentd#149](https://github.com/intent-hq/intentd/pull/149), 2026-07-14)

### STAB-12 (2026-07-14, area: intentd agent runtime / agent.sendMessage fallback path, severity: P1)
*(Shipped as STAB-7 in intent-hq/intentd#150 title)*

The `agent.sendMessage` fallback path (queue when target is busy) drops image and file content blocks.

**Repro:** Send a message with image or file attachments to a busy agent. Observed while self-hosting: when the target agent is mid-turn and the message is queued for later delivery, the fallback code path (`QueuedMessage::from` conversion) only preserves `text_blocks` and drops `image_blocks` and `file_blocks`. After dequeue, the delivered message contains only text, losing the attachments.

**Expected:** The fallback path preserves full block fidelity — `image_blocks` and `file_blocks` are stored in `QueuedMessage` and restored on dequeue exactly like `text_blocks`.

**Status:** fixed ([intent-hq/intentd#150](https://github.com/intent-hq/intentd/pull/150), 2026-07-14)

### STAB-22 (2026-07-14, area: cloudlands-fe agent footer / streaming state hydration, severity: P2)

Agent footer shows "Thinking..." state for non-streaming idle agents after page refresh.

**Repro:** Open a workspace with an idle agent, refresh the page. Observed while self-hosting: after hydration, the agent footer displays "Thinking..." with the thinking spinner even though the agent is idle and not streaming. The hydration logic initialized `isThinking` to `true` unconditionally without checking the actual streaming state.

**Expected:** Footer state reflects the actual agent status on hydration — idle agents show idle state, streaming agents show thinking state.

**Status:** fixed ([intent-hq/cloudlands-fe#55](https://github.com/intent-hq/cloudlands-fe/pull/55), 2026-07-14)

### STAB-23 (2026-07-14, area: cloudlands-fe agent footer / hydration timing, severity: P2)

Agent footer flickers or shows stale state during hydration.

**Repro:** Open a workspace with active agents and refresh. Observed while self-hosting: during hydration, the agent footer briefly shows incorrect state (e.g., thinking indicator when agent is idle, or missing footer entirely) before settling to the correct state. Race between component mount and streaming-state initialization.

**Expected:** Footer hydrates synchronously with correct state from the start, no flicker.

**Status:** fixed ([intent-hq/cloudlands-fe#55](https://github.com/intent-hq/cloudlands-fe/pull/55), 2026-07-14)

### STAB-24 (2026-07-14, area: cloudlands-fe terminal tabs / workspace switch, severity: P2)

Terminal tabs are lost when switching between workspaces.

**Repro:** Open terminal tabs in workspace A, switch to workspace B, switch back to workspace A. Observed while self-hosting: terminal tabs from workspace A do not persist after switching away and back — the terminal tab list is empty or shows only new tabs. Terminal tab state was not scoped per workspace or persisted correctly.

**Expected:** Each workspace retains its own terminal tabs across workspace switches. Tab state (terminal ID, title, working directory) persists and restores when returning to the workspace.

**Status:** fixed ([intent-hq/cloudlands-fe#56](https://github.com/intent-hq/cloudlands-fe/pull/56), 2026-07-14)

### STAB-26 (2026-07-14, area: cloudlands-fe UI state persistence / boot-time clobber, severity: P1)

Persisted UI state (open tabs, active tab) is clobbered on application boot.

**Repro:** Open multiple workspace tabs with a specific active tab, quit and restart the app. Observed while self-hosting: after boot, the workspace tab list is empty or shows only a default tab, losing the persisted state from the previous session. Root cause: `cleanupInvalidWorkspaceTabs` fires before the workspace list has loaded (`workspace.hasLoaded` is false), treating all persisted tabs as invalid and clearing them.

**Expected:** Boot-time cleanup guards against running before workspace data is available. Persisted tabs are validated against the loaded workspace list only after `workspace.hasLoaded` is true, preserving valid tabs across restarts.

**Status:** fixed ([intent-hq/cloudlands-fe#58](https://github.com/intent-hq/cloudlands-fe/pull/58), 2026-07-14)

### STAB-27 (2026-07-14, area: cloudlands-fe queued messages / edit-mode hold, severity: P2)

Editing a queued prompt does not hold the queue, allowing the original unedited message to send.

**Repro:** Send a message to a busy agent (queues the message), then click edit on the queued message in the queue list. Observed while self-hosting: starting edit mode sets only local component state but does not call the `agent.editQueuedMessage` RPC with `editing: true`, so the queue continues to drain and the unedited message sends before the user can save their edits.

**Expected:** Entering edit mode on a queued message immediately holds the queue by calling `agent.editQueuedMessage` with `editing: true`. The queue remains paused until the user saves (sends edited content + `editing: false`) or cancels (restores original + `editing: false`). Every exit path from edit mode releases the hold.

**Status:** fixed ([intent-hq/cloudlands-fe#59](https://github.com/intent-hq/cloudlands-fe/pull/59), 2026-07-14)

### STAB-28 (2026-07-14, area: intentd agent runtime / interrupt + completion watches, severity: P1)

Interrupt-priority messages do not emit `agent:idle` after delivery, wedging completion watches.

**Repro:** Interrupt a streaming agent with a priority=interrupt message. Observed while self-hosting: after the interrupt is delivered and the agent processes the message, no `agent:idle` event is emitted. Parent agents or tooling waiting on `agent:idle` (via `agent.waitForCompletion` or event subscriptions) block indefinitely even though the agent has finished processing the interrupt.

**Expected:** After delivering an interrupt-priority message, the agent runtime emits `agent:idle` (and `agent:stream:end`) so watchers can detect completion. Interrupt delivery follows the same event contract as normal message delivery.

**Status:** fixed ([intent-hq/intentd#148](https://github.com/intent-hq/intentd/pull/148), 2026-07-14)

### STAB-29 (2026-07-14, area: intentd workspace.purge orphan sweep / cloudlands-fe startup purge, severity: P0)

Two daemons with separate SQLite DBs sharing the same default workspaces root triggered catastrophic data loss via workspace.purge orphan sweep.

**Repro:** Run two intentd instances (prod app + dev stack) with separate SQLite databases but sharing the default workspaces root `~/intent/workspaces`. Each app launch triggered `workspace.purge` whose pass-2 orphan sweep called `remove_dir_all` on every workspace directory absent from that daemon's DB. Observed while self-hosting: the dev stack daemon wiped the any-fix workspace checkout because it existed only in the prod daemon's database.

**Expected:** Workspace cleanup must never delete directories it doesn't own. The purge feature was removed entirely to prevent this class of data-loss bug.

**Status:** fixed ([intent-hq/intentd#155](https://github.com/intent-hq/intentd/pull/155), [intent-hq/cloudlands-fe#64](https://github.com/intent-hq/cloudlands-fe/pull/64), 2026-07-14) — purge feature removed

### STAB-30 (2026-07-14, area: intentd CI / runner disk exhaustion, severity: P1)

Intermittent CI failures in the `check` job: "No space left on device" during Tests or rust-cache post step.

**Repro:** On intentd main runs 29304250834, 29301806668 (rust-cache post step failed with "No space left on device"), and runs 29307318874, 29306678297, 29306184499 (job died mid-Tests with null step conclusion). GitHub Actions ubuntu-latest runners have ~53 GB of preinstalled software (dotnet, android, ghc, ghcup) leaving insufficient headroom for Rust compilation + test artifacts.

**Expected:** The `check` job frees unnecessary preinstalled bundles before compilation, sets `CARGO_INCREMENTAL=0` to reduce target dir overhead, and includes `df -h` diagnostics to measure disk usage. Tests run reliably without exhausting disk.

**Status:** fixed ([intent-hq/intentd#146](https://github.com/intent-hq/intentd/pull/146), 2026-07-14)

### STAB-31 (2026-07-14, area: intentd agent runtime / AgentManager process cap on macOS, severity: P2)

Agent process cap stuck at conservative fallback 8 on macOS instead of RAM-based cap.

**Repro:** Run intentd on macOS. Observed while self-hosting on macOS with 64 GB RAM: `AgentManager::new` logged "Failed to detect system RAM, using fallback cap of 8" and capped concurrent agents at 8 instead of the expected RAM-based cap of 32 (64 GB / 2 GB per agent). The daemon was hardcoded to use Linux procfs (`/proc/meminfo`) for RAM detection, which doesn't exist on macOS, forcing the fallback.

**Expected:** AgentManager detects total physical RAM on both Linux (procfs) and macOS (sysctl `hw.memsize` via `libc::sysctlbyname`) and calculates the cap as `total_ram_gb / 2`. Additionally, the `agents.maxConcurrent` setting (new in this fix) allows explicit override: `0` (default) triggers auto-detection, positive integer sets an explicit cap with upper bound 200.

**Status:** fixed ([intent-hq/intentd#134](https://github.com/intent-hq/intentd/pull/134), 2026-07-14)

### STAB-32 (2026-07-14, area: intentd CI / WSS e2e test, severity: P2)

Flaky CI test failure: `router_read_lifecycle_arms_over_wss` in `e2e_wss_agent_lifecycle.rs` with "no mcp servers configured on a fresh workspace".

**Repro:** On intent-hq/intentd PR #134, the `router_read_lifecycle_arms_over_wss` e2e test failed intermittently with assertion error on fresh workspace expecting zero MCP servers.

**Expected:** WSS e2e tests exercise real JSON-RPC transport + method catalog without intermittent failures.

**Status:** not reproducible (investigation 2026-07-14) — The test `router_read_lifecycle_arms_over_wss` still exists in the codebase at `crates/intentd/tests/e2e_wss_agent_lifecycle.rs:2755`. PR [#134](https://github.com/intent-hq/intentd/pull/134) was the macOS RAM-based agent process-cap fix and removed a different test (`e2e_wss_agent_max_concurrent.rs`), not this one. Verification: 25/25 local passes and no failures in 3 days of CI history (2026-07-11 through 2026-07-14). The reported flake is not reproducible on current main.

### STAB-35 (2026-07-14, area: intentd agent events / subscription dedupe + settlement coalescing, severity: P2)

Duplicate agent completion notifications when parent agents repeatedly wake/send to the same child.

**Repro:** Parent agent calls `agent.wakeOrCreate` or `agent.sendToTask` multiple times for the same child task. Observed while self-hosting: each call to `agent_watch_completion_op` or `agent_watch_completion_for_sender_op` created a new subscription with a fresh UUID, even when an identical watch already existed for the same (parent, child) pair. Additionally, `agent:idle` could fire prematurely when messages were queued, creating a race where concurrent message enqueuing between the turn-end check and the worker loop's dequeue call caused duplicate completion notifications.

**Expected:** Completion watches are idempotent — repeated subscribe calls for the same (parent, child) pair return the same subscription ID and deliver exactly one notification per settle cycle. Settlement coalescing ensures `agent:idle` is only published when the target agent is both idle AND its message queue is empty (one notification per settle cycle, not one per turn).

**Status:** fixed ([intent-hq/intentd#171](https://github.com/intent-hq/intentd/pull/171), 2026-07-14)

### STAB-34 (2026-07-14, area: intentd CI / agent_manager process-cap test, severity: P1)

Main branch CI red, all intentd merges blocked by `agent_manager::tests::process_cap_events_queued_resumed_evicted` test failure.

**Repro:** The `check` CI job fails with assertion "resume path emits agent:process:resumed" on main tip 13a1e4f5 (run https://github.com/intent-hq/intentd/actions/runs/29340545221) and on PR #159 (2 runs). Test passes locally on macOS. The test was introduced with the STAB-31 fix (intent-hq/intentd#134). Root cause: test race with async event emission. Events are spawned via `tokio::spawn` in `ProcessRegistry` methods, so they may arrive in any order or be batched unpredictably. The original test used one-shot `sub.recv()` calls that raced with async delivery.

**Expected:** Test should use bounded wait loops that filter by agent ID and event type, continuing on timeout and only breaking when the expected event is found or subscription closes.

**Status:** fixed ([intent-hq/intentd#164](https://github.com/intent-hq/intentd/pull/164), 2026-07-14)

### STAB-36 (2026-07-14, area: intentd intent-services agent_manager tests, severity: P2)

Flaky CI test failure: `agent_manager::tests::process_cap_events_queued_resumed_evicted` with ~50% failure rate.

**Repro:** The `agent_manager::tests::process_cap_events_queued_resumed_evicted` test failed intermittently in CI with ~50% failure rate. Introduced by intentd PR #160, blocked intentd PR #162 CI runs.

**Expected:** Test should pass reliably in CI without intermittent failures.

**Status:** fixed ([intent-hq/intentd#164](https://github.com/intent-hq/intentd/pull/164), 2026-07-14)

### STAB-57 (2026-07-16, area: cloudlands-fe changes panel / daemon event bridge, severity: P1)

Agent commits do not appear in the sidebar Changes panel in a brand-new workspace until switching out of the workspace and back.

**Repro:** In a brand-new workspace, have an agent make commits. Observe the sidebar Changes panel — the commits do not appear. Switch to a different workspace, then switch back to the original workspace. The commits now appear.

**Expected:** Agent commits (and git pull / changes:tracked events) should trigger the Changes panel to refresh within ~2 seconds, without requiring a workspace switch.

**Status:** fixed ([intent-hq/cloudlands-fe#82](https://github.com/intent-hq/cloudlands-fe/pull/82), 2026-07-16) — frontend firehose daemon event bridge now dispatches per-workspace debounced (1s) `changes/refreshRequested` on `git:commit`, `git:pull`, and `changes:tracked` events
