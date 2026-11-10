// Isolated intentd for one eval arm: its own HOME, data and workspaces dirs,
// UDS only, eval harness stamp, and only the provider config dir it is given.

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { connect } from './rpc.mjs';

export const EVAL_CACHE = process.env.AGENT_EVAL_CACHE || path.join(os.homedir(), '.cache', 'intent-agent-eval');

/** Provider-specific isolation: the dedicated config dir and how to check its sign-in. */
export const PROVIDERS = {
  'claude-code': {
    configEnv: 'CLAUDE_CONFIG_DIR',
    cli: 'claude',
    login: (dir) => `CLAUDE_CONFIG_DIR=${dir} claude auth login`,
    signedIn: (env) => {
      const out = run('claude', ['auth', 'status'], env);
      if (out === null) return false;
      try {
        return JSON.parse(out).loggedIn === true;
      } catch {
        return !/not logged in|logged out/i.test(out);
      }
    },
    forbidden: ['CLAUDE.md', 'skills', 'plugins', 'agents', 'commands', 'hooks'],
    // Claude Code re-syncs the signed-in claude.ai account's skills and plugins
    // into skills/synced and plugins/synced on a timer during a run. An empty
    // file in their place makes its mkdir fail (the CLI runs on); a sync that
    // deletes the file first is still caught by the after-task-run check.
    blockers: ['skills', 'plugins'],
    credentials: ['.credentials.json'],
    accountKeys: { '.claude.json': ['oauthAccount', 'userID', 'hasCompletedOnboarding', 'lastOnboardingVersion'] },
    jsonKeys: {
      'settings.json': ['hooks', 'mcpServers', 'enabledPlugins'],
      'settings.local.json': ['hooks', 'mcpServers', 'enabledPlugins'],
      '.claude.json': ['mcpServers'],
    },
  },
  codex: {
    configEnv: 'CODEX_HOME',
    cli: 'codex',
    login: (dir) => `CODEX_HOME=${dir} codex login`,
    signedIn: (env) => {
      const out = run('codex', ['login', 'status'], env, true);
      return out !== null && /logged in/i.test(out) && !/not logged in/i.test(out);
    },
    forbidden: ['AGENTS.md', 'skills', 'prompts'],
    blockers: ['skills'],
    credentials: ['auth.json'],
    jsonKeys: {},
    tomlTables: { 'config.toml': ['mcp_servers'] },
  },
  // The scripted smoke agent gets a config dir too, so the isolation checks run
  // in CI; its "sync" control writes skills the way Claude Code does.
  mock: {
    configEnv: 'EVAL_MOCK_CONFIG_DIR',
    signedIn: () => true,
    forbidden: ['skills', 'plugins'],
    blockers: ['skills', 'plugins'],
    credentials: [],
    jsonKeys: {},
  },
};

function run(cmd, args, env, mergeStderr = false) {
  try {
    const out = execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', mergeStderr ? 'pipe' : 'ignore'], timeout: 30_000 });
    return out;
  } catch (error) {
    if (mergeStderr && (error.stdout || error.stderr)) return `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return null;
  }
}

function realHome() {
  return os.userInfo().homedir;
}

/**
 * Build the run's provider config: a fresh dir under `runRoot` holding only the
 * sign-in copied from the dedicated eval dir (never the developer's own), with
 * the skill/plugin sync roots blocked. Returns the env the daemon passes to the
 * provider, the fresh `dir`, the `sourceDir` the sign-in came from, and the
 * `baseline` credential bytes for syncBackCredentials. On error the caller
 * removes `runRoot` (it holds the copied credentials).
 */
export function preflightProvider(provider, configDir, runRoot) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unsupported PROVIDER=${provider} (supported: ${Object.keys(PROVIDERS).join(', ')})`);
  if (!spec.configEnv) return { env: {}, dir: null, sourceDir: null, baseline: {} };
  const sourceDir = provider === 'mock' ? null : path.resolve(configDir || path.join(EVAL_CACHE, provider));
  const own = [path.join(realHome(), '.claude'), path.join(realHome(), '.codex')];
  if (own.includes(sourceDir)) throw new Error(`${sourceDir} is your own ${provider} config; use a dedicated eval dir`);
  if (sourceDir) fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  const dir = path.join(runRoot, `config-${provider}`);
  isolatedConfig(spec, sourceDir, dir);
  const baseline = credentialBaseline(spec, dir);
  const leaks = isolationLeaks(dir, spec);
  if (leaks.length) throw new Error(`fresh config ${dir} is not clean: ${leaks.join(', ')}`);
  const env = { ...isolatedBaseEnv(fs.mkdtempSync(path.join(runRoot, 'preflight-home-'))), [spec.configEnv]: dir };
  if (!spec.signedIn(env)) {
    const hint = process.platform === 'darwin' && provider === 'claude-code' ? '\n(macOS keeps Claude Code sign-ins in the Keychain, not in a file the eval can copy; run the eval on Linux.)' : '';
    const err = new Error(`${provider} is not signed in for the eval. Run once, interactively:\n  ${spec.login(sourceDir)}${hint}`);
    err.exitCode = 2;
    throw err;
  }
  return { env: { [spec.configEnv]: dir }, dir, sourceDir, baseline };
}

/** The credential bytes as copied, keyed by file name. */
export function credentialBaseline(spec, dir) {
  const out = {};
  for (const file of spec.credentials ?? []) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) out[file] = fs.readFileSync(p);
  }
  return out;
}

/** Copy only the sign-in from `sourceDir` into a new `dir` and block the sync roots. */
export function isolatedConfig(spec, sourceDir, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of spec.credentials ?? []) {
    const from = sourceDir && path.join(sourceDir, file);
    if (from && fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, file));
  }
  for (const [file, keys] of Object.entries(spec.accountKeys ?? {})) {
    const from = sourceDir && path.join(sourceDir, file);
    if (!from || !fs.existsSync(from)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(from, 'utf8'));
    } catch {
      continue;
    }
    const kept = Object.fromEntries(keys.filter((k) => k in json).map((k) => [k, json[k]]));
    fs.writeFileSync(path.join(dir, file), JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 });
  }
  blockSyncRoots(spec, dir);
  return dir;
}

/** An empty read-only file where a sync would create a directory. */
export function blockSyncRoots(spec, dir) {
  for (const name of spec.blockers ?? []) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) continue;
    fs.writeFileSync(p, '');
    fs.chmodSync(p, 0o444);
  }
}

const isBlocker = (spec, dir, name) => {
  if (!(spec.blockers ?? []).includes(name)) return false;
  const st = fs.lstatSync(path.join(dir, name));
  return st.isFile() && st.size === 0;
};

/** Entries under `dir/name`, a few levels deep, for the leak report. */
function listEntries(root, rel, depth = 2, out = []) {
  const full = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(full);
  } catch {
    return out;
  }
  if (!st.isDirectory() || depth === 0) {
    out.push(rel);
    return out;
  }
  const kids = fs.readdirSync(full);
  if (!kids.length) out.push(`${rel}/`);
  for (const k of kids) listEntries(root, path.join(rel, k), depth - 1, out);
  return out;
}

/**
 * Everything in a provider config dir that can change what the agent sees:
 * skills, plugins, instructions, hooks (anything in `forbidden` that is not
 * our blocker file) and MCP servers/hooks/plugins in its config files.
 */
export function isolationLeaks(dir, spec) {
  const leaks = [];
  for (const name of spec.forbidden ?? []) {
    if (!fs.existsSync(path.join(dir, name)) || isBlocker(spec, dir, name)) continue;
    const entries = listEntries(dir, name);
    leaks.push(...entries.slice(0, 5), ...(entries.length > 5 ? [`${name}: ${entries.length - 5} more`] : []));
  }
  leaks.push(...configLeaks(dir, spec));
  return leaks;
}

/**
 * Move leaked entries out of the run's config dir (into `quarantine`) and
 * restore the blockers, so later task-runs start clean again.
 */
export function quarantineLeaks(dir, spec, quarantine) {
  for (const name of spec.forbidden ?? []) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p) || isBlocker(spec, dir, name)) continue;
    fs.mkdirSync(quarantine, { recursive: true });
    fs.renameSync(p, path.join(quarantine, name));
  }
  blockSyncRoots(spec, dir);
}

/**
 * The provider may refresh its OAuth token in the run's copy, which revokes the
 * old refresh token; write the new one back so the dedicated dir stays signed
 * in. Only when the copy changed since `baseline`, parses as JSON (never a
 * half-written file), and the dedicated dir still holds the baseline bytes (a
 * concurrent eval or a fresh login wrote a newer sign-in: keep that one).
 * Updates `baseline`; returns { copied, conflicts }.
 */
export function syncBackCredentials(spec, dir, sourceDir, baseline) {
  const copied = [];
  const conflicts = [];
  if (!sourceDir || !dir) return { copied, conflicts };
  for (const file of spec.credentials ?? []) {
    const from = path.join(dir, file);
    const to = path.join(sourceDir, file);
    if (!fs.existsSync(from)) continue;
    const next = fs.readFileSync(from);
    const base = baseline[file];
    if (base && next.equals(base)) continue;
    try {
      JSON.parse(next.toString('utf8'));
    } catch {
      continue;
    }
    const current = fs.existsSync(to) ? fs.readFileSync(to) : null;
    if (current && !current.equals(base ?? Buffer.alloc(0)) && !current.equals(next)) {
      conflicts.push(file);
      continue;
    }
    if (!current?.equals(next)) {
      const tmp = `${to}.agent-eval-${process.pid}`;
      fs.writeFileSync(tmp, next, { mode: 0o600 });
      fs.renameSync(tmp, to);
      copied.push(file);
    }
    baseline[file] = next;
  }
  return { copied, conflicts };
}

/** Non-empty MCP servers, hooks or plugins in the provider's own config files. */
export function configLeaks(dir, spec) {
  const leaks = [];
  for (const [file, keys] of Object.entries(spec.jsonKeys ?? {})) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      leaks.push(`${file} (unreadable)`);
      continue;
    }
    const scopes = [json, ...Object.values(json.projects ?? {})];
    for (const k of keys) if (scopes.some((o) => o?.[k] && Object.keys(o[k]).length)) leaks.push(`${file}:${k}`);
  }
  for (const [file, tables] of Object.entries(spec.tomlTables ?? {})) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const t of tables) if (new RegExp(`^\\s*\\[\\s*${t}\\b|^\\s*${t}\\s*=|^\\s*${t}\\.`, 'm').test(text)) leaks.push(`${file}:[${t}]`);
  }
  return leaks;
}

export function isolatedBaseEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'dumb',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    npm_config_cache: path.join(EVAL_CACHE, 'npm'),
    npm_config_update_notifier: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function versions(provider, bin, providerEnv) {
  const spec = PROVIDERS[provider];
  const binary = fs.readFileSync(bin, { encoding: 'latin1' });
  const adapter = binary.match(/@agentclientprotocol\/(?:claude-agent-acp|codex-acp)@\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)[.\d]*)?/g) ?? [];
  const pick = provider === 'codex' ? /codex-acp/ : /claude-agent-acp/;
  const env = { ...isolatedBaseEnv(os.tmpdir()), ...providerEnv };
  return {
    intentd: run(bin, ['--version'], env)?.trim() ?? null,
    intentdSha256: crypto.createHash('sha256').update(binary, 'latin1').digest('hex').slice(0, 16),
    evalOverride: binary.includes('INTENTD_EVAL_HARNESS_VERSION'),
    cli: spec?.cli ? run(spec.cli, ['--version'], env)?.trim() ?? null : null,
    adapter: provider === 'mock' ? 'agent-eval-mock' : adapter.find((a) => pick.test(a)) ?? null,
    node: process.version,
  };
}

function socketAccepts(socketPath) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/**
 * Start intentd for one arm. `harness` = a version string, or "current" for
 * no override. Never passes --insecure: UDS only.
 */
export async function startDaemon({ bin, root, harness, providerEnv = {}, extraEnv = {} }) {
  const dirs = Object.fromEntries(['home', 'data', 'workspaces', 'specialists'].map((d) => [d, path.join(root, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.home, '.gitconfig'), '[user]\n\tname = Agent Eval\n\temail = agent-eval@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const env = {
    ...isolatedBaseEnv(dirs.home),
    INTENTD_DATA_DIR: dirs.data,
    INTENTD_WORKSPACES_DIR: dirs.workspaces,
    INTENTD_USER_SPECIALISTS_DIR: dirs.specialists,
    INTENTD_ASSERT_HERMETIC_ROOT: '1',
    INTENTD_LEGACY_IMPORT_ROOTS: '',
    INTENTD_AGENT_EVAL: '1',
    ...(harness && harness !== 'current' ? { INTENTD_EVAL_HARNESS_VERSION: harness } : {}),
    ...providerEnv,
    ...extraEnv,
  };
  const log = fs.openSync(path.join(root, 'intentd.log'), 'a');
  const child = spawn(bin, ['serve'], { env, stdio: ['ignore', log, log], detached: false });
  const socketPath = path.join(dirs.data, 'intentd.sock');
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const kill = async () => {
    if (exited) return;
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await done;
    clearTimeout(timer);
  };
  try {
    const deadline = Date.now() + 120_000;
    while (!(await socketAccepts(socketPath))) {
      if (exited) throw new Error(`intentd exited during startup (${JSON.stringify(exited)}); see ${root}/intentd.log`);
      if (Date.now() > deadline) throw new Error(`intentd did not open ${socketPath} within 120 s`);
      await new Promise((r) => setTimeout(r, 200));
    }
    // A connection opened before ready is not handed over to the full router, so
    // each poll uses a fresh one.
    for (;;) {
      const rpc = await connect(socketPath, { timeoutMs: 5000 });
      const status = await rpc.call('system.startupStatus').catch(() => ({ phase: 'preparing' }));
      rpc.close();
      if (status.phase === 'ready') break;
      if (status.phase === 'failed') throw new Error(`intentd startup failed; see ${root}/intentd.log`);
      if (exited) throw new Error(`intentd exited during startup (${JSON.stringify(exited)}); see ${root}/intentd.log`);
      if (Date.now() > deadline) throw new Error(`intentd was not ready within 120 s (phase ${status.phase})`);
      await new Promise((r) => setTimeout(r, Math.min(status.retryAfterMs ?? 500, 1000)));
    }
  } catch (error) {
    await kill();
    throw error;
  }
  return {
    socketPath,
    dirs,
    stop: kill,
  };
}
