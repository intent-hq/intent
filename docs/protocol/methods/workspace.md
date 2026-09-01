> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.1 `workspace.*` · §5.23 Usage metrics · §5.25 Worktree setup scripts.

### 5.1 `workspace.*`

| Method | Params | Result |
| --- | --- | --- |
| workspace.list | includeArchived?: boolean (default false) | { workspaces: Workspace[] } — triggers background backfill: existing workspaces with a repositoryPath but missing repositoryOwner/Name are enriched from the origin remote URL (same GitHub derivation as workspace.create, non-blocking spawn, deduped per workspace per daemon lifecycle, skips non-GitHub remotes, persists updates, emits workspace:updated with changed fields) |
| workspace.get | workspaceId (req) | { workspace: Workspace } — -32602 if not found |
| workspace.create | workspace fields (incl. repositoryPath?, baseRef?, branch?, remote?, skipIsolation? (canonical; deprecated alias skipWorktree?), githubUrl?, clonePath?, isNewRepo?, progressId? (string — arms the unified provisioning progress stream; see notes), contextLinks? (ContextLink[] — issue/PR context links persisted on the row; a pr-kind link additionally makes the create **PR-aware** — an omitted `branch`/`baseRef` defaults to the PR's head/base branch — see the `contextLinks` and PR-aware create notes below)); optional initialAgent: { prompt, name?, model?, specialist?, provider?, behaviorPrompt?, agentType?, imageBlocks? *(within v7.4, monorepo#3338: entries may carry an attachment-registry `attachmentId` reference instead of inline `data`, under the same exactly-one-of validation + registry check and daemon-side prompt-assembly resolution as `agent.sendMessage` — §5.5; validated at the very top of the op, before any state change, so a bad reference rejects `-32602` without leaving a partially created workspace behind)*, fileBlocks? *(v6.12; same per-entry exactly-one-of-`data`/`attachmentId` validation as `agent.sendMessage`, `-32602` before any side effect — §5.5)*, metadata? } — no `agentId`: agent IDs are server-assigned, and a request carrying `initialAgent.agentId` is rejected with `-32602` (see notes) | { workspace: Workspace, initialAgent?: AgentLite } — the created agent's server-minted id is `initialAgent.id`; daemon-owned orchestration inside one idempotent op (see notes: clone → checkout (worktree or CoW) → spec seed → initial agent). |
| workspace.update | workspaceId (req) + fields to change — the skip toggle uses the same wire names as create: skipIsolation? (canonical; deprecated alias skipWorktree?, either set ⇒ same behavior); the `workspace:updated { changes }` delta serializes it under the canonical skipIsolation name; `statusImageAssetId?: string \| null` is clearable (missing = untouched, `null` = clear, string = set — see the `statusImageAssetId` notes below) | { workspace: Workspace } |
| workspace.delete | workspaceId (req), undoDelayMs? *(v6.7)* | { success: true } — fast-ack: returns immediately after deleting the database row and emitting `workspace:deleted`, while filesystem cleanup runs in a background task — only the git-metadata phase (worktree-registration prune + rename of the checkout to a trash path + guarded branch delete; a CoW or `direct` checkout — a standalone clone with no registration in the source repo and a branch living only inside the clone — gets just the rename, no prune and no source-repo branch delete, and **only when it sits in the daemon-owned `<root>/<workspaceId>/<repo-slug>` layout**: a standalone checkout outside that layout — the `isNewRepo` direct shape, where the checkout IS the user's chosen repository folder (§5.1) — is left untouched, deletion removes only the workspace row) holds the per-repository lock; the recursive `remove_dir_all` of the renamed trash directory runs afterwards outside the lock. **Delete grace window (v6.7, [intent-hq/intentd#1096](https://github.com/intent-hq/intentd/pull/1096)):** `undoDelayMs > 0` (non-negative integer; a non-integer value is `-32602`; values above the 60 000 ms cap are silently clamped, never rejected — `deleteAt` reflects the clamped value) schedules an **in-memory** pending deletion instead of committing — returns `{ success: true, scheduled: true, deleteAt }` (ISO commit deadline), emits `workspace:delete-scheduled { workspaceId, deleteAt }` (§6.5), and serves `pendingDeleteAt` on the row until the deadline commits the real delete (which then runs the full teardown above) or `workspace.cancelDelete` cancels it. Absent, `null`, or `0` keeps the immediate-delete behavior byte-identical. Pending deletions are never persisted (a daemon restart drops them; the workspace survives); re-scheduling is idempotent under the registry lock (returns the existing deadline, no second timer); a committed workspace delete supersedes pending agent deletes inside the workspace |
| workspace.cancelDelete *(v6.7)* | workspaceId (req) | { cancelled: boolean } — cancels a pending (grace-window) deletion scheduled by `workspace.delete` with `undoDelayMs`. `true` clears the pending deletion, emits `workspace:delete-cancelled { workspaceId }` (§6.5), and drops `pendingDeleteAt` from the row; `false` is the race-safe non-error when no deletion is pending (never scheduled, already cancelled, or already committed) |
| workspace.archive | workspaceId (req) | { workspace: Workspace } — returns the refreshed record with `archived: true` / `status: "Archived"` / `archivedAt` set, so callers do not need to follow up with `workspace.get`. Emits `workspace:updated` with the full applied delta `changes: { archived: true, status: "Archived", archivedAt: <ts> }` where `<ts>` is the same ISO timestamp persisted on the row (§6.5). **Archive stops active work** ([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896); PR monitors: [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)): in-flight agent turns are gracefully interrupted, ACTIVE background hooks and ACTIVE PR monitors (§5.42) are cancelled, and queued messages/wakes park while the workspace stays archived — see the archive active-work teardown block below. -32602 if not found. |
| workspace.unarchive | workspaceId (req) | { workspace: Workspace } — mirror of `workspace.archive`; returns the refreshed record with `archived: false` / `status: "Active"` and `archivedAt` cleared. Emits `workspace:updated` with `changes: { archived: false, status: "Active", archivedAt: null }` — an explicit JSON `null` so clients clear the field (§6.5). Re-kicks the queue drains parked by the archived gates so parked messages deliver without a manual kick; cancelled hooks and PR monitors are NOT resurrected (see the archive active-work teardown block below). The same delta shape is also emitted by the turn-start **auto-unarchive** (see the auto-unarchive block below), which additionally stamps the additive `autoUnarchive` field into `changes` — the stamp is never present on this manual path (or `workspace.restore`). -32602 if not found. |
| workspace.dismissAttention | workspaceId (req) | { workspace: Workspace } — clears `attention` to `"none"`; -32602 if not found |
| workspace.markSeen | workspaceId (req) | { workspace: Workspace } — marks the workspace seen: advances **every top-level (no parent, non-background, non-deleted) session's per-conversation seen marker** to its `lastMessageId` through the `agent.markSeen` op (§5.5; same monotonic CAS, each advanced session emits its own `agent:updated` marker event; background/child sessions are untouched), which settles the **derived workspace `unread`** (see the `attention` bullet below) to `none` and emits ONE `workspace:attention-changed { none }` on the transition; also clears the stored legacy flag (guarded on `unread` — a persistent `review_required` survives; the clear re-checks the derivation atomically inside the guarded write, so an assistant message landing mid-call is never retired). **Marker advances are the call's contract, so failures propagate**: a failed pending-list read or per-session marker write is the call's error — the caller never sees success while a session stays unread; the one tolerated per-session failure is a racing `agent.delete` (a deleted session no longer feeds the derivation, so it is skipped). Idempotent: a re-call with nothing unseen writes and emits nothing. `updated_at` stays untouched (looking is not "activity", monorepo#1466) |
| workspace.getContext | workspaceId (req) | { items: ContextItem[] } — persisted chat-context attachments for the workspace; empty array before the first save. -32602 if the workspace is absent. |
| workspace.updateContext | workspaceId (req), items (req): ContextItem[] | { items: ContextItem[] } — atomic full-list replacement (matches the FE's `hydrate/add/remove/update` collapsed to a single authoritative-list write). Order is preserved. Emits `workspace:context-changed` with the persisted list. -32602 on missing workspace, malformed `items`, or an item with an empty `id`. |
| workspace.getAutoCommit *(v2.7)* | workspaceId (req) | { autoCommit: { enabled: boolean, source: "workspace" \| "global" } } — the effective per-workspace auto-commit state: the persisted workspace override when set (`source: "workspace"`), else the current global `git.autoCommit` setting (`source: "global"` — pre-migration rows and the virtual Chief workspace). -32602 if the workspace is absent. |
| workspace.setAutoCommit *(v2.7)* | workspaceId (req), enabled (req): boolean | { autoCommit: { enabled: boolean, source: "workspace" } } — echoes the persisted override (`enabled` is the boolean just written; `source` is always `"workspace"`), persists it across daemon restarts, and emits `workspace:updated` with `changes: { autoCommitEnabled: boolean }` (§6.5). -32602 on missing workspace, missing/non-boolean `enabled`, or the virtual Chief workspace. |
| workspace.diskUsage *(v4.2)* | workspaceId (req) | { diskUsage?: { bytes, fileCount, computedAt, breakdown }, refreshing: boolean } — on-demand poll of the workspace's cached whole-directory disk footprint (see the workspace-disk-usage block below for the payload shape and cache semantics). `diskUsage` is **omitted** (absent, never `null`) until the first walk completes and for non-qualifying rows; `refreshing: true` means a background walk is in flight (stale or first-ever poll — poll again shortly). Non-qualifying workspaces — remote, skip-isolation, the virtual Chief workspace, or a never-provisioned directory — answer `{ refreshing: false }` with the field omitted, without arming a walk. -32602 if the workspace is absent. |
| workspace.transfer.plan *(v6.6)* | workspaceId (req) | { plan: TransferPlan } — read-only transfer preview for the Transfer/Download feature ([intent-hq/intentd#1092](https://github.com/intent-hq/intentd/pull/1092)): `plan.manifest` is the versioned export manifest — `{ formatVersion, creatingIntentdVersion, workspaceId, createdAt, tables: [{ name, rowCount, approxBytes }], assets: [{ id, sizeBytes }], git: { hasRepository, branch?, dirtyFiles, sandboxBranches } }`, where `formatVersion` is `TRANSFER_FORMAT_VERSION` (currently 1; the import side refuses archives whose format version it does not understand), `creatingIntentdVersion` is the exact daemon version (`CARGO_PKG_VERSION`; import gates on exact match), `tables` covers every workspace-scoped table with the `event` table deliberately excluded (event history stays on the source; `approxBytes` sums column byte lengths cast to BLOB — a serialized-payload estimate, not on-disk size), and `git.branch?` is omitted when unresolvable — plus the additive `attachments: [{ id, fileName, sizeBytes, exists }]` manifest list (attachment-transfer support): one entry per `attachments`-registry row (§5.9), probing the stored file in the workspace's canonical `.intent/attachments/` store at plan time — `exists: false` (with `sizeBytes: 0`) marks a row whose file was already deleted (deleted-is-deleted is a first-class state: the row transfers, no file rides, and a missing file never fails a plan or an export) — plus the size estimate `totalSizeBytes = dbRowBytes + assetBytes + attachmentBytes + estimatedGitBundleBytes` (bundle estimated via `git rev-list --disk-usage`; each addend also served — `attachmentBytes` sums only the attachment files the archive will actually carry) and the non-blocking pre-flight `warnings: [{ code, message }]` (`code` machine-readable and stable — e.g. agents running, uncommitted changes, unmerged sandboxes). No side effects; the virtual Chief workspace is rejected. -32602 if the workspace is absent |
| workspace.import.begin *(v6.9)* | manifest (req, object), archiveSizeBytes (req, u64), archiveSha256 (req) — no workspaceId (the target id lives inside the manifest) | { importId, maxChunkBytes } — opens a staged workspace import of a transfer zip archive ([intent-hq/intentd#1101](https://github.com/intent-hq/intentd/pull/1101); the target-side counterpart of `workspace.transfer.plan`). Validates the manifest header BEFORE any bytes are staged: `formatVersion` must be understood, `creatingIntentdVersion` must match this daemon's `CARGO_PKG_VERSION` **exactly** (the error names both versions), the virtual Chief workspace is rejected, and the manifest's workspace id must not collide with an existing row OR another pending import. Staging lives under `<workspaces_root>/.import-staging/<importId>/`; `maxChunkBytes` is the per-chunk decoded cap (16 MiB, under the 40 MiB frame cap) |
| workspace.import.chunk *(v6.9)* | importId (req), seq (req, u64), data (req, base64) | { importId, seq, receivedBytes } — stages one seq-numbered slice of the archive as a per-seq file. Chunks may arrive in any order; retrying a seq is **idempotent** (per-seq overwrite, no double-count); the declared `archiveSizeBytes` guards against over-staging |
| workspace.import.commit *(v6.9)* | importId (req) | { workspace, importedRows, interruptedAgents, rehydrated } — reassembles the staged chunks → verifies the SHA-256 against `begin`'s `archiveSha256` → unzips (zip-slip-safe extract) → checks the embedded manifest equals the `begin` manifest → applies row transforms (path rewrite against the target `workspaces_root`, agent sessions forced to stopped with `interrupted_agent` rows for in-flight agents, `event` rows skipped) → git materialization → attachment materialization (each `attachments/<attachmentId>` archive entry lands at the `stored_path` its registry row records, resolved against the materialized checkout with the within-workspace containment guard — an escaping `stored_path` fails the commit — dropping the ignore-all `.gitignore` marker in the store dir; a registry row with no archive entry is the deleted-is-deleted state and imports as a row without a file; a later failure unwinds every placed file) → single-transaction row insert + asset placement → boot-style rehydration (hooks, event subscriptions, PR monitors). **Atomic:** nothing is visible in `workspace.list` until commit succeeds |
| workspace.import.abort *(v6.9)* | importId (req) | { importId, aborted } — deletes the staged session and its staging directory; idempotent (`aborted: false` when the session no longer exists, not an error) |
| workspace.export.start *(v6.11)* | workspaceId (req) | { exportId, maxChunkBytes } — opens the source-side export of the FE-mediated workspace transfer ([intent-hq/intentd#1118](https://github.com/intent-hq/intentd/pull/1118); the source counterpart of the v6.9 `workspace.import.*` surface) and kicks off the background archive build — the result returns immediately, and progress/outcome travel on the `workspace:transfer:*` events (§6.5). Build stages (each emits `workspace:transfer:progress` before it runs): `stopping-agents` — in-flight agents are captured as pending `interrupted_agent` rows BEFORE the stop (they ride the archive as the target's resumption offers, and equally cover the source if the export is aborted; durable queues untouched) — then `exporting-rows` — the manifest (built by the `workspace.transfer.plan` op; the copy embedded in the zip byte-matches the one the `:ready` event carries) plus the row export — then `bundling-git` (skipped when the workspace has no repository; a dirty worktree and live sandboxes are snapshotted as WIP commits that stay in place while the archive is served and are unwound when the export settles) — then `writing-archive` (zip sealed + SHA-256 hashed). Archive layout (shared with the import side): `manifest.json`, `rows/<table>.jsonl` (only tables with rows), `assets/<assetId>`, `attachments/<attachmentId>` (the registered attachment files that still exist in the git-ignored `.intent/attachments/` store — they never ride the git bundle, so the archive carries them explicitly; a registry row whose file was deleted rides the rows payload with no file entry, and a file that vanishes between plan and write is skipped with a warning, never an export failure), and — when the workspace has a repository — `git/repo.bundle` + `git/refs.json`. Staging lives under `<workspaces_root>/.export-staging/<exportId>/`; sessions are **in-memory only** (a daemon restart drops them; the boot/lazy sweep clears orphaned staging dirs). `maxChunkBytes` is the per-chunk pre-base64 cap (16 MiB, matching the import side so the FE can pipe `read` chunks straight into `workspace.import.chunk`; the encoded frame stays under the 40 MiB cap, §1.3). -32602 on the virtual Chief workspace, an unknown workspaceId, or a second concurrent export of the same workspace (the error names the in-flight exportId) |
| workspace.export.read *(v6.11)* | exportId (req), seq (req, u64) — no workspaceId (the export session, addressed by `exportId`, already binds the workspace) | { exportId, seq, totalChunks, data } — serves one seq-numbered chunk of the sealed archive as base64. **Idempotent**: any seq may be re-requested in any order (same seq, same bytes). -32602 while the session is still building (wait for `workspace:transfer:ready`), on an out-of-range seq (the error names the chunk count), or on an unknown exportId |
| workspace.export.finalize *(v6.11)* | exportId (req), archiveSource? (bool, default false), finalStatusMessage? (string) — no workspaceId (export-session-scoped, like `workspace.export.read`) | { exportId, finalized: true, workspace } — settles the source after a successful relay: applies the optional final status message, archives the workspace when `archiveSource: true` (otherwise it stays active), then unwinds the WIP snapshot commits and deletes staging. The workspace mutations run BEFORE the session is retired, so a failed mutation leaves the export intact and finalize can be retried. Only valid on a ready session — -32602 while still building or on an unknown exportId |
| workspace.export.abort *(v6.11)* | exportId (req) — no workspaceId (export-session-scoped, like `workspace.export.read`) | { exportId, aborted } — cancels an export: a still-building session is flagged and the build task cleans up when it next checks between stages (quiet — no `workspace:transfer:failed`); a ready session is cleaned up inline (WIP snapshots unwound, staging deleted). **Idempotent** — an unknown exportId returns `{ aborted: false }`, not an error. The workspace stays usable; agents stay stopped (the user restarts them) |

**Agent-authored sibling workspace proposals (MCP-only).** A foreground top-level
agent can call `ws.workspace.proposeSibling({ title, initialPrompt, specialist?,
baseRef? })`. `title` and `initialPrompt` are required non-empty strings. Unknown fields,
including repository-selection fields, are rejected; repository identity and path come
from the caller workspace. An omitted `baseRef` uses the repository default. A named ref
must exist; an unresolved ref is warned before Apply and fails through the existing
`workspace.create` structured error without fallback.

The result is the existing `workspace-create` proposal resource with
`preview.workspaceCreate.mode: "sibling"`. The title, prompt, specialist, and base ref
remain editable; repository metadata is locked. The proposal stores one idempotency key,
which its Apply and Retry actions reuse, so one proposal creates at most one workspace.
Dismiss has no create side effect. Delegated and background agents do not receive this
binding, and raw dispatch rejects it. Agents with a parent report the opportunity upward;
parentless background agents remain blocked and have no parent-report path. This is an MCP
binding over the existing `workspace.create` flow, not a JSON-RPC method, and does not
change Chief of Staff `ws.app.workspaces.create` behavior.

```json
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "workspace.list", "params": { "includeArchived": false } }
// ← response
{ "jsonrpc": "2.0", "id": 1, "result": { "workspaces": [ { "id": "ws-abc", "title": "My Workspace" } ] } }
```

**Branch naming (`workspace.create`).** An explicit `branch` is used untouched. On a
PR-aware create (a pr-kind `contextLinks` entry — see the PR-aware create notes below),
an omitted `branch` defaults to the PR's **head branch**, which then behaves exactly like
an explicit branch: no slug generation, no prefix, no uniquification — the point is to
check out the EXISTING branch. Otherwise
the daemon auto-names the branch with a friendly `word-word` slug (TS parity): extracted
from `initialAgent.prompt` via local keyword heuristics when possible (`generateLocalSlug`
— e.g. "fix the auth flow" → `auth-fix`), else a random adjective-animal pair
(`generateWorkspaceSlug` — e.g. `amber-forest`). The `workspace.branchPrefix` setting
(§5.12), when set, is prepended (e.g. `aw/auth-fix`). When `repositoryPath` is a local git
repository the name is uniquified against existing local and remote-tracking branches by
appending `-2`, `-3`, … until free. The branch is never the raw workspace UUID.

**Workspace id (`workspace.create`).** The daemon derives the workspace id as a friendly
`word-word` slug (extracted from `initialAgent.prompt` when possible, else a random
adjective-animal pair), uniquified with a `-2`, `-3`, … suffix whenever the candidate id was
**ever** used — a live workspace, a previously deleted workspace (persisted delete
tombstone), or a leftover `<root>/<id>` directory on disk. Ids are therefore never recycled
across delete/recreate (reuse would collide the old workspace's agent streams and file
paths with the new one's); callers must use the id returned in the `workspace.create`
result rather than predicting it.

**Worktree provisioning (`workspace.create`).** When `repositoryPath` points at a local git
repository, the daemon provisions a linked worktree before persisting the row (TS
`createGitWorktree` parity): the worktree lives at
`<root>/<workspaceId>/<repo-slug>` — `root` is `$INTENTD_WORKSPACES_DIR`, else
`~/intent/workspaces` (the FE's `WorkspaceConfig.WORKSPACES_BASE`); the slug is the
slugified `repositoryName` (basename fallback) — checked out on the workspace `branch`
(auto-named as above when not supplied), created from `baseRef` resolved as
`refs/remotes/<remote>/<baseRef>` (remote defaults to `origin`) → `refs/heads/<baseRef>` →
any rev-parsable spec, else `HEAD`. No network fetch is performed — the base resolves from
local state. A `branch` that already exists locally is reused rather than recreated; a
branch that exists **only as a remote-tracking ref** (`refs/remotes/<remote>/<branch>` —
e.g. a PR head branch never checked out locally) is **materialized** as a local branch at
the remote tip with best-effort upstream tracking (a failure to record tracking never
fails provisioning), instead of a fresh branch at the base commit, so the checkout
carries the branch's existing commits. Materialization applies to **every**
explicit-branch create naming a remote-only ref — not just PR-aware ones — and across
all three checkout modes (worktree / CoW / direct). The returned `Workspace` carries
`worktreePath`, `baseCommitSha` (the
checked-out tip; for a PR-derived branch, the merge-base boundary — see the PR-aware
create notes below), and `checkoutMode` (`"worktree"` here; see the CoW and cache-hydration
notes below). An
unresolvable `baseRef` on a valid repo fails with `-32602` carrying the
`base-ref-unresolvable` `error.data` payload (§9).
Provisioning is skipped — prior row-only behavior — for `skipIsolation: true`
(canonical name; `skipWorktree` is accepted as a deprecated alias, either set ⇒ direct
mode), `isRemote: true`, a caller-supplied `worktreePath`, a missing `repositoryPath`, or
a `repositoryPath` that is not a local git repository (unless `isNewRepo: true`
initializes it first — see new-repository initialization below). `workspace.update` follows the
same rename: `skipIsolation` is the canonical param (deprecated alias `skipWorktree`),
and the persisted column keeps its historical `skip_worktree` name
(`Workspace.skipWorktree`) — the rename is wire-level only, no migration.

**CoW checkout provisioning (`workspace.create`, new in intentd).** The
`workspace.cowIsolation` setting (§5.12, boolean, default `false`) selects the checkout
mode, persisted on the returned `Workspace` as `checkoutMode`
(`"worktree" | "cow" | "direct"`; omitted whenever provisioning was skipped per the
conditions above — see the cache-hydration and new-repository notes below for the
`"direct"` producers). Off ⇒ the
linked-worktree behavior above (`checkoutMode: "worktree"`). On ⇒ the daemon first
probes CoW support from the repository directory to `<root>/<workspaceId>`: when
supported, the checkout is a **standalone copy-on-write clone** of the whole repository
directory (OS reflink primitives — macOS `clonefile(2)` whole-tree fast path with best-effort
walk fallback, Linux `ioctl(FICLONE)`) instead of a linked worktree, carrying deps/build artifacts
(`node_modules`, `target`, …) into the checkout for free; inside the clone the workspace
`branch` is created + checked out from the same `baseRef` resolution order as above,
tracked files are hard-reset to that base, untracked files are preserved, and the row
persists `checkoutMode: "cow"`. When the probe reports Unsupported (or errors) — e.g.
the repository lives on a different volume than the workspaces root, since reflinks
cannot cross filesystems — the create **falls back to the linked-worktree path**
(`checkoutMode: "worktree"`, normal worktree provisioning) with a logged warning
instead of failing: `workspace.cowIsolation` is a preference, not a guarantee. Because
a CoW checkout is a standalone clone, `workspace.delete`'s git-metadata phase skips the
worktree-registration prune and the source-repo branch-delete guard (the workspace
branch lives only inside the clone); the checkout is still renamed to a trash path and
removed in the background as usual.

**Duplication (`workspace.duplicate`).** Duplicating a local workspace off a local git
repository provisions a fresh checkout for the copy at `<root>/<newId>/<repo-slug>` on a
branch named for the new id (uniquified against the source repo's local and
remote-tracking branches). The decision depends on whether the **source** checkout is
standalone:

- **Standalone source** (the source's own `checkoutMode` is `"cow"` or `"direct"`, which
  includes every cache-hydrated workspace and an `isNewRepo` `direct` workspace): the
  duplicate is **always standalone too, and never a linked worktree**. The clone source
  is the source's **own checkout** (`worktreePath`, or `repositoryPath` when the
  repository itself is the checkout), not the source's `repositoryPath`. A CoW probe from
  that checkout to `<root>/<newId>` decides the mode: supported ⇒ CoW clone
  (`checkoutMode: "cow"`); Unsupported ⇒ a **plain local `git clone`** of the source
  checkout (`checkoutMode: "direct"`), and the same local-clone fallback is taken — with a
  logged warning — on a probe error or when a CoW clone still reports Unsupported despite a
  passing probe. A source checkout whose `.git` is a gitfile skips the probe and goes
  straight to the local clone (also warned). `workspace.cowIsolation`
  is **ignored** for standalone sources (parity with cache-hydrated create). Like a
  hydrated create, the checkout *is* the repository: the duplicate persists
  `repositoryPath` = its **own** checkout path, so nothing in the row references the source
  workspace's directory. The `direct` local-clone path additionally **resolves `origin`**
  (a CoW clone is a byte copy and keeps the source's `.git/config` verbatim): a network URL
  and an absolute local path carry over as-is, a relative local path is absolutized against
  the source repository so it still names the same upstream, and the remote is **removed**
  when the source has no `origin` or when `origin` resolves to the source checkout itself.
  The local-clone fallback carries **committed state only** —
  uncommitted/untracked work in the source is not copied. Rationale
  ([intent-hq/monorepo#1560](https://github.com/intent-hq/monorepo/issues/1560)): a linked
  worktree rooted in a sibling workspace's checkout is orphaned when that workspace is
  deleted (the checkout dir is detached), and deleting the duplicate would mutate the
  source's checkout.
- **Shared-checkout source** (no `checkoutMode` — a worktree-mode or shared workspace):
  the **same decision matrix as `workspace.create`** applies against the source's
  `repositoryPath` — `workspace.cowIsolation` off ⇒ linked worktree
  (`checkoutMode: "worktree"`); on ⇒ CoW probe from the repository directory to
  `<root>/<newId>` — supported ⇒ standalone CoW clone (`checkoutMode: "cow"`),
  Unsupported/probe error ⇒ fall back to a linked worktree with a logged warning.

Provisioning is skipped for remote / skip-isolation sources and when the resolved source
directory is not a local git repository. An ordinary provisioning failure is logged and
swallowed (FE parity — "continue without worktree"): the row persists without
`worktreePath`/`checkoutMode`. For a standalone source the inherited `repositoryPath` is
also **cleared** in that case, so a checkout-less duplicate never points at the source
workspace's directory.

**`checkoutMode` is immutable.** `workspace.cowIsolation` is consulted **only** at
provisioning time (`workspace.create` / `workspace.duplicate`); the resulting
`checkoutMode` is persisted on the row and never changes for the life of the workspace.
Toggling the setting later affects only subsequently created workspaces — existing
checkouts are not converted.

**Cache-hydrated creation (`workspace.create`, new in intentd —
[intent-hq/intentd#944](https://github.com/intent-hq/intentd/pull/944)).** When
`githubUrl` is set, `repositoryPath` is not already a local git repository, and the
caller supplies **no** `clonePath`, the daemon provisions the workspace from a hidden,
daemon-managed **repo cache** instead of cloning into `<workspaces_root>/clones/`. The
cache lives at `<workspaces_root>/.repo-cache/<owner>/<repo>` (dot-prefixed so it stays
invisible to users and to recent-repo derivation) and holds a read-only clone with the
remote's default branch checked out. Flow:

1. **Ensure the cache** — the only network-bound phase. Cache miss ⇒ full clone; cache
   hit ⇒ `git fetch --prune origin`, `git remote set-head origin --auto` (a fetch alone
   never re-resolves `origin/HEAD`, so an upstream default-branch change is picked up
   here), a hard reset to that remote default branch, and `git clean -fdx` (a hard reset
   alone leaves untracked pollution — e.g. from a process killed mid-checkout — that
   would be byte-copied into every hydrated checkout).
   **Refresh never fails the flow:** any anomaly (diverged history, corrupt object store,
   an interrupted prior clone, a vanished `origin/HEAD`, or an `origin` that no longer
   matches the requested URL) deletes the cache directory and re-clones from scratch.
   Only a failed *clone* surfaces as an error. Concurrent creates for the same repo
   serialize on a per-repo lock; different repos never contend.
2. **Provision a standalone checkout** at `<root>/<workspaceId>/<repo-slug>` — the same
   location a linked worktree would use, but **never a linked worktree against the
   cache** (a cache refresh hard-resets/re-clones the cache directory, which would
   corrupt linked worktrees). A CoW probe from the cache into `<root>/<workspaceId>`
   decides the mode: supported ⇒ a copy-on-write clone of the cache
   (`checkoutMode: "cow"`, same reflink primitives as the CoW note above); unsupported,
   probe error, or a CoW clone that still reports Unsupported ⇒ a plain local
   `git clone <cache-path>` (`checkoutMode: "direct"`). Provisioning runs under the
   per-repo cache lock so a concurrent create's refresh cannot mutate the cache
   mid-copy.
3. **Detach from the cache.** `origin` is retargeted at the real GitHub URL (the checkout
   never references the cache, so deleting the cache is always safe), the cache's
   remote-tracking refs are copied in so any `baseRef` resolves, and the workspace
   `branch` is created + checked out with the same `baseRef` resolution order as the
   worktree path above.

The workspace's `repositoryPath` **is** the checkout (`worktreePath` carries the same
path), `baseCommitSha` is the checked-out tip (for a PR-derived branch, the merge-base
boundary — see the PR-aware create notes below), and `repositoryOwner`/`repositoryName`
derive from the URL when the caller left them blank. Progress streams through the same
`git:clone:progress` / `git:clone:done` frame shapes as a network clone (scoped to the
newly minted `workspaceId`). Without a `progressId` the legacy framing applies: **synthetic
milestones** rather than parsed git percentages — `starting` at 0% before the cache
ensure, `checkout` at 90% once the cache is ready, then the terminal `git:clone:done` —
the local checkout provisioning that follows emits nothing, matching the legacy flow
where worktree provisioning runs after `git:clone:done`. With a `progressId` the frames
route through the unified provisioning progress reporter instead (see the block below):
the cache ensure **streams real progress** — a cache miss's full clone parses git's
stderr phases (submodule-aware), a cache hit's refresh emits per-step `cache` /
`submodules` milestones (fetch, branch reset, submodule sync/update, clean) — followed
by the provisioning-tail milestones (`cow-copy` / `checkout`, streamed `submodules`
population on the `direct` arm, `finalizing`), with the terminal `git:clone:done` owned
by the create wrapper. A cache failure fails the whole create pre-insert with the
same clone-failure taxonomy as below (no row persisted, no `workspace:created`).
Hydration is skipped — the legacy network clone below applies unchanged — for an
explicit non-empty `clonePath`, a URL carrying no `owner/repo` pair, and creates that
provision no checkout (`isRemote: true`, `skipIsolation`/`skipWorktree`, or a
caller-supplied `worktreePath`).

**Clone orchestration (`workspace.create`).** When `githubUrl` is set,
`repositoryPath` is not already a local git repository, and cache hydration above does
not apply, the daemon clones the URL
before branch naming and worktree provisioning, reusing the streaming `git.clone`
pipeline (§5.6) — with `--recurse-submodules` (new in intentd,
[intent-hq/intentd#1069](https://github.com/intent-hq/intentd/pull/1069)), so the
checkout lands with populated submodule work trees like the repo-cache path, and the
progress stream can carry an aggregated `submodules` phase ("Cloning submodules (N/M)")
after the superproject phases — the create-orchestrated clone is the only caller that
recurses; the standalone `git.clone` RPC (§5.6) is unchanged. The clone target is the
caller-supplied `clonePath` when non-empty,
else `<workspaces_root>/clones/<derived-repo-name>` (basename of the URL with a trailing
`.git` stripped, matching `git clone` defaults); a pre-existing target fails the create
with `-32602` and `error.data = { code: "destination-exists-non-empty", detail }`
(clone failure taxonomy, §9). A leading `~` / `~/` in the caller-supplied `clonePath` or
`repositoryPath` expands to the daemon user's home directory before the existing-repo
check, clone targeting, and persistence (`~user` forms pass through unchanged) — git
would otherwise treat the tilde as a literal `./~` directory, which fails on the
packaged sidecar's read-only cwd. The persisted `repositoryPath` is always the
post-expansion value (identical to the input whenever expansion does not apply).
Expansion is best-effort: it is `/`-separated only, and when the daemon cannot resolve
a home directory from its environment it is a no-op — the verbatim tilde path is then
used as-is, so the clone fails as before (and per the clone-failure rule below, no row
is persisted). Progress streams as `git:clone:progress` frames and terminates in exactly
one `git:clone:done` — both scoped to the newly minted `workspaceId`; with a
`progressId` the frames route through the unified provisioning progress reporter below
(normalized percent, `data.progressId` echo, terminal done owned by the create wrapper) —
and a `git clone`
failure fails the whole `workspace.create` (no row persisted, no `workspace:created`)
with a classified error from the clone failure taxonomy (§9): the numeric code is
`-32602` for user-fixable inputs (`path-invalid`, `destination-exists-non-empty`) or
`-32603` otherwise (`auth-required`, `network`, `clone-failed`), `error.message` is
`workspace.create clone failed (<category>): <detail>`, and
`error.data = { code: "<category>", detail }` where `detail` is the tail of git's
stderr with any `user[:pass]@` credential fragments redacted — clients render the
detail instead of a bare "Internal error" and key behavior off `error.data.code`.
On success the checkout becomes the workspace's `repositoryPath` and, when the URL
carries an `owner/name` pair (`github.com/OWNER/REPO(.git)?` on https or ssh), the
daemon best-effort derives `repositoryOwner`/`repositoryName` from it when the caller
left them blank. Independently of cloning, any create that ends up with a local
`repositoryPath` but no caller-supplied `repositoryOwner`/`repositoryName` best-effort
derives them from the local repository's `origin` remote URL (local git config read only,
no network) when the remote is a GitHub URL (https or ssh forms, strict `github.com` host
check); non-GitHub or missing remotes leave `repositoryOwner` unset. Caller-supplied
values always win; `repositoryName` persists the path basename as a last resort when blank.

**Unified provisioning progress (`workspace.create { progressId }`, new in intentd —
[intent-hq/intentd#1062](https://github.com/intent-hq/intentd/pull/1062),
[#1069](https://github.com/intent-hq/intentd/pull/1069)).** The optional `progressId`
parameter (string; trimmed, empty-after-trim treated as absent) is a **client-minted
correlation id** that arms a per-create progress reporter. Every `git:clone:progress` /
`git:clone:done` frame the create emits then echoes the id verbatim as
`data.progressId` (§6.5), letting the client correlate the asynchronous frames to its
own request without knowing the server-minted `requestId` or the not-yet-known
`workspaceId`. Absent a `progressId` the reporter is never constructed and every event
path behaves exactly as before (the field is additive; rollback-safe). With a reporter
armed:

- **One normalized 0–100 scale.** Percent is normalized across the whole provisioning
  pipeline into a single **non-decreasing** series: the network/cache segment maps into
  0–85 (superproject clone stderr phases into 0–70, aggregated submodule progress into
  70–85; the warm-refresh `cache` milestones span the whole 0–85 segment — its late
  steps, e.g. clean at 84 and "Repository cache ready" at 85, sit inside the 70–85
  band), and the local provisioning tail (checkout / CoW copy / worktree / finalizing)
  fills 85–100. Clone stderr phases are weighted inside their segment (receiving
  dominates; counting/compressing are cheap), the percent is clamped monotonically
  non-decreasing within the create, identical consecutive frames are deduped, and the
  clone's own terminal `complete` frame is re-labeled `checkout` at 85 ("Repository
  cloned") — only the create's own terminal frame carries `complete 100`
  ("Workspace ready").
- **Every mode emits.** Provisioning paths that historically streamed nothing emit
  coarse milestones through the same reporter: `starting 0` once armed, then per mode —
  a network clone streams the parsed git phases (plus the aggregated `submodules`
  phase); cache hydration streams the cache ensure for real (`cache` phase — a miss's
  full clone parses stderr, a hit's refresh emits per-step milestones for fetch/branch
  reset/submodule sync + update/clean) and then the provisioning tail (`cow-copy` or
  `checkout` at 88, streamed `submodules` population inside 89–94 on the `direct` arm);
  a local-repo create emits `worktree` ("Creating linked worktree...") or `cow-copy`
  ("Copying repository (CoW)...") at a nominal 30 (no clone segment ran before it; after
  a network clone the monotonic clamp lifts a later milestone into the 85+ tail
  automatically); an `isNewRepo` `direct` create emits `checkout` (branch checkout) at a
  nominal 50; every mode ends with `finalizing 95` before the row insert.
- **Exactly one terminal done.** The create wrapper owns the terminal frame: exactly one
  `git:clone:done` per create — `{ ok: true }` after the final `complete 100` on any
  successful create, `{ ok: false, error, errorCode? }` on any failure (sanitized detail,
  credential fragments redacted; `errorCode` present only for classified clone failures,
  §9.1) — in **every** checkout mode, including failures that occur before any
  clone/cache work started (an early config or idempotency-store error synthesizes a
  reporter so the stream still closes; no `workspaceId` exists yet on those paths, so
  that frame publishes under the empty sentinel id). **Idempotent replays emit
  nothing** — the cached success result is the answer; no progress or done frames are
  re-emitted.

**New-repository initialization (`workspace.create`, new in intentd).** When
`isNewRepo: true` (optional boolean, default absent/`false`), `repositoryPath` is not
already a local git repository, and no non-empty `githubUrl` is supplied — clone
orchestration above takes precedence — the daemon initializes the directory as a git
repository **before** branch naming and worktree provisioning, reusing the
`workspace.initializeRepository` body: `mkdir -p`, `git init -b main`, seeded
`.gitignore` + `README.md`, and an initial commit (git identity falls back to
`Intent <intent@local>` when no global identity is configured), so downstream
provisioning sees a real checkout. This is the FE's new-project flow (monorepo#962) —
it eliminates the silent row-only workspace the legacy skip produced for non-git
folders. `isNewRepo: true` with a missing/empty `repositoryPath` is rejected with
`-32602` (`repositoryPath is required when isNewRepo is true`) rather than falling
through to the row-only skip. An initialization failure fails the whole create
pre-insert — no row persisted, no `workspace:created` — with `-32603`,
`error.message = "Internal error"`, and the cause in
`error.data` (`workspace.create: repository initialization failed: <detail>`, §9).
`isNewRepo: true` on a path already carrying a git repository with a resolvable HEAD is
a no-op; when `.git` exists but HEAD does not resolve (a previously failed init left the
directory half-initialized), the init re-runs and completes it. Absent/`false` preserves
the legacy behavior: a non-git `repositoryPath` skips provisioning and persists a
row-only workspace (worktree-provisioning skip conditions above).
An `isNewRepo` create that would otherwise be provisioned persists
**`checkoutMode: "direct"`** (intentd#944): no worktree and no CoW clone is provisioned —
the workspace works directly in the initialized repository folder, where the workspace
`branch` is created (at `baseRef` when supplied, else from `HEAD`) and checked out so
agents land on `branch` as in every other checkout mode. `repositoryPath` **is** the
checkout and `worktreePath` carries the same path (standalone-row parity with cache
hydration, monorepo#2611 — previously `worktreePath` stayed unset, which left agent
spawn cwd resolution and the workspace file watcher without a checkout path). Because
the folder is user-chosen — never daemon-provisioned — `workspace.delete` removes only
the row: the standalone-checkout cleanup is gated on the daemon-owned
`<root>/<workspaceId>/<repo-slug>` layout, which the repository folder never matches.
The `"direct"` arm is gated on the same
provisioning-skip conditions as the worktree path above — an `isNewRepo` create with
`isRemote: true`, `skipIsolation`/`skipWorktree`, or a caller-supplied `worktreePath`
still initializes the repository but persists **no** `checkoutMode` and creates no
workspace branch.

**Spec note seeding (`workspace.create`).** Every successful create seeds the well-known
`spec` note in the new workspace (reference `notes.service.ts ensureSpecExists` parity):
id `"spec"`, title `"Spec"`, empty markdown body, tags `["spec"]`, pinned, default,
workspace visibility. The seed captures an initial `v1` version snapshot and publishes
`note:created` so subscribers see the standard note lifecycle. Seeding runs inside the
idempotency scope (§6.5) between `workspace:created` and initial-agent orchestration —
a replayed create returns the stored result and does not re-seed.

**Setup script execution (`workspace.create`).** The `setupScript` parameter is
**execute-only**: when supplied, the daemon executes the script as provided for that
creation (taking precedence over the committed repo config; an empty supplied script is
treated as omitted) but **never persists** it —
nothing is written to `<worktree-root>/.intent/config.json`, and the create path
performs no workspace DB `setup_script` write (the field is retired from all write
paths, kept for wire compat and legacy read-only fallback only). The worktree
`.intent/config.json` remains the sole persisted source of truth, mutated only by the
explicit write paths `workspace.saveSetupScript` (§5.25) and `repoConfig.save` (§5.33).
When the parameter is omitted, the effective script resolves via the unchanged
worktree-first `.intent/config.json` read with legacy DB fallback. FE contract:
cloudlands-fe always sends the script shown in the create form, except when it is the
unedited repo-config script (so the committed config stays authoritative); the
"last used for this repo" default is kept client-side. If an effective setup script
exists (non-empty), the daemon executes it non-blocking (fire-and-forget spawn) after
worktree provisioning in the worktree directory via
`/bin/sh` (POSIX; on Windows, via a discovered Git-for-Windows `sh.exe` running the same
POSIX wrapper, falling back to a `cmd.exe` `.cmd` wrapper that receives the script path
through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT` (repository root path), `WORKTREE_PATH`
(the new worktree path), `BRANCH_NAME` (workspace branch), and `SOURCE_BRANCH`
(baseRef when provided, empty string otherwise). Execution never fails workspace creation — errors are logged and
surfaced. Script output is streamed to a workspace terminal named **"Setup Script"**
(the PTY's daemon-tracked display name, surfaced by `terminal.list` — §5.9),
consistent with other workspace terminals. The script runs through a POSIX-sh timing
wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) that appends
a newline-prefixed completion summary to the scrollback —
`Setup script completed in <N>s (exit code <C>)` on success,
`Setup script failed in <N>s (exit code <C>)` on failure — preserving the script's
exit code.
The setup stage additionally publishes the **setup lifecycle events** (§6.5, additive):
`workspace:setup:started` fires iff an effective script was resolved and a spawn will
be attempted, and exactly one `workspace:setup:completed` fires per logical create on
every terminal path of the setup stage — script ran to exit (`ranScript: true` +
`exitCode`), spawn/pre-spawn failure (`ranScript: false`), no effective script,
`skipIsolation`/no worktree, and `workspace.duplicate` (immediate
`completed { ranScript: false }`). Idempotent replays publish nothing (same as
`workspace:created`). The daemon's own file watcher keys off the completion: a created
workspace's watcher registration (file watcher, git-metadata watcher,
skills/specialists) is **deferred** until `workspace:setup:completed` is observed for
it, so setup-script churn is dropped — never published, never buffered (no `file:*`
events exist for the setup window) — with a 60s backstop that starts the watchers
anyway (WARN) if no completion is observed; a script outliving the backstop emits its
remaining churn. A `workspace.open` during the setup window likewise supersedes the
deferral and starts the watchers immediately (the user is in the workspace), so a
still-running script's remaining churn surfaces from that point on.

**Initial-agent orchestration (`workspace.create`).** When `initialAgent` is supplied the
daemon minimally creates the agent session (honoring `name`/`model`/
`specialist`/`provider`/`behaviorPrompt`/`agentType`/`imageBlocks`/`metadata`) and
delivers the resolved `prompt` (blank/whitespace-only prompts are a no-op, no session).
An omitted `initialAgent.model` resolves through the same daemon-side creation-time
default-model chain as `agent.create` (§5.5 "Creation-time default-model resolution").
When `initialAgent.name` is omitted but a `specialist` is supplied, the agent's name
defaults to the specialist's resolved display name (frontmatter `name`, 3-tier
project > user > bundled — e.g. "Coordinator" for `spec-writer`) and counts as
explicitly set (it survives the agent's guarded opening-turn self-rename, same
rename-guard semantics as `agent.create` §5.5); an UNKNOWN `specialist` — one that
resolves to no known id or alias — is rejected with `-32602` naming the id and the
known catalog ids (monorepo#3497; same strict validation as `agent.create` §5.5),
while a known specialist whose display-name resolution fails still never fails the
create — the name falls back to the generated `Agent {6-hex}` placeholder (not
explicitly set).
The agent's id is **server-assigned**: whenever a session is created the daemon mints a
fresh `agent-{uuid}`, and a request carrying `initialAgent.agentId` is rejected with `-32602`
("agent IDs are server-assigned and the field must be omitted") **before any side
effect** — no workspace row, worktree, spec seed, or `workspace:created` event is
persisted.
The result's `initialAgent` is the created session's full `AgentLite` projection (its
server-minted id is `initialAgent.id`); the agent's turn starts
asynchronously (fire-and-forget) but the create call is not idempotent unless a
`idempotencyKey` is supplied — a replay with the same key returns the stored result
(carrying the originally minted `initialAgent.id`) without re-creating the
session or re-delivering the prompt.
The daemon stamps the reference-parity `isInitialAgent`/`isFirstWorkspaceAgent` flags on
the created session's raw metadata JSON, and the strict `AgentLite.metadata` projection
surfaces `isInitialAgent?: true` (presence-detected, `true`-only — §5.5) on the
`initialAgent` result and every later `agent.list`/`agent.get` read of that agent;
agents created any other way omit the key.

**Archive active-work teardown (`workspace.archive` / `workspace.unarchive`)**
*([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896); behavior only,
no wire-shape change).* Archiving stops the workspace's active work without destroying
any of it — unlike the delete cascade below, nothing is deleted:

- **In-flight agents are gracefully interrupted.** After the archived row is persisted
  (so a concurrent queue-drain kick observes the flag and parks instead of respawning a
  turn), the daemon sweeps every agent with an in-flight turn in the workspace through
  the `agent.stop` keep-alive semantics (§5.5): the turn is cancelled over the wire, the
  draining worker is aborted, and the terminal `agent:stream:end` is emitted with
  `stopReason: "interrupted"` (§7). The provider child process, ACP session, session
  rows, transcripts, completion watches, and pending message queues all **survive for
  unarchive to resume**; no `agent:deleted` fires. Read-only wiring (no agent manager
  attached) still archives without error.
- **Queued messages and wakes park while archived.** All gated delivery arms check the
  archived flag: the automatic queue drain and wake delivery (hook wakes,
  `agent.wakeOrCreate` context messages) refuse to start a turn in an archived
  workspace — entries stay parked in the pending queue (still visible via
  `agent.getQueue`, §5.5). Since [intent-hq/intentd#1293](https://github.com/intent-hq/intentd/pull/1293)
  (behavior only, no wire-shape change; monorepo#2732) the `send_message` arm carries
  the same gate at its choke point: **every automatic-origin delivery** into an
  archived workspace — completion-watch wakes, `ws.agent.reportToParent` relays,
  attention (blocker/discussion) wakes, event-subscription wakes, and agent-to-agent
  `ws.agent.send` / `ws.agent.sendToTask` — parks in the target's queue instead of
  delivering (interrupt-priority automatic sends park too, without interrupting), so a
  watched child completing elsewhere can no longer wake a parent in an archived
  workspace into a turn that auto-unarchives it (the archive/auto-unarchive loop).
  The gate keys on the **delivery (target) workspace**, so a watcher in an active
  workspace is still woken normally when a child in an archived workspace settles.
  **User-origin sends are exempt**: a direct user message (FE `agent.sendMessage`)
  passes the gate untouched and reaches the turn-start choke point, where the
  auto-unarchive block below flips the workspace back to Active — the user talking to
  an agent is an explicit resurrection signal; automatic machinery is not. Since
  [intent-hq/intentd#1587](https://github.com/intent-hq/intentd/pull/1587) (behavior
  only, no wire-shape change; fixes intent-hq/intent#3883) the exemption has two
  refinements. **Combined flush of parked archive notices**: under the `"all"` flush
  mode (§5.5 Queued-message flush), a user `agent.sendMessage` into an archived
  workspace whose queue holds parked ready-to-send entries (hook / PR-monitor
  archive-cancellation wakes, parked automatic sends) no longer runs a DIRECT turn
  past them — the send converts to a user-origin enqueue + immediate drain kick
  (modeled on the monorepo#1791 question-hold conversion, §5.5), returning the
  ordinary queued result `{ success: true, queued: true, queuedMessage, turnId }`,
  and the batch flush delivers every parked ready entry FIFO in the SAME combined
  turn as the user message, with the one-shot unarchive prompt notice trailing —
  so the model learns its hooks were cancelled in the same turn it is resumed,
  not in confusing later turns. The conversion is skipped when nothing is parked
  (the common empty-queue direct send is untouched), under `"systemOnly"`/`"off"`
  (no combined turn exists to carry the parked entries), and for a session parked
  in `Error` (whose documented recovery is the direct fresh send). **The drain-gate
  exemption is time-tightened**: only a ready user-origin entry queued at or after
  the archive (`queuedAt >= archivedAt`) releases the archived gate — a user entry
  parked by a busy race BEFORE archival is not a post-archive user action and stays
  parked with everything else (without the cut, the interrupted worker's end-of-turn
  re-kick would find that older entry and immediately unarchive a freshly archived
  workspace); pre-archive parked entries flush only on manual `workspace.unarchive`
  or by riding the combined turn of a NEW post-archive user message. An entry with
  an unparseable `queuedAt` never matches; a row missing or with an unparseable
  `archivedAt` (legacy data) fails open to the untimed user-origin check. The parked
  send's internal result carries the additive `archivedParked: true` marker alongside
  `queued: true` (surfaced through the MCP send bindings, so an agent can tell an
  archived park from an ordinary busy-queue fallback). The virtual chief workspace
  skips the row read (never archived), and a row-lookup error fails open so a transient
  store error cannot strand a queue. `workspace.unarchive` re-kicks the drain for every
  workspace agent with ready-to-send work (the drain re-checks its own gates), so
  parked queues deliver after unarchive without a manual kick; the gate re-checks the
  row after enqueue and re-kicks the drain itself if the workspace was concurrently
  unarchived, so a park racing a manual unarchive is never stranded.
- **Active background hooks are cancelled.** Every ACTIVE (`scheduled`/`running`) hook
  in the workspace (§5.40) goes through the `hook.cancel` machinery: scheduler task
  aborted, state persisted to `cancelled`, `hook:cancelled` emitted (§6.5), and the
  owner woken with an archive-specific notice — the wake itself parks behind the
  archived gate above, so it queues at most and never starts a turn while archived.
  Terminal hooks are untouched, and **unarchive does not resurrect cancelled hooks** —
  the notice ("This hook was cancelled because its workspace was archived.") explains
  why the watch stopped; the owner is expected to reschedule if the condition still
  matters. Best-effort per hook: a store failure is logged and the sweep moves on
  (archiving never fails because one hook row would not update).
- **Active PR monitors are cancelled** *([intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067); monorepo#1828)*.
  Every ACTIVE PR monitor in the workspace (§5.42) goes through the same core cancel
  transition as `prMonitor.cancel`, mirroring the hook sweep: state persisted to
  `cancelled` (guarded CAS — a concurrent cancel/complete winning the race is fine),
  `prMonitor:cancelled` emitted (§6.5), and the owner woken with an archive-specific
  notice ("This monitor was cancelled because its workspace was archived — it will not
  report again.") that parks behind the archived gate above. Terminal
  (`completed`/`cancelled`) monitors are untouched, and **unarchive does not resurrect
  cancelled monitors** — the owner re-registers via `ws.pr.monitor` if the PR still
  matters. Each cancel transition ends with the transition-only
  `workspace:displayStatus-changed` and `workspace:waiting-changed` recomputes (§6.5) —
  the drop lands with the sweep's last cancel — so an archived workspace no longer
  reads `waiting` indefinitely off a stale active-monitor signal (since v6.17 the
  monitor's wait signal feeds the orthogonal `waiting` flag rather than the
  `displayStatus` promotion, §5.1 step 3; the cancel also lapses the monitor's
  open-PR signal on the `displayStatus` PR rungs —
  [intent-hq/intentd#1329](https://github.com/intent-hq/intentd/pull/1329), §5.1
  step 4).
  Fail-soft per monitor: one row's cancel failure is logged and never aborts
  the sweep or the archive.

One residual race is a deliberate trade-off: a drain that read the workspace row before
the archive persisted can claim the in-flight slot after the sweep's busy-list snapshot,
spawning one stray turn the sweep misses — the window is a few statements wide, the
stray turn runs to completion once, and every subsequent drain/wake parks behind the
archived gates, so the sweep accepts it rather than adding a post-claim re-check to the
hot drain path.

**Auto-unarchive on agent turn start**
*([intent-hq/intentd#1216](https://github.com/intent-hq/intentd/pull/1216); additive
event-payload field within v6.17).* Archiving is sticky against queued/background
activity but not against a **real turn start**: when an agent turn actually begins in an
Archived workspace — at the turn-start choke point where the in-flight slot is claimed,
covering direct sends, queue drains, wake deliveries, and send-now redrives, but never
mere enqueue (the archived gates above keep parking queued wakes) — the daemon
automatically flips the workspace back to Active. Since
[intent-hq/intentd#1293](https://github.com/intent-hq/intentd/pull/1293) the archived
gates park **every automatic-origin delivery** before it can start a turn (see "Queued
messages and wakes park while archived" above), so in practice only a **user-origin**
send — the user deliberately messaging an agent in the archived workspace — reaches
this choke point while archived and triggers the flip; automatic wakes
(completion-watch, reportToParent, attention, event-subscription, agent-to-agent sends)
queue instead and do not auto-unarchive (since
[intent-hq/intentd#1587](https://github.com/intent-hq/intentd/pull/1587) the
user-origin trigger may arrive via the queue DRAIN rather than a direct send: the
combined-flush conversion above enqueues the user message, the drain's archived gate
is released by that post-archive user-origin entry, and its claim reaches this same
choke point — so the flip, the flushed parked entries, and the user message share
ONE combined turn) — with one bounded exception: the residual-race
stray turn above (a drain whose row read raced ahead of the archive persist) still
reaches the choke point and flips the workspace once. The flip goes through the same machinery as
`workspace.unarchive` (row flip, parked-queue drain re-kick, `lastActivity` derivation)
and publishes ONE `workspace:updated` delta (§6.5) whose `changes` additionally carry
the **additive** stamp:

```json
{
  "archived": false,
  "status": "Active",
  "archivedAt": null,
  "autoUnarchive": { "reason": "agent_activity", "agentId": "agent-…", "agentName": "…" }
}
```

`autoUnarchive` is **absent** on manual `workspace.unarchive` / `workspace.restore`
(absent ≠ present-false), so clients that predate the field see the previous delta shape
byte-for-byte; `agentName` is `null` when the agent's session-name lookup fails
(display-only — a lookup failure never blocks the unarchive). The virtual chief
workspace is skipped without a read, and the whole path is **best-effort**: a
workspace-read or unarchive failure logs a warning and the turn proceeds anyway — a
workspace stuck Archived is strictly better than a lost turn. Non-archived workspaces
pay one point read per turn start and nothing else. The row flip is **conditional**
([intent-hq/intentd#1521](https://github.com/intent-hq/intentd/pull/1521); behavior
only, no wire-shape change): the write runs `WHERE archived = 1`, so concurrent
unarchivers — two turn starts racing in the same archived workspace, or a turn start
racing a manual `workspace.unarchive` — serialize at the statement and exactly ONE
caller performs the flip. On the auto path a losing racer emits NO delta at all (the
winner's stamped delta already went out; this supersedes the earlier both-emit /
dedup-per-workspace guidance from #1216), while the manual RPC stays idempotent — a
no-flip manual unarchive still re-derives and re-emits its unstamped delta. The
residual-race stray turn above passes through the same choke point:
when its claim observes the already-persisted archived row it auto-unarchives like any
other turn start (only a claim that raced ahead of the archive persist still runs
archived once).

**Auto-unarchive transcript notice + one-turn prompt injection**
*([intent-hq/intentd#1521](https://github.com/intent-hq/intentd/pull/1521); additive
`agent_message.metadata` type, no method-catalog or wire-shape change).* A
**confirmed** flip — this claim's conditional write actually flipped the row; never a
lost flip race, the suppressed re-claim path, or an unarchive failure — additionally
does two things for the **triggering agent**, both **best-effort** (a persist/publish
failure is logged and the turn proceeds):

- **Persists ONE system transcript row** in the triggering agent's conversation:
  `role: "system"`, one text block
  `"Workspace was automatically unarchived because a message was sent to this agent."`,
  row `metadata = { "type": "auto_unarchived", "reason": "agent_activity" }` —
  following the `model_changed` system-notice precedent (§5.5 `agent.setModel`).
  Emits the standard `agent:message` event (`role: "system"`, §6.5) with agent-list
  cache invalidation so clients update live. Like every system row it is excluded
  from supervisor-XML history replay.
- **Injects a one-turn prompt notice**: the SAME turn that triggered the unarchive
  gets one additional trailing text block appended to its outbound provider prompt —
  `[SYSTEM NOTICE] This workspace was archived; it has been automatically unarchived because this message was sent.`
  The notice rides a one-shot in-memory flag armed only while the claim still holds
  its in-flight slot and consumed at prompt build, so ONLY the triggering turn
  carries it: never replayed on later turns (a separate mechanism from history
  replay, which still excludes system rows — see the §5.5 qualification on the
  `model_changed` row), never persisted, and a stale flag is dropped with the slot
  release, so a claim whose turn never builds a prompt (e.g. a pre-spawn persist
  failure) cannot leak the notice into a later, non-triggering turn.

**Delete cascade (`workspace.delete`).** Before the store cascade drops the
workspace's `agent_session` rows, the daemon sweeps every live in-memory piece of
per-session state so recreating a workspace with the same slug never surfaces ghost agents
whose workers are still draining or whose completion watches are still firing:

- list the workspace's sessions via `store.list_agent_sessions` (a store error is
  propagated with `?` — a partial teardown is worse than a failed delete);
- per session, `AgentManager::stop` aborts the in-flight turn worker, drops the
  session handle (which calls `kill_child_tree` on the ACP child on drop),
  clears the busy flag + the `agent_ws` workspace mapping, and deregisters the
  process from the LRU registry;
- drop the session's live-turn slot and pending message-queue entry in
  `Services` (both are `HashMap::remove` calls, not a drain);
- sweep the daemon-global subscription registry: completion watches whose
  **parent** session lives in the deleted workspace and delegation groups
  anchored there are dropped outright. Cross-workspace watches (a `__chief__`
  parent elsewhere watching a child here) are instead **consumed
  deterministically**: per swept session the daemon delivers the synthetic
  `agent:deleted` completion directly and synchronously (not via the bus, and
  before the store cascade removes the `agent_session` rows) — waking the chief
  parent exactly once and recording grouped children as deleted — then
  backstop-sweeps any surviving watch whose `child_workspace_id` is the deleted
  workspace (in-memory entries and persisted `completion_watch` rows), so no
  watch can reference the deleted workspace as child afterwards. Each parent
  affected by the backstop sweep gets a refreshed `agent:subscriptions-changed`
  (§6.5) so clients converge on the shrunken watch set without polling;
- eagerly abort the workspace's live background-hook scheduler tasks
  ([intent-hq/intentd#896](https://github.com/intent-hq/intentd/pull/896)): the store
  cascade drops the hook rows themselves, but without this sweep a live task would only
  exit lazily at its next tick (the pre-run re-read finds the row gone). Task-abort
  only — no `hook:cancelled` is emitted and no owner wake fires (unlike the archive
  cancel sweep above); best-effort: a hook-list failure is logged and skipped, leaving
  the lazy next-tick exit.

Best-effort teardown recovers from poisoned mutexes via `into_inner()` — this is
the last chance to unlink the workspace-scoped state, so recovery beats a panic.
The daemon emits **one `agent:deleted` per swept session BEFORE** the terminal
`workspace:deleted`, so subscribers see the per-session teardown first and can
retire agent-scoped UI (chat panes, banners) before the workspace row disappears
(§6.5).

**Workspace status fields (new in intentd).** Three BE-owned fields appear on `Workspace`
objects returned by `workspace.*` — lightweight status metadata, **not** a notification store —
each with a dedicated change event (§6.5) that carries the new value:

- `activity` — **derived, read-only (green dot).** In-flight agent state, e.g.
  `"idle" | "agent_running"`. The BE computes it from agent state; clients never set or
  recompute it. It has no setter; it surfaces in `workspace.*` results and via
  `workspace:activity-changed` (§6.5).
- `attention` — **dismissible (blue dot).** A small flag raised by BE transitions, e.g.
  `"none" | "unread" | "review_required"`. Server-owned, so dismissing it from any client
  clears it for all clients. **The served `unread` value is DERIVED from per-agent seen
  markers** on the `workspace.list` / `workspace.get` / subscription emit path:
  `unread` = any **top-level (no parent, non-background, non-deleted)** session whose
  newest user/assistant message is an assistant message the v4.5 seen marker has not
  caught up with (`lastMessageId` set, `lastMessageRole == "assistant"`,
  `metadata.lastSeenMessageId` absent or ≠ `lastMessageId` — the same equality-only
  comparison as the client-side per-agent derivation, §5.5 `agent.markSeen`). A stored
  `review_required` always wins over the derivation; the stored `unread` flag is no
  longer the read-path source of truth — the turn-end raise still writes it (back-compat
  + the transition emit), but a stale stored value can neither show nor hide the blue
  dot. Archived rows skip the derivation and keep the stored value (the turn-end raise
  skips archived workspaces, so no blue dot until unarchive — intentd#1075). Bounded
  cost over persisted session columns: list-shaped reads (`workspace.list`, the seq-0
  subscription snapshot) derive the whole list's unread set in ONE batched statement,
  single-row reads run one bounded EXISTS probe; a derivation failure keeps the stored
  value (degrade, never fail the read). Reading a conversation clears its share:
  `agent.markSeen` re-derives after each marker advance and, when the LAST unread
  session is read, clears the stored legacy flag and emits ONE
  `workspace:attention-changed { none }` (partial reads stay silent). The two
  workspace-level clears are **not** interchangeable (intentd#945):
  `workspace.dismissAttention` retires the stored flag whatever its value (a derived
  `unread` resurfaces on the next read while unseen messages remain), while
  `workspace.markSeen` marks every top-level conversation seen (see its row above) and
  leaves a persistent `review_required` in place (see the attention-flag write guard
  under the derived `displayStatus` block below). Both surface via
  `workspace:attention-changed` (§6.5). This is shared BE state rather than
  per-client local state (the daemon is single-user in v1; per-viewer cursors are a future
  extension).
- `waiting?` — **derived, read-only, orthogonal wait flag (v6.17).** `true` when the
  workspace has any of: an ACTIVE (`scheduled`/`running`) background hook (§5.40), an
  ACTIVE PR monitor (§5.42), or a **waiting agent subscription** — an undelivered child
  completion watch (`report_delivered` excluded, matching the settlement predicate) held
  by a **top-level foreground** agent, anchored in the parent's home workspace
  (§Completion-watch persistence) — i.e. the workspace is watching an external condition
  without needing a running agent turn. **Presence-detected**: emitted only as `waiting:
  true` and **omitted when `false`** (`skip_serializing_if`; never `false`/`null`), so
  clients treat an absent field as not waiting and older daemons interoperate fail-open.
  **Orthogonal to `displayStatus`** — a workspace can read `complete` or `pr_ready` and
  still be waiting; since v6.17 the three wait signals no longer feed the `displayStatus`
  derivation at all (see step 3 below). (Distinct from the wait signal, an ACTIVE PR
  monitor's persisted PR **state** does feed the derivation's PR rungs since
  [intent-hq/intentd#1329](https://github.com/intent-hq/intentd/pull/1329) — see step 4
  below — so a monitor-watching workspace typically reads `pr_open`/`pr_ready` with
  `waiting: true` alongside.) Derived on the same `workspace.list` /
  `workspace.get` / subscription emit path as `displayStatus` (never persisted; the
  enrichment also seeds the transition baseline for `workspace:waiting-changed`, §6.5),
  short-circuiting on the first live signal, and each probe is best-effort — a store read
  failure fails open to `false`, so emission is never wedged and waiting is never
  fabricated. Transitions surface via `workspace:waiting-changed` (§6.5).

**`status` wire form.** `Workspace.status` serializes as the PascalCase TS `WorkspaceStatus`
string enum — `"Active" | "Inactive" | "Archived" | "Deleted"` (src/shared/types.ts) — both on
the wire and as the stored DB word (matching the `PullRequestStatus` precedent). Optional
`Workspace` fields (`statusMessage`, `statusImageAssetId`, `baseRef`, `prUrl`, `prNumber`,
`prStatus`, `activePullRequest`, `pullRequests`, `contextLinks`, `archivedAt`, `cowSupported`,
`checkoutMode`, repository/worktree fields, …) are
**omitted when absent**
(`skip_serializing_if`) rather than emitted as `null`, so clients see only populated keys.

**`contextLinks` (new in intentd, migration `0110`).** Issue/PR context links supplied
at `workspace.create` — the initializer's context mentions — persisted on the workspace
row and returned on every `Workspace` payload so any client opening the workspace can
seed its layout from the linked pages. The param is `contextLinks?: ContextLink[]` where
`ContextLink = { kind: "issue" | "pr", url: string, owner: string, repo: string,
number: number }` (`kind` lowercase on the wire; an unknown `kind` — or a negative or
fractional `number`, which fails the unsigned-integer field type — rejects `-32602` at
parse time with a generic deserialization message). Validated at the very top of the
create op, before any state change, so a
bad list rejects `-32602` without leaving a partially created workspace behind: at most
**20** entries, `url`/`owner`/`repo` non-empty (whitespace-only counts as empty), and
`number` non-zero — each of these post-parse errors names the offending entry
(`contextLinks[i].field`). Write-once at create: `workspace.update` does not accept the
field, and the daemon never mutates it after insert. An empty list (and every workspace
created without the param) persists as absent, so the wire shape **omits** the field
(never `null` / `[]`); `workspace.duplicate` deliberately does not copy the source's
links (they describe the original creation context).

**PR-aware create (pr-kind `contextLinks`, new in intentd,
[intent-hq/intentd#1606](https://github.com/intent-hq/intentd/pull/1606)).** When the
`contextLinks` list carries a `kind: "pr"` entry, the workspace is PR-linked from birth
and the checkout lands on the PR's branches. With multiple pr-kind links the **first
wins** (deliberate tie-break: the FE puts the primary link first). Semantics, in order:

- **Cross-repo guard.** A pr-kind link whose `owner`/`repo` mismatch the workspace's
  known repository identity (caller-supplied or URL-derived; compared case-insensitively,
  blank fields never mismatch) is **ignored with a warn log** — deriving another
  repository's branch names onto this checkout would check out unrelated content or fail
  the create on an unresolvable `baseRef`. The link still persists in `contextLinks`;
  it just drives no PR-aware setup.
- **Linkage from the link itself.** `prNumber`/`prUrl` seed from the link's `number`/
  `url` — not from the forge lookup — so the linkage survives a degraded forge. Blank
  `repositoryOwner`/`repositoryName` are seeded from the link's `owner`/`repo` (also on
  the degraded path) so the persisted linkage stays functional for the background
  PR-refresh sweep (§5.7 `pr.refresh`).
- **Bounded forge lookup.** The create path fetches the PR via the configured
  source-control provider, wrapped in a timeout (`pr_refresh_fetch_timeout`, 60 s in
  production — the same bound as the PR-refresh sweep's per-entry fetch), so a hung forge
  connection degrades instead of stalling the interactive create. On success: an omitted
  (or empty) `branch` defaults to the PR's **head branch** and an omitted (or empty)
  `baseRef` to
  the PR's **base branch** — so ahead/behind and diffs reflect the merge target — and
  `prStatus` + the `activePullRequest` snapshot (+ `pullRequests`) fill from the lookup.
  **Explicit `branch`/`baseRef` params always win** over the PR-derived values.
- **Graceful fallback.** A failed or timed-out lookup — or no source-control provider —
  is **non-fatal** (warn log only): the create proceeds without the PR-derived git setup,
  keeping the `prNumber`/`prUrl` linkage from the link (the PR-refresh sweep heals status
  later). Non-PR creates (no links, or issue-kind only) are byte-for-byte unchanged.
- **Checkout.** The PR-derived head branch is treated as an EXISTING branch (no slug
  generation, no uniquification — see Branch naming above); a head existing only as a
  remote-tracking ref is materialized at the remote tip with upstream tracking (see
  Worktree provisioning above — the materialization applies across worktree / CoW /
  direct modes).
- **`baseCommitSha` = merge-base boundary.** A PR-derived branch checks out at the PR
  head, not the base, so the row records the **merge-base** of the checked-out HEAD with
  `baseRef` — preserving the contract that `baseCommitSha` is the base boundary — falling
  back to the checked-out tip when the boundary cannot be resolved (e.g. the head
  degraded to a fresh branch at the base commit, where tip = boundary anyway).
- **Fork-hosted heads degrade loudly.** `PullRequest` carries no head-repo info, so a
  head living in a fork has no `refs/remotes/<remote>/<branch>` in the base-repo clone —
  the checkout falls back to a **fresh branch at the base commit** (named like the head,
  without its commits) while `prNumber`/`prUrl` keep the linkage. The same applies to a
  never-fetched branch on a local-repo create (provisioning does no network fetch;
  cache-hydrated creates are fine — the cache refresh fetches). The daemon WARNs before
  provisioning when a PR-derived head has no local or remote-tracking ref, so the
  degradation is visible.

**`statusImageAssetId` (new in intentd, migration `0062`).** An agent-authored workspace
status screenshot reference (intent-hq/monorepo#997). The value is a content-addressed
asset id minted by the `note.saveAsset` machinery (§5.2); clients render it with
`note.readAsset` / the `workspace-asset://` URL scheme. Agents set or clear it via the
MCP `workspace_api` binding `ws.workspace.setStatusImage({ data, mimeType, originalName? }
| null)` — the daemon stores the image bytes as an asset first, then points the workspace
row at the resulting id (`null` clears; the binding errors when called against the
virtual chief-of-staff **workspace** — the `WorkspaceId::is_chief()` guard, same as
`archive`/`unarchive` — regardless of which agent or specialist calls it). On the wire,
`workspace.update` accepts `statusImageAssetId: string | null` with the same three
clearable forms as the PR fields below: **missing** leaves the stored value untouched,
explicit **JSON `null`** clears it, and a **present string** sets it (a whitespace-only
or empty string folds to a clear, and the delta carries the `null` clear signal). The
`workspace:updated { changes }` delta (§6.5) preserves the distinction, and the field is
omitted from `Workspace` payloads until an agent sets one.

**`cowSupported` / `checkoutMode` (new in intentd).** `cowSupported` is a BE-derived
machine-capability flag: a cached CoW-reflink probe of the **workspaces root**
filesystem (the probe creates a missing root rather than omitting), filled by the
aggregate-enrichment step on the `workspace.list` / `workspace.get` read paths —
`true` / `false` for a supported/unsupported filesystem, omitted when the probe cannot
run or exceeds the per-call budget (write-path responses such as `workspace.create` /
`update` / `archive` build the row without this enrichment, so clients read it off the
list/get poll). It reports the machine's capability independent of how the specific
workspace was provisioned; the FE gates the `workspace.cowIsolation` opt-in toggle
(§5.12) on it. **Caveat — root-scoped, not repo-scoped:** provisioning probes from the
*repository directory* into the workspaces root (§5.1), so a repository on a different
filesystem than the workspaces root (reflinks cannot cross filesystems) can still land
`workspace.create` on the worktree-fallback path (`checkoutMode: "worktree"`, §5.1)
even when `cowSupported` is `true`; `cowSupported` is a toggle-gating advisory, not a
per-repository guarantee.
`checkoutMode` (`"worktree" | "cow" | "direct"`, lowercase on the wire) records how
`workspace.create` provisioned this workspace's checkout (§5.1): `"worktree"` a linked
worktree, `"cow"` a standalone copy-on-write clone, `"direct"` a standalone plain local
clone (the cache-hydration fallback when CoW is unsupported) or an `isNewRepo`
initialization working in the repository folder itself. It is omitted for rows
without a daemon-provisioned checkout (skip-isolation, remote, caller-supplied
`worktreePath`, non-git repository paths, pre-existing rows). `"cow"` and `"direct"` are
both **standalone** repositories: `workspace.delete` skips the worktree-registration
prune and the source-repo branch-delete guard for both, and both are sandbox-eligible
(§5.5).

**`lastActivity` (BE-derived, always populated).** `Workspace.lastActivity` is the
authoritative "most recent thing that happened in this workspace" timestamp. The daemon
derives it on every path that returns a `Workspace` on the wire (`workspace.list` /
`workspace.get` / `workspace.create` / `workspace.update` / `workspace.archive` /
`workspace.unarchive`) as the **max** of the persisted `lastActivity`, `updatedAt`,
`createdAt`, every note's `updatedAt`, and every agent session's `updatedAt` (FE
`deriveWorkspaceLastActivity` parity). It is always present on the wire —
clients never need to recompute it from notes/agents.

**Push cadence — turn boundaries only
([intent-hq/intentd#1489](https://github.com/intent-hq/intentd/pull/1489)).** Between
reads, the daemon pushes changes via a **debounced** `workspace:updated` event whose
`changes` delta carries only `lastActivity` (§6.5): rapid triggers for the same
workspace coalesce into at most one event per 3-second window (the timer resets on each
trigger, carrying the latest derived value), the recomputed value is compared against
the stored one and an unchanged value emits nothing, and the derived value is also
persisted through a **scoped, monotonic** column write (only the `lastActivity` column
moves, and a late out-of-order timer can never walk it back) so the cheap non-deriving
read paths — `list_workspaces_lite` and the `workspace.subscribe` seq-0 snapshot —
serve a fresh value after a daemon restart. The debounce is scheduled **only at turn
boundaries**, so workspace ordering does not churn on every mid-turn mutation: (a) an
agent **turn end** — a status persist transitioning the session OUT of an active state
(to idle, error, or a terminal state); turn-start and mid-turn status flips do not
schedule; (b) a **user-origin message send** — the FE `agent.sendMessage` direct send,
a user-origin queue-drain delivery, a user-role `agent.appendMessage`, and the
user-origin `agent.sendQueuedMessageNow` store-only force-send (the manager-backed
send-now routes through the direct-send gate); and (c) an
**attention raise** (`ws.agent.reportBlocker` / `ws.agent.requestDiscussion`, §5.5).
Agent-origin appends, agent-to-agent sends, queued-wake deliveries, system-injected
turns, `agent.setModel` / `agent.update` / `agent.reportToParent` mutations, and
token-usage recomputes deliberately do NOT schedule — mid-turn activity surfaces at the
turn's end. The event is a **change signal**, not the authority: the inline derivation
above still runs fresh on every `Workspace`-returning read, so a `workspace.get`
mid-turn serves an up-to-date `lastActivity` even though no event has fired yet.
Behavior only — the derivation formula, the delta shape, and the debounce window are
unchanged; no version bump.

**PR-field ownership (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`, `pullRequests`).**
These five fields are BE-owned: the daemon writes them from PR discovery / refresh
(§5.9, §6.5 `pr:*` events) and clients read them off the returned `Workspace`. All five
are `Option`s that serialize with `skip_serializing_if` (absent, not `null`). The
persisted `pullRequests: PullRequestInfo[]` (new in intentd, migration `0035`) sits
alongside `activePullRequest` and carries the reconciliation candidates the FE matches
`activePullRequest` against.

**Merged `pullRequests` on the list emit paths (new in intentd;
[intent-hq/intentd#1330](https://github.com/intent-hq/intentd/pull/1330)).** On
`workspace.list` and the lite `workspace.subscribe` seq-0 snapshot (§6.9) — the two list
surfaces — the emitted `pullRequests` is a **merged pool**, not a bare read of the stored
column: the daemon folds in the PRs persisted on the workspace's registered git roots
(`workspace_git_root.pull_requests`, the sweep's per-root discovery — §5.6) and the PRs
known to the workspace's PR monitors (entries synthesized as `PullRequestInfo` from
`pr_monitor` snapshots, §5.42; `active` and `completed` monitors count, `cancelled` are
excluded — the same visibility rule as `prMonitor.list`; a snapshotless monitor synthesizes
URL/title from its repo identity, and a completed monitor without a snapshot verdict maps
to `closed`, never `merged`). **Dedup is by PR `url`, first-wins by source precedence**
(workspace stored list > git-root > monitor-derived) — one entry per URL, **no recency
comparison**: a URL already carried by the workspace's stored list wins outright even when
a git-root or monitor entry for the same PR is fresher. One exception: a lower-priority
duplicate whose `status` sits higher on the lifecycle ladder (`Open`/`Draft` < `Closed` <
`Merged`) upgrades the winning entry's `status` + `updatedAt` + `isDraft` in place, so a
stale stored/git-root entry never shadows a monitor that already saw the PR merge
(monorepo#3127). Status only ever moves up the ladder: `Merged` is irreversible and wins
over everything (including a stale `Closed`), while `Closed` — the snapshotless
completed-monitor fallback among others — never downgrades a `Merged` verdict, and
reopened-after-close is left to the sweep re-fetch. `isDraft` moves with `status` so an
upgraded entry never reads merged/closed while still claiming draft.
Identity and all other fields still come from the higher-priority source. Entries can therefore be
**cross-repo** (a submodule root's or a monitored PR's repository rather than the workspace
repository): the entry's `url` is authoritative for which repo it belongs to. The merge is
computed on emit from already-persisted rows — plain column reads plus an in-memory merge,
**no forge calls on the read path** — and exists so list/sidebar clients see submodule and
monitored PRs without opening the workspace. A row with nothing to merge keeps its stored
serialization untouched (an absent stored `pullRequests` stays omitted); a row that merges
always serializes a plain array. The merge also runs **after** the `displayStatus`
enrichment, so the PR/task rollup (the derivation below) reads only the stored
workspace-level list — merged entries affect the emitted `pullRequests` array, never
`displayStatus`. Everything else is unchanged: the stored `workspace.pull_requests` column
keeps its workspace-repo semantics (PR discovery/refresh writes it as before, and the
explicit-null clear below still targets only the stored value), `workspace.get` and the
write-path responses carry the unmerged workspace-level list, and the `pr:*` event
payloads (§6.5) are untouched.

**Explicit-null clear on `workspace.update` PR fields.** On `workspace.update`, the same
five clearable PR fields (`prUrl`, `prNumber`, `prStatus`, `activePullRequest`,
`pullRequests`) accept three wire forms: **missing** the key leaves the stored value
untouched, an explicit **JSON `null`** clears the stored value, and a **present value**
sets it. The applied `WorkspaceUpdate` delta emitted as
`workspace:updated { changes }` (§6.5) preserves this distinction — omitted keys were
untouched, `null` keys were explicit clears, present keys were sets.

**`baseRef` canonicalisation.** On `workspace.create` and `workspace.update`, an incoming
`baseRef` has any known remote prefix (`origin/`, `upstream/`, `fork/`) stripped before
persistence, so `origin/main` and `main` collapse to the same canonical `main`. The
returned `Workspace.baseRef` and the persisted DB value are always the canonical form;
values without a known prefix are stored verbatim. `git.*` methods that need the
fully-qualified remote-tracking name reconstruct it as `origin/<baseRef>` locally.

**Card aggregates (`taskStats` / `agentSummary` / `diffSummary`).** `workspace.list` and
`workspace.get` enrich each `Workspace` with the nested rollup objects the iOS coverflow cards
read, computed fresh from live state on the emit path (never persisted). They are decoded as
optional by iOS and each is **omitted when not computable** (`skip_serializing_if`) rather than
emitted as `null`, so absent simply yields a sparser card. Since intentd#743 only `taskStats`
and `agentSummary` are actually attached on these read paths — `diffSummary` is **always
omitted** (see its bullet below):

- `taskStats: { total, completed, inProgress }` — ports the canonical `computeTaskStats`
  (`task-stats.ts`) over the spec-linked direct-child task notes: `cancelled` is excluded from
  `total`, `complete` counts as `completed`, and `in_progress` + `review_required` count as
  `inProgress`. The renderer-only per-task `tasks` array is omitted.
- `agentSummary: { count, agents: WorkspaceAgentInfo[], agentIds: string[] }` where
  `WorkspaceAgentInfo = { id, name, status, specialist?, lastActivity?, isStreaming, isResponding, parentAgentId? }`.
  This matches the **live iOS `WorkspaceStore.parseWorkspace` consumer** (the richer
  `{ count, agents }` form); `agentIds` is additionally emitted alongside it for forward-compat with
  the slim TS `WorkspaceAgentIdSummary { agentIds }` (a future desktop-on-intentd reads
  `agentSummary?.agentIds ?? []`) and lists the same agents (same order) used to build `agents`.
  `status` carries the same wire strings as `agent.list`; `isStreaming`/`isResponding` are always
  `false` (the headless backend has no live stream state — `status` carries liveness, matching the
  `AgentLite` decision); `lastActivity` is the session `updatedAt`; `parentAgentId` (v2.9, additive)
  is the delegating/spawning agent's id — the same session value surfaced as
  `metadata.createdByAgentId` on `agent.get`/`agent.list` loads (§5.5) — **omitted** for root
  agents, so clients can rebuild the delegation tree from the summary alone. Since
  [intent-hq/intentd#1359](https://github.com/intent-hq/intentd/pull/1359)
  ([monorepo#3041](https://github.com/intent-hq/monorepo/issues/3041)), **archived**
  `workspace.list` rows omit `agentSummary` entirely — the archived tail dominated the
  serialized list payload while no list consumer reads agent info off archived rows (the HUD
  filters archived before reading it; iOS decodes it optionally). Active list rows and
  `workspace.get` — archived included — keep serving it. The slimming runs as a final pass
  over the merged list after enrichment, so a row degraded by an enrichment failure is
  slimmed the same way.
- `diffSummary: { schemaVersion, updatedAt, totalFiles, totalAdditions, totalDeletions, files }` —
  **never emitted since intentd#743**: the per-workspace head-diff rollup is omitted on the
  `workspace.list` / `workspace.get` / workspace-subscription emit paths (recomputing it for every
  workspace on every enrichment pass pinned the blocking pool on large workspace sets). The field
  stays on the wire shape as optional for decoder compatibility; clients that need diff data fetch
  it on demand (path-scoped `git.diffs` / `git.numstat`, §5.6) instead of reading it off a hydrated
  workspace payload.

**Workspace disk usage (`workspace.diskUsage`, on-demand since v4.2).** The **cached**
whole-workspace disk footprint —
`diskUsage: { bytes, fileCount, computedAt, breakdown: [{ name, bytes, fileCount }] }` —
is served exclusively by the dedicated `workspace.diskUsage` method (the §5.1 table above);
since v4.2 the `workspace.list` / `workspace.get` read paths (and the workspace-subscription
emit path) **never populate** `Workspace.diskUsage` (monorepo#1396 — recomputing/serving it
on every hot list pass was needless enrichment weight; the field stays on the row shape as
optional for decoder compatibility, it is simply never present). The method returns
`{ diskUsage?, refreshing }`: `diskUsage` is **omitted when no computed value exists yet**
(absent, never `null`; the value is never persisted — in-memory cache only), and
`refreshing: true` reports an in-flight background walk (first-ever poll, or a stale entry
being revalidated) so clients know to poll again shortly. Only rows with a daemon-managed
directory qualify: remote / skip-isolation rows and the virtual Chief workspace — plus any
row whose directory was never provisioned on disk — answer `{ refreshing: false }` with the
field omitted, without touching the cache (a walk against a missing directory would fail
and report `refreshing` forever-true). An unknown `workspaceId` is `-32602` (NotFound).
Payload and cache semantics:

- **Scope — the whole per-workspace folder.** The walk covers
  `<workspaces_root>/<workspaceId>` in its entirety: the repo checkout **plus** tool
  outputs, agent sandboxes, and any other content of the workspace directory — not just
  the checkout.
- **Physical (allocated) usage, not apparent size.** `bytes` sums allocated blocks
  (`st_blocks * 512`), so sparse regions don't count. Hard-linked files are deduped by
  `(st_dev, st_ino)` within a walk — a multi-linked inode counts once, toward whichever
  breakdown bucket encounters it first. Symlinks are never followed (only the link's own
  allocation counts) and directory-inode allocation is excluded. **CoW caveat
  (best-effort):** clone-shared extents (APFS `clonefile`, btrfs/XFS reflink) are counted
  at **full** allocated size in every workspace that references them — excluding them
  would need a per-file extent enumeration that blows the walk budget — so for
  CoW-provisioned workspaces the value is a documented **upper bound**, not exact
  exclusive usage.
- `fileCount` counts the regular files that contributed bytes (hard-link duplicates
  once); `computedAt` is the RFC-3339 wall-clock time the walk completed — clients can
  render staleness from it.
- `breakdown` carries one `{ name, bytes, fileCount }` entry per **top-level directory**
  of the workspace folder, sorted by `bytes` descending (name ascending on ties), plus a
  synthetic `"other"` bucket aggregating loose top-level files when non-empty.
- **~60s cache / stale-while-revalidate / single-flight / serialized walks.** The walk
  never runs on the request path. Each workspace's value has a ~60-second TTL: a fresh
  entry is served as-is with `refreshing: false`; an expired entry is served
  **immediately** with `refreshing: true` while a single background walk refreshes it for
  the next poll (stale-while-revalidate); refreshes are single-flight per workspace, so
  concurrent `workspace.diskUsage` polls coalesce into one walk — and walks across
  **different** workspaces are additionally globally serialized (max 1 concurrent walk,
  intentd#881: usage is stale-while-revalidate and first paint omits it, so concurrent
  full-tree walks only create disk contention). The first-ever poll finds no entry — the
  field is **omitted**, `refreshing: true` is reported, and the computed value backfills
  for the next poll. A failed walk keeps the last-good value (retried on the next poll).

**Derived display status (`displayStatus`, new in intentd).** Alongside the card aggregates, the
same `workspace.list` / `workspace.get` emit path — and the lite `workspace.subscribe` seq-0
snapshot (§6.9, intentd#743) — enriches each `Workspace` with a BE-owned
"current cycle" status rollup over the active/latest PR and `taskStats` — derived fresh on emit,
**never persisted**. Wire values are the snake_case strings
`"failed" | "blocked" | "needs_attention" | "in_progress" | "not_started" | "idle" | "complete" | "pr_ready" | "pr_open" | "pr_merged"`
(`"idle"` new in intentd#793, `"needs_attention"` new in intentd; `"failed"` / `"blocked"`
new in intentd#945 — added without a protocol bump per the same precedent, since
clients degrade unrecognized values neutrally, see below; the intentd#945 `"unread"`
value is **removed** — the `unread` attention flag is no longer a displayStatus axis, so
the value simply never reaches the wire, which is client-compatible per the same
precedent — the flag itself, its turn-end raise, and `workspace.markSeen` are the unread
contract, §5.1 `attention`). The field is
**authoritative**: clients render it as-is and
perform **no local derivation** (ios#59, cloudlands-fe#560; the former FE sidebar
running/idle grouping overlay is deleted, cloudlands-fe#578). It is decoded as optional and
**omitted when `taskStats` is not computable** (`skip_serializing_if`, e.g. a transient
notes-read failure) rather than emitted as `null`. The two degenerate cases are **distinct**
(ios#81): an **absent** field defaults the display to `not_started`, while a **present but
unrecognized** wire value — a newer daemon emitting a variant this client build predates —
degrades to a **neutral unknown** treatment (a placeholder rendering, sorted last), never to
`not_started` or any other real status. Clients must not conflate the two: a value the build
does not know is not evidence that work has not started. The derivation is the
**canonical precedence** (intentd#945) — `failed` > `blocked` > `needs_attention` >
`in_progress` (running agent) > the PR/task rollup — folding the attention axes
and live agent activity around the "current cycle" rollup:

The attention axes (steps 0–2) are probed per workspace
over its **top-level foreground** sessions — no `parentAgentId`, not background
(`isBackground`), and not deleted — plus the dismissible workspace `attention` flag
(`review_required` only — the `unread` flag never feeds the derivation). Child
and background sessions never count: their attention surface is the parent/subscriber (the
§5.5 attention-retire taxonomy). A pending attention request raised MID-TURN whose
user-facing surfacing is still parked on the deferred-attention registry does not count
either ([intent-hq/intentd#1639](https://github.com/intent-hq/intentd/pull/1639), §5.5
idle-deferred surfacing): the workspace reads `in_progress` while the raising turn runs,
and the turn-end flush's recompute promotes it to `blocked` / `needs_attention` exactly at
the surfacing point. Best-effort: a store read failure fails open to `false`
(the question-hold derivation fails open itself), so list/get emission is never wedged and
attention is never fabricated.

0. **Failed** *(new in intentd#945)* — a top-level foreground agent is parked in `error`
   (the mid-turn failure park, awaiting `agent.retry` — §5.5) → `failed`,
   **unconditionally** (outranks everything, including `blocked` and the running
   promotion): the workspace cannot make progress until the user redrives.
1. **Blocked** *(new in intentd#945)* — a top-level pending **blocker** attention request
   (`attentionRequestKind = "blocker"`, raised via `ws.agent.reportBlocker`, §5.5 — an
   infrastructure/environment problem) → `blocked`. Previously folded into
   `needs_attention`; now its own rung above it.
2. **Needs attention** *(new in intentd)* — a top-level foreground agent is waiting on
   the user → `needs_attention`. A session counts when it either (a) carries a pending
   non-blocker **attention request** (`attentionRequestKind = "discussion"`, raised via
   `ws.agent.requestDiscussion`, §5.5) or (b) has **pending structured questions** — the
   same question-hold derivation as §5.5 (the persisted `pendingQuestionsMessageId` marker
   is set and differs from the `dismissedQuestionsMessageId` marker; within v6.0 this is a
   metadata read, not a transcript tail walk — modulo the one-time pre-upgrade fallback,
   §5.5 — and pendingness survives later user messages
   and agent turns) — or (c, new in intentd#945) the workspace
   `attention` flag reads `review_required`. The cheap session-metadata check (attention
   requests) runs over every candidate first; question-hold probes only
   happen when no session already flagged.
3. **Agent running** —
   any agent running in
   the workspace (the same signal behind `activity == "agent_running"`)
   → `in_progress`, **unconditionally over everything below** (overrides the
   PR stages and `complete`). **Since v6.17 only a truly running agent promotes.** The
   external-wait signals that previously folded into this step — the active-hook fold
   (intentd#856), the active-PR-monitor fold
   ([intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036);
   [monorepo#1814](https://github.com/intent-hq/monorepo/issues/1814)), and the
   child-completion-watch fold — are **unwound**: an idle agent still watching via a
   background hook (§5.40), a PR monitor (§5.42), or delegated-child completion
   watches (§Completion-watch persistence) no longer reads as `in_progress`. Those
   three **wait** signals surface exclusively as the orthogonal `Workspace.waiting` flag
   (see the workspace status fields above) — the same probes, anchored the same way
   (watches in the **parent's home workspace**, the watch's `parent_workspace_id`,
   never the child's; watches held by child or background agents never count), all
   best-effort with a store read failure failing open to `false` — so an
   idle-but-watching workspace reads its real rollup (`complete`, a PR stage, `idle`)
   with `waiting: true` alongside. This restores the pre-#856 promotion semantics;
   the `activity` field's semantics are unchanged. The monitored PR's own **state**
   is a separate signal: since
   [intent-hq/intentd#1329](https://github.com/intent-hq/intentd/pull/1329) it feeds
   the step-4 PR rungs below — an active monitor never promotes to `in_progress`
   here, but it can read as `pr_open`/`pr_ready` there.
4. **Not running** — the "current cycle" precedence:
   1. **Open/draft PR** — the linked `activePullRequest` when open/draft, else the most
      recently updated open/draft entry in `pullRequests` — yields `pr_ready`
      (`mergeable == true` and not draft) or `pr_open`. An **ACTIVE PR monitor**
      (§5.42) whose persisted last snapshot shows the PR open/draft is the same rung
      ([intent-hq/intentd#1329](https://github.com/intent-hq/intentd/pull/1329)):
      `pr_ready` when the snapshot says mergeable and not draft, else `pr_open` — so
      a workspace watching an open PR via `ws.pr.monitor` (including a cross-repo PR
      that never enters the workspace's own PR linkage) never falls through to
      `complete`/`idle`. A linked open PR wins the shared rung first (richer data);
      the mapping is identical either way. The monitor signals are derived purely
      from the persisted rows — no forge calls; an unparseable or missing snapshot
      (and an active row whose snapshot already shows a terminal state) contributes
      nothing, and a store read failure fails open to no signal.
   2. **Open tasks remain** (`completed < total`) → `in_progress` when any task has started
      (`inProgress > 0` or `completed > 0`), else `not_started`.
   3. **Latest PR merged** (the linked PR, else the most recently updated `pullRequests`
      entry) → `pr_merged`. A **COMPLETED monitor** whose final snapshot shows the PR
      merged feeds this rung too (intentd#1329) — only the **latest** completed
      monitor (by `updatedAt`) counts, mirroring the linked-PR "most recently
      updated" semantics, so an older merged watch never masks a newer
      closed-unmerged one.
   4. **All tasks complete** (`total > 0`, `completed == total`) → `complete`; else
      `not_started`.
5. **Idle demotion** — when not running and step 4 yields `in_progress` or `not_started`,
   the result is demoted to `idle`; the PR stages and `complete` pass through.

The dismissible `unread` workspace attention flag (the server-owned turn-end blue dot,
§5.1 `attention`) **never feeds the derivation** — the intentd#945 step-6 unread
promotion is removed, so the rollup always reflects the workspace's real state and the
flag surfaces exclusively through `Workspace.attention` and
`workspace:attention-changed` (§6.5).

`not_started` and a non-running `in_progress` are therefore **no longer emitted**; those enum
variants are retained for wire back-compat (older daemons / client decode paths — they still
decode, and clients keep their `not_started` default for an **absent** field; an unrecognized
value takes the neutral unknown treatment instead).

**Attention-flag write guard (intentd#945).** The turn-end automatic `unread` raise fires
only when a **top-level foreground** agent's queue drains (intentd#1021): child agents
(`parent_agent_id` set) and background agents never raise it — their completions surface
to their parent/coordinator, not the user. A `NotFound` session load (deleted agent)
skips the raise too, while a genuine store error fails open (raise + warn). The raise is
further guarded on the stored flag being `none`: it never downgrades a persistent
`review_required` (no `workspace:attention-changed`), and `workspace.markSeen` — guarded
on `unread` — leaves `review_required` in place; only `workspace.dismissAttention`
retires that flag (its documented contract).

A merged PR in history never masks an open PR (step 4.1 scans `pullRequests` — and the
monitor signals — for open/draft entries) or open tasks (step 4.2 precedes the merged
check). Transitions are pushed as
`workspace:displayStatus-changed` (§6.5), which since intentd#793 also fires on agent
start/stop: the 0→1 running transition recomputes-and-emits immediately, and the
running→not-running recompute runs after the same debounce grace window as
`workspace:activity-changed` (emitting whatever the not-running derivation yields — `idle`,
a PR stage, or `complete`), so the two stay in lockstep. The hook / PR-monitor /
completion-watch lifecycle transitions still recompute-and-compare at every choke point,
but since v6.17 the wait signals move the orthogonal `waiting` flag, not the rollup — each
site runs **both** transition-only recomputes (`workspace:displayStatus-changed` and
`workspace:waiting-changed`, §6.5). With the fold unwound the displayStatus half is
normally a silent no-op at the hook and completion-watch sites while the waiting half
emits; the PR-monitor sites are the exception since intentd#1329 — the monitored PR's
state feeds the step-4 PR rungs, so those same choke points are where the rung
transitions actually emit: a register on an open PR can emit `pr_open`/`pr_ready`, the
poll loop's terminal completion on a merge emits `pr_merged`, and a cancel lapses the
monitor's signal back to the base rollup (the idempotent re-arm still recomputes and
stays a silent no-op). A mid-watch snapshot change (e.g. checks turning the PR
mergeable, `pr_open` → `pr_ready`) does not push its own transition — the poll loop's
non-terminal refreshes are not recompute sites; the flip surfaces on the next read-path
enrichment or any later choke-point recompute. Hook lifecycle transitions
(intentd#856 established the sites): a hook **schedule** (a newly persisted active
hook can raise `waiting`) and every hook **settlement** — dispatch, eviction, cancel, expiry, on
both the synchronous ops and the spawned-task run paths — so `waiting` drops when the
workspace's last active hook settles. PR-monitor lifecycle transitions
([intent-hq/intentd#1036](https://github.com/intent-hq/intentd/pull/1036) established the sites):
a monitor **register** (`ws.pr.monitor` — a newly persisted active monitor can raise;
the idempotent re-arm recomputes too, staying a silent no-op) and every monitor
**settlement** — an owner cancel (`ws.pr.unmonitor`), an external FE cancel
(`prMonitor.cancel`), the `workspace.archive` sweep cancels (§5.1 archive active-work
teardown; [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067)),
the poll loop's terminal completion (PR merged/closed), and the
boot-rehydration owner-gone cancels — so `waiting` drops when the workspace's last
active monitor settles. Completion-watch lifecycle transitions
recompute too, always in the parent's home workspace: a
watch **register/adopt** (the `agent.delegate` auto-watch, `after_all` group enrollment,
explicit `ws.agent.watch` — a newly armed watch can raise) and every watch
**settlement** — the deliver-once retirement at the child's completion, `after_all`
group settlement (the aggregated wake clearing the grouped watches), a scoped or
unscoped `agent.cancelSubscriptions` / `ws.agent.unwatch` cancel, and the
workspace-delete subscription sweeps (a deleted child's watches settling on surviving
parents) — the same choke points that publish `agent:subscriptions-changed` (§6.5) — so
`waiting` drops when the parent's last active watch settles. The attention axes add
their own recompute-and-compare points: an attention **raise** (`ws.agent.requestDiscussion`
/ `ws.agent.reportBlocker` — a child/background raise stays silent, since the derivation
ignores those sessions and the transition-only emission suppresses the no-op) and its
**retire** (the turn-begin clear on a qualifying delivery, §5.5); a **question-asking turn
end** (the turn-end `pendingQuestionsMessageId` marker write arms the question-hold
derivation) and each question-hold **release** — within v6.0 only a `question_answers`-tagged
user row naming the marked message, `agent.dismissQuestions`, or a NEWER question-bearing
assistant turn releases it (§5.5). The recompute-and-compare still runs after every
user-row persist (`agent.sendMessage` direct send, `agent.sendQueuedMessageNow`,
`agent.editAndRegenerate`'s regenerated message, a drained user-origin queue entry) and
every transcript mutation via `agent.appendMessage` / `agent.replaceMessages` (§5.5), but
an untagged row leaves the marker armed, so those paths now emit only when the derivation
actually flipped (intentd#833; intentd#965). The intentd#945 axes add theirs: the mid-turn **Error park** (the
`failed` promotion — the recompute runs as the park persists, so the turn-end debounce
never hides it) and its retires — `agent.retry` (the redrive clears the park and the
recompute runs before the worker starts, emitting `failed → in_progress` immediately)
and the fresh-`agent.sendMessage` recovery path (recomputed after the user-row persist —
the earlier turn-begin recompute still reads `error` and would stay silent); every
workspace **attention-flag write that can move the `review_required` axis** —
`workspace.dismissAttention` and a `workspace.update` carrying `attention` (the turn-end
`raise_attention` writes only `unread` — a guarded no-op when the flag is not `none`, and
skipped entirely when the workspace is `Archived` at drain time — fail-open on a
workspace-read error;
[intent-hq/intentd#1075](https://github.com/intent-hq/intentd/pull/1075) — and
`workspace.markSeen` only clears `unread`; neither feeds the derivation, so both skip the
recompute). The emit-path
enrichment (both the enriched list/get path and the lite
snapshot path) also seeds the in-memory baselines both events' recompute-and-compare runs
against — the displayStatus baseline and the v6.17 `waiting` baseline alike (a seed never
emits); `workspace.delete` evicts both.


```json
// → request — dismiss the blue-dot attention flag
{ "jsonrpc":"2.0","id":2,"method":"workspace.dismissAttention","params":{ "workspaceId":"ws-abc" } }
// ← response (attention reset; emits workspace:attention-changed)
{ "jsonrpc":"2.0","id":2,"result":{ "workspace":{ "id":"ws-abc","activity":"idle","attention":"none" } } }
```

**Workspace chat-context items (`workspace.getContext` / `updateContext`, new in intentd).**
Migrates the renderer-only `localStorage["workspace:context:{workspaceId}"]` store (attached
files/notes/URLs, Linear/GitHub/Sentry issues surfaced in the chat context panel) into
daemon-owned rows so the surface is queryable by MCP tools and other clients. The daemon
treats each item as an **opaque JSON blob** authored by the FE — the `ContextItem` union in
`packages/cloudlands-fe/src/features/context/types.ts` — and only pulls `id` out for keying
and ordering. `updateContext` is a full-list replacement (matches the FE's collapsed
`hydrate/add/remove/update` write pattern) and preserves the caller-supplied order. Every
successful `updateContext` emits `workspace:context-changed` with the persisted list
(§6.5), so subscribers refresh without a follow-up `getContext`.

- **ContextItem** — `{ id: string (required, non-empty), ...extras }`. `id` is the row key
  and the only field the daemon inspects; every other field (`type`, `provider`, `title`,
  `url?`, `parentNoteId?`, `createdAt`, `updatedAt`, plus provider-specific extras such as
  `identifier`, `number`, `favicon`, `noteId`, `isSpec?`, `taskStatus?`) round-trips
  verbatim. The FE's union types are the source of truth.

```json
// → request — write the authoritative list
{ "jsonrpc":"2.0","id":10,"method":"workspace.updateContext","params":{
  "workspaceId":"ws-abc",
  "items":[
    { "id":"ctx-1","type":"linear-issue","provider":"linear","title":"ENG-42",
      "identifier":"ENG-42","createdAt":"2026-07-13T00:00:00Z","updatedAt":"2026-07-13T00:00:00Z" }
  ]
} }
// ← response (emits workspace:context-changed)
{ "jsonrpc":"2.0","id":10,"result":{ "items":[ /* same list */ ] } }
```

### 5.23 Usage metrics — `workspace.getTokenUsage`

The backend owns token/credit **usage accounting**. Usage is sourced **live from ACP**: at the end
of each prompt turn, the `PromptResponse.usage` report (via the agent-client-protocol
`unstable_end_turn_token_usage` feature flag) carries the session's **cumulative** counters; the
daemon persists that snapshot per session with **REPLACE semantics** (each report replaces the
session's previous snapshot — reports are never summed), mapping ACP `cachedReadTokens` →
`cacheReadTokens` and `cachedWriteTokens` → `cacheCreationTokens`, then immediately re-aggregates
per agent and per model and writes the durable `tokenUsage` field on the `Workspace`. The
turn-end bookkeeping is **detached** from the turn itself — it never delays the terminal
`agent:stream:end`, and bookkeeping for the same agent is ordered across turns — so a client
reading `workspace.getTokenUsage` immediately after `agent:stream:end` may briefly see the
previous tally; rely on `workspace:tokenUsage-changed` (§6.5) to observe the update.
**Usage survives ACP session recreation:** when a `session/load` → `session/new` ACP session
recreate swaps in a fresh ACP session id — whether via the resume-impossible fallback (a failed
`session/load`), `agent.editAndRegenerate`'s forced recreate, or the `agent.retry`
poisoned-session recreate ([monorepo#940](https://github.com/intent-hq/monorepo/issues/940)) —
the outgoing session's
cumulative snapshot is folded into a daemon-internal per-agent **baseline** (saturating sum) and
the snapshot is cleared, atomically with the id swap — the recreated session's cumulative reports
restart from zero, so per-agent effective totals are **baseline + snapshot**. The baseline is
internal accounting only (never on the wire; `TokenUsage` shapes are unchanged), and the legacy
per-message **message-sum fallback** applies only when both baseline and snapshot are absent. A
daemon-internal periodic **scan** (300 s cadence) is demoted to a **reconciliation fallback** for
sessions the live path cannot see (providers without end-of-turn usage reports / legacy
per-message metadata); a reconciliation recount that comes back all-zero **never regresses** a
stored non-zero live tally to zero **while agent-session rows still exist** (the racing-sweep
guard). When the workspace has no sessions left (all deleted), an all-zero recount is legitimate
and writes through — clients must not assume `tokenUsage` can never drop back to zero. Only the
**read** and its change event cross the wire —
neither the live update nor the scan has an RPC (§6.8). `workspace.getTokenUsage` requires
`workspaceId`.

**`tokenUsage` is detail-only on the list paths** (since
[intent-hq/intentd#1359](https://github.com/intent-hq/intentd/pull/1359),
[monorepo#3041](https://github.com/intent-hq/monorepo/issues/3041)): although the tally is
persisted on the `Workspace` row, `workspace.list` rows and the lite `workspace.subscribe`
seq-0 snapshot rows (§6.9) **never serve** `tokenUsage` — the field is optional
(`skip_serializing_if`), so it is simply absent (never `null`), following the v4.2
`diskUsage` precedent. `workspace.get` keeps serving it, and clients that need usage read
`workspace.getTokenUsage` + `workspace:tokenUsage-changed` as before (the FE already did
exactly this — no list consumer read the field off list rows).

| Method | Params | Result |
| --- | --- | --- |
| workspace.getTokenUsage | workspaceId (req) | { tokenUsage: TokenUsage } — -32602 if the workspace is not found |

**TokenUsage** — `{ byAgentId: { [agentId]: TokenUsageTotals }, totals: TokenUsageTotals,
byModel: { [modelName]: TokenUsageTotals }, lastScanAt: string | null }`, where
**TokenUsageTotals** is the consumption counters plus an optional cost —
`{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, thoughtTokens?,
cost?: { amount: number, currency: string } }`. `byAgentId` keys are
`agent-{uuid}`; `byModel` keys are the effective model name (`"unknown"` fallback); `lastScanAt` is
the RFC-3339 timestamp of the last recompute — a live turn-end update or a reconciliation pass
(`null` before the first). Updated values are pushed via `workspace:tokenUsage-changed` (§6.5).

**Cost** is sourced from the ACP `usage_update` session notification's `cost` object
(`{ amount, currency }`, `currency` an ISO 4217 code) and is therefore present **only for
providers that report it** — the field is **omitted** (never `null`, never a fabricated `0`)
on any bucket no contributing session reported a cost for, so clients written against the
pre-cost shape are unaffected. Like the token counters, `usage_update` cost is **cumulative
per ACP session**, so each report REPLACES the session's previous cost and an ACP session
recreate folds it into the same internal baseline as the counters (no reset-to-zero loss, no
double count). The two reports are independent: a turn carrying only a cost never zeroes the
counters, and a turn carrying only counters never drops a cost already reported. Aggregation
sums amounts per currency within each bucket (`totals`, each `byAgentId` entry, each `byModel`
entry); in the pathological case of a bucket mixing currencies, the currency with the largest
sum wins — the daemon never converts between currencies.

**`thoughtTokens`** *(additive within v6.0, [intent-hq/intentd#973](https://github.com/intent-hq/intentd/pull/973))*
is the cumulative reasoning ("thought") token count, sourced from the end-of-turn ACP
`PromptResponse.usage` report's `thoughtTokens` field (not the `usage_update` notification,
which carries only `used`/`size`/`cost`). It is **disjoint** from `outputTokens`: providers
whose wire report is a subset of `outputTokens` (codex, grok) have it carved out at ingestion
(`output − thought`, saturating), so clients may sum all five counters freely
(intent-hq/intent#3796). Codex tallies recorded before the carve-out shipped retain the
subset shape (no backfill).
It is a `u64` in camelCase, **omitted when zero or unreported** (never a fabricated `0`, never
`null`), so clients written against the pre-`thoughtTokens` shape are unaffected. It aggregates
exactly like the other counters — saturating sum into `totals` / each `byAgentId` entry / each
`byModel` entry, saturating subtraction for the per-turn delta against the previous cumulative
snapshot (clamped ≥ 0), and folded into the ACP-session-recreate baseline the same way. A tally
whose ONLY non-zero counter is `thoughtTokens` still counts as a real token report, so it does
not fall through to the legacy per-message usage fallback.

```json
// → request
{ "jsonrpc":"2.0","id":62,"method":"workspace.getTokenUsage","params":{ "workspaceId":"ws-abc" } }
// ← response (pushed again as workspace:tokenUsage-changed whenever the tally changes — at turn end or after a reconciliation pass)
{ "jsonrpc":"2.0","id":62,"result":{ "tokenUsage":{
  "byAgentId":{ "agent-123":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } } },
  "byModel":{ "opus-4.8":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } } },
  "totals":{ "inputTokens":12000,"outputTokens":3400,"cacheReadTokens":8000,"cacheCreationTokens":1200,"cost":{ "amount":1.25,"currency":"USD" } },
  "lastScanAt":"2026-06-17T12:00:00Z" } } }
```

### 5.25 Worktree setup scripts — `workspace.getSetupScript` / `workspace.saveSetupScript` / `workspace.detectProjectType` / `workspace.generateSetupScript`

A per-workspace **setup script** that provisions a fresh worktree (install deps, build prereqs, …),
**persisted in `.intent/config.json`** in the worktree (committable, repo-scoped). The workspace
DB `setup_script` field is retired from all write paths (kept for wire compat and legacy
read-only fallback only). `detectProjectType` inspects manifest files to classify the project;
`generateSetupScript` is the **AI-assisted** generator. Every method requires `workspaceId`.

**Setup script execution:** When a workspace is created (`workspace.create`) and an effective
setup script exists (non-empty, resolved from an explicit `setupScript` param — execute-only,
never persisted, §5.1 — else from worktree `.intent/config.json` or legacy DB
fallback), the daemon executes it non-blocking (fire-and-forget spawn) after worktree
provisioning in the worktree directory via `/bin/sh` (POSIX; on Windows, via a discovered
Git-for-Windows `sh.exe` running the same POSIX wrapper, falling back to a `cmd.exe` `.cmd`
wrapper that receives the script path through the `INTENT_SETUP_SCRIPT` env var) with env vars `MAIN_CHECKOUT`
(repository root path), `WORKTREE_PATH` (the new worktree path), `BRANCH_NAME` (workspace
branch), and `SOURCE_BRANCH` (baseRef when provided, empty string otherwise). Execution never fails workspace creation —
errors are logged and surfaced. Script output is streamed to a workspace terminal named
**"Setup Script"** (its daemon-tracked PTY display name in `terminal.list`, §5.9); a POSIX-sh
timing wrapper (the Windows `cmd.exe` fallback uses an equivalent `.cmd` wrapper) appends a
newline-prefixed `Setup script completed in <N>s (exit code <C>)` /
`Setup script failed in <N>s (exit code <C>)` summary to the scrollback, preserving the
script's exit code (§5.1).

| Method | Params | Result |
| --- | --- | --- |
| workspace.getSetupScript | workspaceId (req) | { setupScript: SetupScript } — reads from worktree `.intent/config.json` (when present), falls back to legacy DB row `setup_script` (read-only) |
| workspace.saveSetupScript | workspaceId (req), script (req): string | { setupScript: SetupScript } — writes to worktree `.intent/config.json` (merge semantics, best-effort) and returns synthesized record; DB field is not written. Returns -32602 (invalid params) when the workspace has no `worktreePath` or `repositoryPath` |
| workspace.detectProjectType | workspaceId (req) | { projectType: ProjectType \| null } — null when no known manifest is found |
| workspace.generateSetupScript | workspaceId (req) | { setupScript: SetupScript } — AI-assisted draft (returned, not auto-saved; persist with saveSetupScript) |

- **SetupScript** — `{ script: string, projectType?: ProjectType, updatedAt: number,
  generatedBy?: "user"\|"agent" }`. `generatedBy` records whether the body was hand-written
  (`saveSetupScript`) or AI-drafted (`generateSetupScript`); `updatedAt` is the last-write epoch-ms.
  When read from `.intent/config.json`, `generatedBy` is synthesized as `"user"`.
- **ProjectType** — `"node" | "python" | "go" | "rust" | "ruby"` (detected from `package.json`,
  `pyproject.toml`/`requirements.txt`, `go.mod`, `Cargo.toml`, and `Gemfile` respectively).

```json
// → request — detect the project type, then generate a draft script
{ "jsonrpc":"2.0","id":64,"method":"workspace.detectProjectType","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":64,"result":{ "projectType":"rust" } }
// → request
{ "jsonrpc":"2.0","id":65,"method":"workspace.generateSetupScript","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":65,"result":{ "setupScript":{
  "script":"#!/usr/bin/env bash\nset -euo pipefail\ncargo fetch\n",
  "projectType":"rust","updatedAt":1750000000000,"generatedBy":"agent" } } }
```

