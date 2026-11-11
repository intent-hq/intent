// Side-by-side report: one column group per harness version.

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const SCORE_KEYS = ['unrecovered', 'unknownMethod', 'wsErrors', 'helpCalls', 'turns', 'toolCalls', 'wsCalls'];

export function summarize(results, harnesses) {
  const out = {};
  for (const h of harnesses) {
    const rs = results.filter((r) => r.harness === h);
    const sum = Object.fromEntries(SCORE_KEYS.map((k) => [k, rs.reduce((n, r) => n + (r.score?.[k] ?? 0), 0)]));
    out[h] = {
      runs: rs.length,
      passed: rs.filter((r) => r.pass).length,
      errors: rs.filter((r) => r.error).length,
      ...sum,
      meanContextUsed: mean(rs.map((r) => r.contextUsed).filter(Number.isFinite)),
      meanTokens: mean(rs.map((r) => r.tokens).filter(Number.isFinite)),
    };
  }
  return out;
}

const fmt = (v) => (v === null || v === undefined ? '–' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : Math.round(v).toLocaleString('en-US')) : String(v));
const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? `${b - a >= 0 ? '+' : ''}${fmt(b - a)}` : '–');
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160);

export function renderMarkdown(report) {
  const hs = report.harness;
  const lines = [
    `# Agent eval: ${report.provider}${report.model ? ` / ${report.model}` : ''}`,
    '',
    `Created ${report.createdAt}. N=${report.n}, ${report.tasks.length} tasks, harness ${hs.join(' vs ')}.`,
    '',
    '| Version | Value |',
    '|---|---|',
    ...Object.entries(report.versions).map(([k, v]) => `| ${k} | ${cell(v ?? 'unknown')} |`),
    '',
  ];
  if (report.error) lines.push(`**Run aborted:** ${cell(report.error)}`, '');
  if (report.isolation && !report.isolation.ok) {
    lines.push(
      '## Isolation: FAILED',
      '',
      'Skills, plugins or other user config appeared in the provider config dir during the run, so the agents below may have seen them. Do not trust this report; the entries were quarantined.',
      '',
      ...report.isolation.leaks.map((l) => `- ${l.harness} ${l.task}#${l.run}: ${cell(l.entries.join(', '))}`),
      '',
    );
  } else if (report.isolation) {
    lines.push('Isolation: ok (provider config re-checked after every task-run).', '');
  }
  if (report.connectors && !report.connectors.ok) {
    lines.push(
      '## claude.ai connectors: FAILED',
      '',
      `The agents below were offered or called claude.ai account connectors (ENABLE_CLAUDEAI_MCP_SERVERS=${report.connectors.optOut ?? 'unset'}). Do not trust this report. A row names the task-run whose check first saw the connector.`,
      '',
      ...report.connectors.seen.map((c) => `- ${c.harness} ${c.task}#${c.run}: ${cell(c.tools.join(', '))}`),
      '',
    );
  } else if (report.connectors) {
    lines.push(`claude.ai connectors: none seen (ENABLE_CLAUDEAI_MCP_SERVERS=${report.connectors.optOut ?? 'unset'}).`, '');
  }
  const metrics = [
    ['Passed', 'passed'],
    ['Runner errors', 'errors'],
    ['Unrecovered ws.* errors', 'unrecovered'],
    ['Unknown-method attempts', 'unknownMethod'],
    ['ws.* errors', 'wsErrors'],
    ['ws.help calls', 'helpCalls'],
    ['Turns', 'turns'],
    ['Tool calls', 'toolCalls'],
    ['Mean contextUsage.used after trivial turn', 'meanContextUsed'],
    ['Mean tokens per task', 'meanTokens'],
  ];
  lines.push('## Summary', '', `| Metric | ${hs.join(' | ')} |${hs.length > 1 ? ` Δ ${hs[hs.length - 1]} − ${hs[0]} |` : ''}`);
  lines.push(`|---|${hs.map(() => '---:').join('|')}|${hs.length > 1 ? '---:|' : ''}`);
  for (const [label, key] of metrics) {
    const vals = hs.map((h) => report.summary[h]?.[key]);
    const runs = key === 'passed' ? hs.map((h) => `/${report.summary[h]?.runs ?? 0}`) : hs.map(() => '');
    lines.push(`| ${label} | ${vals.map((v, i) => fmt(v) + runs[i]).join(' | ')} |${hs.length > 1 ? ` ${delta(vals[0], vals[vals.length - 1])} |` : ''}`);
  }
  lines.push('', '## Per task', '', `| Task | Run | ${hs.map((h) => `${h} pass | ${h} unrec. | ${h} ctx | ${h} tokens`).join(' | ')} |`);
  lines.push(`|---|---:|${hs.map(() => ':---:|---:|---:|---:').join('|')}|`);
  const keys = [...new Set(report.results.map((r) => `${r.task}#${r.run}`))];
  for (const key of keys) {
    const [task, run] = key.split('#');
    const cols = hs.map((h) => {
      const r = report.results.find((x) => x.task === task && String(x.run) === run && x.harness === h);
      if (!r) return '– | – | – | –';
      return `${r.pass ? 'pass' : 'FAIL'}${r.cached ? ' (cached)' : ''} | ${fmt(r.score?.unrecovered)} | ${fmt(r.contextUsed)} | ${fmt(r.tokens)}`;
    });
    lines.push(`| ${task} | ${run} | ${cols.join(' | ')} |`);
  }
  const failures = report.results.filter((r) => !r.pass);
  if (failures.length) {
    lines.push('', '## Failures', '');
    for (const r of failures) lines.push(`- ${r.harness} ${r.task}#${r.run}: ${cell(r.detail)}`);
  }
  if (report.controls?.length) {
    lines.push('', '## Negative controls', '', '| Control | Harness | Expect | Held | Detail |', '|---|---|---|:---:|---|');
    for (const c of report.controls) lines.push(`| ${c.task} | ${c.harness} | ${c.expect} | ${c.held ? 'yes' : 'NO'} | ${cell(c.detail)} |`);
  }
  return lines.join('\n') + '\n';
}
