# Frontend Migration

The Intent frontend has been migrated from the prior Electron app
(`augmentcode/intent`) into [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe)
and wired into this monorepo as the `packages/cloudlands-fe` submodule. The full
git history (938 commits) was pushed to `cloudlands-fe` `main` (`ab321db0`), and
the earlier **Tauri v2 prototype** that previously occupied that repo was
replaced.

See also: [IMPLEMENTATION_SPEC.md](./IMPLEMENTATION_SPEC.md) (target
architecture), [PROTOCOL.md](./PROTOCOL.md) (the `intentd` wire contract), and
[BREADCRUMBS.md](./BREADCRUMBS.md) (the running porting log).

## Why

Consolidate the frontend under the intent-hq monorepo so it lives alongside
`packages/intentd` (the headless Rust daemon it talks to), sharing one history,
one review surface, and one porting trail.

## What made the FE portable to `intentd`

The Electron app could not be pointed at `intentd` as-is; the engineering effort
that made it portable was:

- **Backend decoupling.** The legacy in-renderer Redux/Saga *backend* coupling
  was removed. The UI now reaches the backend **only** through the **AppClient
  JSON-RPC boundary** (`src/lib/client`), never by calling backend services
  directly.
- **Mock-driven UI.** `AppClient` has both a **live** implementation (JSON-RPC
  to `intentd`) and a **mock** implementation (in-memory fixtures), so the
  Electron app still runs standalone on mocks and each domain can be migrated
  independently.
- **Seven live domains over JSON-RPC.** `workspaces`, `agents`, `notes`,
  `tasks`, `comments`, `git`, and `files` are wired to `intentd` with
  **optimistic concurrency** (the `-32005` conflict contract carrying the
  authoritative current entity) and **snapshot + delta subscriptions**
  (seq-0 snapshot followed by ordered `{ added, updated, removedIds }` deltas).
- **Renderer→main boundary cleanup.** All Node-bound code (`fs`,
  `child_process`, `worker_threads`) was relocated under feature `main/`
  subtrees, and a null-safe `StreamStoreShaper` seam severs the
  renderer↔Redux-store coupling from the main process.
- **Agent conversation UX restored.** The conversation tab opens correctly,
  live transcripts stream via `agent.getConversation`, and agent-creation
  triggers were reconnected end-to-end.

## Migration mechanics (git)

- The `cloudlands-fe` repo was recreated empty, then the **full FE history** was
  pushed to `main` as the initial import (`ab321db0`).
- The monorepo `packages/cloudlands-fe` submodule gitlink is bumped to
  `ab321db0` in a separate PR (see PR #59); this document is additive and does
  not touch the gitlink.
- **SSH was blocked by the org's SAML SSO**, so all git operations used
  **HTTPS + the `gh` credential helper**.
- The org ruleset on monorepo `main` requires a **PR with passing CodeQL** (no
  merge commits), so this change lands as a squash-merged PR.

## Verification state at import

Captured against the imported FE at `ab321db0`:

- `tsc` ×3 (renderer, main, preload) — **pass**.
- `pnpm run check` — **0 errors**, 258 (pre-existing) warnings.
- `pnpm run lint` — **pass**.
- `pnpm run test:unit` (Vitest) — **8149 passed / 13 skipped / 0 failed**.

## Working with it going forward

```bash
# Initialize / update the submodule
git submodule update --init packages/cloudlands-fe
cd packages/cloudlands-fe

# Develop
pnpm install
pnpm run dev
pnpm run check
pnpm run lint
pnpm run test:unit
```

For frontend internals (the AppClient seam, state management, module
boundaries), see the `cloudlands-fe` repo's own `docs/` and `AGENTS.md`. For the
daemon wire contract the live AppClient targets, see
[PROTOCOL.md](./PROTOCOL.md).
