> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.30 `models.list` — model catalog · §5.38 Provider catalog — `providers.catalog`.

Routing-only `workspaceId?` additions below are [prepared contract fields](../workspace-routing.md), optional on direct daemons and required for future forwarded workspace calls; existing scope and results are unchanged.

### 5.30 `models.list` — model catalog

The BE-owned model catalog every FE model picker reads (ModelPicker, background-agent settings,
workspace initializers, onboarding). It is the **richer, additive sibling** of `agent.getModels`
(§5.5), which keeps its lean `{ id, name, provider, description? }` rows unchanged.

| Method | Params | Result |
| --- | --- | --- |
| models.list | providerId?, forceRefresh?: boolean (default false), workspaceId? | without `providerId`: { models: ModelInfo[], source: "auggie" \| "static", stale?, warning? }; with `providerId`: { providerId, models: ModelInfo[], source, stale?, warning?, warningKind? } |

**ModelInfo** — `{ id, name, provider, description?, modelGroupPriority?: number, costTier?: number, badges?: [{ color, label, variant? }], effortLevels?: string[], isDefault?: boolean, priority?: number, isLegacyModel?: boolean }`.
`id` is the bare model id (`shortName`/`value`), `name` the display label
(`displayName`/`label`); the optional fields carry the picker metadata clients
consume (group/within-group ordering, cost tier `1..3`, badges, effort levels,
default flag, legacy-model flag). Optional fields are omitted when the provider does not
report them.
`isLegacyModel` is present only as `true` when a provider reports that the row is legacy.
`effortLevels` (v5.2) is the model's reasoning-effort vocabulary — the values a
client may offer for the `reasoningEffort` session field (§5.5) and the evidence
the daemon validates delegation/create-time levels against (§5.11 "Delegation
reasoning-effort resolution"). It is sourced from the adapter-advertised
`supportedEffortLevels` on the raw ACP model entry, with codex's known
effort-capable base models falling back to their fixed level set; effort-capable
models are served as **one base row** carrying the list — the pre-5.2 codex
`{model}/{effort}` variant rows are retired. Catalog `effortLevels` are
static/probe metadata, distinct from the session-scoped `effortLevels` served on
the `AgentSession`/`AgentLite` projections (§5.5 "Session-discovered effort
levels") — clients prefer the session-advertised levels for a live session's
picker and fall back to the catalog when the session advertises none.
On the catalogs parsed by the shared ACP row parser (claude-code / pi / droid / antigravity;
codex has its own effort-grouping parser and is deliberately outside this
normalization) the adapter's `default` pseudo-row is **hidden**: the daemon
resolves the real model it stands for — the model select's `currentValue` when
it names a real row, else the unique sibling row matching the pseudo-row's
version-bearing model family — and marks the resolved row `isDefault: true`.
The pseudo-row is dropped unconditionally whenever the catalog has at least one
real model row, resolved or not; when the resolution fails no row is marked
`isDefault` (the daemon never guesses). The single exception: a catalog whose
only row is the pseudo-row keeps it, so the resolution never empties a catalog.
Persisted model-catalog cache entries are sanitized the same way on load, so a
snapshot written by an older daemon cannot resurface the pseudo-row.

**Per-provider catalog.**

```jsonc
// → request
{
  "providerId": "auggie",  // optional — per-provider catalog via the generic cache
  "forceRefresh": false    // optional, default false — skip the cache read, await a fresh probe
}
// ← response (with providerId)
{
  "providerId": "auggie",
  "models": [ /* ModelInfo rows */ ],
  "source": "auggie",          // the provider id, or "static" on fallback
  "stale": true,               // optional — present only when the served list is stale: last-good after a failed probe, or an aged entry while a background refresh runs (never on a fresh cache hit)
  "warning": "...",            // optional — human-readable reason for fallback/stale/empty data
  "warningKind": "cli-missing" // optional — machine-readable cause of `warning` (see "Warning kind" below)
}
```

**Semantics:**

- **One generic per-provider cache.** All `models.list` requests — with or without `providerId` — go through a shared cache keyed on `(providerId, versionKey)`. Most providers persist entries in the daemon data dir (`models-cache.json`) across restarts. **Codex and Claude installed-CLI catalogs are process-local:** their auth/config fingerprints are private to the current daemon process, so their entries are neither restored nor written to disk. The first request after a cold restart must probe again; if that probe fails, no pre-restart last-good list is available. Cached entries are served while **fresh** — younger than the **24-hour** staleness threshold (`MODELS_STALE_AFTER`; behavior within v8.4, [intent-hq/intentd#1538](https://github.com/intent-hq/intentd/pull/1538) — v6.0's [intent-hq/intentd#987](https://github.com/intent-hq/intentd/pull/987) had dropped the original 5-minute TTL and served entries indefinitely). An entry's age is computed with saturating subtraction, so a future-stamped entry (clock skew) reads as age zero — fresh — until the clock catches up. The version key is registry-defined per provider. For Codex and Claude it includes the fixed adapter pin, selected installed executable identity and observed version, and relevant authentication/configuration context. Explicit refresh reobserves that identity; an installed CLI upgrade or context change invalidates the old catalog, and results from an obsolete in-flight probe cannot overwrite the new context. Other providers may use a package pin alone. The no-`providerId` legacy path resolves the same registered auggie source as `providerId: "auggie"` — same key, same cache — so the two can never diverge.
- `forceRefresh: true` skips the cache read, awaits a fresh probe **inline** (blocking), and stores the result on success. On failure it returns the **last-good** list for the same version/auth/config context labeled `stale: true` plus a `warning` — stale data is never served silently. It is the FE model picker's refresh button — the only client-driven way to force an inline re-probe of a cached provider (aged entries refresh on their own in the background, per the next bullet).
- **Non-forced catalog reads serve cached rows without waiting for a catalog refresh, after any required identity check.** For Codex and Claude, the installed CLI identity is reused for **60 seconds**. Once that observation expires, a non-forced request awaits discovery and the bounded installed-CLI version check **before** reading cached rows; concurrent requests share that identity check. If the executable or auth/config context changed, the old rows no longer match and the request awaits a new catalog probe. Explicit refresh also rechecks identity. For a matching identity (or providers without this identity check), cached rows follow stale-while-revalidate ([intent-hq/intentd#1583](https://github.com/intent-hq/intentd/pull/1583) / [intent-hq/intent#3874](https://github.com/intent-hq/intent/issues/3874)): an entry younger than the 24-hour threshold is a plain cache hit; an **aged** entry (at or past it) is served **immediately**, labeled `stale: true` with a `warning` (`cached model list for '<provider>' is stale; refreshing in the background`), while a single refresh probe runs detached in the background — so newly released provider models still surface without a manual refresh, and an aged entry never degrades below its last-good state (a failed background refresh leaves the last-good list in place). A catalog probe is awaited inline only on a **true cache miss** — first use, or a version-key mismatch (e.g. after an adapter pin bump) — with the same last-good + `warning` fallback on failure.
- **Probe guards.** Concurrent probes for the same `(provider, version key)` are single-flighted — at most one probe runs; blocking callers (miss / `forceRefresh`) share its result, and a stale-serving read neither starts a second probe nor awaits a running one (a `forceRefresh` arriving mid-refresh joins the in-flight probe). A background refresh is additionally bounded by a **30-second hard timeout** — on expiry the fetch is abandoned, the timeout is negatively cached like any other probe failure, and the in-flight slot is released — and background refreshes across providers share a **daemon-wide concurrency cap of 2**, so simultaneous stale reads cannot fan out one adapter/CLI spawn per provider at once. A failed probe (blocking or background) is negatively cached for **60 seconds**: non-forced reads within the window skip the probe and serve what the cache has — a true miss serves the failed probe's degradation (static), an aged entry keeps being served as the stale-labeled last-good list with **no** background refresh spawned; `forceRefresh` bypasses the negative entry (and the cache read) but is still single-flighted. A successful probe clears the negative entry; empty successes are served but never cached, so they never masquerade as a last-good list.
- **Registered sources:** providers include `auggie` (CLI discovery, below); `cortex` (gated behind `INTENTD_ENABLE_CORTEX` — hidden by default, not yet well-tested: a closed gate serves an empty list + `warning` under `source: "cortex"`; with the static tier catalog retired an open gate also serves an empty list, just with no `warning` — the provider CLI owns model selection); `claude-code`, `codex`, `pi`, and `antigravity` (live ACP adapter probes); `droid` (live ACP adapter probe, gated behind `INTENTD_ENABLE_DROID` — hidden by default: a closed gate serves an empty list + `warning` without ever probing the binary, and since empty successes are never cached the gate cannot poison the last-good list); `cursor` (session-free ACP probe — `cursor-agent acp`, `initialize`, then the `cursor/list_available_models` extension request, no `session/new`; see "Cursor discovery and selection" below); `opencode` and `grok` (native CLI discovery — each binary is resolved from its native installer location first, `~/.opencode/bin/opencode` and `~/.grok/bin/grok` respectively, **ahead of** the `PATH` scan, so a daemon spawned with a minimal `PATH` — e.g. from a packaged app — still finds a natively installed CLI; `~` denotes the daemon's resolved home directory (`$HOME`, or `%USERPROFILE%` on Windows), not shell expansion; on Windows only runnable `.exe`/`.cmd`/`.bat` entry points are probed — never the bare extensionless name); and `unsloth` (HTTP fetch, below — no CLI/adapter probe). Version keys are per-provider (installed CLI plus adapter/context for Codex and Claude; adapter pin for pi; a digest of the resolved `cursor-agent` path for Cursor, so switching installs or `providers.paths.cursor` never serves the previous binary's rows as fresh); the registry is designed for further providers to be added.
- **The `unsloth` source** fetches the Hugging Face `unsloth` org's GGUF repos (`https://huggingface.co/api/models?author=unsloth&filter=gguf&limit=1000`, 10s timeout) and builds **one row per repo, never per quant**: `id` is the full HF repo id (e.g. `unsloth/gemma-3-27b-it-GGUF` — on the wire the pair is provider `unsloth` plus the bare repo id as `model`), `name` is the bare repo name with the trailing `-GGUF` stripped, and `description` reports the HF download count (the ranking signal); rows are sorted by downloads, ties broken by `trendingScore`. **Memory-fit filtering:** the total parameter count is parsed from the repo name (dense `27B`; MoE `35B-A3B` uses the total `35B`), the footprint is estimated at ~0.6 bytes/param (Q4-class) + 1 GiB headroom, and repos estimated to exceed **~70% of total system RAM** — or whose size cannot be parsed — are dropped, with the existing `warning` field reporting the count (`unsloth: <n> repo(s) hidden (estimated to exceed available memory, or size unknown)`); when RAM detection is unavailable the filter is skipped entirely — every repo is served, including size-unknown ones, and no hidden-count `warning` is emitted. When the filter hides **every** repo (or the response parses to zero repos), the source degrades to the "no models reported" unavailable path — matching the opencode/grok convention — rather than serving an empty success, so an empty catalog is never cached as valid. No new wire fields — the result reuses the standard `{ models, source, stale?, warning? }` shape and cache semantics.
- **Warning kind.** A provider-scoped response (with `providerId`, including a [provider profile reference](./provider-profiles.md), §5.54) may carry `warningKind` next to `warning` when the daemon knows the cause of a failed catalog fetch. Values: `"cli-missing"` — the provider CLI binary the catalog requires was not found on the execution host (currently emitted for `codex` and `claude-code`, see "Codex and Claude runtime selection" below); `"prerequisite-missing"` — a runtime the provider's pinned adapter needs (Node.js with `npx`, for `codex` and `claude-code`) is missing. `warningKind` is present only when `warning` is present and describes a failed fetch — never alongside a fresh successful list (e.g. unsloth's informational hidden-repo `warning`) and never on the aged-entry `cached model list … is stale; refreshing in the background` notice. A failed probe's kind is kept with its `warning` in the 60-second negative cache, so a response served from that failure — the degraded empty list, or the `stale: true` last-good list (including an aged entry re-served inside the negative window) — carries the same kind. The kind is never persisted: after a restart no response carries it until a probe fails again. Every other failure (adapter exit, probe timeout, spawn/transport/RPC failure, authentication required, empty catalog, queue timeout, changed installed context) currently carries no kind; new values may be added without a version bump. The `warning` text is unchanged and human-readable only — clients must key presentation (e.g. an "install the CLI" notice) on `warningKind`, never on the text, and must treat an absent or unrecognized value as a generic load failure. The legacy no-`providerId` path never emits it. Older daemons omit the field.
- **Unknown/unregistered **`providerId` degrades to an **empty list** with `source: "static"` and a `warning` — never an error, so model pickers keep working. (The former static tier rows went with the tier tables, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922); `source: "static"` survives as the degradation label only.)
- **Legacy path.** Without `providerId`, the response omits the `providerId` field (legacy shape) but follows the same cache semantics as `providerId: "auggie"`: a fresh entry is a plain hit; an aged entry is served immediately labeled `stale: true` + `warning` while a background refresh runs; on a failed probe the last-good list is served labeled `stale: true` + `warning` (forced or not), falling back to an **empty list** (`{ models: [], source: "static" }`, exactly those keys) only when no last-good list exists. Because the cache is persisted, last-good entries survive daemon restarts on this path too.

**Codex and Claude runtime selection.** Both require the canonical `codex` or `claude` executable on the execution host (the daemon/worker host for remote workspaces). Enhanced executable discovery also checks supported installer/version-manager directories and captured login-shell PATH, so a GUI/service PATH need not contain the CLI directory. Shell aliases/functions do not qualify. The daemon supplies the selected absolute path to its reviewed ACP adapter; bundled npm dependencies are never a runtime fallback. Upgrade the installed CLI, then refresh the picker to discover its advertised models without changing the adapter. Adapter/CLI protocol compatibility is still required, and catalog membership does not prove account entitlement. Automatic catalog probes send no prompts. Running sessions keep their current process; new launches select the current installed CLI. Missing or incompatible CLIs produce a warning/launch failure, not an alternate runtime or model; a missing CLI on `models.list` is labeled `warningKind: "cli-missing"`.

**Antigravity discovery and selection.** The daemon runs the user's `agy` CLI as `agy acp --app-data-dir antigravity-intent-probe`, so catalog sessions stay out of the user's agy history. Rows are the base models of the session's `configOptions[id="model"]` select, with the `thought_level` select as effort levels; the select's `currentValue` is the default. A model refresh first updates an agy older than 1.5.0 (see the `antigravity` CLI fields under `host.providerDiscovery`, §5.14). Cached and forced-refresh responses follow the generic rules above.

Sessions run `agy acp` with the user's own agy settings, hooks and MCP servers, plus the workspace MCP servers. After session open the daemon applies the saved model with `session/set_config_option` (agy accepts a base id or an effort variant such as `gemini-3.8-flash-low`); a rejected model fails setup before any prompt. The daemon never sends `authenticate`, which opens a browser; sign in on the daemon host with `agy acp --login`. Role tool restrictions are prompt-only, because `agy acp` has no tool-removal flag.

**Cursor discovery and selection** *([intent-hq/intentd#3073](https://github.com/intent-hq/intentd/pull/3073))*. The daemon runs the user-installed `cursor-agent` (resolved as described for `host.providerDiscovery`, §5.14) as `cursor-agent acp` and asks for `cursor/list_available_models` straight after `initialize`. No ACP session is opened, so a catalog probe adds no chat to the user's Cursor history. Rows are Cursor's **base** model ids (`value`, e.g. `gpt-5.2`) with Cursor's display names; the `default` row is Cursor's **Auto** model and is marked `isDefault: true`. A signed-out CLI answers the extension request with an authentication-required error, which degrades like any failed probe (empty or last-good list plus `warning`, no `warningKind`). Cached and forced-refresh responses follow the generic rules above.

A session's own `model` config option lists one variant per base model (`<base>[param=value,…]`). At session start the daemon maps the saved base id onto that list — after stripping a `cursor:` prefix, exact value first, then the `<base>[` prefix — and applies it with `session/set_config_option`. With no saved model, the daemon explicitly applies Cursor's `default` (Auto) model the same way. No match, or a rejected value, stops setup with an actionable error and no prompt is sent; the user refreshes models and picks an available id. Applying a model also saves it as the user's own Cursor CLI default model (Cursor's behavior, accepted for this integration).

**Auggie discovery** (the registered `auggie` source):

1. `auggie model list --json` — rich metadata (`id` ← `shortName`, `name` ← `displayName`).
2. Plain `auggie model list` text fallback (`- Label [model-id]` rows + optional indented
   description) when the JSON form fails or parses empty.
3. All rows are preserved. Rows for which Auggie reports `isLegacyModel: true` keep that flag;
   current rows omit it. Rows are sorted by `modelGroupPriority`, then `priority`, then `name`
   (missing priorities sort last). A successful CLI result is cached per the generic
   per-provider cache above.
4. When the auggie CLI is unavailable or yields nothing parseable (and no last-good entry
   exists), an **empty list** is returned with `source: "static"` — there is no static
   fallback catalog (the provider CLI owns model discovery, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922));
   clients can key honest "live vs fallback" UI off `source`.

Errors: `-32603` only on internal failure; probe/CLI failures degrade as described above.

```json
// → request (legacy path, no providerId)
{ "jsonrpc":"2.0","id":82,"method":"models.list" }
// ← response
{ "jsonrpc":"2.0","id":82,"result":{ "source":"auggie","models":[
  { "id":"sonnet4.5","name":"Sonnet 4.5","provider":"auggie",
    "description":"Balanced general model","modelGroupPriority":1,"costTier":2,
    "badges":[{ "color":"green","label":"Auto" }],"effortLevels":["low","medium","high"],
    "isDefault":true,"priority":1 } ] } }
```

### 5.38 Provider catalog — `providers.catalog` *(v2.6; wire shape changed by [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922); `supportsTestPrompt` added in v9.3 by [intent-hq/intentd#1657](https://github.com/intent-hq/intentd/pull/1657))*

The static provider registry (the `intent-providers` crate's `ACP_PROVIDERS` table) served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. **Daemon-global result**, available on both UDS and WSS. Optional `workspaceId` is prepared routing context only, like `system.capabilities`; it does not filter the registry. The registry is **compiled into the daemon**, with visibility evaluated against the daemon process environment; there is no cache or TTL.

**Prepared request:** `{ workspaceId?: string }`; `{}` remains compatible on direct daemons.

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "auggie",
      "legacyAliases": ["default", "acp", "augment"], // optional — authoritative historical identities
      "displayName": "Augment Auggie",
      "shortName": "Auggie",
      "command": "auggie",
      "canBeDisabled": true,
      "supportsFastMode": false,
      "loginCommandHint": "auggie login",           // optional
      "loginDocsUrl": "https://docs.augmentcode.com/cli/overview",  // optional
      "authErrorPatterns": ["authentication required", "auggie login", "please run `auggie login`"],  // optional
      "visible": true,
      "supportsTestPrompt": true                    // always present; false only for unsloth (v9.3)
    },
    {
      "id": "claude-code",
      "displayName": "Anthropic Claude Code",
      "shortName": "Claude Code",
      "command": "claude-agent-acp",
      "canBeDisabled": true,
      "supportsFastMode": true,                    // additive; absent means unsupported
      "loginDocsUrl": "https://code.claude.com/docs/en/quickstart#step-2-log-in-to-your-account",  // optional
      "visible": true,
      "supportsTestPrompt": true
    },
    {
      "id": "codex",
      "displayName": "OpenAI Codex",
      "shortName": "Codex",
      "command": "codex-acp",
      "canBeDisabled": true,
      "supportsFastMode": true,
      "visible": true,
      "supportsTestPrompt": true
    },
    {
      "id": "cortex",
      "displayName": "Snowflake Cortex",
      "shortName": "Cortex",
      "command": "cortex-acp",
      "canBeDisabled": true,
      "supportsFastMode": false,
      "requiresEnvVar": "INTENTD_ENABLE_CORTEX",    // optional — raw gating field passed through
      "visible": false,                             // daemon-evaluated: env var absent in the daemon environment
      "supportsTestPrompt": true
    },
    // ... one row per registered provider (opencode, unsloth, pi, droid, grok, antigravity, cursor, ...) ...
    // droid carries requiresEnvVar: "INTENTD_ENABLE_DROID" and is likewise visible: false by default
    // unsloth is the one row with supportsTestPrompt: false — its first prompt can trigger a very long model download/load cycle
    {
      "id": "mock",
      "displayName": "Mock (E2E)",
      "shortName": "Mock",
      "command": "node",
      "canBeDisabled": true,
      "supportsFastMode": false,
      "requiresEnvVar": "MOCK_AGENT_SCRIPT_PATH",   // optional — raw gating field passed through
      "visible": false,                             // daemon-evaluated: env var absent in the daemon environment
      "supportsTestPrompt": true
    }
  ]
}
```

- `providers` carries **all** registered providers — gated-off rows included — one row per registry entry, in **registry order**. The order is informational, not a contract: clients must key rows by `id`, never by array position.
- `legacyAliases?: string[]` advertises historical provider identities that resolve to the row's canonical `id`. It is derived from the daemon's recognized-alias resolver, not its separate fallback for arbitrary unknown IDs. Resolve an exact registered `id` first, then an exact, case-sensitive advertised alias. No case folding, trimming, fuzzy matching, or settings/default/order inference applies. Currently `default`, `acp`, and `augment` resolve to `auggie`; clients consume the advertised mapping rather than hardcoding that target. Empty strings and absent identity are not aliases.
- Alias metadata describes **identity**, independently of the configured default, enablement, installation, authentication, visibility, or model availability. It does not select a default or make a provider usable. Selection flags and provider capabilities retain their existing meanings.
- **Additive compatibility:** `legacyAliases` is omitted when a row has no aliases, never `null`. Older daemons omit it entirely; a catalog that has not loaded supplies no alias authority either. Without an advertised match, preserve the raw unresolved identity and avoid alias-dependent writes until authoritative metadata is available. Canonical IDs and explicit canonical user choices remain usable. An omitted field must not be replaced by a settings-derived or positional guess. Existing clients accept the optional field and keep their existing behavior; corrected alias handling requires a client that consumes it and a daemon that supplies it. This addition uses the existing RPC and [field-presence compatibility policy](../versioning.md#compatibility-policy), with no protocol-version bump or session migration.
- `command` is the registry's **logical CLI name** (the `ACP_PROVIDERS` `command` field, e.g. `claude-agent-acp` for `claude-code`) — provider metadata, **not** necessarily the binary the daemon spawns. Launch resolution belongs to `host.providerDiscovery` (§5.14), whose `command` reports what the daemon actually resolves and launches — so the two can differ: an npx-only provider like `claude-code` launches via `npx <npxPackage>` and reports `command: "npx"` there. Clients must not assume the values match across the two methods.
- `visible` is the **daemon-evaluated** gating verdict: `requiresEnvVar` is checked for **presence** against the **daemon's** process environment (an empty-string value counts as set), and a configured `requiresFeatureCode` **always** gates the row off (**default-deny** — the daemon stores no feature-code enablement; no registered provider currently carries one, but the mechanism remains for future providers). `cortex` and `droid` carry `requiresEnvVar` (`INTENTD_ENABLE_CORTEX` / `INTENTD_ENABLE_DROID`) and are hidden by default — not yet well-tested; setting the env var in the daemon's environment restores the provider. The raw gating fields pass through when set, so clients can either trust the verdict or re-derive it. This is the single env-var/feature-code gate shared with `host.providerDiscovery`'s `gatedOff` (§5.14).
- The optional fields (`legacyAliases`, `loginCommandHint`, `loginDocsUrl`, `authErrorPatterns`, `requiresEnvVar`, `requiresFeatureCode`) are **omitted when unset, never null** — clients detect by presence.
- `supportsTestPrompt` *(v9.3; [intent-hq/intentd#1657](https://github.com/intent-hq/intentd/pull/1657))* is **always present**: whether the provider can be exercised by the live `host.providerTestPrompt` probe (§5.14). `false` for `unsloth`, whose first prompt can trigger a long model download; `true` for every other row, including `antigravity` (since 18.0) and `cursor`. For the opt-out providers, the RPC returns `unsupported` without resolution or spawn.
- `supportsProfiles` and the top-level `profiles` list are prepared additive
  fields for [named provider profiles](provider-profiles.md#catalog-models-and-status).
  `providers` keeps one row per provider type. `models.list` accepts a profile
  `providerRef` as `providerId`. The additive top-level `defaultNames` map labels
  a renamed [Default configuration](provider-profiles.md#default-configuration-overrides).
- `supportsFastMode` is an additive boolean: whether this daemon can apply the
  provider's `providers.fastMode` preference (§5.12). Implementing daemons emit it
  on every row: `true` for `claude-code` and `codex`, `false` for other providers.
  Older daemons omit it; clients treat omission as `false` and also require the
  setting to be present in `settings.list` before offering the toggle. This is an
  integration capability, not current account/model eligibility or confirmation
  that a running session uses Fast mode. Model selection and provider availability
  keep their existing meanings.
- **No default designation, no model metadata ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)).** Rows carry no `isDefault` flag, the payload carries no top-level `defaultProviderId`, and the former per-row `modelTiers` (`{ fast, balanced, smart }` tier→model-id map) is gone — the static tier tables were removed with the model-tier concept. Model discovery is fully dynamic via `models.list` (§5.30). Clients derive the **effective default provider** from settings: `model.defaultProvider` when it names a registered provider (§5.12; [intent-hq/intentd#1648](https://github.com/intent-hq/intentd/pull/1648)), else it is unset — there is no positional fallback to the first registered provider ([intent-hq/monorepo#3044](https://github.com/intent-hq/monorepo/issues/3044)) — the same derivation the daemon applies (§5.5 "Creation-time default-model resolution").

Antigravity is an opt-in catalog entry: `id: "antigravity"`, `command: "agy"` (launched as `agy acp`, agy 1.5.0 or later), `canBeDisabled: true`, `loginCommandHint: "agy acp --login"`, and `supportsTestPrompt: true`. Discovery does not enable it or change the active provider.

Cursor is an opt-in provider that the user enables in Settings *([intent-hq/intentd#3073](https://github.com/intent-hq/intentd/pull/3073))*: `id: "cursor"`, `displayName` and `shortName` `"Cursor"`, `command: "cursor-agent"` (never the bare `agent` alias), `canBeDisabled: true`, `loginCommandHint: "cursor-agent login"`, `loginDocsUrl: "https://cursor.com/docs/cli/reference/authentication"`, `authErrorPatterns: ["authentication required"]`, `supportsTestPrompt: true`, and `supportsProfiles: false`. It carries no `requiresEnvVar` or `requiresFeatureCode`, so `visible` is `true`. Like the other opt-in providers it stays off until the user enables it: discovery, a successful auth probe, or a served model list never enables it automatically or changes the active provider. Auth is described under `host.providerAuthStatus` and the CLI fields under `host.providerDiscovery` (§5.14).

### 5.44 Guided Antigravity setup

Retired in 18.0. Protocol 18.0 removed the guided setup surface: `providers.setup.status`, `providers.setup.start`, `providers.setup.login` and `providers.setup.cancel` return `-32601 Method not found`, the `providers.setup.openLogin` reverse RPC is never sent, and `server.capabilities.antigravitySetup` is no longer advertised. Antigravity is a plain CLI provider backed by the user's `agy acp` ([intent-hq/intentd#3267](https://github.com/intent-hq/intentd/pull/3267)). See the 9.8 and 18.0 entries in [versioning.md](../versioning.md).
