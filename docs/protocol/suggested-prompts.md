# Suggested-prompts block cases

Agent replies can end with a suggested-prompts block. Three parsers read it: the desktop app
(cloudlands-fe `scanSuggestedPrompts` in `src/lib/utils/messageParser.ts`), the daemon's
agent-card preview (intentd `clean_response_text` in `crates/intent-services/src/agent_ops.rs`)
and the iOS app (`Intent/Presentation/SuggestedPrompts.swift`). They are written separately,
so [`fixtures/suggested-prompts/v1/cases.json`](./fixtures/suggested-prompts/v1/cases.json)
pins their shared behavior. This is a test contract, not a wire format.

## Block syntax

```text
Reply text.

<!-- suggested-prompts
First prompt
Label|delay:30|Second prompt
-->
```

A model that copied an XML-escaped history replay can write the opener as
`&lt;!-- suggested-prompts` and the closer as `--&gt;`. An escaped opener closes only on an
escaped closer, and entities in its prompt lines are decoded once. The cases cover both
spellings, the closer fused with the final prompt, fenced and inline openers that must stay
visible, body-text-shaped lines that yield no prompts, and the four-prompt cap.

## Case format

Each case has a kebab-case `id`, the `origin` test it was taken from, the reply `input`, and
`expect`:

| Field | Meaning |
|-------|---------|
| `blockStripped` | The input contains at least one well-formed block. |
| `prompts` | Prompts from the last well-formed block, after `Label\|` and `delay:N\|` stripping (at most four). |
| `cleaned` | Reply text with every well-formed block removed, in comparison form. |

The comparison form trims the text and collapses runs of three or more line feeds to two.
Parsers differ only in how many blank lines a removed block leaves, which renders the same.
Without a well-formed block the prompts are empty and `cleaned` is the input in comparison form.

Consumers:

- cloudlands-fe checks `prompts` and `cleaned` with `parseSuggestedPrompts`.
- iOS checks `prompts` with `SuggestedPrompts.parse` and `cleaned` with `stripBlocks`.
- intentd checks only `cleaned` for `blockStripped: true` cases. The daemon preview is lossy
  and also strips malformed spans, so cases without a well-formed block are out of its scope.

An optional `divergences` object maps a consumer to the reason it intentionally differs on
that case. The consumer's test asserts that it still differs, so a stale entry fails and must
be removed.

## Distribution

The model matches [backend-keychain.md](./backend-keychain.md#distribution-and-verification).
`scripts/suggested-prompts-contract.mjs` validates the canonical file and distributes copies:

- `validate`: checks the canonical cases.
- `check`: also checks every adopted component copy; `make check-suggested-prompts-contract`
  runs this inside `make consumer-checks`.
- `export`: writes a component copy plus a lock naming the monorepo commit.
- `verify`: component CI checks the copy byte-for-byte against the monorepo at the locked commit.

| Component | Copy | Lock |
|-----------|------|------|
| cloudlands-fe | `tests/fixtures/suggested-prompts/v1/cases.json` | `tests/fixtures/suggested-prompts.lock.json` |
| intentd | `crates/intent-services/tests/fixtures/suggested-prompts/v1/cases.json` | `crates/intent-services/tests/fixtures/suggested-prompts.lock.json` |
| ios | `IntentTests/Fixtures/suggested-prompts/v1/cases.json` | `IntentTests/Fixtures/suggested-prompts.lock.json` |

To change an expected value or add a case, land it here first. Then re-export each copy at the
merged commit:

```bash
node scripts/suggested-prompts-contract.mjs export --source-root . \
  --source-commit "$(git rev-parse HEAD)" --component cloudlands-fe \
  --component-root packages/cloudlands-fe
```

A component cannot edit its copy on its own: its CI verify step fails. `check` reports a copy
locked to an older commit as behind canonical rather than failing, so docs can lead the pin.
