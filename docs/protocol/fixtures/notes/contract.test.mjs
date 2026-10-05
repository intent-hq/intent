import { canonicalJson } from '../../../../scripts/check-transfer-selection-contract.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { caseFoldTable, sourceSearch, assertSourceSearchTrace } from './source-search.mjs';
import { assertSourceHitDetail } from './source-hit-detail.mjs';
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
const searchFixtures = JSON.parse(await readFile(new URL('./source-search.json', import.meta.url), 'utf8'));
const foldBytes = await readFile(new URL('./CaseFolding-17.0.0.txt', import.meta.url));
const foldTable = caseFoldTable(foldBytes.toString('utf8'));
const hitDetail = JSON.parse(await readFile(new URL('./source-hit-detail.json', import.meta.url), 'utf8'));
test('source-hit details resolve exact raw Unicode text with relative offsets and original view identity', () => {
  assertSourceHitDetail(hitDetail, foldTable);
  assert.deepEqual(hitDetail.owner.sourceRange, { start: 9, end: 17 });
  assert.deepEqual(hitDetail.exchanges.map(x => x.response.result.items[0].offset), [0, 4, 6]);
  assert.equal(hitDetail.exchanges[0].response.result.nextCursor, null);
  assert.notEqual(hitDetail.exchanges[0].response.result.items[0].nextRef, null);
  assert.match(docs, /additive resource meaning: a direct fragment field named `source`/u);
  assert.match(docs, /no empty-field\s+or zero-progress success/u);
});
test('source-hit detail rejects foreign or widened claims and wrong owner/query/view/deadline', () => {
  for (const mutate of [
    x => { x.exchanges[0].request.params.ref = 'foreign-ref'; },
    x => { x.claims['hit-source-0'].principalId = 'other'; },
    x => { x.claims['hit-source-0'].scope.noteId = 'other'; },
    x => { x.claims['hit-source-0'].query.text = 'different'; },
    x => { x.claims['hit-source-0'].sourceRange.start = 0; },
    x => { x.claims['hit-source-0'].viewId = 'other-view'; },
    x => { x.claims['hit-source-4'].expiresAt = '2026-10-05T17:00:00.000Z'; },
    x => { x.now = x.owner.expiresAt; },
    x => { x.exchanges[0].request.params.payloadDigest = x.owner.payloadDigest; },
  ]) {
    const bad = structuredClone(hitDetail); mutate(bad);
    assert.throws(() => assertSourceHitDetail(bad, foldTable));
  }
});
test('source-hit detail rejects folded or surrounding bytes, offset drift, empty and malformed chains', () => {
  for (const mutate of [
    x => { x.exchanges[1].response.result.items[0].text = 'sse'; },
    x => { x.exchanges[0].response.result.items[0].text = 'prefix Stra'; },
    x => { x.exchanges[1].request.params.offset = 5; },
    x => { x.exchanges[2].response.result.items[0].offset = 7; },
    x => { x.exchanges[2].response.result.items[0].text = '\uD83D'; },
    x => { x.exchanges[2].response.result.items[0].text = ''; },
    x => { x.exchanges[0].response.result.items[0].field = 'text'; },
    x => { x.exchanges[0].response.result.items[0].nextRef = null; },
    x => { x.exchanges[1].response.result.items[0].nextRef = 'hit-source-0'; },
    x => { delete x.exchanges[2].response.result.items[0].nextRef; },
    x => { x.exchanges[0].response.result.sourceLength = 8; },
    x => { x.exchanges[0].response.result.expiresAt = '2026-10-05T17:00:00.000Z'; },
    x => { x.owner.sourceRange.end = x.owner.sourceRange.start; },
  ]) {
    const bad = structuredClone(hitDetail); mutate(bad);
    assert.throws(() => assertSourceHitDetail(bad, foldTable));
  }
});
test('source search uses pinned Unicode full folding, not host lowercase', () => {
  assert.equal(createHash('sha256').update(foldBytes).digest('hex'), searchFixtures.caseFoldingSha256);
  assert.ok(docs.includes(searchFixtures.caseFoldingSha256));
  assert.equal(foldTable.get('ß'), 'ss');
  assert.equal(foldTable.get('İ'), 'i\u0307');
  assert.equal(foldTable.get('I'), 'i');
  assert.equal(foldTable.get('ς'), 'σ');
  assert.match(docs, /cursor retains matcher carry and pending-emission position/u);
  assert.match(docs, /only terminal exhaustion, after pending hits are emitted, reports an exact total/u);
});
for (const row of searchFixtures.vectors) test(`source search policy: ${row.name}`, () => {
  assert.deepEqual(sourceSearch(row.source, row.query, foldTable, row.ranges), row.expected);
});
test('source search rejects empty, malformed, NUL and oversized query; admits exact byte limit', () => {
  for (const query of ['', '\0', '\uD800', '\uDC00', 'a'.repeat(1025), 'é'.repeat(513)]) {
    assert.throws(() => sourceSearch('abc', query, foldTable));
  }
  assert.deepEqual(sourceSearch('é'.repeat(512), 'é'.repeat(512), foldTable), [[0, 512]]);
  assert.throws(() => sourceSearch('😀x', 'x', foldTable, [[1, 3]]));
  assert.throws(() => sourceSearch('abc', 'a', foldTable, [[2, 1]]));
});
test('source-search semantic oracle preserves overlaps and expansion across reassembled chunks', () => {
  // Reassembly is ONLY a fixture oracle. This proves no runtime carry/cursor bounds.
  for (const chunks of [['ban', 'ana'], ['ba', 'n', 'a', 'na']]) {
    assert.deepEqual(sourceSearch(chunks.join(''), 'ana', foldTable), [[1, 4], [3, 6]]);
  }
  assert.deepEqual(sourceSearch(['😀Stra', 'ß', 'e'].join(''), 'STRASSE', foldTable), [[2, 8]]);
});
test('controlled search trace resumes overlaps across scan seams and maxItems cuts', () => {
  const pages = [
    { items: [], scannedThrough: 3, count: { value: 0, exact: false }, nextCursor: 'carry-an' },
    { items: [[1, 4]], scannedThrough: 6, count: { value: 2, exact: false }, nextCursor: 'pending-second-hit' },
    { items: [[3, 6]], scannedThrough: 6, count: { value: 2, exact: true }, nextCursor: null },
  ];
  assertSourceSearchTrace('banana', 'ana', foldTable, undefined, pages, 1);
  for (const mutate of [
    p => { p[2].items = []; },
    p => { p[2].items = [[1, 4]]; },
    p => { p[1].count.exact = true; },
    p => { p[1].items.push([3, 6]); },
    p => { p[2].scannedThrough = 5; },
    p => { p[0].count.value = 2; },
  ]) {
    const bad = structuredClone(pages); mutate(bad);
    assert.throws(() => assertSourceSearchTrace('banana', 'ana', foldTable, undefined, bad, 1));
  }
});
test('controlled search trace retains expansion offsets and exact selected-domain count', () => {
  assertSourceSearchTrace('😀ßss', 'ss', foldTable, [[2, 3], [3, 5]], [
    { items: [[2, 3]], scannedThrough: 5, count: { value: 2, exact: false }, nextCursor: 'pending-ascii' },
    { items: [[3, 5]], scannedThrough: 5, count: { value: 2, exact: true }, nextCursor: null },
  ], 1);
  assertSourceSearchTrace('banana', 'ana', foldTable, [[1, 3], [4, 6]], [
    { items: [], scannedThrough: 3, count: { value: 0, exact: false }, nextCursor: 'skip-gap' },
    { items: [], scannedThrough: 6, count: { value: 0, exact: true }, nextCursor: null },
  ], 1);
  const terminalEmpty = frontier => [{ items: [], scannedThrough: frontier,
    count: { value: 0, exact: true }, nextCursor: null }];
  assert.throws(() => assertSourceSearchTrace('zzz', 'a', foldTable, undefined, terminalEmpty(0), 1));
  assert.throws(() => assertSourceSearchTrace('zzzz', 'a', foldTable, [[1, 3]], terminalEmpty(2), 1));
  assertSourceSearchTrace('zzzz', 'a', foldTable, [[1, 3]], terminalEmpty(3), 1);
  assertSourceSearchTrace('zzzz', 'a', foldTable, [], terminalEmpty(0), 1);
});
test('source-search selection union does not inherit or weaken splice ordering', () => {
  const chunks = [
    [{ ordinal: 0, start: 3, end: 6 }, { ordinal: 1, start: 1, end: 4 }],
    [{ ordinal: 2, start: 1, end: 4 }, { ordinal: 3, start: 4, end: 6 }],
  ];
  const before = canonicalJson(chunks);
  const records = chunks.flat();
  assert.deepEqual(records.map(r => r.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(sourceSearch('banana', 'ana', foldTable,
    records.map(r => [r.start, r.end])), [[1, 4], [3, 6]]);
  assert.equal(canonicalJson(chunks), before);
  assert.equal(spliceError('banana', [{ start: 1, end: 4, text: '' },
    { start: 1, end: 4, text: '' }], f.limits), 'invalid-params');
  assert.match(docs, /Only when `header.output === "search"` and\s+`header.query.mode === "source"`/u);
  assert.match(docs, /Other selection modes retain ordered disjoint ranges and reject equal starts or\s+overlaps/u);
  assert.match(docs, /union normalization is derived state, never a rewrite of that stream/u);
});
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


test('canonical HTML continuation requires owner metadata when identical windows have different columns', () => {
  const { recipe: r, expected: e } = f.htmlContinuation;
  const a = r.open + r.repeat.repeat(r.count) + r.tail;
  const b = r.open + r.extra + r.repeat.repeat(r.count - r.extra.length) + r.tail;
  assert.equal(a.length, b.length);
  assert.equal(a.indexOf(e.target), b.indexOf(e.target));
  const start = a.indexOf(e.target), end = start + e.target.length;
  assert.equal(a.slice(start, end), b.slice(start, end));
  assert.notEqual(e.columnIndexA, e.columnIndexB);
  for (const source of [a, b]) assertSourcePage(source,
    frame(source.slice(start, end), start, end, source.length), f.limits,
    { direction: 'forward', at: start });
  const incomplete = structuredClone(tableFixture.cellFrame);
  incomplete.result.items[0].construct = 'htmlTableCell';
  delete incomplete.result.items[0].tablePosition;
  assert.throws(() => summaryContract.assertContextFrame(incomplete, f.limits));
});

test('canonical HTML cell descriptors cannot silently promote raw spans to live geometry', () => {
  const invalid = structuredClone(tableFixture.cellFrame);
  const cell = invalid.result.items[0];
  cell.construct = 'htmlTableCell'; delete cell.tablePosition;
  cell.htmlPosition = { profile: 'canonicalNote', tableRef: 'html-table', rowIndex: 0,
    columnIndex: 1, cellRole: 'data', rowSpan: 2, colSpan: 2 };
  assert.throws(() => summaryContract.assertContextFrame(invalid, f.limits));
});

test('HTML table owners and raw body addresses distinguish identical far source windows', () => {
  const x = f.htmlContinuation;
  const source = x.recipe.open + x.recipe.repeat.repeat(x.recipe.count) + x.recipe.tail;
  for (const [variant, column] of [['a', 1], ['b', 2]]) {
    const frames = x.frames[variant];
    for (const kind of ['cell', 'row', 'table', 'map', 'text'])
      summaryContract.assertContextFrame(frames[kind], f.limits);
    assertMetadataFrame(frames.attributes, f.limits);
    const cell = frames.cell.result.items[0], row = frames.row.result.items[0];
    assert.equal(cell.htmlPosition.columnIndex, column);
    assert.equal(cell.htmlPosition.rowIndex, 0);
    assert.equal(row.htmlPosition.rowIndex, 0);
    assert.equal(cell.htmlPosition.tableRef, row.htmlPosition.tableRef);
    assert.deepEqual(cell.htmlSource.bodyRange, x.expected.targetRange);
    assert.equal(source.slice(cell.htmlSource.bodyRange.start, cell.htmlSource.bodyRange.end), 'TARGET');
    assert.equal(source.slice(cell.htmlSource.openingRange.start, cell.htmlSource.openingRange.end), '<td>');
    assert.equal(source.slice(cell.htmlSource.closingRange.start, cell.htmlSource.closingRange.end), '</td>');
    const text = summaryContract.assertTextFragments([frames.text], 'renderedText', f.limits);
    const map = frames.map.result.items[0];
    assert.equal(text.length, map.renderedRange.end - map.renderedRange.start);
    assert.equal(text, source.slice(map.sourceRange.start, map.sourceRange.end));
    assert.ok(Object.values(frames).every(frame => wireBytes(frame) < 4096));
  }
  assert.equal(x.expected.sourceLength, source.length);
  assert.ok(source.length > 2_000_000);
  assert.notEqual(x.frames.a.cell.result.sourceRevision, x.frames.b.cell.result.sourceRevision);
  assert.ok(docs.includes('htmlTableCell') && docs.includes('context.attributes'));
});

test('canonical HTML address validation rejects spans, roles, unsafe offsets and cross-profile claims', () => {
  for (const change of [
    c => { c.htmlPosition.profileVersion = 2; },
    c => { c.htmlPosition.rowSpan = 2; }, c => { c.htmlPosition.colSpan = 2; },
    c => { c.htmlPosition.rowIndex = -1; }, c => { c.htmlPosition.columnIndex = 0.5; },
    c => { c.htmlPosition.columnIndex = Number.MAX_SAFE_INTEGER + 1; },
    c => { c.htmlPosition.cellRole = 'td'; }, c => { c.htmlPosition.profile = 'liveSession'; },
    c => { c.htmlPosition.tableRef = 'x'.repeat(257); }, c => { delete c.parentRef; },
    c => { delete c.attributesRef; }, c => { delete c.sourceMapRef; },
    c => { c.htmlSource.bodyRange.end = c.sourceRange.end + 1; },
    c => { c.htmlSource.openingRange = null; },
    c => { c.htmlSource.provenance = 'implicit'; },
  ]) {
    const bad = structuredClone(f.htmlContinuation.frames.a.cell);
    change(bad.result.items[0]);
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
  const header = structuredClone(f.htmlContinuation.frames.a.cell);
  header.result.items[0].htmlPosition.cellRole = 'header';
  header.result.items[0].htmlPosition.rowIndex = 7;
  summaryContract.assertContextFrame(header, f.limits);
  for (const type of ['row', 'table']) {
    const bad = structuredClone(f.htmlContinuation.frames.a[type]);
    bad.result.items[0].htmlPosition.columnIndex = 0;
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
});

test('source-less HTML projections have explicit anchors and no fabricated syntax', () => {
  const implicit = structuredClone(f.htmlContinuation.frames.a.row);
  const node = implicit.result.items[0];
  node.sourceRange.end = node.sourceRange.start;
  node.htmlSource = { provenance: 'implicit', openingRange: null, bodyRange: null, closingRange: null };
  summaryContract.assertContextFrame(implicit, f.limits);
  node.htmlSource.bodyRange = { ...node.sourceRange };
  assert.throws(() => summaryContract.assertContextFrame(implicit, f.limits));
  node.htmlSource.provenance = 'repaired'; node.htmlSource.piecesRef = 'repair-pieces';
  summaryContract.assertContextFrame(implicit, f.limits);
});

test('HTML rendered offsets are leaf-local and mapping modes constrain source ownership', () => {
  const frame = structuredClone(f.htmlContinuation.frames.a.map);
  const item = frame.result.items[0];
  assert.equal(item.renderedRange.start, 0);
  assert.ok(item.sourceRange.start > 2_000_000);
  for (const mutate of [
    m => { m.profileVersion = 2; }, m => { m.profile = 'liveSession'; }, m => { m.mapping = 'guess'; },
    m => { m.renderedRange.end++; }, m => { m.textRef = null; },
    m => { m.ownerRef = ''; }, m => { m.textNodeId = 'x'.repeat(257); },
    m => { m.mapping = 'projection'; }, m => { m.mapping = 'omitted'; },
    m => { m.renderedRange.start = -1; },
  ]) {
    const bad = structuredClone(frame); mutate(bad.result.items[0]);
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
  item.mapping = 'omitted'; item.renderedRange.end = 0; item.textRef = null;
  summaryContract.assertContextFrame(frame, f.limits);
  item.mapping = 'projection'; item.sourceRange.end = item.sourceRange.start;
  item.renderedRange.end = 1; item.textRef = 'projection-text';
  summaryContract.assertContextFrame(frame, f.limits);
});

test('HTML mapping refs retain window, owner, revision and expiration guards', () => {
  const claim = { ...f.scope, kind: 'context', contextRef: 'a-cell-window-map',
    sourceRevision: 'r:html-a', boot: 'boot', profileRevision: 'canonical-build-a', expiresAt: 100,
    budgets: { maxWireBytes: 4096 } };
  assert.equal(cursorError(claim, claim, claim, 1), null);
  for (const contextRef of ['b-cell-window-map', 'a-other-window-map', 'live-session-map', 'a-table'])
    assert.equal(cursorError(claim, { ...claim, contextRef }, claim, 1), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, { ...claim, noteId: 'other' }, claim, 1), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, claim, { ...claim, sourceRevision: 'r:html-b' }, 1), 'note-page-stale');
  assert.equal(cursorError(claim, claim, claim, 100), 'note-page-expired');
  assert.equal(cursorError(claim, claim, { ...claim, profileRevision: 'canonical-build-b' }, 1), 'note-page-expired');
});

test('HTML maps use the complete escaped-wire budget with no inline source exceptions', () => {
  const frame = structuredClone(f.htmlContinuation.frames.a.map);
  frame.id = 'i'.repeat(64);
  for (const key of Object.keys(frame.result.scope)) frame.result.scope[key] = 's'.repeat(256);
  frame.result.items = Array.from({ length: 12 }, (_, i) => ({
    ...frame.result.items[0], id: '\u0001'.repeat(127) + i,
    ownerRef: '\u0001'.repeat(127) + i, textNodeId: '\u0001'.repeat(127) + i,
    textRef: '\u0001'.repeat(127) + i,
  }));
  const slots = frame.result.items.flatMap(item => ['id', 'ownerRef', 'textNodeId', 'textRef'].map(key => [item, key]));
  // Escaped legal controls grow six wire bytes each; then fill the exact residual with ASCII.
  for (const [item, key] of slots) {
    const room = Math.min(256 - utf8(item[key]), Math.floor((65536 - wireBytes(frame)) / 6));
    if (room > 0) item[key] += '\u0001'.repeat(room);
  }
  const remaining = 65536 - wireBytes(frame);
  const [item, key] = slots.find(([item, key]) => utf8(item[key]) + remaining + 1 <= 256);
  item[key] += 'x'.repeat(remaining);
  assert.equal(wireBytes(frame), 65536);
  summaryContract.assertContextFrame(frame, f.limits);
  item[key] += 'x';
  assert.equal(wireBytes(frame), 65537);
  assert.throws(() => summaryContract.assertContextFrame(frame, f.limits));
});

test('same HTML owner survives two admitted windows with separately retained map bindings', () => {
  const one = structuredClone(f.htmlContinuation.frames.a.cell);
  const two = structuredClone(one);
  two.result.items[0].sourceMapRef = 'a-same-cell-second-window-map';
  two.result.items[0].continuationBefore = !one.result.items[0].continuationBefore;
  const immutable = ({ sourceMapRef, continuationBefore, continuationAfter, ...owner }) => owner;
  assert.deepEqual(immutable(one.result.items[0]), immutable(two.result.items[0]));
  assert.notEqual(one.result.items[0].sourceMapRef, two.result.items[0].sourceMapRef);
  const bindings = new Map([['window-1', one.result.items[0].sourceMapRef], ['window-2', two.result.items[0].sourceMapRef]]);
  assert.equal(bindings.size, 2);
  for (const frame of [one, two]) summaryContract.assertContextFrame(frame, f.limits);
});

test('direct native leaf references preserve rendered ancestry without earlier sibling reads', () => {
  const x = f.htmlContinuation.frames.b;
  summaryContract.assertContextFrame(x.native, f.limits);
  const nodes = new Map(x.native.result.items.map(n => [n.nodeClass === 'text' ? 'b-native-leaf' : n.id, n]));
  const map = x.map.result.items[0];
  let node = nodes.get(map.textNodeRef);
  assert.equal(node.id, map.textNodeId);
  const chain = [], seen = new Set();
  while (node) {
    assert.ok(!seen.has(node.id)); seen.add(node.id); chain.push(node.nodeType);
    if (node.nodeType === 'tableCell') assert.equal(node.childIndex, 2);
    node = node.parentRef === null ? undefined : nodes.get(node.parentRef);
  }
  assert.deepEqual(chain, ['text', 'paragraph', 'tableCell', 'tableRow', 'table', 'doc']);
  const paragraph = nodes.get('b-native-paragraph');
  assert.equal(paragraph.sourceRange.start, paragraph.sourceRange.end);
  // Ancestor closure returns this implicit node even though an interior seek does not overlap it.
  assert.ok(paragraph.sourceRange.end < map.sourceRange.start + 1);
  assert.equal(x.native.result.items.filter(n => n.nodeType === 'tableCell').length, 1);
  const invalid = structuredClone(x.native);
  invalid.result.items.at(-1).childIndex = -1;
  assert.throws(() => summaryContract.assertContextFrame(invalid, f.limits));
  invalid.result.items.at(-1).childIndex = 0;
  invalid.result.items.at(-1).children = [{ text: 'unbounded hidden subtree' }];
  assert.throws(() => summaryContract.assertContextFrame(invalid, f.limits));
});

test('entity and whitespace segments reconstruct actual canonical leaves without source-prefix reads', () => {
  const x = f.htmlContinuation.entityMapping;
  summaryContract.assertContextFrame(x.maps, f.limits);
  summaryContract.assertContextFrame(x.atom, f.limits);
  const resources = new Map(x.textResources.map(r => [r.ref, r.frame]));
  const leaves = ['', ''];
  for (const item of x.maps.result.items) {
    assert.ok(boundary(x.source, item.sourceRange.start) && boundary(x.source, item.sourceRange.end));
    const leaf = Number(item.textNodeId.at(-1));
    const text = item.textRef === null ? '' : summaryContract.assertTextFragments([resources.get(item.textRef)], 'renderedText', f.limits);
    assert.equal(item.renderedRange.start, leaves[leaf].length);
    assert.equal(item.renderedRange.end, leaves[leaf].length + text.length);
    const raw = x.source.slice(item.sourceRange.start, item.sourceRange.end);
    if (item.mapping === 'identity') assert.equal(text, raw);
    if (item.mapping === 'entity') assert.equal(text, { '&amp;': '&', '&#x1f680;': '🚀', '&nbsp;': '\u00a0' }[raw]);
    if (item.mapping === 'normalized') assert.ok(['\r\n  ', '\t '].includes(raw) && text === ' ');
    leaves[leaf] += text;
  }
  assert.deepEqual(leaves, x.expectedLeaves);
  const oracle = f.htmlContinuation.canonicalOracleCases.find(c => c.id === 'entitiesAndWhitespace');
  const paragraph = oracle.native.content[0].content[0].content[0].content[0];
  assert.deepEqual(paragraph.content.map(n => n.text ?? n.type), [leaves[0], 'hardBreak', leaves[1]]);
  const entity = x.maps.result.items.find(m => x.source.slice(m.sourceRange.start, m.sourceRange.end) === '&amp;');
  const seek = entity.sourceRange.start + 2;
  assert.equal(x.source.slice(seek, entity.sourceRange.end), 'mp;');
  assert.equal(summaryContract.assertTextFragments([resources.get(entity.textRef)], 'renderedText', f.limits), '&');
  const atom = x.atom.result.items[0];
  assert.equal(x.source.slice(atom.sourceRange.start, atom.sourceRange.end), '<br>');
  assert.equal(atom.childIndex, 1);
  assert.equal(atom.nodeClass, 'atom');
});

test('recorded canonical parser outcomes retain roles, nested order and sanitized atomic attributes', () => {
  const cases = Object.fromEntries(f.htmlContinuation.canonicalOracleCases.map(c => [c.id, c]));
  const cells = cases.cellRoles.native.content[0].content[0].content;
  assert.deepEqual(cells.map(n => n.type), ['tableHeader', 'tableCell']);
  const repaired = cases.implicitBodiesAndEnds.native.content[0];
  assert.deepEqual(repaired.content.map(r => r.content.length), [2, 1]);
  const nested = cases.nestedTable.native.content[0].content[0].content[0].content;
  assert.deepEqual(nested.map(n => n.type), ['paragraph', 'table', 'paragraph']);
  assert.equal(nested[1].content[0].content[0].type, 'tableHeader');
  const malformed = cases.malformedSpans.native.content[0].content[0].content;
  assert.ok(malformed.every(n => n.attrs.colspan === 1 && n.attrs.rowspan === 1));
  const unsafe = JSON.stringify(cases.unsafeAttributes.native);
  for (const removed of ['javascript:', 'alert(', 'evil()', 'display:none']) assert.ok(!unsafe.includes(removed));
  const retained = cases.retainedAttributes.native.content[0].content[0].content[0].content;
  assert.deepEqual(retained.map(n => n.type), ['paragraph', 'image']);
  assert.equal(retained[0].content[0].marks[0].attrs.href, 'https://example.test/long');
  assert.equal(retained[1].attrs.src, 'https://example.test/image.png');
  assert.ok(cases.retainedAttributes.source.includes('t'.repeat(256)));
  assert.ok(!JSON.stringify(retained).includes('t'.repeat(256)), 'schema drops the raw link title');
});

test('repaired HTML provenance preserves absent syntax and separately paged exact source pieces', () => {
  const x = f.htmlContinuation.repairedProvenance;
  summaryContract.assertContextFrame(x.cell, f.limits);
  summaryContract.assertContextFrame(x.pieces, f.limits);
  const cell = x.cell.result.items[0], parts = x.pieces.result.items;
  assert.equal(cell.htmlSource.closingRange, null);
  assert.deepEqual(parts.map(p => x.source.slice(p.sourceRange.start, p.sourceRange.end)), ['<td>', 'ONE']);
  assert.ok(parts.every(p => p.nodeRef === cell.nativeRef));
  assert.equal(cell.sourceRange.start, Math.min(...parts.map(p => p.sourceRange.start)));
  assert.equal(cell.sourceRange.end, Math.max(...parts.map(p => p.sourceRange.end)));
  const missing = structuredClone(x.cell); delete missing.result.items[0].htmlSource.piecesRef;
  assert.throws(() => summaryContract.assertContextFrame(missing, f.limits));
  const bad = structuredClone(x.pieces); bad.result.items[0].sourceRange.end = bad.result.items[0].sourceRange.start;
  assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
});

test('native graph references reject duplicate rendered positions, missing parents and cycles', () => {
  const frame = f.htmlContinuation.frames.a.native;
  const links = Object.fromEntries(frame.result.items.map(n => [n.nodeClass === 'text' ? 'a-native-leaf' : n.id, n.id]));
  const nodes = summaryContract.assertNativeGraph([frame], links, f.limits);
  assert.equal(nodes.get(links['a-native-leaf']).nodeClass, 'text');
  assert.equal(nodes.get(links['a-native-leaf']).id, f.htmlContinuation.frames.a.map.result.items[0].textNodeId);
  const duplicated = structuredClone(frame);
  duplicated.result.items.push({ ...duplicated.result.items.at(-1), id: 'different-leaf-same-position' });
  assert.throws(() => summaryContract.assertNativeGraph([duplicated], links, f.limits));
  const cyclic = structuredClone(frame);
  cyclic.result.items.find(n => n.id === 'a-native-paragraph').parentRef = 'a-native-leaf';
  assert.throws(() => summaryContract.assertNativeGraph([cyclic], links, f.limits));
  const missing = structuredClone(frame); missing.result.items.pop();
  missing.result.items.find(n => n.id === 'a-native-paragraph').parentRef = 'missing';
  assert.throws(() => summaryContract.assertNativeGraph([missing], links, f.limits));
  const foreign = structuredClone(frame); foreign.result.snapshotId = 'other-snapshot';
  assert.throws(() => summaryContract.assertNativeGraph([frame, foreign], links, f.limits));
});

test('repaired native text preserves disjoint raw pieces and never treats hull gaps as displayed content', () => {
  const example = f.htmlContinuation.canonicalOracleCases.find(c => c.id === 'unsafeAttributes');
  const expected = example.native.content[0].content[0].content[0].content[0].content[0].text;
  const first = example.source.indexOf('LINK'), last = example.source.lastIndexOf('TEXT');
  const frame = structuredClone(f.htmlContinuation.frames.a.native);
  frame.result.items = [{ kind: 'nativeNode', id: 'repaired-leaf', profile: 'canonicalNote', profileVersion: 1,
    nodeType: 'text', nodeClass: 'text', parentRef: 'repaired-paragraph', childIndex: 0,
    sourceRange: { start: first, end: last + 4 }, provenance: 'repaired',
    sourcePiecesRef: 'leaf-pieces', attributesRef: 'leaf-attrs' }];
  summaryContract.assertContextFrame(frame, f.limits);
  const pieces = structuredClone(f.htmlContinuation.repairedProvenance.pieces);
  pieces.result.items = [first, last].map((start, i) => ({ kind: 'sourcePiece', id: `part-${i}`,
    nodeRef: 'repaired-leaf-ref', sourceRange: { start, end: start + 4 }, role: 'body' }));
  summaryContract.assertContextFrame(pieces, f.limits);
  assert.equal(pieces.result.items.map(p => example.source.slice(p.sourceRange.start, p.sourceRange.end)).join(''), expected);
  assert.ok(example.source.slice(first + 4, last).includes('<script>evil()</script>'));
  assert.ok(!expected.includes('evil'));
});

test('HTML attribute resources page long raw values without confusing them with effective attributes', () => {
  const value = '😀\r\n"'.repeat(20_000);
  const source = `<table><tr><td title='${value}'>TARGET</td></tr></table>`;
  const cell = structuredClone(f.htmlContinuation.frames.a.cell);
  cell.result.items[0].sourceRange = { start: source.indexOf('<td'), end: source.indexOf('</td>') + 5 };
  cell.result.items[0].htmlSource = { provenance: 'explicit',
    openingRange: { start: source.indexOf('<td'), end: source.indexOf('TARGET') },
    bodyRange: { start: source.indexOf('TARGET'), end: source.indexOf('TARGET') + 6 },
    closingRange: { start: source.indexOf('</td>'), end: source.indexOf('</td>') + 5 } };
  summaryContract.assertContextFrame(cell, f.limits);
  assert.ok(wireBytes(cell) < 2048);
  const first = structuredClone(f.htmlContinuation.frames.a.text);
  first.result.items[0] = { kind: 'fragment', id: 'raw-attribute-part', field: 'rawAttributeValue:0',
    offset: 0, text: value.slice(0, 5120), nextRef: 'raw-attribute-next' };
  summaryContract.assertContextFrame(first, f.limits);
  assert.ok(utf8(first.result.items[0].text) <= f.limits.sourceBytes);
  assert.ok(first.result.items[0].text.length < value.length);
  assert.notEqual(cell.result.items[0].attributesRef, first.result.items[0].nextRef);
});


test('stable owner resolution has no hidden last-window map or continuation state', () => {
  const x = f.ownerResolution;
  for (const window of x.windows) summaryContract.assertContextFrame(window, f.limits);
  for (const order of [x.windows, [...x.windows].reverse()]) {
    const replies = order.map(() => structuredClone(x.directResponse));
    for (const reply of replies) summaryContract.assertContextFrame(reply, f.limits, { directOwner: true });
    assert.deepEqual(replies[0], replies[1]);
    assert.ok(wireBytes(x.request) <= f.limits.wireBytes);
    assert.deepEqual(x.windows.map(w => w.result.items[0].sourceMapRef),
      ['a-htmlTableCell-window-map', 'a-cell-window-two-map']);
  }
});

test('stable owner responses reject window-only maps and continuation flags', () => {
  const x = f.ownerResolution;
  for (const key of ['sourceMapRef', 'continuationBefore', 'continuationAfter']) {
    const bad = structuredClone(x.directResponse);
    bad.result.items[0][key] = x.windows[0].result.items[0][key];
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits, { directOwner: true }));
  }
  assert.throws(() => summaryContract.assertContextFrame(x.windows[0], f.limits, { directOwner: true }));
  assert.throws(() => summaryContract.assertContextFrame(x.directResponse, f.limits));
});

const inlineSource = c => c.source ?? (c.recipe.prefix + c.recipe.delimiter.repeat(c.recipe.delimiterCount)
  + c.recipe.body + c.recipe.delimiter.repeat(c.recipe.delimiterCount) + c.recipe.suffix);

test('inline code requires indexed delimiter/body addressing and canonical ownership', () => {
  const x = f.inlineCodeContinuation.canonicalOracleCases[0];
  for (const field of ['codeSource', 'nativeRef', 'sourceMapRef']) {
    const bad = structuredClone(x.windowFrame); delete bad.result.items[0][field];
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
});

test('inline code ranges reject gaps, overlapping delimiters and invented profile state', () => {
  const x = f.inlineCodeContinuation.canonicalOracleCases[0];
  for (const mutate of [c => { c.codeSource.bodyRange.start++; },
    c => { c.codeSource.closingRange.start--; }, c => { c.codeSource.openingRange.start--; },
    c => { c.codeSource.openingRange.end = c.codeSource.openingRange.start; },
    c => { c.codeSource.profileVersion = 2; }, c => { c.codeSource.bodyRange.end = 0.5; },
    c => { c.nativeRef = ''; }]) {
    const bad = structuredClone(x.windowFrame); mutate(bad.result.items[0]);
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits));
  }
});

test('rendered mapping resource cannot conceal a giant prefix in individually bounded fragments', () => {
  const base = f.htmlContinuation.frames.a.text;
  const pages = [structuredClone(base), structuredClone(base)];
  pages[0].result.items[0].text = 'x'.repeat(f.limits.sourceBytes);
  pages[0].result.items[0].nextRef = 'next-piece';
  pages[1].result.items[0].text = 'x'; pages[1].result.items[0].offset = f.limits.sourceBytes;
  pages[1].result.items[0].nextRef = null;
  assert.throws(() => summaryContract.assertTextFragments(pages, 'renderedText', f.limits));
  const map = structuredClone(f.htmlContinuation.frames.a.map);
  map.result.items[0].sourceRange = { start: 0, end: f.limits.sourceBytes + 1 };
  map.result.items[0].renderedRange = { start: 0, end: f.limits.sourceBytes + 1 };
  assert.throws(() => summaryContract.assertContextFrame(map, f.limits));
});

test('canonical inline-code oracle outputs retain normalization and omitted all-space leaf', () => {
  const expected = { multilineTrim: 'A ` B C', multipleDelimiters: 'x `` y ` z',
    noTrimAllSpaces: null, giantOpening: 'TARGET' };
  for (const c of f.inlineCodeContinuation.canonicalOracleCases) {
    assert.equal(c.expectedText, expected[c.id]);
    const source = inlineSource(c), owner = c.directFrame.result.items[0], r = owner.codeSource;
    assert.equal(source.length, c.sourceLength);
    summaryContract.assertContextFrame(c.directFrame, f.limits, { directOwner: true });
    for (const range of [owner.sourceRange, r.openingRange, r.bodyRange, r.closingRange]) {
      assert.ok(boundary(source, range.start) && boundary(source, range.end));
    }
    const opening = source.slice(r.openingRange.start, r.openingRange.end);
    assert.match(opening, /^`+$/);
    assert.equal(source.slice(r.closingRange.start, r.closingRange.end), opening);
    const graph = summaryContract.assertNativeGraph([c.native], c.nativeLinks, f.limits);
    if (c.expectedText === null) {
      assert.equal(owner.nativeRef, null);
      assert.deepEqual(c.expectedProse, ['before after']);
      assert.ok([...graph.values()].every(n => n.nodeClass !== 'text'));
      assert.ok(c.maps.result.items.every(m => m.mapping === 'omitted' && m.textNodeId === null));
    } else {
      const leaf = graph.get(c.nativeLinks[owner.nativeRef]);
      assert.equal(leaf.nodeClass, 'text');
      assert.equal(leaf.marksRef, c.marks.result.items[0].id);
      assertMetadataFrame(c.marks, f.limits);
      assert.equal(c.marks.result.items[1].index, 0);
      assert.equal(summaryContract.assertTextFragments([c.markName], 'value', f.limits), 'code');
    }
    if (c.windowFrame) summaryContract.assertContextFrame(c.windowFrame, f.limits);
    if (c.maps) summaryContract.assertContextFrame(c.maps, f.limits);
    for (const resource of c.texts) {
      const text = summaryContract.assertTextFragments([resource.frame], 'renderedText', f.limits);
      const map = (c.maps?.result.items ?? c.windows.flatMap(w => w.maps.result.items))
        .find(m => m.id === resource.mapId);
      assert.equal(text, c.expectedText.slice(map.renderedRange.start, map.renderedRange.end));
      assert.equal(text.length, map.renderedRange.end - map.renderedRange.start);
      if (map.mapping === 'identity') assert.equal(text, source.slice(map.sourceRange.start, map.sourceRange.end));
      assert.equal(map.textNodeRef, owner.nativeRef);
    }
  }
});

test('inline CRLF and trim map exact raw bytes to canonical leaf without copying delimiters', () => {
  const c = f.inlineCodeContinuation.canonicalOracleCases[0], source = inlineSource(c);
  const maps = c.maps.result.items;
  assert.deepEqual(maps.map(m => source.slice(m.sourceRange.start, m.sourceRange.end)),
    ['`` ', 'A ` B', '\r\n', 'C', ' ``']);
  assert.deepEqual(maps.map(m => [m.renderedRange.start, m.renderedRange.end]),
    [[0, 0], [0, 5], [5, 6], [6, 7], [0, 0]]);
  assert.equal(c.texts.map(r => r.frame.result.items[0].text).join(''), 'A ` B C');
  assert.equal(source, 'before `` A ` B\r\nC `` after');
});

test('giant inline delimiters and far body have separate bounded windows with one stable owner', () => {
  const c = f.inlineCodeContinuation.canonicalOracleCases.find(c => c.id === 'giantOpening');
  const source = inlineSource(c), owner = c.directFrame.result.items[0];
  assert.equal(source.length, 200021); assert.equal(source.indexOf('TARGET'), 100008);
  assert.deepEqual(owner.codeSource.bodyRange, { start: 100008, end: 100014 });
  for (const w of c.windows) {
    const r = w.sourceRange;
    assertSourcePage(source, frame(source.slice(r.start, r.end), r.start, r.end, source.length), f.limits,
      { direction: 'forward', at: r.start });
    summaryContract.assertContextFrame(w.occurrence, f.limits);
    summaryContract.assertContextFrame(w.maps, f.limits);
    assert.ok(wireBytes(w.occurrence) < 2048); assert.ok(wireBytes(w.maps) < 2048);
    const { sourceMapRef, ...stable } = w.occurrence.result.items[0];
    assert.deepEqual(stable, owner);
    assert.equal(w.maps.result.items[0].ownerRef, 'giantOpening-owner');
  }
  assert.equal(c.windows[0].maps.result.items[0].mapping, 'omitted');
  assert.equal(c.windows[0].maps.result.items[0].textRef, null);
  assert.deepEqual(c.windows[1].maps.result.items[0].renderedRange, { start: 2, end: 6 });
  assert.notEqual(c.windows[0].occurrence.result.items[0].sourceMapRef,
    c.windows[1].occurrence.result.items[0].sourceMapRef);
});

test('inline direct owner response rejects a window map and all-space owner invents no leaf', () => {
  for (const c of f.inlineCodeContinuation.canonicalOracleCases) {
    const bad = structuredClone(c.directFrame);
    bad.result.items[0].sourceMapRef = 'a-window-map';
    assert.throws(() => summaryContract.assertContextFrame(bad, f.limits, { directOwner: true }));
    assert.throws(() => summaryContract.assertContextFrame(c.directFrame, f.limits));
  }
});

test('rendered segment total uses UTF8 bytes across fragments while preserving scalar offsets', () => {
  const base = f.htmlContinuation.frames.a.text;
  const pages = [structuredClone(base), structuredClone(base)];
  pages[0].result.items[0].text = '🚀'.repeat(4095); pages[0].result.items[0].nextRef = 'next';
  pages[1].result.items[0].text = '🚀'; pages[1].result.items[0].offset = 8190;
  pages[1].result.items[0].nextRef = null;
  const text = summaryContract.assertTextFragments(pages, 'renderedText', f.limits);
  assert.equal(utf8(text), 16384); assert.equal(text.length, 8192);
  pages[1].result.items[0].text += 'x';
  assert.throws(() => summaryContract.assertTextFragments(pages, 'renderedText', f.limits));
});

test('far identity checkpoints keep absolute leaf offsets and segment-local fragment offsets', () => {
  const total = 2_000_000, start = total - 12;
  const map = structuredClone(f.htmlContinuation.frames.a.map);
  Object.assign(map.result.items[0], { sourceRange: { start, end: total },
    renderedRange: { start, end: total }, mapping: 'identity' });
  const text = structuredClone(f.htmlContinuation.frames.a.text);
  Object.assign(text.result.items[0], { offset: 0, text: '🚀'.repeat(6), nextRef: null });
  summaryContract.assertContextFrame(map, f.limits);
  assert.equal(summaryContract.assertTextFragments([text], 'renderedText', f.limits).length, 12);
  assert.ok(wireBytes(map) < 2048 && wireBytes(text) < 2048);
  assert.ok(map.result.items[0].renderedRange.start > f.limits.sourceBytes);
});

test('stable HTML table and row owners omit maps just like cell owners', () => {
  for (const kind of ['table', 'row', 'cell']) {
    const window = structuredClone(f.htmlContinuation.frames.a[kind]);
    summaryContract.assertContextFrame(window, f.limits);
    const owner = structuredClone(window);
    for (const k of ['sourceMapRef', 'continuationBefore', 'continuationAfter']) delete owner.result.items[0][k];
    summaryContract.assertContextFrame(owner, f.limits, { directOwner: true });
    assert.throws(() => summaryContract.assertContextFrame(owner, f.limits));
  }
});

test('inline mapping cursor cannot switch owner, source window, revision or canonical profile', () => {
  const claim = { ...f.scope, kind: 'context', contextRef: 'inline-body-window-map',
    sourceRevision: 'r:inline', boot: 'boot', profileRevision: 'canonical-build-a', expiresAt: 100,
    budgets: { maxWireBytes: 4096 } };
  assert.equal(cursorError(claim, claim, claim, 1), null);
  for (const contextRef of ['inline-opening-window-map', 'inline-owner', 'other-inline-owner-map'])
    assert.equal(cursorError(claim, { ...claim, contextRef }, claim, 1), 'note-page-cursor-invalid');
  for (const key of ['backendId', 'workspaceId', 'noteId', 'noteInstanceId'])
    assert.equal(cursorError(claim, { ...claim, [key]: 'other' }, claim, 1), 'note-page-cursor-invalid');
  assert.equal(cursorError(claim, claim, { ...claim, sourceRevision: 'changed' }, 1), 'note-page-stale');
  assert.equal(cursorError(claim, claim, { ...claim, profileRevision: 'changed' }, 1), 'note-page-expired');
  assert.equal(cursorError(claim, claim, claim, 100), 'note-page-expired');
});

test('inline descriptors obey exact complete escaped frame budgets with maximum legal scope and id', () => {
  const wire = structuredClone(f.inlineCodeContinuation.canonicalOracleCases[0].windowFrame);
  wire.id = 'i'.repeat(64);
  for (const key of Object.keys(wire.result.scope)) wire.result.scope[key] = 's'.repeat(256);
  wire.result.items = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(wire.result.items[0]),
    id: '\u0001'.repeat(127) + i, parentRef: '\u0001'.repeat(127) + i,
    nativeRef: '\u0001'.repeat(127) + i, sourceMapRef: '\u0001'.repeat(127) + i }));
  const slots = wire.result.items.flatMap(item => ['id', 'parentRef', 'nativeRef', 'sourceMapRef'].map(key => [item, key]));
  for (const [item, key] of slots) {
    const room = Math.min(256 - utf8(item[key]), Math.floor((65536 - wireBytes(wire)) / 6));
    if (room > 0) item[key] += '\u0001'.repeat(room);
  }
  const remaining = 65536 - wireBytes(wire);
  assert.ok(remaining >= 0);
  const [item, key] = slots.find(([item, key]) => utf8(item[key]) + remaining + 1 <= 256);
  item[key] += 'x'.repeat(remaining);
  assert.equal(wireBytes(wire), 65536); summaryContract.assertContextFrame(wire, f.limits);
  item[key] += 'x'; assert.equal(wireBytes(wire), 65537);
  assert.throws(() => summaryContract.assertContextFrame(wire, f.limits));
});

// Synthetic annotation resources: exercise existing context directories and direct
// nextRef traversal, not server token issuance or membership enforcement.
function authorResources(values = {
  authorPrincipalId: 'p'.repeat(255) + '😀\uFEFF',
  authorIdentity: { provider: 'gitlab', host: 'forge.example:8443', externalUserId: 'x'.repeat(1023) + '😀\uFEFF' },
}) {
  const row = structuredClone(f.annotationPages.pages[1].result.items[0]);
  const owner = f.annotationPages.pages[1].result;
  const reads = [];
  const response = (items, nextCursor = null) => ({ jsonrpc: '2.0', id: '\0"😀', result: {
    kind: 'noteContextPage', scope: owner.scope, sourceRevision: owner.sourceRevision,
    commentRevision: owner.commentRevision, snapshotId: owner.snapshotId, expiresAt: owner.expiresAt,
    items, nextCursor,
  } });
  function field(ref, name, text) {
    const scalars = [...text], chunks = [];
    do { chunks.push(scalars.splice(0, 127).join('')); } while (scalars.length);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const contextRef = i === 0 ? ref : `${ref}-${i}`;
      reads.push({ contextRef, response: response([{ kind: 'fragment', id: name,
        field: name, offset, text: chunks[i], nextRef: i + 1 === chunks.length ? null : `${ref}-${i + 1}` }]) });
      offset += chunks[i].length;
    }
  }
  field(row.authorPrincipalIdRef, 'authorPrincipalId', values.authorPrincipalId);
  const fields = ['provider', 'host', 'externalUserId'];
  fields.forEach((name, i) => {
    reads.push({ contextRef: row.authorIdentityRef, ...(i ? { cursor: `directory-${i}` } : {}),
      response: response([{ kind: 'fragment', id: `identity-${name}`, field: name, offset: 0,
        text: '', nextRef: `identity-value-${name}` }], i === 2 ? null : `directory-${i + 1}`) });
    field(`identity-value-${name}`, name, values.authorIdentity[name]);
  });
  return { row, owner, reads, values };
}
const checkAuthorResources = x => summaryContract.assertReplyAuthorResources(x.row, x.owner, x.reads, f.limits);

test('annotation identities: existing reply fixtures cover inline, absent and referenced values', () => {
  assertReplyFrames(f.annotationPages.pages, f.limits, { complete: true });
  const rows = f.annotationPages.pages.flatMap(p => p.result.items);
  assert.equal(rows[0].authorPrincipalId, 'principal-a');
  assert.deepEqual(rows[0].authorIdentity, { provider: 'gitlab', host: 'forge.example:8443', externalUserId: '42' });
  for (const key of ['authorPrincipalId', 'authorIdentity', 'authorPrincipalIdRef', 'authorIdentityRef']) {
    assert.equal(Object.hasOwn(rows[1], key), false);
  }
  assert.equal(rows[2].authorPrincipalIdRef, 'principal-root');
  assert.equal(rows[2].authorIdentityRef, 'identity-root');
});

for (const key of ['authorPrincipalId', 'authorIdentity']) {
  test(`annotation identities: ${key} inline/reference exclusivity and presence`, () => {
    const inline = key === 'authorPrincipalId' ? '' : { provider: 'github', host: 'github.com', externalUserId: '' };
    summaryContract.assertReplyAuthor({});
    summaryContract.assertReplyAuthor({ [key]: inline }); // present empty string is not omission
    summaryContract.assertReplyAuthor({ [`${key}Ref`]: 'opaque' });
    for (const bad of [
      { [key]: inline, [`${key}Ref`]: 'opaque' }, { [key]: null },
      { [`${key}Ref`]: null }, { [`${key}Ref`]: '' }, { [`${key}Ref`]: 'x'.repeat(257) },
    ]) assert.throws(() => summaryContract.assertReplyAuthor(bad));
  });
}

test('annotation identities: inline UTF8 boundaries and exact safe identity shape', () => {
  const row = { authorPrincipalId: '😀'.repeat(64), authorIdentity: {
    provider: 'gitlab', host: 'h'.repeat(1024), externalUserId: '😀'.repeat(256),
  } };
  summaryContract.assertReplyAuthor(row);
  for (const mutate of [
    r => { r.authorPrincipalId += 'a'; }, r => { r.authorIdentity.host += 'a'; },
    r => { r.authorIdentity.externalUserId += 'a'; }, r => { r.authorIdentity.provider = 'other'; },
    r => { r.authorIdentity.token = 'secret'; }, r => { delete r.authorIdentity.host; },
    r => { r.authorIdentity.externalUserId = 42; }, r => { r.authorPrincipalId = '\ud800'; },
  ]) { const bad = structuredClone(row); mutate(bad); assert.throws(() => summaryContract.assertReplyAuthor(bad)); }
});

test('annotation identities: oversized exact values traverse bounded directory and scalar fragments', () => {
  const x = authorResources();
  assert.ok(utf8(x.values.authorPrincipalId) > 256);
  assert.ok(utf8(x.values.authorIdentity.externalUserId) > 1024);
  assert.deepEqual(checkAuthorResources(x), x.values);
  const empty = authorResources({ authorPrincipalId: '', authorIdentity: { provider: 'github', host: 'github.com', externalUserId: '' } });
  assert.deepEqual(checkAuthorResources(empty), empty.values);
  assert.equal(Object.hasOwn(checkAuthorResources(empty), 'authorPrincipalId'), true);
});

for (const key of ['scope', 'sourceRevision', 'commentRevision', 'snapshotId', 'expiresAt']) {
  test(`annotation identities: missing and changed ${key} binding reject directory and scalar responses`, () => {
    for (const directory of [false, true]) for (const remove of [false, true]) {
      const x = authorResources();
      const page = x.reads.find(r => directory ? r.contextRef === x.row.authorIdentityRef : r.contextRef === x.row.authorPrincipalIdRef).response.result;
      if (remove) delete page[key];
      else if (key === 'scope') page.scope = { ...page.scope, noteInstanceId: 'replacement' };
      else page[key] = key === 'expiresAt' ? '2026-10-03T00:06:00.000Z' : 'different';
      assert.throws(() => checkAuthorResources(x));
    }
  });
}

test('annotation identities: missing reference, wrong field, order, cycle and scalar offset reject', () => {
  for (const mutate of [
    x => { x.reads.shift(); },
    x => { x.reads[0].contextRef = 'unrelated-ref'; },
    x => { x.reads[0].response.result.items[0].field = 'body'; },
    x => { x.reads[0].response.result.items[0].nextRef = x.row.authorPrincipalIdRef; },
    x => { x.reads[1].response.result.items[0].offset++; },
    x => { x.reads.find(r => r.contextRef === x.row.authorIdentityRef).response.result.items[0].field = 'externalUserId'; },
    x => { x.reads.find(r => r.contextRef === 'identity-value-provider').response.result.items[0].text = 'other'; },
    x => { x.reads.push(structuredClone(x.reads[0])); },
  ]) { const x = authorResources(); mutate(x); assert.throws(() => checkAuthorResources(x)); }
});

test('annotation identities: actual escaped reply/context frames honor exact wire boundary', () => {
  const pages = structuredClone(f.annotationPages.pages);
  const maxReply = Math.max(...pages.map(wireBytes));
  assertReplyFrames(pages, { ...f.limits, wireBytes: maxReply });
  assert.throws(() => assertReplyFrames(pages, { ...f.limits, wireBytes: maxReply - 1 }));
  const x = authorResources();
  const maxContext = Math.max(...x.reads.map(r => wireBytes(r.response)));
  summaryContract.assertReplyAuthorResources(x.row, x.owner, x.reads, { ...f.limits, wireBytes: maxContext });
  assert.throws(() => summaryContract.assertReplyAuthorResources(x.row, x.owner, x.reads, { ...f.limits, wireBytes: maxContext - 1 }));
});


test('note protocol 13.7 reservation does not advertise partial implementation', () => {
  assert.match(versioning, /\*\*Documented version:\*\* `13\.7`/);
  const section = versioning.split('**Version 13.7 —')[1]?.split('**Version 13.6 —')[0];
  assert.ok(section);
  assert.match(section, /note\.applySplices/);
  assert.match(section, /note\.operationStatus/);
  for (const name of ['begin', 'append', 'seal', 'read', 'commit', 'cancel']) {
    assert.ok(section.includes(name));
  }
  assert.match(section, /451 \/ 395 \/ 56/);
  assert.match(section, /`notePaging: 1` remains absent until the complete core contract/);
  assert.match(section, /all six staged operation methods/);
  assert.match(section, /notePagingBackendId/);
  assert.match(section, /`noteAnnotations: 1` separately requires/);
  assert.ok(!versioning.includes('Allocate the next minor against daemon main at implementation time.'));
});


function paragraphEntryFrame() {
  return { jsonrpc: '2.0', id: 'paragraph\u0000id', result: {
    kind: 'noteContextPage', scope: f.scope, sourceRevision: 'r:7', snapshotId: 'snapshot-a',
    expiresAt: '2026-10-03T00:05:00.000Z',
    items: [structuredClone(f.paragraphEntryPath.paragraph)], nextCursor: null,
  } };
}
test('paragraph entry path: both modes preserve ordinary far lexical identity and details', () => {
  assert.equal(f.paragraphEntryPath.status, 'controlled-shape-fixture-not-store-capture');
  for (const entryPath of f.paragraphEntryPath.entryPaths) {
    const frame = paragraphEntryFrame();
    frame.result.items[0].entryPath = entryPath;
    summaryContract.assertContextFrame(frame, f.limits);
    const { entryPath: mode, ...ordinary } = frame.result.items[0];
    assert.equal(mode, entryPath);
    assert.deepEqual(ordinary, f.paragraphEntryPath.paragraph);
    for (const key of ['nativeRef', 'sourceMapRef', 'profile', 'profileVersion'])
      assert.equal(frame.result.items[0][key], undefined);
  }
});
test('paragraph entry path: absence remains valid without manufacturing a mode', () => {
  const frame = paragraphEntryFrame();
  summaryContract.assertContextFrame(frame, f.limits);
  assert.equal(Object.hasOwn(frame.result.items[0], 'entryPath'), false);
  assert.match(docs, /Absence means \*\*unknown\*\*/);
});
test('paragraph entry path: present null, non-string and unsupported values reject', () => {
  for (const value of [null, false, 1, {}, [], '', 'Markdown', 'plain_text', 'markdownBlock']) {
    const frame = paragraphEntryFrame(); frame.result.items[0].entryPath = value;
    assert.throws(() => summaryContract.assertContextFrame(frame, f.limits));
  }
});
test('paragraph entry path: complete escaped frame accounting includes the added field', () => {
  for (const entryPath of f.paragraphEntryPath.entryPaths) {
    const frame = paragraphEntryFrame(); frame.result.items[0].entryPath = entryPath;
    const bytes = wireBytes(frame);
    summaryContract.assertContextFrame(frame, { ...f.limits, wireBytes: bytes });
    assert.throws(() => summaryContract.assertContextFrame(frame, { ...f.limits, wireBytes: bytes - 1 }));
  }
});
test('paragraph entry path: documented authority remains document-wide and snapshot-bound', () => {
  const section = docs.split('**Paragraph document entry path')[1]?.split('**Absolute table addresses.**')[0];
  assert.ok(section);
  for (const text of ['complete source', '<!--anchor:', 'ws-block', 'original expiry',
    'source revision', 'snapshot', 'incarnation', 'without hydrating', 'safe-edit proof',
    'full `notePaging: 1` activation gate remains unchanged']) assert.ok(section.includes(text), text);
});


test('paragraph entry policy: explicit renderer predicate includes trim and whole-source edge cases', () => {
  // Reference expectations for cross-language producer captures, not Store execution.
  const classify = source => source.trim().startsWith('<')
    && !source.trim().startsWith('<!--anchor:') && !source.includes('```ws-block')
    ? 'html' : 'markdown';
  for (const [source, expected] of [
    ['abc', 'markdown'], ['abc\n\ndef', 'markdown'], ['<p>abc</p>\n\ndef', 'html'],
    ['\uFEFF<p>abc</p>', 'html'], ['\u0085<p>abc</p>', 'markdown'],
    [' '.repeat(20000) + '<p>abc</p>', 'html'],
    ['<!--anchor:x--><p>abc</p>', 'markdown'],
    ['<p>abc</p>' + 'x'.repeat(20000) + '```ws-block', 'markdown'],
    ['<p>inline ```ws-block text</p>', 'markdown'],
    ['<p>inline ```WS-BLOCK text</p>', 'html'],
  ]) assert.equal(classify(source), expected);
  assert.ok(docs.includes('ECMAScript `String.prototype.trim()`'));
  assert.ok(docs.includes('including U+FEFF, excluding U+0085'));
  assert.ok(docs.includes('not only at a parsed fence boundary'));
});


test('inverse history groups preserve staged and inline opaque string identities', () => {
  for (const row of f.staged.inverse) summaryContract.assertInverseHistoryGroup(row.historyGroup);
  const groups = ['paste', '0', '00', 'é'.repeat(128)];
  for (const group of groups) summaryContract.assertInverseHistoryGroup(group);
  assert.equal(new Set(groups).size, 4);
  assert.equal(f.staged.inverse[0].historyGroup, 'paste');
  for (const invalid of [0, 1, null, false, {}, [], '', 'x'.repeat(257), 'é'.repeat(129)])
    assert.throws(() => summaryContract.assertInverseHistoryGroup(invalid));
});

function receiptDetailFixture() {
  const receipt = { scope: f.scope, operationId: 'receipt-operation', payloadDigest: 'a'.repeat(64),
    receiptExpiresAt: '2026-10-03T01:00:00.000Z' };
  return { receipt, request: { ...receipt.scope, operationId: receipt.operationId,
    payloadDigest: receipt.payloadDigest, kind: 'detail', ref: 'inverse-provenance' },
  refs: ['inverse-provenance', 'canonical-effect-detail', 'nested-text'],
  now: Date.parse('2026-10-03T00:30:00.000Z') };
}
test('inline details resolve inverse/effect/nested refs with receipt lifetime', () => {
  const x = receiptDetailFixture();
  for (const ref of x.refs) summaryContract.assertInlineReceiptDetail(
    { ...x.request, ref }, x.receipt, x.refs, x.now);
  // No live source revision or still-live staging view is needed for retained receipt data.
  assert.equal(x.request.sourceRevision, undefined);
  assert.equal(x.request.headerDigest, undefined);
  assert.ok(docs.includes('`effects` and `detail` reads by'));
  assert.ok(docs.includes('receipt effect detailRef (including sourceEffect)'));
});
test('inline details reject foreign receipt identity, unreachable refs and exact expiry', () => {
  const x = receiptDetailFixture();
  for (const patch of [
    ...Object.keys(f.scope).map(key => ({ [key]: 'foreign' })),
    { operationId: 'other' }, { payloadDigest: 'b'.repeat(64) }, { payloadDigest: undefined },
    { kind: 'inverse' }, { ref: 'foreign-ref' }, { ref: '' },
    { headerDigest: 'c'.repeat(64) }, { viewId: 'staged-view' },
  ]) assert.throws(() => summaryContract.assertInlineReceiptDetail(
    { ...x.request, ...patch }, x.receipt, x.refs, x.now));
  // A known spelling elsewhere cannot establish reachability from this owner.
  assert.throws(() => summaryContract.assertInlineReceiptDetail(x.request, x.receipt, [], x.now));
  for (const now of [Date.parse(x.receipt.receiptExpiresAt), Date.parse(x.receipt.receiptExpiresAt) + 1])
    assert.throws(() => summaryContract.assertInlineReceiptDetail(x.request, x.receipt, x.refs, now));
});


test('logical replacement guard preserves existing leading-run and trailer recognition', () => {
  for (const text of ['   1 | first\n   2 | second', '  12 | first\n  13 |',
    '9999 | first\n10000 | next', '   1 | first\n   2 | second\nordinary tail',
    '\n\n--- Task Metadata ---\nstatus: open']) {
    assert.equal(summaryContract.isNumberedReadPresentation(text), true);
    assert.equal(spliceError('base', [{ start: 0, end: 4, text }], f.limits), 'invalid-params');
  }
  for (const text of ['1. first\n2. second', '1 | Alice\n2 | Bob', '| 1 | a |\n| 2 | b |',
    '    1 | code\n    2 | code', '   1 | single', '1|a\n2|b',
    'prose\n   1 | a\n   2 | b', '```\n   1 | a\n   2 | b\n```', '']) {
    assert.equal(summaryContract.isNumberedReadPresentation(text), false);
    assert.equal(spliceError('base', [{ start: 0, end: 4, text }], f.limits), null);
  }
});
test('logical replacement guard rejects a later bad splice before applying any batch', () => {
  const base = 'first second';
  const splices = [{ start: 0, end: 5, text: 'changed' },
    { start: 6, end: 12, text: '   1 | a\n   2 | b' }];
  const before = structuredClone(splices), payloadHash = digest(splices);
  const error = spliceError(base, splices, f.limits);
  const result = error ? base : applySourceSplices(base, splices);
  assert.equal(error, 'invalid-params'); assert.equal(result, base);
  assert.deepEqual(splices, before); assert.equal(digest(splices), payloadHash);
});
test('logical replacement guard neither scans untouched base nor combines independent splices', () => {
  const base = '   1 | first\n   2 | second';
  const repair = [{ start: base.length, end: base.length, text: ' repaired' }];
  assert.equal(spliceError(base, repair, f.limits), null);
  assert.equal(applySourceSplices(base, repair), base + ' repaired');
  const splices = [{ start: 0, end: 1, text: '   1 | a\n' },
    { start: 1, end: 2, text: '   2 | b' }];
  assert.equal(spliceError('ab', splices, f.limits), null);
  assert.equal(summaryContract.isNumberedReadPresentation(applySourceSplices('ab', splices)), true);
});
test('staged logical replacement guard is independent of every scalar-safe chunk seam', () => {
  for (const text of ['   1 | a😀\n   2 | b', '```\n   1 | a\n   2 | b\n```',
    '\n\n--- Task Metadata ---\nstatus: open']) {
    const expected = summaryContract.isNumberedReadPresentation(text);
    for (let at = 0; at <= text.length; at++) {
      if (!boundary(text, at)) continue;
      // Fixture reassembly only, not permission for full production hydration.
      const chunks = [text.slice(0, at), text.slice(at)];
      assert.equal(summaryContract.isNumberedReadPresentation(chunks.join('')), expected);
      assert.equal(digest(chunks.join('')), digest(text));
    }
  }
});
test('logical replacement guard preserves historical replay and exact bytes by contract', () => {
  const section = docs.split('**Numbered-read guard on logical replacements.**')[1]?.split('`operationId` is')[0];
  assert.ok(section);
  for (const text of ['existing unchanged', 'each `splices[].text`', 'reject the whole batch',
    'complete logical', 'Do not strip prefixes', 'combine independent splices',
    'Retained historical receipt replay', 'existing ordering']) assert.ok(section.includes(text), text);
});


const stagedMetadataFixture = JSON.parse(await readFile(new URL('./staged-metadata.json', import.meta.url), 'utf8'));
const { assertStagedMetadataUpload } = await import('./staged-metadata.mjs');
const metadataClone = () => structuredClone(stagedMetadataFixture);
const resource = (f, id) => f.texts.find(r => r.id === id);
const rewriteMetadata = (f, id, change) => {
  const r = resource(f, id), v = JSON.parse(r.text); change(v);
  r.text = canonicalJson(v);
};
test('staged metadata upload resolves distinct entry/text identities, nested and empty containers', () => {
  const f = metadataClone(), result = assertStagedMetadataUpload(f);
  assert.equal(f.status, 'controlled-upload-graph-not-runtime-proof');
  assert.deepEqual([...result.entryIds].sort(), [...f.expectedEntryIds].sort());
  assert.ok(result.readTextIds.includes('scalar-shared'));
  assert.ok(!result.parsedTextIds.includes('scalar-shared'));
  assert.ok(!result.readTextIds.includes('unreachable-upload'));
  assert.equal(result.parsedTextIds.filter(id => id === 'text-root').length, 1);
});
test('staged metadata upload follows only owned explicit references including empty directories', () => {
  for (const id of ['text-root', 'dir-root-b', 'dir-empty-array', 'scalar-long-key', 'scalar-shared']) {
    const missing = metadataClone(); missing.texts = missing.texts.filter(r => r.id !== id);
    assert.throws(() => assertStagedMetadataUpload(missing));
    const foreign = metadataClone(); resource(foreign, id).operationId = 'another-operation';
    assert.throws(() => assertStagedMetadataUpload(foreign));
  }
  const unused = metadataClone(); resource(unused, 'unreachable-upload').text = '{invalid';
  assertStagedMetadataUpload(unused);
});
test('staged metadata upload rejects aliases, duplicate identities, cycles and multiple owners', () => {
  const mutations = [
    f => rewriteMetadata(f, 'text-root', e => { e.childrenRef = 'text-array'; }),
    f => rewriteMetadata(f, 'text-array', e => { e.parentId = 'text-root'; }),
    f => rewriteMetadata(f, 'text-title', e => { e.id = 'entry-array'; }),
    f => rewriteMetadata(f, 'dir-root-b', d => { d.items.push('text-title'); }),
    f => rewriteMetadata(f, 'dir-root-b', d => { d.nextRef = 'dir-root-a'; }),
    f => rewriteMetadata(f, 'dir-array', d => { d.items[0] = 'text-root'; }),
    f => rewriteMetadata(f, 'text-empty-object', e => { e.childrenRef = 'dir-empty-array'; }),
    f => rewriteMetadata(f, 'dir-array', d => { d.items[0] = 'text-title'; }),
  ];
  for (const mutate of mutations) { const f = metadataClone(); mutate(f); assert.throws(() => assertStagedMetadataUpload(f)); }
});
test('staged metadata upload rejects malformed entries/directories and non-progressing empty continuations', () => {
  const mutations = [
    f => rewriteMetadata(f, 'text-root', e => { e.key = 'root-is-not-member'; }),
    f => rewriteMetadata(f, 'text-title', e => { e.keyRef = 'scalar-long-key'; }),
    f => rewriteMetadata(f, 'text-title', e => { e.value = 'not-inline'; }),
    f => rewriteMetadata(f, 'text-null', e => { delete e.value; }),
    f => rewriteMetadata(f, 'text-null', e => { e.value = ''; }),
    f => rewriteMetadata(f, 'dir-root-a', d => { d.kind = 'children'; }),
    f => rewriteMetadata(f, 'dir-root-a', d => { d.extra = true; }),
    f => rewriteMetadata(f, 'dir-root-b', d => { delete d.nextRef; }),
    f => rewriteMetadata(f, 'dir-root-a', d => { d.items = []; }),
    f => rewriteMetadata(f, 'dir-root-b', d => { d.items = []; }),
    f => rewriteMetadata(f, 'dir-empty-array', d => { d.nextRef = 'dir-array'; }),
    f => { resource(f, 'dir-root-a').text += '\n'; },
    f => { const r = resource(f, 'text-root'); r.text = r.text.replace('{', '{"id":"discarded",'); },
  ];
  for (const mutate of mutations) { const f = metadataClone(); mutate(f); assert.throws(() => assertStagedMetadataUpload(f)); }
});
test('staged metadata sibling order spans directory pages and uses decoded scalar keys, not text IDs', () => {
  for (const mutate of [
    f => rewriteMetadata(f, 'dir-root-b', d => { d.items.reverse(); }),
    f => rewriteMetadata(f, 'text-long-key', e => { delete e.keyRef; e.key = 'title'; }),
    f => { resource(f, 'scalar-long-key').text = 'title'; },
    f => rewriteMetadata(f, 'text-null', e => { e.index = 2; }),
  ]) { const f = metadataClone(); mutate(f); assert.throws(() => assertStagedMetadataUpload(f)); }
  const f = metadataClone();
  rewriteMetadata(f, 'dir-root-a', d => { d.items = ['text-title']; });
  rewriteMetadata(f, 'dir-root-b', d => { d.items = ['text-long-key']; });
  rewriteMetadata(f, 'text-title', e => { e.key = '\uE000'; });
  resource(f, 'scalar-long-key').text = '\u{10000}';
  // Unicode scalar/UTF8 order differs from JS UTF16 .sort() for this pair.
  assert.deepEqual(['\uE000', '\u{10000}'].sort(), ['\u{10000}', '\uE000']);
  assertStagedMetadataUpload(f);
  rewriteMetadata(f, 'text-title', e => { e.key = '\u{10000}'; });
  resource(f, 'scalar-long-key').text = '\uE000';
  assert.throws(() => assertStagedMetadataUpload(f));
});
function metadataDirectoryFixture(count) {
  const owner = 'operation', items = Array.from({ length: count }, (_, i) => `child-${i}`);
  const texts = [{ id: 'root', operationId: owner, text: canonicalJson({ id: 'root-entry', parentId: null, type: 'array', childrenRef: 'children' }) },
    { id: 'children', operationId: owner, text: '' },
    ...items.map((id, index) => ({ id, operationId: owner, text: canonicalJson({ id: `entry-${index}`, parentId: 'root-entry', index, type: 'null', value: null }) }))];
  const f = { operationId: owner, roots: ['root'], texts };
  const update = () => { resource(f, 'children').text = canonicalJson({ kind: 'metadataChildren', items, nextRef: null }); };
  update(); return { f, items, update };
}
test('staged metadata directory item and exact escaped logical-byte ceilings are independent', () => {
  assertStagedMetadataUpload(metadataDirectoryFixture(64).f);
  assert.throws(() => assertStagedMetadataUpload(metadataDirectoryFixture(65).f));
  const { f, items, update } = metadataDirectoryFixture(64);
  // Escaped control bytes stress encoded JSON; text IDs remain valid and <=256 raw UTF8 bytes.
  for (let i = 0; i < items.length; i++) { items[i] = `child-${i}-` + '\u0001'.repeat(30); f.texts[i + 2].id = items[i]; }
  update();
  while (utf8(resource(f, 'children').text) < 16384) {
    const i = items.findIndex(id => utf8(id) < 256); assert.ok(i >= 0);
    items[i] += 'x'; f.texts[i + 2].id = items[i]; update();
  }
  assert.equal(utf8(resource(f, 'children').text), 16384); assertStagedMetadataUpload(f);
  const i = items.findIndex(id => utf8(id) < 256); assert.ok(i >= 0);
  items[i] += 'x'; f.texts[i + 2].id = items[i]; update();
  assert.equal(utf8(resource(f, 'children').text), 16385);
  assert.throws(() => assertStagedMetadataUpload(f));
});
test('staged metadata logical resources are chunk-independent and large scalar values remain separate', () => {
  const f = metadataClone(); resource(f, 'scalar-shared').text = '😀'.repeat(5000);
  const expected = assertStagedMetadataUpload(f);
  for (const id of ['text-root', 'dir-root-a', 'scalar-shared']) {
    const r = resource(f, id), whole = r.text;
    for (const at of [0, 1, Math.floor(whole.length / 2), whole.length]) {
      if (!boundary(whole, at)) continue;
      r.chunks = [whole.slice(0, at), whole.slice(at)]; delete r.text;
      assert.deepEqual(assertStagedMetadataUpload(f), expected);
      delete r.chunks; r.text = whole;
    }
  }
});

test('staged metadata keys preserve empty and prefix order and reject invalid Unicode scalars', () => {
  const f = metadataClone();
  rewriteMetadata(f, 'dir-root-a', d => { d.items = ['text-title']; });
  rewriteMetadata(f, 'dir-root-b', d => { d.items = ['text-long-key']; });
  for (const [first, second] of [['', 'a'], ['a', 'aa']]) {
    rewriteMetadata(f, 'text-title', e => { e.key = first; });
    resource(f, 'scalar-long-key').text = second;
    assertStagedMetadataUpload(f);
    rewriteMetadata(f, 'text-title', e => { e.key = second; });
    resource(f, 'scalar-long-key').text = first;
    assert.throws(() => assertStagedMetadataUpload(f));
  }
  for (const bad of ['\0', '\uD800', '\uDC00']) {
    const inline = metadataClone();
    rewriteMetadata(inline, 'text-title', e => { e.key = bad; });
    assert.throws(() => assertStagedMetadataUpload(inline));
    const referenced = metadataClone(); resource(referenced, 'scalar-long-key').text = bad;
    assert.throws(() => assertStagedMetadataUpload(referenced));
    const value = metadataClone(); resource(value, 'scalar-shared').text = bad;
    assert.throws(() => assertStagedMetadataUpload(value));
  }
});

const { assertStagedMarkerOccurrence } = await import('./contract.mjs');
test('staged markers bind individual literals and canonical comment IDs, preserving repeated occurrences', () => {
  const m = f.stagedMarkerOccurrences;
  assert.equal(m.status, 'controlled-resolved-descriptors-not-provenance-or-native-map-proof');
  for (const o of m.occurrences) {
    assertStagedMarkerOccurrence(o.record, o.descriptor, o.attributes, m.source);
    assert.equal(o.detailText, canonicalJson(o.descriptor));
    assert.equal(o.record.detail.sha256, createHash('sha256').update(o.detailText).digest('hex'));
    assert.equal(o.record.detail.length, o.detailText.length);
    assert.equal(o.record.detail.utf8Bytes, utf8(o.detailText));
  }
  const [first, , , repeated] = m.occurrences;
  assert.equal(first.record.canonicalId, repeated.record.canonicalId);
  assert.equal(first.attributes.id, repeated.attributes.id);
  assert.notDeepEqual(first.record.sourceRange, repeated.record.sourceRange);
  assert.notEqual(first.record.ordinal, repeated.record.ordinal);
});
test('staged markers reject pair/body/whitespace/partial ranges and split Unicode endpoints', () => {
  const m = f.stagedMarkerOccurrences;
  for (const range of [
    { start: m.occurrences[0].record.sourceRange.start, end: m.occurrences[1].record.sourceRange.end },
    { start: m.occurrences[0].record.sourceRange.end, end: m.occurrences[1].record.sourceRange.start },
    { start: m.occurrences[0].record.sourceRange.start - 1, end: m.occurrences[0].record.sourceRange.end },
    { start: m.occurrences[0].record.sourceRange.start + 1, end: m.occurrences[0].record.sourceRange.end },
    { start: 1, end: m.occurrences[0].record.sourceRange.end },
  ]) {
    const o = structuredClone(m.occurrences[0]); o.record.sourceRange = range;
    assert.throws(() => assertStagedMarkerOccurrence(o.record, o.descriptor, o.attributes, m.source));
  }
});
test('staged markers reject atom-ID aliases, guessed attributes, wrong type/schema/width and parent', () => {
  const m = f.stagedMarkerOccurrences;
  for (const mutate of [
    o => { o.record.canonicalId = o.attributes.id; },
    o => { o.attributes.commentId = 'different'; },
    o => { o.attributes.id = o.record.canonicalId; },
    o => { o.attributes.type = 'point'; o.attributes.id = `${o.record.canonicalId}:point`; },
    o => { delete o.attributes.type; }, o => { delete o.attributes.id; },
    o => { delete o.attributes.commentId; }, o => { delete o.descriptor.attributesRef; },
    o => { o.descriptor.nodeType = 'text'; }, o => { o.descriptor.version = 2; },
    o => { o.descriptor.nativeRange.to++; }, o => { o.descriptor.nativeRange.to--; },
    o => { o.descriptor.parentOrdinal = o.record.ordinal; },
  ]) {
    const o = structuredClone(m.occurrences[0]); mutate(o);
    assert.throws(() => assertStagedMarkerOccurrence(o.record, o.descriptor, o.attributes, m.source));
  }
});
test('staged marker shape preserves renderer identifier spelling without claiming canonical authority', () => {
  const o = structuredClone(f.stagedMarkerOccurrences.occurrences[2]);
  // Shape-only input: this lookalike has no supplied retained provenance and
  // cannot be treated as a live canonical comment merely because this oracle accepts it.
  o.record.canonicalId = 'legacy-comment';
  o.attributes = { id: 'legacy-comment:point', type: 'point', commentId: 'legacy-comment' };
  const source = '<!--anchor:legacy-comment:point-->';
  o.record.sourceRange = { start: 0, end: source.length };
  assertStagedMarkerOccurrence(o.record, o.descriptor, o.attributes, source);
  assert.match(docs, /Matching literal text, `canonicalId`, and attributes is necessary but does not/);
  assert.match(docs, /Non-UUID lookalikes\nremain ordinary source unless independent retained provenance establishes a marker/);
});

const { assertCapturedViewOutput } = await import('./contract.mjs');
test('staged primary output kind stays bound to the captured header across first and continued reads', () => {
  const kinds = ['source', 'selectionMarkdown', 'search'];
  for (const output of kinds) for (const action of ['read', 'mutate'])
    for (const selection of ['all', 'ranges']) {
      const header = { ...f.staged.header, output, action, selection };
      for (const continuation of [false, true]) {
        // Cursor ownership and persisted header lookup remain separate runtime requirements.
        const request = { kind: output, ...(continuation ? { cursor: 'owned-cursor' } : {}) };
        assertCapturedViewOutput(header, request.kind, output);
        for (const wrong of kinds.filter(k => k !== output)) {
          assert.throws(() => assertCapturedViewOutput(header, wrong, output));
          assert.throws(() => assertCapturedViewOutput(header, output, wrong));
          assert.throws(() => assertCapturedViewOutput(header, wrong, wrong));
        }
      }
    }
});
test('unavailable staged adapters do not create a source fallback or constrain receipt selectors', () => {
  for (const output of ['selectionMarkdown', 'search'])
    assert.throws(() => assertCapturedViewOutput({ output }, 'source', 'source'));
  for (const output of [undefined, 'inverse', 'detail', 'SOURCE'])
    assert.throws(() => assertCapturedViewOutput({ output }, 'source', 'source'));
  assert.match(docs, /unavailable selected adapter must not fall back to `source`/);
  assert.match(docs, /This equality does not change the separately addressed receipt reads or reachable/);
  assert.match(docs, /A captured `source` output remains the exact frozen source without selection/);
});

test('staged inverse composes canonical outside-range changes into the newest original group', () => {
  // Controlled source algebra, not a canonical writer, native history owner or provenance proof.
  const base = 'ab', first = 'aXb', second = 'aXYb', canonical = '[aXYb]';
  const originalGroups = ['typed-first', 'typed-second'];
  const inverse = [
    { historyGroup: originalGroups[1], input: canonical, output: first, splices: [
      { start: 0, end: 1, text: '' }, { start: 3, end: 4, text: '' }, { start: 5, end: 6, text: '' },
    ] },
    { historyGroup: originalGroups[0], input: first, output: base, splices: [{ start: 1, end: 2, text: '' }] },
  ];
  assert.equal(applySourceSplices(base, [{ start: 1, end: 1, text: 'X' }]), first);
  assert.equal(applySourceSplices(first, [{ start: 2, end: 2, text: 'Y' }]), second);
  assert.deepEqual(inverse.map(g => g.historyGroup), [...originalGroups].reverse());
  let current = canonical;
  for (const group of inverse) {
    summaryContract.assertInverseHistoryGroup(group.historyGroup);
    assert.equal(current, group.input);
    current = applySourceSplices(current, group.splices);
    assert.equal(current, group.output);
  }
  assert.equal(current, base);
  assert.notEqual(applySourceSplices(canonical, [{ start: 3, end: 4, text: '' }]), first);
  assert.match(docs, /do not drop them, flatten earlier groups, or invent a\nseparate native gesture/);
});
test('zero-user-group commits retain an empty inverse or one receipt-owned canonical-source inverse', () => {
  const capturedNativeGroups = [], base = 'ab';
  const unchanged = { source: base, inverseRef: 'owned-empty-inverse', groups: [] };
  assert.equal(unchanged.source, base); assert.equal(unchanged.groups.length, 0);
  const changed = { source: '[ab]', inverseRef: 'owned-operation-inverse', groups: [{
    historyGroup: 'operation-only', input: '[ab]', output: base,
    splices: [{ start: 0, end: 1, text: '' }, { start: 3, end: 4, text: '' }],
  }] };
  const group = changed.groups[0]; summaryContract.assertInverseHistoryGroup(group.historyGroup);
  assert.equal(applySourceSplices(group.input, group.splices), group.output);
  assert.equal(group.output, base); assert.equal(capturedNativeGroups.length, 0);
  assert.match(docs, /receipt owns an explicitly empty inverse collection/);
  assert.match(docs, /That group represents\nthis committed operation, not an invented captured native gesture/);
  assert.match(docs, /No reserved group spelling or new wire discriminator is introduced/);
});
