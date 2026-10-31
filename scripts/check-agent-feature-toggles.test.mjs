import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DEFINITIONS_FILE, DOCS_FILE, FE_DIR, FE_FILE, INTENTD_DIR, REGISTRY_FILE,
  compare, parseDefinitionPaths, parseDocsPaths, parseFePaths, parseKnownPaths, run, stripComments,
} from './check-agent-feature-toggles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-agent-feature-toggles.mjs');

// Synthetic sources in the shapes the pinned components use today. The tests
// never edit the real component files, so an unrelated upstream edit cannot
// break them; `make check-agent-feature-toggles` is what reads the pins.
const definitionsRs = (paths, extra = '') => `fn boolean(path: &'static str) -> SettingDefinition { todo!() }

pub(crate) fn definitions() -> Vec<SettingDefinition> {
    let quote = '"';
    vec![
        boolean(
            "workspaceApi.toonOutput",
            "TOON output",
            "TOON-encode results",
            "workspaceApi",
            true,
        ),
${paths.map((p) => `        boolean(\n            "${p}",\n            "Label",\n            "Needs agentFeatures.hostExec; see https://example.test/x",\n            "agentFeatures",\n            true,\n        )\n        .with_token_impact("~50 tokens/session"),\n`).join('')}${extra}    ]
}

#[cfg(test)]
mod tests {
    const EXPECTED: &[(&str, bool)] = &[("agentFeatures.testOnly", true)];
}
`;

const registryRs = (paths) => `pub(crate) const KNOWN_PATHS: &[&str] = &[
    "workspaceApi.toonOutput",
${paths.map((p) => `    "${p}",\n`).join('')}    "prMonitor.debounceSeconds",
];
`;

const featureTs = (paths, entries = paths, { pathsExtra = '', entriesExtra = '' } = {}) => `import { m } from '$shared/paraglide/messages.js';

// i18n-ignore (wire setting paths, not user-facing text)
export const FEATURE_PATHS = [
${paths.map((p) => `  '${p}',\n`).join('')}${pathsExtra}] as const;

export type FeaturePath = (typeof FEATURE_PATHS)[number];

export const FEATURES: {
  path: FeaturePath;
  label: () => string;
  defaultValue: boolean;
}[] = [
${entries.map((p) => `  {\n    path: '${p}',\n    label: () => m.x(),\n    // Off by default on the daemon.\n    defaultValue: true,\n  },\n`).join('')}${entriesExtra}];
`;

// The settings.md shape: one Agent features bullet whose paths precede
// "— booleans", other code spans after it, and optional prepared bullets.
const settingsMd = (paths, prepared = []) => `## Settings

- **Tools:** \`rtk.enabled\` *(boolean, default \`false\`)*.
- **Agent features (new in intentd):** ${paths.map((p, i) => `\`${p}\`${i === 1 ? ' *(v6.1)*' : ''}`).join(', ')} — booleans, TOML-backed under \`[agentFeatures]\`.
  All default **\`true\`** except \`agentFeatures.secretRequests\`; see \`agentFeatures.notListed\` too.
${prepared.map(({ path: p, notImplemented = true }) => `- **Brand new agent feature (prepared addition)**: \`${p}\` *(boolean)* — mentions \`agentFeatures.hostExec\`.${notImplemented ? ' This addition is **not implemented by the current pins**.' : ''}\n`).join('')}- **PR monitor:** \`prMonitor.pollSeconds\`.
`;

const BASE = ['agentFeatures.hostExec', 'agentFeatures.secretRequests', 'agentFeatures.mcpTools'];
const lists = ({ daemon = BASE, known = daemon, fe = BASE, entries = fe } = {}) => ({
  daemon: parseDefinitionPaths(definitionsRs(daemon)),
  known: parseKnownPaths(registryRs(known)),
  ...parseFePaths(featureTs(fe, entries)),
});

function fixture({ daemon = BASE, known = daemon, fe = BASE, entries = fe, docs = daemon, intentdDir = INTENTD_DIR, feDir = FE_DIR } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-feature-toggles-'));
  const files = {
    [DOCS_FILE]: settingsMd(docs),
    [path.join(intentdDir, DEFINITIONS_FILE)]: definitionsRs(daemon),
    [path.join(intentdDir, REGISTRY_FILE)]: registryRs(known),
    [path.join(feDir, FE_FILE)]: featureTs(fe, entries),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const cli = (dir, ...args) => spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8', env: { ...process.env, CI: '' } });
const quiet = { log: () => {}, warn: () => {} };

test('the pinned component sources parse', () => {
  // A shape change in either component fails here and in the check itself;
  // the set comparison is left to `make check-agent-feature-toggles`.
  const daemon = parseDefinitionPaths(readFileSync(path.join(root, INTENTD_DIR, DEFINITIONS_FILE), 'utf8'));
  const known = parseKnownPaths(readFileSync(path.join(root, INTENTD_DIR, REGISTRY_FILE), 'utf8'));
  const { featurePaths, featureEntries } = parseFePaths(readFileSync(path.join(root, FE_DIR, FE_FILE), 'utf8'));
  const { listed } = parseDocsPaths(readFileSync(path.join(root, DOCS_FILE), 'utf8'));
  for (const values of [daemon, known, featurePaths, featureEntries, listed]) {
    assert.ok(values.length > 0);
    for (const value of values) assert.match(value, /^agentFeatures\.[A-Za-z]+$/);
  }
});

test('agreeing synthetic components pass through the CLI', () => {
  const dir = fixture();
  try {
    const out = cli(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /3 agentFeatures\.\* settings have Settings toggles; 3 are documented in docs\/protocol\/methods\/settings\.md$/m);
    assert.doesNotMatch(out.stdout, /::warning::/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails and names a daemon setting with no toggle (the secretRequests regression)', () => {
  const fe = BASE.filter((p) => p !== 'agentFeatures.secretRequests');
  const dir = fixture({ fe });
  try {
    const out = cli(dir);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /agentFeatures\.secretRequests is registered by intentd/);
    assert.match(out.stderr, /FEATURE_PATHS and FEATURES in packages\/cloudlands-fe\/src\/lib\/components\/settings\/agent-feature-definitions\.ts/);
    assert.match(out.stderr, /EXEMPT in scripts\/check-agent-feature-toggles\.mjs before the intentd PR/);
    assert.doesNotMatch(out.stderr, /rebase/, 'no git checkout, so no off-pin hint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI honours --intentd-dir and --fe-dir', () => {
  const dir = fixture({ intentdDir: 'other/intentd', feDir: 'other/fe' });
  try {
    assert.equal(cli(dir).status, 1, 'default directories are absent');
    const out = cli(dir, '--intentd-dir', 'other/intentd', '--fe-dir', 'other/fe');
    assert.equal(out.status, 0, out.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon-only new setting fails, and passes once exempted', () => {
  const l = lists({ daemon: [...BASE, 'agentFeatures.brandNew'] });
  const failing = compare(l);
  assert.equal(failing.errors.length, 1);
  assert.match(failing.errors[0], /agentFeatures\.brandNew is registered by intentd/);
  const exempted = compare({ ...l, exempt: { 'agentFeatures.brandNew': 'toggle lands in cloudlands-fe#1' } });
  assert.deepEqual(exempted.errors, []);
  assert.deepEqual(exempted.warnings, []);
  assert.equal(exempted.exempted, 1);
  assert.equal(exempted.matched, 3);
});

test('the off-pin hint is appended only when given', () => {
  const l = lists({ daemon: [...BASE, 'agentFeatures.brandNew'] });
  assert.match(compare({ ...l, hint: ' If origin/main already exempts it, rebase this monorepo worktree.' }).errors[0], /rebase this monorepo worktree\.$/);
  assert.doesNotMatch(compare(l).errors[0], /rebase/);
});

test('an exemption without a reason fails', () => {
  const l = lists({ daemon: [...BASE, 'agentFeatures.brandNew'] });
  const result = compare({ ...l, exempt: { 'agentFeatures.brandNew': '  ' } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /needs a one-line reason/);
});

test('an exemption outside agentFeatures.* fails', () => {
  const result = compare({ ...lists(), exempt: { 'prMonitor.pollSeconds': 'not a feature toggle' } });
  assert.ok(result.errors.some((e) => /is not an agentFeatures\.\* path/.test(e)));
});

test('a stale exemption warns without failing and is not counted', () => {
  const listed = compare({ ...lists(), exempt: { 'agentFeatures.hostExec': 'old reason' } });
  assert.deepEqual(listed.errors, []);
  assert.match(listed.warnings.join('\n'), /hostExec is stale: cloudlands-fe now lists it/);
  assert.equal(listed.exempted, 0);
  const gone = compare({ ...lists(), exempt: { 'agentFeatures.removedLongAgo': 'old reason' } });
  assert.deepEqual(gone.errors, []);
  assert.match(gone.warnings.join('\n'), /removedLongAgo is stale: intentd no longer registers it/);
  assert.equal(gone.exempted, 0);
});

test('an FE-only toggle warns without failing', () => {
  const result = compare(lists({ fe: [...BASE, 'agentFeatures.feFirst'] }));
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /agentFeatures\.feFirst has a toggle but intentd does not register it/);
});

test('FEATURE_PATHS and FEATURES disagreeing fails', () => {
  const entriesOnly = compare(lists({ fe: BASE.slice(0, 2), entries: BASE }));
  assert.match(entriesOnly.errors.join('\n'), /mcpTools has a FEATURES entry but is not in FEATURE_PATHS/);
  const pathsOnly = compare(lists({ fe: BASE, entries: BASE.slice(0, 2) }));
  assert.match(pathsOnly.errors.join('\n'), /mcpTools is in FEATURE_PATHS but has no FEATURES entry/);
});

test('KNOWN_PATHS and definitions() disagreeing fails closed', () => {
  const helper = compare(lists({ known: [...BASE, 'agentFeatures.viaHelper'] }));
  assert.match(helper.errors.join('\n'), /viaHelper is in KNOWN_PATHS .* found no definitions\(\) constructor/);
  const unknown = compare(lists({ known: BASE.slice(0, 2) }));
  assert.match(unknown.errors.join('\n'), /mcpTools is registered in definitions\(\) .* but missing from KNOWN_PATHS/);
});

test('duplicates fail', () => {
  const result = compare(lists({ fe: [...BASE, 'agentFeatures.mcpTools'], entries: BASE }));
  assert.match(result.errors.join('\n'), /FEATURE_PATHS lists agentFeatures\.mcpTools more than once/);
});

test('unrecognized intentd shapes fail closed', () => {
  assert.throws(() => parseDefinitionPaths(definitionsRs(BASE).replace('pub(crate) fn definitions()', 'pub fn all_definitions()')), /definitions\(\).*not found/);
  assert.throws(() => parseDefinitionPaths(definitionsRs([])), /registers no agentFeatures/);
  assert.throws(() => parseDefinitionPaths(definitionsRs(BASE, '        let key = "agentFeatures.viaConst";\n')), /agentFeatures\.viaConst outside a definition constructor/);
  assert.throws(() => parseDefinitionPaths(definitionsRs(BASE, '        x.with_requires("agentFeatures.hostExec"),\n')), /agentFeatures\.hostExec outside a definition constructor/);
  assert.throws(() => parseKnownPaths(registryRs(BASE).replace('pub(crate) const KNOWN_PATHS', 'pub const PATHS')), /KNOWN_PATHS.*not found/);
  assert.throws(() => parseKnownPaths(registryRs(BASE).replace('];', '    EXTRA,\n];')), /KNOWN_PATHS holds something other than string literals/);
});

test('unrecognized FE shapes fail closed', () => {
  assert.throws(() => parseFePaths(featureTs(BASE, BASE, { pathsExtra: '  ...EXTRA_PATHS,\n' })), /FEATURE_PATHS holds something other than string literals/);
  assert.throws(() => parseFePaths(featureTs(BASE).replace("path: 'agentFeatures.mcpTools',", 'path: MCP_PATH,')), /`path: MCP_PATH,` is not a string literal/);
  assert.throws(() => parseFePaths(featureTs(BASE).replace('export const FEATURE_PATHS', 'export const PATHS')), /FEATURE_PATHS = \[\.\.\.\] as const;` not found/);
  assert.throws(() => parseFePaths(featureTs(BASE, BASE, { entriesExtra: '  ...LABS_FEATURES,\n' })), /FEATURES holds `\.\.\.LABS_FEATURES,`/);
  assert.throws(() => parseFePaths(featureTs(BASE, BASE, { entriesExtra: "  { path: 'agentFeatures.oneLine', label: () => m.x(), defaultValue: true },\n" })), /not a multi-line/);
  assert.throws(() => parseFePaths(featureTs(BASE).replace("    path: 'agentFeatures.mcpTools',\n", '')), /has 0 `path:` lines/);
});

test('comments do not register or reference settings', () => {
  const commented = definitionsRs(BASE, [
    '        // boolean("agentFeatures.lineComment", "x", "x", "agentFeatures", true),\n',
    '        /* boolean(\n            "agentFeatures.blockComment", /* nested */ "x", "x", "agentFeatures", true,\n        ), */\n',
    '        // renamed from "agentFeatures.oldName"\n',
  ].join('')).replace('"agentFeatures.mcpTools",', '"agentFeatures.mcpTools", // was "agentFeatures.mcp"');
  assert.deepEqual(parseDefinitionPaths(commented), BASE);
  const fe = featureTs(BASE, BASE, { pathsExtra: "  // 'agentFeatures.commentedOut',\n  /* 'agentFeatures.blockOut', */\n" });
  assert.deepEqual(parseFePaths(fe).featurePaths, BASE);
});

test('stripComments keeps strings that look like comments', () => {
  const rust = 'let a = "https://x/*y*/"; let c = \'"\'; let r = r#"// "x" "#; // gone\n/* gone /* nested */ */ok';
  const stripped = stripComments(rust, 'rust');
  assert.equal(stripped.length, rust.length);
  assert.ok(stripped.includes('"https://x/*y*/"'));
  assert.ok(stripped.includes('r#"// "x" "#'));
  assert.ok(!stripped.includes('gone'));
  assert.ok(stripped.endsWith('ok'));
  const ts = "const u = 'a // b'; const t = `/* c */`; // gone";
  assert.equal(stripComments(ts, 'ts').trimEnd(), "const u = 'a // b'; const t = `/* c */`;");
});

test('run reports a missing component file', () => {
  const dir = fixture();
  rmSync(path.join(dir, INTENTD_DIR, DEFINITIONS_FILE));
  try {
    assert.throws(() => run(dir, quiet), /settings\.rs not found; initialize the submodule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails and names a daemon setting missing from the docs list', () => {
  const dir = fixture({ docs: BASE.filter((p) => p !== 'agentFeatures.secretRequests') });
  try {
    const out = cli(dir);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /agentFeatures\.secretRequests is registered by intentd .* but missing from the Agent features list in docs\/protocol\/methods\/settings\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the docs list is the bullet text before "— booleans"', () => {
  const { listed, prepared } = parseDocsPaths(settingsMd(BASE));
  assert.deepEqual(listed, BASE, 'mentions after the list, and other bullets, do not count');
  assert.deepEqual(prepared, []);
});

test('a prepared-addition bullet documents a setting, and warns once the daemon registers it', () => {
  const daemon = [...BASE, 'agentFeatures.brandNew'];
  const l = lists({ daemon, fe: daemon });
  const stale = compare({ ...l, docs: parseDocsPaths(settingsMd(BASE, [{ path: 'agentFeatures.brandNew' }])) });
  assert.deepEqual(stale.errors, []);
  assert.equal(stale.documented, 4);
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /agentFeatures\.brandNew has a prepared-addition bullet .* "not implemented by the current pins", but intentd registers it/);
  const updated = compare({ ...l, docs: parseDocsPaths(settingsMd(BASE, [{ path: 'agentFeatures.brandNew', notImplemented: false }])) });
  assert.deepEqual(updated.errors, []);
  assert.deepEqual(updated.warnings, []);
});

test('a docs-first prepared bullet for an unregistered setting is silent', () => {
  const result = compare({ ...lists(), docs: parseDocsPaths(settingsMd(BASE, [{ path: 'agentFeatures.docsFirst' }])) });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a listed path the daemon does not register warns; a duplicate fails', () => {
  const extra = compare({ ...lists(), docs: parseDocsPaths(settingsMd([...BASE, 'agentFeatures.gone'])) });
  assert.deepEqual(extra.errors, []);
  assert.match(extra.warnings.join('\n'), /agentFeatures\.gone is in the Agent features list .* but intentd does not register it/);
  const dup = compare({ ...lists(), docs: parseDocsPaths(settingsMd([...BASE, 'agentFeatures.hostExec'])) });
  assert.match(dup.errors.join('\n'), /Agent features list names agentFeatures\.hostExec more than once/);
});

test('unrecognized docs shapes fail closed', () => {
  assert.throws(() => parseDocsPaths(settingsMd(BASE).replace('- **Agent features', '- **Agent toggles')), /expected one `- \*\*Agent features \.\.\.\*\*` bullet, found 0/);
  assert.throws(() => parseDocsPaths(settingsMd(BASE).replace(' — booleans', ', booleans')), /no longer lists its settings before `— booleans`/);
  assert.throws(() => parseDocsPaths(settingsMd(['rtk.enabled'])), /lists no agentFeatures\.\* setting/);
});

test('run reports missing settings docs without a submodule hint', () => {
  const dir = fixture();
  rmSync(path.join(dir, DOCS_FILE));
  try {
    assert.throws(() => run(dir, quiet), (error) => /settings\.md not found; update check-agent-feature-toggles/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
