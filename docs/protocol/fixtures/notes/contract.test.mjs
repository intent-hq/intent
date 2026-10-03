import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  utf8, wireBytes, digest, boundary, spliceError, applySourceSplices, mapPoint,
  assertSourcePage, cursorError, overlapIds, assertRanges, assertOperationTrace,
  admitState, assertStream, frozenSource, assertUnchangedGaps,
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
  contextRef: 'opaque-context', metadataRef: 'opaque-metadata',
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

test('distant canonical effects have explicit footprints without widening caller edits', () => {
  const c = f.sideEffects;
  assert.equal(applySourceSplices(c.base, c.caller), c.callerResult);
  assertUnchangedGaps(c.base, c.callerResult, c.caller);
  let source = c.callerResult, state = 'callerResult';
  for (const phase of c.phases) {
    assert.equal(phase.inputState, state);
    assert.ok(['task-conversion', 'phantom-scrub'].includes(phase.reason));
    assert.equal(spliceError(source, phase.splices, f.limits), null);
    assert.equal(applySourceSplices(source, phase.splices), phase.expect);
    assertUnchangedGaps(source, phase.expect, phase.splices);
    source = phase.expect; state = phase.outputState;
  }
  assert.equal(source, c.expect);
  assert.ok(source.includes(`anchor:${c.liveMarkerId}:start`));
  assert.ok(source.includes('<!--anchor:demo:start-->literal'));
  assert.ok(source.includes(c.canonicalChildId));
  assert.ok(!source.includes('@@@task'));
  assert.throws(() => assertUnchangedGaps(c.base, c.expect, c.caller));
  // Recoverable conversion failure retains the caller edit and creates no child.
  assert.ok(c.callerResult.includes('@@@task'));
  assert.ok(!c.callerResult.includes('task-1'));
});

test('crossed note/comment channels cannot regress shared authoritative epochs', () => {
  let state;
  for (const [i, frame] of f.crossedChannels.frames.entries()) {
    state = admitState(state, frame.state);
    assert.equal(state.stateGeneration, f.crossedChannels.expectedGenerations[i]);
  }
  assert.deepEqual(state, f.crossedChannels.expected);
  assert.deepEqual(admitState(state, structuredClone(state)), state);
  assert.throws(() => admitState(state, { ...state, sourceRevision: 'r:wrong' }));
  assert.equal(admitState(state, { ...state, scope: { ...state.scope, noteId: 'other' }, stateGeneration: '99' }), state);
  assert.throws(() => admitState(state, { ...state, stateGeneration: '18446744073709551616' }));
});

test('staged header and sealed manifest bind stable identity and all five streams', () => {
  const c = f.staged;
  assert.equal(digest(c.begin), c.headerDigest);
  assert.equal(digest({ headerDigest: c.headerDigest, manifest: c.manifest }), c.payloadDigest);
  assert.deepEqual(c.manifest.map(m => m.stream), ['text', 'dirty', 'selection', 'mutation', 'live']);
  for (const m of c.manifest) assertStream(c.streams[m.stream], m, f.limits);
  for (const method of ['begin', 'append', 'seal', 'read', 'commit', 'cancel']) assert.ok(docs.includes(`| note.operation.${method} |`));
  assert.ok(events.includes('stateGeneration'));
  const reordered = [...c.manifest].reverse();
  assert.notEqual(digest({ headerDigest: c.headerDigest, manifest: reordered }), c.payloadDigest);
  for (const key of ['localEditSequence', 'liveGeneration', 'selectionGeneration', 'editorSessionId']) {
    assert.notEqual(digest({ ...c.begin, header: { ...c.begin.header, [key]: 'other' } }), c.headerDigest);
  }
});

test('staged text is contiguous and exact beyond an inline request budget', () => {
  const c = f.staged;
  const texts = {};
  for (const chunk of c.streams.text) for (const r of chunk.records) {
    assert.equal(r.offset, (texts[r.id] ?? '').length);
    texts[r.id] = (texts[r.id] ?? '') + r.text;
  }
  for (const name of ['dirty', 'mutation']) for (const chunk of c.streams[name]) for (const r of chunk.records) {
    const ref = r.replacement, value = texts[ref.textId];
    assert.equal(value.length, ref.length);
    assert.equal(utf8(value), ref.utf8Bytes);
    assert.equal(createHash('sha256').update(value, 'utf8').digest('hex'), ref.sha256);
  }
  const frozen = frozenSource(c.base, c.dirtyGroups, c.begin.header.localEditSequence, texts, f.limits);
  assert.equal(frozen, c.frozen);
  const mutation = c.streams.mutation[0].records.map(r => ({ ...r, text: texts[r.replacement.textId] }));
  assert.equal(spliceError(frozen, mutation, f.limits), 'note-page-budget');
  const final = applySourceSplices(frozen, mutation);
  assert.equal(final, c.expectedResultPrefix + texts.paste);
  assert.ok(utf8(texts.paste) > f.limits.sourceBytes);
  // Undo the newest gesture only; earlier dirty history groups remain visible.
  const inverse = c.inverse.map(r => ({ ...r, text: c.inverseText }));
  assert.equal(applySourceSplices(final, inverse), c.frozen);
  assert.equal(applySourceSplices(c.frozen, [{ start: 4, end: 7, text: 'two' }]), 'ONE two');
  assert.equal(applySourceSplices('ONE two', [{ start: 0, end: 3, text: 'one' }]), c.base);
});

test('staged gaps, reordered chunks, corrupt hashes and mismatched totals fail closed', () => {
  const c = f.staged, manifest = c.manifest[0];
  for (const mutate of [
    chunks => chunks.splice(1, 1),
    chunks => chunks.reverse(),
    chunks => { chunks[1].previousDigest = '0'.repeat(64); },
    chunks => { chunks[0].records[0].text = 'CORRUPTED'; },
    chunks => { chunks[0].sequence = 1; },
  ]) {
    const chunks = structuredClone(c.streams.text); mutate(chunks);
    assert.throws(() => assertStream(chunks, manifest, f.limits));
  }
  assert.throws(() => assertStream(c.streams.text, { ...manifest, records: manifest.records + 1 }, f.limits));
  // Exact chunk retransmission matches its ack; a different payload cannot.
  const first = c.streams.text[0];
  assert.deepEqual(structuredClone(first), first);
  assert.notEqual(digest({ ...first, records: [] }), first.chunkDigest);
});

test('frozen staged input rejects later edits, split scalars and overlapping groups', () => {
  const c = f.staged, texts = { prefix: 'ONE', second: 'TWO' };
  assert.throws(() => frozenSource(c.base, [...c.dirtyGroups, { localSequence: 3, splices: [] }], 2, texts, f.limits));
  assert.throws(() => frozenSource(c.base, [...c.dirtyGroups].reverse(), 2, texts, f.limits));
  assert.throws(() => frozenSource('A😀B', [{ localSequence: 1, splices: [{ start: 2, end: 3, textId: 'prefix' }] }], 2, texts, f.limits));
  assert.throws(() => frozenSource(c.base, [{ localSequence: 1, splices: [{ start: 0, end: 5, textId: 'prefix' }, { start: 4, end: 7, textId: 'second' }] }], 2, texts, f.limits));
});

for (const c of f.stagedOutcomes) test(`staged lifecycle specification: ${c.id}`, () => {
  const index = name => c.order.indexOf(name);
  const cancelFirst = index('cancel') >= 0 && (index('admit') < 0 || index('cancel') < index('admit'));
  const expiredFirst = index('expire') >= 0 && index('admit') < 0;
  const committed = index('commit') >= 0 && index('admit') >= 0 && !cancelFirst && !expiredFirst && index('remoteWrite') < 0;
  assert.equal(c.sourceWrites, committed ? 1 : 0);
  assert.equal(c.historyGroups, committed ? 1 : 0); // final gesture, not captured-prefix groups
  const unknown = c.order.at(-1) === 'lostAck';
  assert.equal(c.clearDraft, committed && !unknown);
  if (cancelFirst) assert.equal(c.outcome, 'cancelled');
  if (expiredFirst) assert.equal(c.outcome, 'expired');
  if (unknown) assert.equal(c.outcome, 'unknown');
  if (index('remoteWrite') >= 0) assert.equal(c.outcome, index('commit') >= 0 ? 'conflict' : 'readComplete');
  if (c.order.at(-1) === 'cancel' && index('admit') >= 0 && index('commit') < 0) assert.equal(c.outcome, 'pending');
});

test('work-limited search pages progress without false exact counts or false exhaustion', () => {
  let scanned = 0, seen = 0;
  for (const [index, page] of f.searchPages.entries()) {
    assert.ok(page.scannedThrough > scanned);
    scanned = page.scannedThrough;
    seen += page.items.length;
    assert.equal(page.count.value, seen);
    assert.equal(page.count.exact, index === f.searchPages.length - 1);
    assert.equal(page.nextCursor === null, page.count.exact);
  }
  assert.equal(scanned, 5000);
  assert.equal(seen, 1);
});

test('metadata title/tags and live details use separately paged values and children', () => {
  for (const page of f.metadataPages) {
    assert.equal(page.kind, 'noteMetadataPage');
    assert.ok(page.items.length <= f.limits.items);
    assert.ok(wireBytes(page) <= f.limits.wireBytes);
    for (const item of page.items) {
      assert.equal(item.value, undefined);
      if (item.type === 'string') assert.ok(item.valueRef);
      else assert.ok(item.childrenRef);
    }
  }
  assert.ok(docs.includes('metadataRef: string'));
  assert.ok(docs.includes('parentOrdinal'));
  assert.ok(docs.includes('delta'));
});

test('late page replies cannot overwrite newer state admitted from another channel', () => {
  const state = f.crossedChannels.expected;
  const claim = { ...f.cursorClaim, commentRevision: 'c:4' };
  assert.equal(cursorError(claim, claim, { ...state, boot: 'boot-a' }, 1000), 'note-page-stale');
  const oldSource = { ...f.cursorClaim, sourceRevision: 'r:6' };
  assert.equal(cursorError(oldSource, oldSource, { ...state, boot: 'boot-a' }, 1000), 'note-page-stale');
  assert.equal(state.commentRevision, 'c:5');
});

test('receipt-owned inverse text addressing outlives staging without crossing owners', () => {
  const receipt = { scope: f.scope, operationId: f.staged.begin.operationId,
    inverseRef: 'inverse-a', textIds: ['inverse-paste'], stagingExpiresAt: 1000, receiptExpiresAt: 7000 };
  const read = { ...receipt.scope, operationId: receipt.operationId, kind: 'inverseText', ref: 'inverse-a', textId: 'inverse-paste', offset: 0 };
  const valid = (r, now) => now < receipt.receiptExpiresAt && r.operationId === receipt.operationId
    && Object.keys(receipt.scope).every(k => r[k] === receipt.scope[k])
    && r.kind === 'inverseText' && r.ref === receipt.inverseRef && receipt.textIds.includes(r.textId)
    && boundary(f.staged.inverseText, r.offset);
  assert.equal(valid(read, 2000), true);
  assert.equal(valid(read, 7000), false);
  for (const patch of [{ operationId: 'another' }, { noteId: 'another' }, { ref: 'another' },
    { textId: 'another' }, { kind: 'source' }, { offset: 4 }]) assert.equal(valid({ ...read, ...patch }, 2000), false);
  assert.ok(docs.includes('Receipt-owned reads do not require a still-live staged view'));
});
