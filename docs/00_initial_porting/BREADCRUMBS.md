# Initial Porting — Breadcrumbs

A living progress log for the **initial port of Intent's backend to a headless Rust daemon** (`intentd`). This is the durable trail future agents read first to understand where the port stands, and append to as work lands.

See also: [IMPLEMENTATION_SPEC.md](./IMPLEMENTATION_SPEC.md) (target architecture), [PROTOCOL.md](./PROTOCOL.md) (wire contract), and the root [AGENTS.md](../../AGENTS.md) (workflow + breadcrumb-update policy).

## Goal

Port Intent's backend to a standalone, headless Rust daemon (`intentd`) speaking **JSON-RPC 2.0 over a Unix-domain socket**, local-first. Scope of **this** effort is the **Rust backend only** — no frontend (Tauri/Svelte) yet. The Electron app in `augmentcode/intent` is the behavioral ancestor; the wire contract is defined in PROTOCOL.md.

## Current submodule HEAD

- `packages/intentd` @ `c989aeb` (after the Milestone 1 — core domain CRUD milestone)

## Implemented surface so far

- **JSON-RPC methods (34):** full CRUD across four domains over UDS, backed by SQLite —
  - `workspace.*` (9): `list`, `get`, `create`, `update`, `archive`, `unarchive`, `delete`, `markSeen`, `dismissAttention`.
  - `note.*` (12): `list`, `get`, `create`, `update`, `setContent`, `add`, `edit`, `editLines`, `updateMetadata`, `listTasks`, `readAsset`, `delete`.
  - `task.*` (8): `markAsTask`, `update`, `updateStatus`, `updateNoteStatus`, `getMyTask`, `createPrerequisite`, `assignAgent`, `convertBlocks`.
  - `comment.*` (5): `add`, `list`, `getThread`, `respond`, `delete`.
- **CLI:** `intentd serve`, `intentd call`, `intentd status`, `intentd doctor` (doctor now verifies migrations are applied).
- **Transport:** JSON-RPC 2.0 router over UDS (newline-delimited, mode `0600`, stale-socket cleanup, SIGINT/SIGTERM handling), error codes `-32700`/`-32600`/`-32601`/`-32602`/`-32603`. UDS listener + control client are `cfg`-gated so non-Unix targets (Windows) build cleanly.
- **Persistence:** SQLite via `sqlx` with embedded migrations (WAL, `foreign_keys`, `busy_timeout`), incl. the `0002_comments` migration for the comment/thread model.
- **Tests:** end-to-end UDS lifecycle integration test plus camelCase wire-parity fixtures.

## Deferred / planned (NOT yet built)

- The remaining ~72 PROTOCOL methods (106 total in the contract; 34 implemented).
- TCP / TLS / WSS transports, mDNS discovery, bearer-token auth.
- ACP / provider spawning, GitHub (octocrab), context engine, PTY, search, event bus.
- Transport panic-safety via `catch_unwind` → `-32603` (currently relies on per-connection `tokio::spawn` isolation).
- The entire frontend (Tauri/Svelte).

## Milestone history

### Repo & CI bootstrap

Created two **private** GitHub repos (`cloudlands-ai/monorepo`, `cloudlands-ai/intentd`), a minimal intentd, the monorepo scaffold with `packages/intentd` as a submodule, CI workflows (fmt/clippy/test + 3-target build matrix + semantic-PR-title), and `cliff.toml`.

### Crate skeleton

Scaffolded all 12 crates (per IMPLEMENTATION_SPEC §3) as compiling stubs with §3.2 dependency direction enforced. Verified (`fmt`/`clippy`/`build`).

### Core + SQLite store

`intent-core` (ids, `Error` → JSON-RPC code mapping, `Config`/paths, `Workspace`/`Note` camelCase model, `WorkspaceApi` trait) and `intent-store` (SQLite via `sqlx`, embedded migrations, WAL/`foreign_keys`/`busy_timeout`, repositories). Verified @ submodule `41fd4a6`.

### UDS JSON-RPC slice

`intent-services` (concrete `WorkspaceApi` impl), `intent-transport` (JSON-RPC 2.0 router with the five standard error codes + UDS listener, mode `0600`, newline-delimited, stale-socket cleanup, SIGINT/SIGTERM) and the `intentd` CLI (`serve`/`call`/`status`/`doctor`). Integration test over a temp UDS. Verified @ submodule `2756eb4`.

### READMEs

README.md written for both repos (intentd + monorepo). intentd HEAD `8e13a25`.

### Breadcrumbs, docs index, `make dev`

This milestone: added `docs/00_initial_porting/BREADCRUMBS.md`, `docs/README.md`, the AGENTS.md breadcrumb-update policy, and a `make dev` local dev-stack target.

### Milestone 1 — core domain CRUD

Implemented full create/read/update/delete across the four core domains over UDS: `workspace.*` (9), `note.*` (12), `task.*` (8), `comment.*` (5) — 34 JSON-RPC methods total. Added the `0002_comments` SQLite migration (comment/thread model + repo), end-to-end UDS lifecycle integration test, camelCase wire-parity fixtures, a `doctor` migration-applied check, and `cfg`-gating of the UDS listener + control client so Windows (`x86_64-pc-windows-msvc`) builds cleanly. Spans `intent-core`, `intent-services` (incl. `note_ops`), `intent-store` (incl. `comment_repo`), `intent-transport`, and the `intentd` CLI. CI green on all three build targets (incl. Windows). Submodule HEAD `c989aeb`.

## Next steps / open questions

- Begin expanding the JSON-RPC method catalog beyond the read-only slice (write paths for workspaces/notes), driven by PROTOCOL.md.
- Decide when to introduce the event bus + `events.subscribe`/`events.event` (needed by most live-update methods).
- Harden transport panic-safety (`catch_unwind` → `-32603`) before the full method catalog.
- Revisit transports (TCP/TLS/WSS) + auth + mDNS once UDS reads/writes are solid.

## Changelog

Append a dated entry (newest first) whenever a meaningful unit of porting work lands. Keep each entry concise: what changed, which crates/methods, and the resulting submodule HEAD.

- **2026-06-18** — Milestone 1 — core domain CRUD: 34 JSON-RPC methods (`workspace.*` 9, `note.*` 12, `task.*` 8, `comment.*` 5) over UDS; `0002_comments` migration; e2e UDS lifecycle test + camelCase parity fixtures; `doctor` migration check; Windows `cfg`-gating. Touched `intent-core`, `intent-services`, `intent-store`, `intent-transport`, `intentd`. Submodule HEAD `c989aeb`.
- **2026-06-17** — Breadcrumbs, docs index & `make dev`: added breadcrumbs trail, `docs/README.md` index, and AGENTS.md breadcrumb-update policy. Docs-only (monorepo); submodule HEAD unchanged @ `8e13a25`.
- **2026-06-17** — READMEs: wrote README.md for both repos. Submodule HEAD `8e13a25`.
- **UDS JSON-RPC slice** — services + transport + CLI + integration test. Submodule HEAD `2756eb4`.
- **Core + SQLite store** — `intent-core` + `intent-store` (domain model + SQLite). Submodule HEAD `41fd4a6`.
- **Crate skeleton** — Full 12-crate skeleton with stubs; dependency direction enforced.
- **Repo & CI bootstrap** — repos, scaffold, submodule, CI, cliff.toml.
