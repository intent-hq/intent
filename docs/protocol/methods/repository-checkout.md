> Part of the [Intent JSON-RPC protocol docs](../README.md) — GitLab project checkout.

## 5.53 GitLab project checkout

**Prepared additive contract, protocol 13.5.** Require exactly integer
[`server.capabilities.gitlabCheckout: 1`](client-hello.md#gitlab-checkout-capability)
on the destination connection. A numeric protocol version or a method in the
catalog does not establish support, enable the GitLab experiment or authorize a
repository read. These methods browse an already configured GitLab connection
before a workspace exists; they do not create a hosted project.

| Method | Params | Result |
| --- | --- | --- |
| sourceControl.checkout.capture | provider: "gitlab", instanceBaseUrl?, includeOwnerAvatar? | Checkout outcome containing the original connection reference |
| sourceControl.checkout.projects | checkoutId, revision, query?, cursor?, limit? | Checkout outcome containing {items: Project[], nextCursor?} |
| sourceControl.checkout.project | checkoutId, revision, exactly one of projectPath or url | Checkout outcome containing {project: Project, contextUrl?} |
| sourceControl.checkout.branches | checkoutId, revision, projectPath, query?, cursor?, limit?, cached? | Checkout outcome containing {items: Branch[], nextCursor?, defaultBranch?, cached: boolean} |
| sourceControl.checkout.repoConfig | checkoutId, revision, projectPath, branch, commitSha | Checkout outcome containing {projectPath, branch, commitSha, config: object or null, exists: boolean}; requires gitlabCheckoutRepoConfig: 1 |
| sourceControl.checkout.warm | checkoutId, revision, projectPath, branch, commitSha, mode | Checkout outcome containing {projectPath, branch, commitSha, cached: boolean} |
| sourceControl.checkout.release | checkoutId, revision | {released: boolean} |

### Original destination and authority

Capture requires the authenticated caller's actual **Owner or Member authority on
the destination host**. Workspace-only guest membership and a guest's forge
identity do not grant access to the host's repository connection. No method takes
a placeholder workspace ID. Keep the selected daemon, its original physical
connection and the returned reference together; a matching host name, stable
client ID or replacement socket cannot adopt the reference.

Capture accepts `provider: "gitlab"` and, optionally, the exact configured
`instanceBaseUrl`. The complete successful value is
`{checkoutId, revision, provider: "gitlab", instanceBaseUrl, expiresAfterMs}`.
`checkoutId` and `revision` are opaque strings, not portable grants or a client
chosen account. The server binds them to original host, caller, settings and
credential continuity. Socket loss, authority loss, auth/settings replacement
or release prevents stale requests and late private replies. Recapture after
those changes; never repair an old reference with newly available credentials.

The lease has a fixed server lifetime of 600,000 ms, starting when capture
allocates it. `expiresAfterMs: 600000` is an upper bound, not a fresh ten minutes
from response receipt. Browsing and warming do not renew it; earlier server
retirement or connection loss always wins over a client timer.

For example, on the selected destination connection:

```json
{"jsonrpc":"2.0","id":301,"method":"sourceControl.checkout.capture","params":{"provider":"gitlab","instanceBaseUrl":"https://gitlab.example:8443/forge"}}
```

The instance is the full logical HTTPS root, including port and installation
prefix. `https://gitlab.example:8443/forge` and
`https://gitlab.example:8443/another` are distinct instances. A provider transport
override is not that identity. Public metadata, a matching URL or a previous
successful request cannot replace current server authorization.

### Project and branch pages

The value of a ready project page contains `items: Project[]` and an optional
opaque `nextCursor`. Project search uses `query`; branch search uses `query`
within its exact `projectPath`. Echo a returned cursor only with its original
reference, query, page limit and, for branches, project. Do not reuse it after a
project or connection switch, or append late results to a different search.
Continue pagination or server search until the intended branch is reachable;
the first page is not a complete branch inventory.

Project and branch page limits are integers from 1 through 100, defaulting to
50. Search text is trimmed first; the remaining UTF-8 text must be at most 256
bytes and contain no control characters. Cursors are opaque UUID strings bound
to the original lease's connection, account and settings plus the project,
normalized query, limit and cache lane. Do not construct cursors or move one
between cached and provider pages. A stale cursor is refused rather than
reinterpreted for another page.

`projectPath` is at most 1,024 ASCII bytes and must include a namespace. Each
slash-separated segment is nonempty and uses only letters, digits, `.`, `_` or
`-`; `.` and `..` segments are rejected. Preserve the exact returned path.

| Field | Type and meaning |
| --- | --- |
| `Project.projectPath` | Full project path, including nested namespace; preserve its identity. |
| `Project.name` | Display name. |
| `Project.namespace` | Display namespace. |
| `Project.webUrl` | Project web URL under the admitted instance. |
| `Project.cloneUrl` | Sanitized HTTPS clone identity; not caller-supplied credential or checkout authority. |
| `Project.defaultBranch` | Optional actual default branch; omitted when unavailable. Never synthesize `main` or `master`. |
| `Project.ownerAvatarUrl` | Optional HTTPS image of the owning namespace, only for an opted-in capture. See the negotiated extension below. |
| `Branch.name` | Exact selectable branch name. |
| `Branch.commitSha` | Full commit selected with that branch. |
| `Branch.protected` | Optional boolean from provider-observed metadata, not a grant to push. Omitted when only the exact cached name and SHA are known; absence means unknown, never `false`. |

#### Owner-avatar extension (prepared, protocol 13.7)

Require exactly integer `server.capabilities.gitlabCheckoutOwnerAvatar: 1` on
the original destination connection before sending `includeOwnerAvatar: true`
in `sourceControl.checkout.capture`. This flag supplements `gitlabCheckout: 1`;
neither a version string nor a successful unrelated call establishes support.
With an older daemon, omit the request member entirely and use the ordinary
image fallback. Do not retry a refused capture with guessed compatibility.

The capture response is unchanged. Its requested projection is fixed for that
capture: omission or `false` keeps the original project shape with no
`ownerAvatarUrl`; `true` allows the optional field on both project pages and
project detail, including cached detail. Separate captures on the same socket
do not share this preference. Existing authority and lifetime checks still apply.

The producer uses only `namespace.avatar_url` from the existing project response,
and only when `namespace.full_path` exactly matches the project's full owning
namespace. It performs no additional provider request or image fetch. Project
images and the signed-in user's avatar are not owner images. Missing, null,
malformed or mismatched metadata is omitted without making the project unusable.

Image URLs must be at most 8,192 UTF-8 bytes before and after resolution, contain
no whitespace, controls, backslashes or URL user information, and resolve to
HTTPS with a host. Path-relative locations resolve against the original logical
instance as a directory, retaining its port and installation prefix; a single
leading slash uses that origin's root. Explicit HTTPS CDN locations are permitted;
a scheme-relative `//host/path` uses its supplied host and the instance's HTTPS
scheme.
Transport overrides do not supply the image origin. Clients use their ordinary
fallback when an image is absent or fails to load. This display metadata is not
repository identity, authorization, or a credential-bearing download request.

For example, search branches of an already selected project:

```json
{"jsonrpc":"2.0","id":302,"method":"sourceControl.checkout.branches","params":{"checkoutId":"checkout-example","revision":"revision-example","projectPath":"team/subgroup/app","query":"release/","limit":20}}
```

A ready branch page can be:

```json
{"jsonrpc":"2.0","id":302,"result":{"status":"ready","value":{"items":[{"name":"release/customer-a","commitSha":"0123456789abcdef0123456789abcdef01234567","protected":false}],"nextCursor":"opaque-next-page","defaultBranch":"trunk","cached":false}}}
```

A qualified cached page may omit protection metadata while retaining the required
exact branch name and commit SHA:

```json
{"jsonrpc":"2.0","id":302,"result":{"status":"ready","value":{"items":[{"name":"release/customer-a","commitSha":"0123456789abcdef0123456789abcdef01234567"}],"cached":true}}}
```

Omitting this observation does not bypass original connection, project or denial
checks on cache hits or final output.

An empty result does not prove that the project has no default branch or that the
caller has access. Preserve explicit unavailable outcomes and missing values.
Project/branch drafts retain selection intent, not a cursor or authority that
survives connection or credential replacement.

### Project and resource URLs

`sourceControl.checkout.project` accepts exactly one of `projectPath` or `url`.
A supported project, merge-request or issue URL resolves to the **target
project** and may return the original `contextUrl`, preserving query and fragment.
Unsupported or ambiguous resource forms are refused; an unknown instance cannot
fall back to GitHub or another configured account. A merge-request URL does not
select its source fork or head commit. Select a branch of the returned target
project, or use its actual default when the user has not chosen another branch.

```json
{"jsonrpc":"2.0","id":303,"method":"sourceControl.checkout.project","params":{"checkoutId":"checkout-example","revision":"revision-example","url":"https://gitlab.example:8443/forge/team/subgroup/app/-/merge_requests/42?view=parallel#note_7"}}
```

### Warming and exact checkout

The explicit branch and full 40-hex commit SHA must match a branch observed for
that project on the original lease. A syntactically valid name or SHA from a
different capture cannot supply this evidence.

The selection shared by `sourceControl.checkout.warm` and
[`workspace.create.repositoryCheckout`](workspace.md#gitlab-project-checkout)
has exactly these fields:

```ts
type RepositoryCheckoutSelection = {
  checkoutId: string;
  revision: string;
  projectPath: string;
  branch: string;
  commitSha: string;
  mode: "direct" | "cached";
};
```

Use the branch and full commit from the selected branch result. Direct and cached
creation must produce that exact checkout or fail; neither mode substitutes the
default branch. Retries are explicit. Refresh and reconfirm the selection before
adopting a newly observed branch or commit; creation never advances the selected
SHA automatically. Warming exposes no cache path and does not grant later create
permission. Creation revalidates the original reference and selection before
admission.

```json
{"jsonrpc":"2.0","id":304,"method":"workspace.create","params":{"title":"Customer release","repositoryCheckout":{"checkoutId":"checkout-example","revision":"revision-example","projectPath":"team/subgroup/app","branch":"release/customer-a","commitSha":"0123456789abcdef0123456789abcdef01234567","mode":"cached"}}}
```

Top-level `workspace.create.branch` has a separate purpose: it optionally names
the new local workspace branch at the selected commit. It never changes the
source branch or SHA inside `repositoryCheckout`. For example, this creates the
local branch `work/customer-fix` from the observed `release/customer-a` commit:

```json
{"jsonrpc":"2.0","id":305,"method":"workspace.create","params":{"title":"Customer fix","branch":"work/customer-fix","repositoryCheckout":{"checkoutId":"checkout-example","revision":"revision-example","projectPath":"team/subgroup/app","branch":"release/customer-a","commitSha":"0123456789abcdef0123456789abcdef01234567","mode":"direct"}}}
```

The [create composition rules](workspace.md#gitlab-project-checkout) retain
`scope` as metadata and list the incompatible source/path fields and true flags.

The cache distinguishes forge, full instance and full project. Matching origin
and freshness never override known credential/project denial, revocation or
replacement; stale in-flight work cannot install private results after that
boundary. Authorized recovery uses current authority. This is not a requirement
to issue a network permission probe on every cache hit.

Native checkout uses the original selected connection and validated HTTPS
destination. It does not rely on `glab`, a child's Git-helper opt-in, guest
identity, credentials embedded in a URL or arbitrary inherited credential
fallback. Credentials cannot follow a redirect outside their origin or
installation prefix. Existing GitHub, local-Git, SSH and ordinary helper paths
retain their separate contracts.

After creation, existing `git.fetch` and `git.push` calls for workspaces whose
HTTPS remote belongs to the configured GitLab instance use each call's original
socket and native host credential binding. The daemon rechecks workspace access
and lifecycle around the owned worktree operation. These calls do not take a
checkout reference: their request/result shapes and push `force` behavior remain
unchanged. This native credential path is independent of child-helper opt-in;
agent/user-helper, GitHub, local and SSH routes retain their separate behavior.

Creation with `progressId` uses the existing [workspace provisioning progress](workspace.md)
reporter and `git:clone:progress` / `git:clone:done` frames. It reports `starting`,
clone/cache preparation through `receiving`, selected-branch `checkout`, and
`finalizing`; these are provisioning milestones, not per-object transfer
measurements. Keep the original `progressId` and terminal result together. This
adds no event type or checkout-specific progress payload.

### Outcomes, retirement and recovery

Capture, project/branch reads and warming return either
`{status: "ready", value: T}` or
`{status: "unavailable", reason, retryAfterMs?}`. Unavailable reasons include
`disabled`, `not-connected`, `access-denied`, `rate-limited`, `unreachable`,
`retired`, `not-found`, `invalid-target`, `empty-repository` and `branch-changed`.
An unavailable result is not an empty successful page. Honor an observed
`retryAfterMs`; do not invent one or treat a rate limit as an instruction to
replace credentials. Invalid request DTOs are `-32602`. An unauthenticated
caller, guest or foreign original-socket reference is Forbidden under the
existing [error contract](../09-error-codes.md).

A service failure from qualified `workspace.create`, including a native
selected-SHA mismatch, is refused at final response delivery with `-32003`,
message `Forbidden`, and data
`{code: "forbidden", detail: "Repository checkout unavailable"}`. The upstream
native internal-error envelope is not the public qualified-create response.
This refusal is separate from the checkout-read outcome above. Denial,
retirement and expiry can yield the same refusal; it establishes neither a
branch-specific cause nor the absence of prior effects. Offer explicit refresh
and user reconfirmation; never automatically repeat creation, reselect a branch
or advance the selected SHA.

Release takes the original `checkoutId` and `revision` on the original connection
and returns `{released: boolean}`. Explicit release is not needed for socket,
authority or auth/settings loss to retire the old reference. Final transport
delivery revalidates private results; server refusal remains authoritative even
when the client has not yet observed a transition. There is no new global event
or portable retirement subscription in this contract.

Follow the [checkout client lifecycle](../10-thin-client.md#gitlab-checkout-lifecycle-prepared)
for draft restoration, stale-response rejection and progress. These wire and
client obligations do not claim live hosted/self-managed acceptance or a carrying
desktop release.

### Selected repository configuration (prepared, protocol 13.8)

Require exactly integer `server.capabilities.gitlabCheckoutRepoConfig: 1` **and**
`gitlabCheckout: 1` on the original destination connection before calling
`sourceControl.checkout.repoConfig`. Older clients retain their existing behavior;
clients on older daemons must report configuration detection as unavailable rather
than interpreting unsupported reads as an absent file.

The request contains exactly `checkoutId`, `revision`, `projectPath`, `branch`
and `commitSha`. Select a branch and its full 40-character hexadecimal SHA from
this checkout's branch observations first. Unknown fields (including URL, file
path, mode and workspace ID) are invalid. The server reads only
`.intent/config.json`, at that immutable SHA, without cloning, warming a cache,
creating a workspace or writing files. It uses the original caller, socket,
connection, credential and project admission. It does not acquire replacement
authority when a request retires.

```json
{"jsonrpc":"2.0","id":305,"method":"sourceControl.checkout.repoConfig","params":{"checkoutId":"checkout-1","revision":"revision-1","projectPath":"team/sub/project","branch":"release/config","commitSha":"0123456789012345678901234567890123456789"}}
```

```json
{"jsonrpc":"2.0","id":305,"result":{"status":"ready","value":{"projectPath":"team/sub/project","branch":"release/config","commitSha":"0123456789012345678901234567890123456789","config":{"setupScript":"npm ci"},"exists":true}}}
```

All ready fields are required. `config` is explicitly null and `exists` false
only for confirmed file absence. A present invalid JSON document, non-object or
repo-config schema mismatch yields `{}` and `exists: true`, using the existing
repository-config tolerant parser; valid objects preserve unknown keys.
Confirmed matching file/commit responses with undecodable content also yield
`{}`/true, following the existing remote repo-config parser. Missing/mismatched
provider identity, malformed transport JSON, auth/transport failures and
ambiguous HTTP 404s never become absent config. The fixed-file adapter recognizes
GitLab's exact `404 File Not Found` response, distinguished from project/commit
not-found or generic denial. It preserves the existing bounded provider response
limit (16 MiB), a 15-second overall read budget and the original checkout lifetime.

The server validates project identity and branch-to-SHA before and after the file
read. Branch movement or disappearance returns existing `branch-changed`;
project replacement returns `retired`. Other failures use the existing unavailable
reasons and authorization errors. Original authority is checked again through
final response delivery, so a late private configuration cannot escape retirement.
No config response refreshes the checkout lease or grants workspace creation.

Clients must correlate the result with the original destination, checkout,
project, branch and SHA. A changed selection invalidates both detected defaults
and pending reads; an older response cannot overwrite a newer selection.

The [canonical JSON fixture](../fixtures/checkout-repo-config.json) is mirrored by
intent-core’s serialization golden and checked byte-for-byte during validation.
