# Type System Guide for AI Agents

## Overview

The Intent app now has a comprehensive type safety system that prevents type mismatches between backend and frontend. This guide explains how to use it effectively.

## Key Principles

1. **Single Source of Truth**: All shared types are defined in `src/shared/type-system/contracts.ts`
2. **Runtime Validation**: All IPC calls are validated at runtime
3. **Compile-time Safety**: TypeScript ensures type safety at compile time
4. **AI-Friendly Errors**: Errors include clear descriptions and suggested fixes

## Common Tasks

### Adding a New IPC Channel

1. **Define the contract** in `src/shared/type-system/contracts.ts`:

```typescript
export const IpcContracts = {
  'your:channel': {
    request: z.object({
      field1: z.string(),
      field2: z.number().optional(),
    }),
    response: z.object({
      result: z.string(),
      status: z.enum(['success', 'error']),
    }),
  },
  // ... other contracts
};
```

2. **Register the handler** in the main process:

```typescript
import { registerHandler } from '@/shared/type-system/registry';
import { createValidationMiddleware } from '@/shared/type-system/validation';

registerHandler(
  'your:channel',
  createValidationMiddleware('your:channel')(async (event, data) => {
    // data is already validated and typed
    return {
      result: 'processed',
      status: 'success',
    };
  })
);
```

3. **Call from renderer** using type-safe client:

```typescript
import { TypedIpcClient } from '@/shared/generated/ipc-client';

const response = await TypedIpcClient.invoke('your:channel', {
  field1: 'value',
  field2: 42,
});
// response is typed correctly
```

### Checking for Type Errors

Run these commands to validate types:

```bash
# Check all types and handlers
pnpm run type-check

# Check only type contracts
pnpm run type-check:validate

# Check handler registration
pnpm run type-check:handlers

# Generate detailed report
pnpm run type-check:report
```

### Debugging Type Mismatches

When you encounter a type mismatch:

1. **Check the error message** - it will tell you exactly what's wrong:

```
Type validation failed for agent:create.

Errors:
  - workspaceId: Invalid UUID format (expected: UUID, received: "invalid")
  - name: Required field missing
```

2. **Use dev tools** (in development mode):

```javascript
// In browser console
TypeSystem.inspect(); // See all contracts and handlers
TypeSystem.validateHandlers(); // Check registration
TypeSystem.checkType('agent:create', 'request', data); // Validate data
```

3. **Check the contract** in `src/shared/type-system/contracts.ts`

### Common Errors and Fixes

#### Error: Handler not registered

```
IPC handler not registered for channel 'workspace:update'
```

**Fix**: Register the handler in the appropriate `.ipc.ts` file and ensure it's called from `src/main/index.ts`

#### Error: Type mismatch

```
Type mismatch in Agent.status: expected string, got number
```

**Fix**: Update the type in `contracts.ts` to match what's actually being used

#### Error: Unrecognized keys

```
Unrecognized keys in request: extraField
```

**Fix**: Either add the field to the contract or remove it from the request

## Type System Components

### 1. Contracts (`src/shared/type-system/contracts.ts`)

- Defines all shared types using Zod schemas
- Single source of truth for data structures
- Exports TypeScript types inferred from schemas

### 2. Validation (`src/shared/type-system/validation.ts`)

- Runtime validation functions
- Detailed error formatting
- Validation middleware for handlers

### 3. Registry (`src/shared/type-system/registry.ts`)

- Tracks registered IPC handlers
- Validates all required handlers are registered
- Provides registration statistics

### 4. Guards (`src/shared/type-system/guards.ts`)

- Type guard functions for runtime type checking
- Assert functions that throw on invalid types
- Array and partial type guards

### 5. Errors (`src/shared/type-system/errors.ts`)

- Custom error classes with AI-friendly descriptions
- Recovery strategies and suggested fixes
- Detailed error context

### 6. Dev Tools (`src/shared/type-system/dev-tools.ts`)

- Development-time validation tools
- Browser console API for debugging
- Type system inspector

## Best Practices

1. **Always define types in contracts.ts** - Never duplicate type definitions
2. **Use validation middleware** - Always validate IPC data
3. **Run type checks before committing** - The pre-commit hook will enforce this
4. **Generate types after changes** - Run `pnpm run generate:ipc-types`
5. **Check handler registration** - Ensure all channels have handlers
6. **Use type guards** - Validate data at runtime boundaries
7. **Handle validation errors gracefully** - Show user-friendly messages

## Automated Tools

The type system includes several automated tools:

- **Pre-commit hook**: Validates types before allowing commits
- **Build-time validation**: Checks types during build process
- **Type generator**: Creates type-safe IPC wrappers
- **Error tracking**: Automatically tracks type-related errors

## For AI Agents

When working with the codebase:

1. **Always check contracts.ts first** when dealing with shared types
2. **Run type-check after making changes** to ensure consistency
3. **Use the generated client** for type-safe IPC calls
4. **Check error tracking** for type-related issues: `pnpm run agent-errors list`
5. **Validate data before sending** to prevent runtime errors
6. **Use type guards** when receiving external data

Remember: The type system is your friend! It catches errors early and provides clear guidance on how to fix them.
