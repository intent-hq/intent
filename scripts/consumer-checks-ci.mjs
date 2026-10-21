#!/usr/bin/env node
// Select the full reusable workflow exercise and its intentd pin from the
// tested monorepo tree. No API token, submodule checkout, or external packages.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = (name, value) => {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(name + ' must be a full commit SHA');
  return value;
};

function relevant(file) {
  return [
    '.github/workflows/consumer-checks.yml',
    '.github/workflows/ci.yml',
    'scripts/transfer-selection-ci.test.mjs',
    'Makefile',
    '.gitmodules',
  ].includes(file) ||
    file.startsWith('scripts/consumer-checks') ||
    file.startsWith('scripts/ci-gate') ||
    file.startsWith('scripts/test-transfer-selection-contract');
}

try {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!['pull_request', 'merge_group'].includes(eventName)) {
    throw new Error('unsupported event: ' + eventName);
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const head = sha('GITHUB_SHA', process.env.GITHUB_SHA);
  const base = sha('base SHA', eventName === 'pull_request' ? event.pull_request?.base?.sha : event.merge_group?.base_sha);
  if (eventName === 'merge_group' && event.merge_group?.head_sha !== head) {
    throw new Error('merge_group.head_sha does not match GITHUB_SHA');
  }
  if (git('rev-parse', '--verify', 'HEAD').trim() !== head) {
    throw new Error('checkout HEAD does not match GITHUB_SHA');
  }

  // Disabling rename detection exposes both sides as deletion/addition, so
  // moving a workflow out of the selected paths still exercises it. NUL
  // delimiters preserve filenames containing spaces or newlines.
  const changed = git('diff', '--name-only', '--no-renames', '-z', base, head, '--').split('\0').filter(Boolean);
  const selected = changed.some(relevant);
  const pin = git('ls-tree', '-z', head, '--', 'packages/intentd')
    .match(/^160000 commit ([0-9a-f]{40})\tpackages\/intentd\0$/)?.[1];
  if (!pin) throw new Error('tested tree has no intentd commit gitlink');
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  // Publish only after every read succeeds; errors must never become a skip.
  appendFileSync(process.env.GITHUB_OUTPUT, 'selected=' + selected + '\nintentd-sha=' + pin + '\n');
  console.log('consumer-checks-ci: exercise ' + (selected ? 'selected' : 'skipped') + ' at intentd@' + pin);
} catch (error) {
  console.error('consumer-checks-ci: ' + error.message);
  process.exitCode = 1;
}
