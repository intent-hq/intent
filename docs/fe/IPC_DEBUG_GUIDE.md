# IPC Debug Guide for AI Agents

## Overview

The Intent app now includes comprehensive IPC (Inter-Process Communication) debugging to help identify and fix missing handlers and validation errors. This system automatically tracks all IPC calls and writes debug information to files that agents can analyze.

## Quick Start

### Check for IPC Issues
```bash
# Show summary of all IPC debug data
pnpm ipc:debug:summary

# List missing handlers with suggestions
pnpm ipc:debug:missing

# Show validation errors
pnpm ipc:debug:errors

# Show file paths
pnpm ipc:debug:path

# Clear debug data
pnpm ipc:debug:clear
```

## Debug Files Location

The system writes debug data to:
- **Debug Log**: `.augment/ipc-debug/ipc-debug.json` - All IPC calls and results
- **Missing Handlers**: `.augment/ipc-debug/missing-handlers.json` - List of unregistered channels
- **Registered Handlers**: `.augment/ipc-debug/registered-handlers.json` - All registered handlers (created on app startup)

## How It Works

### 1. Automatic Tracking
- Every IPC call is automatically tracked
- Validation errors are logged with full details
- Missing handlers are detected and recorded
- Success/failure status is tracked for each call

### 2. Debug Information Structure

#### Missing Handlers File
```json
{
  "timestamp": "2024-11-20T15:30:00.000Z",
  "count": 3,
  "channels": [
    "workspace:pr:generate",
    "ssh:test_connection",
    "vscode:open"
  ],
  "suggestions": {
    "workspace:pr:generate": "Check src/features/workspace/main/workspace.ipc.ts",
    "ssh:test_connection": "Check src/features/ssh/main/ssh.ipc.ts",
    "vscode:open": "Check src/features/ide/main/ide.ipc.ts"
  }
}
```

#### Debug Log Entry
```json
{
  "timestamp": "2024-11-20T15:30:00.000Z",
  "channel": "workspace:create",
  "type": "validation_error",
  "data": { "name": 123 },
  "error": "Expected string, received number",
  "stack": "..."
}
```

## Common Issues and Fixes

### 1. Missing Handler
**Error**: `No handler registered for channel 'workspace:pr:generate'`

**Fix**:
1. Create handler file: `src/features/workspace/main/workspace-pr.ipc.ts`
2. Register handler in the file
3. Import and call setup function in `src/main/index.ts`

### 2. Validation Error
**Error**: `Expected object, received string`

**Fix**:
1. Check the channel's schema in the handler file
2. Update schema to accept the correct data type
3. Or fix the caller to send correct data format

### 3. Handler Not Being Called
**Debug Steps**:
1. Check if handler is registered: `pnpm ipc:debug:missing`
2. Check for validation errors: `pnpm ipc:debug:errors`
3. Verify handler is imported in `src/main/index.ts`

## Creating New IPC Handlers

### Step 1: Create Handler File
```typescript
// src/features/myfeature/main/myfeature.ipc.ts
import { ipcMain } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../../../main/ipc-validation-middleware';

const MyRequestSchema = z.object({
  workspaceId: z.string(),
  data: z.string()
});

export function setupMyFeatureIPC() {
  ipcMain.handle(
    'myfeature:action',
    createValidatedHandler(MyRequestSchema, async (event, data) => {
      // Handler logic here
      return { success: true };
    }, 'myfeature:action') // Pass channel name for debugging
  );
}
```

### Step 2: Register in Main Process
```typescript
// src/main/index.ts
import { setupMyFeatureIPC } from '../features/myfeature/main/myfeature.ipc';

// In app.whenReady()
setupMyFeatureIPC();
```

### Step 3: Regenerate the Preload Allowlist

The preload channel allowlist (`ALLOWED_CHANNELS` in `src/preload/index.ts`) is generated — do not hand-edit it. After registering the channel, regenerate:

```bash
pnpm run generate:ipc-channels
```

## Debugging Workflow

1. **Run the app** with debug mode:
   ```bash
   pnpm dev:cdp
   ```

2. **Trigger the problematic action** in the UI

3. **Check for issues**:
   ```bash
   pnpm ipc:debug:summary
   ```

4. **Fix missing handlers**:
   ```bash
   pnpm ipc:debug:missing
   ```
   Follow the suggestions to create/register handlers

5. **Fix validation errors**:
   ```bash
   pnpm ipc:debug:errors
   ```
   Update schemas or fix data format

6. **Verify fixes**:
   - Restart the app
   - Trigger the action again
   - Check debug summary

## Tips for AI Agents

1. **Always check IPC debug first** when encountering IPC-related errors
2. **Use the suggestions** in missing-handlers.json to locate where to add handlers
3. **Check validation errors** for data format mismatches
4. **Clear debug data** periodically to avoid confusion with old errors
5. **Export handler info** is created on app startup in development mode
6. **Track patterns** - similar channel names usually go in the same feature directory

## Integration with Error Tracking

IPC errors are also tracked in the main error tracking system:
```bash
# Check general errors including IPC
pnpm run agent-errors summary
```

This provides additional context and stack traces for debugging.
