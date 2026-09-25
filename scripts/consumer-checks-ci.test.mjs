import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/consumer-checks-ci.mjs');
const PIN = 'a'.repeat(40);
const TESTED_PIN = 'b'.repeat(40);
const relevant = [
  '.github/workflows/consumer-checks.yml',
  '.github/workflows/ci.yml',
  'scripts/consumer-checks.sh',
  'scripts/consumer-checks.test.sh',
  'scripts/consumer-checks-ci.mjs',
  'scripts/consumer-checks-ci.test.mjs',
  'scripts/ci-gate.sh',
  'scripts/ci-gate.test.sh',
  'scripts/transfer-selection-ci.test.mjs',
  'scripts/test-transfer-selection-contract.mjs',
  'Makefile',
  '.gitmodules',
];

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'consumer-ci-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, content = 'fixture\n') => {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), content);
  };
  const commit = () => {
    // Keep the deliberately uninitialized gitlink; removals use git rm/index.
    git('add', '--ignore-removal', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'test: fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  write('docs/guide.md');
  write('.github/workflows/consumer-checks.yml');
  git('update-index', '--add', '--cacheinfo', '160000,' + PIN + ',packages/intentd');
  const base = commit();
  return { root, repo, git, write, commit, base };
}

function prepare(f, eventName, { payload, sha, output = path.join(f.root, 'output') } = {}) {
  const head = f.git('rev-parse', 'HEAD');
  const event = payload ?? {
    pull_request: { base: { sha: f.base }, head: { sha: 'c'.repeat(40) } },
    merge_group: { base_sha: f.base, head_sha: head },
  };
  const eventPath = path.join(f.root, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  rmSync(output, { force: true });
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: f.repo,
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: sha ?? head, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

function expectSelection(result, selected, pin = PIN) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'selected=' + selected + '\nintentd-sha=' + pin + '\n');
}

for (const event of ['pull_request', 'merge_group']) {
  test(event + ': docs-only changes skip, including filenames with whitespace', (t) => {
    const f = fixture(t);
    f.write('docs/guide.md', 'updated\n');
    f.write('docs/space and\nnewline.md');
    f.commit();
    expectSelection(prepare(f, event), false);
  });

  for (const file of relevant) {
    test(event + ': selects ' + file, (t) => {
      const f = fixture(t);
      f.write(file, 'changed\n');
      f.commit();
      expectSelection(prepare(f, event), true);
    });
  }

  for (const change of ['delete', 'rename-away', 'rename-into']) {
    test(event + ': selects relevant ' + change, (t) => {
      const f = fixture(t);
      if (change === 'delete') f.git('rm', '.github/workflows/consumer-checks.yml');
      if (change === 'rename-away') f.git('mv', '.github/workflows/consumer-checks.yml', 'docs/moved.md');
      if (change === 'rename-into') f.git('mv', 'docs/guide.md', 'scripts/consumer-checks-new.sh');
      f.commit();
      expectSelection(prepare(f, event), true);
    });
  }

  test(event + ': reads the gitlink from the tested tree, not the base or working directory', (t) => {
    const f = fixture(t);
    f.write('scripts/consumer-checks.sh', 'changed\n');
    f.git('update-index', '--cacheinfo', '160000,' + TESTED_PIN + ',packages/intentd');
    f.commit();
    f.git('update-index', '--cacheinfo', '160000,' + PIN + ',packages/intentd');
    expectSelection(prepare(f, event), true, TESTED_PIN);
  });

  test(event + ': ignores unrelated base-branch history', (t) => {
    const f = fixture(t);
    f.write('.github/workflows/consumer-checks.yml', 'already on main\n');
    f.base = f.commit();
    f.write('docs/guide.md', 'docs PR\n');
    f.commit();
    expectSelection(prepare(f, event), false);
  });

  for (const failure of ['missing base', 'unavailable base', 'wrong checkout', 'missing pin', 'non-gitlink pin']) {
    test(event + ': fails closed for ' + failure, (t) => {
      const f = fixture(t);
      const options = {};
      if (failure === 'missing base') options.payload = {};
      if (failure === 'unavailable base') f.base = 'c'.repeat(40);
      if (failure === 'wrong checkout') options.sha = 'd'.repeat(40);
      if (failure.includes('pin')) {
        f.git('update-index', '--force-remove', 'packages/intentd');
        if (failure === 'non-gitlink pin') f.write('packages/intentd', 'ordinary file\n');
        f.commit();
      }
      const result = prepare(f, event, options);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /consumer-checks-ci:/);
      assert.equal(result.output, '', 'must not emit a skip after preparation fails');
    });
  }
}

test('unknown events fail without emitting selection outputs', (t) => {
  const f = fixture(t);
  const result = prepare(f, 'push');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported event/);
  assert.equal(result.output, '');
});

test('merge-group payload must describe the tree under test', (t) => {
  const f = fixture(t);
  const result = prepare(f, 'merge_group', {
    payload: { merge_group: { base_sha: f.base, head_sha: 'c'.repeat(40) } },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /merge_group.head_sha/);
  assert.equal(result.output, '');
});

test('an unreadable output destination fails instead of reporting success', (t) => {
  const f = fixture(t);
  const result = prepare(f, 'pull_request', { output: path.join(f.root, 'missing', 'output') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /consumer-checks-ci:/);
  assert.equal(result.output, '');
});

function job(source, name) {
  const block = source.split('\n  ' + name + ':\n')[1]?.split(/\n  [a-z][\w-]*:\n/)[0];
  assert.ok(block, 'missing job ' + name);
  return block;
}

test('CI prepares every event and exercises the local workflow only when selected', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const prep = job(ci, 'consumer-checks-prepare');
  assert.doesNotMatch(prep, /^\s+(if|needs|continue-on-error):/m);
  assert.match(prep, /fetch-depth: 0/);
  assert.match(prep, /ref: \$\{\{ github.sha \}\}/);
  assert.match(prep, /submodules: false/);
  assert.match(prep, /id: select/);
  assert.match(prep, /run: node scripts\/consumer-checks-ci.mjs/);
  for (const output of ['selected', 'intentd-sha']) {
    assert.ok(prep.includes(output + ': ${{ steps.select.outputs.' + output + ' }}'));
  }
  const exercise = job(ci, 'consumer-checks-exercise');
  assert.match(exercise, /needs: consumer-checks-prepare/);
  assert.match(exercise, /if: needs.consumer-checks-prepare.outputs.selected == 'true'/);
  assert.match(exercise, /uses: \.\/\.github\/workflows\/consumer-checks.yml/);
  assert.match(exercise, /component: intentd/);
  assert.match(exercise, /head-sha: \$\{\{ needs.consumer-checks-prepare.outputs.intentd-sha \}\}/);
  assert.match(exercise, /self-test: true/);
  assert.doesNotMatch(exercise, /secrets:|continue-on-error:/);
  assert.match(ci, /node --test .*scripts\/consumer-checks-ci.test.mjs/);
  assert.doesNotMatch(ci.split('\njobs:')[0], /paths(-ignore)?:/);
});
