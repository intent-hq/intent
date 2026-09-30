import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initial, runtime, token, transition } from './readiness-model.mjs';

// Executable specification of reset rules, NOT implementation/runtime evidence.
const at = '2026-09-30T14:00:00Z';
const step = (s, type, args = {}) => transition(s, { type, ...args }).state;
const running = options => step(step(initial(options), 'start'), 'spawn');
const check = (s, args = {}) => step(s, 'check', { token: token(s), at, ...args });
const ready = options => check(running(options), { httpStatus: 204 });

test('URL discovery and HTTP failures leave readiness false until 2xx', () => {
  let s = step(running(), 'detected-url');
  assert.deepEqual(s.readiness, { state: 'pending' });
  const pending = transition(s, { type: 'check', token: token(s), at, httpStatus: 503 });
  assert.deepEqual(pending.events, []);
  s = pending.state;
  assert.equal(s.ready, false);
  assert.deepEqual(s.readiness, { state: 'pending', checkedAt: at, lastStatus: 503, lastError: 'http-status' });
  s = check(s, { error: 'timeout' });
  assert.equal(s.readiness.lastStatus, undefined);
  const passed = transition(s, { type: 'check', token: token(s), at, httpStatus: 204 });
  assert.equal(passed.state.ready, true);
  assert.deepEqual(passed.events, [runtime(passed.state)]);
  assert.equal(passed.state.readiness.lastError, undefined);
});

test('HTTP boundary statuses and pattern matches have distinct metadata', () => {
  for (const httpStatus of [199, 200, 204, 299, 300, 302, 404, 503]) {
    assert.equal(check(running(), { httpStatus }).ready, httpStatus >= 200 && httpStatus <= 299);
  }
  const s = check(running(), { patternMatched: true });
  assert.deepEqual(s.readiness, { state: 'ready', checkedAt: at });
});

test('readiness is a startup latch; duplicate start and subsequent checks cannot revoke it', () => {
  const s = ready();
  assert.deepEqual(step(s, 'start'), s);
  assert.deepEqual(check(s, { httpStatus: 503 }), s);
});

for (const action of ['restart', 'stop', 'exit', 'spawn-failed', 'hydrate', 'replace', 'remove']) {
  test(`${action} clears success and all metadata; predecessor success/failure cannot return`, () => {
    const before = ready();
    const reset = transition(before, { type: action });
    const s = reset.state;
    assert.equal(s.ready, false);
    assert.deepEqual(s.readiness, { state: action === 'restart' ? 'pending' : 'idle' });
    assert.equal(reset.events.length, 1);
    for (const httpStatus of [204, 503]) {
      assert.deepEqual(step(s, 'check', { token: token(before), at, httpStatus }), s);
    }
  });
}

test('automatic respawn has its own fence even within the same supervisor', () => {
  const before = running();
  const backoff = step(step(before, 'exit'), 'restart');
  const after = step(backoff, 'spawn');
  assert.notEqual(token(before), token(after));
  assert.equal(after.ready, false);
  for (const httpStatus of [204, 503]) {
    assert.deepEqual(step(after, 'check', { token: token(before), at, httpStatus }), after);
  }
  assert.equal(check(after, { httpStatus: 200 }).ready, true);
});

test('stop then start and definition replacement never reuse an earlier check token', () => {
  const before = running();
  for (const action of ['stop', 'replace', 'hydrate']) {
    const after = step(step(step(before, action), 'start'), 'spawn');
    assert.deepEqual(step(after, 'check', { token: token(before), at, patternMatched: true }), after);
    assert.equal(check(after, { patternMatched: true }).ready, true);
  }
});

test('same script IDs in different workspaces cannot share readiness evidence', () => {
  const a = running();
  const b = running({ workspaceId: 'ws-b' });
  assert.deepEqual(step(b, 'check', { token: token(a), at, httpStatus: 204 }), b);
});

test('no contract preserves legacy wire projection through the lifecycle', () => {
  let s = initial({ configured: false });
  for (const action of ['start', 'spawn', 'detected-url', 'restart', 'spawn', 'stop', 'hydrate']) {
    s = step(s, action);
    assert.deepEqual(runtime(s), { status: s.status });
    assert.equal(check(s, { httpStatus: 204 }).ready, undefined);
  }
});

test('ready implies running in every explored lifecycle ordering', () => {
  const actions = ['start', 'spawn', 'restart', 'stop', 'exit', 'replace', 'remove'];
  let states = [initial()];
  for (let depth = 0; depth < 4; depth++) {
    states = states.flatMap(s => actions.map(type => check(step(s, type), { httpStatus: 204 })));
    for (const s of states) {
      assert.equal(s.ready, s.readiness.state === 'ready');
      if (s.ready) assert.equal(s.status, 'running');
    }
  }
});

test('capability and prepared-only limits are documented consistently', async () => {
  const docs = await Promise.all(['methods/scripts.md', 'methods/client-hello.md', 'versioning.md']
    .map(path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));
  for (const doc of docs) assert.ok(doc.includes('scriptReadiness: 1'));
  assert.match(docs[0], /design prototypes only/);
  assert.match(docs[0], /not a regular expression/);
  assert.match(docs[0], /do not follow any\nredirect/);
});
