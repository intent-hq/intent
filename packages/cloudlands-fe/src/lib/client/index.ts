// Public entry point for the thin reactive client (the redux/saga replacement).
export { rpc } from "../rpc";
export { eventBus, typeMatches, type Subscription } from "../events";
export {
  isTauri,
  type ConnectionStatus,
  RPC_COMMAND,
  EVENT_CHANNEL,
  CONNECTION_CHANNEL,
} from "../bridge";
export {
  WorkspacesStore,
  createWorkspacesStore,
} from "../stores/workspaces.svelte";
export { NotesStore, createNotesStore } from "../stores/notes.svelte";
export type {
  Workspace,
  WorkspaceActivity,
  WorkspaceAttention,
  Note,
  NoteSummary,
  ServerEvent,
  EventNotification,
  JsonRpcError,
  RpcMethods,
  RpcMethod,
} from "../types";
