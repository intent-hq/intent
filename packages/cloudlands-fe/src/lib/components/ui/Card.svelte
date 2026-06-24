<script lang="ts">
  // Lightweight card surface primitive (no shadcn).
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    class?: string;
    children?: Snippet;
  }

  let { class: className = '', children, ...rest }: Props = $props();
</script>

<div
  class={`rounded-lg border border-border/60 bg-card text-card-foreground shadow-sm ${className}`}
  {...rest}
>
  {@render children?.()}
</div>
