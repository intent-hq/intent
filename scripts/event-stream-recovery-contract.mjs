#!/usr/bin/env node
// Event-stream recovery contract (docs/protocol/fixtures/event-stream-recovery/contract.json):
// intentd's transport and e2e tests keep an exact single-file copy through the shared
// fixture-copy tool (scripts/lib/fixture-copy.mjs) with commit provenance. The
// cases themselves are checked by the fixture's own tests under docs/protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/event-stream-recovery/contract.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const COPY = defineFixtureCopy({
  name: 'event-stream-recovery',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    intentd: {
      file: 'crates/intent-transport/src/events/fixtures/event-stream-recovery.json',
      lock: 'crates/intent-transport/src/events/fixtures/event-stream-recovery.lock.json',
    },
  },
  validate: (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireValue(Array.isArray(fixture.scenarios) && Array.isArray(fixture.requestValidation),
      `${SOURCE_PATH}: scenarios and requestValidation must be arrays`);
    return `${fixture.scenarios.length} scenarios, ${fixture.requestValidation.length} request validation cases`;
  },
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'event-stream-recovery-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'event-stream-recovery-contract', () => main());
