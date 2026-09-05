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

Use this block once per finding. Replace every placeholder. It must stand alone as a
workspace `initialPrompt`, without relying on the retrospective transcript.

```markdown
# Finding: <short outcome-oriented title>

## Finding
<Observed repository friction and the desired outcome.>

## Evidence (file/PR/commit)
<Exact paths, PRs, commits, failures, or corrections that demonstrate the incident.>

## Cost (time or bug)
<Measured or bounded time, repeated work, escaped bug, flake, or release risk.>

## Proposed rung + concrete change
<Rung 1-4 and the exact repository change. Explain why every stronger rung is infeasible.>

## Verification steps
- <Command or scenario and its expected result.>

## Dedup check performed
<Sibling workspaces and open issues searched, including queries and any related results.>
```

## Where it goes

Before accepting a finding, deduplicate it against sibling workspaces with
`ws.crossWorkspace.listSiblings` and open `intent-hq/intent` issues. Record both checks
in the template, including related work that narrows or supersedes the proposal.

For each accepted, non-duplicate finding, a foreground top-level agent proposes one
follow-up workspace with `ws.workspace.proposeSibling({ title, initialPrompt })`. Use a
short outcome-oriented `title` and the completed template verbatim as the self-contained
`initialPrompt`. The user must approve the proposal; do not claim the workspace exists.

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