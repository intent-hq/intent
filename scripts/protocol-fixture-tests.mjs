#!/usr/bin/env node
// Runs every docs/protocol fixture test: each docs/protocol/fixtures/**/*.test.mjs,
// found by walking the tree, so a new test runs without editing a list.
// `make check-protocol-fixture-tests` calls this; `make docs-check` (and so
// `make consumer-checks`) depends on that target, and the ci.yml docs-check
// job calls it too, so a green local docs-check means the same tests passed.
//
// It fails before running anything when a file under docs/protocol/ imports
// node:test but is not named fixtures/**/*.test.mjs (for example
// fixtures/x/contract.spec.mjs or docs/protocol/foo.test.mjs): such a test
// would otherwise be silently skipped. It also fails when it finds no tests.
//
// Usage: node scripts/protocol-fixture-tests.mjs [--list]
//   --list  print the discovered test files and exit (no tests run)
// Incident: on #8191 desktop-control/contract.test.mjs ran only in CI, so a
// green local `make docs-check` still failed CI (run 41162793615).

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS_DIR = 'docs/protocol';
export const FIXTURES_DIR = 'docs/protocol/fixtures';
const SCRIPT_EXT = /\.(?:[cm]?js|[cm]?ts)$/;
const NODE_TEST_IMPORT = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]node:test['"]/;

function walk(root, dir) {
  const abs = path.join(root, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) files.push(...walk(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** Sorted repo-relative paths of docs/protocol/fixtures/**\/*.test.mjs. */
export function discoverFixtureTests(root) {
  return walk(root, FIXTURES_DIR)
    .filter(file => file.endsWith('.test.mjs'))
    .sort();
}

/** Files under docs/protocol/ that import node:test but are not discovered. */
export function findStrayTests(root, discovered = discoverFixtureTests(root)) {
  const run = new Set(discovered);
  return walk(root, DOCS_DIR)
    .filter(file => SCRIPT_EXT.test(file) && !run.has(file))
    .filter(file => statSync(path.join(root, file)).size < 4 * 1024 * 1024)
    .filter(file => NODE_TEST_IMPORT.test(readFileSync(path.join(root, file), 'utf8')))
    .sort();
}

/** Returns { files, errors }; errors non-empty means do not run. */
export function plan(root) {
  const files = discoverFixtureTests(root);
  const errors = [];
  for (const stray of findStrayTests(root, files)) {
    errors.push(
      `${stray}: imports node:test but is not a ${FIXTURES_DIR}/**/*.test.mjs file, so nothing runs it; ` +
        `move or rename it to match that pattern`,
    );
  }
  if (files.length === 0) errors.push(`no ${FIXTURES_DIR}/**/*.test.mjs files found`);
  return { files, errors };
}

function main(argv) {
  const unknown = argv.filter(arg => arg !== '--list');
  if (unknown.length > 0) {
    console.error(`protocol-fixture-tests: unknown argument '${unknown[0]}'`);
    console.error('usage: node scripts/protocol-fixture-tests.mjs [--list]');
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { files, errors } = plan(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(`protocol-fixture-tests: error: ${error}`);
    return 1;
  }
  if (argv.includes('--list')) {
    for (const file of files) console.log(file);
    return 0;
  }
  console.log(`protocol-fixture-tests: running ${files.length} test files under ${FIXTURES_DIR}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
