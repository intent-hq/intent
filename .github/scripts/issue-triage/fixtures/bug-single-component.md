### Description

The sidebar flickers when switching workspaces.

### Reproduction steps

1. Open two workspaces
2. Switch between them quickly

### Expected vs actual

Expected: smooth transition. Actual: visible flicker.

### Component

- [ ] intentd (Rust backend daemon)
- [x] cloudlands-fe (Electron + SvelteKit desktop frontend)
- [ ] ios (SwiftUI companion app)
- [ ] docs / tooling

### Severity

P2 — degraded behavior; should be fixed, but impact is limited

### Agent-filed

- [ ] This issue was filed by an AI agent (the `agent-filed` label is applied automatically)
