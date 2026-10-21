// Static model/compatibility checks only. No Store, journal, quota, filesystem,
// native task, provider, authority or durable acknowledgement is exercised.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const data = JSON.parse(read('./local-source.json'));
const hash = text => createHash('sha256').update(text).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
const counter = (value, positive = false) => {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(value) <= 18446744073709551615n);
  if (positive) assert.ok(BigInt(value) > 0n);
};
const requiredCoverage = ['immutableSource', 'captureScratch', 'stagePending',
  'stageFinal', 'hub', 'localLog', 'metadata', 'databaseWal'];
const phases = ['reserved', 'sealed', 'headDecided', 'confirmed', 'committed', 'closedRetained'];

function totals(backing) {
  assert.ok(Number.isSafeInteger(backing.byteLimit) && backing.byteLimit > 0);
  assert.ok(Number.isSafeInteger(backing.inodeLimit) && backing.inodeLimit > 0);
  assert.ok(backing.byteLimit <= data.limits.backingBytes);
  assert.ok(backing.inodeLimit <= data.limits.backingInodes);
  assert.deepEqual([...backing.covered].sort(), [...requiredCoverage].sort());
  assert.ok(backing.charges.length > 0);
  let totalBytes = 0n; let totalInodes = 0n;
  for (const item of backing.charges) {
    for (const field of ['bytes', 'inodes']) {
      assert.ok(Number.isSafeInteger(item[field]) && item[field] >= 0);
    }
    totalBytes += BigInt(item.bytes); totalInodes += BigInt(item.inodes);
  }
  assert.ok(totalBytes <= BigInt(backing.byteLimit));
  assert.ok(totalInodes <= BigInt(backing.inodeLimit));
  return { bytes: Number(totalBytes), inodes: Number(totalInodes) };
}

function validate(example) {
  const { owner, history, cut, target, backing, trace } = example;
  counter(owner.assignmentEpoch, true); counter(owner.captureRevision, true);
  counter(cut.throughSeq);
  assert.ok(bytes(history.rowsJson) <= data.limits.historyBytes);
  assert.equal(bytes(history.rowsJson), history.bytes);
  assert.equal(hash(history.rowsJson), history.sha256);
  const rows = JSON.parse(history.rowsJson);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, history.rowCount);
  assert.ok(rows.length <= data.limits.messages);
  assert.equal(new Set(rows.map(r => r.messageId)).size, rows.length);
  assert.ok(!rows.some(r => r.messageId === history.excludedEnvelope));
  let blocks = 0; let previous = -1n;
  rows.forEach(row => {
    counter(row.storeSeq);
    assert.ok(BigInt(row.storeSeq) > previous); previous = BigInt(row.storeSeq);
    assert.ok(['user', 'assistant', 'system'].includes(row.role));
    assert.ok(Array.isArray(row.content)); blocks += row.content.length;
    assert.ok(row.attribution && typeof row.attribution === 'object');
  });
  assert.equal(blocks, history.blockCount); assert.ok(blocks <= data.limits.blocks);
  if (rows.length) assert.deepEqual(history.storeCut,
    { messageId: rows.at(-1).messageId, seq: rows.at(-1).storeSeq });
  else assert.equal(history.storeCut, null);
  assert.equal(history.mapping.length, rows.length);
  history.mapping.forEach((entry, index) => {
    assert.equal(entry.localSeq, String(index + 1));
    assert.equal(entry.messageId, rows[index].messageId);
    assert.equal(entry.storeSeq, rows[index].storeSeq);
    assert.equal(entry.rowSha256, hash(JSON.stringify(rows[index])));
  });
  assert.equal(cut.throughSeq, String(history.mapping.length));
  assert.equal(cut.historySha256, history.sha256);

  // The actual transferable manifest stays format1; this separate test model
  // deliberately does not allocate local-log or acknowledgement wire fields.
  assert.ok(bytes(example.manifestJson) <= data.limits.manifestBytes);
  const manifest = JSON.parse(example.manifestJson);
  keys(manifest, ['formatVersion', 'checkpointId', 'workspaceId', 'agentId',
    'leaseId', 'incarnation', 'runId', 'assignmentEpoch', 'captureRevision',
    'capturedAt', 'journalSeq', 'repos', 'session', 'attachments']);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(hash(example.manifestJson), example.manifestSha256);
  assert.equal(manifest.checkpointId, cut.checkpointId);
  assert.equal(manifest.agentId, owner.parentAgentId);
  assert.equal(manifest.workspaceId, owner.workspaceId);
  for (const key of ['leaseId', 'incarnation', 'runId', 'assignmentEpoch', 'captureRevision']) {
    assert.equal(manifest[key], owner[key]);
  }
  assert.equal(manifest.journalSeq, cut.throughSeq);
  assert.deepEqual(manifest.session, {
    provider: 'claude-code', mode: 'history', throughSeq: cut.throughSeq, files: [],
  });
  assert.deepEqual(manifest.attachments, []);
  assert.ok(manifest.repos.length > 0 && manifest.repos.length <= data.limits.repositories);
  for (const repo of manifest.repos) {
    assert.equal(repo.objectFormat, 'sha1');
    for (const field of ['head', 'forkBase', 'index']) assert.match(repo[field], /^[a-f0-9]{40}$/);
    assert.ok(!Object.hasOwn(repo, 'wip'));
  }
  keys(example.receipt, ['checkpointId', 'manifestSha256', 'journalSeq']);
  assert.deepEqual(example.receipt, { checkpointId: manifest.checkpointId,
    manifestSha256: example.manifestSha256, journalSeq: cut.throughSeq });
  assert.equal(target.workspaceId, owner.workspaceId);
  assert.equal(target.mergeTargetAgentId, owner.parentAgentId);
  assert.equal(target.inheritedCheckpointId, manifest.checkpointId);
  assert.notEqual(target.agentId, owner.parentAgentId);
  assert.notEqual(target.runId, owner.runId); assert.notEqual(target.leaseId, owner.leaseId);
  counter(target.assignmentEpoch, true);
  keys(example.freshPrompt, ['blocks']);
  assert.ok(example.freshPrompt.blocks.some(b => b.type === 'text' && b.text.length > 0));

  const charge = totals(backing);
  assert.ok(charge.bytes >= history.bytes);
  assert.deepEqual(trace.map(t => t.phase), phases);
  for (const step of trace) {
    assert.equal(step.importId, cut.importId);
    assert.equal(step.throughSeq, cut.throughSeq);
    assert.equal(step.historySha256, history.sha256);
    assert.equal(step.retainedBytes, history.bytes);
    assert.equal(step.chargedBytes, charge.bytes);
    assert.equal(step.chargedInodes, charge.inodes);
  }
}

test('fixture scope, finite limits and unexecuted runtime cases', () => {
  assert.equal(data.qualification, 'prepared-data-and-static-integrity-only');
  assert.match(data.representation, /not a wire DTO, persistence format/);
  assert.deepEqual(data.unchangedFormats, { checkpointFormat: 1, journalFormat: 1 });
  assert.deepEqual(data.limits, { messages: 4096, blocks: 16384, historyBytes: 1048576,
    repositories: 64, manifestBytes: 1048576, stageRepositoryBytes: 268435456,
    stageTotalBytes: 1073741824, backingBytes: 4294967296, backingInodes: 262144 });
  for (const group of [data.examples, data.invalidExamples, data.runtimeScenarios]) {
    assert.equal(new Set(group.map(x => x.id)).size, group.length);
  }
  assert.ok(data.runtimeScenarios.length >= 20);
  for (const scenario of data.runtimeScenarios) {
    assert.equal(scenario.executed, false); assert.ok(scenario.required.length > 20);
  }
});
for (const example of data.examples) test(`static compatible example: ${example.id}`, () => validate(example));
for (const bad of data.invalidExamples) test(`static contradiction rejected: ${bad.id}`, () => {
  const example = structuredClone(data.examples.find(x => x.id === bad.base));
  assert.ok(example, 'known fixture base');
  const path = bad.replace.path; let target = example;
  for (const key of path.slice(0, -1)) { assert.ok(Object.hasOwn(target, key)); target = target[key]; }
  target[path.at(-1)] = bad.replace.value;
  assert.throws(() => validate(example));
});

test('exact byte and inode bounds use all simultaneous charges', () => {
  const backing = structuredClone(data.examples[0].backing);
  backing.charges = [{ resource: 'all', bytes: data.limits.backingBytes, inodes: data.limits.backingInodes }];
  assert.deepEqual(totals(backing), { bytes: 4294967296, inodes: 262144 });
  backing.charges.push({ resource: 'uncertain', bytes: 1, inodes: 0 });
  assert.throws(() => totals(backing));
  backing.charges[1] = { resource: 'uncertain', bytes: 0, inodes: 1 };
  assert.throws(() => totals(backing));
});
test('ordinary Store sequence is not a fabricated local journal counter', () => {
  const history = data.examples[0].history;
  assert.equal(history.storeCut.seq, '12');
  assert.deepEqual(history.mapping.map(x => x.localSeq), ['1', '2', '3']);
  assert.notEqual(history.storeCut.seq, history.mapping.at(-1).localSeq);
});
test('confirmed empty prefix still needs every owned decision step', () => {
  const empty = structuredClone(data.examples.find(x => x.id === 'proven-empty-committed-prefix'));
  validate(empty);
  empty.trace.splice(2, 1);
  assert.throws(() => validate(empty));
});
test('canonical docs keep LOCAL retention separate from remote replay and fresh Prompt', () => {
  const docs = read('../../node-checkpoints.md');
  assert.match(docs, /## Retained head-local source lineage/);
  assert.match(docs, /head-side source provenance, not fresh-child provider\s+replay/);
  assert.match(docs, /acknowledgement \*\*does not reclaim\*\*/);
  assert.match(docs, /database\/WAL destinations/);
  assert.match(docs, /capture-only purpose atomically/);
  assert.match(docs, /FULL durable\s+head transaction/);
});
test('private enrollment and capture supported sets are unchanged by LOCAL examples', () => {
  const enrollment = JSON.parse(read('./enrollment.json'));
  assert.deepEqual(enrollment.versions, { lifecycle: [2, 3, 4], capture: [3, 4],
    enrollment: [4], checkpointFormat: 1, journalFormat: 1 });
  const capture = JSON.parse(read('./checkpoint-capture.json'));
  assert.equal(capture.checkpointFormat, 1); assert.equal(capture.nodeProtocol, 3);
  const versioning = read('../../versioning.md');
  assert.ok(!versioning.includes('nodeProtocol 5'));
});
