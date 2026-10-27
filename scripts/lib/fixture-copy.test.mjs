import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  blobId, defineFixtureCopy, fixtureCopyMain, isFixtureCopy, jsonBytes, sha256,
} from './fixture-copy.mjs';

const SOURCE = 'docs/protocol/fixtures/toy/v1';
const REVISION_SOURCE = 'docs/protocol/fixtures/toy/routing.json';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}
const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t',
  '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Commit `doc` as the canonical toy fixture; returns the commit. */
function commitToy(root, doc, file = path.join(SOURCE, 'data.json')) {
  if (!fs.existsSync(path.join(root, '.git'))) git(root, 'init', '-q');
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), jsonBytes(doc));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'toy');
  return git(root, 'rev-parse', 'HEAD');
}

const commitCopy = (overrides = {}) => defineFixtureCopy({
  name: 'toy',
  sourcePath: SOURCE,
  provenance: 'commit',
  files: ['data.json'],
  copies: {
    alpha: { directory: 'fixtures/toy/v1', lock: 'fixtures/toy.lock.json' },
    beta: { directory: 'Tests/toy/v1', lock: 'Tests/toy.lock.json' },
  },
  // Today's rule: every doc needs `required: true`. Copies are never held to it.
  validate: (directory) => {
    const doc = JSON.parse(fs.readFileSync(path.join(directory, 'data.json'), 'utf8'));
    assert.equal(doc.required, true, 'canonical toy needs required: true');
    return `${doc.cases.length} cases`;
  },
  ...overrides,
});

const revisionCopy = () => defineFixtureCopy({
  name: 'toy-routing',
  sourcePath: REVISION_SOURCE,
  provenance: 'revision',
  copies: { alpha: { file: 'tests/fixtures/toy-routing.json' } },
  validate: () => 'ok',
});

const componentRoot = (root, component) => path.join(root, 'packages', component);
const exportTo = (copy, root, commit, component) =>
  copy.exportCopy({ sourceRoot: root, sourceCommit: commit, component, componentRoot: componentRoot(root, component) });

test('blobId equals the Git blob id', (t) => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'x'), 'hello\n');
  assert.equal(blobId(Buffer.from('hello\n')), execFileSync('git', ['hash-object', path.join(root, 'x')]).toString().trim());
});

test('defineFixtureCopy rejects unsafe or incomplete specs', () => {
  const base = { name: 'toy', sourcePath: SOURCE, provenance: 'commit', files: ['a.json'],
    copies: { alpha: { directory: 'd', lock: 'l.json' } }, validate: () => '' };
  assert.ok(isFixtureCopy(defineFixtureCopy(base)));
  for (const [change, pattern] of [
    [{ name: 'Toy' }, /kebab-case/],
    [{ provenance: 'hash' }, /provenance/],
    [{ sourcePath: 'docs/other/toy' }, /under docs\/protocol\/fixtures/],
    [{ copies: { alpha: { directory: '../escape', lock: 'l.json' } } }, /without '\.\.'/],
    [{ copies: { alpha: { directory: '/abs', lock: 'l.json' } } }, /relative/],
    [{ copies: {} }, /at least one component/],
    [{ files: [] }, /copied file names/],
    [{ validate: undefined }, /validate/],
  ]) {
    assert.throws(() => defineFixtureCopy({ ...base, ...change }), pattern, JSON.stringify(change));
  }
  assert.equal(isFixtureCopy({ name: 'toy' }), false);
});

test('commit: export then verify round-trips and check reports current copies', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const commit = commitToy(root, { required: true, cases: [1, 2] });
  for (const component of ['alpha', 'beta']) {
    assert.match(exportTo(copy, root, commit, component), new RegExp(`exported intent-hq/intent@${commit} \\(2 cases\\)`));
  }
  const lock = JSON.parse(fs.readFileSync(path.join(componentRoot(root, 'alpha'), 'fixtures/toy.lock.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(root, SOURCE, 'data.json'));
  assert.deepEqual(lock, { lockVersion: 1, sourceRepository: 'intent-hq/intent', sourcePath: SOURCE, sourceCommit: commit,
    files: { 'data.json': sha256(bytes) } });
  const { report, warnings } = copy.checkCopies(root);
  assert.match(report, new RegExp(`alpha: adopted copy valid at ${commit}, current`));
  assert.deepEqual(warnings, []);
});

test('commit: a lagging copy only warns, even when today\'s rules reject it', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const old = commitToy(root, { required: true, cases: [1] });
  exportTo(copy, root, old, 'alpha');
  // The old copy lacks a field today's canonical requires; docs lead the pin.
  commitToy(root, { required: true, cases: [1, 2], added: true });
  const { report, warnings } = copy.checkCopies(root);
  assert.match(report, new RegExp(`alpha: adopted copy valid at ${old}, behind canonical`));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /toy alpha: copy at .* is behind canonical/);
});

test('commit: a copy edited with a rehashed lock fails at its own commit', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const commit = commitToy(root, { required: true, cases: [1] });
  exportTo(copy, root, commit, 'alpha');
  const dir = componentRoot(root, 'alpha');
  const edited = jsonBytes({ required: true, cases: [9] });
  fs.writeFileSync(path.join(dir, 'fixtures/toy/v1/data.json'), edited);
  assert.throws(() => copy.checkCopies(root), /do not match the SHA-256 hashes in its lock/);
  const lockFile = path.join(dir, 'fixtures/toy.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, jsonBytes({ ...lock, files: { 'data.json': sha256(edited) } }));
  assert.throws(() => copy.checkCopies(root), new RegExp(`data.json differs from intent-hq/intent@${commit}, the commit its lock names`));
  assert.throws(() => copy.verifyCopy({ sourceRoot: root, sourceCommit: commit, component: 'alpha', componentRoot: dir }), /copy provenance/);
});

test('commit: a lock naming an unmerged commit fails; an absent commit is unverified', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const base = commitToy(root, { required: true, cases: [1] });
  git(root, 'checkout', '-q', '-b', 'side');
  const side = commitToy(root, { required: true, cases: [2] });
  exportTo(copy, root, side, 'alpha');
  git(root, 'checkout', '-q', base);
  assert.throws(() => copy.checkCopies(root), /not on this checkout's history/);
  const lockFile = path.join(componentRoot(root, 'alpha'), 'fixtures/toy.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, jsonBytes({ ...lock, sourceCommit: 'b'.repeat(40) }));
  const { warnings } = copy.checkCopies(root);
  assert.match(warnings[0], /ancestry is unverified/);
});

test('commit: sameSourceAcrossComponents rejects differing adopted locks', (t) => {
  const root = scratch(t);
  const copy = commitCopy({ sameSourceAcrossComponents: true });
  const first = commitToy(root, { required: true, cases: [1] });
  exportTo(copy, root, first, 'alpha');
  const second = commitToy(root, { required: true, cases: [2] });
  exportTo(copy, root, second, 'beta');
  assert.throws(() => copy.checkCopies(root), /conflicting adopted consumer pins/);
  // Without the option the same pins are a lagging copy.
  assert.equal(commitCopy().checkCopies(root).warnings.length, 1);
});

test('commit: half-deleted copies, stray files and a component that lost its copy fail', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const commit = commitToy(root, { required: true, cases: [1] });
  exportTo(copy, root, commit, 'alpha');
  const dir = componentRoot(root, 'alpha');
  fs.writeFileSync(path.join(dir, 'fixtures/toy/v1/extra.json'), '{}\n');
  assert.throws(() => copy.checkCopies(root), /unexpected files: extra.json/);
  fs.rmSync(path.join(dir, 'fixtures/toy/v1'), { recursive: true });
  assert.throws(() => copy.checkCopies(root), /directory .* is missing/);
  fs.rmSync(dir, { recursive: true });
  const beta = componentRoot(root, 'beta');
  fs.mkdirSync(beta, { recursive: true });
  git(beta, 'init', '-q');
  fs.writeFileSync(path.join(beta, 'ci.yml'), 'lock: Tests/toy.lock.json\n');
  git(beta, 'add', '-A');
  assert.throws(() => copy.checkCopies(root), /beta: the component references toy.lock.json but has no copy/);
  fs.rmSync(path.join(beta, 'ci.yml'));
  git(beta, 'add', '-A');
  assert.match(copy.checkCopies(root).report, /beta: pre-adoption pin; conformance not claimed/);
});

test('commit: export refuses uncommitted canonical bytes without writing', (t) => {
  const root = scratch(t);
  const copy = commitCopy();
  const commit = commitToy(root, { required: true, cases: [1] });
  fs.writeFileSync(path.join(root, SOURCE, 'data.json'), jsonBytes({ required: true, cases: [5] }));
  assert.throws(() => exportTo(copy, root, commit, 'alpha'), /differs from source commit/);
  assert.equal(fs.existsSync(componentRoot(root, 'alpha')), false);
});

test('revision: current passes, behind warns, ahead or same-revision drift fails', (t) => {
  const root = scratch(t);
  const copy = revisionCopy();
  commitToy(root, { revision: 2, cases: [1, 2] }, REVISION_SOURCE);
  assert.match(copy.exportCopy({ sourceRoot: root, component: 'alpha', componentRoot: componentRoot(root, 'alpha') }), /exported revision 2/);
  const file = path.join(componentRoot(root, 'alpha'), 'tests/fixtures/toy-routing.json');
  assert.deepEqual(copy.checkCopies(root).warnings, []);
  assert.match(copy.verifyCopy({ sourceRoot: root, component: 'alpha', componentRoot: componentRoot(root, 'alpha') }), /matches/);
  fs.writeFileSync(file, jsonBytes({ revision: 1, cases: [] }));
  const { report, warnings } = copy.checkCopies(root);
  assert.match(report, /alpha: adopted copy behind canonical/);
  assert.match(warnings[0], /revision 1, behind .* \(2\)/);
  for (const [doc, pattern] of [
    [{ revision: 3, cases: [1, 2] }, /ahead of/],
    [{ revision: 2, cases: [1] }, /differs from .* at the same revision 2/],
    [{ cases: [1, 2] }, /no integer revision/],
  ]) {
    fs.writeFileSync(file, jsonBytes(doc));
    assert.throws(() => copy.checkCopies(root), pattern);
  }
  assert.throws(() => copy.exportCopy({ sourceRoot: root, sourceCommit: 'a'.repeat(40), component: 'alpha', componentRoot: root }),
    /takes no source commit/);
});

test('CLI: check emits lagging copies as warnings; revision export rejects --source-commit', (t) => {
  const root = scratch(t);
  const copy = revisionCopy();
  commitToy(root, { revision: 2, cases: [1] }, REVISION_SOURCE);
  const file = path.join(componentRoot(root, 'alpha'), 'tests/fixtures/toy-routing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonBytes({ revision: 1, cases: [] }));
  const warned = [];
  const options = { script: 'toy.mjs', defaultRoot: root, warn: (line) => warned.push(line) };
  assert.match(fixtureCopyMain(copy, ['check'], options), /toy-routing: canonical valid at revision 2/);
  assert.equal(warned.length, 1);
  assert.throws(() => fixtureCopyMain(copy, ['export', '--source-root', root, '--source-commit', 'a'.repeat(40),
    '--component', 'alpha', '--component-root', root], options), /does not accept --source-commit/);
  assert.throws(() => fixtureCopyMain(copy, ['check', '--component', 'alpha'], options), /only accepts --root/);
  assert.throws(() => fixtureCopyMain(commitCopy(), ['verify', '--source-root', root], options), /requires --source-commit/);
  assert.throws(() => fixtureCopyMain(copy, [], options), /usage: toy.mjs/);
});
