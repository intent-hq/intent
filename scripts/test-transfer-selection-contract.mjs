#!/usr/bin/env node
// This connected gate is activated only after both automated pins have harnesses.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFixtures } from './check-transfer-selection-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'crates/intent-services/src/transfer_selection_contract.rs';
const EXPORTER = 'scripts/test-transfer-selection-contract.sh';
const RENDERER = 'src/lib/components/chat/input/ModelPicker.transfer-selection-contract.test.ts';
const LOADER = 'scripts/transfer-selection-fixtures.mjs';
const COMPONENTS = ['intentd', 'cloudlands-fe'];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function required(root, file) {
  assert.ok(existsSync(path.join(root, file)), `required transfer-selection harness/input missing: ${path.join(root, file)}; activate only after both automated pins contain the harnesses`);
}

export function inspectSources(root, env = process.env) {
  const sources = {
    monorepo: git(root, 'rev-parse', 'HEAD'),
    monorepoDirty: git(root, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all') !== '',
    mode: 'local-selected-checkouts',
    components: {},
  };
  for (const component of COMPONENTS) {
    const dir = path.join(root, 'packages', component);
    required(dir, '.git'); // Prevent git from accidentally resolving the parent repo.
    const tree = git(root, 'ls-tree', 'HEAD', `packages/${component}`);
    const pin = /^160000 commit ([a-f0-9]{40})\t/.exec(tree)?.[1];
    assert.ok(pin, `missing recorded gitlink for ${component}`);
    sources.components[component] = { head: git(dir, 'rev-parse', 'HEAD'), pin };
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '', `${component} must be clean and committed`);
  }
  if (env.COMPONENT !== undefined || env.HEAD_SHA !== undefined) {
    assert.ok(COMPONENTS.includes(env.COMPONENT), 'COMPONENT must be intentd or cloudlands-fe');
    assert.match(env.HEAD_SHA ?? '', /^[a-f0-9]{40}$/, 'HEAD_SHA must be the full caller commit');
    sources.mode = 'caller-head-counterpart-pin';
    sources.caller = env.COMPONENT;
    for (const component of COMPONENTS) {
      const { head, pin } = sources.components[component];
      assert.equal(head, component === env.COMPONENT ? env.HEAD_SHA : pin, `wrong ${component} checkout: expected ${component === env.COMPONENT ? 'caller HEAD_SHA' : 'monorepo pin'}`);
    }
  }
  return sources;
}

export async function preflight(root = ROOT, env = process.env) {
  const sources = inspectSources(root, env);
  for (const file of [GENERATOR, EXPORTER]) required(path.join(root, 'packages/intentd'), file);
  for (const file of [RENDERER, LOADER]) required(path.join(root, 'packages/cloudlands-fe'), file);
  const fixtureRoot = path.join(root, 'docs/protocol/fixtures/transfer-selection');
  if (env.TRANSFER_SELECTION_FIXTURE_ROOT !== undefined) {
    assert.ok(env.TRANSFER_SELECTION_FIXTURE_ROOT.trim(), 'TRANSFER_SELECTION_FIXTURE_ROOT must not be empty');
    assert.equal(realpathSync(env.TRANSFER_SELECTION_FIXTURE_ROOT), realpathSync(fixtureRoot), 'fixtures and validator must belong to this monorepo checkout');
  }
  assert.equal(env.TRANSFER_SELECTION_GENERATED, undefined, 'connected gate generates its own fresh input; unset TRANSFER_SELECTION_GENERATED');
  await inspectFixtures({ fixtureRoot });
  sources.generatorSha256 = sha256(path.join(root, 'packages/intentd', GENERATOR));
  return { sources, fixtureRoot };
}

function run(command, args, cwd, env, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    const abort = () => {
      if (child.pid) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.on('error', reject);
    child.on('close', (code, killed) => {
      signal.removeEventListener('abort', abort);
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${killed ?? code})`));
    });
  });
}

export async function runContract({ root = ROOT, env = process.env, log = console.log, signal = new AbortController().signal } = {}) {
  const { sources, fixtureRoot } = await preflight(root, env);
  log(`transfer-selection sources: ${JSON.stringify(sources)}`);
  const golden = path.join(fixtureRoot, 'public-sessions.json');
  const goldenHash = sha256(golden);
  const scratch = mkdtempSync(path.join(env.TMPDIR || os.tmpdir(), 'transfer-selection-'));
  log(`transfer-selection temporary directory: ${scratch}`);
  try {
    // Enclose Rust test state and Node caches as well as generated response files.
    const childEnv = { ...env, TMPDIR: scratch, NODE_COMPILE_CACHE: path.join(scratch, 'node-cache'), TRANSFER_SELECTION_FIXTURE_ROOT: fixtureRoot };
    const freshFiles = [1, 2].map((i) => path.join(scratch, `fresh-${i}.json`));
    for (const fresh of freshFiles) {
      await run('bash', [EXPORTER, '--output', fresh], path.join(root, 'packages/intentd'), childEnv, signal);
      // A caller cannot turn the gate green with a no-op/missing exporter.
      log(await inspectFixtures({ fixtureRoot, fresh, intentdRevision: sources.components.intentd.head, generatorSha256: sources.generatorSha256 }));
    }
    const artifact = JSON.parse(readFileSync(freshFiles[0], 'utf8'));
    const second = JSON.parse(readFileSync(freshFiles[1], 'utf8'));
    assert.equal(artifact.provenance.payloadSha256, second.provenance.payloadSha256, 'generation must be repeatable');
    const consumed = { path: freshFiles[0], sha256: sha256(freshFiles[0]), payloadSha256: artifact.provenance.payloadSha256 };
    log(`transfer-selection renderer input: ${JSON.stringify(consumed)}`);
    await run('corepack', ['pnpm', 'run', 'test:unit', RENDERER], path.join(root, 'packages/cloudlands-fe'), { ...childEnv, TRANSFER_SELECTION_GENERATED: freshFiles[0] }, signal);
    assert.equal(sha256(freshFiles[0]), consumed.sha256, 'renderer modified the generated input');
    assert.equal(sha256(golden), goldenHash, 'connected proof must not rewrite the golden');
    assert.deepEqual(await preflight(root, env), { sources, fixtureRoot }, 'source checkouts changed during the connected proof');
    log(`transfer-selection passed: ${JSON.stringify({ sources, consumed })}`);
    return { sources, consumed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    log(`transfer-selection cleaned: ${scratch}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--preflight'), 'usage: test-transfer-selection-contract.mjs [--preflight]');
    if (process.argv[2] === '--preflight') console.log(JSON.stringify(await preflight(), null, 2));
    else await runContract({ signal: controller.signal });
  } catch (error) {
    console.error(`transfer-selection: ${error.message}`);
    process.exitCode = 1;
  }
}
