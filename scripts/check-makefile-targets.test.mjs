import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CheckError,
  HINT,
  createGitlinkReader,
  commandWords,
  extractCargoReferences,
  hasTestTarget,
  isIntentdRecipe,
  joinContinuations,
  loadCrates,
  parseArguments,
  parseMakefile,
  parsePackageName,
  parseTestTargetNames,
  resolveGitlink,
  splitShellCommands,
  verifyInvocations,
} from './check-makefile-targets.mjs';

const words = (command) => splitShellCommands(command)[0] ?? [];

const SCRIPT = fileURLToPath(new URL('./check-makefile-targets.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

const fakeReader = (paths, sha = SHA) => ({
  sha,
  exists: (objectPath) => paths.includes(objectPath),
  read: () => '',
  listTree: () => [],
});

const crates = new Map([
  ['intent-core', { name: 'intent-core', dir: 'crates/intent-core', cargoToml: '[package]\nname = "intent-core"\n' }],
  ['intentd', { name: 'intentd', dir: 'crates/intentd', cargoToml: '[package]\nname = "intentd"\n' }],
]);

test('joins backslash continuations and keeps the first physical line number', () => {
  const text = 'a: b\n\tcd $(INTENTD_DIR) && \\\n\t\tcargo test -p x \\\n\t\t--test y\nnext: c\n';
  assert.deepEqual(joinContinuations(text), [
    { line: 1, text: 'a: b' },
    { line: 2, text: '\tcd $(INTENTD_DIR) && cargo test -p x --test y' },
    { line: 5, text: 'next: c' },
    { line: 6, text: '' },
  ]);
});

test('detects only tab-indented recipe lines rooted in INTENTD_DIR', () => {
  const makefile = [
    'RUSTUP_CARGO = $(shell cd $(INTENTD_DIR) && cargo test -p ignored --test ignored)',
    '# cd $(INTENTD_DIR) && cargo test -p ignored --test ignored',
    'lint: ensure-intentd-submodule',
    '\t# cd $(INTENTD_DIR) && cargo test -p ignored --test ignored',
    '\tcd $(FE_DIR) && cargo test -p ignored --test ignored',
    '\tcargo test -p ignored --test ignored',
    '\t@cd $(INTENTD_DIR) && cargo test -p intent-core --test repo_slug_fold_lint --jobs 4',
    '\t@echo "    cargo run -p ignored --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve"',
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 7, subcommand: 'test', packages: ['intent-core'], tests: ['repo_slug_fold_lint'] },
  ]);
});

test('records the first physical line of a continued recipe', () => {
  const makefile = 'lint:\n\tcd $(INTENTD_DIR) && \\\n\t\tcargo test -p intent-core \\\n\t\t--test event_type_lint\n';
  assert.deepEqual(parseMakefile(makefile), [
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['event_type_lint'] },
  ]);
});

test('extracts -p, --package, --package=, --test and --test= forms', () => {
  assert.deepEqual(extractCargoReferences(words('cargo test -p a --package b --package=c --test x --test=y --jobs 4')), {
    subcommand: 'test',
    packages: ['a', 'b', 'c'],
    tests: ['x', 'y'],
  });
  assert.deepEqual(extractCargoReferences(words('cargo run -q -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- --test z')), {
    subcommand: 'run',
    packages: ['intentd'],
    tests: [],
  });
  assert.equal(extractCargoReferences(words('cargo fmt --check')), null);
  assert.equal(extractCargoReferences(words('rustup which cargo')), null);
});

test('tokenizes shell words quote-aware and splits on unquoted operators', () => {
  assert.deepEqual(splitShellCommands(`cd "$(INTENTD_DIR)" && cargo test -p 'intent-core' --test "fixed_sleep_lint"`), [
    ['cd', '$(INTENTD_DIR)'],
    ['cargo', 'test', '-p', 'intent-core', '--test', 'fixed_sleep_lint'],
  ]);
  assert.deepEqual(splitShellCommands('echo "a && b ; c | d" ; true || false | cat'), [
    ['echo', 'a && b ; c | d'],
    ['true'],
    ['false'],
    ['cat'],
  ]);
  assert.deepEqual(splitShellCommands(`printf '%s\\n' "say \\"hi\\" \\$x" it\\'s "" x`), [
    ['printf', '%s\\n', 'say "hi" $x', "it's", '', 'x'],
  ]);
});

test('resolves quoted -p / --test / --package= / --test= values without their quotes', () => {
  const makefile = [
    `\tcd "$(INTENTD_DIR)" && cargo test -p 'intent-core' --test "fixed_sleep_lint"`,
    `\tcd $(INTENTD_DIR) && cargo test --package="intent-core" --test='event_type_lint'`,
    `\tcargo build --manifest-path "$(INTENTD_DIR)/Cargo.toml" -p "intentd"`,
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 1, subcommand: 'test', packages: ['intent-core'], tests: ['fixed_sleep_lint'] },
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['event_type_lint'] },
    { line: 3, subcommand: 'build', packages: ['intentd'], tests: [] },
  ]);
});

test('detects roots and cargo after shell control keywords, group openers and env assignments', () => {
  assert.deepEqual(commandWords(['then', 'RUST_LOG=debug', 'cargo', 'test', 'A=1']), ['cargo', 'test', 'A=1']);
  assert.deepEqual(commandWords(['{', 'cd', '$(INTENTD_DIR)']), ['cd', '$(INTENTD_DIR)']);
  assert.deepEqual(commandWords(['echo', 'then']), ['echo', 'then']);
  const makefile = [
    'lint:',
    '\tif true; then cd $(INTENTD_DIR) && cargo test -p intent-core --test does_not_exist; fi',
    '\t{ cd $(INTENTD_DIR) && cargo test -p intent-core --test grouped; }',
    '\t( cd $(INTENTD_DIR) && cargo test -p intent-core --test subshell )',
    '\tcd $(INTENTD_DIR) && RUST_LOG=debug CARGO_TERM_COLOR=always cargo test -p intent-core --test env_prefixed',
    '\tif test -d x; then RUST_LOG=debug cargo test --manifest-path $(INTENTD_DIR)/Cargo.toml -p intentd --test manifest_prefixed; fi',
    '\twhile true; do ! cd $(INTENTD_DIR) && cargo build -p intentd; done',
    '\tif true; then echo "cd $(INTENTD_DIR) && cargo test -p nonexistent --test missing"; fi',
    "\t{ echo 'cd $(INTENTD_DIR) && cargo test -p nonexistent --test missing'; }",
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['does_not_exist'] },
    { line: 3, subcommand: 'test', packages: ['intent-core'], tests: ['grouped'] },
    { line: 4, subcommand: 'test', packages: ['intent-core'], tests: ['subshell'] },
    { line: 5, subcommand: 'test', packages: ['intent-core'], tests: ['env_prefixed'] },
    { line: 6, subcommand: 'test', packages: ['intentd'], tests: ['manifest_prefixed'] },
    { line: 7, subcommand: 'build', packages: ['intentd'], tests: [] },
  ]);
});

test('keeps $(...), $$(...) and $((...)) expansions as single words', () => {
  assert.deepEqual(words('cargo run --manifest-path $(INTENTD_DIR)/Cargo.toml -- $$(pwd)/x $(shell echo $(A)) $((1+2)) \\( "(y)"'), [
    'cargo',
    'run',
    '--manifest-path',
    '$(INTENTD_DIR)/Cargo.toml',
    '--',
    '$$(pwd)/x',
    '$(shell echo $(A))',
    '$((1+2))',
    '(',
    '(y)',
  ]);
  assert.deepEqual(parseMakefile('\tcd $(INTENTD_DIR) && cargo test -p intent-core --test $$(basename $(shell pwd))\n'), [
    { line: 1, subcommand: 'test', packages: ['intent-core'], tests: ['$$(basename $(shell pwd))'] },
  ]);
});

test('tokenizes unquoted subshell parentheses as delimiters regardless of surrounding whitespace', () => {
  assert.deepEqual(splitShellCommands('(cd $(INTENTD_DIR) && cargo test -p intent-core --test compact)'), [
    ['(', 'cd', '$(INTENTD_DIR)'],
    ['cargo', 'test', '-p', 'intent-core', '--test', 'compact', ')'],
  ]);
  assert.deepEqual(commandWords(['(', 'cargo', 'test', '--test', 'x', ')', ')']), ['cargo', 'test', '--test', 'x']);
  const makefile = [
    'lint:',
    '\t(cd $(INTENTD_DIR) && cargo test -p intent-core --test does_not_exist)',
    '\t( cd $(INTENTD_DIR) && cargo test -p intent-core --test fixed_sleep_lint)',
    '\t(cd $(INTENTD_DIR)&&cargo test -p intent-core --test compact_operator)',
    '\t(echo "(cd $(INTENTD_DIR) && cargo test -p nonexistent --test missing)")',
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['does_not_exist'] },
    { line: 3, subcommand: 'test', packages: ['intent-core'], tests: ['fixed_sleep_lint'] },
    { line: 4, subcommand: 'test', packages: ['intent-core'], tests: ['compact_operator'] },
  ]);
});

test('quoted text inside echo / printf arguments is inert', () => {
  const makefile = [
    '\t@echo "cd $(INTENTD_DIR) && cargo test -p intent-core --test nope"',
    `\t@printf '%s\\n' 'cd $(INTENTD_DIR) && cargo test -p nonexistent --test missing'`,
    '\tcd $(INTENTD_DIR) && echo "cargo test -p nonexistent --test missing" && cargo test -p intent-core --test real',
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [{ line: 3, subcommand: 'test', packages: ['intent-core'], tests: ['real'] }]);
});

test('accepts the --manifest-path form and multiple invocations on one recipe line', () => {
  const makefile = '\tcargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- doctor && cargo build -p intent-core\n';
  assert.deepEqual(parseMakefile(makefile), [
    { line: 1, subcommand: 'run', packages: ['intentd'], tests: [] },
    { line: 1, subcommand: 'build', packages: ['intent-core'], tests: [] },
  ]);
});

test('strips Make recipe flags so @cargo / -cargo invocations are still extracted', () => {
  const makefile = [
    'lint:',
    '\t@cargo test --manifest-path $(INTENTD_DIR)/Cargo.toml -p intent-core --test does_not_exist',
    '\t-cd $(INTENTD_DIR) && cargo test -p intent-core --test other',
    '\t+@cd $(INTENTD_DIR) && cargo build -p intentd',
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['does_not_exist'] },
    { line: 3, subcommand: 'test', packages: ['intent-core'], tests: ['other'] },
    { line: 4, subcommand: 'build', packages: ['intentd'], tests: [] },
  ]);
});

test('ignores unquoted inline shell comments but keeps quoted arguments', () => {
  assert.deepEqual(words('cargo test -p a --test b # --test c'), ['cargo', 'test', '-p', 'a', '--test', 'b']);
  assert.deepEqual(words('cargo test -p a --test "b # c"'), ['cargo', 'test', '-p', 'a', '--test', 'b # c']);
  assert.deepEqual(words("echo 'x # y' # z"), ['echo', 'x # y']);
  assert.deepEqual(words('cargo test -p a --test b#c'), ['cargo', 'test', '-p', 'a', '--test', 'b#c']);
  assert.deepEqual(words('cargo test -p a --test b\\#c'), ['cargo', 'test', '-p', 'a', '--test', 'b#c']);
  assert.deepEqual(parseMakefile('\tcd $(INTENTD_DIR) && cargo test -p intent-core --test real # --test does_not_exist\n'), [
    { line: 1, subcommand: 'test', packages: ['intent-core'], tests: ['real'] },
  ]);
});

test('recognizes a comment starting right after a shell operator', () => {
  assert.deepEqual(splitShellCommands('true;# cargo test -p intent-core --test nope'), [['true']]);
  assert.deepEqual(splitShellCommands('a &&# b\n'), [['a']]);
  assert.deepEqual(splitShellCommands('a |# b'), [['a']]);
  const makefile = [
    '\tcd $(INTENTD_DIR) && cargo test -p intent-core --test fixed_sleep_lint;# cargo test -p nonexistent --test missing',
    '\tcd $(INTENTD_DIR) && cargo test -p intent-core --test real && true;# cargo test -p intent-core --test nope',
    '',
  ].join('\n');
  assert.deepEqual(parseMakefile(makefile), [
    { line: 1, subcommand: 'test', packages: ['intent-core'], tests: ['fixed_sleep_lint'] },
    { line: 2, subcommand: 'test', packages: ['intent-core'], tests: ['real'] },
  ]);
});

test('ignores INTENTD_DIR root markers that only appear inside a shell comment', () => {
  const commentedCd = '\tcargo test -p unrelated --test other # cd $(INTENTD_DIR) && cargo test -p intent-core --test commented\n';
  const commentedManifest = '\tcargo test -p unrelated --test other # --manifest-path $(INTENTD_DIR)/Cargo.toml\n';
  const fullyCommented = '\t# cd $(INTENTD_DIR) && cargo test -p intent-core --test commented\n';
  assert.equal(isIntentdRecipe(commentedCd.trimEnd()), false);
  assert.equal(isIntentdRecipe(commentedManifest.trimEnd()), false);
  assert.equal(isIntentdRecipe(fullyCommented.trimEnd()), false);
  assert.deepEqual(parseMakefile(commentedCd + commentedManifest + fullyCommented), []);
});

test('accepts TOML table headers with trailing comments', () => {
  assert.equal(parsePackageName('[package] # comment\nname = "intent-core"\n'), 'intent-core');
  assert.deepEqual(parseTestTargetNames('[package]\nname="intent-core"\n[[test]] # comment\nname="declared"\n'), ['declared']);
});

test('reads the package name and [[test]] target names from Cargo.toml', () => {
  const toml = '[package]\nname = "intent-core"\nversion = "1.0.0"\n\n[[test]]\nname = "custom"\npath = "src/lint.rs"\n\n[[test]]\nname = \'other\'\n\n[dependencies]\nname = "not-a-test"\n';
  assert.equal(parsePackageName(toml), 'intent-core');
  assert.deepEqual(parseTestTargetNames(toml), ['custom', 'other']);
  assert.equal(parsePackageName('[dependencies]\nname = "x"\n'), undefined);
});

test('reports an unknown crate', () => {
  const invocations = [{ line: 12, subcommand: 'test', packages: ['nope'], tests: ['lint'] }];
  const { checked, failures } = verifyInvocations(invocations, crates, fakeReader([]));
  assert.equal(checked, 2);
  assert.deepEqual(failures, [
    `Makefile:12: error: cargo package 'nope' is unknown at pinned intentd gitlink aaaaaaa: no crates/*/Cargo.toml declares [package] name = "nope"`,
  ]);
});

test('reports a missing test file with the expected path', () => {
  const invocations = [{ line: 413, subcommand: 'test', packages: ['intent-core'], tests: ['fixed_sleep_lint'] }];
  const { failures } = verifyInvocations(invocations, crates, fakeReader([]), { makefile: 'Makefile' });
  assert.deepEqual(failures, [
    "Makefile:413: error: cargo test target 'fixed_sleep_lint' (crate 'intent-core') is missing at pinned intentd gitlink aaaaaaa: crates/intent-core/tests/fixed_sleep_lint.rs not found",
  ]);
});

test('accepts tests/<name>.rs, tests/<name>/main.rs and [[test]] name forms', () => {
  const reader = fakeReader(['crates/intent-core/tests/flat.rs', 'crates/intent-core/tests/nested/main.rs']);
  const core = crates.get('intent-core');
  assert.equal(hasTestTarget(reader, core, 'flat'), true);
  assert.equal(hasTestTarget(reader, core, 'nested'), true);
  assert.equal(hasTestTarget(reader, core, 'absent'), false);
  const declared = { ...core, cargoToml: '[package]\nname = "intent-core"\n[[test]]\nname = "declared"\n' };
  assert.equal(hasTestTarget(fakeReader([]), declared, 'declared'), true);
});

test('requires a --test target in every selected package, reporting each crate that lacks it', () => {
  const invocations = [{ line: 8, subcommand: 'test', packages: ['intent-core', 'intentd'], tests: ['lint'] }];
  const onlyCore = fakeReader(['crates/intent-core/tests/lint.rs']);
  assert.deepEqual(verifyInvocations(invocations, crates, onlyCore), {
    checked: 3,
    failures: [
      "Makefile:8: error: cargo test target 'lint' (crate 'intentd') is missing at pinned intentd gitlink aaaaaaa: crates/intentd/tests/lint.rs not found",
    ],
  });
  const onlyIntentd = fakeReader(['crates/intentd/tests/lint/main.rs']);
  assert.deepEqual(verifyInvocations(invocations, crates, onlyIntentd).failures, [
    "Makefile:8: error: cargo test target 'lint' (crate 'intent-core') is missing at pinned intentd gitlink aaaaaaa: crates/intent-core/tests/lint.rs not found",
  ]);
  assert.deepEqual(verifyInvocations(invocations, crates, fakeReader([])).failures, [
    "Makefile:8: error: cargo test target 'lint' (crate 'intent-core') is missing at pinned intentd gitlink aaaaaaa: crates/intent-core/tests/lint.rs not found",
    "Makefile:8: error: cargo test target 'lint' (crate 'intentd') is missing at pinned intentd gitlink aaaaaaa: crates/intentd/tests/lint.rs not found",
  ]);
  const both = fakeReader(['crates/intent-core/tests/lint.rs', 'crates/intentd/tests/lint.rs']);
  assert.deepEqual(verifyInvocations(invocations, crates, both).failures, []);
});

test('fails a --test reference without a crate on the same invocation', () => {
  const invocations = [{ line: 3, subcommand: 'test', packages: [], tests: ['lint'] }];
  const { failures } = verifyInvocations(invocations, crates, fakeReader([]));
  assert.deepEqual(failures, [
    "Makefile:3: error: cargo test target 'lint' cannot be verified: the cargo invocation names no -p/--package crate",
  ]);
});

test('parses CLI arguments', () => {
  assert.deepEqual(parseArguments(['--gitlink', 'abc', '--makefile=other/Makefile']), {
    makefile: 'other/Makefile',
    intentdDir: 'packages/intentd',
    gitlink: 'abc',
  });
  assert.throws(() => parseArguments(['--bogus']), CheckError);
  assert.throws(() => parseArguments(['--gitlink']), CheckError);
});

// Builds a throwaway "monorepo" whose packages/intentd gitlink points at a
// nested throwaway intentd repo containing crates/foo and crates/bar.
function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-makefile-targets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
  const intentd = path.join(root, 'packages', 'intentd');
  fs.mkdirSync(intentd, { recursive: true });
  git(intentd, 'init', '-q', '-b', 'main');
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(intentd, relative)), { recursive: true });
    fs.writeFileSync(path.join(intentd, relative), content);
  };
  write('crates/foo/Cargo.toml', '[package]\nname = "foo"\n');
  write('crates/foo/tests/flat.rs', '');
  write('crates/foo/tests/nested/main.rs', '');
  write('crates/foo/tests/common.rs', '');
  write('crates/bar/Cargo.toml', '[package]\nname = "bar-crate"\n\n[[test]]\nname = "declared"\npath = "src/x.rs"\n');
  write('crates/bar/tests/common.rs', '');
  write('crates/README.md', '');
  git(intentd, 'add', '.');
  git(intentd, 'commit', '-q', '-m', 'pin');
  const sha = git(intentd, 'rev-parse', 'HEAD').trim();
  // Only the working tree has this file; the pin must not see it.
  write('crates/foo/tests/uncommitted.rs', '');

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${sha},packages/intentd`);
  git(root, 'commit', '-q', '-m', 'monorepo');
  return { root, intentd, sha, git };
}

function runCli(cwd, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('resolves the gitlink from HEAD and reads crates through git objects only', (t) => {
  const { root, sha } = makeFixture(t);
  assert.equal(resolveGitlink({ cwd: root }), sha);
  assert.equal(resolveGitlink({ cwd: root, gitlink: sha.slice(0, 8) }), sha);
  const reader = createGitlinkReader(sha, { cwd: root });
  const found = loadCrates(reader);
  assert.deepEqual([...found.keys()].sort(), ['bar-crate', 'foo']);
  assert.equal(found.get('foo').dir, 'crates/foo');
  assert.equal(hasTestTarget(reader, found.get('foo'), 'flat'), true);
  assert.equal(hasTestTarget(reader, found.get('foo'), 'nested'), true);
  assert.equal(hasTestTarget(reader, found.get('bar-crate'), 'declared'), true);
  assert.equal(hasTestTarget(reader, found.get('foo'), 'uncommitted'), false, 'working tree must not be consulted');
});

test('exits 2 with a submodule hint when the gitlink object is absent', (t) => {
  const { root } = makeFixture(t);
  const missing = '1'.repeat(40);
  assert.throws(
    () => resolveGitlink({ cwd: root, gitlink: missing }),
    (error) => error instanceof CheckError && error.exitCode === 2 && error.message.includes('git submodule update --init packages/intentd'),
  );
  fs.writeFileSync(path.join(root, 'Makefile'), 'lint:\n\tcd $(INTENTD_DIR) && cargo test -p foo --test flat\n');
  const result = runCli(root, '--gitlink', missing);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /is not present in packages\/intentd/);
  assert.match(result.stderr, /git submodule update --init packages\/intentd/);
});

test('CLI prints the success summary on a Makefile whose references exist at the pin', (t) => {
  const { root, sha } = makeFixture(t);
  fs.writeFileSync(
    path.join(root, 'Makefile'),
    [
      'lint:',
      '\tcd $(INTENTD_DIR) && cargo test -p foo --test flat',
      '\tcd $(INTENTD_DIR) && cargo test -p foo --test=nested',
      '\tcargo run -p bar-crate --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve',
      `\tcd "$(INTENTD_DIR)" && cargo test -p 'foo' --test "flat" && cargo test --package="bar-crate" --test='declared'`,
      '\t@echo "cd $(INTENTD_DIR) && cargo test -p nonexistent --test missing"',
      '\tcd $(INTENTD_DIR) && cargo test -p foo --test flat;# cargo test -p nonexistent --test missing',
      '\tcd $(INTENTD_DIR) && cargo test -p foo --test flat && true;# cargo test -p foo --test nope',
      '\tcd $(INTENTD_DIR) && cargo test -p foo -p bar-crate --test common',
      '\tif true; then cd $(INTENTD_DIR) && RUST_LOG=debug cargo test -p foo --test flat; fi',
      '\t{ cd $(INTENTD_DIR) && cargo test -p bar-crate --test declared; }',
      '\t( cd $(INTENTD_DIR) && cargo test -p foo --test flat)',
      '\t(cd $(INTENTD_DIR) && cargo test -p bar-crate --test declared)',
      '',
    ].join('\n'),
  );
  const result = runCli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `checked 24 cargo references against intentd@${sha.slice(0, 7)}\n`);
});

test('CLI exits 1 naming the Makefile line, path and pin for a missing target', (t) => {
  const { root, sha } = makeFixture(t);
  fs.writeFileSync(
    path.join(root, 'Makefile'),
    'lint:\n\tcd $(INTENTD_DIR) && cargo test -p foo --test flat # --test not_a_reference\n\tcd $(INTENTD_DIR) && \\\n\t\tcargo test -p foo --test uncommitted\n\t@cargo test --manifest-path $(INTENTD_DIR)/Cargo.toml -p foo --test silent\n\tcd $(INTENTD_DIR) && cargo test -p "foo" --test "quoted#missing"\n\tcd $(INTENTD_DIR) && cargo test -p foo -p bar-crate --test flat\n' +
      '\tif true; then \\\n\t\tcd $(INTENTD_DIR) && RUST_LOG=debug cargo test -p foo --test conditional; \\\n\tfi\n' +
      '\t(cd $(INTENTD_DIR) && cargo test -p foo --test compact_missing)\n',
  );
  const result = runCli(root);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    `Makefile:3: error: cargo test target 'uncommitted' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/uncommitted.rs not found\n` +
      `Makefile:5: error: cargo test target 'silent' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/silent.rs not found\n` +
      `Makefile:6: error: cargo test target 'quoted#missing' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/quoted#missing.rs not found\n` +
      `Makefile:7: error: cargo test target 'flat' (crate 'bar-crate') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/bar/tests/flat.rs not found\n` +
      `Makefile:8: error: cargo test target 'conditional' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/conditional.rs not found\n` +
      `Makefile:11: error: cargo test target 'compact_missing' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/compact_missing.rs not found\n${HINT}\n`,
  );
});
