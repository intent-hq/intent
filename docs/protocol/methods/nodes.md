> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.50 Nodes and hub checkpoints.

### 5.50 Phase 1 node execution contract (prepared, not implemented)

This is the target contract for static remote execution **and per-agent CoW
retirement in phase 1**. It does not describe behavior available in the pinned
daemon. The method/event catalogs reserve additions now; existing CoW entries
remain until component removal and automatic pin advancement. Runtime assertions
below are requirements for future component tests, not results of documentation
checks. [Node link](../node-link.md) specifies the private transport;
[checkpoints](../node-checkpoints.md) specifies durable source/session state.

#### Discovery and compatibility

`client.hello.server.capabilities` adds `agentNodes: 1` when the complete static
node, hub, placement and recovery contract is implemented. `localNodeIsolation: 1`
additionally requires the in-process local node and isolated-checkout parity.
Missing, malformed or unknown values do not enable these features. The flags
grant no authority. Additive implementation allocates the next available minor
protocol version against main; this document does not reserve the abandoned
microVM proposal's 10.10 number. CoW API removal requires a separate major bump
and advertises `agentIsolation: 2` only when retirement is complete. That value
requires both node flags. No version/flag is advertised by this docs change.

Clients gate existing complete placement and hub controls on those flags.
The [widened platform contract](../model-platform-routing.md) additionally requires
`agentPlatformRouting: 1`; its public 11.2 reservation changes no private formats.
The existing client→head
WSS transport, subscription recovery, principal identity and workspace membership
rules remain intact. The FE never connects to the node-link endpoint.

#### Public methods and authority

Identifiers are opaque server-issued strings; timestamps are UTC RFC 3339.
Optional fields are omitted, not null, unless explicitly stated. Unknown fields,
invalid enum values and malformed IDs fail with `-32602` before side effects.

| Method | Params | Result |
| --- | --- | --- |
| node.register | endpoint (req, `wss://host:port/node`), certificateSha256 (req, lowercase 64-hex DER leaf certificate fingerprint), bootstrapToken (req, secret), requestId (req, UUID), name? | `{ node: Node, lease: Lease }`; owner-only; enroll and verify a static node, consume its one-time token and establish its first lease; no agent starts |
| node.list | workspaceId? | `{ nodes: Node[] }`; owner sees inventory; an ordinary workspace manager supplies `workspaceId` and sees safe placement capacity only; guests and agents cannot enumerate nodes |
| node.drain | nodeId (req), draining (req, boolean) | `{ node: Node }`; owner-only, idempotent; prevents new placements without stopping existing agents; `false` restores eligibility if connected |
| node.remove | nodeId (req) | `{ ok: true }`; owner-only; requires a released lease with confirmed stopped processes, or a lost lease fenced as specified below; removes registration/credential, never the user's static-host files; nonexistent ID is a no-op |
| lease.list | nodeId? | `{ leases: Lease[] }`; owner-only, includes terminal leases; never exposes tokens |
| lease.release | leaseId (req), requestId (req, UUID) | `{ lease: Lease }`; owner-only; durably requests stop of all placed agents, revokes dispatch authority and releases reservation; terminal leases return their existing state |
| hub.merge | workspaceId (req), agentId (req), checkpointId (req), requestId (req, UUID) | `{ ok: true, status, commitRange?, canonicalHead?, conflictingPaths?, reason?, overlappingPaths? }`; status is `merged`, `conflict`, or `blocked`; details below |
| hub.discard | workspaceId (req), agentId (req), requestId (req, UUID) | `{ ok: true }`; stops isolated execution before discarding its checkout/ref ownership; already discarded is a no-op |
| hub.publish | workspaceId (req), agentId (req), repoKey (req), checkpointId (req), branch (req), expectedRemoteHead (req, full OID or null for a new branch), requestId (req, UUID) | `{ repoKey, branch, headSha, checkpointId, publishedAt }`; explicitly publishes committed work from the named successful checkpoint using head's forge credentials; never publishes WIP |

`hub.*` requires an ordinary workspace manager, or an agent authorized by the
existing agent/parent rules for this exact workspace and target agent. Merge and
discard permit self or the persisted parent; publish permits self or that parent
only with the workspace's existing forge-write authority. Workspace guests gain
no new mutation authority. Resolve the agent's stored workspace and repo grant,
then compare input; a forged `workspaceId` never changes the resource owner.
Inaccessible workspaces/agents/repos return `-32602` with `data.code: "not-found"`;
an authenticated but disallowed operation returns `-32003` with
`data: { code: "forbidden", detail }`. Node enrollment is never an agent permission.

Durable `requestId` records key mutations by caller, method and UUID, bind the
canonical parameter hash, and retain their terminal results through agent/lease
lifetime (including reconnects). Same ID and same params returns the same result;
same ID with different params returns `-32602`, `request-id-reused`. Concurrent
duplicates join one operation. Retain tombstones after deletion so retries cannot
recreate a released lease or discarded checkout. Publication uncertainty is
reconciled as described in the checkpoint contract, not blindly repeated.

#### Node and lease records

`Node` fields: `id`, `name`, `kind: "local" | "static"`, `os: "linux" | "macos"`,
`arch: "x86_64" | "aarch64"`, `state: "ready" | "offline" | "incompatible" | "removed"`,
`draining: boolean`, `capacity: { maxAgents, reservedAgents, memoryBudgetBytes,
usedMemoryBytes, exclusiveReserved }`, `version`, `lastSeenAt?`. Counts and bytes
are non-negative safe JSON integers. Capacity is sampled, not an admission grant.
Only owner projections include `endpoint`, `certificateSha256`, `nodeIdentity`
and `leaseId`; placement projections omit those fields and removed nodes.
`nodeId` on an agent is safe for its workspace members to see.

`Lease` fields: `id`, `nodeId`, `incarnation` (UUID), `state`, `agentIds`,
`createdAt`, `lastSeenAt?`, `ackSeq` (decimal u64 string, initially `"0"`),
`linkGeneration` (decimal u64 string), `releaseRequested: boolean`.
`state` is `acquiring | ready | busy | idle | released | lost`. `ready` means no
placed agents, `busy` means any running/provisioning agent, `idle` means placed
agents with no running turns. Disconnect alone does not release capacity: node
becomes offline and the last lease state remains until reconciliation. No pause,
snapshot, expiry or cloud-provider state is accepted in phase 1.

One static registration has at most one nonterminal lease, owned by a durable
head-installation identity. Head restart preserves it; reinstall/restoring an
unrelated disk never silently claims it. Lost means the old runtime cannot be
reconciled, not merely a missed heartbeat. Before assigning its agents elsewhere,
head must fence it: obtain confirmed process termination from the node/operator,
or wait until its lease-bound offline execution budget has elapsed. Record the chosen
fence and loss time durably. A disconnected release stays `releaseRequested: true`
until stop confirmation/fencing; it cannot immediately free the host for reuse.
Static files are retained on loss/release; operators may remove them explicitly.
Release also drains the registration. Phase 1 does not automatically reacquire a
released static lease: remove the registration and explicitly re-enroll with a
new operator-issued bootstrap token before reusing that host.

The built-in `local` node cannot be registered, drained, removed or released by
these admin calls. It has the same placement/lease model and durable journal
identity, but no network credential, listener or second daemon process.

#### Placement and creation

The current wire entry point is `agent.create`, **not** `agent.spawn`.
[Single-node platform launch](../model-platform-routing.md) defines the
prepared 11.2 additive extension: optional independent placement.os/arch, whole-
object defaults, one named configured node and atomic multi-agent capacity/launch
ownership. Architecture-only requests such as `{"placement":{"arch":"x86_64"}}`
require `agentPlatformRouting: 1` in addition to `agentNodes: 1`; old complete
`{target,checkout,os?,nodeId?,exclusive?}` objects remain valid. Older supporting
daemons accept only the complete shape. Unknown-field tolerance is not support.

The extension applies to create, single/batch delegate, wakeOrCreate's creation
branch and workspace initial-agent creation. Specialist runsOn and manager-owned
Workspace.defaultAgentPlacement use the same whole-object validation. The linked
contract specifies exact precedence, legacy isolation conflict rules and head
single-node admission. Omission preserves local shared/worktree/CoW behavior
unless an existing specialist/workspace default applies, without a prompt. Existing
assigned agents retain placement when woken. Workspace checkoutMode cow remains.

An isolated checkout is filesystem separation, not an OS security boundary.
Exclusive reserves Intent capacity on a remote node, not ownership of the user's
physical host. Multiple-node ordering and pools are deferred.
Admission reserves configured-node capacity durably before dispatch; uncertain
issuance retains identity and charge. Hydration failure does not itself prove
cleanup or free reservations. Existing first-message preparation and live admission
gates remain mandatory. No queue or local/shared fallback is added. A later
hydration failure leaves the created agent in error with placementError, emits
agent:failed and resolves the first-message gate to failure. Its reservation stays
charged until actual native/private/capture cleanup settles. The
[private preparation gate](../node-link.md#private-preparation-lifecycle) waits for
verified recursive hydration/attachments and actual provider setup, then rechecks
live authority; a ready receipt is not admission. Retained same-node resources
cannot be reused, while separately fenced last-checkpoint recovery on another
node retains the existing loss contract without waiting for unreachable old-node
cleanup. Errors/discovery preserve correlated OS+arch alternatives
and existing availableOs, without exposing administrator node inventory.

Placed agent projections carry nodeId, leaseId, resolved placement,
effectiveIsolation, nodeState and genuine nodeName. Provisioning reports
`effectiveIsolation: "pending"`; settled isolated placement reports `"isolated"`
on local and remote nodes; shared/worktree retain their existing values.
Optional `checkpoint: { id, assignmentEpoch, captureRevision, capturedAt,
committedAt }` is the last successful current hub checkpoint; stale numeric
epoch/revision observations cannot replace newer state. Failure adds
`placementError: { code, detail }`. nodePath is diagnostic opaque text, never a
frontend/head-local filesystem path. Models request constraints; clients show real
node names when available and retain neutral identity otherwise. No manual
placement picker or required-choice dialog is specified. Existing management and
hub merge/discard remain available.

##### Experimental single-node subset

The experimental [single-node private link](../node-link.md#single-node-private-link-nodeprotocol-5)
implements part of this section without advertising `agentNodes`. Behind its
daemon switch, `agent.create`, single `agent.delegate` and `agent.wakeOrCreate`'s
creation branch (public RPC and MCP) accept the closed `placement` object with
the same validation. A remote placement needs `target` omitted or `"remote"` and
`checkout` omitted or `"isolated"`, with optional `os`, `arch` and `nodeId`;
`exclusive: true`, `target: "local"`, and on `agent.delegate` a batch with a
placement or `placement` combined with `isolation` fail with `-32602`. An omitted
placement stays local; `null` is rejected. Admission checks the configured
node's connection, platform and capacity and fails with the documented
`placement-unavailable` data (`no-capacity` or `unsupported-platform`,
`availablePlatforms`, `supportedPlatforms`, `availableOs`, `retryable`,
`observedAt`); `node-configuration-ambiguous` cannot occur with one node. While
a node is configured, the full `workspace_api` tool description names it, its
platforms and current capacity, and how to place an agent.

Placed agents carry `nodeId`, `leaseId`, `nodeName`, the resolved `placement`,
`effectiveIsolation` (`pending` until the node reports its checkout ready, then
`isolated`) and `placementError` on detail reads; `agent.list` rows omit them.
The create result adds a `notice` saying the agent starts from the workspace's
last commit and that uncommitted changes are not carried; delegate and
wakeOrCreate results copy `notice`, `nodeId`, `nodeName` and
`effectiveIsolation`. `nodeState`, `checkpoint`, `nodePath`, the `halted` / `resuming`
statuses, the node and hub events, `node.*`, `lease.*`, `hub.*`,
`Workspace.defaultAgentPlacement` and specialist `runsOn` are not part of the
subset. Agent work is exchanged as the hub ref names in the workspace's own
repository instead of a separate hub.

#### Lifecycle and events

Add `halted` and `resuming` to persisted/wire AgentStatus, alongside existing
values. `halted` has no live provider process and is not a running turn;
`resuming` holds admission and counts as in progress until prompt delivery or
failure. Update core status inventory, store queries and FE enum together before
enabling placement. `pending → active → idle` remains the ordinary flow;
`active → halted → resuming → active` is outage recovery. Stop/delete supersedes
resume at every boundary; a stop recorded while offline is applied before replay
can schedule a continuation. No `halted → active` shortcut spawns a second process.

Use existing `agent:status-changed` and `agent:updated` envelopes for status/field
changes, with `agentId`, `workspaceId` and the changed placement/checkpoint fields
included. Interrupted transcript metadata and `agent:stream:end.interruptReason`
gain `node_link_lost`; its interruption record contains `interruptedAt`,
`lastAckSeq`, `leaseId`, `incarnation`, `cause: "head-required" | "budget" |
"journal-full" | "node-lost"`, and `inFlightRequestId?`. It auto-resumes only after
the replay/fence and user-stop checks in [the link contract](../node-link.md).
No credential-expiry or node-upgrade interruption is promised in phase 1.

| Event | Data and delivery |
| --- | --- |
| node:changed | `{ node: Node }`; owner inventory or workspace-manager safe projection, including a removed tombstone for prior viewers; emitted on connectivity, drain and capacity changes |
| lease:changed | `{ lease: Lease }`; owner-only, never broadcast a host's agent inventory to workspace guests |
| hub:checkpoint | `{ workspaceId, agentId, checkpoint: { id, assignmentEpoch, captureRevision, capturedAt, committedAt } }`; emitted only after a durable successful-pointer advance; ignore older epoch/revision pairs on reordered delivery |
| hub:merged | `{ workspaceId, agentId, checkpointId, commitRange, canonicalHead }`; once per successful merge operation |
| hub:discarded | `{ workspaceId, agentId }`; once on discard, not on no-op retry |

Hub and agent events retain ordinary workspace delivery filters. No raw link frame,
secret, private endpoint or absolute head/node storage path enters public events.
Hub completion delivery waits for the merge result: clean `merged`, conflict bounce
with resolution paths, or `merge-pending` on blocked/unreachable parent or retry
exhaustion. Reuse existing finite bounce limits and deliver-once completion watches.

#### Merge, discard and publication

Merge target is persisted at isolated checkout creation: the parent agent's
checkout when delegated, otherwise the workspace's canonical checkout (resolved
by existing checkoutMode rules). Callers cannot substitute a target path/agent.
That target may be on another node. Head authorizes and probes immutable hub refs;
the target node locks/revalidates its actual HEAD/index/worktree before applying.
Apply child committed delta after its recorded inherited execution base (or fork
base if no inheritance), preserve commit authors, and never merge synthetic WIP
commits. The [inherited-baseline contract](../node-checkpoints.md#inherited-baseline-and-child-owned-changes)
preserves dirty-parent initialization while excluding those inherited edits and
synthetic submodule gitlink substitutions from the child's merge delta.
WIP remains recoverable until explicitly
discarded; uncommitted child changes block completion merge with
`reason: "uncommitted-child-work"`. A conflict leaves target pristine and returns
`conflictingPaths`; overlapping dirty target paths return `blocked` with
`overlappingPaths`; unrelated target dirt is retained. A changed target during
probe is re-probed under the lock, never overwritten. Offline target returns
`blocked`, `reason: "target-offline"`. Submodule commits must exist in their hubs
before superproject gitlinks are applied; dirty/conflicting submodules block the
whole apply before any target repository is changed. Persist operation progress
for crash recovery; do not claim a successful cross-repo apply until all steps
and the target checkpoint commit. Recovery reconciles partial applies before new
target work is admitted. Successful merge retains recovery refs until explicit
discard/retention cleanup, and may release the stopped child's checkout.

Discard durably tombstones ownership, cancels queued/resume work, then stops the
provider tree before deleting its new node-owned checkout and refs. If the node
is offline, cleanup waits for its stop/fence; tombstone prevents stale pushes.
No legacy sandbox directory is reused or deleted. Checkpoint objects still
referenced by another agent/merge operation survive garbage collection.

Publication is an explicit head action, independent of checkpointing and merging.
The current MCP surface remains `ws.git.commit` plus root registration, and
`ws.pr.snapshot`/monitoring. The obsolete source-draft binding names are **not APIs**:

```text
ws.git.push       (not exposed)
ws.pr.create      (removed; use gh)
```

The new node CLI bridge `intentd hub publish --workspace <id> --agent <id>
--repo <key> --checkpoint <id> --branch <name> --expected-remote-head <oid|absent>
--request-id <uuid>` invokes `hub.publish` with its bound agent capability; it
cannot choose another caller. Then the ordinary `gh pr create --repo owner/repo
--head branch --base main --body-file path` workflow remains usable: on nodes a
`gh` launcher forwards the supported argv and body bytes through the scoped
internal `forge.gh` RPC to head, where the real `gh` binary runs without a shell.
For phase 1 that bridge supports `pr create/view/list/checks/diff`, with explicit
`--repo` restricted to granted repos and published heads; mutation `pr create`
requires the same publish authority. `--body-file` is read on the node and
materialized in a head temp file; paths, arbitrary `api`, aliases/extensions,
`--web`, shell hooks and other commands are rejected, not passed through. Other
GitHub operations use the real `gh` on the authenticated head host. This bridge
does not grant merge permission. Uncertain PR creation is reported with the
request ID and branch for reconciliation via `gh pr list`; it is not replayed.

#### Errors and retirement gates

Besides membership errors above, `-32602` carries `data: { code, detail? }` for
`placement-unavailable`, `node-in-use`, `version-mismatch`, `checkpoint-not-found`,
`checkpoint-invalid`, `inherited-baseline-required`, `request-id-reused`, `unsupported-node-operation` and, after
retirement only, `isolation-removed`. `-32005` with `data.code: "conflict"` rejects
a stale expected ref/head. `-32603` with `data.code` `node-offline`,
`checkpoint-failed` or `rpc-outcome-unknown` reports runtime failure, with
`requestId?` for reconciliation. Errors redact credentials. Merge `conflict` and
`blocked` are successful domain results, not RPC errors. Link authentication
failure closes the private connection before dispatch.

Landing sequence within phase 1:

1. Land additive documentation; implement backend nodes/hubs and local replacement.
2. Prove local/remote merge and recovery parity, and ship replacement FE callers.
3. Remove per-agent CoW runtime, prompts, defaults, schemas, settings controls and
   routes. Reject explicit `isolation: "cow"` before side effects; removed
   `sandbox.cow.merge`/`sandbox.cow.discard` return normal `-32601`. Old persisted
   CoW preferences are ignored with a retirement notice, never converted into a
   new placement. Old live sandboxes are not resumed or migrated; expose a recovery
   notice naming retained files without auto-deleting or reusing them.
4. After component removal and automated pin advancement, remove obsolete
   canonical method/event entries. Existing `sandbox:cow:*` entries stay until then.

Keep workspace `checkoutMode: "cow"`, repo-cache hydration and clonefile/FICLONE
tests. An isolated local node checkout uses reflink when available, otherwise a
standalone repo-cache Git clone with local alternates; never the shared fallback
of the old per-agent sandbox path. No alias, live migration or automatic legacy
directory cleanup is introduced. Disabling remote placement after retirement
leaves the new local node available; it does not restore per-agent CoW.

#### Daemon-to-daemon remote machines (prepared)

Prepared, not implemented at the pinned daemon. Any regular daemon can run
agents for another daemon (the *backend*), but only after the machine's
**owner** exposes it to that backend. The machine mints a scoped, revocable
executor credential for one backend; the backend stores the machine's routes,
certificate pin and credential, and connects on demand over the
[executor link](../node-link.md#daemon-to-daemon-executor-link-nodeprotocol-6).
This contract does not advertise or require `agentNodes`; it reuses the
documented `placement` object and the
[experimental subset](#experimental-single-node-subset)'s placed-agent fields.

##### Capability

`client.hello.server.capabilities.remoteMachines: 1` means the daemon
implements the backend methods below **and** `experimental.remoteAgents` is on.
It is separate from `agentNodes`, whose complete-contract rule is unchanged.
The frontend offers **Make available to <current backend>** only while the
current backend advertises it. The machine-side `executor.*` methods are not
gated by the capability: an older machine answers `-32601`, which the frontend
shows as "update Intent on <machine>".

##### Machine methods: executor credentials

Owner-only: the local UDS seat or a WSS connection admitted with the owner
token. They are on neither the collaborator nor the member allowlist, so guests
and members get `-32003`, and the service rechecks the owner role.

| Method | Params | Result |
| --- | --- | --- |
| executor.mint | backendId (req), backendName (req, 1-128 UTF-8 bytes), backendFingerprint? | `{ credentialId, token, machine: { daemonId, name, platform: { os, arch }, port, hosts, tcAddress?, fingerprint } }`; creates one credential for that backend; `token` (32 random bytes, hex) is returned once and never logged; fails `-32602` `remote-agents-disabled` while `remoteAgents.enabled` is off |
| executor.list | — | `{ backends: [{ credentialId, backendId, backendName, backendFingerprint?, createdAt, lastUsedAt?, connected, runningAgents }] }`; unrevoked credentials only; never returns tokens |
| executor.revoke | credentialId (req) | `{ ok: true }`; sets the credential revoked, closes its live executor connections with `1008`, stops its agents and refuses replays with `401`; an already revoked id is a no-op; an unknown id is `-32602` `not-found` |

Minting again for the same `backendId` creates another credential; the earlier
one stays valid until revoked. `machine.hosts`, `port` and `tcAddress` are the
routes the machine currently advertises for pairing, and `fingerprint` is its
WSS certificate fingerprint (§1.2).

##### Backend methods: exposed machines

Owner-only on the backend, with the same classification as the executor
methods. Mutations fail `-32602` with `data.code: "remote-agents-disabled"`
while `experimental.remoteAgents` is off.

| Method | Params | Result |
| --- | --- | --- |
| remoteMachines.backendInfo | — | `{ backendId, backendName, fingerprint? }`; the backend's persisted head id and display name, for `executor.mint` |
| remoteMachines.add | machineId (req), name (req), hosts (req, string[]), port (req), tcAddress?, fingerprint (req), credentialId (req), token (req, secret) | `{ machine: RemoteMachine, replacedCredentialId? }`; probes before saving (route race, pin, token, bind, capabilities); on failure saves nothing and fails with `machine-unreachable` or `machine-update-required`; an existing `machineId` is replaced only after a successful probe, and `replacedCredentialId` names the old credential for the caller to revoke |
| remoteMachines.list | — | `{ machines: RemoteMachine[] }`; never returns tokens |
| remoteMachines.remove | machineId (req), stopAgents? (boolean, default false) | `{ ok: true, credentialId }`; with live agents on the machine and no `stopAgents: true` fails `-32602` `machine-in-use` with `runningAgents`; with `stopAgents: true` it deletes nothing until the machine [acknowledges every stop](../node-link.md#stop-acknowledgement-nodeprotocol-7) (at most 30 s), else fails `-32603` `machine-unreachable` with `unconfirmedStops`; the caller revokes `credentialId` on the machine; unknown id is a no-op |
| remoteMachines.refresh | machineId (req) | `{ machine: RemoteMachine }`; connects on demand and reads fresh capabilities; failures update `state` and fail with `machine-unreachable`, `machine-revoked` or `machine-update-required` |

```ts
interface RemoteMachine {
  id: string;                       // the machine's daemon id
  name: string;
  platform?: { os: "linux" | "macos"; arch: "x86_64" | "aarch64" };
  hosts: string[];
  port: number;
  tcAddress?: string;
  fingerprint: string;
  state: "connected" | "disconnected" | "unreachable" | "revoked" | "update-required";
  runningAgents: number;            // this backend's live agents on the machine
  capabilities?: MachineCapabilities; // last report, kept while disconnected
  observedAt?: string;              // when `capabilities` was reported
  addedAt: string;
  lastConnectedAt?: string;
}
```

`MachineCapabilities` is defined in the
[executor link](../node-link.md#capabilities-report). The backend keeps the
machine row with its last report, and the token in its secret store under
`remoteMachines.<id>.token`. A `401` from the machine marks it `revoked`; the
row stays until removed.

`remoteMachine:changed` carries `{ machine: RemoteMachine }`, or
`{ machineId, removed: true }` after removal. It is delivered to owner
connections only and emitted on add, remove, state changes and new capability
reports.

##### Expose flow

1. On an owner machine that is connected and is not the current backend, the
   frontend offers **Make available to <current backend>** with the warning
   that remote agents run code as the machine owner's OS user. It never offers
   it for guest sessions, or when `principal.me` on that connection is not the
   owner.
2. The frontend main process relays, keeping the token out of the renderer and
   never persisting it: `remoteMachines.backendInfo` on the backend,
   `executor.mint` on the machine, then `remoteMachines.add` on the backend.
3. If `add` fails, the frontend calls `executor.revoke` so no orphaned
   credential remains.
4. Exposing the local machine needs its WSS listener or tailcat to be on; the
   frontend offers to turn it on first and reads the routes from
   `server.pairingInfo`.
5. **Stop making available** calls `remoteMachines.remove` on the backend and
   `executor.revoke` on the machine. The owner can also revoke from the
   machine's own settings with `executor.list` / `executor.revoke`, even when
   the backend is gone.

##### Placement across machines

`placement.nodeId` names an exposed machine; `os` / `arch` filter. With
`target: "remote"` and no `nodeId`, the backend:

1. keeps machines whose platform matches, whose provider is installed (not
   `cli-missing` or `prerequisite-missing`), and that list the requested model
   (or no model was requested);
2. for a launch without a profile, also skips machines whose provider status is
   `signed-out` or `auth-failed`; a launch with a selected profile (any launch
   that sends `profileEnv`) ignores the default account's sign-in status;
3. orders those with free capacity by fewest running agents, then most recently
   used;
4. connects on demand, refreshing a stale report first.

So a machine with no default login but a valid selected profile stays a
candidate, and a profile whose credentials fail does so at launch without
marking the machine's healthy default account `auth-failed`. The tool descriptions and
`ws.help("agent")` discovery are in
[model-platform routing](../model-platform-routing.md#exposed-machines-prepared).

##### Node mode

`intentd serve --node`, or the persisted setting `daemon.mode: "node"`, starts
the regular daemon with its own orchestration off: no workspaces, local agents,
hooks, scripts, schedulers, PR or review monitors. Local front doors that would
start such work refuse with `-32003` `data.code: "node-mode"`. Node mode serves
a deny-by-default method list, golden-tested like the collaborator allowlist so
every cataloged method is either listed or refused:

- `client.hello`, `system.status`, `host.status`, `principal.me`;
- `server.pairingInfo` and the `pairing.*` methods, local-only as today;
- `settings.get` / `settings.update` for the `remoteAgents.*`, `daemon.*` and
  `server.*` keys;
- `providers.catalog`, `models.list` and the provider-profile reads;
- `executor.mint`, `executor.list`, `executor.revoke`;
- the update methods the sitter uses.

Any other method is `-32003` with `data.code: "node-mode"`. Adding a method is a
deliberate one-line opt-in plus a test update. The executor link's request list
is a second, separate opt-in.

##### Remote machine errors

Placement keeps `-32602` `placement-unavailable` and its `no-capacity` and
`unsupported-platform` reasons, and adds `machine-unreachable`,
`machine-unknown` (no exposed machine has that `nodeId`) and `machine-revoked`.
For `no-capacity` the machine's limits decide and the launch is **refused, never
queued**. The data adds `limit: "count" | "memory"`, then `runningAgents` and
`agentCap` for `count`, or `chargedMemoryBytes` and `memoryBudgetBytes` for
`memory`, and `retryable: true`, so the delegating model decides what to do.
With several candidates, `machines[]` carries those fields per machine.

```json
{"code":-32602,"message":"No capacity on Build box: 4 of 4 agents running","data":{"code":"placement-unavailable","reason":"no-capacity","nodeId":"d-build-box","limit":"count","runningAgents":4,"agentCap":4,"retryable":true,"observedAt":"2026-10-30T00:00:00Z"}}
```

`model-unavailable` is `-32602`, raised before any launch when no candidate
lists the requested model:

```ts
interface ModelUnavailableData {
  code: "model-unavailable";
  provider: string;
  model: string;
  machines: { nodeId: string; name: string; platform: { os: string; arch: string };
              status: string; models: string[]; observedAt: string }[]; // models: at most 50
  retryable: boolean; // true when a listed report is stale or its machine was unreachable
}
```

Its message is written for the model: "Model X isn't available on <machine>;
it has: …", naming each machine's provider status.

`machine-update-required` (`-32602` from placement, add and refresh) carries
`{ machineVersion, backendVersion, update: "machine" | "backend" }`.
`machine-unreachable` from `remoteMachines.add` / `refresh` is `-32603` with
`attempts: [{ route, error }]`, where `error` is the executor link's code (for
example `node-link-certificate-mismatch` or `node-link-unauthorized`).
From `remoteMachines.remove` with `stopAgents: true` it also carries
`unconfirmedStops: string[]` (agent ids whose stop the machine has not
acknowledged), and `attempts` is empty when the link was up but the
acknowledgements did not arrive in time.
`machine-revoked` from `refresh` is `-32603`. `machine-in-use`,
`remote-agents-disabled` and `not-found` are `-32602`. Errors never include the
token.
