import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findUnexpectedEntries, formatUnexpectedEntry } from './check-root-hygiene.mjs';

async function fixture(t, entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-root-hygiene-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    if (entry.includes('.')) await fs.writeFile(entryPath, '');
    else await fs.mkdir(entryPath);
  }
  return root;
}

test('accepts allowed top-level files and directories', async (t) => {
  const root = await fixture(t, ['README.md', 'docs', 'scripts']);
  assert.deepEqual(await findUnexpectedEntries(root), []);
});

test('reports unexpected entries in sorted order', async (t) => {
  const root = await fixture(t, ['README.md', 'scratch', 'debug.tmp']);
  assert.deepEqual(await findUnexpectedEntries(root), ['debug.tmp', 'scratch']);
});

test('failure message names the entry and allowlist location', () => {
  assert.equal(
    formatUnexpectedEntry('scratch.txt'),
    'Unexpected top-level entry: scratch.txt. Add it to ALLOWED_TOP_LEVEL_ENTRIES in scripts/check-root-hygiene.mjs if intentional.',
  );
});