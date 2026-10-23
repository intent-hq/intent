import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CONSUMERS, MIRRORS, REQUIRED_CASES, SOURCE_PATH, checkConsumers, exportMirror, jsonBytes, main,
  normalizeCleaned, readCases, validateCases, verifyMirror,
} from './suggested-prompts-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMIT = 'a'.repeat(40);
const canonical = () => structuredClone(readCases(path.join(ROOT, SOURCE_PATH)).doc);
const byId = (doc, id) => doc.cases.find((c) => c.id === id);

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggested-prompts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSource(root, doc) {
  const dir = path.join(root, SOURCE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cases.json'), jsonBytes(doc));
}

const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t',
  '-c', 'commit.gpgsign=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A monorepo-shaped git checkout whose HEAD commits `doc`; returns the commit. */
function commitSource(root, doc) {
  if (!fs.existsSync(path.join(root, '.git'))) git(root, 'init', '-q');
  writeSource(root, doc);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'cases');
  return git(root, 'rev-parse', 'HEAD');
}

test('canonical cases are valid and cover every required case', () => {
  const { doc } = readCases(path.join(ROOT, SOURCE_PATH));
  const ids = doc.cases.map((c) => c.id);
  for (const id of REQUIRED_CASES) assert.ok(ids.includes(id), id);
  assert.match(main(['validate']), /cases valid: \d+ cases sha256 [0-9a-f]{64}/);
});

test('the escaped incident reply strips the block and decodes its prompts', () => {
  const reply = byId(canonical(), 'escaped-failover-reply');
  assert.ok(reply.input.includes('&lt;!-- suggested-prompts'));
  assert.equal(reply.expect.blockStripped, true);
  assert.equal(reply.expect.cleaned, 'Report back when the PR is ready to merge.');
  assert.ok(reply.expect.prompts.includes("Raise Type Check & Lint's timeout to 45 minutes."));
});

test('normalizeCleaned folds CRLF, trims and collapses only runs of three or more line feeds', () => {
  assert.equal(normalizeCleaned('  a\n\n\n\nb\n'), 'a\n\nb');
  assert.equal(normalizeCleaned('a\nb\n\nc'), 'a\nb\n\nc');
  assert.equal(normalizeCleaned('a\r\n\r\n\r\nb\r\n'), 'a\n\nb');
});

const mutations = {
  'duplicate id': (doc) => { doc.cases[1].id = doc.cases[0].id; },
  'non-kebab id': (doc) => { doc.cases[0].id = 'Plain Prompts'; },
  'blank origin': (doc) => { doc.cases[0].origin = ' '; },
  'unknown case key': (doc) => { doc.cases[0].note = 'x'; },
  'more than four prompts': (doc) => { byId(doc, 'cap-at-four').expect.prompts.push('Prompt 5'); },
  'untrimmed prompt': (doc) => { byId(doc, 'plain-prompts').expect.prompts[0] = ' Run tests'; },
  'non-normalized cleaned': (doc) => { byId(doc, 'plain-prompts').expect.cleaned += '\n'; },
  'prompts without a block': (doc) => { byId(doc, 'no-block').expect.prompts = ['x']; },
  'unstripped text changed': (doc) => { byId(doc, 'no-block').expect.cleaned = 'x'; },
  'stripped block leaves text unchanged': (doc) => {
    const c = byId(doc, 'plain-prompts');
    c.expect.cleaned = normalizeCleaned(c.input);
  },
  'unknown divergence consumer': (doc) => { doc.cases[0].divergences = { android: 'x' }; },
  'divergence without reason': (doc) => { doc.cases[0].divergences = { ios: ' ' }; },
  'empty divergences': (doc) => { doc.cases[0].divergences = {}; },
  'missing required case': (doc) => { doc.cases = doc.cases.filter((c) => c.id !== 'escaped-failover-reply'); },
  'consumer list changed': (doc) => { doc.consumers = ['cloudlands-fe']; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const doc = canonical();
    mutate(doc);
    assert.throws(() => validateCases(doc));
  });
}

test('accepts a documented divergence', () => {
  const doc = canonical();
  doc.cases[0].divergences = { intentd: 'The daemon preview only checks stripping.' };
  assert.doesNotThrow(() => validateCases(doc));
});

test('rejects non-canonical formatting', (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, SOURCE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(canonical()));
  assert.throws(() => readCases(dir), /formatted/);
});

test('export then verify round-trips for every consumer', (t) => {
  const root = tempRoot(t);
  const commit = commitSource(root, canonical());
  for (const component of CONSUMERS) {
    const componentRoot = path.join(root, 'packages', component);
    const options = { sourceRoot: root, sourceCommit: commit, component, componentRoot };
    assert.match(exportMirror(options), /exported/);
    assert.match(verifyMirror(options), new RegExp(`match intent-hq/intent@${commit}`));
  }
  const report = checkConsumers(root);
  for (const component of CONSUMERS) assert.match(report, new RegExp(`${component}: adopted mirror valid at ${commit}, current`));
});

test('export refuses uncommitted cases, a non-HEAD commit and a bad commit without writing anything', (t) => {
  const root = tempRoot(t);
  const doc = canonical();
  const commit = commitSource(root, doc);
  const componentRoot = path.join(tempRoot(t), 'ios');
  const mirrorDir = path.join(componentRoot, MIRRORS.ios.directory);
  assert.throws(() => exportMirror({ sourceRoot: root, sourceCommit: 'abc', component: 'ios', componentRoot }), /40-character/);
  assert.throws(() => exportMirror({ sourceRoot: root, sourceCommit: COMMIT, component: 'ios', componentRoot }), /HEAD must equal/);
  assert.throws(() => exportMirror({ sourceRoot: root, sourceCommit: commit, component: 'constructor', componentRoot }), /unknown component/);
  byId(doc, 'plain-prompts').expect.cleaned = 'Some message.';
  writeSource(root, doc);
  assert.throws(() => exportMirror({ sourceRoot: root, sourceCommit: commit, component: 'ios', componentRoot }), /differs from source commit/);
  assert.equal(fs.existsSync(mirrorDir), false);
});

test('a mirror whose expected value was edited fails verify and check', (t) => {
  const root = tempRoot(t);
  const commit = commitSource(root, canonical());
  const componentRoot = path.join(root, 'packages', 'cloudlands-fe');
  const options = { sourceRoot: root, sourceCommit: commit, component: 'cloudlands-fe', componentRoot };
  exportMirror(options);
  const file = path.join(componentRoot, MIRRORS['cloudlands-fe'].directory, 'cases.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  byId(edited, 'plain-prompts').expect.prompts = ['Run tests'];
  fs.writeFileSync(file, jsonBytes(edited));
  assert.throws(() => verifyMirror(options), /SHA-256 vs lock/);
  assert.throws(() => checkConsumers(root), /SHA-256 vs lock/);
});

test('a re-locked mirror that disagrees with the canonical commit fails verify', (t) => {
  const root = tempRoot(t);
  const doc = canonical();
  const commit = commitSource(root, doc);
  const componentRoot = path.join(tempRoot(t), 'ios');
  const forked = structuredClone(doc);
  byId(forked, 'plain-prompts').expect.cleaned = 'Some message.';
  const forkRoot = tempRoot(t);
  const forkCommit = commitSource(forkRoot, forked);
  exportMirror({ sourceRoot: forkRoot, sourceCommit: forkCommit, component: 'ios', componentRoot });
  const lockFile = path.join(componentRoot, MIRRORS.ios.lock);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, jsonBytes({ ...lock, sourceCommit: commit }));
  assert.throws(
    () => verifyMirror({ sourceRoot: root, sourceCommit: commit, component: 'ios', componentRoot }),
    /mirror provenance/,
  );
});

test('check reports an older copy as behind even when today\'s rules would reject it', (t) => {
  const root = tempRoot(t);
  const doc = canonical();
  doc.cases = doc.cases.filter((c) => c.id !== 'plain-prompts');
  const old = structuredClone(doc);
  const oldCommit = commitSource(root, old);
  const componentRoot = path.join(root, 'packages', 'intentd');
  fs.mkdirSync(componentRoot, { recursive: true });
  const options = { sourceRoot: root, sourceCommit: oldCommit, component: 'intentd', componentRoot };
  assert.throws(() => exportMirror(options), /required case plain-prompts/);
  const mirrorDir = path.join(componentRoot, MIRRORS.intentd.directory);
  fs.mkdirSync(mirrorDir, { recursive: true });
  const bytes = jsonBytes(old);
  fs.writeFileSync(path.join(mirrorDir, 'cases.json'), bytes);
  fs.writeFileSync(path.join(componentRoot, MIRRORS.intentd.lock), jsonBytes({
    lockVersion: 1, sourceRepository: 'intent-hq/intent', sourcePath: SOURCE_PATH, sourceCommit: oldCommit,
    casesSha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  commitSource(root, canonical());
  assert.match(checkConsumers(root), new RegExp(`intentd: adopted mirror valid at ${oldCommit}, behind canonical`));
});

test('check rejects a copy locked to a commit off the canonical history', (t) => {
  const root = tempRoot(t);
  const base = commitSource(root, canonical());
  git(root, 'checkout', '-q', '-b', 'side');
  const side = structuredClone(canonical());
  byId(side, 'plain-prompts').expect.cleaned = 'Some message.';
  const sideCommit = commitSource(root, side);
  const componentRoot = path.join(root, 'packages', 'ios');
  exportMirror({ sourceRoot: root, sourceCommit: sideCommit, component: 'ios', componentRoot });
  git(root, 'checkout', '-q', base);
  assert.throws(() => checkConsumers(root), /not on this checkout's history/);
});

test('check fails on a half-deleted mirror, stray files, a dangling symlink and a malformed lock', (t) => {
  const root = tempRoot(t);
  const commit = commitSource(root, canonical());
  const componentRoot = path.join(root, 'packages', 'intentd');
  exportMirror({ sourceRoot: root, sourceCommit: commit, component: 'intentd', componentRoot });
  const stray = path.join(componentRoot, MIRRORS.intentd.directory, 'extra.json');
  fs.writeFileSync(stray, '{}');
  assert.throws(() => checkConsumers(root), /unexpected files/);
  fs.rmSync(stray);
  const lockFile = path.join(componentRoot, MIRRORS.intentd.lock);
  const lockBytes = fs.readFileSync(lockFile);
  fs.writeFileSync(lockFile, '<<<<<<< HEAD\n');
  assert.throws(() => checkConsumers(root), /suggested-prompts\.lock\.json: invalid JSON/);
  fs.rmSync(lockFile);
  assert.throws(() => checkConsumers(root), /lock .* is missing/);
  fs.writeFileSync(lockFile, lockBytes);
  fs.rmSync(path.join(componentRoot, MIRRORS.intentd.directory), { recursive: true });
  fs.rmSync(lockFile);
  fs.symlinkSync(path.join(root, 'nowhere.json'), lockFile);
  assert.throws(() => checkConsumers(root), /lock .* is missing or not a regular file/);
});

test('check reports components without a mirror as pre-adoption', (t) => {
  const root = tempRoot(t);
  commitSource(root, canonical());
  fs.mkdirSync(path.join(root, 'packages', 'cloudlands-fe', '.git'), { recursive: true });
  const report = checkConsumers(root);
  assert.match(report, /cloudlands-fe: pre-adoption pin/);
  assert.match(report, /ios: uninspected \(checkout uninitialized; private\/optional\)/);
});

test('main requires every export/verify option', (t) => {
  const root = tempRoot(t);
  assert.throws(() => main(['verify', '--source-root', root]), /requires --source-commit/);
  assert.throws(() => main(['validate', '--component', 'ios']), /only accepts --root/);
});
