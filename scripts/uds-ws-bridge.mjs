#!/usr/bin/env node
// uds-ws-bridge: expose a running intentd's UDS JSON-RPC socket as an
// UNAUTHENTICATED plain ws:// endpoint on loopback (dev tool, source-only).
//
// - RFC 6455 WebSocket server built on node:http + node:crypto (zero npm deps).
// - One dedicated UDS connection per WebSocket client (1:1).
// - Translation: one complete WS text message <-> one newline-terminated
//   JSON-RPC line on the UDS socket. Binary frames are ignored.
//
// Config (env or flags): BRIDGE_PORT/--port (default 51337),
// BRIDGE_HOST/--host (default 127.0.0.1), INTENTD_SOCKET/--socket
// (default: platform intentd data dir, honoring INTENTD_DATA_DIR).
//
// Loopback-only is non-negotiable: non-loopback hosts are refused at startup
// unless --unsafe-allow-non-loopback / BRIDGE_UNSAFE_NON_LOOPBACK=1 is passed,
// and browser upgrades with a non-loopback Origin are rejected with 403.
//
// See intent-hq/monorepo#2526.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Matches the daemon's per-message transport limit.
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const NL = Buffer.from('\n');

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function defaultSocketPath(env = process.env, platform = process.platform) {
  if (env.INTENTD_SOCKET) return env.INTENTD_SOCKET;
  let dataDir;
  if (env.INTENTD_DATA_DIR) {
    dataDir = env.INTENTD_DATA_DIR;
  } else if (platform === 'darwin') {
    dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'intentd');
  } else {
    dataDir = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'intentd');
  }
  return path.join(dataDir, 'intentd.sock');
}

export function computeAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

export function isLoopbackHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// Browser pages are not stopped by loopback binding (they run on this
// machine), so upgrades carrying a non-loopback Origin are rejected;
// non-browser clients send no Origin header and are unaffected.
export function isAllowedOrigin(origin) {
  if (origin === undefined) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function encodeFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code, reason = '') {
  const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

function handleConnection(socket, head, socketPath) {
  let wsBuf = Buffer.alloc(0);
  let udsBuf = Buffer.alloc(0);
  let fragments = null; // { opcode, chunks, size } while reassembling
  let closeSent = false;
  let closed = false;

  const uds = net.connect(socketPath);

  const sendFrame = (opcode, payload, fin = true) => {
    if (!socket.destroyed && socket.writable) socket.write(encodeFrame(opcode, payload, fin));
  };

  const shutdown = (code, reason) => {
    if (closed) return;
    closed = true;
    if (!closeSent) {
      closeSent = true;
      sendFrame(OP_CLOSE, closePayload(code, reason));
    }
    socket.end();
    uds.destroy();
    // Hard-close if the peer never completes the closing handshake.
    setTimeout(() => socket.destroy(), 1000).unref();
  };

  uds.on('error', (err) => shutdown(1011, `intentd UDS error: ${err.code || err.message}`));
  uds.on('close', () => shutdown(1000, 'intentd UDS connection closed'));
  uds.on('data', (chunk) => {
    udsBuf = udsBuf.length ? Buffer.concat([udsBuf, chunk]) : chunk;
    let nl;
    while ((nl = udsBuf.indexOf(0x0a)) !== -1) {
      const line = udsBuf.subarray(0, nl);
      udsBuf = udsBuf.subarray(nl + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        shutdown(1009, 'message from daemon exceeds 40 MiB cap');
        return;
      }
      sendFrame(OP_TEXT, line);
    }
    if (udsBuf.length > MAX_MESSAGE_BYTES) shutdown(1009, 'message from daemon exceeds 40 MiB cap');
  });

  const deliver = (payload) => {
    if (!uds.destroyed) uds.write(Buffer.concat([payload, NL]));
  };

  const handleFrame = (fin, opcode, payload) => {
    switch (opcode) {
      case OP_PING:
        sendFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        if (!closeSent) {
          closeSent = true;
          sendFrame(OP_CLOSE, payload.subarray(0, 2));
        }
        closed = true;
        socket.end();
        uds.destroy();
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (fin) {
          if (opcode === OP_TEXT) deliver(payload);
          return;
        }
        fragments = { opcode, chunks: [payload], size: payload.length };
        return;
      case OP_CONT: {
        if (!fragments) return; // stray continuation — ignore
        fragments.chunks.push(payload);
        fragments.size += payload.length;
        if (fin) {
          const { opcode: op, chunks } = fragments;
          fragments = null;
          if (op === OP_TEXT) deliver(Buffer.concat(chunks));
        }
        return;
      }
      default:
        return; // unknown opcode — ignore
    }
  };

  const onData = (chunk) => {
    wsBuf = wsBuf.length ? Buffer.concat([wsBuf, chunk]) : chunk;
    while (!closed) {
      if (wsBuf.length < 2) break;
      const fin = (wsBuf[0] & 0x80) !== 0;
      const opcode = wsBuf[0] & 0x0f;
      const masked = (wsBuf[1] & 0x80) !== 0;
      let len = wsBuf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (wsBuf.length < 4) break;
        len = wsBuf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (wsBuf.length < 10) break;
        const big = wsBuf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          shutdown(1009, 'message exceeds 40 MiB cap');
          return;
        }
        len = Number(big);
        off = 10;
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY || opcode === OP_CONT) {
        const assembled = fragments ? fragments.size : 0;
        if (len > MAX_MESSAGE_BYTES || assembled + len > MAX_MESSAGE_BYTES) {
          shutdown(1009, 'message exceeds 40 MiB cap');
          return;
        }
      }
      const maskLen = masked ? 4 : 0;
      if (wsBuf.length < off + maskLen + len) break;
      let payload = wsBuf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = wsBuf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      wsBuf = wsBuf.subarray(off + maskLen + len);
      handleFrame(fin, opcode, payload);
    }
  };

  socket.on('data', onData);
  socket.on('error', () => {
    closed = true;
    uds.destroy();
    socket.destroy();
  });
  // HTTP-server upgrade sockets allow half-open: a client FIN emits 'end'
  // without 'close', so tear down both sides explicitly.
  socket.on('end', () => {
    closed = true;
    uds.destroy();
    socket.destroy();
  });
  socket.on('close', () => {
    closed = true;
    uds.destroy();
  });
  if (head && head.length) onData(head);
}

export function createBridge({ socketPath, host = '127.0.0.1', port = 51337 } = {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('This is a WebSocket endpoint; connect with a WebSocket client.\n');
  });
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = (req.headers.upgrade || '').toLowerCase();
    if (req.method !== 'GET' || upgrade !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, head, socketPath);
  });
  return {
    server,
    listen: (cb) => server.listen(port, host, cb),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const USAGE = `usage: node scripts/uds-ws-bridge.mjs [--port N] [--host H] [--socket PATH] [--unsafe-allow-non-loopback]

env: BRIDGE_PORT (default 51337), BRIDGE_HOST (default 127.0.0.1),
     INTENTD_SOCKET (default: platform intentd data dir, honors INTENTD_DATA_DIR),
     BRIDGE_UNSAFE_NON_LOOPBACK=1 (dangerous: allow a non-loopback host)`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eat = (name) => {
      if (arg === `--${name}`) return argv[++i];
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const port = eat('port');
    if (port !== undefined) {
      out.port = Number(port);
      continue;
    }
    const host = eat('host');
    if (host !== undefined) {
      out.host = host;
      continue;
    }
    const sock = eat('socket');
    if (sock !== undefined) {
      out.socketPath = sock;
      continue;
    }
    if (arg === '--unsafe-allow-non-loopback') {
      out.unsafeAllowNonLoopback = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    console.error(`unknown argument: ${arg}\n${USAGE}`);
    process.exit(2);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const port = args.port ?? Number(process.env.BRIDGE_PORT || 51337);
  const host = args.host ?? process.env.BRIDGE_HOST ?? '127.0.0.1';
  const socketPath = args.socketPath ?? defaultSocketPath();
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[uds-ws-bridge] error: invalid port ${port}`);
    process.exit(2);
  }
  const allowNonLoopback =
    args.unsafeAllowNonLoopback || process.env.BRIDGE_UNSAFE_NON_LOOPBACK === '1';
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    console.error(`[uds-ws-bridge] error: refusing to bind non-loopback host ${host}`);
    console.error('[uds-ws-bridge] this endpoint is the FULL UNAUTHENTICATED daemon API; loopback-only is non-negotiable.');
    console.error('[uds-ws-bridge] if you really must, pass --unsafe-allow-non-loopback or BRIDGE_UNSAFE_NON_LOOPBACK=1.');
    process.exit(2);
  }
  let socketStat;
  try {
    socketStat = fs.statSync(socketPath);
  } catch {
    console.error(`[uds-ws-bridge] error: intentd UDS socket not found at ${socketPath}`);
    console.error('[uds-ws-bridge] is intentd running? Override with INTENTD_SOCKET or --socket.');
    process.exit(1);
  }
  if (!socketStat.isSocket()) {
    console.error(`[uds-ws-bridge] error: intentd UDS path is not a Unix domain socket: ${socketPath}`);
    console.error('[uds-ws-bridge] start intentd or point INTENTD_SOCKET/--socket at its socket.');
    process.exit(1);
  }
  const bridge = createBridge({ socketPath, host, port });
  bridge.listen(() => {
    const addr = bridge.server.address();
    console.log(`[uds-ws-bridge] listening on ws://${addr.address}:${addr.port}/ws`);
    console.log(`[uds-ws-bridge] proxying to UDS socket ${socketPath} (one UDS connection per WS client)`);
    console.warn('[uds-ws-bridge] *****************************************************************');
    console.warn('[uds-ws-bridge] * WARNING: this endpoint exposes the FULL intentd daemon API   *');
    console.warn('[uds-ws-bridge] * with NO AUTHENTICATION. Anything that can reach this port    *');
    console.warn('[uds-ws-bridge] * fully controls the daemon. Loopback-only; dev use only.      *');
    console.warn('[uds-ws-bridge] *****************************************************************');
    if (!isLoopbackHost(host)) {
      console.warn('[uds-ws-bridge] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.warn(`[uds-ws-bridge] !!! DANGER: --unsafe-allow-non-loopback bound ${host} — the`);
      console.warn('[uds-ws-bridge] !!! FULL UNAUTHENTICATED daemon API is reachable from the');
      console.warn('[uds-ws-bridge] !!! network. Anyone who can reach this port owns the daemon.');
      console.warn('[uds-ws-bridge] !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    }
  });
  const stop = (sig) => {
    console.log(`[uds-ws-bridge] ${sig} received, shutting down`);
    bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
