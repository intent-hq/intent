// Reactive workspaces store (Svelte 5 runes) — replaces the reference app's
// redux workspace slice + saga for this slice. Subscribe-then-fetch (§10.2),
// then reconcile to canonical state on each event (§10.1).
import { eventBus } from "../events";
import { rpc } from "../rpc";
import type { ServerEvent, Workspace } from "../types";

interface StartOptions {
  includeArchived?: boolean;
}

export class WorkspacesStore {
  workspaces = $state<Workspace[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  hasLoaded = $state(false);

  #stop: (() => void) | null = null;
  #options: StartOptions = {};

  // Subscribe BEFORE the initial fetch so no change is missed in the gap (§10.2).
  async start(options: StartOptions = {}): Promise<void> {
    this.#options = options;
    this.#stop = await eventBus.add({
      eventTypes: ["workspace:*"],
      onEvent: (event) => this.apply(event),
      onResync: () => void this.refresh(),
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      const { workspaces } = await rpc("workspace.list", {
        includeArchived: this.#options.includeArchived ?? false,
      });
      this.workspaces = workspaces;
      this.hasLoaded = true;
      this.error = null;
    } catch (err) {
      this.error = messageOf(err, "Failed to load workspaces");
    } finally {
      this.loading = false;
    }
  }

  // Apply a single events.event to local state. workspace:* events carry only
  // ids/field deltas, so non-status changes reconcile via workspace.get (§10.1).
  apply(event: ServerEvent): void {
    const data = event.data as {
      workspaceId?: string;
      workspace?: Workspace;
      activity?: Workspace["activity"];
      attention?: Workspace["attention"];
    };
    const id = data.workspaceId;
    switch (event.type) {
      case "workspace:deleted":
        if (id) this.workspaces = this.workspaces.filter((w) => w.id !== id);
        break;
      case "workspace:activity-changed":
        if (id) this.#patch(id, { activity: data.activity });
        break;
      case "workspace:attention-changed":
        if (id) this.#patch(id, { attention: data.attention });
        break;
      default:
        // created / updated / opened / closed / activity → reconcile.
        if (data.workspace) this.#upsert(data.workspace);
        else if (id) void this.#fetchOne(id);
    }
  }

  async #fetchOne(id: string): Promise<void> {
    try {
      const { workspace } = await rpc("workspace.get", { workspaceId: id });
      this.#upsert(workspace);
    } catch {
      // Workspace may have been removed between event and fetch — ignore.
    }
  }

  #upsert(workspace: Workspace): void {
    const i = this.workspaces.findIndex((w) => w.id === workspace.id);
    if (i === -1) {
      this.workspaces = [...this.workspaces, workspace];
    } else {
      const next = this.workspaces.slice();
      next[i] = { ...next[i], ...workspace };
      this.workspaces = next;
    }
  }

  #patch(id: string, changes: Partial<Workspace>): void {
    const i = this.workspaces.findIndex((w) => w.id === id);
    if (i === -1) return;
    const next = this.workspaces.slice();
    next[i] = { ...next[i], ...changes };
    this.workspaces = next;
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }
}

export function messageOf(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

export function createWorkspacesStore(): WorkspacesStore {
  return new WorkspacesStore();
}
