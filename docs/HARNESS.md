# Harness Versioning

> Audience: engineers working on `intentd` (`packages/intentd`) and
> `cloudlands-fe` (`packages/cloudlands-fe`). Companion documents:
> [ARCHITECTURE.md](./ARCHITECTURE.md) (backend architecture) and
> [protocol/methods/agents.md](./protocol/methods/agents.md) §5.5 (the wire contract for
> `harnessVersion` / `harnessFeatures` — wire shapes are specified there,
> not here).

The **harness** is the versioned owner of every system-generated string that
shapes an agent's behavior: the assembled system prompt, the per-turn prompt
envelope, wake/queue system messages, notices, and the bundled instruction
and specialist markdown ("doctrine"). Versioning it gives every agent session
a permanent, creation-time pin to the exact doctrine it was created under, so
a daemon upgrade never silently changes what an existing session runs with.
Today the session pin governs system-prompt/doctrine assembly (and the
specialist bundle); the turn-envelope and wake/notice surfaces are versioned
behind the same trait but their call sites still resolve the latest harness —
routing them through the session's stamp is the intended end state.

## Doctrine vs. reference

Two layers with different versioning rules:

- **Doctrine** — the instruction/prompt *text* and the `agentFeatures` values
  a session was created under. Versioned by the harness; pinned per session
  at creation; immutable for the session's life.
- **Reference** — the wire protocol and method catalog, MCP tool schemas, and
  runtime semantics. Always tracks the live binary; **never** versioned by
  the harness. `harnessVersion` / `harnessFeatures` are additive response
  fields within the protocol, and a harness version bump is independent of
  the protocol version.

## The creation-time stamp

Every agent session is stamped **at creation** with two immutable fields,
served on the `AgentSession` and `AgentLite` projections (shapes in
[protocol/methods/agents.md](./protocol/methods/agents.md) §5.5):

- **`harnessVersion`** — the harness version current at creation
  (`intent_core::CURRENT_HARNESS_VERSION`, today `"1.1"`). There is no
  upgrade/migration/pinning operation; new sessions always get the latest
  version. The stamp depends only on creation time, never on the creator: a
  delegated child mints the current version regardless of the parent's pin,
  so mixed-version agent trees in one workspace are expected. Pre-feature
  rows are backfilled to `"1.0"`, and legacy imports stamp the literal
  `"1.0"` — never the current constant — so pre-harness sessions are never
  mislabeled after a version bump.
- **`harnessFeatures`** — a snapshot of the effective `agentFeatures` on/off
  values at session creation. Later settings changes affect only new
  sessions, and **the snapshot is what the session actually runs with**:
  session (re)spawns resolve the agent's MCP tool surface and prompt assembly
  from the persisted snapshot, not the live settings, so the wire report
  never disagrees with the runtime surface. This covers the per-turn
  state-snapshot injection too — `stateSnapshot` is resolved from the
  captured snapshot like every other toggle. Two documented exceptions stay
  live (`backgroundHooks` is re-checked live on every `hook.schedule`, and
  `mcpTools` is re-checked live on every forwarded `ws.mcp.*` call — a flip
  to `false` acts on existing sessions immediately) — there, the captured
  value records the creation-time setting without freezing the behavior.

Legacy sessions persisted before the feature snapshot existed (NULL in the
store) follow the live effective settings on read until their first
post-launch activation, which materializes the snapshot once from the
resolved live values — with one exception: the legacy per-session `taskGraph`
pin, where present, wins over the live setting for that key, matching the
pre-freeze read — and persists it (idempotent: the store write is guarded
on `harness_features IS NULL`). From then on the row reads its frozen
snapshot like any new session; `harnessVersion` stays `"1.0"` — only the
flags freeze.

## Backend implementation (`intentd`)

The harness lives in `crates/intent-services/src/harness/`:

- **`Harness` trait** (`harness/mod.rs`) — one method per system-generated
  text surface (prompt-layer joining, rule wrappers, specialist sections,
  turn-envelope composition, completion wakes, PR-monitor notices, the
  delegation first message, …). Implementations own 100% of the wording;
  call sites carry typed data in and never format doctrine/envelope text
  themselves, so a future version can reword or reorder surfaces without
  touching the managers.
- **One module per version** — `harness/v1.rs` implements the v1 text set;
  `harness/v1_1.rs` (v1.1) reuses v1's text surfaces wholesale and swaps in
  its own doctrine (the feature-section rewrites in `common.md`; every other
  instruction body and the specialist bundle are byte-identical v1 copies).
  A new version starts as re-exports of the prior version's surface
  functions and overrides only what changed, so the version-to-version diff
  is exactly the changed surfaces.
- **`Doctrine`** — each version bundles its instruction markdown set
  (`resources/agent-instructions/<ver>/`, compiled in via `include_str!`)
  and its embedded specialist prompt bundle
  (`resources/specialists/<ver>/`). All past versions stay bundled in the
  binary so an old session keeps assembling the exact doctrine it was
  created with.
- **`REGISTRY` / `HarnessEntry`** — maps a stamped `harnessVersion` string
  to its harness, doctrine, the `agentFeatures` defaults that version's
  doctrine assumed, and human-readable feature labels. `LATEST_VERSION` is
  `intent_core::CURRENT_HARNESS_VERSION` itself, so the stamp and the
  registry can never drift (pinned by unit tests). Resolving an unknown
  version falls back to the latest with a WARN — a stale or corrupt stamp
  never fails a turn.

Prompt assembly resolves the **session's** pinned entry
(`rules.rs::session_harness_entry`); session-less callers (previews,
background one-shots) use the latest. The session's captured
`harnessFeatures` snapshot gates feature-specific doctrine sections (e.g.
`taskGraph` gates task-relations teaching; `backgroundHooks` /
`scripts` / `terminalAccess` / `richChatBlocks` / `structuredQuestions` /
`attentionRequests` gate their sections) — with every gate open, the
bundled markdown is used untouched.

### Golden tests

The doctrine text is **byte-pinned**: `intent-services/src/v1_goldens.rs`
asserts full literal bytes (or a SHA-256 pin for the large bundled layers)
of every system-generated string that reaches an agent conversation
(`v1_1_goldens.rs` pins the v1.1 doctrine the same way), and
`agent_manager::v1_turn_envelope_goldens` pins the composed turn envelope.
Any wording or whitespace change to a versioned surface fails that
version's goldens and must be answered by minting a new harness version —
a version's goldens are never updated to absorb a doctrine change. Code
moves that keep the output byte-identical (refactors) pass the goldens
unchanged; that is what they exist to prove.

### Minting a new harness version

A new version is warranted when doctrine text or the feature defaults a
version's doctrine assumes change materially. The mechanical steps:

1. Bump `CURRENT_HARNESS_VERSION` in `intent-core` (`model.rs`).
2. Add `resources/agent-instructions/<ver>/` and
   `resources/specialists/<ver>/` directories (copy-then-edit from the
   prior version) and a new `InstructionSet` static in `instructions.rs`.
3. Add a `harness/v<N>.rs` module: re-export the prior version's surfaces,
   override only what changed.
4. Add the version's `HarnessEntry` row to the `REGISTRY` (oldest first).
5. Add goldens for the new version; the prior version's goldens stay
   untouched — they pin the old doctrine forever.

Registry unit tests enforce that the current constant resolves, that rows
are coherent (unique versions, wired doctrine, non-empty labels), and that
unknown versions fall back to the latest.

## Frontend surface (`cloudlands-fe`)

The stamp is read-only in the UI. The agent tab `⋯` menu and the AgentCard
context menu show a "Harness v{version}" item; selecting it opens
`HarnessFeaturesModal.svelte`, a read-only list of the session's
`harnessFeatures` snapshot (name + description per row, On/Off state).
The daemon always serves a `harnessFeatures` value (legacy pre-snapshot
rows follow the live effective settings until activation freezes them —
see above), so the modal normally renders a real snapshot; as a defensive
fallback, an absent snapshot renders every catalog feature Off. Sessions
from daemons that predate the field omit the menu item entirely. Snapshot
keys unknown to the catalog (from a newer daemon) are rendered with
humanized labels rather than dropped, and catalog keys absent from the
snapshot render Off (an older harness never had the newer features).

## Design invariants

- **Stamps are permanent.** No API mutates `harnessVersion` or
  `harnessFeatures` after creation.
- **All versions ship in the binary.** Deleting a version's resources or
  registry row would silently re-doctrine old sessions; don't.
- **Byte changes are version decisions.** The goldens make doctrine edits
  impossible to land accidentally.
- **Fail open on resolution.** An unknown stamp resolves to the latest
  harness with a warning instead of failing the session's turn.
