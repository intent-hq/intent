// Eval task set. Prompts are phrased like a user and never name ws.* methods.
// Each checker reads workspace state only (files, notes, hooks, agents, git).
// `mock` is the scripted solution the MOCK_AGENT smoke runs through the real
// workspace_api tool, so CI proves every checker can pass; `mockControl` is a
// scripted non-solution the smoke runs too, so CI proves the checker fails when
// the agent does not do the task. `allowPending` names waits that legitimately
// outlive the task (e.g. a reminder hook). `afterFirstTurn` resets state the
// runner's trivial first turn changed before the task prompt is sent.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_AGENTS_MD = `# Repository rules

- Whenever you create a new file in this repository, also add its path
  (relative to the repository root) as a new line in \`MANIFEST.txt\`.
  Create \`MANIFEST.txt\` if it does not exist.
`;

const README = ['# Docs site', '', 'Static docs for the project.', '', 'Build with make.', '', 'Owner: docs team.'].join('\n') + '\n';
export const FIXTURE_SPEC = '# Plan\n\nGoal: ship the docs refresh by 2026-12-01.\n';
const CODE_WORD = 'PELICAN-42';
/** The runner's trivial first turn; real agents title the workspace on it. */
export const TRIVIAL_PROMPT = 'Reply with just the word: ready';

/** The fixture repository every task-run starts from. */
export function createFixtureRepo(dir) {
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), FIXTURE_AGENTS_MD);
  fs.writeFileSync(path.join(dir, 'README.md'), README);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'docs-site', version: '3.14.15', private: true }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'utils', 'format.js'), 'export const format = (s) => s.trim();\n');
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', env });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Agent Eval', '-c', 'user.email=agent-eval@example.invalid', 'commit', '-qm', 'Initial fixture');
}

const read = (ctx, rel) => {
  try {
    return fs.readFileSync(path.join(ctx.worktree, rel), 'utf8');
  } catch {
    return null;
  }
};
const verdict = (pass, detail) => ({ pass: Boolean(pass), detail });
const spec = async (ctx) => (await ctx.rpc.call('note.get', { noteId: 'spec', workspaceId: ctx.workspaceId })).note.content ?? '';
const agents = async (ctx) => (await ctx.rpc.call('agent.list', { workspaceId: ctx.workspaceId })).agents ?? [];
const fileEquals = (ctx, rel, want) => {
  const got = read(ctx, rel);
  return verdict(got !== null && got.trim() === want, `${rel}=${JSON.stringify(got?.slice(0, 80) ?? null)}`);
};

export const TASKS = [
  {
    id: 'spec-section',
    quick: true,
    prompt: "Add a short 'Risks' section to the spec with two risks of shipping on a Friday. Keep what is already in the spec.",
    async check(ctx) {
      const text = await spec(ctx);
      return verdict(/^#+\s*Risks\b/im.test(text) && text.includes('Goal: ship the docs refresh'), `spec has Risks heading and kept goal`);
    },
    mock: [
      { code: 'return await ws.note.get("spec")' },
      { code: 'return await ws.help("note")' },
      { code: 'await ws.note.add("spec", { content: "## Risks\\n- Fewer reviewers on Friday.\\n- Weekend incidents go unnoticed." }); return "ok"' },
    ],
  },
  {
    id: 'spec-task',
    prompt: 'Add a task to the spec for writing the release notes.',
    async check(ctx) {
      const tasks = (await ctx.rpc.call('note.listTasks', { noteId: 'spec', workspaceId: ctx.workspaceId })).tasks ?? [];
      const text = await spec(ctx);
      const hit = tasks.some((t) => /release notes/i.test(t.text ?? '')) || /(@@@task[\s\S]*?release notes)|(- \[ \].*release notes)/i.test(text);
      return verdict(hit, `${tasks.length} spec tasks`);
    },
    mock: [{ code: 'return await ws.note.add("spec", { content: "@@@task\\n# Write the release notes\\nDraft the notes for the docs refresh.\\n@@@" })' }],
  },
  {
    id: 'status-message',
    prompt: "Update this workspace's status line to say we are drafting the release notes.",
    async check(ctx) {
      const w = (await ctx.rpc.call('workspace.get', { workspaceId: ctx.workspaceId })).workspace;
      return verdict(/release notes/i.test(w.statusMessage ?? ''), `statusMessage=${JSON.stringify(w.statusMessage ?? null)}`);
    },
    mock: [{ code: 'return await ws.workspace.setStatusMessage("Drafting the release notes.")' }],
  },
  {
    id: 'rename-workspace',
    prompt: "Rename this workspace to 'Docs refresh'.",
    // The first-turn naming instruction titles the workspace on the trivial turn
    // ("Agent readiness check"), and ws.workspace.setTitle then skips because a
    // custom title exists, so every run failed. Clear it: the task measures
    // whether the agent renames when asked.
    async afterFirstTurn(ctx) {
      await ctx.rpc.call('workspace.update', { workspaceId: ctx.workspaceId, title: '' });
      const w = (await ctx.rpc.call('workspace.get', { workspaceId: ctx.workspaceId })).workspace;
      if ((w.title ?? '').trim()) throw new Error(`could not clear the first-turn title ${JSON.stringify(w.title)}`);
    },
    async check(ctx) {
      const w = (await ctx.rpc.call('workspace.get', { workspaceId: ctx.workspaceId })).workspace;
      return verdict((w.title ?? '').trim().toLowerCase() === 'docs refresh', `title=${JSON.stringify(w.title)}`);
    },
    mock: [{ code: 'return await ws.workspace.setTitle("Docs refresh")' }],
    mockControl: [{ code: 'return await ws.workspace.details()' }],
  },
  {
    id: 'wait-command',
    prompt: 'Run `sleep 20 && echo EVAL_DONE > build-done.txt` from the repository root as a build step, and tell me when it has finished.',
    check: (ctx) => fileEquals(ctx, 'build-done.txt', 'EVAL_DONE'),
    mock: [
      {
        code: 'const s = await ws.script.create("build", "sleep 1 && echo EVAL_DONE > build-done.txt", "command"); return await ws.script.run(s.id, { timeoutSeconds: 20 })',
      },
    ],
  },
  {
    id: 'reminder',
    quick: true,
    allowPending: ['hooks'],
    prompt: 'Remind me in two hours to check the deploy.',
    async check(ctx) {
      const hooks = (await ctx.rpc.call('hook.list', { workspaceId: ctx.workspaceId })).hooks ?? [];
      const due = hooks
        .map((h) => Date.parse(h.nextRunAt ?? h.runAt ?? h.expiresAt ?? ''))
        .filter((t) => Number.isFinite(t))
        .map((t) => (t - ctx.promptAt) / 60_000);
      return verdict(due.some((m) => m >= 90 && m <= 150), `active hooks due in minutes: ${due.map(Math.round).join(', ') || 'none'}`);
    },
    mock: [
      {
        code: 'return await ws.hook.schedule({ name: "Deploy reminder", delayMs: 7_200_000, ttlMs: 7_800_000, code: "if (!hookState || !hookState.armed) return { dispatch: false, state: { armed: true } }; return { dispatch: true, message: \\"Check the deploy.\\" };" })',
      },
    ],
  },
  {
    id: 'helper-agent',
    prompt: 'Start a helper agent that creates hello.txt containing the word hi, and tell me when it has finished.',
    async check(ctx) {
      const list = await agents(ctx);
      const file = read(ctx, 'hello.txt');
      return verdict(list.length >= 2 && /\bhi\b/i.test(file ?? ''), `${list.length} agents, hello.txt=${JSON.stringify(file)}`);
    },
    mock: [
      {
        code: 'const a = await ws.agent.create("Helper", "EVAL_CHILD: create hello.txt with hi", { provider: "mock" }); await ws.agent.watch(a.id); return a.id',
      },
    ],
  },
  {
    id: 'meeting-note',
    prompt: "Make a note called 'Meeting notes' with three bullet points about the Q3 plan.",
    async check(ctx) {
      const notes = (await ctx.rpc.call('note.list', { workspaceId: ctx.workspaceId })).notes ?? [];
      const note = notes.find((n) => /meeting notes/i.test(n.title ?? ''));
      const bullets = (note?.content ?? '').split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length;
      return verdict(note && bullets >= 3, note ? `${bullets} bullets` : 'no Meeting notes note');
    },
    mock: [{ code: 'return await ws.note.create("Meeting notes", "- Hire two writers.\\n- Ship the docs refresh.\\n- Retire the old site.")' }],
  },
  {
    id: 'sibling-note',
    prompt: "Another workspace for this repository has a note called 'Launch checklist'. Find the code word in it and write only the code word into answer.txt.",
    async setup(ctx) {
      const sibling = await ctx.createWorkspace('Launch prep');
      await ctx.rpc.call('note.create', { workspaceId: sibling.id, title: 'Launch checklist', content: `- Book the room\n- Code word: ${CODE_WORD}\n- Send invites\n` });
    },
    check: (ctx) => fileEquals(ctx, 'answer.txt', CODE_WORD),
    mock: [
      {
        code: 'for (const s of await ws.crossWorkspace.listSiblings()) { const id = s.id ?? s.workspaceId; const n = (await ws.crossWorkspace.listNotes(id)).find((x) => /Launch checklist/.test(x.title)); if (!n) continue; const note = await ws.crossWorkspace.readNote(id, n.id); const word = (note.rawContent ?? note.content).match(/PELICAN-\\d+/)[0]; await ws.file.write("answer.txt", word); return word; } throw new Error("no checklist")',
      },
    ],
  },
  {
    id: 'propose-followup',
    prompt: "Renaming the utils folder to lib is worth doing, but not as part of this work. Suggest it as separate follow-up work for me to approve, and don't do the rename here.",
    async check(ctx) {
      let pending = 0;
      for (const a of await agents(ctx)) {
        const full = (await ctx.rpc.call('agent.get', { agentId: a.id, workspaceId: ctx.workspaceId })).agent;
        pending += full.metadata?.pendingProposals?.length ?? 0;
      }
      const untouched = fs.existsSync(path.join(ctx.worktree, 'utils', 'format.js'));
      return verdict(pending > 0 && untouched, `${pending} pending proposals, utils kept=${untouched}`);
    },
    mock: [{ code: 'return await ws.workspace.proposeSibling({ title: "Rename utils to lib", initialPrompt: "Rename the utils folder to lib and update imports." })' }],
  },
  {
    id: 'ask-choice',
    prompt: 'I need to pick a database for the cache: Postgres or SQLite. Ask me to choose, with a short note on each option, and wait for my answer.',
    async check(ctx) {
      const a = (await ctx.rpc.call('agent.get', { agentId: ctx.agentId, workspaceId: ctx.workspaceId })).agent;
      return verdict(Boolean(a.metadata?.pendingQuestionsMessageId), `pendingQuestionsMessageId=${a.metadata?.pendingQuestionsMessageId ?? null}`);
    },
  },
  {
    id: 'repo-rule',
    quick: true,
    prompt: 'Create docs/hello.md with a one-line greeting.',
    check(ctx) {
      const file = read(ctx, 'docs/hello.md');
      const manifest = (read(ctx, 'MANIFEST.txt') ?? '').split('\n').map((l) => l.trim().replace(/^\.\//, ''));
      return verdict(file?.trim() && manifest.includes('docs/hello.md'), `hello.md=${file !== null}, manifest lists it=${manifest.includes('docs/hello.md')}`);
    },
    mock: [{ code: 'await ws.file.write("docs/hello.md", "Hello from the docs team.\\n"); await ws.file.write("MANIFEST.txt", "docs/hello.md\\n"); return "ok"' }],
  },
  {
    id: 'commit',
    prompt: "Create CHANGELOG.md with the line '0.1.0 - initial release' and commit it.",
    check(ctx) {
      let log = '';
      try {
        log = execFileSync('git', ['-C', ctx.worktree, 'log', '--format=%H', '--name-only', `${ctx.baseCommit}..HEAD`], { encoding: 'utf8' });
      } catch {}
      const committed = log.split('\n').includes('CHANGELOG.md');
      return verdict(committed && /0\.1\.0 - initial release/.test(read(ctx, 'CHANGELOG.md') ?? ''), `committed=${committed}`);
    },
    mock: [
      { code: 'await ws.file.write("CHANGELOG.md", "0.1.0 - initial release\\n"); return await ws.git.commit("docs: add changelog", { files: ["CHANGELOG.md"], userRequested: true })' },
    ],
  },
  {
    id: 'file-answer',
    prompt: 'Which version is in package.json? Write only the version number into version.txt.',
    check: (ctx) => fileEquals(ctx, 'version.txt', '3.14.15'),
    mock: [{ code: 'const p = JSON.parse(await ws.file.read("package.json")); await ws.file.write("version.txt", p.version); return p.version' }],
  },
  {
    id: 'line-count',
    prompt: 'How many lines does README.md have? Write only the number into lines.txt.',
    check: (ctx) => fileEquals(ctx, 'lines.txt', String(README.trimEnd().split('\n').length)),
    mock: [{ code: 'const t = await ws.file.read("README.md"); const n = String(t.trimEnd().split("\\n").length); await ws.file.write("lines.txt", n); return n' }],
  },
  {
    id: 'saved-script',
    prompt: "Set up a saved command called 'serve docs' that runs `python3 -m http.server 8765`, but don't start it.",
    async check(ctx) {
      const scripts = (await ctx.rpc.call('script.list', { workspaceId: ctx.workspaceId, view: 'full' })).scripts ?? [];
      const s = scripts.find((x) => /serve docs/i.test(x.name ?? ''));
      if (!s) return verdict(false, `no 'serve docs' script among ${scripts.length}`);
      const status = await ctx.rpc.call('script.status', { workspaceId: ctx.workspaceId, scriptId: s.id }).catch(() => ({}));
      const running = /running|starting/i.test(String(status.state ?? status.status ?? status.runtime?.state ?? ''));
      return verdict(/http\.server 8765/.test(s.command ?? '') && !running, `command=${JSON.stringify(s.command)}, running=${running}`);
    },
    mock: [{ code: 'return await ws.script.create("serve docs", "python3 -m http.server 8765", "service")' }],
  },
  {
    id: 'spec-comment',
    prompt: "Leave a comment on the spec's goal line asking whether the date is fixed.",
    async check(ctx) {
      const r = await ctx.rpc.call('comment.list', { noteId: 'spec', workspaceId: ctx.workspaceId });
      return verdict((r.totalThreads ?? r.threads?.length ?? 0) > 0, `${r.totalThreads ?? 0} threads`);
    },
    mock: [{ code: 'return await ws.comment.add("spec", { searchContext: "Goal: ship the docs refresh by 2026-12-01.", commentTarget: "2026-12-01", comment: "Is this date fixed?" })' }],
  },
  {
    id: 'remote-subagent',
    prompt: 'Start a sub-agent on one of my remote machines, using the model sonnet, to summarize README.md.',
    async check(ctx) {
      const extra = (await agents(ctx)).filter((a) => a.id !== ctx.agentId);
      const reply = ctx.lastReply ?? '';
      const honest = /remote|machine/i.test(reply) && /(no|not|none|unavailable|isn't|aren't|cannot|can't)\b/i.test(reply);
      return verdict(extra.length === 0 && honest, `${extra.length} extra agents; reply says no remote machine=${honest}`);
    },
    mock: [{ code: 'return await ws.agent.list()' }],
    mockReply: 'No remote machine is available, so I did not start the sub-agent.',
  },
];

export const MOCK_CHILD = { match: 'EVAL_CHILD: create hello.txt', steps: [{ code: 'return await ws.file.write("hello.txt", "hi\\n")' }], reply: 'Created hello.txt.' };

/** Like a real agent, the mock titles the workspace on the trivial first turn. */
export const MOCK_FIRST_TURN = { match: TRIVIAL_PROMPT, steps: [{ code: 'return await ws.workspace.setTitle("Agent readiness check")' }], reply: 'ready' };

const CONTROL_SUFFIX = ' [eval control]';

/**
 * Smoke-only negative controls; each must come out the way `expect` says:
 * - `fail`: a task's `mockControl` non-solution, so its checker must fail;
 * - `leak`: the mock CLI syncs account skills and plugins into its config dir
 *   mid-run, the way Claude Code does, so the isolation check must flag it;
 * - `connector-offered`: the mock's session record offers a claude.ai connector
 *   tool it never calls, so the session-record scan alone must flag it;
 * - `connector-called`: the mock calls one with no session record, so the
 *   tool-call check alone must flag it.
 */
export function mockControls(tasks) {
  const controls = tasks
    .filter((t) => t.mockControl)
    .map((t) => ({ ...t, id: `${t.id}:control`, prompt: t.prompt + CONTROL_SUFFIX, mock: t.mockControl, control: 'fail' }));
  controls.push({
    id: 'config-leak:control',
    control: 'leak',
    prompt: 'Reply with just the word: done' + CONTROL_SUFFIX,
    check: () => verdict(true, 'no state to check'),
    mock: [],
    mockSyncSkills: true,
  });
  for (const how of ['offered', 'called']) {
    controls.push({
      id: `claude-ai-connector-${how}:control`,
      control: `connector-${how}`,
      prompt: `Reply with just the word: ${how}` + CONTROL_SUFFIX,
      check: () => verdict(true, 'no state to check'),
      mock: [],
      mockConnector: how,
    });
  }
  return controls;
}

/** Did a control come out as expected? */
export function controlHeld(result) {
  if (result.error || result.timedOut) return false;
  if (result.control === 'fail') return !result.pass && !result.isolationLeaks?.length && !result.connectorTools?.length;
  if (result.control === 'connector-offered') return Boolean(result.connectorOffered?.length) && !result.connectorCalled?.length && !result.isolationLeaks?.length;
  if (result.control === 'connector-called') return Boolean(result.connectorCalled?.length) && !result.connectorOffered?.length && !result.isolationLeaks?.length;
  if (result.control === 'leak') return Boolean(result.isolationLeaks?.length);
  return false;
}

export function selectTasks({ ids, quick }) {
  if (ids?.length) {
    const unknown = ids.filter((id) => !TASKS.some((t) => t.id === id));
    if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(', ')}`);
    return TASKS.filter((t) => ids.includes(t.id));
  }
  return quick ? TASKS.filter((t) => t.quick) : TASKS;
}

/** Controls first: a control prompt contains its task's prompt. */
export function mockSolutions(tasks) {
  const ordered = [...tasks.filter((t) => t.control), ...tasks.filter((t) => !t.control)];
  return [
    MOCK_CHILD,
    MOCK_FIRST_TURN,
    ...ordered
      .filter((t) => t.mock)
      .map((t) => ({
        match: t.prompt,
        steps: t.mock,
        reply: t.mockReply ?? 'Done.',
        ...(t.mockSyncSkills ? { syncSkills: true } : {}),
        ...(t.mockConnector ? { connector: t.mockConnector } : {}),
      })),
  ];
}
