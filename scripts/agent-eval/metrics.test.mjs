import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collect, renderTable } from './metrics.mjs';

async function fixtureDb() {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-metrics-')), 'intentd.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE agent_session (id TEXT PRIMARY KEY, provider TEXT, harness_version TEXT NOT NULL DEFAULT '1.0');
    CREATE TABLE agent_message (id TEXT PRIMARY KEY, agent_id TEXT, seq INTEGER, role TEXT, content TEXT, created_at TEXT);
  `);
  const session = db.prepare('INSERT INTO agent_session VALUES (?, ?, ?)');
  session.run('old', 'codex', '3.9');
  session.run('new', 'claude-code', '3.10');
  const msg = db.prepare('INSERT INTO agent_message VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const add = (agent, role, blocks, at = '2026-11-01T00:00:00Z') => msg.run(`m${++n}`, agent, n, role, JSON.stringify(blocks), at);
  const use = (id, code) => ({ type: 'tool_use', name: 'workspace_api', toolCallId: id, input: { code } });
  const res = (id, output, isError) => ({ type: 'tool_result', tool_use_id: id, output, is_error: isError });
  add('old', 'user', [{ type: 'text', text: 'go' }]);
  add('old', 'assistant', [use('a', 'ws.note.get("spec")'), res('a', 'Error: not a function', 1), use('b', 'ws.help("note")'), res('b', 'docs', 0)]);
  add('old', 'assistant', [{ type: 'text', text: 'no tools here' }]);
  add('new', 'user', [{ type: 'text', text: 'go' }], '2026-11-08T00:00:00Z');
  add('new', 'assistant', [use('c', 'ws.note.get("spec")'), res('c', 'Error: not a function', true), use('d', 'ws.note.read("spec")'), res('d', 'ok', false)], '2026-11-08T00:00:00Z');
  db.close();
  return file;
}

test('groups scores by harness version and counts only workspace_api errors', async () => {
  const db = await fixtureDb();
  const by = await collect({ db });
  assert.deepEqual(Object.keys(by).sort(), ['3.10', '3.9']);
  assert.deepEqual(
    { s: by['3.9'].sessions, calls: by['3.9'].wsCalls, err: by['3.9'].wsErrors, unk: by['3.9'].unknownMethod, unrec: by['3.9'].unrecovered, help: by['3.9'].helpCalls },
    { s: 1, calls: 2, err: 1, unk: 1, unrec: 1, help: 1 },
  );
  assert.equal(by['3.10'].unrecovered, 0);
  assert.match(renderTable(by), /\| 3\.9 \| 1 \| 2 \| 1 \| 1 \| 1 \| 1 \| 500\.00 /);
  assert.ok(renderTable(by).indexOf('| 3.9 ') < renderTable(by).indexOf('| 3.10 '), 'versions sort numerically');
});

test('--since and --provider narrow the sessions', async () => {
  const db = await fixtureDb();
  assert.deepEqual(Object.keys(await collect({ db, since: '2026-11-05' })), ['3.10']);
  assert.deepEqual(Object.keys(await collect({ db, provider: 'codex' })), ['3.9']);
});
