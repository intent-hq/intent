#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const GITLINK_MODE = '160000';
export const EXEMPT_HEAD_REFS = ['auto/submodule-bump'];
export const EXEMPTION_LABEL = 'submodule-pin-intended';

const RAW_LINE = /^:(\d{6}) (\d{6}) \S+ \S+ \S+\t(.+)$/;

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

export function findOffendingGitlinks(rawDiff, headRef, labels) {
  if (EXEMPT_HEAD_REFS.includes(headRef ?? '')) return [];
  if ((labels ?? []).includes(EXEMPTION_LABEL)) return [];
  return findMovedGitlinks(rawDiff);
}

function labelsFromEnvironment() {
  const labels = JSON.parse(process.env.PR_LABELS || '[]');
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    throw new TypeError('PR_LABELS must be a JSON array of strings');
  }
  return labels;
}

async function main() {
  const rawDiffPath = process.argv[2];
  if (!rawDiffPath) throw new Error('usage: check-submodule-pins.mjs <raw-diff-file>');

  const rawDiff = await fs.readFile(rawDiffPath, 'utf8');
  const offending = findOffendingGitlinks(rawDiff, process.env.PR_HEAD_REF, labelsFromEnvironment());
  if (offending.length === 0) {
    console.log('No manual submodule pin changes found.');
    return;
  }
  for (const pathspec of offending) console.error(`Submodule gitlink changed in this pull request: ${pathspec}`);
  console.error('Submodule pins are advanced only by the auto-bump-submodules workflow (auto/submodule-bump).');
  console.error('Drop the gitlink change from this branch (git submodule update --checkout <path>) and, if a bump is urgent, run: gh workflow run auto-bump-submodules.yml');
  console.error(`Apply the ${EXEMPTION_LABEL} label only when a manual pin change is intentional.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
