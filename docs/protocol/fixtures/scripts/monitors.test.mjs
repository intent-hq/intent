import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { model, DAY, RETENTION, RETAINED_LIMIT, iso } from './monitor-model.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const fixture = JSON.parse(await read('./monitors.json'));
const doc = await read('../../methods/script-monitors.md');
const events = JSON.parse(await read('../../event-types.json'));
const catalog = await read('../../05-method-catalog.md');
const register = { op: 'register', ttlMs: 1000 };
const start = { op: 'start', runId: 'run-a' };
const finish = { op: 'finish', runId: 'run-a', result: { outcome: 'succeeded', exitCode: 0, stoppedAt: iso(0) } };
const ready = () => { const m = model(); m.step(start); m.step(register); return m; };

function assertCompact(value) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.equal(['output', 'stdout', 'stderr', 'command', 'env', 'cwd', 'scrollback'].includes(k), false, k);
      assert.notEqual(v, null, k);
      assertCompact(v);
    }
  }
}
function assertRow(row) {
  for (const key of ['monitorId', 'workspaceId', 'agentId', 'scriptId', 'runId', 'scriptName']) assert.equal(typeof row[key], 'string');
  assert.ok(['command', 'service'].includes(row.mode));
  assert.ok(['active', 'completed', 'expired', 'cancelled'].includes(row.state));
  assert.ok(Date.parse(row.expiresAt) > Date.parse(row.createdAt));
  assert.equal(row.settledAt !== undefined, row.state !== 'active');
  assert.equal(row.reason !== undefined, row.state !== 'active');
  assert.equal(row.result !== undefined, row.state === 'completed');
  if (row.result) {
    const r = row.result;
    assert.ok(['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.outcome));
    assert.ok(Number.isFinite(Date.parse(r.stoppedAt)));
    if (r.outcome === 'succeeded') { assert.equal(r.exitCode, 0); assert.equal(r.error, undefined); }
    if (r.exitCode === -1) assert.ok(r.error);
  }
  assertCompact(row);
}

test('prepared methods, capability and event inventory match canonical documents', () => {
  assert.equal(fixture.status, 'prepared-not-executed');
  assert.deepEqual(fixture.capability, { scriptMonitors: 1 });
  for (const method of ['list', 'cancel', 'cancelRun']) assert.ok(doc.includes(`| scriptMonitor.${method} |`));
  assert.match(catalog, /\| scriptMonitor \| 3 \| cancel, cancelRun, list/);
  for (const state of ['registered', 'completed', 'expired', 'cancelled']) {
    assert.ok(events.types.includes(`scriptMonitor:${state}`));
    assert.ok(doc.includes(`scriptMonitor:${state}`));
  }
  assert.ok(doc.includes('[1, 86400000]'));
  assert.ok(doc.includes('1000 total retained monitor'));
  assert.equal(new Set(fixture.cases.map(c => c.id)).size, fixture.cases.length);
});

for (const c of fixture.cases) test(`contract trace: ${c.id}`, () => {
  const m = model();
  for (const a of c.steps) {
    m.step(a);
    const slots = m.s.monitors.filter(x => x.state === 'active').map(x => JSON.stringify([x.workspaceId, x.scriptId]));
    assert.equal(new Set(slots).size, slots.length, 'one active owner per script/workspace');
    for (const row of m.s.monitors) assertRow(row);
  }
  assert.deepEqual(m.s.monitors.map(x => x.state), c.expect.states);
  assert.deepEqual([...m.s.delivered.values()].map(x => x.reason), c.expect.wakes);
  assert.deepEqual(m.s.stops, c.expect.stops);
  const terminalEvents = m.s.events.filter(e => e.type !== 'scriptMonitor:registered');
  assert.equal(new Set(terminalEvents.map(e => e.data.monitor.monitorId)).size, terminalEvents.length);
  assert.equal(m.waiting().length, c.expect.states.filter(x => x === 'active').length);
  for (const payload of m.s.delivered.values()) {
    assertCompact(payload);
    assert.equal(payload.type, 'script_monitor_wake');
    assert.equal(payload.source, 'system');
    assert.equal(payload.result !== undefined, payload.reason === 'finished');
    const row = m.s.monitors.find(x => x.monitorId === payload.monitorId);
    assert.equal(payload.runId, row.runId);
    assert.equal(payload.agentId, row.agentId);
  }
});

test('TTL boundaries reject invalid values before even retrying an existing watch', () => {
  for (const ttlMs of [undefined, null, 0, -1, 1.5, '1000', false, Infinity, DAY + 1]) {
    const m = ready();
    const before = structuredClone(m.s.monitors);
    assert.equal(m.step({ op: 'register', ttlMs }).errorCode, -32602, String(ttlMs));
    assert.deepEqual(m.s.monitors, before);
  }
  for (const ttlMs of [1, DAY]) {
    const m = model(); m.step(start);
    assert.equal(m.step({ op: 'register', ttlMs }).ok, true);
    assert.equal(m.s.monitors[0].expiresAt, iso(ttlMs));
  }
});

test('same-owner retries preserve deadline, owner, token and event count', () => {
  const m = ready(), initial = structuredClone(m.s.monitors[0]);
  m.step({ op: 'time', now: 500 });
  assert.deepEqual(m.step({ op: 'register', ttlMs: DAY }).monitor, initial);
  assert.equal(m.s.events.length, 1);
  assert.equal(m.step({ ...register, runId: 'run-b' }).errorCode, -32602);
  const refused = m.step({ ...register, agentId: 'agent-b' });
  assert.equal(refused.refused, true);
  assert.equal(refused.ownerAgentId, 'agent-a');
  assert.equal(refused.monitorId, initial.monitorId);
  assert.equal(refused.runId, initial.runId);
  assert.equal(m.step({ op: 'cancel', asAgent: true, agentId: 'agent-b' }).errorCode, -32602);
});

test('no-run and wrong-run registrations never allocate watches; explicit token avoids successor binding', () => {
  const m = model();
  assert.equal(m.step(register).errorCode, -32602);
  m.step(start); m.step({ op: 'restart', runId: 'run-b' });
  assert.equal(m.step({ ...register, runId: 'run-a' }).errorCode, -32602);
  assert.equal(m.step(register).monitor.runId, 'run-b');
});

function permutations(items) {
  return items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map(rest => [item, ...rest])) : [[]];
}
test('every ordering of completion, expiry and cancellation yields one terminal event/wake', () => {
  for (const order of permutations([finish, { op: 'expire' }, { op: 'cancelRun' }])) {
    const m = ready(); m.step({ op: 'time', now: 1000 });
    for (const action of [...order, ...order]) m.step(action);
    m.step({ op: 'recover' }); m.step({ op: 'deliver' }); m.step({ op: 'deliver' });
    assert.equal(m.s.delivered.size, 1);
    assert.equal(m.s.events.length, 2);
    assert.ok(m.s.stops.length <= 1);
  }
});

test('all compact outcome shapes preserve failure and omitted cancellation code', () => {
  for (const result of [
    finish.result,
    { outcome: 'failed', exitCode: 2, stoppedAt: iso(1) },
    { outcome: 'failed', exitCode: -1, error: 'spawn failed', stoppedAt: iso(1) },
    { outcome: 'cancelled', error: 'cancelled before spawn', stoppedAt: iso(1) },
    { outcome: 'interrupted', exitCode: -1, error: 'daemon stopped', stoppedAt: iso(1) },
  ]) {
    const m = ready(); m.step({ ...finish, result }); m.step({ op: 'deliver' });
    assertRow(m.s.monitors[0]);
    assert.deepEqual([...m.s.delivered.values()][0].result, result);
  }
});

test('cleanup prevents registration and purges completed pending wakes without changing delivered history', () => {
  const m = ready(); m.step(finish); m.step({ op: 'deliver' });
  m.step({ op: 'cleanup', reason: 'owner-retired' });
  assert.equal(m.step(register).errorCode, -32602);
  m.step({ op: 'restore' }); m.step({ op: 'recover' }); m.step({ op: 'deliver' });
  assert.equal(m.s.delivered.size, 1);
  assert.equal(m.waiting().length, 0);
});

test('retention expires eligible metadata but never an undelivered wake', () => {
  for (const deliver of [false, true]) {
    const m = ready(); m.step(finish);
    if (deliver) m.step({ op: 'deliver' });
    m.step({ op: 'time', now: RETENTION }); m.step({ op: 'prune' });
    assert.equal(m.s.monitors.length, deliver ? 0 : 1);
    assert.equal(m.s.pending.size, deliver ? 0 : 1);
    if (deliver) assert.equal(m.step({ op: 'cancelRun' }).errorCode, -32602);
  }
});

test('active limit and retained backlog cap refuse new work without evicting promises', () => {
  const m = model();
  for (let i = 0; i < 6; i++) {
    m.step({ ...start, scriptId: `s${i}` });
    const result = m.step({ ...register, scriptId: `s${i}` });
    assert.equal(result.ok === true, i < 5);
  }
  assert.equal(m.step({ ...register, scriptId: 's0' }).ok, true, 'retry at active cap');
  const n = model();
  for (let i = 0; i < RETAINED_LIMIT; i++) {
    n.step({ ...start, runId: `run-${i}` }); n.step(register);
    n.step({ ...finish, runId: `run-${i}` });
  }
  n.step({ ...start, runId: 'next' });
  assert.equal(n.step(register).errorCode, -32602);
  assert.equal(n.s.pending.size, RETAINED_LIMIT);
  n.step({ op: 'deliver' });
  assert.equal(n.step(register).ok, true);
  assert.equal(n.s.monitors.length, RETAINED_LIMIT);
});

test('cross-workspace monitor IDs cannot stop a local run', () => {
  const m = ready();
  assert.equal(m.step({ op: 'cancelRun', workspaceId: 'ws-b' }).errorCode, -32602);
  assert.deepEqual(m.s.stops, []);
});

test('cleanup racing any terminal operation suppresses queued wakes before restore', () => {
  for (const order of permutations([finish, { op: 'expire' }, { op: 'cleanup', reason: 'workspace-archived' }])) {
    const m = ready(); m.step({ op: 'time', now: 1000 });
    for (const action of order) m.step(action);
    m.step({ op: 'restore' }); m.step({ op: 'recover' }); m.step({ op: 'deliver' });
    assert.equal(m.s.delivered.size, 0);
    assert.equal(m.s.pending.size, 0);
    assert.equal(m.waiting().length, 0);
    assert.equal(m.s.events.length, 2);
  }
});

test('recovery applies durable lifecycle fences even if pre-crash cleanup never ran', () => {
  for (const queued of [false, true]) {
    const m = ready(); if (queued) m.step(finish);
    // Fault injection: lifecycle persist succeeded, sweep died before running.
    m.s.blocked.add('agent-a');
    m.step({ op: 'recover' }); m.step({ op: 'restore' }); m.step({ op: 'deliver' });
    assert.equal(m.s.delivered.size, 0);
    assert.equal(m.s.pending.size, 0);
    assert.equal(m.waiting().length, 0);
  }
});

test('stale active binding with lost predecessor metadata cannot signal a successor', () => {
  const m = ready();
  // Fault injection: successor visible without predecessor result reconciliation.
  m.s.runs.set(JSON.stringify(['ws-a', 'check']), { workspaceId: 'ws-a', scriptId: 'check', mode: 'command', runId: 'run-b' });
  const response = m.step({ op: 'cancelRun' });
  assert.equal(response.runStopped, false);
  assert.equal(response.monitor.runId, 'run-a');
  assert.equal(response.monitor.result.outcome, 'interrupted');
  assert.deepEqual(m.s.stops, []);
});

test('omission and compact schema assertions detect forbidden outputs and invented success', () => {
  const m = ready(); m.step(finish);
  const good = m.s.monitors[0];
  assert.throws(() => assertRow({ ...good, output: 'secret output' }));
  assert.throws(() => assertRow({ ...good, result: { ...good.result, error: null } }));
  assert.throws(() => assertRow({ ...good, result: { ...good.result, exitCode: 2 } }));
  assert.throws(() => assertRow({ ...good, state: 'expired' }));
});
