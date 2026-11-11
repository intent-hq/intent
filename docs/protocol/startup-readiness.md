> Part of the [Intent JSON-RPC protocol docs](./README.md). Prepared additive contract; not yet implemented or shipped.

# Daemon startup readiness and indexing progress

This extension reserves one fast-path method, `system.startupStatus`. The ready
daemon advertises exact integer `server.capabilities.startupStatus: 1` in
`client.hello`. Before normal hello is possible, the versioned status result or
structured not-ready error below is the support probe. Neither socket acceptance,
HTTP liveness, a version number nor this document establishes application readiness.
This is daemon-global, owner-only information; no workspace routing field applies.
No event, subscription, writable setting or index-resume operation is added.

## Bootstrap boundary and security

The existing composition cannot simply bind the ordinary listener sooner:

- `intent-store/src/lib.rs::Store::open_with_owner` runs migrations, profile
  retirement, commit and runtime setup before returning a Store. Progress reads must not acquire that write connection,
  read SQLite, query services or publish through the persisted EventBus.
- `intent-transport/src/client.rs::handle` persists `upsert_client`. Ordinary UDS
  and WSS admission resolve principals through `WorkspaceApi`; hello also binds
  reverse RPC identity. None belongs on a status-only connection.
- `intentd/src/main.rs::cmd_serve` currently builds settings, TLS/auth, listeners
  and Tailcat after Store. The legacy bearer token is actually file-secret-backed
  (`intent-transport/src/auth.rs`), while principal credentials/roles are in SQLite.

Implement a separate bootstrap dispatcher with no `WorkspaceApi` or Store handle,
sharing an in-memory startup snapshot with Store's progress observer. Acquire all
single-instance/data ownership guards before exposing it. Resolve strict config,
startup pins, effective enable/bind/tunnel-only policy, saved port and TLS identity,
and load/create the normal file-secret owner token before accepting network status.
Preserve first-port assignment and persistence, fatal enabled-WSS bind failure,
loopback inclusion, UDS path/permissions, origin validation, token extraction and
constant-time comparison. Do not mint a second token/certificate, enable a disabled
API, use an alternate port, relax TLS verification or fall back to plaintext.
Existing explicit insecure development mode remains development-only.

Only the OS-protected UDS seat and the existing legacy owner token on `/ws`
can observe bootstrap progress. These are restricted bootstrap credentials, not
temporary principal rows or an unbound administrator in the ordinary router.
For secure `/ws`, missing token is HTTP 401; a supplied token that does not match
the owner token is HTTP 503 with `Retry-After: 1` and generic `Service Unavailable`,
because it might be a valid SQLite-backed credential. No progress or credential
validity is disclosed. Ready admission restores normal credential validation,
including 401 for invalid/revoked tokens. A bootstrap 503 must not erase credentials
or initiate pairing. Disabled API/disallowed origin remain 403 before this check.
Secret/config/TLS failure fails closed; do not bind an unprotected status service.

`/invite` and binary `/tunnel` upgrades are unavailable during bootstrap (503,
`Retry-After: 1`, generic body after existing enable/origin gates); unknown paths
remain 404. They never reach an application or TCP forwarding handler. The Tailcat
sidecar is distinct from binary `/tunnel`: it carries the owner's `/ws` traffic.
Saved owner Tailcat routes are part of this feature's acceptance: start the
configured sidecar against the protected early WSS listener and preserve its
route through handoff. If its Store/service-dependent control path cannot be
separated, report the concrete blocker and obtain a scope/design decision before
claiming completion; deferring that route until ready is not an accepted fallback.
Never widen a tunnel-only bind to work around it. Per-principal clients
retain ordinary retry UI until ready; this revision does not expose aggregate
owner progress to guests or host members.

Settings required for admission must be resolved with existing precedence and
any relevant legacy migration before listener exposure; a default-only snapshot
is insufficient. Revalidate policy/credentials when handing off and on fresh
admission. Startup does not enable settings/token mutation RPCs. Existing external
token rotation/cache invalidation rules must continue to apply to bootstrap seats.
Preparing can be observed only after this secure bootstrap succeeds: failures or
slow work before it can still appear as an unreachable daemon.

## Minimal dispatcher and handshake

| Surface | Bootstrap behavior |
| --- | --- |
| `system.startupStatus` with absent params or `{}` | Return the snapshot below, including `failed` when available. Other params are `-32602`. No hello required. |
| `client.hello` | Recognized handshake attempt, but return the structured not-ready error. Do not upsert a client, acknowledge capabilities, register reverse RPCs, or persist identity. |
| Every other RPC name, including unknown names | Return the same not-ready error before any ordinary fast path, service, authorization lookup or subscription handler. No work is queued for later. |
| WebSocket ping/pong/close | Existing heartbeat/cleanup behavior; proves transport liveness only. UDS EOF closes the seat. No new JSON-RPC ping method. |
| HTTPS `GET /health` | HTTP 503, `Retry-After: 1`, body `{"status":"starting"}` or `{"status":"failed"}`. No authenticated progress, IDs, error details or counts. Existing ready health response is unchanged. |

Envelope/frame validation retains existing limits and parse/invalid-request errors
before readiness dispatch. Notifications never execute and receive no response;
even hello notifications cannot bind identity. Unsolicited responses are ignored,
since no reverse RPC was issued. Apply the existing transport size, heartbeat and
connection/resource bounds; status polling must not spawn unbounded tasks.
`system.status`, `principal.me`, capabilities/provider discovery, pairing, shutdown,
updates, settings and subscriptions are deliberately outside the early allowlist.
OS/service-manager stop still works; early `system.shutdown` is not implemented.
As in the existing HTTP parser, `/health` is handled before WebSocket enable,
origin and bearer checks, on an already-bound listener with the same TLS posture.
Its generic 503 body is therefore public liveness/readiness only; all detailed
progress requires protected status admission. No disabled listener is started
just to serve health. `/ws` keeps enable then origin then credential ordering;
the unavailable `/invite` and `/tunnel` paths do not upgrade or authorize work.

The [CLI compatibility projection](#installed-sitter-compatibility-cli-only) below
does not change this wire allowlist: even `system.status` still returns `-32012`
on a protected bootstrap connection. HTTP health and ordinary hello remain gated.

The retryable error for a well-formed request is exactly:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32012,"message":"Daemon not ready","data":{"code":"daemon-not-ready","retryable":true,"retryAfterMs":1000,"startup":{"startupStatus":1,"daemonVersion":"0.10.47","attemptId":"boot-a","phase":"preparing","elapsedMs":1200,"phaseElapsedMs":1200,"progressAgeMs":1200,"retryAfterMs":1000}}}}
```

`data.startup` is the same atomic snapshot as the status method; outer
`retryAfterMs` equals its retry delay. On terminal failure use numeric `-32012`,
message `Daemon startup failed`, `data.code: "daemon-startup-failed"`,
`retryable: false`, omit outer retry delay, and include the failed snapshot.
The error means the requested operation **was not admitted**; it is never returned
after a mutation starts. It permits status retry, not blind application mutation
replay. Unknown method errors return to ordinary `-32601` handling after readiness.

## Snapshot schema and phases

`system.startupStatus` returns this object directly as its JSON-RPC `result`:

| Field | Type and meaning |
| --- | --- |
| `startupStatus` | Exact integer `1`, schema/support marker. |
| `daemonVersion` | Additive nonempty string identifying the **responding daemon** build, supplied by the daemon composition root. New producers include it in every snapshot; older candidates may omit it. Absence does not prevent progress UI, but prevents the CLI liveness projection below. Never null, a client/CLI version, or a fabricated fallback. |
| `attemptId` | Nonempty opaque random string, newly generated each process startup, stable through ready/failure. Not a PID, persisted resume token or database identity. |
| `phase` | `preparing`, `indexing`, `finalizing`, `ready`, or `failed`. |
| `elapsedMs` | Nonnegative safe integer; monotonic duration since attempt start, frozen at ready/failure. |
| `phaseElapsedMs` | Nonnegative safe integer; duration in current phase, frozen at terminal phase entry (zero for ready/failed). |
| `progressAgeMs` | Nonnegative safe integer; time since the last phase or actual work-counter change, reset on change, frozen at terminal entry (zero). Polling alone does not reset it. |
| `retryAfterMs` | Integer 1000–30000, present only for preparing/indexing/finalizing. Normal recommendation 1000; client jitter/backoff may increase it. |
| `progress` | Optional `{ completedNotes, totalNotes, processedSourceBytes, totalSourceBytes }`; all nonnegative safe integers, omitted until a complete work inventory is known. |
| `estimatedRemainingMs` | Optional nonnegative safe integer, indexing-only estimate for remaining **note indexing**, not time to ready. Omitted when unreliable; never null. |
| `finalizingStep` | Required only in finalizing: `anchors`, `committing`, or `services`. No estimate for these steps. |
| `failure` | Required only in failed: `{ code: "startup-failed", message: "Daemon startup failed. Check daemon logs." }`. Raw SQLite/path/token/note details stay in daemon logs. |

Preparing includes database opening/migration and inventory/profile preparation.
The current daemon rebuilds no note indexes at startup, so it never publishes
`indexing`, `progress`, `estimatedRemainingMs` or the `anchors` finalizing step;
they remain valid schema-1 values that clients must keep tolerating, with the
semantics below. Indexing begins when the rebuild work set is fixed. Inventory counts only notes
actually selected for rebuilding. Bytes are UTF-8 bytes of those canonical source
bodies (SQLite BLOB byte length, not character count, derived row count or disk IO).
Increment completed notes and processed bytes together after a whole note's index
replacement succeeds inside the transaction. They describe work performed, **not
committed progress**; a failure can roll it all back. Counts are monotonic within an
attempt, each completed value is at most its total, and totals remain fixed once
published. No IDs, titles, paths, content or per-note sizes cross the wire. Publish
bounded snapshots at most four times per second, with immediate phase/terminal
updates and exact final counters; observer failure must not change transaction
semantics or hold the write transaction waiting for a client.

After indexing, finalizing/anchors is reserved for source-anchor rebuilding;
finalizing/committing starts before awaiting the transaction commit. Only after
commit and the note runtime are usable may finalizing/services cover remaining
required daemon initialization, including any legacy VACUUM. Finalizing steps can
advance without resetting `phaseElapsedMs`; they do reset `progressAgeMs`. When no
notes need rebuilding, zero totals are valid and indexing may be skipped. An
unmeasured preparation/finalization stage stays indeterminate, never fabricated
as note progress. Existing optional background initializers, such as the post-startup cleanup of
retired note paging tables, do not become new readiness prerequisites.

Ready is published only after all required initialization and required listener
binding succeed, and ordinary dispatch is installed. Progress reaching N/N is not
ready. Failed is terminal for this attempt and cannot transition to ready. Record
failure and close/exit nonzero with normal cleanup; a last status read may observe
failed, but delivery is best effort and must not delay shutdown indefinitely.
Abrupt termination may only appear as disconnection. Never serve a durable stale
ready/failure file as current status.

Estimate only from monotonic measured work: remaining source bytes divided by
observed completed-byte throughput, with a bounded stable sampling window. A
candidate estimator must suppress estimates before sufficient samples (at least
five completed notes and two seconds), for zero/unknown workload, insufficient or
unstable throughput, or prolonged absence of progress. Unequal note expansion and
deletion cost can make byte rate unreliable; omission is always valid. Do not
extrapolate elapsed/notes alone or report a guaranteed countdown. Show “About …
remaining for indexing”; finalization remains separate. A large current note can
leave counters unchanged while work continues. After 30 seconds without progress,
UI may say “Still indexing; completed-note count unchanged”, not “hung” or
“failed”, and must hide ETA. Track the last successful status response separately
from `progressAgeMs`: fresh successful polls with unchanged counters prove the
status source is responding while a large note may still be processing. The
client marks status unavailable on disconnection or a failed/timed-out poll and
stops presenting cached counters/ETA as current. A later successful poll restores
freshness even if the counters are unchanged; never reset work age just to make
the UI look active.

## Ready handoff, desktop behavior and compatibility

1. Connect using the saved route and credentials; send normal `client.hello` first.
   A recognized `-32012` startup error enters a distinct starting/failed state.
   It must bypass both current FE transports' “hello failed, continue connected”
   fallback. Poll `system.startupStatus` directly on the same restricted socket,
   one request at a time, honoring retry delay with bounded request timeouts.
2. While starting, do not emit application-connected/reconnected, hydrate data,
   replay subscriptions, dispatch queued mutations, probe `principal.me`, discover
   providers, or mark the local daemon ready for its supervisor. Preserve saved
   credentials and known protocol metadata separately from this startup attempt.
   Native acquisition/adoption probes using `system.status` must recognize the
   structured error and avoid treating a live, starting daemon as replaceable.
3. At ready handoff, stop admitting bootstrap seats, atomically install full
   admission/dispatch on the same bound endpoints, and retire **all** bootstrap
   seats (WebSocket 1001 reason `Startup complete; reconnect`, UDS EOF). Never
   promote an owner-only/unbound bootstrap connection into ordinary authority.
   A racing status poll can return ready before close; either signal leads to
   one fresh connection with backoff. Handoff cannot expose a readiness gap where
   normal work reaches incomplete services. Keep ownership/port/TLS identity
   across handoff; any bind failure is startup failure, not ready.
4. Fresh admission revalidates credentials and binds the actual principal. Only
   successful ordinary hello then unlocks new-client application hydration and
   subscribe-then-fetch recovery. Ready owner status remains available as a normal
   fast path without requiring hello; non-owner callers receive `-32003 Forbidden`
   without a status payload. No snapshot is an authorization grant.
5. Clear startup counters/ETA on attempt or backend change. Key responses by backend
   plus connection generation plus attempt, and ignore late replies from retired
   connections. A restarted process starts over; it does not resume reported work.

Older clients may show their existing connection error/fallback while indexing;
the daemon still rejects **every** ordinary operation and executes no buffered
work. Old clients reconnect normally after the forced close and see unchanged
ordinary hello/status shapes. New clients talking to older daemons retain legacy
behavior: `-32601` on an optional status probe means unsupported, not “indexing”.
Absence/malformed/unknown capability or snapshot versions never creates fake
progress; a recognized not-ready code still keeps hydration gated while retrying
with generic startup UI. Unrelated old hello failures keep existing compatibility
behavior. HTTP 503 and unreachable sockets alone provide no authenticated progress
and use ordinary connection backoff; never guess phase, counts or ETA from them.

No numeric protocol major change is required for this additive method. Coordinate
an additive minor with the component's then-current protocol version; prepared
unrelated versions do not imply this capability. Merge docs additions first,
daemon next, frontend last, each with human permission. The companion daemon PR
updates the bundled assistant app guide once the UI behavior is ready for users.

## Installed sitter compatibility (CLI only)

Already-installed sitters must not terminate a responsive daemon merely because
indexing outlasts their startup deadline. The frozen `b6fc9f881` sitter's
`intentd-sitter/src/readiness.rs` probes the **newly installed daemon binary** with
`call system.status`, requires a successful process exit and parses `version` at
the top level of its stdout JSON. Its startup, supervisor and post-update paths
use that probe. It discards stderr, so a structured wire startup error printed
there remains indistinguishable from no response to that sitter.

The compatibility adapter belongs only in the new daemon's CLI `cmd_call` path
for `system.status`. A validated live-startup error may become exit 0 with an
explicit not-ready JSON projection on stdout. This is a CLI liveness result,
never a successful wire `system.status` reply. Do not change hello, API admission,
HTTP health, auth, or any other `call` method. Ordinary successful ready responses
still print their existing result without synthesis. Failed startup and missing,
timed-out, malformed or unsupported observations remain nonzero; no last-known
status is substituted. Do not print invented full-service fields such as agents,
clients, resources, capabilities, update support or transport metrics.

The version in this projection must come from the protected responding daemon's
startup metadata. Never substitute the probing CLI's build version: a new CLI
can contact a different or older daemon. An old sitter's target-version comparison
must continue to see the server's actual version and refuse a mismatched target.
No credential or authority is conveyed by the version metadata.

An unchanged old sitter can consequently report start/update success while
indexing continues: its “up” or internal “Ready” verdict means the target process
is responding, not that application initialization or migration commit finished.
Consumers needing application readiness must complete a fresh normal hello after
the ready handoff. A subsequent startup failure still exits the daemon nonzero
and follows existing supervision; the CLI projection cannot retroactively turn
the old sitter's earlier liveness verdict into a ready guarantee. New CLI/status
UI should say starting, and new readiness-aware automation must inspect the
explicit false readiness marker or use the wire startup/hello contract. A future
sitter can distinguish liveness from readiness, but updating sitter is not a
prerequisite for this daemon's safe startup.

The exact projection is restricted to `call system.status` with absent params or
an empty object `{}`, after normal response correlation and envelope validation.
Explicit null, arrays and nonempty objects do not qualify. Require numeric `error.code: -32012`,
`error.data.code: "daemon-not-ready"`, `retryable: true`, matching outer and
snapshot retry delays, and a valid schema-1 snapshot in `preparing`, `indexing`
or `finalizing`, with a nonempty `daemonVersion`. Invalid optional progress or
missing/invalid durations, attempt identity or version, unknown schema/phase, a `ready`/`failed`
snapshot, terminal error or unrelated error never qualifies. Do not infer a live
attempt merely from error text or the presence of a version string.

For example, a CLI built as `0.10.47` observing a valid protected startup error
whose snapshot identifies daemon `0.10.46` prints this stdout JSON and exits 0:

```json
{"version":"0.10.46","ready":false,"startup":{"startupStatus":1,"daemonVersion":"0.10.46","attemptId":"boot-a","phase":"preparing","elapsedMs":1200,"phaseElapsedMs":1200,"progressAgeMs":1200,"retryAfterMs":1000}}
```

The old sitter consequently sees `0.10.46`, never the CLI's `0.10.47`, and cannot
mistake that daemon for its requested newer target. This JSON has no JSON-RPC
envelope: it is a CLI projection of an error, with exactly `version`, `ready` and
`startup`; the captured network response still contains `error`, not `result`.
For true readiness the existing successful `system.status` result is passed
through unchanged; it need not acquire a new `ready` field. Failure/unsupported
projection keeps normal CLI error diagnostics on stderr and a nonzero exit.
The [CLI fixtures](./fixtures/startup/cli-compat.json) pin both positive and
negative cases, including mixed CLI/server versions.

## Verification and implementation handoff

[Examples](./fixtures/startup/status.json) cover every phase, unknown ETA, restart,
failure and early handshake rejection. Their [static tests](./fixtures/startup/contract.test.mjs)
validate the documented samples only; they are not listener/transaction evidence.
Run `node --test docs/protocol/fixtures/startup/contract.test.mjs` and
`make consumer-checks` for this docs change.

Component acceptance requires regression/functional tests of: status responsiveness
while a real index transaction is blocked; zero ordinary reads/writes/subscriptions
and hello persistence before ready; count/UTF-8 byte accuracy; suppressed ETA;
commit failure and restart rollback; ownership/bind cleanup; disabled API, TLS,
origin, bad/missing/owner/per-principal credentials; public health versus protected
progress; saved owner Tailcat reachability; fresh authenticated handoff under concurrent
requests; and both FE transports' startup/old-peer/reconnect/late-response behavior,
including fresh unchanged progress versus failed or disconnected status polling.
Also run an **unmodified frozen sitter** against the new daemon/CLI through
indexing longer than its original startup deadline: cover start, supervisor and
update probes, mismatched CLI/server versions, failed startup, absent/stalled
responses and true readiness. Fixtures only validate the specified projection;
they do not prove a real old sitter survives or preserve its shutdown behavior.
Use temporary databases and controlled barriers, never the live user's database.
Relevant FE seams are `src/features/backend/main/json-rpc-client.ts`, backend
acquisition/adoption and IPC connection state, and
`src/lib/client/live/browser-websocket-transport.ts`. A renderer-only screenshot
cannot qualify Electron acquisition, IPC or supervisor behavior.
