# Intent Monorepo

Monorepo for **Intent**, an agentic coding platform. This repo ties
the Intent components together via git submodules and provides unified docs, tooling, and
CI/CD. It mounts the **Rust backend daemon (`intentd`)**, the **Electron + SvelteKit
desktop frontend (`cloudlands-fe`)**, and the **SwiftUI iOS companion app (`ios`)** as submodules.

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
│                       intent-hq/monorepo                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ packages/                                              │  │
│  │   ├── intentd/        ⇒ submodule → intent-hq/intentd  │  │
│  │   │     Rust backend daemon (JSON-RPC over UDS)        │  │
│  │   ├── cloudlands-fe/   ⇒ submodule → intent-hq/cloudlands-fe │
│  │   │     Electron + SvelteKit desktop UI                │  │
│  │   └── ios/            ⇒ submodule → intent-hq/ios      │  │
│  │         SwiftUI iOS companion app                      │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ docs/   ARCHITECTURE.md + PROTOCOL.md                  │  │
│  │ AGENTS.md   Makefile   cliff.toml   .github/workflows/ │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Code lives in the submodule repos; the monorepo tracks specific commits of each submodule and
carries the cross-cutting docs and tooling. See `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md`
for the full design.

## Status

| Component | Status |
| --- | --- |
| `packages/intentd` | **Backend port — canonical persistence landed.** 218 JSON-RPC request methods + a server-initiated `events.event` notification over SQLite, spanning workspace/repo/note/task/comment, events, git/PR/file-tracking/metrics/accept-changes, search/terminal/script, workspace-file/note-primitive/cross-workspace, the settings/rules/specialist/`mcp.servers`/MCP-OAuth agent ecosystem, GitHub-browse/Linear/Sentry integrations, and the ACP agent runtime (`agent.*`). The daemon owns all persistent user-facing state (notes/comments/assets/settings/agent sessions). Transports: UDS (default, `0600`) + WSS/TLS (bearer auth, origin allow-list, fingerprint pinning) + mDNS. CLI: `serve`/`call`/`status`/`stop`/`doctor`/`import`/`service`/`token`/`mcp-bridge`. |
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
│   ├── ARCHITECTURE.md            # Durable backend architecture
│   └── PROTOCOL.md                # Canonical wire contract (protocol v2.0)
├── packages/
│   ├── intentd/                   # ⇒ submodule → intent-hq/intentd (Rust backend)
│   ├── cloudlands-fe/             # ⇒ submodule → intent-hq/cloudlands-fe (Electron + SvelteKit frontend)
│   └── ios/                       # ⇒ submodule → intent-hq/ios (SwiftUI iOS companion app)
├── AGENTS.md                      # AI agent workflow guide (commit/PR conventions)
├── Makefile                       # Cross-package task orchestration
└── README.md                      # ← you are here
```

## Submodules

| Path                     | Repository                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- |
| `packages/intentd`       | [intent-hq/intentd](https://github.com/intent-hq/intentd)                     |
| `packages/cloudlands-fe` | [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe)         |
| `packages/ios`           | [intent-hq/ios](https://github.com/intent-hq/ios)                             |

## Getting Started

```bash
# Clone with submodules
git clone --recursive git@github.com:intent-hq/monorepo.git
cd monorepo

# Or, if already cloned without --recursive:
git submodule update --init --recursive

# Verify and test (delegates into packages/intentd)
make check      # cargo fmt --check + cargo clippy -- -D warnings
make test       # cargo test --workspace
make build      # cargo build --workspace
make clean      # remove build artifacts

# Local dev: choose one of two workflows
#
# Option 1 — One-command sidecar mode (recommended):
#   The FE spawns and supervises its own intentd binary (like the packaged app).
#
#   make dev
#
# Option 2 — Two-terminal mode (daemon + FE separate):
#   Run the daemon and FE in separate terminals. Useful for daemon debugging.
#
#   # Terminal 1 — dev daemon: isolated data dir under .dev/intentd, --listen both --insecure
#   make dev-daemon
#
#   # Terminal 2 — Electron + SvelteKit frontend (packages/cloudlands-fe);
#   # connects to ws://127.0.0.1:5181/ws out of the box.
#   make run-fe
#
# Occasional "debug the release app with its own state" variant: run intentd
# against its default (real) data dir over UDS only, no TCP listener bound:
#
#   make release-daemon                                      # UDS only on the real data dir
#   INTENTD_SOCKET=~/Library/Application\ Support/intentd/intentd.sock make run-fe
#
# `make run-intentd` is a deprecated alias for `make release-daemon`.
# `make ios-info` prints the host/port for the iOS simulator and hardware, and
# `make ios-open` opens the Xcode project (`packages/ios/Intent.xcodeproj`).
# `make help` lists every documented target.
```

## Contributing & Workflow

Changes that span a submodule and the monorepo follow a two-phase flow (see `AGENTS.md` for
the full guide):

**Phase 1 — Submodule PR.** Make scoped, conventional commits on a feature branch in the
submodule (e.g. `intent-hq/intentd`), push, open a PR, and merge (squash preferred).

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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the durable backend architecture:
  system overview, crate layout, dependency rules, persistence, and transports.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the canonical wire contract (protocol v2.0):
  transport, JSON-RPC envelope, full method catalog, events, and error codes.

## Related Repositories

| Repository | Description |
| --- | --- |
| [intent-hq/intentd](https://github.com/intent-hq/intentd) | Rust backend daemon — JSON-RPC over UDS, mounted at `packages/intentd`. |
| [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) | Electron + SvelteKit desktop frontend — mounted at `packages/cloudlands-fe`. |
| [intent-hq/ios](https://github.com/intent-hq/ios) | SwiftUI iOS companion app — mounted at `packages/ios`. |
