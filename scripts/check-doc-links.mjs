#!/usr/bin/env node

// Check agent-facing Markdown for paths that no longer resolve. In addition to
// local Markdown links, this conservatively checks single-backtick
// spans whose entire value starts with docs/, scripts/, or .github/ and contains
// only path characters. Globs, placeholders, whitespace, and ellipses are ignored.
// Bare paths resolve against the source directory, monorepo root, and component repositories.
// References requiring an uninitialized submodule are skipped as unverifiable.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*(<?[^\s)>]+>?)/g;
const REPO_PATH = /`((?:docs|scripts|\.github)\/[A-Za-z0-9._/-]+)`/g;

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function markdownFilesBelow(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFilesBelow(entryPath)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files;
}

export async function findInputs(root) {
  const inputs = [];
  for (const name of ['AGENTS.md', 'CONTRIBUTING.md']) {
    const candidate = path.join(root, name);
    if (await isFile(candidate)) inputs.push(candidate);
  }
  inputs.push(...(await markdownFilesBelow(path.join(root, 'docs'))));

  let packages = [];
  try {
    packages = await fs.readdir(path.join(root, 'packages'), { withFileTypes: true });
  } catch {
    // A checkout without initialized submodules may not have package directories.
  }
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, 'packages', entry.name, 'AGENTS.md');
    if (await isFile(candidate)) inputs.push(candidate);
  }
  return inputs.sort();
}

async function submodules(root) {
  let config;
  try {
    config = await fs.readFile(path.join(root, '.gitmodules'), 'utf8');
  } catch {
    return [];
  }
  const paths = [...config.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((match) => path.resolve(root, match[1]));
  const modules = [];
  for (const submodulePath of paths) {
    modules.push({ path: submodulePath, initialized: await exists(path.join(submodulePath, '.git')) });
  }
  return modules;
}

function unwrapTarget(raw) {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

function cleanTarget(raw) {
  const unwrapped = unwrapTarget(raw);
  const end = [unwrapped.indexOf('#'), unwrapped.indexOf('?')]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), unwrapped.length);
  try {
    return decodeURIComponent(unwrapped.slice(0, end));
  } catch {
    return unwrapped.slice(0, end);
  }
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function isLocalLink(raw) {
  const target = unwrapTarget(raw);
  return (
    !target.startsWith('#') &&
    !target.startsWith('//') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
    !/[{}*]/.test(target) &&
    !target.includes('...')
  );
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function isWithin(candidate, directory) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

export async function inspectRepository(root) {
  root = path.resolve(root);
  const [inputs, modules] = await Promise.all([findInputs(root), submodules(root)]);
  const failures = [];
  let skipped = 0;

  for (const source of inputs) {
    const content = await fs.readFile(source, 'utf8');
    const references = [];
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      if (!isLocalLink(match[1])) continue;
      references.push({
        raw: match[1],
        target: cleanTarget(match[1]),
        index: match.index,
        bases: uniquePaths([path.dirname(source), root]),
      });
    }
    for (const match of content.matchAll(REPO_PATH)) {
      if (match[1].includes('...')) continue;
      references.push({
        raw: match[1],
        target: cleanTarget(match[1]),
        index: match.index,
        bases: uniquePaths([path.dirname(source), root, ...modules.map((module) => module.path)]),
      });
    }

    for (const reference of references) {
      const resolved = uniquePaths(reference.bases.map((base) => path.resolve(base, reference.target)));
      const insideRoot = resolved.filter((candidate) => isWithin(candidate, root));
      const isUnverifiable = (candidate) =>
        modules.some((module) => !module.initialized && isWithin(candidate, module.path));
      const verifiable = insideRoot.filter((candidate) => !isUnverifiable(candidate));
      const found = (await Promise.all(verifiable.map((candidate) => exists(candidate)))).some(Boolean);
      if (found) continue;

      const unverifiable = insideRoot.some(isUnverifiable);
      if (unverifiable) {
        skipped += 1;
        continue;
      }

      failures.push({
        source: path.relative(root, source),
        line: lineAt(content, reference.index),
        target: reference.raw,
        resolved: path.relative(root, insideRoot[0] ?? resolved[0]),
      });
    }
  }
  return { failures, skipped };
}

export async function checkRepository(root) {
  return (await inspectRepository(root)).failures;
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const { failures, skipped } = await inspectRepository(root);
  if (failures.length === 0) {
    console.log(`Documentation links resolve; skipped ${skipped} unverifiable reference${skipped === 1 ? '' : 's'}.`);
    return;
  }
  for (const failure of failures) {
    console.error(`${failure.source}:${failure.line}: missing ${failure.target} (${failure.resolved})`);
  }
  if (skipped > 0) console.log(`Skipped ${skipped} unverifiable reference${skipped === 1 ? '' : 's'}.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();