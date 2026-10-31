> Part of the [Intent JSON-RPC protocol docs](../README.md) — explicit resource reads.

## 5.52 Explicit GitLab resource reads

| Method | Params | Result |
| --- | --- | --- |
| sourceControl.read.capture | workspaceId | Original read lifetime, scope, revision, retirement cursor and configured instances |
| sourceControl.read.detail | workspaceId, readLifetimeId, target, refresh? | Qualified merge-request snapshot or issue detail with availability and observed quota |
| sourceControl.read.release | workspaceId, readLifetimeId | {released: true} |

**Additive contract.** Require the original connection's
[`repositoryResourceRead: 1`](client-hello.md#resource-read-capability) before
capture. The typed forms and bounds below describe explicit GitLab detail reads;
catalog presence or a numeric protocol version alone does not establish support.
Examples use illustrative identifiers and observations.

The operations are `sourceControl.read.capture`,
`sourceControl.read.detail` and `sourceControl.read.release`, with the private
`sourceControl.read.retired` feed. They let a desktop client read one explicitly
identified GitLab merge request or issue through an already configured instance
and the daemon's existing shared detail caches. The workspace supplies an
authorization boundary; the requested project need not be its default review
target or have a matching local Git remote.

### Capture and configured instances

Capture accepts only `workspaceId` and binds a new opaque read lifetime to the
original physical connection, daemon Services instance and authenticated caller.
For example:

```json
{"jsonrpc":"2.0","id":201,"method":"sourceControl.read.capture","params":{"workspaceId":"workspace-example"}}
```

The complete capture result has these six fields:

| Field | Type and meaning |
| --- | --- |
| `readLifetimeId` | Opaque string bound to this capture and original connection. |
| `scope` | `{ daemonId, authorityScopeId, authorityGeneration }`; the first two are opaque strings, and `authorityGeneration` is a canonical decimal u64 string. |
| `revision` | `{ epoch, sequence }`; opaque string epoch and canonical decimal u64 string sequence. Compare only within the same scope and epoch. |
| `expiresAfterMs` | Numeric `300000`, a nonrenewable client discard upper bound measured from the original capture request start, not from response receipt. Earlier server retirement or loss remains authoritative. |
| `retirementSequence` | The original feed's current canonical decimal u64 string cursor. |
| `instances` | Array of token-free `{ provider, instanceBaseUrl, availability }` descriptors. This implementation returns the one admitted configured GitLab instance with `provider: "gitlab"` and `availability: "connected"`. |

For example, with illustrative opaque identifiers:

```json
{"jsonrpc":"2.0","id":201,"result":{"readLifetimeId":"original-read-example","scope":{"daemonId":"daemon-example","authorityScopeId":"original-read-example","authorityGeneration":"7"},"revision":{"epoch":"original-read-example","sequence":"1"},"expiresAfterMs":300000,"retirementSequence":"0","instances":[{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","availability":"connected"}]}}
```

All fields are present. Scope, revision and cursor strings are never rounded
through a JavaScript `Number`. The current producer uses the new lifetime ID as
the revision epoch and starts its revision sequence at `"1"`; these correlation
values are not authority or ordering across lifetimes.

Capture requires approved, paired, settled connection facts. Missing, unavailable,
unsettled, busy or disconnected facts refuse with the sanitized `Forbidden`
described below; there is no unknown/empty descriptor fallback. Descriptors expose
no connection/account identifier, credential generation, token, private policy
handle or provider transport URL. A later installation or account transition
cannot repair the old capture.

A descriptor is a target-recognition hint, not proof of resource access. A public
GitLab URL alone, including one on `gitlab.com`, does not authorize a private read.
Without an eligible configured instance, clients retain the original ordinary
link behavior rather than choosing another provider or account.

### Explicit detail requests

Detail binds `workspaceId`, the original `readLifetimeId`, and the full `target`.
An omitted `refresh` means `false`; an explicit value must be a Boolean. Unknown
fields at the outer, target or repository level, wrong types, explicit `null` and
unsupported target forms are rejected. A lifetime ID is nonempty, at most 128
UTF-8 bytes and contains no control character. The illustrative MR request is:

```json
{
  "jsonrpc": "2.0",
  "id": 202,
  "method": "sourceControl.read.detail",
  "params": {
    "workspaceId": "workspace-example",
    "readLifetimeId": "original-read-example",
    "target": {
      "repository": {
        "provider": "gitlab",
        "instanceBaseUrl": "https://gitlab.example:8443/gitlab",
        "projectPath": "group/subgroup/project"
      },
      "kind": "merge-request",
      "number": 42
    },
    "refresh": true
  }
}
```

Issue detail uses the same repository identity with `kind: "issue"`:

```json
{"jsonrpc":"2.0","id":203,"method":"sourceControl.read.detail","params":{"workspaceId":"workspace-example","readLifetimeId":"original-read-example","target":{"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"issue","number":42}}}
```

The two examples name distinct resources even though both have IID 42. `number`
is a **project-local IID**, never a provider-global object ID, and must be a
positive JavaScript-safe integer from 1 through 9007199254740991. Strings,
fractions, zero, negatives and unsafe integers are not interchangeable encodings.
A larger integer would require a separate explicit wire contract.

Repository identity includes the canonical HTTPS origin, effective port, exact
configured path prefix and complete case-preserving nested project path. For the
example, `/gitlab` is the configured instance prefix and
`group/subgroup/project` is the project. Substring host matches, dropping namespace
segments, lowercasing project paths or guessing across ambiguous encoded slashes
and dot segments cannot establish identity. Git remote `.git` normalization does
not automatically define a resource-URL alias. Provider redirects or returned
identity mismatches cannot silently substitute another project or resource.
The instance root is at most 2048 UTF-8 bytes. The project path is at most 1024
bytes and has at least two nonempty slash-separated segments; each contains only
ASCII letters, digits, `_`, `-` or `.`, and neither `.` nor `..` is a segment.
Before backend cache installation and projection, the returned primary IID and
URL must match the requested resource. The primary URL must equal the configured
root plus the full project path and `/-/merge_requests/<IID>` or `/-/issues/<IID>`;
the returned issue or MR number must equal the requested IID.

Clients preserve the original clicked/copied URL, including its query and
fragment, for ordinary navigation; the explicit read target does not rewrite it.
The existing host-based authentication input is not full-prefix onboarding.
Submitting a URL prefix or changing an instance setting cannot retarget a token
or create a settled connection. This contract uses existing configured instances
and does not change authentication or setup operations.

### Detail and errors

Every admitted detail result has exactly `readLifetimeId`, `scope`, `revision`,
`target`, `outcome` and `quota`. The first three retain the original capture's
values and `target` echoes the exact requested resource. `outcome.kind`
discriminates these three complete variants:

| Outcome | Remaining fields |
| --- | --- |
| `merge-request` | `snapshot`: the existing [qualified snapshot value](pr.md#qualified-gitlab-snapshot-response), retaining flat fields plus `resource`, `details` and `availability`. |
| `issue` | `issue`: `{ number, title, body, state, url, author, createdAt, updatedAt }`, the existing issue serialization. `number` is the requested IID; `body` is string or `null`; `title`, `state`, `url`, `author`, `createdAt` and `updatedAt` are strings. No draft/branch fields are invented. |
| `failure` | `code`: one of the provider-failure values below; `status`: an observed HTTP status number or `null`. Unobserved status stays `null`, never a synthesized `0`. |

MR unknown and partial fields keep the linked snapshot's exact null/omission
rules, normalized author and per-signal availability. Unknown checks/reviews do
not become successful or complete, and the projection performs no hidden read.
The existing issue `state` and author strings pass through without an inferred
state enum or proof of raw author presence.

`quota` always contains `resetAt`, `remaining` and `limit`. Each value is a
canonical decimal u64 string or `null`, preserving observed provider values;
missing evidence never becomes `"0"`. `resetAt` is Unix seconds, not an ISO date
or milliseconds. The other values are remaining requests and full window quota.
An illustrative full issue result is:

```json
{"jsonrpc":"2.0","id":203,"result":{"readLifetimeId":"original-read-example","scope":{"daemonId":"daemon-example","authorityScopeId":"original-read-example","authorityGeneration":"7"},"revision":{"epoch":"original-read-example","sequence":"1"},"target":{"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"issue","number":42},"outcome":{"kind":"issue","issue":{"number":42,"title":"Example issue","body":null,"state":"open","url":"https://gitlab.example:8443/gitlab/group/subgroup/project/-/issues/42","author":"contributor","createdAt":"2026-10-02T00:00:00Z","updatedAt":"2026-10-02T00:00:00Z"}},"quota":{"resetAt":null,"remaining":null,"limit":null}}}
```

The complete provider-failure `code` set is `authentication`, `project-denied`,
`resource-denied`, `optional-restricted`, `optional-unavailable`, `rate-limited`,
`transient`, `unavailable` and `unknown`. A provider failure can be an admitted
JSON-RPC **result** carrying sanitized evidence about the original request:

```json
{"jsonrpc":"2.0","id":202,"result":{"readLifetimeId":"original-read-example","scope":{"daemonId":"daemon-example","authorityScopeId":"original-read-example","authorityGeneration":"7"},"revision":{"epoch":"original-read-example","sequence":"1"},"target":{"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"merge-request","number":42},"outcome":{"kind":"failure","code":"rate-limited","status":null},"quota":{"resetAt":"1790899200","remaining":"0","limit":"2000"}}}
```

The example's quota values represent supplied observations, not defaults. The
failure variant contains no raw response text, provider URL, account or secret.
Primary access denial, credential rejection, hiding 404, optional restriction and
transient/unknown evidence remain distinct. An actual accepted credential
rejection can still be disclosed as evidence of its original failed request;
the resulting disconnect never grants a subsequent read or successful payload.
Partial optional failure cannot suppress mandatory authority or credential errors.

Invalid request shapes/types use JSON-RPC `-32602`. Other authority or admission
unavailability, including ineligible cache delivery, uses sanitized `-32003`
`Forbidden`, not an empty successful detail or fabricated provider outcome:

```json
{"jsonrpc":"2.0","id":202,"error":{"code":-32003,"message":"Forbidden","data":{"code":"forbidden","detail":"Repository resource read unavailable"}}}
```

Provider quota facts survive in an admitted outcome, but this is not a promise
that every refusal carries quota. No failure selects a generic, native-review or
GitHub fallback. Clients retain truthful partial availability and backoff semantics.

### Release

Release accepts exactly `workspaceId` and `readLifetimeId` and returns
`{ released: true }`. For example:

```json
{"jsonrpc":"2.0","id":204,"method":"sourceControl.read.release","params":{"workspaceId":"workspace-example","readLifetimeId":"original-read-example"}}
```

```json
{"jsonrpc":"2.0","id":204,"result":{"released":true}}
```

It is bounded and idempotent on the original eligible connection: an already
absent lifetime still returns `released: true`. A present lifetime bound to a
different workspace is refused. Release does not bypass the connection's current
host/workspace admission, restore a retired feed, renew a lifetime or establish
that a lifetime on another socket was retired.

Release's original Store-authority validation has a five-second limit, subject
to the original frame deadline.

### Authorization and shared caches

The current Host Owner or Member execution gate and original workspace
membership/existence must both admit the read. A Host Guest is refused. Eligible
members may request an explicit project outside the workspace's default target
using the connected host-approved account; actual provider access is checked by
the primary resource read. A workspace Guest row, visible URL, remote,
collaboration proof, public connected status or prior receipt is insufficient.
See the [permission boundary](../08-permission-flow.md#explicit-resource-read-authorization).

Each frame retains the original caller and connection before queued work.
Capture binds durable authorization revisions, settings and provider connection
to the new lifetime. The server rechecks that
authority before a cache value is copied, each secret-bearing provider dispatch,
cache installation and the first protected reply transfer. Cancellation, expiry,
workspace or account retirement and lost ownership apply to warm hits as well as
misses. Restore-after-removal, account A→B→A or an equal-looking replacement
connection cannot revive the original lifetime. The final decision covers the
actual reply transfer; an earlier check followed by an unguarded send is
insufficient.

The existing managed MR/issue caches retain their TTL, refresh, limits and opaque
provider attribution. Their identity includes the daemon, original authorization
and execution scope, private account/connection revision, full instance/project,
resource kind and IID. Sharing storage does not promise a hit across callers or
authority lifetimes, and does not authorize a second client-side settled-detail
cache. Eligible warm hits need no HTTP, user/auth-status request, secret load or
credential-refresh probe. Cache eligibility checks still apply.

An accepted credential rejection retires connection eligibility. A current primary
project/resource denial, including authorization-hiding 404, invalidates matching
detail and summary receipts while preserving the original error and quota facts.
Old success cannot restore them; recovery requires a fresh authorized successful
read for the same coverage. Optional-detail restrictions, rate limits, transient
errors and unknown data do not alone establish project-wide denial. A summary
cannot extend detail freshness, and this draft does not add a public summary
invalidation stream.

### Client lifecycle

1. Capture the intended physical connection and sender, detect the capability
   there and install its private retirement handler before acquiring a lifetime.
   Bind the original workspace allocation and UI consumer to that connection.
   Record a monotonic capture-request start before sending; set the local discard
   deadline to that start plus `expiresAfterMs`. It is an upper bound, not a
   promise of 300 seconds remaining when the response arrives. Server retirement
   or connection/feed loss ends use earlier; neither a response, read nor refresh
   extends the deadline.
2. Reconcile retirements received while capture awaits before using its result.
   An opaque ID, public descriptor or echoed revision is correlation information,
   not a transferable authorization grant.
3. Send detail for the explicit target through that captured connection and
   sender. Match every response's target, lifetime, scope and revision to the
   original pending request; accept success or error only for that same live
   workspace allocation and consumer. Never attach a late reply to a replacement
   hover, workspace or socket.
4. Dispose pending consumers on expiry, cancellation, release or retirement. Use
   `sourceControl.read.release` for bounded, idempotent cleanup on the same
   connection; it cannot renew or create authority. If an acquisition completes
   after disposal, its late cleanup also stays on the original connection. A
   refused cleanup cannot justify switching sockets to address the old lifetime.
5. On disconnect, feed loss/overflow or malformed scope/revision, invalidate local
   references and fail closed. A replacement connection requires a fresh capture
   for new work and cannot inherit the old one. Delayed notices never override
   authoritative server admission and final-transfer checks.

The [retirement feed](../06-events.md#private-resource-read-retirement)
is socket-private, with no global event subscription or root/account payload.
These are integration obligations, not a claim that existing frontend clients
already implement them.

### Bounds and scope

This contract fixes these bounds. The server sets a nonrenewable
300-second lease deadline during capture; clients use the conservative
request-start discard deadline below, and server retirement or loss may end use
earlier:

| Resource or phase | Bound |
| --- | --- |
| Client discard deadline | At most 300 seconds from the original capture request start, never renewed; `expiresAfterMs: 300000` does not start a fresh period at response receipt. Server retirement/loss may end it earlier. |
| Live/reserved leases | At most 64 per original connection **and** 64 across its Services instance. |
| Captured request frames | At most 64 per original connection **and** 64 across its Services instance; includes capture, detail and release. |
| Detail attempts | At most 64 within one lifetime, including eligible warm hits and explicit refresh; not a count of underlying HTTP subrequests. |
| Retirement feed | One receiver per original connection; at most 64 queued notices before fail-closed retirement. |
| Frame deadline | 15 seconds from original frame capture, including queued time and protected consumption. |
| Capture acquisition | 5 seconds. |
| Release validation | 5 seconds for the original Store-authority await, subject to the original frame deadline. |
| Detail read | 10 seconds, subject to the original frame and lifetime deadlines. |
| Final protected validation/transfer | 5 seconds, also subject to the earlier frame/lifetime deadlines. |
| Private retirement forwarding | 5 seconds for each send; timeout or closed output drops the feed and retires original scopes. |

Capacity is reserved against both applicable limits before work; unavailable
capacity refuses instead of creating an unbounded queue. Retirement does not
promise that in-flight owners have already dropped all held capacity. Reusing a
cached value does not reset counters, deadlines, scope or revision.

This desktop explicit-target read is separate from repository inventory leases,
saved selection, selected-workspace PR state and MCP MR/PR observation aliases.
It grants no Git, staging, checkout, write, review creation or provider setup
authority. Project/branch search, lists, suggestions, monitors and threads remain
outside this contract. A GitLab `/work_items/:id` URL stays an ordinary original
link unless a provider-verified resolver establishes its instance, project and
issue IID; its numeric segment is not automatically an issue IID. Group, epic or
unknown resource links are likewise not converted into issue detail requests.

### Project pages and discussions

This separate [protocol 15.1 extension](../versioning.md) adds bounded
project lists and complete conversation reads. It requires
`repositoryResourcePages: 1` on the original connection in addition to the existing
detail-read contract. It defines scoped capture, detail and release alongside
list and discussion reads. These forms do not follow from
`repositoryResourceRead: 1` alone or change the detail-only method table and
bounds above. Catalog presence is not proof of deployed support.

| Method | Params | Result |
| --- | --- | --- |
| sourceControl.read.captureScoped | context | Context plus the original capture fields: read lifetime, scope, revision, retirement cursor, expiry and instances |
| sourceControl.read.detailScoped | context, readLifetimeId, target, refresh? | Context plus the full qualified detail result, including snapshot and observed quota |
| sourceControl.read.releaseScoped | context, readLifetimeId | {released: true} |
| sourceControl.read.resolveKnownRepository | context (host only), readLifetimeId, path | Context, read lifetime, scope, revision, path and selection resolution |
| sourceControl.read.list | context, readLifetimeId, repository, kind, query | Original context/lifetime/scope/revision, repository, kind, query, page or failure outcome, and observed quota |
| sourceControl.read.discussions | context, readLifetimeId, target, page | Original context/lifetime/scope/revision, target, page, discussion page or failure outcome, and observed quota |

Retain the actual authorized caller scope, original connection and read lifetime
for every page. The existing workspace capture still requires a real authorized
workspace. The new scoped capture distinguishes two exact `context` forms:

| Context | Authority |
| --- | --- |
| `{ "kind": "workspace", "workspaceId": "workspace-example" }` | The original caller's durable workspace authority and existing host execution gate. |
| `{ "kind": "host" }` | The original physical connection's durable Host Owner; host membership or checkout eligibility alone is insufficient. |

A Home view without a workspace uses the explicitly admitted host context; it
cannot borrow an unrelated workspace or treat a selected URL/account as a
capture. Each project is an explicit canonical GitLab full instance and project
path; a collection is not a fabricated resource with IID zero. `context` is
semantic authority, not an optional top-level routing field. Do not inject a
focused `workspaceId`, change context during a lifetime, or adopt that lifetime
on another connection.

#### Scoped capture, detail and release

`sourceControl.read.captureScoped` accepts only `context`. Its result contains
`context` alongside the six existing capture fields, at the same object level;
there is no nested `capture` object. The original nonrenewable deadline,
scope/revision encoding and configured-instance qualifications still apply.
Illustrative host capture:

```json
{"jsonrpc":"2.0","id":211,"method":"sourceControl.read.captureScoped","params":{"context":{"kind":"host"}}}
```

`sourceControl.read.detailScoped` accepts `context`, `readLifetimeId`, `target`
and optional Boolean `refresh` (default `false`). It returns `context` alongside
the existing detail fields, with no nested `detail` object. The target and
failure/quota meanings remain those of explicit detail above. For example:

```json
{"jsonrpc":"2.0","id":212,"method":"sourceControl.read.detailScoped","params":{"context":{"kind":"workspace","workspaceId":"workspace-example"},"readLifetimeId":"workspace-read-example","target":{"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"issue","number":42}}}
```

`sourceControl.read.releaseScoped` accepts exactly `context` and
`readLifetimeId`, returning `{ "released": true }`. Capture, every subsequent
request and cleanup must retain the same context and original connection. An
absent lifetime is idempotent only through the eligible original cleanup path;
a mismatched present context cannot be released as if it belonged to the caller.

```json
{"jsonrpc":"2.0","id":215,"method":"sourceControl.read.releaseScoped","params":{"context":{"kind":"host"},"readLifetimeId":"host-read-example"}}
```

#### Known repository identity before workspace creation

The `sourceControl.read.resolveKnownRepository` method accepts exactly
`context`, `readLifetimeId` and `path`. It requires `{ "kind": "host" }` and the
original Host Owner capture; a workspace context is refused. `path` must be an
absolute path registered as a known repository and identify its actual local
Git root. It is a nonempty string of at most 4096 UTF-8 bytes with no control
characters. For example:

```json
{"jsonrpc":"2.0","id":216,"method":"sourceControl.read.resolveKnownRepository","params":{"context":{"kind":"host"},"readLifetimeId":"host-read-example","path":"/repositories/example"}}
```

The result contains exactly `context`, `readLifetimeId`, `scope`, `revision`,
`path` and `selection`. `selection` has the existing
[`ReviewSelectionResolution` shape](workspace.md#repository-context): `saved`,
`noRemotes` and `outcome`. This operation uses `saved: { "mode": "automatic" }`
with effective local Git configuration and canonical fetch destinations; it
does not borrow a workspace's saved selection, prefer a remote named `origin`,
or reconstruct a target from owner/name text. Ambiguous or unresolved candidates
remain selection-required. A repository without remotes remains unavailable:

```json
{"jsonrpc":"2.0","id":216,"result":{"context":{"kind":"host"},"readLifetimeId":"host-read-example","scope":{"daemonId":"daemon-example","authorityScopeId":"host-read-example","authorityGeneration":"7"},"revision":{"epoch":"host-read-example","sequence":"1"},"path":"/repositories/example","selection":{"saved":{"mode":"automatic"},"noRemotes":true,"outcome":{"state":"repository-unavailable","reason":"no-remote","selectionRequired":false}}}}
```

This is one local identity observation, with no provider or authentication
request. It neither persists a choice nor creates a workspace or live Git-root
lifetime. Match the returned context, lifetime, scope, revision and path to the
original request. Even a resolved canonical target grants no remote permission;
each later explicit list or detail read still requires original caller,
account and project admission. This method requires the page capability
and does not change legacy capture or selection methods.

#### Lists, filters and continuation

`sourceControl.read.list` accepts exactly `context`, `readLifetimeId`,
`repository`, `kind` and `query`. `repository` has the same full GitLab instance
and project identity as a detail target, without a resource IID. `kind` is
`"merge-request"` or `"issue"`. The exact query fields are:

| Field | Required value |
| --- | --- |
| `state` | `"all"`, `"open"`, `"closed"` or `"merged"`. |
| `filter` | `"all"`, `"created"`, `"assigned"`, `"review-requested"` or `"involves"`. |
| `search` | String, including `""`; at most 512 UTF-8 bytes and no control characters. |
| `limit` | Integer from 1 through 100. |
| `cursor` | Optional opaque nonempty string, at most 128 UTF-8 bytes and no control characters. Omit it for the initial page; explicit `null` is invalid. |

The first four fields are required; enum defaults do not make them optional wire
fields. Unknown request, context, repository or query fields are rejected.
Parsing an enum value does not promise provider support for that resource/filter
combination. An illustrative initial page is:

```json
{"jsonrpc":"2.0","id":213,"method":"sourceControl.read.list","params":{"context":{"kind":"host"},"readLifetimeId":"host-read-example","repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"merge-request","query":{"state":"closed","filter":"all","search":"","limit":20}}}
```

The GitLab provider supports `all`, `created`, `assigned` and
`review-requested` for merge requests, and `all`, `created` and `assigned` for
issues. The self filters use the authenticated account on the captured
connection, not a client-supplied user identity. `all` adds no involvement
filter. Other resource/filter combinations remain unsupported. The issue
queries also reject the `merged` state with `unsupported`; it is an MR state.

For merge requests, **Closed
includes both merged and unmerged-closed items**, matching the existing GitHub
presentation. Unsupported filters must be reported as unavailable rather than
approximated or represented by a successful empty list. In particular, a
participant-based query is not an exact replacement for Involves. Provider
version, tier or permission limits do not justify silently changing the filter.

Keep continuation bound to the original project, account, full instance, caller
and normalized query. An empty filtered page with a continuation cursor is not
the end of the list. Changing the query or selected project starts its own
pagination; a cursor from another query cannot be adopted. Mixed-forge views
retain each item's complete provider/instance/project/kind/IID identity instead
of deduplicating by number or owner/name alone.

Selecting an item for context or workspace creation preserves its target
project and the explicitly displayed branch intent. An MR's source fork or head
does not replace that selection. Existing checkout admission and explicit
branch/commit confirmation remain separate from a successful list read.

#### Complete conversations

Conversation reads include standalone user notes, unanchored general discussions
and diff discussions, including non-resolvable notes. Provider system notes are
omitted; this is one discussion collection, not a union with legacy flat comments.
A page with no retained user notes can still carry a continuation. Preserve
provider discussion,
note and reply identities across pages so each note appears once and replies
stay with their original thread. A shared file and line do not identify a
thread. Optional diff positions cannot establish the MR's current head.

Resolvability and resolution are separate facts. A non-resolvable note is not
an unresolved merge blocker; absent resolution information remains unknown.
Keep the observed resource/head attribution and section completeness alongside
the content. A partial or unsupported section does not mean there are no notes,
and successful conversation reads do not establish successful CI, approvals or
merge readiness. Missing checks or a pipeline with no executed jobs are not a
passing result.

`sourceControl.read.discussions` accepts exactly `context`, `readLifetimeId`,
`target` and `page`. The target must be an explicit merge request; an issue target
is invalid for this operation. `page` requires `limit` from 1 through 100 and
accepts the same optional, non-null cursor form as lists:

```json
{"jsonrpc":"2.0","id":214,"method":"sourceControl.read.discussions","params":{"context":{"kind":"host"},"readLifetimeId":"host-read-example","target":{"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"merge-request","number":42},"page":{"limit":20}}}
```

#### Page results and unavailable observations

A list result has exactly `context`, `readLifetimeId`, `scope`, `revision`,
`repository`, `kind`, `query`, `outcome` and `quota`. A discussion result instead
has `context`, `readLifetimeId`, `scope`, `revision`, `target`, `page`, `outcome`
and `quota`. Keep the echoed target and normalized query/page bound to the
original request. The shared outcome has these complete variants:

| Outcome | Fields |
| --- | --- |
| `page` | `items` array, `nextCursor` string or `null`, and nonnegative integer `omitted` for rows withheld because their original observation is no longer valid. All three fields are present. |
| `failure` | `code` from the page-failure set below and observed `status` number or `null`; it has no `items`, `nextCursor` or `omitted` fields. |

Page failure codes are `authentication`, `project-denied`, `resource-denied`,
`optional-restricted`, `optional-unavailable`, `rate-limited`, `transient`,
`unavailable`, `unsupported` and `unknown`. `unsupported` is an additive
page-only code; it does not extend the existing detail failure union, including
scoped detail. An unsupported page outcome with no observed HTTP status is:

```json
{"kind":"failure","code":"unsupported","status":null}
```

An empty page with a cursor is still a continuation. `omitted` is not the total
number of matches, proof of complete access, or a provider-denial code. This
illustrative result deliberately contains no item payload:

```json
{"jsonrpc":"2.0","id":213,"result":{"context":{"kind":"host"},"readLifetimeId":"host-read-example","scope":{"daemonId":"daemon-example","authorityScopeId":"host-read-example","authorityGeneration":"7"},"revision":{"epoch":"host-read-example","sequence":"1"},"repository":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/gitlab","projectPath":"group/subgroup/project"},"kind":"merge-request","query":{"state":"closed","filter":"all","search":"","limit":20},"outcome":{"kind":"page","items":[],"nextCursor":"continuation-example","omitted":1},"quota":{"resetAt":null,"remaining":null,"limit":null}}}
```

`quota` retains the existing decimal-string-or-null fields; unknown status and
quota never become zero. A failure is not a successful empty page. The item
forms below describe the provider projection. intentd forwards the private
invalidation notice below on the capturing connection; no global event schema
is added.

#### List and discussion items

List items use the existing provider `PullRequest` or `Issue` serialization,
selected by the result's `kind`. All fields below are present and use camelCase.
Nullable values are explicit `null`, not omitted fields or invented empty values.

| Item | Complete fields |
| --- | --- |
| Merge request | `number`: project-local IID; `url`, `title`, `sourceBranch`, `targetBranch`, `author`, `createdAt`, `updatedAt`: strings; `body`: string or null; `state`: `"open"`, `"closed"` or `"merged"`; `draft`: Boolean; `mergeable`: Boolean or null; `mergeableState`, `headSha`: strings or null. |
| Issue | `number`: project-local IID; `title`, `state`, `url`, `author`, `createdAt`, `updatedAt`: strings; `body`: string or null. The issue state remains the provider-normalized string, not a new enum inferred from the list query. |

The enclosing result supplies the full original repository/resource kind;
clients cannot identify an item by IID alone. The service must qualify each
returned primary identity before projection. A source branch or observed head
does not replace the selected target project or authorize checkout. Nullable
mergeability and head values remain unknown; a list item is not a complete
readiness snapshot. For example, this is one illustrative merge-request item:

```json
{"number":42,"url":"https://gitlab.example:8443/gitlab/group/subgroup/project/-/merge_requests/42","title":"Example merge request","body":null,"state":"merged","draft":false,"sourceBranch":"topic","targetBranch":"main","author":"contributor","mergeable":null,"mergeableState":null,"headSha":null,"createdAt":"2026-10-13T00:00:00Z","updatedAt":"2026-10-13T00:00:00Z"}
```

Each discussion item has exactly `id` (opaque canonical provider-qualified
string), `individualNote` (Boolean) and `notes` (array). Canonical discussion and
note identity includes the full instance, project and MR; equal raw provider IDs
in different resources are not interchangeable. Preserve the provider's
standalone-note classification and canonical identity; do not manufacture a
thread from a file/line pair. Each note has these fields, all present:

| Field | Type and meaning |
| --- | --- |
| `id` | Canonical provider-qualified note string. |
| `inReplyToId` | Canonical reply-parent string or null; null does not authorize inferring a parent by position. |
| `author`, `body`, `createdAt` | Strings from the qualified provider projection. |
| `path`, `url` | Strings or null. An optional path is a diff anchor, not repository or current-head authority. |
| `line` | Nonnegative integer or null, preserving the provider position without inventing one. |
| `positionHeadSha` | String or null from the original note's `position.head_sha`. It identifies the diff anchor's head, never the current MR HEAD. |
| `resolvable` | Boolean; false is a legitimate standalone or general note, not missing content. |
| `resolved` | Boolean or null. Null is unknown/not supplied; false is not a merge blocker when `resolvable` is false. |

Within a multi-note discussion, later notes' `inReplyToId` refers to the first
retained non-system note. Standalone and first retained notes have null. This is
a thread-root relationship, not proof of a more specific reply parent. Missing
or non-Boolean provider `resolvable` is a decode failure, never default false.
When `resolvable` is true but no Boolean resolution is supplied, `resolved`
remains null. Non-resolvable notes also retain null resolution.

Illustrative standalone content follows; the ID strings stand for opaque
server-returned values, not an ID-construction algorithm:

```json
{"id":"provider-discussion-example","individualNote":true,"notes":[{"id":"provider-note-example","inReplyToId":null,"author":"contributor","body":"General observation","createdAt":"2026-10-13T00:00:00Z","path":null,"line":null,"positionHeadSha":null,"url":null,"resolvable":false,"resolved":null}]}
```

Keep canonical IDs and parent relationships across pages. These item values do
not themselves carry a new current-head assertion or independent authority;
their original enclosing target, scope, revision, lifetime and section outcome
remain required. Clients must validate the explicit item form rather than
accepting arbitrary JSON as a successful page.

#### Current authority and retained data

Known primary authentication/project/resource denial overrides retained data
and late success from the earlier authority. Invalidate the affected summaries,
details, lists and discussions under their original coverage. Replacing an
account, full instance or connection cannot revive them; recovery requires a
fresh authorized read. Optional unsupported/restricted sections, rate limits
and transient failures stay distinct from denial of the whole project and must
identify the unavailable section without hiding readable facts.

The socket-private notification is `sourceControl.read.invalidated`.
Its body contains exactly `readLifetimeIds` (an array of strings), `sequence`
(a canonical decimal u64 string), `repository` (the full canonical repository
target) and `coverage`. It belongs to the original socket and carries no
permission grant or provider payload. Coverage has these explicit forms:

| Coverage | Complete fields and scope |
| --- | --- |
| Project | `{ "kind": "project" }` identifies the enclosing repository. |
| Resource | `{ "kind": "resource", "target": ReviewTarget }` identifies one complete repository/resource-kind/IID target. |
| List | `{ "kind": "list", "resourceKind": "merge-request" }` or the same form with `"issue"` identifies the corresponding list endpoint. |

Invalidation and `sourceControl.read.retired` share one original feed sequence.
Handle both notification kinds in order and reconcile either across the capture
await; the existing gap, exhaustion and feed-loss rules apply. Invalidation
marks matching observations unusable without itself releasing the listed
lifetimes. Connection-level credential rejection retires affected lifetimes.

Coverage is never inferred from an absent or null target. A denied list endpoint
does not invalidate independently readable details. The existing retirement
contract remains separate; final private-notice forwarding, sequence and loss
handling must be qualified with the integrated implementation before clients
claim this extension is supported.

Use the existing bounded initial-page retention and shared request lifetimes.
Do not introduce a resolved preview cache or retain every search/page response.
Query replacement remains the original pager's responsibility. A successful
page or discussion section cannot refresh an older detail payload, and a cache
hit does not bypass current authority or renew a lifetime. This does not require
an extra provider network probe on every eligible cache hit.
