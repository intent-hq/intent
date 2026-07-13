# Known Issues

Live issue tracker for the **01_stabilizing** self-hosting phase.

## Intake Convention

Each issue entry includes:

- **ID** — `STAB-N` sequential numbering
- **Date** — when discovered (YYYY-MM-DD)
- **Area** — component/subsystem (e.g., `intentd note persistence`, `cloudlands-fe chat UI`, `ios sync`)
- **Severity** — P0 (crash/data-loss), P1 (broken feature), P2 (papercut)
- **Repro** — minimal steps to reproduce
- **Status** — `open` | `fixed (PR link, date)`

---

## Open Issues

### STAB-1 (2026-07-13, area: intentd note persistence, severity: P1)

Concurrent note writes fail with JSON-RPC `-32603` `internal error: insert note_version failed: error returned from database: (code: 5) database is locked`.

**Repro:** Issue ~5 parallel `note.edit` or `note.update` calls against different notes in one workspace (e.g., via `Promise.all` in the workspace_api MCP tool). Some writes fail with SQLITE_BUSY surfaced as `-32603`.

**Expected:** Writes are serialized or retried daemon-side (busy_timeout / retry-on-busy), never surfacing SQLITE_BUSY to the client. Sequential retry succeeds.

**Status:** open

### STAB-2 (2026-07-13, area: cloudlands-fe UI — workspace timeline/feed, severity: P2)

The "workspace start" indicator renders at the bottom of the workspace view instead of marking the chronological beginning of the workspace.

**Repro:** Open a workspace with multiple activity items and locate the workspace start indicator. Observed while self-hosting: in a workspace whose first activity was the "Scaffold docs/01_stabilizing" work, the start indicator appeared way down at the bottom of the feed rather than at the top where the workspace began.

**Expected:** The indicator anchors the beginning of the workspace (before/at the first item), regardless of feed ordering.

**Status:** open

### STAB-3 (2026-07-13, area: intentd PR↔workspace linking, severity: P1)

An open PR whose head branch exactly matches the workspace branch is never linked to the workspace.

**Repro:** In a workspace on branch X, file a PR with head X via `gh`, wait >2 minutes, call `pr.status`. Observed while self-hosting: monorepo PR #98 was filed with head branch `any-fix` for the workspace on branch `any-fix`; well beyond several 60s background-refresh cycles, `pr.status` still returns `-32603` "No active PR", no `pr:linked` event is emitted, and the FE PR panel keeps showing "Create PR" instead of the open PR.

**Expected:** The 60s background + on-demand PR refresh matches the PR by `head.ref` (branch-only matching per BREADCRUMBS Milestone 4 Cycle B), persists `activePullRequest`/`prStatus`, emits `pr:linked`, and the `pr.*` surface + FE PR panel reflect the open PR.

**Status:** open

---

## Carried Over from 00_initial_porting

These items were genuinely open/deferred in [../00_initial_porting/BREADCRUMBS.md](../00_initial_porting/BREADCRUMBS.md) and remain as stabilization tasks:

### Transport panic-safety

**Area:** intentd transport  
**Severity:** P1  
**Description:** Currently relies on per-connection `tokio::spawn` isolation. Should use `catch_unwind` → `-32603` to guarantee a panicked request handler never brings down the daemon or other connections.  
**Status:** open

### Real auggie e2e in CI

**Area:** intentd CI  
**Severity:** P2  
**Description:** A real auggie turn in CI is best-effort/local only (requires auggie + login). The hermetic mock-agent E2E is the CI gate; the generated `--mcp-config` + bridge are auggie-consumable, but CI has no live auggie coverage.  
**Status:** open (best-effort/local only)

### PR↔workspace matching — branch-only

**Area:** intentd sourcecontrol  
**Severity:** P2  
**Description:** PR↔workspace matching is **branch-only** (`head.ref`) vs the reference TS branch-OR-`baseRef` match. This is an accepted deferral from Milestone 4 — Cycle B, but may surface as a papercut if workspaces don't link when expected.  
**Status:** open (intentional divergence, may revisit)

### `pr.*` single-page reads / capability gating

**Area:** intentd sourcecontrol  
**Severity:** P2  
**Description:** `pr.*` reads stay single-page (the separately-addressed `github.*` list reads gained real pagination in Milestone 11). Capability gating is deferred — no runtime detection of whether the active PR supports certain operations.  
**Status:** open (intentional deferral)

### Agent-Id / Linked-Note-Id commit trailers

**Area:** intentd git  
**Severity:** P2  
**Description:** Git commits lack `Agent-Id` and `Linked-Note-Id` trailers (no agent context at the UDS layer yet). Reference TS backend added these trailers for audit/provenance.  
**Status:** open (intentional deferral from Milestone 4)

### REV-2 — Explicit reverse-dispatch target selection

**Area:** intentd transport  
**Severity:** P2  
**Description:** REV-1 first-client-sticky reverse dispatch is an interim single-client policy while an explicit target-selection surface (REV-2 / PROTOCOL §16 client identity) is designed. Agent-initiated `browser.exec` currently goes to the first-connected client only.  
**Status:** open (design in progress)

---

## Fixed Issues

_(none yet — first fixes will appear here with PR links and resolution dates)_
