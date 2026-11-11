#!/usr/bin/env node
// Synthetic executable specification. No provider, daemon, transport or process I/O.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const MAX_ROWS = 256;
export const MAX_SEEN = 1024;
const SCOPE_KEYS = ['workspaceId', 'agentId', 'provider', 'acpSessionId', 'connectionGeneration'];
// Adapter pins (synthetic values: the daemon takes each version from its adapter pin and
// moves it with every pin bump). Any other provider, or any other version, is unsupported.
export const SUPPORTED_ADAPTERS = Object.freeze({
  codex: Object.freeze({ adapterVersion: '2.2.2', source: 'codex-air' }),
  'claude-code': Object.freeze({ adapterVersion: '0.81.1', source: 'claude-air' }),
});
export const STOP_METHOD = '_session/async_task/stop';
const SUBAGENT_TASK_TYPES = new Set(['agent', 'local_agent']);
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const clone = structuredClone;
const validId = (v) => typeof v === 'string' && Buffer.byteLength(v) > 0 && Buffer.byteLength(v) <= 256 && !/[\u0000-\u001f\u007f]/u.test(v);
const time = (v) => Number.isSafeInteger(v) && v >= 0;
function bounded(value, maxBytes) {
  if (typeof value !== 'string') return undefined;
  let result = '';
  for (const c of value.replace(/[\u0000-\u001f\u007f]/gu, ' ')) {
    if (Buffer.byteLength(result + c) > maxBytes) break;
    result += c;
  }
  return result;
}
const boundedTitle = (value) => bounded(value, 512);
// Provider profiles (`claude-code@work`) share their base provider's adapter and rules.
export const baseProvider = (provider) => provider.split('@')[0];
// Sanitize first, then judge the sanitized value. Codex reports only shell workers;
// Claude also reports workflows and monitors. Subagents are never workers.
function acceptedTaskType(provider, taskType) {
  const type = bounded(taskType, 64)?.trim();
  if (!type || SUBAGENT_TASK_TYPES.has(type)) return undefined;
  if (baseProvider(provider) === 'codex' && type !== 'shell') return undefined;
  return type;
}
// Running means "the provider announced it and has not reported an end". There is no
// upstream heartbeat, so evidence age never demotes a row; only lost continuity does.
function project(row, continuity) {
  const out = clone(row);
  if (row.providerState === 'running') {
    out.status = continuity === 'continuous' ? 'running' : 'unknown';
    if (continuity !== 'continuous') out.unknownReason = continuity;
    else delete out.unknownReason;
  } else out.status = row.providerState;
  return out;
}

export class WorkerProjection {
  constructor(scope, { adapterVersion, negotiated, maxRows = MAX_ROWS, maxSeen = MAX_SEEN } = {}) {
    const noSession = scope.acpSessionId === null && scope.connectionGeneration === null;
    assert.ok(SCOPE_KEYS.every((k) => noSession && ['acpSessionId', 'connectionGeneration'].includes(k) || validId(scope[k])), 'invalid scope');
    assert.ok(Number.isInteger(maxRows) && maxRows > 0 && maxRows <= MAX_ROWS);
    assert.ok(Number.isInteger(maxSeen) && maxSeen >= maxRows && maxSeen <= MAX_SEEN);
    this.scope = Object.fromEntries(SCOPE_KEYS.map((k) => [k, scope[k]]));
    this.options = { adapterVersion, negotiated, maxRows, maxSeen };
    const base = noSession && !validId(scope.provider) ? undefined : baseProvider(scope.provider);
    const adapter = base !== undefined && Object.hasOwn(SUPPORTED_ADAPTERS, base) ? SUPPORTED_ADAPTERS[base] : undefined;
    this.source = adapter?.source;
    this.support = noSession ? { status: 'unavailable', reason: 'no-session' } : !adapter ? { status: 'unsupported', reason: 'provider' }
      : adapterVersion !== adapter.adapterVersion ? { status: 'unsupported', reason: 'adapter-version' }
      : negotiated !== true ? { status: 'unsupported', reason: 'not-negotiated' } : { status: 'supported' };
    this.rows = new Map(); this.seen = new Set(); this.now = 0;
    this.continuity = noSession ? 'lost' : 'continuous'; this.truncated = false;
  }
  clock(now) {
    assert.ok(time(now), 'invalid timestamp');
    this.now = Math.max(this.now, now);
    return this.now;
  }
  ingest(frame, context) {
    // context is receiving-connection authority, never supplied by the ACP payload.
    if (this.support.status !== 'supported' || this.continuity !== 'continuous' || context.origin !== 'live') return false;
    if (!SCOPE_KEYS.every((k) => context[k] === this.scope[k])) return false;
    if (frame?.sessionId !== this.scope.acpSessionId) return false;
    const u = frame.update;
    if (!u || !validId(u.asyncTaskId) || (u.toolCallId !== undefined && !validId(u.toolCallId))) return false;
    const taskType = u.sessionUpdate === 'async_task_spawned' ? acceptedTaskType(this.scope.provider, u.taskType) : undefined;
    if (!time(context.receivedAt)) return false;
    if (u.sessionUpdate === 'async_task_spawned' && taskType === undefined) {
      // Not a worker (subagent, Codex non-shell): tombstone so a later end report cannot create a row.
      if (!this.seen.has(u.asyncTaskId) && this.seen.size < this.options.maxSeen) this.seen.add(u.asyncTaskId);
      return false;
    }
    const spawned = taskType !== undefined;
    const ended = u.sessionUpdate === 'async_task_state_update' && TERMINAL.has(u.state);
    if (!spawned && !ended) return false;
    const at = context.receivedAt;
    this.clock(at);
    let row = this.rows.get(u.asyncTaskId);
    if (row) {
      // No sequence or epoch upstream: first terminal wins; duplicate spawn is not a heartbeat.
      if (spawned || TERMINAL.has(row.providerState)) return false;
      if (at < row.observedAt) return false;
    } else {
      // Tombstones survive row eviction, so duplicate frames cannot recreate fresh observations.
      if (this.seen.has(u.asyncTaskId)) return false;
      if (this.seen.size >= this.options.maxSeen) { this.truncated = true; return false; }
      this.seen.add(u.asyncTaskId);
      if (this.rows.size >= this.options.maxRows) {
        // Running rows never expire, so evict the oldest ended row first and a running row only when none ended.
        const victim = [...this.rows].find(([, r]) => TERMINAL.has(r.providerState))?.[0] ?? this.rows.keys().next().value;
        this.rows.delete(victim);
        this.truncated = true;
      }
      row = { identity: { ...this.scope, asyncTaskId: u.asyncTaskId }, firstObservedAt: at };
      if (u.toolCallId !== undefined) row.toolCallId = u.toolCallId;
      const title = boundedTitle(u.name);
      if (title !== undefined) row.name = title;
      // A terminal-only row was never announced as stoppable.
      row.canStop = spawned && u.canStop === true;
      if (spawned) row.taskType = taskType;
    }
    row.providerState = spawned ? 'running' : u.state;
    row.observedAt = at;
    row.source = this.source; row.cause = 'unavailable'; row.exitEvidence = { kind: 'unknown' };
    this.rows.set(u.asyncTaskId, row);
    return true;
  }
  disconnect() { this.continuity = 'disconnected'; }
  reconnect() { if (this.continuity === 'disconnected') this.loseContinuity(); }
  loseContinuity() { this.continuity = 'lost'; this.support = { status: 'unavailable', reason: 'continuity-lost' }; }
  authorize(request, granted) {
    if (!validId(request.workspaceId) || !validId(request.agentId)) throw new Error('-32602 invalid-params');
    if (granted !== true || request.workspaceId !== this.scope.workspaceId || request.agentId !== this.scope.agentId) {
      throw new Error('-32602 not-found');
    }
  }
  list(request, now, authority = { canRead: true }) {
    this.authorize(request, authority.canRead);
    const at = this.clock(now);
    return { ...this.scope, support: clone(this.support), continuity: this.continuity, asOf: at,
      truncated: this.truncated,
      workers: [...this.rows.values()].map((r) => project(r, this.continuity)) };
  }
  // Decide a stop request. Either answers locally with stopped:false (no provider call) or
  // forwards exactly one provider request. The row is never changed here: only the
  // provider's own terminal frame ends it, and the stop answer is not worker evidence.
  stop(request, authority = { canControl: true }) {
    if (!validId(request.asyncTaskId) || !validId(request.connectionGeneration)) throw new Error('-32602 invalid-params');
    this.authorize(request, authority.canControl);
    // A provider may reuse a task ID in a new generation: a stale row must never stop a different worker.
    if (request.connectionGeneration !== this.scope.connectionGeneration) throw new Error('-32602 not-found');
    const row = this.rows.get(request.asyncTaskId);
    if (!row) throw new Error('-32602 not-found');
    const result = { asyncTaskId: request.asyncTaskId, stopped: false };
    if (this.support.status !== 'supported' || this.continuity !== 'continuous') return { result };
    if (row.providerState !== 'running' || row.canStop !== true) return { result };
    return { forward: { method: STOP_METHOD, params: { sessionId: this.scope.acpSessionId, asyncTaskId: request.asyncTaskId } } };
  }
  stopResponse(asyncTaskId, response) {
    return { asyncTaskId, stopped: response?.stopped === true };
  }
  push(subscriptionId, seq, now) {
    return { jsonrpc: '2.0', method: 'subscription.push', params: { subscriptionId, kind: 'snapshot', seq,
      snapshot: this.list(this.scope, now) } };
  }
  checkpoint() {
    return clone({ scope: this.scope, options: this.options, support: this.support, continuity: this.continuity,
      now: this.now, rows: [...this.rows], seen: [...this.seen], truncated: this.truncated });
  }
  static restore(checkpoint) {
    // Trusted same-generation in-memory handoff, NOT a client snapshot or persistence format.
    assert.ok(checkpoint?.scope && Array.isArray(checkpoint.rows) && Array.isArray(checkpoint.seen), 'complete internal checkpoint required');
    const c = clone(checkpoint);
    const p = new WorkerProjection(c.scope, c.options);
    Object.assign(p, { support: c.support, continuity: c.continuity, now: c.now, truncated: c.truncated,
      rows: new Map(c.rows), seen: new Set(c.seen) });
    return p;
  }
}

// Models atomic admission/teardown only; no socket, task, timer or event bus.
export class WorkerSubscriptions {
  constructor() { this.connections = new Map(); this.nextId = 1; }
  subscribe(connectionId, projection, request, now, authority = { canRead: true }) {
    const snapshot = projection.list(request, now, authority); // authorize before capacity/support disclosure
    const subscriptions = this.connections.get(connectionId) ?? new Map();
    if (subscriptions.size >= 8) throw new Error('-32602 capacity');
    const subscriptionId = `workers-${this.nextId++}`;
    subscriptions.set(subscriptionId, request.workspaceId);
    this.connections.set(connectionId, subscriptions);
    return { ack: { subscriptionId }, initial: { jsonrpc: '2.0', method: 'subscription.push',
      params: { subscriptionId, kind: 'snapshot', seq: 0, snapshot } } };
  }
  unsubscribe(connectionId, subscriptionId, workspaceId) {
    const subscriptions = this.connections.get(connectionId);
    if (!subscriptions?.has(subscriptionId) || subscriptions.get(subscriptionId) !== workspaceId) return { success: false };
    subscriptions.delete(subscriptionId);
    if (subscriptions.size === 0) this.connections.delete(connectionId);
    return { success: true };
  }
  disconnect(connectionId) { this.connections.delete(connectionId); }
}

export class WorkerClient {
  constructor(scope) { this.scope = scope; this.now = 0; this.snapshot = null; this.subscriptionId = null; this.seq = -1; this.connected = false; }
  // Called only when the subscribe acknowledgement arrives. Validate before replacing a binding.
  subscribe(id) {
    if (!validId(id)) return false;
    this.subscriptionId = id; this.seq = -1; this.connected = false;
    return true;
  }
  disconnect() { this.connected = false; this.subscriptionId = null; }
  push(frame) {
    if (!validId(this.subscriptionId)) return false;
    const p = frame?.params;
    if (frame?.method !== 'subscription.push' || p?.subscriptionId !== this.subscriptionId || p.kind !== 'snapshot') return false;
    if (!Number.isSafeInteger(p.seq) || p.seq < 0 || p.seq <= this.seq || (this.seq === -1 && p.seq !== 0)) return false;
    const s = p.snapshot;
    if (!s || s.workspaceId !== this.scope.workspaceId || s.agentId !== this.scope.agentId) return false;
    if (!Array.isArray(s.workers) || s.workers.length > MAX_ROWS || !time(s.asOf)) return false;
    if (!s.workers.every((r) => SCOPE_KEYS.every((k) => r.identity?.[k] === s[k]))) return false;
    this.snapshot = clone(s); this.seq = p.seq; this.connected = true; this.now = Math.max(this.now, s.asOf);
    return true;
  }
  view(now) {
    assert.ok(time(now)); this.now = Math.max(this.now, now);
    if (!this.snapshot) return null;
    const s = clone(this.snapshot);
    s.workers = s.workers.map((r) => project(r, this.connected ? s.continuity : 'disconnected'));
    return s;
  }
}

export function routeToolUpdate(tools, update) {
  const backgrounded = update?._meta?.jetbrains?.air?.asyncTasks?.backgrounded === true;
  const fields = ['status', 'title', 'kind', 'rawInput', 'rawOutput', 'content', 'locations'];
  const supplied = fields.filter((k) => Object.hasOwn(update, k));
  // The metadata marker is a correlation hint only; never default absent status to started.
  if (backgrounded && supplied.length === 0) return { ordinary: false, backgrounded: true };
  if (update.sessionUpdate !== 'tool_call_update' || !validId(update.toolCallId)) return { ordinary: false, backgrounded };
  tools[update.toolCallId] = { ...tools[update.toolCallId], ...Object.fromEntries(supplied.map((k) => [k, clone(update[k])])) };
  return { ordinary: true, backgrounded };
}

export function runScenario(scenario) {
  const p = new WorkerProjection(scenario.scope, scenario.options);
  const observations = [];
  for (const step of scenario.steps) {
    if (step.op === 'ingest') p.ingest(step.frame, { ...scenario.scope, origin: 'live', receivedAt: step.at, ...step.context });
    else if (step.op === 'disconnect') p.disconnect();
    else if (step.op === 'reconnect') p.reconnect();
    else if (step.op === 'loseContinuity') p.loseContinuity();
    else if (step.op === 'list') observations.push(p.list(scenario.scope, step.at));
    else if (step.op === 'stop') observations.push(p.stop({ ...scenario.scope, asyncTaskId: step.asyncTaskId }));
    else throw new Error('unknown scenario operation');
  }
  return observations;
}
export function readGoldens() {
  return JSON.parse(readFileSync(new URL('../docs/protocol/fixtures/agent-workers/v1/corpus.json', import.meta.url), 'utf8'));
}
export function runGoldens(corpus = readGoldens()) {
  assert.equal(corpus.provenance, 'synthetic-contract-examples-not-provider-captures');
  assert.equal(corpus.version, 1);
  assert.deepEqual(corpus.scenarios.map((s) => s.id), ['running-until-terminal-replayed', 'synthetic-failed', 'terminal-before-spawn', 'capacity-no-recreation', 'unsupported', 'claude-tasks-disconnect', 'stop-decisions']);
  for (const s of corpus.scenarios) assert.deepEqual(runScenario(s), s.expected, s.id);
  return corpus.scenarios.length;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`agent-worker contract: ${runGoldens()} synthetic goldens passed`);
