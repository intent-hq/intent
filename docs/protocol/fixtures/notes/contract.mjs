// Specification arithmetic and validators only. No daemon/store implementation.
import assert from 'node:assert/strict';
import { canonicalJson } from '../../../../scripts/check-transfer-selection-contract.mjs';

export const utf8 = value => Buffer.byteLength(value, 'utf8');
export const wireBytes = value => utf8(JSON.stringify(value));
export const boundary = (text, offset) => Number.isSafeInteger(offset) && offset >= 0
  && offset <= text.length && !(offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]));
export const validText = text => typeof text === 'string' && !text.includes('\0')
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

export function assertSourcePage(source, frame, limits, request = { direction: 'forward' }) {
  assert.equal(frame.jsonrpc, '2.0');
  rpcId(frame.id);
  const p = frame.result;
  assertScope(p.scope);
  for (const key of ['sourceRevision', 'snapshotId', 'contextRef', 'metadataRef']) token(p[key]);
  timestamp(p.expiresAt);
  cursor(p.nextCursor); cursor(p.previousCursor);
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

const scopeKeys = ['backendId', 'workspaceId', 'noteId', 'noteInstanceId'];
const token = value => assert.ok(typeof value === 'string' && value.length > 0 && utf8(value) <= 256);
export function assertScope(scope) {
  assert.ok(scope && typeof scope === 'object');
  for (const key of scopeKeys) token(scope[key]);
}
const rpcId = id => assert.ok(Number.isSafeInteger(id) || (typeof id === 'string' && utf8(id) <= 64));
const timestamp = value => assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)));
const cursor = value => value === null ? undefined : token(value);

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

// Paged summaries preserve logical presence without widening legacy inline types.
export function assertReplyAuthor(row) {
  for (const key of ['authorPrincipalId', 'authorIdentity']) {
    const inline = Object.hasOwn(row, key), ref = Object.hasOwn(row, `${key}Ref`);
    assert.ok(!(inline && ref), 'author inline and reference are mutually exclusive');
    if (ref) { token(row[`${key}Ref`]); assert.ok(validText(row[`${key}Ref`])); }
    if (!inline) continue;
    if (key === 'authorPrincipalId') {
      assert.ok(validText(row[key]) && utf8(row[key]) <= 256);
    } else {
      const value = row[key];
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.deepEqual(Object.keys(value).sort(), ['externalUserId', 'host', 'provider']);
      assert.ok(['github', 'gitlab'].includes(value.provider));
      for (const field of ['host', 'externalUserId']) {
        assert.ok(validText(value[field]) && utf8(value[field]) <= 1024);
      }
    }
  }
}

// Fixture response-adoption check only: does not verify signed token ownership,
// current database membership, or actual server expiry. Those require runtime proof.
export function assertAnnotationContextFrame(frame, owner, limits, options = {}) {
  assertContextFrame(frame, limits, options);
  for (const key of ['scope', 'sourceRevision', 'commentRevision', 'snapshotId', 'expiresAt']) {
    assert.ok(Object.hasOwn(owner, key) && Object.hasOwn(frame.result, key), `missing ${key} binding`);
    assert.deepEqual(frame.result[key], owner[key], `mismatched ${key} binding`);
  }
  token(frame.result.commentRevision);
}

// Synthetic read traces bind requested references to recorded responses. This is
// a specification oracle, not a token parser or a production full-value loader.
export function assertReplyAuthorResources(row, owner, reads, limits) {
  assertReplyAuthor(row);
  const used = new Set();
  const read = (ref, cursorValue, directory = false) => {
    token(ref);
    const matches = reads.filter(r => r.contextRef === ref && (r.cursor ?? null) === cursorValue);
    assert.equal(matches.length, 1, 'missing or ambiguous reference binding');
    const entry = matches[0];
    assert.ok(!used.has(entry), 'cyclic author reference'); used.add(entry);
    assertAnnotationContextFrame(entry.response, owner, limits, { directory });
    return entry.response;
  };
  const scalar = (ref, field) => {
    const frames = [];
    while (ref !== null) {
      const frame = read(ref, null);
      assert.equal(frame.result.nextCursor, null, 'scalar continuation uses nextRef');
      assert.ok(frame.result.items.length > 0);
      frames.push(frame);
      ref = frame.result.items.at(-1).nextRef;
    }
    return assertTextFragments(frames, field, limits);
  };
  const values = {};
  if (Object.hasOwn(row, 'authorPrincipalId')) values.authorPrincipalId = row.authorPrincipalId;
  if (Object.hasOwn(row, 'authorIdentity')) values.authorIdentity = row.authorIdentity;
  if (row.authorPrincipalIdRef !== undefined) {
    values.authorPrincipalId = scalar(row.authorPrincipalIdRef, 'authorPrincipalId');
  }
  if (row.authorIdentityRef !== undefined) {
    let next = null;
    const entries = [];
    do {
      const frame = read(row.authorIdentityRef, next, true);
      entries.push(...frame.result.items);
      next = frame.result.nextCursor;
    } while (next !== null);
    assert.deepEqual(entries.map(r => r.field), ['provider', 'host', 'externalUserId']);
    values.authorIdentity = Object.fromEntries(entries.map(r => [r.field, scalar(r.nextRef, r.field)]));
    assert.ok(['github', 'gitlab'].includes(values.authorIdentity.provider));
  }
  return values;
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
      assertReplyAuthor(row);
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
  assert.ok(wireBytes(frame) <= limits.stateBytes);
}

export function pagingBackendId(frame) {
  const caps = frame?.result?.server?.capabilities;
  return caps?.notePagingRead === 1 && typeof caps.notePagingBackendId === 'string'
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
        if (item.construct === 'markdownDocument') {
          assert.equal(item.profile, 'canonicalNote'); assert.equal(item.profileVersion, 1);
          assert.equal(item.entryPath, 'markdown'); assert.equal(r.start, 0);
          token(item.nativeRef); token(item.attributesRef);
          assert.equal(item.parentRef, undefined);
          if (directOwner) assert.equal(item.sourceMapRef, undefined);
          else token(item.sourceMapRef);
        }
        if (item.construct === 'paragraph' && Object.hasOwn(item, 'entryPath')) {
          assert.ok(['markdown', 'html'].includes(item.entryPath));
        }
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
        if (directOwner && (item.htmlPosition || item.construct === 'markdownDocument')) {
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

// Cross-resource specification checks; the caller supplies known separator extents.
// This is not a Markdown parser, database index, or production admission algorithm.
export function assertMarkdownDocumentResources(resources, limits) {
  const { source, window, ownerRef, nativeRef, ownerFrame, nativeFrame,
    occurrenceFrame, mapFrames, separatorRanges } = resources;
  assert.ok(validText(source)); token(ownerRef); token(nativeRef);
  assert.ok(boundary(source, window.start) && boundary(source, window.end));
  assert.ok(window.start <= window.end);
  assert.ok(utf8(source.slice(window.start, window.end)) <= limits.sourceBytes);
  assertContextFrame(occurrenceFrame, limits);
  const expected = separatorRanges.map(r => ({ start: Math.max(r.start, window.start),
    end: Math.min(r.end, window.end) })).filter(r => r.start < r.end);
  const emptyDocument = source.length === 0;
  if (!separatorRanges.length && !emptyDocument) {
    assert.equal(ownerFrame, null); assert.equal(nativeFrame, null);
    assert.deepEqual(occurrenceFrame.result.items, []); assert.deepEqual(mapFrames, []);
    return;
  }
  assertContextFrame(ownerFrame, limits, { directOwner: true });
  assertContextFrame(nativeFrame, limits);
  assertContextFrame(occurrenceFrame, limits);
  for (const f of [nativeFrame, occurrenceFrame, ...mapFrames]) {
    assertContextFrame(f, limits);
    for (const field of ['scope', 'sourceRevision', 'snapshotId', 'expiresAt'])
      assert.deepEqual(f.result[field], ownerFrame.result[field]);
  }
  assert.equal(ownerFrame.result.items.length, 1);
  assert.equal(nativeFrame.result.items.length, 1);
  assert.equal(occurrenceFrame.result.items.length, expected.length || emptyDocument ? 1 : 0);
  const owner = ownerFrame.result.items[0], root = nativeFrame.result.items[0];
  assert.equal(owner.construct, 'markdownDocument');
  assert.deepEqual(owner.sourceRange, { start: 0, end: source.length });
  assert.equal(owner.nativeRef, nativeRef);
  assert.equal(root.kind, 'nativeNode'); assert.equal(root.nodeType, 'doc');
  assert.equal(root.nodeClass, 'container'); assert.equal(root.parentRef, null);
  assert.equal(root.childIndex, 0); assert.equal(root.provenance, 'implicit');
  assert.deepEqual(root.sourceRange, { start: 0, end: 0 });
  assert.equal(root.attributesRef, owner.attributesRef);
  if (!expected.length && !emptyDocument) {
    assert.deepEqual(mapFrames, []);
    return;
  }
  const { sourceMapRef, continuationBefore, continuationAfter, ...stable } = occurrenceFrame.result.items[0];
  assert.deepEqual(stable, owner);
  assert.equal(continuationBefore, window.start > 0);
  assert.equal(continuationAfter, window.end < source.length);
  token(sourceMapRef);
  if (emptyDocument) {
    assert.equal(mapFrames.length, 1);
    assert.deepEqual(mapFrames[0].result.items, []);
    assert.equal(mapFrames[0].result.nextCursor, null);
  }
  const maps = mapFrames.flatMap(f => f.result.items);
  const ranges = [];
  for (const map of maps) {
    assert.equal(map.kind, 'sourceMap'); assert.equal(map.ownerRef, ownerRef);
    assert.equal(map.mapping, 'omitted'); assert.equal(map.textNodeId, null);
    assert.equal(map.textNodeRef, null); assert.equal(map.textRef, null);
    assert.deepEqual(map.renderedRange, { start: 0, end: 0 });
    const { start, end } = map.sourceRange;
    assert.ok(boundary(source, start) && boundary(source, end));
    assert.ok(start >= window.start && end <= window.end && start < end);
    assert.ok(separatorRanges.some(r => start >= r.start && end <= r.end));
    if (ranges.length) assert.ok(ranges.at(-1).end <= start);
    ranges.push({ start, end });
  }
  // Adjacent scalar-safe chunks can subdivide a separator, including CR | LF.
  const join = rs => rs.reduce((out, r) => {
    if (out.length && out.at(-1).end === r.start) out.at(-1).end = r.end;
    else out.push({ ...r });
    return out;
  }, []);

  assert.deepEqual(join(ranges), join(expected));
}

// Controlled parser-marker receipts plus full-editor oracle output, not a parser.
export function assertMarkdownTaskMarker(source, marker, native) {
  const { start, end } = marker.sourceRange;
  assert.ok(boundary(source, start) && boundary(source, end));
  assert.equal(typeof marker.checked, 'boolean');
  assert.ok((marker.checked ? ['[x]', '[X]'] : ['[ ]']).includes(source.slice(start,end)));
  let node = native, parent;
  for (const index of marker.nativePath) {
    assert.ok(Number.isSafeInteger(index) && index >= 0);
    parent = node; node = node?.content?.[index];
  }
  assert.equal(parent?.type, 'taskList'); assert.equal(node?.type, 'taskItem');
  assert.deepEqual(node.attrs, { checked: marker.checked,
    status: marker.checked ? 'done' : 'todo', delegatedAgentId: null });
}

// Validate a supplied structural direct-child receipt, without parsing Markdown.
export function assertMarkdownDelimiterReceipt(source, receipt) {
  assert.ok(['document','list','item','blockquote'].includes(receipt.kind));
  const { start, end } = receipt.sourceRange;
  assert.ok(boundary(source,start) && boundary(source,end) && start <= end);
  const protectedRanges = receipt.children.map(c=>c.sourceRange).sort((a,b)=>a.start-b.start||a.end-b.end);
  const expected=[];
  let offset=start;
  for (const child of protectedRanges) {
    assert.ok(boundary(source,child.start) && boundary(source,child.end));
    assert.ok(child.start >= start && child.start <= child.end && child.end <= end);
    if (offset < child.start) expected.push({start:offset,end:child.start});
    offset=Math.max(offset,child.end);
  }
  if (offset < end) expected.push({start:offset,end});
  assert.deepEqual(receipt.delimiters,expected);
}

// A supplied unique inline-group receipt, not parser/group discovery evidence.
export function assertMarkdownRepairedParagraph(source, receipt, native, block, pieces) {
  assert.equal(receipt.candidates.length, 1);
  const group = receipt.candidates[0];
  assert.equal(group.itemRef, receipt.itemRef);
  assert.equal(native.parentRef, receipt.itemRef);
  assert.equal(native.nodeType, 'paragraph');
  assert.equal(native.provenance, 'repaired'); token(native.sourcePiecesRef);
  assert.ok(pieces.length > 0);
  const seen = new Set();
  let previous;
  for (const piece of pieces) {
    assert.equal(piece.kind, 'sourcePiece'); assert.equal(piece.nodeRef, receipt.nodeRef);
    assert.equal(piece.role, 'body'); token(piece.id);
    const { start, end } = piece.sourceRange;
    assert.ok(boundary(source, start) && boundary(source, end) && start < end);
    const key = JSON.stringify([start, end]); assert.ok(!seen.has(key)); seen.add(key);
    if (previous) assert.ok(previous.start < start || previous.start === start && previous.end < end);
    previous = piece.sourceRange;
  }
  assert.deepEqual(pieces.map(p => p.sourceRange), group.ranges);
  const hull = { start: pieces[0].sourceRange.start, end: Math.max(...pieces.map(p => p.sourceRange.end)) };
  assert.deepEqual(native.sourceRange, hull); assert.deepEqual(block.sourceRange, hull);
}
