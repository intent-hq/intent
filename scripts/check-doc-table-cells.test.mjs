// Fixture-driven tests for scripts/check-doc-table-cells.mjs.
// Run: node --test scripts/check-doc-table-cells.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, mismatchedRows } from './check-doc-table-cells.mjs';

const SCRIPT = fileURLToPath(new URL('./check-doc-table-cells.mjs', import.meta.url));
const table = (...body) => ['| Field | Meaning |', '| --- | --- |', ...body].join('\n');

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-doc-table-cells-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
}

test('a consistent table passes', () => {
  assert.deepEqual(mismatchedRows(table('| `a` | first |', '| `b` | second |')), []);
});

test('a row with an extra unescaped pipe fails at its line', () => {
  assert.deepEqual(mismatchedRows(`intro\n\n${table('| `a` | ok |', '| `b` | x | hidden |')}\n`), [
    { line: 6, cells: 3, header: 2, headerLine: 3 },
  ]);
});

test('a pipe inside a backtick code span still splits the cell, as on GitHub', () => {
  assert.deepEqual(mismatchedRows(table('| `outcome` | `{ status: "created"|"reused" }` |')), [
    { line: 3, cells: 3, header: 2, headerLine: 1 },
  ]);
});

test('an escaped pipe does not split the cell', () => {
  assert.deepEqual(mismatchedRows(table('| `outcome` | `{ status: "created"\\|"reused" }` |')), []);
});

test('the trailing pipe is optional on every row', () => {
  assert.deepEqual(mismatchedRows(['| a | b', '| --- | ---', '| 1 | 2 |', '| 3 | 4'].join('\n')), []);
});

test('a row with fewer cells than the header fails too', () => {
  assert.deepEqual(mismatchedRows(table('| `a` |')), [{ line: 3, cells: 1, header: 2, headerLine: 1 }]);
});

test('a delimiter row with the wrong cell count fails', () => {
  assert.deepEqual(mismatchedRows(['| a | b |', '| --- | --- | --- |', '| 1 | 2 |'].join('\n')), [
    { line: 2, cells: 3, header: 2, headerLine: 1 },
  ]);
});

test('alignment colons and up to three spaces of indentation are recognised', () => {
  assert.deepEqual(mismatchedRows(['   | a | b |', '   | :-- | --: |', '   | 1 | 2 | 3 |'].join('\n')), [
    { line: 3, cells: 3, header: 2, headerLine: 1 },
  ]);
});

test('fenced code blocks are ignored, including nested shorter fences', () => {
  const text = ['````md', '| a | b |', '| --- | --- |', '```', '| 1 | 2 | 3 |', '````', '', table('| x | y |')].join('\n');
  assert.deepEqual(mismatchedRows(text), []);
  assert.deepEqual(mismatchedRows(['~~~', '| a | b |', '| - | - |', '| 1 | 2 | 3 |', '~~~'].join('\n')), []);
});

test('pipe-led lines without a delimiter row are not a table', () => {
  assert.deepEqual(mismatchedRows('| just | a | line |\n| and | another |\n'), []);
});

test('a blank line ends the table; a later table uses its own header', () => {
  const text = [table('| a | b |'), '', '| one |', '| --- |', '| 1 |'].join('\n');
  assert.deepEqual(mismatchedRows(text), []);
});

test('CRLF line endings do not add a cell', () => {
  assert.deepEqual(mismatchedRows(table('| a | b |').replace(/\n/g, '\r\n')), []);
});

test('scans docs/protocol/**/*.md only and names file:line', async (t) => {
  const bad = table('| a | b | c |');
  const root = await fixture(t, {
    'docs/protocol/methods/agents.md': `# Agents\n\n${bad}\n`,
    'docs/protocol/ok.md': table('| a | b |'),
    'docs/protocol/notes.txt': bad,
    'docs/other.md': bad,
  });
  const findings = await check(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^docs\/protocol\/methods\/agents\.md:5: error: table row has 3 cell\(s\), its header \(line 3\) has 2/);
});

test('CLI exits 1 naming the row, and 0 on a clean tree', async (t) => {
  const root = await fixture(t, { 'docs/protocol/a.md': table('| `x` | `"a"|"b"` |') });
  const failed = run(root);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /docs\/protocol\/a\.md:3: error: table row has 3 cell/);

  await fs.writeFile(path.join(root, 'docs/protocol/a.md'), table('| `x` | `"a"\\|"b"` |'));
  const passed = run(root);
  assert.equal(passed.status, 0, passed.stderr);
});

test('fails closed on a symlink or a missing docs/protocol directory', async (t) => {
  const root = await fixture(t, { 'docs/protocol/a.md': 'ok\n', 'elsewhere.md': 'x\n' });
  await fs.symlink(path.join(root, 'elsewhere.md'), path.join(root, 'docs/protocol/linked.md'));
  const linked = run(root);
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /symlinks under docs\/protocol are not scanned/);

  const empty = await fixture(t, {});
  assert.equal(run(empty).status, 1);
});
