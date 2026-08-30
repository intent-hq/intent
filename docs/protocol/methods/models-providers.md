> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.30 `models.list` — model catalog · §5.38 Provider catalog — `providers.catalog`.

### 5.30 `models.list` — model catalog

The BE-owned model catalog every FE model picker reads (ModelPicker, background-agent settings,
workspace initializers, onboarding). It is the **richer, additive sibling** of `agent.getModels`
(§5.5), which keeps its lean `{ id, name, provider, description? }` rows unchanged.

| Method | Params | Result |
| --- | --- | --- |
| models.list | providerId?, forceRefresh?: boolean (default false) — no `workspaceId` | without `providerId`: { models: ModelInfo[], source: "auggie" \| "static", stale?, warning? }; with `providerId`: { providerId, models: ModelInfo[], source, stale?, warning? } |

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
On the catalogs parsed by the shared ACP row parser (claude-code / pi / droid;
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
  "stale": true,               // optional — present whenever last-good data is served: after a failed probe, or on an aged entry while a background refresh runs
  "warning": "..."             // optional — human-readable reason for fallback/stale/empty data
}
```

**Semantics:**

- **One generic per-provider cache.** All `models.list` requests — with or without `providerId` — go through a shared cache keyed on `(providerId, versionKey)`, persisted in the daemon data dir (`models-cache.json`) so it survives restarts. Cached entries are served while **fresh** — younger than the **24-hour** staleness threshold (`MODELS_STALE_AFTER`; behavior within v8.4, [intent-hq/intentd#1538](https://github.com/intent-hq/intentd/pull/1538) — v6.0's [intent-hq/intentd#987](https://github.com/intent-hq/intentd/pull/987) had dropped the original 5-minute TTL and served entries indefinitely). An entry's age is computed with saturating subtraction, so a future-stamped entry (clock skew) reads as age zero — fresh — until the clock catches up. The version key is registry-defined per provider (e.g. the full pinned npx package spec for claude-code); a pin bump (or package rename) invalidates cached entries automatically. The no-`providerId` legacy path resolves the same registered auggie source as `providerId: "auggie"` — same key, same cache — so the two can never diverge.
- `forceRefresh: true` skips the cache read, awaits a fresh probe **inline** (blocking), and stores the result on success. On failure it returns the **last-good** list labeled `stale: true` plus a `warning` — stale data is never served silently. It is the FE model picker's refresh button — the only client-driven way to force an inline re-probe of a cached provider (aged entries refresh on their own in the background, per the next bullet).
- **Non-forced reads never block while there is anything to serve** (stale-while-revalidate, [intent-hq/intentd#1583](https://github.com/intent-hq/intentd/pull/1583) / [intent-hq/intent#3874](https://github.com/intent-hq/intent/issues/3874)): an entry younger than the 24-hour threshold is a plain cache hit; an **aged** entry (at or past it) is served **immediately**, labeled `stale: true` with a `warning` (`cached model list for '<provider>' is stale; refreshing in the background`), while a single refresh probe runs detached in the background — so newly released provider models still surface without a manual refresh, and an aged entry never degrades below its last-good state (a failed background refresh leaves the last-good list in place). A probe is awaited inline only on a **true cache miss** — first use, or a version-key mismatch (e.g. after an adapter pin bump) — with the same last-good + `warning` fallback on failure.
- **Probe guards.** Concurrent probes for the same `(provider, version key)` are single-flighted — at most one probe runs; blocking callers (miss / `forceRefresh`) share its result, and a stale-serving read neither starts a second probe nor awaits a running one (a `forceRefresh` arriving mid-refresh joins the in-flight probe). A background refresh is additionally bounded by a **30-second hard timeout** — on expiry the fetch is abandoned, the timeout is negatively cached like any other probe failure, and the in-flight slot is released — and background refreshes across providers share a **daemon-wide concurrency cap of 2**, so simultaneous stale reads cannot fan out one adapter/CLI spawn per provider at once. A failed probe (blocking or background) is negatively cached for **60 seconds**: non-forced reads within the window skip the probe and serve what the cache has — a true miss serves the failed probe's degradation (static), an aged entry keeps being served as the stale-labeled last-good list with **no** background refresh spawned; `forceRefresh` bypasses the negative entry (and the cache read) but is still single-flighted. A successful probe clears the negative entry; empty successes are served but never cached, so they never masquerade as a last-good list.
- **Registered sources:** nine providers are registered — `auggie` (CLI discovery, below); `cortex` (gated behind `INTENTD_ENABLE_CORTEX` — hidden by default, not yet well-tested: a closed gate serves an empty list + `warning` under `source: "cortex"`; with the static tier catalog retired an open gate also serves an empty list, just with no `warning` — the provider CLI owns model selection); `claude-code`, `codex`, and `pi` (live ACP adapter probes); `droid` (live ACP adapter probe, gated behind `INTENTD_ENABLE_DROID` — hidden by default: a closed gate serves an empty list + `warning` without ever probing the binary, and since empty successes are never cached the gate cannot poison the last-good list); `opencode` and `grok` (native CLI discovery — each binary is resolved from its native installer location first, `~/.opencode/bin/opencode` and `~/.grok/bin/grok` respectively, **ahead of** the `PATH` scan, so a daemon spawned with a minimal `PATH` — e.g. from a packaged app — still finds a natively installed CLI; `~` denotes the daemon's resolved home directory (`$HOME`, or `%USERPROFILE%` on Windows), not shell expansion; on Windows only runnable `.exe`/`.cmd`/`.bat` entry points are probed — never the bare extensionless name); and `unsloth` (HTTP fetch, below — no CLI/adapter probe). Version keys are per-provider (e.g. the claude-code/codex/pi adapter version pins); the registry is designed for further providers to be added.
- **The `unsloth` source** fetches the Hugging Face `unsloth` org's GGUF repos (`https://huggingface.co/api/models?author=unsloth&filter=gguf&limit=1000`, 10s timeout) and builds **one row per repo, never per quant**: `id` is the full HF repo id (e.g. `unsloth/gemma-3-27b-it-GGUF` — the compound model id is `unsloth:<repo-id>`), `name` is the bare repo name with the trailing `-GGUF` stripped, and `description` reports the HF download count (the ranking signal); rows are sorted by downloads, ties broken by `trendingScore`. **Memory-fit filtering:** the total parameter count is parsed from the repo name (dense `27B`; MoE `35B-A3B` uses the total `35B`), the footprint is estimated at ~0.6 bytes/param (Q4-class) + 1 GiB headroom, and repos estimated to exceed **~70% of total system RAM** — or whose size cannot be parsed — are dropped, with the existing `warning` field reporting the count (`unsloth: <n> repo(s) hidden (estimated to exceed available memory, or size unknown)`); when RAM detection is unavailable the filter is skipped entirely — every repo is served, including size-unknown ones, and no hidden-count `warning` is emitted. When the filter hides **every** repo (or the response parses to zero repos), the source degrades to the "no models reported" unavailable path — matching the opencode/grok convention — rather than serving an empty success, so an empty catalog is never cached as valid. No new wire fields — the result reuses the standard `{ models, source, stale?, warning? }` shape and cache semantics.
- **Unknown/unregistered **`providerId` degrades to an **empty list** with `source: "static"` and a `warning` — never an error, so model pickers keep working. (The former static tier rows went with the tier tables, [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922); `source: "static"` survives as the degradation label only.)
- **Legacy path.** Without `providerId`, the response omits the `providerId` field (legacy shape) but follows the same cache semantics as `providerId: "auggie"`: a fresh entry is a plain hit; an aged entry is served immediately labeled `stale: true` + `warning` while a background refresh runs; on a failed probe the last-good list is served labeled `stale: true` + `warning` (forced or not), falling back to an **empty list** (`{ models: [], source: "static" }`, exactly those keys) only when no last-good list exists. Because the cache is persisted, last-good entries survive daemon restarts on this path too.

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

### 5.38 Provider catalog — `providers.catalog` *(v2.6; wire shape changed by [intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922))*

The static provider registry (the `intent-providers` crate's `ACP_PROVIDERS` table) served over the wire (monorepo#928), so clients no longer need a local copy of the provider config. **Daemon-global**: no params and no `workspaceId` (like `system.capabilities`), available on both UDS and WSS. The data is **compiled into the daemon** — there is no cache or TTL; the result only changes when the daemon binary does.

**Request:** `{}` (no parameters)

**Response:**

```jsonc
{
  "providers": [
    {
      "id": "auggie",
      "displayName": "Augment Auggie",
      "shortName": "Auggie",
      "command": "auggie",
      "canBeDisabled": true,
      "loginCommandHint": "auggie login",           // optional
      "loginDocsUrl": "https://docs.augmentcode.com/cli/overview",  // optional
      "authErrorPatterns": ["authentication required", "auggie login", "please run `auggie login`"],  // optional
      "visible": true
    },
    {
      "id": "claude-code",
      "displayName": "Anthropic Claude Code",
      "shortName": "Claude Code",
      "command": "claude-agent-acp",
      "canBeDisabled": true,
      "loginDocsUrl": "https://code.claude.com/docs/en/quickstart#step-2-log-in-to-your-account",  // optional
      "visible": true
    },
    {
      "id": "cortex",
      "displayName": "Snowflake Cortex",
      "shortName": "Cortex",
      "command": "cortex-acp",
      "canBeDisabled": true,
      "requiresEnvVar": "INTENTD_ENABLE_CORTEX",    // optional — raw gating field passed through
      "visible": false                              // daemon-evaluated: env var absent in the daemon environment
    },
    // ... one row per registered provider (opencode, unsloth, pi, droid, grok, ...) ...
    // droid carries requiresEnvVar: "INTENTD_ENABLE_DROID" and is likewise visible: false by default
    {
      "id": "mock",
      "displayName": "Mock (E2E)",
      "shortName": "Mock",
      "command": "node",
      "canBeDisabled": true,
      "requiresEnvVar": "MOCK_AGENT_SCRIPT_PATH",   // optional — raw gating field passed through
      "visible": false                              // daemon-evaluated: env var absent in the daemon environment
    }
  ]
}
```

- `providers` carries **all** registered providers — gated-off rows included — one row per registry entry, in **registry order**. The order is informational, not a contract: clients must key rows by `id`, never by array position.
- `command` is the registry's **logical CLI name** (the `ACP_PROVIDERS` `command` field, e.g. `claude-agent-acp` for `claude-code`) — provider metadata, **not** necessarily the binary the daemon spawns. Launch resolution belongs to `host.providerDiscovery` (§5.14), whose `command` reports what the daemon actually resolves and launches — so the two can differ: an npx-only provider like `claude-code` launches via `npx <npxPackage>` and reports `command: "npx"` there. Clients must not assume the values match across the two methods.
- `visible` is the **daemon-evaluated** gating verdict: `requiresEnvVar` is checked for **presence** against the **daemon's** process environment (an empty-string value counts as set), and a configured `requiresFeatureCode` **always** gates the row off (**default-deny** — the daemon stores no feature-code enablement; no registered provider currently carries one, but the mechanism remains for future providers). `cortex` and `droid` carry `requiresEnvVar` (`INTENTD_ENABLE_CORTEX` / `INTENTD_ENABLE_DROID`) and are hidden by default — not yet well-tested; setting the env var in the daemon's environment restores the provider. The raw gating fields pass through when set, so clients can either trust the verdict or re-derive it. This is the single env-var/feature-code gate shared with `host.providerDiscovery`'s `gatedOff` (§5.14).
- The optional fields (`loginCommandHint`, `loginDocsUrl`, `authErrorPatterns`, `requiresEnvVar`, `requiresFeatureCode`) are **omitted when unset, never null** — clients detect by presence.
- **No default designation, no model metadata ([intent-hq/intentd#922](https://github.com/intent-hq/intentd/pull/922)).** Rows carry no `isDefault` flag, the payload carries no top-level `defaultProviderId`, and the former per-row `modelTiers` (`{ fast, balanced, smart }` tier→model-id map) is gone — the static tier tables were removed with the model-tier concept. Model discovery is fully dynamic via `models.list` (§5.30). Clients derive the **effective default provider** from settings: the provider prefix of `model.default` when it is a compound id naming a registered provider, else `providers.active` (§5.12), else the first registered provider — the same derivation the daemon applies (§5.5 "Creation-time default-model resolution").

