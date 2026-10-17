// Opt-in compatibility/security gate for the pinned real CLI, with a local fake
// Responses API. No OpenAI/GitHub credentials or external API calls are used.
// TRIAGE_TEST_REAL_CODEX=1 node --test .github/scripts/issue-triage/codex-isolation.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { CODEX_VERSION, RESPONSE_SCHEMA, codexArgs, prepareClassifier, validateResponse } = require('./codex-runner.js');
const { RESPONSE } = require('./fixtures/cli-fixture.cjs');

test('real Codex: inherited instructions/tools are absent and hostile tool calls cannot execute or write', {
  skip: process.env.TRIAGE_TEST_REAL_CODEX !== '1', timeout: 30000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'prepared');
  prepareClassifier(bundle, {})('Return only the structured classification.');
  // An ancestor project config/hook/MCP and AGENTS.md must not bleed into the
  // deliberately empty working directory, even when the caller has them.
  const poisoned = path.join(root, '.codex');
  fs.mkdirSync(poisoned);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'INHERITED_INSTRUCTIONS_CANARY');
  fs.writeFileSync(path.join(poisoned, 'config.toml'), [
    'developer_instructions = "INHERITED_CONFIG_CANARY"',
    '[mcp_servers.injected]',
    'command = "touch"',
    `args = [${JSON.stringify(path.join(root, 'mcp-executed'))}]`,
  ].join('\n'));
  fs.writeFileSync(path.join(poisoned, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${root}/hook-executed` }] }] },
  }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      let item;
      if (requests.length === 1) {
        item = { id: 'call_1', call_id: 'tool_1', type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${root}/shell-executed` }) };
      } else if (requests.length === 2) {
        item = { id: 'call_2', call_id: 'tool_2', type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${root}/patch-written\n+unsafe\n*** End Patch\n` };
      } else {
        item = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(RESPONSE) }] };
      }
      const events = [
        { type: 'response.created', response: { id: `r_${requests.length}` } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `r_${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  // Match the Action's proxy config shape: local URL, no upstream key in Codex.
  const configPath = path.join(bundle, 'codex-home', 'config.toml');
  fs.writeFileSync(configPath, `model_provider = "test-proxy"\n${fs.readFileSync(configPath, 'utf8')}\n` +
    '[model_providers.test-proxy]\nname = "Test Proxy"\nwire_api = "responses"\n' +
    `base_url = "http://127.0.0.1:${server.address().port}/v1"\n`);
  const env = {
    PATH: process.env.PATH, HOME: path.join(bundle, 'home'),
    CODEX_HOME: path.join(bundle, 'codex-home'),
    XDG_CONFIG_HOME: path.join(bundle, 'home', '.config'),
  };
  assert.equal(execFileSync('codex', ['--version'], { env, encoding: 'utf8' }).trim(), `codex-cli ${CODEX_VERSION}`);
  const child = spawn('codex', [...codexArgs(bundle).slice(0, -1), '-c', 'features.enable_request_compression=false', '-'], {
    env, cwd: path.join(bundle, 'work'), stdio: ['pipe', 'pipe', 'pipe'], timeout: 25000, killSignal: 'SIGKILL',
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(fs.readFileSync(path.join(bundle, 'prompt.txt')));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(requests.length, 3, stderr);
  assert.deepEqual(requests[0].text.format.schema, RESPONSE_SCHEMA);
  const tools = requests[0].tools.map((tool) => tool.name || tool.type);
  assert.deepEqual(tools.sort(), ['apply_patch', 'request_user_input']);
  assert.ok(!JSON.stringify(requests).includes('INHERITED_INSTRUCTIONS_CANARY'));
  assert.ok(!JSON.stringify(requests).includes('INHERITED_CONFIG_CANARY'));
  const returned = requests.flatMap((r) => r.input).filter((i) => i.type.endsWith('_call_output'));
  assert.ok(returned.some((i) => String(i.output).includes('unsupported call: exec_command')));
  assert.ok(returned.some((i) => String(i.output).includes('writing is blocked by read-only sandbox')));
  for (const marker of ['shell-executed', 'patch-written', 'mcp-executed', 'hook-executed']) {
    assert.equal(fs.existsSync(path.join(root, marker)), false, marker);
  }
  validateResponse(fs.readFileSync(path.join(bundle, 'response.json'), 'utf8'));
});
