# Event System Architecture

**Version**: 3.0
**Date**: 2026-03-25
**Purpose**: Comprehensive guide to the Redux-based event system

## Overview

The Intent app uses a **Redux-based event system** for all workspace events. Events are managed through Redux slices and sagas in the main process, with IPC channels for renderer communication.

1. **WorkspaceEvents**: Full-featured events managed by `workspace-events` Redux slice with persistence, filtering, and query support

> **Note**: The legacy EventBus singletons (UnifiedEventBus, WorkspaceEventBus, WorkspaceEventService) have been removed, as have the DomainEvents broadcast layer (`domain-events` actions/sagas) and the main-process Redux store. All event state is now managed through renderer Redux.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Renderer Process                             │
├─────────────────────────────────────────────────────────────────┤
│  Components              Redux Store              Selectors     │
│  ┌─────────┐         ┌──────────────────┐    ┌─────────────┐   │
│  │ UI      │◄────────│ workspace-events │◄───│ Reactive    │   │
│  │ Layer   │────────►│ slice (synced)   │───►│ Selectors   │   │
│  └─────────┘         └────────┬─────────┘    └─────────────┘   │
└──────────────────────────────┼──────────────────────────────────┘
                               │ IPC (Redux sync)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Main Process                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Redux Store (Main)                          │    │
│  │                                                          │    │
│  │  • workspace-events slice — event state + persistence   │    │
│  │  • agent-subscriptions slice — agent event filters      │    │
│  └────────────────────────┬────────────────────────────────┘    │
│                           │                                      │
│                           ▼                                     │
│                  ┌──────────────┐                               │
│                  │ Sagas        │                               │
│                  │ (side fx)    │                               │
│                  └──────────────┘                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Event Types

### WorkspaceEvents (Full Events)

Used for file changes, agent actions, git operations. Features:
- Unique ID and timestamp
- Actor attribution (user, agent, system)
- Workspace scoping

Persistence and historical queries are daemon-owned (intentd); the frontend keeps no local event store.

```typescript
interface WorkspaceEvent {
  id: string;
  type: WorkspaceEventType;
  timestamp: string;
  workspaceId?: string;
  actor?: EventActor;
  data: Record<string, unknown>;
}
```

### DomainEvents (Removed)

The DomainEvents broadcast layer (`domain-events` actions and sagas under `src/store/main/slices/domain-events/`, including `domainEventEmitted`) has been removed along with the main-process Redux store. Real-time updates now flow from the daemon to the renderer via the daemon events bridge.

## Key Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| workspace-events slice | `store/main/slices/workspace-events/` | Event state management |
| agent-subscriptions slice | `store/main/slices/agent-subscriptions/` | Agent event filter state |
| EventFilterEngine | `features/events/event-filter-engine.ts` | Pure filter matching logic |
| agent-subscription-ops | `features/events/main/agent-subscription-ops.ts` | Agent subscription operations |

## Emitting Events

Main-process event emission via `mainDispatch` no longer does anything: `src/store/main/redux-store-bridge.ts` is neutralized (the main-process Redux store was removed; `mainDispatch` is a no-op that returns the action unchanged). Events originate from the intentd daemon and reach the renderer through the daemon events bridge (`src/features/events/daemon-events-bridge.client.ts`).

## IPC Channels

All event IPC channels are defined in `src/shared/ipc-registry.ts`:

| Channel | Purpose |
|---------|---------|
| `events:emit` | Emit event from renderer |
| `events:subscribe` | Subscribe to events |
| `events:unsubscribe` | Unsubscribe from events |
| `events:query` | Query events with filters |
| `events:getLastEvent` | Get last event of type |
| `events:getStatistics` | Get event statistics |

## Data Flow: File Change Event

Change detection is daemon-owned (the FE change-tracking subsystem — ChangeDetector, ChangeProcessor, EventCoordinator — has been removed):

```
1. File changed on disk
   ↓
2. intentd daemon detects the change and emits a WorkspaceEvent
   ↓
3. The daemon events bridge delivers the event to the renderer
   ↓
4. workspace-events slice accepts event (with deduplication)
   ↓
5. UI components update via Redux selectors
```

## Best Practices

1. **Import pure utilities from features/events**: EventFilterEngine
2. **Use EventFilterBuilder**: For type-safe filter construction

## Configuration

Event-system timing configuration (`src/features/file-tracking/tracking.config.ts`) was removed along with the FE change-tracking subsystem — change detection and event persistence are daemon-owned.

## Deprecated Channels

The legacy `activity-log:*` channels (`activity-log:get-entries`, `activity-log:add-entry`, `activity-log:clear`) have been removed entirely — they are no longer defined in `ipc-registry.ts`. Use the `events:*` channels instead.

---

## IPC Event Handling in the Renderer

### Event Emission Patterns

Events can arrive in the renderer via two different emission patterns:

#### Pattern A: Direct IPC (Flat Data)
```typescript
// Main process emits:
window.webContents.send('agent:renamed', { agentId, workspaceId, name });

// Renderer receives via listenSync:
// { payload: { agentId, workspaceId, name } }
```

#### Pattern B: Wrapped WorkspaceEvent
```typescript
// Main process sends the full event object to renderer windows:
window.webContents.send('agent:deleted', event);

// Renderer receives via listenSync:
// { payload: { type: 'agent:deleted', id: '...', data: { agentId, agentName } } }
```
(Historically these events were dispatched through the main-process Redux store via `mainDispatch(emitWorkspaceEvent(...))`; that store has been removed and `mainDispatch` is now a no-op.)

### The `listenSync` Wrapping

The `listenSync` function in `electron-bridge.ts` always wraps incoming data:

```typescript
const listener = (data: T) => {
  handler({ payload: data });  // Always wraps in { payload: data }
};
```

### Using `extractEventData()` Helper

To safely handle both patterns, use the `extractEventData()` helper from `$lib/electron-bridge`:

```typescript
import { listenSync, extractEventData } from '$lib/electron-bridge';
import type { AgentDeletedPayload } from '$features/events/types';

// Extract a specific field (works for both patterns)
listenSync('agent:deleted', (event: any) => {
  const agentId = extractEventData<string>(event, 'agentId');
  if (typeof agentId === 'string') {
    handleAgentDeleted(agentId);
  } else {
    logger.warn('Received agent:deleted with invalid agentId', { event });
  }
});

// Extract the full data object
listenSync('agent:renamed', (event: any) => {
  const data = extractEventData<AgentRenamedPayload>(event);
  if (data && typeof data.agentId === 'string') {
    handleAgentRenamed(data);
  }
});
```

### Best Practices for Event Handlers

1. **Always use `extractEventData()`** for new handlers - it handles both emission patterns
2. **Add validation** - Always verify the extracted data has the expected shape:
   ```typescript
   const agentId = extractEventData<string>(event, 'agentId');
   if (typeof agentId !== 'string') {
     logger.warn('Unexpected event format', { event });
     return;
   }
   ```
3. **Use TypeScript types** - Import payload types from `$features/events/types`:
   ```typescript
   import type { AgentDeletedPayload, AgentRenamedPayload } from '$features/events/types';
   ```
4. **Log unexpected formats** - Don't silently fail when data extraction fails
5. **Prefer Redux `emitWorkspaceEvent` for new events** - It provides consistent structure and better observability

### Common Pitfalls

❌ **DON'T** assume the event format without checking:
```typescript
// BAD: Assumes flat format - breaks with Redux WorkspaceEvent objects
listenSync('agent:deleted', (event) => {
  const agentId = event.payload;  // Could be a WorkspaceEvent object!
  agents = agents.filter(a => a.id !== agentId);  // String vs Object comparison always true
});
```

✅ **DO** use `extractEventData()` and validate:
```typescript
// GOOD: Handles both patterns and validates
listenSync('agent:deleted', (event) => {
  const agentId = extractEventData<string>(event, 'agentId');
  if (typeof agentId === 'string') {
    agents = agents.filter(a => a.id !== agentId);
  }
});
```

### IPC Payload Type Definitions

Type definitions for IPC event payloads are available in `src/features/events/types.ts`:

| Type | Event Channel | Description |
|------|---------------|-------------|
| `AgentDeletedPayload` | `agent:deleted` | Agent deletion data |
| `AgentRenamedPayload` | `agent:renamed` | Agent rename data |
| `AgentCreatedPayload` | `agent:created` | Agent creation data |
| `AgentSubscribedPayload` | `agent:subscribed` | Agent subscription data |
| `AgentUnsubscribedPayload` | `agent:unsubscribed` | Agent unsubscription data |
| `AgentIdlePayload` | `agent:idle` | Agent idle state data |
| `AgentStatusChangedPayload` | `agent:status-changed` | Agent status change data |
| `NoteCreatedPayload` | `note:created` | Note creation data |
| `NoteUpdatedPayload` | `note:updated` | Note update data |
| `NoteDeletedPayload` | `note:deleted` | Note deletion data |
| `TaskStatusChangedPayload` | `task:status-changed` | Task status change data |
| `IpcEventWrapper<T>` | (any) | Wrapper for listenSync events |

### Debugging Event Issues

If events aren't being handled correctly:

1. **Log the raw event** to see its actual structure:
   ```typescript
   listenSync('event-name', (event) => {
     console.log('Raw event:', JSON.stringify(event, null, 2));
   });
   ```

2. **Check the emission source** - Is it using direct IPC or Redux events?
   - Search for `webContents.send('event-name'` for direct IPC
   - Search for `emitWorkspaceEvent(` for Redux-based events

3. **Use `isWorkspaceEvent()` type guard** to understand the format:
   ```typescript
   import { isWorkspaceEvent } from '$lib/electron-bridge';

   listenSync('event-name', (event) => {
     const payload = event.payload;
     if (isWorkspaceEvent(payload)) {
       console.log('WorkspaceEvent format, data:', payload.data);
     } else {
       console.log('Flat format:', payload);
     }
   });
   ```
