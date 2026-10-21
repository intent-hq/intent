// Fixture-driven tests for scripts/check-doc-links.mjs.
// Run: node --test scripts/check-doc-links.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRepository, findInputs, headingAnchors, headingSlug, inspectRepository } from './check-doc-links.mjs';

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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const PRIVATE_MODULES =
  '[submodule "packages/public"]\n\tpath = packages/public\n\tbranch = main\n' +
  '[submodule "packages/private"]\n\tpath = packages/private\n\tupdate = none\n';

test('reports missing bare paths when the only absent submodule is update = none', async (t) => {
  const root = await fixture(
    t,
    {
      '.gitmodules': PRIVATE_MODULES,
      'docs/guide.md': 'Run `scripts/missing.mjs` and `scripts/shared.mjs`.',
      'packages/public/.git': 'gitdir: elsewhere',
      'packages/public/scripts/shared.mjs': '',
    },
    ['packages/private'],
  );
  assert.deepEqual(await inspectRepository(root), {
    failures: [{ source: 'docs/guide.md', line: 1, target: 'scripts/missing.mjs', resolved: 'docs/scripts/missing.mjs' }],
    skipped: 0,
  });
});

test('does not resolve bare paths in an update = none submodule even when it is initialized', async (t) => {
  const root = await fixture(t, {
    '.gitmodules': PRIVATE_MODULES,
    'docs/guide.md': 'Run `scripts/ios-only.sh`.',
    'packages/public/.git': 'gitdir: elsewhere',
    'packages/private/.git': 'gitdir: elsewhere',
    'packages/private/scripts/ios-only.sh': '',
  });
  const { failures } = await inspectRepository(root);
  assert.deepEqual(failures.map((failure) => failure.target), ['scripts/ios-only.sh']);
});

test('still skips explicit links into an absent update = none submodule', async (t) => {
  const root = await fixture(
    t,
    {
      '.gitmodules': PRIVATE_MODULES,
      'docs/guide.md': '[build](../packages/private/scripts/build.sh) [notes](../packages/private/AGENTS.md#setup)',
    },
    ['packages/private'],
  );
  assert.deepEqual(await inspectRepository(root), { failures: [], skipped: 2 });
});

test('the repository declares packages/ios as the only update = none submodule', async () => {
  const gitmodules = await fs.readFile(path.join(REPO, '.gitmodules'), 'utf8');
  const optIn = gitmodules
    .split(/^\s*\[/m)
    .filter((section) => /^\s*update\s*=\s*none\s*$/m.test(section))
    .map((section) => section.match(/^\s*path\s*=\s*(.+?)\s*$/m)?.[1]);
  assert.deepEqual(optIn, ['packages/ios']);
});

function makeGraph(makefile) {
  const rules = new Map();
  let current = null;
  for (const line of makefile.split('\n')) {
    const rule = line.match(/^([A-Za-z0-9_.-]+(?:[ \t]+[A-Za-z0-9_.-]+)*)[ \t]*:(?!=)([^#]*)/);
    if (rule && !line.startsWith('\t')) {
      const prerequisites = rule[2].split(/\s+/).filter((name) => name && !name.includes('$') && name !== '|');
      current = rule[1].split(/\s+/);
      for (const target of current) {
        const entry = rules.get(target) ?? { prerequisites: [], recipe: '' };
        entry.prerequisites.push(...prerequisites);
        rules.set(target, entry);
      }
    } else if (line.startsWith('\t') && current) {
      for (const target of current) rules.get(target).recipe += `${line}\n`;
    } else if (line.trim() !== '') {
      current = null;
    }
  }
  return rules;
}

function reachable(rules, roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const target = stack.pop();
    if (seen.has(target) || !rules.has(target)) continue;
    seen.add(target);
    stack.push(...rules.get(target).prerequisites);
  }
  return seen;
}

// Incident: docs/protocol/README.md named an intentd script that existed only on an
// unmerged branch for ~3 weeks because CI ran the checker only without submodules.
// The docs-check job checks out intentd and cloudlands-fe at their pins, so it also
// runs the checker; component PRs must not (monorepo docs would fail them).
test('the docs-check CI job runs the checker after initializing the component submodules', async () => {
  const workflow = await fs.readFile(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const job = workflow.match(/^ {2}docs-check:\n([\s\S]*?)(?=^ {2}[\w-]+:\n)/m)?.[1];
  assert.ok(job, 'ci.yml has a docs-check job');
  const steps = job.split(/^ {6}- /m).slice(1);
  const init = steps.findIndex((step) => /git submodule update --init\b.*packages\/cloudlands-fe.*packages\/intentd/.test(step));
  const check = steps.findIndex((step) => /\bnode scripts\/check-doc-links\.mjs\b/.test(step));
  assert.ok(init >= 0, 'docs-check initializes cloudlands-fe and intentd');
  assert.ok(check > init, 'docs-check runs check-doc-links.mjs after the submodule init step');
});

test('component consumer checks never run the doc-link checker', async () => {
  const rules = makeGraph(await fs.readFile(path.join(REPO, 'Makefile'), 'utf8'));
  const consumerChecks = await fs.readFile(path.join(REPO, 'scripts/consumer-checks.sh'), 'utf8');
  const listed = consumerChecks.match(/^checks="([^"]+)"/m)?.[1].split(/\s+/);
  assert.ok(listed?.includes('docs-check'), 'consumer-checks.sh lists its make targets');
  const targets = reachable(rules, listed);
  assert.ok(targets.has('event-catalog-check'), 'docs-check prerequisites are followed');
  for (const target of targets) {
    assert.notEqual(target, 'check-doc-links', 'consumer checks must not depend on check-doc-links');
    assert.doesNotMatch(rules.get(target).recipe, /check-doc-links/, `make ${target} must not run the doc-link checker`);
  }
  for (const script of ['scripts/consumer-checks.sh', 'scripts/docs-check.sh']) {
    assert.doesNotMatch(await fs.readFile(path.join(REPO, script), 'utf8'), /check-doc-links/, `${script} must not run it`);
  }
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
      resolved: 'docs/methods/scripts.md',
      anchor: 'saved-scripts-and-one-off-history-1011-implemented-candidate',
    },
    { source: 'docs/b.md', line: 3, target: '#manager-issues', resolved: 'docs/b.md', anchor: 'manager-issues' },
  ]);
});

test('numbers duplicate headings like GitHub', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': '## Problem\n## Problem\n[first](#problem) [second](#problem-1) [missing](#problem-2)\n',
  });
  assert.deepEqual(await checkRepository(root), [
    { source: 'docs/guide.md', line: 3, target: '#problem-2', resolved: 'docs/guide.md', anchor: 'problem-2' },
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

test('slugs rendered heading text, keeping code spans literal', () => {
  assert.equal(headingSlug('`Option<T>` handling'), 'optiont-handling');
  assert.equal(headingSlug('`<a id="x">` inline'), 'a-idx-inline');
  assert.equal(headingSlug('The _foo_ option and __init__ with snake_case'), 'the-foo-option-and-init-with-snake_case');
  assert.equal(headingSlug('A &amp; B &#38; C'), 'a--b--c');
  assert.equal(headingSlug('See [x][ref] and <em>y</em>'), 'see-x-and-y');
});

test('numbers colliding duplicate slugs like github-slugger', () => {
  const anchors = headingAnchors('## Release-1\n## Release\n## Release\n');
  assert.deepEqual([...anchors], ['release-1', 'release', 'release-2']);
});

test('reads multi-line setext and blockquote headings', () => {
  const anchors = headingAnchors('Para line one\nline two\n---\n\n> ## Note\n\n- item\ncontinued\n---\n');
  assert.deepEqual([...anchors], ['para-line-one-line-two', 'note']);
});

test('takes explicit anchors from any tag but not from code spans', () => {
  const anchors = headingAnchors('Text `<a id="ex">` here\n<h2 id="custom">Custom</h2>\n<section name="named"></section>\n');
  assert.deepEqual([...anchors], ['custom', 'named']);
});

test('does not check anchors of example links in code or comments', async (t) => {
  const root = await fixture(t, {
    'docs/guide.md': [
      '```md',
      '[see](#fenced-example)',
      '```',
      '`[x](#inline-example)`',
      '<!-- [y](#commented-example) -->',
      '[real](#missing)',
    ].join('\n'),
  });
  assert.deepEqual(
    (await checkRepository(root)).map((failure) => failure.target),
    ['#missing'],
  );
});

test('checks directory anchors against the README GitHub renders', async (t) => {
  const root = await fixture(t, {
    'AGENTS.md': '[ok](docs/protocol/#present) [stale](docs/protocol/#renamed-section)',
    'docs/protocol/README.md': '# Present\n',
  });
  assert.deepEqual(await checkRepository(root), [
    {
      source: 'AGENTS.md',
      line: 1,
      target: 'docs/protocol/#renamed-section',
      resolved: 'docs/protocol/README.md',
      anchor: 'renamed-section',
    },
  ]);
});

test('reports an encoded hash in a missing path as a missing path', async (t) => {
  const root = await fixture(t, { 'docs/guide.md': '[notes](notes%23v2.md)' });
  const [failure] = await checkRepository(root);
  assert.equal(failure.resolved, 'docs/notes#v2.md');
  assert.equal(failure.anchor, undefined);
});
