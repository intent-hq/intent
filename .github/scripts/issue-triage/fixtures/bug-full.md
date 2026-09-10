### Description

The daemon crashes on startup when the config file is missing.

### Reproduction steps

1. Delete ~/.config/intentd/config.toml
2. Run intentd

### Expected vs actual

Expected: daemon starts with defaults. Actual: panic and exit.

### Component

- [x] intentd (Rust backend daemon)
- [ ] cloudlands-fe (Electron + SvelteKit desktop frontend)
- [ ] ios (SwiftUI companion app)
- [x] docs / tooling

### Severity

Urgent — crash, data loss, or corruption; blocks shipping to external users

### Agent-filed

- [x] This issue was filed by an AI agent (the `agent-filed` label is applied automatically)
