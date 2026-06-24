<script lang="ts">
  // Workspace detail placeholder — note list/view + data wiring land in T7.
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';

  const id = $derived(page.params.id);
</script>

<div class="flex h-full flex-col gap-4 p-6">
  <header class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <h1 class="truncate text-xl font-semibold tracking-tight">Workspace</h1>
      <p class="truncate text-sm text-muted-foreground">{id}</p>
    </div>
    <Button variant="outline" size="sm" onclick={() => goto('/')}>Home</Button>
  </header>

  <p class="text-sm text-muted-foreground">
    Detail layout and note view land in T7.
  </p>
</div>
