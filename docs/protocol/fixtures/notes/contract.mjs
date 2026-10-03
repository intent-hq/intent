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

export function assertSourcePage(source, frame, limits) {
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
  assert.ok(p.text.length > 0 || p.range.start === source.length);
  assert.ok(utf8(p.text) <= limits.sourceBytes);
  assert.ok(wireBytes(frame) <= limits.wireBytes);
}

// Test-only decoded cursor claims, never an on-wire token format.
export function cursorError(claim, request, current, now) {
  const keys = ['backendId', 'workspaceId', 'noteId', 'noteInstanceId', 'principalId', 'kind', 'budgets', 'ranges'];
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
