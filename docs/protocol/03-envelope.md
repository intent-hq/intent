> Part of the [Intent JSON-RPC protocol docs](./README.md) — §3 Message Envelope (JSON-RPC 2.0).

## 3. Message Envelope (JSON-RPC 2.0)

All application messages are **JSON-RPC 2.0** text frames. The handler is transport-agnostic: it takes a message string and returns a response string (or `null` for notifications).

### 3.1 Request

```json
{ "jsonrpc": "2.0", "id": 1, "method": "note.list", "params": { "workspaceId": "ws-abc" } }
```

- `jsonrpc` — **must** be the string `"2.0"`. Otherwise → `-32600 Invalid Request`.
- `method` — **must** be a non-empty string. Otherwise → `-32600`.
- `id` — string, number, or `null`. Any other type → `-32600`.
- `params` — object (named) or array (positional). **Named (object) params are required by thisAPI.** Positional arrays are *accepted* per spec but coerced to `{}` (so the call runs with noargs). Non-object/array `params` → `-32602 Invalid params`.

### 3.2 Success response

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "notes": [ /* ... */ ] } }
```

`result` is always a JSON **object** (never a bare array/scalar); list endpoints wrap their arrayunder a named key (e.g. `{ "notes": [...] }`, `{ "agents": [...] }`).

### 3.3 Error response

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32602, "message": "Missing required parameter: noteId", "data": { "code": "invalid-params" } } }
```

`error.data` is optional and carries extra context — for `-32603` it may carry the original internal error message (not guaranteed: many shims pass the underlying message through as `message` directly — §9), and some errors attach a structured machine-readable payload (e.g. the `-32005` conflict object, or the `workspace.create` base-ref failure data). **All** `-32602` errors carry an `error.data.code` discriminator: `"not-found"` (the addressed entity does not exist) or `"invalid-params"` (bad/missing parameters), except errors that already attach a more specific code (`base-ref-unresolvable`, `path-invalid`, `destination-exists-non-empty`, `not-a-file`), which keep theirs. Fast-path connection-scope methods handled before the dispatcher (subscriptions, `drafts.*`, `forward.*`, `host.*`, `browser.exec`, `client.hello`) always emit `"invalid-params"`. **Client rule:** the deleted-entity flow requires `error.data.code === "not-found"`; only that code may be treated as "entity deleted" — see §9. See §9 for the code table.

### 3.4 Notifications (no response)

A request **without an **`id`** member** is a notification: the server processes it and returnsnothing. Note the distinction required by JSON-RPC 2.0:

- `id` **absent** → notification → no response is ever sent (even on error / unknown method).
- `id: null` **present** → a normal request that **must** receive a response.

Unknown methods sent as notifications are silently ignored; unknown methods sent as requests get`-32601 Method not found`.

### 3.5 Batching

The server processes **one JSON-RPC object per WebSocket text frame**. JSON-RPC batch *arrays* are **not** supported as a batch unit: a top-level array fails envelope validation (`-32600 Invalid Request: expected an object`). Clients should send one message per frame and correlate responses by `id`. (Independent requests can be pipelined — the server does not require request/response lock-step — but each must be its own frame.)

### 3.6 `workspaceId` scoping

Most methods operate within a workspace. `workspaceId` is read from `params.workspaceId`, fallingback to a connection-level context value if the transport provides one. If neither is present, themethod returns `-32602 "workspaceId is required"`. The workspace/repo/specialist/global methods(e.g. `workspace.list`, `repo.list`, `specialist.list`, `agent.getModels`) do not require it.

