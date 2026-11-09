// Persistent JSON-RPC 2.0 client over intentd's UDS socket (newline-delimited frames).

import net from 'node:net';

export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? JSON.stringify(error)}`);
    this.code = error?.code;
    this.data = error?.data;
  }
}

export function connect(socketPath, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const waiting = new Map();
    let nextId = 0;
    let buf = '';
    const listeners = [];
    const fail = (error) => {
      for (const w of waiting.values()) w.reject(error);
      waiting.clear();
    };
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id === undefined && frame.method) {
          for (const fn of listeners) fn(frame.method, frame.params);
          continue;
        }
        const w = waiting.get(frame.id);
        if (!w) continue;
        waiting.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.error) w.reject(new RpcError(w.method, frame.error));
        else w.resolve(frame.result);
      }
    });
    sock.once('error', (error) => {
      fail(error);
      reject(error);
    });
    sock.on('close', () => fail(new Error('intentd closed the UDS connection')));
    sock.once('connect', () =>
      resolve({
        call(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              waiting.delete(id);
              rej(new Error(`${method}: timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            waiting.set(id, { resolve: res, reject: rej, timer, method });
            sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          });
        },
        onNotification(fn) {
          listeners.push(fn);
        },
        close() {
          sock.end();
        },
      }),
    );
  });
}
