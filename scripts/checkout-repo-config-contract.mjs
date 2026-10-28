#!/usr/bin/env node
// Checkout repository-config wire golden (docs/protocol/fixtures/checkout-repo-config.json):
// intentd's serialization test keep an exact single-file copy through the shared
// fixture-copy tool (scripts/lib/fixture-copy.mjs) with commit provenance. The
// cases themselves are checked by the fixture's own tests under docs/protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/checkout-repo-config.json';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const COPY = defineFixtureCopy({
  name: 'checkout-repo-config',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    intentd: {
      file: 'crates/intent-core/tests/goldens/checkout_repo_config.json',
      lock: 'crates/intent-core/tests/goldens/checkout_repo_config.lock.json',
    },
  },
  validate: (file) => {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    requireValue(fixture.request?.method === 'sourceControl.checkout.repoConfig',
      `${SOURCE_PATH}: request.method must be sourceControl.checkout.repoConfig`);
    return ['ready', 'absent', 'unavailable'].filter((key) => key in fixture).join(', ');
  },
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'checkout-repo-config-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'checkout-repo-config-contract', () => main());
