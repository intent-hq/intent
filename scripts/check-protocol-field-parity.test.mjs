// Fixture-driven tests for scripts/check-protocol-field-parity.mjs.
// Run: node --test scripts/check-protocol-field-parity.test.mjs

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  PAIRS,
  STAGED_DOC,
  STAGED_HEADING,
  comparePair,
  extractRustFields,
  extractTsKeys,
  formatDiagnostic,
  formatRefBanner,
  formatRefOffPinWarning,
  parseStagedFields,
  runChecks,
  toCamelCase,
} from './check-protocol-field-parity.mjs';
import { cleanNodeEnv } from './test-env.mjs';

const SCRIPT = fileURLToPath(new URL('./check-protocol-field-parity.mjs', import.meta.url));

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
  assert.equal(errors[0].severity, undefined);
  const text = formatDiagnostic(errors[0]);
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

test('comparePair warns about a stale ignore entry whose field is no longer emitted', () => {
  const diags = comparePair(pair({ ignore: { gone: 'reason' } }), RUST, TS_FULL);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warning');
  assert.equal(diags[0].file, 'model.rs');
  assert.equal(diags[0].line, 5);
  assert.match(formatDiagnostic(diags[0]), /^model\.rs:5: warning: Row → Row: stale ignore entry gone \("reason"\) — Row no longer emits it; remove the entry from PAIRS$/);
});

test('comparePair warns about a stale ignore entry whose field is now declared by the TS type', () => {
  const diags = comparePair(pair({ ignore: { kind: 'reason' } }), RUST, TS_FULL);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warning');
  assert.equal(diags[0].file, 'types.ts');
  assert.equal(diags[0].line, 6);
  assert.match(formatDiagnostic(diags[0]), /^types\.ts:6: warning: Row → Row: stale ignore entry kind \("reason"\) — Row now declares it; remove the entry from PAIRS$/);
});

test('comparePair reports a struct or type that cannot be found', () => {
  const noStruct = comparePair(pair({ rust: { file: 'model.rs', struct: 'Missing' } }), RUST, TS_FULL);
  assert.equal(noStruct.length, 1);
  assert.equal(formatDiagnostic(noStruct[0]), 'model.rs:1: error: Missing → Row: pub struct Missing not found');
  const noType = comparePair(pair({ ts: { file: 'types.ts', type: 'Missing' } }), RUST, TS_FULL);
  assert.equal(noType.length, 1);
  assert.match(formatDiagnostic(noType[0]), /^types\.ts:1: error: Row → Missing: export interface Missing \/ export const Missing = z\.object\(\{ not found$/);
});

test('comparePair surfaces flatten and rename_all errors instead of comparing', () => {
  const src = '#[serde(rename_all = "camelCase")]\npub struct Row {\n    #[serde(flatten)]\n    pub inner: Inner,\n}\n';
  const errors = comparePair(pair(), src, TS_FULL);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /flatten/);
});

// The staged daemon-first field table as docs/protocol/versioning.md carries
// it; `rows` are `[row, field, contract, adoption]` cell strings.
function stagedDoc(rows = []) {
  const body = rows.map((cells) => `| ${cells.join(' | ')} |\n`).join('');
  return `# Versioning\n\n### ${STAGED_HEADING}\n\nProse.\n\n| Row | Field | Contract | App adoption |\n|---|---|---|---|\n${body}\n## Next\n`;
}

// Every fixture root carries an empty staged table unless `files` names
// STAGED_DOC; `null` leaves the file out.
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-protocol-field-parity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ [STAGED_DOC]: stagedDoc(), ...files })) {
    if (content === null) continue;
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
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.checked, ['Row → Row']);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /^skipped: Row → Row \(packages\/ios\/Types\.ts missing — submodule not initialized\)$/);
});

const FIXTURE_PAIR = { rust: { file: 'packages/intentd/model.rs', struct: 'Row' }, ts: { file: 'packages/cloudlands-fe/types.ts', type: 'Row' }, ignore: {} };

test('parseStagedFields reads rows keyed by struct and strips backticks', () => {
  const { staged, errors } = parseStagedFields(stagedDoc([['`Row`', '`lastActivity`', LINK, 'cloudlands-fe#1']]), STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...staged.get('Row')], [['lastActivity', { file: STAGED_DOC, line: 9, adoption: 'cloudlands-fe#1' }]]);
});

test('parseStagedFields accepts an empty table', () => {
  const { staged, errors } = parseStagedFields(stagedDoc(), STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.equal(staged.size, 0);
});

const LINK = '[§5.5](./methods/agents.md)';

test('parseStagedFields fails closed on a malformed table', () => {
  const cases = [
    ['# Versioning\n\nNo table here.\n', 1, /heading not found/],
    [`### ${STAGED_HEADING}\n\nProse only.\n\n## Next\n`, 1, /no table follows the heading/],
    [`### ${STAGED_HEADING}\n\n| Row | Field |\n|---|---|\n`, 3, /table columns are Row \| Field; expected Row \| Field \| Contract \| App adoption/],
    [`### ${STAGED_HEADING}\n\n| Row | Field | Contract | App adoption |\n| Row | x | y | z |\n`, 4, /separator row/],
    [stagedDoc([['`Row`', '`a`', LINK]]), 9, /row has 3 cell\(s\); expected 4/],
    [stagedDoc([['`Row`', 'two words', LINK, 'a']]), 9, /Row and Field must each be one name, in balanced backticks or none/],
    [stagedDoc([['`Row`', '`a', LINK, 'a']]), 9, /Row and Field must each be one name, in balanced backticks or none \(got `Row` \/ `a\)/],
    [stagedDoc([['`Row`', '`a`', LINK, '']]), 9, /Row\.a needs a Markdown link to its Contract and the App adoption/],
    [stagedDoc([['`Row`', '`a`', 'TBD', 'later']]), 9, /Row\.a needs a Markdown link to its Contract/],
    [stagedDoc([['`Other`', '`a`', LINK, 'a']]), 9, /Row Other is not a checked Rust row struct \(Row\); name the Rust struct, not the frontend type/],
    [stagedDoc([['`Row`', '`kind`', LINK, 'a']]), 9, /Row\.kind is also a PAIRS ignore entry/],
    [stagedDoc([['`Row`', '`a`', LINK, 'a'], ['`Row`', '`a`', LINK, 'b']]), 10, /Row\.a is listed twice \(first at line 9\)/],
  ];
  for (const [doc, line, re] of cases) {
    const { errors } = parseStagedFields(doc, STAGED_DOC, [pair({ ignore: { kind: 'never read' } })]);
    assert.equal(errors.length, 1, doc);
    assert.equal(errors[0].line, line, doc);
    assert.equal(errors[0].severity, undefined);
    assert.match(formatDiagnostic(errors[0]), re);
  }
});

test('parseStagedFields keeps escaped pipes inside a cell', () => {
  const { staged, errors } = parseStagedFields(stagedDoc([['`Row`', '`a`', `${LINK} \`string \\| null\``, 'cloudlands-fe#1']]), STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.ok(staged.get('Row').has('a'));
});

test('parseStagedFields accepts a serde-renamed wire name that is not an identifier', () => {
  const { staged, errors } = parseStagedFields(stagedDoc([['`Row`', '`x-trace-id`', LINK, 'cloudlands-fe#1']]), STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.ok(staged.get('Row').has('x-trace-id'));
});

test('parseStagedFields ignores an example section inside a code fence', () => {
  const fenced = `# Versioning\n\n\`\`\`md\n### ${STAGED_HEADING}\n\n| Row | Field | Contract | App adoption |\n|---|---|---|---|\n| \`Row\` | \`example\` | ${LINK} | cloudlands-fe#0 |\n\`\`\`\n\n`;
  const doc = fenced + stagedDoc([['`Row`', '`real`', LINK, 'cloudlands-fe#1']]).replace('# Versioning\n\n', '');
  const { staged, errors } = parseStagedFields(doc, STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...staged.get('Row').keys()], ['real']);
});

test('parseStagedFields ends the table at the first non-table line', () => {
  const doc = stagedDoc([['`Row`', '`a`', LINK, 'cloudlands-fe#1']]).replace('\n## Next\n', '\nProse.\n| `Row` | `b` | x | y |\n');
  const { staged, errors } = parseStagedFields(doc, STAGED_DOC, [pair()]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...staged.get('Row').keys()], ['a']);
});

test('parseStagedFields reads the table the way GitHub renders it', () => {
  const row = (field) => `| \`Row\` | \`${field}\` | ${LINK} | cloudlands-fe#1 |`;
  const doc = (...body) => stagedDoc().replace('|---|---|---|---|\n', `|---|---|---|---|\n${body.join('\n')}\n`);
  // A lazy line right after the table is a row on GitHub, so it is checked (and fails) instead of ending the table.
  const lazy = parseStagedFields(doc(row('a'), 'Trailing prose.'), STAGED_DOC, [pair()]);
  assert.deepEqual(lazy.errors.map((e) => [e.line, e.message.match(/row has \d+ cell\(s\)/)?.[0]]), [[10, 'row has 1 cell(s)']]);
  // A tab-indented line is indented code on GitHub: it ends the table and is not a row.
  const tabbed = parseStagedFields(doc(row('a'), `\t${row('b')}`), STAGED_DOC, [pair()]);
  assert.deepEqual(tabbed.errors, []);
  assert.deepEqual([...tabbed.staged.get('Row').keys()], ['a']);
  // A backslash before an escaped pipe still escapes it (cmark-gfm), so the cell does not split.
  const escaped = parseStagedFields(doc(`| \`Row\` | \`a\` | ${LINK} \`x\\\\|y\` | cloudlands-fe#1 |`), STAGED_DOC, [pair()]);
  assert.deepEqual(escaped.errors, []);
  // A tilde line inside a backtick fence does not close it, so the example heading stays hidden.
  const fenced = `# Versioning\n\n\`\`\`md\n~~~\n### ${STAGED_HEADING}\n\`\`\`\n\n${stagedDoc([['`Row`', '`real`', LINK, 'cloudlands-fe#1']]).replace('# Versioning\n\n', '')}`;
  const hidden = parseStagedFields(fenced, STAGED_DOC, [pair()]);
  assert.deepEqual(hidden.errors, []);
  assert.deepEqual([...hidden.staged.get('Row').keys()], ['real']);
});

test('parseStagedFields names a separator row with the wrong cell count', () => {
  const doc = `### ${STAGED_HEADING}\n\n| Row | Field | Contract | App adoption |\n|---|---|---|\n`;
  const { errors } = parseStagedFields(doc, STAGED_DOC, [pair()]);
  assert.deepEqual(errors.map((e) => [e.line, e.message]), [[4, `${STAGED_HEADING}: the | --- | separator row has 3 cell(s); expected 4 (GitHub renders a mismatched table as plain text)`]]);
});

test('parseStagedFields ends the section at a setext heading', () => {
  const doc = `### ${STAGED_HEADING}\n\nProse only.\n\nNext section\n------------\n\n| Row | Field | Contract | App adoption |\n|---|---|---|---|\n`;
  const { errors } = parseStagedFields(doc, STAGED_DOC, [pair()]);
  assert.deepEqual(errors.map((e) => [e.line, e.message.match(/no table follows the heading/)?.[0]]), [[1, 'no table follows the heading']]);
});

const stagedEntry = (field) => new Map([[field, { file: STAGED_DOC, line: 9, adoption: 'cloudlands-fe#1' }]]);

test('comparePair downgrades a staged daemon-first field to a warning', () => {
  const ts = TS_FULL.replace('  lastActivity?: string;\n', '');
  const diags = comparePair(pair(), RUST, ts, stagedEntry('lastActivity'));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 'warning');
  assert.match(formatDiagnostic(diags[0]), /^model\.rs:10: warning: Row → Row: staged daemon-first field Row\.lastActivity \(Rust last_activity\) is not in Row yet \(types\.ts:2-9\); app adoption pending: cloudlands-fe#1 \(docs\/protocol\/versioning\.md:9\)$/);
});

test('comparePair still fails an unstaged missing field next to a staged one', () => {
  const ts = TS_FULL.replace('  lastActivity?: string;\n', '').replace('  kind: number;\n', '');
  const diags = comparePair(pair(), RUST, ts, stagedEntry('lastActivity'));
  assert.deepEqual(diags.map((d) => [d.severity ?? 'error', d.message.match(/field Row\.(\w+)/)[1]]), [['warning', 'lastActivity'], ['error', 'kind']]);
});

test('comparePair warns when the TS type already declares a staged field', () => {
  const diags = comparePair(pair(), RUST, TS_FULL, stagedEntry('kind'));
  assert.equal(diags.length, 1);
  assert.match(formatDiagnostic(diags[0]), /^docs\/protocol\/versioning\.md:9: warning: Row → Row: stale staged field kind — Row now declares it \(types\.ts:6\); remove the row from the "Staged row fields \(app adoption pending\)" table$/);
});

test('comparePair warns when a staged field is not emitted (docs leading the pin)', () => {
  const diags = comparePair(pair(), RUST, TS_FULL, stagedEntry('upcoming'));
  assert.equal(diags.length, 1);
  assert.match(formatDiagnostic(diags[0]), /^docs\/protocol\/versioning\.md:9: warning: Row → Row: staged field upcoming is not emitted by Row; expected while its intentd change has not reached this checkout \(docs lead the pin\), otherwise remove the row \(or fix a misspelled Field\)$/);
});

test('runChecks fails when the staged table document is missing', async (t) => {
  const root = await fixture(t, {
    [STAGED_DOC]: null,
    'packages/intentd/.git': 'gitdir: x\n',
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: x\n',
    'packages/cloudlands-fe/types.ts': TS_FULL,
  });
  const result = await runChecks(root, [FIXTURE_PAIR]);
  assert.deepEqual(result.errors.map(formatDiagnostic), ['docs/protocol/versioning.md:1: error: cannot read the staged daemon-first field table: ENOENT']);
});

test('the real staged table parses against the real manifest', async () => {
  const doc = await fs.readFile(fileURLToPath(new URL(`../${STAGED_DOC}`, import.meta.url)), 'utf8');
  assert.deepEqual(parseStagedFields(doc).errors, []);
});


test('runChecks separates stale-ignore warnings from errors', async (t) => {
  const root = await fixture(t, {
    'packages/intentd/.git': 'gitdir: x\n',
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: x\n',
    'packages/cloudlands-fe/types.ts': TS_FULL,
  });
  const result = await runChecks(root, [{ ...FIXTURE_PAIR, ignore: { gone: 'reason', kind: 'reason' } }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checked, ['Row → Row']);
  assert.deepEqual(
    result.warnings.map((w) => [w.severity, w.file, w.line]),
    [['warning', 'packages/intentd/model.rs', 5], ['warning', 'packages/cloudlands-fe/types.ts', 6]],
  );
});

const run = promisify(execFile);
async function runCli(root, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, root, ...args], { env: cleanNodeEnv() });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

// The CLI reads the real PAIRS manifest, so the fixture root is derived from
// it: every Rust struct emits only `id` (plus `extraRust` on the first pair's
// struct) and every TS type declares only `id`, which makes each ignore entry
// stale (its field is no longer emitted).
function cliFixtureFiles(extraRust = '') {
  const files = { 'packages/intentd/.git': 'gitdir: x\n', 'packages/cloudlands-fe/.git': 'gitdir: x\n' };
  const staleCount = PAIRS.reduce((n, p) => n + Object.keys(p.ignore).length, 0);
  PAIRS.forEach((p, i) => {
    assert.ok(!Object.hasOwn(p.ignore, 'id'));
    files[p.rust.file] = (files[p.rust.file] ?? '') + `#[serde(rename_all = "camelCase")]\npub struct ${p.rust.struct} {\n    pub id: String,\n${i === 0 ? extraRust : ''}}\n\n`;
    files[p.ts.file] = (files[p.ts.file] ?? '') + `export interface ${p.ts.type} {\n  id: string;\n}\n\n`;
  });
  return { files, staleCount };
}

function workspaceCapabilityFixtureFiles({ canManage = false, memberCount = true } = {}) {
  const { files } = cliFixtureFiles();
  const { rust, ts } = PAIRS.find((p) => p.rust.struct === 'Workspace');
  files[rust.file] = files[rust.file].replace(
    'pub struct Workspace {\n',
    'pub struct Workspace {\n    #[serde(default, flatten, skip_serializing_if = "Option::is_none")]\n    pub membership: Option<WorkspaceMembership>,\n',
  );
  files[rust.file] += `#[serde(rename_all = "camelCase")]
pub struct WorkspaceMembership {
    #[serde(default)]
    pub can_manage: bool,
    pub member_count: u64,
}
`;
  files[ts.file] = `export interface Workspace {
  id: string;
${memberCount ? '  memberCount: number;\n' : ''}${canManage ? '  canManage?: boolean;\n' : ''}}
`;
  return files;
}

const STAGED_CAN_MANAGE = ['`Workspace`', '`canManage`', '[membership](./methods/shared-host-membership.md)', 'cloudlands-fe#2911'];

test('CLI: an undocumented daemon-first field fails against the pinned frontend', async (t) => {
  const root = await fixture(t, workspaceCapabilityFixtureFiles());
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1);
  assert.match(stderr, /: error: Workspace → Workspace: emitted field Workspace\.canManage \(Rust can_manage\) is missing from Workspace .*stage a daemon-first field in the "Staged row fields \(app adoption pending\)" table of docs\/protocol\/versioning\.md/);
  assert.match(stderr, /check-protocol-field-parity: 1 error\(s\)/);
});

test('CLI: a staged daemon-first field warns instead of failing, with no checker edit', async (t) => {
  const root = await fixture(t, { ...workspaceCapabilityFixtureFiles(), [STAGED_DOC]: stagedDoc([STAGED_CAN_MANAGE]) });
  const { code, stdout, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Protocol field parity holds .*Workspace → Workspace/);
  assert.match(stderr, /: warning: Workspace → Workspace: staged daemon-first field Workspace\.canManage \(Rust can_manage\) is not in Workspace yet .*app adoption pending: cloudlands-fe#2911 \(docs\/protocol\/versioning\.md:9\)/);
  assert.doesNotMatch(stderr, /: error: /);
});

test('CLI: a staged field does not excuse other missing workspace fields', async (t) => {
  const root = await fixture(t, { ...workspaceCapabilityFixtureFiles({ memberCount: false }), [STAGED_DOC]: stagedDoc([STAGED_CAN_MANAGE]) });
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1);
  assert.match(stderr, /: error: .*emitted field Workspace\.memberCount \(Rust member_count\) is missing from Workspace/);
  assert.match(stderr, /check-protocol-field-parity: 1 error\(s\)/);
  assert.doesNotMatch(stderr, /: error: .*Workspace\.canManage/);
});

test('CLI: frontend adoption of a staged field succeeds and warns to remove its docs row', async (t) => {
  const root = await fixture(t, { ...workspaceCapabilityFixtureFiles({ canManage: true }), [STAGED_DOC]: stagedDoc([STAGED_CAN_MANAGE]) });
  const { code, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.match(stderr, /^docs\/protocol\/versioning\.md:9: warning: Workspace → Workspace: stale staged field canManage — Workspace now declares it \(packages\/cloudlands-fe\/src\/shared\/types\.ts:4\); remove the row from the "Staged row fields \(app adoption pending\)" table$/m);
  assert.doesNotMatch(stderr, /: error: /);
});

test('CLI: a malformed staged table fails the check', async (t) => {
  const root = await fixture(t, { ...workspaceCapabilityFixtureFiles({ canManage: true }), [STAGED_DOC]: stagedDoc([['`Workspace`', '`canManage`', '', '']]) });
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1);
  assert.match(stderr, /^docs\/protocol\/versioning\.md:9: error: Staged row fields \(app adoption pending\): Workspace\.canManage needs a Markdown link to its Contract and the App adoption/m);
});

function scriptMonitorFixtureFiles({ scriptMonitors = false, prMonitors = true } = {}) {
  const { files } = cliFixtureFiles(`    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waiting_on_script_monitors: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waiting_on_pr_monitors: Vec<serde_json::Value>,
`);
  const { ts } = PAIRS.find((p) => p.rust.struct === 'AgentLite');
  files[ts.file] = `export interface AgentSession {
  id: string;
${prMonitors ? '  waitingOnPrMonitors?: { monitorId: string }[];\n' : ''}${scriptMonitors ? '  waitingOnScriptMonitors?: { monitorId: string; scriptId: string; runId: string; scriptName: string; expiresAt: string }[];\n' : ''}}
`;
  return files;
}

test('CLI: missing AgentLite.waitingOnScriptMonitors is rejected after frontend adoption', async (t) => {
  const root = await fixture(t, scriptMonitorFixtureFiles());
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /emitted field AgentLite\.waitingOnScriptMonitors \(Rust waiting_on_script_monitors\) is missing from AgentSession/);
  assert.match(stderr, /check-protocol-field-parity: 1 error\(s\)/);
});

test('CLI: adopted script monitors still reject another missing optional agent field', async (t) => {
  const root = await fixture(t, scriptMonitorFixtureFiles({ scriptMonitors: true, prMonitors: false }));
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1);
  assert.match(stderr, /emitted field AgentLite\.waitingOnPrMonitors \(Rust waiting_on_pr_monitors\) is missing from AgentSession/);
  assert.match(stderr, /check-protocol-field-parity: 1 error\(s\)/);
  assert.doesNotMatch(stderr, /emitted field AgentLite\.waitingOnScriptMonitors/);
});

test('CLI: adopted script monitors pass without a retired manifest warning', async (t) => {
  const root = await fixture(t, scriptMonitorFixtureFiles({ scriptMonitors: true }));
  const { code, stdout, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Protocol field parity holds .*AgentLite → AgentSession/);
  assert.doesNotMatch(stderr, /: error: |stale ignore entry waitingOnScriptMonitors/);
});

test('CLI: daemon without script monitors has no retired manifest warning', async (t) => {
  const { files } = cliFixtureFiles();
  const root = await fixture(t, files);
  const { code, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /: error: |stale ignore entry waitingOnScriptMonitors/);
});

test('CLI: stale ignore entries print warnings to stderr and exit 0', async (t) => {
  const { files, staleCount } = cliFixtureFiles();
  const root = await fixture(t, files);
  const { code, stdout, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.ok(staleCount > 0);
  assert.equal(stderr.match(/^.*: warning: .*stale ignore entry .*; remove the entry from PAIRS$/gm)?.length, staleCount, stderr);
  assert.doesNotMatch(stderr, /: error: /);
  assert.match(stdout, new RegExp(`^Protocol field parity holds for ${PAIRS.length} pair\\(s\\): .* ${staleCount} warning\\(s\\): stale ignore entries`, 'm'));
});

test('CLI: a missing field still exits 1 with an error', async (t) => {
  const { files, staleCount } = cliFixtureFiles('    pub parent_agent_id: String,\n');
  const root = await fixture(t, files);
  const { code, stderr } = await runCli(root);
  assert.equal(code, 1);
  const [{ rust, ts }] = PAIRS;
  assert.match(stderr, new RegExp(`^${rust.file.replace(/[./]/g, '\\$&')}:4: error: ${rust.struct} → ${ts.type}: emitted field ${rust.struct}\\.parentAgentId \\(Rust parent_agent_id\\) is missing from ${ts.type}`, 'm'));
  assert.match(stderr, new RegExp(`^check-protocol-field-parity: 1 error\\(s\\), ${staleCount} warning\\(s\\): stale ignore entries, staged daemon-first fields or pin drift$`, 'm'));
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
const SUBMODULES = ['packages/intentd', 'packages/cloudlands-fe'];

// The CLI fixture with both packages as nested git repos recorded as the monorepo gitlinks.
// `advance()` commits an extra emitted field in intentd so that checkout moves off its pin.
async function makeGitRoot(t) {
  const { files, staleCount } = cliFixtureFiles();
  for (const dir of SUBMODULES) delete files[`${dir}/.git`];
  const root = await fixture(t, files);
  const pins = {};
  for (const dir of SUBMODULES) {
    git(path.join(root, dir), 'init', '-q', '-b', 'main');
    git(path.join(root, dir), 'add', '.');
    git(path.join(root, dir), 'commit', '-q', '-m', 'pin');
    pins[dir] = git(path.join(root, dir), 'rev-parse', 'HEAD');
  }
  git(root, 'init', '-q', '-b', 'main');
  for (const dir of SUBMODULES) git(root, 'update-index', '--add', '--cacheinfo', `160000,${pins[dir]},${dir}`);
  git(root, 'commit', '-q', '-m', 'monorepo');
  const advance = async () => {
    const [{ rust }] = PAIRS;
    const file = path.join(root, rust.file);
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace(`pub struct ${rust.struct} {\n`, `pub struct ${rust.struct} {\n    pub parent_agent_id: String,\n`));
    git(path.join(root, 'packages/intentd'), 'commit', '-q', '-am', 'ahead of the pin');
    return git(path.join(root, 'packages/intentd'), 'rev-parse', 'HEAD');
  };
  return { root, pins, staleCount, advance };
}

const bannerOf = (dir, checkout, pin) => `check-protocol-field-parity: ${path.basename(dir)} sources from ${dir} checkout ${checkout.slice(0, 7)} (recorded pin ${pin.slice(0, 7)})`;

// Copy the real entry point and its script dependencies, not a stand-in recipe.
async function makeRoutingRoot(t) {
  const setup = await makeGitRoot(t);
  await fs.mkdir(path.join(setup.root, 'scripts/lib'), { recursive: true });
  for (const file of ['Makefile', 'scripts/check-protocol-field-parity.mjs', 'scripts/submodule-ref.mjs', 'scripts/lib/markdown-tables.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(setup.root, file));
  }
  return setup;
}

async function runMake(root, ...args) {
  try {
    const { stdout, stderr } = await run('make', ['--no-print-directory', 'check-protocol-field-parity', ...args], {
      cwd: root, env: { ...cleanNodeEnv(), MAKEFLAGS: '', MFLAGS: '', MAKEOVERRIDES: '' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('real Makefile routes INTENTD_DIR to the selected daemon worktree', async (t) => {
  const { root } = await makeRoutingRoot(t);
  const baseline = await runMake(root);
  assert.equal(baseline.code, 0, baseline.stderr);
  assert.match(baseline.stdout, /Protocol field parity holds for 2 pair\(s\)/);
  const selected = '.intent/worktrees/daemon-candidate';
  git(path.join(root, 'packages/intentd'), 'worktree', 'add', '--detach', path.join(root, selected), 'HEAD');
  const rustFile = path.join(selected, path.relative('packages/intentd', PAIRS[0].rust.file));
  const source = await fs.readFile(path.join(root, rustFile), 'utf8');
  await fs.writeFile(path.join(root, rustFile), source.replace('    pub id: String,', '    pub id: String,\n    pub candidate_only: String,'));
  const result = await runMake(root, `INTENTD_DIR=${selected}`);
  assert.equal(result.code, 2, `selected daemon must fail instead of checking the valid default pair:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stderr.includes(`${rustFile}:4: error:`), result.stderr);
  assert.match(result.stderr, /emitted field AgentLite\.candidateOnly/);
});

const COMPONENTS = [
  { sub: 'packages/intentd', flag: '--intentd-dir', variable: 'INTENTD_DIR', side: 'rust' },
  { sub: 'packages/cloudlands-fe', flag: '--fe-dir', variable: 'FE_DIR', side: 'ts' },
];

for (const { sub, flag, side } of COMPONENTS) {
  for (const absolute of [false, true]) {
    test(`CLI selects ${absolute ? 'absolute' : 'relative'} ${sub} worktrees with canonical pin provenance`, async (t) => {
      const { root, pins, staleCount } = await makeGitRoot(t);
      const relative = `.intent/worktrees/${side}-candidate`;
      const selected = absolute ? path.join(root, relative) : relative;
      const worktree = path.resolve(root, selected);
      git(path.join(root, sub), 'worktree', 'add', '--detach', worktree, 'HEAD');
      assert.ok((await fs.stat(path.join(worktree, '.git'))).isFile(), 'a genuine git worktree uses a .git file');
      const expectedBanner = (head, dirty) => `check-protocol-field-parity: ${path.basename(sub)} sources from ${selected} checkout ${head.slice(0, 7)}${dirty ? ' (dirty)' : ''} (recorded pin ${pins[sub].slice(0, 7)})`;
      const baseline = await runCli(root, flag, selected);
      assert.equal(baseline.code, 0, baseline.stderr);
      assert.ok(baseline.stdout.split('\n').includes(expectedBanner(pins[sub], false)), baseline.stdout);
      assert.equal(baseline.stderr.match(/stale ignore entry/g)?.length, staleCount);
      assert.doesNotMatch(baseline.stderr, /is off the recorded pin|uncommitted changes/);

      const file = path.join(selected, path.relative(sub, PAIRS[0][side].file));
      const source = await fs.readFile(path.resolve(root, file), 'utf8');
      await fs.writeFile(path.resolve(root, file), side === 'rust'
        ? source.replace('    pub id: String,', '    pub id: String,\n    pub candidate_only: String,')
        : source.replace('  id: string;\n', ''));
      const dirty = await runCli(root, flag, selected);
      assert.equal(dirty.code, 1, dirty.stderr);
      assert.ok(dirty.stdout.split('\n').includes(expectedBanner(pins[sub], true)), dirty.stdout);
      const remedy = `Run git submodule update --checkout ${sub} and rerun without component overrides to compare against the pin.`;
      assert.ok(dirty.stderr.split('\n').includes(`warning: ${selected} checkout ${pins[sub].slice(0, 7)} has uncommitted changes; results reflect the working tree, not the recorded pin ${pins[sub].slice(0, 7)}. ${remedy}`), dirty.stderr);
      if (side === 'rust') {
        assert.ok(dirty.stderr.includes(`${file}:4: error: AgentLite → AgentSession: emitted field AgentLite.candidateOnly`), dirty.stderr);
        assert.ok(dirty.stderr.includes(`(${PAIRS[0].ts.file}:1-3)`), dirty.stderr);
        assert.ok(dirty.stderr.includes(`${file}:2: warning: AgentLite → AgentSession: stale ignore entry`), dirty.stderr);
      } else {
        assert.ok(dirty.stderr.includes(`${PAIRS[0].rust.file}:3: error: AgentLite → AgentSession: emitted field AgentLite.id`), dirty.stderr);
        assert.ok(dirty.stderr.includes(`(${file}:1-2)`), dirty.stderr);
      }
      assert.doesNotMatch(dirty.stdout, /skipped:/);
      assert.equal((await runCli(root)).code, 0, 'the valid default pair was not modified');

      git(worktree, 'commit', '-q', '-am', 'candidate sources');
      const head = git(worktree, 'rev-parse', 'HEAD');
      assert.notEqual(head, pins[sub]);
      const committed = await runCli(root, flag, selected);
      assert.equal(committed.code, 1, committed.stderr);
      assert.ok(committed.stdout.split('\n').includes(expectedBanner(head, false)), committed.stdout);
      assert.ok(committed.stderr.split('\n').includes(`warning: ${selected} checkout ${head.slice(0, 7)} is off the recorded pin ${pins[sub].slice(0, 7)}; results reflect the checkout, not the pin. ${remedy}`), committed.stderr);
      assert.ok(!committed.stderr.includes(`git submodule update --checkout ${selected}`), committed.stderr);
    });
  }
}

test('real Makefile routes FE_DIR and both selected roots, including paths with spaces', async (t) => {
  const { root } = await makeRoutingRoot(t);
  const intentd = '.intent/worktrees/daemon candidate';
  const fe = path.join(root, '.intent/worktrees/frontend candidate');
  for (const [sub, selected] of [['packages/intentd', intentd], ['packages/cloudlands-fe', fe]]) {
    git(path.join(root, sub), 'worktree', 'add', '--detach', path.resolve(root, selected), 'HEAD');
  }
  const rustFile = path.resolve(root, intentd, path.relative('packages/intentd', PAIRS[0].rust.file));
  const tsFile = path.join(fe, path.relative('packages/cloudlands-fe', PAIRS[0].ts.file));
  const rustSource = await fs.readFile(rustFile, 'utf8');
  const tsSource = await fs.readFile(tsFile, 'utf8');
  await fs.writeFile(tsFile, tsSource.replace('  id: string;\n', ''));
  const frontendOnly = await runMake(root, `FE_DIR=${fe}`);
  assert.equal(frontendOnly.code, 2, frontendOnly.stdout);
  assert.ok(frontendOnly.stderr.includes(`(${tsFile}:1-2)`), frontendOnly.stderr);
  await fs.writeFile(rustFile, rustSource.replace('    pub id: String,', '    pub id: String,\n    pub candidate_only: String,'));
  await fs.writeFile(tsFile, tsSource.replace('  id: string;', '  id: string;\n  candidateOnly: string;'));
  assert.equal((await runMake(root, `INTENTD_DIR=${intentd}`)).code, 2);
  const both = await runMake(root, `INTENTD_DIR=${intentd}`, `FE_DIR=${fe}`);
  assert.equal(both.code, 0, both.stderr);
  assert.match(both.stdout, /Protocol field parity holds for 2 pair\(s\)/);
});

for (const { sub, flag, variable, side } of COMPONENTS) {
  for (const metadata of ['dangling', 'corrupt', 'unborn', 'wrong-root']) {
    test(`explicit ${sub} rejects ${metadata} Git metadata through CLI and Make`, async (t) => {
      const { root } = await makeRoutingRoot(t);
      const selected = `.intent/worktrees/${side}-${metadata}`;
      const selectedRoot = path.join(root, selected);
      await fs.mkdir(selectedRoot, { recursive: true });
      for (const file of new Set(PAIRS.map((pair) => pair[side].file))) {
        const dest = path.join(selectedRoot, path.relative(sub, file));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(path.join(root, file), dest);
      }
      if (metadata === 'unborn') {
        git(selectedRoot, 'init', '-q', '-b', 'main');
        assert.throws(() => git(selectedRoot, 'rev-parse', 'HEAD'));
      } else if (metadata === 'wrong-root') {
        const canonical = path.join(root, sub);
        git(canonical, 'config', 'core.worktree', canonical);
        await fs.writeFile(path.join(selectedRoot, '.git'), `gitdir: ${canonical}/.git\n`);
        assert.equal(git(selectedRoot, 'rev-parse', '--show-toplevel'), canonical);
      } else {
        const marker = metadata === 'dangling' ? `gitdir: ${root}/nonexistent-git-dir\n` : 'not valid Git metadata\n';
        await fs.writeFile(path.join(selectedRoot, '.git'), marker);
        assert.throws(() => git(selectedRoot, 'rev-parse', 'HEAD'));
      }
      // Run both entry points before asserting so the red evidence covers both.
      const cli = await runCli(root, flag, selected);
      const make = await runMake(root, `${variable}=${selected}`);
      assert.deepEqual([cli.code, make.code], [1, 2], `invalid selected ${sub} must fail both entry points:\n${cli.stdout}\n${make.stdout}`);
      for (const result of [cli, make]) {
        assert.ok(result.stderr.includes(`selected ${sub} root ${selected} is not a repository root with a readable HEAD`), result.stderr);
        assert.doesNotMatch(result.stdout, /skipped:|Protocol field parity holds/);
      }
      assert.equal((await runCli(root)).code, 0, 'omitted overrides still check the valid default pair');
    });
  }

  test(`explicit invalid or missing ${sub} roots fail instead of skipping or falling back`, async (t) => {
    const { root } = await makeRoutingRoot(t);
    const plain = '.intent/not-a-checkout';
    await fs.mkdir(path.join(root, plain), { recursive: true });
    const regularFile = '.intent/not-a-directory';
    await fs.writeFile(path.join(root, regularFile), 'not a directory');
    for (const selected of ['', '.intent/missing', plain, regularFile]) {
      const cli = await runCli(root, flag, selected);
      assert.equal(cli.code, 1, `${flag}=${selected}: ${cli.stdout}`);
      assert.ok(cli.stderr.includes(`selected ${sub} root`), cli.stderr);
      assert.doesNotMatch(cli.stdout, /skipped:|Protocol field parity holds/);
      const make = await runMake(root, `${variable}=${selected}`);
      assert.equal(make.code, 2, `${variable}=${selected}: ${make.stdout}`);
      assert.doesNotMatch(make.stdout, /Protocol field parity holds/);
    }
    // A chosen checkout can exist while the manifest source is missing or unreadable.
    const selected = `.intent/worktrees/${side}-incomplete`;
    git(path.join(root, sub), 'worktree', 'add', '--detach', path.join(root, selected), 'HEAD');
    const file = path.join(selected, path.relative(sub, PAIRS[0][side].file));
    await fs.rm(path.join(root, file));
    const missing = await runCli(root, flag, selected);
    assert.equal(missing.code, 1);
    assert.ok(missing.stderr.includes(`${file}:1: error: manifest path ${file} does not exist`), missing.stderr);
    assert.doesNotMatch(missing.stdout, /skipped:|Protocol field parity holds/);
    assert.equal((await runMake(root, `${variable}=${selected}`)).code, 2);
    await fs.mkdir(path.join(root, file));
    const invalidFile = await runCli(root, flag, selected);
    assert.equal(invalidFile.code, 1);
    assert.ok(invalidFile.stderr.includes(`${file}:1: error: cannot read manifest path ${file}: EISDIR`), invalidFile.stderr);

    // Explicitly selecting the absent canonical checkout is an error too; only
    // omission of the override retains the optional-submodule skip behavior.
    await fs.rm(path.join(root, sub), { recursive: true });
    const defaults = await runCli(root);
    assert.equal(defaults.code, 0, defaults.stderr);
    assert.match(defaults.stdout, /skipped:.*submodule not initialized/);
    const explicitDefault = await runCli(root, flag, sub);
    assert.equal(explicitDefault.code, 1);
    assert.doesNotMatch(explicitDefault.stdout, /skipped:|Protocol field parity holds/);
  });
}

test('fixtures outside any git repository yield unknown refs: no banner, no warning', async (t) => {
  const root = await fixture(t, {
    'packages/intentd/.git': 'gitdir: x\n',
    'packages/intentd/model.rs': RUST,
    'packages/cloudlands-fe/.git': 'gitdir: x\n',
    'packages/cloudlands-fe/types.ts': TS_FULL,
  });
  const result = await runChecks(root, [FIXTURE_PAIR]);
  assert.deepEqual(result.refs, SUBMODULES.map((dir) => ({ source: 'checkout', dir, checkout: null, pin: null })));
  for (const ref of result.refs) {
    assert.equal(formatRefBanner(ref), null);
    assert.equal(formatRefOffPinWarning(ref), null);
  }
  const skipped = await runChecks(root, [{ ...FIXTURE_PAIR, ts: { file: 'packages/ios/Types.ts', type: 'Row' } }]);
  assert.deepEqual(skipped.refs, [], 'a skipped pair reads nothing, so no ref is reported');
});

test('at the pins: one banner per submodule names checkout == pin on stdout, no off-pin warning, exit code unchanged', async (t) => {
  const { root, pins, staleCount } = await makeGitRoot(t);
  const result = await runChecks(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.refs, SUBMODULES.map((dir) => ({ source: 'checkout', dir, checkout: pins[dir], pin: pins[dir], dirty: false })));
  for (const ref of result.refs) assert.equal(formatRefOffPinWarning(ref), null);
  const { code, stdout, stderr } = await runCli(root);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.startsWith(SUBMODULES.map((dir) => bannerOf(dir, pins[dir], pins[dir]) + '\n').join('')), stdout);
  assert.doesNotMatch(stderr, /is off the recorded pin/);
  assert.equal(stderr.match(/stale ignore entry/g)?.length, staleCount, 'the stale-ignore warnings are unchanged');
});

test('off the intentd pin: the intentd banner names both SHAs, its stderr warning leads, results reflect the checkout, exit code unchanged', async (t) => {
  const { root, pins, advance } = await makeGitRoot(t);
  const head = await advance();
  assert.notEqual(head, pins['packages/intentd']);
  const result = await runChecks(root);
  assert.deepEqual(result.refs, [
    { source: 'checkout', dir: 'packages/intentd', checkout: head, pin: pins['packages/intentd'], dirty: false },
    { source: 'checkout', dir: 'packages/cloudlands-fe', checkout: pins['packages/cloudlands-fe'], pin: pins['packages/cloudlands-fe'], dirty: false },
  ]);
  assert.equal(result.errors.length, 1, 'the checkout source (with the extra field) is what was compared');
  assert.match(result.errors[0].message, /parentAgentId/);
  assert.equal(formatRefOffPinWarning(result.refs[1]), null, 'the cloudlands-fe checkout is still at its pin');
  const warning = `warning: packages/intentd checkout ${head.slice(0, 7)} is off the recorded pin ${pins['packages/intentd'].slice(0, 7)}; results reflect the checkout, not the pin. Run git submodule update --checkout packages/intentd to compare against the pin.\n`;
  const { code, stdout, stderr } = await runCli(root);
  assert.equal(code, 1);
  assert.equal(stdout, `${bannerOf('packages/intentd', head, pins['packages/intentd'])}\n${bannerOf('packages/cloudlands-fe', pins['packages/cloudlands-fe'], pins['packages/cloudlands-fe'])}\n`);
  assert.ok(stderr.startsWith(warning), stderr);
  assert.equal(stderr.match(/is off the recorded pin/g).length, 1, 'only the moved submodule warns');
  assert.match(stderr, /parentAgentId/);
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

// ---- Off-pin checkouts: the comparison monorepo-consumer-checks makes ----
//
// The upstream job checks out monorepo main, puts the PR head in place of its
// component and the other component at main's pin. A local monorepo worktree
// older than main lacks main's staged rows and pins, so `--base <ref>` re-runs
// a missing field against <ref> when a component checkout is off its pin.

const AGENT_PARENT_ROW = ['`AgentLite`', '`parentAgentId`', '[agents](./methods/agents.md)', 'cloudlands-fe#1'];

// Record a commit as `refs/remotes/origin/main` on top of the monorepo HEAD
// without touching the worktree: `files` replaces blobs (an empty staged table
// by default), `gitlinks` moves pins.
function makeBase(root, { files: overrides = {}, gitlinks = {} } = {}) {
  const files = { [STAGED_DOC]: stagedDoc(), ...overrides };
  const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(root, '.git', 'base-index') };
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  g('read-tree', 'HEAD');
  for (const [file, content] of Object.entries(files)) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, encoding: 'utf8', env, input: content }).trim();
    g('update-index', '--add', '--cacheinfo', `100644,${blob},${file}`);
  }
  for (const [dir, sha] of Object.entries(gitlinks)) g('update-index', '--add', '--cacheinfo', `160000,${sha},${dir}`);
  const commit = g('commit-tree', g('write-tree'), '-p', 'HEAD', '-m', 'origin/main');
  git(root, 'update-ref', 'refs/remotes/origin/main', commit);
  return commit;
}

// Commit `edit(source)` to a submodule file, then return the checkout to `back`
// so the commit exists only as an object (a newer pin the checkout has not reached).
async function commitUnchecked(root, dir, file, edit, back) {
  const abs = path.join(root, file);
  await fs.writeFile(abs, edit(await fs.readFile(abs, 'utf8')));
  git(path.join(root, dir), 'commit', '-q', '-am', 'newer main');
  const sha = git(path.join(root, dir), 'rev-parse', 'HEAD');
  git(path.join(root, dir), 'checkout', '-q', back);
  return sha;
}

test('off the intentd pin: a field origin/main stages is a pin-drift warning, not an error', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  const head = await advance();
  const base = makeBase(root, { files: { [STAGED_DOC]: stagedDoc([AGENT_PARENT_ROW]) }, gitlinks: { 'packages/intentd': head } });
  const strict = await runCli(root);
  assert.equal(strict.code, 1, 'without --base the local comparison stays strict');
  assert.doesNotMatch(strict.stderr, /pin drift:|^note: /m);
  const result = await runChecks(root, PAIRS, { base: 'origin/main' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.drift.status, 'compared');
  const { code, stdout, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Protocol field parity holds for 2 pair\(s\)/);
  assert.match(stderr, new RegExp(`: warning: AgentLite → AgentSession: pin drift: emitted field AgentLite\\.parentAgentId \\(Rust parent_agent_id\\) is missing locally but passes against origin/main \\(${base.slice(0, 7)}\\), the comparison monorepo-consumer-checks makes: staged in origin/main:docs/protocol/versioning\\.md\\.`));
  assert.match(stderr, /This monorepo worktree is older than origin\/main; rebase it onto origin\/main to compare locally\.$/m);
  assert.doesNotMatch(stderr, /: error: /);
});

test('off the intentd pin: a field the checkout introduces still fails against origin/main', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  const head = await advance();
  const base = makeBase(root, { gitlinks: { 'packages/intentd': head } });
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.match(stderr, /: error: AgentLite → AgentSession: emitted field AgentLite\.parentAgentId \(Rust parent_agent_id\) is missing from AgentSession/);
  assert.match(stderr, new RegExp(`^note: the missing field\\(s\\) above also fail against origin/main \\(${base.slice(0, 7)}\\), the comparison monorepo-consumer-checks makes, so they come from the component checkout, not from newer main\\. If origin/main is stale, run git fetch origin main and rerun\\.$`, 'm'));
  assert.doesNotMatch(stderr, /pin drift:/);
});

test('off the intentd pin: a field the frontend at origin/main\'s pin declares is a pin-drift warning', async (t) => {
  const { root, pins, advance } = await makeGitRoot(t);
  const head = await advance();
  const fe = 'packages/cloudlands-fe';
  const { ts } = PAIRS[0];
  const adopted = await commitUnchecked(root, fe, ts.file, (s) => s.replace(`export interface ${ts.type} {\n`, `export interface ${ts.type} {\n  parentAgentId?: string;\n`), pins[fe]);
  makeBase(root, { gitlinks: { 'packages/intentd': head, [fe]: adopted } });
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 0, stderr);
  assert.match(stderr, new RegExp(`pin drift: emitted field AgentLite\\.parentAgentId .*: declared by AgentSession at origin/main's cloudlands-fe pin ${adopted.slice(0, 7)}\\.`));
});

test('off the intentd pin: an origin/main frontend pin missing from the local clone falls back to the checkout and says so', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  const head = await advance();
  const absent = 'f'.repeat(40);
  makeBase(root, { files: { [STAGED_DOC]: stagedDoc() }, gitlinks: { 'packages/intentd': head, 'packages/cloudlands-fe': absent } });
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.ok(stderr.includes(`note: origin/main's packages/cloudlands-fe pin ${absent.slice(0, 7)} is not in the local clone; its checkout was compared instead (git -C packages/cloudlands-fe fetch origin to compare against it).`), stderr);
});

test('off the intentd pin: an unresolvable base skips the comparison with a fetch hint', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  await advance();
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.match(stderr, /^note: the comparison against origin\/main that monorepo-consumer-checks makes was skipped: origin\/main does not resolve to a commit\. If the missing field\(s\) above came from newer component main, run git fetch origin main and rerun\.$/m);
});

test('a base equal to HEAD (the upstream job) changes nothing', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  await advance();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const result = await runChecks(root, PAIRS, { base: 'origin/main' });
  assert.equal(result.drift.status, 'base-is-head');
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /pin drift:|^note: /m);
});

test('at the pins: a missing field stays an error even when origin/main stages it', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  const head = await advance();
  git(root, 'update-index', '--cacheinfo', `160000,${head},packages/intentd`);
  git(root, 'commit', '-q', '-m', 'bump intentd');
  makeBase(root, { files: { [STAGED_DOC]: stagedDoc([AGENT_PARENT_ROW]) } });
  const result = await runChecks(root, PAIRS, { base: 'origin/main' });
  assert.equal(result.drift.status, 'at-pins');
  assert.equal(result.errors.length, 1);
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /pin drift:|^note: /m);
});

test('the pin-drift comparison never excuses a non-field error', async (t) => {
  const { root, advance } = await makeGitRoot(t);
  const head = await advance();
  makeBase(root, { files: { [STAGED_DOC]: stagedDoc([AGENT_PARENT_ROW]) }, gitlinks: { 'packages/intentd': head } });
  await fs.writeFile(path.join(root, STAGED_DOC), stagedDoc([['`AgentLite`', '`parentAgentId`', 'no link', '']]));
  const { code, stderr } = await runCli(root, '--base', 'origin/main');
  assert.equal(code, 1);
  assert.match(stderr, /needs a Markdown link to its Contract/);
});

// ---- The real Makefile: PARITY_BASE and make check deferral ----

async function runMakeArgs(root, args, env = {}) {
  const base = cleanNodeEnv({ MAKEFLAGS: '', MFLAGS: '', MAKEOVERRIDES: '' });
  delete base.CI;
  Object.assign(base, env);
  try {
    const { stdout, stderr } = await run('make', ['--no-print-directory', ...args], { cwd: root, env: base });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('real Makefile: PARITY_BASE defaults to origin/main locally, is off under CI, and PARITY_BASE= keeps the strict comparison', async (t) => {
  const { root, advance } = await makeRoutingRoot(t);
  const head = await advance();
  makeBase(root, { files: { [STAGED_DOC]: stagedDoc([AGENT_PARENT_ROW]) }, gitlinks: { 'packages/intentd': head } });
  const local = await runMakeArgs(root, ['check-protocol-field-parity']);
  assert.equal(local.code, 0, local.stderr);
  assert.match(local.stderr, /: warning: AgentLite → AgentSession: pin drift: emitted field AgentLite\.parentAgentId/);
  const strict = await runMakeArgs(root, ['check-protocol-field-parity', 'PARITY_BASE=']);
  assert.equal(strict.code, 2, strict.stderr);
  assert.doesNotMatch(strict.stderr, /pin drift:/);
  const ci = await runMakeArgs(root, ['check-protocol-field-parity'], { CI: 'true' });
  assert.equal(ci.code, 2, ci.stderr);
  assert.doesNotMatch(ci.stderr, /pin drift:/);
});

// Stand-ins for fmt / clippy: RUST_CHECK_TARGETS on the command line replaces
// the real lints, so the test exercises the real check recipe without cargo.
const STAND_IN_MK = 'stand-in-lint:\n\t@echo stand-in-lint ran\n';

test('real Makefile: make check runs the remaining steps after a parity failure and fails at the end', async (t) => {
  const { root, advance } = await makeRoutingRoot(t);
  await advance();
  await fs.writeFile(path.join(root, 'stand-in.mk'), STAND_IN_MK);
  const goals = ['-f', 'Makefile', '-f', 'stand-in.mk', 'RUST_CHECK_TARGETS=check-protocol-field-parity stand-in-lint', 'PARITY_BASE='];
  const failed = await runMakeArgs(root, [...goals, 'check']);
  assert.equal(failed.code, 2, failed.stderr);
  assert.match(failed.stderr, /: error: AgentLite → AgentSession: emitted field AgentLite\.parentAgentId/);
  assert.match(failed.stderr, /make check: check-protocol-field-parity failed; continuing with the remaining check steps, check fails at the end/);
  assert.match(failed.stdout, /^stand-in-lint ran$/m, 'the lints after parity still ran');
  assert.match(failed.stderr, /make check: FAILED: check-protocol-field-parity \(output above\); every other check step passed/);
  await assert.rejects(fs.stat(path.join(root, '.dev/check-deferred')), 'the record is cleared after the report');

  const standalone = await runMakeArgs(root, [...goals, 'check-protocol-field-parity', 'stand-in-lint']);
  assert.equal(standalone.code, 2);
  assert.doesNotMatch(standalone.stdout, /stand-in-lint ran/, 'outside check / gate the parity failure stops make');
  assert.doesNotMatch(standalone.stderr, /continuing with the remaining check steps/);

  git(path.join(root, 'packages/intentd'), 'checkout', '-q', 'HEAD~1');
  const clean = await runMakeArgs(root, [...goals, 'check']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /^stand-in-lint ran$/m);
  assert.doesNotMatch(clean.stderr, /make check: FAILED/);
});

test('a field that only passes because origin/main\'s older daemon pin does not emit it stays an error', async (t) => {
  const { root, pins, advance } = await makeGitRoot(t);
  const head = await advance();
  git(root, 'update-index', '--cacheinfo', `160000,${head},packages/intentd`);
  git(root, 'commit', '-q', '-m', 'this branch bumps intentd');
  makeBase(root, { gitlinks: { 'packages/intentd': pins['packages/intentd'] } });
  const tsFile = path.join(root, PAIRS[1].ts.file);
  await fs.writeFile(tsFile, (await fs.readFile(tsFile, 'utf8')).replace('  id: string;\n', '  id: string;\n  feOnly?: string;\n'));
  const result = await runChecks(root, PAIRS, { base: 'origin/main' });
  assert.equal(result.drift.status, 'compared', 'the dirty frontend checkout is the moved component');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /emitted field AgentLite\.parentAgentId/);
  assert.doesNotMatch(result.warnings.map((w) => w.message).join('\n'), /pin drift:/);
});
