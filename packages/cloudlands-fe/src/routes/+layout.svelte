<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';
  import WindowTitleBar from '$lib/components/layout/WindowTitleBar.svelte';
  import SidebarNav from '$lib/components/layout/SidebarNav.svelte';

  let { children } = $props();

  const workspaceId = $derived(page.params.id as string | undefined);
  const title = $derived(workspaceId ? `Workspace · ${workspaceId}` : 'Cloudlands');
</script>

<div
  class="relative flex h-screen w-screen flex-col overflow-hidden bg-app-background text-foreground"
  aria-label="Application shell"
  data-testid="app-shell"
>
  <WindowTitleBar {title} />

  <div class="flex min-h-0 flex-1">
    <SidebarNav />

    <main
      class="mr-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/30 bg-sidebar shadow-sm"
      aria-label="Main content"
    >
      <div class="min-h-0 flex-1 overflow-auto">
        {@render children?.()}
      </div>
    </main>
  </div>
</div>

<style>
  :global(html, body) {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
</style>
