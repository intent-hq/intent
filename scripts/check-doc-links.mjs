#!/usr/bin/env node

// Check agent-facing Markdown for paths that no longer resolve. In addition to
// local Markdown links, this conservatively checks single-backtick
// spans whose entire value starts with docs/, scripts/, or .github/ and contains
// only path characters. Globs, placeholders, whitespace, and ellipses are ignored.
// Bare paths resolve against the source directory, monorepo root, and component repositories.
// References requiring an uninitialized submodule are skipped as unverifiable.
//
// Markdown links with an anchor (`file.md#anchor` or `#anchor`) whose target is a
// Markdown file must also name a heading in it, slugged like GitHub: inline markup
// dropped, lowercased, punctuation removed, spaces turned into hyphens, `-1`, `-2`, ...
// appended to repeated slugs. Headings inside code fences are ignored; explicit
// `<a id>` / `<a name>` anchors count. Anchors GitHub generates at runtime (comment
// and review anchors, `L12` line anchors) and anchors on other file types are not checked.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*(<?[^\s)>]+>?)/g;
const REPO_PATH = /`((?:docs|scripts|\.github)\/[A-Za-z0-9._/-]+)`/g;
const RUNTIME_ANCHOR = /^(?:issuecomment-|discussion_r|discussioncomment-|pullrequestreview-|L\d+(?:-L\d+)?$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const NOT_SETEXT_TEXT = /^ {0,3}(?:[-*+>]\s|\d+[.)]\s|#|<|\||$)/;
const HTML_ANCHOR = /<a\s[^>]*?\b(?:id|name)\s*=\s*["']([^"']+)["']/gi;

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

export function headingSlug(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

export function headingAnchors(content) {
  const anchors = new Set();
  const occurrences = new Map();
  const addHeading = (text) => {
    const slug = headingSlug(text);
    const count = occurrences.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    occurrences.set(slug, count + 1);
  };

  const lines = content.split(/\r?\n/);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(FENCE);
    if (fence) {
      const closes =
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1];
      if (closes) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    for (const match of line.matchAll(HTML_ANCHOR)) anchors.add(match[1]);
    const atx = line.match(ATX_HEADING);
    if (atx) {
      addHeading(atx[1] ?? '');
      continue;
    }
    const next = lines[index + 1];
    if (next !== undefined && SETEXT_UNDERLINE.test(next) && !NOT_SETEXT_TEXT.test(line) && line.trim()) {
      addHeading(line);
      index += 1;
    }
  }
  return anchors;
}

function unwrapTarget(raw) {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
}

function anchorOf(raw) {
  const unwrapped = unwrapTarget(raw);
  const hash = unwrapped.indexOf('#');
  if (hash < 0) return null;
  const anchor = unwrapped.slice(hash + 1);
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
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

function anchorReader() {
  const cache = new Map();
  return (filePath) => {
    if (!cache.has(filePath)) cache.set(filePath, fs.readFile(filePath, 'utf8').then(headingAnchors));
    return cache.get(filePath);
  };
}

function needsAnchorCheck(anchor, filePath) {
  return Boolean(anchor) && !RUNTIME_ANCHOR.test(anchor) && filePath.endsWith('.md');
}

export async function inspectRepository(root) {
  root = path.resolve(root);
  const anchorsIn = anchorReader();
  const [inputs, modules] = await Promise.all([findInputs(root), submodules(root)]);
  const failures = [];
  let skipped = 0;

  for (const source of inputs) {
    const content = await fs.readFile(source, 'utf8');
    const references = [];
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      if (!isLocalLink(match[1])) continue;
      const target = cleanTarget(match[1]);
      references.push({
        raw: match[1],
        target: target === '' ? path.basename(source) : target,
        anchor: anchorOf(match[1]),
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
      const present = await Promise.all(verifiable.map((candidate) => exists(candidate)));
      const found = verifiable.find((_, index) => present[index]);
      if (found) {
        if (!needsAnchorCheck(reference.anchor, found) || !(await isFile(found))) continue;
        const anchors = await anchorsIn(found);
        if (anchors.has(reference.anchor) || anchors.has(reference.anchor.toLowerCase())) continue;
        failures.push({
          source: path.relative(root, source),
          line: lineAt(content, reference.index),
          target: reference.raw,
          resolved: `${path.relative(root, found)}#${reference.anchor}`,
        });
        continue;
      }

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
    const hash = failure.resolved.indexOf('#');
    const detail =
      hash < 0
        ? `missing ${failure.target} (${failure.resolved})`
        : `missing heading ${failure.resolved.slice(hash)} in ${failure.resolved.slice(0, hash)}`;
    console.error(`${failure.source}:${failure.line}: ${detail}`);
  }
  if (skipped > 0) console.log(`Skipped ${skipped} unverifiable reference${skipped === 1 ? '' : 's'}.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();