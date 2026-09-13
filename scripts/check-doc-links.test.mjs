// Fixture-driven tests for scripts/check-doc-links.mjs.
// Run: node --test scripts/check-doc-links.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkRepository, findInputs, inspectRepository } from './check-doc-links.mjs';

async function fixture(t, files, directories = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-doc-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of directories) await fs.mkdir(path.join(root, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

test('finds only the configured agent-facing Markdown inputs', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': '',
    'CONTRIBUTING.md': '',
    'README.md': '',
    'docs/guide.md': '',
    'docs/nested/detail.md': '',
    'packages/present/AGENTS.md': '',
    'packages/present/README.md': '',
  });
  const inputs = (await findInputs(root)).map((file) => path.relative(root, file));
  assert.deepEqual(inputs, [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'docs/guide.md',
    'docs/nested/detail.md',
    'packages/present/AGENTS.md',
  ]);
});

test('checks repo-relative Markdown links and skips URLs and anchors', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': '[ok](docs/guide.md?view=full#intro) [web](https://example.com/missing) [anchor](#missing)',
    'docs/guide.md': '[missing](../scripts/missing.mjs#usage)',
  });
  assert.deepEqual(await checkRepository(root), [
    { source: 'docs/guide.md', line: 1, target: '../scripts/missing.mjs#usage', resolved: 'scripts/missing.mjs' },
  ]);
});

test('checks only conservative backticked repository paths', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': '`docs/exists.md` `scripts/missing.mjs` `docs/**/*.md` `docs/...` `src/not-checked.ts`',
    'docs/exists.md': '',
  });
  assert.deepEqual(await checkRepository(root), [
    { source: 'AGENTS.md', line: 1, target: 'scripts/missing.mjs', resolved: 'scripts/missing.mjs' },
  ]);
});

test('skips links into submodules that are absent from the checkout', async (t) => {
  const root = await fixture(t, {
    '.gitmodules': '[submodule "packages/product"]\n\tpath = packages/product\n',
    'docs/guide.md': '[source](../packages/product/src/main.js)',
  });
  assert.deepEqual(await checkRepository(root), []);
});

test('skips bare paths requiring an uninitialized submodule directory', async (t) => {
  const root = await fixture(
    t,
    {
      '.gitmodules': '[submodule "packages/product"]\n\tpath = packages/product\n',
      'docs/guide.md': 'Run `scripts/release.mjs`.',
    },
    ['packages/product'],
  );
  assert.deepEqual(await inspectRepository(root), { failures: [], skipped: 1 });
});

test('resolves bare paths found only in an initialized submodule', async (t) => {
  const root = await fixture(t, {
    '.gitmodules': '[submodule "packages/product"]\n\tpath = packages/product\n',
    'docs/guide.md': 'Shared component script: `scripts/release.mjs`',
    'packages/product/AGENTS.md': 'Run `scripts/release.mjs`.',
    'packages/product/.git': 'gitdir: elsewhere',
    'packages/product/scripts/release.mjs': '',
  });
  assert.deepEqual(await checkRepository(root), []);
});

test('reports links that escape the repository', async (t) => {
  const root = await fixture(t, { 'AGENTS.md': '[outside](../outside.md)' });
  const [failure] = await checkRepository(root);
  assert.equal(failure.source, 'AGENTS.md');
  assert.equal(failure.target, '../outside.md');
});