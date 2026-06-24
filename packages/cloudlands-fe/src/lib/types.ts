// Wire-level types mirrored from PROTOCOL.md §5 (method catalog) and §6 (events).
// Only the slice this client covers (workspace.* + note.*) is typed precisely;
// entities keep an index signature so the BE can add fields without breaking us.

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Derived green-dot state (read-only) and dismissible blue-dot flag (PROTOCOL §5.1).
export type WorkspaceActivity = "idle" | "agent_running" | (string & {});
export type WorkspaceAttention = "none" | "unread" | "review_required" | (string & {});

export interface Workspace {
  id: string;
  title?: string;
  activity?: WorkspaceActivity;
  attention?: WorkspaceAttention;
  [key: string]: unknown;
}

export interface NoteSummary {
  id: string;
  title?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface Note extends NoteSummary {
  content?: string;
}

export interface EventActor {
  type: "user" | "agent" | "system" | "external" | "tool";
  id?: string;
  name?: string;
}

// The `event` object carries exactly these members (PROTOCOL §6.3).
export interface ServerEvent<D = Record<string, unknown>> {
  type: string;
  workspaceId?: string;
  id: string;
  timestamp: string;
  actor: EventActor;
  data: D;
}

// Payload of the bridged `events.event` notification (PROTOCOL §6.3).
export interface EventNotification {
  subscriptionId: string;
  event: ServerEvent;
}

// Typed method map for the slice this client covers. `params`/`result` mirror
// the PROTOCOL §5.1/§5.2 tables plus the §6.1/§6.2 subscription methods.
export interface RpcMethods {
  "workspace.list": {
    params: { includeArchived?: boolean };
    result: { workspaces: Workspace[] };
  };
  "workspace.get": {
    params: { workspaceId: string };
    result: { workspace: Workspace };
  };
  "workspace.dismissAttention": {
    params: { workspaceId: string };
    result: { workspace: Workspace };
  };
  "workspace.markSeen": {
    params: { workspaceId: string };
    result: { workspace: Workspace };
  };
  "note.list": {
    params: { workspaceId: string };
    result: { notes: NoteSummary[] };
  };
  "note.get": {
    params: { workspaceId: string; noteId: string };
    result: { note: Note };
  };
  "events.subscribe": {
    params: { eventTypes: string[]; workspaceId?: string; replaceGroup?: string };
    result: { subscriptionId: string };
  };
  "events.unsubscribe": {
    params: { subscriptionId: string };
    result: { success: boolean };
  };
}

export type RpcMethod = keyof RpcMethods;
