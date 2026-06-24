<script lang="ts">
  // Home-specific workspace card. Mirrors the reference table row's leading
  // status dots (green = agent running, blue = needs attention) + title, but as
  // a self-contained card surface driven by the typed Workspace entity.
  import Card from '$lib/components/ui/Card.svelte';
  import type { Workspace } from '$lib/client';

  interface Props {
    workspace: Workspace;
    onOpen: (workspace: Workspace, event: MouseEvent) => void;
  }

  let { workspace, onOpen }: Props = $props();

  const title = $derived(workspace.title?.trim() || 'Untitled');
  const isRunning = $derived(workspace.activity === 'agent_running');
  const needsAttention = $derived(
    workspace.attention === 'unread' || workspace.attention === 'review_required',
  );
  const attentionLabel = $derived(
    workspace.attention === 'review_required' ? 'Review required' : 'Unread updates',
  );
</script>

<Card class="overflow-hidden p-0">
  <button
    type="button"
    class="group flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onclick={(e) => onOpen(workspace, e)}
  >
    <span class="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden="true">
      {#if isRunning}
        <span class="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-success/60"></span>
        <span class="relative inline-flex h-2 w-2 rounded-full bg-success"></span>
      {:else}
        <span class="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40"></span>
      {/if}
    </span>

    <span class="min-w-0 flex-1">
      <span
        class="block truncate text-sm font-medium {workspace.title
          ? 'text-foreground'
          : 'text-muted-foreground'}"
        {title}
      >
        {title}
      </span>
      <span class="block truncate text-xs text-muted-foreground">{workspace.id}</span>
    </span>

    {#if needsAttention}
      <span
        class="h-2 w-2 shrink-0 rounded-full bg-ring"
        title={attentionLabel}
        aria-label={attentionLabel}
      ></span>
    {/if}
  </button>
</Card>
