#!/usr/bin/env node

// Check that every bulk-transfer method the app calls rides a transfer
// connection. intentd classifies each method in `PAYLOAD_CLASSES`
// (crates/intent-transport/src/catalog.rs); `bulk(...)` rows may return more
// than the 500 KiB read budget. cloudlands-fe sends the methods in
// `TRANSFER_METHODS` (src/features/backend/main/transfer-connections.ts) on a
// short-lived connection of their own over remote transports; everything else
// shares the main connection with the heartbeat. Before this check,
// `file.read`, `git.showFile` and `note.readAsset` could send up to 40 MiB on
// the main connection while only `file.readChunk` used a transfer connection.
//
// Both sides are read as text, never executed (upstream, a component checkout
// is an untrusted PR head). Comments are stripped first.
//
// Rules:
//   - a BulkTransfer method the app calls (a quoted literal anywhere under the
//     fe src/ tree) but does not list in TRANSFER_METHODS fails;
//   - a BulkTransfer method the app never names only warns (intentd lands a
//     new bulk method before the app adopts it);
//   - a TRANSFER_METHODS entry intentd classifies as anything but
//     BulkTransfer or Mutation (an upload) fails: a capped read does not
//     belong there;
//   - a TRANSFER_METHODS entry intentd does not classify only warns
//     (app-first entry, or left over after a daemon removal);
//   - an intentd without PAYLOAD_CLASSES (pins before the payload budget
//     sweep) skips with a notice;
//   - docs lead the pin: until BOTH components carry the bounded-object-read
//     work (intentd classifies ADOPTION_MARKER and the app lists it in
//     TRANSFER_METHODS), every error is reported as a warning and the check
//     passes. Once both pins have it, the rules above are enforced.
//   - see docs/protocol/methods/files-terminal-browser.md "Bounded object reads".

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { stripComments } from './check-agent-feature-toggles.mjs';
import { describeCheckout, formatBanner, formatOffPinWarning } from './submodule-ref.mjs';

export const INTENTD_DIR = 'packages/intentd';
export const FE_DIR = 'packages/cloudlands-fe';
export const CATALOG_FILE = 'crates/intent-transport/src/catalog.rs';
export const FE_FILE = 'src/features/backend/main/transfer-connections.ts';
export const FE_SRC = 'src';
const CHECK = 'check-transfer-methods';
/** A method added by the bounded-object-read work on both sides. */
export const ADOPTION_MARKER = 'git.showFileChunk';

const CLASS_FNS = ['bounded', 'bulk', 'proxy', 'subscription', 'mutation'];
const METHOD_RE = /^[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+$/;

/**
 * `Map<method, class>` from `PAYLOAD_CLASSES`, `null` when the constant does
 * not exist, or throws naming what changed.
 */
export function parsePayloadClasses(source, file = CATALOG_FILE) {
  const text = stripComments(source, 'rust');
  const start = text.search(/^pub const PAYLOAD_CLASSES: &\[PayloadBudget\] = &\[$/m);
  if (start === -1) {
    if (/\bPAYLOAD_CLASSES\b/.test(text)) throw new Error(`${file}: PAYLOAD_CLASSES is no longer \`pub const PAYLOAD_CLASSES: &[PayloadBudget] = &[\`; update ${CHECK}`);
    return null;
  }
  const rest = text.slice(start);
  const end = rest.search(/^\];$/m);
  if (end === -1) throw new Error(`${file}: end of PAYLOAD_CLASSES not found; update ${CHECK}`);
  const body = rest.slice(rest.indexOf('\n') + 1, end);
  const classes = new Map();
  const callRe = new RegExp(`(?<![\\w.])(${CLASS_FNS.join('|')})\\(\\s*"([^"\\\\]*)"`, 'g');
  for (const m of body.matchAll(callRe)) {
    const [, fn, method] = m;
    if (classes.has(method)) throw new Error(`${file}: PAYLOAD_CLASSES lists ${method} more than once`);
    classes.set(method, fn);
  }
  // Every row must be one of the constructor calls: a struct literal or a new
  // helper would otherwise go missing silently.
  const rows = body.split('\n').filter((line) => line.trim() && !/^\s*[)\],]*\s*$/.test(line) && /^\s{4}\S/.test(line));
  const unrecognized = rows.filter((line) => !new RegExp(`^\\s{4}(?:${CLASS_FNS.join('|')})\\(`).test(line));
  if (unrecognized.length) throw new Error(`${file}: PAYLOAD_CLASSES row \`${unrecognized[0].trim().slice(0, 60)}\` is not a ${CLASS_FNS.join('/')}(...) call; update ${CHECK}`);
  if (!classes.size) throw new Error(`${file}: PAYLOAD_CLASSES has no rows; update ${CHECK}`);
  return classes;
}

/** The string literals of `TRANSFER_METHODS`, or throws naming what changed. */
export function parseTransferMethods(source, file = FE_FILE) {
  const text = stripComments(source, 'ts');
  const m = text.match(/^const TRANSFER_METHODS = new Set\(\[([\s\S]*?)\]\);$/m);
  if (!m) throw new Error(`${file}: \`const TRANSFER_METHODS = new Set([...]);\` not found; update ${CHECK}`);
  const values = [...m[1].matchAll(/'([^'\\]*)'/g)].map((x) => x[1]);
  const leftover = m[1].replace(/'[^'\\]*'/g, '').replace(/[\s,]/g, '');
  if (leftover) throw new Error(`${file}: TRANSFER_METHODS holds something other than string literals (${leftover.slice(0, 60)}); update ${CHECK}`);
  return values;
}

/** Quoted method-name literals in the app's sources (comments stripped). */
export function collectCalledMethods(files) {
  const called = new Set();
  for (const source of files) {
    const text = stripComments(source, 'ts');
    for (const m of text.matchAll(/(['"`])([a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+)\1/g)) {
      if (METHOD_RE.test(m[2])) called.add(m[2]);
    }
  }
  return called;
}

/**
 * Which components already carry the bounded-object-read work. Returns
 * `{ intentd, fe, both }`.
 */
export function adoption({ classes, transfer }) {
  const intentd = classes.has(ADOPTION_MARKER);
  const fe = transfer.includes(ADOPTION_MARKER);
  return { intentd, fe, both: intentd && fe };
}

/**
 * Compare the sides. Returns `{ errors, warnings, routed, pending }`;
 * `pending` names the components that have not adopted the contract yet, in
 * which case every finding is a warning.
 */
export function compare(input) {
  const result = compareStrict(input);
  const adopted = adoption(input);
  if (adopted.both) return { ...result, pending: null };
  const missing = [!adopted.intentd && 'intentd', !adopted.fe && 'cloudlands-fe'].filter(Boolean);
  const pending = missing.join(' and ');
  const verb = missing.length > 1 ? 'do not carry' : 'does not carry';
  return {
    errors: [],
    warnings: [
      `not enforced yet: ${pending} ${verb} the bounded-object-read work (${ADOPTION_MARKER} classified bulk(...) and listed in TRANSFER_METHODS); the findings below become errors once both pins have it`,
      ...result.errors.map((error) => `pending adoption: ${error}`),
      ...result.warnings,
    ],
    routed: result.routed,
    pending,
  };
}

function compareStrict({ classes, transfer, called, files = {} }) {
  const f = { catalog: `${INTENTD_DIR}/${CATALOG_FILE}`, fe: `${FE_DIR}/${FE_FILE}`, ...files };
  const errors = [];
  const warnings = [];
  const transferSet = new Set(transfer);
  for (const dup of new Set(transfer.filter((v, i) => transfer.indexOf(v) !== i))) errors.push(`TRANSFER_METHODS lists ${dup} more than once (${f.fe})`);
  let routed = 0;
  for (const [method, cls] of classes) {
    if (cls !== 'bulk') continue;
    if (transferSet.has(method)) {
      routed += 1;
    } else if (called.has(method)) {
      errors.push(
        `${method} is BulkTransfer in PAYLOAD_CLASSES (${f.catalog}) and the app calls it, but TRANSFER_METHODS (${f.fe}) does not route it: ` +
          `its replies may exceed the read budget and would block the main connection. Add it to TRANSFER_METHODS, or cap its replies and classify it bounded(...).`,
      );
    } else {
      warnings.push(`${method} is BulkTransfer in PAYLOAD_CLASSES but the app does not call it yet; add it to TRANSFER_METHODS when it does`);
    }
  }
  for (const method of transfer) {
    const cls = classes.get(method);
    if (cls === undefined) warnings.push(`${method} is in TRANSFER_METHODS (${f.fe}) but intentd does not classify it (app-first entry, or left over after a daemon removal)`);
    else if (cls !== 'bulk' && cls !== 'mutation') {
      errors.push(`${method} is in TRANSFER_METHODS (${f.fe}) but PAYLOAD_CLASSES (${f.catalog}) classifies it ${cls}(...), not bulk(...): remove it from TRANSFER_METHODS, or classify it bulk(...) if its replies really exceed the read budget`);
    }
  }
  return { errors, warnings, routed };
}

/** Every .ts / .svelte file under `dir`, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:ts|svelte)$/.test(entry.name) && !/\.(?:test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Read and compare the checkouts under `root`. */
export function run(root, { intentdDir = INTENTD_DIR, feDir = FE_DIR, log = console.log, warn = console.error } = {}) {
  const read = (dir, file) => {
    const full = path.resolve(root, dir, file);
    if (!fs.existsSync(full)) throw new Error(`${path.join(dir, file)} not found; initialize the submodule (make ensure-intentd-submodule ensure-fe-submodule) or update ${CHECK} if the file moved`);
    return fs.readFileSync(full, 'utf8');
  };
  for (const [dir, pinDir, what] of [[intentdDir, INTENTD_DIR, 'payload classes'], [feDir, FE_DIR, 'transfer methods']]) {
    const ref = describeCheckout(root, dir, { pinDir });
    const banner = formatBanner(ref, { check: CHECK, what });
    if (banner) log(banner);
    const offPin = formatOffPinWarning(ref);
    if (offPin) warn(offPin);
  }
  const files = { catalog: path.join(intentdDir, CATALOG_FILE), fe: path.join(feDir, FE_FILE) };
  const classes = parsePayloadClasses(read(intentdDir, CATALOG_FILE), files.catalog);
  if (classes === null) return { skipped: `${files.catalog} has no PAYLOAD_CLASSES yet`, errors: [], warnings: [], routed: 0 };
  const transfer = parseTransferMethods(read(feDir, FE_FILE), files.fe);
  const srcDir = path.resolve(root, feDir, FE_SRC);
  if (!fs.existsSync(srcDir)) throw new Error(`${path.join(feDir, FE_SRC)} not found; update ${CHECK}`);
  const called = collectCalledMethods(sourceFiles(srcDir).map((file) => fs.readFileSync(file, 'utf8')));
  return compare({ classes, transfer, called, files });
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, 'intentd-dir': { type: 'string' }, 'fe-dir': { type: 'string' } } });
  const root = path.resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)));
  let result;
  try {
    result = run(root, { intentdDir: values['intentd-dir'] ?? INTENTD_DIR, feDir: values['fe-dir'] ?? FE_DIR });
  } catch (error) {
    console.error(`${CHECK}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.skipped) {
    console.log(`${CHECK}: skipped — ${result.skipped}`);
    return;
  }
  for (const warning of result.warnings) console.log(`::warning::${CHECK}: ${warning}`);
  for (const error of result.errors) console.error(`${CHECK}: error: ${error}`);
  if (result.errors.length) {
    process.exitCode = 1;
    return;
  }
  if (result.pending) {
    console.log(`${CHECK}: pass (not enforced yet; waiting on ${result.pending})`);
    return;
  }
  console.log(`${CHECK}: ${result.routed} BulkTransfer methods ride transfer connections`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
