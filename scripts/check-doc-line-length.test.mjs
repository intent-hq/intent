// Fixture-driven tests for scripts/check-doc-line-length.mjs.
// Run: node --test scripts/check-doc-line-length.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASELINE_PATH, LIMIT, check, compare, longLines, parseBaseline, scan } from './check-doc-line-length.mjs';

const SCRIPT = fileURLToPath(new URL('./check-doc-line-length.mjs', import.meta.url));
const long = (n = LIMIT + 1) => 'x'.repeat(n);

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-doc-line-length-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

test('a line at the limit passes and one code point over fails', () => {
  assert.deepEqual(longLines(`${long(LIMIT)}\n${long()}\n`), [{ line: 2, length: LIMIT + 1 }]);
});

test('counts Unicode code points, not UTF-16 units or bytes, and ignores a trailing CR', () => {
  assert.deepEqual(longLines(`${'—'.repeat(LIMIT)}\r\n${'😀'.repeat(LIMIT)}`), []);
  assert.deepEqual(longLines('é'.repeat(LIMIT + 1)), [{ line: 1, length: LIMIT + 1 }]);
});

test('fenced code lines count too', () => {
  assert.deepEqual(longLines(`\`\`\`\n${long()}\n\`\`\``), [{ line: 2, length: LIMIT + 1 }]);
});

test('scans docs/protocol/**/*.md only, sorted by path', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/methods/b.md': long(),
    'docs/protocol/a.md': 'short',
    'docs/protocol/notes.txt': long(),
    'docs/other.md': long(),
  });
  assert.deepEqual(await scan(root), [
    { path: 'docs/protocol/a.md', long: [] },
    { path: 'docs/protocol/methods/b.md', long: [{ line: 1, length: LIMIT + 1 }] },
  ]);
});

test('passes when every long line is within its baseline entry', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/a.md': `${long()}\nok\n${long()}\n`,
    'docs/protocol/b.md': 'ok\n',
    [BASELINE_PATH]: '# comment\n\ndocs/protocol/a.md 2\n',
  });
  assert.deepEqual((await check(root)).findings, []);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('a new long line in a file with no entry fails naming file:line', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/methods/pr.md': `ok\n${long()}\n`,
    [BASELINE_PATH]: '',
  });
  const { findings } = await check(root);
  assert.equal(findings[0], `docs/protocol/methods/pr.md: 1 line(s) over ${LIMIT} characters, the baseline has no entry for it:`);
  assert.match(findings[1], new RegExp(`^docs/protocol/methods/pr\\.md:2: error: line is ${LIMIT + 1} characters \\(limit ${LIMIT}\\)`));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/protocol\/methods\/pr\.md:2: error/);
});

test('a file over its entry fails listing every long line', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/a.md': `${long()}\n${long()}\n`,
    [BASELINE_PATH]: 'docs/protocol/a.md 1\n',
  });
  const { findings } = await check(root);
  assert.equal(findings[0], `docs/protocol/a.md: 2 line(s) over ${LIMIT} characters, the baseline allows 1:`);
  assert.equal(findings.length, 3);
});

test('a file under its entry fails naming the replacement baseline line', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/a.md': `${long()}\n`,
    [BASELINE_PATH]: 'docs/protocol/a.md 3\n',
  });
  assert.deepEqual((await check(root)).findings, [
    `${BASELINE_PATH}:1: error: docs/protocol/a.md has 1 line(s) over ${LIMIT} characters but the baseline allows 3; the ratchet only moves down: replace its line with \`docs/protocol/a.md 1\``,
  ]);
});

test('a fully reflowed file fails until its entry is removed', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/a.md': 'ok\n',
    [BASELINE_PATH]: 'docs/protocol/a.md 2\n',
  });
  assert.deepEqual((await check(root)).findings, [
    `${BASELINE_PATH}:1: error: docs/protocol/a.md has no lines over ${LIMIT} characters left but the baseline allows 2; the ratchet only moves down: remove its line \`docs/protocol/a.md 2\``,
  ]);
});

test('an entry for a missing file fails', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/a.md': 'ok\n',
    [BASELINE_PATH]: 'docs/protocol/gone.md 1\n',
  });
  assert.deepEqual((await check(root)).findings, [
    `${BASELINE_PATH}:1: error: docs/protocol/gone.md no longer exists; remove its line \`docs/protocol/gone.md 1\``,
  ]);
});

test('rejects malformed, zero, unsorted and duplicate baseline entries', () => {
  assert.deepEqual(parseBaseline('just-a-path\n').errors, [`${BASELINE_PATH}:1: error: expected \`<path> <count>\`, got "just-a-path"`]);
  assert.deepEqual(parseBaseline('a.md two\n').errors, [`${BASELINE_PATH}:1: error: count "two" is not a number`]);
  assert.deepEqual(parseBaseline('a.md 0\n').errors, [`${BASELINE_PATH}:1: error: a file with no too-long lines has no entry; remove "a.md 0"`]);
  assert.deepEqual(parseBaseline('b.md 1\na.md 1\n').errors, [`${BASELINE_PATH}:2: error: entries must be sorted by path and unique, but "a.md" follows "b.md"`]);
  assert.deepEqual(parseBaseline('a.md 1\na.md 1\n').errors, [`${BASELINE_PATH}:2: error: entries must be sorted by path and unique, but "a.md" follows "a.md"`]);
  assert.deepEqual(parseBaseline('a.md 1\nb.md 02\n'), {
    entries: [{ path: 'a.md', count: 1, line: 1 }, { path: 'b.md', count: 2, line: 2 }],
    errors: [],
  });
});

test('a missing baseline file fails', async (t) => {
  const root = await fixture(t, { 'docs/protocol/a.md': 'ok\n' });
  assert.deepEqual((await check(root)).findings, [`${BASELINE_PATH}: error: baseline file is missing`]);
});

test('compare honours a custom limit', () => {
  assert.deepEqual(compare([{ path: 'a.md', long: [] }], [], { limit: 10 }), []);
});

test('--print-counts prints the regenerated baseline and exits 0', async (t) => {
  const root = await fixture(t, {
    'docs/protocol/z.md': long(),
    'docs/protocol/a.md': `${long()}\n${long()}`,
    'docs/protocol/ok.md': 'ok',
    [BASELINE_PATH]: '',
  });
  const result = run(root, '--print-counts');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'docs/protocol/a.md 2\ndocs/protocol/z.md 1\n');
});

test('an unknown argument exits 2 with usage', async (t) => {
  const root = await fixture(t, { [BASELINE_PATH]: '' });
  const result = run(root, '--bogus');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: check-doc-line-length/m);
});
