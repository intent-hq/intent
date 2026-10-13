import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static contract examples only. Component tests must exercise real dispatch,
// authentication and a blocked index transaction before claiming runtime support.
const examples = JSON.parse(readFileSync(new URL('./status.json', import.meta.url)));
const cliExamples = JSON.parse(readFileSync(new URL('./cli-compat.json', import.meta.url)));
const byName = new Map(examples.scenarios.map(s => [s.name, s.response.result]));
const active = new Set(['preparing', 'indexing', 'finalizing']);
const phases = new Set([...active, 'ready', 'failed']);
const integer = n => assert.ok(Number.isSafeInteger(n) && n >= 0);

function validate(s) {
  const fields = new Set(['startupStatus', 'attemptId', 'phase', 'elapsedMs',
    'phaseElapsedMs', 'progressAgeMs', 'retryAfterMs', 'progress',
    'estimatedRemainingMs', 'finalizingStep', 'failure', 'daemonVersion']);
  assert.ok(Object.keys(s).every(key => fields.has(key)));
  assert.equal(s.startupStatus, 1);
  assert.ok(typeof s.attemptId === 'string' && s.attemptId.length > 0);
  if ('daemonVersion' in s) assert.ok(typeof s.daemonVersion === 'string' && s.daemonVersion.trim());
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

test('fresh unchanged counters remain available; timeout and disconnect do not', () => {
  for (const observation of examples.pollObservations) {
    const cached = byName.get(observation.lastSuccessfulScenario);
    assert.ok(cached.progressAgeMs >= 30000);
    assert.equal(observation.statusAvailable, observation.pollOutcome === 'success');
    assert.equal(observation.showEta, false);
  }
  assert.deepEqual(examples.pollObservations.map(o => o.pollOutcome),
    ['success', 'timeout', 'disconnected', 'success']);
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

// Specification oracle only; the production CLI and frozen sitter must be
// exercised by component tests. The CLI build version is deliberately not input.
function startupCliProjection(method, response) {
  try {
    const { error } = response;
    assert.equal(method, 'system.status');
    assert.ok(!('result' in response));
    assert.equal(error.code, -32012);
    const { data } = error;
    assert.equal(data.code, 'daemon-not-ready');
    assert.equal(data.retryable, true);
    const snapshot = data.startup;
    validate(snapshot);
    assert.ok(active.has(snapshot.phase));
    assert.equal(data.retryAfterMs, snapshot.retryAfterMs);
    assert.ok(typeof snapshot.daemonVersion === 'string' && snapshot.daemonVersion.trim());
    return { version: snapshot.daemonVersion, ready: false, startup: snapshot };
  } catch {
    return null;
  }
}

test('only a validated live system.status error gets CLI liveness success', () => {
  for (const sample of cliExamples.filter(s => s.response.error || !s.response.result)) {
    const before = JSON.stringify(sample.response);
    const projected = startupCliProjection(sample.method, sample.response);
    assert.deepEqual(projected, sample.expectedStdout, sample.name);
    assert.equal(projected === null ? 1 : 0, sample.expectedExitCode, sample.name);
    assert.equal(JSON.stringify(sample.response), before, 'wire response is unchanged');
    if (projected) {
      assert.deepEqual(Object.keys(projected).sort(), ['ready', 'startup', 'version']);
      assert.equal(projected.ready, false);
      assert.equal(sample.response.error.code, -32012);
      assert.ok(!('result' in sample.response));
    }
  }
});

test('true ready status retains the ordinary CLI result and gains no synthetic fields', () => {
  const ready = cliExamples.find(s => s.name === 'ordinary-ready-passthrough');
  assert.equal(startupCliProjection(ready.method, ready.response), null);
  assert.deepEqual(ready.expectedStdout, ready.response.result);
  assert.equal(ready.expectedExitCode, 0);
  assert.ok(!('ready' in ready.expectedStdout));
  assert.ok(!('startup' in ready.expectedStdout));
});

test('old sitter sees the responding server version, never the probing CLI version', () => {
  const mixed = cliExamples.find(s => s.name === 'new-cli-older-server');
  const projection = startupCliProjection(mixed.method, mixed.response);
  // Frozen readiness.rs parses version from result-only CLI stdout after exit 0.
  const parsedByOldSitter = JSON.parse(JSON.stringify(projection)).version;
  assert.equal(parsedByOldSitter, '0.10.46');
  assert.notEqual(parsedByOldSitter, mixed.cliVersion);
  const same = cliExamples.find(s => s.name === 'live-indexing-with-estimate');
  const live = startupCliProjection(same.method, same.response);
  assert.equal(live.version, same.cliVersion);
  assert.equal(live.ready, false, 'old sitter liveness success is not application readiness');
});
