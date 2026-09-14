import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CATALOG_PATH,
  DOCUMENTED_NOT_DISPATCHABLE,
  INTENTD_CATALOG_PATH,
  METHODS_DIR,
  collectDocumentedMethods,
  extractRustCatalog,
  formatError,
  methodNamesInFirstCell,
  parseCatalog,
  runChecks,
  tokenizeRowSuffixes,
} from './check-protocol-catalog.mjs';

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

test('passing fixture: both layers run and report no errors', async () => {
  const result = await runChecks(await makeRoot());
  assert.deepEqual(messages(result), []);
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

test('Layer 2: a row Count that disagrees with catalog.rs fails', async () => {
  const rust = RUST.replace('    "agent.stop",\n', '');
  const catalog = CATALOG.replace('create, list, stop — live agents', 'create, list — live agents');
  const result = await runChecks(await makeRoot({ catalog, rust, methods: { 'agents.md': METHODS_DOC.replace('| agent.stop | agentId (req) | { ok } |\n', '') } }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| agent |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: agent row says 3 methods but ${INTENTD_CATALOG_PATH} ROUTER_METHODS has 2`,
    `docs/protocol/05-method-catalog.md:${line}: error: agent row says 3 methods but lists 2 (create, list)`,
  ]);
});

test('Layer 2: catalog entries absent from catalog.rs are orphans with the rebase hint', async () => {
  const rust = RUST.replace('    "github.relatedRepos.list",\n', '').replace('    "client.hello",\n', '');
  const result = await runChecks(await makeRoot({ rust }));
  const msgs = messages(result);
  assert.equal(msgs.length, 4, msgs.join('\n'));
  assert.match(msgs[0], /^docs\/protocol\/05-method-catalog\.md:\d+: error: github row says 2 methods but .* has 1$/);
  assert.match(msgs[1], /^docs\/protocol\/05-method-catalog\.md:\d+: error: github\.relatedRepos\.list is listed in the github row but is not a router method in the pinned intentd catalog\.rs — if the intentd PR adding it merged after this branch was cut, rebase onto main \(the submodule pin advances automatically\) and re-run$/);
  assert.match(msgs[2], /^docs\/protocol\/05-method-catalog\.md:\d+: error: github\.relatedRepos\.list is listed in the catalog but not in the pinned intentd catalog\.rs — if the intentd PR adding it merged after this branch was cut, rebase onto main \(the submodule pin advances automatically\) and re-run$/);
  assert.match(msgs[3], /client\.hello is listed in the catalog but not in the pinned intentd catalog\.rs/);
});

test('Layer 2: a fake suffix in a row whose Count still matches catalog.rs fails naming it', async () => {
  const catalog = CATALOG.replace('| github | 2 | pulls.list, relatedRepos.list |', '| github | 2 | pulls.list, relatedRepos.list, fake |');
  const result = await runChecks(await makeRoot({ catalog }));
  const line = catalog.split('\n').findIndex((l) => l.startsWith('| github |')) + 1;
  assert.deepEqual(messages(result), [
    `docs/protocol/05-method-catalog.md:${line}: error: github row says 2 methods but lists 3 (pulls.list, relatedRepos.list, fake)`,
    `docs/protocol/05-method-catalog.md:${line}: error: github.fake is listed in the github row but is not a router method in the pinned intentd catalog.rs — if the intentd PR adding it merged after this branch was cut, rebase onto main (the submodule pin advances automatically) and re-run`,
  ]);
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

test('Layer 2: a whole documented namespace absent from catalog.rs is an orphan row', async () => {
  const rust = RUST.replace('    "github.pulls.list",\n    "github.relatedRepos.list",\n', '');
  const result = await runChecks(await makeRoot({ rust }));
  assert.match(messages(result)[0], /router namespace github is listed in the catalog but not in the pinned intentd catalog\.rs/);
});

test('Layer 2 is skipped (exit 0 on Layer 1 alone) when catalog.rs is absent', async () => {
  const result = await runChecks(await makeRoot({ rust: null }));
  assert.deepEqual(messages(result), []);
  assert.equal(result.layer2Ran, false);
  assert.equal(result.skipped, `skipped: ${INTENTD_CATALOG_PATH} (submodule not initialized)`);
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
