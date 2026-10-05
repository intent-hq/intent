// Controlled staged upload grammar oracle. In-memory fixture maps are NOT a
// production graph store, streaming parser, resource bound or authorization proof.
import assert from 'node:assert/strict';
import { canonicalJson } from '../../../../scripts/check-transfer-selection-contract.mjs';

const bytes = s => Buffer.byteLength(s, 'utf8');
const text = s => typeof s === 'string' && !s.includes('\0')
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
const token = s => assert.ok(text(s) && s.length > 0 && bytes(s) <= 256);
const exact = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};

export function assertStagedMetadataUpload(fixture) {
  const resources = new Map();
  for (const resource of fixture.texts) {
    token(resource.id); assert.ok(!resources.has(resource.id));
    resources.set(resource.id, resource);
  }
  const reads = new Set(), parsed = new Set(), ids = new Map(), entries = new Map();
  const directoryOwners = new Map(), queued = new Set(), roots = new Set();
  const pending = [];
  function raw(ref) {
    token(ref);
    const resource = resources.get(ref);
    assert.ok(resource, 'missing text resource');
    assert.equal(resource.operationId, fixture.operationId, 'foreign operation text');
    const chunks = resource.chunks ?? [resource.text];
    assert.ok(Array.isArray(chunks) && chunks.length > 0 && chunks.every(text));
    reads.add(ref);
    return chunks.join(''); // fixture only; runtime must stream large scalar text
  }
  function json(ref) {
    const value = raw(ref);
    assert.ok(bytes(value) <= 16384, 'entry/directory JSON byte budget');
    const decoded = JSON.parse(value);
    assert.equal(canonicalJson(decoded), value, 'canonical JSON entry/directory');
    parsed.add(ref);
    return decoded;
  }
  function entry(ref, parent) {
    const e = json(ref); token(e.id);
    assert.equal(e.parentId, parent?.id ?? null);
    assert.ok(!ids.has(e.id), 'duplicate entry identity');
    ids.set(e.id, ref);
    const keys = ['id', 'parentId', 'type'];
    let key;
    if (parent?.type === 'object') {
      const inline = Object.hasOwn(e, 'key'), referenced = Object.hasOwn(e, 'keyRef');
      assert.notEqual(inline, referenced, 'one object key encoding');
      if (inline) { assert.ok(text(e.key) && bytes(e.key) <= 1024); key = e.key; keys.push('key'); }
      else { key = raw(e.keyRef); keys.push('keyRef'); }
    } else if (parent?.type === 'array') {
      assert.ok(Number.isSafeInteger(e.index) && e.index >= 0); keys.push('index');
    }
    if (e.type === 'object' || e.type === 'array') {
      token(e.childrenRef); keys.push('childrenRef');
    } else if (e.type === 'string') {
      raw(e.valueRef); keys.push('valueRef');
    } else {
      assert.ok(['number', 'boolean', 'null'].includes(e.type)); keys.push('value');
      if (e.type === 'number') assert.ok(typeof e.value === 'number' && Number.isFinite(e.value));
      if (e.type === 'boolean') assert.equal(typeof e.value, 'boolean');
      if (e.type === 'null') assert.equal(e.value, null);
    }
    exact(e, keys); entries.set(ref, e);
    return { e, key };
  }
  function schedule(ref, parent) {
    assert.ok(!queued.has(ref), 'duplicate child or graph cycle'); queued.add(ref);
    const result = entry(ref, parent);
    pending.push({ ref, ...result });
    return result;
  }
  for (const ref of fixture.roots) {
    if (roots.has(ref)) continue; // the same immutable root may serve multiple descriptors
    roots.add(ref); schedule(ref, null);
  }
  for (let at = 0; at < pending.length; at++) {
    const { ref: owner, e } = pending[at];
    if (e.type !== 'object' && e.type !== 'array') continue;
    const chain = new Set();
    let next = e.childrenRef, ordinal = 0, previousKey;
    while (next !== null) {
      assert.ok(!chain.has(next), 'directory cycle'); chain.add(next);
      assert.ok(!directoryOwners.has(next), 'directory reused under another container');
      directoryOwners.set(next, owner);
      const d = json(next); exact(d, ['kind', 'items', 'nextRef']);
      assert.equal(d.kind, 'metadataChildren');
      assert.ok(Array.isArray(d.items) && d.items.length <= 64);
      if (d.nextRef !== null) token(d.nextRef);
      if (!d.items.length) assert.ok(chain.size === 1 && d.nextRef === null, 'empty continuation');
      for (const child of d.items) {
        const { e: item, key } = schedule(child, e);
        if (e.type === 'array') assert.equal(item.index, ordinal);
        else {
          if (previousKey !== undefined)
            assert.ok(Buffer.compare(Buffer.from(previousKey), Buffer.from(key)) < 0, 'object key order');
          previousKey = key;
        }
        ordinal++;
      }
      next = d.nextRef;
    }
  }
  return { entryIds: [...ids.keys()], readTextIds: [...reads], parsedTextIds: [...parsed] };
}
