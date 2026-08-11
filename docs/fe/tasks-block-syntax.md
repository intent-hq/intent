# Task Block Syntax

This document explains the expected syntax for proposing tasks in the workspace spec, and compares it with what agents sometimes produce incorrectly.

## Target Syntax: `@@@task` Block (Singular)

When an agent wants to propose tasks that should become nested Task Notes, it should use **separate** `@@@task` blocks (singular, not `@@@tasks`).

### Why `@@@task` instead of ` ```task`?

The new `@@@task` syntax avoids conflicts with nested code blocks in task content. When task descriptions contain code examples with triple backticks, the old ` ```task` syntax could cause parsing ambiguities. The `@@@` delimiters are unambiguous and work reliably even with complex nested content.

### Key Rules

1. **One task per block** - Each `@@@task` block contains exactly one task
2. **First `#` heading is the title** - The first h1 heading becomes the task title
3. **Everything below is the body** - All content after the title heading becomes the task body
4. **Multiple tasks = multiple blocks** - For multiple tasks, create multiple `@@@task` blocks

### Correct Format

````markdown
## Tasks

@@@task
# Authentication System
Build JWT-based authentication for the API layer.

## Requirements
- Login/logout endpoints
- Session management with refresh tokens
- Password reset flow
@@@

@@@task
# Database Layer
Set up PostgreSQL with Drizzle ORM.

## Schema
- Users table
- Sessions table
- Migrations setup
@@@
````

### How It Works

1. Each `@@@task` block is parsed independently
2. The first `# Title` heading becomes the task title
3. Everything after that heading becomes the task body
4. When the note is saved, the system:
   - Parses each `@@@task` block
   - Creates a Task Note with the title and body
   - Replaces the `@@@task` block with a linked task checkbox

### Expected Output After Conversion

```markdown
## Tasks

- [ ] [Authentication System](intent://local/task/note-abc123)

- [ ] [Database Layer](intent://local/task/note-def456)
```

---

## What Agents Sometimes Write Instead (Incorrect)

### Problem: Empty Tasks Section

```markdown
## Tasks

## Design Reference
```

**Issue**: The agent wrote a `## Tasks` header but left it empty, with no `@@@task` blocks.

### Problem: Plain Markdown Lists

```markdown
## Tasks

- Authentication System
- Database Layer
- API Endpoints
```

**Issue**: Plain bullet lists are not recognized as task proposals. They're just text.

### Problem: Regular Checkboxes

```markdown
## Tasks

- [ ] Authentication System
- [ ] Database Layer
```

**Issue**: Regular checkboxes are not automatically converted to Task Notes. Use `@@@task` blocks instead.

### Problem: Using `tasks` (plural) instead of `task` (singular)

````markdown
@@@tasks
# Task One
...
# Task Two
...
@@@
````

**Issue**: The old `@@@tasks` (plural) syntax is deprecated. Use individual `@@@task` blocks instead.

---

## Comparison Table

| Syntax | Creates Task Notes? | Supports Rich Content? |
|--------|---------------------|------------------------|
| `@@@task` block (one per task) | ✅ Yes | ✅ Yes (body below title) |
| `- [ ] Task Name` (no marker) | ❌ No | N/A |
| Plain bullet list | ❌ No | N/A |
| Empty section | ❌ No | N/A |
| `@@@tasks` (plural, deprecated) | ❌ No | N/A |

---

## Debugging

### Check if content has task blocks

```typescript
import { hasTaskBlocks } from '../features/notes/utils/task-block-parser';

const content = note.content;
console.log('Has task blocks:', hasTaskBlocks(content));
```

### Extract tasks from blocks

```typescript
import { extractTasksBlocks } from '../features/notes/utils/task-block-parser';

const result = extractTasksBlocks(content);
console.log('Block count:', result.blockCount);
console.log('Valid tasks:', result.validTaskCount);
console.log('Invalid blocks:', result.invalidBlockCount);
console.log('Tasks found:', result.tasks);
// Each task has: { title: string, content: string }
```

---

## Robustness

The parser handles these edge cases for `@@@task` syntax:

- **Trailing whitespace**: `@@@task   ` (with spaces/tabs after `task`) is accepted
- **Windows line endings**: Both `\n` and `\r\n` are supported
- **Empty titles**: `#    ` (whitespace-only title) is rejected as invalid
- **Content before title**: Any text before the first `# Title` is ignored
- **Multiple `#` headings**: Only the first `# Title` is the task title; subsequent ones are part of the body
- **`##` and `###`**: These are NOT treated as titles (only single `#` works)

Invalid blocks are replaced with `<!-- invalid-task-block-removed -->` comment.

---

## Agent Instructions Reference

The agent instructions should specify:

> Use `@@@task` blocks to propose tasks with rich context:
> - Write **one task per block**
> - Use the first `# Title` heading for the task title
> - Add detailed context, requirements, and acceptance criteria in the body
> - When saved, each block is automatically converted to a linked Task Note
