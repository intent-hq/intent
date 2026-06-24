<script lang="ts">
  /**
   * WindowTitleBar — Tauri-styled draggable title bar mirroring the reference
   * app's chrome. The bar is the OS drag region (data-tauri-drag-region) and
   * reserves space for the macOS traffic lights via titleBarStyle: "Overlay".
   */
  interface Props {
    title?: string;
  }

  let { title }: Props = $props();

  const isMac = $derived.by(() => {
    if (typeof navigator === 'undefined') return false;
    return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  });

  const heading = $derived(title ?? 'Cloudlands');
</script>

<div
  class="window-title-bar"
  class:window-title-bar-mac={isMac}
  data-tauri-drag-region
  aria-label="Window title bar"
>
  <div></div>
  <span class="pointer-events-none select-none truncate text-xs font-medium text-muted-foreground">
    {heading}
  </span>
  <div></div>
</div>

<style>
  .window-title-bar {
    height: 35px;
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    background: hsl(var(--app-background) / 0.8);
    position: relative;
    z-index: 50;
  }

  .window-title-bar-mac {
    padding-left: 70px; /* Reserve room for macOS traffic lights */
  }
</style>
