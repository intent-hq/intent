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
  if (claim.expiresAt <= now || claim.boot !== current.boot) return 'note-page-expired';
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
  return text;
}

export function assertContextFrame(frame, limits, { directory = false } = {}) {
  assert.equal(frame.jsonrpc, '2.0'); rpcId(frame.id);
  const p = frame.result;
  assert.equal(p.kind, 'noteContextPage'); assertSnapshotResult(p);
  assert.ok(p.items.length <= limits.items);
  assert.ok(wireBytes(frame) <= limits.wireBytes);
  let textBytes = 0;
  for (const item of p.items) {
    token(item.id);
    for (const key of ['parentRef', 'detailRef']) if (item[key] !== undefined) token(item[key]);
    assert.equal(item.content, undefined);
    if (item.kind === 'fragment') {
      assert.ok(typeof item.field === 'string' && item.field.length > 0 && utf8(item.field) <= 1024);
      assert.ok(Number.isSafeInteger(item.offset) && item.offset >= 0);
      assert.ok(validText(item.text)); cursor(item.nextRef); textBytes += utf8(item.text);
      if (directory) {
        assert.equal(item.offset, 0); assert.equal(item.text, ''); token(item.nextRef);
      }
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
        assert.equal(typeof item.continuationBefore, 'boolean');
        assert.equal(typeof item.continuationAfter, 'boolean');
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
