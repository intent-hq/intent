# Self-hosting the daemon (advanced)

> Most people should install the packaged app from [intentapp.dev](https://intentapp.dev), which bundles and manages
> `intentd` for you. This page covers running the daemon on its own, for example on a remote host.

Install `intentd` separately only if you want to run and manage the daemon
independently of the desktop app, such as on a remote host.

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

## One-line script (macOS & Linux)

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

## Homebrew (macOS & Linux)

```sh
brew tap intent-hq/homebrew-tap
brew install intentd
brew services start intentd   # runs `intentd serve` now and on startup
```

The Intent desktop app picks up an already-running daemon such as this
brew-managed one automatically, with nothing to configure: at startup it probes
the default socket and, when a daemon answers, connects to it instead of
spawning its own bundled `intentd`. Quitting the app leaves an adopted daemon
(and its agents) running. When no daemon is running, the app spawns its
bundled `intentd` (sidecar mode) and stops it on quit.

## Debian/Ubuntu

`.deb` packages ship the sitter with a systemd user unit that runs
`intentd serve`; download them from the sitter releases on the
public
[intentd-releases page](https://github.com/intent-hq/intentd-releases/releases):

```sh
# On arm64, use intentd_arm64.deb in both commands.
curl -fLO https://github.com/intent-hq/intentd-releases/releases/download/sitter-latest/intentd_amd64.deb
sudo apt install ./intentd_amd64.deb
# The package does not auto-enable the unit (it is per-user); start it at login with:
systemctl --user enable --now intentd
```

## Direct download

Prebuilt sitter archives for macOS, Linux, and Windows are published on the
public intentd-releases repo's
[`sitter-latest` release](https://github.com/intent-hq/intentd-releases/releases/tag/sitter-latest).

## Network ports and separate installations

Network access is disabled by default. Local-only installations use their local
socket and do not allocate a TCP port. On the first WSS start, an installation
without a configured `server.wsApi.port` tries `5181` and then consecutive ports
through `65535`, advancing only when an address is already in use. It saves the
first port that binds on every required address in `<data_dir>/config.toml`
before announcing readiness. Separate per-user installations select and save
their own ports; clients should use `intentd pair` or the pairing payload to
discover the actual listening port.

The saved port stays fixed across restarts. Existing numeric port settings and
nonzero `INTENTD_TCP_PORT` overrides are also fixed choices. If enabled WSS
cannot bind at daemon startup, the daemon exits with an error; sitter retries
do not choose another port. Release the occupied port, or stop the daemon and
set a different `port` under `[server.wsApi]` in its config. Deliberately
removing that entry requests a new selection at the next WSS start. Check for
an environment override before editing the file, since it takes precedence.

Installer and sitter readiness checks remain based on the per-user local
socket; they do not allocate or probe a WSS port. See the
[transport contract](protocol/01-transport.md) and
[port setting semantics](protocol/methods/settings.md#wss-port-assignment)
for runtime enable failures and reset behavior.
