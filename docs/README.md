# Documentation

Index of the `docs/` tree for the Cloudlands monorepo.

## `00_initial_porting/` — **COMPLETE / FROZEN**

Documents for the **initial port of Intent's backend to a headless Rust daemon**
(`intentd`). This effort is **complete as of 2026-07-13** and the documents are now
**frozen** as historical records. Three core documents work together:

- **[IMPLEMENTATION_SPEC.md](./00_initial_porting/IMPLEMENTATION_SPEC.md)** — the
  **target architecture**: crates/modules, persistence, ACP/GitHub/context integration,
  deployment, testing, and the phased plan.
- **[PROTOCOL.md](./00_initial_porting/PROTOCOL.md)** — the **wire contract**: transport,
  the JSON-RPC 2.0 envelope, the full method catalog, events, the permission flow, and
  error codes the backend must reproduce.
- **[BREADCRUMBS.md](./00_initial_porting/BREADCRUMBS.md)** — the **progress log**
  (frozen): what was built, the final submodule HEADs, and the dated changelog.

Supporting documents:

- **[FE-MIGRATION.md](./00_initial_porting/FE-MIGRATION.md)** — how the Electron +
  SvelteKit frontend was migrated into `intent-hq/cloudlands-fe` and mounted as the
  `packages/cloudlands-fe` submodule.
- **[WSS_OVER_SSH.md](./00_initial_porting/WSS_OVER_SSH.md)** — the surviving FE SSH
  surface and the WSS-over-SSH transport shape for future remote workspaces.

In short: the **spec** is where we're going, the **protocol** is the contract we must
honor, and the **breadcrumbs** are where we are right now.

**Self-hosting cutover achieved**: the 00_initial_porting effort was built entirely with
the reference app (`augmentcode/intent`); as of 2026-07-13, development moves onto intentd
+ cloudlands-fe itself — the IDE now builds the next version of the IDE.

## `01_stabilizing/`

Documents for the **ongoing stabilization and hardening phase**, post-initial-port.
Development now happens on the self-hosted stack (intentd + cloudlands-fe building the
next version of themselves).

- **[STABILIZATION.md](./01_stabilizing/STABILIZATION.md)** — the **dogfooding process**:
  how bugs are discovered, filed, triaged, fixed, and closed; fix conventions; and the
  exit criteria for public release readiness.
- **[KNOWN_ISSUES.md](./01_stabilizing/KNOWN_ISSUES.md)** — the **live issue tracker**:
  all open bugs discovered during self-hosting, with severity (P0/P1/P2), repro steps,
  and status. Agents update this file when bugs are found or resolved, following the same
  docs-only conventional-commit conventions.

## Workflow

For the agent commit/PR workflow — and the policy requiring breadcrumbs to be kept
current — see the root [AGENTS.md](../AGENTS.md).
