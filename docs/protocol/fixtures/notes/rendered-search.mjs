// Controlled resolved upload fixture only. No configured native capture, Store
// authorization, external-storage bound or authenticated cursor is proved here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { boundary, validText, utf8 } from './contract.mjs';
import { sourceSearch } from './source-search.mjs';

const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const uint = value => assert.ok(Number.isSafeInteger(value) && value >= 0);
const token = value => assert.ok(validText(value) && value.length > 0 && utf8(value) <= 256);
const range = (value, names) => {
  keys(value, names); names.forEach(name => uint(value[name]));
  assert.ok(value[names[0]] <= value[names[1]]);
};

export function assertRenderedIdentityCapture(capture, table) {
  const { parent, leaf, header, resources, source } = capture;
  token(capture.operationId);
  assert.equal(header.output, 'search'); assert.equal(header.selection, 'ranges');
  assert.equal(header.query.mode, 'renderedText'); assert.equal(header.query.caseSensitive, false);
  for (const item of [parent, leaf]) {
    keys(item.record, ['ordinal', 'role', 'sourceRange']);
    range(item.record.sourceRange, ['start', 'end']);
    range(item.descriptor.nativeRange, ['from', 'to']);
    token(item.descriptor.attributesRef);
    const resource = resources[item.descriptor.attributesRef];
    assert.equal(resource.operationId, capture.operationId);
    assert.deepEqual(resource.attributes, {});
  }
  keys(parent.descriptor, ['version', 'nodeType', 'parentOrdinal', 'nativeRange', 'attributesRef']);
  keys(leaf.descriptor, ['version', 'nodeType', 'parentOrdinal', 'nativeRange', 'attributesRef', 'renderedText']);
  assert.equal(parent.record.ordinal, 0); assert.equal(parent.record.role, 'selection-owner');
  assert.equal(parent.descriptor.version, 1); assert.equal(parent.descriptor.nodeType, 'paragraph');
  assert.equal(parent.descriptor.parentOrdinal, null);
  assert.equal(leaf.record.ordinal, 1); assert.equal(leaf.record.role, 'inline-span');
  assert.equal(leaf.descriptor.version, 2); assert.equal(leaf.descriptor.nodeType, 'text');
  assert.equal(leaf.descriptor.parentOrdinal, 0);
  assert.deepEqual(leaf.record.sourceRange, parent.record.sourceRange);
  const ref = leaf.descriptor.renderedText;
  keys(ref, ['textId', 'length', 'utf8Bytes', 'sha256']); token(ref.textId);
  uint(ref.length); uint(ref.utf8Bytes);
  const resource = resources[ref.textId];
  assert.equal(resource.operationId, capture.operationId);
  const text = resource.text;
  assert.ok(validText(text) && text.length > 0); assert.equal(source, text);
  assert.equal(ref.length, text.length); assert.equal(ref.utf8Bytes, utf8(text));
  assert.equal(ref.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(leaf.record.sourceRange.end - leaf.record.sourceRange.start, text.length);
  assert.equal(leaf.descriptor.nativeRange.to - leaf.descriptor.nativeRange.from, text.length);
  assert.equal(leaf.descriptor.nativeRange.from, parent.descriptor.nativeRange.from + 1);
  assert.equal(leaf.descriptor.nativeRange.to, parent.descriptor.nativeRange.to - 1);
  assert.equal(capture.selection.length, 1);
  const selected = capture.selection[0], start = leaf.record.sourceRange.start;
  keys(selected, ['ordinal', 'start', 'end', 'anchorAffinity', 'headAffinity', 'direction']);
  assert.equal(selected.ordinal, 0);
  assert.ok(['before', 'after'].includes(selected.anchorAffinity));
  assert.ok(['before', 'after'].includes(selected.headAffinity));
  assert.ok(['forward', 'backward'].includes(selected.direction));
  assert.ok(boundary(text, selected.start - start) && boundary(text, selected.end - start));
  assert.ok(selected.start <= selected.end);
  return sourceSearch(text, header.query.text, table, [[selected.start - start, selected.end - start]])
    .map(([a, b]) => ({ renderedRange: [a, b], sourceRange: [start + a, start + b] }));
}
