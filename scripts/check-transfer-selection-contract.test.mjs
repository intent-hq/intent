import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertContract,
  assertFresh,
  assertGenerated,
  hashJson,
  inspectFixtures,
  normalizeCases,
  resolveFixtureRoot,
} from './check-transfer-selection-contract.mjs';
import { cleanNodeEnv } from './test-env.mjs';

const root = fileURLToPath(new URL('../docs/protocol/fixtures/transfer-selection/', import.meta.url));
const script = fileURLToPath(new URL('./check-transfer-selection-contract.mjs', import.meta.url));
const contract = JSON.parse(await fs.readFile(path.join(root, 'contract.json'), 'utf8'));

// Internal schema fixture only. These objects have NEVER been emitted by a daemon
// and must not be copied to the shared public-sessions.json golden.
function syntheticGenerated() {
  const cases = contract.cases.map((c) => {
    const selection = contract.expectations[c.expectation].selection;
    return {
      id: c.id,
      session: {
        id: 'synthetic-agent', workspaceId: 'synthetic-workspace', name: 'Synthetic',
        nameExplicitlySet: false, provider: selection.provider,
        ...(selection.model === null ? {} : { model: selection.model }),
        ...(selection.reasoningEffort === null ? {} : { reasoningEffort: selection.reasoningEffort }),
        status: 'idle', isActive: false, messages: [], notificationsMuted: false,
        harnessVersion: 'synthetic', harnessFeatures: { synthetic: true },
        createdAt: '2026-09-24T10:00:00Z', updatedAt: '2026-09-24T10:01:00Z',
      },
      persisted: { ...c.expectedPersistedSelection, ...c.expectedRawHistory },
      firstTurn: { ...contract.expectations[c.expectation].firstTurn },
    };
  });
  const normalized = normalizeCases(cases);
  return {
    formatVersion: 1, normalizationVersion: 1,
    provenance: {
      kind: 'intentd-public-import', generator: 'intent-services/transfer-selection-contract',
      intentdRevision: 'a'.repeat(40), intentdDirty: false,
      generatorSha256: hashJson({ internalSyntheticFixture: true }),
      contractSha256: hashJson(contract), payloadSha256: hashJson(normalized),
    },
    cases: normalized,
  };
}

function rehash(artifact) {
  artifact.provenance.payloadSha256 = hashJson(artifact.cases);
  return artifact;
}

async function fixture(t, generated = syntheticGenerated()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-selection-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'contract.json'), JSON.stringify(contract));
  if (generated) await fs.writeFile(path.join(dir, 'public-sessions.json'), JSON.stringify(generated));
  return dir;
}

test('the maintained inputs cover all 32 stable cases', () => {
  assertContract(contract);
  const expected = ['auggie', 'acp', 'augment', 'default'].flatMap((provider) =>
    ['direct', 'history', 'prefix', 'auto'].flatMap((mode) =>
      [true, false].map((enabled) => `${provider}:${mode}:codex=${enabled}`)));
  assert.deepEqual(contract.cases.map((c) => c.id), expected);
});

for (const [name, change, error] of [
  ['missing case', (c) => c.cases.pop(), /32 cases/],
  ['duplicate case', (c) => { c.cases[1] = c.cases[0]; }, /duplicate case/],
  ['unstable case id', (c) => { c.cases[0].id = 'renamed'; }, /case id/],
  ['unknown mode', (c) => { c.cases[0].mode = 'unknown'; }, /mode/],
  ['wrong enabled type', (c) => { c.cases[0].codexEnabled = 'true'; }, /codexEnabled/],
  ['changed defaults', (c) => { c.destinationDefaults.provider = 'auggie'; }, /destinationDefaults/],
  ['source absent from catalog', (c) => { c.providersCatalog.providers.shift(); }, /providersCatalog/],
  ['unsupported source effort', (c) => { c.models.auggie[0].effortLevels = ['high']; }, /models/],
  ['renamed source model', (c) => { c.models.auggie[0].id = 'gpt-6-astra'; }, /models/],
  ['changed source input', (c) => { c.cases[0].input.provider = 'codex'; }, /input/],
  ['missing raw input history', (c) => { delete c.cases[0].input.last_turn_provider; }, /input/],
  ['normalized expected history', (c) => { c.cases[8].expectedRawHistory.last_turn_provider = 'auggie'; }, /expectedRawHistory/],
  ['altered explicit selection', (c) => { c.expectations.explicit.selection.reasoningEffort = 'high'; }, /expectations/],
  ['Auto given a model', (c) => { c.expectations.auto.selection.model = 'gpt6-astra'; }, /expectations/],
  ['Auto assigned explicit expectation', (c) => { c.cases[6].expectation = 'explicit'; }, /expectation/],
  ['wrong first-turn expectation', (c) => { c.expectations.auto.firstTurn.provider = 'codex'; }, /expectations/],
  ['warning expectation relaxed', (c) => { c.expectations.explicit.renderer.warning = true; }, /expectations/],
  ['canonical prefix spelling lost', (c) => { c.cases[4].expectedPersistedSelection.model = 'gpt6-astra'; }, /expectedPersistedSelection/],
  ['unknown input field', (c) => { c.cases[0].inputs = {}; }, /keys/],
  ['unknown format version', (c) => { c.formatVersion = 2; }, /formatVersion/],
]) {
  test(`inputs reject ${name}`, () => {
    const changed = structuredClone(contract);
    change(changed);
    assert.throws(() => assertContract(changed), error);
  });
}

test('synthetic envelope exercises schema only, including omitted Auto fields', () => {
  const generated = syntheticGenerated();
  assertGenerated(contract, generated);
  assertFresh(contract, generated, structuredClone(generated));
  assert.equal(Object.hasOwn(generated.cases[6].session, 'model'), false);
  assert.equal(Object.hasOwn(generated.cases[6].session, 'reasoningEffort'), false);
});

for (const [name, change, error] of [
  ['historical public alias regression', (a) => { a.cases[8].session.provider = 'acp'; }, /session.provider/],
  ['public prefixed model regression', (a) => { a.cases[12].session.model = 'acp:gpt6-astra'; }, /session.model/],
  ['destination effort leakage', (a) => { a.cases[0].session.reasoningEffort = 'high'; }, /reasoningEffort/],
  ['raw history canonicalization', (a) => { a.cases[8].persisted.last_turn_provider = 'auggie'; }, /persisted/],
  ['raw history model loss', (a) => { a.cases[0].persisted.last_turn_model = null; }, /persisted/],
  ['wrong first-turn provider', (a) => { a.cases[0].firstTurn.provider = 'codex'; }, /firstTurn/],
  ['Auto fallback', (a) => { a.cases[6].firstTurn.model = 'gpt-6-astra'; }, /firstTurn/],
  ['null instead of omitted public Auto model', (a) => { a.cases[6].session.model = null; }, /must be omitted/],
  ['null instead of omitted public Auto effort', (a) => { a.cases[6].session.reasoningEffort = null; }, /must be omitted/],
  ['configuration attention', (a) => { a.cases[0].session.attentionRequestKind = 'configuration'; }, /attentionRequestKind/],
  ['stale imported effort levels', (a) => { a.cases[0].session.effortLevels = ['high']; }, /effortLevels/],
  ['invalid public message shape', (a) => { a.cases[0].session.messages = {}; }, /messages/],
  ['live session', (a) => { a.cases[0].session.isActive = true; }, /isActive/],
  ['missing public identity', (a) => { delete a.cases[0].session.id; }, /session.id/],
  ['missing public session', (a) => { delete a.cases[0].session; }, /keys/],
  ['missing output case', (a) => { a.cases.pop(); }, /32 cases/],
  ['duplicate output case', (a) => { a.cases[1] = a.cases[0]; }, /duplicate case/],
  ['unknown output case', (a) => { a.cases[0].id = 'unknown'; }, /case id/],
  ['reordered output', (a) => { a.cases.reverse(); }, /case order/],
  ['unnormalized time', (a) => { a.cases[0].session.updatedAt = '2026-09-24T12:00:00Z'; }, /normalized/],
]) {
  test(`rehashed output still rejects ${name}`, () => {
    const generated = syntheticGenerated();
    change(generated);
    assert.throws(() => assertGenerated(contract, rehash(generated)), error);
  });
}

test('payload tampering fails integrity separately from semantic controls', () => {
  const generated = syntheticGenerated();
  generated.cases[0].session.name = 'Tampered';
  assert.throws(() => assertGenerated(contract, generated), /payloadSha256/);
});

for (const [name, change, error] of [
  ['stale inputs', (a) => { a.provenance.contractSha256 = '0'.repeat(64); }, /contractSha256/],
  ['missing source revision', (a) => { delete a.provenance.intentdRevision; }, /keys/],
  ['short source revision', (a) => { a.provenance.intentdRevision = 'abcdef'; }, /intentdRevision/],
  ['dirty source', (a) => { a.provenance.intentdDirty = true; }, /intentdDirty/],
  ['missing generator identity', (a) => { a.provenance.generator = 'handwritten'; }, /generator/],
  ['invalid generator digest', (a) => { a.provenance.generatorSha256 = 'unknown'; }, /generatorSha256/],
  ['wrong provenance kind', (a) => { a.provenance.kind = 'synthetic'; }, /kind/],
  ['unknown envelope field', (a) => { a.normalized = true; }, /keys/],
  ['wrong normalization version', (a) => { a.normalizationVersion = 2; }, /normalizationVersion/],
]) {
  test(`provenance rejects ${name}`, () => {
    const generated = syntheticGenerated();
    change(generated);
    assert.throws(() => assertGenerated(contract, generated), error);
  });
}

test('fresh output provenance can be bound to the actual checkout and generator', () => {
  const generated = syntheticGenerated();
  assertGenerated(contract, generated, { intentdRevision: 'a'.repeat(40), generatorSha256: generated.provenance.generatorSha256 });
  assert.throws(() => assertGenerated(contract, generated, { intentdRevision: 'b'.repeat(40) }), /intentdRevision/);
  assert.throws(() => assertGenerated(contract, generated, { generatorSha256: 'b'.repeat(64) }), /generatorSha256/);
});

test('normalization changes only four named volatile fields and leaves the input untouched', () => {
  const original = syntheticGenerated().cases;
  const raw = structuredClone(original);
  raw[0].session.id = 'random-agent';
  raw[0].session.workspaceId = 'random-workspace';
  raw[0].session.createdAt = '2026-09-24T13:00:00Z';
  raw[0].session.updatedAt = '2026-09-24T14:00:00Z';
  raw[0].session.extraPath = '/tmp/retain-this-path';
  raw[0].session.extraTimestamp = '2026-09-24T15:00:00Z';
  raw[0].session.extraId = 'retain-this-id';
  original[0].session.extraPath = raw[0].session.extraPath;
  original[0].session.extraTimestamp = raw[0].session.extraTimestamp;
  original[0].session.extraId = raw[0].session.extraId;
  const before = structuredClone(raw);
  assert.deepEqual(normalizeCases(raw), original);
  assert.deepEqual(raw, before);
});

test('normalization cannot repair provider/model/effort/history or invalid dates', () => {
  const raw = syntheticGenerated().cases;
  raw[0].session.provider = 'acp';
  raw[0].session.model = 'acp:gpt6-astra';
  raw[0].session.reasoningEffort = 'high';
  raw[0].persisted.last_turn_model = 'changed-history';
  assert.deepEqual(normalizeCases(raw), raw);
  raw[0].session.createdAt = 'not-a-date';
  assert.throws(() => normalizeCases(raw), /createdAt/);
});

test('normalization rejects impossible calendar dates instead of hiding them', () => {
  const raw = syntheticGenerated().cases;
  raw[0].session.updatedAt = '2026-02-30T12:00:00Z';
  assert.throws(() => normalizeCases(raw), /updatedAt/);
});

test('freshness retains additive public fields and rejects drift even with valid hashes', () => {
  const golden = syntheticGenerated();
  const fresh = structuredClone(golden);
  fresh.provenance.intentdRevision = 'b'.repeat(40);
  assertFresh(contract, golden, fresh);
  fresh.cases[0].session.newField = 'detect additive drift';
  rehash(fresh);
  assertGenerated(contract, fresh);
  assert.throws(() => assertFresh(contract, golden, fresh), /stale.*auggie:direct:codex=true/);
});

test('canonical hashing ignores object key order, preserving arrays and semantic values', () => {
  assert.equal(hashJson({ a: 1, b: { c: 2 } }), hashJson({ b: { c: 2 }, a: 1 }));
  assert.notEqual(hashJson(['acp', 'auggie']), hashJson(['auggie', 'acp']));
  assert.notEqual(hashJson({ model: null }), hashJson({}));
  assert.throws(() => hashJson({ model: undefined }), /JSON/);
});

test('fixture-root precedence is explicit argument, environment, then monorepo default', () => {
  assert.equal(resolveFixtureRoot({ fixtureRoot: '/explicit', env: { TRANSFER_SELECTION_FIXTURE_ROOT: '/env' } }), '/explicit');
  assert.equal(resolveFixtureRoot({ env: { TRANSFER_SELECTION_FIXTURE_ROOT: '/env' } }), '/env');
  assert.equal(resolveFixtureRoot({ env: {} }), path.resolve(root));
});

test('missing required inputs and outputs fail; only explicit inputs-only mode omits output', async (t) => {
  const dir = await fixture(t, null);
  await inspectFixtures({ fixtureRoot: dir, inputsOnly: true });
  await assert.rejects(inspectFixtures({ fixtureRoot: dir }), /required.*public-sessions.json/);
  await fs.rm(path.join(dir, 'contract.json'));
  await assert.rejects(inspectFixtures({ fixtureRoot: dir, inputsOnly: true }), /required.*contract.json/);
});

test('CLI works outside the monorepo and never silently accepts a missing or malformed file', async (t) => {
  const dir = await fixture(t);
  const env = { ...cleanNodeEnv(), TRANSFER_SELECTION_FIXTURE_ROOT: dir };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.match(run().stdout, /freshness not checked/);
  await fs.writeFile(path.join(dir, 'fresh.json'), JSON.stringify(syntheticGenerated()));
  assert.equal(run('--fresh', path.join(dir, 'fresh.json')).status, 0);
  assert.match(run('--fresh', path.join(dir, 'missing.json')).stderr, /required fixture.*missing.json/);
  assert.notEqual(run('--fresh', path.join(dir, 'public-sessions.json')).status, 0);
  await fs.symlink(path.join(dir, 'public-sessions.json'), path.join(dir, 'symlink.json'));
  await fs.link(path.join(dir, 'public-sessions.json'), path.join(dir, 'hardlink.json'));
  assert.notEqual(run('--fresh', path.join(dir, 'symlink.json')).status, 0);
  assert.notEqual(run('--fresh', path.join(dir, 'hardlink.json')).status, 0);
  assert.notEqual(run('--inputs-only', '--fresh', path.join(dir, 'fresh.json')).status, 0);
  await fs.writeFile(path.join(dir, 'public-sessions.json'), '{');
  const malformed = run();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /invalid JSON.*public-sessions.json/);
  await fs.rm(path.join(dir, 'contract.json'));
  const missing = run('--inputs-only');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /required.*contract.json.*TRANSFER_SELECTION_FIXTURE_ROOT/);
});
