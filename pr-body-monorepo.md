Bumps `packages/intentd` submodule to main commit 6c9978f7d16f961633f1548c1023968c3dd42f99 and adds STAB-37 to the stabilization issue tracker.

## Upstream PR
intent-hq/intentd#189 — fix: resolve provider binaries to absolute paths before spawning

## Changes
- `packages/intentd` gitlink updated to 6c9978f (PR #189 merged to main)
- `docs/01_stabilizing/KNOWN_ISSUES.md` — added STAB-37 (2026-07-15, area: intentd agent spawn / provider binary resolution, severity: P1) marked fixed with PR link and resolution date 2026-07-16
- Updated next available STAB ID to STAB-38

## Verification
- `make check` passed (fmt + clippy clean)
- `make test` — one local-only flake in `uds_concurrent_dispatch::slow_host_exec_does_not_block_fast_workspace_list` (timeout on slow local machine); test passes in CI on the exact commit 6c9978f (https://github.com/intent-hq/intentd/actions/runs/29516132821)
