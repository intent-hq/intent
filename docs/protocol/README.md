# Intent Backend — JSON-RPC Protocol

**Protocol Version:** `9.4`

This directory is the canonical wire contract between Intent clients (desktop, iOS, CLI, and agent developers building clients) and the Intent backend daemon (`intentd`): transport, JSON-RPC envelope, the full method catalog, events, agent streaming, the permission flow, error codes, and thin-client guidance. It is a **living specification**: changes land through the compatibility policy (see below), and the method surface is enforced by golden tests in the `intent-transport` crate.

## Section → file map

| Section | File |
|---------|------|
| Protocol Version & Compatibility (incl. Compatibility Policy) | [versioning.md](./versioning.md) |
| §1 Transport (1.1–1.4) | [01-transport.md](./01-transport.md) |
| §2 Authentication (2.1–2.3) | [02-authentication.md](./02-authentication.md) |
| §3 Message Envelope (JSON-RPC 2.0) (3.1–3.6) | [03-envelope.md](./03-envelope.md) |
| §4 Heartbeat & Lifecycle | [04-heartbeat.md](./04-heartbeat.md) |
| §5 Method Catalog — intro, router/fast-path method tables, aliases, client-served reverse RPCs | [05-method-catalog.md](./05-method-catalog.md) |
| §6 Events & Subscriptions (6.1–6.9) | [06-events.md](./06-events.md) |
| §7 Agent Streaming (7.1–7.3) | [07-agent-streaming.md](./07-agent-streaming.md) |
| §8 Permission Flow | [08-permission-flow.md](./08-permission-flow.md) |
| §9 Error Codes (incl. 9.1) | [09-error-codes.md](./09-error-codes.md) |
| §10 Thin-Client Guidance (10.1–10.4) | [10-thin-client.md](./10-thin-client.md) |

### §5.x subsections (`methods/`)

| Subsection | File |
|------------|------|
| §5.1 `workspace.*` | [methods/workspace.md](./methods/workspace.md) |
| §5.2 `note.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.2.1 `note.lineAttribution.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.3 `comment.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.4 `task.*` | [methods/notes-tasks.md](./methods/notes-tasks.md) |
| §5.5 `agent.*` | [methods/agents.md](./methods/agents.md) |
| §5.5a `sandbox.cow.*` (CoW agent sandboxes) | [methods/agents.md](./methods/agents.md) |
| §5.6 `git.*` | [methods/git.md](./methods/git.md) |
| §5.7 `pr.*` | [methods/pr.md](./methods/pr.md) |
| §5.8 `script.*` | [methods/scripts.md](./methods/scripts.md) |
| §5.9 `browser.*`, `terminal.*`, `file.*` | [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) |
| §5.10 `event.*` (query/aggregation) | [methods/events-query.md](./methods/events-query.md) |
| §5.11 `crossWorkspace.*`, `primitive.*`, `specialist.*`, `repo.*` | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.12 `settings.*` | [methods/settings.md](./methods/settings.md) |
| §5.13 Interactive `terminal.*` | [methods/files-terminal-browser.md](./methods/files-terminal-browser.md) |
| §5.14 Execution locus, locality & remote behavior | [methods/execution-locus.md](./methods/execution-locus.md) |
| §5.15 `search.*` | [methods/search-drafts.md](./methods/search-drafts.md) |
| §5.16 `drafts.*` | [methods/search-drafts.md](./methods/search-drafts.md) |
| §5.17 `client.hello` handshake & stable client identity | [methods/client-hello.md](./methods/client-hello.md) |
| §5.18 `accept-changes.*` | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.19 `file-tracking.*` (reads) | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.20 Change metrics (reads) | [methods/change-tracking.md](./methods/change-tracking.md) |
| §5.21 `rules.*` | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.22 `mcp.servers.*` (incl. §5.22.1 `mcp.oauth.*`, §5.22.2 `mcp.testConnection`) | [methods/mcp-servers.md](./methods/mcp-servers.md) |
| §5.23 Usage metrics — `workspace.getTokenUsage` | [methods/workspace.md](./methods/workspace.md) |
| §5.24 Session stats — `agent.getSessionStats` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.25 Worktree setup scripts — `workspace.getSetupScript` etc. | [methods/workspace.md](./methods/workspace.md) |
| §5.26 Future integrations & observability | [methods/integrations.md](./methods/integrations.md) |
| §5.27 `github.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.28 `linear.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.29 `sentry.*` namespace | [methods/integrations.md](./methods/integrations.md) |
| §5.30 `models.list` — model catalog | [methods/models-providers.md](./methods/models-providers.md) |
| §5.31 `agent.enhancePrompt` — one-shot prompt enhancement | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.32 `agent.completeOnce` — one-shot prompt→completion | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.33 `repoConfig.*` — per-repository configuration | [methods/misc-namespaces.md](./methods/misc-namespaces.md) |
| §5.34 Skills — `skill.list` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.35 Interrupted-agent resumption — `agent.listInterrupted` / `agent.resolveInterrupted` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.36 Agentic usage stats — `stats.getUsage` | [methods/agent-aux.md](./methods/agent-aux.md) |
| §5.37 Managed Unsloth server — `unsloth.status` / `unsloth.stop` | [methods/system-observability.md](./methods/system-observability.md) |
| §5.38 Provider catalog — `providers.catalog` | [methods/models-providers.md](./methods/models-providers.md) |
| §5.39 Token-rate history — `stats.getRateHistory` | [methods/system-observability.md](./methods/system-observability.md) |
| §5.40 Background hooks — `hook.*` | [methods/hooks.md](./methods/hooks.md) |
| §5.41 Voice transcription — `voice.transcribe` / `voice.getWorkspaceVocabulary` | [methods/voice.md](./methods/voice.md) |
| §5.42 Centralized PR monitoring — `prMonitor.*` | [methods/pr.md](./methods/pr.md) |
| §5.43 Daemon stack sampling — `debug.sampleStacks` | [methods/system-observability.md](./methods/system-observability.md) |

## Compatibility policy (summary)

The protocol version is a `major.minor` pair: **additive** changes (new methods, new optional params, new presence-detected response fields) bump the minor version; **breaking** changes (removed methods, changed shapes) bump the major version. Additive response fields on an existing method do not change the golden-test-enforced catalog and ship within the current version — clients must detect them by **presence**, not by protocol version. The full policy and the complete version-by-version history live in [versioning.md](./versioning.md).

## How this doc set evolves

- **§ numbers are stable and citation-load-bearing.** intentd code comments, tests, and sibling docs cite "§5.5", "§6.5", etc. Never renumber existing sections; new content gets the next free number.
- **New §5.x subsections** go into the `methods/` file whose domain they belong to (see the map above), or a new `methods/*.md` file for a genuinely new domain — in either case, add the subsection to this README's map (the single canonical § → file map; [05-method-catalog.md](./05-method-catalog.md)'s index just points here).
- **Version-history entries** are appended to the narrative in [versioning.md](./versioning.md), and the current-version headers there and in this README are updated together.
- **New top-level sections** (§11, …) get their own `NN-*.md` file and a row in the map above.
