#!/usr/bin/env node
// Browser-routing (REV-2) worked cases: the component copy goes through the
// shared fixture-copy tool (scripts/lib/fixture-copy.mjs) with revision
// provenance. The cases themselves are checked against the documented rules by
// docs/protocol/fixtures/browser-routing/contract.test.mjs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/browser-routing/routing.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const COPY = defineFixtureCopy({
  name: 'browser-routing',
  sourcePath: SOURCE_PATH,
  provenance: 'revision',
  copies: {
    intentd: { file: 'crates/intent-transport/tests/fixtures/browser-routing.json' },
  },
  validate: (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireValue(fixture.schema === 'browser-routing/v1', `${SOURCE_PATH}: schema must be browser-routing/v1`);
    requireValue(Array.isArray(fixture.cases) && fixture.cases.length > 0, `${SOURCE_PATH}: cases must be a non-empty array`);
    return `${fixture.cases.length} cases`;
  },
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'browser-routing-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'browser-routing-contract', () => main());
