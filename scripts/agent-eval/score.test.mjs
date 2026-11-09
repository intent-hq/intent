import assert from 'node:assert/strict';
import test from 'node:test';

import { helpCalls, namespaces, scoreTranscript } from './lib/score.mjs';

let seq = 0;
const use = (code, name = 'workspace_api') => {
  const id = `t${++seq}`;
  return { use: { type: 'tool_use', id: `b${seq}`, name, toolCallId: id, input: { code } }, id };
};
const result = (id, output, isError) => ({ type: 'tool_result', tool_use_id: id, output, is_error: isError });
const call = (code, output, isError = false) => {
  const u = use(code);
  return [u.use, result(u.id, output, isError)];
};
const user = (text = 'go') => ({ role: 'user', blocks: [{ type: 'text', text }] });
const assistant = (...blocks) => ({ role: 'assistant', blocks: blocks.flat() });

test('a failed call retried successfully in the same namespace is recovered', () => {
  const s = scoreTranscript([
    user(),
    assistant(call('return ws.note.get("spec")', 'Error: Error: not a function', true), call('return ws.note.read("spec")', 'ok')),
  ]);
  assert.deepEqual(
    { wsErrors: s.wsErrors, unknownMethod: s.unknownMethod, unrecovered: s.unrecovered, wsCalls: s.wsCalls },
    { wsErrors: 1, unknownMethod: 1, unrecovered: 0, wsCalls: 2 },
  );
});

test('a success in another namespace does not recover the error', () => {
  const s = scoreTranscript([
    user(),
    assistant(call('await ws.git.roots()', 'ws.git.roots is not a function', true), call('await ws.note.read("x")', 'ok')),
  ]);
  assert.equal(s.unrecovered, 1);
});

test('a retry in the next turn does not recover the error', () => {
  const s = scoreTranscript([
    user(),
    assistant(call('await ws.note.add()', 'Usage: ws.note.add(id, { content })', true)),
    user('again'),
    assistant(call('await ws.note.add("spec", { content: "x" })', 'ok')),
  ]);
  assert.deepEqual({ turns: s.turns, wsErrors: s.wsErrors, unknownMethod: s.unknownMethod, unrecovered: s.unrecovered }, {
    turns: 2,
    wsErrors: 1,
    unknownMethod: 0,
    unrecovered: 1,
  });
});

test('stored rows flag errors as 1 and nest codex output under result.content', () => {
  const u = use('ws.agent.sendMessage("a", "b")');
  const codex = { result: { content: [{ type: 'text', text: 'Error: Error: not a function' }] }, error: null };
  const s = scoreTranscript([user(), assistant(u.use, result(u.id, codex, 1))]);
  assert.deepEqual({ wsErrors: s.wsErrors, unknownMethod: s.unknownMethod, unrecovered: s.unrecovered }, {
    wsErrors: 1,
    unknownMethod: 1,
    unrecovered: 1,
  });
});

test('errors from other tools are not workspace_api errors', () => {
  const u = use('ls', 'bash');
  const s = scoreTranscript([user(), assistant(u.use, result(u.id, 'not a function', true))]);
  assert.deepEqual({ toolCalls: s.toolCalls, wsCalls: s.wsCalls, wsErrors: s.wsErrors }, { toolCalls: 1, wsCalls: 0, wsErrors: 0 });
});

test('the ACP title identifies workspace_api when the name is a provider alias', () => {
  const block = { type: 'tool_use', name: 'mcp tool', toolCallId: 'x1', input: { code: 'ws.help("note")', _acpTitle: 'mcp__workspace-mcp__workspace_api' } };
  const s = scoreTranscript([user(), assistant(block, result('x1', 'docs', false))]);
  assert.deepEqual({ wsCalls: s.wsCalls, helpCalls: s.helpCalls }, { wsCalls: 1, helpCalls: 1 });
});

test('ws.help inside string literals is not a call', () => {
  assert.equal(helpCalls('await ws.help("pr"); const s = "ws.help(x)"; ws.help ( )'), 2);
  assert.equal(helpCalls('myws.help(); x.ws.help()'), 0);
});

test('namespaces ignore names quoted in strings and ws.help', () => {
  assert.deepEqual([...namespaces('ws.help("note"); ws.agent.list(); "ws.pr.monitor"')], ['agent']);
});

test('a failed call with no ws.* namespace is recovered by any later success', () => {
  const s = scoreTranscript([user(), assistant(call('throw new Error("x")', 'x', true), call('return ws.note.list()', 'ok'))]);
  assert.equal(s.unrecovered, 0);
});

test('a tool_use with only metadata.status counts as an error without unknown-method text', () => {
  const failed = { ...use('ws.note.get("spec")').use, metadata: { status: 'error' } };
  const ok = { ...use('ws.note.read("spec")').use, metadata: { status: 'completed' } };
  const s = scoreTranscript([user(), assistant(failed, ok)]);
  assert.deepEqual({ wsErrors: s.wsErrors, unknownMethod: s.unknownMethod, unrecovered: s.unrecovered }, { wsErrors: 1, unknownMethod: 0, unrecovered: 0 });
});

test('live tool events supply the error text when no tool_result was stored', () => {
  const u = use('ws.git.roots()');
  const failed = { ...u.use, metadata: { status: 'error' } };
  const toolEvents = new Map([[u.id, { status: 'error', output: 'ws.git.roots is not a function. Did you mean `ws.git.listRoots`?' }]]);
  const s = scoreTranscript([user(), assistant(failed)], { toolEvents });
  assert.deepEqual({ wsErrors: s.wsErrors, unknownMethod: s.unknownMethod, unrecovered: s.unrecovered }, { wsErrors: 1, unknownMethod: 1, unrecovered: 1 });
});

test('a started call with no outcome is neither an error nor a recovery', () => {
  const pending = { ...use('ws.note.read("spec")').use, metadata: { status: 'started' } };
  const s = scoreTranscript([user(), assistant(call('ws.note.get("x")', 'not a function', true), pending)]);
  assert.deepEqual({ wsErrors: s.wsErrors, unrecovered: s.unrecovered }, { wsErrors: 1, unrecovered: 1 });
});
