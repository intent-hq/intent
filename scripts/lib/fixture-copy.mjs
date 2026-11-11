// Shared export / verify / check for docs/protocol fixtures that component
// repositories keep a copy of. Every copied fixture describes itself once with
// defineFixtureCopy(); scripts/check-fixture-copies.mjs fails on any component
// file that copies a fixture without such a description.
//
// Docs lead the pin: the canonical file changes here first, and a component
// copy may lag behind it. `check` (monorepo and upstream consumer checks) warns
// on a lagging copy and fails on a copy that disagrees with the source it
// claims, or claims a source this checkout has never had. Two provenance kinds:
//
// - `commit`: the copy is a directory (or one file) of exact canonical bytes
//   plus a lock naming the full monorepo commit it was exported from and the
//   copy hashes. Component CI runs `verify` against the monorepo checked out at
//   that commit.
// - `revision`: the copy is one JSON file carrying the canonical file's
//   integer revision field; a change to the cases bumps the revision.
//
// Dependency-free (Node built-ins only). Component CI sparse-checks out this
// file next to the fixture's contract script, so keep it importable alone.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

export const SOURCE_REPOSITORY = 'intent-hq/intent';
export const LIB_PATH = 'scripts/lib/fixture-copy.mjs';
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRAND = Symbol.for('intent-hq.fixture-copy');

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function equal(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** The Git blob id of `bytes`, so copies compare against history without fetching blobs. */
export function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
/** Parse `bytes`, requiring the JSON.stringify(value, null, 2) + newline form. */
export function readJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error.message})`);
  }
  requireValue(bytes.equals(jsonBytes(value)),
    `${label} must be formatted as JSON.stringify(value, null, 2) plus a newline`);
  return value;
}
/** True when the path exists in any form, including a dangling symlink. */
export function present(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}
export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}
function gitText(root, ...args) {
  try {
    return git(root, ...args).toString().trim();
  } catch {
    return null;
  }
}

/** 'ancestor' | 'unrelated' | 'unknown' (commit absent, e.g. a shallow checkout). */
export function commitAncestry(root, commit) {
  if (gitText(root, 'cat-file', '-e', `${commit}^{commit}`) === null) return 'unknown';
  return gitText(root, 'merge-base', '--is-ancestor', commit, 'HEAD') === null ? 'unrelated' : 'ancestor';
}

/**
 * Every committed version of the files under `pathspec`: { blobs: Map(blob id
 * → path), shallow }, or null outside a Git checkout. `-m` includes merge
 * resolutions, which plain `log --raw` omits, and `--full-history` keeps the
 * ancestry of a merge whose fixture matches one parent. Trees only: with --no-renames
 * nothing here downloads a blob in a `--filter=blob:none` partial clone.
 */
export function historyBlobs(root, pathspec) {
  const shallow = gitText(root, 'rev-parse', '--is-shallow-repository');
  if (shallow === null) return null;
  const blobs = new Map();
  const raw = git(root, 'log', '-m', '--full-history', '--no-renames', '--format=', '--raw', '--no-abbrev', '-z', '--', pathspec).toString('utf8');
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length - 1; i += 2) {
    const meta = fields[i].replace(/^\n+/, '').split(' ');
    if (meta.length >= 5 && meta[0].startsWith(':') && !/^0{40}$/.test(meta[3]) && !blobs.has(meta[3])) {
      blobs.set(meta[3], fields[i + 1]);
    }
  }
  return { blobs, shallow: shallow === 'true' };
}

/** true / false, or undefined when `componentRoot` is not a Git checkout. */
function componentReferences(componentRoot, marker) {
  try {
    execFileSync('git', ['-C', componentRoot, 'grep', '-q', '-F', marker, '--', '.', ':!CHANGELOG.md'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return error.status === 1 ? false : undefined;
  }
}

function uninspected(componentRoot, component) {
  const initialized = fs.existsSync(path.join(componentRoot, '.git'));
  return initialized
    ? 'pre-adoption pin'
    : `uninspected (checkout uninitialized${component === 'ios' ? '; private/optional' : ''})`;
}

function relative(file) {
  requireValue(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file)
    && !file.split(/[\\/]/).includes('..'), `fixture copy path must be relative without '..': ${file}`);
  return file;
}

/**
 * Describe one copied fixture.
 *
 * Common fields: `name` (kebab-case, used in messages), `sourcePath`
 * (repo-relative, under docs/protocol/fixtures), `provenance` ('commit' |
 * 'revision'), `copies` ({ component: paths }) and `validate(location)`, which
 * checks today's canonical fixture and returns a one-line summary. Copies are
 * never held to today's validation: an older copy is judged only by its
 * provenance, so tightening the rules never fails a lagging copy.
 *
 * `commit`: `sourcePath` is a directory holding exactly `files`; each copy is
 * `{ directory, lock }`. `lockFields(filesBytes)` adds fixture-specific lock
 * keys (default `{ files: { name: sha256 } }`). `sameSourceAcrossComponents`
 * requires every adopted copy to carry the same lock.
 *
 * Single-file `commit`: omit `files`; `sourcePath` is one file and each copy is
 * `{ file, lock }` (the copy may have a different name). The bytes are exact
 * and need only parse when the file is JSON. The default lock key is
 * `fileSha256`. The lock alone declares adoption: a copy file without a lock is
 * a pre-adoption pin, so a component's existing copy can be registered before
 * the component exports its lock. A pre-adoption copy must still equal a
 * committed canonical version.
 *
 * `revision`: `sourcePath` is one JSON file with a positive integer
 * `revisionField` (default 'revision'); each copy is `{ file }`.
 *
 * `reference` (per copy, optional): a string whose presence in a component
 * that has no copy means the copy went missing rather than was never adopted.
 * Defaults to the lock (commit) or copy file (revision) basename.
 */
export function defineFixtureCopy(spec) {
  const {
    name, sourcePath, provenance, copies, validate,
    files = [], lockFields, sameSourceAcrossComponents = false, revisionField = 'revision',
  } = spec;
  requireValue(typeof name === 'string' && NAME.test(name), 'fixture copy name must be kebab-case');
  requireValue(['commit', 'revision'].includes(provenance), `${name}: provenance must be 'commit' or 'revision'`);
  relative(sourcePath);
  requireValue(sourcePath.startsWith('docs/protocol/fixtures/'), `${name}: sourcePath must be under docs/protocol/fixtures/`);
  requireValue(typeof validate === 'function', `${name}: validate(location) is required`);
  requireValue(copies && typeof copies === 'object' && Object.keys(copies).length > 0, `${name}: copies must name at least one component`);
  const single = provenance === 'commit' && Object.values(copies).some((paths) => paths?.file !== undefined);
  for (const [component, paths] of Object.entries(copies)) {
    if (single) {
      requireValue(paths?.directory === undefined, `${name}: commit copies are all { directory, lock } or all { file, lock }`);
      relative(paths?.file);
      relative(paths?.lock);
      requireValue(path.posix.normalize(paths.file) !== path.posix.normalize(paths.lock), `${name}: ${component} copy and lock must be different files`);
    } else if (provenance === 'commit') {
      relative(paths?.directory);
      relative(paths?.lock);
    } else {
      relative(paths?.file);
    }
    requireValue(paths.reference === undefined || typeof paths.reference === 'string', `${name}: ${component}.reference must be a string`);
  }
  if (single) {
    requireValue(spec.files === undefined, `${name}: a single-file commit copy takes no files list`);
  } else if (provenance === 'commit') {
    requireValue(Array.isArray(files) && files.length > 0 && files.every((f) => typeof f === 'string' && !f.includes('/')),
      `${name}: commit provenance needs the list of copied file names`);
  }
  const components = Object.keys(copies);
  const label = name;
  // A single-file copy is handled as a one-file directory keyed by the source's basename.
  const names = single ? [path.posix.basename(sourcePath)] : files;
  const sourceFile = (file) => (single ? sourcePath : `${sourcePath}/${file}`);
  const defaultLockFields = (bytes) => (single
    ? { fileSha256: sha256(bytes[names[0]]) }
    : { files: Object.fromEntries(files.map((f) => [f, sha256(bytes[f])])) });
  const buildLock = (bytes, sourceCommit) => ({
    lockVersion: 1,
    sourceRepository: SOURCE_REPOSITORY,
    sourcePath,
    sourceCommit,
    ...(lockFields ?? defaultLockFields)(bytes),
  });

  function copyPaths(componentRoot, component) {
    requireValue(Object.hasOwn(copies, component),
      `${label}: unknown component ${component}; expected one of ${components.join(', ')}`);
    const spec = copies[component];
    if (single) return { file: path.join(componentRoot, spec.file), lock: path.join(componentRoot, spec.lock) };
    return provenance === 'commit'
      ? { directory: path.join(componentRoot, spec.directory), lock: path.join(componentRoot, spec.lock) }
      : { file: path.join(componentRoot, spec.file) };
  }

  /** Component-relative files a component's copy consists of (for the bypass check). */
  function copiedFiles(component) {
    const spec = copies[component];
    if (!spec) return [];
    if (single) return [spec.file];
    return provenance === 'commit' ? files.map((f) => path.posix.join(spec.directory, f)) : [spec.file];
  }

  function marker(component) {
    const spec = copies[component];
    return spec.reference ?? path.posix.basename(provenance === 'commit' ? spec.lock : spec.file);
  }

  // ---- commit provenance -------------------------------------------------

  /** A single-file copy (or canonical file): exact bytes, parsed only for validity. */
  function readSingleFile(file, what) {
    requireValue(fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(), `${what}: ${file} is missing or not a regular file`);
    const bytes = fs.readFileSync(file);
    requireValue(bytes.length > 0, `${what}: ${file} is empty`);
    if (file.endsWith('.json')) {
      try {
        JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        throw new Error(`${what}: invalid JSON (${error.message})`);
      }
    }
    return { [names[0]]: bytes };
  }

  /** The exact files of a copy (or canonical) directory; no content validation. */
  function readDirectory(directory, what) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    requireValue(stat?.isDirectory(), `${what}: directory ${directory} is missing or not a regular directory`);
    const extra = fs.readdirSync(directory).filter((f) => !files.includes(f)).sort();
    requireValue(extra.length === 0, `${what}: directory contains unexpected files: ${extra.join(', ')}`);
    const bytes = {};
    for (const file of files) {
      const full = path.join(directory, file);
      requireValue(fs.lstatSync(full, { throwIfNoEntry: false })?.isFile(), `${what}: ${file} is missing or not a regular file`);
      bytes[file] = fs.readFileSync(full);
      requireValue(bytes[file].length > 0, `${what}: ${file} is empty`);
      if (file.endsWith('.json')) readJsonBytes(bytes[file], `${what}: ${file}`);
    }
    return bytes;
  }

  function readCanonicalDirectory(root) {
    const location = path.join(root, sourcePath);
    const bytes = single ? readSingleFile(location, `${label} canonical`) : readDirectory(location, `${label} canonical`);
    return { bytes, summary: validate(location) };
  }

  function inspectLock(lockFile, what) {
    requireValue(fs.lstatSync(lockFile, { throwIfNoEntry: false })?.isFile(),
      `${what}: lock ${lockFile} is missing or not a regular file`);
    const lock = readJsonBytes(fs.readFileSync(lockFile), lockFile);
    requireValue(lock !== null && typeof lock === 'object' && !Array.isArray(lock), `${what}: lock must be an object`);
    equal(Object.keys(lock).sort(), Object.keys(buildLock(Object.fromEntries(names.map((f) => [f, Buffer.alloc(0)])), '')).sort(),
      `${what}: lock keys`);
    equal(lock.lockVersion, 1, `${what}: lockVersion`);
    equal(lock.sourceRepository, SOURCE_REPOSITORY, `${what}: sourceRepository`);
    equal(lock.sourcePath, sourcePath, `${what}: sourcePath`);
    requireValue(typeof lock.sourceCommit === 'string' && SHA.test(lock.sourceCommit),
      `${what}: lock sourceCommit must be a full 40-character lowercase Git SHA`);
    for (const [key, value] of Object.entries(lock)) {
      if (/Sha256$/.test(key)) requireValue(typeof value === 'string' && HASH.test(value), `${what}: lock ${key} must be SHA-256`);
    }
    return lock;
  }

  /** A component copy plus its lock: present, well formed and matching its own hashes. */
  function inspectCommitCopy(componentRoot, component) {
    const what = `${label} ${component}`;
    const paths = copyPaths(componentRoot, component);
    const lock = inspectLock(paths.lock, what);
    const bytes = single ? readSingleFile(paths.file, `${what} copy`) : readDirectory(paths.directory, `${what} copy`);
    requireValue(isDeepStrictEqual(lock, buildLock(bytes, lock.sourceCommit)),
      `${what}: copy bytes do not match the SHA-256 hashes in its lock; re-export the copy instead of editing it`);
    return { bytes, lock, paths };
  }

  /**
   * The canonical files at `sourceCommit`: `sourceRoot` must be a checkout
   * whose HEAD is that commit, with the files committed, so a copy never locks
   * uncommitted or unmerged expectations to a commit.
   */
  function requireSource(sourceRoot, sourceCommit) {
    requireValue(typeof sourceCommit === 'string' && SHA.test(sourceCommit),
      'source commit must be a full 40-character lowercase Git SHA');
    equal(git(sourceRoot, 'rev-parse', '--show-toplevel').toString().trim(), fs.realpathSync(sourceRoot),
      'source root must be the checkout root');
    equal(git(sourceRoot, 'rev-parse', 'HEAD').toString().trim(), sourceCommit, 'source checkout HEAD must equal the source commit');
    const source = readCanonicalDirectory(sourceRoot);
    for (const file of names) {
      requireValue(source.bytes[file].equals(git(sourceRoot, 'show', `${sourceCommit}:${sourceFile(file)}`)),
        `canonical ${file} differs from source commit ${sourceCommit}; commit it first`);
    }
    return source;
  }

  function exportCommitCopy({ sourceRoot, sourceCommit, component, componentRoot }) {
    // Validate everything before writing so a bad argument never leaves a half-updated copy.
    const source = requireSource(sourceRoot, sourceCommit);
    const paths = copyPaths(componentRoot, component);
    if (single) {
      requireValue(path.resolve(paths.file) !== path.resolve(sourceRoot, sourcePath), 'copy must be separate from canonical data');
      for (const file of [paths.lock, paths.file]) {
        const target = fs.lstatSync(file, { throwIfNoEntry: false });
        requireValue(!target || target.isFile(), `export target must be a regular file: ${file}`);
      }
      fs.mkdirSync(path.dirname(paths.file), { recursive: true });
      fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
      fs.writeFileSync(paths.file, source.bytes[names[0]]);
      fs.writeFileSync(paths.lock, jsonBytes(buildLock(source.bytes, sourceCommit)));
      verifyCommitCopy({ sourceRoot, sourceCommit, component, componentRoot });
      return `${label} ${component}: exported ${SOURCE_REPOSITORY}@${sourceCommit} (${source.summary})`;
    }
    requireValue(path.resolve(paths.directory) !== path.resolve(sourceRoot, sourcePath), 'copy must be separate from canonical data');
    const stat = fs.lstatSync(paths.directory, { throwIfNoEntry: false });
    if (stat) {
      requireValue(stat.isDirectory(), `${label} ${component}: copy directory ${paths.directory} is not a regular directory`);
      requireValue(fs.readdirSync(paths.directory).every((f) => files.includes(f)),
        `${label} ${component}: copy directory contains unexpected files`);
    }
    for (const file of [paths.lock, ...files.map((f) => path.join(paths.directory, f))]) {
      const target = fs.lstatSync(file, { throwIfNoEntry: false });
      requireValue(!target || target.isFile(), `export target must be a regular file: ${file}`);
    }
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(paths.directory, file), source.bytes[file]);
    fs.writeFileSync(paths.lock, jsonBytes(buildLock(source.bytes, sourceCommit)));
    verifyCommitCopy({ sourceRoot, sourceCommit, component, componentRoot });
    return `${label} ${component}: exported ${SOURCE_REPOSITORY}@${sourceCommit} (${source.summary})`;
  }

  /** Component CI: the copy must be byte-identical to the monorepo at its lock's commit. */
  function verifyCommitCopy({ sourceRoot, sourceCommit, component, componentRoot }) {
    const source = requireSource(sourceRoot, sourceCommit);
    const copy = inspectCommitCopy(componentRoot, component);
    requireValue(isDeepStrictEqual(copy.lock, buildLock(source.bytes, sourceCommit)),
      `${label} ${component}: copy provenance: its lock does not describe ${SOURCE_REPOSITORY}@${sourceCommit}`);
    for (const file of names) {
      requireValue(copy.bytes[file].equals(source.bytes[file]),
        `${label} ${component}: ${file} differs from ${SOURCE_REPOSITORY}@${sourceCommit}`);
    }
    return `${label} ${component}: copy matches ${SOURCE_REPOSITORY}@${sourceCommit} (${source.summary})`;
  }

  function checkCommitCopies(root) {
    const canonical = readCanonicalDirectory(root);
    const lines = [`${label}: canonical valid (${canonical.summary})`];
    const warnings = [];
    const adopted = [];
    for (const component of components) {
      const componentRoot = path.join(root, 'packages', component);
      const paths = copyPaths(componentRoot, component);
      // Either file declares adoption of a directory copy; a half-deleted copy
      // must fail, not skip. A single-file copy is adopted by its lock alone.
      const copyPresent = single ? false : present(paths.directory);
      if (!present(paths.lock) && !copyPresent) {
        const where = single ? copies[component].lock : copies[component].directory;
        requireValue(componentReferences(componentRoot, marker(component)) !== true,
          `${label} ${component}: the component references ${marker(component)} but has no ${single ? 'lock' : 'copy'} at ${where}`);
        if (single && present(paths.file)) {
          // Not yet adopted, but never a hand-edited copy: it must be a committed canonical version.
          const bytes = readSingleFile(paths.file, `${label} ${component} copy`)[names[0]];
          const history = historyBlobs(root, sourcePath);
          if (!history?.blobs.has(blobId(bytes))) {
            requireValue(history?.shallow === true,
              `${label} ${component}: ${copies[component].file} matches no committed version of ${sourcePath}; re-export the copy instead of editing it`);
            warnings.push(`${label} ${component}: pre-adoption copy ${copies[component].file} is not in this shallow checkout's history, so unverified`);
          }
          lines.push(`${component}: pre-adoption pin (copy without lock ${copies[component].lock}); conformance not claimed`);
          continue;
        }
        lines.push(`${component}: ${uninspected(componentRoot, component)}; conformance not claimed`);
        continue;
      }
      adopted.push({ component, ...inspectCommitCopy(componentRoot, component) });
    }
    if (sameSourceAcrossComponents && adopted.length > 1) {
      for (const other of adopted.slice(1)) {
        requireValue(isDeepStrictEqual(other.lock, adopted[0].lock),
          `${label}: conflicting adopted consumer pins: ${adopted[0].component} and ${other.component} must lock the same source`);
      }
    }
    for (const { component, bytes, lock } of adopted) {
      const commit = lock.sourceCommit;
      const current = names.every((f) => bytes[f].equals(canonical.bytes[f]));
      const ancestry = commitAncestry(root, commit);
      requireValue(ancestry !== 'unrelated',
        `${label} ${component}: lock commit ${commit} is not on this checkout's history; export from a merged monorepo commit`);
      if (ancestry === 'ancestor') {
        // Tree lookups only: blob ids need no blob download in a partial clone.
        for (const file of names) {
          const locked = gitText(root, 'rev-parse', '--verify', '--quiet', `${commit}:${sourceFile(file)}`);
          requireValue(locked === blobId(bytes[file]),
            `${label} ${component}: ${file} differs from ${SOURCE_REPOSITORY}@${commit}, the commit its lock names; re-export the copy instead of editing it`);
        }
      }
      let state = 'current';
      if (!current) {
        state = ancestry === 'ancestor'
          ? 'behind canonical (re-export to pick up the change)'
          : 'differs from canonical; lock commit not in this checkout, so ancestry is unverified';
        warnings.push(`${label} ${component}: copy at ${commit} is ${state}`);
      }
      lines.push(`${component}: adopted copy valid at ${commit}, ${state}; provenance is verified in component CI`);
    }
    return { report: lines.join('\n'), warnings };
  }

  // ---- revision provenance -----------------------------------------------

  function readRevisionFile(file, what) {
    requireValue(fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(), `${what}: ${file} is missing or not a regular file`);
    const bytes = fs.readFileSync(file);
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`${what}: invalid JSON (${error.message})`);
    }
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${what}: must be a JSON object`);
    return { bytes, value };
  }

  function readCanonicalFile(root) {
    const file = path.join(root, sourcePath);
    const canonical = readRevisionFile(file, `${label} canonical`);
    const revision = canonical.value[revisionField];
    requireValue(Number.isInteger(revision) && revision > 0, `${label} canonical: ${revisionField} must be a positive integer`);
    return { ...canonical, revision, summary: validate(file) };
  }

  /**
   * {} when current, { warn } when the copy lags, { fail } otherwise. A lagging
   * copy must be byte-identical to a committed canonical version (`history`
   * from historyBlobs); without full history it warns as unverified.
   */
  function revisionVerdict(canonical, copy, component, { bytes, history } = {}) {
    const at = copy[revisionField];
    const ahead = `land the ${sourcePath} change first`;
    if (!Number.isInteger(at) || at < 1) return { fail: `${label} ${component}: copy has no positive integer ${revisionField}; re-export it` };
    if (at > canonical[revisionField]) {
      return { fail: `${label} ${component}: copy is at ${revisionField} ${at}, ahead of ${sourcePath} (${canonical[revisionField]}); ${ahead}` };
    }
    if (at < canonical[revisionField]) {
      const behind = `${label} ${component}: copy is at ${revisionField} ${at}, behind ${sourcePath} (${canonical[revisionField]}); re-export it`;
      if (bytes && history && !history.blobs.has(blobId(bytes))) {
        if (!history.shallow) {
          return { fail: `${label} ${component}: copy at ${revisionField} ${at} matches no committed version of ${sourcePath}; re-export the copy instead of editing it` };
        }
        return { warn: `${behind} (not found in this shallow checkout's history, so unverified)` };
      }
      return { warn: behind };
    }
    if (!isDeepStrictEqual(copy, canonical)) {
      return { fail: `${label} ${component}: copy differs from ${sourcePath} at the same ${revisionField} ${at}; bump ${revisionField} when changing the cases, or re-export the copy` };
    }
    return {};
  }

  function exportRevisionCopy({ sourceRoot, sourceCommit, component, componentRoot }) {
    requireValue(sourceCommit === undefined, `${label}: revision provenance takes no source commit`);
    const canonical = readCanonicalFile(sourceRoot);
    const { file } = copyPaths(componentRoot, component);
    requireValue(path.resolve(file) !== path.resolve(sourceRoot, sourcePath), 'copy must be separate from canonical data');
    const target = fs.lstatSync(file, { throwIfNoEntry: false });
    requireValue(!target || target.isFile(), `export target must be a regular file: ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, canonical.bytes);
    return `${label} ${component}: exported ${revisionField} ${canonical.revision} (${canonical.summary})`;
  }

  function verifyRevisionCopy({ sourceRoot, sourceCommit, component, componentRoot }) {
    requireValue(sourceCommit === undefined, `${label}: revision provenance takes no source commit`);
    const canonical = readCanonicalFile(sourceRoot);
    const copy = readRevisionFile(copyPaths(componentRoot, component).file, `${label} ${component} copy`);
    const verdict = revisionVerdict(canonical.value, copy.value, component);
    requireValue(!verdict.fail && !verdict.warn, verdict.fail ?? verdict.warn);
    return `${label} ${component}: copy matches ${sourcePath} at ${revisionField} ${canonical.revision}`;
  }

  function checkRevisionCopies(root) {
    const canonical = readCanonicalFile(root);
    const lines = [`${label}: canonical valid at ${revisionField} ${canonical.revision} (${canonical.summary})`];
    const warnings = [];
    let history;
    for (const component of components) {
      const componentRoot = path.join(root, 'packages', component);
      const { file } = copyPaths(componentRoot, component);
      if (!present(file)) {
        requireValue(componentReferences(componentRoot, marker(component)) !== true,
          `${label} ${component}: the component references ${marker(component)} but has no copy at ${copies[component].file}`);
        lines.push(`${component}: ${uninspected(componentRoot, component)}; conformance not claimed`);
        continue;
      }
      const copy = readRevisionFile(file, `${label} ${component} copy`);
      history ??= historyBlobs(root, sourcePath) ?? undefined;
      const verdict = revisionVerdict(canonical.value, copy.value, component, { bytes: copy.bytes, history });
      requireValue(!verdict.fail, verdict.fail);
      if (verdict.warn) warnings.push(verdict.warn);
      lines.push(`${component}: adopted copy ${verdict.warn ? 'behind canonical' : 'current'}`);
    }
    return { report: lines.join('\n'), warnings };
  }

  const commit = provenance === 'commit';
  return Object.freeze({
    [BRAND]: true,
    name,
    sourcePath,
    provenance,
    components,
    copies,
    copiedFiles,
    copyPaths,
    /** Validate today's canonical fixture at `root`; returns its summary. */
    validateCanonical: (root) => (commit ? readCanonicalDirectory(root) : readCanonicalFile(root)).summary,
    inspectCopy: commit ? inspectCommitCopy : (componentRoot, component) =>
      readRevisionFile(copyPaths(componentRoot, component).file, `${label} ${component} copy`),
    exportCopy: commit ? exportCommitCopy : exportRevisionCopy,
    verifyCopy: commit ? verifyCommitCopy : verifyRevisionCopy,
    /** Monorepo/upstream check of the canonical fixture and every adopted copy: { report, warnings }. */
    checkCopies: commit ? checkCommitCopies : checkRevisionCopies,
    revisionVerdict: commit ? undefined : revisionVerdict,
  });
}

export function isFixtureCopy(value) {
  return value?.[BRAND] === true;
}

/**
 * The shared CLI every fixture contract script exposes:
 *   validate|check [--root MONOREPO]
 *   export|verify --source-root MONOREPO [--source-commit SHA] --component C --component-root DIR
 * `check` prints each lagging copy as a GitHub ::warning:: on stderr.
 */
export function fixtureCopyMain(copy, args, { script, defaultRoot, warn = (line) => console.warn(`::warning::${line}`) }) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      'source-root': { type: 'string' },
      'source-commit': { type: 'string' },
      component: { type: 'string' },
      'component-root': { type: 'string' },
    },
  });
  const commitArg = copy.provenance === 'commit' ? ' --source-commit SHA' : '';
  const usage = `usage: ${script} validate|check [--root MONOREPO] OR export|verify --source-root MONOREPO${commitArg} `
    + `--component ${copy.components.join('|')} --component-root COMPONENT`;
  const [command] = positionals;
  requireValue(positionals.length === 1 && ['validate', 'check', 'export', 'verify'].includes(command), usage);
  if (command === 'validate' || command === 'check') {
    requireValue(Object.keys(values).every((key) => key === 'root'), `${command} only accepts --root`);
    const root = path.resolve(values.root ?? defaultRoot);
    if (command === 'validate') return `${copy.name}: canonical valid (${copy.validateCanonical(root)})`;
    const { report, warnings } = copy.checkCopies(root);
    for (const line of warnings) warn(line);
    return report;
  }
  requireValue(values.root === undefined, `${command} does not accept --root; ${usage}`);
  const required = ['source-root', ...(commitArg ? ['source-commit'] : []), 'component', 'component-root'];
  for (const key of required) requireValue(typeof values[key] === 'string', `${command} requires --${key}; ${usage}`);
  if (!commitArg) requireValue(values['source-commit'] === undefined, `${command} does not accept --source-commit for revision provenance`);
  const options = {
    sourceRoot: path.resolve(values['source-root']),
    sourceCommit: values['source-commit'],
    component: values.component,
    componentRoot: path.resolve(values['component-root']),
  };
  return command === 'export' ? copy.exportCopy(options) : copy.verifyCopy(options);
}

/** Run `main` as a script entry point, prefixing errors with the script name. */
export function runScript(importMetaUrl, prefix, main) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(importMetaUrl)) return;
  try {
    console.log(main());
  } catch (error) {
    console.error(`${prefix}: ${error.message}`);
    process.exitCode = 1;
  }
}
