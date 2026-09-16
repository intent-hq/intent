#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_INTENTD_DIR = 'packages/intentd';
export const CARGO_SUBCOMMANDS = new Set(['test', 'run', 'build', 'clippy', 'nextest', 'check', 'bench']);
export const HINT =
  'hint: the referenced artifact probably lives on an unmerged intentd branch; merge the intentd PR and wait for auto-bump-submodules to advance the pin before landing this monorepo change.';

const USAGE = 'usage: check-makefile-targets.mjs [--makefile <path>] [--gitlink <sha>] [--intentd-dir <path>]';
const INTENTD_MANIFEST = '$(INTENTD_DIR)/Cargo.toml';
const SHELL_OPERATORS = ['&&', '||', ';', '|'];
const SHELL_GROUP_OPENERS = new Set(['{', '(']);
const SHELL_GROUP_CLOSERS = new Set(['}', ')']);
const SHELL_PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', ...SHELL_GROUP_OPENERS]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TOML_HEADER = /^(\[\[?)\s*([^\]\s]+)\s*\]\]?\s*(?:#.*)?$/;
const TOML_NAME = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/;

export class CheckError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Make joins a backslash-newline (plus the next line's leading whitespace) into a
// single space; each logical line keeps the number of its first physical line.
export function joinContinuations(text) {
  const logical = [];
  let current = null;
  String(text ?? '')
    .split('\n')
    .forEach((physical, index) => {
      if (current === null) current = { line: index + 1, text: '' };
      const piece = current.text === '' ? physical : physical.replace(/^\s+/, '');
      if (physical.endsWith('\\')) {
        current.text += `${piece.slice(0, -1).trimEnd()} `;
        return;
      }
      current.text += piece;
      logical.push(current);
      current = null;
    });
  if (current !== null) logical.push(current);
  return logical;
}

// The recipe body without the tab and Make's leading `@` / `-` / `+` flags.
export function recipeBody(logicalText) {
  return logicalText.slice(1).replace(/^[\s@\-+]+/, '');
}

// Length of the `$(...)`, `$$(...)` or `$((...))` expansion starting at `start`
// (its parentheses balanced), or 0 when `$` is not followed by `(`.
function expansionLength(text, start) {
  let i = start;
  while (text[i] === '$') i += 1;
  if (text[i] !== '(') return 0;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && (depth -= 1) === 0) return i + 1 - start;
  }
  return text.length - start;
}

// Splits a shell line into simple commands (on unquoted `&&`, `||`, `;`, `|`),
// each a list of words with their quoting removed. Single quotes are literal,
// double quotes honour backslash escapes of `"` `\` `$` and backquote, and an
// unquoted backslash escapes the next character. An unquoted `#` at a word
// boundary starts a comment that runs to the end of the line. Unquoted `(` and
// `)` are words of their own (subshell delimiters) unless they belong to a
// `$(...)` / `$$(...)` / `$((...))` expansion, which stays inside its word.
export function splitShellCommands(text) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (char === '"') {
      inWord = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) i += 1;
        word += text[i];
        i += 1;
      }
      i += 1;
    } else if (char === '\\') {
      word += text[i + 1] ?? '';
      inWord = true;
      i += 2;
    } else if (/\s/.test(char)) {
      endWord();
      i += 1;
    } else if (char === '#' && !inWord) {
      break;
    } else if (char === '$' && expansionLength(text, i) > 0) {
      const length = expansionLength(text, i);
      word += text.slice(i, i + length);
      inWord = true;
      i += length;
    } else if (char === '(' || char === ')') {
      endWord();
      words.push(char);
      i += 1;
    } else {
      const operator = SHELL_OPERATORS.find((candidate) => text.startsWith(candidate, i));
      if (operator) {
        endCommand();
        i += operator.length;
      } else {
        word += char;
        inWord = true;
        i += 1;
      }
    }
  }
  endCommand();
  return commands;
}

// The simple commands a recipe line runs, with Make flags and comments removed;
// `null` for non-recipe lines.
export function recipeCommands(logicalText) {
  if (!logicalText.startsWith('\t')) return null;
  return splitShellCommands(recipeBody(logicalText));
}

// A simple command from its command name on: leading shell reserved words,
// group openers and NAME=value assignments are skipped, as are trailing group
// closers.
export function commandWords(words) {
  let start = 0;
  while (start < words.length && (SHELL_PREFIX_WORDS.has(words[start]) || SHELL_ASSIGNMENT.test(words[start]))) start += 1;
  let end = words.length;
  while (end > start && SHELL_GROUP_CLOSERS.has(words[end - 1])) end -= 1;
  return words.slice(start, end);
}

// A command is rooted in intentd when it is `cd $(INTENTD_DIR)` or passes
// `--manifest-path $(INTENTD_DIR)/Cargo.toml`.
export function isIntentdRootedCommand(words) {
  const command = commandWords(words);
  if (command[0] === 'cd' && command[1] === '$(INTENTD_DIR)') return true;
  return command.some(
    (word, index) =>
      word === `--manifest-path=${INTENTD_MANIFEST}` || (word === '--manifest-path' && command[index + 1] === INTENTD_MANIFEST),
  );
}

export function isIntentdRecipe(logicalText) {
  const commands = recipeCommands(logicalText);
  return commands !== null && commands.some(isIntentdRootedCommand);
}

// Arguments after a bare `--` belong to the invoked binary and are skipped; an
// echoed `cargo ...` hint is text, not an invocation.
export function extractCargoReferences(words) {
  const command = commandWords(words);
  const cargoIndex = command.indexOf('cargo');
  if (cargoIndex === -1) return null;
  if (command.slice(0, cargoIndex).includes('echo')) return null;
  const subcommand = command.slice(cargoIndex + 1).find((word) => !word.startsWith('+'));
  if (!CARGO_SUBCOMMANDS.has(subcommand)) return null;
  const packages = [];
  const tests = [];
  for (let i = cargoIndex + 1; i < command.length; i += 1) {
    const word = command[i];
    if (word === '--') break;
    if (word === '-p' || word === '--package') {
      if (command[i + 1] !== undefined) packages.push(command[(i += 1)]);
    } else if (word.startsWith('--package=')) {
      packages.push(word.slice('--package='.length));
    } else if (word === '--test') {
      if (command[i + 1] !== undefined) tests.push(command[(i += 1)]);
    } else if (word.startsWith('--test=')) {
      tests.push(word.slice('--test='.length));
    }
  }
  return { subcommand, packages, tests };
}

export function parseMakefile(text) {
  const invocations = [];
  for (const { line, text: logical } of joinContinuations(text)) {
    const commands = recipeCommands(logical);
    if (commands === null || !commands.some(isIntentdRootedCommand)) continue;
    for (const words of commands) {
      const references = extractCargoReferences(words);
      if (references) invocations.push({ line, ...references });
    }
  }
  return invocations;
}

function tomlSections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const header = TOML_HEADER.exec(line);
    if (header) {
      current = { name: header[2], array: header[1] === '[[', lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function sectionName(section) {
  for (const line of section.lines) {
    const match = TOML_NAME.exec(line);
    if (match) return match[1] ?? match[2];
  }
  return undefined;
}

export function parsePackageName(cargoToml) {
  const section = tomlSections(cargoToml).find((candidate) => candidate.name === 'package' && !candidate.array);
  return section ? sectionName(section) : undefined;
}

export function parseTestTargetNames(cargoToml) {
  return tomlSections(cargoToml)
    .filter((section) => section.name === 'test' && section.array)
    .map(sectionName)
    .filter((name) => name !== undefined);
}

function git(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Only git object access at the gitlink: never the submodule working tree, so a
// locally advanced or dirty checkout cannot mask a stale pin.
export function createGitlinkReader(sha, { cwd = process.cwd(), intentdDir = DEFAULT_INTENTD_DIR } = {}) {
  const run = (args) => git(['-C', path.resolve(cwd, intentdDir), ...args]);
  return {
    sha,
    exists(objectPath) {
      try {
        run(['cat-file', '-e', `${sha}:${objectPath}`]);
        return true;
      } catch {
        return false;
      }
    },
    read(objectPath) {
      return run(['cat-file', '-p', `${sha}:${objectPath}`]);
    },
    listTree(treePath) {
      return run(['ls-tree', sha, `${treePath}/`])
        .split('\n')
        .filter(Boolean)
        .map((entry) => {
          const [meta, entryPath] = entry.split('\t');
          const [mode, type] = meta.split(' ');
          return { mode, type, path: entryPath };
        });
    },
  };
}

export function resolveGitlink({ cwd = process.cwd(), intentdDir = DEFAULT_INTENTD_DIR, gitlink } = {}) {
  let requested = gitlink;
  if (!requested) {
    try {
      requested = git(['rev-parse', `HEAD:${intentdDir}`], { cwd }).trim();
    } catch {
      throw new CheckError(`error: cannot read the ${intentdDir} gitlink from HEAD; run from the monorepo root`);
    }
  }
  try {
    return git(['-C', path.resolve(cwd, intentdDir), 'rev-parse', '--verify', '--quiet', `${requested}^{commit}`], {
      cwd,
    }).trim();
  } catch {
    throw new CheckError(
      `error: intentd gitlink ${requested} is not present in ${intentdDir}; run 'git submodule update --init ${intentdDir}' (or 'git -C ${intentdDir} fetch origin ${requested}') and retry`,
    );
  }
}

export function loadCrates(reader) {
  const crates = new Map();
  for (const entry of reader.listTree('crates')) {
    if (entry.type !== 'tree') continue;
    const manifest = `${entry.path}/Cargo.toml`;
    if (!reader.exists(manifest)) continue;
    const cargoToml = reader.read(manifest);
    const name = parsePackageName(cargoToml);
    if (name) crates.set(name, { name, dir: entry.path, cargoToml });
  }
  return crates;
}

export function testTargetCandidates(dir, name) {
  return [`${dir}/tests/${name}.rs`, `${dir}/tests/${name}/main.rs`];
}

export function hasTestTarget(reader, crate, name) {
  if (parseTestTargetNames(crate.cargoToml).includes(name)) return true;
  return testTargetCandidates(crate.dir, name).some((candidate) => reader.exists(candidate));
}

export function verifyInvocations(invocations, crates, reader, { makefile = 'Makefile' } = {}) {
  const sha7 = reader.sha.slice(0, 7);
  const failures = [];
  let checked = 0;
  for (const { line, packages, tests } of invocations) {
    const resolved = [];
    for (const name of packages) {
      checked += 1;
      const crate = crates.get(name);
      if (crate) resolved.push(crate);
      else {
        failures.push(
          `${makefile}:${line}: error: cargo package '${name}' is unknown at pinned intentd gitlink ${sha7}: no crates/*/Cargo.toml declares [package] name = "${name}"`,
        );
      }
    }
    for (const test of tests) {
      checked += 1;
      if (packages.length === 0) {
        failures.push(
          `${makefile}:${line}: error: cargo test target '${test}' cannot be verified: the cargo invocation names no -p/--package crate`,
        );
      } else {
        // cargo applies a named --test target to every selected package.
        for (const crate of resolved) {
          if (hasTestTarget(reader, crate, test)) continue;
          failures.push(
            `${makefile}:${line}: error: cargo test target '${test}' (crate '${crate.name}') is missing at pinned intentd gitlink ${sha7}: ${crate.dir}/tests/${test}.rs not found`,
          );
        }
      }
    }
  }
  return { checked, failures };
}

export function parseArguments(argv) {
  const options = { makefile: 'Makefile', intentdDir: DEFAULT_INTENTD_DIR, gitlink: undefined };
  const keys = { makefile: 'makefile', gitlink: 'gitlink', 'intentd-dir': 'intentdDir' };
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--(makefile|gitlink|intentd-dir)(?:=(.*))?$/s.exec(argv[i]);
    const value = match ? (match[2] ?? argv[(i += 1)]) : undefined;
    if (value === undefined) throw new CheckError(USAGE);
    options[keys[match[1]]] = value;
  }
  return options;
}

async function readMakefile(makefile) {
  try {
    return await fs.readFile(makefile, 'utf8');
  } catch (error) {
    throw new CheckError(`error: cannot read ${makefile}: ${error.message}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const invocations = parseMakefile(await readMakefile(options.makefile));
  const sha = resolveGitlink(options);
  const reader = createGitlinkReader(sha, options);
  const { checked, failures } = verifyInvocations(invocations, loadCrates(reader), reader, options);
  if (failures.length === 0) {
    console.log(`checked ${checked} cargo references against intentd@${sha.slice(0, 7)}`);
    return;
  }
  for (const failure of failures) console.error(failure);
  console.error(HINT);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(error.message);
    process.exitCode = error.exitCode;
  }
}
