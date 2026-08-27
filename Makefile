# Intent Monorepo Makefile
#
# Four postures for local work:
#   1. `make dev-daemon` — default dev seat. intentd on an isolated data dir,
#      serving UDS + insecure TCP (`--insecure`) bound on 0.0.0.0:$(DEV_TCP_PORT)
#      (reachable from loopback and LAN). Pairs with `make dev-fe` (which pins
#      the FE to the dev seat's UDS socket) and with the iOS app (`make ios-info`).
#   2. `make release-daemon` — occasional "debug the release app with its own
#      state" seat. intentd on the real data dir, UDS-always and no
#      `--insecure`. No TCP port is bound unless the persisted
#      `server.wsApi.enabled` setting is true, in which case the secure WSS
#      listener binds `server.wsApi.port` (default 5181 — the same as
#      $(DEV_TCP_PORT)); if the dev seat already holds it, the bind failure
#      is non-fatal and UDS keeps serving.
#   3. `make dev-fe` / `make ios-open` / `make ios-info` — clients pointed at
#      the dev daemon.
#   4. `make dev-prod` — FE dev build connected to the already-running packaged
#      app daemon, showing the same workspaces and agents without starting a
#      second daemon against production state.
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
# DEV_TCP_PORT is the intentd TCP/WebSocket base port for the dev seat's
# insecure plain-ws:// listener. It serves the iOS app (`make ios-info`) and
# any client pointed at it explicitly via INTENTD_WS_URL — not the FE's
# default: the FE's zero-config default is UDS at the platform data-dir
# socket, honoring INTENTD_DATA_DIR (resolveBackendConfig in
# packages/cloudlands-fe/src/features/backend/main/backend-connection.ts),
# and `make dev-fe` pins the FE to the dev seat's UDS socket. The daemon
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
# Injectable platform seam for dev-prod's packaged-daemon socket default.
# An explicit INTENTD_SOCKET always takes precedence.
DEV_PROD_PLATFORM ?= $(shell uname -s)
# Export DEV_PORT so `make dev-fe` (and any recipe that shells out to the FE)
# actually sees the default/override in the child environment.
export DEV_PORT

# BRIDGE_PORT is the loopback port for `make uds-to-unauthed-wss-bridge` — the
# source-only dev shim that exposes the installed daemon's UDS socket as an
# UNAUTHENTICATED plain ws:// endpoint on 127.0.0.1. 51337 stays clear of 5181
# (held by the daemon's authed WSS for iOS). Overridable, e.g.
# `make uds-to-unauthed-wss-bridge BRIDGE_PORT=5182`.
BRIDGE_PORT ?= 51337
# Injectable platform seam for the bridge's installed-daemon socket default.
# An explicit INTENTD_SOCKET always takes precedence.
BRIDGE_PLATFORM ?= $(shell uname -s)

# Build-artifact GC (cargo-sweep). Rust target/ dirs grow without bound as
# deps and toolchains churn; `sweep` prunes artifacts older than SWEEP_DAYS
# days in this worktree's intentd, and `sweep-all` does the same across every
# sibling worktree under WORKSPACES_DIR (the per-worktree monorepo checkouts
# live at $(WORKSPACES_DIR)/<name>/monorepo). Both need cargo-sweep
# (`cargo install cargo-sweep`). Overridable, e.g. `make sweep SWEEP_DAYS=7`
# or `make sweep-all WORKSPACES_DIR=/elsewhere/workspaces`.
WORKSPACES_DIR ?= $(HOME)/intent/workspaces
SWEEP_DAYS ?= 3

# Parallelism caps shared by the Rust build/test/coverage targets
# (build-intentd, clippy, test-intentd, coverage-e2e, coverage-all).
# Negative values mean "logical CPUs minus N" (clamped to at least 1):
# cargo-nextest accepts them for test threads (NEXTEST_TEST_THREADS /
# --test-threads) and cargo for build jobs (CARGO_BUILD_JOBS / --jobs) —
# verified with the pinned cargo 1.96.0 (packages/intentd/rust-toolchain.toml)
# and nextest 0.9.143. The -2 defaults leave two
# cores of headroom so local runs do not saturate a laptop; override for
# full speed, e.g. `make test TEST_THREADS=num-cpus BUILD_JOBS=default`
# or `make coverage-all TEST_THREADS=num-cpus BUILD_JOBS=default`.
TEST_THREADS ?= -2
BUILD_JOBS ?= -2

# Node heap ceiling (MB) for the FE production build. The renderer's vite build
# OOMs at Node's default heap (~2-4 GB) and often still OOMs at 8 GB on this
# app; default to 16 GB. dist-mac exports this via NODE_OPTIONS so every child
# Node process (vite, tsc, electron-builder) gets the bump. Overridable, e.g.
# make dist-mac FE_BUILD_HEAP_MB=24576.
FE_BUILD_HEAP_MB ?= 16384

.PHONY: all help ensure-submodules ensure-intentd-submodule ensure-fe-submodule ensure-ios-submodule \
	update \
	build build-intentd build-sidecar test test-intentd coverage-e2e coverage-all \
	fmt clippy check clean clean-dev \
	sweep sweep-all seed-dev-providers seed-dev-workspaces dev-daemon release-daemon \
	run-intentd dev-ui dev-fe fe-launch run-fe-local uds-to-unauthed-wss-bridge dev dev-prod ios-open ios-info dist-mac

all: build

help: ## List documented targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# The iOS submodule is private and marked `update = none` in .gitmodules, so
# the generic `git submodule update --init` would silently skip it while
# claiming success. Its leg passes `--checkout` to override `update = none`,
# and fails soft (warning, not error) when the clone fails — e.g. no access to
# the private repo. GIT_TERMINAL_PROMPT=0 makes that failure fast and
# non-interactive (no `Username for https://github.com:` prompt when no
# credentials are cached); internal devs who want to authenticate
# interactively can use `make ensure-ios-submodule`, which still prompts.
ensure-submodules: ## Initialize any missing submodules — intentd, FE, iOS (idempotent; iOS is fail-soft)
	@for sm in $(SUBMODULES); do \
		if [ ! -e "$$sm/.git" ]; then \
			echo "[ensure-submodules] initializing $$sm"; \
			if [ "$$sm" = "$(IOS_DIR)" ]; then \
				GIT_TERMINAL_PROMPT=0 git submodule update --init --checkout --recursive "$$sm" \
					|| echo "[ensure-submodules] WARNING: could not initialize $$sm (private repo; skipping — check GitHub access if you need it)"; \
			else \
				git submodule update --init --recursive "$$sm" || exit 1; \
			fi; \
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
# (`dev-fe`, `build-sidecar`, `dev`), so backend-only workflows stay fast.
ensure-fe-submodule:
	@if [ ! -e "$(FE_DIR)/.git" ]; then \
		echo "[ensure-fe-submodule] initializing $(FE_DIR)"; \
		git submodule update --init --recursive "$(FE_DIR)"; \
	else \
		echo "[ensure-fe-submodule] $(FE_DIR) already initialized — leaving as-is"; \
	fi

# On-demand init for the iOS submodule — pulled in only by targets that need
# it (`ios-open`); backend-only workflows stay fast. `--checkout` overrides the
# `update = none` in .gitmodules (set so external clones skip this private
# repo) so it still initializes on machines with access.
ensure-ios-submodule:
	@if [ ! -e "$(IOS_DIR)/.git" ]; then \
		echo "[ensure-ios-submodule] initializing $(IOS_DIR)"; \
		git submodule update --init --checkout --recursive "$(IOS_DIR)"; \
	else \
		echo "[ensure-ios-submodule] $(IOS_DIR) already initialized — leaving as-is"; \
	fi

# Pull/rebase the monorepo branch and every submodule onto its configured
# remote branch (.gitmodules `branch = main` for all three today). Unlike
# `ensure-submodules` (init-if-missing only) and bare `git submodule update`
# (reset to the monorepo-recorded pin), this advances tips.
#
# Monorepo: fetch + pull --rebase --autostash on the current branch's upstream
# (fails if detached HEAD or no upstream).
# Each submodule: fetch, checkout the configured branch (creates a local
# tracking branch from origin/<branch> when detached/missing), then
# pull --rebase --autostash. Stops on the first conflict so you can fix and
# re-run. Does not commit submodule pointer bumps in the monorepo — after a
# successful update, `git status` will show dirty pins if you want a bump PR.
update: ## git pull --rebase monorepo + each submodule onto its .gitmodules branch
	@set -e; \
	if ! git rev-parse -q --verify HEAD >/dev/null; then \
		echo "[update] ERROR: monorepo has no HEAD"; \
		exit 1; \
	fi; \
	if [ "$$(git rev-parse --abbrev-ref HEAD)" = "HEAD" ]; then \
		echo "[update] ERROR: monorepo is detached HEAD — checkout a branch first (e.g. git checkout main)"; \
		exit 1; \
	fi; \
	if ! git rev-parse -q --abbrev-ref '@{u}' >/dev/null 2>&1; then \
		echo "[update] ERROR: monorepo branch '$$(git rev-parse --abbrev-ref HEAD)' has no upstream"; \
		exit 1; \
	fi; \
	echo "[update] monorepo $$(git rev-parse --abbrev-ref HEAD) ← $$(git rev-parse --abbrev-ref '@{u}') (pull --rebase --autostash)"; \
	git fetch --prune; \
	git pull --rebase --autostash; \
	git submodule sync --recursive; \
	git submodule update --init --recursive; \
	for sm in $(SUBMODULES); do \
		branch=$$(git config -f .gitmodules --get "submodule.$$sm.branch" 2>/dev/null || echo main); \
		if [ ! -e "$$sm/.git" ]; then \
			if [ "$$(git config -f .gitmodules --get "submodule.$$sm.update" 2>/dev/null)" = "none" ]; then \
				echo "[update] $$sm is not initialized (update = none) — skipping"; \
				continue; \
			fi; \
			echo "[update] ERROR: $$sm is not initialized after submodule update --init"; \
			exit 1; \
		fi; \
		echo "[update] $$sm → $$branch (pull --rebase --autostash)"; \
		git -C "$$sm" fetch --prune origin; \
		cur=$$(git -C "$$sm" rev-parse --abbrev-ref HEAD); \
		if [ "$$cur" = "HEAD" ] || [ "$$cur" != "$$branch" ]; then \
			if git -C "$$sm" show-ref --verify --quiet "refs/heads/$$branch"; then \
				git -C "$$sm" checkout "$$branch"; \
			elif git -C "$$sm" show-ref --verify --quiet "refs/remotes/origin/$$branch"; then \
				git -C "$$sm" checkout -B "$$branch" "origin/$$branch"; \
			else \
				echo "[update] ERROR: $$sm has no local or origin/$$branch"; \
				exit 1; \
			fi; \
		fi; \
		if ! git -C "$$sm" rev-parse -q --abbrev-ref '@{u}' >/dev/null 2>&1; then \
			git -C "$$sm" branch --set-upstream-to="origin/$$branch" "$$branch"; \
		fi; \
		git -C "$$sm" pull --rebase --autostash; \
	done; \
	echo "[update] done."; \
	echo "[update] monorepo $$(git rev-parse --abbrev-ref HEAD) @ $$(git rev-parse --short HEAD)"; \
	for sm in $(SUBMODULES); do \
		if [ -e "$$sm/.git" ]; then \
			echo "[update]   $$sm $$(git -C $$sm rev-parse --abbrev-ref HEAD) @ $$(git -C $$sm rev-parse --short HEAD)"; \
		else \
			echo "[update]   $$sm (not initialized — skipped)"; \
		fi; \
	done; \
	if ! git diff --quiet -- $(SUBMODULES) 2>/dev/null \
		|| ! git diff --cached --quiet -- $(SUBMODULES) 2>/dev/null; then \
		echo "[update] submodule pointers differ from the monorepo commit (expected after advancing tips)."; \
		echo "[update] stage and commit when you want a monorepo pin bump PR."; \
	fi

build: build-intentd ## Build the Rust workspace (packages/intentd)

build-intentd: ensure-intentd-submodule
	cd $(INTENTD_DIR) && cargo build --workspace --jobs $(BUILD_JOBS)

fmt: ensure-intentd-submodule ## cargo fmt --check
	cd $(INTENTD_DIR) && cargo fmt --check

clippy: ensure-intentd-submodule ## cargo clippy --all-targets -- -D warnings
	cd $(INTENTD_DIR) && cargo clippy --workspace --all-targets --jobs $(BUILD_JOBS) -- -D warnings

check: fmt clippy ## fmt + clippy

test: test-intentd ## Run the Rust test suite (cargo nextest, CPUs-2 by default; override TEST_THREADS/BUILD_JOBS)

# Runs under nextest so local full-suite runs pick up the same
# .config/nextest.toml protections CI uses (timing-serial test group,
# retries, slow-timeout). nextest does not run doctests; the workspace has
# none, so nothing is lost.
# Capped to $(TEST_THREADS) test threads / $(BUILD_JOBS) build jobs (CPUs-2
# by default) so a local run leaves CPU headroom; override for full speed,
# e.g. `make test TEST_THREADS=num-cpus BUILD_JOBS=default`.
test-intentd: ensure-intentd-submodule
	@cargo nextest --version >/dev/null 2>&1 || { \
		echo "[test-intentd] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
		exit 1; \
	}
	cd $(INTENTD_DIR) && cargo nextest run --workspace --build-jobs $(BUILD_JOBS) --test-threads $(TEST_THREADS)

# Local reproduction of the CI coverage jobs (packages/intentd
# .github/workflows/ci.yml: coverage-e2e / coverage-all), wrapping the same
# scripts CI runs. These are instrumented (cargo-llvm-cov) full-suite runs —
# slow, and deliberately NOT part of `make test`. The scripts install
# cargo-llvm-cov / cargo-nextest / llvm-tools if missing.
# NEXTEST_TEST_THREADS / CARGO_BUILD_JOBS carry the $(TEST_THREADS) /
# $(BUILD_JOBS) caps into the scripts so local coverage runs also leave CPU
# headroom by default (override e.g. TEST_THREADS=num-cpus BUILD_JOBS=default).
# Optional COVERAGE_FLOOR passes the scripts' positional fail-under-lines
# floor (CI uses 40), e.g. `make coverage-e2e COVERAGE_FLOOR=40`; when unset
# it expands to nothing and no floor is enforced locally.
coverage-e2e: ensure-intentd-submodule ## Reproduce CI e2e coverage locally (slow, instrumented; not part of make test)
	cd $(INTENTD_DIR) && NEXTEST_TEST_THREADS=$(TEST_THREADS) CARGO_BUILD_JOBS=$(BUILD_JOBS) \
		./scripts/coverage-e2e.sh $(COVERAGE_FLOOR)

coverage-all: ensure-intentd-submodule ## Reproduce CI full-workspace coverage locally (slow, instrumented; not part of make test)
	cd $(INTENTD_DIR) && NEXTEST_TEST_THREADS=$(TEST_THREADS) CARGO_BUILD_JOBS=$(BUILD_JOBS) \
		./scripts/coverage-all.sh $(COVERAGE_FLOOR)

clean: ## Remove cargo build artifacts (packages/intentd/target)
	rm -rf $(INTENTD_DIR)/target

clean-dev: ## Wipe the dev-seat state dir (.dev/)
	rm -rf "$(CURDIR)/.dev"

# `sweep` deliberately has no ensure-intentd-submodule prerequisite:
# initializing the submodule just to sweep a target/ dir that cannot exist yet
# would be overkill, so it short-circuits with a friendly no-op instead.
sweep: ## Prune intentd build artifacts older than $(SWEEP_DAYS) days (needs cargo-sweep)
	@cargo sweep --version >/dev/null 2>&1 || { \
		echo "[sweep] ERROR: cargo-sweep is not installed — run 'cargo install cargo-sweep'"; \
		exit 1; \
	}
	@if [ -d "$(INTENTD_DIR)/target" ]; then \
		cd $(INTENTD_DIR) && cargo sweep --time $(SWEEP_DAYS); \
	else \
		echo "[sweep] nothing to sweep — $(INTENTD_DIR)/target does not exist"; \
	fi

sweep-all: ## Sweep intentd build artifacts in every worktree under $(WORKSPACES_DIR)
	@cargo sweep --version >/dev/null 2>&1 || { \
		echo "[sweep-all] ERROR: cargo-sweep is not installed — run 'cargo install cargo-sweep'"; \
		exit 1; \
	}
	@for dir in $(WORKSPACES_DIR)/*/monorepo/$(INTENTD_DIR); do \
		[ -d "$$dir" ] || continue; \
		if [ -d "$$dir/target" ]; then \
			echo "[sweep-all] sweeping $$dir"; \
			(cd "$$dir" && cargo sweep --time $(SWEEP_DAYS)) \
				|| echo "[sweep-all] WARNING: sweep failed in $$dir — continuing"; \
		else \
			echo "[sweep-all] skipping $$dir (no target/ dir)"; \
		fi; \
	done

# Optional: inherit non-secret provider choices from the packaged seat into an
# empty $(DEV_DATA_DIR). Existing contents always win; missing prod config is a
# no-op. Not wired into `dev` / `dev-daemon` — run explicitly when you want it:
#   make seed-dev-providers
#   make seed-dev-providers DEV_DATA_DIR=...
seed-dev-providers: ## Seed provider prefs from packaged intentd into empty $(DEV_DATA_DIR)
	@python3 scripts/seed_dev_providers.py --dev-data-dir "$(DEV_DATA_DIR)"

# Optional: copy workspace rows from the packaged intentd SQLite DB into the
# dev seat. Creates/migrates $(DEV_DATA_DIR)/intentd.db via `intentd doctor`
# when missing, then inserts Active (default) workspace metadata only — not
# agents, notes, messages, or assets. Skips ids already present; does not
# touch the on-disk worktrees (paths point at the shared ~/intent/workspaces).
# Not wired into `dev` / `dev-daemon` — run explicitly, ideally with the dev
# daemon stopped so WAL/locking stays quiet:
#   make seed-dev-workspaces
#   make seed-dev-workspaces SEED_INCLUDE_ARCHIVED=1
#   make seed-dev-workspaces SEED_SOURCE_DB=/path/to/intentd.db
SEED_INCLUDE_ARCHIVED ?= 0
seed-dev-workspaces: ensure-intentd-submodule ## Seed workspace rows from packaged intentd.db into $(DEV_DATA_DIR)
	@mkdir -p "$(DEV_DATA_DIR)"
	@if [ ! -f "$(DEV_DATA_DIR)/intentd.db" ]; then \
		echo "[seed-dev-workspaces] initializing empty dev DB via intentd doctor..."; \
		INTENTD_DATA_DIR="$(DEV_DATA_DIR)" \
			cargo run -q -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- doctor >/dev/null; \
	fi
	@python3 scripts/seed_dev_workspaces.py --dev-data-dir "$(DEV_DATA_DIR)" \
		$(if $(filter 1,$(SEED_INCLUDE_ARCHIVED)),--include-archived) \
		$(if $(SEED_SOURCE_DB),--source "$(SEED_SOURCE_DB)")

dev-daemon: ensure-intentd-submodule ## Dev seat: intentd on isolated data dir, UDS + insecure TCP on $(DEV_TCP_PORT)
	@mkdir -p "$(DEV_DATA_DIR)"
	@echo "[dev-daemon] intentd dev data dir: $(DEV_DATA_DIR) (UDS: $(DEV_DATA_DIR)/intentd.sock, TCP: 0.0.0.0:$(DEV_TCP_PORT))"
	@echo "[dev-daemon] INTENTD_LEGACY_IMPORT_ROOTS=\"\" (legacy import disabled for the dev seat)"
	@echo "[dev-daemon] WARNING: --insecure binds ws:// on 0.0.0.0:$(DEV_TCP_PORT) with no TLS and no auth — anyone on your LAN can reach it. Only run on a trusted network."
	# `--insecure` serves the local UDS socket AND a plain ws:// listener on
	# 0.0.0.0:$(DEV_TCP_PORT) with no TLS and no bearer-token auth — serves
	# the iOS simulator/hardware seat and any explicit INTENTD_WS_URL client;
	# the FE pairs over UDS via `make dev-fe`.
	# The daemon fails fast if $(DEV_TCP_PORT) is already bound.
	# INTENTD_LEGACY_IMPORT_ROOTS="" disables the legacy import hook: the dev
	# seat starts with a fresh $(DEV_DATA_DIR) DB, so first boot would otherwise
	# scan the shared ~/intent/workspaces root.
	INTENTD_DATA_DIR="$(DEV_DATA_DIR)" INTENTD_TCP_PORT=$(DEV_TCP_PORT) \
		INTENTD_LEGACY_IMPORT_ROOTS="" \
		cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve --insecure

release-daemon: ensure-intentd-submodule ## Release-state debug seat: intentd on real data dir, UDS-always, no --insecure
	# Runs intentd against its DEFAULT data dir (no dev override): Config::resolve picks
	# $$HOME/Library/Application Support/intentd on macOS for the socket + SQLite DB.
	# The UDS listener always serves; the secure WSS listener starts only when
	# the persisted `server.wsApi.enabled` setting is true (config.toml or the
	# runtime toggle), on `server.wsApi.port` (5181 unless INTENTD_TCP_PORT is
	# set). A WSS bind failure at boot is non-fatal (e.g. when `make dev-daemon`
	# already holds 5181): the daemon logs a warning and keeps serving UDS;
	# toggle `server.wsApi.enabled` to retry. No `--insecure`: the WSS listener,
	# when enabled, serves wss:// with TLS + bearer auth as the packaged app
	# expects.
	cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve

run-intentd: ## DEPRECATED alias for release-daemon
	@echo "[run-intentd] DEPRECATED: use 'make release-daemon' (or 'make dev-daemon' for the dev seat)."
	@$(MAKE) release-daemon

dev-ui: ensure-fe-submodule ## Run the fast browser-only frontend UI preview
	@[ -d $(FE_DIR)/node_modules ] || (echo "[dev-ui] installing FE deps (corepack pnpm install)" && cd $(FE_DIR) && corepack pnpm install --frozen-lockfile)
	@script=$$(node -e 'const scripts = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts || {}; if (scripts["dev:ui"]) process.stdout.write("dev:ui"); else if (scripts["dev:web"]) process.stdout.write("dev:web"); else process.exit(1)' "$(FE_DIR)/package.json") || { \
		echo "[dev-ui] ERROR: frontend package.json defines neither dev:ui nor dev:web"; \
		exit 1; \
	}; \
	if [ "$$script" = "dev:ui" ]; then \
		echo "[dev-ui] using optimized browser-only dev:ui preview"; \
	else \
		echo "[dev-ui] dev:ui is unavailable on this frontend pin; falling back to browser-only dev:web"; \
	fi; \
	cd $(FE_DIR) && corepack pnpm run "$$script"

dev-fe: ensure-fe-submodule ## Run the FE dev stack against dev-daemon's UDS socket (two-terminal pair)
	# Two-terminal counterpart of `make dev-daemon`: launches only the FE dev
	# stack (vite + Electron) pinned to the dev seat's isolated daemon via
	# INTENTD_SOCKET=$(DEV_DATA_DIR)/intentd.sock — the highest-precedence
	# transport override (resolveBackendConfig in
	# packages/cloudlands-fe/src/features/backend/main/backend-connection.ts).
	# The pin is needed because the FE's zero-config default is UDS at the
	# PLATFORM data-dir socket (honoring INTENTD_DATA_DIR) — i.e. the installed
	# daemon, not the dev seat. The FE does NOT spawn intentd; start
	# `make dev-daemon` in another terminal first, or use `make dev` for the
	# one-command sidecar mode. Other clients:
	#   `make run-fe-local` → dev FE against the installed daemon's UDS socket.
	#   `make dev-prod`     → same, with the packaged app's live daemon.
	# Long-running; does not exit until you stop it (Ctrl-C).
	# The -S pre-check is skipped on Windows (MSYS/MINGW/CYGWIN), where the
	# daemon socket path is not a filesystem entry — the win32 FE derives a
	# named pipe from it and reports the connection failure itself (same
	# rationale as run-fe-local's is_windows guard below).
	@is_windows=0; \
	case "$$(uname -s)" in \
		MINGW*|MSYS*|CYGWIN*) is_windows=1 ;; \
	esac; \
	if [ "$$is_windows" -eq 0 ] && [ ! -S "$(DEV_DATA_DIR)/intentd.sock" ]; then \
		echo "[dev-fe] ERROR: no dev daemon socket at $(DEV_DATA_DIR)/intentd.sock"; \
		echo "[dev-fe] Start the dev seat first in another terminal: make dev-daemon"; \
		exit 1; \
	fi
	@INTENTD_SOCKET="$(DEV_DATA_DIR)/intentd.sock" $(MAKE) fe-launch

# Internal FE-launch helper shared by dev-fe and dev-prod (not listed in
# `make help`): pnpm-install-if-missing guard + `pnpm run dev`, inheriting the
# caller's INTENTD_SOCKET (and the exported DEV_PORT) from the environment.
fe-launch: ensure-fe-submodule
	@[ -d $(FE_DIR)/node_modules ] || (echo "[fe-launch] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	cd $(FE_DIR) && pnpm run dev

run-fe-local: ensure-fe-submodule ## Run the FE against the locally INSTALLED intentd's UDS socket
	# Like `dev-fe`, but points the FE at the installed Intent daemon's default
	# socket path (<data_dir>/intentd.sock, per directories::ProjectDirs):
	#   macOS   → $$HOME/Library/Application Support/intentd/intentd.sock
	#   Linux   → $${XDG_DATA_HOME:-$$HOME/.local/share}/intentd/intentd.sock
	#   Windows → $$APPDATA/intentd/data/intentd.sock — not a filesystem entry:
	#             the win32 FE derives the named pipe \\.\pipe\intentd-<hash16>
	#             from the resolved socket path (intentd-pipe-name.ts; requires
	#             an fe checkout that includes acbb0408), so the existence
	#             pre-check is skipped there and the FE reports the connection
	#             failure itself if no daemon is running.
	# An INTENTD_SOCKET already set in the caller's environment wins over the
	# platform default. Setting INTENTD_SOCKET is the highest-precedence
	# transport override (resolveBackendConfig in
	# packages/cloudlands-fe/src/features/backend/main/backend-connection.ts)
	# and any transport override also disables sidecar spawning
	# (intentd-spawn-policy.ts) — so only the daemon connection changes; the
	# dev FE keeps its own DEV_PORT-namespaced userData dir.
	# Long-running; does not exit until you stop it (Ctrl-C).
	@[ -d $(FE_DIR)/node_modules ] || (echo "[run-fe-local] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	@sock="$$INTENTD_SOCKET"; \
	is_windows=0; \
	case "$$(uname -s)" in \
		MINGW*|MSYS*|CYGWIN*) is_windows=1 ;; \
	esac; \
	if [ -n "$$sock" ]; then \
		echo "[run-fe-local] using caller-provided INTENTD_SOCKET"; \
	else \
		case "$$(uname -s)" in \
			Darwin) sock="$$HOME/Library/Application Support/intentd/intentd.sock" ;; \
			Linux) sock="$${XDG_DATA_HOME:-$$HOME/.local/share}/intentd/intentd.sock" ;; \
			MINGW*|MSYS*|CYGWIN*) sock="$$APPDATA/intentd/data/intentd.sock" ;; \
			*) echo "[run-fe-local] ERROR: unsupported platform $$(uname -s) — no known installed-daemon socket path."; \
			   echo "[run-fe-local] Point the FE at a reachable daemon instead, e.g.: cd $(FE_DIR) && INTENTD_WS_URL=ws://host:5181/ws pnpm run dev"; \
			   exit 1 ;; \
		esac; \
	fi; \
	if [ "$$is_windows" -eq 0 ] && [ ! -S "$$sock" ]; then \
		echo "[run-fe-local] ERROR: no UDS socket at '$$sock' — is the installed Intent daemon running?"; \
		exit 1; \
	fi; \
	echo "[run-fe-local] INTENTD_SOCKET=$$sock"; \
	cd $(FE_DIR) && INTENTD_SOCKET="$$sock" pnpm run dev

uds-to-unauthed-wss-bridge: ## Expose the installed intentd's UDS as an UNAUTHENTICATED plain ws:// endpoint on 127.0.0.1:$(BRIDGE_PORT)
	# Runs scripts/uds-ws-bridge.mjs (zero-dependency, Node >= 20): each WS
	# client on ws://127.0.0.1:$(BRIDGE_PORT)/ws gets its own dedicated UDS
	# connection to the installed daemon, with 1:1 JSON-RPC frame translation
	# (docs/PROTOCOL.md). The daemon's own auth posture — authed WSS on 5181
	# for iOS — is untouched; despite the target name, the endpoint is plain
	# ws:// (no TLS). Socket resolution matches the script's own
	# defaultSocketPath(): an explicit INTENTD_SOCKET always takes precedence,
	# then an INTENTD_DATA_DIR-derived path ($$INTENTD_DATA_DIR/intentd.sock),
	# then the platform default (BRIDGE_PLATFORM is the injectable `uname -s`
	# seam). The target errors if the resolved socket does not exist.
	# Long-running; does not exit until you stop it (Ctrl-C).
	@socket="$$INTENTD_SOCKET"; \
		if [ -z "$$socket" ] && [ -n "$$INTENTD_DATA_DIR" ]; then \
			socket="$$INTENTD_DATA_DIR/intentd.sock"; \
		fi; \
		if [ -z "$$socket" ]; then \
			case "$(BRIDGE_PLATFORM)" in \
				Darwin) socket="$$HOME/Library/Application Support/intentd/intentd.sock" ;; \
				Linux) socket="$${XDG_DATA_HOME:-$$HOME/.local/share}/intentd/intentd.sock" ;; \
				*) echo "[uds-to-unauthed-wss-bridge] ERROR: unsupported platform '$(BRIDGE_PLATFORM)'; set INTENTD_SOCKET explicitly."; \
				   exit 1 ;; \
			esac; \
		fi; \
		if [ ! -S "$$socket" ]; then \
			echo "[uds-to-unauthed-wss-bridge] ERROR: daemon socket not found at $$socket"; \
			echo "[uds-to-unauthed-wss-bridge] Start the installed Intent daemon first, or set INTENTD_SOCKET to its socket path."; \
			exit 1; \
		fi; \
		echo "[uds-to-unauthed-wss-bridge] Bridging installed daemon socket: $$socket"; \
		echo "[uds-to-unauthed-wss-bridge] WARNING: this exposes the FULL UNAUTHENTICATED daemon API as plain ws:// on 127.0.0.1:$(BRIDGE_PORT) — no TLS, no auth. Loopback-only by design; any process on this machine can drive the daemon while the bridge runs."; \
		INTENTD_SOCKET="$$socket" BRIDGE_PORT=$(BRIDGE_PORT) node scripts/uds-ws-bridge.mjs

build-sidecar: ensure-intentd-submodule ensure-fe-submodule ## Build intentd release + stage the sidecar binary for FE packaging
	# Builds the intentd release binary (may take several minutes on first build) and
	# runs the FE copy-sidecar script to stage it for electron-builder. This is the
	# prerequisite for `pnpm run dist:mac` in packages/cloudlands-fe.
	# Ensure FE node_modules first so a fresh checkout does not fail when any
	# staging helper (or a future copy-sidecar dep) expects an installed tree —
	# and so `dist-mac` (which depends on this target) does not install after
	# the sidecar step.
	@[ -d $(FE_DIR)/node_modules ] || (echo "[build-sidecar] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	@echo "[build-sidecar] Building intentd release binary..."
	cd $(INTENTD_DIR) && cargo build --release --workspace
	@echo "[build-sidecar] Staging sidecar binary for FE packaging..."
	cd $(FE_DIR) && node scripts/copy-sidecar.cjs

dist-mac: update ## Pull/rebase monorepo+submodules, then package Intent.app into $(FE_DIR)/dist-electron
	# End-to-end macOS packaging. Always starts with `update` (pull --rebase
	# monorepo + each submodule onto its .gitmodules branch) so the package
	# reflects current tips, not a stale pin. Then `build-sidecar` ensures FE
	# deps, builds the intentd release binary, and stages it under
	# $(FE_DIR)/resources/sidecar; finally the FE's dist:mac script runs
	# (build -> ensure-native-deps -> copy-sidecar -> electron-builder --mac).
	# Output artifacts (arm64 dmg + zip, each containing Intent.app) land in
	# $(FE_DIR)/dist-electron.
	#
	# `build-sidecar` is invoked via a nested $(MAKE) (not a peer prerequisite)
	# so it cannot race `update` under make -j.
	#
	# Code signing + notarization run only when the Apple credentials are present
	# in the environment (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID);
	# without them electron-builder produces an unsigned/ad-hoc build. See
	# packages/cloudlands-fe/electron-builder.yml.
	#
	# NODE_OPTIONS raises Node's heap ceiling to $(FE_BUILD_HEAP_MB) MB so the
	# renderer's vite build does not OOM; it is inherited by every child Node
	# process. A pre-existing NODE_OPTIONS in the environment is preserved and
	# wins (Node applies the last --max-old-space-size), so callers can override.
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[dist-mac] ERROR: requires macOS (electron-builder --mac). Detected $$(uname -s)."; \
		exit 1; \
	fi
	@$(MAKE) build-sidecar
	@echo "[dist-mac] Packaging Intent.app (electron-builder --mac, Node heap $(FE_BUILD_HEAP_MB)MB)..."
	cd $(FE_DIR) && NODE_OPTIONS="--max-old-space-size=$(FE_BUILD_HEAP_MB) $$NODE_OPTIONS" CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run dist:mac
	@echo "[dist-mac] Done. Artifacts in $(FE_DIR)/dist-electron"

dev: ensure-intentd-submodule ensure-fe-submodule ## One-command dev: launch the FE with intentd as a sidecar (INTENTD_SIDECAR=1)
	# Launches the FE with sidecar spawning enabled (INTENTD_SIDECAR=1). The FE will
	# spawn and supervise its own intentd binary, giving a one-command dev stack.
	# Always runs the intentd release build first so the sidecar reflects the
	# current sources; cargo's freshness check makes it a fast no-op when nothing
	# changed. This is an alternative to the two-terminal flow (dev-daemon +
	# dev-fe); use whichever fits your workflow.
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
	#   INTENTD_LEGACY_IMPORT_ROOTS="" — disables the legacy import hook: the dev
	#     seat starts with a fresh $(DEV_DATA_DIR) DB, so the sidecar's first boot
	#     would otherwise scan the shared ~/intent/workspaces root.
	@[ -d $(FE_DIR)/node_modules ] || (echo "[dev] installing FE deps (pnpm install)" && cd $(FE_DIR) && pnpm install)
	@echo "[dev] Building intentd release binary (no-op if already fresh)..."
	cd $(INTENTD_DIR) && cargo build --release --workspace
	@mkdir -p "$(DEV_DATA_DIR)"
	@echo "[dev] Launching FE with sidecar mode enabled (INTENTD_SIDECAR=1)"
	@echo "[dev]   INTENTD_BIN=$(CURDIR)/$(INTENTD_DIR)/target/release/intentd"
	@echo "[dev]   INTENTD_DATA_DIR=$(DEV_DATA_DIR) (UDS: $(DEV_DATA_DIR)/intentd.sock)"
	@echo "[dev]   INTENTD_LEGACY_IMPORT_ROOTS=\"\" (legacy import disabled for the dev seat)"
	cd $(FE_DIR) && INTENTD_SIDECAR=1 \
		INTENTD_BIN="$(CURDIR)/$(INTENTD_DIR)/target/release/intentd" \
		INTENTD_DATA_DIR="$(DEV_DATA_DIR)" \
		INTENTD_LEGACY_IMPORT_ROOTS="" \
		pnpm run dev

dev-prod: ensure-fe-submodule ## Run the dev FE against the packaged app's live daemon and production state
	@socket="$$INTENTD_SOCKET"; \
		if [ -z "$$socket" ]; then \
			case "$(DEV_PROD_PLATFORM)" in \
				Darwin) socket="$$HOME/Library/Application Support/intentd/intentd.sock" ;; \
				Linux) socket="$${XDG_DATA_HOME:-$$HOME/.local/share}/intentd/intentd.sock" ;; \
				*) echo "[dev-prod] ERROR: unsupported platform '$(DEV_PROD_PLATFORM)'; set INTENTD_SOCKET explicitly."; \
				   exit 1 ;; \
			esac; \
		fi; \
		if [ ! -S "$$socket" ]; then \
			echo "[dev-prod] ERROR: production daemon socket not found at $$socket"; \
			echo "[dev-prod] Start the packaged app first, or set INTENTD_SOCKET to its socket path."; \
			exit 1; \
		fi; \
		echo "[dev-prod] Launching dev FE against production daemon: $$socket"; \
		INTENTD_SOCKET="$$socket" $(MAKE) fe-launch

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
	@echo "  For the secure pairing posture (TLS + bearer auth + QR pairing),"
	@echo "  run intentd WITHOUT '--insecure' and enable the WSS listener via the"
	@echo "  'server.wsApi.enabled' setting (config.toml or runtime toggle), e.g."
	@echo "    cargo run -p intentd --manifest-path $(INTENTD_DIR)/Cargo.toml -- serve"
	@echo "  then use the iOS 'Scan QR Code' or 'Manual Connection' flows."
