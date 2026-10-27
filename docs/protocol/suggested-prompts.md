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

The comparison form turns CRLF into LF, trims the text and collapses runs of three or more line
feeds to two. Parsers differ only in line endings and in how many blank lines a removed block
leaves, which render the same.
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

The copies use the shared fixture-copy tool with `commit` provenance (see
[Copied fixtures](./README.md#copied-fixtures)).
`scripts/suggested-prompts-contract.mjs` validates the canonical file and distributes copies:

- `validate`: checks the canonical cases.
- `check`: also checks every adopted component copy against its lock; `make
  check-suggested-prompts-contract` runs this inside `make consumer-checks`.
- `export`: writes a component copy plus a lock naming the monorepo commit. The source checkout's
  HEAD must be that commit, with the case file committed.
- `verify`: component CI checks the copy byte-for-byte against the monorepo at the locked commit.
  Its sparse checkout needs `scripts/suggested-prompts-contract.mjs`,
  `scripts/lib/fixture-copy.mjs` and `docs/protocol/fixtures/suggested-prompts/v1/`.

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
Today's schema and required-case rules apply only to the canonical file, so tightening them
never fails an older copy. A copy locked to a commit off the checkout's history (an unmerged
branch) fails when that commit is present; a shallow checkout reports it as unverified. A copy
whose bytes differ from the commit its lock names fails, even if its lock was rehashed.
