import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  utf8, wireBytes, digest, boundary, spliceError, applySourceSplices, mapPoint,
  assertSourcePage, cursorError, overlapIds, assertRanges, assertOperationTrace,
  admitState, assertStream, frozenSource, assertUnchangedGaps,
  assertAppendFrame, assertMetadataFrame, assertReplyFrames, assertPageStateFrame,
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
  assert.deepEqual(c.pages.flatMap(p => p.result.items.map(r => r.commentId)), ['reply-1', 'reply-2', 'root']);
  assert.equal(c.pages.at(-1).result.nextCursor, null);
  assert.equal(c.fragments.map(p => p.text).join(''), c.expectedBody);
  assert.ok(c.fragments.every(p => utf8(p.text) <= f.limits.sourceBytes));
  for (const event of c.events) {
    assert.ok(wireBytes(event) <= f.limits.receiptBytes);
    assert.equal(event.params.snapshot.invalidation, 'all');
    for (const field of ['content', 'note', 'attributions', 'threads', 'comments']) assert.equal(event.params.snapshot[field], undefined);
  }
  const states = c.events.map(e => e.params.snapshot);
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
  // The caller-only intermediate still contains the unconverted task fence.
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
  for (const m of c.manifest) assertStream(c.streams[m.stream], m, f.limits, c.appendFrames[m.stream]);
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
    assert.throws(() => assertStream(chunks, manifest, f.limits, chunks.map(appendFrame)));
  }
  assert.throws(() => assertStream(c.streams.text, { ...manifest, records: manifest.records + 1 }, f.limits, c.streams.text.map(appendFrame)));
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

// Independent review regressions: assertions first recorded against a27af5ff.
test('review F1: recoverable conversion failure keeps completed canonical cleanup', () => {
  assert.doesNotMatch(docs, /retains callerResult with the legacy no-conversion outcome/);
  const c = f.conversionFailure;
  assert.ok(c, 'combined cleanup/conversion-failure scenario is required');
  let source = applySourceSplices(c.base, c.caller);
  assert.equal(source, c.callerResult);
  for (const phase of c.preConversionEffects) {
    assertUnchangedGaps(source, phase.expect, phase.splices);
    source = applySourceSplices(source, phase.splices);
    assert.equal(source, phase.expect);
  }
  assert.equal(source, c.preConversionCanonical);
  assert.equal(c.final, source);
  assert.ok(c.final.includes('@@@task'));
  assert.ok(!c.final.includes(c.phantomId));
  assert.ok(c.final.includes(`anchor:${c.liveMarkerId}:end`));
  assert.deepEqual(c.committedEffects, c.preConversionEffects);
  assert.equal(c.createdChildren, 0);
  assert.equal(c.conversionSnapshots, 0);
  assert.deepEqual(c.epochs.before, { sourceRevision: 'r:7', attributionGeneration: 'a:2', commentRevision: 'c:4', stateGeneration: '10' });
  assert.deepEqual(c.epochs.after, { sourceRevision: 'r:8', attributionGeneration: 'a:3', commentRevision: 'c:5', stateGeneration: '11' });
  assert.deepEqual(c.versionSnapshots, [c.preConversionCanonical]);
  assertOperationTrace(c.trace);
});

test('review F2: equal-time replies are ordered by canonical ID across pages', () => {
  const rows = f.annotationPages.pages.flatMap(p => p.result.items);
  const keys = rows.map(r => `${r.createdAt}\0${r.commentId}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('review F2: reply summaries include status', () => {
  for (const row of f.annotationPages.pages.flatMap(p => p.result.items)) {
    assert.ok(['open', 'resolved'].includes(row.status));
  }
});

test('review F2: metadata pages carry their source snapshot identity', () => {
  for (const p of f.metadataPages) {
    assert.deepEqual(p.scope, f.scope);
    assert.equal(p.sourceRevision, 'r:7');
    assert.equal(p.snapshotId, 'snapshot-a');
    assert.equal(p.expiresAt, '2026-10-03T00:05:00.000Z');
  }
});

test('review F2: pageState uses the subscription snapshot envelope', () => {
  for (const e of f.annotationPages.events) {
    assert.equal(e.params.kind, 'snapshot');
    assert.equal(e.params.snapshot.kind, 'notePageState');
    assert.equal(e.params.payload, undefined);
  }
});

test('review F3: backward exhaustion at zero is a valid empty page', () => {
  assertSourcePage('abc', frame('', 0, 0, 3), f.limits, { direction: 'backward', at: 0 });
  assert.throws(() => assertSourcePage('abc', frame('', 1, 1, 3), f.limits, { direction: 'backward', at: 1 }));
  assert.throws(() => assertSourcePage('abc', frame('', 0, 0, 3), f.limits, { direction: 'forward', at: 0 }));
});

test('review F3: JSON member order does not change scope identity', () => {
  const current = f.crossedChannels.expected;
  const incoming = { ...current, scope: Object.fromEntries(Object.entries(current.scope).reverse()), stateGeneration: '13' };
  assert.equal(admitState(current, incoming), incoming);
});

const appendFrame = chunk => ({ jsonrpc: '2.0', id: 1, method: 'note.operation.append', params: {
  ...f.scope, operationId: f.staged.begin.operationId, headerDigest: f.staged.headerDigest, ...chunk,
} });
const textChunk = text => {
  const payload = { stream: 'text', sequence: 0, previousDigest: null, records: [{ kind: 'text', id: 'text', offset: 0, text }] };
  return { ...payload, chunkDigest: digest(payload) };
};
const singleManifest = chunk => ({ stream: 'text', chunks: 1, records: 1, lastDigest: chunk.chunkDigest });

test('review F3: escaped append payload fitting alone cannot overflow its RPC', () => {
  let chunk = textChunk('');
  const count = Math.floor((f.limits.wireBytes - wireBytes(chunk)) / 6);
  chunk = textChunk('\u0001'.repeat(count));
  assert.ok(utf8(chunk.records[0].text) < f.limits.sourceBytes);
  assert.ok(wireBytes(chunk) <= f.limits.wireBytes);
  assert.ok(wireBytes(appendFrame(chunk)) > f.limits.wireBytes);
  assert.throws(() => assertStream([chunk], singleManifest(chunk), f.limits, [appendFrame(chunk)]));
});

test('review F2: full wire validators reject missing page identity and reply fields', () => {
  assertReplyFrames(f.annotationPages.pages, f.limits);
  for (const page of f.metadataPages) assertMetadataFrame({ jsonrpc: '2.0', id: 1, result: page }, f.limits);
  for (const field of ['scope', 'sourceRevision', 'snapshotId', 'expiresAt', 'items', 'nextCursor']) {
    const bad = structuredClone(f.metadataPages[0]); delete bad[field];
    assert.throws(() => assertMetadataFrame({ jsonrpc: '2.0', id: 1, result: bad }, f.limits), field);
    const replies = structuredClone(f.annotationPages.pages); delete replies[0].result[field];
    assert.throws(() => assertReplyFrames(replies, f.limits), field);
  }
  for (const field of ['status', 'commentId', 'createdAt', 'preview', 'truncated', 'bodyRef', 'detailRef']) {
    const bad = structuredClone(f.annotationPages.pages); delete bad[0].result.items[0][field];
    assert.throws(() => assertReplyFrames(bad, f.limits), field);
  }
  const wrongOrder = structuredClone(f.annotationPages.pages);
  [wrongOrder[0].result.items[0], wrongOrder[1].result.items[0]] =
    [wrongOrder[1].result.items[0], wrongOrder[0].result.items[0]];
  assert.throws(() => assertReplyFrames(wrongOrder, f.limits));
  const mixedSnapshot = structuredClone(f.annotationPages.pages);
  mixedSnapshot[1].result.commentRevision = 'c:5';
  assert.throws(() => assertReplyFrames(mixedSnapshot, f.limits));
});

test('review F2: concrete event frame matches docs and rejects ambiguous containers', () => {
  for (const e of f.annotationPages.events) assertPageStateFrame(e, f.limits);
  const documented = events.split('\n').find(line => line.startsWith('{"jsonrpc":"2.0","method":"subscription.push"'));
  assert.deepEqual(JSON.parse(documented), f.annotationPages.events[0]);
  for (const mutate of [
    e => { delete e.params.kind; },
    e => { e.params.kind = 'delta'; },
    e => { e.params.payload = e.params.snapshot; delete e.params.snapshot; },
    e => { e.params.snapshot = [e.params.snapshot]; },
    e => { delete e.params.snapshot.attributionState; },
    e => { e.params.snapshot.comments = []; },
    e => { e.params.snapshot.scope = {}; },
  ]) {
    const bad = structuredClone(f.annotationPages.events[0]); mutate(bad);
    assert.throws(() => assertPageStateFrame(bad, f.limits));
  }
});

test('review F3: complete escaped append RPC fits exactly and rejects one-byte overflow', () => {
  // Maximum legal RPC ID and all four scope IDs, with multibyte source and escaping.
  const wrap = chunk => {
    const request = appendFrame(chunk);
    request.id = 'i'.repeat(64);
    for (const key of Object.keys(f.scope)) request.params[key] = 's'.repeat(256);
    return request;
  };
  const base = '😀中\\"';
  const available = f.limits.wireBytes - wireBytes(wrap(textChunk(base)));
  const text = base + '\u0001'.repeat(Math.floor(available / 6)) + 'a'.repeat(available % 6);
  const chunk = textChunk(text), request = wrap(chunk);
  assert.equal(wireBytes(request), 65536);
  assert.ok(utf8(text) < 16384);
  assertStream([chunk], singleManifest(chunk), f.limits, [request]);
  const overflow = textChunk(text + 'a');
  assert.equal(wireBytes(wrap(overflow)), 65537);
  assert.throws(() => assertStream([overflow], singleManifest(overflow), f.limits, [wrap(overflow)]));
  assert.throws(() => assertStream([chunk], singleManifest(chunk), f.limits));
  assert.throws(() => assertStream([chunk], singleManifest(chunk), f.limits, []));
  for (const mutate of [
    r => { r.id += 'x'; },
    r => { r.params.noteId += 'x'; },
    r => { r.method = 'other'; },
    r => { delete r.params.headerDigest; },
    r => { r.params.records[0].text = '\ud800'; },
  ]) {
    const bad = structuredClone(request); mutate(bad);
    assert.throws(() => assertAppendFrame(bad, f.limits));
  }
});

test('review F1: cleanup history, orphan state and final receipt survive only conversion rollback', () => {
  const c = f.conversionFailure;
  assert.equal(c.savepointAfter, 'preConversionCanonical');
  assert.deepEqual(c.rolledBack, ['conversion-source', 'conversion-children', 'conversion-version', 'conversion-effects']);
  assert.equal(c.commentsBefore[1].isOrphaned, false);
  assert.equal(c.commentsAfter[1].isOrphaned, true);
  const first = c.trace.steps[0], replay = c.trace.steps.at(-1);
  assert.equal(first.receipt.sourceLength, c.final.length);
  assert.equal(first.receipt.afterRevision, c.epochs.after.sourceRevision);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(replay.historyCount, 0);
  assert.equal(replay.writeCount, 0);
  assert.equal(replay.eventCount, 0);
  assert.equal(c.trace.steps[1].outcome, 'unknown');
  assert.equal(c.trace.steps[1].clearDraft, false);
  assert.ok(wireBytes({ jsonrpc: '2.0', id: 1, result: first.receipt }) <= f.limits.receiptBytes);
});

test('deleted root is explicit on every reply page without changing thread identity', () => {
  for (const page of f.annotationPages.pages) assert.equal(page.result.rootState, 'present');
  const c = f.deletedRoot;
  assert.ok(c, 'root deletion with surviving replies requires wire fixtures');
  assertReplyFrames(c.pages, f.limits, { complete: true });
  for (const page of c.pages) {
    assert.equal(page.result.rootCommentId, 'root');
    assert.equal(page.result.threadId, 'root');
    assert.equal(page.result.rootState, 'deleted');
    assert.equal(page.result.totalComments, 2);
    assert.equal(page.result.commentRevision, 'c:5');
    assert.deepEqual(page.result.scope, f.scope);
    assert.ok(!page.result.items.some(row => row.commentId === 'root'));
  }
  assert.deepEqual(c.pages.flatMap(page => page.result.items.map(row => row.commentId)), ['reply-1', 'reply-2']);
  assert.ok(c.pages[0].result.nextCursor);
  assert.equal(c.pages.at(-1).result.nextCursor, null);
});

test('root deletion invalidates old annotation snapshots without invalidating unchanged source', () => {
  const c = f.deletedRoot;
  assert.ok(c, 'root deletion epoch scenario is required');
  assert.equal(cursorError(c.oldReplyCursor, c.oldReplyCursor, c.afterRootDelete, 1000), 'note-page-stale');
  assert.equal(cursorError(f.cursorClaim, f.cursorClaim, c.afterRootDelete, 1000), null);
  assert.equal(c.cachedBeforeDelete.result.commentRevision, 'c:4');
  assert.notEqual(c.cachedBeforeDelete.result.commentRevision, c.afterRootDelete.commentRevision);
  assert.equal(c.cachedBeforeDelete.result.sourceRevision, c.afterRootDelete.sourceRevision);
  assertPageStateFrame(c.notification, f.limits);
  const admitted = admitState(f.annotationPages.events[0].params.snapshot, c.notification.params.snapshot);
  assert.equal(admitted.commentRevision, c.afterRootDelete.commentRevision);
  assert.equal(admitted.sourceRevision, c.afterRootDelete.sourceRevision);
  assert.equal(admitted.attributionGeneration, c.afterRootDelete.attributionGeneration);
  assert.equal(c.acceptLateOldPage, c.cachedBeforeDelete.result.commentRevision === admitted.commentRevision);
  assert.equal(c.retainedFrozenSource.before, c.retainedFrozenSource.after);
  assert.equal(c.retainedFrozenSource.commentRevision, undefined);
});

test('rootless exhaustion, reply deletion and missing thread have distinct outcomes', () => {
  const c = f.deletedRoot;
  assert.ok(c, 'rootless lifecycle is required');
  assertReplyFrames([c.exhausted], f.limits);
  assert.deepEqual(c.exhausted.result.items, []);
  assert.equal(c.exhausted.result.totalComments, 2);
  assert.equal(c.exhausted.result.rootState, 'deleted');
  assertReplyFrames(c.afterReplyDelete, f.limits, { complete: true });
  assert.equal(c.afterReplyDelete[0].result.totalComments, 1);
  assert.equal(c.afterReplyDelete[0].result.items[0].commentId, 'reply-2');
  assert.equal(cursorError(c.survivorCursor, c.survivorCursor, c.afterFinalDelete, 1000), 'note-page-stale');
  assert.equal(c.missingThread.result, undefined);
  assert.equal(c.missingThread.error.code, -32602);
  assert.equal(c.missingThread.error.data.code, 'not-found');
  assert.equal(c.missingThread.error.data.entity, 'commentThread');
  assert.ok(wireBytes(c.missingThread) <= f.limits.receiptBytes);
  assert.equal(c.summary.result.totalThreads, 1);
  assert.equal(c.summary.result.totalComments, 2);
  assert.equal(c.summary.result.items[0].anchorRef, null);
  assert.equal(c.summary.result.items[0].rootState, 'deleted');
});

test('deleted-root cursor keeps thread binding and rejects expiry, foreign scope and source changes', () => {
  const claim = { ...f.deletedRoot.oldReplyCursor, commentRevision: 'c:5' };
  assert.equal(cursorError(claim, claim, f.deletedRoot.afterRootDelete, 1000), null);
  assert.equal(cursorError(claim, { ...claim, threadId: 'another-thread' }, f.deletedRoot.afterRootDelete, 1000), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, { ...claim, noteId: 'another-note' }, f.deletedRoot.afterRootDelete, 1000), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, claim, f.deletedRoot.afterRootDelete, claim.expiresAt), 'note-page-expired');
  assert.equal(cursorError(claim, claim, { ...f.deletedRoot.afterRootDelete, sourceRevision: 'r:8' }, 1000), 'note-page-stale');
});

test('deleted-root wire rejects fake roots, mixed headers, missing state and inflated counts', () => {
  assertReplyFrames(f.annotationPages.pages, f.limits, { complete: true });
  const survivors = f.annotationPages.pages.flatMap(p => p.result.items).filter(row => row.commentId !== 'root');
  assert.deepEqual(f.deletedRoot.pages.flatMap(p => p.result.items), survivors);
  for (const mutate of [
    p => { delete p[0].result.rootState; },
    p => { p[0].result.items[0].commentId = 'root'; },
    p => { p[1].result.rootState = 'present'; },
    p => { for (const frame of p) frame.result.rootState = 'present'; },
    p => { for (const frame of p) frame.result.totalComments = 3; },
    p => { p[1].result.items = []; },
    p => { p[0].result.totalComments = 0; },
    p => { p[1].result.rootCommentId = 'reply-1'; },
  ]) {
    const bad = structuredClone(f.deletedRoot.pages); mutate(bad);
    assert.throws(() => assertReplyFrames(bad, f.limits, { complete: true }));
  }
  const exhausted = structuredClone(f.deletedRoot.exhausted);
  exhausted.result.totalComments = 0;
  assert.throws(() => assertReplyFrames([exhausted], f.limits));
  const summary = f.deletedRoot.summary;
  assert.ok(wireBytes(summary) <= f.limits.wireBytes);
  assert.deepEqual(summary.result.scope, f.scope);
  assert.equal(summary.result.commentRevision, 'c:5');
  assert.equal(summary.result.items[0].latestCommentId, survivors.at(-1).commentId);
  assert.ok(docs.includes('Legacy unpaged lookup errors'));
  assert.ok(errors.includes('data.entity'));
});


// Review regressions: accepted/rejected are existing CommentStatus values.
for (const status of ['open', 'resolved', 'pending', 'accepted', 'rejected']) {
  test(`reply pages preserve existing ${status} status`, () => {
    const frames = structuredClone(f.deletedRoot.pages);
    for (const page of frames) for (const item of page.result.items) item.status = status;
    assertReplyFrames(frames, f.limits, { complete: true });
  });
}
test('reply pages reject an unknown status', () => {
  const frames = structuredClone(f.deletedRoot.pages);
  frames[0].result.items[0].status = 'approved';
  assert.throws(() => assertReplyFrames(frames, f.limits));
});

const summaryContract = await import('./contract.mjs');
test('ordered summary wire contract exists without full Note hydration', () => {
  assert.equal(typeof summaryContract.assertTaskIdFrames, 'function');
  assert.equal(typeof summaryContract.assertTextFragments, 'function');
  assert.equal(typeof summaryContract.pagingBackendId, 'function');
});
test('ordered summary retains the existing lexical first-occurrence oracle', () => {
  const x = f.orderedTaskIds;
  // Intentionally the literal existing FE oracle, independent of fixture validator.
  const matches = [...x.source.matchAll(/\[([^\]]+)\]\(intent:\/\/local\/task\/([^)]+)\)/g)];
  assert.deepEqual([...new Set(matches.map(m => m[2]))], x.expected);
  assert.deepEqual(summaryContract.assertTaskIdFrames(x.source, x.pages, f.limits), x.expected);
  assert.equal(x.pages.flatMap(p => p.result.items).length, 8);
  assert.ok(x.source.includes('\r\n'));
  assert.equal(x.pages.at(-1).result.items.at(-1).taskNoteId, undefined);
  const text = summaryContract.assertTextFragments(x.longIdFragments, 'taskNoteId', f.limits);
  assert.equal(text, x.expected.at(-1));
  assert.ok(utf8(text) > 256);
});
test('ordered summary is independent of arbitrary source-page splits', () => {
  const x = f.orderedTaskIds;
  for (let i = 0; i <= x.source.length; i++) {
    if (!boundary(x.source, i)) continue;
    // Reassembly oracle includes a match crossing every legal split; a producer
    // needs an index, not independent regex matches over each transported page.
    assert.deepEqual(summaryContract.assertTaskIdFrames(x.source.slice(0, i) + x.source.slice(i),
      x.pages, f.limits), x.expected);
  }
});
test('task summary validator rejects order, dedup, range, identity and count corruption', () => {
  const x = f.orderedTaskIds;
  for (const corrupt of [
    p => { p[0].result.items.reverse(); },
    p => { p[1].result.items[0] = p[0].result.items[0]; },
    p => { p[0].result.items[0].sourceRange.start++; },
    p => { p[1].result.sourceRevision = 'r:8'; },
    p => { p[1].result.scope.noteId = 'other'; },
    p => { p[1].result.startIndex++; },
    p => { p[1].result.totalItems++; },
    p => { p[0].result.nextCursor = null; },
    p => { p[0].result.items[0].taskNoteId = 'FIRST'; },
    p => { p[0].result.items[0].taskNoteIdRef = 'duplicate-arm'; },
    p => { const r = p.at(-1).result.items.at(-1); r.taskNoteId = x.expected.at(-1); delete r.taskNoteIdRef; },
    p => { p.at(-1).result.items.at(-1).taskNoteIdLength--; },
  ]) {
    const pages = structuredClone(x.pages); corrupt(pages);
    assert.throws(() => summaryContract.assertTaskIdFrames(x.source, pages, f.limits));
  }
});
test('ordered summary supports empty and exhausted pages and rejects nonadvancing traversal', () => {
  const x = f.orderedTaskIds;
  assert.deepEqual(summaryContract.assertTaskIdFrames('', [x.empty], f.limits), []);
  assert.deepEqual(summaryContract.assertTaskIdFrames(x.source, [x.exhausted], f.limits,
    { startIndex: 8 }), []);
  const invalid = structuredClone(x.exhausted); invalid.result.startIndex = 7;
  assert.throws(() => summaryContract.assertTaskIdFrames(x.source, [invalid], f.limits, { startIndex: 7 }));
});
test('summary fragments retain exact UTF16 offsets and reject mixed revisions/gaps/oversize', () => {
  const x = f.orderedTaskIds;
  for (const corrupt of [
    p => { p[1].result.items[0].offset--; },
    p => { p[1].result.sourceRevision = 'r:8'; },
    p => { p[1].result.items[0].field = 'title'; },
    p => { p[0].result.items[0].nextRef = null; },
    p => { p[0].result.items[0].text = 'x'.repeat(16385); },
  ]) {
    const pages = structuredClone(x.longIdFragments); corrupt(pages);
    assert.throws(() => summaryContract.assertTextFragments(pages, 'taskNoteId', f.limits));
  }
});
test('summary cursor binds kind, scope, budgets, live revision and expiration', () => {
  const base = { ...f.scope, principalId: 'p', kind: 'taskIds', budgets: { maxItems: 2 },
    sourceRevision: 'r:7', boot: 'boot-a', expiresAt: 100 };
  assert.equal(cursorError(base, base, base, 1), null);
  for (const changed of [{ kind: 'source' }, { noteId: 'other' }, { workspaceId: 'other' },
    { principalId: 'other' }, { budgets: { maxItems: 3 } }]) {
    assert.equal(cursorError(base, { ...base, ...changed }, base, 1), 'note-page-cursor-invalid');
  }
  assert.equal(cursorError(base, base, { ...base, sourceRevision: 'r:8' }, 1), 'note-page-stale');
  assert.equal(cursorError(base, base, { ...base, commentRevision: 'c:2' }, 1), null);
  assert.equal(cursorError(base, base, base, 100), 'note-page-expired');
});
test('summary frame budget measures full escaping at exact fit and one-byte overflow', () => {
  const source = `[x](intent://local/task/${'\u0001'.repeat(220)})`;
  const row = { index: 0, sourceRange: { start: 24, end: 244 }, taskNoteIdLength: 220,
    taskNoteId: '\u0001'.repeat(220) };
  const page = structuredClone(f.orderedTaskIds.empty);
  page.result.totalItems = 1; page.result.items = [row];
  row.sourceRange.start = source.indexOf('\u0001'); row.sourceRange.end = source.lastIndexOf('\u0001') + 1;
  const size = wireBytes(page);
  assert.ok(size > utf8(source));
  assert.doesNotThrow(() => summaryContract.assertTaskIdFrames(source, [page], { ...f.limits, wireBytes: size }));
  assert.throws(() => summaryContract.assertTaskIdFrames(source, [page], { ...f.limits, wireBytes: size - 1 }));
});
test('hello requires the exact capability path, version and valid backend identity', () => {
  assert.equal(summaryContract.pagingBackendId(f.helloPaging), 'db-a');
  for (const caps of [{}, { notePaging: true, notePagingBackendId: 'db-a' },
    { notePaging: '1', notePagingBackendId: 'db-a' }, { notePaging: 2, notePagingBackendId: 'db-a' },
    { notePaging: 1 }, { notePaging: 1, notePagingBackendId: '' },
    { notePaging: 1, notePagingBackendId: 'x'.repeat(257) }]) {
    const hello = structuredClone(f.helloPaging); hello.result.server.capabilities = caps;
    hello.result.notePagingBackendId = 'wrong-place';
    assert.equal(summaryContract.pagingBackendId(hello), null);
  }
});

test('context uses explicit vocabulary and separately addressed field directories', () => {
  const x = f.contextWire;
  for (const value of [...x.constructs, ...x.roles]) assert.ok(docs.includes('`' + value + '`'));
  const descriptor = x.descriptor.result.items[0];
  assert.ok(x.constructs.includes(descriptor.construct));
  assert.equal(descriptor.detailRef, 'details-link');
  const fields = x.directory.result.items;
  assert.deepEqual(fields.map(f => f.field), Object.keys(x.fields));
  assert.ok(fields.every(f => f.kind === 'fragment' && f.offset === 0 && f.text === '' && f.nextRef));
  assert.ok(wireBytes(x.directory) <= f.limits.wireBytes);
  assert.ok(fields.length <= f.limits.items);
  for (const [field, resource] of Object.entries(x.fields)) {
    assert.equal(summaryContract.assertTextFragments(resource.pages, field, f.limits), resource.expected);
  }
  assert.equal(x.fields.title.pages[0].result.items[0].nextRef, null);
  assert.equal(x.fields.destination.pages[0].result.nextCursor, null);
  assert.notEqual(x.fields.destination.pages[0].result.items[0].nextRef, null);
});
test('nonempty field resource cannot use a zero-progress directory item as text', () => {
  assert.throws(() => summaryContract.assertTextFragments([f.contextWire.directory], 'openingSource', f.limits));
  const p = structuredClone(f.orderedTaskIds.longIdFragments);
  p[0].result.items[0].text = '\ud800';
  assert.throws(() => summaryContract.assertTextFragments(p, 'taskNoteId', f.limits));
});
test('task summary exact 65536-byte full frame and one-byte overflow with legal maximum identities', () => {
  const values = Array.from({ length: 90 }, (_, i) => '\u0001'.repeat(80) + i);
  const make = () => {
    let source = '';
    const items = values.map((value, index) => {
      const prefix = '[x](intent://local/task/';
      const start = source.length + prefix.length;
      source += prefix + value + ')\n';
      return { index, sourceRange: { start, end: start + value.length },
        taskNoteIdLength: value.length, taskNoteId: value };
    });
    const p = structuredClone(f.orderedTaskIds.empty);
    p.id = 'i'.repeat(64);
    for (const k of Object.keys(p.result.scope)) p.result.scope[k] = 's'.repeat(256);
    p.result.sourceRevision = 'r'.repeat(256); p.result.snapshotId = 'v'.repeat(256);
    p.result.totalItems = items.length; p.result.items = items;
    return { source, p };
  };
  let candidate = make();
  // Legal raw IDs remain <=256 decoded bytes. Fill one ASCII byte at a time;
  // this independent JSON.stringify oracle includes all header/address growth.
  for (let i = 0; wireBytes(candidate.p) < 65536 && i < 100000; i++) {
    const index = values.findIndex(v => utf8(v) < 256);
    assert.ok(index >= 0); values[index] += 'x'; candidate = make();
  }
  assert.equal(wireBytes(candidate.p), 65536);
  assert.doesNotThrow(() => summaryContract.assertTaskIdFrames(candidate.source, [candidate.p], f.limits));
  values[89] += 'x'; candidate = make();
  assert.equal(wireBytes(candidate.p), 65537);
  assert.throws(() => summaryContract.assertTaskIdFrames(candidate.source, [candidate.p], f.limits), /wire budget/);
});
test('full context frames validate identities, directories, fragments and opaque future grammar', () => {
  for (const page of f.contextPages) summaryContract.assertContextFrame({ jsonrpc: '2.0', id: 1, result: page }, f.limits);
  summaryContract.assertContextFrame(f.contextWire.descriptor, f.limits);
  summaryContract.assertContextFrame(f.contextWire.directory, f.limits, { directory: true });
  for (const resource of Object.values(f.contextWire.fields)) for (const page of resource.pages) {
    summaryContract.assertContextFrame(page, f.limits);
  }
  const future = structuredClone(f.contextWire.descriptor);
  future.result.items[0].construct = 'futureSyntax';
  assert.doesNotThrow(() => summaryContract.assertContextFrame(future, f.limits));
  assert.equal(f.contextWire.fields.openingSource.expected + 'label' + f.contextWire.fields.closingSource.expected,
    f.contextWire.source);
  assert.equal(f.contextWire.descriptor.result.items[0].sourceRange.end, f.contextWire.source.length);
});
test('context frames reject malformed directory, range, projection, oversized field and wire', () => {
  for (const corrupt of [
    p => { p.result.items[0].sourceRange.end = -1; },
    p => { p.result.items[0].kind = 'parserObject'; },
    p => { delete p.result.scope; },
    p => { p.result.items[0].continuationAfter = 1; },
    p => { Object.assign(p.result.items[0], { kind: 'span', role: 'projection' }); },
  ]) {
    const page = structuredClone(f.contextWire.descriptor); corrupt(page);
    assert.throws(() => summaryContract.assertContextFrame(page, f.limits));
  }
  const directory = structuredClone(f.contextWire.directory);
  directory.result.items[0].nextRef = null;
  assert.throws(() => summaryContract.assertContextFrame(directory, f.limits, { directory: true }));
  const field = structuredClone(f.contextWire.fields.destination.pages[0]);
  field.result.items[0].field = 'x'.repeat(1025);
  assert.throws(() => summaryContract.assertContextFrame(field, f.limits));
  assert.throws(() => summaryContract.assertContextFrame(f.contextWire.directory,
    { ...f.limits, wireBytes: wireBytes(f.contextWire.directory) - 1 }));
});

test('WikiLink details preserve explicit true and false hasPothole wire strings', () => {
  assert.ok(docs.includes('`WikiLink`'));
  assert.ok(docs.includes('`hasPothole`'));
  for (const x of f.contextWire.wikiLinks) {
    summaryContract.assertContextFrame(x.directory, f.limits, { directory: true });
    assert.deepEqual(x.directory.result.items.map(row => row.field),
      ['openingSource', 'closingSource', 'linkType', 'destination', 'title', 'referenceId', 'hasPothole']);
    const values = Object.fromEntries(Object.entries(x.fields).map(([key, resource]) => {
      for (const frame of resource.pages) summaryContract.assertContextFrame(frame, f.limits);
      const value = summaryContract.assertTextFragments(resource.pages, key, f.limits);
      assert.equal(value, resource.expected);
      return [key, value];
    }));
    summaryContract.assertLinkFields(values);
    assert.equal(values.openingSource + x.body + values.closingSource, x.source);
  }
});
test('link detail validator rejects Debug enum strings and misplaced or malformed WikiLink flags', () => {
  const base = { linkType: 'Inline', destination: '/target', title: '', referenceId: '' };
  assert.doesNotThrow(() => summaryContract.assertLinkFields(base));
  for (const patch of [{ linkType: 'WikiLink' }, { hasPothole: 'true' },
    { linkType: 'WikiLink', hasPothole: true }, { linkType: 'WikiLink', hasPothole: 'TRUE' },
    { linkType: 'WikiLink { has_pothole: true }' }]) {
    assert.throws(() => summaryContract.assertLinkFields({ ...base, ...patch }));
  }
});

// Specification source materialization is an oracle only, not a production reader.
const tableFixture = f.tablePositions;
const tableRecipe = tableFixture.recipe;
const tableSource = tableRecipe.header + tableRecipe.precedingBodyRow.repeat(tableRecipe.precedingBodyRows)
  + '|' + tableRecipe.giantFirstCellScalar.repeat(tableRecipe.giantFirstCellRepeats) + tableRecipe.lastRowTail + tableRecipe.afterFirstTable;
test('far table cell has an absolute address without preceding row or cell source', () => {
  const x = tableFixture;
  assert.equal(tableSource.length, x.expected.sourceLength);
  assert.ok(utf8(tableSource.slice(0, x.expected.cellStart)) > 2_000_000);
  assert.equal(tableSource.slice(x.expected.cellStart, x.expected.cellEnd), '目标😀');
  assertSourcePage(tableSource, x.sourceFrame, { ...f.limits, sourceBytes: 16, wireBytes: 4096 },
    { direction: 'forward', at: x.sourceRequest.params.page.at });
  for (const frame of [x.cellFrame, x.rowFrame, x.tableFrame]) summaryContract.assertContextFrame(frame, f.limits);
  const cell = x.cellFrame.result.items[0];
  assert.deepEqual(cell.tablePosition, { tableRef: 'first-table-ref', rowIndex: 100001, columnIndex: 2, alignment: 'right' });
  assert.equal(cell.tablePosition.alignment, x.expected.alignments[cell.tablePosition.columnIndex]);
  assert.equal(x.cellFrame.result.items.length, 1);
  assert.equal(cell.sourceRange.start, x.expected.cellStart);
  assert.equal(cell.text, undefined);
  assert.equal(cell.parentRef, 'far-row-ref');
  assert.equal(cell.detailRef, 'far-cell-details');
  summaryContract.assertContextFrame(x.cellDetails.directory, f.limits, { directory: true });
  for (const field of ['openingSource', 'closingSource']) {
    assert.equal(summaryContract.assertTextFragments([x.cellDetails[field]], field, f.limits), '');
  }
  assert.ok([x.cellFrame, x.rowFrame, x.tableFrame].every(p => wireBytes(p) <= 4096));
});
test('table positions are mandatory and distinguish row, header and cell shapes', () => {
  const x = tableFixture;
  for (const frame of [x.cellFrame, x.rowFrame, x.headerFrame]) {
    const absent = structuredClone(frame); delete absent.result.items[0].tablePosition;
    assert.throws(() => summaryContract.assertContextFrame(absent, f.limits));
  }
  for (const corrupt of [
    p => { p.rowIndex = -1; }, p => { p.rowIndex = Number.MAX_SAFE_INTEGER + 1; },
    p => { p.columnIndex = 1.5; }, p => { delete p.columnIndex; },
    p => { p.rowIndex = '100001'; }, p => { p.alignment = 'justify'; },
    p => { delete p.alignment; }, p => { p.tableRef = ''; },
    p => { p.tableRef = 'x'.repeat(257); }, p => { p.rowSpan = 2; },
    p => { p.colSpan = 2; },
  ]) {
    const bad = structuredClone(x.cellFrame); corrupt(bad.result.items[0].tablePosition);
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
  const row = structuredClone(x.rowFrame); row.result.items[0].tablePosition.columnIndex = 0;
  assert.throws(() => summaryContract.assertContextFrame(row, f.limits));
  const header = structuredClone(x.headerFrame); header.result.items[0].tablePosition.rowIndex = 1;
  assert.throws(() => summaryContract.assertContextFrame(header, f.limits));
  const body = structuredClone(x.rowFrame); body.result.items[0].tablePosition.rowIndex = 0;
  assert.throws(() => summaryContract.assertContextFrame(body, f.limits));
});
test('table reference continuations reject cross-table, cross-note and changed revision use', () => {
  const claim = { ...f.scope, kind: 'context', contextRef: 'first-table-ref',
    sourceRevision: 'r:table', boot: 'boot', expiresAt: 100, budgets: { maxWireBytes: 4096 } };
  assert.equal(cursorError(claim, claim, claim, 1), null);
  assert.equal(cursorError(claim, { ...claim, contextRef: 'second-table-ref' }, claim, 1), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, { ...claim, noteId: 'other' }, claim, 1), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, claim, { ...claim, sourceRevision: 'r:next' }, 1), 'note-page-stale');
});
test('header/body ordinals reset per table and are independent of viewport continuation', () => {
  const x = tableFixture;
  for (const frame of [x.headerFrame, x.secondTableFrame]) summaryContract.assertContextFrame(frame, f.limits);
  assert.equal(x.headerFrame.result.items[1].tablePosition.columnIndex, 0);
  assert.equal(x.secondTableFrame.result.items[0].tablePosition.rowIndex, 0);
  assert.equal(x.secondTableFrame.result.items[1].tablePosition.rowIndex, 1);
  assert.notEqual(x.cellFrame.result.items[0].tablePosition.tableRef,
    x.secondTableFrame.result.items[1].tablePosition.tableRef);
  const before = structuredClone(x.cellFrame);
  before.result.items[0].continuationBefore = false;
  before.result.items[0].continuationAfter = true;
  assert.deepEqual(before.result.items[0].tablePosition, x.cellFrame.result.items[0].tablePosition);
});
test('table position frames honor exact full-wire limits even with maximally escaped references', () => {
  const frame = structuredClone(tableFixture.cellFrame);
  frame.id = 'i'.repeat(64);
  for (const k of Object.keys(frame.result.scope)) frame.result.scope[k] = 's'.repeat(256);
  frame.result.sourceRevision = 'r'.repeat(256); frame.result.snapshotId = 'v'.repeat(256);
  frame.result.items = Array.from({ length: 17 }, (_, i) => ({
    kind: 'boundary', id: '\u0001'.repeat(128) + i, construct: 'tableCell',
    sourceRange: { start: i * 5, end: i * 5 + 4 }, continuationBefore: false, continuationAfter: false,
    parentRef: '\u0001'.repeat(128) + i, detailRef: '\u0001'.repeat(128) + i,
    tablePosition: { tableRef: '\u0001'.repeat(128) + i, rowIndex: 1, columnIndex: 2, alignment: 'right' },
  }));
  const slots = frame.result.items.flatMap(item => [[item, 'id'], [item, 'parentRef'],
    [item, 'detailRef'], [item.tablePosition, 'tableRef']]);
  assert.ok(wireBytes(frame) < 65536);
  while (wireBytes(frame) < 65536) {
    const slot = slots.find(([owner, key]) => utf8(owner[key]) < 256);
    assert.ok(slot, 'fixture must reach the wire ceiling before token capacity');
    slot[0][slot[1]] += 'x';
  }
  assert.equal(wireBytes(frame), 65536);
  summaryContract.assertContextFrame(frame, f.limits);
  const slot = slots.find(([owner, key]) => utf8(owner[key]) < 256);
  assert.ok(slot); slot[0][slot[1]] += 'x';
  assert.equal(wireBytes(frame), 65537);
  assert.throws(() => summaryContract.assertContextFrame(frame, f.limits));
});
test('table address metadata stays bounded as unloaded prefix extent grows', () => {
  const near = structuredClone(tableFixture.cellFrame);
  near.result.items[0].tablePosition.rowIndex = 1;
  near.result.items[0].sourceRange = { start: 30, end: 34 };
  assert.ok(wireBytes(tableFixture.cellFrame) - wireBytes(near) < 32);
  const nearCell = near.result.items[0];
  const empty = structuredClone(near);
  empty.result.items[0].sourceRange.end = nearCell.sourceRange.start;
  summaryContract.assertContextFrame(empty, f.limits);
  assert.equal(empty.result.items[0].tablePosition.columnIndex, 2);
  const tooMany = structuredClone(near);
  tooMany.result.items = Array.from({ length: 129 }, () => nearCell);
  assert.throws(() => summaryContract.assertContextFrame(tooMany, f.limits));
  const split = structuredClone(tableFixture.sourceFrame);
  split.result.range.start = tableFixture.expected.cellStart + 3;
  split.result.text = tableSource.slice(split.result.range.start, split.result.range.end);
  assert.throws(() => assertSourcePage(tableSource, split, f.limits,
    { direction: 'forward', at: split.result.range.start }));
});
