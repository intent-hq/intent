// Aggregate-only audit. No raw responses, commands, env keys/values, error
// strings or output are logged or saved. --live performs only the two list RPCs.
// Usage: node docs/protocol/fixtures/scripts/payload-audit.mjs [--live workspaceId]
// Live reads only unarchived scripts; original all-archive baseline is recorded
// in the task note and is deliberately not fetched again. Monitor baseline reads
// may still contain terminal rows on a protocol-13 host.
// Live uses the repo probe's INTENTD_SOCKET/INTENTD_DATA_DIR discovery.
import { bytes, page, scriptSummary, monitorSummary, representativeRows } from './compact-model.mjs';

const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { min: sorted[0] ?? 0, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? 0 };
};
function audit(method, result, workspaceId) {
  const isScript = method === 'script.list';
  const rows = result[isScript ? 'scripts' : 'monitors'];
  if (!Array.isArray(rows)) throw new Error('Unexpected response shape (payload withheld)');
  const fields = {}, distributions = {}, joint = {}, fieldSizes = {};
  const errors = new Map();
  const aggregate = (row, path = '') => {
    for (const [key, value] of Object.entries(row)) {
      const name = path + key;
      fields[name] = (fields[name] ?? 0) + bytes(key) + 1 + bytes(value);
      (fieldSizes[name] ??= []).push(bytes(value));
      if (key === 'error' && typeof value === 'string') errors.set(value, (errors.get(value) ?? 0) + 1);
      if (value && typeof value === 'object' && !Array.isArray(value) && key !== 'env') aggregate(value, name + '.');
    }
  };
  for (const row of rows) {
    aggregate(row);
    for (const key of isScript ? ['purpose', 'mode'] : ['state', 'mode']) {
      const value = row[key] ?? 'absent';
      (distributions[key] ??= {})[value] = (distributions[key][value] ?? 0) + 1;
    }
    if (isScript) {
      const bucket = `${row.archivedAt ? 'archived' : 'active'}:${row.purpose ?? 'absent'}`;
      joint[bucket] = (joint[bucket] ?? 0) + 1;
    }
  }
  const eligible = rows.filter(row => isScript ? !row.archivedAt : row.state === 'active');
  const summaryRows = eligible.map(isScript ? scriptSummary : monitorSummary);
  const first = page(method, rows, { workspaceId, view: 'summary' });
  const focus = isScript ? ['command', 'env', 'lastRun', 'lastRun.error', 'runtime', 'runtime.error'] : ['outputPattern', 'trigger.matchedLine', 'result', 'result.error'];
  return {
    method, resultBytes: bytes(result), rows: rows.length, rowBytes: stats(rows.map(bytes)), distributions,
    ...(isScript ? { archivedPurpose: joint } : {}),
    // Contributions include key+colon+value, excluding parent separators. Nested
    // fields are subsets of parent totals and must not be added to parents.
    fieldContributions: Object.fromEntries(Object.entries(fields).sort((a, b) => b[1] - a[1])),
    fieldValueBytesWhenPresent: Object.fromEntries(focus.map(name => [name, stats(fieldSizes[name] ?? [])])),
    errors: { occurrences: [...errors.values()].reduce((a, b) => a + b, 0), distinct: errors.size, maxRepeats: Math.max(0, ...errors.values()) },
    referenceProjection: {
      status: 'protocol14-reference-not-daemon-support',
      eligibleRows: eligible.length,
      eligibleFullBytes: bytes({ [isScript ? 'scripts' : 'monitors']: eligible }),
      allRowsBytes: bytes({ view: 'summary', [isScript ? 'scripts' : 'monitors']: summaryRows }),
      first100PageBytes: bytes(first),
      first100Rows: first[isScript ? 'scripts' : 'monitors'].length,
      summaryRowBytes: stats(summaryRows.map(bytes)),
      ...(isScript ? {} : { activePageBytes: bytes(page(method, rows, { workspaceId, view: 'summary', state: 'active' })) }),
    },
  };
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--live' || !args[1]))
  throw new Error('Usage: node payload-audit.mjs [--live workspaceId]');
const workspaceId = args[1] ?? 'ws-a';
const synthetic = args.length ? null : representativeRows(3174);
for (const method of ['script.list', 'scriptMonitor.list']) {
  let result, elapsedMs, wireBytes;
  if (synthetic) result = method === 'script.list' ? { scripts: synthetic.scripts } : { monitors: synthetic.monitors.slice(0, 1000) };
  else {
    const { runProbe } = await import('../../../../scripts/uds-rpc.mjs');
    const { defaultSocketPath } = await import('../../../../scripts/uds-ws-bridge.mjs');
    let raw = '';
    const start = performance.now();
    const code = await runProbe({ method, params: { workspaceId, ...(method === 'script.list' ? { archive: 'active' } : {}) }, socketPath: defaultSocketPath(), stdout: { write: text => { raw += text; } }, stderr: { write: () => {} }, timeout: 30000 });
    elapsedMs = Math.round(performance.now() - start);
    wireBytes = Buffer.byteLength(raw);
    if (code) {
      console.log(JSON.stringify({ method, probeExitCode: code, elapsedMs, wireBytes, unavailable: true }));
      process.exitCode = 1;
      continue;
    }
    result = JSON.parse(raw).result;
  }
  console.log(JSON.stringify({ source: synthetic ? 'synthetic' : 'live', workspaceId, elapsedMs, wireBytes, ...audit(method, result, workspaceId) }));
}
