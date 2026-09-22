import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeCheckout, formatBanner, formatOffPinWarning, submoduleOf } from './submodule-ref.mjs';

const DIR = 'packages/intentd';
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A monorepo whose packages/intentd is a nested git repo recorded as the gitlink; `advance()` commits
// again in intentd so the checkout moves off the pin.
async function makeGitRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submodule-ref-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const intentd = path.join(root, DIR);
  await fs.mkdir(intentd, { recursive: true });
  await fs.writeFile(path.join(intentd, 'file.txt'), 'pin\n');
  git(intentd, 'init', '-q', '-b', 'main');
  git(intentd, 'add', '.');
  git(intentd, 'commit', '-q', '-m', 'pin');
  const pin = git(intentd, 'rev-parse', 'HEAD');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},${DIR}`);
  git(root, 'commit', '-q', '-m', 'monorepo');
  const advance = async () => {
    await fs.writeFile(path.join(intentd, 'file.txt'), 'ahead\n');
    git(intentd, 'commit', '-q', '-am', 'ahead of the pin');
    return git(intentd, 'rev-parse', 'HEAD');
  };
  return { root, pin, advance };
}

test('submoduleOf names the packages/<name> directory of a repo-relative file, or null', () => {
  assert.equal(submoduleOf('packages/intentd/crates/x/src/lib.rs'), 'packages/intentd');
  assert.equal(submoduleOf('packages/cloudlands-fe/src/types.ts'), 'packages/cloudlands-fe');
  assert.equal(submoduleOf('docs/protocol/events.md'), null);
  assert.equal(submoduleOf('packages/intentd'), null);
});

test('formatBanner renders the checkout and pin shapes for any check, component and subject', () => {
  const checkout = 'a'.repeat(40);
  const pin = 'b'.repeat(40);
  const label = { check: 'check-x', what: 'catalog' };
  assert.equal(formatBanner({ source: 'checkout', dir: DIR, checkout, pin }, label), `check-x: intentd catalog from ${DIR} checkout aaaaaaa (recorded pin bbbbbbb)`);
  assert.equal(formatBanner({ source: 'checkout', dir: DIR, checkout, pin: null }, label), `check-x: intentd catalog from ${DIR} checkout aaaaaaa (recorded pin unreadable)`);
  assert.equal(formatBanner({ source: 'pin', dir: DIR, pin }, label), 'check-x: intentd catalog from recorded pin bbbbbbb');
  assert.equal(
    formatBanner({ source: 'checkout', dir: 'packages/cloudlands-fe', checkout, pin }, { check: 'check-y', what: 'types' }),
    `check-y: cloudlands-fe types from packages/cloudlands-fe checkout aaaaaaa (recorded pin bbbbbbb)`,
  );
  assert.equal(formatBanner({ source: 'checkout', dir: DIR, checkout: null, pin }, label), null);
  assert.equal(formatBanner(null, label), null);
});

test('formatOffPinWarning fires only for a checkout off a readable pin; the remedy defaults to restoring the checkout', () => {
  const checkout = 'a'.repeat(40);
  const pin = 'b'.repeat(40);
  assert.equal(
    formatOffPinWarning({ source: 'checkout', dir: DIR, checkout, pin }),
    `warning: ${DIR} checkout aaaaaaa is off the recorded pin bbbbbbb; results reflect the checkout, not the pin. Run git submodule update --checkout ${DIR} to compare against the pin.`,
  );
  assert.equal(
    formatOffPinWarning({ source: 'checkout', dir: DIR, checkout, pin }, { remedy: 'Run make x --pinned.' }),
    `warning: ${DIR} checkout aaaaaaa is off the recorded pin bbbbbbb; results reflect the checkout, not the pin. Run make x --pinned.`,
  );
  assert.equal(formatOffPinWarning({ source: 'checkout', dir: DIR, checkout: pin, pin }), null);
  assert.equal(formatOffPinWarning({ source: 'checkout', dir: DIR, checkout, pin: null }), null);
  assert.equal(formatOffPinWarning({ source: 'checkout', dir: DIR, checkout: null, pin }), null);
  assert.equal(formatOffPinWarning({ source: 'pin', dir: DIR, pin }), null);
  assert.equal(formatOffPinWarning(null), null);
});

test('describeCheckout outside any git repository yields null refs: no banner, no warning', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submodule-ref-plain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, DIR), { recursive: true });
  const ref = describeCheckout(root, DIR);
  assert.deepEqual(ref, { source: 'checkout', dir: DIR, checkout: null, pin: null });
  assert.equal(formatBanner(ref, { check: 'check-x', what: 'catalog' }), null);
  assert.equal(formatOffPinWarning(ref), null);
});

test('describeCheckout reads the checkout HEAD and the recorded gitlink; at the pin they agree, off it they differ', async (t) => {
  const { root, pin, advance } = await makeGitRoot(t);
  assert.deepEqual(describeCheckout(root, DIR), { source: 'checkout', dir: DIR, checkout: pin, pin });
  assert.equal(formatOffPinWarning(describeCheckout(root, DIR)), null);
  const head = await advance();
  assert.notEqual(head, pin);
  const ref = describeCheckout(root, DIR);
  assert.deepEqual(ref, { source: 'checkout', dir: DIR, checkout: head, pin });
  assert.equal(formatBanner(ref, { check: 'check-x', what: 'catalog' }), `check-x: intentd catalog from ${DIR} checkout ${head.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})`);
  assert.match(formatOffPinWarning(ref), new RegExp(`^warning: ${DIR} checkout ${head.slice(0, 7)} is off the recorded pin ${pin.slice(0, 7)};`));
});
