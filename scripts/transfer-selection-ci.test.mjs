import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Workflow steps call scripts/retry.sh from the monorepo checkout; RETRY_DELAY=0
  // keeps its retries from waiting in real time.
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(path.join(ROOT, 'scripts/retry.sh'), path.join(root, 'scripts/retry.sh'));
  return { root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: `${root}/summary`, GITHUB_ENV: `${root}/env`, GITHUB_ACTIONS: '', RETRY_DELAY: '0' } };
}

// The standalone fixture checkout may be actions/checkout or a component's
// local checkout-pinned composite (cloudlands-fe#4274). Both resolve to the
// same properties: which repository and ref they fetch, which paths, and
// whether a credential is left behind.
const CHECKOUT_USES = /^( *)(?:- )?uses: (actions\/checkout@\S+|\.\/\.github\/actions\/checkout-pinned)\s*$/;
function checkoutSteps(source) {
  const lines = source.split('\n');
  const steps = [];
  lines.forEach((line, at) => {
    const match = line.match(CHECKOUT_USES);
    if (!match) return;
    // A step starts at its "- " item; include sibling keys before and after `uses`.
    let begin = at;
    while (begin > 0 && !/^ *- /.test(lines[begin])) begin -= 1;
    const item = lines[begin].match(/^ */)[0].length;
    let end = begin + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].match(/^ */)[0].length > item)) end += 1;
    steps.push({ uses: match[2], source: lines.slice(begin, end).join('\n') });
  });
  return steps;
}
function withInputs(source) {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => /^ *with:\s*$/.test(line));
  if (at === -1) return {};
  const indent = lines[at].match(/^ */)[0].length;
  const inputs = {};
  let keyIndent;
  let key;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const lead = line.match(/^ */)[0].length;
    if (lead <= indent) break;
    keyIndent ??= lead;
    const pair = lead === keyIndent && line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      inputs[key] = pair[2] === '|' ? '' : pair[2];
    } else {
      // Block scalar continuation (sparse-checkout patterns).
      inputs[key] = inputs[key] ? `${inputs[key]}\n${line.trim()}` : line.trim();
    }
  }
  return inputs;
}
function actionDefaults(action) {
  const block = action.split(/^inputs:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  const defaults = {};
  let name;
  for (const line of block.split('\n')) {
    const input = line.match(/^  ([\w-]+):\s*$/);
    if (input) name = input[1];
    const value = line.match(/^    default: (.*)$/);
    if (name && value) defaults[name] = value[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return defaults;
}
function resolveCheckout({ uses, source }, readComponent) {
  const given = withInputs(source);
  if (uses.startsWith('actions/checkout@')) {
    return { repository: given.repository, ref: given.ref, sparse: given['sparse-checkout'] ?? '', credentials: given['persist-credentials'] === 'false' ? 'none' : 'persisted' };
  }
  const action = readComponent('.github/actions/checkout-pinned/action.yml');
  const script = readComponent('scripts/git-network-retry.sh');
  // The composite must fetch anonymously over the repository URL it is given
  // and leave no credential in the checkout it creates.
  const anonymous = !/secrets\.|github\.token|token:|actions\/checkout@|extraheader/i.test(action)
    && /REPOSITORY: \$\{\{ inputs\.repository \}\}/.test(action)
    && /"https:\/\/github\.com\/\$REPOSITORY"/.test(action)
    && /git-network-retry\.sh" sparse-checkout /.test(action)
    && !/extraheader|credential|GITHUB_TOKEN|GH_TOKEN|Authorization/i.test(script);
  const defaults = actionDefaults(action);
  return { repository: given.repository ?? defaults.repository, ref: given.ref ?? defaults.ref, sparse: given['sparse-checkout'] ?? '', credentials: anonymous ? 'none' : 'persisted' };
}
function assertSharedFixtureCheckout(steps, readComponent, label) {
  assert.equal(steps.length, 1, `${label}: expected exactly one fixture checkout`);
  const checkout = resolveCheckout(steps[0], readComponent);
  assert.equal(checkout.repository, 'intent-hq/intent', `${label}: the fixture checkout must fetch intent-hq/intent, not ${checkout.repository}`);
  assert.equal(checkout.ref, 'main', `${label}: the fixture checkout must fetch main, not ${checkout.ref}`);
  assert.equal(checkout.credentials, 'none', `${label}: the fixture checkout must not keep credentials`);
  assert.match(checkout.sparse, /docs\/protocol\/fixtures\/transfer-selection/, `${label}: the fixture checkout must include the transfer-selection fixtures`);
  assert.match(checkout.sparse, /scripts\//, `${label}: the fixture checkout must include scripts/`);
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

test('the connected step is required in the queue, with no path or missing-harness bypass', () => {
  for (const name of ['Verify connected harnesses and source revisions', 'Prepare the connected test toolchains', 'Install the selected renderer dependencies', 'Run the connected transfer selection contract']) {
    const block = step(workflow, name);
    assert.deepEqual(block.match(/^ +if: .*$/gm)?.map((line) => line.trim()), ["if: github.event_name == 'merge_group' && steps.monorepo.outcome == 'success'"]);
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
  // OpenSSL headers missing, so the sudo install path runs.
  writeFileSync(path.join(f.root, 'bin', 'pkg-config'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const failedTool of ['rustup', 'sudo', 'corepack']) {
    for (const tool of ['rustup', 'sudo', 'corepack']) {
      writeFileSync(path.join(f.root, 'bin', tool), '#!/bin/sh\nexit ' + (tool === failedTool ? 23 : 0) + '\n', { mode: 0o755 });
    }
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 23, failedTool + ': ' + result.stderr);
  }
});

test('toolchain and package downloads retry a transient failure, then give up', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'packages/intentd'), { recursive: true });
  writeFileSync(path.join(f.root, 'packages/intentd/rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.0"\n');
  const command = body(step(workflow, 'Prepare the connected test toolchains'));
  writeFileSync(path.join(f.root, 'bin', 'pkg-config'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(path.join(f.root, 'bin', 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Each download fails FAILURES times (counted per argv line), then succeeds.
  const flaky = '#!/bin/sh\necho "$0 $*" >> "$RUNNER_TEMP/tools"\n[ "$(grep -cxF "$0 $*" "$RUNNER_TEMP/tools")" -gt "$FAILURES" ] || { echo "could not download file" >&2; exit 1; }\n';
  for (const tool of ['rustup', 'sudo']) writeFileSync(path.join(f.root, 'bin', tool), flaky, { mode: 0o755 });
  const calls = (needle) => readFileSync(path.join(f.root, 'tools'), 'utf8').split('\n').filter((line) => line.includes(needle)).length;
  let result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: { ...f.env, FAILURES: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /attempt 1\/3 failed \(exit 1\), retrying in 0s: rustup toolchain install 1\.96\.0 --profile minimal/);
  assert.deepEqual([calls('rustup toolchain install'), calls('apt-get update'), calls('apt-get install')], [2, 2, 2]);
  assert.equal(readFileSync(f.env.GITHUB_ENV, 'utf8').trim(), 'RUSTUP_TOOLCHAIN=1.96.0');
  rmSync(path.join(f.root, 'tools'));
  rmSync(f.env.GITHUB_ENV);
  result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: { ...f.env, FAILURES: '99' }, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /giving up after 3 attempt\(s\), last exit 1: rustup toolchain install 1\.96\.0/);
  assert.equal(calls('rustup toolchain install'), 3);
  assert.equal(existsSync(f.env.GITHUB_ENV), false);
});

test('preinstalled OpenSSL headers never call sudo (unprivileged runners)', (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, 'packages/intentd'), { recursive: true });
  writeFileSync(path.join(f.root, 'packages/intentd/rust-toolchain.toml'), '[toolchain]\nchannel = "1.96.0"\n');
  const command = body(step(workflow, 'Prepare the connected test toolchains'));
  writeFileSync(path.join(f.root, 'bin', 'pkg-config'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const tool of ['rustup', 'corepack']) writeFileSync(path.join(f.root, 'bin', tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(f.root, 'bin', 'sudo'), '#!/bin/sh\necho sudo >> "$RUNNER_TEMP/tools"\nexit 23\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', command], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(f.root, 'tools')), false);
});

test('standalone jobs acquire main once and print the actual full contract SHA', (t) => {
  const f = fixture(t);
  const daemon = read('packages/intentd/.github/actions/transfer-selection-fixtures/action.yml');
  const frontend = read('packages/cloudlands-fe/.github/workflows/intent-pr.yml');
  const checkout = step(frontend, 'Checkout shared transfer-selection fixtures');
  for (const [component, source] of [['intentd', daemon], ['cloudlands-fe', checkout]]) {
    assertSharedFixtureCheckout(checkoutSteps(source), (file) => read(`packages/${component}/${file}`), component);
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

test('fixture checkout resolution keeps the safety checks for both checkout forms', () => {
  const pinned = (extra = '') => `      - name: Checkout shared transfer-selection fixtures
        uses: ./.github/actions/checkout-pinned
        with:${extra}
          ref: main
          path: .cache/transfer-selection-contract
          sparse-checkout: |
            /docs/protocol/fixtures/transfer-selection/
            /scripts/
`;
  const action = (repositoryDefault = 'intent-hq/intent', run = 'bash "$GITHUB_ACTION_PATH/../../../scripts/git-network-retry.sh" sparse-checkout "https://github.com/$REPOSITORY" "$REF" "$DEST"') => `name: Checkout pinned sparse paths
inputs:
  repository:
    description: owner/name
    required: false
    default: ${repositoryDefault}
  ref:
    required: true
runs:
  using: composite
  steps:
    - shell: bash
      env:
        REPOSITORY: \${{ inputs.repository }}
      run: ${run}
`;
  const script = 'git -C "$dest" fetch --depth=1 origin "$ref"\n';
  const files = (actionSource, scriptSource = script) => (file) => (file.endsWith('action.yml') ? actionSource : scriptSource);
  const ok = () => assertSharedFixtureCheckout(checkoutSteps(pinned()), files(action()), 'fe');
  ok();
  // A wrong repository (default or explicit), a token, or a credential written by the script all fail.
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(pinned()), files(action('someone/fork')), 'fe'), /intent-hq\/intent/);
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(pinned('\n          repository: someone/fork')), files(action()), 'fe'), /intent-hq\/intent/);
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(pinned('\n          token: ${{ secrets.X }}')), files(action().replace('    - shell: bash', '    - uses: actions/checkout@v7\n      with:\n        token: ${{ github.token }}\n    - shell: bash')), 'fe'), /credentials/);
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(pinned()), files(action(), 'git -C "$dest" config http.extraheader "AUTHORIZATION: x"\n'), 'fe'), /credentials/);
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(pinned()), files(action('intent-hq/intent', 'git clone "https://x-access-token:$T@github.com/$REPOSITORY"')), 'fe'), /credentials/);
  // actions/checkout must still say persist-credentials: false and fetch main once.
  const checkout = (persist) => `    - uses: actions/checkout@v7
      with:
        repository: intent-hq/intent
        ref: main
        path: .transfer-selection-contract${persist}
        sparse-checkout: |
          docs/protocol/fixtures/transfer-selection
          scripts/check-transfer-selection-contract.mjs
        sparse-checkout-cone-mode: false
    - uses: actions/setup-node@v7
`;
  const none = () => assert.fail('actions/checkout must not read component files');
  assertSharedFixtureCheckout(checkoutSteps(checkout('\n        persist-credentials: false')), none, 'intentd');
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(checkout('')), none, 'intentd'), /credentials/);
  assert.throws(() => assertSharedFixtureCheckout(checkoutSteps(checkout('\n        persist-credentials: false') + checkout('\n        persist-credentials: false')), none, 'intentd'), /exactly one/);
});
