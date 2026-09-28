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

Before spawn head refreshes its base mirror and records the exact committed fork
base and merge target. For a delegated child, use the parent's latest successful
checkpoint's committed head, including unpublished commits; dirty parent WIP stays
in the parent's checkpoint and is not silently committed or attributed to the
child. Phase 1 delegates from committed history, not a live dirty snapshot fork:
commit intended handoff changes first. The node hydrates a separate checkout
from its own cache/forge and fetches any missing objects/agent delta from hub.
Base objects are preferably fetched directly, but **may cross the node link** when
unpublished or unavailable from the forge; correctness cannot assume otherwise.
Recursively hydrate granted submodule repos before the first-message gate settles.
Local isolated checkout uses clonefile/FICLONE from the repo cache where supported;
otherwise use a standalone Git clone with local alternates. Reflink failure never
changes requested isolation to shared. Shared local agents keep today's checkout.

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

Required fields are those shown except `branch` (omitted for detached HEAD) and
`wip` (omitted when clean). `repos` contains root plus all initialized tracked
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

1. Node captures and retains manifest/objects locally, uploads all repo packs and
   content-addressed session/attachment data, and submits an internal
   `checkpoint.commit` RPC keyed by checkpoint UUID and manifest hash.
2. Head verifies assignment, safe paths, object closure, hashes, sizes, submodule
   edges and that transcript ack has reached `journalSeq`. Reject unknown format,
   duplicate repo/path, traversal, symlink escape and credentials in runtime-owned
   session paths. It never marks a partially uploaded checkpoint successful.
3. Under the agent checkpoint lock, head fsyncs objects, manifest, blobs and
   immutable per-checkpoint refs in each affected hub before one SQLite transaction
   advances the agent's successful checkpoint pointer and records `committedAt`.
   Git/files/SQLite are not a global transaction: immutable anchors written before
   DB commit are harmless orphans, reclaimed only after reconciliation. Readers
   resolve the DB pointer/manifest, never an in-progress set of mutable refs.
4. Head updates mutable head/WIP aliases from the committed manifest, emits
   `hub:checkpoint` and replies with the committed checkpoint. Crash recovery
   repairs aliases/events from the durable pointer. A lost response retries the
   same UUID/hash and returns the committed result. Different bytes with that UUID
   fail. No prior checkpoint is deleted before this success is durable.

Journal ack and checkpoint success are independent: transcript may be newer than
recoverable disk. Hub reads/diffs select a checkpoint and return its capture time;
live reads go to the active node with its scope and fail explicitly when offline.
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

`hub.publish` selects the named successful manifest's **committed** `head` for the
granted repo; it never substitutes a newer live ref or synthetic WIP. Validate the
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
| Recovery | Short grace outage, head-required wait, deadline/cap halt; head restart with retained lease; node loss with checkpoint older than five minutes; consistent session/history fallback |
| Merge | Local and remote target parity: clean, conflict, unrelated/overlapping dirty parent, submodule failures, crash reconciliation and once-only completion |
| Retirement | Reject per-agent cow and removed routes; workspace cow/reflink and plain-clone fallback still pass; no legacy files removed or migrated |
| Separate filesystems | Head and node roots inaccessible to the opposite process; tools, MCP, attachments, scripts/hooks and live reads cannot succeed through a shared checkout |

Final qualification also requires full package gates and a separate-host static
node smoke run. `make consumer-checks` verifies catalog/docs consistency only.
