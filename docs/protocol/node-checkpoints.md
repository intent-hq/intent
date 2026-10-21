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

## Retained head-local source lineage

This prepared contract permits an ordinary local parent's source to seed a fresh
isolated child. It requires new head-owned source admission, retained storage and
history adapters; it does not assert that an initializer or live model launch is
implemented. It changes no remote journalFormat 1, checkpointFormat 1, private
node-link version, public request or provider-resume semantics. The internal
storage encoding and migrations belong to the implementation, not this document.

### Real parent, immutable source and committed history

The source parent is the actual authenticated running caller of model create or
delegate, in the same workspace and under current read/spawn permission. Retain
that parent's exact identity as the child's merge target. Do not insert a hidden
parent, replace its identity, borrow the child's remote run/epoch, or wait for the
initiating tool turn to finish. Parentless creation is outside this initial
inherited-source path.

The initial supported source is a verified clean committed isolated repository
with its exact initialized submodule closure. Resolve repository keys and roots
from persisted workspace state and actual source admission. Reject unsupported
dirty/index/untracked state, unborn or unresolved repositories and unbacked
attachments explicitly; never silently omit them. This restriction is an initial
implementation boundary, not a weakening of the general WIP inheritance contract
above. Snapshot immutable committed objects into retained owned storage without
changing the parent's HEAD/index/worktree. A clean flag, bare path, new registry
or fresh barrier does not prove that a mutable source has no concurrent writers.
Every writer to the newly owned copy must use its real common barrier.

At invocation take one bounded, agent-scoped Store read snapshot of the committed
message prefix and adopted payload/attribution rows. Retain the actual highest
committed sequence and row identity, ordered rows, counts, exact byte digests and
caller/turn/tool-call correlation. Include already committed user and assistant
messages. Explicitly exclude the current uncommitted assistant envelope and its
unadopted prestaged blocks; a tool call must not wait for its own turn-end commit.
Later messages cannot change the frozen cut or be substituted on a retry.

Preserve complete bounded semantic message and adopted payload bytes independently
of later Store pruning. A checksum, mutable row pointer, lossy replay preview or
provider-session watermark is not retained history. Page and bound materialization
inside the same snapshot; reject missing required full payload, unsupported
attachment content or overflow rather than truncating it. Provider-native session
files remain nonportable. Do not invent output events or reinsert the imported
history into the parent's ordinary transcript.

The retained history is **head-side source provenance, not fresh-child provider
replay**. A fresh child receives its separately requested instruction through the
existing fresh Prompt: Prepare.resume, Prompt.history and resumeAttemptId are all
absent. Session.mode=history, throughSeq and files=[] carry a source watermark,
not transcript bytes. Check the entire resolved request, inherited defaults and
ordinary method semantics; an actual unsupported resume/history requirement must
fail explicitly, never be stripped or relabelled as a fresh run. In particular,
an ordinary model create with a new name and a self-contained first message can
use this path without pretending that it resumes the parent's provider session.

### Capture-only identity and ordinary parent routing

Use the real built-in Local node identity and its durably owned source lease,
a fresh capture-only run and Store-allocated positive assignmentEpoch. Allocate
a positive captureRevision durably before capture; failed attempts burn revisions.
This source is not another selectable execution target and supplies no ACP,
Prepare, credential or network grant. Do not replace a conflicting execution
assignment or live local lease to create it. The parent continues under its own
existing local execution authority.

Persist capture-only purpose atomically with the source assignment. Every relevant
assignment consumer, including hooks, local/node dispatch, Stop/deletion, startup
and recovery, must consult this purpose before routing. Missing or partial purpose
fails closed for the capture owner; it cannot default to execution. Merely making
an ordinary assignment inactive is insufficient. Closing source capture preserves
the parent's ordinary local routing and the retained source identity/checkpoint;
it neither retires the parent nor makes it an offline remote agent.

Only a manager-minted, nonserializable LOCAL admission may create or operate this
source. Bind the real parent/workspace/lease/run/epoch, caller/launch correlation,
immutable OIDs, history cutoff/digest, original deadline, checkpoint UUID and
backing reservation in the durable intent. Register the same task/resource/result
owner before spawning work. Raw arguments, LocalCapture data, serialized receipts
or a fresh authority registry cannot mint this admission.

### Sealed local prefix and retention-only acknowledgement

The LOCAL retained log imports actual committed history in order, preserving each
original row ID/role/sequence, adopted payload and attribution. Allocate its local
sequence by actual durable append; retain the exact mapping from local sequence
to Store row identity/hash and the selected source cut. Do not equate Store and
journal counters or route this import into ordinary remote Transcript ingestion,
which would duplicate or relabel existing history.

Seal the completed contiguous append prefix durably, binding the exact source
identity, import/checkpoint identity, original Store cutoff, last local sequence,
complete byte/hash inventory, counts/charges and original deadline. No later
append enters that sealed cut. Under the same LOCAL admission, a FULL durable
head transaction verifies the purpose, owner, contiguous prefix and fsynced full
inventory before recording the exact source acknowledgement decision. Then fsync
confirmation of that same decision and cut locally. Only the correlated confirmed
cut permits checkpoint admission. An actually empty prefix still requires real
durable genesis/provenance and confirmation; never assign a constant zero cut as
a shortcut.

This acknowledgement **does not reclaim**. The typed LOCAL owner must make ordinary
remote Journal acknowledge, begin_replay, complete_replay and reclaiming open paths
unreachable. Share encoding/durable append primitives only if retention policy is
enforced through construction, confirmation, Drop and reopen; otherwise use a
distinct internal retained-log type. Ordinary remote journal consumers are
unchanged. A reconnect barrier or read-only confirmation cannot substitute for
this durable local seal/decision/confirmation sequence.

Retain full history bytes, payloads, mapping, source pins and their charges through
Store pruning, cancellation, expiry, failed native disposal and wrapper Drop.
Reopen reconciles the same cut/decision or quarantines missing, mismatched or
rolled-back state; it cannot reset genesis, delete bytes or refund capacity.
Confirmation and retention lifetime are separate: even a durable ACK is not
permission to unlink, reuse a root or reclaim backing. Dependencies and actual
joined disposal must settle under the real owner before any later release.

### Enforced backing and commit ordering

All initializer effects require a verified pre-provisioned byte **and inode**
limited allocation in the same retained head backing domain. Coverage includes
immutable source copies, native capture scratch/spool/temp packs, Stage pending
and final copies, promoted hub objects/refs, the LOCAL log/provenance/metadata and
database/WAL destinations, including uncertain partials. Deny symlink, alternate
object directory, temporary-directory or shared-hub escapes. If any destination
lacks enforcement, return unavailable before the first initializer write, pin or
assignment publication. Logical Stage limits, a scan, sampled free space or scalar
accounting are not enforcement for native writers. This contract neither assumes
host support nor provisions storage.

Reserve logical capacity under that actual enforced owner, counting simultaneous
copies and uncertain outcomes. Apply these upper bounds and every stricter existing
component or installed-allocation limit; no limit enlarges another component cap:

| Resource | Initial LOCAL source limit |
| --- | --- |
| Active work | One initializer per head and parent; no queue |
| History | 4096 messages, 16384 blocks, 1 MiB decoded semantic bytes |
| Repository closure | 64 repositories; 1 MiB manifest |
| Stage objects | 256 MiB per repository; 1 GiB aggregate |
| All backing, including temporary/uncertain copies | 4 GiB; 262144 inodes |

The required order is bounded read-only selection, current admission plus enforced
backing reservation and registered job, durable exact intent/purpose, immutable
copy/pins and LOCAL log import, sealed-prefix acknowledgement, then capture,
stage, promotion, durable checkpoint commit and alias repair. Do not hold a Store
transaction, map lock or exclusive capture barrier across unrelated remote waits.
Revalidate actual authority after waits and before effects. Preserve the original
deadline and exact intent on retries; timeout is not settlement or quota release.

Typed LOCAL authority must cover native promotion and alias repair as well as the
initial Store check. Never fabricate a LinkBinding or physical connection generation
to call remote-only APIs. Keep UUID/hash idempotence, capture-revision freshness
CAS and alias ordering. Only the actual unchanged three-field durable commit
receipt permits selecting inheritedCheckpointId for the distinct remote target,
whose mergeTargetAgentId is the real source parent. Target source-read authority
is separate from the closed source-capture owner; it need not keep the source run
executable.

Retain the same task, sticky work/JoinError/disposal/commit results, native policies,
spool and charges through dropped waiters. Fence close/deadline independently of
joins and join outside worker-needed locks. Finished flags are not settlement.
Unknown commit results reconcile the original UUID/hash and retain uncertainty;
they must not create a second source or child. Required bounded readers, LOCAL
log/schema and purpose-aware routing, typed native admission and enforced backing
are implementation prerequisites, not claims established by the prepared
[local-source examples](./fixtures/nodes/local-source.json) or their
[static validator](./fixtures/nodes/local-source.test.mjs). Runtime scenarios remain
unexecuted until separately qualified. Additive canonical docs precede consumer
merges; local development and draft review may proceed in parallel.

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
ownership. The [private selected-read agreement](./node-link.md#selected-checkpoint-git-reads)
reserves bounded head source ownership **before** prepare dispatch, even if no
transfer is registered. Record/reference quotas and backing retained-data capacity
are separate from the attempt quota; lost dispatch and uncertain cleanup stay
charged. Each source-read attempt registers through node.checkpoint.read.prepare
before Open and binds its head-issued ID to the exact preparation, checkpoint/hash,
source-reader relation, target run/epoch, repository and current generation.

Only the typed local installer selects git.checkpointUploadPack and the issued
ID. Unknown/consumed/foreign source IDs never fall back to ordinary Upload or the
current preparation. Upload rejects StageBinding and cannot fetch arbitrary
manifest OIDs. The selected-source adapter must advertise only exact immutable
HEAD/index/WIP anchors with expected OIDs, prove inherited bases in their closure,
and fail if a required root is missing; each submodule needs its own granted read.
Never substitute moving aliases or local stage paths. Retain fresh source/target
admission through native reads and queued/actual writes, then prove cleanup before
releasing pins. Expiry is not settlement; tombstone compaction must preserve replay
fences until durable target-epoch retirement makes old requests reject before
lookup. Fenced recovery elsewhere does not release the original owner's resources.

The producer, registry, installer, source adapter and guarded Upload are required
implementation work, not qualified behavior. Existing Prompt carries bounded
history; manifest metadata, registration or transfer completion introduces no
portable-file import, readiness or checkpoint ACK proof.

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

## Capture quiescence and spool ownership

The [private version-3 capture agreement](./node-link.md#private-checkpoint-capture)
registers exact manifest bytes, complete repository upper bounds and attachment
lengths before existing Stage uploads, then uses the durable commit below. It
preserves checkpointFormat 1's numeric formatVersion, RFC3339 capture time and
optional-field omission. The three-field receipt and freshness rules are unchanged.
Only supported current Store attachment reuse is included; local-only and
prior-checkpoint-only bytes fail explicitly, without loss of the prior checkpoint.

Every ACP/tool/script/Git mutation, attachment adapter/delivery/retirement disk
write and synchronous mkdir/unlink/Drop path must participate in the SAME checkout
barrier. A retained outer initialization MutationPermit cannot be released just
because some Disk tasks finished. Prove actual initialization workers settled and
all later mutating APIs have barrier admission and bounded owned retirement before
atomic handoff; failed/uncertain writes retain their permit and defer capture.
A new registry/barrier, provider idle or forced guard drop cannot prove quiescence.
Provider mutation guards remain effective; immutable data/ledger ownership is
separate from outstanding mutating work.

Reserve finite local record/spool/temporary capacity and persist the next revision
before capture. Under the common barrier record the serialized journal cut and
validate stable HEAD/index/files without changing their real state. Retain the
immutable spool and its owner before releasing capture ownership. Upload reads
that spool under separate retained ownership; never hold the exclusive checkout
barrier across remote waits. A changed tree/cut fails or defers; counters are not
reused. Head/node budgets cover pending, retained and uncertain data across runs,
not just successful captures. Restart quarantines uncertain ownership and never
infers cleanup or authority from expiry/intact files.

Existing Stage framing requires a full bounded retransmission for lost-receipt
replay, after actual prior settlement and reserved scratch; at most three physical
attempts total per repo, with no second durable import. Retain/join the SAME Stage
and commit task/result, process, native policy and spool through dropped waiters.
The [capture protocol](./node-link.md#stage-upload-and-lost-receipt-replay) defines
this requirement; current local helper APIs alone do not establish it.

## Durable commit, visibility and recovery

Capture freshness is independent of journal acknowledgement and wall-clock time.
Head persists a monotonically increasing per-agent `assignmentEpoch` (u64 decimal
string) at each new execution admission/reassignment or authorized capture-only
LOCAL source admission and binds it to the exact
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
