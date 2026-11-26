import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, folderLists } from './check-provider-profile-bases.mjs';

const DOC = `
| Base | Credentials (auto-mark) | Account folder | Launch-only step for a key profile |
| --- | --- | --- | --- |
| \`codex\` | \`CODEX_API_KEY\`, \`OPENAI_API_KEY\` | \`CODEX_HOME\` | [Codex API key](#codex-api-key) |
| \`droid\` | \`FACTORY_API_KEY\` | none | none (the key beats a stored login) |

| Key or pattern | Why |
| --- | --- |
| \`PATH\` | Launch rewrites it. |
| \`INITIAL_AGENT_MODE\` | \`codex\` only: Intent sets the permission mode. |
| \`DROID_TELEMETRY\` | \`droid\` only: Intent turns telemetry off. |
`;

const profile = (overrides) => ({ credentialKeys: [], accountDirKeys: [], apiKeyHome: null, credentialLaunchEnv: [], reservedKeys: [], ...overrides });
const GOLDEN = {
  providers: [
    { id: 'codex', profile: profile({ credentialKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], accountDirKeys: ['CODEX_HOME'], apiKeyHome: { key: 'CODEX_API_KEY' }, reservedKeys: ['INITIAL_AGENT_MODE'] }) },
    { id: 'opencode', profile: null },
    { id: 'droid', profile: profile({ credentialKeys: ['FACTORY_API_KEY'], reservedKeys: ['DROID_TELEMETRY'] }) },
  ],
};
const withProvider = (row) => ({ providers: [...GOLDEN.providers, row] });

test('matching docs and golden pass without warnings', () => {
  assert.deepEqual(compare({ markdown: DOC, golden: GOLDEN }), { errors: [], warnings: [], bases: 2 });
});

test('a new profile base in the golden fails naming the table', () => {
  const { errors } = compare({ markdown: DOC, golden: withProvider({ id: 'fake', profile: profile({ credentialKeys: ['FAKE_KEY'], accountDirKeys: ['FAKE_HOME'] }) }) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"Profile-capable bases" table: profile base fake has no row/);
  assert.match(errors[0], /FAKE_KEY.*FAKE_HOME/);
});

test('a credential, account folder or launch step the table lacks fails', () => {
  const golden = structuredClone(GOLDEN);
  golden.providers[2].profile.credentialKeys.push('FACTORY_TOKEN');
  golden.providers[2].profile.accountDirKeys.push('FACTORY_HOME');
  golden.providers[2].profile.credentialLaunchEnv.push(['FACTORY_STORE', 'memory']);
  const { errors } = compare({ markdown: DOC, golden });
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /droid \(line \d+\): credentials lacks FACTORY_TOKEN/);
  assert.match(errors[1], /droid \(line \d+\): account folder lacks FACTORY_HOME/);
  assert.match(errors[2], /droid \(line \d+\): the registry has a launch-only step/);
});

test('a docs-only base, key or step warns because the docs lead an addition', () => {
  const markdown = DOC
    .replace('| `droid` | `FACTORY_API_KEY` |', '| `droid` | `FACTORY_API_KEY`, `FACTORY_TOKEN` |')
    .replace('| none | none (the key', '| `FACTORY_HOME` | [Droid](#droid) (the key')
    .replace('| `DROID_TELEMETRY` |', '| `DROID_TELEMETRY`, `DROID_DEBUG` |')
    .replace('\n\n| Key', '\n| `newbase` | `NEW_KEY` | none | none |\n\n| Key');
  const { errors, warnings } = compare({ markdown, golden: GOLDEN });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 5, warnings.join('\n'));
  assert.ok(warnings.every((warning) => warning.includes('pending; the docs lead')));
});

test('a base-only reserved key without its marked row fails', () => {
  const { errors } = compare({ markdown: DOC.replace('`droid` only:', 'Droid only:'), golden: GOLDEN });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"Reserved keys" table: DROID_TELEMETRY is reserved for droid only; add a row whose reason starts with "`droid` only:"/);
});

test('a reshaped golden fails instead of turning every row into a warning', () => {
  const renamed = { providers: GOLDEN.providers.map(({ profile, ...row }) => ({ ...row, profileSpec: profile })) };
  assert.throws(() => compare({ markdown: DOC, golden: renamed }), /codex: row has an unknown shape/);
  const noHome = structuredClone(GOLDEN);
  delete noHome.providers[0].profile.apiKeyHome;
  assert.throws(() => compare({ markdown: DOC, golden: noHome }), /codex: profile has an unknown shape/);
  assert.throws(() => compare({ markdown: DOC, golden: { providers: [{ id: 'opencode', profile: null }] } }), /no provider has a profile/);
});

test('a missing or duplicated table fails', () => {
  assert.throws(() => compare({ markdown: DOC.replace('| Base |', '| Provider |'), golden: GOLDEN }), /expected one table headed \| Base \|.*found 0/);
  assert.throws(() => compare({ markdown: `${DOC}\n${DOC}`, golden: GOLDEN }), /found 2/);
});

test('a page that lists account folders again fails; one folder or a link passes', () => {
  const pages = [
    { path: 'docs/protocol/a.md', text: 'x\nsets (`CODEX_HOME`,\n  or `CLAUDE_CONFIG_DIR`) here' },
    { path: 'docs/protocol/b.md', text: 'sets `CODEX_HOME` or an [account folder](./x.md#account-folders)' },
  ];
  const golden = withProvider({ id: 'claude-code', profile: profile({ credentialKeys: ['K'], accountDirKeys: ['CLAUDE_CONFIG_DIR'] }) });
  const markdown = DOC.replace('\n\n| Key', '\n| `claude-code` | `K` | `CLAUDE_CONFIG_DIR` | none |\n\n| Key');
  const { errors } = compare({ markdown, golden, pages });
  assert.deepEqual(errors, ['docs/protocol/a.md:2: lists account folders (`CODEX_HOME`, or `CLAUDE_CONFIG_DIR`); link to docs/protocol/methods/provider-profiles.md#account-folders instead']);
});

test('folderLists matches comma, "or" and "and" lists only', () => {
  const folders = ['A_HOME', 'B_HOME'];
  assert.equal(folderLists('`A_HOME` and `B_HOME`', folders).length, 1);
  assert.equal(folderLists('`A_HOME`, `B_HOME`', folders).length, 1);
  assert.equal(folderLists('`A_HOME` | `B_HOME`', folders).length, 0);
  assert.equal(folderLists('`A_HOME`, `OTHER`, `B_HOME`', folders).length, 0);
  assert.equal(folderLists('`A_HOME`, `XYZ`', ['A_HOME', 'X.*']).length, 0);
});
