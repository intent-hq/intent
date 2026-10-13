import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static contract examples only. Component tests must exercise real dispatch,
// authentication and a blocked index transaction before claiming runtime support.
const examples = JSON.parse(readFileSync(new URL('./status.json', import.meta.url)));
const byName = new Map(examples.scenarios.map(s => [s.name, s.response.result]));
const active = new Set(['preparing', 'indexing', 'finalizing']);
const phases = new Set([...active, 'ready', 'failed']);
const integer = n => assert.ok(Number.isSafeInteger(n) && n >= 0);

function validate(s) {
  const fields = new Set(['startupStatus', 'attemptId', 'phase', 'elapsedMs',
    'phaseElapsedMs', 'progressAgeMs', 'retryAfterMs', 'progress',
    'estimatedRemainingMs', 'finalizingStep', 'failure']);
  assert.ok(Object.keys(s).every(key => fields.has(key)));
  assert.equal(s.startupStatus, 1);
  assert.ok(typeof s.attemptId === 'string' && s.attemptId.length > 0);
  assert.ok(phases.has(s.phase));
  for (const key of ['elapsedMs', 'phaseElapsedMs', 'progressAgeMs']) integer(s[key]);
  assert.ok(s.phaseElapsedMs <= s.elapsedMs);
  assert.ok(s.progressAgeMs <= s.elapsedMs);
  assert.equal('retryAfterMs' in s, active.has(s.phase));
  if (active.has(s.phase)) {
    integer(s.retryAfterMs);
    assert.ok(s.retryAfterMs >= 1000 && s.retryAfterMs <= 30000);
  } else {
    assert.equal(s.phaseElapsedMs, 0);
    assert.equal(s.progressAgeMs, 0);
  }
  if (s.progress) {
    const p = s.progress;
    assert.deepEqual(Object.keys(p).sort(), [
      'completedNotes', 'processedSourceBytes', 'totalNotes', 'totalSourceBytes',
    ]);
    Object.values(p).forEach(integer);
    assert.ok(p.completedNotes <= p.totalNotes);
    assert.ok(p.processedSourceBytes <= p.totalSourceBytes);
  }
  if ('estimatedRemainingMs' in s) {
    integer(s.estimatedRemainingMs);
    assert.equal(s.phase, 'indexing');
    assert.ok(s.progress.completedNotes >= 5 && s.phaseElapsedMs >= 2000);
    assert.ok(s.progressAgeMs < 30000);
  }
  assert.equal('finalizingStep' in s, s.phase === 'finalizing');
  if (s.finalizingStep) assert.ok(['anchors', 'committing', 'services'].includes(s.finalizingStep));
  assert.equal('failure' in s, s.phase === 'failed');
  if (s.failure) assert.deepEqual(s.failure, {
    code: 'startup-failed', message: 'Daemon startup failed. Check daemon logs.',
  });
}

test('all phase examples have bounded, consistent status envelopes', () => {
  assert.deepEqual(new Set(examples.scenarios.map(s => s.response.result.phase)), phases);
  for (const { request, response } of examples.scenarios) {
    assert.equal(request.method, 'system.startupStatus');
    assert.deepEqual(request.params, {});
    assert.equal(response.id, request.id);
    assert.equal(response.jsonrpc, '2.0');
    validate(response.result);
  }
});

test('no fabricated ETA; completed work remains distinguishable from commit and readiness', () => {
  assert.ok(!('estimatedRemainingMs' in byName.get('indexing-without-estimate')));
  const committing = byName.get('finalizing-committing');
  assert.equal(committing.progress.completedNotes, committing.progress.totalNotes);
  assert.notEqual(committing.phase, 'ready');
  assert.deepEqual(byName.get('failed').progress, committing.progress);
  assert.equal(byName.get('nothing-to-rebuild').progress.totalNotes, 0);
});

test('restart has new identity and resets measured progress', () => {
  const restarted = byName.get('restarted-attempt');
  assert.notEqual(restarted.attemptId, byName.get('ready').attemptId);
  assert.ok(restarted.elapsedMs < byName.get('ready').elapsedMs);
  assert.ok(!('progress' in restarted));
});

test('hello and ordinary operations receive structured rejection; failure is not retryable', () => {
  assert.ok(examples.rejectedRequests.some(s => s.request.method === 'client.hello'));
  for (const { request, response } of examples.rejectedRequests) {
    assert.equal(response.id, request.id);
    assert.ok(!('result' in response));
    assert.equal(response.error.code, -32012);
    const { data, message } = response.error;
    validate(data.startup);
    const failed = data.startup.phase === 'failed';
    assert.equal(message, failed ? 'Daemon startup failed' : 'Daemon not ready');
    assert.equal(data.code, failed ? 'daemon-startup-failed' : 'daemon-not-ready');
    assert.equal(data.retryable, !failed);
    assert.equal('retryAfterMs' in data, !failed);
    if (!failed) assert.equal(data.retryAfterMs, data.startup.retryAfterMs);
  }
});

test('invalid examples cannot claim ready ETA, overflow progress or leak failure detail', () => {
  assert.throws(() => validate({ ...byName.get('ready'), estimatedRemainingMs: 0 }));
  assert.throws(() => validate({ ...byName.get('indexing-with-estimate'),
    progress: { completedNotes: 11, totalNotes: 10, processedSourceBytes: 0, totalSourceBytes: 0 } }));
  assert.throws(() => validate({ ...byName.get('failed'),
    failure: { code: 'startup-failed', message: '/private/notes.db: SQL error' } }));
  assert.throws(() => validate({ ...byName.get('preparing'), noteTitle: 'Private note' }));
});
