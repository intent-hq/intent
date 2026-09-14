// Fixture-driven tests for scripts/check-event-catalog.mjs.
// Run: node --test scripts/check-event-catalog.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BYTE_MISMATCH, EVENTS_DOC, SIDECAR, VENDORED_COPIES, diffCatalogs, inspectRepository } from './check-event-catalog.mjs';

const [INTENTD_GOLDEN, IOS_FIXTURE] = VENDORED_COPIES;

const catalog = {
  version: 1,
  types: ['note:created', 'task:ready-tasks-changed', 'workspace:updated'],
  discriminators: {
    'task:ready-tasks-changed': {
      path: 'data.triggeredBy.reason',
      kind: 'value',
      values: ['note-deleted', 'task-status-changed'],
      absent: 'status change',
    },
    'workspace:updated': { path: 'data.changes', kind: 'keys', values: ['status', 'title'] },
  },
};

const doc = '| note | note:created |\n| task | task:ready-tasks-changed |\n| workspace | workspace:updated |\n';

function withTypes(base, types) {
  return { ...base, types };
}

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-event-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('identical vendored copies pass', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: catalog,
    [IOS_FIXTURE]: catalog,
  });
  assert.deepEqual(await inspectRepository(root), { failures: [], skipped: [] });
});

test('a missing vendored copy is skipped, not failed', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: catalog,
  });
  assert.deepEqual(await inspectRepository(root), { failures: [], skipped: [IOS_FIXTURE] });
});

test('a differing type fails naming the type and the copy', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: withTypes(catalog, ['note:created', 'task:ready-tasks-changed', 'workspace:updated', 'note:renamed']),
    [IOS_FIXTURE]: withTypes(catalog, ['note:created', 'workspace:updated']),
  });
  assert.deepEqual(await inspectRepository(root), {
    failures: [
      { source: INTENTD_GOLDEN, message: 'unexpected type note:renamed' },
      { source: IOS_FIXTURE, message: 'missing type task:ready-tasks-changed' },
    ],
    skipped: [],
  });
});

test('a semantically equal copy that is not byte-identical fails', async (t) => {
  const reordered = withTypes(catalog, ['workspace:updated', 'note:created', 'task:ready-tasks-changed']);
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: reordered,
    [IOS_FIXTURE]: JSON.stringify(catalog, null, 2),
  });
  assert.deepEqual(await inspectRepository(root), {
    failures: [
      { source: INTENTD_GOLDEN, message: BYTE_MISMATCH },
      { source: IOS_FIXTURE, message: BYTE_MISMATCH },
    ],
    skipped: [],
  });

  const duplicated = withTypes(catalog, [...catalog.types, 'note:created']);
  const extraField = { ...catalog, generatedBy: 'hand' };
  const root2 = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: duplicated,
    [IOS_FIXTURE]: extraField,
  });
  assert.deepEqual(await inspectRepository(root2), {
    failures: [
      { source: INTENTD_GOLDEN, message: BYTE_MISMATCH },
      { source: IOS_FIXTURE, message: BYTE_MISMATCH },
    ],
    skipped: [],
  });
});

test('a differing discriminator fails naming the type and value', () => {
  const actual = structuredClone(catalog);
  actual.discriminators['workspace:updated'].values = ['status', 'tags'];
  actual.discriminators['task:ready-tasks-changed'].kind = 'keys';
  delete actual.discriminators['task:ready-tasks-changed'].absent;
  assert.deepEqual(diffCatalogs(catalog, actual), [
    'discriminator task:ready-tasks-changed.kind "keys" differs from "value"',
    'discriminator task:ready-tasks-changed.absent undefined differs from "status change"',
    'discriminator workspace:updated missing value title',
    'discriminator workspace:updated unexpected value tags',
  ]);
  assert.deepEqual(diffCatalogs(catalog, { ...catalog, version: 2 }), ['version 2 differs from 1']);
  assert.deepEqual(diffCatalogs(catalog, { ...catalog, discriminators: {} }), [
    'missing discriminator for task:ready-tasks-changed',
    'missing discriminator for workspace:updated',
  ]);
});

test('a sidecar type absent from the events doc fails', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: '| note | note:created |\n| workspace | workspace:updated |\n',
  });
  assert.deepEqual(await inspectRepository(root), {
    failures: [{ source: EVENTS_DOC, message: `type task:ready-tasks-changed from ${SIDECAR} is not mentioned` }],
    skipped: [INTENTD_GOLDEN, IOS_FIXTURE],
  });
});

test('the checked-in sidecar is valid and fully documented', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { failures } = await inspectRepository(root);
  assert.deepEqual(failures.filter((failure) => failure.source === EVENTS_DOC), []);
});
