## Problem

When prompted to 'create a task', agents may not know which method to use:
- `@@@task` blocks in notes (auto-converts to task notes)
- Task management tools (`add_tasks`, `update_tasks`)
- Direct task note creation via `ws.note.create`

This can lead to:
- Using the wrong method for the context
- Duplicating content instead of linking
- Missing the auto-conversion feature of `@@@task` blocks

## Solution

Added a clear decision tree to the 'Creating Tasks' section in `workspace.md`:

1. **For tasks in the spec or notes** → Use `@@@task` blocks (auto-converts to task notes)
2. **For conversation-level task tracking** → Use task management tools
3. **Direct task note creation** → Rarely needed; prefer `@@@task` blocks

Also added emphasis that `@@@task` is the **preferred method** for planning/spec tasks.

## Changes

- Updated `crates/intent-services/resources/agent-instructions/workspace.md`
- Added decision tree at the top of 'Creating Tasks' section
- Clarified when each method should be used
- Emphasized `@@@task` as the preferred method for spec tasks

## Testing

This is a documentation-only change to agent instructions. No code changes, no tests needed.
