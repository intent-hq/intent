// Fixture-driven tests for scripts/check-doc-links.mjs.
// Run: node --test scripts/check-doc-links.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkRepository, findInputs, headingSlug, inspectRepository } from './check-doc-links.mjs';

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

test('checks repo-relative Markdown links and skips URLs', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': '# Present\n[ok](docs/guide.md?view=full#intro) [web](https://example.com/missing#x) [anchor](#present)',
    'docs/guide.md': '## Intro\n[missing](../scripts/missing.mjs#usage)',
  });
  assert.deepEqual(await checkRepository(root), [
    { source: 'docs/guide.md', line: 2, target: '../scripts/missing.mjs#usage', resolved: 'scripts/missing.mjs' },
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
test('resolves heading anchors in other files and the same file', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': [
      '# Agent Guide',
      '[cross](docs/guide.md#saved-scripts-and-one-off-history-protocol-13-baseline)',
      '[same](#agent-guide) [encoded](docs/guide.md#w%C3%BCrfel-api) [setext](docs/guide.md#setext-title)',
    ].join('\n'),
    'docs/guide.md': [
      '#### Saved scripts and one-off history (protocol-13 baseline)',
      '## Würfel `API` ##',
      'Setext title',
      '============',
    ].join('\n'),
  });
  assert.deepEqual(await checkRepository(root), []);
});

test('reports an anchor whose heading was renamed', async (t) => {
  const root = await fixture(t, {
    'docs/a.md': 'See [scripts](methods/scripts.md#saved-scripts-and-one-off-history-1011-implemented-candidate).',
    'docs/methods/scripts.md': '#### Saved scripts and one-off history (protocol-13 baseline)\n',
    'docs/b.md': 'Intro\n\n[toc](#manager-issues)\n\n## Performance Issues\n',
  });
  assert.deepEqual(await checkRepository(root), [
    {
      source: 'docs/a.md',
      line: 1,
      target: 'methods/scripts.md#saved-scripts-and-one-off-history-1011-implemented-candidate',
      resolved: 'docs/methods/scripts.md#saved-scripts-and-one-off-history-1011-implemented-candidate',
    },
    { source: 'docs/b.md', line: 3, target: '#manager-issues', resolved: 'docs/b.md#manager-issues' },
  ]);
});

test('numbers duplicate headings like GitHub', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': '## Problem\n## Problem\n[first](#problem) [second](#problem-1) [missing](#problem-2)\n',
  });
  assert.deepEqual(await checkRepository(root), [
    { source: 'docs/guide.md', line: 3, target: '#problem-2', resolved: 'docs/guide.md#problem-2' },
  ]);
});

test('ignores headings inside code fences', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': [
      '```bash',
      '# Clean and rebuild',
      '```',
      '~~~~',
      '## Tilde heading',
      '```',
      '~~~~',
      '## Real heading',
      '[real](#real-heading) [fenced](#clean-and-rebuild) [tilde](#tilde-heading)',
    ].join('\n'),
  });
  const failures = await checkRepository(root);
  assert.deepEqual(
    failures.map((failure) => failure.target),
    ['#clean-and-rebuild', '#tilde-heading'],
  );
});

test('honors explicit HTML anchors', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': '<a id="custom-id"></a>\n<a name=\'legacy\'></a>\n[id](#custom-id) [name](#legacy)\n',
  });
  assert.deepEqual(await checkRepository(root), []);
});

test('ignores GitHub runtime anchors and non-Markdown targets', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': [
      '`See [Risk Analysis](#issuecomment-XXXX)` [review](#discussion_r123) [line](#L12-L20)',
      '[source](../scripts/tool.mjs#usage)',
    ].join('\n'),
    'scripts/tool.mjs': '',
  });
  assert.deepEqual(await checkRepository(root), []);
});

test('skips anchors into Markdown in an absent submodule', async (t) => {
  const root = await fixture(
    t,
    {
      '.gitmodules': '[submodule "packages/product"]\n\tpath = packages/product\n',
      'docs/guide.md': '[guide](../packages/product/AGENTS.md#missing)',
      'packages/product/AGENTS.md': '# Product\n',
    },
  );
  assert.deepEqual(await inspectRepository(root), { failures: [], skipped: 1 });
});

test('slugs headings like GitHub', () => {
  assert.equal(headingSlug('Saved scripts and one-off history (protocol-13 baseline)'), 'saved-scripts-and-one-off-history-protocol-13-baseline');
  assert.equal(headingSlug('5.8 `script.*`'), '58-script');
  assert.equal(headingSlug('Problem: "Cannot find module" errors in tests'), 'problem-cannot-find-module-errors-in-tests');
  assert.equal(headingSlug('See [the guide](docs/x.md) & <code>snake_case</code>'), 'see-the-guide--snake_case');
  assert.equal(headingSlug('Closing a workspace — ergonomics retrospective'), 'closing-a-workspace--ergonomics-retrospective');
});
