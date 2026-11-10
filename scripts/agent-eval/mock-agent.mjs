#!/usr/bin/env node
// Scripted ACP agent for the agent-eval smoke (MOCK_AGENT=1). Zero dependencies.
//
// intentd spawns it as the `mock` provider (MOCK_AGENT_SCRIPT_PATH) with
// `--mcp-config <file>`. On each session/prompt it finds the first entry in
// EVAL_MOCK_SOLUTIONS (a JSON file: [{ match, steps: [{ code, summary? }], reply? }])
// whose `match` occurs in the prompt text, runs each step through the daemon's
// real workspace_api tool, and reports each call as an ACP tool call so the
// daemon stores tool_use/tool_result blocks the scorer reads. It also reports a
// usage_update whose `used` is the prompt length / 4, so contextUsage tracks the
// size of what Intent sent. A solution with `syncSkills: true` first does what
// Claude Code's account sync does: it replaces the runner's blocker files in
// its config dir (EVAL_MOCK_CONFIG_DIR) with skills/synced and plugins/synced.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SESSION_ID = 'eval-mock-session';
let bridge;
let toolSeq = 0;
const totals = { inputTokens: 0, outputTokens: 0 };

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: SESSION_ID, update: u } });

function mcpServer() {
  const i = process.argv.indexOf('--mcp-config');
  if (i < 0) throw new Error('mock-agent: missing --mcp-config');
  const config = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  const server = config.mcpServers?.['workspace-mcp'];
  if (!server) throw new Error('mock-agent: no workspace-mcp server in --mcp-config');
  return server;
}

/** One long-lived stdio MCP client over the daemon's bridge. */
function openBridge() {
  const server = mcpServer();
  const proc = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  let nextId = 0;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
    else w.resolve(msg.result);
  });
  proc.on('close', () => {
    for (const w of waiting.values()) w.reject(new Error('MCP bridge closed'));
    waiting.clear();
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const ready = request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agent-eval-mock', version: '1' },
  }).then(() => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
  return {
    async call(code, summary) {
      await ready;
      return request('tools/call', { name: 'workspace_api', arguments: { code, summary } });
    },
    close() {
      proc.stdin.end();
    },
  };
}

function loadSolutions() {
  const file = process.env.EVAL_MOCK_SOLUTIONS;
  if (!file || !fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runStep(step) {
  const toolCallId = `eval-mock-${++toolSeq}`;
  const rawInput = { code: step.code, summary: step.summary ?? 'eval step' };
  update({ sessionUpdate: 'tool_call', toolCallId, title: 'workspace_api', kind: 'other', status: 'pending', rawInput });
  let text;
  let isError;
  try {
    bridge ??= openBridge();
    const result = await bridge.call(step.code, rawInput.summary);
    text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
    isError = Boolean(result?.isError);
  } catch (error) {
    text = String(error?.message ?? error);
    isError = true;
  }
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: isError ? 'failed' : 'completed',
    rawOutput: { content: [{ type: 'text', text }], isError },
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
}

function syncAccountSkills() {
  const dir = process.env.EVAL_MOCK_CONFIG_DIR;
  if (!dir) throw new Error('mock-agent: syncSkills needs EVAL_MOCK_CONFIG_DIR');
  for (const root of ['skills', 'plugins']) {
    fs.rmSync(path.join(dir, root), { recursive: true, force: true });
    const synced = path.join(dir, root, 'synced', 'developer-only');
    fs.mkdirSync(synced, { recursive: true });
    fs.writeFileSync(path.join(synced, root === 'skills' ? 'SKILL.md' : 'plugin.json'), '# developer-only\n');
  }
}

async function prompt(id, params) {
  const text = (params?.prompt ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const solution = loadSolutions().find((s) => text.includes(s.match));
  const used = Math.round(text.length / 4);
  totals.inputTokens += used;
  update({ sessionUpdate: 'usage_update', used, size: 200000 });
  if (solution?.syncSkills) syncAccountSkills();
  for (const step of solution?.steps ?? []) await runStep(step);
  const reply = solution?.reply ?? 'ready';
  totals.outputTokens += Math.ceil(reply.length / 4);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
  send({
    id,
    result: {
      stopReason: 'end_turn',
      usage: { ...totals, totalTokens: totals.inputTokens + totals.outputTokens, cachedReadTokens: 0, cachedWriteTokens: 0 },
    },
  });
}

const handlers = {
  initialize: (id) =>
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'agent-eval-mock', version: '1' } } }),
  authenticate: (id) => send({ id, result: { authenticated: true } }),
  'session/new': (id) => send({ id, result: { sessionId: SESSION_ID } }),
  'session/load': (id) => send({ id, error: { code: -32601, message: 'Method not found: session/load' } }),
  'session/prompt': prompt,
  'session/cancel': () => {},
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg.method) return;
  const handler = handlers[msg.method];
  try {
    if (handler) await handler(msg.id, msg.params);
    else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  } catch (error) {
    process.stderr.write(`[agent-eval-mock] ${msg.method} failed: ${error?.stack ?? error}\n`);
    if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
});
process.stdin.on('end', () => {
  bridge?.close();
  process.exit(0);
});
