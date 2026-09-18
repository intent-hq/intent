import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanNodeEnv } from './test-env.mjs';
import {
  CheckError,
  HINT,
  createGitlinkReader,
  commandWords,
  compileTestGlob,
  extractCargoReferences,
  globToRegExp,
  hasTestTarget,
  isIntentdRecipe,
  isTestGlob,
  joinContinuations,
  listTestTargets,
  loadCrates,
  parseArguments,
  parseMakefile,
  parsePackageAutotests,
  parsePackageName,
  parseTestTargetNames,
  resolveGitlink,
  splitShellCommands,
  verifyInvocations,
} from './check-makefile-targets.mjs';

const words = (command) => splitShellCommands(command)[0] ?? [];

const SCRIPT = fileURLToPath(new URL('./check-makefile-targets.mjs', import.meta.url));
const SHA = 'a'.repeat(40);

// `paths` are blob paths; a directory entry is listed for every path directly
// under `treePath`, as `git ls-tree <sha> <treePath>/` would.
const fakeReader = (paths, sha = SHA) => ({
  sha,
  exists: (objectPath) => paths.includes(objectPath),
  read: () => '',
  listTree: (treePath) => {
    const prefix = `${treePath}/`;
    const entries = new Map();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const [head, ...rest] = p.slice(prefix.length).split('/');
      const type = rest.length === 0 ? 'blob' : 'tree';
      entries.set(head, { mode: type === 'tree' ? '040000' : '100644', type, path: prefix + head });
    }
    return [...entries.values()];
  },
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

test('records --workspace / --all selection alongside packages and tests', () => {
  assert.deepEqual(extractCargoReferences(words("cargo test --workspace --test '*_lint' --jobs 4")), {
    subcommand: 'test',
    packages: [],
    tests: ['*_lint'],
    workspace: true,
  });
  assert.deepEqual(extractCargoReferences(words('cargo test --all -p a --test b')), {
    subcommand: 'test',
    packages: ['a'],
    tests: ['b'],
    workspace: true,
  });
  assert.deepEqual(parseMakefile("\tcd $(INTENTD_DIR) && cargo test --workspace --test '*_lint'\n"), [
    { line: 1, subcommand: 'test', packages: [], tests: ['*_lint'], workspace: true },
  ]);
});

test('treats a --test value with glob metacharacters as a pattern', () => {
  assert.equal(isTestGlob('*_lint'), true);
  assert.equal(isTestGlob('lint_?'), true);
  assert.equal(isTestGlob('[ab]_lint'), true);
  assert.equal(isTestGlob('fixed_sleep_lint'), false);
  assert.equal(isTestGlob('quoted#missing'), false);
  const star = globToRegExp('*_lint');
  assert.equal(star.test('repo_slug_fold_lint'), true);
  assert.equal(star.test('_lint'), true);
  assert.equal(star.test('lint_foo'), false);
  assert.equal(star.test('a_lint.rs'), false);
  assert.equal(globToRegExp('lint_?').test('lint_a'), true);
  assert.equal(globToRegExp('lint_?').test('lint_ab'), false);
  assert.equal(globToRegExp('[ab]_lint').test('a_lint'), true);
  assert.equal(globToRegExp('[ab]_lint').test('c_lint'), false);
  assert.equal(globToRegExp('[!ab]_lint').test('c_lint'), true);
  assert.equal(globToRegExp('[^ab]_lint').test('^_lint'), true, '^ is an ordinary class member, not negation');
  assert.equal(globToRegExp('[^ab]_lint').test('c_lint'), false);
  assert.equal(globToRegExp('[]]_lint').test(']_lint'), true);
  assert.equal(globToRegExp('a.b*').test('aXb_'), false, 'regex metacharacters in the pattern are literal');
});

test('rejects patterns the glob crate (and therefore cargo) cannot build', () => {
  assert.equal(compileTestGlob('**').error, undefined, 'a lone ** is a whole path component');
  assert.equal(compileTestGlob('**/x_lint').error, undefined);
  assert.deepEqual(compileTestGlob('**_lint'), { error: 'recursive wildcards must form a single path component' });
  assert.deepEqual(compileTestGlob('z**'), { error: 'recursive wildcards must form a single path component' });
  assert.deepEqual(compileTestGlob('***_lint'), { error: 'wildcards are either regular `*` or recursive `**`' });
  assert.deepEqual(compileTestGlob('[_lint'), { error: 'invalid range pattern' });
  assert.deepEqual(compileTestGlob('[]_lint'), { error: 'invalid range pattern' });
  assert.deepEqual(compileTestGlob('[!]_lint'), { error: 'invalid range pattern' });
  assert.throws(() => globToRegExp('**_lint'), /cannot build glob pattern from '\*\*_lint'/);
});

test('lists auto-discovered and declared test targets of a crate', () => {
  const reader = fakeReader([
    'crates/intent-core/tests/flat.rs',
    'crates/intent-core/tests/nested/main.rs',
    'crates/intent-core/tests/helper/mod.rs',
    'crates/intent-core/tests/goldens/x.json',
    'crates/intent-core/tests/notes.txt',
  ]);
  const declared = { ...crates.get('intent-core'), cargoToml: '[package]\nname = "intent-core"\n[[test]]\nname = "declared"\n' };
  assert.deepEqual(listTestTargets(reader, declared).sort(), ['declared', 'flat', 'nested']);
  assert.deepEqual(listTestTargets(fakeReader([]), crates.get('intentd')), []);
});

test('autotests = false drops auto-discovered tests/ targets but keeps declared [[test]] targets', () => {
  assert.equal(parsePackageAutotests('[package]\nname = "x"\n'), true);
  assert.equal(parsePackageAutotests('[package]\nname = "x"\nautotests = true\n'), true);
  assert.equal(parsePackageAutotests('[package]\nname = "x"\nautotests = false # comment\n'), false);
  assert.equal(parsePackageAutotests('[package]\nname = "x"\n[lib]\nautotests = false\n'), true, 'only the [package] table counts');
  const reader = fakeReader(['crates/intent-core/tests/hidden_lint.rs', 'crates/intent-core/tests/nested_lint/main.rs']);
  const off = { ...crates.get('intent-core'), cargoToml: '[package]\nname = "intent-core"\nautotests = false\n' };
  assert.deepEqual(listTestTargets(reader, off), []);
  const offDeclared = { ...off, cargoToml: `${off.cargoToml}[[test]]\nname = "declared_lint"\npath = "tests/hidden_lint.rs"\n` };
  assert.deepEqual(listTestTargets(reader, offDeclared), ['declared_lint']);
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

test('accepts a --workspace --test glob when at least one crate has a matching target', () => {
  const invocations = [{ line: 5, subcommand: 'test', packages: [], tests: ['*_lint'], workspace: true }];
  const oneMatch = fakeReader(['crates/intentd/tests/serve_spawn_lint.rs', 'crates/intent-core/tests/common/mod.rs']);
  assert.deepEqual(verifyInvocations(invocations, crates, oneMatch), { checked: 1, failures: [] });
  const nestedMatch = fakeReader(['crates/intent-core/tests/event_type_lint/main.rs']);
  assert.deepEqual(verifyInvocations(invocations, crates, nestedMatch).failures, []);
  const declared = new Map([
    ['intent-core', { ...crates.get('intent-core'), cargoToml: '[package]\nname = "intent-core"\n[[test]]\nname = "custom_lint"\n' }],
  ]);
  assert.deepEqual(verifyInvocations(invocations, declared, fakeReader([])).failures, []);
});

test('fails a --test glob naming the pattern when no selected crate has a matching target', () => {
  const noLints = fakeReader(['crates/intent-core/tests/lint_helper.rs', 'crates/intentd/tests/e2e_guard.rs']);
  const workspace = [{ line: 5, subcommand: 'test', packages: [], tests: ['*_lint'], workspace: true }];
  assert.deepEqual(verifyInvocations(workspace, crates, noLints), {
    checked: 1,
    failures: ["Makefile:5: error: cargo test pattern '*_lint' matches no test target in any workspace crate at pinned intentd gitlink aaaaaaa"],
  });
  const scoped = [{ line: 6, subcommand: 'test', packages: ['intent-core'], tests: ['*_lint'] }];
  const onlyElsewhere = fakeReader(['crates/intentd/tests/serve_spawn_lint.rs']);
  assert.deepEqual(verifyInvocations(scoped, crates, onlyElsewhere).failures, [
    "Makefile:6: error: cargo test pattern '*_lint' matches no test target in crate 'intent-core' at pinned intentd gitlink aaaaaaa",
  ]);
  const unscoped = [{ line: 7, subcommand: 'test', packages: [], tests: ['*_lint'] }];
  assert.deepEqual(verifyInvocations(unscoped, crates, onlyElsewhere).failures, [
    "Makefile:7: error: cargo test pattern '*_lint' cannot be verified: the cargo invocation names no -p/--package crate and passes no --workspace",
  ]);
});

test('a --test glob ignores tests/ files of a crate with autotests = false unless declared as [[test]]', () => {
  const invocations = [{ line: 8, subcommand: 'test', packages: [], tests: ['*_lint'], workspace: true }];
  const reader = fakeReader(['crates/intent-core/tests/hidden_lint.rs']);
  const off = new Map([
    ['intent-core', { ...crates.get('intent-core'), cargoToml: '[package]\nname = "intent-core"\nautotests = false\n' }],
  ]);
  assert.deepEqual(verifyInvocations(invocations, off, reader), {
    checked: 1,
    failures: ["Makefile:8: error: cargo test pattern '*_lint' matches no test target in any workspace crate at pinned intentd gitlink aaaaaaa"],
  });
  const declared = new Map([
    [
      'intent-core',
      {
        ...crates.get('intent-core'),
        cargoToml: '[package]\nname = "intent-core"\nautotests = false\n[[test]]\nname = "hidden_lint"\npath = "tests/hidden_lint.rs"\n',
      },
    ],
  ]);
  assert.deepEqual(verifyInvocations(invocations, declared, reader), { checked: 1, failures: [] });
});

test('fails a cargo-invalid --test glob even when a lenient reading would match existing targets', () => {
  const reader = fakeReader(['crates/intent-core/tests/fixed_sleep_lint.rs']);
  const invocations = [
    { line: 11, subcommand: 'test', packages: [], tests: ['**_lint'], workspace: true },
    { line: 12, subcommand: 'test', packages: ['intent-core'], tests: ['[_lint'] },
  ];
  assert.deepEqual(verifyInvocations(invocations, crates, reader), {
    checked: 3,
    failures: [
      "Makefile:11: error: cargo cannot build glob pattern from '**_lint': recursive wildcards must form a single path component",
      "Makefile:12: error: cargo cannot build glob pattern from '[_lint': invalid range pattern",
    ],
  });
});

test('a literal --test name still requires an exact target, never a partial match', () => {
  const reader = fakeReader(['crates/intent-core/tests/fixed_sleep_lint.rs']);
  const partial = [{ line: 9, subcommand: 'test', packages: ['intent-core'], tests: ['sleep_lint'] }];
  assert.deepEqual(verifyInvocations(partial, crates, reader).failures, [
    "Makefile:9: error: cargo test target 'sleep_lint' (crate 'intent-core') is missing at pinned intentd gitlink aaaaaaa: crates/intent-core/tests/sleep_lint.rs not found",
  ]);
  const exact = [{ line: 9, subcommand: 'test', packages: ['intent-core'], tests: ['fixed_sleep_lint'] }];
  assert.deepEqual(verifyInvocations(exact, crates, reader).failures, []);
  const literalUnderWorkspace = [{ line: 10, subcommand: 'test', packages: [], tests: ['fixed_sleep_lint'], workspace: true }];
  assert.deepEqual(verifyInvocations(literalUnderWorkspace, crates, reader).failures, [
    "Makefile:10: error: cargo test target 'fixed_sleep_lint' cannot be verified: the cargo invocation names no -p/--package crate",
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
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: cleanNodeEnv() });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Points the parent's NODE_OPTIONS at a preload that writes to stderr, the way
// host-level tracer injection does, and restores the original env afterwards.
function withNoisyNodeOptions(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-makefile-targets-noise-'));
  const preload = path.join(dir, 'noise.cjs');
  fs.writeFileSync(preload, 'process.stderr.write("NOISE\\n");\n');
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, DD_TRACE_DEBUG: process.env.DD_TRACE_DEBUG };
  process.env.NODE_OPTIONS = `--require ${preload}`;
  process.env.DD_TRACE_DEBUG = 'true';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('cleanNodeEnv drops NODE_OPTIONS and DD_* keys without mutating process.env', (t) => {
  withNoisyNodeOptions(t);
  const env = cleanNodeEnv({ EXTRA: '1' });
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(env, 'DD_TRACE_DEBUG'), false);
  assert.deepEqual(
    Object.entries(env).filter(([key]) => key.startsWith('DD_')).sort(),
    [['DD_TRACE_ENABLED', 'false'], ['DD_TRACE_STARTUP_LOGS', 'false']],
  );
  assert.equal(env.EXTRA, '1');
  assert.equal(env.PATH, process.env.PATH);
  assert.match(process.env.NODE_OPTIONS, /--require /);
  assert.equal(process.env.DD_TRACE_DEBUG, 'true');
});

test('CLI stderr is exactly the checker output even when the host injects NODE_OPTIONS', (t) => {
  const { root, sha } = makeFixture(t);
  withNoisyNodeOptions(t);
  fs.writeFileSync(path.join(root, 'Makefile'), 'lint:\n\tcd $(INTENTD_DIR) && cargo test -p foo --test uncommitted\n');
  const result = runCli(root);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    `Makefile:2: error: cargo test target 'uncommitted' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/uncommitted.rs not found\n${HINT}\n`,
  );
});

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
      "\tcd $(INTENTD_DIR) && cargo test --workspace --test 'fl*' --jobs 4",
      "\tcd $(INTENTD_DIR) && cargo test --workspace --test 'decl?red'",
      "\tcd $(INTENTD_DIR) && cargo test -p foo --test 'nest*'",
      '',
    ].join('\n'),
  );
  const result = runCli(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `checked 28 cargo references against intentd@${sha.slice(0, 7)}\n`);
});

test('CLI exits 1 naming the Makefile line, path and pin for a missing target', (t) => {
  const { root, sha } = makeFixture(t);
  fs.writeFileSync(
    path.join(root, 'Makefile'),
    'lint:\n\tcd $(INTENTD_DIR) && cargo test -p foo --test flat # --test not_a_reference\n\tcd $(INTENTD_DIR) && \\\n\t\tcargo test -p foo --test uncommitted\n\t@cargo test --manifest-path $(INTENTD_DIR)/Cargo.toml -p foo --test silent\n\tcd $(INTENTD_DIR) && cargo test -p "foo" --test "quoted#missing"\n\tcd $(INTENTD_DIR) && cargo test -p foo -p bar-crate --test flat\n' +
      '\tif true; then \\\n\t\tcd $(INTENTD_DIR) && RUST_LOG=debug cargo test -p foo --test conditional; \\\n\tfi\n' +
      '\t(cd $(INTENTD_DIR) && cargo test -p foo --test compact_missing)\n' +
      "\tcd $(INTENTD_DIR) && cargo test --workspace --test '*_lint'\n" +
      "\tcd $(INTENTD_DIR) && cargo test -p bar-crate --test 'fl*'\n" +
      "\tcd $(INTENTD_DIR) && cargo test --workspace --test 'uncommit*'\n",
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
      `Makefile:11: error: cargo test target 'compact_missing' (crate 'foo') is missing at pinned intentd gitlink ${sha.slice(0, 7)}: crates/foo/tests/compact_missing.rs not found\n` +
      `Makefile:12: error: cargo test pattern '*_lint' matches no test target in any workspace crate at pinned intentd gitlink ${sha.slice(0, 7)}\n` +
      `Makefile:13: error: cargo test pattern 'fl*' matches no test target in crate 'bar-crate' at pinned intentd gitlink ${sha.slice(0, 7)}\n` +
      `Makefile:14: error: cargo test pattern 'uncommit*' matches no test target in any workspace crate at pinned intentd gitlink ${sha.slice(0, 7)}\n${HINT}\n`,
  );
});
