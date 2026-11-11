#!/usr/bin/env node
// Compact script rows and pages (docs/protocol/fixtures/scripts/compact.json):
// intentd's MCP binding tests keep an exact single-file copy through the shared
// fixture-copy tool (scripts/lib/fixture-copy.mjs) with commit provenance. The
// cases themselves are checked by the fixture's own tests under docs/protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/scripts/compact.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const COPY = defineFixtureCopy({
  name: 'scripts-compact',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    intentd: {
      file: 'crates/intent-acp/tests/fixtures/scripts-compact.json',
      lock: 'crates/intent-acp/tests/fixtures/scripts-compact.lock.json',
    },
  },
  validate: (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireValue(Array.isArray(fixture.examples) && fixture.examples.length > 0, `${SOURCE_PATH}: examples must be a non-empty array`);
    return `${fixture.examples.length} examples, ${fixture.componentScenarios?.length ?? 0} component scenarios`;
  },
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'scripts-compact-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'scripts-compact-contract', () => main());
