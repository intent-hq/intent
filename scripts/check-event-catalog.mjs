#!/usr/bin/env node

// Check that the event-type catalog agrees on every surface that vendors it:
// the intentd golden (source of truth, generated from
// intent_core::events::ALL_EVENT_TYPES), the protocol sidecar
// docs/protocol/event-types.json, and the iOS test fixture. A vendored copy that
// is missing because its submodule is not initialized is skipped. The sidecar
// may LEAD a vendored copy — a copy that lacks a type, a discriminator, or a
// discriminator value the sidecar carries is a warning ("docs lead the pin"),
// the intended fix order: land the monorepo docs PR first, then the intentd PR,
// and the submodule bump lands green. A copy that carries something the sidecar
// lacks, or that differs in version / path / kind / absent, is an error naming
// the monorepo files to update. When a copy and the sidecar are semantically
// equal they must still be byte-identical — a byte-only difference (ordering,
// formatting, duplicates, extra fields) fails. Every type in the sidecar must
// also appear literally in docs/protocol/06-events.md.

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

// "Docs ahead of pin" is the intended ordering (land the sidecar first, then the intentd PR), so
// a copy lagging the sidecar is a warning; it only signals a real problem if no intentd change
// ever ships the type.
export const LEAD_HINT = 'docs lead the pin';
// A copy carrying something the sidecar lacks is the pin ahead of the docs: the monorepo files
// are the ones to update.
export const FIX_HINT = `update ${SIDECAR} (copy the intentd golden) and document the type in ${EVENTS_DOC}`;

// Semantic differences between two catalogs as `{ errors, warnings }` of
// human-readable sentences. `expected` is the sidecar and `actual` a vendored
// copy: something the sidecar carries and the copy lacks is a warning (the
// sidecar may lead), everything else is an error. Both empty means the
// catalogs agree on types and discriminators; byte identity is checked
// separately by `inspectRepository`.
export function diffCatalogs(expected, actual) {
  const errors = [];
  const warnings = [];
  if (expected.version !== actual.version) {
    errors.push(`version ${JSON.stringify(actual.version)} differs from ${JSON.stringify(expected.version)}`);
  }

  const expectedTypes = asStringList(expected.types);
  const actualTypes = asStringList(actual.types);
  for (const type of setDifference(expectedTypes, actualTypes)) warnings.push(`missing type ${type}`);
  for (const type of setDifference(actualTypes, expectedTypes)) errors.push(`unexpected type ${type}`);

  const expectedDiscriminators = expected.discriminators ?? {};
  const actualDiscriminators = actual.discriminators ?? {};
  for (const type of Object.keys(expectedDiscriminators)) {
    if (!(type in actualDiscriminators)) {
      warnings.push(`missing discriminator for ${type}`);
      continue;
    }
    const want = expectedDiscriminators[type];
    const have = actualDiscriminators[type];
    for (const field of ['path', 'kind', 'absent']) {
      if (want[field] !== have[field]) {
        errors.push(`discriminator ${type}.${field} ${JSON.stringify(have[field])} differs from ${JSON.stringify(want[field])}`);
      }
    }
    for (const value of setDifference(asStringList(want.values), asStringList(have.values))) {
      warnings.push(`discriminator ${type} missing value ${value}`);
    }
    for (const value of setDifference(asStringList(have.values), asStringList(want.values))) {
      errors.push(`discriminator ${type} unexpected value ${value}`);
    }
  }
  for (const type of Object.keys(actualDiscriminators)) {
    if (!(type in expectedDiscriminators)) errors.push(`unexpected discriminator for ${type}`);
  }
  return { errors, warnings };
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
  const warnings = [];
  const skipped = [];

  for (const copy of VENDORED_COPIES) {
    const copyPath = path.join(root, copy);
    if (!(await isFile(copyPath))) {
      skipped.push(copy);
      continue;
    }
    const copyBytes = await fs.readFile(copyPath);
    if (copyBytes.equals(sidecarBytes)) continue;
    const diff = diffCatalogs(sidecar, JSON.parse(copyBytes.toString('utf8')));
    for (const error of diff.errors) failures.push({ source: copy, message: `${error} — ${FIX_HINT}` });
    for (const warning of diff.warnings) warnings.push({ source: copy, message: `${warning} (${LEAD_HINT})` });
    if (diff.errors.length === 0 && diff.warnings.length === 0) failures.push({ source: copy, message: BYTE_MISMATCH });
  }

  const doc = await fs.readFile(path.join(root, EVENTS_DOC), 'utf8');
  for (const type of undocumentedTypes(sidecar, doc)) {
    failures.push({ source: EVENTS_DOC, message: `type ${type} from ${SIDECAR} is not mentioned` });
  }
  return { failures, warnings, skipped };
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const { failures, warnings, skipped } = await inspectRepository(root);
  for (const copy of skipped) console.log(`skipped: ${copy} (submodule not initialized)`);
  for (const warning of warnings) console.error(`${warning.source}: warning: ${warning.message}`);
  const warningSuffix = warnings.length ? `; ${warnings.length} warning(s): ${LEAD_HINT}` : '';
  if (failures.length === 0) {
    const checked = VENDORED_COPIES.length - skipped.length;
    console.log(`Event catalog is in sync; checked ${checked} vendored cop${checked === 1 ? 'y' : 'ies'} and ${EVENTS_DOC}${warningSuffix}.`);
    return;
  }
  for (const failure of failures) console.error(`${failure.source}: ${failure.message}`);
  console.error(`check-event-catalog: ${failures.length} error(s)${warningSuffix}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
