// Prepared reference oracle, not production code. Cursor encoding here is only
// for deterministic tests; clients treat the daemon's cursor as opaque.
export const bytes = value => Buffer.byteLength(JSON.stringify(value));
const pick = (row, keys) => Object.fromEntries(keys
  .filter(key => Object.hasOwn(row, key))
  .map(key => [key, structuredClone(row[key])]));
const invalid = () => { throw new Error('InvalidParams'); };
function preview(text, budget) {
  let value = '', used = 0;
  for (const scalar of text) {
    const size = Buffer.byteLength(scalar);
    if (used + size > budget) break;
    value += scalar;
    used += size;
  }
  return [value, value !== text];
}
function withError(row, keys) {
  const result = pick(row, keys);
  if (Object.hasOwn(row, 'error')) {
    const [text, truncated] = preview(row.error, 256);
    result.error = text;
    if (truncated) result.errorTruncated = true;
  }
  return result;
}
const resultFields = ['outcome', 'exitCode', 'startedAt', 'stoppedAt'];
export function scriptSummary(row) {
  const result = pick(row, ['id', 'workspaceId', 'name', 'mode', 'source', 'category', 'autoStart', 'createdAt', 'updatedAt', 'purpose', 'archivedAt']);
  [result.commandPreview, result.commandTruncated] = preview(row.command, 160);
  result.runtime = withError(row.runtime, ['status', 'restartCount', 'runId', 'pid', 'exitCode', 'startedAt', 'stoppedAt', 'detectedUrl', 'previouslyRunning', 'ready', 'readiness']);
  if (row.lastRun) result.lastRun = withError(row.lastRun, ['runId', ...resultFields]);
  return result;
}
export function monitorSummary(row) {
  const result = pick(row, ['monitorId', 'workspaceId', 'agentId', 'scriptId', 'runId', 'scriptName', 'mode', 'state', 'lineCount', 'createdAt', 'expiresAt', 'settledAt', 'reason']);
  if (Object.hasOwn(row, 'outputPattern'))
    [result.outputPatternPreview, result.outputPatternTruncated] = preview(row.outputPattern, 160);
  if (row.result) result.result = withError(row.result, resultFields);
  if (row.trigger) result.trigger = pick(row.trigger, ['observedLineCount']);
  return result;
}
export function representativeRows(count = 3) {
  const scripts = [], monitors = [];
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(5, '0');
    scripts.push({
      id, workspaceId: 'ws-a', name: `Script ${id}`, command: 'x'.repeat(8192),
      cwd: 'repo', env: { SYNTHETIC: 'v'.repeat(2048) }, mode: 'command', source: 'user',
      purpose: i % 2 ? 'saved' : 'oneOff', createdAt: '2026-10-01T00:00:00Z',
      ...(i % 2 ? {} : { archivedAt: '2026-10-02T00:00:00Z' }),
      lastRun: {
        runId: `run-${id}`, outcome: 'interrupted', exitCode: -1,
        stoppedAt: '2026-10-02T00:00:00Z', error: 'e'.repeat(2048),
      },
      runtime: {
        runId: `run-${id}`, status: 'exited', restartCount: 0,
        exitCode: -1, error: 'e'.repeat(2048),
      },
    });
    monitors.push({
      monitorId: id, workspaceId: 'ws-a', agentId: 'agent-a', scriptId: id,
      runId: `run-${id}`, scriptName: `Script ${id}`, mode: 'command', state: 'triggered',
      outputPattern: 'p'.repeat(1024), createdAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-01T01:00:00Z', settledAt: '2026-10-01T00:01:00Z',
      reason: 'output-match', trigger: { observedLineCount: 3, matchedLine: 'p'.repeat(4096) },
    });
  }
  return { scripts, monitors };
}
export function page(method, rows, params) {
  const scripts = method === 'script.list';
  const key = scripts ? 'scripts' : 'monitors';
  const id = scripts ? 'id' : 'monitorId';
  const view = params.view === undefined ? 'full' : params.view;
  if (!['full', 'summary'].includes(view)) invalid();
  const archive = params.archive === undefined ? 'all' : params.archive;
  const state = params.state === undefined ? 'all' : params.state;
  if (scripts && !['active', 'archived', 'all'].includes(archive)) invalid();
  if (!scripts && !['active', 'terminal', 'all'].includes(state)) invalid();
  if (!scripts && params.agentId !== undefined && (typeof params.agentId !== 'string' || !params.agentId)) invalid();
  if (view === 'full' && ['limit', 'cursor', 'state'].some(k => Object.hasOwn(params, k))) invalid();
  if (scripts && Object.hasOwn(params, 'state')) invalid();
  const scope = [method, params.workspaceId, scripts ? archive : state, scripts ? null : params.agentId ?? null];
  const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const tuple = row => [row.createdAt, row[id]];
  const compareTuple = (a, b) => compare(a[0], b[0]) || compare(a[1], b[1]);
  let selected = rows.filter(row => row.workspaceId === params.workspaceId && (scripts
    ? archive === 'all' || Boolean(row.archivedAt) === (archive === 'archived')
    : (!params.agentId || row.agentId === params.agentId) && (state === 'all' || (row.state === 'active') === (state === 'active'))));
  selected.sort((a, b) => compareTuple(tuple(a), tuple(b)));
  if (view === 'full') return { [key]: structuredClone(selected) };
  const limit = params.limit === undefined ? 100 : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid();
  selected.reverse();
  if (Object.hasOwn(params, 'cursor')) {
    let cursor;
    try {
      if (typeof params.cursor !== 'string' || !params.cursor) invalid();
      cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || JSON.stringify(cursor.scope) !== JSON.stringify(scope) || !Array.isArray(cursor.after) || cursor.after.length !== 2 || cursor.after.some(x => typeof x !== 'string' || !x)) invalid();
    } catch { invalid(); }
    selected = selected.filter(row => compareTuple(tuple(row), cursor.after) < 0);
  }
  const window = selected.slice(0, limit);
  const result = { view: 'summary', [key]: window.map(scripts ? scriptSummary : monitorSummary) };
  if (selected.length > limit) result.nextCursor = Buffer.from(JSON.stringify({ v: 1, scope, after: tuple(window.at(-1)) })).toString('base64url');
  return result;
}
