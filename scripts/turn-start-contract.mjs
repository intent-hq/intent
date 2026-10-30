#!/usr/bin/env node
// Turn-start events (docs/protocol/fixtures/turn-start/turn-start-events.json):
// every daemon event PROTOCOL §6.5/§6.6 names as the start of an agent turn,
// with one replayable example each. cloudlands-fe keeps an exact single-file
// copy through the shared fixture-copy tool (scripts/lib/fixture-copy.mjs) and
// replays every entry through its events bridge, so a protocol-named turn-start
// event the client ignores fails a test instead of shipping (the queued-message
// Thinking-indicator delay fixed by cloudlands-fe#3849).
//
// The canonical file is checked against the event catalog
// (docs/protocol/event-types.json) and the §6.6 "Turn-start signals" table in
// docs/protocol/06-events.md, so the docs, the catalog and the fixture name the
// same events.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { defineFixtureCopy, fixtureCopyMain, readJsonBytes, requireValue, runScript } from './lib/fixture-copy.mjs';
import { scanMarkdown } from './lib/markdown-tables.mjs';

export const SOURCE_PATH = 'docs/protocol/fixtures/turn-start/turn-start-events.json';
export const CATALOG_PATH = 'docs/protocol/event-types.json';
export const DOCS_PATH = 'docs/protocol/06-events.md';
export const DOCS_SECTION = '6.6 Turn/event lifecycle & batching window';
export const TABLE_HEADER = ['Turn-start event', 'Condition', 'Turn', 'Fixture id'];
/** §6.6 turn kinds: a harness-wake turn, a daemon-dispatched session/prompt turn, or either. */
export const TURN_KINDS = ['agent-initiated', 'prompt', 'any'];
/** Turn-start events that must never silently disappear from the fixture. */
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

/** Validate a parsed fixture against the catalog's event types; returns the entries. */
export function validateFixture(doc, eventTypes) {
  keys(doc, ['fixtureFormatVersion', 'description', 'events'], [], 'turn-start fixture');
  requireValue(doc.fixtureFormatVersion === 1, 'fixtureFormatVersion must be 1');
  nonEmptyString(doc.description, 'description');
  requireValue(Array.isArray(doc.events) && doc.events.length > 0, 'events must be a non-empty array');
  const catalog = new Set(eventTypes);
  const ids = new Set();
  for (const [index, entry] of doc.events.entries()) {
    const label = `events[${index}]${typeof entry?.id === 'string' ? ` (${entry.id})` : ''}`;
    keys(entry, ['id', 'type', 'turn', 'event'], ['match'], label);
    requireValue(typeof entry.id === 'string' && ID.test(entry.id), `${label}: id must be kebab-case`);
    requireValue(!ids.has(entry.id), `${label}: duplicate id ${entry.id}`);
    ids.add(entry.id);
    nonEmptyString(entry.type, `${label}: type`);
    requireValue(catalog.has(entry.type), `${label}: type ${entry.type} is not in ${CATALOG_PATH}`);
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
  const types = new Set(doc.events.map((entry) => entry.type));
  const missing = REQUIRED_TYPES.filter((type) => !types.has(type));
  requireValue(missing.length === 0, `required turn-start events missing from the fixture: ${missing.join(', ')}`);
  return doc.events;
}

const code = (cell) => /^`([^`]+)`$/.exec(cell)?.[1];

/** The §6.6 "Turn-start signals" table rows as { type, condition, turn, id }. */
export function readDocsTable(markdown) {
  const scan = scanMarkdown(markdown);
  const start = scan.headings.find((heading) => heading.text === DOCS_SECTION);
  requireValue(start, `${DOCS_PATH}: heading "${DOCS_SECTION}" not found`);
  const end = scan.headings.find((heading) => heading.line > start.line && heading.level <= start.level)?.line ?? Infinity;
  const tables = scan.tables.filter((table) => table.headerLine > start.line && table.headerLine < end
    && isDeepStrictEqual(table.header, TABLE_HEADER));
  requireValue(tables.length === 1,
    `${DOCS_PATH} §6.6 must hold exactly one table headed | ${TABLE_HEADER.join(' | ')} |, found ${tables.length}`);
  return tables[0].rows.map(({ line, cells }) => {
    const [type, condition, turn, id] = cells.map(code);
    requireValue(cells.length === TABLE_HEADER.length && type && turn && id && cells[1].length > 0,
      `${DOCS_PATH}:${line}: a turn-start row needs \`event\`, a condition, \`turn\` and \`fixture id\``);
    return { type, condition, turn, id };
  });
}

/** The docs table lists exactly the fixture's entries, in order. */
export function validateDocsTable(markdown, events) {
  const rows = readDocsTable(markdown).map(({ type, turn, id }) => ({ id, type, turn }));
  const expected = events.map(({ id, type, turn }) => ({ id, type, turn }));
  requireValue(isDeepStrictEqual(rows, expected),
    `${DOCS_PATH} §6.6 Turn-start signals table must list the fixture's entries (id, type, turn) in order:\n`
    + `  table:   ${JSON.stringify(rows)}\n  fixture: ${JSON.stringify(expected)}`);
}

/** Validate the canonical fixture at `file` (under a monorepo-shaped root); returns a summary. */
export function validateCanonical(file) {
  const root = file.slice(0, -SOURCE_PATH.length);
  requireValue(path.resolve(file) === path.resolve(root, SOURCE_PATH), `${file} is not ${SOURCE_PATH}`);
  const doc = readJsonBytes(fs.readFileSync(file), SOURCE_PATH);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, CATALOG_PATH), 'utf8'));
  requireValue(Array.isArray(catalog?.types), `${CATALOG_PATH}: types must be an array`);
  const events = validateFixture(doc, catalog.types);
  validateDocsTable(fs.readFileSync(path.join(root, DOCS_PATH), 'utf8'), events);
  return `${events.length} events`;
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
  validate: validateCanonical,
});

export function main(args = process.argv.slice(2), options = {}) {
  return fixtureCopyMain(COPY, args, { script: 'turn-start-contract.mjs', defaultRoot: ROOT, ...options });
}

runScript(import.meta.url, 'turn-start-contract', () => main());
