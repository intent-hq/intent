#!/usr/bin/env node
// Offline corpus validation and exact-byte distribution; no component imports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

export const SOURCE_REPOSITORY = 'intent-hq/intent';
export const SOURCE_PATH = 'docs/protocol/fixtures/backend-keychain/v1';
export const MIRRORS = {
  'cloudlands-fe': { directory: 'tests/fixtures/backend-keychain/v1', lock: 'tests/fixtures/backend-keychain.lock.json' },
  ios: { directory: 'IntentTests/Fixtures/backend-keychain/v1', lock: 'IntentTests/Fixtures/backend-keychain.lock.json' },
};
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = ['corpus.json', 'manifest.json'];
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMMON = 'label host hosts port fingerprint hostname tcAddress detectHosts token updatedAt';
const DESKTOP = `${COMMON} accent detectedDeviceKind deviceIcon`;
const IOS = `${COMMON} deleted deletedAt`;
const REQUIRED = {
  parseCases: [
    'live-lan', 'tunnel-only', 'route-absent', 'route-null', 'route-empty', 'route-whitespace',
    'route-number', 'route-boolean', 'route-object', 'route-array', 'route-padded', 'route-case-distinct',
    'legacy-defaults', 'optional-type-defaults', 'older-numeric-version', 'malformed-json', 'array-root', 'null-root',
    ...['v', 'label', 'host', 'port', 'fingerprint', 'updatedAt'].flatMap((key) =>
      ['absent', 'null', 'wrong-type'].map((kind) => `${key}-${kind}`)),
    'host-blank', 'port-string', 'port-fractional', 'future-version', 'future-fractional-version',
    'unknown-metadata', 'accent-invalid', 'removal-explicit', 'removal-fallback', 'removal-invalid-clock',
  ],
  identityCases: ['fingerprint-normalized', 'legacy-address', 'tunnel-account-only-lowercases'],
  serializeCases: ['live-lan', 'tunnel-only', 'removal-scrubs-token', 'removal-default-clock', 'metadata-known-only'],
  expiryCases: ['before-expiry', 'at-expiry', 'after-expiry', 'fallback-expiry', 'live-never-expires'],
  iosPublishCases: ['pair-lan', 'pair-tunnel-only', 'pair-no-route', 'repair-preserves-metadata', 'routes-preserve-metadata'],
  iosImportCases: ['import-lan', 'import-tunnel-only'],
  noWriteCases: ['future-version', 'v-wrong-type'],
};

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function object(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
function keys(value, fields, label) {
  object(value, label);
  equal(Object.keys(value).sort(), fields.split(' ').sort(), `${label} keys`);
}
function string(value, label) { requireValue(typeof value === 'string', `${label} must be a string`); }
function number(value, label) { requireValue(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number`); }
function strings(value, label) {
  requireValue(Array.isArray(value) && value.every((x) => typeof x === 'string'), `${label} must be a string array`);
}
function nullableString(value, label) { if (value !== null) string(value, label); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function assertRecord(value, client, label, { extra = false } = {}) {
  object(value, label);
  const fields = client === 'desktop' ? DESKTOP + (value.deleted === true ? ' deleted deletedAt' : '') : IOS;
  if (!extra) keys(value, fields, label);
  for (const field of COMMON.split(' ')) requireValue(Object.hasOwn(value, field), `${label}.${field} missing`);
  for (const field of ['label', 'host', 'fingerprint', 'token']) string(value[field], `${label}.${field}`);
  for (const field of ['port', 'updatedAt']) number(value[field], `${label}.${field}`);
  for (const field of ['hostname', 'tcAddress']) nullableString(value[field], `${label}.${field}`);
  strings(value.hosts, `${label}.hosts`);
  requireValue(typeof value.detectHosts === 'boolean', `${label}.detectHosts must be boolean`);
  if (client === 'ios') {
    requireValue(Number.isSafeInteger(value.port), `${label}.port must be an integer`);
    requireValue(typeof value.deleted === 'boolean', `${label}.deleted must be boolean`);
    if (!value.deleted) equal(value.deletedAt, null, `${label}.deletedAt`);
  } else {
    nullableString(value.accent, `${label}.accent`);
    nullableString(value.detectedDeviceKind, `${label}.detectedDeviceKind`);
    string(value.deviceIcon, `${label}.deviceIcon`);
  }
  if (value.deleted === true) {
    number(value.deletedAt, `${label}.deletedAt`);
    if (!extra) equal(value.token, '', `${label}: tombstone token must be scrubbed`);
  }
}

function assertConnection(c, label) {
  keys(c, 'label hosts port fingerprint token tcAddress pendingSyncUpdatedAt pendingRoutePublication', label);
  for (const field of ['label', 'fingerprint', 'token']) string(c[field], `${label}.${field}`);
  strings(c.hosts, `${label}.hosts`);
  number(c.port, `${label}.port`);
  nullableString(c.tcAddress, `${label}.tcAddress`);
  if (c.pendingSyncUpdatedAt !== null) number(c.pendingSyncUpdatedAt, `${label}.pendingSyncUpdatedAt`);
  if (c.pendingRoutePublication !== null) {
    const p = c.pendingRoutePublication;
    keys(p, 'hosts tcAddress previousTcAddress updatedAt tcUpdatedAt', `${label}.pendingRoutePublication`);
    strings(p.hosts, `${label}.route.hosts`);
    nullableString(p.tcAddress, `${label}.route.tcAddress`);
    nullableString(p.previousTcAddress, `${label}.route.previousTcAddress`);
    number(p.updatedAt, `${label}.route.updatedAt`);
    if (p.tcUpdatedAt !== null) number(p.tcUpdatedAt, `${label}.route.tcUpdatedAt`);
  }
}

function assertRows(rows, label) {
  requireValue(Array.isArray(rows), `${label} must be an array`);
  for (const row of rows) {
    keys(row, 'account payload', label);
    string(row.account, `${label}.account`);
    object(row.payload, `${label}.payload`);
    for (const field of ['v', ...COMMON.split(' ')]) requireValue(Object.hasOwn(row.payload, field), `${label}.payload.${field} missing`);
  }
}

export function validateCorpus(corpus) {
  keys(corpus, `fixtureFormatVersion payloadVersion service tombstoneTtlMs ${Object.keys(REQUIRED).join(' ')}`, 'corpus');
  equal(corpus.fixtureFormatVersion, 1, 'fixtureFormatVersion');
  equal(corpus.payloadVersion, 1, 'payloadVersion');
  equal(corpus.service, 'com.cloudlands.intent.backends', 'service');
  equal(corpus.tombstoneTtlMs, 2592000000, 'tombstoneTtlMs');
  for (const [group, required] of Object.entries(REQUIRED)) {
    requireValue(Array.isArray(corpus[group]), `${group} must be an array`);
    const ids = corpus[group].map((c) => c?.id);
    requireValue(ids.every((id) => typeof id === 'string' && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(id)), `${group}: invalid case id`);
    equal(new Set(ids).size, ids.length, `${group}: duplicate case id`);
    for (const id of required) requireValue(ids.includes(id), `${group}: missing required case ${id}`);
  }
  const parsed = new Map(corpus.parseCases.map((c) => [c.id, c]));
  for (const c of corpus.parseCases) {
    keys(c, 'id payload desktop ios', c.id);
    string(c.payload, `${c.id}.payload`);
    requireValue(c.payload.length > 0, `${c.id}.payload cannot be empty`);
    for (const client of ['desktop', 'ios']) {
      const result = c[client];
      requireValue(['record', 'invalid', 'newer-version'].includes(result?.kind), `${c.id}.${client}: invalid kind`);
      keys(result, result.kind === 'record' ? 'kind record' : 'kind', `${c.id}.${client}`);
      if (result.kind === 'record') assertRecord(result.record, client, `${c.id}.${client}`);
    }
    // Exactly two existing kind differences; no per-client shared-field ignore list.
    if (['port-fractional', 'accent-invalid'].includes(c.id)) {
      equal(c.desktop.kind, c.id === 'port-fractional' ? 'record' : 'invalid', `${c.id}.desktop.kind`);
      equal(c.ios.kind, c.id === 'port-fractional' ? 'invalid' : 'record', `${c.id}.ios.kind`);
    } else {
      equal(c.desktop.kind, c.ios.kind, `${c.id}: shared parse outcome`);
    }
    if (c.desktop.kind === 'record' && c.ios.kind === 'record') {
      for (const field of COMMON.split(' ')) {
        if (c.id === 'route-padded' && field === 'tcAddress') {
          equal(c.desktop.record.tcAddress, ' \ttcMiXeD_Case-Address\n ', `${c.id}.desktop route`);
          equal(c.ios.record.tcAddress, 'tcMiXeD_Case-Address', `${c.id}.ios route`);
        } else equal(c.desktop.record[field], c.ios.record[field], `${c.id}: shared ${field}`);
      }
      equal(c.desktop.record.deleted ?? false, c.ios.record.deleted, `${c.id}: deleted`);
      equal(c.desktop.record.deletedAt ?? null, c.ios.record.deletedAt, `${c.id}: deletedAt`);
    }
  }
  for (const id of ['live-lan', 'tunnel-only']) {
    for (const client of ['desktop', 'ios']) equal(parsed.get(id)[client].record?.tcAddress, 'tcMiXeD_Case-Address', `${id}.${client}: required route`);
  }
  // Check that named coverage still contains the promised input. This is not
  // a reference codec: production consumers assert the complete stored outputs.
  const input = (id) => {
    let value;
    try { value = JSON.parse(parsed.get(id).payload); } catch { throw new Error(`${id}: coverage requires JSON input`); }
    object(value, `${id}: coverage input`);
    return value;
  };
  for (const id of ['live-lan', 'tunnel-only']) equal(input(id).tcAddress, 'tcMiXeD_Case-Address', `${id}: route coverage`);
  equal(input('tunnel-only').host, 'tcMiXeD_Case-Address', 'tunnel-only: host coverage');
  equal(input('tunnel-only').hosts, [], 'tunnel-only: hosts coverage');
  const routeInputs = {
    absent: undefined, null: null, empty: '', whitespace: ' \t\n ', number: 42,
    boolean: true, object: { address: 'tcOther' }, array: ['tcOther'],
    padded: ' \ttcMiXeD_Case-Address\n ', 'case-distinct': 'tcMIXED_Case-Address',
  };
  for (const [suffix, value] of Object.entries(routeInputs)) {
    const id = `route-${suffix}`;
    equal(input(id).tcAddress, value, `${id}: coverage input`);
    if (!['padded', 'case-distinct'].includes(suffix)) {
      for (const client of ['desktop', 'ios']) equal(parsed.get(id)[client].record?.tcAddress, null, `${id}: unknown route result`);
    }
  }
  for (const field of ['v', 'label', 'host', 'port', 'fingerprint', 'updatedAt']) {
    for (const suffix of ['absent', 'null', 'wrong-type']) {
      const id = `${field}-${suffix}`;
      const value = suffix === 'absent' ? undefined : suffix === 'null' ? null : ['v', 'port', 'updatedAt'].includes(field) ? true : 42;
      equal(input(id)[field], value, `${id}: coverage input`);
      for (const client of ['desktop', 'ios']) equal(parsed.get(id)[client].kind, 'invalid', `${id}: required-field result`);
    }
  }
  for (const id of ['future-version', 'future-fractional-version']) {
    requireValue(input(id).v > 1, `${id}: coverage requires a future version`);
    for (const client of ['desktop', 'ios']) equal(parsed.get(id)[client].kind, 'newer-version', `${id}: future-version result`);
  }
  for (const c of corpus.identityCases) {
    keys(c, 'id host port fingerprint accountKey registryKey', c.id);
    for (const field of ['host', 'fingerprint', 'accountKey', 'registryKey']) string(c[field], `${c.id}.${field}`);
    number(c.port, `${c.id}.port`);
  }
  for (const c of corpus.serializeCases) {
    keys(c, 'id record expected', c.id);
    // A serializer input may intentionally carry unknown properties and an unscrubbed token.
    // Its deletedAt can be absent to exercise the fallback clock.
    assertRecord({ ...c.record, ...(c.record.deleted === true ? { deletedAt: c.record.deletedAt ?? c.record.updatedAt } : {}) }, 'desktop', c.id, { extra: true });
    keys(c.expected, `v ${DESKTOP}${c.expected.deleted === true ? ' deleted deletedAt' : ''}`, `${c.id}.expected`);
    equal(c.expected.v, 1, `${c.id}.expected.v`);
    const { v, ...record } = c.expected;
    assertRecord(record, 'desktop', `${c.id}.expected`);
  }
  for (const c of corpus.expiryCases) {
    keys(c, 'id parseCaseId nowMs expired', c.id);
    number(c.nowMs, `${c.id}.nowMs`);
    requireValue(typeof c.expired === 'boolean', `${c.id}.expired must be boolean`);
    requireValue(parsed.get(c.parseCaseId)?.ios.kind === 'record', `${c.id}: unknown record reference`);
  }
  for (const c of corpus.iosPublishCases) {
    keys(c, 'id operation existing connection expected', c.id);
    requireValue(['pair', 'routes'].includes(c.operation), `${c.id}: unknown publication operation`);
    assertConnection(c.connection, c.id);
    assertRows(c.existing, `${c.id}.existing`);
    keys(c.expected, 'outcome writes', `${c.id}.expected`);
    equal(c.expected.outcome, 'published', `${c.id}.expected.outcome`);
    assertRows(c.expected.writes, `${c.id}.writes`);
    equal(c.expected.writes.length, 1, `${c.id}: must exercise a write`);
  }
  for (const c of corpus.iosImportCases) {
    keys(c, 'id parseCaseId expected', c.id);
    requireValue(parsed.get(c.parseCaseId)?.ios.kind === 'record', `${c.id}: unknown record reference`);
    keys(c.expected, 'hosts port fingerprint token tcAddress', `${c.id}.expected`);
    strings(c.expected.hosts, `${c.id}.hosts`);
    number(c.expected.port, `${c.id}.port`);
    for (const field of ['fingerprint', 'token', 'tcAddress']) string(c.expected[field], `${c.id}.${field}`);
  }
  for (const c of corpus.noWriteCases) {
    keys(c, 'id parseCaseId account localRecord connection nowMs expected', c.id);
    requireValue(['invalid', 'newer-version'].includes(parsed.get(c.parseCaseId)?.desktop.kind), `${c.id}: unknown frozen reference`);
    string(c.account, `${c.id}.account`);
    number(c.nowMs, `${c.id}.nowMs`);
    assertRecord(c.localRecord, 'desktop', `${c.id}.localRecord`);
    assertConnection(c.connection, c.id);
    equal(c.expected, { desktop: { applied: [], upserts: [], deletes: [] }, ios: { outcome: 'retry', writes: [] } }, `${c.id}: no-write expectation`);
  }
  return corpus;
}

function readBytes(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`required file missing: ${file}`); }
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `required file must be regular: ${file}`);
  const bytes = fs.readFileSync(file);
  requireValue(bytes.length > 0, `required file empty: ${file}`);
  return bytes;
}
function readJson(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid JSON: ${label}`); }
  requireValue(bytes.equals(jsonBytes(value)), `${label}: use UTF-8 JSON, two-space indentation and one final newline (no duplicate keys)`);
  return value;
}
export function readCorpus(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  requireValue(stat?.isDirectory() && !stat.isSymbolicLink(), `required corpus directory missing or not a regular directory: ${directory}`);
  const files = Object.fromEntries(FILES.map((file) => [file, readBytes(path.join(directory, file))]));
  equal(fs.readdirSync(directory).sort(), FILES, 'corpus file inventory');
  const manifest = readJson(files['manifest.json'], 'manifest.json');
  keys(manifest, 'fixtureFormatVersion payloadVersion files', 'manifest');
  equal(manifest.fixtureFormatVersion, 1, 'manifest.fixtureFormatVersion');
  equal(manifest.payloadVersion, 1, 'manifest.payloadVersion');
  equal(manifest.files, { 'corpus.json': sha256(files['corpus.json']) }, 'manifest.files hashes');
  const corpus = validateCorpus(readJson(files['corpus.json'], 'corpus.json'));
  return { corpus, files, digest: sha256(files['corpus.json']) };
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}
function requireSource(root, commit) {
  requireValue(typeof commit === 'string' && SHA.test(commit), 'source commit must be an immutable 40-character lowercase Git SHA');
  equal(git(root, 'rev-parse', '--show-toplevel').toString().trim(), fs.realpathSync(root), 'source root must be the checkout root');
  equal(git(root, 'rev-parse', 'HEAD').toString().trim(), commit, 'canonical checkout HEAD must equal source commit');
  const source = readCorpus(path.join(root, SOURCE_PATH));
  for (const file of FILES) {
    requireValue(source.files[file].equals(git(root, 'show', `${commit}:${SOURCE_PATH}/${file}`)), `canonical ${file} differs from source commit ${commit}`);
  }
  return source;
}
function mirrorPaths(componentRoot, component) {
  requireValue(Object.hasOwn(MIRRORS, component), `unknown component: ${component}`);
  const spec = MIRRORS[component];
  return { directory: path.join(componentRoot, spec.directory), lock: path.join(componentRoot, spec.lock) };
}
function expectedLock(source, commit) {
  return {
    lockVersion: 1, sourceRepository: SOURCE_REPOSITORY, sourcePath: SOURCE_PATH,
    sourceCommit: commit, corpusSha256: source.digest,
    files: Object.fromEntries(FILES.map((file) => [file, sha256(source.files[file])])),
  };
}
export function inspectMirror(componentRoot, component) {
  const paths = mirrorPaths(componentRoot, component);
  const lock = readJson(readBytes(paths.lock), paths.lock);
  keys(lock, 'lockVersion sourceRepository sourcePath sourceCommit corpusSha256 files', 'lock');
  equal(lock.lockVersion, 1, 'lockVersion');
  equal(lock.sourceRepository, SOURCE_REPOSITORY, 'sourceRepository');
  equal(lock.sourcePath, SOURCE_PATH, 'sourcePath');
  requireValue(typeof lock.sourceCommit === 'string' && SHA.test(lock.sourceCommit), 'lock sourceCommit must be a full 40-character lowercase Git SHA');
  requireValue(typeof lock.corpusSha256 === 'string' && HASH.test(lock.corpusSha256), 'lock corpusSha256 must be SHA-256');
  const source = readCorpus(paths.directory);
  equal(lock, expectedLock(source, lock.sourceCommit), 'mirror hashes/lock');
  return { ...source, lock };
}
export function exportFixtures({ sourceRoot, sourceCommit, componentRoot, component }) {
  const source = requireSource(sourceRoot, sourceCommit);
  const paths = mirrorPaths(componentRoot, component);
  requireValue(path.resolve(paths.directory) !== path.resolve(sourceRoot, SOURCE_PATH), 'mirror must be separate from canonical data');
  // Refuse extra files instead of leaving a partly updated mirror on failure.
  if (fs.existsSync(paths.directory)) {
    requireValue(fs.lstatSync(paths.directory).isDirectory(), 'mirror must be a regular directory');
    requireValue(fs.readdirSync(paths.directory).every((file) => FILES.includes(file)), 'mirror contains unexpected files');
  }
  for (const file of [paths.lock, ...FILES.map((name) => path.join(paths.directory, name))]) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    requireValue(!stat || stat.isFile(), `export target must be a regular file: ${file}`);
  }
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  for (const file of FILES) fs.writeFileSync(path.join(paths.directory, file), source.files[file]);
  fs.writeFileSync(paths.lock, jsonBytes(expectedLock(source, sourceCommit)));
  return verifyFixtures({ sourceRoot, sourceCommit, componentRoot, component });
}
export function verifyFixtures({ sourceRoot, sourceCommit, componentRoot, component }) {
  const source = requireSource(sourceRoot, sourceCommit);
  const mirror = inspectMirror(componentRoot, component);
  equal(mirror.lock, expectedLock(source, sourceCommit), 'mirror provenance');
  for (const file of FILES) requireValue(mirror.files[file].equals(source.files[file]), `${component}: canonical byte mismatch in ${file}`);
  return `${component}: verified ${SOURCE_REPOSITORY}@${sourceCommit} corpus sha256 ${source.digest}`;
}
export function checkConsumers(root) {
  const canonical = readCorpus(path.join(root, SOURCE_PATH));
  const lines = [`canonical Keychain corpus valid: sha256 ${canonical.digest}`];
  let first;
  for (const component of Object.keys(MIRRORS)) {
    const componentRoot = path.join(root, 'packages', component);
    const paths = mirrorPaths(componentRoot, component);
    // Either marker declares adoption. Partial deletion must fail, never turn into a skip.
    const exists = (file) => fs.existsSync(file) || (() => { try { fs.lstatSync(file); return true; } catch { return false; } })();
    if (!exists(paths.lock) && !exists(paths.directory)) {
      const initialized = fs.existsSync(path.join(componentRoot, '.git'));
      lines.push(`${component}: ${initialized ? 'pre-adoption pin' : 'uninspected (checkout uninitialized' + (component === 'ios' ? '; private/optional)' : ')')}; conformance not claimed`);
      continue;
    }
    const mirror = inspectMirror(componentRoot, component);
    if (first) equal(mirror.lock, first, 'conflicting adopted consumer pins');
    first = mirror.lock;
    lines.push(`${component}: adopted integrity valid at ${mirror.lock.sourceCommit} sha256 ${mirror.digest}; provenance is required in component CI`);
  }
  return lines.join('\n');
}

export function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    root: { type: 'string' }, 'source-root': { type: 'string' }, 'source-commit': { type: 'string' },
    component: { type: 'string' }, 'component-root': { type: 'string' },
  } });
  const [command] = positionals;
  requireValue(positionals.length === 1 && ['validate', 'check', 'export', 'verify'].includes(command),
    'usage: backend-keychain-contract.mjs validate|check [--root MONOREPO] OR export|verify --source-root MONOREPO --source-commit SHA --component cloudlands-fe|ios --component-root COMPONENT');
  if (['validate', 'check'].includes(command)) {
    requireValue(Object.keys(values).every((key) => key === 'root'), 'validate/check only accepts --root');
    const root = path.resolve(values.root ?? ROOT);
    return command === 'check' ? checkConsumers(root) : `canonical Keychain corpus valid: sha256 ${readCorpus(path.join(root, SOURCE_PATH)).digest}`;
  }
  requireValue(!values.root && ['source-root', 'source-commit', 'component', 'component-root'].every((key) => values[key]), 'export/verify requires explicit source root, source commit, component and component root');
  return (command === 'export' ? exportFixtures : verifyFixtures)({
    sourceRoot: path.resolve(values['source-root']), sourceCommit: values['source-commit'],
    component: values.component, componentRoot: path.resolve(values['component-root']),
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(main()); } catch (error) { console.error(`backend-keychain-contract: ${error.message}`); process.exitCode = 1; }
}
