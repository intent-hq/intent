import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROVIDERS, connectorTraces, isConnectorTool } from './lib/daemon.mjs';
import { renderMarkdown } from './lib/report.mjs';
import { cacheable, checkConnectors, checkIsolation, connectorCalls, connectorReport } from './run.mjs';
import { controlHeld, mockControls } from './tasks.mjs';

const claude = PROVIDERS['claude-code'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-connectors-'));

/** A session record the way Claude Code writes one when connectors load. */
const offered = (...names) => JSON.stringify({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: names } }) + '\n';

function session(dir, rel, text) {
  const file = path.join(dir, 'projects', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  return file;
}

test('the claude-code provider env opts out of claude.ai connectors', () => {
  assert.deepEqual(claude.env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  assert.equal(PROVIDERS.codex.connectors, undefined);
});

test('connector tool names match the CLI and the intentd-derived spellings only', () => {
  for (const n of ['mcp__claude_ai_Gmail__search_threads', 'claude_ai_Gmail_search_threads', 'mcp__claude_ai_Claude_Docs__read']) assert.ok(isConnectorTool(n), n);
  for (const n of ['mcp__workspace-mcp__workspace_api', 'workspace_api', 'Bash', 'my_claude_ai_tool', 'grep -r mcp__claude_ai_ .', 'cat docs/mcp__claude_ai_Gmail__x.md', undefined]) {
    assert.ok(!isConnectorTool(n), String(n));
  }
});

test('connector traces come from offered tools and the connected list, each reported once', () => {
  const dir = tmp();
  const seen = new Map();
  assert.deepEqual(connectorTraces(dir, claude, seen), []);
  session(dir, 'repo-a/s1.jsonl', offered('mcp__claude_ai_Claude_Docs__read', 'mcp__workspace-mcp__workspace_api'));
  session(dir, 'repo-a/s1/subagents/agent-1.jsonl', offered('mcp__claude_ai_Gmail__search_threads'));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'u', claudeAiMcpEverConnected: ['claude.ai Claude Docs'] }));
  assert.deepEqual(connectorTraces(dir, claude, seen), [
    'connected: claude.ai Claude Docs',
    'mcp__claude_ai_Claude_Docs__read',
    'mcp__claude_ai_Gmail__search_threads',
  ]);
  assert.deepEqual(connectorTraces(dir, claude, seen), [], 'nothing new since the last check');
  session(dir, 'repo-b/s2.jsonl', offered('mcp__workspace-mcp__workspace_api'));
  assert.deepEqual(connectorTraces(dir, claude, seen), []);
  session(dir, 'repo-a/s1.jsonl', offered('mcp__claude_ai_Slack__send'));
  assert.deepEqual(connectorTraces(dir, claude, seen), ['mcp__claude_ai_Slack__send'], 'only the appended record');
});

test('only offered and called tool records count, never text that mentions a connector', () => {
  const dir = tmp();
  const mention = 'grep -r mcp__claude_ai_Gmail__search_threads .';
  const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: mention } }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', content: 'mcp__claude_ai_Slack__send' }] } };
  const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'mcp__claude_ai_Slack__send' }] } };
  session(dir, 'r/s.jsonl', [bash, result, text].map((r) => JSON.stringify(r) + '\n').join('') + 'not json mcp__claude_ai_X__y\n');
  assert.deepEqual(connectorTraces(dir, claude, new Map()), []);
  const called = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude_ai_Gmail__search_threads', input: {} }] } };
  session(dir, 'r/s.jsonl', JSON.stringify(called) + '\n');
  assert.deepEqual(connectorTraces(dir, claude, new Map()), ['mcp__claude_ai_Gmail__search_threads']);
});

test('a rewritten (shorter) session file is scanned again', () => {
  const dir = tmp();
  const seen = new Map();
  const file = session(dir, 'r/s.jsonl', offered('mcp__workspace-mcp__workspace_api').repeat(3));
  assert.deepEqual(connectorTraces(dir, claude, seen), []);
  fs.writeFileSync(file, offered('mcp__claude_ai_Gmail__search_threads'));
  assert.deepEqual(connectorTraces(dir, claude, seen), ['mcp__claude_ai_Gmail__search_threads']);
});

test('a record still being written is read once complete', () => {
  const dir = tmp();
  const seen = new Map();
  const line = offered('mcp__claude_ai_Gmail__search_threads');
  const file = session(dir, 'r/s.jsonl', line.slice(0, 40));
  assert.deepEqual(connectorTraces(dir, claude, seen), []);
  fs.appendFileSync(file, line.slice(40));
  assert.deepEqual(connectorTraces(dir, claude, seen), ['mcp__claude_ai_Gmail__search_threads']);
});

test('connector calls are found in transcript blocks and live tool events', () => {
  const messages = [
    { role: 'assistant', blocks: [{ type: 'tool_use', name: 'workspace_api' }, { type: 'tool_use', name: 'claude_ai_Gmail_search_threads' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'mcp__claude_ai_Slack__send' }] },
  ];
  const events = new Map([
    ['t1', { toolName: 'claude_ai_Claude_Docs_read', title: 'mcp__claude_ai_Claude_Docs__read' }],
    ['t2', { toolName: 'Bash', title: 'grep -r mcp__claude_ai_ .' }],
  ]);
  assert.deepEqual(connectorCalls(messages, events).sort(), ['claude_ai_Claude_Docs_read', 'claude_ai_Gmail_search_threads', 'mcp__claude_ai_Claude_Docs__read']);
  assert.deepEqual(connectorCalls([], undefined), []);
});

test('checkConnectors taints and records a task-run; a control is tainted but not recorded', () => {
  const dir = tmp();
  const isolation = { dir, spec: claude, connectors: [], scanned: new Map() };
  const clean = { task: 'spec-section', harness: 'current', run: 1, pass: true, detail: 'ok' };
  assert.deepEqual(checkConnectors(isolation, clean), []);
  assert.equal(clean.pass, true);

  session(dir, 'r/s.jsonl', offered('mcp__claude_ai_Claude_Docs__read'));
  const offeredRun = { task: 'spec-section', harness: 'current', run: 2, pass: true, detail: 'ok' };
  checkConnectors(isolation, offeredRun);
  assert.equal(offeredRun.pass, false);
  assert.match(offeredRun.detail, /^claude\.ai connectors loaded \(mcp__claude_ai_Claude_Docs__read\); ok/);
  assert.deepEqual(isolation.connectors, [{ task: 'spec-section', harness: 'current', run: 2, tools: ['mcp__claude_ai_Claude_Docs__read'] }]);

  assert.deepEqual(offeredRun.connectorOffered, ['mcp__claude_ai_Claude_Docs__read']);
  assert.equal(offeredRun.connectorCalled, undefined);

  const called = { task: 'claude-ai-connector-called:control', harness: 'current', run: 1, pass: true, control: 'connector-called', connectorCalled: ['claude_ai_Gmail_search_threads'] };
  checkIsolation(isolation, called);
  assert.deepEqual(called.connectorTools, ['claude_ai_Gmail_search_threads']);
  assert.equal(called.connectorOffered, undefined, 'already-scanned records are not reported again');
  assert.equal(called.pass, false);
  assert.equal(isolation.connectors.length, 1);
  assert.ok(controlHeld(called));
});

test('each connector control proves its own detection path', () => {
  const controls = mockControls([]).filter((c) => c.control.startsWith('connector-'));
  assert.deepEqual(controls.map((c) => [c.control, c.mockConnector]), [['connector-offered', 'offered'], ['connector-called', 'called']]);
  assert.ok(controlHeld({ control: 'connector-offered', connectorOffered: ['x'] }));
  assert.ok(!controlHeld({ control: 'connector-offered', connectorCalled: ['x'] }), 'the call path must not stand in for the record scan');
  assert.ok(controlHeld({ control: 'connector-called', connectorCalled: ['x'] }));
  assert.ok(!controlHeld({ control: 'connector-called', connectorOffered: ['x'] }), 'the record scan must not stand in for the call path');
  assert.ok(!controlHeld({ control: 'connector-called', pass: true }));
  assert.ok(!controlHeld({ control: 'fail', pass: false, connectorTools: ['claude_ai_x_y'] }));
});

test('the report records the opt-out and fails loudly when connectors got through', () => {
  const base = { provider: 'claude-code', createdAt: 'now', n: 1, harness: ['current'], tasks: ['spec-section'], versions: {}, results: [], summary: {}, isolation: { ok: true, leaks: [] } };
  const env = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CONFIG_DIR: '/x' };
  const good = connectorReport(env, []);
  assert.deepEqual(good, { optOut: 'false', ok: true, seen: [] });
  assert.match(renderMarkdown({ ...base, connectors: good }), /claude\.ai connectors: none seen \(ENABLE_CLAUDEAI_MCP_SERVERS=false\)/);
  const bad = connectorReport(env, [{ task: 'spec-section', harness: 'current', run: 1, tools: ['mcp__claude_ai_Claude_Docs__read'] }]);
  assert.equal(bad.ok, false);
  const md = renderMarkdown({ ...base, connectors: bad });
  assert.match(md, /## claude\.ai connectors: FAILED/);
  assert.match(md, /- current spec-section#1: mcp__claude_ai_Claude_Docs__read/);
  assert.doesNotMatch(renderMarkdown(base), /claude\.ai connectors/);
});

test('a task-run that saw connectors, offered or called, is never cached', () => {
  const isolation = { dir: tmp(), spec: claude, connectors: [], scanned: new Map() };
  const clean = { task: 'spec-section', harness: '3.12', run: 1, pass: true };
  checkConnectors(isolation, clean);
  assert.ok(cacheable(clean));
  session(isolation.dir, 'r/s.jsonl', offered('mcp__claude_ai_Claude_Docs__read'));
  const offeredOnly = { task: 'spec-section', harness: '3.12', run: 2, pass: true };
  checkConnectors(isolation, offeredOnly);
  assert.equal(offeredOnly.connectorCalled, undefined);
  assert.ok(!cacheable(offeredOnly), 'offered-only evidence must block caching');
  const calledOnly = { task: 'spec-section', harness: '3.12', run: 3, pass: true, connectorCalled: ['claude_ai_x_y'] };
  checkConnectors(isolation, calledOnly);
  assert.ok(!cacheable(calledOnly));
  assert.ok(!cacheable({ isolationLeaks: ['skills/synced/dev'] }));
  assert.ok(!cacheable({ error: 'boom' }));
});
