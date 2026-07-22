# Intent Monorepo Makefile
#
# Three postures for local work:
#   1. `make dev-daemon` — default dev seat. intentd on an isolated data dir,
#      serving UDS + TCP (`--listen both --insecure`) bound on 0.0.0.0:$(DEV_TCP_PORT)
#      (reachable from loopback and LAN). Pairs with `make run-fe` (whose dev default
#      is `ws://127.0.0.1:5181/ws`) and with the iOS app (`make ios-info`).
#   2. `make release-daemon` — occasional "debug the release app with its own
#      state" seat. intentd on the real data dir, `LISTEN=uds` by default and
#      no `--insecure`, so it never binds $(DEV_TCP_PORT) or collides with the
#      dev seat.
#   3. `make run-fe` / `make ios-open` / `make ios-info` — clients pointed at
#      the dev daemon.
#
# `make help` lists every documented target (any recipe whose header ends in
# `## <description>`).

INTENTD_DIR = packages/intentd
FE_DIR = packages/cloudlands-fe
IOS_DIR = packages/ios

# `ensure-submodules` covers ALL submodules (intentd + FE + iOS), initializing
# any that are missing. The FE and iOS submodules are heavy and not needed for
# backend-only workflows, so those workflows use the narrower per-submodule
# targets instead: `ensure-intentd-submodule` for every Rust target
# (build/test/fmt/clippy/check), and `ensure-fe-submodule` /
# `ensure-ios-submodule` on demand (same idempotent init-if-missing contract).
SUBMODULES = $(INTENTD_DIR) $(FE_DIR) $(IOS_DIR)

# Dev-seat data + ports (overridable, e.g. `make dev-daemon DEV_TCP_PORT=6181`).
#
# DEV_DATA_DIR is a dedicated, gitignored dir under the monorepo so the dev
# seat never touches the packaged app's real data dir (Config::resolve in
# packages/intentd/crates/intent-core/src/config.rs honours INTENTD_DATA_DIR).
#
# DEV_TCP_PORT is the intentd TCP/WebSocket base port. 5181 matches the FE's
# built-in dev default (`DEFAULT_DEV_WS_URL = ws://127.0.0.1:5181/ws` in
# packages/cloudlands-fe/src/features/backend/main/backend-connection.ts), so
# `make dev-daemon` + `make run-fe` connect with no env overrides. The daemon
# reads it via the INTENTD_TCP_PORT env seam (ws_options_from_env in
# packages/intentd/crates/intentd/src/main.rs).
#
# DEV_PORT is a separate FE-only knob: the Electron dev launcher uses it to
# namespace its userData directory (resolveDevUserDataDirName in
# packages/cloudlands-fe/src/main/utils/resolve-dev-instance.ts), keeping
# parallel dev Electrons off each other's SingletonLock. It has nothing to do
# with intentd's TCP port and is passed through to the FE unchanged.
DEV_DATA_DIR ?= $(CURDIR)/.dev/intentd
DEV_TCP_PORT ?= 5181
DEV_PORT ?= 5190
# Export DEV_PORT so `make run-fe` (and any recipe that shells out to the FE)
# actually sees the default/override in the child environment.
export DEV_PORT

# Transport for `release-daemon`. Defaults to `uds` (UDS only) so the release
# seat can never race the dev seat for $(DEV_TCP_PORT). Override for the
# TCP+UDS or TCP-only postures, e.g. `make release-daemon LISTEN=both`.
LISTEN ?= uds

.PHONY: all help ensure-submodules ensure-intentd-submodule ensure-fe-submodule ensure-ios-submodule \
	build build-intentd build-sidecar test test-intentd fmt clippy check clean clean-dev \
	dev-daemon release-daemon run-intentd run-fe dev ios-open ios-info

all: build

help: ## List documented targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

ensure-submodules: ## Initialize any missing submodules — intentd, FE, iOS (idempotent)
	@for sm in $(SUBMODULES); do \
		if [ ! -e "$$sm/.git" ]; then \
			echo "[ensure-submodules] initializing $$sm"; \
			git submodule update --init --recursive "$$sm"; \
		else \
			echo "[ensure-submodules] $$sm already initialized — leaving as-is"; \
		fi; \
	done

# Narrow init for the intentd submodule — the only one Rust targets
# (build/test/fmt/clippy/check and the daemon seats) need, keeping
# backend-only workflows fast.
ensure-intentd-submodule:
	@if [ ! -e "$(INTENTD_DIR)/.git" ]; then \
		echo "[ensure-intentd-submodule] initializing $(INTENTD_DIR)"; \
		git submodule update --init --recursive "$(INTENTD_DIR)"; \
	else \
		echo "[ensure-intentd-submodule] $(INTENTD_DIR) already initialized — leaving as-is"; \
	fi

# On-demand init for the FE submodule — pulled in only by targets that need it
# (`run-fe`), so backend-only workflows stay fast.
ensure-fe-submodule:
	@if [ ! -e "$(FE_DIR)/.git" ]; then \
		echo "[ensure-fe-submodule] initializing $(FE_DIR)"; \
		git submodule update --init --recursive "$(FE_DIR)"; \
	else \
		echo "[ensure-fe-submodule] $(FE_DIR) already initialized — leaving as-is"; \
	fi

# On-demand init for the iOS submodule — pulled in only by targets that need
# it (`ios-open`); backend-only workflows stay fast.
ensure-ios-submodule:
	@if [ ! -e "$(IOS_DIR)/.git" ]; then \
		echo "[ensure-ios-submodule] initializing $(IOS_DIR)"; \
		git submodule update --init --recursive "$(IOS_DIR)"; \
	else \
		echo "[ensure-ios-submodule] $(IOS_DIR) already initialized — leaving as-is"; \
	fi

build: build-intentd ## Build the Rust workspace (packages/intentd)

build-intentd: ensure-intentd-submodule
	cd $(INTENTD_DIR) && cargo build --workspace

fmt: ensure-intentd-submodule ## cargo fmt --check
	cd $(INTENTD_DIR) && cargo fmt --check

clippy: ensure-intentd-submodule ## cargo clippy -- -D warnings
	cd $(INTENTD_DIR) && cargo clippy --workspace -- -D warnings

check: fmt clippy ## fmt + clippy

test: test-intentd ## Run the Rust test suite

test-intentd: ensure-intentd-submodule
	cd $(INTENTD_DIR) && cargo test --workspace

clean: ## Remove cargo build artifacts (packages/intentd/target)
	rm -rf $(INTENTD_DIR)/target

clean-dev: ## Wipe the dev-seat state dir (.dev/)
	rm -rf "$(CURDIR)/.dev"

dev-daemon: ensure-intentd-submodule ## Dev seat: intentd on isolated data dir, UDS + insecure TCP on $(DEV_TCP_PORT)
	@mkdir -p "$(DEV_DATA_DIR)"
	@echo "[dev-daemon] intentd dev data dir: $(DEV_DATA_DIR) (UDS: $(DEV_DATA_DIR)/intentd.sock, TCP: 0.0.0.0:$(DEV_TCP_PORT))"
	@echo "[dev-daemon] WARNING: --insecure binds ws:// on 0.0.0.0:$(DEV_TCP_PORT) with no TLS and no auth — anyone on your LAN can reach it. Only run on a trusted network."
	# `--listen both --insecure` serves the local UDS socket AND a plain ws://
	# listener on 0.0.0.0:$(DEV_TCP_PORT) with no TLS and no bearer-token auth
	# — matches the FE's dev default and the iOS simulator/hardware seat.
	# The daemon fails fast if $(DEV_TCP_PORT) is already bound.
	INTENTD_DATA_DIR="$(DEV_DATA_DIR)" INTENTD_TCP_PORT=$(DEV_TCP_PORT) \
		cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen both --insecure

release-daemon: ensure-intentd-submodule ## Release-state debug seat: intentd on real data dir, LISTEN=uds by default, no --insecure
	# Runs intentd against its DEFAULT data dir (no dev override): Config::resolve picks
	# $$HOME/Library/Application Support/intentd on macOS for the socket + SQLite DB.
	# LISTEN defaults to `uds` so this seat is UDS-only and does not bind a TCP
	# port at all. Pass `LISTEN=both` or `LISTEN=tcp` to add the WSS listener on
	# intentd's default TCP port (5181 unless INTENTD_TCP_PORT is set); the
	# daemon fails fast if that port is already bound (e.g. by `make dev-daemon`
	# on the same 5181). No `--insecure`: the TCP listener, when enabled, serves
	# wss:// with TLS + bearer auth as the packaged app expects.
	cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen $(LISTEN)

run-intentd: ## DEPRECATED alias for release-daemon
	@echo "[run-intentd] DEPRECATED: use 'make release-daemon' (or 'make dev-daemon' for the dev seat)."
	@$(MAKE) release-daemon

run-fe: ensure-fe-submodule ## Run the Electron + SvelteKit FE (pairs with dev-daemon out of the box)
	# Launches only the FE dev stack (vite + Electron). The FE does NOT spawn
	# intentd; pair this with `make dev-daemon` (default) — the FE's dev build
	# defaults to `ws://127.0.0.1:5181/ws` (DEFAULT_DEV_WS_URL in
	# packages/cloudlands-fe/src/features/backend/main/backend-connection.ts),
	# which matches dev-daemon's DEV_TCP_PORT. Overrides:
	#   INTENTD_SOCKET=/path/to.sock  → UDS (highest precedence; e.g. point at
	#                                    release-daemon's default socket).
	#   INTENTD_WS_URL=ws://host:port → plain WebSocket to a specific URL.
	# Long-running; does not exit until you stop it (Ctrl-C).
	@[ -d $(FE_DIR)/node_modules ] || (echo "[run-fe] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	cd $(FE_DIR) && pnpm run dev

build-sidecar: ensure-intentd-submodule ensure-fe-submodule ## Build intentd release + stage the sidecar binary for FE packaging
	# Builds the intentd release binary (may take several minutes on first build) and
	# runs the FE copy-sidecar script to stage it for electron-builder. This is the
	# prerequisite for `pnpm run dist:mac` in packages/cloudlands-fe.
	@echo "[build-sidecar] Building intentd release binary..."
	cd $(INTENTD_DIR) && cargo build --release --workspace
	@echo "[build-sidecar] Staging sidecar binary for FE packaging..."
	cd $(FE_DIR) && node scripts/copy-sidecar.cjs

dev: ensure-intentd-submodule ensure-fe-submodule ## One-command dev: launch the FE with intentd as a sidecar (INTENTD_SIDECAR=1)
	# Launches the FE with sidecar spawning enabled (INTENTD_SIDECAR=1). The FE will
	# spawn and supervise its own intentd binary, giving a one-command dev stack.
	# Always runs the intentd release build first so the sidecar reflects the
	# current sources; cargo's freshness check makes it a fast no-op when nothing
	# changed. This is an alternative to the two-terminal flow (dev-daemon +
	# run-fe); use whichever fits your workflow.
	# Long-running; does not exit until you stop it (Ctrl-C).
	#
	# Pins the sidecar to two absolute paths so it does not depend on Electron's cwd:
	#   INTENTD_BIN=$(CURDIR)/$(INTENTD_DIR)/target/release/intentd — the release binary
	#     just built above; consumed by resolveIntentdBinaryPath in
	#     packages/cloudlands-fe/src/features/backend/main/intentd-sidecar.ts
	#     (env override wins over the packaged/dev cwd walk).
	#   INTENTD_DATA_DIR=$(DEV_DATA_DIR) — the isolated dev data dir; keeps the
	#     sidecar off the packaged app's real data dir and pairs with the UDS
	#     socket at $(DEV_DATA_DIR)/intentd.sock (resolveSocketPath in the same file).
	@[ -d $(FE_DIR)/node_modules ] || (echo "[dev] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	@echo "[dev] Building intentd release binary (no-op if already fresh)..."
	cd $(INTENTD_DIR) && cargo build --release --workspace
	@mkdir -p "$(DEV_DATA_DIR)"
	@echo "[dev] Launching FE with sidecar mode enabled (INTENTD_SIDECAR=1)"
	@echo "[dev]   INTENTD_BIN=$(CURDIR)/$(INTENTD_DIR)/target/release/intentd"
	@echo "[dev]   INTENTD_DATA_DIR=$(DEV_DATA_DIR) (UDS: $(DEV_DATA_DIR)/intentd.sock)"
	cd $(FE_DIR) && INTENTD_SIDECAR=1 \
		INTENTD_BIN="$(CURDIR)/$(INTENTD_DIR)/target/release/intentd" \
		INTENTD_DATA_DIR="$(DEV_DATA_DIR)" \
		pnpm run dev

ios-open: ensure-ios-submodule ## Open the iOS Xcode project (packages/ios/Intent.xcodeproj)
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[ios-open] ERROR: requires macOS (Xcode). Detected $$(uname -s)."; \
		exit 1; \
	fi
	open "$(IOS_DIR)/Intent.xcodeproj"

ios-info: ## Print how to point the iOS app at the local dev daemon
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[ios-info] ERROR: requires macOS (uses ipconfig getifaddr). Detected $$(uname -s)."; \
		exit 1; \
	fi
	@echo "iOS ↔ intentd dev seat (pairs with 'make dev-daemon' on port $(DEV_TCP_PORT)):"
	@echo ""
	@echo "  Simulator: host 127.0.0.1  port $(DEV_TCP_PORT)"
	@lan_ip=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null); \
		if [ -n "$$lan_ip" ]; then \
			echo "  Hardware:  host $$lan_ip  port $(DEV_TCP_PORT)   (Mac + iPhone on the same LAN)"; \
		else \
			echo "  Hardware:  <no LAN IP on en0/en1 — connect Wi-Fi/Ethernet and re-run 'make ios-info'>"; \
		fi
	@echo ""
	@echo "  dev-daemon runs '--insecure' (plain ws://, no TLS, no bearer auth)."
	@echo "  In the iOS 'Manual Connection' sheet, enter the host + port above; the"
	@echo "  token field can be any non-empty value (the daemon does not enforce it"
	@echo "  in insecure mode)."
	@echo ""
	@echo "  For the secure/Bonjour pairing posture (TLS + bearer auth + QR/mDNS),"
	@echo "  run intentd WITHOUT '--insecure' and with INTENTD_DISCOVERY=1, e.g."
	@echo "    INTENTD_DISCOVERY=1 cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen both"
	@echo "  then use the iOS 'Scan QR Code' or 'Find on Network' flows."
