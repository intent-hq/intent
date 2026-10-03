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

// This records only the specified submission's location/evidence precedence.
// It deliberately does not simulate provider delivery or persistence.
function trace(steps, initial = 'pending') {
  let state = initial;
  for (const step of steps) {
    switch (step) {
      case 'delivered': state = 'delivered'; break;
      case 'processing': if (state !== 'delivered') state = 'processing'; break;
      case 'restore': if (state !== 'delivered') state = 'queue'; break;
      case 'queue': case 'ack':
        if (!['processing', 'delivered'].includes(state)) state = 'queue';
        break;
      case 'timeout': if (['pending', 'conversation'].includes(state)) state = 'uncertain'; break;
      case 'reject': state = 'rejected'; break;
      case 'foreign-queue':
        assert.equal(matches({ ...scope, principalId: 'B', submissionIds: ['a2'] }, 'a2'), false);
        break;
      case 'legacy-queue': assert.equal(matches({ ...scope, content: 'again' }, 'a2'), false); break;
      case 'absent': break;
      default: throw new Error(`Unknown fixture operation ${step}`);
    }
  }
  return state;
}

test('wire additions and prepared capability agree with canonical docs', () => {
  assert.equal(fixture.status, 'prepared-synthetic-not-runtime-evidence');
  assert.deepEqual(fixture.capability, { submissionCorrelation: 1 });
  for (const field of ['messageId?: string', 'submissionIds?: string[]', 'mergeEligible?: boolean']) {
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

for (const c of fixture.traces) test(`evidence precedence: ${c.name}`, () => {
  assert.equal(trace(c.steps, c.initial), c.expected);
});

test('all reply/queue/delivery permutations end in one delivered location', () => {
  for (const steps of [
    ['ack', 'queue', 'delivered'], ['queue', 'ack', 'delivered'],
    ['ack', 'delivered', 'queue'], ['queue', 'delivered', 'ack'],
    ['delivered', 'queue', 'ack'], ['delivered', 'ack', 'queue'],
  ]) assert.equal(trace(steps), 'delivered');
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
