#!/usr/bin/env node
//
// Start fresh monorepo-consumer-checks on the component PRs a merged
// docs/protocol PR links, so nobody has to remember which rerun button works.
//
// Why: a component PR whose consumer checks fail because the monorepo docs
// lag lands those docs first, then needs a new check run. "Re-run failed
// jobs" keeps the monorepo commit its first attempt resolved, so it fails
// again: intentd#3289's run 43066761390 attempt 2 reused monorepo 23e1b23e
// after intent#9108 merged and cost a ~20 minute CI cycle. GitHub resolves a
// reusable workflow's @main again only for a new run or "Re-run all jobs"
// (POST /actions/runs/{id}/rerun), and a pull_request run cannot be created
// without pushing to the PR branch, so this script re-runs all jobs.
// scripts/consumer-checks-stale-rerun.sh stays as the backstop explainer.
//
// Driven by .github/workflows/consumer-checks-docs-rerun.yml:
//   push to main touching docs/protocol/**  every merged PR in the push
//   workflow_dispatch with PR_NUMBER       that merged monorepo PR
// Environment:
//   GITHUB_TOKEN    reads the monorepo (PRs, files, timeline).
//   RERUN_TOKEN     actions:write + pull-requests:read on intentd and
//                   cloudlands-fe; absent means warn and exit 0 (fail-soft).
//   PR_NUMBER       workflow_dispatch input; overrides the push event.
//   DRY_RUN=true    report the plan without cancelling or re-running.
//   WAIT_MINUTES    how long to wait for in-flight runs (default 45).
//   POLL_SECONDS    poll interval while waiting (default 60).
//
// A linked PR is an open, same-repository intentd or cloudlands-fe PR that
// the docs PR's title or body names (URL, owner/repo#N or repo#N), or that
// cross-references the docs PR. For each, the latest run per workflow on its
// head commit that has monorepo-consumer-checks jobs is restarted only when
// it started before the docs merged and those jobs failed; an in-flight run
// whose checks already failed is cancelled first, and one still running them
// is waited for.

import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MONOREPO = 'intent-hq/intent';
export const COMPONENTS = ['intent-hq/intentd', 'intent-hq/cloudlands-fe'];
export const PROTOCOL_DOCS = 'docs/protocol/';
export const CONSUMER_JOB = 'monorepo-consumer-checks';

const REFERENCE = /(?:https:\/\/github\.com\/|\b)(?:intent-hq\/)?(intentd|cloudlands-fe)(?:\/pull\/|#)(\d+)\b/g;

// Component PR references in free text, deduplicated, in order of appearance.
export function linkedPullRequests(text) {
  const seen = new Map();
  for (const match of String(text ?? '').matchAll(REFERENCE)) {
    const repo = 'intent-hq/' + match[1];
    const number = Number(match[2]);
    seen.set(repo + '#' + number, { repo, number });
  }
  return [...seen.values()];
}

export function touchesProtocolDocs(files) {
  return files.some((file) => [file.filename, file.previous_filename].some((name) => name?.startsWith(PROTOCOL_DOCS)));
}

// Aggregate the monorepo-consumer-checks jobs of one run attempt (the called
// workflow's jobs are named "monorepo-consumer-checks / <job>").
export function consumerChecksState(jobs) {
  const ours = jobs.filter((job) => job.name === CONSUMER_JOB || job.name.startsWith(CONSUMER_JOB + ' / '));
  if (ours.length === 0) return 'none';
  if (ours.some((job) => job.status === 'completed' && ['failure', 'timed_out'].includes(job.conclusion))) return 'failed';
  if (ours.some((job) => job.status !== 'completed')) return 'pending';
  if (ours.some((job) => job.conclusion === 'cancelled')) return 'cancelled';
  return 'passed';
}

// What to do with one run, given its latest-attempt jobs and the docs merge time.
export function decide({ run, jobs, mergedAt }) {
  const state = consumerChecksState(jobs);
  if (state === 'none') return { action: 'skip', reason: 'no monorepo-consumer-checks job' };
  const started = Date.parse(run.run_started_at ?? run.created_at);
  if (started >= Date.parse(mergedAt)) return { action: 'skip', reason: 'attempt started after the docs merged' };
  if (state === 'passed') return { action: 'skip', reason: 'monorepo-consumer-checks passed' };
  if (state === 'cancelled') return { action: 'skip', reason: 'monorepo-consumer-checks were cancelled' };
  if (state === 'pending') return { action: 'wait', reason: 'monorepo-consumer-checks still running against the old docs' };
  if (run.status !== 'completed') return { action: 'cancel', reason: 'monorepo-consumer-checks failed; cancelling the in-flight run first' };
  return { action: 'rerun', reason: 'monorepo-consumer-checks failed against the old docs' };
}

export function createGitHub({ fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com', tokenFor }) {
  async function request(method, pathOrUrl, repo) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : apiUrl + pathOrUrl;
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + tokenFor(repo),
        'x-github-api-version': '2022-11-28',
        'user-agent': 'intent-consumer-checks-docs-rerun',
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(method + ' ' + url + ' -> ' + response.status + ' ' + body.slice(0, 200));
      error.status = response.status;
      throw error;
    }
    const text = response.status === 204 ? '' : await response.text();
    return { data: text ? JSON.parse(text) : null, link: response.headers.get('link') ?? '' };
  }
  return {
    async get(repo, path) {
      return (await request('GET', '/repos/' + repo + path, repo)).data;
    },
    // Follows rel="next"; `key` picks the array out of wrapped responses.
    async list(repo, path, key) {
      const items = [];
      let next = '/repos/' + repo + path;
      while (next) {
        const { data, link } = await request('GET', next, repo);
        items.push(...(key ? data[key] : data));
        next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? '';
      }
      return items;
    },
    async post(repo, path) {
      return (await request('POST', '/repos/' + repo + path, repo)).data;
    },
  };
}

const withPage = (path) => path + (path.includes('?') ? '&' : '?') + 'per_page=100';

// Merged monorepo PRs into main that changed docs/protocol, for this event.
export async function docsPullRequests(gh, { eventName, event, prNumber }) {
  let numbers;
  if (prNumber) {
    numbers = [Number(prNumber)];
  } else if (eventName === 'push') {
    if (!event.before || /^0+$/.test(event.before)) return [];
    const compare = await gh.get(MONOREPO, '/compare/' + event.before + '...' + event.after);
    numbers = [];
    for (const commit of compare.commits ?? []) {
      const pulls = await gh.get(MONOREPO, '/commits/' + commit.sha + '/pulls');
      numbers.push(...pulls.filter((pr) => pr.merged_at && pr.base?.ref === 'main').map((pr) => pr.number));
    }
  } else {
    throw new Error('unsupported event ' + eventName + ' without PR_NUMBER');
  }
  const result = [];
  for (const number of [...new Set(numbers)]) {
    const pr = await gh.get(MONOREPO, '/pulls/' + number);
    if (!pr.merged_at || pr.base?.ref !== 'main') {
      console.log('#' + number + ': not merged into main; skipped');
      continue;
    }
    const files = await gh.list(MONOREPO, withPage('/pulls/' + number + '/files'));
    if (!touchesProtocolDocs(files)) {
      console.log('#' + number + ': no ' + PROTOCOL_DOCS + ' change; skipped');
      continue;
    }
    result.push(pr);
  }
  return result;
}

// Component PRs a docs PR links, in either direction.
export async function linkedTargets(gh, pr) {
  const links = linkedPullRequests((pr.title ?? '') + '\n' + (pr.body ?? ''));
  const timeline = await gh.list(MONOREPO, withPage('/issues/' + pr.number + '/timeline'));
  for (const item of timeline) {
    const source = item.event === 'cross-referenced' ? item.source?.issue : null;
    const repo = source?.repository?.full_name;
    if (source?.pull_request && COMPONENTS.includes(repo)) links.push({ repo, number: source.number });
  }
  const unique = new Map(links.filter((link) => COMPONENTS.includes(link.repo)).map((link) => [link.repo + '#' + link.number, link]));
  return [...unique.values()];
}

// The runs to consider for one component PR: its head commit's latest run
// per workflow (a newer run supersedes older ones on the same commit).
async function candidateRuns(gh, repo, headSha) {
  const runs = await gh.list(repo, '/actions/runs?event=pull_request&per_page=100&head_sha=' + headSha, 'workflow_runs');
  const latest = new Map();
  for (const run of runs) {
    const current = latest.get(run.workflow_id);
    if (!current || Date.parse(run.created_at) > Date.parse(current.created_at)) latest.set(run.workflow_id, run);
  }
  return [...latest.values()];
}

export async function restart(gh, targets, options) {
  const { dryRun = false, sleep, now = () => Date.now(), waitMs = 45 * 60_000, pollMs = 60_000, log = console.log } = options;
  const results = [];
  const work = [];
  for (const target of targets) {
    const label = target.repo + '#' + target.number;
    let pr;
    try {
      pr = await gh.get(target.repo, '/pulls/' + target.number);
    } catch (error) {
      if (error.status !== 404) throw error;
      results.push({ label, outcome: 'skipped', reason: 'not a pull request' });
      continue;
    }
    if (pr.state !== 'open') {
      results.push({ label, outcome: 'skipped', reason: 'PR is ' + (pr.merged_at ? 'merged' : pr.state) });
      continue;
    }
    if (pr.head?.repo?.full_name !== target.repo) {
      results.push({ label, outcome: 'skipped', reason: 'fork PR (consumer checks do not run)' });
      continue;
    }
    const runs = await candidateRuns(gh, target.repo, pr.head.sha);
    if (runs.length === 0) results.push({ label, outcome: 'skipped', reason: 'no pull_request run on ' + pr.head.sha.slice(0, 7) });
    if (runs.length > 0) results.push({ label, outcome: 'checked', reason: runs.length + ' run(s) on ' + pr.head.sha.slice(0, 7) });
    for (const run of runs) work.push({ ...target, label: label + ' run ' + run.id, runId: run.id });
  }

  const deadline = now() + waitMs;
  let pending = work;
  while (pending.length > 0) {
    const next = [];
    for (const item of pending) {
      const run = await gh.get(item.repo, '/actions/runs/' + item.runId);
      const jobs = await gh.list(item.repo, '/actions/runs/' + item.runId + '/jobs?filter=latest&per_page=100', 'jobs');
      const { action, reason } = decide({ run, jobs, mergedAt: item.mergedAt });
      if (action === 'skip') {
        if (consumerChecksState(jobs) !== 'none') results.push({ label: item.label, outcome: 'skipped', reason });
      } else if (action === 'rerun') {
        if (!dryRun) await gh.post(item.repo, '/actions/runs/' + item.runId + '/rerun');
        results.push({ label: item.label, outcome: dryRun ? 'would re-run' : 're-ran all jobs', reason, url: run.html_url });
      } else if (action === 'cancel' && dryRun) {
        results.push({ label: item.label, outcome: 'would cancel and re-run', reason, url: run.html_url });
      } else {
        if (action === 'cancel' && !item.cancelled) {
          await gh.post(item.repo, '/actions/runs/' + item.runId + '/cancel');
          log(item.label + ': ' + reason);
          item.cancelled = true;
        } else if (action === 'wait' && dryRun) {
          results.push({ label: item.label, outcome: 'would wait', reason, url: run.html_url });
          continue;
        }
        next.push(item);
      }
    }
    if (next.length === 0) break;
    if (now() >= deadline) {
      for (const item of next) {
        results.push({ label: item.label, outcome: 'gave up', reason: 'still in flight after ' + Math.round(waitMs / 60_000) + ' minutes; start a new run or use "Re-run all jobs"' });
      }
      break;
    }
    log('waiting on ' + next.map((item) => item.label).join(', '));
    await sleep(pollMs);
    pending = next;
  }
  return results;
}

export function summarize(docsPrs, results) {
  const lines = ['### Consumer checks restarted after protocol docs merged', ''];
  lines.push('Docs PRs: ' + (docsPrs.map((pr) => '#' + pr.number).join(', ') || 'none'), '');
  if (results.length === 0) {
    lines.push('No linked open intentd or cloudlands-fe PR.');
  } else {
    lines.push('| Component run | Outcome | Reason |', '|---|---|---|');
    for (const result of results) {
      const label = result.url ? '[' + result.label + '](' + result.url + ')' : result.label;
      lines.push('| ' + label + ' | ' + result.outcome + ' | ' + result.reason + ' |');
    }
  }
  return lines.join('\n') + '\n';
}

export async function main(env = process.env, { fetchImpl, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now } = {}) {
  if (!env.RERUN_TOKEN) {
    console.log('::warning::RERUN_TOKEN (CONSUMER_CHECKS_RERUN_TOKEN) is not set; not restarting component consumer checks.');
    return 0;
  }
  const gh = createGitHub({
    fetchImpl,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    tokenFor: (repo) => (COMPONENTS.includes(repo) ? env.RERUN_TOKEN : env.GITHUB_TOKEN || env.RERUN_TOKEN),
  });
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const docsPrs = await docsPullRequests(gh, { eventName: env.GITHUB_EVENT_NAME, event, prNumber: env.PR_NUMBER });
  const targets = new Map();
  for (const pr of docsPrs) {
    for (const link of await linkedTargets(gh, pr)) {
      const key = link.repo + '#' + link.number;
      const mergedAt = targets.has(key) && targets.get(key).mergedAt > pr.merged_at ? targets.get(key).mergedAt : pr.merged_at;
      targets.set(key, { ...link, mergedAt });
    }
  }
  const results = await restart(gh, [...targets.values()], {
    dryRun: env.DRY_RUN === 'true' || env.DRY_RUN === '1',
    sleep,
    now,
    waitMs: Number(env.WAIT_MINUTES || 45) * 60_000,
    pollMs: Number(env.POLL_SECONDS || 60) * 1000,
  });
  const summary = summarize(docsPrs, results);
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  for (const result of results.filter((r) => r.outcome === 'gave up')) {
    console.log('::warning::' + result.label + ': ' + result.reason);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error('::error::consumer-checks-docs-rerun: ' + error.message);
      process.exitCode = 1;
    },
  );
}
