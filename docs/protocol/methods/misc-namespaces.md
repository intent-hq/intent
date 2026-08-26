> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*` · §5.21 `rules.*` · §5.33 `repoConfig.*`.

### 5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*`

| Method | Params | Result |
| --- | --- | --- |
| crossWorkspace.listSiblings | workspaceId (req) | sibling workspaces sharing the same git repository (the workspace's own repo) |
| crossWorkspace.readNote | targetWorkspaceId (req), noteId (req) | note from a sibling workspace |
| crossWorkspace.listNotes | targetWorkspaceId (req) | notes in a sibling workspace |
| primitive.addReference | noteId (req), semanticId (req), description (req), snapshot? | { ok, primitiveId, noteId } |
| primitive.addCli | noteId (req), command (req), description (req), workingDirectory? | { ok, primitiveId, noteId } |
| primitive.addPatch | noteId (req), filePath (req), diff (req), description (req) | { ok, primitiveId, noteId } |
| primitive.addAgentAction | noteId (req), agentId (req), goal (req), description (req) | { ok, primitiveId, noteId } |
| specialist.list | provider? — no workspaceId | { specialists: SpecialistDef[] } (user files override bundled) — each entry may carry the additive `resolvedModel`/`resolvedProvider` preview fields (below); unknown `provider` → -32602 |
| specialist.get | id (req), workspacePath?, provider? | { specialist: SpecialistDef } — resolved view, with the `resolvedModel`/`resolvedProvider` preview fields when applicable; -32602 if not found; unknown `provider` → -32602 |
| specialist.create | id (req), spec (req): SpecialistDef, scope?: "project"\|"user" (default "user") | { specialist: SpecialistDef } |
| specialist.edit | id (req), spec (req): SpecialistDef, scope (req): "project"\|"user" | { specialist: SpecialistDef } |
| specialist.delete | id (req), scope (req): "project"\|"user", workspacePath? | { success: true } — `bundled` definitions are read-only |
| repo.list | — (no workspaceId) | { repos: [...] } |
| repo.remove | path (req) — no workspaceId | { removed: bool } — deletes one known-repo registry entry; `false` when the path was not registered (not an error) |
| repo.warmCache *(v6.10)* | githubUrl (req) — no workspaceId | { started: true, owner, repo } — opportunistic **background** refresh of the daemon-managed repo cache (`.repo-cache/<owner>/<repo>`; [intent-hq/intentd#1105](https://github.com/intent-hq/intentd/pull/1105)): the RPC returns immediately while the fetch (the same `ensure_cached_repo` pipeline `workspace.create` hydrates from — fetch + prune + hard reset + recursive submodule sync, self-healing by re-clone; token resolution matching `workspace.create`) runs as a detached task. Deliberately **silent**: no `git:clone:*` frames and no events are emitted — the outcome is only logged daemon-side. **Global single-flight (never queued):** at most one opportunistic warm runs daemon-wide; a second call while one is in flight is rejected with `-32603` (`"repo cache warm already in flight for <owner>/<repo>"`) carrying machine-readable `error.data = { code: "warm-in-flight", owner, repo }` naming the repo currently being warmed, so clients key off `error.data.code` instead of prose. A missing/non-string `githubUrl`, a URL with no owner/repo pair, or an invalid owner/repo path segment (empty, `.`/`..`, leading `-`, separators) is `-32602` and never claims the single-flight slot, so a malformed URL can never block valid warms. **Never blocks `workspace.create`:** the create path is not gated by the in-flight flag — its cache ensure simply serializes behind an in-flight warm for the same repo on the existing per-repo cache lock |

```json
// → request — `provider` is the optional resolution context for the preview fields
{ "jsonrpc":"2.0","id":50,"method":"specialist.list","params":{ "provider":"codex" } }
// ← response — resolvedModel/resolvedProvider omitted when the provider CLI default applies
{ "jsonrpc":"2.0","id":50,"result":{ "specialists": [
  { "id":"implementor","name":"Implementor","description":"...","source":"bundled",
    "reasoningEffort":"high",
    "resolvedModel":"gpt-5.3-codex","resolvedProvider":"codex" } ] } }
```

**`specialist.*` full CRUD.** Beyond `specialist.list`, the namespace carries
`get` / `create` / `edit` / `delete`. Definitions resolve in **3 tiers** — **project**
(`.intent/specialists/`) overrides **user** (`~/.intent/specialists/`) overrides **bundled** — and
`scope` selects which tier a write targets (`bundled` is read-only). `list`/`get` return the
resolved view; `create`/`edit` take a full `spec` body. Malformed params → `-32602`; deleting a
non-existent or `bundled` definition → `-32602`.

**Base-tier replacement mode (`INTENTD_SPECIALISTS_DIR` / `intentd serve --specialists-dir`).**
The effective `specialists.dir` setting (§5.12 — the `INTENTD_SPECIALISTS_DIR` startup pin, else
a hand-written `[specialists] dir` in config.toml; the `--specialists-dir` serve flag folds into
the env var pre-runtime, so the flag wins over an inherited env value, and an empty value counts
as unset — no replacement) wholesale-**replaces** the base tier: the embedded bundle and the
on-disk bundled `resources/specialists/` directory are both excluded, and the named directory
becomes the sole base (`bundled`, read-only) tier — shipped ids (`implementor`, `spec-writer`, …)
resolve only when present there or in the user/project tiers, which fold on top **unchanged**
(same precedence, inherit-on-omit folds, and file watching as below; the replacement directory
itself is static and unwatched, like the bundled tier it replaces). A missing or empty
replacement directory yields an empty base tier. A startup-pinned replacement holds for the
process lifetime, and session bundle pins never bypass a replacement: session-scoped resolution
never resurrects shipped bundles the operator excluded.

- **SpecialistDef** — `{ id, name, description, codingAgent?, model?, reasoningEffort?,
  roleReminder?, agentType?, role?, icon?, prompt?, hidden?: boolean,
  modelOptions?: [{ model, hint, reasoningEffort? }], teamAgents?: [string],
  aliases?: [string],
  source: "project"|"user"|"bundled", path?, resolvedModel?, resolvedProvider? }`. The optional
  scalars (`codingAgent`, `model`, `reasoningEffort`, `roleReminder`, `agentType`, `role`,
  `icon`) are first-class **string** fields on the wire, not
  frontmatter-only: `list`/`get` emit each one when its resolved value is non-empty, and
  `create`/`edit` accept them in `spec` (they are written to the file's frontmatter). On
  `list`/`get`, `source` is the **winning** tier and `path?` the file it resolved from (omitted
  for `bundled`); on `create`/`edit` the body carries the authored fields and `scope` chooses the
  target tier.
- **`modelTier` is retired** (tolerated-and-ignored, like the retired
  `model.workspaceOverrides` setting in §5.12): a `modelTier` in a `create`/`edit` `spec` or
  in an existing file's frontmatter never errors, but the key is stripped on parse — never
  echoed by `list`/`get`, never written by `create`/`edit` (an existing frontmatter line is
  dropped on the file's next rewrite) — and never participates in model resolution (§5.5).
- **`resolvedModel?` / `resolvedProvider?` (additive preview, [intent-hq/intentd#852](https://github.com/intent-hq/intentd/pull/852))** —
  on `list`/`get` only, the daemon decorates each definition with the model a **no-model
  `agent.create`** for that specialist would actually pin, computed by the same daemon-side
  resolver as agent creation (§5.5 "Creation-time default-model resolution", steps 2–5 — a
  preview has no client-picked model, so step 1 never applies). The optional `provider`
  request param supplies the resolution context: absent/empty defaults to the
  settings-derived default provider (provider of `model.default`, else `providers.active`,
  else the first registered provider — [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922));
  an unknown id is rejected with `-32602` (`unknown provider: <p>`) on both
  methods. **Both fields are omitted** (never `null`) when resolution falls to the provider
  CLI default — clients render "Provider default". A specialist with no model config
  previews the user's `model.providerDefaults` / `model.default` settings chain (the
  quick-action model settings never participate,
  [intent-hq/monorepo#1729](https://github.com/intent-hq/monorepo/issues/1729)). Over the WSS router, `specialist.list` resolves with no
  project tier (no `workspacePath` param, matching its live wire signature); `specialist.get`
  passes its `workspacePath?` through to the resolver.
- **`hidden?`** — optional boolean sourced from `hidden:` in the specialist file's
  frontmatter and **inherited across tiers**: a definition resolves `hidden: true` when any
  lower tier (down to the embedded bundled floor) sets `hidden: true`, unless a higher tier
  **explicitly** sets `hidden: false` — a file that omits the key inherits the lower tiers'
  effective value. Emitted on `list`/`get` only when the resolved value is true (absent ⇒ not
  hidden). On `create`/`edit` an explicit `hidden: true`/`false` is written verbatim and an
  omitted `hidden` writes no key (the resolved value then inherits); explicit `hidden: false`
  in a user/project file is the opt-out that unhides.
  Hidden specialists stay in `list`/`get` results — clients filter them out of
  specialist pickers while keeping them visible on editing surfaces (e.g. Settings → AI
  Behavior). The bundled `chief-of-staff` is flagged hidden.
- **Config scalars (`codingAgent` / `model` / `reasoningEffort` / `agentType` / `role` /
  `icon`)** — the six
  optional config frontmatter scalars follow the same **inherit-on-omit** fold as `hidden`, each key
  independently, across the tiers (embedded bundled floor → bundled dir → user → project): a
  file that omits the key inherits the lower tiers' effective value, and an explicit non-empty
  value in a higher tier overrides it. An explicit **empty string** (`""`) clears the inherited
  value — the string analogue of `hidden: false` — and `create`/`edit` write `key: ""` verbatim
  so the explicit clear round-trips losslessly. A bare `key:` with no value (YAML `null`) is
  parsed as an explicit empty string — the frontmatter parser takes the trimmed text after the
  colon — so it **clears** exactly like `key: ""` (it is neither an omit nor an error).
  `roleReminder` intentionally stays
  **winner-takes-all** (not inherited): it is coupled to the prompt body (itself
  winner-takes-all), so the derive-from-body fallback remains correct when a higher tier
  rewrites the body.
  `reasoningEffort` is the specialist's default reasoning level (§5.5) — stored as-is, no
  vocabulary validation at this seam; it is the frontmatter rung of the delegation
  reasoning-effort resolution below. `role` and `icon` are the picker-metadata scalars
  (below) — they follow this fold verbatim, with `role` additionally enum-validated on write
  and read-normalized.
- **`modelOptions?` (additive, [intent-hq/intentd#900](https://github.com/intent-hq/intentd/pull/900) /
  [intent-hq/intentd#908](https://github.com/intent-hq/intentd/pull/908))** — the ordered list of **delegation
  model options** a specialist's author suggests: `[{ model, hint, reasoningEffort? }]` entries where `model` is
  the model id to pass on delegation — typically an internal compound id (e.g.
  `opencode:kimi-k3`); validation requires only a non-empty string — and `hint` is the author's
  free-text guidance for choosing that option (`""` when none was given). Carried additively on
  `specialist.get`/`list`/`create`/`edit` — emitted when the resolved list is non-empty, omitted
  otherwise (never `null`/`[]` on the wire) — and accepted in `create`/`edit` `spec` bodies. In
  the file it is a frontmatter scalar encoded as a **single-line JSON array**
  (`modelOptions: [{"model":"opencode:kimi-k3","hint":"cheap"}]`) so it fits the line-based
  frontmatter parser and round-trips parse→write→parse losslessly. Resolution follows the same
  3-tier **inherit-on-omit** fold as the config scalars above, with **`[]` as the explicit
  clear** (the array analogue of `key: ""`): an omitted key inherits the lower tiers' effective
  list, an explicit `[]` clears it, and a non-empty list overrides **wholesale** — entries never
  merge across tiers. Reads are **lenient** (files are never rejected): an unparseable scalar or
  a non-array is treated as an omitted key (inherits), and unusable entries — non-objects, or no
  non-empty string `model` — are skipped individually (a non-string `hint` alone does not make
  an entry unusable on read — it is coerced to `""`); only a **literal `[]`** clears — a
  non-empty array whose entries are ALL unusable is treated as omitted (falls through to
  inheritance), so one bad hand-authored entry never silently drops an inherited list. Writes
  are **strict**: `create`/`edit` validate the `spec` value before writing — it must be a JSON
  array of objects, each with a non-empty string `model`; `hint` must be a string when present
  (defaults to `""`), and `reasoningEffort` must be a string when present — and any invalid
  shape → `-32602` with nothing written. An entry's optional `reasoningEffort` is the effort
  level that option implies; it is carried only when non-empty (omitted otherwise) and is
  rendered in the injected docs block as `effort: <level>` inside the option's parenthetical.
  The list adds
  **no resolver step** (§5.5 "Creation-time default-model resolution"): it is advisory — the
  daemon injects each visible specialist's options into the delegating agent's `workspace_api`
  tool description (the `ws.agent.delegate` docs), and the delegating agent passes its pick as
  the explicit `model` param (resolution step 1).
- **Picker metadata (`role?` / `teamAgents?` / `icon?`) (additive,
  [intent-hq/intentd#1477](https://github.com/intent-hq/intentd/pull/1477))** — render-only
  metadata for client specialist pickers; none of the three fields is ever consulted at
  delegation time.
  - **`role?`** — the picker-orchestration enum: `"orchestrator"` (powers the team-mode card)
    or `"internal"` (excluded from the New Workspace modal's **single-agent** picker only);
    absent ⇒ a standard pickable specialist. An inherited config scalar (the fold above:
    omit inherits, explicit `""` clears). Writes are **strict**: `create`/`edit` reject any
    value other than `"orchestrator"`, `"internal"`, or `""` (including non-strings) with
    `-32602`. Reads are **lenient**: an out-of-enum on-disk value is normalized to an
    **omitted** key (which inherits), like an unparseable `teamAgents` — `list`/`get` never
    serve a value the strict write validation would reject when a client echoes the def back.
  - **`icon?`** — names a client-side avatar design. An inherited config scalar (omit
    inherits, explicit `""` clears). Icon names are free-form — no enum — but `create`/`edit`
    reject a non-string value with `-32602`.
  - **`teamAgents?`** — the orchestrator's **advisory team roster**: the specialist ids it
    delegates to, used by clients to render the team-mode card; never enforced at delegation
    time. On the wire it is an array of non-empty (non-whitespace) strings — `create`/`edit`
    reject any other shape with `-32602` — emitted on `list`/`get` only when the resolved
    list is non-empty (never `null`/`[]`). In the file it follows the `modelOptions` pattern:
    a frontmatter scalar encoded as a **single-line JSON array**
    (`teamAgents: ["implementor","verifier"]`), resolving through the same 3-tier
    inherit-on-omit fold with **`[]` as the explicit clear** — an omitted key inherits, a
    non-empty list overrides **wholesale** (entries never merge across tiers). Reads are
    **lenient** (files are never rejected): an unparseable scalar or a non-array is treated
    as an omitted key (inherits), unusable entries (non-strings, empty strings) are skipped
    individually, and only a **literal `[]`** clears — a non-empty array whose entries are
    ALL unusable is treated as omitted, so one bad hand-authored entry never silently drops
    an inherited list.
  - The v1.1 bundled specialists seed the metadata: `spec-writer` carries
    `role: "orchestrator"` + `teamAgents: ["implementor","verifier"]`,
    `implementor`/`verifier` carry `role: "internal"`, and every bundled file names an
    `icon`. The picker/routing-metadata keys (including `aliases`, below) are the only
    frontmatter allowed to diverge between the v1 and v1.1 bundled copies (the goldens pin
    every other key to its v1 value).
- **Specialist aliases (`aliases?`) (additive,
  [intent-hq/intentd#1488](https://github.com/intent-hq/intentd/pull/1488))** — a
  specialist's alternate ids: spawn/delegation callers may address the specialist by any
  listed alias, and resolution maps the alias to the claiming (canonical) definition. On the
  wire and in the file `aliases` follows the `teamAgents` contract exactly: an array of
  non-empty (non-whitespace) strings — `create`/`edit` reject any other shape with `-32602`
  — encoded in frontmatter as a **single-line JSON array** (`aliases: ["coordinator"]`),
  resolving through the same 3-tier inherit-on-omit fold (omit inherits, literal `[]`
  clears, a non-empty list overrides wholesale) with the same lenient reads.
  - **Resolution order** — direct id lookup always runs first; the alias scan only runs on
    a miss, so a **canonical id always beats an alias** with the same spelling. When
    multiple specialists claim the same alias, the **lexicographically smallest canonical
    id** wins (deterministic ascending-id catalog scan). The resolved def is the canonical
    specialist's — its `id` carries the canonical id, never the alias — so `specialist.get`
    on an alias serves the canonical resolved view.
  - **Canonical-id persistence** — `agent.create` (and the seams that funnel through it:
    `agent.delegate`, `agent.wakeOrCreate`) canonicalize an alias **before** any downstream
    resolution runs: display-name derivation, model/effort resolution, and the frozen
    prompt snapshot all see the canonical id, and the session persists it —
    `metadata.specialist` carries `"spec-writer"` when the caller spawned with
    `"coordinator"`, never the alias. Unknown specialist ids keep the existing lenient
    pass-through (unchanged by this feature).
  - The v1.1 bundled `spec-writer` claims `aliases: ["coordinator"]` (the v1 bundle stays
    frozen), so `coordinator` resolves as a specialist id everywhere specialists are
    accepted.
- **Delegation reasoning-effort resolution (additive)** — `agent.delegate` and
  `agent.wakeOrCreate`'s create branch resolve the child's `reasoningEffort` (§5.5) in this
  order: (1) the caller's explicit `reasoningEffort` param — an empty/whitespace-only value is
  an explicit clear and does **not** fall through; (2) the `reasoningEffort` of the chosen
  specialist model option whose `model` matches the resolved model; (3) the specialist's
  `reasoningEffort` frontmatter scalar; (4) the settings `model.defaultReasoningEffort`
  (§5.12), applied only when the session's model itself resolved from the settings chain;
  (5) unset. The resolved level is then **validated
  against cached-catalog evidence**: when the resolved model has a non-empty `effortLevels`
  list in the daemon's cached model catalog (§5.30 — read-only, never a live probe), a level
  outside that list is rejected with `-32602` naming the valid values, before any side effect
  (no child session is created). Matching is case-insensitive and the caller's spelling is
  what persists. With **no evidence** — no resolved model, no cached row, or a row that
  declares no `effortLevels` — the value passes through unvalidated, mirroring the
  bare-model ownership guard's "absence of evidence is not a mismatch" rule (§5.5). The
  settings rung (4) is the one exception to the rejection: a level the resolved model provably
  does not support is **dropped with a daemon warn log** rather than rejected — only
  caller-supplied and specialist-derived levels raise `-32602`.
  `agent.create` walks the **same chain** against its own resolved model (§5.5
  "Creation-time reasoning-effort resolution"): its `reasoningEffort` param is step (1), a
  `specialistId` it names supplies steps (2)–(3), and the settings default is step (4) — the
  delegate / wakeOrCreate seams simply pre-resolve (2)–(3) and hand the result down as the
  param, so the rungs are resolved exactly once.
- The daemon watches the user (`~/.intent/specialists/`) and project
  (`<workspace>/.intent/specialists/`) tiers (using `notify` watchers, the same infrastructure as
  workspace `file:changed` events); when a specialist file is created/modified/deleted under a
  watched tier, the daemon re-resolves the specialist set for the affected workspace(s) (user-tier
  changes affect all open workspaces; project-tier changes are workspace-scoped), compares the
  newly-resolved set against the cached specialist set, and emits `specialists:changed` (§6.5) only
  if the resolved set actually changed (500ms debounce per workspace). The bundled tier (including
  its compile-time embedded floor) is static and unwatched. Clients should re-fetch via
  `specialist.list` on the event to refresh the specialist roster.

```json
// → request — author a project-scoped specialist
{ "jsonrpc":"2.0","id":51,"method":"specialist.create",
  "params":{ "id":"reviewer","scope":"project",
    "spec":{ "id":"reviewer","name":"Reviewer","description":"Reviews diffs",
      "model":"opus4.5","prompt":"You review code changes…" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "specialist":{
  "id":"reviewer","name":"Reviewer","description":"Reviews diffs","model":"opus4.5",
  "source":"project","path":".intent/specialists/reviewer.md" } } }
```

### 5.21 `rules.*`

The backend owns prompt **rules**: the workspace rule files
(`AGENTS.md` / `CLAUDE.md` / `.augment/guidelines.md` / `.augment/rules/*.md`), specialization
rules attached to a specialist, and **user-rule overrides** persisted by the daemon. `list`/`get`
are reads; `update` is the UI-invoked op that edits the **user-override** content. Assembling these
into an agent's system prompt (the **injection pipeline**) runs **internally** as agents start —
there is no wire method for it (§6.8). Every method requires `workspaceId` except where noted.

Within that internal pipeline the **per-agent-type specialization** layer is **not settings-only**:
it resolves through a **3-tier fallback** (highest priority first) — the `endUserRules`
**user-settings override** (edited via `rules.update`) **>** the **workspace file**
`.augment/agent-rules/{agentType}.md` **>** the compiled-in **bundled built-in** template — so a
workspace rule file and a bundled default both back the per-agent-type key when no settings override
exists. The composition (with the agent-id alias map and the utility/background-agent
special-cases) remains internal — no method or shape changes.

| Method | Params | Result |
| --- | --- | --- |
| rules.list | workspaceId? | { rules: RuleSet } — all rule sources for the workspace (or global when omitted) |
| rules.get | workspaceId (req), ruleType (req): user-override key — "base-system-prompt", a per-agent-type specialization key, "workspace", … | { enabled, content, updatedAt } for that one user-override type |
| rules.update | workspaceId (req), ruleType (req): user-override key (as in rules.get), content (req): string, enabled?: boolean | { rules: RuleSet } — upserts the user-override body (+ enabled) and re-reads the set |

**RuleSet** — `{ workspaceId?, rules: RuleEntry[] }` where **RuleEntry** =
`{ ruleType: string, source: string, path?, content, enabled: boolean, updatedAt: number,
editable: boolean }`. `ruleType` is the user-override key the entry is stored under (e.g.
`"base-system-prompt"`, a per-agent-type specialization key, or `"workspace"`); `source` names the
origin (e.g. `"AGENTS.md"`, `".augment/guidelines.md"`, a specialist id, or `"user-override"`);
`path?` is the backing file when one exists; `enabled` toggles whether the override is applied and
`updatedAt` is its last-write epoch-ms; only `user-override` entries are `editable` (the target of
`rules.update`). File-sourced entries are read-only over the wire — edit the files directly.

```json
// → request — set the user-rule override for a workspace
{ "jsonrpc":"2.0","id":60,"method":"rules.update",
  "params":{ "workspaceId":"ws-abc","ruleType":"workspace","enabled":true,
    "content":"Always run the linter before committing." } }
// ← response
{ "jsonrpc":"2.0","id":60,"result":{ "rules":{ "workspaceId":"ws-abc","rules":[
  { "ruleType":"base-system-prompt","source":"user-override","content":"…",
    "enabled":false,"updatedAt":1750000000000,"editable":true },
  { "ruleType":"workspace","source":"user-override",
    "content":"Always run the linter before committing.","enabled":true,
    "updatedAt":1750000000000,"editable":true } ] } } }
```

### 5.33 `repoConfig.*` — per-repository configuration

Four JSON-RPC methods for managing per-repository configuration (`.intent/config.json`) at the
repository root. Each workspace lives in a git worktree; these methods resolve the **repository**
root (via `worktreePath` → `repositoryPath` → `git_ops::worktree_path`) and read/write/check the
shared `.intent/config.json` that sits at that root. The config carries project-wide settings
(branch naming prefix, default setup script, agent instructions, repo scripts) that apply to all
workspaces cloned from the same repo.

All methods require `workspaceId` and map `Error::NotFound` to `-32602 "Workspace not found"`.

| Method | Params | Result |
| --- | --- | --- |
| repoConfig.get | workspaceId (req) | { config: RepoConfig } — reads the config from the repo root; returns default empty config if the file is absent or contains invalid JSON |
| repoConfig.save | workspaceId (req), config (req): RepoConfig | { config: RepoConfig } — writes the config, ensures `.intent/.gitignore`, and returns the persisted record |
| repoConfig.has | workspaceId (req) | { exists: boolean } — checks whether `.intent/config.json` exists at the repo root |
| repoConfig.ensureDir | workspaceId (req) | { ok: true } — creates the `.intent/` directory at the repo root if missing |

**RepoConfig** — all fields are optional; absent fields have no effect on the workspace (fallback to workspace-level or global settings):

- `branchPrefix?: string` — string prefix (e.g. `"feat/"`, `"aw/"`) prepended to auto-generated branch names in `workspace.create` (§5.1)
- `setupScript?: string` — default setup script used when `workspace.create` omits `setupScript`
- `instructions?: string` — repo-level instructions injected into agent prompts
- `runScript?: string` — optional run script (reserved, no consumer in v1)
- `archiveScript?: string` — optional archive script (reserved, no consumer in v1)
- `scripts?: Array<{ id, name, command, mode, cwd?, env?, category?, autoStart? }>` — repo script definitions used to bootstrap workspace scripts when none exist

The `defaultAutoCommit` field mentioned in early drafts was **not implemented** in the initial port.

```json
// → request — read the config
{ "jsonrpc":"2.0","id":90,"method":"repoConfig.get","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":90,"result":{ "config":{ "branchPrefix":"feature/","setupScript":"npm install","instructions":"Use TypeScript strict mode" } } }

// → request — write/update the config
{ "jsonrpc":"2.0","id":91,"method":"repoConfig.save",
  "params":{ "workspaceId":"ws-abc","config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }
// ← response
{ "jsonrpc":"2.0","id":91,"result":{ "config":{ "branchPrefix":"feat/","setupScript":"pnpm install" } } }

// → request — check existence
{ "jsonrpc":"2.0","id":92,"method":"repoConfig.has","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":92,"result":{ "exists":true } }

// → request — ensure the .intent directory exists
{ "jsonrpc":"2.0","id":93,"method":"repoConfig.ensureDir","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":93,"result":{ "ok":true } }
```

