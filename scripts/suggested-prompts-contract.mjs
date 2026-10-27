#!/usr/bin/env node
// Shared suggested-prompts block cases: offline validation, and exact-byte
// copies in the component test suites through the shared fixture-copy tool
// (scripts/lib/fixture-copy.mjs). No component code is imported.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  SOURCE_REPOSITORY, defineFixtureCopy, fixtureCopyMain, jsonBytes, readJsonBytes, runScript, sha256,
} from './lib/fixture-copy.mjs';

export { SOURCE_REPOSITORY, jsonBytes, sha256 };
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
 * The comparison form of a cleaned reply: CRLF as LF, trimmed, with runs of
 * three or more line feeds collapsed to two. Parsers differ only in line
 * endings and in how many blank lines a removed block leaves behind, which
 * render identically.
 */
export function normalizeCleaned(text) {
  return text.replace(/\r\n/g, '\n').trim().replace(/\n{3,}/g, '\n\n');
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

/**
 * Read a cases file. `validate: false` checks only JSON and formatting, for a
 * component copy locked to an older canonical revision: today's schema and
 * required-case rules apply to the canonical file, not to older copies.
 */
export function readCases(directory, { validate = true } = {}) {
  const file = path.join(directory, CASES_FILE);
  const bytes = fs.readFileSync(file);
  const doc = readJsonBytes(bytes, file);
  if (validate) validateCases(doc);
  return { doc, bytes, digest: sha256(bytes) };
}

export const COPY = defineFixtureCopy({
  name: 'suggested-prompts',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  files: [CASES_FILE],
  copies: MIRRORS,
  // The lock format predates the shared tool; adopted locks keep it.
  lockFields: (bytes) => ({ casesSha256: sha256(bytes[CASES_FILE]) }),
  validate: (directory) => {
    const { doc, digest } = readCases(directory);
    return `${doc.cases.length} cases sha256 ${digest}`;
  },
});

/** Write the component copy and lock from the canonical cases at `sourceRoot`. */
export const exportMirror = (options) => COPY.exportCopy(options);
/** Component CI provenance: the copy must be byte-identical to the monorepo at the lock's commit. */
export const verifyMirror = (options) => COPY.verifyCopy(options);
/** Monorepo/upstream check: canonical cases plus every adopted component copy. */
export const checkConsumers = (root) => COPY.checkCopies(root).report;

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'suggested-prompts-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'suggested-prompts-contract', () => main());
