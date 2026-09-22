// Which submodule commit a consumer check read. A check that reads a file out of a
// `packages/<name>` checkout names that ref on stdout (banner) and warns on stderr when the
// checkout is off the gitlink the monorepo HEAD records, so a local result in a cross-component
// workspace is attributed to the right cause. Neither output changes an exit code.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const short = (sha) => sha.slice(0, 7);

/** Output of a git command, or null when it fails (not a repository, unknown ref, ...). */
function gitOrNull(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The `packages/<name>` submodule directory a repo-relative file lives in, or null. */
export function submoduleOf(file) {
  const m = file.match(/^(packages\/[^/]+)\//);
  return m ? m[1] : null;
}

const realpathOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * HEAD of the repository rooted exactly at the absolute `dir`, or null. A `packages/<name>` directory that holds
 * files but no repository of its own (a fixture fetched at the pin without `.git`) resolves to the enclosing
 * monorepo, whose HEAD must not be mistaken for a submodule checkout.
 */
function checkoutHead(dir) {
  const top = gitOrNull(['rev-parse', '--show-toplevel'], dir);
  if (!top || realpathOrNull(top) !== realpathOrNull(dir)) return null;
  return gitOrNull(['rev-parse', 'HEAD'], dir);
}

/**
 * The commit the submodule checkout at `root/dir` is at and the gitlink HEAD records; either is null when git
 * cannot tell. A known checkout also carries `dirty`: true when its tracked files have uncommitted changes, so
 * a result read from the working tree is not attributed to the commit HEAD names. `root` may be relative to the
 * process cwd (`runChecks('.')`); it is resolved once here so git is never handed a relative path as both cwd
 * and target.
 */
export function describeCheckout(root, dir) {
  const absRoot = path.resolve(root);
  const absDir = path.resolve(absRoot, dir);
  const checkout = checkoutHead(absDir);
  const ref = { source: 'checkout', dir, checkout, pin: gitOrNull(['rev-parse', `HEAD:${dir}`], absRoot) };
  if (checkout) ref.dirty = (gitOrNull(['status', '--porcelain', '--untracked-files=no'], absDir) ?? '') !== '';
  return ref;
}

/**
 * The stdout line naming the ref `what` was read from — `<check>: <component> <what> from <dir> checkout
 * <short> (recorded pin <short>)`, or `... from recorded pin <short>` for a `source: 'pin'` ref — or null
 * when no ref is known. The component is the submodule's directory name (`packages/intentd` → `intentd`).
 */
export function formatBanner(ref, { check, what }) {
  if (!ref) return null;
  const component = path.basename(ref.dir);
  if (ref.source === 'pin') return `${check}: ${component} ${what} from recorded pin ${short(ref.pin)}`;
  if (!ref.checkout) return null;
  const pin = ref.pin ? short(ref.pin) : 'unreadable';
  const dirty = ref.dirty ? ' (dirty)' : '';
  return `${check}: ${component} ${what} from ${ref.dir} checkout ${short(ref.checkout)}${dirty} (recorded pin ${pin})`;
}

/**
 * The stderr warning for a checkout whose result does not reflect the recorded pin — off the pin, or at it
 * with uncommitted changes — or null when it is clean at the pin (or unknown). `remedy` is the trailing
 * sentence telling the reader how to compare against the pin; the default restores the checkout, a check with
 * a pinned mode passes its own.
 */
export function formatOffPinWarning(ref, { remedy } = {}) {
  if (!ref || ref.source !== 'checkout' || !ref.checkout || !ref.pin) return null;
  const offPin = ref.checkout !== ref.pin;
  if (!offPin && !ref.dirty) return null;
  const how = remedy ?? `Run git submodule update --checkout ${ref.dir} to compare against the pin.`;
  if (!offPin) {
    return `warning: ${ref.dir} checkout ${short(ref.checkout)} has uncommitted changes; results reflect the working tree, not the recorded pin ${short(ref.pin)}. ${how}`;
  }
  return `warning: ${ref.dir} checkout ${short(ref.checkout)} is off the recorded pin ${short(ref.pin)}; results reflect the checkout, not the pin. ${how}`;
}
