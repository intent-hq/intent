#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const GITLINK_MODE = '160000';
export const EXEMPT_HEAD_REFS = ['auto/submodule-bump'];
export const EXEMPTION_LABEL = 'submodule-pin-intended';

const RAW_LINE = /^:(\d{6}) (\d{6}) \S+ \S+ \S+\t(.+)$/;

// --ignore-submodules=none overrides any `ignore = all` a branch could add to
// .gitmodules, which would otherwise hide the moved gitlink from the diff.
export function rawDiffArgs(baseRef, headRef = 'HEAD') {
  return ['diff', '--raw', '--no-renames', '--ignore-submodules=none', `${baseRef}...${headRef}`];
}

export function rawDiff(baseRef, options = {}) {
  return execFileSync('git', rawDiffArgs(baseRef), { encoding: 'utf8', ...options });
}

export function findMovedGitlinks(rawDiff) {
  const paths = [];
  for (const line of String(rawDiff ?? '').split('\n')) {
    const match = RAW_LINE.exec(line);
    if (!match) continue;
    const [, srcMode, dstMode, pathspec] = match;
    if (srcMode === GITLINK_MODE || dstMode === GITLINK_MODE) paths.push(pathspec);
  }
  return paths;
}

// The head-ref exemption is name-based, so it only counts for branches in this
// repository: a fork can name its branch anything.
export function findOffendingGitlinks(rawDiff, headRef, labels, { fromFork = false } = {}) {
  if (!fromFork && EXEMPT_HEAD_REFS.includes(headRef ?? '')) return [];
  if ((labels ?? []).includes(EXEMPTION_LABEL)) return [];
  return findMovedGitlinks(rawDiff);
}

function fromForkFromEnvironment() {
  const { PR_HEAD_REPO: headRepo, GITHUB_REPOSITORY: baseRepo } = process.env;
  return Boolean(headRepo && baseRepo && headRepo !== baseRepo);
}

function labelsFromEnvironment() {
  const labels = JSON.parse(process.env.PR_LABELS || '[]');
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    throw new TypeError('PR_LABELS must be a JSON array of strings');
  }
  return labels;
}

async function rawDiffFromArguments(argv) {
  if (argv[0] === '--base' && argv[1]) return { diff: rawDiff(argv[1]), baseRef: argv[1] };
  if (argv[0] && argv[0] !== '--base') return { diff: await fs.readFile(argv[0], 'utf8'), baseRef: '<base>' };
  throw new Error('usage: check-submodule-pins.mjs (--base <ref> | <raw-diff-file>)');
}

async function main() {
  const { diff, baseRef } = await rawDiffFromArguments(process.argv.slice(2));
  const offending = findOffendingGitlinks(diff, process.env.PR_HEAD_REF, labelsFromEnvironment(), {
    fromFork: fromForkFromEnvironment(),
  });
  if (offending.length === 0) {
    console.log('No manual submodule pin changes found.');
    return;
  }
  for (const pathspec of offending) console.error(`Submodule gitlink changed in this pull request: ${pathspec}`);
  console.error('Submodule pins are advanced only by the auto-bump-submodules workflow (auto/submodule-bump).');
  console.error(`Restore the base pin and commit: git checkout ${baseRef} -- <path> && git submodule update --checkout <path>`);
  console.error('If a bump is urgent, dispatch the workflow instead: gh workflow run auto-bump-submodules.yml');
  console.error(`Apply the ${EXEMPTION_LABEL} label only when a manual pin change is intentional.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
