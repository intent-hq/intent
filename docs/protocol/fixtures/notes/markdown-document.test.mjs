import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertContextFrame } from './contract.mjs';
const common = JSON.parse(await readFile(new URL('./contract.json', import.meta.url)));
const owner = { kind: 'boundary', id: 'markdown-document', construct: 'markdownDocument',
  profile: 'canonicalNote', profileVersion: 1, entryPath: 'markdown',
  sourceRange: { start: 0, end: 22 }, nativeRef: 'native-doc', attributesRef: 'doc-attrs',
  sourceMapRef: 'window-separators', continuationBefore: false, continuationAfter: false };
const frame = item => ({ jsonrpc: '2.0', id: 'document', result: {
  kind: 'noteContextPage', scope: common.scope, sourceRevision: 'r:7', snapshotId: 'snapshot-a',
  expiresAt: '2026-10-03T00:05:00.000Z', items: [item], nextCursor: null,
} });

test('Markdown document owner rejects malformed profile, entry path and references', () => {
  assertContextFrame(frame(owner), common.limits);
  for (const mutate of [x => { x.profile = 'other'; }, x => { x.profileVersion = 2; },
    x => { x.entryPath = 'html'; }, x => { x.sourceRange.start = 1; },
    x => { delete x.nativeRef; }, x => { delete x.attributesRef; },
    x => { delete x.sourceMapRef; }]) {
    const bad = structuredClone(owner); mutate(bad);
    assert.throws(() => assertContextFrame(frame(bad), common.limits));
  }
});

test('Markdown direct owner excludes window bindings and continuation flags', () => {
  const direct = structuredClone(owner);
  for (const key of ['sourceMapRef', 'continuationBefore', 'continuationAfter']) delete direct[key];
  assertContextFrame(frame(direct), common.limits, { directOwner: true });
  for (const key of ['sourceMapRef', 'continuationBefore', 'continuationAfter']) {
    const bad = { ...direct, [key]: owner[key] };
    assert.throws(() => assertContextFrame(frame(bad), common.limits, { directOwner: true }));
  }
});

const fixture = JSON.parse(await readFile(new URL('./markdown-document.json', import.meta.url)));
const { assertMarkdownDocumentResources, wireBytes, boundary } = await import('./contract.mjs');
const range = ([start, end]) => ({ start, end });
const sourceOf = c => c.source ?? c.recipe.prefix + c.recipe.repeat.repeat(c.recipe.count) + c.recipe.suffix;
function resources(c, w) {
  const source = sourceOf(c), stable = structuredClone(fixture.owner);
  stable.sourceRange.end = source.length;
  const occurrence = { ...stable, sourceMapRef: `maps-${w.range.join('-')}`,
    continuationBefore: w.range[0] > 0, continuationAfter: w.range[1] < source.length };
  const maps = w.maps.map((r, i) => ({ kind: 'sourceMap', id: `separator-${i}`,
    profile: 'canonicalNote', profileVersion: 1, ownerRef: fixture.ownerRef,
    sourceRange: range(r), renderedRange: { start: 0, end: 0 }, mapping: 'omitted',
    textNodeId: null, textNodeRef: null, textRef: null }));
  const mapFrame = frame(stable); mapFrame.result.items = maps;
  const occurrenceFrame = frame(occurrence);
  if (!maps.length) occurrenceFrame.result.items = [];
  return { source, window: range(w.range), ownerRef: fixture.ownerRef, nativeRef: fixture.nativeRef,
    ownerFrame: c.separators.length ? frame(stable) : null,
    nativeFrame: c.separators.length ? frame(structuredClone(fixture.root)) : null,
    occurrenceFrame, mapFrames: maps.length ? [mapFrame] : [], separatorRanges: c.separators.map(range) };
}
for (const c of fixture.cases) test(`Markdown exact separator ownership: ${c.id}`, () => {
  const source = sourceOf(c);
  // Independent fixture partition: separators must neither expand nor overlap block owners.
  const partition = [...c.blocks.map(b => b.range), ...c.separators].sort((a,b) => a[0]-b[0]);
  let end = 0;
  for (const r of partition) {
    assert.equal(r[0], end); assert.ok(r[1] > r[0]);
    assert.ok(boundary(source, r[0]) && boundary(source, r[1])); end = r[1];
  }
  assert.equal(end, source.length);
  const owners = c.windows.map(w => resources(c,w));
  for (const r of owners) assertMarkdownDocumentResources(r, common.limits);
  for (const r of owners) assert.deepEqual(r.ownerFrame, owners[0].ownerFrame);
  const refs = owners.flatMap(r => r.occurrenceFrame.result.items.map(o => o.sourceMapRef));
  assert.equal(new Set(refs).size, refs.length);
});

test('Markdown document rejects wrong root, owner binding, scope and omitted coverage', () => {
  const good = resources(fixture.cases[0], fixture.cases[0].windows[0]);
  const native = r => r.nativeFrame.result.items[0];
  const map = r => r.mapFrames[0].result.items[0];
  for (const mutate of [r => { native(r).nodeType = 'paragraph'; },
    r => { native(r).nodeClass = 'atom'; }, r => { native(r).parentRef = 'parent'; },
    r => { native(r).childIndex = 1; }, r => { native(r).attributesRef = 'other'; },
    r => { native(r).sourceRange = { start: 2, end: 2 }; },
    r => { r.ownerFrame.result.items[0].sourceRange.end--; },
    r => { r.nativeRef = 'wrong-root'; }, r => { map(r).ownerRef = 'wrong-owner'; },
    r => { map(r).sourceRange = { start: 20, end: 22 }; },
    r => { map(r).mapping = 'projection'; }, r => { map(r).textNodeId = 'fake-leaf'; map(r).textNodeRef = 'fake-ref'; },
    r => { r.mapFrames[0].result.items = []; }, r => { r.mapFrames[0].result.items.push(structuredClone(map(r))); },
    r => { r.mapFrames[0].result.snapshotId = 'different'; },
    r => { r.occurrenceFrame.result.items[0].nativeRef = 'different'; }]) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => assertMarkdownDocumentResources(bad, common.limits));
  }
});

test('Markdown document window frames retain escaped byte and item limits', () => {
  const r = resources(fixture.cases[2], fixture.cases[2].windows[0]);
  const max = Math.max(...[r.ownerFrame,r.nativeFrame,r.occurrenceFrame,...r.mapFrames].map(wireBytes));
  assertMarkdownDocumentResources(r,{...common.limits,wireBytes:max});
  assert.throws(() => assertMarkdownDocumentResources(r,{...common.limits,wireBytes:max-1}));
  assert.throws(() => assertMarkdownDocumentResources(r,{...common.limits,items:0}));
});

test('Markdown separators remain complete across bounded map pages and reject a missing seam', () => {
  const c = fixture.cases.find(c => c.id === 'leading-trailing-unicode');
  const r = resources(c,c.windows[0]);
  const combined = r.mapFrames[0];
  r.mapFrames = combined.result.items.map(item => ({ ...combined,
    result: { ...combined.result, items: [item] } }));
  assertMarkdownDocumentResources(r,{...common.limits,items:1});
  const missing = structuredClone(r); missing.mapFrames.pop();
  assert.throws(() => assertMarkdownDocumentResources(missing,common.limits));
  const scalarSplit = structuredClone(r); scalarSplit.window.start = 4;
  assert.throws(() => assertMarkdownDocumentResources(scalarSplit,common.limits));
  const notASep = structuredClone(r);
  notASep.mapFrames[0].result.items[0].sourceRange = {start:1,end:3};
  assert.throws(() => assertMarkdownDocumentResources(notASep,common.limits));
});

test('Markdown empty, no-gap and block-only windows cannot invent separator admission', () => {
  for (const c of fixture.cases) for (const w of c.windows.filter(w => !w.maps.length)) {
    const r = resources(c,w);
    r.occurrenceFrame.result.items = [structuredClone(owner)];
    assert.throws(() => assertMarkdownDocumentResources(r,common.limits));
  }
});

test('Markdown separator documentation preserves the strict admission and rollout guarantees', async () => {
  const docs = await readFile(new URL('../../methods/notes-tasks.md',import.meta.url),'utf8');
  for (const required of ['construct: "markdownDocument"', 'union of original parser-event',
    'not the complement of successfully', 'no paragraph/heading overlaps',
    'empty native range', 'sourceLength', 'CR from LF', 'fixed expiry',
    'Additive documentation lands before']) assert.ok(docs.includes(required),required);
});
