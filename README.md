# Cloudlands Monorepo

Internal engineering monorepo for **Cloudlands**, an agentic coding platform. This repo ties
the Cloudlands components together via git submodules and provides unified docs, tooling, and
CI/CD. The **Rust backend (`intentd`) comes first**; the desktop frontend lands later.

> ⚠️ Private Repository — This repo is internal to the Cloudlands engineering team. The
> component repositories it references are also private. See Related Repositories for links.

## Architecture Overview

`intentd` is a local-first Rust daemon that owns the Intent domain model — workspaces, notes,
tasks, comments, agents, git, pull requests, scripts, terminals, files, and events — and
exposes it over a JSON-RPC 2.0 API on a Unix-domain socket plus a secure WSS/TLS LAN
transport. Clients are thin; all business logic lives in the daemon, including the ACP agent
runtime. A Tauri/Svelte desktop frontend is **planned** and will live in this monorepo as a
second submodule once it exists.

```
┌──────────────────────────────────────────────────────────────┐
│                     cloudlands-ai/monorepo                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ packages/                                              │  │
│  │   ├── intentd/        ⇒ submodule → cloudlands-ai/intentd │
│  │   │     Rust backend daemon (JSON-RPC over UDS)        │  │
│  │   └── (frontend/)     ⇒ Tauri + Svelte desktop UI      │  │
│  │                          ── PLANNED, not yet present ── │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ docs/00_initial_porting/   IMPLEMENTATION_SPEC + PROTOCOL │
│  │ AGENTS.md   Makefile   cliff.toml   .github/workflows/ │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Code lives in the submodule repos; the monorepo tracks specific commits of each submodule and
carries the cross-cutting docs and tooling. See `docs/00_initial_porting/IMPLEMENTATION_SPEC.md`
for the full design.

## Status

| Component | Status |
| --- | --- |
| `packages/intentd` | **Backend port — Milestones 1–10 implemented.** ~143 JSON-RPC methods + a server-initiated `events.event` notification over SQLite, spanning workspace/repo/note/task/comment, events, git/PR/file-tracking/metrics/accept-changes, search/terminal/script, the settings/rules/specialist/`mcp.servers` agent ecosystem, the ACP agent runtime (`agent.*`), and intentd transport extensions. Transports: UDS (default, `0600`) + WSS/TLS (bearer auth, origin allow-list, fingerprint pinning) + mDNS. CLI: `serve`/`call`/`status`/`stop`/`doctor`/`import`/`service`/`mcp-bridge`. See `docs/00_initial_porting/BREADCRUMBS.md` for the live log. |
| Desktop frontend | **Planned.** Tauri + Svelte; not yet a submodule. |

## Repository Layout

```
monorepo/
├── .github/
│   └── workflows/
│       └── ci.yml                 # fmt/clippy/test + build matrix + PR-title check
├── .gitmodules                    # Submodule definitions (intentd)
├── cliff.toml                     # git-cliff changelog config (conventional commits)
├── docs/
│   └── 00_initial_porting/        # IMPLEMENTATION_SPEC.md + PROTOCOL.md
├── packages/
│   └── intentd/                   # ⇒ submodule → cloudlands-ai/intentd (Rust backend)
├── AGENTS.md                      # AI agent workflow guide (commit/PR conventions)
├── Makefile                       # Cross-package task orchestration
└── README.md                      # ← you are here
```

## Submodules

| Path               | Repository                                                        | Visibility |
| ------------------ | ---------------------------------------------------------------- | ---------- |
| `packages/intentd` | [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd) | Private    |

## Getting Started

```bash
# Clone with submodules
git clone --recursive git@github.com:cloudlands-ai/monorepo.git
cd monorepo

# Or, if already cloned without --recursive:
git submodule update --init --recursive

# Verify and test (delegates into packages/intentd)
make check      # cargo fmt --check + cargo clippy -- -D warnings
make test       # cargo test --workspace
make build      # cargo build --workspace
make clean      # remove build artifacts
```

## Contributing & Workflow

Changes that span a submodule and the monorepo follow a two-phase flow (see `AGENTS.md` for
the full guide):

**Phase 1 — Submodule PR.** Make scoped, conventional commits on a feature branch in the
submodule (e.g. `cloudlands-ai/intentd`), push, open a PR, and merge (squash preferred).

**Phase 2 — Monorepo update.** Pull the submodule's latest `main`, stage the updated gitlink
(`git add packages/intentd`), commit (`chore: update intentd submodule to latest main`), push,
and open a monorepo PR referencing the submodule PR.

Conventions:

- **Conventional commits** are required and PR titles are validated in CI against `feat`,
  `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`.
- **Changelogs** are generated with `git-cliff` (see `cliff.toml`).
- For Rust changes, keep `cargo fmt --check`, `cargo clippy -- -D warnings`, and
  `cargo build` green in `packages/intentd` before opening a PR.

## Documentation

- [`docs/00_initial_porting/IMPLEMENTATION_SPEC.md`](docs/00_initial_porting/IMPLEMENTATION_SPEC.md)
  — architecture, crate layout, persistence, and the phased roadmap.
- [`docs/00_initial_porting/PROTOCOL.md`](docs/00_initial_porting/PROTOCOL.md) — the wire
  contract: transport, JSON-RPC envelope, full method catalog, events, and error codes.

## Related Repositories

| Repository | Description |
| --- | --- |
| [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd) | Rust backend daemon (private) — JSON-RPC over UDS, mounted at `packages/intentd`. |
