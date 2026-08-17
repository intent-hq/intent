# Documentation

Index of the `docs/` tree for the Intent monorepo.

## Architecture — `ARCHITECTURE.md`

**[ARCHITECTURE.md](./ARCHITECTURE.md)** records the durable architecture of the
`intentd` Rust backend: system overview, crate layout and dependency rules,
persistence, transports, and the ACP agent runtime.

## Wire Contract — `protocol/`

**[protocol/](./protocol/README.md)** is the **canonical, versioned wire contract**
between Intent clients (desktop, iOS, CLI) and the Intent backend daemon (`intentd`):
a living specification covering transport, authentication, JSON-RPC 2.0 envelope
rules, the complete method catalog, event subscriptions, agent streaming, the
permission flow, error codes, and thin-client guidance. It is split into per-section
files with § numbering preserved; [protocol/README.md](./protocol/README.md) carries
the § → file map, and the version history + compatibility policy live in
[protocol/versioning.md](./protocol/versioning.md). The method surface is enforced by
golden tests in the `intent-transport` crate. [PROTOCOL.md](./PROTOCOL.md) remains as
a redirect stub so legacy "PROTOCOL.md §N.M" citations stay meaningful.

## Harness Versioning — `HARNESS.md`

**[HARNESS.md](./HARNESS.md)** explains the harness versioning system: the permanent
creation-time `harnessVersion` / `harnessFeatures` stamp on agent sessions, the
doctrine-vs-reference split, the versioned `Harness` trait and doctrine bundles in
`intentd`, golden-test byte pinning, the steps for minting a new version, and the
read-only frontend surface.

## Frontend — `fe/`

Durable documentation for the `cloudlands-fe` desktop frontend (Electron + SvelteKit),
migrated from `packages/cloudlands-fe/docs/` after an accuracy audit:

**Architecture & state**

- [fe/STATE_MANAGEMENT.md](./fe/STATE_MANAGEMENT.md) — Redux/Themis state architecture and side-effect ownership
- [fe/EVENT_SYSTEM.md](./fe/EVENT_SYSTEM.md) — workspace event system and renderer IPC event handling
- [fe/COMPONENTS_DESIGN.md](./fe/COMPONENTS_DESIGN.md) — Svelte 5 + Redux component design guidance
- [fe/MODULE_BOUNDARY_GUIDE.md](./fe/MODULE_BOUNDARY_GUIDE.md) — directory roles and module placement rules
- [fe/TYPE_SYSTEM_GUIDE.md](./fe/TYPE_SYSTEM_GUIDE.md) — IPC type-system contracts, validation, and codegen
- [fe/agent-message-dedup-and-stream-sagas.md](./fe/agent-message-dedup-and-stream-sagas.md) — agent message dedup and stream saga ownership

**Guides**

- [fe/DEVELOPER_GUIDE.md](./fe/DEVELOPER_GUIDE.md) — project structure, agent factory, tab registry, provider system
- [fe/TROUBLESHOOTING_GUIDE.md](./fe/TROUBLESHOOTING_GUIDE.md) — common issues and debugging workflow
- [fe/IPC_DEBUG_GUIDE.md](./fe/IPC_DEBUG_GUIDE.md) — IPC debug tooling and adding new channels
- [fe/ERROR_HANDLING_SYSTEM.md](./fe/ERROR_HANDLING_SYSTEM.md) — error handler, reporter, and toast utilities
- [fe/KEYBINDINGS.md](./fe/KEYBINDINGS.md) — keyboard shortcut reference and audit notes
- [fe/PR_DESCRIPTION_GUIDE.md](./fe/PR_DESCRIPTION_GUIDE.md) — PR description conventions
- [fe/RULES_SYSTEM.md](./fe/RULES_SYSTEM.md) — agent instruction layers and rules loading

**Features**

- [fe/BROWSER_PANEL_SPEC.md](./fe/BROWSER_PANEL_SPEC.md) — embedded browser panel
- [fe/CDP_MCP_TOOLS.md](./fe/CDP_MCP_TOOLS.md) — Chrome DevTools Protocol MCP tools
- [fe/MULTI_BACKEND_CONNECT.md](./fe/MULTI_BACKEND_CONNECT.md) — multi-backend connections and switching
- [fe/PANEL_TAB_UX_SPEC.md](./fe/PANEL_TAB_UX_SPEC.md) — panel/tab UX design spec (leader-key system)
- [fe/panel-system-refactoring.md](./fe/panel-system-refactoring.md) — tab-type registry architecture
- [fe/code-review-ui.md](./fe/code-review-ui.md) — code review panel design
- [fe/tasks-block-syntax.md](./fe/tasks-block-syntax.md) — `@@@task` block syntax
- [fe/workspaces-link-handler.md](./fe/workspaces-link-handler.md) — `intent://` link handling

**Release engineering**

- [RELEASING.md](./RELEASING.md) — cross-component release pipeline (channels, workflows, secrets, ordering, guardrails)
- [fe/RELEASING.md](./fe/RELEASING.md) — release process (beta/stable channels)
- [fe/DEPLOYING.md](./fe/DEPLOYING.md) — deployment infrastructure, runners, and feeds

## Initial porting phase — **COMPLETE (historical)**

The **initial port of Intent's backend to a headless Rust daemon** (`intentd`)
completed on **2026-07-13**, with self-hosting cutover: the effort was built entirely
with the reference app (`augmentcode/intent`), and development has since moved onto the
Intent stack (`intentd` + `cloudlands-fe`) itself. The porting chronicle (implementation
spec, porting-era protocol, breadcrumbs log, and supporting notes) has been removed from
the tree; its durable content lives on in [ARCHITECTURE.md](./ARCHITECTURE.md) and
the [protocol docs](./protocol/README.md), and the original documents remain available
in git history.

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
