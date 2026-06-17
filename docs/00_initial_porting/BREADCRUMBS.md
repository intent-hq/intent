# Initial Porting — Breadcrumbs

A living progress log for the **initial port of Intent's backend to a headless Rustdaemon** (`intentd`). This is the durable trail future agents read first to understandwhere the port stands, and append to as work lands.

See also: [IMPLEMENTATION_SPEC.md](./IMPLEMENTATION_SPEC.md) (target architecture),[PROTOCOL.md](./PROTOCOL.md) (wire contract), and the root[AGENTS.md](../../AGENTS.md) (workflow + breadcrumb-update policy).

## Goal

Port Intent's backend to a standalone, headless Rust daemon (`intentd`) speaking**JSON-RPC 2.0 over a Unix-domain socket**, local-first. Scope of **this** effort is the**Rust backend only** — no frontend (Tauri/Svelte) yet. The Electron app in`augmentcode/intent` is the behavioral ancestor; the wire contract is defined inPROTOCOL.md.

## Current submodule HEAD

- `packages/intentd` @ `8e13a25` (after the READMEs milestone)

## Implemented surface so far

- **JSON-RPC methods:** `workspace.list`, `note.list` (read-only, backed by SQLite).
- **CLI:** `intentd serve`, `intentd call`, `intentd status`, `intentd doctor`.
- **Transport:** JSON-RPC 2.0 router over UDS (newline-delimited, mode `0600`, stale-socketcleanup, SIGINT/SIGTERM handling), error codes `-32700`/`-32600`/`-32601`/`-32602`/`-32603`.
- **Persistence:** SQLite via `sqlx` with embedded migrations (WAL, `foreign_keys`,`busy_timeout`).

## Deferred / planned (NOT yet built)

- The remaining ~104 PROTOCOL methods (106 total in the contract; 2 implemented).
- TCP / TLS / WSS transports, mDNS discovery, bearer-token auth.
- ACP / provider spawning, GitHub (octocrab), context engine, PTY, search, event bus.
- Transport panic-safety via `catch_unwind` → `-32603` (currently relies on per-connection`tokio::spawn` isolation).
- The entire frontend (Tauri/Svelte).

## Milestone history

### Repo & CI bootstrap

Created two **private** GitHub repos (`cloudlands-ai/monorepo`, `cloudlands-ai/intentd`),a minimal intentd, the monorepo scaffold with `packages/intentd` as a submodule, CIworkflows (fmt/clippy/test + 3-target build matrix + semantic-PR-title), and `cliff.toml`.

### Crate skeleton

Scaffolded all 12 crates (per IMPLEMENTATION_SPEC §3) as compiling stubs with §3.2dependency direction enforced. Verified (`fmt`/`clippy`/`build`).

### Core + SQLite store

`intent-core` (ids, `Error` → JSON-RPC code mapping, `Config`/paths, `Workspace`/`Note`camelCase model, `WorkspaceApi` trait) and `intent-store` (SQLite via `sqlx`, embeddedmigrations, WAL/`foreign_keys`/`busy_timeout`, repositories). Verified @ submodule `41fd4a6`.

### UDS JSON-RPC slice

`intent-services` (concrete `WorkspaceApi` impl), `intent-transport` (JSON-RPC 2.0 routerwith the five standard error codes + UDS listener, mode `0600`, newline-delimited,stale-socket cleanup, SIGINT/SIGTERM) and the `intentd` CLI (`serve`/`call`/`status`/`doctor`). Integration test over a temp UDS. Verified @ submodule `2756eb4`.

### READMEs

README.md written for both repos (intentd + monorepo). intentd HEAD `8e13a25`.

### Breadcrumbs, docs index, `make dev`

This milestone: added `docs/00_initial_porting/BREADCRUMBS.md`, `docs/README.md`, the AGENTS.mdbreadcrumb-update policy, and a `make dev` local dev-stack target.

## Next steps / open questions

- Begin expanding the JSON-RPC method catalog beyond the read-only slice (write paths forworkspaces/notes), driven by PROTOCOL.md.
- Decide when to introduce the event bus + `events.subscribe`/`events.event` (needed bymost live-update methods).
- Harden transport panic-safety (`catch_unwind` → `-32603`) before the full method catalog.
- Revisit transports (TCP/TLS/WSS) + auth + mDNS once UDS reads/writes are solid.

## Changelog

Append a dated entry (newest first) whenever a meaningful unit of porting work lands. Keepeach entry concise: what changed, which crates/methods, and the resulting submodule HEAD.

- **2026-06-17** — Breadcrumbs, docs index & `make dev`: added breadcrumbs trail, `docs/README.md` index, and AGENTS.mdbreadcrumb-update policy. Docs-only (monorepo); submodule HEAD unchanged @ `8e13a25`.
- **2026-06-17** — READMEs: wrote README.md for both repos. Submodule HEAD `8e13a25`.
- **UDS JSON-RPC slice** — services + transport + CLI + integration test. Submodule HEAD `2756eb4`.
- **Core + SQLite store** — `intent-core` + `intent-store` (domain model + SQLite). Submodule HEAD `41fd4a6`.
- **Crate skeleton** — Full 12-crate skeleton with stubs; dependency direction enforced.
- **Repo & CI bootstrap** — repos, scaffold, submodule, CI, cliff.toml.