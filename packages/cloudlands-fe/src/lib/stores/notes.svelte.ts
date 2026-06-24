// Reactive notes store (Svelte 5 runes) — workspace-scoped notes list plus the
// currently selected note. Subscribe-then-fetch per workspace (§10.2); note:*
// events carry only noteId/action, so updates reconcile via fetch (§10.1).
import { eventBus } from "../events";
import { rpc } from "../rpc";
import { messageOf } from "./workspaces.svelte";
import type { Note, NoteSummary, ServerEvent } from "../types";

export class NotesStore {
  notes = $state<NoteSummary[]>([]);
  note = $state<Note | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  #workspaceId: string | null = null;
  #selectedId: string | null = null;
  #stop: (() => void) | null = null;

  // Open a workspace: re-subscribe scoped to it, then fetch its notes.
  async open(workspaceId: string): Promise<void> {
    this.stop();
    this.#workspaceId = workspaceId;
    this.note = null;
    this.notes = [];
    this.#stop = await eventBus.add({
      eventTypes: ["note:*"],
      workspaceId,
      onEvent: (event) => this.apply(event),
      onResync: () => void this.refresh(),
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.#workspaceId) return;
    this.loading = true;
    try {
      const { notes } = await rpc("note.list", {
        workspaceId: this.#workspaceId,
      });
      this.notes = notes;
      this.error = null;
      if (this.#selectedId) await this.select(this.#selectedId);
    } catch (err) {
      this.error = messageOf(err, "Failed to load notes");
    } finally {
      this.loading = false;
    }
  }

  async select(noteId: string): Promise<void> {
    this.#selectedId = noteId;
    if (!this.#workspaceId) return;
    try {
      const { note } = await rpc("note.get", {
        workspaceId: this.#workspaceId,
        noteId,
      });
      this.note = note;
      this.error = null;
    } catch (err) {
      this.error = messageOf(err, "Failed to load note");
    }
  }

  apply(event: ServerEvent): void {
    const id = (event.data as { noteId?: string }).noteId;
    if (event.type === "note:deleted") {
      if (!id) return;
      this.notes = this.notes.filter((n) => n.id !== id);
      if (this.#selectedId === id) {
        this.#selectedId = null;
        this.note = null;
      }
      return;
    }
    // note:created / note:updated → re-fetch the list (and selected note, which
    // refresh() re-selects) to reconcile against canonical state (§10.1).
    void this.refresh();
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }
}

export function createNotesStore(): NotesStore {
  return new NotesStore();
}
