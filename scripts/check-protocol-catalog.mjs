#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CATALOG_PATH = 'docs/protocol/05-method-catalog.md';
export const METHODS_DIR = 'docs/protocol/methods';
export const INTENTD_CATALOG_PATH = 'packages/intentd/crates/intent-transport/src/catalog.rs';

// Method-name grammar: namespace may contain hyphens (e.g. `accept-changes`).
export const METHOD_NAME_RE = /^[a-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9]*)+$/;
const METHOD_NAME_SRC = '[a-z][A-Za-z0-9-]*(?:\\.[A-Za-z][A-Za-z0-9]*)+';

// Names documented in docs/protocol/methods/*.md that are deliberately absent from the
// dispatchable catalog. Each entry needs a one-line reason.
export const DOCUMENTED_NOT_DISPATCHABLE = new Set([
  'browser.docs', // documented in §5.9 as "not exposed: no router arm" — an MCP-only helper, never dispatched on the wire
]);

const SECTION_HEADINGS = {
  router: /^### Router methods by namespace \((\d+) total\)\s*$/,
  fastPath: /^### Fast-path methods \((\d+) total\)\s*$/,
  aliases: /^### Method aliases \((\d+) total\)\s*$/,
  reverse: /^### Client-served reverse RPCs \((\d+) total\)\s*$/,
};

export function formatError({ file, line, message }) {
  return `${file}:${line}: error: ${message}`;
}

export function formatWarning({ file, line, message }) {
  return `${file}:${line}: warning: ${message}`;
}

function sliceSection(lines, headingRe) {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##(#)? /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const total = Number(lines[start].match(headingRe)[1]);
  return { total, headingLine: start + 1, body: lines.slice(start + 1, end), offset: start + 1 };
}

const ROUTER_ROW_RE = /^\|\s*([a-z][A-Za-z0-9-]*)(?:\s+\(router\))?\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*$/;
const ALIAS_BULLET_RE = new RegExp(`^- \`(${METHOD_NAME_SRC})\` → \`(${METHOD_NAME_SRC})\``);
const REVERSE_BULLET_RE = new RegExp(`^- \`(${METHOD_NAME_SRC})\``);
const FASTPATH_LIST_RE = new RegExp(`^${METHOD_NAME_SRC}(?:,\\s*${METHOD_NAME_SRC})*$`);

/** Parse docs/protocol/05-method-catalog.md into its four method sections plus the summary counts. */
export function parseCatalog(text) {
  const lines = text.split('\n');
  const catalog = {
    routerRows: [],
    router: null,
    fastPath: null,
    aliases: null,
    reverse: null,
    summary: null,
    bullets: { router: null, fastPath: null },
    missingSections: [],
  };

  const router = sliceSection(lines, SECTION_HEADINGS.router);
  if (router) {
    catalog.router = { total: router.total, headingLine: router.headingLine };
    router.body.forEach((l, i) => {
      const m = l.match(ROUTER_ROW_RE);
      if (m) catalog.routerRows.push({ ns: m[1], count: Number(m[2]), cell: m[3], line: router.offset + i + 1 });
    });
  } else catalog.missingSections.push('Router methods by namespace');

  const fast = sliceSection(lines, SECTION_HEADINGS.fastPath);
  if (fast) {
    const idx = fast.body.findIndex((l) => FASTPATH_LIST_RE.test(l.trim()));
    const names = idx === -1 ? [] : fast.body[idx].trim().split(',').map((s) => s.trim());
    catalog.fastPath = { total: fast.total, headingLine: fast.headingLine, names, line: idx === -1 ? fast.headingLine : fast.offset + idx + 1 };
  } else catalog.missingSections.push('Fast-path methods');

  const aliases = sliceSection(lines, SECTION_HEADINGS.aliases);
  if (aliases) {
    const pairs = [];
    aliases.body.forEach((l, i) => {
      const m = l.match(ALIAS_BULLET_RE);
      if (m) pairs.push({ alias: m[1], canonical: m[2], line: aliases.offset + i + 1 });
    });
    catalog.aliases = { total: aliases.total, headingLine: aliases.headingLine, pairs };
  } else catalog.missingSections.push('Method aliases');

  const reverse = sliceSection(lines, SECTION_HEADINGS.reverse);
  if (reverse) {
    const names = [];
    reverse.body.forEach((l, i) => {
      const m = l.match(REVERSE_BULLET_RE);
      if (m) names.push({ name: m[1], line: reverse.offset + i + 1 });
    });
    catalog.reverse = { total: reverse.total, headingLine: reverse.headingLine, names };
  } else catalog.missingSections.push('Client-served reverse RPCs');

  lines.forEach((l, i) => {
    let m = l.match(/\*\*(\d+) dispatchable method names\*\*/);
    if (m && !catalog.summary) catalog.summary = { total: Number(m[1]), line: i + 1 };
    m = l.match(/^- \*\*Router methods:\*\*\s*(\d+)/);
    if (m && !catalog.bullets.router) catalog.bullets.router = { total: Number(m[1]), line: i + 1 };
    m = l.match(/^- \*\*Fast-path methods:\*\*\s*(\d+)/);
    if (m && !catalog.bullets.fastPath) catalog.bullets.fastPath = { total: Number(m[1]), line: i + 1 };
  });

  return catalog;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `suffix` occurs in a router-row Methods cell as a whole token. */
export function cellHasSuffix(cell, suffix) {
  return new RegExp(`(^|[ ,(])${escapeRe(suffix)}($|[ ,()])`).test(cell);
}

export function splitMethodName(name) {
  const dot = name.indexOf('.');
  return { ns: name.slice(0, dot), suffix: name.slice(dot + 1) };
}

const SUFFIX_TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

/** Split a router-row Methods cell into its suffix tokens: the text before the first " — " (or the whole cell), comma-separated. */
export function tokenizeRowSuffixes(cell) {
  const dash = cell.indexOf(' — ');
  const list = dash === -1 ? cell : cell.slice(0, dash);
  const tokens = list.split(',').map((s) => s.trim());
  return { tokens, invalid: tokens.filter((t) => !SUFFIX_TOKEN_RE.test(t)) };
}

/** Where a method name is present in the parsed catalog, or null. */
export function findInCatalog(catalog, name) {
  const { ns, suffix } = splitMethodName(name);
  const row = catalog.routerRows.find((r) => r.ns === ns);
  if (row && cellHasSuffix(row.cell, suffix)) return { section: 'router', line: row.line };
  if (catalog.fastPath?.names.includes(name)) return { section: 'fastPath', line: catalog.fastPath.line };
  const alias = catalog.aliases?.pairs.find((p) => p.alias === name || p.canonical === name);
  if (alias) return { section: 'aliases', line: alias.line };
  const rev = catalog.reverse?.names.find((r) => r.name === name);
  if (rev) return { section: 'reverse', line: rev.line };
  return null;
}

const FIRST_CELL_RE = /^\|\s*((?:[^|\\]|\\.)*?)\s*\|/;
const LEADING_NAME_RE = new RegExp(`^\\s*\`?(${METHOD_NAME_SRC})\`?`);
// Trailing row annotations such as `*(v4.1)*`, `(deprecated)`, `*(v8.7, [x](https://…))*`.
const ANNOTATION_RE = /^\s*\*?\((?:[^()]|\([^()]*\))*\)\*?/;
const HEADING_NAME_RE = new RegExp(`\`(${METHOD_NAME_SRC})\``, 'g');

/** Method names a table first cell names: `foo.bar`, `` `foo.bar` ``, `foo.bar *(v1)*`, `a.b, c.d`. */
export function methodNamesInFirstCell(cell) {
  const names = [];
  let rest = cell;
  for (;;) {
    const m = rest.match(LEADING_NAME_RE);
    if (!m) return [];
    names.push(m[1]);
    rest = rest.slice(m[0].length);
    for (let a = rest.match(ANNOTATION_RE); a; a = rest.match(ANNOTATION_RE)) rest = rest.slice(a[0].length);
    rest = rest.trimStart();
    if (rest === '') return names;
    if (!rest.startsWith(',')) return [];
    rest = rest.slice(1);
  }
}

/** Collect `{ name, line }` for every method a docs/protocol/methods/*.md file documents. */
export function collectDocumentedMethods(text) {
  const found = [];
  let inFence = false;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (/^#{2,5} /.test(raw)) {
      for (const m of raw.matchAll(HEADING_NAME_RE)) found.push({ name: m[1], line });
      return;
    }
    const cell = raw.match(FIRST_CELL_RE);
    if (cell) for (const name of methodNamesInFirstCell(cell[1])) found.push({ name, line });
  });
  return found;
}

function rustConstBody(text, name) {
  const m = text.match(new RegExp(`const ${name}\\s*:[^=]*=\\s*&\\[([\\s\\S]*?)\\];`));
  return m ? m[1] : null;
}

/** Extract the frozen wire-contract constants from intent-transport's catalog.rs. */
export function extractRustCatalog(text) {
  const strings = (body) => [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const pairs = (body) => [...body.matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => [m[1], m[2]]);
  const result = { missing: [] };
  for (const [key, name, parse] of [
    ['routerMethods', 'ROUTER_METHODS', strings],
    ['fastPathMethods', 'FASTPATH_METHODS', strings],
    ['aliases', 'METHOD_ALIASES', pairs],
    ['reverseMethods', 'REVERSE_METHODS', strings],
  ]) {
    const body = rustConstBody(text, name);
    if (body === null) result.missing.push(name);
    result[key] = body === null ? [] : parse(body);
  }
  return result;
}

// "Docs ahead of pin" is the intended ordering (document first, then merge the intentd PR), so these
// findings are warnings; they only signal a real problem if no intentd change ever ships the method.
const LEAD_HINT =
  'expected while the docs lead the intentd pin (the submodule pin advances automatically once the intentd PR merges; rebase onto main if it already has); if no intentd change is adding it, treat this as an error and remove the entry';
const ORPHAN_HINT = `is listed in the catalog but not in the pinned intentd catalog.rs — ${LEAD_HINT}`;
const ORPHAN_HINT_TAIL = `is not a router method in the pinned intentd catalog.rs — ${LEAD_HINT}`;

/** Layer 1: methods/*.md coverage, section counts, summary formula. `docs` is `[{ file, methods: [{ name, line }] }]`. */
export function checkLayer1(catalog, docs, { catalogPath = CATALOG_PATH, allowlist = DOCUMENTED_NOT_DISPATCHABLE } = {}) {
  const errors = [];
  const err = (file, line, message) => errors.push({ file, line, message });
  for (const section of catalog.missingSections) err(catalogPath, 1, `missing section heading "### ${section} (N total)"`);

  for (const { file, methods } of docs) {
    for (const { name, line } of methods) {
      if (allowlist.has(name) || findInCatalog(catalog, name)) continue;
      err(file, line, `${name} is documented here but missing from ${catalogPath}`);
    }
  }

  const routerSum = catalog.routerRows.reduce((s, r) => s + r.count, 0);
  if (catalog.router && catalog.router.total !== routerSum) {
    err(catalogPath, catalog.router.headingLine, `router heading says ${catalog.router.total} total but the Count column sums to ${routerSum}`);
  }
  if (catalog.fastPath && catalog.fastPath.total !== catalog.fastPath.names.length) {
    err(catalogPath, catalog.fastPath.headingLine, `fast-path heading says ${catalog.fastPath.total} total but the list has ${catalog.fastPath.names.length} names`);
  }
  if (catalog.aliases && catalog.aliases.total !== catalog.aliases.pairs.length) {
    err(catalogPath, catalog.aliases.headingLine, `alias heading says ${catalog.aliases.total} total but ${catalog.aliases.pairs.length} alias bullets are listed`);
  }
  if (catalog.reverse && catalog.reverse.total !== catalog.reverse.names.length) {
    err(catalogPath, catalog.reverse.headingLine, `reverse-RPC heading says ${catalog.reverse.total} total but ${catalog.reverse.names.length} bullets are listed`);
  }

  const fastCount = catalog.fastPath?.names.length ?? 0;
  const aliasCount = catalog.aliases?.pairs.length ?? 0;
  const expected = routerSum + fastCount + aliasCount;
  if (!catalog.summary) err(catalogPath, 1, 'missing "**N dispatchable method names**" summary line');
  else if (catalog.summary.total !== expected) {
    err(catalogPath, catalog.summary.line, `summary says ${catalog.summary.total} dispatchable method names but router ${routerSum} + fast-path ${fastCount} + aliases ${aliasCount} = ${expected}`);
  }
  if (!catalog.bullets.router) err(catalogPath, 1, 'missing "- **Router methods:** N" bullet');
  else if (catalog.bullets.router.total !== routerSum) {
    err(catalogPath, catalog.bullets.router.line, `"Router methods" bullet says ${catalog.bullets.router.total} but the Count column sums to ${routerSum}`);
  }
  if (!catalog.bullets.fastPath) err(catalogPath, 1, 'missing "- **Fast-path methods:** N" bullet');
  else if (catalog.bullets.fastPath.total !== fastCount) {
    err(catalogPath, catalog.bullets.fastPath.line, `"Fast-path methods" bullet says ${catalog.bullets.fastPath.total} but the list has ${fastCount} names`);
  }
  return errors;
}

/**
 * Layer 2: the catalog doc against intentd's frozen `catalog.rs` constants. Returns `{ errors, warnings }`:
 * "pin ahead of docs" (a Rust entry with no docs entry) is an error; "docs ahead of pin" (a documented entry
 * the pinned catalog.rs does not carry yet) is a warning.
 */
export function checkLayer2(catalog, rust, docs, { catalogPath = CATALOG_PATH, rustPath = INTENTD_CATALOG_PATH } = {}) {
  const errors = [];
  const warnings = [];
  const err = (file, line, message) => errors.push({ file, line, message });
  const warn = (file, line, message) => warnings.push({ file, line, message });
  for (const name of rust.missing) err(rustPath, 1, `could not extract the ${name} constant`);
  if (rust.missing.length) return { errors, warnings };

  const byNs = new Map();
  for (const name of rust.routerMethods) {
    const { ns } = splitMethodName(name);
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(name);
  }
  const rowByNs = new Map(catalog.routerRows.map((r) => [r.ns, r]));
  for (const [ns, names] of byNs) {
    const row = rowByNs.get(ns);
    if (!row) {
      err(catalogPath, catalog.router?.headingLine ?? 1, `router namespace ${ns} (${names.length} methods in ${rustPath}) has no row in the router table`);
      continue;
    }
    for (const name of names) {
      if (!cellHasSuffix(row.cell, splitMethodName(name).suffix)) err(catalogPath, row.line, `${name} is in ${rustPath} ROUTER_METHODS but missing from the ${ns} row`);
    }
    // A Count above the Rust total is the docs leading the pin; the token checks below cover it.
    if (row.count < names.length) err(catalogPath, row.line, `${ns} row says ${row.count} methods but ${rustPath} ROUTER_METHODS has ${names.length}`);
    const { tokens, invalid } = tokenizeRowSuffixes(row.cell);
    if (invalid.length) {
      for (const t of invalid) err(catalogPath, row.line, `${ns} row method list contains "${t}", which is not a method suffix — list the suffixes first, comma-separated, and put prose after " — "`);
      continue;
    }
    if (tokens.length !== row.count) err(catalogPath, row.line, `${ns} row says ${row.count} methods but lists ${tokens.length} (${tokens.join(', ')})`);
    for (const t of tokens) {
      if (!names.includes(`${ns}.${t}`)) warn(catalogPath, row.line, `${ns}.${t} is listed in the ${ns} row but ${ORPHAN_HINT_TAIL}`);
    }
  }
  for (const row of catalog.routerRows) {
    if (!byNs.has(row.ns)) warn(catalogPath, row.line, `router namespace ${row.ns} ${ORPHAN_HINT}`);
  }

  const rustAll = new Set([...rust.routerMethods, ...rust.fastPathMethods, ...rust.reverseMethods, ...rust.aliases.flat()]);
  const seen = new Set();
  for (const { methods } of docs) {
    for (const { name } of methods) {
      if (seen.has(name) || rustAll.has(name)) continue;
      const hit = findInCatalog(catalog, name);
      if (!hit || hit.section !== 'router') continue;
      seen.add(name);
      warn(catalogPath, hit.line, `${name} ${ORPHAN_HINT}`);
    }
  }

  const setDiff = (a, b) => a.filter((x) => !b.includes(x));
  if (catalog.fastPath) {
    for (const n of setDiff(rust.fastPathMethods, catalog.fastPath.names)) err(catalogPath, catalog.fastPath.line, `${n} is in ${rustPath} FASTPATH_METHODS but missing from the fast-path list`);
    for (const n of setDiff(catalog.fastPath.names, rust.fastPathMethods)) warn(catalogPath, catalog.fastPath.line, `${n} ${ORPHAN_HINT}`);
  }
  if (catalog.aliases) {
    const docPairs = catalog.aliases.pairs.map((p) => `${p.alias} → ${p.canonical}`);
    const rustPairs = rust.aliases.map(([a, b]) => `${a} → ${b}`);
    for (const p of setDiff(rustPairs, docPairs)) err(catalogPath, catalog.aliases.headingLine, `alias ${p} is in ${rustPath} METHOD_ALIASES but missing from the alias list`);
    for (const p of setDiff(docPairs, rustPairs)) warn(catalogPath, catalog.aliases.headingLine, `alias ${p} ${ORPHAN_HINT}`);
  }
  if (catalog.reverse) {
    const docNames = catalog.reverse.names.map((r) => r.name);
    for (const n of setDiff(rust.reverseMethods, docNames)) err(catalogPath, catalog.reverse.headingLine, `${n} is in ${rustPath} REVERSE_METHODS but missing from the reverse-RPC list`);
    for (const r of catalog.reverse.names) if (!rust.reverseMethods.includes(r.name)) warn(catalogPath, r.line, `${r.name} ${ORPHAN_HINT}`);
  }
  return { errors, warnings };
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Run both layers against `root`; returns `{ errors, warnings, skipped, layer2Ran }`. */
export async function runChecks(root) {
  const catalogText = await fs.readFile(path.join(root, CATALOG_PATH), 'utf8');
  const catalog = parseCatalog(catalogText);
  const methodFiles = (await fs.readdir(path.join(root, METHODS_DIR))).filter((f) => f.endsWith('.md')).sort();
  const docs = await Promise.all(
    methodFiles.map(async (f) => ({
      file: `${METHODS_DIR}/${f}`,
      methods: collectDocumentedMethods(await fs.readFile(path.join(root, METHODS_DIR, f), 'utf8')),
    })),
  );
  const errors = checkLayer1(catalog, docs);
  const rustText = await readIfExists(path.join(root, INTENTD_CATALOG_PATH));
  if (rustText === null) return { errors, warnings: [], skipped: `skipped: ${INTENTD_CATALOG_PATH} (submodule not initialized)`, layer2Ran: false };
  const layer2 = checkLayer2(catalog, extractRustCatalog(rustText), docs);
  errors.push(...layer2.errors);
  return { errors, warnings: layer2.warnings, skipped: null, layer2Ran: true };
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const { errors, warnings, skipped, layer2Ran } = await runChecks(root);
  if (skipped) console.log(skipped);
  for (const w of warnings) console.error(formatWarning(w));
  if (errors.length === 0) {
    const suffix = warnings.length ? `; ${warnings.length} warning(s): docs lead the intentd pin` : '';
    console.log(`Protocol method catalog is consistent (Layer 1${layer2Ran ? ' + Layer 2' : ''}${suffix}).`);
    return;
  }
  for (const e of errors) console.error(formatError(e));
  console.error(`${errors.length} protocol catalog error(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

