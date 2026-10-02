// Synthetic executable specification. No component/runtime behavior is tested here.
import { MonitorLines, MAX_COUNT, fixtureRegex } from './monitor-lines.mjs';
export const DAY = 86400000;
export const ACTIVE_LIMIT = 5;
export const RETAINED_LIMIT = 1000;
export const RETENTION = 7 * DAY;
export const iso = ms => new Date(Date.UTC(2026, 9, 2, 10) + ms).toISOString();
const key = (ws, id) => JSON.stringify([ws, id]);
const terminal = (outcome, now, extra = {}) => ({ outcome, stoppedAt: iso(now), ...extra });

export function model() {
  const s = { now: 0, runs: new Map(), monitors: [], pending: new Map(), delivered: new Map(), events: [], blocked: new Set(), archived: new Set(), stops: [], serial: 0 };
  const windows = new Map();
  const eligible = m => !s.blocked.has(m.agentId) && !s.archived.has(m.workspaceId);
  const active = (ws, id) => s.monitors.find(m => m.workspaceId === ws && m.scriptId === id && m.state === 'active');
  const wake = m => {
    const { monitorId, workspaceId, agentId, scriptId, runId, scriptName, mode, reason, expiresAt, settledAt, result, trigger } = m;
    return { type: 'script_monitor_wake', source: 'system', monitorId, workspaceId, agentId, scriptId, runId, scriptName, mode, reason, expiresAt, settledAt, ...(result ? { result } : {}), ...(trigger ? { trigger } : {}) };
  };
  const settle = (m, state, reason, result, trigger) => {
    if (!m || m.state !== 'active') return;
    Object.assign(m, { state, reason, settledAt: iso(s.now) }, result ? { result: structuredClone(result) } : {}, trigger ? { trigger } : {});
    s.events.push({ type: `scriptMonitor:${state}`, data: { monitor: structuredClone(m) } });
    if (state !== 'cancelled' && eligible(m)) s.pending.set(m.monitorId, wake(m));
  };
  const complete = (r, result) => {
    if (r.result) return;
    const monitor = active(r.workspaceId, r.scriptId);
    if (monitor?.runId === r.runId) {
      if (Date.parse(monitor.expiresAt) <= Date.parse(iso(s.now))) settle(monitor, 'expired', 'ttl-expired');
      else settle(monitor, 'completed', 'finished', result);
    }
    r.result = result;
  };
  const onLine = r => line => {
    const m = active(r.workspaceId, r.scriptId);
    if (!m || m.runId !== r.runId || !eligible(m) || !(m.outputPattern !== undefined || m.lineCount !== undefined)) return;
    if (Date.parse(m.expiresAt) <= Date.parse(iso(s.now))) { settle(m, 'expired', 'ttl-expired'); return; }
    const window = windows.get(m.monitorId);
    if (line.start < window.baseline) return;
    window.count = Math.min(window.count + 1, 2147483647);
    if (!line.overlong && m.outputPattern !== undefined && fixtureRegex(m.outputPattern).test(line.text)) settle(m, 'triggered', 'output-match', undefined, { observedLineCount: window.count, matchedLine: line.text });
    else if (m.lineCount !== undefined && window.count >= m.lineCount) settle(m, 'triggered', 'line-count', undefined, { observedLineCount: window.count });
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
        s.runs.set(key(ws, id), { workspaceId: ws, scriptId: id, runId: a.runId, mode: a.mode ?? 'command', attempt: 0, lines: new MonitorLines() });
        return { runId: a.runId };
      case 'respawn': {
        r.lines.eof(onLine(r));
        r.lines = new MonitorLines();
        r.attempt++;
        const monitor = active(ws, id);
        if (monitor) windows.get(monitor.monitorId).baseline = 0;
        return { runId: r.runId };
      }
      case 'output':
        if (r?.runId === a.runId && (a.attempt === undefined || a.attempt === r.attempt) && !r.result && !a.synthetic) r.lines.push(a.bytes ?? a.text, onLine(r));
        return;
      case 'gap': r.lines.gap(); return;
      case 'finish':
        if (r?.runId === a.runId) { r.lines?.eof(onLine(r)); complete(r, a.result); }
        return;
      case 'register': {
        if (!Number.isInteger(a.ttlMs) || a.ttlMs < 1 || a.ttlMs > DAY || (a.runId !== undefined && (typeof a.runId !== 'string' || !a.runId))) return error('invalid options');
        if (a.lineCount !== undefined && (!Number.isInteger(a.lineCount) || a.lineCount < 1 || a.lineCount > MAX_COUNT)) return error('invalid lineCount');
        try { if (a.outputPattern !== undefined) fixtureRegex(a.outputPattern); } catch { return error('invalid outputPattern'); }
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
        const row = { monitorId: `monitor-${++s.serial}`, workspaceId: ws, agentId: owner, scriptId: id, runId, scriptName: id, mode: r.mode, state: 'active', createdAt: iso(s.now), expiresAt: iso(s.now + a.ttlMs), ...(a.outputPattern !== undefined ? { outputPattern: a.outputPattern } : {}), ...(a.lineCount !== undefined ? { lineCount: a.lineCount } : {}) };
        windows.set(row.monitorId, { baseline: r.lines?.position ?? 0, count: 0 });
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
          const bound = s.runs.get(key(ws, m.scriptId));
          if (bound?.runId === m.runId && bound.result) settle(m, 'completed', 'finished', bound.result);
          else if (Date.parse(m.expiresAt) <= Date.parse(iso(s.now))) settle(m, 'expired', 'ttl-expired');
          else if (a.op === 'cancel') settle(m, 'cancelled', 'unmonitored');
          else {
            if (bound?.runId === m.runId) {
              s.stops.push(m.runId); runStopped = true;
              complete(bound, terminal('cancelled', s.now, { error: 'cancelled by user' }));
            } else settle(m, 'completed', 'finished', terminal('interrupted', s.now, { exitCode: -1, error: 'bound run unavailable' }));
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
