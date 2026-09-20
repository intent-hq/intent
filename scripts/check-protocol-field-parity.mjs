#!/usr/bin/env node

// Check that every wire field an intentd serde struct emits is consumed by (or
// deliberately ignored for) its cloudlands-fe TypeScript counterpart. The Rust
// struct is the source of truth: fields are walked with their serde attributes
// (`rename_all`, `rename`, `skip` / `skip_serializing`, `flatten` into a
// same-file struct), then compared with the top-level property names of the
// named TS `interface` / `z.object` block. Each manifest pair carries an
// `ignore` map for fields the FE intentionally does not consume; a stale
// ignore entry (field no longer emitted, or now present in the TS type) fails.
// Attributes the scanner cannot interpret but that may change the wire shape
// (`cfg_attr`, `cfg`, unknown serde arguments) fail closed. A pair whose
// submodule is not initialized is skipped; a manifest path missing from an
// initialized submodule fails.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODEL_RS = 'packages/intentd/crates/intent-core/src/model.rs';

export const PAIRS = [
  {
    rust: { file: MODEL_RS, struct: 'AgentLite' },
    ts: { file: 'packages/cloudlands-fe/src/shared/types/agent-session.ts', type: 'AgentSession' },
    ignore: {
      contextUsage: 'not consumed by the FE today (no reader of the row field)',
      contextReferences: 'read untyped through the agent-session slice (DETAIL_ONLY_SESSION_FIELDS in agent-session-slice.ts); accepted FE typing debt, not declared on the type',
      fileBlocks: 'read untyped through the agent-session slice (DETAIL_ONLY_SESSION_FIELDS and data.fileBlocks in agent-session-slice.ts); accepted FE typing debt, not declared on the type',
    },
  },
  {
    rust: { file: MODEL_RS, struct: 'Workspace' },
    ts: { file: 'packages/cloudlands-fe/src/shared/types.ts', type: 'Workspace' },
    ignore: {
      tokenUsage: 'read via workspace.getTokenUsage and the workspace:tokenUsage-changed event into the token-usage slice, not from the row',
      openInviteCount: 'multiplayer w1 membership summary; not consumed by the FE today',
    },
  },
];

export function formatError({ file, line, message }) {
  return `${file}:${line}: error: ${message}`;
}

export function pairLabel(pair) {
  return `${pair.rust.struct} → ${pair.ts.type}`;
}

export function toCamelCase(name) {
  return name.replace(/_+([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const SUPPORTED_RENAME_ALL = { camelCase: toCamelCase };

// Split `text` on commas outside string literals and parentheses.
function splitTopLevel(text) {
  const parts = [];
  let cur = '';
  let inStr = false;
  let paren = 0;
  for (const ch of text) {
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '(') paren += 1;
    else if (!inStr && ch === ')') paren -= 1;
    if (ch === ',' && !inStr && paren === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Canonical `#[name(` head of an attribute: Rust allows whitespace between `#`,
// `[`, the path and `(`, so `# [serde (..)]` is the same attribute as `#[serde(..)]`.
function attrHead(attr) {
  const m = attr.match(/^#\s*\[\s*([A-Za-z_][A-Za-z0-9_:]*)\s*(\(|\]|=)/);
  return m ? m[1] : null;
}

// Arguments of one `#[serde(...)]` attribute, or `null` for any other attribute.
function serdeArgs(attr) {
  if (attrHead(attr) !== 'serde') return null;
  const m = attr.match(/^#\s*\[\s*serde\s*\((.*)\)\s*\]$/);
  return m ? splitTopLevel(m[1]) : null;
}

// Parse `serialize = "x", deserialize = "y"` (either, both, any order);
// `null` when the body is anything else.
function directionalRename(inner) {
  const out = {};
  for (const part of splitTopLevel(inner)) {
    const m = part.match(/^(serialize|deserialize)\s*=\s*"([^"]*)"$/);
    if (!m || m[1] in out) return null;
    out[m[1]] = m[2];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// serde arguments that never change the emitted field names. Container
// `into` / `try_into` / `remote` serialize a different type, so the struct's
// own fields are not the wire shape and they are deliberately absent here.
const HARMLESS_SERDE_ARGS = {
  struct: new Set(['default', 'bound', 'deny_unknown_fields', 'crate', 'from', 'try_from', 'expecting', 'rename']),
  field: new Set(['default', 'bound', 'skip_serializing_if', 'skip_deserializing', 'deserialize_with', 'serialize_with', 'with', 'alias', 'borrow', 'getter']),
};
const SIMPLE_ARG_RE = /^([A-Za-z_]+)(?:\s*=\s*"[^"]*")?$/;

// Interpret the attributes on a struct (`level = "struct"`) or field
// (`level = "field"`). `attrs` are `{ text, line }`. Anything wire-affecting
// that is not understood lands in `unsupported` instead of being guessed.
function parseSerdeAttrs(attrs, level) {
  const out = { renameAll: null, rename: null, skip: false, flatten: false, unsupported: [] };
  for (const { text, line } of attrs) {
    const head = attrHead(text);
    if (head === 'cfg' || head === 'cfg_attr') {
      out.unsupported.push({ line, text, detail: 'conditional attributes cannot be evaluated' });
      continue;
    }
    const args = serdeArgs(text);
    if (!args) {
      if (head === 'serde') out.unsupported.push({ line, text, detail: 'serde attribute form is not understood' });
      continue;
    }
    for (const arg of args) {
      let m;
      let dir;
      if (level === 'struct' && (m = arg.match(/^rename_all\s*=\s*"([^"]*)"$/))) out.renameAll = m[1];
      else if (level === 'struct' && (m = arg.match(/^rename_all\s*\((.*)\)$/)) && (dir = directionalRename(m[1]))) {
        if (dir.serialize !== undefined) out.renameAll = dir.serialize;
      } else if (level === 'field' && (m = arg.match(/^rename\s*=\s*"([^"]*)"$/))) out.rename = m[1];
      else if (level === 'field' && (m = arg.match(/^rename\s*\((.*)\)$/)) && (dir = directionalRename(m[1]))) {
        if (dir.serialize !== undefined) out.rename = dir.serialize;
      } else if (level === 'field' && (arg === 'skip' || arg === 'skip_serializing')) out.skip = true;
      else if (level === 'field' && arg === 'flatten') out.flatten = true;
      else if ((m = arg.match(SIMPLE_ARG_RE)) && HARMLESS_SERDE_ARGS[level].has(m[1])) continue;
      else out.unsupported.push({ line, text, detail: `serde argument \`${arg}\` is not understood and may change the emitted name` });
    }
  }
  return out;
}

function unsupportedError(file, target, { line, text, detail }) {
  return {
    file,
    line,
    message: `unsupported attribute ${text} on ${target}: ${detail}; use a plain #[serde(rename / rename(serialize = ..) / skip / skip_serializing / flatten)] form or extend scripts/check-protocol-field-parity.mjs`,
  };
}

const ATTR_START_RE = /^\s*#\s*\[/;
const STRUCT_RE = (name) => new RegExp(`^\\s*pub(?:\\([^)]*\\))?\\s+struct\\s+${name}\\s*(?:<[^{]*>)?\\s*\\{\\s*$`);
const FIELD_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?\s*$/;
const RUST_CHAR_RE = /^'(?:[^'\\\n]|\\(?:[nrt0'"\\]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}))'/;

// Blank out `//` line comments and `/* */` block comments (nested) while
// keeping every newline, so line numbers survive. String, raw-string and char
// literals are copied through so comment markers inside them are kept.
export function stripRustComments(source) {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (depth > 0) {
      if (two === '/*') {
        depth += 1;
        i += 2;
      } else if (two === '*/') {
        depth -= 1;
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      depth = 1;
      i += 2;
      continue;
    }
    if (two === '//') {
      const end = source.indexOf('\n', i);
      if (end === -1) return out;
      i = end;
      continue;
    }
    const raw = source.slice(i).match(/^b?r(#*)"/);
    if (raw) {
      const close = `"${raw[1]}`;
      const end = source.indexOf(close, i + raw[0].length);
      const stop = end === -1 ? source.length : end + close.length;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += source[i];
          i += 1;
        }
        out += source[i];
        i += 1;
      }
      out += '"';
      i += 1;
      continue;
    }
    if (ch === "'") {
      const m = source.slice(i).match(RUST_CHAR_RE);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Update `[` / `]` depth for one line of an attribute, ignoring brackets inside
// string literals (with escapes). Returns the new depth; `state.inStr` carries
// an open string across lines.
function attrBracketDepth(line, depth, state) {
  for (let k = 0; k < line.length; k += 1) {
    const ch = line[k];
    if (state.inStr) {
      if (ch === '\\') k += 1;
      else if (ch === '"') state.inStr = false;
    } else if (ch === '"') state.inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
  }
  return depth;
}

// Split `source` into logical lines: a `#[...]` attribute spanning several
// physical lines is joined into one entry so multi-line serde attributes parse
// like single-line ones. `line` is the 1-based number of the first physical line.
function logicalLines(source) {
  const lines = source.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!ATTR_START_RE.test(lines[i])) {
      out.push({ text: lines[i], line: i + 1 });
      continue;
    }
    const start = i;
    const state = { inStr: false };
    let depth = 0;
    const parts = [];
    for (;;) {
      depth = attrBracketDepth(lines[i], depth, state);
      parts.push(lines[i].trim());
      if (depth <= 0 || i + 1 >= lines.length) break;
      i += 1;
    }
    out.push({ text: parts.join(' '), line: start + 1 });
  }
  return out;
}

function flattenTarget(rustType) {
  const inner = rustType.match(/^Option\s*<\s*(.+)\s*>$/);
  const ty = (inner ? inner[1] : rustType).trim();
  return ty.split('::').pop().replace(/<.*$/, '').trim();
}

/**
 * Collect the wire field names emitted by `pub struct <structName>` in `source`.
 * Returns `{ fields: [{ wire, rustName, line }], structLine }`; `fields` is
 * `null` when the struct is not found. `errors` names unsupported constructs.
 */
export function extractRustFields(source, structName, file, seen = new Set()) {
  const lines = logicalLines(stripRustComments(source));
  const idx = lines.findIndex((l) => STRUCT_RE(structName).test(l.text));
  const errors = [];
  if (idx === -1) return { fields: null, structLine: null, errors };
  const structLine = lines[idx].line;
  if (seen.has(structName)) {
    errors.push({ file, line: structLine, message: `struct ${structName} flattens itself (cycle)` });
    return { fields: [], structLine, errors };
  }
  seen.add(structName);

  const structAttrs = [];
  for (let i = idx - 1; i >= 0; i -= 1) {
    const l = lines[i].text.trim();
    if (ATTR_START_RE.test(l)) structAttrs.push({ text: l, line: lines[i].line });
    else if (l === '') continue;
    else break;
  }
  const { renameAll, unsupported } = parseSerdeAttrs(structAttrs, 'struct');
  for (const u of unsupported) errors.push(unsupportedError(file, `struct ${structName}`, u));
  const renamer = SUPPORTED_RENAME_ALL[renameAll];
  if (!renamer) {
    const have = renameAll === null ? 'no #[serde(rename_all)]' : `#[serde(rename_all = "${renameAll}")]`;
    errors.push({ file, line: structLine, message: `struct ${structName} has ${have}; only ${Object.keys(SUPPORTED_RENAME_ALL).join(', ')} is supported` });
  }
  if (errors.length > 0) return { fields: [], structLine, errors };

  const fields = [];
  let attrs = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const raw = lines[i].text;
    const l = raw.trim();
    if (l === '}') break;
    if (l === '') continue;
    if (ATTR_START_RE.test(l)) {
      attrs.push({ text: l, line: lines[i].line });
      continue;
    }
    const m = raw.match(FIELD_RE);
    if (!m) continue;
    const [, rustName, rustType] = m;
    const serde = parseSerdeAttrs(attrs, 'field');
    attrs = [];
    const line = lines[i].line;
    if (serde.unsupported.length > 0) {
      for (const u of serde.unsupported) errors.push(unsupportedError(file, `${structName}.${rustName}`, u));
      continue;
    }
    if (serde.skip) continue;
    if (serde.flatten) {
      const target = flattenTarget(rustType);
      const nested = extractRustFields(source, target, file, seen);
      if (nested.fields === null) {
        errors.push({ file, line, message: `field ${structName}.${rustName} is #[serde(flatten)] but struct ${target} is not defined in ${file}; only same-file structs can be flattened` });
        continue;
      }
      errors.push(...nested.errors);
      fields.push(...nested.fields);
      continue;
    }
    fields.push({ wire: serde.rename ?? renamer(rustName), rustName, line });
  }
  return { fields, structLine, errors };
}

const TS_ZOD_RE = (name) => new RegExp(`^\\s*export\\s+const\\s+${name}\\s*(?::[^=]*)?=\\s*z\\.object\\(\\{`);
const TS_INTERFACE_RE = (name) => new RegExp(`^\\s*export\\s+interface\\s+${name}\\b`);
const TS_KEY_RE = /^\s*(?:readonly\s+)?(?:([A-Za-z_$][A-Za-z0-9_$]*)|'([^']*)'|"([^"]*)")\s*\??\s*[:(]/;

// Strip `//` and `/* */` comments and template contents, and drop brackets
// (`{}()[]`) inside string literals (escapes honored), so they do not affect
// depth tracking while quoted keys stay matchable. `state` carries an open
// block comment or template literal across lines.
function stripNoise(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end === -1) return out;
      state.block = false;
      i = end + 2;
      continue;
    }
    if (state.template) {
      const end = line.indexOf('`', i);
      if (end === -1) return out;
      state.template = false;
      i = end + 1;
      continue;
    }
    const two = line.slice(i, i + 2);
    const ch = line[i];
    if (two === '//') return out;
    if (two === '/*') {
      state.block = true;
      i += 2;
      continue;
    }
    if (ch === '`') {
      state.template = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += ch;
      i += 1;
      while (i < line.length && line[i] !== ch) {
        const escaped = line[i] === '\\';
        const c = escaped ? line[i + 1] : line[i];
        if (c !== undefined && !'{}()[]'.includes(c)) out += escaped ? '\\' + c : c;
        i += escaped ? 2 : 1;
      }
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Locate the `{` opening the declaration body on cleaned lines starting at
// `idx`: for `z.object({` it is on the declaration line; for an interface it
// is the first `{` outside the generic parameters / `extends` type arguments
// (angle brackets balanced, `=>` skipped), possibly lines later. `null` when
// no body opens.
function findTsBodyOpen(clean, idx, typeName) {
  const zod = clean[idx].match(TS_ZOD_RE(typeName));
  if (zod) return { line: idx, col: zod.index + zod[0].length - 1 };
  const head = clean[idx].match(TS_INTERFACE_RE(typeName));
  let angle = 0;
  for (let i = idx, col = head.index + head[0].length; i < clean.length; i += 1, col = 0) {
    const text = clean[i];
    for (; col < text.length; col += 1) {
      const ch = text[col];
      if (ch === '=' && text[col + 1] === '>') col += 1;
      else if (ch === '<') angle += 1;
      else if (ch === '>') angle -= 1;
      else if (ch === '{' && angle === 0) return { line: i, col };
    }
  }
  return null;
}

/**
 * Collect the top-level property names of `export interface <typeName>` or
 * `export const <typeName> = z.object({` in `source`. Returns
 * `{ keys: [{ name, line }], startLine, endLine }`, or `null` when the block
 * is not found. Declarations inside comments or template literals are not
 * candidates; names inside parameter lists `( )` and tuples `[ ]` are not keys.
 */
export function extractTsKeys(source, typeName) {
  const lines = source.split('\n');
  const zodRe = TS_ZOD_RE(typeName);
  const interfaceRe = TS_INTERFACE_RE(typeName);
  const state = { block: false, template: false };
  const clean = [];
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    clean.push(stripNoise(lines[i], state));
    if (idx === -1 && (zodRe.test(clean[i]) || interfaceRe.test(clean[i]))) idx = i;
  }
  if (idx === -1) return null;
  const open = findTsBodyOpen(clean, idx, typeName);
  if (open === null) return null;
  const keys = [];
  let brace = 1;
  let paren = 0;
  let bracket = 0;
  let endLine = lines.length;
  for (let i = open.line; i < lines.length; i += 1) {
    const body = i === open.line ? clean[i].slice(open.col + 1) : clean[i];
    if (i > open.line && brace === 1 && paren === 0 && bracket === 0) {
      const m = body.match(TS_KEY_RE);
      if (m) keys.push({ name: m[1] ?? m[2] ?? m[3], line: i + 1 });
    }
    for (const ch of body) {
      if (ch === '{') brace += 1;
      else if (ch === '}') brace -= 1;
      else if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket -= 1;
    }
    if (brace <= 0) {
      endLine = i + 1;
      break;
    }
  }
  return { keys, startLine: idx + 1, endLine };
}

/** Compare one pair's emitted fields with its TS keys; returns `{ file, line, message }` errors. */
export function comparePair(pair, rustSource, tsSource) {
  const label = pairLabel(pair);
  const rustFile = pair.rust.file;
  const tsFile = pair.ts.file;
  const rust = extractRustFields(rustSource, pair.rust.struct, rustFile);
  const errors = [...rust.errors];
  if (rust.fields === null) {
    errors.push({ file: rustFile, line: 1, message: `${label}: pub struct ${pair.rust.struct} not found` });
  }
  const ts = extractTsKeys(tsSource, pair.ts.type);
  if (ts === null) {
    errors.push({ file: tsFile, line: 1, message: `${label}: export interface ${pair.ts.type} / export const ${pair.ts.type} = z.object({ not found` });
  }
  if (rust.fields === null || ts === null || errors.length > 0) return errors;

  const tsKeys = new Map(ts.keys.map((k) => [k.name, k.line]));
  const tsRange = `${tsFile}:${ts.startLine}-${ts.endLine}`;
  const emitted = new Map(rust.fields.map((f) => [f.wire, f]));
  for (const f of rust.fields) {
    if (tsKeys.has(f.wire) || Object.hasOwn(pair.ignore, f.wire)) continue;
    errors.push({
      file: rustFile,
      line: f.line,
      message: `${label}: emitted field ${pair.rust.struct}.${f.wire} (Rust ${f.rustName}) is missing from ${pair.ts.type} (${tsRange}); add it to the TS type (and normalizer if needed) or add an ignore entry with a reason in scripts/check-protocol-field-parity.mjs`,
    });
  }
  for (const [wire, reason] of Object.entries(pair.ignore)) {
    if (!emitted.has(wire)) {
      errors.push({ file: rustFile, line: rust.structLine, message: `${label}: stale ignore entry ${wire} ("${reason}") — ${pair.rust.struct} no longer emits it; remove the entry from PAIRS` });
    } else if (tsKeys.has(wire)) {
      errors.push({ file: tsFile, line: tsKeys.get(wire), message: `${label}: stale ignore entry ${wire} ("${reason}") — ${pair.ts.type} now declares it; remove the entry from PAIRS` });
    }
  }
  return errors;
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function submoduleOf(file) {
  const m = file.match(/^(packages\/[^/]+)\//);
  return m ? m[1] : null;
}

// `{ source }` when readable, `{ skipped: true }` when the file's submodule is
// not initialized, `{ error }` when the path is stale inside an initialized
// submodule (or outside any submodule).
async function readManifestFile(root, file) {
  const sub = submoduleOf(file);
  if (sub && !(await exists(path.join(root, sub, '.git')))) return { skipped: true };
  if (!(await exists(path.join(root, file)))) {
    const where = sub ? `submodule ${sub} is initialized` : 'not inside a submodule';
    return { error: { file, line: 1, message: `manifest path ${file} does not exist (${where}); update PAIRS in scripts/check-protocol-field-parity.mjs` } };
  }
  return { source: await fs.readFile(path.join(root, file), 'utf8') };
}

/** Run every manifest pair against `root`; returns `{ errors, checked, skipped }`. */
export async function runChecks(root, pairs = PAIRS) {
  const errors = [];
  const checked = [];
  const skipped = [];
  for (const pair of pairs) {
    const [rust, ts] = await Promise.all([readManifestFile(root, pair.rust.file), readManifestFile(root, pair.ts.file)]);
    for (const r of [rust, ts]) if (r.error) errors.push(r.error);
    const missing = [rust.skipped && pair.rust.file, ts.skipped && pair.ts.file].filter(Boolean);
    if (missing.length > 0) {
      skipped.push(`skipped: ${pairLabel(pair)} (${missing.join(', ')} missing — submodule not initialized)`);
      continue;
    }
    if (rust.error || ts.error) continue;
    errors.push(...comparePair(pair, rust.source, ts.source));
    checked.push(pairLabel(pair));
  }
  return { errors, checked, skipped };
}

async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const { errors, checked, skipped } = await runChecks(root);
  for (const s of skipped) console.log(s);
  if (errors.length === 0) {
    console.log(`Protocol field parity holds for ${checked.length} pair(s): ${checked.join('; ')}.`);
    return;
  }
  for (const e of errors) console.error(formatError(e));
  console.error(`check-protocol-field-parity: ${errors.length} error(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
