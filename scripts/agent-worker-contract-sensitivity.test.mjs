// Deliberately violate the model and prove the maintained regression suite notices.
// No repository edits or provider sessions; every mutant runs in an isolated directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const model = readFileSync(new URL('./agent-worker-contract.mjs', import.meta.url), 'utf8');
const mutations = [
  ['duplicate refresh', "if (spawned || TERMINAL.has(row.providerState)) return false;", "if (TERMINAL.has(row.providerState)) return false;"],
  ['eviction recreation', 'if (this.seen.has(u.asyncTaskId)) return false;', '// broken eviction fence'],
  ['cross-session ownership', 'if (frame?.sessionId !== this.scope.acpSessionId) return false;', '// broken session fence'],
  ['generation ownership', 'context[k] === this.scope[k]', "(k === 'connectionGeneration' || context[k] === this.scope[k])"],
  ['metadata revives tool', "if (backgrounded && supplied.length === 0) return { ordinary: false, backgrounded: true };", "if (backgrounded && supplied.length === 0) { tools[update.toolCallId] = {status:'in_progress'}; return {ordinary:true, backgrounded:true}; }"],
  ['mixed marker drops data', 'if (backgrounded && supplied.length === 0)', 'if (backgrounded)'],
  ['synthetic failure claims exit', "row.exitEvidence = { kind: 'unknown' };", "row.exitEvidence = { kind: 'observed', exitCode: 1 };"],
  ['recreation loses tombstones', 'seen: new Set(c.seen)', 'seen: new Set()'],
  ['unacknowledged subscription accepts push', 'if (!validId(this.subscriptionId)) return false;', '// broken active subscription guard'],
  ['malformed acknowledgement replaces binding', 'if (!validId(id)) return false;', '// broken acknowledgement guard'],
  ['freshness boundary', 'now >= row.freshUntil', 'now > row.freshUntil'],
];
for (const [name, before, after] of mutations) test(`regressions reject ${name}`, (t) => {
  assert.ok(model.includes(before), `mutation anchor missing: ${name}`);
  const root = mkdtempSync(join(tmpdir(), 'worker-contract-mutant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'docs/protocol/fixtures/agent-workers/v1'), { recursive: true });
  writeFileSync(join(root, 'scripts/agent-worker-contract.mjs'), model.replace(before, after));
  copyFileSync(new URL('./agent-worker-contract.test.mjs', import.meta.url), join(root, 'scripts/agent-worker-contract.test.mjs'));
  copyFileSync(new URL('../docs/protocol/fixtures/agent-workers/v1/corpus.json', import.meta.url), join(root, 'docs/protocol/fixtures/agent-workers/v1/corpus.json'));
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'scripts/agent-worker-contract.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 15000, env,
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /ERR_ASSERTION/, 'must fail an assertion, not loading/syntax');
});
