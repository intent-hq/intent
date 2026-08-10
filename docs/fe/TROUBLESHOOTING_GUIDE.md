# Troubleshooting Guide

**Version**: 2.0.0
**Last Updated**: November 19, 2025
**Status**: Post-Refactor Architecture

## Table of Contents

1. [Agent Creation Issues](#agent-creation-issues)
2. [Streaming Issues](#streaming-issues)
3. [Manager Issues](#manager-issues)
4. [Memory and Performance](#memory-and-performance)
5. [Test Issues](#test-issues)
6. [TypeScript Issues](#typescript-issues)
7. [Migration Issues](#migration-issues)

## Common Issues and Solutions

### Agent Creation Issues

#### Problem: User rules not being loaded

**Symptom**: Agent doesn't follow workspace-specific rules
**Cause**: Direct orchestrator call bypassing factory
**Solution**:

```typescript
// ❌ WRONG - Bypasses rules
const agent = await orchestrator.createAgent(workspace, config);

// ✅ CORRECT - Guarantees rules
import { agentFactory } from '$features/agent/services/agent-factory';
const agent = await agentFactory.createAgent(workspace, config);
```

#### Problem: Agent creation fails silently

**Symptom**: No agent appears, no error message
**Check**:

1. Verify workspace has valid ID
2. Check browser console for errors
3. Ensure Auggie is installed and running
4. Check IPC communication

**Debug**:

```typescript
try {
  const agent = await agentFactory.createAgent(workspace, config);
  console.log('Agent created:', agent);
} catch (error) {
  console.error('Agent creation failed:', error);
  // Check error.code for specific issue
}
```

### Streaming Issues

#### Problem: Messages appear all at once instead of streaming

**Cause**: The UI is not rendering incremental chunks, or another handler is delaying updates
**Solution**: `streamManager` processes chunks immediately. Inspect the streaming callbacks and emitted events instead of waiting for a batch flush.

```typescript
streamManager.on('stream:chunk', (event) => {
  console.log('Chunk received:', event.chunk.text);
});
```

#### Problem: Streaming stops unexpectedly

**Check**:

1. Agent process still running
2. No memory limits exceeded
3. Stream session not timed out

### Test Issues

#### Problem: Tests hanging indefinitely

**Cause**: The test is waiting on the wrong async boundary
**Solution**: Direct streaming does not have a batch-flush step. Await the real completion point instead, such as stream completion or the specific event your test expects.

```typescript
const result = await streamManager.completeStream(streamId);
expect(result.success).toBe(true);
```

#### Problem: "Cannot find module" errors in tests

**Cause**: Path aliases not configured
**Solution**: Check `vitest.config.ts`:

```typescript
export default {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      $lib: path.resolve(__dirname, './src/lib'),
    },
  },
};
```

### TypeScript Issues

#### Problem: Branded ID type errors

**Symptom**: "Type 'string' is not assignable to type 'AgentId'"
**Solution**:

```typescript
// ❌ WRONG
const agentId: AgentId = 'some-id';

// ✅ CORRECT - Get from factory/backend
const result = await agentFactory.createAgent(workspace, config);
const agentId = result.agentId; // Already branded
```

#### Problem: Missing error codes

**Symptom**: "Property 'X' does not exist on type 'AgentErrorCode'"
**Solution**: Add to the relevant error enum:

```typescript
// src/features/agent/errors/agent-errors.ts
export enum AgentErrorCode {
  // ... existing codes
  YOUR_NEW_ERROR = 'YOUR_NEW_ERROR',
}
```

### Performance Issues

#### Problem: High memory usage with multiple agents

**Check**:

1. Agents being properly cleaned up
2. Stream sessions ending correctly
3. Memory cleanup intervals running

#### Problem: Slow agent responses

**Check**:

1. Network latency to Auggie
2. System prompt complexity
3. Number of concurrent agents

### IPC Communication Issues

#### Problem: "IPC channel not found" errors

**Cause**: Handler not registered or wrong channel name
**Solution**: Verify handler registration:

```typescript
// main-process handler registration
ipcMain.handle('agent:create', async (event, data) => {
  // ... create the agent
});
```

#### Problem: IPC timeout errors

**Cause**: Long-running operations blocking main process
**Solution**: Use streaming or break into smaller operations

### Build Issues

#### Problem: Build fails with module errors

**Solution**:

```bash
# Clean and rebuild
rm -rf node_modules dist
pnpm install
pnpm run build
```

#### Problem: "Cannot find module electron" in production

**Cause**: Electron not bundled correctly
**Solution**: Check `electron-builder.yml` configuration

#### Problem: Stale or corrupt Vite dep-optimization cache in dev

**Symptoms**: Missing-dependency errors or `504 (Outdated Optimize Dep)` in the renderer after `pnpm run dev`
**Cause**: `node_modules/.vite` (the Vite dep-optimization cache, reused for fast warm starts) is out of date or corrupt
**Solution**: Force a one-off re-optimization, then return to normal dev runs:

```bash
# One-off forced re-optimization (vite dev --force)
pnpm run dev:renderer:force

# Or simply clear the cache and start dev normally
rm -rf node_modules/.vite
pnpm run dev
```

## Debugging Tools

### Browser DevTools

```javascript
// Enable verbose logging
localStorage.setItem('DEBUG', 'agent:*');

// Check agent state
console.log(agentState.sessions);
console.log(agentState.streamingSessions);
```

### Backend Logging

```typescript
// Enable debug mode
process.env.DEBUG = 'backend:*';

// Add custom logging
import { logger } from '@/utils/logger';
logger.debug('Agent operation', { agentId, operation });
```

## Migration Issues

### Problem: IPC channel conflicts

**Symptom**: "Handler already registered"
**Solution**: Use only AGENT_CHANNELS from '$shared/ipc/channels'

### Problem: State not reactive

**Symptom**: UI not updating
**Solution**: Use Svelte 5 runes for component-local state, or Redux selectors/actions for shared application state (see `docs/STATE_MANAGEMENT.md`).

### Problem: Manager singleton issues

**Symptom**: Different manager instances
**Solution**: Always use getInstance() method

## Quick Debugging Commands

```bash
# Check TypeScript errors
pnpm run type-check

# Run tests
pnpm run test

# Clean and rebuild
rm -rf node_modules dist && pnpm install && pnpm run build
```

## Getting Help

1. Check this troubleshooting guide
2. Search existing issues in the repository
3. Ask in #agent-system channel with:
   - Error messages and codes
   - Steps to reproduce
   - System information
   - Relevant code snippets
   - What you've already tried

---

**Version**: 2.0.0 | **Updated**: November 19, 2025
