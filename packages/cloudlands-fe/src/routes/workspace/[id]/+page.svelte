<script lang="ts">
  /**
   * Workspace detail + note view (T7). Shows a workspace and its notes via the
   * T4 reactive client: NotesStore drives note.list / note.get over the bridge,
   * and a one-shot workspace.get supplies the header title. Two-pane layout
   * mirrors the reference (note list rail + rendered markdown body), with
   * loading / empty / error states. Read-only — editing lands in later waves.
   */
  import { onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { createNotesStore, rpc, isTauri, type Workspace } from '$lib/client';
  import Button from '$lib/components/ui/Button.svelte';
  import NoteList from '$lib/components/notes/NoteList.svelte';
  import NoteContent from '$lib/components/notes/NoteContent.svelte';

  const store = createNotesStore();
  const id = $derived(page.params.id as string);

  let selectedId = $state<string | null>(null);
  let workspace = $state<Workspace | null>(null);

  const heading = $derived(workspace?.title?.trim() || id);

  // (Re-)open the store and reload the header whenever the route id changes.
  let openedId: string | null = null;
  $effect(() => {
    const next = id;
    if (next === openedId) return;
    openedId = next;
    selectedId = null;
    workspace = null;
    void store.open(next);
    void loadWorkspace(next);
  });

  async function loadWorkspace(workspaceId: string): Promise<void> {
    try {
      const { workspace: ws } = await rpc('workspace.get', { workspaceId });
      if (openedId === workspaceId) workspace = ws;
    } catch {
      // Header falls back to the id; note errors surface via the store.
    }
  }

  // Auto-select the first note once the list loads and nothing is selected.
  $effect(() => {
    if (!selectedId && store.notes.length > 0) {
      handleSelect(store.notes[0].id);
    }
  });

  function handleSelect(noteId: string): void {
    selectedId = noteId;
    void store.select(noteId);
  }

  onDestroy(() => store.stop());
</script>

<div class="flex h-full flex-col">
  <header
    class="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border/40 px-6 py-4"
  >
    <div class="min-w-0">
      <h1 class="truncate text-xl font-semibold tracking-tight">{heading}</h1>
      <p class="truncate text-sm text-muted-foreground">{id}</p>
    </div>
    <Button variant="outline" size="sm" onclick={() => goto('/')}>Home</Button>
  </header>

  {#if !isTauri()}
    <div class="p-6 text-sm text-muted-foreground">
      Running outside the Tauri webview — the bridge is unavailable, so notes
      can't load. Launch via <code>pnpm tauri dev</code> against a running
      <code>intentd</code> to see live data.
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <aside class="w-64 flex-shrink-0 border-r border-border/40 bg-sidebar/40">
        {#if store.loading && store.notes.length === 0}
          <p class="px-3 py-4 text-sm text-muted-foreground">Loading notes…</p>
        {:else if store.notes.length === 0}
          <p class="px-3 py-4 text-sm text-muted-foreground">No notes yet.</p>
        {:else}
          <NoteList notes={store.notes} {selectedId} onSelect={handleSelect} />
        {/if}
      </aside>

      <section class="min-h-0 flex-1">
        {#if store.error}
          <p class="p-6 text-sm text-destructive-foreground">Error: {store.error}</p>
        {:else if store.note}
          <NoteContent note={store.note} />
        {:else if store.loading}
          <p class="p-6 text-sm text-muted-foreground">Loading note…</p>
        {:else if store.notes.length === 0}
          <p class="p-6 text-sm text-muted-foreground">
            This workspace has no notes to display.
          </p>
        {:else}
          <p class="p-6 text-sm text-muted-foreground">Select a note to view it.</p>
        {/if}
      </section>
    </div>
  {/if}
</div>
