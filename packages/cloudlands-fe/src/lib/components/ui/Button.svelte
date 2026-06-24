<script lang="ts">
  // Lightweight button primitive (no shadcn). Variants/sizes map to theme tokens.
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Variant = 'default' | 'secondary' | 'outline' | 'ghost';
  type Size = 'sm' | 'md' | 'icon';

  interface Props extends HTMLButtonAttributes {
    variant?: Variant;
    size?: Size;
    class?: string;
    children?: Snippet;
  }

  let {
    variant = 'default',
    size = 'md',
    class: className = '',
    children,
    ...rest
  }: Props = $props();

  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium ' +
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
    'disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

  const variants: Record<Variant, string> = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
    outline: 'border border-border bg-transparent hover:bg-muted',
    ghost: 'bg-transparent hover:bg-muted text-foreground',
  };

  const sizes: Record<Size, string> = {
    sm: 'h-7 px-2.5 text-xs',
    md: 'h-9 px-4 text-sm',
    icon: 'h-9 w-9',
  };
</script>

<button class={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
  {@render children?.()}
</button>
