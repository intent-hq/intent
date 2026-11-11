import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverFixtureTests, findStrayTests, plan } from './protocol-fixture-tests.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_BODY = "import test from 'node:test';\ntest('x', () => {});\n";

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'protocol-fixture-tests-'));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  }
  return root;
}

test('discovers nested fixture tests in sorted order and ignores helpers', t => {
  const root = tree({
    'docs/protocol/fixtures/z/contract.test.mjs': TEST_BODY,
    'docs/protocol/fixtures/a/deep/er/case.test.mjs': TEST_BODY,
    'docs/protocol/fixtures/a/helper.mjs': 'export const x = 1;\n',
    'docs/protocol/fixtures/a/data.json': '{}',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(discoverFixtureTests(root), [
    'docs/protocol/fixtures/a/deep/er/case.test.mjs',
    'docs/protocol/fixtures/z/contract.test.mjs',
  ]);
  assert.deepEqual(plan(root).errors, []);
});

test('a new fixture test is picked up without editing any list', t => {
  const root = tree({ 'docs/protocol/fixtures/a/one.test.mjs': TEST_BODY });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(discoverFixtureTests(root).length, 1);
  writeFileSync(path.join(root, 'docs/protocol/fixtures/a/two.test.mjs'), TEST_BODY);
  assert.deepEqual(discoverFixtureTests(root), [
    'docs/protocol/fixtures/a/one.test.mjs',
    'docs/protocol/fixtures/a/two.test.mjs',
  ]);
});

test('fails on a node:test file that the glob would not run', t => {
  const root = tree({
    'docs/protocol/fixtures/a/ok.test.mjs': TEST_BODY,
    'docs/protocol/fixtures/a/contract.spec.mjs': TEST_BODY,
    'docs/protocol/fixtures/b/legacy.test.js': "const { test } = require('node:test');\n",
    'docs/protocol/loose.test.mjs': "const { test } = await import('node:test');\n",
    'docs/protocol/fixtures/a/helper.mjs': "export const name = 'not a test';\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(findStrayTests(root), [
    'docs/protocol/fixtures/a/contract.spec.mjs',
    'docs/protocol/fixtures/b/legacy.test.js',
    'docs/protocol/loose.test.mjs',
  ]);
  const { errors } = plan(root);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /contract\.spec\.mjs: imports node:test .* nothing runs it/);
});

test('fails when no fixture tests exist', t => {
  const root = tree({ 'docs/protocol/README.md': '# x\n' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(plan(root), { files: [], errors: ['no docs/protocol/fixtures/**/*.test.mjs files found'] });
});

test('the repository has fixture tests and no stray ones', () => {
  const { files, errors } = plan(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(files.includes('docs/protocol/fixtures/desktop-control/contract.test.mjs'), files.join('\n'));
});

function makeRecipe(makefile, target) {
  const lines = makefile.split('\n');
  const start = lines.findIndex(line => line.startsWith(`${target}:`));
  assert.notEqual(start, -1, `Makefile target ${target} not found`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line.trim());
  }
  return { header: lines[start], body };
}

test('docs-check depends on the shared runner target', () => {
  const makefile = readFileSync(path.join(repoRoot, 'Makefile'), 'utf8');
  const runner = makeRecipe(makefile, 'check-protocol-fixture-tests');
  assert.ok(runner.body.includes('@node --test scripts/protocol-fixture-tests.test.mjs'), runner.body.join('\n'));
  assert.ok(runner.body.includes('@node scripts/protocol-fixture-tests.mjs'), runner.body.join('\n'));
  const prerequisites = makeRecipe(makefile, 'docs-check').header.split('##')[0].split(/\s+/).slice(1);
  assert.ok(prerequisites.includes('check-protocol-fixture-tests'), prerequisites.join(' '));
  const docsCheck = makeRecipe(makefile, 'docs-check').body.join('\n');
  assert.doesNotMatch(docsCheck, /docs\/protocol\/fixtures\//, 'docs-check must not hand-list fixture tests');
});

function workflowJob(workflow, job) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `ci.yml job ${job} not found`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).filter(line => !/^\s*#/.test(line)).join('\n');
}

test('the CI docs-check job uses the shared target, not its own list', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const job = workflowJob(workflow, 'docs-check');
  assert.match(job, /^ {6}- run: make check-protocol-fixture-tests$/m);
  assert.doesNotMatch(job, /docs\/protocol\/fixtures\/[^\s]*\.test\.mjs/, 'CI must not hand-list fixture tests');
  assert.doesNotMatch(workflow, /node --test[^\n]*docs\/protocol\/fixtures/, 'ci.yml must not run fixture tests directly');
});
