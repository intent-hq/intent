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
const runner = (os, arch, busy = false, extra = []) => ({
  status: 'online',
  busy,
  labels: ['self-hosted', os, arch, ...extra].map((name) => ({ name })),
});
// intent-cache slots register with GitHub's default labels plus `intent-cache`.
const cacheSlot = (busy = false) => runner('Linux', 'X64', busy, ['intent-cache']);
const CACHE = ['self-hosted', 'linux', 'x64', 'intent-cache'];
const smallSlot = (busy = false) => runner('Linux', 'X64', busy, ['intent-cache-small']);
const SMALL = ['self-hosted', 'linux', 'x64', 'intent-cache-small'];
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
            cacheSlot(),
            cacheSlot(),
            ...Array.from({ length: 6 }, () => smallSlot()),
            runner('Windows', 'X64'),
            runner('macOS', 'ARM64'),
            runner('Linux', 'ARM64'),
          ]
        );
      if (method === 'runs') {
        queried.push(params.repo);
        return [{ id: 2 }];
      }
      // Fixture jobs belong to one repository so depth counts each job once.
      return params.repo === 'cloudlands-fe' ? (fixture.jobs ?? []) : [];
    },
  };
  const env = { THRESHOLD: '2', SMALL_THRESHOLD: '6', LINUX_SIZE: '8', ...fixture.env };
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
  return { outputs, runners: JSON.parse(outputs.runners), slots: JSON.parse(outputs.slots), queried, messages };
}
test('healthy matching fleet is preferred for every workload size', async () => {
  const r = await route();
  // Larger-runner labels carry heavy jobs; standard labels carry fast jobs.
  for (const label of ['gh-linux-8x', 'gh-linux-16x']) assert.deepEqual(r.runners[label], CACHE);
  for (const label of ['ubuntu-22.04', 'ubuntu-24.04']) assert.deepEqual(r.runners[label], SMALL);
  for (const label of ['ubuntu-24.04-arm', 'gh-linux-arm64-8x'])
    assert.deepEqual(r.runners[label], ['self-hosted', 'Linux', 'ARM64']);
  assert.deepEqual(r.runners['macos-26-xlarge'], ['self-hosted', 'macOS', 'ARM64']);
  for (const label of ['windows-2022', 'windows-2025', 'gh-windows-16x'])
    assert.deepEqual(r.runners[label], ['self-hosted', 'Windows', 'X64']);
  assert.deepEqual(JSON.parse(r.outputs.linux_labels), CACHE);
  assert.deepEqual([...new Set(r.queried)].sort(), ['cloudlands-fe', 'intent', 'intentd']);
});
test('offline, invisible, API failure, and unreadable sibling capacity burst', async () => {
  for (const f of [{ runners: [] }, { error: true }, { unreadable: 'intent' }]) {
    const r = await route(f);
    for (const label of Object.keys(r.runners)) assert.deepEqual(r.runners[label], [label]);
    assert.deepEqual(JSON.parse(r.outputs.check_labels), ['gh-linux-8x']);
    assert.deepEqual(JSON.parse(r.outputs.windows_labels), ['gh-windows-16x']);
    assert.deepEqual(JSON.parse(r.outputs.macos_labels), ['macos-26-xlarge']);
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
    labels: CACHE,
    created_at: new Date().toISOString(),
  };
  assert.equal(
    (await route({ jobs: Array.from({ length: 2 }, (_, i) => ({ ...queued, id: i + 3 })) })).outputs
      .linux_burst,
    'true',
  );
  assert.equal(
    (await route({ jobs: [{ ...queued, created_at: '2000-01-01T00:00:00Z' }] })).outputs
      .linux_burst,
    'true',
  );
  assert.equal(
    (await route({ jobs: [{ ...queued, labels: ['gh-linux-8x'] }] })).outputs.linux_burst,
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
test('only intent-cache slots serve Linux; generic self-hosted Linux runners are ignored', async () => {
  const generic = await route({ runners: [runner('Linux', 'X64'), runner('Linux', 'X64')] });
  assert.equal(generic.outputs.linux_burst, 'true');
  assert.deepEqual(generic.runners['ubuntu-24.04'], ['ubuntu-24.04']);
  assert.deepEqual(JSON.parse(generic.outputs.linux_labels), ['gh-linux-8x']);
  assert.ok(generic.messages.some((m) => m.includes('linux routing: burst=true (no available compatible runner)')));
  for (const label of JSON.parse(generic.outputs.linux_labels)) assert.notEqual(label, 'self-hosted');
  // Jobs requesting the generic fleet do not occupy intent-cache slots.
  const generic_jobs = Array.from({ length: 5 }, (_, i) => ({
    id: i + 3,
    status: 'in_progress',
    labels: ['self-hosted', 'Linux', 'X64'],
  }));
  assert.equal((await route({ jobs: generic_jobs })).outputs.linux_burst, 'false');
});
test('Linux bursts exactly when every intent-cache slot is occupied', async () => {
  const job = (id, status = 'in_progress') => ({
    id,
    status,
    labels: CACHE,
    created_at: new Date().toISOString(),
  });
  const one = await route({ jobs: [job(3)] });
  assert.equal(one.outputs.linux_burst, 'false');
  assert.ok(one.messages.some((m) => m.includes('queue depth=1 threshold=2 online=2')));
  // Label case differs between runs-on and runner registration; GitHub matches case-insensitively.
  const two = await route({ jobs: [job(3), { ...job(4), labels: ['self-hosted', 'Linux', 'X64', 'intent-cache'] }] });
  assert.equal(two.outputs.linux_burst, 'true');
  assert.deepEqual(JSON.parse(two.outputs.linux_labels), ['gh-linux-8x']);
  // One slot between jobs (ephemeral runner re-registering) halves capacity.
  const single = await route({ runners: [cacheSlot(), smallSlot()], jobs: [job(3)] });
  assert.equal(single.outputs.linux_burst, 'true');
  // Slots can grow by raising THRESHOLD alone.
  const grown = await route({
    env: { THRESHOLD: '4' },
    runners: [cacheSlot(), cacheSlot(), cacheSlot(), cacheSlot()],
    jobs: [job(3), job(4), job(5)],
  });
  assert.equal(grown.outputs.linux_burst, 'false');
});
test('the Linux kill switch sends every Linux job to the hosted fallback', async () => {
  const r = await route({ env: { LINUX_RUNNER_DISABLED: 'true' } });
  assert.equal(r.outputs.linux_burst, 'true');
  for (const label of ['ubuntu-22.04', 'ubuntu-24.04', 'gh-linux-8x', 'gh-linux-16x'])
    assert.deepEqual(r.runners[label], [label]);
  assert.ok(r.messages.some((m) => m.includes('linux routing: burst=true (disabled for maintenance)')));
  assert.equal(r.outputs.windows_burst, 'false');
});
test('the probe never names tinybox', () => {
  assert.doesNotMatch(workflow, /tinybox/i);
});
test('the fast pool routes standard labels and bursts independently of the heavy pool', async () => {
  const job = (id, labels = SMALL) => ({ id, status: 'in_progress', labels, created_at: new Date().toISOString() });
  const five = await route({ jobs: Array.from({ length: 5 }, (_, i) => job(i + 3)) });
  assert.deepEqual(five.runners['ubuntu-24.04'], SMALL);
  assert.ok(five.messages.some((m) => m.includes('small routing: burst=false (queue depth=5 threshold=6 online=6 free=1)')));
  const six = await route({ jobs: Array.from({ length: 6 }, (_, i) => job(i + 3)) });
  assert.deepEqual(six.runners['ubuntu-24.04'], ['ubuntu-24.04']);
  assert.deepEqual(six.runners['gh-linux-8x'], CACHE);
  // A full heavy pool leaves fast jobs on their slots.
  const heavy = await route({ jobs: [job(3, CACHE), job(4, CACHE)] });
  assert.deepEqual(heavy.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.deepEqual(heavy.runners['ubuntu-24.04'], SMALL);
  // Heavy slots alone never serve fast jobs, and vice versa.
  const heavyOnly = await route({ runners: [cacheSlot(), cacheSlot()] });
  assert.deepEqual(heavyOnly.runners['ubuntu-24.04'], ['ubuntu-24.04']);
  assert.deepEqual(heavyOnly.runners['gh-linux-8x'], CACHE);
  const grown = await route({
    env: { SMALL_THRESHOLD: '8' },
    runners: Array.from({ length: 8 }, () => smallSlot()),
    jobs: Array.from({ length: 7 }, (_, i) => job(i + 3)),
  });
  assert.deepEqual(grown.runners['ubuntu-24.04'], SMALL);
});
test('both pools carry the generic labels, so capacity and demand are counted per pool label', async () => {
  // GitHub adds self-hosted/Linux/X64 to every slot; only the pool label separates them.
  const smallOnly = await route({ runners: Array.from({ length: 6 }, () => smallSlot()) });
  assert.deepEqual(smallOnly.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.deepEqual(smallOnly.runners['ubuntu-24.04'], SMALL);
  assert.ok(smallOnly.messages.some((m) => m.includes('linux routing: burst=true (no available compatible runner)')));
  // Six running fast jobs fill the small pool but leave both heavy slots free.
  const job = (id) => ({ id, status: 'in_progress', labels: SMALL, created_at: new Date().toISOString() });
  const r = await route({ jobs: Array.from({ length: 6 }, (_, i) => job(i + 3)) });
  assert.ok(r.messages.some((m) => m.includes('linux routing: burst=false (queue depth=0 threshold=2 online=2 free=2)')));
  // A routed job's labels always include its pool label, so the other pool cannot take it.
  const healthy = await route({});
  assert.ok(healthy.runners['gh-linux-8x'].includes('intent-cache'));
  assert.ok(!healthy.runners['gh-linux-8x'].includes('intent-cache-small'));
  assert.ok(healthy.runners['ubuntu-24.04'].includes('intent-cache-small'));
  assert.ok(!healthy.runners['ubuntu-24.04'].includes('intent-cache'));
});
// Per-job slot fitting: a run gets self-hosted labels for at most as many jobs as a pool has free slots.
const heavyJob = (id, status = 'in_progress') => ({ id, status, labels: CACHE, created_at: new Date().toISOString() });
const UNIT = { key: 'test', label: 'gh-linux-8x', minutes: 13, shards: 4 };
const slotEnv = (jobs, env = {}) => ({ SLOT_JOBS: JSON.stringify(jobs), ...env });
const onSlots = (r, labels) => Object.keys(r.slots).filter((k) => JSON.stringify(r.slots[k]) === JSON.stringify(labels)).sort();
test('2 free heavy slots and 4 heavy jobs: exactly 2 self-hosted, 2 hosted', async () => {
  const r = await route({ env: slotEnv([UNIT]) });
  assert.deepEqual(Object.keys(r.slots).sort(), ['test-1', 'test-2', 'test-3', 'test-4']);
  assert.equal(onSlots(r, CACHE).length, 2);
  assert.equal(onSlots(r, ['gh-linux-8x']).length, 2);
  // Matrix shards get different runners; list order breaks ties.
  assert.deepEqual(onSlots(r, CACHE), ['test-1', 'test-2']);
  // The listed jobs used every free slot, so unlisted heavy jobs go hosted too.
  assert.deepEqual(r.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.equal(r.outputs.linux_burst, 'true');
  assert.ok(r.messages.some((m) => m.includes('linux routing: burst=true (queue depth=0 threshold=2 online=2 free=2 granted=2)')));
  // One running heavy job elsewhere leaves a single free slot.
  const one = await route({ env: slotEnv([UNIT]), jobs: [heavyJob(3)] });
  assert.deepEqual(onSlots(one, CACHE), ['test-1']);
});
test('0 free heavy slots: every listed job goes hosted', async () => {
  const r = await route({ env: slotEnv([UNIT, { key: 'check', label: 'gh-linux-8x', rust: true }]), jobs: [heavyJob(3), heavyJob(4)] });
  for (const labels of Object.values(r.slots)) assert.deepEqual(labels, ['gh-linux-8x']);
  assert.equal(Object.keys(r.slots).length, 5);
});
test('the kill switch, a fork, a probe failure, and an unreadable list send listed jobs hosted', async () => {
  const jobs = [UNIT, { key: 'lint', label: 'ubuntu-24.04' }];
  for (const f of [
    { env: slotEnv(jobs, { LINUX_RUNNER_DISABLED: 'true' }) },
    { env: slotEnv(jobs), event: 'pull_request', payload: { pull_request: { head: { repo: { full_name: 'outside/fork' } } } } },
    { env: slotEnv(jobs), error: true },
  ]) {
    const r = await route(f);
    assert.equal(Object.keys(r.slots).length, 5);
    for (const [key, labels] of Object.entries(r.slots)) assert.deepEqual(labels, [key === 'lint' ? 'ubuntu-24.04' : 'gh-linux-8x']);
  }
  const bad = await route({ env: { SLOT_JOBS: '[not json' } });
  assert.deepEqual(bad.slots, {});
  assert.ok(bad.messages.some((m) => m.includes('slot list unreadable')));
});
test('Rust-compiling jobs get slots first, then the longest jobs', async () => {
  const r = await route({
    env: slotEnv([
      { key: 'lint', label: 'gh-linux-8x', minutes: 30 },
      { key: 'coverage', label: 'gh-linux-16x', rust: true, minutes: 13 },
      { key: 'unit', label: 'gh-linux-8x', minutes: 14 },
      { key: 'check', label: 'gh-linux-8x', rust: true, minutes: 20 },
    ]),
  });
  assert.deepEqual(onSlots(r, CACHE), ['check', 'coverage']);
  assert.deepEqual(r.slots.lint, ['gh-linux-8x']);
  assert.deepEqual(r.slots.unit, ['gh-linux-8x']);
  const one = await route({ env: slotEnv([{ key: 'a', label: 'gh-linux-8x', minutes: 4 }, { key: 'b', label: 'gh-linux-8x', minutes: 14 }]), jobs: [heavyJob(3)] });
  assert.deepEqual(onSlots(one, CACHE), ['b']);
});
test('jobs that skip this event do not take a slot', async () => {
  const jobs = [
    { key: 'build-web', label: 'gh-linux-8x', minutes: 40, events: ['merge_group'] },
    { key: 'checks', label: 'gh-linux-8x', minutes: 14 },
    { key: 'unit', label: 'gh-linux-8x', minutes: 13 },
  ];
  const pr = await route({ env: slotEnv(jobs), event: 'pull_request', payload: { pull_request: { head: { repo: { full_name: 'intent-hq/cloudlands-fe' } } } } });
  assert.deepEqual(onSlots(pr, CACHE), ['checks', 'unit']);
  assert.deepEqual(pr.slots['build-web'], ['gh-linux-8x']);
  const queue = await route({ env: slotEnv(jobs), event: 'merge_group' });
  assert.deepEqual(onSlots(queue, CACHE), ['build-web', 'checks']);
});
test('each pool fits its own jobs and keeps its own labels', async () => {
  const small = Array.from({ length: 8 }, (_, i) => ({ key: `s${i}`, label: 'ubuntu-24.04', minutes: i }));
  const r = await route({ env: slotEnv([...small, UNIT]), jobs: [heavyJob(3), { ...heavyJob(4), labels: SMALL }] });
  // Small pool: 6 slots, 1 busy -> 5 granted, longest first.
  assert.deepEqual(onSlots(r, SMALL), ['s3', 's4', 's5', 's6', 's7']);
  assert.deepEqual(onSlots(r, ['ubuntu-24.04']), ['s0', 's1', 's2']);
  // Heavy pool: 2 slots, 1 busy -> 1 granted.
  assert.deepEqual(onSlots(r, CACHE), ['test-1']);
  assert.equal(r.outputs.linux_burst, 'true');
  assert.deepEqual(r.runners['ubuntu-24.04'], ['ubuntu-24.04']);
  // A pool with slots left after its listed jobs still serves unlisted jobs.
  const spare = await route({ env: slotEnv([{ key: 'lint', label: 'ubuntu-24.04' }]) });
  assert.deepEqual(spare.slots.lint, SMALL);
  assert.deepEqual(spare.runners['ubuntu-24.04'], SMALL);
  // Native fleets are not slot-fitted.
  const win = await route({ env: slotEnv([{ key: 'win', label: 'windows-2025' }]) });
  assert.deepEqual(win.slots.win, ['windows-2025']);
});
