# Cloudlands Monorepo Makefile

INTENTD_DIR = packages/intentd

SUBMODULES = $(INTENTD_DIR)

# Local dev stack configuration (overridable from the env/CLI, e.g. `make dev DEV_PORT=6000`).
# DEV_DATA_DIR is a dedicated, gitignored data dir so dev never touches the real one.
DEV_DATA_DIR ?= $(PWD)/.dev/intentd
DEV_PORT ?= 5180

.PHONY: all ensure-submodules build build-intentd test test-intentd fmt clippy check clean dev

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

dev: ensure-submodules ## Run the local dev stack against a dedicated dev data dir
	@mkdir -p $(DEV_DATA_DIR)
	@echo "[dev] intentd dev data dir: $(DEV_DATA_DIR) (UDS socket: $(DEV_DATA_DIR)/intentd.sock)"
	# intentd is UDS-only today (TCP/port deferred per §5.2): the dev socket + SQLite DB
	# live under $(DEV_DATA_DIR). DEV_PORT is reserved/forward-looking for the planned TCP
	# listener (§5.2) and the future Tauri/Svelte FE dev server; it is exported as
	# INTENTD_DEV_PORT now so downstream startup can pick it up without a Makefile change.
	# TODO: when TCP (§5.2) and the Tauri/Svelte FE dev server land, start them here
	# (alongside intentd) so `make dev` ultimately runs the whole stack.
	INTENTD_DATA_DIR=$(DEV_DATA_DIR) INTENTD_DEV_PORT=$(DEV_PORT) \
		cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --listen uds
