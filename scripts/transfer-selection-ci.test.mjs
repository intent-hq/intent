import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const workflow = read('.github/workflows/consumer-checks.yml');
function step(source, name, indent = 6) {
  const marker = `${' '.repeat(indent)}- name: ${name}\n`;
  const begin = source.indexOf(marker);
  assert.notEqual(begin, -1, `missing workflow step ${name}`);
  const end = source.indexOf(`\n${' '.repeat(indent)}- `, begin + marker.length);
  return source.slice(begin, end === -1 ? undefined : end);
}
function body(source, indent = 10) {
  const match = source.match(/\n +run: \|\n([\s\S]*)/);
  assert.ok(match, 'expected a shell step');
  const lines = [];
  for (const line of match[1].split('\n')) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
    lines.push(line.slice(indent));
  }
  return lines.join('\n');
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'transfer-ci-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  return { root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: `${root}/summary`, GITHUB_ENV: `${root}/env` } };
}

test('reusable acquisition preserves workflow revision, caller head and counterpart pin for both directions', () => {
  const mono = step(workflow, "Check out the monorepo at this workflow's commit");
  assert.match(mono, /ref: \$\{\{ inputs.self-test && github.sha \|\| job\.workflow_sha \|\| 'main' \}\}/);
  assert.match(mono, /repository: \$\{\{ inputs.self-test && github.repository \|\| job\.workflow_repository \|\| 'intent-hq\/intent' \}\}/);
  assert.match(mono, /persist-credentials: false/);
  const caller = step(workflow, 'Replace packages/${{ inputs.component }} with the caller head');
  assert.match(caller, /ref: \$\{\{ inputs.head-sha \|\| github.sha \}\}/);
  assert.match(caller, /path: packages\/\$\{\{ inputs.component \}\}/);
  assert.match(caller, /persist-credentials: false/);
  const pin = step(workflow, 'Initialize packages/${{ steps.component.outputs.other }} at its pin');
  assert.match(pin, /git submodule update --init --depth=1 "packages\/\$\{\{ steps.component.outputs.other \}\}"/);
  for (const component of ['intentd', 'cloudlands-fe']) {
    const callerWorkflow = read(component === 'intentd' ? 'packages/intentd/.github/workflows/ci.yml' : 'packages/cloudlands-fe/.github/workflows/intent-pr.yml');
    const callerJob = callerWorkflow.split('\n  monorepo-consumer-checks:\n')[1]?.split(/\n  [a-z][\w-]*:/)[0];
    assert.ok(callerJob);
    assert.match(callerJob, new RegExp(`component: ${component}`));
    assert.match(callerJob, /head-sha: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
    assert.match(callerWorkflow, /needs.monorepo-consumer-checks.result/);
  }
});

test('the connected step is required after checkout, with no path or missing-harness bypass', () => {
  for (const name of ['Verify connected harnesses and source revisions', 'Prepare the connected test toolchains', 'Install the selected renderer dependencies', 'Run the connected transfer selection contract']) {
    const block = step(workflow, name);
    assert.deepEqual(block.match(/^ +if: .*$/gm)?.map((line) => line.trim()), ["if: steps.monorepo.outcome == 'success'"]);
    assert.doesNotMatch(block, /continue-on-error|hashFiles|paths-filter|--if-present|passWithNoTests/);
  }
  assert.match(step(workflow, 'Verify connected harnesses and source revisions'), /run: node scripts\/test-transfer-selection-contract.mjs --preflight/);
  assert.match(step(workflow, 'Run the connected transfer selection contract'), /shell: bash/);
});

test('local exercise uses the tested monorepo tree and the actual component repository', () => {
  assert.match(workflow, /self-test:\n\s+description: .*\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  const mono = step(workflow, "Check out the monorepo at this workflow's commit");
  assert.match(mono, /repository: \$\{\{ inputs.self-test && github.repository \|\| job.workflow_repository \|\| 'intent-hq\/intent' \}\}/);
  assert.match(mono, /ref: \$\{\{ inputs.self-test && github.sha \|\| job.workflow_sha \|\| 'main' \}\}/);
  assert.match(workflow, /COMPONENT_REPOSITORY: \$\{\{ inputs.self-test && format\('intent-hq\/\{0\}', inputs.component\) \|\| github.repository \}\}/);
  const caller = step(workflow, 'Replace packages/${{ inputs.component }} with the caller head');
  assert.match(caller, /repository: \$\{\{ env.COMPONENT_REPOSITORY \}\}/);
  assert.match(caller, /ref: \$\{\{ inputs.head-sha \|\| github.sha \}\}/);
  assert.match(step(workflow, 'Skip when the monorepo checkout failed'), /SELF_TEST: \$\{\{ inputs.self-test \}\}/);
});

test('the real connected workflow shell propagates failures through tee and records evidence', (t) => {
  const f = fixture(t);
  writeFileSync(`${f.root}/bin/make`, '#!/bin/sh\nprintf "%s\\n" "$*" > "$RUNNER_TEMP/args"\necho "transfer-selection sources: caller=$COMPONENT head=$HEAD_SHA"\nexit "$TEST_STATUS"\n', { mode: 0o755 });
  const command = body(step(workflow, 'Run the connected transfer selection contract'));
  for (const component of ['intentd', 'cloudlands-fe']) {
    for (const status of [0, 19]) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', command], { cwd: f.root, env: { ...f.env, COMPONENT: component, HEAD_SHA: 'a'.repeat(40), TEST_STATUS: String(status) }, encoding: 'utf8' });
      assert.equal(result.status, status, result.stderr);
      assert.equal(readFileSync(`${f.root}/args`, 'utf8').trim(), 'RUSTUP_CARGO= test-transfer-selection-contract');
      assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), new RegExp(`caller=${component} head=${'a'.repeat(40)}`));
    }
  }
});

test('toolchain preparation rejects caller path overrides and pins a valid release', (t) => {
  const f = fixture(t);
  mkdirSync(`${f.root}/packages/intentd`, { recursive: true });
  for (const tool of ['rustup', 'sudo', 'corepack']) writeFileSync(`${f.root}/bin/${tool}`, '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$RUNNER_TEMP/tools"\n', { mode: 0o755 });
  const command = body(step(workflow, 'Prepare the connected test toolchains'));
  for (const [config, expected] of [['[toolchain]\npath = "attacker"\n', 1], ['[toolchain]\nchannel = "$(false)"\n', 1], ['[toolchain]\nchannel = "1.96.0"\n', 0]]) {
    writeFileSync(`${f.root}/packages/intentd/rust-toolchain.toml`, config);
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
  }
  assert.equal(readFileSync(f.env.GITHUB_ENV, 'utf8').trim(), 'RUSTUP_TOOLCHAIN=1.96.0');
  assert.equal(readFileSync(`${f.root}/tools`, 'utf8').split('\n').filter((line) => line.includes('rustup')).length, 1);
});

test('toolchain setup failures propagate from every required tool', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'packages/intentd'), { recursive: true });
  writeFileSync(path.join(f.root, 'packages/intentd/rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.0"\n');
  const command = body(step(workflow, 'Prepare the connected test toolchains'));
  for (const failedTool of ['rustup', 'sudo', 'corepack']) {
    for (const tool of ['rustup', 'sudo', 'corepack']) {
      writeFileSync(path.join(f.root, 'bin', tool), '#!/bin/sh\nexit ' + (tool === failedTool ? 23 : 0) + '\n', { mode: 0o755 });
    }
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 23, failedTool + ': ' + result.stderr);
  }
});

test('standalone jobs acquire main once and print the actual full contract SHA', (t) => {
  const f = fixture(t);
  const daemon = read('packages/intentd/.github/actions/transfer-selection-fixtures/action.yml');
  const frontend = read('packages/cloudlands-fe/.github/workflows/intent-pr.yml');
  const checkout = step(frontend, 'Checkout shared transfer-selection fixtures');
  for (const source of [daemon, checkout]) {
    assert.equal(source.match(/repository: intent-hq\/intent/g)?.length, 1);
    assert.match(source, /ref: main\n/);
    assert.match(source, /persist-credentials: false/);
    assert.match(source, /docs\/protocol\/fixtures\/transfer-selection/);
    assert.match(source, /scripts\//);
  }
  for (const executable of ['node', 'pnpm']) writeFileSync(`${f.root}/bin/${executable}`, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const [location, source, indent] of [
    ['.transfer-selection-contract', step(daemon, 'Validate and expose the required shared fixtures', 4), 8],
    ['.cache/transfer-selection-contract', step(frontend, 'Unit tests'), 10],
  ]) {
    const dir = `${f.root}/${location}`;
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'test: fixture']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const command = body(source, indent).replaceAll('${{ matrix.shard }}', '1');
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: { ...f.env, GITHUB_WORKSPACE: f.root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`intent-hq/intent@${sha}`));
    assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), new RegExp(`intent-hq/intent@${sha}`));
  }
});
