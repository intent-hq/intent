# Workspaces App Keyboard Shortcuts Reference

> **Legend:** `Cmd` = ⌘ on Mac, `Ctrl` on Windows/Linux. `Mod` means either depending on platform.

---

## 🌐 Global / App-Wide

| Shortcut         | Action                        | Context                          |
| ---------------- | ----------------------------- | -------------------------------- |
| `Mod+K`          | Open Command Palette          | Anywhere (not in terminal)       |
| `Mod+T`          | Open Blank Working Panel      | In workspace                     |
| `Mod+P`          | Quick Open (file picker)      | Anywhere (not in terminal)       |
| `Mod+Shift+P`    | Open Command Palette          | Anywhere (not in terminal)       |
| `Mod+,`          | Open Settings                 | Anywhere                         |
| `Mod+O`          | Toggle All Spaces             | Anywhere                         |
| `Mod+N`          | New Agent                     | Anywhere (not in inputs)         |
| `Mod+?`          | Toggle Keyboard Shortcuts     | Anywhere                         |
| `Mod+F`          | Search                        | Focused searchable panel         |
| `Ctrl+Tab`       | Next Space                    | Anywhere in workspace            |
| `Ctrl+Shift+Tab` | Previous Space                | Anywhere in workspace            |
| `Alt+Z`          | Toggle Word Wrap              | In editor                        |
| `Mod+J`          | Toggle Quake Terminal Overlay | Anywhere                         |
| `Ctrl+\``        | Toggle Quake Terminal Overlay | Anywhere (always Ctrl, even Mac) |
| `Ctrl+Shift+\``  | Create New Terminal           | Anywhere (always Ctrl, even Mac) |
| `Escape`         | Close modal/dialog/cancel     | Various contexts                 |

---

## 🗂️ Panes & Columns

| Shortcut             | Action                                             | Context                                                   |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `Mod+PageUp`         | Select Previous Pane                               | In the active stack, outside editors and terminals        |
| `Mod+PageDown`       | Select Next Pane                                   | In the active stack, outside editors and terminals        |
| `Mod+W`              | Close Active Pane                                  | In a workspace                                            |
| `Mod+Shift+T`        | Reopen Most Recently Closed Pane, Column, or Space | In a workspace                                            |
| `Mod+Shift+PageUp`   | Focus Previous Column                              | Outside editors and terminals; disabled at the left edge  |
| `Mod+Shift+PageDown` | Focus Next Column                                  | Outside editors and terminals; disabled at the right edge |
| `Mod+Alt+PageUp`     | Move Active Pane to Previous Column                | Outside editors and terminals; disabled at the left edge  |
| `Mod+Alt+PageDown`   | Move Active Pane to Next Column                    | Outside editors and terminals; disabled at the right edge |
| `Mod+\`              | Create Column to the Right                         | Outside editors and terminals; disabled at four columns   |
| `Mod+Shift+M`        | Toggle Panel Zoom/Maximize                         | In panel                                                  |

---

## 📍 Focus Navigation (VS Code-style)

| Shortcut      | Action                                                             | Context  |
| ------------- | ------------------------------------------------------------------ | -------- |
| `Mod+1`       | Focus Main Content                                                 | Anywhere |
| `Mod+2`       | Focus Drawer (sidebar panels)                                      | Anywhere |
| `Mod+3`       | Focus Dock (agents/terminals)                                      | Anywhere |
| `Mod+B`       | Toggle Workspace Sidebar                                           | Anywhere |
| `Mod+O`       | Toggle Spaces Overlay                                              | Anywhere |
| `Mod+Shift+D` | Open Agent Overview                                                | Anywhere |
| `Mod+Shift+E` | Focus File Explorer Tab                                            | Anywhere |
| `Mod+Shift+G` | Focus Git Changes Tab                                              | Anywhere |
| `Mod+Shift+N` | _(reserved)_ New Window — handled by native menu; not bound in-app | —        |
| `Mod+Shift+A` | Focus Activity Tab                                                 | Anywhere |

`Mod+1/2/3` are registered globally for main-content, drawer, and dock focus.

`Mod`-click on an item that supports adjacent opening keeps its existing open-to-right behavior.

---

## 🎨 Layout Presets

| Shortcut    | Action                    | Context            |
| ----------- | ------------------------- | ------------------ |
| `Mod+Alt+1` | Focus Mode (single panel) | Anywhere           |
| `Mod+Alt+2` | Split View                | Anywhere           |
| `Mod+Alt+3` | Full Layout               | Anywhere           |
| `Mod+Alt+=` | Equalize Panel Sizes      | Multi-panel layout |
| `Mod+Alt+←` | Shrink Panel              | Multi-panel layout |
| `Mod+Alt+→` | Grow Panel                | Multi-panel layout |

---

## 🔤 Leader Key System (tmux/vim-style)

> **Leader Key:** `Mod+;` — Press once, then press action key within 2 seconds

| Key after Leader | Action                   | Notes          |
| ---------------- | ------------------------ | -------------- |
| `h`              | Navigate Panel Left      | vim-style      |
| `j`              | Navigate Panel Down      | vim-style      |
| `k`              | Navigate Panel Up        | vim-style      |
| `l`              | Navigate Panel Right     | vim-style      |
| `o`              | Cycle to Next Panel      | tmux-style     |
| `p`              | Cycle to Previous Panel  | tmux-style     |
| `%`              | Create Column to Right   | tmux-style     |
| `z`              | Toggle Panel Zoom        |                |
| `x`              | Close Panel              |                |
| `=`              | Equalize All Panel Sizes |                |
| `q`              | Show Panel Numbers       | For quick jump |
| `1-9`            | Jump to Panel by Number  | After `q`      |
| `m`              | Move Tab to Other Panel  |                |
| `Space`          | Cycle Layout Presets     |                |

---

## 💬 Chat / Agent

| Shortcut      | Action                         | Context                      |
| ------------- | ------------------------------ | ---------------------------- |
| `Enter`       | Send Message                   | In chat input                |
| `Mod+Enter`   | Send Message (force/interrupt) | In chat input                |
| `Shift+Enter` | Insert New Line                | In chat input                |
| `Escape`      | Stop Agent Generation          | During agent response        |
| `/`           | Focus Chat Input               | Not in editable element      |
| `Mod+/`       | Enhance Prompt                 | Chat inputs / prompt editors |
| `Mod+↑`       | Navigate to Previous Message   | Not in inputs                |
| `Mod+↓`       | Navigate to Next Message       | Not in inputs                |

---

## 👁️ Follow Mode

| Shortcut      | Action                | Context        |
| ------------- | --------------------- | -------------- |
| `Mod+Shift+F` | Toggle Follow Mode    | Anywhere       |
| `Mod+Shift+→` | Follow Next Agent     | In follow mode |
| `Mod+Shift+←` | Follow Previous Agent | In follow mode |
| `Escape`      | Exit Follow Mode      | In follow mode |

---

## 🔍 Dock Navigation

| Shortcut | Action                              | Context                 |
| -------- | ----------------------------------- | ----------------------- |
| `Alt+↑`  | Previous Dock Item (agent/terminal) | Not in editable element |
| `Alt+↓`  | Next Dock Item (agent/terminal)     | Not in editable element |
| `Alt+←`  | Go Back (main panel history)        | Not in editable element |
| `Alt+→`  | Go Forward (main panel history)     | Not in editable element |

---

## 🌐 Web Browser Panel

| Shortcut       | Action        | Context          |
| -------------- | ------------- | ---------------- |
| `Alt+←`        | Go Back       | In browser panel |
| `Alt+→`        | Go Forward    | In browser panel |
| `F5` / `Mod+R` | Refresh Page  | In browser panel |
| `Escape`       | Close Browser | In browser panel |

---

## 📁 File Explorer / Editor

| Shortcut      | Action                        | Context                           |
| ------------- | ----------------------------- | --------------------------------- |
| `Mod+S`       | Save File                     | In file editor                    |
| `Mod+Z`       | Undo                          | In editor                         |
| `Mod+Shift+Z` | Redo                          | In editor                         |
| `F12`         | Go to Definition              | In code editor (when focused)     |
| `/`           | Open Search                   | In repo visualizer (not in input) |
| `n` / `N`     | Navigate Siblings (next/prev) | In repo visualizer                |
| `Escape`      | Zoom Out One Level            | In repo visualizer (when zoomed)  |

---

## 🖥️ Terminal Overlay

| Shortcut        | Action                  | Context                          |
| --------------- | ----------------------- | -------------------------------- |
| `Ctrl+\``       | Toggle Terminal Overlay | Anywhere (always Ctrl, even Mac) |
| `Mod+J`         | Toggle Terminal Overlay | Anywhere (alternate)             |
| `Ctrl+Shift+\`` | Create New Terminal Tab | Anywhere                         |
| `Mod+Shift+]`   | Next Terminal Tab       | In terminal overlay              |
| `Mod+Shift+[`   | Previous Terminal Tab   | In terminal overlay              |

> ⚠️ **`Cmd+\`` is intentionally NOT used** — it is a reserved macOS shortcut for cycling between application windows.

---

## 📝 Command Palette Navigation

| Shortcut    | Action                 | Context            |
| ----------- | ---------------------- | ------------------ |
| `↑` / `↓`   | Navigate Items         | In command palette |
| `Enter`     | Select Item            | In command palette |
| `Mod+Enter` | Open in Adjacent Panel | In command palette |
| `Escape`    | Clear Search / Close   | In command palette |

---

## Reserved OS Shortcuts

These shortcuts are reserved by the operating system and **must not** be intercepted by the app.
The `KeyboardShortcutManager` will warn in dev mode if any of these are registered.

| Shortcut          | OS      | Purpose                                             |
| ----------------- | ------- | --------------------------------------------------- |
| `Cmd+\``          | macOS   | Cycle through application windows                   |
| `Cmd+Tab`         | macOS   | Application switcher                                |
| `Cmd+H`           | macOS   | Hide application                                    |
| `Cmd+Q`           | macOS   | Quit application                                    |
| `Cmd+Space`       | macOS   | Spotlight search                                    |
| `Cmd+Shift+3/4/5` | macOS   | Screenshots                                         |
| `Ctrl+Tab`        | Windows | Task switcher (handled by OS, but safe in Electron) |
