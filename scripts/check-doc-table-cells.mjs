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
// Scanned: every `docs/protocol/**/*.md`. A table is a header row holding an
// unescaped `|` followed by a delimiter row (`---`, `:--`, `--:`, `:-:` cells
// separated by `|`); its body is every following line up to a blank line or
// the start of another block (fence, heading, blockquote, list item, thematic
// break, HTML), so a lazy line without a leading pipe is a row too, as on
// GitHub. Fenced code blocks are skipped. Every delimiter and body row must
// have exactly as many cells as the header. The walk fails closed: an
// unreadable directory or a symlink is an error.
//
// Usage:
//   node scripts/check-doc-table-cells.mjs               # exit 1 on any finding
//   --root <dir>  scan another checkout (tests)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { markdownFilesBelow } from './check-doc-line-length.mjs';
import { tableCells } from './check-protocol-catalog.mjs';

export const SCAN_DIR = 'docs/protocol';

const DELIMITER_CELL_RE = /^:?-+:?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const UNESCAPED_PIPE_RE = /(^|[^\\])\|/;
// Block starts that end a table body (blank lines are handled separately).
const BLOCK_START_RE = /^ {0,3}(#{1,6}(\s|$)|>|[-*+](\s|$)|\d{1,9}[.)](\s|$)|<|([-*_])(\s*\5){2,}\s*$)/;

const strip = (raw) => raw.replace(/\r$/, '');
// A table row's cells; the leading pipe is optional, as in GFM.
const rowCells = (raw) => {
  const text = strip(raw).trim();
  return tableCells(text.startsWith('|') ? text : `|${text}`);
};
const isDelimiterRow = (raw) => {
  if (raw === undefined || !/^ {0,3}\S/.test(raw) || !strip(raw).includes('|')) return false;
  const cells = rowCells(raw);
  return cells.length > 0 && cells.every((c) => DELIMITER_CELL_RE.test(c));
};

/** `[{ line, cells, header, headerLine }]` for every table row whose cell count differs from its header's. */
export function mismatchedRows(text) {
  const found = [];
  const lines = text.split('\n');
  let fence = null;
  let header = null;
  lines.forEach((raw, i) => {
    const line = i + 1;
    const run = raw.match(FENCE_RE)?.[1];
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && raw.trim() === run) fence = null;
      return;
    }
    if (run) {
      fence = run;
      header = null;
      return;
    }
    if (header) {
      if (strip(raw).trim() === '' || BLOCK_START_RE.test(raw)) header = null;
      else {
        const cells = rowCells(raw).length;
        if (cells !== header.cells) found.push({ line, cells, header: header.cells, headerLine: header.line });
        return;
      }
    }
    if (/^ {0,3}\S/.test(raw) && UNESCAPED_PIPE_RE.test(strip(raw)) && isDelimiterRow(lines[i + 1])) {
      header = { cells: rowCells(raw).length, line };
    }
  });
  return found;
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
