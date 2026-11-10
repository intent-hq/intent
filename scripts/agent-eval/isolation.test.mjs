import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROVIDERS, isolatedConfig, isolationLeaks, quarantineLeaks, syncBackCredentials } from './lib/daemon.mjs';
import { renderMarkdown } from './lib/report.mjs';
import { checkIsolation } from './run.mjs';

const claude = PROVIDERS['claude-code'];
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `agent-eval-${p}-`));

/** A dedicated sign-in dir the way the developer's looks after a sync. */
function syncedSource() {
  const dir = tmp('source');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"r1"}}');
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ userID: 'u', oauthAccount: { emailAddress: 'a@b' }, hasCompletedOnboarding: true, mcpServers: { mail: {} }, projects: { '/x': { mcpServers: { y: {} } } } }),
  );
  for (const root of ['skills', 'plugins']) {
    fs.mkdirSync(path.join(dir, root, 'synced', 'dev'), { recursive: true });
    fs.writeFileSync(path.join(dir, root, 'synced', 'dev', 'SKILL.md'), '# dev');
  }
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'personal rules');
  return dir;
}

/** What Claude Code's account sync does mid-run. */
function sync(dir) {
  fs.rmSync(path.join(dir, 'skills'), { force: true });
  fs.mkdirSync(path.join(dir, 'skills', 'synced', 'dev'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'synced', 'dev', 'SKILL.md'), '# dev');
}

test('the fresh config copies only the sign-in and blocks the sync roots', () => {
  const dir = isolatedConfig(claude, syncedSource(), path.join(tmp('run'), 'config'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.claude.json', '.credentials.json', 'plugins', 'skills']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')), {
    oauthAccount: { emailAddress: 'a@b' },
    userID: 'u',
    hasCompletedOnboarding: true,
  });
  for (const root of ['skills', 'plugins']) {
    const st = fs.statSync(path.join(dir, root));
    assert.ok(st.isFile() && st.size === 0, `${root} is an empty blocker file`);
    assert.throws(() => fs.mkdirSync(path.join(dir, root, 'synced'), { recursive: true }), /ENOTDIR|EEXIST/);
  }
  assert.deepEqual(isolationLeaks(dir, claude), []);
});

test('skills synced over a blocker are a leak, quarantined, and the blocker comes back', () => {
  const dir = isolatedConfig(claude, syncedSource(), path.join(tmp('run'), 'config'));
  sync(dir);
  assert.deepEqual(isolationLeaks(dir, claude), ['skills/synced/dev']);
  const quarantine = path.join(tmp('q'), 'q');
  quarantineLeaks(dir, claude, quarantine);
  assert.deepEqual(isolationLeaks(dir, claude), []);
  assert.ok(fs.existsSync(path.join(quarantine, 'skills', 'synced', 'dev', 'SKILL.md')));
  assert.ok(fs.statSync(path.join(dir, 'skills')).isFile());
});

test('checkIsolation taints the task-run and records it; a control is tainted but not recorded', () => {
  const dir = isolatedConfig(claude, syncedSource(), path.join(tmp('run'), 'config'));
  const isolation = { dir, spec: claude, quarantine: path.join(tmp('q'), 'q'), leaks: [] };
  const clean = { task: 'spec-section', harness: '3.12', run: 1, pass: true, detail: 'ok' };
  assert.deepEqual(checkIsolation(isolation, clean), []);
  assert.equal(clean.pass, true);

  sync(dir);
  const tainted = { task: 'spec-section', harness: '3.12', run: 2, pass: true, detail: 'ok' };
  checkIsolation(isolation, tainted);
  assert.equal(tainted.pass, false);
  assert.match(tainted.detail, /^config leak \(skills\/synced\/dev\)/);
  assert.deepEqual(isolation.leaks, [{ task: 'spec-section', harness: '3.12', run: 2, entries: ['skills/synced/dev'] }]);

  sync(dir);
  const control = { task: 'config-leak:control', harness: '3.12', run: 1, pass: true, control: 'leak' };
  checkIsolation(isolation, control);
  assert.deepEqual(control.isolationLeaks, ['skills/synced/dev']);
  assert.equal(isolation.leaks.length, 1);
  assert.deepEqual(isolationLeaks(dir, claude), []);
});

test('a refreshed token is written back to the dedicated dir, an unchanged one is not', () => {
  const source = syncedSource();
  const dir = isolatedConfig(claude, source, path.join(tmp('run'), 'config'));
  assert.deepEqual(syncBackCredentials(claude, dir, source), []);
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"refreshToken":"r2"}}');
  assert.deepEqual(syncBackCredentials(claude, dir, source), ['.credentials.json']);
  assert.match(fs.readFileSync(path.join(source, '.credentials.json'), 'utf8'), /r2/);
});

test('the report fails loudly on a leak and lists the negative controls', () => {
  const base = { provider: 'claude-code', createdAt: 'now', n: 1, harness: ['3.12'], tasks: ['spec-section'], versions: {}, results: [], summary: {} };
  const bad = renderMarkdown({ ...base, isolation: { ok: false, leaks: [{ task: 'spec-section', harness: '3.12', run: 2, entries: ['skills/synced/dev'] }] } });
  assert.match(bad, /## Isolation: FAILED/);
  assert.match(bad, /- 3\.12 spec-section#2: skills\/synced\/dev/);
  const good = renderMarkdown({ ...base, isolation: { ok: true, leaks: [] }, controls: [{ task: 'rename-workspace:control', harness: '3.12', expect: 'fail', held: true, detail: 'title=""' }] });
  assert.match(good, /Isolation: ok/);
  assert.match(good, /\| rename-workspace:control \| 3\.12 \| fail \| yes \|/);
});
