# Known Issues

Live issue tracker for the **01_stabilizing** self-hosting phase.

**Next available ID:** STAB-132 (as of 2026-07-20)

## Intake Convention

Each issue entry includes:

- **ID** — `STAB-N` sequential numbering
- **Date** — when discovered (YYYY-MM-DD)
- **Area** — component/subsystem (e.g., `intentd note persistence`, `cloudlands-fe chat UI`, `ios sync`)
- **Severity** — P0 (crash/data-loss), P1 (broken feature), P2 (papercut)
- **Repro** — minimal steps to reproduce
- **Status** — `open` or `open (optional note)` | `fixed (PR link, date)`

---

## Fixed Issues

### STAB-131 (2026-07-20, area: cloudlands-fe specialist hydration, severity: P1)

Specialist refetch corruption: refetching specialists during file-watching startup corrupted bundled specialist state in memory, causing new specialist-delegated agents to fail to spawn with "specialist not found" errors even though the bundled specialist files existed. Discovered during STAB-117 dogfooding.

**Repro:** With file-watching enabled (default in dev mode), start the daemon and immediately delegate a task to a specialist (implementor/verifier). Observed: the agent spawn failed with "specialist not found" or similar error, even though the bundled specialist markdown files were present in the resources directory. The issue occurred because the file-watcher startup sequence refetched specialists from disk, and user-created specialists (even empty ones) shadowed bundled specialists, resulting in incomplete specialist metadata (missing model, tool restrictions, etc.).

**Root cause:** The specialist refetch logic (`refetchAndDispatch` in `specialists-mutation-service.ts`) did not preserve bundled specialist state when user files shadowed them. During startup, the file-watcher triggered a refetch that replaced bundled specialists with user specialists, losing critical metadata (default model, tool restrictions, etc.) from the bundled files. New agents delegated to these specialists failed to spawn because the specialist metadata was incomplete.

**Expected:** Refetching specialists preserves bundled specialist data even when user files shadow them. Bundled specialists remain fully functional with their default models and tool restrictions intact.

**Status:** fixed ([intent-hq/cloudlands-fe#174](https://github.com/intent-hq/cloudlands-fe/pull/174), 2026-07-20) — Modified specialist refetch logic to preserve bundled specialist metadata when shadowed by user files. Added regression test verifying bundled specialists remain functional after refetch.

---

### STAB-130 (2026-07-20, area: intentd agent runtime + model resolution, severity: P1)

Model selector and default model resolution failures: delegated agents (implementor/verifier) created without an explicit model ignored settings-configured defaults and fell through to the CLI's own default. Additionally, specialist frontmatter model was not resolved or persisted at agent creation time, and path-traversal/workspace-path security guards were missing. Follow-up to STAB-117.

**Repro:** Delegate a task to an implementor or verifier without specifying a model. Observed: the agent used the CLI's default model instead of the settings-configured default (model.default, model.workspaceOverrides, backgroundAgents.defaultModel, backgroundAgents.typeOverrides). Specialist frontmatter `model:` field was not read during delegation, so specialist-specific model preferences were ignored.

**Root cause:** Three bugs: (A) The settings keys `model.default`, `model.workspaceOverrides`, `backgroundAgents.defaultModel`, and `backgroundAgents.typeOverrides` were defined in the settings schema but never read by `agent_create_op` / `agent_delegate_op` / `resolve_spawn`. Delegated agents created without an explicit model ignored the settings-configured default entirely and fell through to the CLI's own default. (B) Specialist frontmatter model was not parsed or resolved at agent creation time - it was only read during spawn, so the persisted `session.model` remained null even when the specialist defined a default model. (C) No path-traversal or workspace-path security guards on specialist file loading, allowing potential security issues.

**Expected:** Agents created without an explicit model get the settings-configured default resolved and persisted to `session.model` at creation time (specialist frontmatter model > model.workspaceOverrides > backgroundAgents.typeOverrides/defaultModel > model.default > CLI default). Specialist frontmatter model is parsed and persisted during agent creation. Path-traversal and workspace-path security guards prevent loading specialists from outside allowed directories.

**Status:** fixed ([intent-hq/intentd#261](https://github.com/intent-hq/intentd/pull/261) + [intent-hq/intentd#262](https://github.com/intent-hq/intentd/pull/262), 2026-07-20) — PR #261: added providerDefaults reading in model resolution chain with precedence specialist frontmatter model > model.workspaceOverrides > backgroundAgents.typeOverrides/defaultModel > model.default > CLI default; PR #262: specialist frontmatter model resolved and persisted at agent creation time, added path-traversal and workspace-path security guards for specialist file loading.

---

### STAB-129 (2026-07-20, area: cloudlands-fe settings hydration / background agents, severity: P1)

Background agent default model settings were not persisted or hydrated: changes to `backgroundAgents.defaultModel` and `backgroundAgents.typeOverrides` in the Settings UI were not saved to the daemon, and the UI did not hydrate these values on mount, always showing empty/default state even when the daemon had values configured.

**Repro:** Open Settings → Background Agents, change the default model or type-specific model overrides, close settings. Reopen Settings → Background Agents. Observed: the UI showed the default/empty state instead of the previously configured values. The daemon had the values (verified via settings.get RPC), but the FE never persisted changes or hydrated on mount.

**Root cause:** The Settings UI component for background agent models did not call the settings.update RPC when values changed, and did not call settings.get on mount to hydrate existing values from the daemon. The UI state was purely local and never synchronized with the daemon's settings store.

**Expected:** Changes to background agent default model and type overrides are persisted to the daemon via settings.update. The UI hydrates existing values from the daemon on mount via settings.get, so users see their previously configured values.

**Status:** fixed ([intent-hq/cloudlands-fe#175](https://github.com/intent-hq/cloudlands-fe/pull/175), 2026-07-20) — Added settings.update calls on value change and settings.get call on mount to persist and hydrate background agent model settings. All settings changes now persist across app restarts.

---

### STAB-125 (2026-07-19, area: intentd agent status wire, severity: P2)

Long in-flight turns are invisible to status/conversation consumers.

**Repro:** Start a turn that runs for a long time without persisting a message (e.g., a 24-minute busy turn doing many tool calls). Poll `agent.getStatus` / read the conversation while it runs. Observed: `lastActivity` stays pinned at the last persisted message, so a long busy turn is indistinguishable from a wedged agent — orchestrators concluded the agent was stuck and spawned duplicate agents for the same task.

**Expected:** Status/conversation consumers can distinguish an actively-working agent from a wedged one (e.g., `lastActivity` or an equivalent liveness signal advances while a turn is in flight).

**Status:** fixed ([intent-hq/intentd#264](https://github.com/intent-hq/intentd/pull/264), 2026-07-20) — Additive turn-liveness fields derived from the existing live-turn slot, gated on the busy claim: `turnInFlight: bool` and `lastStreamActivityAt` (RFC-3339, stamped at turn start and refreshed on every stream event) on `AgentLite` (`agent.get`/`agent.list`), the `agent.getConversation` result, and the `chat.subscribe` seq-0 snapshot flags overlay. A poller can now tell a long-but-alive turn (timestamp advancing) from a wedged agent (timestamp pinned). Caveat documented in PROTOCOL §5.5: the stamp only advances on stream traffic, so combine with `isWaitingOnTool` during long silent tool calls. Unit + UDS + WSS e2e coverage.

---

### STAB-127 (2026-07-19, area: intentd acp/prompt-injection, severity: P1)

(Planned as "STAB-111" in the injection-mechanism workstream; filed as STAB-127 because the STAB-111 ID was already taken by the dangling-tool_use session-resume issue.)

Assembled system prompt silently dropped for providers with no native system-prompt mechanism (`cortex`, `mock`): the daemon-side `assemble_system_prompt` output (behavior prompt + `<specialist_role>`) was persisted on the agent session but never delivered to the provider, so specialist agents ran with no role/behavior instructions at all.

**Repro:** Create a specialist agent (e.g. `specialistId: "implementor"`) on the cortex or mock provider and drive a turn. Observed: the outbound `session/prompt` contains only the per-turn role reminder and user content — the assembled system prompt (including the `<specialist_role>` section) never reaches the provider by any mechanism (no rules-file flag, no `_meta`, no env config, no prompt prepend).

**Root cause:** The `InjectionMechanism` registry ([intent-hq/intentd#253](https://github.com/intent-hq/intentd/pull/253)) tags `cortex` and `mock` as `FirstTurnPrepend`, but no code consumed that variant — the fallback delivery path was never implemented, so those providers' assembled prompts were dropped on the floor.

**Expected:** For `FirstTurnPrepend` providers, the assembled system prompt is prepended `<system>`-wrapped to the FIRST prompt of each fresh ACP session (before context/naming/reminder/user content), re-fires after session recreation, never repeats within a session, and is never double-injected for providers with a native mechanism.

**Status:** fixed ([intent-hq/intentd#263](https://github.com/intent-hq/intentd/pull/263), 2026-07-20) — `AgentManager` arms a per-agent prepend flag in `start_session` on fresh sessions (`session/new` brand-new or recreate; never `session/load` resume) for `FirstTurnPrepend` providers and consumes it in `build_turn_prompt` as the outermost `<system>` block. Transient store errors keep the flag armed for retry. Covered by unit tests (fire-once, recreate re-fire, native-mechanism no-arm, blank-prompt skip, ordering) and a WSS e2e (`e2e_wss_system_prompt_fallback.rs`) asserting the exact prompt text received by the mock provider on turns 1 and 2 via the new `MOCK_AGENT_PROMPT_LOG` fixture seam.

---

### STAB-124 (2026-07-19, area: intentd interrupt/abort persistence, severity: P1)

Interrupt mid-tool-call persists anonymous tool_use blocks (`name: ""`) that break conversation loading.

**Repro:** Send `agent.sendMessage` with `priority: "interrupt"` while an agent is mid-tool-call. Observed: the preempted assistant message is persisted with a leading `tool_use` block having `name: ""`, `input: {}`, `metadata.status: "error"`, followed by a `tool_result` containing "Process error: The operation was aborted". Conversations whose assistant message starts with such an anonymous errored tool_use fail to load in the FE.

**Evidence:** Observed on agent-695dcf49 (workspace happened-check) seq 2; a DB scan found the same `"name":""` pattern in 10+ agents across workspaces (e.g. agent-9cbcb5d7 seq 11/14, agent-4b81126c seq 6/12).

**Expected:** The tool name is known at tool-call start and must not be lost when the turn is aborted: the interrupted turn persists the real tool name, or the anonymous block is dropped/sanitized consistently with the STAB-111 dangling-tool_use policy ([intent-hq/intentd#250](https://github.com/intent-hq/intentd/pull/250)). Existing conversations containing the malformed pattern load without error.

**Status:** fixed ([intent-hq/intentd#260](https://github.com/intent-hq/intentd/pull/260), 2026-07-20) — Three-layer fix: (1) `AgentManager::interrupt()` drains buffered stale notifications after `session/cancel` (the cancelled child's title-less `tool_call_update` abort echoes no longer leak into the next turn's transcript); (2) `Transcript::record_tool` drops first-sight tool updates whose derived name is empty instead of fabricating an anonymous block; (3) `agent.getConversation` strips anonymous tool_use/tool_result pairs on read (non-destructive), so rows persisted by pre-fix daemons load cleanly — also covers the `chat.subscribe` snapshot. Regression tests at all three layers (WSS e2e with new `parkMidToolCall` mock behavior, Transcript unit test, read-path test).

---

### STAB-126 (2026-07-19, area: intentd agent manager / priority interrupt zero-output requeue, severity: P1)

When `agent.sendMessage` with `priority: "interrupt"` preempts an in-flight turn before ANY assistant output is produced, the preempted user message was silently lost — it existed in the transcript with no reply and was never requeued for processing after the interrupt completed.

**Repro:** Send a user message to an agent that parks before streaming any chunks (e.g., mock ACP provider with `parkBeforeFirstChunk: true`). Before any assistant content is emitted, send an interrupt with `priority: "interrupt"`. Observed: the interrupt processed successfully, but the original user message was dropped — it remained in the transcript as an unanswered user message with no assistant response, and it never re-appeared in the queue for processing after the interrupt completed.

**Root cause:** The interrupt codepath (`interrupt_send_message`) detected cancellable turns (handle + `acp_session_id` present), called `interrupt()` to cancel the ACP session, and immediately spawned the interrupt turn. For zero-output turns (parked before streaming any chunks), the preempted user message was neither persisted as completed (no assistant row exists) nor requeued — it was silently abandoned.

**Expected:** When an interrupt preempts a turn before any output, the preempted user message is requeued at the front of the queue (with `persisted: true` to skip duplicate transcript append, `requeuedAfterFailure: false` so the FE does not show a failure marker, and original attachments preserved via `image_blocks`/`file_blocks` extraction from transcript content). The queue-updated event is published so clients reflect the requeued state.

**Status:** fixed ([intent-hq/intentd#256](https://github.com/intent-hq/intentd/pull/256), 2026-07-19) — `interrupt_send_message` now checks `live_turn().blocks.is_empty()` to detect zero-output turns before calling `interrupt()`. If zero output, it fetches the last 10 transcript messages (bounded work), extracts the last user message with attachments, checks for any non-user messages after it (avoids re-running tool calls), and requeues the message at the front with `persisted: true`, `requeued_after_failure: false`. Regression tests `stab_114_interrupt_zero_output_requeues_message_over_wss` (zero-output path) and `stab_114_interrupt_after_streaming_no_requeue_over_wss` (inverse case) verify wire behavior.

---

### STAB-122 (2026-07-19, area: cloudlands-fe auto-update, severity: P1)

Packaged 2.0.6 app cannot download or install updates: the Install button is a no-op, downloads stall at "Preparing download…", and clicking the "Update available" toast does nothing.

**Repro:** Run the packaged 2.0.6 app with an update available on the feed. (1) Click the "Update available" toast — nothing happens (it dispatches the `downloadUpdate` trigger whose IPC channel was removed). (2) Open Settings → About and click Install — no-op. (3) Trigger a download — the UI remains stuck at "Preparing download…" indefinitely. At startup, the console logs "Auto-update is not available in this build" errors from `AutoUpdateMutationService` and `UserPreferencesBetaPersistenceService`.

**Root cause:** Regression from [intent-hq/cloudlands-fe#108](https://github.com/intent-hq/cloudlands-fe/pull/108), which removed auto-update download/install IPC channels still used by the renderer.

**Expected:** In packaged builds, the "Update available" toast and the Install button trigger download/install via functioning IPC channels; download progress advances past "Preparing download…"; no "Auto-update is not available in this build" errors at startup.

**Status:** fixed ([intent-hq/cloudlands-fe#172](https://github.com/intent-hq/cloudlands-fe/pull/172), 2026-07-20) — restored the auto-update download/install IPC channels removed in #108, rewiring the "Update available" toast, Settings → About Install button, and download progress flow

---

### STAB-123 (2026-07-19, area: cloudlands-fe storage, severity: P2)

`[SafeStorage]` warning at every startup: the localStorage key `intent:all-spaces-view-mode` holds the bare string `repo` instead of JSON, so `JSON.parse` fails on every launch.

**Repro:** Launch the app with `intent:all-spaces-view-mode` set to the bare string `repo` in localStorage (the value the app itself writes). Observed: a `[SafeStorage]` warn is logged on every launch because `JSON.parse("repo")` throws.

**Expected:** The value is written and read consistently (JSON-encoded, or the reader tolerates the legacy bare-string value); no `[SafeStorage]` warning on launch.

**Status:** fixed ([intent-hq/cloudlands-fe#171](https://github.com/intent-hq/cloudlands-fe/pull/171), 2026-07-19) — legacy raw-string `all-spaces-view-mode` values are migrated without triggering the SafeStorage warning

---

### STAB-120 (2026-07-19, area: intentd agent subscriptions / SUB-1 delegation-group dedupe, severity: P1)

Coordinator received duplicate completion notifications when sending coordination messages to children already covered by an undelivered after_all delegation group.

**Repro:** Coordinator delegates 2 tasks with `waitMode: after_all`, sends `agent.sendToTask` or `agent.sendMessage` follow-ups to each child (triggering SUB-1 auto-watch), both children complete. Observed: parent received an individual wake for child A, the aggregated "All 2 settled" wake, AND a duplicate individual wake for child B.

**Root cause:** `agent_watch_completion_for_sender_op` (SUB-1) did not check whether the (caller, target) pair was already in an undelivered `after_all` delegation group before registering an ungrouped oneShot watch. This mirrors the existing `child_in_undelivered_group` suppression used for `reportToParent` wakes but was missing for sender auto-watch.

**Expected:** When a coordinator sends coordination messages to children already covered by an `after_all` group, the parent receives exactly ONE aggregated wake (not individual wakes + aggregated).

**Status:** fixed ([intent-hq/intentd#258](https://github.com/intent-hq/intentd/pull/258), 2026-07-19) — Added SUB-1 delegation-group conflict suppression check in `agent_ops.rs`; added Services-level regression test + WSS e2e test covering the real wire flow and client-visible transcript delivery

---

### STAB-119 (2026-07-19, area: ios ConversationStore reconnect/resubscribe, severity: P2)

ConversationStoreIntegrationTests/connectionLossClearsLiveThenReconnectResubscribes failed intermittently when run with the full test suite.

**Repro:** Run the full iOS test suite. The test `connectionLossClearsLiveThenReconnectResubscribes` fails occasionally (passes in isolation, fails under load).

**Root cause:** Test-side race condition. The test used a fixed 100ms sleep after `simulateConnect()`, which was insufficient when running under load. The connection state change triggers `onReconnected()` asynchronously via a Combine publisher on the main actor. Under full test suite load, the async operations (parallel fetches + sequential subscriptions) took longer than 100ms to complete. Additionally, the initial polling fix checked `didCallMethod("chat.subscribe")`, but `FakeConnectionManager` appends to `requestLog` at the START of `request(_:)`, which races with handler registration in the product code.

**Expected:** Test waits for the subscription handler to be registered (post-completion signal) rather than relying on fixed sleep durations or request log entries.

**Status:** fixed ([intent-hq/ios#25](https://github.com/intent-hq/ios/pull/25), 2026-07-19) — Added `Task.yield()` to allow Combine publisher callbacks to run, then poll on `hasSubscriptionHandler(id:)` which signals that the subscribe operation completed and the handler was registered. Test now passes 15/15 runs deterministically.

---

### STAB-118 (2026-07-19, area: cloudlands-fe chat transcript loading state, severity: P2)

Opening an agent while intentd is slow to return the transcript briefly rendered the generic specialist welcome page (RegularAgentWelcome/ChiefChatEmptyState) instead of the loading skeleton, creating a jarring flash of incorrect content.

**Repro:** Open an agent conversation while the backend is slow to respond to the transcript fetch (e.g., during high load, slow disk I/O, or initial cold-start transcript hydration). Observed: the chat panel immediately rendered the specialist welcome page ("I'm ready to help..." / empty state) for a brief moment until the transcript loaded, then replaced it with the actual conversation history.

**Root cause:** `ChatPanel.svelte` gated the welcome state only on `session exists && messages.length === 0`, but transcript hydration ran asynchronously. During the hydration window, the session existed (agent record loaded) but messages were still empty (transcript fetch in flight), so the component incorrectly rendered the welcome page. The welcome page is semantically meant only for never-used sessions (`backendSessionId === null`), not for existing conversations whose transcript is still loading.

**Expected:** Skeleton loader displayed until transcript hydration completes or fails. Welcome page shown only for agents with `backendSessionId === null` (never started). If hydration of an existing conversation fails, skeleton is retained (not replaced with welcome).

**Status:** fixed ([intent-hq/cloudlands-fe#165](https://github.com/intent-hq/cloudlands-fe/pull/165), 2026-07-19) — `ChatPanel.svelte` now gates welcome rendering on `backendSessionId === null` (never-used session), and displays the loading skeleton during transcript hydration (new `isTranscriptLoading` selector) for existing conversations. Failed hydration of existing sessions retains the skeleton rather than showing welcome.

---

### STAB-117 (2026-07-19, area: intentd agent runtime + cloudlands-fe model picker, severity: P1)

Model selector inconsistency: picker showed Claude Fable 5 while the request actually went to Claude Sonnet 4.5; delegated agents ignored settings default models.

**Repro:** Observed: picker showed "Claude Fable 5" but the agent replied as Claude Sonnet 4.5. Delegated agents (implementor/verifier) created without an explicit model ignored the settings-configured default (model.default, model.workspaceOverrides, backgroundAgents.defaultModel, backgroundAgents.typeOverrides) and fell through to the CLI's own default.

**Root cause:** Three compounding bugs: (A) `agent.setModel` only persisted `session.model`. The model is applied only at spawn time (`ensure_started` → `resolve_spawn` → `--model`). When the agent's child process is alive, `ensure_started` short-circuits and returns the existing `acpSessionId`, so the running provider keeps its spawn-time model indefinitely. (B) For agents created without an explicit model (e.g., delegated verifier/implementor agents), `session.model` is null and intentd spawns the CLI without `--model` (CLI's own default applies). The FE footer picker falls back to `hydratedInputModel ?? agentModel` where `agentModel` defaults to the FE constant `DEFAULT_AGENT_MODEL`, displaying a model the agent is not actually using. (C) The settings keys `model.default`, `model.workspaceOverrides`, `backgroundAgents.defaultModel`, and `backgroundAgents.typeOverrides` are defined in the settings schema but never read by `agent_create_op` / `agent_delegate_op` / `resolve_spawn`. Delegated agents created without an explicit model ignore the settings-configured default entirely and fall through to the CLI's own default.

**Expected:** Changing the model on an agent with a live provider process takes effect on that agent's next turn. Agents created without an explicit model get the settings-configured default resolved and persisted to `session.model` at creation time (model.workspaceOverrides > backgroundAgents.typeOverrides/defaultModel > model.default > CLI default). The footer picker never displays a concrete model name for a session whose model is null; it shows the default-model option instead.

**Status:** fixed ([intent-hq/intentd#257](https://github.com/intent-hq/intentd/pull/257) + [intent-hq/cloudlands-fe#160](https://github.com/intent-hq/cloudlands-fe/pull/160), 2026-07-19) — intentd: respawn-on-setModel + creation-time settings-default resolution, 4 unit tests + WSS e2e test; cloudlands-fe: call-site fallbacks removed, AgentSession.model nullable end-to-end (type + Zod schema + stream-lifecycle wire coercion), all 7 review threads resolved.

---

### STAB-116 (2026-07-19, area: ios agent footer / getSubscriptions parsing, severity: P1)

iOS app crashed when parsing `agent.getSubscriptions` responses due to hard-coded `Subscription` decoder expecting fields the backend no longer returns.

**Repro:** Open iOS app, select a workspace with live subscriptions. Observed: app crashed with "No value associated with key CodingKeys(stringValue: \"lastProcessedAt\", intValue: nil)" when trying to display the agent footer.

**Root cause:** `Subscription.swift` defined `lastProcessedAt` and `errorState` as non-optional, but the backend never populated them (`intentd` subscription table only tracks `lastEventId`). `StreamingSubscription` likewise assumed `nextCursor` was always present. The iOS decoder crashed when these keys were absent in the JSON.

**Expected:** iOS app successfully parses `agent.getSubscriptions` responses and displays subscription state in the footer (or gracefully degrades if optional metadata is missing).

**Status:** fixed ([intent-hq/ios#24](https://github.com/intent-hq/ios/pull/24), 2026-07-19) — Made `Subscription.lastProcessedAt`, `errorState`, and `StreamingSubscription.nextCursor` optional. Added fallback display for missing values (shows "Never" for nil `lastProcessedAt`). Added unit tests for both present/absent decoder paths.

---

### STAB-114 (2026-07-19, area: intentd intent-store pool / event log, severity: P1)

SQLite pool contention under heavy concurrent write load caused reads to block for multiple seconds and occasional `database is locked` errors.

**Repro:** Run ~30 concurrent agents or other write-heavy operations (note edits, event-producing calls). Observed: lightweight read RPCs like `workspace.list` or `system.status` issued mid-load took multiple seconds to respond (pool acquire timeouts), and occasional `database is locked` errors surfaced to clients. The single shared pool blocked readers behind long-running write transactions.

**Root cause:** The daemon used a single SQLite connection pool shared by all read and write operations. Heavy concurrent write load (e.g., 30 agents editing notes simultaneously, batched event-log writes from the event bus) exhausted the pool, starving lightweight read operations. SQLite's single-writer MVCC model meant write transactions held exclusive locks, blocking readers. The event bus's synchronous write-per-event pattern amplified contention.

**Expected:** Concurrent writes do not starve reads. A lightweight read RPC (`workspace.list`) issued mid-heavy-write-load responds within a small bound (< 2s). No `database is locked` errors surface to clients.

**Status:** fixed ([intent-hq/intentd#259](https://github.com/intent-hq/intentd/pull/259), 2026-07-19) — Pool split into single-writer pool (size 1) and read pool (size 16), routing all mutations to the write pool and all reads to the read pool. Added periodic WAL checkpointing (every 60s) to prevent unbounded WAL growth. Batched event-log writes behind a dedicated writer task in the event bus (flushes every 20ms or 64 events). Made `agent:stream:chunk` events transient (broadcast-only, never persisted) to reduce write pressure. Stress e2e test `concurrent_writes_do_not_starve_reads` asserts 30 concurrent note writes + mid-load read < 2s.

---

### STAB-114 (2026-07-19, area: cloudlands-fe / NewSpaceModal repo defaulting, severity: P2)

After previously using a repo, opening the New Workspace modal (Cmd+N or sidebar +) showed 'Select a repository' instead of the most recent repo.

**Repro:** Open the New Workspace modal (Cmd+N or sidebar +) after previously using a repo. Observed: the repository selector shows 'Select a repository' instead of the most recent repo, forcing the user to manually re-select their working repo every time.

**Root cause:** NewSpaceModal never called `applyPrefill()` so stale workspace-prefill sessionStorage blocked last-repo hydration forever, and there was no fallback to recent repos when `lastSelectedRepo` was unset.

**Expected:** The repository selector defaults to the most recently used repo when opening the New Workspace modal.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/161, 2026-07-19)

---

### STAB-115 (2026-07-19, area: cloudlands-fe terminal footer / scripts hydration, severity: P2)

Switching workspaces briefly flashed "Detect Scripts" in the terminal footer before the detected script count appeared, creating a jarring UX and implying no scripts were detected when they were.

**Repro:** With script detection enabled, switch to a different workspace that has detected scripts (e.g., via the workspace switcher or by opening a new workspace from the Home screen). Observed: the terminal footer button briefly flashed "Detect Scripts" text for 100-500ms before updating to show "Scripts (N)" with the detected count, even though the workspace had N>0 scripts already detected and persisted.

**Root cause:** The "Detect Scripts" button visibility was gated only on `scriptEntries.length === 0` (checking whether any scripts exist in the store), without checking whether the scripts slice had finished hydrating for the newly-selected workspace. On workspace switch, the scripts slice starts with `initialized: false` and an empty `scriptEntries` array until the `workspaceMounted` fan-out's `scripts.list` RPC resolves. During this initialization window, the button showed "Detect Scripts" (the empty-state CTA) instead of waiting for hydration to complete.

**Expected:** The "Detect Scripts" button should only appear when the scripts slice is initialized AND the workspace has zero detected scripts. During initial hydration (scripts not yet loaded), the button should not render at all or should show a loading skeleton.

**Status:** fixed ([intent-hq/cloudlands-fe#162](https://github.com/intent-hq/cloudlands-fe/pull/162), 2026-07-19) — Gated button visibility on `initialized && scriptEntries.length === 0` in `TerminalFooter.svelte`, ensuring the button only appears after scripts have been loaded and confirmed empty. Scripts slice already tracked `initialized` state from the seeder.

---

### STAB-113 (2026-07-19, area: intentd/cloudlands-fe (queued message failure indicator), severity: P2)

After a terminal failure causes a queued message to be requeued, the UI showed no visual distinction between the retry attempt and the original entry — users could not tell which messages had failed and were being retried.

**Repro:** Start an agent with queued messages. Trigger a terminal failure (e.g., provider timeout, crash, idle timeout) that causes the agent to enter `error` status and requeue the in-flight message. Observed: the requeued message appeared in the queue list indistinguishable from the original — no visual indicator that it had failed and was being retried.

**Root cause:** The backend marked requeued-after-failure messages with the `persisted` flag (to include `requeuedAfterFailure: true` in the wire format), but the frontend did not render any visual indicator for this state.

**Expected:** Requeued messages display a retry indicator (rotate-right icon + "Failed — will retry" tooltip and screen-reader text) so users can see which messages failed and are being retried.

**Status:** fixed ([intent-hq/intentd#252](https://github.com/intent-hq/intentd/pull/252) + [intent-hq/cloudlands-fe#157](https://github.com/intent-hq/cloudlands-fe/pull/157), 2026-07-19) — backend: `QueuedMessage::to_value` emits `requeuedAfterFailure: true` when `persisted == true`; frontend: `QueuedMessageList.svelte` displays retry indicator with accessible screen-reader text (`sr-only` class) and `aria-hidden` decorative icon; regression test `test_queue_operations::terminal_failure_requeues_with_persisted_flag` verifies wire shape.

---

### STAB-112 (2026-07-19, area: intentd serve / WSS listener lifecycle, severity: P1)

WSS toggle ON but listener not running after daemon restart: when `server.wsApi.enabled` is persisted as `true`, the WSS listener does not actually start after a daemon restart, leaving the Settings toggle showing ON but "Show QR Code" displaying "WebSocket API server is not running" until the user toggles OFF→ON.

**Repro:** Enable WSS in the packaged app (Settings → WebSocket API → toggle ON), relaunch the app, click "Show QR Code". Observed: the toggle shows ON (setting reads `true`), but the toast says "WebSocket API server is not running" and no QR code is displayed. Existing mobile clients cannot connect until the user toggles the setting OFF and back ON.

**Root cause:** The packaged/sidecar app spawned the daemon with `intentd serve --listen uds` (`packages/cloudlands-fe/src/features/backend/main/intentd-sidecar.ts:360`). Before the fix, in `packages/intentd/crates/intentd/src/main.rs` (`cmd_serve`, ~lines 545–553), the WSS listener auto-started at boot ONLY for `--listen tcp/both`. Persisted `server.wsApi.enabled` was explicitly NOT honored at boot: "With --listen uds: listener does NOT auto-start at boot (regardless of persisted server.wsApi.enabled)". Result after any app relaunch: the setting read `true` (toggle showed ON), but no listener was bound. `server.pairingInfo` returned `port: null`, so the FE's `handleShowQr` (`WebSocketApiSettings.svelte:186-190`) showed "WebSocket API server is not running", and clients could not connect until the user toggled OFF→ON.

**Expected:** After app relaunch with WSS previously enabled: Settings shows toggle ON, "Show QR Code" renders a QR (no "not running" toast), and a client can connect to `wss://<host>:<port>/ws`.

**Status:** fixed ([intent-hq/intentd#251](https://github.com/intent-hq/intentd/pull/251), 2026-07-19) — Boot-time auto-start of the WSS listener when persisted `server.wsApi.enabled=true` under `--listen uds`, plus `Store::close()` WAL checkpoint so the setting survives restart.

---

### STAB-111 (2026-07-19, area: intentd agent manager / session resume, severity: P1)

(Referenced as STAB-108 in the intent-hq/intentd#250 PR title; renumbered due to ID collision.)

Agent becomes wedged in `error` status with an undrainable queue after a mid-turn provider failure, because persisted history contains dangling `tool_use` blocks (tool_use without corresponding tool_result), triggering provider rejection (`400 invalidArgument`) on every session resume attempt.

**Repro:** Trigger a mid-turn provider failure (e.g., timeout, 400 error) after a `tool_use` block is persisted but before the corresponding `tool_result` arrives. The agent flips to `error` status and requeues the user message. Every subsequent `agent.retry` or queue drain attempt resumes the ACP session with the malformed history and gets the same 400 rejection. The queue (multiple entries) can never drain; no recovery path exists.

**Root cause:** `history_xml::sanitize_messages_for_history` was keeping all `tool_use` blocks unconditionally during history sanitization, even those lacking matching `tool_result` blocks. On session resume, the malformed history (dangling tool_use) was rendered into the `<supervisor>` XML block and sent to the provider, which rejected it per protocol schema (tool_use blocks without results violate ACP contract).

**Expected:** After a mid-turn terminal provider failure, `agent.retry`/queue drain succeeds against the previously-failing transcript shape. History sanitization drops dangling `tool_use` blocks before rendering the `<supervisor>` block.

**Status:** fixed ([intent-hq/intentd#250](https://github.com/intent-hq/intentd/pull/250), 2026-07-19) — Modified `history_xml::sanitize_messages_for_history` to perform two-pass sanitization: first pass collects all tool_use IDs and valid tool_result IDs, second pass drops tool_use blocks lacking a matching valid tool_result. Regression test `sanitizes_dangling_tool_use_blocks` added. All 19 history_xml tests pass.

---

## Open Issues

### STAB-128 (2026-07-20, area: intentd/tests (WSS e2e), severity: P2)

E2e test `agent_message_event_emitted_for_queue_drain_and_wake_over_wss` (`crates/intentd/tests/e2e_wss_agent_lifecycle.rs`) times out under the full parallel `cargo test` suite but passes in isolation.

**Repro:** In `packages/intentd`, run the full `cargo test` (parallel, all targets): the test fails with a timeout (2/2 repro during Wave-1-era verification; also reproduced 2026-07-20). Run it in isolation — `cargo test --test e2e_wss_agent_lifecycle agent_message_event_emitted_for_queue_drain_and_wake_over_wss` — and it passes reliably (3/3, plus 2026-07-20 confirmation).

**Root cause:** Resource contention, not a delivery bug. The test's two event loops were the only call sites in the file using a 5s per-event silence window with panic-on-timeout (siblings use 30s + break-on-silence); under the parallel suite, mock-agent spawn plus the test's own 2000ms first-turn delay routinely exceeds 5s of event silence before the first `stream:end`. Introduced by [intent-hq/intentd#234](https://github.com/intent-hq/intentd/pull/234).

**Expected:** The test passes reliably under the full parallel suite, or its timing bounds account for contention from sibling e2e suites.

**Status:** fixed ([intent-hq/intentd#270](https://github.com/intent-hq/intentd/pull/270), 2026-07-20) — both event loops now use the sibling suites' 30s-per-event `wss_event_opt` deadline with break-on-silence and post-loop asserts carrying stream-end/elapsed diagnostics; 10/10 full-parallel-suite runs green.

---

### STAB-121 (2026-07-19, area: intentd CI / coverage-all test, severity: P2)

The `burst_above_threshold_collapses_to_directory_summaries` test in the coverage-all suite fails intermittently with event count mismatches.

**Repro:** In `packages/intentd`, run `cargo test --workspace` or `make test`, or observe the coverage-all CI job on main. The test `burst_above_threshold_collapses_to_directory_summaries` fails approximately 1-2 out of 5 runs with an assertion error: expected fewer than 80 events, got 98 (or similar counts exceeding the threshold).

**Root cause:** Product defect in the file-watcher debounce loop, not the test. `tokio::select!` ingests one raw notify event per iteration, so slow event publishes (e.g. SQLite INSERTs under coverage instrumentation, ~24 ms each) starve ingestion and spread per-path debounce deadlines; the burst decision in `flush_due` only counted paths due at a single flush instant, so a 150-file churn came due across many small flushes that never crossed the collapse threshold and was emitted as individual events.

**Expected:** The test passes reliably on all runs, or the event count assertions are made more lenient to account for legitimate variance in event emission patterns.

**Status:** fixed ([intentd#266](https://github.com/intent-hq/intentd/pull/266), 2026-07-20). Batch-drains the raw channel before each flush, bases the burst decision on the whole pending backlog, and adds a bounded 1 s burst cooldown so trailing waves of the same churn collapse too. Verified with deterministic `flush_due` regression tests plus 15 consecutive coverage-instrumented full-suite runs green.

---

### STAB-109 (2026-07-19, area: intentd/cloudlands-fe (agent error surfacing), severity: P1)

Agent failure text was held only in FE memory — after a daemon restart or FE reload, error sessions showed the generic "Agent spawn failed" fallback (follow-up to STAB-103).

**Repro:** Start an agent that fails spawn or mid-turn (e.g., a session/prompt idle-timeout, a provider crash, quota exceeded). Observe the chat error card displays the specific error text from `agent:failed` / `agent:idle` `stopReason` (e.g., "Session idle timeout after 60s"). Reload the FE (`Cmd-R`) or restart the daemon. Observed: the error card reverted to "Agent spawn failed" — the daemon did not persist the error text, and the FE did not hydrate it from `agent.list` / `agent.get`.

**Root cause:** The daemon stored agent status (`active`, `idle`, `error`, etc.) but did not persist the `stop_reason` (finish reason / error text) to the database. The `agent.list` / `agent.get` RPCs omitted `stopReason` from the AgentLite projection. The FE preserved `stopReason` from live events (`agent:failed`, `agent:idle`, `agent:status-changed`) but did not guard the hydration path (`bulkUpsertSessions` / `applySessionUpsert`) against older snapshots lacking the field — an FE reload would clobber the live-event `stopReason` with `undefined` from the snapshot.

**Expected:** The daemon persists `stop_reason` to the `agent_session` table, serves it on `agent.list` / `agent.get`, and emits it on set/clear `agent:status-changed` events. The FE hydrates `stopReason` from snapshots and preserves a fresher live-event value when an older snapshot omits the field. After a daemon restart or FE reload, error sessions retain the specific error text in the chat error card.

**Status:** fixed ([intent-hq/intentd#249](https://github.com/intent-hq/intentd/pull/249) + [intent-hq/cloudlands-fe#152](https://github.com/intent-hq/cloudlands-fe/pull/152), 2026-07-19) — daemon: migration 0045 adds `stop_reason TEXT` column to `agent_session`; `set_stop_reason` / `clear_stop_reason` in `agent_repo.rs` persist it; `agent.list` / `agent.get` serve it on AgentLite; `agent:status-changed` carries it as string when setting / JSON null when clearing / omitted when untouched; FE: `applySessionUpsert` guard preserves existing `stopReason` when incoming snapshot omits the key (mirrors Phase 1's `canonicalSessionUpdates` guard); 7 regression tests (4 slice-level, 3 live-client)

### STAB-110 (2026-07-19, area: cloudlands-fe sidebar / workspaces-seeder, severity: P2)

On refresh, the sidebar workspace list briefly shows a single workspace or "No workspaces yet" message until `workspace.list` resolves, creating a jarring flash of incorrect state.

**Repro:** Refresh the app (Cmd-R) while viewing a workspace. Observed: the sidebar workspaces list immediately renders with either a single workspace entry or the "No workspaces yet" placeholder for a brief moment (typically <500ms) until the `workspace.list` RPC completes and hydrates the full workspace collection. This flashing interim state creates a perception of lost data or broken state, even though it resolves automatically.

**Root cause:** The sidebar workspace list component (`WorkspaceList.svelte` or equivalent) was rendering the current Redux store state synchronously on mount without checking whether workspaces data was still loading. The workspace slice initialized with an empty or minimal collection, and the seeder (`workspaces-seeder.ts`) fired `workspace.list` asynchronously. The component bound to the store's transient loading state, showing whatever partial data existed before the RPC settled.

**Expected:** During the initial workspace list load (on app start or refresh), the sidebar should display an indeterminate loading skeleton or spinner instead of rendering a partial/empty workspace collection. Once `workspace.list` resolves, transition to the populated list. The loading state should be tracked in the workspace slice and consumed by the UI component.

**Status:** fixed ([intent-hq/cloudlands-fe#155](https://github.com/intent-hq/cloudlands-fe/pull/155) + [intent-hq/cloudlands-fe#156](https://github.com/intent-hq/cloudlands-fe/pull/156), 2026-07-19) — workspace slice tracks `isLoadingWorkspaceList` boolean; seeder sets it true before `workspace.list` and false on settle; sidebar component gates rendering on `!isLoadingWorkspaceList` and shows skeleton during load; error handling improved with user-facing toast and fallback to empty array

### STAB-108 (2026-07-18, area: intentd agent runtime / delegation group rehydration, severity: P1)

Delegation groups are lost or stale across daemon restart: a coordinator waiting on a delegation group with `after_all` wait mode can be stuck forever if the daemon restarts mid-delegation and a child completes before the group is rehydrated back into memory.

**Repro:** Coordinator `agent-c01bfe39` (workspace `agent-broken`) delegated child `agent-0d3b8877` with `after_all` wait mode; delegation group `2d6f0821-fae3-42b6-aef4-929b6213c607` was created and persisted (2026-07-17 12:27:23). The daemon restarted (~12:28:25, `make dev`). In-memory subscription state (watches + group copy) was wiped. Startup heal (`heal_stale_agent_sessions`) only fixes agent statuses; it does NOT rehydrate delegation groups. The child was restarted via a plain user message (not `agent.resolveInterrupted`), so `rehydrate_delegation_groups` never ran for the workspace. Child called `agent.reportToParent` (12:35:04) and went idle (12:35:14). Both `record_group_completion_pre_publish` and `deliver_completion_to_watches` only consult the in-memory registry — the group wasn't loaded, so the SQLite row's `completed_agent_ids` stayed `[]`. On 2026-07-18 a different agent resumed via the proper interrupted path, which rehydrated group `2d6f0821` (sealed, incomplete) back into memory. Rehydration does no reconciliation, so the group waits forever for an `agent:idle` that already happened — the FE shows the coordinator perpetually "waiting".

**Root cause:** Two distinct failures: (1) **No rehydration at daemon startup** — undelivered delegation groups are only rehydrated lazily on interrupted-agent resume/abandon paths (`agent_ops.rs:4078`, `agent_ops.rs:4203`). Completions recorded while a group is not in memory are silently lost. (2) **No reconciliation on rehydration** — `rehydrate_delegation_groups` (`agent_subscriptions.rs:743`) blindly loads groups as sealed without checking whether expected children are already idle/completed (with persisted `completion_report`). Side effect: a stale in-memory group makes `child_in_undelivered_group` return true for its children, suppressing future `reportToParent` immediate wakes.

**Expected:** A daemon restart mid-delegation can no longer strand a delegation group: after restart, groups are back in memory without requiring the resume path. A child that completed while its group was not in memory is reconciled on rehydration and the parent receives exactly one aggregated wake.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/248, 2026-07-19)

### STAB-104 (2026-07-18, area: intentd specialists / task status lifecycle, severity: P1)

Task notes got stuck in `review_required` status: when a delegated implementor called `report_to_parent`, the daemon transitioned the linked task note to `review_required`, but after a verifier approved the work, nothing marked the task `complete`.

**Repro:** Delegate a task to an implementor agent via `ws.agent.delegate({ taskNoteId: "abc-123", specialist: "implementor" })`. The implementor completes and calls `report_to_parent` with a summary. The daemon transitions the task note to `review_required` status (`transition_linked_task_to_review_required` in `packages/intentd/crates/intent-services/src/agent_ops.rs`). Delegate verification to a verifier agent. The verifier reviews the work, approves it (verdict: APPROVED), and calls `report_to_parent` with the approval verdict. Observed: the task note remains in `review_required` status indefinitely — it is never marked `complete`. Tasks accumulate stuck in "Review Requested" state.

**Root cause:** The daemon mechanically sets `review_required` via `report_to_parent` (the "TASK-B" writer in `agent_ops.rs`), but there was no automatic transition to `complete`. The bundled verifier prompt (`packages/intentd/crates/intent-services/resources/specialists/verifier.md`) instructed "Call `report_to_parent` with your verdict" but never told the verifier to mark verified task notes `complete` via `update_note_task_status`. The bundled coordinator prompt (`spec-writer.md`) similarly lacked completion instructions after verification. Verifiers already had tool access (confirmed in `tool_restrictions.rs`), so a prompt fix was sufficient.

**Expected:** After a verifier approves a task (verdict: APPROVED), the task note is marked `complete`. The bundled verifier prompt instructs marking each verified task note `complete` via `update_note_task_status` on an APPROVED verdict, and the coordinator backstops task completion after verification.

**Status:** fixed ([intent-hq/intentd#247](https://github.com/intent-hq/intentd/pull/247), 2026-07-18) — verifier.md updated to list `update_note_task_status` tool and instruct marking each verified task `complete` only on APPROVED verdicts; spec-writer.md updated to backstop completion after approved verification; rot-check unit test in specialists.rs fails if completion instruction removed from verifier prompt

### STAB-102 (2026-07-18, area: intentd e2e tests / local environment, severity: P2)

The `agent_message_event_emitted_for_queue_drain_and_wake_over_wss` e2e test fails intermittently when run in parallel (`make test`) on a developer machine with multiple live intentd daemons running, but passes consistently in isolation.

**Repro:** Run the intentd stack locally with multiple intentd daemons bound to various ports across different workspace directories, then execute `make test` in the monorepo. Observed: the full test suite (29 tests) sometimes fails with test hangs or timeouts. Running the same test in isolation 3 times: `cargo test --test e2e_wss_agent_lifecycle agent_message_event_emitted_for_queue_drain_and_wake_over_wss` passes 3/3 times with 6.17-6.35s duration. The intentd CI at the same commit (cc6dec88) was green, confirming this is a local environment issue, not a product bug.

**Root cause:** Similar to STAB-63, local intentd daemons interfere with e2e test hermeticity when tests run in parallel. The tests use ephemeral ports (`INTENTD_TCP_PORT=0`) but may still experience resource contention or event delivery interference from multiple background daemons detected via `pgrep -fl intentd`.

**Expected:** E2e tests should be hermetic and pass reliably on developer machines regardless of local daemon state, or the test suite should detect and skip tests when hermeticity cannot be guaranteed.

**Status:** open

### STAB-86 (2026-07-17, area: cloudlands-fe / workspace delete, severity: P1)

Home-screen workspace delete did not remove spaces from the visible list, requiring a full app refresh (Cmd-R), and spammed logs with `resolveWorkspaceRoot` / `note.list spec reseed failed` errors for deleted workspaces.

**Repro:** Before the fix: create a disposable workspace, delete it from the Home screen. Observed: (1) the deleted workspace remained visible in the workspaces list until Cmd-R refresh, and (2) `make dev` logs filled with paired errors per deleted workspace: main-process `[WorkspaceConfig] resolveWorkspaceRoot: workspace "<slug>" not found in any location` (from `user-activity.ipc.ts:51` calling `WorkspaceConfig.resolveWorkspaceRoot`) and daemon `WARN intent_services: note.list spec reseed failed; continuing with best-effort list workspace_id=<slug> error=internal error: insert note failed: error returned from database: (code: 787) FOREIGN KEY constraint failed`.

**Root cause:** When `workspace:deleted` event arrived from daemon, `daemon-events-bridge.ts` dispatched `workspaceDeleted(wsId, agentIds)`. Other slices (`workspace-agents`, `chat-state`, `agent-session`) handled this action and purged their workspace-scoped state, BUT the `workspace-slice` reducer had NO case for `workspaceDeleted`. The workspace entity stayed in `state.workspace.workspaces` collection, and the FE continued to attempt operations (user-activity IPC, note subscriptions) on the deleted workspace.

**Expected:** After clicking Delete on the Home screen OR receiving an external `workspace:deleted` event, the space must disappear from the list immediately and permanently. Zero occurrences of `resolveWorkspaceRoot` / `note.list spec reseed failed` log lines for deleted workspaces.

**Status:** fixed ([intent-hq/cloudlands-fe#133](https://github.com/intent-hq/cloudlands-fe/pull/133), 2026-07-17) — workspace-slice.ts now handles the `workspaceDeleted` action: removes the workspace from the collection, clears `activeWorkspaceId` if it matched, and purges `pendingDeletions` / `pendingArchives` / `pendingCreations` / `recency.lastViewedAt` entries for the deleted id. Downstream: user-activity IPC and note subscriptions stop firing for the ghost workspace, eliminating `resolveWorkspaceRoot` and `note.list spec reseed failed` log spam.

### STAB-85 (2026-07-17, area: intentd CI / e2e tests, severity: P1)

The `completion_report_cleared_when_new_turn_begins_over_wss` e2e test hung indefinitely in CI, timing out every coverage-e2e and coverage-all job at 30 minutes.

**Repro:** PR #221 added the `completion_report_cleared_when_new_turn_begins_over_wss` test to `crates/intentd/tests/e2e_wss_agent_lifecycle.rs`. The test delegated a mock child agent, waited for `agent:created` to retrieve the child's ID, then sent a new message to the parent and awaited `agent:updated` with `completionReportCleared: true`. The test hung from 2026-07-17 10:16 UTC onward because: (1) it called `wss_event(rx, "agent:created").await` expecting a `parentAgentId` field that `agent:created` events never carry (the field exists only on `agent:updated`), so the test retrieved `null` for the child ID and subsequent filters matched nothing, and (2) the `wss_event` helper's 30-second timeout reset on every WebSocket heartbeat Ping frame, allowing the hung wait to extend indefinitely. Every coverage-e2e and coverage-all CI run timed out at GitHub Actions' 30-minute job limit from that point forward, blocking all PRs and main pushes.

**Expected:** E2e tests use deadline-bounded event waits that fail fast when expected events never arrive. The `wss_event_opt` helper (with a single overall deadline, no heartbeat resets) should be used for waits that may legitimately time out, and child agent IDs should be retrieved from the parent agent's `waitingForAgentIds` field rather than expecting a `parentAgentId` on `agent:created`.

**Status:** fixed ([intent-hq/intentd#227](https://github.com/intent-hq/intentd/pull/227), 2026-07-17) — test switched to `wss_event_opt` for deadline-bounded waits and retrieves child ID from parent's `waitingForAgentIds`; added nextest slow-timeout guard (~5 min) to catch similar hangs; intentd main ruleset now requires coverage-e2e and coverage-all as merge-queue checks to prevent merging PRs with failing coverage jobs

### STAB-84 (2026-07-17, area: intentd workspace RPC / setup scripts, severity: P1)

The `workspace.saveSetupScript` RPC contract changed in PR #223 to require a repository path, breaking the `uds_integration::uds_slice_end_to_end` test on main.

**Repro:** PR #223 ("feat: make .intent/config.json sole source of truth for setup scripts", merged 2026-07-17 12:49 UTC) changed `workspace.saveSetupScript` to return InvalidParams when called without a repository path, aligning the RPC with the new config.json-backed persistence model. The `uds_slice_end_to_end` integration test in `crates/intentd/tests/uds_integration.rs` (lines 331+) asserted the old §5.25 contract: empty default, save returns stored record with `generatedBy: "user"`, get round-trips. After #223 merged, `saveSetupScript` returned `Null` (InvalidParams) instead of the expected stored script, causing the test to fail deterministically on main. The regression went undetected because coverage-e2e and coverage-all jobs were timing out at 30 minutes (STAB-85) and were not required merge-queue checks at the time #223 merged.

**Expected:** Tests align with the current RPC contract. When `saveSetupScript` is called without a repository path in the new config.json model, the RPC should either return InvalidParams (as implemented in #223) or persist to a workspace-scoped default location, and the integration test assertions should match the implemented behavior.

**Status:** fixed ([intent-hq/intentd#227](https://github.com/intent-hq/intentd/pull/227), 2026-07-17) — test updated to expect InvalidParams error when saving setup scripts without repository path; intentd main ruleset now requires coverage-e2e and coverage-all as merge-queue checks to prevent similar regressions

### STAB-63 (2026-07-17, area: intentd doctor / e2e_core_cli_commands test, severity: P2)

The `doctor_checks_data_dir_and_migrations` test fails deterministically when a live intentd daemon is running.

**Repro:** Run the intentd stack locally with a daemon bound to WSS port 5181, then execute `make test` or `cargo test -p intentd --test e2e_core_cli_commands doctor_checks_data_dir_and_migrations`. Observed while dogfooding: `intentd doctor` exits with code 1 due to `[FAIL] WSS port 5181 not bindable: Address already in use (os error 48)` whenever a live intentd daemon holds the port (always true on a dogfooding machine). All other doctor checks pass. The test in `crates/intentd/tests/e2e_core_cli_commands.rs` asserts that doctor exits with success, so the whole test suite fails on any machine running the stack. Passes in CI where no daemon runs.

**Expected:** The test should pass on developer machines running the intentd stack. Suggested direction: make the doctor port-bind check non-fatal (warning instead of failure) or modify the test to use an ephemeral/configurable port for the check.

**Note:** This is distinct from STAB-62 (intermittent WSS integration test port-bind flake) but related in theme.

**Status:** open

### STAB-62 (2026-07-17, area: intentd tests / wss port binding, severity: P2)

Intermittent WSS integration test failure due to port bind conflict.

**Repro:** Observed once locally during `cargo test --workspace` on the flaky-test stabilization branch (2026-07-17). A WSS integration test failed with a port bind conflict error, suggesting that the test's WSS listener tried to bind to a port already in use by another test or process. The failure was intermittent and did not reproduce on subsequent runs. The specific test name was not captured, but the failure occurred during the full workspace test suite run (not during isolated test execution).

**Expected:** All WSS integration tests should reliably acquire unique ports without conflicts, either through dynamic port allocation or proper test isolation/cleanup.

**Status:** open (needs reproduction and root cause analysis)

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

### STAB-107 (2026-07-18, area: cloudlands-fe / CI + live client seam, severity: P1)

[intent-hq/cloudlands-fe#148](https://github.com/intent-hq/cloudlands-fe/pull/148) (commit bb588763, "120s timeout override for workspace.delete") changed runMutation/runMutationWithId to forward a third options arg to backendRequest, breaking arity-strict toHaveBeenCalledWith(method, params) assertions in the live-notes/live-comments/live-settings/live-files/live-git client test suites; went unnoticed because cloudlands-fe main-push CI runs only CodeQL (unit tests run on PRs only).

**Repro:** Before the fix: [intent-hq/cloudlands-fe#148](https://github.com/intent-hq/cloudlands-fe/pull/148) added a `timeout?: number` field to `backendRequest`'s third options arg to support the 120s override for bulk workspace.delete. `runMutation` and `runMutationWithId` were updated to forward a third `{ timeout }` object when provided. However, the live-client unit tests (`live-notes.test.ts`, `live-comments.test.ts`, `live-settings.test.ts`, `live-files.test.ts`, `live-git.test.ts`) used strict 2-arg assertions: `expect(backendRequest).toHaveBeenCalledWith(method, params)`. After bb588763, every call to `runMutation` forwarded `{}` as the third arg (even when `timeout` was undefined), causing all these assertions to fail with "Expected: 2 arguments, Received: 3 arguments". The test suite went from 100% pass to 28 failures across 5 suites. The breakage went undetected on main because the cloudlands-fe `.github/workflows/intent-pr.yml` workflow runs only on `pull_request` events, not on `push` to main — unit tests are never re-run after PR merge. Main-push CI (CodeQL analysis) does not run unit tests.

**Root cause:** `runMutation` / `runMutationWithId` forwarded the third `options` object unconditionally (as `{}` when no timeout was provided) instead of omitting it when empty. Arity-strict `toHaveBeenCalledWith` assertions failed because they expected exactly 2 arguments. The regression landed on main undetected because cloudlands-fe's `.github/workflows/intent-pr.yml` is gated to `pull_request` only — main-push CI runs only CodeQL, which does not execute unit tests.

**Expected:** `runMutation` / `runMutationWithId` forward the third options arg only when it contains actual options (non-empty object), preserving 2-arg call shape when no options are present. Unit test assertions remain valid for both 2-arg and 3-arg call shapes.

**Status:** fixed ([intent-hq/cloudlands-fe#150](https://github.com/intent-hq/cloudlands-fe/pull/150), 2026-07-18)

### STAB-106 (2026-07-18, area: cloudlands-fe / renderer store persistence, severity: P2)

Home-screen repo selector does not default to the most recent repository; workspace-initializer persistence never re-homed after saga removal.

**Repro:** Before the fix: Open the Cloudlands home screen, create a workspace from repo A, then create another workspace from repo B. Close the app, reopen, and return to the home screen. Observed: the repo selector dropdown defaults to "Select a repository" (no selection) instead of repo B. Expected: the selector should default to the most recent repository (repo B).

**Root cause:** The workspace-initializer component (`WorkspaceInitializer.svelte`) previously persisted its form state (selected repo, branch, prompt text) via a Redux-observable saga (`workspace-initializer-saga.ts`). The saga subscribed to form-state actions and wrote to an electron-store `workspace-initializer` bag. Commit 95d908a2 ("refactor: remove redux-observable") deleted the saga file and all persistence logic, but the component continued to read from the now-static electron-store entry. New form interactions (repo selection, branch typing, prompt edits) updated local component state and Redux store state but never persisted, so the electron-store bag stayed frozen at its last pre-saga-removal value. On app restart, the component rehydrated from the stale electron-store entry, discarding all session state. The repo selector defaulted to no selection (or the stale repo) instead of the most recent repository.

**Expected:** Workspace-initializer form state (selected repo ID, branch, prompt) persists across app restarts and defaults to the most recent repository.

**Status:** fixed ([intent-hq/cloudlands-fe#149](https://github.com/intent-hq/cloudlands-fe/pull/149), [intent-hq/intentd#246](https://github.com/intent-hq/intentd/pull/246), 2026-07-18) — workspace-initializer state promoted to daemon-owned `workspaceInitializer.state` setting; FE reads/writes via `settings.get`/`settings.update`; repo selector defaults to most recent repository on app launch

### STAB-105 (2026-07-18, area: intentd workspace.delete + cloudlands-fe bulk operations, severity: P1)

Bulk deletion of archived workspaces timed out client-side during heavy cleanup, despite daemon eventually succeeding.

**Repro:** Before the fix: accumulate 15+ archived workspaces (each 1–4 GB), select all on the Home screen, click Delete. Observed: after 30–60 seconds the FE showed "Operation timed out" errors for most workspaces (typically all but the first 2–3), but the daemon logs confirmed all deletes eventually succeeded — the `workspace:deleted` events arrived 2–10 minutes later as the background cleanup finished.

**Root cause:** The FE fired parallel `workspace.delete` calls with a 30-second IPC timeout. The daemon serialized multi-GB `remove_dir_all` operations under a per-repository lock to prevent race conditions with concurrent deletes/recreations. Later deletes in the batch queued behind earlier ones, exceeding the 30s client timeout even though the daemon completed them successfully in the background. The polling implementor pushed a follow-up commit (445b8b9) that updated intentd delete tests to poll for the now-asynchronous filesystem cleanup, confirming the background task model works as designed.

**Expected:** Bulk delete of large archived workspaces completes without client-side timeouts. The daemon returns success as soon as the database row is deleted and the event is emitted (fast-ack), and the FE waits long enough for the initial response.

**Status:** fixed ([intent-hq/intentd#245](https://github.com/intent-hq/intentd/pull/245), [intent-hq/cloudlands-fe#148](https://github.com/intent-hq/cloudlands-fe/pull/148), 2026-07-18) — intentd now returns immediately after database delete + event emission, running filesystem cleanup in a background task under per-repo lock; cloudlands-fe raised `workspace.delete` timeout to 120s for bulk operations

### STAB-103 (2026-07-18, area: cloudlands-fe chat error card / agent-session state, severity: P2)

Agent turn failures rendered as generic "Agent spawn failed" instead of the daemon's `agent:failed` error text (observed with a session/prompt idle-timeout failure on 2026-07-18).

**Repro:** Before the fix: trigger an agent turn failure that emits `agent:failed` with an error message (e.g., session idle timeout). The chat error card displayed "Agent spawn failed" instead of the actual error text from the daemon event.

**Root cause:** Two issues: (1) `handleAgentFailedStream` in `daemon-events-bridge.ts` early-returned before dispatching `chatSendFailed` when `streamsByAgent` had no state for the agent (occurred when agent spawn failed before any streaming started, e.g., before `agent:stream:chunk` arrived); (2) `canonicalSessionUpdates` in `agent-session-slice.ts` unconditionally set `updates.stopReason = fields.stopReason` even when `fields.stopReason` was `undefined`, so the trailing `agent:status-changed` event (which arrived milliseconds after `agent:failed` without its own `stopReason` field) overwrote the error text with `undefined`.

**Expected:** Chat error card displays the daemon's actual error text from `agent:failed` events.

**Status:** fixed ([intent-hq/cloudlands-fe#147](https://github.com/intent-hq/cloudlands-fe/pull/147), 2026-07-18)

### STAB-101 (2026-07-17, area: intentd + cloudlands-fe / user message events, severity: P1)

Dequeued and agent-to-agent user messages did not emit `agent:message` workspace events, preventing live clients from converging on transcript state for user messages appended by daemon-side operations (queue drain, wake delivery).

**Repro:** Before the fix: (1) Send a message to a busy agent (it queues), wait for the agent to finish its current turn. The queued message is drained and persisted by the daemon (`persist_user` in `agent_manager.rs`), but no `agent:message` event is published. The FE chat continues to show the message as queued/pending until refresh. (2) Call `agent.wakeOrCreate` to wake an idle task agent. The daemon delivers the wake message via `deliver_wake_message` runtime path and persists the user row, but again no `agent:message` event is published. The FE never sees the user message appear in the transcript.

**Root cause:** The daemon emitted `agent:message` events only for store-only fallback paths (`agent_send_message_op`, `agent_force_message_op`) when no `AgentManager` runtime was attached. When an `AgentManager` WAS attached, the runtime `agent.sendMessage` path returned the message ID immediately for FE optimistic rendering and did NOT emit an event. However, the queue-drain (`persist_user`) and wake-delivery (`deliver_wake_message`) runtime paths also skipped event emission, leaving no mechanism for the FE to learn about daemon-persisted user messages. The cloudlands-fe transcript subscribed to `agent:message` events but never received them for these paths, causing the UI to diverge from the persisted transcript.

**Expected:** All daemon-side user-row appends (send, force, queue drain, wake delivery) emit `agent:message` workspace events with the persisted message row ID so live clients can converge on transcript state.

**Status:** fixed ([intent-hq/intentd#234](https://github.com/intent-hq/intentd/pull/234), [intent-hq/cloudlands-fe#135](https://github.com/intent-hq/cloudlands-fe/pull/135), 2026-07-17) — intentd now emits `agent:message` from queue-drain and wake-delivery paths with persisted row IDs; cloudlands-fe transcript subscriber processes these events to update the UI

### STAB-92 (2026-07-18, area: intentd CI / intent-transport TLS test, severity: P2)

Flaky TLS fingerprint test failure in `intent-transport/src/tls/tests.rs::test_client_cert_fingerprint_verification_rejects_wrong_fingerprint`.

**Repro:** Run `cargo test --workspace` under parallelism (e.g., CI default or local with high CPU count). The test intermittently fails with assertion error when the client cert fingerprint check accepts a previously-rejected wrong fingerprint, suggesting cached TLS state is leaking between test runs.

**Root cause:** OpenSSL caches certificate validation state globally across all tests. The test creates a TLS client that intentionally uses a mismatched fingerprint to verify rejection, then verifies acceptance with the correct fingerprint. When tests run in parallel or sequentially without clearing the cache, OpenSSL reuses cached validation results from prior test runs, causing the fingerprint check to pass when it should fail or vice versa.

**Expected:** Each TLS test run clears OpenSSL's internal cert cache before setting up the client connection, ensuring test hermiticity regardless of execution order or parallelism.

**Status:** fixed ([intent-hq/intentd#243](https://github.com/intent-hq/intentd/pull/243), 2026-07-18) — added `SSL_CTX_flush_sessions` call to clear cert cache before each test client setup

### STAB-87 (2026-07-17, area: cloudlands-fe, severity: P1)

Re-entering a streaming conversation shows no deltas until the next tool call (or later).

**Repro:** Start a conversation with a long-running agent task (e.g., multi-file edit or research). While the agent is mid-turn and streaming partial assistant text, navigate away from the chat (switch to another workspace or panel). Navigate back to the streaming chat. Observed: the partial assistant message is blank until the agent emits the next tool call or completes the turn. Expected: the partial text appears immediately and continues growing with each delta.

**Root cause (traced):** Chat hydration (`chat-read-service.ts` → `loadChatTranscript`) pages through `agent.getConversation` only. On the daemon, the in-flight partial assistant message (live-turn slot, CS-0 D5) is merged **only** into the `chat.subscribe` seq-0 snapshot (`chat_snapshot` in `intent-transport/src/subscriptions.rs`) — `agent.getConversation` returns persisted messages only. The FE used to hydrate via `chat.subscribeSnapshot` but switched to `getConversation` paging (to fix >50-message truncation), silently losing the live-turn merge. Two compounding effects: (1) Hydration wipes the in-flight placeholder (the events bridge keeps the transcript growing in Redux even while the chat is closed, but `loadChatTranscript` replaces `messages` with the persisted-only page — dropping the in-flight assistant message), and (2) after an app restart mid-turn, the bridge accumulator (`streamsByAgent`) restarts empty and only holds the chunk tail; `resolveStreamContentBlocks`' `hasActiveStreamRegression` correctly rejects the shorter/poorer candidate versus the fuller hydrated partial — so deltas stay invisible until the candidate outgrows it (typically at the next tool call, which adds blocks).

**Status:** fixed ([intent-hq/cloudlands-fe#132](https://github.com/intent-hq/cloudlands-fe/pull/132), 2026-07-17) — `chat-read-service.ts` now merges `chat.subscribeSnapshot` in-flight message into `getConversation` hydration; `daemon-events-bridge.ts` seeds stream accumulator from snapshot (`seedStreamFromSnapshot`) so regression guard passes after app restart mid-turn

### STAB-86 (2026-07-17, area: cloudlands-fe, severity: P1)

Interrupt-send (⌘Enter while agent is mid-turn) stalls the session: stuck in "Thinking", message never appears, renderer state wedged.

**Repro:** Start a conversation and send a message that triggers a long-running agent task. While the agent is mid-turn (visible "Thinking" or streaming partial response), type a new message and press ⌘Enter (force-submit / interrupt). Observed: the UI switches to "Thinking" for the new message but never shows the message in the transcript. The session is wedged — subsequent messages show status ticks but no transcript. Restarting the app (Electron relaunch) recovers the UI but the interrupted message is lost. Restarting only intentd doesn't help because the renderer's wedged state persists (restarting intentd doesn't reset the renderer). Expected: the new message should interrupt the old turn, appear immediately in the transcript, and stream normally.

**Root cause (traced):** The FE renderer is daemon-bridged via the mock IPC router. `chat-send-service.ts` and `agent-stream-lifecycle.ts` correctly thread `priority: "interrupt"` all the way into the `STREAM_MESSAGE` invoke (and the zod schema `AgentBackendStreamMessageSchema` allows it), **but the bridge handler in `src/store/renderer/seeders/agent-ipc-bridge-seeder.ts` (STREAM_MESSAGE → `agent.sendMessage`) never forwards `priority`** — it forwards messageId/imageBlocks/fileBlocks/model/messageMetadata/contextReferences/noteIds/stdinContext/app-ID trio only. Consequences, matching the reported symptoms exactly: (1) Daemon receives a plain `agent.sendMessage` while the turn is in flight → `try_begin` fails → the message is **silently auto-queued** (`{ success: true, queued: true }`) instead of preempting (`interrupt_send_message` is never invoked). (2) The FE only checks `response.success` — `queued: true` is ignored on this path. It has already torn down the old stream handler and registered a fresh one for a new assistant placeholder, so the old turn's chunks/complete are treated as stale and skipped → UI wedges in "Thinking". (3) The daemon queue is in-memory, so restarting intentd **loses the queued message**. (4) The renderer's stream-registry/session state stays wedged (restarting intentd doesn't reset the renderer), so subsequent sends show status ticks but no transcript.

**Status:** fixed ([intent-hq/cloudlands-fe#132](https://github.com/intent-hq/cloudlands-fe/pull/132), 2026-07-17) — `agent-ipc-bridge-seeder.ts` now forwards `priority: "interrupt"` through STREAM_MESSAGE → agent.sendMessage; `agent-stream-lifecycle.ts` handles `{ success: true, queued: true }` responses (cleanup + queue seeding) to avoid wedged placeholders

### STAB-83 (2026-07-17, area: cloudlands-fe notification settings persistence, severity: P1)

Notification settings (enabled, soundEnabled, soundOnlyWhenUnfocused, volume) were not persisted to the daemon, causing them to be lost on app relaunch.

**Repro:** Before the fix: open Settings → Notifications in the app, toggle any notification setting (e.g., disable notifications entirely), then quit and relaunch the app. Observe: the setting has reset to the default value (notifications re-enabled), not the value you chose.

**Root cause:** The `user-preferences-notification-persistence-service` middleware (added in PR #116) called `invoke('settings:set', { key: 'notificationSettings', ... })`, writing the entire settings bag to a retired `localStorage` key (`legacy-settings:notificationSettings`) that is never read on boot. The correct protocol is `settings.update` with individual `notifications.*` paths (`notifications.enabled`, `notifications.soundEnabled`, `notifications.soundOnlyWhenUnfocused`, `notifications.volume`) that intentd persists in its settings catalog and surfaces to both main (for notification behavior) and renderer (for UI state). Additionally, the boot-time hydration dispatched actions that immediately triggered the persistence logic, causing echo-writes (the FE wrote back the values it just read from the daemon). Test mocks also simulated constant state (not evolving post-reducer state) and used real timers instead of fake timers.

**Expected:** Notification toggles persist via `settings.update` to the daemon's canonical `notifications.*` paths. Settings survive app relaunch because the daemon catalog is durable. Hydration-dispatched actions are suppressed from persistence to prevent echo-writes. Tests use fake timers and evolving state mocks.

**Status:** fixed ([intent-hq/cloudlands-fe#127](https://github.com/intent-hq/cloudlands-fe/pull/127), [intent-hq/cloudlands-fe#129](https://github.com/intent-hq/cloudlands-fe/pull/129), [intent-hq/cloudlands-fe#130](https://github.com/intent-hq/cloudlands-fe/pull/130), 2026-07-17)

### STAB-82 (2026-07-17, area: intentd agent resumption / graceful shutdown, severity: P1)

Agents mid-turn during graceful shutdown were settled to `RuntimeIdle` instead of being captured as interrupted, so the resumption modal never appeared after a clean restart.

**Repro:** Start intentd, spawn an agent and let it run a turn, then quit intentd gracefully via `SIGINT` or `SIGTERM` (normal quit, not a crash). Expected: after restart, `agent.listInterrupted` returns the agent and the FE shows the resumption modal. Actual before fix: `agent.listInterrupted` returned an empty list because the `signal_handler_task` settled all active agent sessions to `RuntimeIdle` without capturing them as interrupted records first. The heal sweep on next startup thus saw only `RuntimeIdle` rows (not `active`/`processing`/`waiting`) and never created interruption records. The resumption modal only appeared after crash scenarios (where the signal handler never ran).

**Expected:** Graceful shutdown (`SIGINT`/`SIGTERM`) captures in-flight agents (`active`, `processing`, `waiting` statuses) as interrupted records before settling them to `RuntimeIdle`, exactly like the crash-recovery heal path. The resumption modal appears after both clean and unclean shutdowns whenever agents were mid-turn.

**Status:** fixed ([intent-hq/intentd#219](https://github.com/intent-hq/intentd/pull/219), 2026-07-17)

### STAB-79 (2026-07-17, area: cloudlands-fe sidebar status grouping / workspace activity, severity: P1)

Sidebar showed every workspace as Idle even with working agents; workspaces with running agents appeared under Complete/PR sections; running agent icons did not clear when all agents went idle.

**Repro:** Before the fix, the sidebar displayed incorrect workspace statuses due to four related issues: (1) Workspace.activity field was not wired from the daemon (intentd emitted workspace:activity-changed events but the FE did not subscribe or merge them), so the FE had no knowledge of when workspaces transitioned between Idle and AgentRunning states. (2) The sidebar grouping logic did not consider running agents when determining display status — workspaces with active agents could be grouped under "Complete" or "Ready for PR" based solely on their base status (e.g., pr_merged), ignoring ongoing agent work. (3) WorkspaceCard running agent avatars were controlled only by activeStreamsTracker and cached Redux agent state, which could remain stale after all agents went idle, leaving running-state icons visible indefinitely even when workspace.activity === 'idle'. (4) Edge-triggered workspace:activity-changed events could be missed (e.g., coordinator-only workspaces where the 0→1 agent transition fired before FE subscription or entity seeding), leaving workspaces stuck at Idle even while agents were mid-turn.

**Expected:** Sidebar accurately reflects workspace activity: workspaces with running agents always appear under "In Progress" regardless of PR/merge status, and workspace cards show no running agent avatars when workspace.activity === 'idle'. Activity reconciliation detects missed edges via agent-implying events and refetches workspace.activity when FE state is stale.

**Status:** fixed ([intent-hq/cloudlands-fe#123](https://github.com/intent-hq/cloudlands-fe/pull/123), [intent-hq/cloudlands-fe#124](https://github.com/intent-hq/cloudlands-fe/pull/124), [intent-hq/cloudlands-fe#128](https://github.com/intent-hq/cloudlands-fe/pull/128), 2026-07-17)

### STAB-81 (2026-07-17, area: cloudlands-fe / settings auto-update, severity: P1)

Beta-updates toggle in Settings unresponsive when clicked. Toggle does not reflect actual update channel on app boot in real (non-mock) mode.

**Repro:** Launch app in real mode (not mock). Open Settings → About → Beta Updates. Click the beta-updates toggle. Observe: toggle does not flip, no channel switch occurs. Relaunch app. Observe: toggle shows wrong state (doesn't match actual channel).

**Root cause:** (1) Middleware called dead `invoke('settings:set')` with no main-process handler — the IPC call silently failed. (2) Real-mode boot hydration missing — only mock seeder synced Redux `betaUpdatesEnabled` with main-process channel from `autoUpdateClient.getState()`. The middleware also called `autoUpdateClient.setChannel()` which already persisted via local-prefs, making the dead settings:set call redundant.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/125, 2026-07-17)

### STAB-80 (2026-07-17, area: intentd intent-acp / workspace_api MCP, severity: P1)

Chief of Staff agent broken: cannot enumerate workspaces or access app-level operations.

**Repro:** Create a Chief of Staff workspace agent and try to use it. The agent reports that the `ws.app` namespace (which provides `ws.app.workspaces.list`, `ws.app.agents.list`, UI navigation, and proposal management) is not registered in the session. Only the single-workspace API surface is available, and since the Chief workspace has no repository attached, there's no way for the agent to enumerate or manage user workspaces.

**Root cause:** The `ws.app.*` MCP tool bindings were not registered in the daemon's MCP server for chief-workspace sessions. The bindings existed in `intent-acp/src/mcp_server/bindings/app/` but were not exposed in the workspace_api tool description for chief agents.

**Expected:** Chief of Staff agents should have access to `ws.app.workspaces.list/get/archive`, `ws.app.agents.list/readConversation`, `ws.app.settings.list/get`, `ws.app.specialists.list/get`, `ws.app.proposal.show`, `ws.app.ui.navigate/highlight/targets`, and `ws.app.workspaces.open` to perform cross-workspace management tasks.

**Status:** fixed ([intent-hq/intentd#241](https://github.com/intent-hq/intentd/pull/241), [intent-hq/cloudlands-fe#139](https://github.com/intent-hq/cloudlands-fe/pull/139), 2026-07-18)

Workspace sidebar does not re-sort by lastActivity when an agent makes progress — workspaces only re-sorted when clicked.

**Repro:** Before this fix, workspace `lastActivity` was updated in the DB on every daemon-side activity (agent turn, commit, note edit), but no live event carried the new timestamp to the frontend. The sidebar only re-sorted when the user clicked a workspace, triggering a workspace.get fetch with the fresh `lastActivity`. Even with the WSS event stream connected, newly-active workspaces stayed at the bottom of the sidebar until clicked.

**Expected:** When an agent or daemon operation updates workspace `lastActivity`, a debounced `workspace:updated` event with the new timestamp is emitted over the WSS connection, and the FE sidebar re-sorts in real-time without user interaction.

**Status:** fixed ([intent-hq/intentd#224](https://github.com/intent-hq/intentd/pull/224), [intent-hq/intentd#225](https://github.com/intent-hq/intentd/pull/225), 2026-07-17) — `workspace:updated` event now emitted with debounced (200ms) trailing-edge logic; follow-up PR #225 addressed Copilot review findings: debounce insertion race condition (generation counter guard), lexicographical RFC3339 comparison bug (chrono::DateTime parsing for timestamp advancement assertions), and RAII environment variable isolation in tests (DebounceEnvGuard)

### STAB-78 (2026-07-17, area: cloudlands-fe / renderer store persistence, severity: P2)

External-editors persistence (Open-In action, hidden editors) and window:zoom-changed listener never persisted after saga removal.

**Repro:** Select a default "Open In" editor in Settings → External Editors, or hide an editor from the list, quit and relaunch the app. Expected: the selected default and hidden editors persist. Actual: selections were lost on relaunch — the store slice was never persisted to daemon settings. Similarly, the window:zoom-changed IPC listener (which syncs Electron's zoom level to the renderer store) was registered in a saga effect that was deleted in saga-removal commit `95d908a2` without being re-homed, so zoom level changes never updated the store.

**Root cause:** The external-editors saga (`external-editors-saga.ts`) was deleted in saga-removal commit `95d908a2` without being re-homed as a middleware. The saga's persistence handlers and window:zoom-changed IPC listener registration were lost, leaving no mechanism to save external-editors state or sync zoom changes.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/119, 2026-07-17)

### STAB-77 (2026-07-17, area: cloudlands-fe / renderer store persistence, severity: P2)

Terminal persistence (overlay height, renames, metadata, per-workspace overlay state) never persisted after saga removal.

**Repro:** Rename a terminal, resize the terminal overlay, or toggle the terminal visibility, quit and relaunch the app. Expected: terminal state persists. Actual: all terminal state was lost on relaunch — the store slice was never persisted to daemon settings.

**Root cause:** The terminal-saga (`terminal-saga.ts`) was deleted in saga-removal commit `95d908a2` without being re-homed as a middleware. The saga's persistence handlers were lost, leaving no mechanism to save terminal state (overlay height, terminal renames, terminal metadata, per-workspace overlay visibility).

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/114, 2026-07-17)

### STAB-76 (2026-07-17, area: cloudlands-fe / renderer store persistence, severity: P2)

User-preferences persistence (spellcheck, show-archived, group-by-repo, provider-setup flag, agent/note font styles, code font family, activity-log presets, promo-banner dismissals) never persisted after saga removal.

**Repro:** Toggle spellcheck in Settings → Preferences, or change the activity-log preset, quit and relaunch the app. Expected: user preferences persist. Actual: preferences were lost on relaunch — the store slice was never persisted to daemon settings.

**Root cause:** The user-preferences saga (`user-preferences-saga.ts`) was deleted in saga-removal commit `95d908a2` without being re-homed as a middleware. The saga's persistence handlers were lost, leaving no mechanism to save user preferences (spellcheck enabled, show archived workspaces, group by repo, provider setup completed flag, agent message font style, note font style, code font family, activity log presets, promo banner dismissals).

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/117, 2026-07-17)

### STAB-75 (2026-07-17, area: cloudlands-fe / renderer store persistence, severity: P1)

Workspace settings persistence (auto-commit toggle, beta-updates toggle, notification settings) never persisted after saga removal.

**Repro:** Toggle auto-commit in Settings → Workspace Settings, or change notification settings, quit and relaunch the app. Expected: settings persist per-workspace. Actual: settings were lost on relaunch — the store slice was never persisted to daemon settings.

**Root cause:** The workspace-settings saga (`workspace-settings-saga.ts`) was deleted in saga-removal commit `95d908a2` without being re-homed as a middleware. The saga's persistence handlers were lost, leaving no mechanism to save workspace settings (auto-commit enabled, beta updates channel, notification preferences).

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/116, 2026-07-17)

### STAB-74 (2026-07-17, area: cloudlands-fe agents-seeder / reload, severity: P1)

Chat transcript clobbered to blank after workspace reload.

**Repro:** Open a workspace with an agent that has existing chat messages. Reload the app (Cmd-R). Observe the agent panel — the chat transcript is completely blank even though the conversation history exists in the daemon.

**Root cause:** `agents-seeder` unconditionally replaced Redux `agentSessions` with the AgentLite list from `client.agents.list()`. When AgentLite payloads have `messages: []` (daemon optimization to reduce payload size), seeder wiped existing conversation transcripts that were already hydrated in the store.

**Expected:** Agent chat transcript is preserved across workspace reloads. Seeder should preserve existing session messages when incoming agent has `messages.length === 0` and existing session has `messages.length > 0`, mirroring the merge logic in `hydrateWorkspaceAgents` from `lifecycle-read-service.ts`.

**Status:** fixed ([intent-hq/cloudlands-fe#122](https://github.com/intent-hq/cloudlands-fe/pull/122), 2026-07-17)

### STAB-73 (2026-07-17, area: cloudlands-fe workspaces-seeder / reload, severity: P1)

Sidebar Changes panel stuck in indeterminate state after workspace reload.

**Repro:** Open a workspace, make some file changes visible in the Changes panel. Reload the app (Cmd-R). Observe the sidebar Changes panel — it shows indeterminate state (spinner or blank) instead of the actual workspace state, even though the workspace is correctly selected in the URL.

**Root cause:** `workspaces-seeder` read `store.state` BEFORE the async `client.workspaces.list()` call, then unconditionally dispatched `setActiveWorkspaceId` + `openWorkspaceTab` for the first workspace. On reload, route loader sets `activeWorkspaceId` during the fetch; seeder's stale empty-state read clobbered it.

**Expected:** Workspace selection and sidebar state correctly reflect the loaded workspace after reload. Seeder should only auto-select the first workspace when BOTH `activeWorkspaceId` AND `currentTabId` are unset (fresh boot scenario), avoiding clobbering route-driven state.

**Status:** fixed ([intent-hq/cloudlands-fe#122](https://github.com/intent-hq/cloudlands-fe/pull/122), 2026-07-17)

### STAB-72 (2026-07-17, area: intentd workspace.create initial-agent orchestration, severity: P1)

Images attached to the first message of a new workspace were persisted on the session but never delivered to the initial agent turn.

**Repro:** Create a workspace from the new-workspace panel with an image attached to the first message. The daemon's `agent_create_op` correctly persists the `imageBlocks` on the created session, but intentd's daemon-owned initial-agent orchestration in `crates/intent-services/src/lib.rs` (`workspace.create`, ~line 6338) delivers the initial prompt with `TurnOptions::default()` — `image_blocks` (and `context_references`) are never threaded into the send, so `append_attachment_blocks` has nothing to append and the first ACP turn goes out text-only. The agent never sees the attached image.

**Expected:** The `workspace.create` handler threads the persisted `initialAgent.imageBlocks` and `contextReferences` into the first turn's `TurnOptions`, so the initial ACP prompt includes the attachments that were already persisted on the agent session. Image-only initial messages (no text prompt) also trigger a turn.

**Note:** The submodule PR/code comments reference this issue as STAB-69 — the ID was reassigned due to a concurrent numbering race; this tracker entry is canonical.

**Status:** fixed ([intent-hq/intentd#220](https://github.com/intent-hq/intentd/pull/220), 2026-07-17)

### STAB-71 (2026-07-17, area: cloudlands-fe chat send middleware / queued-message force-send, severity: P1)

Clicking "Send now" on a queued message delivered it twice: once immediately via interrupt, then again when the queue drained.

**Repro:** Queue a message by sending it while the agent is busy processing another turn. Click "Send now" on the queued message. Observe: the message is delivered immediately (interrupt turn starts), but the queued entry remains visible in the UI during the forced turn. When the interrupt turn ends, the queue drains and the same message is delivered a second time. Root cause: `ChatPanel.svelte` → `handleSendQueuedMessageNow()` dispatches `sendMessage` with `queuedMessageId`, `forceSubmit: true`, and `skipQueueCheck: true`, but `createChatSendMiddleware()` in `packages/cloudlands-fe/src/features/agent/chat-send-service.ts` never reads `queuedMessageId` — it only extracts `forceSubmit` and sends via the lifecycle with `priority: "interrupt"`. No queue removal ever happens (the `SendMessagePayload.queuedMessageId` field is documented but unused). On the daemon side, the interrupt path deliberately preserves the pending queue (per PROTOCOL.md), so when the interrupt turn ends, the queue drains and the original copy is re-delivered.

**Expected:** When `sendMessage` carries `queuedMessageId`, the middleware (1) removes the entry locally (optimistic), (2) calls `agent.removeQueuedMessage` on the wire (awaited), and (3) only then dispatches the lifecycle send with `priority: "interrupt"`. The queued message disappears from the queue list immediately when "Send now" is clicked, and exactly one turn is delivered (no duplicate).

**Note:** The submodule PR/code comments reference this issue as STAB-68 — the ID was reassigned due to a concurrent numbering race; this tracker entry is canonical.

**Status:** fixed ([intent-hq/cloudlands-fe#118](https://github.com/intent-hq/cloudlands-fe/pull/118), 2026-07-17)

### STAB-70 (2026-07-17, area: intentd agent runtime / reportToParent persistence, severity: P2)

A delegated agent's completion report stays sticky in agent metadata and the FE agent card footer forever, even after the parent sends new work and the agent goes active again.

**Repro:** Delegate a task to an agent, let it complete and call `report_to_parent`. The completion report appears in the agent metadata (`completionReport` field) and the FE agent card footer. Send a new message to the same agent (or delegate new work). The agent becomes active again and processes the new turn, but the old completion report remains visible in the metadata and UI — it never clears when the new turn begins.

**Expected:** The completion report should clear when a new turn begins (when the agent transitions from a completed state back to active work). The `completionReport` field should be reset to `null` in agent metadata when the agent starts processing a new message.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/221, 2026-07-17)

### STAB-69 (2026-07-17, area: cloudlands-fe opencode IPC / host.exec, severity: P1)

Opencode model picker failed to load models due to invalid `cwd` parameter in `host.exec` call.

**Repro:** Open the model picker with the opencode CLI installed and authenticated. Expected: the picker lists available opencode models. Actual: FE logs show repeated warnings `[WARN] [OpenCodeIPC] Could not get models from opencode CLI { error="Invalid parameter: cwd requires workspaceId for the containment guard" }` and the picker shows no opencode models. The daemon rejects the `host.exec` JSON-RPC call with error `-32602` because the FE passed `cwd: os.homedir()` without a corresponding `workspaceId`, violating intentd's containment-guard invariant (PROTOCOL §6.6.4).

**Root cause:** The cloudlands-fe `executeOpencodeCommand` helper in `src/features/opencode/main/opencode.ipc.ts` called `hostExec` with `{ command: "opencode", args, cwd: os.homedir(), timeoutMs }`. The daemon's `host.exec` handler (`intent-services/src/host_exec.rs`) requires that `cwd` is either absent or paired with a `workspaceId` (for workspace-containment enforcement). The FE invocation violated this rule by passing `cwd` with no `workspaceId`, causing the daemon to reject the request. The same invalid pattern appeared in `src/features/auggie/main/augment-cli.ts` for the deprecated augment-cli adapter.

**Expected:** The FE `host.exec` calls for opencode (and augment-cli) pass only `{ command, args, timeoutMs }` with no `cwd` or `workspaceId`, allowing the daemon to execute the CLI command in its own working directory (inherited daemon cwd or the daemon's default). The model picker lists opencode models when the CLI is installed and authenticated.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/120, 2026-07-17)

### STAB-68 (2026-07-17, area: cloudlands-fe chat transcript hydration/rendering, severity: P1)

Chat transcript intermittently showed only the newest ~50 messages or flickered blank, losing earlier turns until a refresh.

**Repro:** Open a workspace with an agent conversation containing more than 50 messages. Navigate to the chat view. Observed while dogfooding on 2026-07-17 (Coordinator agent, workspace warnings-warn): earlier turns intermittently vanished from the transcript, showing either a blank flicker or only the last few messages, until a full refresh (Cmd-R) which correctly loaded the full conversation.

**Root cause:** The renderer's `loadChatTranscript` (in `chat-read-service.ts`) hydrated the transcript from `chat.subscribeSnapshot`, which returns only the newest ~50 messages (a single page of the `agent.getConversation` pagination). Earlier messages were never fetched, so they did not appear in the UI.

**Expected:** The chat transcript loads the full conversation history on hydration, regardless of message count. All messages from the first turn to the latest should be visible without requiring a refresh.

**Status:** fixed ([intent-hq/cloudlands-fe#121](https://github.com/intent-hq/cloudlands-fe/pull/121), 2026-07-17) — Changed `loadChatTranscript` to page through `agent.getConversation` with pagination (limit=200/page, following `nextToken` until null) to assemble the full transcript. Added a 125-message regression test.

### STAB-67 (2026-07-17, area: cloudlands-fe / files store, severity: P2)

File-content entries leak in the files slice when tabs are closed.

**Repro:** Open a file tab, then close it. The file-content entry remains in the files slice (memory leak), persisting indefinitely even though no tab references it.

**Root cause:** The file-content prune watcher (`cleanupClosedFileContentEntries`) was deleted in saga-removal commit `95d908a2` without being re-homed. The saga's cleanup logic that watched for tab-close actions and pruned orphaned file-content entries was lost, leaving no mechanism to remove file-content when tabs close.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/105, https://github.com/intent-hq/cloudlands-fe/pull/109, https://github.com/intent-hq/cloudlands-fe/pull/110, https://github.com/intent-hq/cloudlands-fe/pull/111, 2026-07-17)

### STAB-66 (2026-07-17, area: cloudlands-fe / panel layout persistence, severity: P1)

Workspaces did not restore previously opened tabs/layouts (splits, active tab, focused panel) across relaunches.

**Repro:** Open a workspace, open multiple tabs and/or create panel splits, quit and relaunch the app. Expected: the workspace reopens with the same panel layout (tabs, splits, active tab, focused panel) as before. Actual: the layout was never persisted to `localStorage` nor restored on `workspaceMounted`, and `restoreStatus` stayed `"idle"` — the workspace always opens with a default/empty layout.

**Root cause:** The `panel-layout-saga` (which handled persistence and restore) was deleted in saga-removal commit `95d908a2` without being re-homed as a middleware. The saga's `PERSIST_ACTIONS` / `HISTORY_ACTIONS` handlers, `localStorage` persistence, and `workspaceMounted` restore logic were lost, leaving no mechanism to save or restore panel layouts.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/102, 2026-07-17)

### STAB-65 (2026-07-17, area: cloudlands-fe Settings / Specialists persistence, severity: P1)

**Repro:**
1. Open Settings → Specialists
2. Click "Use for all specialists" (to apply the selected model to all)
3. Observe: no effect — button stays visible, no `.md` files written to `~/.augment/specialists/`
4. Similarly, per-specialist model changes, prompt edits, create-new, delete, and reset-to-default produce no wire call

**Root cause:**
Saga-trigger write actions (`saveFileSpecialist`, `deleteFileSpecialist`, `exportBuiltinToFile`, `loadFileSpecialists`) were orphaned when the saga runtime was removed (their handlers lived in the removed saga). Dispatch sites in AIBehaviorEditor.svelte and Settings remained unchanged, so the actions dispatched but produced no daemon call.

Additionally, the SpecialistsClient seam lacked write methods (`create` / `edit` / `delete`) — only `list` was implemented.

**Status:** fixed (https://github.com/intent-hq/cloudlands-fe/pull/101, 2026-07-17)

**Fix:**
1. Extended SpecialistsClient seam with `create` / `edit` / `delete` matching PROTOCOL §5.11 (live client propagates errors, mock client stubs; 16 tests)
2. Created specialists mutation middleware (`createSpecialistsMutationMiddleware()`) re-homing the orphaned write actions — middleware chooses create vs edit by checking store state for existing file specialist (daemon semantics: create errors on existing id, edit errors on missing id), refetches `specialist.list` after every write, surfaces toast errors on failure (8 tests)
3. Registered middleware in `src/store/renderer/middleware.ts`

Result: clicking "Use for all specialists" now writes one file per specialist via `specialist.create`/`edit`, the store refreshes from `specialist.list`, and the button hides once all specialists use the selected model.

### STAB-64 (2026-07-17, area: intentd workspace.create / cloudlands-fe sidebar repo grouping, severity: P2)

Sidebar repo groups show no GitHub avatar for workspaces created from local repo paths, unlike the reference app.

**Repro:** Create a workspace from a local repository path that has a `github.com` origin remote (e.g., `intentd workspace create --path ~/code/monorepo`). Open the cloudlands-fe sidebar All-Workspaces repo view. The repo group for that workspace shows no GitHub owner avatar next to the repo group, even though the repository has a valid GitHub origin.

**Expected:** The GitHub owner avatar appears next to the repo group in the sidebar, matching the reference app behavior. The sidebar (`AllWorkspacesCard.svelte`, repo view) renders the avatar when `group.owner` is set, which requires `workspace.repositoryOwner`.

**Root cause:** The daemon never derives `repositoryOwner` from local paths. intentd only sets `repository_owner` when the caller explicitly supplies it or when the workspace is created by cloning a `github.com/OWNER/REPO` URL. PROTOCOL.md states: "`repositoryOwner` is never derived from local paths (no remote inspection)". The reference app (augmentcode/intent) backfilled `repositoryOwner` and `repositoryName` in the Electron main process (`performBackgroundEnrichment` → `git remote get-url origin`), but that enrichment path is out of the daemon-canonical data path in the ported stack — the cloudlands-fe sidebar lists workspaces straight from intentd `workspace.list` (`LiveWorkspacesClient`) with fields passing through untouched.

**Status:** fixed (https://github.com/intent-hq/intentd/pull/218, 2026-07-17)

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

**Status:** fixed ([intent-hq/intentd#189](https://github.com/intent-hq/intentd/pull/189), 2026-07-16) — generalized provider binary discovery with settings → managed bin → PATH-scan precedence, wired into agent spawn. The claude-code provider now falls back to `npx -y @agentclientprotocol/claude-agent-acp` when the adapter binary is absent ([intent-hq/intentd#215](https://github.com/intent-hq/intentd/pull/215), 2026-07-17).

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
