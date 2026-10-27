// Browser-routing (REV-2, §5.9) contract checks. A reference resolver recomputes
// every case's expectation from its inputs, every case must quote its rule's
// text in files-terminal-browser.md, and intentd's mirror (when present) must
// equal this fixture. intentd's routing unit tests run the same cases against
// the real code, so a rule change that skips the docs, the fixture or the
// daemon fails a test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixtureUrl = new URL('./routing.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const docs = await readFile(new URL('../../methods/files-terminal-browser.md', import.meta.url), 'utf8');
const MIRROR = new URL(
  '../../../../packages/intentd/crates/intent-transport/tests/fixtures/browser-routing.json',
  import.meta.url,
);

const normalise = text => text.replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim();

// The REV-2 block, from its heading to the next block heading, split into its
// numbered rules: rules[n] is the text of rule n (the last rule runs to the
// end of the block, so it covers the Chief sentence too).
function rev2Rules(markdown) {
  const start = markdown.indexOf('**Agent-initiated `browser.exec` — REV-2 target selection');
  const end = markdown.indexOf('**Registry-backed agent actions', start);
  assert.ok(start >= 0 && end > start, 'REV-2 block not found in files-terminal-browser.md');
  const block = normalise(markdown.slice(start, end));
  const marks = [...block.matchAll(/(?:^| )(\d+)\. \*\*/g)].map(m => ({ n: Number(m[1]), at: m.index }));
  const rules = {};
  marks.forEach((m, i) => {
    rules[m.n] = block.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : block.length);
  });
  return { block, rules };
}

// Reference implementation of the documented rules.
function workspaceTarget({ chief, pin, desktopSession, tabs }) {
  if (chief) return { kind: 'default' };
  if (pin) return { kind: 'pinned', clientId: pin };
  if (desktopSession) return { kind: 'client', clientId: desktopSession };
  const claimed = tabs.find(t => t.owner);
  return claimed ? { kind: 'client', clientId: claimed.host } : { kind: 'default' };
}

function resolveConnection({ connections, drops }, target) {
  const dropped = new Set(drops);
  const eligible = connections.filter(c => !dropped.has(c.id) && c.hello && c.browserExec);
  let clientId = target.clientId;
  if (target.kind === 'default') {
    if (eligible.length === 0) return { error: { kind: 'no-client' } };
    clientId = eligible[0].client;
  }
  const newest = eligible.filter(c => c.client === clientId).at(-1);
  if (!newest) return { error: { kind: 'client-offline', clientId, pinned: target.kind === 'pinned' } };
  return { connection: newest.id };
}

function expectFor(c) {
  const target = workspaceTarget(c.workspace);
  return { target, ...resolveConnection(c, target) };
}

const { block, rules } = rev2Rules(docs);

test('fixture shape', () => {
  assert.equal(fixture.schema, 'browser-routing/v1');
  const ids = fixture.cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids are unique');
  for (const c of fixture.cases) {
    const ws = c.workspace;
    assert.deepEqual(Object.keys(ws).sort(), ['chief', 'desktopSession', 'pin', 'tabs'], c.id);
    if (ws.chief) assert.equal(ws.pin, null, `${c.id}: the Chief workspace cannot be pinned`);
    for (const t of ws.tabs) assert.deepEqual(Object.keys(t).sort(), ['host', 'owner', 'tabId'], c.id);
    const conns = c.connections.map(x => x.id);
    assert.equal(new Set(conns).size, conns.length, `${c.id}: connection ids are unique`);
    for (const x of c.connections) {
      assert.deepEqual(Object.keys(x).sort(), ['browserExec', 'client', 'hello', 'id'], `${c.id}/${x.id}`);
      if (!x.hello) assert.ok(x.client === null && x.browserExec === false, `${c.id}/${x.id}: un-hello'd`);
      else assert.equal(typeof x.client, 'string', `${c.id}/${x.id}`);
    }
    for (const d of c.drops) assert.ok(conns.includes(d), `${c.id}: drop ${d} is a connection`);
    if (c.helloOrder) {
      const hellod = c.connections.filter(x => x.hello).map(x => x.id);
      assert.deepEqual([...c.helloOrder].sort(), hellod.sort(), `${c.id}: helloOrder lists every hello'd connection`);
    }
    assert.ok(['default', 'client', 'pinned'].includes(c.expect.target.kind), c.id);
    assert.ok(('connection' in c.expect) !== ('error' in c.expect), `${c.id}: exactly one of connection / error`);
    if (c.expect.error) assert.ok(['no-client', 'client-offline'].includes(c.expect.error.kind), c.id);
  }
});

for (const c of fixture.cases) {
  test(`reference resolver: ${c.id}`, () => {
    assert.deepEqual(c.expect, expectFor(c));
  });
}

test('every case quotes its rule in REV-2', () => {
  for (const c of fixture.cases) {
    assert.ok(rules[c.rule], `${c.id}: REV-2 has no rule ${c.rule}`);
    assert.ok(rules[c.rule].includes(normalise(c.docText)), `${c.id}: rule ${c.rule} does not say: ${c.docText}`);
  }
});

test('every REV-2 rule has a case, and the edge cases stay covered', () => {
  for (const n of Object.keys(rules)) {
    assert.ok(fixture.cases.some(c => c.rule === Number(n)), `REV-2 rule ${n} has no fixture case`);
  }
  const has = (what, pred) => assert.ok(fixture.cases.some(pred), `no ${what} case`);
  has('unpinned', c => !c.workspace.pin && !c.workspace.chief);
  has('pinned', c => c.workspace.pin);
  has('claimed-tab', c => c.workspace.tabs.some(t => t.owner) && !c.workspace.pin && !c.workspace.desktopSession);
  has('user-tab', c => c.workspace.tabs.some(t => !t.owner));
  has('Chief', c => c.workspace.chief);
  has('desktop-session', c => c.workspace.desktopSession && !c.workspace.chief);
  has('dropped-connection', c => c.drops.length > 0);
  has('hello-order', c => c.helloOrder);
  has('stale-connection', c => {
    const chosen = c.connections.find(x => x.id === c.expect.connection);
    return chosen && c.connections.findIndex(x => x.client === chosen.client) < c.connections.indexOf(chosen);
  });
  for (const kind of ['no-client', 'client-offline']) has(kind, c => c.expect.error?.kind === kind);
  has('pinned offline', c => c.expect.error?.pinned === true);
});

test('REV-2 links the fixture', () => {
  assert.ok(block.includes('fixtures/browser-routing/routing.json'));
});

test("intentd's mirror equals this fixture", async t => {
  let mirror;
  try {
    mirror = await readFile(MIRROR, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // Docs lead the pin: until intentd adopts the fixture there is no copy.
    console.warn(`::warning::no intentd mirror at ${MIRROR.pathname}; nothing to compare yet`);
    t.skip('intentd has not adopted the fixture yet');
    return;
  }
  assert.deepEqual(JSON.parse(mirror), fixture,
    'packages/intentd/crates/intent-transport/tests/fixtures/browser-routing.json drifted from '
    + 'docs/protocol/fixtures/browser-routing/routing.json; copy one onto the other');
});
