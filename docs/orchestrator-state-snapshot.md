# Orchestrator process-local state snapshot

**Snapshot, not maintained.** Classification of every field of `intent_services::Services` and every tenant restore, sweep and loop that `intent_app::tenant` starts, by what each means for running more than one orchestrator process per tenant. Taken 2026-11-25 from intentd `main` at `dda749f87` plus the agent-queue change (intentd#3782). Code changes after that date are not reflected; re-check a row against the code before relying on it.

The design that uses this table is in [ARCHITECTURE.md: Owner work vs request writes](./ARCHITECTURE.md#owner-work-vs-request-writes-orchestrator-mode).

## Classes

| Class | Meaning |
|---|---|
| owner | Owned background work, a long-lived runtime or a link. Needs one owner per tenant or machine (a claim) when several processes serve a tenant. |
| gate | An in-process lock or single-flight that guards an invariant. "Writer lock" says whether the Postgres tenant writer lock already covers it. |
| volatile | Live process-local state that is neither durable nor a cache. Losing it or splitting it across processes changes behavior. |
| cache | Safe to lose or to differ per process; the note says how stale it gets. |
| connection | Bound to one client or executor connection. |
| config | Fixed after start (wiring, overrides, handles). |
| test | Test parks, probes and overrides; absent in production. |
| durable | The database is the truth. |

## Counts

| Class | Fields | Loops |
|---|---|---|
| owner | 31 | 25 |
| gate | 35 | 0 |
| volatile | 45 | 0 |
| cache | 26 | 1 |
| connection | 8 | 0 |
| config | 36 | 0 |
| test | 50 | 0 |
| durable | 0 | 0 |
| **total** | **231** | **26** |

Gates: 0 covered, 12 partial, 23 not covered by the tenant writer lock.

## Gates

| Field | Invariant | Writer lock | Note |
|---|---|---|---|
| `agent_queue_persist_gate` | This process's agent_queue writes and refreshes run one at a time, each on a memory snapshot taken inside the gate; a drain's refresh, pop and claim run as one step. | partial | Narrowed: across processes, sync_agent_queue reads, merges and writes under the tenant writer lock with the queue version, so another process's queue is merged with, never overwritten. The gate still orders this process's snapshot against its own write and its merge base, which the writer lock cannot see. |
| `agent_queue_publish_gate` | agent:queue:updated snapshots are never older than a mutation that completed before the publish. | no | Kept as is: it orders reads of process memory against the in-process bus write, which no store transaction covers. Another process's queue change is published only on that process's bus; cross-process ordering belongs to the event fabric. |
| `browser_client_pin_gate` | workspace.setBrowserClient write and its workspace:updated publish happen in the same order. | partial | Writes are ordered by the writer lock; publication after commit is not. |
| `browser_tab_gate` | Each browser tab registry mutation and its browser:tab-* events are published atomically (no ghost tabs). | partial | Row order is covered; event publication order is not. |
| `agent_retirement_gates` | Per-target retirement cleanup and restore never interleave (lifecycle lock order head). | no | Spans several transactions plus process work (stopping sessions). |
| `pending_question_mutation_locks` | Per-agent pending-question marker writes and their agent:updated events stay in order. | partial | Write order is covered; event order is not. |
| `archive_script_gates` | A workspace delete or purge waits for a running archiveScript before removing the folder. | no | Guards local process and disk work. |
| `group_persist_lane` | delegation_group writes apply in enqueue order (intent-hq/intent#4460). | no | Single worker per process. The writer lock serializes each transaction but not the enqueue order; with two replicas each has its own lane and writes for one group can interleave across processes. |
| `completion_watch_registration_gate` | A strict completion-only watch is durably persisted before completion delivery can see it. | partial | Persistence is covered; visibility to the in-memory registry is not. |
| `completion_deliveries_in_flight` | Only one delivery pass delivers a given ungrouped watch's terminal wake (intent-hq/intent#4367). | partial | completion_watches already has a DB delivery claim (claim_delivery with ProcessToken + epoch); this in-memory claim also shares consumed flip triggers between passes. |
| `dismissal_notices_sent` | No duplicate questions-dismissed notice for concurrent or interleaved dismissals of the same id. | no | The persisted marker is single-slot; the dedupe set is process memory. |
| `worktree_locks` | Commit/push on one worktree never races other operations on it (withGitWorktreeLock parity). | no | Guards a local git worktree. |
| `warm_in_flight` | At most one opportunistic repo.warmCache warm daemon-wide. | no | Guards local repo-cache disk work; per-replica it becomes one per replica. |
| `archive_fence` | Per-workspace archive and unarchive (and the archive post-commit tail) never interleave. | no | Held across several commits and event publication. |
| `settings_revision_gate` | Settings persistence, revision allocation and settings:changed publication are ordered against snapshots. | no | Settings live in config.toml, not under the tenant writer lock. |
| `settings_secret_gates` | Readers and writers of one secret setting wait for its whole mutation, including compensation and publication. | no | Secrets live outside the database. |
| `attention_mutation_gates` | Per-agent attention persistence, deferred surfacing and matching clear events stay ordered. | partial | Write order is covered; event order is not. |
| `scripts_running_state` | Workspace.scriptsRunning transitions are computed and published in order per workspace. | no | Derived from local script processes. |
| `gitlab_credential_gate` | Refresh, persist and delete of the GitLab credential pair are serialized. | no | The pair is in a local file today. |
| `repository_review_capacity` | Bounds concurrent repository review reads. | no | Process-local capacity; replicas multiply the bound. |
| `repository_resource_capacity` | Bounds concurrent repository resource reads. | no | Process-local capacity. |
| `repository_child_git_capacity` | Bounds concurrent child git helper operations. | no | Process-local capacity. |
| `repository_checkout_capacity` | Bounds concurrent repository checkout operations. | no | Process-local capacity. |
| `repository_selection_capacity` | Bounds concurrent repository selection operations. | no | Process-local capacity. |
| `identity_transition` | The primary identity's lock check and write never interleave with invite minting. | partial | Both sides write rows, but check-then-write spans separate statements. |
| `invite_nonce_permits` | At most MAX_OUTSTANDING_NONCES nonces are outstanding. | no | Process-local permits. |
| `human_instruction_authority` | Human instruction authority changes exclude concurrent instruction admissions. | no | Process-local RwLock. |
| `discussion_control_gates` | Per-agent discussion control mutations are serialized. | partial | Writes are covered; surrounding reads and publication are not. |
| `automatic_pr_refresh` | Automatic PR refreshes are reserved before I/O, bounding retries across reconnects and windows. | no | Forge-call admission; replicas multiply the budget. |
| `pr_monitor_registration` | Per-owner PR-monitor quota admission through persistence, including adoption, is serialized. | partial | The count-then-insert spans a forge read and separate statements. |
| `review_monitor_poll_lane` | GitLab review-monitor polls never overlap. | no | Guards forge polling. |
| `legacy_pr_monitor_poll_lane` | The legacy PR-monitor sweep and an agent:idle nudge never poll the same monitors concurrently. | no | Guards forge polling; becomes an owner claim with replicas. |
| `workspace_mutations` | Admitted creates and sends finish before an incremental workspace deletion stops sessions; later producers fail fast. | no | Deletion yields the writer between steps, so the writer lock cannot hold it. |
| `attachment_idempotency_inflight` | Same-key keyed attachment placements wait and replay instead of racing (intent-hq/intent#4691). | partial | The store primary key is the last line of defence; the wait-and-replay is process-local. |
| `idempotency_inflight` | Same-key first-use callers of with_idempotency serialize; one runs, the rest replay. | partial | The stored result is durable; the in-flight wait is process-local. |

## Tenant restores, sweeps and loops

| Name | Kind | Class | Note |
|---|---|---|---|
| `heal_event_subscriptions_on_startup` | restore | owner | Rehydrates persisted event subscriptions into this process; each replica would deliver them again. |
| `hydrate_scripts` | restore | owner | Loads script definitions into the local registry. |
| `reconcile_startup_completions` | restore | owner | Delivers completions that finished while no process served the tenant (TenantRuntime::reconcile_completions); a second process would deliver them again. |
| `rehydrate_hooks` | restore | owner | Resumes hook timers in this process; needs per-hook claims. |
| `rehydrate_pr_monitors` | restore | owner | Resumes PR monitors and marks catch-up; needs per-monitor claims. |
| `refresh_primary_identity_at_startup` | restore | cache | One bounded GitHub identity refresh; harmless to repeat. |
| `sweep_orphaned_worktree_trash` | sweep | owner | Removes local worktree trash dirs (gap F). |
| `sweep_stale_export_staging` | sweep | owner | Removes local export staging dirs, assuming every session died with the process. |
| `sweep_agent_tmp_root` | loop | owner | Hourly sweep of local agent temp folders. |
| `resume_exposed_machines` | sweep | owner | Redials machines that may run this backend's agents (gap E: one owner per machine). |
| `sweep_expired_attachment_idempotency_keys` | sweep | owner | Deletes expired idempotency bindings; idempotent, safe to run on any replica. |
| `spawn_pr_refresh_loop` | loop | owner | Background PR refresh every 60 s tick; duplicate runs double forge load. |
| `spawn_pr_monitor_loop` | loop | owner | Centralized PR-monitor sweep; needs per-monitor claims. |
| `spawn_token_usage_scan_loop` | loop | owner | Token-usage rescan every 300 s. Since this snapshot it holds a lease (scope `token-usage-scan`, intentd#3793). |
| `spawn_completion_delivery_loop` | loop | owner | Bus subscriber waking parents on child completion; DB delivery claims exist for watches. |
| `spawn_auto_commit_loop` | loop | owner | agent:idle subscriber committing task-linked changes; touches the home worktree. |
| `spawn_push_publisher` | loop | owner | Push relay publisher; one per tenant. |
| `spawn_idle_pr_refresh_loop` | loop | owner | agent:idle subscriber refreshing that workspace's PRs. |
| `spawn_agent_locks_loop` | loop | owner | Recomputes and publishes changes:agent-locks snapshots from bus events. |
| `spawn_tracked_changes_sweep_loop` | loop | owner | Deletes stale tracked-change rows after git checks. |
| `spawn_script_output_sweep_loop` | loop | owner | Deletes old local script output logs (gap F). |
| `spawn_auto_retire_loop` | loop | owner | Hourly purge of long-archived workspaces. |
| `spawn_auto_archive_loop` | loop | owner | Hourly archive of idle workspaces. |
| `spawn_execution_context_loop` | loop | owner | Recomputes provider execution readiness (backend upkeep; runs in node mode too). |
| `spawn_tenant_retention_loop` | loop | owner | Event retention store sweep (TenantRuntime only). |
| `spawn_tenant_reap_loop` | loop | owner | Idempotency reaper store sweep (TenantRuntime only). |

## Fields: owner

| Field | Note |
|---|---|
| `event_bus` | In-process EventBus (store append, then tokio broadcast). Gap C: transient events never leave the process. |
| `hold_release_timers` | Spawned sleepers releasing debounce holds on queued messages at holdUntil; re-armed at rehydration. |
| `delivery_tasks` | Cancellation and drain ownership of automatic agent delivery tasks. |
| `store_tasks` | Finite derived-state writer tasks drained at shutdown. |
| `settings_tasks` | Finite settings writer tasks drained at shutdown. |
| `terminal_tasks` | Terminal-related finite tasks drained at shutdown. |
| `turn_start_tasks` | Detached claim-to-spawn deliveries (intent-hq/intent#9927), joined at the shutdown checkpoint. |
| `pending_delete_tasks` | Finite pending-delete tasks drained at shutdown. |
| `host_exec_runtime` | Owns one-shot host command processes and their reaping. |
| `provider_preparation` | Bounded provider preparation scheduler. |
| `completion_delivery_retries` | Per-child terminal-delivery retry tasks with generations (intent-hq/intent#3728). The durable watch stays armed; the retry owner is in memory. |
| `pending_completion_retries` | Per-child bounded-backoff retry owner for deferred deliveries. |
| `completion_group_delivery_retries` | Delegation groups with an active aggregated-wake retry task. |
| `pty` | PTY host backing terminal.* and ACP terminals; processes live here (gap D). |
| `pulls` | Serves ws.file.pull pieces from snapshots under a local staging folder. |
| `profile_activation` | Live provider profile processes, one per agent at most. |
| `mcp_hub` | External MCP server processes and their health monitor. |
| `turn_bookkeeping` | Per-agent chain of detached turn-end usage bookkeeping tasks (monorepo#738). |
| `line_attribution_debouncers` | Per-note debounce timers for attribute_lines recomputes; a replica would recompute twice (harmless) but would not cancel the other's timer. |
| `last_activity_debouncers` | Per-workspace trailing-edge debounce timers for workspace:updated lastActivity. |
| `last_activity_debounce_gen` | Generation counter for last_activity_debouncers. |
| `idle_debouncers` | Per-workspace debounce timers for the busy-to-idle workspace:activity-changed flip. |
| `idle_debounce_gen` | Generation counter for idle_debouncers. |
| `push_relay` | Push relay key, link bookkeeping and publisher wake-up. |
| `link_traffic` | Capture of executor-link traffic, tapped by the links (gap E). |
| `pr_monitor_kick` | Wakes the PR-monitor loop for an immediate sweep. |
| `created_pr_retries` | Agent-created PRs being linked, so a second report joins the retry. |
| `review_monitor_controls` | Control channel into the running monitor loop. |
| `pending_workspace_deletes` | Delete grace-window timers; never persisted, so a restart drops pending deletions. |
| `pending_agent_deletes` | Agent delete grace-window timers; never persisted. |
| `execution_invalidation` | Notify that wakes the execution-context loop on safe-context invalidations. |

## Fields: volatile

| Field | Note |
|---|---|
| `event_subscriptions` | Deprecated event.subscribe registrations with their running bus-delivery tasks. Rows persist and are rehydrated at startup, but delivery runs in this process; needs one owner per subscription. |
| `agent_workers` | Provider worker observations per live agent generation in this daemon. |
| `queue_submission_order` | Process-wide monotonic queue submission counter; another replica would allocate overlapping orders. Raised to the highest order of entries adopted from the store, but two processes can still hand out the same order. Queue order is the stored row position, not this counter. |
| `draining_queue_entries` | Entries this process popped and is delivering, overlaid on its own snapshots until their user rows exist (PROTOCOL 6.5 drain ordering) and frozen at shutdown. Narrowed: it no longer has to keep another process from draining the same entry; the drain's claimed pop (Services::claim_queue_pop) does that in the store. It stays process-local: another process's snapshots do not show this process's in-flight entries. |
| `draining_shutdown` | Shutdown flag freezing drained payloads before owners are cancelled. |
| `parked_recovery_sends` | Queue-entry ids of recovery sends parked behind a still-held in-flight slot (intent-hq/intent#4962). Never persisted. |
| `workspace_setup_states` | Per-workspace setup stage; absent reads 'unknown'. In-memory only. |
| `home_setups` | How far each workspace home's opening on its machine has got. In-memory only. |
| `agent_subscriptions` | Completion-watch and delegation-group registry. Rows persist (completion_watches with delivery claims), but the live registry and its delivery state are in memory. |
| `agent_failure_streaks` | Consecutive identical terminal failures per agent (monorepo#840); feeds session_poisoned. Restart forgets it. |
| `pending_terminal_error` | Single-shot handoff of an already-persisted terminal error to the turn worker (monorepo#2050). |
| `failure_wake_dedup` | Last agent:failed wake per (parent, child), suppressing repeats. Per-replica copies would let duplicates through. |
| `interim_skipped_idles` | Children whose last agent:idle was skipped as interim (monorepo#1280); drives redelivery. |
| `stale_report_interim_skips` | Subset of interim_skipped_idles recorded by registration-time deferral (monorepo#2532). |
| `advisory_pending_interim_skips` | Subset of interim_skipped_idles that owes a monitoring-idle advisory (monorepo#1297). |
| `advisory_wake_periods` | In-memory mirror of advisory_wake_delivery markers bounding advisories when the store write fails. |
| `secret_vault` | Agent-owned secrets and pending secret requests (PROTOCOL 5.56). Memory only by design; never persisted. |
| `agent_activity` | Per-workspace in-flight session count behind the derived activity dot. Never persisted. |
| `settings_revision` | Daemon-lifetime monotonic settings revision; replicas would hand out unrelated revisions. |
| `provider_profiles` | Provider profile metadata in <data_dir>/provider-profiles.json with a mutation lock and process-local revision (gap F). |
| `live_turns` | Partial assistant message of each streaming turn, merged into chat.subscribe snapshots. Lives with the turn writer. |
| `truncation_redrives` | Consecutive suspected-truncation auto-redrive counter per agent (monorepo#2863). |
| `quota_failover_chains` | Failover chain of the in-flight user turn; present only while a turn worker owns the turn. |
| `quota_failover_replays` | Continue-the-cut-short-turn replay marks. |
| `pending_remote_failovers` | Remote agents' quota switches awaiting their node's start (intent-hq/intent#8317). |
| `remote_model_switches` | Accepted agent.setModel switches for remote agents awaiting the next start. |
| `provider_return_announcements` | Pending provider_returned announcements; re-armed when the message restarts. |
| `pending_truncation_redrive` | One-shot truncation redrive handoff between run_prompt_turn and the turn worker. |
| `deferred_attention` | Attention requests raised mid-turn, surfaced when the agent goes idle. Restart loses the queue. |
| `rpc_proposals` | Assistant rpc-call proposals awaiting approval. In memory only; a restart expires them. |
| `backend_reports` | Latest backends.report from each owner app. |
| `github_auth_flow` | The single GitHub device-flow slot and its poll task. |
| `collaboration_auth` | Collaboration credential flows; credentials live in private local files (gap F). |
| `gitlab_auth` | GitLab device-grant slot and unsupported-host memory. |
| `repository_connection_directory` | Repository credential directory for this server incarnation, with a fresh private epoch. |
| `repository_lifecycle_registry` | The one invalidation observer installed in the Store for this Services instance. |
| `identity_rekey_generation` | Bumped by every identity.provider write; a stale re-key probe is dropped. Process-local counter. |
| `invite_nonces` | Outstanding invite.challenge nonces awaiting invite.prove; a prove on another replica would fail. |
| `turn_attachments` | Turn-attachment registry: MCP dispatch registers, transcript writer claims. Both run with the agent's session. |
| `pr_monitor_queued_wakes` | Each monitor's last changed wake still queued, so a newer one replaces it. |
| `pr_monitor_catch_up` | Monitors whose next poll skips the debounce after a restart; set by rehydration. |
| `review_monitor_authorities` | Original qualified registration lifetimes; never rebuilt from stored ids. |
| `review_monitor_deliveries` | Current original deliveries; never reconstructed from persisted wake metadata. |
| `startup_resume_candidates` | Agents reserved for startup resume. |
| `attachment_uploads` | Staged attachment upload sessions between begin and commit; chunks on another replica would miss the session. Staging dirs are local disk (gap F). |

## Fields: cache

| Field | Note |
|---|---|
| `agent_queues` | Per-process cache of each agent's agent_queue rows. Every write-through is Store::sync_agent_queue: on Postgres, when another process wrote the queue since, this process's change is merged onto the stored rows and memory is refreshed from the result. agent.getQueue and the drain pops refresh from the store first (Store::refresh_agent_queue). Staleness: other in-memory readers (has_ready_to_send, event snapshots, diagnostics) see another process's change only after this process's next write or refresh. SQLite: one writer, so memory is always current. |
| `session_stats_cache` | Last stats per session, used to emit agent:session-stats-changed only on change. Losing it causes at most one extra event; per-replica copies may duplicate events. |
| `models_catalog` | models.list cache, 24h staleness, optionally mirrored to a data-dir file; per-provider single-flight inside. |
| `auto_commit_cooldowns` | Per-workspace generation cool-down after a timeout (intent-hq/intent#5454). Losing it retries generation once more. |
| `worktree_presence` | Workspaces last seen with a missing checkout folder; re-probed by the watcher. Local disk view (gap F). |
| `workspace_vocabulary` | Per-workspace vocabulary, content-hash keyed; recomputed on a miss. |
| `context_usages` | Latest context-window occupancy per agent from ACP usage_update; dropped on restart, refreshed by the next update. |
| `last_turn_silent_tails` | Silent tail of each agent's last turn for agent.diagnostics; diagnostic only. |
| `provider_quota_cache` | Daemon-wide quota health per provider configuration; re-learned from the next attempt. |
| `last_display_statuses` | Last emitted displayStatus per workspace; per-replica copies may emit duplicate or missed change events. |
| `last_waiting_statuses` | Last emitted waiting flag per workspace; same staleness as last_display_statuses. |
| `token_usage_watermarks` | Incremental token-usage scan watermarks; a restart (or another replica) rescans once. |
| `principal_identity_refreshed_at` | Rate-limit instant for the primary's GitHub profile refresh; another replica refreshes once more. |
| `disk_usage` | TTL stale-while-revalidate disk-usage cache; local disk walks (gap F). |
| `agent_list_cache` | agent.list message projections, invalidated by local writes. A replica would not see another replica's invalidations: needs bus-driven invalidation. |
| `git_diffs_inflight` | Single-flight for identical git.diffs walks; coalescing only. |
| `git_diffs_slow_warns` | WARN rate limiter; logging only. |
| `git_status_cache` | Per-worktree status cache invalidated by daemon-observed changes plus a fallback TTL. Invalidations from another replica would not arrive. |
| `ac_status_inflight` | Single-flight for accept-changes.getStatus builds; coalescing only. |
| `pr_monitor_feed` | Last-seen PR state per monitor and PRs other reads saw move; only speeds up polling. |
| `pr_cache` | Shared PR read cache within prCache.maxAgeSeconds; starts cold. |
| `pr_discovery` | Repository-wide PR discovery single-flight with failure memory for a window. |
| `issue_cache` | github.issues.get cache within prCache.maxAgeSeconds. |
| `pr_monitor_logged_interval` | Last logged cadence; logging only. |
| `sweep_rate_limit` | Global forge rate-limit pause; re-learned on the first rate-limited call. |
| `execution_readiness` | Bounded provider readiness verdicts; recomputed by the execution-context loop. |

## Fields: connection

| Field | Note |
|---|---|
| `desktop` | Desktop-control authority bound to one admitted execution connection; volatile by design. |
| `search_cancels` | Per-request cancel registry for search.*; a cancel must reach the process running the walk. |
| `pull_transfers` | Which caller opened each ws.file.pull transfer. |
| `reverse_dispatch` | First-client-sticky server-to-client RPC registry for ws.browser.exec (gap D). |
| `principal_revocations` | Feed of revoked principals; the transport closes their connections. Must reach every replica holding them. |
| `executor_revocations` | Feed of revoked executor credentials; the transport closes their /node/* connections. |
| `executor_liveness` | Live status of executor credentials from the executor link (gap E). |
| `presence` | Ephemeral workspace and note presence table (gap D). |

## Fields: config

| Field | Note |
|---|---|
| `store` | Store handle (SQLite or Postgres). Shared by every replica; the database itself is the durable truth. |
| `assets_root` | Note-asset directory on local disk. Replicas need shared object storage (gap F). |
| `chief_cwd_root` | Assistant workspace root on local disk (gap F). |
| `primary_auth_admitted` | Set only on the clone inside a registered settings/primary-auth owner. |
| `agent_manager` | Weak back-reference to the AgentManager, attached once. |
| `source_control` | Forge override, wired at startup or by tests. |
| `linear_engine` | Linear engine override. |
| `sentry_engine` | Sentry engine override. |
| `voice_engine` | Voice engine override (tests). |
| `autocomplete_upstream` | Autocomplete upstream endpoints and timeout. |
| `workspaces_root` | Worktree root on local disk. |
| `base_refresh_timeout` | Base-refresh fetch bound (tests shorten it). |
| `script_output_config` | Script output log directory on local disk (gap F). |
| `script_too_fast_ms` | Too-fast-exit floor (tests raise it). |
| `secrets` | Secret store for sensitive settings (file-backed by default, gap F); its single-flight cache is safe to lose. |
| `settings_registry` | config.toml registry with a file watcher (gap F); the 'settings off disk' task moves it to Postgres. |
| `specialists_user_dir` | User specialists directory override. |
| `specialists_bundled_dir` | Bundled specialists directory override. |
| `context_engine` | Context engine for search.codebase. |
| `server_control` | WSS listener runtime control, attached once. |
| `agent_rpc` | Assistant ws.rpc.* surface, attached once. |
| `invite_links` | Invite link builder, attached once. |
| `gitlab_secret_store` | File-backed GitLab credential pair (secrets.json, gap F); the 'settings off disk' task moves it. |
| `daemon_boot_id` | Identity of this server incarnation; each replica has its own. |
| `repository_wire_owner` | Weak back-reference to the owning Services allocation. |
| `machine_routes` | Where the executor link can be dialed, attached once. |
| `hooks_max_per_agent` | Hook cap from Config. |
| `node_mode` | Node mode flag, fixed before listeners serve. |
| `run_mode` | Daemon mode (orchestrator or not), fixed before listeners serve. |
| `hook_eval_timeout` | Hook script budget (tests shorten it). |
| `hook_store_retry_base` | Hook persistence retry backoff (tests shorten it). |
| `suspend_tracker` | Host suspend-overlap query; host-local by nature. |
| `pr_monitor_fetch_timeout` | Per-fetch bound in a sweep (tests shorten it). |
| `pr_refresh_fetch_timeout` | Per-workspace PR refresh bound (tests shorten it). |
| `ports` | Registered feature ports, frozen once shared. |
| `features` | Feature state objects keyed by type (e.g. transfer sessions); the objects themselves are not inventoried here. |

## Fields: test

| Field | Note |
|---|---|
| `pending_marker_mutation_park` | Deterministic park before a marker mutation. |
| `auggie_bin` | Test override for the auggie binary. |
| `branches_ls_remote_base` | Test override for the ls-remote fallback URL base. |
| `one_shot_npx` | Test override for npx discovery. |
| `auto_commit_timeout_ms` | Test override for the auto-commit message timeout. |
| `auto_commit_cooldown_ms` | Test override for the auto-commit cool-down window. |
| `sentry_api_base_url` | Test override for the Sentry API base. |
| `script_parks` | Script supervisor pre-registration park. |
| `completion_classify_park` | Completion classify-to-mark park. |
| `hook_wake_park` | Hook wake park (test-hooks). |
| `hook_eval_park` | Hook eval park (test-hooks). |
| `completion_claim_park` | Completion claim-to-send park. |
| `completion_flip_take_park` | Flipped-completion take-to-publish park. |
| `attention_write_park` | Attention write park. |
| `unread_settle_entry_park` | Unread settle entry park. |
| `fold_hit_park` | PR cache-hit fold park. |
| `wake_archived_park` | Wake archived-gate park. |
| `task_update_projection_park` | task.update projection park. |
| `archive_tail_park` | Archive post-commit tail park. |
| `archive_predrop_park` | Archive pre-drop park. |
| `queue_mutation_gate_park` | Per-id queue mutation park. |
| `test_busy` | Simulated busy agents; empty in production. |
| `github_login_base_uri` | Test override for the GitHub login host. |
| `isolated_secrets_dir` | Scratch secrets directory of new_isolated. |
| `invite_create_commit_pause` | Mutation barrier (cfg(test)). |
| `member_removal_commit_pause` | Mutation barrier (cfg(test)). |
| `invite_join_commit_pause` | Mutation barrier (cfg(test)). |
| `invite_join_admission_pause` | Mutation barrier (cfg(test)). |
| `member_removal_publication_pause` | Mutation barrier (cfg(test)). |
| `queue_drain_commit_pause` | Mutation barrier (cfg(test)). |
| `github_api_base_uri` | Test override for the GitHub API base. |
| `gitlab_api_base_uri` | Test override for the GitLab API base (None in production: env, then the instance origin). |
| `periodic_commit_hold` | Periodic commit hold (cfg(test)). |
| `git_diffs_walk_probe` | git.diffs walk probe. |
| `git_status_scan_probe` | Status scan probe. |
| `hook_clock_skew` | Hook TTL clock skew. |
| `hook_store_fault` | Hook persistence fault injector (test-hooks). |
| `pr_cache_max_age_seconds` | Override for prCache.maxAgeSeconds; production reads settings. |
| `pr_read_park` | On-demand PR read park. |
| `pr_monitor_poll_seconds` | Override for prMonitor.pollSeconds. |
| `pr_monitor_hourly_request_budget` | Override for prMonitor.hourlyRequestBudget. |
| `pr_monitor_quota_share_percent` | Override for prMonitor.quotaSharePercent. |
| `pr_monitor_debounce_seconds` | Override for prMonitor.debounceSeconds. |
| `pr_monitors_max_per_agent` | Override for prMonitor.maxPerAgent. |
| `test_review_monitoring_recipient` | Fixture receipt (cfg(test)). |
| `test_review_monitor_write_ready` | Write-ready notify (cfg(test)). |
| `interrupted_list_park` | Interrupted list park (cfg(test)). |
| `interrupted_resume_park` | Interrupted resume park (cfg(test)). |
| `workspace_delete_test_gate` | Workspace delete gate (cfg(test)). |
| `pending_delete_test_gate` | Pending delete gates (cfg(all(test, unix))). |
