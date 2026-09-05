#!/usr/bin/env node

// Check agent-facing Markdown for paths that no longer resolve. In addition to
// explicit ./ and ../ Markdown links, this conservatively checks single-backtick
// spans whose entire value starts with docs/, scripts/, or .github/ and contains
// only path characters. Globs, placeholders, whitespace, and ellipses are ignored.
// Root guides resolve these from the monorepo root, package guides from that
// package or the monorepo, and docs/fe from cloudlands-fe; other docs may
// describe any component.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*(<?(?:\.\.?\/)[^\s)>]+>?)/g;
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
    modules.push({ path: submodulePath, available: await exists(submodulePath) });
  }
  return modules;
}

function cleanTarget(raw) {
  const unwrapped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
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

export async function checkRepository(root) {
  root = path.resolve(root);
  const [inputs, modules] = await Promise.all([findInputs(root), submodules(root)]);
  const failures = [];

  for (const source of inputs) {
    const content = await fs.readFile(source, 'utf8');
    const references = [];
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      references.push({ raw: match[1], target: cleanTarget(match[1]), index: match.index, bases: [path.dirname(source)] });
    }
    for (const match of content.matchAll(REPO_PATH)) {
      if (match[1].includes('...')) continue;
      const relativeSource = path.relative(root, source);
      let bases = [root];
      const packageMatch = relativeSource.match(/^packages\/[^/]+/);
      if (packageMatch) bases = [path.join(root, packageMatch[0]), root];
      else if (relativeSource.startsWith(`docs${path.sep}fe${path.sep}`)) bases = [path.join(root, 'packages', 'cloudlands-fe')];
      else if (relativeSource.startsWith(`docs${path.sep}`)) bases = [root, ...modules.map((module) => module.path)];
      references.push({ raw: match[1], target: cleanTarget(match[1]), index: match.index, bases });
    }

    for (const reference of references) {
      const resolved = reference.bases.map((base) => path.resolve(base, reference.target));
      const insideRoot = resolved.every((candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
      const found = (await Promise.all(resolved.map((candidate) => exists(candidate)))).some(Boolean);
      const unverifiable = resolved.some((candidate) =>
        modules.some(
          (module) => !module.available && (candidate === module.path || candidate.startsWith(`${module.path}${path.sep}`)),
        ),
      );
      if (!insideRoot || (!found && !unverifiable)) {
        failures.push({
          source: path.relative(root, source),
          line: lineAt(content, reference.index),
          target: reference.raw,
          resolved: path.relative(root, resolved[0]),
        });
      }
    }
  }
  return failures;
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const failures = await checkRepository(root);
  if (failures.length === 0) {
    console.log('Documentation links resolve.');
    return;
  }
  for (const failure of failures) {
    console.error(`${failure.source}:${failure.line}: missing ${failure.target} (${failure.resolved})`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();