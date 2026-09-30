// Design prototype only: no production code, network, PTY, database or locks.
// A monotonically increasing epoch models definition/run/process-attempt fencing.
export function initial({ configured = true, workspaceId = 'ws-a', scriptId = 'svc' } = {}) {
  return { configured, workspaceId, scriptId, epoch: 0, status: 'idle',
    ...(configured ? { ready: false, readiness: { state: 'idle' } } : {}) };
}

export function token(s) {
  return JSON.stringify([s.workspaceId, s.scriptId, s.epoch]);
}

export function runtime(s) {
  return { status: s.status, ...(s.configured
    ? { ready: s.ready, readiness: structuredClone(s.readiness) } : {}) };
}

export function transition(previous, action) {
  const s = structuredClone(previous);
  const reset = (status, state) => {
    s.epoch += 1;
    s.status = status;
    if (s.configured) {
      s.ready = false;
      s.readiness = { state };
    }
  };
  switch (action.type) {
    case 'start':
      if (!['running', 'starting', 'restarting'].includes(s.status)) reset('starting', 'pending');
      break;
    case 'restart': reset('restarting', 'pending'); break;
    case 'spawn':
      if (['starting', 'restarting'].includes(s.status)) reset('running', 'pending');
      break;
    case 'stop': reset('idle', 'idle'); break;
    case 'exit': case 'spawn-failed': reset('exited', 'idle'); break;
    case 'hydrate': case 'replace': reset('idle', 'idle'); break;
    case 'remove': reset('removed', 'idle'); break;
    case 'detected-url': break; // Discovery is never readiness evidence.
    case 'check': {
      if (!s.configured || s.status !== 'running' || s.ready || action.token !== token(s)) break;
      s.readiness = { state: 'pending', checkedAt: action.at };
      if (action.httpStatus !== undefined) s.readiness.lastStatus = action.httpStatus;
      const passed = action.patternMatched === true ||
        (action.httpStatus >= 200 && action.httpStatus <= 299);
      if (passed) {
        s.ready = true;
        s.readiness.state = 'ready';
      } else {
        s.readiness.lastError = action.error ?? 'http-status';
      }
      break;
    }
    default: throw new Error(`Unknown prototype action: ${action.type}`);
  }
  // Lifecycle events still fire outside this model. This projection identifies
  // only readiness transitions; metadata-only failed polls do not emit events.
  const events = s.configured && previous.readiness.state !== s.readiness.state
    ? [runtime(s)] : [];
  return { state: s, events };
}
