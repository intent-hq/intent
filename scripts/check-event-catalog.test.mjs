// Fixture-driven tests for scripts/check-event-catalog.mjs.
// Run: node --test scripts/check-event-catalog.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BYTE_MISMATCH,
  EVENTS_DOC,
  FIX_HINT,
  LEAD_HINT,
  SIDECAR,
  VENDORED_COPIES,
  diffCatalogs,
  inspectRepository,
} from './check-event-catalog.mjs';

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

function error(message) {
  return `${message} — ${FIX_HINT}`;
}

function lag(message) {
  return `${message} (${LEAD_HINT})`;
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
  assert.deepEqual(await inspectRepository(root), { failures: [], warnings: [], skipped: [] });
});

test('a missing vendored copy is skipped, not failed', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: catalog,
  });
  assert.deepEqual(await inspectRepository(root), { failures: [], warnings: [], skipped: [IOS_FIXTURE] });
});

test('a copy lagging the sidecar warns without failing (docs lead the pin)', async (t) => {
  const lagging = structuredClone(catalog);
  lagging.types = ['note:created', 'workspace:updated'];
  delete lagging.discriminators['task:ready-tasks-changed'];
  lagging.discriminators['workspace:updated'].values = ['status'];
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: lagging,
    [IOS_FIXTURE]: lagging,
  });
  const expectedWarnings = [
    lag('missing type task:ready-tasks-changed'),
    lag('missing discriminator for task:ready-tasks-changed'),
    lag('discriminator workspace:updated missing value title'),
  ];
  assert.deepEqual(await inspectRepository(root), {
    failures: [],
    warnings: [
      ...expectedWarnings.map((message) => ({ source: INTENTD_GOLDEN, message })),
      ...expectedWarnings.map((message) => ({ source: IOS_FIXTURE, message })),
    ],
    skipped: [],
  });
});

test('a copy carrying what the sidecar lacks fails naming the monorepo files to update', async (t) => {
  const leading = structuredClone(catalog);
  leading.types = [...catalog.types, 'note:renamed'];
  leading.discriminators['note:renamed'] = { path: 'data.kind', kind: 'value', values: ['manual'] };
  leading.discriminators['workspace:updated'].values = ['status', 'title', 'tags'];
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: doc,
    [INTENTD_GOLDEN]: leading,
    [IOS_FIXTURE]: withTypes(catalog, ['note:created', 'workspace:updated']),
  });
  const result = await inspectRepository(root);
  assert.deepEqual(result, {
    failures: [
      { source: INTENTD_GOLDEN, message: error('unexpected type note:renamed') },
      { source: INTENTD_GOLDEN, message: error('discriminator workspace:updated unexpected value tags') },
      { source: INTENTD_GOLDEN, message: error('unexpected discriminator for note:renamed') },
    ],
    warnings: [{ source: IOS_FIXTURE, message: lag('missing type task:ready-tasks-changed') }],
    skipped: [],
  });
  for (const failure of result.failures) {
    assert.ok(failure.message.includes(SIDECAR) && failure.message.includes(EVENTS_DOC));
  }
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
    warnings: [],
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
    warnings: [],
    skipped: [],
  });
});

test('a differing discriminator is an error, a lagging one a warning', () => {
  const actual = structuredClone(catalog);
  actual.discriminators['workspace:updated'].values = ['status', 'tags'];
  actual.discriminators['task:ready-tasks-changed'].kind = 'keys';
  delete actual.discriminators['task:ready-tasks-changed'].absent;
  assert.deepEqual(diffCatalogs(catalog, actual), {
    errors: [
      'discriminator task:ready-tasks-changed.kind "keys" differs from "value"',
      'discriminator task:ready-tasks-changed.absent undefined differs from "status change"',
      'discriminator workspace:updated unexpected value tags',
    ],
    warnings: ['discriminator workspace:updated missing value title'],
  });
  const changedPath = structuredClone(catalog);
  changedPath.discriminators['workspace:updated'].path = 'data.diff';
  assert.deepEqual(diffCatalogs(catalog, changedPath), {
    errors: ['discriminator workspace:updated.path "data.diff" differs from "data.changes"'],
    warnings: [],
  });
  assert.deepEqual(diffCatalogs(catalog, { ...catalog, version: 2 }), { errors: ['version 2 differs from 1'], warnings: [] });
  assert.deepEqual(diffCatalogs(catalog, { ...catalog, discriminators: {} }), {
    errors: [],
    warnings: ['missing discriminator for task:ready-tasks-changed', 'missing discriminator for workspace:updated'],
  });
  assert.deepEqual(diffCatalogs(catalog, { ...catalog, discriminators: { ...catalog.discriminators, 'note:created': { path: 'data.kind', kind: 'value', values: [] } } }), {
    errors: ['unexpected discriminator for note:created'],
    warnings: [],
  });
});

test('a sidecar type absent from the events doc fails', async (t) => {
  const root = await fixture(t, {
    [SIDECAR]: catalog,
    [EVENTS_DOC]: '| note | note:created |\n| workspace | workspace:updated |\n',
  });
  assert.deepEqual(await inspectRepository(root), {
    failures: [{ source: EVENTS_DOC, message: `type task:ready-tasks-changed from ${SIDECAR} is not mentioned` }],
    warnings: [],
    skipped: [INTENTD_GOLDEN, IOS_FIXTURE],
  });
});

test('the CLI exits 0 on warnings and reports the count, 1 on errors', async (t) => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-event-catalog.mjs');
  const lagging = withTypes(catalog, ['note:created', 'workspace:updated']);
  const warnRoot = await fixture(t, { [SIDECAR]: catalog, [EVENTS_DOC]: doc, [INTENTD_GOLDEN]: lagging });
  const warned = spawnSync(process.execPath, [script, warnRoot], { encoding: 'utf8' });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, new RegExp(`^${INTENTD_GOLDEN}: warning: missing type task:ready-tasks-changed \\(${LEAD_HINT}\\)$`, 'm'));
  assert.match(warned.stdout, /Event catalog is in sync; checked 1 vendored copy and docs\/protocol\/06-events\.md; 1 warning\(s\): docs lead the pin\./);

  const leading = withTypes(catalog, [...catalog.types, 'note:renamed']);
  const failRoot = await fixture(t, { [SIDECAR]: catalog, [EVENTS_DOC]: doc, [INTENTD_GOLDEN]: leading });
  const failed = spawnSync(process.execPath, [script, failRoot], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /unexpected type note:renamed/);
  assert.match(failed.stderr, /check-event-catalog: 1 error\(s\)$/m);
});

test('the checked-in sidecar is valid and fully documented', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { failures } = await inspectRepository(root);
  assert.deepEqual(failures.filter((failure) => failure.source === EVENTS_DOC), []);
});
