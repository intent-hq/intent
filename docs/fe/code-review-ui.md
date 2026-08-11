# Code Review UI Design

## Overview

AI-powered code review for staged changes, integrated into the change timeline and main panel.

---

## Entry Point

**Location:** Change timeline local changes header (next to "View all" button)

**Trigger:** "Review staged" button with magic wand icon
- Clicking initiates review and opens main panel view
- Button transforms into a status pill showing review state:
  - `🔄 Reviewing...` (while streaming)
  - `✓ 3 comments` (completed, shows count)
  - `⚠️ 2 issues` (if critical/important issues found)
  - `✓ Looks good` (no issues)

**Pill behavior:**
- Click to open/focus the review panel
- Shows severity badge if critical issues exist
- Subtle pulse animation while reviewing

---

## Main Panel View

### Layout (top to bottom)

```
┌─────────────────────────────────────────────────┐
│  Header: "Code Review" + status + actions       │
├─────────────────────────────────────────────────┤
│  Change Visualization (same as chat panel)      │
│  [file tree or diff summary graphic]            │
├─────────────────────────────────────────────────┤
│  Summary Card (streams in)                      │
│  "Overall: Looking good with minor suggestions" │
├─────────────────────────────────────────────────┤
│  Comments List, stream in                       │
│  ┌─────────────────────────────────────────┐   │
│  │ 🔴 Critical: SQL injection risk          │   │
│  │    file.ts:42 • Security                 │   │
│  │    [View] [Pin] [Dismiss]                │   │
│  └─────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────┐   │
│  │ 🟡 Important: Missing null check         │   │
│  │    utils.ts:15 • Bug                     │   │
│  └─────────────────────────────────────────┘   │
├─────────────────────────────────────────────────┤
│  Diff View (scrollable, with inline markers)   │
└─────────────────────────────────────────────────┘
```

### Header Bar

- Title: "Code Review"
- Status indicator (reviewing/complete/stale)
- Actions:
  - **Stop** (during review) - stops streaming
  - **Re-run** (after complete) - fresh review
  - **Close** - returns to previous panel content

### Loading State

While streaming:
- Summary card shows skeleton with subtle shimmer
- Status text: "Reviewing your changes..." with typing indicator
- Comments appear one-by-one as they stream in (nice staggered animation), skeleton with 3 when loading
- Stop button prominently visible

---

## Summary Card

**Content:**
- Overall assessment (1-2 sentences)
- Quick stats: `3 files reviewed • 2 issues • 1 suggestion`
- Confidence indicator (optional): "High confidence review"

**States:**
- Loading: Skeleton with shimmer
- Streaming: Text appears word-by-word
- Complete: Full summary visible
- Stale: Dimmed with "Review may be outdated" badge

---

## Comments List

### Comment Card Structure

```
┌──────────────────────────────────────────────────┐
│ 🔴 Critical                              Security │
│ ─────────────────────────────────────────────────│
│ SQL injection vulnerability in user input        │
│                                                  │
│ The query string is concatenated directly...     │
│                                                  │
│ 📍 src/api/users.ts:42                          │
│                                                  │
│ [View in diff] [Pin to chat] [Dismiss]          │
└──────────────────────────────────────────────────┘
```

### Severity Levels (visual distinction)

- **🔴 Critical** - Red accent, prominent
- **🟡 Important** - Yellow/amber accent
- **🔵 Minor** - Blue/subtle accent

### Comment Actions

1. **View in diff** - Scrolls to and highlights the relevant code
2. **Pin to chat** - Adds to agent context (appears in input header)
3. **Dismiss** - Hides comment (can undo), persisted locally

### Filtering

- Filter pills at top: `All (5)` `Critical (1)` `Important (2)` `Minor (2)`
- Dismissed comments hidden by default, toggle to show

---

## Agent Integration

### Pinning Comments

When user pins comment(s):
- Badge appears in chat input header: `📌 2 review comments`
- Clicking badge shows list of pinned comments
- Can unpin from there

### Sending to Agent

When user sends message with pinned comments:
- Full review context included (summary + all comments)
- Pinned comments highlighted in context
- Agent can reference specific comments by location

### Auto-context

If agent drawer is open when review completes:
- Show toast: "Review complete - 3 comments found"
- Don't auto-add to context (user must pin explicitly)


---

## Diff View Integration

### Inline Comment Markers

In the diff view below the comments list:
- Gutter markers at lines with comments
- Click marker to jump to comment in list above
- Hover shows comment preview tooltip

### Code Highlighting

When "View in diff" clicked:
- Smooth scroll to the file/line
- Highlight the relevant lines (yellow flash, then subtle background)
- Comment card stays visible (split view consideration?)

---

## Edge Cases

### No Issues Found

- Summary: "✓ No issues found - your code looks good!"
- Comments section: Empty state with checkmark illustration
- Consider: "Would you like a more thorough review?" option

### Many Comments (>10)

- Virtualized list for performance
- "Show more" pagination
- Consider collapsing by file

### Review Errors

- Network failure: Retry button, cached partial results if any
- Timeout: "Review took too long" with partial results
- Invalid diff: Clear error message

### Empty Staged Changes

- Disable review button
- Tooltip: "Stage changes to review"

---

## Streaming Behavior

### Order of Output

1. Summary streams first (gives immediate feedback)
2. Comments stream one-by-one after summary complete
3. Each comment animates in with subtle slide-up

### Chunk Handling

- Parse streaming output for complete comment blocks
- Don't show partial comments (buffer until complete)
- Summary can show partial (word-by-word streaming)

---

## Data Model

```typescript
interface CodeReview {
  id: string;
  workspaceId: string;
  timestamp: Date;
  status: 'running' | 'complete' | 'error' | 'stale';

  // Snapshot of what was reviewed
  snapshot: {
    stagedFiles: string[];
    commitHashes?: string[];
    baseRef?: string;
  };

  // Results
  summary?: string;
  comments: ReviewComment[];

  // Metadata
  duration?: number;
  agentId?: string;
}

interface ReviewComment {
  id: string;
  severity: 'critical' | 'important' | 'minor';
  category: 'bug' | 'security' | 'api' | 'documentation' | 'other';
  title: string;
  description: string;
  location?: {
    file: string;
    startLine: number;
    endLine?: number;
  };
  confidence: number; // 0-1

  // UI state (local, not from agent)
  dismissed?: boolean;
  pinned?: boolean;
}
```

---

## Implementation Phases

### Phase 1: Core Flow (implemented)
- [x] Review button in change timeline
- [x] Main panel view with loading state
- [x] Stream summary and comments
- [x] Basic comment list UI

### Phase 2: Interactions (implemented)
- [x] View in diff (scroll + highlight)
- [x] Pin to chat functionality
- [x] Dismiss comments
- [x] Filter by severity

### Phase 3: Polish
- [ ] Staleness detection
- [ ] Review history/archives
- [ ] Inline diff markers
- [ ] Keyboard navigation

---

## Open Questions

1. **Should inline diff markers be clickable to add new comments?** (human review feature)
2. **Do we want a "Fix this" button that auto-creates an agent task?**
3. **Should we support reviewing specific files vs all staged?**
4. **What about reviewing commits (not just staged changes)?**
5. **Integration with GitHub PR reviews - sync comments?**
