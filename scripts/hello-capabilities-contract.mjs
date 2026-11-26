#!/usr/bin/env node
// client.hello capabilities (docs/protocol/fixtures/hello/capabilities.json):
// the server.capabilities a successful hello announces, one profile per daemon
// composition. intentd generates the file from its hello builder and a golden
// test fails when the code and its copy disagree; cloudlands-fe's fake daemon
// announces the `regular` profile from its copy, so frontend tests that boot the
// whole app see the same features a real daemon turns on. Both copies are exact
// single-file copies through the shared fixture-copy tool
// (scripts/lib/fixture-copy.mjs) with commit provenance.
//
// Component CI checks out only this script, the fixture and
// scripts/lib/fixture-copy.mjs, so it imports nothing else.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineFixtureCopy, fixtureCopyMain, readJsonBytes, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/hello/capabilities.json';
/** The profile a client test double announces by default. */
export const DEFAULT_PROFILE = 'regular';
export const DAEMON_MODES = ['regular', 'node', 'orchestrator'];
const PROFILE_KEYS = ['id', 'description', 'daemonMode', 'startupStatus', 'remoteMachines', 'capabilities'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CAPABILITY = /^[a-z][A-Za-z0-9]*$/;

function exactKeys(value, expected, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value);
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys must be ${expected.join(', ')} in that order, got ${actual.join(', ')}`);
}

/** Validate a parsed fixture on its own; returns its profiles. */
export function validateFixture(doc) {
  exactKeys(doc, ['fixtureFormatVersion', 'description', 'profiles'], 'hello capabilities fixture');
  requireValue(doc.fixtureFormatVersion === 1, 'fixtureFormatVersion must be 1');
  requireValue(typeof doc.description === 'string' && doc.description.length > 0, 'description must be a non-empty string');
  requireValue(Array.isArray(doc.profiles) && doc.profiles.length > 0, 'profiles must be a non-empty array');
  const ids = new Set();
  for (const [index, profile] of doc.profiles.entries()) {
    const label = `profiles[${index}]${typeof profile?.id === 'string' ? ` (${profile.id})` : ''}`;
    exactKeys(profile, PROFILE_KEYS, label);
    requireValue(typeof profile.id === 'string' && /^[a-z]+(?:-[a-z]+)*$/.test(profile.id), `${label}: id must be kebab-case`);
    requireValue(!ids.has(profile.id), `${label}: duplicate id`);
    ids.add(profile.id);
    requireValue(typeof profile.description === 'string' && profile.description.length > 0, `${label}: description must be a non-empty string`);
    requireValue(DAEMON_MODES.includes(profile.daemonMode), `${label}: daemonMode must be one of ${DAEMON_MODES.join(', ')}`);
    requireValue(typeof profile.startupStatus === 'boolean', `${label}: startupStatus must be a boolean`);
    requireValue(typeof profile.remoteMachines === 'boolean', `${label}: remoteMachines must be a boolean`);
    const names = Object.keys(profile.capabilities ?? {});
    requireValue(profile.capabilities !== null && typeof profile.capabilities === 'object' && !Array.isArray(profile.capabilities)
      && names.length > 0, `${label}: capabilities must be a non-empty object`);
    requireValue(JSON.stringify(names) === JSON.stringify([...names].sort()), `${label}: capabilities must be sorted by name`);
    for (const name of names) {
      const value = profile.capabilities[name];
      requireValue(CAPABILITY.test(name), `${label}: capability ${name} must be lowerCamelCase`);
      requireValue(value === true || (Number.isInteger(value) && value >= 1),
        `${label}: capability ${name} must be true or a positive integer, got ${JSON.stringify(value)}`);
    }
    requireValue((profile.capabilities.startupStatus === 1) === profile.startupStatus,
      `${label}: capabilities.startupStatus must match startupStatus`);
    requireValue((profile.capabilities.remoteMachines === 1) === profile.remoteMachines,
      `${label}: capabilities.remoteMachines must match remoteMachines`);
  }
  requireValue(ids.has(DEFAULT_PROFILE), `profiles must include ${DEFAULT_PROFILE}`);
  return doc.profiles;
}

/** Read and validate the fixture file at `file`; returns its profiles. */
export function readFixture(file) {
  return validateFixture(readJsonBytes(fs.readFileSync(file), SOURCE_PATH));
}

export const COPY = defineFixtureCopy({
  name: 'hello-capabilities',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    intentd: {
      file: 'crates/intent-transport/tests/fixtures/hello-capabilities.json',
      lock: 'crates/intent-transport/tests/fixtures/hello-capabilities.lock.json',
    },
    'cloudlands-fe': {
      file: 'tests/fixtures/hello-capabilities.json',
      lock: 'tests/fixtures/hello-capabilities.lock.json',
    },
  },
  validate: (file) => `${readFixture(file).map((profile) => profile.id).join(', ')} profiles`,
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'hello-capabilities-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'hello-capabilities-contract', () => main());
