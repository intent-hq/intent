#!/usr/bin/env node

// Table cell-count check for the protocol docs.
//
// GitHub splits a table cell at every unescaped `|`, even inside a backtick
// code span, and renders only as many cells as the header row has, so a stray
// pipe silently hides the rest of the row. Before intent#7472 about 24,000
// characters of the agent.list docs and the whole agent.delegate result in
// methods/agents.md were invisible on GitHub this way. Write `\|` for a
// literal pipe inside a cell.
//
// Scanned: every `docs/protocol/**/*.md`, read by the shared GFM scanner in
// scripts/lib/markdown-tables.mjs, so tables, lazy rows, block boundaries and
// fenced code are exactly the ones GitHub renders. Every body row must have as
// many cells as its header. A delimiter row whose cell count differs from the
// header is reported too: GitHub then renders the whole table as plain text.
// The walk fails closed: an unreadable directory or a symlink is an error.
//
// Usage:
//   node scripts/check-doc-table-cells.mjs               # exit 1 on any finding
//   --root <dir>  scan another checkout (tests)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { markdownFilesBelow } from './check-doc-line-length.mjs';
import { scanMarkdown } from './lib/markdown-tables.mjs';

export const SCAN_DIR = 'docs/protocol';

/** `[{ line, cells, header, headerLine }]` for every table row whose cell count differs from its header's. */
export function mismatchedRows(text) {
  const { tables, brokenTables } = scanMarkdown(text);
  const found = brokenTables.map((t) => ({ line: t.delimiterLine, cells: t.delimiter.length, header: t.header.length, headerLine: t.headerLine }));
  for (const t of tables) {
    for (const row of t.rows) {
      if (row.cells.length !== t.header.length) found.push({ line: row.line, cells: row.cells.length, header: t.header.length, headerLine: t.headerLine });
    }
  }
  return found.sort((x, y) => x.line - y.line);
}

/** Run the check against `root`; returns error strings (empty when every table is consistent). */
export async function check(root) {
  const files = (await markdownFilesBelow(root, SCAN_DIR)).sort();
  const findings = [];
  for (const file of files) {
    for (const m of mismatchedRows(await fs.readFile(path.join(root, file), 'utf8'))) {
      findings.push(`${file}:${m.line}: error: table row has ${m.cells} cell(s), its header (line ${m.headerLine}) has ${m.header}; escape a literal pipe inside a cell as \\|`);
    }
  }
  return findings;
}

async function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && i + 1 < argv.length) root = path.resolve(argv[++i]);
    else {
      process.stderr.write('usage: check-doc-table-cells.mjs [--root <dir>]\n');
      return 2;
    }
  }
  try {
    const findings = await check(root);
    if (findings.length > 0) {
      process.stderr.write(`error: table rows in ${SCAN_DIR}/**/*.md do not match their header's cell count (GitHub drops the extra cells):\n${findings.join('\n')}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
