# Component Design Guidelines

Practical rules for structuring and sizing Svelte components in this codebase.

## Component Structure

Every Svelte component's `<script>` block should follow this ordering. Separate the script from the template with a blank line.

1. **Imports** — external packages, then internal modules
2. **Props** — component prop declarations (`let { ... } = $props()`)
3. **Variable declarations** — local state, constants
4. **Selector calls and derived variables** — selector readables via `selectThing()`, `$derived` expressions
5. **Handler declarations** — event handlers, callbacks
6. **`onMount` handling** — setup that runs once after first render
7. **Effects** — `$effect` blocks for reactive side effects
8. **`onDestroy` handling** — cleanup logic

```svelte
<script lang="ts">
  // 1. Imports
  import { onDestroy, onMount } from 'svelte';
  import { store as appStore } from '$store/renderer/store';
  import { someAction } from './some-slice';
  import { selectSomeItem } from './selectors';
  import ChildComponent from './ChildComponent.svelte';

  // 2. Props
  let { id, label } = $props<{ id: string; label: string }>();

  // 3. Variable declarations
  let localCount = $state(0);

  // 4. Selectors and derived
  const item$ = selectSomeItem(id);
  const displayName = $derived($item$?.name ?? label);

  // 5. Handlers
  function handleClick() {
    appStore.dispatch(someAction(id));
  }

  // 6. onMount
  onMount(() => {
    console.log('mounted');
  });

  // 7. Effects
  $effect(() => {
    if ($item$?.status === 'ready') {
      localCount += 1;
    }
  });

  // 8. onDestroy
  onDestroy(() => {
    console.log('destroyed');
  });
</script>

<button onclick={handleClick}>{displayName} ({localCount})</button>
```

## Breaking Down Large Components

The codebase enforces a **1200-line ESLint `max-lines` rule** per file. Components approaching this limit need to be decomposed. Use the strategies below to keep components focused and small.

### Avoid prop-drilling

Don't thread props through multiple component layers. Instead, have child components read state directly from the Redux store via selectors.

```svelte
<!-- ❌ Prop-drilling -->
<Parent {user} {settings} {theme}>
  <Child {user} {settings} {theme}>
    <Grandchild {user} {settings} />
  </Child>
</Parent>

<!-- ✅ Direct selector access -->
<Grandchild userId={id} />
<!-- Grandchild reads user/settings from Redux internally -->
```

### Move side effects to sagas

Business logic, IPC listeners, and async workflows belong in Redux sagas — not in component `$effect` chains. This shrinks components and makes logic testable in isolation.

```svelte
<!-- ❌ Complex effect chains in component -->
$effect(() => {
  window.api.onSomeEvent((data) => {
    appStore.dispatch(processData(data));
    if (data.needsRefresh) {
      appStore.dispatch(fetchMore());
    }
  });
});

<!-- ✅ One dispatch, saga handles the rest -->
$effect(() => {
  appStore.dispatch(subscribeToEvent());
  return () => appStore.dispatch(unsubscribeFromEvent());
});
```

### Use Redux for shared state

Don't pass state through component hierarchies. Connect child components directly to the store so each component owns only what it needs.

### Extract conditional template blocks

Templates inside `{#if}/{:else}` blocks that are substantial (roughly 30+ lines) should become their own components.

```svelte
<!-- ❌ Large inline conditional -->
{#if mode === 'edit'}
  <!-- 50 lines of edit UI -->
{:else}
  <!-- 40 lines of view UI -->
{/if}

<!-- ✅ Extracted -->
{#if mode === 'edit'}
  <EditView {id} />
{:else}
  <ReadView {id} />
{/if}
```

### Extract repeated template patterns

`{#each}` item renderers are natural extraction candidates. If the loop body is more than a few lines, extract it.

```svelte
<!-- ❌ Large inline loop body -->
{#each items as item}
  <!-- 40 lines of item rendering -->
{/each}

<!-- ✅ Extracted -->
{#each items as item}
  <ItemRow {item} />
{/each}
```

### Summary checklist

When a component is growing large, ask:
- Can any props be replaced with direct selector access?
- Are there `$effect` blocks that should be sagas?
- Are there `{#if}` branches over 30 lines?
- Are there `{#each}` bodies over 10 lines?
- Is shared state being passed down instead of read from the store?

See also: [State Management](./STATE_MANAGEMENT.md)

