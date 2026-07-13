# Documentation

Index of the `docs/` tree for the Cloudlands monorepo.

## `00_initial_porting/`

Documents for the **initial port of Intent's backend to a headless Rust daemon**
(`intentd`). Three core documents work together:

- **[IMPLEMENTATION_SPEC.md](./00_initial_porting/IMPLEMENTATION_SPEC.md)** — the
  **target architecture**: crates/modules, persistence, ACP/GitHub/context integration,
  deployment, testing, and the phased plan.
- **[PROTOCOL.md](./00_initial_porting/PROTOCOL.md)** — the **wire contract**: transport,
  the JSON-RPC 2.0 envelope, the full method catalog, events, the permission flow, and
  error codes the backend must reproduce.
- **[BREADCRUMBS.md](./00_initial_porting/BREADCRUMBS.md)** — the **living progress log**:
  what has actually been built so far, what is deferred/planned, the current submodule
  HEAD, and a dated changelog that agents append to as work lands.

Supporting documents:

- **[FE-MIGRATION.md](./00_initial_porting/FE-MIGRATION.md)** — how the Electron +
  SvelteKit frontend was migrated into `intent-hq/cloudlands-fe` and mounted as the
  `packages/cloudlands-fe` submodule.
- **[WSS_OVER_SSH.md](./00_initial_porting/WSS_OVER_SSH.md)** — the surviving FE SSH
  surface and the WSS-over-SSH transport shape for future remote workspaces.

In short: the **spec** is where we're going, the **protocol** is the contract we must
honor, and the **breadcrumbs** are where we are right now.

## Workflow

For the agent commit/PR workflow — and the policy requiring breadcrumbs to be kept
current — see the root [AGENTS.md](../AGENTS.md).
