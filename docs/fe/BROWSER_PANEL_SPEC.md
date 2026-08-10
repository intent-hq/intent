# Browser Panel Implementation Spec

## Overview

Add an embedded browser feature to the Intent app that allows users to:
1. Enter URLs and view web pages in the main content area
2. Access recent URLs quickly from the sidebar
3. Toggle embedded DevTools from the browser toolbar; future work can add richer console capture for agents

## Current State

### What Exists
- Third-party sources feature - Persists external references (Linear, GitHub, etc.) but not integrated in new sidebar
- `mainContentType` includes `'browser'` - Main content area has conditional for browser type
- `webviewTag: true` enabled in Electron's BrowserWindow config

### Implemented Components
- `BrowserPanel.svelte` - Sidebar panel for URL input and recent URLs
- `EmbeddedBrowser.svelte` - Main content component using Electron's `<webview>` tag
- `src/store/renderer/slices/browser/` - Redux slice for browser state (recent URLs etc.)
- Browser sidebar and main-panel integration are wired into the workspace layout

## Architecture

### File Structure
```
src/features/browser/
├── types.ts                   # BrowserSession, RecentUrl types

src/store/renderer/slices/browser/
├── browser-slice.ts           # State: recent URLs, current session

src/lib/components/browser/
├── BrowserPanel.svelte        # Sidebar: URL input + recent list
├── EmbeddedBrowser.svelte     # Main content: webview component
```

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Webview vs iframe | `<webview>` tag | No CORS restrictions, console access, DevTools |
| State management | Redux slice (`src/store/renderer/slices/browser/`) | Matches current state architecture |
| Recent URLs limit | 20 per workspace | Balance between utility and clutter |
| URL validation | URL constructor | Simple, built-in validation |

## Phase 1: Core Browser Feature

### 1.1 Browser State (`src/store/renderer/slices/browser/browser-slice.ts`)

> Originally implemented as `browser.store.svelte.ts`; state has since moved to the Redux `browser` slice.

```typescript
interface RecentUrl {
  url: string;
  title?: string;
  favicon?: string;
  lastVisited: string; // ISO timestamp
}

interface BrowserState {
  recentUrls: RecentUrl[];
  currentUrl: string | null;
  isLoading: boolean;
}
```

**Features (slice actions):**
- `addRecentUrl(url, title?)` - Adds URL, deduplicates, maintains max 20
- `removeRecentUrl(url)` - Removes single URL
- `clearRecentUrls()` - Clears all
- `setCurrentUrl(url)` - Sets active URL
- Persists to localStorage per workspace: `browser-recent-${workspaceId}`

### 1.2 Browser Panel (`src/lib/components/browser/BrowserPanel.svelte`)

Sidebar component for the `WorkspaceDetailSidebar`.

**UI Elements:**
- URL input field with Enter-to-submit
- Recent URLs list using `ListContainer`/`ListItem`
- Delete button (×) on hover for each URL
- Clear all button in header

**Props:**
```typescript
interface Props {
  workspaceId: string;
  onOpenUrl: (url: string) => void;
  class?: string;
}
```

### 1.3 Embedded Browser (`src/lib/components/browser/EmbeddedBrowser.svelte`)

Main content component using Electron's webview.

**Features:**
- Navigation: back, forward, refresh, home
- URL bar with current URL display
- Loading indicator
- Error handling for failed loads
- Webview partition isolation via `BROWSER_PANEL_PARTITION`
- Protocol allowlist enforcement via `BROWSER_PROTOCOLS.NAVIGATION_ALLOWED`
- Browser zoom controls via `browser:zoom` events
- Embedded DevTools toggle (`webview.openDevTools()` / `closeDevTools()`)
- Focus propagation and browser-specific shortcut handling for the active panel

**Webview Events to Handle:**
- `did-start-loading` / `did-stop-loading` - Loading state
- `did-navigate` / `did-navigate-in-page` - URL updates
- `page-title-updated` - Title for recent URLs
- `page-favicon-updated` - Favicon for recent URLs
- `did-fail-load` - Error handling

**Props:**
```typescript
interface Props {
  url: string;
  workspaceId: string;
  tabId?: string;
  onNavigate?: (url: string) => void;
  onClose?: () => void;
  onTitleChange?: (title: string) => void;
  onFaviconChange?: (faviconUrl: string) => void;
  onFocus?: () => void;
  focusUrlBarOnMount?: boolean;
  isFocused?: boolean;
}
```

### 1.4 Integration Points

**WorkspaceDetailSidebar.svelte:**
- Add `BrowserPanel` as a collapsible section (similar to Notes)
- Place between Notes and Files/Changes toggle
- Add `onOpenUrl` prop and handler

**Main Content Area (WorkspaceContent or page.svelte):**
- Handle `open-url-in-browser` event from sidebar
- Set `mainContentType = 'browser'` and `currentBrowserUrl`
- Render `EmbeddedBrowser` when type is 'browser'

**Event Flow:**
```
BrowserPanel (sidebar)
    ↓ onOpenUrl(url)
WorkspaceDetailSidebar
    ↓ dispatches 'open-url-in-browser' event
+page.svelte
    ↓ sets mainContentType='browser', stores URL
Main Content Area
    ↓ renders EmbeddedBrowser with URL
```

## Phase 2: Console Capture (Future)

- Capture console logs via `console-message` event
- Create `BrowserConsolePanel.svelte` for log display
- Filter logs by level (log, warn, error, info, debug)

## Phase 3: Agent Integration (Future)

- MCP tools: `browser_get_console_logs`, `browser_screenshot`, `browser_execute_js`
- DOM inspection for agents
- Screenshot with annotation support

## Implementation Tasks

### Phase 1 Checklist (historical)

#### Implementation (completed)

- [x] Create `src/features/browser/types.ts`
- [x] Create browser state store (originally `browser.store.svelte.ts`, since moved to the Redux `browser` slice)
- [x] Create `src/lib/components/browser/BrowserPanel.svelte`
- [x] Create `src/lib/components/browser/EmbeddedBrowser.svelte`
- [x] Add BrowserPanel to `WorkspaceDetailSidebar.svelte`
- [x] Wire up event handling in `+page.svelte`
- [x] Update main content rendering for browser type
- [x] Enable `webviewTag: true` in BrowserWindow config

#### Verification (pending/manual)

- [ ] Test: URL input opens in main panel
- [ ] Test: Recent URLs persist across sessions
- [ ] Test: Navigation controls work (back/forward/refresh)
- [ ] Test: Sites that block iframes load correctly

## UI Design Notes

- Follow existing sidebar patterns (Notes section structure)
- Use `ListContainer`/`ListItem` for recent URLs
- Use shadcn `Input` for URL field
- Use Font Awesome icons (`faGlobe`, `faArrowLeft`, `faArrowRight`, `faRefresh`)
- Subtle, sleek Vercel-like aesthetic
- Collapsible section header matching Notes pattern

## Open Questions

1. **Should browser panel be always visible or collapsible?**
   - Recommendation: Collapsible, starts collapsed

2. **How to handle multiple browser tabs/sessions?**
   - Phase 1: Single session, URL replaces previous
   - Future: Tab support if needed

3. **Should recent URLs sync across workspaces?**
   - Recommendation: No, keep per-workspace for context relevance

4. **Keyboard shortcuts?**
   - `Cmd+L` to focus URL bar (when browser panel focused)
   - Standard nav: `Alt+Left/Right` for back/forward
