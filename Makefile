# Cloudlands Monorepo Makefile

INTENTD_DIR = packages/intentd
FE_DIR = packages/cloudlands-fe

SUBMODULES = $(INTENTD_DIR)

# Local dev stack configuration (overridable from the env/CLI, e.g. `make dev DEV_PORT=6000`).
# DEV_DATA_DIR is a dedicated, gitignored data dir so dev never touches the real one.
DEV_DATA_DIR ?= $(PWD)/.dev/intentd
DEV_PORT ?= 5180

# Transport for `run-intentd`. Defaults to `both` (HTTPS+WSS on 0.0.0.0:5180 for the iOS app,
# plus the local UDS socket). Override for UDS-only, e.g. `make run-intentd LISTEN=uds` (or `tcp`).
LISTEN ?= both

.PHONY: all ensure-submodules build build-intentd test test-intentd fmt clippy check clean dev-daemon run-intentd run-fe

all: build

ensure-submodules:
	@for sm in $(SUBMODULES); do \
		if [ ! -e "$$sm/.git" ]; then \
			echo "[ensure-submodules] initializing $$sm"; \
			git submodule update --init --recursive "$$sm"; \
		else \
			echo "[ensure-submodules] $$sm already initialized — leaving as-is"; \
		fi; \
	done

build: build-intentd

build-intentd: ensure-submodules
	cd $(INTENTD_DIR) && cargo build --workspace

fmt: ensure-submodules
	cd $(INTENTD_DIR) && cargo fmt --check

clippy: ensure-submodules
	cd $(INTENTD_DIR) && cargo clippy --workspace -- -D warnings

check: fmt clippy

test: test-intentd

test-intentd: ensure-submodules
	cd $(INTENTD_DIR) && cargo test --workspace

clean:
	rm -rf $(INTENTD_DIR)/target

dev-daemon: ensure-submodules ## Run intentd alone (UDS) against a dedicated dev data dir
	@mkdir -p $(DEV_DATA_DIR)
	@echo "[dev-daemon] intentd dev data dir: $(DEV_DATA_DIR) (UDS socket: $(DEV_DATA_DIR)/intentd.sock)"
	# intentd is UDS-only today (TCP/port deferred per §5.2): the dev socket + SQLite DB
	# live under $(DEV_DATA_DIR). DEV_PORT is reserved/forward-looking for the planned TCP
	# listener (§5.2) and the future Tauri/Svelte FE dev server; it is exported as
	# INTENTD_DEV_PORT now so downstream startup can pick it up without a Makefile change.
	INTENTD_DATA_DIR=$(DEV_DATA_DIR) INTENTD_DEV_PORT=$(DEV_PORT) \
		cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen uds

run-intentd: ensure-submodules ## Run intentd with default settings (real data dir; LISTEN=both|uds|tcp)
	# Runs intentd against its DEFAULT data dir (no dev override): Config::resolve picks
	# $$HOME/Library/Application Support/intentd on macOS for the socket + SQLite DB. This
	# target is long-running and does not exit until you stop it (Ctrl-C). LISTEN selects the
	# transport: `both` (default) serves the local UDS socket AND HTTPS+WSS on 0.0.0.0:5180
	# for the iOS app; override with `LISTEN=uds` (UDS only) or `LISTEN=tcp` (HTTPS+WSS only).
	cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen $(LISTEN)

run-fe: ensure-submodules ## Run the Electron + SvelteKit FE alone (packages/cloudlands-fe)
	# Launches only the FE dev stack (vite + Electron). The FE does NOT spawn intentd;
	# it connects to an already-running daemon, so pair this with `make run-intentd`
	# (both use the default socket: ~/Library/Application Support/intentd/intentd.sock).
	# Point the FE at a different daemon by setting INTENTD_SOCKET — make exports it to
	# the FE automatically, so e.g. `INTENTD_SOCKET=$(DEV_DATA_DIR)/intentd.sock make run-fe`
	# targets `make dev-daemon`. Left unset by default so the FE uses its default socket.
	# Long-running; does not exit until you stop it (Ctrl-C).
	# Always runs `pnpm install` first so FE deps stay synced to the lockfile.
	cd $(FE_DIR) && pnpm install && pnpm run dev
