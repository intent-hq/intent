// Fixture-driven tests for the pass-2 agentic triage logic: model-output
// parsing, the label allowlist, action gating, issue Type gating, issue
// field (Priority / Effort) gating, and comment building.
// Run locally with:  node --test .github/scripts/issue-triage/agentic-triage.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  AGENTIC_MARKER,
  ISSUE_TYPE_BY_LABEL,
  POSSIBLE_DUPLICATE_LABEL,
  buildPrompt,
  buildSummaryComment,
  extractSearchQueries,
  parseTriageResponse,
  planActions,
  planIssueFields,
  planIssueType,
  sanitizeText,
} = require('./agentic-triage.js');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// Shape of `repository.issueTypes.nodes` as resolved at runtime.
const ISSUE_TYPES = [
  { id: 'IT_task', name: 'Task', isEnabled: true },
  { id: 'IT_bug', name: 'Bug', isEnabled: true },
  { id: 'IT_feature', name: 'Feature', isEnabled: true },
];

// Shape of the single-select `repository.issueFields.nodes` as resolved at
// runtime (non-single-select nodes are filtered out before planning).
const ISSUE_FIELDS = [
  {
    id: 'IFSS_priority',
    name: 'Priority',
    options: [
      { id: 'IFSSO_urgent', name: 'Urgent' },
      { id: 'IFSSO_high', name: 'High' },
      { id: 'IFSSO_medium', name: 'Medium' },
      { id: 'IFSSO_low', name: 'Low' },
    ],
  },
  {
    id: 'IFSS_effort',
    name: 'Effort',
    options: [
      { id: 'IFSSO_e_high', name: 'High' },
      { id: 'IFSSO_e_medium', name: 'Medium' },
      { id: 'IFSSO_e_low', name: 'Low' },
    ],
  },
];

test('parse: fenced JSON with surrounding prose parses fully', () => {
  const r = parseTriageResponse(fixture('agentic-response-clean.txt'));
  assert.deepStrictEqual(r, {
    duplicates: [
      { number: 101, confidence: 'high', reason: 'Same panic in the workspace store on startup' },
      { number: 102, confidence: 'low', reason: 'Related subsystem but a different error' },
    ],
    component: 'intentd',
    type: 'bug',
    priority: 'P1',
    security: false,
    reasons: {
      component: 'The stack trace is in intentd Rust code',
      type: 'Reports a panic, clearly a defect',
      priority: 'Daemon crash on startup but a restart recovers',
    },
  });
});

test('parse: invented labels and malformed fields are dropped, never passed through', () => {
  const r = parseTriageResponse(fixture('agentic-response-invented.txt'));
  assert.deepStrictEqual(r.duplicates, []);
  assert.strictEqual(r.component, null);
  assert.strictEqual(r.type, null);
  assert.strictEqual(r.priority, null);
  assert.strictEqual(r.security, false);
});

test('parse: bare JSON without a fence still parses', () => {
  const r = parseTriageResponse('{"component":"fe","type":null,"priority":null,"security":false}');
  assert.strictEqual(r.component, 'fe');
  assert.deepStrictEqual(r.duplicates, []);
});

test('parse: garbage output yields null', () => {
  assert.strictEqual(parseTriageResponse('no json here'), null);
  assert.strictEqual(parseTriageResponse('{broken'), null);
  assert.strictEqual(parseTriageResponse('[1,2,3]'), null);
});

test('sanitize: strips HTML-comment marker forgery and neutralizes mentions', () => {
  const s = sanitizeText(`dup of <!-- issue-triage: needs-info --> ping @someone now`);
  assert.ok(!s.includes('<!--'));
  assert.ok(!s.includes('@someone'));
  assert.ok(s.includes('ping'));
  assert.ok(sanitizeText('x'.repeat(500)).length <= 240);
});

test('sanitize: strips markdown links and bare URLs, keeps link text', () => {
  const s = sanitizeText(
    'see [the fix](https://evil.example/x) and https://evil.example/y for details'
  );
  assert.ok(!s.includes('http'), s);
  assert.ok(!s.includes(']('), s);
  assert.ok(s.includes('the fix'));
  assert.ok(s.includes('details'));
});

test('queries: title keywords, error line, broad fallback; qualifiers cannot be smuggled', () => {
  const qs = extractSearchQueries(
    'Daemon crashes when label:needs-info opening the settings panel',
    'steps\n\nthread panicked at crates/store/src/lib.rs:42\nmore text'
  );
  assert.strictEqual(qs.length, 3);
  assert.ok(!qs[0].includes(':'), `no qualifier colon in ${JSON.stringify(qs[0])}`);
  assert.ok(qs[0].includes('daemon'));
  assert.strictEqual(qs[0].split(' ').length, 4);
  assert.ok(qs[1].includes('panicked'));
  // Broad 2-keyword fallback for recall (GitHub ANDs every term).
  assert.strictEqual(qs[2].split(' ').length, 2);

  // Short titles get no fallback query.
  assert.deepStrictEqual(extractSearchQueries('panel focus lost', ''), [
    'panel focus lost',
  ]);
});

test('plan: existing labels gate inference; needs-triage retired; dup allowlist enforced', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  const plan = planActions({
    response,
    currentLabels: ['needs-triage'],
    candidateNumbers: [101, 102],
  });
  assert.deepStrictEqual(plan.addLabels, [
    'component:intentd', 'bug', 'priority:P1', POSSIBLE_DUPLICATE_LABEL,
  ]);
  // Only the high-confidence candidate survives.
  assert.deepStrictEqual(plan.duplicates.map((d) => d.number), [101]);
  assert.strictEqual(plan.removeNeedsTriage, true);

  // Pass-1 / human labels win: nothing re-inferred, dup number not in the
  // candidate set is discarded even at high confidence.
  const gated = planActions({
    response,
    currentLabels: ['component:fe', 'enhancement', 'priority:P3'],
    candidateNumbers: [999],
  });
  assert.deepStrictEqual(gated.addLabels, []);
  assert.deepStrictEqual(gated.duplicates, []);
  assert.strictEqual(gated.removeNeedsTriage, false);
  // Without a resolved Type list nothing is set.
  assert.strictEqual(plan.issueType, null);
  assert.strictEqual(gated.issueType, null);
});

test('type: untyped issue gets the Type from the model inference; IDs come from the runtime list', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  const plan = planActions({
    response,
    currentLabels: ['needs-triage'],
    candidateNumbers: [],
    currentIssueType: null,
    issueTypes: ISSUE_TYPES,
  });
  assert.deepStrictEqual(plan.issueType, {
    id: 'IT_bug',
    name: 'Bug',
    reason: 'Reports a panic, clearly a defect',
  });
});

test('type: existing type label wins over the model; question maps to Task', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  const fromLabel = planIssueType({
    response,
    currentLabels: ['enhancement'],
    currentIssueType: null,
    issueTypes: ISSUE_TYPES,
  });
  assert.strictEqual(fromLabel.name, 'Feature');
  assert.strictEqual(fromLabel.id, 'IT_feature');
  assert.ok(fromLabel.reason.includes('`enhancement` label'));

  response.type = 'question';
  const question = planIssueType({
    response,
    currentLabels: [],
    currentIssueType: null,
    issueTypes: ISSUE_TYPES,
  });
  assert.strictEqual(question.name, 'Task');
  assert.strictEqual(question.id, 'IT_task');
  assert.deepStrictEqual(ISSUE_TYPE_BY_LABEL, {
    bug: 'Bug', enhancement: 'Feature', question: 'Task',
  });
});

test('type: an existing Type is never overwritten', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  const plan = planActions({
    response,
    currentLabels: ['enhancement'],
    candidateNumbers: [],
    currentIssueType: 'Task',
    issueTypes: ISSUE_TYPES,
  });
  assert.strictEqual(plan.issueType, null);
});

test('type: nothing is set without a signal, a matching enabled Type, or a resolved list', () => {
  const noSignal = parseTriageResponse('{"security": false}');
  assert.strictEqual(
    planIssueType({ response: noSignal, currentLabels: [], currentIssueType: null, issueTypes: ISSUE_TYPES }),
    null
  );
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  assert.strictEqual(
    planIssueType({ response, currentLabels: [], currentIssueType: null, issueTypes: [] }),
    null
  );
  assert.strictEqual(
    planIssueType({
      response,
      currentLabels: [],
      currentIssueType: null,
      issueTypes: [{ id: 'IT_bug', name: 'Bug', isEnabled: false }],
    }),
    null
  );
  assert.strictEqual(
    planIssueType({
      response,
      currentLabels: [],
      currentIssueType: null,
      issueTypes: [{ id: 'IT_task', name: 'Task', isEnabled: true }],
    }),
    null
  );
});

test('fields: empty Priority and Effort are filled from the model; IDs come from the runtime list', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.effort = 'Medium';
  response.reasons.effort = 'Touches one crate and needs a regression test';
  const plan = planIssueFields({
    response,
    currentFieldValues: {},
    issueFields: ISSUE_FIELDS,
  });
  assert.deepStrictEqual(plan, {
    priority: {
      fieldId: 'IFSS_priority',
      optionId: 'IFSSO_high',
      name: 'High',
      reason: 'Daemon crash on startup but a restart recovers',
    },
    effort: {
      fieldId: 'IFSS_effort',
      optionId: 'IFSSO_e_medium',
      name: 'Medium',
      reason: 'Touches one crate and needs a regression test',
    },
  });

  // The P0–P3 map covers every label; the field vocabulary is accepted as-is.
  for (const [label, name] of Object.entries({ P0: 'Urgent', P1: 'High', P2: 'Medium', P3: 'Low' })) {
    response.priority = label;
    assert.strictEqual(
      planIssueFields({ response, currentFieldValues: {}, issueFields: ISSUE_FIELDS }).priority.name,
      name
    );
    response.priority = name;
    assert.strictEqual(
      planIssueFields({ response, currentFieldValues: {}, issueFields: ISSUE_FIELDS }).priority.name,
      name
    );
  }
});

test('fields: an existing value is never overwritten', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.effort = 'Low';
  const priorityKept = planIssueFields({
    response,
    currentFieldValues: { Priority: 'Low' },
    issueFields: ISSUE_FIELDS,
  });
  assert.strictEqual(priorityKept.priority, undefined);
  assert.strictEqual(priorityKept.effort.name, 'Low');

  const bothKept = planIssueFields({
    response,
    currentFieldValues: { Priority: 'Medium', Effort: 'High' },
    issueFields: ISSUE_FIELDS,
  });
  assert.deepStrictEqual(bothKept, {});

  // Security escalation does not override a human-set Priority either.
  response.security = true;
  assert.strictEqual(
    planIssueFields({ response, currentFieldValues: { Priority: 'Low' }, issueFields: ISSUE_FIELDS })
      .priority,
    undefined
  );
});

test('fields: unknown options, no signal, or an unresolved field list plan nothing', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.effort = 'Huge';
  const unknownEffort = planIssueFields({
    response,
    currentFieldValues: {},
    issueFields: ISSUE_FIELDS,
  });
  assert.strictEqual(unknownEffort.effort, undefined);
  assert.strictEqual(unknownEffort.priority.name, 'High');

  response.effort = 'Medium';
  // Option renamed / missing at runtime: the field is skipped, not guessed.
  const noHigh = planIssueFields({
    response,
    currentFieldValues: {},
    issueFields: [
      { id: 'IFSS_priority', name: 'Priority', options: [{ id: 'IFSSO_low', name: 'Low' }] },
      ISSUE_FIELDS[1],
    ],
  });
  assert.strictEqual(noHigh.priority, undefined);
  assert.strictEqual(noHigh.effort.name, 'Medium');

  // Lookup failed / fields unavailable.
  assert.deepStrictEqual(
    planIssueFields({ response, currentFieldValues: {}, issueFields: [] }),
    {}
  );
  assert.deepStrictEqual(
    planIssueFields({ response, currentFieldValues: {}, issueFields: undefined }),
    {}
  );

  // No priority/effort signal at all.
  assert.deepStrictEqual(
    planIssueFields({
      response: parseTriageResponse('{"security": false}'),
      currentFieldValues: {},
      issueFields: ISSUE_FIELDS,
    }),
    {}
  );
});

test('fields: security escalates Priority to Urgent regardless of the model pick', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.security = true;
  response.priority = 'P3';
  const plan = planIssueFields({ response, currentFieldValues: {}, issueFields: ISSUE_FIELDS });
  assert.strictEqual(plan.priority.name, 'Urgent');
  assert.strictEqual(plan.priority.optionId, 'IFSSO_urgent');
  assert.strictEqual(plan.priority.reason, 'suspected security impact escalates to Urgent');

  response.priority = null;
  assert.strictEqual(
    planIssueFields({ response, currentFieldValues: {}, issueFields: ISSUE_FIELDS }).priority.name,
    'Urgent'
  );
});

test('plan: needs-info keeps needs-triage in place', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  const plan = planActions({
    response,
    currentLabels: ['needs-triage', 'needs-info'],
    candidateNumbers: [101],
  });
  assert.strictEqual(plan.removeNeedsTriage, false);
});

test('plan: repeated duplicate numbers are deduped', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.duplicates = [
    { number: 101, confidence: 'high', reason: 'first' },
    { number: 101, confidence: 'high', reason: 'second' },
    { number: 102, confidence: 'high', reason: 'other' },
  ];
  const plan = planActions({
    response,
    currentLabels: [],
    candidateNumbers: [101, 102],
  });
  assert.deepStrictEqual(plan.duplicates.map((d) => d.number), [101, 102]);
  assert.strictEqual(plan.duplicates[0].reason, 'first');
});

test('plan: docs label counts as a component; security escalates priority to P0', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.security = true;
  response.priority = 'P3';
  const plan = planActions({ response, currentLabels: ['docs'], candidateNumbers: [] });
  assert.ok(!plan.addLabels.some((l) => l.startsWith('component:')));
  assert.ok(plan.addLabels.includes('priority:P0'));
});

test('comment: lists labels, candidates, and security redirect; always carries the marker', () => {
  const response = parseTriageResponse(fixture('agentic-response-clean.txt'));
  response.security = true;
  const plan = planActions({
    response,
    currentLabels: ['needs-triage'],
    candidateNumbers: [101],
  });
  const comment = buildSummaryComment(plan);
  assert.ok(comment.includes('`component:intentd`'));
  assert.ok(comment.includes('#101'));
  assert.ok(comment.includes('security/advisories'));
  assert.ok(!comment.includes('Type set:'));
  assert.ok(comment.endsWith(AGENTIC_MARKER));

  const typed = buildSummaryComment(
    planActions({
      response,
      currentLabels: ['needs-triage'],
      candidateNumbers: [],
      currentIssueType: null,
      issueTypes: ISSUE_TYPES,
    })
  );
  assert.ok(typed.includes('Type set: **Bug** — Reports a panic, clearly a defect'));

  const empty = buildSummaryComment(
    planActions({
      response: parseTriageResponse('{"security": false}'),
      currentLabels: [],
      candidateNumbers: [],
    })
  );
  assert.ok(empty.includes('No additional labels suggested.'));
  assert.ok(empty.endsWith(AGENTIC_MARKER));
});

test('prompt: embeds issue and candidates as data with the untrusted-data rule', () => {
  const prompt = buildPrompt(
    { number: 7, title: 'Panel focus lost', body: 'body text', labels: ['needs-triage'] },
    [{ number: 101, state: 'OPEN', title: 'Focus bug', labels: ['bug'], body: 'candidate body' }]
  );
  assert.ok(prompt.includes('ISSUE #7'));
  assert.ok(prompt.includes('candidate body'));
  assert.ok(prompt.includes('untrusted user data'));
  assert.ok(prompt.includes('"P0"|"P1"|"P2"|"P3"|null'));
});
