#!/usr/bin/env node

// Status-label check for the protocol docs: a capability the pinned intentd
// advertises in `client.hello` `server.capabilities` must not be described as
// "prepared" or "not implemented". The docs label rollout status by hand, so
// nothing tied those labels to what the daemon ships: desktop control and
// secret requests shipped with "prepared" still on them in about 14 files, and
// fixing it took two passes (#8191, then #8205 after a reviewer found the rest).
//
// Inputs, read as text and never executed (upstream, the intentd checkout is
// an untrusted PR head):
//   - intentd: the names of the `let capabilities = json!({ ... });` literal in
//     `server_json()` (crates/intent-transport/src/client.rs), the block every
//     hello response carries. A name whose value is `true` or a positive
//     integer is advertised. Anything other than `"name": <literal>` pairs
//     fails closed. Flags added conditionally elsewhere (the sitter's
//     `startupStatus`, the test-only `reviewMonitoring`) are not read.
//   - every docs/protocol/**/*.md, through the shared GFM scanner
//     (scripts/lib/markdown-tables.mjs), and the top-level `status` of every
//     docs/protocol/fixtures/**/*.json.
//
// A capability mention is a code span naming it as `capabilities.<name>` (any
// prefix), `<name>`, or `<name>: <value>`. The bare forms count only for a
// known capability: an advertised one, or one some protocol doc writes as
// `capabilities.<name>`. Fenced code is not read.
//
// A section reference is a link to a protocol doc (its anchor, else the
// heading numbered like a `§N.N` in the link text, else the file's numbered
// section) or a bare `§N.N`. A file whose `> Part of ... — §N.N Title` banner
// names one number is that section (methods/desktop.md is §5.51 with no
// numbered heading). A reference stands for the capability with more than
// half the mentions in the referenced section, climbing to enclosing
// sections while one mentions none but never past a numbered section; a
// section that names several flags (§5.17 client.hello) has no subject.
//
// A status label is "prepared" or "not (yet) implemented" in prose, outside
// code spans, link destinations and HTML. Each label has one subject
// capability, the first mention or resolvable reference in its scope, nearest
// to the label first (those after it in order, then those before it):
//   - in a paragraph or list item: its sentence; when the label sits inside
//     the emphasized lead-in that opens the block ("**Prepared additive
//     contract.** `capabilities.x: 1` ..."), else the next sentence;
//   - in a table row: from the label's cell to the end of the row
//     ("| discussion (prepared) | ... | requires `x: 1` |", or a README index
//     row "| §5.56 Secret requests (prepared) | [secrets.md](...) |");
//   - in a heading: the heading, else its section in order (every block up to
//     the next heading of the same or a higher level);
//   - in a fixture: a top-level `status` starting with "prepared", whose
//     subject is the first known capability name the file quotes.
// A label whose subject is advertised is a finding, counted once per
// sentence and subject.
//
// Two lists let findings through:
//   - UNFINISHED below: a part of a shipped feature that really is
//     unfinished, e.g. a platform the capability does not cover yet. Each entry
//     names the capability, the file, a substring of the flagged block and a
//     one-line reason. An entry that matches nothing warns: remove it.
//   - the baseline (scripts/protocol-status-labels-baseline.txt): labels that
//     were already stale when this check was added, as `<path> <capability>
//     <count>` lines. It only ratchets down: more findings than the count
//     fails naming each one; fewer fails naming the line to write (a warning
//     while the intentd checkout is off its pin, where the daemon side and not
//     the docs may have moved).
//
// Direction (docs lead the pin): an intentd PR that starts advertising a
// capability fails upstream while the monorepo docs still call it prepared.
// Land the monorepo docs PR that drops the label first.
//
// Usage:
//   node scripts/check-protocol-status-labels.mjs                   # exit 1 on any error
//   node scripts/check-protocol-status-labels.mjs --print-baseline  # print a complete baseline
//   --root <dir>         check another checkout (tests)
//   --intentd-dir <dir>  the intentd checkout, relative to the root

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { stripComments } from './check-agent-feature-toggles.mjs';
import { headingSlug } from './check-doc-links.mjs';
import { scanMarkdown } from './lib/markdown-tables.mjs';
import { describeCheckout, formatBanner, formatOffPinWarning } from './submodule-ref.mjs';

export const INTENTD_DIR = 'packages/intentd';
export const CAPABILITIES_FILE = 'crates/intent-transport/src/client.rs';
export const SCAN_DIR = 'docs/protocol';
export const FIXTURES_DIR = 'docs/protocol/fixtures';
export const BASELINE_PATH = 'scripts/protocol-status-labels-baseline.txt';
const CHECK = 'check-protocol-status-labels';
const SCRIPT = `scripts/${CHECK}.mjs`;

/**
 * Parts of a shipped feature whose "prepared" / "not implemented" label is
 * accurate. `text` is a substring of the flagged heading, paragraph, list
 * item or table row (or of the fixture's `status` line). Example:
 *   { capability: 'desktopControl', file: 'docs/protocol/methods/desktop.md',
 *     text: 'Linux support is prepared', reason: 'native helper ships for macOS and Windows only' }
 */
export const UNFINISHED = [];

export const BASELINE_HEADER = [
  '# Stale status labels grandfathered when check-protocol-status-labels was added:',
  '# `<path> <capability> <count>`, sorted, where count is the number of "prepared" /',
  '# "not implemented" labels in that doc whose subject is a capability the pinned intentd',
  '# advertises. Checked by `scripts/check-protocol-status-labels.mjs` (run from',
  '# `make docs-check`). Entries only ratchet down: drop a stale label and write the',
  '# count the check names. Regenerate with `node scripts/check-protocol-status-labels.mjs --print-baseline`.',
].join('\n');

const NAME = '[A-Za-z][A-Za-z0-9]*';
const LABEL_RE = /\bprepared\b|\bnot\s+(?:yet\s+)?implemented\b/gi;
const QUALIFIED_RE = new RegExp(`(?:^|[^A-Za-z0-9_])capabilities\\.(${NAME})`, 'g');
const BARE_RE = new RegExp(`^(${NAME})(?:\\s*:\\s*[^\\s]+)?$`);
const CODE_SPAN_RE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
// Sentence ends: terminal punctuation (optionally closed by emphasis, a
// bracket or a quote) followed by whitespace, or a table cell boundary.
const SENTENCE_END_RE = /[.!?][*_)\]"']*(?=\s)|(?<!\\)\|/g;
const ABBREVIATION_RE = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i;
// An emphasized lead-in that opens a block ("**Prepared additive
// contract.** ...", "*(prepared, additive)* ..."), after any list marker.
const LEAD_IN_RE = /^([ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(\*\*|__|\*|_)(?=\S)/;

/** End offset of the emphasized lead-in that opens `text`, or -1. */
function leadInEnd(text) {
  const m = text.match(LEAD_IN_RE);
  if (!m) return -1;
  const start = m[1].length + m[2].length;
  const close = text.indexOf(m[2], start);
  return close === -1 ? -1 : close + m[2].length;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * Advertised capability names from intentd's `server_json()`, or throws
 * naming what changed. A `false` or `0` value is present but not advertised.
 */
export function parseAdvertised(source, file = `${INTENTD_DIR}/${CAPABILITIES_FILE}`) {
  const text = stripComments(source, 'rust');
  const start = text.search(/^pub\(crate\) fn server_json\(/m);
  if (start === -1) throw new Error(`${file}: \`pub(crate) fn server_json(\` not found; update ${CHECK} for the new hello shape`);
  const rest = text.slice(start);
  const end = rest.search(/^\}$/m);
  if (end === -1) throw new Error(`${file}: end of server_json() not found`);
  const body = rest.slice(0, end);
  const literals = [...body.matchAll(/let capabilities = json!\(\{([\s\S]*?)\}\);/g)];
  if (literals.length !== 1) throw new Error(`${file}: expected one \`let capabilities = json!({ ... });\` in server_json(), found ${literals.length}; update ${CHECK}`);
  const pairs = [...literals[0][1].matchAll(/"([^"\\]*)"\s*:\s*(true|false|\d+)/g)];
  const leftover = literals[0][1].replace(/"[^"\\]*"\s*:\s*(?:true|false|\d+)/g, '').replace(/[\s,]/g, '');
  if (leftover) throw new Error(`${file}: the server_json() capabilities literal holds something other than \`"name": <literal>\` pairs (${leftover.slice(0, 60)}); update ${CHECK}`);
  const names = pairs.map((m) => m[1]);
  const bad = names.find((n) => !new RegExp(`^${NAME}$`).test(n));
  if (bad !== undefined) throw new Error(`${file}: capability name ${JSON.stringify(bad)} is not a plain identifier; update ${CHECK}`);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`${file}: capability ${dup} appears twice in server_json()`);
  if (!names.length) throw new Error(`${file}: server_json() advertises no capability; update ${CHECK} if the block moved`);
  return pairs.filter((m) => m[2] === 'true' || (m[2] !== 'false' && Number(m[2]) > 0)).map((m) => m[1]);
}

/** `[{ offset, name, qualified }]` for each capability-shaped code span of `text`, in order. */
function codeMentions(text, known) {
  const found = [];
  for (const span of text.matchAll(CODE_SPAN_RE)) {
    const content = span[2].trim();
    const qualified = [...content.matchAll(QUALIFIED_RE)].map((m) => m[1]);
    if (qualified.length) {
      for (const name of qualified) found.push({ offset: span.index, name, qualified: true });
      continue;
    }
    const bare = content.match(BARE_RE);
    if (bare && known?.has(bare[1])) found.push({ offset: span.index, name: bare[1], qualified: false });
  }
  return found;
}

/** Names some text writes as `capabilities.<name>` inside a code span. */
export function qualifiedNames(text) {
  return codeMentions(text, null).filter((m) => m.qualified).map((m) => m.name);
}

/** `text` with code spans and link destinations blanked, offsets preserved: only prose is searched for labels. */
function prose(text) {
  return text
    .replace(CODE_SPAN_RE, blank)
    .replace(/(\]\()([^)\s]*)((?:\s+"[^"]*")?\))/g, (_, open, dest, close) => open + blank(dest) + close)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<[^>\n]*>/g, blank);
}

/** Sentence start offsets of `text` (always includes 0). */
function sentenceStarts(text) {
  const starts = [0];
  const p = prose(text);
  for (const m of p.matchAll(SENTENCE_END_RE)) {
    if (m[0] !== '|' && ABBREVIATION_RE.test(p.slice(Math.max(0, m.index - 4), m.index + 1))) continue;
    starts.push(m.index + m[0].length);
  }
  return starts;
}

/**
 * The blocks of a Markdown document the check reads: `{ kind, line, lines,
 * text }` per heading, paragraph, list item, blockquote paragraph and table
 * row (header and delimiter rows excluded). `lines[i]` is the 1-based source
 * line of each joined line; `text` joins them with '\n'. Fenced and indented
 * code, HTML blocks and thematic breaks are skipped.
 */
export function blocksOf(source) {
  const { lines, kinds, headings, tables } = scanMarkdown(source);
  const headingAt = new Map(headings.map((h) => [h.line, h]));
  const rowLines = new Set(tables.flatMap((t) => t.rows.map((r) => r.line)));
  const blocks = [];
  let open = null;
  const start = (kind, i, text) => {
    open = { kind, line: i + 1, lines: [i + 1], text };
    blocks.push(open);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const kind = kinds[i];
    const line = lines[i];
    if (kind === 'heading') {
      open = null;
      const h = headingAt.get(i + 1);
      if (h) blocks.push({ kind: 'heading', level: h.level, line: i + 1, lines: [i + 1], text: h.text });
      continue;
    }
    if (kind === 'table') {
      open = null;
      if (rowLines.has(i + 1)) blocks.push({ kind: 'row', line: i + 1, lines: [i + 1], text: line });
      continue;
    }
    if (kind === 'quote') {
      const content = line.replace(/^[ \t]*(?:>[ \t]?)+/, '');
      if (/^[ \t]*$/.test(content)) open = null;
      else if (open?.kind !== 'quote' || /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]/.test(content) || /^#{1,6}[ \t]/.test(content)) start('quote', i, content);
      else {
        open.lines.push(i + 1);
        open.text += `\n${content}`;
      }
      continue;
    }
    if (kind === 'list') {
      start('item', i, line);
      continue;
    }
    if (kind === 'paragraph') {
      if (open && (open.kind === 'item' || open.kind === 'paragraph')) {
        open.lines.push(i + 1);
        open.text += `\n${line}`;
      } else start('paragraph', i, line);
      continue;
    }
    open = null;
  }
  return blocks;
}

/** 1-based source line of `offset` within a block's joined text. */
function lineAt(block, offset) {
  const before = block.text.slice(0, offset).split('\n').length - 1;
  return block.lines[Math.min(before, block.lines.length - 1)];
}

const HEADING_NUMBER_RE = /^(\d+(?:\.\d+)*[a-z]?)\s/;
const SECTION_NUMBER = '(\\d+(?:\\.\\d+)*[a-z]?)';

/**
 * Heading sections of a parsed document: `{ heading, index, slug, number,
 * parent, from, to }`, where `from`/`to` are block indices (`to` exclusive)
 * and `number` is a leading section number such as `5.56`.
 */
export function sectionsOf(blocks) {
  const out = [];
  const seen = new Map();
  blocks.forEach((b, i) => {
    if (b.kind !== 'heading') return;
    let to = blocks.length;
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (blocks[j].kind === 'heading' && blocks[j].level <= b.level) {
        to = j;
        break;
      }
    }
    const base = headingSlug(b.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const parent = [...out].reverse().find((s) => s.heading.level < b.level) ?? null;
    out.push({ heading: b, index: i, slug: n ? `${base}-${n}` : base, number: b.text.match(HEADING_NUMBER_RE)?.[1] ?? null, parent, from: i + 1, to });
  });
  return out;
}

/**
 * A parsed document: `{ blocks, sections, root }`. `root` is a section
 * spanning the whole file when its opening `> Part of ... — §N.N Title`
 * banner names exactly one section number (methods/desktop.md is §5.51 with
 * no numbered heading); top-level sections then have it as their parent.
 */
export function parseDoc(source) {
  const blocks = blocksOf(source);
  const sections = sectionsOf(blocks);
  const banner = blocks[0]?.kind === 'quote' && /^Part of\b/.test(blocks[0].text) ? blocks[0].text : '';
  const numbers = [...banner.matchAll(new RegExp(`§${SECTION_NUMBER}`, 'g'))].map((m) => m[1]);
  let root = null;
  if (numbers.length === 1) {
    root = { heading: { level: 0, text: banner }, index: -1, slug: null, number: numbers[0], parent: null, from: 0, to: blocks.length };
    for (const section of sections) if (!section.parent) section.parent = root;
  }
  return { blocks, sections, root };
}

/**
 * Section references in `text`, in order: `{ offset, end, path, anchor,
 * number }` for a link to a Markdown file or a same-file anchor (`path` null),
 * and `{ offset, end, number }` for a bare `§N.N` outside a link. Code spans
 * and links to anything else (fixtures, URLs) are ignored.
 */
function referencesIn(text) {
  const p = text.replace(CODE_SPAN_RE, blank);
  const refs = [];
  const linked = [];
  for (const m of p.matchAll(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
    linked.push([m.index, m.index + m[0].length]);
    const hash = m[2].indexOf('#');
    const dest = hash === -1 ? m[2] : m[2].slice(0, hash);
    const anchor = hash === -1 ? null : m[2].slice(hash + 1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || (dest && !dest.endsWith('.md')) || (!dest && !anchor)) continue;
    const number = text.slice(m.index, m.index + m[1].length + 2).match(new RegExp(`§${SECTION_NUMBER}`))?.[1] ?? null;
    refs.push({ offset: m.index, end: m.index + m[0].length, path: dest || null, anchor, number });
  }
  for (const m of p.matchAll(new RegExp(`§${SECTION_NUMBER}`, 'g'))) {
    if (linked.some(([a, b]) => m.index >= a && m.index < b)) continue;
    refs.push({ offset: m.index, end: m.index + m[0].length, number: m[1] });
  }
  return refs.sort((a, b) => a.offset - b.offset);
}

/**
 * The capability a run of blocks is about: the one with more than half of
 * its capability mentions. `{ name }` (name null when no capability has a
 * majority) or null when the blocks mention no capability.
 */
function dominant(blocks, from, to, ctx) {
  const counts = new Map();
  let total = 0;
  for (let i = from; i < to; i += 1) {
    for (const m of codeMentions(blocks[i].text, ctx.known)) {
      counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
      total += 1;
    }
  }
  if (!total) return null;
  const [name, count] = [...counts].sort((x, y) => y[1] - x[1])[0];
  return { name: count * 2 > total ? name : null };
}

/**
 * The capability a section reference describes, or null: the dominant
 * capability of the referenced section, climbing to enclosing sections while
 * a section mentions none, but never past the nearest numbered section
 * (`5.56 Secret requests`). A link to a file with no anchor or `§` number
 * means the file's first numbered section. References are not followed
 * further.
 */
function resolveReference(ctx, fromFile, ref) {
  let file = fromFile;
  let section = null;
  if ('path' in ref) {
    if (ref.path) file = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), ref.path));
    const doc = ctx.docs.get(file);
    if (!doc) return null;
    if (ref.anchor) section = doc.sections.find((s) => s.slug === safeDecode(ref.anchor)) ?? null;
    else if (ref.number) section = doc.sections.find((s) => s.number === ref.number) ?? null;
    else section = doc.root ?? doc.sections.find((s) => s.number) ?? null;
  } else {
    const hits = ctx.numbered.get(ref.number) ?? [];
    if (hits.length !== 1) return null;
    ({ file, section } = hits[0]);
  }
  const { blocks } = ctx.docs.get(file);
  for (let s = section; s; s = s.number ? null : s.parent) {
    const hit = dominant(blocks, s.from, s.to, ctx);
    if (hit) return hit.name;
  }
  return null;
}

function safeDecode(anchor) {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}

/**
 * The subject of text `from`..`to` (offsets, `to` exclusive or undefined) of
 * one block: its capability mentions and resolvable section references,
 * nearest to the label first (those at or after offset `at` in text order,
 * then those before it, closest first), or null.
 */
function subjectIn(ctx, file, text, { from = 0, to = undefined, at = from } = {}) {
  const within = (o) => o >= from && (to === undefined || o < to);
  const items = [
    ...codeMentions(text, ctx.known).filter((m) => within(m.offset)).map((m) => ({ offset: m.offset, name: m.name })),
    ...referencesIn(text).filter((r) => within(r.offset)).map((r) => ({ offset: r.offset, ref: r })),
  ];
  const after = items.filter((i) => i.offset >= at).sort((a, b) => a.offset - b.offset);
  const before = items.filter((i) => i.offset < at).sort((a, b) => b.offset - a.offset);
  for (const item of [...after, ...before]) {
    const name = item.name ?? resolveReference(ctx, file, item.ref);
    if (name) return name;
  }
  return null;
}

/**
 * Status labels in one Markdown file: `[{ file, line, capability, label,
 * block }]`, one per sentence and subject whose subject is a known capability.
 * `ctx` is `{ docs, known, numbered }` from `buildContext`.
 */
export function labelsIn(file, ctx) {
  const doc = ctx.docs.get(file);
  const found = [];
  const { blocks } = doc;
  blocks.forEach((block, index) => {
    const labels = [...prose(block.text).matchAll(LABEL_RE)];
    if (!labels.length) return;
    const starts = sentenceStarts(block.text);
    const subjects = new Set();
    for (const label of labels) {
      const own = starts.filter((s) => s <= label.index).at(-1) ?? 0;
      const next = starts.find((s) => s > label.index);
      let subject = null;
      if (block.kind === 'heading') {
        subject = subjectIn(ctx, file, block.text, { at: label.index });
        const section = doc.sections.find((s) => s.index === index);
        for (let i = section?.from ?? 0; !subject && section && i < section.to; i += 1) subject = subjectIn(ctx, file, blocks[i].text);
      } else if (block.kind === 'row') {
        subject = subjectIn(ctx, file, block.text, { from: own, at: label.index });
      } else {
        subject = subjectIn(ctx, file, block.text, { from: own, to: next, at: label.index });
        if (!subject && next !== undefined && label.index < leadInEnd(block.text)) subject = subjectIn(ctx, file, block.text, { from: next, to: starts.find((s) => s > next) });
      }
      // One finding per sentence (a row cell onward, a heading) and subject:
      // two labels in one sentence are one statement, while a second stale
      // sentence in a grandfathered paragraph raises the count.
      const key = `${block.kind === 'heading' ? 0 : own} ${subject}`;
      if (!subject || subjects.has(key)) continue;
      subjects.add(key);
      found.push({ file, line: lineAt(block, label.index), capability: subject, label: label[0], block: block.text });
    }
  });
  return found;
}

/**
 * `{ docs, known, numbered }` for a set of `{ file: source }` protocol docs:
 * parsed documents, the known capability names (`advertised` plus every
 * `capabilities.<name>` the docs write) and numbered sections by number.
 */
export function buildContext(sources, advertised) {
  const docs = new Map();
  for (const [file, source] of Object.entries(sources)) docs.set(file, parseDoc(source));
  const known = new Set(advertised);
  for (const { blocks } of docs.values()) for (const b of blocks) for (const n of qualifiedNames(b.text)) known.add(n);
  const numbered = new Map();
  for (const [file, doc] of docs) {
    for (const section of doc.root ? [doc.root, ...doc.sections] : doc.sections) {
      if (!section.number) continue;
      if (!numbered.has(section.number)) numbered.set(section.number, []);
      numbered.get(section.number).push({ file, section });
    }
  }
  // A number used by several headings resolves to the shallowest one only when it is unique at that level.
  for (const [number, hits] of numbered) {
    const top = Math.min(...hits.map((h) => h.section.heading.level));
    numbered.set(number, hits.filter((h) => h.section.heading.level === top));
  }
  return { docs, known, numbered };
}

/** A fixture's stale status: `[{ file, line, capability, label, block }]` (zero or one). */
export function fixtureLabels(file, source, { known }) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error.message})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.status !== 'string' || !/^prepared\b/i.test(data.status)) return [];
  const statusLine = source.split('\n').findIndex((l) => /^\s*"status"\s*:/.test(l)) + 1;
  for (const m of source.matchAll(new RegExp(`"(${NAME})"`, 'g'))) {
    if (known.has(m[1])) return [{ file, line: statusLine || 1, capability: m[1], label: data.status, block: `"status": ${JSON.stringify(data.status)}` }];
  }
  return [];
}

/** Every file below `root/relative` with one of `extensions`, failing closed on a symlink. */
export function filesBelow(root, relative, extensions) {
  const out = [];
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`${child}: symlinks under ${SCAN_DIR} are not scanned; commit the file itself`);
    if (entry.isDirectory()) out.push(...filesBelow(root, child, extensions));
    else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) out.push(child);
  }
  return out.sort();
}

/**
 * Findings for in-memory sources: `docs` and `fixtures` map repo-relative
 * paths to text. Only labels whose subject is in `advertised` are returned.
 */
export function findLabels({ docs, fixtures = {} }, advertised) {
  const ctx = buildContext(docs, advertised);
  const shipped = new Set(advertised);
  const findings = [];
  for (const file of Object.keys(docs).sort()) findings.push(...labelsIn(file, ctx));
  for (const file of Object.keys(fixtures).sort()) findings.push(...fixtureLabels(file, fixtures[file], ctx));
  return findings.filter((f) => shipped.has(f.capability));
}

/** Findings for the docs tree under `root`. */
export function scanDocs(root, advertised) {
  const read = (files) => Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const docs = read(filesBelow(root, SCAN_DIR, ['.md']));
  const fixtures = read(fs.existsSync(path.join(root, FIXTURES_DIR)) ? filesBelow(root, FIXTURES_DIR, ['.json']) : []);
  return findLabels({ docs, fixtures }, advertised);
}

const keyOf = (f) => `${f.file} ${f.capability}`;

/** Baseline lines for a set of findings, sorted. */
export function baselineEntries(findings) {
  const counts = new Map();
  for (const f of findings) counts.set(keyOf(f), (counts.get(keyOf(f)) ?? 0) + 1);
  return [...counts.keys()].sort().map((k) => `${k} ${counts.get(k)}`);
}

/** Parse the baseline: `{ entries: [{ file, capability, count, line }], errors }`. */
export function parseBaseline(text, file = BASELINE_PATH) {
  const entries = [];
  const errors = [];
  let previous = null;
  text.split('\n').forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = trimmed.match(new RegExp(`^(\\S+)\\s+(${NAME})\\s+([0-9]+)$`));
    if (!m) {
      errors.push(`${file}:${i + 1}: error: expected \`<path> <capability> <count>\`, got "${raw}"`);
      return;
    }
    const key = `${m[1]} ${m[2]}`;
    if (Number(m[3]) === 0) {
      errors.push(`${file}:${i + 1}: error: a pair with no stale labels has no entry; remove "${raw}"`);
      return;
    }
    if (previous !== null && !(previous < key)) {
      errors.push(`${file}:${i + 1}: error: entries must be sorted and unique, but "${key}" follows "${previous}"`);
      return;
    }
    previous = key;
    entries.push({ file: m[1], capability: m[2], count: Number(m[3]), line: i + 1 });
  });
  return { entries, errors };
}

/**
 * Compare findings with the allowlist and baseline. Returns `{ errors,
 * warnings, allowed, grandfathered }`. `strict` makes a baseline that is now
 * too high an error (the intentd checkout is at its pin, so only the docs moved).
 */
export function compare(findings, { entries = [], unfinished = UNFINISHED, strict = true, baselinePath = BASELINE_PATH } = {}) {
  const errors = [];
  const warnings = [];
  const used = new Set();
  const remaining = [];
  unfinished.forEach((u, i) => {
    for (const field of ['capability', 'file', 'text', 'reason']) {
      if (typeof u[field] !== 'string' || !u[field].trim()) errors.push(`UNFINISHED entry ${i + 1} in ${SCRIPT} needs a non-empty ${field}`);
    }
  });
  for (const f of findings) {
    const hit = unfinished.findIndex((u) => u.capability === f.capability && u.file === f.file && typeof u.text === 'string' && u.text && f.block.includes(u.text));
    if (hit === -1) remaining.push(f);
    else used.add(hit);
  }
  unfinished.forEach((u, i) => {
    if (!used.has(i)) warnings.push(`UNFINISHED entry for ${u.capability} in ${u.file} ("${u.text}") matches no label; remove it from ${SCRIPT}`);
  });

  const byKey = new Map();
  for (const f of remaining) {
    if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), []);
    byKey.get(keyOf(f)).push(f);
  }
  const baseline = new Map(entries.map((e) => [`${e.file} ${e.capability}`, e]));
  let grandfathered = 0;
  for (const [key, list] of byKey) {
    const entry = baseline.get(key);
    const allowed = entry?.count ?? 0;
    if (list.length > allowed) {
      const why = entry ? `the baseline allows ${allowed}` : 'the baseline has no entry for it';
      errors.push(`${list[0].file}: ${list.length} "prepared"/"not implemented" label(s) describe ${list[0].capability}, which the pinned intentd advertises in server.capabilities; ${why}:`);
      for (const f of list) {
        errors.push(
          `${f.file}:${f.line}: error: "${f.label}" labels ${f.capability} as unshipped, but intentd advertises it. ` +
            `Drop the label (the feature shipped), or, for a part that really is unfinished, add an UNFINISHED entry with a reason to ${SCRIPT}. ` +
            'On an intentd PR that starts advertising it, land the monorepo docs change first.',
        );
      }
    } else {
      grandfathered += list.length;
      if (list.length < allowed) {
        const msg = `${baselinePath}:${entry.line}: ${key} has ${list.length} stale label(s) left but the baseline allows ${allowed}; the ratchet only moves down: replace its line with \`${key} ${list.length}\``;
        (strict ? errors : warnings).push(strict ? `${msg.replace(': ', ': error: ')}` : `${msg} (intentd is off its pin, so this is a warning here)`);
      }
    }
  }
  for (const entry of entries) {
    const key = `${entry.file} ${entry.capability}`;
    if (byKey.has(key)) continue;
    const msg = `${baselinePath}:${entry.line}: ${key} has no stale labels left but the baseline allows ${entry.count}; remove its line \`${key} ${entry.count}\``;
    (strict ? errors : warnings).push(strict ? msg.replace(': ', ': error: ') : `${msg} (intentd is off its pin, so this is a warning here)`);
  }
  return { errors, warnings, allowed: used.size, grandfathered };
}

/**
 * Run the check against `root`. `intentdDir` is relative to `root`. Returns
 * `{ errors, warnings, advertised, findings, ... }`.
 */
export function run(root, { intentdDir = INTENTD_DIR, unfinished = UNFINISHED, log = console.log, warn = console.error } = {}) {
  const capsPath = path.join(intentdDir, CAPABILITIES_FILE);
  if (!fs.existsSync(path.resolve(root, capsPath))) {
    throw new Error(`${capsPath} not found; initialize the submodule (make ensure-intentd-submodule) or update ${CHECK} if the file moved`);
  }
  const ref = describeCheckout(root, intentdDir, { pinDir: INTENTD_DIR });
  const banner = formatBanner(ref, { check: CHECK, what: 'server.capabilities' });
  if (banner) log(banner);
  const offPinWarning = formatOffPinWarning(ref);
  if (offPinWarning) warn(offPinWarning);
  const advertised = parseAdvertised(fs.readFileSync(path.resolve(root, capsPath), 'utf8'), capsPath);
  const findings = scanDocs(root, advertised);
  const baselineFile = path.join(root, BASELINE_PATH);
  if (!fs.existsSync(baselineFile)) return { errors: [`${BASELINE_PATH}: error: baseline file is missing`], warnings: [], advertised, findings };
  const { entries, errors: parseErrors } = parseBaseline(fs.readFileSync(baselineFile, 'utf8'));
  if (parseErrors.length) return { errors: parseErrors, warnings: [], advertised, findings };
  const strict = !ref.checkout || !ref.pin || (ref.checkout === ref.pin && !ref.dirty);
  return { ...compare(findings, { entries, unfinished, strict }), advertised, findings };
}

function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, 'intentd-dir': { type: 'string' }, 'print-baseline': { type: 'boolean' } } });
  const root = path.resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)));
  const intentdDir = values['intentd-dir'] ?? INTENTD_DIR;
  let result;
  try {
    if (values['print-baseline']) {
      const advertised = parseAdvertised(fs.readFileSync(path.resolve(root, intentdDir, CAPABILITIES_FILE), 'utf8'));
      const remaining = scanDocs(root, advertised).filter((f) => !UNFINISHED.some((u) => u.capability === f.capability && u.file === f.file && f.block.includes(u.text)));
      process.stdout.write(`${[BASELINE_HEADER, ...baselineEntries(remaining)].join('\n')}\n`);
      return;
    }
    result = run(root, { intentdDir });
  } catch (error) {
    console.error(`${CHECK}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of result.warnings) console.log(`::warning::${CHECK}: ${warning}`);
  for (const error of result.errors) console.error(`${CHECK}: ${error}`);
  if (result.errors.length) {
    process.exitCode = 1;
    return;
  }
  const { advertised, findings, allowed, grandfathered } = result;
  console.log(`${CHECK}: no new "prepared"/"not implemented" labels on the ${advertised.length} capabilities intentd advertises (${allowed} allowlisted as unfinished, ${grandfathered} grandfathered in ${BASELINE_PATH}; ${findings.length} total)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
