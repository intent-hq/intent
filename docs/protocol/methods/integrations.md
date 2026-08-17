> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.26 Future integrations & observability · §5.27 `github.*` · §5.28 `linear.*` · §5.29 `sentry.*`.

### 5.26 Future integrations & observability *(design notes — NOT v1 wire surface)*

> **Future integrations (design stubs — NOT v1).** Of the original design stubs, **Sandbox /
> DevContainer** workspace configuration remains a future per-workspace execution-environment
> surface — anticipated but **not** exposed over the protocol in v1, folded into the same future
> track.
>
> **Linear** (issue tracking) is re-implemented daemon-owned against Linear's GraphQL API
> (**no Augment proxy**) as the `linear.*` namespace — **specified as a TARGET contract — see §5.28**.
>
> **Sentry** (error tracking) is re-implemented daemon-owned against Sentry's REST API
> (**no Augment proxy**) as the `sentry.*` namespace — **specified as a TARGET contract — see §5.29**.
>
> These are documented so the surface is anticipated.

> **Observability is internal, not wire.** Tracing, structured logging, and log files are
> **daemon-internal** operational concerns — there is **no** `logging.*` / `telemetry.*` wire
> surface, and none is planned for v1. Clients observe backend work through domain **events** (§6.5),
> not through a logging API.

### 5.27 `github.*` namespace

> The `github.*` namespace is served **daemon-owned** against `api.github.com` — 24 methods (23 network reads/writes plus the cached-first `github.branches.listCached` — one-shot ls-remote fallback on a miss — v6.2), with real `nextToken`/`limit` pagination on the list reads (the uniform-pagination contract described in the conventions below), reusing the `intent-sourcecontrol` **octocrab** engine — the same engine that already backs `pr.*`. The auth trio (`connect` / `cancelAuth` / `revoke`) drives a daemon-owned **OAuth device flow** (see the auth-model note below). The field names and shapes here are the source of truth for both sides.
>
> **Namespace split.** Local git operations stay on `git.*` (§5.6). Everything
> that hits `api.github.com` — repo/PR/issue browse, PR review comments + threads — plus GitHub
> **auth** and GitHub-**derived identity** live on `github.*`. The surviving `pr.*` methods (§5.7 —
> `pr.status` / `pr.refresh` since the v5.0 removal) are deliberately **workspace/active-PR scoped**
> (`ws` → owner/repo/number) and are left **untouched**;
> `github.*` is the **explicit-addressing** surface — every data method takes `(owner, repo[, number])`
> rather than resolving from the workspace.

> **Auth model — OAuth device flow, daemon-owned (with env-PAT fallbacks).** `github.connect`
> starts GitHub's **OAuth device flow** (no client secret, no callback URL — only a public OAuth
> App client id, `sourceControl.github.oauthClientId`): the daemon requests a `user_code`, hands it
> to the client, and **polls GitHub in the background** until the user authorizes at
> `github.com/login/device` (or the codes expire / the user denies). On authorize the access token
> is persisted server-side under `sourceControl.github.token` — the **first slot** of the existing
> `intent-sourcecontrol` resolution chain, ahead of the `GITHUB_TOKEN` / `GH_TOKEN` env vars and
> the `gh auth token` fallback (§5.12) — so every `github.*` / `pr.*` consumer picks it up with
> zero resolution changes. Because the daemon owns the poll loop, the flow **survives client
> refreshes**: a reconnecting client re-reads the in-flight state from `github.authStatus`.
> On authorize the daemon also **best-effort** authenticates a locally installed `gh` CLI with the
> stored token (piped via stdin only, never argv or logs; skipped when `gh` is absent or already
> logged in — an existing `gh` login is never overwritten; a sync failure never affects the device
> flow — behavior-only, no wire-shape change).
>
> - `github.authStatus` validates the resolved token via `GET /user` and reports connection state,
>   plus the in-flight device flow (if any) under `deviceFlow`.
> - `github.connect` starts the flow (or returns the **same codes** while one is still pending —
>   idempotent); terminal transitions are pushed as `github:auth-changed` events (§6.5).
> - `github.cancelAuth` aborts a pending flow; `github.revoke` deletes the **stored** token (env /
>   `gh` fallbacks are untouched — they re-resolve on the next probe).
> - **Identity** is GitHub-derived: `github.getUser` returns the authenticated user from `GET /user`.
>
> **🔒 Secret guardrail.** The PAT is a secret: it is **never logged, echoed, or returned** over the
> wire. Only **derived identity** fields (login, avatar, profile URL) and the boolean
> connection state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `shared/types.ts` GitHub shapes
(`GithubRepo` / `GithubUser` / `GithubPullRequest` / `GithubIssue`, and the review-comment /
review-thread shapes) **field-for-field**, rendered in this protocol's **camelCase** convention
(serde `rename_all = "camelCase"`, matching `pr.*` in §5.7 and the rest of the catalog). The FE's
Augment-proxy passthrough exposed GitHub-native **snake_case**; on the `github.*` wire those keys
are normalized to camelCase: `html_url → htmlUrl`, `created_at → createdAt`, `updated_at → updatedAt`,
`merged_at → mergedAt`, `closed_at → closedAt`, `default_branch → defaultBranch`, `head_ref → headRef`,
`base_ref → baseRef`, `head_sha → headSha`, `base_sha → baseSha`, `mergeable_state → mergeableState`,
`review_comments → reviewComments`, `changed_files → changedFiles`, `avatar_url → avatarUrl`,
`in_reply_to_id → inReplyToId`. The set of fields is otherwise identical to the FE types.

**Conventions.** Unless noted, `owner` + `repo` are **(req)** string params (and `number` is the
**(req)** PR/issue number where applicable). Reads that paginate follow the uniform pagination
contract: an optional `limit` (default **50**, max **200**) plus an opaque `nextToken` cursor echoed
in the result (`nextToken: null` when there are no further pages). Errors reuse the §9 conventions:
missing/invalid params and "not found" (404) lookups → `-32602` **unless a method row documents a
graceful null/exists result** (e.g. `github.repos.get` → `{ repo: null }`, `github.repoConfig.get`
→ `{ config: null, exists: false }`); a token that is absent or fails `GET /user`, and any other
GitHub/service failure → `-32603` with a descriptive `message`
(e.g. `"GitHub is not configured."`). There are **no** custom numeric codes.

#### Repos & branches

| Method | Params | Result |
| --- | --- | --- |
| github.repos.list | limit?, nextToken? | { repos: GithubRepo[], nextToken? } — the authenticated user's repositories (`GET /user/repos`) |
| github.repos.search | query (req), limit?, nextToken? | { repos: GithubRepo[], nextToken? } — `GET /search/repositories` (FE rewrites `owner/name` → `name user:owner`, sorted by stars) |
| github.repos.get | owner (req), repo (req) | { repo: GithubRepo \| null } — `GET /repos/{owner}/{repo}` (repo metadata incl. `defaultBranch`) |
| github.branches.list | owner (req), repo (req), prefix?, limit?, nextToken? | { branches: string[], nextToken? } — **remote** branch names. Absent or blank `prefix` → the unfiltered listing (`GET /repos/{owner}/{repo}/branches`), paged upstream exactly as before. A non-blank `prefix` → server-side prefix search via the git refs API (`GET /repos/{owner}/{repo}/git/matching-refs/heads/{prefix}`; slashes in the prefix preserved as path separators, other characters percent-encoded), mapping `refs/heads/<name>` onto branch names — GitHub ignores `per_page`/`page` on that endpoint and returns the entire match set, so the daemon applies the `(limit, nextToken)` window client-side (an exactly-full final page ends with no `nextToken`; pages past the end are empty). Response shape is unchanged either way (prefix intentd#1081) |
| github.branches.listCached | owner (req), repo (req) | { cached: boolean, source?: "cache" \| "ls-remote", branches: string[], defaultBranch? } — **cached-first with a one-shot ls-remote fallback**: a warm cache serves branch names from the daemon's local repo cache (`.repo-cache/{owner}/{repo}`) with no network I/O — remote-tracking names (`refs/remotes/origin/*`, the `HEAD` symref excluded), sorted, as `{ cached: true, source: "cache", … }`; `defaultBranch` derives from the `origin/HEAD` symref — recorded at clone time and re-resolved on every cache refresh (`git remote set-head origin --auto`), so it tracks upstream default-branch changes — and is **omitted when unresolvable**. A cold cache or foreign-origin repo falls back to a single `git ls-remote --symref` against the GitHub remote (token offered via env like the clone pipeline, never argv; intentd#1072) → `{ cached: false, source: "ls-remote", branches, defaultBranch? }` — branch short names sorted, `defaultBranch` from the remote `HEAD` symref (omitted when not advertised). A failed fallback (offline, missing repo, no access) → `{ cached: false, branches: [] }` with `source` omitted — graceful, **never an error** (an explicit exception to the namespace's error conventions above, like `github.repoConfig.get`); invalid `owner`/`repo` path segments → `-32602`. FE consumption is cached-first: the branch picker renders a warm-cache result instantly, and the fallback means a cold cache still paints real branches; `github.branches.list` (and the repo's `defaultBranch`) remain the paged authoritative read (v6.2; fallback + additive `source` field intentd#1072) |
| github.repoConfig.get | owner (req), repo (req), ref? | { config: RepoConfig \| null, exists: boolean } — the repo's `.intent/config.json` fetched via the contents API (`GET /repos/{owner}/{repo}/contents/.intent/config.json`, no clone; `ref` defaults to the default branch). A missing file (or missing repo/ref) → `{ config: null, exists: false }` — an **explicit exception** to the namespace's 404→`-32602` convention above: all 404s are graceful "no config" outcomes, never errors (transport/auth failures still surface as `-32603` like the other `github.*` methods). A present but invalid/mis-shaped file folds **tolerantly** to `{ config: {}, exists: true }` (mirrors the `repoConfig.get` §5.33 parse semantics). Same camelCase `RepoConfig` shape as §5.33, unknown keys preserved (v2.4) |

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| github.authStatus | — | { isConfigured, oauthUrl, configuredButNeedsUpdate, updatedScopes, deviceFlow } — `isConfigured` = a token resolves **and** `GET /user` succeeds. `deviceFlow` is `null` when no flow is in flight, else `{ status: "pending"\|"expired"\|"denied"\|"error", userCode, verificationUri, expiresIn, interval }`; while a flow is live `oauthUrl` carries the `verificationUri` (FE shape parity). `configuredButNeedsUpdate` is `false` and `updatedScopes` is `""` (kept for FE shape parity) |
| github.connect | — | { ok: true, userCode, verificationUri, expiresIn, interval } — starts the OAuth **device flow** (or returns the SAME codes while one is pending — idempotent). The daemon polls GitHub in the background; terminal transitions arrive as `github:auth-changed` events (§6.5). A missing/empty `sourceControl.github.oauthClientId` or an unreachable login host → `-32603` |
| github.cancelAuth | — | { ok: true, cancelled } — aborts a pending device flow (`cancelled: true` iff one was pending; idempotent no-op otherwise) |
| github.revoke | — | { ok: true } — deletes the **stored** `sourceControl.github.token` and aborts any in-flight flow; emits `github:auth-changed { status: "revoked" }`. Idempotent; env / `gh` fallbacks are untouched. Also best-effort logs a locally installed `gh` out of github.com, but **only** when gh's active token exactly matches the token being revoked — i.e. the login the authorize-side sync created; any other gh login is never touched, and a logout failure never affects the revoke (behavior-only, no wire-shape change) |
| github.getUser | — | { user: GithubUser \| null } — authenticated identity from `GET /user`; never includes the token |

#### Pulls

`createPullRequest` sends `head` **verbatim** (no `owner:branch` login prefix) — preserving the
FE's "bypass the buggy backend" behavior for same-repo branches.

| Method | Params | Result |
| --- | --- | --- |
| github.pulls.create | owner (req), repo (req), title (req), body (req), head (req), base (req), draft? | { pull: GithubPullRequest \| null } — `POST /repos/{owner}/{repo}/pulls` (head verbatim) |
| github.pulls.get | owner (req), repo (req), number (req) | { pull: GithubPullRequest \| null } — `GET /repos/{owner}/{repo}/pulls/{number}` |
| github.pulls.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", head?, base?, sort?: "created"\|"updated"\|"popularity"\|"long-running", direction?: "asc"\|"desc", limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /repos/{owner}/{repo}/pulls` |
| github.pulls.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"review-requested"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { pulls: GithubPullRequest[], nextToken? } — `GET /search/issues?q=is:pr repo:{o}/{r} is:{state} {author\|assignee\|review-requested\|involves}:@me {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter:"all"`+`state:"open"` with no `query` delegates to `github.pulls.list` |
| github.pulls.merge | owner (req), repo (req), number (req), mergeMethod?: "merge"\|"squash"\|"rebase", commitTitle?, commitMessage? | { merged, message, sha? } — `PUT /repos/{owner}/{repo}/pulls/{number}/merge` |
| github.pulls.updateBranch | owner (req), repo (req), number (req), expectedHeadSha? | { message, url? } — `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` |

#### Issues

| Method | Params | Result |
| --- | --- | --- |
| github.issues.list | owner (req), repo (req), state?: "open"\|"closed"\|"all", assignee?, creator?, labels?, sort?: "created"\|"updated"\|"comments", direction?: "asc"\|"desc", limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /repos/{owner}/{repo}/issues` (items carrying `pull_request` are filtered out) |
| github.issues.search | owner (req), repo (req), filter?: "all"\|"assigned"\|"created"\|"involves", state?: "open"\|"closed", query?, limit?, nextToken? | { issues: GithubIssue[], nextToken? } — `GET /search/issues?q=is:issue repo:{o}/{r} [state:{state}] {query}`; `query` is free text (trimmed; blank == absent; qualifier/boolean tokens are quoted into literals so the `repo:` scope cannot widen); `filter` is validated (invalid → `-32603`) but — unlike `github.pulls.search` — adds **no** `@me` qualifier yet (v1 limitation: the engine cannot express issue involvement), so only a non-blank `query` routes through `GET /search/issues`; without one the method delegates to the repo-issue listing (`GET /repos/{o}/{r}/issues`) filtered by state, regardless of `filter` |

#### Review comments & threads

Review **comments** are the REST inline comments (`/pulls/{n}/comments`); review **threads** are the
GraphQL `pullRequest.reviewThreads` with resolve state — `resolveThread` / `unresolveThread` map to
the GraphQL `resolveReviewThread` / `unresolveReviewThread` mutations (parity with the FE's
`pr-comment.service.ts`).

| Method | Params | Result |
| --- | --- | --- |
| github.listReviewComments | owner (req), repo (req), number (req), limit?, nextToken? | { comments: ReviewComment[], nextToken? } — `GET /repos/{owner}/{repo}/pulls/{number}/comments` |
| github.replyReviewComment | owner (req), repo (req), number (req), commentId (req), body (req) | { comment: ReviewComment } — `POST /repos/{owner}/{repo}/pulls/{number}/comments` (`inReplyToId = commentId`) |
| github.getReviewThreads | owner (req), repo (req), number (req), limit?, nextToken? | { threads: ReviewThread[], nextToken? } — GraphQL `pullRequest.reviewThreads` |
| github.resolveThread | threadId (req) | { isResolved: true } — GraphQL `resolveReviewThread` |
| github.unresolveThread | threadId (req) | { isResolved: false } — GraphQL `unresolveReviewThread` |

#### DTO schemas

```ts
interface GithubRepo {
  owner: string;
  name: string;
  htmlUrl?: string;
  createdAt?: string;     // ISO 8601
  updatedAt?: string;     // ISO 8601
  defaultBranch?: string;
}

interface GithubUser {     // derived identity — never carries the PAT
  login: string;
  avatarUrl: string;
  htmlUrl: string;
}

interface GithubPullRequest {
  number: number;
  title: string;
  body: string;
  state: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  user: GithubUser;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  draft: boolean;
  mergeable?: boolean | null;
  mergeableState?: string;
  labels: string[];
  assignees?: GithubUser[];
  comments: number;
  reviewComments: number;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  user: GithubUser;
  labels: string[];
  comments: number;
  owner?: string;          // repository owner (echoed for convenience)
  repo?: string;           // repository name
}

interface ReviewComment {  // REST inline review comment
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
  inReplyToId?: number;
  htmlUrl: string;
}

interface ReviewThread {   // GraphQL review thread
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

interface ReviewThreadComment {
  id: string;
  body: string;
  author: { login: string };
  path: string;
  line: number | null;
  createdAt: string;
}
```

#### Examples

```json
// → check GitHub auth (validates the resolved token via GET /user)
{ "jsonrpc":"2.0","id":50,"method":"github.authStatus","params":{} }
// ← response (token present and valid, no flow in flight)
{ "jsonrpc":"2.0","id":50,"result":{
  "isConfigured": true, "oauthUrl": "", "configuredButNeedsUpdate": false, "updatedScopes": "",
  "deviceFlow": null } }
```

```json
// → derived identity (no token ever returned)
{ "jsonrpc":"2.0","id":51,"method":"github.getUser","params":{} }
// ← response
{ "jsonrpc":"2.0","id":51,"result":{ "user":{
  "login":"octocat","avatarUrl":"https://avatars.githubusercontent.com/u/1","htmlUrl":"https://github.com/octocat" } } }
```

```json
// → create a PR with the head ref sent verbatim (no login prefix)
{ "jsonrpc":"2.0","id":52,"method":"github.pulls.create",
  "params":{ "owner":"octocat","repo":"hello","title":"Add feature","body":"…",
    "head":"feature/x","base":"main","draft":false } }
// ← response
{ "jsonrpc":"2.0","id":52,"result":{ "pull":{
  "number":42,"title":"Add feature","state":"open","htmlUrl":"https://github.com/octocat/hello/pull/42",
  "headRef":"feature/x","baseRef":"main","draft":false,"merged":false,
  "user":{ "login":"octocat","avatarUrl":"…","htmlUrl":"…" } } } }
```

```json
// → start the OAuth device flow (daemon polls GitHub in the background)
{ "jsonrpc":"2.0","id":53,"method":"github.connect","params":{} }
// ← response — the user enters userCode at verificationUri
{ "jsonrpc":"2.0","id":53,"result":{
  "ok": true, "userCode": "ABCD-1234", "verificationUri": "https://github.com/login/device",
  "expiresIn": 900, "interval": 5 } }
// … the user authorizes on github.com; the daemon's background poll persists
//   the token server-side and pushes the terminal transition:
{ "jsonrpc":"2.0","method":"events.event","params":{ "subscriptionId":"…","event":{
  "type":"github:auth-changed", "data":{ "status":"authorized" }, "…":"…" } } }
```

### 5.28 `linear.*` namespace

> The full `linear.*` read surface — `linear.authStatus`, `linear.listIssues`, `linear.searchIssues`, `linear.getIssue`, `linear.viewer`, `linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`, `linear.listLabels` — plus the issue-write methods `linear.createIssue` / `linear.updateIssue` are served **daemon-owned** against Linear's GraphQL API (`POST https://api.linear.app/graphql`) via the `intent-linear` crate. The `filter` values map to **typed Linear GraphQL filters server-side**. Only the `linear.listComments` / `linear.createComment` comment surface (no FE shape) remains out of scope — see "Deferred — comments" below. The field names and shapes here are the source of truth for both sides.

> **Auth model — personal API key (no OAuth/device flow).** A local
> daemon has no hosted OAuth callback, so v1 authenticates with a **Linear personal API key**: the
> default `auto` resolution tries the secret-store account `linear.token` first (the daemon's
> file-backed secret store; settable via `settings.update { path: "linear.token" }`, §5.12), then falls back to the
> `LINEAR_API_KEY` environment variable. Linear is GraphQL-only; the key is sent as the **`Authorization: <key>` header
> with NO `Bearer` prefix** for `lin_api_…` personal keys (a future OAuth access token would use
> `Authorization: Bearer <token>` — the prefix differs by credential type).
>
> - `linear.authStatus` validates the resolved key via the GraphQL `viewer` probe and reports
>   connection state.
> - **There is no `linear.connect` / `linear.revoke` / `cancelAuth` wire method.** Unlike `github.*`
>   (which keeps inert no-op `connect`/`revoke` for FE shape parity), Linear exposes **nothing**
>   here: "connect" is `settings.update` on the `linear.token` catalog entry (§5.12) — or set
>   `LINEAR_API_KEY` — "revoke/logout" is `settings.reset { path: "linear.token" }`, and
>   `cancelAuth` was always a pure client-side no-op.
>
> **🔒 Secret guardrail.** The API key is a secret: it is **never logged, echoed, or returned** over
> the wire. Only **derived identity** (the `login` from `viewer`) and the boolean connection state
> cross the wire — never the key itself.

**Field naming.** The DTOs below mirror the FE `src/features/linear-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all = "camelCase"`,
matching `github.*` §5.27 and the rest of the catalog). The wire returns the **flattened
`LinearIssueResult`** — the exact shape the FE's `fetchMyIssues` / `searchIssues` already consume —
so the rewire is zero-FE-change: nested Linear relations (`team` / `state` / `assignee` / `creator`
/ `project` / `labels`) are pre-flattened to scalar / `string[]` fields server-side. Absent
(`None`) optional fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). The two issue reads — `linear.listIssues` and `linear.searchIssues` — are
**cursor-paginated** per the §5.5 conventions: they accept an optional **opaque base64**
`nextToken` (the token echoed by a previous page; a malformed token degrades to the first
page, matching the `github.*` reads) and return a
`{ issues: LinearIssueResult[], nextToken: string|null }` envelope where `nextToken` is an
opaque base64 string when another page exists and an explicit `null` on the last page. The
underlying Linear GraphQL `pageInfo.endCursor` / `after` cursor is a server-side detail
clients MUST treat as opaque. Every other Linear arm returns a **bare result** — either a
bare object (`linear.authStatus`, `linear.viewer`, `linear.getIssue`) or a bare array
(`linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`,
`linear.listLabels`) — with **no envelope and no cursor** (those catalogs are small and
bounded). Absent (`None`) optional fields are **omitted** from the JSON. Errors reuse the §9
conventions: missing/invalid params → `-32602` (e.g. `linear.getIssue` requires `id` **or**
`identifier`, otherwise `Missing required parameter: id`); a key that is **absent or fails the
`viewer` probe** ("not configured"), and any other Linear/service failure → `-32603` with a
descriptive `message` (e.g. `"Linear is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| linear.authStatus | — | { authenticated, login?, scopes } — `authenticated` = env key resolves **and** the GraphQL `viewer { id name email }` probe succeeds; `login` is the viewer's name/email; `scopes` is always `[]` (Linear's `viewer` returns no key scopes). Never includes the key. |

#### Issues

`filter` maps to a typed Linear GraphQL filter **server-side**.
`linear.listIssues` backs the FE's `fetchMyIssues`; `linear.searchIssues`
backs the FE's `searchIssues`. Both return the paginated `{ issues, nextToken }` envelope
(see Conventions above): pass the returned `nextToken` back as a param to fetch the next page.
`linear.getIssue` resolves a single flattened `LinearIssueResult` by UUID `id` **or** `ENG-123`-style
`identifier` (the engine picks the lookup mode by string shape); it is not consumed by the FE today
but completes the read surface.

| Method | Params | Result |
| --- | --- | --- |
| linear.listIssues | filter?: "assigned"\|"created"\|"subscribed"\|"team"\|"all" (default "assigned"), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — the authenticated viewer's issues for the typed `filter`; `nextToken` is an opaque base64 string when another page exists, else `null` |
| linear.searchIssues | query (req), limit?, nextToken? | { issues: LinearIssueResult[], nextToken } — full-text issue search, same cursor semantics |
| linear.getIssue | id \| identifier (one required — UUID `id` or `ENG-123`-style `identifier`) | LinearIssueResult — one flattened issue |

#### Viewer & catalogs

`linear.viewer` returns the authenticated user as a bare `LinearUser`; the four list methods return
small bounded catalogs (teams, workflow states, projects, labels) as bare DTO arrays. All four
lists accept an optional `limit`. None of these reads are currently consumed by the FE — they are
forward-looking surface for a future create/edit UI.

| Method | Params | Result |
| --- | --- | --- |
| linear.viewer | — | LinearUser — the authenticated user |
| linear.listTeams | limit? | LinearTeam[] |
| linear.listWorkflowStates | limit? | LinearWorkflowState[] |
| linear.listProjects | limit? | LinearProject[] |
| linear.listLabels | limit? | LinearLabel[] |

#### DTO schemas

```ts
interface AuthStatus {          // shared with the auth probe; never carries the API key
  authenticated: boolean;
  login?: string;               // viewer name or email
  scopes: string[];             // always [] — Linear's viewer returns no key scopes
}

interface LinearIssueResult {   // flattened UI shape — matches the FE verbatim
  id: string;
  identifier: string;           // e.g. "ENG-123"
  title: string;
  description?: string;
  url?: string;
  teamName?: string;
  teamKey?: string;             // e.g. "ENG"
  state?: string;               // workflow-state name
  priority?: number;            // Linear priority 0–4
  assignee?: string;            // assignee display name
  labels?: string[];            // label names
  project?: string;             // project name
  creator?: string;             // creator name
  createdAt?: string;           // ISO 8601
  updatedAt?: string;           // ISO 8601
}

interface LinearUser {          // linear.viewer
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

interface LinearTeam {          // linear.listTeams entry
  id: string;
  key: string;                  // e.g. "ENG"
  name: string;
  description?: string;
}

interface LinearWorkflowState { // linear.listWorkflowStates entry
  id: string;
  name: string;
  type: string;                 // "backlog" | "unstarted" | "started" | "completed" | "canceled"
  description?: string;
  color?: string;
}

interface LinearProject {       // linear.listProjects entry
  id: string;
  name: string;
  description?: string;
  state: string;                // "backlog" | "planned" | "started" | "paused" | "completed" | "canceled"
  url?: string;
}

interface LinearLabel {         // linear.listLabels entry
  id: string;
  name: string;
  description?: string;
  color?: string;
}
```

#### Examples

```json
// → check Linear auth (validates the env key via the GraphQL viewer probe)
{ "jsonrpc":"2.0","id":54,"method":"linear.authStatus","params":{} }
// ← response (LINEAR_API_KEY present and valid)
{ "jsonrpc":"2.0","id":54,"result":{ "authenticated": true, "login": "Ada Lovelace", "scopes": [] } }
```

```json
// → issues assigned to the authenticated viewer (typed filter, no NL prompt)
{ "jsonrpc":"2.0","id":55,"method":"linear.listIssues","params":{ "filter":"assigned","limit":50 } }
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":55,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamName":"Engineering","teamKey":"ENG","priority":2,"assignee":"Ada Lovelace",
    "labels":["bug"],"url":"https://linear.app/acme/issue/ENG-123" } ],
  "nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":56,"method":"linear.searchIssues","params":{ "query":"widget","limit":20,"nextToken":"eyJjIjoiY3Vyc29yLTIifQ" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":56,"result":{ "issues":[
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","teamKey":"ENG",
    "url":"https://linear.app/acme/issue/ENG-123" } ], "nextToken":null } }
```

```json
// → one issue by ENG-123 identifier (or pass `id` for a UUID)
{ "jsonrpc":"2.0","id":57,"method":"linear.getIssue","params":{ "identifier":"ENG-123" } }
// ← response (single flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":57,"result":
  { "id":"a1b2","identifier":"ENG-123","title":"Fix the widget","state":"In Progress",
    "teamKey":"ENG","url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → the authenticated user
{ "jsonrpc":"2.0","id":58,"method":"linear.viewer","params":{} }
// ← response (bare LinearUser; absent optionals omitted)
{ "jsonrpc":"2.0","id":58,"result":
  { "id":"u1","name":"Ada Lovelace","displayName":"ada","email":"ada@example.com" } }
```

```json
// → list teams (bare array; optional limit caps the result)
{ "jsonrpc":"2.0","id":59,"method":"linear.listTeams","params":{ "limit":50 } }
// ← response (bare LinearTeam[])
{ "jsonrpc":"2.0","id":59,"result":[
  { "id":"t1","key":"ENG","name":"Engineering" } ] }
```

#### Writes — P2 (createIssue / updateIssue)

`linear.createIssue` runs the `issueCreate` GraphQL mutation; `linear.updateIssue` runs
`issueUpdate`. The router validates the required wire fields up front — `createIssue` requires a
non-empty `title` **and** `teamId`, `updateIssue` requires a non-empty `issueId` (otherwise
`-32602` `Missing required parameter: <field>`) — and forwards only the fields present. Both return
the **flattened `LinearIssueResult`** (the same shape as the reads). A key that is **absent or
fails the `viewer` probe** ("not configured"), and any other Linear/service failure → `-32603`.
🔒 The API key is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| linear.createIssue | title (req), teamId (req), description?, assigneeId?, stateId?, priority?, labelIds? | LinearIssueResult — the created issue, flattened |
| linear.updateIssue | issueId (req), title?, description?, assigneeId?, stateId?, priority? | LinearIssueResult — the updated issue, flattened |

##### DTO schemas

```ts
interface CreateIssueRequest {  // linear.createIssue — `title` + `teamId` required
  title: string;
  teamId: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
  labelIds?: string[];
}

interface UpdateIssueRequest {  // linear.updateIssue — `issueId` required; rest optional
  issueId: string;
  title?: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;            // Linear priority 0–4
}
```

##### Examples

```json
// → create an issue (title + teamId required)
{ "jsonrpc":"2.0","id":60,"method":"linear.createIssue",
  "params":{ "title":"New issue","teamId":"team-uuid","priority":2,"labelIds":["l1"] } }
// ← response (flattened LinearIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":60,"result":
  { "id":"a1b2","identifier":"ENG-200","title":"New issue","teamKey":"ENG","priority":2,
    "url":"https://linear.app/acme/issue/ENG-200" } }
```

```json
// → missing required `teamId` → -32602
{ "jsonrpc":"2.0","id":61,"method":"linear.createIssue","params":{ "title":"X" } }
// ← error
{ "jsonrpc":"2.0","id":61,"error":{ "code":-32602,"message":"Missing required parameter: teamId" } }
```

```json
// → update an issue (issueId required; only present fields are sent through IssueUpdateInput)
{ "jsonrpc":"2.0","id":62,"method":"linear.updateIssue",
  "params":{ "issueId":"uuid-1","title":"Updated","stateId":"s1" } }
// ← response (flattened LinearIssueResult)
{ "jsonrpc":"2.0","id":62,"result":
  { "id":"uuid-1","identifier":"ENG-123","title":"Updated","state":"Done",
    "url":"https://linear.app/acme/issue/ENG-123" } }
```

```json
// → not-configured (no LINEAR_API_KEY, or the viewer probe fails) → -32603
{ "jsonrpc":"2.0","id":63,"method":"linear.createIssue","params":{ "title":"X","teamId":"t1" } }
// ← error
{ "jsonrpc":"2.0","id":63,"error":{ "code":-32603,"message":"Linear is not configured." } }
```

#### Deferred — comments (NOT in this phase)

The read surface (P0 + P1) and the P2 issue writes ship now (above). Only the comment surface
remains **out of scope** and is listed so it is anticipated:

- **Comments (no FE shape):** `linear.listComments` / `linear.createComment` — comments are not
  modeled in the FE at all. Do **not** build unless a feature requires them.

When built, the comment methods extend this `linear.*` namespace additively (with their own §9
error rows and any events) and do not change the contract above.

### 5.29 `sentry.*` namespace

> The full `sentry.*` surface — the reads
> `sentry.authStatus`, `sentry.listIssues`, `sentry.searchIssues`,
> `sentry.listProjects`, `sentry.getIssue`; and the writes `sentry.resolveIssue`,
> `sentry.ignoreIssue`, `sentry.assignIssue` — is served **daemon-owned** against Sentry's REST
> API (`GET https://sentry.io/api/0/organizations/{org}/issues/`) via the `intent-sentry`
> crate (wire arm: `intent-services` `sentry_ops` → `intent-transport` router). The `status`
> filter maps to a **typed `is:<status>` clause** server-side, and `query` is forwarded
> verbatim as the Sentry search string. The field names and shapes here are the source of
> truth for both sides.

> **Auth model — token + org from the environment (no OAuth/device flow, no
> `connect`/`revoke`).** A local daemon has no hosted OAuth callback, so v1 authenticates with
> a **Sentry user/internal-integration auth token + organization slug resolved from the
> environment**: `SENTRY_API_TOKEN` (with an optional lower-priority secret-store account
> `sentry.token`) plus `SENTRY_ORG` (organization slug). Sentry is REST-only; the token is sent
> as the **`Authorization: Bearer <token>`** header.
>
> - `sentry.authStatus` validates the resolved pair via `GET /organizations/{org}/` and reports
>   connection state.
> - **There is no `sentry.connect` / `sentry.revoke` / `cancelAuth` wire method.** As with
>   `linear.*`, Sentry exposes **nothing** here: "connect" becomes "set `SENTRY_API_TOKEN` +
>   `SENTRY_ORG` and restart", "revoke/logout" is a local "forget token" action, and `cancelAuth`
>   was always a pure client-side no-op. The settings UI buttons are inert.
>
> **🔒 Secret guardrail.** The auth token is a secret: it is **never logged, echoed, or returned**
> over the wire. Only **derived identity** (the `organization` slug) and the boolean connection
> state cross the wire — never the token itself.

**Field naming.** The DTOs below mirror the FE `src/features/sentry-auth/types.ts` shapes
**field-for-field** in this protocol's **camelCase** convention (serde `rename_all =
"camelCase"`, matching `github.*` §5.27 / `linear.*` §5.28 and the rest of the catalog). The
wire returns the **flattened `SentryIssueResult`** — the exact shape the FE's `fetchIssues` /
`searchIssues` already consume — so the rewire is zero-FE-change: nested Sentry relations
(`project` → `projectName`/`projectSlug`, `metadata` → `type`/`value`/`filename`/`function`,
`permalink` → `url`) are pre-flattened to scalar fields server-side. Absent (`None`) optional
fields are **omitted** from the JSON.

**Conventions.** All list-style reads take an optional `limit` (a cap on the number of items
returned). The two issue reads — `sentry.listIssues` and `sentry.searchIssues` — are
**cursor-paginated** per the §5.5 conventions (parity with `linear.listIssues` /
`linear.searchIssues`, §5.28): they accept an optional **opaque base64** `nextToken` (the
token echoed by a previous page; a malformed token degrades to the first page, matching the
`github.*` reads) and return a `{ issues: SentryIssueResult[], nextToken: string|null }`
envelope where `nextToken` is an opaque base64 string when another page exists and an
explicit `null` on the last page. The underlying Sentry `Link`-header page cursor is a
server-side detail clients MUST treat as opaque. Every other Sentry arm returns a **bare
result** — either a bare object (`sentry.authStatus`, `sentry.getIssue`, the P2 writes) or a
bare array (`sentry.listProjects`) — with **no envelope and no cursor**. Absent (`None`)
optional fields are **omitted** from the JSON.
Errors reuse the §9 conventions: missing/invalid params → `-32602` (e.g. `sentry.searchIssues`
requires `query`, otherwise `Missing required parameter: query`; an invalid `status` not in
`unresolved`|`resolved`|`ignored`|`all` → `Invalid params: status must be one of: unresolved,
resolved, ignored, all`); a credential pair that is **absent or fails the org probe** ("not
configured"), and any other Sentry/service failure → `-32603` with a descriptive `message`
(e.g. `"Sentry is not configured."`). There are **no** custom numeric codes.

#### Auth & identity

| Method | Params | Result |
| --- | --- | --- |
| sentry.authStatus | — | { authenticated, organization?, error? } — `authenticated` = env credential pair resolves **and** the `GET /organizations/{org}/` probe succeeds; `organization` is the resolved org slug (derived identity only — never the token); `error` is a descriptive failure string when the probe fails. Never includes the token. |

#### Issues

`status` maps to a typed `is:<status>` clause **server-side**;
`query` is forwarded verbatim as the Sentry search string.
`sentry.listIssues` backs the FE's `fetchIssues`; `sentry.searchIssues` backs the FE's
`searchIssues`. Both return the paginated `{ issues, nextToken }` envelope (see Conventions
above): pass the returned `nextToken` back as a param to fetch the next page.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listIssues | project?, status?: "unresolved"\|"resolved"\|"ignored"\|"all" (default "unresolved"; any other value → `-32602`), query?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — issues matching the typed `is:<status>` clause (combined with optional `project` slug and free-text `query`); `nextToken` is an opaque base64 string when another page exists, else `null` |
| sentry.searchIssues | query (req — missing → `-32602`), project?, limit?, nextToken? | { issues: SentryIssueResult[], nextToken } — full-text issue search, same cursor semantics |
| sentry.getIssue | id \| shortId (one required — UUID/numeric `id` or `WEB-1`-style `shortId`; both missing → `-32602`) | SentryIssueResult — one flattened issue |

#### Projects (P1)

`sentry.listProjects` returns the configured organization's projects as a bare `SentryProject[]`
(parity with `linear.listTeams` / `linear.listProjects`); it accepts an optional `limit`. Not
consumed by the FE today — forward-looking surface for a future project picker.

| Method | Params | Result |
| --- | --- | --- |
| sentry.listProjects | limit? | SentryProject[] |

#### Writes — P2 (resolve / ignore / assign)

`sentry.resolveIssue` / `sentry.ignoreIssue` mutate the issue's status (`resolved` / `ignored`);
`sentry.assignIssue` sets the assignee. All three require a **non-empty `id`** (otherwise `-32602`
`Missing required parameter: id`); `assignIssue`'s `assignedTo` is **optional — an absent value
unassigns** the issue. Each returns the updated flattened `SentryIssueResult`. A credential pair
that is **absent or fails the org probe** ("not configured"), and any other Sentry/service failure
→ `-32603`. 🔒 The auth token is never logged, echoed, or returned.

| Method | Params | Result |
| --- | --- | --- |
| sentry.resolveIssue | id (req) | SentryIssueResult — the issue with `status: "resolved"` |
| sentry.ignoreIssue | id (req) | SentryIssueResult — the issue with `status: "ignored"` |
| sentry.assignIssue | id (req), assignedTo? (absent = unassign) | SentryIssueResult — the issue after (un)assignment |

#### DTO schemas

```ts
interface SentryAuthState {       // shared with the auth probe; never carries the token
  authenticated: boolean;
  organization?: string;          // resolved org slug (derived identity only)
  error?: string;                 // descriptive failure when the probe fails
}

interface SentryProject {         // sentry.listProjects entry
  id: string;
  slug: string;
  name: string;
  platform?: string;
  isMember?: boolean;
}

interface SentryIssueResult {     // flattened UI shape — matches the FE verbatim
  id: string;
  shortId: string;                // e.g. "PROJ-1"
  title: string;
  culprit?: string;
  status: "unresolved" | "resolved" | "ignored";
  level: "error" | "warning" | "info" | "fatal" | "debug";
  count: string;                  // total event count (Sentry returns a string)
  userCount: number;
  firstSeen: string;              // RFC-3339
  lastSeen: string;               // RFC-3339
  projectName: string;
  projectSlug: string;
  url?: string;                   // Sentry `permalink`
  type?: string;                  // metadata.type, e.g. "TypeError"
  value?: string;                 // metadata.value
  filename?: string;              // metadata.filename
  function?: string;              // metadata.function
}
```

#### Examples

```json
// → check Sentry auth (validates the env credential pair via the GET /organizations/{org}/ probe)
{ "jsonrpc":"2.0","id":70,"method":"sentry.authStatus","params":{} }
// ← response (SENTRY_API_TOKEN + SENTRY_ORG present and valid)
{ "jsonrpc":"2.0","id":70,"result":{ "authenticated": true, "organization": "acme" } }
```

```json
// → unresolved issues across the org (typed `is:unresolved` clause, no NL prompt)
{ "jsonrpc":"2.0","id":71,"method":"sentry.listIssues","params":{ "status":"unresolved","limit":50 } }
// ← response ({ issues, nextToken }; absent optionals omitted; `nextToken` is an
//   opaque base64 string when another page exists — pass it back to fetch the next page)
{ "jsonrpc":"2.0","id":71,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "type":"TypeError","filename":"src/app.ts",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ],
  "nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
```

```json
// → full-text issue search (next page via the returned token)
{ "jsonrpc":"2.0","id":72,"method":"sentry.searchIssues","params":{ "query":"TypeError","limit":20,"nextToken":"eyJjIjoiMDoxMDA6MCJ9" } }
// ← response (last page → explicit `nextToken: null`)
{ "jsonrpc":"2.0","id":72,"result":{ "issues":[
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } ], "nextToken":null } }
```

```json
// → missing required `query` → -32602
{ "jsonrpc":"2.0","id":73,"method":"sentry.searchIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":73,"error":{ "code":-32602,"message":"Missing required parameter: query" } }
```

```json
// → invalid `status` → -32602 (verbatim message)
{ "jsonrpc":"2.0","id":74,"method":"sentry.listIssues","params":{ "status":"bogus" } }
// ← error
{ "jsonrpc":"2.0","id":74,"error":{
  "code":-32602,"message":"status must be one of: unresolved, resolved, ignored, all" } }
```

```json
// → not-configured (no SENTRY_API_TOKEN/SENTRY_ORG, or org probe fails) → -32603
{ "jsonrpc":"2.0","id":75,"method":"sentry.listIssues","params":{} }
// ← error
{ "jsonrpc":"2.0","id":75,"error":{ "code":-32603,"message":"Sentry is not configured." } }
```

```json
// → one issue by shortId (or pass `id` for a UUID/numeric id)
{ "jsonrpc":"2.0","id":76,"method":"sentry.getIssue","params":{ "shortId":"WEB-1" } }
// ← response (single flattened SentryIssueResult; absent optionals omitted)
{ "jsonrpc":"2.0","id":76,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → getIssue with neither `id` nor `shortId` → -32602
{ "jsonrpc":"2.0","id":77,"method":"sentry.getIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":77,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

```json
// → list the org's projects (bare SentryProject[]; optional limit caps the result)
{ "jsonrpc":"2.0","id":78,"method":"sentry.listProjects","params":{ "limit":25 } }
// ← response (bare SentryProject[]; absent optionals omitted)
{ "jsonrpc":"2.0","id":78,"result":[
  { "id":"1","slug":"web","name":"Web","platform":"javascript","isMember":true } ] }
```

```json
// → resolve an issue (id required) → updated flattened issue with status "resolved"
{ "jsonrpc":"2.0","id":79,"method":"sentry.resolveIssue","params":{ "id":"1" } }
// ← response
{ "jsonrpc":"2.0","id":79,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"resolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → assign an issue; omit `assignedTo` to unassign
{ "jsonrpc":"2.0","id":80,"method":"sentry.assignIssue","params":{ "id":"1","assignedTo":"user-1" } }
// ← response (updated flattened SentryIssueResult)
{ "jsonrpc":"2.0","id":80,"result":
  { "id":"1","shortId":"WEB-1","title":"TypeError: foo is not a function","status":"unresolved",
    "level":"error","count":"12","userCount":3,"firstSeen":"2026-01-01T00:00:00Z",
    "lastSeen":"2026-01-02T00:00:00Z","projectName":"Web","projectSlug":"web",
    "url":"https://sentry.io/organizations/acme/issues/1/" } }
```

```json
// → a write with a missing/empty `id` → -32602
{ "jsonrpc":"2.0","id":81,"method":"sentry.resolveIssue","params":{} }
// ← error
{ "jsonrpc":"2.0","id":81,"error":{ "code":-32602,"message":"Missing required parameter: id" } }
```

