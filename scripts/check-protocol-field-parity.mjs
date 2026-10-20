#!/usr/bin/env node

// Check that every wire field an intentd serde struct emits is consumed by (or
// deliberately ignored for) its cloudlands-fe TypeScript counterpart. The Rust
// struct is the source of truth: fields are walked with their serde attributes
// (`rename_all`, `rename`, `skip` / `skip_serializing`, `flatten` into a
// same-file struct), then compared with the top-level property names of the
// named TS `interface` / `z.object` block. Each manifest pair carries an
// `ignore` map for fields the FE intentionally does not consume; a stale
// ignore entry (field no longer emitted, or now present in the TS type) is a
// warning, not an error, so an FE PR that declares a previously ignored field
// is not deadlocked against the monorepo entry (intent-hq/intent#5497).
// A daemon-first field the FE has not adopted yet is not an ignore entry: it
// is a row of the "Staged row fields (app adoption pending)" table in
// docs/protocol/versioning.md, which lands with the field's docs before the
// intentd PR (docs lead the pin). A staged field missing from the TS type is a
// warning; a row the FE has adopted, or whose field is not emitted, warns too.
// A malformed table fails closed (intent-hq/intent#7233 needed checker edits).
// Attributes the scanner cannot interpret but that may change the wire shape
// (`cfg_attr`, `cfg`, unknown serde arguments) fail closed. A pair whose
// submodule is not initialized is skipped; a manifest path missing from an
// initialized submodule fails.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { describeCheckout, formatBanner, formatOffPinWarning, submoduleOf } from './submodule-ref.mjs';

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
    },
  },
];

export const STAGED_DOC = 'docs/protocol/versioning.md';
export const STAGED_HEADING = 'Staged row fields (app adoption pending)';
const STAGED_COLUMNS = ['Row', 'Field', 'Contract', 'App adoption'];
const STAGED_NAME_RE = /^`?([A-Za-z_][A-Za-z0-9_]*)`?$/;

function tableCells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((c) => c.trim());
}

/**
 * Parse the staged daemon-first field table under `### <STAGED_HEADING>` in
 * `markdown`. Returns `{ staged, errors }`: `staged` maps a Rust struct name to
 * a Map of wire field → `{ file, line, adoption }`. Every row must name a
 * manifest struct, a field, a contract and the app adoption that retires it.
 */
export function parseStagedFields(markdown, file = STAGED_DOC, pairs = PAIRS) {
  const staged = new Map();
  const errors = [];
  const fail = (line, message) => errors.push({ file, line, message: `${STAGED_HEADING}: ${message}` });
  const lines = markdown.split('\n');
  const headingRe = /^#{1,6}\s+(.*?)\s*$/;
  const start = lines.findIndex((l) => l.match(headingRe)?.[1] === STAGED_HEADING);
  if (start === -1) {
    fail(1, `heading not found; restore the section (with its ${STAGED_COLUMNS.join(' | ')} table) in ${file}`);
    return { staged, errors };
  }
  let i = start + 1;
  while (i < lines.length && !headingRe.test(lines[i]) && !lines[i].trim().startsWith('|')) i += 1;
  if (i >= lines.length || !lines[i].trim().startsWith('|')) {
    fail(start + 1, `no table follows the heading; expected columns ${STAGED_COLUMNS.join(' | ')}`);
    return { staged, errors };
  }
  const header = tableCells(lines[i]);
  if (header.join('|') !== STAGED_COLUMNS.join('|')) {
    fail(i + 1, `table columns are ${header.join(' | ')}; expected ${STAGED_COLUMNS.join(' | ')}`);
    return { staged, errors };
  }
  if (!/^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1] ?? '')) {
    fail(i + 2, 'the header row must be followed by a | --- | separator row');
    return { staged, errors };
  }
  const structs = new Map(pairs.map((p) => [p.rust.struct, p]));
  for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
    const line = i + 1;
    const cells = tableCells(lines[i]);
    if (cells.length !== STAGED_COLUMNS.length) {
      fail(line, `row has ${cells.length} cell(s); expected ${STAGED_COLUMNS.length}`);
      continue;
    }
    const [rowCell, fieldCell, contract, adoption] = cells;
    const row = rowCell.match(STAGED_NAME_RE)?.[1];
    const field = fieldCell.match(STAGED_NAME_RE)?.[1];
    if (!row || !field) {
      fail(line, `Row and Field must be single identifiers (got ${rowCell || '(empty)'} / ${fieldCell || '(empty)'})`);
      continue;
    }
    if (!contract || !adoption) {
      fail(line, `${row}.${field} needs a Contract link and the App adoption (cloudlands-fe PR or issue) that retires it`);
      continue;
    }
    const pair = structs.get(row);
    if (!pair) {
      fail(line, `Row ${row} is not a checked row struct (${[...structs.keys()].join(', ')}); add a pair to PAIRS in scripts/check-protocol-field-parity.mjs first`);
      continue;
    }
    if (Object.hasOwn(pair.ignore, field)) {
      fail(line, `${row}.${field} is also a PAIRS ignore entry; keep one: the ignore entry for a field the FE never reads, the staged row for pending adoption`);
      continue;
    }
    if (!staged.has(row)) staged.set(row, new Map());
    if (staged.get(row).has(field)) {
      fail(line, `${row}.${field} is listed twice (first at line ${staged.get(row).get(field).line})`);
      continue;
    }
    staged.get(row).set(field, { file, line, adoption });
  }
  return { staged, errors };
}

// A diagnostic is `{ file, line, message, severity? }`; `severity` is
// `'warning'` for stale ignore entries and staged fields, absent for errors.
export function formatDiagnostic({ file, line, message, severity }) {
  return `${file}:${line}: ${severity ?? 'error'}: ${message}`;
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

/**
 * Compare one pair's emitted fields with its TS keys; returns diagnostics
 * (`{ file, line, message, severity? }`). Missing fields and parse failures are
 * errors; stale ignore entries and staged fields carry `severity: 'warning'`.
 * `staged` is this pair's Map from `parseStagedFields` (wire → `{ file, line, adoption }`).
 */
export function comparePair(pair, rustSource, tsSource, staged = new Map()) {
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
    const entry = staged.get(f.wire);
    if (entry) {
      errors.push({
        file: rustFile,
        line: f.line,
        severity: 'warning',
        message: `${label}: staged daemon-first field ${pair.rust.struct}.${f.wire} (Rust ${f.rustName}) is not in ${pair.ts.type} yet (${tsRange}); app adoption pending: ${entry.adoption} (${entry.file}:${entry.line})`,
      });
      continue;
    }
    errors.push({
      file: rustFile,
      line: f.line,
      message: `${label}: emitted field ${pair.rust.struct}.${f.wire} (Rust ${f.rustName}) is missing from ${pair.ts.type} (${tsRange}); add it to the TS type (and normalizer if needed), stage a daemon-first field in the "${STAGED_HEADING}" table of ${STAGED_DOC}, or add an ignore entry with a reason in scripts/check-protocol-field-parity.mjs for a field the FE never reads`,
    });
  }
  for (const [wire, entry] of staged) {
    if (!emitted.has(wire)) {
      errors.push({ file: entry.file, line: entry.line, severity: 'warning', message: `${label}: staged field ${wire} is not emitted by ${pair.rust.struct}; expected while its intentd change has not reached this checkout (docs lead the pin), otherwise remove the row` });
    } else if (tsKeys.has(wire)) {
      errors.push({ file: entry.file, line: entry.line, severity: 'warning', message: `${label}: stale staged field ${wire} — ${pair.ts.type} now declares it (${tsFile}:${tsKeys.get(wire)}); remove the row from the "${STAGED_HEADING}" table` });
    }
  }
  for (const [wire, reason] of Object.entries(pair.ignore)) {
    if (!emitted.has(wire)) {
      errors.push({ file: rustFile, line: rust.structLine, severity: 'warning', message: `${label}: stale ignore entry ${wire} ("${reason}") — ${pair.rust.struct} no longer emits it; remove the entry from PAIRS` });
    } else if (tsKeys.has(wire)) {
      errors.push({ file: tsFile, line: tsKeys.get(wire), severity: 'warning', message: `${label}: stale ignore entry ${wire} ("${reason}") — ${pair.ts.type} now declares it; remove the entry from PAIRS` });
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

/** The stdout line naming the submodule ref a pair's files were read from, or null when no ref is known. */
export function formatRefBanner(ref) {
  return formatBanner(ref, { check: 'check-protocol-field-parity', what: 'sources' });
}

/** The stderr warning for a submodule checkout that is off the recorded pin, or null. */
export function formatRefOffPinWarning(ref) {
  const remedy = ref?.pinDir
    ? `Run git submodule update --checkout ${ref.pinDir} and rerun without component overrides to compare against the pin.`
    : undefined;
  return formatOffPinWarning(ref, { remedy });
}

// Keep the manifest's canonical component identity separate from the selected
// path: source reads/diagnostics follow the latter, recorded gitlinks the former.
function selectFile(file, dirs) {
  const sub = submoduleOf(file);
  const explicit = sub !== null && dirs[sub] !== undefined;
  const dir = explicit ? dirs[sub] : sub;
  return { sub, dir, explicit, file: explicit ? path.join(dir, path.relative(sub, file)) : file };
}

// `{ source }` when readable, `{ skipped: true }` when the file's submodule is
// not initialized, `{ error }` when the path is stale inside an initialized
// submodule (or outside any submodule).
async function readManifestFile(root, { file, sub, dir, explicit }) {
  if (explicit && !dir) return { error: { file, line: 1, message: `selected ${sub} root must not be empty` } };
  if (sub && !(await exists(path.resolve(root, dir, '.git')))) {
    if (!explicit) return { skipped: true };
    return { error: { file, line: 1, message: `selected ${sub} root ${dir} is missing or not initialized (.git not found)` } };
  }
  if (explicit && !describeCheckout(root, dir, { pinDir: sub }).checkout) {
    return { error: { file, line: 1, message: `selected ${sub} root ${dir} is not a repository root with a readable HEAD` } };
  }
  if (!(await exists(path.resolve(root, file)))) {
    const where = sub ? `submodule ${dir} is initialized` : 'not inside a submodule';
    return { error: { file, line: 1, message: `manifest path ${file} does not exist (${where}); update PAIRS in scripts/check-protocol-field-parity.mjs` } };
  }
  try {
    return { source: await fs.readFile(path.resolve(root, file), 'utf8') };
  } catch (error) {
    return { error: { file, line: 1, message: `cannot read manifest path ${file}: ${error.code}` } };
  }
}

/**
 * Run every manifest pair against `root`; returns `{ errors, warnings, checked, skipped, refs }`.
 * `warnings` are stale ignore entries and staged daemon-first fields; only `errors` fail the check.
 * The staged table is read from `root`'s `STAGED_DOC` (monorepo docs, never a component root).
 * `refs` holds one submodule ref per distinct component a compared file was read from, in
 * first-read order. Optional `intentdDir` / `feDir` select roots relative to `root` (or absolute);
 * unlike absent default submodules, explicitly selected missing roots fail.
 */
export async function runChecks(root, pairs = PAIRS, { intentdDir, feDir } = {}) {
  const errors = [];
  const warnings = [];
  const checked = [];
  const skipped = [];
  const refs = new Map();
  let stagedSource = '';
  try {
    stagedSource = await fs.readFile(path.resolve(root, STAGED_DOC), 'utf8');
  } catch (error) {
    errors.push({ file: STAGED_DOC, line: 1, message: `cannot read the staged daemon-first field table: ${error.code}` });
  }
  const { staged, errors: stagedErrors } = stagedSource ? parseStagedFields(stagedSource, STAGED_DOC, pairs) : { staged: new Map(), errors: [] };
  errors.push(...stagedErrors);
  const dirs = { 'packages/intentd': intentdDir, 'packages/cloudlands-fe': feDir };
  for (const pair of pairs) {
    const sources = [selectFile(pair.rust.file, dirs), selectFile(pair.ts.file, dirs)];
    const selectedPair = { ...pair, rust: { ...pair.rust, file: sources[0].file }, ts: { ...pair.ts, file: sources[1].file } };
    const [rust, ts] = await Promise.all(sources.map((source) => readManifestFile(root, source)));
    for (const r of [rust, ts]) if (r.error) errors.push(r.error);
    const missing = [rust.skipped && pair.rust.file, ts.skipped && pair.ts.file].filter(Boolean);
    if (missing.length > 0) {
      skipped.push(`skipped: ${pairLabel(pair)} (${missing.join(', ')} missing — submodule not initialized)`);
      continue;
    }
    if (rust.error || ts.error) continue;
    for (const { sub, dir } of sources) {
      if (sub && !refs.has(sub)) refs.set(sub, describeCheckout(root, dir, { pinDir: sub }));
    }
    for (const d of comparePair(selectedPair, rust.source, ts.source, staged.get(pair.rust.struct))) (d.severity === 'warning' ? warnings : errors).push(d);
    checked.push(pairLabel(pair));
  }
  return { errors, warnings, checked, skipped, refs: [...refs.values()] };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'intentd-dir': { type: 'string' }, 'fe-dir': { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error('Usage: check-protocol-field-parity.mjs [root] [--intentd-dir DIR] [--fe-dir DIR]');
  const root = positionals[0] ? path.resolve(positionals[0]) : process.cwd();
  const { errors, warnings, checked, skipped, refs } = await runChecks(root, PAIRS, {
    intentdDir: values['intentd-dir'], feDir: values['fe-dir'],
  });
  for (const ref of refs) {
    const banner = formatRefBanner(ref);
    const offPin = formatRefOffPinWarning(ref);
    if (banner) console.log(banner);
    if (offPin) console.error(offPin);
  }
  for (const s of skipped) console.log(s);
  for (const w of warnings) console.error(formatDiagnostic(w));
  const warningSummary = warnings.length > 0 ? `${warnings.length} warning(s): stale ignore entries or staged daemon-first fields` : '';
  if (errors.length === 0) {
    const suffix = warningSummary ? ` ${warningSummary}; see the warnings above.` : '';
    console.log(`Protocol field parity holds for ${checked.length} pair(s): ${checked.join('; ')}.${suffix}`);
    return;
  }
  for (const e of errors) console.error(formatDiagnostic(e));
  console.error(`check-protocol-field-parity: ${errors.length} error(s)${warningSummary ? `, ${warningSummary}` : ''}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
