> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.41 Voice transcription — `voice.transcribe` / `voice.getWorkspaceVocabulary`.

### 5.41 Voice transcription — `voice.transcribe` / `voice.getWorkspaceVocabulary` *(v4.3; workspace vocabulary v5.1)*

Daemon-owned speech-to-text behind a pluggable provider seam: the client records audio
(e.g. the desktop push-to-talk flow), ships it base64-encoded, and the daemon calls the
configured transcription provider — **ElevenLabs Scribe** (`scribe_v2`) or **OpenAI**
(the configured `voice.openai.model`, default `gpt-4o-transcribe`; `whisper-1`
fallback) — and returns the transcript. Daemon-owned so the provider API keys live in
the daemon's file-backed secret store and **never reach clients** (the same 🔒 secret
guardrail as `linear.token`, §5.28: keys are never logged, echoed, or returned over the
wire). **Daemon-global**: no required `workspaceId` (like `stats.getRateHistory`,
§5.39) — since v5.1 `voice.transcribe` accepts an **optional** `workspaceId?` that
opts the call into workspace-vocabulary injection (see "Workspace vocabulary" below),
and the companion read RPC `voice.getWorkspaceVocabulary` is workspace-scoped
(`workspaceId` req).

| Method | Params | Result |
| --- | --- | --- |
| voice.transcribe | audio (req), mimeType?, language?, provider?, context?, workspaceId? *(v5.1)* | `{ text, provider, durationMs }` — `durationMs` always present, `null` when unknown |
| voice.getWorkspaceVocabulary *(v5.1)* | workspaceId (req) | `{ terms: string[] }` — the auto-derived workspace vocabulary, derived terms only (the user's `voice.vocabulary` is not merged in) |

**Params:**

- `audio` (req) — the recorded audio bytes, **base64-encoded** (standard alphabet,
  padded). Typically webm/opus (the FE `MediaRecorder` default) or wav; the daemon
  forwards the bytes to the provider unchanged. Missing, blank, invalid base64, or a
  payload that decodes to zero bytes → `-32602`. Capped at **25 MB decoded**
  (`26,214,400` bytes), enforced twice — pre-decode on the base64 text length and
  post-decode on the byte length — so an over-cap payload is rejected before any
  provider call (see errors below).
- `mimeType?` — the audio container MIME type (e.g. `"audio/webm"`, `"audio/wav"`);
  defaults to `"audio/webm"` when omitted or blank.
- `language?` — optional language hint, forwarded to the provider. When absent or
  blank, the `voice.language` setting (§5.12) fills the gap — see "Language
  resolution" below.
- `provider?` — per-call provider override: `"elevenlabs" | "openai"` (the same enum as
  the `voice.provider` setting); any other value → `-32602`. Absent → the
  `voice.provider` setting (§5.12) selects the provider.
- `context?` — `{ prompt?: string, keyterms?: string[] }` — optional domain-vocabulary
  hints for transcription accuracy (e.g. workspace title, branch name, agent names).
  `keyterms` must be an array of strings (a non-array or non-string element →
  `-32602`; an explicit `null` is treated as absent). Mapped per provider — see
  "Context mapping" below.
- `workspaceId?` *(v5.1)* — opt-in workspace-vocabulary injection: when present and
  naming a known workspace, the daemon merges that workspace's auto-derived
  vocabulary into the transcription bias (see "Workspace vocabulary" below).
  **Tolerant by design**: an absent, unknown, or stale `workspaceId` (e.g. a
  workspace deleted since the client cached it) is never an error — the call behaves
  exactly like a no-`workspaceId` call; only a wrong **type** (a non-string value)
  → `-32602`.

**Result:**

- `text` — the transcript.
- `provider` — the provider that actually served the request (`"elevenlabs"` or
  `"openai"`), so clients can attribute the result when the setting (not a per-call
  override) chose it.
- `durationMs` — the transcribed **audio duration** in milliseconds as reported by the
  provider (ElevenLabs: the last word's `end` timestamp; OpenAI: the response
  `duration` field — not request latency). **Always present, `null` when the provider
  does not report it** (unlike the §5.39-style omitted-when-unset convention).

**Context mapping (per provider).** The daemon biases every transcription with the
user-editable **`voice.vocabulary`** setting (§5.12 — a string array defaulting to
`["Intent"]`; users add their own terms, the shipped default is minimal),
**read per call** — an absent or non-array stored value degrades to an empty list and
non-string elements are skipped, never an error — plus a fixed style hint ("Technical dictation in a
software-engineering app; preserve code identifiers and file paths verbatim.") — and,
when the call carries a `workspaceId` naming a known workspace, the auto-derived
**workspace vocabulary** (v5.1; see "Workspace vocabulary" below) — and merges the
request's `context` into it, in the fixed order user `voice.vocabulary` → workspace
auto-terms → `context.keyterms`:

- **OpenAI** — composed into the API's single free-form `prompt` parameter: the style
  hint, then `" Vocabulary: <terms comma-joined>."` (configured vocabulary +
  workspace auto-terms + `context.keyterms`, in that order), then `context.prompt`
  appended.
- **ElevenLabs** — the configured vocabulary and `context.keyterms` feed Scribe v2
  **keyterm prompting** (repeated `keyterms` form fields; requires `model_id:
  scribe_v2`): vocabulary first, then workspace auto-terms, then request keyterms;
  case-insensitive dedup (first
  spelling wins); blank and > 50-char terms skipped; hard cap of 100 total.
  `context.prompt` has no ElevenLabs equivalent and is **ignored** for this provider.

**Workspace vocabulary (v5.1).** When `voice.transcribe` carries a `workspaceId`, the
daemon injects that workspace's **auto-derived vocabulary** — unique/non-dictionary
and rare terms mined from the workspace's own docs, so project-specific identifiers
(e.g. "intentd", "clippy") transcribe correctly with no manual `voice.vocabulary`
entry — into the merge, between the user vocabulary and the request keyterms: user
`voice.vocabulary` → workspace auto-terms → `context.keyterms`, under the existing
rules above (case-insensitive dedup, first spelling wins; blank and > 50-char terms
skipped; hard cap of 100 total). Derivation sources are the workspace's root
`README` / `AGENTS` docs, the same docs one directory level down (e.g.
`packages/*/README.md`-style direct children), and the workspace's spec note; the
derived list is capped by the `voice.workspaceVocabulary.maxTerms` setting (§5.12 —
default 50, `0` disables derivation and injection entirely) and **content-hash
cached**: unchanged sources mean no re-extraction on subsequent calls (a source edit
or a `maxTerms` change takes effect on the next derivation). Per the `workspaceId?`
param above, a stale or unknown id degrades to no injection — never an error.

**Providers.** Both are typed REST engines over `reqwest` (the `intent-linear` /
`intent-sentry` pattern):

- **ElevenLabs** — multipart `POST https://api.elevenlabs.io/v1/speech-to-text` with
  `model_id: scribe_v2` (required for keyterm prompting).
- **OpenAI** — multipart `POST https://api.openai.com/v1/audio/transcriptions` with
  `model:` the configured `voice.openai.model` setting (§5.12; `gpt-4o-transcribe` |
  `gpt-4o-mini-transcribe` | `whisper-1`, default `gpt-4o-transcribe`), with a one-shot
  `whisper-1` fallback when the selected model is unavailable on the account (404 /
  model-not-found) — skipped when `whisper-1` itself is the selected model.

**Language resolution.** The language hint the daemon forwards to the provider is
resolved as: per-call `language` → the `voice.language` setting (§5.12) → none
(provider auto-detection). Both rungs are trimmed and a blank value behaves like
omitted — a whitespace-only per-call `language` falls through to the setting, and a
blank stored setting is treated as unset. The setting is an optional ISO-639-1 string
with no default, TOML-backed under `[voice]` like `voice.provider`.

**Settings & secrets (§5.12).** `voice.provider` (enum: `elevenlabs` | `openai`, default
`elevenlabs`; an invalid stored value silently falls back to the default) selects the
provider when the call carries no override — selection order: per-call `provider` →
`voice.provider` setting → `elevenlabs`. `voice.language` supplies the default
transcription language hint (see "Language resolution" above). `voice.openai.model`
selects the OpenAI
transcription model (see "Providers" above). `voice.workspaceVocabulary.maxTerms`
caps the auto-derived workspace vocabulary (v5.1; see "Workspace vocabulary" above).
The API keys are the **sensitive** catalog
entries `voice.elevenlabs.apiKey` / `voice.openai.apiKey`, persisted to the daemon's
file-backed secret store (`~/intent/.secrets.json`, `0600`) and settable via
`settings.update` — the FE "connect" flow, exactly like `linear.token`. Key resolution
is **secret store first, then env fallback** (`ELEVENLABS_API_KEY` / `OPENAI_API_KEY`);
empty/whitespace-only values are treated as absent at both levels.

**Errors** (§9):

- Caller-input problems — missing/blank/invalid-base64/zero-byte `audio`, an unknown
  `provider` value, a malformed `context.keyterms`, a non-string `workspaceId`
  *(v5.1)* — → `-32602` with the generic `error.data.code: "invalid-params"`
  discriminator (no voice-specific `-32602` data codes). A **stale or unknown**
  `workspaceId` is deliberately NOT among these — it is tolerated (see "Workspace
  vocabulary" above); only the wrong type errors.
- **Audio too large** (over the 25 MB cap, either enforcement point) → `-32602`
  (`"audio exceeds the 25 MB limit"`) — rejected before any provider call.
- **No API key configured** for the selected provider → `-32603` with the generic
  `"Internal error"` message and **structured** `error.data` *(v4.4;
  monorepo#1448)*: `{ "code": "voice-no-api-key", "detail": "<descriptive message>" }`.
  Clients match `data.code` to surface an actionable "configure in Settings" hint
  (the `detail` names the provider and both key sources), keeping a message sniff on
  the detail text only as a fallback for pre-4.4 daemons — whose `error.data` was the
  same descriptive text as a plain string, byte-identical to today's `data.detail`:

  ```json
  { "code": -32603, "message": "Internal error",
    "data": { "code": "voice-no-api-key",
      "detail": "voice not configured: voice: no API key found for elevenlabs (set voice.elevenlabs.apiKey or ELEVENLABS_API_KEY)" } }
  ```

  This is the **only** voice-specific data code; no other `voice.transcribe` failure
  carries one.
- **Provider HTTP failure** (auth rejection, rate limit, 5xx, decode errors) →
  `-32603` with the provider's error detail in `error.data` (a plain string,
  unchanged in 4.4 — e.g.
  `"voice auth error: elevenlabs returned 401 Unauthorized: …"`); the API key
  never appears in the error.

```json
// → request
{ "jsonrpc":"2.0","id":97,"method":"voice.transcribe","params":{
  "audio":"GkXfo59ChoEBQveBAULygQRC…","mimeType":"audio/webm","language":"en",
  "workspaceId":"ws-abc",
  "context":{ "keyterms":["cloudlands-fe","submodule","clippy"] } } }
// ← response
{ "jsonrpc":"2.0","id":97,"result":{
  "text":"Bump the cloudlands-fe submodule and rerun clippy.",
  "provider":"elevenlabs","durationMs":3200 } }
```

**`voice.getWorkspaceVocabulary` *(v5.1)*.** The read RPC serving a workspace's
auto-derived vocabulary — the **derived terms only** (the user's `voice.vocabulary`
is a separate §5.12 setting and is not merged in) — for clients that transcribe
**outside** the daemon (e.g. the desktop OS-engine dictation path) and for Settings
previews, so both engines bias with the same terms. The response is served from the
same content-hash cache the `voice.transcribe` injection uses (unchanged sources ⇒
no re-extraction), already capped by `voice.workspaceVocabulary.maxTerms`
(`{ "terms": [] }` when the setting is `0` or nothing derives). Unlike the tolerant
`workspaceId?` on `voice.transcribe`, the param here is **required** and validated:
an unknown `workspaceId` is the standard not-found error (`-32602` with
`error.data.code: "not-found"`, §9).

```json
// → request
{ "jsonrpc":"2.0","id":98,"method":"voice.getWorkspaceVocabulary","params":{
  "workspaceId":"ws-abc" } }
// ← response
{ "jsonrpc":"2.0","id":98,"result":{
  "terms":["intentd","clippy","cloudlands-fe","TOON"] } }
```

