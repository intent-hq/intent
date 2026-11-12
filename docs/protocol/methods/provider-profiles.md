> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.54 Provider profiles (prepared).

### 5.54 Provider profiles *(prepared)*

This is a **prepared contract** for named configurations of an installed Codex or
Claude Code CLI. It is not implemented by the current pins. Each profile has a
stable identity, a display name, a base provider and environment overrides. A
profile shares its base provider's installation, executable path and enablement.
Each profile has its own Fast mode preference (see
[References in settings](#references-in-settings)). The original configuration stays available as **Default**
and is not a profile. Default can still be renamed and carry its own environment
overrides (see [Default configuration overrides](#default-configuration-overrides)).
Hosts with no profiles keep their current behavior.

Profiles of one base provider have a saved order, and any of them can be marked as a
**backup**. When a turn fails because its provider ran out of quota, the daemon
retries it on the next backup profile of the same base provider, and later returns
the conversation to the provider it started on (see
[Backup failover](#backup-failover)). The Default configuration is never a backup
and has no position in the order.

#### Identity and provider references

A **profile id** is minted by the daemon on create. It is immutable, never reused
and opaque to clients. It matches `^[a-z0-9][a-z0-9-]{0,31}$`; the daemon mints
`p` followed by 12 random lowercase base-32 characters, for example `p3k9x2m4q7t1a`.
The editable name is never an identifier.

A **provider reference** names the configuration that runs a selection:

| Reference | Meaning |
| --- | --- |
| `codex`, `claude-code` (bare, canonical id) | Default configuration. This is the legacy form and remains valid everywhere. |
| `<baseProviderId>@<profileId>`, for example `codex@p3k9x2m4q7t1a` | That named profile |

The qualified form is valid only with a canonical base id that advertises
`supportsProfiles: true` (`codex` or `claude-code`). Legacy aliases, other
providers, case variants, whitespace and extra `@` characters are invalid. Clients
read the reference from `ProviderProfile.providerRef` and never compose it from a name.

The reference travels in the **existing provider fields**. No parallel
`profileId` field exists:

- `agent.create`, `agent.setModel`, `agent.delegate` and workspace/agent creation `provider` params (§5.5)
- `AgentLite` / `AgentSession` `provider` and `last_turn_provider`-derived event fields
- `model.defaultProvider` and `model.providerDefaults` keys (§5.12)
- `quickActions.providerSettings` snapshot keys (client-owned, keyed like other provider ids)
- specialist frontmatter `provider` and `modelOptions[].provider` (§5.11)
- `models.list` `providerId` and `ModelInfo.provider` (§5.30)
- `host.providerAuthStatus` and `host.providerTestPrompt` `providerId` (§5.14)

`providers.enabled` and `providers.paths` stay keyed by the base provider id. Qualified references are rejected there; a profile inherits
those values from its base provider. `providers.fastMode` is the exception: its keys
also accept profile references, and a profile never inherits its base provider's
entry (see [References in settings](#references-in-settings)).

**Why one field.** The call-site survey found these properties at the pins:

- Current daemons reject an unregistered `provider` at `agent.create`, `agent.setModel`
  and `agent.delegate` with `-32602` (`ensure_known_provider`). `host.providerAuthStatus`
  also rejects one. A newer client talking to an older daemon therefore fails loudly.
  An older daemon would instead **silently drop** an unknown `profileId` param and run
  on the Default account.
- Older clients round-trip provider strings unchanged. Examples are whole-value
  `model.providerDefaults` writes, specialist `modelOptions` rewrites in the frontend
  file loader, and `quickActions.providerSettings` snapshots. A separate sibling field
  would be lost whenever an older client rewrites one of these objects.
- An older daemon reads an unknown `model.defaultProvider` as unset. Agent creation
  then fails with the no-default-provider error rather than choosing the Default
  account.

**Why `@`.** `:` is the legacy compound `provider:model` separator. The daemon's
settings normalizer, specialist `modelOptions` parsing and the frontend's
`splitLegacyCompoundId` all split on the first `:`. `.` separates dotted setting
paths such as `voice.openai.model`. No registered provider id contains `@`.
Some model ids do, such as Vertex AI Claude ids like `claude-…@20250514`. That is
harmless because references appear only in provider fields and model ids remain
separate bare fields; clients must never parse a reference out of a model id.

**Downgrade behavior.** An older daemon still starts. It never reads the profile
file below, and it does not validate provider strings while parsing `config.toml`
(`SettingsFile::validate` checks neither `model.defaultProvider` nor
`model.providerDefaults` keys). The secret-store entries are inert. Saved
references then fail later, at the point of use:

- **Default provider setting** (`model.defaultProvider`): read as unset. Agent
  creation without an explicit provider and delegation fallback fail with the
  no-default-provider error, and quick actions report unavailable.
- **Provider default model keys** (`model.providerDefaults`): never looked up, so
  they are inert.
- **Specialist provider pin**: `agent.create` and `agent.delegate` fail with
  `-32602` unknown provider.
- **Specialist model options** (`modelOptions[].provider`): the option never
  matches a provider, so it is not applied.
- **Persisted conversation provider**: the spawn path's unknown-provider fallback
  runs the first registered provider (`auggie`) with a warning, or fails if it is
  not installed.

None of these routes to the base provider's Default account. The last row runs a
different provider, so downgrading with profiled conversations is unsupported:
select a model again after a downgrade.

#### Storage

| Data | Location | Exposure |
| --- | --- | --- |
| `id`, `name`, `baseProviderId`, timestamps, `backup`, order | Daemon-owned file `<data_dir>/provider-profiles.json` (mode `0600`, next to `config.toml`): `{ "version": 1, "profiles": [{ "id", "baseProvider", "name", "createdAt", "updatedAt", "backup"? }] }` | Only through `providers.profiles.*`. Not a `settings.*` path: `settings.get` / `settings.reset` return `-32602`, and `settings.update` rejects it. |
| Remote-compatible choices | Daemon-owned file `<data_dir>/provider-remote-compatible.json` (mode `0600`, see Remote-compatible choices below) | Only through `providers.profiles.*` reads and writes |
| Environment entries | Existing protected `SecretStore`, account `providerProfiles.<profileId>.env`, one JSON document per profile | Only through `providers.profiles.*` reads, masked except the folder-path keys (see [Folder paths on reads](#folder-paths-on-reads)) |

The metadata stays out of `config.toml` because `SettingsFile` denies unknown fields
and `Config::resolve` fails startup on a malformed file. A new table there would stop
an older daemon from starting. A separate file is also preferred over SQLite. Older
daemons ignore an unknown data-dir file, while a schema migration is irreversible and
blocks hash-built test installs (see the monorepo AGENTS.md manual-build exception).
The file is reached only through the administrator-only `providers.profiles.*`
service, the same authorization boundary as `settings.*`. It holds no secrets, so no
redaction applies. Deleting the file removes every profile.

- **Writes.** The daemon writes the file atomically (temp file, fsync, rename) and
  serializes all profile mutations. Create writes the secret entry before the
  metadata and removes the secret if the metadata write fails. Delete removes the
  metadata before the secret. A secret entry with no metadata is inert.
- **Orphan cleanup.** The secret store (`~/intent/.secrets.json`) is one file shared by
  every daemon of the user, dev sandboxes included. The profile file belongs to one
  data dir, so the daemon never removes `providerProfiles.*` secrets wholesale; that
  could delete another daemon's profiles. Instead:
  - Before each create or delete, the daemon records the profile id in an optional
    `pendingEnvCleanup: string[]` member of its own profile file.
  - It drops the id once the mutation completes. The member is omitted when empty, so
    the file normally has exactly the shape above.
  - At startup, the daemon removes the secret entry only for recorded ids that have no
    metadata, then clears the list.
  - A secret orphaned some other way stays inert and is never swept.
- **Order.** The order of one base provider's entries in the `profiles` array is that
  base provider's saved order. Create appends. `reorder` permutes only that base
  provider's entries and leaves other base providers' entries where they are.
- **Backup flag.** `backup` is written only while `true`; an absent member reads as
  `false`. The file `version` stays `1`, so files without the member load unchanged.
- **Remote-compatible choices.** The saved [remote-compatible](#remote-compatibility)
  choices live in a second daemon-owned file,
  `<data_dir>/provider-remote-compatible.json` (mode `0600`):
  `{ "version": 1, "profiles": { "<profileId>": boolean }, "defaults": { "<baseProviderId>": boolean } }`.
  An older daemon never reads or rewrites it, so the choices survive a downgrade
  and upgrade. A profile or Default with no entry is not migrated yet. The daemon
  writes it atomically like the profile file, serialized with the other mutations.
  A mutation that changes both files writes this one first and restores its previous
  content if the profile-file write fails. An entry for a profile id with no
  metadata is inert, and the daemon prunes it on its next write of this file. It
  holds no secrets. If it is malformed or has an unknown `version`, the daemon leaves
  it untouched, reads every configuration as `not-marked` (an account folder still
  reads as `account-folder`), and refuses `remoteCompatible` writes with `-32603`
  `provider-profiles-unreadable`.
- **Downgrade.** An older daemon ignores `backup` and keeps the array order. It drops
  `backup` when it next rewrites the file, after any create, update or delete, so the
  flags must be set again after an upgrade. It never fails over. While downgraded, it
  applies its own rule: it sends any configuration without an account folder,
  including ones the user unmarked. After the upgrade the saved choices apply again;
  only profiles created while downgraded are migrated.
- **Reads.** The daemon reads the file at startup and after its own writes. It does
  not watch for external edits; changes made outside the daemon apply after a restart.
  If the file is malformed or has an unknown `version`, the daemon still starts and
  leaves the file untouched. `providers.profiles.*` then return `-32603` with
  `data.code: "provider-profiles-unreadable"`, and qualified references fail with
  `provider-profile-replacement-required` (`reason: "profile-missing"`).

Environment values never enter `config.toml`, the profile file, the ordinary
`providers.*` map, the settings database, `settings.list`, `settings:changed`,
catalogs, model rows, events, agent-visible metadata or logs. Deleting a profile
removes both records and prunes its `model.providerDefaults` and `providers.fastMode`
entries (see
[References in settings](#references-in-settings)). The daemon never rewrites
client-owned `quickActions.providerSettings` snapshots; a snapshot keyed by a
deleted reference stays inert.

#### References in settings

- `model.defaultProvider` accepts a reference. `settings.update` rejects one that
  names no saved profile with `-32602` and `data.code: "provider-profile-not-found"`.
- `model.providerDefaults` keys accept references. Clients write the object as a
  whole value, so validation compares with the stored map. Only a key that is new,
  or whose value changed, must name a saved profile. An unchanged stored key
  round-trips without error even if its profile is gone.
- `providers.fastMode` keys accept references; see
  [Per-profile Fast mode](#per-profile-fast-mode).
- `providers.profiles.delete` removes the profile's `model.providerDefaults` key and
  its `providers.fastMode` key in the same commit. That emits one `settings:changed`
  with the new settings revision, as well as `providers:profiles-changed`.
- `quickActions.providerSettings` stays client-owned and unvalidated.

##### Per-profile Fast mode

Each profile has its own Fast mode (Claude Code) or service tier (Codex)
preference, stored in the existing [`providers.fastMode`](settings.md) map under
the profile's `providerRef`:

```jsonc
{"changes": [{"path": "providers.fastMode", "value": {
  "claude-code": true,
  "claude-code@p3k9x2m4q7t1a": false,
  "codex@p7m2q9x4k1t3b": true
}}]}
```

- **No inheritance.** A profile with no entry is **off**. The bare base key
  (`claude-code`, `codex`) applies only to the Default configuration and never to a
  profile, in either direction.
- **Application.** The daemon reads the entry for the selected reference: on each
  new turn and in one-shot prompts (the [application boundary](settings.md) is
  unchanged). A turn on `codex@…` reads only `providers.fastMode["codex@…"]`.
- **Validation.** A qualified key must be well formed (see
  [Identity and provider references](#identity-and-provider-references)) and its
  base must advertise `supportsFastMode: true`; otherwise `settings.update` returns
  `-32602` as for any unknown key. The map is a whole-value write, so, as for
  `model.providerDefaults`, validation compares with the stored map: a qualified key
  that is new, or whose value changed, must name a saved profile, else `-32602` with
  `data.code: "provider-profile-not-found"`. An unchanged stored key round-trips
  without error even if its profile is gone. The whole batch is rejected before
  persistence.
- **Delete.** `providers.profiles.delete` prunes the profile's key in the same commit
  (above).
- **Clients.** Show the control per profile only when the base row advertises both
  `supportsProfiles` and `supportsFastMode`. Preserve every other key, including
  other profiles' keys, when changing one toggle.

#### Methods

Router methods. They are administrator-only like `settings.*`, and members and
guests receive `-32003`. Each is daemon-global, with no `workspaceId` required.

| Method | Params | Result |
| --- | --- | --- |
| providers.profiles.list | baseProviderId? | { profiles: ProviderProfile[], defaults: DefaultConfig[], revision } |
| providers.profiles.create | baseProviderId (req), name (req), env?: EnvEntryWrite[], backup?: boolean, remoteCompatible?: boolean | { profile: ProviderProfile, revision } |
| providers.profiles.update | profileId (req), name?, env?: EnvEntryWrite[], backup?: boolean, remoteCompatible?: boolean | { profile: ProviderProfile, revision, activation: ProfileActivation } |
| providers.profiles.delete | profileId (req) | { profileId, revision } |
| providers.profiles.reorder | baseProviderId (req), profileIds (req): string[] | { profiles: ProviderProfile[], revision } |
| providers.profiles.updateDefault | baseProviderId (req), name?, env?: EnvEntryWrite[], remoteCompatible?: boolean | { defaultConfig: DefaultConfig, revision, activation: ProfileActivation } — see [Default configuration overrides](#default-configuration-overrides) |

```ts
interface ProviderProfile {
  id: string;                 // opaque, immutable
  providerRef: string;        // "<baseProviderId>@<id>" — the value for every provider field
  baseProviderId: "codex" | "claude-code";
  name: string;               // trimmed display name
  backup: boolean;            // quota failover may switch to this profile
  env: EnvEntryRead[];        // masked except folder paths; in stored order
  settingsFingerprint: string; // opaque; changes whenever saved env changes; not derived from values alone
  createdAt: string;          // RFC 3339
  updatedAt: string;
  activation?: { runningProcesses: number }; // see "Activation on reads"
  remoteCompatible?: boolean; // the saved "Use on remote machines" choice; see "Remote compatibility"
  remoteIncompatibility?: RemoteIncompatibility; // present exactly when remoteCompatible is false
}
interface RemoteIncompatibility {
  reason: "account-folder" | "not-marked" | string; // open enum
  keys: string[];  // account-folder: the variable names, as saved; not-marked: []; never values
}
type EnvEntryRead =
  | { key: string; kind: "set"; value: string } // "********" (masked) or "" (saved empty string); CLAUDE_CONFIG_DIR / CODEX_HOME: the stored value
  | { key: string; kind: "unset" };
type EnvEntryWrite =
  | { key: string; kind: "set"; value: string }  // literal, including ""
  | { key: string; kind: "unset" }               // remove the inherited variable
  | { key: string; kind: "keep" };               // update only: keep this key's saved entry
interface ProfileActivation {
  envChanged: boolean;        // false for a rename-only update
  runningProcesses: number;   // live provider processes still using earlier settings
}
```

- **Env semantics.** `set` applies the literal value; `""` differs from `unset`.
  `unset` removes the variable even if it is inherited from the daemon or the captured
  login shell. A key that is absent inherits normally. Values are never shell-expanded
  or executed, with the one exception below. Profile entries override inherited
  values for the same key.
- **Home expansion.** For `CLAUDE_CONFIG_DIR` and `CODEX_HOME` only (compared
  ignoring ASCII case), a `set` value that is exactly `~` or starts with `~/` is
  expanded to the daemon user's home directory when the profile environment is
  resolved. `~/.claude-work` becomes `<home>/.claude-work`. Expansion happens
  before account-home lookup, isolation and fingerprinting, so auth checks, model
  catalogs and launched sessions all see the same path. The stored value is
  unchanged, and reads return that stored, unexpanded value. `~user/…`, `$HOME`, `${…}` and a `~`
  anywhere else stay literal, and every other key is used exactly as typed. If the
  daemon cannot determine its home directory, the value stays literal.
- **Update.** `env`, when present, is the complete new list. Keys left out are removed,
  which restores inheritance. `keep` preserves a saved entry's kind and value without
  echoing the secret, so a masked field stays unchanged. Omitting `env` leaves all
  entries unchanged. A rename never changes `id`, `providerRef` or routing.
- **Backup.** `backup` defaults to `false` on create. On update, omitting it keeps the
  saved value. A non-boolean value returns `-32602`. Changing only `backup` is not an
  environment change: `envChanged` is `false` and running processes are unaffected.
- **Remote compatible.** `remoteCompatible` is the saved choice to let the
  configuration run on remote machines (see [Remote compatibility](#remote-compatibility)).
  On update, omitting it keeps the saved value; changing only it is not an
  environment change (`envChanged: false`). A non-boolean value returns `-32602`.
- **Order.** `list` returns profiles in file order, so each base provider's profiles
  appear in that base provider's saved order. Catalog `profiles` uses the same order. Clients render this order and do not sort by name.
- **Reorder.** `profileIds` is the complete new order for `baseProviderId`: every saved
  profile of that base provider exactly once, and nothing else. The result `profiles`
  lists that base provider's profiles in the new order. Every successful call commits,
  increments `revision` and emits one `reordered` event, even when the order is
  unchanged. A missing or non-array `profileIds`, or a non-string entry, returns
  `-32602` without `fieldErrors`.
- **Atomicity.** Each mutation validates fully before writing. It commits metadata
  and secrets together or changes nothing.
- **`revision`** is a process-local, strictly increasing profile watermark with the
  same client rules as the [settings revision](settings.md). Reset it on reconnect
  and ignore older results and events.
- `list` returns masked values, except the folder paths below. No method returns any
  other saved value.
- <a id="folder-paths-on-reads"></a>**Folder paths on reads.** A `set` entry whose key is
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (compared ignoring ASCII case, as for home
  expansion, under either base provider) reads back with `value` exactly as stored:
  not masked and not home-expanded, so `~/.claude-work` reads as `~/.claude-work`.
  This applies to every `EnvEntryRead`: `providers.profiles.list` (profiles and
  `defaults`), the `profile` in `create` and `update` results, and the
  `defaultConfig` in `updateDefault` results. These are folder locations, not
  credentials. Every other key stays masked as `"********"` (or `""` for a saved
  empty string). Events, logs and `fieldErrors` remain value-free; launch logs still
  redact these folder values like any other saved value. An older daemon
  masks these keys too, so clients must accept `"********"` for them.
- **Activation on reads.** Every `ProviderProfile` read carries the optional
  `activation: { runningProcesses }`. That covers `list` and the `profile` in the
  `create` and `update` results. `runningProcesses` is a non-negative integer: the
  live provider processes for this profile still running with an earlier
  `settingsFingerprint`. `0` means every live process uses the saved settings, or
  none is live. It is value-free, with no keys, values or process details.
  - Clients show the "running sessions use earlier settings" notice while the count
    is above `0`, and clear it at `0`.
  - Daemons that do not track processes omit the field. Clients then keep their
    last known state; omission does not mean `0`.
  - The `update` result's top-level `activation` additionally carries `envChanged`.
  - `ProviderProfileSummary` (catalog rows and events) does not carry activation.
- <a id="remote-compatibility"></a>**Remote compatibility.** `remoteCompatible` is a
  **saved choice** ("Use on remote machines"): the user's consent to send this
  configuration's environment to any machine this backend launches a
  [remote agent](./nodes.md#daemon-to-daemon-remote-machines) on. There is no
  per-machine consent. Every `ProviderProfile` and `DefaultConfig` read carries it:
  `list` (profiles and `defaults`), the `profile` in `create` and `update` results,
  the `profiles` in `reorder` results, and the `defaultConfig` in `updateDefault`
  results. `create`, `update` and `updateDefault` write it.
  - **Can't be marked.** A configuration that **sets** an account folder
    (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, compared ignoring ASCII case, under either
    base provider) is never remote-compatible. The folder is signed in on this
    backend; another machine may lack it or hold a different account under the same
    path. A write that sends `remoteCompatible: true` for a configuration whose
    saved `env` would set an account folder fails with the `remote-account-folder`
    field error on `remoteCompatible`, and nothing is saved. A write that adds an
    account folder and omits `remoteCompatible` unmarks the configuration in the
    same commit.
  - **Reads.** `remoteCompatible: true` has no `remoteIncompatibility`.
    `remoteCompatible: false` has one, with the first matching reason:
    1. `{ reason: "account-folder", keys }` when an account folder is set; `keys`
       lists those variable names as saved. Clients show the toggle as unavailable
       and say why.
    2. `{ reason: "not-marked", keys: [] }` otherwise. Clients show the toggle off.
  - **Default.** For the Default configuration the choice decides whether its
    overrides are sent. A marked Default sends its overrides; with none, it sends
    nothing. An unmarked Default sends nothing and runs through the machine's own
    sign-in ([which providers a machine offers](#which-providers-a-machine-offers)).
    `DefaultConfig.remoteLaunch` gives the result.
  - **Create default.** When `create` omits `remoteCompatible`, the daemon applies
    the profile migration rule below to the new `env`, so an older client keeps
    today's behaviour. Clients that know the field always send it.
    `updateDefault` and `update` keep the saved value when it is omitted.
  - **Migration.** A profile, or a Default of a base provider that advertises
    `supportsProfiles`, with no entry in the
    [choices file](#storage) keeps today's behaviour: the daemon adds its entry at
    startup from the rule below and writes the file once, before it serves any
    request.
    - A profile is marked unless it sets an account folder. So API key and token
      profiles start marked, Different login profiles (an account folder) start
      unmarked, and Advanced profiles follow the same rule.
    - A Default with at least one saved entry and no account folder starts marked.
      Every other Default starts unmarked and keeps working on remote machines
      through the machine's own sign-in. This includes a Default that sets an
      account folder: today it is refused, and after migration it runs with the
      machine's own sign-in and sends nothing, as the
      [launch rules](./nodes.md#placement-across-machines) say for any unmarked
      Default. Its folder never leaves the backend.
    After migration the value changes only through an explicit write, the
    unmarking above, or a Default's [credential auto-mark](#default-credential-auto-mark);
    no other `env` change marks a configuration.
  - [Cloud machines](./nodes.md#placement-on-e2b) need more: a configuration
    runs there only when it is marked **and** its `env` has at least one
    `kind: "set"` entry. The machine's own sign-in never applies there, because a
    sandbox has no sign-in.
  - `reason` is an open string enum. Clients treat an unknown reason as not
    remote-compatible and show `keys` when present.
  - It is value-free: `keys` carries variable names only. Daemons that predate the
    field omit both fields; clients then treat the configuration as compatible and
    let placement decide. Daemons that predate the saved choice compute the value
    (only `account-folder` is then possible) and omit `DefaultConfig.remoteLaunch`;
    clients detect the saved choice by `remoteLaunch` (see [Compatibility](#compatibility)).

**Validation.** Invalid input returns `-32602` with `data.code: "invalid-params"` and
`data.fieldErrors: [{ field, code, message }]`, listing every failure found:

| `field` | `code` | Rule |
| --- | --- | --- |
| `baseProviderId` | `base-provider-unsupported` | It must be a canonical id with `supportsProfiles: true`. |
| `name` | `name-blank` | It must not be empty after trimming Unicode whitespace. |
| `name` | `name-invalid` | No control characters, and at most 64 Unicode scalar values after trimming. |
| `name` | `name-duplicate` | Names must be unique within one base provider, ignoring case (Unicode simple case folding), including a renamed Default of that base provider. The same name may exist under another base provider. |
| `name` | `name-reserved` | `Default`, ignoring case, names the original configuration. |
| `baseProviderId` | `profile-limit` | At most 32 profiles per base provider. |
| `env` | `env-limit` | At most 64 entries. |
| `env[i].key` | `env-key-invalid` | The key must match `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. |
| `env[i].key` | `env-key-duplicate` | Keys must be unique ignoring ASCII case, so behavior is the same on Windows. |
| `env[i].key` | `env-key-reserved` | Reserved keys are listed below. |
| `env[i].value` | `env-value-invalid` | No NUL characters, and at most 32 KiB of UTF-8. |
| `env[i].value` | `env-value-placeholder` | A `set` value of `********` is rejected. Use `kind: "keep"`. |
| `env[i].kind` | `env-keep-missing` | `keep` names a key with no saved entry, or appears on create. |
| `remoteCompatible` | `remote-account-folder` | `remoteCompatible: true` is sent while the saved `env` would set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (see [Remote compatibility](#remote-compatibility)). The message names the variables and says to turn off "Use on remote machines" or remove the folder. |
| `profileIds[i]` | `profile-order-duplicate` | Reorder only. The id appears more than once. |
| `profileIds[i]` | `profile-order-unknown` | Reorder only. The id is not a saved profile of `baseProviderId`. |
| `profileIds` | `profile-order-incomplete` | Reorder only. A saved profile of `baseProviderId` is missing from the list. |

Reorder also reports `base-provider-unsupported` on `baseProviderId`; it then checks
nothing else. A failed reorder changes nothing.

An unknown `profileId` returns `-32602` with `data.code: "not-found"`.

**Reserved keys.** These are compared ignoring ASCII case. Intent owns them: launch
replaces the value, or the daemon reads it to locate the shared installation before
any profile environment applies. A saved override would therefore be ignored or would
break the shared installation. The `env-key-reserved` message names the reason. For
`HOME` and `USERPROFILE` it also points to `CODEX_HOME` (Codex) or `CLAUDE_CONFIG_DIR`
(Claude Code), which select an account.

| Key or pattern | Why |
| --- | --- |
| `PATH` | Launch rewrites it with the enhanced executable path. |
| `CODEX_PATH`, `CLAUDE_CODE_EXECUTABLE` | Installed executable selection (`InstalledContext`) |
| `CODEX_CONFIG` | Enforced Codex policy, set after every env merge |
| `NODE_OPTIONS` | Daemon-managed adapter memory cap composition |
| `HOME`, `USERPROFILE` | Read for executable discovery and as the source home for account isolation; not replaced at launch. Use `CODEX_HOME` or `CLAUDE_CONFIG_DIR` to select an account. |
| `npm_config_workspace*`, `npm_workspace*`, `npm_config_include_workspace_root` | Removed from adapter bootstrap launches |
| `INTENT_*`, `INTENTD_*` | Intent session and bootstrap wiring |
| `GIT_CONFIG_PARAMETERS`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | Intent sets this at launch (session wiring and commit identity). Reserved for Codex and Claude Code. |
| `INITIAL_AGENT_MODE` | Intent sets this at launch (session wiring and commit identity). Reserved for Codex only; Claude Code profiles may set it. |

Reservation applies to both `set` and `unset`. A profile therefore cannot override or
remove Intent's git commit identity or its credential-helper configuration.

Account configuration variables remain supported, for example `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`
and `CODEX_ACCESS_TOKEN`. Adding a reserved key requires a contract update so that
existing profiles are not silently degraded.

**Delete blocking.** `delete` refuses while a saved setting explicitly selects the
profile. It returns `-32602` with `data.code: "provider-profile-in-use"` and
`data.inUse: InUseReason[]`. Nothing is deleted.

```ts
type InUseReason =
  | { kind: "defaultProvider" }                         // model.defaultProvider; also governs quick actions
  | { kind: "specialistProvider"; specialistId: string; source: string }
  | { kind: "specialistModelOption"; specialistId: string; source: string; index: number };
```

The daemon scans every specialist tier it resolves on this host. A repository
specialist that it cannot see still fails loudly later (see below). Conversations,
running turns and `model.providerDefaults` keys do not block deletion. Deletion
never removes external account directories.

#### Catalog, models and status

- `providers.catalog` (§5.38) rows gain an additive boolean `supportsProfiles`.
  Implementing daemons emit `true` for `codex` and `claude-code` and `false` for
  other rows. Absence means unsupported, including on older daemons. Clients offer
  **Add profile** only when it is `true`.
- `providers.catalog` gains an additive top-level `profiles: ProviderProfileSummary[]`
  (`{ id, providerRef, baseProviderId, name, backup }`), in saved order. It has no env and no counts, and
  member reads may include it. `providers` rows stay one per provider type, so
  onboarding, which reads only `providers`, shows each type once. The `profiles` list
  reflects saved metadata at read time. `providers:profiles-changed` invalidates it.
- `providers.catalog` gains an additive top-level `defaultNames?` map naming each
  renamed Default configuration (see
  [Default configuration overrides](#default-configuration-overrides)).
- **Guest reads.** Profile and Default configuration names are host settings. When
  the caller's current durable host role is guest (re-read on every call, not the role
  cached when the connection was admitted), `profiles` is `[]` and `defaultNames` is
  omitted. A principal the host does not know, or a failed role lookup, reads as a
  guest. `defaultRemoteIncompatibility` is still served; it names environment keys,
  not configurations. Owner, host-member, agent and daemon reads are unchanged. A
  client reading the catalog as a guest names configurations by base provider only.
- **Remote compatibility in the catalog.** Each `profiles` row
  (`ProviderProfileSummary`) also carries `remoteCompatible` and, when it is `false`,
  `remoteIncompatibility`, as on `ProviderProfile`
  ([Remote compatibility](#remote-compatibility)). The catalog gains two additive
  top-level maps for the Default configurations:
  - `defaultRemoteLaunch?: { "<baseProviderId>": DefaultRemoteLaunch }`, one entry
    per base provider that advertises `supportsProfiles`, with the value of
    `DefaultConfig.remoteLaunch`.
  - `defaultRemoteIncompatibility?` is no longer sent: on a machine every Default
    runs, through the machine's own sign-in when it is not marked. An older client
    that reads it treats every Default as compatible, which is now correct.

  Member reads may include both, since they carry no values. A provider picker
  for a remote agent reads them to mark or hide configurations that cannot run there
  (see the [launch rules](./nodes.md#placement-across-machines)).
  `providers:profiles-changed` invalidates them; its `profile` summary does not carry
  the fields, so clients re-read the catalog.
- `models.list { providerId: providerRef }` returns that profile's catalog with
  `ModelInfo.provider = providerRef`. Cache keys and the version key include the
  profile's resolved environment fingerprint. Catalogs and cached status never cross
  profiles or configuration changes. On an older daemon an unknown `providerId` keeps
  its existing empty-list-plus-`warning` degradation. A profile catalog carries the
  same optional `warningKind` as its provider
  ([§5.30](./models-providers.md#530-modelslist--model-catalog), "Warning kind").
- `host.providerAuthStatus { providerId: providerRef }` returns
  `{ id: providerRef, authenticated }`. A sweep without `providerId` stays unchanged
  unless `includeProfiles: true`, which appends one entry per profile.
  `host.providerTestPrompt` accepts a reference and promotes or demotes only that
  reference's verdict. A result for one profile never changes another profile or
  the Default configuration.
- **Live process versus saved profile.** These reads describe the **saved** profile:
  the configuration a newly started process will use. They are not the state of a
  provider process that is already running. For an agent with a live, unchanged
  process, the source of truth is what that process itself reported:
  - the session-discovered fields on `AgentLite` / `AgentSession` (current `model`,
    session `effortLevels`, §5.5);
  - the results of its own turns, such as an `agent:failed` authentication or quota
    signal.

  While `usingEarlierProfileSettings` is present, clients must not show a
  saved-profile auth verdict or model list as that process's state. A choice that
  starts a new process is checked against the saved profile, because the new process
  will use it. That includes a different model, a different reference, or any choice
  when no process is live.
- UI status mapping: a saved profile is *configured*; *checking* while the client's
  probe is pending; `authenticated: true` is *ready*; `false` is *error* (signed out);
  `null` stays *configured* (not verified). Saving never implies *ready*.
- Model resolution for a reference walks `model.providerDefaults[providerRef]` →
  `model.providerDefaults[baseProviderId]` → `model.default`, each provider-guarded as today.

#### Agent state, switches and replacement

- **Switch.** An `agent.setModel` that changes the reference takes effect on the next
  turn. This includes a change between `codex` and `codex@…`, and a change that keeps
  the same model. The current turn finishes on its original configuration. The next
  turn starts a fresh provider process and a native session owned by the new
  reference, with Intent history replayed. A native session id is never reused across
  references or across an account-relevant settings change.
  For a remote agent the target must also be remote-compatible and offered by the
  agent's machine, and the next turn relaunches it on that machine
  ([switching a remote agent's model](./nodes.md#switching-a-remote-agents-model)).
- **Activation.** Provider processes read the saved profile when they start. This
  includes processes recreated after idle reaping or a crash. Running processes keep
  their settings. Saving never interrupts a turn or restarts anything.
- `AgentLite` / `AgentSession` gain additive optional fields:
  - `usingEarlierProfileSettings?: true` is present while the agent's live provider
    process started with a `settingsFingerprint` other than the profile's current one.
    It is omitted once they match or no process is live. The daemon emits
    `agent:updated` when it changes.
  - `providerReplacementRequired?: { providerRef, reason: "profile-missing" | "provider-disabled" }`
    is present when the next turn would be refused.
- **Replacement required.** A turn, a resume or a create whose qualified reference
  names a missing profile or a disabled base provider fails with `-32602`.
  `data.code` is `"provider-profile-replacement-required"` and
  `data: { providerRef, reason }`. The daemon never rehomes the conversation to the
  app default or to the Default account. Bare legacy references keep today's
  disabled-provider behavior. A missing reference in `model.defaultProvider`, a
  specialist or a delegation raises the same error. It never falls back to the bare base.
- **Delegation.** Explicit param, then specialist, then the parent agent's bare provider
  when usable, then app default (§5.5 "Parent provider inheritance"). A child never
  inherits its parent's profile, and no account is inferred across providers by profile
  name.
- **Restart copy.** The daemon does not report who owns it. A client that spawned its
  own local daemon (the desktop sidecar) says to restart Intent. Otherwise it names
  intentd on the provider host. UDS locality alone does not mean the daemon is
  app-owned, and a client reconnect never counts as applying an edit.

#### Backup failover

A turn whose provider rejects it for quota retries on another candidate (a backup
profile, or home) instead of failing. "Quota" means exactly the failures that
`agent:failed` reports with `errorCode: "quota-exceeded"` ([§6](../06-events.md)).
Every other failure behaves as today. A quota failure is terminal only when no
eligible untried candidate remains, home included (see [Exhaustion](#backup-failover)).
A conversation that is at home with no profile flagged as a backup has no candidate,
so it behaves as today.

- **Home provider.** Each conversation has a *home* reference: its last explicit
  selection, which is the reference it was on before its first automatic switch. Until
  it first switches, home is simply its current reference. Home may be the Default
  configuration or a profile, backup or not. An explicit selection that changes the
  provider or the model (`agent.setModel`, or the provider chosen at create) sets a
  new home and clears any [return timer](#timed-return). Automatic switches never
  change home.
- **Rotation.** The candidates form one cycle: the profiles with `backup: true` whose
  base provider is the agent's base provider, in saved order, then home if it is not
  already among them. Home is always a candidate while the conversation is away from
  home, even if no profile is flagged as a backup any more (for example, the flags were
  cleared after a failover). Failover never crosses base providers (Codex and Claude Code
  stay separate) and never changes the model id.
- **Choice.** The daemon walks the cycle starting after the current reference,
  wrapping around, and takes the first reference not yet tried for this user turn. If
  the current reference is not in the cycle, the walk starts at the beginning. The
  reference that just failed counts as tried, so each reference is tried at most once
  per user turn and the walk never loops. A profile that no longer exists, or a base
  provider that is disabled, is skipped. The walk prefers references the
  [shared quota state](#shared-quota-state) does not mark out of quota; when every
  untried reference is marked, it takes the first of them anyway.
- **Switch.** The daemon saves the chosen reference as the agent's provider, as
  `agent.setModel` would with the same model, and emits `agent:updated`. The switch
  is sticky: later turns stay on it until the [timed return](#timed-return) or an
  explicit selection.
- **Retry.** The chosen reference (a backup, or home) starts a fresh provider process and native session with Intent
  history replayed, as for any [switch](#agent-state-switches-and-replacement). What
  it receives depends on what the failed attempt persisted:
  - **No output yet.** If the failed attempt persisted no assistant text or tool
    activity, the backup's prompt is the original user message. The message is
    sent again but never persisted twice.
  - **Partial output.** If the quota failure arrived mid-turn, the replayed history
    contains the user message once, followed by the failed attempt's partial
    assistant text and its tool calls and results. The prompt is a continuation
    instruction: continue the reply and do not repeat the tool calls shown. The
    partial output stays in the transcript.

  Either way it remains the same user turn, and no new user message is persisted.
  This also holds when the backup's own attempt goes through an internal transport
  retry.
- **Session setup.** A quota failure during provider process or session setup
  (for example a quota-rejected `session/new`) fails over immediately, with no
  same-provider setup retries. Setup failures that are not quota failures keep
  today's retry behavior.
- **Swallowed attempt.** A failed attempt that leads to a retry emits no
  `agent:failed` and persists no error row. The agent stays busy until the retried
  turn ends.
- **Exhaustion.** When no eligible untried candidate remains, home included, the turn
  fails with today's terminal `agent:failed` and `errorCode: "quota-exceeded"`,
  unchanged. `providerId` names the
  last reference tried, which is the agent's provider at that point.

**Transcript notice.** Each switch persists one row before the retry starts:
`role: "system"`, one text block naming both configurations, and

```ts
metadata = {
  type: "provider_failover";
  fromProvider: string;   // reference that hit its quota
  toProvider: string;     // reference now running the turn (a backup, or home)
  model: string | null;   // unchanged model id; null = provider default
  reason: "quota-exceeded";
}
```

The daemon emits the standard `agent:message` event (`role: "system"`). The row is
transcript-only and never replayed: like `model_changed` ([§5.5](agents.md)), history
replay excludes it and it never reaches a provider prompt. Clients render it from
`metadata` as an inline notice, not as an error. A failover chain (A → B → C) writes
one `provider_failover` row per switch and never a `model_changed` row.

##### Timed return

A conversation that left home because of quota goes back to home once home's quota
has had time to reset.

- **Return-after time.** When a quota switch moves the conversation away from home,
  the daemon records a return-after time. It is the reset time reported in the quota
  error when the daemon can parse one (for example "resets at 5pm"), otherwise 5 hours
  later. A parsed time that is not in the future is ignored. Further switches between
  backups while away keep the recorded time.
- **Return.** The first turn that starts at or after the return-after time starts on
  home instead of the current reference (earlier or later when the
  [shared quota state](#shared-quota-state) says so), as a [switch](#agent-state-switches-and-replacement)
  with Intent history replayed, and emits `agent:updated`. A return happens only at
  the start of a turn, never mid-turn and never in a failover retry.
- **Home accepts.** When home produces the turn's first output, the daemon persists
  one `provider_returned` row before that output. The conversation is home again: the
  timer and the backoff are cleared.
- **Home still out of quota.** The turn fails over through the rotation as usual, with
  home counted as tried; the user sees only the `provider_failover` row. The daemon
  records a new return-after time: the newly reported reset time if one can be parsed,
  otherwise a backoff of 1 hour, doubling on each further failed return (1 h, 2 h,
  4 h, …) up to 24 hours. If every candidate is exhausted, the turn fails as in
  [Exhaustion](#backup-failover) and the new time still applies.
- **Clearing.** An explicit selection clears the timer and the backoff. If home is a
  profile that no longer exists, the daemon clears them and the conversation stays on
  its current reference.
- **Persistence.** Home, the return-after time and the backoff step live in the agent
  session's existing metadata document. They survive a daemon restart, need no
  database migration, and are not part of `AgentLite` or `AgentSession`.

<a id="auto-selection-notice"></a>**Auto-selection notice.** An agent created on
an [auto-picked](#remote-auto-pick) profile gets one transcript row, with
`role: "system"`, one text block such as "Default isn't signed in on Build box, so
this agent runs with claude-code (Work), marked for remote machines.", and

```ts
metadata = {
  type: "provider_auto_selected";
  fromProvider: string;   // the plain Default asked for (a bare base id)
  toProvider: string;     // the profile reference that runs instead
  model: string | null;   // the agent's model; null = provider default
  reason: "machine-signed-out" | "sandbox-no-sign-in";
  machine: string;        // the machine's name, or the cloud entry's name, for example "E2B"
}
```

It follows the `provider_failover` rules: the standard `agent:message` event,
transcript-only, never replayed to a provider, rendered as an inline notice; an
older client shows its text.

**Return notice.** The return row has `role: "system"`, one text block naming home,
and

```ts
metadata = {
  type: "provider_returned";
  fromProvider: string;   // reference the conversation was on while away
  toProvider: string;     // home reference now running the turn
  model: string | null;   // unchanged model id; null = provider default
  reason: "quota-reset";
}
```

It follows the `provider_failover` rules: the standard `agent:message` event,
transcript-only, never replayed to a provider, rendered as an inline notice. A return
never writes a `model_changed` row.

**Downgrade.** An older daemon ignores the stored home and timer: the conversation
stays on its current reference and never returns on its own. A later upgrade resumes
the timer from the stored values.

##### Shared quota state

The daemon shares what one conversation learns about a reference's quota with every
other conversation. The Default configuration (a bare provider id) and each profile
are tracked separately, never per model.

- **Out of quota.** A quota failure on a reference marks it out of quota until the
  reset time the error reports (parsed as for the return-after time), otherwise for
  5 hours. The newest failure replaces any earlier state. A failure is recorded even
  when the conversation has no candidate to fail over to. A quota failure of a remote
  agent whose reference sends nothing (it ran on the machine's own sign-in, see
  **Turn start** below) marks nothing: that account is not this backend's. The
  conversation still fails over as usual
  ([intent-hq/intent#9100](https://github.com/intent-hq/intent/issues/9100)).
- **Working.** The first output of an attempt on a reference (or a turn that
  completes on it without output) marks it working. This replaces an out-of-quota mark
  only when the attempt started after the mark was recorded.
- **Turn start.** At the start of a turn (never in a failover retry, replay or
  continuation), after the timed-return check:
  - If the conversation is away and home is marked working, the turn starts on home
    even before the return-after time, as a [return](#timed-return).
  - If the return-after time has passed but home is still marked out of quota, the
    conversation stays on its current reference. This is not a failed return, so the
    backoff is unchanged. A mark therefore also delays the shorter backoff steps after
    a failed return until it expires.
  - If the reference the turn would start on is marked out of quota, the daemon
    switches to the first reference in the [rotation](#backup-failover) that is not
    marked, before any attempt. The switch writes the usual `provider_failover` row and
    sets the return-after time to the mark's expiry. The skipped reference is not
    counted as tried, so the turn can still reach it as its last candidate. Leaving a
    marked home this way is not a failed return: the backoff and return-after time
    stay as they are.
  - The first turn after an explicit selection (`agent.setModel`) is never moved this
    way: it tries the chosen reference, and fails over as usual if it is out of quota.
  - If every candidate is marked, nothing moves: the turn tries its current reference
    and fails over as usual.
  - A remote agent whose reference sends nothing (a plain Default with no overrides,
    or an unmarked Default on a machine) runs on the machine's own sign-in, another
    account than this backend's. This backend's mark never moves it: the turn starts on
    the plain reference. A marked Default with overrides sends this backend's account,
    so its mark applies ([intent-hq/intent#9100](https://github.com/intent-hq/intent/issues/9100)).
- **Edited.** When `providers.profiles.update` or `providers.profiles.updateDefault`
  saves a change (the name, the environment, or a profile's `backup`), the edited
  reference's state is cleared before the call returns, so the next turn of every
  conversation treats it as neither out of quota nor working.
  `providers.profiles.delete` clears the deleted profile's state. A call that saves
  nothing, or fails, leaves it unchanged. Other references, including the same base
  provider's Default or other profiles, keep their state.
  - A process still running on settings from before an environment change or a
    delete (`usingEarlierProfileSettings`) does not mark the reference again: its
    quota failures and output leave the shared state unchanged. After a change to
    only the name or `backup`, running processes use the same settings, so they
    still mark it.
- **Advisory and in-memory.** Marks never make a turn fail without an attempt. They
  are not persisted: after a daemon restart, each conversation's stored timer applies
  as before. No method or event exposes them.

##### Quick actions

`agent.completeOnce` ([§5.32](agent-aux.md)) fails over on its ACP route on the same
terms as a turn. The auggie route has no profiles and does not fail over.

- **Candidates.** The reference the call resolves to (its *configured* reference)
  plays the part of home. The rotation, choice and limits are those of
  [Backup failover](#backup-failover): `backup: true` profiles of the same base
  provider in saved order, then the configured reference; each reference at most once
  per call; never another base provider; the same model and effort.
- **Start.** When the [shared quota state](#shared-quota-state) marks the configured
  reference out of quota, the call starts on the first reference in its rotation that
  is not marked. If every candidate is marked, it starts on the configured reference.
- **Retry.** A quota failure marks the reference out of quota and runs the same prompt
  on the next candidate. A reply marks the reference working. Every other failure,
  and every `{ available: false }` result, is returned at once, as before.
- **Budget.** All attempts share the call's one `timeoutMs`. The first attempt keeps
  today's setup budgets; a backup's whole attempt, setup included, ends at the
  deadline. After a quota failure, no backup starts when less than 5 seconds remain.
  The call then fails with the last quota error, as before. It also fails with that
  error when no untried candidate remains, or when a backup times out or can no longer
  be resolved.
- **Nothing persisted.** The call stays stateless: no setting, agent or transcript row
  changes, and no event is emitted for a switch. The result shape is unchanged.

#### Default configuration overrides

The Default configuration of `codex` and `claude-code` can carry its own display
name and environment overrides. These use the same rules as a profile's, without
`backup` or a position in the order. Default stays the bare reference: its
`providerRef` is the base provider id. No saved selection, specialist, conversation
or `model.providerDefaults` key changes when it is renamed or its environment is
edited, and it is still never a backup.

```ts
interface DefaultConfig {
  baseProviderId: "codex" | "claude-code";
  providerRef: string;         // the bare base provider id
  name: string;                // "Default" unless renamed
  env: EnvEntryRead[];         // masked except folder paths; in stored order; [] when none saved
  settingsFingerprint: string; // opaque; "" exactly when no entries are saved
  activation?: { runningProcesses: number }; // as on ProviderProfile
  remoteCompatible?: boolean;                // saved choice: send these overrides to remote machines
  remoteIncompatibility?: RemoteIncompatibility; // as on ProviderProfile
  remoteLaunch?: DefaultRemoteLaunch;        // what a remote launch of the bare reference does
}
type DefaultRemoteLaunch =
  | "send"             // marked: its overrides are sent (none saved: nothing is sent)
  | "machine-sign-in"  // not marked: nothing is sent; the machine's own sign-in runs it (refused on cloud machines)
  | "refused";         // its saved environment cannot be read: launches fail closed
```

| Method | Params | Result |
| --- | --- | --- |
| providers.profiles.updateDefault | baseProviderId (req), name?, env?: EnvEntryWrite[], remoteCompatible?: boolean | { defaultConfig: DefaultConfig, revision, activation: ProfileActivation } |

- **Reads.** `providers.profiles.list` gains an additive `defaults: DefaultConfig[]`
  with one entry per base provider that advertises `supportsProfiles`, in catalog
  order, whether or not anything is saved. A `baseProviderId` filter narrows it to
  that base provider. Values are masked exactly as on profiles, and folder paths are
  returned as stored (see [Folder paths on reads](#folder-paths-on-reads)).
- **Name.** `name` is trimmed. A name that is empty after trimming, or equals
  `Default` ignoring case, is not a rename: it restores the unrenamed Default, which
  reads as `"Default"` and appears in neither the file nor `defaultNames`. Any other
  name follows the profile rules (`name-invalid`) and must not equal, ignoring case,
  the name of a profile of the same base provider (`name-duplicate`). A profile
  create or rename whose name equals the renamed Default of its base provider,
  ignoring case, is also rejected with `name-duplicate`. Omitting `name` keeps the
  saved one.
- **Environment.** `env` has the profile semantics: `set`, `unset` and `keep`, the
  complete new list when present, unchanged when omitted. The same limits, key rules,
  reserved keys and home expansion apply, with the same field codes. `keep` names a
  key with a saved Default entry. An empty list removes every override.
- **Remote compatible.** `remoteCompatible` is the Default's "Use on remote
  machines" choice, with the [profile rules](#remote-compatibility) (including
  `remote-account-folder`). Omitting it keeps the saved value, except for the
  credential auto-mark below. A Default may be marked with no overrides; a remote
  launch then sends nothing. Removing every override does not unmark it.
  `remoteLaunch` is recomputed on every read from this choice.
- <a id="default-credential-auto-mark"></a>**Credential auto-mark.** An
  `updateDefault` that **adds a credential** marks the Default in the same commit,
  so the credential is used on remote machines without a second step. A
  credential is a `kind: "set"` entry for one of `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`,
  `CODEX_API_KEY` or `OPENAI_API_KEY` (compared ignoring ASCII case). It is added
  when the saved environment did not already set that key; changing the value of a
  key that is already set, or `keep`, adds nothing.
  - An explicit `remoteCompatible` in the same write wins.
  - A Default whose saved result sets an account folder stays unmarked.
  - Removing the credential later never unmarks it.
  - A write that adds no credential (a rename, other keys, an `unset`) keeps the
    saved choice.
  - The daemon applies it for every client, so an older client that saves an API
    key on the Default gets the same result. The `updateDefault` result and the
    `default-updated` event carry the new state; clients re-list as usual.
  - It applies only to Default configurations. A profile's choice changes only as
    described in [Remote compatibility](#remote-compatibility).
- **Validation.** `baseProviderId` must be a canonical id with
  `supportsProfiles: true` (`base-provider-unsupported`). Errors use the same
  `-32602` `invalid-params` envelope and `fieldErrors` as profile mutations. The
  method is administrator-only and daemon-global, like the other
  `providers.profiles.*` methods.
- **Storage.** Both halves belong to the daemon's own data dir, like profiles:
  - The profile file gains an optional
    `defaults: { "<baseProviderId>": { "name"?, "envId"? } }` member. `name` is
    present only for a renamed Default. `envId` is present only while entries are
    saved; it is minted like a profile id and is never exposed. A base provider with
    neither is omitted, and the member is omitted when empty. The file `version`
    stays `1`.
  - The Default's remote-compatible choice lives in the
    [choices file](#storage), keyed by base provider id.
  - Environment entries live in the protected `SecretStore` under account
    `providerProfiles.<envId>.env`, in the profile document shape. Because `envId`
    is random and recorded only in this daemon's file, another daemon sharing the
    secret store (a dev sandbox, for example) never reads or overwrites it.
  - Neither half ever appears in `config.toml`, settings reads, events, catalogs or
    logs.
- **Writes.** An `updateDefault` is serialized with the other profile mutations and
  commits through the profile file's atomic rename. An environment change writes
  the new entries under a freshly minted `envId`, records both the new and the
  previous `envId` in `pendingEnvCleanup`, then writes the file with the new name and
  `envId` together. After the file is committed it removes the previous secret and
  clears the cleanup list. If the file write fails, the daemon removes the new secret,
  and the saved name and environment are unchanged. A rename alone writes only the
  file. At startup, a recorded id counts as having metadata when it is a saved
  profile id or a current `defaults` `envId`; otherwise its secret is removed.
- **Runtime.** With no saved entries (`settingsFingerprint: ""`), the Default
  configuration launches exactly as before. With entries, every process that the
  Default configuration starts (agent sessions, one-shot prompts, auth probes and
  model catalog discovery) applies them as a profile applies its overlay, and the
  fingerprint-keyed behaviour of profiles applies under the bare reference:
  - Model catalog and auth status caches key on the Default fingerprint.
  - `activation.runningProcesses` and `AgentLite.usingEarlierProfileSettings` report
    live Default processes started with a different fingerprint.
  - A native session is resumed only under the fingerprint it was bound to. A
    session with no recorded binding counts as bound to `""`, so existing Default
    conversations keep resuming until entries are first saved. A session bound to a
    non-empty fingerprint is never resumed after the Default environment changes,
    including when every entry is removed.
  - An environment change (`envChanged: true`) clears the bare reference's
    [shared quota](#shared-quota-state) mark, since the new environment may select
    another account.

  Saving never interrupts a turn or restarts anything.
- **Fail closed.** If `envId` is recorded but its secret cannot be read or decoded,
  the Default configuration does not fall back to running without its entries. A
  turn, one-shot prompt or probe on the bare reference then fails with `-32603`,
  like a profile whose environment is unavailable. `providerReplacementRequired`
  never applies to the bare reference.
- **Catalog.** `providers.catalog` gains an additive top-level
  `defaultNames?: { "<baseProviderId>": name }`, holding only renamed Defaults and
  omitted when none is renamed. Member reads may include it. Clients label the
  Default configuration with this name and fall back to `Default`.
- **Downgrade.** An older daemon ignores the `defaults` member and drops it on its
  next profile-file write. Name and environment are then both gone: the Default
  configuration launches without entries, and the orphaned secret stays inert. After
  an upgrade, set both again.

#### Events

`providers:profiles-changed` is global (no `workspaceId`). The daemon emits exactly
one event, with a `revision` one higher than the previous event, in three cases:

- **A committed `providers.profiles.*` mutation.** Create, update and delete change
  exactly one profile; `change` is `"created"`, `"updated"` or `"deleted"`. A reorder
  has `change: "reordered"` and carries `baseProviderId` instead of `profileId` and
  `profile`; clients re-run `providers.profiles.list` to read the new order.
- **A change in one profile's `activation.runningProcesses`.** For example, a
  process on earlier settings exits or is recycled, or a new process starts.
  `change` is `"activation"`, and `profile` and `envChanged` are omitted. The event
  carries no count; clients re-run `providers.profiles.list` to read it.
- **A Default configuration change** ([Default configuration overrides](#default-configuration-overrides)).
  A committed `providers.profiles.updateDefault` has `change: "default-updated"`
  with `baseProviderId` and `envChanged`. A change in the Default configuration's
  `activation.runningProcesses` has `change: "default-activation"` with
  `baseProviderId`. Neither carries `profileId` or `profile`; clients re-run
  `providers.profiles.list` (and `providers.catalog` for a new name).

The daemon does not reload the profile file. Only a reorder covers several profiles.
The payload is
`data = { revision, change: "created" | "updated" | "deleted" | "activation" | "reordered" | "default-updated" | "default-activation", profileId?, baseProviderId?, profile?: ProviderProfileSummary, envChanged?: boolean }`.
It never carries env keys or values. `profileId` is present on every profile change,
and `baseProviderId` only on `reordered` and the two Default changes. `profile` is
omitted on delete, activation, reorder and Default events. A client re-runs `providers.profiles.list` (or
`providers.catalog`) when it sees an activation or reorder event, a revision gap, or
a reconnect. A failover switch changes no profile and emits no
`providers:profiles-changed`. A delete that prunes a `model.providerDefaults` key also emits
`settings:changed`, with its own settings revision.

#### Profiles on an orchestrator

*(Additive, docs first.)* On an [orchestrator](./nodes.md#orchestrator-mode)
providers are only enabled or disabled, plus profiles. The orchestrator never
runs a provider CLI, so it never checks one:

- **No install or sign-in check.** `host.providerDiscovery` returns
  `{ providers: [] }`. `host.providerAuthStatus` returns `authenticated: null`
  (*configured*) for every provider and, with `includeProfiles: true`, every
  profile, with no `identity`; `force` changes nothing. No CLI detection,
  sign-in, version, quota or model probe runs.
- **Catalog.** `providers.catalog` rows are unchanged except
  `supportsTestPrompt: false` on every row. `models.list` returns
  `{ models: [], source: "static" }` with no `warning`; model pickers read the
  machines' reports (`remoteMachines.models`).
- **No Test button.** `host.providerTestPrompt` is refused with `-32003`
  `data.code: "orchestrator-mode"` and spawns nothing. Clients hide the profile
  **Test** button on an orchestrator.
- **Remote compatibility is implied.** Every profile, and every Default with
  overrides, counts as remote-compatible without the mark; reason
  `not-marked` never fires. A configuration that sets an account folder
  (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) stays refused with reason
  `account-folder`. `ProviderProfile` and `DefaultConfig` reads keep the stored
  `remoteCompatible` (so switching back to `regular` restores it); the catalog's
  `profiles[].remoteCompatible` and `defaultRemoteLaunch` report the effective
  value. Clients hide the "Use on remote machines" control.
- **Editing.** Profiles and Default overrides are created, edited, ordered and
  selected as on any backend. A selected profile's environment is sent to the
  machine as `profileEnv` at launch.
- **Where status shows.** Whether a provider runs is decided by each machine at
  placement and launch, from its own [capabilities report](../node-link.md#capabilities-report).
  The app shows that state only on the machine's row in Settings → Machines,
  never as the orchestrator's provider status.

#### Remote execution nodes

An agent placed on a remote machine over the daemon-to-daemon executor link runs
with the selected profile or a marked Default's overrides, resolved on the backend
and sent to the machine as an environment overlay; otherwise nothing is sent and
the machine uses its own provider sign-in. Nothing falls back to another account,
except the documented [auto-pick](#remote-auto-pick) of a marked profile for a
plain Default that the chosen machine cannot sign in.
See [provider credentials](../node-link.md#provider-credentials-profile-environment).

Only a configuration the user marked [remote-compatible](#remote-compatibility)
is sent. The [launch rules](./nodes.md#placement-across-machines) decide every
remote launch: placement, sub-agents, `agent.setModel` and quota failover. An
unmarked profile, or an unmarked Default on a cloud machine, fails before any write with
`-32602` `profile-not-remote-compatible`
([remote machine errors](./nodes.md#remote-machine-errors)). A remote agent can
switch to another allowed configuration or model that its machine offers; see
[switching a remote agent's model](./nodes.md#switching-a-remote-agents-model).
Quota failover on a remote agent passes over candidates the launch rules refuse.

##### Which providers a machine offers

This decides which providers a machine **offers**; it never changes the
configuration a launch selected. A base provider is offered on a remote machine
when either holds:

1. **The machine's own sign-in can run it.** The provider's CLI is detected there
   and its sign-in status is `signed-in` or `unknown` (an `unknown` one is still
   tried). A launch of the Default that sends nothing (an unmarked Default, or a
   marked one with no overrides) runs this way.
2. **This backend has a remote-compatible configuration for it** (a marked
   profile, or a marked Default with overrides), and the provider's CLI is
   installed on the machine; its own sign-in does not matter. A launch runs this
   way when that configuration is selected, or through the
   [auto-pick](#remote-auto-pick) below when the plain Default is.

<a id="remote-auto-pick"></a>**Auto-pick for the plain Default.** When a remote
launch asks for the plain Default (no profile chosen) and the machine cannot run
it on its own sign-in, admission sends the **first profile marked for remote
machines** of that base provider, in the saved profile order, instead:

- on a machine whose report says the provider is `signed-out` or `auth-failed`.
  The order is: while such a profile exists, placement keeps machines signed out
  of the provider as candidates (their CLI must be installed); it chooses a
  machine as usual; **then**, if the chosen machine is signed out, the profile is
  sent ([placement across machines](./nodes.md#placement-across-machines), step 5);
- on a [cloud machine](./nodes.md#placement-on-e2b) (E2B or Northflank), which has no sign-in; there the profile
  must also send a set variable.

A machine whose sign-in is `signed-in` or `unknown` runs the Default on its own
sign-in first. Only when no marked profile qualifies does the original refusal
stand (`machine-not-signed-in`, or on a cloud machine `profile-not-remote-compatible` /
`cloud-profile-required`). A profile chosen explicitly is never replaced. The
agent is created on the picked profile: its `provider` is that profile's
reference, so lists and detail reads show it, and its transcript gets one
[`provider_auto_selected`](#auto-selection-notice) row. Auto-pick runs at
admission (`agent.create`, `agent.delegate`, `agent.wakeOrCreate`'s creation
branch, `workspace.create`'s `initialAgent`, sub-agents of remote agents); it
does not apply to `agent.setModel`, quota failover or a later start.

When neither applies, the provider is **not offered** for that machine: it is left
out of the agent-facing machine list (`ws.agent.create` and `ws.help("agent")`),
out of placement's automatic choice, and is refused at admission; clients hide it
from their pickers for that machine. A plain Default on a machine that is signed
out, with no marked profile to auto-pick, is refused with `machine-not-signed-in`
([remote machine errors](./nodes.md#remote-machine-errors)). A machine whose sign-in
was `unknown` and then fails on authentication reports `node-provider-signed-out`
([machine codes](../node-link.md#machine-start-failure-codes)).

There is no setting to stop a machine using its own sign-in. On
[cloud machines](./nodes.md#placement-on-e2b) (E2B and Northflank) the CLIs are never signed in, so only the
second rule applies. Providers without profiles have only the first.

#### Compatibility

The contract is additive under the [field-presence policy](../versioning.md#compatibility-policy).
Clients detect support through `supportsProfiles` and must not send qualified
references or call `providers.profiles.*` when it is absent. Older clients ignore the
new fields and show an unrecognized reference as a raw provider id. They preserve it
on write.
A daemon that advertises `supportsProfiles` but predates per-profile Fast mode
rejects a qualified `providers.fastMode` key with `-32602`; the whole update fails and
the stored map is unchanged, so clients surface the error rather than retrying.

Clients detect Default configuration overrides by the presence of `defaults` on the
`providers.profiles.list` result. When it is absent, a client may still offer the
Default name and environment controls (with nothing saved); an older daemon rejects
`providers.profiles.updateDefault` with `-32601`, which the client reports as a
failed save. Older clients ignore `defaults`, `defaultNames`
and the two Default event changes (they re-list on any revision), and keep labelling
the original configuration `Default`.

Clients detect remote compatibility by the presence of `remoteCompatible` on
`ProviderProfile`, `DefaultConfig` and `ProviderProfileSummary` rows. When it is
absent, they treat every configuration as compatible and rely on the
`profile-not-remote-compatible` refusal. Older clients ignore `remoteCompatible`,
`remoteIncompatibility` and `defaultRemoteIncompatibility`, and surface the refusal's
message.

Clients detect the **saved choice** by the presence of `remoteLaunch` on
`DefaultConfig` (and `defaultRemoteLaunch` on the catalog). Without them, the daemon computes `remoteCompatible` from the
account-folder rule: clients show it read-only and never send `remoteCompatible`,
which such a daemon ignores. Older clients keep working unchanged:

- The migration keeps every launch that worked before working, and `create`
  without the field applies the same rule.
- `update` and `updateDefault` without the field keep the saved choice, except
  that adding an account folder unmarks the configuration, and adding a credential
  to a Default marks it ([credential auto-mark](#default-credential-auto-mark)). Removing the folder does
  not mark it again, though today that edit makes it compatible; an older client
  cannot mark it, so the user marks it in a newer client. This is an accepted
  degradation: marking is consent.
- `defaultRemoteIncompatibility` is not sent, so an older picker offers every
  Default, which every machine with the provider signed in can run.
- An older Settings page reads an unmarked Default as `remoteCompatible: false`
  (`not-marked`) and may describe it as not remote-ready even though the machine's
  own sign-in runs it. This is an accepted, display-only degradation.
- New refusals (`not-marked`, `machine-not-signed-in`, `node-provider-signed-out`)
  reach older clients as ordinary errors with a full message.

Clients detect backup failover support by the presence of `backup` on
`ProviderProfile` and `ProviderProfileSummary`. When it is absent, they hide the
reorder and backup controls and never call `providers.profiles.reorder`. An older
client ignores `backup`, the `reordered` change and the `provider_failover` and
`provider_returned` row metadata, and still sees each row's text; failover and return
run without it.
