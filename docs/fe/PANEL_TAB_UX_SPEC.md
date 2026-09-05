# Panel & Tab System UX Specification

A comprehensive guide to implementing a powerful, intuitive panel and tab management system.

---

## Core Concepts

### Layout Model
- **Panels**: Containers that hold one or more tabs
- **Tabs**: Individual content views within a panel
- **Splits**: Horizontal divisions between panels — the layout is a single row of 1–4 side-by-side columns; there are no vertical (top/bottom) splits
- **Layout Tree**: A single horizontal root split whose children are panels (one per column)

---

## Tab Interactions

### 1. Tab Selection
| Action | Behavior |
|--------|----------|
| Click tab | Activate tab in current panel |
| Middle-click tab | Close tab |
| Cmd/Ctrl+click | Keep current tab, open in background (if applicable) |

### 2. Tab Reordering (Within Panel)
| Action | Behavior |
|--------|----------|
| Drag tab left/right | Reorder within tab bar |
| Visual feedback | Drop indicator line between tabs |
| Animation | Smooth slide of adjacent tabs |

### 3. Tab Movement (Across Panels)
| Action | Behavior |
|--------|----------|
| Drag tab to another panel's tab bar | Move tab to that panel |
| Drag tab to panel center | Move tab to that panel (same as above) |
| Drag tab to panel edge | Create new split, place tab in new panel |

### 4. Tab Close Behaviors
| Action | Behavior |
|--------|----------|
| Close button / Middle-click | Close single tab |
| Close tab with unsaved changes | Prompt to save/discard |
| Close last tab in panel | Close panel |
| Right-click → "Close Others" | Close all tabs except this one |
| Right-click → "Close to the Right" | Close all tabs to the right |
| Right-click → "Close All" | Close all tabs in panel |

---

## Panel Splitting

### 5. Split Creation Methods

#### Via Drag-to-Edge
When dragging a tab near a panel edge, show the relevant drop zone:

```
┌──────┬─────────────┬────────┐
│      │             │        │
│ LEFT │   CENTER    │ RIGHT  │  ← Left/Right: new column on that side (horizontal split)
│      │             │        │
└──────┴─────────────┴────────┘
```

- **Edge zones**: ~20% of panel width from the left and right edges. There are no top/bottom zones — the layout only splits horizontally, up to 4 columns
- **Center zone**: Move tab to this panel (no split)
- **Visual feedback**: Highlight the target zone with overlay. animate the overlay between states.

#### Via Panel Menu
- "Split Right" → Horizontal split, empty panel on right (no-op at the 4-column limit)
- "Duplicate Tab in Split" → Split + clone current tab

#### Via Keyboard
See [Keyboard Shortcuts Reference](#keyboard-shortcuts-reference) below.

---

## Panel Resizing

### 6. Resize Handle Behavior
| Interaction | Behavior |
|-------------|----------|
| Drag handle | Resize adjacent panels proportionally |
| Double-click handle | Reset to 50/50 split |
| Drag while holding Shift | Snap to increments (25%, 33%, 50%, etc.) |
| Minimum size | Panels cannot shrink below ~100px |
| Collapse threshold | If panel shrinks below minimum, offer to close it |

### 7. Resize Visual Feedback
- Handle highlights on hover
- During drag: show size overlay (e.g., "35% / 65%")
- Cursor changes to `col-resize` or `row-resize`

---

## Panel Navigation

### 8. Focus Management
See [Keyboard Shortcuts Reference](#keyboard-shortcuts-reference) below for navigation shortcuts.

### 9. Visual Focus Indicators
- Focused panel: subtle border highlight or header emphasis
- Unfocused panels: slightly dimmed or neutral styling
- Active tab within focused panel: clear visual distinction

---

## Advanced Features

### 11. Panel Maximization
| Action | Behavior |
|--------|----------|
| Double-click panel header | Toggle maximize (shrink other panels to minimum size) |
| `Cmd+Shift+M` | Maximize/restore focused panel |
| Click outside maximized panel | Restore all panels |

### 13. Layout Presets & Memory
- Save current layout as a preset ("Code Review", "Writing", "Debugging")
- Quick switch between presets via menu or keyboard
- Remember last layout per workspace
- Reset to default layout option
- Have some hard-coded presets like "Initial", "Code Review", "Debugging" that are auto-saved and can be switched between quickly.
- add a top bar above the panels that also has a prompt box that sends a message asking an agent for a layout recommendation. The agent will look at the current context and suggest a layout. We can use it like we use an agent for code review or generating a commit message. We should tell it the syntax to use, tell it to end its response with <layout> tag, and we should parse its response to get the layout. TFigure out hte idea ui & ux.

---

## Drag & Drop Affordances

### 15. Drag States & Feedback

| State | Visual |
|-------|--------|
| Drag start | Tab becomes semi-transparent, cursor shows drag icon |
| Over tab bar | Gap opens between tabs at drop position |
| Over drop zone | Zone highlights, preview of resulting split |
| Invalid drop | Cursor shows "no drop" indicator |
| Drag end (success) | Smooth animation to final position |
| Drag end (cancel) | Tab animates back to original position |

### 16. External Drag Sources
- Drag file from sidebar → Creates file tab in target panel
- Drag note from sidebar → Creates note tab in target panel
- Drag agent from sidebar → Opens agent in target panel
- Drag from OS file explorer → Opens file (if applicable)

---

## Edge Cases & Behaviors

### 17. Empty Panels
| Scenario | Behavior |
|----------|----------|
| Close last tab | Close panel |
| Drag to empty panel | Tab becomes only tab in panel |

### 18. Single Panel Mode
- When only one panel exists, hide split handles
- Dragging tab to edges still creates new splits
- Maximized panel hides all chrome

### 19. Deep Nesting Protection
- Limit split nesting depth (e.g., max 4-5 levels)
- When limit reached, move to nearest valid location
- Warn user if layout becomes too complex

### 20. Layout Persistence
- Auto-save layout on every change (debounced)
- Store tab content identifiers, not content itself
- Handle missing content gracefully (show "Tab content not found")
- Migrate layout versions across app updates

---

## Accessibility

### 21. Keyboard Navigation
See [Keyboard Shortcuts Reference](#keyboard-shortcuts-reference) for complete bindings.

Basic accessibility navigation:
| Key | Action |
|-----|--------|
| `Tab` | Move focus between major regions |
| `Arrow keys` | Navigate within focused region |
| `Enter` | Activate focused element |
| `Escape` | Cancel current operation |
| `F6` | Cycle through panel regions |

### 22. Screen Reader Support
- Panels: `role="region"` with `aria-label`
- Tabs: `role="tablist"` / `role="tab"` with proper labels
- Announce: "Panel 1 of 3", "Tab 2 of 5, active"
- Resize handles: `role="separator"` with `aria-orientation`

### 23. Reduced Motion
- Respect `prefers-reduced-motion`
- Skip animations, use instant transitions
- Keep visual feedback for drop zones (no animation needed)

---

## Implementation Priority

Current implementation note: `PanelTabBar.svelte` already supports inline rename on double-click in addition to the completed checklist items below.

### Phase 1: Foundation
1. ✅ Basic tab bar with click-to-activate
2. ✅ Panel split/resize with handles
3. ✅ Tab reordering within panel (drag)
4. ✅ Tab close button + middle-click

### Phase 2: Cross-Panel
5. ✅ Drag tab to another panel's tab bar
6. ⬜ Drag tab to panel edge → create split
7. ✅ Drop zone visualization
8. ✅ Panel focus management + keyboard nav (implemented in `src/features/layout/panel-keyboard-shortcuts.svelte.ts`; panel swap is still a TODO in code)

### Phase 3: Polish
9. ✅ Panel maximize/restore
10. ✅ Tab context menu (Close Others, etc.)
11. ⬜ Layout presets
12. ⬜ Accessibility audit + screen reader testing

### Phase 4: Advanced
13. ⬜ Tab groups / multi-select
14. ⬜ Panel pinning
15. ⬜ External drag sources
16. ⬜ Touch/mobile support

---

## Keyboard Shortcuts Reference

Designed to feel familiar to developers who use tmux, vim, VS Code, and terminal emulators.

### Design Principles
1. **Prefix-based for power users** — Like tmux's `Ctrl+B` prefix, we use `Cmd+;` as a leader key for panel operations (tmux-style; avoids conflict with the `Cmd+K` command palette)
2. **Vim-style directional** — `h/j/k/l` for navigation when in panel mode
3. **VS Code compatibility** — Common shortcuts like `Cmd+\` and `Cmd+W` work as expected
4. **Discoverability** — Single-key shortcuts after prefix, shown in command palette

### Leader Key: `Cmd+;` (Mac) / `Ctrl+;` (Windows/Linux)
Like tmux's `Ctrl+B`, entering the leader key activates "panel mode" for the next keypress.

> **Note:** [KEYBINDINGS.md](./KEYBINDINGS.md) is the authoritative reference for what is actually bound today; the tables below are the design spec.

---

### Panel Navigation

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+; h` | Focus panel to the left | vim `Ctrl+W h` |
| `Cmd+; j` | Focus panel below | vim `Ctrl+W j` |
| `Cmd+; k` | Focus panel above | vim `Ctrl+W k` |
| `Cmd+; l` | Focus panel to the right | vim `Ctrl+W l` |
| `Cmd+; Cmd+;` | Toggle between last two focused panels | tmux `Ctrl+B ;` |
| `Cmd+; o` | Cycle to next panel | tmux `Ctrl+B o` |
| `Cmd+; 1-9` | Focus panel by index | tmux `Ctrl+B 0-9` |
| `Cmd+Option+←/→` | Focus prev/next panel (quick) | VS Code |

### Panel Splitting

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+\` | Split right (new column, max 4) | VS Code |
| `Cmd+; %` | Split right | tmux `Ctrl+B %` |
| `Cmd+; !` | Move current tab to new panel | tmux `Ctrl+B !` (pane→window) |

The layout is horizontal-only (1–4 columns); there is no "split down" chord.

### Panel Resizing

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+; H` | Resize panel left (shrink right edge) | vim `Ctrl+W <` |
| `Cmd+; J` | Resize panel down (grow bottom edge) | vim `Ctrl+W +` |
| `Cmd+; K` | Resize panel up (shrink bottom edge) | vim `Ctrl+W -` |
| `Cmd+; L` | Resize panel right (grow right edge) | vim `Ctrl+W >` |
| `Cmd+; =` | Equalize all panel sizes | vim `Ctrl+W =` |
| `Cmd+; _` | Maximize panel height | vim `Ctrl+W _` |
| `Cmd+; \|` | Maximize panel width | vim `Ctrl+W \|` |

### Panel Zoom/Maximize

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+; z` | Toggle zoom (maximize/restore) | tmux `Ctrl+B z` |
| `Cmd+Shift+M` | Toggle maximize focused panel | VS Code |
| `Escape` | Exit zoom mode | — |

### Panel Management

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+; x` | Close current panel | tmux `Ctrl+B x` |
| `Cmd+; {` | Swap panel with previous (TODO in code) | tmux `Ctrl+B {` |
| `Cmd+; }` | Swap panel with next (TODO in code) | tmux `Ctrl+B }` |
| `Cmd+; Space` | Cycle through layout presets | tmux `Ctrl+B Space` |
| `Cmd+; q` | Show panel numbers (press 1-9 to jump) | tmux `Ctrl+B q` |

---

### Tab Navigation

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+Shift+]` | Next tab in panel | VS Code / Chrome |
| `Cmd+Shift+[` | Previous tab in panel | VS Code / Chrome |
| `Cmd+Option+→` | Next tab | Chrome |
| `Cmd+Option+←` | Previous tab | Chrome |
| `Ctrl+Tab` | Next tab (cycle) | Browser standard |
| `Ctrl+Shift+Tab` | Previous tab (cycle) | Browser standard |
| `Cmd+1-9` | Jump to tab by index | Chrome / VS Code |

### Tab Management

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+W` | Close current tab | Universal |
| `Cmd+Shift+W` | Close all tabs in panel | — |
| `Cmd+Shift+T` | Reopen last closed tab | Chrome |
| `Cmd+; Cmd+W` | Close all other tabs | VS Code |
| `Cmd+; w` | Close tabs to the right | VS Code |

### Tab Movement

| Shortcut | Action | Inspired By |
|----------|--------|-------------|
| `Cmd+; m` | Move tab to next panel | — |
| `Cmd+; Shift+M` | Move tab to previous panel | — |
| `Cmd+; ←/→` | Move tab left/right within panel | — |
| `Cmd+; Shift+←` | Move tab to panel on left | — |
| `Cmd+; Shift+→` | Move tab to panel on right | — |

---

### Quick Reference Card

```
┌─────────────────────────────────────────────────────────────────┐
│  PANEL SYSTEM SHORTCUTS (Leader: Cmd+;)                         │
├─────────────────────────────────────────────────────────────────┤
│  NAVIGATE          SPLIT             RESIZE          TABS       │
│  ─────────         ─────             ──────          ────       │
│  h/j/k/l  focus    Cmd+\   right     H/J/K/L  edges  Cmd+1-9    │
│  o        cycle    %       right     =        equal  Cmd+Shift+]│
│  1-9      index                      z        zoom   Cmd+W close│
│  Cmd+;    last                       _/|      max    Cmd+Shift+T│
│                                                       reopen    │
├─────────────────────────────────────────────────────────────────┤
│  x  close panel    {/}  swap    Space  cycle layouts    q  show#│
└─────────────────────────────────────────────────────────────────┘
```

---

### Comparison with Familiar Tools

| Operation | tmux | vim | VS Code | Our App |
|-----------|------|-----|---------|---------|
| **Prefix/Leader** | `Ctrl+B` | `Ctrl+W` | — | `Cmd+;` |
| **Split horizontal** | `Ctrl+B %` | `:vsplit` | `Cmd+\` | `Cmd+\` or `Cmd+; %` |
| **Split vertical** | `Ctrl+B "` | `:split` | `Cmd+K Cmd+\` | — (horizontal-only layout) |
| **Navigate left** | `Ctrl+B ←` | `Ctrl+W h` | `Cmd+K ←` | `Cmd+; h` |
| **Navigate right** | `Ctrl+B →` | `Ctrl+W l` | `Cmd+K →` | `Cmd+; l` |
| **Navigate up** | `Ctrl+B ↑` | `Ctrl+W k` | `Cmd+K ↑` | `Cmd+; k` |
| **Navigate down** | `Ctrl+B ↓` | `Ctrl+W j` | `Cmd+K ↓` | `Cmd+; j` |
| **Zoom/maximize** | `Ctrl+B z` | — | — | `Cmd+; z` |
| **Close pane** | `Ctrl+B x` | `:q` | — | `Cmd+; x` |
| **Next pane** | `Ctrl+B o` | `Ctrl+W w` | — | `Cmd+; o` |
| **Last pane** | `Ctrl+B ;` | `Ctrl+W p` | — | `Cmd+; Cmd+;` |
| **Equalize sizes** | — | `Ctrl+W =` | — | `Cmd+; =` |
| **Close tab** | — | `:bd` | `Cmd+W` | `Cmd+W` |
| **Next tab** | `Ctrl+B n` | `:bn` | `Cmd+Shift+]` | `Cmd+Shift+]` |
| **Prev tab** | `Ctrl+B p` | `:bp` | `Cmd+Shift+[` | `Cmd+Shift+[` |

---

### iTerm2-Style Shortcuts (Alternative Bindings)

For users who prefer iTerm2's approach:

| Shortcut | Action |
|----------|--------|
| `Cmd+D` | Split right |
| `Cmd+]` | Next panel |
| `Cmd+[` | Previous panel |
| `Cmd+Option+Arrow` | Navigate to panel in direction |
| `Cmd+Shift+Enter` | Maximize/restore panel |

---

## Reference Implementations

Study these for inspiration:
- **tmux**: Prefix-based workflow, session/window/pane hierarchy, zoom with `Ctrl+B z`
- **vim**: `Ctrl+W` prefix for window commands, `h/j/k/l` navigation, powerful splits
- **VS Code**: `Cmd+K` chord system, excellent discoverability, smooth animations
- **iTerm2**: `Cmd+D` splits, `Cmd+]`/`[` navigation, simple and memorable
- **Figma**: Excellent drag feedback and split creation
- **JetBrains IDEs**: "Goto Next Splitter" action, configurable keymaps
- **Arc Browser**: Creative tab organization (spaces, pinning, split view)
