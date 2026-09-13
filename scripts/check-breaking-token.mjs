#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const FOOTER_TOKENS = ['BREAKING CHANGE:', 'BREAKING-CHANGE:', 'Release-As:'];
export const EXEMPTION_LABEL = 'breaking-change-intended';

function containsFooterToken(text) {
  return FOOTER_TOKENS.some((token) => String(text ?? '').includes(token));
}

export function findOffendingLocations(prBody, commitMessages, labels) {
  if ((labels ?? []).includes(EXEMPTION_LABEL)) return [];

  const locations = [];
  if (containsFooterToken(prBody)) locations.push('pull request body');
  for (const [index, message] of (commitMessages ?? []).entries()) {
    if (containsFooterToken(message)) locations.push(`commit ${index + 1}`);
  }
  return locations;
}

function labelsFromEnvironment() {
  const labels = JSON.parse(process.env.PR_LABELS || '[]');
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    throw new TypeError('PR_LABELS must be a JSON array of strings');
  }
  return labels;
}

async function main() {
  const commitMessagesPath = process.argv[2];
  if (!commitMessagesPath) throw new Error('usage: check-breaking-token.mjs <commit-messages-file>');

  const commitMessages = await fs.readFile(commitMessagesPath, 'utf8');
  const locations = findOffendingLocations(process.env.PR_BODY, [commitMessages], labelsFromEnvironment());
  if (locations.length === 0) {
    console.log('No unintended release footer tokens found.');
    return;
  }
  for (const location of locations) console.error(`Unintended release footer token found in ${location}.`);
  console.error(`Apply the ${EXEMPTION_LABEL} label only when the release impact is intentional.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();