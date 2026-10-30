import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jsonBytes } from './lib/fixture-copy.mjs';
import {
  CATALOG_PATH, DOCS_PATH, checkTurnStartContract, conditionMatch, readDocsTable, validateCatalog, validateDocsTable,
} from './check-turn-start-contract.mjs';
import { COPY, REQUIRED_TYPES, SOURCE_PATH, main, resolvePath, validateFixture } from './turn-start-contract.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const canonical = () => JSON.parse(read(SOURCE_PATH));
const catalogTypes = () => JSON.parse(read(CATALOG_PATH)).types;
const docs = () => read(DOCS_PATH);
const byId = (doc, id) => doc.events.find((entry) => entry.id === id);
const rejects = (doc, pattern) => assert.throws(() => validateFixture(doc), pattern);

function tempRoot(t, { doc = canonical(), markdown = docs(), catalog = read(CATALOG_PATH) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of [[SOURCE_PATH, jsonBytes(doc)], [DOCS_PATH, markdown], [CATALOG_PATH, catalog]]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('the canonical fixture, catalog and §6.6 table agree and cover every required turn-start event', () => {
  assert.equal(main(['validate']), 'turn-start: canonical valid (4 events)');
  assert.match(checkTurnStartContract(), /turn-start contract: 4 events agree/);
  assert.deepEqual([...new Set(canonical().events.map((entry) => entry.type))].sort(), [...REQUIRED_TYPES].sort());
});

test('the copy contract imports only the shared fixture-copy tool, so component CI can sparse-check it out', () => {
  const imports = [...read('scripts/turn-start-contract.mjs').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((specifier) => specifier.startsWith('.')), ['./lib/fixture-copy.mjs']);
});

test('the copy is a single-file commit copy in cloudlands-fe', () => {
  assert.equal(COPY.provenance, 'commit');
  assert.deepEqual(COPY.components, ['cloudlands-fe']);
});

test('only the running status edge and the harness-wake stream start count', () => {
  const entry = byId(canonical(), 'running-status-edge');
  assert.deepEqual(entry.match, { 'data.status': 'active', 'data.isActive': true });
  assert.equal(entry.turn, 'any');
  assert.deepEqual(byId(canonical(), 'harness-wake-start').match, { 'data.reason': 'harness-wake' });
  assert.equal(resolvePath(entry.event, 'data.status'), 'active');
  assert.equal(resolvePath(entry.event, 'data.missing.deeper'), undefined);
});

test('a type missing from the event catalog fails', () => {
  const events = canonical().events;
  events[3].type = 'agent:queue:started';
  assert.throws(() => validateCatalog({ types: catalogTypes() }, events),
    /queue-drain-start: type agent:queue:started is not in docs\/protocol\/event-types.json/);
  assert.throws(() => validateCatalog({}, events), /types must be an array/);
});

test('a fixture type not in REQUIRED_TYPES fails until the list is updated too', () => {
  const doc = canonical();
  doc.events.push({ ...structuredClone(doc.events[2]), id: 'idle-ping', type: 'agent:idle' });
  doc.events.at(-1).event.type = 'agent:idle';
  rejects(doc, /fixture event types not in REQUIRED_TYPES \(scripts\/turn-start-contract.mjs\): agent:idle/);
});

test('removing a required turn-start event fails', () => {
  const doc = canonical();
  doc.events = doc.events.filter((entry) => entry.type !== 'agent:queue:processing');
  rejects(doc, /required turn-start events missing from the fixture: agent:queue:processing/);
});

test('an event whose type differs from its entry fails', () => {
  const doc = canonical();
  doc.events[1].event.type = 'agent:idle';
  rejects(doc, /event.type "agent:idle" must equal type agent:status-changed/);
});

test('a match path the example does not satisfy fails', () => {
  const doc = canonical();
  byId(doc, 'running-status-edge').event.data.status = 'idle';
  rejects(doc, /match data.status expects "active" but event has "idle"/);
  const empty = canonical();
  byId(empty, 'running-status-edge').match = {};
  rejects(empty, /match must name at least one path/);
  const nested = canonical();
  byId(nested, 'running-status-edge').match = { 'data.status': { value: 'active' } };
  rejects(nested, /match data.status must be a JSON scalar/);
});

test('an unknown turn kind fails', () => {
  const doc = canonical();
  doc.events[0].turn = 'wake';
  rejects(doc, /turn must be one of agent-initiated, prompt, any, got "wake"/);
});

test('ids must be kebab-case and unique', () => {
  const bad = canonical();
  bad.events[0].id = 'Harness_Wake';
  rejects(bad, /id must be kebab-case/);
  const dup = canonical();
  dup.events[1].id = dup.events[0].id;
  rejects(dup, /duplicate id harness-wake-start/);
});

test('entries and events have exact keys', () => {
  const extra = canonical();
  extra.events[0].note = 'x';
  rejects(extra, /has unknown key note/);
  const missing = canonical();
  delete missing.events[0].event.actor;
  rejects(missing, /event is missing actor/);
  const top = canonical();
  top.version = 2;
  rejects(top, /turn-start fixture has unknown key version/);
  const format = canonical();
  format.fixtureFormatVersion = 2;
  rejects(format, /fixtureFormatVersion must be 1/);
  rejects({ ...canonical(), events: [] }, /events must be a non-empty array/);
});

test('an example needs an agent, an ISO timestamp and, for a wake turn, its message id', () => {
  const agent = canonical();
  agent.events[2].event.data.agentId = '';
  rejects(agent, /event.data.agentId must be a non-empty string/);
  const time = canonical();
  time.events[2].event.timestamp = '30 Oct 2026';
  rejects(time, /event.timestamp must be an ISO-8601 UTC timestamp/);
  const wake = canonical();
  delete byId(wake, 'harness-wake-start').event.data.messageId;
  rejects(wake, /agent-initiated turn opens its assistant message, so event.data.messageId/);
});

test('the §6.6 table lists every fixture entry with its turn kind and condition', () => {
  const rows = readDocsTable(docs());
  assert.deepEqual(rows.map((row) => row.id), canonical().events.map((entry) => entry.id));
  assert.match(rows[1].condition, /^Only the running edge/);
  assert.deepEqual(rows[1].match, { 'data.status': 'active', 'data.isActive': true });
  assert.deepEqual(rows[2].match, {});
  assert.doesNotThrow(() => validateDocsTable(docs(), canonical().events));
});

test('a table condition that disagrees with the fixture match fails', () => {
  const dropped = docs().replace(', `data.isActive: true`', '');
  assert.notEqual(dropped, docs());
  assert.throws(() => validateDocsTable(dropped, canonical().events), /\(id, type, turn, match\)/);
  const doc = canonical();
  delete byId(doc, 'harness-wake-start').match;
  assert.throws(() => validateDocsTable(docs(), doc.events), /\(id, type, turn, match\)/);
  assert.deepEqual(conditionMatch('`data.a: 1`, `data.b.c: "x"`, plain `data.messageId`', 'cell'), { 'data.a': 1, 'data.b.c': 'x' });
  assert.throws(() => conditionMatch('`data.a: nope`', 'cell'), /must be `path: <JSON value>`/);
  assert.throws(() => conditionMatch('`data.a: 1` `data.a: 2`', 'cell'), /names data.a twice/);
});

test('a table row missing for a fixture entry fails', () => {
  const markdown = docs().split('\n').filter((line) => !line.startsWith('| `agent:queue:processing` |')).join('\n');
  assert.throws(() => validateDocsTable(markdown, canonical().events), /Turn-start signals table must list the fixture's entries/);
});

test('a table row whose turn kind disagrees with the fixture fails', () => {
  const markdown = docs().replace('| `prompt` | `queue-drain-start` |', '| `any` | `queue-drain-start` |');
  assert.notEqual(markdown, docs());
  assert.throws(() => validateDocsTable(markdown, canonical().events), /Turn-start signals table must list/);
});

test('a malformed table row fails', () => {
  const markdown = docs().replace('| `agent:queue:processing` |', '| agent:queue:processing |');
  assert.throws(() => readDocsTable(markdown), /a turn-start row needs/);
});

test('the table must exist exactly once inside §6.6', () => {
  const header = '| Turn-start event | Condition | Turn | Fixture id |';
  assert.throws(() => readDocsTable(docs().replace(header, '| Event | Condition | Turn | Fixture id |')),
    /must hold exactly one table headed/);
  const outside = docs().replace('### 6.6 Turn/event lifecycle & batching window', '### 6.6 Renamed');
  assert.throws(() => readDocsTable(outside), /heading "6.6 Turn\/event lifecycle & batching window" not found/);
});

test('checkTurnStartContract reads the fixture, catalog and docs under a monorepo-shaped root', (t) => {
  assert.match(checkTurnStartContract(tempRoot(t)), /4 events agree/);
  const doc = canonical();
  doc.events.push({ ...structuredClone(doc.events[2]), id: 'second-activity-ping' });
  assert.throws(() => checkTurnStartContract(tempRoot(t, { doc })), /Turn-start signals table must list/);
  const catalog = `${JSON.stringify({ version: 1, types: catalogTypes().filter((type) => type !== 'agent:stream:activity') }, null, 2)}\n`;
  assert.throws(() => checkTurnStartContract(tempRoot(t, { catalog })), /type agent:stream:activity is not in/);
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, SOURCE_PATH), JSON.stringify(canonical()));
  assert.throws(() => checkTurnStartContract(root), /must be formatted as JSON.stringify/);
});
