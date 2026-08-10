# Intent Link Handler

## Overview

The intent link handler enables internal navigation using `intent://` protocol links. This allows agents and users to create clickable links to notes that work in both chat messages and note editors.

## URL Format

```
intent://local/note/{note-id}
intent://local/task/{note-id}
intent://local/workspace/{workspace-id}
intent://local/{workspace-id}/note/{note-id}
intent://local/{workspace-id}/task/{note-id}
```

### Components

- **Protocol**: `intent://`
- **Org ID**: `local` (placeholder for future organization support)
- **Workspace Segment**: Optional. When present (and the second segment is `note` or `task`), the link targets a specific workspace
- **Resource Type**: `note`, `task`, or `workspace`
- **Resource ID**: The backing note ID for `note`/`task` links (e.g., `spec`, task UUIDs, other note IDs), or the workspace ID for `workspace` links

### Examples

```markdown
[Spec Note](intent://local/note/spec)
[Task Note](intent://local/task/550e8400-e29b-41d4-a716-446655440000)
[Meeting Notes](intent://local/note/meeting-2024-01-15)
[UUID Note](intent://local/note/550e8400-e29b-41d4-a716-446655440000)
[Workspace](intent://local/workspace/my-workspace-id)
[Cross-Workspace Note](intent://local/workspace-123/note/spec)
[Cross-Workspace Task](intent://local/workspace-123/task/550e8400-e29b-41d4-a716-446655440000)
```

## Implementation

### Core Module

**File**: `src/lib/utils/workspaces-link-handler.ts`

**Exports**:

- `parseIntentLink(url: string)` - Parse an intent:// URL
- `generateNoteLink(noteId: string, workspaceId?: string)` - Deprecated compatibility wrapper around `noteUrl()`
- `handleIntentLink(url: string)` - Navigate to an intent:// URL
- `createIntentLinkClickHandler()` - Create a Tiptap click handler

**Preferred helpers**:

- `noteUrl(noteId, workspaceId?)` from `$shared/constants/intent-links`
- `taskNoteUrl(noteId)` from `$shared/constants/intent-links` for current-workspace task links
- `workspaceUrl(workspaceId)` / `workspaceLink(text, workspaceId)` from `$shared/constants/intent-links` for workspace links

### Integration Points

Link clicks are now centralized in the unified link handler (`src/features/navigation/link-handler.ts`), which handles intent:// links alongside other URL types.

1. **MarkdownViewer.svelte** (Chat)
   - Intercepts clicks on intent:// links in chat messages
   - Uses `createIntentLinkClickHandler()` in `editorProps.handleClick`

2. **editor-config.ts** (Notes Editor, `src/lib/utils/editor-config.ts`)
   - Intercepts clicks on intent:// links in note editor
   - Checks for intent:// links before other click handlers

## Behavior

### Successful Navigation

When a valid intent:// link is clicked:

1. URL is parsed to extract org-id, optional workspace-id, resource type, and resource ID
2. `note` and `task` links both resolve to note records (task notes are regular notes with task metadata)
3. The system checks whether the target note exists in the current or specified workspace
4. If needed, the app navigates to the target workspace first and opens the note there
5. If the note doesn't exist, the user sees an error toast

### Error Handling

- **Invalid URL format**: Shows toast with error message
- **Note not found**: Shows "Note not found in current workspace" toast
- **Cross-workspace note not found**: Shows which workspace ID was checked
- **Workspace not found**: Shows "Workspace {id} not found" toast
- **No workspace open for short-form links**: Shows "No space is currently open" toast
- **Unknown resource type**: Shows "Cannot handle {type} links yet" toast

### Implemented navigation modes

- Current-workspace notes: `intent://local/note/{note-id}`
- Current-workspace task notes: `intent://local/task/{note-id}`
- Workspace links: `intent://local/workspace/{workspace-id}`
- Cross-workspace notes: `intent://local/{workspace-id}/note/{note-id}`
- Cross-workspace task notes: `intent://local/{workspace-id}/task/{note-id}`

## Testing

### Test Files

- `src/lib/utils/workspaces-link-handler.test.ts` - Unit tests (15 tests)
- `src/lib/utils/workspaces-link-handler.integration.test.ts` - Integration tests (9 tests)

### Running Tests

```bash
# Run all workspaces link handler tests
pnpm test src/lib/utils/workspaces-link-handler --run

# Run with verbose output
pnpm test src/lib/utils/workspaces-link-handler --run --reporter=verbose
```

### Test Coverage

- ✅ URL parsing (valid and invalid formats)
- ✅ Link generation
- ✅ Task link parsing
- ✅ Cross-workspace note/task parsing
- ✅ Round-trip parsing/generation
- ✅ Tiptap click handler integration
- ✅ Error handling
- ✅ Edge cases (empty IDs, unknown types, etc.)

## Usage

### For Agents

Agents should generate note links with `noteUrl()` and treat `generateNoteLink()` as a deprecated compatibility wrapper:

```typescript
import { noteUrl, taskNoteUrl, workspaceUrl, workspaceLink } from '$shared/constants/intent-links';

const noteLink = noteUrl('spec');
// Returns: "intent://local/note/spec"

const taskLink = taskNoteUrl('550e8400-e29b-41d4-a716-446655440000');
// Returns: "intent://local/task/550e8400-e29b-41d4-a716-446655440000"

const wsLink = workspaceUrl('my-workspace-id');
// Returns: "intent://local/workspace/my-workspace-id"

// Use in markdown
const markdown = `See the [spec note](${noteLink}) or [task](${taskLink}).`;
const wsMarkdown = workspaceLink('My Workspace', 'my-workspace-id');
// Returns: "[My Workspace](intent://local/workspace/my-workspace-id)"
```

For chat-side rendering, prefer the fenced ` ```workspace ` block (handled by `ChatWorkspaceCard`) so the user sees a live, clickable workspace card with title, repo, branch, and status. Use the workspace markdown link only when you must reference a workspace inline in a sentence.

### For Users

Users can manually create links in markdown:

```markdown
Check out the [spec](intent://local/note/spec) for requirements.
```

## Future Enhancements

### Planned

1. **Organization Support**: Replace `local` placeholder with actual org-id
2. **Additional Resource Types**: Support for files, agents, etc.
3. **Deep Linking**: Link to specific sections within notes

### URL Format Evolution

Future URL formats might look like:

```
intent://example-org/note/spec
intent://example-org/file/src/main.ts
intent://example-org/agent/session-123
intent://example-org/note/spec#section-2
```

## Design Decisions

### Why `local` as Placeholder?

The `local` placeholder reserves the org-id slot in the URL structure without requiring organization infrastructure today. This makes the URLs forward-compatible.

### Why Not OS-Level Protocol Handling?

We chose to handle links at the application level (Tiptap click handlers) rather than OS-level protocol registration because:

- Faster to implement
- No platform-specific code needed
- Works immediately without OS configuration
- Can be upgraded to OS-level later if needed

### Why Fire-and-Forget for Async Handlers?

Tiptap's `handleClick` doesn't support async functions. We call the async handler without awaiting to avoid blocking the UI thread. This is acceptable because:

- Navigation happens quickly
- Errors are shown via toast notifications
- User gets immediate feedback

## Troubleshooting

### Links Not Working

1. Check that the note exists in the current workspace
2. Verify the URL format is correct
3. Check browser console for errors
4. Ensure a workspace is currently open

### Tests Failing

1. Run `pnpm test src/lib/utils/workspaces-link-handler --run`
2. Check for import errors or missing dependencies
3. Verify workspace store is properly mocked in tests
