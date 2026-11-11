> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.57 Agent Plugins.

## 5.57 Agent Plugins

This is an **additive contract**. It lets a user install an
[Agent Plugins v1.0.0](https://agent-plugins.org/specification) package once, for
the whole app. Intent loads the plugin's skills and MCP servers itself and gives
them to every provider, so no provider-specific setup is needed.

### Status and discovery

The daemon advertises exactly integer `server.capabilities.agentPlugins: 1`
([client.hello](./client-hello.md)) when it implements this section. Missing or
unknown values mean unsupported. The flag grants no permission.

### Storage and scope

Only the user scope exists. Repository plugins (`<repo>/.agents/plugins`) are
reserved for a later version.

| Path | Content |
| --- | --- |
| `~/.intent/plugins/<name>/` | The plugin folder. `<name>` must equal the manifest `name`. |
| `~/.intent/plugin-data/<name>/` | `PLUGIN_DATA`. Kept across updates. Created before a server starts. |
| `~/.intent/plugins.json` | Daemon-owned registry: `{ plugins: { [name]: { source?, kind?: "path"\|"git", enabled, installedAt? } } }`. |

A non-empty `INTENTD_USER_PLUGINS_DIR` in the daemon environment replaces `~/.intent`
as the base of all three paths (dev sandboxes and test harnesses use it).

A folder placed in `~/.intent/plugins/` by hand loads too. It is enabled unless the
registry disables it, and it has no source, so `plugin.update` refuses it.
Folders whose names start with `.` are ignored.

### Loading

Each plugin is validated as the specification requires. Failures stay at the
narrowest boundary, and each one appears in `diagnostics` (or `error` for a
rejected plugin):

1. A missing or invalid `plugin.json` rejects the plugin (`status: "invalid"`).
   Unknown top-level fields and a non-object `extensions` are reported and ignored.
2. A `skills/` or `mcp.json` that is not valid, or resolves outside the plugin
   root, disables that component type.
3. A skill whose `SKILL.md` is not a regular file inside the root is skipped.
   Only immediate children of `skills/` are scanned.
4. A server entry that breaks the `mcp.json` rules is skipped.

### What agents receive

For an **enabled, valid** plugin:

1. **Skills** join the [§5.34](./agent-aux.md#534-skills--skilllist) catalog as
   `<plugin>:<skill>` with `scope: "user"`. They rank below every directory tier;
   a loose skill with the same full name wins. Plugin folders are watched like the
   user skill roots, so `skills:changed` follows edits.
2. **MCP servers** are ordinary [`mcp.servers`](./mcp-servers.md) entries with
   `id: "plugin:<plugin>/<server>"`, `name: "<plugin>-<server>"` (characters outside
   `[A-Za-z0-9_-]` become `_`) and `plugin: "<plugin>"`. The MCP hub runs them like the
   user's servers, so they have live status, sign-in, the global and per-workspace
   switches, `ws.mcp.*` and a place in every agent session's MCP set. Their definitions
   come from the plugin and cannot be edited or deleted through `mcp.servers.*`.
   `mcp.enableUserServers` gates them too. A user server's name wins a clash.
   - `stdio` servers start as `intentd plugin-exec --cwd <cwd> -- <command> <args…>`,
     because session MCP configs carry no working directory. The environment adds
     `PLUGIN_ROOT` and `PLUGIN_DATA`. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are
     expanded once in `args`, `env` values and `cwd` only.
   - `streamable-http` servers become `transport: "http"`; `sse` stays `"sse"`. Both
     keep their `headers`.
3. **Plugin changes** apply at once: `plugin.install`, `plugin.uninstall` and
   `plugin.toggle` start or stop the plugin's servers in the hub, and `plugin.update`
   restarts them. Running agents see the change at their next launch.

### Methods

All five methods are daemon-global and administrator-only. They take no
`workspaceId`.

```ts
interface PluginInfo {
  name: string;
  status: "ok" | "invalid";
  enabled: boolean;
  path: string;                 // absolute plugin folder
  error?: string;               // status "invalid" only
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];          // omitted when empty
  source?: string;              // install source: folder path or git URL
  sourceKind?: "path" | "git";
  skills: string[];             // skill directory names
  mcpServers: { id: string; name: string; sessionName: string; transport: "stdio" | "streamable-http" | "sse" }[]; // id: the mcp.servers id
  diagnostics: string[];
}
```

| Method | Params | Result |
| --- | --- | --- |
| plugin.list | — | `{ plugins: PluginInfo[] }`, sorted by folder name |
| plugin.install | `source` (req) | `{ plugin: PluginInfo }` |
| plugin.update | `name` (req) | `{ plugin: PluginInfo }` |
| plugin.uninstall | `name` (req), `keepData?` (default `false`) | `{ name, removed: true }` |
| plugin.toggle | `name` (req), `enabled` (req) | `{ plugin: PluginInfo }` |

- **`plugin.install`.** `source` is a git URL (`https://`, `http://`, `ssh://`,
  `git://` or `git@…`) or an absolute folder path (a leading `~/` is expanded).
  A git source is shallow-cloned and its `.git` folder removed; a folder is copied
  without `.git`, with links copied as links. The copy is staged in a hidden folder
  and validated first. An invalid plugin, an unreadable source, a failed clone
  (180 s limit) or an already-installed name is `-32602` and leaves nothing
  behind. The new plugin is enabled.
- **`plugin.update`.** Fetches the recorded source again the same way and swaps
  it in. `enabled` and `PLUGIN_DATA` are kept. A plugin without a recorded source,
  or a source that now has a different `name`, is `-32602`; the old copy stays.
- **`plugin.uninstall`.** Removes the folder and the registry entry, and
  `PLUGIN_DATA` unless `keepData` is `true`.
- **`plugin.toggle`.** Sets `enabled` in the registry.
- An unknown `name` is `-32602` with `data.code: "not-found"`. Mutations are serialized.
