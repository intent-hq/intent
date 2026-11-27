import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTERED } from './check-fixture-copies.mjs';
import { COPY, DEFAULT_PROFILE, SOURCE_PATH, main, validateFixture } from './hello-capabilities-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const canonical = () => JSON.parse(read(SOURCE_PATH));
const profile = (doc, id) => doc.profiles.find((entry) => entry.id === id);
const rejects = (edit, pattern) => {
  const doc = canonical();
  edit(doc);
  assert.throws(() => validateFixture(doc), pattern);
};

test('the canonical fixture is valid and carries the default profile', () => {
  assert.match(main(['validate']), /^hello-capabilities: canonical valid \(.*regular.*profiles\)$/);
  assert.ok(profile(canonical(), DEFAULT_PROFILE));
});

test('the copy contract imports only the shared fixture-copy tool, so component CI can sparse-check it out', () => {
  const imports = [...read('scripts/hello-capabilities-contract.mjs').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((specifier) => specifier.startsWith('.')), ['./lib/fixture-copy.mjs']);
});

test('intentd and cloudlands-fe keep registered single-file commit copies', () => {
  assert.ok(REGISTERED.includes(COPY));
  assert.equal(COPY.provenance, 'commit');
  assert.deepEqual(COPY.components, ['intentd', 'cloudlands-fe']);
});

test('a profile whose flags disagree with its capabilities fails', () => {
  rejects((doc) => { profile(doc, 'regular').remoteMachines = false; }, /capabilities.remoteMachines must match remoteMachines/);
  rejects((doc) => { delete profile(doc, 'regular').capabilities.startupStatus; }, /capabilities.startupStatus must match startupStatus/);
});

test('a version bump of a flagged capability stays valid', () => {
  const doc = canonical();
  profile(doc, 'regular').capabilities.startupStatus = 2;
  profile(doc, 'regular').capabilities.remoteMachines = 3;
  assert.doesNotThrow(() => validateFixture(doc));
});

test('unsorted, malformed or false capabilities fail', () => {
  rejects((doc) => {
    const entry = profile(doc, 'regular');
    entry.capabilities = Object.fromEntries(Object.entries(entry.capabilities).reverse());
  }, /must be sorted by name/);
  rejects((doc) => { profile(doc, 'regular').capabilities.agentRetire = 0; }, /agentRetire must be true or a positive integer/);
  rejects((doc) => { profile(doc, 'regular').capabilities.agentRetire = '1'; }, /agentRetire must be true or a positive integer/);
});

test('a fixture without the default profile, or with an unknown mode, fails', () => {
  rejects((doc) => { doc.profiles = doc.profiles.filter((entry) => entry.id !== DEFAULT_PROFILE); }, /must include regular/);
  rejects((doc) => { profile(doc, 'node').daemonMode = 'edge'; }, /daemonMode must be one of/);
  rejects((doc) => { profile(doc, 'node').id = 'regular'; }, /duplicate id/);
});
