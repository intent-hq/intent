import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertMarkdownTaskMarker } from './contract.mjs';
const fixture = JSON.parse(await readFile(new URL('./markdown-task-native.json',import.meta.url)));
const atPath = (native,path) => path.reduce((n,i) => n.content[i],native);
const walk = node => [node,...(node.content ?? []).flatMap(walk)];
for (const c of fixture.cases) {
  test(`source-bound task marker state and links: ${c.id}`, () => {
    assert.match(c.oracleSha256,/^[a-f0-9]{64}$/);
    for (const marker of c.markers) assertMarkdownTaskMarker(c.source,marker,c.native);
    assert.equal(walk(c.native).filter(n=>n.type==='taskItem').length,c.markers.length);
    const links = walk(c.native).flatMap(n => (n.marks ?? []).filter(m=>m.type==='link')
      .map(m=>({text:n.text,attrs:m.attrs})));
    assert.deepEqual(links,c.links);
    assert.deepEqual(links.map(l=>l.attrs.href),[...c.source.matchAll(/\]\((intent:\/\/[^)]+)\)/g)].map(m=>m[1]));
  });
  test(`task markers cannot vanish as sanitizer omission: ${c.id}`, () => {
    for (const marker of c.markers) for (const mutate of [n=>{n.type='listItem';},
      n=>{delete n.attrs.checked;},n=>{n.attrs.checked=!n.attrs.checked;},
      n=>{n.attrs.status='unknown';},n=>{delete n.attrs.delegatedAgentId;}]) {
      const bad = structuredClone(c.native); mutate(atPath(bad,marker.nativePath));
      assert.throws(()=>assertMarkdownTaskMarker(c.source,marker,bad));
    }
  });
}
test('mixed plain siblings and nested task ownership remain separate', () => {
  const mixed = fixture.cases.find(c=>c.id==='mixed');
  assert.ok(walk(mixed.native).some(n=>n.type==='bulletList'));
  assert.ok(walk(mixed.native).some(n=>n.type==='listItem'));
  const nested = fixture.cases.find(c=>c.id==='nested');
  assert.ok(nested.markers.some(m=>m.nativePath.length>2));
  const m = nested.markers.at(-1), bad=structuredClone(nested.native);
  const parent=atPath(bad,m.nativePath.slice(0,-1));parent.type='bulletList';
  assert.throws(()=>assertMarkdownTaskMarker(nested.source,m,bad));
});
