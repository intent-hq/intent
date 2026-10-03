// Synthetic contract oracle, not a test of the daemon or renderer implementation.
// Component acceptance must feed real wire responses through their own tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const fixture = JSON.parse(fs.readFileSync(new URL('./contract.json', import.meta.url)));
const doc = fs.readFileSync(new URL('../../methods/agents.md', import.meta.url), 'utf8');
const supported = value => value === 1;
const scope = { authority: 'host-a', workspaceId: 'ws-a', agentId: 'agent-a', principalId: 'A' };
const matches = (evidence, id, expectedScope = scope) =>
  Object.keys(scope).every(key => evidence[key] === expectedScope[key]) &&
  evidence.submissionIds?.includes(id) === true;

// Eligibility is derived from trusted internal arrival facts, not wire position.
function target({ rows, draining = [], incoming }) {
  const humans = rows.filter(row => row.human !== false);
  if (!humans.length || humans.some(row => !Number.isSafeInteger(row.order))) return null;
  const latest = humans.reduce((a, b) => a.order > b.order ? a : b);
  if (draining.some(row => row.human !== false && row.provisional &&
      (!Number.isSafeInteger(row.order) || row.order > latest.order))) return null;
  return latest.principal && latest.principal === incoming && !latest.imported && !latest.persisted
    ? latest.id : null;
}

function snapshot({ live, draining }) {
  const overlays = draining.filter(d => !live.some(row =>
    row.submissionIds?.includes(d.id) || row.id === d.id || row.turnId === d.turnId));
  return [...overlays.map(row => ({ ...row, overlay: true })), ...live].map(row => ({
    id: row.id,
    submissionIds: row.submissionIds,
    mergeEligible: !row.overlay && target({ rows: live, draining, incoming: row.principal }) === row.id,
  }));
}

// Source leaves are provenance, not execution entries or permission grants.
function normalizeSources(entries) {
  const leaves = [];
  for (const entry of entries) {
    const sources = entry.recoverySources ?? [{
      messageId: entry.id, author: entry.author, origin: entry.origin,
      ...(entry.submissionIds ? { submissionIds: entry.submissionIds } : {}),
    }];
    for (const source of sources) {
      const key = JSON.stringify([source.messageId, source.origin,
        source.author?.principalId ?? source.author]);
      const existing = leaves.find(leaf => leaf.key === key);
      if (!existing) leaves.push({ key, value: structuredClone(source) });
      else if (existing.value.submissionIds && source.submissionIds) {
        existing.value.submissionIds = [...new Set([...existing.value.submissionIds, ...source.submissionIds])];
      } else delete existing.value.submissionIds;
    }
  }
  return leaves.map(leaf => leaf.value);
}

const sourceItems = row => row.recoverySources ?? [row];
const ownsAlias = (row, pending) => sourceItems(row).some(source =>
  source.author?.principalId != null && source.author.principalId === pending.principalId &&
  source.submissionIds?.includes(pending.id));
const overlaps = (a, b) => sourceItems(a).some(source =>
  source.submissionIds?.some(id => ownsAlias(b, { id, principalId: source.author?.principalId })));

// A small observation oracle with independent history, queue and optimism.
// Requests/results are actual wire shapes; generations are local request fences.
// This does not claim to simulate daemon locks, permissions or provider execution.
function observe(c) {
  const history = new Map();
  const pending = new Map(c.pending.map(row => [row.id, structuredClone(row)]));
  const reads = new Map();
  const evidence = [];
  let queue = [], generation = 0, active = false, needsRefresh = false;
  let currentRead = false;
  const corroborate = row => {
    evidence.push(row);
    for (const [id, local] of pending) if (ownsAlias(row, local)) pending.delete(id);
  };
  const setQueue = rows => {
    queue = structuredClone(rows);
    queue.forEach(corroborate);
  };
  for (const step of c.steps) {
    if (step.request) {
      assert.equal(step.request.method, 'agent.getQueue');
      reads.set(step.request.id, generation);
    } else if (step.response) {
      assert.ok(reads.has(step.response.id), 'every read reply has an issued request');
      if (reads.get(step.response.id) === generation) {
        setQueue(step.response.result.queue);
        currentRead = true;
        needsRefresh = active && queue.length > 0;
      }
      reads.delete(step.response.id);
    } else if (step.event) {
      const { type, workspaceId, data } = step.event;
      assert.equal(workspaceId, scope.workspaceId);
      assert.equal(data.agentId, scope.agentId);
      generation++;
      currentRead = false;
      if (type === 'agent:queue:updated') {
        setQueue(data.queue);
        needsRefresh = queue.some(row => active || row.requeuedAfterFailure || row.recoverySources ||
          [...history.values()].some(h => overlaps(row, h)));
      } else if (type === 'agent:message') {
        history.set(data.messageId, data);
        corroborate(data);
        if (queue.some(row => overlaps(row, data))) needsRefresh = true;
      } else if (type === 'agent:queue:processing') {
        active = true;
        data.queuedMessages.forEach(corroborate);
      } else if (['agent:failed', 'agent:stream:end'].includes(type)) {
        active = false;
        needsRefresh = true;
      } else throw new Error(`Unexpected event ${type}`);
    } else if (step.mutationReply) {
      const reply = step.mutationReply;
      const local = pending.get(reply.requestMessageId);
      // A mutation acknowledgement cannot replace any confirmed queue row.
      if (local && !evidence.some(row => ownsAlias(row, local))) local.destination = 'queue';
    } else if (step.timeout) {
      const local = pending.get(step.timeout);
      if (local) local.uncertain = true;
    } else if (step.disconnect) {
      generation++;
      active = false;
      currentRead = false;
      needsRefresh = true;
    } else throw new Error('Unknown observation');
  }
  return {
    historyIds: [...history.keys()], queueIds: queue.map(row => row.id),
    pendingIds: [...pending.keys()],
    retryWorkIds: currentRead && !active ? queue.filter(row => row.requeuedAfterFailure ||
      row.recoverySources || [...history.values()].some(h => overlaps(row, h))).map(row => row.id) : [],
    needsRefresh,
  };
}

test('wire additions and prepared capability agree with canonical docs', () => {
  assert.equal(fixture.status, 'prepared-synthetic-not-runtime-evidence');
  assert.deepEqual(fixture.capability, { submissionCorrelation: 1 });
  for (const field of ['messageId?: string', 'submissionIds?: string[]', 'mergeEligible?: boolean', 'recoverySources?: RecoverySource[]']) {
    assert.ok(doc.includes(`\`${field}\``), `document ${field}`);
  }
  assert.ok(doc.includes('10 minutes') && doc.includes('1024 submissions'));
  assert.equal(fixture.request.messageId, 'a2');
  assert.notEqual(fixture.request.messageId, fixture.queuedReply.messageId, 'append replies name the survivor');
  const row = fixture.queue[0];
  assert.equal(new Set(row.submissionIds).size, row.submissionIds.length);
  assert.ok(row.submissionIds.includes(row.id));
  assert.ok(row.submissionIds.includes(fixture.request.messageId));
  assert.deepEqual(new Set(fixture.delivered.submissionIds), new Set(row.submissionIds));
  assert.deepEqual(new Set(fixture.queuedReply.submissionIds), new Set(row.submissionIds));
  assert.equal(row.content, 'again\n\nagain', 'identical text remains separate input');
  assert.equal(fixture.delivered.queuedMessageId, row.id);
  assert.notEqual(fixture.delivered.messageId, row.id, 'drain row IDs need explicit correlation');
});

test('unknown and legacy capability values fail closed', () => {
  assert.equal(supported(1), true);
  for (const value of [undefined, null, false, true, 0, 2, '1', {}, []]) assert.equal(supported(value), false);
});

for (const c of fixture.mergeCases) test(`merge eligibility: ${c.name}`, () => {
  assert.equal(target(c), c.target);
  // Changing drain order cannot change human arrival eligibility.
  assert.equal(target({ ...c, rows: [...c.rows].reverse() }), c.target);
});

for (const c of fixture.snapshotCases) test(`full snapshot: ${c.name}`, () => {
  const rows = snapshot(c);
  assert.deepEqual(rows, c.expected);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.ok(rows.filter(row => row.mergeEligible).length <= 1);
});

for (const c of fixture.wireTraces) test(`wire observations: ${c.name}`, () => {
  assert.deepEqual(observe(c), c.expected);
});

test('mixed recovery preserves original author/origin leaves through restart and repeated failure', () => {
  const { originalEntries, expectedSources, firstRetry, secondRetry } = fixture.recovery;
  assert.deepEqual(normalizeSources(originalEntries), expectedSources);
  assert.deepEqual(normalizeSources([JSON.parse(JSON.stringify(firstRetry))]), expectedSources);
  assert.deepEqual(normalizeSources([firstRetry, secondRetry]), expectedSources, 'retry wrapper IDs never become source aliases');
  for (const retry of [firstRetry, secondRetry]) {
    assert.equal(retry.author.principalId, 'A', 'existing head authority is retained');
    assert.equal(retry.submissionIds, undefined, 'no flat head-attributed foreign alias union');
    assert.deepEqual(retry.recoverySources, expectedSources);
    assert.equal(ownsAlias(retry, { id: 'b1', principalId: 'B' }), true);
    assert.equal(ownsAlias(retry, { id: 'b1', principalId: 'A' }), false);
    assert.equal(ownsAlias(retry, { id: 'z1', principalId: 'A' }), false);
  }
});

test('source normalization keeps distinct sources and never fills missing legacy aliases', () => {
  const [a, b, automatic] = fixture.recovery.originalEntries;
  const sameAuthor = { ...a, id: 'a2', submissionIds: ['a2'] };
  const leaves = normalizeSources([a, sameAuthor, b, automatic]);
  assert.deepEqual(leaves.map(x => x.messageId), ['a1', 'a2', 'b1', 'z1']);
  assert.equal(leaves[2].author.principalId, 'B');
  assert.equal(leaves[3].origin, 'automatic');
  const legacy = { ...a };
  delete legacy.submissionIds;
  assert.equal(normalizeSources([a, legacy])[0].submissionIds, undefined);
  assert.equal(normalizeSources([legacy, a])[0].submissionIds, undefined);
  const humanWake = { ...a, origin: 'automatic' };
  assert.equal(normalizeSources([a, humanWake]).length, 2, 'origin is independent from authorship');
  assert.equal(normalizeSources([a, { ...a, author: { principalId: 'B' } }]).length, 2);
});

test('correlation requires every trusted scope dimension and never text equality', () => {
  const evidence = { ...scope, submissionIds: ['a2', 'a1'] };
  assert.equal(matches(evidence, 'a2'), true);
  assert.equal(matches(evidence, 'a3'), false);
  for (const key of Object.keys(scope)) {
    assert.equal(matches({ ...evidence, [key]: 'different' }, 'a2'), false, key);
    assert.equal(matches({ ...evidence, [key]: null }, 'a2'), false, key);
  }
});

test('foreign arrival splits a provisional same-author append without losing aliases', () => {
  const before = { rows: [{ id: 'a1', principal: 'A', order: 1 }], incoming: 'A' };
  assert.equal(target(before), 'a1');
  const after = { ...before, rows: [...before.rows, { id: 'b1', principal: 'B', order: 2 }] };
  assert.equal(target(after), null);
  const confirmed = [
    { ...scope, id: 'a1', submissionIds: ['a1'] },
    { ...scope, principalId: 'B', id: 'b1', submissionIds: ['b1'] },
    { ...scope, id: 'a2', submissionIds: ['a2'] },
  ];
  assert.deepEqual(confirmed.filter(row => matches(row, 'a2')).map(row => row.id), ['a2']);
});
