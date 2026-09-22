import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CheckError } from './check-makefile-targets.mjs';
import {
  INDEX_PATH,
  INTENTD_DIR,
  PROTOCOL_DIR,
  RENAMED_BINDINGS,
  TOOLS_RS_IN_INTENTD,
  TOOLS_RS_PATH,
  collectDocMentions,
  describeCheckout,
  extractHelpText,
  formatBanner,
  formatError,
  formatOffPinWarning,
  identifiersIn,
  maskLiterals,
  mergeBindings,
  parseBindings,
  renderIndex,
  runChecks,
  splitArgs,
} from './check-mcp-bindings.mjs';
import { cleanNodeEnv } from './test-env.mjs';

const SCRIPT = fileURLToPath(new URL('./check-mcp-bindings.mjs', import.meta.url));

const BASE_HELP = `Execute JavaScript against the workspace API.

Namespaces (index — full signatures in API below):
  ws.help(namespace?) — runtime docs
  ws.agent.* — create/delegate/message/watch agents
  ws.workspace.* — workspace info

API:
  ws.help(namespace?) → string  // Offline API docs; \`ws.help("pr")\` returns one namespace.

  ws.workspace.info() → { id, path }  // Current workspace ID + absolute path.
  ws.workspace.setStatusImage({ data, mimeType, originalName? } | null) → { ok, statusImageAssetId, url? }  // Set or clear the status image.

  ws.agent.create(name, message, opts?) → { ok, id?, text?, ... }  // Create a sub-agent, or with \`topLevel: true\` a peer.
    With \`topLevel: true\` the created agent is a co-equal peer (name, message, ignoredContinuation).
  ws.agent.send(agentId, message, priority?) → { ok, agentId, delivery?, ... }  // Send a message; the third argument also takes \`{ priority?, replacePending? }\`.
  ws.agent.list(optsOrIncludeCompleted?) → [agents]  // Lists agents.
  ws.agent.watch(agentId) → { ok, subscriptionId, agentId }  // Watch another agent.
  ws.hook.schedule({ name, code, delayMs | cron | runAt, ttlMs?, perpetual? }) → { hook, dispatched }  // Register a hook.
  ws.pr.snapshot(prNumber, { repo? }?) → { repo, checks: { total, failedNames }, requirements: { state, threads: { unresolved? } } }  // One-shot read.

Examples:
  return await ws.workspace.info()
  ws.fake.example(arg) → nothing
`;

const CHIEF_HELP = `Execute JavaScript against the workspace API.

API:
  ws.help(namespace?) → string  // Offline API docs.
  ws.workspace.info() → { id, path }  // Current workspace ID + absolute path.
  ws.app.question.ask({ header, question, options, explanation?, multiSelect? }) → { ok, attachmentId, message }  // Ask ONE question. Example: ws.app.question.ask({ header: "Auth", options: [{ label: "OAuth" }] }).
  ws.app.settings.propose(changes[] | { changes }) → ProposalCard  // Preview settings changes.
  ws.agent.create(name, message, opts?) → { ok, id?, text?, ... }  // Create a sub-agent.
`;

const RUST = `//! MCP tools.

pub(crate) const WORKSPACE_API_DESCRIPTION: &str = r###"${BASE_HELP}"###;

/// Chief-workspace variant.
pub(crate) const WORKSPACE_API_DESCRIPTION_CHIEF: &str = r###"${CHIEF_HELP}"###;

fn other() {}
`;

const AGENTS_DOC = `> Part of the protocol docs — MCP \`ws.agent.*\` bindings.

### 5.5 Agents

\`ws.agent.create(name, message, opts?)\` creates a sub-agent; \`ws.agent.create({ topLevel: true })\` creates a peer.
Historical: \`ws.agent.spawnPeer(name, message, opts?)\` was renamed. \`ws.agent.send(agentId, msg, "queue")\` queues.
The \`ws.agent.*\` namespace is gated; \`ws.help("agent")\` prints it. \`ws.pr.snapshot(887)\` and
\`ws.pr.snapshot(prNumber, { repo? })\` are one-shot reads. \`ws.hook.schedule({ name, code, delayMs })\` waits.

\`\`\`javascript
await ws.agent.nonexistent({ bogus: true })
\`\`\`
`;

async function makeRoot({ rust = RUST, docs = { 'methods/agents.md': AGENTS_DOC }, index } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-mcp-bindings-'));
  for (const [rel, text] of Object.entries(docs)) {
    const file = path.join(root, PROTOCOL_DIR, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  if (rust !== null) {
    await fs.mkdir(path.dirname(path.join(root, TOOLS_RS_PATH)), { recursive: true });
    await fs.writeFile(path.join(root, TOOLS_RS_PATH), rust);
  }
  if (index !== undefined) {
    await fs.mkdir(path.dirname(path.join(root, INDEX_PATH)), { recursive: true });
    await fs.writeFile(path.join(root, INDEX_PATH), index);
  }
  return root;
}

const messages = (result) => result.errors.map(formatError);
const allBindings = () => mergeBindings(parseBindings(BASE_HELP), parseBindings(CHIEF_HELP));

test('extractHelpText returns both raw-string bodies and reports missing constants', () => {
  const help = extractHelpText(RUST);
  assert.deepEqual(help.missing, []);
  assert.equal(help.base, BASE_HELP);
  assert.equal(help.chief, CHIEF_HELP);
  assert.deepEqual(extractHelpText('fn main() {}').missing, ['WORKSPACE_API_DESCRIPTION', 'WORKSPACE_API_DESCRIPTION_CHIEF']);
});

test('parseBindings reads only API entry lines and splits params, options, and result fields', () => {
  const bindings = parseBindings(BASE_HELP);
  const byName = Object.fromEntries(bindings.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(byName), [
    'ws.help', 'ws.workspace.info', 'ws.workspace.setStatusImage', 'ws.agent.create', 'ws.agent.send',
    'ws.agent.list', 'ws.agent.watch', 'ws.hook.schedule', 'ws.pr.snapshot',
  ]);
  assert.deepEqual(byName['ws.help'], { name: 'ws.help', params: ['namespace'], positional: ['namespace?'], resultFields: [], signature: 'ws.help(namespace?) → string' });
  assert.deepEqual(byName['ws.workspace.setStatusImage'].params, ['data', 'mimeType', 'originalName']);
  assert.deepEqual(byName['ws.workspace.setStatusImage'].resultFields, ['ok', 'statusImageAssetId', 'url']);
  assert.equal(byName['ws.agent.create'].signature, 'ws.agent.create(name, message, opts?) → { ok, id?, text?, ... }');
  assert.deepEqual(byName['ws.agent.create'].params, ['name', 'message', 'opts']);
  assert.deepEqual(byName['ws.agent.list'].resultFields, ['agents']);
  assert.deepEqual(byName['ws.hook.schedule'].params, ['name', 'code', 'delayMs', 'cron', 'runAt', 'ttlMs', 'perpetual']);
  assert.deepEqual(byName['ws.pr.snapshot'].positional, ['prNumber', '{ repo? }?']);
  assert.deepEqual(byName['ws.pr.snapshot'].resultFields, ['repo', 'checks', 'total', 'failedNames', 'requirements', 'state', 'threads', 'unresolved']);
  assert.ok(!('ws.fake.example' in byName), 'lines after the API section (Examples) are not bindings');
  assert.deepEqual(parseBindings('  ws.a.b(x) → { y }  // no API: heading').map((b) => b.name), ['ws.a.b']);
});

test('parseBindings handles 3-level names, union defaults, and string literals in comments', () => {
  const byName = Object.fromEntries(parseBindings(CHIEF_HELP).map((b) => [b.name, b]));
  assert.deepEqual(byName['ws.app.question.ask'].params, ['header', 'question', 'options', 'explanation', 'multiSelect']);
  assert.deepEqual(byName['ws.app.settings.propose'], {
    name: 'ws.app.settings.propose', params: ['changes'], positional: ['changes[] | { changes }'], resultFields: ['ProposalCard'],
    signature: 'ws.app.settings.propose(changes[] | { changes }) → ProposalCard',
  });
});

test('identifiersIn and splitArgs drop literals, keywords, values after ":" and nested commas', () => {
  assert.deepEqual(identifiersIn('{ priority: "queue", replacePending: true, tasks: [a, b] }'), ['priority', 'replacePending', 'tasks', 'a', 'b']);
  assert.deepEqual(identifiersIn('{ priority: "queue", tasks: [a, { b: c }], x }, { y: { z } }', { dropValues: true }), ['priority', 'tasks', 'x', 'y']);
  assert.deepEqual(identifiersIn('{ checks: { total, items }, ok? }'), ['checks', 'total', 'items', 'ok']);
  assert.deepEqual(identifiersIn('{ data, mimeType } | null'), ['data', 'mimeType']);
  assert.deepEqual(identifiersIn("887, 'x'"), []);
  assert.deepEqual(splitArgs('prNumber, { repo?, a: [1, 2] }, (x, y)'), ['prNumber', '{ repo?, a: [1, 2] }', '(x, y)']);
  assert.deepEqual(splitArgs(''), []);
});

test('maskLiterals blanks literal contents (escape-aware) so brackets, commas and colons inside them are inert', () => {
  const text = 'a, "x, (y: z)", \'q\\"r)\', "open';
  const masked = maskLiterals(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked, 'a, "         ", \'     \', "    ');
  assert.equal(maskLiterals('"trailing\\'), '"         ');
  assert.deepEqual(splitArgs('id, "a, b", { repo: "o/n)", repoo: true }'), ['id', '"a, b"', '{ repo: "o/n)", repoo: true }']);
  assert.deepEqual(identifiersIn('{ repo: "o/n)", repoo: true, k: "x: [ignored]" }', { dropValues: true }), ['repo', 'repoo', 'k']);
});

test('mergeBindings unions by name with the first list winning', () => {
  const merged = allBindings();
  assert.equal(merged.filter((b) => b.name === 'ws.agent.create').length, 1);
  assert.equal(merged.filter((b) => b.name === 'ws.help').length, 1);
  assert.ok(merged.some((b) => b.name === 'ws.app.question.ask'));
  assert.equal(merged.length, 9 + 2);
});

test('renderIndex is deterministic, table-free, and keeps binding names out of headings', () => {
  const bindings = allBindings();
  const rendered = renderIndex(bindings);
  assert.equal(renderIndex([...bindings].reverse()), rendered);
  assert.ok(!rendered.split('\n').some((l) => l.startsWith('|')), 'no markdown tables');
  const headings = rendered.split('\n').filter((l) => /^#{1,6} /.test(l));
  assert.deepEqual(headings, [
    '## MCP `ws.*` binding signatures', '### ws', '### ws.agent', '### ws.app.question', '### ws.app.settings',
    '### ws.hook', '### ws.pr', '### ws.workspace',
  ]);
  for (const h of headings) assert.ok(!/`ws\.[a-z]+\.[A-Za-z]+`/.test(h), `heading names a binding: ${h}`);
  assert.match(rendered, /### ws\n\n```text\nws\.help\(namespace\?\) → string\n```/);
  assert.match(rendered, /ws\.agent\.create\(name, message, opts\?\) → \{ ok, id\?, text\?, \.\.\. \}\nws\.agent\.list/);
  assert.ok(!rendered.includes('Create a sub-agent'), 'comment text is omitted');
});

test('collectDocMentions returns names and inline-code signatures outside fences with line numbers', () => {
  const { names, signatures } = collectDocMentions(AGENTS_DOC);
  assert.deepEqual(names.filter((n) => n.line === 1), [{ name: 'ws.agent', line: 1 }]);
  assert.ok(names.some((n) => n.name === 'ws.agent.spawnPeer' && n.line === 6));
  assert.ok(!names.some((n) => n.name === 'ws.agent.nonexistent'), 'fenced code is skipped');
  assert.deepEqual(signatures.map((s) => [s.name, s.args, s.line]), [
    ['ws.agent.create', 'name, message, opts?', 5],
    ['ws.agent.create', '{ topLevel: true }', 5],
    ['ws.agent.spawnPeer', 'name, message, opts?', 6],
    ['ws.agent.send', 'agentId, msg, "queue"', 6],
    ['ws.help', '"agent"', 7],
    ['ws.pr.snapshot', '887', 7],
    ['ws.pr.snapshot', 'prNumber, { repo? }', 8],
    ['ws.hook.schedule', '{ name, code, delayMs }', 8],
  ]);
});

test('collectDocMentions keeps complete identifiers and is quote-aware inside inline-code calls', () => {
  const doc = [
    'Call `ws.agent.list2()` or ws.agent.list_all or `ws.agent.list$x`; not xws.agent.list.',
    '`ws.pr.snapshot(prNumber, { repo: "team/repo)", repoo: true })` and `ws.pr.snapshot(1, { repo: "team/repo(" })`.',
    '`ws.agent.send(id, "call ws.fake.inner(1)")`.',
    "`ws.agent.send(id, 'see ws.fake.single')` then ws.fake.bare; don't stop.",
  ].join('\n');
  const { names, signatures } = collectDocMentions(doc);
  assert.deepEqual(names.filter((n) => n.line === 1).map((n) => n.name), ['ws.agent.list2', 'ws.agent.list_all', 'ws.agent.list$x']);
  assert.deepEqual(names.filter((n) => n.line === 3).map((n) => n.name), ['ws.agent.send']);
  assert.deepEqual(names.filter((n) => n.line === 4).map((n) => n.name), ['ws.agent.send', 'ws.fake.bare']);
  assert.deepEqual(signatures.map((s) => [s.name, s.args, s.line]), [
    ['ws.agent.list2', '', 1],
    ['ws.pr.snapshot', 'prNumber, { repo: "team/repo)", repoo: true }', 2],
    ['ws.pr.snapshot', '1, { repo: "team/repo(" }', 2],
    ['ws.agent.send', 'id, "call ws.fake.inner(1)"', 3],
    ['ws.agent.send', "id, 'see ws.fake.single'", 4],
  ]);
});

test('RENAMED_BINDINGS maps only ws.agent.spawnPeer', () => {
  assert.deepEqual([...RENAMED_BINDINGS], [['ws.agent.spawnPeer', 'ws.agent.create({ topLevel: true })']]);
});

const VALID_DOC = AGENTS_DOC.replace('`ws.agent.send(agentId, msg, "queue")` queues.', '`ws.agent.send(agentId, message, "queue")` queues.');

test('passing fixture: --write creates the index, then the plain run reports no errors', async () => {
  const root = await makeRoot({ docs: { 'methods/agents.md': VALID_DOC } });
  const written = await runChecks(root, { write: true });
  assert.equal(written.wrote, true);
  assert.deepEqual(messages(written), []);
  assert.equal(await fs.readFile(path.join(root, INDEX_PATH), 'utf8'), renderIndex(allBindings()));
  const plain = await runChecks(root);
  assert.equal(plain.wrote, false);
  assert.equal(plain.skipped, null);
  assert.deepEqual(messages(plain), []);
  assert.equal(plain.bindings.length, 11);
});

test('a missing index fails naming the file and the --write command', async () => {
  const result = await runChecks(await makeRoot({ docs: { 'methods/agents.md': VALID_DOC } }));
  assert.deepEqual(messages(result), [
    `${INDEX_PATH}:1: error: index is missing — run \`node scripts/check-mcp-bindings.mjs --write\` to regenerate the index, then update the prose that documents the binding`,
  ]);
});

test('a binding missing from the committed index fails naming it', async () => {
  const index = renderIndex(allBindings()).replace('ws.agent.watch(agentId) → { ok, subscriptionId, agentId }\n', '');
  const result = await runChecks(await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index }));
  assert.deepEqual(messages(result), [
    `${INDEX_PATH}:1: error: ws.agent.watch is in the help text but missing from the index: ws.agent.watch(agentId) → { ok, subscriptionId, agentId } — run \`node scripts/check-mcp-bindings.mjs --write\` to regenerate the index, then update the prose that documents the binding`,
  ]);
});

test('a result field removed from an index line fails naming the binding at its line', async () => {
  const good = renderIndex(allBindings());
  const index = good.replace('→ { ok, statusImageAssetId, url? }', '→ { ok, statusImageAssetId }');
  const result = await runChecks(await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index }));
  const line = index.split('\n').findIndex((l) => l.startsWith('ws.workspace.setStatusImage(')) + 1;
  assert.equal(messages(result).length, 1);
  assert.match(messages(result)[0], new RegExp(`^${INDEX_PATH.replaceAll('.', '\\.')}:${line}: error: ws\\.workspace\\.setStatusImage differs from the help text: index has "ws\\.workspace\\.setStatusImage\\(\\{ data, mimeType, originalName\\? \\} \\| null\\) → \\{ ok, statusImageAssetId \\}" but the help text has ".*url\\? \\}"`));
});

test('a stale index line for a binding no longer in the help text fails, and header-only drift is reported', async () => {
  const good = renderIndex(allBindings());
  const stale = good.replace('ws.agent.watch(agentId)', 'ws.agent.watch(agentId) → { ok }\nws.agent.gone(x)');
  const result = await runChecks(await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index: stale }));
  assert.ok(messages(result).some((m) => /ws\.agent\.gone is in the index but not in the help text: ws\.agent\.gone\(x\) → \{ ok, subscriptionId, agentId \}/.test(m)), messages(result).join('\n'));
  const header = await runChecks(await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index: `${good}\nhand edit\n` }));
  assert.deepEqual(messages(header), [
    `${INDEX_PATH}:1: error: index text differs from the rendered output outside the signature lines — run \`node scripts/check-mcp-bindings.mjs --write\` to regenerate the index, then update the prose that documents the binding`,
  ]);
});

const withIndex = (docs) => makeRoot({ docs, index: renderIndex(allBindings()) });

test('a doc mention of a binding absent from the help text fails with file:line, in nested directories too', async () => {
  const doc = `${VALID_DOC}\nSee \`ws.agent.teleport(agentId)\` and the \`ws.nope\` namespace.\n`;
  const result = await runChecks(await withIndex({ 'methods/agents.md': VALID_DOC, 'guides/nested.md': doc }));
  const line = doc.split('\n').length - 1;
  assert.deepEqual(messages(result), [
    `${PROTOCOL_DIR}/guides/nested.md:${line}: error: ws.agent.teleport is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs`,
    `${PROTOCOL_DIR}/guides/nested.md:${line}: error: ws.nope is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs`,
  ]);
});

test('an unknown name that extends a known one is rejected in full, not truncated to the known binding', async () => {
  const doc = `${VALID_DOC}\nSee \`ws.agent.list2()\` and \`ws.agent.list_all\`.\n`;
  const result = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  const line = doc.split('\n').length - 1;
  assert.deepEqual(messages(result), [
    `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.agent.list2 is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs`,
    `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.agent.list_all is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs`,
  ]);
});

test('a ws.* name inside a string literal in an inline-code example is not a mention; the same name outside one still fails', async () => {
  const doc = `${VALID_DOC}\n\`ws.agent.send(agentId, "see ws.example.foo")\` is fine.\nBut \`ws.example.foo\` is not.\n`;
  const result = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  const line = doc.split('\n').length - 1;
  assert.deepEqual(messages(result), [
    `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.example.foo is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs`,
  ]);
});

test('a stale option after a literal containing parentheses is still rejected', async () => {
  const doc = `${VALID_DOC}\n\`ws.pr.snapshot(prNumber, { repo: "team/repo)", repoo: true })\` and \`ws.pr.snapshot(1, { repo: "team/repo(", repoo: true })\`.\n`;
  const result = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  const line = doc.split('\n').length - 1;
  const expected = `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.pr.snapshot: "repoo" is not a parameter or option of ws.pr.snapshot in the help text — signature is ws.pr.snapshot(prNumber, { repo? }?) → { repo, checks: { total, failedNames }, requirements: { state, threads: { unresolved? } } }`;
  assert.deepEqual(messages(result), [expected, expected]);
});

test('a renamed binding listed in RENAMED_BINDINGS passes; an unlisted rename fails', async () => {
  assert.deepEqual(messages(await runChecks(await withIndex({ 'methods/agents.md': VALID_DOC }))), []);
  const doc = VALID_DOC.replace('ws.agent.spawnPeer', 'ws.agent.spawnClone');
  const result = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  assert.equal(messages(result).length, 1);
  assert.match(messages(result)[0], /^docs\/protocol\/methods\/agents\.md:6: error: ws\.agent\.spawnClone is not a binding/);
});

test('a prose signature using an option absent from the help text fails naming binding, option, and signature', async () => {
  const result = await runChecks(await withIndex({ 'methods/agents.md': AGENTS_DOC }));
  assert.deepEqual(messages(result), [
    `${PROTOCOL_DIR}/methods/agents.md:6: error: ws.agent.send: "msg" is not a parameter or option of ws.agent.send in the help text — signature is ws.agent.send(agentId, message, priority?) → { ok, agentId, delivery?, ... }`,
  ]);
  const doc = `${VALID_DOC}\n\`ws.hook.schedule({ name, code, delayMs, ttl: 5 })\` and \`ws.pr.snapshot(prNumber, { repository: "o/n" })\`.\n`;
  const more = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  const line = doc.split('\n').length - 1;
  assert.deepEqual(messages(more), [
    `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.hook.schedule: "ttl" is not a parameter or option of ws.hook.schedule in the help text — signature is ws.hook.schedule({ name, code, delayMs | cron | runAt, ttlMs?, perpetual? }) → { hook, dispatched }`,
    `${PROTOCOL_DIR}/methods/agents.md:${line}: error: ws.pr.snapshot: "repository" is not a parameter or option of ws.pr.snapshot in the help text — signature is ws.pr.snapshot(prNumber, { repo? }?) → { repo, checks: { total, failedNames }, requirements: { state, threads: { unresolved? } } }`,
  ]);
});

test('valid prose signatures pass: literals, partial option lists, opaque option bags, namespace prefixes, fenced code', async () => {
  const doc = `${VALID_DOC}
\`ws.agent.create({ topLevel: true, ... })\`, \`ws.agent.send(agentId, message, { priority: "queue", replacePending: true })\`,
\`ws.workspace.setStatusImage({ data, mimeType })\`, \`ws.workspace.setStatusImage(null)\`, \`ws.agent.list(true)\`,
\`ws.app.question.ask({ header, question, options: [{ label: "A" }] })\`, \`ws.hook.*\`, \`ws.app.question\`, \`ws.help()\`,
\`ws.pr.snapshot(prNumber, { repo: "team/repo)" })\`, \`ws.pr.snapshot(1, { repo: "a(b, c: d" })\`, \`ws.help("x\\"y(")\`.
`;
  const result = await runChecks(await withIndex({ 'methods/agents.md': doc }));
  assert.deepEqual(messages(result), []);
});

test('everything is skipped (exit 0) when tools.rs is absent', async () => {
  const result = await runChecks(await makeRoot({ rust: null }));
  assert.deepEqual(messages(result), []);
  assert.equal(result.skipped, `skipped: ${TOOLS_RS_PATH} (submodule not initialized)`);
});

test('a tools.rs without the constants fails naming each missing constant', async () => {
  const result = await runChecks(await makeRoot({ rust: 'fn main() {}' }));
  assert.deepEqual(messages(result), [
    `${TOOLS_RS_PATH}:1: error: could not extract the WORKSPACE_API_DESCRIPTION constant`,
    `${TOOLS_RS_PATH}:1: error: could not extract the WORKSPACE_API_DESCRIPTION_CHIEF constant`,
  ]);
});


const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A passing fixture whose packages/intentd is a nested git repo with RUST committed, recorded as the
// monorepo gitlink. `advance()` commits an extra binding in intentd so the checkout moves off the pin.
async function makeGitRoot(t) {
  const root = await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index: renderIndex(allBindings()) });
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
    const ahead = RUST.replace('  ws.agent.watch(agentId)', '  ws.agent.unwatch(id) → { ok, removed }  // Stop watching.\n  ws.agent.watch(agentId)');
    await fs.writeFile(path.join(intentd, TOOLS_RS_IN_INTENTD), ahead);
    git(intentd, 'commit', '-q', '-am', 'ahead of the pin');
    return git(intentd, 'rev-parse', 'HEAD');
  };
  return { root, intentd, pin, advance };
}

const runCli = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: cleanNodeEnv() });
const names = (result) => result.bindings.map((b) => b.name);

test('formatBanner and formatOffPinWarning render the ref shapes; unknown refs print nothing', () => {
  const checkout = 'a'.repeat(40);
  const pin = 'b'.repeat(40);
  const dir = INTENTD_DIR;
  assert.equal(formatBanner({ source: 'checkout', dir, checkout, pin }), `check-mcp-bindings: intentd help text from ${INTENTD_DIR} checkout aaaaaaa (recorded pin bbbbbbb)`);
  assert.equal(formatBanner({ source: 'checkout', dir, checkout, pin: null }), `check-mcp-bindings: intentd help text from ${INTENTD_DIR} checkout aaaaaaa (recorded pin unreadable)`);
  assert.equal(formatBanner({ source: 'pin', dir, pin }), 'check-mcp-bindings: intentd help text from recorded pin bbbbbbb');
  assert.equal(formatBanner({ source: 'checkout', dir, checkout: null, pin }), null);
  assert.equal(formatBanner(null), null);
  assert.equal(
    formatOffPinWarning({ source: 'checkout', dir, checkout, pin }),
    `warning: ${INTENTD_DIR} checkout aaaaaaa is off the recorded pin bbbbbbb; results reflect the checkout, not the pin. Run PINNED=1 make check-mcp-bindings (node scripts/check-mcp-bindings.mjs --pinned) to compare against the pin.`,
  );
  assert.equal(formatOffPinWarning({ source: 'checkout', dir, checkout: pin, pin }), null);
  assert.equal(formatOffPinWarning({ source: 'checkout', dir, checkout, pin: null }), null);
  assert.equal(formatOffPinWarning({ source: 'pin', dir, pin }), null);
  assert.equal(formatOffPinWarning(null), null);
});

test('a root outside any git repository yields an unknown ref: no banner, no warning, checks unchanged', async () => {
  const root = await makeRoot({ docs: { 'methods/agents.md': VALID_DOC }, index: renderIndex(allBindings()) });
  assert.deepEqual(describeCheckout(root), { source: 'checkout', dir: INTENTD_DIR, checkout: null, pin: null });
  const result = await runChecks(root);
  assert.deepEqual(messages(result), []);
  assert.equal(formatBanner(result.ref), null);
  assert.equal(formatOffPinWarning(result.ref), null);
  const skipped = await runChecks(await makeRoot({ rust: null }));
  assert.equal(skipped.ref, null);
});

test('at the pin: the banner names checkout == pin, no warning, exit code and output otherwise unchanged', async (t) => {
  const { root, pin } = await makeGitRoot(t);
  const result = await runChecks(root);
  assert.deepEqual(messages(result), []);
  assert.deepEqual(result.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: pin, pin });
  assert.equal(formatOffPinWarning(result.ref), null);
  const cli = runCli(root);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `check-mcp-bindings: intentd help text from ${INTENTD_DIR} checkout ${pin.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})\nMCP ws.* bindings are consistent (11 bindings).\n`);
  assert.equal(cli.stderr, '');
});

test('off the pin: results reflect the checkout and the stderr warning names both SHAs without changing the exit code', async (t) => {
  const { root, pin, advance } = await makeGitRoot(t);
  const head = await advance();
  assert.notEqual(head, pin);
  const result = await runChecks(root);
  assert.deepEqual(result.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: head, pin });
  assert.ok(names(result).includes('ws.agent.unwatch'), 'the checkout help text is what was parsed');
  assert.equal(messages(result).length, 1);
  assert.match(messages(result)[0], /ws\.agent\.unwatch is in the help text but missing from the index/);
  const warning = `warning: ${INTENTD_DIR} checkout ${head.slice(0, 7)} is off the recorded pin ${pin.slice(0, 7)}; results reflect the checkout, not the pin. Run PINNED=1 make check-mcp-bindings (node scripts/check-mcp-bindings.mjs --pinned) to compare against the pin.\n`;
  const failing = runCli(root);
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, `check-mcp-bindings: intentd help text from ${INTENTD_DIR} checkout ${head.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})\n`);
  assert.ok(failing.stderr.startsWith(warning), failing.stderr);
  const written = runCli(root, '--write');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stderr, warning, 'the warning is the only stderr output of a passing off-pin run');
  assert.match(written.stdout, /^check-mcp-bindings: intentd help text from packages\/intentd checkout [0-9a-f]{7} \(recorded pin [0-9a-f]{7}\)\nWrote docs\/protocol\/methods\/mcp-bindings\.md \(12 bindings\)\.\nMCP ws\.\* bindings are consistent \(12 bindings\)\.\n$/);
});

test('runChecks with a relative root reports the same off-pin ref as the absolute root', async (t) => {
  const { root, pin, advance } = await makeGitRoot(t);
  const head = await advance();
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const relative = await runChecks('.');
  assert.deepEqual(relative.ref, { source: 'checkout', dir: INTENTD_DIR, checkout: head, pin });
  assert.deepEqual(relative.ref, (await runChecks(root)).ref);
  assert.ok(formatBanner(relative.ref));
  assert.ok(formatOffPinWarning(relative.ref));
});

test('without git on PATH the default run stays exit 0 with no provenance and --pinned exits 2 naming the missing git', async (t) => {
  const { root, pin } = await makeGitRoot(t);
  const emptyBin = await fs.mkdtemp(path.join(os.tmpdir(), 'check-mcp-bindings-nogit-'));
  t.after(() => fs.rm(emptyBin, { recursive: true, force: true }));
  const noGit = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: cleanNodeEnv({ PATH: emptyBin }) });
  const plain = noGit();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'MCP ws.* bindings are consistent (11 bindings).\n');
  assert.equal(plain.stderr, '');
  const pinned = noGit('--pinned');
  assert.equal(pinned.status, 2);
  assert.equal(pinned.stdout, '');
  assert.equal(pinned.stderr, 'error: git not found on PATH; install git or add it to PATH and retry\n');
  assert.ok(!pinned.stderr.includes('monorepo root'));
  assert.ok(!pinned.stderr.includes(pin.slice(0, 7)), 'no pin is fabricated without git');
});

test('--pinned reads tools.rs at the recorded gitlink through git objects, never the worktree, and composes with --write', async (t) => {
  const { root, intentd, pin, advance } = await makeGitRoot(t);
  await advance();
  await fs.writeFile(path.join(intentd, TOOLS_RS_IN_INTENTD), 'fn main() {}');
  assert.equal(messages(await runChecks(root)).length, 2, 'the checkout run sees the dirty worktree file');
  const pinned = await runChecks(root, { pinned: true });
  assert.deepEqual(pinned.ref, { source: 'pin', dir: INTENTD_DIR, pin });
  assert.deepEqual(messages(pinned), []);
  assert.ok(!names(pinned).includes('ws.agent.unwatch'), 'the pin does not have the checkout-only binding');
  assert.equal(pinned.bindings.length, 11);
  assert.equal(formatOffPinWarning(pinned.ref), null);
  const cli = runCli(root, '--pinned');
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `check-mcp-bindings: intentd help text from recorded pin ${pin.slice(0, 7)}\nMCP ws.* bindings are consistent (11 bindings).\n`);
  assert.equal(cli.stderr, '');
  await fs.writeFile(path.join(root, INDEX_PATH), 'stale\n');
  const written = runCli(root, '--pinned', '--write');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stderr, '');
  assert.equal(await fs.readFile(path.join(root, INDEX_PATH), 'utf8'), renderIndex(allBindings()));
});

test('--pinned exits 2 with the submodule hint when the pin is absent from the intentd object store', async (t) => {
  const { root } = await makeGitRoot(t);
  const missing = '1'.repeat(40);
  git(root, 'update-index', '--cacheinfo', `160000,${missing},${INTENTD_DIR}`);
  git(root, 'commit', '-q', '-m', 'pin not fetched');
  await assert.rejects(
    runChecks(root, { pinned: true }),
    (error) => error instanceof CheckError && error.exitCode === 2 && error.message.includes(`git submodule update --init ${INTENTD_DIR}`) && error.message.includes(missing),
  );
  const cli = runCli(root, '--pinned');
  assert.equal(cli.status, 2);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /is not present in packages\/intentd; run 'git submodule update --init packages\/intentd' \(or 'git -C packages\/intentd fetch origin 1{40}'\) and retry/);
  const checkout = await runChecks(root);
  assert.deepEqual(messages(checkout), []);
  assert.equal(checkout.ref.pin, missing, 'the default run still names the recorded pin');
  assert.ok(formatOffPinWarning(checkout.ref).includes(`checkout ${checkout.ref.checkout.slice(0, 7)} is off the recorded pin 1111111`));
});
