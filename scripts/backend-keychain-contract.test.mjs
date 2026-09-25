import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SOURCE_PATH, MIRRORS, jsonBytes, sha256, readCorpus, validateCorpus,
  inspectMirror, checkConsumers, exportFixtures, verifyFixtures,
} from './backend-keychain-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/backend-keychain-contract.mjs');
const canonical = readCorpus(path.join(ROOT, SOURCE_PATH));
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-keychain-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeJson(file, value) { fs.writeFileSync(file, jsonBytes(value)); }
function copyCanonical(root) {
  fs.mkdirSync(path.dirname(path.join(root, SOURCE_PATH)), { recursive: true });
  fs.cpSync(path.join(ROOT, SOURCE_PATH), path.join(root, SOURCE_PATH), { recursive: true });
}
function sourceRepo(t) {
  const sourceRoot = scratch(t);
  copyCanonical(sourceRoot);
  const git = (...args) => execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '.');
  // Isolated fixture history, never a commit in the workspace repository.
  git('-c', 'user.name=Contract Test', '-c', 'user.email=contract@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test: fixture source');
  return { sourceRoot, sourceCommit: git('rev-parse', 'HEAD').trim(), git };
}
function setup(t, component = 'cloudlands-fe') {
  const source = sourceRepo(t);
  const componentRoot = scratch(t);
  const options = { ...source, componentRoot, component };
  exportFixtures(options);
  return { ...options, directory: path.join(componentRoot, MIRRORS[component].directory), lockPath: path.join(componentRoot, MIRRORS[component].lock) };
}
function rewriteCorpus(directory, mutate) {
  const corpus = JSON.parse(fs.readFileSync(path.join(directory, 'corpus.json'), 'utf8'));
  mutate(corpus);
  const bytes = jsonBytes(corpus);
  fs.writeFileSync(path.join(directory, 'corpus.json'), bytes);
  writeJson(path.join(directory, 'manifest.json'), { fixtureFormatVersion: 1, payloadVersion: 1, files: { 'corpus.json': sha256(bytes) } });
}
function rehashLock(options) {
  const lock = JSON.parse(fs.readFileSync(options.lockPath, 'utf8'));
  for (const file of ['corpus.json', 'manifest.json']) lock.files[file] = sha256(fs.readFileSync(path.join(options.directory, file)));
  lock.corpusSha256 = lock.files['corpus.json'];
  writeJson(options.lockPath, lock);
}
function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, DD_TRACE_ENABLED: 'false' } });
}

test('canonical data has independent complete route expectations and separate versions', () => {
  assert.equal(validateCorpus(canonical.corpus), canonical.corpus);
  const lan = canonical.corpus.parseCases.find((c) => c.id === 'live-lan');
  assert.equal(lan.desktop.record.tcAddress, 'tcMiXeD_Case-Address');
  assert.equal(lan.ios.record.tcAddress, 'tcMiXeD_Case-Address');
  assert.equal(canonical.corpus.payloadVersion, 1);
  assert.equal(canonical.corpus.fixtureFormatVersion, 1);
});

test('empty, missing, duplicate, malformed, and incomplete cases fail validation', () => {
  const mutations = [
    [(c) => { c.parseCases = []; }, /missing required case/],
    [(c) => { c.parseCases.push(c.parseCases[0]); }, /duplicate/],
    [(c) => { c.expiryCases.pop(); }, /missing required case live-never-expires/],
    [(c) => { c.parseCases[0].ios = { kind: 'success' }; }, /invalid kind/],
    [(c) => { delete c.parseCases[0].desktop.record.tcAddress; }, /keys/],
    [(c) => { c.parseCases[0].ios.record.tcAddress = 'lowercased'; }, /shared tcAddress/],
    [(c) => { c.parseCases[0].desktop.record.tcAddress = null; c.parseCases[0].ios.record.tcAddress = null; }, /required route/],
    [(c) => { c.parseCases.find((x) => x.id === 'removal-explicit').ios.record.token = 'leak'; }, /scrubbed/],
    [(c) => { c.iosPublishCases[0].expected.writes = []; }, /must exercise a write/],
    [(c) => { delete c.iosPublishCases[0].expected.writes[0].payload.tcAddress; }, /tcAddress missing/],
    [(c) => { c.noWriteCases[0].expected.desktop.upserts = ['write']; }, /no-write expectation/],
    [(c) => { c.iosImportCases[0].parseCaseId = 'missing'; }, /unknown record reference/],
    [(c) => { c.payloadVersion = 2; }, /payloadVersion/],
  ];
  for (const [mutate, pattern] of mutations) {
    const copy = structuredClone(canonical.corpus);
    mutate(copy);
    assert.throws(() => validateCorpus(copy), pattern);
  }
});

test('pre-existing parser differences are scoped to exact operations and fields', () => {
  const copy = structuredClone(canonical.corpus);
  const padded = copy.parseCases.find((c) => c.id === 'route-padded');
  padded.ios.record.host = 'changed';
  assert.throws(() => validateCorpus(copy), /shared host/);
  padded.ios.record.host = padded.desktop.record.host;
  padded.desktop.record.tcAddress = padded.ios.record.tcAddress;
  assert.throws(() => validateCorpus(copy), /desktop route/);
});

test('coverage labels cannot disguise missing routes or wrong edge-case inputs', () => {
  for (const [id, change] of [
    ['live-lan', (p) => { delete p.tcAddress; }],
    ['route-absent', (p) => { p.tcAddress = null; }],
    ['route-number', (p) => { p.tcAddress = '42'; }],
    ['host-absent', (p) => { p.host = 'Mac.Local'; }],
    ['future-version', (p) => { p.v = 1; }],
  ]) {
    const copy = structuredClone(canonical.corpus);
    const c = copy.parseCases.find((c) => c.id === id);
    const payload = JSON.parse(c.payload);
    change(payload);
    c.payload = JSON.stringify(payload);
    assert.throws(() => validateCorpus(copy), /coverage/);
  }
});

for (const component of Object.keys(MIRRORS)) {
  test(`${component}: standalone export is deterministic, offline, byte-identical and verifiable`, (t) => {
    const options = setup(t, component);
    assert.match(verifyFixtures(options), new RegExp(options.sourceCommit));
    const first = fs.readFileSync(options.lockPath);
    exportFixtures(options);
    assert.deepEqual(fs.readFileSync(options.lockPath), first);
    for (const file of ['corpus.json', 'manifest.json']) assert.deepEqual(fs.readFileSync(path.join(options.directory, file)), canonical.files[file]);
    const lock = JSON.parse(first);
    assert.equal(lock.sourceCommit.length, 40);
    assert.equal(lock.corpusSha256, canonical.digest);
    assert.equal(inspectMirror(options.componentRoot, component).digest, canonical.digest);
  });
}

test('all missing, empty, malformed and altered required files fail', (t) => {
  const options = setup(t);
  for (const file of [options.lockPath, ...['corpus.json', 'manifest.json'].map((f) => path.join(options.directory, f))]) {
    const original = fs.readFileSync(file);
    for (const content of [null, '', '{', '{}\n', original.toString().replace(/1/, '9')]) {
      if (content === null) fs.unlinkSync(file); else fs.writeFileSync(file, content);
      assert.throws(() => verifyFixtures(options), /missing|empty|JSON|hashes|keys|Version|provenance/);
      fs.writeFileSync(file, original);
    }
  }
});

test('valid-looking edits plus rehashed mirror and lock still fail provenance', (t) => {
  const options = setup(t);
  rewriteCorpus(options.directory, (c) => { c.identityCases[0].accountKey = 'forged.local:8843'; });
  rehashLock(options);
  // Integrity alone is intentionally distinct from provenance.
  assert.ok(inspectMirror(options.componentRoot, options.component));
  assert.throws(() => verifyFixtures(options), /mirror provenance/);
});

test('source commit must be full, checked out, and contain unchanged exact canonical bytes', (t) => {
  const options = setup(t);
  for (const sourceCommit of ['main', options.sourceCommit.slice(0, 7), '0'.repeat(40)]) {
    assert.throws(() => verifyFixtures({ ...options, sourceCommit }), /40-character|HEAD/);
  }
  rewriteCorpus(path.join(options.sourceRoot, SOURCE_PATH), (c) => { c.identityCases[0].accountKey = 'dirty.local:8843'; });
  assert.throws(() => exportFixtures(options), /differs from source commit/);
});

test('wrong lock source revision/repository/path and unsafe inventories fail', (t) => {
  const options = setup(t);
  const original = JSON.parse(fs.readFileSync(options.lockPath, 'utf8'));
  for (const [key, value] of [['sourceCommit', 'a'.repeat(40)], ['sourceCommit', 'main'], ['sourceRepository', 'other/repo'], ['sourcePath', '../escape']]) {
    writeJson(options.lockPath, { ...original, [key]: value });
    assert.throws(() => verifyFixtures(options), /provenance|sourceCommit|sourceRepository|sourcePath/);
  }
  writeJson(options.lockPath, original);
  fs.writeFileSync(path.join(options.directory, 'unexpected.json'), '{}\n');
  assert.throws(() => verifyFixtures(options), /inventory/);
  assert.throws(() => exportFixtures(options), /unexpected files/);
  fs.unlinkSync(path.join(options.directory, 'unexpected.json'));
  fs.unlinkSync(path.join(options.directory, 'corpus.json'));
  fs.symlinkSync(path.join(options.sourceRoot, SOURCE_PATH, 'corpus.json'), path.join(options.directory, 'corpus.json'));
  assert.throws(() => verifyFixtures(options), /regular/);
  assert.throws(() => exportFixtures(options), /regular/);
});

test('a mirror directory must contain checked-in files, not redirect to another directory', (t) => {
  const options = setup(t);
  fs.rmSync(options.directory, { recursive: true });
  fs.symlinkSync(path.join(options.sourceRoot, SOURCE_PATH), options.directory, 'dir');
  assert.throws(() => verifyFixtures(options), /directory/);
  assert.throws(() => exportFixtures(options), /directory/);
});

test('docs-first check explicitly reports pre-adoption and uninitialized private iOS', (t) => {
  const root = scratch(t);
  copyCanonical(root);
  fs.mkdirSync(path.join(root, 'packages/cloudlands-fe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/cloudlands-fe/.git'), 'gitdir: unused');
  const result = checkConsumers(root);
  assert.match(result, /canonical Keychain corpus valid/);
  assert.match(result, /cloudlands-fe: pre-adoption pin; conformance not claimed/);
  assert.match(result, /ios: uninspected \(checkout uninitialized; private\/optional\); conformance not claimed/);
  fs.writeFileSync(path.join(root, SOURCE_PATH, 'corpus.json'), '{}');
  assert.throws(() => checkConsumers(root), /manifest.files hashes/);
});

test('any adopter requires both lock and mirror; both adopted pins must agree', (t) => {
  const source = sourceRepo(t);
  for (const component of Object.keys(MIRRORS)) exportFixtures({ ...source, component, componentRoot: path.join(source.sourceRoot, 'packages', component) });
  assert.match(checkConsumers(source.sourceRoot), /ios: adopted integrity valid/);
  const component = 'ios';
  const componentRoot = path.join(source.sourceRoot, 'packages', component);
  const lockPath = path.join(componentRoot, MIRRORS.ios.lock);
  const original = fs.readFileSync(lockPath);
  writeJson(lockPath, { ...JSON.parse(original), sourceCommit: 'b'.repeat(40) });
  assert.throws(() => checkConsumers(source.sourceRoot), /conflicting adopted consumer pins/);
  fs.unlinkSync(lockPath);
  assert.throws(() => checkConsumers(source.sourceRoot), /required file missing/);
  fs.writeFileSync(lockPath, original);
  fs.rmSync(path.join(componentRoot, MIRRORS.ios.directory), { recursive: true });
  assert.throws(() => checkConsumers(source.sourceRoot), /required corpus directory missing/);
});

test('adopted digest conflicts fail even when each mirror and its lock are internally valid', (t) => {
  const source = sourceRepo(t);
  for (const component of Object.keys(MIRRORS)) exportFixtures({ ...source, component, componentRoot: path.join(source.sourceRoot, 'packages', component) });
  const componentRoot = path.join(source.sourceRoot, 'packages/ios');
  const options = { directory: path.join(componentRoot, MIRRORS.ios.directory), lockPath: path.join(componentRoot, MIRRORS.ios.lock) };
  rewriteCorpus(options.directory, (c) => { c.identityCases[0].accountKey = 'changed.local:8843'; });
  rehashLock(options);
  assert.throws(() => checkConsumers(source.sourceRoot), /conflicting adopted consumer pins/);
});

test('CLI validates and exports/verifies standalone mirrors, rejects missing/unknown arguments', (t) => {
  const options = setup(t);
  const args = ['--source-root', options.sourceRoot, '--source-commit', options.sourceCommit, '--component-root', options.componentRoot, '--component', options.component];
  for (const command of ['export', 'verify']) {
    const result = cli([command, ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(options.sourceCommit));
  }
  for (const command of ['validate', 'check']) {
    const result = cli([command, '--root', options.sourceRoot]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /canonical Keychain corpus valid/);
  }
  for (const args of [[], ['export'], ['verify', '--root', options.sourceRoot], ['validate', '--unknown'], ['check', '--source-commit', 'main']]) {
    const result = cli(args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /backend-keychain-contract:/);
  }
  fs.unlinkSync(options.lockPath);
  assert.equal(cli(['verify', ...args]).status, 1);
});
