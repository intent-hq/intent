# State Management Guide

> **Architecture update — the renderer uses the published Themis runtime.**
> `@augmentcode/themis` provides the Store, actions, reducers, selectors, and
> collection utilities. Themis initializes its saga middleware during
> `Store.init()`, and the root layout starts the app-owned saga registry with
> `store.runSaga(sagaFn)`.

This is the project entrypoint for state-management orientation. The store API
surface is the installed `@augmentcode/themis` package; app-specific companion
notes live under `src/store/renderer/docs/`.

If this doc conflicts with the installed Themis runtime, follow the runtime and
report the drift.

## Repository orientation

Renderer shared/domain state lives under `src/store/renderer/` and uses the
configured `Store` from `@augmentcode/themis`. Svelte store modules
(`*.store.svelte.ts`) are deprecated migration targets; do not create new ones or
expand existing ones.

Electron main-process shared/domain state lives under `src/store/main/` and
previously used a configured `StreamingStore` (since removed). The remaining
modules there are neutralized no-op shims kept for type compatibility; do not
add new main-process store state.

The current app-specific map is:

- `src/store/renderer/store.ts` — configured app `Store`, app state type inference,
  and app reducer registration.
- `src/store/renderer/sagas.ts` — positional `sagas` array plus
  `startAllAppSagas(store)`, which starts each saga with `store.runSaga(sagaFn)`.
- `src/routes/+layout.svelte` — root Store initialization and explicit app saga
  startup via `startAllAppSagas(appStore)`.
- `src/store/renderer/slices/**` — app-owned slice state, actions, selectors, and
  sagas.
- `src/store/renderer/utils/` — app-local helpers that are not package-owned exports,
  such as workspace scoping, IPC channels, and safe localStorage saga helpers.
- `src/store/main/slices/**` — historical main-process slice state, actions, and
  selectors (the main-process store itself has been removed).
- `src/store/main/redux-store-bridge.ts` — neutralized no-op bridge retained so
  main-process services continue to type-check.

## Side-effect ownership

Renderer business side effects belong to root-owned Themis/Redux sagas. API and
IPC calls, persistence, timers, subscriptions, navigation, and toasts must not
be introduced through Store middleware or a new renderer bridge.

`src/store/renderer/middleware.ts` contains exactly five approved infrastructure
and diagnostic categories: store guards, action batching, logging, state-reference
checks, and structured-clone checks. Existing web/mock IPC bridge installers may
adapt Electron-shaped channels, but must not become alternate business workflows.
`pnpm validate:architecture` enforces these boundaries.

## Local rules worth remembering

- Redux owns shared, persisted, async-driven, or cross-feature state.
- Component-local state is for ephemeral view details only, such as hover,
  focus, transient open/closed state, or one component's draft field.
- Components create selector readables during component initialization, render
  `$selector$` values, and dispatch through the configured app Store.
- Event handlers and non-component services use one-shot reads from the
  configured Store, e.g. `selectThing.select(store.state, id)`, then dispatch
  explicit actions with `store.dispatch(action)`.
- The main-process store has been removed; `src/store/main/redux-store-bridge.ts`
  exports no-ops (`initMainStoreBridge` does nothing, `mainDispatch` returns the
  action unchanged). Do not add main-process store state. Renderer code must not
  import `src/store/main/**`, and main-process code must not import renderer
  Store setup.
- Tests, services, and selector composition should use `.select(state, ...args)`
  for synchronous reads; sagas should use `.effect(...args)`.
- Side effects that matter beyond one component belong in sagas. Component
  `$effect` should stay limited to DOM-local concerns.
- App-local safe localStorage helpers remain in `src/store/renderer/utils/` because
  the package skills describe them as app-owned examples rather than public
  package exports.

## Companion docs

Use [`src/store/renderer/docs/readme.md`](../../packages/cloudlands-fe/src/store/renderer/docs/readme.md) as the
index for retained app-specific Redux notes. Those docs are concise companions;
use the skills above for current API and architecture rules.
