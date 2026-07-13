# Stabilization

Self-hosted development — stabilize the forked app while using it for daily work.

## Goal + Self-Hosting Premise

**00_initial_porting** was developed entirely with the reference app (`augmentcode/intent`). **01_stabilizing** is the **self-hosting phase** — `intentd` + `cloudlands-fe` is now the development environment used to build the next version of itself.

Stabilize the forked app while running it for all daily work. Bugs found while self-hosting are the primary work source, and every fix shipped through the app is itself a validation of the app.

## Process — The Dogfooding Loop

Observe a bug → file it in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) with a repro → triage (P0 crash/data-loss, P1 broken feature, P2 papercut) → fix in the owning submodule via the standard Phase 1/Phase 2 PR workflow → mark fixed with the PR link.

1. **Discover** — encounter a bug while dogfooding (self-hosted planning, delegation, fixes, PRs)
2. **File** — document in KNOWN_ISSUES.md with id `STAB-N`, date, area, severity, repro, status
3. **Triage** — severity determines urgency:
   - **P0** — crash, data-loss, or corruption; blocks shipping to external users
   - **P1** — broken feature; app still usable but with significant workaround required
   - **P2** — papercut; annoying but does not block workflows
4. **Fix** — land via the standard commit/PR workflow (Phase 1 → Phase 2):
   - Phase 1: scoped commits in the owning submodule (intentd / cloudlands-fe / ios) on a feature branch → push → file PR → merge (squash merge preferred)
   - Phase 2: pull latest main in the updated submodule → stage the submodule ref change in the monorepo → commit → push → file monorepo PR → merge
5. **Close** — mark fixed in KNOWN_ISSUES.md with the PR link and resolution date

## Fix Conventions

- Fixes land as **`fix:`** conventional-commit PRs in the owning repo (`intent-hq/intentd`, `intent-hq/cloudlands-fe`, `intent-hq/ios`)
- **Regression coverage** expected with each fix:
  - **intentd**: `make check` + `make test` green
  - **cloudlands-fe**: `pnpm run check` + `pnpm vitest run` green
  - **ios**: build + test targets passing
- Prefer minimal, focused fixes over refactors — address the reported issue directly
- Document the fix in the submodule PR description with a link back to the KNOWN_ISSUES.md entry

## Exit Criteria — Public Release Readiness

The app is ready for **public release** when:

- **No open P0/P1 issues** — all crashes, data-loss, and broken-feature bugs are resolved
- **Sustained self-hosted development** — the team uses the app for planning, delegation, fixes, and PRs without falling back to the reference app (`augmentcode/intent`) or other IDEs for any workflow
- **No shipping blockers** — no known issues that would prevent releasing the app to external users with confidence

## Non-Goals

This phase is stabilization only. Not in scope:

- **New features** — no net-new capabilities beyond what 00_initial_porting delivered
- **Further protocol expansion** — the JSON-RPC surface is frozen unless a bug fix requires a method addition
- **Remote/iOS feature work** — bug fixes only; no new remote-workspace capabilities or iOS features (WSS-over-SSH and iOS companion-app polish are deferred to later efforts)
- **Performance optimization** — unless performance is a P0/P1 blocker (e.g., UI freezes, 10s+ operation latencies)

## Tracking

All issues are tracked in [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) in this directory.

See also:
- [00_initial_porting/BREADCRUMBS.md](../00_initial_porting/BREADCRUMBS.md) — the initial port's progress log (read-only; no new breadcrumbs entries during 01_stabilizing)
- [00_initial_porting/IMPLEMENTATION_SPEC.md](../00_initial_porting/IMPLEMENTATION_SPEC.md) — the target architecture
- [00_initial_porting/PROTOCOL.md](../00_initial_porting/PROTOCOL.md) — the wire contract
- [../README.md](../README.md) — documentation index
