import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { callsIn, defaultDbPath, knownNamesFromToolsRs, maskJs, openReadOnly, rank } from './mine-ws-usage.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mine-ws-usage.mjs');

const TOOLS_RS = `
const WORKSPACE_API_DESCRIPTION: &str = r#"Intro ws.ghost.method() is prose, not API.

API:
  ws.help(namespace?) → string  // docs
  ws.note.read(id) → { id }  // read
  ws.note.add(id, { content }) → { ok }  // add
  ws.pr.snapshot(prNumber) → { state }  // pr
"#;
const WORKSPACE_API_DESCRIPTION_CHIEF: &str = r#"API:
  ws.agent.send(agentId, message) → { ok }  // send
"#;
`;

function buildFixtureDb(file) {
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE agent_message (id TEXT PRIMARY KEY, agent_id TEXT, seq INTEGER, role TEXT, content TEXT);
      CREATE TABLE agent_message_payload (message_id TEXT, agent_id TEXT, block_ordinal INTEGER, kind TEXT, encoding TEXT, body BLOB);
    `);
    const msg = db.prepare("INSERT INTO agent_message VALUES (?, 'a', ?, ?, ?)");
    const use = (name, code, extra = {}) => ({ type: 'tool_use', id: 'x', name, input: { code, ...extra } });
    msg.run('m1', 1, 'assistant', JSON.stringify([
      { type: 'text', text: 'I will call ws.note.add("spec") now' },
      use('workspace_api', 'await ws.note.add("spec", { content: "ws.note.read(1) and ws.agent.send(2)" });'),
      use('bash', 'echo "ws.note.add(x)"; ws.note.add(1)'),
    ]));
    msg.run('m2', 2, 'assistant', JSON.stringify([
      use('mcp__workspace-mcp__workspace_api', [
        '// ws.agent.send(old) in a comment',
        '/* ws.note.add(block) */',
        'const t = `ws.note.read(text) ${await ws.note.read(`n-${ws.help()}`)}`;',
        'await ws.mr.snapshot(7); await ws.made.up(); await ws.note.read.call(null, 1);',
      ].join('\n')),
    ]));
    msg.run('m3', 3, 'assistant', JSON.stringify([
      { type: 'thinking', text: '' },
      use('workspace_api', 'await ws.note.ad', { inputTruncated: true }),
    ]));
    msg.run('m4', 4, 'user', JSON.stringify([use('workspace_api', 'ws.note.add(1)')]));
    db.prepare("INSERT INTO agent_message_payload VALUES ('m3', 'a', 1, 'tool_use_input', 'zlib', ?)")
      .run(zlib.deflateSync(Buffer.from(JSON.stringify({ code: 'await ws.note.add(1); await ws.note.add(2);' }))));
    db.close();
  });
}

test('maskJs blanks literal text and comments but keeps template expressions', () => {
  const code = 'a("x.y(") /* c(*/ `t ${b("s")} u` // d(';
  const masked = maskJs(code);
  assert.equal(masked.length, code.length);
  assert.equal(masked, 'a("    ")         `  ${b(" ")}  `      ');
});

test('callsIn ignores strings, folds ws.mr and drops function props', () => {
  assert.deepEqual(callsIn('ws.note.add("ws.note.read()"); ws . pr . monitor(1)'), ['ws.note.add', 'ws.pr.monitor']);
  assert.deepEqual(callsIn('ws.mr.snapshot(1); ws.note.read.toString(); myws.note.add(1); x.ws.note.add(1)'), [
    'ws.pr.snapshot',
    'ws.note.read',
  ]);
  assert.deepEqual(callsIn("ws.help('x') // ws.note.add()"), ['ws.help']);
  assert.deepEqual(callsIn('ws.note.add?.(1)'), ['ws.note.add']);
});

test('callsIn skips regex literals that contain quotes but keeps division', () => {
  assert.deepEqual(callsIn("x.replace(/`/g, ''); ws.note.add(1); ws.note.read(2)"), ['ws.note.add', 'ws.note.read']);
  assert.deepEqual(callsIn("const r = /'[\\/']/; ws.note.add(1)"), ['ws.note.add']);
  assert.deepEqual(callsIn("return /\"/.test(s) && ws.note.add(1)"), ['ws.note.add']);
  assert.deepEqual(callsIn('const a = b / 2; ws.note.add(1) / c; ws.note.read(1)'), ['ws.note.add', 'ws.note.read']);
  assert.deepEqual(callsIn('const a = (b) / 2 / ws.note.add(1)'), ['ws.note.add']);
});

test('knownNamesFromToolsRs reads only the API sections of both constants', () => {
  assert.deepEqual([...knownNamesFromToolsRs(TOOLS_RS)].sort(), [
    'ws.agent.send', 'ws.help', 'ws.note.add', 'ws.note.read', 'ws.pr.snapshot',
  ]);
  assert.throws(() => knownNamesFromToolsRs('fn main() {}'), /no ws\.\* help constants/);
});

test('rank orders by calls and reports cumulative coverage over known names', () => {
  const known = new Set(['ws.a.x', 'ws.a.y', 'ws.a.z']);
  const r = rank(['ws.a.x(); ws.a.x(); ws.a.x()', 'ws.a.y(); ws.bad.name()'], known, { top: 1 });
  assert.equal(r.scripts, 2);
  assert.equal(r.calls, 5);
  assert.equal(r.knownCalls, 4);
  assert.deepEqual(r.ranked.map((x) => [x.name, x.calls, x.cumulative]), [['ws.a.x', 3, 0.75], ['ws.a.y', 1, 1]]);
  assert.deepEqual(r.hotSet, ['ws.a.x']);
  assert.equal(r.hotSetCoverage, 0.75);
  assert.deepEqual(r.neverCalled, ['ws.a.z']);
  assert.deepEqual(r.unknown, [{ name: 'ws.bad.name', calls: 1 }]);
});

test('defaultDbPath follows INTENTD_DATA_DIR, then the platform data dir', () => {
  assert.equal(defaultDbPath({ INTENTD_DATA_DIR: '/d' }, 'linux', '/h'), '/d/intentd.db');
  assert.equal(defaultDbPath({}, 'linux', '/h'), '/h/.local/share/intentd/intentd.db');
  assert.equal(defaultDbPath({}, 'darwin', '/h'), '/h/Library/Application Support/intentd/intentd.db');
});

test('openReadOnly refuses writes even on a writable file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-ws-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'intentd.db');
  await buildFixtureDb(dbFile);
  const db = await openReadOnly(dbFile);
  try {
    assert.throws(() => db.exec('CREATE TABLE t (x)'), /readonly/);
  } finally {
    db.close();
  }
});

test('CLI mines a fixture database read-only and writes the JSON report', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-ws-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbFile = path.join(dir, 'intentd.db');
  const toolsRs = path.join(dir, 'tools.rs');
  const jsonOut = path.join(dir, 'usage.json');
  fs.writeFileSync(toolsRs, TOOLS_RS);
  await buildFixtureDb(dbFile);
  fs.chmodSync(dbFile, 0o444);
  const before = fs.readFileSync(dbFile);

  const stdout = execFileSync(process.execPath, [SCRIPT, '--db', dbFile, '--tools-rs', toolsRs, '--top', '2', '--json', jsonOut], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));

  assert.equal(report.scripts, 3);
  assert.deepEqual(report.ranked.map((r) => [r.name, r.calls]), [
    ['ws.note.add', 3],
    ['ws.note.read', 2],
    ['ws.help', 1],
    ['ws.pr.snapshot', 1],
  ]);
  assert.equal(report.knownCalls, 7);
  assert.deepEqual(report.unknown, [{ name: 'ws.made.up', calls: 1 }]);
  assert.deepEqual(report.hotSet, ['ws.note.add', 'ws.note.read']);
  assert.equal(report.hotSetCoverage, 5 / 7);
  assert.deepEqual(report.neverCalled, ['ws.agent.send']);
  assert.match(stdout, /hot set \(2\): 71\.4%/);
  assert.ok(before.equals(fs.readFileSync(dbFile)), 'database file must not change');
});
