# Cloudlands Monorepo Makefile

INTENTD_DIR = packages/intentd

SUBMODULES = $(INTENTD_DIR)

.PHONY: all ensure-submodules build build-intentd test test-intentd fmt clippy check clean

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
