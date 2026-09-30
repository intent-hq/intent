import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixture = JSON.parse(await readFile(new URL('./lifecycle.json', import.meta.url), 'utf8'));
const scriptsDoc = await readFile(new URL('../../methods/scripts.md', import.meta.url), 'utf8');
const catalog = await readFile(new URL('../../05-method-catalog.md', import.meta.url), 'utf8');

// These are static checks on prepared examples, not a script runtime simulator.
// Component suites must execute the cases and controlled races against real code.
test('prepared examples name documented methods and do not claim runtime proof', () => {
  assert.equal(fixture.status, 'prepared-not-executed');
  assert.deepEqual(fixture.capability, { scriptLifecycle: 1 });
  const entries = [...fixture.cases, ...fixture.scenarios];
  assert.equal(new Set(entries.map(c => c.id)).size, entries.length);
  for (const c of fixture.cases) {
    assert.ok(scriptsDoc.includes(`| ${c.request.method} |`), c.id);
    assert.equal(c.request.params.workspaceId, 'ws-a', c.id);
    assert.ok(c.expect && Object.keys(c.expect).length, c.id);
  }
  assert.match(catalog, /\| script \| 11 \| archive, create, list, output, remove, restart, restore, run, start, status, stop \|/);
  assert.ok(scriptsDoc.includes('scriptLifecycle: 1'));
});

test('list examples partition definitions without losing failures from history', () => {
  const select = archive => fixture.seed
    .filter(row => archive === 'all' || Boolean(row.archivedAt) === (archive === 'archived'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(row => row.id);
  for (const c of fixture.cases.filter(c => c.id.startsWith('list-'))) {
    assert.deepEqual(c.expect.scriptIds, select(c.request.params.archive ?? 'active'), c.id);
  }
  assert.ok(select('archived').includes('failed'));
  assert.ok(!select('active').includes('failed'));
  assert.ok(!select('active').includes('successful'));
});

test('batch examples account for every selected ID exactly once and retain order', () => {
  for (const c of fixture.cases.filter(c => c.expect.result?.skipped)) {
    const successKey = c.request.method === 'script.archive' ? 'archived' : 'restored';
    const selected = [...new Set(c.request.params.scriptIds)];
    const success = c.expect.result[successKey];
    const skipped = c.expect.result.skipped.map(r => r.scriptId);
    assert.deepEqual([...success, ...skipped].sort(), [...selected].sort(), c.id);
    assert.deepEqual(success, selected.filter(id => success.includes(id)), c.id);
    assert.deepEqual(skipped, selected.filter(id => skipped.includes(id)), c.id);
    for (const r of c.expect.result.skipped) {
      assert.ok((successKey === 'archived' ? ['live', 'service', 'notFound'] : ['notFound']).includes(r.reason), c.id);
    }
    for (const id of c.expect.changedIds ?? []) assert.ok(success.includes(id), c.id);
  }
});

test('result examples cannot represent failure or cancellation as automatic success', () => {
  for (const c of fixture.scenarios.filter(c => c.fixtureControl.terminalOutcome)) {
    const r = c.expect.lastRun;
    assert.ok(['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.outcome), c.id);
    if (c.expect.status === 'exited') assert.ok(Number.isInteger(r.exitCode), c.id);
    else {
      assert.equal(c.expect.status, 'idle', c.id);
      assert.equal(r.outcome, 'cancelled', c.id);
      assert.equal(r.exitCode, undefined, c.id);
      assert.equal(c.expect.stopAwareHookRequired, true, c.id);
    }
    assert.ok(Number.isFinite(Date.parse(r.stoppedAt)), c.id);
    if (r.exitCode === -1) assert.ok(r.error, c.id);
    if (r.outcome === 'succeeded') {
      assert.equal(r.exitCode, 0, c.id);
      assert.equal(r.error, undefined, c.id);
    }
    assert.equal(c.expect.archived, c.fixtureControl.purpose === 'oneOff', c.id);
    if (c.expect.archived && r.outcome !== 'succeeded') assert.equal(c.expect.historyFailureVisible, true, c.id);
    assert.equal(c.expect.hookDispatch, true, c.id);
    assert.equal(c.expect.outputAddressable, true, c.id);
    if (c.expect.archived) assert.deepEqual(c.expect.eventOrder, ['script:state', 'script:changed']);
  }
});

test('required concurrency, persistence, cancellation and compatibility examples exist', () => {
  const required = [
    'archive-start-order-start-first', 'archive-start-order-archive-first',
    'archive-run-reservation', 'archive-supervisor-teardown', 'archive-unknown-future-state',
    'restart-predecessor-success', 'late-exit-after-upsert', 'late-exit-after-rerun',
    'cancel-run-waiter-before-spawn', 'cancel-run-waiter-after-spawn',
    'archive-write-failure', 'restore-write-failure-before-start', 'partial-batch-write-failure',
    'restart-archived-success', 'restart-failed-one-off',
    'daemon-loss-starting', 'daemon-loss-running', 'daemon-loss-run-reservation', 'daemon-loss-restarting',
    'all-archived-no-bootstrap', 'old-daemon-no-capability', 'old-client-new-daemon',
    'archive-selected-output-tab', 'reconnect-archived-open-tab',
    'manual-archive-legacy-unknown-result', 'reject-selection-limit', 'accept-selection-limit',
  ];
  for (const id of required) assert.ok(fixture.scenarios.some(c => c.id === id), id);
  for (const c of fixture.scenarios.filter(c => c.id.startsWith('daemon-loss-'))) {
    assert.equal(c.expect.archived, true, c.id);
    assert.equal(c.expect.historyFailureVisible, true, c.id);
    assert.equal(c.expect.lastRun.outcome, 'interrupted', c.id);
    assert.equal(c.expect.lastRun.exitCode, -1, c.id);
    assert.equal(c.expect.hookDispatch, true, c.id);
  }
  assert.equal(fixture.scenarios.find(c => c.id === 'restart-archived-success').expect.outputMayBeEmpty, true);
});
