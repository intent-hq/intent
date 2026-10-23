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
// Standard GitHub-hosted labels are free for public repositories.
const FREE = ['ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-latest', 'ubuntu-24.04-arm', 'windows-2022', 'windows-2025'];
// Per-job slot fitting: a run gets self-hosted labels for at most as many jobs as a pool has free slots.
const heavyJob = (id, status = 'in_progress') => ({ id, status, labels: CACHE, created_at: new Date().toISOString() });
const UNIT = { key: 'test', label: 'gh-linux-8x', minutes: 13, shards: 4 };
const slotEnv = (jobs, env = {}) => ({ SLOT_JOBS: JSON.stringify(jobs), ...env });
const onSlots = (r, labels) => Object.keys(r.slots).filter((k) => JSON.stringify(r.slots[k]) === JSON.stringify(labels)).sort();
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
  // Pool tests check the GitHub fallback; the WarpBuild tests below turn WarpBuild on.
  const env = { THRESHOLD: '2', LINUX_SIZE: '8', WARPBUILD_DISABLED: 'true', ...fixture.env };
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
  assert.deepEqual(r.runners['gh-linux-arm64-8x'], ['self-hosted', 'Linux', 'ARM64']);
  assert.deepEqual(r.runners['macos-26-xlarge'], ['self-hosted', 'macOS', 'ARM64']);
  assert.deepEqual(r.runners['gh-windows-16x'], ['self-hosted', 'Windows', 'X64']);
  // Free standard labels stay on GitHub even with idle self-hosted runners.
  for (const label of FREE) assert.deepEqual(r.runners[label], [label]);
  assert.deepEqual(JSON.parse(r.outputs.linux_labels), CACHE);
  assert.deepEqual([...new Set(r.queried)].sort(), ['cloudlands-fe', 'intent', 'intentd']);
});
test('offline, invisible, API failure, and unreadable sibling capacity burst', async () => {
  for (const f of [{ runners: [] }, { error: true }, { unreadable: 'intent' }, { unreadable: 'intentd' }]) {
    const r = await route({ ...f, env: slotEnv([UNIT, { key: 'lint', label: 'ubuntu-24.04' }]) });
    // Unknown demand on any repo sends every listed job hosted.
    assert.ok(Object.values(r.slots).every((labels) => labels.length === 1 && !labels[0].startsWith('self-hosted')));
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
test('free standard labels never take a self-hosted slot or a WarpBuild runner', async () => {
  for (const env of [{}, { WARPBUILD_DISABLED: '' }]) {
    const idle = await route({ env: slotEnv([{ key: 'lint', label: 'ubuntu-24.04' }, { key: 'win', label: 'windows-2025' }], env) });
    for (const label of FREE) assert.deepEqual(idle.runners[label], [label]);
    for (const label of FREE) assert.deepEqual(JSON.parse(idle.outputs.cloud)[label], [label]);
    assert.deepEqual(idle.slots, { lint: ['ubuntu-24.04'], win: ['windows-2025'] });
  }
  assert.doesNotMatch(workflow, /intent-cache-small|SMALL_THRESHOLD/);
});
test('the small pool shares the generic labels but never counts as heavy capacity or demand', async () => {
  // GitHub adds self-hosted/Linux/X64 to every slot; only the pool label separates them.
  const smallOnly = await route({ runners: Array.from({ length: 6 }, () => smallSlot()) });
  assert.deepEqual(smallOnly.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.ok(smallOnly.messages.some((m) => m.includes('linux routing: burst=true (no available compatible runner)')));
  // Jobs pinned to the small pool leave both heavy slots free.
  const job = (id) => ({ id, status: 'in_progress', labels: SMALL, created_at: new Date().toISOString() });
  const r = await route({ jobs: Array.from({ length: 6 }, (_, i) => job(i + 3)) });
  assert.ok(r.messages.some((m) => m.includes('linux routing: burst=false (queue depth=0 threshold=2 online=2 free=2)')));
  assert.ok(r.runners['gh-linux-8x'].includes('intent-cache'));
  assert.ok(!r.runners['gh-linux-8x'].includes('intent-cache-small'));
});
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
test('listed free-label jobs keep their GitHub label while heavy jobs fit the heavy pool', async () => {
  const small = Array.from({ length: 3 }, (_, i) => ({ key: `s${i}`, label: 'ubuntu-24.04', minutes: 40 + i }));
  const r = await route({ env: slotEnv([...small, UNIT]), jobs: [heavyJob(3)] });
  assert.deepEqual(onSlots(r, ['ubuntu-24.04']), ['s0', 's1', 's2']);
  // Heavy pool: 2 slots, 1 busy -> 1 granted.
  assert.deepEqual(onSlots(r, CACHE), ['test-1']);
  assert.equal(r.outputs.linux_burst, 'true');
  // `legs` gives each named matrix leg its own key.
  const legs = await route({ env: slotEnv([{ key: 'pin', label: 'gh-linux-8x', legs: ['codex', 'claude-code'] }]), jobs: [heavyJob(3)] });
  assert.deepEqual(legs.slots, { 'pin-codex': CACHE, 'pin-claude-code': ['gh-linux-8x'] });
  // Native fleets are not slot-fitted.
  const win = await route({ env: slotEnv([{ key: 'win', label: 'gh-windows-16x' }]) });
  assert.deepEqual(win.slots.win, ['gh-windows-16x']);
});
// The xl pool: 16-thread slots that take gh-linux-16x jobs; gh-linux-8x jobs stay on the heavy pool.
const XL = ['self-hosted', 'linux', 'x64', 'intent-cache-xl'];
const xlSlot = (busy = false) => runner('Linux', 'X64', busy, ['intent-cache-xl']);
const xlJob = (id, status = 'in_progress') => ({ id, status, labels: XL, created_at: new Date().toISOString() });
const todaysFleet = () => [
  cacheSlot(),
  cacheSlot(),
  ...Array.from({ length: 6 }, () => smallSlot()),
  runner('Windows', 'X64'),
  runner('macOS', 'ARM64'),
  runner('Linux', 'ARM64'),
];
const XL_ON = { XL_THRESHOLD: '2' };
const MIXED = [
  { key: 'coverage', label: 'gh-linux-16x', rust: true, minutes: 13 },
  { key: 'check', label: 'gh-linux-8x', rust: true, minutes: 15 },
  { key: 'lint', label: 'ubuntu-24.04' },
];
test('gh-linux-16x jobs take xl slots; gh-linux-8x jobs stay on the heavy pool', async () => {
  const r = await route({ env: slotEnv(MIXED, XL_ON), runners: [...todaysFleet(), xlSlot(), xlSlot()] });
  assert.deepEqual(r.slots, { coverage: XL, check: CACHE, lint: ['ubuntu-24.04'] });
  // One xl slot is still free, so unlisted 16-core jobs ride it; 8-core jobs never do.
  assert.deepEqual(r.runners['gh-linux-16x'], XL);
  assert.deepEqual(r.runners['gh-linux-8x'], CACHE);
  assert.deepEqual(JSON.parse(r.outputs.check_labels), CACHE);
  assert.deepEqual(JSON.parse(r.outputs.linux_labels), CACHE);
  assert.ok(r.messages.some((m) => m.includes('xl routing: burst=false (queue depth=0 threshold=2 online=2 free=2 granted=1)')));
  // Callers asking for the 16-core size read the xl slot and report it as self-hosted.
  const sized = await route({ env: { ...XL_ON, LINUX_SIZE: '16' }, runners: [...todaysFleet(), xlSlot()] });
  assert.deepEqual(JSON.parse(sized.outputs.linux_labels), XL);
  assert.equal(sized.outputs.linux_burst, 'false');
  // 8-core jobs never take an xl slot, even when the heavy pool is full.
  const heavyFull = await route({
    env: slotEnv([{ key: 'check', label: 'gh-linux-8x' }], XL_ON),
    runners: [...todaysFleet(), xlSlot()],
    jobs: [heavyJob(3), heavyJob(4)],
  });
  assert.deepEqual(heavyFull.slots.check, ['gh-linux-8x']);
  assert.deepEqual(heavyFull.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.deepEqual(heavyFull.runners['gh-linux-16x'], XL);
});
test('a full xl pool sends gh-linux-16x jobs to free heavy slots, then hosted', async () => {
  const runners = [...todaysFleet(), xlSlot()];
  const jobs16 = [
    { key: 'a', label: 'gh-linux-16x', minutes: 30 },
    { key: 'b', label: 'gh-linux-16x', minutes: 20 },
    { key: 'c', label: 'gh-linux-16x', minutes: 10 },
    { key: 'd', label: 'gh-linux-16x', minutes: 5 },
  ];
  const r = await route({ env: slotEnv(jobs16, XL_ON), runners });
  // xl first (longest job), then the two heavy slots, then hosted.
  assert.deepEqual(r.slots, { a: XL, b: CACHE, c: CACHE, d: ['gh-linux-16x'] });
  assert.deepEqual(r.runners['gh-linux-16x'], ['gh-linux-16x']);
  // xl busy elsewhere: 16-core work overflows to heavy exactly as before xl existed.
  const busy = await route({ env: XL_ON, runners, jobs: [xlJob(3)] });
  assert.deepEqual(busy.runners['gh-linux-16x'], CACHE);
  assert.ok(busy.messages.some((m) => m.includes('xl routing: burst=true (queue depth=1 threshold=1 online=1 free=0)')));
  // Both pools full: hosted.
  const full = await route({ env: XL_ON, runners, jobs: [xlJob(3), heavyJob(4), heavyJob(5)] });
  assert.deepEqual(full.runners['gh-linux-16x'], ['gh-linux-16x']);
  assert.deepEqual(full.runners['gh-linux-8x'], ['gh-linux-8x']);
});
test('xl and heavy capacity and demand are counted per pool label', async () => {
  // xl slots carry the generic labels too; only intent-cache-xl separates them.
  const xlOnly = await route({ env: XL_ON, runners: [xlSlot(), xlSlot()] });
  assert.deepEqual(xlOnly.runners['gh-linux-8x'], ['gh-linux-8x']);
  assert.deepEqual(xlOnly.runners['gh-linux-16x'], XL);
  assert.ok(xlOnly.messages.some((m) => m.includes('linux routing: burst=true (no available compatible runner)')));
  // Running xl jobs do not occupy heavy slots, and running heavy jobs do not occupy xl slots.
  const r = await route({ env: XL_ON, runners: [...todaysFleet(), xlSlot()], jobs: [xlJob(3), xlJob(4), heavyJob(5)] });
  assert.ok(r.messages.some((m) => m.includes('linux routing: burst=false (queue depth=1 threshold=2 online=2 free=1)')));
  assert.ok(r.messages.some((m) => m.includes('xl routing: burst=true (queue depth=2 threshold=1 online=1 free=0)')));
  // A routed job's labels name exactly one pool.
  assert.ok(!r.runners['gh-linux-8x'].includes('intent-cache-xl'));
});
test('with no xl runners online, or the xl limit at its default of 0, routing is unchanged', async () => {
  const listed = slotEnv([...MIXED, UNIT]);
  const baseline = await route({ env: listed, jobs: [heavyJob(9)] });
  // Today's expectations: both 8x and 16x jobs share the heavy pool.
  // One heavy slot is free; the longer Rust job takes it and 16-core work goes hosted.
  assert.deepEqual(baseline.slots.check, CACHE);
  assert.deepEqual(baseline.slots.coverage, ['gh-linux-16x']);
  assert.deepEqual(onSlots(baseline, CACHE), ['check']);
  assert.deepEqual(baseline.runners['gh-linux-16x'], ['gh-linux-16x']);
  for (const f of [
    { env: { ...listed, ...XL_ON } },
    { env: { ...listed, ...XL_ON }, runners: [...todaysFleet(), xlSlot(true)].map((r, i, all) => (i === all.length - 1 ? { ...r, status: 'offline' } : r)) },
    { env: listed, runners: [...todaysFleet(), xlSlot(), xlSlot()] },
    { env: { ...listed, XL_THRESHOLD: '0' }, runners: [...todaysFleet(), xlSlot()] },
  ]) {
    const r = await route({ ...f, jobs: [heavyJob(9)] });
    assert.deepEqual(r.slots, baseline.slots);
    assert.deepEqual(r.runners, baseline.runners);
    for (const key of ['linux_labels', 'check_labels', 'linux_burst', 'windows_labels', 'windows_burst', 'macos_labels', 'macos_burst'])
      assert.equal(r.outputs[key], baseline.outputs[key], key);
    assert.ok(r.messages.some((m) => m.startsWith('xl routing: burst=true')));
  }
  const sized = await route({ env: { LINUX_SIZE: '16' } });
  assert.deepEqual(JSON.parse(sized.outputs.linux_labels), CACHE);
  assert.equal(sized.outputs.linux_burst, 'false');
});
test('the Linux kill switch and probe failures also send xl work hosted', async () => {
  const runners = [...todaysFleet(), xlSlot(), xlSlot()];
  for (const f of [
    { env: slotEnv(MIXED, { ...XL_ON, LINUX_RUNNER_DISABLED: 'true' }), runners },
    { env: slotEnv(MIXED, XL_ON), runners, error: true },
    { env: slotEnv(MIXED, XL_ON), runners, unreadable: 'intentd' },
  ]) {
    const r = await route(f);
    assert.deepEqual(r.slots, { coverage: ['gh-linux-16x'], check: ['gh-linux-8x'], lint: ['ubuntu-24.04'] });
    assert.deepEqual(r.runners['gh-linux-16x'], ['gh-linux-16x']);
  }
  const killed = await route({ env: { ...XL_ON, LINUX_RUNNER_DISABLED: 'true' }, runners });
  assert.ok(killed.messages.some((m) => m.includes('xl routing: burst=true (disabled for maintenance)')));
});
test('pool limits come from Actions variables with the old values as defaults', async () => {
  const env = workflow.split('          SLOT_JOBS:')[0].split('        env:\n').pop();
  assert.match(env, /^ {10}THRESHOLD: \$\{\{ vars\.CI_LINUX_HEAVY_SLOTS \|\| '2' \}\}$/m);
  assert.match(env, /^ {10}XL_THRESHOLD: \$\{\{ vars\.CI_LINUX_XL_SLOTS \|\| '0' \}\}$/m);
  assert.doesNotMatch(workflow, /THRESHOLD: '\d+'/);
  // An unset variable reaches the script empty only if the expression is dropped; the script defaults match.
  const unset = await route({ env: { THRESHOLD: '', XL_THRESHOLD: '' }, runners: [...todaysFleet(), cacheSlot(), xlSlot()] });
  assert.ok(unset.messages.some((m) => m.includes('linux routing: burst=false (queue depth=0 threshold=2 online=3 free=2)')));
  assert.ok(unset.messages.some((m) => m.includes('xl routing: burst=true (queue depth=0 threshold=0 online=1 free=0)')));
  // Raising the variables alone grows the pools: 14 heavy and 2 xl slots.
  const grown = await route({
    env: slotEnv([{ key: 'unit', label: 'gh-linux-8x', shards: 16 }, { key: 'cov', label: 'gh-linux-16x', shards: 3 }], { THRESHOLD: '14', XL_THRESHOLD: '2' }),
    runners: [...Array.from({ length: 14 }, () => cacheSlot()), xlSlot(), xlSlot()],
  });
  assert.equal(onSlots(grown, CACHE).length, 14);
  assert.deepEqual(onSlots(grown, XL), ['cov-1', 'cov-2']);
  // A malformed variable fails the probe open to hosted.
  for (const bad of [{ XL_THRESHOLD: 'two' }, { THRESHOLD: '-1' }, { THRESHOLD: '1.5' }]) {
    const r = await route({ env: slotEnv(MIXED, bad), runners: [...todaysFleet(), xlSlot()] });
    assert.ok(Object.values(r.slots).every((labels) => labels.length === 1 && !labels[0].startsWith('self-hosted')));
    assert.ok(r.messages.some((m) => m.includes('probe failed (invalid queue threshold)')));
  }
});

// WarpBuild replaces paid GitHub labels as the burst target.
const WARP_ON = { WARPBUILD_DISABLED: '' };
const WARP = {
  'gh-linux-8x': ['warp-ubuntu-2404-x64-8x'],
  'gh-linux-16x': ['warp-ubuntu-2404-x64-16x'],
  'gh-linux-arm64-8x': ['warp-ubuntu-2404-arm64-8x'],
  'gh-windows-16x': ['warp-windows-2022-x64-16x'],
  'macos-26-xlarge': ['warp-macos-26-arm64-12x'],
};
const FORK = { event: 'pull_request', payload: { pull_request: { head: { repo: { full_name: 'outside/fork' } } } } };
const warpJob = (id, label, minutesAgo) => ({ id, status: 'queued', labels: [label], created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
test('full or missing self-hosted fleets burst paid labels to WarpBuild', async () => {
  for (const f of [{ runners: [] }, { jobs: [heavyJob(3), heavyJob(4)], runners: [cacheSlot(), cacheSlot()] }]) {
    const r = await route({ ...f, env: WARP_ON });
    for (const [label, labels] of Object.entries(WARP)) assert.deepEqual(r.runners[label], labels, label);
    assert.deepEqual(JSON.parse(r.outputs.check_labels), WARP['gh-linux-8x']);
    assert.deepEqual(JSON.parse(r.outputs.linux_labels), WARP['gh-linux-8x']);
    assert.equal(r.outputs.linux_burst, 'true');
    // No WarpBuild Intel Mac; free labels stay free.
    assert.deepEqual(r.runners['macos-latest-large'], ['macos-latest-large']);
    for (const label of FREE) assert.deepEqual(r.runners[label], [label]);
  }
  const none = await route({ runners: [], env: WARP_ON });
  assert.deepEqual(JSON.parse(none.outputs.windows_labels), WARP['gh-windows-16x']);
  assert.deepEqual(JSON.parse(none.outputs.macos_labels), WARP['macos-26-xlarge']);
  assert.ok(none.messages.includes('warpbuild ubuntu-x64: on'));
});
test('a free self-hosted slot still wins over WarpBuild', async () => {
  const r = await route({ env: slotEnv([UNIT], WARP_ON) });
  assert.deepEqual(onSlots(r, CACHE), ['test-1', 'test-2']);
  assert.deepEqual(onSlots(r, WARP['gh-linux-8x']), ['test-3', 'test-4']);
  assert.deepEqual(r.runners['gh-linux-8x'], WARP['gh-linux-8x']);
  const idle = await route({ env: WARP_ON });
  assert.deepEqual(idle.runners['gh-linux-8x'], CACHE);
  assert.deepEqual(idle.runners['gh-windows-16x'], ['self-hosted', 'Windows', 'X64']);
  assert.deepEqual(idle.runners['macos-26-xlarge'], ['self-hosted', 'macOS', 'ARM64']);
});
test('the WarpBuild kill switch and fork pull requests burst to GitHub', async () => {
  for (const f of [{ env: slotEnv([UNIT], { WARPBUILD_DISABLED: 'true' }), runners: [] }, { ...FORK, env: slotEnv([UNIT], WARP_ON) }]) {
    const r = await route(f);
    for (const label of Object.keys(WARP)) assert.deepEqual(r.runners[label], [label]);
    for (const label of Object.keys(WARP)) assert.deepEqual(JSON.parse(r.outputs.cloud)[label], [label]);
    assert.deepEqual(onSlots(r, ['gh-linux-8x']), ['test-1', 'test-2', 'test-3', 'test-4']);
  }
  const fork = await route({ ...FORK, env: WARP_ON });
  assert.equal(fork.queried.length, 0);
  assert.ok(fork.messages.includes('warpbuild ubuntu-x64: off (fork pull request)'));
  const off = await route({ env: { WARPBUILD_DISABLED: 'true' } });
  assert.ok(off.messages.includes('warpbuild macos-arm64: off (CI_WARPBUILD_DISABLED)'));
  // The kill switch is an Actions variable, so no workflow change is needed to flip it.
  assert.match(workflow, /^ {10}WARPBUILD_DISABLED: \$\{\{ vars\.CI_WARPBUILD_DISABLED \}\}$/m);
});
test('a WarpBuild OS/architecture queued over 10 minutes bursts to GitHub; others keep WarpBuild', async () => {
  const stuck = await route({ runners: [], env: WARP_ON, jobs: [warpJob(3, 'warp-ubuntu-2404-x64-16x', 11)] });
  for (const label of ['gh-linux-8x', 'gh-linux-16x']) assert.deepEqual(stuck.runners[label], [label]);
  // ARM64 Linux, Windows and macOS are tracked separately.
  assert.deepEqual(stuck.runners['gh-linux-arm64-8x'], WARP['gh-linux-arm64-8x']);
  assert.deepEqual(stuck.runners['gh-windows-16x'], WARP['gh-windows-16x']);
  assert.deepEqual(stuck.runners['macos-26-xlarge'], WARP['macos-26-xlarge']);
  assert.ok(stuck.messages.includes('warpbuild ubuntu-x64: off (queued over 10 minutes)'));
  assert.ok(stuck.messages.includes('warpbuild ubuntu-arm64: on'));
  const arm = await route({ runners: [], env: WARP_ON, jobs: [warpJob(3, 'warp-ubuntu-2404-arm64-8x', 30)] });
  assert.deepEqual(arm.runners['gh-linux-arm64-8x'], ['gh-linux-arm64-8x']);
  assert.deepEqual(arm.runners['gh-linux-8x'], WARP['gh-linux-8x']);
  // Aliases and variants map to the same OS/architecture.
  const alias = await route({ runners: [], env: WARP_ON, jobs: [warpJob(3, 'warp-windows-2025-vs2026-x64-4x', 30)] });
  assert.deepEqual(alias.runners['gh-windows-16x'], ['gh-windows-16x']);
  // A WarpBuild job whose age is unreadable is not evidence of an outage.
  const unknown = await route({ runners: [], env: WARP_ON, jobs: [{ id: 3, status: 'queued', labels: ['warp-ubuntu-2404-x64-8x'] }] });
  assert.deepEqual(unknown.runners['gh-linux-8x'], WARP['gh-linux-8x']);
  const mac = await route({ runners: [], env: WARP_ON, jobs: [warpJob(3, 'warp-macos-15-arm64-12x', 30)] });
  assert.deepEqual(mac.runners['macos-26-xlarge'], ['macos-26-xlarge']);
  assert.deepEqual(JSON.parse(mac.outputs.cloud)['macos-15-xlarge'], ['macos-15-xlarge']);
  assert.deepEqual(mac.runners['gh-linux-8x'], WARP['gh-linux-8x']);
  // A short wait, or a running job, is normal.
  for (const job of [warpJob(3, 'warp-ubuntu-2404-x64-8x', 2), { ...warpJob(3, 'warp-ubuntu-2404-x64-8x', 60), status: 'in_progress' }]) {
    const r = await route({ runners: [], env: WARP_ON, jobs: [job] });
    assert.deepEqual(r.runners['gh-linux-8x'], WARP['gh-linux-8x']);
  }
});
test('an unreadable queue or a probe failure keeps WarpBuild as the burst runner', async () => {
  for (const f of [{ error: true }, { unreadable: 'intentd' }]) {
    const r = await route({ ...f, env: slotEnv([UNIT], WARP_ON) });
    assert.deepEqual(onSlots(r, WARP['gh-linux-8x']), ['test-1', 'test-2', 'test-3', 'test-4']);
    for (const [label, labels] of Object.entries(WARP)) assert.deepEqual(r.runners[label], labels, label);
  }
});
test('cloud maps every paid label to WarpBuild and never to a self-hosted runner', async () => {
  const r = await route({ env: WARP_ON });
  const cloud = JSON.parse(r.outputs.cloud);
  assert.deepEqual(cloud, {
    ...Object.fromEntries(FREE.map((label) => [label, [label]])),
    ...WARP,
    'macos-15-xlarge': ['warp-macos-15-arm64-12x'],
    'macos-latest-large': ['macos-latest-large'],
  });
  // Idle self-hosted runners are still used by `runners`, never by `cloud`.
  assert.deepEqual(r.runners['gh-linux-8x'], CACHE);
  // The reusable workflow exposes it.
  assert.match(workflow, /^ {6}cloud:\n {8}value: \$\{\{ jobs\.probe\.outputs\.cloud \}\}$/m);
});
