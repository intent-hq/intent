> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.8 `script.*`.

### 5.8 `script.*`

| Method | Params | Result |
| --- | --- | --- |
| script.list | workspaceId (req) | { scripts: [...] } |
| script.create | workspaceId (req), name (req), command (req), mode (req: `service` \| `command`), cwd?, env?, category?, autoStart?, scriptId? | { id, workspaceId, name, command, mode, source, createdAt, cwd?, env?, category?, autoStart?, updatedAt? } — the persisted `WorkspaceScript` record |
| script.remove | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.start | workspaceId (req), scriptId (req) | { ok, scriptId } — the runtime status is flipped to `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) **before the reply**, atomically with the supervisor's registration and with the previous run's terminal fields (`pid`, `startedAt`, `exitCode`, `stoppedAt`, `error`, `detectedUrl`) cleared, so a `script.status` read after the reply never observes the pre-launch `idle`; the owned launch task publishes the `starting` transition as `script:state` strictly ahead of the spawn's `running` (or `exited` + `error` on a launch failure). A script already `running` or `starting` is a no-op |
| script.stop | workspaceId (req), scriptId (req) | { ok, scriptId } — on a **non-running** script that carries the was-running marker this is the **dismiss** affordance: it clears the marker (`previouslyRunning` on a service row, the hydrated `lost` reading on a command row; in memory plus a best-effort row write), emits a `script:state` snapshot (§6.5), and returns ok instead of erroring |
| script.restart | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.output | workspaceId (req), scriptId (req), maxLines? | output buffer text |
| script.status | workspaceId (req), scriptId (req) | { status, restartCount, pid?, exitCode?, startedAt?, stoppedAt?, error?, detectedUrl?, previouslyRunning? } — the `ScriptRuntimeState` snapshot; `status` and `restartCount` are always present, every other field is **omitted when unset** (never `null` — a cleared `exitCode` is absent, so hooks test `exitCode !== undefined`); `status` is one of `idle \| starting \| running \| restarting \| exited`. `exited` **always** carries `exitCode` (new in intentd, unreleased): when the real status was not observable it is the sentinel `-1` together with an `error` naming the cause — see the total exit contract note below. `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) is the `script.start` launch window: set synchronously before `script.start` replies, with the previous run's terminal fields cleared, and held until the spawn's `running` (or `exited` on a launch failure), so a poll issued right after `start` never reads the pre-launch `idle` or a stale `exitCode`. `restarting` (new in intentd, monorepo#1318) is the transient restart-in-flight state between an exit and the next spawn attempt — the service auto-restart backoff window and the `script.restart` stop→start gap — so a poll taken mid-restart never reads as a final `exited`/`idle`; the respawn flips it back to `running`. `previouslyRunning?: true` (new in intentd, within v5.1) marks a **service** script that was running when the daemon last stopped; a command script in the same situation hydrates as `exited` / `exitCode: -1` / `error` instead — see the was-running marker note below |
| script.run | workspaceId (req), scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } — `exitCode` follows the same total exit contract as the runtime state (new in intentd, unreleased): `-1` when the exit was unobservable — see the total exit contract note below |

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

