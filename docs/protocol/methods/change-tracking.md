> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.18 `accept-changes.*` · §5.19 `file-tracking.*` (reads) · §5.20 Change metrics (reads).

Routing-only `workspaceId?` additions below are [prepared contract fields](../workspace-routing.md), optional on direct daemons and required for future forwarded workspace calls; existing scope and results are unchanged.

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

#### Native review preparation and receipts

| Method | Params | Result |
| --- | --- | --- |
| accept-changes.reconcile | workspaceId, operationId, root | Original pending/settled native-review attempt, subject to current disclosure checks |
| accept-changes.release | workspaceId, operationId, root | {released: true}; retires admission without erasing a committed effect |

**Prepared additive contract.** Detect support through the original
connection's [`nativeReview: 1` capability](client-hello.md#native-review-capability).
The capability does not establish a configured provider connection. Admission is conditional
on current original ownership and provider configuration. Prepared facts and the
capability alone are not permission to execute.

The **presence** of `review` selects the qualified branch of the existing
`accept-changes.prepare` and `accept-changes.execute` operations. Omitting it keeps
the ordinary unqualified contract above, including GitHub, unchanged. A null or
malformed `review`, or any unknown field in a qualified request or its nested
records, is rejected; it never falls back to the ordinary branch. Qualified
actions are only `commit`, `push` and `create-pr`.

**Requests and original identity.** The root is explicit and workspace-bound:
`{ workspaceId, kind: "primary" }` or
`{ workspaceId, kind: "registered", gitRootId }`. Its workspace must match the
outer `workspaceId`. A root path, copied scope or context/selection ID is not a
substitute for the original captured root and socket.

- Preparation accepts `{ workspaceId, action, files?, options?, review }`.
  `files` is an optional array of strings. `options` permits only
  `stageUnstaged`, `pushAfterCommit` and `createPRAfterPush`, each a boolean that
  defaults to false. `review` is `{ root, choice, targetBranch?, pushRemote? }`.
  Choice is `{ kind: "saved" }` or `{ kind: "explicitTarget", target }`, where
  target is `{ provider, instanceBaseUrl, projectPath }`. An explicit choice is
  per preparation; it does not save or reset repository selection.
- Execution accepts `{ workspaceId, action, review, commitMessage?, prTitle?,
  prBody? }`, with `review: { operationId, root }` from the received preparation.
  It does not accept replacement files, options, branch, provider, credential or
  scope. The action must match the original preparation. Commit requires a
  nonblank `commitMessage`.
- The `accept-changes.reconcile` and `accept-changes.release` operations
  each accept exactly `{ workspaceId, operationId, root }` on that same socket.
  Reconcile observes the retained attempt; it does not dispatch another stage.
  Release returns `{ released: true }`, retires future stage admission and is
  idempotent for an absent or released ID after original-root authorization.
  It is not a cross-connection existence lookup or receipt deletion.

Optional `files`, `targetBranch`, `pushRemote`, `commitMessage`, `prTitle` and
`prBody` accept omission or null. Omitted `options` supplies defaults; null
`options` or null option booleans are invalid. Root, choice and operation identity
are required. Unknown provider enum values fail decoding; the shared enum also
contains GitHub, but this qualified implementation supports **GitLab only**.

**Independent stages.** Files and `stageUnstaged` apply only to commit. Both
chaining flags also apply only to commit: `pushAfterCommit: true` adds push;
`createPRAfterPush: true` adds create and does **not** implicitly add push. A
standalone create adds no Git stage. Separate sidebar commit and create calls
have independent preparations and receipts; the latter cannot claim the former's
commit. A changed command cannot reuse an earlier operation.

A push plan requires explicit `pushRemote`; HTTPS push binds the exact original
source ref/SHA and all approved destinations. It does not permit SSH push, ambient
credential helpers, URL rewrites, force or redirects. Create supports ready,
same-project GitLab merge requests. It requires a valid target branch different
from the original source branch and already present remotely. Omitting
`targetBranch` resolves to the source branch, which cannot satisfy create. An
exact existing match is returned as reused without editing it. Ambiguous targets,
unsupported transports and changed authority are refused before a new effect;
there is no silent origin/trunk or provider fallback.

For example, this requests an explicit commit/push/create plan. It assumes the
captured GitLab source branch differs from `main` and the original `origin`
destinations satisfy admission; the JSON itself supplies no authority:

```json
{"jsonrpc":"2.0","id":150,"method":"accept-changes.prepare","params":{"workspaceId":"ws-example","action":"commit","options":{"stageUnstaged":true,"pushAfterCommit":true,"createPRAfterPush":true},"review":{"root":{"workspaceId":"ws-example","kind":"primary"},"choice":{"kind":"saved"},"targetBranch":"main","pushRemote":"origin"}}}
```

A standalone create can instead name a registered root and explicit project.
This per-call choice is not persisted and performs no implicit commit or push:

```json
{"jsonrpc":"2.0","id":151,"method":"accept-changes.prepare","params":{"workspaceId":"ws-example","action":"create-pr","review":{"root":{"workspaceId":"ws-example","kind":"registered","gitRootId":"root-example"},"choice":{"kind":"explicitTarget","target":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example","projectPath":"group/project"}},"targetBranch":"main"}}}
```

For the first preparation, execution binds the original operation and root. The
files, options and branch plan are not resubmitted:

```json
{"jsonrpc":"2.0","id":152,"method":"accept-changes.execute","params":{"workspaceId":"ws-example","action":"commit","review":{"operationId":"operation-example","root":{"workspaceId":"ws-example","kind":"primary"}},"commitMessage":"Record the prepared changes","prTitle":"Review the changes"}}
```

**Preparation result.** The ordinary display shape is augmented, not replaced:
`valid`, `warnings`, `errors`, `filesCount`, `additions`, `deletions`, `files` and
the three suggestion strings remain. Qualified display suggestions are currently
empty strings. The two added objects are:

| Field | Qualified response |
| --- | --- |
| `reviewOperation` | `{ operationId, root, retirementSequence, expiresAfterMs: 300000 }` |
| `reviewPreparation` | `{ operationId, scope, contextRevision, root, worktreeId, source, target, localHeadSha, transport }` |
| `scope` | `{ daemonId, authorityScopeId, authorityGeneration }`; derived by the server, not an authorization parameter |
| `contextRevision` | `{ epoch, sequence }`; comparable only within matching scope/epoch |
| `source`, `target` | `{ repository, providerProjectId, connection?, branch }`; repository is the qualified provider/instance/project identity, project ID is string or null |
| `connection` | `{ connectionId, accountId, connectionGeneration }` when disclosed; **omitted** from each branch target for a non-administrator |
| `localHeadSha` | String or null, reflecting the original observation |
| `transport` | Null or `{ remoteName, fetchUrls: string[], pushUrls: string[] }`, with sanitized complete destination lists; fetch does not imply push |

Scope and connection generations, revision sequences and retirement cursors are
canonical decimal u64 **strings**, including values beyond JavaScript's safe
integer range. Project IDs are also strings. `expiresAfterMs` and the existing
review `resource.number` remain JSON numbers; do not change their wire types.

Actual host Owner/Member permission, workspace membership, credential and root
checks govern execution. Administrator permission is separate: public
source/target connection fields are omitted for other callers, including inside
retained executions. If included, administrator permission is checked again at
final disclosure. Private account/credential facts stay server-owned; a missing
public connection field does not itself deny a permitted Member operation.

**Execution and reconciliation.** Execution returns
`{ operationId, root, state: "pending"|"settled", reviewExecution?, success,
steps, result?, error? }`. Reconcile returns
`{ operationId, root, state: "prepared"|"pending"|"settled", reviewExecution? }`.
The execution payload appears only after actual settlement. Pending execution is
not success and includes no fabricated result:

```json
{"jsonrpc":"2.0","id":152,"result":{"operationId":"operation-example","root":{"workspaceId":"ws-example","kind":"primary"},"state":"pending","success":false,"steps":[],"error":"Repository review outcome is pending; reconcile the original socket"}}
```

Reconciliation uses the original bound identity, without a new write:

```json
{"jsonrpc":"2.0","id":153,"method":"accept-changes.reconcile","params":{"workspaceId":"ws-example","operationId":"operation-example","root":{"workspaceId":"ws-example","kind":"primary"}}}
```

Release uses that same bound identity; its success does not certify that an
admitted worker has stopped:

```json
{"jsonrpc":"2.0","id":155,"method":"accept-changes.release","params":{"workspaceId":"ws-example","operationId":"operation-example","root":{"workspaceId":"ws-example","kind":"primary"}}}
```

`reviewExecution` is `{ requestId, preparation, gitReceipts, outcome, publication }`.
Its preparation has the full shape and disclosure rules above. The three kinds
of evidence are independent:

| Field | Variants and meaning |
| --- | --- |
| `gitReceipts` | Completed primitives only: `{ stage: "commit", commitHash }` or `{ stage: "push", pushedSha }`. Missing receipt means missing completion evidence, not proof of no effect. |
| `outcome` | `{ status: "not-attempted" }`; `{ status: "created"|"reused", review }`; `{ status: "failed", stage, code, message }`; or `{ status: "uncertain", stage, message }`. `code` may be null; stage uses the three qualified action spellings. |
| `publication` | `{ state: "included"|"local-ahead"|"diverged", localHeadSha, remoteSourceSha }`; `{ state: "remote-branch-missing", localHeadSha }`; or `{ state: "unknown", localHeadSha, remoteSourceSha }`. SHAs may be null in the last two variants. |

`not-attempted` can accompany a successful commit/push-only call. A permitted
refusal before a consuming stage claim can retain a failed outcome for that
stage, preserving earlier receipts. Known commit/push/review completion is
recorded at the primitive before later bookkeeping or reply delivery. A later
failure or disclosure refusal does not erase it. Legacy `steps`/`result` retain
completed Git stages (`commitHash`, `pushedSha`) and observed review
`prNumber`/`prUrl` even if another stage fails; `success: false` does not imply
rollback. An ambiguous or lost provider write remains uncertain, without
automatic retry. Later matching provider state cannot establish that the old
operation created it.

An observed `review` has required `resource`, `url` and `title`, and nullable
`body`, `state`, `draft`, `sourceBranch`, `targetBranch`, `source`, `target`,
`author`, `mergeable`, `mergeableState`, `headSha`, `createdAt`, `updatedAt`.
Resource is `{ repository, kind: "merge-request", number }`. Confirmed state is
`open|locked|closed|merged`; unknown state/draft remains null. Branch identity is
null as a whole or `{ provider, instanceBaseUrl, projectId, projectPath, branch }`,
where `projectPath` may be null. These are provider observations, not values
filled from a submitted title/body or selected branch. Nonempty normalized
authors, including literal `ghost`, are retained; empty becomes null, without
asserting raw author presence. Publication requires actual source-ref evidence:
a review head SHA, successful create/push or different SHAs alone cannot prove
inclusion, local-ahead or divergence.

**Ownership, limits and failures.** One original execute frame claims one
immutable command before queueing. An identical repeat observes that attempt;
a changed command is invalid. Cancellation, timeout or release retires future
admission, while an already-owned worker keeps its worktree lock and capacity
until actual completion. Retained effects and current permission to disclose
them are separate. Reconcile/release never rebind to another socket, host, caller
or root; loss before a known receipt leaves uncertainty, not safe write replay.
There is no durable cross-socket receipt lookup.

| Bound | Meaning |
| --- | --- |
| 32 records/socket; 256 per Services instance | Retained original operations |
| 2 active jobs/socket; 8 per Services instance | Original acquisition/execution work, held through actual completion |
| 64 queued notices; 64 observations/operation | Private feed and repeat-execute/reconcile budget |
| 65,536 bytes | Serialized qualified command bound |
| 5 seconds | Acquisition response and individual private-notice send budgets |
| 15 seconds | Fixed deadline from the original execute frame until its **first successful consuming stage claim**, including queue/source/lock waits; it is not restarted at a wait or source observation |
| 120 seconds | Retirement timer for an entered stage; after the first claim, the old 15-second queue alarm cannot retire that admitted work |
| 360 seconds | Execute's observation wait before returning pending if it can still disclose; earlier lifecycle/transport refusal remains possible |
| 300 seconds | Original write lease; stable prepared facts do not renew it |
| 600 seconds | Receipt retention measured from **actual settlement**, subject to original disclosure authority |

Create-stage lock waiting also has a separate 15-second bound. No timer proves
worker completion: admitted work is joined before its capacity/lock is released.
Server checks at entry, each stage and consuming reply remain authoritative;
neither notification delivery nor an unexpired preparation guarantees admission.

Malformed strict decoding returns `-32602`, message
`Invalid native review parameters`, data `{ code: "invalid-params" }`.
Unsupported/changed Services parameters use the same code/data with message
`invalid params: Unsupported or changed native review parameters`. Original
ownership/unavailability refusal is sanitized:

```json
{"jsonrpc":"2.0","id":154,"error":{"code":-32003,"message":"Forbidden","data":{"code":"forbidden","detail":"Repository review unavailable"}}}
```

Unchanged connection/transport permissions can still return their existing
errors. A settled failed/uncertain execution is data, distinct from these RPC
errors. Use the [private feed](../06-events.md#private-native-review-retirement)
and [client lifecycle](../10-thin-client.md#native-review-lifecycle)
to preserve receipts without treating a stale handle as new authority.

#### Commit companion preparation

**Prepared additive contract.** This adds an opt-in, separately confirmed
create after a staged-only commit. It requires the original physical
connection's [`nativeReviewCompanion: 1` capability](client-hello.md#commit-companion-capability)
alongside `nativeReview: 1`. This extends the existing qualified operations;
it adds no method or public eligibility field. The native-review contract above
still governs unmarked requests, responses, permissions and errors. Ordinary
unqualified behavior, including GitHub, remains unchanged. This describes
conditional admission, not a frontend rollout or deployed provider guarantee.

**Marked parent preparation.** Use `action: "commit"` and
`review.companion: { kind: "create-pr" }`, with the existing explicit root and
`saved` or `explicitTarget` project choice. `targetBranch` is required and must
be a nonempty, valid branch different from the original source branch, already
present in the same ready GitLab project. The server validates that intended
target before the commit. Outer `files` and `options`, and `review.pushRemote`,
must be **absent**, including null; even `options: {}` is invalid. This commits
only already-staged changes, without staging unstaged files, pushing or creating
a review. A null/unknown companion, wrong action or unknown nested field is
rejected without falling back to an ordinary request.

The following illustrative request assumes the source branch differs from the
validated remote target `trunk`. Its public fields confer no authority:

```json
{"jsonrpc":"2.0","id":160,"method":"accept-changes.prepare","params":{"workspaceId":"ws-example","action":"commit","review":{"root":{"workspaceId":"ws-example","kind":"primary"},"choice":{"kind":"saved"},"targetBranch":"trunk","companion":{"kind":"create-pr"}}}}
```

After separate user confirmation, use the unchanged text-only execute shape.
Here `00000000-0000-4000-8000-000000000001` represents the returned parent
operation; no target, files or flags are resubmitted:

```json
{"jsonrpc":"2.0","id":161,"method":"accept-changes.execute","params":{"workspaceId":"ws-example","action":"commit","review":{"operationId":"00000000-0000-4000-8000-000000000001","root":{"workspaceId":"ws-example","kind":"primary"}},"commitMessage":"Record the staged changes"}}
```

**Fresh child preparation.** Only after eligible completion and original reply
transfer may the retained original main-process session construct
`choice: { kind: "afterCommit", operationId, captureId }` on that same socket.
`operationId` identifies its marked parent; `captureId` identifies the one capture
owned by that session. Both are canonical lowercase, hyphenated, 36-character
UUID strings, not execution grants. The child action must be `create-pr`.
Outer `files`/`options` and `review.targetBranch`/`pushRemote`/`companion` must be
**absent**, including null. The original target is inherited privately. Account,
SHA, path, display text and other unknown preparation fields are not accepted.
These presence rules are stricter than the older unmarked forms' null defaults.

```json
{"jsonrpc":"2.0","id":162,"method":"accept-changes.prepare","params":{"workspaceId":"ws-example","action":"create-pr","review":{"root":{"workspaceId":"ws-example","kind":"primary"},"choice":{"kind":"afterCommit","operationId":"00000000-0000-4000-8000-000000000001","captureId":"00000000-0000-4000-8000-000000000002"}}}}
```

The child has its own returned operation, preparation, lease and receipt. Confirm
it separately before executing the unchanged text-only create command, using the
child's ID, not the parent's. For example, if that ID is
`00000000-0000-4000-8000-000000000003`:

```json
{"jsonrpc":"2.0","id":163,"method":"accept-changes.execute","params":{"workspaceId":"ws-example","action":"create-pr","review":{"operationId":"00000000-0000-4000-8000-000000000003","root":{"workspaceId":"ws-example","kind":"primary"}},"prTitle":"Review the staged changes","prBody":"Review the separately prepared change."}}
```

The existing `reviewOperation`, `reviewPreparation`, `reviewExecution`, bound
reconcile/release and private-notice shapes are unchanged. There is no returned
companion-eligibility boolean or new `captureId` response field. The child's
`gitReceipts` do not copy the parent's commit. Neither request implicitly pushes;
the committed local branch may remain `local-ahead` of the provider source.
Unmarked commits and independently prepared creates do not acquire this link.

**Eligibility is separate from the receipt.** The backend requires the actual
primitive commit SHA, successful original helper/classification and attribution,
a matching index and witnessed post-state under the original worktree lock,
normal owned completion with worker capacity released, and an eligible successful
**original guarded reply transfer**. A known commit or a success-looking result
alone is insufficient. Pending, abandoned, uncertain, failed-after-commit or
unavailable post-state cannot establish continuation eligibility. Retained
effects, permission to disclose them and client observation remain independent;
successful server transfer does not prove the client received it.

The original opt-in reply attempt is reserved synchronously before its delivery
future can await guards. Refusal, cancellation or overlapping attempts cannot
reopen eligibility after that attempt is lost. Reconciliation can disclose the
original historical receipt under current authority; it cannot mint a replacement
grant, infer success from current HEAD or replay the write. Preserve known effects
even if attribution, later bookkeeping or disclosure prevents a child.

**Private continuity and new authorization.** Child acquisition, publication and
stage entry check the original root/path/incarnation, Git directories/source ref,
selection binding/revision, private provider/project/account generation,
configuration, effective destinations and intended target. Only the parent's
witnessed HEAD advance is allowed. Full private Git/index observations occur in
the owned locked worker before the consuming comparison; that comparison adds no
I/O, await or extra queue. Current original Member/workspace and credential checks
remain authoritative, with administrator-only public connection disclosure
checked separately at final transfer. Public IDs, account data or known SHAs
cannot replace those checks. Observation equality is not a mutation journal and
cannot rule out a wholly unobserved change followed by restoration.

**One capture and distinct leases.** There is one backend capture per parent,
including identical or concurrent duplicate requests. A failed capture keeps its
claim as a tombstone. Coalesce client-local duplicates to the original promise;
do not retry a capture, renew it or create a grandchild. The parent's intent lasts
300 seconds from original operation creation. Child acquisition **and reply
publication** must finish before that fixed deadline. A published child receives
its own fixed 300-second lease from publication; parent expiry alone does not
expire it. Explicit parent release, context/authority or socket loss still retires
linked future admission. Already-admitted work remains owned through completion.

The existing bounds still apply: 32 records/socket and 256/Services instance;
2 workers/socket and 8/Services instance; 64 notices and 64 observations/operation;
65,536-byte commands; 5-second acquisition/notice budgets; 15-second first-stage
admission, 120-second entered-stage retirement and 360-second execute observation;
600-second receipt retention from actual settlement. None proves worker termination
or rollback. Malformed forms retain `-32602`; original ownership/unavailability
retains the sanitized `-32003` refusal described above. Missing original receipts
remain uncertain. See the [companion retirement rules](../06-events.md#commit-companion-retirement)
and [client obligations](../10-thin-client.md#commit-companion-lifecycle).

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
| metrics.getAgentStats | agentId (req), workspaceId? | Metrics \| null — `{ additions, deletions, filesChanged }` for one agent (`byAgent` omitted) |

```json
// → request
{ "jsonrpc":"2.0","id":52,"method":"metrics.getAgentStats","params":{ "agentId":"agent-123", "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "additions":140,"deletions":12,"filesChanged":3 } }
```
