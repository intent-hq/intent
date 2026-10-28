#!/usr/bin/env node
// Every docs/protocol fixture a component copies must go through the shared
// fixture-copy tool (scripts/lib/fixture-copy.mjs), so a new copy gets the
// "docs first, copy may lag" rules by default instead of a home-made check.
//
// A component file counts as a copy when its bytes equal any version of any
// file under docs/protocol/fixtures in this checkout's history, merge
// resolutions included (Git blob ids,
// so a partial clone with `--filter=blob:none` needs no blob downloads). It
// passes only when a registered defineFixtureCopy() spec owns that path, or it
// is a LEGACY copy listed below that predates the tool. Byte-identical copies
// are what export produces; a hand-edited copy is out of reach of this check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COPY as browserRouting } from './browser-routing-contract.mjs';
import { COPY as backendKeychain } from './backend-keychain-contract.mjs';
import { blobId, git, historyBlobs, isFixtureCopy, requireValue, runScript } from './lib/fixture-copy.mjs';
import { COPY as suggestedPrompts } from './suggested-prompts-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const FIXTURES_ROOT = 'docs/protocol/fixtures';
export const COMPONENTS = ['cloudlands-fe', 'intentd', 'ios'];

/** Every fixture copied through the shared tool. A new spec must be added here. */
export const REGISTERED = [browserRouting, backendKeychain, suggestedPrompts];

/**
 * Copies that predate the shared tool. Do not add entries: register new copies
 * with defineFixtureCopy(). Remove an entry once its copy moves onto the tool
 * or disappears (the check warns about stale entries).
 */
export const LEGACY = [
  {
    component: 'intentd',
    path: 'crates/intent-acp/tests/fixtures/scripts-compact.json',
    source: 'docs/protocol/fixtures/scripts/compact.json',
  },
  {
    component: 'intentd',
    path: 'crates/intent-core/tests/fixtures/truncated-read.json',
    source: 'docs/protocol/fixtures/notes/truncated-read.json',
  },
  {
    component: 'intentd',
    path: 'crates/intent-core/tests/goldens/checkout_repo_config.json',
    source: 'docs/protocol/fixtures/checkout-repo-config.json',
  },
  {
    component: 'intentd',
    path: 'crates/intent-transport/src/events/fixtures/event-stream-recovery.json',
    source: 'docs/protocol/fixtures/event-stream-recovery/contract.json',
  },
];

function lines(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function hashFiles(root, files) {
  return files.map((file) => ({ file, blob: blobId(fs.readFileSync(path.join(root, file))) }));
}

/** Untracked files Git would not ignore, plus tracked files from the index. */
function componentFiles(componentRoot) {
  const tracked = lines(git(componentRoot, 'ls-files', '-s', '-z')).map((entry) => {
    const [meta, file] = entry.split('\t');
    return { file, blob: meta.split(' ')[1], mode: meta.split(' ')[0] };
  }).filter((entry) => entry.mode !== '160000');
  const untracked = lines(git(componentRoot, 'ls-files', '-o', '--exclude-standard', '-z'))
    .filter((file) => fs.lstatSync(path.join(componentRoot, file)).isFile());
  return [...tracked, ...hashFiles(componentRoot, untracked)];
}

/** Map of blob id → canonical path, for every version of every fixture file. */
function canonicalBlobs(root) {
  const history = historyBlobs(root, FIXTURES_ROOT);
  requireValue(history, `${root} is not a Git checkout`);
  const { blobs, shallow } = history;
  const tracked = lines(git(root, 'ls-files', '-z', '--', FIXTURES_ROOT));
  const untracked = lines(git(root, 'ls-files', '-o', '--exclude-standard', '-z', '--', FIXTURES_ROOT));
  for (const { file, blob } of hashFiles(root, [...tracked, ...untracked].filter((f) => fs.existsSync(path.join(root, f))))) {
    if (!blobs.has(blob)) blobs.set(blob, file);
  }
  return { blobs, shallow };
}

/** Every scripts/*.mjs that defines a fixture copy must be registered. */
function unregisteredSpecs(root, registered) {
  const scripts = path.join(root, 'scripts');
  const names = new Set(registered.map((copy) => copy.name));
  const missing = [];
  for (const file of fs.readdirSync(scripts).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).sort()) {
    const text = fs.readFileSync(path.join(scripts, file), 'utf8');
    for (const match of text.matchAll(/defineFixtureCopy\(\{\s*name:\s*'([^']+)'/g)) {
      if (!names.has(match[1])) missing.push(`${file} (${match[1]})`);
    }
  }
  return missing;
}

/** { report, warnings }; throws listing every copy that bypasses the shared tool. */
export function checkFixtureCopies(root = ROOT, { registered = REGISTERED, legacy = LEGACY, components = COMPONENTS } = {}) {
  requireValue(registered.every(isFixtureCopy), 'REGISTERED must hold defineFixtureCopy() specs');
  const failures = unregisteredSpecs(root, registered)
    .map((spec) => `scripts/${spec} defines a fixture copy that is not in REGISTERED (scripts/check-fixture-copies.mjs)`);
  const warnings = [];
  const { blobs, shallow } = canonicalBlobs(root);
  const report = [`fixture copies: ${blobs.size} canonical fixture versions under ${FIXTURES_ROOT}`];
  if (shallow) {
    warnings.push('monorepo checkout is shallow: only fixture versions in the fetched history are compared; fetch full history (blob:none is enough)');
  }
  const usedLegacy = new Set();
  for (const component of components) {
    const componentRoot = path.join(root, 'packages', component);
    if (!fs.existsSync(path.join(componentRoot, '.git'))) {
      report.push(`${component}: uninspected (checkout uninitialized)`);
      continue;
    }
    const owned = new Map();
    for (const copy of registered) for (const file of copy.copiedFiles(component)) owned.set(file, copy.name);
    let copies = 0;
    for (const { file, blob } of componentFiles(componentRoot)) {
      const source = blobs.get(blob);
      if (!source) continue;
      copies += 1;
      if (owned.has(file)) continue;
      const entry = legacy.find((l) => l.component === component && l.path === file);
      if (entry) {
        usedLegacy.add(entry);
        continue;
      }
      failures.push(`packages/${component}/${file} is a copy of ${source} that bypasses the shared fixture-copy tool; `
        + 'describe it with defineFixtureCopy() (scripts/lib/fixture-copy.mjs), add the spec to REGISTERED in '
        + 'scripts/check-fixture-copies.mjs, and export the copy with that fixture\'s contract script');
    }
    report.push(`${component}: ${copies} fixture copies found; all registered or legacy`);
  }
  for (const entry of legacy) {
    const initialized = fs.existsSync(path.join(root, 'packages', entry.component, '.git'));
    if (initialized && !usedLegacy.has(entry)) {
      warnings.push(`LEGACY entry packages/${entry.component}/${entry.path} no longer matches any version of ${entry.source}; remove it from scripts/check-fixture-copies.mjs`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} fixture cop${failures.length === 1 ? 'y bypasses' : 'ies bypass'} the shared tool:\n- ${failures.join('\n- ')}`);
  }
  return { report: report.join('\n'), warnings };
}

export function main(args = process.argv.slice(2), { warn = (line) => console.warn(`::warning::${line}`) } = {}) {
  const { values } = parseArgs({ args, options: { root: { type: 'string' } } });
  const { report, warnings } = checkFixtureCopies(path.resolve(values.root ?? ROOT));
  for (const line of warnings) warn(line);
  return report;
}

runScript(import.meta.url, 'check-fixture-copies', () => main());
