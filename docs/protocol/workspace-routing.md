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
| `events.unsubscribe`, `note.unsubscribe`, `task.unsubscribe`, `comment.unsubscribe`, `chat.unsubscribe`, `note.presence.unsubscribe`, `presence.focus.unsubscribe` | Add | `workspaceId` | Workspace-owned connection subscriptions; retain the workspace alongside `subscriptionId`. Use `events.unsubscribe` for agent-collection teardown. |
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
| `workspace.get`, `workspace.update`, `workspace.delete`, `workspace.cancelDelete`, `workspace.archive`, `workspace.unarchive`, `workspace.retire`, `workspace.dismissAttention`, `workspace.markSeen`, `workspace.diskUsage`, `workspace.localChanges`, `workspace.getTokenUsage`, `workspace.getAutoCommit`, `workspace.setAutoCommit`, `workspace.getBrowserClient`, `workspace.setBrowserClient`, `workspace.getSetupScript`, `workspace.saveSetupScript`, `workspace.detectProjectType`, `workspace.generateSetupScript`, `workspace.getContext`, `workspace.updateContext`, `workspace.getUiContext`, `workspace.updateUiContext`, `workspace.restore`, `workspace.cleanup` | Propagate | `workspaceId` | Existing workspace lifecycle, configuration and reads. |
| `workspace.duplicate` | Propagate | `workspaceId` | Existing source-workspace duplication on the contacted daemon; no cross-backend placement. |
| `workspace.export.start`, `workspace.transfer.plan` | Propagate | `workspaceId` | Required source workspace. Transfer plan remains the existing source-only helper; destination routing is excluded. |
| `workspace.members.list`, `workspace.members.add`, `workspace.members.setRole`, `workspace.members.remove`, `workspace.members.leave`, `workspace.invite.create`, `workspace.invite.list`, `workspace.invite.revoke` | Propagate | `workspaceId` | Existing workspace membership and invite administration; retain authority checks and connection restrictions. Separate identity/join bootstrap is excluded. |
| `note.list`, `note.get`, `note.create`, `note.update`, `note.add`, `note.edit`, `note.editLines`, `note.setContent`, `note.updateMetadata`, `note.delete`, `note.listTasks`, `note.readAsset`, `note.readAssetChunk`, `note.saveAsset`, `note.listVersions`, `note.getVersion`, `note.restoreVersion`, `note.lineAttribution.load`, `note.lineAttribution.computeNow` | Propagate | `workspaceId` | Existing note, version and asset operations. |
| `task.updateStatus`, `task.updateNoteStatus`, `task.update`, `task.getMyTask`, `task.markAsTask`, `task.setRelations`, `task.convertBlocks`, `task.createPrerequisite`, `task.assignAgent`, `task.removeAgentFromAllTasks`, `task.list`, `task.get`, `task.linkAgent`, `task.unlinkAgent`, `task.listAgentLinks` | Propagate | `workspaceId` | Existing workspace task operations. |
| `comment.add`, `comment.list`, `comment.getThread`, `comment.respond`, `comment.delete`, `comment.resolveThread`, `primitive.addReference`, `primitive.addCli`, `primitive.addPatch`, `primitive.addAgentAction` | Propagate | `workspaceId` | Existing note-owned comments and primitives. |
| `discussion.conversations`, `discussion.recipients`, `discussion.list`, `discussion.send`, `discussion.rename`, `discussion.delete`, `discussion.react`, `discussion.stopAgent`, `discussion.retryAgent` | Propagate | `workspaceId` | Keep the selected backend, authenticated principal, and conversation ID through discovery, reads, sends, retries, management, and live delivery. Non-default targets require `discussionConversations: 1`; workspace-wide creation and rename/delete additionally require exact `discussionManagement: 1`, preserving creation intent and role checks without redirecting to default. Legacy private histories remain participant-restricted and read-only. Replies/reactions require `discussionMessageActions: 1`; expanded reactions require `discussionReactions: 1`; explicit agent recipients require `discussionAgentMessaging: 1` and an explicit grant in this conversation (named workspace-wide conversations additionally require `discussionManagement: 1`). Stop/Retry additionally requires `discussionAgentActivity: 1`; preserve message ID, agent ID, and expected attempt across reconnect. |
| `agent.list`, `agent.getCreationPreferences`, `agent.create`, `agent.delegate`, `agent.sendToTask`, `agent.sendMessage`, `agent.sendQueuedMessageNow`, `agent.sendQueuedMessagesNow`, `agent.dismissQuestions`, `agent.resolveProposal`, `agent.markSeen`, `agent.editAndRegenerate`, `agent.setModel`, `agent.retry`, `agent.wakeOrCreate`, `agent.summary`, `agent.reportToParent`, `agent.getSubscriptions`, `agent.cancelSubscriptions`, `agent.diagnostics`, `sandbox.cow.merge`, `sandbox.cow.discard` | Propagate | `workspaceId` | Existing required workspace context, including service-owned agent subscriptions and CoW operations. |
| `hub.merge`, `hub.discard`, `hub.publish` | Propagate | `workspaceId` | Prepared node contract (§5.50): required workspace of the stored agent and granted repository; retain checkpoint/request identities and head-owned mutation authority. Routing never selects a different merge target or grants publication access. |
| `node.list` | Propagate | `workspaceId` | Prepared workspace-manager placement-capacity variant (§5.50); preserve its safe projection and workspace authorization. This selector has semantic meaning and must not be injected into the owner inventory variant. |
| `agent.get`, `agent.getConversation`, `agent.listUserMessages`, `agent.getMessageBlock`, `agent.getSessionStats`, `agent.getSession`, `agent.update`, `agent.appendMessage`, `agent.replaceMessages`, `agent.getQueue`, `agent.delete`, `agent.cancelDelete`, `agent.restore`, `agent.retire`, `agent.enhancePrompt`, `agent.completeOnce` | Propagate | `workspaceId` | Existing optional context; preserve direct callers that omit it. |
| `agent.subscribe`, `agent.unsubscribe` | Propagate | `workspaceId` | Legacy service variant: subscribe carries `eventTypes`; unsubscribe carries required `workspaceId`. These are not collection-channel registrations. |
| `git.status`, `git.getConfig`, `git.stage`, `git.unstage`, `git.discard`, `git.stageHunk`, `git.unstageHunk`, `git.push`, `git.fetch`, `git.createBranch`, `git.checkoutBranch`, `git.renameBranch`, `git.removeLockFile`, `git.agentCommit`, `git.checkMergeConflicts`, `git.changes`, `git.diffs`, `git.commitDetails`, `git.commits`, `git.showFile`, `git.showFileChunk`, `git.numstat`, `git.branchDiff`, `gitRoot.list` | Propagate | `workspaceId` | Existing workspace Git operations; retain supported `gitRootId` selection and permissions. |
| `git.branchStatus` | Propagate | `workspaceId` | `gitRootId` variant requires the workspace; existing-workspace `repoPath` variant also carries it for routing, while `repoPath` retains precedence. |
| `pr.refresh`, `prMonitor.list`, `prMonitor.cancel`, `prMonitor.flush`, `hook.list`, `hook.cancel`, `hook.runNow` | Propagate | `workspaceId` | Existing workspace PR/monitor/hook operations; MCP-only scheduling helpers are not new RPCs. |
| `scriptMonitor.list`, `scriptMonitor.get`, `scriptMonitor.cancel`, `scriptMonitor.cancelRun`, `script.list`, `script.get`, `script.create`, `script.archive`, `script.restore`, `script.remove`, `script.start`, `script.stop`, `script.restart`, `script.status`, `script.output`, `script.run` | Propagate | `workspaceId` | Capture context for script lifetime, output, stop and restart. |
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
| `note.subscribe`, `task.subscribe`, `comment.subscribe`, `note.presence.subscribe`, `presence.focus.subscribe` | Propagate | `workspaceId` | Snapshot/delta workspace channels; retain resource selectors, projections and replacement groups. |
| `secret.provide`, `secret.dismiss`, `secret.list`, `secret.forget` | Propagate | `workspaceId` | Secret requests (§5.56); required workspace, the target agent's send authority and request ownership survive forwarding. `secret.provide` params carry a secret value: forwarders must never log, cache or echo them. |
| `desktop.getState`, `desktop.setPermission`, `desktop.respondPermission`, `desktop.revoke` | Propagate | `workspaceId` | Desktop control (§5.51); required originating workspace, authenticated primary/candidate principal and request/session ownership survive forwarding. Never inject a different focused workspace or synthesize caller authority. |
| `agent.workers.list`, `agent.workers.subscribe`, `agent.workers.stop` | Propagate | `workspaceId` | Worker observations and stop (§5.5b); retain agent and task selectors, scoped read/control authority and observation times. Cleanup uses `events.unsubscribe`. |
| `agent.subscribe` | Propagate | `workspaceId` | Collection-channel variant only when `eventTypes` is absent; canonical cleanup is `events.unsubscribe`. |
| `accept-changes.getStatus`, `accept-changes.prepare`, `accept-changes.execute`, `accept-changes.addRemote`, `accept-changes.mergePR`, `file-tracking.getChanges`, `file-tracking.getAgentLocks`, `file-tracking.loadCommits`, `file-tracking.stage`, `file-tracking.unstage` | Propagate | `workspaceId` | Existing workspace change-tracking operations. |

### Excluded methods and variants

| Methods | Disposition | Routing field | Variant and preserved behavior |
| --- | --- | --- | --- |
| `sourceControl.read.captureScoped`, `sourceControl.read.detailScoped`, `sourceControl.read.releaseScoped`, `sourceControl.read.list`, `sourceControl.read.discussions` | Exclude | — | Protocol 15.1 scoped reads retain their original physical connection and explicit nested `context`: authorized workspace or durable Host Owner. `context.workspaceId` is semantic authority, not a top-level routing field. Do not inject or borrow a workspace, change context, or adopt the lifetime after reconnect. |
| `sourceControl.read.resolveKnownRepository` | Exclude | — | Protocol 15.1 Host-only local identity observation on the original read lifetime and registered absolute repository path. No workspace borrowing, daemon selection from the path, or provider permission follows. |
| `sourceControl.gitlab.childGit.get`, `sourceControl.gitlab.childGit.set` | Exclude | — | Protocol 15.1 owner-only policy on the original daemon connection and complete account/full-instance binding. No workspace routing field or credential authority is inferred from the public binding. |
| `system.startupStatus`, `system.status`, `system.shutdown`, `system.requestUpdate`, `system.gitCredential`, `debug.sampleStacks` | Exclude | — | Daemon administration, diagnostics or local credential-helper control. |
| `host.prepareProviderAdapters` | Exclude | — | Prepared owner-only onboarding optimization on the captured daemon connection before workspace creation; accepts only provider IDs, never workspace routing or arbitrary execution inputs. |
| `sourceControl.checkout.capture`, `sourceControl.checkout.projects`, `sourceControl.checkout.project`, `sourceControl.checkout.branches`, `sourceControl.checkout.repoConfig`, `sourceControl.checkout.warm`, `sourceControl.checkout.release` | Exclude | — | Prepared pre-workspace GitLab checkout on an explicitly selected destination. Preserve the original physical connection, host Owner/Member authority and checkout reference; no fabricated workspace ID, focused-host fallback or cross-connection cursor/cleanup adoption. A forge instance URL is not a daemon routing address. |
| `node.register`, `node.drain`, `node.remove`, `lease.list`, `lease.release` | Exclude | — | Prepared owner-only node/lease administration (§5.50), bound to the contacted head installation; no workspace routing context or authority is inferred from node/lease IDs. |
| `executor.mint`, `executor.list`, `executor.revoke`, `remoteMachines.backendInfo`, `remoteMachines.add`, `remoteMachines.list`, `remoteMachines.remove`, `remoteMachines.refresh`, `remoteLinkTraffic.start`, `remoteLinkTraffic.stop`, `remoteLinkTraffic.snapshot` | Exclude | — | Owner-only daemon-to-daemon remote machine administration (§5.50), bound to the contacted daemon; no workspace routing context or authority is inferred from machine, backend or credential IDs. |
| `cloudMachines.configure`, `cloudMachines.list`, `cloudMachines.remove`, `cloudMachines.pause`, `cloudMachines.kill` | Exclude | — | Daemon-global E2B cloud machine administration (§5.50), bound to the contacted backend; no workspace routing context or authority is inferred from machine or sandbox IDs, even though a cloud machine row names the workspace it was started for. |
| `node.list` | Exclude | — | Prepared owner inventory variant without `workspaceId` (§5.50); host-wide result, distinct from the workspace-manager safe capacity projection. |
| `host.members.list`, `host.members.remove`, `host.invite.create`, `host.invite.list`, `host.invite.revoke`, `host.invite.searchAccounts`, `pairing.getInfo`, `pairing.getSelfInfo`, `server.pairingInfo`, `server.rotateToken` | Exclude | — | Host membership, pairing and host invitation bootstrap. |
| `identity.authStatus`, `identity.connect`, `identity.cancelAuth`, `identity.revoke`, `identity.getUser`, `identity.select`, `principal.me`, `principal.list`, `principal.revokeSelf`, `invite.inspect`, `invite.challenge`, `invite.accept`, `invite.prove`, `github.identityProof.create`, `github.identityProof.delete`, `sourceControl.identityProof.create`, `sourceControl.identityProof.delete` | Exclude | — | Connection identity, guest join and credential-holder proof flows require a separate destination/identity contract. |
| `github.connect`, `github.cancelAuth`, `github.revoke`, `sourceControl.connect`, `sourceControl.cancelAuth`, `sourceControl.revoke`, `providers.setup.status`, `providers.setup.start`, `providers.setup.login`, `providers.setup.cancel`, `host.providerTestPrompt`, `mcp.oauth.list`, `mcp.oauth.get`, `mcp.oauth.set`, `mcp.oauth.delete`, `mcp.testConnection` | Exclude | — | Credential mutation, setup or direct host testing. |
| `settings.update`, `settings.reset`, `rules.update`, `mcp.servers.create`, `mcp.servers.update`, `mcp.servers.delete`, `mcp.servers.restart`, `plugin.install`, `plugin.update`, `plugin.uninstall`, `plugin.toggle` | Exclude | — | Daemon-wide configuration writes, including user rule overrides; existing workspace-shaped fields do not change that scope. |
| `providers.profiles.list`, `providers.profiles.create`, `providers.profiles.update`, `providers.profiles.delete`, `providers.profiles.reorder`, `providers.profiles.updateDefault` | Exclude | — | Prepared administrator-only, daemon-global provider profile management (§5.54); profiles are host-scoped and never take a workspace override. |
| `specialist.create`, `specialist.edit`, `specialist.delete` | Exclude | — | User-library writes (`scope: "user"`, or create's default user scope); edit/delete still require scope. |
| `mcp.servers.toggle` | Exclude | — | Global variant without `workspaceId`; never inject a workspace override. |
| `rules.list`, `rules.get`, `mcp.servers.list` | Exclude | — | Global settings variants, including the frontend rules `"global"` placeholder. |
| `plugin.list` | Exclude | — | Daemon-wide plugin inventory; plugins have no workspace scope. |
| `unsloth.status`, `unsloth.stop` | Exclude | — | Shared daemon process management. |
| `workspace.list`, `workspace.findByPullRequest`, `workspace.subscribe`, `workspace.unsubscribe`, `agent.listActive`, `agent.listInterrupted`, `agent.memoryUsage`, `agent.resolveInterrupted`, `stats.getUsage`, `stats.getRateHistory`, `crossWorkspace.listSiblings` | Exclude | — | Global discovery, combined views or cross-backend batch operations require aggregation policy. |
| `search.notes`, `search.messages`, `search.events`, `events.subscribe`, `events.unsubscribe`, `search.cancel` | Exclude | — | Global/unscoped search or event registration and its teardown/cancellation. |
| `events.fence` | Exclude | — | Prepared recovery control bound to the original physical connection and the entire set of already admitted generic leases, which may span scoped and global subscriptions. Never inject a focused workspace, forward foreign subscription IDs, split the set across connections or rebind it after replacement. Preserve every lease's scope and authority; reject the whole fence if any lease is foreign, retired or no longer authorized, as specified in [generic stream recovery](event-stream-recovery.md). |
| `workspace.create`, `workspace.import.begin`, `workspace.import.chunk`, `workspace.import.commit`, `workspace.import.abort`, `workspace.findRepositories`, `workspace.initializeRepository`, `repo.list`, `repo.remove`, `repo.warmCache`, `git.clone`, `host.listDirectory`, `host.createDirectory`, `host.directoryStatus` | Exclude | — | Creation/provisioning/import needs a destination decision; no import routing or end-to-end transfer orchestration. |
| `git.getBranches`, `git.pull`, `git.getRemoteUrl`, `git.branchStatus` | Exclude | — | Pre-workspace path operations without an originating workspace require destination selection. |
| `client.hello` | Exclude | — | Aggregator connection handshake and capabilities are future work. Binary `/tunnel` forwarding is outside this RPC inventory. |
| `browser.removeTab`, `browser.navigateTab`, `browser.closeTab` | Exclude | — | Existing tab-ID-only controls need connection/registry routing; no new workspace parameter is approved for these methods. |
| `browser.syncTabs`, `presence.update` | Exclude | — | Whole-connection reports: retain `tabs[].workspaceId` and `focus[].workspaceId` plus typing semantics. Multiple workspaces, empty reports and connection cleanup require a future connection relay contract, not one injected ID. |
| `desktop.control` | Exclude | — | Daemon-only desktop reverse RPC (§5.51); identity-only prepare binds eligible candidate connections; activation/actions bind the selected primary connection/session, never generic workspace forwarding. Agent startControl/endControl and actions are MCP-only. |
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

## Remote agents on the executor link

The daemon-to-daemon [executor link](./node-link.md#workspace-api-on-the-machine)
runs a remote agent's `workspace_api` code on its machine and routes each
`host({ method, args })` frame by method. This is agent-binding routing over a
private link, not the aggregator routing above, and adds nothing to the public
method inventory:

| Frames | Where they run |
| --- | --- |
| `file.read`, `file.write`, `file.list`, `file.delete`, `file.mkdir`, `file.rename`, `git.commit`, `host.exec`, `help.*` | On the machine, against the agent's own checkout and host |
| `file.getAttachment` | On the machine: the bytes come from the backend with the internal `file.attachmentData` frame (below), and the copy lands in the agent's own checkout |
| `workspace.info` | On the machine: `{ id, path }`, where `path` is the agent's own checkout on the machine |
| `note.*`, `task.*`, `agent.*`, `pr.*` (and its `mr.*` alias), `comment.*`, `event.*`, `script.*`, `primitive.*`, `discussion.*`, `crossWorkspace.*`, `hook.*`, `browser.*`, `desktop.*`, `mcp.*` | Forwarded to the backend as one `workspace.call` link request with params `{ method, args }` |
| `workspace.details`, `workspace.setTitle`, `workspace.setAgentName`, `workspace.setStatusMessage`, `workspace.setStatusImage`, `workspace.proposeSibling`, `workspace.applyProposal`, `workspace.archive`, `workspace.unarchive`, `workspace.context`, `workspace.referenceDocs`, `workspace.timeline`, `workspace.emitNotification`, `git.listRoots`, `terminal.list`, `terminal.readOutput`, `app.question.ask` | Forwarded the same way, method by method |
| `app.*` other than `app.question.ask` | Refused: `remote-agent-unsupported: ws.app.* is for the Assistant workspace, whose agents run on the backend.` |
| `git.registerRoot`, `git.unregisterRoot`, and a `gitRootId` on `git.commit` | Refused: `remote-agent-unsupported: secondary git roots are registered on the backend; ws.git.listRoots lists this agent's submodules at their paths on its machine, so work in them by path (for example git -C <path> through ws.host.exec), not by gitRootId.` |
| `secret.request`, `secret.list`, `secret.forget` | Forwarded the same way on nodeProtocol 14 or later; the values stay on the machine ([secrets on the machine](./node-link.md#secrets-on-the-machine-nodeprotocol-14)). On an older link: refused with `remote-agent-unsupported:` |
| `host.exec` with `secretEnv` | On the machine, from the agent's own secrets held there (nodeProtocol 14 or later); on an older link it fails as when secret requests are off |
| Everything else | Refused, never run on another host |

A refused frame fails with a message starting `remote-agent-unsupported:` that names
the method and lists what remote agents can use. The backend serves a forwarded
frame only on the machine's current binding, only for an agent recorded on that
binding's lease, and only when its own copy of this table forwards the method; the
frame then runs through the same host dispatch as a local agent's bridge, as that
agent and in its workspace. The forwarded workspace setters therefore act as the
leased agent: `workspace.setTitle`, `workspace.setStatusMessage` and
`workspace.setStatusImage` change the agent's workspace with the same checks and
events as a local agent's call, and `workspace.setAgentName` renames only the
calling remote agent, never another session. A forwarded `workspace.proposeSibling`
runs the same checks as a local agent's call (foreground top-level agents only, so a
remote sub-agent or background agent is refused) and builds the proposal card on the
backend, from the backend's workspace: repository identity, the default `baseRef`
and the `baseRef` check use the backend's repository, not the machine's checkout, so
a ref that exists only on the machine is warned about and Apply fails. The backend
does not register the card when the forwarded call returns: the card goes back to
the machine in the tool result, and the machine registers it with the
`turn.attachments` frame (below) when the `workspace_api` call ends, so it becomes a
pending proposal on that agent's message, attributed to it, that the user can Apply.
A forwarded `workspace.applyProposal` runs the same checks as a local agent's call
(the explicit `userRequested: true` attestation, and only the caller's own pending
proposals). `workspace.archive` and `workspace.unarchive` act on the agent's
workspace on the backend, with the same checks and events as a local agent's call;
they do not touch the agent's checkout on the machine. `git.listRoots` lists only
the secondary git roots the agent's machine has: the registered roots that are
submodules carried in the agent's pins ([node-link.md § Submodule pins](node-link.md#submodule-pins)). The backend answers each such
row with its `path` relative to the checkout (`"a/b"`) and without `branch`; the
machine makes `path` absolute in the agent's checkout and reads `branch` there, so the
agent gets rows valid on its machine; a row whose repository is not checked out on
the machine is left out there. Every other root (a repository outside the checkout, a
plain repository inside it, a submodule not populated on the backend) is on the
backend only and is left out. An older machine passes the relative rows through
without `branch`; their paths resolve against the checkout root, the agent's starting
working directory. The other
forwarded reads return backend data: `terminal.list` and `terminal.readOutput` read the workspace's
terminals on the backend (read-only; there is no terminal write frame), and
`crossWorkspace.*` and `discussion.*` read what a local agent reads. `primitive.*`
writes to the backend's notes as a local agent's call does. `workspace.context`,
`workspace.referenceDocs`, `workspace.timeline` and `workspace.emitNotification`
are forwarded too, and answer with the backend's own "not yet available" error, as
they do for a local agent. A
forwarded frame shares the link's 8 MiB RPC body cap, so a
`workspace.setStatusImage` image too large for it fails on the link with
`node-link-frame-too-large`. The agent's `agentFeatures` snapshot and the sub-agent
gates apply as they do locally. A forwarded `agent.create`, `agent.delegate` or
`agent.wakeOrCreate` without a `placement` creates the sub-agent on the agent's own
machine; see [sub-agents of remote
agents](./methods/nodes.md#sub-agents-of-remote-agents). Before an agent-initiated
`git.commit`, the machine forwards the internal frame `git.commitPolicy` (refused
from agent code) and the backend answers `{ "autoCommit": boolean }` with the
workspace's effective auto-commit policy.

The machine also forwards the internal frame `agent.placementHelp` (refused from
agent code; args `null`) when it starts the agent's `workspace_api` server and for
`help.*` with `namespace: "agent"`. The backend answers `{ "help": string | null }`:
the same machine-placement text a local agent sees in the `workspace_api`
description and in `ws.help("agent")`, or `null` when the backend exposes no
machine. The machine adds the text to the remote agent's `workspace_api`
description and `ws.help("agent")`, so a remote agent can name another machine in
`placement`. An older backend refuses the frame, and the machine leaves the text out.

A forwarded `ws.mcp.listServers`, `ws.mcp.listTools` or `ws.mcp.callTool` runs
in the backend's MCP hub with a local agent's gates (`agentFeatures.mcpTools`,
`mcp.enableUserServers`, the server's own and its workspace's disabled state,
host membership) and the hub's 55 s call cap; it lists and calls the backend's
servers, never servers on the machine. The machine also forwards the internal
frames `mcp.proxy.listTools` and `mcp.proxy.callTool` (refused from agent code)
for the user MCP servers in the provider's own session, on a link that
negotiated nodeProtocol 11 ([user MCP
servers](./node-link.md#user-mcp-servers-nodeprotocol-11)).

On a link that negotiated nodeProtocol 10 the machine replaces `setupStatus` in
the forwarded `workspace.details` reply with the setup status of the agent's own
checkout ([prepared checkout](./node-link.md#setup-status-and-output)):
`{ state: "completed" | "failed" | "skipped", exitCode?, startedAt?, finishedAt? }`,
never `pending` or `running` (setup finishes before the agent starts) and never
`terminalId`. Every other member is the backend workspace's. Below 10 the reply is
the backend's unchanged.

Hooks, structured questions, the browser and the desktop are forwarded and run on
the backend as the remote agent:

1. **Hooks.** A forwarded `hook.schedule` makes a hook owned by the remote agent.
   `hook.cancel` is scoped to that owner, as for a local agent. The hook's code runs
   in the backend's hook runtime, and its `ws.*` calls, `ws.host.exec` included, run
   on the backend: `host.exec` sees the backend's worktree and the backend's tools
   and credentials (such as `gh`), not the agent's checkout on the machine. A
   dispatch or eviction wakes the owner with an ordinary agent message, which the
   backend queues behind the agent's current turn and delivers to the machine as the
   agent's next prompt.
2. **Structured questions.** A forwarded `app.question.ask` keeps the top-level-only
   and `agentFeatures.structuredQuestions` gates. The backend registers the question
   for the agent's current turn and drains it onto that turn's assistant message on
   the backend, with the same `trailingBlocks` delivery as a local agent's question
   ([question blocks](./07-agent-streaming.md)). The user's answers reach the agent
   as its next user message.
3. **Browser and desktop.** `browser.*` and `desktop.*` act on the user's client
   connected to the backend, as they do for a local agent (they never act on the
   machine). Desktop control asks for the same consent, keyed by the remote agent's
   id. The consent's outcome (granted, denied, expired or withdrawn) and a later
   revocation wake the agent with an agent message. Browser URLs and paths are the client's and the backend's: `http://daemon.localhost:<port>`
   reaches a port on the backend's loopback, not on the machine, and `file://`
   URLs and capture directories are paths on the client.

When a remote agent's `workspace_api` call ends, before the machine answers the
provider, it sends the result cards it collected during that call (such as a
forwarded `workspace.proposeSibling` card) to the backend in one internal
`turn.attachments` frame, also refused from agent code:

```ts
// workspace.call params: { method: "turn.attachments", args: TurnAttachmentsArgs }
interface TurnAttachmentsArgs {
  attachments: {            // at most 32 cards, in call order
    id: string;             // an attachment id the machine minted
    mimeType: string;
    uri: string;
    name: string;
    text: string;
  }[];
}
```

The backend accepts it only for an agent on the link's lease, registers the list as
one batch for that agent's current turn, as a local agent's cards are registered
when its call ends, and answers `{}`. A frame with more than 32 cards, a missing or
non-string field, or an `id` that is not an attachment id is refused with `-32602`,
and those cards are taken from the tool output instead. One batch per call keeps
each card on the tool call that made it, even when calls run in parallel or one call
makes several cards. An older backend refuses the frame; the machine ignores the
refusal, and the card is then taken from the tool output as before.

The machine forwards `script.*` only on a link that negotiated nodeProtocol 8 or
later; a protocol 7 machine, or a link to a backend that offers only 7, refuses it
on the machine with `remote-agent-unsupported:` ([mixed
versions](./node-link.md#saved-scripts-nodeprotocol-8)). A backend that negotiates 8
or later advertises [`remoteScripts:
1`](./methods/scripts.md#scripts-of-remote-agents-remotescripts-1); it keeps the
script, and the agent's runs of it happen on its machine over the [script
frames](./node-link.md#saved-scripts-nodeprotocol-8). Tool outputs too large for a
reply are written on the machine, next to the agent's worktree.

**Attachments.** A message with image or file attachments to a remote agent is
accepted as for a local agent, and its attachments reach the machine:

1. **Images.** The backend resolves image attachments as for a local agent and sends
   each supported image inline, as an ACP `image` block, in the turn's `prompt`
   frame. The whole frame shares the link's 8 MiB cap, so the backend measures the
   message before anything is written or sent: its text and images, with the
   images prepared (resized) as the turn prepares them, plus 256 KiB of room for
   what the turn adds (the agent's instructions on its first turn, notices). A
   message that does not fit is refused with `-32602`
   `attachments-too-large-for-machine:`, naming its size in bytes and the
   8388608-byte limit. The check runs for `agent.sendMessage`,
   `agent.queueMessage` and `agent.editAndRegenerate` to a remote agent (an edit
   is refused before the agent is stopped or its transcript cut), for
   `agent.create` whose agent is placed on another machine, with its
   `imageBlocks` and initial message, and for `workspace.create` with a remote
   `initialAgent`, where it is part of the pre-side-effect validation: no
   workspace, worktree, agent or queued message is created. Images stored with
   `agent.update` are not checked up front; the turn-time check below covers them. Images that fail
   preparation are left to the turn, which reports them as for a local agent. A
   turn whose frame still does not fit (for example several queued messages
   delivered together) fails with `node-prompt-too-large:` and nothing is sent to
   the machine.
2. **Files.** The prompt carries the same attachment notice as a local agent's, and
   the agent copies the file with `ws.file.getAttachment(attachmentId, destDir?)`,
   which runs on the machine. The machine forwards the internal frame
   `file.attachmentData` (refused from agent code). The backend answers only for an
   agent on the link's lease and only for an attachment of that agent's workspace.
   The machine asks for the file in pieces of at most 4 MiB, each starting where
   the copy so far ends:

   ```ts
   // workspace.call params: { method: "file.attachmentData", args: AttachmentDataArgs }
   interface AttachmentDataArgs {
     attachmentId: string;
     offset?: number;     // byte offset of the piece; with `length`
     length?: number;     // at least 1; the backend sends at most 4 MiB
   }
   interface AttachmentData {
     fileName: string;
     mimeType?: string;
     size: number;        // bytes of the whole file
     uploadedAt: string;
     data: string;        // base64 of the piece's bytes (the whole file without a range)
     offset?: number;     // with a range: where `data` starts
     sha256?: string;     // with a range at offset 0: lowercase hex of the whole file
   }
   ```

   An unknown id, or an attachment of another workspace, fails with
   `unknown attachment id: <id>`; a file deleted from the backend's store fails with
   the same "continue without this file" error as for a local agent; an `offset`
   past the end fails with `-32602` `attachment-range-invalid:`; an `offset` or
   `length` alone, or not a non-negative integer, or a `length` of 0, fails with
   `-32602`. Without a range the answer is the whole file, and a file larger than
   5 MiB fails with `attachment-too-large-for-link:` (its base64 must fit the
   link's 8 MiB RPC cap). The machine writes each piece to a hidden part file in
   the agent's checkout under `destDir` (default `.intent/attachments/`, with the
   same ignore-all `.gitignore` marker as a local copy, so the copy never reaches
   the agent's pushed refs), and when the copy reaches `size` checks its size and
   sha256 against the first answer's. A mismatch, or a piece that does not start
   where the copy ends, fails the call (`attachment-copy-mismatch:` for a size or
   hash mismatch) and removes the part file. A matching copy replaces the file
   unless an identical file is already there, and the call answers with the local
   result `{ path, fileName, mimeType?, size, uploadedAt }`, `path` relative to
   the checkout. So any file the backend accepts reaches a remote agent.

This needs no new nodeProtocol: `file.attachmentData` rides `workspace.call`, and
the range is optional. An older backend ignores `offset` and `length` and answers
with the whole file (no `offset` in the answer), which the machine copies as
before, or refuses a file over 5 MiB with `attachment-too-large-for-link:`, which
the call reports unchanged. An older machine sends no range and gets the whole
file, up to 5 MiB. An older backend that refuses the frame makes the machine fail
`file.getAttachment` with `remote-agent-unsupported:` naming the update. An older
machine refuses `file.getAttachment` itself; images still reach it in the prompt.
An older backend does not check the prompt's size up front: such a message fails
at its turn with `node-prompt-too-large:`.

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
