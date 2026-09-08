#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  '.agents',
  '.git',
  '.github',
  '.gitignore',
  '.gitmodules',
  '.intent',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'Makefile',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'cliff.toml',
  'docs',
  'packages',
  'scripts',
]);

export async function findUnexpectedEntries(root, allowed = ALLOWED_TOP_LEVEL_ENTRIES) {
  const entries = await fs.readdir(root);
  return entries.filter((entry) => !allowed.has(entry)).sort();
}

export function formatUnexpectedEntry(entry) {
  return `Unexpected top-level entry: ${entry}. Add it to ALLOWED_TOP_LEVEL_ENTRIES in scripts/check-root-hygiene.mjs if intentional.`;
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const unexpected = await findUnexpectedEntries(root);
  if (unexpected.length === 0) {
    console.log('Repository root contains only allowed entries.');
    return;
  }
  for (const entry of unexpected) console.error(formatUnexpectedEntry(entry));
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();