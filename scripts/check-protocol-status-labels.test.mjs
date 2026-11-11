import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  BASELINE_HEADER, BASELINE_PATH, CAPABILITIES_FILE, INTENTD_DIR,
  baselineEntries, compare, findLabels, parseAdvertised, parseBaseline, run,
} from './check-protocol-status-labels.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-protocol-status-labels.mjs');

// Synthetic sources in the shapes the pinned intentd and the protocol docs use
// today; the tests never read the real component or docs, so an unrelated
// docs edit cannot break them. `make check-protocol-status-labels` reads both.
const clientRs = (pairs, extra = '') => `/// Build the \`server\` capability block.
pub(crate) fn server_json(
    has_display: bool,
    is_local: bool,
) -> Value {
    // "commentedOut": 1 is not advertised.
    let capabilities = json!({ ${pairs} });${extra}
    let mut server = json!({
        "locality": if is_local { "local" } else { "remote" },
        "capabilities": capabilities,
    });
    server
}

#[cfg(feature = "repository-test-fixtures")]
fn apply_monitor_test_support(server: &mut Value) {
    server["capabilities"]["reviewMonitoring"] = json!(1);
}
`;

const SHIPPED = ['secretRequests', 'desktopControl', 'liveState'];

const secretsMd = (heading = '## 5.56 Secret requests') => `> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.56 Secret requests.

${heading}

This is an additive contract.

### Status and discovery

The daemon advertises \`server.capabilities.secretRequests: 1\` (§5.17) only when
it implements the contract below.
`;

const desktopMd = `> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.51 Desktop control.

## Status and discovery

The daemon advertises \`server.capabilities.desktopControl: 1\`. Electron sends
\`desktopControl: 1\` alongside \`browserExec: true\`.

## Events and agent wakes

Events are delivered to the bound agent.
`;

const helloMd = `> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.17 \`client.hello\`.

## 5.17 client.hello

Flags: \`server.capabilities.secretRequests: 1\`, \`server.capabilities.desktopControl: 1\`,
\`server.capabilities.futureThing: 1\`, \`server.capabilities.otherThing: 1\`.
`;

const docsWith = (extra = {}) => ({
  'docs/protocol/methods/secrets.md': secretsMd(),
  'docs/protocol/methods/desktop.md': desktopMd,
  'docs/protocol/methods/client-hello.md': helloMd,
  ...extra,
});

const labels = (docs, fixtures = {}, advertised = SHIPPED) => findLabels({ docs, fixtures }, advertised).map((f) => `${f.file}:${f.line} ${f.capability} ${f.label}`);

test('parseAdvertised reads the server_json() literal and keeps only truthy flags', () => {
  const names = parseAdvertised(clientRs('"desktopControl": 1, "liveState": true, "scriptMonitors": 2, "offFlag": false, "zeroFlag": 0'));
  assert.deepEqual(names, ['desktopControl', 'liveState', 'scriptMonitors']);
});

test('parseAdvertised fails closed on shapes it cannot read', () => {
  assert.throws(() => parseAdvertised(clientRs('"desktopControl": 1, "computed": value')), /something other than `"name": <literal>` pairs/);
  assert.throws(() => parseAdvertised(clientRs('"desktopControl": 1, "desktopControl": 1')), /appears twice/);
  assert.throws(() => parseAdvertised(clientRs('"desktopControl": 1', '\n    let capabilities = json!({ "x": 1 });')), /expected one/);
  assert.throws(() => parseAdvertised(clientRs('')), /advertises no capability/);
  assert.throws(() => parseAdvertised(clientRs('"bad-name": 1')), /not a plain identifier/);
  assert.throws(() => parseAdvertised('fn other() {}'), /`pub\(crate\) fn server_json\(` not found/);
});

test('the current docs shapes pass and a restored (prepared) §5.56 heading fails', () => {
  assert.deepEqual(labels(docsWith()), []);
  const docs = docsWith({ 'docs/protocol/methods/secrets.md': secretsMd('## 5.56 Secret requests *(prepared)*') });
  assert.deepEqual(labels(docs), ['docs/protocol/methods/secrets.md:3 secretRequests prepared']);
});

test('a label whose subject is not advertised is not a finding', () => {
  const docs = docsWith({ 'docs/protocol/x.md': '**Prepared additive contract.** `server.capabilities.futureThing: 1` gates it.\n' });
  assert.deepEqual(labels(docs), []);
  assert.deepEqual(labels(docs, {}, [...SHIPPED, 'futureThing']), ['docs/protocol/x.md:1 futureThing Prepared']);
});

test('a bare capability code span counts only for a known capability', () => {
  const docs = docsWith({ 'docs/protocol/x.md': 'The prepared `lossRecovery` option needs `secretRequests: 1`.\n' });
  assert.deepEqual(labels(docs), ['docs/protocol/x.md:1 secretRequests prepared']);
});

test('prose labels: same sentence, an emphasized lead-in, and "not implemented"', () => {
  const docs = docsWith({
    'docs/protocol/a.md': [
      'This is prepared and not shipped: `secretRequests: 1` gates it.',
      '',
      '**Prepared additive contract.** `server.capabilities.desktopControl: 1` announces it.',
      '',
      '- *(prepared)* Clients detect `liveState` first.',
      '',
      'The streaming mode is not yet implemented. `liveState` is unrelated.',
      '',
      'The prepared default change is separate. `desktopControl: 1` does not gate it.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), [
    'docs/protocol/a.md:1 secretRequests prepared',
    'docs/protocol/a.md:3 desktopControl Prepared',
    'docs/protocol/a.md:5 liveState prepared',
  ]);
  const notImplemented = docsWith({ 'docs/protocol/b.md': 'The `liveState` push surface is not implemented by the current pins.\n' });
  assert.deepEqual(labels(notImplemented), ['docs/protocol/b.md:1 liveState not implemented']);
});

test('labels inside code, link destinations and fenced code are ignored', () => {
  const docs = docsWith({
    'docs/protocol/a.md': [
      'See [secret requests](./methods/secrets.md#secret-requests-prepared) for `secretRequests: 1`.',
      '',
      'The `prepared` flag of `secretRequests: 1` is a field name.',
      '',
      '```json',
      '{ "status": "prepared", "secretRequests": 1 }',
      '```',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), []);
});

test('a table row label takes the first subject from its cell onward', () => {
  const docs = docsWith({
    'docs/protocol/events.md': [
      '| Category | Events | Notes |',
      '| --- | --- | --- |',
      '| desktop (prepared) | desktop:changed | Requires `desktopControl: 1`. |',
      '| future (prepared) | future:changed | Requires `server.capabilities.futureThing: 1`; see `liveState`. |',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), ['docs/protocol/events.md:3 desktopControl prepared']);
});

test('section references resolve to the referenced section\'s capability', () => {
  const docs = docsWith({
    'docs/protocol/05-method-catalog.md': [
      '| secret | 4 | dismiss, forget, list, provide — prepared secret requests (§5.56) |',
      '| --- | --- | --- |',
      '',
      '- `desktop.control` — reverse RPC (§5.51; prepared, daemon→client only)',
      '',
      'The prepared [desktop control contract](./methods/desktop.md) adds four methods.',
      '',
      '#### Prepared desktop control events (not implemented)',
      '',
      '[§5.51](./methods/desktop.md#events-and-agent-wakes) reserves the events.',
      '',
      'A prepared hello rule (§5.17) is ambiguous: that section names several flags.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), [
    'docs/protocol/05-method-catalog.md:4 desktopControl prepared',
    'docs/protocol/05-method-catalog.md:6 desktopControl prepared',
    'docs/protocol/05-method-catalog.md:8 desktopControl Prepared',
  ]);
  // The first line is a table header row, which is not read as a block.
  const row = docsWith({
    'docs/protocol/catalog.md': '| Area | Methods |\n| --- | --- |\n| secret | provide — prepared secret requests (§5.56) |\n',
  });
  assert.deepEqual(labels(row), ['docs/protocol/catalog.md:3 secretRequests prepared']);
});

test('README index rows resolve through their § number and link', () => {
  const docs = docsWith({
    'docs/protocol/README.md': [
      '| Section | File |',
      '| --- | --- |',
      '| §5.51 Desktop control (prepared) | [methods/desktop.md](./methods/desktop.md) |',
      '| §5.56 Secret requests | [methods/secrets.md](./methods/secrets.md) |',
      '| Other notes (prepared) | [methods/client-hello.md](./methods/client-hello.md) |',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), ['docs/protocol/README.md:3 desktopControl prepared']);
});

test('a fixture whose status starts with "prepared" is a finding for its first known capability', () => {
  const docs = docsWith();
  const fixtures = {
    'docs/protocol/fixtures/desktop-control/lifecycle.json': '{\n  "status": "prepared-not-executed",\n  "capability": { "desktopControl": 1 }\n}\n',
    'docs/protocol/fixtures/secrets/cases.json': '{\n  "status": "shipped-static-examples",\n  "capability": { "secretRequests": 1 }\n}\n',
    'docs/protocol/fixtures/future/cases.json': '{\n  "status": "prepared-not-executed",\n  "capability": { "futureThing": 1 }\n}\n',
    'docs/protocol/fixtures/list.json': '[1, 2]\n',
  };
  assert.deepEqual(labels(docs, fixtures), ['docs/protocol/fixtures/desktop-control/lifecycle.json:2 desktopControl prepared-not-executed']);
  assert.throws(() => findLabels({ docs, fixtures: { 'docs/protocol/fixtures/bad.json': '{' } }, SHIPPED), /not valid JSON/);
});

const finding = (file, capability, line = 1, block = 'The prepared thing.') => ({ file, line, capability, label: 'prepared', block });

test('compare: the baseline grandfathers counts and only ratchets down', () => {
  const findings = [finding('docs/protocol/a.md', 'liveState', 1), finding('docs/protocol/a.md', 'liveState', 5)];
  const entries = [{ file: 'docs/protocol/a.md', capability: 'liveState', count: 2, line: 7 }];
  assert.deepEqual(compare(findings, { entries, unfinished: [] }), { errors: [], warnings: [], allowed: 0, grandfathered: 2 });

  const over = compare([...findings, finding('docs/protocol/a.md', 'liveState', 9)], { entries, unfinished: [] });
  assert.equal(over.errors.length, 4);
  assert.match(over.errors[0], /3 "prepared"\/"not implemented" label\(s\) describe liveState.*the baseline allows 2/);
  assert.match(over.errors[3], /^docs\/protocol\/a\.md:9: error: "prepared" labels liveState as unshipped/);

  const fixed = compare(findings.slice(0, 1), { entries, unfinished: [] });
  assert.deepEqual(fixed.errors, [`${BASELINE_PATH}:7: error: docs/protocol/a.md liveState has 1 stale label(s) left but the baseline allows 2; the ratchet only moves down: replace its line with \`docs/protocol/a.md liveState 1\``]);
  const offPin = compare(findings.slice(0, 1), { entries, unfinished: [], strict: false });
  assert.deepEqual(offPin.errors, []);
  assert.match(offPin.warnings[0], /replace its line .* \(intentd is off its pin, so this is a warning here\)$/);

  const gone = compare([], { entries, unfinished: [] });
  assert.deepEqual(gone.errors, [`${BASELINE_PATH}:7: error: docs/protocol/a.md liveState has no stale labels left but the baseline allows 2; remove its line \`docs/protocol/a.md liveState 2\``]);
  assert.equal(compare([], { entries, unfinished: [], strict: false }).warnings.length, 1);

  const fresh = compare([finding('docs/protocol/b.md', 'secretRequests', 3)], { entries: [], unfinished: [] });
  assert.match(fresh.errors[0], /the baseline has no entry for it/);
  assert.match(fresh.errors[1], /add an UNFINISHED entry with a reason/);
});

test('compare: UNFINISHED entries let a matching label through and warn when stale', () => {
  const unfinished = [
    { capability: 'desktopControl', file: 'docs/protocol/methods/desktop.md', text: 'Linux support is prepared', reason: 'the native helper ships for macOS and Windows only' },
    { capability: 'secretRequests', file: 'docs/protocol/methods/secrets.md', text: 'never matches', reason: 'stale on purpose' },
  ];
  const findings = [
    finding('docs/protocol/methods/desktop.md', 'desktopControl', 4, 'Linux support is prepared; `desktopControl: 1` is not advertised there.'),
    finding('docs/protocol/methods/desktop.md', 'desktopControl', 9, 'Windows support is prepared.'),
  ];
  const result = compare(findings, { entries: [], unfinished });
  assert.equal(result.allowed, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[1], /desktop\.md:9: error/);
  assert.deepEqual(result.warnings, ['UNFINISHED entry for secretRequests in docs/protocol/methods/secrets.md ("never matches") matches no label; remove it from scripts/check-protocol-status-labels.mjs']);
  const missingReason = compare([], { unfinished: [{ capability: 'x', file: 'y', text: 'z', reason: ' ' }] });
  assert.match(missingReason.errors[0], /UNFINISHED entry 1 .* needs a non-empty reason/);
});

test('parseBaseline validates shape, order and counts', () => {
  const ok = parseBaseline(`${BASELINE_HEADER}\ndocs/protocol/a.md liveState 2\ndocs/protocol/b.md desktopControl 1\n`);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.entries.map((e) => [e.file, e.capability, e.count]), [['docs/protocol/a.md', 'liveState', 2], ['docs/protocol/b.md', 'desktopControl', 1]]);
  assert.match(parseBaseline('docs/protocol/a.md liveState\n').errors[0], /expected `<path> <capability> <count>`/);
  assert.match(parseBaseline('docs/protocol/a.md liveState 0\n').errors[0], /has no entry; remove/);
  assert.match(parseBaseline('docs/protocol/b.md x 1\ndocs/protocol/a.md x 1\n').errors[0], /sorted and unique/);
  assert.deepEqual(baselineEntries([finding('b.md', 'x'), finding('a.md', 'y'), finding('b.md', 'x')]), ['a.md y 1', 'b.md x 2']);
});

function fixture({ secretsHeading, baseline = '', advertised = '"secretRequests": 1, "desktopControl": 1' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'status-labels-'));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  write(path.join(INTENTD_DIR, CAPABILITIES_FILE), clientRs(advertised));
  write('docs/protocol/methods/secrets.md', secretsMd(secretsHeading));
  write('docs/protocol/methods/desktop.md', desktopMd);
  write('docs/protocol/fixtures/desktop-control/lifecycle.json', '{ "status": "shipped-static-examples", "desktopControl": 1 }\n');
  write(BASELINE_PATH, `${BASELINE_HEADER}\n${baseline}`);
  return dir;
}

const quiet = { log: () => {}, warn: () => {} };

test('run: reads the checkout, compares with the baseline file and fails on a new label', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ok = run(dir, quiet);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.advertised, ['secretRequests', 'desktopControl']);

  const stale = fixture({ secretsHeading: '## 5.56 Secret requests *(prepared)*' });
  t.after(() => rmSync(stale, { recursive: true, force: true }));
  assert.match(run(stale, quiet).errors.join('\n'), /secrets\.md:3: error: "prepared" labels secretRequests as unshipped/);

  const grandfathered = fixture({ secretsHeading: '## 5.56 Secret requests *(prepared)*', baseline: 'docs/protocol/methods/secrets.md secretRequests 1\n' });
  t.after(() => rmSync(grandfathered, { recursive: true, force: true }));
  assert.deepEqual(run(grandfathered, quiet).errors, []);

  const notShipped = fixture({ secretsHeading: '## 5.56 Secret requests *(prepared)*', advertised: '"desktopControl": 1' });
  t.after(() => rmSync(notShipped, { recursive: true, force: true }));
  assert.deepEqual(run(notShipped, quiet).errors, []);
});

test('run: fails closed on a missing intentd checkout, a missing baseline and a symlinked doc', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => run(dir, { ...quiet, intentdDir: 'packages/missing' }), /not found; initialize the submodule/);
  rmSync(path.join(dir, BASELINE_PATH));
  assert.deepEqual(run(dir, quiet).errors, [`${BASELINE_PATH}: error: baseline file is missing`]);
  writeFileSync(path.join(dir, BASELINE_PATH), BASELINE_HEADER);
  symlinkSync(path.join(dir, 'docs/protocol/methods/desktop.md'), path.join(dir, 'docs/protocol/link.md'));
  assert.throws(() => run(dir, quiet), /symlinks under docs\/protocol are not scanned/);
});

test('CLI: exit codes and --print-baseline', (t) => {
  const dir = fixture({ secretsHeading: '## 5.56 Secret requests *(prepared)*' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, DD_TRACE_ENABLED: 'false' };
  const failed = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8', env });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /secrets\.md:3: error/);

  const printed = spawnSync(process.execPath, [script, '--root', dir, '--print-baseline'], { encoding: 'utf8', env });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${BASELINE_HEADER}\ndocs/protocol/methods/secrets.md secretRequests 1\n`);
  writeFileSync(path.join(dir, BASELINE_PATH), printed.stdout);

  const passed = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8', env });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /no new "prepared"\/"not implemented" labels on the 2 capabilities intentd advertises \(0 allowlisted as unfinished, 1 grandfathered/);
});

test('each sentence counts, so a second stale sentence in one paragraph raises the count', () => {
  const one = docsWith({ 'docs/protocol/a.md': 'The `secretRequests` contract is prepared.\n' });
  const two = docsWith({ 'docs/protocol/a.md': 'The `secretRequests` contract is prepared. The `secretRequests` handlers are not implemented.\n' });
  assert.deepEqual(labels(one), ['docs/protocol/a.md:1 secretRequests prepared']);
  assert.deepEqual(labels(two), ['docs/protocol/a.md:1 secretRequests prepared', 'docs/protocol/a.md:1 secretRequests not implemented']);
  const entries = [{ file: 'docs/protocol/a.md', capability: 'secretRequests', count: 1, line: 1 }];
  assert.notDeepEqual(compare(findLabels({ docs: two }, SHIPPED), { entries, unfinished: [] }).errors, []);
  // Two labels in one sentence are one statement.
  const same = docsWith({ 'docs/protocol/b.md': 'The prepared `secretRequests` contract is not implemented yet.\n' });
  assert.deepEqual(labels(same), ['docs/protocol/b.md:1 secretRequests prepared']);
});

test('the next-sentence fallback applies only to a label inside the opening emphasized lead-in', () => {
  const docs = docsWith({
    'docs/protocol/a.md': [
      '**Note:** The streaming mode is not implemented. `secretRequests` is unrelated.',
      '',
      '*(prepared, additive)* The daemon records links. Support is gated by `desktopControl: 1`.',
      '',
      '**Workspace roles (prepared).** Exact `liveState` gates the contract.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), [
    'docs/protocol/a.md:3 desktopControl prepared',
    'docs/protocol/a.md:5 liveState prepared',
  ]);
});

// Patterns that slipped through while the baseline was drained (#8245, #8246):
// each was found by a reviewer, not by this check.
const DISCUSSION = ['discussionConversations', 'discussionManagement', 'discussionReactions'];

const multiplayerMd = `> Part of the [Intent JSON-RPC protocol docs](../README.md) — §5.55 Workspace discussions.

### 5.55 Workspace discussions

Gated by \`server.capabilities.discussionConversations: 1\`, \`discussionManagement: 1\`
and \`discussionReactions: 1\`; managers also need \`discussionManagement: 1\`.

#### Message history

Pages are bounded.

### 5.59 Mixed flags

Gated by \`server.capabilities.discussionReactions: 1\` and \`server.capabilities.futureThing: 1\`.
`;

test('a label pointing at a section that names several flags, all advertised, is a finding', () => {
  const advertised = [...SHIPPED, ...DISCUSSION];
  const docs = docsWith({
    'docs/protocol/methods/multiplayer.md': multiplayerMd,
    'docs/protocol/README.md': [
      '| Section | File |',
      '| --- | --- |',
      '| §5.55 Workspace discussions (prepared) | [methods/multiplayer.md](./methods/multiplayer.md#555-workspace-discussions) |',
      '| §5.59 Mixed flags (prepared) | [methods/multiplayer.md](./methods/multiplayer.md#559-mixed-flags) |',
      '',
    ].join('\n'),
  });
  // The most mentioned flag is charged; §5.59 also names an unadvertised flag, so it has no subject.
  assert.deepEqual(labels(docs, {}, advertised), ['docs/protocol/README.md:3 discussionManagement prepared']);
  assert.deepEqual(labels(docs), [], 'with one discussion flag unadvertised, §5.55 has no subject');

  // A broad section reached only by climbing from a subsection that names
  // nothing, or met while scanning a heading's section, does not count.
  const loose = docsWith({
    'docs/protocol/methods/multiplayer.md': multiplayerMd,
    'docs/protocol/a.md': [
      'The prepared [history paging](./methods/multiplayer.md#message-history) is separate.',
      '',
      '### Provider profiles (prepared)',
      '',
      'Profiles run beside discussions (§5.55).',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(loose, {}, advertised), []);
});

test('a label in a version lead-in with no capability of its own takes the paragraph that follows', () => {
  const docs = docsWith({
    'docs/protocol/methods/checkout.md': '### 5.60 Checkout\n\n#### Owner avatars\n\nOptional images.\n',
    'docs/protocol/versioning.md': [
      '**Version 13.7 — checkout owner avatars (additive, prepared).**',
      'The [owner-avatar extension](./methods/checkout.md#owner-avatars) adds an optional field.',
      'Exactly integer `liveState: 1` permits the opt-in.',
      '',
      '**Version 14.0 — active-only script lists (breaking, prepared).**',
      '',
      'Exact gates are `desktopControl: 1` and `secretRequests: 1`; `desktopControl` first.',
      '',
      '**Version 14.1 — reserved (additive, prepared).**',
      '',
      '**Version 14.2 — other (additive).** `secretRequests: 1` is not about 14.1.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs), [
    'docs/protocol/versioning.md:1 liveState prepared',
    'docs/protocol/versioning.md:5 desktopControl prepared',
  ]);
});

test('a protocol version next to a label stands for that version\'s entries', () => {
  const advertised = [...SHIPPED, ...DISCUSSION];
  const versioning = (intro) => [
    '## Protocol Version & Compatibility',
    '',
    intro,
    '',
    '**Version 15.1 — workspace discussions (additive).**',
    '`discussionConversations: 1` and `discussionManagement: 1` gate it; managers need `discussionManagement: 1`.',
    '',
    '**Version 15.1 — scoped repository pages (additive).** `discussionReactions: 1` also applies.',
    '',
    '**Version 15.0 — retirements (breaking).** `server.capabilities.futureThing: 1` stays reserved.',
    '',
  ].join('\n');
  const intro = '**Documented version:** `15.3` — on top of 15.1\'s prepared discussions and scoped pages; not a shipped-version claim.';
  assert.deepEqual(labels(docsWith({ 'docs/protocol/versioning.md': versioning(intro) }), {}, advertised), ['docs/protocol/versioning.md:3 discussionManagement prepared']);
  // Other phrasings of the same version, in another doc.
  const elsewhere = docsWith({
    'docs/protocol/versioning.md': versioning('Intro.'),
    'docs/protocol/a.md': [
      '#### Discussion typing *(15.1, prepared)*',
      '',
      'Typing renews a lease.',
      '',
      'The prepared [protocol 15.1 extension](./versioning.md) adds pages.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(elsewhere, {}, advertised), ['docs/protocol/a.md:1 discussionManagement prepared', 'docs/protocol/a.md:5 discussionManagement prepared']);
  // A version whose entries name an unadvertised flag, or one far from the label, is no subject.
  const quiet = docsWith({
    'docs/protocol/versioning.md': versioning('Intro.'),
    'docs/protocol/a.md': [
      'The 15.0 retirements stay prepared.',
      '',
      'Counts were recorded at protocol 15.1; the remaining fifteen documented methods are separately prepared.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(quiet, {}, advertised), []);
});

test('"This is a prepared ... extension" after a capability sentence resolves through its link', () => {
  const advertised = [...SHIPPED, ...DISCUSSION];
  const docs = docsWith({
    'docs/protocol/methods/multiplayer.md': multiplayerMd,
    'docs/protocol/methods/client-hello.md': [
      'Exactly integer `server.capabilities.liveState: 1` adds request-correlated activity.',
      'This is a prepared Multiplayer Labs extension; see [the activity contract](./multiplayer.md#555-workspace-discussions).',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs, {}, advertised), ['docs/protocol/methods/client-hello.md:2 discussionManagement prepared']);
});

test('a quoted "see ..." heading is a reference, ahead of a broad § number later in the row', () => {
  const advertised = [...SHIPPED, 'noteTruncatedRead'];
  const docs = docsWith({
    'docs/protocol/09-error-codes.md': '> Part of the [Intent JSON-RPC protocol docs](./README.md) — §9 Error Codes.\n\n## 9. Error Codes\n\nShared-host refusals need `server.capabilities.liveState: 1`.\n',
    'docs/protocol/methods/notes-tasks.md': [
      '| Method | Params | Result |',
      '| --- | --- | --- |',
      '| note.update | noteId (req), baseContentBytes?: int *(prepared)* | { note } — a mismatch → `-32602` (see "Truncated note reads" below). A stale `expectedVersion` → `-32005` (§9) |',
      '',
      '### Truncated note reads',
      '',
      '`server.capabilities.noteTruncatedRead` equal to `1` gates it.',
      '',
    ].join('\n'),
  });
  assert.deepEqual(labels(docs, {}, advertised), ['docs/protocol/methods/notes-tasks.md:3 noteTruncatedRead prepared']);
});

test('a quoted heading prefers an exact match and needs a unique prefix', () => {
  const doc = (headings) => docsWith({
    'docs/protocol/a.md': ['The prepared extension (see "Truncated note reads" below).', '', ...headings.flatMap(([h, cap]) => [h, '', `\`server.capabilities.${cap}: 1\``, ''])].join('\n'),
  });
  // An exact heading wins over an earlier one it only prefixes, either way round.
  assert.deepEqual(labels(doc([['### Truncated note reads legacy', 'liveState'], ['### Truncated note reads', 'futureThing']])), []);
  assert.deepEqual(labels(doc([['### Truncated note reads legacy', 'futureThing'], ['### Truncated note reads', 'liveState']])), ['docs/protocol/a.md:1 liveState prepared']);
  // A trailing status parenthetical does not stop an exact match; an ambiguous prefix resolves to nothing.
  assert.deepEqual(labels(doc([['### Truncated note reads (prepared additive contract)', 'liveState']])), ['docs/protocol/a.md:1 liveState prepared', 'docs/protocol/a.md:3 liveState prepared']);
  assert.deepEqual(labels(doc([['### Truncated note reads v1', 'liveState'], ['### Truncated note reads v2', 'liveState']])), []);
});
