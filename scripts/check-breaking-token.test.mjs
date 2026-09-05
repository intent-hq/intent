import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXEMPTION_LABEL,
  FOOTER_TOKENS,
  findOffendingLocations,
} from './check-breaking-token.mjs';

test('accepts a clean pull request', () => {
  assert.deepEqual(findOffendingLocations('Routine CI guard.', ['ci: add guard'], []), []);
});

test('reports a protected footer token in the pull request body', () => {
  assert.deepEqual(findOffendingLocations(`Details\n${FOOTER_TOKENS[0]} intentional`, [], []), [
    'pull request body',
  ]);
});

test('reports the offending commit among several messages', () => {
  const messages = ['test: cover clean input', `docs: quote ${FOOTER_TOKENS[1]}`, 'ci: wire guard'];
  assert.deepEqual(findOffendingLocations('', messages, []), ['commit 2']);
});

test('recognizes every protected footer token', () => {
  const messages = FOOTER_TOKENS.map((token) => `chore: mention ${token}`);
  assert.deepEqual(findOffendingLocations('', messages, []), ['commit 1', 'commit 2', 'commit 3']);
});

test('allows protected footer tokens with the exemption label', () => {
  assert.deepEqual(
    findOffendingLocations(FOOTER_TOKENS[2], FOOTER_TOKENS, ['other-label', EXEMPTION_LABEL]),
    [],
  );
});