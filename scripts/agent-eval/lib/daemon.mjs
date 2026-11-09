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
    jsonKeys: {},
    tomlTables: { 'config.toml': ['mcp_servers'] },
  },
  mock: { configEnv: null },
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
 * Check the dedicated provider dir: never the developer's own, signed in, and
 * free of user MCP servers, skills, hooks and instructions. Returns the env the
 * daemon passes to the provider.
 */
export function preflightProvider(provider, configDir) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unsupported PROVIDER=${provider} (supported: ${Object.keys(PROVIDERS).join(', ')})`);
  if (!spec.configEnv) return { env: {}, dir: null };
  const dir = path.resolve(configDir || path.join(EVAL_CACHE, provider));
  const own = [path.join(realHome(), '.claude'), path.join(realHome(), '.codex')];
  if (own.includes(dir)) throw new Error(`${dir} is your own ${provider} config; use a dedicated eval dir`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const leaks = spec.forbidden.filter((name) => fs.existsSync(path.join(dir, name)));
  leaks.push(...configLeaks(dir, spec));
  if (leaks.length) throw new Error(`${dir} must hold only the sign-in; remove: ${leaks.join(', ')}`);
  const env = { ...isolatedBaseEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-home-'))), [spec.configEnv]: dir };
  if (!spec.signedIn(env)) {
    const err = new Error(`${provider} is not signed in for the eval. Run once, interactively:\n  ${spec.login(dir)}`);
    err.exitCode = 2;
    throw err;
  }
  return { env: { [spec.configEnv]: dir }, dir };
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
  const adapter = binary.match(/@agentclientprotocol\/(?:claude-agent-acp|codex-acp)@[0-9][\w.-]*/g) ?? [];
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
