<script lang="ts">
  /**
   * SidebarNav — left navigation rail mirroring the reference app's global nav.
   * Lightweight: client-side routing via goto, active state derived from the
   * current path. Data-driven workspace entries land in T6.
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  interface NavItem {
    label: string;
    href: string;
    match: (path: string) => boolean;
  }

  const items: NavItem[] = [
    { label: 'Home', href: '/', match: (p) => p === '/' },
    { label: 'Demo', href: '/demo', match: (p) => p.startsWith('/demo') },
  ];

  const path = $derived(page.url.pathname);
</script>

<nav class="sidebar-nav" aria-label="Primary navigation">
  <div class="logo" aria-hidden="true">C</div>

  {#each items as item (item.href)}
    <button
      class="nav-item"
      class:active={item.match(path)}
      aria-label={item.label}
      aria-current={item.match(path) ? 'page' : undefined}
      onclick={() => goto(item.href)}
    >
      {#if item.href === '/'}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="20" height="20">
          <path d="M3 11.5 12 4l9 7.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="20" height="20">
          <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
          <path d="M8 12h8M12 8v8" stroke-linecap="round" />
        </svg>
      {/if}
    </button>
  {/each}
</nav>

<style>
  .sidebar-nav {
    width: 56px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    background: hsl(var(--sidebar));
  }

  .logo {
    width: 32px;
    height: 32px;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-weight: 700;
    color: hsl(var(--primary-foreground));
    background: hsl(var(--primary));
  }

  .nav-item {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: hsl(var(--muted-foreground));
    background: transparent;
    cursor: pointer;
    transition:
      color 0.15s ease,
      background 0.15s ease;
  }

  .nav-item:hover {
    color: hsl(var(--foreground));
    background: hsl(var(--muted) / 0.5);
  }

  .nav-item.active {
    color: hsl(var(--primary));
    background: hsl(var(--muted) / 0.6);
  }
</style>
