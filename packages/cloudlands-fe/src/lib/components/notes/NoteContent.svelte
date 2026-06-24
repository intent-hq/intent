<script lang="ts">
  /**
   * NoteContent — read-only markdown render of a selected note (T7 slice).
   * Mirrors the reference note view: a titled header over rendered markdown
   * body. Uses marked + DOMPurify (as the reference does) and Tailwind's
   * typography `prose` classes for theme-aligned styling. Editing/comments/
   * tasks are out of scope for this wave.
   */
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import type { Note } from '$lib/client';

  interface Props {
    note: Note;
  }

  let { note }: Props = $props();

  const title = $derived(note.title?.trim() || 'Untitled note');

  // marked.parse is synchronous for our default options; sanitize the HTML
  // before injecting it with @html so untrusted note content can't inject
  // active markup.
  const html = $derived.by(() => {
    const source = note.content ?? '';
    if (!source.trim()) return '';
    const rendered = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(rendered);
  });
</script>

<article class="flex h-full flex-col">
  <header class="border-b border-border/40 px-6 py-4">
    <h1 class="truncate text-lg font-semibold tracking-tight">{title}</h1>
    {#if note.tags && note.tags.length > 0}
      <div class="mt-2 flex flex-wrap gap-1.5">
        {#each note.tags as tag (tag)}
          <span
            class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            {tag}
          </span>
        {/each}
      </div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
    {#if html}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="prose prose-sm dark:prose-invert max-w-none">{@html html}</div>
    {:else}
      <p class="text-sm text-muted-foreground">This note is empty.</p>
    {/if}
  </div>
</article>
