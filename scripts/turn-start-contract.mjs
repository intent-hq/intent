#!/usr/bin/env node
// Turn-start events (docs/protocol/fixtures/turn-start/turn-start-events.json):
// the daemon events PROTOCOL §6.6 names as the start of an agent turn, with one
// replayable example each. A component keeps an exact single-file copy through
// the shared fixture-copy tool (scripts/lib/fixture-copy.mjs) and replays every
// entry through its event handling, so a protocol-named turn-start event the
// client ignores fails a test instead of shipping (the queued-message
// Thinking-indicator delay fixed by cloudlands-fe#3849).
//
// This file checks the fixture on its own. Component CI checks out only this
// script, the fixture and scripts/lib/fixture-copy.mjs, so it imports nothing
// else. scripts/check-turn-start-contract.mjs (make check-turn-start-contract)
// adds the cross-checks against event-types.json and the §6.6 table.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { defineFixtureCopy, fixtureCopyMain, readJsonBytes, requireValue, runScript } from './lib/fixture-copy.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/turn-start/turn-start-events.json';
/** §6.6 turn kinds: a harness-wake turn, a daemon-dispatched session/prompt turn, or either. */
export const TURN_KINDS = ['agent-initiated', 'prompt', 'any'];
/**
 * The fixture's event types, exactly. A turn-start event cannot be dropped, and
 * a new one cannot be added, without changing this list as well as the fixture
 * and the §6.6 table.
 */
export const REQUIRED_TYPES = ['agent:stream:start', 'agent:status-changed', 'agent:stream:activity', 'agent:queue:processing'];
export const EVENT_KEYS = ['type', 'workspaceId', 'id', 'timestamp', 'actor', 'data'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function object(value, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}
function keys(value, required, optional, label) {
  object(value, label);
  const actual = Object.keys(value);
  for (const key of required) requireValue(actual.includes(key), `${label} is missing ${key}`);
  for (const key of actual) requireValue(required.includes(key) || optional.includes(key), `${label} has unknown key ${key}`);
}
function nonEmptyString(value, label) {
  requireValue(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`);
}

/** The value at dotted `pathText` inside `value`, or undefined. */
export function resolvePath(value, pathText) {
  return pathText.split('.').reduce((node, key) => (node !== null && typeof node === 'object' && Object.hasOwn(node, key)
    ? node[key] : undefined), value);
}

/** Validate a parsed fixture on its own; returns its entries. */
export function validateFixture(doc) {
  keys(doc, ['fixtureFormatVersion', 'description', 'events'], [], 'turn-start fixture');
  requireValue(doc.fixtureFormatVersion === 1, 'fixtureFormatVersion must be 1');
  nonEmptyString(doc.description, 'description');
  requireValue(Array.isArray(doc.events) && doc.events.length > 0, 'events must be a non-empty array');
  const ids = new Set();
  for (const [index, entry] of doc.events.entries()) {
    const label = `events[${index}]${typeof entry?.id === 'string' ? ` (${entry.id})` : ''}`;
    keys(entry, ['id', 'type', 'turn', 'event'], ['match'], label);
    requireValue(typeof entry.id === 'string' && ID.test(entry.id), `${label}: id must be kebab-case`);
    requireValue(!ids.has(entry.id), `${label}: duplicate id ${entry.id}`);
    ids.add(entry.id);
    nonEmptyString(entry.type, `${label}: type`);
    requireValue(TURN_KINDS.includes(entry.turn), `${label}: turn must be one of ${TURN_KINDS.join(', ')}, got ${JSON.stringify(entry.turn)}`);
    const { event } = entry;
    keys(event, EVENT_KEYS, [], `${label}: event`);
    requireValue(event.type === entry.type, `${label}: event.type ${JSON.stringify(event.type)} must equal type ${entry.type}`);
    nonEmptyString(event.workspaceId, `${label}: event.workspaceId`);
    nonEmptyString(event.id, `${label}: event.id`);
    requireValue(typeof event.timestamp === 'string' && ISO.test(event.timestamp), `${label}: event.timestamp must be an ISO-8601 UTC timestamp`);
    object(event.actor, `${label}: event.actor`);
    object(event.data, `${label}: event.data`);
    nonEmptyString(event.data.agentId, `${label}: event.data.agentId`);
    if (entry.turn === 'agent-initiated') {
      nonEmptyString(event.data.messageId, `${label}: an agent-initiated turn opens its assistant message, so event.data.messageId`);
    }
    if (entry.match !== undefined) {
      object(entry.match, `${label}: match`);
      requireValue(Object.keys(entry.match).length > 0, `${label}: match must name at least one path`);
      for (const [pathText, expected] of Object.entries(entry.match)) {
        requireValue(expected === null || ['string', 'number', 'boolean'].includes(typeof expected),
          `${label}: match ${pathText} must be a JSON scalar`);
        requireValue(isDeepStrictEqual(resolvePath(event, pathText), expected),
          `${label}: match ${pathText} expects ${JSON.stringify(expected)} but event has ${JSON.stringify(resolvePath(event, pathText))}`);
      }
    }
  }
  const types = [...new Set(doc.events.map((entry) => entry.type))];
  const missing = REQUIRED_TYPES.filter((type) => !types.includes(type));
  requireValue(missing.length === 0, `required turn-start events missing from the fixture: ${missing.join(', ')}`);
  const extra = types.filter((type) => !REQUIRED_TYPES.includes(type));
  requireValue(extra.length === 0,
    `fixture event types not in REQUIRED_TYPES (scripts/turn-start-contract.mjs): ${extra.join(', ')}; add them there too`);
  return doc.events;
}

/** Read and validate the fixture file at `file`; returns its entries. */
export function readFixture(file) {
  return validateFixture(readJsonBytes(fs.readFileSync(file), SOURCE_PATH));
}

export const COPY = defineFixtureCopy({
  name: 'turn-start',
  sourcePath: SOURCE_PATH,
  provenance: 'commit',
  copies: {
    'cloudlands-fe': {
      file: 'tests/fixtures/turn-start-events.json',
      lock: 'tests/fixtures/turn-start-events.lock.json',
    },
  },
  validate: (file) => `${readFixture(file).length} events`,
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'turn-start-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'turn-start-contract', () => main());
