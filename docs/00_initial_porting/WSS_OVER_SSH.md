# WSS-over-SSH Remote Transport (Design)

Design note for the remote-workspace transport model that survives the
`intent-server.cjs` retirement. The retirement deleted the legacy Node
sidecar and every FE consumer of `RemoteRPCClient` / `RemoteMetadataFS` /
`remote-executor` / `remote-git-manager`. This document records what the FE
keeps, how the surviving surface reaches a remote daemon, and what a future
FE↔intentd remote hookup will look like.

## Goal

Reach a remote `intentd` from the FE renderer over an SSH-authenticated,
TLS-terminated WebSocket **without** deploying any FE-owned code on the
remote host. The remote host runs a pre-installed `intentd` binary exactly
as it does locally; the WebSocket handshake and pinned-TLS material land on
the SSH-authenticated user account, so no separate port-forward or
`ssh -L` mental model is needed.

## Non-goals

- Porting the retired `intent-server.cjs` or any remote-side FE code.
- Reintroducing `deployIntentServer` / `readRemoteFile` / `writeRemoteFile`.
- Client-side FS or git implementations for remote workspaces — those calls
  route through the daemon's existing `file.*`, `fs.*`, `git.*`, and
  `search.*` RPCs (PROTOCOL §§5.6, 5.9) or return a structured "not
  supported for remote workspaces" error until the daemon is reachable.

## Surviving FE surface

- `SSHManager` (`packages/cloudlands-fe/src/shared/main/ssh-manager.ts`) —
  connection lifecycle (`connect` / `disconnect` / `executeCommand` /
  `uploadFile` / `getConnections`) plus the `transport: 'websocket'` branch
  that wraps the WebSocket in `createWebSocketStream` and hands the
  resulting `Duplex` to the ssh2 `Client` as its `sock`.
- `SSHConnectionConfig.transport: 'ssh' | 'websocket'` and the optional
  `wsUrl` on the same shape.
- The workspace's `environmentConfig.ssh` bag (host, port, username,
  auth material, and — for remote intentd — the WSS URL and pinned-TLS
  fingerprint the daemon advertises).

## Transport shape

The FE picks the transport per workspace on `SSHManager.connect`:

- `transport: 'ssh'` (default) — plain TCP handshake to `host:port`
  authenticated by password / private key / SSH agent. Used by the SFTP
  and interactive-command paths that survive the remote retirement
  (`file-sync.ts:104,197,207` upload sites; `ssh.ipc.ts` command execution).
- `transport: 'websocket'` + `wsUrl` — the FE opens a WebSocket to the
  configured URL, wraps it via `createWebSocketStream(ws)`, and passes the
  resulting `Duplex` to ssh2's `Client.connect({ sock })`. `host` / `port`
  are intentionally left unset because ssh2 ignores them when `sock` is
  supplied. This is the seam the future FE↔remote-intentd hookup layers
  daemon JSON-RPC on top of.

## Why not `ssh -L` port-forwarding?

The `ssh -L` mental model was misleading: a local forward assumes the FE
speaks plain TCP to a local port that is tunnelled to a remote socket. In
the WSS-over-SSH model the WebSocket itself **is** the transport — the
same duplex the SSH client rides — so no forward is set up, no ephemeral
port is bound, and no second SSH channel is opened. The WebSocket close /
error surface propagates directly to the SSH `Client.close` handler, which
the manager already handles (`ssh-manager.ts:243–256`) by cleaning up the
`WebSocket` instance.

## Interaction with the daemon

- Local workspaces: FE `AppClient` connects to the local `intentd` UDS as
  today; `SSHManager` is not involved.
- Remote workspaces (future): the FE will construct an `AppClient` whose
  transport is the daemon's pinned-TLS WSS. The WSS handshake terminates
  on the remote `intentd`; the SSH-established WebSocket duplex is what
  the future transport substrate wraps. Until that hookup lands, remote
  workspace bootstrapping is deliberately degraded — the FE warms an SSH
  connection but skips monitoring / listing / search / git and returns a
  structured error, each with a `TODO(P3-5)` marker at the call site.

## Verification

A feasibility proof lives in
`packages/cloudlands-fe/src/shared/main/__tests__/ssh-manager-wss-transport.test.ts`.
It spins a localhost `ws://` server, mocks the ssh2 `Client`, and asserts
that `SSHManager.connect({ transport: 'websocket', wsUrl })`:

1. Opens a WebSocket to `wsUrl`, wraps it via `createWebSocketStream`, and
   passes the resulting `Duplex` to `Client.connect({ sock })` with `host`
   / `port` unset.
2. Rejects with a WebSocket-branded error when `wsUrl` is unreachable and
   never reaches the ssh2 `Client.connect` call.

No real SSH daemon or remote host is required; the test exercises the
FE-owned transport branch end-to-end.
