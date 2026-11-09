#!/usr/bin/env node
// Agent eval runner: drives real agents through isolated intentd daemons, one per
// harness version (A/B on one binary via the eval-only harness stamp), and
// writes a side-by-side report. `make agent-eval` is the entry point.
//
// Per task-run: fresh fixture repo + workspace, a trivial first turn (its
// contextUsage.used is the prompt size), then the task prompt. "Done" = every
// agent in the workspace idle with an empty queue and no active hooks or
// monitors (unless the task allows one), seen three polls in a row.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EVAL_CACHE, preflightProvider, startDaemon, versions } from './lib/daemon.mjs';
import { renderMarkdown, summarize } from './lib/report.mjs';
import { connect } from './lib/rpc.mjs';
import { addScores, scoreTranscript } from './lib/score.mjs';
import { FIXTURE_SPEC, createFixtureRepo, mockSolutions, selectTasks } from './tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIVIAL_PROMPT = 'Reply with just the word: ready';
const IDLE_POLLS = 3;

export const USAGE = `usage: node scripts/agent-eval/run.mjs --provider <claude-code|codex|mock> --intentd-bin <path>
  [--model <id>] [--harness 3.9,3.10] [--n 1] [--quick] [--tasks id,id] [--out dir]
  [--config-dir dir] [--timeout-min 15] [--reuse-baseline] [--expect-pass] [--keep]

  --harness       comma list of harness versions to compare; "current" = no override
  --quick         the quick subset (N stays as given; default 1)
  --config-dir    dedicated provider config dir (default ${path.join(EVAL_CACHE, '<provider>')})
  --reuse-baseline  reuse cached results for the first harness when CLI, adapter
                  and model versions are unchanged
  --expect-pass   exit 1 unless every task passes (the MOCK_AGENT smoke)`;

export function parseArgs(argv) {
  const o = { harness: ['3.9', '3.10'], n: 1, timeoutMin: 15, tasks: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--provider') o.provider = val();
    else if (a === '--model') o.model = val() || undefined;
    else if (a === '--harness') o.harness = val().split(/[,\s]+/).filter(Boolean);
    else if (a === '--n') o.n = Number(val());
    else if (a === '--tasks') o.tasks = val().split(/[,\s]+/).filter(Boolean);
    else if (a === '--quick') o.quick = true;
    else if (a === '--out') o.out = val();
    else if (a === '--intentd-bin') o.bin = val();
    else if (a === '--config-dir') o.configDir = val() || undefined;
    else if (a === '--timeout-min') o.timeoutMin = Number(val());
    else if (a === '--reuse-baseline') o.reuseBaseline = true;
    else if (a === '--expect-pass') o.expectPass = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.help) return o;
  if (!o.provider) throw new Error('missing --provider');
  if (!o.bin || !fs.existsSync(o.bin)) throw new Error(`intentd binary not found: ${o.bin ?? '(none)'}; build it with cargo build -p intentd or pass INTENTD_BIN`);
  if (!Number.isInteger(o.n) || o.n < 1) throw new Error(`invalid --n: ${o.n}`);
  if (!o.harness.length) throw new Error('empty --harness');
  return o;
}

const log = (...a) => process.stderr.write(`[agent-eval] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const busy = (a) =>
  a.turnInFlight || a.isResponding || a.isProcessing || a.isStreaming || a.isWaitingOnTool || String(a.status).toLowerCase() === 'active';
const activeMonitor = (m) => !/^(completed|cancelled|canceled|expired|failed|finished|done|stopped)$/i.test(String(m.state ?? m.status ?? 'active'));

/** Wait until the workspace is done; returns { timedOut, pending }. */
async function waitDone(rpc, { workspaceId, agentId, sentAt, timeoutMs, pollMs, allowPending = [] }) {
  const deadline = Date.now() + timeoutMs;
  let idle = 0;
  let pending = [];
  while (Date.now() < deadline) {
    await sleep(pollMs);
    pending = [];
    const agents = (await rpc.call('agent.list', { workspaceId })).agents ?? [];
    const primary = agents.find((a) => a.id === agentId);
    const answered =
      primary &&
      (String(primary.status).toLowerCase() === 'error' ||
        (primary.lastMessageRole === 'assistant' && Date.parse(primary.lastActivity) >= sentAt));
    if (!answered) pending.push('no reply yet');
    for (const a of agents) {
      if (busy(a)) pending.push(`${a.name ?? a.id} busy`);
      const q = await rpc.call('agent.getQueue', { agentId: a.id, workspaceId }).catch(() => ({ queueLength: 0 }));
      if (q.queueLength) pending.push(`${a.name ?? a.id} queue ${q.queueLength}`);
    }
    if (!allowPending.includes('hooks')) {
      const hooks = (await rpc.call('hook.list', { workspaceId })).hooks ?? [];
      if (hooks.length) pending.push(`${hooks.length} hooks`);
    }
    const scriptMonitors = ((await rpc.call('scriptMonitor.list', { workspaceId }).catch(() => ({}))).monitors ?? []).filter(activeMonitor);
    const prMonitors = ((await rpc.call('prMonitor.list', { workspaceId }).catch(() => ({}))).monitors ?? []).filter(activeMonitor);
    if (scriptMonitors.length) pending.push(`${scriptMonitors.length} script monitors`);
    if (prMonitors.length) pending.push(`${prMonitors.length} PR monitors`);
    idle = pending.length ? 0 : idle + 1;
    if (idle >= IDLE_POLLS) return { timedOut: false, pending: [] };
  }
  return { timedOut: true, pending };
}

async function sessionMessages(rpc, agentId, workspaceId) {
  const s = (await rpc.call('agent.getSession', { agentId, workspaceId })).session;
  return { session: s, messages: (s.messages ?? []).map((m) => ({ role: m.role, blocks: m.contentBlocks ?? [] })) };
}

const lastReplyOf = (messages) => {
  const m = [...messages].reverse().find((x) => x.role === 'assistant' && x.blocks.some((b) => b.type === 'text'));
  return m ? m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
};
const tokenTotal = (u) => ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].reduce((n, k) => n + (u?.totals?.[k] ?? 0), 0);

async function runTask({ arm, task, run, opts, root }) {
  const { rpc } = arm;
  const started = Date.now();
  const id = `${arm.harness}-${task.id}-${run}`;
  const repo = path.join(root, 'repos', id);
  fs.mkdirSync(repo, { recursive: true });
  createFixtureRepo(repo);
  const createWorkspace = async (name) => (await rpc.call('workspace.create', { name, repositoryPath: repo })).workspace;
  const result = { task: task.id, harness: arm.harness, run, pass: false };
  try {
    const workspace = await createWorkspace(`eval ${task.id}`);
    const workspaceId = workspace.id;
    await rpc.call('note.update', { noteId: 'spec', workspaceId, content: FIXTURE_SPEC });
    const ctx = { rpc, workspaceId, worktree: workspace.worktreePath, baseCommit: workspace.baseCommitSha, createWorkspace };
    await task.setup?.(ctx);
    const agent = (await rpc.call('agent.create', { workspaceId, name: 'Eval', provider: opts.provider, ...(opts.model ? { model: opts.model } : {}) })).agent;
    ctx.agentId = agent.id;
    result.stampedHarness = agent.harnessVersion;
    if (arm.harness !== 'current' && agent.harnessVersion !== arm.harness) {
      throw Object.assign(new Error(`agent stamped ${agent.harnessVersion}, wanted ${arm.harness}: this intentd ignores the eval override`), { fatal: true });
    }
    const timeoutMs = opts.timeoutMin * 60_000;
    const pollMs = opts.provider === 'mock' ? 750 : 2000;
    let sentAt = Date.now();
    await rpc.call('agent.sendMessage', { workspaceId, agentId: agent.id, content: TRIVIAL_PROMPT });
    const first = await waitDone(rpc, { workspaceId, agentId: agent.id, sentAt, timeoutMs: Math.min(timeoutMs, 5 * 60_000), pollMs });
    if (first.timedOut) throw new Error(`trivial first turn did not finish: ${first.pending.join(', ')}`);
    const afterTrivial = (await rpc.call('agent.get', { agentId: agent.id, workspaceId })).agent;
    result.contextUsed = afterTrivial.contextUsage?.used ?? null;
    await sleep(1500);
    const trivialTokens = tokenTotal((await rpc.call('workspace.getTokenUsage', { workspaceId })).tokenUsage);

    ctx.promptAt = sentAt = Date.now();
    await rpc.call('agent.sendMessage', { workspaceId, agentId: agent.id, content: task.prompt });
    const done = await waitDone(rpc, { workspaceId, agentId: agent.id, sentAt, timeoutMs, pollMs, allowPending: task.allowPending });
    result.timedOut = done.timedOut;
    if (done.timedOut) result.pending = done.pending;

    let score = scoreTranscript([]);
    const agents = (await rpc.call('agent.list', { workspaceId })).agents ?? [];
    for (const a of agents) {
      const { session, messages } = await sessionMessages(rpc, a.id, workspaceId);
      if (a.id === agent.id) {
        result.model = session.model ?? opts.model ?? null;
        ctx.lastReply = lastReplyOf(messages);
        const taskTurn = messages.findIndex((m, i) => i > 0 && m.role === 'user');
        score = addScores(score, scoreTranscript(taskTurn < 0 ? [] : messages.slice(taskTurn)));
      } else {
        score = addScores(score, scoreTranscript(messages));
      }
    }
    result.agents = agents.length;
    result.score = score;
    await sleep(1500);
    result.tokens = tokenTotal((await rpc.call('workspace.getTokenUsage', { workspaceId })).tokenUsage) - trivialTokens;
    const v = await task.check(ctx);
    result.pass = v.pass && !done.timedOut;
    result.detail = done.timedOut ? `timed out (${done.pending.join(', ')}); ${v.detail}` : v.detail;
  } catch (error) {
    if (error.fatal) throw error;
    result.error = String(error?.message ?? error);
    result.detail = result.error;
  }
  result.durationMs = Date.now() - started;
  return result;
}

/** Baseline cache for the first harness: dropped when CLI, adapter or model change. */
function baselineCache(opts, ver) {
  const dir = path.join(EVAL_CACHE, 'baseline', `${opts.provider}-${opts.model ?? 'default'}`);
  const key = { cli: ver.cli, adapter: ver.adapter, model: opts.model ?? null };
  const metaFile = path.join(dir, 'versions.json');
  if (fs.existsSync(metaFile) && JSON.stringify(JSON.parse(fs.readFileSync(metaFile, 'utf8'))) !== JSON.stringify(key)) {
    log(`versions changed since the cached baseline; dropping ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaFile, JSON.stringify(key));
  const file = (harness, task, run) => path.join(dir, `${harness}-${task.id}-${run}-${hash([task.prompt, task.check.toString()])}.json`);
  return {
    get: (h, t, r) => (fs.existsSync(file(h, t, r)) ? { ...JSON.parse(fs.readFileSync(file(h, t, r), 'utf8')), cached: true } : null),
    put: (h, t, r, res) => fs.writeFileSync(file(h, t, r), JSON.stringify(res)),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const mock = opts.provider === 'mock';
  let tasks = selectTasks({ ids: opts.tasks, quick: opts.quick });
  if (mock) tasks = tasks.filter((t) => t.mock);
  const { env: providerEnv, dir: configDir } = preflightProvider(opts.provider, opts.configDir);
  const ver = versions(opts.provider, opts.bin, providerEnv);
  if (!ver.evalOverride && opts.harness.some((h) => h !== 'current')) {
    throw new Error(`${opts.bin} has no eval harness override (INTENTD_EVAL_HARNESS_VERSION); use --harness current or a newer build`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.resolve(opts.out ?? path.join('.dev', 'agent-eval', `${stamp}-${opts.provider}`));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-'));
  log(`provider=${opts.provider} model=${opts.model ?? 'default'} harness=${opts.harness.join(' vs ')} tasks=${tasks.length} n=${opts.n}`);
  log(`versions ${JSON.stringify(ver)}; daemons under ${root}`);

  const extraEnv = {};
  if (mock) {
    const solutions = path.join(root, 'mock-solutions.json');
    fs.writeFileSync(solutions, JSON.stringify(mockSolutions(tasks)));
    Object.assign(extraEnv, { MOCK_AGENT_SCRIPT_PATH: path.join(HERE, 'mock-agent.mjs'), EVAL_MOCK_SOLUTIONS: solutions });
  }
  const cache = opts.reuseBaseline ? baselineCache(opts, ver) : null;
  const arms = [];
  const results = [];
  let failure;
  try {
    for (const harness of opts.harness) {
      const daemon = await startDaemon({ bin: opts.bin, root: path.join(root, `daemon-${harness}`), harness, providerEnv, extraEnv });
      arms.push({ harness, daemon, rpc: await connect(daemon.socketPath, { timeoutMs: 120_000 }) });
    }
    for (let run = 1; run <= opts.n; run++) {
      for (const task of tasks) {
        for (const [i, arm] of arms.entries()) {
          const cached = i === 0 && cache?.get(arm.harness, task, run);
          const r = cached || (await runTask({ arm, task, run, opts, root }));
          if (i === 0 && cache && !cached && !r.error) cache.put(arm.harness, task, run, r);
          results.push(r);
          log(`${r.pass ? 'PASS' : 'FAIL'} ${arm.harness} ${task.id}#${run}${r.cached ? ' (cached)' : ''}: ${r.detail ?? ''}`);
        }
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const arm of arms) {
      arm.rpc.close();
      await arm.daemon.stop();
    }
  }
  const report = {
    createdAt: new Date().toISOString(),
    provider: opts.provider,
    model: opts.model ?? null,
    harness: opts.harness,
    n: opts.n,
    configDir,
    versions: ver,
    tasks: tasks.map((t) => t.id),
    results,
    summary: summarize(results, opts.harness),
    error: failure ? String(failure.message ?? failure) : undefined,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(report));
  log(`report: ${path.join(out, 'report.md')}`);
  if (!opts.keep && !failure) fs.rmSync(root, { recursive: true, force: true });
  else log(`kept daemon dirs and logs under ${root}`);
  if (failure) throw failure;
  if (opts.expectPass && results.some((r) => !r.pass)) {
    log('expected every task to pass');
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      log(`error: ${error?.message ?? error}`);
      process.exit(error?.exitCode ?? 1);
    },
  );
}
