<script lang="ts">
  // Minimal demo binding for the T4 reactive client (data layer only — the real
  // home/detail screens land in T5–T7). Proves rpc('workspace.list') returns
  // typed data and that the store re-renders when an events.event arrives.
  import { onDestroy, onMount } from "svelte";
  import { createWorkspacesStore, isTauri } from "$lib/client";

  const store = createWorkspacesStore();

  onMount(() => {
    void store.start();
  });
  onDestroy(() => store.stop());
</script>

<main class="flex min-h-screen flex-col gap-4 bg-background p-6 text-foreground">
  <header class="flex items-center justify-between">
    <h1 class="text-xl font-semibold tracking-tight text-primary">
      Reactive client demo
    </h1>
    <button
      class="rounded border border-border px-3 py-1 text-sm hover:bg-muted"
      onclick={() => store.refresh()}
    >
      Refresh
    </button>
  </header>

  {#if !isTauri()}
    <p class="text-sm text-muted-foreground">
      Running outside the Tauri webview — the bridge is unavailable, so RPC calls
      will error. Launch via <code>pnpm tauri dev</code> against a running
      <code>intentd</code> to see live data.
    </p>
  {/if}

  <section class="text-sm text-muted-foreground">
    {#if store.loading}
      <span>Loading workspaces…</span>
    {:else if store.error}
      <span class="text-destructive">Error: {store.error}</span>
    {:else}
      <span>{store.workspaces.length} workspace(s) — live via events.event</span>
    {/if}
  </section>

  <ul class="flex flex-col gap-2">
    {#each store.workspaces as workspace (workspace.id)}
      <li class="rounded border border-border px-3 py-2">
        <span class="font-medium">{workspace.title ?? workspace.id}</span>
        <span class="ml-2 text-xs text-muted-foreground">
          activity: {workspace.activity ?? "—"} · attention:
          {workspace.attention ?? "—"}
        </span>
      </li>
    {/each}
  </ul>
</main>
