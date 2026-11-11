#!/usr/bin/env node
// Truncated note read vectors (docs/protocol/fixtures/notes/truncated-read.json):
// intentd's cut-rule tests keep an exact single-file copy through the shared
// fixture-copy tool (scripts/lib/fixture-copy.mjs) with commit provenance. The
// cases themselves are checked by the fixture's own tests under docs/protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/notes/truncated-read.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const COPY = defineFixtureCopy({
  name: 'note-truncated-read',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    intentd: {
      file: 'crates/intent-core/tests/fixtures/truncated-read.json',
      lock: 'crates/intent-core/tests/fixtures/truncated-read.lock.json',
    },
  },
  validate: (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireValue(Array.isArray(fixture.cases) && fixture.cases.length > 0, `${SOURCE_PATH}: cases must be a non-empty array`);
    return `${fixture.cases.length} cases`;
  },
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'note-truncated-read-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'note-truncated-read-contract', () => main());
