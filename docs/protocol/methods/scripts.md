> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.8 `script.*`.

### 5.8 `script.*`

The prepared [script monitor extension (§5.8a)](./script-monitors.md) adds
run identity, one-shot agent monitoring and guarded user cancellation under
`scriptMonitors: 1`. Existing script controls keep their current semantics.

The [prepared service readiness extension](#service-readiness-prepared-additive-extension)
adds optional `healthUrl` / `readyPattern` definition inputs and `ready` /
`readiness` runtime fields. These are capability-gated, not yet shipped.

| Method | Params | Result |
| --- | --- | --- |
| script.list | workspaceId (req), archive? (`active` \| `archived` \| `all`, default `all`) | { scripts: [...] } — definition plus `runtime`; see the 10.11 lifecycle candidate below |
| script.create | workspaceId (req), name (req), command (req), mode (req: `service` \| `command`), cwd?, env?, category?, autoStart?, scriptId?, purpose? (`saved` \| `oneOff`), healthUrl?, readyPattern?, clearReadiness? (prepared; see below) | { id, workspaceId, name, command, mode, source, createdAt, cwd?, env?, category?, autoStart?, updatedAt?, purpose?, archivedAt?, lastRun?, healthUrl?, readyPattern? } — the persisted `WorkspaceScript` record |
| script.archive | workspaceId (req), scriptIds (req: nonempty string array) | { archived: [scriptId, ...], skipped: [{ scriptId, reason }] } — 10.11 candidate; inactive commands only |
| script.restore | workspaceId (req), scriptIds (req: nonempty string array) | { restored: [scriptId, ...], skipped: [{ scriptId, reason }] } — 10.11 candidate; restores visibility without starting |
| script.remove | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.start | workspaceId (req), scriptId (req) | { ok, scriptId } — the runtime status is flipped to `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) **before the reply**, atomically with the supervisor's registration and with the previous run's terminal fields (`pid`, `startedAt`, `exitCode`, `stoppedAt`, `error`, `detectedUrl`) cleared, so a `script.status` read after the reply never observes the pre-launch `idle`; the owned launch task publishes the `starting` transition as `script:state` strictly ahead of the spawn's `running` (or `exited` + `error` on a launch failure). A script already `running` or `starting` is a no-op |
| script.stop | workspaceId (req), scriptId (req) | { ok, scriptId } — stops an active run; resetting a finished script from `exited` to `idle` emits a `script:state` snapshot (§6.5; prepared event-authority extension below). On a **non-running** script that carries the was-running marker this is the **dismiss** affordance: it clears the marker (`previouslyRunning` on a service row, the hydrated `lost` reading on a command row; in memory plus a best-effort row write), emits the cleared runtime snapshot, and returns ok instead of erroring. Stopping an already idle, unmarked script is a no-op with no state event |
| script.restart | workspaceId (req), scriptId (req) | { ok, scriptId } |
| script.output | workspaceId (req), scriptId (req), maxLines? | output buffer text |
| script.status | workspaceId (req), scriptId (req) | { status, restartCount, pid?, exitCode?, startedAt?, stoppedAt?, error?, detectedUrl?, previouslyRunning?, ready?, readiness? } — the `ScriptRuntimeState` snapshot; `status` and `restartCount` are always present, every other field is **omitted when unset** (never `null` — a cleared `exitCode` is absent, so hooks test `exitCode !== undefined`); `status` is one of `idle \| starting \| running \| restarting \| exited`. `exited` **always** carries `exitCode` (new in intentd, unreleased): when the real status was not observable it is the sentinel `-1` together with an `error` naming the cause — see the total exit contract note below. `starting` (new in intentd, within v9.12 — intent-hq/intent#4858) is the `script.start` launch window: set synchronously before `script.start` replies, with the previous run's terminal fields cleared, and held until the spawn's `running` (or `exited` on a launch failure), so a poll issued right after `start` never reads the pre-launch `idle` or a stale `exitCode`. `restarting` (new in intentd, monorepo#1318) is the transient restart-in-flight state between an exit and the next spawn attempt — the service auto-restart backoff window and the `script.restart` stop→start gap — so a poll taken mid-restart never reads as a final `exited`/`idle`; the respawn flips it back to `running`. `previouslyRunning?: true` (new in intentd, within v5.1) marks a **service** script that was running when the daemon last stopped; a command script in the same situation hydrates as `exited` / `exitCode: -1` / `error` instead — see the was-running marker note below |
| script.run | workspaceId (req), scriptId (req), maxLines?, timeoutSeconds? (alias timeout?) | { exitCode?, output, timedOut?, warning? } — `exitCode` follows the same total exit contract as the runtime state (new in intentd, unreleased): `-1` when the exit was unobservable — see the total exit contract note below |

> **Implemented lifecycle candidate (10.11).** The additive purpose/archive fields, filters and
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


#### Service readiness (prepared additive extension)

This contract addresses [intent-hq/intent#4256](https://github.com/intent-hq/intent/issues/4256).
It leads implementation and does not establish that the issue is fixed.
Advertise `client.hello.server.capabilities.scriptReadiness: 1` only after the
whole contract, persistence and MCP bindings are implemented and tested. Allocate
the next minor against main at implementation time; no new RPC or event names.
This capability is independent of `scriptLifecycle`.

**Configuration and compatibility.** `script.create` accepts mutually exclusive
optional `healthUrl: string` and `readyPattern: string`, only in `mode: "service"`.
Persist and return the configured field on definitions from create/list. Neither
field is inferred from `detectedUrl`, command text, category or purpose. Reject
both fields together, explicit null, empty values, invalid types or either field
on a command with `-32602`, before persistence or stopping an upserted process.
Omitting both on a new definition creates no contract. Omitting both on an upsert
preserves the existing contract; providing one replaces the other. To explicitly
clear it, accept `clearReadiness: true` on create with an existing `scriptId`,
without either field; otherwise reject that flag. It is an input only, never a
definition field. Switching to command mode requires clearing an existing
contract in that same upsert. All accepted upserts retain existing stop/replace
semantics, including a fresh readiness state. Contract persistence failure fails
the operation; never report successful configuration without the durable write.
Repository-config scripts without these options retain no contract; repository
configuration import of readiness options is outside this extension.

A script without a contract omits both runtime fields, even on a supporting
daemon, and retains existing start/status/output/URL behavior. Absent `ready`
means **unknown/not configured**, never true or false. Existing stored scripts
need no inferred backfill. A client must check `scriptReadiness: 1` before sending
any readiness option, including clear. Older daemons can silently ignore unknown
options: successful create is not proof of support. Clients needing readiness
must report unsupported or use their existing explicit checks; never silently
fall back to URL detection. Old clients may ignore additive fields, and their
upserts preserve an existing contract when they omit the new inputs.

**Runtime shape.** For a configured service, `script.status`, each list entry's
`runtime`, and the runtime snapshot on `script:state` carry:

| Field | Meaning |
| --- | --- |
| `ready: boolean` | Always present for configured services; true only after the current process attempt passes its contract while still running. |
| `state` (inside `readiness`) | `idle` before launch/after stop or exit, `pending` while starting/restarting/checking, or `ready` after success. No change to the existing process `status` enum. |
| `checkedAt?: string` (inside `readiness`) | RFC 3339 UTC time of the last completed HTTP attempt or successful pattern match; absent before either. |
| `lastStatus?: integer` (inside `readiness`) | Most recent HTTP attempt's response status (100–599), absent if no response was received; never present for a pattern. |
| `lastError?: string` (inside `readiness`) | One safe code: `http-status`, `timeout`, `connection-failed`, `tls-failed`, `unsafe-url`, or `output-gap`; absent after success. No arbitrary exception text. |

Optional fields are omitted, never null. `ready` is exactly equivalent to
`readiness.state === "ready"` and implies process `status === "running"`.
No-contract scripts do not emit a synthetic `readiness.state = idle`.
The `ready` state is a startup latch, not a continuous health monitor: checks
stop at success and a later HTTP outage alone does not change it. A health
endpoint decides what readiness means; 2xx cannot prove browser hydration or
dependency availability unless the endpoint itself checks them.

**HTTP checks.** `healthUrl` (maximum 2,048 UTF-8 bytes) is either an absolute
HTTP(S) URL or an origin-relative path beginning with one `/` (not `//`). Resolve
paths against the current attempt's detected URL's **origin**, ignoring its path
and query. Before URL detection a relative contract stays pending without a
request, timestamp or error. An absolute URL needs no detected URL. Reject
credentials, fragments, backslashes, control characters, missing/invalid hosts
and non-HTTP(S) schemes. Query strings are permitted, but never copied into
readiness errors or logs. Validate absolute configuration at create time and
validate the final resolved target again before each request.

Only literal loopback addresses (`127.0.0.0/8` or `::1`) and exact `localhost`
are allowed; reject IPv4-mapped IPv6, unspecified addresses, LAN/public IPs,
other DNS names and browser tunnel aliases such as `daemon.localhost`. For
`localhost`, connect directly to loopback (IPv4/IPv6 candidates only), never use
DNS; literal IP connections likewise require no DNS. Pin the actual connection
to those addresses, disable environment/system proxies, and do not follow any
redirect, even to another loopback URL. TLS uses normal certificate/hostname
validation; no insecure bypass. Requests execute on the daemon host, not in the
browser. This keeps user-configured checks local; it does not prove ownership of
the listening process, so use a dedicated endpoint/port for the service.

Send GET without authentication, cookies or inherited headers. Success is any
200–299 response header, without reading the body. Close/drop every response
without collecting or exposing bodies, response headers, redirect locations or
credentials in status/events/errors/logs. Keep only timestamp, status and safe
error code. A non-2xx result records `http-status`; a network/TLS/timeout failure
records its code and clears previous `lastStatus`. An unsafe resolved URL makes
no request, records `unsafe-url`, and stays pending. Errors never stop/restart
the service and do not overwrite its process `error` field.

One attempt per configured running service at a time; first eligible attempt
runs immediately, subsequent attempts start at least 1,000 ms after completion.
Each request has a 2,000 ms total deadline, including connection/TLS/headers;
enforce a 16 KiB response-header limit (overflow is `connection-failed`). A
daemon-wide cap of eight active requests uses a fair queue containing at most
one entry per active configured service. Wait time for a slot is not a completed
attempt. There is no overall startup deadline: failures retry until success or
lifecycle cancellation. Reads of status/list never perform I/O. Polls must not
block output draining or process-exit detection.

**Output checks.** `readyPattern` is a case-sensitive **literal UTF-8 substring**,
not a regular expression (maximum 1,024 UTF-8 bytes; reject CR, LF and control
characters). Match against ANSI-stripped text from the current process attempt.
Scripts use a PTY that combines stdout and stderr; either stream can satisfy the
contract. A match may span output chunks, UTF-8 fragments and ANSI fragments but
not a line boundary; CR and LF each end a line. Retain at most 1,023 decoded text
bytes plus bounded UTF-8/ANSI decoder state across chunks; scan longer chunks
incrementally. Discard overlong ANSI control sequences with bounded memory.
Do not match synthetic supervisor separators, previous-attempt scrollback or
output arriving after exit. A dropped/lagged output segment resets partial
matching state and records `output-gap` without `checkedAt`; subsequent complete
observed output can still match. A match records `checkedAt` and clears the error;
do not expose matched text in readiness metadata.

**Reset and stale-result rules.** Create/hydrate configured services as
`ready: false, readiness: { state: "idle" }`; never persist positive readiness.
At launch admission reset to false/pending, with all old check metadata cleared,
before start replies. A repeated start on a running/starting service remains the
existing no-op and does not clear valid readiness. Explicit restart resets before
teardown; automatic restart resets when the old process exits, before backoff.
Every replacement process starts with fresh check/matcher state. Terminal exit,
spawn failure and stop reset to false/idle and clear all check metadata. Daemon
shutdown, remove and upsert cancel queued/in-flight work and release slots;
hydration follows the existing was-running behavior, never reusing old success.

Every probe result, output match and readiness event is scoped by workspace,
script ID, definition generation, admitted run and **process attempt** (automatic
respawns within one supervisor need a new identity). Validate that identity and
running/not-stopping state atomically at publication. A late success/failure from
an earlier attempt, removed definition or same ID in another workspace must not
change either state or events. Cancel on stop acceptance, before awaiting process
teardown, so a late check cannot restore readiness during stop. Do not hold a
registry/admission lock over network work or joins that need that lock.

Reuse `script:state` for readiness transitions. Publish reset before any successor
ready event, and serialize publication with lifecycle transitions so a captured
old snapshot cannot arrive after reset. Successful readiness changes appear in
status/list before their event is sent. Repeated pending failures update the
readable check metadata without emitting a new durable event each polling tick;
emit on readiness state changes, with the full current runtime snapshot. No
new `script:changed` event is needed for checks (configuration changes retain
existing definition invalidation). Consumers replace the readiness snapshot;
omitted optional check fields clear old metadata.

**Examples and implementation proof.** The bounded executable reset model and
contract tests in `../fixtures/scripts/readiness-model.mjs` and
`../fixtures/scripts/readiness.test.mjs` are design prototypes only. They do not
exercise HTTP, persistence, the real PTY, locks or WSS. Component acceptance must
add regression-first tests for URL-before-503-before-204, automatic/explicit
restart, delayed predecessor success/failure and event ordering, stop/remove/
upsert/shutdown cancellation, same IDs across workspaces, no-contract byte-shape
compatibility and old-client upserts. Real HTTP fixtures must prove no redirects,
proxy/DNS escape, body leakage or deadline/concurrency growth; PTY fixtures must
cover split text/UTF-8/ANSI, stderr, line boundaries, lag and old scrollback. Real
WSS tests must cover create/status/list/state-event envelopes, authorization,
validation errors and capability negotiation. Persistence tests use isolated DBs.
Run the daemon gates and consumer checks before advertising support.

#### Command creation defaults (prepared breaking change)

This change leads implementation; it does not claim released or installed support.
It changes the 10.11 creation default described by the original lifecycle candidate.
Recommend protocol **11.0** against the reviewed 10.11 baseline: an omitted-purpose
command changes retention, and a previously valid new autostart command now fails
validation. No method, field, enum value or event is added or removed. Confirm the
version against daemon main before implementation lands; see [versioning](../versioning.md).

| Creation input | Resulting purpose |
| --- | --- |
| New `mode: "command"`, purpose omitted | `oneOff` |
| New `mode: "service"`, purpose omitted | `saved` |
| Explicit `purpose: "saved"` | `saved`, including reusable/autostart commands |
| Existing `scriptId`, purpose omitted | Preserve the stored purpose |
| Hydrated/imported/repository-config definition, purpose absent | `saved`; no reclassification |

The new-ID rule also applies when a caller supplies a `scriptId` that does not
exist. Resolve omitted purpose from the stored definition before validation on
an upsert; use the mode default only for a genuinely new definition. Validate the
resolved purpose before persistence or stopping an existing process. An omitted
purpose on an existing one-off does not silently promote it when changing to a
service or setting `autoStart: true`: either change requires explicit `saved`.
A new command with omitted purpose and `autoStart: true` is invalid (`-32602`),
just like explicit `oneOff` with autostart. Explicit null and unknown values remain
invalid. There is no schema migration, backfill, archive sweep, or change to the
legacy deserialization default. Existing saved rows stay saved; existing one-offs
stay one-off. Completion, output, hooks, manual archive and restore are unchanged.

**Caller migration.** Audit reusable command creators, boot/setup commands and
any command using autostart: send `purpose: "saved"` explicitly. Apply this to raw
JSON-RPC, CLI JSON requests, MCP helpers and frontend creation forms. Do not make
an omission into `saved` in a forwarding wrapper; preserve omission for the daemon
to distinguish new creation from upsert. Do not apply creation defaults while
hydrating a legacy response. Services continue to default to saved.

`scriptLifecycle: 1` proves lifecycle support, not which creation default applies:
it is also advertised by the earlier saved-default daemon. Explicit purpose is
the portable choice across lifecycle-capable generations. On a daemon without
that capability, absent purpose still hydrates as saved and one-off retirement
cannot be promised; unknown request fields may be ignored. An old client that
omits purpose on a new command receives the new one-off behavior after a daemon
upgrade. Its unfiltered list still returns archived definitions and its known-ID
status/output reads still work; this does not preserve the old creation default.

Prepared examples (execute only against a daemon supporting lifecycle):

```javascript
// Explicit retention works across old and new lifecycle-capable defaults.
const reusable = await ws.script.create("Check", "make check", "command", { purpose: "saved" });
const disposable = await ws.script.create("Once", "make check", "command", { purpose: "oneOff" });
// With the new default, a new command can omit purpose; services remain saved.
const once = await ws.script.create("Once", "make check", "command");
const service = await ws.script.create("Dev", "make dev", "service");
```

The monorepo CLI probe forwards the same JSON contract; replace the workspace ID:

```bash
make rpc METHOD=script.create PARAMS='{"workspaceId":"<workspace-id>","name":"Check","command":"make check","mode":"command","purpose":"saved"}'
```

For a command with `autoStart: true`, keep that explicit saved purpose. For an
upsert, add the existing `scriptId` and omit purpose only to retain its stored
classification. These examples create definitions, not a successful test result.
The generated MCP index remains pin-owned and is not edited for this preparation.

#### Saved scripts and one-off history (10.11 implemented candidate)

The complete extension is implemented and independently verified in intentd
[`7a80f18905377545ec1e8a88a8331772557e772e`](https://github.com/intent-hq/intentd/commit/7a80f18905377545ec1e8a88a8331772557e772e)
([PR #2195](https://github.com/intent-hq/intentd/pull/2195)), which advertises
protocol `10.11` and `client.hello.server.capabilities.scriptLifecycle: 1`.
This covers persistence, all settled command outcomes, durable admission recovery,
concurrency protection and the agent bindings. The lifecycle-aware frontend is
[`25c9335afd3032b6782b2f52155f95710e89ed76`](https://github.com/intent-hq/cloudlands-fe/commit/25c9335afd3032b6782b2f52155f95710e89ed76)
([PR #3041](https://github.com/intent-hq/cloudlands-fe/pull/3041)). These are
component candidates, not a claim of merged, pinned, released or installed support;
combined client/runtime acceptance and deployment remain separate gates. See
[versioning](../versioning.md) for the reviewed pin baseline and merge order.
Only advertise the capability for the complete extension. Existing methods and status enum remain;
`script.archive` and `script.restore` are the only new RPC names. History is a view
of retained definitions and their latest result, **not a per-run log archive**.

**Definition fields and compatibility.** A supporting daemon always returns
`purpose: "saved" | "oneOff"` on definitions (`script.create` and `script.list`).
`archivedAt?: string` is an RFC 3339 UTC timestamp, omitted while active, never
`null`. Archive state and purpose persist across restart. `lastRun?` is the compact
persisted command result described below; it is absent if no result is known.
These fields belong to the definition, not `ScriptRuntimeState`.

- Under the prepared [creation default change](#command-creation-defaults-prepared-breaking-change),
  new commands default to `oneOff` and services to `saved` when purpose is omitted.
  The original 10.11 candidate defaulted both to `saved`. Every pre-existing,
  imported or repository-config definition without explicit purpose stays `saved`.
  Never infer one-off purpose from source (including `source=user`), name, command,
  category, age, idle status, agent ownership, or lack of output.
- `oneOff` is a retention choice for `mode: "command"`; `mode` still
  controls execution. Reject `oneOff` with `mode: "service"` or `autoStart: true`
  as `-32602` invalid params, without mutation. Unknown purpose/archive-filter
  values and explicit `null` are invalid params too. Services are never retired
  automatically and are excluded from command archive selection.
- A new client on an older daemon treats absent purpose as `saved` and absent
  archive metadata as active. Without `scriptLifecycle: 1`, hide history/archive
  controls and do not send lifecycle fields, filters or mutations. Old parsers
  can silently ignore unknown fields: a successful create is **not** proof that
  one-off retirement is supported. Never fall back to `script.remove`.
- Old clients on a supporting daemon can start/status/output known IDs as before.
  With the prepared default change, omitted-purpose new commands become one-off;
  earlier lifecycle daemons create saved definitions. Old clients ignore additive
  fields and
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

**Completion, failure and cancellation.** A one-off command moves
to history after its admitted run has **settled**, whether it succeeded, failed,
was cancelled, timed out, or was interrupted. Settlement requires that its
process and launch/run reservation have ended and no restart is pending. Never
retire a never-run `idle` definition or a transient idle/exit during restart.
Saved commands and services never auto-archive. Publish the final runtime state
where the existing path emits `script:state` before the archive change event;
all prior output chunks keep their existing ordering. Under the prepared
event-authority extension below, a stop that resets a finished script from
`exited` to `idle` publishes that runtime transition. Any archive change event
still follows settlement. Do not hide a run before final output/state can be read.

Failure must not disappear silently: History renders the recorded result and
error, and its entry point visibly signals failed/cancelled/interrupted entries.
Those outcomes retire just like success; the indication must not depend on a
transient toast, output buffer, or a selected script still being in the active
list. There is no inferred age/command-name/success-count cleanup policy.
Automatic archive write failure keeps the row active, logs the persistence
error, and leaves the real terminal state intact; it must not turn a successful
command into a failed command or lose its output.

Manual-stop result semantics are **unchanged**, including `idle` after stopping a launch
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

An already observed terminal result takes precedence over interruption recovery:
shutdown preserves its outcome, exit code and timestamps even if persistence is
still pending. Only unfinished admissions recover as interrupted. Restart admission
cannot inherit the predecessor's observed result; completion remains scoped to
the admitted run.

**Rerun and replacement.** `start`, `run`, and `restart` of an archived ID
restore it durably before accepting a launch. They preserve its purpose and ID,
clear the runtime terminal fields for the new run and publish the restoration
change before that run's first live state event. Existing duplicate-start
no-op / already-running warning behavior extends across every live reservation,
including `restarting`. Do not schedule a second launch to restore an already
live entry. Restore-only leaves terminal status/output untouched. A
`script.create` upsert with the same ID intentionally replaces the definition
and restores it, preserving existing source/creation identity behavior. Omitted
purpose preserves the existing purpose (the prepared default change applies only
to new IDs: commands default to `oneOff`, services to `saved`);
explicit purpose replaces it, subject to mode validation. Changing an existing
one-off to service therefore requires explicit `purpose: "saved"`. Existing
upsert teardown behavior is unchanged: unlike archive, replacement can stop the
old process. Completion from the replaced run cannot retire its replacement.

**Events and completion hooks.** `script:changed` retains `scriptId` and
`action: "created" | "updated" | "removed"`. The prepared additive
[self-contained change contract](#self-contained-script-changes-prepared-additive-extension)
below adds the complete row for create/update, including archive/restore and
latest results. Legacy ID-only create/update events still invalidate the selected
list. Archive is never removal; `script:state` alone never proves durable
retirement. No new event type or runtime status is added.

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

**Agent API (implemented candidate signatures, not installed bindings).** The
verified daemon candidate implements these helpers with the capability. The
generated binding index continues to represent only the pinned implementation:

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
and create/start/status/output signatures remain valid. Send explicit `purpose: "saved"`
for reusable/autostart commands; explicit `oneOff` gives throwaway checks the same
retention on both lifecycle-capable default generations. New commands may omit
purpose once the prepared default change is implemented. Never use
remove as automatic cleanup. The generated MCP binding index reflects the
monorepo pin, not necessarily the installed daemon. Automatic pin advancement
regenerates it; this candidate documentation does not manually advance it. Use
the connected daemon's capability and installed helper help to establish support.

Prepared examples and race expectations are in
[`fixtures/scripts/lifecycle.json`](../fixtures/scripts/lifecycle.json).
They are synthetic contract inputs, not evidence of implemented runtime behavior.
Run their static consistency checks with
`node --test docs/protocol/fixtures/scripts/contract.test.mjs`; component tests
exercise the implemented lifecycle with isolated databases and controlled
launch/completion race barriers. The JSON remains a prepared scenario catalog;
its static checker does not execute those component tests.

#### Self-contained script changes (prepared additive extension)

This contract is **prepared, not a shipped implementation claim**. It extends
`script:changed` without adding a method, event type, capability, database field,
or wire revision counter. Detect support from each event's payload; neither
`scriptLifecycle: 1` nor a numeric protocol version proves snapshot support.
Lifecycle controls still require their existing capability. Allocate the additive
minor against daemon main at implementation time; docs land before consumers.

**Payload.** Keep the §6.3 envelope and workspace authorization unchanged:

| Action | `data` | Meaning |
| --- | --- | --- |
| `created` | `{ scriptId, action: "created", script }` | Insert the committed definition and current runtime |
| `updated` | `{ scriptId, action: "updated", script }` | Replace the complete row after definition edit, archive, restore or result commit |
| `removed` | `{ scriptId, action: "removed" }` | Delete the definition by ID; omit `script` |

`script` is exactly one **full `script.list` row**, independent of the client's
active/history filter: all definition fields plus a complete `runtime` object.
Required fields are `id`, `workspaceId`, `name`, `command`, `mode`, `purpose`,
`source`, `createdAt`, and `runtime` (with `status` and `restartCount`). Optional
fields follow the same types and omission rules as list/status, including
`archivedAt`, `lastRun`, definition options and runtime terminal fields.
`script.id` equals `data.scriptId`; `script.workspaceId` equals the event's
`workspaceId`. Never publish another workspace's row or a definition-only object
under `script`. Unknown additive fields remain tolerable. Output bytes and client
state (selection, tabs, buffered output) are not part of this row.

**Replacement and clearing.** Presence of a valid `script` means a complete
snapshot, not a patch. Replace both definition and runtime, removing old optional
fields absent from the new row; do not shallow-merge it with the cached row.
Omitted `archivedAt` means active; omitted `lastRun` means no known result (for
example after upsert); omitted `cwd`, `env`, `category`, `autoStart`, `updatedAt`,
or supported readiness configuration clears the prior value. Omitted runtime
`pid`, `exitCode`, `startedAt`, `stoppedAt`, `error`, `detectedUrl`,
`previouslyRunning`, or supported readiness metadata clears the prior value.
Unset optional fields are omitted, **never `null`**. An explicit false/zero/empty
value, when allowed by the field's type, remains a value. `script` absent means
legacy invalidation, never an empty replacement. Null, partial, invalid or
identity-mismatched snapshots are not authoritative: use the existing scoped
reconciliation path without applying the malformed row. An unknown action also
falls back to reconciliation. Never infer removal from missing/invalid `script`.

**Publication and persistence.** Supporting producers include `script` on every
created/updated event, not only auto-archive. Publish after the durable mutation
commits and the runtime registry reflects it, taking definition and runtime from
one coherent observation. Use the same row projection as list. Completion for
saved commands publishes the new `lastRun` while remaining active; completion for
one-offs coalesces result and archive into one updated snapshot. Cover success,
nonzero exit, spawn failure, cancellation, timeout and interrupted-run recovery.
Recovery must construct/hydrate the corresponding runtime before publishing a
full row; it cannot send an empty snapshot while the registry is not populated.
Skipped/no-op archive/restore operations emit nothing.

A failed durable write must not publish an uncommitted result or archive snapshot.
The existing terminal state/output remains readable and its state event may
already have arrived, but the prior committed definition/result stays in force.
This applies to automatic retirement and explicit edits/archive/restore/removal;
a failed partial batch can still have events for earlier committed IDs.

Keep existing output/state ordering. The final runtime event, where the path
emits one, precedes the settled change snapshot. A stop that settles at `idle`
may publish a changed row with `runtime.status: "idle"` and cancelled `lastRun`;
do not invent an exit code or duplicate a state event already published for that
transition. A stop that resets an already finished script from `exited` to `idle`
must publish a complete `script:state` snapshot, even when no result or archive
mutation remains to publish. This reset changes runtime status only: retain the
preceding terminal fields, `lastRun`, archive membership and addressable output.
It is not a new cancellation or an implicit restore. Marker dismissal remains
distinct: remove a service's `previouslyRunning`; dismissing a command's hydrated
`lost` reading resets its runtime to plain `idle` (clearing terminal fields),
without clearing its durable result/archive metadata. Both dismissals publish
the cleared runtime snapshot. An already idle, unmarked script with no pending
run is a no-op and emits no state event. Consumers replace runtime from these
snapshots without a stop-triggered list refresh; initial/reconnect and legacy
reconciliation remain as described below.

Restore-before-launch
publishes the restored snapshot before the successor's first live state event;
restore alone retains previous runtime/result/output. Upsert clears prior archive
and result metadata and publishes the replacement's fresh runtime.

For each workspace/script ID, serialize mutation, snapshot capture and change
publication against replacement/removal and launch admission. An older captured
change must not publish after its successor. Validate the definition generation
and admitted run before committing/publishing delayed completion; a stale exit
must not update, archive or resurrect a replacement or rerun. Runtime publication
must likewise not let a predecessor state overwrite the successor snapshot.
There is no cross-script total-order promise. These are producer responsibilities,
not races clients can solve by comparing `createdAt`, `updatedAt`, `stoppedAt`,
event timestamps or event UUIDs; none is a monotonic row revision.

**Consumption and reconciliation.** After initial loading, valid create/update
snapshots directly update known or previously unknown IDs and derive active/history
membership from `archivedAt`, with **zero event-triggered `script.list` calls**.
Keep archived rows available to open output viewers; archive must not clear
selection, tabs, subscriptions or buffered output. `script:state` replaces runtime
only; it cannot create a definition, change archive membership or resurrect a
removed ID. Removal directly drops the ID with existing explicit-delete behavior;
its ID-only shape is already sufficient, on both new and old daemons, and needs
no list call. Existing rerun/replacement output lifetime rules still apply.

Subscribe before initial/reconnect reconciliation. Lists remain necessary for
initial loading, reconnect/missed events, explicit reads and legacy invalidations.
A pending list response must not overwrite script changes or runtime events
received since that request began, nor resurrect an event-removed row. A local
per-workspace request fence plus buffering/reapplying those events in receive
order is sufficient; include full row replacements, removals and runtime-only
updates, and preserve each list filter's meaning. For example an active-list
response omitting an archived row must not erase the retained row delivered by a
completion event. Do not launch a second list solely because a valid snapshot
arrived during the first one. Protect concurrent list requests from older response
completion as well; coalescing/serialization or local request tokens suffice.

Scope pending reads, buffers and subscriptions to the workspace **and connection
/ authority generation**; discard old-connection results and queued events after
reconnect or an authority switch. Deduplicate overlapping subscriptions by
`event.id` (§6.3). Receive order is meaningful only within the current live stream;
replaying historical `event.query` rows onto a current cache is not reconciliation.
The existing event envelope supplies no resume cursor/snapshot watermark. After
a missed stream or connection reset, re-list rather than treating historical
arrival order as fresh state. No general event-versioning framework is required.

Older daemons' create/update events omit `script`: retain the existing coalesced
list refresh. Older clients ignore the new member and continue their current
refresh behavior; omitted wire archive filters still mean `all`. Rollback may
remove the producer extension while this consumer fallback remains. A valid row
snapshot must never cause a completion refresh, including saved-script results.

Executable synthetic fixtures live in
[`fixtures/scripts/changed-events.json`](../fixtures/scripts/changed-events.json)
and run with `node --test docs/protocol/fixtures/scripts/contract.test.mjs`.
They exercise snapshot application, omission clearing, output retention, legacy
fallback and in-flight/reconnect races; they are **not** proof of daemon locking,
persistence or frontend transport behavior. Component unit and WSS/transport
regressions must execute those guarantees against real implementation code.
