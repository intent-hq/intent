# Documentation

Index of the `docs/` tree for the Intent monorepo.

## Architecture — `ARCHITECTURE.md`

**[ARCHITECTURE.md](./ARCHITECTURE.md)** records the durable architecture of the
`intentd` Rust backend: system overview, crate layout and dependency rules,
persistence, transports, and the ACP agent runtime.

## Wire Contract — `PROTOCOL.md`

**[PROTOCOL.md](./PROTOCOL.md)** is the **canonical, versioned wire contract** between
Intent clients (desktop, iOS, CLI) and the Intent backend daemon (`intentd`). It
specifies protocol v2.0 (frozen as of 2026-07-14), covering transport, authentication,
JSON-RPC 2.0 envelope rules, the complete method catalog (280 dispatchable names), event
subscriptions, and error codes. The detailed wire contract from the porting era has been
merged in, making this the single canonical spec. The method surface is enforced by
golden tests in the `intent-transport` crate.

## Initial porting phase — **COMPLETE (historical)**

The **initial port of Intent's backend to a headless Rust daemon** (`intentd`)
completed on **2026-07-13**, with self-hosting cutover: the effort was built entirely
with the reference app (`augmentcode/intent`), and development has since moved onto the
Intent stack (`intentd` + `cloudlands-fe`) itself. The porting chronicle (implementation
spec, porting-era protocol, breadcrumbs log, and supporting notes) has been removed from
the tree; its durable content lives on in [ARCHITECTURE.md](./ARCHITECTURE.md) and
[PROTOCOL.md](./PROTOCOL.md), and the original documents remain available in git
history.

## `01_stabilizing/` — **CONCLUDED**

The **stabilization and hardening phase** ran post-initial-port as file-based issue
tracking (`STABILIZATION.md` + `KNOWN_ISSUES.md`) while development moved onto the
self-hosted Intent stack (`intentd` + `cloudlands-fe`). The phase concluded on
2026-07-22: all open items were migrated to
[GitHub issues](https://github.com/intent-hq/monorepo/issues) and the directory was
removed. Bugs are now filed directly as GitHub issues on `intent-hq/monorepo`.

Durable conventions carried forward from that phase:

- **Severity taxonomy** for triage:
  - **P0** — crash, data-loss, or corruption; blocks shipping to external users
  - **P1** — broken feature; app still usable but with significant workaround required
  - **P2** — papercut; annoying but does not block workflows
- **Regression coverage** expected with each fix:
  - **intentd**: `make check` + `make test` green
  - **cloudlands-fe**: `pnpm run check` + `pnpm vitest run` green
  - **ios**: build + test targets passing

## Workflow

For the agent commit/PR workflow and issue tracking, see the root
[AGENTS.md](../AGENTS.md). Bugs and open work are tracked as
[GitHub issues](https://github.com/intent-hq/monorepo/issues).
