> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.7 `pr.*` · §5.42 Centralized PR monitoring (`prMonitor.*`).

### 5.7 `pr.*`

The namespace holds the **two** workspace/active-PR-scoped methods that survived the v5.0 removal: `pr.status` (requires an active pull request on the workspace — otherwise the underlying service throws → `-32603`) and `pr.refresh` (exists to establish/repair the link and works without one — see its semantics note below).

> Host-agnostic naming. `pr.*` is the canonical wire name. Conceptually it is host-agnostic — "PR" covers pull request / merge request / change request — and in v1 it is backed by GitHub (selected via the sourceControl.activeProvider setting, §5.12). Future forges (GitLab, Bitbucket) plug in behind the same pr.* surface.

> **Removed in v5.0 ([intent-hq/intentd#921](https://github.com/intent-hq/intentd/pull/921); monorepo#1506).** The 11 other `pr.*` methods — `pr.capabilities`, `pr.createReview`, `pr.getReviews`, `pr.listCheckRuns`, `pr.listComments`, `pr.listReviewComments`, `pr.merge`, `pr.postComment`, `pr.replyToReviewComment`, `pr.resolveThread`, and `pr.updateBranch` — were left caller-less after agent GitHub workflows moved to the `gh` CLI and the `ws.pr.*` MCP surface shrank to snapshot-only ([intent-hq/intentd#918](https://github.com/intent-hq/intentd/pull/918)), and are deleted from the wire (calling one returns `-32601` Method not found — same precedent as the v3.0 `pr.waitForChanges` removal). The v2.1 provider capability gating went with them (no gated `pr.*` operation remains). Equivalent PR read/write operations live on the explicit-addressing `github.*` surface (§5.27 — e.g. `github.pulls.merge`, `github.pulls.updateBranch`, `github.getReviewThreads`, `github.listReviewComments`, `github.replyReviewComment`, `github.resolveThread` / `github.unresolveThread`); agents use `gh` on the host plus the read-only MCP `ws.pr.snapshot` binding (below).

| Method | Params | Result |
| --- | --- | --- |
| pr.status | — | { prNumber, title, url, state, mergeable, mergeableState, hasConflicts, isDraft, isMerged, isClosed, summary } |
| pr.refresh | — | { outcome: "skipped" \| "unchanged" \| "linked" \| "updated" \| "unlinked", prNumber: number \| null, prUrl: string \| null, prStatus: string \| null, pullRequests: PullRequestInfo[] } — the post-refresh linkage state. Forces the same PR discovery/refresh the daemon's background sweep runs for one workspace, on demand |

> **`pr.refresh` semantics.** Unlike `pr.status`, `pr.refresh` does **not** require an
> active PR — it exists to establish/repair the link. It runs the shared refresh path
> (discovery, status update, stale-link clearing, relink-after-merge), so any
> resulting `pr:linked` / `pr:updated` / `pr:unlinked` events (§6.5) are emitted **once** by
> that path — the RPC adds no duplicate emission. The matching rule is **branch OR baseRef**:
> a PR matches a workspace when its head ref equals the workspace's own `branch`, or when it
> matches the workspace's `baseRef` (raw equality, plus the known-remote-prefix-stripped
> remainder for legacy rows persisted before write-side canonicalisation — see `baseRef`
> canonicalisation, §5.1), so review workspaces created *for* a PR link it via `baseRef`.
> Discovery (and relink-after-merge) queries by the workspace's own branch head first —
> branch match takes precedence — then falls back to one open-PR query per baseRef
> candidate (the raw stored `baseRef` plus, when it differs, its known-remote-prefix-
> stripped remainder); when several PRs match, the highest PR number wins. A stale link is
> cleared only on a **positive mismatch**: the linked PR's head ref is known, at least one
> of the workspace's `branch` / `baseRef` is known, and every known field fails to match —
> unknown inputs never unlink. This intentionally deviates from the FE guard
> (which only cleared a stale link when the workspace's own branch was present): a
> branch-less workspace whose `baseRef` positively mismatches the linked PR's head **does**
> unlink. Ineligible workspaces (remote, archived, without a repo, or — when no PR is
> linked — with neither a branch nor a baseRef) return `outcome: "skipped"` rather than
> erroring.
> Unlike the usual omitted-when-absent (`skip_serializing_if`) convention, `prNumber` /
> `prUrl` / `prStatus` are always present and serialize as literal `null` when no PR is
> linked after the refresh; `pullRequests` is always an array (possibly empty). An unknown
> `workspaceId` → `-32602 "Workspace not found"`.

```json
// → request — the active PR's status
{ "jsonrpc":"2.0","id":40,"method":"pr.status","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":40,"result":{ "prNumber":12,"title":"Add review wire surface",
  "url":"https://github.com/octo/repo/pull/12","state":"open","mergeable":true,
  "mergeableState":"clean","hasConflicts":false,"isDraft":false,"isMerged":false,
  "isClosed":false,"summary":"..." } }
```

> **`ws.pr.snapshot(prNumber, { repo? })` — agent MCP binding *(new in intentd,
> [intentd#887](https://github.com/intent-hq/intentd/pull/887); repo override + echo
> [intentd#911](https://github.com/intent-hq/intentd/pull/911))*.** Since
> [intentd#918](https://github.com/intent-hq/intentd/pull/918) the snapshot is the
> read-only one-shot `ws.pr.*` MCP binding: agent GitHub workflows are **`gh`-CLI-based**
> (PR creation, status/checks, reviews, comments, thread resolution, branch updates, and
> merging all go through `gh` on the host). Since v6.1 the `ws.pr.*` family also carries
> the monitoring bindings `ws.pr.monitor` / `ws.pr.unmonitor` / `ws.pr.monitors` (§5.42)
> — for PR *watching* agents prefer `ws.pr.monitor` (daemon-run polling, no TTL);
> the snapshot survives as the current-state-once read and remains usable from
> **hook-based PR monitoring**
> (§5.40): a hook calls it each run, compares the result against the previous run's
> carry-over `hookState`, and dispatches only on meaningful change. There is **no wire
> method** (MCP-only, per the §6.8 principle — PR watching is agent-authored background
> work; FE clients keep using `pr.status` and the explicit-addressing `github.*` reads, §5.27).
> `prNumber` is **required** (a positive number —
> missing, non-numeric, or `<= 0` values are rejected with a validation error) and
> there is **no active-PR fallback**: the snapshot is scoped to the workspace's
> repository unless `repo: "owner/name"` overrides it (e.g. a submodule's repo), and
> the result echoes the resolved `repo` so a wrong-repo read is detectable.
> Result shape: `{ repo, prNumber, title, url, state, isDraft, isMerged, isClosed, headSha,
> updatedAt, mergeable, mergeableState, mergeBlockedReason, checks: { total, passed,
> failed, pending, failedNames }, reviews: { decision, approvals, changesRequested },
> comments: { conversationCount, reviewCommentCount, unresolvedThreadCount,
> totalCount }, requirements: MergeRequirements }`. **`requirements`** *(additive in v6.1,
> [intentd#989](https://github.com/intent-hq/intentd/pull/989))* is the full
> merge-requirements checklist (§5.42 — "what is still needed to merge this PR"), the
> SAME canonical object `ws.pr.monitor` returns (its `requirements` result field) and
> the monitor loop's change detection diffs — `ws.pr.monitors` rows carry only the
> reduced `lastSnapshot` summary of it (§5.42), and monitor wakes carry the derived
> change lines; the top-level `checks` / `reviews` / `comments` blocks are the compact
> projection of the same read. `mergeBlockedReason` is a human-readable
> reason and is non-`null` exactly when the PR is open (draft included) and cannot be
> merged. `checks` tallies the runs on the PR head (SHA, else source branch); a
> provider without the `checkRuns` capability — or a PR whose head cannot be
> determined — reports an empty tally rather than failing the snapshot.
> **`reviews.decision`** *(changed in intentd,
> [intentd#942](https://github.com/intent-hq/intentd/pull/942);
> [intent-hq/monorepo#1524](https://github.com/intent-hq/monorepo/issues/1524))*
> is derived from the forge's authoritative review-requirement verdict (GitHub's
> GraphQL `reviewDecision`) when available: `approved`, `changes_requested`, or
> `review_required` (the last only for an open PR, draft included) map directly.
> When the provider signal is unavailable — no review requirement configured on
> the base branch, a host without the capability, or a failed fetch — the
> decision falls back to the aggregated actionable reviews; a provider
> `review_required` on a merged/closed PR is likewise discarded and falls back
> to the aggregate. That fallback yields `changes_requested`,
> else `approved`, else `none`; the fallback path never yields
> `review_required`. REST `mergeable_state` is **no longer consulted** for this
> field — its `blocked` value conflates required checks, merge queues, and
> token-access gaps with an actual review requirement, and previously caused
> `review_required` to appear on PRs with no reviews or requirement at all.
> `comments.reviewCommentCount` counts every inline thread comment **including
> replies** (threads come from GraphQL when available, else the REST list
> grouped by reply parent), and `totalCount = conversationCount +
> reviewCommentCount`, so a new reply anywhere moves the counter a hook can
> diff. `comments.unresolvedThreadCount` reflects real per-thread resolution
> state from the GraphQL threads; on the REST fallback (grouped by reply parent)
> no resolution state is available, so every thread counts as unresolved — that
> fallback is logged at warn level with the underlying GraphQL error
> *(intentd, [intentd#949](https://github.com/intent-hq/intentd/pull/949))*.

### 5.42 Centralized PR monitoring — `prMonitor.*` *(v6.1)*

Centralized PR monitoring ([intent-hq/intentd#989](https://github.com/intent-hq/intentd/pull/989)): an agent registers a **daemon-run monitor** on a PR via the MCP `ws.pr.monitor` binding, and one shared daemon loop polls every active monitor (every `prMonitor.pollSeconds`, §5.12, read live, floor 10s), diffs a **merge-requirements checklist** against the monitor's persisted **emit baseline** — the PR state as of the last delivered wake (or registration) — and wakes the owning agent with a **single consolidated, debounced notification** once the PR has been quiet for `prMonitor.debounceSeconds` (§5.12) — a busy PR that never goes quiet still gets its wake via the max-latency bound (5 debounce windows since the oldest un-emitted change; late, never starved — conditional on the coalesced set staying continuously non-empty: a full revert empties the set and re-arms the clock, by design). The pending set is a **coalesced net diff, recomputed against the emit baseline on every poll — never an accumulated log**: a field that moved A→B→C reports one initial→final line, a field that reverted to its baseline value drops out of the set, and a PR that fully reverts within the debounce window empties the set — nothing pending, debounce anchors reset, **no wake sent**. Each delivered wake advances the baseline to the delivered snapshot, so the next wake reports only what moves from there; a merged/closed PR terminalizes the monitor with an immediate, undebounced final wake (state `completed` — the row is retained so merged PRs stay visible) whose "changes since the last report" section coalesces the same way. Monitors are persisted (SQLite `pr_monitor` table), **survive daemon restarts** via boot rehydration with catch-up delivery (the net diff against the pre-restart baseline fires on the first post-restart poll — only when non-empty), and have **no TTL** — this is why agents are steered to `ws.pr.monitor` over a self-authored §5.40 snapshot-diffing hook. Store writes are guarded compare-and-swap, so concurrent flush / cancel / re-register / poll never clobber each other. Safe when source control is unconfigured (the tick logs and returns).

**Registration is MCP-only** (per the §6.8 principle — PR watching is agent-authored background work; the same split as `hook.*` vs `ws.hook.schedule`): `ws.pr.monitor(prNumber, { repo? })` registers (or idempotently re-arms, refreshing the baseline — never a second monitor) the caller's monitor, scoped to the workspace repo unless `repo: "owner/name"` overrides it, and returns `{ ok, monitor, requirements }`; active monitors are capped at 5 per agent (`-32602`-style validation error beyond the cap). `ws.pr.unmonitor(prNumber, { repo? })` cancels the caller's **own** active monitor (unknown/foreign PR → not-found error; an owner's own cancel never self-wakes). `ws.pr.monitors()` lists the caller's active and completed monitors. The three bindings are gated by `agentFeatures.prMonitor` (§5.12).

The **wire surface is read/cancel/flush only** (the FE view over agent-owned monitors):

| Method | Params | Result |
| --- | --- | --- |
| prMonitor.list | workspaceId | { monitors: PrMonitor[] } — the workspace-wide view (every agent's monitors); `cancelled` rows are excluded, `completed` rows retained so merged PRs stay visible |
| prMonitor.cancel | workspaceId, monitorId | { ok, monitor } — cancels **any** monitor in the workspace by id and wakes the owning agent with a cancellation notice (unlike the agent's own `ws.pr.unmonitor`, which never self-wakes — the same one-directional visibility as `hook.cancel`, §5.40) |
| prMonitor.flush | workspaceId, monitorId, check? | { ok, flushed } — delivers a monitor's pending consolidated wake **now**, bypassing the remaining debounce window; `flushed: false` when nothing was pending (a no-op, not an error). `check?: boolean` *(additive; default `false`)* — when `true`, the daemon first performs an **immediate on-demand poll** of that one monitor (fresh snapshot fetched from the forge, coalesced pending set recomputed against the emit baseline through the same guarded CAS write as the loop, terminalizing with the final wake if the PR merged/closed), then flushes whatever is pending — so the flush covers changes the poll loop has not seen yet; the recomputed set being empty returns `flushed: false` with no wake. A forge fetch failure during the check records the monitor's `lastError` (baseline untouched) and returns an error. Omitting `check` (or `false`) preserves the pre-check semantics exactly; a non-boolean value is `-32602` |

**`PrMonitor` wire shape** (shared by `prMonitor.list`, the `ws.pr.monitor` / `ws.pr.unmonitor` results, and `ws.pr.monitors` rows): `{ monitorId, workspaceId, agentId, repo, prNumber, state, pendingChanges, hasPendingChanges, createdAt, updatedAt, pendingSince?, lastChangeAt?, lastPolledAt?, lastError?, title?, url?, lastSnapshot? }` — `repo` is the combined `"owner/name"` string; `state ∈ { active, completed, cancelled }`; `pendingChanges` is the human-readable **net** change lines since the last delivered wake — the coalesced diff against the emit baseline, recomputed each poll (awaiting the debounce window; it shrinks or empties when changes revert; `[]` when nothing is pending); `lastError` is the most recent forge-poll error (cleared by a successful poll — a failing poll never kills the loop); `title` / `url` / `lastSnapshot` are present once the monitor has a successful poll baseline, `lastSnapshot` being the last-refresh checklist summary `{ state, isDraft, hasConflicts, isBehind, mergeable, mergeBlockedReason, checks: { total, passed, failed, pending, failingRequired, pendingRequired, requiredKnown }, approvals: { decision, have, needed, changesRequested }, threads: { unresolved, resolutionRequired }, isInMergeQueue?, mergeQueueEjection?, rulesKnown }`.

**`MergeRequirements` checklist** — "what is needed to merge this PR", the reusable object backing `ws.pr.monitor` (the `requirements` result field), the monitor loop's change detection, and the additive `requirements` block on `ws.pr.snapshot` (§5.7) — one canonical shape across all three surfaces. Shape: `{ state, isDraft, hasConflicts, isBehind, mergeable?, checks: { total, passed, failed, pending, items: [{ name, status, required, url? }], failingRequired, pendingRequired, requiredKnown }, approvals: { decision, have, needed?, changesRequested }, threads: { unresolved, resolutionRequired? }, mergeStateStatus?, mergeBlockedReason?, isInMergeQueue?, mergeQueueEjection?, rulesKnown }`. `state` is the 4-value lifecycle word; `mergeable` is the forge's tri-state (omitted while still computing); each `checks.items[]` entry reports `status ∈ { passed, failed, pending }` and its own `required` flag, with `failingRequired` / `pendingRequired` naming the required checks that are failing/still running; `approvals.decision` is the §5.7 `ws.pr.snapshot` decision wire word, `have` counts distinct approving reviewers, `needed` the base branch's required approvals; `mergeStateStatus` is the host's raw merge-state status (GitHub GraphQL `mergeStateStatus`) — the residual signal for rules with no finer detail (merge queue, signed commits, hooks); `isInMergeQueue` is additive and presence-detected per the protocol's additive-field convention: `true` exactly when the host reports the PR queued in its merge queue (GitHub GraphQL `isInMergeQueue`), and the key is omitted (never null) when not queued or unknown; `mergeQueueEjection` *(additive, presence-detected under the same convention)* is the PR's **latest merge-queue removal event** as `{ at, reason? }` — `at` is when the queue ejected the PR (GitHub GraphQL `RemovedFromMergeQueueEvent.createdAt`, RFC 3339) and `reason` the host's raw removal reason (e.g. `failed_checks`; omitted when the host reports none) — with the key omitted when the host reports no removal event; the monitor loop's diff keys its ejection line on the event identity (`at`) and humanizes the reason (underscores → spaces), so an enter→eject pair that nets out on `isInMergeQueue` within one window still reports "removed from the merge queue (failed checks)". Degradation is **per-signal, never fatal**: a host that reports no check rollup yields `checks.requiredKnown: false` (every `required` flag `false`, tallies fall back to the REST check runs), unreadable branch rules yield `rulesKnown: false` with `approvals.needed` / `threads.resolutionRequired` omitted, and a fully failed probe still produces the state / conflicts / approvals / threads rows from the snapshot alone.

**Wake deliveries** ride the automatic `agent.sendMessage` path (queued behind an in-flight turn, never interrupting) and tag the persisted user block with `messageMetadata { type: "pr_monitor_wake", monitorId, repo, prNumber, reason, url? }` — `repo` is the combined `"owner/name"` string, `reason ∈ { changed, completed, cancelled }` names why the owner was woken (the consolidated change emit — debounce elapsed, max-latency bound, restart catch-up, or a `prMonitor.flush` —, the PR-merged/closed final wake, or an FE `prMonitor.cancel` notice), and `url` *(additive, presence-detected)* is the PR's HTML URL read off the monitor's persisted baseline snapshot — the key is **omitted** (never `null`) when the monitor has no baseline yet.

Lifecycle is observable via the `prMonitor:*` event category (§6.5), and each agent's per-turn snapshot lists its active monitors (one `"owner/name#number"` label per monitor, suffixed `" (changes pending)"` while a debounced emit is accumulating).

**Idle-visibility & completion-watch deferral (unified external-wait, v6.2; [intent-hq/intentd#1002](https://github.com/intent-hq/intentd/pull/1002), [intent-hq/intentd#1007](https://github.com/intent-hq/intentd/pull/1007)).** An agent's ACTIVE PR monitors are surfaced the same way as its active background hooks (§5.40): the light `waitingOnPrMonitors?: [{ monitorId, repo, prNumber, title? }]` list on `agent:idle` (§6.5), the `AgentLite` projection (§5.5), and `agent.diagnostics` agent rows — and completion-watch / `after_all` settlement defers on such an idle exactly like the hook-waiting case (§Completion-watch persistence), with one key difference: PR monitors have **no TTL**, so the deferral is unbounded except by the monitor's own terminal transitions (complete, owner `ws.pr.unmonitor`, external `prMonitor.cancel`, the `workspace.archive` sweep cancel — §5.1 archive active-work teardown, [intent-hq/intentd#1067](https://github.com/intent-hq/intentd/pull/1067) — or owner-gone restart rehydration).

```json
// → request — the FE's workspace-wide monitor list
{ "jsonrpc":"2.0","id":99,"method":"prMonitor.list","params":{ "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":99,"result":{ "monitors":[ {
  "monitorId":"prm-1","workspaceId":"ws-abc","agentId":"agent-1",
  "repo":"octo/repo","prNumber":12,"state":"active",
  "pendingChanges":["check ci: pending → failed"],"hasPendingChanges":true,
  "pendingSince":"2026-08-07T12:00:00.000Z","lastChangeAt":"2026-08-07T12:00:00.000Z",
  "lastPolledAt":"2026-08-07T12:00:30.000Z","title":"Add review wire surface",
  "url":"https://github.com/octo/repo/pull/12",
  "lastSnapshot":{ "state":"open","isDraft":false,"hasConflicts":false,"isBehind":false,
    "mergeable":true,"mergeBlockedReason":"1 required check failing (ci)",
    "checks":{ "total":3,"passed":2,"failed":1,"pending":0,
      "failingRequired":["ci"],"pendingRequired":[],"requiredKnown":true },
    "approvals":{ "decision":"approved","have":1,"needed":1,"changesRequested":0 },
    "threads":{ "unresolved":0,"resolutionRequired":true },"rulesKnown":true },
  "createdAt":"2026-08-07T11:58:00.000Z","updatedAt":"2026-08-07T12:00:30.000Z" } ] } }

// → request — deliver the pending consolidated wake now
{ "jsonrpc":"2.0","id":100,"method":"prMonitor.flush","params":{
  "workspaceId":"ws-abc","monitorId":"prm-1" } }
// ← response
{ "jsonrpc":"2.0","id":100,"result":{ "ok":true,"flushed":true } }

// → request — re-poll the PR on demand first, then flush (check-and-flush)
{ "jsonrpc":"2.0","id":101,"method":"prMonitor.flush","params":{
  "workspaceId":"ws-abc","monitorId":"prm-1","check":true } }
// ← response — nothing changed vs. the emit baseline: no wake
{ "jsonrpc":"2.0","id":101,"result":{ "ok":true,"flushed":false } }
```

