#!/usr/bin/env node

// Check agent-facing Markdown for paths that no longer resolve. In addition to
// local Markdown links, this conservatively checks single-backtick
// spans whose entire value starts with docs/, scripts/, or .github/ and contains
// only path characters. Globs, placeholders, whitespace, and ellipses are ignored.
// Bare paths resolve against the source directory, monorepo root, and component repositories.
// References requiring an uninitialized submodule are skipped as unverifiable.
// Bare paths are never looked up in a submodule that .gitmodules marks `update = none`
// (the private packages/ios, which CI never checks out): otherwise every missing bare
// path would have a candidate there and be skipped instead of failing. Explicit links
// into such a submodule are still skipped while it is absent.
//
// Markdown links with an anchor (`file.md#anchor`, `dir/#anchor` or `#anchor`) whose
// target is a Markdown file (or a directory's README.md) must also name a heading in
// it, slugged like GitHub's github-slugger: the rendered heading text (code spans kept
// literal, other markup dropped), lowercased, punctuation removed, spaces turned into
// hyphens, and `-1`, `-2`, ... appended to repeated slugs. ATX, setext and blockquote
// headings count; headings inside code fences do not; explicit `id` / `name` attributes
// count. Example links inside code or HTML comments, anchors GitHub generates at runtime
// (comment and review anchors, `L12` line anchors), and anchors on other file types are
// not checked.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*(<?[^\s)>]+>?)/g;
const REPO_PATH = /`((?:docs|scripts|\.github)\/[A-Za-z0-9._/-]+)`/g;
const RUNTIME_ANCHOR = /^(?:issuecomment-|discussion_r|discussioncomment-|pullrequestreview-|L\d+(?:-L\d+)?$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCKQUOTE = /^(?: {0,3}> ?)+/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const BLOCK_START = /^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t]|<|\|)/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const CODE_SPAN = /(`+)(?!`)(.*?[^`])\1(?!`)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;
const HTML_ID = /<[A-Za-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi;
const INLINE_LINK = /!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;
const EMPHASIS = /(^|[^\p{L}\p{N}_])(_{1,2})(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])/gu;
const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function statOf(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
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
  const modules = [];
  for (const section of config.split(/^\s*\[/m)) {
    const setting = (name) => section.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
    const submodulePath = setting('path');
    if (!submodulePath) continue;
    const resolved = path.resolve(root, submodulePath);
    modules.push({
      path: resolved,
      initialized: Boolean(await statOf(path.join(resolved, '.git'))),
      optIn: setting('update') === 'none',
    });
  }
  return modules;
}

function renderedText(markdown) {
  return markdown
    .replace(HTML_COMMENT, '')
    .replace(INLINE_LINK, '$1')
    .replace(HTML_TAG, '')
    .replace(EMPHASIS, '$1$3')
    .replace(ENTITY, (whole, decimal, hex, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    });
}

export function headingSlug(text) {
  let plain = '';
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    plain += renderedText(text.slice(last, match.index)) + match[2];
    last = match.index + match[0].length;
  }
  plain += renderedText(text.slice(last));
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

// Yields each line with its offset, its text without blockquote markers, and whether
// it belongs to a fenced code block (fence delimiters included).
function* markdownLines(content) {
  let fence = null;
  let start = 0;
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const body = line.replace(BLOCKQUOTE, '');
    const fenceMatch = body.match(FENCE);
    let fenced = false;
    if (fence) {
      fenced = true;
      const closes =
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        body.trim() === fenceMatch[1];
      if (closes) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
      fenced = true;
    }
    yield { line, body, fenced, start };
    start += raw.length + 1;
  }
}

export function headingAnchors(content) {
  const anchors = new Set();
  const occurrences = new Map();
  const addHeading = (text) => {
    const original = headingSlug(text);
    let slug = original;
    while (occurrences.has(slug)) {
      const count = occurrences.get(original) + 1;
      occurrences.set(original, count);
      slug = `${original}-${count}`;
    }
    occurrences.set(slug, 0);
    anchors.add(slug);
  };

  let paragraph = [];
  let inContainer = false;
  for (const { body, fenced } of markdownLines(content)) {
    if (fenced) {
      paragraph = [];
      continue;
    }
    for (const match of body.replace(CODE_SPAN, '').replace(HTML_COMMENT, '').matchAll(HTML_ID)) {
      anchors.add(match[1]);
    }
    if (paragraph.length > 0 && SETEXT_UNDERLINE.test(body)) {
      addHeading(paragraph.join(' '));
      paragraph = [];
      continue;
    }
    const atx = body.match(ATX_HEADING);
    if (atx) {
      addHeading(atx[1] ?? '');
      paragraph = [];
      inContainer = false;
    } else if (!body.trim()) {
      paragraph = [];
      inContainer = false;
    } else if (BLOCK_START.test(body)) {
      paragraph = [];
      inContainer = true;
    } else if (!inContainer && (paragraph.length > 0 || !INDENTED_CODE.test(body))) {
      paragraph.push(body.trim());
    }
  }
  return anchors;
}

// Offsets of fenced code, inline code spans and HTML comments, where links are examples.
function literalRanges(content) {
  const ranges = [];
  for (const { line, fenced, start } of markdownLines(content)) {
    if (fenced) {
      ranges.push([start, start + line.length]);
      continue;
    }
    for (const match of line.matchAll(CODE_SPAN)) {
      ranges.push([start + match.index, start + match.index + match[0].length]);
    }
  }
  for (const match of content.matchAll(HTML_COMMENT)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
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

// The Markdown file whose headings an anchor on `found` refers to, if any.
async function anchorDocument(found, stat) {
  if (stat.isFile()) return found.endsWith('.md') ? found : null;
  if (!stat.isDirectory()) return null;
  const readme = path.join(found, 'README.md');
  return (await statOf(readme))?.isFile() ? readme : null;
}

export async function inspectRepository(root) {
  root = path.resolve(root);
  const anchorsIn = anchorReader();
  const [inputs, modules] = await Promise.all([findInputs(root), submodules(root)]);
  const bareBases = modules.filter((module) => !module.optIn).map((module) => module.path);
  const failures = [];
  let skipped = 0;

  for (const source of inputs) {
    const content = await fs.readFile(source, 'utf8');
    const references = [];
    const literal = literalRanges(content);
    const isExample = (index) => literal.some(([start, end]) => index >= start && index < end);
    for (const match of content.matchAll(MARKDOWN_LINK)) {
      if (!isLocalLink(match[1])) continue;
      const target = cleanTarget(match[1]);
      const anchor = isExample(match.index) ? null : anchorOf(match[1]);
      references.push({
        raw: match[1],
        target: target === '' ? source : target,
        anchor: anchor && !RUNTIME_ANCHOR.test(anchor) ? anchor : null,
        index: match.index,
        bases: target === '' ? [path.dirname(source)] : uniquePaths([path.dirname(source), root]),
      });
    }
    for (const match of content.matchAll(REPO_PATH)) {
      if (match[1].includes('...')) continue;
      references.push({
        raw: match[1],
        target: cleanTarget(match[1]),
        index: match.index,
        bases: uniquePaths([path.dirname(source), root, ...bareBases]),
      });
    }

    for (const reference of references) {
      const resolved = uniquePaths(reference.bases.map((base) => path.resolve(base, reference.target)));
      const insideRoot = resolved.filter((candidate) => isWithin(candidate, root));
      const isUnverifiable = (candidate) =>
        modules.some((module) => !module.initialized && isWithin(candidate, module.path));
      const verifiable = insideRoot.filter((candidate) => !isUnverifiable(candidate));
      const stats = await Promise.all(verifiable.map(statOf));
      const foundIndex = stats.findIndex(Boolean);
      if (foundIndex >= 0) {
        if (!reference.anchor) continue;
        const document = await anchorDocument(verifiable[foundIndex], stats[foundIndex]);
        if (!document) continue;
        const anchors = await anchorsIn(document);
        if (anchors.has(reference.anchor) || anchors.has(reference.anchor.toLowerCase())) continue;
        failures.push({
          source: path.relative(root, source),
          line: lineAt(content, reference.index),
          target: reference.raw,
          resolved: path.relative(root, document),
          anchor: reference.anchor,
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
    const detail = failure.anchor
      ? `missing heading #${failure.anchor} in ${failure.resolved}`
      : `missing ${failure.target} (${failure.resolved})`;
    console.error(`${failure.source}:${failure.line}: ${detail}`);
  }
  if (skipped > 0) console.log(`Skipped ${skipped} unverifiable reference${skipped === 1 ? '' : 's'}.`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();