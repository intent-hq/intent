> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.18 `accept-changes.*` · §5.19 `file-tracking.*` (reads) · §5.20 Change metrics (reads).

### 5.18 `accept-changes.*`

The multi-step "accept the agent's work" workflow: the backend owns local git **and** the forge
(the `SourceControl` trait), so a thin client drives commit → push → create-PR →
merge through a handful of calls. `execute` runs the orchestrated pipeline and **restores agent
attribution** from `file-tracking` (§5.19) on each step. Every method requires `workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| accept-changes.getStatus | workspaceId (req) | WorkspaceGitStatus (schema below) |
| accept-changes.prepare | workspaceId (req), action (req), files?: string[] | PrepareResult { valid, warnings[], errors[], suggestedCommitMessage?, suggestedPRTitle?, suggestedPRBody?, filesCount, additions, deletions, files: [{ path, additions, deletions, staged }] } |
| accept-changes.execute | workspaceId (req), action (req), files?, commitMessage?, prTitle?, prBody?, targetBranch?, mergeStrategy?: "merge"\|"squash"\|"rebase", upToCommitHash?, undoCommitsMetadata?, options?: { stageUnstaged?, pushAfterCommit?, createPRAfterPush?, rebaseFirst?, localOnly? } | AcceptChangesResult { success, steps: [{ id, name, status, message?, error? }], result?: { commitHash?, prNumber?, prUrl?, mergeCommitHash?, … }, error? } |
| accept-changes.mergePR | workspaceId (req), prNumber (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | AcceptChangesResult |
| accept-changes.addRemote | workspaceId (req), remoteUrl (req) | WorkspaceGitStatus (refreshed after adding `origin`) |

`action` is one of `commit \| push \| create-pr \| merge \| export \| undo-push \| undo-commit \|
reset-to-trunk \| rebase-onto-trunk` — except **`export` is not supported** (no UI consumer),
so `execute` rejects `action:"export"`. A step that fails sets `success:false` and the offending
`steps[].status:"failed"` with `error`; malformed params → `-32602`, underlying service throws →
`-32603`.

```json
// → request — prepare a commit for the staged files
{ "jsonrpc":"2.0","id":50,"method":"accept-changes.prepare",
  "params":{ "workspaceId":"ws-abc","action":"commit" } }
// ← response
{ "jsonrpc":"2.0","id":50,"result":{
  "valid":true,"warnings":[],"errors":[],
  "suggestedCommitMessage":"Add review wire surface",
  "filesCount":2,"additions":140,"deletions":12,
  "files":[{ "path":"docs/rust-backend/PROTOCOL.md","additions":140,"deletions":12,"staged":true }] } }
```

**Shared schemas (Code Changes Review).** Defined once here; referenced by §5.19, §5.20.

- **WorkspaceGitStatus** — `{ branch, trunkBranch, aheadOfTrunk, behindTrunk, hasRemote,
  isPushed, uncommittedCount, stagedCount, localCommits: CommitWithAttribution[],
  existingPR?: { number, url, htmlUrl, title, state: "open"|"closed"|"merged"|"draft" } }`.
- **CommitWithAttribution** — a local commit carrying agent provenance:
  `{ hash, message, author, date, filesChanged?, isPushed, files?: [{ path, additions?,
  deletions?, status? }], agentId?, linkedNoteId? }`. `files` and `filesChanged` are
  emitted only when the producing walk computed per-commit tree diffs. All current
  producers are **metadata-only** (both fields omitted — the list walks skip
  per-commit diffs for performance; clients fetch per-file data on demand via
  `git.commitDetails` (§5.6)): `accept-changes.getStatus` `localCommits` and
  `file-tracking.loadCommits` (§5.19). The `changes:git-status` event (§6.5) carries
  the same reduced `WorkspaceGitStatus`.
- **TrackedChange** — one file's audit record through the git stages (see §5.19):
  `{ id, file, relativePath, stage: "unstaged"|"staged"|"committed"|"pushed"|"pull_request"|
  "merged"|"trunk", status?: "added"|"modified"|"deleted"|"renamed",
  stats: { additions, deletions, binary? },
  attribution: { agent?: { agentId, agentName, sessionId, turnNumber, messageId?, toolCallId?,
  timestamp }, manual?, timestamp } }`.
- **Review** — `{ author, verdict: "approve"|"request-changes"|"comment", body?, submittedAt }`
  (host-agnostic; GitHub's `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED` map onto `verdict`).
- **CheckRun** — `{ name, state: "pending"|"success"|"failure"|"neutral"|"cancelled", url? }`.
- **Metrics** — line-change totals: `{ additions, deletions, filesChanged, byAgent }` (workspace-level
  stats include `byAgent`; per-agent stats may omit `byAgent`; see §5.20).
- **DiffChunk / DiffDetail** *(internal — no wire method)* — old/new content + hunks, computed and
  stored inside the backend; never returned by a `diffs.*` RPC.
  Diff content reaches the client only via the `file-tracking.*` reads and the §6.5 change events.

### 5.19 `file-tracking.*` (reads)

A per-file audit trail as changes move through the git stages
(`unstaged → staged → committed → pushed → pull_request → merged`) with agent attribution. Only
the **UI-invoked reads** are wire methods; the attribution writer `trackChange` is **internal**
(the backend records it as agents edit files — no client RPC; see §6.8). Every method requires
`workspaceId`.

| Method | Params | Result |
| --- | --- | --- |
| file-tracking.getChanges | workspaceId (req), filter?: { stage?, agentId?, sessionId?, turnNumber?, filePattern?, since?, until? } | { changes: TrackedChange[], truncated, totalCount } |
| file-tracking.loadCommits | workspaceId (req), limit?: number (default 50, ≤200), nextToken?, includeOlder?: boolean (default false) | { commits: CommitWithAttribution[], boundarySha, nextToken } — **metadata-only** entries (see the CommitWithAttribution schema, §5.18): the bounded walk skips per-commit tree diffs; clients fetch per-file data on demand via `git.commitDetails` (§5.6). Boundary semantics below |
| file-tracking.getLineStats | workspaceId (req) | { additions, deletions } — real-time totals across unstaged + staged + local commits |
| file-tracking.getAgentLocks | workspaceId (req) | { autoCommitEnabled, lockedAgentIds: string[], lockedFilePaths: string[] } — the daemon-computed **agent-lock snapshot**; hydration read for the `changes:agent-locks` event (§6.5). Lock semantics below |
| file-tracking.stage | workspaceId (req), paths (req): string[] | { ok: true } — stages the referenced files |
| file-tracking.unstage | workspaceId (req), paths (req): string[] | { ok: true } — unstages the referenced files |

**`file-tracking.getAgentLocks` lock semantics (v8.8).** The daemon owns the agent-lock
computation (previously client-side): which agents' files must **not** be manually
staged/reverted because the owning agent is actively working with auto-commit enabled —
a manual stage/revert there would race the daemon's auto-commit. An agent is **locked** when
all three hold: (1) the workspace's **effective auto-commit** is enabled (the §5.1
`workspace.getAutoCommit` resolution — per-workspace override, else global `git.autoCommit`);
(2) the agent owns at least one tracked change at the `unstaged` or `staged` stage (§5.19
attribution rows; later stages never lock); (3) the agent is **actively working** — its session
is running a turn (`pending`/`active`), or its linked task note's status is not terminal
(`complete`/`cancelled`). Retired and deleted sessions never lock. `lockedFilePaths` is the
union of the locked agents' unstaged/staged tracked-change paths (repo-relative, forward-slash).
Both arrays are sorted and deduplicated; when auto-commit is off the snapshot is
`{ autoCommitEnabled: false, lockedAgentIds: [], lockedFilePaths: [] }`. Store failures degrade
to the empty (unlocked) snapshot rather than an error. Live updates ride the self-sufficient
`changes:agent-locks` event (§6.5) — same payload plus `workspaceId` — published by a daemon
recompute worker (debounced ~500 ms) whenever agent lifecycle, task status, auto-commit
policy, or tracked-change churn moves the snapshot; unchanged snapshots are never re-emitted.

**`file-tracking.loadCommits` boundary semantics.** The commit walk is bounded by the workspace's **boundary commit** so a workspace only surfaces its own history:

- When `includeOlder` is `false` (default), returns commits in the `boundary..HEAD` range (workspace-owned commits only).
- When `includeOlder` is `true`, returns commits before and including the workspace boundary (for "show previous" functionality; the boundary commit itself is included).
- `boundarySha` is the workspace boundary commit SHA, or `null` when the workspace has no boundary info (`baseRef` or `baseCommitSha` not set), or when boundary info exists but cannot be resolved (e.g. shallow clone, nonexistent ref, base commit not an ancestor of HEAD).
- **Fail-closed safety net:** when boundary info exists but cannot be resolved, the method returns an empty commit list (regardless of `includeOlder`) to prevent leaking arbitrary base-branch history.
- **Boundary resolution strategy:** (1) prefer the merge-base of HEAD with `origin/<baseRef>` or `<baseRef>` (rebase-resilient); (2) fall back to `baseCommitSha` if it is a valid ancestor of HEAD; (3) return `null` if neither resolves.
- `nextToken` in the result is the pagination token for the next page, or `null` when exhausted; pass it back as the `nextToken` parameter.

```json
// → request — load committed changes for one agent
{ "jsonrpc":"2.0","id":51,"method":"file-tracking.getChanges",
  "params":{ "workspaceId":"ws-abc","filter":{ "stage":"committed","agentId":"agent-123" } } }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "changes":[
  { "id":"git-1-src/x.ts","file":"/ws/src/x.ts","relativePath":"src/x.ts",
    "stage":"committed","status":"modified","stats":{ "additions":10,"deletions":2 },
    "attribution":{ "agent":{ "agentId":"agent-123","agentName":"Coordinator",
      "sessionId":"sess-9","turnNumber":4,"timestamp":1750000000000 },"timestamp":1750000000000 } } ],
  "truncated":false,"totalCount":1 } }
```

### 5.20 Change metrics (reads)

Read-only line-change aggregates. Aggregation
itself (`metrics.calculate`, the `update*` writers, `mark-agent-active`) is **internal** — the
backend computes metrics as agents work and pushes change events (§6.5); clients only **read**.
Metrics are durable (the `workspace_metrics` / `agent_metrics` tables).

| Method | Params | Result |
| --- | --- | --- |
| metrics.getWorkspaceStats | workspaceId (req) | Metrics \| null — `{ additions, deletions, filesChanged, byAgent }` for the workspace |
| metrics.getAgentStats | agentId (req) | Metrics \| null — `{ additions, deletions, filesChanged }` for one agent (`byAgent` omitted) |
| metrics.getAllWorkspaceStats | — | { [workspaceId]: Metrics } — all workspaces |
| metrics.clearAgentStats | agentId (req) | { success: boolean } — resets one agent's counters |

```json
// → request
{ "jsonrpc":"2.0","id":52,"method":"metrics.getWorkspaceStats","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "additions":140,"deletions":12,"filesChanged":3,
  "byAgent":{ "agent-123":{ "additions":140,"deletions":12,"filesChanged":3 } } } }
```

