#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const TOOLS_RS_PATH = 'packages/intentd/crates/intent-acp/src/mcp_server/tools.rs';
export const PROTOCOL_DIR = 'docs/protocol';
export const INDEX_PATH = 'docs/protocol/methods/mcp-bindings.md';
export const HELP_CONSTANTS = ['WORKSPACE_API_DESCRIPTION', 'WORKSPACE_API_DESCRIPTION_CHIEF'];

// `ws.*` names the docs may still mention as history after a rename. Each entry maps the
// old name to the current call shape; the value is informational (shown in failure hints).
export const RENAMED_BINDINGS = new Map([
  ['ws.agent.spawnPeer', 'ws.agent.create({ topLevel: true })'], // renamed in v8.1
]);

const IDENT_SRC = '[A-Za-z_$][A-Za-z0-9_$]*';
// A complete `ws.<segment>(.<segment>)*` name: full JS identifier segments, no partial match of a longer identifier.
const NAME_SRC = `ws\\.${IDENT_SRC}(?:\\.${IDENT_SRC})*(?![A-Za-z0-9_$])`;
const NAME_RE = new RegExp(`(?<![A-Za-z0-9_$])${NAME_SRC}`, 'g');
const HELP_LINE_RE = new RegExp(`^  (${NAME_SRC})\\(`);
const CODE_SPAN_RE = /`([^`\n]+)`/g;
const IDENT_RE = new RegExp(IDENT_SRC, 'g');
const IGNORED_IDENTS = new Set(['null', 'true', 'false', 'undefined', 'string', 'number', 'boolean', 'void']);

export function formatError({ file, line, message }) {
  return `${file}:${line}: error: ${message}`;
}

/** Extract the raw-string bodies of both help-text constants from tools.rs. */
export function extractHelpText(rustSource) {
  const result = { missing: [] };
  for (const [key, name] of [['base', HELP_CONSTANTS[0]], ['chief', HELP_CONSTANTS[1]]]) {
    const m = rustSource.match(new RegExp(`const ${name}\\s*:\\s*&str\\s*=\\s*r(#*)"([\\s\\S]*?)"\\1;`));
    if (!m) result.missing.push(name);
    result[key] = m ? m[2] : '';
  }
  return result;
}

/**
 * Same length as `text`, with the contents of every `"…"` / `'…'` literal (escape-aware; an unterminated literal
 * runs to the end) blanked to spaces so brackets, commas, colons and identifiers inside literals never count.
 */
export function maskLiterals(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const quote = text[i];
    if (quote !== '"' && quote !== "'") {
      out += quote;
      continue;
    }
    out += quote;
    for (i += 1; i < text.length; i += 1) {
      if (text[i] === '\\' && i + 1 < text.length) {
        out += '  ';
        i += 1;
        continue;
      }
      if (text[i] === quote) {
        out += quote;
        break;
      }
      out += ' ';
    }
  }
  return out;
}

/** Index of the `)` matching the `(` at `open` (parentheses inside string literals ignored), or -1 when unbalanced. */
function matchParen(text, open) {
  const masked = maskLiterals(text);
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Remove every `: <value>` expression (up to the next same-depth `,` or closing bracket); `text` is literal-masked. */
function stripValues(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ':') {
      out += text[i];
      continue;
    }
    let depth = 0;
    for (i += 1; i < text.length; i += 1) {
      const c = text[i];
      if ('{[('.includes(c)) depth += 1;
      else if ('}])'.includes(c)) {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ',' && depth === 0) break;
    }
    i -= 1;
  }
  return out;
}

/**
 * Identifiers used as names in a parameter list or result shape: literals, keywords, and the identifier right
 * after `:` are dropped. `dropValues` also drops everything nested inside a `: <value>` expression, which is
 * what a prose call such as `ws.x({ options: [{ label: "A" }] })` needs (`label` is example data, not an option).
 */
export function identifiersIn(text, { dropValues = false } = {}) {
  const literalFree = maskLiterals(text);
  const clean = dropValues ? stripValues(literalFree) : literalFree;
  const names = [];
  for (const m of clean.matchAll(IDENT_RE)) {
    const before = clean.slice(0, m.index).trimEnd();
    if (before.endsWith(':') || IGNORED_IDENTS.has(m[0])) continue;
    if (!names.includes(m[0])) names.push(m[0]);
  }
  return names;
}

/** Split an argument list on top-level commas (ignoring commas nested in `{}`, `[]`, `()` or string literals). */
export function splitArgs(text) {
  const masked = maskLiterals(text);
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if ('{[('.includes(c)) depth += 1;
    else if ('}])'.includes(c)) depth -= 1;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== '') args.push(last);
  return args;
}

/** Split `ws.x.y(<params>) → <result>` into its parts, or null when the text is not a signature. */
function splitSignature(text) {
  const open = text.indexOf('(');
  const close = matchParen(text, open);
  if (open === -1 || close === -1) return null;
  const rest = text.slice(close + 1);
  const arrow = rest.match(/^\s*→\s*(.*)$/);
  return { name: text.slice(0, open), params: text.slice(open + 1, close), result: arrow ? arrow[1].trim() : null };
}

/** The lines of the `API:` section (up to the next unindented heading), or every line when there is no such section. */
function apiSectionLines(helpText) {
  const lines = helpText.split('\n');
  const start = lines.findIndex((l) => /^API:\s*$/.test(l));
  if (start === -1) return lines;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Parse the `  ws.<name>(<params>) → <result>  // <comment>` entries of one help text's API section. */
export function parseBindings(helpText) {
  const bindings = [];
  for (const raw of apiSectionLines(helpText)) {
    if (!HELP_LINE_RE.test(raw)) continue;
    const comment = raw.indexOf('  //');
    const sig = splitSignature((comment === -1 ? raw : raw.slice(0, comment)).trim());
    if (!sig || sig.result === null) continue;
    bindings.push({
      name: sig.name,
      params: identifiersIn(sig.params),
      positional: splitArgs(sig.params),
      resultFields: identifiersIn(sig.result),
      signature: `${sig.name}(${sig.params}) → ${sig.result}`,
    });
  }
  return bindings;
}

/** Union of several binding lists by name; the first occurrence of a name wins. */
export function mergeBindings(...lists) {
  const byName = new Map();
  for (const list of lists) for (const b of list) if (!byName.has(b.name)) byName.set(b.name, b);
  return [...byName.values()];
}

export function namespaceOf(name) {
  return name.slice(0, name.lastIndexOf('.'));
}

const INDEX_HEADER = `> Part of the [Intent JSON-RPC protocol docs](../README.md) — MCP \`ws.*\` binding signature index.

<!-- GENERATED FILE — do not edit by hand. Rendered by scripts/check-mcp-bindings.mjs from the
     WORKSPACE_API_DESCRIPTION / WORKSPACE_API_DESCRIPTION_CHIEF constants in
     ${TOOLS_RS_PATH}; regenerate with
     \`node scripts/check-mcp-bindings.mjs --write\`. -->

## MCP \`ws.*\` binding signatures

Every \`ws.<namespace>.<method>\` binding the workspace MCP tool exposes, with its parameters and
result shape exactly as the pinned intentd help text states them (comment text omitted). A prose
paragraph elsewhere under \`docs/protocol/\` that documents a binding must agree with its line here.
`;

/** Render the golden signature index: one heading per namespace, signatures in a fenced block, sorted. */
export function renderIndex(bindings) {
  const byNs = new Map();
  for (const b of bindings) {
    const ns = namespaceOf(b.name);
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(b);
  }
  const out = [INDEX_HEADER];
  for (const ns of [...byNs.keys()].sort()) {
    const lines = byNs.get(ns).map((b) => b.signature).sort();
    out.push(`### ${ns}\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n`);
  }
  return out.join('\n');
}

/**
 * `ws.*` mentions in a markdown text outside fenced code blocks: bare names plus inline-code call signatures.
 * String literals inside inline-code spans are masked first, so a `ws.*`-looking string value in an example is
 * data, not a mention; bare prose is scanned as written (an apostrophe there is not a literal opener).
 */
export function collectDocMentions(markdown) {
  const names = [];
  const signatures = [];
  let inFence = false;
  markdown.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const scanned = raw.replace(CODE_SPAN_RE, (_, code) => `\`${maskLiterals(code)}\``);
    for (const m of scanned.matchAll(NAME_RE)) names.push({ name: m[0], line });
    for (const span of raw.matchAll(CODE_SPAN_RE)) {
      const code = span[1];
      for (const m of maskLiterals(code).matchAll(new RegExp(`(?<![A-Za-z0-9_$])${NAME_SRC}\\(`, 'g'))) {
        const open = m.index + m[0].length - 1;
        const close = matchParen(code, open);
        if (close === -1) continue;
        signatures.push({ name: m[0].slice(0, -1), args: code.slice(open + 1, close), line });
      }
    }
  });
  return { names, signatures };
}

/** Signature lines of an index text keyed by binding name (fenced `ws.…(` lines only). */
export function indexSignatures(indexText) {
  const map = new Map();
  let inFence = false;
  for (const raw of indexText.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || !new RegExp(`^${NAME_SRC}\\(`).test(raw)) continue;
    const sig = splitSignature(raw.trim());
    if (sig) map.set(sig.name, raw.trim());
  }
  return map;
}

const WRITE_HINT = 'run `node scripts/check-mcp-bindings.mjs --write` to regenerate the index, then update the prose that documents the binding';

/** Check 1: the committed index against the rendered one. `committed` is null when the file is absent. */
export function checkIndex(bindings, committed, { indexPath = INDEX_PATH } = {}) {
  const rendered = renderIndex(bindings);
  if (committed === null) return [{ file: indexPath, line: 1, message: `index is missing — ${WRITE_HINT}` }];
  if (committed === rendered) return [];
  const errors = [];
  const want = indexSignatures(rendered);
  const have = indexSignatures(committed);
  const lineOf = (name) => committed.split('\n').findIndex((l) => l.startsWith(`${name}(`)) + 1 || 1;
  for (const [name, sig] of want) {
    if (!have.has(name)) errors.push({ file: indexPath, line: 1, message: `${name} is in the help text but missing from the index: ${sig} — ${WRITE_HINT}` });
    else if (have.get(name) !== sig) errors.push({ file: indexPath, line: lineOf(name), message: `${name} differs from the help text: index has "${have.get(name)}" but the help text has "${sig}" — ${WRITE_HINT}` });
  }
  for (const [name, sig] of have) {
    if (!want.has(name)) errors.push({ file: indexPath, line: lineOf(name), message: `${name} is in the index but not in the help text: ${sig} — ${WRITE_HINT}` });
  }
  if (errors.length === 0) errors.push({ file: indexPath, line: 1, message: `index text differs from the rendered output outside the signature lines — ${WRITE_HINT}` });
  return errors;
}

/** Checks 2 + 3 for one doc: stale names and stale options in inline-code signatures. */
export function checkDoc(file, mentions, bindings, { renamed = RENAMED_BINDINGS } = {}) {
  const errors = [];
  const byName = new Map(bindings.map((b) => [b.name, b]));
  const isNamespace = (name) => bindings.some((b) => b.name.startsWith(`${name}.`));
  for (const { name, line } of mentions.names) {
    if (byName.has(name) || renamed.has(name) || isNamespace(name)) continue;
    errors.push({ file, line, message: `${name} is not a binding in the pinned intentd help text (${TOOLS_RS_PATH}); if it was renamed, add it to RENAMED_BINDINGS in scripts/check-mcp-bindings.mjs` });
  }
  for (const { name, args, line } of mentions.signatures) {
    const binding = byName.get(name);
    if (!binding) continue;
    for (const ident of proseOptionNames(binding, args)) {
      if (binding.params.includes(ident)) continue;
      errors.push({ file, line, message: `${name}: "${ident}" is not a parameter or option of ${name} in the help text — signature is ${binding.signature}` });
    }
  }
  return errors;
}

/**
 * Identifiers a prose call uses as parameter/option names that the help text can vouch for. A destructured
 * argument at a position where the help text takes an opaque bag (e.g. `opts?`) is skipped: its option names
 * live in comment text, not the signature, so `ws.agent.create({ topLevel: true })` is not checkable.
 */
export function proseOptionNames(binding, args) {
  const names = [];
  splitArgs(args).forEach((arg, i) => {
    const helpArg = binding.positional[i];
    if (arg.includes('{') && helpArg !== undefined && !helpArg.includes('{')) return;
    for (const ident of identifiersIn(arg, { dropValues: true })) if (!names.includes(ident)) names.push(ident);
  });
  return names;
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function walkMarkdown(dir, rel = '') {
  const out = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkMarkdown(path.join(dir, entry.name), relPath)));
    else if (entry.name.endsWith('.md')) out.push(relPath);
  }
  return out;
}

/** Run all three checks against `root`; returns `{ errors, skipped, wrote, bindings }`. */
export async function runChecks(root, { write = false } = {}) {
  const rustText = await readIfExists(path.join(root, TOOLS_RS_PATH));
  if (rustText === null) return { errors: [], skipped: `skipped: ${TOOLS_RS_PATH} (submodule not initialized)`, wrote: false, bindings: [] };
  const help = extractHelpText(rustText);
  const errors = help.missing.map((name) => ({ file: TOOLS_RS_PATH, line: 1, message: `could not extract the ${name} constant` }));
  if (help.missing.length) return { errors, skipped: null, wrote: false, bindings: [] };
  const bindings = mergeBindings(parseBindings(help.base), parseBindings(help.chief));

  const indexFile = path.join(root, INDEX_PATH);
  let wrote = false;
  if (write) {
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await fs.writeFile(indexFile, renderIndex(bindings));
    wrote = true;
  }
  errors.push(...checkIndex(bindings, await readIfExists(indexFile)));

  const protocolDir = path.join(root, PROTOCOL_DIR);
  for (const rel of await walkMarkdown(protocolDir)) {
    const text = await fs.readFile(path.join(protocolDir, rel), 'utf8');
    errors.push(...checkDoc(`${PROTOCOL_DIR}/${rel}`, collectDocMentions(text), bindings));
  }
  return { errors, skipped: null, wrote, bindings };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const rootArg = args.find((a) => !a.startsWith('--'));
  const root = rootArg ? path.resolve(rootArg) : process.cwd();
  const { errors, skipped, wrote, bindings } = await runChecks(root, { write });
  if (skipped) console.log(skipped);
  if (wrote) console.log(`Wrote ${INDEX_PATH} (${bindings.length} bindings).`);
  if (errors.length === 0) {
    if (!skipped) console.log(`MCP ws.* bindings are consistent (${bindings.length} bindings).`);
    return;
  }
  for (const e of errors) console.error(formatError(e));
  console.error(`${errors.length} MCP binding error(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
