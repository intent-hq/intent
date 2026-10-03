> Part of the [Intent JSON-RPC protocol docs](../README.md) — explicit resource reads.

## 5.52 Explicit GitLab resource reads

| Method | Params | Result |
| --- | --- | --- |
| sourceControl.read.capture | workspaceId | Original read lifetime, scope, revision, retirement cursor and configured instances |
| sourceControl.read.detail | workspaceId, readLifetimeId, target, refresh? | Qualified merge-request snapshot or issue detail with availability and observed quota |
| sourceControl.read.release | workspaceId, readLifetimeId | {released: true} |

**Prepared additive contract.** Require the original connection's
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
