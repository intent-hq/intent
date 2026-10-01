import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inspectSources, preflight, runContract } from './test-transfer-selection-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'crates/intent-services/src/transfer_selection_contract.rs';
const EXPORTER = 'scripts/test-transfer-selection-contract.sh';
const RENDERER = 'src/lib/components/chat/input/ModelPicker.transfer-selection-contract.test.ts';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function write(root, file, contents, mode) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, { mode });
}
function commit(root) {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'test: fixture');
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t) {
  const top = mkdtempSync(path.join(os.tmpdir(), 'transfer-runner-test-'));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const root = path.join(top, 'monorepo');
  mkdirSync(root);
  const dirs = Object.fromEntries(['intentd', 'cloudlands-fe'].map((component) => [component, path.join(root, 'packages', component)]));
  for (const dir of [root, ...Object.values(dirs)]) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--quiet');
  }
  cpSync(path.join(ROOT, 'docs/protocol/fixtures/transfer-selection'), path.join(root, 'docs/protocol/fixtures/transfer-selection'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['check-transfer-selection-contract.mjs', 'test-transfer-selection-contract.mjs']) cpSync(path.join(ROOT, 'scripts', file), path.join(root, 'scripts', file));
  write(dirs.intentd, GENERATOR, '// synthetic orchestration fixture, never a public golden\n');
  write(dirs.intentd, EXPORTER, '#!/bin/bash\nset -euo pipefail\nnode "$FIXTURE_EMITTER" "$@"\n');
  write(dirs['cloudlands-fe'], RENDERER, '// renderer invocation is observed by the fixture corepack executable\n');
  write(dirs['cloudlands-fe'], 'scripts/transfer-selection-fixtures.mjs', '// fixture loader marker\n');
  const pins = Object.fromEntries(Object.entries(dirs).map(([name, dir]) => [name, commit(dir)]));
  for (const [name, pin] of Object.entries(pins)) git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},packages/${name}`);
  commit(root);
  write(top, 'emit.mjs', `
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const env = process.env;
if (env.FIXTURE_MODE === 'wait') { console.log('fixture exporter ready'); await new Promise(() => { setInterval(() => {}, 1000); }); }
if (env.FIXTURE_MODE === 'export-fail') process.exit(23);
if (env.FIXTURE_MODE === 'no-output') process.exit(0);
const root = env.TRANSFER_SELECTION_FIXTURE_ROOT;
const artifact = JSON.parse(readFileSync(root + '/public-sessions.json', 'utf8'));
const { hashJson } = createRequire(import.meta.url)(root + '/../../../../scripts/check-transfer-selection-contract.mjs');
if (env.FIXTURE_MODE !== 'stale') artifact.provenance.intentdRevision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
artifact.provenance.generatorSha256 = createHash('sha256').update(readFileSync('${GENERATOR}')).digest('hex');
if (env.FIXTURE_MODE === 'wrong-generator') artifact.provenance.generatorSha256 = 'f'.repeat(64);
if (env.FIXTURE_MODE === 'drift') { artifact.cases[0].session.extraField = 'unreviewed'; artifact.provenance.payloadSha256 = hashJson(artifact.cases); }
if (env.FIXTURE_MODE === 'tamper') artifact.cases[0].session.provider = 'acp';
writeFileSync(process.argv[3], JSON.stringify(artifact));
`);
  write(top, 'bin/corepack', `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.TRANSFER_SELECTION_GENERATED;
fs.writeFileSync(process.env.FIXTURE_RENDER_LOG, JSON.stringify({argv:process.argv.slice(2),file,artifact:JSON.parse(fs.readFileSync(file,'utf8'))}));
if (process.env.FIXTURE_MODE === 'render-fail') process.exit(31);
if (process.env.FIXTURE_MODE === 'render-mutation') fs.appendFileSync(file, ' ');
`, 0o755);
  mkdirSync(path.join(top, 'tmp'));
  const env = { ...process.env, PATH: `${top}/bin:${process.env.PATH}`, TMPDIR: path.join(top, 'tmp'), FIXTURE_EMITTER: path.join(top, 'emit.mjs'), FIXTURE_RENDER_LOG: path.join(top, 'render.json') };
  for (const key of ['COMPONENT', 'HEAD_SHA', 'TRANSFER_SELECTION_FIXTURE_ROOT', 'TRANSFER_SELECTION_GENERATED']) delete env[key];
  return { top, root, dirs, pins, env };
}

test('local gate generates twice, routes exact fresh input, reports provenance and cleans up', async (t) => {
  const f = fixture(t);
  const before = git(f.root, 'status', '--porcelain');
  const golden = hash(path.join(f.root, 'docs/protocol/fixtures/transfer-selection/public-sessions.json'));
  const result = await runContract({ root: f.root, env: f.env, log: () => {} });
  const rendered = JSON.parse(readFileSync(f.env.FIXTURE_RENDER_LOG, 'utf8'));
  assert.deepEqual(rendered.argv, ['pnpm', 'run', 'test:unit', RENDERER]);
  assert.equal(rendered.file, result.consumed.path);
  assert.equal(rendered.artifact.provenance.intentdRevision, f.pins.intentd);
  assert.equal(result.sources.monorepo, git(f.root, 'rev-parse', 'HEAD'));
  assert.equal(result.sources.mode, 'local-selected-checkouts');
  assert.deepEqual(readdirSync(f.env.TMPDIR), []);
  assert.equal(hash(path.join(f.root, 'docs/protocol/fixtures/transfer-selection/public-sessions.json')), golden);
  assert.equal(git(f.root, 'status', '--porcelain'), before);
});

for (const component of ['intentd', 'cloudlands-fe']) {
  test(`${component} caller head is tested with the recorded counterpart pin`, async (t) => {
    const f = fixture(t);
    write(f.dirs[component], 'new-head', 'caller PR revision\n');
    const head = commit(f.dirs[component]);
    const env = { ...f.env, COMPONENT: component, HEAD_SHA: head };
    const result = await runContract({ root: f.root, env, log: () => {} });
    assert.equal(result.sources.mode, 'caller-head-counterpart-pin');
    assert.equal(result.sources.components[component].head, head);
    assert.notEqual(head, f.pins[component]);
    const other = component === 'intentd' ? 'cloudlands-fe' : 'intentd';
    assert.equal(result.sources.components[other].head, f.pins[other]);
    assert.throws(() => inspectSources(f.root, { ...env, HEAD_SHA: f.pins[component] }), /caller HEAD_SHA/);
    write(f.dirs[other], 'not-the-pin', 'wrong counterpart\n');
    commit(f.dirs[other]);
    assert.throws(() => inspectSources(f.root, env), /monorepo pin/);
  });
}

for (const [mode, message] of [
  ['export-fail', /failed \(23\)/], ['no-output', /required fixture/],
  ['stale', /intentdRevision/], ['wrong-generator', /generatorSha256/],
  ['drift', /fresh.*(differ|match)|drift/i], ['tamper', /Sha256|provider/],
  ['render-fail', /failed \(31\)/], ['render-mutation', /renderer modified/],
]) {
  test(`fails and cleans up on ${mode}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(runContract({ root: f.root, env: { ...f.env, FIXTURE_MODE: mode }, log: () => {} }), message);
    assert.deepEqual(readdirSync(f.env.TMPDIR), []);
    assert.equal(git(f.root, 'status', '--porcelain'), '');
    if (!mode.startsWith('render')) assert.equal(readdirSync(f.top).includes('render.json'), false);
  });
}

test('missing or deleted required harnesses cannot silently disable the gate', async (t) => {
  for (const [component, files] of [['intentd', [EXPORTER, GENERATOR]], ['cloudlands-fe', [RENDERER, 'scripts/transfer-selection-fixtures.mjs']]]) {
    for (const file of files) {
      const f = fixture(t);
      rmSync(path.join(f.dirs[component], file));
      commit(f.dirs[component]);
      await assert.rejects(preflight(f.root, f.env), /required transfer-selection harness/);
      assert.deepEqual(readdirSync(f.env.TMPDIR), []);
    }
  }
});

test('refuses dirty source, wrong contract root, stale input override and invalid routing', async (t) => {
  const f = fixture(t);
  for (const overrides of [{ TRANSFER_SELECTION_FIXTURE_ROOT: '' }, { TRANSFER_SELECTION_FIXTURE_ROOT: f.top }, { TRANSFER_SELECTION_GENERATED: '' }, { TRANSFER_SELECTION_GENERATED: '/old.json' }, { COMPONENT: 'ios', HEAD_SHA: f.pins.intentd }, { COMPONENT: 'intentd', HEAD_SHA: 'main' }]) {
    await assert.rejects(preflight(f.root, { ...f.env, ...overrides }));
  }
  write(f.dirs.intentd, 'uncommitted', 'dirty\n');
  await assert.rejects(preflight(f.root, f.env), /clean and committed/);
});

test('missing or altered shared input fails before compiling or rendering', async (t) => {
  for (const file of ['contract.json', 'public-sessions.json']) {
    const f = fixture(t);
    rmSync(path.join(f.root, 'docs/protocol/fixtures/transfer-selection', file));
    await assert.rejects(runContract({ root: f.root, env: f.env }), /required fixture/);
    assert.deepEqual(readdirSync(f.env.TMPDIR), []);
  }
  const f = fixture(t);
  const contractPath = path.join(f.root, 'docs/protocol/fixtures/transfer-selection/contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  contract.cases[0].sourceProvider = 'unexpected-provider';
  writeFileSync(contractPath, JSON.stringify(contract));
  await assert.rejects(runContract({ root: f.root, env: f.env }), /sourceProvider/);
  assert.deepEqual(readdirSync(f.env.TMPDIR), []);
});

test('SIGTERM stops the exporter and cleans the enclosing temporary directory', { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, [path.join(f.root, 'scripts/test-transfer-selection-contract.mjs')], { env: { ...f.env, FIXTURE_MODE: 'wait' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stopped = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!stopped && output.includes('fixture exporter ready')) { stopped = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', () => {});
  t.after(() => child.kill('SIGKILL'));
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  assert.equal(code, 1);
  assert.match(output, /transfer-selection cleaned:/);
  assert.deepEqual(readdirSync(f.env.TMPDIR), []);
});
