#!/usr/bin/env node

// Check that every `agentFeatures.*` setting intentd registers for
// `settings.list` has a toggle in cloudlands-fe's Settings → Agent features
// list. intentd#2804 added `agentFeatures.secretRequests` (off by default) and
// it shipped in cloudlands-fe v2.253.2 and v2.255.0 with no way to turn it on;
// nothing compared the two lists until this check (fixed in cloudlands-fe#3890).
//
// Both sides are read as text, never executed (upstream, a component checkout
// is an untrusted PR head). Comments are stripped first.
//   - intentd: the first string argument of each definition constructor call
//     (`boolean(`, `number(`, ...) inside `definitions()` in settings.rs, the
//     schema `settings.list` returns. Any other `"agentFeatures.<name>"`
//     literal there fails closed. The `agentFeatures.*` entries of
//     `KNOWN_PATHS` (settings_registry.rs, every TOML-backed key) must be the
//     same set, so a toggle registered through a helper this scan cannot see
//     fails closed too.
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

export const INTENTD_DIR = 'packages/intentd';
export const FE_DIR = 'packages/cloudlands-fe';
export const DEFINITIONS_FILE = 'crates/intent-services/src/settings.rs';
export const REGISTRY_FILE = 'crates/intent-services/src/settings_registry.rs';
export const FE_FILE = 'src/lib/components/settings/agent-feature-definitions.ts';
const CHECK = 'check-agent-feature-toggles';
const SCRIPT = `scripts/${CHECK}.mjs`;
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
// The definition constructors in settings.rs; a builder method such as
// `.with_x("agentFeatures.y")` is not one, so its literal fails closed.
const CONSTRUCTOR_RE = /(?<![.\w])(?:boolean|number|string|secret|enumerated|nullable_enumerated|object)\(\s*"(agentFeatures\.[^"\\]*)"/g;

/**
 * Replace comments with spaces (newlines kept), leaving string literals intact.
 * `lang` is 'rust' (`"..."`, raw `r#"..."#`, nested block comments; `'` is a
 * char or lifetime, not a string) or 'ts' (`'...'`, `"..."`, backtick
 * templates read as plain strings).
 */
export function stripComments(text, lang) {
  let out = '';
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const quotes = lang === 'ts' ? ['"', "'", '`'] : ['"'];
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth) {
        if (lang === 'rust' && text[j] === '/' && text[j + 1] === '*') { depth += 1; j += 2; }
        else if (text[j] === '*' && text[j + 1] === '/') { depth -= 1; j += 2; }
        else j += 1;
      }
      out += blank(text.slice(i, j));
      i = j;
    } else if (lang === 'rust' && c === 'r' && /^r#*"/.test(text.slice(i, i + 260)) && !/\w/.test(text[i - 1] ?? '')) {
      const hashes = text.slice(i + 1).match(/^#*/)[0];
      const close = text.indexOf(`"${hashes}`, i + 2 + hashes.length);
      const stop = close === -1 ? text.length : close + 1 + hashes.length;
      out += text.slice(i, stop);
      i = stop;
    } else if (lang === 'rust' && c === "'" && /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.test(text.slice(i, i + 12))) {
      const len = text.slice(i, i + 12).match(/^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/)[0].length;
      out += text.slice(i, i + len);
      i += len;
    } else if (quotes.includes(c)) {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Registered `agentFeatures.*` paths in intentd's `definitions()`, or throws naming what changed. */
export function parseDefinitionPaths(source, file = DEFINITIONS_FILE) {
  const text = stripComments(source, 'rust');
  const start = text.search(/^pub\(crate\) fn definitions\(\) -> Vec<SettingDefinition> \{$/m);
  if (start === -1) throw new Error(`${file}: \`pub(crate) fn definitions() -> Vec<SettingDefinition>\` not found; update ${CHECK} for the new registry shape`);
  const rest = text.slice(start);
  const end = rest.search(/^\}$/m);
  if (end === -1) throw new Error(`${file}: end of definitions() not found`);
  const body = rest.slice(0, end);
  const literals = [...body.matchAll(/"(agentFeatures\.[^"\\]*)"/g)].map((m) => m[1]);
  const registered = [...body.matchAll(CONSTRUCTOR_RE)].map((m) => m[1]);
  // Count occurrences, so a reference to a registered path from a builder
  // method (`.with_x("agentFeatures.hostExec")`) is not hidden by the
  // registration itself.
  const count = (values, value) => values.filter((v) => v === value).length;
  const unrecognized = [...new Set(literals)].filter((literal) => count(literals, literal) > count(registered, literal));
  if (unrecognized.length) {
    throw new Error(`${file}: definitions() names ${unrecognized.join(', ')} outside a definition constructor's first argument; update ${CHECK} for the new registration form`);
  }
  if (!registered.length) throw new Error(`${file}: definitions() registers no agentFeatures.* setting; update ${CHECK} if the registry moved`);
  return registered;
}

/** The `agentFeatures.*` entries of `KNOWN_PATHS`, or throws naming what changed. */
export function parseKnownPaths(source, file = REGISTRY_FILE) {
  const text = stripComments(source, 'rust');
  const list = text.match(/^pub\(crate\) const KNOWN_PATHS: &\[&str\] = &\[([\s\S]*?)^\];$/m);
  if (!list) throw new Error(`${file}: \`pub(crate) const KNOWN_PATHS: &[&str] = &[...];\` not found; update ${CHECK}`);
  const leftover = list[1].replace(/"[^"\\]*"/g, '').replace(/[\s,]/g, '');
  if (leftover) throw new Error(`${file}: KNOWN_PATHS holds something other than string literals (${leftover.slice(0, 60)}); update ${CHECK}`);
  return [...list[1].matchAll(/"([^"\\]*)"/g)].map((m) => m[1]).filter((p) => p.startsWith(PREFIX));
}

/** The single-quoted string literals of a source span; anything else left over fails closed. */
function quotedStrings(span, file, what) {
  const values = [...span.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
  const leftover = span.replace(/'[^'\\]*'/g, '').replace(/[\s,]/g, '');
  if (leftover) throw new Error(`${file}: ${what} holds something other than string literals (${leftover.slice(0, 60)}); update ${CHECK}`);
  return values;
}

/** `{ featurePaths, featureEntries }` from the FE definitions file, or throws naming what changed. */
export function parseFePaths(source, file = FE_FILE) {
  const text = stripComments(source, 'ts');
  const list = text.match(/^export const FEATURE_PATHS = \[([\s\S]*?)\] as const;$/m);
  if (!list) throw new Error(`${file}: \`export const FEATURE_PATHS = [...] as const;\` not found; update ${CHECK}`);
  const featurePaths = quotedStrings(list[1], file, 'FEATURE_PATHS');
  const features = text.match(/^export const FEATURES\b[\s\S]*?= \[\n([\s\S]*?)^\];$/m);
  if (!features) throw new Error(`${file}: \`export const FEATURES ... = [ ... ];\` not found; update ${CHECK}`);
  // One `{` ... `},` block per entry at two-space indent, each with one
  // `path: '<literal>',` line; a spread, a one-line entry or a computed path
  // fails closed rather than going missing.
  const featureEntries = [];
  let open = null;
  for (const line of features[1].split('\n')) {
    if (!line.trim()) continue;
    if (/^ {2}\S/.test(line)) {
      if (line === '  {' && open === null) open = [];
      else if (line === '  },' && open !== null) {
        if (open.length !== 1) throw new Error(`${file}: a FEATURES entry has ${open.length} \`path:\` lines; update ${CHECK}`);
        featureEntries.push(open[0]);
        open = null;
      } else throw new Error(`${file}: FEATURES holds \`${line.trim().slice(0, 60)}\`, not a multi-line \`{ ... },\` entry; update ${CHECK}`);
      continue;
    }
    if (open === null) throw new Error(`${file}: FEATURES holds \`${line.trim().slice(0, 60)}\` outside an entry; update ${CHECK}`);
    const value = line.match(/^ {4}path:(.*)$/)?.[1].trim();
    if (value === undefined) continue;
    const m = value.match(/^'([^'\\]*)',$/);
    if (!m) throw new Error(`${file}: FEATURES entry \`path: ${value}\` is not a string literal; update ${CHECK}`);
    open.push(m[1]);
  }
  if (open !== null) throw new Error(`${file}: unterminated FEATURES entry; update ${CHECK}`);
  return { featurePaths, featureEntries };
}

const duplicates = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

/**
 * Compare the lists. Returns `{ errors, warnings, matched, exempted }`. `hint`
 * is appended to a missing-toggle error (the local off-pin rebase hint).
 */
export function compare({ daemon, known = daemon, featurePaths, featureEntries, exempt = EXEMPT, hint = '', files = {} }) {
  const f = { definitions: `${INTENTD_DIR}/${DEFINITIONS_FILE}`, registry: `${INTENTD_DIR}/${REGISTRY_FILE}`, fe: `${FE_DIR}/${FE_FILE}`, ...files };
  const errors = [];
  const warnings = [];
  for (const [name, values] of [['intentd definitions()', daemon], ['intentd KNOWN_PATHS', known], ['FEATURE_PATHS', featurePaths], ['FEATURES', featureEntries]]) {
    for (const dup of duplicates(values)) errors.push(`${name} lists ${dup} more than once`);
    for (const value of values) if (!PATH_RE.test(value)) errors.push(`${name}: ${value} is not an agentFeatures.<name> path`);
  }
  const registered = new Set(daemon);
  const knownSet = new Set(known);
  for (const p of known) if (!registered.has(p)) errors.push(`${p} is in KNOWN_PATHS (${f.registry}) but ${CHECK} found no definitions() constructor for it in ${f.definitions}; update ${CHECK} to read its registration`);
  for (const p of daemon) if (!knownSet.has(p)) errors.push(`${p} is registered in definitions() (${f.definitions}) but missing from KNOWN_PATHS (${f.registry}); update ${CHECK} if KNOWN_PATHS moved`);

  const fe = new Set(featurePaths);
  const entries = new Set(featureEntries);
  for (const p of featurePaths) if (!entries.has(p)) errors.push(`${p} is in FEATURE_PATHS but has no FEATURES entry (the harness features modal would miss it); add it to FEATURES in ${f.fe}`);
  for (const p of featureEntries) if (!fe.has(p)) errors.push(`${p} has a FEATURES entry but is not in FEATURE_PATHS (the settings form would not load it); add it to FEATURE_PATHS in ${f.fe}`);

  let exempted = 0;
  for (const [p, reason] of Object.entries(exempt)) {
    if (!p.startsWith(PREFIX)) errors.push(`EXEMPT entry ${p} is not an ${PREFIX}* path`);
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`EXEMPT entry ${p} needs a one-line reason in ${SCRIPT}`);
    if (fe.has(p)) warnings.push(`EXEMPT entry ${p} is stale: cloudlands-fe now lists it; remove the entry from ${SCRIPT}`);
    else if (!registered.has(p)) warnings.push(`EXEMPT entry ${p} is stale: intentd no longer registers it; remove the entry from ${SCRIPT}`);
    else exempted += 1;
  }
  let matched = 0;
  for (const p of daemon) {
    if (fe.has(p)) {
      matched += 1;
    } else if (!Object.hasOwn(exempt, p)) {
      errors.push(
        `${p} is registered by intentd (${f.definitions} definitions()) but has no Settings → Agent features toggle. ` +
          `Add it to FEATURE_PATHS and FEATURES in ${f.fe}, or, for a setting that intentionally has no toggle (or whose toggle lands later), ` +
          `add it with a reason to EXEMPT in ${SCRIPT} before the intentd PR.${hint}`,
      );
    }
  }
  for (const p of featurePaths) {
    if (!registered.has(p)) warnings.push(`${p} has a toggle but intentd does not register it (FE-first toggle, or left over after a daemon removal)`);
  }
  return { errors, warnings, matched, exempted };
}

/**
 * Read and compare the checkouts under `root`. `intentdDir` / `feDir` are
 * relative to `root` (the Makefile's INTENTD_DIR / FE_DIR).
 */
export function run(root, { intentdDir = INTENTD_DIR, feDir = FE_DIR, exempt = EXEMPT, env = process.env, log = console.log, warn = console.error } = {}) {
  const read = (dir, file) => {
    const full = path.resolve(root, dir, file);
    if (!fs.existsSync(full)) throw new Error(`${path.join(dir, file)} not found; initialize the submodule (make ensure-intentd-submodule ensure-fe-submodule) or update ${CHECK} if the file moved`);
    return fs.readFileSync(full, 'utf8');
  };
  const intentdRef = describeCheckout(root, intentdDir, { pinDir: INTENTD_DIR });
  const feRef = describeCheckout(root, feDir, { pinDir: FE_DIR });
  for (const [ref, what] of [[intentdRef, 'settings definitions'], [feRef, 'agent feature toggles']]) {
    const banner = formatBanner(ref, { check: CHECK, what });
    if (banner) log(banner);
    const offPin = formatOffPinWarning(ref);
    if (offPin) warn(offPin);
  }
  const files = { definitions: path.join(intentdDir, DEFINITIONS_FILE), registry: path.join(intentdDir, REGISTRY_FILE), fe: path.join(feDir, FE_FILE) };
  const daemon = parseDefinitionPaths(read(intentdDir, DEFINITIONS_FILE), files.definitions);
  const known = parseKnownPaths(read(intentdDir, REGISTRY_FILE), files.registry);
  const { featurePaths, featureEntries } = parseFePaths(read(feDir, FE_FILE), files.fe);
  // A local intentd branch newer than the pin may need an exemption that
  // origin/main already has. In CI the monorepo is main (upstream, intentd is
  // off-pin by construction), so the hint would only mislead.
  const ci = env.CI && !['false', '0'].includes(env.CI);
  const offPin = Boolean(intentdRef.checkout && intentdRef.pin && (intentdRef.checkout !== intentdRef.pin || intentdRef.dirty));
  const hint = offPin && !ci ? ' If origin/main already exempts it, rebase this monorepo worktree.' : '';
  return compare({ daemon, known, featurePaths, featureEntries, exempt, hint, files });
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
  for (const warning of result.warnings) console.log(`::warning::${CHECK}: ${warning}`);
  for (const error of result.errors) console.error(`${CHECK}: error: ${error}`);
  if (result.errors.length) {
    process.exitCode = 1;
    return;
  }
  console.log(`${CHECK}: ${result.matched} agentFeatures.* settings have Settings toggles${result.exempted ? ` (${result.exempted} exempt)` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
