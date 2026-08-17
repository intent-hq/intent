> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.8 `script.*`.

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

