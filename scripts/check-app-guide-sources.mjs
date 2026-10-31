#!/usr/bin/env node
// Every file the assistant app guide cites in a `<!-- Sources: ... -->` comment
// must exist in the component it names, at the commit under check. The guide
// is free prose, so these pointers are the only link between a documented
// behavior and the code that implements it; a pointer to a file that never
// landed (or was reverted) means the guide describes a feature the app lacks.
// Incident: the startup-progress paragraph cited src/shared/{startup-status,
// startup-monitor}.ts from the closed cloudlands-fe#3389 for weeks, promising a
// desktop "Starting intentd" screen the app did not have (fixed by
// intentd#2831).
//
// Reads git objects only (`git ls-tree`, `git cat-file`), never a component's
// working tree and never its code, so an upstream PR checkout cannot change
// what runs.
//
// Monorepo mode (default) resolves each component at its recorded gitlink and
// fails on any missing citation. `--upstream` (the component consumer job)
// resolves each checkout's HEAD instead: the caller's PR head, with the other
// component at its pin. There a missing intentd file fails (the guide lives in
// intentd, so the same PR can fix it) and a missing cloudlands-fe file only
// warns: either the intentd PR documents a frontend change that has not been
// pinned yet, or the frontend PR removes a cited file before the guide
// follows. The auto/submodule-bump PR runs in monorepo mode and stays strict.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const GUIDE_COMPONENT = 'intentd';
export const GUIDE_PATH = 'crates/intent-services/resources/assistant-app-guide.md';
// Components whose citations are checked, keyed by their monorepo directory.
export const COMPONENTS = { 'packages/intentd': 'intentd', 'packages/cloudlands-fe': 'cloudlands-fe' };
// packages/ios is private (`update = none`) and absent from CI checkouts.
export const SKIPPED = { 'packages/ios': 'ios' };

const COMMENT = /<!--([\s\S]*?)-->/g;
const SOURCES = /^\s*Sources?\b/i;
const HEADER = /^\s*Sources\s*(?:\(paths relative to ([^)\s]+)\))?\s*:/;

export function expandBraces(text) {
  const open = text.indexOf('{');
  if (open === -1) {
    if (text.includes('}')) throw new Error(`unbalanced '}' in ${text}`);
    return [text];
  }
  if (text.slice(0, open).includes('}')) throw new Error(`unbalanced '}' in ${text}`);
  const alternatives = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    else if (char === ',' && depth === 1) {
      alternatives.push(text.slice(start, i));
      start = i + 1;
    } else if (char === '}' && (depth -= 1) === 0) {
      alternatives.push(text.slice(start, i));
      const prefix = text.slice(0, open);
      const suffix = text.slice(i + 1);
      if (alternatives.length < 2) throw new Error(`brace group needs at least two alternatives in ${text}`);
      return alternatives.flatMap(alternative => expandBraces(prefix + alternative + suffix));
    }
  }
  throw new Error(`unbalanced '{' in ${text}`);
}

const count = (text, char) => text.split(char).length - 1;

// One whitespace-delimited word of a comment, without the prose punctuation
// around it or a `:120` / `#L40` location suffix: `see packages/intentd/NOTICE).`
// cites NOTICE, while `src/routes/(app)/settings/+page.svelte` keeps its
// balanced parentheses.
export function cleanToken(word) {
  let token = word;
  for (;;) {
    const before = token;
    token = token.replace(/^`+|`+$/g, '').replace(/[.;,:`]+$/, '');
    if (token.startsWith('(') && token.endsWith(')') && count(token, '(') === count(token, ')')) token = token.slice(1, -1);
    if (token.endsWith(')') && count(token, ')') > count(token, '(')) token = token.slice(0, -1);
    if (token.startsWith('(') && count(token, '(') > count(token, ')')) token = token.slice(1);
    token = token.replace(/#[^/]*$/, '').replace(/:\d+(?:-\d+)?$/, '');
    if (token === before) return token;
  }
}

// A word that names a file or directory rather than prose like `read/write`:
// a `packages/` path, or a relative path whose last segment has an extension
// or a brace group, or that ends in `/`. A top-level file under a relative
// base (`README.md`) has no `/` and must be cited as `packages/<component>/...`.
function isCitation(token) {
  if (token.includes('://') || token.startsWith('/')) return false;
  if (token.startsWith('packages/')) return true;
  return token.includes('/') && (token.includes('{') || /\/$|\.[A-Za-z0-9]+$/.test(token));
}

function componentOf(file) {
  for (const [dir, name] of Object.entries(COMPONENTS)) {
    if (file.startsWith(`${dir}/`)) return { name, dir, path: file.slice(dir.length + 1), skipped: false };
  }
  for (const [dir, name] of Object.entries(SKIPPED)) {
    if (file.startsWith(`${dir}/`)) return { name, dir, path: file.slice(dir.length + 1), skipped: true };
  }
  return null;
}

// Every cited file of the guide: [{ line, citation, file, component, path, skipped }]
// plus guide-format problems as [{ line, message }].
//
// Sources comments may set a relative base and must qualify every other path.
// Any other comment (for example `<!-- Auggie visibility: packages/... -->`)
// is free-form: only its `packages/...` paths are checked.
export function parseGuide(text) {
  const citations = [];
  const problems = [];
  let comments = 0;
  for (const match of text.matchAll(COMMENT)) {
    const line = text.slice(0, match.index).split('\n').length;
    let body = match[1];
    let base;
    const sources = SOURCES.test(body);
    if (sources) {
      comments += 1;
      const header = HEADER.exec(body);
      if (!header) {
        problems.push({ line, message: "malformed Sources comment: expected 'Sources:' or 'Sources (paths relative to packages/<component>):'" });
        continue;
      }
      base = header[1]?.replace(/\/+$/, '');
      if (base !== undefined && !(base in COMPONENTS) && !(base in SKIPPED)) {
        problems.push({ line, message: `unknown relative base '${base}' (expected one of ${[...Object.keys(COMPONENTS), ...Object.keys(SKIPPED)].join(', ')})` });
        continue;
      }
      body = body.slice(header[0].length);
    }
    for (const word of body.split(/\s+/)) {
      const citation = cleanToken(word);
      if (!isCitation(citation) || (!sources && !citation.startsWith('packages/'))) continue;
      let qualified = citation;
      if (!citation.startsWith('packages/')) {
        if (base === undefined) {
          problems.push({ line, message: `unqualified path '${citation}': prefix it with packages/<component>/ or use 'Sources (paths relative to packages/<component>):'` });
          continue;
        }
        qualified = `${base}/${citation}`;
      }
      let files;
      try {
        files = expandBraces(qualified);
      } catch (error) {
        problems.push({ line, message: `${citation}: ${error.message}` });
        continue;
      }
      for (const cited of files) {
        // A trailing slash cites a directory.
        const file = cited.replace(/\/$/, '');
        if (file.split('/').some(segment => segment === '..' || segment === '.' || segment === '')) {
          problems.push({ line, message: `${citation}: '${cited}' is not a normalized repository path` });
          continue;
        }
        const component = componentOf(file);
        if (!component) {
          problems.push({ line, message: `${citation}: '${cited}' names no known component (packages/intentd, packages/cloudlands-fe or packages/ios)` });
          continue;
        }
        citations.push({ line, citation, file, component: component.name, path: component.path, skipped: component.skipped });
      }
    }
  }
  return { comments, citations, problems };
}

export class CheckError extends Error {}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim().split('\n')[0];
    throw new CheckError(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

// The commit each component is checked at: its recorded gitlink, or (upstream)
// the checkout's own HEAD.
export function resolveRevision(root, dir, { upstream }) {
  const checkout = path.join(root, dir);
  let toplevel;
  try {
    toplevel = git(['rev-parse', '--show-toplevel'], checkout).trim();
  } catch {
    toplevel = '';
  }
  if (!toplevel || realpathSync(toplevel) !== realpathSync(checkout)) {
    throw new CheckError(`${dir} is not a checked-out repository; run 'git submodule update --init ${dir}' and retry`);
  }
  let rev;
  try {
    rev = upstream ? git(['rev-parse', 'HEAD'], checkout).trim() : git(['rev-parse', `HEAD:${dir}`], root).trim();
  } catch (error) {
    throw new CheckError(`cannot resolve ${upstream ? `HEAD of ${dir}` : `the ${dir} gitlink`}: ${error.message}; run from the monorepo root`);
  }
  try {
    git(['cat-file', '-e', `${rev}^{commit}`], checkout);
  } catch {
    throw new CheckError(`${dir} commit ${rev} is not present; run 'git submodule update --init ${dir}' (or 'git -C ${dir} fetch origin ${rev}') and retry`);
  }
  return rev;
}

// Files and directories of a commit, as repository-relative paths.
export function listTree(checkout, rev) {
  const entries = new Set();
  for (const file of git(['ls-tree', '-r', '-z', '--name-only', rev], checkout).split('\0')) {
    if (!file) continue;
    entries.add(file);
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) entries.add(file.slice(0, i));
  }
  return entries;
}

export function check({ root, upstream = false }) {
  const revisions = {};
  const trees = {};
  for (const [dir, name] of Object.entries(COMPONENTS)) {
    revisions[name] = resolveRevision(root, dir, { upstream });
    trees[name] = listTree(path.join(root, dir), revisions[name]);
  }
  const guideDir = Object.keys(COMPONENTS).find(dir => COMPONENTS[dir] === GUIDE_COMPONENT);
  if (!trees[GUIDE_COMPONENT].has(GUIDE_PATH)) {
    throw new CheckError(`${guideDir}/${GUIDE_PATH} is missing at ${GUIDE_COMPONENT} ${revisions[GUIDE_COMPONENT].slice(0, 7)}`);
  }
  const text = git(['cat-file', 'blob', `${revisions[GUIDE_COMPONENT]}:${GUIDE_PATH}`], path.join(root, guideDir));
  const { comments, citations, problems } = parseGuide(text);
  const guide = `${guideDir}/${GUIDE_PATH}`;
  const errors = problems.map(({ line, message }) => `${guide}:${line}: error: ${message}`);
  const warnings = [];
  const checked = new Set();
  let skipped = 0;
  for (const cite of citations) {
    if (cite.skipped) {
      skipped += 1;
      continue;
    }
    checked.add(cite.file);
    if (trees[cite.component].has(cite.path)) continue;
    const at = `${cite.component} ${revisions[cite.component].slice(0, 7)}`;
    const shown = cite.citation === cite.file ? cite.file : `${cite.file} (from ${cite.citation})`;
    if (upstream && cite.component !== GUIDE_COMPONENT) {
      warnings.push(`${guide}:${cite.line}: ${shown} is missing at ${at}; the auto/submodule-bump PR fails until the guide cites a file the pinned ${cite.component} has`);
    } else {
      errors.push(`${guide}:${cite.line}: error: ${shown} is missing at ${at}`);
    }
  }
  const pins = Object.entries(revisions).map(([name, rev]) => `${name} ${rev.slice(0, 7)}`).join(' and ');
  const scope = `${citations.length - skipped} citations (${checked.size} files) in ${comments} Sources comments at ${pins}; ${skipped} packages/ios citations skipped`;
  return { errors, warnings, scope };
}

function main() {
  const here = fileURLToPath(new URL('../', import.meta.url));
  let values;
  try {
    ({ values } = parseArgs({ options: { root: { type: 'string' }, upstream: { type: 'boolean', default: false } } }));
  } catch (error) {
    console.error(`app-guide-sources: ${error.message}\nusage: check-app-guide-sources.mjs [--root <monorepo>] [--upstream]`);
    return 2;
  }
  try {
    const result = check({ root: path.resolve(values.root ?? here), upstream: values.upstream });
    for (const warning of result.warnings) console.log(`::warning::app-guide-sources: ${warning}`);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(error);
      console.error(`app-guide-sources: ${result.errors.length} broken Sources citation(s) among ${result.scope}`);
      console.error('hint: point the comment at the file that implements the behavior, or remove the guide text that describes code the component does not have (fix it in intentd, then let auto-bump-submodules advance the pin).');
      return 1;
    }
    console.log(`app-guide-sources: ok, ${result.scope}${result.warnings.length ? `; ${result.warnings.length} upstream warning(s)` : ''}`);
    return 0;
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`app-guide-sources: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
