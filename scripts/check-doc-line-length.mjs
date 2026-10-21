#!/usr/bin/env node

// Long-line ratchet for the protocol docs.
//
// A protocol paragraph or table row that describes many fields on one line is
// a merge-conflict magnet: two unrelated edits to different fields touch the
// same line and collide (intent#7408 needed a manual rebase because #7424 added
// an unrelated field to the same ~5,000-character line of methods/pr.md). Keep
// one sentence or bullet per line, and move long table-cell prose into a
// details block under the table.
//
// Scanned: every `docs/protocol/**/*.md`. A line is too long when it has more
// than LIMIT Unicode code points (trailing `\r` excluded). Fenced code counts.
// The walk fails closed: an unreadable directory or a symlink is an error, not
// a silently skipped file.
//
// Baseline (`scripts/doc-line-length-baseline.txt`): one `<path> <count> <chars>`
// line per file that still has too-long lines, sorted by path, where `count` is
// the number of too-long lines and `chars` their combined length. It only
// ratchets down:
//   - more too-long lines than `count` (or a file absent from the baseline)
//     fails naming every too-long line;
//   - the same count but more than `chars` characters (a grandfathered line
//     grew, or one was swapped for a longer one) fails the same way;
//   - fewer too-long lines than `count`, or an entry whose file is gone, fails
//     naming the exact baseline line to write.
// A same-count shrink in `chars` passes without a baseline edit, so two PRs
// that each trim a grandfathered line do not collide on the baseline itself.
//
// Usage:
//   node scripts/check-doc-line-length.mjs                 # exit 1 on any finding
//   node scripts/check-doc-line-length.mjs --print-counts  # print a complete baseline
//                                                          # file for the current tree
//   --root <dir>  scan another checkout (tests)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const LIMIT = 2000;
export const SCAN_DIR = 'docs/protocol';
export const BASELINE_PATH = 'scripts/doc-line-length-baseline.txt';

export const BASELINE_HEADER = [
  '# Grandfathered over-long lines per protocol doc: `<path> <count> <chars>`, sorted by path,',
  `# where count is the number of lines over ${LIMIT} characters and chars their combined length.`,
  '# Checked by `scripts/check-doc-line-length.mjs` (run from `make docs-check`). Entries only',
  '# ratchet down: split a long line into one sentence or bullet per line and the check names the',
  '# corrected line to write here. Regenerate with `node scripts/check-doc-line-length.mjs --print-counts`.',
].join('\n');

const FIX_HINT =
  "split it into one sentence or bullet per line; for a long table row, keep the row's result shape and move its prose into a details block under the table";

async function markdownFilesBelow(root, relative) {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`${child}: symlinks under ${SCAN_DIR} are not scanned; commit the file itself`);
    if (entry.isDirectory()) files.push(...(await markdownFilesBelow(root, child)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child);
  }
  return files;
}

/** `[{ line, length }]` for every line of `text` longer than `limit` code points. */
export function longLines(text, limit = LIMIT) {
  const found = [];
  text.split('\n').forEach((raw, i) => {
    const length = [...raw.replace(/\r$/, '')].length;
    if (length > limit) found.push({ line: i + 1, length });
  });
  return found;
}

/** `[{ path, long: [{ line, length }] }]` for every scanned file, sorted by path. */
export async function scan(root, { limit = LIMIT } = {}) {
  const files = (await markdownFilesBelow(root, SCAN_DIR)).sort();
  const results = [];
  for (const file of files) {
    results.push({ path: file, long: longLines(await fs.readFile(path.join(root, file), 'utf8'), limit) });
  }
  return results;
}

const total = (long) => long.reduce((sum, l) => sum + l.length, 0);

/** Baseline lines (`<path> <count> <chars>`) for a scan, sorted by path. */
export function baselineEntries(results) {
  return results.filter((r) => r.long.length > 0).map((r) => `${r.path} ${r.long.length} ${total(r.long)}`);
}

/** Parse the baseline: `{ entries: [{ path, count, chars, line }], errors: [string] }`. */
export function parseBaseline(text, file = BASELINE_PATH) {
  const entries = [];
  const errors = [];
  let previous = null;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
    if (!m) {
      errors.push(`${file}:${line}: error: expected \`<path> <count> <chars>\`, got "${raw}"`);
      return;
    }
    const [, entryPath, countText, charsText] = m;
    const bad = [countText, charsText].find((t) => !/^[0-9]+$/.test(t));
    if (bad !== undefined) {
      errors.push(`${file}:${line}: error: "${bad}" is not a number`);
      return;
    }
    const count = Number(countText);
    const chars = Number(charsText);
    if (count === 0) {
      errors.push(`${file}:${line}: error: a file with no too-long lines has no entry; remove "${raw}"`);
      return;
    }
    if (previous !== null && !(previous < entryPath)) {
      errors.push(`${file}:${line}: error: entries must be sorted by path and unique, but "${entryPath}" follows "${previous}"`);
      return;
    }
    previous = entryPath;
    entries.push({ path: entryPath, count, chars, line });
  });
  return { entries, errors };
}

/** Compare a scan with the parsed baseline; returns error strings (empty when in step). */
export function compare(results, entries, { limit = LIMIT, baselinePath = BASELINE_PATH } = {}) {
  const findings = [];
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const listLines = (file, long) => {
    for (const { line, length } of long) {
      findings.push(`${file}:${line}: error: line is ${length} characters (limit ${limit}); ${FIX_HINT}`);
    }
  };
  for (const { path: file, long } of results) {
    const entry = byPath.get(file);
    const count = long.length;
    const chars = total(long);
    const actual = `${file} ${count} ${chars}`;
    if (count > (entry?.count ?? 0)) {
      const allowedText = entry ? `the baseline allows ${entry.count}` : 'the baseline has no entry for it';
      findings.push(`${file}: ${count} line(s) over ${limit} characters, ${allowedText}:`);
      listLines(file, long);
    } else if (entry && count === 0) {
      findings.push(`${baselinePath}:${entry.line}: error: ${file} has no lines over ${limit} characters left but the baseline allows ${entry.count}; the ratchet only moves down: remove its line \`${entry.path} ${entry.count} ${entry.chars}\``);
    } else if (entry && count < entry.count) {
      findings.push(`${baselinePath}:${entry.line}: error: ${file} has ${count} line(s) over ${limit} characters but the baseline allows ${entry.count}; the ratchet only moves down: replace its line with \`${actual}\``);
    } else if (entry && chars > entry.chars) {
      findings.push(`${file}: its ${count} line(s) over ${limit} characters grew to ${chars} characters, the baseline allows ${entry.chars}; put new text on its own lines instead of extending a long one:`);
      listLines(file, long);
    }
  }
  const scanned = new Set(results.map((r) => r.path));
  for (const entry of entries) {
    if (!scanned.has(entry.path)) {
      findings.push(`${baselinePath}:${entry.line}: error: ${entry.path} no longer exists; remove its line \`${entry.path} ${entry.count} ${entry.chars}\``);
    }
  }
  return findings;
}

/** Run the whole check against `root`; returns error strings (empty when in step). */
export async function check(root, { limit = LIMIT } = {}) {
  const results = await scan(root, { limit });
  let text;
  try {
    text = await fs.readFile(path.join(root, BASELINE_PATH), 'utf8');
  } catch {
    return [`${BASELINE_PATH}: error: baseline file is missing`];
  }
  const { entries, errors } = parseBaseline(text);
  if (errors.length > 0) return errors;
  return compare(results, entries, { limit });
}

async function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let printCounts = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--print-counts') printCounts = true;
    else if (argv[i] === '--root' && i + 1 < argv.length) root = path.resolve(argv[++i]);
    else {
      process.stderr.write('usage: check-doc-line-length.mjs [--print-counts] [--root <dir>]\n');
      return 2;
    }
  }
  try {
    if (printCounts) {
      process.stdout.write(`${[BASELINE_HEADER, ...baselineEntries(await scan(root))].join('\n')}\n`);
      return 0;
    }
    const findings = await check(root);
    if (findings.length > 0) {
      process.stderr.write(`error: lines in ${SCAN_DIR}/**/*.md are out of step with ${BASELINE_PATH}:\n${findings.join('\n')}\n`);
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
