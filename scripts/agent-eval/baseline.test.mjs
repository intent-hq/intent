import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.AGENT_EVAL_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-cache-'));
const { baselineCache, taskHash } = await import('./run.mjs');
const { TASKS } = await import('./tasks.mjs');

const opts = { provider: 'claude-code', model: 'opus' };
const ver = { cli: '2.1.303', adapter: 'acp@0.95.0', intentdSha256: 'abc' };
const rename = TASKS.find((t) => t.id === 'rename-workspace');

test('a baseline cached before isolation checks is dropped, not reused', () => {
  const dir = path.join(process.env.AGENT_EVAL_CACHE, 'baseline', 'claude-code-opus');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify({ cli: ver.cli, adapter: ver.adapter, model: 'opus', intentd: 'abc' }));
  fs.writeFileSync(path.join(dir, `3.11-${rename.id}-1-${taskHash(rename)}.json`), JSON.stringify({ pass: false, detail: 'title="Agent readiness check"' }));
  const cache = baselineCache(opts, ver);
  assert.equal(cache.get('3.11', rename, 1), null);
  cache.put('3.11', rename, 1, { pass: true });
  assert.equal(baselineCache(opts, ver).get('3.11', rename, 1).pass, true);
});

test('the reset step is part of a task cache identity', () => {
  assert.notEqual(taskHash(rename), taskHash({ ...rename, afterFirstTurn: undefined }));
});
