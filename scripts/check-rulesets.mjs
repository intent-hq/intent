#!/usr/bin/env node

// Check the committed expected `main` branch rules of intent, intentd and
// cloudlands-fe (.github/rulesets/<repo>.main.json) against the live effective
// rules GitHub reports for the branch (repository AND organization rulesets),
// so a silent ruleset edit — a required check dropped, thread resolution
// switched off, merge-queue settings changed — fails monorepo CI instead of
// letting the queue merge untested trees. The endpoint is readable without a
// token on these public repositories; GITHUB_TOKEN / GH_TOKEN only raises the
// rate limit. For the monorepo the required check contexts must also name a
// `name:` of a job in .github/workflows/ci.yml, so a renamed gate job cannot
// leave the queue waiting on a check nothing produces.
//
// The effective rules omit each ruleset's `bypass_actors`, so an actor granted
// an always-bypass on the Default ruleset would not register as drift. When
// RULESET_ADMIN_TOKEN is set (a fine-grained token with administration read on
// the three repositories; GitHub returns the field only to callers with write
// access to the ruleset) every active ruleset of each repository is read from
// GET /repos/{owner}/{repo}/rulesets/{id} and its bypass actors are compared
// with the committed allow-list .github/rulesets/<repo>.bypass.json (an object
// keyed by ruleset, `Repository intent-hq/intent ruleset Default`; empty by
// default, so any bypass actor is drift). The token is optional: when it is
// absent, or a ruleset does not return the field, a `::warning::` names the
// gap and the check passes.
//
// Exit codes: 0 match, 1 drift, 2 usage / configuration error (bad snapshot,
// 401, 404, permission 403). Transient failures (network, a body cut off
// mid-read, 5xx, primary or secondary rate limit) print a `::warning::` and
// exit 0 so a GitHub hiccup does not redden a PR.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const OWNER = 'intent-hq';
export const REPOS = ['intent', 'intentd', 'cloudlands-fe'];
export const BRANCH = 'main';
export const RULESETS_DIR = '.github/rulesets';
export const CI_WORKFLOW = '.github/workflows/ci.yml';
export const CROSS_CHECKED_REPO = 'intent';
export const API_BASE = 'https://api.github.com';

export const ADMIN_TOKEN_VARIABLE = 'RULESET_ADMIN_TOKEN';

export function rulesUrl(repo, apiBase = API_BASE) {
  return `${apiBase}/repos/${OWNER}/${repo}/rules/branches/${BRANCH}`;
}

export function rulesetsUrl(repo, apiBase = API_BASE) {
  return `${apiBase}/repos/${OWNER}/${repo}/rulesets`;
}

export function rulesetUrl(repo, rulesetId, apiBase = API_BASE) {
  return `${rulesetsUrl(repo, apiBase)}/${rulesetId}`;
}

export function snapshotPath(repo) {
  return path.join(RULESETS_DIR, `${repo}.${BRANCH}.json`);
}

export function bypassAllowListPath(repo) {
  return path.join(RULESETS_DIR, `${repo}.bypass.json`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(sortKeys(value));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// The wire order of the rules and of their array parameters is not stable
// across repositories, so both sides are normalized before the compare:
// `ruleset_id` is dropped (ids are brittle and carry no policy), object keys
// are sorted, `required_status_checks` sort by context, `allowed_merge_methods`
// lexically, and the rules array by type then stable JSON.
export function normalizeRule(rule) {
  const normalized = {
    type: rule.type,
    ruleset_source_type: rule.ruleset_source_type,
    ruleset_source: rule.ruleset_source,
  };
  if (rule.parameters !== undefined) {
    const parameters = sortKeys(rule.parameters);
    if (Array.isArray(parameters.required_status_checks)) {
      parameters.required_status_checks = [...parameters.required_status_checks].sort(
        (left, right) =>
          compareStrings(String(left?.context), String(right?.context)) ||
          compareStrings(stableJson(left), stableJson(right)),
      );
    }
    if (Array.isArray(parameters.allowed_merge_methods)) {
      parameters.allowed_merge_methods = [...parameters.allowed_merge_methods].sort(compareStrings);
    }
    normalized.parameters = parameters;
  }
  return sortKeys(normalized);
}

export function normalizeRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
  return rules
    .map(normalizeRule)
    .sort((left, right) => compareStrings(left.type, right.type) || compareStrings(stableJson(left), stableJson(right)));
}

export function formatSnapshot(rules) {
  return `${JSON.stringify(normalizeRules(rules), null, 2)}\n`;
}

export function ruleKey(rule) {
  return `${rule.ruleset_source_type} ${rule.ruleset_source} rule ${rule.type}`;
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// Compares two lists whose entries share a grouping key (rules by source and
// type, required checks by context) without collapsing repeated keys: within a
// group identical entries pair off first, the remainder pair in normalized
// order for field-level diagnostics, and any leftover is reported whole.
function diffGroups(expected, actual, keyOf, { label, at, compared = (item) => item }) {
  const expectedGroups = groupBy(expected, keyOf);
  const actualGroups = groupBy(actual, keyOf);
  const differences = [];
  for (const key of new Set([...expectedGroups.keys(), ...actualGroups.keys()])) {
    const expectedItems = expectedGroups.get(key) ?? [];
    const actualItems = [...(actualGroups.get(key) ?? [])];
    const repeated = Math.max(expectedItems.length, actualItems.length) > 1;
    const unmatched = [];
    for (const item of expectedItems) {
      const index = actualItems.findIndex((candidate) => stableJson(candidate) === stableJson(item));
      if (index === -1) unmatched.push(item);
      else actualItems.splice(index, 1);
    }
    while (unmatched.length > 0 && actualItems.length > 0) {
      const item = unmatched.shift();
      differences.push(...diffValues(compared(item), compared(actualItems.shift()), at(key, item, repeated)));
    }
    for (const item of unmatched) differences.push(`${label(key, item, repeated)} missing`);
    for (const item of actualItems) differences.push(`${label(key, item, repeated)} unexpected`);
  }
  return differences;
}

// Human-readable differences, each naming the divergent path. Arrays whose
// elements carry a `context` (required_status_checks) are matched by context so
// a dropped check is reported by name rather than by index.
export function diffValues(expected, actual, at) {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const byContext = (items) => items.every((item) => isPlainObject(item) && typeof item.context === 'string');
    if (expected.length + actual.length > 0 && byContext(expected) && byContext(actual)) {
      const name = (context, item, repeated) => (repeated ? `${at}[] context ${JSON.stringify(context)} ${stableJson(item)}` : `${at}[] context ${JSON.stringify(context)}`);
      return diffGroups(expected, actual, (item) => item.context, {
        label: name,
        at: (context, item, repeated) => (repeated ? name(context, item, repeated) : `${at}[context ${JSON.stringify(context)}]`),
      });
    }
    if (expected.every((item) => !isPlainObject(item)) && actual.every((item) => !isPlainObject(item))) {
      return stableJson(expected) === stableJson(actual)
        ? []
        : [`${at} expected ${stableJson(expected)}, live ${stableJson(actual)}`];
    }
    const differences = [];
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      if (index >= expected.length) differences.push(`${at}[${index}] unexpected ${stableJson(actual[index])}`);
      else if (index >= actual.length) differences.push(`${at}[${index}] missing ${stableJson(expected[index])}`);
      else differences.push(...diffValues(expected[index], actual[index], `${at}[${index}]`));
    }
    return differences;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const differences = [];
    for (const key of Object.keys(expected).sort()) {
      if (!(key in actual)) differences.push(`${at}.${key} missing (expected ${stableJson(expected[key])})`);
      else differences.push(...diffValues(expected[key], actual[key], `${at}.${key}`));
    }
    for (const key of Object.keys(actual).sort()) {
      if (!(key in expected)) differences.push(`${at}.${key} unexpected (live ${stableJson(actual[key])})`);
    }
    return differences;
  }
  return stableJson(expected) === stableJson(actual) ? [] : [`${at} expected ${stableJson(expected)}, live ${stableJson(actual)}`];
}

// A repository (or the organization) may impose several rules of one type, so
// rules are grouped by source and type rather than keyed. Whatever the
// diagnostics miss, two normalized snapshots that differ never compare clean.
export function diffRules(expected, actual) {
  const expectedRules = normalizeRules(expected);
  const actualRules = normalizeRules(actual);
  const label = (key, rule, repeated) => (repeated ? `${key} ${stableJson(rule.parameters ?? {})}` : key);
  const differences = diffGroups(expectedRules, actualRules, ruleKey, {
    label,
    at: (key, rule, repeated) => `${label(key, rule, repeated)} parameters`,
    compared: (rule) => rule.parameters ?? {},
  });
  if (differences.length === 0 && stableJson(expectedRules) !== stableJson(actualRules)) {
    differences.push('normalized rules differ (see diff below)');
  }
  return differences;
}

// Minimal unified line diff (LCS) of two formatted snapshots, printed under the
// path list so the surrounding JSON is visible without opening the files.
export function unifiedDiff(expectedText, actualText, { context = 2 } = {}) {
  const left = expectedText.split('\n');
  const right = actualText.split('\n');
  const lcs = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [];
  for (let i = 0, j = 0; i < left.length || j < right.length; ) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      lines.push([' ', left[i]]);
      i += 1;
      j += 1;
    } else if (i < left.length && (j >= right.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push(['-', left[i]]);
      i += 1;
    } else {
      lines.push(['+', right[j]]);
      j += 1;
    }
  }
  const keep = new Set();
  lines.forEach(([op], index) => {
    if (op === ' ') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep.add(k);
  });
  const out = [];
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== previous + 1) out.push('@@');
    out.push(`${lines[index][0]}${lines[index][1]}`);
    previous = index;
  }
  return out.join('\n');
}

export function requiredCheckContexts(rules) {
  const contexts = [];
  for (const rule of rules) {
    if (rule.type !== 'required_status_checks') continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (typeof check?.context === 'string') contexts.push(check.context);
    }
  }
  return [...new Set(contexts)].sort();
}

// Job display names: the `name:` lines at job-key depth (four spaces) in the
// workflow. A job without `name:` is reported under its key, which the rulesets
// do not use today, so only explicit names count.
export function workflowJobNames(workflowText) {
  const names = new Set();
  for (const line of String(workflowText ?? '').split('\n')) {
    const match = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (match) names.add(match[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return names;
}

export function crossCheckWorkflow(rules, workflowText, workflowPath = CI_WORKFLOW) {
  const names = workflowJobNames(workflowText);
  return requiredCheckContexts(rules)
    .filter((context) => !names.has(context))
    .map((context) => `required check ${JSON.stringify(context)} is not the name: of any job in ${workflowPath}`);
}

// A bypass actor is `{ actor_id, actor_type, bypass_mode }`; `actor_id` is
// null for actor types GitHub does not number (OrganizationAdmin, DeployKey).
// Both sides are normalized to those three keys and sorted before the compare.
export function normalizeBypassActors(actors) {
  if (!Array.isArray(actors)) throw new TypeError('bypass_actors must be an array');
  return actors
    .map((actor) => {
      if (!isPlainObject(actor)) throw new TypeError(`bypass actor ${stableJson(actor)} is not an object`);
      return sortKeys({ actor_id: actor.actor_id ?? null, actor_type: actor.actor_type, bypass_mode: actor.bypass_mode });
    })
    .sort((left, right) => compareStrings(stableJson(left), stableJson(right)));
}

export function bypassActorKey(actor) {
  return actor.actor_id === null ? String(actor.actor_type) : `${actor.actor_type} ${actor.actor_id}`;
}

// Differences between the allow-listed and the live bypass actors of one
// ruleset, each naming the actor (type and id) so a granted bypass is reported
// by who holds it rather than by index.
export function diffBypassActors(expected, actual) {
  const expectedActors = normalizeBypassActors(expected);
  const actualActors = normalizeBypassActors(actual);
  const label = (key, actor, repeated) => (repeated ? `bypass actor ${key} ${stableJson(actor)}` : `bypass actor ${key}`);
  return diffGroups(expectedActors, actualActors, bypassActorKey, { label, at: label });
}

// Rulesets are keyed by source type, source and name — an organization and a
// repository ruleset may share a name — in the style of `ruleKey`.
export function rulesetKey(ruleset) {
  return `${ruleset.source_type} ${ruleset.source} ruleset ${ruleset.name}`;
}

// The committed allow-list is an object keyed by `rulesetKey` whose values are
// bypass-actor arrays; a ruleset without an entry allows no bypass actor, and
// rulesets without actors are left out so the default stays `{}`.
export function formatBypassAllowList(rulesets) {
  const entries = rulesets
    .map((ruleset) => [rulesetKey(ruleset), normalizeBypassActors(ruleset.bypass_actors)])
    .filter(([, actors]) => actors.length > 0)
    .sort(([left], [right]) => compareStrings(left, right));
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

export function activeRulesets(rulesets) {
  if (!Array.isArray(rulesets)) throw new TypeError('rulesets must be an array');
  return rulesets.filter((ruleset) => isPlainObject(ruleset) && ruleset.enforcement === 'active');
}

export class RulesFetchError extends Error {
  constructor(message, { transient }) {
    super(message);
    this.transient = transient;
  }
}

function errorMessage(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    return isPlainObject(body) && typeof body.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

// GitHub reports an exhausted primary limit as 403 with x-ratelimit-remaining:
// 0, and a secondary limit as 403 or 429 — sometimes with retry-after, but
// documented to arrive with neither header and a nonzero remaining count and
// only the body message telling it apart from a permission 403.
function rateLimited(response, bodyText) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.has('retry-after') ||
    /rate limit|abuse detection/i.test(errorMessage(bodyText))
  );
}

// One GitHub API read, classified: the parsed JSON body, or a RulesFetchError
// whose `transient` flag decides between a warning and a configuration error.
// `subject` prefixes every message (`intent-hq/intent`, `intent-hq/intent
// ruleset 42`).
export async function fetchJson(url, subject, { fetchImpl = globalThis.fetch, token } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'intent-hq/intent check-rulesets',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new RulesFetchError(`${subject}: network error (${error?.message ?? error})`, { transient: true });
  }
  if (response.status >= 500 || response.status === 429) {
    throw new RulesFetchError(`${subject}: HTTP ${response.status}`, { transient: true });
  }
  const notOk = new RulesFetchError(`${subject}: HTTP ${response.status} reading ${url}`, { transient: false });
  // The status alone settles every other failure except a 403, whose body
  // message tells a secondary rate limit from a permission error.
  if (!response.ok && response.status !== 403) throw notOk;
  // fetch resolves once the headers arrive; the connection can still drop while
  // the body streams, which is a transport failure, not a malformed document.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new RulesFetchError(`${subject}: HTTP ${response.status}, body read failed (${error?.message ?? error})`, {
      transient: true,
    });
  }
  if (rateLimited(response, text)) {
    throw new RulesFetchError(`${subject}: HTTP ${response.status}`, { transient: true });
  }
  if (!response.ok) throw notOk;
  try {
    return JSON.parse(text);
  } catch {
    throw new RulesFetchError(`${subject}: response is not JSON`, { transient: false });
  }
}

export async function fetchLiveRules(repo, { fetchImpl = globalThis.fetch, token, apiBase = API_BASE } = {}) {
  const body = await fetchJson(rulesUrl(repo, apiBase), `${OWNER}/${repo}`, { fetchImpl, token });
  if (!Array.isArray(body)) {
    throw new RulesFetchError(`${OWNER}/${repo}: response is not a rules array`, { transient: false });
  }
  return body;
}

// The rulesets that apply to the repository (its own and the organization's,
// as the endpoint includes parents by default), then each active one in full
// — the list omits `bypass_actors`. A ruleset whose detail lacks the field is
// returned as is; the caller reports the gap.
export async function fetchLiveRulesets(repo, { fetchImpl = globalThis.fetch, token, apiBase = API_BASE } = {}) {
  const list = await fetchJson(rulesetsUrl(repo, apiBase), `${OWNER}/${repo} rulesets`, { fetchImpl, token });
  if (!Array.isArray(list)) {
    throw new RulesFetchError(`${OWNER}/${repo} rulesets: response is not a rulesets array`, { transient: false });
  }
  const rulesets = [];
  for (const summary of activeRulesets(list)) {
    const subject = `${OWNER}/${repo} ruleset ${summary.id}`;
    const detail = await fetchJson(rulesetUrl(repo, summary.id, apiBase), subject, { fetchImpl, token });
    if (!isPlainObject(detail)) throw new RulesFetchError(`${subject}: response is not a ruleset object`, { transient: false });
    rulesets.push({ ...summary, ...detail });
  }
  return rulesets;
}

// A fixture keeps the tests off the network: a JSON object keyed by repository
// whose values are either a rules array (HTTP 200) or a canned response
// `{ status, headers?, body? }`; `{ error: "..." }` simulates a network error.
// An optional `rulesets` object keyed by repository serves the rulesets
// endpoints the same way: `list` for GET .../rulesets and a ruleset id for
// GET .../rulesets/{id}, each a document (HTTP 200) or a canned response.
function isCanned(entry) {
  return isPlainObject(entry) && ('status' in entry || 'error' in entry);
}

export function fetchFromFixture(fixture) {
  return async (url) => {
    const rules = /\/repos\/[^/]+\/([^/]+)\/rules\//.exec(url);
    const rulesets = /\/repos\/[^/]+\/([^/]+)\/rulesets(?:\/([^/?]+))?$/.exec(url);
    let entry;
    if (rules) entry = fixture[rules[1]];
    else if (rulesets) entry = fixture.rulesets?.[rulesets[1]]?.[rulesets[2] ?? 'list'];
    if (entry === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (!isCanned(entry)) return Response.json(entry);
    if (entry.error) throw new Error(entry.error);
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body ?? null);
    return new Response(body, { status: entry.status ?? 200, headers: entry.headers ?? {} });
  };
}

export function parseArguments(argv) {
  const options = { update: false, repos: [...REPOS], fixture: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update') options.update = true;
    else if (argument === '--repo' && argv[index + 1]) {
      const repo = argv[++index];
      if (!REPOS.includes(repo)) throw new Error(`unknown repository ${repo}; expected one of ${REPOS.join(', ')}`);
      options.repos = [repo];
    } else if (argument === '--fixture' && argv[index + 1]) options.fixture = argv[++index];
    else throw new Error('usage: check-rulesets.mjs [--update] [--repo <name>] [--fixture <file>]');
  }
  return options;
}

async function readSnapshot(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${filePath} is missing; run \`make check-rulesets UPDATE=1\` to create it from the live rules`);
    }
    throw error;
  }
  let rules;
  try {
    rules = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`);
  }
  if (!Array.isArray(rules)) throw new Error(`${filePath}: expected a JSON array of rules`);
  return rules;
}

async function readBypassAllowList(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${filePath} is missing; commit \`{}\` (no bypass actors allowed) or run \`make check-rulesets UPDATE=1\` with ${ADMIN_TOKEN_VARIABLE} set`);
    }
    throw error;
  }
  let allowList;
  try {
    allowList = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`);
  }
  if (!isPlainObject(allowList) || !Object.values(allowList).every(Array.isArray)) {
    throw new Error(`${filePath}: expected a JSON object mapping rulesets to arrays of bypass actors`);
  }
  return allowList;
}

// Compares the live bypass actors of every active ruleset with the allow-list;
// returns `{ differences, skipped }`, where `skipped` names the rulesets whose
// detail did not include `bypass_actors` (the token lacks write access to
// them), reported as a warning rather than as drift.
export function diffBypassAllowList(allowList, rulesets) {
  const differences = [];
  const skipped = [];
  const seen = new Set();
  for (const ruleset of rulesets) {
    const key = rulesetKey(ruleset);
    seen.add(key);
    if (ruleset.bypass_actors === undefined) {
      skipped.push(ruleset);
      continue;
    }
    for (const difference of diffBypassActors(allowList[key] ?? [], ruleset.bypass_actors)) {
      differences.push(`${key} ${difference}`);
    }
  }
  for (const key of Object.keys(allowList).sort()) {
    if (!seen.has(key) && allowList[key].length > 0) {
      differences.push(`${key} is allow-listed but is not an active ruleset`);
    }
  }
  return { differences, skipped };
}

// Runs the check; returns the process exit code. `stdout` / `stderr` are
// `console`-like sinks so tests can capture output without spawning.
export async function run(argv, { cwd = process.cwd(), env = process.env, fetchImpl, stdout = console, stderr = console } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.error(error.message);
    return 2;
  }
  if (options.fixture) {
    try {
      fetchImpl = fetchFromFixture(JSON.parse(await fs.readFile(path.resolve(cwd, options.fixture), 'utf8')));
    } catch (error) {
      stderr.error(`check-rulesets: cannot read fixture ${options.fixture} (${error.message})`);
      return 2;
    }
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
  const adminToken = env[ADMIN_TOKEN_VARIABLE] || undefined;
  let exitCode = 0;
  let drifted = false;
  let bypassDrifted = false;
  const fail = (code) => {
    exitCode = Math.max(exitCode, code);
  };
  if (!adminToken) {
    stdout.log(
      `::warning::check-rulesets: ${ADMIN_TOKEN_VARIABLE} is not set; the bypass actors of the ${options.repos.map((repo) => `${OWNER}/${repo}`).join(', ')} rulesets are not checked (GitHub returns them only to a token with administration read on the repository).`,
    );
  }

  for (const repo of options.repos) {
    const snapshotFile = snapshotPath(repo);
    const snapshotAbsolute = path.resolve(cwd, snapshotFile);
    let live;
    try {
      live = await fetchLiveRules(repo, { fetchImpl, token });
    } catch (error) {
      if (error instanceof RulesFetchError && error.transient) {
        stdout.log(`::warning::check-rulesets: could not read live ${BRANCH} branch rules for ${error.message}; skipping ${repo}.`);
      } else {
        stderr.error(`check-rulesets: ${error.message}`);
        fail(2);
      }
      live = undefined;
    }

    let expected;
    if (options.update) {
      if (live === undefined) continue;
      await fs.mkdir(path.dirname(snapshotAbsolute), { recursive: true });
      await fs.writeFile(snapshotAbsolute, formatSnapshot(live));
      stdout.log(`Wrote ${snapshotFile} from the live ${OWNER}/${repo} ${BRANCH} branch rules.`);
      expected = normalizeRules(live);
    } else {
      try {
        expected = await readSnapshot(snapshotAbsolute);
      } catch (error) {
        stderr.error(`check-rulesets: ${error.message}`);
        fail(2);
        continue;
      }
      if (live !== undefined) {
        const differences = diffRules(expected, live);
        if (differences.length === 0) {
          stdout.log(`${OWNER}/${repo}: live ${BRANCH} branch rules match ${snapshotFile}.`);
        } else {
          stderr.error(`${OWNER}/${repo}: live ${BRANCH} branch rules differ from ${snapshotFile}:`);
          for (const difference of differences) stderr.error(`  - ${difference}`);
          stderr.error(`--- ${snapshotFile} (expected)\n+++ live ${OWNER}/${repo} ${BRANCH} rules`);
          stderr.error(unifiedDiff(formatSnapshot(expected), formatSnapshot(live)));
          drifted = true;
          fail(1);
        }
      }
    }

    if (repo === CROSS_CHECKED_REPO) {
      const workflowText = await fs.readFile(path.resolve(cwd, CI_WORKFLOW), 'utf8');
      const problems = crossCheckWorkflow(expected, workflowText);
      for (const problem of problems) stderr.error(`${OWNER}/${repo}: ${problem}`);
      if (problems.length > 0) fail(1);
    }

    if (adminToken) {
      if (await checkBypassActors(repo, { cwd, adminToken, fetchImpl, update: options.update, stdout, stderr, fail })) bypassDrifted = true;
    }
  }

  if (drifted) {
    stderr.error('Restore the rules on GitHub, or accept the live rules with `make check-rulesets UPDATE=1` and commit the result.');
  }
  if (bypassDrifted) {
    stderr.error(
      `Remove the bypass actors on GitHub, or allow-list them with \`make check-rulesets UPDATE=1\` (${ADMIN_TOKEN_VARIABLE} set) and commit the result.`,
    );
  }
  return exitCode;
}

// The bypass-actor half of one repository's check; returns whether it drifted.
async function checkBypassActors(repo, { cwd, adminToken, fetchImpl, update, stdout, stderr, fail }) {
  const allowListFile = bypassAllowListPath(repo);
  const allowListAbsolute = path.resolve(cwd, allowListFile);
  let rulesets;
  try {
    rulesets = await fetchLiveRulesets(repo, { fetchImpl, token: adminToken });
  } catch (error) {
    if (error instanceof RulesFetchError && error.transient) {
      stdout.log(`::warning::check-rulesets: could not read the rulesets of ${error.message}; skipping the bypass actors of ${repo}.`);
    } else {
      stderr.error(`check-rulesets: ${error.message}`);
      fail(2);
    }
    return false;
  }
  const withActors = rulesets.filter((ruleset) => ruleset.bypass_actors !== undefined);
  const warnSkipped = (skipped) => {
    for (const ruleset of skipped) {
      stdout.log(
        `::warning::check-rulesets: ${OWNER}/${repo}: ${rulesetKey(ruleset)} (id ${ruleset.id}) did not return bypass_actors (the token lacks write access to it); its bypass actors are not checked.`,
      );
    }
  };

  if (update) {
    warnSkipped(rulesets.filter((ruleset) => ruleset.bypass_actors === undefined));
    if (withActors.length < rulesets.length) return false;
    await fs.mkdir(path.dirname(allowListAbsolute), { recursive: true });
    await fs.writeFile(allowListAbsolute, formatBypassAllowList(rulesets));
    stdout.log(`Wrote ${allowListFile} from the bypass actors of the live ${OWNER}/${repo} rulesets.`);
    return false;
  }

  let allowList;
  try {
    allowList = await readBypassAllowList(allowListAbsolute);
  } catch (error) {
    stderr.error(`check-rulesets: ${error.message}`);
    fail(2);
    return false;
  }
  const { differences, skipped } = diffBypassAllowList(allowList, rulesets);
  warnSkipped(skipped);
  if (differences.length === 0) {
    if (withActors.length > 0) {
      stdout.log(`${OWNER}/${repo}: bypass actors of ${withActors.length} active ruleset(s) match ${allowListFile}.`);
    }
    return false;
  }
  stderr.error(`${OWNER}/${repo}: live ruleset bypass actors differ from ${allowListFile}:`);
  for (const difference of differences) stderr.error(`  - ${difference}`);
  fail(1);
  return true;
}

async function main() {
  process.exitCode = await run(process.argv.slice(2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
