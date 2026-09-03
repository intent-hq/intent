# Browser Panel Implementation Spec

## Overview

Add an embedded browser feature to the Intent app that allows users to:
1. Enter URLs and view web pages in the main content area
2. Access recent URLs quickly from the sidebar
3. Navigate and inspect pages from a compact, responsive toolbar
4. Preview responsive layouts with fit, device-preset, and custom viewport modes
5. Attach a page screenshot or selected DOM element to the next agent message

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
├── browser-slice.ts           # Recent URLs, zoom requests, pending browser captures
├── browser-selectors.ts       # Workspace-scoped browser selectors
└── browser-types.ts           # Recent URL and browser capture contracts

src/lib/components/browser/
├── BrowserPanel.svelte        # Sidebar: URL input + recent list
├── EmbeddedBrowser.svelte     # Webview, toolbar, navigation, and capture orchestration
├── BrowserOverflowMenu.svelte # Secondary tools and narrow-width controls
├── BrowserViewportMenu.svelte # Fit, preset, custom, and rotation controls
├── BrowserDeviceFrame.svelte  # Scaled fixed-size frame and drag resize handle
├── BrowserElementPickerButton.svelte
└── element-picker-*           # Guest-page picker, validation, and capture coordinates
```

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Webview vs iframe | `<webview>` tag | No CORS restrictions, console access, DevTools |
| State management | Redux slice (`src/store/renderer/slices/browser/`) | Matches current state architecture |
| Recent URLs limit | 20 per workspace | Balance between utility and clutter |
| URL validation | URL constructor | Simple, built-in validation |
| Default viewport | Fit panel | Uses all available panel space without a device frame |
| Fixed viewports | Persisted preset/custom mode | Exact CSS dimensions survive layout rehydration |
| Capture delivery | Pending Redux capture consumed by the target chat | Lets the user review/remove context before sending |

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
- Navigation: back, forward, refresh, and editable address
- Loading indicator
- Error handling for failed loads
- Webview partition isolation via `BROWSER_PANEL_PARTITION`
- Protocol allowlist enforcement via `BROWSER_PROTOCOLS.NAVIGATION_ALLOWED`
- Browser zoom controls via `browser:zoom` events
- DevTools Console, Sources, and Elements panel shortcuts
- Focus propagation and browser-specific shortcut handling for the active panel
- Per-tab viewport emulation and an agent-native element picker

#### Toolbar

The toolbar is one 48px row. It shows back, forward, reload, page identity, element
selection, viewport mode, a vertical-kebab overflow menu, and close. The identity is the
page title plus a subdued hostname instead of a permanent URL field. Clicking it, or using
the address shortcut, replaces it with a prefilled `bg-background` input; Enter navigates,
while Escape or blur discards the edit. Agent-owned tabs show the owning agent's live avatar
and state; unowned tabs show the page favicon when available.

The overflow menu contains, in order: Open in external browser, Copy URL, a separator,
Screenshot, Console, Source, Inspector, and Reload without cache. Console errors increment a
badge on the kebab trigger and the count resets on top-level navigation. Console, Source, and
Inspector open the matching Electron DevTools panel, falling back to plain DevTools if panel
selection is unavailable. Screenshot creates a pending chat capture; it does not write to the
clipboard.

Toolbar collapsing is based on the toolbar's own width:
- At 560px and wider, all primary controls and the hostname are visible.
- From 400px through 559px, the hostname is hidden first.
- Below 400px, back/forward, element selection, and viewport mode move to the top of the
  overflow menu. Reload, page title, kebab, and close remain visible.

#### Viewport modes

Viewport mode is persisted per browser tab and absent legacy values resolve to **Fit panel**:
- **Fit panel** fills the available webview area with no fixed frame or letterboxing. Unowned
  tabs use native sizing. Owned tabs remain CDP-emulated at the visible panel bounds; hidden
  owned tabs use their last emulated size or 1280×800 as a fallback.
- **Preset** offers iPhone SE, iPhone 15, Pixel 8, iPad Mini, iPad Pro 11″, 1280×800, and
  1440×900. The page lays out at the exact preset dimensions and scales down, never up, when
  the panel is smaller.
- **Custom** accepts integer width and height values from 320 through 3840 CSS pixels.

Preset and custom modes render a centered device frame with an exact W × H readout. The menu
can rotate fixed dimensions, and dragging the frame's bottom-right handle converts the mode to
custom. An agent `openTab` without dimensions uses Fit panel; explicit `openTab` dimensions or
`resizeTab` select custom mode.

#### Element selection and chat attachment

Select element activates a crosshair picker inside the guest page. Hovering outlines the
candidate and labels its tag and dimensions. Clicking captures the element's visible bounds
and records its page URL, DOM path, CSS selector, text snippet, viewport size, and a best-effort
source reference from framework development metadata. Escape, navigation, or toggling the
control again cancels selection and removes the overlay.

The capture becomes two removable items in the target chat composer: a PNG image and structured
selection context. The focused active agent chat is preferred; if no agent chat is active, an
agent-owned browser tab falls back to its owner. The overflow Screenshot action uses the same
flow for a whole-viewport image. Captures are attached to the next message only after remaining
in the composer; removing either item excludes that image or context from the send.

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
  isActive?: boolean;
  ownerAgentId?: string;
  ownerAgentName?: string;
  viewport?: BrowserTabViewport;
  onViewportChange?: (viewport: BrowserTabViewport) => void;
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

## Phase 2: Browser Inspection

- Implemented: count error-level `console-message` events and surface the count on the overflow
  trigger.
- Implemented: best-effort opening of Console, Sources, or Elements from the overflow menu runs
  `DevToolsAPI.showPanel` inside `devToolsWebContents` after opening DevTools and falls back to
  plain DevTools when panel selection is unavailable.
- Future: capture and stream full console entries for agents.

## Phase 3: Agent Integration

- Implemented: element and viewport screenshots become removable chat-composer context.
- Implemented: selected-element metadata includes DOM path, selector, text, bounds, viewport, and
  best-effort source reference.
- Browser automation for agents remains available through `browser.exec`; richer console capture
  is future work.

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
- [ ] Test: Fit mode tracks both a user tab and an agent-owned tab's visible panel bounds
- [ ] Test: Presets/custom dimensions match `window.innerWidth` and rotate/resize correctly
- [ ] Test: Selecting an element attaches image + DOM/source context to the intended chat
- [ ] Test: Narrow toolbar widths preserve collapsed controls in the overflow menu

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

4. **Keyboard shortcuts**
   - `Cmd/Ctrl+L`: edit the current address.
   - `Cmd/Ctrl+R` or `F5`: refresh the focused browser.
   - `Alt+Left/Right`: navigate back/forward.
   - `Cmd/Ctrl+Shift+C`: copy the current browser URL (default binding).
   - `Cmd+Option+I` on macOS or `Ctrl+Shift+I` elsewhere: toggle DevTools.
   - `Cmd/Ctrl+W`: close the browser tab through the panel system.
   - `Escape`: cancel address editing or active element selection.

Shortcuts are intercepted both from app chrome and inside the guest webview so behavior remains
consistent as focus moves across the panel.
