import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixture = JSON.parse(await readFile(new URL('./truncated-read.json', import.meta.url)));
const docs = await readFile(new URL('../../methods/notes-tasks.md', import.meta.url), 'utf8');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// Reference implementation of the documented cut rule.
function truncate(content, limit) {
  const bytes = encoder.encode(content);
  if (bytes.length <= limit) return { content };
  let end = bytes.lastIndexOf(0x0a, limit - 1) + 1;
  if (end === 0) {
    end = limit;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d && bytes[end] === 0x0a) end -= 1;
  }
  return { content: decoder.decode(bytes.subarray(0, end)), contentTruncated: true, contentBytes: bytes.length };
}

const validMax = v => Number.isInteger(v) && v > 0;
const validBase = v => Number.isInteger(v) && v >= 0;

for (const c of fixture.cases) {
  test(`cut rule: ${c.id}`, () => {
    assert.deepEqual(truncate(c.content, c.maxContentBytes), c.expect);
    const kept = encoder.encode(c.expect.content).length;
    assert.ok(kept <= c.maxContentBytes || !c.expect.contentTruncated);
    assert.ok(c.content.startsWith(c.expect.content));
    if (!c.expect.contentTruncated) {
      assert.equal(c.expect.content, c.content);
      assert.deepEqual(Object.keys(c.expect), ['content']);
    }
  });
}

test('a truncated prefix can never pass the baseContentBytes guard', () => {
  for (const c of fixture.cases.filter(x => x.expect.contentTruncated)) {
    assert.ok(encoder.encode(c.expect.content).length < c.expect.contentBytes, c.id);
  }
});

test('param validation vectors are rejected', () => {
  for (const v of fixture.invalidMaxContentBytes) assert.equal(validMax(v), false, String(v));
  for (const v of fixture.invalidBaseContentBytes) assert.equal(validBase(v), false, String(v));
  assert.ok(validBase(0));
});

test('docs name the capability, markers, guard and error code', () => {
  assert.equal(fixture.status, 'shipped-specification-examples');
  assert.equal(fixture.capability.noteTruncatedRead, 1);
  for (const needle of ['### Truncated note reads (additive contract)', 'server.capabilities.noteTruncatedRead',
    '`maxContentBytes`', 'contentTruncated: true', '`contentBytes`', '`baseContentBytes`',
    'content-base-mismatch', 'resolvedBaseBytes', '**Not covered.**', 'fixtures/notes/truncated-read.json'])
    assert.ok(docs.includes(needle), needle);
});
