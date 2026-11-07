# Workspaces App Keyboard Shortcuts Reference

> **Legend:** `Cmd` = ⌘ on Mac, `Ctrl` on Windows/Linux. `Mod` means either depending on platform.
>
> Rows with an **ID** are configurable in Settings → Keyboard Shortcuts. Their chord must match
> `SHORTCUT_DEFAULTS` in cloudlands-fe `src/lib/utils/shortcut-bindings.ts`; `make check-keybindings-doc`
> checks this. To move a shortcut, see [Moving a shortcut](#moving-a-shortcut).

---

## 🌐 Global / App-Wide

| Shortcut         | Action                        | Context                          | ID                           |
| ---------------- | ----------------------------- | -------------------------------- | ---------------------------- |
| `Mod+K`          | Open Command Palette          | Anywhere (not in terminal)       | `global.command-palette-alt` |
| `Mod+T`          | Open Blank Working Panel      | In workspace                     | `navigation.new-tab`         |
| `Mod+Alt+A`      | New Agent                     | In workspace                     | `workspace.new-agent`        |
| `Mod+Alt+N`      | New Note                      | In workspace                     | `workspace.new-note`         |
| `Mod+Alt+T`      | New Terminal                  | In workspace                     | `workspace.new-terminal`     |
| `Mod+Alt+B`      | New Browser                   | In workspace with browser panels | `workspace.new-browser`      |
| `Mod+P`          | Quick Open (file picker)      | Anywhere (not in terminal)       |                              |
| `Mod+Shift+P`    | Open Command Palette          | Anywhere (not in terminal)       | `global.command-palette`     |
| `Mod+,`          | Open Settings                 | Anywhere                         | `global.settings`            |
| `Mod+O`          | Toggle All Spaces             | Anywhere                         | `global.toggle-spaces`       |
| `Mod+N`          | New Workspace                 | Anywhere (not in inputs)         | `global.new-space`           |
| `Mod+?`          | Toggle Keyboard Shortcuts     | Anywhere                         | `global.keyboard-shortcuts`  |
| `Mod+F`          | Search                        | Focused searchable panel         | `global.search`              |
| `Ctrl+Tab`       | Next Space                    | Anywhere in workspace            | `global.next-space`          |
| `Ctrl+Shift+Tab` | Previous Space                | Anywhere in workspace            | `global.previous-space`      |
| `Mod+Shift+]`    | Next Space (alternate)        | Anywhere in workspace            | `global.next-space-alt`      |
| `Mod+Shift+[`    | Previous Space (alternate)    | Anywhere in workspace            | `global.previous-space-alt`  |
| `Mod+Shift+S`    | Set Workspace Aside           | On a Home workspace row          | `workspace.set-aside`        |
| `Alt+Z`          | Toggle Word Wrap              | In editor                        | `editor.toggle-word-wrap`    |
| `Mod+J`          | Toggle Quake Terminal Overlay | Anywhere                         |                              |
| `Ctrl+\``        | Toggle Quake Terminal Overlay | Anywhere (always Ctrl, even Mac) |                              |
| `Ctrl+Shift+\``  | Create New Terminal           | Anywhere (always Ctrl, even Mac) |                              |
| `Escape`         | Close modal/dialog/cancel     | Various contexts                 |                              |

---

## 🗂️ Panes & Columns

| Shortcut           | Action                                             | Context                                                     | ID                                |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| `Mod+[`            | Select Previous Pane                               | In the active stack, including editors and terminals        | `panel.previous-pane`             |
| `Mod+]`            | Select Next Pane                                   | In the active stack, including editors and terminals        | `panel.next-pane`                 |
| `Mod+W`            | Close Active Pane                                  | In a workspace                                              | `navigation.close-tab`            |
| `Mod+Shift+W`      | Close Workspace Tab                                | In a workspace                                              | `navigation.close-space-tab`      |
| `Mod+Shift+T`      | Reopen Most Recently Closed Pane, Column, or Space | In a workspace                                              | `navigation.reopen-tab`           |
| `Mod+1-9`          | Go to Tab 1–9                                      | In a workspace                                              | `navigation.go-to-tab`            |
| `Mod+Alt+Shift+←`  | Move Space Tab Left                                | In a workspace                                              | `navigation.move-space-tab-left`  |
| `Mod+Alt+Shift+→`  | Move Space Tab Right                               | In a workspace                                              | `navigation.move-space-tab-right` |
| `Mod+Alt+←`        | Focus Previous Column                              | Including editors and terminals; disabled at the left edge  | `panel.focus-previous-column`     |
| `Mod+Alt+→`        | Focus Next Column                                  | Including editors and terminals; disabled at the right edge | `panel.focus-next-column`         |
| `Mod+Alt+PageUp`   | Move Active Pane to Previous Column                | Outside editors and terminals; disabled at the left edge    | `panel.move-pane-previous-column` |
| `Mod+Alt+PageDown` | Move Active Pane to Next Column                    | Outside editors and terminals; disabled at the right edge   | `panel.move-pane-next-column`     |
| `Mod+\`            | Create Column to the Right                         | Including editors and terminals; disabled at four columns   | `panel.create-column-right`       |
| `Mod+Shift+M`      | Toggle Panel Zoom/Maximize                         | In panel                                                    | `panel.maximize`                  |
| `Mod+Shift+C`      | Copy Browser URL                                   | In browser panel                                            | `panel.copy-browser-url`          |

---

## 📍 Focus Navigation (VS Code-style)

| Shortcut      | Action                                                             | Context  | ID                     |
| ------------- | ------------------------------------------------------------------ | -------- | ---------------------- |
| `Mod+B`       | Toggle Workspace Sidebar                                           | Anywhere | `panel.toggle-sidebar` |
| `Mod+O`       | Toggle Spaces Overlay                                              | Anywhere | `global.toggle-spaces` |
| `Mod+Shift+D` | Open Agent Overview                                                | Anywhere |                        |
| `Mod+Shift+E` | Focus File Explorer Tab                                            | Anywhere |                        |
| `Mod+Shift+G` | Focus Git Changes Tab                                              | Anywhere |                        |
| `Mod+Shift+N` | _(reserved)_ New Window — handled by native menu; not bound in-app | —        |                        |
| `Mod+Shift+A` | Focus Activity Tab                                                 | Anywhere |                        |

`Mod`-click on an item that supports adjacent opening keeps its existing open-to-right behavior.

---

## 🎨 Layout Presets

| Shortcut    | Action                    | Context            |
| ----------- | ------------------------- | ------------------ |
| `Mod+Alt+1` | Focus Mode (single panel) | Anywhere           |
| `Mod+Alt+2` | Split View                | Anywhere           |
| `Mod+Alt+3` | Full Layout               | Anywhere           |
| `Mod+Alt+=` | Equalize Panel Sizes      | Multi-panel layout |

---

## 🔤 Leader Key System (tmux/vim-style)

> **Leader Key:** `Mod+;` — Press once, then press action key within 2 seconds

| Key after Leader | Action                            | Notes                 | ID                           |
| ---------------- | --------------------------------- | --------------------- | ---------------------------- |
| `h/j/k/l`        | Navigate Panel Left/Down/Up/Right | vim-style             | `leader.navigate-panels`     |
| `H/J/K/L`        | Resize Panel Left/Down/Up/Right   | vim-style             | `leader.resize-panels`       |
| `o/p`            | Cycle to Next/Previous Panel      | tmux-style            | `leader.next-previous-panel` |
| `%`              | Create Column to Right            | tmux-style            | `leader.split-right`         |
| `z`              | Toggle Panel Zoom                 |                       | `leader.toggle-zoom`         |
| `x`              | Close Panel                       |                       | `leader.close-panel`         |
| `=`              | Equalize All Panel Sizes          |                       | `leader.equalize-sizes`      |
| `q + 1-9`        | Jump to Panel by Number           | `q` shows the numbers | `leader.jump-to-panel`       |
| `Space`          | Cycle Layout Presets              |                       | `leader.cycle-layout`        |

---

## 💬 Chat / Agent

| Shortcut      | Action                         | Context                      | ID                     |
| ------------- | ------------------------------ | ---------------------------- | ---------------------- |
| `Enter`       | Send Message                   | In chat input                | `chat.send`            |
| `Mod+Enter`   | Send Message (force/interrupt) | In chat input                | `chat.force-send`      |
| `Shift+Enter` | Insert New Line                | In chat input                | `chat.new-line`        |
| `/`           | Focus Chat Input               | Not in editable element      | `chat.focus-input`     |
| `@`           | Mention Context                | In chat input                | `chat.mention-context` |
| `Mod+/`       | Enhance Prompt                 | Chat inputs / prompt editors |                        |
| `Mod+↑`       | Navigate to Previous Message   | Not in inputs                |                        |
| `Mod+↓`       | Navigate to Next Message       | Not in inputs                |                        |

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

| Shortcut      | Action                        | Context                           | ID                        |
| ------------- | ----------------------------- | --------------------------------- | ------------------------- |
| `Mod+S`       | Save File                     | In file editor                    | `editor.save`             |
| `Mod+Z`       | Undo                          | In editor                         | `editor.undo`             |
| `Mod+Shift+Z` | Redo                          | In editor                         | `editor.redo`             |
| `Mod+G`       | Go to Line                    | In file editor                    | `editor.go-to-line`       |
| `Mod+C`       | Copy                          | In file editor                    | `editor.copy`             |
| `Mod+A`       | Select All                    | In file editor                    | `editor.select-all`       |
| `Mod+Shift+9` | Toggle Task List              | In note editor                    | `editor.toggle-task-list` |
| `F12`         | Go to Definition              | In code editor (when focused)     |                           |
| `/`           | Open Search                   | In repo visualizer (not in input) |                           |
| `n` / `N`     | Navigate Siblings (next/prev) | In repo visualizer                |                           |
| `Escape`      | Zoom Out One Level            | In repo visualizer (when zoomed)  |                           |

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

---

## Moving a shortcut

`make check-keybindings-doc` runs with the other consumer checks, in the monorepo and on every
cloudlands-fe PR. A cloudlands-fe PR that changes a chord in `SHORTCUT_DEFAULTS` fails it until this
doc agrees. The docs lead the pin:

1. In a monorepo PR, update the row here and add a `PENDING` entry (`from`, `to`, `reason`) for the
   shortcut id in `scripts/check-keybindings-doc.mjs`. The check then accepts the new chord while the
   pin still has the old one.
2. Re-run the cloudlands-fe PR's checks and land it.
3. After the submodule bump, remove the `PENDING` entry (the check warns until you do).

A new shortcut needs a row with its id, or the check fails. Land the row first, in a monorepo PR; the
check only warns about an id the pinned table does not define yet. After a shortcut is removed, drop
its row once the bump lands.
