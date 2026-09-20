#!/usr/bin/env node

// Check that every wire field an intentd serde struct emits is consumed by (or
// deliberately ignored for) its cloudlands-fe TypeScript counterpart. The Rust
// struct is the source of truth: fields are walked with their serde attributes
// (`rename_all`, `rename`, `skip` / `skip_serializing`, `flatten` into a
// same-file struct), then compared with the top-level property names of the
// named TS `interface` / `z.object` block. Each manifest pair carries an
// `ignore` map for fields the FE intentionally does not consume; a stale
// ignore entry (field no longer emitted, or now present in the TS type) fails.
// A pair whose submodule is not initialized is skipped.

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
      contextReferences: 'rides the wire row untyped; carried forward by DETAIL_ONLY_SESSION_FIELDS in agent-session-slice.ts, never declared on the type',
      fileBlocks: 'rides the wire row untyped; carried forward by DETAIL_ONLY_SESSION_FIELDS in agent-session-slice.ts, never declared on the type',
    },
  },
  {
    rust: { file: MODEL_RS, struct: 'Workspace' },
    ts: { file: 'packages/cloudlands-fe/src/shared/types.ts', type: 'Workspace' },
    ignore: {
      tokenUsage: 'read via workspace.getTokenUsage and the workspace:tokenUsage-changed event into the token-usage slice, not from the row',
      ownerPrincipalId: 'multiplayer w1 membership summary; not consumed by the FE today',
      myRole: 'multiplayer w1 membership summary; not consumed by the FE today',
      memberCount: 'multiplayer w1 membership summary; not consumed by the FE today',
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

// Split the body of one `#[serde(...)]` attribute on top-level commas.
function serdeArgs(attr) {
  const m = attr.match(/^#\[serde\((.*)\)\]$/);
  if (!m) return null;
  const args = [];
  let cur = '';
  let inStr = false;
  for (const ch of m[1]) {
    if (ch === '"') inStr = !inStr;
    if (ch === ',' && !inStr) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function parseSerdeAttrs(attrs) {
  const out = { renameAll: null, rename: null, skip: false, flatten: false };
  for (const attr of attrs) {
    const args = serdeArgs(attr);
    if (!args) continue;
    for (const arg of args) {
      let m;
      if ((m = arg.match(/^rename_all\s*=\s*"([^"]*)"$/))) out.renameAll = m[1];
      else if ((m = arg.match(/^rename\s*=\s*"([^"]*)"$/))) out.rename = m[1];
      else if (arg === 'skip' || arg === 'skip_serializing') out.skip = true;
      else if (arg === 'flatten') out.flatten = true;
    }
  }
  return out;
}

const STRUCT_RE = (name) => new RegExp(`^\\s*pub(?:\\([^)]*\\))?\\s+struct\\s+${name}\\s*(?:<[^{]*>)?\\s*\\{\\s*$`);
const FIELD_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?\s*$/;

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
  const lines = source.split('\n');
  const idx = lines.findIndex((l) => STRUCT_RE(structName).test(l));
  const errors = [];
  if (idx === -1) return { fields: null, structLine: null, errors };
  const structLine = idx + 1;
  if (seen.has(structName)) {
    errors.push({ file, line: structLine, message: `struct ${structName} flattens itself (cycle)` });
    return { fields: [], structLine, errors };
  }
  seen.add(structName);

  const structAttrs = [];
  for (let i = idx - 1; i >= 0; i -= 1) {
    const l = lines[i].trim();
    if (l.startsWith('#[')) structAttrs.push(l);
    else if (l.startsWith('//') || l === '') continue;
    else break;
  }
  const { renameAll } = parseSerdeAttrs(structAttrs);
  const renamer = SUPPORTED_RENAME_ALL[renameAll];
  if (!renamer) {
    const have = renameAll === null ? 'no #[serde(rename_all)]' : `#[serde(rename_all = "${renameAll}")]`;
    errors.push({ file, line: structLine, message: `struct ${structName} has ${have}; only ${Object.keys(SUPPORTED_RENAME_ALL).join(', ')} is supported` });
    return { fields: [], structLine, errors };
  }

  const fields = [];
  let attrs = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const l = raw.trim();
    if (l === '}') break;
    if (l === '' || l.startsWith('//')) continue;
    if (l.startsWith('#[')) {
      attrs.push(l);
      continue;
    }
    const m = raw.match(FIELD_RE);
    if (!m) continue;
    const [, rustName, rustType] = m;
    const serde = parseSerdeAttrs(attrs);
    attrs = [];
    const line = i + 1;
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

const TS_BLOCK_RE = (name) =>
  new RegExp(`^\\s*export\\s+(?:interface\\s+${name}\\b[^{]*\\{|const\\s+${name}\\s*(?::[^=]*)?=\\s*z\\.object\\(\\{)`);
const TS_KEY_RE = /^\s*(?:readonly\s+)?(?:([A-Za-z_$][A-Za-z0-9_$]*)|'([^']*)'|"([^"]*)")\s*\??\s*[:(]/;

// Strip `//` and `/* */` comments plus string/template contents so braces
// inside them do not affect depth tracking. `state` carries an open block
// comment or template literal across lines.
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
      const end = line.indexOf(ch, i + 1);
      out += ch + (end === -1 ? line.slice(i + 1) : line.slice(i + 1, end)) + ch;
      i = end === -1 ? line.length : end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Collect the top-level property names of `export interface <typeName> {` or
 * `export const <typeName> = z.object({` in `source`. Returns
 * `{ keys: [{ name, line }], startLine, endLine }`, or `null` when the block
 * is not found.
 */
export function extractTsKeys(source, typeName) {
  const lines = source.split('\n');
  const re = TS_BLOCK_RE(typeName);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) return null;
  const keys = [];
  const state = { block: false, template: false };
  let depth = 0;
  let endLine = lines.length;
  for (let i = idx; i < lines.length; i += 1) {
    const clean = stripNoise(lines[i], state);
    const body = i === idx ? clean.slice(clean.indexOf('{')) : clean;
    if (i > idx && depth === 1) {
      const m = body.match(TS_KEY_RE);
      if (m) keys.push({ name: m[1] ?? m[2] ?? m[3], line: i + 1 });
    }
    for (const ch of body) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) {
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
    if (tsKeys.has(f.wire) || f.wire in pair.ignore) continue;
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

async function readIfAvailable(root, file) {
  const sub = submoduleOf(file);
  if (sub && !(await exists(path.join(root, sub, '.git')))) return null;
  if (!(await exists(path.join(root, file)))) return null;
  return fs.readFile(path.join(root, file), 'utf8');
}

/** Run every manifest pair against `root`; returns `{ errors, checked, skipped }`. */
export async function runChecks(root, pairs = PAIRS) {
  const errors = [];
  const checked = [];
  const skipped = [];
  for (const pair of pairs) {
    const [rustSource, tsSource] = await Promise.all([readIfAvailable(root, pair.rust.file), readIfAvailable(root, pair.ts.file)]);
    const missing = [rustSource === null && pair.rust.file, tsSource === null && pair.ts.file].filter(Boolean);
    if (missing.length > 0) {
      skipped.push(`skipped: ${pairLabel(pair)} (${missing.join(', ')} missing — submodule not initialized)`);
      continue;
    }
    errors.push(...comparePair(pair, rustSource, tsSource));
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
