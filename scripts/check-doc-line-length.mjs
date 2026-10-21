#!/usr/bin/env node

// Long-line ratchet for the protocol docs.
//
// A protocol paragraph or table row that describes many fields on one line is
// a merge-conflict magnet: two unrelated edits to different fields touch the
// same line and collide (intent#7408 needed a manual rebase because #7424 added
// an unrelated field to the same ~5,000-character line of methods/pr.md). Keep
// one sentence or bullet per line, and move long table-cell prose into a
// details section under the table.
//
// Scanned: every `docs/protocol/**/*.md`. A line is too long when it has more
// than LIMIT Unicode code points (trailing `\r` excluded). Fenced code counts.
//
// Baseline (`scripts/doc-line-length-baseline.txt`): one `<path> <count>` line
// per file that still has too-long lines, sorted by path. It only ratchets
// down: a file over its entry (or absent from the baseline) fails naming every
// too-long line; a file under its entry, or an entry whose file is gone, fails
// naming the exact baseline line to write.
//
// Usage:
//   node scripts/check-doc-line-length.mjs                 # exit 1 on any finding
//   node scripts/check-doc-line-length.mjs --print-counts  # print `<path> <count>`
//                                                          # (baseline regeneration)
//   --root <dir>  scan another checkout (tests)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const LIMIT = 2000;
export const SCAN_DIR = 'docs/protocol';
export const BASELINE_PATH = 'scripts/doc-line-length-baseline.txt';

const FIX_HINT =
  "split it into one sentence or bullet per line; for a long table row, keep the row's result shape and move its prose into a details block under the table";

async function markdownFilesBelow(root, relative) {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
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

/** Parse the baseline: `{ entries: [{ path, count, line }], errors: [string] }`. */
export function parseBaseline(text, file = BASELINE_PATH) {
  const entries = [];
  const errors = [];
  let previous = null;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = trimmed.match(/^(\S+)\s+(\S+)$/);
    if (!m) {
      errors.push(`${file}:${line}: error: expected \`<path> <count>\`, got "${raw}"`);
      return;
    }
    const [, entryPath, countText] = m;
    if (!/^[0-9]+$/.test(countText)) {
      errors.push(`${file}:${line}: error: count "${countText}" is not a number`);
      return;
    }
    const count = Number(countText);
    if (count === 0) {
      errors.push(`${file}:${line}: error: a file with no too-long lines has no entry; remove "${raw}"`);
      return;
    }
    if (previous !== null && !(previous < entryPath)) {
      errors.push(`${file}:${line}: error: entries must be sorted by path and unique, but "${entryPath}" follows "${previous}"`);
      return;
    }
    previous = entryPath;
    entries.push({ path: entryPath, count, line });
  });
  return { entries, errors };
}

/** Compare a scan with the parsed baseline; returns error strings (empty when in step). */
export function compare(results, entries, { limit = LIMIT, baselinePath = BASELINE_PATH } = {}) {
  const findings = [];
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const { path: file, long } of results) {
    const entry = byPath.get(file);
    const count = long.length;
    const allowed = entry?.count ?? 0;
    if (count > allowed) {
      const allowedText = entry ? `the baseline allows ${allowed}` : 'the baseline has no entry for it';
      findings.push(`${file}: ${count} line(s) over ${limit} characters, ${allowedText}:`);
      for (const { line, length } of long) {
        findings.push(`${file}:${line}: error: line is ${length} characters (limit ${limit}); ${FIX_HINT}`);
      }
    } else if (entry && count === 0) {
      findings.push(`${baselinePath}:${entry.line}: error: ${file} has no lines over ${limit} characters left but the baseline allows ${allowed}; the ratchet only moves down: remove its line \`${file} ${allowed}\``);
    } else if (entry && count < allowed) {
      findings.push(`${baselinePath}:${entry.line}: error: ${file} has ${count} line(s) over ${limit} characters but the baseline allows ${allowed}; the ratchet only moves down: replace its line with \`${file} ${count}\``);
    }
  }
  const scanned = new Set(results.map((r) => r.path));
  for (const entry of entries) {
    if (!scanned.has(entry.path)) {
      findings.push(`${baselinePath}:${entry.line}: error: ${entry.path} no longer exists; remove its line \`${entry.path} ${entry.count}\``);
    }
  }
  return findings;
}

/** Run the whole check against `root`; returns `{ findings, counts }`. */
export async function check(root, { limit = LIMIT } = {}) {
  const results = await scan(root, { limit });
  const counts = results.filter((r) => r.long.length > 0).map((r) => `${r.path} ${r.long.length}`);
  let text;
  try {
    text = await fs.readFile(path.join(root, BASELINE_PATH), 'utf8');
  } catch {
    return { findings: [`${BASELINE_PATH}: error: baseline file is missing`], counts };
  }
  const { entries, errors } = parseBaseline(text);
  if (errors.length > 0) return { findings: errors, counts };
  return { findings: compare(results, entries, { limit }), counts };
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
  const { findings, counts } = await check(root);
  if (printCounts) {
    for (const line of counts) process.stdout.write(`${line}\n`);
    return 0;
  }
  if (findings.length > 0) {
    process.stderr.write(`error: lines in ${SCAN_DIR}/**/*.md are out of step with ${BASELINE_PATH}:\n${findings.join('\n')}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
