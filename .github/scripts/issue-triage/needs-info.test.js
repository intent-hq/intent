// Fixture-driven tests for the needs-info completeness loop.
// Run locally with:  node --test .github/scripts/issue-triage/needs-info.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  NEEDS_INFO_LABEL,
  NEEDS_INFO_MARKER,
  assessCompleteness,
  buildNudgeComment,
  nudgeActions,
  shouldClearNeedsInfo,
} = require('./needs-info.js');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// --- assessCompleteness -----------------------------------------------------

test('bug with placeholder repro and n/a expected-vs-actual is incomplete', () => {
  const a = assessCompleteness(fixture('bug-incomplete.md'));
  assert.strictEqual(a.incomplete, true);
  assert.deepStrictEqual(a.reasons, [
    'the "Reproduction steps" section is empty or placeholder-only',
    'the "Expected vs actual" section is empty or placeholder-only',
  ]);
});

test('bug with real repro and expected-vs-actual is complete', () => {
  assert.strictEqual(assessCompleteness(fixture('bug-full.md')).incomplete, false);
});

test('bug with _No response_ expected-vs-actual is incomplete on that section only', () => {
  const a = assessCompleteness(fixture('no-selections.md'));
  assert.strictEqual(a.incomplete, true);
  assert.deepStrictEqual(a.reasons, [
    'the "Expected vs actual" section is empty or placeholder-only',
  ]);
});

test('placeholder-word-only sections (tbd/todo) are incomplete', () => {
  const body = '### Reproduction steps\n\ntbd\n\n### Expected vs actual\n\nTODO\n';
  assert.strictEqual(assessCompleteness(body).incomplete, true);
});

test('feature request (no repro sections) is never flagged', () => {
  assert.strictEqual(assessCompleteness(fixture('feature-request.md')).incomplete, false);
});

test('blank issue with substantial free-form content is complete', () => {
  assert.strictEqual(assessCompleteness(fixture('blank-issue.md')).incomplete, false);
});

test('near-empty blank issue is incomplete (image/link URLs do not count)', () => {
  const a = assessCompleteness(fixture('blank-near-empty.md'));
  assert.strictEqual(a.incomplete, true);
  assert.strictEqual(a.reasons.length, 1);
});

test('empty and non-string bodies are incomplete', () => {
  assert.strictEqual(assessCompleteness('').incomplete, true);
  assert.strictEqual(assessCompleteness(null).incomplete, true);
  assert.strictEqual(assessCompleteness(undefined).incomplete, true);
});

// --- buildNudgeComment ------------------------------------------------------

test('nudge comment lists each reason and embeds the hidden marker', () => {
  const reasons = ['the "Reproduction steps" section is empty or placeholder-only'];
  const comment = buildNudgeComment(reasons);
  assert.ok(comment.includes(`- ${reasons[0]}`));
  assert.ok(comment.includes(NEEDS_INFO_MARKER));
  assert.ok(comment.includes(NEEDS_INFO_LABEL));
});

// --- nudgeActions (marker idempotency) ----------------------------------------

const incomplete = { incomplete: true, reasons: ['x'] };
const NOTHING = { addLabel: false, postComment: false };

test('fresh incomplete issue gets both the label and the nudge comment', () => {
  assert.deepStrictEqual(
    nudgeActions({ assessment: incomplete, labels: ['bug'], commentBodies: [] }),
    { addLabel: true, postComment: true }
  );
});

test('complete issue never gets a nudge', () => {
  assert.deepStrictEqual(
    nudgeActions({ assessment: { incomplete: false, reasons: [] }, labels: [], commentBodies: [] }),
    NOTHING
  );
});

test('label present without marker still posts the comment (recovers a failed comment)', () => {
  assert.deepStrictEqual(
    nudgeActions({ assessment: incomplete, labels: ['bug', NEEDS_INFO_LABEL], commentBodies: [] }),
    { addLabel: false, postComment: true }
  );
});

test('marker comment suppresses everything, even after the label was removed', () => {
  assert.deepStrictEqual(
    nudgeActions({
      assessment: incomplete,
      labels: ['bug'],
      commentBodies: ['unrelated', `Thanks!\n\n${NEEDS_INFO_MARKER}`],
    }),
    NOTHING
  );
});

test('marker comment plus label present changes nothing (fully nudged)', () => {
  assert.deepStrictEqual(
    nudgeActions({
      assessment: incomplete,
      labels: ['bug', NEEDS_INFO_LABEL],
      commentBodies: [buildNudgeComment(['x'])],
    }),
    NOTHING
  );
});

// --- shouldClearNeedsInfo (author vs non-author) ------------------------------

const labeled = ['bug', NEEDS_INFO_LABEL];

test('issue author comment on a needs-info issue clears the label', () => {
  assert.strictEqual(
    shouldClearNeedsInfo({
      labels: labeled, issueAuthor: 'alice', commentAuthor: 'alice', commentBody: 'here are the steps',
    }),
    true
  );
});

test('non-author comment does not clear the label', () => {
  assert.strictEqual(
    shouldClearNeedsInfo({
      labels: labeled, issueAuthor: 'alice', commentAuthor: 'bob', commentBody: 'me too',
    }),
    false
  );
});

test('comment on an unlabeled issue clears nothing', () => {
  assert.strictEqual(
    shouldClearNeedsInfo({
      labels: ['bug'], issueAuthor: 'alice', commentAuthor: 'alice', commentBody: 'update',
    }),
    false
  );
});

test('the marker-carrying nudge comment itself never clears the label', () => {
  assert.strictEqual(
    shouldClearNeedsInfo({
      labels: labeled, issueAuthor: 'alice', commentAuthor: 'alice',
      commentBody: buildNudgeComment(['x']),
    }),
    false
  );
});

test('missing author information never clears the label', () => {
  assert.strictEqual(
    shouldClearNeedsInfo({ labels: labeled, issueAuthor: undefined, commentAuthor: undefined, commentBody: 'hi' }),
    false
  );
});
