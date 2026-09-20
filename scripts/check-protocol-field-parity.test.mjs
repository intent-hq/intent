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

test('extractRustFields parses serde attributes that span several lines', () => {
  const src = [
    '#[derive(Serialize)]',
    '#[serde(',
    '    rename_all = "camelCase",',
    ')]',
    'pub struct Row {',
    '    #[serde(',
    '        rename = "parentAgentId",',
    '    )]',
    '    pub owner_id: String,',
    '    #[serde(',
    '        default,',
    '        skip_serializing_if = "Option::is_none",',
    '        skip,',
    '    )]',
    '    pub hidden: Option<String>,',
    '    pub kept: u8,',
    '}',
    '',
  ].join('\n');
  const { fields, errors } = extractRustFields(src, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['parentAgentId', 'kept']);
  assert.equal(fields[0].rustName, 'owner_id');
  assert.equal(fields[0].line, 9);
});

test('extractRustFields does not close an attribute on a bracket inside a string literal', () => {
  const src = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    #[serde(\n        rename = "a]b",\n    )]\n    pub x: u8,\n}\n';
  const { fields, errors } = extractRustFields(src, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['a]b']);
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

const TS_STRING_BRACES = `
export const RowSchema = z.object({
  id: z.string(),
  metadata: z.object({
    marker: z.literal("}"),
    parentAgentId: z.string(),
  }),
  single: z.literal('{'),
  escaped: z.literal("\\"}"),
  'quoted-key': z.string(),
});
export const After = z.object({ afterKey: z.string() });
`;

test('extractTsKeys ignores braces inside string literals when tracking depth', () => {
  const result = extractTsKeys(TS_STRING_BRACES, 'RowSchema');
  assert.deepEqual(result.keys.map((k) => k.name), ['id', 'metadata', 'single', 'escaped', 'quoted-key']);
  assert.equal(result.endLine, 11);
});

test('extractTsKeys ignores escaped braces inside string literals', () => {
  const src = [
    'export const Row = z.object({',
    '  metadata: z.object({',
    '    marker: z.literal("' + String.fromCharCode(92) + '}"),',
    '    parentAgentId: z.string(),',
    '  }),',
    "  other: z.literal('" + String.fromCharCode(92) + "{'),",
    '});',
    '',
  ].join('\n');
  const result = extractTsKeys(src, 'Row');
  assert.deepEqual(result.keys.map((k) => k.name), ['metadata', 'other']);
  assert.equal(result.endLine, 7);
  const rust = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    pub metadata: Meta,\n    pub parent_agent_id: String,\n    pub other: u8,\n}\n';
  const errors = comparePair(pair(), rust, src);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/);
});

test('comparePair reports a field that only appears inside a nested object next to a string brace', () => {
  const rust = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    pub id: String,\n    pub metadata: Meta,\n    pub parent_agent_id: String,\n}\n';
  const errors = comparePair(pair(), rust, TS_STRING_BRACES.replace('RowSchema', 'Row'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/);
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

test('comparePair does not treat Object.prototype names as ignore entries', () => {
  const rust = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    pub id: String,\n    pub to_string: String,\n    pub constructor: String,\n}\n';
  const ts = 'export interface Row {\n  id: string;\n}\n';
  const errors = comparePair(pair({ ignore: {} }), rust, ts);
  assert.deepEqual(
    errors.map((e) => e.message.match(/emitted field Row\.(\w+)/)[1]),
    ['toString', 'constructor'],
  );
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

test('runChecks fails closed when the submodule is initialized but a manifest path is missing', async (t) => {
  const root = await fixture(t, {
    'packages/intentd/.git': 'gitdir: x\n',
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: x\n',
    'packages/cloudlands-fe/other.ts': TS_FULL,
  });
  const pairs = [{ rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/cloudlands-fe/types.ts', type: 'Row' }, ignore: {} }];
  const result = await runChecks(root, pairs);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.checked, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'packages/cloudlands-fe/types.ts');
  assert.equal(result.errors[0].line, 1);
  assert.match(result.errors[0].message, /packages\/cloudlands-fe\/types\.ts does not exist .*packages\/cloudlands-fe is initialized.*PAIRS/);
});

test('runChecks only skips a pair when the submodule directory itself is absent', async (t) => {
  const root = await fixture(t, {
    'packages/intentd/.git': 'gitdir: x\n',
    'packages/intentd/model.rs': RUST,
  });
  const pairs = [{ rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/cloudlands-fe/types.ts', type: 'Row' }, ignore: {} }];
  const result = await runChecks(root, pairs);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checked, []);
  assert.match(result.skipped[0], /packages\/cloudlands-fe\/types\.ts missing — submodule not initialized/);
});

// ---- Regressions from the PR #5488 review ----

const RUST_HEADER = '#[derive(Serialize)]\n#[serde(rename_all = "camelCase")]\n';
const TS_ID_ONLY = 'export interface Row {\n  id: string;\n}\n';

// Verbatim minimal fixtures recorded by the PR #5488 reviewer (note 5ed38dab). Each
// returned [] at 2bfacd2; none may establish parity.
const REVIEWER_FIXTURES = [
  {
    name: 'rust-block-comment-skip',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub id: u8,\n  /*\n  #[serde(skip)]\n  */\n  pub parent_agent_id: String,\n}\n",
    ts: "export interface Row {\n  id: number;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/,
  },
  {
    name: 'rust-block-comment-brace',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub id: u8,\n  /* Example: {\n  }\n  */\n  pub parent_agent_id: String,\n}\n",
    ts: "export interface Row {\n  id: number;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/,
  },
  {
    name: 'ts-method-parameter',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub id: u8,\n  pub parent_agent_id: String,\n}\n",
    ts: "export interface Row {\n  id: number;\n  describe(\n    parentAgentId: string,\n  ): void;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/,
  },
  {
    name: 'ts-tuple-label',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub id: u8,\n  pub parent_agent_id: String,\n}\n",
    ts: "export interface Row {\n  id: number;\n  metadata: [\n    parentAgentId: string,\n  ];\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row/,
  },
  {
    name: 'ts-commented-declaration',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub id: u8,\n  pub parent_agent_id: String,\n}\n",
    ts: "/* obsolete example\nexport interface Row {\n  id: number;\n  parentAgentId: string;\n}\n*/\nexport interface Row {\n  id: number;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row \(types\.ts:7-9\)/,
  },
  {
    name: 'rust-cfg-attr-rename',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  #[cfg_attr(all(), serde(rename = \"parentAgentId\"))]\n  pub owner_id: String,\n}\n",
    ts: "export interface Row {\n  ownerId: string;\n}\n",
    expect: /unsupported attribute #\[cfg_attr\(all\(\), serde\(rename = "parentAgentId"\)\)\] on Row\.owner_id/,
  },
  {
    name: 'rust-serialize-rename',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  #[serde(rename(serialize = \"parentAgentId\"))]\n  pub owner_id: String,\n}\n",
    ts: "export interface Row {\n  ownerId: string;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust owner_id\) is missing from Row/,
  },
  {
    name: 'rust-trailing-comment-rename',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  #[serde(rename = \"parentAgentId\")] // wire name\n  pub owner_id: String,\n}\n",
    ts: "export interface Row {\n  ownerId: string;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust owner_id\) is missing from Row/,
  },
  {
    name: 'ts-generic-bound',
    rust: "#[serde(rename_all = \"camelCase\")]\npub struct Row {\n  pub parent_agent_id: String,\n}\n",
    ts: "export interface Row<T extends {\n  parentAgentId: string;\n}> {\n  id: string;\n}\n",
    expect: /emitted field Row\.parentAgentId \(Rust parent_agent_id\) is missing from Row \(types\.ts:1-5\)/,
  },
];

for (const fx of REVIEWER_FIXTURES) {
  test(`reviewer fixture ${fx.name} does not establish parity`, () => {
    const errors = comparePair(
      { rust: { file: 'model.rs', struct: 'Row' }, ts: { file: 'types.ts', type: 'Row' }, ignore: {} },
      fx.rust,
      fx.ts,
    );
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].message, fx.expect);
  });
}

test('comparePair: a #[serde(skip)] inside a Rust block comment cannot suppress a missing field', () => {
  const rust = [
    RUST_HEADER + 'pub struct Row {',
    '    pub id: String,',
    '    /* disabled:',
    '    #[serde(skip)]',
    '    */',
    '    pub reviewer_new_field: String,',
    '}',
    '',
  ].join('\n');
  const errors = comparePair(pair(), rust, TS_ID_ONLY);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 8);
  assert.match(errors[0].message, /emitted field Row\.reviewerNewField \(Rust reviewer_new_field\) is missing from Row/);
});

test('comparePair: a standalone } inside a Rust block comment does not end the struct walk', () => {
  const rust = [
    RUST_HEADER + 'pub struct Row {',
    '    pub id: String,',
    '    /* old:',
    '    }',
    '    */',
    '    pub parent_agent_id: String,',
    '    /* outer /* nested */ still a comment',
    '    }',
    '    */',
    '    pub other: u8,',
    '}',
    '',
  ].join('\n');
  const errors = comparePair(pair(), rust, TS_ID_ONLY);
  assert.deepEqual(
    errors.map((e) => e.message.match(/emitted field Row\.(\w+)/)[1]),
    ['parentAgentId', 'other'],
  );
});

test('extractRustFields keeps a rename followed by a trailing line comment', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    #[serde(rename = "parentAgentId")] // wire name\n    pub owner_id: String, // trailing\n}\n';
  const { fields, errors } = extractRustFields(rust, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['parentAgentId']);
});

test('comparePair: a block-commented copy of the Rust struct does not mask the live struct', () => {
  const rust = [
    '/*',
    RUST_HEADER + 'pub struct Row {',
    '    pub id: String,',
    '}',
    '*/',
    RUST_HEADER + 'pub struct Row {',
    '    pub id: String,',
    '    pub parent_agent_id: String,',
    '}',
    '',
  ].join('\n');
  const errors = comparePair(pair(), rust, TS_ID_ONLY);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Row\.parentAgentId .* is missing from Row/);
});

test('comparePair: a block-commented copy of the TS interface does not mask the live interface', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    pub id: String,\n    pub parent_agent_id: String,\n}\n';
  const ts = [
    '/*',
    'export interface Row {',
    '  id: string;',
    '  parentAgentId: string;',
    '}',
    '*/',
    'const doc = `',
    'export interface Row {',
    '  parentAgentId: string;',
    '}`;',
    'export interface Row {',
    '  id: string;',
    '}',
    '',
  ].join('\n');
  const result = extractTsKeys(ts, 'Row');
  assert.equal(result.startLine, 11);
  assert.equal(result.endLine, 13);
  const errors = comparePair(pair(), rust, ts);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Row\.parentAgentId .* is missing from Row \(types\.ts:11-13\)/);
});

test('comparePair: a multiline method parameter named like the field does not satisfy it', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    pub id: String,\n    pub parent_agent_id: String,\n}\n';
  const ts = [
    'export interface Row {',
    '  id: string;',
    '  describe(',
    '    parentAgentId: string,',
    '    depth: number,',
    '  ): void;',
    '  handler: (',
    '    parentAgentId: string,',
    '  ) => void;',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(extractTsKeys(ts, 'Row').keys.map((k) => k.name), ['id', 'describe', 'handler']);
  const errors = comparePair(pair(), rust, ts);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Row\.parentAgentId .* is missing from Row/);
});

test('comparePair: a labelled tuple member named like the field does not satisfy it', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    pub id: String,\n    pub parent_agent_id: String,\n}\n';
  const ts = [
    'export interface Row {',
    '  id: string;',
    '  pair: [',
    '    parentAgentId: string,',
    '    other: number,',
    '  ];',
    "  marker: z.literal(')') | z.literal('[');",
    '}',
    '',
  ].join('\n');
  assert.deepEqual(extractTsKeys(ts, 'Row').keys.map((k) => k.name), ['id', 'pair', 'marker']);
  const errors = comparePair(pair(), rust, ts);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Row\.parentAgentId .* is missing from Row/);
});

test('comparePair: properties of a generic constraint do not satisfy row fields', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    pub id: String,\n    pub parent_agent_id: String,\n}\n';
  const ts = [
    'export interface Row<T extends {',
    '  parentAgentId: string;',
    '}> {',
    '  id: string;',
    '}',
    '',
  ].join('\n');
  const result = extractTsKeys(ts, 'Row');
  assert.deepEqual(result.keys.map((k) => k.name), ['id']);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 5);
  const errors = comparePair(pair(), rust, ts);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Row\.parentAgentId .* is missing from Row \(types\.ts:1-5\)/);

  const oneLine = 'export interface Row<T extends () => void> extends Base<{ parentAgentId: string }> {\n  id: string;\n}\n';
  assert.deepEqual(extractTsKeys(oneLine, 'Row').keys.map((k) => k.name), ['id']);
  assert.equal(comparePair(pair(), rust, oneLine).length, 1);
});

test('extractRustFields honors the directional rename(serialize = ...) form', () => {
  const rust = [
    RUST_HEADER + 'pub struct Row {',
    '    #[serde(rename(serialize = "parentAgentId"))]',
    '    pub owner_id: String,',
    '    #[serde(rename(serialize = "wireA", deserialize = "inputA"))]',
    '    pub a: u8,',
    '    #[serde(rename(deserialize = "inputB", serialize = "wireB"))]',
    '    pub b: u8,',
    '    #[serde(rename(deserialize = "inputC"))]',
    '    pub c_name: u8,',
    '}',
    '',
  ].join('\n');
  const { fields, errors } = extractRustFields(rust, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['parentAgentId', 'wireA', 'wireB', 'cName']);
});

test('comparePair: cfg_attr-wrapped serde attributes fail with an actionable unsupported-attribute error', () => {
  const rust = RUST_HEADER + 'pub struct Row {\n    pub id: String,\n    #[cfg_attr(all(), serde(rename = "parentAgentId"))]\n    pub owner_id: String,\n}\n';
  const ts = 'export interface Row {\n  id: string;\n  ownerId: string;\n}\n';
  const errors = comparePair(pair(), rust, ts);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'model.rs');
  assert.equal(errors[0].line, 5);
  assert.match(errors[0].message, /unsupported attribute .*cfg_attr.* on Row\.owner_id/);
});

test('comparePair: other uninterpretable wire-affecting attributes fail instead of asserting parity', () => {
  const ts = 'export interface Row {\n  id: string;\n  ownerId: string;\n}\n';
  const cases = [
    ['#[cfg(feature = "x")]', /unsupported attribute .*#\[cfg\(feature = "x"\)\] on Row\.owner_id/],
    ['#[serde(rename(bogus = "parentAgentId"))]', /unsupported attribute .*rename\(bogus = "parentAgentId"\).* on Row\.owner_id/],
    ['#[serde(rename_all(serialize = "PascalCase"))]', /unsupported attribute .*rename_all\(serialize = "PascalCase"\).* on Row\.owner_id/],
    ['#[serde(getter_of_wire_name = "parentAgentId")]', /unsupported attribute .*getter_of_wire_name.* on Row\.owner_id/],
  ];
  for (const [attr, re] of cases) {
    const rust = RUST_HEADER + `pub struct Row {\n    pub id: String,\n    ${attr}\n    pub owner_id: String,\n}\n`;
    const errors = comparePair(pair(), rust, ts);
    assert.equal(errors.length, 1, attr);
    assert.equal(errors[0].line, 5, attr);
    assert.match(errors[0].message, re);
  }
  const structLevel = '#[derive(Serialize)]\n#[serde(rename_all = "camelCase", tag = "kind")]\npub struct Row {\n    pub id: String,\n    pub owner_id: String,\n}\n';
  const errors = comparePair(pair(), structLevel, ts);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /unsupported attribute .*tag = "kind".* on struct Row/);
});

test('comparePair: container attributes that replace the serialized shape fail instead of asserting parity', () => {
  const ts = 'export interface Row {\n  ownerId: string;\n}\n';
  for (const arg of ['into = "WireRow"', 'try_into = "WireRow"', 'remote = "WireRow"']) {
    const rust = `#[derive(Serialize)]\n#[serde(rename_all = "camelCase", ${arg})]\npub struct Row {\n    pub owner_id: String,\n}\n`;
    const errors = comparePair(pair(), rust, ts);
    assert.equal(errors.length, 1, arg);
    assert.equal(errors[0].file, 'model.rs', arg);
    assert.equal(errors[0].line, 2, arg);
    assert.match(errors[0].message, new RegExp(`unsupported attribute .*${arg.replace(/[()"]/g, '\\$&')}.* on struct Row`));
  }
});

test('comparePair: whitespace inside an attribute does not hide a wire-affecting serde argument', () => {
  const ts = 'export interface Row {\n  ownerId: string;\n}\n';
  const missing = /emitted field Row\.parentAgentId \(Rust owner_id\) is missing from Row/;
  const cases = [
    ['#[serde (rename = "parentAgentId")]', missing, 5],
    ['# [serde(rename = "parentAgentId")]', missing, 5],
    ['#[ serde( rename = "parentAgentId" ) ]', missing, 5],
    ['#[cfg_attr (all(), serde(rename = "parentAgentId"))]', /unsupported attribute .*cfg_attr .*on Row\.owner_id/, 4],
    ['# [cfg(feature = "x")]', /unsupported attribute .*cfg\(feature.*on Row\.owner_id/, 4],
  ];
  for (const [attr, re, line] of cases) {
    const rust = `#[derive(Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct Row {\n    ${attr}\n    pub owner_id: String,\n}\n`;
    const errors = comparePair(pair(), rust, ts);
    assert.equal(errors.length, 1, attr);
    assert.equal(errors[0].line, line, attr);
    assert.match(errors[0].message, re, attr);
  }
  const skipped = '#[derive(Serialize)]\n#[serde(rename_all = "camelCase")]\npub struct Row {\n    pub owner_id: String,\n    # [serde (skip)]\n    pub hidden: u8,\n}\n';
  assert.deepEqual(comparePair(pair(), skipped, ts), []);
});

test('extractRustFields accepts a spaced struct-level rename_all attribute', () => {
  const rust = '#[derive(Serialize)]\n# [serde (rename_all = "camelCase")]\npub struct Row {\n    pub owner_id: String,\n}\n';
  const { fields, errors } = extractRustFields(rust, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['ownerId']);
});

test('extractRustFields still accepts the harmless serde arguments used in model.rs', () => {
  const rust = [
    '#[derive(Serialize)]',
    '#[serde(rename_all = "camelCase", deny_unknown_fields, default)]',
    'pub struct Row {',
    '    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "de", alias = "legacy")]',
    '    pub a: Option<u8>,',
    '    #[serde(default = "default_b", with = "m", serialize_with = "s", skip_deserializing, borrow)]',
    '    pub b: u8,',
    '}',
    '',
  ].join('\n');
  const { fields, errors } = extractRustFields(rust, 'Row', 'x.rs');
  assert.deepEqual(errors, []);
  assert.deepEqual(fields.map((f) => f.wire), ['a', 'b']);
});

test('manifest pairs have a reason for every ignore entry', () => {
  assert.equal(PAIRS.length, 2);
  for (const p of PAIRS) {
    for (const [field, reason] of Object.entries(p.ignore)) {
      assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${p.rust.struct}.${field} needs a reason`);
    }
  }
});
