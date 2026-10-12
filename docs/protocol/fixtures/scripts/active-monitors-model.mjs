// Prepared protocol-14 persistence oracle. This is not production SQL or an
// implementation of the process runner. Component tests must inject the same
// faults into the real store, queue and worker admission paths.
const invalid = () => { throw new Error('InvalidParams'); };
export class ActiveMonitors {
  constructor(snapshot) {
    this.store = structuredClone(snapshot ?? {
      active: {}, jobs: {}, queue: {}, messages: {}, admissions: {}, runs: {}, blocked: [], serial: 0,
    });
    this.events = [];
    this.failCommit = false;
  }
  transaction(fn) {
    const next = structuredClone(this.store);
    const result = fn(next);
    if (this.failCommit) { this.failCommit = false; throw new Error('store failure'); }
    this.store = next;
    return result;
  }
  restart() { return new ActiveMonitors(this.store); }
  eligible(row) { return !this.store.blocked.includes(row.agentId) && !this.store.blocked.includes(row.workspaceId); }
  get(workspaceId, id, owner) {
    const row = this.store.active[id];
    if (!row || row.workspaceId !== workspaceId || (owner && row.agentId !== owner)) invalid();
    return structuredClone(row);
  }
  list(workspaceId, owner) {
    return Object.values(this.store.active).filter(row => row.workspaceId === workspaceId && (!owner || row.agentId === owner)).map(structuredClone);
  }
  register({ workspaceId = 'ws', agentId = 'agent', scriptId = 'script', runId, ttlMs = 1000, now = 0, outputPattern } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) invalid();
    if (!this.eligible({ workspaceId, agentId })) invalid();
    const old = Object.values(this.store.active).find(row => row.workspaceId === workspaceId && row.scriptId === scriptId);
    if (old) return old.agentId === agentId ? { ok: true, monitor: structuredClone(old) } : { ok: false, refused: true, reason: 'already-monitored' };
    const run = this.store.runs[scriptId];
    if (!run || (runId && run.runId !== runId)) invalid();
    if (run.final) return { ok: false, refused: true, reason: 'run-finished', scriptId, runId: run.runId };
    const active = this.list(workspaceId);
    const jobs = Object.values(this.store.jobs).filter(row => row.workspaceId === workspaceId);
    if (active.filter(row => row.agentId === agentId).length >= 5 || active.length + jobs.length >= 1000)
      return { ok: false, refused: true, reason: 'capacity' };
    const row = this.transaction(s => {
      const monitorId = `m-${++s.serial}`;
      return s.active[monitorId] = { monitorId, workspaceId, agentId, scriptId, runId: run.runId, state: 'active', scriptName: scriptId, mode: 'command', createdAt: now, expiresAt: now + ttlMs, ...(outputPattern ? { outputPattern } : {}) };
    });
    this.events.push({ type: 'registered', monitor: structuredClone(row) });
    return { ok: true, monitor: structuredClone(row) };
  }
  retire(id, state, decision = {}) {
    const current = this.store.active[id];
    if (!current || (current.cancelIntent && ['triggered', 'expired'].includes(state))) return false;
    if (!['completed', 'expired', 'triggered', 'cancelled'].includes(state)) invalid();
    const terminal = { ...current, ...decision, state };
    delete terminal.cancelIntent;
    this.transaction(s => {
      delete s.active[id];
      if (state !== 'cancelled' && this.eligible(current)) {
        const wakeId = `script-monitor:${id}`;
        const { workspaceId, agentId, scriptId, runId, scriptName, mode, expiresAt } = current;
        s.jobs[wakeId] = { wakeId, workspaceId, agentId, scriptId, runId, createdAt: decision.settledAt,
          phase: 'pending', metadata: { scriptName, mode, expiresAt, ...decision } };
      }
    });
    this.events.push({ type: state, monitor: terminal });
    return true;
  }
  reserveCancel(id) { this.transaction(s => { if (!s.active[id]) invalid(); s.active[id].cancelIntent = true; }); }
  stopFailed(id) { this.transaction(s => { if (s.active[id]) delete s.active[id].cancelIntent; }); }
  enqueue(wakeId) {
    const job = this.store.jobs[wakeId];
    if (!job || !this.eligible(job)) return false;
    this.transaction(s => { s.queue[wakeId] ??= { ...job, turnId: wakeId, phase: 'queued' }; });
    return true;
  }
  persistMessage(wakeId) {
    const job = this.store.jobs[wakeId];
    if (!job || !this.eligible(job) || !this.store.queue[wakeId]) return false;
    this.transaction(s => {
      s.messages[wakeId] ??= { id: wakeId, metadata: job.metadata };
      s.jobs[wakeId].phase = 'message-persisted';
    });
    return true;
  }
  transfer(wakeId) {
    const job = this.store.jobs[wakeId];
    if (!job || !this.eligible(job) || !this.store.messages[wakeId] || !this.store.queue[wakeId]) return false;
    this.transaction(s => {
      s.admissions[wakeId] = { wakeId, workspaceId: job.workspaceId, agentId: job.agentId, turnId: wakeId, phase: 'pending' };
      delete s.jobs[wakeId];
    });
    return true;
  }
  admit(wakeId) {
    const receipt = this.store.admissions[wakeId];
    if (!receipt || !this.eligible(receipt)) return false;
    this.transaction(s => { s.admissions[wakeId].phase = 'accepted'; });
    return receipt.turnId;
  }
  finish(wakeId) { this.transaction(s => { delete s.admissions[wakeId]; delete s.queue[wakeId]; }); }
  suppress(scope) {
    this.transaction(s => {
      s.blocked.push(scope);
      for (const collection of ['active', 'jobs', 'queue', 'admissions'])
        for (const [id, row] of Object.entries(s[collection]))
          if (row.workspaceId === scope || row.agentId === scope) delete s[collection][id];
    });
  }
  restore(scope) { this.transaction(s => { s.blocked = s.blocked.filter(value => value !== scope); }); }
  migrate(legacy) {
    // Represents one upgrade transaction replacing the old monitor table and
    // admission/lifecycle triggers. No full terminal row enters the new store.
    this.transaction(s => {
      for (const { row, wakeState } of legacy) {
        const wakeId = `script-monitor:${row.monitorId}`;
        if (!this.eligible(row) || wakeState === 'suppressed') {
          delete s.active[row.monitorId]; delete s.jobs[wakeId]; delete s.queue[wakeId]; delete s.admissions[wakeId];
          continue;
        }
        if (row.state === 'active') { s.active[row.monitorId] = structuredClone(row); continue; }
        delete s.active[row.monitorId];
        if (s.admissions[wakeId]) continue;
        if (wakeState !== 'pending' && !s.queue[wakeId]) continue;
        const { workspaceId, agentId, scriptId, runId, scriptName, mode, expiresAt, settledAt, reason, result, trigger } = row;
        const metadata = Object.fromEntries(Object.entries({ scriptName, mode, expiresAt, settledAt, reason, result, trigger }).filter(([, value]) => value !== undefined));
        s.jobs[wakeId] ??= { wakeId, workspaceId, agentId, scriptId, runId, createdAt: settledAt, metadata, phase: s.messages[wakeId] ? 'message-persisted' : 'pending' };
      }
    });
  }
}

// Reference caller sequence for an explicit run-finished refusal. The output
// RPC has no run-specific atomic read, so absence/mismatch fails attribution.
export async function readFinishedOutput(refusal, { status, output }) {
  if (refusal.reason !== 'run-finished' || !refusal.runId) return { kind: 'unavailable' };
  try {
    if ((await status(refusal.scriptId)).runId !== refusal.runId) return { kind: 'unavailable' };
    const text = await output(refusal.scriptId);
    if ((await status(refusal.scriptId)).runId !== refusal.runId) return { kind: 'unavailable' };
    return { kind: 'available', output: text };
  } catch { return { kind: 'unavailable' }; }
}
