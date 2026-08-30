> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.40 Background hooks — `hook.*`.

### 5.40 Background hooks — `hook.*` *(v2.10)*

A **background hook** is a small agent-authored JS script the daemon runs on one of
three **schedule kinds** — a fixed `delayMs` cadence, a recurring `cron` expression, or
a one-shot `runAt` timestamp (within v8.7, intentd#1586; see the schedule-kinds block
below) — until it *dispatches* (wakes its owning agent with a message and ends), fails
(is *evicted* and wakes the owner with the error), is *cancelled*, or *expires* (its
TTL passes — v3.1). Hooks let an agent
watch for a condition (CI results, file changes) without burning turns polling. (For PR
watching specifically, agents are steered to the centralized `ws.pr.monitor` instead —
§5.42, v6.1 — since a hook's TTL expires while a PR sits blocked and a monitor's does
not.)
Per the §6.8 principle, **scheduling is not on the wire**: hooks are created only by
agents via the `ws.hook.schedule` MCP binding (`{ name ≤ 50 chars, code, delayMs ≥
10000 | cron | runAt, ttlMs?, perpetual? }` — exactly ONE schedule kind is required
(within v8.7, see the schedule-kinds block below); `name` is a short human-readable description shown to the user
(cap raised from 19 within v5.1, intentd#929); the first run happens immediately as validation — a failing script rejects the
call, a dispatching one wakes without persisting a schedule — unless the hook is
**perpetual**, whose dispatching validation run wakes the owner AND persists the active
schedule (see the perpetual block below); per-agent cap on active
hooks, default 5). Every hook carries a **TTL** (v3.1) counted from creation, not the
last run: for `delayMs` hooks `ttlMs` defaults to and is capped at 86 400 000 (24 hours — raised from the
original 60-minute cap within v7.0, [intent-hq/intentd#1290](https://github.com/intent-hq/intentd/pull/1290);
values are clamped into `[10000, 86400000]`, never rejected); `cron` hooks lift the cap —
`ttlMs` defaults to and is capped at 7 days (same 10-second floor); a `runAt` hook's
expiry is implied (fire time + 1-hour grace) and an explicit `ttlMs` is rejected (see the
schedule-kinds block below). `expiresAt` (= `createdAt` + clamped `ttlMs`, or the implied
`runAt` deadline) persists on the Hook. When the deadline passes the daemon stops the hook (terminal
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
| hook.runNow | workspaceId (req), hookId (req) | `{ ok: true, hookId }` — ack only; the triggered run's outcome surfaces as `hook:*` events. The hook's inter-run timer resets after the run (a `cron` hook's next fire is recomputed from the expression; a `runAt` hook fires its one shot early and retires — schedule-kinds block below) |

**Hook** — `{ hookId, workspaceId, agentId, name, code, delayMs, cron?, runAt?, state,
createdAt, expiresAt?, lastRunAt?, nextRunAt?, runCount, perpetual, dispatchCount, lastError?,
lastLogs?, lastState? }` with
`state ∈ scheduled | running | dispatched | evicted | cancelled | expired`
(`scheduled`/`running` are the active states;
`runCount` includes the schedule-time validation run; `lastError` is set on eviction —
and, from [intent-hq/intentd#1410](https://github.com/intent-hq/intentd/pull/1410)
(monorepo#3231), also on a **non-evicting** run whose in-script host exec calls failed
(nonzero exit code or timeout without a script throw): the run completes as the script
decided, but a capped failure summary — at most 5 lines of command / exit-or-timeout /
stderr snippet — persists to `lastError` on the still-active hook so a silently broken
check is observable, and a later run whose execs all succeed clears it).
`perpetual` (bool) and `dispatchCount` (number) are the perpetual-hook fields
([intent-hq/intentd#979](https://github.com/intent-hq/intentd/pull/979)): `dispatchCount`
counts **fires so far** for every hook created or updated from v6.0 on — a one-shot hook's
sole fire counts too, so only a perpetual hook ever exceeds 1 — and both are always present
(the additive defaulted migration backfills pre-existing rows to `perpetual: false` /
`dispatchCount: 0` unconditionally, so a retained pre-migration row that had already
dispatched reads back `dispatchCount: 0` despite having fired — the "fires so far" contract
only holds going forward, not retroactively for that one field on migrated rows).
`expiresAt` (v3.1) is the TTL deadline (`createdAt` + clamped `ttlMs` — ≤ 24 hours from
creation for `delayMs` hooks, ≤ 7 days for `cron` hooks — or the fire time + 1-hour grace
for `runAt` hooks); it is set on every hook scheduled from v3.1 on and absent only on pre-TTL
legacy rows, which never expire.
`cron` / `runAt` (within v8.7,
[intent-hq/intentd#1586](https://github.com/intent-hq/intentd/pull/1586)) are the
schedule-kind fields — presence-detected additive fields, each present only on a hook of
that kind: `cron` is the recurring 5-field cron expression (evaluated in UTC), `runAt`
the one-shot RFC3339 fire time (normalized to UTC on persist). `delayMs` serializes as
`0` for both new kinds, and pre-existing rows read back with both fields absent (additive
nullable migration `0107_hook_schedule_kinds.sql`) — `delayMs` hooks are byte-for-byte
unchanged on the wire.
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

**Schedule kinds: `cron` and `runAt`** (within v8.7 — additive Hook wire fields plus
MCP-only schedule params, no method-catalog change;
[intent-hq/intentd#1586](https://github.com/intent-hq/intentd/pull/1586)).
`ws.hook.schedule` accepts **exactly one** of `delayMs` | `cron` | `runAt` — zero or more
than one schedule kind is rejected at schedule time. All three kinds share the same run
contract (validation-run semantics, dispatch/evict/cancel outcomes, `hookState`
carry-over, log capture, `hook:*` events, per-agent cap, the never-start-at/after-
`expiresAt` guard, and the in-flight-run-at-expiry rule); the kinds differ only in how
the next fire and the TTL are computed:

- **`delayMs`** (the original fixed cadence) is unchanged: inter-run delay in ms
  (≥ 10 000), `ttlMs` clamped into `[10000, 86400000]` with the 24-hour default/cap.
- **`cron`** is a recurring standard **5-field** cron expression (minute hour
  day-of-month month day-of-week — no seconds field), evaluated in **UTC**. Invalid or
  six-field expressions are rejected at schedule time. The next fire is recomputed from
  the expression after **every** run — natural ticks, `hook.runNow`, and the perpetual
  dispatch re-arm alike — so a triggered early run never skews the cadence. An
  expression with no computable future occurrence at schedule time is rejected; one
  that becomes **exhausted** later (no next occurrence after a run) expires the hook
  (terminal `expired`, owner woken) rather than leaving the row active with no future
  fire. Because meaningful cron cadences (nightly, weekly) outlive the 24-hour cap,
  `ttlMs` for cron hooks defaults to and is capped at **7 days** (floor unchanged).
  `perpetual` composes as usual.
- **`runAt`** is a **one-shot** fire at a future RFC3339 timestamp (any offset accepted,
  normalized to UTC on persist; non-RFC3339 or past timestamps are rejected, as is one
  so far out that fire + grace would overflow the supported date range — "too far in
  the future", a validation error, never a panic). `nextRunAt` is the fire time itself, and the expiry is **implied**:
  `expiresAt` = fire time + a fixed **1-hour grace** window — an explicit `ttlMs` and
  `perpetual: true` are both rejected (a one-shot timer has nothing to re-arm). After
  the fire the hook **retires regardless of outcome**: a dispatching run retires it
  through the normal dispatch path (`dispatched`, owner woken with the message), and a
  non-dispatching fire retires it as `expired` with a distinct **timer-fired** wake
  (the notice says the one-shot timer fired, not that a TTL elapsed; same `hook:expired`
  event and `reason: "expired"` wake metadata as TTL expiry). `hook.runNow` fires the
  one shot early and retires it the same way. The grace window is the watchdog for a
  fire missed while the daemon was down: a `runAt` row whose fire time passed during
  downtime still runs at boot rehydration (overdue ⇒ immediate), while one past
  `expiresAt` is expired like any other hook.

Restart rehydration is kind-aware: `cron` and `runAt` rows resume to their **absolute**
persisted deadline (overdue ⇒ immediate run), while `delayMs` rows resume to the earlier
of the persisted deadline and a fresh `now + delayMs` countdown, exactly as before.


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
- **Everything else is unchanged.** TTL semantics (24-hour cap; perpetual does not
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

