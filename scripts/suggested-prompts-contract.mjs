#!/usr/bin/env node
// Shared suggested-prompts block cases: offline validation and exact-byte
// distribution to the component test suites (same model as
// backend-keychain-contract.mjs). No component code is imported.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

export const SOURCE_REPOSITORY = 'intent-hq/intent';
export const SOURCE_PATH = 'docs/protocol/fixtures/suggested-prompts/v1';
export const CASES_FILE = 'cases.json';
export const MIRRORS = {
  'cloudlands-fe': {
    directory: 'tests/fixtures/suggested-prompts/v1',
    lock: 'tests/fixtures/suggested-prompts.lock.json',
  },
  intentd: {
    directory: 'crates/intent-services/tests/fixtures/suggested-prompts/v1',
    lock: 'crates/intent-services/tests/fixtures/suggested-prompts.lock.json',
  },
  ios: {
    directory: 'IntentTests/Fixtures/suggested-prompts/v1',
    lock: 'IntentTests/Fixtures/suggested-prompts.lock.json',
  },
};
export const CONSUMERS = Object.keys(MIRRORS);
// Cases that must never silently disappear: the escaped-block incident and the
// structural rules every parser has to agree on.
export const REQUIRED_CASES = [
  'plain-prompts', 'no-block', 'empty-input', 'fenced-opener-ignored', 'inline-opener-in-prose',
  'unclosed-block-restored', 'body-shaped-heading', 'last-block-wins', 'cap-at-four', 'fused-closer',
  'crlf-line-endings', 'escaped-failover-reply', 'escaped-fused-closer', 'escaped-body-shaped',
  'escaped-fenced-untouched', 'escaped-inline-opener', 'escaped-block-ignores-literal-closer',
  'literal-block-ignores-escaped-closer', 'literal-block-entities-kept',
];
export const MAX_PROMPTS = 4;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function object(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
function keys(value, required, optional, label) {
  object(value, label);
  const actual = Object.keys(value);
  for (const key of required) requireValue(actual.includes(key), `${label} is missing ${key}`);
  for (const key of actual) requireValue(required.includes(key) || optional.includes(key), `${label} has unknown key ${key}`);
}
function string(value, label) {
  requireValue(typeof value === 'string', `${label} must be a string`);
}

/**
 * The comparison form of a cleaned reply: trimmed, with runs of three or more
 * line feeds collapsed to two. Parsers differ only in how many blank lines a
 * removed block leaves behind, which renders identically.
 */
export function normalizeCleaned(text) {
  return text.trim().replace(/\n{3,}/g, '\n\n');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validateCases(doc) {
  keys(doc, ['fixtureFormatVersion', 'description', 'consumers', 'cases'], [], 'cases file');
  equal(doc.fixtureFormatVersion, 1, 'fixtureFormatVersion');
  string(doc.description, 'description');
  equal(doc.consumers, CONSUMERS, 'consumers');
  requireValue(Array.isArray(doc.cases) && doc.cases.length > 0, 'cases must be a non-empty array');
  const seen = new Set();
  for (const [index, testCase] of doc.cases.entries()) {
    const label = `cases[${index}]${typeof testCase?.id === 'string' ? ` (${testCase.id})` : ''}`;
    keys(testCase, ['id', 'origin', 'input', 'expect'], ['divergences'], label);
    requireValue(typeof testCase.id === 'string' && ID.test(testCase.id), `${label}: id must be kebab-case`);
    requireValue(!seen.has(testCase.id), `${label}: duplicate id`);
    seen.add(testCase.id);
    string(testCase.origin, `${label}.origin`);
    requireValue(testCase.origin.trim().length > 0, `${label}.origin must not be blank`);
    string(testCase.input, `${label}.input`);
    const { expect } = testCase;
    keys(expect, ['blockStripped', 'prompts', 'cleaned'], [], `${label}.expect`);
    requireValue(typeof expect.blockStripped === 'boolean', `${label}.expect.blockStripped must be a boolean`);
    requireValue(Array.isArray(expect.prompts) && expect.prompts.every((p) => typeof p === 'string' && p.trim() === p && p.length > 0),
      `${label}.expect.prompts must be an array of non-empty trimmed strings`);
    requireValue(expect.prompts.length <= MAX_PROMPTS, `${label}.expect.prompts has more than ${MAX_PROMPTS} prompts`);
    string(expect.cleaned, `${label}.expect.cleaned`);
    equal(expect.cleaned, normalizeCleaned(expect.cleaned), `${label}.expect.cleaned must already be normalized`);
    if (!expect.blockStripped) {
      equal(expect.prompts, [], `${label}: a reply without a well-formed block has no prompts`);
      equal(expect.cleaned, normalizeCleaned(testCase.input), `${label}: a reply without a well-formed block is left as is`);
    } else {
      requireValue(expect.cleaned !== normalizeCleaned(testCase.input), `${label}: a stripped block must change the text`);
    }
    if (testCase.divergences !== undefined) {
      object(testCase.divergences, `${label}.divergences`);
      const entries = Object.entries(testCase.divergences);
      requireValue(entries.length > 0, `${label}.divergences must not be empty`);
      for (const [consumer, reason] of entries) {
        requireValue(CONSUMERS.includes(consumer), `${label}.divergences: unknown consumer ${consumer}`);
        requireValue(typeof reason === 'string' && reason.trim().length > 0, `${label}.divergences.${consumer} needs a reason`);
      }
    }
  }
  for (const id of REQUIRED_CASES) requireValue(seen.has(id), `required case ${id} is missing`);
  return doc;
}

export function readCases(directory) {
  const file = path.join(directory, CASES_FILE);
  const bytes = fs.readFileSync(file);
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  validateCases(doc);
  requireValue(bytes.equals(jsonBytes(doc)), `${file} must be formatted as JSON.stringify(value, null, 2) plus a newline`);
  return { doc, bytes, digest: sha256(bytes) };
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mirrorPaths(componentRoot, component) {
  const spec = MIRRORS[component];
  requireValue(spec, `unknown component ${component}; expected one of ${CONSUMERS.join(', ')}`);
  return {
    directory: path.join(componentRoot, spec.directory),
    lock: path.join(componentRoot, spec.lock),
  };
}

export function expectedLock(source, sourceCommit) {
  requireValue(typeof sourceCommit === 'string' && SHA.test(sourceCommit), 'source commit must be a full 40-character lowercase Git SHA');
  return {
    lockVersion: 1,
    sourceRepository: SOURCE_REPOSITORY,
    sourcePath: SOURCE_PATH,
    sourceCommit,
    casesSha256: source.digest,
  };
}

function inspectMirror(componentRoot, component) {
  const paths = mirrorPaths(componentRoot, component);
  requireValue(fs.existsSync(paths.lock), `${component}: mirror lock ${paths.lock} is missing`);
  requireValue(fs.existsSync(paths.directory) && fs.lstatSync(paths.directory).isDirectory(),
    `${component}: mirror directory ${paths.directory} is missing`);
  requireValue(fs.readdirSync(paths.directory).every((file) => file === CASES_FILE),
    `${component}: mirror directory contains unexpected files`);
  const lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
  keys(lock, ['lockVersion', 'sourceRepository', 'sourcePath', 'sourceCommit', 'casesSha256'], [], `${component} lock`);
  equal(lock.lockVersion, 1, `${component} lockVersion`);
  equal(lock.sourceRepository, SOURCE_REPOSITORY, `${component} sourceRepository`);
  equal(lock.sourcePath, SOURCE_PATH, `${component} sourcePath`);
  requireValue(typeof lock.sourceCommit === 'string' && SHA.test(lock.sourceCommit),
    `${component} lock sourceCommit must be a full 40-character lowercase Git SHA`);
  requireValue(typeof lock.casesSha256 === 'string' && HASH.test(lock.casesSha256), `${component} lock casesSha256 must be SHA-256`);
  const mirror = readCases(paths.directory);
  equal(mirror.digest, lock.casesSha256, `${component}: mirror cases.json SHA-256 vs lock`);
  return { ...mirror, lock, paths };
}

/** Write the component mirror and lock from the canonical cases at `sourceRoot`. */
export function exportMirror({ sourceRoot, sourceCommit, component, componentRoot }) {
  const source = readCases(path.join(sourceRoot, SOURCE_PATH));
  const paths = mirrorPaths(componentRoot, component);
  requireValue(path.resolve(paths.directory) !== path.resolve(sourceRoot, SOURCE_PATH), 'mirror must be separate from canonical data');
  if (fs.existsSync(paths.directory)) {
    requireValue(fs.readdirSync(paths.directory).every((file) => file === CASES_FILE), `${component}: mirror directory contains unexpected files`);
  }
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(path.join(paths.directory, CASES_FILE), source.bytes);
  fs.writeFileSync(paths.lock, jsonBytes(expectedLock(source, sourceCommit)));
  return `${component}: exported ${source.doc.cases.length} cases at ${sourceCommit} sha256 ${source.digest}`;
}

/**
 * Component CI provenance: `sourceRoot` is the monorepo checked out at the
 * lock's commit, and the mirror must be byte-identical to it.
 */
export function verifyMirror({ sourceRoot, sourceCommit, component, componentRoot }) {
  const source = readCases(path.join(sourceRoot, SOURCE_PATH));
  const mirror = inspectMirror(componentRoot, component);
  equal(mirror.lock, expectedLock(source, sourceCommit), `${component}: mirror provenance`);
  requireValue(mirror.bytes.equals(source.bytes), `${component}: cases.json differs from ${SOURCE_REPOSITORY}@${sourceCommit}`);
  return `${component}: ${mirror.doc.cases.length} cases match ${SOURCE_REPOSITORY}@${sourceCommit} sha256 ${source.digest}`;
}

/** Monorepo/upstream check: canonical cases plus every adopted component mirror. */
export function checkConsumers(root) {
  const canonical = readCases(path.join(root, SOURCE_PATH));
  const lines = [`canonical suggested-prompts cases valid: ${canonical.doc.cases.length} cases sha256 ${canonical.digest}`];
  for (const component of CONSUMERS) {
    const componentRoot = path.join(root, 'packages', component);
    const paths = mirrorPaths(componentRoot, component);
    // Either file declares adoption; a half-deleted mirror must fail, not skip.
    if (!fs.existsSync(paths.lock) && !fs.existsSync(paths.directory)) {
      const initialized = fs.existsSync(path.join(componentRoot, '.git'));
      lines.push(`${component}: ${initialized ? 'pre-adoption pin' : `uninspected (checkout uninitialized${component === 'ios' ? '; private/optional' : ''})`}; conformance not claimed`);
      continue;
    }
    const mirror = inspectMirror(componentRoot, component);
    const state = mirror.digest === canonical.digest ? 'current' : 'behind canonical (re-export to pick up new cases)';
    lines.push(`${component}: adopted mirror valid at ${mirror.lock.sourceCommit}, ${state}; provenance is verified in component CI`);
  }
  return lines.join('\n');
}

export function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      'source-root': { type: 'string' },
      'source-commit': { type: 'string' },
      component: { type: 'string' },
      'component-root': { type: 'string' },
    },
  });
  const usage = 'usage: suggested-prompts-contract.mjs validate|check [--root MONOREPO] '
    + 'OR export|verify --source-root MONOREPO --source-commit SHA --component cloudlands-fe|intentd|ios --component-root COMPONENT';
  const [command] = positionals;
  requireValue(positionals.length === 1 && ['validate', 'check', 'export', 'verify'].includes(command), usage);
  if (command === 'validate' || command === 'check') {
    requireValue(Object.keys(values).every((key) => key === 'root'), `${command} only accepts --root`);
    const root = path.resolve(values.root ?? ROOT);
    if (command === 'check') return checkConsumers(root);
    const { doc, digest } = readCases(path.join(root, SOURCE_PATH));
    return `canonical suggested-prompts cases valid: ${doc.cases.length} cases sha256 ${digest}`;
  }
  for (const key of ['source-root', 'source-commit', 'component', 'component-root']) {
    requireValue(typeof values[key] === 'string', `${command} requires --${key}; ${usage}`);
  }
  const options = {
    sourceRoot: path.resolve(values['source-root']),
    sourceCommit: values['source-commit'],
    component: values.component,
    componentRoot: path.resolve(values['component-root']),
  };
  return command === 'export' ? exportMirror(options) : verifyMirror(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(main());
  } catch (error) {
    console.error(`suggested-prompts-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
