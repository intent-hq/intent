'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RESPONSE = {
  duplicates: [
    { number: 101, confidence: 'high', reason: 'Same crash' },
    { number: 999, confidence: 'high', reason: 'Not a search candidate' },
  ],
  component: 'intentd', type: 'bug', priority: 'High', effort: 'Medium', security: false,
  reasons: { component: 'Daemon stack', type: 'Crashes', priority: 'Stops work', effort: 'Several files' },
};

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = `#!${process.execPath}\n${fs.readFileSync(path.join(__dirname, 'mock-triage-command.cjs'), 'utf8')}`;
  for (const executable of ['gh', 'codex']) {
    fs.writeFileSync(path.join(dir, executable), source, { mode: 0o755 });
  }
  const settings = {
    response: JSON.stringify(RESPONSE),
    issue: { number: 7, title: 'Daemon startup panic', body: 'Crashes during startup.', state: 'OPEN', labels: [{ name: 'needs-triage' }], url: 'https://github.com/test/repo/issues/7' },
    candidates: [{ number: 101, title: 'Startup panic', state: 'OPEN', body: 'Crashes on startup.', labels: [] }],
    context: {
      issue: { id: 'I_7', issueType: null, issueFieldValues: { nodes: [] } },
      issueTypes: { nodes: ['Bug', 'Feature', 'Task'].map((name) => ({ id: `IT_${name}`, name, isEnabled: true })) },
      issueFields: { nodes: [
        { id: 'IF_priority', name: 'Priority', options: ['Urgent', 'High', 'Medium', 'Low'].map((name) => ({ id: `P_${name}`, name })) },
        { id: 'IF_effort', name: 'Effort', options: ['Low', 'Medium', 'High'].map((name) => ({ id: `E_${name}`, name })) },
      ] },
    },
    ...overrides,
  };
  const env = {
    ...process.env, NODE_OPTIONS: '', PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: 'gh-token-canary', GITHUB_TOKEN: 'github-token-canary',
    GH_ENTERPRISE_TOKEN: 'enterprise-token-canary', ACTIONS_RUNTIME_TOKEN: 'actions-token-canary',
    AUGMENT_SESSION_AUTH: 'augment-auth-canary', OPENAI_API_KEY: 'test-openai-key',
    TRIAGE_REPO: 'test/repo',
  };
  const update = () => fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(settings));
  const calls = () => fs.existsSync(path.join(dir, 'calls.jsonl'))
    ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  update();
  return {
    dir, settings, env, update, calls,
    clear: () => fs.rmSync(path.join(dir, 'calls.jsonl'), { force: true }),
    run: (args = [], extraEnv = {}) => {
      update();
      return spawnSync(process.execPath, [path.join(__dirname, '..', 'agentic-triage.js'), ...args, '7'], {
        env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000,
      });
    },
  };
}

const writes = (calls) => calls.filter((c) => c.command === 'gh' && (
  (c.args[0] === 'issue' && ['edit', 'comment'].includes(c.args[1])) ||
  c.args.some((arg) => arg.startsWith('query=mutation')) || c.input.includes('"query":"mutation')
));

module.exports = { fixture, RESPONSE, writes };
