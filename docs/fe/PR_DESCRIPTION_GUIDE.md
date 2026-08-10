# PR Description Guide

## 1. Purpose

PR descriptions are the primary artifact for reviewers to understand scope, risk, and verification.

## 2. Required Sections

All sections below are required unless noted as optional.

### Summary

Write one paragraph explaining what the PR does and why it exists. Include the diff stats line in this section: `**N files changed, +X / −Y**`.

### Results (optional)

Use a before/after metrics table when the PR has measurable impact, such as line counts, IPC call counts, render counts, or bundle size changes. Omit this section when there is no meaningful metric to report.

### What Changed

List all changes grouped by category: new files, modified files, deleted files, renamed files, new slices, new modules, new components, migrations, and docs updates. Be specific: name every new module, slice, component, utility, or handler and give each a one-line description.

### Architecture

Explain how the changes fit into the existing architecture, ownership boundaries, and data flow. Link to relevant docs in `docs/` when they help reviewers understand the design.

### Testing

List exactly what you verified and how: typechecks, unit tests, builds, manual scenarios, and any targeted commands. Use exact command names and note manual validation steps when applicable.

### What's NOT Changed

Call out what is intentionally out of scope. This sets reviewer expectations and prevents assumptions about adjacent systems.

## 3. Risk Analysis Rule

**Every PR description MUST include a risk analysis section.** This section identifies features and code paths that could break due to the changes, organized by risk level.

```markdown
## Risk Analysis

### 🔴 P0 — Critical (core user flows affected)
- **Feature name** — what changed and why it's risky
  - [ ] Test: specific manual test step

### 🟠 P1 — High (important flows affected)
- ...

### 🟡 P2 — Medium (secondary flows affected)
- ...

### 🟢 P3 — Low (minor/cosmetic changes)
- ...
```

End each risk analysis with a summary table:

| Risk Level | Areas | Items |
| --- | --- | --- |
| P0 | Core flows | N |
| ... | ... | ... |

Rules for risk analysis:

- Every modified component, IPC handler, or state migration must be mapped to a user-facing feature.
- Each risk item must have at least one concrete test step, manual or automated.
- P0 items must be tested before the PR is marked ready for review.
- Include a summary table at the bottom: `| Risk Level | Areas | Items |`.
- If a PR touches more than 20 files, full risk analysis is mandatory.
- If a PR touches fewer than 20 files, a simplified version that lists affected features is acceptable.

Place the risk analysis in the PR description body. For very large PRs (50+ files) where the risk analysis exceeds ~100 lines, post it as a separate pinned PR comment instead and add a link from the description: `See [Risk Analysis](#issuecomment-XXXX)`.

## 4. Style Rules

- Use exact numbers, not approximations; run `git diff --stat` to get real counts.
- List every new file, module, slice, component, and utility by name.
- Use tables for before/after comparisons.
- Keep bullet points to one line each.
- Use code formatting for file paths, function names, and commands.

## 5. Anti-patterns

- ❌ `Various improvements and fixes` — be specific.
- ❌ Approximate numbers like `~200 files` — use exact counts.
- ❌ Missing `What's NOT Changed` — reviewers need scope boundaries.
- ❌ No risk analysis on large PRs — always assess what could break.
- ❌ `All tests pass` without listing commands — specify the exact verification steps.