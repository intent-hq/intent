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
does not depend on the node flags: retirement does not wait for the local node.
No version/flag is advertised by this docs change.

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

1. Land additive documentation. *(Done.)*
2. *(Done in protocol 16.)* Remove per-agent CoW runtime, prompts, defaults, schemas, settings controls and
   routes. This step does not wait for the in-process local node or its
   isolated-checkout parity; until that node ships, agents that are not placed
   on a remote machine share the workspace checkout. Reject explicit
   `isolation: "cow"` before side effects; removed
   `sandbox.cow.merge`/`sandbox.cow.discard` return normal `-32601`. Old persisted
   CoW preferences are never converted into a new placement, and an omitted
   `isolation` never resolves to `"cow"`. Protocol 17 later retired the
   `workspace.cowIsolation` setting itself (§5.12). A backend sub-agent of a
   remote agent always takes the shared worktree path of
   [backend sub-agents](#backend-sub-agents-of-remote-agents). No live per-agent
   sandboxes exist to carry over, so there is no resume, migration or recovery
   notice: the removal drops the sandbox store rows and session sandbox fields,
   and never touches files on disk.
3. *(Done.)* After component removal and automated pin advancement, remove obsolete
   canonical method/event entries.
4. Implement backend nodes/hubs and the local node, prove local/remote merge and
   recovery parity, and ship replacement FE callers.

Keep workspace `checkoutMode: "cow"`, repo-cache hydration and clonefile/FICLONE
tests. An isolated local node checkout uses reflink when available, otherwise a
standalone repo-cache Git clone with local alternates; never the shared fallback
of the old per-agent sandbox path. No alias, live migration or automatic legacy
directory cleanup is introduced. Disabling remote placement after retirement
leaves the new local node available; it does not restore per-agent CoW.

#### Daemon-to-daemon remote machines

Any regular daemon can run
agents for another daemon (the *backend*), but only after the machine's
**owner** exposes it to that backend. The machine mints a scoped, revocable
executor credential for one backend; the backend stores the machine's routes,
certificate pin and credential, and connects on demand over the
[executor link](../node-link.md#daemon-to-daemon-executor-link-nodeprotocol-7).
This contract does not advertise or require `agentNodes`; it uses the
documented `placement` object through the [placement subset](#placement-subset).
No daemon setting switches it on: the frontend offers remote agents behind its
Labs flag, and the executor credential is the machine owner's consent.

##### Capability

`client.hello.server.capabilities.remoteMachines: 1` means the daemon
implements the backend methods below and is not in [node mode](#node-mode).
It is separate from `agentNodes`, whose complete-contract rule is unchanged.
The frontend offers **Make available to <current backend>** only while the
current backend advertises it. The machine-side `executor.*` methods are not
gated by the capability: an older machine answers `-32601`, which the frontend
shows as "update Intent on <machine>".

`client.hello.server.capabilities.remoteInitialAgent: 1` means
`workspace.create` accepts `initialAgent.placement` under the
[placement subset](#placement-subset). The backend advertises it only together
with `remoteMachines: 1` and omits it otherwise. A backend with
`remoteMachines: 1` but without this flag predates the contract and may ignore
the field and start the initial agent locally, so a client offers a remote
initial agent only for exact integer `1`. `remoteMachines` stays at `1`.

`client.hello.server.capabilities.remoteScripts: 1` means a remote agent's
`ws.script.*` calls are forwarded to the backend and the scripts it starts run
on its machine as machine runs
([scripts of remote agents](./scripts.md#scripts-of-remote-agents-remotescripts-1)).
The backend advertises it only together with `remoteMachines: 1`. Without it,
a remote agent's `script.*` calls are refused and no script row carries
`machineRuns`. The machine side also needs nodeProtocol 8 or later: a protocol 7
machine refuses its agents' `ws.script.*` calls itself, with
`remote-agent-unsupported:`
([mixed versions](../node-link.md#saved-scripts-nodeprotocol-8)). A backend
with `remoteScripts: 1` reports each machine's negotiated `nodeProtocol` on
`RemoteMachine`; while it is below 8, clients show that the machine needs an
update for its agents to use scripts (for example in Settings → Machines).

`client.hello.server.capabilities.cloudMachines: 1` means the backend can start
its own machines on E2B ([cloud machines](#cloud-machines-e2b)). The backend
advertises it only together with `remoteMachines: 1`.
`client.hello.server.capabilities.cloudMachineEntries: 1` means it keeps
several [named E2B entries](#named-e2b-entries); it is advertised only together
with `cloudMachines: 1`.

##### Machine methods: executor credentials

Owner-only: the local UDS seat or a WSS connection admitted with the owner
token. They are on neither the collaborator nor the member allowlist, so guests
and members get `-32003`, and the service rechecks the owner role.

| Method | Params | Result |
| --- | --- | --- |
| executor.mint | backendId (req), backendName (req, 1-128 UTF-8 bytes), backendFingerprint? | `{ credentialId, token, machine: { daemonId, name, platform: { os, arch }, port, hosts, tcAddress?, fingerprint } }`; creates one credential for that backend; `token` (32 random bytes, hex) is returned once and never logged |
| executor.list | — | `{ backends: [{ credentialId, backendId, backendName, backendFingerprint?, createdAt, lastUsedAt?, connected, runningAgents }] }`; unrevoked credentials only; never returns tokens |
| executor.revoke | credentialId (req) | `{ ok: true }`; sets the credential revoked, closes its live executor connections with `1008`, stops its agents, removes its journal and agent checkouts (as for any [inactive credential](../node-link.md#final-stop-nodeprotocol-9)) and refuses replays with `401`; an already revoked id is a no-op; an unknown id is `-32602` `not-found` |

Minting again for the same `backendId` creates another credential; the earlier
one stays valid until revoked. The machine's `agent.memoryUsage` (§5.5) lists the
agents it runs for each backend, tagged `remoteOwner: { backendId, backendName }`,
and `system.status` (§5.7) counts the live links in `remoteLinks`: `backends` on the
machine, `machines` on the backend. `machine.hosts`, `port` and `tcAddress` are the
routes the machine currently advertises for pairing, and `fingerprint` is its
WSS certificate fingerprint (§1.2).

##### Backend methods: exposed machines

Owner-only on the backend, with the same classification as the executor
methods.

| Method | Params | Result |
| --- | --- | --- |
| remoteMachines.backendInfo | — | `{ backendId, backendName, fingerprint? }`; the backend's persisted head id and display name, for `executor.mint` |
| remoteMachines.add | machineId (req), name (req), hosts (req, string[]), port (req), tcAddress?, fingerprint (req), credentialId (req), token (req, secret) | `{ machine: RemoteMachine, replacedCredentialId? }`; probes before saving (route race, pin, token, bind, capabilities); on failure saves nothing and fails with `machine-unreachable` or `machine-update-required`; an existing `machineId` is replaced only after a successful probe, and `replacedCredentialId` names the old credential for the caller to revoke |
| remoteMachines.list | — | `{ machines: RemoteMachine[] }`; never returns tokens |
| remoteMachines.remove | machineId (req), stopAgents? (boolean, default false) | `{ ok: true, credentialId }`; with live agents on the machine and no `stopAgents: true` fails `-32602` `machine-in-use` with `runningAgents`; with `stopAgents: true` it deletes nothing until the machine [acknowledges every stop](../node-link.md#stop-acknowledgement-nodeprotocol-7) (at most 30 s; from nodeProtocol 9 these are [final stops](../node-link.md#final-stop-nodeprotocol-9) and the wait is at most 90 s), else fails `-32603` `machine-unreachable` with `unconfirmedStops`; the caller revokes `credentialId` on the machine; unknown id is a no-op |
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
  nodeProtocol?: number;            // link version negotiated at the last bind, kept while disconnected; absent before the first bind and from backends without remoteScripts
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

##### Machine model lookup

*(Experimental, additive, docs lead implementation.)*
`client.hello.server.capabilities.remoteMachineModels: 1` means the backend
implements `remoteMachines.models`. The backend advertises it only together
with `remoteMachines: 1`. On the wire it is owner-only, with the same
classification as the other backend methods. Agents reach it through the MCP
binding `ws.agent.machineModels(nodeId?, { provider?, model? })`, which maps its
arguments one to one onto the params:

- **Authority.** The binding calls the backend's service in process, not over a
  wire connection, so it does not apply the owner check. Every agent the backend
  runs may call it, whoever drives the workspace. This is the same audience that
  already sees the exposed machines in the tool descriptions, and the result
  carries no more than that list plus full model lists.
- **Availability.** A backend that does not advertise `remoteMachineModels: 1`
  has no binding: `ws.agent.machineModels` is absent from the help text and the
  capability map, and a call fails as any unknown `ws.*` method does.
- **Param name.** `nodeId` matches `placement.nodeId`, the name agents already
  pass when they place a remote agent. It is the same value as `RemoteMachine.id`
  and the `machineId` param of `remoteMachines.refresh` and `remove`.

| Method | Params | Result |
| --- | --- | --- |
| remoteMachines.models | nodeId?, provider?, model? (each a non-empty string, exact match) | `{ machines: MachineModels[] }`; reads the cached reports only (no connect, no refresh); an unknown `nodeId` fails `-32602` `machine-unknown` |

```ts
interface MachineModels {
  nodeId: string;                   // RemoteMachine.id
  name: string;
  platform?: { os: "linux" | "macos"; arch: "x86_64" | "aarch64" };
  state: "connected" | "disconnected" | "unreachable" | "revoked" | "update-required";
  lastConnectedAt?: string;
  observedAt?: string;              // when the report below was taken; absent before the first report
  runningAgents: number;
  providers: {
    id: string;
    status: "signed-in" | "signed-out" | "unknown" | "auth-failed" | "cli-missing" | "prerequisite-missing";
    models: string[];               // the full list from the report, never capped
    modelsStale: boolean;
  }[];
  disabledProviders?: string[];
}
```

1. **Rows.** One row per machine in `remoteMachines.list`, in name order.
   [Cloud machines](#cloud-machines-e2b) are left out, as they are from
   `remoteMachines.list`. A machine with no report yet has `providers: []`.
2. **Filters.** `nodeId` keeps that machine only. `provider` keeps that
   provider's entry only and drops machines that do not report it. `model` keeps
   the providers whose `models` contain it and drops machines with none; a kept
   entry still carries its full `models` list. Filters combine with AND.
3. **Provider fields** are the report's `providers` entries
   ([capabilities report](../node-link.md#capabilities-report)) without
   `visible`. Like that report, they list only providers enabled on the machine;
   `disabledProviders` names the others.
4. **Never exposed:** routes (`hosts`, `port`, `tcAddress`), fingerprints,
   credentials, `nodeProtocol`, `capacity` and other backends.
5. **Staleness.** A report can be up to 1 hour old before placement refreshes it.
   Callers that need the live state call `remoteMachines.refresh` first; admission
   rechecks everything at launch whatever this method returned.

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

##### Placement subset

Remote placement implements part of [placement and creation](#placement-and-creation)
without advertising `agentNodes`. On a backend that advertises
`remoteMachines: 1`, `agent.create`, `agent.delegate` (single and
[batch](#batch-placement)) and `agent.wakeOrCreate`'s creation branch (public
RPC and MCP) accept the closed `placement` object with the same validation. A
remote placement needs `target` omitted or `"remote"` and `checkout` omitted or
`"isolated"`, with optional `os`, `arch` and `nodeId`; `exclusive: true`, and on
`agent.delegate` a remote `placement` combined with `isolation` fail with
`-32602`. With `cloudMachines: 1`, `target: "e2b"` starts the agent on a new
[cloud machine](#placement-on-e2b), from the entry that the optional
`cloudMachineId` names. `placement: { "target": "local" }` (no other
members), from any caller, means "run on the backend": it creates an ordinary
local agent, as if no placement were sent, and on `agent.delegate` it may be
combined with `isolation`. `target: "local"` with `os`, `arch`, `nodeId`,
`checkout` or `exclusive` fails with `-32602`. An omitted placement stays local, except for
[sub-agents of remote agents](#sub-agents-of-remote-agents); `null` is
rejected. Admission picks a machine as in
[placement across machines](#placement-across-machines) and fails with the
documented `placement-unavailable` data (`no-capacity` or
`unsupported-platform`, `availablePlatforms`, `supportedPlatforms`,
`availableOs`, `retryable`, `observedAt`, plus the
[remote machine reasons](#remote-machine-errors)).

Placed agents carry `nodeId`, `leaseId`, `nodeName`, the resolved `placement`,
`effectiveIsolation` (`pending` until the machine reports its checkout ready,
then `isolated`) and `placementError` on detail reads. `agent.list` rows (every
scope) and the [agent collection channel](../06-events.md#69-snapshotdelta-subscription-channels-new-in-intentd)
snapshot rows and `added` / `updated` deltas carry the same `nodeId`,
`nodeName`, `placement`, `effectiveIsolation` and `placementError`, so a list
can show where an agent runs, and its move from `pending` to `isolated`,
without opening it: when the machine reports the checkout ready or a start
failure, the backend publishes `agent:updated`, which reaches the channel as an
`updated` delta. `leaseId` stays detail-only. Local agents omit all of them
(absent, never `null`). An agent placed on E2B also carries `cloudStart`
on both reads while its [sandbox starts](#placement-on-e2b), and no `nodeId`
until the link binds. On nodeProtocol 10 placed agents also carry
[`submodules` and `setup`](#prepared-checkout). The create result adds a `notice` saying the agent starts from the
workspace's last commit and that uncommitted changes are not carried; delegate
and wakeOrCreate results copy `notice`, `nodeId`, `nodeName` and
`effectiveIsolation`. `nodeState`, `checkpoint`, `nodePath`, the `halted` /
`resuming` statuses, the node and hub events, `node.*`, `lease.*`, `hub.*`,
`Workspace.defaultAgentPlacement` and specialist `runsOn` are not part of the
subset. Agent work is exchanged as the hub ref names in the workspace's own
repository instead of a separate hub.

On a backend that also advertises `remoteInitialAgent: 1`, `workspace.create`
accepts `initialAgent.placement` with the same closed object and validation as `agent.create`. The placement checks,
the [remote-compatibility](./provider-profiles.md#remote-compatibility) check
and the model check of [placement across machines](#placement-across-machines),
and admission all run under `workspace.create`'s
[pre-side-effect validation](./workspace.md#51-workspace) ("Pre-side-effect
validation" in its notes): a `-32602` (a malformed or `null` placement, `placement-unavailable`,
`profile-not-remote-compatible`, `model-unavailable` or
`attachments-too-large-for-machine:`, below) creates no workspace, worktree,
event or agent. A placement on a create without a git repository (a
[plain-folder workspace](./workspace.md#plain-folder-workspaces)) is also
refused there with `-32602`, since there is no commit to start from.
`initialAgent.imageBlocks` and `fileBlocks` (including the `metadata` fallback)
reach the remote agent's first turn as for
[any message with attachments to a remote agent](../workspace-routing.md#remote-agents-on-the-executor-link),
including its up-front size check.
After the workspace commits, the initial agent is
created on the chosen machine as by `agent.create`, starting from the new
worktree's `HEAD`: the result's
`initialAgent` carries `nodeId`, `nodeName`, `placement` and
`effectiveIsolation`, and the result adds the same `notice`. If the launch
fails before the reply, the workspace and the initial agent are kept (the
agent keeps its placement with `placementError` and never falls back to
local), and the reply is the subset form of the
[post-creation error envelope](../model-platform-routing.md#per-method-launch-responses):
`-32603` with `data: { code: "launch-failed", retryable: false, workspaceId,
launch: { agentId, state: "failed" }, cause: { code, message } }`, where
`workspaceId` is the created workspace, `agentId` the kept initial agent and
`cause.code` the `placementError.code` (for example `remote-launch-failed`).
No first turn starts; a supplied prompt stays on the agent as
`metadata.initialMessage`. No result accompanies the error and it is never `-32602`; the caller fetches
the workspace by `workspaceId`. A retry with the same `idempotencyKey`
replays that error; it creates no second workspace and does not relaunch. A failure the machine reports after the reply
surfaces on the initial agent like any remote start failure (`placementError`
and `agent:updated`). An omitted `initialAgent.placement` keeps the initial
agent local, as before.

##### Batch placement

A batch `agent.delegate` (`tasks: [...]`) takes a `placement` for the whole
batch, and an object entry `{ taskNoteId, ..., placement? }` takes one for that
task alone. An entry's placement replaces the batch's as a whole object (members
are never merged); a bare task id, or an entry without one, uses the batch's.
A task with no placement from either follows the single-delegation rule: local,
or the parent's machine for a [sub-agent of a remote agent](#sub-agents-of-remote-agents).

Every placement in the call is checked before any task starts, so a malformed
placement (in the batch or in any entry), or a task that would run remotely
(by an explicit or an inherited placement) in a call with `isolation`, fails
the whole batch with `-32602` and starts nothing. Each task the batch starts
is then admitted as its own delegation, in the batch's admission order: a task
that fails admission (`profile-not-remote-compatible`, `model-unavailable`,
`placement-unavailable` or `machine-update-required`) has nothing written for
it and gets the usual error row `{ taskNoteId, title, disposition: "error",
reason }`, where `reason` is the full error text (the message, then the
error's `data` as JSON); the other tasks still start. Started rows are
unchanged: the placed child's `nodeId`, `nodeName` and `notice` are on the
agent, not on the row. The batch admits nothing on the node link itself, so
this needs no node-link change.

##### Sub-agents of remote agents

When a remote agent creates a sub-agent through its `workspace_api`
(`ws.agent.create`, `ws.agent.delegate`, or `ws.agent.wakeOrCreate`'s creation
branch, all [forwarded](../workspace-routing.md#remote-agents-on-the-executor-link)
to the backend) without a `placement`, the default is the parent's machine: the
backend admits the child as if it had sent `placement: { "target": "remote",
"nodeId": <the parent's nodeId> }`. Every normal check runs, in order: the
[remote-compatibility](./provider-profiles.md#remote-compatibility) check, the
machine's state, provider and model checks of
[placement across machines](#placement-across-machines), and its capacity. A
failure returns the normal error (`profile-not-remote-compatible`,
`model-unavailable`, `placement-unavailable` or `machine-update-required`, with
the same `code` and `data`) before any write; the backend never falls back to
another machine or to the backend. Only the message changes: it adds that the
sub-agent defaults to the parent's machine (by name) and that
`placement: { target: "local" }` runs it on the backend instead.

This covers every child of a remote agent's batch `agent.delegate`
(`tasks: [...]`) that gets no placement from the batch or from its entry. To
send a batch elsewhere, give it a [batch placement](#batch-placement):
`{ "target": "local" }` runs every task on the backend, and another `nodeId`
(or `os` / `arch`) sends them to another machine; an entry's own placement
moves only that task. An inherited-placement failure fails only that child,
as for any batch task, and its `reason` carries the same message suffix.

A remote agent's single `agent.delegate` with `isolation` but no `placement`,
or its batch with `isolation` where any task would inherit the parent's
machine, fails with `-32602` before any write: its sub-agents run in a checkout
on the machine (the parent's one on nodeProtocol 13), so `isolation` does not
apply. Per-agent isolation on the backend was removed in protocol 16, so
`placement: { target: "local" }` gives the child the shared workspace checkout.

The child is a placed agent like any other: it carries `nodeId`, `nodeName`,
`placement` and `effectiveIsolation`, and the results carry the `notice`. What
it starts from depends on its machine's link
([sub-agent checkouts](../node-link.md#sub-agent-checkouts-nodeprotocol-13)):

| Child runs on | Parent's machine link at nodeProtocol 13 or later | Older link |
| --- | --- | --- |
| The parent's machine | Works in the parent's checkout: both see each other's uncommitted changes at once, as local sub-agents do. The child's work reaches the backend in the parent's `head` and `wip` refs. | The workspace's last commit |
| Another machine | A copy of the parent's commits and uncommitted changes, pushed when the child is created; later work is not shared, and the child's `head` is merged as usual | The same copy, from the parent's last push (its turn end) |

The `notice` says which. A child on the parent's machine gets its own private
temp folder. "The parent's checkout" is the checkout's owner when the parent
itself shares one. Deleting or retiring the parent removes its checkout: the
machine first stops the children that share it, and their next start fails
`node-checkout-failed`.

An explicit `placement` wins. A remote parent, on a machine or on a
[cloud machine](#cloud-machines-e2b), can send its sub-agent anywhere:

| `placement` | The sub-agent runs on |
| --- | --- |
| Omitted | The parent's machine or sandbox |
| `{ "target": "remote", "nodeId": <a machine> }`, or `os` / `arch` | That machine, admitted as usual; it may be the parent's own |
| `{ "target": "remote", "nodeId": <a sandbox of the chain> }` | That sandbox ([cloud machine rows](#cloud-machine-rows), item 4) |
| `{ "target": "e2b", "cloudMachineId"? }` | A **new** sandbox that the sub-agent owns ([placement on E2B](#placement-on-e2b)), also when the parent itself runs on a sandbox; without `cloudMachineId`, from the entry of the nearest agent in the chain that has one ([entry rules](#placement-on-e2b)) |
| `{ "target": "local" }` | The backend ([backend sub-agents](#backend-sub-agents-of-remote-agents)) |

What the child starts from depends only on where it runs, as in the table
above: on the machine or sandbox the parent runs on (whoever owns that
sandbox), it works in the parent's checkout; anywhere else, including a new
sandbox, it starts from a copy of the parent's work. Every row runs the
normal checks for its target, and a failure never falls back to another
target. A child of an agent that is not remote, and every create made by the
user or another client, keeps the rules above: no placement means local.

###### Backend sub-agents of remote agents

When a remote parent creates a sub-agent with
`placement: { "target": "local" }` (the create's caller is the parent), the
backend first gets the parent's latest work, as for a child on another
machine (steps 1 to 4 of
[parent's work on another machine](../node-link.md#parents-work-on-another-machine)).
The child works in the shared workspace worktree, which the backend never
changes for it (per-agent copy-on-write checkouts were removed in protocol 16).
The create result's `notice` (copied to delegate and wakeOrCreate results)
and the child's instructions name the parent's `head` and `wip` refs, where
that work is saved or will appear once the parent pushes. Getting the parent's
work never fails the create.

###### Who pays for a sandbox an agent starts

A sandbox started for an agent that another agent creates (a sub-agent with
`target: "e2b"`, or a top-level agent that an agent creates with
`target: "e2b"`) runs in the E2B project of its [entry](#named-e2b-entries),
like every sandbox. Its
`cloud.startedBy` is the person behind the creating agent's chain: the
backend walks up from the creating agent (that agent first) and takes the
`startedBy` of the first one that runs on a sandbox; with none, the person
who created that chain's top-level agent; else the backend owner (for
example for an agent created before the backend recorded its creator). That
person is the sandbox's *starter*, so they can `cloudMachines.pause` and
`cloudMachines.kill` it. A sandbox placed by a user or client names that
caller, as before. There is no cap on the number of sandboxes that agents
start; E2B's plan limits are the only limit, and a refused create fails that
agent with `cloud-quota`.

###### When a parent stops

A sub-agent on another machine or sandbox follows the same rules as a local
sub-agent:

1. **Turn stop or pause.** Stopping the parent's turn, or pausing the parent's
   sandbox, does not stop or pause its sub-agents elsewhere. Each sandbox
   pauses on its own idle timer.
2. **Retire.** Retiring the parent cascade-retires its descendants
   ([retire cascade](./agents.md)); each one that is remote gets a
   [final stop](#ending-a-remote-agent-for-good), and a sandbox that one of
   them owns is deleted after its final stop, as in
   [sandbox lifecycle](#sandbox-lifecycle).
3. **Delete.** Deleting the parent does not end sub-agents on other machines
   or on their own sandboxes: they stay, as orphans, like local children, and
   keep their sandboxes until they end for good. Sub-agents that share the
   parent's checkout are stopped with it.
4. **Sandbox owner.** Whoever their parent is, the agents on a sandbox get a
   final stop when the sandbox's `cloud.agentId` ends for good, and the
   sandbox is deleted ([sandbox lifecycle](#sandbox-lifecycle)).

##### Placement across machines

The agent's provider reference must first be
[remote-compatible](./provider-profiles.md#remote-compatibility): a profile, or
a bare base provider whose Default configuration overrides set, an account
folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) fails with `-32602`
`profile-not-remote-compatible` before any write, lease or launch, whatever
machine was named.

`placement.nodeId` names an exposed machine; `os` / `arch` filter. With
`target: "remote"` and no `nodeId`, the backend:

1. keeps machines whose platform matches, whose report lists the provider (a
   machine leaves out providers disabled in its own settings, see
   [enabled providers](../node-link.md#capabilities-report)) as installed (not
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
[model-platform routing](../model-platform-routing.md#exposed-machines).

##### Switching a remote agent's model

`agent.setModel` on a remote agent may change the model, the provider, or both,
including to a profile reference or another base provider. It is accepted when
all of these hold, judged on the agent's machine's cached
[capabilities report](../node-link.md#capabilities-report) without connecting:

1. the target reference is
   [remote-compatible](./provider-profiles.md#remote-compatibility);
2. the machine's report lists the target base provider (it omits providers
   disabled in the machine's own settings) as usable under the placement
   rules: installed (not `cli-missing` or `prerequisite-missing`), and for a
   target without profile environment also not `signed-out` or `auth-failed`;
3. the machine lists the model, under the same alias rule as placement; the
   `"default"` sentinel skips this check.

The provider must still be selectable (registered, enabled, a resolvable
profile) and own the model (§5.5). The cross-provider availability gate does
not apply: the backend's own install and sign-in do not matter, because step 2
judges the machine instead. On success the result and the
`agent:updated` event are unchanged. The current turn finishes on the old
configuration. The next turn stops the agent's provider process on the machine
and starts it again **on the same machine**, in the same checkout, with the new
provider, model and profile environment, replaying the Intent history like a
local [switch](./provider-profiles.md#agent-state-switches-and-replacement). A
remote agent never moves to another machine. If that start fails, the failure
surfaces as any remote start failure does.

Refusals are `-32602` and change nothing:

- `profile-not-remote-compatible` when the target is not remote-compatible;
- `model-unavailable` when the provider is not usable on the agent's machine or
  the model is not listed; `machines` holds only the agent's machine;
- `placement-unavailable` with reason `machine-unknown` or `machine-revoked`
  when the agent's machine is no longer exposed.

`remote-model-change-unsupported` is no longer returned by `agent.setModel`. It
remains a start-path safety net: a remote start whose provider or model changed
by any route other than a validated `agent.setModel` or
[quota failover](./provider-profiles.md#backup-failover) fails with a message
starting `remote-model-change-unsupported:`. Quota failover is the other
accepted switch, and it too picks only remote-compatible backups. A switch or
failover that still reaches the machine on a provider disabled there (its
settings changed after the cached report) is refused by the machine with
`node-provider-unavailable` before any process starts, and surfaces as a remote
start failure.

##### Ending a remote agent for good

`agent.delete`, `agent.retire`, `workspace.retire`, `workspace.delete` and
`remoteMachines.remove` with `stopAgents: true` end a remote agent for good.
Each sends the agent a [final stop](../node-link.md#final-stop-nodeprotocol-9)
instead of a plain stop:

1. The backend durably records the pending final stop, in the same
   transaction that retires or deletes the session.
2. The machine stops the agent's script runs and provider, and makes a final
   push of `head` and `wip` (at most 60 s). The backend accepts that push while
   the record exists, into the workspace's repository, even though the session
   or workspace worktree is already gone.
3. The machine removes the agent's checkout, then acknowledges.
4. The backend drops the record only after the acknowledgement, or after 7
   days without one. It drops the agent's lease row with it for a delete or a
   machine removal; after a retire the lease row stays, so a restored agent
   can launch again: with no checkout on the machine, its launch checks out
   its saved `head` ref (else its base) and restores the `wip` changes on top
   ([relaunch without a checkout](../node-link.md#relaunch-without-a-checkout)). The agent's
   `refs/intent/ws/<workspaceId>/agents/<agentId>/{base,head,wip}` refs stay,
   and so do its `unapplied/<sha>` refs: when a relaunch cannot apply the saved
   `wip`, the machine first pins it there (create-only) and only then starts the
   agent's first turn, whose notice names that ref.

The methods' results and errors are unchanged. Apart from
`remoteMachines.remove`, which waits for the acknowledgements as above, they
return without waiting for the machine. A machine that is offline is redialed
with the usual backoff and gets the final stop after it binds, also after a
backend restart; at that bind an agent whose session is retired or deleted is
stopped for good, never resumed. At each nodeProtocol 9 bind the machine also
removes checkouts of agents the backend no longer records, including a retired
agent with no pending final stop. On a machine below
nodeProtocol 9 the agent is stopped, its work is pushed on a best-effort
basis (the backend accepts the push for 120 s after the acknowledgement), and
its checkout stays until that machine is updated and binds again. The machine
removes the checkouts of a credential that is no longer active on it (revoked
or unknown) at revoke, at bind and at startup, never another active
credential's.

##### Prepared checkout

On a link that negotiated nodeProtocol 10, a remote agent's checkout is
[prepared](../node-link.md#prepared-checkout-nodeprotocol-10) like the
backend's worktree: every submodule populated in the workspace worktree is
checked out at the commit checked out there (its `HEAD`, which may be ahead of
the gitlink or exist only on the backend), and the workspace's setup script
runs on the machine before the agent starts. The agent's own submodule commits
and edits come back as per-submodule `head` and `wip` refs in each submodule's
repository; nothing is merged automatically.

Placed agents gain two members:

```ts
interface RemoteSubmodulePin { path: string; commit: string } // path from the superproject root

interface RemoteSetupStatus {
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  exitCode?: number;
  error?: string;              // "<code>: <detail>", e.g. "node-setup-timeout: …"
  startedAt?: string;          // UTC RFC 3339
  finishedAt?: string;
  output?: string;             // detail reads only: the last 256 KiB of checkout and setup output
  outputTruncated?: boolean;   // detail reads only: earlier output was dropped
}
```

- `submodules: RemoteSubmodulePin[]` is on detail reads only. It lists the
  pins captured at creation, parents first, and is empty when the worktree had
  no populated submodule.
- `setup?: RemoteSetupStatus` is on detail reads, `agent.list` rows and the
  agent channel rows and deltas (rows omit `output` and `outputTruncated`). It is
  absent until the first protocol 10 launch. `pending` means the machine is
  preparing the checkout, `running` that the script runs; while
  `effectiveIsolation` is `pending` a client can show "Preparing checkout" or
  "Running setup". `skipped` means the workspace has no setup script.
- The backend publishes `agent:updated` on every `state` change and, while
  output arrives, at most once every 2 s. A failed setup does not set
  `placementError`: the agent still starts, and its first turn carries the
  setup-failure notice. A failed checkout sets `placementError`
  `node-checkout-failed` as before.
- A submodule populated in the agent's checkout that is not one of the
  checkout's pins (the setup script initialized it on the machine, for example
  from the submodule's own remote, or an earlier session did) is not carried:
  its commits and edits are not sent back. On a prepared-checkout launch
  (nodeProtocol 10), after setup, the machine checks the checkout at every
  launch, also for a sub-agent that shares it. When it finds such a submodule,
  the agent's first turn of that launch carries a notice naming it ("packages/ios
  was populated on this machine (by the setup script or an earlier session), not
  carried from the backend; changes there won't be sent back to the backend"),
  and the agent's own `ws.workspace.details().setupStatus` lists it as
  `unsentSubmodules: string[]` (paths from the superproject root, top-most
  only). Neither is set when every populated submodule is a pin.
  `unsentSubmodules` is agent-facing only: it is not a `RemoteSetupStatus`
  member and is not on the backend's agent rows.
- `setup` describes the agent's checkout on its machine, never the backend
  worktree. The workspace's own `setupStatus` and `workspace:setup:*` events
  are unchanged.

When the worktree has populated submodules, the create `notice` (copied by
delegate and wakeOrCreate) adds that uncommitted changes inside submodules are
not carried either, and when the workspace has a setup script, that it runs on
the machine before the agent starts.

**Older machines.** A workspace whose worktree has a populated submodule or
that has an effective setup script needs nodeProtocol 10. Placing an agent of
such a workspace on a machine whose link negotiates below 10 fails `-32602`
`machine-update-required` with `update: "machine"` and
`reason: "prepared-checkout"`, before any write; this covers `agent.create`,
`agent.delegate`, `agent.wakeOrCreate`'s creation branch and
[inherited sub-agent placement](#sub-agents-of-remote-agents). For
`workspace.create`'s initial agent the check runs once the worktree exists:
the workspace is created and the create reports the `launch-failed` error
above, with `cause.code` `remote-launch-failed` and the
`machine-update-required` message as `cause.message` (also the agent's
`placementError.detail`). The message reads "Update Intent on <machine> to run agents for this
workspace: it has submodules or a setup script." An agent created this way
whose machine later links below 10 does not start: it gets
`placementError.code` `machine-update-required`. Agents created before the
backend supported nodeProtocol 10 have no pins, omit `submodules` and `setup`,
and keep running as before on every link. Workspaces that need neither run on
every supported link.

##### Forge token for remote agents

On a link that negotiated nodeProtocol 15, the backend passes the GitHub token
it already resolves to the machine, in memory
([forge token on the machine](../node-link.md#forge-token-on-the-machine-nodeprotocol-15)).
No method, setting or result member is added; the existing
`sourceControl.github.exposeGitCredentialToChildren` setting (default on) also
gates it.

- **Every remote agent** gets the token as `GH_TOKEN`, so `gh` works on the
  machine.
- **A top-level agent** (`isSubAgent: false`) of a GitHub workspace also gets
  `origin` set to the workspace's GitHub repository, the workspace branch as
  its upstream (on an agent-local branch) and a credential helper, so
  `git push` and `gh pr create --head <branch>` work. This includes the initial
  agent of a workspace started on a cloud machine. All top-level remote agents
  of a workspace push to the same branch; a second writer pulls or rebases
  after a non-fast-forward reject, and the backend's worktree is not updated.
- **A sub-agent** has no credential helper, and hands its work back through
  its refs as before. On a link below 17 its own checkout has no `origin`; one that shares a
  top-level agent's checkout sees that checkout's `origin` and upstream. On a
  nodeProtocol 17 link its `git fetch origin` goes through the backend, which
  refreshes from GitHub first, so `origin/<branch>` matches GitHub at the last
  successful refresh; its
  `git push` to the workspace repository is refused
  ([sub-agent fetch](../node-link.md#sub-agent-fetch-through-the-backend-nodeprotocol-17)).
  It is told to use `gh` for reads only. This
  is a convention only: the token is not read-only, and nothing stops a
  sub-agent that pushes or writes with it.
- The token is the backend's full token. The model can read it from the
  provider's environment for the agent's lifetime.
- On a link below 15, or with no token, remote agents get no `GH_TOKEN`, as
  before. In a workspace whose `origin` is not on GitHub, they get `GH_TOKEN`
  but no `origin`.

The machine answers a `forgeToken` frame it cannot accept with the fixed code
`forge-token-invalid`. It is a link reply code, not a public error: no method
returns it.

##### Commit identity for remote agents

Every remote agent, sub-agents included, commits with the `user.name` and
`user.email` the backend's git config resolves for the workspace's checkout at
each launch
([commit identity](../node-link.md#commit-identity)). The machine sets them as
`GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the agent's environment only. When the
backend resolves no identity, nothing is set, and a commit fails or falls back
to the machine's own git identity. No method, setting or result member is added, and a machine
from before starts its agents as before.

##### Cloud machines (E2B)

A *cloud machine* is a remote machine that the backend starts itself, in an
[E2B](https://e2b.dev) sandbox, with an E2B API key that the backend owner
saved in a [named entry](#named-e2b-entries). Each
sandbox runs a normal intentd daemon with a fresh identity and is used as an
exposed machine over the unchanged
[executor link](../node-link.md#cloud-machines). The backend creates one
sandbox for each agent placed with `target: "e2b"`, top-level or sub-agent;
that agent's sub-agents share it unless they are given another
[placement](#sub-agents-of-remote-agents). The sandbox pauses when it is idle and is deleted when its agent
ends for good.

`client.hello.server.capabilities.cloudMachines: 1` means the backend
implements the methods, placement, fields, event and errors in this section.
The backend advertises it only together with `remoteMachines: 1`, so never in
[node mode](#node-mode). Without it, `target: "e2b"` is `-32602`
`invalid-params`, and a client shows no cloud machine. The flag grants no
authority.

###### Cloud machine methods

| Method | Who | Params | Result |
| --- | --- | --- | --- |
| cloudMachines.configure | Owner | cloudMachineId? (the entry to update; omit to create one), name? (1-64 UTF-8 bytes; required to create a new entry), provider? (`"e2b"`, the only value; default `"e2b"`), apiKey? (secret; required to create an entry unless `apiKeyFrom` is given), apiKeyFrom? (the `cloudMachineId` of another entry whose saved key this entry copies), size? (one of the entry's `sizes`; default `"4x8"`), idlePauseMinutes? (1-1440, default 10), pausedDeleteDays? (1-30, default 7), templateProject? (E2B project slug that publishes the templates; default Intent's E2B project), validateOnly? (boolean, default false) | `{ provider: CloudMachineProvider }`; creates or updates one entry ([which entry](#named-e2b-entries)); with `apiKey` or `apiKeyFrom`, tests the key with one E2B read before it saves anything; an omitted member keeps its saved value. With `validateOnly: true` it saves nothing and emits no event: it tests the given key (or else the entry's saved one; with neither it fails `cloud-machine-unavailable` reason `not-configured`) and checks that the template `<templateProject>/intent-node-<size>:<intentdVersion>` exists, then returns the entry as it would be saved, with `state: "ready"`. Any failed test is an error, never a result: a rejected key is `key-rejected`, a missing template `template-missing`, an E2B failure `api-error` (all `cloud-machine-unavailable`). A normal save runs the same tests first |
| cloudMachines.list | Owner, members | — | `{ providers: CloudMachineProvider[], machines: RemoteMachine[] }`; `providers` are the entries, in creation order; `machines` are the live cloud machines of every entry, each with `cloud`; a member sees only the machines of workspaces they can manage; never returns a key |
| cloudMachines.remove | Owner | cloudMachineId? (the entry; default `"e2b"`), provider? (`"e2b"`, the only value), stopAgents? (boolean, default false) | `{ ok: true, unconfirmedStops: string[] }`; removes one entry; with any sandbox of that entry (running or paused) and no `stopAgents: true` fails `-32602` `machine-in-use` with `runningAgents`; with `stopAgents: true` sends each agent on that entry's sandboxes a final stop, waits at most 90 s, then deletes those sandboxes, their machine rows, the entry and its key ([removing an entry](#named-e2b-entries)); an id that names no entry is a no-op, and any other `provider` is `-32602` `invalid-params` |
| cloudMachines.pause | Owner, starter | machineId (req) | `{ machine: RemoteMachine }`; pauses the sandbox now; while an agent on it has a running turn fails `-32602` `machine-in-use` with `runningAgents`; an already paused sandbox is returned unchanged |
| cloudMachines.kill | Owner, starter | machineId (req) | `{ ok: true, unconfirmedStops: string[] }`; sends each agent on the sandbox a final stop (resuming a paused sandbox first), waits at most 90 s, then deletes the sandbox and its machine row even when stops are unconfirmed |

- **Who.** *Owner* is the local UDS seat or a WSS connection with the owner
  token. *Members* are [shared-host members](./shared-host-membership.md#member-execution-and-safe-host-reads),
  who can also place agents on E2B: their agents spend the owner's E2B
  account, with no per-person cap. *Starter* is the principal in
  `cloud.startedBy`: the caller of the placing method, or for a placement made
  by an agent the person behind its chain
  ([who pays](#who-pays-for-a-sandbox-an-agent-starts)). Others get `-32003`.
  Guests get none of these methods.
- **Unknown machine.** A `machineId` that names no cloud machine is `-32602`
  `not-found` for `pause` and `kill`.
- **Unconfirmed stops.** `unconfirmedStops` lists the agent ids whose final
  stop was not acknowledged in time. Their pushed `head` and `wip` refs stay;
  work they did not push is lost with the sandbox. Unlike
  `remoteMachines.remove`, which keeps the machine and fails `-32603` when stops
  go unconfirmed, `kill` and `remove` delete the sandbox anyway: a sandbox costs
  money while it runs, and a broken one must still be removable.
- **Key.** An E2B API key belongs to exactly one E2B project; an entry's
  sandboxes run in that project, under its plan and limits. The backend keeps
  each entry's key in its secret store under `cloudMachines.<cloudMachineId>.apiKey`
  (`cloudMachines.e2b.apiKey` for the entry `"e2b"`). An entry holds only this
  reference; `apiKeyFrom` copies the other entry's key into the new account, so
  removing either entry never removes the other's key. A key never appears in a
  result, event, log, `Debug` output, error or the sandbox.
- **Routing.** The methods are daemon-global, take no `workspaceId` and are
  [excluded from workspace routing](../workspace-routing.md#excluded-methods-and-variants).

```ts
interface CloudMachineProvider {               // one named entry
  id: string;                              // the cloudMachineId: "e2b" or "e2b-<12 lowercase hex>"
  provider: "e2b";                         // the cloud provider kind
  name: string;                            // the entry's name, for example "E2B" or "Team project"
  state: "ready" | "key-rejected" | "unreachable"; // result of the last E2B call
  template: string;                        // the template the backend starts: "<templateProject>/intent-node-<size>:<intentdVersion>"
  templateProject: string;                    // E2B project slug that publishes the templates
  agentProviders: string[];                // base provider ids whose CLIs the templates install, for example "claude-code"
  sizes: CloudMachineSizeInfo[];           // published sizes for this intentd version, smallest first
  size: CloudMachineSize;                  // the size new sandboxes use
  idlePauseMinutes: number;
  pausedDeleteDays: number;
  configuredAt: string;
  checkedAt?: string;                      // last successful E2B call
}

type CloudMachineSize = "2x4" | "4x8" | "8x16" | "16x32"; // <vCPU>x<GiB>

interface CloudMachineSizeInfo {
  id: CloudMachineSize;
  vcpu: number;                            // 2, 4, 8, 16
  memoryMiB: number;                       // 4096, 8192, 16384, 32768
  plan: "hobby" | "pro-raised-limits";     // the lowest E2B plan that allows it
}
```

Each size is its own template. With every intentd release Intent publishes, under
`<templateProject>/`, each tagged `<intentdVersion>` and `latest`:

| Size | Template | vCPU | Memory | E2B plan |
| --- | --- | --- | --- | --- |
| `2x4` | `intent-node-2x4` | 2 | 4 GiB | Hobby |
| `4x8` (default) | `intent-node-4x8` | 4 | 8 GiB | Hobby |
| `8x16` | `intent-node-8x16` | 8 | 16 GiB | Pro with raised limits |
| `16x32` | `intent-node-16x32` | 16 | 32 GiB | Pro with raised limits |

E2B's Hobby plan caps a sandbox at 8 vCPU and 8 GiB. Pro allows more only after
E2B support raises the project's limits. The same limits apply to the publisher
E2B project that builds the templates, so a release skips (with a warning) a size whose
build E2B refuses for resource limits, and does not fail. A skipped size gets no
`<intentdVersion>` tag, and its `latest` tag stays on the last release that
built it. The `plan` column of `sizes` describes E2B's plans; it does not depend
on `templateProject`.

- **Published sizes only.** `sizes` lists only the sizes whose
  `<templateProject>/intent-node-<size>:<intentdVersion>` tag exists. The backend
  checks the tags on `configure` (also with `validateOnly`) and on
  `cloudMachines.list` when its last check is older than 1 hour. A failed check
  keeps the last known list (empty before the first success). A change of
  `sizes` emits `cloudMachine:changed` with the provider.
- **Saved size not published.** The saved `size` (or the default `4x8`) stays
  saved and reported even when it is not in `sizes`, for example after a backend
  update. Starts then fail with `cloud-machine-unavailable` reason
  `template-missing`. `configure` checks the template only when the call
  creates an entry or gives `size`, `templateProject`, `apiKey` or
  `apiKeyFrom`, so other edits still save.
- **Choosing a size.** A `size` that is not a `CloudMachineSize` is `-32602`
  `invalid-params`. A known size whose tag is not published is
  `cloud-machine-unavailable` reason `template-missing`.
- **Plan refusal.** `configure` saves a published size on any plan. When E2B
  refuses the create because the project's plan or limits do not allow the size,
  the agent gets `cloud-quota` with `limit: "plan"`. The backend never starts a
  smaller size in its place.

###### Named E2B entries

The owner can save several E2B *entries*. Each entry has its own id, name, key
(so entries can use different E2B projects), template project, size,
`idlePauseMinutes` and `pausedDeleteDays`. Every `CloudMachineProvider` row is
one entry, and every sandbox belongs to the entry it started from. A backend
that keeps entries advertises `cloudMachineEntries: 1`. Clients send
`cloudMachineId`, `name` and `apiKeyFrom` only when it is exactly `1`.

- **Ids.** The backend picks the id when it creates the entry and never
  changes it: `"e2b"` while no entry has that id, else
  `"e2b-<12 lowercase hex>"`. A `cloudMachineId` that is not a string of at
  most 64 bytes is `-32602` `invalid-params`. A string that names no entry
  gets a different answer on each method, on purpose:

  | Method | Unknown `cloudMachineId` |
  | --- | --- |
  | `configure` (and its `apiKeyFrom`) | `-32602` `not-found` |
  | `remove` | No-op `{ ok: true, unconfirmedStops: [] }`, so a repeated remove succeeds |
  | Placement | `-32602` `cloud-machine-unavailable` reason `not-configured` |

- **Names.** 1-64 UTF-8 bytes after trimming, with no control characters,
  unique among the entries without regard to case. An empty, too long or taken
  name is `-32602` `invalid-params`. Renaming an entry renames its machine rows
  (each emits `cloudMachine:changed` with the machine) and sets its agents'
  `nodeName` (each publishes `agent:updated`).
- **Limit.** At most 16 entries. Creating a 17th is `-32602` `invalid-params`.
- **Which entry `configure` writes.** With `cloudMachineId`, that entry.
  Without it, and with `name`, a new entry. Without both (the call an older
  client sends), the entry `"e2b"`; when it does not exist, the call creates it
  with the first free name of `"E2B"`, `"E2B 2"`, `"E2B 3"` and so on, so it
  never fails on the name. Creating needs `apiKey` or `apiKeyFrom`, else
  `cloud-machine-unavailable` reason `not-configured`. With `validateOnly`, a
  call that would create an entry runs every create check (name, limit,
  `apiKeyFrom`, key, template) and returns the row with `id: ""`.
- **Copying a key.** `apiKeyFrom` names another entry, on create or update. The
  backend copies that entry's saved key into this entry's own secret account
  once: a later key change on either entry does not reach the other. An entry
  with no saved key is `-32602` `not-found`; this entry's own id, or
  `apiKeyFrom` together with `apiKey`, is `-32602` `invalid-params`.
- **Removing an entry.** `cloudMachines.remove` deletes the entry's sandboxes
  (see the method). Agents left on the entry, with no sandbox, lose
  `placement.cloudMachineId`; their next start picks an entry again as for an
  omitted `cloudMachineId` ([placement on E2B](#placement-on-e2b)), so a later
  entry that reuses the id `"e2b"` never inherits them by accident. When E2B
  would not delete a sandbox (for example a rejected key), the backend keeps
  the removed entry's key, hidden from every read, only for the reaper. It
  deletes that key once the reaper finds no sandbox with this backend's
  metadata left in the entry's project.
- **Migration.** A backend that saved one provider before it kept entries
  turns it, at its first start, into the entry `"e2b"` named `"E2B"`, with the
  same settings and the same secret store account. Its sandboxes and agents
  get `cloudMachineId: "e2b"`. Nothing is asked of the owner, and no sandbox
  restarts.
- **Older clients.** An older client reads only the row whose `id` is
  `"e2b"`, and it keys provider upserts and `{ providerId, removed: true }`
  events by id, so events about other entries do not change what it shows. It
  keeps working with the entry `"e2b"`: it configures and removes it, and its
  placements fall back to it ([placement on E2B](#placement-on-e2b)). It does
  not show the other entries, and it still lists and can kill their sandboxes,
  because their machine rows keep `cloud.provider: "e2b"`. When no entry
  `"e2b"` exists, it shows E2B as not configured.

###### Cloud machine rows

Each live sandbox has a machine row with the sandbox daemon's id, like an
exposed machine, plus `cloud`. The row exists from the time the sandbox is
linked until it is deleted. `hosts` is empty and `tcAddress` names the sandbox's
tailcat route. `name` is `"<entry name> · <agent name>"` (cut to 128 bytes),
so two sandboxes can be told apart; agents on it show the entry's name as
`nodeName`, for example `"E2B"`.

```ts
interface RemoteMachine {
  // ...the members above
  cloud?: CloudMachineState;               // only on cloud machine rows
}

interface CloudMachineState {
  provider: "e2b";
  cloudMachineId: string;                  // the entry the sandbox started from
  sandboxId: string;                       // E2B's sandbox id
  state: "running" | "pausing" | "paused" | "resuming" | "stopping";
  template: string;                        // the template this sandbox started from
  size: CloudMachineSize;
  startedBy: { principalId: string; displayName: string | null };
  agentId: string;                         // the agent the sandbox was started for: top-level, or a sub-agent placed with target "e2b"
  workspaceId: string;
  startedAt: string;
  runningSeconds: number;                  // seconds not paused since start, for cost estimates
}
```

Cloud machine rows are not ordinary exposed machines:

1. `remoteMachines.list` and `remoteMachine:changed` leave them out, so an older
   client does not show a sandbox as a machine.
2. `remoteMachines.refresh` and `remoteMachines.remove` treat their ids as
   unknown. Use `cloudMachines.kill`.
3. Placement with `target: "remote"` and no `nodeId` never picks one.
4. `target: "remote"` with a cloud machine's `nodeId` is accepted only for a
   sub-agent whose chain of parents reaches that machine's `cloud.agentId`, in
   the same workspace, from any creation path (`agent.create`,
   `agent.delegate`, `agent.wakeOrCreate`). It places on that sandbox, resuming
   it when paused. This is how sub-agents share the sandbox. Every other caller
   gets `placement-unavailable` with reason `machine-unknown`, as if the machine
   did not exist.

`cloudMachine:changed` carries `{ provider: CloudMachineProvider }` (one
entry), `{ providerId, removed: true }` (`providerId` is the removed entry's
`cloudMachineId`), `{ machine: RemoteMachine }` or
`{ machineId, removed: true }`. It is emitted on configure, remove, each
sandbox state change and each machine row change. It goes to owner connections,
and to member connections for the providers and for the machines of workspaces
they can manage, as `cloudMachines.list` shows them. It never goes to guests and
never carries the key.

###### Placement on E2B

`placement: { "target": "e2b", "cloudMachineId"?: string }` is accepted
wherever the [placement subset](#placement-subset) accepts a remote placement,
including batch entries and `workspace.create`'s `initialAgent.placement`.
`checkout` may be omitted or `"isolated"`. `os`, `arch`, `nodeId` and
`exclusive` fail with `-32602`, and so does `cloudMachineId` with any other
`target`. A placement with `target: "e2b"` always starts a new sandbox for the
placed agent, also from an agent that already runs on a cloud machine. A
sub-agent shares its parent's sandbox only with an omitted placement or the
sandbox's `nodeId` ([sub-agents of remote agents](#sub-agents-of-remote-agents)).
One sandbox serves the agent it was started for (`cloud.agentId`) and the
sub-agents that share it.

The [entry](#named-e2b-entries) is, in this order:

1. With no entry at all: `cloud-machine-unavailable` reason `not-configured`.
2. The entry that `cloudMachineId` names.
3. Without it, for an agent that another agent creates: the entry of the
   nearest agent in the creating agent's chain (that agent first) whose
   `placement.cloudMachineId` is set. Agents on the backend, on other machines,
   or whose entry was removed are skipped.
4. Else the only entry.
5. Else the entry `"e2b"`, so that an older client's placement still starts.
6. Else `cloud-machine-unavailable` reason `entry-required`, whose `entries`
   name every entry so that the caller can choose one.

The resolved placement always carries the entry's `cloudMachineId`, on the
reply and on later reads, and a new sandbox for the same agent (an
[agent without a sandbox](#sandbox-lifecycle)) uses the same entry while it
exists.

Admission runs these checks in order, before any write, sandbox or charge. Checks
2 and 3 also run for every agent placed onto an existing sandbox (a sub-agent
with an omitted placement or the cloud machine's `nodeId`) and
for every relaunch on a new sandbox, because every launch on a cloud machine
carries a `profileEnv`:

1. The entry exists and its key is not known to be rejected, else
   `cloud-machine-unavailable` with `reason` `not-configured` (also for a
   `cloudMachineId` that names no entry) or `key-rejected`.
2. The provider reference is
   [remote-compatible](./provider-profiles.md#remote-compatibility), else
   `profile-not-remote-compatible`.
3. The launch sends a `profileEnv`, else `cloud-profile-required`. A sandbox
   has no login of its own. A configuration sends one when its `env` has at
   least one `kind: "set"` entry: an API-key profile, an env-only subscription
   token such as `CLAUDE_CODE_OAUTH_TOKEN`, or a Default configuration that sets
   such variables. The Default configuration with no overrides sends none, even
   though it is `remoteCompatible`. Clients use the same rule on the
   [profile reads](./provider-profiles.md#remote-compatibility) to show which
   configurations can run on E2B. For an agent on a cloud machine,
   `agent.setModel` to such a configuration fails with `cloud-profile-required`,
   and [backup failover](./provider-profiles.md#backup-failover) skips it.
4. The base provider is in the entry's `agentProviders`, else `model-unavailable`
   with an empty `machines` and `retryable: false`. The model is checked only
   when the sandbox reports its capabilities.

The reply then returns the agent with `placement.target: "e2b"`,
`placement.cloudMachineId`, the entry's name as `nodeName`,
`effectiveIsolation: "pending"`, no `nodeId`, and `cloudStart: { step }`. The backend starts the sandbox after the reply:

| Step | Work |
| --- | --- |
| `creating-sandbox` | Create the sandbox from the entry's template with the entry's key, with the backend's metadata |
| `starting-daemon` | Start intentd and tailcat in the sandbox, then mint its executor credential |
| `connecting` | Add the hidden machine row and bind the executor link |

When the link binds, the agent gets `nodeId` and loses `cloudStart`; the
checkout and setup continue as for any
[remote agent](#prepared-checkout). Each step change publishes
`agent:updated`. A message sent while the sandbox starts waits for the start.
A start failure sets `placementError` (`cloud-quota`,
`cloud-machine-unavailable`, or `model-unavailable` when the sandbox reports no
such model), clears `cloudStart`, deletes the sandbox if one was made, and leaves
no machine row. The agent never falls back to local. When an
[agent without a sandbox](#sandbox-lifecycle) starts a new one, `cloudStart`
comes back for that start and a new start clears the old `placementError`.

###### Sandbox lifecycle

A sandbox is *busy* while any agent on it has a running turn, a queued
message, a pending permission request, or a live script run on the machine
(`machineRuns`). Otherwise it is *idle*.

| Event | Backend action |
| --- | --- |
| Sandbox busy | Keeps the sandbox's E2B timeout ahead of now. E2B pauses the sandbox, never kills it, if the timeout runs out. |
| Sandbox idle for its entry's `idlePauseMinutes` | Pauses the sandbox. The link drops; memory and the checkout stay. |
| New message for an agent on a paused sandbox | Resumes the sandbox, redials the link with a new generation and replays the journal. |
| Agent ends for good ([ending a remote agent](#ending-a-remote-agent-for-good)) | Final stop, then deletes the sandbox and its machine row. A paused sandbox is resumed first. |
| `cloudMachines.kill` or `remove`, or paused for its entry's `pausedDeleteDays` | Resumes a paused sandbox (billed for that short time), sends the final stop, then deletes the sandbox. If the resume fails, deletes it without a final stop. The agent becomes an agent without a sandbox (below). |
| E2B removes the sandbox itself | Fails the agent's turn with `cloud-machine-unavailable` reason `sandbox-lost`. |
| A paused sandbox cannot bind after the backend was updated (`machine-update-required`) | Deletes the sandbox without a final stop. The agent keeps the work it pushed. |
| A sandbox with this backend's metadata and no machine row | Deleted by the backend's reaper, which lists each entry's E2B project with that entry's key. |

**Agent without a sandbox.** When its sandbox is deleted for any reason other
than the agent's own delete, the backend drops the agent's lease and machine
row but keeps the agent, with `placement.target: "e2b"` and no `nodeId`. Its next
message, also after a restore, starts a new sandbox as at placement, and the
launch [relaunches without a checkout](../node-link.md#relaunch-without-a-checkout)
from its saved `head` and `wip`. Work it did not push is lost; its first turn
there gets the [new machine notice](../node-link.md#relaunch-without-a-checkout),
which says so. When its entry was removed, that start picks an entry again
([removing an entry](#named-e2b-entries)).

**Template.** The backend starts only the template tagged with its own exact
intentd version in the entry's size, `<templateProject>/intent-node-<size>:<intentdVersion>`,
where `templateProject` is the entry's setting (default: Intent's publisher E2B project). It
never falls back to another tag: a missing tag fails the start with
`cloud-machine-unavailable` reason `template-missing`. A paused sandbox keeps the
version it started with; it resumes and binds while the nodeProtocol ranges
overlap.

A sub-agent on the sandbox keeps it live like the agent it was started for. The sandbox is
deleted when the agent it was started for (`cloud.agentId`) ends for good;
sub-agents still on it get a final stop first. A sub-agent's own sandbox is
deleted when that sub-agent ends for good, not when its parent does
([when a parent stops](#when-a-parent-stops)).

##### Node mode

`intentd serve --node`, or the persisted setting `daemon.mode: "node"`, starts
the regular daemon with its own orchestration off: no workspaces, local agents,
hooks, scripts, schedulers, PR or review monitors. Local front doors that would
start such work refuse with `-32003` `data.code: "node-mode"`. Node mode serves
a deny-by-default method list, golden-tested like the collaborator allowlist so
every cataloged method is either listed or refused:

- `client.hello`, `system.status`, `host.status`, `principal.me`;
- `server.pairingInfo` and the `pairing.*` methods, local-only as today;
- `settings.get` / `settings.update` for the `remoteAgents.*` (that is,
  `remoteAgents.permission`), `daemon.*` and `server.*` keys;
- `providers.catalog`, `models.list` and the provider-profile reads;
- `executor.mint`, `executor.list`, `executor.revoke`;
- the update methods the sitter uses.

`remoteLinkTraffic.*` ([link traffic capture](#link-traffic-capture)) is not on
the list.

Any other method is `-32003` with `data.code: "node-mode"`. Adding a method is a
deliberate one-line opt-in plus a test update. The executor link's request list
is a second, separate opt-in.

##### Reported daemon mode

A daemon reports its running mode as `daemonMode: "regular" | "node"` in three
places (additive, docs first):

- `client.hello` `server.daemonMode` ([§5.17](./client-hello.md));
- the `host.status` result root ([§5.14](./execution-locus.md));
- the `pairing.getInfo` result
  ([§5.12](../05-method-catalog.md#pairinggetinfo-local-only)).

The value is the mode of the running process, so `intentd serve --node` reports
`"node"` even while the setting `daemon.mode` is `regular`. A pending setting
change is not reported until the next start. Older daemons omit the field:
absence means **unknown**, not regular. For those daemons a client probes once,
after `client.hello`, with a method outside the node-mode list (for example
`workspace.list`). A `-32003` refusal with `data.code: "node-mode"` means node.
A result, or an error without that code, means regular. A transport failure or
timeout leaves the mode unknown, and the client probes again on the next
connection. The field grants no caller authority, and a client reads it again
on every connection because the mode can change across restarts.

##### Node setup and pairing

Setup asks which kind of daemon to run and steers new users to the full daemon.
The installers (`install.sh`, `install.ps1`) ask when they run interactively
(`install.sh` reads `/dev/tty`, so the prompt works under `curl | sh`):

```text
How will you use this computer?
1) Run Intent here (recommended if you're just getting started): workspaces, agents and the app connect to it.
2) Node only: lets another Intent run agents on this computer; nothing else runs here.
```

1. Enter selects option 1 (Run Intent here). Scripted installs use the flag
   `--daemon-mode=full|node` or the environment variable
   `INTENTD_DAEMON_MODE=full|node` (flag, then variable, then prompt). When
   setup is not interactive and neither is set, it uses `full`. `full` is the
   installer name for `daemon.mode: "regular"`. The flag is not `--mode`:
   `intentd serve --mode` already selects connection locality.
2. `full` keeps `daemon.mode: "regular"` and does not pair. `node` sets
   `daemon.mode: "node"` over the local UDS seat, restarts the daemon, then
   runs `intentd pair --tunnel`: the consent prompt, then the network
   interface picker with the Tailcat tunnel row pre-checked. Setup ends by
   printing the QR code and the `intent://pair` link.
3. An unattended node install runs `intentd pair --yes --tunnel` and prints a
   tunnel-only link (empty `host=`, `tc=` present).
4. Without the login service, and in the `.deb` `postinst` (which cannot
   prompt), setup only prints the commands for a node: set `daemon.mode`, start
   the daemon, then `intentd pair --tunnel`.

**Tunnel on by default when pairing (both modes).** The rule depends on
`server.bindAddress`, not on whether the tunnel setting was ever saved: a full
daemon writes every setting to `config.toml` at startup. When `intentd pair`
turns external connections on and every bound address is loopback
(`127.0.0.1` / `::1`; the fresh-install default is `127.0.0.1`), the interface
picker pre-checks the Tailcat tunnel row, and `intentd pair --yes` turns the
tunnel on with the listener. With a loopback-only bind this overrides a saved
`false`, because without the tunnel pairing cannot succeed. The user can still
clear the row in the picker. A bind with any LAN address, or an unspecified
bind (`0.0.0.0` / `::`, which counts as all interfaces), keeps its saved tunnel
choice. This is a deliberate change for full daemons too:
before, `pair --yes` on a fresh install stayed loopback-only and failed with
"listener is bound to loopback only and no tunnel is active"; now it prints a
tunnel link. A full daemon that was never paired does not start the tunnel:
the tunnel starts only when pairing turns external connections on, and a daemon
whose listener is already on is not changed by this default.

`intentd pair --tunnel` sets `server.tunnel.enabled: true` before pairing,
whatever the saved value, so the tunnel row is pre-checked and `--yes` pairs
through the tunnel. The setting is in the `server.*` group, so it is allowed in
node mode.

When `intentd pair` turns the tunnel on (by default or with `--tunnel`):

1. It sends the tunnel change in its own `settings.update`, after the listener
   is on. If the sidecar fails to start, pairing continues with the listener
   alone and prints a warning; the link then has only the direct hosts, or the
   loopback-only error when there are none.
2. It waits for `tcAddress` in `system.status`, with a bounded timeout, before
   it reads `pairing.getInfo`, so the link carries `tc=`.

The pair link of a node carries the hint `mode=node`
([`pairing.getInfo`](../05-method-catalog.md#pairinggetinfo-local-only)). For
`intentd pair --host <h>`, which builds the link from `server.pairingInfo`, the
CLI reads the mode from `host.status` first and adds the same hint. The link of
a regular daemon has no `mode` param, and a link without one means a full
daemon. The hint lets a client choose a section before it connects, but it is
not authoritative: after the credential test the client uses the reported
`daemonMode` (or the probe above) and moves the row if the two disagree.

##### Machines and Nodes in the app

Settings → Machines shows two lists:

- **Machines**: full daemons, which can be the current backend.
- **Nodes**, shown only when there is at least one node, with the description
  "Nodes only run agents." A node never becomes the current backend and never
  opens a backend window.

The client stores the detected kind on the saved connection and checks it again
on each connection. Adding a node by any route (the Add machine dialog, the
**Paste intent:// link** item of the Add machine menu, or opening an
`intent://pair` link) saves it, then asks whether to make it available to the
current backend: **Make available** runs the [expose flow](#expose-flow),
**Not now** keeps the node saved and offers the expose action on its row. The
client accepts a node only when the client offers remote agents and the
current backend can run agents on other machines. It refuses the node when:

- remote agents are off in the client (its Labs flag): the error points to
  Settings → Labs;
- the current backend does not advertise `remoteMachines: 1`: the error names
  the backend, and the user updates it and adds the node again.

A refused node is not saved, on every route, including a node detected only
after its credential test (for example a link without the `mode=node` hint).
The check applies to new and already-saved nodes alike: a refused link changes
nothing. An accepted link for a node that is already saved updates its
credential, and the prompt appears only if the node is not yet available to
the current backend.

The paste item parses the link, tests the credential with `principal.me` and
detects the mode. A full daemon is added to Machines with no dialog; a node is
added to Nodes and gets the prompt above, or is refused as above. Errors show
inline. The pairing token
stays in the main process and the secret store, as for every other saved
connection.

With `cloudMachineEntries: 1`, the Nodes list also shows each
[E2B entry](#named-e2b-entries) by name, with its live sandboxes under it,
because cloud machines only run agents too; Nodes then shows when there is a
node or an entry. Start On lists each entry as "E2B · <name>". Without the
flag, the single E2B provider stays where older clients show it.

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

`profile-not-remote-compatible` is `-32602`, raised before any write by
placement (`agent.create`, `agent.delegate`, `agent.wakeOrCreate`'s creation
branch) and by `agent.setModel` on a remote agent when the provider reference
is not [remote-compatible](./provider-profiles.md#remote-compatibility):

```ts
interface ProfileNotRemoteCompatibleData {
  code: "profile-not-remote-compatible";
  providerRef: string;               // the reference as given (a profile ref or a bare base id)
  reason: "account-folder" | string; // open enum, as on RemoteIncompatibility
  keys: string[];                    // variable names only, never values
}
```

Its message names the configuration and the variable and points to a
configuration that uses the machine's own sign-in or an API key, for example
"Work uses an account folder (CLAUDE_CONFIG_DIR) that only exists on this
backend, so it can't run on another machine; pick a profile that uses the
machine's own sign-in or an API key." It is not retryable: the configuration
must change first.

`model-unavailable` is `-32602`, raised before any launch when no candidate
lists the requested model, and by `agent.setModel` on a remote agent whose
machine does not offer the target provider or model (then `machines` lists
only that machine):

```ts
interface ModelUnavailableData {
  code: "model-unavailable";
  provider: string;
  model: string;
  machines: { nodeId: string; name: string; platform: { os: string; arch: string };
              status: MachineProviderStatus; models: string[]; observedAt: string }[]; // models: at most 50
  retryable: boolean; // true when a listed report is stale or its machine was unreachable
}

type MachineProviderStatus =
  | "signed-in" | "signed-out" | "unknown" | "auth-failed"
  | "cli-missing" | "prerequisite-missing" // the report's own provider status
  | "disabled";                            // provider switched off on that machine
```

`status` is the provider's status in that machine's
[capabilities report](../node-link.md#capabilities-report). When there is no
report or it does not list the provider, the first matching rule applies
(`models` is empty):

1. `disabled` when the report's `disabledProviders` names it: the provider is
   switched off in the machine's own `providers.enabled`, whether or not it is
   installed;
2. `unknown` when the machine has no report yet, or its report lists no
   providers and no `disabledProviders` (the machine has not looked at its
   providers yet);
3. `cli-missing` otherwise, including every absent provider of a machine that
   does not send `disabledProviders` and still lists other providers.

Placement refreshes a machine without a report before deciding; one it cannot
reach is left out of `machines` and makes the error `retryable`. So a
report-less entry comes from `agent.setModel` on a remote agent whose machine
has not reported. `status` is an open set: values may be added without a version
bump, and a client treats an unrecognized value as a generic unavailability.

Its message is written for the model: "Model X isn't available on <machine>;
it has: …", naming each machine's provider status. A `disabled` machine reads
"disabled on <machine>", so the user knows to switch the provider on there
rather than install it.

`machine-update-required` (`-32602` from placement, add and refresh) carries
`{ machineVersion, backendVersion, update: "machine" | "backend", reason? }`.
`reason` is present only from placement, as `"prepared-checkout"` when the
machine links below nodeProtocol 10 and the workspace needs a
[prepared checkout](#prepared-checkout); clients treat an unknown `reason` as
a plain update request.
`machine-unreachable` from `remoteMachines.add` / `refresh` is `-32603` with
`attempts: [{ route, error }]`, where `error` is the executor link's code (for
example `node-link-certificate-mismatch` or `node-link-unauthorized`).
From `remoteMachines.remove` with `stopAgents: true` it also carries
`unconfirmedStops: string[]` (agent ids whose stop the machine has not
acknowledged), and `attempts` is empty when the link was up but the
acknowledgements did not arrive in time.
`machine-revoked` from `refresh` is `-32603`. `machine-in-use` and `not-found`
are `-32602`. Errors never include the
token.

The [cloud machines](#cloud-machines-e2b) add three codes. None of them
carries the E2B key.

`cloud-machine-unavailable` means E2B cannot start or keep a sandbox:

```ts
interface CloudMachineUnavailableData {
  code: "cloud-machine-unavailable";
  provider: "e2b";
  cloudMachineId?: string;           // the entry, when one was named or resolved
  reason: "not-configured" | "key-rejected" | "entry-required" | "api-error"
        | "template-missing" | "bootstrap-failed" | "sandbox-lost" | string; // open enum
  retryable: boolean;
  status?: number;                   // E2B's HTTP status, when E2B answered
  entries?: { cloudMachineId: string; name: string }[]; // only with "entry-required"
}
```

`not-configured` and `key-rejected` are `-32602` from placement and
`cloudMachines.configure` (not retryable: the owner must save a working key).
`entry-required` is `-32602` from placement only, and not retryable: the
placement named no entry, several exist and none is `"e2b"`
([placement on E2B](#placement-on-e2b)); its message lists the entry names.
The others are `-32603` from `cloudMachines.configure`, `pause` and `kill`, or
an agent's `placementError` after the reply: `api-error` (E2B failed or was
unreachable, retryable), `template-missing` (no template tagged with this backend's
exact version), `bootstrap-failed` (intentd, tailcat or the credential mint failed in
the sandbox) and `sandbox-lost` (E2B removed a sandbox that had an agent). The
message says no sandbox was left behind, or that the agent's pushed work is
kept.

When E2B rejects the saved key (for example the owner revoked it at E2B), the
entry's `state` becomes `key-rejected` and `cloudMachines.pause` of its sandboxes fails with
`-32602` `cloud-machine-unavailable` reason `key-rejected`. `cloudMachines.kill`
and `remove` still succeed: they send the final stops they can, then remove the
backend's machine rows and leases. A sandbox E2B would not delete stays in the
owner's E2B account; the reaper deletes it once a working key is saved for
that entry.

`cloud-profile-required` is `-32602`, from placement and from `agent.setModel`
on an agent on a cloud machine, before any write, when the launch would send no
`profileEnv`:

```ts
interface CloudProfileRequiredData {
  code: "cloud-profile-required";
  provider: "e2b";
  cloudMachineId?: string;
  providerRef: string;               // the reference as given
}
```

Its message reads, for example, "Work uses this backend's Claude sign-in, which
E2B can't use; pick a profile with an API key or token." It is not retryable.

`cloud-quota` means E2B refused for a plan limit: too many running sandboxes, too
many requests, or a size the project's plan or limits do not allow (for example
`8x16` on Hobby). Intent sets
no limit of its own.

```ts
interface CloudQuotaData {
  code: "cloud-quota";
  provider: "e2b";
  cloudMachineId?: string;           // the entry whose E2B project refused
  limit: "concurrency" | "rate" | "plan";
  retryAfterSeconds?: number;        // from E2B's Retry-After
  retryable: boolean;                // false for "plan"
}
```

It is `-32602` from `cloudMachines.pause` and `kill`, an agent's
`placementError` when a create is refused, and the turn's error when a resume
is refused. The backend retries a `rate` refusal itself before it reports one.
A `plan` refusal is `retryable: false`: the owner must pick a smaller size, or
use E2B Pro and ask E2B support to raise the project's limits; the message names
both.

##### Link traffic capture

The owner can record the frames of this daemon's
[executor links](../node-link.md#daemon-to-daemon-executor-link-nodeprotocol-7)
to see what crosses them, for example in the frontend's developer console.
Capture is off until the owner starts it, holds a bounded in-memory buffer,
masks secrets before a record enters the buffer, and is cleared when it stops.
It is never persisted and does not survive a daemon restart. While it is off,
the links do no capture work.

`client.hello.server.capabilities.remoteLinkTraffic: 1` means the daemon
implements the methods and event below. A daemon advertises it only together
with `remoteMachines: 1`, so never in [node mode](#node-mode). One daemon
records both roles: as a backend, the links it dials to exposed machines
(`peer.kind: "machine"`); as a machine, the links backends hold to it
(`peer.kind: "backend"`). Only `/node/link` frames are recorded, including the
`hello` / `welcome` handshake; `/node/git` sessions are not.

The methods are owner-only and daemon-global, with the same classification
as `remoteMachines.*`: members and guests get `-32003`. In node mode they fail with `-32003`
`data.code: "node-mode"`.

| Method | Params | Result |
| --- | --- | --- |
| remoteLinkTraffic.start | payloads? (boolean, default `true`) | `{ capture: LinkTrafficCapture }`; turns capture on. While it is already on, it keeps the buffer and only updates `payloads` |
| remoteLinkTraffic.stop | — | `{ capture: LinkTrafficCapture }`; turns capture off and clears the buffer and counters, returning `active: false`, `retained: 0`; a no-op when off |
| remoteLinkTraffic.snapshot | afterSeq? (exclusive), limit? (default 500, max 2000) | `{ capture: LinkTrafficCapture, records: LinkTrafficRecord[] }`; retained records with `seq > afterSeq`, oldest first; empty while off |

A snapshot also stops before its records pass 448 KiB of JSON, so it can return
fewer than `limit` records (always at least one when any match). Page with
`afterSeq` until the last `seq` is `capture.nextSeq - 1`.

```ts
interface LinkTrafficCapture {
  active: boolean;
  startedAt?: string;       // RFC 3339 UTC, while active
  payloads: boolean;        // whether records carry `payload`
  maxRecords: number;       // buffer size, 2000
  maxPayloadBytes: number;  // 65536, measured on the redacted JSON
  retained: number;         // records in the buffer now
  evicted: number;          // records pushed out of the full buffer by newer ones
  dropped: number;          // records lost because the capture queue was full
  oversized: number;        // records kept without their payload because it was too large
  nextSeq: number;          // the seq the next record gets
}

interface LinkTrafficRecord {
  seq: number;              // starts at 1 when capture turns on; a start while on keeps counting
  at: string;               // RFC 3339 UTC, millisecond precision
  direction: "in" | "out";  // relative to this daemon
  peer: { kind: "machine" | "backend"; id: string; name?: string };
  frameType: string;        // the frame's `type`, for example "launch" or "journal"
  agentId?: string;         // when the frame names an agent
  requestId?: string;       // on request, response and cancelRequest frames
  bytes: number;            // the frame's encoded size on the wire
  summary: string;          // one short line, already redacted; on a request frame, names the forwarded workspace method
  payload?: unknown;        // the redacted frame, when `payloads` is on and it fits
  truncated?: boolean;      // true when `payload` was omitted for size
}
```

`peer.id` is the machine's id on a backend and the backend's daemon id on a
machine. `peer.name` is the exposed machine's name on a backend and the
executor credential's backend name on a machine, when it has one.
`seq` restarts at 1 only when a `start` turns capture on from off; a `start`
while capture is on (for example to change `payloads`) keeps the buffer and
continues the sequence, so `snapshot({ afterSeq })` never skips a record.
`frameType` is open: clients show an unknown type as text.
Every `request` frame's method is `workspace.call`, so its `summary` names the
forwarded method from its params instead, for example `note.read`.

The links hand records to capture without waiting: a full capture queue drops
the record and counts it in `dropped`, so capture never delays a frame. A
payload larger than `maxPayloadBytes` is omitted, the record is kept with
`truncated: true`, and `oversized` counts it.

`remoteLinkTraffic:records` carries `{ records: LinkTrafficRecord[], capture:
LinkTrafficCapture }`. It is batched (at most every 250 ms, at most 100
records per event) while capture is on, and delivered like any other event
through [`events.subscribe`](../06-events.md#61-eventssubscribe), to owner
connections only. Every `start` (including one that only changes `payloads`)
and every `stop` that turns capture off also emits it with `records: []` and
the new `capture` state, so every owner client sees capture start and stop; there is
no separate start or stop event. A client calls `snapshot` with the last `seq`
it holds to fill a gap.

**Redaction.** Secrets are masked as `"***"` before a record enters the buffer,
in `payload` and `summary` alike, and this cannot be turned off:

- `launch.profileEnv.env[].value` (a `null` value stays `null`; keys,
  `providerRef` and `fingerprint` stay visible);
- `scriptStart.env[].value` (keys stay visible);
- `secretPut.value` (protocol 14; `agentId` and `name` stay visible);
- `forgeToken.token` (protocol 15; `host` stays visible);
- at any depth of a `request` or `response` frame's params or result, every
  value inside a member named `env`: in the `{ key, value }[]` form each
  `value`, and in the object form each member's value (keys stay visible). This
  covers saved-script environments in forwarded `script.create` params and in
  script rows returned to a remote agent;
- at any depth of any frame, including request params and response results,
  the value of every key whose name contains a match for
  `token|secret|password|credential|authorization|cookie|private.?key|cert`
  (case-insensitive, unanchored), except the identifiers `fingerprint`,
  `credentialId`, `stopId` and `requestId`. A string value becomes `"***"`
  and an object or array value is replaced whole; number, boolean and `null`
  values stay, so usage counts such as `inputTokens` remain readable;
- every string value that starts with `-----BEGIN` (certificates and keys).

The executor token travels in the upgrade request, not in a frame, so it is
never recorded. These rules cover the
[profile environment](../node-link.md#provider-credentials-profile-environment),
[script environments](../node-link.md#saved-scripts-nodeprotocol-8),
[agent secrets](../node-link.md#secrets-on-the-machine-nodeprotocol-14)
and any secret a frame carries.
