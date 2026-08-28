// Fixture-driven tests for the pass-1 triage parser.
// Run locally with:  node --test .github/scripts/issue-triage/parse-issue.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { labelsForIssueBody } = require('./parse-issue.js');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('template bug: components, severity, and agent-filed all map to labels', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('bug-full.md')), [
    'component:intentd',
    'docs',
    'priority:P0',
    'agent-filed',
  ]);
});

test('template bug: single component + severity, agent-filed unchecked', () => {
  assert.deepStrictEqual(labelsForIssueBody(fixture('bug-single-component.md')), [
    'component:fe',
    'priority:P2',
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
    '### Severity\r\n\r\nP3 — papercut; annoying but does not block workflows\r\n';
  assert.deepStrictEqual(labelsForIssueBody(body), [
    'component:intentd',
    'priority:P3',
  ]);
});

test('severity not starting with a Pn token yields no priority label', () => {
  const body = '### Severity\n\nsomething custom the user typed\n';
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
