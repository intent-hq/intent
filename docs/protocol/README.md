# Intent Backend — JSON-RPC Protocol

**Documented Protocol Version:** `10.9` (additive contract ahead of implementation; pinned daemon: `10.8`). Detect support through the [capability contract](./methods/shared-host-membership.md#authority-and-discovery).

This directory is the canonical wire contract between Intent clients (desktop, iOS, CLI, and agent developers building clients) and the Intent backend daemon (`intentd`): transport, JSON-RPC envelope, the full method catalog, events, agent streaming, the permission flow, error codes, and thin-client guidance. It is a **living specification**: changes land through the compatibility policy (see below), and the method surface is enforced by golden tests in the `intent-transport` crate.

## Section → file map

| Section | File |
|---------|------|
| Protocol Version & Compatibility (incl. Compatibility Policy) | [versioning.md](./versioning.md) |
| §1 Transport (1.1–1.4) | [01-transport.md](./01-transport.md) |
| §2 Authentication (2.1–2.3) | [02-authentication.md](./02-authentication.md) |
| §3 Message Envelope (JSON-RPC 2.0) (3.1–3.6) | [03-envelope.md](./03-envelope.md) |
| §4 Heartbeat & Lifecycle | [04-heartbeat.md](./04-heartbeat.md) |
| §5 Method Catalog — intro, router/fast-path method tables, aliases, client-served reverse RPCs | [05-method-catalog.md](./05-method-catalog.md) |
| §6 Events & Subscriptions (6.1–6.9) | [06-events.md](./06-events.md) |
| §7 Agent Streaming (7.1–7.3) | [07-agent-streaming.md](./07-agent-streaming.md) |
| §8 Permission Flow | [08-permission-flow.md](./08-permission-flow.md) |
| §9 Error Codes (incl. 9.1) | [09-error-codes.md](./09-error-codes.md) |
| §10 Thin-Client Guidance (10.1–10.4) | [10-thin-client.md](./10-thin-client.md) |

### §5.x subsections (`methods/`)

| Subsection | File |
|------------|------|
| §5.1 `workspace.*` | [methods/workspace.md](./methods/workspace.md) |
| §5.2 `note.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.2.1 `note.lineAttribution.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.3 `comment.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.4 `task.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.5 `agent.*` | [methods/agents.md](./methods/agents.md) |
| §5.5a `sandbox.cow.*` (CoW agent sandboxes) | [methods/agents.md](./methods/agents.md) |
| §5.6 `git.*` | [methods/git.md](./methods/git.md) |
| §5.7 `pr.*` | [methods/pr.md](./methods/pr.md) |
| §5.8 `script.*` | [methods/scripts.md](./methods/scripts.md) |
| §5.9 `browser.*`, `terminal.*`, `file.*` | [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) |
| §5.10 `event.*` (query/aggregation) | [methods/events-query.md](./methods/events-query.md) |
| §5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*` | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.12 `settings.*` | [methods/settings.md](./methods/settings.md) |
| §5.13 Interactive `terminal.*` | [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) |
| §5.14 Execution locus, locality & remote behavior | [methods/execution-locus.md](./methods/execution-locus.md) |
| §5.15 `search.*` | [methods/search-drafts.md](./methods/search-drafts.md) |
| §5.16 `drafts.*` | [methods/search-drafts.md](./methods/search-drafts.md) |
| §5.17 `client.hello` handshake, stable client identity & `client.list` | [methods/client-hello.md](./methods/client-hello.md) |
| §5.18 `accept-changes.*` | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.19 `file-tracking.*` (reads) | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.20 Change metrics (reads) | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.21 `rules.*` | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.22 `mcp.servers.*` (incl. §5.22.1 `mcp.oauth.*`, §5.22.2 `mcp.testConnection`) | [methods/mcp-servers.md](./methods/mcp-servers.md) |
| §5.23 Usage metrics — `workspace.getTokenUsage` | [methods/workspace.md](./methods/workspace.md) |
| §5.24 Session stats — `agent.getSessionStats` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.25 Worktree setup scripts — `workspace.getSetupScript` etc. | [methods/workspace.md](./methods/workspace.md) |
| §5.26 Future integrations & observability | [methods/integrations.md](./methods/integrations.md) |
| §5.27 `github.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.28 `linear.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.29 `sentry.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.30 `models.list` — model catalog | [methods/models-providers.md](./methods/models-providers.md) |
| §5.31 `agent.enhancePrompt` — one-shot prompt enhancement | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.32 `agent.completeOnce` — one-shot prompt→completion | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.33 `repoConfig.*` — per-repository configuration | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.34 Skills — `skill.list` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.35 Interrupted-agent resumption — `agent.listInterrupted` / `agent.resolveInterrupted` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.36 Agentic usage stats — `stats.getUsage` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.37 Managed Unsloth server — `unsloth.status` / `unsloth.stop` | [methods/system-observability.md](./methods/system-observability.md) |
| §5.38 Provider catalog — `providers.catalog` | [methods/models-providers.md](./methods/models-providers.md) |
| §5.39 Token-rate history — `stats.getRateHistory` | [methods/system-observability.md](./methods/system-observability.md) |
| §5.40 Background hooks — `hook.*` | [methods/hooks.md](./methods/hooks.md) |
| §5.41 Voice transcription — `voice.transcribe` / `voice.getWorkspaceVocabulary` | [methods/voice.md](./methods/voice.md) |
| §5.42 Centralized PR monitoring — `prMonitor.*` | [methods/pr.md](./methods/pr.md) |
| §5.43 Daemon stack sampling — `debug.sampleStacks` | [methods/system-observability.md](./methods/system-observability.md) |
| §5.44 Guided Antigravity setup — `providers.setup.*` | [methods/models-providers.md](./methods/models-providers.md#544-guided-antigravity-setup) |
| §5.45 Browser tab registry — `browser.listTabs` / `upsertTab` / `removeTab` / `syncTabs` / `navigateTab` / `closeTab` | [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) |
| §5.46 Connection principal — `principal.me` | [methods/client-hello.md](./methods/client-hello.md) |
| §5.47 Presence — `presence.*` / `note.presence.*` (ephemeral workspace roster + per-note viewer channel) | [methods/presence.md](./methods/presence.md) |
| §5.48 Multiplayer — `principal.*` / `workspace.invite.*` / `invite.*` / `workspace.members.*` (principals, invite links, the `/invite` proof join, membership, the collaborator allowlists) | [methods/multiplayer.md](./methods/multiplayer.md) |
| §5.49 Shared host membership, scoped invitations, collaboration identity and personal pairing | [methods/shared-host-membership.md](./methods/shared-host-membership.md) |
| MCP `ws.*` binding signature index (generated; not wire-routable) | [methods/mcp-bindings.md](./methods/mcp-bindings.md) |

`make check-protocol-catalog` (run by CI's `docs-check` job) enforces that the [05-method-catalog.md](./05-method-catalog.md) tables, the method tables in `methods/*.md`, and intentd's `intent-transport` catalog stay in sync (read from the `packages/intentd` checkout; like `check-event-catalog` and `check-protocol-field-parity`, the run names the checkout and the recorded pin on stdout and warns on stderr when they differ): every method documented in a `methods/*.md` table must appear in the catalog, and every method the pinned intentd catalog dispatches must have a catalog entry. The docs lead the pin: document a new method here first — a `methods/*.md` table row plus its catalog entry in one monorepo change; the checker only warns while the pinned `catalog.rs` does not carry it yet — then merge the intentd PR, and the automatic submodule bump passes once both exist. The reverse order fails: a pinned method with no docs row is a CI error, and once the `CI Gate` check is required it holds the rolling bump PR at the merge queue until the docs row lands. The same checks also run upstream: every intentd and cloudlands-fe PR calls the monorepo's reusable `.github/workflows/consumer-checks.yml` (`monorepo-consumer-checks`) with its own head in place of the pin, so a missing docs row is red on that PR before it merges, not on the bump afterwards.

`make check-mcp-bindings` (a prerequisite of `make docs-check`) covers the MCP-only `ws.*` surface the catalog does not: it parses the `WORKSPACE_API_DESCRIPTION` / `WORKSPACE_API_DESCRIPTION_CHIEF` help-text constants in intentd's `crates/intent-acp/src/mcp_server/tools.rs` — from the `packages/intentd` checkout by default (the run names the checkout and the recorded pin on stdout and warns on stderr when they differ), or from the recorded gitlink through git objects with `PINNED=1 make check-mcp-bindings` (`node scripts/check-mcp-bindings.mjs --pinned`; CI runs at the pin) — and enforces that (1) the generated signature index [methods/mcp-bindings.md](./methods/mcp-bindings.md) matches the help text line for line, (2) every `ws.<namespace>.<method>` name mentioned in prose under `docs/protocol/` exists in the help text (renamed bindings are listed in the script's `RENAMED_BINDINGS` map), and (3) every parameter or option name used in an inline-code signature mention such as `` `ws.pr.snapshot(prNumber, { repo? })` `` is a parameter/option of that binding. A change to a binding's help line (new option, new result field) therefore fails CI until `make mcp-bindings-doc` regenerates the index — and the regeneration diff names the binding whose prose paragraph needs updating.

## Transfer selection fixture contract

[`fixtures/transfer-selection/contract.json`](./fixtures/transfer-selection/contract.json)
owns the deterministic import-to-renderer test inputs and independent expectations.
It covers `auggie` / `acp` / `augment` / `default` × `direct` / `history` / `prefix` /
`auto` × destination Codex enabled / disabled: exactly 32 cases, in that order, with
enabled before disabled. Stable IDs are `<sourceProvider>:<mode>:codex=<true|false>`.
This is a test artifact contract, not an addition to the daemon wire protocol.

### Input and consumer interface

`formatVersion: 1` and `normalizationVersion: 1` are required. The lightweight
[`check-transfer-selection-contract.mjs`](../../scripts/check-transfer-selection-contract.mjs)
validator owns the executable schema, rejects unknown contract/envelope/row keys,
and pins the matrix semantics. A deliberate contract change updates the JSON,
validator, tests and consumers together; silently weakening expectations fails.

| Field | Consumer behavior |
|---|---|
| `destinationDefaults` | Apply `provider`, `model`, `reasoningEffort` as `model.defaultProvider`, `model.default`, `model.defaultReasoningEffort`: `codex` / `gpt-6-astra` / `high`. |
| `enabledProviders` | Start with `{auggie: true}` and add `codex: case.codexEnabled`. Auggie is available in every case, even when the destination default is disabled. |
| `providersCatalog` | Seed the renderer's real provider-catalog reducer/selectors with these two protocol-shaped entries. Aliases are intentionally absent. |
| `models` | Per-provider cache rows (`id`, `provider`, `name`, `isDefault`, `effortLevels`). Seed a fresh affirmative daemon catalog using the current cache version key. Renderer transport maps each row to `{value: provider + ':' + id, label: name, description: '', effortLevels}`. |
| `cases[].input` | Merge these five **snake_case** columns into the archived `agent_session` row: `provider`, `model`, `reasoning_effort`, `last_turn_provider`, `last_turn_model`. JSON null is SQL NULL. |
| `cases[].expectation` | Select `expectations.explicit` or `expectations.auto`. Each contains independent `selection`, `firstTurn`, and `renderer` assertions. |
| `cases[].expectedPersistedSelection` | Compare raw active `provider`, `model`, `reasoning_effort` columns after import. The canonical `auggie:gpt6-astra` prefix retains its raw spelling; alias prefixes become `gpt6-astra`. |
| `cases[].expectedRawHistory` | Compare raw `last_turn_provider` / `last_turn_model` columns exactly, including alias spelling and nulls. Do not compare only a normalized store read. |

`history` has an unset active provider and matching last-turn history; `prefix`
has an unset provider plus `<sourceProvider>:gpt6-astra`. Direct selection and Auto
carry the source provider. Explicit public selection and first-turn resolution
must be `auggie` / `gpt6-astra` / `low`. Auto must resolve to `auggie` with unset
model and effort; the provider chooses its automatic model. Expectations encode
unset as JSON null, but the public session must **omit** `model` and
`reasoningEffort`, preserving real serialization rather than inserting nulls.

Each import uses an isolated temporary database, settings, workspace/assets roots,
fresh cache and local inert provider availability fixture. Set the archive header's
daemon version from the compiled generator, not a fixed release number. No provider
authentication, model request, live turn or user database is needed. Resolve the
first turn through the existing daemon resolver without launching it. Always clean
temporary state on success and failure.

Component harnesses must accept `TRANSFER_SELECTION_FIXTURE_ROOT`, an absolute path to this
directory containing `contract.json` and the generated `public-sessions.json`.
In a monorepo checkout, their default is this directory through the actual parent
monorepo; a standalone component checkout must set the variable to a matching
monorepo fixture directory. Fail with the missing filename and variable name when
required files are unavailable. Do not search another workspace, download implicit
fallbacks, or silently skip. The Node validator resolves `--fixture-root` first,
then the environment variable, then its own monorepo-relative directory, independent
of the caller's working directory.

### Generated output and freshness

The daemon test harness owns generation of `public-sessions.json`; public-session
goldens must never be hand-written. The emitter must exercise real
`workspace.import.begin`, `workspace.import.chunk`, `workspace.import.commit` and
`agent.getSession` service paths. Its final JSON envelope has exactly these fields:

```typescript
{
  formatVersion: 1,
  normalizationVersion: 1,
  provenance: {
    kind: 'intentd-public-import',
    generator: 'intent-services/transfer-selection-contract',
    intentdRevision: string,  // full lowercase 40-character checkout HEAD SHA
    intentdDirty: false,      // checked from the source worktree, never assumed
    generatorSha256: string,  // SHA-256 of the generator Rust source file bytes
    contractSha256: string,   // hashJson(parsed contract.json)
    payloadSha256: string,    // hashJson(normalized cases array)
  },
  cases: [{
    id: string,               // same IDs and order as contract.json
    session: object,          // FULL serialized public agent.getSession result
    persisted: { provider, model, reasoning_effort, last_turn_provider, last_turn_model },
    firstTurn: { provider, model, reasoningEffort },
  }],
}
```

`persisted` contains those five raw exported columns, including nulls; `firstTurn`
contains the actual resolver's provider/model/effort triple, with null for unset.
Neither is copied from expected values. The generator source is
`crates/intent-services/src/transfer_selection_contract.rs`; its runner records that
file's byte hash and clean intentd HEAD. Commit the harness before producing a
publishable envelope. Runtime version/cache timestamps stay in the isolated input
setup, not in provenance. No generated-at timestamp is needed.

Only four fields in each `cases[].session` may be normalized:

| Field | Replacement |
|---|---|
| `id` | `agent-transfer-contract` |
| `workspaceId` | `ws-transfer-contract` |
| `createdAt`, `updatedAt` | `2000-01-01T00:00:00Z` |

Use the validator's exported `normalizeCases` on real emitted rows; it validates
nonempty IDs and UTC timestamps, preserves all other fields and array order, and
does not mutate the input. No path is currently volatile in the public response,
so no path replacement is allowed. New fields, including paths, remain visible to
freshness comparisons. Provider/model/effort/history, null versus omission, status,
attention fields, and harness features must never be scrubbed. The public session
must be idle/inactive with empty messages and no imported effort capabilities or
configuration attention. Additive public fields are retained rather than filtered.

`hashJson` is SHA-256 of compact UTF-8 JSON with object keys sorted recursively,
array order retained and no trailing newline. It rejects non-JSON values. Use the
exported helper to avoid serializer differences. Source and generator hashes are
evidence, not authentication: a fabricated but rehashed envelope can only be
excluded by actual generation. The connected gate must generate twice into separate
temporary files, assert equal normalized payloads, bind each envelope to the actual
checkout SHA and generator byte hash, then compare the fresh payload with the
checked-in golden. Validate semantic assertions even when hashes match. Changes to
source revision alone do not invalidate an otherwise identical public payload.

From the monorepo root, compilation-free input/schema checks are:

```bash
node --test scripts/check-transfer-selection-contract.test.mjs
node scripts/check-transfer-selection-contract.mjs --inputs-only
```

With a real generated golden present, the default command requires and validates
it, explicitly reporting that freshness was not checked. `--generated <file>` can
select an emitted envelope instead. `--fresh <separate-emission.json>` compares a
fresh envelope with the golden; `--intentd-revision <sha>` and
`--generator-sha256 <sha256>` bind the fresh envelope (or `--generated` when used
alone) to independently measured source metadata. A missing file fails; passing
the golden itself, a symlink or hardlink to it as `--fresh` fails. `--inputs-only`
cannot combine with output/provenance options. It is the explicit mode for the
docs-first contract addition and is not a connected-test substitute.

The Node unit tests construct an internal **synthetic schema fixture** only. It
has no daemon provenance and must never become the golden. Negative controls
separately reject payload tampering, missing/duplicate cases, alias public identity,
changed history, Auto/first-turn drift and rehashed freshness drift. The maintained
daemon and ModelPicker tests must also demonstrate the historical alias regression
or an equivalent deliberate semantic mutation, with integrity checks satisfied.
Renderer assertions use the complete emitted session, real identity/catalog
selectors and isolated state/transport: explicit Auggie label or Auto (`Default
model` tooltip), with no warning, fallback action, model mutation or toast.

### Gate rollout

`make check-transfer-selection-contract` validates the complete matrix, golden and
provenance envelope without compiling Rust or installing the frontend. It is a
required row of `make consumer-checks`. Integrity alone does not prove freshness;
the connected Cargo-to-ModelPicker runner supplies that proof.

Publish this contract, its real generated golden and the lightweight checks first.
Standalone component CI then checks out monorepo `main` once per job, recording its
resolved full SHA; the validator and fixtures must come from that same checkout.
A missing validator or golden fails the job. Land the daemon harness, then the
renderer harness, with human merge permission, and let the automated submodule
bump advance both pins. Only after both recorded pins contain the harnesses may
the separate connected-runner/Makefile/reusable-workflow activation land. Never
advance gitlinks manually or treat a missing harness as a passing connected check.

The reusable workflow keeps its own monorepo workflow revision, replaces only the
calling component with its actual PR head (queue commit for `merge_group`), and
initializes the other component at the recorded monorepo pin. Once activated, it
runs the connected proof for both caller directions on every successful checkout,
without a changed-path filter. Local runs at two feature heads are useful evidence,
but do not establish that a not-yet-landed counterpart pin passes.

## Compatibility policy (summary)

The protocol version is a `major.minor` pair: **additive** changes (new methods, new optional params, new presence-detected response fields) bump the minor version; **breaking** changes (removed methods, changed shapes) bump the major version. Additive response fields on an existing method do not change the golden-test-enforced catalog and ship within the current version — clients must detect them by **presence**, not by protocol version. The full policy and the complete version-by-version history live in [versioning.md](./versioning.md).

## How this doc set evolves

- **§ numbers are stable and citation-load-bearing.** intentd code comments, tests, and sibling docs cite "§5.5", "§6.5", etc. Never renumber existing sections; new content gets the next free number.
- **New §5.x subsections** go into the `methods/` file whose domain they belong to (see the map above), or a new `methods/*.md` file for a genuinely new domain — in either case, add the subsection to this README's map (the single canonical § → file map; [05-method-catalog.md](./05-method-catalog.md)'s index just points here).
- **Version-history entries** are appended to the narrative in [versioning.md](./versioning.md), and the current-version headers there and in this README are updated together.
- **New top-level sections** (§11, …) get their own `NN-*.md` file and a row in the map above.
- **Browser-tab action-result contract** (§5.9) is mirrored on three surfaces: the `errorCode` bullet list in [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) (canonical), the cloudlands-fe executor's `errorCode` union (`browser-action-executor.ts` / `embedded-browser-cdp-service.ts`), and intentd's `ws.browser.docs("overview")` text (`bindings/browser_docs/overview.md`). `make docs-check` cross-checks the tokens and the `displayed` field across all three. The docs lead the pin for additions: add the canonical bullet first — the check only warns while a pinned component does not carry the token yet — then land the component PRs; an FE union/alias token absent from the canonical documentation is an error; the intentd overview is checked only for documented tokens it lacks. For a removal the order reverses: drop the token from the components first (the check warns about the now-extra bullet) and remove the bullet after the bump. A rename is an addition: document the new token first (keep the old bullet), rename in the components, then drop the old bullet after the bump.

The shared-host extension is [§5.49 Shared host membership](./methods/shared-host-membership.md): roles, scoped invitations, collaboration credential purpose, personal pairing, authenticated devices and client compatibility. Its behavioral conformance table is the implementation test contract for desktop, daemon and iOS consumers.
