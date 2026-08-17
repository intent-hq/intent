# Developer Guide

This guide reflects the current Intent repository layout and APIs as of package version `2.22.0`.

## Getting Started

### Prerequisites

- Node.js 18+
- `pnpm`
- Git
- Auggie CLI for the default ACP provider workflow

### Install and Run

```bash
pnpm install

# Start the Electron app with the Chrome DevTools Protocol flow enabled
pnpm run dev:cdp
```

### Common Commands

```bash
pnpm run dev           # Standard development launcher
pnpm run dev:cdp       # Development launcher with CDP support
pnpm run build         # Production build
pnpm run check         # Svelte + TypeScript checks
pnpm run lint          # ESLint
pnpm run format        # Prettier write pass
pnpm run test:unit     # Vitest suite
pnpm run test:playwright
```

## Project Structure

The codebase is split across renderer features, Electron process code, shared types/utilities, and operational scripts.

```text
.
├── docs/                     # Product and engineering documentation
├── scripts/                  # Build, release, migration, and tooling scripts
├── src/
│   ├── features/             # Feature-first renderer modules
│   │   ├── agent/            # Agent lifecycle, orchestration, background tasks
│   │   ├── browser/          # Embedded browser tabs and browser tooling
│   │   ├── cdp/              # Chrome DevTools Protocol integration
│   │   ├── layout/           # Panel layout system and tab routing
│   │   ├── rules/            # User rules and rules IPC services
│   │   └── ...               # Many other product features
│   ├── lib/                  # Shared renderer utilities, services, stores, components
│   ├── main/                 # Electron main-process entry points and services
│   ├── preload/              # Electron preload bridge
│   ├── routes/               # SvelteKit routes and test pages
│   ├── shared/               # Cross-process config, types, constants, IPC contracts
│   └── test/                 # Test helpers, factories, and mocks
└── package.json              # Scripts, dependencies, and version metadata
```

When updating docs or adding features, verify which side of the app owns the behavior:

- `src/features/` for renderer-facing product logic
- `src/main/` for Electron and system integration
- `src/shared/` for contracts used by both sides
- `scripts/` for operational workflows such as release packaging and uploads

## Agent Creation and Integration

Use `agentFactory.createAgent(...)` for agent creation. The factory is the supported public entry point and normalizes agent config before backend creation.

```typescript
import { agentFactory } from '$features/agent/services/agent-factory';

const result = await agentFactory.createAgent(workspace, {
  name: 'Review Changes',
  agentType: 'task-loop',
  model: 'haiku4.5',
  initialMessage: 'Review the current diff and summarize the risks.',
  source: 'workspace-initializer',
});
```

Important notes:

- Pass `agentType` so the backend can build the correct instructions.
- `CreateAgentOptions.systemPrompt` is deprecated; do not use it for new code.
- Valid `AgentTypeId` values include `chat`, `task-loop`, `workspace-agent`, `code-review`, `commit-message`, and `pr-description`.

## Panel Layout System

The workspace UI is driven by the `panel-layout` Redux slice (`src/store/renderer/slices/panel-layout/`), with `src/features/layout/panel-layout-adapter.ts` bridging layout operations for feature code.

Core ideas:

- Each workspace has its own layout state in the slice.
- Layouts are trees of panel nodes and split nodes.
- Split nodes can be horizontal or vertical.
- Each panel can host multiple tabs, with one active tab at a time.
- State includes focus tracking, pending focus, recently closed tabs, layout history, and focus history.
- Layout state is persisted so reopened workspaces restore their previous arrangement.

The main data model centers on:

- `WorkspacePanelLayout` for the full layout state
- `PanelState` for the tabs inside one panel
- `PanelTab` for the content metadata a tab needs to render

`PanelTab` carries type-specific identifiers such as `noteId`, `filePath`, `agentId`, `terminalId`, `diffPath`, and `browserUrl`, which let the UI route a tab to the correct feature component.

## Tab Types and Content Routing

The tab system is split into two layers:

1. `PanelTabType` in the panel-layout types (`src/store/renderer/slices/panel-layout/panel-layout-types.ts`) defines the allowed tab kinds.
2. `tabTypeRegistry` in `src/features/layout/tab-types/registry.ts` maps a tab type to its renderer component and UI metadata.

Each registered tab type provides:

- `type`
- `component`
- `icon`
- `defaultTitle`
- `categoryLabel`
- optional `sidebarTabId`
- optional `renameable`

`registerAllTabTypes()` currently registers the main built-in tabs used by the workspace UI:

- `browser`
- `terminal`
- `code-review`
- `agent-overview`
- `agent`
- `note`
- `file`
- `diff`
- `changes`
- `local-changes`
- `chat-changes`
- `activity-changes`
- `settings`
- `overview`

The broader `PanelTabType` union also includes workflow-oriented types such as `activity`, which are part of the routing model even when a specific registry entry is managed elsewhere or added later.

## Background Agents

Background tasks such as commit-message generation, PR description generation, and code review run through the `background-agent-executor` Redux slice (`src/store/renderer/slices/background-agent-executor/`) and its sagas.

Executor state tracked per run includes:

- `status`
- `messages`
- `result`
- `error`
- `progress`
- `agentId`

Background model selection is provider-aware. The `background-agent-settings` Redux slice (`src/store/renderer/slices/background-agent-settings/`) keeps:

- a default background-agent model
- per-type overrides for `commit`, `pr`, `review`, and `fast`

That allows the app to preserve different background-agent model preferences for different ACP providers.

## Provider System

ACP provider metadata is served by the daemon's `providers.catalog` RPC (monorepo [docs/protocol/methods/models-providers.md](../protocol/methods/models-providers.md) §5.38) — the single source of truth for provider identity, display names, CLI commands, default models, model tiers, and env-var/feature-code gating. There is no static provider table in the renderer.

At connect time the catalog is hydrated into the `providerCatalog` Redux slice (`src/store/renderer/slices/provider-catalog/`); renderer code reads it through the slice's selectors. Main-process call sites that cannot import the renderer store use the cached catalog accessor in `src/main/utils/provider-catalog-accessor.ts`.

Compound model ids (`provider:model`) are parsed with the pure helpers in `src/shared/utils/compound-model-id.ts`, with the catalog's default provider threaded in explicitly for bare ids.

The active provider is tracked in the `providerSettings` Redux slice; it starts empty and adopts the registry default when the catalog hydrates. When you add or update provider-sensitive UI, read the active provider and provider metadata from the store selectors rather than assuming Auggie is always selected.

## Testing and Validation

Use `pnpm` for all documented test commands.

```bash
pnpm run test:unit
pnpm run test:unit -- src/features/agent/__tests__/agent.test.ts
pnpm run test:unit:watch
pnpm run check
pnpm run lint
```

Tests and test helpers are spread across several areas of the repo:

- feature-level `__tests__` folders under `src/features/`
- Electron main-process tests under `src/main/__tests__/`
- shared tests under `src/shared/__tests__/`
- reusable mocks/factories under `src/test/`

## Debugging Notes

- `pnpm run dev:cdp` is the best default when working on browser/CDP features.
- Renderer-only issues usually live in `src/features/`, `src/lib/`, or `src/routes/`.
- IPC and desktop integration issues usually involve `src/main/`, `src/preload/`, and `src/shared/ipc` contracts.
- Release or packaging issues usually trace back to `scripts/` and `package.json` script wiring.

## Contribution Tips

1. Verify the owning feature area before editing code.
2. Use the existing store/service patterns instead of creating parallel abstractions.
3. Prefer extending typed contracts in `src/shared/` when behavior spans renderer and main.
4. Run the smallest relevant validation command before sending a change for review.
