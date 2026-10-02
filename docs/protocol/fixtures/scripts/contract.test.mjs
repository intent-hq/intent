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

const changes = JSON.parse(await readFile(new URL('./changed-events.json', import.meta.url), 'utf8'));

// A deliberately small client-side contract model, not the production reducer.
// Event fixtures are real §6.3 event objects; named rows/steps are harness controls.
function validChangedRow(event) {
  const row = event.data.script;
  if (!row || Array.isArray(row) || typeof row !== 'object') return false;
  const required = ['id', 'workspaceId', 'name', 'command', 'source', 'createdAt'];
  return required.every(key => typeof row[key] === 'string')
    && row.id === event.data.scriptId && row.workspaceId === event.workspaceId
    && ['command', 'service'].includes(row.mode)
    && ['saved', 'oneOff'].includes(row.purpose)
    && ['idle', 'starting', 'running', 'restarting', 'exited'].includes(row.runtime?.status)
    && Number.isInteger(row.runtime?.restartCount)
    && ['cwd', 'env', 'category', 'autoStart', 'updatedAt', 'archivedAt', 'lastRun']
      .every(key => row[key] !== null)
    && ['pid', 'exitCode', 'startedAt', 'stoppedAt', 'error', 'detectedUrl', 'previouslyRunning']
      .every(key => row.runtime[key] !== null);
}

function client(initial) {
  const rows = new Map(initial ? [[initial.id, structuredClone(initial)]] : []);
  const pending = new Map();
  const seen = new Set();
  let generation = 0;
  let request = 0;
  let output = 'retained output\n';
  let selected = true;
  let listCalls = 0;
  function apply(event, replay = false) {
    const data = event.data;
    if (event.type === 'script:state') {
      const row = rows.get(data.scriptId);
      if (row) {
        const { scriptId, ...runtime } = data;
        rows.set(scriptId, { ...row, runtime: structuredClone(runtime) });
      }
    } else if (data.action === 'removed' && typeof data.scriptId === 'string') {
      rows.delete(data.scriptId);
      selected = false;
      output = '';
    } else if (['created', 'updated'].includes(data.action) && validChangedRow(event)) {
      rows.set(data.scriptId, structuredClone(data.script));
    } else if (!replay) listCalls++;
  }
  return {
    step(step) {
      if (step.reconnect) {
        generation++;
        seen.clear();
      } else if (step.beginList) {
        pending.set(step.beginList, { generation, request: ++request, events: [] });
        listCalls++;
      } else if (step.resolveList) {
        const read = pending.get(step.resolveList);
        pending.delete(step.resolveList);
        if (read.generation !== generation || read.request !== request) return;
        // These fixtures request archive=active. Retain already known history.
        for (const [id, row] of rows) if (!row.archivedAt) rows.delete(id);
        for (const name of step.rows) {
          const row = changes.rows[name];
          rows.set(row.id, structuredClone(row));
        }
        for (const event of read.events) apply(event, true);
      } else if (step.event) {
        const event = typeof step.event === 'string' ? changes.events[step.event] : step.event;
        if ((step.generation ?? generation) !== generation
            || event.workspaceId !== changes.workspaceId || seen.has(event.id)) return;
        seen.add(event.id);
        for (const read of pending.values()) {
          if (read.generation === generation) read.events.push(event);
        }
        apply(event);
      }
    },
    result() {
      const row = rows.get('check');
      return { row, active: Boolean(row && !row.archivedAt), listCalls, output, selected };
    },
  };
}

test('changed-event fixtures contain complete wire events and document their limits', () => {
  assert.equal(changes.status, 'synthetic-contract-model-not-component-proof');
  assert.match(scriptsDoc, /zero event-triggered `script.list` calls/);
  assert.match(scriptsDoc, /Optional\nfields follow the same types and omission rules/);
  assert.equal(new Set(changes.cases.map(c => c.id)).size, changes.cases.length);
  for (const [name, event] of Object.entries(changes.events)) {
    assert.deepEqual(Object.keys(event).sort(), ['actor', 'data', 'id', 'timestamp', 'type', 'workspaceId']);
    assert.ok(Number.isFinite(Date.parse(event.timestamp)), name);
    if (event.data.script) {
      assert.ok(validChangedRow(event), name);
      const row = event.data.script;
      if (row.purpose === 'oneOff') {
        assert.equal(row.mode, 'command', name);
        assert.notEqual(row.autoStart, true, name);
      }
      if (row.runtime.status === 'exited') assert.ok(Number.isInteger(row.runtime.exitCode), name);
      if (row.lastRun?.outcome === 'succeeded') assert.equal(row.lastRun.exitCode, 0, name);
    }
  }
});

for (const c of changes.cases) {
  test(`self-contained changes: ${c.id}`, () => {
    const state = client(changes.rows[c.initial]);
    for (const step of c.steps) state.step(step);
    const actual = state.result();
    const expectedRow = c.expect.row ? structuredClone(changes.rows[c.expect.row]) : undefined;
    if (c.expect.runtime) expectedRow.runtime = c.expect.runtime;
    assert.deepEqual(actual.row, expectedRow);
    for (const key of ['active', 'listCalls', 'output', 'selected']) {
      if (key in c.expect) assert.equal(actual[key], c.expect[key], key);
    }
  });
}

test('absent, null, incomplete and mismatched snapshots reconcile without replacing', () => {
  const malformed = [undefined, null, {}, { ...changes.rows.complete, runtime: undefined },
    { ...changes.rows.complete, id: 'foreign' },
    { ...changes.rows.complete, workspaceId: 'ws-b' },
    { ...changes.rows.complete, archivedAt: null }];
  for (const script of malformed) {
    const state = client(changes.rows.running);
    state.step({ event: { ...changes.events.complete, data: {
      scriptId: 'check', action: 'updated', ...(script === undefined ? {} : { script }),
    } } });
    assert.deepEqual(state.result().row, changes.rows.running);
    assert.equal(state.result().listCalls, 1);
  }
  const state = client(changes.rows.running);
  state.step({ event: { ...changes.events.complete, data: {
    ...changes.events.complete.data, action: 'future-action',
  } } });
  assert.deepEqual(state.result().row, changes.rows.running);
  assert.equal(state.result().listCalls, 1);
});

test('foreign-workspace events cannot overwrite local state', () => {
  const state = client(changes.rows.running);
  state.step({ event: { ...changes.events.removed, workspaceId: 'ws-b' } });
  assert.deepEqual(state.result().row, changes.rows.running);
  assert.equal(state.result().listCalls, 0);
});

test('snapshot fixtures detect shallow-merge clearing and unfenced-list regressions', () => {
  const merged = { ...changes.rows.old, ...changes.rows.replacement };
  assert.notDeepEqual(merged, changes.rows.replacement);
  assert.ok(merged.archivedAt && merged.lastRun && merged.cwd && merged.env);
  const runtimeMerged = { ...changes.rows.running.runtime, ...changes.events.starting.data };
  assert.ok(runtimeMerged.pid && runtimeMerged.startedAt);
  const state = client(changes.rows.running);
  state.step({ beginList: 'a' });
  state.step({ event: 'complete' });
  state.step({ resolveList: 'a', rows: ['running'] });
  assert.notDeepEqual(state.result().row, changes.rows.running);
  assert.deepEqual(state.result().row, changes.rows.complete);
});

test('stop fixtures distinguish a finished transition, marker dismissal and idle no-op', () => {
  const finished = changes.cases.find(c => c.id === 'finished-stop-preserves-archive-and-result');
  const lost = changes.cases.find(c => c.id === 'dismiss-lost-preserves-history');
  const service = changes.cases.find(c => c.id === 'dismiss-service-clears-marker');
  const noop = changes.cases.find(c => c.id === 'idle-stop-no-op');
  // A silent reset leaves the client exited: the stop event is essential.
  assert.notDeepEqual(client(changes.rows[finished.initial]).result().row.runtime,
    finished.expect.runtime);
  assert.deepEqual(finished.expect.runtime, { ...changes.rows.complete.runtime, status: 'idle' });
  // Lost dismissal clears terminal metadata; a runtime patch would retain it.
  assert.deepEqual(lost.expect.runtime, { status: 'idle', restartCount: 0 });
  assert.notDeepEqual({ ...changes.rows.interrupted.runtime, ...lost.expect.runtime },
    lost.expect.runtime);
  assert.equal(changes.rows[service.initial].runtime.previouslyRunning, true);
  assert.equal(service.expect.runtime.previouslyRunning, undefined);
  // No-op is an empty event stream, not an invented idle notification.
  assert.deepEqual(noop.steps, []);
  assert.equal(changes.rows[noop.initial].runtime.status, 'idle');
  assert.equal(changes.rows[noop.initial].runtime.previouslyRunning, undefined);
});


test('unknown additive fields are tolerated and explicit false/zero values survive', () => {
  const state = client(changes.rows.old);
  const script = { ...changes.rows.replacement, autoStart: false, env: {}, futureField: null };
  state.step({ event: { ...changes.events.replacement, data: {
    ...changes.events.replacement.data, script,
  } } });
  assert.deepEqual(state.result().row, script);
  assert.equal(state.result().listCalls, 0);
  assert.equal(state.result().row.autoStart, false);
  assert.equal(state.result().row.runtime.restartCount, 0);
});
