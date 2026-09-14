#!/usr/bin/env node

// Check that the event-type catalog is identical on every surface that vendors
// it: the intentd golden (source of truth, generated from
// intent_core::events::ALL_EVENT_TYPES), the protocol sidecar
// docs/protocol/event-types.json, and the iOS test fixture. A vendored copy that
// is missing because its submodule is not initialized is skipped; a copy that is
// present must be byte-identical to the sidecar — a semantic difference fails
// naming the differing types / discriminators, and a byte-only difference
// (ordering, formatting, duplicates, extra fields) fails as well. Every type in
// the sidecar must also appear literally in docs/protocol/06-events.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SIDECAR = 'docs/protocol/event-types.json';
export const EVENTS_DOC = 'docs/protocol/06-events.md';
export const VENDORED_COPIES = [
  'packages/intentd/crates/intent-core/tests/goldens/event_types.json',
  'packages/ios/IntentTests/Fixtures/event_types.json',
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function asStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function setDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

// Semantic differences between two catalogs, as human-readable sentences. An
// empty array means the catalogs agree on types and discriminators; byte
// identity is checked separately by `inspectRepository`.
export function diffCatalogs(expected, actual) {
  const differences = [];
  if (expected.version !== actual.version) {
    differences.push(`version ${JSON.stringify(actual.version)} differs from ${JSON.stringify(expected.version)}`);
  }

  const expectedTypes = asStringList(expected.types);
  const actualTypes = asStringList(actual.types);
  for (const type of setDifference(expectedTypes, actualTypes)) differences.push(`missing type ${type}`);
  for (const type of setDifference(actualTypes, expectedTypes)) differences.push(`unexpected type ${type}`);

  const expectedDiscriminators = expected.discriminators ?? {};
  const actualDiscriminators = actual.discriminators ?? {};
  for (const type of Object.keys(expectedDiscriminators)) {
    if (!(type in actualDiscriminators)) {
      differences.push(`missing discriminator for ${type}`);
      continue;
    }
    const want = expectedDiscriminators[type];
    const have = actualDiscriminators[type];
    for (const field of ['path', 'kind', 'absent']) {
      if (want[field] !== have[field]) {
        differences.push(`discriminator ${type}.${field} ${JSON.stringify(have[field])} differs from ${JSON.stringify(want[field])}`);
      }
    }
    for (const value of setDifference(asStringList(want.values), asStringList(have.values))) {
      differences.push(`discriminator ${type} missing value ${value}`);
    }
    for (const value of setDifference(asStringList(have.values), asStringList(want.values))) {
      differences.push(`discriminator ${type} unexpected value ${value}`);
    }
  }
  for (const type of Object.keys(actualDiscriminators)) {
    if (!(type in expectedDiscriminators)) differences.push(`unexpected discriminator for ${type}`);
  }
  return differences;
}

// Sidecar types that do not appear literally in the events doc.
export function undocumentedTypes(catalog, doc) {
  return asStringList(catalog.types).filter((type) => !doc.includes(type));
}

export const BYTE_MISMATCH = `not byte-identical to ${SIDECAR} (ordering, formatting, duplicate, or extra field)`;

export async function inspectRepository(root) {
  root = path.resolve(root);
  const sidecarBytes = await fs.readFile(path.join(root, SIDECAR));
  const sidecar = JSON.parse(sidecarBytes.toString('utf8'));
  const failures = [];
  const skipped = [];

  for (const copy of VENDORED_COPIES) {
    const copyPath = path.join(root, copy);
    if (!(await isFile(copyPath))) {
      skipped.push(copy);
      continue;
    }
    const copyBytes = await fs.readFile(copyPath);
    if (copyBytes.equals(sidecarBytes)) continue;
    const differences = diffCatalogs(sidecar, JSON.parse(copyBytes.toString('utf8')));
    for (const difference of differences) failures.push({ source: copy, message: difference });
    if (differences.length === 0) failures.push({ source: copy, message: BYTE_MISMATCH });
  }

  const doc = await fs.readFile(path.join(root, EVENTS_DOC), 'utf8');
  for (const type of undocumentedTypes(sidecar, doc)) {
    failures.push({ source: EVENTS_DOC, message: `type ${type} from ${SIDECAR} is not mentioned` });
  }
  return { failures, skipped };
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const { failures, skipped } = await inspectRepository(root);
  for (const copy of skipped) console.log(`skipped: ${copy} (submodule not initialized)`);
  if (failures.length === 0) {
    const checked = VENDORED_COPIES.length - skipped.length;
    console.log(`Event catalog is in sync; checked ${checked} vendored cop${checked === 1 ? 'y' : 'ies'} and ${EVENTS_DOC}.`);
    return;
  }
  for (const failure of failures) console.error(`${failure.source}: ${failure.message}`);
  console.error(`check-event-catalog: ${failures.length} error(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
