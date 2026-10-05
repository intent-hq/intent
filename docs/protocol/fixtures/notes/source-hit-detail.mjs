// Fixture-only decoded reference claims and whole-string source oracle.
// This does not authenticate tokens, enforce Store ownership or implement paging.
import assert from 'node:assert/strict';
import { boundary, validText, utf8, wireBytes } from './contract.mjs';
import { sourceSearch } from './source-search.mjs';

export function assertSourceHitDetail(fixture, foldTable) {
  const { owner, claims, exchanges, now } = fixture;
  const { start, end } = owner.sourceRange;
  assert.ok(boundary(owner.source, start) && boundary(owner.source, end) && end > start);
  assert.equal(owner.query.mode, 'source');
  assert.ok(sourceSearch(owner.source, owner.query.text, foldTable)
    .some(([a, b]) => a === start && b === end));
  assert.ok(Date.parse(now) < Date.parse(owner.expiresAt));
  const raw = owner.source.slice(start, end);
  const { source, detailRef, ...identity } = owner;
  let ref = detailRef, offset = 0, text = '';
  assert.ok(exchanges.length > 0);
  const seen = new Set();
  for (const [index, exchange] of exchanges.entries()) {
    assert.ok(typeof ref === 'string' && ref.length > 0 && utf8(ref) <= 256 && !seen.has(ref));
    seen.add(ref);
    assert.deepEqual(claims[ref], { ...identity, offset });
    const request = exchange.request, response = exchange.response;
    assert.equal(request.jsonrpc, '2.0');
    assert.equal(request.method, 'note.operation.read');
    assert.equal(response.jsonrpc, '2.0'); assert.equal(response.id, request.id);
    const p = request.params, result = response.result;
    assert.deepEqual(p, { ...owner.scope, operationId: owner.operationId,
      headerDigest: owner.headerDigest, kind: 'detail', ref,
      ...(Object.hasOwn(p, 'offset') ? { offset } : {}),
      maxItems: p.maxItems, maxWireBytes: p.maxWireBytes });
    assert.ok(Number.isSafeInteger(p.maxItems) && p.maxItems >= 1 && p.maxItems <= 128);
    assert.ok(Number.isSafeInteger(p.maxWireBytes) && p.maxWireBytes >= 4096 && p.maxWireBytes <= 65536);
    assert.ok(wireBytes(request) <= 65536 && wireBytes(response) <= p.maxWireBytes);
    assert.deepEqual(Object.keys(result).sort(), ['kind', 'scope', 'operationId', 'headerDigest',
      'payloadDigest', 'viewId', 'outputKind', 'sourceLength', 'items', 'nextCursor', 'expiresAt'].sort());
    assert.equal(result.kind, 'noteOperationPage'); assert.equal(result.outputKind, 'detail');
    for (const key of ['scope', 'operationId', 'headerDigest', 'payloadDigest', 'viewId', 'expiresAt']) {
      assert.deepEqual(result[key], owner[key]);
    }
    assert.equal(result.sourceLength, source.length);
    assert.equal(result.nextCursor, null);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['kind', 'id', 'field', 'offset', 'text', 'nextRef'].sort());
    assert.equal(item.kind, 'fragment'); assert.equal(item.field, 'source');
    assert.ok(typeof item.id === 'string' && item.id.length > 0 && utf8(item.id) <= 256);
    assert.equal(item.offset, offset);
    assert.ok(validText(item.text) && item.text.length > 0 && utf8(item.text) <= 16384);
    assert.ok(boundary(raw, offset) && boundary(raw, offset + item.text.length));
    assert.equal(item.text, raw.slice(offset, offset + item.text.length));
    text += item.text; offset += item.text.length;
    assert.equal(item.nextRef === null, offset === raw.length);
    assert.equal(item.nextRef === null, index === exchanges.length - 1);
    ref = item.nextRef;
  }
  assert.equal(text, raw);
}
