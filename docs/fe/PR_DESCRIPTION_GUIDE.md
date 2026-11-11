# PR Description Guide

The reviewer reads the diff. The body gives only what the diff cannot show: the
change in behavior and the reason for it. Text that repeats git or CI hides
those two facts. Do not write it.

The cloudlands-fe
[`pr-description` skill](../../packages/cloudlands-fe/.agents/skills/pr-description/SKILL.md)
gives agents the same rules. Change the two files together.

## Title

`type(scope): imperative subject`

- CI accepts only these types: `feat`, `fix`, `chore`, `docs`, `refactor`,
  `test`, `ci`, `perf`. The scope is optional.
- Name the result in 5 to 10 words. Do not end with a period.
- Use `docs` only when the diff changes documentation and nothing else.

Example: `fix(agent): keep deleted agents out of the sidebar`

## Body

Write two parts. No other part is mandatory.

1. **What changed.** State the new behavior that a user or a developer sees.
2. **Why.** State the problem and its cause. If a reviewer can expect a
   different solution, state why you did not use it.

- A small change needs one to three sentences and no headings.
- A large change gets one bullet for each change in behavior.

## Add only when it applies

| Condition                                 | Add                                                   |
| ----------------------------------------- | ----------------------------------------------------- |
| The PR fixes a filed issue                | `Fixes intent-hq/intent#N`                            |
| The PR changes UI                         | Before and after screenshots, in a table              |
| The PR changes what a user sees or does   | The assistant app guide section, or why none applies  |
| The PR claims a performance result        | The measured before and after table, and its command  |
| The PR depends on another PR              | The link and the merge order                          |
| You ran a check that CI does not run      | One line: the check and its result                    |
| You did not run a check that is necessary | One line: the check and the reason                    |
| The reviewer must make a decision         | One line: the question and the option that you prefer |

Omit a row that does not apply. Do not write "None" or "N/A".

Put the screenshots in a table with a `Before` column and an `After` column.

## Do not write

- Diff statistics, file counts, or lists of changed, new, or deleted files.
- Lists of commits, symbols, modules, or components.
- Results of checks that CI runs: lint, type checks, unit tests, builds.
- An explanation of how the code works. Put that in the code or in the docs.
- A list of things that the PR does not change.
- Risk levels, risk tables, or checklists.
- Empty sections, placeholders, or a summary of the body.
- The steps that you took, or the solutions that you tried and removed.
- Claims that you did not verify.
- The literal breaking-change footer token, unless the change is a breaking
  change (see [Conventions](../../AGENTS.md#conventions)).

## Language: Simplified Technical English

Write the title and the body in Simplified Technical English (ASD-STE100).
These rules are mandatory:

- Write one idea in each sentence. Use a maximum of 20 words.
- Use the active voice. Name the thing that does the action.
- Use the present tense for the new behavior and the past tense for the old.
- Use one word for one thing. Do not change the word to prevent repetition.
- Use the specific name: the control, the setting, the method, the error.
- Use a verb for an action: "the saga retries the call", not "retry logic was
  implemented".
- Remove each word that gives no fact: "comprehensive", "robust", "seamless",
  "leverage", "This PR", "in order to".
- Do not use idioms or metaphors.

Identifiers, commands, and names from the app stay as they are, in code format.

| Do not write                                                                                     | Write                                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| This PR introduces comprehensive improvements to the robustness of the session handling layer.   | The agent list drops rows that carry `pendingDeleteAt`.  |
| Retry logic with exponential backoff has been implemented in order to handle transient failures. | The saga retries a failed `agent.list` call three times. |
| All tests pass.                                                                                  | (nothing: CI shows this)                                 |

## Example

```markdown
A deleted agent came back in the sidebar after the workspace list refreshed.

The refresh read rows that the daemon had not removed yet. The agent list now
drops rows that carry `pendingDeleteAt`.

Fixes intent-hq/intent#N
```
