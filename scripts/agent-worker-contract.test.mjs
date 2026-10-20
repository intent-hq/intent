import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerProjection, WorkerClient, WorkerSubscriptions, routeToolUpdate, runGoldens, readGoldens, STOP_METHOD } from './agent-worker-contract.mjs';

const scope = { workspaceId: 'ws-A', agentId: 'agent-A', provider: 'codex', acpSessionId: 'session-A', connectionGeneration: 'generation-A' };
const configured = (options = {}) => new WorkerProjection(scope, { adapterVersion: '2.2.2', negotiated: true, ...options });
const spawn = (id = 'worker-A') => ({ sessionId: scope.acpSessionId, update: { sessionUpdate: 'async_task_spawned', asyncTaskId: id, taskType: 'shell', name: 'synthetic command', toolCallId: 'call-A', canStop: true, showInTranscript: false } });
const terminal = (state, id = 'worker-A') => ({ sessionId: scope.acpSessionId, update: { sessionUpdate: 'async_task_state_update', asyncTaskId: id, state, toolCallId: 'call-A' } });
const ingest = (p, frame, at = 1000, extra = {}) => p.ingest(frame, { ...scope, receivedAt: at, origin: 'live', ...extra });
const row = (p, at = 1000) => p.list(scope, at).workers[0];
const marker = { sessionUpdate: 'tool_call_update', toolCallId: 'call-A', _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } } };

test('synthetic golden scenarios match reviewed wire observations', () => runGoldens());
test('running persists until the provider reports an end; evidence age never demotes a row', () => {
  const p = configured(); ingest(p, spawn());
  for (const at of [1000, 61000, 86_400_000]) {
    assert.equal(row(p, at).status, 'running');
    assert.equal('unknownReason' in row(p, at), false);
    assert.equal(row(p, at).observedAt, 1000);
  }
  assert.equal('freshUntil' in row(p), false);
  assert.equal('freshnessMs' in p.list(scope, 1000), false);
  assert.deepEqual(row(p).exitEvidence, { kind: 'unknown' });
  ingest(p, terminal('completed'), 86_400_001);
  assert.equal(row(p, 86_400_001).status, 'completed');
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
  assert.equal(row(p, 70000).status, 'running');
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
  for (const [s, o] of [[{ ...scope, provider: 'claude' }, {}], [{ ...scope, provider: 'auggie' }, {}], [{ ...scope, provider: 'constructor' }, {}],
    [scope, { adapterVersion: '1.13.1' }], [scope, { adapterVersion: '0.81.1' }], [{ ...scope, provider: 'claude-code' }, { adapterVersion: '2.2.2' }],
    [scope, { negotiated: false }], [{ ...scope, provider: 'claude-code' }, { adapterVersion: '0.81.1', negotiated: false }]]) {
    const p = new WorkerProjection(s, { adapterVersion: '2.2.2', negotiated: true, ...o });
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
  const next = new WorkerProjection(nextScope, { adapterVersion: '2.2.2', negotiated: true });
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
test('backward time cannot rewind the projection clock or observation time', () => {
  const p = configured(); ingest(p, spawn()); p.list(scope, 70000);
  assert.equal(p.list(scope, 2000).asOf, 70000);
  assert.equal(row(p, 2000).observedAt, 1000);
  assert.equal(row(p, 2000).status, 'running');
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
  assert.equal(client.view(61000).workers[0].status, 'running');
  assert.equal(client.push(p.push('sub-1', 2, 62000)), true); // full snapshot: skipped seq is safe
  assert.equal(client.push(p.push('sub-1', 1, 2000)), false);
  client.disconnect(); client.subscribe('sub-2');
  assert.equal(client.push(p.push('sub-1', 3, 63000)), false);
  assert.equal(client.push(p.push('sub-2', 0, 64000)), true);
  assert.equal(client.view(64000).workers[0].status, 'running');
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
  for (const at of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000']) assert.equal(ingest(p, spawn(), at), false);
  assert.equal(p.checkpoint().seen.length, 0);
});
test('absent tool correlation stays absent; ownership is checked inside every client row', () => {
  const p = configured(); const f = spawn(); delete f.update.toolCallId; ingest(p, f);
  assert.equal('toolCallId' in row(p), false);
  const c = new WorkerClient(scope); c.subscribe('sub');
  const msg = p.push('sub', 0, 1000); msg.params.snapshot.workers[0].identity.acpSessionId = 'foreign';
  assert.equal(c.push(msg), false);
});
test('client disconnect demotes immediately, and same-generation refetch restores running with original evidence', () => {
  const p = configured(); ingest(p, spawn()); const c = new WorkerClient(scope); c.subscribe('one');
  c.push(p.push('one', 0, 1000)); c.disconnect();
  assert.equal(c.view(1001).workers[0].unknownReason, 'disconnected');
  c.subscribe('two'); c.push(p.push('two', 0, 2000));
  assert.equal(c.view(2000).workers[0].status, 'running');
  assert.equal(c.view(61000).workers[0].status, 'running');
  assert.equal(c.view(61000).workers[0].observedAt, 1000);
});
test('evicted IDs cannot reappear while the seen ledger still has spare capacity', () => {
  const p = configured({ maxRows: 1, maxSeen: 3 });
  ingest(p, spawn('first')); ingest(p, spawn('second'), 2000);
  ingest(p, spawn('first'), 70000);
  assert.equal(row(p, 70000).identity.asyncTaskId, 'second');
  assert.equal(row(p, 70000).observedAt, 2000);
  assert.equal(row(p, 70000).status, 'running');
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
  assert.equal(row(restored, 71000).status, 'running');
});
test('fresh and disconnected clients reject pushes without an acknowledged subscription', () => {
  const p = configured(); ingest(p, spawn()); const c = new WorkerClient(scope);
  for (const id of [null, undefined, '', 17, false, {}, []]) {
    assert.equal(c.push(p.push(id, 0, 1000)), false);
    assert.equal(c.view(1000), null);
  }
  c.subscribe('first'); c.push(p.push('first', 0, 1000)); c.disconnect();
  const disconnected = c.view(2000);
  for (const id of [null, undefined, '', 'first']) {
    assert.equal(c.push(p.push(id, 1, 2000)), false);
    assert.deepEqual(c.view(2000), disconnected);
  }
  assert.equal(c.connected, false);
  assert.equal(c.view(2000).workers[0].unknownReason, 'disconnected');
  assert.equal(c.view(2000).workers[0].observedAt, 1000);
});
test('malformed subscription acknowledgements cannot erase a valid binding or reset its sequence', () => {
  const p = configured(); ingest(p, spawn()); const c = new WorkerClient(scope);
  c.subscribe('active'); c.push(p.push('active', 0, 1000));
  const before = c.view(2000);
  for (const id of [null, undefined, '', 17, false, {}, [], 'bad\n', 'x'.repeat(257)]) {
    assert.equal(c.subscribe(id), false);
    assert.equal(c.subscriptionId, 'active');
    assert.equal(c.seq, 0);
    assert.equal(c.connected, true);
    assert.deepEqual(c.view(2000), before);
    assert.equal(c.push(p.push(id, 1, 2000)), false);
  }
  assert.equal(c.push(p.push('active', 0, 2000)), false);
  assert.equal(c.push(p.push('active', 1, 2000)), true);
});
test('valid re-subscribe requires seq zero and keeps rejecting the previous acknowledged ID', () => {
  const p = configured(); ingest(p, spawn()); const c = new WorkerClient(scope);
  c.subscribe('old'); c.push(p.push('old', 0, 1000)); c.disconnect();
  c.subscribe('new');
  assert.equal(c.push(p.push('old', 1, 2000)), false);
  assert.equal(c.push(p.push('new', 1, 2000)), false);
  assert.equal(c.view(2000).workers[0].unknownReason, 'disconnected');
  assert.equal(c.push(p.push('new', 0, 2000)), true);
  assert.equal(c.view(2000).workers[0].observedAt, 1000);
  assert.equal(c.view(61000).workers[0].status, 'running');
  assert.equal('unknownReason' in c.view(61000).workers[0], false);
});

const claudeScope = { ...scope, provider: 'claude-code' };
const claude = () => new WorkerProjection(claudeScope, { adapterVersion: '0.81.1', negotiated: true });
const claudeIngest = (p, frame, at = 1000) => p.ingest(frame, { ...claudeScope, receivedAt: at, origin: 'live' });
const withUpdate = (frame, extra) => ({ ...frame, update: { ...frame.update, ...extra } });
test('Claude reports shells, workflows and monitors as workers but never subagents', () => {
  const p = claude();
  for (const [id, taskType] of [['a', 'shell'], ['b', 'workflow'], ['c', 'monitor'], ['d', 'task']]) {
    assert.equal(claudeIngest(p, withUpdate(spawn(id), { taskType })), true, taskType);
  }
  for (const [id, taskType] of [['e', 'local_agent'], ['f', 'agent'], ['g', ''], ['h', '  '], ['i', 7], ['j', undefined]]) {
    assert.equal(claudeIngest(p, withUpdate(spawn(id), { taskType })), false, String(taskType));
  }
  const workers = p.list(claudeScope, 1000).workers;
  assert.deepEqual(workers.map((w) => w.taskType), ['shell', 'workflow', 'monitor', 'task']);
  assert.ok(workers.every((w) => w.source === 'claude-air' && w.status === 'running'));
  const long = claude(); claudeIngest(long, withUpdate(spawn(), { taskType: 'x'.repeat(100) }));
  assert.equal(long.list(claudeScope, 1000).workers[0].taskType.length, 64);
});
test('Codex admits only shell workers', () => {
  for (const taskType of ['workflow', 'monitor', 'task']) {
    const p = configured(); assert.equal(ingest(p, withUpdate(spawn(), { taskType })), false, taskType);
  }
});
test('canStop is projected only from an explicit spawn true; terminal-only rows cannot stop', () => {
  for (const [canStop, expected] of [[true, true], [false, false], [undefined, false], ['true', false], [1, false]]) {
    const p = configured(); ingest(p, withUpdate(spawn(), { canStop }));
    assert.equal(row(p).canStop, expected, String(canStop));
  }
  const p = configured(); ingest(p, terminal('stopped'));
  assert.equal(row(p).canStop, false);
});
test('stop forwards exactly one provider request only for a connected, running, stoppable worker', () => {
  const p = configured(); ingest(p, spawn());
  const before = p.checkpoint();
  assert.deepEqual(p.stop({ ...scope, asyncTaskId: 'worker-A' }), { forward: { method: STOP_METHOD, params: { sessionId: scope.acpSessionId, asyncTaskId: 'worker-A' } } });
  assert.equal(STOP_METHOD, '_session/async_task/stop');
  assert.deepEqual(p.checkpoint(), before, 'a stop decision never changes worker state');
  const locked = configured(); ingest(locked, withUpdate(spawn(), { canStop: false }));
  assert.deepEqual(locked.stop({ ...scope, asyncTaskId: 'worker-A' }), { result: { asyncTaskId: 'worker-A', stopped: false } });
  for (const state of ['completed', 'failed', 'stopped']) {
    const ended = configured(); ingest(ended, spawn()); ingest(ended, terminal(state), 2000);
    assert.deepEqual(ended.stop({ ...scope, asyncTaskId: 'worker-A' }), { result: { asyncTaskId: 'worker-A', stopped: false } });
  }
  for (const cut of [(q) => q.disconnect(), (q) => q.loseContinuity()]) {
    const q = configured(); ingest(q, spawn()); cut(q);
    assert.deepEqual(q.stop({ ...scope, asyncTaskId: 'worker-A' }), { result: { asyncTaskId: 'worker-A', stopped: false } });
  }
});
test('stop authorizes before disclosure and rejects unknown or malformed task IDs', () => {
  const p = configured(); ingest(p, spawn());
  for (const asyncTaskId of [undefined, '', 'x'.repeat(257), 'bad\n', 4]) assert.throws(() => p.stop({ ...scope, asyncTaskId }), /invalid-params/);
  assert.throws(() => p.stop({ ...scope, asyncTaskId: 'missing' }), /not-found/);
  assert.throws(() => p.stop({ ...scope, asyncTaskId: 'worker-A' }, { canControl: false }), /not-found/);
  assert.throws(() => p.stop({ ...scope, asyncTaskId: 'worker-A', canControl: true }, { canControl: false }), /not-found/);
  for (const field of ['workspaceId', 'agentId']) assert.throws(() => p.stop({ ...scope, [field]: 'foreign', asyncTaskId: 'worker-A' }), /not-found/);
  assert.throws(() => p.stop({ ...scope, asyncTaskId: 'worker-A' }, { canRead: true }), /not-found/, 'read authority does not confer stop');
});
test('provider stop answers map only an exact stopped:true and never end the worker', () => {
  const p = configured(); ingest(p, spawn());
  for (const [response, stopped] of [[{ stopped: true }, true], [{ stopped: false }, false], [{ stopped: 'true' }, false], [{}, false], [null, false], [undefined, false]]) {
    assert.deepEqual(p.stopResponse('worker-A', response), { asyncTaskId: 'worker-A', stopped });
  }
  assert.equal(row(p).status, 'running');
  ingest(p, terminal('stopped'), 2000);
  assert.equal(row(p, 2000).status, 'stopped');
});
