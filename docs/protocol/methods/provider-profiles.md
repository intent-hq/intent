> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.54 Provider profiles (prepared).

### 5.54 Provider profiles *(prepared)*

This is a **prepared contract** for named configurations of an installed Codex or
Claude Code CLI. It is not implemented by the current pins. Each profile has a
stable identity, a display name, a base provider and environment overrides. A
profile shares its base provider's installation, executable path, enablement and
Fast mode preference. The original configuration stays available as **Default**
and is not a profile. Hosts with no profiles keep their current behavior.

Fallback chains are out of scope. This contract defines no chain schema. A later
chain can reference profiles through the provider references below.

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

`providers.enabled`, `providers.paths`, `providers.fastMode` and the access-token
settings stay keyed by the base provider id. Qualified references are rejected
there; a profile inherits those values from its base provider.

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
paths such as `providers.codex.accessToken`. No registered provider id contains `@`.
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
| `id`, `name`, `baseProviderId`, timestamps | Daemon-owned file `<data_dir>/provider-profiles.json` (mode `0600`, next to `config.toml`): `{ "version": 1, "profiles": [{ "id", "baseProvider", "name", "createdAt", "updatedAt" }] }` | Only through `providers.profiles.*`. Not a `settings.*` path: `settings.get` / `settings.reset` return `-32602`, and `settings.update` rejects it. |
| Environment entries | Existing protected `SecretStore`, account `providerProfiles.<profileId>.env`, one JSON document per profile | Only through `providers.profiles.*` reads, masked |

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
- **Reads.** The daemon reads the file at startup and after its own writes. It does
  not watch for external edits; changes made outside the daemon apply after a restart.
  If the file is malformed or has an unknown `version`, the daemon still starts and
  leaves the file untouched. `providers.profiles.*` then return `-32603` with
  `data.code: "provider-profiles-unreadable"`, and qualified references fail with
  `provider-profile-replacement-required` (`reason: "profile-missing"`).

Environment values never enter `config.toml`, the profile file, the ordinary
`providers.*` map, the settings database, `settings.list`, `settings:changed`,
catalogs, model rows, events, agent-visible metadata or logs. Deleting a profile
removes both records and prunes its `model.providerDefaults` entry (see
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
- `providers.profiles.delete` removes the profile's `model.providerDefaults` key in
  the same commit. That emits `settings:changed` with the new settings revision, as
  well as `providers:profiles-changed`.
- `quickActions.providerSettings` stays client-owned and unvalidated.

#### Methods

Router methods. They are administrator-only like `settings.*`, and members and
guests receive `-32003`. Each is daemon-global, with no `workspaceId` required.

| Method | Params | Result |
| --- | --- | --- |
| providers.profiles.list | baseProviderId? | { profiles: ProviderProfile[], revision } |
| providers.profiles.create | baseProviderId (req), name (req), env?: EnvEntryWrite[] | { profile: ProviderProfile, revision } |
| providers.profiles.update | profileId (req), name?, env?: EnvEntryWrite[] | { profile: ProviderProfile, revision, activation: ProfileActivation } |
| providers.profiles.delete | profileId (req) | { profileId, revision } |

```ts
interface ProviderProfile {
  id: string;                 // opaque, immutable
  providerRef: string;        // "<baseProviderId>@<id>" — the value for every provider field
  baseProviderId: "codex" | "claude-code";
  name: string;               // trimmed display name
  env: EnvEntryRead[];        // masked; in stored order
  settingsFingerprint: string; // opaque; changes whenever saved env changes; not derived from values alone
  createdAt: string;          // RFC 3339
  updatedAt: string;
  activation?: { runningProcesses: number }; // see "Activation on reads"
}
type EnvEntryRead =
  | { key: string; kind: "set"; value: "********" | "" } // "" means a saved empty string
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
  or executed. Profile entries override inherited values for the same key.
- **Update.** `env`, when present, is the complete new list. Keys left out are removed,
  which restores inheritance. `keep` preserves a saved entry's kind and value without
  echoing the secret, so a masked field stays unchanged. Omitting `env` leaves all
  entries unchanged. A rename never changes `id`, `providerRef` or routing.
- **Atomicity.** Each mutation validates fully before writing. It commits metadata
  and secrets together or changes nothing.
- **`revision`** is a process-local, strictly increasing profile watermark with the
  same client rules as the [settings revision](settings.md). Reset it on reconnect
  and ignore older results and events.
- `list` returns masked values only. No method returns a saved value.
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

**Validation.** Invalid input returns `-32602` with `data.code: "invalid-params"` and
`data.fieldErrors: [{ field, code, message }]`, listing every failure found:

| `field` | `code` | Rule |
| --- | --- | --- |
| `baseProviderId` | `base-provider-unsupported` | It must be a canonical id with `supportsProfiles: true`. |
| `name` | `name-blank` | It must not be empty after trimming Unicode whitespace. |
| `name` | `name-invalid` | No control characters, and at most 64 Unicode scalar values after trimming. |
| `name` | `name-duplicate` | Names must be unique within one base provider, ignoring case (Unicode simple case folding). The same name may exist under another base provider. |
| `name` | `name-reserved` | `Default`, ignoring case, names the original configuration. |
| `baseProviderId` | `profile-limit` | At most 32 profiles per base provider. |
| `env` | `env-limit` | At most 64 entries. |
| `env[i].key` | `env-key-invalid` | The key must match `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. |
| `env[i].key` | `env-key-duplicate` | Keys must be unique ignoring ASCII case, so behavior is the same on Windows. |
| `env[i].key` | `env-key-reserved` | Reserved keys are listed below. |
| `env[i].value` | `env-value-invalid` | No NUL characters, and at most 32 KiB of UTF-8. |
| `env[i].value` | `env-value-placeholder` | A `set` value of `********` is rejected. Use `kind: "keep"`. |
| `env[i].kind` | `env-keep-missing` | `keep` names a key with no saved entry, or appears on create. |

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
  (`{ id, providerRef, baseProviderId, name }`). It has no env and no counts, and
  member reads may include it. `providers` rows stay one per provider type, so
  onboarding, which reads only `providers`, shows each type once. The `profiles` list
  reflects saved metadata at read time. `providers:profiles-changed` invalidates it.
- `models.list { providerId: providerRef }` returns that profile's catalog with
  `ModelInfo.provider = providerRef`. Cache keys and the version key include the
  profile's resolved environment fingerprint. Catalogs and cached status never cross
  profiles or configuration changes. On an older daemon an unknown `providerId` keeps
  its existing empty-list-plus-`warning` degradation.
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
- **Delegation.** Explicit param, then specialist, then app default; precedence is
  unchanged. A child never inherits its parent's profile, and no account is inferred
  across providers by profile name.
- **Restart copy.** The daemon does not report who owns it. A client that spawned its
  own local daemon (the desktop sidecar) says to restart Intent. Otherwise it names
  intentd on the provider host. UDS locality alone does not mean the daemon is
  app-owned, and a client reconnect never counts as applying an edit.

#### Events

`providers:profiles-changed` is global (no `workspaceId`). The daemon emits exactly
one event, with a `revision` one higher than the previous event, in two cases:

- **A committed `providers.profiles.*` mutation.** Each mutation changes exactly one
  profile. `change` is `"created"`, `"updated"` or `"deleted"`.
- **A change in one profile's `activation.runningProcesses`.** For example, a
  process on earlier settings exits or is recycled, or a new process starts.
  `change` is `"activation"`, and `profile` and `envChanged` are omitted. The event
  carries no count; clients re-run `providers.profiles.list` to read it.

The daemon does not reload the profile file, so no event covers several profiles.
The payload is
`data = { revision, change: "created" | "updated" | "deleted" | "activation", profileId, profile?: ProviderProfileSummary, envChanged?: boolean }`.
It never carries env keys or values. `profile` is omitted on delete and activation
events. A client re-runs `providers.profiles.list` (or `providers.catalog`) when it
sees an activation event, a revision gap, or a reconnect. A delete that prunes a `model.providerDefaults` key also emits
`settings:changed`, with its own settings revision.

#### Compatibility

The contract is additive under the [field-presence policy](../versioning.md#compatibility-policy).
Clients detect support through `supportsProfiles` and must not send qualified
references or call `providers.profiles.*` when it is absent. Older clients ignore the
new fields and show an unrecognized reference as a raw provider id. They preserve it
on write.
