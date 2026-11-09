#!/usr/bin/env node
// Post-release metrics over stored conversations: per harness version, the
// workspace_api calls, errors (is_error results only), unknown-method attempts,
// unrecovered errors and ws.help calls. Reads the intentd SQLite database
// read-only. `make agent-eval-metrics` is the entry point.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { addScores, scoreTranscript } from './lib/score.mjs';

export const USAGE = `usage: node scripts/agent-eval/metrics.mjs [--db path] [--since YYYY-MM-DD] [--provider prefix] [--json]

  --db        intentd.db (default: INTENTD_DATA_DIR or the platform data dir)
  --since     only messages created on or after this date
  --provider  only sessions whose provider starts with this (e.g. codex, claude-code)
  --json      print JSON instead of a Markdown table`;

export function defaultDbPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.INTENTD_DATA_DIR) return path.join(env.INTENTD_DATA_DIR, 'intentd.db');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'intentd', 'intentd.db');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'intentd', 'intentd.db');
}

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--db') o.db = val();
    else if (a === '--since') o.since = val();
    else if (a === '--provider') o.provider = val();
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.since && Number.isNaN(Date.parse(o.since))) throw new Error(`invalid --since: ${o.since}`);
  return o;
}

const parseBlocks = (content) => {
  try {
    const v = JSON.parse(content);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Aggregate scores per harness version. */
export async function collect({ db, since, provider }) {
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(db, { readOnly: true });
  const where = ["(m.role IN ('user', 'system') OR m.content LIKE '%tool_%')"];
  const params = [];
  if (since) {
    where.push('m.created_at >= ?');
    params.push(new Date(since).toISOString());
  }
  if (provider) {
    where.push("s.provider LIKE ? ESCAPE '\\'");
    params.push(`${provider.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const stmt = conn.prepare(
    `SELECT m.agent_id AS agent, s.harness_version AS harness, m.role AS role, m.content AS content
       FROM agent_message m JOIN agent_session s ON s.id = m.agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.agent_id, m.seq`,
  );
  const byHarness = {};
  let agent = null;
  let harness = null;
  let messages = [];
  const flush = () => {
    if (agent === null) return;
    const score = scoreTranscript(messages);
    const bucket = (byHarness[harness] ??= { sessions: 0, ...scoreTranscript([]) });
    if (score.wsCalls || score.turns) bucket.sessions += 1;
    Object.assign(bucket, addScores(bucket, score));
  };
  for (const row of stmt.iterate(...params)) {
    if (row.agent !== agent) {
      flush();
      agent = row.agent;
      harness = row.harness;
      messages = [];
    }
    messages.push({ role: row.role, blocks: parseBlocks(row.content) });
  }
  flush();
  conn.close();
  return byHarness;
}

const versionOrder = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return a.localeCompare(b);
};
const per1k = (n, d) => (d ? ((1000 * n) / d).toFixed(2) : '–');

export function renderTable(byHarness) {
  const rows = [
    '| Harness | Sessions | ws calls | ws errors | Unknown-method | Unrecovered | ws.help | Errors /1k calls | Unknown /1k | Unrecovered /1k | Help /1k |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const h of Object.keys(byHarness).sort(versionOrder)) {
    const b = byHarness[h];
    rows.push(
      `| ${h} | ${b.sessions} | ${b.wsCalls} | ${b.wsErrors} | ${b.unknownMethod} | ${b.unrecovered} | ${b.helpCalls} | ${per1k(b.wsErrors, b.wsCalls)} | ${per1k(b.unknownMethod, b.wsCalls)} | ${per1k(b.unrecovered, b.wsCalls)} | ${per1k(b.helpCalls, b.wsCalls)} |`,
    );
  }
  return rows.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const db = opts.db ?? defaultDbPath();
  if (!fs.existsSync(db)) throw new Error(`database not found: ${db}`);
  const byHarness = await collect({ db, since: opts.since, provider: opts.provider });
  process.stdout.write(opts.json ? JSON.stringify(byHarness, null, 2) + '\n' : renderTable(byHarness));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[agent-eval-metrics] error: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
