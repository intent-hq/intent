import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const corpus = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
const doc = await readFile(new URL('../../event-stream-recovery.md', import.meta.url), 'utf8');
const maxGeneration = 18446744073709551615n;

// Static fixture integrity only. Components must run the schedules against their
// actual transports, admission code, schedulers and stores before advertising support.
function validGeneration(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    && value.length <= 20 && BigInt(value) <= maxGeneration;
}

function expectedAdmission(example) {
  const { params } = example.frame;
  const { lease } = example;
  if (!validGeneration(params.generation) || !lease || lease.retired || lease.lossRecovery !== 1
    || params.subscriptionId !== lease.subscriptionId
    || params.scope.workspaceId !== lease.workspaceId) return 'reject';
  const context = example.deliveryContext ?? lease;
  if (context.connectionEpoch !== lease.connectionEpoch
    || context.principalEpoch !== lease.principalEpoch) return 'reject';
  return BigInt(params.generation) > BigInt(example.lastGeneration ?? '0') ? 'invalidate' : 'ignore';
}

test('prepared corpus owns exact wire shapes without domain event payloads', () => {
  assert.equal(corpus.status, 'prepared-not-executed');
  assert.deepEqual(corpus.capability, { eventStreamRecovery: 1 });
  for (const example of corpus.admission) {
    assert.deepEqual(Object.keys(example.frame).sort(), ['jsonrpc', 'method', 'params']);
    assert.equal(example.frame.jsonrpc, '2.0');
    assert.equal(example.frame.method, 'events.lost');
    assert.deepEqual(Object.keys(example.frame.params).sort(), ['generation', 'scope', 'subscriptionId']);
    assert.deepEqual(Object.keys(example.frame.params.scope), ['workspaceId']);
    assert.equal(expectedAdmission(example), example.expected, example.id);
  }
});

test('negotiation requires exact capability, request and ack; legacy shapes stay unchanged', () => {
  for (const row of corpus.negotiation) {
    assert.equal(row.admit, row.capability === 1 && row.request === 1 && row.ack === 1, row.id);
  }
  assert.equal(corpus.wire.scopedRequest.params.lossRecovery, 1);
  assert.equal(corpus.wire.scopedAck.result.lossRecovery, 1);
  assert.equal(corpus.wire.scopedAck.id, corpus.wire.scopedRequest.id);
  assert.equal(corpus.wire.legacyAck.id, corpus.wire.legacyRequest.id);
  assert.equal('lossRecovery' in corpus.wire.legacyRequest.params, false);
  assert.deepEqual(Object.keys(corpus.wire.legacyAck.result), ['subscriptionId']);
});

test('precision and malformed boundaries cannot silently become valid', () => {
  const byId = Object.fromEntries(corpus.admission.map(row => [row.id, row]));
  assert.equal(byId['exact-u64'].frame.params.generation, '9007199254740993');
  assert.equal(byId['max-u64'].frame.params.generation, String(maxGeneration));
  for (const id of ['zero', 'leading-zero', 'number', 'overflow', 'negative', 'decimal']) {
    assert.equal(byId[`reject-${id}`].expected, 'reject');
    assert.equal(validGeneration(byId[`reject-${id}`].frame.params.generation), false);
  }
  for (const id of ['scoped', 'unscoped', 'foreign-subscription', 'rejected-subscribe',
    'retired-subscription', 'foreign-connection', 'principal-aba', 'legacy-lease']) assert.ok(byId[id], id);
});

test('all deterministic schedules have component owners and observable assertions', () => {
  const ids = corpus.scenarios.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of corpus.scenarios) {
    assert.ok(row.steps.length >= 2, row.id);
    assert.ok(Object.keys(row.expect).length > 0, row.id);
    assert.ok(row.consumers.length > 0, row.id);
    for (const owner of row.consumers) assert.ok(corpus.consumers[owner]?.length, `${row.id}: ${owner}`);
  }
  for (const id of ['final-loss', 'ack-order', 'conflation-barrier', 'writer-timeout',
    'membership-only-loss', 'replace-lease', 'generation-exhaustion', 'early-marker',
    'early-staging-overflow', 'overlap-and-trailing', 'sustained-success', 'finite-failures',
    'newer-push', 'teardown-and-aba', 'inactive-resource', 'final-file-git-state',
    'legacy-fallback', 'typed-channel-independence', 'queued-writer-timeout',
    'overlap-independent-generations', 'queued-event-after-read',
    'held-overlap-independent-generations', 'fence-covers-bus-worker',
    'fence-retired-set', 'fence-ordered-ingress', 'fence-loss-window',
    'fence-filtered-transient-tail', 'fence-new-overlap', 'fence-control-only',
    'failed-end-fence-budget', 'fence-wss-nonblocking']) assert.ok(ids.includes(id), id);
});

test('bounded scheduler examples agree with documented policy', () => {
  assert.deepEqual(corpus.policy, {
    minReadStartIntervalMs: 250, failureRetryDelaysMs: [1000, 4000],
    maxConsecutiveFailures: 3, maxEarlyMarkerIds: 64, lossBarrierTimeoutMs: 5000,
  });
  const byId = Object.fromEntries(corpus.scenarios.map(row => [row.id, row]));
  const failures = byId['finite-failures'].expect;
  assert.deepEqual(failures.startTimesMs, [0, 1000, 5000]);
  assert.equal(failures.reads, corpus.policy.maxConsecutiveFailures);
  const starts = byId['sustained-success'].expect.startTimesMs;
  starts.slice(1).forEach((at, index) => assert.ok(at - starts[index] >= corpus.policy.minReadStartIntervalMs));
  assert.equal(byId['overlap-and-trailing'].expect.maxActive, 1);
  assert.equal(byId['overlap-and-trailing'].expect.maxPending, 1);
  for (const value of ['250 ms', '1,000 ms', '4,000 ms', '5,000 ms', '64 early']) assert.ok(doc.includes(value), value);
});

test('invalid opt-in parameters never admit or replace a lease', () => {
  for (const row of corpus.requestValidation) {
    const optedIn = Object.hasOwn(row.params, 'lossRecovery');
    const accepted = !optedIn || (row.params.lossRecovery === 1
      && row.hasRequestId && row.params.workspaceId !== '');
    assert.equal(accepted, row.accepted, row.id);
    if (!accepted && row.hasRequestId) assert.equal(row.errorCode, -32602, row.id);
    if (!row.hasRequestId) assert.equal(row.response, null, row.id);
  }
});


test('fences have exact correlation and reject partial or foreign lease sets', () => {
  const { fenceRequest, fenceReply } = corpus.wire;
  assert.equal(fenceRequest.method, 'events.fence');
  assert.equal(fenceRequest.id, fenceReply.id);
  assert.deepEqual(fenceReply.result, fenceRequest.params);
  assert.deepEqual(Object.keys(fenceReply.result), ['subscriptionIds']);
  for (const row of corpus.fenceValidation) {
    const ids = row.subscriptionIds;
    const accepted = ids.length >= 1 && ids.length <= 64
      && new Set(ids).size === ids.length
      && ids.every(id => typeof id === 'string' && id.length > 0 && row.liveOptedInIds.includes(id));
    assert.equal(accepted, row.accepted, row.id);
  }
});

test('request bounds include every begin fence, data read and end fence', () => {
  const byId = Object.fromEntries(corpus.scenarios.map(row => [row.id, row]));
  for (const id of ['overlap-and-trailing', 'finite-failures', 'queued-event-after-read', 'failed-end-fence-budget']) {
    const e = byId[id].expect;
    assert.equal(e.totalRpcs, e.beginFenceRpcs + e.dataRpcs + e.endFenceRpcs, id);
    assert.ok(e.totalRpcs <= 3 * e.dataRpcs, id);
  }
  assert.equal(byId['failed-end-fence-budget'].expect.totalRpcs, 9);
  assert.equal(byId['fence-control-only'].expect.consecutiveFailures, 2);
  assert.equal(byId['fence-control-only'].expect.newDirtyVersions, 0);
  assert.equal(byId['fence-new-overlap'].expect.snapshotApplied, false);
});
