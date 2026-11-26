#!/usr/bin/env node
// Compares the "Profile-capable bases" table and the base-only "Reserved keys"
// rows in docs/protocol/methods/provider-profiles.md with the `profile` field of
// intentd's provider registry golden, and fails when any docs/protocol page
// lists two or more account folders instead of linking to the table.
//
// Direction: docs lead an addition. A base, key or launch step the golden has
// and the table lacks fails; one only the table has warns (pending) until the
// daemon catches up, so the docs PR can land first. Read as data only. Run by
// `make check-provider-profile-bases`, part of `make consumer-checks`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue, runScript } from './lib/fixture-copy.mjs';
import { scanMarkdown } from './lib/markdown-tables.mjs';

export const DOCS_PATH = 'docs/protocol/methods/provider-profiles.md';
export const GOLDEN_PATH = 'packages/intentd/crates/intent-providers/tests/goldens/provider_registry.json';
export const BASES_HEADER = ['Base', 'Credentials (auto-mark)', 'Account folder', 'Launch-only step for a key profile'];
export const RESERVED_HEADER = ['Key or pattern', 'Why'];
const BASES_TABLE = `${DOCS_PATH} "Profile-capable bases" table`;
const RESERVED_TABLE = `${DOCS_PATH} "Reserved keys" table`;
// Base-only keys the daemon reserves as launch wiring outside the profile spec,
// so the golden does not carry them (intentd provider_profiles.rs
// launch_wired_keys).
export const LAUNCH_WIRED = [['codex', 'INITIAL_AGENT_MODE']];
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE_ONLY = /^`([a-z][a-z0-9-]*)` only:/;

const codeSpans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const sorted = (values) => [...values].sort();

function onlyTable(markdown, header, label) {
  const tables = scanMarkdown(markdown).tables
    .filter((table) => table.header.length === header.length && table.header.every((cell, i) => cell === header[i]));
  requireValue(tables.length === 1, `${label}: expected one table headed | ${header.join(' | ')} |, found ${tables.length}`);
  return tables[0];
}

/** The golden's profile bases as { base, credentials, folders, launchStep, reserved }. */
export function goldenBases(golden) {
  const shape = `has an unknown shape; update scripts/check-provider-profile-bases.mjs`;
  requireValue(Array.isArray(golden?.providers), `${GOLDEN_PATH}: providers must be an array`);
  for (const row of golden.providers) requireValue(Object.hasOwn(row ?? {}, 'profile'), `${GOLDEN_PATH} ${row?.id}: row ${shape}`);
  const bases = golden.providers.filter((row) => row.profile).map(({ id, profile }) => {
    requireValue(Array.isArray(profile.credentialKeys) && Array.isArray(profile.accountDirKeys)
      && Array.isArray(profile.credentialLaunchEnv) && Array.isArray(profile.reservedKeys)
      && Object.hasOwn(profile, 'apiKeyHome'),
    `${GOLDEN_PATH} ${id}: profile ${shape}`);
    return {
      base: id,
      credentials: sorted(profile.credentialKeys),
      folders: sorted(profile.accountDirKeys),
      launchStep: profile.apiKeyHome != null || profile.credentialLaunchEnv.length > 0,
      reserved: sorted(profile.reservedKeys),
    };
  });
  requireValue(bases.length > 0, `${GOLDEN_PATH}: no provider has a profile; ${shape}`);
  return bases;
}

/** The "Profile-capable bases" rows, in the same shape as goldenBases. */
export function docsBases(markdown) {
  const seen = new Set();
  return onlyTable(markdown, BASES_HEADER, BASES_TABLE).rows.map(({ line, cells }) => {
    const [base] = codeSpans(cells[0] ?? '');
    requireValue(base && cells.length === BASES_HEADER.length, `${DOCS_PATH}:${line}: a base row needs \`base\` and ${BASES_HEADER.length} cells`);
    requireValue(!seen.has(base), `${DOCS_PATH}:${line}: ${base} is listed twice`);
    seen.add(base);
    return {
      base,
      line,
      credentials: sorted(codeSpans(cells[1])),
      folders: cells[2].trim() === 'none' ? [] : sorted(codeSpans(cells[2])),
      launchStep: !cells[3].trim().startsWith('none'),
    };
  });
}

/** The keys of each Reserved keys row whose reason starts with "`<base>` only:". */
export function docsBaseOnlyReserved(markdown) {
  return onlyTable(markdown, RESERVED_HEADER, RESERVED_TABLE).rows.flatMap(({ cells }) => {
    const base = BASE_ONLY.exec((cells[1] ?? '').trim())?.[1];
    return base ? codeSpans(cells[0]).map((key) => ({ base, key })) : [];
  });
}

/** Enumerations of two or more account folders (`A`, `B` or `C`) in a page. */
export function folderLists(text, folders) {
  if (folders.length < 2) return [];
  const name = `\`(?:${folders.map((folder) => folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\``;
  const list = new RegExp(`${name}(?:\\s*,\\s*(?:(?:or|and)\\s+)?${name}|\\s+(?:or|and)\\s+${name})+`, 'g');
  return [...text.matchAll(list)].map((m) => ({ line: text.slice(0, m.index).split('\n').length, list: m[0].replace(/\s+/g, ' ') }));
}

/** Compare the docs with the golden; returns { errors, warnings }. */
export function compare({ markdown, golden, pages = [] }) {
  const errors = [];
  const warnings = [];
  const expected = goldenBases(golden);
  const rows = docsBases(markdown);
  const byBase = new Map(rows.map((row) => [row.base, row]));
  const missing = (have, want) => want.filter((key) => !have.includes(key));
  for (const want of expected) {
    const row = byBase.get(want.base);
    if (!row) {
      errors.push(`${BASES_TABLE}: profile base ${want.base} has no row; add it (credentials ${want.credentials.join(', ')}; account folder ${want.folders.join(', ') || 'none'})`);
      continue;
    }
    for (const [field, label] of [['credentials', 'credentials'], ['folders', 'account folder']]) {
      const lacking = missing(row[field], want[field]);
      if (lacking.length) errors.push(`${BASES_TABLE} ${want.base} (line ${row.line}): ${label} lacks ${lacking.join(', ')}`);
      const extra = missing(want[field], row[field]);
      if (extra.length) warnings.push(`${BASES_TABLE} ${want.base}: ${label} ${extra.join(', ')} not in the registry yet (pending; the docs lead)`);
    }
    if (want.launchStep && !row.launchStep) errors.push(`${BASES_TABLE} ${want.base} (line ${row.line}): the registry has a launch-only step for a key profile; link its section`);
    if (!want.launchStep && row.launchStep) warnings.push(`${BASES_TABLE} ${want.base}: launch-only step not in the registry yet (pending; the docs lead)`);
  }
  const known = new Set(expected.map(({ base }) => base));
  for (const row of rows.filter(({ base }) => !known.has(base))) {
    warnings.push(`${BASES_TABLE}: ${row.base} is not a profile base in the registry yet (pending; the docs lead)`);
  }

  const marked = docsBaseOnlyReserved(markdown);
  const wanted = [...expected.flatMap(({ base, reserved }) => reserved.map((key) => ({ base, key }))),
    ...LAUNCH_WIRED.map(([base, key]) => ({ base, key }))];
  const same = (a) => (b) => a.base === b.base && a.key === b.key;
  for (const want of wanted.filter((want) => !marked.some(same(want)))) {
    errors.push(`${RESERVED_TABLE}: ${want.key} is reserved for ${want.base} only; add a row whose reason starts with "\`${want.base}\` only:"`);
  }
  for (const row of marked.filter((row) => !wanted.some(same(row)))) {
    warnings.push(`${RESERVED_TABLE}: ${row.key} (\`${row.base}\` only) is not reserved in the registry yet (pending; the docs lead)`);
  }

  const folders = sorted(new Set([...expected, ...rows].flatMap((row) => row.folders)));
  for (const page of pages) {
    for (const hit of folderLists(page.text, folders)) {
      errors.push(`${page.path}:${hit.line}: lists account folders (${hit.list}); link to ${DOCS_PATH}#account-folders instead`);
    }
  }
  return { errors, warnings, bases: expected.length };
}

function protocolPages(root) {
  const dir = path.join(root, 'docs/protocol');
  return fs.readdirSync(dir, { recursive: true })
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => ({ path: path.posix.join('docs/protocol', file.split(path.sep).join('/')), text: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

/** Check the docs under monorepo `root` against the intentd checkout there. */
export function checkProviderProfileBases(root = ROOT) {
  const goldenFile = path.join(root, GOLDEN_PATH);
  requireValue(fs.existsSync(goldenFile), `${GOLDEN_PATH} not found; is packages/intentd checked out?`);
  const { errors, warnings, bases } = compare({
    markdown: fs.readFileSync(path.join(root, DOCS_PATH), 'utf8'),
    golden: JSON.parse(fs.readFileSync(goldenFile, 'utf8')),
    pages: protocolPages(root),
  });
  for (const warning of warnings) console.log(`::warning::provider-profile-bases: ${warning}`);
  requireValue(errors.length === 0, `${errors.length} mismatch(es) with ${GOLDEN_PATH}:\n  ${errors.join('\n  ')}`);
  return `provider-profile-bases: ${bases} profile bases and their base-only reserved keys match ${GOLDEN_PATH}`;
}

runScript(import.meta.url, 'check-provider-profile-bases', () => {
  requireValue(process.argv.length === 2, 'usage: check-provider-profile-bases.mjs');
  return checkProviderProfileBases();
});
