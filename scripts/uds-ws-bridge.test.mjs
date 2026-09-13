// Tests for scripts/uds-ws-bridge.mjs — node:test only, no live daemon.
// Run: node --test scripts/uds-ws-bridge.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBridge, MAX_MESSAGE_BYTES } from './uds-ws-bridge.mjs';

const BRIDGE_PATH = fileURLToPath(new URL('./uds-ws-bridge.mjs', import.meta.url));

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Independent client-side frame codec (deliberately not reusing the bridge's
// encoder, so encode/decode bugs cannot cancel out).
function clientFrame(opcode, payload, fin = true) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  let header;
  const len = data.length;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  assert.equal(buf[1] & 0x80, 0, 'server frames must be unmasked');
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (buf.length < off + len) return null;
  return { fin, opcode, payload: buf.subarray(off, off + len), total: off + len };
}

class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let frame;
    while ((frame = parseServerFrame(this.buf)) !== null) {
      this.buf = this.buf.subarray(frame.total);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    }
  }

  next() {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function wsConnect(port, urlPath = '/ws', extraHeaders = '') {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  await once(sock, 'connect');
  sock.write(
    `GET ${urlPath} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      extraHeaders +
      '\r\n',
  );
  let head = Buffer.alloc(0);
  while (head.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(sock, 'data');
    head = Buffer.concat([head, chunk]);
  }
  const idx = head.indexOf('\r\n\r\n');
  const headerText = head.subarray(0, idx).toString();
  const reader = new FrameReader();
  const rest = head.subarray(idx + 4);
  sock.on('data', (chunk) => reader.feed(chunk));
  if (rest.length) reader.feed(rest);
  return { sock, key, headerText, reader };
}

function tmpSockPath() {
  return path.join(os.tmpdir(), `udsws-${crypto.randomBytes(6).toString('hex')}.sock`);
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
    conns,
    close: () => {
      for (const c of conns) c.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function setup(t, onConnection = (c) => c.pipe(c)) {
  const uds = await startUds(onConnection);
  const bridge = createBridge({ socketPath: uds.socketPath, host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => bridge.listen(resolve));
  t.after(async () => {
    await bridge.close();
    await uds.close();
  });
  return { uds, port: bridge.server.address().port };
}

test('handshake returns the correct Sec-WebSocket-Accept', async (t) => {
  const { port } = await setup(t);
  const { sock, key, headerText } = await wsConnect(port);
  assert.match(headerText, /^HTTP\/1\.1 101 /);
  const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  assert.ok(headerText.includes(`Sec-WebSocket-Accept: ${expected}`));
  sock.destroy();
});

test('non-upgrade HTTP request is rejected with 400', async (t) => {
  const { port } = await setup(t);
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/ws', agent: false }, resolve).on('error', reject);
  });
  assert.equal(res.statusCode, 400);
  res.resume();
  await once(res, 'end');
});

test('WS text message round-trips through the UDS as one NDJSON line', async (t) => {
  let received = Buffer.alloc(0);
  const { port } = await setup(t, (c) => {
    c.on('data', (d) => {
      received = Buffer.concat([received, d]);
      c.write(d);
    });
  });
  const { sock, reader } = await wsConnect(port);
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.list' });
  sock.write(clientFrame(0x1, msg));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.toString(), msg);
  assert.equal(received.toString(), msg + '\n');
  sock.destroy();
});

test('fragmented client message is reassembled into one line', async (t) => {
  let received = Buffer.alloc(0);
  const { port } = await setup(t, (c) => {
    c.on('data', (d) => {
      received = Buffer.concat([received, d]);
      c.write(d);
    });
  });
  const { sock, reader } = await wsConnect(port);
  sock.write(clientFrame(0x1, '{"a"', false));
  sock.write(clientFrame(0x0, ':"b', false));
  sock.write(clientFrame(0x0, 'c"}', true));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.toString(), '{"a":"bc"}');
  assert.equal(received.toString(), '{"a":"bc"}\n');
  sock.destroy();
});

test('multi-MB message survives both directions', async (t) => {
  const { port } = await setup(t);
  const { sock, reader } = await wsConnect(port);
  const big = 'x'.repeat(3 * 1024 * 1024);
  sock.write(clientFrame(0x1, big));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.length, big.length);
  assert.equal(frame.payload.toString(), big);
  sock.destroy();
});

test('over-cap message closes the connection with 1009', async (t) => {
  const { port } = await setup(t);
  const { sock, reader } = await wsConnect(port);
  const header = Buffer.alloc(10);
  header[0] = 0x81; // FIN + text
  header[1] = 0x80 | 127; // masked + 64-bit length
  header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
  sock.write(header);
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1009);
  await once(sock, 'close');
});

test('UDS-side disconnect closes the WS client', async (t) => {
  let resolveConn;
  const gotConn = new Promise((resolve) => (resolveConn = resolve));
  const { port } = await setup(t, (c) => resolveConn(c));
  const { sock, reader } = await wsConnect(port);
  const conn = await gotConn;
  conn.destroy();
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x8);
  await once(sock, 'close');
});

test('WS-side disconnect closes the UDS connection', async (t) => {
  let resolveConn;
  const gotConn = new Promise((resolve) => (resolveConn = resolve));
  const { port } = await setup(t, (c) => resolveConn(c));
  const { sock } = await wsConnect(port);
  const conn = await gotConn;
  sock.destroy();
  await once(conn, 'close');
});

test('ping is answered with a pong carrying the same payload', async (t) => {
  const { port } = await setup(t);
  const { sock, reader } = await wsConnect(port);
  sock.write(clientFrame(0x9, 'ping-payload'));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0xa);
  assert.equal(frame.payload.toString(), 'ping-payload');
  sock.destroy();
});

test('binary frames are ignored', async (t) => {
  let received = Buffer.alloc(0);
  const { port } = await setup(t, (c) => {
    c.on('data', (d) => {
      received = Buffer.concat([received, d]);
      c.write(d);
    });
  });
  const { sock, reader } = await wsConnect(port);
  sock.write(clientFrame(0x2, Buffer.from([1, 2, 3])));
  sock.write(clientFrame(0x1, 'after-binary'));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.toString(), 'after-binary');
  assert.equal(received.toString(), 'after-binary\n');
  sock.destroy();
});

test('client-initiated Close is echoed with the same code, then the socket closes', async (t) => {
  let resolveConn;
  const gotConn = new Promise((resolve) => (resolveConn = resolve));
  const { port } = await setup(t, (c) => resolveConn(c));
  const { sock, reader } = await wsConnect(port);
  const conn = await gotConn;
  const connClosed = once(conn, 'close');
  const sockClosed = once(sock, 'close');
  const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('done')]); // 1000 + reason
  sock.write(clientFrame(0x8, payload));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1000);
  await sockClosed;
  await connClosed;
});

test('over-cap line from the UDS side closes the WS client with 1009', async (t) => {
  const { port } = await setup(t, (c) => {
    c.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61));
  });
  const { sock, reader } = await wsConnect(port);
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1009);
  await once(sock, 'close');
});

test('upgrade with a non-loopback Origin is rejected with 403', async (t) => {
  const { port } = await setup(t);
  const { sock, headerText } = await wsConnect(port, '/ws', 'Origin: https://evil.example\r\n');
  assert.match(headerText, /^HTTP\/1\.1 403 /);
  sock.destroy();
});

test('upgrade with a loopback Origin is accepted and round-trips', async (t) => {
  const { port } = await setup(t);
  const { sock, reader, headerText } = await wsConnect(port, '/ws', 'Origin: http://localhost:5173\r\n');
  assert.match(headerText, /^HTTP\/1\.1 101 /);
  sock.write(clientFrame(0x1, '{"id":1}'));
  const frame = await reader.next();
  assert.equal(frame.payload.toString(), '{"id":1}');
  sock.destroy();
});

test('non-loopback host is refused at startup without the unsafe opt-out', async () => {
  const child = spawn(process.execPath, [BRIDGE_PATH, '--host', '0.0.0.0', '--socket', '/nonexistent.sock']);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
  assert.match(stderr, /refusing to bind non-loopback host 0\.0\.0\.0/);
  assert.match(stderr, /--unsafe-allow-non-loopback/);
});

test('existing non-socket paths are refused at startup', async () => {
  for (const socketPath of [process.execPath, os.tmpdir()]) {
    const child = spawn(process.execPath, [BRIDGE_PATH, '--socket', socketPath, '--port', '0']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /not a Unix domain socket/);
    assert.doesNotMatch(stdout, /listening on/);
  }
});

test('UDS connect failure closes the WS client with a clear reason', async (t) => {
  const bridge = createBridge({ socketPath: tmpSockPath(), host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => bridge.listen(resolve));
  t.after(() => bridge.close());
  const { sock, reader } = await wsConnect(bridge.server.address().port);
  sock.write(clientFrame(0x1, '{"jsonrpc":"2.0","id":1,"method":"workspace.list"}'));
  const frame = await reader.next();
  assert.equal(frame.opcode, 0x8);
  assert.equal(frame.payload.readUInt16BE(0), 1011);
  assert.match(frame.payload.subarray(2).toString(), /intentd UDS error/);
  await once(sock, 'close');
});
