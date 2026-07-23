# Intent

**Intent** is a local-first agentic coding platform. A Rust daemon (`intentd`)
runs on your machine and owns everything — workspaces, notes, tasks, coding
agents, git, terminals, and events — exposing it all through a JSON-RPC API.
A desktop app (Electron + SvelteKit) and an iOS companion app connect to the
daemon as thin clients.

<!-- TODO: screenshot/demo -->

```
┌────────────────────────┐   ┌────────────────────────┐
│      Desktop app       │   │   iOS companion app    │
│  Electron + SvelteKit  │   │        SwiftUI         │
└───────────┬────────────┘   └───────────┬────────────┘
            │ JSON-RPC over UDS          │ JSON-RPC over WSS/TLS (LAN)
            ▼                            ▼
┌─────────────────────────────────────────────────────────┐
│                  intentd — Rust daemon                  │
│  workspaces · notes · tasks · agents · git · terminals  │
└─────────────────────────────────────────────────────────┘
```

## Install

### Homebrew (macOS & Linux)

```sh
brew tap intent-hq/homebrew-tap
brew install intentd
brew services start intentd   # start now and on startup (launchd on macOS, systemd on Linux)
```

The Intent desktop app auto-detects and connects to the brew-managed daemon.

### GitHub Releases

Prebuilt `intentd` binaries — macOS, Linux, and Windows archives, `.deb`
packages, and shell/PowerShell installers — are published on the
[intentd releases page](https://github.com/intent-hq/intentd/releases).

The desktop app is not yet packaged for download; it will ship via GitHub
Releases. Until then, you can [build it from source](#build-from-source).

## Build from source

```sh
git clone https://github.com/intent-hq/monorepo.git
cd monorepo
# Init the public submodules (packages/ios is currently private):
git submodule update --init --recursive packages/intentd packages/cloudlands-fe

make check   # cargo fmt --check + cargo clippy -- -D warnings
make test    # cargo test --workspace
make build   # cargo build --workspace
```

Run the stack locally in one of two ways:

```sh
# One-command sidecar mode (recommended): the desktop app spawns and
# supervises its own intentd binary, like the packaged app.
make dev

# Two-terminal mode, useful for daemon debugging:
make dev-daemon   # terminal 1 — dev daemon with an isolated data dir
make run-fe       # terminal 2 — desktop app, connects to the dev daemon
```

`make help` lists every documented target.

## Architecture

Clients are thin: all state and business logic — including the agent runtime —
live in `intentd`, which persists to SQLite and serves JSON-RPC 2.0 over a
Unix-domain socket (local clients) and WSS/TLS (LAN clients such as the iOS
app). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the backend design
and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the canonical wire contract.

This monorepo ties the components together as git submodules and carries the
cross-cutting docs, tooling, and CI; the code lives in the component repos:

| Path | Repository | Component |
|------|------------|-----------|
| `packages/intentd` | [intent-hq/intentd](https://github.com/intent-hq/intentd) | Rust backend daemon |
| `packages/cloudlands-fe` | [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) | Electron + SvelteKit desktop app |
| `packages/ios` | [intent-hq/ios](https://github.com/intent-hq/ios) | SwiftUI iOS companion app (private) |

## Community

- [CONTRIBUTING.md](CONTRIBUTING.md) — bug reports and feature requests are
  very welcome via the
  [issue forms](https://github.com/intent-hq/monorepo/issues/new/choose);
  external pull requests are deferred for now while the public repository is a
  read-only snapshot mirror.
- [SECURITY.md](SECURITY.md) — report security vulnerabilities privately, not
  through public issues.
- [Issue tracker](https://github.com/intent-hq/monorepo/issues) — the single
  tracker for all Intent components.

## iOS companion app

The SwiftUI iOS companion app is in early development; its repository is
currently private and will open up later.

## License

Intent is licensed under the [Apache License 2.0](LICENSE).
