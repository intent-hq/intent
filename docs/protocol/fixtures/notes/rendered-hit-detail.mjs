// Complete-tree fixture oracle with decoded claims, not a streaming runtime,
// authenticated reference resolver or configured native projection proof.
import assert from 'node:assert/strict';
import { boundary, validText, utf8, wireBytes } from './contract.mjs';
import { assertRenderedIdentityCapture } from './rendered-search.mjs';

// Encoding-only oracle for the two explicit server-output exceptions. Expected
// values are supplied by the fixture, not established by authentication here.
export function assertOutputStringEncoding(entry, expected, domain, wholeLeaf = false) {
  assert.ok(['receiptDetail', 'renderedHit'].includes(domain));
  assert.equal(entry.type, 'string');
  assert.ok(validText(expected));
  const inline = Object.hasOwn(entry, 'value'), referenced = Object.hasOwn(entry, 'valueRef');
  assert.notEqual(inline, referenced);
  assert.ok(!Object.hasOwn(entry, 'childrenRef'));
  if (domain === 'renderedHit') assert.equal(referenced, wholeLeaf || utf8(expected) > 1024);
  if (inline) {
    assert.equal(entry.value, expected);
    assert.ok(utf8(entry.value) <= 1024);
  } else {
    assert.ok(validText(entry.valueRef) && entry.valueRef.length > 0 && utf8(entry.valueRef) <= 256);
  }
}

export function assertRenderedHitDetail(fixture, capture, table) {
  const { owner, claims, exchanges } = fixture;
  assert.equal(owner.operationId, capture.operationId);
  assert.deepEqual(owner.query, capture.header.query);
  assert.deepEqual(owner.selection, capture.selection);
  assert.equal(owner.parentOrdinal, 0); assert.equal(owner.leafOrdinal, 1);
  assert.ok(Number.isSafeInteger(owner.sourceLength) && owner.sourceLength >= capture.leaf.record.sourceRange.end);
  assert.ok(Date.parse(fixture.now) < Date.parse(owner.expiresAt));
  const hit = assertRenderedIdentityCapture(capture, table)[0];
  assert.ok(hit);
  assert.deepEqual(owner.sourceRange, { start: hit.sourceRange[0], end: hit.sourceRange[1] });
  assert.deepEqual(owner.renderedRange, { start: hit.renderedRange[0], end: hit.renderedRange[1] });
  const available = new Map(), used = new Set(), ids = new Set();
  const address = (ref, cursor) => JSON.stringify([ref, cursor ?? null]);
  for (const exchange of exchanges) {
    const p = exchange.request.params, key = address(p.ref, p.cursor);
    assert.ok(!available.has(key)); available.set(key, exchange);
  }
  function page(ref, cursor, pageIndex) {
    const key = address(ref, cursor); assert.ok(!used.has(key)); used.add(key);
    const exchange = available.get(key); assert.ok(exchange);
    const { request, response } = exchange, p = request.params, r = response.result;
    assert.deepEqual(claims[cursor ?? ref], { ...owner, resourceRef: ref, pageIndex });
    assert.equal(request.jsonrpc, '2.0'); assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, request.id); assert.equal(request.method, 'note.operation.read');
    assert.deepEqual(p, { ...owner.scope, operationId: owner.operationId,
      headerDigest: owner.headerDigest, kind: 'detail', ref, ...(cursor ? { cursor } : {}),
      maxItems: 4, maxWireBytes: 4096 });
    for (const k of ['scope', 'operationId', 'headerDigest', 'payloadDigest', 'viewId', 'expiresAt', 'sourceLength'])
      assert.deepEqual(r[k], owner[k]);
    assert.deepEqual(Object.keys(r).sort(), ['scope', 'operationId', 'headerDigest', 'payloadDigest',
      'viewId', 'expiresAt', 'sourceLength', 'kind', 'outputKind', 'items', 'nextCursor'].sort());
    assert.equal(r.kind, 'noteOperationPage'); assert.equal(r.outputKind, 'detail');
    assert.ok(r.items.length <= p.maxItems && wireBytes(response) <= p.maxWireBytes);
    assert.ok(wireBytes(request) <= 65536);
    return r;
  }
  function collection(ref) {
    const items = []; let cursor, index = 0;
    do {
      const r = page(ref, cursor, index++); items.push(...r.items);
      assert.ok(r.nextCursor === null || (typeof r.nextCursor === 'string' && r.nextCursor.length > 0 && r.items.length > 0));
      cursor = r.nextCursor;
    } while (cursor !== null);
    return items;
  }
  function text(ref, field, expected) {
    let value = '', id;
    do {
      const r = page(ref, undefined, 0); assert.equal(r.nextCursor, null);
      assert.equal(r.items.length, 1);
      const item = r.items[0];
      assert.deepEqual(Object.keys(item).sort(), ['kind', 'id', 'field', 'offset', 'text', 'nextRef'].sort());
      assert.equal(item.kind, 'fragment'); assert.equal(item.field, field);
      id ??= item.id; assert.equal(item.id, id);
      assert.ok(validText(item.text) && (item.text.length > 0 || expected.length === 0) && utf8(item.text) <= 16384);
      assert.equal(item.offset, value.length);
      assert.ok(boundary(expected, item.offset) && boundary(expected, item.offset + item.text.length));
      assert.equal(item.text, expected.slice(item.offset, item.offset + item.text.length));
      value += item.text;
      assert.equal(item.nextRef === null, value.length === expected.length);
      ref = item.nextRef;
    } while (ref !== null);
    return value;
  }
  function resolve(entry, parentId, key, expected, path = []) {
    assert.ok(!ids.has(entry.id)); ids.add(entry.id);
    assert.equal(entry.parentId, parentId);
    const base = ['id', 'parentId', 'type', ...(key === undefined ? [] : ['key'])];
    if (key !== undefined) assert.equal(entry.key, key);
    if (entry.type === 'object') {
      assert.deepEqual(Object.keys(entry).sort(), [...base, 'childrenRef'].sort());
      const children = collection(entry.childrenRef), names = children.map(child => child.key);
      assert.deepEqual(names, [...new Set(names)].sort());
      const value = {};
      for (const child of children)
        Object.defineProperty(value, child.key, { value: resolve(child, entry.id, child.key, expected?.[child.key], [...path, child.key]), enumerable: true });
      return value;
    }
    if (entry.type === 'string') {
      const wholeLeaf = path.length === 2 && path[0] === 'leaf' && path[1] === 'renderedText';
      assertOutputStringEncoding(entry, expected, 'renderedHit', wholeLeaf);
      const field = Object.hasOwn(entry, 'valueRef') ? 'valueRef' : 'value';
      assert.deepEqual(Object.keys(entry).sort(), [...base, field].sort());
      return field === 'valueRef' ? text(entry.valueRef, key, expected) : entry.value;
    }
    assert.deepEqual(Object.keys(entry).sort(), [...base, 'value'].sort());
    assert.ok(['number', 'null'].includes(entry.type));
    assert.equal(entry.value === null ? 'null' : typeof entry.value, entry.type);
    return entry.value;
  }
  const roots = collection(fixture.rootRef); assert.equal(roots.length, 1);
  const node = item => ({ ordinal: item.record.ordinal, sourceRange: item.record.sourceRange,
    descriptor: item.descriptor, attributes: {} });
  const expected = { kind: 'stagedRenderedHit', mapping: 'identity', sourceRange: owner.sourceRange,
    renderedRange: owner.renderedRange, parent: node(capture.parent),
    leaf: { ...node(capture.leaf), renderedText: capture.source } };
  const actual = resolve(roots[0], null, undefined, expected);
  assert.deepEqual(actual, expected); assert.deepEqual(actual, fixture.expected);
  assert.equal(used.size, available.size, 'fixture has unreachable pages');
}
