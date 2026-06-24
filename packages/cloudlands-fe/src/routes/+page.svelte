<script lang="ts">
  // Home placeholder — the workspace-list screen lands in T6. Provides a
  // demonstrable navigation entry into a workspace route for now.
  import { goto } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';
</script>

<div class="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-primary">Cloudlands</h1>
    <p class="mt-2 text-sm text-muted-foreground">
      App shell ready — workspace list lands in T6.
    </p>
  </div>

  <Card class="w-full max-w-sm p-4">
    <p class="text-sm text-muted-foreground">Open a sample workspace route:</p>
    <Button class="mt-3 w-full" onclick={() => goto('/workspace/demo')}>
      Open workspace
    </Button>
  </Card>
</div>
