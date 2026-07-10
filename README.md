# Cloudlands Monorepo

Internal engineering monorepo for **Cloudlands**, an agentic coding platform. This repo ties
the Cloudlands components together via git submodules and provides unified docs, tooling, and
CI/CD. It mounts the **Rust backend daemon (`intentd`)**, the **Electron + SvelteKit
desktop frontend (`cloudlands-fe`)**, and the **SwiftUI iOS companion app (`ios`)** as submodules.

> ⚠️ Private Repository — This repo is internal to the Cloudlands engineering team. The
> component repositories it references are also private. See Related Repositories for links.

## Architecture Overview

`intentd` is a local-first Rust daemon that owns the Intent domain model — workspaces, notes,
tasks, comments, agents, git, pull requests, scripts, terminals, files, and events — and
exposes it over a JSON-RPC 2.0 API on a Unix-domain socket plus a secure WSS/TLS LAN
transport. Clients are thin; all business logic lives in the daemon, including the ACP agent
runtime. The desktop frontend now **exists** and lives in this monorepo as the
`packages/cloudlands-fe` submodule — an **Electron + SvelteKit + TypeScript** app. It talks
to `intentd` only through the `AppClient` JSON-RPC boundary (which ships with a mock
implementation, so the frontend can also run standalone). It was migrated in with full history.

```
┌──────────────────────────────────────────────────────────────┐
│                     cloudlands-ai/monorepo                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ packages/                                              │  │
│  │   ├── intentd/        ⇒ submodule → cloudlands-ai/intentd │
│  │   │     Rust backend daemon (JSON-RPC over UDS)        │  │
│  │   ├── cloudlands-fe/   ⇒ submodule → cloudlands-ai/cloudlands-fe │
│  │   │     Electron + SvelteKit desktop UI                │  │
│  │   └── ios/            ⇒ submodule → cloudlands-ai/ios │
│  │         SwiftUI iOS companion app                      │  │
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
| `packages/intentd` | **Backend port — canonical persistence landed.** 218 JSON-RPC request methods + a server-initiated `events.event` notification over SQLite, spanning workspace/repo/note/task/comment, events, git/PR/file-tracking/metrics/accept-changes, search/terminal/script, workspace-file/note-primitive/cross-workspace, the settings/rules/specialist/`mcp.servers`/MCP-OAuth agent ecosystem, GitHub-browse/Linear/Sentry integrations, and the ACP agent runtime (`agent.*`). The daemon owns all persistent user-facing state (notes/comments/assets/settings/agent sessions). Transports: UDS (default, `0600`) + WSS/TLS (bearer auth, origin allow-list, fingerprint pinning) + mDNS. CLI: `serve`/`call`/`status`/`stop`/`doctor`/`import`/`service`/`token`/`mcp-bridge`. See `docs/00_initial_porting/BREADCRUMBS.md` for the live log. |
| `packages/cloudlands-fe` | **Desktop frontend — daemon-canonical.** Electron + SvelteKit + TypeScript app, mounted at `packages/cloudlands-fe`. Reaches the backend only through the `AppClient` JSON-RPC boundary (live `intentd` + a mock implementation for standalone runs); local persistence, execution spawns, the legacy agent transport, and the remote-backend stack are all retired onto daemon RPCs. |
| `packages/ios` | **iOS companion app — submodule mounted.** SwiftUI iOS app, mounted at `packages/ios`. Early-stage development. |

## Repository Layout

```
monorepo/
├── .github/
│   └── workflows/
│       └── ci.yml                 # fmt/clippy/test + build matrix + PR-title check
├── .gitmodules                    # Submodule definitions (intentd, cloudlands-fe, ios)
├── cliff.toml                     # git-cliff changelog config (conventional commits)
├── docs/
│   └── 00_initial_porting/        # IMPLEMENTATION_SPEC.md + PROTOCOL.md
├── packages/
│   ├── intentd/                   # ⇒ submodule → cloudlands-ai/intentd (Rust backend)
│   ├── cloudlands-fe/             # ⇒ submodule → cloudlands-ai/cloudlands-fe (Electron + SvelteKit frontend)
│   └── ios/                       # ⇒ submodule → cloudlands-ai/ios (SwiftUI iOS companion app)
├── AGENTS.md                      # AI agent workflow guide (commit/PR conventions)
├── Makefile                       # Cross-package task orchestration
└── README.md                      # ← you are here
```

## Submodules

| Path                     | Repository                                                                    | Visibility |
| ------------------------ | ----------------------------------------------------------------------------- | ---------- |
| `packages/intentd`       | [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd)             | Private    |
| `packages/cloudlands-fe` | [cloudlands-ai/cloudlands-fe](https://github.com/cloudlands-ai/cloudlands-fe) | Private    |
| `packages/ios`           | [cloudlands-ai/ios](https://github.com/cloudlands-ai/ios)                     | Private    |

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

# Local dev runs as two long-running processes, one per terminal
# (each is long-running; Ctrl-C to stop):
#
#   # Terminal 1 — the intentd daemon on its default (real) data dir + socket
#   make run-intentd
#
#   # Terminal 2 — the Electron + SvelteKit frontend (packages/cloudlands-fe),
#   # launched via `pnpm run dev`. By default it connects to the daemon's
#   # default intentd socket, so it pairs directly with `make run-intentd`.
#   make run-fe
#
# Isolated dev-data variant: run the daemon against a dedicated gitignored dev
# data dir, then point the frontend at that socket instead of the default:
#
#   make dev-daemon                                          # intentd (UDS) on the dev data dir
#   INTENTD_SOCKET=$(DEV_DATA_DIR)/intentd.sock make run-fe  # FE → dev-data socket
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
| [cloudlands-ai/cloudlands-fe](https://github.com/cloudlands-ai/cloudlands-fe) | Electron + SvelteKit desktop frontend (private) — mounted at `packages/cloudlands-fe`. |
| [cloudlands-ai/ios](https://github.com/cloudlands-ai/ios) | SwiftUI iOS companion app (private) — mounted at `packages/ios`. |
