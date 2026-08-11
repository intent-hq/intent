# Workspaces App Keyboard Shortcuts Reference

> **Legend:** `Cmd` = ⌘ on Mac, `Ctrl` on Windows/Linux. `Mod` means either depending on platform.

---

## 🌐 Global / App-Wide

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+K` | Open Command Palette | Anywhere (not in terminal) |
| `Mod+T` | New Tab (creates new agent) | In workspace |
| `Mod+P` | Quick Open (file picker) | Anywhere (not in terminal) |
| `Mod+Shift+P` | Open Command Palette | Anywhere (not in terminal) |
| `Mod+,` | Open Settings | Anywhere |
| `Mod+O` | Toggle All Spaces | Anywhere |
| `Mod+N` | New Agent | Anywhere (not in inputs) |
| `Mod+?` | Toggle Keyboard Shortcuts | Anywhere |
| `Mod+F` | Search | Focused searchable panel |
| `Ctrl+Tab` | Next Space | Anywhere in workspace |
| `Ctrl+Shift+Tab` | Previous Space | Anywhere in workspace |
| `Alt+Z` | Toggle Word Wrap | In editor |
| `Mod+J` | Toggle Quake Terminal Overlay | Anywhere |
| `Ctrl+\`` | Toggle Quake Terminal Overlay | Anywhere (always Ctrl, even Mac) |
| `Ctrl+Shift+\`` | Create New Terminal | Anywhere (always Ctrl, even Mac) |
| `Escape` | Close modal/dialog/cancel | Various contexts |

---

## 🗂️ Tabs & Panels

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+W` | Close Current Tab | In panel |
| `Mod+Shift+T` | Reopen Last Closed Tab | In panel |
| `Mod+1-9` | Switch to Tab by Index | In panel (1 = first tab; `Mod+1/2/3` may be preempted by focus navigation) |
| `Mod+\` | Split Panel Horizontally | In panel |
| `Mod+Shift+\` | Split Panel Vertically | In panel |
| `Mod+[` | Go Back in Panel History | In panel |
| `Mod+]` | Go Forward in Panel History | In panel |
| `Mod+Shift+[` | Select Previous Tab | In panel (also terminal tabs) |
| `Mod+Shift+]` | Select Next Tab | In panel (also terminal tabs) |
| `Mod+Shift+M` | Toggle Panel Zoom/Maximize | In panel |

---

## 📍 Focus Navigation (VS Code-style)

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+1` | Focus Main Content | Anywhere |
| `Mod+2` | Focus Drawer (sidebar panels) | Anywhere |
| `Mod+3` | Focus Dock (agents/terminals) | Anywhere |
| `Mod+B` | Toggle Workspace Sidebar | Anywhere |
| `Mod+O` | Toggle Spaces Overlay | Anywhere |
| `Mod+Shift+D` | Open Agent Overview | Anywhere |
| `Mod+Shift+E` | Focus File Explorer Tab | Anywhere |
| `Mod+Shift+G` | Focus Git Changes Tab | Anywhere |
| `Mod+Shift+N` | *(reserved)* New Window — handled by native menu; not bound in-app | — |
| `Mod+Shift+A` | Focus Activity Tab | Anywhere |

`Mod+1/2/3` are registered globally for main-content, drawer, and dock focus. Panel-level numeric tab switching still exists, but those focus shortcuts can take precedence depending on where the event is handled.

---

## 🎨 Layout Presets

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+Alt+1` | Focus Mode (single panel) | Anywhere |
| `Mod+Alt+2` | Split View | Anywhere |
| `Mod+Alt+3` | Full Layout | Anywhere |
| `Mod+Alt+=` | Equalize Panel Sizes | Multi-panel layout |
| `Mod+Alt+←` | Shrink Panel | Multi-panel layout |
| `Mod+Alt+→` | Grow Panel | Multi-panel layout |

---

## 🔤 Leader Key System (tmux/vim-style)

> **Leader Key:** `Mod+;` — Press once, then press action key within 2 seconds

| Key after Leader | Action | Notes |
|------------------|--------|-------|
| `h` | Navigate Panel Left | vim-style |
| `j` | Navigate Panel Down | vim-style |
| `k` | Navigate Panel Up | vim-style |
| `l` | Navigate Panel Right | vim-style |
| `Shift+H` | Resize Panel Left | Key is mapped; action handler still TODO |
| `Shift+J` | Resize Panel Down | Key is mapped; action handler still TODO |
| `Shift+K` | Resize Panel Up | Key is mapped; action handler still TODO |
| `Shift+L` | Resize Panel Right | Key is mapped; action handler still TODO |
| `o` | Cycle to Next Panel | tmux-style |
| `p` | Cycle to Previous Panel | tmux-style |
| `%` | Split Right | tmux-style |
| `"` | Split Down | tmux-style |
| `z` | Toggle Panel Zoom | |
| `x` | Close Panel | |
| `=` | Equalize All Panel Sizes | |
| `q` | Show Panel Numbers | For quick jump |
| `1-9` | Jump to Panel by Number | After `q` |
| `m` | Move Tab to Other Panel | |
| `Space` | Cycle Layout Presets | |

---

## 💬 Chat / Agent

| Shortcut | Action | Context |
|----------|--------|---------|
| `Enter` | Send Message | In chat input |
| `Mod+Enter` | Send Message (force/interrupt) | In chat input |
| `Shift+Enter` | Insert New Line | In chat input |
| `Escape` | Stop Agent Generation | During agent response |
| `/` | Focus Chat Input | Not in editable element |
| `Mod+/` | Enhance Prompt | Chat inputs / prompt editors |
| `Mod+↑` | Navigate to Previous Message | Not in inputs |
| `Mod+↓` | Navigate to Next Message | Not in inputs |

---

## 👁️ Follow Mode

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+Shift+F` | Toggle Follow Mode | Anywhere |
| `Mod+Shift+→` | Follow Next Agent | In follow mode |
| `Mod+Shift+←` | Follow Previous Agent | In follow mode |
| `Escape` | Exit Follow Mode | In follow mode |

---

## 🔍 Dock Navigation

| Shortcut | Action | Context |
|----------|--------|---------|
| `Alt+↑` | Previous Dock Item (agent/terminal) | Not in editable element |
| `Alt+↓` | Next Dock Item (agent/terminal) | Not in editable element |
| `Alt+←` | Go Back (main panel history) | Not in editable element |
| `Alt+→` | Go Forward (main panel history) | Not in editable element |

---

## 🌐 Web Browser Panel

| Shortcut | Action | Context |
|----------|--------|---------|
| `Alt+←` | Go Back | In browser panel |
| `Alt+→` | Go Forward | In browser panel |
| `F5` / `Mod+R` | Refresh Page | In browser panel |
| `Escape` | Close Browser | In browser panel |

---

## 📁 File Explorer / Editor

| Shortcut | Action | Context |
|----------|--------|---------|
| `Mod+S` | Save File | In file editor |
| `Mod+Z` | Undo | In editor |
| `Mod+Shift+Z` | Redo | In editor |
| `F12` | Go to Definition | In code editor (when focused) |
| `/` | Open Search | In repo visualizer (not in input) |
| `n` / `N` | Navigate Siblings (next/prev) | In repo visualizer |
| `Escape` | Zoom Out One Level | In repo visualizer (when zoomed) |

---

## 🖥️ Terminal Overlay

| Shortcut | Action | Context |
|----------|--------|---------|
| `Ctrl+\`` | Toggle Terminal Overlay | Anywhere (always Ctrl, even Mac) |
| `Mod+J` | Toggle Terminal Overlay | Anywhere (alternate) |
| `Ctrl+Shift+\`` | Create New Terminal Tab | Anywhere |
| `Mod+Shift+]` | Next Terminal Tab | In terminal overlay |
| `Mod+Shift+[` | Previous Terminal Tab | In terminal overlay |

> ⚠️ **`Cmd+\`` is intentionally NOT used** — it is a reserved macOS shortcut for cycling between application windows.

---

## 📝 Command Palette Navigation

| Shortcut | Action | Context |
|----------|--------|---------|
| `↑` / `↓` | Navigate Items | In command palette |
| `Enter` | Select Item | In command palette |
| `Mod+Enter` | Open in Adjacent Panel | In command palette |
| `Escape` | Clear Search / Close | In command palette |

---

# ⚠️ Audit Notes & Issues

## Potential Conflicts

1. **`Mod+Shift+N`** - Reserved for New Window (handled by the native menu); do not bind it in-app. Use `Ctrl+Shift+\`` for new terminal.

2. **`Mod+Shift+[/]`** - Used for both "Select Previous/Next Tab" AND "Previous/Next Terminal Tab"
   - Context-dependent: panel tabs vs terminal tabs
   - Recommendation: This is acceptable since they're in different contexts

3. **`Escape`** - Overloaded for many purposes (close modal, stop agent, exit follow, zoom out)
   - This is standard behavior and acceptable

4. **`Mod+J`** vs `Ctrl+\`` for terminal** - Duplicate functionality
   - Recommendation: Keep both for discoverability (`Mod+J` is easier, `Ctrl+\`` matches VS Code)

## Reserved OS Shortcuts (DO NOT OVERRIDE)

These shortcuts are reserved by the operating system and **must not** be intercepted by the app.
The `KeyboardShortcutManager` will warn in dev mode if any of these are registered.

| Shortcut | OS | Purpose |
|----------|-----|---------|
| `Cmd+\`` | macOS | Cycle through application windows |
| `Cmd+Tab` | macOS | Application switcher |
| `Cmd+H` | macOS | Hide application |
| `Cmd+Q` | macOS | Quit application |
| `Cmd+Space` | macOS | Spotlight search |
| `Cmd+Shift+3/4/5` | macOS | Screenshots |
| `Ctrl+Tab` | Windows | Task switcher (handled by OS, but safe in Electron) |

## Inconsistencies

1. **Leader key shortcuts are only partially implemented** - Resize actions (`Shift+H/J/K/L`) are parsed by the leader-key mapper, but the handler still logs a TODO instead of resizing panels; swap actions (`{` / `}`) are also still only suggested/TODO.

2. ~~**`Mod+T`** opened the wrong action~~ ✅ **FIXED** - It now dispatches `workspace:new-tab`, which creates a new agent tab.

---

# 💡 Suggested New Keybindings

> **Note**: This section and "Implementation Priority" below are proposals/wishlist items, not reference material for implemented bindings.

## For Developer Familiarity (VS Code-style)

| Shortcut | Suggested Action | Rationale |
|----------|-----------------|-----------|
| `Mod+Shift+O` | Go to Symbol | VS Code standard |
| `Mod+G` | Go to Line | Universal IDE shortcut |
| `Mod+D` | Add Selection to Next Match | VS Code multi-cursor |
| `Mod+Shift+L` | Select All Occurrences | VS Code multi-cursor |
| `F2` | Rename Symbol | Universal IDE shortcut |
| ~~`F12`~~ | ~~Go to Definition~~ | ✅ **Implemented** |
| `Shift+F12` | Find All References | VS Code standard |
| `Mod+.` | Quick Fix / Code Actions | VS Code standard |
| `Mod+/` | Toggle Line Comment | Universal IDE shortcut |
| `Mod+Shift+/` | Toggle Block Comment | Universal IDE shortcut |

## For Power Users (vim/tmux-style)

| Shortcut | Suggested Action | Rationale |
|----------|-----------------|-----------|
| `Mod+Shift+P` → `:` | Open command-line mode | vim-style command entry |
| Leader + `c` | Create new panel | tmux-style (currently missing) |
| Leader + `n` | Next window | tmux-style (alt to `o`) |
| Leader + `&` | Kill panel (with confirmation) | tmux-style |
| Leader + `{` / `}` | Swap panel position | tmux-style (marked TODO) |
| Leader + `[` | Enter copy/scroll mode | tmux-style |

## Quality of Life

| Shortcut | Suggested Action | Rationale |
|----------|-----------------|-----------|
| `Mod+Shift+C` | Copy Full Conversation | Quick export |
| `Mod+Shift+X` | Clear Conversation | Quick reset |
| `Mod+Alt+C` | Copy Last Code Block | Common need |
| `Mod+'` | Toggle Focus Mode | Quick distraction-free mode |
| `Mod+0` | Close All Panels | Clear workspace |
| `Mod+Shift+W` | Close All Tabs in Panel | Batch close |
| `Mod+L` | Clear Terminal | Standard terminal shortcut |
| `Mod+Shift+R` | Restart Agent | Quick reset |

## Agent-Specific

| Shortcut | Suggested Action | Rationale |
|----------|-----------------|-----------|
| `Mod+Shift+Enter` | Send & Keep Focus | Continue typing immediately |
| `Alt+Enter` | Send as Code | Wrap in code block |
| `Mod+Shift+.` | Retry Last Action | Quick iteration |
| `Mod+Shift+,` | Undo Agent Change | Revert file changes |
| `Mod+U` | Show Undo/Redo History | See agent actions |

---

# 📋 Implementation Priority

## High Priority (Missing basics)
- [x] ~~`Mod+G` - Go to line~~ ✅ **Implemented**
- [ ] Toggle comment shortcut (currently unassigned)
- [ ] `Mod+L` - Clear terminal (pass through to xterm)

## Medium Priority (Power user)
- [ ] Complete leader key resize shortcuts (`Shift+H/J/K/L`) — keys are mapped, but the action handler still logs a TODO
- [ ] Complete leader key swap shortcuts (`{` / `}`)
- [x] ~~`F12` - Go to definition~~ ✅ **Implemented**
- [ ] `Shift+F12` - Find all references

## Low Priority (Nice to have)
- [ ] Multi-cursor shortcuts (`Mod+D`, `Mod+Shift+L`)
- [ ] Copy conversation shortcuts
- [ ] Agent-specific shortcuts
