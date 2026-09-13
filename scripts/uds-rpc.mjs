#!/usr/bin/env node
// uds-rpc: one-shot JSON-RPC probe for a running intentd's UDS socket
// (dev tool, source-only, zero npm deps).
//
// Sends one newline-terminated JSON-RPC 2.0 request on the UDS socket and
// prints each received frame as-is, one JSON line per stdout line. Default
// mode exits once the frame whose id matches the request arrives (nonzero if
// it is a JSON-RPC error); --subscribe keeps the connection open, printing
// every frame, until --max-frames or --timeout.
//
// Config (env or flags): INTENTD_SOCKET/--socket (default: platform intentd
// data dir, honoring INTENTD_DATA_DIR).

import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { MAX_MESSAGE_BYTES, defaultSocketPath } from './uds-ws-bridge.mjs';

export const USAGE = `usage: node scripts/uds-rpc.mjs <method> [json-params] [--subscribe] [--max-frames N] [--timeout MS] [--socket PATH]

  <method>        JSON-RPC method name (e.g. workspace.list)
  [json-params]   optional params as a JSON object or array
  --subscribe     keep the connection open, printing every frame, until
                  --max-frames frames printed or --timeout elapses (exit 0)
  --max-frames N  stop after printing N frames (requires --subscribe)
  --timeout MS    overall timeout in ms (default 30000); an error in default
                  mode, a normal exit with --subscribe

env: INTENTD_SOCKET (default: platform intentd data dir, honors INTENTD_DATA_DIR)`;

export function parseArgs(argv) {
  const out = { timeout: 30000 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eat = (name) => {
      if (arg === `--${name}`) {
        if (i + 1 >= argv.length) throw new Error(`missing value for --${name}`);
        return argv[++i];
      }
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const maxFrames = eat('max-frames');
    if (maxFrames !== undefined) {
      out.maxFrames = Number(maxFrames);
      continue;
    }
    const timeout = eat('timeout');
    if (timeout !== undefined) {
      out.timeout = Number(timeout);
      continue;
    }
    const sock = eat('socket');
    if (sock !== undefined) {
      out.socketPath = sock;
      continue;
    }
    if (arg === '--subscribe') {
      out.subscribe = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    positional.push(arg);
  }
  if (out.help) return out;
  if (positional.length === 0) throw new Error('missing required <method> argument');
  if (positional.length > 2) throw new Error(`unexpected argument: ${positional[2]}`);
  out.method = positional[0];
  if (positional[1] !== undefined) {
    try {
      out.params = JSON.parse(positional[1]);
    } catch {
      throw new Error(`invalid JSON params: ${positional[1]}`);
    }
    if (out.params === null || typeof out.params !== 'object') {
      throw new Error('json-params must be a JSON object or array');
    }
  }
  if (out.maxFrames !== undefined && (!Number.isInteger(out.maxFrames) || out.maxFrames < 1)) {
    throw new Error(`invalid --max-frames: ${out.maxFrames}`);
  }
  if (out.maxFrames !== undefined && !out.subscribe) {
    throw new Error('--max-frames requires --subscribe');
  }
  if (!Number.isInteger(out.timeout) || out.timeout < 1) {
    throw new Error(`invalid --timeout: ${out.timeout}`);
  }
  return out;
}

// Resolves to the process exit code; never rejects.
export function runProbe({
  method,
  params,
  subscribe = false,
  maxFrames,
  timeout = 30000,
  socketPath,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  return new Promise((resolve) => {
    const id = 1;
    const request = { jsonrpc: '2.0', id, method };
    if (params !== undefined) request.params = params;
    const uds = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    let frames = 0;
    let settled = false;
    const finish = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message) stderr.write(`[uds-rpc] ${message}\n`);
      uds.destroy();
      resolve(code);
    };
    const timer = setTimeout(() => {
      if (subscribe) finish(0);
      else finish(1, `error: timed out after ${timeout} ms waiting for response id ${id}`);
    }, timeout);
    uds.on('connect', () => uds.write(JSON.stringify(request) + '\n'));
    uds.on('error', (err) => finish(1, `error: intentd UDS error: ${err.code || err.message}`));
    uds.on('close', () => finish(1, 'error: connection closed by daemon'));
    uds.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let nl;
      while (!settled && (nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (line.length > MAX_MESSAGE_BYTES) {
          finish(1, 'error: frame from daemon exceeds 40 MiB cap');
          return;
        }
        stdout.write(line.toString('utf8') + '\n');
        frames++;
        if (subscribe) {
          if (maxFrames !== undefined && frames >= maxFrames) finish(0);
          continue;
        }
        let frame;
        try {
          frame = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        if (frame && typeof frame === 'object' && frame.id === id) {
          finish('error' in frame ? 1 : 0);
        }
      }
      if (!settled && buf.length > MAX_MESSAGE_BYTES) {
        finish(1, 'error: frame from daemon exceeds 40 MiB cap');
      }
    });
  });
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[uds-rpc] error: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const socketPath = args.socketPath ?? defaultSocketPath();
  let socketStat;
  try {
    socketStat = fs.statSync(socketPath);
  } catch {
    console.error(`[uds-rpc] error: intentd UDS socket not found at ${socketPath}`);
    console.error('[uds-rpc] is intentd running? Override with INTENTD_SOCKET or --socket.');
    process.exit(1);
  }
  if (!socketStat.isSocket()) {
    console.error(`[uds-rpc] error: intentd UDS path is not a Unix domain socket: ${socketPath}`);
    console.error('[uds-rpc] start intentd or point INTENTD_SOCKET/--socket at its socket.');
    process.exit(1);
  }
  // Set exitCode instead of calling process.exit() so stdout drains fully
  // before the process ends (large frames can otherwise be truncated on pipes).
  runProbe({ ...args, socketPath }).then((code) => {
    process.exitCode = code;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
