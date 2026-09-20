> Part of the [Intent JSON-RPC protocol docs](../README.md) — MCP `ws.*` binding signature index.

<!-- GENERATED FILE — do not edit by hand. Rendered by scripts/check-mcp-bindings.mjs from the
     WORKSPACE_API_DESCRIPTION / WORKSPACE_API_DESCRIPTION_CHIEF constants in
     packages/intentd/crates/intent-acp/src/mcp_server/tools.rs; regenerate with
     `node scripts/check-mcp-bindings.mjs --write`. -->

## MCP `ws.*` binding signatures

Every `ws.<namespace>.<method>` binding the workspace MCP tool exposes, with its parameters and
result shape exactly as the pinned intentd help text states them (comment text omitted). A prose
paragraph elsewhere under `docs/protocol/` that documents a binding must agree with its line here.

### ws

```text
ws.help(namespace?) → string
```

### ws.agent

```text
ws.agent.create(name, message, opts?) → { ok, id?, text?, ... }
ws.agent.delegate({ taskNoteId?, noteId?, taskText?, agentInstructions?, specialist?, model?, provider?, reasoningEffort?, behaviorPrompt?, waitMode?, skipAutoCommit?, tasks? }) → { ok, text?, ... }
ws.agent.diagnostics({ agentId?, taskNoteId?, includeCompleted?, staleRespondingAfterMs? }?) → { diagnostics, text }
ws.agent.getMessageBlock(agentId, messageId, blockId) → { block }
ws.agent.getQueue(agentId) → { ok, agentId, queueLength, queue }
ws.agent.list(optsOrIncludeCompleted?) → [agents]
ws.agent.listSpecialists() → [specialists]
ws.agent.readConversation(agentId, { lastN?, startTurn?, endTurn?, includeToolCalls? }) → messages
ws.agent.removeQueuedMessage(agentId, messageId) → { ok, agentId, messageId }
ws.agent.reportBlocker(reason) → { ok, kind, reason, savedAt }
ws.agent.reportToParent(report) → { ok, ... }
ws.agent.requestDiscussion(reason) → { ok, kind, reason, savedAt }
ws.agent.retire(reason?) → { ok, agentId, retired, retiredAt, reason? }
ws.agent.send(agentId, message, priority?) → { ok, agentId, delivery?, ... }
ws.agent.sendToTask(taskNoteId, message, priority?) → { ok, taskNoteId, delivery?, ... }
ws.agent.snapshot() → { time, hooks?, agentWatches?, queuedMessages?, eventSubscriptions?, activeSubAgents?, unsettledSubAgents?, runningSubAgents?, numQuestionsAsked?, prMonitors?, prs?, tasks?, pendingAttention? }
ws.agent.status(agentId) → agent
ws.agent.subscribe(eventTypes, { excludeSelf?, batchWindow? }) → { subscriptionId, ... }
ws.agent.summary(agentId) → summary
ws.agent.unsubscribe(subscriptionId) → { ok, subscriptionId }
ws.agent.unwatch(subscriptionIdOrAgentId) → { ok, removed }
ws.agent.wakeOrCreate(taskNoteId, contextMessage, model?, messageMetadata?, reasoningEffort?) → { ... }
ws.agent.watch(agentId) → { ok, subscriptionId, agentId }
```

### ws.app.agents

```text
ws.app.agents.ask(agentId, message, priority?) → { ok, send, watch }
ws.app.agents.getMessageBlock(workspaceId, agentId, messageId, blockId) → { block }
ws.app.agents.list({ workspaceId?, includeCompleted?, limit?, cursor? }?) → { threads, total, returned, nextCursor? }
ws.app.agents.readConversation(workspaceId, agentId, { lastN?, startTurn?, endTurn?, includeToolCalls? }?) → { workspaceId, workspaceTitle, agentId, agentName, totalMessages, returnedMessages, startTurn, endTurn, includeToolCalls, taskNoteId?, messages }
ws.app.agents.send(agentId, message, priority?) → { ok, agentId, agentName, workspaceId, sourceMessageId, sourceUrl, ...sendOutcome }
ws.app.agents.waitFor({ agentIds, waitMode? }) → { ok, waitMode, results }
```

### ws.app.proposal

```text
ws.app.proposal.show(proposal) → ProposalCard
```

### ws.app.question

```text
ws.app.question.ask({ header, question, options, explanation?, multiSelect? }) → { ok, attachmentId, message }
```

### ws.app.settings

```text
ws.app.settings.get(path) → setting
ws.app.settings.list({ includeValues?, category? }?) → settings[]
ws.app.settings.propose(changes[] | { changes }) → ProposalCard
```

### ws.app.specialists

```text
ws.app.specialists.get(id) → specialist
ws.app.specialists.list() → specialists[]
ws.app.specialists.propose({ action: "create"|"edit"|"delete", id?, name?, description?, model?, prompt?, scope? }) → ProposalCard
```

### ws.app.ui

```text
ws.app.ui.highlight(id, { durationMs? }?) → { ok, id, workspaceId, durationMs? }
ws.app.ui.navigate(route, { highlightId?, durationMs? }?) → { ok, route, workspaceId, highlightId?, durationMs? }
ws.app.ui.targets() → [{ id, label, route, tab, category, description, dynamic?, idPattern?, hashAliases?, scrollSelector?, highlightSelector? }]
```

### ws.app.workspaces

```text
ws.app.workspaces.archive(id) → ProposalCard
ws.app.workspaces.bulkArchive(ids) → ProposalCard
ws.app.workspaces.bulkDelete(ids) → ProposalCard
ws.app.workspaces.create(params) → ProposalCard
ws.app.workspaces.delete(id) → ProposalCard
ws.app.workspaces.get(id) → workspace
ws.app.workspaces.list({ filter?, sort? }) → workspaces[]
ws.app.workspaces.open(id, { openInNewWindow? }?) → { ok, queued }
```

### ws.browser

```text
ws.browser.docs(topic) → string
ws.browser.exec(actions, tabId?) → result | results[]
ws.browser.listTabs(scope?) → [tabs]
```

### ws.comment

```text
ws.comment.add(noteId, { searchContext, commentTarget, comment, type?, author?, authorType? }) → { ... }
ws.comment.delete(noteId, commentId) → { ... }
ws.comment.getThread(noteId, { threadId?, commentId? }) → thread
ws.comment.list(noteId, { since?, authorType?, status?, includeComments? }) → [threads]
ws.comment.respond(noteId, { threadId?, commentId?, comment, type?, author?, authorType?, suggestionOriginal?, suggestionProposed? }) → { ... }
```

### ws.crossWorkspace

```text
ws.crossWorkspace.listNotes(targetWorkspaceId) → [notes]
ws.crossWorkspace.listSiblings() → [workspaces]
ws.crossWorkspace.readNote(targetWorkspaceId, noteId) → note
```

### ws.event

```text
ws.event.agentActivity(agentId?, minutesAgo?) → [events]
ws.event.query({ eventType?, actorType?, actorId?, path?, minutesAgo?, limit? }) → [events]
ws.event.subscribe(eventTypes, { excludeSelf?, batchWindow? }) → { subscriptionId, eventTypes }
ws.event.unsubscribe(subscriptionId) → { ok, subscriptionId }
ws.event.workspaceSummary(minutesAgo?) → summary
```

### ws.file

```text
ws.file.delete(path) → { ok, path, deleted }
ws.file.getAttachment(attachmentId, destDir?) → { path, fileName, mimeType?, size, uploadedAt }
ws.file.list(path?) → [{ name, type }]
ws.file.mkdir(path) → { ok, path, created?|existed? }
ws.file.read(path) → string
ws.file.rename(oldPath, newPath) → { ok, oldPath, newPath }
ws.file.write(path, content) → { ok, path, size }
```

### ws.git

```text
ws.git.commit(message, { gitRootId?, files?, userRequested? }) → { ok, hash, files, fileCount }
ws.git.listRoots() → [{ id, workspaceId, path, source, repoOwner?, repoName?, branch?, ... }]
ws.git.registerRoot(path) → { id, workspaceId, path, source, repoOwner?, repoName?, branch?, ... }
ws.git.unregisterRoot(path) → { ok, gitRootId, path }
```

### ws.hook

```text
ws.hook.cancel(hookId) → { ok, hook }
ws.hook.get(hookId) → hook
ws.hook.list({ includeRetired? }?) → [hooks]
ws.hook.runNow(hookId) → { ok, hookId }
ws.hook.schedule({ name, code, delayMs | cron | runAt, ttlMs?, perpetual? }) → { hook, dispatched }
```

### ws.host

```text
ws.host.exec({ command, args?, cwd?, env?, timeoutMs? }) → { stdout, stderr, exitCode, timedOut? }
```

### ws.mcp

```text
ws.mcp.callTool(serverId, toolName, args?, timeoutMs?) → result
ws.mcp.listServers() → { servers: [{ id, name, transport, enabled, state, toolCount?, workspaceDisabled? }] }
ws.mcp.listTools(serverId) → { tools: [...] }
```

### ws.note

```text
ws.note.add(id, { content, heading?, position? }) → { ... }
ws.note.create(title, content, tags?) → { id, title, tags, link, markdownLink, convertedCount, createdTaskNoteIds, createdTasks, warnings }
ws.note.delete(id) → { ok, noteId, deleted }
ws.note.edit(id, { old, new }) → { ... }
ws.note.editLines(id, { start, end, content }) → { ... }
ws.note.list(tag?) → [{ id, title, tags, ... }]
ws.note.listTasks(id) → [{ text, status, taskNoteId, linkedTaskNoteId, lineNumber, ... }]
ws.note.read(id) → { id, title, content, rawContent, tags, ... }
ws.note.readAsset(asset) → { assetId, mimeType, data, sizeKb }
ws.note.saveAsset({ data, mimeType, originalName? }) → { assetId, path, url }
ws.note.setContent(id, content, confirmReplacement?) → { ... }
ws.note.updateMetadata(id, { title?, tags? }) → { ... }
```

### ws.pr

```text
ws.pr.monitor(prNumber, { repo? }) → { ok, monitor, requirements }
ws.pr.monitors() → [monitors]
ws.pr.snapshot(prNumber, { repo? }?) → { repo, prNumber, title, url, state, isDraft, isMerged, isClosed, headSha, updatedAt, mergeable, mergeableState, mergeBlockedReason, checks: { total, passed, failed, pending, failedNames }, reviews: { decision, approvals, changesRequested }, comments: { conversationCount, reviewCommentCount, unresolvedThreadCount?, totalCount }, requirements: { state, isDraft, hasConflicts, isBehind, mergeable?, checks: { total, passed, failed, pending, items, failingRequired, pendingRequired, requiredKnown }, approvals: { decision, have, needed?, changesRequested }, threads: { unresolved?, resolutionRequired? }, mergeStateStatus?, mergeBlockedReason?, isInMergeQueue?, mergeQueueEjection?, rulesKnown }, pausedUntil? }
ws.pr.unmonitor(prNumber, { repo? }) → { ok, monitor }
```

### ws.primitive

```text
ws.primitive.addAgentAction(noteId, agentId, goal, description) → { ok, primitiveId, noteId }
ws.primitive.addCli(noteId, command, description, workingDirectory?) → { ok, primitiveId, noteId }
ws.primitive.addPatch(noteId, filePath, diff, description) → { ok, primitiveId, noteId }
ws.primitive.addReference(noteId, semanticId, description, snapshot?) → { ok, primitiveId, noteId }
```

### ws.script

```text
ws.script.create(name, command, mode, { cwd?, env?, category?, autoStart?, scriptId? }) → { id }
ws.script.list() → [scripts]
ws.script.output(scriptId, maxLines?) → string
ws.script.remove(scriptId) → { ok, scriptId }
ws.script.restart(scriptId) → { ok, scriptId }
ws.script.run(scriptId, { maxLines?, timeoutSeconds? }) → { exitCode?, output, timedOut?, warning? }
ws.script.start(scriptId) → { ok, scriptId }
ws.script.status(scriptId) → status
ws.script.stop(scriptId) → { ok, scriptId }
```

### ws.task

```text
ws.task.assignAgent(noteId, agentId) → { ok, noteId, agentId }
ws.task.convertBlocks(noteId) → { convertedCount, createdNoteIds, createdTasks, warnings }
ws.task.createPrerequisite(dependentNoteId, title, { content?, status? }) → { ... }
ws.task.getMyTask(taskNoteId) → task
ws.task.markAsTask(noteId, status, { acceptanceCriteria?, effort?, dependsOn?, conflictsWith? }) → { ... }
ws.task.setRelations(noteId, { dependsOn?, conflictsWith? }) → { ok, noteId, dependsOn, conflictsWith }
ws.task.update(noteId, line, { text?, status?, expected? }) → { ok, lineNumber, ... }
ws.task.updateNoteStatus(noteId, status) → { ok, noteId, status, advisory? }
ws.task.updateStatus(noteId, taskText, status) → { ok, noteId, status, note }
```

### ws.terminal

```text
ws.terminal.list() → [terminals]
ws.terminal.readOutput(terminalId, maxLines?) → string
```

### ws.workspace

```text
ws.workspace.applyProposal(proposalIdOrIdempotencyKey, { userRequested: true, title?, initialPrompt? }) → { ok, proposalId, outcome, workspace, initialAgent?, overrides?, alreadyResolved?, resolveWarning? }
ws.workspace.archive() → { ok, status, archivedAt }
ws.workspace.details() → { id, title, hasTitle, status, statusMessage, statusImageAssetId, branch, repositoryName, tags }
ws.workspace.info() → { id, path }
ws.workspace.proposeSibling({ title, initialPrompt, specialist?, baseRef? }) → { ok, proposalId, proposal, ... }
ws.workspace.setAgentName(name) → { ok, name }
ws.workspace.setStatusImage({ data, mimeType, originalName? } | null) → { ok, statusImageAssetId, url? }
ws.workspace.setStatusMessage(message) → { ok, statusMessage }
ws.workspace.setTitle(title) → { ok, title, branch, skipped? }
ws.workspace.unarchive() → { ok, status }
```
