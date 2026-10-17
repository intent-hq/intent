'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, RESPONSE, writes } = require('./fixtures/cli-fixture.cjs');
const { AGENTIC_MARKER } = require('./agentic-triage.js');
const { CODEX_VERSION, CODEX_MODEL, CODEX_CONFIG, RESPONSE_SCHEMA } = require('./codex-runner.js');

const root = path.resolve(__dirname, '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/issue-triage.yml'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

// Extract the workflow's literal scalars and shell blocks, without a runtime
// YAML dependency. Unsupported syntax fails these focused contract tests.
function section(source, key, indent) {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line.startsWith(prefix));
  assert.notEqual(start, -1, `Missing ${key}`);
  const value = lines[start].slice(prefix.length).trim();
  if (value && !['|', '>-'].includes(value)) return value.replace(/^(['"])(.*)\1$/, '$2');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(indent + 2))) break;
    body.push(line.slice(indent + 2));
  }
  return value === '>-' ? body.join(' ').trim() : body.join('\n').trimEnd();
}

const job = section(workflow, 'agentic-triage', 2);
const steps = section(job, 'steps', 0).split(/(?=^- )/m).filter((s) => s.trim());
const step = (id) => {
  const found = steps.find((s) => new RegExp(`^  id: ${id}$`, 'm').test(s));
  assert.ok(found, `Missing workflow step ${id}`);
  return found;
};
const field = (s, key) => section(s, key, 2);
const envEntries = (s, indent = 2) => Object.fromEntries(section(s, 'env', indent).split('\n').map((line) => {
  const pair = line.match(/^([A-Z_]+): (.+)$/);
  assert.ok(pair, `Unsupported environment entry: ${line}`);
  return [pair[1], pair[2].replace(/^(['"])(.*)\1$/, '$2')];
}));

function evaluate(expression, context, success = true) {
  const values = { ...context, success: () => success, always: () => true, cancelled: () => false };
  return Function(...Object.keys(values), `return (${expression});`)(...Object.values(values));
}
const render = (value, context) => value.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => String(evaluate(expression, context)));
const enabled = (s, context, success) => {
  if (!/^  if:/m.test(s)) return success;
  const condition = field(s, 'if');
  return (/(?:success|always|cancelled|failure)\(/.test(condition) || success) && evaluate(condition, context, success);
};

function runWorkflow(t, { key = 'fake-api-key', dryRun = false, modelOutcome = 'success', response = JSON.stringify(RESPONSE), settings, issueNumber = '7', stale = false, afterModel } = {}) {
  const f = fixture(t, settings);
  const temp = path.join(f.dir, 'runner temp');
  fs.mkdirSync(temp);
  const context = {
    github: { repository: 'test/repo', token: 'workflow-gh-token', event_name: 'workflow_dispatch', event: { issue: {} } },
    inputs: { issue_number: issueNumber, dry_run: dryRun },
    runner: { temp }, secrets: { OPENAI_API_KEY: key }, env: {}, steps: {},
  };
  context.env = Object.fromEntries(Object.entries(envEntries(job, 0)).map(([k, v]) => [k, render(v, context)]));
  const bundle = path.join(temp, 'issue-triage-codex');
  if (stale) {
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'response.json'), JSON.stringify(RESPONSE));
  }
  let success = true;
  let modelCalls = 0;
  const output = [];
  for (const id of ['prepare', 'gate', 'codex', 'apply', 'warn', 'cleanup']) {
    const s = step(id);
    const result = context.steps[id] = { outcome: 'skipped', conclusion: 'skipped', outputs: {} };
    if (!enabled(s, context, success)) continue;
    const env = { PATH: f.env.PATH, NODE_OPTIONS: '', ...context.env };
    if (/^  env:/m.test(s)) {
      Object.assign(env, Object.fromEntries(Object.entries(envEntries(s)).map(([k, v]) => [k, render(v, context)])));
    }
    assert.equal(env.OPENAI_API_KEY || '', '', `${id} must not receive the API key in its environment`);
    if (id === 'codex') {
      modelCalls++;
      assert.deepEqual(writes(f.calls()), [], 'prepare must not write to GitHub');
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'CODEX_API_KEY']) {
        assert.equal(env[name], '', `${name} must not reach the model`);
      }
      assert.equal(fs.readFileSync(path.join(bundle, 'codex-home/config.toml'), 'utf8'), CODEX_CONFIG);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bundle, 'schema.json'), 'utf8')), RESPONSE_SCHEMA);
      assert.equal(JSON.parse(fs.readFileSync(path.join(bundle, 'request.json'), 'utf8')).dryRun, dryRun);
      const inputs = section(s, 'with', 2);
      assert.equal(render(section(inputs, 'openai-api-key', 0), context), key);
      for (const [name, file] of Object.entries({ 'prompt-file': 'prompt.txt', 'output-schema-file': 'schema.json', 'output-file': 'response.json', 'codex-home': 'codex-home', 'working-directory': 'work' })) {
        assert.equal(render(section(inputs, name, 0), context), path.join(bundle, file));
      }
      if (response !== null) fs.writeFileSync(path.join(bundle, 'response.json'), response);
      result.outcome = modelOutcome;
      if (afterModel) { afterModel(f); f.update(); }
    } else {
      const outputFile = path.join(temp, `${id}.output`);
      const envFile = path.join(temp, `${id}.env`);
      const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', field(s, 'run')], {
        cwd: root, env: { ...env, GITHUB_OUTPUT: outputFile, GITHUB_ENV: envFile }, encoding: 'utf8', timeout: 30000,
      });
      assert.ifError(run.error);
      output.push(run.stdout, run.stderr);
      result.outcome = run.status === 0 ? 'success' : 'failure';
      if (fs.existsSync(outputFile)) {
        result.outputs = Object.fromEntries(fs.readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('=')));
      }
      if (fs.existsSync(envFile)) {
        Object.assign(context.env, Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('='))));
      }
    }
    result.conclusion = result.outcome;
    if (result.outcome === 'failure') success = false;
  }
  assert.equal(context.steps.cleanup.outcome, 'success', output.join('\n'));
  assert.equal(fs.existsSync(bundle), false, 'bundle must be removed even on failure');
  assert.ok(f.calls().filter((c) => c.command === 'gh').every((c) => c.githubToken === 'workflow-gh-token'));
  assert.ok(!f.calls().some((c) => c.command === 'codex'), 'prepare/apply must never launch a CLI directly');
  return { f, modelCalls, steps: context.steps, output: output.join('\n') };
}

test('workflow: event routing, manual dry-run default, concurrency and fail-soft behavior remain intact', () => {
  assert.match(workflow, /types: \[opened, edited, reopened, labeled\]/);
  assert.match(workflow, /issue_comment:\n    types: \[created\]/);
  assert.match(section(section(section(workflow, 'on', 0), 'workflow_dispatch', 0), 'inputs', 0), /dry_run:[\s\S]*?default: true/);
  assert.equal(section(workflow, 'concurrency', 0), 'group: issue-triage-${{ github.event.issue.number || inputs.issue_number }}\ncancel-in-progress: false');
  assert.equal(section(job, 'needs', 0), 'triage');
  assert.equal(section(job, 'continue-on-error', 0), 'true');
  assert.ok(Number(section(job, 'timeout-minutes', 0)) <= 15);
  for (const [event, action, expected] of [['issues', 'opened', true], ['issues', 'edited', false], ['issues', 'reopened', false], ['issues', 'labeled', false], ['issue_comment', 'created', false], ['workflow_dispatch', undefined, true]]) {
    assert.equal(evaluate(section(job, 'if', 0), { github: { event_name: event, event: { action } } }), expected);
  }
});

test('workflow: pinned Action and isolated files keep model credentials out of checkout and GitHub steps', () => {
  assert.doesNotMatch(job, /auggie|AUGMENT_SESSION_AUTH/i);
  const checkout = steps.find((s) => s.includes('uses: actions/checkout@'));
  assert.equal(section(field(checkout, 'with'), 'persist-credentials', 0), 'false');
  assert.equal(section(field(checkout, 'with'), 'submodules', 0), 'false');
  const action = step('codex');
  assert.equal(field(action, 'uses'), 'openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e');
  assert.equal(steps.filter((s) => s.includes('uses: openai/codex-action@')).length, 1);
  const inputs = field(action, 'with');
  for (const [name, expected] of Object.entries({ 'codex-version': CODEX_VERSION, model: CODEX_MODEL, effort: 'low', sandbox: 'read-only', 'safety-strategy': 'drop-sudo', 'allow-users': '*', 'codex-args': '["--ephemeral","--color","never"]' })) {
    assert.equal(section(inputs, name, 0), expected, name);
  }
  assert.ok(Number(field(action, 'timeout-minutes')) <= 10);
  const env = envEntries(action);
  assert.equal(env.HOME, '${{ env.TRIAGE_CODEX_DIR }}/home');
  assert.equal(env.XDG_CONFIG_HOME, '${{ env.TRIAGE_CODEX_DIR }}/home/.config');
  assert.equal(env.XDG_DATA_HOME, '${{ env.TRIAGE_CODEX_DIR }}/home/.local/share');
  assert.equal(env.CODEX_HOME, '${{ env.TRIAGE_CODEX_DIR }}/codex-home');
  assert.deepEqual(envEntries(step('gate')), { HAS_OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY != '' }}" });
  assert.equal((job.match(/secrets\.OPENAI_API_KEY/g) || []).length, 2, 'only a boolean presence gate and the Action input may reference the key');
  assert.doesNotMatch(section(job, 'env', 0), /TOKEN|API_KEY|runner\./, 'runner context is unavailable in job-level env');
  for (const id of ['prepare', 'cleanup']) {
    assert.equal(envEntries(step(id)).TRIAGE_CODEX_DIR, '${{ runner.temp }}/issue-triage-codex');
  }
  assert.equal(field(step('cleanup'), 'if'), 'always()');
  for (const id of ['prepare', 'gate', 'apply', 'warn', 'cleanup']) {
    assert.doesNotMatch(field(step(id), 'run'), /\$\{\{/, 'event data must not be interpolated into shell code');
  }
});

test('workflow: apply requires successful preparation and model success or an explicit no-model request', () => {
  for (const prepared of ['success', 'failure', 'skipped']) {
    for (const needsModel of ['true', 'false', '']) {
      for (const credential of ['true', 'false', '']) {
        for (const model of ['success', 'failure', 'cancelled', 'skipped']) {
          const context = { steps: { prepare: { outcome: prepared, outputs: { needs_model: needsModel } }, gate: { outputs: { run: credential } }, codex: { outcome: model, conclusion: 'success' } } };
          assert.equal(Boolean(enabled(step('apply'), context, true)), prepared === 'success' && (needsModel === 'false' || (needsModel === 'true' && credential === 'true' && model === 'success')));
          assert.equal(Boolean(enabled(step('codex'), context, true)), prepared === 'success' && needsModel === 'true' && credential === 'true');
          assert.equal(Boolean(enabled(step('apply'), context, false)), false);
        }
      }
    }
  }
});

for (const dryRun of [false, true]) {
  test(`workflow: ${dryRun ? 'dry-run' : 'applying'} handoff uses the saved response`, (t) => {
    const run = runWorkflow(t, { dryRun });
    assert.equal(run.modelCalls, 1);
    assert.equal(run.steps.apply.outcome, 'success', run.output);
    assert.equal(writes(run.f.calls()).length === 0, dryRun);
  });
  test(`workflow: missing credential skips classification with a warning (dry-run=${dryRun})`, (t) => {
    const run = runWorkflow(t, { key: '', dryRun });
    assert.equal(run.steps.prepare.outcome, 'success', run.output);
    assert.match(run.output, /::warning::OPENAI_API_KEY secret is absent/);
    assert.equal(run.modelCalls, 0);
    assert.equal(run.steps.apply.outcome, 'skipped');
    assert.deepEqual(writes(run.f.calls()), []);
  });
  for (const [name, options] of [['failed Action with valid output', { modelOutcome: 'failure' }], ['malformed output', { response: '{invalid' }], ['missing output', { response: null }]]) {
    test(`workflow: ${name} cannot write (dry-run=${dryRun})`, (t) => {
      const run = runWorkflow(t, { ...options, dryRun });
      assert.equal(run.modelCalls, 1);
      assert.equal(run.steps.apply.outcome, options.modelOutcome ? 'skipped' : 'failure');
      assert.match(run.output, /::warning::Codex triage did not complete/);
      assert.deepEqual(writes(run.f.calls()), []);
    });
  }
  test(`workflow: no-model recovery applies without an API key (dry-run=${dryRun})`, (t) => {
    const run = runWorkflow(t, { key: '', dryRun, settings: { trustedComments: AGENTIC_MARKER } });
    assert.equal(run.steps.prepare.outputs.needs_model, 'false');
    assert.equal(run.steps.apply.outcome, 'success', run.output);
    assert.equal(run.modelCalls, 0);
    assert.equal(writes(run.f.calls()).length, dryRun ? 0 : 1);
  });
}

test('workflow: preparation failure cannot reuse stale output and always cleans up', (t) => {
  const run = runWorkflow(t, { stale: true });
  assert.equal(run.steps.prepare.outcome, 'failure');
  assert.equal(run.modelCalls, 0);
  assert.equal(run.steps.apply.outcome, 'skipped');
  assert.deepEqual(writes(run.f.calls()), []);
});

test('workflow: manual input is passed as data, never shell code', (t) => {
  const run = runWorkflow(t, { issueNumber: '7; exit 0 #', dryRun: true });
  assert.equal(run.steps.prepare.outcome, 'failure');
  assert.equal(run.modelCalls, 0);
  assert.deepEqual(run.f.calls(), []);
});

test('workflow: issue changes between model and apply reject the saved response', (t) => {
  const run = runWorkflow(t, { afterModel: (f) => { f.settings.issue.body = 'Edited while Codex was running'; } });
  assert.equal(run.steps.apply.outcome, 'failure');
  assert.match(run.output, /changed since preparation/);
  assert.deepEqual(writes(run.f.calls()), []);
});

test('CI: discovers every triage test and enables the real pinned-CLI isolation gate without credentials', () => {
  const job = section(ci, 'triage-parser-test', 2);
  assert.match(job, new RegExp(`npm install -g @openai/codex@${CODEX_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`));
  assert.match(job, /TRIAGE_TEST_REAL_CODEX: ['"]?1['"]?/);
  assert.match(job, /node --test \.github\/scripts\/issue-triage\/\*\.test\.js/);
  assert.doesNotMatch(job, /secrets\.|github\.token|continue-on-error:/);
});
