import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXEMPTION_LABEL,
  EXEMPT_HEAD_REFS,
  findMovedGitlinks,
  findOffendingGitlinks,
  rawDiff,
  rawDiffArgs,
} from './check-submodule-pins.mjs';

const movedIntentd = ':160000 160000 3d37461 1c3dfbc M\tpackages/intentd';
const addedSubmodule = ':000000 160000 0000000 9f8e7d6 A\tpackages/new-module';
const removedSubmodule = ':160000 000000 9f8e7d6 0000000 D\tpackages/ios';
const docsChange = ':100644 100644 0a1b2c3 4d5e6f7 M\tAGENTS.md';
const addedFile = ':000000 100644 0000000 1234567 A\tscripts/check-submodule-pins.mjs';

test('accepts a diff without gitlink changes', () => {
  assert.deepEqual(findMovedGitlinks(`${docsChange}\n${addedFile}\n`), []);
  assert.deepEqual(findOffendingGitlinks(`${docsChange}\n`, 'feature/docs', []), []);
});

test('accepts an empty diff', () => {
  assert.deepEqual(findMovedGitlinks(''), []);
  assert.deepEqual(findMovedGitlinks(undefined), []);
});

test('reports a moved gitlink', () => {
  assert.deepEqual(findMovedGitlinks(`${movedIntentd}\n`), ['packages/intentd']);
});

test('reports added and removed gitlinks', () => {
  assert.deepEqual(findMovedGitlinks(`${addedSubmodule}\n${removedSubmodule}\n`), [
    'packages/new-module',
    'packages/ios',
  ]);
});

test('returns only gitlink paths from a mixed diff', () => {
  const diff = [docsChange, movedIntentd, addedFile].join('\n');
  assert.deepEqual(findOffendingGitlinks(diff, 'cycle-review', ['other-label']), ['packages/intentd']);
});

test('exempts the automation head branch', () => {
  for (const headRef of EXEMPT_HEAD_REFS) {
    assert.deepEqual(findOffendingGitlinks(movedIntentd, headRef, []), []);
  }
  assert.deepEqual(findOffendingGitlinks(movedIntentd, 'auto/submodule-bump-2', []), ['packages/intentd']);
});

test('does not exempt the automation branch name when it comes from a fork', () => {
  assert.deepEqual(findOffendingGitlinks(movedIntentd, EXEMPT_HEAD_REFS[0], [], { fromFork: true }), [
    'packages/intentd',
  ]);
  assert.deepEqual(findOffendingGitlinks(movedIntentd, EXEMPT_HEAD_REFS[0], [], { fromFork: false }), []);
});

test('exempts pull requests carrying the exemption label', () => {
  assert.deepEqual(findOffendingGitlinks(movedIntentd, 'feature/new-submodule', ['x', EXEMPTION_LABEL]), []);
});

test('diff arguments compare the merge base and never ignore submodules', () => {
  assert.deepEqual(rawDiffArgs('origin/main'), [
    'diff',
    '--raw',
    '--no-renames',
    '--ignore-submodules=none',
    'origin/main...HEAD',
  ]);
});

test('detects a moved gitlink even when the branch sets ignore = all in .gitmodules', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'check-submodule-pins-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
  git('init', '-q', '-b', 'main');
  git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},packages/foo`);
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(
    path.join(repo, '.gitmodules'),
    '[submodule "foo"]\n\tpath = packages/foo\n\turl = https://example.invalid/foo\n\tignore = all\n',
  );
  git('add', '.gitmodules');
  git('update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},packages/foo`);
  git('commit', '-q', '-m', 'bump');

  const defaultDiff = git('diff', '--raw', '--no-renames', 'HEAD~1...HEAD');
  assert.deepEqual(findMovedGitlinks(defaultDiff), [], 'fixture must reproduce the ignore = all bypass');
  assert.deepEqual(findMovedGitlinks(rawDiff('HEAD~1', { cwd: repo })), ['packages/foo']);
});
