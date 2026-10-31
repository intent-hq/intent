import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanToken, expandBraces, parseGuide } from './check-app-guide-sources.mjs';

const script = fileURLToPath(new URL('./check-app-guide-sources.mjs', import.meta.url));
const GUIDE = 'crates/intent-services/resources/assistant-app-guide.md';

test('expandBraces handles flat, nested and slash alternatives', () => {
  assert.deepEqual(expandBraces('a/{b,c}.ts'), ['a/b.ts', 'a/c.ts']);
  assert.deepEqual(expandBraces('a/{b,c/{d,e}}.rs'), ['a/b.rs', 'a/c/d.rs', 'a/c/e.rs']);
  assert.deepEqual(expandBraces('s/{x.ts,sagas/y.ts}'), ['s/x.ts', 's/sagas/y.ts']);
  assert.deepEqual(expandBraces('{a,b}/{c,d}'), ['a/c', 'a/d', 'b/c', 'b/d']);
  assert.deepEqual(expandBraces('plain/path.ts'), ['plain/path.ts']);
  assert.throws(() => expandBraces('a/{b,c.ts'), /unbalanced '\{'/);
  assert.throws(() => expandBraces('a/b,c}.ts'), /unbalanced '\}'/);
  assert.throws(() => expandBraces('a/{b}.ts'), /two alternatives/);
});

test('cleanToken strips prose punctuation but keeps balanced parentheses', () => {
  assert.equal(cleanToken('packages/intentd/NOTICE).'), 'packages/intentd/NOTICE');
  assert.equal(cleanToken('packages/cloudlands-fe/src/routes/(app)/settings/+page.svelte;'), 'packages/cloudlands-fe/src/routes/(app)/settings/+page.svelte');
  assert.equal(cleanToken('(packages/intentd/README.md'), 'packages/intentd/README.md');
  assert.equal(cleanToken('`src/a.ts`,'), 'src/a.ts');
});

test('parseGuide reads absolute, relative, annotated and skipped citations', () => {
  const guide = [
    'Intro',
    '<!-- Sources: packages/intentd/src/{a,b}.rs (fn names); packages/ios/App.swift; see packages/intentd/NOTICE). Daemon: workspace.update `label`. -->',
    '<!-- Sources (paths relative to packages/cloudlands-fe): src/x.ts; messages/en.json. Daemon: packages/intentd/c.rs; https://example.com/a/b. -->',
  ].join('\n');
  const { comments, citations, problems } = parseGuide(guide);
  assert.equal(comments, 2);
  assert.deepEqual(problems, []);
  assert.deepEqual(citations.map(c => [c.line, c.file, c.component, c.path, c.skipped]), [
    [2, 'packages/intentd/src/a.rs', 'intentd', 'src/a.rs', false],
    [2, 'packages/intentd/src/b.rs', 'intentd', 'src/b.rs', false],
    [2, 'packages/ios/App.swift', 'ios', 'App.swift', true],
    [2, 'packages/intentd/NOTICE', 'intentd', 'NOTICE', false],
    [3, 'packages/cloudlands-fe/src/x.ts', 'cloudlands-fe', 'src/x.ts', false],
    [3, 'packages/cloudlands-fe/messages/en.json', 'cloudlands-fe', 'messages/en.json', false],
    [3, 'packages/intentd/c.rs', 'intentd', 'c.rs', false],
  ]);
});

test('cleanToken unwraps parenthesized paths and drops location suffixes', () => {
  assert.equal(cleanToken('(packages/intentd/crates/x.rs).'), 'packages/intentd/crates/x.rs');
  assert.equal(cleanToken('packages/intentd/src/agent_ops.rs:120'), 'packages/intentd/src/agent_ops.rs');
  assert.equal(cleanToken('packages/intentd/src/agent_ops.rs:120-140;'), 'packages/intentd/src/agent_ops.rs');
  assert.equal(cleanToken('src/ChatPanel.svelte#L40'), 'src/ChatPanel.svelte');
});

test('parseGuide checks packages paths in other comments and ignores prose slashes', () => {
  const guide = [
    '<!-- Auggie visibility: packages/cloudlands-fe/src/shared/provider-visibility.ts; see src/bare.ts and read/write. -->',
    '<!-- Sources: packages/intentd/a.rs (read/write path, Settings/Agents); (packages/intentd/b.rs). -->',
    '<!-- Sources (paths relative to packages/cloudlands-fe): src/x.ts (Home/Workspaces view); src/dir/. -->',
    '<!-- A plain comment without paths. -->',
  ].join('\n');
  const { comments, citations, problems } = parseGuide(guide);
  assert.deepEqual(problems, []);
  assert.equal(comments, 2, 'only Sources comments are counted as Sources comments');
  assert.deepEqual(citations.map(c => [c.line, c.file]), [
    [1, 'packages/cloudlands-fe/src/shared/provider-visibility.ts'],
    [2, 'packages/intentd/a.rs'],
    [2, 'packages/intentd/b.rs'],
    [3, 'packages/cloudlands-fe/src/x.ts'],
    [3, 'packages/cloudlands-fe/src/dir'],
  ]);
});

test('parseGuide reports guide-format problems', () => {
  const guide = [
    '<!-- Sources: messages/en.json. -->',
    '<!-- Sources: packages/other/x.ts. -->',
    '<!-- Sources (paths relative to packages/nope): src/x.ts. -->',
    '<!-- Sources packages/intentd/x.rs -->',
    '<!-- Sources: packages/intentd/{a,b.rs. -->',
    '<!-- Sources: packages/intentd/../x.rs. -->',
    '<!-- Source: packages/intentd/x.rs. -->',
  ].join('\n');
  const messages = parseGuide(guide).problems.map(p => `${p.line} ${p.message}`);
  assert.equal(messages.length, 7, messages.join('\n'));
  assert.match(messages[6], /^7 malformed Sources comment/);
  assert.match(messages[0], /^1 unqualified path 'messages\/en.json'/);
  assert.match(messages[1], /^2 .*names no known component/);
  assert.match(messages[2], /^3 unknown relative base 'packages\/nope'/);
  assert.match(messages[3], /^4 malformed Sources comment/);
  assert.match(messages[4], /^5 .*unbalanced/);
  assert.match(messages[5], /^6 .*not a normalized repository path/);
});

// A monorepo with two component repos recorded as gitlinks, the way the
// docs-check job and the upstream consumer job see them.
function fixture(t, { guide, intentdFiles = [], feFiles = [] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'app-guide-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const init = dir => {
    mkdirSync(dir, { recursive: true });
    run(dir, 'init', '-q', '-b', 'main');
    run(dir, 'config', 'user.email', 'test@example.com');
    run(dir, 'config', 'user.name', 'test');
    run(dir, 'config', 'commit.gpgsign', 'false');
  };
  const write = (dir, file, text = '') => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const commit = (dir, files) => {
    for (const [file, text] of files) write(dir, file, text);
    run(dir, 'add', '-A');
    run(dir, 'commit', '-q', '--allow-empty', '-m', 'snapshot');
    return run(dir, 'rev-parse', 'HEAD');
  };
  init(root);
  const intentd = path.join(root, 'packages/intentd');
  const fe = path.join(root, 'packages/cloudlands-fe');
  init(intentd);
  init(fe);
  const pins = {
    intentd: commit(intentd, [[GUIDE, guide], ...intentdFiles.map(f => [f, 'x'])]),
    fe: commit(fe, feFiles.map(f => [f, 'x'])),
  };
  run(root, 'update-index', '--add', '--cacheinfo', `160000,${pins.intentd},packages/intentd`);
  run(root, 'update-index', '--add', '--cacheinfo', `160000,${pins.fe},packages/cloudlands-fe`);
  run(root, 'commit', '-q', '-m', 'pins');
  return { root, intentd, fe, write, commit, run };
}

const checkAt = (root, ...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });

const GOOD = '<!-- Sources: packages/intentd/crates/x/{a,b}.rs; packages/ios/App.swift. -->\n<!-- Sources (paths relative to packages/cloudlands-fe): src/{one.ts,two/}; messages/en.json. -->\n';
const GOOD_FILES = { intentdFiles: ['crates/x/a.rs', 'crates/x/b.rs'], feFiles: ['src/one.ts', 'src/two/index.ts', 'messages/en.json'] };

test('passes when every citation exists at the pins', t => {
  const { root } = fixture(t, { guide: GOOD, ...GOOD_FILES });
  const result = checkAt(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^app-guide-sources: ok, 5 citations \(5 files\) in 2 Sources comments at intentd [0-9a-f]{7} and cloudlands-fe [0-9a-f]{7}; 1 packages\/ios citations skipped$/m);
});

test('a fabricated missing frontend path fails in monorepo mode', t => {
  const { root } = fixture(t, { guide: `${GOOD}\n<!-- Sources: packages/cloudlands-fe/src/never-landed.ts. -->\n`, ...GOOD_FILES });
  const result = checkAt(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /assistant-app-guide\.md:4: error: packages\/cloudlands-fe\/src\/never-landed\.ts is missing at cloudlands-fe [0-9a-f]{7}/);
});

test('upstream mode warns for a missing frontend path and fails for a missing intentd path', t => {
  const frontendMiss = fixture(t, { guide: `${GOOD}<!-- Sources: packages/cloudlands-fe/src/{one,later}.ts. -->\n`, ...GOOD_FILES });
  const warned = checkAt(frontendMiss.root, '--upstream');
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stdout, /::warning::app-guide-sources: .*:3: packages\/cloudlands-fe\/src\/later\.ts \(from packages\/cloudlands-fe\/src\/\{one,later\}\.ts\) is missing/);
  assert.match(warned.stdout, /; 1 upstream warning\(s\)$/m);

  const intentdMiss = fixture(t, { guide: `${GOOD}<!-- Sources: packages/intentd/crates/x/gone.rs. -->\n`, ...GOOD_FILES });
  const failed = checkAt(intentdMiss.root, '--upstream');
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /:3: error: packages\/intentd\/crates\/x\/gone\.rs is missing at intentd/);
});

test('reads the pinned commit, not the working tree or a newer checkout HEAD', t => {
  const guide = `${GOOD}<!-- Sources: packages/cloudlands-fe/src/new.ts. -->\n`;
  const fx = fixture(t, { guide, ...GOOD_FILES });
  fx.write(fx.fe, 'src/new.ts', 'uncommitted');
  assert.equal(checkAt(fx.root).status, 1, 'an uncommitted file must not satisfy the pin');
  fx.commit(fx.fe, []);
  assert.equal(checkAt(fx.root).status, 1, 'a commit past the recorded gitlink must not satisfy the pin');
  const upstream = checkAt(fx.root, '--upstream');
  assert.equal(upstream.status, 0, upstream.stdout + upstream.stderr);
  assert.doesNotMatch(upstream.stdout, /::warning::/, 'upstream mode reads the checkout HEAD');
});

test('reads the guide from the intentd pin', t => {
  const fx = fixture(t, { guide: GOOD, ...GOOD_FILES });
  fx.write(fx.intentd, GUIDE, `${GOOD}<!-- Sources: packages/cloudlands-fe/src/nope.ts. -->\n`);
  assert.equal(checkAt(fx.root).status, 0, 'an unpinned guide edit is not checked in monorepo mode');
});

test('a missing component commit is a usage error naming the fix', t => {
  const fx = fixture(t, { guide: GOOD, ...GOOD_FILES });
  fx.run(fx.root, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},packages/cloudlands-fe`);
  fx.run(fx.root, 'commit', '-q', '-m', 'bogus pin');
  const result = checkAt(fx.root);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /git submodule update --init packages\/cloudlands-fe/);
});

test('an uninitialized submodule directory is a usage error, not the monorepo tree', t => {
  for (const args of [[], ['--upstream']]) {
    const fx = fixture(t, { guide: GOOD, ...GOOD_FILES });
    rmSync(fx.fe, { recursive: true, force: true });
    mkdirSync(fx.fe);
    const result = checkAt(fx.root, ...args);
    assert.equal(result.status, 2, `${args}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /packages\/cloudlands-fe is not a checked-out repository; run 'git submodule update --init packages\/cloudlands-fe'/);
  }
});

test('a missing guide is reported as such', t => {
  const fx = fixture(t, { guide: GOOD, ...GOOD_FILES });
  fx.run(fx.intentd, 'rm', '-q', GUIDE);
  fx.commit(fx.intentd, []);
  const result = checkAt(fx.root, '--upstream');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /assistant-app-guide\.md is missing at intentd [0-9a-f]{7}/);
});
