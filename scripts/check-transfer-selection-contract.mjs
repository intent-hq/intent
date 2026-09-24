#!/usr/bin/env node

// Compilation-free validation of the shared transfer-selection test contract.
// Integrity is not provenance proof: the connected gate must freshly generate
// daemon responses and compare them using assertFresh / --fresh.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const PROVIDERS = ['auggie', 'acp', 'augment', 'default'];
const MODES = ['direct', 'history', 'prefix', 'auto'];
const DEFAULT_ROOT = fileURLToPath(new URL('../docs/protocol/fixtures/transfer-selection/', import.meta.url));
const GENERATOR = 'intent-services/transfer-selection-contract';
const TIME = '2000-01-01T00:00:00Z';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function keys(value, names, label) {
  object(value, label);
  equal(Object.keys(value).sort(), names.split(' ').sort(), `${label} keys`);
}

function equal(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function string(value, label) {
  requireValue(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
}

// Object keys sorted recursively, array order preserved, UTF-8 compact JSON,
// no trailing newline. Null and absence are deliberately different.
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('hash input must contain only JSON values');
}

export function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function caseList(cases, label) {
  requireValue(Array.isArray(cases) && cases.length === 32, `${label} must contain exactly 32 cases`);
  const ids = new Set();
  for (const c of cases) {
    object(c, label);
    string(c.id, `${label} case id`);
    requireValue(!ids.has(c.id), `${label}: duplicate case ${c.id}`);
    ids.add(c.id);
  }
}

export function assertContract(contract) {
  keys(contract, 'formatVersion normalizationVersion destinationDefaults enabledProviders providersCatalog models expectations cases', 'contract');
  equal(contract.formatVersion, 1, 'formatVersion');
  equal(contract.normalizationVersion, 1, 'normalizationVersion');
  equal(contract.destinationDefaults, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }, 'destinationDefaults');
  equal(contract.enabledProviders, { auggie: true }, 'enabledProviders');
  equal(contract.providersCatalog, { providers: [
    { id: 'auggie', displayName: 'Augment Auggie', shortName: 'Auggie', command: 'auggie', canBeDisabled: true, visible: true },
    { id: 'codex', displayName: 'OpenAI Codex', shortName: 'Codex', command: 'codex-acp', canBeDisabled: true, visible: true },
  ] }, 'providersCatalog');
  equal(contract.models, {
    auggie: [{ id: 'gpt6-astra', provider: 'auggie', name: 'GPT6 Astra Auggie', isDefault: true, effortLevels: ['low', 'high'] }],
    codex: [{ id: 'gpt-6-astra', provider: 'codex', name: 'GPT-6 Astra Codex', isDefault: true, effortLevels: ['low', 'high'] }],
  }, 'models');
  keys(contract.expectations, 'explicit auto', 'expectations');
  for (const mode of ['explicit', 'auto']) {
    const auto = mode === 'auto';
    const selection = { provider: 'auggie', model: auto ? null : 'gpt6-astra', reasoningEffort: auto ? null : 'low' };
    equal(contract.expectations[mode], {
      selection, firstTurn: selection,
      renderer: { label: auto ? 'Default model' : 'GPT6 Astra Auggie', auto, warning: false, fallbackAction: false, modelMutation: false, toast: false },
    }, `expectations.${mode}`);
  }
  caseList(contract.cases, 'contract');
  const order = [];
  for (const provider of PROVIDERS) for (const mode of MODES) for (const enabled of [true, false]) {
    order.push(`${provider}:${mode}:codex=${enabled}`);
  }
  for (const [index, c] of contract.cases.entries()) {
    keys(c, 'id sourceProvider mode codexEnabled input expectation expectedPersistedSelection expectedRawHistory', c.id);
    requireValue(PROVIDERS.includes(c.sourceProvider), `${c.id}: invalid sourceProvider`);
    requireValue(MODES.includes(c.mode), `${c.id}: invalid mode`);
    requireValue(typeof c.codexEnabled === 'boolean', `${c.id}: codexEnabled must be boolean`);
    equal(c.id, `${c.sourceProvider}:${c.mode}:codex=${c.codexEnabled}`, 'case id');
    equal(c.id, order[index], 'contract case order');
    const auto = c.mode === 'auto';
    const model = auto ? null : 'gpt6-astra';
    const effort = auto ? null : 'low';
    equal(c.input, {
      provider: ['history', 'prefix'].includes(c.mode) ? null : c.sourceProvider,
      model: c.mode === 'prefix' ? `${c.sourceProvider}:gpt6-astra` : model,
      reasoning_effort: effort, last_turn_provider: c.sourceProvider, last_turn_model: model,
    }, `${c.id}.input`);
    equal(c.expectation, auto ? 'auto' : 'explicit', `${c.id}.expectation`);
    // Canonical Auggie prefixes already worked before the alias correction and
    // retain raw spelling. Alias prefixes are canonicalized at import.
    equal(c.expectedPersistedSelection, {
      provider: 'auggie',
      model: c.sourceProvider === 'auggie' && c.mode === 'prefix' ? 'auggie:gpt6-astra' : model,
      reasoning_effort: effort,
    }, `${c.id}.expectedPersistedSelection`);
    equal(c.expectedRawHistory, { last_turn_provider: c.sourceProvider, last_turn_model: model }, `${c.id}.expectedRawHistory`);
  }
}

// This is the entire normalization allowlist. Never recursively scrub keys by
// name: that would hide changed provider IDs, model IDs or historical fields.
export function normalizeCases(cases) {
  requireValue(Array.isArray(cases), 'cases must be an array');
  const copy = structuredClone(cases);
  for (const c of copy) {
    object(c.session, `${c.id}.session`);
    for (const field of ['id', 'workspaceId']) string(c.session[field], `${c.id}.session.${field}`);
    for (const field of ['createdAt', 'updatedAt']) {
      const value = c.session[field];
      const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
      requireValue(
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
          && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19),
        `${c.id}.session.${field} must be a UTC timestamp`,
      );
      c.session[field] = TIME;
    }
    c.session.id = 'agent-transfer-contract';
    c.session.workspaceId = 'ws-transfer-contract';
  }
  return copy;
}

export function assertGenerated(contract, artifact, expectedSource = {}) {
  assertContract(contract);
  keys(artifact, 'formatVersion normalizationVersion provenance cases', 'generated envelope');
  equal(artifact.formatVersion, 1, 'generated formatVersion');
  equal(artifact.normalizationVersion, 1, 'generated normalizationVersion');
  const p = artifact.provenance;
  keys(p, 'kind generator intentdRevision intentdDirty generatorSha256 contractSha256 payloadSha256', 'provenance');
  equal(p.kind, 'intentd-public-import', 'provenance.kind');
  equal(p.generator, GENERATOR, 'provenance.generator');
  requireValue(typeof p.intentdRevision === 'string' && /^[a-f0-9]{40}$/.test(p.intentdRevision), 'provenance.intentdRevision must be a full lowercase Git SHA');
  equal(p.intentdDirty, false, 'provenance.intentdDirty');
  for (const field of ['generatorSha256', 'contractSha256', 'payloadSha256']) {
    requireValue(typeof p[field] === 'string' && /^[a-f0-9]{64}$/.test(p[field]), `provenance.${field} must be a lowercase SHA-256`);
  }
  for (const field of ['intentdRevision', 'generatorSha256']) {
    if (expectedSource[field] !== undefined) equal(p[field], expectedSource[field], `provenance.${field}`);
  }
  equal(p.contractSha256, hashJson(contract), 'provenance.contractSha256');
  equal(p.payloadSha256, hashJson(artifact.cases), 'provenance.payloadSha256');
  caseList(artifact.cases, 'generated output');
  const byId = new Map(contract.cases.map((c) => [c.id, c]));
  for (const [index, row] of artifact.cases.entries()) {
    keys(row, 'id session persisted firstTurn', `output ${row.id}`);
    const c = byId.get(row.id);
    requireValue(c, `unknown output case id ${row.id}`);
    equal(row.id, contract.cases[index].id, 'output case order');
    const expectation = contract.expectations[c.expectation];
    const s = row.session;
    object(s, `${row.id}.session`);
    for (const field of ['id', 'workspaceId', 'name', 'harnessVersion']) string(s[field], `${row.id}.session.${field}`);
    equal(s.status, 'idle', `${row.id}.session.status`);
    for (const field of ['isActive', 'nameExplicitlySet', 'notificationsMuted']) equal(s[field], false, `${row.id}.session.${field}`);
    equal(s.messages, [], `${row.id}.session.messages`);
    object(s.harnessFeatures, `${row.id}.session.harnessFeatures`);
    requireValue(Object.keys(s.harnessFeatures).length > 0 && Object.values(s.harnessFeatures).every((v) => typeof v === 'boolean'), `${row.id}.session.harnessFeatures must contain boolean flags`);
    for (const [field, value] of Object.entries(expectation.selection)) {
      if (value === null) requireValue(!Object.hasOwn(s, field), `${row.id}.session.${field} must be omitted for Auto`);
      else equal(s[field], value, `${row.id}.session.${field}`);
    }
    for (const field of ['attentionRequestKind', 'attentionRequestReason', 'effortLevels']) {
      requireValue(!Object.hasOwn(s, field), `${row.id}.session.${field} must be omitted`);
    }
    equal(row.persisted, { ...c.expectedPersistedSelection, ...c.expectedRawHistory }, `${row.id}.persisted`);
    equal(row.firstTurn, expectation.firstTurn, `${row.id}.firstTurn`);
  }
  requireValue(isDeepStrictEqual(artifact.cases, normalizeCases(artifact.cases)), 'output must already be normalized');
}

export function assertFresh(contract, golden, fresh, expectedSource = {}) {
  assertGenerated(contract, golden);
  assertGenerated(contract, fresh, expectedSource);
  for (const [index, row] of golden.cases.entries()) {
    requireValue(isDeepStrictEqual(row, fresh.cases[index]), `stale public-sessions.json: freshly generated payload differs for ${row.id}; inspect the daemon change before regenerating`);
  }
}

export function resolveFixtureRoot({ fixtureRoot, env = process.env } = {}) {
  return path.resolve(fixtureRoot ?? env.TRANSFER_SELECTION_FIXTURE_ROOT ?? DEFAULT_ROOT);
}

async function readRequiredJson(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { throw new Error(`required fixture ${file} could not be read (${error.code}); set TRANSFER_SELECTION_FIXTURE_ROOT to the shared fixture directory`); }
  try { return JSON.parse(text); }
  catch { throw new Error(`invalid JSON in required fixture ${file}`); }
}

export async function inspectFixtures({ fixtureRoot, inputsOnly = false, generated, fresh, intentdRevision, generatorSha256 } = {}) {
  requireValue(!inputsOnly || (!generated && !fresh && !intentdRevision && !generatorSha256), '--inputs-only cannot be combined with output or provenance options');
  const root = resolveFixtureRoot({ fixtureRoot });
  const contract = await readRequiredJson(path.join(root, 'contract.json'));
  assertContract(contract);
  if (inputsOnly) return '32 transfer-selection input cases valid (outputs not checked)';
  const goldenPath = path.resolve(generated ?? path.join(root, 'public-sessions.json'));
  const golden = await readRequiredJson(goldenPath);
  const expectedSource = { intentdRevision, generatorSha256 };
  if (fresh) {
    const freshPath = path.resolve(fresh);
    const freshArtifact = await readRequiredJson(freshPath);
    const [goldenStat, freshStat] = await Promise.all([fs.stat(goldenPath), fs.stat(freshPath)]);
    requireValue(goldenStat.dev !== freshStat.dev || goldenStat.ino !== freshStat.ino, '--fresh must name a separate newly generated file, not the golden');
    assertFresh(contract, golden, freshArtifact, expectedSource);
    return '32 transfer-selection cases valid; fresh payload matches the golden';
  }
  assertGenerated(contract, golden, expectedSource);
  return '32 transfer-selection cases valid (integrity only; freshness not checked)';
}

async function main() {
  const { values } = parseArgs({ options: {
    'fixture-root': { type: 'string' }, 'inputs-only': { type: 'boolean' },
    generated: { type: 'string' }, fresh: { type: 'string' },
    'intentd-revision': { type: 'string' }, 'generator-sha256': { type: 'string' },
  } });
  console.log(await inspectFixtures({
    fixtureRoot: values['fixture-root'], inputsOnly: values['inputs-only'],
    generated: values.generated, fresh: values.fresh,
    intentdRevision: values['intentd-revision'], generatorSha256: values['generator-sha256'],
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`transfer-selection contract: ${error.message}`); process.exitCode = 1; });
}
