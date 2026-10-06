import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pagingBackendId } from './contract.mjs';
const fixture = JSON.parse(await readFile(new URL('./contract.json', import.meta.url)));
const hello = caps => ({ result: { server: { capabilities: caps } } });

test('read paging uses its own exact capability and rejects the legacy write promise', () => {
  assert.equal(pagingBackendId(hello({ notePagingRead: 1, notePagingBackendId: 'db-a' })), 'db-a');
  for (const caps of [{ notePaging: 1 }, { notePagingRead: true }, { notePagingRead: '1' }, { notePagingRead: 2 }, {}])
    assert.equal(pagingBackendId(hello({ notePagingBackendId: 'db-a', ...caps })), null);
});

test('read-only fixture freezes the complete opt-in allowlist without partial writes', () => {
  assert.deepEqual(fixture.readOnly, {
    noteGetKinds: ['source', 'context', 'metadata', 'taskIds'],
    annotationKinds: { 'note.lineAttribution.load': 'attribution', 'comment.list': 'comments', 'comment.getThread': 'replies' },
    subscriptions: ['note.subscribe', 'comment.subscribe'],
    projection: 'pageState',
  });
  assert.equal(fixture.capabilities.notePaging, undefined);
  for (const request of fixture.requests) assert.ok(['note.get', ...Object.keys(fixture.readOnly.annotationKinds)].includes(request.method));
});

test('prepared protocol omits edit RPCs and retains full-content concurrency caveat', async () => {
  const docs = await readFile(new URL('../../methods/notes-tasks.md', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../../05-method-catalog.md', import.meta.url), 'utf8');
  for (const text of [docs, catalog]) assert.doesNotMatch(text, /\| note\.(applySplices|operationStatus|operation\.(begin|append|seal|read|commit|cancel)) \|/);
  assert.match(docs, /300,000 UTF-8 bytes/);
  assert.match(docs, /missing retained version snapshot/);
  assert.match(docs, /note.update \{ workspaceId, noteId, content, expectedVersion \}/);
  assert.match(docs, /Never omit the revision or retry\nunconditionally/);
  assert.match(docs, /initial content write and conversion are not one atomic/);
  assert.match(docs, /Intentional empty, quoted, JSON-looking/);
  assert.match(docs, /strict `expectedVersion` CAS/);
  assert.match(docs, /sourceLength.*UTF-16/);
});

test('13.8 allocation follows owner avatars and catalog counts reflect only retained methods', async () => {
  const versioning = await readFile(new URL('../../versioning.md', import.meta.url), 'utf8');
  assert.match(versioning, /\*\*Documented version:\*\* `13\.8`/);
  const section = versioning.split('**Version 13.8 —')[1].split('**Version 13.7 —')[0];
  assert.match(section, /`notePagingRead: 1`/);
  assert.match(section, /443 \/ 387 \/ 56/);
  assert.match(section, /`noteAnnotations: 1` separately requires/);
  const avatars = versioning.split('**Version 13.7 —')[1].split('**Version 13.6 —')[0];
  assert.match(avatars, /`gitlabCheckoutOwnerAvatar: 1`/);
  const catalog = await readFile(new URL('../../05-method-catalog.md', import.meta.url), 'utf8');
  const row = catalog.split('\n').find(line => line.startsWith('| note |'));
  const methods = row.split('|')[3].trim().split(', ');
  assert.equal(methods.length, 18);
  assert.ok(!methods.some(name => name.startsWith('operation') || name === 'applySplices'));
});

test('source admission rejects missing snapshot identity even when text is exact', async () => {
  const { assertSourcePage } = await import('./contract.mjs');
  const page = { jsonrpc: '2.0', id: 1, result: {
    kind: 'noteSourcePage', scope: fixture.scope, sourceRevision: 'r:7',
    snapshotId: 'snapshot-a', expiresAt: '2026-10-03T00:05:00.000Z',
    sourceLength: 3, range: { start: 0, end: 3 }, text: 'a😀',
    nextCursor: null, previousCursor: null, contextRef: 'context-a', metadataRef: 'metadata-a',
  } };
  assertSourcePage('a😀', page, fixture.limits);
  for (const key of ['scope', 'sourceRevision', 'snapshotId', 'expiresAt', 'contextRef', 'metadataRef']) {
    const bad = structuredClone(page); delete bad.result[key];
    assert.throws(() => assertSourcePage('a😀', bad, fixture.limits), key);
  }
});
