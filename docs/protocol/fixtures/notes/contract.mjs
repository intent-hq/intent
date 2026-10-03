// Specification arithmetic and validators only. No daemon/store implementation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../../scripts/check-transfer-selection-contract.mjs';

export const utf8 = value => Buffer.byteLength(value, 'utf8');
export const wireBytes = value => utf8(JSON.stringify(value));
export const digest = value => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
export const boundary = (text, offset) => Number.isSafeInteger(offset) && offset >= 0
  && offset <= text.length && !(offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]));
export const validText = text => typeof text === 'string' && !text.includes('\0')
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

export function spliceError(source, splices, limits) {
  if (!Array.isArray(splices) || !splices.length) return 'invalid-params';
  if (splices.length > limits.splices) return 'note-page-budget';
  let previous;
  for (const s of splices) {
    if (!boundary(source, s.start) || !boundary(source, s.end) || s.start > s.end
      || !validText(s.text) || (previous && (previous.end > s.start || previous.start >= s.start))) {
      return 'invalid-params';
    }
    previous = s;
  }
  return splices.reduce((bytes, s) => bytes + utf8(s.text), 0) > limits.sourceBytes
    ? 'note-page-budget' : null;
}

export function applySourceSplices(source, splices) {
  return splices.reduceRight((text, s) => text.slice(0, s.start) + s.text + text.slice(s.end), source);
}

export function mapPoint(point, affinity, changes) {
  let delta = 0;
  for (const c of changes) {
    if (point < c.start) break;
    if (point < c.end || (c.start === c.end && point === c.start)) {
      return { offset: c.start + delta + (affinity === 'after' ? c.insertedLength : 0),
        deleted: point > c.start && point < c.end };
    }
    delta += c.insertedLength - (c.end - c.start);
  }
  return { offset: point + delta, deleted: false };
}

export function assertSourcePage(source, frame, limits, request = { direction: 'forward' }) {
  const p = frame.result;
  assert.equal(p.kind, 'noteSourcePage');
  assert.equal(p.note, undefined);
  assert.equal(p.content, undefined);
  assert.equal(p.sourceLength, source.length);
  assert.ok(boundary(source, p.range.start) && boundary(source, p.range.end));
  assert.ok(p.range.start <= p.range.end);
  assert.equal(p.text, source.slice(p.range.start, p.range.end));
  assert.ok(validText(p.text));
  assert.equal(p.nextCursor === null, p.range.end === source.length);
  assert.equal(p.previousCursor === null, p.range.start === 0);
  assert.ok(['forward', 'backward'].includes(request.direction));
  if (request.at !== undefined) {
    assert.ok(boundary(source, request.at));
    assert.equal(request.direction === 'backward' ? p.range.end : p.range.start, request.at);
  }
  assert.ok(p.text.length > 0 || p.range.start === (request.direction === 'backward' ? 0 : source.length));
  assert.ok(utf8(p.text) <= limits.sourceBytes);
  assert.ok(wireBytes(frame) <= limits.wireBytes);
}

// Test-only decoded cursor claims, never an on-wire token format.
export function cursorError(claim, request, current, now) {
  const keys = ['backendId', 'workspaceId', 'noteId', 'noteInstanceId', 'principalId', 'kind', 'budgets', 'ranges', 'threadId', 'contextRef'];
  if (keys.some(k => canonicalJson(claim[k] ?? null) !== canonicalJson(request[k] ?? null))) {
    return 'note-page-cursor-invalid';
  }
  if (claim.expiresAt <= now || claim.boot !== current.boot
    || claim.profileRevision !== current.profileRevision) return 'note-page-expired';
  if (claim.sourceRevision !== current.sourceRevision
    || (claim.attributionGeneration !== undefined && claim.attributionGeneration !== current.attributionGeneration)
    || (claim.commentRevision !== undefined && claim.commentRevision !== current.commentRevision)) {
    return 'note-page-stale';
  }
  return null;
}

export function overlapIds(anchors, ranges) {
  return [...new Set(anchors.filter(a => ranges.some(r => a.start === a.end
    ? r.start <= a.start && a.start < r.end : a.start < r.end && a.end > r.start))
    .map(a => a.canonicalId))].sort();
}

export function assertRanges(ranges, maxRanges) {
  assert.ok(ranges.length <= maxRanges);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    assert.ok(Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 0 && r.start < r.end);
    if (i) assert.ok(ranges[i - 1].end < r.start);
  }
}

// Validate recorded scenario transitions; does not execute persistence or emulate RPC.
export function assertOperationTrace(trace) {
  const receipts = new Map();
  let commits = 0;
  for (const row of trace.steps) {
    const key = row.operationId;
    const prior = receipts.get(key);
    if (row.outcome === 'committed') {
      if (prior) {
        assert.equal(row.digest, prior.digest);
        assert.deepEqual(row.receipt, prior.receipt);
        assert.equal(row.writeCount, 0);
        assert.equal(row.historyCount, 0);
        assert.equal(row.eventCount, 0);
      } else {
        assert.equal(row.writeCount, 1);
        assert.equal(row.historyCount, 1);
        assert.equal(row.eventCount, 1);
        assert.ok(row.atomicReceipt);
        assert.ok(row.receipt.beforeRevision !== row.receipt.afterRevision);
        receipts.set(key, row);
        commits++;
      }
    } else {
      assert.equal(row.writeCount, 0);
      assert.equal(row.historyCount, 0);
      assert.equal(row.eventCount, 0);
      assert.equal(row.draftRetained, true);
      if (row.error === 'note-operation-mismatch') {
        assert.ok(prior);
        assert.notEqual(row.digest, prior.digest);
      }
    }
    // Queue drain, missing ack, conflict and pending are never a clear-draft signal.
    if (!row.acknowledged || row.outcome !== 'committed') assert.equal(row.clearDraft, false);
  }
  assert.equal(commits, trace.expectedCommits);
}

export function admitState(current, incoming) {
  assertScope(incoming.scope);
  if (current && scopeKeys.some(k => incoming.scope[k] !== current.scope[k])) return current;
  assert.match(incoming.stateGeneration, /^(0|[1-9][0-9]*)$/);
  const generation = BigInt(incoming.stateGeneration);
  assert.ok(generation <= 18446744073709551615n);
  if (!current || generation > BigInt(current.stateGeneration)) return incoming;
  if (generation === BigInt(current.stateGeneration)) assert.deepEqual(incoming, current);
  return current;
}

// Validate finite staged fixtures, not a durable staging server.
export function assertStream(chunks, expected, limits, frames) {
  assert.ok(Array.isArray(frames), 'complete append RPC frames are required');
  assert.equal(frames.length, chunks.length);
  let previousDigest = null, records = 0;
  for (const [sequence, chunk] of chunks.entries()) {
    const frame = frames[sequence];
    assertAppendFrame(frame, limits);
    const { backendId, workspaceId, noteId, noteInstanceId, operationId, headerDigest, ...wireChunk } = frame.params;
    assert.deepEqual(wireChunk, chunk);
    if (sequence) for (const key of [...scopeKeys, 'operationId', 'headerDigest']) {
      assert.equal(frame.params[key], frames[0].params[key]);
    }
    assert.equal(chunk.sequence, sequence);
    assert.equal(chunk.stream, expected.stream);
    assert.equal(chunk.previousDigest, previousDigest);
    const { chunkDigest, ...payload } = chunk;
    assert.equal(digest(payload), chunkDigest);
    assert.ok(chunk.records.length <= limits.items);
    assert.ok(chunk.records.reduce((n, r) => n + utf8(r.text ?? ''), 0) <= limits.sourceBytes);
    previousDigest = chunkDigest;
    records += chunk.records.length;
  }
  assert.equal(expected.chunks, chunks.length);
  assert.equal(expected.records, records);
  assert.equal(expected.lastDigest, previousDigest);
}

export function frozenSource(base, groups, fence, textById, limits) {
  let lastSequence = -1;
  return groups.reduce((source, group) => {
    assert.ok(group.localSequence > lastSequence && group.localSequence <= fence);
    lastSequence = group.localSequence;
    const splices = group.splices.map(s => ({ ...s, text: textById[s.textId] }));
    // Group/item streaming removes the inline total-input cap, not scalar/range rules.
    assert.equal(spliceError(source, splices, { ...limits, splices: Number.MAX_SAFE_INTEGER,
      sourceBytes: Number.MAX_SAFE_INTEGER }), null);
    return applySourceSplices(source, splices);
  }, base);
}

export function assertUnchangedGaps(before, after, splices) {
  let input = 0, output = 0;
  for (const s of splices) {
    const gap = before.slice(input, s.start);
    assert.equal(after.slice(output, output + gap.length), gap);
    output += gap.length;
    assert.equal(after.slice(output, output + s.text.length), s.text);
    output += s.text.length;
    input = s.end;
  }
  assert.equal(after.slice(output), before.slice(input));
}

const scopeKeys = ['backendId', 'workspaceId', 'noteId', 'noteInstanceId'];
const token = value => assert.ok(typeof value === 'string' && value.length > 0 && utf8(value) <= 256);
export function assertScope(scope) {
  assert.ok(scope && typeof scope === 'object');
  for (const key of scopeKeys) token(scope[key]);
}
const rpcId = id => assert.ok(Number.isSafeInteger(id) || (typeof id === 'string' && utf8(id) <= 64));
const timestamp = value => assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)));
const cursor = value => value === null ? undefined : token(value);

// Complete wire validation is mandatory; hash-chain arithmetic alone is insufficient.
export function assertAppendFrame(frame, limits) {
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.method, 'note.operation.append');
  rpcId(frame.id);
  const p = frame.params;
  assertScope(p);
  assert.match(p.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  for (const key of ['headerDigest', 'chunkDigest']) assert.match(p[key], /^[0-9a-f]{64}$/);
  assert.ok(['text', 'dirty', 'selection', 'mutation', 'live'].includes(p.stream));
  assert.ok(Number.isSafeInteger(p.sequence) && p.sequence >= 0);
  if (p.previousDigest !== null) assert.match(p.previousDigest, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(p.records) && p.records.length <= limits.items);
  if (p.stream === 'text') for (const row of p.records) {
    assert.equal(row.kind, 'text'); token(row.id);
    assert.ok(Number.isSafeInteger(row.offset) && row.offset >= 0);
    assert.ok(validText(row.text));
  }
  assert.ok(p.records.reduce((n, r) => n + utf8(r.text ?? ''), 0) <= limits.sourceBytes);
  assert.ok(wireBytes(frame) <= limits.wireBytes, 'complete append RPC exceeds wire budget');
}

export function assertSnapshotResult(page) {
  assertScope(page.scope);
  token(page.sourceRevision); token(page.snapshotId); timestamp(page.expiresAt);
  cursor(page.nextCursor);
  assert.ok(Array.isArray(page.items));
}

export function assertMetadataFrame(frame, limits) {
  assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
  const p = frame.result;
  assert.equal(p.kind, 'noteMetadataPage'); assertSnapshotResult(p);
  assert.ok(p.items.length <= limits.items);
  assert.ok(wireBytes(frame) <= limits.wireBytes);
}

export function assertReplyFrames(frames, limits, { complete = false } = {}) {
  let previous, first;
  const seen = new Set();
  for (const frame of frames) {
    assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
    const p = frame.result;
    assert.equal(p.kind, 'noteReplyPage'); assertSnapshotResult(p);
    for (const key of ['commentRevision', 'threadId', 'rootCommentId']) token(p[key]);
    assert.ok(['present', 'deleted'].includes(p.rootState));
    assert.ok(Number.isSafeInteger(p.totalComments) && p.totalComments > 0);
    const { items, nextCursor, ...identity } = p;
    if (first) assert.deepEqual(identity, first); else first = identity;
    assert.ok(items.length <= limits.annotationItems);
    assert.ok(wireBytes(frame) <= limits.wireBytes);
    for (const row of items) {
      if (p.rootState === 'deleted') assert.notEqual(row.commentId, p.rootCommentId);
      for (const key of ['commentId', 'bodyRef', 'detailRef']) token(row[key]);
      timestamp(row.createdAt);
      assert.ok(['open', 'resolved', 'pending', 'accepted', 'rejected'].includes(row.status));
      assert.ok(typeof row.preview === 'string' && utf8(row.preview) <= 512);
      assert.equal(typeof row.truncated, 'boolean');
      assert.equal(row.comments, undefined); assert.equal(row.replies, undefined);
      const key = [Date.parse(row.createdAt), row.commentId];
      if (previous) assert.ok(previous[0] < key[0] || (previous[0] === key[0] && previous[1] < key[1]));
      assert.ok(!seen.has(row.commentId)); seen.add(row.commentId); previous = key;
    }
  }
  assert.ok(seen.size <= first.totalComments);
  if (complete) {
    assert.equal(seen.size, first.totalComments);
    assert.equal(seen.has(first.rootCommentId), first.rootState === 'present');
    assert.equal(frames.at(-1).result.nextCursor, null);
  }
}

export function assertPageStateFrame(frame, limits) {
  assert.equal(frame.jsonrpc, '2.0'); assert.equal(frame.method, 'subscription.push');
  const p = frame.params;
  token(p.subscriptionId);
  assert.ok(Number.isSafeInteger(p.seq) && p.seq >= 0);
  assert.equal(p.kind, 'snapshot');
  assert.equal(p.payload, undefined); assert.equal(p.delta, undefined);
  const s = p.snapshot;
  assert.equal(s.kind, 'notePageState'); assertScope(s.scope);
  for (const key of ['sourceRevision', 'attributionGeneration', 'commentRevision']) token(s[key]);
  assert.match(s.stateGeneration, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(s.stateGeneration) <= 18446744073709551615n);
  assert.ok(['pending', 'ready'].includes(s.attributionState));
  assert.equal(typeof s.deleted, 'boolean'); assert.equal(s.invalidation, 'all');
  assert.deepEqual(Object.keys(s).sort(), ['kind', 'scope', 'stateGeneration', 'sourceRevision',
    'attributionGeneration', 'attributionState', 'commentRevision', 'deleted', 'invalidation'].sort());
  assert.ok(wireBytes(frame) <= limits.receiptBytes);
}

export function pagingBackendId(frame) {
  const caps = frame?.result?.server?.capabilities;
  return caps?.notePaging === 1 && typeof caps.notePagingBackendId === 'string'
    && caps.notePagingBackendId.length > 0 && utf8(caps.notePagingBackendId) <= 256
    ? caps.notePagingBackendId : null;
}

// Fixture-only lexical oracle; a production reader must use indexed membership.
export function assertTaskIdFrames(source, frames, limits, { startIndex = 0, complete = true } = {}) {
  const expected = [], seen = new Set();
  for (const m of source.matchAll(/\[([^\]]+)\]\(intent:\/\/local\/task\/([^)]+)\)/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    const start = m.index + m[0].length - m[2].length - 1;
    expected.push({ text: m[2], start, end: start + m[2].length });
  }
  let index = startIndex, identity;
  const result = [];
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
    const p = frame.result;
    assert.equal(p.kind, 'noteTaskIdsPage'); assertSnapshotResult(p);
    const current = { scope: p.scope, sourceRevision: p.sourceRevision,
      snapshotId: p.snapshotId, expiresAt: p.expiresAt, totalItems: p.totalItems };
    if (identity) assert.deepEqual(current, identity); else identity = current;
    assert.equal(p.note, undefined); assert.equal(p.content, undefined);
    assert.equal(p.totalItems, expected.length);
    assert.equal(p.startIndex, index);
    assert.ok(index >= 0 && index <= p.totalItems);
    assert.ok(p.items.length <= limits.items);
    assert.ok(p.items.length > 0 || index === p.totalItems);
    assert.ok(wireBytes(frame) <= limits.wireBytes, 'complete task summary frame exceeds wire budget');
    for (const row of p.items) {
      const e = expected[index]; assert.ok(e);
      assert.equal(row.index, index++);
      assert.deepEqual(row.sourceRange, { start: e.start, end: e.end });
      assert.ok(boundary(source, e.start) && boundary(source, e.end));
      assert.equal(row.taskNoteIdLength, e.text.length);
      if (utf8(e.text) <= limits.tokenBytes) {
        assert.equal(row.taskNoteId, e.text); assert.equal(row.taskNoteIdRef, undefined);
      } else {
        assert.equal(row.taskNoteId, undefined); token(row.taskNoteIdRef);
      }
      result.push(e.text);
    }
    assert.equal(p.nextCursor === null, index === p.totalItems);
  }
  if (complete) assert.equal(index, expected.length);
  return result;
}

// Full wire frames for a single field resource, not descriptor-directory entries.
export function assertTextFragments(frames, field, limits) {
  let text = '', identity, ended = false;
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
    const p = frame.result;
    assert.equal(p.kind, 'noteContextPage'); assertSnapshotResult(p);
    const { items, nextCursor, ...current } = p;
    if (identity) assert.deepEqual(current, identity); else identity = current;
    assert.ok(items.length > 0 && items.length <= limits.items);
    assert.ok(wireBytes(frame) <= limits.wireBytes);
    assert.ok(items.reduce((sum, r) => sum + utf8(r.text), 0) <= limits.sourceBytes);
    for (const row of items) {
      assert.ok(!ended); assert.equal(row.kind, 'fragment'); token(row.id);
      assert.equal(row.field, field); assert.equal(row.offset, text.length);
      assert.ok(validText(row.text)); cursor(row.nextRef);
      assert.ok(row.text.length > 0 || (text.length === 0 && row.nextRef === null));
      text += row.text; ended = row.nextRef === null;
    }
  }
  assert.ok(ended);
  if (field === 'renderedText') assert.ok(utf8(text) <= limits.sourceBytes);
  return text;
}

export function assertContextFrame(frame, limits, { directory = false, directOwner = false } = {}) {
  assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
  const p = frame.result;
  assert.equal(p.kind, 'noteContextPage'); assertSnapshotResult(p);
  assert.ok(p.items.length <= limits.items);
  assert.ok(wireBytes(frame) <= limits.wireBytes);
  let textBytes = 0;
  for (const item of p.items) {
    token(item.id);
    for (const key of ['parentRef', 'detailRef']) if (item[key] !== undefined
      && !(item.kind === 'nativeNode' && key === 'parentRef' && item[key] === null)) token(item[key]);
    assert.equal(item.content, undefined);
    if (item.kind === 'fragment') {
      assert.ok(typeof item.field === 'string' && item.field.length > 0 && utf8(item.field) <= 1024);
      assert.ok(Number.isSafeInteger(item.offset) && item.offset >= 0);
      assert.ok(validText(item.text)); cursor(item.nextRef); textBytes += utf8(item.text);
      if (directory) {
        assert.equal(item.offset, 0); assert.equal(item.text, ''); token(item.nextRef);
      }
    } else if (item.kind === 'nativeNode' || item.kind === 'sourcePiece') {
      assert.ok(!directory);
      const r = item.sourceRange;
      assert.ok(Number.isSafeInteger(r?.start) && Number.isSafeInteger(r?.end)
        && r.start >= 0 && r.end >= r.start);
      assert.equal(item.text, undefined);
      if (item.kind === 'sourcePiece') {
        token(item.nodeRef); assert.ok(r.end > r.start);
        assert.ok(['opening', 'body', 'closing', 'attribute', 'omitted'].includes(item.role));
      } else {
        assert.equal(item.profile, 'canonicalNote'); assert.equal(item.profileVersion, 1);
        assert.ok(typeof item.nodeType === 'string' && item.nodeType.length > 0 && utf8(item.nodeType) <= 1024);
        assert.ok(['container', 'text', 'atom'].includes(item.nodeClass));
        assert.equal(item.nodeClass === 'text', item.nodeType === 'text');
        assert.ok(Number.isSafeInteger(item.childIndex) && item.childIndex >= 0);
        if (item.parentRef === null) {
          assert.equal(item.nodeType, 'doc'); assert.equal(item.childIndex, 0);
        } else token(item.parentRef);
        token(item.attributesRef);
        if (item.marksRef !== undefined) token(item.marksRef);
        assert.ok(['explicit', 'implicit', 'repaired'].includes(item.provenance));
        if (item.provenance === 'implicit') assert.equal(r.start, r.end);
        if (item.provenance === 'repaired') token(item.sourcePiecesRef);
        else assert.equal(item.sourcePiecesRef, undefined);
        assert.equal(item.children, undefined); assert.equal(item.attributes, undefined);
      }
    } else if (item.kind === 'sourceMap') {
      assert.ok(!directory);
      assert.equal(item.profile, 'canonicalNote'); assert.equal(item.profileVersion, 1);
      token(item.ownerRef);
      if (item.textNodeId !== null) { token(item.textNodeId); token(item.textNodeRef); }
      else assert.equal(item.textNodeRef, null);
      const a = item.sourceRange, b = item.renderedRange;
      for (const r of [a, b]) assert.ok(Number.isSafeInteger(r?.start)
        && Number.isSafeInteger(r?.end) && r.start >= 0 && r.end >= r.start);
      assert.ok(b.end - b.start <= limits.sourceBytes);
      assert.ok(['identity', 'entity', 'normalized', 'omitted', 'projection'].includes(item.mapping));
      if (item.mapping === 'identity') assert.equal(a.end - a.start, b.end - b.start);
      if (item.mapping === 'projection') assert.equal(a.start, a.end);
      else assert.ok(a.end > a.start);
      if (item.mapping === 'omitted') {
        assert.equal(b.start, b.end); assert.equal(item.textRef, null);
        if (item.textNodeId === null) assert.equal(b.start, 0);
      } else {
        assert.ok(b.end > b.start); token(item.textNodeId); token(item.textRef);
      }
      assert.equal(item.text, undefined);
    } else {
      assert.ok(!directory);
      assert.ok(['boundary', 'span'].includes(item.kind));
      const r = item.sourceRange;
      assert.ok(Number.isSafeInteger(r?.start) && Number.isSafeInteger(r?.end)
        && r.start >= 0 && r.end >= r.start);
      const vocabulary = item.kind === 'boundary' ? item.construct : item.role;
      assert.ok(typeof vocabulary === 'string' && vocabulary.length > 0 && utf8(vocabulary) <= 1024);
      assert.equal(item.text, undefined);
      if (item.kind === 'boundary') {
        if (['htmlTable', 'htmlTableRow', 'htmlTableCell'].includes(item.construct)) {
          const position = item.htmlPosition, source = item.htmlSource;
          assert.equal(position?.profile, 'canonicalNote'); assert.equal(position.profileVersion, 1); token(position.tableRef);
          const keys = ['profile', 'profileVersion', 'tableRef'];
          if (item.construct !== 'htmlTable') {
            keys.push('rowIndex');
            assert.ok(Number.isSafeInteger(position.rowIndex) && position.rowIndex >= 0);
            token(item.parentRef);
          }
          if (item.construct === 'htmlTableCell') {
            keys.push('columnIndex', 'cellRole');
            assert.ok(Number.isSafeInteger(position.columnIndex) && position.columnIndex >= 0);
            assert.ok(['data', 'header'].includes(position.cellRole));
          }
          assert.deepEqual(Object.keys(position).sort(), keys.sort());
          token(item.attributesRef); token(item.nativeRef);
          if (directOwner) assert.equal(item.sourceMapRef, undefined);
          else token(item.sourceMapRef);
          assert.ok(['explicit', 'implicit', 'repaired'].includes(source?.provenance));
          for (const key of ['openingRange', 'bodyRange', 'closingRange']) {
            const part = source[key];
            assert.ok(part === null || (Number.isSafeInteger(part?.start)
              && Number.isSafeInteger(part?.end) && part.start >= r.start
              && part.end >= part.start && part.end <= r.end));
          }
          if (source.provenance === 'explicit') assert.notEqual(source.openingRange, null);
          if (source.provenance === 'repaired') token(source.piecesRef);
          else assert.equal(source.piecesRef, undefined);
          if (source.provenance === 'implicit') {
            assert.equal(r.start, r.end);
            for (const key of ['openingRange', 'bodyRange', 'closingRange']) assert.equal(source[key], null);
          }
        } else {
          assert.equal(item.htmlPosition, undefined); assert.equal(item.htmlSource, undefined);
        }
        if (['tableHead', 'tableRow', 'tableCell'].includes(item.construct)) {
          const position = item.tablePosition;
          assert.ok(position && typeof position === 'object'); token(position.tableRef);
          assert.ok(Number.isSafeInteger(position.rowIndex) && position.rowIndex >= 0);
          assert.equal(position.rowSpan, undefined); assert.equal(position.colSpan, undefined);
          if (item.construct === 'tableHead') assert.equal(position.rowIndex, 0);
          if (item.construct === 'tableRow') assert.ok(position.rowIndex >= 1);
          if (item.construct === 'tableCell') {
            assert.ok(Number.isSafeInteger(position.columnIndex) && position.columnIndex >= 0);
            assert.ok(['none', 'left', 'center', 'right'].includes(position.alignment));
          } else {
            assert.equal(position.columnIndex, undefined); assert.equal(position.alignment, undefined);
          }
        } else assert.equal(item.tablePosition, undefined);
        if (directOwner && item.htmlPosition) {
          assert.equal(item.continuationBefore, undefined);
          assert.equal(item.continuationAfter, undefined);
        } else {
          assert.equal(typeof item.continuationBefore, 'boolean');
          assert.equal(typeof item.continuationAfter, 'boolean');
        }
      } else if (item.role === 'code') {
        const c = item.codeSource;
        assert.equal(c?.profile, 'canonicalNote'); assert.equal(c.profileVersion, 1);
        const ranges = [c.openingRange, c.bodyRange, c.closingRange];
        for (const part of ranges) assert.ok(Number.isSafeInteger(part?.start)
          && Number.isSafeInteger(part?.end) && part.start >= r.start
          && part.end >= part.start && part.end <= r.end);
        assert.equal(c.openingRange.start, r.start);
        assert.equal(c.openingRange.end, c.bodyRange.start);
        assert.equal(c.bodyRange.end, c.closingRange.start);
        assert.equal(c.closingRange.end, r.end);
        assert.ok(c.openingRange.end > c.openingRange.start);
        assert.equal(c.openingRange.end - c.openingRange.start,
          c.closingRange.end - c.closingRange.start);
        if (item.nativeRef !== null) token(item.nativeRef);
        if (directOwner) assert.equal(item.sourceMapRef, undefined);
        else token(item.sourceMapRef);
        assert.equal(item.continuationBefore, undefined);
        assert.equal(item.continuationAfter, undefined);
      } else if (item.role === 'projection') assert.equal(r.start, r.end);
    }
  }
  assert.ok(textBytes <= limits.sourceBytes);
}

export function assertLinkFields(fields) {
  assert.ok(['Inline', 'Reference', 'ReferenceUnknown', 'Collapsed', 'CollapsedUnknown',
    'Shortcut', 'ShortcutUnknown', 'Autolink', 'Email', 'WikiLink'].includes(fields.linkType));
  for (const key of ['destination', 'title', 'referenceId']) assert.ok(validText(fields[key]));
  if (fields.linkType === 'WikiLink') assert.ok(['true', 'false'].includes(fields.hasPothole));
  else assert.equal(fields.hasPothole, undefined);
}

// Validate a bounded fixture's admitted native nodes plus ancestor closure.
// links are fixture-local opaque-ref -> node-id claims, not a token format or index.
export function assertNativeGraph(frames, links, limits) {
  const nodes = new Map(), positions = new Map();
  let identity;
  for (const frame of frames) {
    assertContextFrame(frame, limits);
    const { items, nextCursor, ...current } = frame.result;
    if (identity) assert.deepEqual(current, identity); else identity = current;
    for (const node of items) {
      assert.equal(node.kind, 'nativeNode');
      if (nodes.has(node.id)) assert.deepEqual(node, nodes.get(node.id));
      nodes.set(node.id, node);
    }
  }
  for (const node of nodes.values()) {
    const parentId = node.parentRef === null ? null : links[node.parentRef];
    if (node.parentRef !== null) assert.ok(nodes.has(parentId), 'missing admitted ancestor');
    const position = JSON.stringify([parentId, node.childIndex]);
    if (positions.has(position)) assert.equal(positions.get(position), node.id);
    positions.set(position, node.id);
    const seen = new Set();
    let current = node;
    while (current) {
      assert.ok(!seen.has(current.id), 'cyclic canonical parent'); seen.add(current.id);
      current = current.parentRef === null ? undefined : nodes.get(links[current.parentRef]);
    }
  }
  return nodes;
}
