# Module Boundary Guide

How to place utility and helper modules in the Intent codebase so they don't create unintended cross-process coupling.

## Why This Matters

Intent is an Electron app with three distinct process contexts:

- **Main process** (`src/main/`, feature `main/` subtrees) — Node.js, has filesystem/OS access
- **Renderer process** (`src/lib/`, `src/routes/`, feature root/component files) — browser context, Svelte UI
- **Preload** (`src/preload/`) — bridge between main and renderer

When a renderer module imports a helper that lives inside a feature's `main/` subtree, the bundler pulls the entire main-process dependency chain into the renderer bundle. This causes:

- Larger renderer bundles with dead Node.js code
- Potential runtime errors from Node.js APIs in the browser
- Tight coupling between features that should be independent

The same problem occurs in reverse: main-process code importing from renderer-only feature paths can pull in Svelte/browser dependencies.

## Directory Roles

| Directory | Process | Purpose | When to use |
|-----------|---------|---------|-------------|
| `src/shared/` | Any | Pure helpers with **active main + renderer consumers** | Cross-process utilities (ID generators, validators, type guards) |
| `src/lib/utils/` | Renderer | Browser-safe helpers reused across renderer features | Serializers, formatters, URL helpers used by multiple UI features |
| `src/main/utils/` | Main | Main-process helpers shared across features or IPC handlers | Validation, sanitization, path helpers used by multiple main services |
| `src/features/<name>/utils/` | Varies | Helpers clearly owned by one feature | Feature-local extraction from a mixed module |
| `src/features/<name>/main/` | Main | Feature's main-process code | Business logic, IPC handlers, services |
| `src/features/<name>/` (root) | Renderer | Feature's renderer code | Stores, components, client modules |

### Decision Flowchart

When you have a utility function that needs a home:

1. **Is it used by both main and renderer code?** → `src/shared/`
2. **Is it main-process only, used by multiple features?** → `src/main/utils/`
3. **Is it renderer only, used by multiple features?** → `src/lib/utils/`
4. **Is it used by only one feature?** → `src/features/<name>/utils/`
5. **Is it tightly coupled to a service or orchestration module?** → Leave it in place, it's not a utility

## Rules for New Code

### DO

- **Place new shared utilities in the correct process-safe directory** from the start. Don't put a cross-feature helper in a feature root and plan to move it later.
- **Use feature-local `utils/` directories** when a helper is clearly owned by one feature. This is better than prematurely promoting to `src/shared/`.
- **Keep utility modules dependency-light.** A utility should not import stores, services, or orchestration modules. If it needs those, it's not a utility — it's a service.
- **Prefer pure functions.** Utilities should take inputs and return outputs without side effects. This makes them safe to import from any process context.
- **Co-locate related utilities.** `generateCommentId()` and `isValidCommentId()` belong in the same file, not scattered across directories.

### DON'T

- **Don't export utility functions from orchestration modules.** If `workspace.client.ts` has a `normalizeWorkspacePaths()` helper, extract it to `utils/` rather than making callers import the entire client module.
- **Don't import from a feature's `main/` subtree in renderer code** (or vice versa). This is the primary boundary violation this guide prevents.
- **Don't put renderer-only helpers in `src/shared/`.** If only renderer code uses it, `src/lib/utils/` is the right home. `src/shared/` should be reserved for genuinely cross-process code.
- **Don't duplicate helpers across directories.** If you find yourself writing `isGitHubUrl()` in two places, extract it to the appropriate shared location instead.

## Recognizing Mixed Modules

A "mixed module" exports both:
- **Utility functions** — pure, dependency-light, reusable (e.g., `isAuthUrl()`, `normalizeWorkspacePaths()`)
- **Orchestration code** — stateful, side-effectful, feature-specific (e.g., `handleLink()`, API client methods)

Mixed modules are the most common source of boundary violations because importing the utility also pulls in the orchestration code and all its dependencies.

### How to Split a Mixed Module

1. **Identify the utility exports** — functions that are pure, take simple inputs, return simple outputs, and don't import stores/services
2. **Create a `utils/` file** in the appropriate directory (feature-local or shared)
3. **Move the utility functions** to the new file
4. **Add a temporary re-export** from the original file to avoid breaking all callers at once:
   ```typescript
   // Old file — temporary shim during migration
   export { isAuthUrl, isGitHubUrl } from '$lib/utils/link-url-utils';
   ```
5. **Repoint direct consumers** to the new path in the same PR
6. **Remove the re-export** once all consumers are migrated (can be a follow-up PR)

## Refactoring Existing Code

When you encounter a boundary violation during feature work:

1. **Don't fix it inline** if it's not directly related to your change. File a separate issue or note it for a future refactor.
2. **If you must fix it**, follow the batch approach:
   - Move/split one module at a time
   - Preserve all existing export names and signatures
   - Use temporary re-exports to minimize import churn
   - Run targeted tests + typechecks before moving to the next module
3. **Verify after each move:**
   ```bash
   # Targeted tests for touched features
   npx vitest run <test-files-for-touched-features>
   
   # All three typecheck targets
   npx tsc -p tsconfig.json --noEmit        # renderer
   npx tsc -p tsconfig.main.json --noEmit   # main process
   npx tsc -p tsconfig.preload.json --noEmit # preload
   ```

## Current State

The following moves were completed as part of the initial refactor:

| Module | Old Location | New Location | Status |
|--------|-------------|--------------|--------|
| `comment-id-generator.ts` | `src/features/comments/` | `src/shared/utils/` | ✅ Moved, old-path shim removed |
| `notes-primitives-serializer.ts` | `src/features/notes/` | `src/lib/utils/` | ✅ Moved, old-path shim removed |
| `workspace-validation.ts` | `src/features/workspace/main/` | `src/main/utils/` | ✅ Moved, old-path shim removed |

The temporary re-export shims at the old paths have all been removed; consumers import the new locations directly.

### Remaining planned work

| Module | Action | Target |
|--------|--------|--------|
| `ipc-validation.ts` | Split | `src/main/utils/` (generic IPC validators vs workspace-specific) |
| `link-handler.ts` | Split | Extract `isAuthUrl()`/`isGitHubUrl()` from `src/features/navigation/link-handler.ts` → `src/lib/utils/link-url-utils.ts` (not yet done) |

Note: `workspace.client.ts` now lives at `src/store/renderer/slices/workspace/utils/` and still holds `normalizeWorkspacePaths()`.

## Related Documentation

- [Developer Guide](./DEVELOPER_GUIDE.md) — project setup and structure overview
- [Type System Guide](./TYPE_SYSTEM_GUIDE.md) — type conventions