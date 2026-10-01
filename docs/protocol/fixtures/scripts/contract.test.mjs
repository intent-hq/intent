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
    assert.deepEqual(c.expect.scriptIds, select(c.request.params.archive ?? 'all'), c.id);
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

test('omitted wire filters retain archived definitions for legacy refetches', () => {
  const defaultList = fixture.cases.find(c => c.id === 'list-default');
  const allList = fixture.cases.find(c => c.id === 'list-all');
  assert.equal(defaultList.request.params.archive, undefined);
  assert.deepEqual(defaultList.expect.scriptIds, allList.expect.scriptIds);
  assert.match(scriptsDoc, /default `all`/);
  const legacy = fixture.scenarios.find(c => c.id === 'old-client-new-daemon');
  assert.equal(legacy.expect.defaultListArchive, 'all');
});

test('selected-output examples exercise an archive transition and both client generations', () => {
  for (const id of ['archive-selected-output-tab', 'old-client-refetch-after-archive']) {
    const c = fixture.scenarios.find(c => c.id === id);
    assert.ok(c?.initialScript, id);
    assert.equal(c.initialScript.archivedAt, undefined, id);
    assert.equal(c.initialScript.runtime.status, 'exited', id);
    assert.equal(c.fixtureControl.scriptId, c.initialScript.id, id);
    assert.deepEqual(c.expect.changedIds, [c.initialScript.id], id);
    assert.equal(c.expect.tabOpen, true, id);
    assert.equal(c.expect.selectionPreserved, true, id);
  }
  const legacy = fixture.scenarios.find(c => c.id === 'old-client-refetch-after-archive');
  assert.equal(legacy.fixtureControl.refetch.params.archive, undefined);
  assert.equal(legacy.expect.archivedRowInResponse, true);
  assert.equal(legacy.expect.definitionAndRuntimeRetained, true);
  for (const id of ['lifecycle-aware-ui-list-default', 'lifecycle-aware-mcp-list-default']) {
    const c = fixture.scenarios.find(c => c.id === id);
    assert.equal(c?.expect.wireParams.archive, 'active', id);
  }
});

test('creation examples separate new command defaults from persistence and hydration', () => {
  const cases = new Map(fixture.cases.map(c => [c.id, c]));
  for (const [id, mode, purpose] of [
    ['new-command-default-is-one-off', 'command', 'oneOff'],
    ['new-service-default-is-saved', 'service', 'saved'],
    ['new-explicit-saved-command', 'command', 'saved'],
    ['new-autostart-explicit-saved-command', 'command', 'saved'],
    ['upsert-retains-saved-purpose', 'command', 'saved'],
    ['upsert-retains-explicit-purpose', 'command', 'oneOff'],
  ]) {
    const c = cases.get(id);
    assert.ok(c, id);
    assert.equal(c.request.params.mode, mode, id);
    assert.equal(c.expect.definitionSubset.purpose, purpose, id);
    if (id.includes('default') || id.startsWith('upsert-retains')) {
      assert.equal(c.request.params.purpose, undefined, id);
    } else assert.equal(c.request.params.purpose, 'saved', id);
  }
  for (const id of ['new-autostart-default-rejected', 'upsert-one-off-autostart-rejected']) {
    const c = cases.get(id);
    assert.ok(c, id);
    assert.equal(c.request.params.purpose, undefined, id);
    assert.equal(c.request.params.autoStart, true, id);
    assert.equal(c.expect.errorCode, -32602, id);
    assert.equal(c.expect.noMutation, true, id);
  }
  assert.equal(cases.get('new-autostart-explicit-saved-command').request.params.autoStart, true);
  const legacy = fixture.scenarios.find(c => c.id === 'legacy-hydration-remains-saved');
  assert.ok(legacy);
  assert.equal(legacy.initialScript.purpose, undefined);
  assert.equal(legacy.expect.purpose, 'saved');
  assert.equal(legacy.expect.archived, false);
  assert.equal(fixture.scenarios.find(c => c.id === 'old-client-new-daemon').expect.defaultPurpose, 'oneOff');
  assert.equal(fixture.scenarios.find(c => c.id === 'old-daemon-no-capability').expect.defaultPurpose, 'saved');
});
