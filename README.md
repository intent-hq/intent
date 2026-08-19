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

Installing `intentd` installs the **sitter** — a small self-updating shim,
itself named `intentd`, that downloads the latest real daemon from the public
[intent-hq/intentd-releases](https://github.com/intent-hq/intentd-releases)
mirror (falling back to the
[intentd repo's own releases](https://github.com/intent-hq/intentd/releases)),
forwards all CLI
arguments to it, and respawns it if it crashes.
Update checks run only for `intentd serve` (at startup and every 12–24
hours); one-shot subcommands (e.g. `intentd doctor`) run the installed
daemon as-is and fail fast with guidance if none is installed yet. The
sitter tracks the stable channel by default; `intentd sitter channel beta`
durably pins beta in `<data_dir>/sitter/config.toml` (add `--redownload` to
install that channel's version immediately — also the downgrade path — then
`intentd restart` to activate it in place). Per-launch `--sitter-channel` /
`INTENTD_CHANNEL` overrides take precedence over the pin.

### One-line script (macOS & Linux)

```sh
curl -fsSL https://github.com/intent-hq/intentd-releases/releases/download/sitter-latest/install.sh | sh
```

Detects OS/arch, verifies the archive checksum, and installs `intentd` to
`/usr/local/bin` when writable, else `~/.local/bin` (override with
`INTENTD_INSTALL_DIR`). Then start the daemon with `intentd serve`, or use
the Homebrew / `.deb` installs below for a managed background service.

On Windows:

```powershell
powershell -c "irm https://github.com/intent-hq/intentd-releases/releases/download/sitter-latest/install.ps1 | iex"
```

### Homebrew (macOS & Linux)

```sh
brew tap intent-hq/homebrew-tap
brew install intentd
brew services start intentd   # runs `intentd serve --resume-all` now and on startup
```

The Intent desktop app connects to an already-running daemon such as this
brew-managed one when configured to; it can also spawn its own bundled
`intentd` (sidecar mode).

### Debian/Ubuntu

`.deb` packages ship the sitter with a systemd user unit that runs
`intentd serve --resume-all`; download them from the sitter releases on the
public
[intentd-releases page](https://github.com/intent-hq/intentd-releases/releases):

```sh
# On arm64, use intentd_arm64.deb in both commands.
curl -fLO https://github.com/intent-hq/intentd-releases/releases/download/sitter-latest/intentd_amd64.deb
sudo apt install ./intentd_amd64.deb
# The package does not auto-enable the unit (it is per-user); start it at login with:
systemctl --user enable --now intentd
```

### Direct download

Prebuilt sitter archives for macOS, Linux, and Windows are published on the
public intentd-releases repo's
[`sitter-latest` release](https://github.com/intent-hq/intentd-releases/releases/tag/sitter-latest).

The desktop app is not yet packaged for download; it will ship via GitHub
Releases. Until then, you can [build it from source](#build-from-source).

## Build from source

```sh
git clone --recurse-submodules https://github.com/intent-hq/monorepo.git
cd monorepo

make check   # cargo fmt --check + cargo clippy -- -D warnings
make test    # cargo nextest run --workspace (needs cargo-nextest: cargo install cargo-nextest --locked)
make build   # cargo build --workspace
```

`packages/ios` is a private submodule and is skipped automatically
(`update = none` in `.gitmodules`), so the clone succeeds without access to
[intent-hq/ios](https://github.com/intent-hq/ios) — the directory is simply
left empty.

Run the stack locally in one of three ways:

```sh
# One-command sidecar mode (recommended): the desktop app spawns and
# supervises its own intentd binary, like the packaged app.
make dev

# Production-data frontend mode: connect the dev FE to the packaged app's
# already-running daemon and show the same workspaces and agents.
make dev-prod

# Two-terminal mode, useful for daemon debugging:
make dev-daemon   # terminal 1 — dev daemon with an isolated data dir
make dev-fe       # terminal 2 — desktop app, pinned to the dev daemon's UDS socket
```

`make dev-prod` uses `INTENTD_SOCKET` when provided. Otherwise, the packaged
socket defaults to `$HOME/Library/Application Support/intentd/intentd.sock`
on macOS and `${XDG_DATA_HOME:-$HOME/.local/share}/intentd/intentd.sock`
on Linux. This mode connects directly to the packaged daemon's production state
and does not start another daemon.

`make help` lists every documented target.

## Architecture

Clients are thin: all state and business logic — including the agent runtime —
live in `intentd`, which persists to SQLite and serves JSON-RPC 2.0 over a
Unix-domain socket (local clients) and WSS/TLS (LAN clients such as the iOS
app). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the backend design
and [docs/protocol/](docs/protocol/README.md) for the canonical wire contract.

This monorepo ties the components together as git submodules and carries the
cross-cutting docs, tooling, and CI; the code lives in the component repos:

| Path | Repository | Component |
|------|------------|-----------|
| `packages/intentd` | [intent-hq/intentd](https://github.com/intent-hq/intentd) | Rust backend daemon |
| `packages/cloudlands-fe` | [intent-hq/cloudlands-fe](https://github.com/intent-hq/cloudlands-fe) | Electron + SvelteKit desktop app |
| `packages/ios` | [intent-hq/ios](https://github.com/intent-hq/ios) | SwiftUI iOS companion app (private) |

## Network & privacy

Intent is local-first: all state lives on your machine, and the stack ships
**no telemetry, analytics, or crash reporting**. Network access is limited to
update checks against public GitHub Releases and actions you take yourself:

- **Desktop app auto-updates** — the packaged app checks for and downloads
  updates from GitHub Releases on
  [intent-hq/cloudlands-releases](https://github.com/intent-hq/cloudlands-releases).
- **intentd sitter self-update** — the sitter (see [Install](#install))
  downloads the daemon and checks the channel manifests published on the
  public
  [intent-hq/intentd-releases](https://github.com/intent-hq/intentd-releases)
  mirror, falling back to the
  [intentd releases page](https://github.com/intent-hq/intentd/releases). The
  mirror is the permanent public distribution channel, kept even after the
  intentd repo goes public.
- **Auggie binary download (on demand)** — installing the Auggie CLI from the
  desktop app downloads the pre-built binary from the latest public release of
  [augmentcode/auggie](https://github.com/augmentcode/auggie).
- **Provider sign-ins (user-initiated)** — signing in to a coding-agent
  provider (Auggie, Claude Code, Codex, OpenCode, Droid, Grok, Pi) runs that
  provider's own CLI sign-in flow; each provider CLI talks to its own vendor
  service when you sign in.
- **User-configured integrations** — connecting GitHub (OAuth device flow or
  personal access token), Linear (API key), or Sentry calls the respective
  service's API with credentials you provide. Sentry is opt-in in two places:
  the desktop app talks to the sentry.io API when you connect a Sentry
  account, and the daemon's Sentry integration uses an API token you
  configure. Nothing is sent to any of these services unless you connect them.

Coding agents you run are external programs and may access the network
according to their own provider's behavior.

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
