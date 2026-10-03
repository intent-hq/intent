import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  utf8, wireBytes, digest, boundary, spliceError, applySourceSplices, mapPoint,
  assertSourcePage, cursorError, overlapIds, assertRanges, assertOperationTrace,
} from './contract.mjs';

const f = JSON.parse(await readFile(new URL('./contract.json', import.meta.url), 'utf8'));
const docs = await readFile(new URL('../../methods/notes-tasks.md', import.meta.url), 'utf8');
const events = await readFile(new URL('../../06-events.md', import.meta.url), 'utf8');
const errors = await readFile(new URL('../../09-error-codes.md', import.meta.url), 'utf8');
const versioning = await readFile(new URL('../../versioning.md', import.meta.url), 'utf8');
const frame = (text, start, end, length) => ({ jsonrpc: '2.0', id: 1, result: {
  kind: 'noteSourcePage', scope: f.scope, sourceRevision: 'r:7', snapshotId: 'snapshot-a',
  expiresAt: '2026-10-03T00:05:00.000Z', sourceLength: length, range: { start, end }, text,
  nextCursor: end === length ? null : 'opaque-next', previousCursor: start === 0 ? null : 'opaque-previous',
  contextRef: 'opaque-context',
} });

// The functions above operate only on fixture strings. They do not service requests,
// create tokens, prove database atomicity, or claim real paging implementation.
test('prepared status, capability gates, hard limits and catalog integration agree', () => {
  assert.equal(f.status, 'prepared-specification-only');
  assert.deepEqual(f.capabilities, { notePaging: 1, noteAnnotations: 1 });
  for (const cap of Object.keys(f.capabilities)) {
    assert.ok(docs.includes(`${cap}: 1`));
    assert.ok(versioning.includes(`${cap}: 1`));
  }
  for (const limit of [16384, 65536, 4096]) assert.ok(docs.includes(limit.toLocaleString('en-US')));
  assert.deepEqual(f.limits, { sourceBytes: 16384, wireBytes: 65536, receiptBytes: 4096,
    items: 128, annotationItems: 64, ranges: 32, splices: 32, tokenBytes: 256 });
  for (const method of ['note.applySplices', 'note.operationStatus']) assert.ok(docs.includes(`| ${method} |`));
  assert.ok(events.includes('projection: "pageState"'));
  assert.ok(events.includes('4,096'));
  for (const error of ['note-page-stale', 'note-page-expired', 'note-page-cursor-invalid',
    'note-revision-conflict', 'note-operation-mismatch', 'note-operation-expired', 'note-page-budget']) {
    assert.ok(errors.includes(`| ${error} |`));
  }
});

for (const fixture of f.sources) test(`exact source pages: ${fixture.id}`, () => {
  const source = fixture.text ?? fixture.recipe.prefix + fixture.recipe.repeat.repeat(fixture.recipe.count) + fixture.recipe.suffix;
  const limits = { ...f.limits, sourceBytes: fixture.maxSourceBytes ?? f.limits.sourceBytes };
  const boundaries = fixture.boundaries ? [...fixture.boundaries] : [0];
  if (!fixture.boundaries) {
    let pos = 0;
    // Deliberately page a giant single construct by scalar bytes, never by grammar.
    while (pos < source.length) {
      let end = pos, bytes = 0;
      for (const scalar of source.slice(pos)) {
        if (bytes + utf8(scalar) > limits.sourceBytes) break;
        bytes += utf8(scalar); end += scalar.length;
      }
      boundaries.push(end); pos = end;
    }
  }
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries.at(-1), source.length);
  const pages = boundaries.slice(1).map((end, i) => frame(source.slice(boundaries[i], end), boundaries[i], end, source.length));
  for (const p of pages) assertSourcePage(source, p, limits);
  assert.equal(pages.map(p => p.result.text).join(''), source);
  assert.equal([...pages].reverse().reduce((s, p) => p.result.text + s, ''), source);
  if (fixture.recipe) {
    assert.ok(source.length > 10 * limits.sourceBytes);
    assert.ok(pages.length > 10);
    assert.ok(pages[1].result.text.length > 0 && !pages[1].result.text.includes('```'));
  }
});

test('UTF-16/scalar/UTF-8 units differ and only surrogate interiors are invalid', () => {
  const text = 'A😀é\r\n中';
  assert.equal(text.length, 8);
  assert.equal([...text].length, 7);
  assert.equal(utf8(text), 13);
  assert.equal(boundary(text, 2), false);
  assert.equal(boundary(text, 6), true); // between CR and LF is valid
  const p = frame('😀', 1, 3, text.length);
  assertSourcePage(text, p, { ...f.limits, sourceBytes: 4 });
  assert.throws(() => assertSourcePage(text, { ...p, result: { ...p.result, range: { start: 2, end: 3 }, text: '\ude00' } }, f.limits));
});

test('recorded wire page fits exactly after JSON escaping; one extra scalar exceeds budget', () => {
  const c = f.escapedWire;
  const source = c.scalar.repeat(c.sourceCount);
  const page = frame(source.slice(0, c.end), 0, c.end, source.length);
  assert.equal(wireBytes(page), c.expectedWireBytes);
  assert.ok(utf8(page.result.text) < c.maxWireBytes);
  assertSourcePage(source, page, { sourceBytes: f.limits.sourceBytes, wireBytes: c.maxWireBytes });
  const extra = frame(source.slice(0, c.end + 1), 0, c.end + 1, source.length);
  assert.ok(wireBytes(extra) > c.maxWireBytes);
  assert.throws(() => assertSourcePage(source, extra, { sourceBytes: f.limits.sourceBytes, wireBytes: c.maxWireBytes }));
});

for (const c of f.splices) test(`base-addressed splice: ${c.id}`, () => {
  const error = spliceError(c.source, c.splices, f.limits);
  assert.equal(error, c.error ?? null);
  if (!error) assert.equal(applySourceSplices(c.source, c.splices), c.expect);
});

test('inline input has independent count and decoded-byte limits', () => {
  assert.equal(spliceError('a'.repeat(34), Array.from({ length: 33 }, (_, i) => ({ start: i, end: i, text: '' })), f.limits), 'note-page-budget');
  assert.equal(spliceError('', [{ start: 0, end: 0, text: '😀'.repeat(4096) }], f.limits), null);
  assert.equal(spliceError('', [{ start: 0, end: 0, text: '😀'.repeat(4097) }], f.limits), 'note-page-budget');
});

for (const c of f.cursors) test(`cursor consistency: ${c.id}`, () => {
  const claim = { ...f.cursorClaim, ...c.claimPatch };
  const request = { ...claim, ...c.requestPatch };
  assert.equal(cursorError(claim, request, { ...f.current, ...c.currentPatch }, c.now ?? 1000), c.expect);
});

test('seek, backward exhaustion and late responses retain scope/revision identity', () => {
  const source = 'same 😀 same';
  const p = frame('😀', 5, 7, source.length);
  assertSourcePage(source, p, f.limits);
  const backward = frame(source.slice(0, 5), 0, 5, source.length);
  assertSourcePage(source, backward, f.limits);
  assert.equal(backward.result.previousCursor, null);
  const exhausted = frame('', source.length, source.length, source.length);
  assertSourcePage(source, exhausted, f.limits);
  assert.equal(exhausted.result.nextCursor, null);
  const key = p => JSON.stringify([p.scope, p.sourceRevision, p.snapshotId]);
  assert.notEqual(key(p.result), key({ ...p.result, sourceRevision: 'r:8' }));
  assert.notEqual(key(p.result), key({ ...p.result, scope: { ...f.scope, noteId: 'other' } }));
});

test('disjoint annotation queries retain outside-start overlap and canonical alias IDs', () => {
  const c = f.annotations;
  assertRanges(c.ranges, f.limits.ranges);
  assert.deepEqual(overlapIds(c.anchors, c.ranges), c.expect);
  assert.deepEqual(overlapIds(c.anchors, []), []);
  assert.ok(overlapIds(c.anchors, [{ start: 10, end: 50 }]).includes('gap-only'));
  assert.throws(() => assertRanges([{ start: 10, end: 20 }, { start: 20, end: 30 }], 32));
  assert.throws(() => assertRanges([{ start: 10, end: 30 }, { start: 20, end: 40 }], 32));
});

test('authoritative mapping retains affinity and deletion independent of source size', () => {
  for (const c of f.mapping.points) assert.deepEqual(mapPoint(c.point, c.affinity, f.mapping.changes), c.expect);
  assert.deepEqual(mapPoint(1000000, 'after', [{ start: 0, end: 2000000, insertedLength: 3 }]), { offset: 3, deleted: true });
  assert.deepEqual(mapPoint(2, 'after', [{ start: 0, end: 2, insertedLength: 1 }, { start: 2, end: 2, insertedLength: 4 }]), { offset: 5, deleted: false });
  const many = Array.from({ length: 1000 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, insertedLength: 0 }));
  const pages = [];
  for (let i = 0; i < many.length; i += f.limits.items) pages.push(many.slice(i, i + f.limits.items));
  assert.deepEqual(pages.flat(), many);
  assert.ok(pages.every(p => p.length <= 128 && wireBytes(p) < f.limits.wireBytes));
  assert.notDeepEqual(mapPoint(2001, 'after', pages[0]), mapPoint(2001, 'after', pages.flat()));
});

test('digest binds exact scope, base, operation identity and ordered payload', () => {
  const c = f.digestVector;
  assert.equal(digest(c.payload), c.sha256);
  assert.equal(digest(Object.fromEntries(Object.entries(c.payload).reverse())), c.sha256);
  for (const field of ['backendId', 'workspaceId', 'noteId', 'noteInstanceId', 'baseRevision', 'operationId', 'expiresAt']) {
    assert.notEqual(digest({ ...c.payload, [field]: 'changed' }), c.sha256);
  }
  assert.notEqual(digest({ ...c.payload, splices: [...c.payload.splices].reverse() }), c.sha256);
});

test('recorded receipt transitions reject duplicate writes, false failures and false save success', () => {
  assertOperationTrace(f.operationTrace);
  const receipt = f.operationTrace.steps.find(s => s.receipt).receipt;
  assert.ok(wireBytes({ jsonrpc: '2.0', id: 1, result: receipt }) <= f.limits.receiptBytes);
  for (const forbidden of ['content', 'newContent', 'oldContent', 'current', 'note', 'splices']) assert.equal(receipt[forbidden], undefined);
  for (const mutate of [
    t => { t.steps[4].writeCount = 1; },
    t => { t.steps[4].receipt.afterRevision = 'r:11'; },
    t => { t.steps[2].atomicReceipt = false; },
    t => { t.steps[3].clearDraft = true; },
    t => { t.steps[6].historyCount = 1; },
  ]) {
    const bad = structuredClone(f.operationTrace); mutate(bad);
    assert.throws(() => assertOperationTrace(bad));
  }
});

test('annotation summaries, reply pages, fragments and events remain bounded', () => {
  const c = f.annotationPages;
  for (const p of c.pages) {
    assert.ok(wireBytes(p) <= f.limits.wireBytes);
    assert.ok(p.result.items.length <= f.limits.annotationItems);
    assert.equal(p.result.commentRevision, 'c:4');
    assert.equal(p.result.totalComments, 3);
    for (const row of p.result.items) {
      assert.equal(row.comments, undefined);
      assert.equal(row.replies, undefined);
      assert.ok(utf8(row.preview) <= 512);
      assert.ok(row.bodyRef);
    }
  }
  assert.deepEqual(c.pages.flatMap(p => p.result.items.map(r => r.commentId)), ['root', 'reply-1', 'reply-2']);
  assert.equal(c.pages.at(-1).result.nextCursor, null);
  assert.equal(c.fragments.map(p => p.text).join(''), c.expectedBody);
  assert.ok(c.fragments.every(p => utf8(p.text) <= f.limits.sourceBytes));
  for (const event of c.events) {
    assert.ok(wireBytes(event) <= f.limits.receiptBytes);
    assert.equal(event.params.payload.invalidation, 'all');
    for (const field of ['content', 'note', 'attributions', 'threads', 'comments']) assert.equal(event.params.payload[field], undefined);
  }
  const states = c.events.map(e => e.params.payload);
  assert.equal(states[0].sourceRevision, states[1].sourceRevision);
  assert.notEqual(states[0].attributionGeneration, states[1].attributionGeneration);
  assert.equal(states[1].commentRevision, states[0].commentRevision);
  assert.notEqual(states[2].commentRevision, states[1].commentRevision);
  assert.equal(states[2].attributionGeneration, states[1].attributionGeneration);
});

test('frozen dirty view excludes later typing and preserves current selected-copy MIME', () => {
  const c = f.frozenOperation;
  const prefix = c.edits.filter(e => e.sequence <= c.capturedSequence);
  const view = prefix.reduce((text, e) => applySourceSplices(text, [e]), c.source);
  assert.equal(view, c.expect);
  assert.equal(c.saveCount, 0);
  assert.equal(c.mime, 'text/plain');
  for (const outcome of c.cutOutcomes) assert.equal(outcome.sourceWrites,
    outcome.publication === 'succeeded' && outcome.commit === 'committed' ? 1 : 0);
});

test('legacy full result and page discriminants cannot be interchanged', () => {
  assert.equal(f.legacy.request.params.page, undefined);
  assert.equal(f.legacy.result.note.content, 'whole note');
  assert.equal(f.legacy.result.kind, undefined);
  const page = frame('', 0, 0, 0);
  assert.equal(page.result.note, undefined);
  assert.equal(page.result.content, undefined);
  assert.throws(() => assertSourcePage('whole note', { result: f.legacy.result }, f.limits));
});

test('wire requests retain explicit opt-ins and the digest includes the method', () => {
  for (const request of f.requests) {
    assert.equal(request.jsonrpc, '2.0');
    assert.ok(Number.isSafeInteger(request.id));
    assert.equal(request.params.workspaceId, f.scope.workspaceId);
    assert.equal(request.params.noteId, f.scope.noteId);
    assert.ok(wireBytes(request) <= f.limits.wireBytes);
    assert.ok(docs.includes(`| ${request.method} |`));
  }
  const request = f.requests.find(r => r.method === 'note.applySplices');
  const { payloadDigest, ...payload } = request.params;
  assert.equal(digest({ method: request.method, ...payload }), payloadDigest);
  assert.equal(f.requests.find(r => r.method === 'note.operationStatus').params.payloadDigest, payloadDigest);
});

test('structural context and alias expansions page separately from source', () => {
  for (const p of f.contextPages) {
    assert.equal(p.kind, 'noteContextPage');
    assert.equal(p.sourceRevision, 'r:7');
    assert.ok(p.items.length <= f.limits.items);
    assert.ok(wireBytes({ jsonrpc: '2.0', id: 1, result: p }) <= f.limits.wireBytes);
    for (const item of p.items) {
      assert.ok(item.detailRef);
      assert.equal(item.content, undefined);
      assert.equal(item.text, undefined);
    }
  }
  assert.ok(f.contextPages[0].items[0].sourceRange.end > f.limits.sourceBytes);
  const aliases = f.anchorOccurrences.pages.flat();
  assert.equal(new Set(aliases.map(a => a.occurrenceId)).size, 2);
  assert.deepEqual([...new Set(aliases.map(a => a.canonicalId))], [f.anchorOccurrences.canonicalId]);
});

test('attribution pending and independent ready generation never relabel an old map', () => {
  const [pending, ready] = f.attributionPages;
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.items, []);
  assert.equal(pending.nextCursor, null);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.sourceRevision, pending.sourceRevision);
  assert.notEqual(ready.attributionGeneration, pending.attributionGeneration);
  for (const p of f.attributionPages) {
    assert.equal(p.attributions, undefined);
    assert.ok(wireBytes({ jsonrpc: '2.0', id: 1, result: p }) <= f.limits.wireBytes);
  }
  const s = f.commentSummaryPage;
  assert.equal(s.items[0].comments, undefined);
  assert.equal(s.items[0].replies, undefined);
  assert.ok(s.totalThreads > s.items.length);
  assert.ok(s.nextCursor); // this is a partial page, not false exhaustion
  assert.ok(wireBytes(s) < 4096);
});

test('atomic outcome goldens prohibit partial source/index/history/receipt publication', () => {
  const c = f.atomicStates;
  assert.deepEqual(Object.keys(c.before).sort(), [...c.fields].sort());
  assert.deepEqual(Object.keys(c.after).sort(), [...c.fields].sort());
  const validate = (scenario, actual) => assert.deepEqual(actual, c[scenario.expect]);
  for (const scenario of c.scenarios) {
    validate(scenario, c[scenario.expect]);
    const opposite = scenario.expect === 'before' ? c.after : c.before;
    for (const field of c.fields) {
      assert.throws(() => validate(scenario, { ...c[scenario.expect], [field]: opposite[field] }));
    }
  }
  // These are required observable states for component fault-injection tests,
  // not evidence that a real transaction has been executed by this suite.
});

test('page validator detects changed bytes, false exhaustion, excess budget and partial Note shape', () => {
  const p = frame('same', 0, 4, 9);
  assertSourcePage('same same', p, f.limits);
  for (const patch of [{ text: 'SAME' }, { nextCursor: null }, { previousCursor: 'wrong' },
    { sourceLength: 8 }, { content: 'same' }, { note: { content: 'same' } }, { range: { start: 0, end: 5 } }]) {
    assert.throws(() => assertSourcePage('same same', { ...p, result: { ...p.result, ...patch } }, f.limits));
  }
  assert.throws(() => assertSourcePage('same same', p, { sourceBytes: 3, wireBytes: 65536 }));
});
