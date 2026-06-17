# Cloudlands Monorepo

Internal engineering monorepo for the Cloudlands backend. This repo ties together the
Cloudlands components via git submodules and provides unified CI/CD and tooling.

> ⚠️ Private Repository — This repo is internal to the Cloudlands engineering team.

## Architecture Overview

`intentd` is a local-first Rust daemon that owns the Intent domain model — workspaces,
notes, tasks, comments, agents, git, pull requests, scripts, terminals, files, and events —
and exposes it over a JSON-RPC API. Clients (a desktop UI, a CLI, or an agent acting as an
MCP client) are thin; all business logic lives in the daemon. See the engineering spec in
`docs/00_initial_porting/IMPLEMENTATION_SPEC.md` for the full design.

> Status: **bootstrap skeleton.** `intentd` currently compiles as a minimal cargo workspace
> with a single binary crate that prints its version and usage. No daemon behavior,
> transport, or persistence is implemented yet.

## Repository Map

```
monorepo/
├── .github/
│   └── workflows/
│       └── ci.yml                 # PR title check (conventional commits)
├── .gitmodules                    # Submodule definitions (intentd)
├── cliff.toml                     # git-cliff changelog config (conventional commits)
├── docs/                          # Architecture + porting specs
├── packages/
│   └── intentd/                   # Rust backend daemon (submodule)
├── AGENTS.md                      # AI agent workflow guide
├── Makefile                       # Cross-package task orchestration
└── README.md
```

## Submodules

| Path               | Repository                                            |
| ------------------ | ----------------------------------------------------- |
| `packages/intentd` | [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd) |

Code lives in the submodule repos. The monorepo tracks specific commits of each submodule.

## Getting Started

```bash
git clone --recurse-submodules https://github.com/cloudlands-ai/monorepo
cd monorepo

# Or, if already cloned without submodules:
git submodule update --init --recursive
```

## Common Tasks

```bash
make build      # build intentd (cargo build --workspace)
make check      # cargo fmt --check + cargo clippy -- -D warnings
make test       # cargo test --workspace
make clean      # remove build artifacts
```

## Related Repositories

- [cloudlands-ai/intentd](https://github.com/cloudlands-ai/intentd) — Rust backend daemon
