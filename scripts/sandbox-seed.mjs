#!/usr/bin/env node
// sandbox-seed: give a running `make dev-sandbox-stack` a plain-folder workspace
// whose Spec holds sample links (external, note, file, workspace), then print the
// deep link that opens it. Re-running reuses the workspace and rewrites the notes.
// Stack only: app mode talks to the installed daemon, which must not be seeded.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_TITLE = 'Sandbox links';
export const LINKED_NOTE_TITLE = 'Linked note';

export function seedFolder(root = repoRoot, env = process.env) {
  // Plain folders must sit outside any git repository, so not under .dev/.
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return path.join(cache, 'intent-sandbox-seed', key);
}

export function specContent({ workspaceId, linkedNoteId }) {
  return `# Sandbox links

Sample links for UI checks. Hover a link for its hint; ⌘-click opens it in the app.

- External: [example.com](https://example.com)
- Bare URL: https://example.org/docs
- Note: [${LINKED_NOTE_TITLE}](intent://local/note/${linkedNoteId})
- File: [README.md](intent://local/file/README.md)
- Workspace: [${SEED_TITLE}](intent://local/workspace/${workspaceId})
`;
}

export function rpc(socketPath, method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const done = (fn, value) => {
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'));
    sock.on('error', (err) => done(reject, new Error(`intentd socket ${socketPath}: ${err.code || err.message}`)));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
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
        if (frame?.id !== 1) continue;
        if (frame.error) return done(reject, new Error(`${method}: ${frame.error.message}`));
        return done(resolve, frame.result);
      }
    });
  });
}

async function listAll(call, method, params, key) {
  const rows = [];
  let nextToken;
  do {
    const page = await call(method, { ...params, ...(nextToken ? { nextToken } : {}) });
    rows.push(...(page[key] ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return rows;
}

export async function seed({ call, folder }) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# Sandbox seed\n\nTarget of the file link in the Spec.\n');

  const workspaces = await listAll(call, 'workspace.list', {}, 'workspaces');
  let workspace = workspaces.find((w) => w.plainFolder && w.repositoryPath === folder);
  workspace ??= (await call('workspace.create', { plainFolder: true, repositoryPath: folder, title: SEED_TITLE }))
    .workspace;
  const workspaceId = workspace.id;

  const notes = await listAll(call, 'note.list', { workspaceId, projection: 'slim' }, 'notes');
  let linkedNoteId = notes.find((n) => n.title === LINKED_NOTE_TITLE)?.id;
  linkedNoteId ??= (
    await call('note.create', {
      workspaceId,
      title: LINKED_NOTE_TITLE,
      content: `# ${LINKED_NOTE_TITLE}\n\nOpened from a link in the Spec.\n`,
    })
  ).note.id;

  await call('note.setContent', {
    workspaceId,
    noteId: 'spec',
    content: specContent({ workspaceId, linkedNoteId }),
    confirmReplacement: true,
  });
  return { workspaceId, noteId: 'spec', linkedNoteId };
}

async function main() {
  const statePath = path.join(repoRoot, '.dev/sandbox/stack.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    console.error('[sandbox-seed] no stack sandbox is running; start `make dev-sandbox-stack` (MOCK_AGENT=1 optional) first.');
    process.exit(1);
  }
  const call = (method, params) => rpc(state.socket, method, params);
  const result = await seed({ call, folder: seedFolder() });
  const url = `${state.daemonLocalhostUrl.replace(/\/$/, '')}/workspace/${result.workspaceId}?note=spec`;
  if (process.env.SEED_JSON === '1') {
    console.log(JSON.stringify({ ...result, url }));
  } else {
    console.log(`[sandbox-seed] workspace ${result.workspaceId}: Spec with sample links`);
    console.log(`[sandbox-seed] open ${url}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[sandbox-seed] error: ${err.message}`);
    process.exit(1);
  });
}
