# WSS-over-SSH Remote Transport (Design)

Design note for the remote-workspace transport model that survives the`intent-server.cjs` retirement. The retirement deleted the legacy Nodesidecar and every FE consumer of `RemoteRPCClient` / `RemoteMetadataFS` /`remote-executor` / `remote-git-manager`. This document records what the FEkeeps, how the surviving surface reaches a remote daemon, and what a futureFE↔intentd remote hookup will look like.

## Goal

Reach a remote `intentd` from the FE renderer over an SSH-authenticated,TLS-terminated WebSocket **without** deploying any FE-owned code on theremote host. The remote host runs a pre-installed `intentd` binary exactlyas it does locally; the WebSocket handshake and pinned-TLS material land onthe SSH-authenticated user account, so no separate port-forward or`ssh -L` mental model is needed.

## Non-goals

- Porting the retired `intent-server.cjs` or any remote-side FE code.
- Reintroducing `deployIntentServer` / `readRemoteFile` / `writeRemoteFile`.
- Client-side FS or git implementations for remote workspaces — those callsroute through the daemon's existing `file.*`, `fs.*`, `git.*`, and`search.*` RPCs (PROTOCOL §§5.6, 5.9) or return a structured "notsupported for remote workspaces" error until the daemon is reachable.

## Surviving FE surface

- `SSHManager` (`packages/cloudlands-fe/src/shared/main/ssh-manager.ts`) —connection lifecycle (`connect` / `disconnect` / `executeCommand` /`uploadFile` / `getConnections`) plus the `transport: 'websocket'` branchthat wraps the WebSocket in `createWebSocketStream` and hands theresulting `Duplex` to the ssh2 `Client` as its `sock`.
- `SSHConnectionConfig.transport: 'ssh' | 'websocket'` and the optional`wsUrl` on the same shape.
- The workspace's `environmentConfig.ssh` bag (host, port, username,auth material, and — for remote intentd — the WSS URL and pinned-TLSfingerprint the daemon advertises).

## Transport shape

The FE picks the transport per workspace on `SSHManager.connect`:

- `transport: 'ssh'` (default) — plain TCP handshake to `host:port`authenticated by password / private key / SSH agent. Used by the SFTPand interactive-command paths that survive the remote retirement(`file-sync.ts:104,197,207` upload sites; `ssh.ipc.ts` command execution).
- `transport: 'websocket'` + `wsUrl` — the FE opens a WebSocket to theconfigured URL, wraps it via `createWebSocketStream(ws)`, and passes theresulting `Duplex` to ssh2's `Client.connect({ sock })`. `host` / `port`are intentionally left unset because ssh2 ignores them when `sock` issupplied. This is the seam the future FE↔remote-intentd hookup layersdaemon JSON-RPC on top of.

## Why not `ssh -L` port-forwarding?

The `ssh -L` mental model was misleading: a local forward assumes the FEspeaks plain TCP to a local port that is tunnelled to a remote socket. Inthe WSS-over-SSH model the WebSocket itself **is** the transport — thesame duplex the SSH client rides — so no forward is set up, no ephemeralport is bound, and no second SSH channel is opened. The WebSocket close /error surface propagates directly to the SSH `Client.close` handler, whichthe manager already handles (`ssh-manager.ts:243–256`) by cleaning up the`WebSocket` instance.

## Interaction with the daemon

- Local workspaces: FE `AppClient` connects to the local `intentd` UDS astoday; `SSHManager` is not involved.
- Remote workspaces (future): the FE will construct an `AppClient` whosetransport is the daemon's pinned-TLS WSS. The WSS handshake terminateson the remote `intentd`; the SSH-established WebSocket duplex is whatthe future transport substrate wraps. Until that hookup lands, remoteworkspace bootstrapping is deliberately degraded — the FE warms an SSHconnection but skips monitoring / listing / search / git and returns astructured error, each with a `TODO(P3-5)` marker at the call site.

## Verification

A feasibility proof lives in`packages/cloudlands-fe/src/shared/main/__tests__/ssh-manager-wss-transport.test.ts`.It spins a localhost `ws://` server, mocks the ssh2 `Client`, and assertsthat `SSHManager.connect({ transport: 'websocket', wsUrl })`:

1. Opens a WebSocket to `wsUrl`, wraps it via `createWebSocketStream`, andpasses the resulting `Duplex` to `Client.connect({ sock })` with `host`/ `port` unset.
2. Rejects with a WebSocket-branded error when `wsUrl` is unreachable andnever reaches the ssh2 `Client.connect` call.

No real SSH daemon or remote host is required; the test exercises theFE-owned transport branch end-to-end.