import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_PATH,
  DOCUMENTED_NOT_DISPATCHABLE,
  INTENTD_CATALOG_PATH,
  METHODS_DIR,
  collectDocumentedMethods,
  extractRustCatalog,
  formatError,
  formatRefBanner,
  formatRefOffPinWarning,
  formatWarning,
  methodNamesInFirstCell,
  parseCatalog,
  runChecks,
  tokenizeRowSuffixes,
} from './check-protocol-catalog.mjs';
import { submoduleOf } from './submodule-ref.mjs';
import { cleanNodeEnv } from './test-env.mjs';

const SCRIPT = fileURLToPath(new URL('./check-protocol-catalog.mjs', import.meta.url));
const INTENTD_DIR = submoduleOf(INTENTD_CATALOG_PATH);

const CATALOG = `> Part of the protocol docs — §5 Method Catalog.

## 5. Method Catalog

The API exposes **10 dispatchable method names** across the following categories:

- **Router methods:** 6 methods dispatched via the main router
- **Fast-path methods:** 3 methods intercepted before the router
- **Method aliases:** 1 alias accepted on the wire

### Router methods by namespace (6 total)

| Namespace | Count | Methods |
| --- | --- | --- |
| agent | 3 | create, list, stop — live agents (§5.5; \`workspaceId\` req) |
| github | 2 | pulls.list, relatedRepos.list |
| system (router) | 1 | capabilities — machine-level capabilities, no workspaceId |

### Fast-path methods (3 total)

The following methods are intercepted before the router.

client.hello, host.openInEditor, system.status

### Method aliases (1 total)

- \`git.diff\` → \`git.diffs\`

### Client-served reverse RPCs (2 total)

- \`host.openInEditor\` — open a file (dual-role)
- \`host.openExternal\` — open a URL (daemon→client only)

### §5.x subsection index
`;

const METHODS_DOC = `### 5.5 Agents — \`agent.create\`

| Method | Params | Result |
| --- | --- | --- |
| agent.create | workspaceId (req) | { agent } |
| \`agent.list\` *(v4.1)* | workspaceId (req) | { agents } |
| agent.stop | agentId (req) | { ok } |
| github.relatedRepos.list | workspaceId (req) | { repos } |
| browser.docs | topic (req) | docs string — **not exposed**: no router arm |

#### \`system.capabilities\` — machine-level capabilities

\`\`\`json
| not.aRow | inside | a fence |
\`\`\`
`;

const RUST = `//! Protocol v2.0 method catalog — frozen wire-contract constants.

#[cfg(test)]
pub(crate) const ROUTER_METHODS: &[&str] = &[
    "agent.create",
    "agent.list",
    "agent.stop",
    "github.pulls.list",
    "github.relatedRepos.list",
    "system.capabilities",
];

/// Method aliases (wire-accepted → canonical).
#[cfg(test)]
pub(crate) const METHOD_ALIASES: &[(&str, &str)] =
    &[("git.diff", "git.diffs")];

#[cfg(test)]
pub(crate) const FASTPATH_METHODS: &[&str] = &[
    "client.hello",
    "host.openInEditor",
    "system.status",
];

#[cfg(test)]
pub(crate) const NOTIFICATIONS: &[&str] = &["events.event"];

#[cfg(test)]
pub(crate) const REVERSE_METHODS: &[&str] = &[
    "host.openExternal",
    "host.openInEditor",
];
`;

async function makeRoot({ catalog = CATALOG, methods = { 'agents.md': METHODS_DOC }, rust = RUST } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-protocol-catalog-'));
  await fs.mkdir(path.join(root, METHODS_DIR), { recursive: true });
  await fs.writeFile(path.join(root, CATALOG_PATH), catalog);
  for (const [name, text] of Object.entries(methods)) await fs.writeFile(path.join(root, METHODS_DIR, name), text);
  if (rust !== null) {
    await fs.mkdir(path.dirname(path.join(root, INTENTD_CATALOG_PATH)), { recursive: true });
    await fs.writeFile(path.join(root, INTENTD_CATALOG_PATH), rust);
  }
  return root;
}

const messages = (result) => result.errors.map(formatError);
const warningMessages = (result) => result.warnings.map(formatWarning);

const LEAD_HINT_RE =
  /expected while the docs lead the intentd pin \(the submodule pin advances automatically once the intentd PR merges; rebase onto main if it already has\); if no intentd change is adding it, treat this as an error and remove the entry$/;

test('passing fixture: both layers run and report no errors or warnings', async () => {
  const result = await runChecks(await makeRoot());
  assert.deepEqual(messages(result), []);
  assert.deepEqual(warningMessages(result), []);
  assert.equal(result.skipped, null);
  assert.equal(result.layer2Ran, true);
});

test('allowlist contains only browser.docs', () => {
  assert.deepEqual([...DOCUMENTED_NOT_DISPATCHABLE], ['browser.docs']);
});

test('Layer 1: a methods/ table row missing from the catalog fails with file:line', async () => {
  const doc = `${METHODS_DOC}\n| Method | Params | Result |\n| --- | --- | --- |\n| foo.bar | x | y |\n`;
  const result = await runChecks(await makeRoot({ methods: { 'integrations.md': doc } }));
  const line = doc.split('\n').findIndex((l) => l.startsWith('| foo.bar')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/methods/integrations.md:${line}: error: foo.bar is documented here but missing from docs/protocol/05-method-catalog.md`,
  ]);
});

test('Layer 1: a backticked method in a heading missing from the catalog fails', async () => {
  const doc = `${METHODS_DOC}\n### 5.99 Widgets — \`widget.list\` / \`widget.get\` *(v9)*\n`;
  const result = await runChecks(await makeRoot({ methods: { 'widgets.md': doc } }));
  const line = doc.split('\n').length - 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/methods/widgets.md:${line}: error: widget.list is documented here but missing from docs/protocol/05-method-catalog.md`,
    `docs/protocol/methods/widgets.md:${line}: error: widget.get is documented here but missing from docs/protocol/05-method-catalog.md`,
  ]);
});

test('Layer 1: an allowlisted name (browser.docs) is accepted; a non-allowlisted twin is not', async () => {
  const doc = METHODS_DOC.replace('| browser.docs |', '| browser.docs |\n| browser.docz |');
  const result = await runChecks(await makeRoot({ methods: { 'agents.md': doc } }));
  assert.equal(messages(result).length, 1);
  assert.match(messages(result)[0], /browser\.docz is documented here/);
  assert.doesNotMatch(messages(result).join('\n'), /browser\.docs /);
});

test('Layer 1: a "(N total)" heading that disagrees with its list fails', async () => {
  const catalog = CATALOG.replace('### Fast-path methods (3 total)', '### Fast-path methods (4 total)');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('### Fast-path methods')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: fast-path heading says 4 total but the list has 3 names`,
  ]);
});

test('Layer 1: router heading, summary line, and bullets are checked against the Count column', async () => {
  const catalog = CATALOG.replace('| agent | 3 |', '| agent | 4 |');
  const result = await runChecks(await makeRoot({ catalog, rust: null }));
  assert.deepEqual(
    result.errors.map((e) => e.message),
    [
      'router heading says 6 total but the Count column sums to 7',
      'summary says 10 dispatchable method names but router 7 + fast-path 3 + aliases 1 = 11',
      '"Router methods" bullet says 6 but the Count column sums to 7',
    ],
  );
});

test('Layer 2: a router method in catalog.rs missing from its namespace row fails', async () => {
  const catalog = CATALOG.replace('pulls.list, relatedRepos.list', 'pulls.list');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/methods/agents.md:8: error: github.relatedRepos.list is documented here but missing from docs/protocol/05-method-catalog.md`,
    `docs/protocol/05-method-catalog.md:${line}: error: github.relatedRepos.list is in ${INTENTD_CATALOG_PATH} ROUTER_METHODS but missing from the github row`,
    `docs/protocol/05-method-catalog.md:${line}: error: github row says 2 methods but lists 1 (pulls.list)`,
  ]);
});

test('Layer 2: a row Count above catalog.rs with a matching token list is not a Count error (docs lead the pin)', async () => {
  const rust = RUST.replace('    "agent.stop",\n', '');
  const catalog = CATALOG.replace('create, list, stop — live agents', 'create, list — live agents');
  const result = await runChecks(await makeRoot({ catalog, rust, methods: { 'agents.md': METHODS_DOC.replace('| agent.stop | agentId (req) | { ok } |\n', '') } }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| agent |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: agent row says 3 methods but lists 2 (create, list)`,
  ]);
  assert.deepEqual(warningMessages(result), []);
});

test('Layer 2: a row Count below the catalog.rs method count fails (pin ahead of docs)', async () => {
  const catalog = CATALOG.replace('| agent | 3 |', '| agent | 2 |').replace('(6 total)', '(5 total)').replace('**10 dispatchable', '**9 dispatchable').replace('**Router methods:** 6', '**Router methods:** 5');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| agent |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: agent row says 2 methods but ${INTENTD_CATALOG_PATH} ROUTER_METHODS has 3`,
    `docs/protocol/05-method-catalog.md:${line}: error: agent row says 2 methods but lists 3 (create, list, stop)`,
  ]);
  assert.deepEqual(warningMessages(result), []);
});

test('Layer 2: catalog entries absent from catalog.rs are warnings, not errors, with the docs-lead hint', async () => {
  const rust = RUST.replace('    "github.relatedRepos.list",\n', '').replace('    "client.hello",\n', '');
  const result = await runChecks(await makeRoot({ rust }));
  assert.deepEqual(messages(result), []);
  const msgs = warningMessages(result);
  assert.equal(msgs.length, 3, msgs.join('\n'));
  assert.match(msgs[0], /^docs\/protocol\/05-method-catalog\.md:\d+: warning: github\.relatedRepos\.list is listed in the github row but is not a router method in the pinned intentd catalog\.rs — /);
  assert.match(msgs[0], LEAD_HINT_RE);
  assert.match(msgs[1], /^docs\/protocol\/05-method-catalog\.md:\d+: warning: github\.relatedRepos\.list is listed in the catalog but not in the pinned intentd catalog\.rs — /);
  assert.match(msgs[1], LEAD_HINT_RE);
  assert.match(msgs[2], /^docs\/protocol\/05-method-catalog\.md:\d+: warning: client\.hello is listed in the catalog but not in the pinned intentd catalog\.rs — /);
});

test('Layer 2: a row listing one extra not-yet-pinned method is one warning and zero errors', async () => {
  const catalog = CATALOG.replace('| github | 2 | pulls.list, relatedRepos.list |', '| github | 3 | pulls.list, relatedRepos.list, issues.list |')
    .replace('(6 total)', '(7 total)').replace('**10 dispatchable', '**11 dispatchable').replace('**Router methods:** 6', '**Router methods:** 7');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), []);
  assert.deepEqual(warningMessages(result).length, 1);
  assert.match(warningMessages(result)[0], new RegExp(`^docs/protocol/05-method-catalog\\.md:${line}: warning: github\\.issues\\.list is listed in the github row but is not a router method in the pinned intentd catalog\\.rs — `));
});

test('Layer 2: a whole not-yet-pinned namespace row is a warning only', async () => {
  const catalog = CATALOG.replace('| system (router) |', '| widget | 2 | list, get |\n| system (router) |')
    .replace('(6 total)', '(8 total)').replace('**10 dispatchable', '**12 dispatchable').replace('**Router methods:** 6', '**Router methods:** 8');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| widget |')) + 1;
  assert.deepEqual(messages(result), []);
  assert.deepEqual(warningMessages(result).length, 1);
  assert.match(warningMessages(result)[0], new RegExp(`^docs/protocol/05-method-catalog\\.md:${line}: warning: router namespace widget is listed in the catalog but not in the pinned intentd catalog\\.rs — `));
});

test('Layer 2: a catalog.rs router method with no docs row is still an error', async () => {
  const rust = RUST.replace('    "system.capabilities",\n', '    "system.capabilities",\n    "widget.list",\n');
  const result = await runChecks(await makeRoot({ rust }));
  assert.deepEqual(result.errors.map((e) => e.message), [
    `router namespace widget (1 methods in ${INTENTD_CATALOG_PATH}) has no row in the router table`,
  ]);
  assert.deepEqual(warningMessages(result), []);
});

test('Layer 2: fast-path, alias, and reverse-RPC orphans are warnings; their Rust-only twins stay errors', async () => {
  const catalog = CATALOG.replace('client.hello, host.openInEditor, system.status', 'client.hello, host.openInEditor, system.status, system.ping')
    .replace('### Fast-path methods (3 total)', '### Fast-path methods (4 total)')
    .replace('**Fast-path methods:** 3', '**Fast-path methods:** 4')
    .replace('**10 dispatchable', '**11 dispatchable')
    .replace('- `git.diff` → `git.diffs`', '- `git.diff` → `git.diffs`\n- `git.log` → `git.history`')
    .replace('### Method aliases (1 total)', '### Method aliases (2 total)')
    .replace('**11 dispatchable', '**12 dispatchable')
    .replace('- `host.openExternal` — open a URL (daemon→client only)', '- `host.openExternal` — open a URL (daemon→client only)\n- `host.prompt` — ask the user')
    .replace('### Client-served reverse RPCs (2 total)', '### Client-served reverse RPCs (3 total)');
  const result = await runChecks(await makeRoot({ catalog }));
  assert.deepEqual(messages(result), []);
  assert.deepEqual(
    result.warnings.map((w) => w.message.split(' — ')[0]),
    [
      'system.ping is listed in the catalog but not in the pinned intentd catalog.rs',
      'alias git.log → git.history is listed in the catalog but not in the pinned intentd catalog.rs',
      'host.prompt is listed in the catalog but not in the pinned intentd catalog.rs',
    ],
  );

  const rust = RUST.replace('    "system.status",\n', '    "system.status",\n    "system.ping",\n')
    .replace('&[("git.diff", "git.diffs")]', '&[("git.diff", "git.diffs"), ("git.log", "git.history")]')
    .replace('    "host.openInEditor",\n];', '    "host.openInEditor",\n    "host.prompt",\n];');
  const rustAhead = await runChecks(await makeRoot({ rust }));
  assert.deepEqual(rustAhead.errors.map((e) => e.message), [
    `system.ping is in ${INTENTD_CATALOG_PATH} FASTPATH_METHODS but missing from the fast-path list`,
    `alias git.log → git.history is in ${INTENTD_CATALOG_PATH} METHOD_ALIASES but missing from the alias list`,
    `host.prompt is in ${INTENTD_CATALOG_PATH} REVERSE_METHODS but missing from the reverse-RPC list`,
  ]);
  assert.deepEqual(warningMessages(rustAhead), []);
});

test('Layer 2: a fake suffix in a row whose Count still matches catalog.rs fails on the token count and warns on the suffix', async () => {
  const catalog = CATALOG.replace('| github | 2 | pulls.list, relatedRepos.list |', '| github | 2 | pulls.list, relatedRepos.list, fake |');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: github row says 2 methods but lists 3 (pulls.list, relatedRepos.list, fake)`,
  ]);
  assert.equal(warningMessages(result).length, 1);
  assert.match(warningMessages(result)[0], new RegExp(`^docs/protocol/05-method-catalog\\.md:${line}: warning: github\\.fake is listed in the github row but is not a router method in the pinned intentd catalog\\.rs — `));
  assert.match(warningMessages(result)[0], LEAD_HINT_RE);
});

test('Layer 2: a row whose token count disagrees with its Count fails even when catalog.rs agrees with Count', async () => {
  const catalog = CATALOG.replace('| github | 2 | pulls.list, relatedRepos.list |', '| github | 2 | pulls.list, relatedRepos.list, pulls.list |');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: github row says 2 methods but lists 3 (pulls.list, relatedRepos.list, pulls.list)`,
  ]);
});

test('Layer 2: prose inside the method list (before the em dash) is rejected naming the offending token', async () => {
  const catalog = CATALOG.replace('| github | 2 | pulls.list, relatedRepos.list |', '| github | 2 | pulls.list (§5.11; v2.1), relatedRepos.list |');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: github row method list contains "pulls.list (§5.11; v2.1)", which is not a method suffix — list the suffixes first, comma-separated, and put prose after " — "`,
  ]);
});

test('tokenizeRowSuffixes stops at the first em dash and tolerates surrounding whitespace', () => {
  assert.deepEqual(tokenizeRowSuffixes('create, list, stop — live agents (§5.5; `workspaceId` req) — more'), { tokens: ['create', 'list', 'stop'], invalid: [] });
  assert.deepEqual(tokenizeRowSuffixes('  pulls.list ,relatedRepos.list  '), { tokens: ['pulls.list', 'relatedRepos.list'], invalid: [] });
  assert.deepEqual(tokenizeRowSuffixes('capabilities — machine-level capabilities, no workspaceId'), { tokens: ['capabilities'], invalid: [] });
  assert.deepEqual(tokenizeRowSuffixes('a, b (x), c'), { tokens: ['a', 'b (x)', 'c'], invalid: ['b (x)'] });
});

test('Layer 2: a whole documented namespace absent from catalog.rs is an orphan-row warning', async () => {
  const rust = RUST.replace('    "github.pulls.list",\n    "github.relatedRepos.list",\n', '');
  const result = await runChecks(await makeRoot({ rust }));
  assert.deepEqual(messages(result), []);
  assert.match(warningMessages(result)[0], /warning: router namespace github is listed in the catalog but not in the pinned intentd catalog\.rs/);
});

test('Layer 2 is skipped (exit 0 on Layer 1 alone) when catalog.rs is absent', async () => {
  const result = await runChecks(await makeRoot({ rust: null }));
  assert.deepEqual(messages(result), []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.layer2Ran, false);
  assert.equal(result.skipped, `skipped: ${INTENTD_CATALOG_PATH} (submodule not initialized)`);
  assert.equal(result.ref, null);
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A passing fixture whose packages/intentd is a nested git repo with catalog.rs committed and recorded as
// the monorepo gitlink. `advance()` commits an extra router method in intentd so the checkout moves off the pin.
async function makeGitRoot(t) {
  const root = await makeRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const intentd = path.join(root, INTENTD_DIR);
  git(intentd, 'init', '-q', '-b', 'main');
  git(intentd, 'add', '.');
  git(intentd, 'commit', '-q', '-m', 'pin');
  const pin = git(intentd, 'rev-parse', 'HEAD');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${pin},${INTENTD_DIR}`);
  git(root, 'commit', '-q', '-m', 'monorepo');
  const advance = async () => {
    await fs.writeFile(path.join(root, INTENTD_CATALOG_PATH), RUST.replace('    "agent.stop",\n', '    "agent.stop",\n    "agent.unwatch",\n'));
    git(intentd, 'commit', '-q', '-am', 'ahead of the pin');
    return git(intentd, 'rev-parse', 'HEAD');
  };
  return { root, pin, advance };
}

const runCli = (root) => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', env: cleanNodeEnv() });

test('a root outside any git repository yields an unknown ref: no banner, no warning, checks unchanged', async () => {
  const result = await runChecks(await makeRoot());
  assert.deepEqual(result.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: null, pin: null });
  assert.equal(formatRefBanner(result.ref), null);
  assert.equal(formatRefOffPinWarning(result.ref), null);
});

test('at the pin: the banner names checkout == pin on stdout, no warning, exit code and output otherwise unchanged', async (t) => {
  const { root, pin } = await makeGitRoot(t);
  const result = await runChecks(root);
  assert.deepEqual(messages(result), []);
  assert.deepEqual(result.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: pin, pin, dirty: false });
  assert.equal(formatRefOffPinWarning(result.ref), null);
  const cli = runCli(root);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `check-protocol-catalog: intentd catalog.rs from ${INTENTD_DIR} checkout ${pin.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})\nProtocol method catalog is consistent (Layer 1 + Layer 2).\n`);
  assert.equal(cli.stderr, '');
});

test('off the pin: results reflect the checkout and the stderr warning names both SHAs without changing the exit code', async (t) => {
  const { root, pin, advance } = await makeGitRoot(t);
  const head = await advance();
  assert.notEqual(head, pin);
  const result = await runChecks(root);
  assert.deepEqual(result.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: head, pin, dirty: false });
  assert.ok(messages(result).length >= 1, 'the checkout catalog.rs (with the extra method) is what was compared');
  assert.match(messages(result).join('\n'), /agent\.unwatch/);
  const banner = `check-protocol-catalog: intentd catalog.rs from ${INTENTD_DIR} checkout ${head.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})\n`;
  const warning = `warning: ${INTENTD_DIR} checkout ${head.slice(0, 7)} is off the recorded pin ${pin.slice(0, 7)}; results reflect the checkout, not the pin. Run git submodule update --checkout ${INTENTD_DIR} to compare against the pin.\n`;
  const cli = runCli(root);
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, banner);
  assert.ok(cli.stderr.startsWith(warning), cli.stderr);
  assert.match(cli.stderr, /agent\.unwatch/);
});

test('extractRustCatalog pulls the four constants from a realistic snippet', () => {
  const rust = extractRustCatalog(RUST);
  assert.deepEqual(rust.missing, []);
  assert.deepEqual(rust.routerMethods, ['agent.create', 'agent.list', 'agent.stop', 'github.pulls.list', 'github.relatedRepos.list', 'system.capabilities']);
  assert.deepEqual(rust.fastPathMethods, ['client.hello', 'host.openInEditor', 'system.status']);
  assert.deepEqual(rust.aliases, [['git.diff', 'git.diffs']]);
  assert.deepEqual(rust.reverseMethods, ['host.openExternal', 'host.openInEditor']);
  assert.deepEqual(extractRustCatalog('fn main() {}').missing, ['ROUTER_METHODS', 'FASTPATH_METHODS', 'METHOD_ALIASES', 'REVERSE_METHODS']);
});

test('parseCatalog reads sections, rows, and summary counts', () => {
  const c = parseCatalog(CATALOG);
  assert.deepEqual(c.missingSections, []);
  assert.deepEqual(c.routerRows.map((r) => [r.ns, r.count]), [['agent', 3], ['github', 2], ['system', 1]]);
  assert.equal(c.router.total, 6);
  assert.deepEqual(c.fastPath.names, ['client.hello', 'host.openInEditor', 'system.status']);
  assert.deepEqual(c.aliases.pairs.map((p) => [p.alias, p.canonical]), [['git.diff', 'git.diffs']]);
  assert.deepEqual(c.reverse.names.map((r) => r.name), ['host.openInEditor', 'host.openExternal']);
  assert.equal(c.summary.total, 10);
  assert.deepEqual([c.bullets.router.total, c.bullets.fastPath.total], [6, 3]);
});

test('collectDocumentedMethods reads rows, annotated rows, headings, and skips fences and prose cells', () => {
  const names = collectDocumentedMethods(METHODS_DOC).map((m) => m.name);
  assert.deepEqual(names, ['agent.create', 'agent.create', 'agent.list', 'agent.stop', 'github.relatedRepos.list', 'browser.docs', 'system.capabilities']);
  assert.deepEqual(methodNamesInFirstCell('agent.subscribe (deprecated)'), ['agent.subscribe']);
  assert.deepEqual(methodNamesInFirstCell('agent.resolveProposal *(v8.7, [intentd#1581](https://github.com/intent-hq/intentd/pull/1581))*'), ['agent.resolveProposal']);
  assert.deepEqual(methodNamesInFirstCell('browser.listTabs *(v9.10)*, browser.upsertTab *(v9.10)*'), ['browser.listTabs', 'browser.upsertTab']);
  assert.deepEqual(methodNamesInFirstCell('No decidable default (`model.defaultProvider` unset)'), []);
  assert.deepEqual(methodNamesInFirstCell('`model.defaultProvider` unset — falls through'), []);
});

test('Layer 1: explicit field tables do not declare methods or change catalog comparisons', async () => {
  const doc = `${METHODS_DOC}\n| Field | Qualified response |\n| --- | --- |\n| \`details.source\`, \`details.target\` | Confirmed branch identities. |\n`;
  const result = await runChecks(await makeRoot({ methods: { 'fields.md': doc } }));
  assert.deepEqual(messages(result), []);
  assert.deepEqual(warningMessages(result), []);
  assert.equal(result.layer2Ran, true);
});

test('collectDocumentedMethods recognizes field headers with alignment and escaped pipes', () => {
  for (const table of [
    '| Field | Meaning |\n| --- | --- |',
    '| field | Meaning |\n| :--- | ---: |',
    '| Field | Meaning |\n| - | -- |',
    '| FIELD | Meaning | Type |\n| :---: | --- | ---: |',
    '| Field | Meaning \\| notes |\n| --- | --- |',
    '| Field | Meaning\n| --- | ---',
  ]) {
    const extra = table.includes('| Type |') ? ' text |' : '';
    const doc = `${table}\n| source | Simple field. |${extra}\n| details.source | Nested field. |${extra}\n| \`details.target\`, details.branch *(v1)* | More fields \\| alternatives. |${extra}`;
    assert.deepEqual(collectDocumentedMethods(doc), [], table);
  }
});

test('collectDocumentedMethods preserves unknown methods under unknown or malformed headers', () => {
  for (const header of [
    '| Method | Result |\n| --- | --- |',
    '| Unknown | Result |\n| --- | --- |',
    '| Field names | Result |\n| --- | --- |',
    '| Field | Meaning |',
    '| Field | Meaning |\n\n| --- | --- |',
    '| Field | Meaning |\n| --- | invalid |',
    '| Field | Meaning |\n| invalid | --- |',
    '| Field | Meaning |\n| ---:--- | --- |',
    '| Field | Meaning |\n| : | --- |',
    '| Field | Meaning |\n| --- |',
    '| Field | Meaning |\n| --- | --- | --- |',
    '| Field | |\n| --- | --- |',
    '| Field | Meaning |\nnot a separator',
  ]) {
    for (const prefix of ['', '| Field | Meaning |\n| --- | --- |\n| details.source | Field. |\n']) {
      const doc = `${prefix}${header}\n| \`unknown.method\`, unknown.other *(v2)* | Result. |`;
      const line = doc.split('\n').length;
      assert.deepEqual(collectDocumentedMethods(doc), [
        { name: 'unknown.method', line }, { name: 'unknown.other', line },
      ], doc);
    }
  }
});

test('collectDocumentedMethods ends field context at table and non-table boundaries', () => {
  for (const boundary of [
    '',
    'Some prose.',
    '### Another table',
    '| Method | Result |\n| --- | --- |',
    '| Unknown | Result |\n| --- | --- |',
    '| Field | Meaning |\n| --- | invalid |',
    '| Unknown | Result |\n| invalid | --- |',
    '```text\n| Field | Result |\n| --- | --- |\n```',
    '~~~text\n| ignored.method | Result |\n~~~',
  ]) {
    const doc = `| Field | Meaning |\n| --- | --- |\n| details.source | Field. |\n${boundary}\n| unknown.method | Result. |`;
    assert.deepEqual(collectDocumentedMethods(doc), [
      { name: 'unknown.method', line: doc.split('\n').length },
    ], boundary);
  }
});

test('collectDocumentedMethods restarts field context for an adjacent field table', () => {
  const doc = '| Field | Meaning |\n| --- | --- |\n| details.source | Field. |\n| Field | Type | Meaning |\n| --- | --- | --- |\n| details.target | string | Field. |';
  assert.deepEqual(collectDocumentedMethods(doc), []);
});

test('Layer 1: field table boundaries preserve heading and row file:line diagnostics', async () => {
  const doc = '| Field | Meaning |\n| --- | --- |\n| details.source | Field. |\n### `unknown.heading`\n| unknown.legacy | Result. |\n| Unknown | Result |\n| --- | --- |\n| unknown.table | Result. |';
  const result = await runChecks(await makeRoot({ methods: { 'fields.md': doc } }));
  assert.deepEqual(messages(result), [
    'docs/protocol/methods/fields.md:4: error: unknown.heading is documented here but missing from docs/protocol/05-method-catalog.md',
    'docs/protocol/methods/fields.md:5: error: unknown.legacy is documented here but missing from docs/protocol/05-method-catalog.md',
    'docs/protocol/methods/fields.md:8: error: unknown.table is documented here but missing from docs/protocol/05-method-catalog.md',
  ]);
});

const PROTOCOL_DIR = new URL('../docs/protocol/', import.meta.url);
const SUBSCRIPTION_NAMES = ['note', 'task', 'agent', 'workspace', 'comment', 'chat', 'note.presence']
  .flatMap((channel) => [`${channel}.subscribe`, `${channel}.unsubscribe`]);

async function routingRows() {
  const text = await fs.readFile(new URL('workspace-routing.md', PROTOCOL_DIR), 'utf8');
  return text.split('\n').filter((line) => /\| (Add|Propagate|Exclude) \|/.test(line)).map((line) => {
    const [, cell, disposition, field, variant] = line.split('|').map((s) => s.trim());
    const names = methodNamesInFirstCell(cell);
    assert.ok(names.length > 0, `routing inventory must use exact names: ${line}`);
    assert.ok(variant, `routing inventory must explain the variant: ${line}`);
    if (disposition === 'Add') assert.equal(field, '`workspaceId`');
    if (disposition === 'Propagate') assert.ok(['`workspaceId`', '`targetWorkspaceId`'].includes(field), line);
    if (disposition === 'Exclude') assert.equal(field, '—');
    return { names, disposition, field, variant };
  });
}

test('workspace routing inventory covers every catalog name, alias, reverse RPC and snapshot channel exactly by variant', async () => {
  const catalog = parseCatalog(await fs.readFile(new URL('05-method-catalog.md', PROTOCOL_DIR), 'utf8'));
  const expected = new Set([
    ...catalog.routerRows.flatMap((row) => tokenizeRowSuffixes(row.cell).tokens.map((suffix) => `${row.ns}.${suffix}`)),
    ...catalog.fastPath.names,
    ...catalog.aliases.pairs.flatMap(({ alias, canonical }) => [alias, canonical]),
    ...catalog.reverse.names.map(({ name }) => name),
    ...SUBSCRIPTION_NAMES,
  ]);
  const rows = await routingRows();
  const actual = new Set(rows.flatMap(({ names }) => names));
  assert.deepEqual([...expected].filter((name) => !actual.has(name)), [], 'missing routing classifications');
  assert.deepEqual([...actual].filter((name) => !expected.has(name)), [], 'unknown or abbreviated method names');
  const variants = rows.flatMap(({ names, variant }) => names.map((name) => `${name}: ${variant}`));
  assert.equal(new Set(variants).size, variants.length, 'duplicate method/variant rows');

  // The channels are intercepted before router.rs and absent from most catalog constants.
  // Check their current classifier as well when intentd is initialized (CI initializes it).
  const source = await fs.readFile(new URL('../packages/intentd/crates/intent-transport/src/subscriptions.rs', import.meta.url), 'utf8')
    .catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (source !== null) {
    const classify = source.split('pub(crate) fn classify')[1].split('/// Validate')[0];
    const names = [...classify.matchAll(/"([a-z]+(?:\.[a-z]+)*\.(?:subscribe|unsubscribe))"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(names)].sort(), [...SUBSCRIPTION_NAMES].sort());
  }
});

test('routing inventory preserves source export, target reads and scope-sensitive method variants', async () => {
  const rows = await routingRows();
  const forMethod = (name) => rows.filter((row) => row.names.includes(name));
  const dispositions = (name) => [...new Set(forMethod(name).map((row) => row.disposition))].sort();
  assert.deepEqual(dispositions('workspace.export.start'), ['Propagate']);
  for (const method of ['workspace.export.read', 'workspace.export.finalize', 'workspace.export.abort']) {
    assert.deepEqual(dispositions(method), ['Add']);
    assert.match(forMethod(method)[0].variant, /Source workspace/);
  }
  for (const method of ['crossWorkspace.readNote', 'crossWorkspace.listNotes']) {
    assert.equal(forMethod(method)[0].field, '`targetWorkspaceId`');
  }
  for (const method of ['mcp.servers.toggle', 'search.messages', 'search.events', 'events.subscribe', 'rules.list', 'rules.get']) {
    assert.deepEqual(dispositions(method), ['Exclude', 'Propagate']);
  }
  for (const method of ['specialist.create', 'specialist.edit', 'specialist.delete', 'events.unsubscribe', 'search.cancel']) {
    assert.deepEqual(dispositions(method), ['Add', 'Exclude']);
  }
  assert.deepEqual(dispositions('agent.unsubscribe'), ['Exclude', 'Propagate']);
  assert.match(forMethod('agent.subscribe').find((row) => /Collection-channel/.test(row.variant)).variant, /events\.unsubscribe/);
  for (const method of ['workspace.import.begin', 'workspace.import.chunk', 'workspace.import.commit', 'workspace.import.abort', 'system.shutdown']) {
    assert.deepEqual(dispositions(method), ['Exclude']);
  }
});
