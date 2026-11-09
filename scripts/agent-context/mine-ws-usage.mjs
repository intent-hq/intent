#!/usr/bin/env node
// Rank ws.* method calls in stored workspace_api scripts and pick the hot set.
//
// Reads the local intentd SQLite database read-only. Sources: workspace_api tool_use
// blocks in agent_message.content, with the full input from agent_message_payload when
// the inline copy was truncated. String literals and comments are blanked before
// matching, and only names in today's ws.* help text count. Inputs whose full copy was
// pruned by intentd's payload retention count only up to the inline truncation point, so
// the counts are a slight undercount, good for ranking rather than exact totals.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { HELP_CONSTANTS, TOOLS_RS_PATH, extractHelpText, mergeBindings, parseBindings } from '../check-mcp-bindings.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CALL_RE = /(?<![\w$.])ws((?:\s*\??\.\s*[A-Za-z_$][\w$]*)+)\s*(?:\?\.)?\s*\(/g;
const REGEX_AFTER_CHAR = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield']);
const MIN_NODE = [22, 13];
const ALIASES = new Map([['mr', 'pr']]);
const FUNCTION_PROPS = new Set(['toString', 'call', 'apply', 'bind']);

export function defaultDbPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.INTENTD_DATA_DIR) return path.join(env.INTENTD_DATA_DIR, 'intentd.db');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'intentd', 'intentd.db');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'intentd', 'intentd.db');
}

/**
 * Same length as `code`, with the text of string literals, template-literal text, regex literals and
 * comments blanked to spaces. Code inside `${…}` stays, so calls built into template strings still count.
 */
export function maskJs(code) {
  const out = code.split('');
  const stack = [];
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const startsRegex = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    if (k < 0) return true;
    if (REGEX_AFTER_CHAR.has(out[k])) return true;
    const word = out.slice(0, k + 1).join('').match(/[A-Za-z_$][\w$]*$/);
    return Boolean(word && REGEX_AFTER_WORD.has(word[0]) && !/[\w$.]/.test(out[k - word[0].length] ?? ''));
  };
  const scanRegex = () => {
    const start = i + 1;
    let inClass = false;
    for (i += 1; i < code.length && code[i] !== '\n'; i += 1) {
      const c = code[i];
      if (c === '\\') i += 1;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    blank(start, Math.min(i, code.length));
    i += 1;
  };
  const scanTemplate = () => {
    const start = i;
    while (i < code.length) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(start, i); i += 1; return; }
      if (c === '$' && code[i + 1] === '{') { blank(start, i); i += 2; stack.push(0); return; }
      i += 1;
    }
    blank(start, i);
  };
  while (i < code.length) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && startsRegex()) {
      scanRegex();
    } else if (c === '"' || c === "'") {
      const start = i + 1;
      for (i += 1; i < code.length && code[i] !== c && code[i] !== '\n'; i += 1) if (code[i] === '\\') i += 1;
      blank(start, Math.min(i, code.length));
      i += 1;
    } else if (c === '`') {
      i += 1;
      scanTemplate();
    } else if (c === '{' && stack.length) {
      stack[stack.length - 1] += 1;
      i += 1;
    } else if (c === '}' && stack.length) {
      if (stack[stack.length - 1] === 0) {
        stack.pop();
        i += 1;
        scanTemplate();
      } else {
        stack[stack.length - 1] -= 1;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Every `ws.<chain>(` call in `code` (literals and comments ignored), as `ws.a.b` names. `ws.mr.*` folds into
 * `ws.pr.*`, and a trailing `.call(`/`.toString(` counts as the method itself.
 */
export function callsIn(code) {
  const names = [];
  for (const m of maskJs(code).matchAll(CALL_RE)) {
    const parts = m[1].replace(/[\s?]/g, '').split('.').filter(Boolean);
    while (parts.length > 1 && FUNCTION_PROPS.has(parts[parts.length - 1])) parts.pop();
    if (parts.length && ALIASES.has(parts[0])) parts[0] = ALIASES.get(parts[0]);
    names.push(`ws.${parts.join('.')}`);
  }
  return names;
}

export function knownNamesFromToolsRs(rustSource) {
  const help = extractHelpText(rustSource);
  if (help.missing.length === HELP_CONSTANTS.length) throw new Error('no ws.* help constants found in tools.rs');
  return new Set(mergeBindings(parseBindings(help.base), parseBindings(help.chief)).map((b) => b.name));
}

function isWorkspaceApi(name) {
  return typeof name === 'string' && /(^|[_.:/-])workspace_api$/.test(name);
}

function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(`node:sqlite needs Node ${MIN_NODE.join('.')} or later (found ${version})`);
  }
}

export async function openReadOnly(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function decodePayload(encoding, body) {
  const buf = Buffer.from(body);
  return (encoding === 'zlib' ? zlib.inflateSync(buf) : buf).toString('utf8');
}

/** Yield the source of every workspace_api script stored in the database. */
export function* workspaceApiScripts(db) {
  const payload = db.prepare(
    "SELECT encoding, body FROM agent_message_payload WHERE message_id = ? AND block_ordinal = ? AND kind = 'tool_use_input'",
  );
  const rows = db.prepare(
    "SELECT id, content FROM agent_message WHERE role = 'assistant' AND content LIKE '%workspace_api%'",
  );
  for (const { id, content } of rows.iterate()) {
    let blocks;
    try {
      blocks = JSON.parse(content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const [ordinal, block] of blocks.entries()) {
      if (!block || block.type !== 'tool_use' || !isWorkspaceApi(block.name)) continue;
      let input = block.input;
      const full = payload.get(id, ordinal);
      if (full) {
        try {
          input = JSON.parse(decodePayload(full.encoding, full.body));
        } catch {
          // Keep the inline copy when the stored payload is unreadable.
        }
      }
      if (input && typeof input.code === 'string') yield input.code;
    }
  }
}

/** Count calls over `scripts` and rank the names in `known`. */
export function rank(scripts, known, { top = 30 } = {}) {
  const counts = new Map();
  const unknown = new Map();
  let scriptCount = 0;
  let calls = 0;
  for (const code of scripts) {
    scriptCount += 1;
    for (const name of callsIn(code)) {
      calls += 1;
      const target = known.has(name) ? counts : unknown;
      target.set(name, (target.get(name) ?? 0) + 1);
    }
  }
  const knownCalls = [...counts.values()].reduce((a, b) => a + b, 0);
  let running = 0;
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n], index) => {
      running += n;
      return { rank: index + 1, name, calls: n, share: n / knownCalls, cumulative: running / knownCalls };
    });
  const coverageAt = (n) => (ranked.length ? ranked[Math.min(n, ranked.length) - 1].cumulative : 0);
  const needed = (target) => (ranked.find((r) => r.cumulative >= target)?.rank ?? ranked.length);
  return {
    scripts: scriptCount,
    calls,
    knownCalls,
    unknownCalls: calls - knownCalls,
    knownNames: known.size,
    usedNames: ranked.length,
    neverCalled: [...known].filter((n) => !counts.has(n)).sort(),
    coverage: { top20: coverageAt(20), top25: coverageAt(25), top30: coverageAt(30) },
    namesFor90Percent: needed(0.9),
    hotSet: ranked.slice(0, top).map((r) => r.name),
    hotSetCoverage: coverageAt(top),
    ranked,
    unknown: [...unknown.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, calls: n })),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function formatReport(result, { limit = 60 } = {}) {
  const lines = [
    `scripts: ${result.scripts}  calls: ${result.calls}  to existing methods: ${result.knownCalls}  unknown: ${result.unknownCalls}`,
    `coverage: top 20 ${pct(result.coverage.top20)}, top 25 ${pct(result.coverage.top25)}, top 30 ${pct(result.coverage.top30)}; 90% needs ${result.namesFor90Percent} names`,
    `hot set (${result.hotSet.length}): ${pct(result.hotSetCoverage)}`,
    '',
    'rank  calls     share   cumul.  name',
  ];
  for (const r of result.ranked.slice(0, limit)) {
    lines.push(`${String(r.rank).padStart(4)}  ${String(r.calls).padStart(7)}  ${pct(r.share).padStart(6)}  ${pct(r.cumulative).padStart(6)}  ${r.name}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { db: defaultDbPath(), toolsRs: path.join(REPO_ROOT, TOOLS_RS_PATH), top: 30, json: null, limit: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--db') opts.db = value;
    else if (flag === '--tools-rs') opts.toolsRs = value;
    else if (flag === '--top') opts.top = Number(value);
    else if (flag === '--json') opts.json = value;
    else if (flag === '--limit') opts.limit = Number(value);
    else if (flag === '-h' || flag === '--help') {
      console.log('usage: mine-ws-usage.mjs [--db intentd.db] [--tools-rs tools.rs] [--top 30] [--limit 60] [--json out.json]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${flag}`);
    i += 1;
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) throw new Error('--top must be a positive integer');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.toolsRs)) throw new Error(`${opts.toolsRs} not found; init packages/intentd or pass --tools-rs`);
  if (!fs.existsSync(opts.db)) throw new Error(`${opts.db} not found; pass --db or set INTENTD_DATA_DIR`);
  const known = knownNamesFromToolsRs(fs.readFileSync(opts.toolsRs, 'utf8'));
  assertNodeVersion();
  const db = await openReadOnly(opts.db);
  try {
    const result = rank(workspaceApiScripts(db), known, { top: opts.top });
    console.log(formatReport(result, { limit: opts.limit }));
    if (opts.json) {
      const { ranked, unknown, ...summary } = result;
      const out = { generatedAt: new Date().toISOString(), ...summary, ranked, unknown: unknown.slice(0, 50) };
      fs.writeFileSync(opts.json, `${JSON.stringify(out, null, 2)}\n`);
      console.log(`\nwrote ${opts.json}`);
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`mine-ws-usage: ${err.message}`);
    process.exit(1);
  });
}
