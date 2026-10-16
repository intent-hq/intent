// Offline fixtures execute the same inline script that Actions runs (no checkout in the probe).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/runner-route.yml'), 'utf8');
const script = workflow
  .split('          script: |\n')[1]
  .split('\n')
  .map((l) => l.slice(12))
  .join('\n');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runner = (os, arch, busy = false) => ({
  status: 'online',
  busy,
  labels: ['self-hosted', os, arch].map((name) => ({ name })),
});
async function route(fixture = {}) {
  const outputs = {},
    queried = [],
    messages = [];
  const api = {
    listSelfHostedRunnersForOrg: 'org',
    listSelfHostedRunnersForRepo: 'repo',
    listWorkflowRunsForRepo: 'runs',
    listJobsForWorkflowRun: 'jobs',
  };
  const github = {
    rest: { actions: api },
    paginate: async (method, params) => {
      if (
        fixture.error ||
        (fixture.orgError && method === 'org') ||
        params.repo === fixture.unreadable
      )
        throw Error('fixture unavailable');
      if (method === 'org' || method === 'repo')
        return (
          fixture.runners ?? [
            runner('Linux', 'X64'),
            runner('Windows', 'X64'),
            runner('macOS', 'ARM64'),
            runner('Linux', 'ARM64'),
          ]
        );
      if (method === 'runs') {
        queried.push(params.repo);
        return [{ id: 2 }];
      }
      return fixture.jobs ?? [];
    },
  };
  const env = { THRESHOLD: '8', LINUX_SIZE: '8', ...fixture.env };
  await new AsyncFunction('core', 'github', 'context', 'process', script)(
    { setOutput: (k, v) => (outputs[k] = v), info: (m) => messages.push(m) },
    github,
    {
      repo: { owner: 'intent-hq', repo: 'cloudlands-fe' },
      runId: 1,
      eventName: fixture.event || 'push',
      payload: fixture.payload || {},
    },
    { env },
  );
  return { outputs, runners: JSON.parse(outputs.runners), queried, messages };
}
test('healthy matching fleet is preferred for every workload size', async () => {
  const r = await route();
  for (const size of ['', '-8', '-16'])
    assert.deepEqual(r.runners[`depot-ubuntu-24.04${size}`], ['self-hosted', 'Linux', 'X64']);
  assert.deepEqual(r.runners['depot-ubuntu-24.04-arm-8'], ['self-hosted', 'Linux', 'ARM64']);
  assert.deepEqual(r.runners['depot-macos-latest'], ['self-hosted', 'macOS', 'ARM64']);
  assert.deepEqual(r.runners['depot-windows-2022-16'], ['self-hosted', 'Windows', 'X64']);
  assert.deepEqual([...new Set(r.queried)].sort(), ['cloudlands-fe', 'intent', 'intentd']);
});
test('offline, invisible, API failure, and unreadable sibling capacity burst', async () => {
  for (const f of [{ runners: [] }, { error: true }, { unreadable: 'intent' }]) {
    const r = await route(f);
    assert.deepEqual(r.runners['depot-ubuntu-24.04-8'], ['depot-ubuntu-24.04-8']);
    assert.ok(r.messages.some((m) => m.includes('burst=true')));
  }
});
test('org listing may fall back to repository-visible runners', async () => {
  assert.equal((await route({ orgError: true })).outputs.linux_burst, 'false');
});
test('busy native runners and unknown busy state burst', async () => {
  for (const busy of [true, undefined]) {
    const r = await route({
      runners: [runner('Windows', 'X64', true), { ...runner('macOS', 'ARM64'), busy }],
    });
    assert.equal(r.outputs.windows_burst, 'true');
    assert.equal(r.outputs.macos_burst, 'true');
  }
});
test('queued demand and stalled jobs trigger fallback; hosted jobs do not', async () => {
  const queued = {
    id: 3,
    status: 'queued',
    labels: ['self-hosted', 'Linux', 'X64'],
    created_at: new Date().toISOString(),
  };
  assert.equal(
    (await route({ jobs: Array.from({ length: 9 }, (_, i) => ({ ...queued, id: i + 3 })) })).outputs
      .linux_burst,
    'true',
  );
  assert.equal(
    (await route({ jobs: [{ ...queued, created_at: '2000-01-01T00:00:00Z' }] })).outputs
      .linux_burst,
    'true',
  );
  assert.equal(
    (await route({ jobs: [{ ...queued, labels: ['depot-ubuntu-24.04-8'] }] })).outputs.linux_burst,
    'false',
  );
});
test('maintenance disables each matching platform', async () => {
  const r = await route({
    env: {
      LINUX_RUNNER_DISABLED: 'true',
      WINDOWS_RUNNER_DISABLED: 'true',
      MACOS_RUNNER_DISABLED: 'true',
    },
  });
  for (const key of ['linux_burst', 'windows_burst', 'macos_burst'])
    assert.equal(r.outputs[key], 'true');
});
test('fork pull requests never select persistent runners', async () => {
  const r = await route({
    event: 'pull_request',
    payload: { pull_request: { head: { repo: { full_name: 'outside/fork' } } } },
  });
  assert.equal(r.outputs.linux_burst, 'true');
  assert.equal(r.queried.length, 0);
});
test('platform and architecture must match', async () => {
  const r = await route({ runners: [runner('Linux', 'ARM64'), runner('macOS', 'X64')] });
  assert.equal(r.outputs.linux_burst, 'true');
  assert.equal(r.outputs.macos_burst, 'true');
});
test('component CI and reusable workflows execute the same routing policy', () => {
  for (const name of ['ci.yml', 'intent-pr.yml']) {
    const file = path.join(root, '.github/workflows', name);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    const section = body.match(/^ {2}route:\n[\s\S]*? {10}script: \|\n((?: {12}[^\n]*\n|\n)*)/m);
    if (!section) continue;
    const normalize = (s) =>
      s
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
    assert.equal(normalize(section[1]), normalize(script));
  }
});
test('native busy occupancy is not counted twice, and queued native demand bursts', async () => {
  const runners = [runner('macOS', 'ARM64'), runner('macOS', 'ARM64', true)];
  const job = { id: 4, status: 'in_progress', labels: ['self-hosted', 'macOS', 'ARM64'] };
  assert.equal((await route({ runners, jobs: [job] })).outputs.macos_burst, 'false');
  assert.equal(
    (
      await route({
        runners,
        jobs: [{ ...job, status: 'queued', created_at: new Date().toISOString() }],
      })
    ).outputs.macos_burst,
    'true',
  );
});
