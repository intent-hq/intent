## Phase 2 — Monorepo Update (STAB-6)

Flips STAB-6 to fixed and documents the intentd + cloudlands-fe PRs that resolved it.

### Changes

- Mark STAB-6 as fixed in `docs/01_stabilizing/KNOWN_ISSUES.md` with both PR links and date 2026-07-14
- STAB-7 and STAB-8 entries added to the open issues section
- Submodule gitlinks already at target commits (from earlier PRs):
  - `packages/intentd` @ 4f08634ec52f777efb554b8353a2d0940e444564
  - `packages/cloudlands-fe` @ bcce2dad676ca9887b7dfb931bff40ac7f38b937

### Related PRs

- intentd: https://github.com/intent-hq/intentd/pull/137 (merged 2026-07-14)
- cloudlands-fe: https://github.com/intent-hq/cloudlands-fe/pull/43 (merged 2026-07-14)

### Fixed Issue

**STAB-6**: The cloudlands-fe sidecar watchdog kills the daemon while it is healthy, triggered by intentd store pool exhaustion.

- **intentd fix**: Explicit SQLite pool sizing + acquire timeout with named exhaustion error
- **FE fix**: Sidecar watchdog — system.status probe, 3-strike policy, SIGTERM→SIGKILL escalation

Both fixes ensure health checks don't depend on acquiring a connection from the main SQLite pool and the watchdog has better failure-detection logic.
