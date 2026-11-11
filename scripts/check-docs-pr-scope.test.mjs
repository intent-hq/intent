import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXEMPTION_LABEL,
  MAX_LISTED_FILES,
  evaluate,
  formatFailure,
  isDocsTitle,
  isDocumentationPath,
  suggestTypes,
} from './check-docs-pr-scope.mjs';

const SCRIPT = fileURLToPath(new URL('./check-docs-pr-scope.mjs', import.meta.url));
const APP_GUIDE = 'crates/intent-services/resources/assistant-app-guide.md';

// intentd#2839: a docs title over a flaky-test fix in hook_manager.rs.
const INCIDENT = {
  title: 'docs: explain sidebar multi-pane selection',
  files: [APP_GUIDE, 'crates/intent-svc-runtime/src/hook_manager.rs'],
};

test('recognizes docs titles with and without a scope or bang', () => {
  for (const title of ['docs: x', 'docs(guide): x', 'docs!: x', 'Docs: x', '  docs: x']) {
    assert.equal(isDocsTitle(title), true, title);
  }
  for (const title of ['doc: x', 'fix: docs link', 'chore(docs): x', 'docsy: x', 'test: x', '', undefined]) {
    assert.equal(isDocsTitle(title), false, String(title));
  }
});

test('classifies Markdown and docs assets as documentation', () => {
  for (const file of ['README.md', APP_GUIDE, 'docs/guide.mdx', 'CHANGELOG.markdown', 'docs/img/flow.svg', 'a/docs/shot.PNG']) {
    assert.equal(isDocumentationPath(file), true, file);
  }
  for (const file of ['src/lib.rs', 'src/app.ts', 'static/icon.svg', 'docs/build.ts', 'Cargo.toml', 'package.json', '.github/workflows/ci.yml']) {
    assert.equal(isDocumentationPath(file), false, file);
  }
});

test('fails the incident: a docs title that changes a Rust file', () => {
  assert.deepEqual(evaluate({ ...INCIDENT, labels: [] }), {
    codeFiles: ['crates/intent-svc-runtime/src/hook_manager.rs'],
    suggestions: ['fix', 'test', 'refactor', 'feat', 'chore'],
  });
});

test('fails a docs title that changes a TypeScript file', () => {
  const result = evaluate({ title: 'docs(sidebar): describe panes', labels: [], files: ['docs/panes.md', 'src/lib/sidebar.ts'] });
  assert.deepEqual(result?.codeFiles, ['src/lib/sidebar.ts']);
});

test('passes a docs-only pull request, the app guide included', () => {
  assert.equal(evaluate({ title: INCIDENT.title, labels: [], files: [APP_GUIDE, 'README.md', 'docs/a.png'] }), null);
});

test('passes code changes under any other title', () => {
  assert.equal(evaluate({ title: 'test: stabilize hook manager tests', labels: [], files: INCIDENT.files }), null);
});

test('the exemption label bypasses the check', () => {
  assert.equal(evaluate({ ...INCIDENT, labels: ['documentation', EXEMPTION_LABEL] }), null);
});

test('suggests test: for test-only changes and ci: for workflow-only changes', () => {
  assert.deepEqual(suggestTypes(['crates/a/tests/hooks.rs', 'src/app.test.ts', 'scripts/test_x.py']), ['test']);
  assert.deepEqual(suggestTypes(['.github/workflows/ci.yml']), ['ci']);
  assert.deepEqual(suggestTypes(['src/app.ts', 'src/app.test.ts'])[0], 'fix');
});

test('the failure message names the files, a retitle, a split and the label', () => {
  const message = formatFailure('docs(sidebar): explain panes', evaluate({ ...INCIDENT, title: 'docs(sidebar): explain panes', labels: [] }));
  assert.match(message, /changes 1 file that is not documentation:\n  crates\/intent-svc-runtime\/src\/hook_manager\.rs\n/);
  assert.match(message, /"fix\(sidebar\): explain panes"/);
  assert.match(message, /Split the code change/);
  assert.match(message, new RegExp(EXEMPTION_LABEL));
});

test('the failure message truncates long file lists', () => {
  const files = Array.from({ length: MAX_LISTED_FILES + 3 }, (_, index) => `src/f${String(index).padStart(2, '0')}.rs`);
  const message = formatFailure('docs: x', evaluate({ title: 'docs: x', labels: [], files }));
  assert.match(message, /changes 23 files/);
  assert.match(message, /\.\.\. and 3 more/);
  assert.doesNotMatch(message, /src\/f22\.rs/);
});

function runCli(pullRequest, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-pr-scope-'));
  const prPath = path.join(dir, 'pr.json');
  const filesPath = path.join(dir, 'files.txt');
  fs.writeFileSync(prPath, JSON.stringify(pullRequest));
  fs.writeFileSync(filesPath, `${files.join('\n')}\n`);
  const env = { ...process.env, GITHUB_ACTIONS: 'true' };
  const result = spawnSync(process.execPath, [SCRIPT, prPath, filesPath], { encoding: 'utf8', env });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('cli: fails the incident with an annotation naming the file', () => {
  const result = runCli({ title: INCIDENT.title, labels: [{ name: 'documentation' }] }, INCIDENT.files);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error title=docs: title with code changes::/m);
  assert.match(result.stderr, /hook_manager\.rs/);
  assert.doesNotMatch(result.stderr, /assistant-app-guide/);
});

test('cli: passes docs-only, non-docs titles and labelled pull requests', () => {
  assert.equal(runCli({ title: INCIDENT.title, labels: [] }, [APP_GUIDE]).status, 0);
  assert.equal(runCli({ title: 'fix: hooks', labels: [] }, INCIDENT.files).status, 0);
  const labelled = runCli({ title: INCIDENT.title, labels: [{ name: EXEMPTION_LABEL }] }, INCIDENT.files);
  assert.equal(labelled.status, 0);
  assert.match(labelled.stdout, new RegExp(`${EXEMPTION_LABEL} label is applied`));
});

test('cli: rejects missing arguments and a pull request without a title', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.notEqual(runCli({ labels: [] }, ['src/a.rs']).status, 0);
});
