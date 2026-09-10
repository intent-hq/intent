### Description

The label bot mislabeled my last issue. Here is what the template produced:

```
### Component

- [x] intentd (Rust backend daemon)
- [ ] cloudlands-fe (Electron + SvelteKit desktop frontend)

### Severity

P0 — crash, data loss, or corruption; blocks shipping to external users

### Agent-filed

- [x] This issue was filed by an AI agent (the `agent-filed` label is applied automatically)
```

That fenced copy above should be ignored by the parser.

### Component

- [ ] intentd (Rust backend daemon)
- [x] cloudlands-fe (Electron + SvelteKit desktop frontend)
- [ ] ios (SwiftUI companion app)
- [ ] docs / tooling

### Severity

P2 — degraded behavior; should be fixed, but impact is limited

### Agent-filed

- [ ] This issue was filed by an AI agent (the `agent-filed` label is applied automatically)
