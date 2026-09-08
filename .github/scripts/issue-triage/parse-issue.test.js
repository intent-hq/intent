// Fixture-driven tests for the pass-1 triage parser.
// Run locally with:  node --test .github/scripts/issue-triage/parse-issue.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  ISSUE_TYPE_BY_LABEL,
  LEGACY_TYPE_LABELS,
  labelsForIssueBody,
  planLegacyTypeLabels,
  priorityForIssueBody,
} = require('./parse-issue.js');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('template bug: components and agent-filed map to labels; severity does not', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('bug-full.md')), [
    'component:intentd',
    'docs',
    'agent-filed',
  ]);
});

test('template bug: single component, agent-filed unchecked', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('bug-single-component.md')), [
    'component:fe',
  ]);
});

test('feature request: component only, no severity section', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('feature-request.md')), [
    'component:ios',
  ]);
});

test('blank free-form issue yields no labels', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('blank-issue.md')), []);
});

test('template issue with nothing checked and _No response_ severity yields no labels', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('no-selections.md')), []);
});

test('empty and non-string bodies yield no labels', () => {
  assert.deepStrictEqual(labelsForIssueBody(''), []);
  assert.deepStrictEqual(labelsForIssueBody(null), []);
  assert.deepStrictEqual(labelsForIssueBody(undefined), []);
});

test('uppercase [X] checkboxes and CRLF line endings are accepted', () => {
  const body =
    '### Component\r\n\r\n- [X] intentd (Rust backend daemon)\r\n\r\n' +
    '### Severity\r\n\r\nLow — papercut; annoying but does not block workflows\r\n';
  assert.deepStrictEqual(labelsForIssueBody(body), ['component:intentd']);
  assert.strictEqual(priorityForIssueBody(body), 'Low');
});

test('severity dropdown never produces a priority label', () => {
  const body = '### Severity\n\nUrgent — crash, data loss, or corruption\n';
  assert.deepStrictEqual(labelsForIssueBody(body), []);
});

test('unknown checkbox text in Component section is ignored', () => {
  const body = '### Component\n\n- [x] some other thing entirely\n';
  assert.deepStrictEqual(labelsForIssueBody(body), []);
});

test('duplicate sections do not produce duplicate labels', () => {
  const body =
    '### Component\n\n- [x] intentd (Rust backend daemon)\n\n' +
    '### Component\n\n- [x] intentd (Rust backend daemon)\n';
  assert.deepStrictEqual(labelsForIssueBody(body), ['component:intentd']);
});

test('template markdown pasted inside a code fence is ignored', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('fenced-template.md')), [
    'component:fe',
  ]);
  assert.strictEqual(priorityForIssueBody(fixture('fenced-template.md')), 'Medium');
});

test('body that is only a fenced template copy yields no labels and no priority', () => {
  const body =
    'log dump:\n\n```\n### Component\n\n- [x] intentd (Rust backend daemon)\n\n' +
    '### Severity\n\nUrgent — crash\n```\n';
  assert.deepStrictEqual(labelsForIssueBody(body), []);
  assert.strictEqual(priorityForIssueBody(body), null);
});

test('priorityForIssueBody maps each current Severity option to the Priority field value', () => {
  const severity = (line) => `### Description\n\nx\n\n### Severity\n\n${line}\n`;
  assert.strictEqual(
    priorityForIssueBody(severity('Urgent — crash, data loss, or corruption; blocks shipping to external users')),
    'Urgent',
  );
  assert.strictEqual(
    priorityForIssueBody(severity('High — broken feature; app still usable but with significant workaround required')),
    'High',
  );
  assert.strictEqual(
    priorityForIssueBody(severity('Medium — degraded behavior; should be fixed, but impact is limited')),
    'Medium',
  );
  assert.strictEqual(
    priorityForIssueBody(severity('Low — papercut; annoying but does not block workflows')),
    'Low',
  );
});

test('priorityForIssueBody accepts the legacy P0–P3 tokens from the old template', () => {
  const severity = (line) => `### Severity\n\n${line}\n`;
  assert.strictEqual(priorityForIssueBody(severity('P0 — crash, data loss, or corruption')), 'Urgent');
  assert.strictEqual(priorityForIssueBody(severity('P1 — broken feature')), 'High');
  assert.strictEqual(priorityForIssueBody(severity('P2 — degraded behavior')), 'Medium');
  assert.strictEqual(priorityForIssueBody(severity('P3 — papercut')), 'Low');
});

test('priorityForIssueBody matches the severity token case-insensitively', () => {
  const severity = (line) => `### Severity\n\n${line}\n`;
  assert.strictEqual(priorityForIssueBody(severity('urgent — crash, data loss, or corruption')), 'Urgent');
  assert.strictEqual(priorityForIssueBody(severity('URGENT')), 'Urgent');
  assert.strictEqual(priorityForIssueBody(severity('p0 — crash, data loss, or corruption')), 'Urgent');
  assert.strictEqual(priorityForIssueBody(severity('LOW — papercut')), 'Low');
});

test('priorityForIssueBody reads fixtures on both vocabularies', () => {
  assert.strictEqual(priorityForIssueBody(fixture('bug-full.md')), 'Urgent');
  assert.strictEqual(priorityForIssueBody(fixture('bug-single-component.md')), 'Medium');
});

test('priorityForIssueBody is null without a Severity section', () => {
  assert.strictEqual(priorityForIssueBody(fixture('feature-request.md')), null);
  assert.strictEqual(priorityForIssueBody(fixture('blank-issue.md')), null);
  assert.strictEqual(priorityForIssueBody(''), null);
  assert.strictEqual(priorityForIssueBody(null), null);
  assert.strictEqual(priorityForIssueBody(undefined), null);
});

test('priorityForIssueBody is null for _No response_ and free-form text', () => {
  assert.strictEqual(priorityForIssueBody(fixture('no-selections.md')), null);
  assert.strictEqual(priorityForIssueBody('### Severity\n\n_No response_\n'), null);
  assert.strictEqual(priorityForIssueBody('### Severity\n\nsomething custom the user typed\n'), null);
  assert.strictEqual(priorityForIssueBody('### Severity\n\nHighly unusual\n'), null);
  assert.strictEqual(priorityForIssueBody('### Severity\n\nP4 — not a real level\n'), null);
});

test('tilde fences are skipped and sections after a fence still parse', () => {
  const body =
    '### Description\n\n~~~\n- [x] intentd (Rust backend daemon)\n~~~\n\n' +
    '### Component\n\n- [x] docs / tooling\n';
  assert.deepStrictEqual(labelsForIssueBody(body), ['docs']);
});

// --- legacy type-label retirement -----------------------------------------

const ISSUE_TYPES = [
  { id: 'IT_bug', name: 'Bug', isEnabled: true },
  { id: 'IT_feature', name: 'Feature', isEnabled: true },
  { id: 'IT_task', name: 'Task', isEnabled: true },
];

test('legacy type labels are bug and enhancement only; question stays a regular label', () => {
  assert.deepStrictEqual(LEGACY_TYPE_LABELS, ['bug', 'enhancement']);
  assert.deepStrictEqual(ISSUE_TYPE_BY_LABEL, { bug: 'Bug', enhancement: 'Feature', question: 'Task' });
  for (const label of LEGACY_TYPE_LABELS) assert.ok(ISSUE_TYPE_BY_LABEL[label]);
});

test('planLegacyTypeLabels: no legacy label is a no-op', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({
      labels: ['component:intentd', 'needs-triage', 'question'],
      currentIssueType: null,
      issueTypes: ISSUE_TYPES,
    }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: [], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: undefined, currentIssueType: null, issueTypes: [] }),
    { setType: null, removeLabels: [] },
  );
});

test('planLegacyTypeLabels: legacy label + no Type + enabled Type -> set and remove', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['bug', 'component:fe'], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    { setType: { id: 'IT_bug', name: 'Bug' }, removeLabels: ['bug'] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['enhancement'], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    { setType: { id: 'IT_feature', name: 'Feature' }, removeLabels: ['enhancement'] },
  );
});

test('planLegacyTypeLabels: existing Type is never overwritten; label is still removed', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['bug'], currentIssueType: 'Feature', issueTypes: ISSUE_TYPES }),
    { setType: null, removeLabels: ['bug'] },
  );
  // Even when the Type list is unavailable the existing Type suffices.
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['enhancement'], currentIssueType: 'Bug', issueTypes: [] }),
    { setType: null, removeLabels: ['enhancement'] },
  );
});

test('planLegacyTypeLabels: Type unavailable -> nothing set, nothing removed', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['bug'], currentIssueType: null, issueTypes: [] }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['bug'], currentIssueType: null, issueTypes: undefined }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({
      labels: ['bug'],
      currentIssueType: null,
      issueTypes: [{ id: 'IT_bug', name: 'Bug', isEnabled: false }, { id: 'IT_task', name: 'Task', isEnabled: true }],
    }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({
      labels: ['enhancement'],
      currentIssueType: null,
      issueTypes: [{ id: 'IT_bug', name: 'Bug', isEnabled: true }],
    }),
    { setType: null, removeLabels: [] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({
      labels: ['bug'],
      currentIssueType: null,
      issueTypes: [{ id: '', name: 'Bug', isEnabled: true }],
    }),
    { setType: null, removeLabels: [] },
  );
});

test('planLegacyTypeLabels: several legacy labels -> first in LEGACY_TYPE_LABELS order decides, all removed', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['enhancement', 'bug'], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    { setType: { id: 'IT_bug', name: 'Bug' }, removeLabels: ['bug', 'enhancement'] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['enhancement', 'bug'], currentIssueType: 'Task', issueTypes: ISSUE_TYPES }),
    { setType: null, removeLabels: ['bug', 'enhancement'] },
  );
  // Only the deciding label needs an enabled Type; without one nothing moves.
  assert.deepStrictEqual(
    planLegacyTypeLabels({
      labels: ['enhancement', 'bug'],
      currentIssueType: null,
      issueTypes: [{ id: 'IT_feature', name: 'Feature', isEnabled: true }],
    }),
    { setType: null, removeLabels: [] },
  );
});

test('planLegacyTypeLabels never removes question', () => {
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['question', 'bug'], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    { setType: { id: 'IT_bug', name: 'Bug' }, removeLabels: ['bug'] },
  );
  assert.deepStrictEqual(
    planLegacyTypeLabels({ labels: ['question'], currentIssueType: 'Task', issueTypes: ISSUE_TYPES }),
    { setType: null, removeLabels: [] },
  );
});
