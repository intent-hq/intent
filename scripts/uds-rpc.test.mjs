// Tests for scripts/uds-rpc.mjs — node:test only, no live daemon.
// Run: node --test scripts/uds-rpc.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, runProbe, USAGE } from './uds-rpc.mjs';

const RPC_PATH = fileURLToPath(new URL('./uds-rpc.mjs', import.meta.url));

function tmpSockPath() {
  return path.join(os.tmpdir(), `udsrpc-${crypto.randomBytes(6).toString('hex')}.sock`);
}

async function startUds(onConnection) {
  const socketPath = tmpSockPath();
  const conns = new Set();
  const server = net.createServer((c) => {
    conns.add(c);
    c.on('close', () => conns.delete(c));
    c.on('error', () => {});
    onConnection(c);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: () => {
      for (const c of conns) c.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function sink() {
  const chunks = [];
  return {
    write: (s) => chunks.push(String(s)),
    get text() {
      return chunks.join('');
    },
  };
}

// --- parseArgs ---

test('parseArgs: method only, defaults applied', () => {
  const args = parseArgs(['workspace.list']);
  assert.equal(args.method, 'workspace.list');
  assert.equal(args.params, undefined);
  assert.equal(args.timeout, 30000);
  assert.equal(args.subscribe, undefined);
});

test('parseArgs: JSON params object and array are accepted', () => {
  assert.deepEqual(parseArgs(['m', '{"a":1}']).params, { a: 1 });
  assert.deepEqual(parseArgs(['m', '[1,2]']).params, [1, 2]);
});

test('parseArgs: flags accept both "--flag v" and "--flag=v"', () => {
  const spaced = parseArgs(['m', '--subscribe', '--max-frames', '3', '--timeout', '500', '--socket', '/tmp/x.sock']);
  assert.equal(spaced.maxFrames, 3);
  assert.equal(spaced.timeout, 500);
  assert.equal(spaced.socketPath, '/tmp/x.sock');
  const eq = parseArgs(['m', '--subscribe', '--max-frames=3', '--timeout=500', '--socket=/tmp/x.sock']);
  assert.deepEqual(eq, spaced);
});

test('parseArgs: --subscribe and --help flags', () => {
  assert.equal(parseArgs(['m', '--subscribe']).subscribe, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: bad inputs are rejected', () => {
  assert.throws(() => parseArgs([]), /missing required <method>/);
  assert.throws(() => parseArgs(['m', 'not-json']), /invalid JSON params/);
  assert.throws(() => parseArgs(['m', '"str"']), /must be a JSON object or array/);
  assert.throws(() => parseArgs(['m', '{}', 'extra']), /unexpected argument/);
  assert.throws(() => parseArgs(['m', '--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['m', '--subscribe', '--max-frames', '0']), /invalid --max-frames/);
  assert.throws(() => parseArgs(['m', '--timeout', 'abc']), /invalid --timeout/);
});

test('parseArgs: a flag without a value reports the missing value, not unknown argument', () => {
  assert.throws(() => parseArgs(['m', '--max-frames']), /missing value for --max-frames/);
  assert.throws(() => parseArgs(['m', '--timeout']), /missing value for --timeout/);
  assert.throws(() => parseArgs(['m', '--socket']), /missing value for --socket/);
});

test('parseArgs: --max-frames without --subscribe is rejected', () => {
  assert.throws(() => parseArgs(['m', '--max-frames', '3']), /--max-frames requires --subscribe/);
});

// --- runProbe against a fake UDS server ---

test('one-shot round-trip: correct framed request, prints response, exit 0', async (t) => {
  let received = '';
  const uds = await startUds((c) => {
    c.on('data', (d) => {
      received += d;
      if (received.endsWith('\n')) {
        const req = JSON.parse(received);
        c.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\n');
      }
    });
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({
    method: 'workspace.list',
    params: { a: 1 },
    socketPath: uds.socketPath,
    stdout,
    stderr: sink(),
  });
  assert.equal(code, 0);
  assert.equal(received, '{"jsonrpc":"2.0","id":1,"method":"workspace.list","params":{"a":1}}\n');
  assert.deepEqual(JSON.parse(stdout.text), { jsonrpc: '2.0', id: 1, result: { ok: true } });
});

test('response split across multiple socket writes is reassembled', async (t) => {
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, pad: 'x'.repeat(64) } }) + '\n';
  let sent = false;
  const uds = await startUds((c) => {
    c.on('data', () => {
      if (sent) return;
      sent = true;
      c.write(frame.slice(0, 10));
      setTimeout(() => c.write(frame.slice(10, 25)), 10);
      setTimeout(() => c.write(frame.slice(25)), 20);
    });
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({ method: 'x', socketPath: uds.socketPath, stdout, stderr: sink() });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.text), JSON.parse(frame));
});

test('default mode: non-matching frames are printed but only the matching id ends the run', async (t) => {
  const uds = await startUds((c) => {
    c.on('data', () => {
      c.write(JSON.stringify({ jsonrpc: '2.0', method: 'event.note', params: { n: 1 } }) + '\n');
      c.write(JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'other' }) + '\n');
      c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');
    });
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({ method: 'x', socketPath: uds.socketPath, stdout, stderr: sink() });
  assert.equal(code, 0);
  const lines = stdout.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].method, 'event.note');
  assert.equal(lines[1].id, 99);
  assert.deepEqual(lines[2], { jsonrpc: '2.0', id: 1, result: { ok: true } });
});

test('JSON-RPC error response yields nonzero exit', async (t) => {
  const uds = await startUds((c) => {
    c.on('data', () => {
      c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }) + '\n');
    });
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({ method: 'x', socketPath: uds.socketPath, stdout, stderr: sink() });
  assert.equal(code, 1);
  assert.match(stdout.text, /-32601/);
});

test('--subscribe --max-frames N prints N frames then exits 0', async (t) => {
  const uds = await startUds((c) => {
    c.on('data', () => {
      for (let i = 1; i <= 5; i++) c.write(JSON.stringify({ method: 'event', seq: i }) + '\n');
    });
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({
    method: 'x',
    subscribe: true,
    maxFrames: 3,
    socketPath: uds.socketPath,
    stdout,
    stderr: sink(),
  });
  assert.equal(code, 0);
  const lines = stdout.text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [1, 2, 3]);
});

test('--timeout in default mode fails with an error', async (t) => {
  const uds = await startUds(() => {}); // accepts but never responds
  t.after(() => uds.close());
  const stderr = sink();
  const code = await runProbe({
    method: 'x',
    timeout: 100,
    socketPath: uds.socketPath,
    stdout: sink(),
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text, /timed out after 100 ms/);
});

test('--timeout with --subscribe is a normal exit 0', async (t) => {
  const uds = await startUds((c) => {
    c.on('data', () => c.write('{"method":"event"}\n'));
  });
  t.after(() => uds.close());
  const stdout = sink();
  const code = await runProbe({
    method: 'x',
    subscribe: true,
    timeout: 100,
    socketPath: uds.socketPath,
    stdout,
    stderr: sink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text, /"event"/);
});

test('connection refused at the socket path exits nonzero', async () => {
  const stderr = sink();
  const code = await runProbe({
    method: 'x',
    socketPath: tmpSockPath(),
    stdout: sink(),
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text, /intentd UDS error/);
});

// --- CLI entry point ---

async function runCli(args) {
  const child = spawn(process.execPath, [RPC_PATH, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('CLI: missing socket path exits 1 with a clear message', async () => {
  const { code, stderr } = await runCli(['workspace.list', '--socket', tmpSockPath()]);
  assert.equal(code, 1);
  assert.match(stderr, /UDS socket not found/);
});

test('CLI: existing non-socket path exits 1', async () => {
  const { code, stderr } = await runCli(['workspace.list', '--socket', process.execPath]);
  assert.equal(code, 1);
  assert.match(stderr, /not a Unix domain socket/);
});

test('CLI: bad arguments exit 2 with usage', async () => {
  const { code, stderr } = await runCli(['workspace.list', 'not-json']);
  assert.equal(code, 2);
  assert.match(stderr, /invalid JSON params/);
  assert.match(stderr, /usage: node scripts\/uds-rpc\.mjs/);
});

test('CLI: --help prints usage and exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), USAGE.trim());
});
