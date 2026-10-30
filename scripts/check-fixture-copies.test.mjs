import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTERED, checkFixtureCopies } from './check-fixture-copies.mjs';
import { defineFixtureCopy, jsonBytes } from './lib/fixture-copy.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = 'docs/protocol/fixtures/toy/cases.json';

const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t',
  '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function write(root, file, bytes) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), bytes);
}

const V1 = jsonBytes({ revision: 1, cases: ['first'] });
const V2 = jsonBytes({ revision: 2, cases: ['first', 'second'] });

/** A monorepo whose toy fixture went through two versions, with an initialized intentd. */
function monorepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-copies-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, 'scripts'));
  write(root, FIXTURE, V1);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'v1');
  write(root, FIXTURE, V2);
  git(root, 'commit', '-q', '-am', 'v2');
  const intentd = path.join(root, 'packages/intentd');
  fs.mkdirSync(intentd, { recursive: true });
  git(intentd, 'init', '-q');
  write(intentd, 'README.md', 'intentd\n');
  return { root, intentd };
}

const toy = defineFixtureCopy({
  name: 'toy',
  sourcePath: FIXTURE,
  provenance: 'revision',
  copies: { intentd: { file: 'tests/fixtures/toy.json' } },
  validate: () => 'ok',
});
const options = { registered: [toy], components: ['cloudlands-fe', 'intentd'] };

test('registered copies pass, at the current or an older fixture version', (t) => {
  const { root, intentd } = monorepo(t);
  write(intentd, 'tests/fixtures/toy.json', V1);
  git(intentd, 'add', '-A');
  const { report, warnings } = checkFixtureCopies(root, options);
  assert.match(report, /intentd: 1 fixture copies found; all registered/);
  assert.match(report, /cloudlands-fe: uninspected/);
  // Every registered spec's own check runs too: the older copy lags and only warns.
  assert.match(report, /toy: canonical valid at revision 2/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /toy intentd: copy is at revision 1, behind/);
});

test('a tracked copy of the current fixture outside the shared tool fails', (t) => {
  const { root, intentd } = monorepo(t);
  write(intentd, 'crates/x/tests/fixtures/toy-copy.json', V2);
  git(intentd, 'add', '-A');
  assert.throws(() => checkFixtureCopies(root, options),
    /packages\/intentd\/crates\/x\/tests\/fixtures\/toy-copy\.json is a copy of docs\/protocol\/fixtures\/toy\/cases\.json that bypasses the shared fixture-copy tool/);
});

test('an untracked copy of an older fixture version also fails', (t) => {
  const { root, intentd } = monorepo(t);
  write(intentd, 'old.json', V1);
  assert.throws(() => checkFixtureCopies(root, options), /packages\/intentd\/old\.json is a copy of/);
  write(intentd, '.gitignore', 'old.json\n');
  assert.doesNotThrow(() => checkFixtureCopies(root, options));
});

test('a copy of a merge-resolved fixture version fails', (t) => {
  const { root, intentd } = monorepo(t);
  const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  write(root, FIXTURE, jsonBytes({ revision: 2, cases: ['side'] }));
  git(root, 'commit', '-q', '-am', 'side');
  git(root, 'checkout', '-q', main);
  try { git(root, 'merge', '-q', 'side'); } catch { /* conflict, resolved below */ }
  const resolved = jsonBytes({ revision: 3, cases: ['first', 'second', 'side'] });
  write(root, FIXTURE, resolved);
  git(root, 'commit', '-q', '-am', 'merge');
  // Move past the merge so the resolution exists only in a merge commit.
  write(root, FIXTURE, jsonBytes({ revision: 4, cases: [] }));
  git(root, 'commit', '-q', '-am', 'v4');
  write(intentd, 'resolved.json', resolved);
  git(intentd, 'add', '-A');
  assert.throws(() => checkFixtureCopies(root, options), /packages\/intentd\/resolved\.json is a copy of/);
});

test('a copy of a version that exists only on a merged branch whose fixture lost the merge fails', (t) => {
  const { root, intentd } = monorepo(t);
  const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'side');
  const intermediate = jsonBytes({ revision: 3, cases: ['side-intermediate'] });
  write(root, FIXTURE, intermediate);
  git(root, 'commit', '-q', '-am', 'side 1');
  write(root, FIXTURE, jsonBytes({ revision: 4, cases: ['side-final'] }));
  git(root, 'commit', '-q', '-am', 'side 2');
  git(root, 'checkout', '-q', main);
  // The merge keeps main's fixture, so default history simplification prunes the side branch.
  git(root, 'merge', '-q', '-s', 'ours', '--no-edit', 'side');
  write(intentd, 'intermediate.json', intermediate);
  git(intentd, 'add', '-A');
  assert.throws(() => checkFixtureCopies(root, options), /packages\/intentd\/intermediate\.json is a copy of/);
});

test('a registered spec whose own copy check fails fails the whole check', (t) => {
  const { root, intentd } = monorepo(t);
  write(intentd, 'tests/fixtures/toy.json', jsonBytes({ revision: 3, cases: [] }));
  git(intentd, 'add', '-A');
  assert.throws(() => checkFixtureCopies(root, options), /toy: toy intentd: copy is at revision 3, ahead of/);
});

test('a fixture-copy spec missing from REGISTERED fails', (t) => {
  const { root } = monorepo(t);
  write(root, 'scripts/new-fixture-contract.mjs', "export const COPY = defineFixtureCopy({\n  name: 'new-fixture',\n});\n");
  assert.throws(() => checkFixtureCopies(root, options), /scripts\/new-fixture-contract\.mjs \(new-fixture\) defines a fixture copy that is not in REGISTERED/);
});

test('a shallow monorepo checkout warns that only fetched history is compared', (t) => {
  const { root } = monorepo(t);
  const clone = path.join(root, 'packages/clone');
  execFileSync('git', ['clone', '-q', '--depth=1', `file://${root}`, clone], { stdio: 'ignore' });
  fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
  const { warnings } = checkFixtureCopies(clone, { ...options, components: [] });
  assert.match(warnings[0], /shallow/);
});

test('a single-file commit spec owns its copy before and after adoption', (t) => {
  const { root, intentd } = monorepo(t);
  const single = defineFixtureCopy({
    name: 'toy-file',
    sourcePath: FIXTURE,
    provenance: 'commit',
    copies: { intentd: { file: 'tests/goldens/toy_cases.json', lock: 'tests/goldens/toy_cases.lock.json' } },
    validate: () => 'ok',
  });
  write(intentd, 'tests/goldens/toy_cases.json', V1);
  git(intentd, 'add', '-A');
  const registered = { ...options, registered: [single] };
  let result = checkFixtureCopies(root, registered);
  assert.match(result.report, /intentd: 1 fixture copies found; all registered/);
  assert.match(result.report, /intentd: pre-adoption pin \(copy without lock tests\/goldens\/toy_cases\.lock\.json\)/);
  assert.deepEqual(result.warnings, []);
  assert.throws(() => checkFixtureCopies(root, options), /toy_cases\.json is a copy of/);
  // A hand-edited copy is no longer a copy for the bypass scan, but the spec still rejects it.
  write(intentd, 'tests/goldens/toy_cases.json', jsonBytes({ revision: 1, cases: ['edited'] }));
  assert.throws(() => checkFixtureCopies(root, registered), /toy_cases\.json matches no committed version of/);
  // Adopted: the lock is not mistaken for a copy, and a lagging copy warns.
  const commit = git(root, 'rev-parse', 'HEAD~1');
  git(root, 'checkout', '-q', commit);
  single.exportCopy({ sourceRoot: root, sourceCommit: commit, component: 'intentd', componentRoot: intentd });
  git(root, 'checkout', '-q', '-');
  git(intentd, 'add', '-A');
  result = checkFixtureCopies(root, registered);
  assert.match(result.report, /intentd: 1 fixture copies found; all registered/);
  assert.match(result.report, new RegExp(`intentd: adopted copy valid at ${commit}, behind canonical`));
  assert.equal(result.warnings.length, 1);
});

test('the real registry covers every adopted copy', () => {
  assert.deepEqual(REGISTERED.map((copy) => copy.name).sort(), [
    'backend-keychain', 'browser-routing', 'checkout-repo-config', 'event-stream-recovery', 'note-truncated-read',
    'scripts-compact', 'suggested-prompts', 'turn-start',
  ]);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-fixture-copies.mjs')],
    { encoding: 'utf8', env: { ...process.env, DD_TRACE_ENABLED: 'false' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /canonical fixture versions under docs\/protocol\/fixtures/);
});
