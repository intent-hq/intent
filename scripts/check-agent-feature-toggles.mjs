#!/usr/bin/env node

// Check that every `agentFeatures.*` setting intentd registers for
// `settings.list` has a toggle in cloudlands-fe's Settings → Agent features
// list. intentd#2804 added `agentFeatures.secretRequests` (off by default) and
// it shipped in cloudlands-fe v2.253.2 and v2.255.0 with no way to turn it on;
// nothing compared the two lists until this check (fixed in cloudlands-fe#3890).
//
// Both sides are read as text, never executed (upstream, a component checkout
// is an untrusted PR head):
//   - intentd: the first string argument of each definition constructor call
//     (`boolean(`, `number(`, ...) inside `definitions()` in settings.rs.
//     Any other `"agentFeatures.<name>"` literal there fails closed, so a new
//     registration form needs a deliberate checker change.
//   - cloudlands-fe: `FEATURE_PATHS` (read by the settings form) and the
//     `path:` entries of `FEATURES` (read by the harness features modal) in
//     agent-feature-definitions.ts; the two must agree.
//
// Direction rules (the same "docs lead the pin" order as
// check-protocol-field-parity's staged table):
//   - a daemon setting the FE does not list fails, at the pins and on upstream
//     intentd PRs alike, unless EXEMPT below names it. A daemon-first setting
//     whose toggle lands later gets an EXEMPT entry here BEFORE the intentd PR;
//   - an FE path the daemon does not register only warns (an FE-first toggle,
//     or one left over after a daemon removal);
//   - a stale EXEMPT entry (the FE now lists the path, or the daemon no longer
//     registers it) only warns, so the FE PR that adds the toggle is not
//     blocked on removing the entry; remove it in a follow-up.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { describeCheckout, formatBanner, formatOffPinWarning } from './submodule-ref.mjs';

export const INTENTD_FILE = 'packages/intentd/crates/intent-services/src/settings.rs';
export const FE_FILE = 'packages/cloudlands-fe/src/lib/components/settings/agent-feature-definitions.ts';
const CHECK = 'check-agent-feature-toggles';
const PREFIX = 'agentFeatures.';

/**
 * `agentFeatures.*` settings intentd registers that deliberately have no
 * Settings → Agent features toggle, each with a one-line reason. For a
 * daemon-first setting whose toggle is coming, name the cloudlands-fe PR
 * (e.g. 'toggle lands in cloudlands-fe#1234') and land the entry before the
 * intentd PR.
 */
export const EXEMPT = {};

const PATH_RE = /^agentFeatures\.[A-Za-z][A-Za-z0-9]*$/;

/** Drop whole-line `//` comments; keeps line numbers out of scope but avoids touching `//` inside strings. */
const stripLineComments = (text) => text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

/** Registered `agentFeatures.*` paths in intentd's `definitions()`, or throws naming what changed. */
export function parseIntentdPaths(source) {
  const start = source.search(/^pub\(crate\) fn definitions\(\) -> Vec<SettingDefinition> \{$/m);
  if (start === -1) throw new Error(`${INTENTD_FILE}: \`pub(crate) fn definitions() -> Vec<SettingDefinition>\` not found; update ${CHECK} for the new registry shape`);
  const rest = source.slice(start);
  const end = rest.search(/^\}$/m);
  if (end === -1) throw new Error(`${INTENTD_FILE}: end of definitions() not found`);
  const body = stripLineComments(rest.slice(0, end));
  const literals = [...body.matchAll(/"(agentFeatures\.[^"\\]*)"/g)].map((m) => m[1]);
  const registered = [...body.matchAll(/\b[a-z_]+\(\s*"(agentFeatures\.[^"\\]*)"/g)].map((m) => m[1]);
  const unrecognized = literals.filter((literal) => !registered.includes(literal));
  if (unrecognized.length) {
    throw new Error(`${INTENTD_FILE}: definitions() names ${unrecognized.join(', ')} outside a constructor's first argument; update ${CHECK} for the new registration form`);
  }
  if (!registered.length) throw new Error(`${INTENTD_FILE}: definitions() registers no agentFeatures.* setting; update ${CHECK} if the registry moved`);
  return registered;
}

/** The single-quoted string literals of an array/object source span; anything else left over fails closed. */
function quotedStrings(span, what, leftoverRe) {
  const values = [...span.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
  const leftover = span.replace(/'[^'\\]*'/g, '').replace(leftoverRe, '');
  if (leftover.trim()) throw new Error(`${FE_FILE}: ${what} holds something other than string literals (${leftover.trim().slice(0, 60)}); update ${CHECK}`);
  return values;
}

/** `{ featurePaths, featureEntries }` from the FE definitions file, or throws naming what changed. */
export function parseFePaths(source) {
  const text = stripLineComments(source);
  const list = text.match(/^export const FEATURE_PATHS = \[([\s\S]*?)\] as const;$/m);
  if (!list) throw new Error(`${FE_FILE}: \`export const FEATURE_PATHS = [...] as const;\` not found; update ${CHECK}`);
  const featurePaths = quotedStrings(list[1], 'FEATURE_PATHS', /[\s,]/g);
  const features = text.match(/^export const FEATURES\b[\s\S]*?= \[\n([\s\S]*?)^\];$/m);
  if (!features) throw new Error(`${FE_FILE}: \`export const FEATURES ... = [ ... ];\` not found; update ${CHECK}`);
  const pathLines = [...features[1].matchAll(/^\s*path:(.*)$/gm)].map((m) => m[1].trim());
  const featureEntries = pathLines.map((value) => {
    const m = value.match(/^'([^'\\]*)',$/);
    if (!m) throw new Error(`${FE_FILE}: FEATURES entry \`path: ${value}\` is not a string literal; update ${CHECK}`);
    return m[1];
  });
  return { featurePaths, featureEntries };
}

const duplicates = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

/**
 * Compare the two lists. Returns `{ errors, warnings, matched }`; `offPin` adds
 * the rebase hint to a missing-toggle error.
 */
export function compare({ daemon, featurePaths, featureEntries, exempt = EXEMPT, offPin = false }) {
  const errors = [];
  const warnings = [];
  for (const [name, values] of [['intentd definitions()', daemon], ['FEATURE_PATHS', featurePaths], ['FEATURES', featureEntries]]) {
    for (const dup of duplicates(values)) errors.push(`${name} lists ${dup} more than once`);
    for (const value of values) if (!PATH_RE.test(value)) errors.push(`${name}: ${value} is not an agentFeatures.<name> path`);
  }
  const fe = new Set(featurePaths);
  const entries = new Set(featureEntries);
  for (const p of featurePaths) if (!entries.has(p)) errors.push(`${p} is in FEATURE_PATHS but has no FEATURES entry (the harness features modal would miss it); add it to FEATURES in ${FE_FILE}`);
  for (const p of featureEntries) if (!fe.has(p)) errors.push(`${p} has a FEATURES entry but is not in FEATURE_PATHS (the settings form would not load it); add it to FEATURE_PATHS in ${FE_FILE}`);

  const registered = new Set(daemon);
  for (const [p, reason] of Object.entries(exempt)) {
    if (!p.startsWith(PREFIX)) errors.push(`EXEMPT entry ${p} is not an ${PREFIX}* path`);
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`EXEMPT entry ${p} needs a one-line reason in scripts/${CHECK}.mjs`);
    if (fe.has(p)) warnings.push(`EXEMPT entry ${p} is stale: cloudlands-fe now lists it; remove the entry from scripts/${CHECK}.mjs`);
    else if (!registered.has(p)) warnings.push(`EXEMPT entry ${p} is stale: intentd no longer registers it; remove the entry from scripts/${CHECK}.mjs`);
  }
  let matched = 0;
  for (const p of daemon) {
    if (fe.has(p)) {
      matched += 1;
    } else if (!Object.hasOwn(exempt, p)) {
      const hint = offPin ? ' If origin/main already exempts it, rebase this monorepo worktree.' : '';
      errors.push(
        `${p} is registered by intentd (${INTENTD_FILE} definitions()) but has no Settings → Agent features toggle. ` +
          `Add it to FEATURE_PATHS and FEATURES in ${FE_FILE}, or, for a setting that intentionally has no toggle (or whose toggle lands later), ` +
          `add it with a reason to EXEMPT in scripts/${CHECK}.mjs before the intentd PR.${hint}`,
      );
    }
  }
  for (const p of featurePaths) {
    if (!registered.has(p)) warnings.push(`${p} has a toggle but intentd does not register it (FE-first toggle, or left over after a daemon removal)`);
  }
  return { errors, warnings, matched };
}

export function run(root, { exempt = EXEMPT, log = console.log, warn = console.error } = {}) {
  const read = (file) => {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) throw new Error(`${file} not found; initialize the submodule (make ensure-intentd-submodule ensure-fe-submodule) or update ${CHECK} if the file moved`);
    return fs.readFileSync(full, 'utf8');
  };
  const intentdRef = describeCheckout(root, 'packages/intentd');
  const feRef = describeCheckout(root, 'packages/cloudlands-fe');
  for (const [ref, what] of [[intentdRef, 'settings definitions'], [feRef, 'agent feature toggles']]) {
    const banner = formatBanner(ref, { check: CHECK, what });
    if (banner) log(banner);
    const offPin = formatOffPinWarning(ref);
    if (offPin) warn(offPin);
  }
  const daemon = parseIntentdPaths(read(INTENTD_FILE));
  const { featurePaths, featureEntries } = parseFePaths(read(FE_FILE));
  const offPin = Boolean(intentdRef.checkout && intentdRef.pin && (intentdRef.checkout !== intentdRef.pin || intentdRef.dirty));
  return compare({ daemon, featurePaths, featureEntries, exempt, offPin });
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' } } });
  const root = path.resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)));
  let result;
  try {
    result = run(root);
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
  const exempted = Object.keys(EXEMPT).length;
  console.log(`${CHECK}: ${result.matched} agentFeatures.* settings have Settings toggles${exempted ? ` (${exempted} exempt)` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
