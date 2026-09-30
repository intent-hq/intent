import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerProjection, WorkerClient, WorkerSubscriptions, routeToolUpdate, FRESHNESS_MS, runGoldens, readGoldens } from './agent-worker-contract.mjs';

const scope = { workspaceId: 'ws-A', agentId: 'agent-A', provider: 'codex', acpSessionId: 'session-A', connectionGeneration: 'generation-A' };
const configured = (options = {}) => new WorkerProjection(scope, { adapterVersion: '1.13.1', negotiated: true, ...options });
const spawn = (id = 'worker-A') => ({ sessionId: scope.acpSessionId, update: { sessionUpdate: 'async_task_spawned', asyncTaskId: id, taskType: 'shell', name: 'synthetic command', toolCallId: 'call-A', canStop: true, showInTranscript: false } });
const terminal = (state, id = 'worker-A') => ({ sessionId: scope.acpSessionId, update: { sessionUpdate: 'async_task_state_update', asyncTaskId: id, state, toolCallId: 'call-A' } });
const ingest = (p, frame, at = 1000, extra = {}) => p.ingest(frame, { ...scope, receivedAt: at, origin: 'live', ...extra });
const row = (p, at = 1000) => p.list(scope, at).workers[0];
const marker = { sessionUpdate: 'tool_call_update', toolCallId: 'call-A', _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } };

test('synthetic golden scenarios match reviewed wire observations', () => runGoldens());
test('running means last provider observation and expires at the exact boundary', () => {
  const p = configured(); ingest(p, spawn());
  assert.equal(row(p, 1000 + FRESHNESS_MS - 1).status, 'running');
  assert.equal(row(p, 1000 + FRESHNESS_MS).status, 'unknown');
  assert.equal(row(p, 1000 + FRESHNESS_MS).unknownReason, 'stale');
  assert.equal(row(p, 1000 + FRESHNESS_MS).providerState, 'running');
  assert.deepEqual(row(p).exitEvidence, { kind: 'unknown' });
});
test('duplicates, refetch, same-generation reconnect and restored projection cannot refresh evidence', () => {
  const p = configured(); ingest(p, spawn());
  ingest(p, spawn(), 70000);
  p.disconnect(); p.reconnect();
  assert.equal(row(p, 70000).observedAt, 1000);
  assert.equal(row(p, 70000).status, 'unknown');
  const restored = WorkerProjection.restore(p.checkpoint());
  ingest(restored, spawn(), 80000);
  assert.deepEqual(restored.list(scope, 80000), p.list(scope, 80000));
  assert.equal(row(restored, 80000).status, 'unknown');
});
test('evicted identity remains fenced; saturated ledger refuses new IDs without unbounded growth', () => {
  const p = configured({ maxRows: 1, maxSeen: 2 });
  ingest(p, spawn('first')); ingest(p, spawn('second'), 2000);
  ingest(p, spawn('first'), 70000); ingest(p, terminal('completed', 'first'), 71000);
  ingest(p, spawn('third'), 72000);
  assert.equal(row(p, 72000).identity.asyncTaskId, 'second');
  assert.equal(row(p, 72000).observedAt, 2000);
  assert.equal(p.list(scope, 72000).truncated, true);
  assert.equal(p.checkpoint().seen.length, 2);
  assert.equal(p.checkpoint().rows.length, 1);
});
test('first terminal state wins even before spawn; conflicting and late frames cannot rewrite history', () => {
  const p = configured(); ingest(p, terminal('failed'));
  ingest(p, spawn(), 2000); ingest(p, terminal('completed'), 3000);
  assert.equal(row(p, 90000).providerState, 'failed');
  assert.equal(row(p, 90000).observedAt, 1000);
  assert.equal(row(p, 90000).status, 'failed');
  assert.equal(row(p).cause, 'unavailable');
});
test('item failure and synthetic provider failure are intentionally indistinguishable', () => {
  for (const state of ['completed', 'failed', 'stopped']) {
    const p = configured(); ingest(p, spawn()); ingest(p, terminal(state), 2000);
    assert.equal(row(p, 2000).providerState, state);
    assert.deepEqual(row(p, 2000).exitEvidence, { kind: 'unknown' });
    assert.equal(row(p, 2000).cause, 'unavailable');
    assert.equal(row(p, 2000).identity.connectionGeneration, scope.connectionGeneration);
  }
});
test('cancellation, stop acknowledgement, tool completion, terminal metadata and reconciliation are not worker evidence', () => {
  const p = configured(); ingest(p, spawn());
  for (const sessionUpdate of ['parent_cancelled', 'stop_acknowledged', 'terminal_exit', 'reconcile_success', 'reconcile_failed', 'tool_call_update', 'app_server_replaced']) {
    ingest(p, { sessionId: scope.acpSessionId, update: { sessionUpdate, asyncTaskId: 'worker-A', status: 'completed', exitCode: 0 } }, 70000);
  }
  assert.equal(row(p, 70000).status, 'unknown');
  assert.equal(row(p, 70000).observedAt, 1000);
});
test('ingress ownership fences workspace, agent, provider, session and generation; wire IDs confer no authority', () => {
  for (const field of Object.keys(scope)) {
    const p = configured();
    assert.equal(ingest(p, spawn(), 1000, { [field]: 'foreign' }), false, field);
    assert.equal(p.list(scope, 1000).workers.length, 0);
  }
  const p = configured();
  assert.equal(ingest(p, { ...spawn(), sessionId: 'child-session' }), false);
  for (const field of ['workspaceId', 'agentId']) assert.throws(() => p.list({ ...scope, [field]: 'foreign' }, 1000), /not-found/);
  assert.throws(() => p.list(scope, 1000, { canRead: false }), /not-found/);
});
test('unsupported providers, adapter versions and absent negotiation cannot materialize workers', () => {
  for (const [s, o] of [[{ ...scope, provider: 'claude' }, {}], [scope, { adapterVersion: '1.13.2' }], [scope, { negotiated: false }]]) {
    const p = new WorkerProjection(s, { adapterVersion: '1.13.1', negotiated: true, ...o });
    assert.equal(ingest(p, spawn()), false);
    assert.equal(p.list(s, 1000).support.status, 'unsupported');
    assert.deepEqual(p.list(s, 1000).workers, []);
  }
});
test('historical frames cannot create rows; lost reducer continuity cannot silently rebuild the same generation', () => {
  const p = configured(); assert.equal(ingest(p, spawn(), 1000, { origin: 'replay' }), false);
  ingest(p, spawn()); p.loseContinuity();
  ingest(p, spawn('new'), 2000);
  assert.equal(p.list(scope, 2000).support.status, 'unavailable');
  assert.equal(row(p, 2000).status, 'unknown');
  assert.equal(p.list(scope, 2000).workers.length, 1);
});
test('actual outer generation replacement clears old rows, and old frames cannot enter its ledger', () => {
  const p = configured(); ingest(p, spawn());
  const nextScope = { ...scope, connectionGeneration: 'generation-B' };
  const next = new WorkerProjection(nextScope, { adapterVersion: '1.13.1', negotiated: true });
  assert.equal(ingest(next, spawn()), false);
  assert.equal(next.list(nextScope, 2000).workers.length, 0);
  assert.equal(ingest(next, spawn(), 2000, { connectionGeneration: 'generation-B' }), true);
  assert.equal(row(next, 2000).observedAt, 2000);
});
test('malformed frames and identity bounds reject atomically; optional titles never authorize file reads', () => {
  for (const update of [{ ...spawn().update, asyncTaskId: '' }, { ...spawn().update, asyncTaskId: 'x'.repeat(257) }, { ...spawn().update, taskType: 'agent' }, { ...terminal('running').update }, { ...terminal('paused').update }, { ...spawn().update, toolCallId: 4 }]) {
    const p = configured(); assert.equal(ingest(p, { sessionId: scope.acpSessionId, update }), false);
    assert.equal(p.checkpoint().seen.length, 0);
  }
  const p = configured(); ingest(p, { ...spawn(), update: { ...spawn().update, name: 'é'.repeat(300), outputFilePath: '/private/path' } });
  assert.ok(Buffer.byteLength(row(p).name) <= 512);
  assert.equal('outputFilePath' in row(p), false);
});
test('backward time cannot make a stale observation fresh', () => {
  const p = configured(); ingest(p, spawn()); p.list(scope, 70000);
  assert.equal(row(p, 2000).status, 'unknown');
});
test('metadata-only markers cannot change completed/error tools, materialize tools or open turns', () => {
  for (const status of ['completed', 'failed']) {
    const tools = { 'call-A': { status, rawOutput: { retained: true } } };
    const before = structuredClone(tools);
    for (let i = 0; i < 2; i++) assert.equal(routeToolUpdate(tools, marker).ordinary, false);
    assert.deepEqual(tools, before);
    const p = configured(); ingest(p, { sessionId: scope.acpSessionId, update: marker }); ingest(p, spawn());
    assert.deepEqual(tools, before);
  }
  const tools = {};
  assert.deepEqual(routeToolUpdate(tools, marker), { ordinary: false, backgrounded: true });
  assert.deepEqual(tools, {});
});
test('mixed marker preserves genuine fields and uses only explicit tool status', () => {
  const tools = { 'call-A': { status: 'completed', rawOutput: 'old' } };
  const update = { ...marker, rawOutput: { real: true }, title: 'new', content: [{ type: 'text', text: 'genuine output' }] };
  assert.equal(routeToolUpdate(tools, update).ordinary, true);
  assert.deepEqual(tools['call-A'], { status: 'completed', rawOutput: { real: true }, title: 'new', content: update.content });
  routeToolUpdate(tools, { ...marker, status: 'failed' }); assert.equal(tools['call-A'].status, 'failed');
});
test('subscription snapshots fence old subscriptions and ordering while retaining original evidence age', () => {
  const p = configured(); ingest(p, spawn());
  const client = new WorkerClient(scope); client.subscribe('sub-1');
  assert.equal(client.push(p.push('sub-1', 0, 1000)), true);
  assert.equal(client.view(61000).workers[0].status, 'unknown');
  assert.equal(client.push(p.push('sub-1', 2, 62000)), true); // full snapshot: skipped seq is safe
  assert.equal(client.push(p.push('sub-1', 1, 2000)), false);
  client.disconnect(); client.subscribe('sub-2');
  assert.equal(client.push(p.push('sub-1', 3, 63000)), false);
  assert.equal(client.push(p.push('sub-2', 0, 64000)), true);
  assert.equal(client.view(64000).workers[0].status, 'unknown');
  assert.equal(client.view(64000).workers[0].observedAt, 1000);
  const bad = p.push('sub-2', 1, 64000); bad.params.snapshot.workspaceId = 'foreign';
  assert.equal(client.push(bad), false);
});
test('no-session fallback is explicitly unavailable and owns no worker observations', () => {
  const s = { ...scope, acpSessionId: null, connectionGeneration: null };
  const p = new WorkerProjection(s);
  assert.deepEqual(p.list(s, 0).support, { status: 'unavailable', reason: 'no-session' });
  assert.deepEqual(p.list(s, 0).workers, []);
  assert.equal(p.list(s, 0).continuity, 'lost');
});
test('invalid request IDs and overflowing timestamps fail before state allocation', () => {
  const p = configured();
  assert.throws(() => p.list({ agentId: scope.agentId }, 0), /invalid-params/);
  for (const at of [-1, 0.1, NaN, Number.MAX_SAFE_INTEGER]) assert.equal(ingest(p, spawn(), at), false);
  assert.equal(p.checkpoint().seen.length, 0);
});
test('absent tool correlation stays absent; ownership is checked inside every client row', () => {
  const p = configured(); const f = spawn(); delete f.update.toolCallId; ingest(p, f);
  assert.equal('toolCallId' in row(p), false);
  const c = new WorkerClient(scope); c.subscribe('sub');
  const msg = p.push('sub', 0, 1000); msg.params.snapshot.workers[0].identity.acpSessionId = 'foreign';
  assert.equal(c.push(msg), false);
});
test('client disconnect demotes immediately, and same-generation refetch preserves the deadline', () => {
  const p = configured(); ingest(p, spawn()); const c = new WorkerClient(scope); c.subscribe('one');
  c.push(p.push('one', 0, 1000)); c.disconnect();
  assert.equal(c.view(1001).workers[0].unknownReason, 'disconnected');
  c.subscribe('two'); c.push(p.push('two', 0, 2000));
  assert.equal(c.view(2000).workers[0].status, 'running');
  assert.equal(c.view(61000).workers[0].status, 'unknown');
  assert.equal(c.view(61000).workers[0].observedAt, 1000);
});
test('evicted IDs cannot reappear while the seen ledger still has spare capacity', () => {
  const p = configured({ maxRows: 1, maxSeen: 3 });
  ingest(p, spawn('first')); ingest(p, spawn('second'), 2000);
  ingest(p, spawn('first'), 70000);
  assert.equal(row(p, 70000).identity.asyncTaskId, 'second');
  assert.equal(row(p, 70000).observedAt, 2000);
  assert.equal(row(p, 70000).status, 'unknown');
});
test('queued observations retain ingress time rather than read/projection time', () => {
  const p = configured(); ingest(p, spawn()); p.list(scope, 70000);
  ingest(p, terminal('completed'), 2000);
  assert.equal(row(p, 71000).observedAt, 2000);
  assert.equal(row(p, 71000).firstObservedAt, 1000);
  const late = configured(); ingest(late, spawn(), 2000);
  assert.equal(ingest(late, terminal('failed'), 1000), false);
  assert.equal(row(late, 2000).providerState, 'running');
});
test('outer disconnect cannot accept queued frames as new live observations', () => {
  const p = configured(); ingest(p, spawn()); p.disconnect();
  assert.equal(ingest(p, terminal('completed'), 2000), false);
  assert.equal(row(p, 2000).unknownReason, 'disconnected');
  p.reconnect();
  assert.deepEqual(p.list(scope, 2000).support, { status: 'unavailable', reason: 'continuity-lost' });
});
test('subscription admission checks ownership before ack; teardown belongs to connection and workspace', () => {
  const p = configured(); ingest(p, spawn()); const subs = new WorkerSubscriptions();
  assert.throws(() => subs.subscribe('client-A', p, { ...scope, workspaceId: 'foreign' }, 1000), /not-found/);
  assert.equal(subs.connections.size, 0);
  const { ack, initial } = subs.subscribe('client-A', p, scope, 1000);
  assert.deepEqual(initial, p.push(ack.subscriptionId, 0, 1000));
  assert.deepEqual(subs.unsubscribe('client-B', ack.subscriptionId, scope.workspaceId), { success: false });
  assert.deepEqual(subs.unsubscribe('client-A', ack.subscriptionId, 'foreign'), { success: false });
  assert.deepEqual(subs.unsubscribe('client-A', ack.subscriptionId, scope.workspaceId), { success: true });
  assert.deepEqual(subs.unsubscribe('client-A', ack.subscriptionId, scope.workspaceId), { success: false });
});
test('subscription capacity is per connection, atomic and released by disconnect', () => {
  const p = configured(); const subs = new WorkerSubscriptions();
  for (let i = 0; i < 8; i++) subs.subscribe('A', p, scope, 1000);
  assert.throws(() => subs.subscribe('A', p, scope, 1000), /capacity/);
  assert.equal(subs.connections.get('A').size, 8);
  assert.throws(() => subs.subscribe('A', p, { ...scope, agentId: 'foreign' }, 1000), /not-found/);
  assert.doesNotThrow(() => subs.subscribe('B', p, scope, 1000));
  subs.disconnect('A'); assert.doesNotThrow(() => subs.subscribe('A', p, scope, 1000));
});
test('golden checks reject refreshed timestamps, fabricated exit evidence and missing coverage', () => {
  for (const mutate of [
    (c) => { c.scenarios[0].expected[2].workers[0].observedAt = 62000; },
    (c) => { c.scenarios[1].expected[0].workers[0].exitEvidence = { kind: 'observed', exitCode: 1 }; },
    (c) => { c.scenarios.pop(); },
    (c) => { c.provenance = 'recorded-live-provider'; },
  ]) {
    const corpus = readGoldens(); mutate(corpus); assert.throws(() => runGoldens(corpus), assert.AssertionError);
  }
});
test('request fields cannot override trusted read authority', () => {
  const p = configured(); const subs = new WorkerSubscriptions();
  const request = { ...scope, authorized: true, canRead: true };
  assert.throws(() => p.list(request, 1000, { canRead: false }), /not-found/);
  assert.throws(() => subs.subscribe('A', p, request, 1000, { canRead: false }), /not-found/);
  assert.equal(subs.connections.size, 0);
});
test('recreated projection requires the complete same-generation ledger, not a client snapshot', () => {
  const p = configured({ maxRows: 1, maxSeen: 3 });
  ingest(p, spawn('first')); ingest(p, spawn('second'), 2000);
  assert.throws(() => WorkerProjection.restore(p.list(scope, 70000)), /complete internal checkpoint/);
  const restored = WorkerProjection.restore(p.checkpoint());
  assert.equal(ingest(restored, spawn('first'), 71000), false);
  assert.equal(row(restored, 71000).identity.asyncTaskId, 'second');
  assert.equal(row(restored, 71000).observedAt, 2000);
  assert.equal(row(restored, 71000).status, 'unknown');
});
