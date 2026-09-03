> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.7 daemon status identity · §5.37 Managed Unsloth server — `unsloth.*` · §5.39 Token-rate history — `stats.getRateHistory` · §5.43 Daemon stack sampling — `debug.sampleStacks`.

### 5.7 Daemon build identity — `system.status`

The `system.status` result keeps its required `version` field and can also carry the additive
`buildCommit` string. `buildCommit` is the source commit embedded when the daemon binary was
built. It is omitted, never `null`, when that identity is unavailable. Clients must detect it
by field presence and must continue to use `version` as the release version.

### 5.7 Exact-version daemon updates — `system.requestUpdateVersion` *(v9.5)*

This additive fast-path method is available over authenticated UDS and WSS. It is
**distinct from** parameterless `system.requestUpdate`, whose historical handlers ignore
params and ask for the moving channel tip. Never send a version to that older method.

| Method | Params | Result |
| --- | --- | --- |
| system.requestUpdateVersion | `{ version: string }` (required, no extra fields) | `{ ok: true, accepted: true, version: string }` |

`version` must be canonical SemVer: `X.Y.Z` optionally followed by a valid prerelease
suffix, such as `1.2.3-beta.1`. Published prerelease pins are preserved verbatim for the
immutable `v<version>` release tag. Core numbers are unsigned 64-bit decimal components
without leading zeroes (except `0`); prerelease identifiers follow SemVer, including its
no-leading-zero rule for numeric identifiers. Leading `v`, whitespace, ranges, URLs/paths,
malformed identifiers and build metadata are rejected. Numeric releases distributed on
alpha are also supported. Invalid params return `-32602` before sitter handoff.

`system.status` adds **`exactVersionUpdateSupported: boolean`**, always present on capable
daemons and absent on older daemons. A client must require `=== true`; `updateSupported`
alone is insufficient. It is true only on Unix when the verified live sitter parent set
the v1 capability marker and its private control socket exists. A new daemon under an
old sitter reports false. This read-time hint is not a handoff guarantee: the sitter can
exit between status and the request. The method checks again and requires the sitter's
exact-version acknowledgement. Unsupported installations/platforms, refusal to downgrade,
another active update, and failed/invalid/timed-out handoffs return `-32603`. Old daemons
return `-32601` for the unknown method. **None of these errors permits a latest fallback.**

Success means **accepted, not installed or running**. The sitter resolves only
`v<version>/intentd-<target>.tar.xz` and its `.sha256` sidecar from the trusted release
repositories (the public distribution repository first, then the original source release
repository). It does not read a channel manifest. Missing/unavailable/invalid artifacts,
checksum or extraction failures leave the installed daemon unchanged. Existing checksum
verification and atomic binary/state installation apply. Neither the running daemon nor
the installed state may be newer than the requested version; unknown installed version
identity is refused rather than allowing a downgrade. Channel configuration is unchanged.

The sitter reserves a cross-process update lock **before acceptance**. Concurrent periodic,
SIGUSR1 and CLI installs are rejected/coalesced, not queued to install a channel tip later.
The reservation spans the download and supervised child restart, then a **60-second
stabilization window** after child spawn. Failure also retains a 60-second window so
coalesced checks cannot act as a latest fallback. SIGHUP child restarts during that window
keep the selected version. After the window, normal newer-only channel checks resume on
their usual schedule: this is not a permanent pin. The reservation is process-scoped;
explicitly stopping/restarting the sitter ends it and restores normal startup checking.

Clients must reconnect to the **same remote** and compare `system.status.version` with
the accepted target before claiming completion. A timeout, unchanged version, different
version or disconnect is not success; explain that installation may have failed and offer
a deliberate retry. Do not automatically downgrade an already-newer remote.

**Legacy installations:** upgrading only the managed daemon cannot upgrade its sitter.
The user must explicitly upgrade/reinstall the packaged sitter using the
[installation guide](../../../packages/intentd/README.md#install) for their installer or
package manager, restart the sitter service, then reconnect and check the new capability. This is a separate manual maintenance action: warn that the legacy startup
workflow follows its configured channel. Do not silently perform that channel update as
part of an exact-version request, and do not offer database-unsafe binary downgrades as a
workaround. If maintenance advances the remote beyond the app pin, update the app instead
of downgrading the remote. No new contract can make an already-installed old sitter honor
an exact target.

### 5.37 Managed Unsloth server — `unsloth.status` / `unsloth.stop` *(v2.5)*

The daemon owns a **singleton managed Unsloth server** (the `unsloth` CLI process plus the
`llama-server` child it spawns, which holds the model weights) backing every `unsloth`-provider
agent (model catalog §5.30; startup progress surfaces as the repeated `launch`-phase
`agent:stream:status` events, §6.5). These two router methods expose observability and control
over it. Both are **daemon-global**: they take no params and no `workspaceId` (like
`system.capabilities`), and are available on both UDS and WSS.

| Method | Params | Result |
| --- | --- | --- |
| unsloth.status | — (empty `{}`) | `{ running: boolean, repoId?, port?, pid?, uptimeSecs?, phase?, cpuPercent?, memoryBytes?, attachedAgentCount? }` |
| unsloth.stop | — (empty `{}`) | `{ stopped: boolean }` — `stopped: false` means nothing was running (a **no-op result**, never an error) |

**`unsloth.status`** — a point-in-time snapshot of the managed server. With a server up,
`running: true` and the other fields are present:

- `repoId` — full HF repo id currently served (or being started), e.g.
  `"unsloth/gemma-3-27b-it-GGUF"` (on the wire the pair is provider `unsloth` plus the bare
  `<repoId>` as the model id, §5.30).
- `port` — port the managed server listens on (default `8888`); `pid` — OS pid of the server
  child (`null` when unknown).
- `uptimeSecs` — seconds since the server child was spawned.
- `phase` — coarse startup phase: `"starting"`, `"minting"`, `"loading"`, or `"ready"`.
- `cpuPercent` / `memoryBytes` — resource usage sampled at snapshot time and **summed across the
  server's whole process tree** (root plus descendants — the `llama-server` child holds the
  model weights, so the tree total is what matters for capacity planning). `cpuPercent` follows
  the raw `sysinfo` convention (100 = one full core) and is `0.0` when the pid is unknown or the
  sample failed.
- `attachedAgentCount` — the number of currently-tracked agents spawned with the `unsloth`
  provider, counted **regardless of `running`** (a stopped-but-attached state is possible
  mid-restart). When no server is up the result degrades to
  `{ running: false, attachedAgentCount }`; a daemon whose agent manager is not attached
  (composition-root wiring — e.g. a bare test harness, or a daemon that has never spawned any
  agent infrastructure) reports exactly `{ "running": false }`.

Status reads never block behind an in-flight startup: the snapshot is served from a lock-free
identity mirror, so `unsloth.status` stays responsive even during a minutes-long first-use model
download. A dead-and-reaped server child reports as `running: false`, never as a stale identity.

**`unsloth.stop`** — gracefully terminates the managed server and its **whole process tree** if
one is running; an in-flight startup is aborted within about one probe tick rather than leaving
the stop blocked behind the startup window. `stopped: true` means a server (or in-flight
startup) was actually torn down. Stopping is **safe while agents are attached** — the daemon
neither blocks nor warns; a client that wants an "N agents are still using this server"
confirmation should check `unsloth.status`'s `attachedAgentCount` first. A later
`unsloth`-provider spawn simply starts the server again.

```json
// → request
{ "jsonrpc":"2.0","id":97,"method":"unsloth.status","params":{} }
// ← response (server up)
{ "jsonrpc":"2.0","id":97,"result":{
  "running":true,"repoId":"unsloth/gemma-3-27b-it-GGUF","port":8888,"pid":48113,
  "uptimeSecs":312,"phase":"ready","cpuPercent":184.2,"memoryBytes":17179869184,
  "attachedAgentCount":2 } }
// ← response (no server running; agent manager attached)
{ "jsonrpc":"2.0","id":97,"result":{ "running":false,"attachedAgentCount":0 } }

// → request
{ "jsonrpc":"2.0","id":98,"method":"unsloth.stop","params":{} }
// ← response
{ "jsonrpc":"2.0","id":98,"result":{ "stopped":true } }
```

### 5.39 Token-rate history — `stats.getRateHistory` *(v2.9)*

The backend owns a global **per-minute token-rate history** (the HUD TOK/MIN chart).
Recording is daemon-internal and rides the same turn-end bookkeeping as the hourly usage
stats (§5.36): at the end of each prompt turn the daemon folds the turn's clamped **token
delta** — the identical delta that feeds `usage_stats_hourly`, never a raw cumulative
snapshot — into a `usage_rate_minutely` row keyed by the RFC-3339 **UTC minute floor**
(`"YYYY-MM-DDTHH:MM:00Z"`). Rates aggregate **across all workspaces**: there is
deliberately no workspace / model / provider dimension. All-zero deltas are skipped. The
table is capped by retention: an hourly reaper deletes buckets at or older than the
**24h** cutoff (inclusive, so a boundary-aligned sweep still holds the cap), bounding it
at ≤ 1440 rows. Only the **read** crosses the wire — recording has no RPC.
`stats.getRateHistory` is global: it takes **no** `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| stats.getRateHistory | limit: integer 1–1440, default 60 — the number of trailing minute samples | `{ samples: RateSample[] }` — -32602 on a non-integer or out-of-range limit |

**RateSample** — `{ bucketUtc, inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, thoughtTokens }`:

- **samples** — exactly `limit` entries in **chronological order** (oldest first), one per
  minute, ending at the **current UTC minute floor**. Minutes with no recorded activity
  are **zero-filled**, so the array is always a gap-free minute-by-minute series; an empty
  store returns all-zero samples, never an error.
- **bucketUtc** — the sample's UTC minute floor (`"2026-07-30T14:07:00Z"`). Keys sort
  lexicographically in chronological order.
- The token counters are the minute's accumulated per-turn deltas (same clamped-≥ 0
  semantics as §5.36's UsageTotals).
- **thoughtTokens** *(additive within v6.0, [intent-hq/intentd#976](https://github.com/intent-hq/intentd/pull/976))*
  — the minute's accumulated reasoning ("thought") token deltas, the per-minute counterpart
  of the `TokenUsageTotals.thoughtTokens` counter (§5.31). Unlike that omitted-when-zero
  field, samples here are **dense**: every counter is always present, so a minute with no
  reasoning tokens (including every bucket recorded before this field shipped) emits
  `"thoughtTokens": 0`. Clients written against the pre-`thoughtTokens` shape are
  unaffected — the counter is additional. It is **disjoint** from `outputTokens`: providers
  whose wire report is a subset (codex, grok) have it carved out of `outputTokens` at
  ingestion (intent-hq/intent#3796), so clients may sum all five counters freely.

Note the trailing-window semantics: like §5.36's `24h` period this is an **absolute
rolling window** ending at the current minute; there is no timezone parameter — samples
are UTC and any local-time rendering is a client concern.

```json
// → request
{ "jsonrpc":"2.0","id":95,"method":"stats.getRateHistory","params":{ "limit":3 } }
// ← response
{ "jsonrpc":"2.0","id":95,"result":{ "samples":[
  { "bucketUtc":"2026-07-30T14:05:00Z","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":0 },
  { "bucketUtc":"2026-07-30T14:06:00Z","inputTokens":7,"outputTokens":2,"cacheReadTokens":0,"cacheCreationTokens":0,"thoughtTokens":0 },
  { "bucketUtc":"2026-07-30T14:07:00Z","inputTokens":100,"outputTokens":40,"cacheReadTokens":20,"cacheCreationTokens":10,"thoughtTokens":15 } ] } }
```

### 5.43 Daemon stack sampling — `debug.sampleStacks` *(v6.3)*

Point-in-time sample of the daemon's **own** thread stacks ([monorepo#1755](https://github.com/intent-hq/monorepo/issues/1755)), the backend of the FE Help menu's "Sample intentd Process" flow (the Activity Monitor "Sample Process" analogue): the daemon captures its own thread backtraces in-process over a short window and returns the rendered, human-readable text report — no debugger, no shelling out to `/usr/bin/sample`, works over UDS and WSS alike (including remote daemons). Daemon-global — no `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| debug.sampleStacks | durationMs?, frequencyHz? | { report, durationMs, frequencyHz, sampleCount, distinctStacks } |

**Params** (both optional; a present non-numeric value — other than `null`, which reads as absent — is `-32602`):

- `durationMs?: number` — the sampling window in milliseconds, **clamped server-side** into [100, 10000]; default 1000. The RPC blocks for (at least) the effective window, so clients should size their request timeout accordingly.
- `frequencyHz?: number` — the sampling frequency in Hz, clamped into [1, 250]; default 99 (the conventional off-by-one from 100 that avoids lockstep with periodic work).

**Result:**

- `report: string` — the rendered text report: a header line stating the effective parameters and totals, then one block per distinct stack (highest sample count first), each naming its thread (name + id) and frames (symbol, and source file:line where available). **Never empty** — the header always renders; when no samples landed the report says so explicitly.
- `durationMs` / `frequencyHz: number` — the **effective** (clamped/defaulted) parameters the capture actually used.
- `sampleCount: number` — total samples captured across all threads.
- `distinctStacks: number` — number of distinct (thread, stack) entries in the report.

**Semantics & caveats:**

- **CPU-time sampling** (Unix `setitimer(ITIMER_PROF)` + `SIGPROF`, via the in-process `pprof` sampler): samples land on threads in proportion to CPU consumed, so a busy/spinning thread dominates the report and blocked/idle threads accumulate none — a fully idle daemon can legitimately return `sampleCount: 0`. This is exactly the right bias for the motivating diagnoses (CPU pegs, busy stalls); it does **not** enumerate parked threads the way macOS `sample` does.
- **One session at a time**: the profiler's signal handler is process-global, so a concurrent call fails immediately with `-32603` ("a stack sampling session is already in progress") rather than queueing.
- **The daemon never hangs while sampling**: the capture runs on the blocking pool; the async runtime and every other RPC proceed normally during the window.
- **Platform support**: Unix only (macOS, Linux). On other platforms (Windows) the method returns `-32603` with a message naming the limitation ("not supported on this platform") — clients should treat this as "hide/disable the menu item", keyed off the platform they already know.

```json
// → request
{ "jsonrpc":"2.0","id":1,"method":"debug.sampleStacks","params":{ "durationMs":1000,"frequencyHz":99 } }
// ← response
{ "jsonrpc":"2.0","id":1,"result":{
  "report":"intentd stack sample — 87 samples, 5 distinct stacks (1000 ms at 99 Hz, CPU-time sampling: idle/blocked threads accumulate no samples)\n\n61 samples — thread \"tokio-runtime-w\" (id 6154):\n    0: intent_services::disk_usage::walk (crates/intent-services/src/disk_usage.rs:118)\n  ...",
  "durationMs":1000,"frequencyHz":99,"sampleCount":87,"distinctStacks":5 } }
```

