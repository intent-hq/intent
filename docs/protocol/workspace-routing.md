# Workspace routing preparation

This is an **additive contract ahead of component implementation**. It prepares
workspace calls for a future separate aggregator. It does not implement backend
discovery, forwarding, fan-out, placement, authentication, stream relaying, or new
method rejection in intentd. Direct daemon calls retain their current behavior.
Neither the protocol version nor this inventory advertises aggregator support.

The [private node lifecycle](./node-link.md#private-preparation-lifecycle) is
excluded from the public method inventory below. Its head-to-node preparation,
status and exact-run control operations are explicitly assignment-authorized;
they are not public catalog methods, agent workspace bindings or generic namespace
forwarding. A private control method name that resembles a client agent method
does not inherit that client's route or authority. Do not add private lifecycle
names to these public routing tables.

## Routing and compatibility

For the selected workspace variants below, a future forwarded request must carry
a real, non-empty workspace ID in the specified field. New routing-only
`params.workspaceId?: string` fields remain optional on direct daemon calls;
omission preserves old callers. Existing required fields remain required. The
originating action captures the ID: delayed responses, retries, cancellation,
reconnects and cleanup must not read whichever workspace is currently focused.
Resource IDs, repository paths, forge hosts and the literal `"global"` settings
placeholder are not substitutes for a routing destination.

Routing-only context selects the daemon; it does not filter the daemon's result,
change storage scope, grant access, change execution locality, or change a
mutation's side effects. Settings remain daemon settings, client lists remain
daemon client lists, and integration calls use that daemon's configured
credentials. Preserve redaction, setting revisions, membership/role checks and
existing provider-discovery self-healing. An agent permission snapshot still uses
its existing optional `agentId` filter; routing context does not add a filter.
Project specialist writes still require their explicit scope and path under the
existing contract. `specialist.list` still resolves user and bundled definitions;
it must not infer a project path from routing context.

Existing semantic fields take precedence over generic injection:

- `crossWorkspace.readNote` and `crossWorkspace.listNotes` route by
  **`targetWorkspaceId`**, never the caller's workspace.
- `search.notes`, `search.messages`, `search.events` and `events.subscribe` use `workspaceId` as
  an actual filter. Only their already-scoped variants are prepared; a global
  query cannot acquire the focused workspace as a filter. `preferWorkspaceId`
  is only a ranking hint, never a routing field.
- `mcp.servers.toggle` with `workspaceId` changes a workspace override; without
  it, the operation changes global enablement and stays outside this preparation.
  `mcp.servers.list` retains its workspace-disabled information.
- `rules.list` and `rules.get` carry the real workspace for workspace reads;
  direct global settings keep their existing omission or `"global"` placeholder.
  Routing does not make user overrides workspace-local.
- `host.exec` and `host.execStream` retain the execution-context and working-
  directory containment meaning of their existing optional `workspaceId`.
- `git.branchStatus` keeps `repoPath` precedence when both selectors are given.
  `workspaceId` plus `gitRootId` still resolves a registered workspace root; a
  `repoPath` call carries the real originating workspace without changing the path.
- `file.getAttachmentInfo` keeps exactly one selector: `attachmentId`, or
  `workspaceId` plus `idempotencyKey`. Workspace callers also carry the originating
  ID on the attachment-ID arm; it does not switch selectors or change lookup.

No blanket parameter injection is permitted. Workspace-originated reads with
daemon-wide results still carry routing context. Pre-workspace and direct global
settings flows remain usable directly, without inventing a destination. A future
aggregator must reject missing/unsupported routing context or define a separate
contract; this preparation adds no such error to direct intentd.

Client caches and pending work must distinguish connection plus workspace (and
provider, setting path or other resource key as appropriate). A late result or
event for workspace A cannot update workspace B's view or cache entry.

## Exact method and variant inventory

**Add** means a new optional routing-only `workspaceId`. **Propagate** means keep
the existing field and send the real context; its current required/optional and
semantic behavior is unchanged. **Exclude** means unchanged direct behavior,
with the reason shown. Names in a cell are complete wire names, not suffix
patterns. Repeated names have explicitly different variants. The inventory covers
the [main catalog](./05-method-catalog.md), both wire aliases, all seven
snapshot/delta channel pairs, and reverse RPCs. It does not turn MCP-only helpers
into wire methods.

### New optional routing fields

| Methods | Disposition | Routing field | Variant and preserved behavior |
| --- | --- | --- | --- |
| `models.list`, `agent.getModels`, `providers.catalog` | Add | `workspaceId` | Workspace model/provider catalogs, including legacy model reads and refreshes; preserve provider selection and cache behavior. |
| `host.providerDiscovery`, `host.providerAuthStatus` | Add | `workspaceId` | Workspace readiness reads; preserve existing discovery side effects, auth verdicts and filters. |
| `specialist.list`, `specialist.get` | Add | `workspaceId` | Workspace resolution reads; preserve provider context and explicit `workspacePath` on get; list remains user/bundled. |
| `specialist.create`, `specialist.edit`, `specialist.delete` | Add | `workspaceId` | Explicit `scope: "project"` only; preserve `workspacePath`, validation and project file writes. |
| `settings.list`, `settings.get`, `mcp.servers.getStatus` | Add | `workspaceId` | Workspace configuration reads; storage, redaction, access checks and server-ID meaning remain unchanged. |
| `system.capabilities`, `host.executionContext`, `host.status`, `host.env`, `host.toolAvailability`, `host.findBinary`, `host.checkGit`, `host.checkNode`, `host.checkGh`, `host.checkAuggie`, `client.list` | Add | `workspaceId` | Host/tool information used by a workspace. Results still describe the contacted daemon, including its entire connected-client registry. |
| `agent.queueMessage`, `agent.editQueuedMessage`, `agent.removeQueuedMessage`, `agent.stop`, `agent.pendingPermissions`, `agent.respondPermission`, `agent.rename`, `metrics.getAgentStats` | Add | `workspaceId` | Workspace-owned agent operations; retain original agent/message/request identifiers and snapshot filters. |
| `terminal.write`, `terminal.resize`, `terminal.kill`, `terminal.getBuffer`, `host.execStream.write`, `host.execStream.cancel` | Add | `workspaceId` | Follow-ups retain the workspace captured at terminal/exec creation and all existing ownership restrictions. |
| `search.cancel` | Add | `workspaceId` | Cancellation of a workspace-scoped search; retain its original `requestId`. |
| `file.attachmentUpload.chunk`, `file.attachmentUpload.commit`, `file.attachmentUpload.abort` | Add | `workspaceId` | Retain the workspace from upload begin together with `uploadId`, including retry and failure cleanup. |
| `workspace.export.read`, `workspace.export.finalize`, `workspace.export.abort` | Add | `workspaceId` | Source workspace from export start, together with `exportId`; see the complete export lifecycle below. |
| `chat.subscribe` | Add | `workspaceId` | Workspace owning `agentId`; preserve chat projection, resume cursor and delta encoding. |
| `events.unsubscribe`, `note.unsubscribe`, `task.unsubscribe`, `comment.unsubscribe`, `chat.unsubscribe`, `note.presence.unsubscribe` | Add | `workspaceId` | Workspace-owned connection subscriptions; retain the workspace alongside `subscriptionId`. Use `events.unsubscribe` for agent-collection teardown. |
| `git.getBranches`, `git.pull`, `git.getRemoteUrl` | Add | `workspaceId` | Existing-workspace `repoPath` operations only; preserve path selection and result shapes. |
| `github.repos.list`, `github.repos.search`, `github.repos.get`, `github.branches.list`, `github.branches.listCached`, `github.repoConfig.get`, `github.relatedRepos.list`, `github.users.search` | Add | `workspaceId` | Existing-workspace repository/user operations using configured credentials; pre-workspace discovery remains direct-only. |
| `github.pulls.checks`, `github.pulls.reviews`, `github.pulls.files`, `github.pulls.create`, `github.pulls.get`, `github.pulls.list`, `github.pulls.search`, `github.pulls.merge`, `github.pulls.updateBranch`, `github.issues.get`, `github.issues.list`, `github.issues.search`, `github.listReviewComments`, `github.replyReviewComment`, `github.getReviewThreads`, `github.resolveThread`, `github.unresolveThread` | Add | `workspaceId` | Existing-workspace integration operations; retain repo/thread selectors, permissions and existing side effects. |
| `github.authStatus`, `github.getUser`, `sourceControl.authStatus`, `sourceControl.getUser` | Add | `workspaceId` | Workspace credential-status reads. `sourceControl`'s `host` remains the forge host, not an intentd address. |
| `linear.authStatus`, `linear.listIssues`, `linear.searchIssues`, `linear.getIssue`, `linear.viewer`, `linear.listTeams`, `linear.listWorkflowStates`, `linear.listProjects`, `linear.listLabels`, `linear.createIssue`, `linear.updateIssue` | Add | `workspaceId` | Existing-workspace Linear calls, including writes, using configured credentials; no sign-in flow added. |
| `sentry.authStatus`, `sentry.listIssues`, `sentry.searchIssues`, `sentry.listProjects`, `sentry.getIssue`, `sentry.resolveIssue`, `sentry.ignoreIssue`, `sentry.assignIssue` | Add | `workspaceId` | Existing-workspace Sentry calls, including writes, using configured credentials; no sign-in flow added. |

### Existing workspace fields to propagate

| Methods | Disposition | Routing field | Variant and preserved behavior |
| --- | --- | --- | --- |
| `workspace.repositoryContext.capture`, `workspace.repositoryContext`, `workspace.repositoryContext.release` | Propagate | `workspaceId` | Prepared repository context contract: required captured workspace, exact inventory/root coverage and original physical connection. Reads and release retain the original lifetime; forwarding cannot rebind it to a replacement socket or focused workspace. |
| `workspace.repositorySelection.capture`, `workspace.repositorySelection.save`, `workspace.repositorySelection.reset`, `workspace.repositorySelection.reconcile`, `workspace.repositorySelection.release` | Propagate | `workspaceId` | Prepared selection contract: required workspace and exact root of the original editing operation. Preserve manager permission, immutable command and separate receipt/disclosure authority on the same original connection. |
| `accept-changes.reconcile`, `accept-changes.release` | Propagate | `workspaceId` | Prepared native review controls: required original workspace, root and operation ID. Retained receipts and cleanup stay on the original physical connection; no new-socket lookup, write replay or authority renewal. |
| `sourceControl.read.capture`, `sourceControl.read.detail`, `sourceControl.read.release` | Propagate | `workspaceId` | Prepared explicit resource reads: required authorization workspace and original connection/lifetime. The target project may differ from the workspace default; preserve its full instance/project/kind/IID. The forge URL is not a daemon routing address. |
| `workspace.get`, `workspace.update`, `workspace.delete`, `workspace.cancelDelete`, `workspace.archive`, `workspace.unarchive`, `workspace.dismissAttention`, `workspace.markSeen`, `workspace.diskUsage`, `workspace.localChanges`, `workspace.getTokenUsage`, `workspace.getAutoCommit`, `workspace.setAutoCommit`, `workspace.getBrowserClient`, `workspace.setBrowserClient`, `workspace.getSetupScript`, `workspace.saveSetupScript`, `workspace.detectProjectType`, `workspace.generateSetupScript`, `workspace.getContext`, `workspace.updateContext`, `workspace.getUiContext`, `workspace.updateUiContext`, `workspace.restore`, `workspace.cleanup` | Propagate | `workspaceId` | Existing workspace lifecycle, configuration and reads. |
| `workspace.duplicate` | Propagate | `workspaceId` | Existing source-workspace duplication on the contacted daemon; no cross-backend placement. |
| `workspace.export.start`, `workspace.transfer.plan` | Propagate | `workspaceId` | Required source workspace. Transfer plan remains the existing source-only helper; destination routing is excluded. |
| `workspace.members.list`, `workspace.members.add`, `workspace.members.remove`, `workspace.members.leave`, `workspace.invite.create`, `workspace.invite.list`, `workspace.invite.revoke` | Propagate | `workspaceId` | Existing workspace membership and invite administration; retain authority checks and connection restrictions. Separate identity/join bootstrap is excluded. |
| `note.list`, `note.get`, `note.create`, `note.update`, `note.add`, `note.edit`, `note.editLines`, `note.setContent`, `note.updateMetadata`, `note.delete`, `note.listTasks`, `note.readAsset`, `note.saveAsset`, `note.listVersions`, `note.getVersion`, `note.restoreVersion`, `note.lineAttribution.load`, `note.lineAttribution.computeNow` | Propagate | `workspaceId` | Existing note, version and asset operations. |
| `task.updateStatus`, `task.updateNoteStatus`, `task.update`, `task.getMyTask`, `task.markAsTask`, `task.setRelations`, `task.convertBlocks`, `task.createPrerequisite`, `task.assignAgent`, `task.removeAgentFromAllTasks`, `task.list`, `task.get`, `task.linkAgent`, `task.unlinkAgent`, `task.listAgentLinks` | Propagate | `workspaceId` | Existing workspace task operations. |
| `comment.add`, `comment.list`, `comment.getThread`, `comment.respond`, `comment.delete`, `comment.resolveThread`, `primitive.addReference`, `primitive.addCli`, `primitive.addPatch`, `primitive.addAgentAction` | Propagate | `workspaceId` | Existing note-owned comments and primitives. |
| `agent.list`, `agent.getCreationPreferences`, `agent.create`, `agent.delegate`, `agent.sendToTask`, `agent.sendMessage`, `agent.sendQueuedMessageNow`, `agent.sendQueuedMessagesNow`, `agent.dismissQuestions`, `agent.resolveProposal`, `agent.markSeen`, `agent.editAndRegenerate`, `agent.setModel`, `agent.retry`, `agent.wakeOrCreate`, `agent.summary`, `agent.reportToParent`, `agent.getSubscriptions`, `agent.cancelSubscriptions`, `agent.diagnostics`, `sandbox.cow.merge`, `sandbox.cow.discard` | Propagate | `workspaceId` | Existing required workspace context, including service-owned agent subscriptions and CoW operations. |
| `hub.merge`, `hub.discard`, `hub.publish` | Propagate | `workspaceId` | Prepared node contract (§5.50): required workspace of the stored agent and granted repository; retain checkpoint/request identities and head-owned mutation authority. Routing never selects a different merge target or grants publication access. |
| `node.list` | Propagate | `workspaceId` | Prepared workspace-manager placement-capacity variant (§5.50); preserve its safe projection and workspace authorization. This selector has semantic meaning and must not be injected into the owner inventory variant. |
| `agent.get`, `agent.getConversation`, `agent.listUserMessages`, `agent.getMessageBlock`, `agent.getSessionStats`, `agent.getSession`, `agent.update`, `agent.appendMessage`, `agent.replaceMessages`, `agent.getQueue`, `agent.delete`, `agent.cancelDelete`, `agent.restore`, `agent.retire`, `agent.enhancePrompt`, `agent.completeOnce` | Propagate | `workspaceId` | Existing optional context; preserve direct callers that omit it. |
| `agent.subscribe`, `agent.unsubscribe` | Propagate | `workspaceId` | Legacy service variant: subscribe carries `eventTypes`; unsubscribe carries required `workspaceId`. These are not collection-channel registrations. |
| `git.status`, `git.getConfig`, `git.stage`, `git.unstage`, `git.discard`, `git.stageHunk`, `git.unstageHunk`, `git.push`, `git.fetch`, `git.createBranch`, `git.checkoutBranch`, `git.renameBranch`, `git.removeLockFile`, `git.agentCommit`, `git.checkMergeConflicts`, `git.changes`, `git.diffs`, `git.commitDetails`, `git.commits`, `git.showFile`, `git.numstat`, `git.branchDiff`, `gitRoot.list` | Propagate | `workspaceId` | Existing workspace Git operations; retain supported `gitRootId` selection and permissions. |
| `git.branchStatus` | Propagate | `workspaceId` | `gitRootId` variant requires the workspace; existing-workspace `repoPath` variant also carries it for routing, while `repoPath` retains precedence. |
| `pr.refresh`, `prMonitor.list`, `prMonitor.cancel`, `prMonitor.flush`, `hook.list`, `hook.cancel`, `hook.runNow` | Propagate | `workspaceId` | Existing workspace PR/monitor/hook operations; MCP-only scheduling helpers are not new RPCs. |
| `scriptMonitor.list`, `scriptMonitor.cancel`, `scriptMonitor.cancelRun`, `script.list`, `script.create`, `script.archive`, `script.restore`, `script.remove`, `script.start`, `script.stop`, `script.restart`, `script.status`, `script.output`, `script.run` | Propagate | `workspaceId` | Capture context for script lifetime, output, stop and restart. |
| `event.query`, `event.agentActivity`, `event.workspaceSummary` | Propagate | `workspaceId` | Existing workspace event queries. |
| `file.read`, `file.readChunk`, `file.write`, `file.list`, `file.tree`, `file.delete`, `file.mkdir`, `file.rename`, `file.exists`, `file.stat`, `file.placeAttachment`, `file.attachmentUpload.begin` | Propagate | `workspaceId` | Existing workspace file and attachment creation operations. |
| `file.getAttachmentInfo` | Propagate | `workspaceId` | Required with `idempotencyKey`; also carry alongside `attachmentId` for workspace calls without changing that selector's lookup. |
| `terminal.create`, `terminal.list`, `terminal.readOutput` | Propagate | `workspaceId` | Existing workspace terminal operations. |
| `search.inFiles`, `search.fileNames`, `search.codebase` | Propagate | `workspaceId` | Existing scoped searches; preserve it for progress and cancellation. |
| `search.notes`, `search.messages`, `search.events`, `events.subscribe` | Propagate | `workspaceId` | Only the variant already filtered to one workspace; never inject a filter into a global query. `search.notes` scoping requires its indexed contract (§5.15); legacy daemons ignore that filter. |
| `rules.list`, `rules.get`, `mcp.servers.list` | Propagate | `workspaceId` | Workspace reads, preserving current rule/configuration scope. Global settings flows stay direct-only. |
| `mcp.servers.toggle` | Propagate | `workspaceId` | Workspace override variant only. |
| `repoConfig.get`, `repoConfig.save`, `repoConfig.has`, `repoConfig.ensureDir`, `skill.list` | Propagate | `workspaceId` | Existing repository configuration and skill operations. |
| `voice.transcribe`, `voice.getWorkspaceVocabulary` | Propagate | `workspaceId` | Preserve optional transcription vocabulary context and required vocabulary-read context. |
| `host.exec`, `host.execStream` | Propagate | `workspaceId` | Workspace execution variant; preserve existing execution scope and stream ownership. |
| `crossWorkspace.readNote`, `crossWorkspace.listNotes` | Propagate | `targetWorkspaceId` | Target reads; destination can differ from the originating workspace. |
| `browser.exec`, `browser.listTabs`, `browser.upsertTab` | Propagate | `workspaceId` | Workspace client-to-daemon calls; preserve optional exec context and host-only upsert. Reverse routing is not implemented here. |
| `presence.snapshot`, `note.presence.update`, `drafts.get`, `drafts.set`, `drafts.clear` | Propagate | `workspaceId` | Workspace presence/caret/draft operations; connection and lease ownership still apply. |
| `note.subscribe`, `task.subscribe`, `comment.subscribe`, `note.presence.subscribe` | Propagate | `workspaceId` | Snapshot/delta workspace channels; retain resource selectors, projections and replacement groups. |
| `desktop.getState`, `desktop.setPermission`, `desktop.respondPermission`, `desktop.revoke` | Propagate | `workspaceId` | Prepared desktop control (§5.51); required originating workspace, authenticated primary/candidate principal and request/session ownership survive forwarding. Never inject a different focused workspace or synthesize caller authority. |
| `agent.workers.list`, `agent.workers.subscribe` | Propagate | `workspaceId` | Prepared worker observations (§5.5b); retain agent selector, scoped authority and evidence age. Cleanup uses `events.unsubscribe`. |
| `agent.subscribe` | Propagate | `workspaceId` | Collection-channel variant only when `eventTypes` is absent; canonical cleanup is `events.unsubscribe`. |
| `accept-changes.getStatus`, `accept-changes.prepare`, `accept-changes.execute`, `accept-changes.addRemote`, `accept-changes.mergePR`, `file-tracking.getChanges`, `file-tracking.getAgentLocks`, `file-tracking.loadCommits`, `file-tracking.stage`, `file-tracking.unstage` | Propagate | `workspaceId` | Existing workspace change-tracking operations. |

### Excluded methods and variants

| Methods | Disposition | Routing field | Variant and preserved behavior |
| --- | --- | --- | --- |
| `system.status`, `system.shutdown`, `system.requestUpdate`, `system.importLegacy`, `system.gitCredential`, `debug.sampleStacks` | Exclude | — | Daemon administration, diagnostics or local credential-helper control. |
| `node.register`, `node.drain`, `node.remove`, `lease.list`, `lease.release` | Exclude | — | Prepared owner-only node/lease administration (§5.50), bound to the contacted head installation; no workspace routing context or authority is inferred from node/lease IDs. |
| `node.list` | Exclude | — | Prepared owner inventory variant without `workspaceId` (§5.50); host-wide result, distinct from the workspace-manager safe capacity projection. |
| `host.members.list`, `host.members.remove`, `host.invite.create`, `host.invite.list`, `host.invite.revoke`, `host.invite.searchAccounts`, `pairing.getInfo`, `pairing.getSelfInfo`, `server.pairingInfo`, `server.rotateToken` | Exclude | — | Host membership, pairing and host invitation bootstrap. |
| `identity.authStatus`, `identity.connect`, `identity.cancelAuth`, `identity.revoke`, `identity.getUser`, `identity.select`, `principal.me`, `principal.list`, `principal.revokeSelf`, `invite.inspect`, `invite.challenge`, `invite.accept`, `invite.prove`, `github.identityProof.create`, `github.identityProof.delete`, `sourceControl.identityProof.create`, `sourceControl.identityProof.delete` | Exclude | — | Connection identity, guest join and credential-holder proof flows require a separate destination/identity contract. |
| `github.connect`, `github.cancelAuth`, `github.revoke`, `sourceControl.connect`, `sourceControl.cancelAuth`, `sourceControl.revoke`, `providers.setup.status`, `providers.setup.start`, `providers.setup.login`, `providers.setup.cancel`, `host.providerTestPrompt`, `mcp.oauth.list`, `mcp.oauth.get`, `mcp.oauth.set`, `mcp.oauth.delete`, `mcp.testConnection` | Exclude | — | Credential mutation, setup or direct host testing. |
| `settings.update`, `settings.reset`, `rules.update`, `mcp.servers.create`, `mcp.servers.update`, `mcp.servers.delete`, `mcp.servers.restart` | Exclude | — | Daemon-wide configuration writes, including user rule overrides; existing workspace-shaped fields do not change that scope. |
| `specialist.create`, `specialist.edit`, `specialist.delete` | Exclude | — | User-library writes (`scope: "user"`, or create's default user scope); edit/delete still require scope. |
| `mcp.servers.toggle` | Exclude | — | Global variant without `workspaceId`; never inject a workspace override. |
| `rules.list`, `rules.get`, `mcp.servers.list` | Exclude | — | Global settings variants, including the frontend rules `"global"` placeholder. |
| `unsloth.status`, `unsloth.stop` | Exclude | — | Shared daemon process management. |
| `workspace.list`, `workspace.subscribe`, `workspace.unsubscribe`, `agent.listActive`, `agent.listInterrupted`, `agent.memoryUsage`, `agent.resolveInterrupted`, `stats.getUsage`, `stats.getRateHistory`, `crossWorkspace.listSiblings` | Exclude | — | Global discovery, combined views or cross-backend batch operations require aggregation policy. |
| `search.notes`, `search.messages`, `search.events`, `events.subscribe`, `events.unsubscribe`, `search.cancel` | Exclude | — | Global/unscoped search or event registration and its teardown/cancellation. |
| `workspace.create`, `workspace.import.begin`, `workspace.import.chunk`, `workspace.import.commit`, `workspace.import.abort`, `workspace.findRepositories`, `workspace.initializeRepository`, `repo.list`, `repo.remove`, `repo.warmCache`, `git.clone`, `host.listDirectory`, `host.createDirectory`, `host.directoryStatus` | Exclude | — | Creation/provisioning/import needs a destination decision; no import routing or end-to-end transfer orchestration. |
| `git.getBranches`, `git.pull`, `git.getRemoteUrl`, `git.branchStatus` | Exclude | — | Pre-workspace path operations without an originating workspace require destination selection. |
| `client.hello` | Exclude | — | Aggregator connection handshake and capabilities are future work. Binary `/tunnel` forwarding is outside this RPC inventory. |
| `browser.removeTab`, `browser.navigateTab`, `browser.closeTab` | Exclude | — | Existing tab-ID-only controls need connection/registry routing; no new workspace parameter is approved for these methods. |
| `browser.syncTabs`, `presence.update` | Exclude | — | Whole-connection reports: retain `tabs[].workspaceId` and `focus[].workspaceId` plus typing semantics. Multiple workspaces, empty reports and connection cleanup require a future connection relay contract, not one injected ID. |
| `desktop.control` | Exclude | — | Prepared daemon-only desktop reverse RPC (§5.51); identity-only prepare binds eligible candidate connections; activation/actions bind the selected primary connection/session, never generic workspace forwarding. Agent startControl/endControl and actions are MCP-only. |
| `host.findApp`, `host.listInstalledEditors`, `host.openInEditor`, `host.openExternal`, `host.pickApplication`, `providers.setup.openLogin`, `browser.exec` | Exclude | — | Native desktop/reverse traffic, including dual-role reverse `browser.exec` and `host.openInEditor`. Existing local/remote execution behavior remains unchanged. |
| `agent.unsubscribe` | Exclude | — | Bare `{ subscriptionId }` collection alias remains direct-compatible. Do not add `workspaceId` to it: that selects the legacy service handler. |

The Add rows cover workspace-originated calls only. Their direct global settings,
onboarding and pre-workspace variants are not made aggregatable by this contract.
Likewise an optional existing context does not make an unscoped call routable.

## Resource lifetimes and subscription cleanup

Capture `{ connection, workspaceId, resourceId }` when creating or subscribing to
a resource, and retain it until cleanup finishes. Subscription IDs and replacement
groups are connection-local; routing metadata alone does not preserve that
ownership across a reconnect. Re-establish subscriptions with the original
workspace and options, associate the returned new IDs with that connection, and
keep old cleanup from removing a replacement connection's registration. Terminal,
exec, upload, permission and search follow-ups also keep their original workspace;
none derives a backend from an opaque handle.

The current connection dispatcher has two separate agent subscription variants:

| Request variant | Current dispatch | Prepared cleanup |
| --- | --- | --- |
| `agent.subscribe` with `workspaceId`, without `eventTypes` | Snapshot/delta collection channel | `events.unsubscribe { subscriptionId, workspaceId }` |
| `agent.subscribe` with `workspaceId` and `eventTypes` | Legacy service subscription | `agent.unsubscribe { subscriptionId, workspaceId }` |
| `agent.unsubscribe` without `workspaceId` | Connection-local collection removal | Preserve for old direct callers only. |

`events.unsubscribe` and the snapshot channel unsubscriptions both call the same
connection registry removal and return `{ success }`, including `false` for an
unknown ID. This also releases a note-presence lease. `workspaceId` on canonical
teardown is optional for direct compatibility and required for a future forwarded
workspace registration. It is not a new subscription lookup scope. Preserve the
legacy service unsubscribe and do not rewrite it to connection teardown.

The exact prepared snapshot channel pairs are `note.subscribe` / `note.unsubscribe`,
`task.subscribe` / `task.unsubscribe`, `comment.subscribe` / `comment.unsubscribe`,
`chat.subscribe` / `chat.unsubscribe`, `note.presence.subscribe` /
`note.presence.unsubscribe`, and collection `agent.subscribe` /
`events.unsubscribe`. Global `workspace.subscribe` / `workspace.unsubscribe` stays
excluded. The underlying wire aliases remain accepted as described above.

## Source workspace export lifecycle

The source workspace identifies the export daemon throughout the operation:

| Method | Prepared params | Behavior retained |
| --- | --- | --- |
| `workspace.export.start` | `workspaceId` (required) | Creates the export on the source daemon. |
| `workspace.export.read` | `exportId`, `seq`, `workspaceId?` | Read/retry chunks from that source export. |
| `workspace.export.finalize` | `exportId`, `archiveSource?`, `finalStatusMessage?`, `workspaceId?` | Existing optional source archive/status effects; no destination selection. |
| `workspace.export.abort` | `exportId`, `workspaceId?` | Existing export-session cleanup on success, failure or cancellation. |

Subscribe before starting the export, using `events.subscribe` with the source
`workspaceId` and `eventTypes: ["workspace:transfer:*"]`; keep its subscription ID
and source context. The existing `workspace:transfer:progress`,
`workspace:transfer:ready` and `workspace:transfer:failed` events remain
source-scoped and correlated by `exportId`. Keep that same source
through retries, finalize, abort, and late subscription cleanup, even after focus
changes or source archival. Do not replace it with an imported/destination
workspace ID, and do not confuse the export session ID with the routing key.
`workspace.transfer.plan` already takes the source workspace and is unchanged.
Import destination routing and transfer orchestration remain outside this contract.

## Verification boundary

The inventory is checked against `catalog.rs`, `router.rs` and
`subscriptions.rs` in intentd, including parameter-discriminated agent aliases,
and the relevant host/browser/presence dispatchers. Catalog tests check exact name
coverage; they do not prove parameter forwarding or authorization behavior.
Component verification must cover omitted and supplied optional fields, strict
client schemas, real WSS subscription teardown equivalence, global/project
variants, source export progress and late cleanup, cache separation and reconnects.
Fixtures must exercise integration calls without real external mutations. None
of these checks establishes end-to-end federation without an aggregator.

Run `make check-protocol-catalog`,
`node --test scripts/check-protocol-catalog.test.mjs` (including inventory and
scope-variant checks), and `make consumer-checks` for this documentation contract.
