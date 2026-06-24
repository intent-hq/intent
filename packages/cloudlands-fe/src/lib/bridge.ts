// Low-level boundary to the T2 Rust bridge (src-tauri). All Tauri coupling lives
// here so the names are easy to realign and the data layer stays testable.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EventNotification, JsonRpcError } from "./types";

// --- Bridge contract (matches src-tauri/src/rpc.rs from T2). ---
// Tauri command: rpc_call({ method, params }) -> result (rejects with JsonRpcError).
export const RPC_COMMAND = "rpc_call";
// Tauri event forwarding the server's `events.event` notification params (§6.3),
// i.e. `{ subscriptionId, event }`.
export const EVENT_CHANNEL = "intentd://event";
// Connection-status event emitted on (dis)connect; drives re-fetch on reconnect
// (§4). The transport itself replays tracked `events.subscribe` calls.
export const CONNECTION_CHANNEL = "intentd://status";

export interface ConnectionStatus {
  connected: boolean;
  error?: string;
}

// True only inside the Tauri webview; lets a plain-browser dev page degrade
// gracefully instead of throwing at module load.
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function bridgeRpc<R>(
  method: string,
  params: Record<string, unknown>,
): Promise<R> {
  if (!isTauri()) {
    throw {
      code: -32603,
      message: "Tauri bridge unavailable (not running in the desktop app)",
    } satisfies JsonRpcError;
  }
  try {
    return (await invoke(RPC_COMMAND, { method, params })) as R;
  } catch (err) {
    throw normalizeError(err);
  }
}

export function onServerEvent(
  handler: (notification: EventNotification) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(noop);
  return listen<EventNotification>(EVENT_CHANNEL, (e) => handler(e.payload));
}

export function onConnectionChange(
  handler: (status: ConnectionStatus) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(noop);
  return listen<ConnectionStatus>(CONNECTION_CHANNEL, (e) => handler(e.payload));
}

function noop(): void {}

function normalizeError(err: unknown): JsonRpcError {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return err as JsonRpcError;
  }
  return {
    code: -32603,
    message: typeof err === "string" ? err : "Bridge call failed",
    data: err,
  };
}
