// Static prepared-contract checks only. Component tests must execute these
// cases against real code; this suite makes no runtime/native support claim.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const [fixture, doc, catalog, events, eventDoc, routing] = await Promise.all([
  read('./lifecycle.json').then(JSON.parse),
  read('../../methods/desktop.md'),
  read('../../05-method-catalog.md'),
  read('../../event-types.json').then(JSON.parse),
  read('../../06-events.md'),
  read('../../workspace-routing.md'),
]);
const byId = id => {
  const entry = [...fixture.cases, ...fixture.races].find(c => c.id === id);
  assert.ok(entry, `missing required acceptance scenario: ${id}`);
  return entry;
};
const expected = id => byId(id).expect;

function validateState(state) {
  if (state.status === 'active') {
    assert.equal(typeof state.sessionId, 'string');
    assert.equal(typeof state.computerName, 'string');
    assert.equal(state.hint, fixture.releaseHint);
  } else {
    assert.ok(['inactive', 'pending_permission'].includes(state.status));
    assert.equal(Object.hasOwn(state, 'hint'), false);
    assert.equal(Object.hasOwn(state, 'sessionId'), false);
    if (state.status === 'pending_permission') assert.equal(typeof state.requestId, 'string');
  }
}

test('prepared additions have catalog, routing and event documentation without claiming runtime support', () => {
  assert.equal(fixture.status, 'prepared-not-executed');
  assert.deepEqual(fixture.platforms, ['macos', 'windows']);
  assert.deepEqual(fixture.capability, { desktopControl: 1 });
  assert.match(doc, /prepared additive contract/);
  for (const method of fixture.routerMethods) {
    assert.ok(doc.includes(`| ${method} |`), method);
    assert.ok(routing.includes(`\`${method}\``), method);
  }
  assert.match(catalog, /\| desktop \| 4 \| getState, respondPermission, revoke, setPermission —/);
  assert.deepEqual(fixture.reverseMethods, ['desktop.control']);
  assert.match(catalog, /- `desktop.control` —/);
  for (const type of fixture.eventTypes) {
    assert.ok(events.types.includes(type), type);
    assert.ok(doc.includes(type), type);
    assert.ok(eventDoc.includes(type), type);
  }
  const ids = [...fixture.cases, ...fixture.races].map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('start examples distinguish pending, fresh activation and already-granted activation', () => {
  const pending = expected('start-unremembered');
  const repeated = expected('start-pending-again');
  assert.equal(pending.result.status, 'pending_permission');
  assert.deepEqual(pending.result, repeated.result);
  assert.equal(pending.promptCount, 1);
  assert.equal(repeated.promptCount, 0);
  assert.equal(repeated.executionAllowed, false);
  assert.equal(Object.hasOwn(repeated.result, 'alreadyGranted'), false);
  for (const [id, alreadyGranted] of [['start-remembered', false], ['start-active-again', true]]) {
    const c = expected(id);
    validateState(c.result);
    assert.equal(c.localReady, true);
    assert.equal(c.result.alreadyGranted, alreadyGranted);
    assert.equal(c.startToastCount, alreadyGranted ? 0 : 1);
  }
  assert.equal(expected('start-active-again').result.message, 'Control is already granted');
  assert.ok(doc.includes(fixture.releaseHint));
});

test('end results separate teardown, no-op, withdrawal and errors', () => {
  assert.deepEqual(expected('end-active').result, { ended: true, withdrawn: false });
  assert.equal(expected('end-active').localTeardownConfirmed, true);
  assert.deepEqual(expected('end-inactive').result, { ended: false, withdrawn: false });
  assert.deepEqual(expected('withdraw-pending').result, { ended: false, withdrawn: true });
  assert.equal(Object.hasOwn(expected('end-failed'), 'result'), false);
  assert.equal(expected('end-failed').error.data.code, 'desktop-execution-failed');
  assert.equal(expected('stale-approval-after-withdrawal').error.data.code, 'desktop-stale-request');
  assert.equal(expected('stale-approval-after-withdrawal').remembered, false);
});

test('error examples reject forged ownership, fallback routing and false action success', () => {
  assert.equal(expected('forged-agent-id').error.data.code, 'invalid-params');
  assert.equal(expected('foreign-primary-approval').error.code, -32003);
  for (const id of ['primary-offline', 'primary-incapable', 'desktop-owned-by-other-backend', 'native-not-ready']) {
    assert.equal(expected(id).fallbackClientSelected, false);
    assert.equal(Object.hasOwn(expected(id), 'result'), false);
  }
  for (const c of fixture.cases.filter(c => c.expect.error)) {
    assert.equal(Object.hasOwn(c.expect, 'result'), false, c.id);
    assert.ok(doc.includes(`\`${c.expect.error.data.code}\``) || ['forbidden', 'invalid-params'].includes(c.expect.error.data.code), c.id);
    if (c.call.binding && !c.call.binding.endsWith('Control')) {
      assert.ok(['not_started', 'partial', 'unknown'].includes(c.expect.error.data.execution), c.id);
    }
  }
  assert.equal(expected('input-transport-timeout').retry, false);
  assert.equal(expected('partial-drag').heldInputReleased, true);
});

test('race fixtures retain early grants, invalidate late grants and respect local Stop', () => {
  const grant = byId('grant-before-turn-end');
  assert.ok(grant.steps.indexOf('local-ready') < grant.steps.indexOf('queue-grant'));
  assert.ok(grant.steps.indexOf('queue-grant') < grant.steps.indexOf('end-turn'));
  assert.ok(grant.steps.indexOf('end-turn') < grant.steps.indexOf('deliver-grant'));
  assert.equal(grant.expect.wakeCount, 1);
  assert.equal(grant.expect.concurrentTurns, false);
  assert.equal(expected('stop-before-grant-delivery').activeGrantDelivered, false);
  assert.equal(expected('withdraw-before-ready').activationAccepted, false);
  assert.equal(expected('primary-change').activationAccepted, false);
  assert.equal(expected('stop-offline').remembered, true);
  assert.equal(expected('stop-offline').overlayVisible, false);
  for (const id of ['stop-offline', 'lease-expiry']) {
    assert.equal(expected(id).queuedInputExecuted, false);
    assert.equal(expected(id).automaticRestart, false);
  }
  assert.equal(expected('ordinary-turn-boundary').state.status, 'active');
  assert.equal(expected('agent-termination').state.status, 'inactive');
  assert.equal(expected('permission-off-while-active').state.status, 'active');
  assert.equal(expected('permission-off-while-active').remembered, false);
});

test('active snapshot hints cannot survive revocation in any example', () => {
  for (const c of [...fixture.cases, ...fixture.races]) {
    for (const state of [c.expect.after, c.expect.state].filter(Boolean)) validateState(state);
  }
  assert.throws(() => validateState({ status: 'inactive', hint: fixture.releaseHint }));
  assert.throws(() => validateState({ status: 'active', sessionId: 'a', computerName: 'Studio' }));
});

test('capture and click fixtures exercise mixed DPI, negative origins, right click and successful-only pulse', () => {
  const capture = expected('mixed-dpi-screenshot');
  assert.equal(capture.overlayExcluded, true);
  assert.equal(capture.pulseCount, 1);
  assert.equal(expected('screenshot-save-failure').pulseCount, 0);
  const { displays, layoutId } = capture.result;
  assert.equal(new Set(displays.map(d => d.displayId)).size, displays.length);
  assert.ok(displays.some(d => d.originX < 0));
  assert.ok(new Set(displays.map(d => d.scaleFactor)).size > 1);
  for (const d of displays) {
    assert.ok(Number.isInteger(d.width) && d.width > 0);
    assert.ok(Number.isInteger(d.height) && d.height > 0);
    assert.ok(Number.isFinite(d.scaleFactor) && d.scaleFactor > 0);
    assert.equal(d.mimeType, 'image/png');
    assert.equal(d.url, `workspace-asset://ws-a/${d.assetId}`);
  }
  const click = byId('right-double-click').call.args;
  const display = displays.find(d => d.displayId === click.displayId);
  assert.ok(display);
  assert.equal(click.layoutId, layoutId);
  assert.ok(click.x >= 0 && click.x < display.width && click.y >= 0 && click.y < display.height);
  assert.equal(click.button, 'right');
  assert.equal(click.clickCount, 2);
});

test('deadline wire contract supplies a local ticket instead of requiring an undefined clock calibration', () => {
  assert.match(doc, /\| `prepareCommand` \|/);
  assert.match(doc, /\| `execute` \| `computerId, sessionId, commandId, sequence, deadlineId`/);
  assert.match(doc, /expiresInMs: 10000/);
  assert.doesNotMatch(doc, /desktop-clock-uncertain/);
});

test('prepared deadline wire exchange correlates a single retained action and ticket', () => {
  const { prepare, prepared, execute } = fixture.deadlines.wire;
  assert.equal(prepare.method, 'desktop.control');
  assert.equal(execute.method, 'desktop.control');
  assert.equal(prepare.params.operation, 'prepareCommand');
  assert.equal(execute.params.operation, 'execute');
  assert.equal(prepared.id, prepare.id);
  assert.equal(prepared.result.expiresInMs, 10000);
  assert.equal(execute.params.deadlineId, prepared.result.deadlineId);
  for (const key of ['workspaceId', 'agentId', 'principalId', 'connectionEpoch', 'computerId', 'sessionId', 'commandId', 'sequence']) {
    assert.deepEqual(prepare.params[key], execute.params[key], key);
  }
  for (const key of ['commandId', 'sequence']) assert.equal(prepared.result[key], execute.params[key]);
  assert.ok(prepare.params.action);
  assert.equal(Object.hasOwn(execute.params, 'action'), false);
  assert.equal(Object.hasOwn(execute.params, 'expiresAt'), false);
});

// Arithmetic oracle for prepared examples, not a native executor implementation.
function deadlineOutcome(c) {
  if (c.clockSafe === false || c.executeMonoMs < c.preparedMonoMs) {
    return ['desktop-deadline-unavailable', 'not_started'];
  }
  if (!c.knownTicket || c.consumed || c.bindingMatches === false) {
    return ['desktop-stale-command', 'not_started'];
  }
  if (c.executeMonoMs - c.preparedMonoMs >= 10000) {
    return ['desktop-command-expired', c.stepsCompleted > 0 ? 'partial' : 'not_started'];
  }
  return ['execute', undefined];
}

test('deadline examples cover skew, latency, exact expiry, missing tickets and invalid clocks', () => {
  const cases = fixture.deadlines.cases;
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) assert.deepEqual(deadlineOutcome(c), [c.expect, c.execution], c.id);
  const select = id => {
    const c = cases.find(c => c.id === id);
    assert.ok(c, id);
    return c;
  };
  assert.equal(select('opposite-clock-skew').expect, 'execute');
  assert.equal(select('wall-clock-jump').expect, 'execute');
  const latency = select('response-and-transit-latency');
  assert.equal(latency.executeMonoMs - latency.preparedMonoMs, latency.responseLatencyMs + latency.executeTransitMs);
  assert.deepEqual(deadlineOutcome({ ...latency, executeMonoMs: latency.executeMonoMs + 1 }), ['desktop-command-expired', 'not_started']);
  assert.equal(select('exact-expiry').expect, 'desktop-command-expired');
  assert.equal(select('expiry-between-drag-steps').execution, 'partial');
  assert.equal(select('unprepared-ticket').expect, 'desktop-stale-command');
  assert.equal(select('consumed-ticket-replay').expect, 'desktop-stale-command');
  assert.equal(select('connection-replaced').expect, 'desktop-stale-command');
  assert.equal(select('monotonic-regression').expect, 'desktop-deadline-unavailable');
  assert.equal(select('resume-without-safe-clock').expect, 'desktop-deadline-unavailable');
  // Changing a peer's UTC clock must never extend the native deadline.
  assert.deepEqual(deadlineOutcome({ ...select('queued-too-long'), daemonWallMs: 0, executorWallMs: 0 }), ['desktop-command-expired', 'not_started']);
});

test('offline Stop records an authenticated terminal report and the required rescission wake', () => {
  assert.match(doc, /### Offline Stop reconciliation/);
  const stopped = expected('stop-offline');
  assert.equal(stopped.reconciliationAuthenticated, true);
  assert.equal(stopped.wake.message, 'Desktop control permission was rescinded by the user. Respect the interruption; do not automatically restart or retry desktop control.');
  assert.equal(stopped.wake.outcome, 'revoked');
  assert.deepEqual(stopped.wake.state, { status: 'inactive' });
  assert.equal(stopped.automaticRestart, false);
});

test('terminal Stop wire examples preserve the old authenticated tuple on a new connection', () => {
  const { retained, request, cases } = fixture.stopReports;
  assert.equal(request.method, 'desktop.revoke');
  assert.equal(request.params.reason, 'user_stop');
  assert.equal(request.params.workspaceId, retained.workspaceId);
  assert.equal(request.params.sessionId, retained.sessionId);
  for (const key of ['computerId', 'connectionEpoch', 'stopReportToken']) {
    assert.equal(request.params.stopReport[key], retained[key]);
  }
  assert.equal(Buffer.from(retained.stopReportToken, 'base64url').length, 32);
  assert.match(doc, /leaseMs: 15000, stopReportToken/);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    assert.notEqual(c.transportEpoch, retained.connectionEpoch, c.id);
    assert.equal(c.expect.resurrected, false, c.id);
    const authorized = c.principalId === retained.principalId && c.tokenMatches !== false;
    if (!authorized) {
      assert.equal(c.expect.error.code, -32003, c.id);
      assert.equal(Object.hasOwn(c.expect, 'result'), false, c.id);
      assert.equal(c.expect.newWakeCount, 0, c.id);
      continue;
    }
    assert.equal(c.expect.result.revoked, false, c.id);
    assert.equal(c.expect.result.reported, !c.alreadyReported, c.id);
    assert.equal(c.expect.remembered, true, c.id);
    assert.equal(c.expect.newWakeCount, c.alreadyReported || c.agentCompleted ? 0 : 1, c.id);
    const notification = c.expect.wake ?? c.expect.conversationNotification;
    if (notification) {
      assert.ok(notification.message.startsWith(fixture.stopReports.rescissionMessage), c.id);
      assert.equal(notification.sessionId, retained.sessionId, c.id);
      assert.equal(notification.outcome, 'revoked', c.id);
      assert.deepEqual(notification.state, { status: 'inactive' }, c.id);
      assert.equal(JSON.stringify(notification).includes(retained.stopReportToken), false, c.id);
    }
    validateState(c.expect.currentState);
    assert.equal(c.expect.currentState.status, c.successor ? 'active' : 'inactive', c.id);
    if (c.successor) {
      assert.equal(c.expect.currentState.sessionId, c.successor);
      assert.ok(notification.message.includes(`newer explicit session ${c.successor} is unchanged`));
    }
  }
  const byReportId = id => {
    const c = cases.find(c => c.id === id);
    assert.ok(c, id);
    return c;
  };
  assert.equal(byReportId('reconnect-after-disconnected').expect.replacesUndelivered, true);
  assert.equal(byReportId('reconnect-after-lease-expired-delivered').expect.replacesUndelivered, false);
  assert.equal(byReportId('retry-after-lost-ack').expect.newWakeCount, 0);
  assert.equal(byReportId('duplicate-with-different-report-id').expect.newWakeCount, 0);
  assert.equal(byReportId('restart-keeps-report-only').expect.currentState.status, 'inactive');
  assert.ok(byReportId('terminal-agent-not-restarted').expect.conversationNotification);
});

test('ambiguous not-found retains terminal Stop reports until authenticated acknowledgement or explicit local discard', () => {
  assert.ok(doc.includes('An ambiguous `not-found` response never authorizes local deletion'));
  assert.ok(!doc.includes('discards the orphaned report'));
});

test('retention examples cannot distinguish hidden from deleted targets or lose reports during access loss', () => {
  const { ambiguousResponse, cases } = fixture.stopReportRetention;
  assert.equal(ambiguousResponse.error.code, -32602);
  assert.equal(ambiguousResponse.error.data.code, 'not-found');
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    let queued = true;
    for (const step of c.steps) {
      const acknowledged = ['ack-first', 'ack-duplicate'].includes(step.response);
      const explicitDiscard = step.localAction === 'discard-undelivered-notification' && step.userInitiated === true;
      if (acknowledged || explicitDiscard) queued = false;
      assert.equal(step.expectQueued, queued, `${c.id}: ${step.response ?? step.localAction}`);
      assert.equal(step.expectWakeCount, step.response === 'ack-first' ? 1 : 0, c.id);
      if (step.response === 'not-found') {
        assert.equal(step.expectQueued, true, c.id);
        assert.equal(Object.hasOwn(step, 'deletionAcknowledged'), false, c.id);
      }
    }
    assert.equal(c.expectReportId, c.initialReportId, c.id);
    assert.equal(c.expectSessionResurrected, false, c.id);
  }
  const select = id => {
    const c = cases.find(c => c.id === id);
    assert.ok(c, id);
    return c;
  };
  const restored = select('access-lost-then-restored');
  assert.equal(restored.steps.at(-1).accessRestored, true);
  assert.equal(restored.steps.at(-1).expectWakeCount, 1);
  assert.equal(restored.expectRemembered, true);
  assert.deepEqual(restored.steps[0], select('deleted-target-stays-ambiguous').steps[0]);
  const cleanup = select('deleted-target-explicit-local-cleanup');
  assert.equal(cleanup.expectDeliveryAcknowledged, false);
  assert.equal(cleanup.expectSuccessorUnchanged, true);
  assert.equal(select('lost-ack-then-duplicate-ack').expectDeliveryAcknowledged, true);
  assert.equal(select('auth-failure-and-signout-retain').steps.at(-1).expectQueued, true);
});

test('desktop ownership uses the persisted workspace owner rather than a manager or message sender', () => {
  assert.ok(doc.includes('workspace.owner_principal_id'));
  assert.ok(doc.includes('require_agent_owner'));
  assert.ok(doc.includes('Owner changes invalidate pending requests and active sessions'));
});

test('ownership boundary examples reject every identity fallback and invalidate old authority', () => {
  const { source, cases } = fixture.desktopOwners;
  assert.equal(source, 'workspace.owner_principal_id');
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  for (const c of cases) {
    const allowed = Boolean(c.workspaceOwner) && c.workspaceOwner === c.connectionPrincipal;
    assert.equal(c.expect.allowed, allowed, c.id);
    assert.equal(c.expect.fallbackSelected, false, c.id);
    if (allowed) assert.equal(c.expect.boundPrincipal, c.workspaceOwner, c.id);
    else assert.equal(c.expect.errorCode, 'forbidden', c.id);
    if (c.originalOwner) {
      assert.notEqual(c.workspaceOwner, c.originalOwner, c.id);
      assert.equal(c.expect.reason, 'owner_changed', c.id);
      assert.equal(c.expect.grantTransferred, false, c.id);
      if (c.stage === 'decision') assert.equal(c.expect.requestInvalidated, true, c.id);
      else {
        assert.deepEqual(c.expect.state, { status: 'inactive' }, c.id);
        validateState(c.expect.state);
      }
    }
    if (c.rememberedGrantPrincipal) {
      assert.notEqual(c.workspaceOwner, c.rememberedGrantPrincipal);
      assert.equal(c.expect.rememberedConsentApplies, false);
      assert.equal(c.expect.status, 'pending_permission');
    }
  }
  for (const id of ['workspace-owner-primary', 'delegate-uses-own-workspace-owner', 'manager-is-not-owner', 'administrator-is-not-owner', 'message-sender-is-not-owner', 'missing-persisted-owner', 'owner-changed-before-decision', 'owner-changed-before-renew', 'owner-changed-before-action', 'new-owner-needs-own-consent']) {
    assert.ok(cases.some(c => c.id === id), id);
  }
});
