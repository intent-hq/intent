# Agent Message Deduplication and Stream Saga Architecture

This document explains the approved message deduplication and stream-reconciliation architecture for agent sessions.

## Part 1: Detailed Guide — What Changed and Why

### Problem

Agent chats could show two assistant messages for one logical response. The observed duplicate shape was usually:

- one renderer-created assistant message produced while handling restored/reconnected stream updates, and
- one backend-finalized assistant message persisted or emitted later with different `id`, `appMessageId`, or timestamp metadata.

The root issue was not just rendering. A missing local stream update target could previously cause the stream lifecycle adapter (then `src/features/agent/agent-stream-lifecycle.ts`, since removed) to synthesize a placeholder from accumulated stream content. Fallback assistant message creation now belongs to the stream saga and only runs after canonical target matching plus bypass-cache refresh still miss. Later, `src/features/agent/main/agent-backend-handler.service.ts` could finish and persist the same logical assistant turn under a different identity. Exact-ID merge paths and prior content fallback rules did not always collapse that pair.

### Changed Areas

#### Canonical dedup utility

`src/shared/utils/message-dedup.ts` is the single owner for agent message duplicate matching and merge policy. It depends on shared content-block helpers such as `src/shared/utils/content-block-helpers.ts`, which keeps the policy usable from renderer reducers/sagas and main-process persistence code.

It handles:

- timestamp normalization,
- content-block hashing and stable content comparison,
- assistant-only near-duplicate detection for stream finalization identity mismatches,
- `appMessageId`, canonical `msg_` id, timestamp, role, and turn-number guards, and
- merge policy for preserving the preferred identity while keeping the richer/final message content.

The main entry points are:

- `deduplicateAgentMessages(...)`
- `insertAgentMessageWithDedup(...)`
- `replaceAgentMessageByIdWithDedup(...)`

Why: duplicate policy must be consistent for full session snapshots, incremental message appends, and id replacement. Keeping this logic in one pure utility prevents drift between ingestion paths.

#### Reducer safety net

`src/store/renderer/slices/agent-session/agent-session-slice.ts` routes session/message ingestion through the dedup utility.

Covered paths include:

- session normalization before storing,
- single message insertions,
- message replacement by id,
- full message replacement,
- session update payloads containing messages, and
- workspace-agent cross-slice message replacement.

Why: reducers are the last shared-state boundary before UI rendering. Even if an upstream race or persisted session reintroduces duplicate logical messages, Redux session state should converge to the canonical deduped representation.

#### Thin stream lifecycle adapter

The stream adapter role is now filled by `src/features/events/daemon-events-bridge.client.ts` (the former `src/features/agent/agent-stream-lifecycle.ts` has been removed). It translates daemon stream events into typed Redux actions such as `agentStreamUpdateReceived(...)`.

It should not own Redux-state-dependent decisions such as:

- whether the current session contains an assistant update target,
- which message should receive a chunk/content-block/complete update,
- whether a session is stale,
- whether to refresh from persistence,
- refresh coalescing or rate limiting, or
- whether fallback placeholder creation is justified after refresh misses.

Why: service/lifecycle files should be as thin as possible. Shared/domain state and side-effect orchestration belong in Redux and Redux sagas, where selector reads, effects, and tests are explicit.

#### Saga-owned missing-target reconciliation

`src/store/renderer/slices/agent-session/sagas/agent-stream-saga.ts` owns stream update decisions that depend on Redux state.

It handles:

- selecting the current agent session,
- matching stream updates to canonical assistant targets,
- applying chunk/content-block/complete/error/timeout updates,
- detecting missing update targets,
- refreshing stale sessions from persistence with `{ bypassCache: true }`,
- coalescing in-flight refreshes and rate-limiting repeated refreshes, and
- creating a fallback assistant message only after refresh still cannot find a target.

Why: missing-target refresh is a side effect and an orchestration workflow. Sagas are the correct layer for reads from Redux state, persistence calls, retry/rate-limit behavior, and follow-up dispatches.

### Verification Approach

The implementation was verified with focused coverage for:

- message dedup utility behavior and false-positive guards,
- agent-session reducer ingestion paths,
- restored and sendMessage stream lifecycle regressions,
- agent-session stream sagas, including missing-target refresh and saga-owned fallback behavior,
- renderer TypeScript checks, and
- `git diff --check` whitespace checks.

## Part 2: New Architecture

### Ownership Model

| Layer                      | Owns                                                                                                     | Must Not Own                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| UI components              | Rendering, component-local UI state, dispatching user intent                                             | Shared/domain state or app workflows                                     |
| Service/lifecycle adapters | IPC/stream subscriptions, raw event translation, payload construction, compatibility window events       | Redux-state target lookup, refresh/reconcile orchestration, dedup policy |
| Redux slices/reducers      | Serializable shared/domain state and pure canonical state transitions                                    | Side effects, async work, timers, persistence calls                      |
| Selectors                  | Reusable state reads and derived state                                                                   | Side effects or state mutation                                           |
| Redux sagas                | Side effects, IPC/persistence calls, retries, debounce/rate-limit/coalescing, cross-domain orchestration | Rendering or reducer mutations                                           |
| Dedup utility              | Pure message duplicate matching and merge policy                                                         | Persistence, dispatching, or UI updates                                  |

### Stream Update Flow

1. Backend emits stream events for an agent response.
2. `daemon-events-bridge.client.ts` receives stream callbacks and dispatches raw Redux stream actions with IDs, content, content blocks, `appMessageId`, and stream metadata.
3. `agent-stream-saga.ts` reads Redux state through selectors and tries to apply the update to the current canonical assistant target.
4. If no target exists, the saga treats the session as stale, performs a bypass-cache persistence refresh, and retries the update against the refreshed session.
5. If refresh still cannot supply a target, the saga may create a fallback assistant message. This is the exception path, not the default reconciliation strategy.
6. `agent-session-slice.ts` applies the update and runs canonical message deduplication so snapshot replacement and incremental insertion converge to the same result.
7. UI reads deduped session state and renders one logical assistant response.

### Architectural Rules Going Forward

- Keep service and lifecycle files as thin as possible. They can translate external events into typed actions, but should not make Redux-state-dependent domain decisions.
- Put shared/domain state in Redux slices under `src/store/renderer/`.
- Put side-effect orchestration in Redux sagas: IPC, persistence, refresh/reconcile, timers, retries, coalescing, rate limiting, and cross-slice workflows.
- Keep duplicate matching and merge rules in `message-dedup.ts`; do not reimplement near-duplicate policy in services, sagas, components, or persistence code.
- Preserve false-positive guards for legitimate repeated assistant messages, especially different explicit turns.

### Key References

- `src/shared/utils/message-dedup.ts`
- `src/shared/utils/content-block-helpers.ts`
- `src/store/renderer/slices/agent-session/agent-session-slice.ts`
- `src/features/events/daemon-events-bridge.client.ts`
- `src/store/renderer/slices/workspace-agents/workspace-agents-slice.ts`
- `src/store/renderer/slices/agent-session/sagas/agent-stream-saga.ts`
- `src/store/renderer/slices/agent-session/sagas/agent-stream-saga.test.ts`
