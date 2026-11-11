import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ADOPTION_MARKER, CATALOG_FILE, FE_DIR, FE_FILE, INTENTD_DIR,
  adoption, collectCalledMethods, compare, parsePayloadClasses, parseTransferMethods, run,
} from './check-transfer-methods.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-transfer-methods.mjs');

// Synthetic sources in the shapes the components use; the real files are
// read only by `make check-transfer-methods`.
const catalogRs = (rows) => `pub enum PayloadClass { BoundedRead }

/// Every method's payload class.
pub const PAYLOAD_CLASSES: &[PayloadBudget] = &[
${rows.join('\n')}
];
`;
const BASE_ROWS = [
  '    bounded("file.read", "One UTF-8 file, capped."),',
  '    // bulk("commented.out", None, 1, "ignored"),',
  '    bulk("file.readChunk", Some("length"), IMPORT_MAX_CHUNK_BYTES, "Offset-windowed read."),',
  '    bulk(',
  '        "workspace.export.read",',
  '        None,',
  '        IMPORT_MAX_CHUNK_BYTES,',
  '        "One export chunk.",',
  '    ),',
  '    bulk("git.showFileChunk", Some("length"), IMPORT_MAX_CHUNK_BYTES, "Blob window."),',
  '    mutation("file.placeAttachment", "Copies an attachment."),',
  '    proxy("github.pulls.list", Some("perPage"), "A page of PRs."),',
  '    subscription("events.subscribe", "Stream control."),',
];
// Both sides carry the bounded-object-read work, so the check enforces.
const M = ADOPTION_MARKER;
// intentd before the work: the whole-object reads are still bulk(...).
const OLD_ROWS = BASE_ROWS.filter((row) => !row.includes(M)).map((row) => row.replace('bounded("file.read"', 'bulk("file.read", None, 1,'));
const transferTs = (methods) => `/** The bulk methods. */
const TRANSFER_METHODS = new Set([
${methods.map((m) => `  '${m}',`).join('\n')}
]);
`;

test('parsePayloadClasses reads one class per method, multi-line calls included', () => {
  const classes = parsePayloadClasses(catalogRs(BASE_ROWS));
  assert.deepEqual(Object.fromEntries(classes), {
    'file.read': 'bounded',
    'file.readChunk': 'bulk',
    'git.showFileChunk': 'bulk',
    'workspace.export.read': 'bulk',
    'file.placeAttachment': 'mutation',
    'github.pulls.list': 'proxy',
    'events.subscribe': 'subscription',
  });
});

test('parsePayloadClasses returns null before PAYLOAD_CLASSES exists and fails closed on a new shape', () => {
  assert.equal(parsePayloadClasses('pub const ROUTER_METHODS: &[&str] = &[];\n'), null);
  assert.throws(() => parsePayloadClasses('pub static PAYLOAD_CLASSES: Vec<PayloadBudget> = vec![];\n'), /no longer/);
  assert.throws(() => parsePayloadClasses(catalogRs([...BASE_ROWS, '    PayloadBudget { method: "x.y", class: PayloadClass::BoundedRead, reason: "r" },'])), /not a bounded/);
  assert.throws(() => parsePayloadClasses(catalogRs([...BASE_ROWS, '    bounded("file.read", "again"),'])), /more than once/);
});

test('parseTransferMethods reads string literals and fails closed on anything else', () => {
  assert.deepEqual(parseTransferMethods(transferTs(['file.readChunk', 'file.placeAttachment'])), ['file.readChunk', 'file.placeAttachment']);
  assert.throws(() => parseTransferMethods('const TRANSFER_METHODS = [];\n'), /not found/);
  assert.throws(() => parseTransferMethods(transferTs(['a.b']).replace("'a.b',", "...OTHER, 'a.b',")), /other than string literals/);
});

test('collectCalledMethods finds quoted method names outside comments', () => {
  const called = collectCalledMethods([
    "await backendRequest('git.showFile', {});\n// 'commented.method'\nconst x = \"note.readAsset\";\nconst y = `file.read`;\nconst z = 'not a method';",
  ]);
  assert.ok(called.has('git.showFile'));
  assert.ok(called.has('note.readAsset'));
  assert.ok(called.has('file.read'));
  assert.ok(!called.has('commented.method'));
});

test('compare passes when every called bulk method is routed', () => {
  const classes = parsePayloadClasses(catalogRs(BASE_ROWS));
  const r = compare({
    classes,
    transfer: ['file.readChunk', 'workspace.export.read', 'file.placeAttachment', M],
    called: new Set(['file.readChunk', 'workspace.export.read', 'file.read']),
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.routed, 3);
  assert.equal(r.pending, null);
});

test('compare fails a called bulk method missing from TRANSFER_METHODS (deliberate mismatch)', () => {
  const classes = parsePayloadClasses(catalogRs(BASE_ROWS));
  const r = compare({ classes, transfer: ['file.readChunk', M], called: new Set(['workspace.export.read']) });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^workspace\.export\.read is BulkTransfer .* does not route it/);
});

test('compare only warns for a bulk method the app does not call yet', () => {
  const classes = parsePayloadClasses(catalogRs(BASE_ROWS));
  const r = compare({ classes, transfer: ['file.readChunk', M], called: new Set() });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join('\n'), /workspace\.export\.read .* does not call it yet/);
});

test('compare fails a capped read in TRANSFER_METHODS and warns on an unclassified entry', () => {
  const classes = parsePayloadClasses(catalogRs(BASE_ROWS));
  const r = compare({
    classes,
    transfer: ['file.readChunk', 'workspace.export.read', 'file.read', 'brand.new', 'file.readChunk', M],
    called: new Set(),
  });
  assert.match(r.errors.join('\n'), /file\.read is in TRANSFER_METHODS .* classifies it bounded/);
  assert.match(r.errors.join('\n'), /lists file\.readChunk more than once/);
  assert.match(r.warnings.join('\n'), /brand\.new is in TRANSFER_METHODS .* does not classify it/);
});

function fixture({ rows = BASE_ROWS, transfer = ['file.readChunk', 'workspace.export.read', M], app = "backendRequest('workspace.export.read');" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-transfer-methods-'));
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  if (rows) write(path.join(INTENTD_DIR, CATALOG_FILE), catalogRs(rows));
  else write(path.join(INTENTD_DIR, CATALOG_FILE), 'pub const ROUTER_METHODS: &[&str] = &[];\n');
  write(path.join(FE_DIR, FE_FILE), transferTs(transfer));
  write(path.join(FE_DIR, 'src/features/export.ts'), app);
  write(path.join(FE_DIR, 'src/features/export.test.ts'), "backendRequest('file.readChunk');");
  return dir;
}

test('run reads both checkouts and skips before PAYLOAD_CLASSES exists', () => {
  const quiet = { log: () => {}, warn: () => {} };
  let dir = fixture();
  try {
    assert.deepEqual(run(dir, quiet).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = fixture({ rows: null });
  try {
    assert.match(run(dir, quiet).skipped, /no PAYLOAD_CLASSES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits non-zero on a mismatch and zero when routed', () => {
  let dir = fixture({ transfer: ['file.readChunk', M] });
  try {
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /workspace\.export\.read is BulkTransfer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = fixture();
  try {
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /3 BulkTransfer methods ride transfer connections/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adoption needs the marker on both sides', () => {
  const newClasses = parsePayloadClasses(catalogRs(BASE_ROWS));
  const oldClasses = parsePayloadClasses(catalogRs(OLD_ROWS));
  assert.deepEqual(adoption({ classes: newClasses, transfer: [M] }), { intentd: true, fe: true, both: true });
  assert.deepEqual(adoption({ classes: newClasses, transfer: ['file.readChunk'] }), { intentd: true, fe: false, both: false });
  assert.deepEqual(adoption({ classes: oldClasses, transfer: [M] }), { intentd: false, fe: true, both: false });
});

test('compare only warns while a pin predates the work (docs lead the pin)', () => {
  // Today's pins: old intentd (file.read is bulk) and an app that routes only file.readChunk.
  const called = new Set(['file.read', 'workspace.export.read']);
  let r = compare({ classes: parsePayloadClasses(catalogRs(OLD_ROWS)), transfer: ['file.readChunk'], called });
  assert.deepEqual(r.errors, []);
  assert.equal(r.pending, 'intentd and cloudlands-fe');
  assert.match(r.warnings[0], /^not enforced yet: intentd and cloudlands-fe do not carry/);
  assert.match(r.warnings.join('\n'), /pending adoption: file\.read is BulkTransfer .* does not route it/);
  assert.match(r.warnings.join('\n'), /pending adoption: workspace\.export\.read is BulkTransfer/);
  // intentd landed first, app pin not advanced yet.
  r = compare({ classes: parsePayloadClasses(catalogRs(BASE_ROWS)), transfer: ['file.readChunk'], called });
  assert.match(r.warnings[0], /^not enforced yet: cloudlands-fe does not carry/);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pending, 'cloudlands-fe');
  // Both adopted: the same mismatch is enforced.
  r = compare({ classes: parsePayloadClasses(catalogRs(BASE_ROWS)), transfer: ['file.readChunk', M], called });
  assert.equal(r.pending, null);
  assert.match(r.errors.join('\n'), /^workspace\.export\.read is BulkTransfer .* does not route it/);
});

test('the CLI passes with a warning before adoption and fails the same mismatch after', () => {
  const app = "backendRequest('workspace.export.read'); backendRequest('file.read');";
  let dir = fixture({ rows: OLD_ROWS, transfer: ['file.readChunk'], app });
  try {
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /::warning::check-transfer-methods: not enforced yet/);
    assert.match(r.stdout, /::warning::check-transfer-methods: pending adoption: workspace\.export\.read is BulkTransfer/);
    assert.match(r.stdout, /pass \(not enforced yet; waiting on intentd and cloudlands-fe\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = fixture({ transfer: ['file.readChunk', M], app });
  try {
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /error: workspace\.export\.read is BulkTransfer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
