> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.8 `script.*`.

### 5.8 `script.*`

| Method | Params | Result |
| --- | --- | --- |
| script.list | workspaceId (req), archive? (`active` \| `archived` \| `all`, default `all`) | { scripts: [...] } — definition plus `runtime`; see the prepared lifecycle extension below |
| script.create | workspaceId (req), name (req), command (req), mode (req: `service` \| `command`), cwd?, env?, category?, autoStart?, scriptId?, purpose? (`saved` \| `oneOff`) | { id, workspaceId, name, command, mode, source, createdAt, cwd?, env?, category?, autoStart?, updatedAt?, purpose?, archivedAt?, lastRun? } — the persisted `WorkspaceScript` record |
| script.archive | workspaceId (req), scriptIds (req: nonempty string array) | { archived: [scriptId, ...], skipped: [{ scriptId, reason }] } — prepared extension; inactive commands only |
| script.restore | workspaceId (req), scriptIds (req: nonempty string array) | { restored: [scriptId, ...], skipped: [{ scriptId, reason }] } — prepared extension; restores visibility without starting |
| script.remove | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.start | workspaceId (req), scriptId (req) | { ok, scriptId } — the runtime status is flipped to `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) **before the reply**, atomically with the supervisor's registration and with the previous run's terminal fields (`pid`, `startedAt`, `exitCode`, `stoppedAt`, `error`, `detectedUrl`) cleared, so a `script.status` read after the reply never observes the pre-launch `idle`; the owned launch task publishes the `starting` transition as `script:state` strictly ahead of the spawn's `running` (or `exited` + `error` on a launch failure). A script already `running` or `starting` is a no-op |
| script.stop | workspaceId (req), scriptId (req) | { ok, scriptId } — on a **non-running** script that carries the was-running marker this is the **dismiss** affordance: it clears the marker (`previouslyRunning` on a service row, the hydrated `lost` reading on a command row; in memory plus a best-effort row write), emits a `script:state` snapshot (§6.5), and returns ok instead of erroring |
| script.restart | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.output | workspaceId (req), scriptId (req), maxLines? | output buffer text |
| script.status | workspaceId (req), scriptId (req) | { status, restartCount, pid?, exitCode?, startedAt?, stoppedAt?, error?, detectedUrl?, previouslyRunning? } — the `ScriptRuntimeState` snapshot; `status` and `restartCount` are always present, every other field is **omitted when unset** (never `null` — a cleared `exitCode` is absent, so hooks test `exitCode !== undefined`); `status` is one of `idle \| starting \| running \| restarting \| exited`. `exited` **always** carries `exitCode` (new in intentd, unreleased): when the real status was not observable it is the sentinel `-1` together with an `error` naming the cause — see the total exit contract note below. `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) is the `script.start` launch window: set synchronously before `script.start` replies, with the previous run's terminal fields cleared, and held until the spawn's `running` (or `exited` on a launch failure), so a poll issued right after `start` never reads the pre-launch `idle` or a stale `exitCode`. `restarting` (new in intentd, monorepo#1318) is the transient restart-in-flight state between an exit and the next spawn attempt — the service auto-restart backoff window and the `script.restart` stop→start gap — so a poll taken mid-restart never reads as a final `exited`/`idle`; the respawn flips it back to `running`. `previouslyRunning?: true` (new in intentd, within v5.1) marks a **service** script that was running when the daemon last stopped; a command script in the same situation hydrates as `exited` / `exitCode: -1` / `error` instead — see the was-running marker note below |
| script.run | workspaceId (req), scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } — `exitCode` follows the same total exit contract as the runtime state (new in intentd, unreleased): `-1` when the exit was unobservable — see the total exit contract note below |

> **Prepared lifecycle extension.** The additive purpose/archive fields, filters and
> archive/restore methods above are gated by `scriptLifecycle: 1`, as specified
> below. Archive preserves the existing runtime and manual-stop semantics;
> the extension adds retention and compact result metadata, not new statuses.

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
> `idle | starting | running | restarting | exited`. `starting` (new in intentd, within v9.12 —
> intent-hq/intent#4858) covers the `script.start` launch window: `script.start` flips the
> status under the same registry lock as its already-running guard — atomically with
> spawning and registering the supervisor task, and clearing the previous run's `pid` /
> `startedAt` / `exitCode` / `stoppedAt` / `error` / `detectedUrl` (cleared fields are
> **omitted** from the serialized state, never `null`) — **before it replies**,
> so a `script.status` read after the reply never observes the pre-launch `idle` or a stale
> terminal field. The owned supervisor task publishes the `starting` transition as
> `script:state` strictly ahead of the spawn's `running` (or `exited` + `error` on a launch
> failure); the reply does not wait for that publish. `starting` is as exclusive as
> `running` — a second `script.start` inside the window is a no-op, `script.run` inside it
> returns the already-running `warning`, and `script.stop` inside it awaits the owned
> supervisor (whose spawn is refused and reaped) and settles the status back to `idle` with
> a `script:state`. `restarting` (new in intentd, monorepo#1318) covers
> the restart-in-flight window — a service auto-restart's backoff between an exit and the next
> spawn attempt, and `script.restart`'s stop→start gap — distinguishing it from a final exit;
> the respawn flips it back to `running` (no `starting` is emitted for the restart gap).
> Clients should treat any status other than `idle` / `exited` as live (the FE's
> `isLiveScriptStatus` allowlist), so future transitional states degrade correctly.
>
> **Total exit contract (`exited` always carries `exitCode`, new in intentd, unreleased).** `exited`
> is terminal and every path that ends a run records an `exitCode`, so the exit-only hook
> condition `s.status === "exited" && s.exitCode !== undefined` is total: a script whose
> process is gone can no longer sit at a status the hook never matches (a saved gate run
> that died externally once left its hook waiting until it expired). When the real status
> was not observable, `exitCode` is the sentinel `-1` and `error` names the cause:
>
> - a spawn/cwd failure — the existing launch-failure `error` text;
> - `exit status unobservable` — the child was reaped out-of-band, the PTY host dropped the
>   session, or the recorded pid is gone without a reported status; the supervisor's liveness
>   backstop detects a provably gone process within its exit-poll interval (a zombie —
>   exited but not yet reaped — does not count);
> - `lost: the daemon stopped while the script was running` — a command-mode script that was
>   live when the daemon last stopped, hydrated from the was-running marker (below).
>
> A real process exit never yields `-1`: treat it as a failure, read `error`, and do not
> re-poll — the reading is final until the next `script.start` clears the terminal fields.
> One contract, both surfaces: the runtime state (`script.status`, `script.list`,
> `script:state`) and the `script.run` result's own `exitCode?` follow the same rule — `-1`
> whenever the exit was unobservable, never a placeholder code.
>
> **Was-running marker (`previouslyRunning?`, new in intentd, within v5.1).** Closing the app
> stops the daemon and kills every running script, and boot hydration previously loaded all
> persisted definitions as plain `idle` — so clients could not tell which scripts were live
> before the shutdown. The daemon persists a was-running marker on the script row
> (stored-on-write) and surfaces it **by mode**: a `service` row hydrates as `idle` with the
> optional `previouslyRunning: true` field on `ScriptRuntimeState` — served by
> `script.status`, the runtime part of `script.list` entries, and `script:state` events
> (§6.5) — and a `command` row (new in intentd, unreleased) hydrates as `exited` + `exitCode: -1` +
> `error: "lost: the daemon stopped while the script was running"` **without**
> `previouslyRunning` (clients render that flag as a restore affordance, which does not apply
> to a one-shot command). `previouslyRunning` is **omitted when false**, so clients detect it
> by presence, not by protocol version.
>
> Semantics:
>
> - **Set by every successful start/restart**, in both modes (new in intentd, unreleased —
>   previously `service`-mode only). `previouslyRunning` stays service-only on the wire.
> - **Cleared** on a user `script.stop`, on natural exit, and on `script.remove` (the row goes
>   with it); a `script.create` upsert resets it. Starting a marked script clears it — the
>   hydrated `previouslyRunning` (or `lost` reading) drops as the state flips to `running`
>   (an auto-restart's respawn re-sets the marker).
> - **Survives repeated daemon restarts** untouched: a marked service row keeps hydrating as
>   `idle` with `previouslyRunning: true`, and a marked command row as `exited` / `-1` /
>   `lost`, until the script is started or explicitly stopped.
> - **Dismiss:** `script.stop` on a non-running script that carries the marker clears it —
>   in memory and, via the same best-effort persist as every other transition, on the row —
>   and returns ok (instead of erroring), and **emits a `script:state` event** carrying the
>   cleared state (plain `idle`), so other subscribers do not retain a stale
>   `previouslyRunning: true` (or `lost` reading); the row hydrates as plain `idle` after the
>   next restart.
> - **Workspace-scoped.** The runtime registry permits the same client-supplied `scriptId` in
>   separate workspaces, so marker reads and writes are qualified by `workspaceId` — setting
>   or clearing the marker in one workspace never touches a same-id script in another.
> - Marker writes are **best-effort**: a failed bookkeeping write is logged and never fails the
>   runtime transition or its `script:state` event. Persistence is therefore not guaranteed on
>   any path, dismiss included — if the clearing write fails, the marker stays on the row and
>   rehydrates as `previouslyRunning: true` (or the `lost` reading) after the next daemon
>   restart, and the client can dismiss it again.


#### Saved scripts and one-off history (prepared additive extension)

This contract leads implementation; it does not claim a shipped daemon version.
Advertise `client.hello.server.capabilities.scriptLifecycle: 1` only when the
complete extension below is implemented, including persistence, completion,
concurrency protection and the agent bindings. Allocate the next protocol minor
against main at implementation time. The existing methods and status enum remain;
`script.archive` and `script.restore` are the only new RPC names. History is a view
of retained definitions and their latest result, **not a per-run log archive**.

**Definition fields and compatibility.** A supporting daemon always returns
`purpose: "saved" | "oneOff"` on definitions (`script.create` and `script.list`).
`archivedAt?: string` is an RFC 3339 UTC timestamp, omitted while active, never
`null`. Archive state and purpose persist across restart. `lastRun?` is the compact
persisted command result described below; it is absent if no result is known.
These fields belong to the definition, not `ScriptRuntimeState`.

- New definitions default to `saved` when `purpose` is omitted. Every pre-existing,
  imported or repository-config definition without explicit purpose stays `saved`.
  Never infer one-off purpose from source (including `source=user`), name, command,
  category, age, idle status, agent ownership, or lack of output.
- `oneOff` is an explicit retention choice for `mode: "command"`; `mode` still
  controls execution. Reject `oneOff` with `mode: "service"` or `autoStart: true`
  as `-32602` invalid params, without mutation. Unknown purpose/archive-filter
  values and explicit `null` are invalid params too. Services are never retired
  automatically and are excluded from command archive selection.
- A new client on an older daemon treats absent purpose as `saved` and absent
  archive metadata as active. Without `scriptLifecycle: 1`, hide history/archive
  controls and do not send lifecycle fields, filters or mutations. Old parsers
  can silently ignore unknown fields: a successful create is **not** proof that
  one-off retirement is supported. Never fall back to `script.remove`.
- Old clients on a supporting daemon keep creating saved definitions and can
  start/status/output known IDs as before. They ignore additive fields and
  continue receiving **all definitions when the wire filter is omitted**, even
  after `script:changed` triggers a refetch. This preserves their existing row
  maps, selected output and runtime failure state. They cannot show the new
  History view or remove archived rows from their ordinary list; upgrading the
  client enables those affordances. Server capability advertisement alone does
  not change legacy client behavior. A stale new-method request to an older
  daemon can return method-not-found or Forbidden at its collaborator allowlist;
  surface it without claiming success.

**Lists and history.** On the wire, omitted `archive` is equivalent to
`archive: "all"`, preserving the existing unfiltered result for legacy clients.
`"active"` selects definitions without `archivedAt`, `"archived"` selects history,
and `"all"` selects both. Lifecycle-aware frontend normal lists and the updated
MCP helper's default list **explicitly send `archive: "active"`**; that is how
finished one-offs leave the normal view without changing older clients' lists.
History sends `"archived"`; retained/open-ID recovery can send `"all"`. When the
capability is absent, the frontend omits the filter and retains legacy behavior.
Every selection returns the same `{ scripts: [...] }` envelope and full
definitions with `runtime`. Preserve the existing oldest-created-first order,
breaking equal `createdAt` ties by `id`. Clients may sort History by `archivedAt`
locally. There is no implicit age cutoff, deletion or pagination in this extension.
Bootstrap from repository config only if the workspace has **no definitions at
all**; an empty filtered view must not recreate archived definitions.

**Explicit archive and restore.** Both RPCs take only the named workspace and
an explicit selection of 1–1,000 nonempty `scriptIds` (limit checked before
deduplication; duplicates deduplicated in first-occurrence order). Validate the whole request and workspace authority
before mutation. Each selected ID gets exactly one outcome, preserving input
order within the success and skipped arrays. Archive reasons are `live`,
`service`, and `notFound`; restore's only skipped reason is `notFound`. Foreign
and absent IDs are indistinguishable `notFound`. For archive, check existence,
then service mode, then liveness. No command text or metadata is returned for a
skipped ID. An already archived command counts as `archived` without changing
its timestamp; an already active definition counts as `restored`. Repetition is
safe. A service can be a restore no-op, but can never be newly archived here.

The batch is deliberately **per-ID**, not all-or-nothing: eligible entries can
succeed while a concurrent start makes another entry `live`. Persistence errors
fail the RPC with `-32603`; earlier IDs may have committed. Re-read the list and
retry the same selection to reconcile. Never report an ID archived/restored
until its durable update commits. Skip/no-op entries emit no change event.
Restore clears `archivedAt`, preserving purpose, latest result, current runtime
and available output; it does not start a process. A restored one-off remains a
one-off and retires again after its next settled run. To make it reusable,
explicitly replace it with `purpose: "saved"` using `script.create`.

**Atomic protection.** A command can be archived only when its status is `idle`
or final `exited` **and** it has no live process, pending launch/run reservation,
supervisor teardown or restart operation. Treat unknown future states as live.
This check and the archive commit must serialize against `start`, `run`,
`restart`, definition replacement and removal; a list-then-update check is not
sufficient. Archive must never stop, kill, detach, evict the runtime entry,
clear its PTY/output handle, or synthesize an exit. Protect the complete restart
stop→start gap, including a momentary predecessor exit. Completion work must
validate both definition identity and the specific admitted run, so a delayed
completion cannot archive a replacement or a newer run with the same ID.

For a start/archive race there are only two legal orders: start reserves first
and archive reports `live`; or archive commits first and start restores before
reserving the launch. An archived live process is never a legal result. Apply
the same rule to `script.run`'s pre-spawn reservation and all restart paths.
A restore/start persistence failure refuses the new launch; no process is
started hidden in history. Keep authorization and durable writes qualified by
workspace, with the same member/owner permissions as script definition edits.
Non-members cannot discover the workspace or scripts through this extension;
connection allowlists and service-level scope checks both cover the new methods.

**Completion, failure and cancellation.** An explicitly one-off command moves
to history after its admitted run has **settled**, whether it succeeded, failed,
was cancelled, timed out, or was interrupted. Settlement requires that its
process and launch/run reservation have ended and no restart is pending. Never
retire a never-run `idle` definition or a transient idle/exit during restart.
Saved commands and services never auto-archive. Publish the final runtime state
where the existing path emits `script:state` before the archive invalidation;
all prior output chunks keep their existing ordering. A stop path that already
resets to idle without a state event need not invent one; its archive invalidation
still follows settlement. Do not hide a run before final output/state can be read.

Failure must not disappear silently: History renders the recorded result and
error, and its entry point visibly signals failed/cancelled/interrupted entries.
Those outcomes retire just like success; the indication must not depend on a
transient toast, output buffer, or a selected script still being in the active
list. There is no inferred age/command-name/success-count cleanup policy.
Automatic archive write failure keeps the row active, logs the persistence
error, and leaves the real terminal state intact; it must not turn a successful
command into a failed command or lose its output.

Manual-stop behavior is **unchanged**, including `idle` after stopping a launch
before spawn or resetting a settled script. Archive itself never clears or
rewrites that state. Stopping an admitted one-off records a `cancelled` result
once teardown settles, even if the terminated child reports 0; stopping a
never-run idle command creates no result and does not auto-archive. Stopping an
already settled script is not a new run: preserve its preceding result and
archive state while applying existing runtime/dismiss semantics. The stop phase
of `restart` is not final completion and cannot trigger retirement.

Cancellation of an RPC waiter alone is not a user stop: once an owned launch or
completion task has taken over, it continues supervising normally. A dropped
`script.run` waiter before spawn releases its reservation without fabricating a
completed run, with the entry left active (even if starting it restored it from
history). Its previous result remains available. A timeout that kills a spawned
command records `cancelled` and a timeout diagnostic, keeps `timedOut: true` on
the existing run result, and retires after teardown settles.

**Compact last result and restart.** After a command attempt settles, persist
`lastRun: { outcome, exitCode?, startedAt?, stoppedAt, error? }`. `outcome` is
`succeeded | failed | cancelled | interrupted`; timestamps are RFC 3339 UTC.
Use the same observed exit code or `-1` diagnostic as an `exited` runtime reading.
When cancellation ends at `idle` before spawn with no observed exit, omit
`exitCode` rather than inventing a process result. `startedAt` is absent when no
process started. `error` describes launch failure, cancellation, timeout or
unobservable exit when applicable. A spawn/cwd failure is `failed`; an
unobservable process exit or daemon loss is `interrupted`. Nonzero observed exit
is `failed` unless cancellation/interruption is known. `succeeded` requires an
observed 0 with none of those conditions. Persist this bounded latest-result
metadata for commands of either purpose; do not invent outcomes for legacy idle
definitions or reconstruct them from names or output. No durable stdout/stderr,
PID, per-run ledger, or full runtime snapshot is promised.

Keep the preceding `lastRun` during a new launch (label it as a **previous**
result while live); replace it when that attempt settles. Starting clears the
runtime terminal fields as before. A definition upsert clears `lastRun` because
it replaces the command definition. Automatic archive and that run's result
must be persisted together, so history cannot contain a newly retired one-off
with no result, including failure/cancellation. A result write failure is logged,
the terminal state remains readable in memory and auto-archive is withheld;
restart durability cannot be claimed when the database rejected the write.
Manual archive of a legacy definition with no known result remains allowed;
History shows that outcome as unknown, never as success.

Hydrate archived definitions too, retaining their IDs, archive timestamps and
last results; never start them automatically. Runtime hydration remains the
existing behavior: a completed command normally returns to `idle` after daemon
restart; History reads `lastRun` instead of mistaking that transient state for an
unknown/successful result. A command live at daemon shutdown instead hydrates as
the existing `exited` / `-1` / `lost: the daemon stopped while the script was running`
reading, with `lastRun.outcome: "interrupted"` persisted; an explicit one-off then
retires after recovery settlement, while a saved command remains active. The
recovery marker takes precedence over an older successful result. Cover accepted
launches and run/restart reservations too; do not let a restart between admission
and spawn turn unfinished work into a success or an unmarked idle row. When the
exact stop time is unobservable, `lastRun.stoppedAt` is the recovery observation
time, not a claim about the process's exact exit time. Repeated hydration of the
same interrupted run is idempotent: retain its first archive timestamp and
recorded result rather than creating another completion. Service recovery and
existing was-running dismiss semantics remain unchanged.

**Rerun and replacement.** `start`, `run`, and `restart` of an archived ID
restore it durably before accepting a launch. They preserve its purpose and ID,
clear the runtime terminal fields for the new run and publish the restoration
invalidation before that run's first live state event. Existing duplicate-start
no-op / already-running warning behavior extends across every live reservation,
including `restarting`. Do not schedule a second launch to restore an already
live entry. Restore-only leaves terminal status/output untouched. A
`script.create` upsert with the same ID intentionally replaces the definition
and restores it, preserving existing source/creation identity behavior. Omitted
purpose preserves the existing purpose (new IDs alone default to `saved`);
explicit purpose replaces it, subject to mode validation. Changing an existing
one-off to service therefore requires explicit `purpose: "saved"`. Existing
upsert teardown behavior is unchanged: unlike archive, replacement can stop the
old process. Completion from the replaced run cannot retire its replacement.

**Events and completion hooks.** Reuse `script:changed` with existing payload
`{ scriptId, action: "updated" }` for real archive/restore transitions and last
result updates (coalesce result+archive into one invalidation). Do not emit
`action: "removed"` for archive. No new event type or runtime status is added.
Consumers invalidate and refetch the selected list, retain direct status/output
handles, and must not add a hidden row back to the active list merely because a
`script:state` arrives. New subscribers/reconnects obtain authoritative archive
state from `script.list`; invalidation events alone are not a row snapshot.

Archive does **not** cancel completion hooks or subscriptions. After `start`
returns, hooks keep using direct `status`/`output` by ID even after the row leaves
the lifecycle-aware active list. Natural exit and failure still satisfy
`state.status === "exited" && state.exitCode !== undefined`; a hook that also
handles manual stop must accept `idle` after launch acceptance, as with the
existing manual-stop contract. Never gate on `exitCode` alone, and keep waiting
through `starting`, `running` and `restarting`. Archive must not reset an
`exited` reading to idle or remove its error. Direct `script.output` reads the
same available buffer and must not fail because the ID is archived.

Selected/open output tabs and their subscriptions survive archive. Keep a
retained row/ID outside the active-list filter or resolve it with `archive: "all"`;
do not close a tab, clear selection/output, or treat an absent active-list row
as deleted. On reconnect, recover archived open IDs through the all/history
view. Restore makes the entry visible without opening a new process/tab.
PTY scrollback remains transient and may be empty after daemon restart; an empty
buffer is not success. Rerun, replacement and explicit removal retain their
existing output lifetime limits. Hooks track the current run of an ID, not an
immutable run ledger: callers needing independent completion watches must use
distinct IDs or finish observing the preceding run before reusing its ID.

**Agent API (prepared signatures, not installed bindings).** Implement these
helpers together with the capability; the generated binding index continues to
represent only the pinned implementation:

```text
ws.script.list({ archive? }?) → [scripts]
ws.script.create(name, command, mode, { ...options, purpose? }) → { id }
ws.script.archive(scriptIds) → { archived, skipped }
ws.script.restore(scriptIds) → { restored, skipped }
```

List remains an unwrapped array. The updated helper defaults an omitted options
bag or omitted `archive` option to an explicit wire `archive: "active"`; passing
`"archived"` or `"all"` forwards that choice. Older helper implementations that
omit the wire filter continue receiving all definitions. Archive/restore return
the RPC batch result.
Workspace scope is injected by the host as for existing helpers; no
caller-supplied cross-workspace escape is added. Existing no-argument `list()`
and create/start/status/output signatures remain valid. Teach callers to opt into `purpose: "oneOff"` for
throwaway checks, retain `saved` for reusable commands/services, and never use
remove as automatic cleanup. The generated MCP binding index reflects the
installed implementation and is regenerated when that implementation lands.

Prepared examples and race expectations are in
[`fixtures/scripts/lifecycle.json`](../fixtures/scripts/lifecycle.json).
They are synthetic contract inputs, not evidence of implemented runtime behavior.
Run their static consistency checks with
`node --test docs/protocol/fixtures/scripts/contract.test.mjs`; component tests
must later exercise these scenarios with isolated databases and controlled
launch/completion race barriers before advertising support.
