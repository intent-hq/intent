> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.59 Composer autocomplete — `input.autocomplete`.

### 5.59 Composer autocomplete — `input.autocomplete` *(v18.1)*

Suggests a short continuation of the user's composer draft ("ghost text"). The daemon
asks an OpenAI-compatible gateway — **Kilo Gateway** or **OpenRouter**, chosen by the
`autocomplete.*` settings (§5.12) — so the service API keys stay in the daemon's
file-backed secret store and **never reach clients** (the same 🔒 secret guardrail as
`voice.*`, §5.41). **Daemon-global**: no `workspaceId`. Owner and host members only,
like `voice.*`; guests are refused with `-32003`.

| Method | Params | Result |
| --- | --- | --- |
| input.autocomplete | text (req), context (req) | `{ completion: string }` |

**Params:**

- `text` (req) — the draft typed so far, **1 to 2,000 characters** (Unicode code points;
  a client that caps at 2,000 UTF-16 units always fits).
- `context` (req) — recent conversation text, including the latest suggested prompts,
  **0 to 4,000 characters**. An empty string is allowed.
- A missing param, a non-string value, or a length outside these bounds → `-32602`.
  Params are validated even when autocomplete is off.

**Result:** `{ completion }` — the text to append after `text`, or `""`. The daemon
answers `""` on **every soft failure** and never a JSON-RPC error for them:
autocomplete is off (`autocomplete.enabled` false), the service is OpenRouter with no
key, the model is gone (HTTP 404), the service is rate limited (HTTP 429), any other
non-2xx status, the 4-second timeout, a network error, or a reply the daemon cannot
parse. These are logged at debug level only; the draft, the context and the keys are
never logged.

**Model id sent upstream** (`<model>` is the `autocomplete.model` base id):

| Service setting | Key saved for that service | Model id |
| --- | --- | --- |
| `kilo` | no | `<model>:free` |
| `kilo` | yes | `<model>` (paid, no hourly limit) |
| `openrouter` | yes | `<model>` |
| `openrouter` | no | no request; `""` |

The key is `autocomplete.kilo.apiKey` or `autocomplete.openrouter.apiKey`; a key saved
for the other service is ignored.

**Upstream request** (OpenAI-compatible chat completions, non-streaming, 4 s timeout):

- Kilo: `POST https://api.kilo.ai/api/gateway/chat/completions`.
- OpenRouter: `POST https://openrouter.ai/api/v1/chat/completions` with
  `HTTP-Referer: https://intentapp.dev` and `X-Title: Intent`.
- `Authorization: Bearer <key>` only when a key is saved.
- Body: `model`, `max_tokens: 40`, `temperature: 0.2`, `stop: ["\n"]`,
  `reasoning: { enabled: false }`, and two messages — a fixed system prompt (continue
  the user's message without repeating it, at most the current sentence, nothing when
  unsure) and the user message `<conversation>\n{context}\n</conversation>\n<typed>{text}</typed>`.

**Reply clean-up** (applied to `choices[0].message.content`):

1. Keep the first line.
2. Strip wrapping quotes or backticks, and drop a repeated copy of `text` at the start
   (case-insensitive; a copy of `text` without its trailing spaces counts too).
3. Cut after the first sentence end: `.`, `?` or `!` followed by whitespace or the end
   (so `file.rs` does not end a sentence).
4. Cap at 200 characters and drop trailing whitespace.

Leading whitespace is kept as the model sent it: the model decides whether the
continuation starts a new word. A reply that is empty after clean-up yields `""`.

**Client behaviour (informative).** The desktop asks only when autocomplete is on, the
trimmed draft has at least 5 characters, the caret is at the end, no IME composition is
active and no slash or mention menu is open; it debounces 250 ms, drops stale replies,
and shows nothing on `""`. Clients detect support by the presence of
`autocomplete.enabled` in `settings.list`; older daemons return `-32601` for the method.
