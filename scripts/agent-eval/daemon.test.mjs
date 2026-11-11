import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PROVIDERS, configLeaks } from './lib/daemon.mjs';

const dirWith = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-config-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

test('a signed-in Claude dir with no user config passes', () => {
  const dir = dirWith({ '.claude.json': JSON.stringify({ userID: 'x', mcpServers: {} }), '.credentials.json': '{}' });
  assert.deepEqual(configLeaks(dir, PROVIDERS['claude-code']), []);
});

test('user MCP servers, hooks and project-scoped servers in Claude config are leaks', () => {
  const dir = dirWith({
    '.claude.json': JSON.stringify({ projects: { '/repo': { mcpServers: { mail: { command: 'x' } } } } }),
    'settings.local.json': JSON.stringify({ hooks: { Stop: [] , PreToolUse: [{}] } }),
  });
  assert.deepEqual(configLeaks(dir, PROVIDERS['claude-code']).sort(), ['.claude.json:mcpServers', 'settings.local.json:hooks']);
});

test('Codex mcp_servers tables in config.toml are leaks, other tables are not', () => {
  assert.deepEqual(configLeaks(dirWith({ 'config.toml': 'model = "x"\n[mcp_servers.mail]\ncommand = "x"\n' }), PROVIDERS.codex), ['config.toml:[mcp_servers]']);
  assert.deepEqual(configLeaks(dirWith({ 'config.toml': 'model = "x"\n[profiles.fast]\nmodel = "y"\n' }), PROVIDERS.codex), []);
});
