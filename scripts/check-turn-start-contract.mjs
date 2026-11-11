#!/usr/bin/env node
// Cross-checks the turn-start events fixture (scripts/turn-start-contract.mjs)
// against the protocol: every entry's type is in docs/protocol/event-types.json,
// and the §6.6 "Turn-start signals" table in docs/protocol/06-events.md lists
// exactly the fixture's entries, in order, with the same turn kind and the same
// payload conditions (each `match` path written as a `path: value` code span in
// the Condition cell). Run by `make check-turn-start-contract`, part of
// `make consumer-checks`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { requireValue, runScript } from './lib/fixture-copy.mjs';
import { scanMarkdown } from './lib/markdown-tables.mjs';
import { SOURCE_PATH, readFixture } from './turn-start-contract.mjs';

export const CATALOG_PATH = 'docs/protocol/event-types.json';
export const DOCS_PATH = 'docs/protocol/06-events.md';
export const DOCS_SECTION = '6.6 Turn/event lifecycle & batching window';
export const TABLE_HEADER = ['Turn-start event', 'Condition', 'Turn', 'Fixture id'];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONDITION = /^(data(?:\.[A-Za-z0-9_]+)+): (.+)$/;

const code = (cell) => /^`([^`]+)`$/.exec(cell)?.[1];

/** The `path: value` code spans of a Condition cell, as a { path: value } object. */
export function conditionMatch(cell, label) {
  const match = {};
  for (const [, span] of cell.matchAll(/`([^`]+)`/g)) {
    const parts = CONDITION.exec(span);
    if (!parts) continue;
    let value;
    try {
      value = JSON.parse(parts[2]);
    } catch {
      throw new Error(`${label}: condition \`${span}\` must be \`path: <JSON value>\``);
    }
    requireValue(!Object.hasOwn(match, parts[1]), `${label}: condition names ${parts[1]} twice`);
    match[parts[1]] = value;
  }
  return match;
}

/** The §6.6 "Turn-start signals" table rows as { type, condition, match, turn, id }. */
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
    const [type, turn, id] = [cells[0], cells[2], cells[3]].map((cell) => (cell === undefined ? undefined : code(cell)));
    const condition = cells[1] ?? '';
    requireValue(cells.length === TABLE_HEADER.length && type && turn && id && condition.length > 0,
      `${DOCS_PATH}:${line}: a turn-start row needs \`event\`, a condition, \`turn\` and \`fixture id\``);
    return { type, condition, match: conditionMatch(condition, `${DOCS_PATH}:${line}`), turn, id };
  });
}

/** The docs table lists exactly the fixture's entries, in order, with the same conditions. */
export function validateDocsTable(markdown, events) {
  const rows = readDocsTable(markdown).map(({ id, type, turn, match }) => ({ id, type, turn, match }));
  const expected = events.map(({ id, type, turn, match = {} }) => ({ id, type, turn, match }));
  requireValue(isDeepStrictEqual(rows, expected),
    `${DOCS_PATH} §6.6 Turn-start signals table must list the fixture's entries (id, type, turn, match) in order:\n`
    + `  table:   ${JSON.stringify(rows)}\n  fixture: ${JSON.stringify(expected)}`);
}

/** Every fixture type is a cataloged event type. */
export function validateCatalog(catalog, events) {
  requireValue(Array.isArray(catalog?.types), `${CATALOG_PATH}: types must be an array`);
  const known = new Set(catalog.types);
  for (const entry of events) {
    requireValue(known.has(entry.type), `${SOURCE_PATH} ${entry.id}: type ${entry.type} is not in ${CATALOG_PATH}`);
  }
}

/** Check the fixture, catalog and docs under monorepo `root`; returns a summary. */
export function checkTurnStartContract(root = ROOT) {
  const events = readFixture(path.join(root, SOURCE_PATH));
  validateCatalog(JSON.parse(fs.readFileSync(path.join(root, CATALOG_PATH), 'utf8')), events);
  validateDocsTable(fs.readFileSync(path.join(root, DOCS_PATH), 'utf8'), events);
  return `turn-start contract: ${events.length} events agree with ${CATALOG_PATH} and the ${DOCS_PATH} §6.6 table`;
}

runScript(import.meta.url, 'check-turn-start-contract', () => {
  requireValue(process.argv.length === 2, 'usage: check-turn-start-contract.mjs');
  return checkTurnStartContract();
});
