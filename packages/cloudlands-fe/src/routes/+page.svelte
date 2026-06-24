<script lang="ts">
  // Home / workspace-list screen (T6). Binds the T4 reactive WorkspacesStore
  // (subscribe-then-fetch over workspace.list, live-reconciled on workspace:*
  // events) to a grid of cards. Clicking a card opens /workspace/[id].
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { createWorkspacesStore, isTauri, type Workspace } from '$lib/client';
  import Button from '$lib/components/ui/Button.svelte';
  import WorkspaceCard from '$lib/components/home/WorkspaceCard.svelte';

  const store = createWorkspacesStore();

  onMount(() => {
    void store.start();
  });
  onDestroy(() => store.stop());

  const showSkeleton = $derived(!store.hasLoaded && store.loading);
  const isEmpty = $derived(store.hasLoaded && !store.error && store.workspaces.length === 0);

  function openWorkspace(workspace: Workspace) {
    void goto(`/workspace/${workspace.id}`);
  }
</script>

<div class="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 px-8 py-12">
  <header class="flex items-baseline justify-between gap-4">
    <h1 class="text-2xl font-medium tracking-tight">Workspaces</h1>
    <Button variant="outline" size="sm" onclick={() => store.refresh()} disabled={store.loading}>
      Refresh
    </Button>
  </header>

  {#if !isTauri()}
    <p class="rounded-md border border-border/60 bg-card p-3 text-xs text-muted-foreground">
      Running outside the Tauri webview — the bridge is unavailable, so workspaces
      can't load. Launch via <code>pnpm tauri dev</code> against a running
      <code>intentd</code> to see live data.
    </p>
  {/if}

  {#if showSkeleton}
    <div class="flex flex-col gap-3" aria-busy="true" aria-label="Loading workspaces">
      {#each [0, 1, 2, 3] as i (i)}
        <div class="h-[58px] animate-pulse rounded-lg border border-border/60 bg-muted/40"></div>
      {/each}
    </div>
  {:else if store.error}
    <div
      class="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/30 p-4"
    >
      <div>
        <p class="text-sm font-medium text-destructive-foreground">Failed to load workspaces</p>
        <p class="mt-1 text-xs text-destructive-foreground/80">{store.error}</p>
      </div>
      <Button variant="outline" size="sm" onclick={() => store.refresh()}>Try again</Button>
    </div>
  {:else if isEmpty}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 p-12 text-center"
    >
      <p class="text-sm font-medium text-foreground">No workspaces yet</p>
      <p class="max-w-sm text-sm text-muted-foreground">
        Workspaces from the connected <code>intentd</code> daemon will appear here.
      </p>
    </div>
  {:else}
    <div class="flex flex-col gap-3">
      {#each store.workspaces as workspace (workspace.id)}
        <WorkspaceCard {workspace} onOpen={openWorkspace} />
      {/each}
    </div>
  {/if}
</div>
