# Cloudlands Monorepo Makefile

INTENTD_DIR = packages/intentd
FE_DIR = packages/cloudlands-fe

SUBMODULES = $(INTENTD_DIR)

# Local dev stack configuration (overridable from the env/CLI, e.g. `make dev DEV_PORT=6000`).
# DEV_DATA_DIR is a dedicated, gitignored data dir so dev never touches the real one.
DEV_DATA_DIR ?= $(PWD)/.dev/intentd
DEV_PORT ?= 5180

# Transport for `run-intentd`. Defaults to `uds` (matching intentd's own `serve` default).
# Override to serve WSS/TCP for the iOS app, e.g. `make run-intentd LISTEN=both` or `LISTEN=tcp`.
LISTEN ?= uds

.PHONY: all ensure-submodules build build-intentd test test-intentd fmt clippy check clean dev dev-daemon run-intentd

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

dev: ensure-submodules ## Run the full FE+daemon dev stack (builds intentd, launches cloudlands-fe)
	@mkdir -p $(DEV_DATA_DIR)
	@echo "[dev] starting cloudlands-fe + intentd dev stack"
	@echo "[dev] intentd dev data dir: $(DEV_DATA_DIR) (UDS socket: $(DEV_DATA_DIR)/intentd.sock)"
	# `pnpm tauri dev` runs the FE's `beforeDevCommand` (`pnpm sidecar && pnpm dev`):
	# scripts/prepare-sidecar.mjs cargo-builds intentd (release) and stages it as the
	# Tauri sidecar, then src-tauri/src/daemon.rs spawns that bundled intentd over UDS on
	# app startup. So this one command builds intentd + launches the FE + spawns the daemon.
	# INTENTD_DATA_DIR is honored by both the FE's rpc client and the spawned daemon (which
	# inherits this env), so dev stays on the dedicated gitignored data dir. This target is
	# long-running and does not exit until you stop the dev app (Ctrl-C).
	@[ -d $(FE_DIR)/node_modules ] || (echo "[dev] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	cd $(FE_DIR) && INTENTD_DATA_DIR=$(DEV_DATA_DIR) pnpm tauri dev

dev-daemon: ensure-submodules ## Run intentd alone (UDS) against a dedicated dev data dir
	@mkdir -p $(DEV_DATA_DIR)
	@echo "[dev-daemon] intentd dev data dir: $(DEV_DATA_DIR) (UDS socket: $(DEV_DATA_DIR)/intentd.sock)"
	# intentd is UDS-only today (TCP/port deferred per §5.2): the dev socket + SQLite DB
	# live under $(DEV_DATA_DIR). DEV_PORT is reserved/forward-looking for the planned TCP
	# listener (§5.2) and the future Tauri/Svelte FE dev server; it is exported as
	# INTENTD_DEV_PORT now so downstream startup can pick it up without a Makefile change.
	INTENTD_DATA_DIR=$(DEV_DATA_DIR) INTENTD_DEV_PORT=$(DEV_PORT) \
		cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen uds

run-intentd: ensure-submodules ## Run intentd with default settings (real data dir; LISTEN=uds|tcp|both)
	# Runs intentd against its DEFAULT data dir (no dev override): Config::resolve picks
	# $$HOME/Library/Application Support/intentd on macOS for the socket + SQLite DB. This
	# target is long-running and does not exit until you stop it (Ctrl-C). LISTEN selects the
	# transport: `uds` (default) serves the local Unix socket; `tcp`/`both` also bring up
	# HTTPS+WSS on 0.0.0.0:5180 for the iOS app.
	cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen $(LISTEN)
