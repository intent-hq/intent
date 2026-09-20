// Fixture-driven tests for scripts/check-protocol-field-parity.mjs.
// Run: node --test scripts/check-protocol-field-parity.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PAIRS, comparePair, extractRustFields, extractTsKeys, formatError, runChecks, toCamelCase } from './check-protocol-field-parity.mjs';

const RUST = `
/// Doc comment.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    /// Multi-word field.
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<String>,
    #[serde(rename = "kind")]
    pub row_kind: u8,
    #[serde(skip)]
    pub secret: String,
    #[serde(skip_serializing)]
    pub input_only: String,
    #[serde(default, flatten, skip_serializing_if = "Option::is_none")]
    pub membership: Option<Membership>,
    pub metadata: Meta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub member_count: u64,
    pub my_role: Option<Role>,
}
`;

const pair = (extra = {}) => ({
  rust: { file: 'model.rs', struct: 'Row' },
  ts: { file: 'types.ts', type: 'Row' },
  ignore: {},
  ...extra,
});

test('toCamelCase matches serde rename_all = "camelCase"', () => {
  assert.equal(toCamelCase('id'), 'id');
  assert.equal(toCamelCase('is_waiting_for_other_agents'), 'isWaitingForOtherAgents');
  assert.equal(toCamelCase('field_2'), 'field2');
});

test('extractRustFields honors rename_all, rename, skip and inlines same-file flatten', () => {
  const { fields, structLine, errors } = extractRustFields(RUST, 'Row', 'model.rs');
  assert.deepEqual(errors, []);
  assert.equal(structLine, 5);
  assert.deepEqual(
    fields.map((f) => f.wire),
    ['id', 'workspaceId', 'lastActivity', 'kind', 'memberCount', 'myRole', 'metadata'],
  );
  const lastActivity = fields.find((f) => f.wire === 'lastActivity');
  assert.equal(lastActivity.rustName, 'last_activity');
  assert.equal(lastActivity.line, 10);
});

test('extractRustFields returns null fields for an unknown struct', () => {
  assert.equal(extractRustFields(RUST, 'Nope', 'model.rs').fields, null);
});

test('extractRustFields rejects a struct without a supported rename_all', () => {
  const src = '#[derive(Serialize)]\npub struct Plain {\n    pub a_b: u8,\n}\n';
  const { errors } = extractRustFields(src, 'Plain', 'x.rs');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Plain has no #\[serde\(rename_all\)\]/);
  const snake = '#[serde(rename_all = "snake_case")]\npub struct S {\n    pub a: u8,\n}\n';
  assert.match(extractRustFields(snake, 'S', 'x.rs').errors[0].message, /rename_all = "snake_case".*only camelCase/);
});

test('extractRustFields rejects flatten of a struct not defined in the same file', () => {
  const src = '#[serde(rename_all = "camelCase")]\npub struct Outer {\n    #[serde(flatten)]\n    pub inner: other::Inner,\n}\n';
  const { fields, errors } = extractRustFields(src, 'Outer', 'x.rs');
  assert.deepEqual(fields, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
  assert.match(errors[0].message, /Outer\.inner is #\[serde\(flatten\)\] but struct Inner is not defined in x\.rs/);
});

const TS_INTERFACE = `
export interface Other { nope: string }
/** Doc with a brace { inside */
export interface Row extends Base {
  id: string; // trailing } comment
  readonly 'workspaceId': string;
  lastActivity?: Date | string;
  kind: 1 | 2;
  metadata: {
    nested: string;
    deeper: { evenDeeper: string };
  };
  /* block
     comment: notAKey */
  memberCount: number;
  method(): void;
  [key: string]: unknown;
}
export interface After { afterKey: string }
`;

test('extractTsKeys collects only top-level interface keys and reports the block range', () => {
  const result = extractTsKeys(TS_INTERFACE, 'Row');
  assert.deepEqual(
    result.keys.map((k) => k.name),
    ['id', 'workspaceId', 'lastActivity', 'kind', 'metadata', 'memberCount', 'method'],
  );
  assert.equal(result.startLine, 4);
  assert.equal(result.endLine, 18);
  assert.equal(result.keys.find((k) => k.name === 'memberCount').line, 15);
});

const TS_ZOD = `
export const RowSchema = z.object({
  id: z.string(),
  metadata: z.object({
    nested: z.string(),
  }),
  myRole: z.enum(['owner', 'member']).optional(),
});
`;

test('extractTsKeys supports z.object blocks with nested objects', () => {
  const result = extractTsKeys(TS_ZOD, 'RowSchema');
  assert.deepEqual(result.keys.map((k) => k.name), ['id', 'metadata', 'myRole']);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 8);
});

test('extractTsKeys returns null for an unknown block', () => {
  assert.equal(extractTsKeys(TS_INTERFACE, 'Missing'), null);
});

const TS_FULL = `
export interface Row {
  id: string;
  workspaceId: string;
  lastActivity?: string;
  kind: number;
  memberCount: number;
  myRole?: string;
  metadata: Record<string, unknown>;
}
`;

test('comparePair passes when every emitted field is declared', () => {
  assert.deepEqual(comparePair(pair(), RUST, TS_FULL), []);
});

test('comparePair reports an emitted field missing from the TS type with both files and a fix', () => {
  const ts = TS_FULL.replace('  lastActivity?: string;\n', '');
  const errors = comparePair(pair(), RUST, ts);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'model.rs');
  assert.equal(errors[0].line, 10);
  const text = formatError(errors[0]);
  assert.match(text, /^model\.rs:10: error: Row → Row: emitted field Row\.lastActivity \(Rust last_activity\) is missing from Row \(types\.ts:2-9\)/);
  assert.match(text, /add it to the TS type .* or add an ignore entry with a reason/);
});

test('comparePair accepts an ignore entry for a missing field', () => {
  const ts = TS_FULL.replace('  lastActivity?: string;\n', '');
  assert.deepEqual(comparePair(pair({ ignore: { lastActivity: 'not consumed' } }), RUST, ts), []);
});

test('comparePair reports a stale ignore entry whose field is no longer emitted', () => {
  const errors = comparePair(pair({ ignore: { gone: 'reason' } }), RUST, TS_FULL);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'model.rs');
  assert.equal(errors[0].line, 5);
  assert.match(errors[0].message, /stale ignore entry gone \("reason"\) — Row no longer emits it; remove the entry/);
});

test('comparePair reports a stale ignore entry whose field is now declared by the TS type', () => {
  const errors = comparePair(pair({ ignore: { kind: 'reason' } }), RUST, TS_FULL);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'types.ts');
  assert.equal(errors[0].line, 6);
  assert.match(errors[0].message, /stale ignore entry kind .* Row now declares it; remove the entry/);
});

test('comparePair reports a struct or type that cannot be found', () => {
  const noStruct = comparePair(pair({ rust: { file: 'model.rs', struct: 'Missing' } }), RUST, TS_FULL);
  assert.equal(noStruct.length, 1);
  assert.equal(formatError(noStruct[0]), 'model.rs:1: error: Missing → Row: pub struct Missing not found');
  const noType = comparePair(pair({ ts: { file: 'types.ts', type: 'Missing' } }), RUST, TS_FULL);
  assert.equal(noType.length, 1);
  assert.match(formatError(noType[0]), /^types\.ts:1: error: Row → Missing: export interface Missing \/ export const Missing = z\.object\(\{ not found$/);
});

test('comparePair surfaces flatten and rename_all errors instead of comparing', () => {
  const src = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    #[serde(flatten)]\n    pub inner: Inner,\n}\n';
  const errors = comparePair(pair(), src, TS_FULL);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /flatten/);
});

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-protocol-field-parity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return root;
}

test('runChecks skips a pair whose submodule is not initialized and checks the rest', async (t) => {
  const pairs = [
    { rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/cloudlands-fe/types.ts', type: 'Row' }, ignore: {} },
    { rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/ios/Types.ts', type: 'Row' }, ignore: {} },
  ];
  const root = await fixture(t, {
    'packages/intentd/.git': 'gitdir: ../../.git/modules/packages/intentd\n',
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: ../../.git/modules/packages/cloudlands-fe\n',
    'packages/cloudlands-fe/types.ts': TS_FULL,
  });
  const result = await runChecks(root, pairs);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checked, ['Row → Row']);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /^skipped: Row → Row \(packages\/ios\/Types\.ts missing — submodule not initialized\)$/);
});

test('runChecks treats a submodule directory without .git as uninitialized', async (t) => {
  const root = await fixture(t, {
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: x\n',
    'packages/cloudlands-fe/types.ts': TS_FULL,
  });
  const pairs = [{ rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/cloudlands-fe/types.ts', type: 'Row' }, ignore: {} }];
  const result = await runChecks(root, pairs);
  assert.deepEqual(result.checked, []);
  assert.match(result.skipped[0], /packages\/intentd\/model\.rs missing/);
});

test('manifest pairs have a reason for every ignore entry', () => {
  assert.equal(PAIRS.length, 2);
  for (const p of PAIRS) {
    for (const [field, reason] of Object.entries(p.ignore)) {
      assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${p.rust.struct}.${field} needs a reason`);
    }
  }
});
