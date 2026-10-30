import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EXEMPT, FE_FILE, INTENTD_FILE, compare, parseFePaths, parseIntentdPaths, run } from './check-agent-feature-toggles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/check-agent-feature-toggles.mjs');
const intentdSource = readFileSync(path.join(root, INTENTD_FILE), 'utf8');
const feSource = readFileSync(path.join(root, FE_FILE), 'utf8');

// Mutations of the real pinned sources, so a format change in either component
// shows up here as a parser failure rather than a silently empty list.
const dropFePath = (source, p) =>
  source
    .replace(`  '${p}',\n`, '')
    .replace(new RegExp(`  \\{\\n    path: '${p.replace('.', '\\.')}',[\\s\\S]*?\\n  \\},\\n`), '');

const addDaemonSetting = (source, p) =>
  source.replace(
    /^(pub\(crate\) fn definitions\(\) -> Vec<SettingDefinition> \{\n)/m,
    `$1    let _new = boolean(\n        "${p}",\n        "New",\n        "New feature",\n        "agentFeatures",\n        false,\n    );\n`,
  );

function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-feature-toggles-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const cli = (dir) => spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
const lists = (intentd = intentdSource, fe = feSource) => ({ daemon: parseIntentdPaths(intentd), ...parseFePaths(fe) });

test('the pinned components agree', () => {
  const { daemon, featurePaths, featureEntries } = lists();
  assert.ok(daemon.includes('agentFeatures.secretRequests'));
  assert.deepEqual([...featurePaths].sort(), [...daemon].sort());
  assert.deepEqual(featureEntries, featurePaths);
  const result = compare({ daemon, featurePaths, featureEntries });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.matched, daemon.length);
  assert.deepEqual(EXEMPT, {}, 'a new EXEMPT entry needs a matching test expectation update');
});

test('CLI passes on copies of the current components', () => {
  const dir = fixture({ [INTENTD_FILE]: intentdSource, [FE_FILE]: feSource });
  try {
    const out = cli(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\d+ agentFeatures\.\* settings have Settings toggles/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails and names a daemon setting the FE dropped (the secretRequests regression)', () => {
  const fe = dropFePath(feSource, 'agentFeatures.secretRequests');
  assert.notEqual(fe, feSource);
  assert.ok(!parseFePaths(fe).featurePaths.includes('agentFeatures.secretRequests'));
  assert.ok(!parseFePaths(fe).featureEntries.includes('agentFeatures.secretRequests'));
  const dir = fixture({ [INTENTD_FILE]: intentdSource, [FE_FILE]: fe });
  try {
    const out = cli(dir);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /agentFeatures\.secretRequests is registered by intentd/);
    assert.match(out.stderr, new RegExp(FE_FILE.replaceAll('.', '\\.')));
    assert.match(out.stderr, /EXEMPT in scripts\/check-agent-feature-toggles\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a daemon-only new setting fails, and passes once exempted', () => {
  const l = lists(addDaemonSetting(intentdSource, 'agentFeatures.brandNew'));
  assert.ok(l.daemon.includes('agentFeatures.brandNew'));
  const failing = compare(l);
  assert.equal(failing.errors.length, 1);
  assert.match(failing.errors[0], /agentFeatures\.brandNew/);
  const exempted = compare({ ...l, exempt: { 'agentFeatures.brandNew': 'toggle lands in cloudlands-fe#1' } });
  assert.deepEqual(exempted.errors, []);
  assert.deepEqual(exempted.warnings, []);
});

test('off-pin intentd adds the rebase hint to a missing-toggle error', () => {
  const l = lists(addDaemonSetting(intentdSource, 'agentFeatures.brandNew'));
  assert.match(compare({ ...l, offPin: true }).errors[0], /rebase this monorepo worktree/);
  assert.doesNotMatch(compare(l).errors[0], /rebase/);
});

test('an exemption without a reason fails', () => {
  const l = lists(addDaemonSetting(intentdSource, 'agentFeatures.brandNew'));
  const result = compare({ ...l, exempt: { 'agentFeatures.brandNew': '  ' } });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /needs a one-line reason/);
});

test('an exemption outside agentFeatures.* fails', () => {
  const result = compare({ ...lists(), exempt: { 'prMonitor.pollSeconds': 'not a feature toggle' } });
  assert.ok(result.errors.some((e) => /is not an agentFeatures\.\* path/.test(e)));
});

test('a stale exemption warns without failing', () => {
  const listed = compare({ ...lists(), exempt: { 'agentFeatures.hostExec': 'old reason' } });
  assert.deepEqual(listed.errors, []);
  assert.match(listed.warnings.join('\n'), /hostExec is stale: cloudlands-fe now lists it/);
  const gone = compare({ ...lists(), exempt: { 'agentFeatures.removedLongAgo': 'old reason' } });
  assert.deepEqual(gone.errors, []);
  assert.match(gone.warnings.join('\n'), /removedLongAgo is stale: intentd no longer registers it/);
});

test('an FE-only toggle warns without failing', () => {
  const intentd = intentdSource.replace(/\n        boolean\(\n            "agentFeatures\.mcpTools",[\s\S]*?\.with_token_impact\("[^"]*"\),/, '');
  assert.notEqual(intentd, intentdSource);
  const result = compare(lists(intentd));
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /agentFeatures\.mcpTools has a toggle but intentd does not register it/);
});

test('FEATURE_PATHS and FEATURES disagreeing fails', () => {
  const pathsOnly = feSource.replace("  'agentFeatures.mcpTools',\n", '');
  assert.match(compare(lists(intentdSource, pathsOnly)).errors.join('\n'), /mcpTools has a FEATURES entry but is not in FEATURE_PATHS/);
  const entriesOnly = dropFePath(feSource, 'agentFeatures.mcpTools').replace('] as const;', "  'agentFeatures.mcpTools',\n] as const;");
  assert.match(compare(lists(intentdSource, entriesOnly)).errors.join('\n'), /mcpTools is in FEATURE_PATHS but has no FEATURES entry/);
});

test('duplicates fail', () => {
  const fe = feSource.replace("  'agentFeatures.mcpTools',\n", "  'agentFeatures.mcpTools',\n  'agentFeatures.mcpTools',\n");
  assert.match(compare(lists(intentdSource, fe)).errors.join('\n'), /FEATURE_PATHS lists agentFeatures\.mcpTools more than once/);
});

test('unrecognized shapes fail closed', () => {
  assert.throws(() => parseIntentdPaths(intentdSource.replace('pub(crate) fn definitions()', 'pub fn all_definitions()')), /definitions\(\).*not found/);
  assert.throws(() => parseIntentdPaths(intentdSource.replaceAll('"agentFeatures.', '"features.')), /registers no agentFeatures/);
  assert.throws(
    () => parseIntentdPaths(intentdSource.replace(/^(pub\(crate\) fn definitions\(\) -> Vec<SettingDefinition> \{\n)/m, '$1    let key = "agentFeatures.viaConst";\n')),
    /agentFeatures\.viaConst outside a constructor/,
  );
  assert.throws(() => parseFePaths(feSource.replace('] as const;', '  ...EXTRA_PATHS,\n] as const;')), /FEATURE_PATHS holds something other than string literals/);
  assert.throws(() => parseFePaths(feSource.replace("path: 'agentFeatures.mcpTools',", 'path: MCP_PATH,')), /`path: MCP_PATH,` is not a string literal/);
  assert.throws(() => parseFePaths(feSource.replace('export const FEATURE_PATHS', 'export const PATHS')), /FEATURE_PATHS = \[\.\.\.\] as const;` not found/);
});

test('commented-out registrations do not count', () => {
  const intentd = addDaemonSetting(intentdSource, 'agentFeatures.brandNew').replace('    let _new = boolean(\n        "agentFeatures.brandNew",', '    // let _new = boolean(\n        // "agentFeatures.brandNew",');
  assert.ok(!parseIntentdPaths(intentd).includes('agentFeatures.brandNew'));
});

test('run reports a missing component file', () => {
  const dir = fixture({ [FE_FILE]: feSource });
  try {
    assert.throws(() => run(dir, { log: () => {}, warn: () => {} }), /settings\.rs not found; initialize the submodule/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
