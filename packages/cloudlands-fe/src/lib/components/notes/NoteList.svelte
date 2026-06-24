<script lang="ts">
  /**
   * NoteList — left rail listing a workspace's notes (T7 slice). Mirrors the
   * reference Notes panel: a titled list of selectable note rows. Selection is
   * owned by the parent; this component is presentational.
   */
  import type { NoteSummary } from '$lib/client';

  interface Props {
    notes: NoteSummary[];
    selectedId: string | null;
    onSelect: (noteId: string) => void;
  }

  let { notes, selectedId, onSelect }: Props = $props();

  function titleOf(note: NoteSummary): string {
    return note.title?.trim() || 'Untitled note';
  }
</script>

<nav class="flex h-full flex-col" aria-label="Notes">
  <div
    class="flex h-9 flex-shrink-0 items-center px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
  >
    Notes
  </div>
  <ul class="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
    {#each notes as note (note.id)}
      <li>
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
          class:bg-muted={selectedId === note.id}
          class:text-foreground={selectedId === note.id}
          class:text-muted-foreground={selectedId !== note.id}
          aria-current={selectedId === note.id ? 'true' : undefined}
          onclick={() => onSelect(note.id)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            width="15"
            height="15"
            class="flex-shrink-0 text-ghost"
            aria-hidden="true"
          >
            <path
              d="M6 3.5h8L18.5 8v12.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"
              stroke-linejoin="round"
            />
            <path d="M13.5 3.5V8h4.5" stroke-linejoin="round" />
          </svg>
          <span class="truncate">{titleOf(note)}</span>
        </button>
      </li>
    {/each}
  </ul>
</nav>
