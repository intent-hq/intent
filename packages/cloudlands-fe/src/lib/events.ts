// Event-subscription layer — the redux-saga replacement for live server state.
// Implements subscribe-then-fetch (PROTOCOL §10.2). Subscriptions are
// per-connection and do not survive a disconnect; the Rust transport (T2)
// replays tracked `events.subscribe` calls on reconnect, so this layer only
// re-fetches canonical state when the connection comes back (§4 / §10.2).
import {
  onConnectionChange,
  onServerEvent,
  type ConnectionStatus,
} from "./bridge";
import { rpc } from "./rpc";
import type { ServerEvent } from "./types";

export interface Subscription {
  // Event-type filters, exact (`note:updated`) or `prefix:*` wildcards (§6.4).
  eventTypes: string[];
  // Scope delivery to one workspace; omit for all workspaces the connection sees.
  workspaceId?: string;
  // Called for each matching event.
  onEvent: (event: ServerEvent) => void;
  // Called on reconnect (after the transport replays subscriptions) so the
  // store can re-fetch canonical state (§10.2).
  onResync?: () => void;
}

// §6.4 filter semantics: exact match or `prefix:*` starts-with.
export function typeMatches(filter: string[], type: string): boolean {
  return filter.some((f) =>
    f.endsWith(":*") ? type.startsWith(f.slice(0, -1)) : f === type,
  );
}

class EventBus {
  private subs = new Set<Subscription>();
  private ids = new Map<Subscription, string>();
  private started = false;
  private wasConnected = true;

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await onServerEvent((n) => this.dispatch(n.event));
    await onConnectionChange((s) => this.handleConnection(s));
  }

  private dispatch(event: ServerEvent): void {
    for (const sub of this.subs) {
      if (
        sub.workspaceId &&
        event.workspaceId &&
        sub.workspaceId !== event.workspaceId
      ) {
        continue;
      }
      if (typeMatches(sub.eventTypes, event.type)) sub.onEvent(event);
    }
  }

  private handleConnection(status: ConnectionStatus): void {
    const reconnected = status.connected && !this.wasConnected;
    this.wasConnected = status.connected;
    if (!reconnected) return;
    // The transport replays tracked subscriptions itself, so we only re-fetch
    // canonical state to fill any gap during the disconnect (§10.1 / §10.2).
    for (const sub of this.subs) sub.onResync?.();
  }

  private async serverSubscribe(sub: Subscription): Promise<void> {
    try {
      const { subscriptionId } = await rpc("events.subscribe", {
        eventTypes: sub.eventTypes,
        workspaceId: sub.workspaceId,
      });
      this.ids.set(sub, subscriptionId);
    } catch {
      // Best-effort: if the bridge is offline the transport replays this
      // subscription once it (re)connects (T2), and onResync re-fetches.
    }
  }

  // Register a subscription: attach the listener, issue events.subscribe, then
  // the caller fetches. Returns an unsubscribe disposer.
  async add(sub: Subscription): Promise<() => void> {
    await this.ensureStarted();
    this.subs.add(sub);
    await this.serverSubscribe(sub);
    return () => this.remove(sub);
  }

  private remove(sub: Subscription): void {
    this.subs.delete(sub);
    const id = this.ids.get(sub);
    this.ids.delete(sub);
    if (id) void rpc("events.unsubscribe", { subscriptionId: id }).catch(() => {});
  }
}

// Shared singleton: one Tauri listener fans out to every registered store.
export const eventBus = new EventBus();
