# Enhanced Error Handling System

## Overview

The Intent app now features a comprehensive error handling system designed to make debugging easier and enable seamless integration with AI agents for troubleshooting.

## Key Features

### 1. Error Console (Removed)

The floating Error Console UI (previously toggled with `Ctrl+Shift+E`) has been removed; `Mod+Shift+E` is now bound to Focus Explorer. Errors surface through toast notifications and the error handler's subscription API described below.

### 2. Enhanced Error Notifications

- **Quick Actions**:
  - **Copy**: Formats error for debugging
  - **Agent**: Sends error directly to AI agent
  - **Retry**: Attempts automatic recovery (if recoverable)
- **Auto-dismiss**: Info messages disappear after 5 seconds
- **Smart Suppression**: Filters out non-critical errors (ResizeObserver warnings, Monaco disposal/rejection noise, bits-ui cleanup errors, and Svelte effect depth errors)

### 3. Error Reporter Utility

- **Comprehensive Context Collection**:
  - Browser information (name, version, platform)
  - Performance metrics (memory usage, uptime)
  - Recent user actions (clicks, navigation, form submissions)
  - Current route and workspace information
- **Multiple Output Formats**:
  - Markdown (for documentation)
  - JSON (for telemetry)
  - Agent-optimized prompts

### 4. Agent Integration

- **Direct Error Submission**: Send errors to agents with one click
- **Contextual Prompts**: Automatically generates helpful prompts including:
  - Error details and stack trace
  - Recent user actions
  - Environment information
  - Specific help requests
- **Metadata Tracking**: Errors sent to agents include source tracking

## Usage Guide

### For Users

#### Copying Errors for Debugging

1. Click the "Copy" button on any error notification
2. The error will be formatted as markdown with full context

#### Sending Errors to Agents

1. Click the "Agent" button on the error toast
2. An agent will be launched with:
   - Pre-filled error context
   - Recent actions leading to the error
   - Automatic submission enabled

### For Developers

#### Error Tracking

```typescript
import { errorHandler } from '$lib/utils/error-handler.svelte';

// Handle an error
errorHandler.handleError(error, {
  component: 'MyComponent',
  action: 'fetchData',
  userId: currentUser.id,
});

// Handle a warning
errorHandler.handleWarning('API rate limit approaching');

// Handle info
errorHandler.handleInfo('Data sync completed');
```

#### Reactive subscription model

- `ErrorHandler` no longer uses Svelte `$state` runes internally.
- It keeps plain internal arrays and notifies UI subscribers via `subscribe(callback)`.
- This callback-based pattern avoids creating reactive dependencies during module initialization, which helps prevent `effect_update_depth_exceeded` loops.

#### Svelte error resolution

When an error message contains a Svelte docs URL (for example `https://svelte.dev/e/...`), the error handler uses `svelte-error-resolver.ts` to turn it into a richer, developer-friendly message.

- `isSvelteErrorUrl(message)` detects Svelte error URLs.
- `resolveSvelteError(message)` returns structured `SvelteErrorInfo` metadata.
- `formatSvelteError(message)` builds the expanded display text shown in the UI.
- Toast notifications are rendered via `showErrorToast()` from `error-toast.ts`.

#### Custom Error Reports

```typescript
import { errorReporter } from '$lib/utils/error-reporter';

// Generate a custom report
const report = errorReporter.generateReport(error, {
  workspaceId: 'ws-123',
  agentId: 'agent-456',
  recentActions: [{ action: 'save_file', timestamp: '2024-01-01T12:00:00Z' }],
});

// Use different formats
console.log(report.markdown); // For documentation
console.log(report.json); // For telemetry
console.log(report.agentPrompt); // For AI assistance
```

#### Action Tracking

```typescript
import { errorReporter } from '$lib/utils/error-reporter';

// Track custom actions
errorReporter.trackAction('custom_action', {
  details: 'User performed custom action',
  metadata: { key: 'value' },
});
```

## Error Categories

The system automatically categorizes errors:

- **Network Error**: Connection issues, fetch failures
- **Authentication Error**: Auth failures, unauthorized access
- **Permission Denied**: Access control issues
- **File System Error**: File/directory operations
- **Connection Error**: SSH, WebSocket issues
- **API Error**: Endpoint failures
- **Application Error**: General application errors

## Suppressed Errors

The following errors are automatically suppressed to reduce noise:

1. **ResizeObserver**: "ResizeObserver loop completed with undelivered notifications"
2. **Svelte Effects**: `effect_update_depth_exceeded` / `svelte.dev/e/effect_update_depth_exceeded`
3. **Monaco Editor**: disposal, cancellation, and related unhandled rejection noise handled by `shouldSuppressMonacoUnhandledRejection()`
4. **bits-ui cleanup**: component-unmount cleanup errors such as `.current is not a function` and minified `*.call is not a function` variants

## Enhanced Context

Each error includes:

### Browser Information

- User agent
- Browser name and version
- Platform
- Online status

### Performance Metrics

- Memory usage (used/total/limit)
- Time since page load
- Application uptime

### Recent Actions

- Last 20 user interactions
- Navigation events
- Button clicks
- Form submissions

### Stack Trace Enhancement

- Highlights Svelte components
- Marks dependency code
- Improves readability

## Best Practices

### For Error Handling

1. Always provide context when handling errors
2. Use appropriate error types (error, warning, info)
3. Mark errors as recoverable when automatic retry is possible
4. Include component names for easier debugging

### For Agent Integration

1. Errors sent to agents include full context automatically
2. Agents receive formatted markdown for better parsing
3. Recent actions help agents understand user flow
4. Stack traces are limited to relevant portions

### For Production

1. Telemetry integration ready (sendTelemetry method)
2. Error logs are capped at 100 entries to prevent memory issues
3. Sensitive information should be filtered from context
4. Production builds suppress console logging

## Architecture

### Components

- `src/lib/utils/error-handler.svelte.ts`: Core error handling logic (`handleError`/`handleWarning`/`handleInfo`) and callback-based subscriptions
- `src/lib/utils/error-reporter.ts`: Report generation and formatting
- `src/lib/utils/error-toast.ts`: Toast UI used for interactive error notifications
- `src/lib/utils/monaco-error-suppression.ts`: Utility for suppressing known Monaco disposal/rejection noise
- `src/lib/utils/svelte-error-resolver.ts`: Resolves Svelte error URLs into structured `SvelteErrorInfo` output

### Data Flow

1. Error occurs → Global handlers capture it
2. Error is enhanced with context
3. Error is categorized and stored
4. UI components react to error state
5. User can interact (copy, send to agent, retry)

## Testing Errors

To test the error handling system:

```javascript
// In browser console
throw new Error('Test error message');

// Or trigger through the app
errorHandler.handleError(new Error('Test error'), {
  test: true,
  component: 'TestComponent',
});
```

## Future Enhancements

- [ ] Error grouping by similarity
- [ ] Persistent error storage across sessions
- [ ] Error frequency analysis
- [ ] Automatic error reporting to backend
- [ ] Integration with monitoring services
- [ ] Smart error recovery suggestions
- [ ] Error replay functionality

## Troubleshooting

### Errors Not Captured

- Verify global handlers are set up
- Check if error is being suppressed
- Ensure error handler is initialized

### Agent Integration Issues

- Verify agentLauncher is available
- Check workspace context is set
- Ensure agent service is running

## Summary

The enhanced error handling system provides:

1. **Better Visibility**: Toast notifications and subscription-based error tracking
2. **Easy Sharing**: One-click copy/send to agents
3. **Rich Context**: Comprehensive error information
4. **Smart Features**: Auto-suppression, categorization, recovery
5. **Agent Ready**: Optimized for AI debugging assistance

This system significantly improves the debugging experience and makes it easier to get help from AI agents when issues occur.
