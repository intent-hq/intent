import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { scriptSummary, monitorSummary, page, representativeRows, bytes } from './compact-model.mjs';

const fixture = JSON.parse(await readFile(new URL('./compact.json', import.meta.url), 'utf8'));

test('portable goldens pin exact full/detail versus summary shapes', () => {
  assert.equal(fixture.status, 'prepared-not-executed');
  assert.deepEqual(fixture.capability, { scriptActiveLists: 1, scriptMonitors: 2 });
  for (const example of fixture.examples)
    assert.deepEqual((example.kind === 'script' ? scriptSummary : monitorSummary)(example.full), example.summary);
  assert.equal(new Set(fixture.componentScenarios.map(row => row.id)).size, fixture.componentScenarios.length);
});

// Prepared contract oracle only: component tests must feed real service responses
// into these assertions. Passing this model does not prove daemon/renderer support.
test('compact scripts cannot carry definitions or output, even with oversized fields', () => {
  const { scripts } = representativeRows();
  const source = { ...scripts[0], healthUrl: 'http://localhost/ready', readyPattern: 'ready', output: 'synthetic output', stdout: 'synthetic stdout', stderr: 'synthetic stderr' };
  const before = structuredClone(source);
  const row = scriptSummary(source);
  for (const key of ['command', 'cwd', 'env', 'healthUrl', 'readyPattern', 'output', 'stdout', 'stderr'])
    assert.equal(Object.hasOwn(row, key), false, key);
  assert.equal(row.commandPreview, 'x'.repeat(160));
  assert.equal(row.commandTruncated, true);
  assert.equal(row.runtime.error, 'e'.repeat(256));
  assert.equal(row.runtime.errorTruncated, true);
  assert.equal(row.lastRun.errorTruncated, true);
  assert.equal(row.runtime.exitCode, -1);
  assert.equal(row.runtime.runId, source.runtime.runId);
  assert.deepEqual(source, before, 'projection must not shrink detail/event source');
});

test('previews truncate UTF-8 on scalar boundaries and preserve omission and empty strings', () => {
  const source = representativeRows(1).scripts[0];
  const row = scriptSummary({ ...source, command: '😀'.repeat(41), runtime: { status: 'idle', restartCount: 0 } });
  assert.equal(row.commandPreview, '😀'.repeat(40));
  assert.equal(Buffer.byteLength(row.commandPreview), 160);
  assert.equal(row.runtime.error, undefined);
  assert.equal(row.runtime.errorTruncated, undefined);
  const empty = scriptSummary({ ...source, command: '', runtime: { status: 'exited', restartCount: 0, exitCode: -1, error: '' } });
  assert.equal(empty.commandPreview, '');
  assert.equal(empty.commandTruncated, false);
  assert.equal(empty.runtime.error, '');
  assert.equal(empty.runtime.errorTruncated, undefined);
});

test('active monitor summaries omit terminal decisions and full patterns', () => {
  const source = representativeRows(1).monitors[0];
  const before = structuredClone(source);
  const row = monitorSummary(source);
  assert.equal(row.outputPattern, undefined);
  assert.equal(row.outputPatternPreview, 'p'.repeat(160));
  assert.equal(row.outputPatternTruncated, true);
  assert.equal(row.trigger, undefined);
  assert.equal(row.reason, undefined);
  assert.equal(row.state, 'active');
  assert.deepEqual(source, before, 'full monitor events/wakes/get remain canonical');
});

test('explicit full-data export can traverse all pages in descending ID order', () => {
  const rows = representativeRows(3174).scripts.filter(row => !row.archivedAt);
  const params = { workspaceId: 'ws-a', view: 'summary', archive: 'active', limit: 200 };
  let cursor;
  const ids = [];
  do {
    const result = page('script.list', rows, { ...params, ...(cursor ? { cursor } : {}) });
    assert.equal(result.view, 'summary');
    assert.ok(result.scripts.length <= 200);
    ids.push(...result.scripts.map(row => row.id));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, rows.map(row => row.id).sort().reverse());
  assert.equal(new Set(ids).size, 1587);
  assert.equal(page('script.list', rows, { ...params, limit: undefined }).scripts.length, 100);
});

test('visible collection contract requires first-page-only hydration and explicit Load more', async () => {
  assert.deepEqual(fixture.presentation, {
    initialPagesPerVisibleCollection: 1,
    nextPage: 'explicit-load-more',
    completeWhen: 'nextCursor-absent',
    automaticTraversal: 'explicit-full-data-operation-only',
    serverScriptFilters: ['unarchived-only'],
    purposeDisplay: 'loaded-rows-only',
  });
  const doc = await readFile(new URL('../../methods/scripts.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('Initial hydration reads only the first page per visible collection'));
  assert.ok(doc.includes('**Load more**'));
  assert.ok(doc.includes('No server-side purpose filter'));
  assert.doesNotMatch(doc.split('\n').find(line => line.startsWith('| script.list |')), /purpose/);
  assert.doesNotMatch(doc, /Load all needed\nactive pages/);
});

test('more than one page of active monitors remains partial until explicit Load more', () => {
  const rows = representativeRows(250).monitors.map((row, i) => {
    const active = { ...row, state: 'active', agentId: `agent-${Math.floor(i / 5)}` };
    for (const key of ['settledAt', 'reason', 'trigger']) delete active[key];
    return active;
  });
  const params = { workspaceId: 'ws-a', view: 'summary', state: 'active' };
  const first = page('scriptMonitor.list', rows, params);
  assert.equal(first.monitors.length, 100);
  assert.ok(first.nextCursor, 'first page must keep Load more available');
  // These calls stand for separate user Load more actions, not hydration.
  const second = page('scriptMonitor.list', rows, { ...params, cursor: first.nextCursor });
  assert.equal(second.monitors.length, 100);
  assert.ok(second.nextCursor);
  const third = page('scriptMonitor.list', rows, { ...params, cursor: second.nextCursor });
  assert.equal(third.monitors.length, 50);
  assert.equal(third.nextCursor, undefined);
  assert.equal(new Set([...first.monitors, ...second.monitors, ...third.monitors].map(row => row.monitorId)).size, 250);
});

test('loaded purpose groups cannot claim absence or discard their collection cursor', () => {
  const rows = representativeRows(250).scripts.map((row, i) => {
    const active = { ...row, purpose: i >= 150 ? 'oneOff' : 'saved' };
    delete active.archivedAt;
    return active;
  });
  const params = { workspaceId: 'ws-a', view: 'summary', archive: 'active' };
  const first = page('script.list', rows, params);
  assert.equal(first.scripts.length, 100);
  assert.equal(first.scripts.filter(row => row.purpose === 'saved').length, 0);
  assert.ok(first.nextCursor, 'no saved rows loaded does not mean no saved rows exist');
  const next = page('script.list', rows, { ...params, cursor: first.nextCursor });
  assert.equal(next.scripts.filter(row => row.purpose === 'saved').length, 100);
  assert.ok(next.nextCursor, 'local grouping does not make the archive partition complete');
});

test('cursor binds method, workspace and effective filters, but permits a different page size', () => {
  const rows = representativeRows(4).scripts.map(({ archivedAt, ...row }) => row);
  const params = { workspaceId: 'ws-a', view: 'summary', archive: 'active', limit: 1 };
  const cursor = page('script.list', rows, params).nextCursor;
  assert.equal(page('script.list', rows, { ...params, cursor, limit: 2 }).scripts.length, 2);
  for (const changed of [{ workspaceId: 'ws-b' }, { view: 'full' }])
    assert.throws(() => page('script.list', rows, { ...params, ...changed, cursor }), /InvalidParams/);
  assert.throws(() => page('scriptMonitor.list', [], { workspaceId: 'ws-a', view: 'summary', cursor }), /InvalidParams/);
  assert.throws(() => page('script.list', rows, { ...params, cursor: 'invalid' }), /InvalidParams/);
});

test('deleting cursor boundaries does not skip rows; inserts ahead require refresh', () => {
  const rows = representativeRows(4).scripts.map(({ archivedAt, ...row }) => row);
  const params = { workspaceId: 'ws-a', view: 'summary', limit: 2 };
  const first = page('script.list', rows, params);
  const survivors = rows.slice(0, 2);
  const inserted = { ...rows[0], id: '99999' };
  const next = page('script.list', [...survivors, inserted], { ...params, cursor: first.nextCursor });
  assert.deepEqual(next.scripts.map(row => row.id), ['00001', '00000']);
  assert.equal(next.nextCursor, undefined);
  assert.equal(page('script.list', [...survivors, inserted], params).scripts[0].id, '99999');
});

test('ID ties use UTF-8 ordering and long existing IDs remain pageable', () => {
  const { archivedAt, ...template } = representativeRows(1).scripts[0];
  const ids = ['\uE000', '😀', 'z'.repeat(5000)];
  const rows = ids.map(id => ({ ...template, id }));
  const params = { workspaceId: 'ws-a', view: 'summary', limit: 1 };
  const first = page('script.list', rows, params);
  const second = page('script.list', rows, { ...params, cursor: first.nextCursor });
  const third = page('script.list', rows, { ...params, cursor: second.nextCursor });
  assert.deepEqual([first, second, third].map(p => p.scripts[0].id), ['😀', '\uE000', ids[2]]);
  rows.push({ ...template, id: 'a' });
  const long = page('script.list', rows, { ...params, cursor: second.nextCursor });
  assert.ok(long.nextCursor.length > 4096);
  assert.equal(page('script.list', rows, { ...params, cursor: long.nextCursor }).scripts[0].id, 'a');
});

test('summary options reject invalid values; full reads preserve eligible row shapes and ascending order', () => {
  const rows = representativeRows(3).scripts;
  for (const limit of [null, 0, -1, 201, 1.5, '2', false])
    assert.throws(() => page('script.list', rows, { workspaceId: 'ws-a', view: 'summary', limit }), /InvalidParams/);
  for (const options of [{ view: null }, { view: 'unknown' }, { limit: 1 }, { cursor: 'x' }, { view: 'summary', cursor: null }, { view: 'summary', archive: null }])
    assert.throws(() => page('script.list', rows, { workspaceId: 'ws-a', ...options }), /InvalidParams/);
  const legacy = page('script.list', rows, { workspaceId: 'ws-a' });
  assert.deepEqual(legacy, { scripts: rows.filter(row => !row.archivedAt) });
  assert.deepEqual(page('script.list', rows, { workspaceId: 'ws-a', view: 'full' }), legacy);
});

test('filters precede paging; active monitors do not require downloading retained history', () => {
  const { scripts, monitors } = representativeRows(250);
  for (const row of monitors) row.state = 'completed';
  scripts[1].workspaceId = 'ws-b';
  assert.equal(page('script.list', scripts, { workspaceId: 'ws-a', view: 'summary', archive: 'active', limit: 200 }).scripts.length, 124);
  monitors[200] = { ...monitors[200], state: 'active' };
  delete monitors[200].settledAt;
  delete monitors[200].reason;
  delete monitors[200].trigger;
  const active = page('scriptMonitor.list', monitors, { workspaceId: 'ws-a', view: 'summary', state: 'active' });
  assert.deepEqual(active.monitors.map(row => row.monitorId), [monitors[200].monitorId]);
  assert.equal(active.nextCursor, undefined);
  assert.deepEqual(page('scriptMonitor.list', monitors, { workspaceId: 'ws-a', view: 'summary', agentId: 'unknown' }).monitors, []);
});

test('reference reductions cover eligible definitions and active monitor configuration', () => {
  const { scripts, monitors } = representativeRows(1000);
  for (const [method, rows, key] of [['script.list', scripts, 'scripts'], ['scriptMonitor.list', monitors, 'monitors']]) {
    const legacy = page(method, rows, { workspaceId: 'ws-a' });
    const compact = page(method, rows, { workspaceId: 'ws-a', view: 'summary' });
    assert.equal(compact[key].length, 100);
    assert.ok(bytes(compact) < bytes(legacy) / 10);
  }
});

test('prepared method tables document the summary discriminator and detail reads', async () => {
  const scriptDoc = await readFile(new URL('../../methods/scripts.md', import.meta.url), 'utf8');
  const monitorDoc = await readFile(new URL('../../methods/script-monitors.md', import.meta.url), 'utf8');
  assert.ok(scriptDoc.includes('| script.get |'));
  assert.ok(scriptDoc.includes('scriptActiveLists: 1'));
  assert.ok(scriptDoc.includes('commandPreview'));
  assert.ok(monitorDoc.includes('| scriptMonitor.get |'));
});

for (const view of [undefined, 'full', 'summary']) {
  test(`all script list paths exclude archived rows and reject obsolete filters (${view})`, () => {
    const { scripts } = representativeRows(10);
    const params = { workspaceId: 'ws-a', ...(view ? { view } : {}) };
    const result = page('script.list', scripts, params);
    assert.equal(result.scripts.length, 5);
    assert.ok(result.scripts.every(row => !row.archivedAt));
    for (const archive of ['all', 'archived', null, false])
      assert.throws(() => page('script.list', scripts, { ...params, archive }), /InvalidParams/);
  });
  test(`all monitor list paths exclude terminal rows (${view})`, () => {
    const { monitors } = representativeRows(5);
    ['completed', 'triggered', 'expired', 'cancelled'].forEach((state, i) => { monitors[i].state = state; });
    const params = { workspaceId: 'ws-a', ...(view ? { view } : {}) };
    assert.deepEqual(page('scriptMonitor.list', monitors, params).monitors.map(row => row.monitorId), ['00004']);
    for (const state of ['all', 'terminal', null, false])
      assert.throws(() => page('scriptMonitor.list', monitors, { ...params, state }), /InvalidParams/);
  });
}

test('archived row bodies are never loaded and obsolete filters fail before selection', () => {
  const hidden = { id: 'archived', workspaceId: 'ws-a', archivedAt: '2026-10-01' };
  Object.defineProperty(hidden, 'command', { enumerable: true, get() { throw new Error('archived body loaded'); } });
  assert.deepEqual(page('script.list', [hidden], { workspaceId: 'ws-a' }), { scripts: [] });
  const neverRead = new Proxy([], { get() { throw new Error('query attempted'); } });
  assert.throws(() => page('script.list', neverRead, { workspaceId: 'ws-a', archive: 'all' }), /InvalidParams/);
});


test('monitor cursors bind owner and view and malformed workspaces fail before reads', () => {
  const { monitors } = representativeRows(10);
  const params = { workspaceId: 'ws-a', view: 'summary', agentId: 'agent-0', limit: 1 };
  const cursor = page('scriptMonitor.list', monitors, params).nextCursor;
  assert.ok(cursor);
  assert.throws(() => page('scriptMonitor.list', monitors, { ...params, cursor, agentId: 'agent-1' }), /InvalidParams/);
  assert.throws(() => page('scriptMonitor.list', monitors, { ...params, cursor, view: 'full' }), /InvalidParams/);
  for (const workspaceId of ['', null, undefined, 123])
    assert.throws(() => page('script.list', [], { workspaceId }), /InvalidParams/);
});
