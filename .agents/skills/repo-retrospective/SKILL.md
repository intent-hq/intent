---
name: repo-retrospective
description: >-
  Reflect on a completed workspace, identify evidence-backed repository friction,
  and turn accepted findings into deduplicated, enforceable follow-up work.
triggers:
  - close workspace
  - run repository retrospective
  - reflect on agent workflow
  - propose repository improvements
---

# Repository Retrospective

## When to run

Run this retrospective after the work has merged or shipped and before writing the
final workspace status message. Also run it whenever a user explicitly requests a
repository or workspace retrospective.

## The reflection prompt

Think hard about what would have made this workspace easier to research, implement,
and test. Treat the repository as one coherent system: a tower of linked abstractions
(protocol docs → goldens → services → transport → FE). Ask what would have let you
understand the situation accurately and control it with the least resource expenditure.

Use actual workspace evidence. Review each phase separately:

- **Research:** What did you have to discover that a routing table, focused document,
  or invariant ledger should have told you? Where did linked abstractions disagree?
- **Implement:** What convention did you learn only after correction, review feedback,
  or a failed attempt? What safer path should have been the obvious path?
- **Verify:** What broke that an automated check should have caught? Which gate was
  slow, flaky, overly broad, or missing, and what evidence demonstrates that cost?
- **Ship:** Which release, merge, queue, pin, or status step was ambiguous? What would
  have made the handoff and shipped-version check deterministic?

Discard observations without a concrete incident, cost, and actionable repository
change. Combine observations that share one root cause into one finding.

## Enforcement ladder

Each finding must target the strongest feasible rung:

1. **Make the mistake impossible:** encode it in types, goldens, or a protocol contract.
2. **Catch it mechanically before merge:** add a focused lint, CI check, or test.
3. **Make the right path discoverable:** improve a routing table, Makefile target, or
   script that guides agents to the supported path.
4. **Add a prose rule:** use `AGENTS.md` only as a last resort and cite the incident.

Name the proposed rung for every finding. Explain why each stronger rung is infeasible;
for rung 1, state that it is already the strongest rung. Prefer upgrading or replacing
an existing weaker rule over adding another instruction agents must remember.

## Output template

Write for the person deciding whether to approve the work. Assume they have not read
the conversation and do not know the implementation. Use a short title that describes
the improvement, such as "Keep database upgrade tests reliable" instead of "Stabilize
historical migration fixtures".

Start the task with two short paragraphs: the observed problem and why it matters,
then the proposed change and what it will improve. Use everyday words before technical
terms. For example, say "tests for upgrades from older databases" before "migration
fixtures". The first few sentences must explain the value without paths, hashes,
commands, or internal labels such as "Finding" and "Proposed rung".

The task appears in a plain text box. Use short paragraphs, simple labels, and a few
bullets. Avoid Markdown heading markers and code fences. Aim for about 150 words;
add only the detail needed for the new agent to work without the original transcript.
Put essential technical facts at the end, one fact per bullet. Link to longer evidence
instead of copying an investigation into the card.

Use this shape once per finding. Replace every placeholder:

```text
<What is going wrong and its practical cost, in plain English.>

<What to improve, why it helps, and why it belongs in a separate workspace.>

What to do:
- <Concrete step in plain English.>
- <Concrete step in plain English.>

Implementation notes:
- <Essential code locations and linked evidence for the observed problem.>
- <Chosen enforcement rung and why stronger rungs are infeasible.>
- <Check to run and the expected result.>
- <Sibling workspaces and issue searches checked, with any related results.>
```

For example, the opening for the database finding can be:

```text
Tests for upgrades from older databases currently break when unrelated features add
new fields. This creates extra repair work before we can check whether upgrades work.

Give these tests a way to create an old database directly. They can then check the
upgrade itself and keep working as the app changes. This is separate test cleanup
that will make future database changes easier to check.
```

## Where it goes

Before accepting a finding, deduplicate it against sibling workspaces with
`ws.crossWorkspace.listSiblings` and open `intent-hq/intent` issues. Record both checks
in the template, including related work that narrows or supersedes the proposal.

For each accepted, non-duplicate finding, a foreground top-level agent proposes one
follow-up workspace with `ws.workspace.proposeSibling({ title, initialPrompt })`. Use a
short outcome-oriented `title` and the readable task above as the self-contained
`initialPrompt`. Keep the plain English reason in the opening of that task. The user
must approve the proposal; do not claim the workspace exists.

Delegated or background agents must instead send the completed finding to their parent
with `ws.agent.reportToParent`; the parent decides whether to propose it. Outside
Intent, file an issue labeled `agent-workflow` and `agent-filed` instead. Never edit
`AGENTS.md` inside the feature PR to land a retrospective finding.

## Anti-patterns

- Adding prose without a cited incident or without evaluating stronger rungs.
- Adding a rule that duplicates an existing lint, CI check, test, or type constraint.
- Putting coordinator-internal sequencing terminology into committed documentation.
- Quoting the literal breaking-change footer token while merely discussing its hazard.
- Bundling retrospective cleanup into the feature PR instead of proposing follow-up work.
