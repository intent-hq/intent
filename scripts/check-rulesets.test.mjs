import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  API_BASE,
  CI_WORKFLOW,
  REPOS,
  crossCheckWorkflow,
  diffRules,
  fetchFromFixture,
  fetchLiveRules,
  formatSnapshot,
  normalizeRules,
  run,
  snapshotPath,
  workflowJobNames,
} from './check-rulesets.mjs';
import { cleanNodeEnv } from './test-env.mjs';

const scriptPath = fileURLToPath(new URL('./check-rulesets.mjs', import.meta.url));

const orgSource = { ruleset_source_type: 'Organization', ruleset_source: 'intent-hq', ruleset_id: 21072618 };
const repoSource = (repo) => ({ ruleset_source_type: 'Repository', ruleset_source: `intent-hq/${repo}`, ruleset_id: 1 });

function pullRequestParameters(extra = {}) {
  return {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    required_reviewers: [],
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: true,
    require_extra_approval_for_unattributed_changes: true,
    allowed_merge_methods: ['squash', 'rebase'],
    ...extra,
  };
}

export function liveRules(repo) {
  return [
    { type: 'deletion', ...orgSource },
    { type: 'non_fast_forward', ...orgSource },
    { type: 'pull_request', parameters: pullRequestParameters(), ...orgSource },
    { type: 'deletion', ...repoSource(repo) },
    {
      type: 'pull_request',
      parameters: pullRequestParameters({ dismissal_restriction: { enabled: false, allowed_actors: [] } }),
      ...repoSource(repo),
    },
    {
      type: 'merge_queue',
      parameters: {
        merge_method: 'SQUASH',
        max_entries_to_build: 5,
        min_entries_to_merge: 1,
        max_entries_to_merge: 5,
        min_entries_to_merge_wait_minutes: 0,
        grouping_strategy: 'ALLGREEN',
        check_response_timeout_minutes: 60,
      },
      ...repoSource(repo),
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: 'CI Gate', integration_id: 15368 }],
      },
      ...repoSource(repo),
    },
  ];
}

const clone = (value) => structuredClone(value);

function withRule(rules, type, mutate) {
  const copy = clone(rules);
  mutate(copy.find((rule) => rule.type === type && rule.ruleset_source_type === 'Repository'));
  return copy;
}

const workflow = ['jobs:', '  docs-check:', '    runs-on: ubuntu-latest', '  gate:', '    name: CI Gate', '    steps:', '      - name: Check results'].join('\n');

function fixtureFor(overrides = {}) {
  return Object.fromEntries(REPOS.map((repo) => [repo, overrides[repo] ?? liveRules(repo)]));
}

// A repository root holding committed snapshots that match `liveRules` and a
// ci.yml whose gate job is named CI Gate.
function makeRepo(t, { snapshots = true, workflowText = workflow } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rulesets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, path.dirname(CI_WORKFLOW)), { recursive: true });
  fs.writeFileSync(path.join(root, CI_WORKFLOW), `${workflowText}\n`);
  if (snapshots) {
    fs.mkdirSync(path.join(root, path.dirname(snapshotPath('intent'))), { recursive: true });
    for (const repo of REPOS) fs.writeFileSync(path.join(root, snapshotPath(repo)), formatSnapshot(liveRules(repo)));
  }
  return root;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, stdout: { log: (line) => out.push(String(line)) }, stderr: { error: (line) => err.push(String(line)) } };
}

async function runWith(t, fixture, argv = [], repoOptions = {}) {
  const cwd = makeRepo(t, repoOptions);
  const io = capture();
  const exitCode = await run(argv, {
    cwd,
    env: {},
    fetchImpl: fetchFromFixture(fixture),
    stdout: io.stdout,
    stderr: io.stderr,
  });
  return { exitCode, cwd, stdout: io.out.join('\n'), stderr: io.err.join('\n') };
}

test('matching live rules exit 0', async (t) => {
  const result = await runWith(t, fixtureFor());
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /intent-hq\/intent: live main branch rules match/);
  assert.match(result.stdout, /intent-hq\/cloudlands-fe: live main branch rules match/);
  assert.equal(result.stderr, '');
});

test('a missing required check is drift naming the context', async (t) => {
  const live = withRule(liveRules('intentd'), 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks = [];
  });
  const result = await runWith(t, fixtureFor({ intentd: live }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /intent-hq\/intentd: live main branch rules differ from \.github\/rulesets\/intentd\.main\.json/);
  assert.match(result.stderr, /required_status_checks\[\] context "CI Gate" missing/);
  assert.match(result.stderr, /^-\s+"context": "CI Gate",$/m);
  assert.match(result.stderr, /make check-rulesets UPDATE=1/);
  assert.doesNotMatch(result.stderr, /intent-hq\/intent:/);
});

test('thread resolution switched off is drift naming the parameter', async (t) => {
  const live = withRule(liveRules('intent'), 'pull_request', (rule) => {
    rule.parameters.required_review_thread_resolution = false;
  });
  const result = await runWith(t, fixtureFor({ intent: live }));
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /Repository intent-hq\/intent rule pull_request parameters\.required_review_thread_resolution expected true, live false/,
  );
});

test('a changed merge-queue parameter is drift', async (t) => {
  const live = withRule(liveRules('cloudlands-fe'), 'merge_queue', (rule) => {
    rule.parameters.grouping_strategy = 'HEADGREEN';
  });
  const result = await runWith(t, fixtureFor({ 'cloudlands-fe': live }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /rule merge_queue parameters\.grouping_strategy expected "ALLGREEN", live "HEADGREEN"/);
});

test('an extra live rule is drift and a dropped rule is named', async (t) => {
  const extra = [...liveRules('intent'), { type: 'required_signatures', ...repoSource('intent') }];
  const dropped = liveRules('intent').filter((rule) => rule.type !== 'merge_queue');
  const added = await runWith(t, fixtureFor({ intent: extra }));
  assert.equal(added.exitCode, 1);
  assert.match(added.stderr, /Repository intent-hq\/intent rule required_signatures unexpected/);
  const removed = await runWith(t, fixtureFor({ intent: dropped }));
  assert.equal(removed.exitCode, 1);
  assert.match(removed.stderr, /Repository intent-hq\/intent rule merge_queue missing/);
});

test('a second rule of the same source and type is not collapsed', async (t) => {
  const base = liveRules('intent');
  const checksRule = base.find((rule) => rule.type === 'required_status_checks');
  const second = clone(checksRule);
  second.ruleset_id = 2;
  second.parameters.required_status_checks = [{ context: 'Additional Required Check', integration_id: 15368 }];

  const added = await runWith(t, fixtureFor({ intent: [...base, second] }));
  assert.equal(added.exitCode, 1, 'an additional same-type rule must be drift');
  assert.match(added.stderr, /Repository intent-hq\/intent rule required_status_checks .*"context":"Additional Required Check".* unexpected/);
  assert.match(added.stderr, /^\+\s+"context": "Additional Required Check",$/m);

  const cwd = makeRepo(t, { workflowText: `${workflow}\n  extra:\n    name: Additional Required Check` });
  fs.writeFileSync(path.join(cwd, snapshotPath('intent')), formatSnapshot([...base, second]));
  const dropped = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: fetchFromFixture({ intent: base }), ...dropped }), 1);
  assert.match(dropped.err.join('\n'), /rule required_status_checks .*"Additional Required Check".* missing/);

  const changed = clone(second);
  changed.parameters.required_status_checks[0].context = 'Renamed Check';
  const renamed = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: fetchFromFixture({ intent: [...base, changed] }), ...renamed }), 1);
  assert.match(renamed.err.join('\n'), /required_status_checks\[\] context "Additional Required Check" missing/);
  assert.match(renamed.err.join('\n'), /required_status_checks\[\] context "Renamed Check" unexpected/);

  const reordered = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: fetchFromFixture({ intent: [second, ...base] }), ...reordered }), 0, reordered.err.join('\n'));
  assert.deepEqual(diffRules([...base, second], [second, ...base]), []);
  assert.deepEqual(diffRules([...base, second, second], [second, ...base, second]), []);
  assert.deepEqual(diffRules([...base, second, second], [second, ...base]), [
    `Repository intent-hq/intent rule required_status_checks ${JSON.stringify(normalizeRules([second])[0].parameters)} missing`,
  ]);
});

test('a repeated check context with a different integration id is not collapsed', async (t) => {
  const base = liveRules('intent');
  const withDuplicate = withRule(base, 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks.push({ context: 'CI Gate', integration_id: 100 });
  });
  const prefix = 'Repository intent-hq/intent rule required_status_checks parameters.required_status_checks[] context "CI Gate"';

  const added = await runWith(t, fixtureFor({ intent: withDuplicate }));
  assert.equal(added.exitCode, 1, 'an added duplicate context must be drift');
  assert.match(added.stderr, /context "CI Gate" \{"context":"CI Gate","integration_id":100\} unexpected/);
  assert.match(added.stderr, /^\+\s+"integration_id": 100$/m);
  assert.deepEqual(diffRules(base, withDuplicate), [`${prefix} {"context":"CI Gate","integration_id":100} unexpected`]);
  assert.deepEqual(diffRules(withDuplicate, base), [`${prefix} {"context":"CI Gate","integration_id":100} missing`]);

  const changed = withRule(withDuplicate, 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks[1].integration_id = 101;
  });
  assert.deepEqual(diffRules(withDuplicate, changed), [
    `${prefix} {"context":"CI Gate","integration_id":100}.integration_id expected 100, live 101`,
  ]);

  const reordered = withRule(withDuplicate, 'required_status_checks', (rule) => rule.parameters.required_status_checks.reverse());
  assert.deepEqual(diffRules(withDuplicate, reordered), []);
  const cwd = makeRepo(t);
  fs.writeFileSync(path.join(cwd, snapshotPath('intent')), formatSnapshot(withDuplicate));
  const io = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: fetchFromFixture({ intent: reordered }), ...io }), 0, io.err.join('\n'));
});

test('normalized snapshots that differ never compare clean', () => {
  const base = liveRules('intent');
  const live = clone(base);
  live.find((rule) => rule.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'CI Gate', integration_id: 100 });
  const extraRule = clone(base.find((rule) => rule.type === 'required_status_checks'));
  extraRule.parameters.required_status_checks = [{ context: 'Additional Required Check', integration_id: 15368 }];
  for (const candidate of [live, [...base, extraRule], [...base, clone(base[0])]]) {
    assert.notEqual(formatSnapshot(base), formatSnapshot(candidate));
    assert.ok(diffRules(base, candidate).length > 0, formatSnapshot(candidate));
    assert.ok(diffRules(candidate, base).length > 0, formatSnapshot(candidate));
  }
  assert.deepEqual(diffRules([...base, clone(base[0])], base), ['Organization intent-hq rule deletion {} missing']);
});

test('key order, array order and ruleset ids do not count as drift', async (t) => {
  const shuffled = clone(liveRules('intent')).reverse();
  for (const rule of shuffled) {
    rule.ruleset_id = 999;
    if (rule.parameters) {
      rule.parameters = Object.fromEntries(Object.entries(rule.parameters).reverse());
      if (rule.parameters.allowed_merge_methods) rule.parameters.allowed_merge_methods.reverse();
    }
  }
  const checks = shuffled.find((rule) => rule.type === 'required_status_checks');
  checks.parameters.required_status_checks = [{ integration_id: 15368, context: 'CI Gate' }];
  assert.deepEqual(diffRules(liveRules('intent'), shuffled), []);
  assert.equal(formatSnapshot(shuffled), formatSnapshot(liveRules('intent')));
  const result = await runWith(t, fixtureFor({ intent: shuffled }));
  assert.equal(result.exitCode, 0, result.stderr);
});

test('two required checks in any order compare equal, and a swapped one is named', () => {
  const two = withRule(liveRules('intent'), 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks.push({ context: 'Lint', integration_id: 15368 });
  });
  const reversed = withRule(two, 'required_status_checks', (rule) => rule.parameters.required_status_checks.reverse());
  assert.deepEqual(diffRules(two, reversed), []);
  const renamed = withRule(two, 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks[1].context = 'Lint2';
  });
  assert.deepEqual(diffRules(two, renamed), [
    'Repository intent-hq/intent rule required_status_checks parameters.required_status_checks[] context "Lint" missing',
    'Repository intent-hq/intent rule required_status_checks parameters.required_status_checks[] context "Lint2" unexpected',
  ]);
});

test('transient failures warn and exit 0', async (t) => {
  for (const failure of [
    { status: 503, body: { message: 'unavailable' } },
    { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: { message: 'rate limited' } },
    { status: 429, headers: { 'retry-after': '30' }, body: { message: 'slow down' } },
    { status: 429, body: { message: 'slow down' } },
    {
      status: 403,
      headers: { 'x-ratelimit-remaining': '4000' },
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
    },
    {
      status: 403,
      headers: { 'x-ratelimit-remaining': '4000' },
      body: { message: 'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.' },
    },
    { error: 'getaddrinfo ENOTFOUND api.github.com' },
  ]) {
    const result = await runWith(t, fixtureFor({ intentd: failure }));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stdout,
      /^::warning::check-rulesets: could not read live main branch rules for intent-hq\/intentd: .*; skipping intentd\.$/m,
    );
    assert.match(result.stdout, /intent-hq\/intent: live main branch rules match/);
  }
});

test('a transient failure on one repository does not hide drift on another', async (t) => {
  const live = withRule(liveRules('intent'), 'merge_queue', (rule) => {
    rule.parameters.check_response_timeout_minutes = 5;
  });
  const result = await runWith(t, fixtureFor({ intent: live, intentd: { status: 502 } }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /check_response_timeout_minutes expected 60, live 5/);
  assert.match(result.stdout, /::warning::.*intentd/);
});

test('404, 401 and a non-rate-limited 403 are configuration errors (exit 2)', async (t) => {
  for (const failure of [
    { status: 404, body: { message: 'nope' } },
    { status: 401, body: { message: 'nope' } },
    { status: 403, body: { message: 'nope' } },
    { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: { message: 'Resource not accessible by integration' } },
    { status: 403, body: '<html>forbidden</html>' },
  ]) {
    const result = await runWith(t, fixtureFor({ 'cloudlands-fe': failure }));
    assert.equal(result.exitCode, 2, `status ${failure.status}`);
    assert.match(result.stderr, new RegExp(`check-rulesets: intent-hq/cloudlands-fe: HTTP ${failure.status}`));
    assert.doesNotMatch(result.stdout, /::warning::/);
  }
  const missing = await runWith(t, {});
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /HTTP 404/);
});

// A real server, because fetch resolves on headers: the failure under test
// happens while the body is read, which a canned Response cannot reproduce.
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  return { apiBase, fetchImpl: (url, init) => fetch(String(url).replace(API_BASE, apiBase), init) };
}

test('a body cut off after a 200 header is transient, not a malformed response', async (t) => {
  let status = 200;
  const partial = await serve(t, (request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
    response.write('[{"type":"deletion","ruleset_source_type":"Repository",');
    setTimeout(() => request.socket.destroy(), 10);
  });
  await assert.rejects(fetchLiveRules('intent', { fetchImpl: fetch, apiBase: partial.apiBase }), (error) => {
    assert.equal(error.transient, true, error.message);
    assert.match(error.message, /^intent-hq\/intent: HTTP 200, body read failed \(/);
    return true;
  });
  const cwd = makeRepo(t);
  const io = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: partial.fetchImpl, ...io }), 0, io.err.join('\n'));
  assert.match(io.out.join('\n'), /^::warning::check-rulesets: could not read live main branch rules for intent-hq\/intent: HTTP 200, body read failed/m);
  assert.equal(io.err.join('\n'), '');

  for (status of [401, 404]) {
    await assert.rejects(fetchLiveRules('intent', { fetchImpl: fetch, apiBase: partial.apiBase }), {
      message: `intent-hq/intent: HTTP ${status} reading ${partial.apiBase}/repos/intent-hq/intent/rules/branches/main`,
      transient: false,
    });
    const definite = capture();
    assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: partial.fetchImpl, ...definite }), 2, `interrupted ${status} body must stay a configuration error`);
    assert.match(definite.err.join('\n'), new RegExp(`check-rulesets: intent-hq/intent: HTTP ${status} reading`));
    assert.doesNotMatch(definite.out.join('\n'), /::warning::/);
  }
});

test('a complete but non-JSON body is a configuration error (exit 2)', async (t) => {
  const html = await serve(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><body>maintenance</body></html>');
  });
  await assert.rejects(fetchLiveRules('intent', { fetchImpl: fetch, apiBase: html.apiBase }), {
    message: 'intent-hq/intent: response is not JSON',
    transient: false,
  });
  const cwd = makeRepo(t);
  const io = capture();
  assert.equal(await run(['--repo', 'intent'], { cwd, env: {}, fetchImpl: html.fetchImpl, ...io }), 2);
  assert.match(io.err.join('\n'), /check-rulesets: intent-hq\/intent: response is not JSON/);
  assert.doesNotMatch(io.out.join('\n'), /::warning::/);
  const truncatedJson = await runWith(t, fixtureFor({ intent: { status: 200, body: '[{"type":"deletion"' } }));
  assert.equal(truncatedJson.exitCode, 2, 'a fixture body that ends early is a complete document, so still exit 2');
  assert.match(truncatedJson.stderr, /response is not JSON/);
});

test('a missing or malformed committed snapshot is a configuration error', async (t) => {
  const missing = await runWith(t, fixtureFor(), [], { snapshots: false });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /intent\.main\.json is missing; run `make check-rulesets UPDATE=1`/);
  const cwd = makeRepo(t);
  fs.writeFileSync(path.join(cwd, snapshotPath('intentd')), '{"not":"an array"}\n');
  const io = capture();
  const exitCode = await run([], { cwd, env: {}, fetchImpl: fetchFromFixture(fixtureFor()), ...io });
  assert.equal(exitCode, 2);
  assert.match(io.err.join('\n'), /intentd\.main\.json: expected a JSON array of rules/);
});

test('--update writes normalized snapshots that a re-run reproduces byte for byte', async (t) => {
  const live = clone(liveRules('intent')).reverse();
  live[0].ruleset_id = 42;
  const fixture = fixtureFor({ intent: live });
  const result = await runWith(t, fixture, ['--update'], { snapshots: false });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Wrote \.github\/rulesets\/intent\.main\.json/);
  const written = fs.readFileSync(path.join(result.cwd, snapshotPath('intent')), 'utf8');
  assert.equal(written, formatSnapshot(liveRules('intent')));
  assert.doesNotMatch(written, /ruleset_id/);
  assert.ok(written.endsWith('\n'));
  assert.equal(JSON.stringify(JSON.parse(written)), JSON.stringify(normalizeRules(JSON.parse(written))));

  const io = { env: {}, fetchImpl: fetchFromFixture(fixture), ...capture() };
  assert.equal(await run(['--update'], { cwd: result.cwd, ...io }), 0);
  assert.equal(fs.readFileSync(path.join(result.cwd, snapshotPath('intent')), 'utf8'), written);
  assert.equal(await run([], { cwd: result.cwd, ...io }), 0);
});

test('--update leaves a snapshot untouched on a transient failure', async (t) => {
  const result = await runWith(t, fixtureFor({ intentd: { status: 500 } }), ['--update', '--repo', 'intentd']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /::warning::/);
  assert.equal(fs.readFileSync(path.join(result.cwd, snapshotPath('intentd')), 'utf8'), formatSnapshot(liveRules('intentd')));
});

test('--repo limits the check to one repository', async (t) => {
  const result = await runWith(t, { intentd: liveRules('intentd') }, ['--repo', 'intentd']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /intent-hq\/intentd: live main branch rules match/);
  assert.doesNotMatch(result.stdout, /intent-hq\/intent:/);
  const unknown = await runWith(t, fixtureFor(), ['--repo', 'other']);
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.stderr, /unknown repository other/);
  const usage = await runWith(t, fixtureFor(), ['--bogus']);
  assert.equal(usage.exitCode, 2);
  assert.match(usage.stderr, /usage: check-rulesets\.mjs/);
});

test('required check contexts must name a ci.yml job for the monorepo only', async (t) => {
  assert.deepEqual([...workflowJobNames(workflow)], ['CI Gate']);
  assert.deepEqual([...workflowJobNames('jobs:\n  gate:\n    name: "CI Gate"\n')], ['CI Gate']);
  assert.deepEqual(crossCheckWorkflow(liveRules('intent'), workflow), []);
  assert.deepEqual(crossCheckWorkflow(liveRules('intent'), workflow.replace('CI Gate', 'Gate')), [
    'required check "CI Gate" is not the name: of any job in .github/workflows/ci.yml',
  ]);

  const renamed = await runWith(t, fixtureFor(), [], { workflowText: workflow.replace('name: CI Gate', 'name: CI Gate v2') });
  assert.equal(renamed.exitCode, 1);
  assert.match(renamed.stderr, /^intent-hq\/intent: required check "CI Gate" is not the name: of any job in \.github\/workflows\/ci\.yml$/m);
  assert.doesNotMatch(renamed.stderr, /make check-rulesets UPDATE=1/);

  const nested = await runWith(t, fixtureFor(), [], { workflowText: workflow.replace('    name: CI Gate', '      name: CI Gate') });
  assert.equal(nested.exitCode, 1, 'a step named CI Gate is not a job');

  const otherRepos = await runWith(t, fixtureFor({ intentd: liveRules('intentd') }), ['--repo', 'intentd'], {
    workflowText: 'jobs:\n  build:\n    runs-on: ubuntu-latest\n',
  });
  assert.equal(otherRepos.exitCode, 0, otherRepos.stderr);

  const updated = await runWith(t, fixtureFor(), ['--update', '--repo', 'intent'], {
    snapshots: false,
    workflowText: workflow.replace('CI Gate', 'Renamed'),
  });
  assert.equal(updated.exitCode, 1, '--update still cross-checks the freshly written rules');
});

test('fetchLiveRules sends the token as a bearer header only when set', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return Response.json([]);
  };
  await fetchLiveRules('intent', { fetchImpl });
  await fetchLiveRules('intentd', { fetchImpl, token: 'tok' });
  assert.equal(seen[0].url, 'https://api.github.com/repos/intent-hq/intent/rules/branches/main');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(seen[1].headers.Authorization, 'Bearer tok');
  await assert.rejects(fetchLiveRules('intent', { fetchImpl: async () => Response.json({ message: 'no' }) }), {
    message: 'intent-hq/intent: response is not a rules array',
    transient: false,
  });
});

test('the CLI reads a --fixture file and reports the exit code', (t) => {
  const cwd = makeRepo(t);
  const fixtureFile = path.join(cwd, 'fixture.json');
  const drifted = withRule(liveRules('intent'), 'required_status_checks', (rule) => {
    rule.parameters.required_status_checks[0].context = 'Other Gate';
  });
  const spawn = (fixture) => {
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
    try {
      return { status: 0, stdout: execFileSync('node', [scriptPath, '--fixture', fixtureFile], { cwd, encoding: 'utf8', env: cleanNodeEnv(), stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const ok = spawn(fixtureFor());
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /intent-hq\/intent: live main branch rules match/);
  const drift = spawn(fixtureFor({ intent: drifted }));
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /context "CI Gate" missing/);
  assert.match(drift.stderr, /context "Other Gate" unexpected/);
  const missing = spawn({ intent: liveRules('intent'), intentd: liveRules('intentd') });
  assert.equal(missing.status, 2);
  const transient = spawn(fixtureFor({ intent: { status: 500 } }));
  assert.equal(transient.status, 0, transient.stderr);
  assert.match(transient.stdout, /::warning::/);
});
