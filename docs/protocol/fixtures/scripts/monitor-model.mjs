// Synthetic executable specification. No component/runtime behavior is tested here.
export const DAY = 86400000;
export const ACTIVE_LIMIT = 5;
export const RETAINED_LIMIT = 1000;
export const RETENTION = 7 * DAY;
export const iso = ms => new Date(Date.UTC(2026, 9, 2, 10) + ms).toISOString();
const key = (ws, id) => JSON.stringify([ws, id]);
const terminal = (outcome, now, extra = {}) => ({ outcome, stoppedAt: iso(now), ...extra });

export function model() {
  const s = { now: 0, runs: new Map(), monitors: [], pending: new Map(), delivered: new Map(), events: [], blocked: new Set(), archived: new Set(), stops: [], serial: 0 };
  const eligible = m => !s.blocked.has(m.agentId) && !s.archived.has(m.workspaceId);
  const active = (ws, id) => s.monitors.find(m => m.workspaceId === ws && m.scriptId === id && m.state === 'active');
  const wake = m => {
    const { monitorId, workspaceId, agentId, scriptId, runId, scriptName, mode, reason, expiresAt, settledAt, result } = m;
    return { type: 'script_monitor_wake', source: 'system', monitorId, workspaceId, agentId, scriptId, runId, scriptName, mode, reason, expiresAt, settledAt, ...(result ? { result } : {}) };
  };
  const settle = (m, state, reason, result) => {
    if (!m || m.state !== 'active') return;
    Object.assign(m, { state, reason, settledAt: iso(s.now) }, result ? { result: structuredClone(result) } : {});
    s.events.push({ type: `scriptMonitor:${state}`, data: { monitor: structuredClone(m) } });
    if (state !== 'cancelled' && eligible(m)) s.pending.set(m.monitorId, wake(m));
  };
  const complete = (r, result) => {
    if (r.result) return;
    r.result = result;
    const monitor = active(r.workspaceId, r.scriptId);
    if (monitor?.runId === r.runId) settle(monitor, 'completed', 'finished', result);
  };
  const prune = capacity => {
    const removable = () => s.monitors.filter(m => m.state !== 'active' && !s.pending.has(m.monitorId)).sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.monitorId.localeCompare(b.monitorId));
    for (const m of removable()) {
      if (Date.parse(iso(s.now)) - Date.parse(m.settledAt) >= RETENTION || (capacity && s.monitors.filter(x => x.workspaceId === capacity).length >= RETAINED_LIMIT && m.workspaceId === capacity)) {
        s.monitors.splice(s.monitors.indexOf(m), 1);
      }
    }
  };
  const error = detail => ({ errorCode: -32602, detail });
  function step(a) {
    const ws = a.workspaceId ?? 'ws-a', id = a.scriptId ?? 'check', owner = a.agentId ?? 'agent-a';
    const r = s.runs.get(key(ws, id));
    const m = s.monitors.find(x => x.monitorId === (a.monitorId ?? 'monitor-1') && x.workspaceId === ws);
    switch (a.op) {
      case 'time': s.now = a.now; return;
      case 'start':
      case 'restart':
        if (r && !r.result && a.op === 'start') return { runId: r.runId };
        if (r && !r.result) complete(r, terminal('cancelled', s.now, { error: 'manual restart' }));
        s.runs.set(key(ws, id), { workspaceId: ws, scriptId: id, runId: a.runId, mode: a.mode ?? 'command' });
        return { runId: a.runId };
      case 'respawn': return { runId: r.runId };
      case 'finish':
        if (r?.runId === a.runId) complete(r, a.result);
        return;
      case 'register': {
        if (!Number.isInteger(a.ttlMs) || a.ttlMs < 1 || a.ttlMs > DAY || (a.runId !== undefined && (typeof a.runId !== 'string' || !a.runId))) return error('invalid options');
        if (s.blocked.has(owner) || s.archived.has(ws)) return error('inactive lifecycle');
        const held = active(ws, id);
        if (held) {
          if (held.agentId !== owner) return { ok: false, refused: true, reason: 'already-monitored', ownerAgentId: held.agentId, monitorId: held.monitorId, workspaceId: ws, scriptId: id, runId: held.runId, instruction: 'Ask the owner to stop monitoring.' };
          if (a.runId !== undefined && a.runId !== held.runId) return error('different run');
          return { ok: true, monitor: structuredClone(held) };
        }
        const runId = a.runId ?? r?.runId;
        const previous = s.monitors.find(x => x.workspaceId === ws && x.scriptId === id && x.agentId === owner && x.runId === runId && x.state === 'completed');
        if (previous) return { ok: true, monitor: structuredClone(previous) };
        if (!r || r.runId !== runId) return error('unavailable run');
        prune(ws);
        if (s.monitors.filter(x => x.state === 'active' && x.agentId === owner).length >= ACTIVE_LIMIT || s.monitors.filter(x => x.workspaceId === ws).length >= RETAINED_LIMIT) return error('monitor limit');
        const row = { monitorId: `monitor-${++s.serial}`, workspaceId: ws, agentId: owner, scriptId: id, runId, scriptName: id, mode: r.mode, state: 'active', createdAt: iso(s.now), expiresAt: iso(s.now + a.ttlMs) };
        s.monitors.push(row);
        s.events.push({ type: 'scriptMonitor:registered', data: { monitor: structuredClone(row) } });
        if (r.result) settle(row, 'completed', 'finished', r.result);
        return { ok: true, monitor: structuredClone(row) };
      }
      case 'expire':
        if (m?.state === 'active' && Date.parse(m.expiresAt) <= Date.parse(iso(s.now))) {
          const bound = s.runs.get(key(m.workspaceId, m.scriptId));
          if (bound?.runId === m.runId && bound.result) settle(m, 'completed', 'finished', bound.result);
          else settle(m, 'expired', 'ttl-expired');
        }
        return;
      case 'cancel':
      case 'cancelRun': {
        if (!m) return error('unknown monitor');
        if (a.asAgent && m.agentId !== owner) return error(`owned by ${m.agentId}`);
        let runStopped = false;
        if (m.state === 'active') {
          if (a.op === 'cancel') settle(m, 'cancelled', 'unmonitored');
          else {
            const bound = s.runs.get(key(ws, m.scriptId));
            if (bound?.runId === m.runId && !bound.result) {
              s.stops.push(m.runId); runStopped = true;
              complete(bound, terminal('cancelled', s.now, { error: 'cancelled by user' }));
            } else settle(m, 'completed', 'finished', bound?.runId === m.runId && bound.result || terminal('interrupted', s.now, { exitCode: -1, error: 'bound run unavailable' }));
          }
        }
        return { ok: true, monitor: structuredClone(m), ...(a.op === 'cancelRun' ? { runStopped } : {}) };
      }
      case 'cleanup': {
        const workspace = a.reason.startsWith('workspace-');
        if (workspace) s.archived.add(ws); else s.blocked.add(owner);
        for (const row of s.monitors) {
          if (workspace ? row.workspaceId === ws : row.agentId === owner) {
            settle(row, 'cancelled', a.reason);
            s.pending.delete(row.monitorId);
          }
        }
        return;
      }
      case 'restore': s.archived.delete(ws); s.blocked.delete(owner); return;
      case 'recover':
        for (const [id, payload] of s.pending) if (!eligible(payload)) s.pending.delete(id);
        for (const row of s.monitors.filter(x => x.state === 'active')) {
          if (!eligible(row)) { settle(row, 'cancelled', s.archived.has(row.workspaceId) ? 'workspace-archived' : 'owner-retired'); continue; }
          const bound = s.runs.get(key(row.workspaceId, row.scriptId));
          if (bound?.runId === row.runId && bound.result) settle(row, 'completed', 'finished', bound.result);
          else if (Date.parse(row.expiresAt) <= Date.parse(iso(s.now))) settle(row, 'expired', 'ttl-expired');
          else settle(row, 'completed', 'finished', terminal('interrupted', s.now, { exitCode: -1, error: 'daemon stopped' }));
        }
        return;
      case 'deliver':
        for (const [id, payload] of s.pending) {
          if (!s.blocked.has(payload.agentId) && !s.archived.has(payload.workspaceId)) s.delivered.set(id, payload);
          s.pending.delete(id);
        }
        return;
      case 'prune': prune(); return;
      default: throw new Error(`unknown harness action: ${a.op}`);
    }
  }
  return { s, step, waiting: () => s.monitors.filter(m => m.state === 'active').map(({ monitorId, scriptId, runId, scriptName, expiresAt }) => ({ monitorId, scriptId, runId, scriptName, expiresAt })) };
}
