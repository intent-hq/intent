# Single-node platform launch (prepared 11.2)

This additive contract extends [node placement](./methods/nodes.md). It is not
implemented by the recorded component pins. Documentation/static fixtures do not
qualify scheduling, concurrent reservation, native execution or deployment.
No new RPC method, public event, private node protocol, checkpoint or journal
format is allocated here. The private capture proposal is independent.

## Capability and compatibility

Reserve public documented version **11.2** after the prepared 11.1 contract.
`client.hello.server.capabilities.agentPlatformRouting: 1` means **all** behavior
here is implemented, including public and MCP forwarding, discovery/error
rendering, multi-agent capacity admission and the actual preparation handoff.
It requires `agentNodes: 1`; local isolated execution additionally requires
`localNodeIsolation: 1`. Exact value 1 is required; missing, malformed and unknown
values are unsupported. Version alone, renderer Labs, model features and a
successful unknown-field request do not establish support or authorization.
No capability is advertised by this documentation change. Recheck the allocation
against canonical and daemon main before consumer merge; do not reuse another
extension's number. Additive documentation lands before consumer merges; local
development and draft preparation may proceed in parallel after contract review.
Daemon protocol consumers land before frontend protocol consumers.

| Connected capabilities | Permitted client behavior |
| --- | --- |
| No agentNodes | Preserve existing unplaced local calls; refuse a required placement instead of stripping it |
| agentNodes 1 only | Existing complete placement object and documented defaults; no arch, partial objects, new retry fields |
| agentNodes 1 and agentPlatformRouting 1 | Widened placement against one configured node, launch identity and discovery |
| Also localNodeIsolation 1 | Local isolated checkout eligible; otherwise exclude it, with no shared fallback |

Existing complete objects retain their meaning. Existing specialist/workspace defaults govern future requests;
upgrading or enrolling a node alone does not reroute old omitted requests. No manual placement selector or required-choice dialog is
part of creation. Existing agent management and hub operations remain available.
Renderer Labs may gate new UI entry surfaces, never backend/model RPC authority.

## Placement input and propagation

Use the existing `placement` object, not a second `platform` field:

```json
{"taskNoteId":"task-1","placement":{"arch":"x86_64"}}
```

The closed object accepts these optional members:

| Member | Accepted value and meaning |
| --- | --- |
| os | `linux` or `macos`; exact required OS |
| arch | `x86_64` or `aarch64`; exact required architecture, independently of OS |
| target | `local` or `remote`; location filter, not a configured target name |
| checkout | `shared`, `worktree` or `isolated`; absent on a selected object means isolated |
| nodeId | Nonempty opaque enrolled/builtin node ID, at most 128 UTF-8 bytes; exact node filter, never a pool ID |
| exclusive | Boolean, default false; true requires remote isolated placement and an otherwise unreserved node |

Objects, including `{}`, are deliberate whole requests. Null, unknown members,
non-string enums, aliases (for example amd64), invalid IDs and duplicate members
(including escaped equivalent keys) reject before effects. There is no implicit
OS from the head's architecture or cross-product of OS/arch lists. Remote
shared/worktree is invalid. Exclusive with omitted target narrows eligibility to
remote; contradictory explicit local is invalid. A nodeId inconsistent with any
other filter produces no match, not permission to ignore a filter. Complete old
objects keep their checkout value. No explicit isolated intent becomes shared.
Windows and unimplemented acquisition backends are not advertised as executable.

Propagate the same validated object through:

- `agent.create`, single `agent.delegate`, call-level batch defaults and object
  entries in `tasks` (bare task IDs still inherit defaults).
- `agent.wakeOrCreate.create.placement`, only when a new agent is created. Existing
  live/resumable assignments keep their resolved placement; this is not migration.
- `workspace.create.initialAgent.placement`. Workspace creation without an initial
  agent does not schedule one. Validate the initial placement before workspace
  effects; a later capacity failure preserves the created workspace and reports
  initial-agent failure explicitly, without silently spawning locally.
- Specialist `runsOn` and `Workspace.defaultAgentPlacement`. The latter retains
  manager-only workspace.update authority; null clears the stored default.

Choose one whole object: per-task explicit → call explicit → resolved specialist
runsOn → workspace defaultAgentPlacement → legacy local resolution. Explicit `{}` wins, clears lower constraints and uses
isolated checkout. Never merge os/arch/checkout between layers. Specialist runsOn
is a structured object in specialist create/edit/list/get; in Markdown frontmatter
it is a single-line JSON-object scalar. Omission inherits the lower specialist
tier; an empty scalar clears that tier's inherited runsOn (then workspace/legacy
precedence applies); JSON `{}` is an explicit object. Invalid nonempty values fail
creation with invalid-params, not silently ignored defaults. Stored defaults have
no power to bypass caller authorization or supported capability checks.

With no selected object, retain current local
shared/worktree resolution and existing additive-stage CoW behavior. Explicit
legacy isolation selects its existing local compatibility path; it conflicts with
any effective placement object. Workspace cowIsolation is consulted
only on the legacy path, not silently combined with a selected remote route.
Per-agent CoW removal remains separately gated. Workspace checkoutMode cow and
reflink behavior are unchanged.

MCP create/delegate option parsing and their WorkspaceApi forwarding must carry
these values; accepting an unknown JS key alone is not support. Extend the
existing positional `ws.agent.wakeOrCreate` helper compatibly: keep positions
1–5 as taskNoteId, contextMessage, model, messageMetadata and reasoningEffort;
add optional position 6 named options. This sixth argument is prepared, not in
the pinned helper. The trailing closed options object has `create?` (the existing public create
options including placement) and `idempotencyKey?`; never reinterpret the first
five arguments. All existing create-only provider/model inheritance remains
unchanged. `ws.agent.create` and `ws.agent.delegate` accept idempotencyKey in their
existing options object. Workspace initial creation uses the existing outer
workspace idempotencyKey, with a derived initial-agent key, not a new independent
retry that could create a second workspace.

## One configured execution node

This feature admits one configured intentd execution node and multiple agents on
that node. Multiple nodes, pools, priority order and provider acquisition are
future work. No target settings, targetId/targetName abstraction, new settings UI,
provider SDK or singleton database migration is added. Existing many-node storage
and exact per-node lease identities remain valid.

Reuse the existing enrolled NodeRecord and node.register/name contract. For this
feature, the configured remote node is the sole non-removed static registration
owned by this head, including when offline/draining/full. Never choose a different
record because this one is unavailable. Multiple non-removed static registrations
make automatic partial/empty placement ambiguous: fail -32602 with data.code
`node-configuration-ambiguous` before agent creation, rather than sorting records.
Existing complete nodeId selectors keep their exact identity semantics, but this
feature cannot launch on another remote node while the retained selected node has
live/uncertain assignments. Operator reconciliation of registration/lease ownership
is required before changing that selection. Enforce this in admission, not by a
destructive migration or a claim that storage represents only one node.

With no static registration, the builtin local node is the only candidate for
partial/empty requests, subject to its actual platform and local isolation support.
With one static registration, partial/empty requests consider only it. Explicit
legacy local complete placement and unplaced local calls retain existing head-local
behavior; this compatibility path is not a second remote scheduler. Explicit remote
or nodeId filters never silently fall back to the builtin node. Existing complete
specialist/workspace defaults retain their meaning. Enrollment alone neither
creates agents nor changes omitted-call defaults.

Use NodeRecord.name as the genuine configured display name. Add optional nodeName
to resolved agent projections alongside existing nodeId/leaseId; read it from the
bound record, never invent it from nodeId or an isolation label. Legacy rows without
a retained name omit it. No target-name selector exists. Node IDs are opaque
(1–128 UTF-8 bytes); names are 1–128 UTF-8 bytes without control characters. Name
is presentation, not authority; retain its admission snapshot and revalidate the
underlying node identity independently on every effect.

## Multi-agent admission and launch ownership

Authenticate the existing create/delegate/wake/workspace operation first. Platform
matching grants no authority. Match os/arch against the configured node's actual
advertisement; then require current compatible release/link/lease, credentials,
checkout capability, non-draining healthy state and finite agent/memory capacity.
One node may run multiple agents. Its maxAgents is a positive safe integer at most
1024; memoryBudgetBytes is a positive safe integer at most 2^50. Head's trusted
runtime profile provides the finite per-agent memory reservation (1–memoryBudgetBytes),
not model input. Invalid or absent required capacity/profile data fails closed as
configuration failure; no unlimited capacity or silent zero charge is inferred.

A single durable admission transaction, under retained ownership, rechecks current
node/lease identity and the retained head selection (so simultaneous requests
cannot select two remote nodes), pins its configuration/profile revision and complete launch
intent, reserves a slot and memory (plus exclusive-node state when requested),
and binds workspace, agent, run, assignment epoch and lease incarnation before
dispatch. Concurrent requests cannot consume the same last slot or memory.
Exclusive reserves all Intent admission capacity, not the user's physical host.
Idle, preparing, disconnected and uncertain agents retain reservations. An actual
runtime requirement above admitted memory rejects; never undercharge. Do not hold
a database transaction across network I/O. Store assignment rows and sampled free
capacity alone are not execution authority.

The node independently admits the same run using existing trusted preparation,
root, config and source ownership. First prompt delivery waits for actual
preparation and live admission. Definite pre-effect rejection releases capacity
only after old ownership settles; it returns failure, not another-node launch.
Once issuance might have taken effect, retain identity and charge; no fresh run or
local fallback on timeout. Stop/revocation fences issuance and retains in-flight
workers until reconciliation. Restart quarantines uncertain attempts; loading a
row does not restore authority. Separately fenced checkpoint recovery remains its
existing contract, not automatic capacity fallback.

### Idempotency and unknown outcomes

Reuse create.idempotencyKey and add optional idempotencyKey to delegate and
wakeOrCreate (including their MCP paths). Accept 1–128 UTF-8 bytes, no controls.
The key is scoped to authenticated caller identity, workspace and method. Full
intent equality includes all effective creation inputs, platform/checkout,
configured node/profile, specialist and task, while also retaining the original request to detect a changed
explicit input. Freeze defaults/configuration once; a same-key retry does not
re-resolve a changed default. Changed request intent fails with -32602,
`data.code: "idempotency-conflict"`, before effects. Transport JSON-RPC IDs are not
durable keys. Authorize the caller again before returning a stored result.

For a batch, derive per-task keys by SHA-256 of the canonical JSON array
`[parentKey, taskNoteId]` (UTF-8, no whitespace, JSON string escapes as ECMAScript JSON.stringify,
no Unicode normalization); duplicate task IDs reject before
admission. The complete ordered batch intent is bound to parentKey. Existing
held/skipped classification remains; retrying the same batch returns its stored
classification/results, not a fresh attempt to start newly unblocked tasks. A new
intent/key is needed after inspecting those results. Force cannot duplicate an
unresolved launch. Wake's decision and task occupancy are serialized with creation;
the same key must not take the create branch twice or deliver the context twice.
Workspace initial-agent key is SHA-256 of `[workspaceKey,"initialAgent"]` under
the same canonical-array rule and participates in the parent workspace transaction.

When old callers omit a key, allocate it once at admission and include
`launch: { idempotencyKey, state, agentId? }` in create-producing operation results;
state is `pending`, `running`, `failed` or `uncertain`. Batch entries carry their
own launch projection. Workspace results attach it to the initial-agent result.
Never start another agent as a consequence of a lost response. A keyed retry uses
the same operation; without the lost generated key, reconcile the existing task
assignment/agent inventory first. If that cannot identify the operation, report
unknown outcome and require explicit resolution, not blind automatic resubmission.
This cannot deduplicate unrelated legacy unkeyed calls that the client submits as
new intents; do not claim exactly-once delivery for those calls.

Unknown outcomes return -32603 with `data: { code: "launch-outcome-unknown",
idempotencyKey, agentId?, retryable: true }`; retryable means reconcile/retry the
**same key**, not start elsewhere. Pending keyed retries return the same launch
projection. Successful/failed results are durable and do not reissue provider work.
A retained failed attempt does not free native resources merely because its public
state is failed. Terminal evidence must satisfy existing cleanup owners.

Finite launch ledger: at most 16,384 records and 256 MiB aggregate per head;
at most 1,024 unresolved records. Reserve the full intent/response accounting
before dispatch, max 64 KiB per record (large messages/attachments use existing
immutable persisted references plus hashes, not truncation). At capacity reject
before effects with -32603 `launch-ledger-full`; no eviction of uncertain records.
Retain compact keyed tombstones until explicit workspace deletion and all owned
work is settled; deleting only an agent keeps a not-found tombstone for its key
in the surviving workspace. Never expire a key into a new launch. Deleted resources
remain not-found on keyed retry; a deleted workspace identity cannot be reused. Failure/uncertainty retains charged
records; timeouts are not cleanup proof. Configuration changes do not erase fences.

## Model discovery and errors

Use one caller-scoped platform projection for fresh agent tool descriptions,
`ws.help("agent")`, and launch errors. Recompute at each help request, tool-list
refresh and scheduling attempt; include observedAt (UTC RFC3339). Cached discovery
is advisory, never a reservation. Models learn safe platform data only for their
current workspace under existing spawn authority, not node inventory, endpoints,
credentials, lease IDs or other agents. No platform RPC or relaxation of
node.list/lease.list is added.

availablePlatforms and supportedPlatforms are sorted unique arrays of {os,arch}
pairs, each with zero or one entry for this feature. Supported means the configured
candidate's valid platform under caller policy, even when full/offline; available
also requires healthy admissible capacity and required capabilities. Generate
alternatives for the applicable configured/local candidate without the requested
os/arch filter, retaining other restrictions (checkout, location, exact nodeId).
Never expose inaccessible capacity. A pair not supported by that candidate is
unsupported-platform; a matching known pair without capacity is no-capacity. Do
not infer a Cartesian product or advertise a second node. Configuration ambiguity,
invalid capacity/profile and unknown outcomes are separate errors.

Definite no match creates no agent and returns -32602:

```json
{"code":-32602,"message":"No capacity for x86_64; available: none; supported: linux/x86_64","data":{"code":"placement-unavailable","requested":{"arch":"x86_64"},"reason":"no-capacity","availablePlatforms":[],"supportedPlatforms":[{"os":"linux","arch":"x86_64"}],"availableOs":[],"retryable":true,"observedAt":"2026-10-01T00:00:00Z"}}
```

Unsupported-platform has retryable false; no-capacity has true for later admission.
Preserve availableOs as the sorted unique OS projection of availablePlatforms.
Batch errors preserve this data per attempted entry. The typed data and human
message must both contain accurate alternatives. MCP's Error-to-String path must
preserve code, requested constraints, reason and paired available/supported values
in safe text; discarding data without rendering it fails the contract. Help and
errors share the projection. Existing malformed/forbidden/not-found errors remain.

Resolved create/get/list/subscription data carries fully resolved placement
(including actual os/arch), nodeId, leaseId and nodeName when known from admission.
No configured target ID, pool projection or manual placement selector is added.
Existing effectiveIsolation and pending/error semantics remain unchanged.

## Verification boundary

[Prepared cases](./fixtures/nodes/platform-routing.json) and
[standalone static checks](./fixtures/nodes/platform-routing.test.mjs) validate
request/capacity shapes, whole-object precedence and single-node discovery.
Run `node --test docs/protocol/fixtures/nodes/platform-routing.test.mjs`.
These pure checks do not execute a Store transaction, concurrent reservation,
provider spawn, authenticated link, first-message gate, Stop or restart recovery.
Runtime acceptance requires real last-slot races, multi-agent/exclusive/memory
accounting, exact-key replay, uncertain launch/restart retention, same-task
settlement and actual MCP forwarding/error rendering. No multi-node qualification
or future target ordering is claimed.
