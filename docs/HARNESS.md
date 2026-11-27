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
  (`intent_core::CURRENT_HARNESS_VERSION` in that daemon). There is no
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
  consolidated post-unarchive notice for archive-cancelled hooks and PR
  monitors (v2.7, `workspace_archived_watches_cancelled_notice`), the
  delegation first message, …). Implementations own 100% of the wording;
  call sites carry typed data in and never format doctrine/envelope text
  themselves, so a future version can reword or reorder surfaces without
  touching the managers.
- **One module per version** — `harness/v1.rs` implements the v1 text set;
  `harness/v1_1.rs` (v1.1) reuses v1's text surfaces wholesale and swaps in
  its own doctrine (the feature-section rewrites in `common.md`; every other
  instruction body and the specialist bundle are byte-identical v1 copies),
  and `harness/v2.rs` reuses the unchanged system text while selecting the v2
  doctrine.
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

### Prepared repository guidance for 3.2, 3.3 and 3.4 sessions

The prepared delivery change in intentd
`73478bdaa5a09dc81307d4bfe7606a5a85983876` applies only to an active session
whose saved `harnessVersion` is explicitly admitted: `"3.2"` or `"3.3"` (and `"3.4"`, admitted by
intent-hq/intentd#2754). It adds recurring repository
guidance to ordinary ACP prompts after the original physical session is
confirmed. It does not change a session's stamp, feature snapshot or doctrine,
introduce a new major version, or establish support in an installed daemon.

The manager retains the original Services allocation, repository read owner,
workspace/agent and matching ACP Connection. It captures guidance before later
prompt or startup metadata awaits, then validates the original authority again
at final transfer. Replacement, retirement or unavailable authority omits the
optional guidance; an ID or provider name cannot reconstruct that authority.
The ordinary prompt remains available through its existing path.

Delivery is an additional text block in the original `session/prompt`, with an
8 KiB maximum. It is **not a system- or developer-role update**. The applicable
boundaries are a daemon-owned turn or explicit continuation, successful load,
recreation after failed load, and an existing supported output-free retry.
Retries recapture on the same original binding before backoff; streamed errors
do not authorize replay. A provider's internal loop or compaction without a new
daemon prompt boundary has no new delivery hook.

The initial doctrine channels remain unchanged. The inventory below describes
the candidate's provider configuration, not native execution of every runtime.
All rows use the same conditional daemon prompt-text path above:

| Runtime in the candidate | Initial doctrine channel | Qualification |
| --- | --- | --- |
| Claude `@agentclientprotocol/claude-agent-acp@0.81.1` | Session metadata | Node 22+/npm 7.7+; secondary CLI version is not globally pinned. No new native role-mapping proof. |
| Codex `@agentclientprotocol/codex-acp@2.1.1` | First-turn prepend | Installed CLI qualified separately; no within-Codex-loop claim. |
| Pi `pi-acp@0.0.34`, Pi CLI 0.81.0+ | First-turn prepend | Initial workspace MCP uses the Pi extension; native extension-loop delivery is not established. |
| Auggie CLI 0.7.0+ | `--rules` file | `--mcp-config` remains the initial tool channel; native acceptance is separate. |
| OpenCode / Unsloth through OpenCode | Generated environment configuration | Installed versions are not globally pinned; Unsloth's generic test prompt is unsupported. |
| Grok agent stdio | First-turn prepend | Installed version is not globally pinned; no new native discovery or loop claim. |
| Antigravity `agy acp` (agy 1.5.0+) | First-turn prepend | User's own agy settings, hooks and MCP servers; role tool limits are prompt-only. |
| Droid, environment-gated | `--append-system-prompt-file` | No feature/default activation or native acceptance follows. |
| Cortex, environment-gated | First-turn prepend | No workspace MCP delivery channel, hence no workspace-tool-result claim. |

Prompt delivery does not acknowledge a private callback or promote the initial
pending MCP endpoint. Fresh optional workspace-tool results and private monitor
delivery still require their genuinely negotiated, acknowledged original
callback route. The standard prompt-only context cannot substitute for it.

Missing, `2.9`, `2.10`, `3.0`, `3.1` and unknown saved stamps do not acquire this
new fallback during turn, load, recovery or tool response. Their persisted
instructions/features and existing behavior remain pinned. The general registry
fallback for an unknown version is not admission to this explicit
`3.2`/`3.3`/`3.4` path.

The source's finite checks exercise real daemon ownership with a controlled
ordinary ACP peer. They do not establish production adapter/model acceptance,
true role-channel updates, provider-owned within-turn delivery or unsupported
private-tool support. Landed-source integration and native acceptance remain
separate from this prepared contract; it does not promote experimental delivery
into the bundled app guide.

Harness 3.3 (intentd `6b776f5216047587f55fc2fd4be113dddc714dca`,
intent-hq/intent#5835) is admitted to the same path with the same guidance
text. It differs from 3.2 only in instruction composition: an unknown or
default agent type (including the `interactive` spawn default) gets the
workspace instruction body once instead of as both the workspace layer and
the fallback body. Text surfaces, specialist prompts and feature defaults
are 3.2's. Existing sessions stay pinned to their saved stamp, so a 3.2
session keeps its original composition.

Harness 3.4 (intent-hq/intentd#2754) is admitted to the same path with the same
guidance text. It differs from 3.3 only in the common instruction body, which
gains a "Link other workspaces" section: in chat and notes, agents mention
another workspace as `[Workspace Title](intent://local/workspace/<workspaceId>)`
and never by its bare internal ID (outside Intent they use the plain title).
Composition, text surfaces, specialist prompts and feature defaults are 3.3's,
and a 3.3 session keeps its original prompt. The same change adds `link` /
`markdownLink` to the `ws.crossWorkspace.listSiblings` rows and the
`ws.workspace.applyProposal` result; tool output follows the running daemon, so
every session sees those fields regardless of its stamp.

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
version's doctrine assumes change materially. Start every bump with the make
target, from `packages/intentd` in a monorepo checkout:

```bash
make new-harness-version FROM=3.15 TO=3.16    # DRY_RUN=1 lists the files only
```

`FROM` must be the current version. The target registers `TO` as an exact
copy of `FROM` and writes nothing unless every edit applies. It edits:

1. `intent-core/src/model.rs`: `CURRENT_HARNESS_VERSION`, and `TO` appended to
   `REPOSITORY_GUIDANCE_HARNESS_VERSIONS` and
   `REPOSITORY_MONITOR_GUIDANCE_HARNESS_VERSIONS`.
2. `intent-core/src/prompt_breakdown.rs`: `harness_records_prompt_breakdown`
   admits `TO`, and its test asserts it.
3. `intent-services/src/context_budget.rs`: `PREVIOUS` becomes `FROM`.
4. `intent-services/src/harness/mod.rs`: the `pub(crate) mod v<TO>;` line and
   the `REGISTRY` row (oldest first).
5. `harness/v<FROM>.rs`: its test stops pinning `FROM` as the current version.
6. `harness/v<TO>.rs` (new): reuses every `FROM` surface; its test pins `TO`
   as current.

The protocol docs do not list harness versions, so a bump needs no monorepo
docs change.

Then make the version's own change by hand:

1. Copy and edit each changed resource set under the new version
   (`resources/agent-instructions/<ver>/`, `resources/specialists/<ver>/`).
   Unchanged instruction bodies or specialist bundles reuse the prior
   version. Add a new `InstructionSet` static in `instructions.rs` or bundle
   const in `specialists.rs` only for a changed set.
2. In `harness/v<TO>.rs`, override only what changed and replace the matching
   "unchanged" assertion in its test with one that pins the change.
3. Pin new text surfaces in goldens. The prior version's goldens stay
   untouched; they pin the old doctrine forever.
4. If the change is user-facing, update the assistant app guide in the same
   intentd PR.
5. The bump keeps `FROM`'s repository guidance and prompt breakdown
   admissions. To drop either, edit those lists by hand: it is a per-version
   decision, not a routine edit.

Run `make check` and `make test-select E='test(harness)'` before opening the
intentd PR.

Registry unit tests enforce that the current constant resolves, that rows
are coherent (unique versions, wired doctrine, non-empty labels), and that
unknown versions fall back to the latest. Compile-time checks fail the build
when the guidance lists miss the current version. intentd's release-scripts
CI job runs the target on a copy of the real files, so a layout change that
breaks it fails on that PR.

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
