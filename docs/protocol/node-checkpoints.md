# Phase 1 hub and checkpoint contract (prepared)

These are future requirements for [node execution](./methods/nodes.md); none is
an executed assertion about the current transfer code. The transfer implementation
provides the existing WIP/index/submodule representation, but its current
`snapshot_wip` mutates live HEAD/index and then unwinds them. Periodic checkpointing
must extract a non-mutating codec instead of calling that helper on a running tree.

## Repositories, refs and checkout creation

Head stores one bare hub per canonical repo identity (forge provider, host,
owner/repository; not merely `owner/repo`). Disk key is an opaque hash of that
identity, avoiding collisions across forges and unsafe path components. Each hub
may borrow objects through alternates from the **head-local** repo cache. GC/cache
eviction must preserve borrowed objects reachable from any live checkpoint or
dissociate them first. A node has its own cache/alternates; no filesystem path or
alternates file is shared across machines.

```text
refs/heads/*                                             head-only forge mirror
refs/intent/ws/<ws>/agents/<agent>/head                   committed tip
refs/intent/ws/<ws>/agents/<agent>/wip                    synthetic dirty snapshot
refs/intent/checkpoints/<checkpoint>/<repo>/head         immutable recovery anchor
refs/intent/checkpoints/<checkpoint>/<repo>/wip          immutable recovery anchor
refs/intent/checkpoints/<checkpoint>/<repo>/index        immutable index anchor
refs/intent/publish/<branch>                             head-only publication
```

`git-remote-intent` is the Git remote helper for `intent://hub/<repoKey>/<workspaceId>
/<agentId>` URLs. This private scheme is unrelated to UI navigation links. The
helper authenticates to the node-local service with its agent capability, then
transports smart Git bytes over the node link. Head checks both reads and writes:
exact workspace/agent/repo assignment and reachable granted object/ref closure.
No arbitrary SHA fetch, sibling enumeration, symbolic ref escape, base/publish
write or unscoped receive-pack is allowed. A parent merge gets a temporary explicit
read grant for the child's chosen refs. Nodes upload objects into quarantine and
request scoped agent ref updates with expected-old-OID checks; only head finalizes
checkpoint/publication refs. No public Git server is opened.

Before spawn head refreshes its base mirror and records the fork base and merge
target. For an isolated delegated child, capture a fresh successful parent
checkpoint under the capture barrier and pin it as the immutable **inherited
baseline**. Hydrate its committed history **and dirty worktree contents**, including
staged, unstaged, untracked and initialized submodule work, on either local or
remote placement. Do not silently use an older checkpoint when the requested
parent state cannot be captured: fail provisioning without delivering the first
message. Parent HEAD, index bytes, worktree and attribution remain untouched.
Starting a fresh node process/image does not preclude hydrating Git WIP; no live
VM snapshot fork is needed. The node hydrates a separate checkout
from its own cache/forge and fetches any missing objects/agent delta from hub.
Base objects are preferably fetched directly, but **may cross the node link** when
unpublished or unavailable from the forge; correctness cannot assume otherwise.
Recursively hydrate granted submodule repos before the first-message gate settles.
The [private preparation lifecycle](./node-link.md#private-preparation-lifecycle)
also requires verified checkpoint-bound attachment materialization before ready;
missing or unauthorized attachments fail preparation, not a later provider turn.
Validate inherited/prior-run source selection through its authorized provenance
separately from the target's same-owner staged-assignment check. Serializable
checkpoint metadata and a manifest hash are data, not source or execution
capabilities; resolve them through owned staging/source validation. Never require
the parent source identity to equal the child run, or widen the target check to
accept arbitrary cross-agent input. Fresh children use a new provider session.
Local isolated checkout uses clonefile/FICLONE from the repo cache where supported;
otherwise use a standalone Git clone with local alternates. Reflink failure never
changes requested isolation to shared. Shared local agents keep today's checkout.

### Inherited baseline and child-owned changes

Each child's repository entry pins `inherited: { sourceAgentId, checkpointId,
executionBase }`. The source checkpoint retains the parent's original `head`,
index tree, WIP tree, submodule gitlinks and attribution, so inherited edits keep
their original ownership and staged/unstaged/untracked provenance. `forkBase`
names the source committed head. `executionBase` is that head when clean, otherwise
a private synthetic snapshot commit containing the captured worktree tree. Child
HEAD and index initially point to this execution base, with matching files; like
the existing CoW sandbox, the child sees inherited file contents as its starting
baseline, not newly staged/dirty work of its own. The parent's original index
split is retained in the source checkpoint, not rewritten on the parent or charged
to the child. The child starts a new provider session, not the parent's session.

Build initialized submodule execution bases before their containing repository.
The containing synthetic tree points to those execution bases, while the immutable
source checkpoint preserves the original gitlink/index values. Record the mapping
through each submodule's inherited entry; purely synthetic gitlink substitutions
are initialization, not child changes. Only the child-owned delta after this base
is eligible for attribution, merge-back and publication. A child with no new work
has an empty merge delta even when it inherited dirty files. Parent baseline
checkpoints and their transitive inherited references remain pinned until all
dependent children, recovery and merge/publication operations release them.

Merge-back replays the child's authored commits **after executionBase**, preserving
authors/messages, onto the target's current committed history. Never merge the
synthetic baseline itself or use the full forkBase-to-child diff: that would claim
the parent's WIP. Independently changed submodule commits are replayed before
rewriting the child's changed gitlinks to their resulting real OIDs. Baseline-only
gitlink substitutions are excluded. Existing dirty-target overlap protection still
applies; a child extending inherited work that the parent has not committed may
remain blocked until that overlapping parent work is settled. An unrelated child
commit can merge while unrelated inherited parent dirt remains unchanged.

Synthetic baseline ancestry also cannot reach the forge. Publication normalizes
private history by replaying authored deltas after each inherited execution base
onto its source's normalized committed history (recursively for nested delegation,
then submodules first), excluding all synthetic baseline/WIP/index-anchor commits.
Preserve author/message attribution and record old-to-new commit/gitlink mappings;
published OIDs may differ from private child OIDs. If a delta needs inherited WIP
that is absent from that committed history, return `inherited-baseline-required`
without a push. Settle the parent work and merge the child into that parent, then
publish the resulting parent checkpoint; never silently publish inherited dirt.

## Manifest v1 and consistent capture

A successful checkpoint has a UUID `checkpointId`, a manifest in head's durable
content store and immutable Git/blob anchors. Below is the JSON shape (OID/hash
strings in this illustrative schema stand for full validated values):

```json
{
  "formatVersion": 1,
  "checkpointId": "<uuid>",
  "workspaceId": "ws-1",
  "agentId": "agent-1",
  "leaseId": "lease-1",
  "incarnation": "<uuid>",
  "runId": "<uuid>",
  "assignmentEpoch": "3",
  "captureRevision": "8",
  "capturedAt": "2026-09-28T09:00:00Z",
  "journalSeq": "42",
  "repos": [{
    "repoKey": "<canonical repo key>",
    "path": ".",
    "objectFormat": "sha1",
    "head": "<committed tip OID>",
    "forkBase": "<fork base OID>",
    "wip": "<WIP commit OID>",
    "index": "<index anchor commit OID>",
    "branch": "feature",
    "submodules": [{"path": "packages/lib", "repoKey": "<submodule repo key>"}]
  }],
  "session": {
    "provider": "<provider id>",
    "mode": "history",
    "throughSeq": "42",
    "files": []
  },
  "attachments": [{"attachmentId": "attachment-1", "sha256": "<hash>"}]
}
```

Private preparation transfers this complete metadata through
[node-link sourceMetadata](./node-link.md#immutable-source-metadata), with exact
typed manifest bytes and checkpoint-bound retained attachment ID/hash/length
descriptors. Manifest attachments alone do not supply lengths. This preserves the
checkpoint digest/format; metadata and its descriptor lengths are immutable
preparation intent, held in separately bounded owned storage rather than expanding
the compact preparation ledger. An object or successful decode grants no authority.

Head validates current/inherited source selection independently from target-stage
ownership. Remote restore also requires an admitted selected-checkpoint Git
read-ref adapter for exact immutable HEAD/index/WIP/inherited closure; Upload
rejects StageBinding and cannot fetch arbitrary manifest OIDs. Never substitute
moving aliases or local stage paths. Existing Prompt carries bounded history;
manifest session metadata introduces no portable-file import or readiness proof.

Required fields are those shown except `branch` (omitted for detached HEAD) and
`wip` (omitted when clean). A delegated isolated child additionally carries the
`inherited` entry defined above in each seeded repository; independent agents omit
it. `head` is the actual private execution tip, which can descend from that private
baseline; publication must normalize it as above. `repos` contains root plus all initialized tracked
submodules, ordered parent before child; each uses the same shape, with its
workspace-relative `path`, direct submodule edges and its own hub. Phase 1 requires
SHA-1 repositories; unsupported object format fails explicitly. Empty/unborn repos
and unresolved index conflicts fail checkpoint with a retained prior checkpoint,
not a silently lossy approximation. Uninitialized submodules remain gitlinks in
the containing tree; never claim to have snapshotted nonexistent local content.
Capture both actual submodule HEAD/WIP and the containing repository's index/tree
gitlinks, which may differ. Do not overwrite a gitlink just to match the child HEAD.
Nested unpublished commits must have their own hub objects, including the parent
submodules needed to reach them. Existing transfer detection/validation is the
starting point, not permission to skip dirty submodules or a changed gitlink.

The `index` anchor commit has the exact staged tree, rooted in the committed tip;
the WIP commit has the worktree tree and parents retaining `head` and `index`.
Reuse the existing transfer sentinel and `Intent-Index-Tree` trailer to recover
staged/unstaged/untracked splits. Restore real HEAD at `head`, index from the index
tree, and files from WIP (or head when clean); Git then classifies worktree paths
absent from the restored index as untracked, including staged-delete/recreated
paths. Include normal untracked files,
deletions, executable bits and symlink contents without following escaping links.
Skip ignored files, `.intent/attachments`, derived `tool-outputs`, provider secret
files, sockets/devices and unregistered nested repositories. Agent-authored secrets
in ordinary tracked files receive normal Git treatment; the codec must not claim
to detect every possible secret. Runtime-owned secret material is always excluded.

Capture uses temporary indices/object writes, never real index, branch or HEAD
mutation; error paths leave byte-identical index and unchanged worktree/ref state.
Take a per-checkout capture barrier covering ACP writes, commands/scripts and Git
operations; shared checkout participants use that same barrier. A running mutating
child or external writer prevents a proven stable capture: defer/retry and retain
the prior checkpoint, rather than claiming an atomic filesystem snapshot. Recheck
HEAD/index/files before committing a capture; any detected change invalidates it.
No hard durability promise applies to uncontrolled host processes writing outside
these locks. Periodic capture is attempted every five minutes when changed, at
idle, and after attributed commits; on a long unquiesced command it may be deferred.

`journalSeq` identifies the capture barrier. `session.mode: "load"` is allowed
only for providers with a verified portable session allowlist and a quiesced
session through that same sequence; `files` then contains `{ path, sha256, bytes }`
for validated relative paths in a separate session bundle, never arbitrary HOME
contents. Rewriting a provider cwd/session path must be provider-aware and tested.
When that cut cannot be proven, emit `mode: "history"`, `throughSeq: journalSeq`,
`files: []` and recover through bounded history instead of loading an inconsistent
session. Do not replay acknowledged tool effects as executable calls. Session
credentials/caches are never included; static credentials are reissued on resume.

## Durable commit, visibility and recovery

Capture freshness is independent of journal acknowledgement and wall-clock time.
Head persists a monotonically increasing per-agent `assignmentEpoch` (u64 decimal
string) at each new execution admission/reassignment and binds it to the exact
lease/incarnation/run. Reconnecting the same surviving run retains its epoch;
spawning a new run requires a new epoch. The node persists a per-agent, per-epoch
`captureRevision` counter before each capture, under the capture barrier. Captures
are serialized in revision order; uploads may overlap. Revisions are never reused,
even on failed capture, and two captures with the same journal watermark still
receive different revisions. A lost/rolled-back counter requires a newly admitted
epoch, never a guessed next revision. Timestamps and journalSeq are not freshness
comparators. Recovery may continue to use the last successful prior-epoch pointer
until the current epoch produces a successful checkpoint.

1. Node captures and retains manifest/objects locally, uploads all repo packs and
   content-addressed session/attachment data, and submits an internal
   `checkpoint.commit` RPC keyed by checkpoint UUID and manifest hash.
2. Head verifies the current assignment epoch and bound lease/incarnation/run,
   safe paths, object closure, hashes, sizes, submodule
   edges and that transcript ack has reached `journalSeq`. Reject unknown format,
   duplicate repo/path, traversal, symlink escape and credentials in runtime-owned
   session paths. It never marks a partially uploaded checkpoint successful.
3. Under the agent checkpoint lock, head fsyncs objects, manifest, blobs and
   immutable per-checkpoint refs in each affected hub. In one SQLite transaction,
   revalidate assignment ownership and compare-and-swap the successful pointer
   only if `(assignmentEpoch, captureRevision)` is greater than the current
   pointer's pair, comparing epoch first and then revision as **u64 numbers**, not
   decimal text. Enforce a durable unique mapping from `(agentId, assignmentEpoch,
   captureRevision)` to UUID/hash for historical uploads as well as the current
   pointer. Store the pair, checkpoint UUID/hash, `committedAt`
   and the operation receipt together. A valid older upload may be retained as
   historical, but cannot advance the pointer, aliases or checkpoint event. A
   mismatched execution epoch is rejected as `stale-checkpoint-owner`; an equal
   pair with a different UUID/hash is `checkpoint-invalid`, never last-writer-wins.
   Git/files/SQLite are not a global transaction: immutable anchors written before
   DB commit are harmless orphans, reclaimed only after reconciliation. Readers
   resolve the DB pointer/manifest, never an in-progress set of mutable refs.
4. Still under the agent checkpoint lock, repair mutable head/WIP aliases from
   the **current DB pointer**, not the upload callback's cached manifest. Agent Git
   ref update requests remain staged until this commit decision. Emit
   `hub:checkpoint` only for pointer advancement, carrying its epoch/revision;
   consumers ignore an older pair if delivery is reordered. Reply with a durable
   receipt `{ checkpointId, outcome: "advanced" | "historical", currentCheckpointId }`
   describing the commit decision. Crash recovery repairs aliases/events from the
   durable pointer under the same lock. A lost response retries the same UUID/hash
   and returns its existing receipt; it never re-advances the pointer or re-emits
   the event. Different bytes with that UUID fail. No prior checkpoint is deleted
   before the replacement success is durable.

Journal ack and checkpoint success are independent: transcript may be newer than
recoverable disk. Preparation readiness is separate from both: it proves neither a durable head
checkpoint receipt nor capture quiescence, and provider idleness releases no
capture owner. Bounded resume history is selected on head from an authorized
acknowledged source cut and transferred through the scoped first-message gate;
portable-session import must fail when the adapter does not support it.

Hub reads/diffs select a checkpoint and return its capture time; live reads go to
the active node with its scope and fail explicitly when offline.
Never label a cached WIP diff as live. On restore verify all data before exposing
the checkout, rematerialize attachments, restore each repository/index and then
provider state/history. Loss notice names capturedAt and possibly missing work
since then, even when that exceeds the nominal five-minute interval.

Archive retains recovery data. Explicit agent deletion/discard tombstones ref
ownership, then removes its mutable refs and unreferenced checkpoint anchors after
pending recovery/merge operations release them; periodic GC reclaims unreachable
objects. An offline node cannot resurrect a tombstoned ref. Session/blob reachability
uses the same manifest ownership. Publication refs and checkpoints owned by other
agents are never removed as collateral cleanup.

## Explicit publication

`hub.publish` selects the named successful manifest's committed delta for the
granted repo, normalizing inherited private baselines as defined above; it never
substitutes a newer live ref or publishes synthetic WIP. With no inherited
baseline the published tip is exactly the manifest's `head`; otherwise `headSha`
in the result is the normalized tip, and the operation receipt pins its mapping
from the source checkpoint before pushing. Validate the
branch with Git ref rules, forbid reserved namespaces, recheck current caller
authority and stage `refs/intent/publish/<branch>` on head. Push with exact
expected-remote-head compare-and-swap (`null` means branch must not exist), not an
unconditional force push. Existing protected-branch restrictions still apply.
For submodules, publish required child commits first; reject superproject publish
if its gitlink targets cannot be fetched from their authorized forge repositories.
No periodic checkpoint, agent idle, merge-back or PR monitor initiates publication.

Persist publication intent before invoking Git. If the response is lost, query
the exact remote branch: matching desired OID completes the same operation;
unchanged expected OID permits a keyed retry; any other OID returns conflict. If
the remote is unavailable, report uncertainty and retain the intent. PR creation
is a subsequent explicit `gh` command through the [bounded bridge](./methods/nodes.md#merge-discard-and-publication),
not a side effect of publish. Neither operation grants permission to merge a PR.

## Required implementation assertions (not yet run)

The [example corpus](./fixtures/nodes/contract.json) supplies request/expected
outcome seeds. Component tests must replace fixture IDs with seeded identities
and exercise real WSS authorization, not accept a docs-only fixture validator as
proof. Additional deterministic tests must cover:

| Test boundary | Required assertion |
| --- | --- |
| Node auth | Wrong token/cert/identity/generation, revoked member and cross-agent/workspace/repo calls fail before effects; no daemon authority through hooks |
| Placement | Explicit remote never local; isolated never shared; exclusive reservation races; absent placement retains local behavior; gate failure releases capacity |
| Transport | Both RPC directions/cancel; 64 KiB fragmented bulk cannot occupy reserved control queue; unknown mutation result never replayed as fresh |
| Journal | Crash before/after ingest transaction and before/after ack; duplicate/gap/corrupt record; two reconnects; exactly one resume; user stop wins |
| Checkpoint | Byte-identical live index/HEAD after success/failure; staged/unstaged/untracked split; deletion/symlink/mode; nested unpublished and dirty submodules; partial upload/DB crash |
| Checkpoint ordering | Upload captures in reverse order, including equal journal watermarks; pointer, aliases, events and loss recovery select the higher capture revision; stale epoch/counter reuse cannot take ownership |
| Inherited parent WIP | Local and remote child sees staged/unstaged/untracked parent contents and dirty submodules; parent HEAD/index/worktree unchanged; baseline is not child attribution; empty/unrelated child merge does not reapply inherited dirt; publication excludes synthetic ancestry or blocks |
| Recovery | Short grace outage, head-required wait, deadline/cap halt; head restart with retained lease; node loss with checkpoint older than five minutes; consistent session/history fallback |
| Merge | Local and remote target parity: clean, conflict, unrelated/overlapping dirty parent, submodule failures, crash reconciliation and once-only completion |
| Retirement | Reject per-agent cow and removed routes; workspace cow/reflink and plain-clone fallback still pass; no legacy files removed or migrated |
| Separate filesystems | Head and node roots inaccessible to the opposite process; tools, MCP, attachments, scripts/hooks and live reads cannot succeed through a shared checkout |

Final qualification also requires full package gates and a separate-host static
node smoke run. `make consumer-checks` verifies catalog/docs consistency only.
