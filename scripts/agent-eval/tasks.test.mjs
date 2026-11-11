import assert from 'node:assert/strict';
import test from 'node:test';

import { TASKS, TRIVIAL_PROMPT, controlHeld, mockControls, mockSolutions } from './tasks.mjs';

const rename = TASKS.find((t) => t.id === 'rename-workspace');

/** Just enough of the daemon for the rename task: setTitle skips once titled. */
function fakeDaemon(title) {
  const ws = { id: 'w1', title };
  const rpc = {
    async call(method, params) {
      if (method === 'workspace.get') return { workspace: { ...ws } };
      if (method === 'workspace.update') {
        if ('title' in params) ws.title = params.title;
        return { workspace: { ...ws } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const setTitle = (t) => {
    if (ws.title.trim() && ws.title !== ws.id) return { skipped: true };
    ws.title = t;
    return { ok: true };
  };
  return { ctx: { rpc, workspaceId: 'w1' }, setTitle };
}

test('rename-workspace passes when the agent renames after a first-turn title', async () => {
  const { ctx, setTitle } = fakeDaemon('Agent readiness check');
  await rename.afterFirstTurn(ctx);
  assert.equal(setTitle('Docs refresh').ok, true);
  assert.equal((await rename.check(ctx)).pass, true);
});

test('rename-workspace fails when the agent does not rename', async () => {
  const { ctx } = fakeDaemon('Agent readiness check');
  await rename.afterFirstTurn(ctx);
  assert.deepEqual(await rename.check(ctx), { pass: false, detail: 'title=""' });
});

test('without the reset, a first-turn title makes the rename skip (the old false FAIL)', async () => {
  const { ctx, setTitle } = fakeDaemon('Agent readiness check');
  assert.equal(setTitle('Docs refresh').skipped, true);
  assert.equal((await rename.check(ctx)).pass, false);
});

test('mock solutions: the first turn titles the workspace and controls match before their tasks', () => {
  const tasks = TASKS.filter((t) => t.mock);
  const all = [...tasks, ...mockControls(tasks)];
  const solutions = mockSolutions(all);
  const pick = (text) => solutions.find((s) => text.includes(s.match));
  assert.match(pick(`harness preamble\n${TRIVIAL_PROMPT}`).steps[0].code, /setTitle\("Agent readiness check"\)/);
  const control = mockControls(tasks).find((c) => c.id === 'rename-workspace:control');
  assert.equal(pick(control.prompt).steps, rename.mockControl);
  assert.equal(pick(rename.prompt).steps, rename.mock);
  assert.equal(pick(mockControls(tasks).find((c) => c.control === 'leak').prompt).syncSkills, true);
});

test('controlHeld: fail controls must fail without a leak, leak controls must leak', () => {
  assert.equal(controlHeld({ control: 'fail', pass: false }), true);
  assert.equal(controlHeld({ control: 'fail', pass: true }), false);
  assert.equal(controlHeld({ control: 'fail', pass: false, error: 'boom' }), false);
  assert.equal(controlHeld({ control: 'fail', pass: false, timedOut: true }), false);
  assert.equal(controlHeld({ control: 'leak', pass: false, isolationLeaks: ['skills/synced/x'] }), true);
  assert.equal(controlHeld({ control: 'leak', pass: true }), false);
});
