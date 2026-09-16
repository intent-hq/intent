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
const INTENTD_ROOT_MARKERS = [/\bcd\s+"?\$\(INTENTD_DIR\)"?\s+&&/, /--manifest-path[= ]"?\$\(INTENTD_DIR\)"?\/Cargo\.toml/];
const SHELL_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;
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

// Drops an unquoted `#` comment (one that starts a word) from a shell line.
export function stripShellComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

// The shell command a recipe line runs: flags and comments removed; `null` for
// non-recipe lines.
export function recipeCommand(logicalText) {
  if (!logicalText.startsWith('\t')) return null;
  return stripShellComment(recipeBody(logicalText));
}

export function isIntentdRecipe(logicalText) {
  const command = recipeCommand(logicalText);
  if (command === null) return false;
  return INTENTD_ROOT_MARKERS.some((marker) => marker.test(command));
}

// Arguments after a bare `--` belong to the invoked binary and are skipped; an
// echoed `cargo ...` hint is text, not an invocation.
export function extractCargoReferences(segment) {
  const tokens = segment.trim().split(/\s+/);
  const cargoIndex = tokens.indexOf('cargo');
  if (cargoIndex === -1) return null;
  if (tokens.slice(0, cargoIndex).some((token) => /^[@\-+]*echo$/.test(token))) return null;
  const subcommand = tokens.slice(cargoIndex + 1).find((token) => !token.startsWith('+'));
  if (!CARGO_SUBCOMMANDS.has(subcommand)) return null;
  const packages = [];
  const tests = [];
  for (let i = cargoIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') break;
    if (token === '-p' || token === '--package') {
      if (tokens[i + 1] !== undefined) packages.push(tokens[(i += 1)]);
    } else if (token.startsWith('--package=')) {
      packages.push(token.slice('--package='.length));
    } else if (token === '--test') {
      if (tokens[i + 1] !== undefined) tests.push(tokens[(i += 1)]);
    } else if (token.startsWith('--test=')) {
      tests.push(token.slice('--test='.length));
    }
  }
  return { subcommand, packages, tests };
}

export function parseMakefile(text) {
  const invocations = [];
  for (const { line, text: logical } of joinContinuations(text)) {
    if (!isIntentdRecipe(logical)) continue;
    for (const segment of recipeCommand(logical).split(SHELL_SEPARATOR)) {
      const references = extractCargoReferences(segment);
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
      } else if (resolved.length > 0 && !resolved.some((crate) => hasTestTarget(reader, crate, test))) {
        const [crate] = resolved;
        failures.push(
          `${makefile}:${line}: error: cargo test target '${test}' (crate '${crate.name}') is missing at pinned intentd gitlink ${sha7}: ${crate.dir}/tests/${test}.rs not found`,
        );
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
