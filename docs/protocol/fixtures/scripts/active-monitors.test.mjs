import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveMonitors } from './active-monitors-model.mjs';
const prepared = () => {
  const m = new ActiveMonitors();
  m.store.runs.script = { runId: 'run-a', final: false };
  const { monitor } = m.register();
  return { m, id: monitor.monitorId, wake: `script-monitor:${monitor.monitorId}` };
};
const decision = { settledAt: 50, reason: 'finished', result: { outcome: 'succeeded', exitCode: 0, stoppedAt: 50 } };

for (const state of ['completed', 'expired', 'triggered', 'cancelled']) {
  test(`${state} atomically removes monitor and preserves only appropriate delivery work`, () => {
    const { m, id, wake } = prepared();
    const before = structuredClone(m.store);
    m.failCommit = true;
    assert.throws(() => m.retire(id, state, decision), /store failure/);
    assert.deepEqual(m.store, before);
    assert.equal(m.events.length, 1);
    assert.equal(m.retire(id, state, decision), true);
    assert.equal(m.list('ws').length, 0);
    assert.throws(() => m.get('ws', id), /InvalidParams/);
    assert.equal(Boolean(m.store.jobs[wake]), state !== 'cancelled');
    assert.equal(m.retire(id, state, decision), false);
    assert.equal(m.events.length, 2, 'duplicate callback cannot publish another event');
    assert.equal(m.events[1].monitor.state, state, 'full transient lifecycle snapshot survives');
    assert.equal(m.restart().list('ws').length, 0);
  });
}

test('known active detail is scoped and previews never replace configuration', () => {
  const { m, id } = prepared();
  m.store.active[id].outputPattern = 'full-pattern';
  assert.equal(m.get('ws', id, 'agent').outputPattern, 'full-pattern');
  assert.throws(() => m.get('foreign', id), /InvalidParams/);
  assert.throws(() => m.get('ws', id, 'other-owner'), /InvalidParams/);
});

test('active retry is stable; finished registration refuses and creates no history/wake', () => {
  const { m, id } = prepared();
  assert.equal(m.register({ ttlMs: 2000 }).monitor.expiresAt, 1000);
  assert.throws(() => m.register({ ttlMs: 0 }), /InvalidParams/);
  m.store.runs.script.final = true;
  m.retire(id, 'completed', decision);
  assert.deepEqual(m.register(), { ok: false, refused: true, reason: 'run-finished', scriptId: 'script', runId: 'run-a' });
  assert.equal(Object.keys(m.store.jobs).length, 1);
  assert.throws(() => m.register({ runId: 'stale' }), /InvalidParams/);
});

test('triggered live run can be explicitly monitored afresh, without a terminal retry cache', () => {
  const { m, id } = prepared();
  m.retire(id, 'triggered', { settledAt: 1, reason: 'line-count', trigger: { observedLineCount: 1 } });
  assert.notEqual(m.register({ now: 2 }).monitor.monitorId, id);
});

test('cancel reservation wins over output/expiry; failed stop restores observation', () => {
  const { m, id } = prepared();
  m.reserveCancel(id);
  assert.equal(m.retire(id, 'triggered', decision), false);
  assert.equal(m.restart().retire(id, 'expired', decision), false);
  m.stopFailed(id);
  assert.equal(m.retire(id, 'triggered', decision), true);
});

for (const crashAt of ['retired', 'queued', 'message', 'transferred', 'admitted']) {
  test(`restart after ${crashAt} delivers one message and one durable turn identity`, () => {
    let { m, id, wake } = prepared();
    m.retire(id, 'completed', decision);
    if (crashAt !== 'retired') m.enqueue(wake);
    if (['message', 'transferred', 'admitted'].includes(crashAt)) m.persistMessage(wake);
    if (['transferred', 'admitted'].includes(crashAt)) m.transfer(wake);
    if (crashAt === 'admitted') m.admit(wake);
    m = m.restart();
    m.enqueue(wake); m.persistMessage(wake); m.transfer(wake);
    assert.equal(m.admit(wake), wake);
    assert.equal(m.admit(wake), wake, 'repeated worker guards accept only the same durable admission');
    assert.equal(Object.keys(m.store.messages).length, 1);
    assert.equal(Object.keys(m.store.jobs).length, 0);
    assert.equal(m.events.length, 0, 'delivery recovery does not re-emit terminal events');
    m.finish(wake);
    assert.equal(m.enqueue(wake), false, 'stale queue cannot replay after completion');
    assert.equal(m.admit(wake), false);
    assert.equal(Object.keys(m.store.admissions).length, 0);
  });
}

test('message append alone never strands admission, and failed transfer is atomic', () => {
  const { m, id, wake } = prepared();
  m.retire(id, 'completed', decision); m.enqueue(wake); m.persistMessage(wake);
  assert.ok(m.store.jobs[wake]);
  m.failCommit = true;
  assert.throws(() => m.transfer(wake), /store failure/);
  assert.ok(m.store.jobs[wake]); assert.equal(m.store.admissions[wake], undefined);
  assert.equal(m.restart().transfer(wake), true);
});

for (const scope of ['agent', 'ws']) {
  test(`lifecycle suppression for ${scope} fences pending/transferred jobs and restore`, () => {
    for (const transferred of [false, true]) {
      const { m, id, wake } = prepared();
      m.retire(id, 'completed', decision); m.enqueue(wake); m.persistMessage(wake);
      if (transferred) m.transfer(wake);
      m.suppress(scope); m.restore(scope);
      assert.equal(m.enqueue(wake), false);
      assert.equal(m.admit(wake), false);
      assert.equal(Object.keys(m.store.jobs).length, 0);
      assert.equal(Object.keys(m.store.queue).length, 0);
      assert.equal(Object.keys(m.store.messages).length, 1, 'ordinary transcript survives');
    }
  });
}

test('migration transfers obligations, drops history and is idempotent/rollback-safe', () => {
  const m = new ActiveMonitors();
  const row = { monitorId: 'old', workspaceId: 'ws', agentId: 'agent', scriptId: 'script', runId: 'run-a', scriptName: 'script', mode: 'command', state: 'completed', ...decision };
  const { settledAt, reason, result, ...active } = row;
  const legacy = [
    { row: { ...active, monitorId: 'active', state: 'active', cancelIntent: true }, wakeState: 'none' },
    { row: { ...row, monitorId: 'pending' }, wakeState: 'pending' },
    { row: { ...row, monitorId: 'delivered' }, wakeState: 'delivered' },
    { row: { ...row, monitorId: 'queued' }, wakeState: 'delivered' },
    { row: { ...row, monitorId: 'suppressed' }, wakeState: 'suppressed' },
  ];
  m.store.messages['script-monitor:queued'] = { pruned: true };
  m.store.queue['script-monitor:queued'] = { workspaceId: 'ws', agentId: 'agent' };
  const before = structuredClone(m.store);
  m.failCommit = true;
  assert.throws(() => m.migrate(legacy), /store failure/);
  assert.deepEqual(m.store, before);
  m.migrate(legacy);
  const after = structuredClone(m.store);
  m.migrate(legacy);
  assert.deepEqual(m.store, after);
  assert.deepEqual(Object.keys(m.store.active), ['active']);
  assert.equal(m.store.active.active.cancelIntent, true);
  assert.deepEqual(Object.keys(m.store.jobs), ['script-monitor:pending', 'script-monitor:queued']);
  assert.equal(m.store.jobs['script-monitor:queued'].phase, 'message-persisted');
  assert.equal(m.store.jobs['script-monitor:pending'].row_json, undefined);
  assert.equal(m.events.length, 0);
});

test('outstanding jobs reserve capacity without evicting old undelivered notifications', () => {
  const { m, id, wake } = prepared();
  for (let i = 0; i < 999; i++) m.store.jobs[`old-${i}`] = { workspaceId: 'ws' };
  m.retire(id, 'completed', decision);
  assert.equal(Object.keys(m.store.jobs).length, 1000);
  assert.equal(m.register().reason, 'capacity');
  assert.ok(m.store.jobs[wake]);
  assert.equal(Object.keys(m.restart().store.jobs).length, 1000);
});


test('legacy delivered message without a queue is preserved without inventing a new wake', () => {
  const m = new ActiveMonitors();
  const row = { monitorId: 'old', workspaceId: 'ws', agentId: 'agent', scriptId: 'script', runId: 'run-a', state: 'completed', ...decision };
  m.store.messages['script-monitor:old'] = { id: 'script-monitor:old' };
  m.migrate([{ row, wakeState: 'delivered' }]);
  assert.equal(Object.keys(m.store.jobs).length, 0);
  assert.equal(m.enqueue('script-monitor:old'), false);
  assert.ok(m.store.messages['script-monitor:old']);
});

test('migration silently removes ineligible pending jobs, including their stale queue entries', () => {
  const m = new ActiveMonitors();
  m.store.blocked.push('agent');
  const row = { monitorId: 'old', workspaceId: 'ws', agentId: 'agent', scriptId: 'script', runId: 'run-a', state: 'triggered', settledAt: 2, reason: 'line-count' };
  m.store.queue['script-monitor:old'] = { agentId: 'agent', workspaceId: 'ws' };
  m.migrate([{ row, wakeState: 'pending' }]);
  assert.equal(Object.keys(m.store.jobs).length, 0);
  assert.equal(Object.keys(m.store.queue).length, 0);
  m.restore('agent');
  assert.equal(m.enqueue('script-monitor:old'), false);
});

test('quick exit refuses the accepted run; a successor cannot be silently monitored by its old ID', () => {
  const m = new ActiveMonitors();
  m.store.runs.script = { runId: 'quick-run', final: true };
  const refused = m.register({ runId: 'quick-run' });
  assert.equal(refused.reason, 'run-finished');
  assert.equal(refused.runId, 'quick-run');
  assert.equal(m.list('ws').length, 0);
  assert.equal(Object.keys(m.store.jobs).length, 0);
  m.store.runs.script = { runId: 'successor', final: false };
  assert.throws(() => m.register({ runId: refused.runId }), /InvalidParams/);
  assert.equal(m.list('ws').length, 0);
});

test('quick-exit component scenarios pin refusal handling and run-scoped output attribution', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./compact.json', import.meta.url), 'utf8'));
  for (const id of ['quick-exit-no-wait', 'quick-exit-successor-before-output', 'quick-exit-successor-during-output', 'quick-exit-no-run-identity'])
    assert.ok(fixture.componentScenarios.some(row => row.id === id), id);
  const doc = await readFile(new URL('../../methods/script-monitors.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('must inspect the registration result before ending a turn'));
  assert.ok(doc.includes('isolated test databases'));
  assert.ok(doc.includes('SCRIPT_RUN_MONITOR_RECIPE'));
});

for (const [before, after, calls] of [['run-a', 'run-a', 3], ['run-b', 'run-b', 1], ['run-a', 'run-b', 3], [undefined, undefined, 1]]) {
  test(`finished output attribution: ${before} before / ${after} after`, async () => {
    const { readFinishedOutput } = await import('./active-monitors-model.mjs');
    const seen = [], readings = [before, after];
    const result = await readFinishedOutput({ reason: 'run-finished', scriptId: 'script', runId: 'run-a' }, {
      status: async id => { seen.push(['status', id]); return { runId: readings.shift() }; },
      output: async id => { seen.push(['output', id]); return ''; },
    });
    assert.equal(seen.length, calls);
    assert.deepEqual(result, before === after && before === 'run-a' ? { kind: 'available', output: '' } : { kind: 'unavailable' });
  });
}
