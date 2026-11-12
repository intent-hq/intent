import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  consumerChecksSha,
  consumerChecksState,
  decide,
  linkedPullRequests,
  main,
  touchesProtocolDocs,
} from './consumer-checks-docs-rerun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MERGED = '2026-11-11T23:18:32Z';
const BEFORE = '2026-11-11T23:00:00Z';
const AFTER = '2026-11-11T23:30:00Z';
const HEAD = 'c'.repeat(40);
const OLD = '2'.repeat(40);
const NEW = '0'.repeat(40);
const MERGE = '5'.repeat(40);
const job = (name, status, conclusion = null) => ({ name, status, conclusion });
const consumer = (status, conclusion) => job('monorepo-consumer-checks / consumer-checks', status, conclusion);

test('linkedPullRequests reads URLs and short references to component PRs only', () => {
  const body = [
    '- intentd: https://github.com/intent-hq/intentd/pull/3289',
    '- cloudlands-fe: https://github.com/intent-hq/cloudlands-fe/pull/4458',
    'Follows intent-hq/intentd#3289 and cloudlands-fe#12; see intent#9108.',
    'Not a PR: https://github.com/intent-hq/intentd/issues/7 or myintentd#5.',
    'Other owners: fork/intentd#8, https://github.com/fork/cloudlands-fe/pull/9, github.com/x/intentd/pull/10.',
    'Without scheme: github.com/intent-hq/intentd/pull/11.',
  ].join('\n');
  assert.deepEqual(linkedPullRequests(body), [
    { repo: 'intent-hq/intentd', number: 3289 },
    { repo: 'intent-hq/cloudlands-fe', number: 4458 },
    { repo: 'intent-hq/cloudlands-fe', number: 12 },
    { repo: 'intent-hq/intentd', number: 11 },
  ]);
  assert.deepEqual(linkedPullRequests(null), []);
});

test('touchesProtocolDocs includes renames out of docs/protocol', () => {
  assert.equal(touchesProtocolDocs([{ filename: 'docs/protocol/05-method-catalog.md' }]), true);
  assert.equal(touchesProtocolDocs([{ filename: 'docs/old.md', previous_filename: 'docs/protocol/old.md' }]), true);
  assert.equal(touchesProtocolDocs([{ filename: 'docs/ARCHITECTURE.md' }, { filename: 'docs/protocolish.md' }]), false);
});

test('consumerChecksState aggregates the called workflow jobs', () => {
  const route = (conclusion) => job('monorepo-consumer-checks / runner-route / probe', 'completed', conclusion);
  assert.equal(consumerChecksState([job('build', 'completed', 'failure')]), 'none');
  assert.equal(consumerChecksState([route('success'), consumer('completed', 'success')]), 'passed');
  assert.equal(consumerChecksState([route('success'), consumer('completed', 'skipped')]), 'passed');
  assert.equal(consumerChecksState([route('success'), consumer('in_progress')]), 'pending');
  assert.equal(consumerChecksState([route('success'), consumer('completed', 'failure')]), 'failed');
  assert.equal(consumerChecksState([consumer('completed', 'timed_out')]), 'failed');
  assert.equal(consumerChecksState([consumer('completed', 'cancelled')]), 'cancelled');
});

test('decide restarts only stale failed consumer checks', () => {
  const completed = { status: 'completed' };
  const running = { status: 'in_progress' };
  const failed = [consumer('completed', 'failure')];
  const calling = { referenced_workflows: [{ path: 'intent-hq/intent/.github/workflows/consumer-checks.yml@main', sha: OLD }] };
  assert.equal(decide({ run: completed, jobs: [], stale: true }).action, 'skip');
  assert.equal(decide({ run: completed, jobs: failed, stale: true }).action, 'rerun');
  assert.equal(decide({ run: completed, jobs: failed, stale: false }).action, 'skip');
  assert.equal(decide({ run: completed, jobs: [consumer('completed', 'success')], stale: true }).action, 'skip');
  assert.equal(decide({ run: completed, jobs: [consumer('completed', 'cancelled')], stale: true }).action, 'skip');
  assert.equal(decide({ run: running, jobs: failed, stale: true }).action, 'cancel');
  assert.equal(decide({ run: running, jobs: [consumer('queued')], stale: true }).action, 'wait');
  // A queued run whose nested jobs are not listed yet is waited for.
  assert.equal(decide({ run: { ...running, ...calling }, jobs: [], stale: true }).action, 'wait');
  assert.equal(decide({ run: { ...completed, ...calling }, jobs: [], stale: true }).action, 'skip');
  assert.equal(consumerChecksSha(calling), OLD);
  assert.equal(consumerChecksSha({ referenced_workflows: [{ path: 'intent-hq/intent/.github/workflows/docs-pr-scope.yml@main', sha: OLD }] }), null);
});

// A tiny in-memory GitHub: routes map "METHOD /path" (query included) to a
// body or a function of the call count; every request is recorded.
function fakeGitHub(routes) {
  const calls = [];
  const counts = new Map();
  const fetchImpl = async (url, init) => {
    const key = init.method + ' ' + url.replace('https://api.github.com', '');
    calls.push({ key, auth: init.headers.authorization });
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (!(key in routes)) return new Response('missing ' + key, { status: 404 });
    const value = typeof routes[key] === 'function' ? routes[key](count) : routes[key];
    if (value === null) return new Response(null, { status: 201 });
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl, posts: () => calls.filter((call) => call.key.startsWith('POST')).map((call) => call.key) };
}

const docsPr = (body) => ({ number: 9108, title: 'docs(protocol): add things', body, merged_at: MERGED, merge_commit_sha: MERGE, base: { ref: 'main' } });
const resolved = (sha) => ({ referenced_workflows: [{ path: 'intent-hq/intent/.github/workflows/consumer-checks.yml@main', sha }] });
const openPr = (repo, extra = {}) => ({ state: 'open', head: { sha: HEAD, repo: { full_name: repo } }, ...extra });
const runsPath = (repo) => 'GET /repos/' + repo + '/actions/runs?event=pull_request&per_page=100&head_sha=' + HEAD;
const docsRoutes = (body, timeline = []) => ({
  'GET /repos/intent-hq/intent/pulls/9108': docsPr(body),
  'GET /repos/intent-hq/intent/pulls/9108/files?per_page=100': [{ filename: 'docs/protocol/methods/agent.md' }],
  'GET /repos/intent-hq/intent/issues/9108/timeline?per_page=100': timeline,
  ['GET /repos/intent-hq/intent/compare/' + OLD + '...' + MERGE]: { status: 'ahead' },
  ['GET /repos/intent-hq/intent/compare/' + NEW + '...' + MERGE]: { status: 'behind' },
});

function run(fake, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-rerun-'));
  const summary = path.join(dir, 'summary.md');
  writeFileSync(summary, '');
  const sleeps = [];
  let clock = 0;
  const done = main(
    { RERUN_TOKEN: 'rerun', GITHUB_TOKEN: 'mono', PR_NUMBER: '9108', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: summary, WAIT_MINUTES: '5', ...env },
    { fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock },
  );
  return done.then((code) => {
    const text = readFileSync(summary, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return { code, summary: text, sleeps };
  });
}

test('re-runs all jobs on a linked PR whose consumer checks failed before the docs merged', async () => {
  const fake = fakeGitHub({
    ...docsRoutes('intentd: https://github.com/intent-hq/intentd/pull/3289'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [
      { id: 1, workflow_id: 10, created_at: '2026-11-11T22:00:00Z' },
      { id: 2, workflow_id: 10, created_at: '2026-11-11T22:30:00Z' },
      { id: 3, workflow_id: 11, created_at: '2026-11-11T22:30:00Z' },
    ] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'completed', run_started_at: BEFORE, html_url: 'https://example/2' },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'GET /repos/intent-hq/intentd/actions/runs/3': { id: 3, status: 'completed', run_started_at: BEFORE },
    'GET /repos/intent-hq/intentd/actions/runs/3/jobs?filter=latest&per_page=100': { jobs: [job('docs-pr-scope', 'completed', 'failure')] },
    'POST /repos/intent-hq/intentd/actions/runs/2/rerun': null,
  });
  const { code, summary } = await run(fake);
  assert.equal(code, 0);
  // The superseded run 1 is never touched; only the latest run is re-run, and
  // with "Re-run all jobs", never rerun-failed-jobs.
  assert.deepEqual(fake.posts(), ['POST /repos/intent-hq/intentd/actions/runs/2/rerun']);
  assert.ok(!fake.calls.some((call) => call.key.includes('/runs/1')));
  assert.match(summary, /\[intent-hq\/intentd#3289 run 2\]\(https:\/\/example\/2\) \| re-ran all jobs/);
  // Component calls use the rerun token; monorepo reads use GITHUB_TOKEN.
  for (const call of fake.calls) {
    assert.equal(call.auth, call.key.includes('/intent-hq/intent/') ? 'Bearer mono' : 'Bearer rerun', call.key);
  }
});

test('skips closed, fork and fresh PRs and finds cross-referencing PRs', async () => {
  const timeline = [
    { event: 'cross-referenced', source: { issue: { number: 77, pull_request: {}, repository: { full_name: 'intent-hq/cloudlands-fe' } } } },
    { event: 'cross-referenced', source: { issue: { number: 5, repository: { full_name: 'intent-hq/intentd' } } } },
    { event: 'cross-referenced', source: { issue: { number: 6, pull_request: {}, repository: { full_name: 'other/repo' } } } },
  ];
  const fake = fakeGitHub({
    ...docsRoutes('intentd#1 and intentd#2', timeline),
    'GET /repos/intent-hq/intentd/pulls/1': { state: 'closed', merged_at: MERGED },
    'GET /repos/intent-hq/intentd/pulls/2': openPr('someone/intentd'),
    'GET /repos/intent-hq/cloudlands-fe/pulls/77': openPr('intent-hq/cloudlands-fe'),
    [runsPath('intent-hq/cloudlands-fe')]: { workflow_runs: [{ id: 9, workflow_id: 1, created_at: AFTER }] },
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/9': { id: 9, status: 'completed', run_started_at: BEFORE, ...resolved(NEW) },
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/9/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
  });
  const { summary } = await run(fake);
  assert.deepEqual(fake.posts(), []);
  assert.match(summary, /intent-hq\/intentd#1 \| skipped \| PR is merged/);
  assert.match(summary, /intent-hq\/intentd#2 \| skipped \| fork PR/);
  assert.match(summary, /cloudlands-fe#77 run 9 \| skipped \| already checks a monorepo commit with the docs/);
  assert.ok(!fake.calls.some((call) => call.key.includes('/pulls/5') || call.key.includes('/pulls/6')));
});

test('regression: a stale attempt that started after the merge is still re-run (intentd#3289)', async () => {
  // Attempt 2 of run 43066761390 started 34 s after intent#9108 merged yet
  // resolved consumer-checks.yml@main to the older 23e1b23e.
  const fake = fakeGitHub({
    ...docsRoutes('https://github.com/intent-hq/intentd/pull/3289'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [{ id: 2, workflow_id: 1, created_at: BEFORE }] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'completed', run_started_at: '2026-11-11T23:19:06Z', ...resolved(OLD) },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'POST /repos/intent-hq/intentd/actions/runs/2/rerun': null,
  });
  const { code } = await run(fake);
  assert.equal(code, 0);
  assert.deepEqual(fake.posts(), ['POST /repos/intent-hq/intentd/actions/runs/2/rerun']);
});

test('without referenced_workflows, a run started after the merge counts as fresh', async () => {
  const fake = fakeGitHub({
    ...docsRoutes('intentd#3289'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [{ id: 2, workflow_id: 1, created_at: AFTER }] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'completed', run_started_at: AFTER },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
  });
  const { summary } = await run(fake);
  assert.deepEqual(fake.posts(), []);
  assert.match(summary, /run 2 \| skipped \| already checks a monorepo commit with the docs/);
});

test('API errors are reported per run, the rest still run, and the job ends red', async () => {
  const routes = {
    ...docsRoutes('intentd#3289 cloudlands-fe#4458 intentd#3300'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [{ id: 2, workflow_id: 1, created_at: BEFORE }] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'completed', ...resolved(OLD) },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'GET /repos/intent-hq/cloudlands-fe/pulls/4458': openPr('intent-hq/cloudlands-fe'),
    [runsPath('intent-hq/cloudlands-fe')]: { workflow_runs: [{ id: 5, workflow_id: 1, created_at: BEFORE }] },
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/5': (n) => ({ id: 5, status: n < 2 ? 'in_progress' : 'completed', ...resolved(OLD) }),
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/5/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'POST /repos/intent-hq/cloudlands-fe/actions/runs/5/rerun': null,
  };
  const fake = fakeGitHub(routes);
  const inner = fake.fetchImpl;
  fake.fetchImpl = async (url, init) => {
    if (url.endsWith('/intentd/actions/runs/2/rerun')) return new Response('{"message":"too old"}', { status: 403 });
    if (url.endsWith('/cloudlands-fe/actions/runs/5/cancel')) return new Response('{"message":"done"}', { status: 409 });
    if (url.endsWith('/intentd/pulls/3300')) return new Response('{"message":"boom"}', { status: 502 });
    return inner(url, init);
  };
  const { code, summary } = await run(fake);
  assert.equal(code, 1);
  assert.match(summary, /intentd#3289 run 2 \| error \| HTTP 403/);
  assert.match(summary, /intentd#3300 \| error \| HTTP 502/);
  // The 409 on cancel is a finished run: the next poll re-runs it.
  assert.match(summary, /cloudlands-fe#4458 run 5 \| re-ran all jobs/);
});

test('cancels an in-flight run whose checks failed, then re-runs it once it stops', async () => {
  const fake = fakeGitHub({
    ...docsRoutes('cloudlands-fe#4458'),
    'GET /repos/intent-hq/cloudlands-fe/pulls/4458': openPr('intent-hq/cloudlands-fe'),
    [runsPath('intent-hq/cloudlands-fe')]: { workflow_runs: [{ id: 5, workflow_id: 1, created_at: BEFORE }] },
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/5': (n) => ({ id: 5, status: n < 3 ? 'in_progress' : 'completed', run_started_at: BEFORE }),
    'GET /repos/intent-hq/cloudlands-fe/actions/runs/5/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'POST /repos/intent-hq/cloudlands-fe/actions/runs/5/cancel': null,
    'POST /repos/intent-hq/cloudlands-fe/actions/runs/5/rerun': null,
  });
  const { summary, sleeps } = await run(fake);
  assert.deepEqual(fake.posts(), [
    'POST /repos/intent-hq/cloudlands-fe/actions/runs/5/cancel',
    'POST /repos/intent-hq/cloudlands-fe/actions/runs/5/rerun',
  ]);
  assert.equal(sleeps.length, 2);
  assert.match(summary, /re-ran all jobs/);
});

test('waits for running checks, then gives up with a warning at the deadline', async () => {
  const fake = fakeGitHub({
    ...docsRoutes('intentd#3289'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [{ id: 2, workflow_id: 1, created_at: BEFORE }] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'in_progress', run_started_at: BEFORE },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('in_progress')] },
  });
  const { code, summary, sleeps } = await run(fake, { WAIT_MINUTES: '3', POLL_SECONDS: '60' });
  assert.equal(code, 0);
  assert.deepEqual(fake.posts(), []);
  assert.equal(sleeps.length, 3);
  assert.match(summary, /gave up \| still in flight after 3 minutes/);
});

test('dry run reports the plan without cancelling or re-running', async () => {
  const fake = fakeGitHub({
    ...docsRoutes('intentd#3289'),
    'GET /repos/intent-hq/intentd/pulls/3289': openPr('intent-hq/intentd'),
    [runsPath('intent-hq/intentd')]: { workflow_runs: [{ id: 2, workflow_id: 1, created_at: BEFORE }, { id: 3, workflow_id: 2, created_at: BEFORE }] },
    'GET /repos/intent-hq/intentd/actions/runs/2': { id: 2, status: 'completed', run_started_at: BEFORE },
    'GET /repos/intent-hq/intentd/actions/runs/2/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
    'GET /repos/intent-hq/intentd/actions/runs/3': { id: 3, status: 'in_progress', run_started_at: BEFORE },
    'GET /repos/intent-hq/intentd/actions/runs/3/jobs?filter=latest&per_page=100': { jobs: [consumer('completed', 'failure')] },
  });
  const { summary, sleeps } = await run(fake, { DRY_RUN: 'true' });
  assert.deepEqual(fake.posts(), []);
  assert.deepEqual(sleeps, []);
  assert.match(summary, /run 2 \| would re-run/);
  assert.match(summary, /run 3 \| would cancel and re-run/);
});

test('push events read every merged PR in the push and ignore PRs without protocol docs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-rerun-event-'));
  const eventPath = path.join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before: 'a'.repeat(40), after: 'b'.repeat(40) }));
  const fake = fakeGitHub({
    ['GET /repos/intent-hq/intent/compare/' + 'a'.repeat(40) + '...' + 'b'.repeat(40)]: { commits: [{ sha: 's1' }, { sha: 's2' }] },
    'GET /repos/intent-hq/intent/commits/s1/pulls': [{ number: 9108, merged_at: MERGED, base: { ref: 'main' } }],
    'GET /repos/intent-hq/intent/commits/s2/pulls': [{ number: 9109, merged_at: MERGED, base: { ref: 'main' } }, { number: 1, merged_at: null, base: { ref: 'main' } }],
    ...docsRoutes(''),
    'GET /repos/intent-hq/intent/pulls/9109': { ...docsPr('intentd#1'), number: 9109 },
    'GET /repos/intent-hq/intent/pulls/9109/files?per_page=100': [{ filename: 'Makefile' }],
  });
  const { summary } = await run(fake, { PR_NUMBER: '', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath });
  rmSync(dir, { recursive: true, force: true });
  assert.match(summary, /Docs PRs: #9108\n/);
  assert.match(summary, /No linked open intentd or cloudlands-fe PR/);
  assert.ok(!fake.calls.some((call) => call.key.includes('/pulls/1')));
});

test('paginates through Link headers', async () => {
  const pages = {
    'GET /repos/intent-hq/intent/pulls/9108/files?per_page=100': { body: [{ filename: 'README.md' }], next: 'https://api.github.com/repos/intent-hq/intent/pulls/9108/files?per_page=100&page=2' },
    'GET /repos/intent-hq/intent/pulls/9108/files?per_page=100&page=2': { body: [{ filename: 'docs/protocol/x.md' }] },
  };
  const fake = fakeGitHub({ ...docsRoutes('intentd#3289'), 'GET /repos/intent-hq/intentd/pulls/3289': { state: 'closed' } });
  const inner = fake.fetchImpl;
  const fetchImpl = async (url, init) => {
    const page = pages['GET ' + url.replace('https://api.github.com', '')];
    if (!page) return inner(url, init);
    const headers = page.next ? { link: '<' + page.next + '>; rel="next"' } : {};
    return new Response(JSON.stringify(page.body), { status: 200, headers });
  };
  const { summary } = await run({ ...fake, fetchImpl });
  assert.match(summary, /intent-hq\/intentd#3289 \| skipped \| PR is closed/);
});

test('missing RERUN_TOKEN is a warning, not a failure', async () => {
  const fake = fakeGitHub({});
  const { code } = await run(fake, { RERUN_TOKEN: '' });
  assert.equal(code, 0);
  assert.deepEqual(fake.calls, []);
});

test('the workflow runs main\'s script on docs/protocol pushes with the rerun token', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/consumer-checks-docs-rerun.yml'), 'utf8');
  assert.match(workflow, /push:\n\s+branches: \[main\]\n\s+paths:\n\s+- 'docs\/protocol\/\*\*'/);
  assert.match(workflow, /ref: main/);
  // The secret lives in a main-only environment, never a repository secret.
  assert.match(workflow, /\n    if: github\.ref == 'refs\/heads\/main'\n    environment: consumer-checks-rerun\n/);
  assert.match(workflow, /RERUN_TOKEN: \$\{\{ secrets\.CONSUMER_CHECKS_RERUN_TOKEN \}\}/);
  assert.match(workflow, /run: node scripts\/consumer-checks-docs-rerun\.mjs/);
});
