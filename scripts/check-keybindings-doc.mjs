#!/usr/bin/env node

// Check that the chords docs/fe/KEYBINDINGS.md documents for configurable
// shortcuts match cloudlands-fe's shortcut table (SHORTCUT_DEFAULTS in
// src/lib/utils/shortcut-bindings.ts). cloudlands-fe#4205 moved column focus
// to Mod+Alt+Left/Right; the doc kept an older chord and nothing compared the
// two.
//
// A doc table opts in with an `ID` column. A row whose ID cell holds a
// shortcut id in a code span (`panel.focus-next-column`) has its first cell,
// one code span such as `Mod+Alt+→`, compared with the table. Rows with an
// empty ID cell (shortcuts outside the table) are not checked. Both sides are
// read as text, never executed (upstream, the component checkout is an
// untrusted PR head).
//
// Direction rules (the same "docs lead the pin" order as the other consumer
// checks):
//   - a tagged row whose chord differs from the table fails, at the pin and
//     on upstream cloudlands-fe PRs alike. To move a shortcut, land the doc
//     change with a PENDING entry below BEFORE the cloudlands-fe PR; the
//     check then accepts the new chord while the pin still has the old one;
//   - a stale PENDING entry (the pin now has the new chord) only warns, so
//     the pin bump stays green; remove it in a follow-up;
//   - a table id with no tagged row fails: a new shortcut is documented
//     first. Land its row BEFORE the cloudlands-fe PR that adds it;
//   - a tagged id the table does not define only warns (that docs-first
//     addition while the pin catches up, or a row left over after the
//     shortcut was removed; drop it after the bump).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { describeCheckout, formatBanner, formatOffPinWarning } from './submodule-ref.mjs';

export const FE_DIR = 'packages/cloudlands-fe';
export const BINDINGS_FILE = 'src/lib/utils/shortcut-bindings.ts';
export const DOCS_FILE = 'docs/fe/KEYBINDINGS.md';
const CHECK = 'check-keybindings-doc';
const SCRIPT = `scripts/${CHECK}.mjs`;

/**
 * Chord changes the doc already shows ahead of the pin, by shortcut id:
 * `{ from: '<pinned binding>', to: '<new binding>', reason: 'cloudlands-fe#1234' }`.
 */
export const PENDING = {};

const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'];
const MODIFIERS = {
  mod: 'mod', cmd: 'mod', command: 'mod', meta: 'mod', '⌘': 'mod',
  ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', '⌥': 'alt',
  shift: 'shift', '⇧': 'shift',
};
const KEYS = {
  '←': 'left', '→': 'right', '↑': 'up', '↓': 'down',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  escape: 'esc', return: 'enter', pgup: 'pageup', pgdn: 'pagedown',
};
const NAMED = new Set([
  'left', 'right', 'up', 'down', 'pageup', 'pagedown', 'home', 'end', 'enter', 'esc', 'tab',
  'space', 'backspace', 'delete', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

function canonicalStep(text) {
  const parts = text.split('+').map((part) => part.trim());
  const raw = parts.pop();
  if (!raw) return null;
  const modifiers = parts.map((part) => MODIFIERS[part.toLowerCase()]);
  if (modifiers.some((m) => !m) || new Set(modifiers).size !== modifiers.length) return null;
  let key;
  if (/^[1-8]-9$/.test(raw)) key = raw;
  else if ([...raw].length === 1) {
    if (MODIFIERS[raw]) return null;
    // A bare capital is Shift+letter (`H/J/K/L` after the leader); with a modifier, `Mod+K` means k.
    key = KEYS[raw] ?? (modifiers.length ? raw.toLowerCase() : raw);
  } else {
    key = KEYS[raw.toLowerCase()] ?? raw.toLowerCase();
    if (!NAMED.has(key)) return null;
  }
  return [...MODIFIER_ORDER.filter((m) => modifiers.includes(m)), key].join('+');
}

/**
 * One spelling for a doc chord (`Mod+Alt+→`) and a table binding
 * (`mod+alt+right`), or null when it is not a chord this check reads.
 * Handles `a/b` alternatives, `x + 1-9` sequences and `Mod+1-9` ranges.
 */
export function canonicalChord(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const steps = trimmed.split(/\s+\+\s+/);
  if (steps.length > 1) {
    const canonical = steps.map((step) => canonicalChord(step));
    return canonical.includes(null) ? null : canonical.join(' + ');
  }
  if (trimmed.length > 1 && trimmed.includes('/') && !trimmed.endsWith('+/')) {
    const alternatives = trimmed.split('/').map(canonicalStep);
    return alternatives.includes(null) ? null : alternatives.join('/');
  }
  return canonicalStep(trimmed);
}

/** `Map<id, binding>` from SHORTCUT_DEFAULTS, or throws naming what changed. */
export function parseBindings(source, file = `${FE_DIR}/${BINDINGS_FILE}`) {
  const block = source.match(/^export const SHORTCUT_DEFAULTS = \{\n([\s\S]*?)^\} as const;$/m);
  if (!block) throw new Error(`${file}: \`export const SHORTCUT_DEFAULTS = { ... } as const;\` not found; update ${CHECK}`);
  const bindings = new Map();
  for (const line of block[1].split('\n')) {
    if (!line.trim() || /^\s*\/\//.test(line)) continue;
    const m = line.match(/^ {2}'([a-z][a-z0-9-]*\.[a-z0-9.-]+)': '((?:[^'\\]|\\.)*)',$/);
    if (!m) throw new Error(`${file}: SHORTCUT_DEFAULTS holds \`${line.trim().slice(0, 60)}\`, not a \`'id': 'binding',\` line; update ${CHECK}`);
    if (bindings.has(m[1])) throw new Error(`${file}: SHORTCUT_DEFAULTS lists ${m[1]} more than once`);
    bindings.set(m[1], m[2].replace(/\\(.)/g, '$1'));
  }
  if (!bindings.size) throw new Error(`${file}: SHORTCUT_DEFAULTS is empty; update ${CHECK}`);
  return bindings;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());

/** `[{ line, id, chord }]` for every row tagged with a shortcut id, or throws naming the row. */
export function parseDocRows(source, file = DOCS_FILE) {
  const lines = source.split('\n');
  const rows = [];
  let tables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('|') || !/^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) continue;
    const header = cells(lines[i]);
    const idColumn = header.indexOf('ID');
    i += 2;
    for (; i < lines.length && lines[i].startsWith('|'); i += 1) {
      if (idColumn === -1) continue;
      const where = `${file}:${i + 1}`;
      const row = cells(lines[i]);
      if (row.length !== header.length) throw new Error(`${where}: row has ${row.length} cells, the header has ${header.length} cells (escape a literal pipe as \\|)`);
      const idCell = row[idColumn];
      if (!idCell) continue;
      const id = idCell.match(/^`([a-z][a-z0-9-]*\.[a-z0-9.-]+)`$/)?.[1];
      if (!id) throw new Error(`${where}: the ID cell must be one shortcut id in a code span (\`panel.focus-next-column\`) or empty, not \`${idCell}\``);
      const chord = row[0].match(/^`([^`]+)`$/)?.[1];
      if (!chord) throw new Error(`${where}: a row tagged ${id} must spell its chord as one code span in the first cell, not \`${row[0]}\``);
      rows.push({ line: i + 1, id, chord });
    }
    if (idColumn !== -1) tables += 1;
    i -= 1;
  }
  if (!tables) throw new Error(`${file}: no table with an ID column; update ${CHECK} if the doc moved`);
  return rows;
}

/** Compare tagged doc rows with the table. Returns `{ errors, warnings, checked, pending }`. */
export function compare({ bindings, rows, pending = PENDING, files = {} }) {
  const f = { bindings: `${FE_DIR}/${BINDINGS_FILE}`, docs: DOCS_FILE, ...files };
  const errors = [];
  const warnings = [];
  let checked = 0;
  let pendingCount = 0;
  const documented = new Set(rows.map((row) => row.id));

  for (const [id, entry] of Object.entries(pending)) {
    if (!entry || typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`PENDING entry ${id} needs a reason (the cloudlands-fe PR) in ${SCRIPT}`);
    else if (canonicalChord(entry.from) === null || canonicalChord(entry.to) === null) errors.push(`PENDING entry ${id} needs readable from/to bindings in ${SCRIPT}`);
    else if (!bindings.has(id)) warnings.push(`PENDING entry ${id} is stale: ${f.bindings} no longer defines it; remove the entry from ${SCRIPT}`);
    else if (canonicalChord(bindings.get(id)) === canonicalChord(entry.to)) warnings.push(`PENDING entry ${id} is stale: ${f.bindings} now binds ${entry.to}; remove the entry from ${SCRIPT}`);
  }

  for (const { line, id, chord } of rows) {
    const where = `${f.docs}:${line}`;
    if (!bindings.has(id)) {
      warnings.push(`${where} names ${id}, which ${f.bindings} does not define (a docs-first addition, or left over after the shortcut was removed)`);
      continue;
    }
    const binding = bindings.get(id);
    const doc = canonicalChord(chord);
    const table = canonicalChord(binding);
    if (doc === null) {
      errors.push(`${where}: cannot read \`${chord}\` as a chord (write modifiers as Mod, Ctrl, Alt, Shift and keys as in the shortcut table)`);
      continue;
    }
    if (table === null) {
      errors.push(`${f.bindings}: cannot read ${id} binding \`${binding}\`; update ${CHECK}`);
      continue;
    }
    if (doc === table) {
      checked += 1;
      continue;
    }
    const entry = pending[id];
    if (entry?.reason && canonicalChord(entry.to) === doc && canonicalChord(entry.from) === table) {
      pendingCount += 1;
      continue;
    }
    errors.push(
      `${where}: ${id} is documented as \`${chord}\` but ${f.bindings} binds it to \`${binding}\`. ` +
        `Update the row; when the doc leads a cloudlands-fe change, add a PENDING entry for ${id} in ${SCRIPT} in the same monorepo PR.`,
    );
  }

  for (const [id, binding] of bindings) {
    if (!documented.has(id)) {
      errors.push(
        `${id} (${binding}) has no row in ${f.docs}. Add one with \`${id}\` in its ID cell; ` +
          `for a new shortcut, land that row in a monorepo PR before the cloudlands-fe PR.`,
      );
    }
  }
  return { errors, warnings, checked, pending: pendingCount };
}

/** Read and compare the checkout under `root`; `feDir` is relative to `root` (the Makefile's FE_DIR). */
export function run(root, { feDir = FE_DIR, docsFile = DOCS_FILE, pending = PENDING, log = console.log, warn = console.error } = {}) {
  const read = (file, hint) => {
    const full = path.resolve(root, file);
    if (!fs.existsSync(full)) throw new Error(`${file} not found; ${hint}update ${CHECK} if the file moved`);
    return fs.readFileSync(full, 'utf8');
  };
  const ref = describeCheckout(root, feDir, { pinDir: FE_DIR });
  const banner = formatBanner(ref, { check: CHECK, what: 'shortcut table' });
  if (banner) log(banner);
  const offPin = formatOffPinWarning(ref);
  if (offPin) warn(offPin);
  const files = { bindings: path.join(feDir, BINDINGS_FILE), docs: docsFile };
  const bindings = parseBindings(read(files.bindings, 'initialize the submodule (make ensure-fe-submodule) or '), files.bindings);
  const rows = parseDocRows(read(docsFile, ''), docsFile);
  return compare({ bindings, rows, pending, files });
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, 'fe-dir': { type: 'string' } } });
  const root = path.resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)));
  let result;
  try {
    result = run(root, { feDir: values['fe-dir'] ?? FE_DIR });
  } catch (error) {
    console.error(`${CHECK}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of result.warnings) console.log(`::warning::${CHECK}: ${warning}`);
  for (const error of result.errors) console.error(`${CHECK}: error: ${error}`);
  if (result.errors.length) {
    process.exitCode = 1;
    return;
  }
  const n = result.checked;
  const pending = result.pending ? ` (${result.pending} pending a cloudlands-fe change)` : '';
  console.log(`${CHECK}: ${n} documented shortcut${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''} ${BINDINGS_FILE}${pending}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
