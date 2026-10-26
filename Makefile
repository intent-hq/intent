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
#      listener binds `server.wsApi.port` (default 5181, outside the derived
#      $(DEV_TCP_PORT) range); if another process holds it, the bind failure
#      is non-fatal and UDS keeps serving.
#   3. `make dev-fe` / `make ios-open` / `make ios-info` — clients pointed at
#      the dev daemon.
#   4. `make dev-prod` — FE dev build connected to the already-running packaged
#      app daemon, showing the same workspaces and agents without starting a
#      second daemon against production state.
#
# `make help` lists every documented target (any recipe whose header ends in
# `## <description>`).

.DEFAULT_GOAL := all

# Reject before running ANY recipe, including parallel/mixed gate + coverage
# goals. Coverage needs its own debug/instrumentation settings.
COMPACT ?= 0
export COMPACT
ifeq ($(COMPACT),1)
ifneq ($(filter coverage-%,$(MAKECMDGOALS)),)
$(error COMPACT=1 is incompatible with coverage targets; rerun coverage with COMPACT=0)
endif
endif
# Expand only for compact compiler recipes; ordinary invocations stay identical.
COMPACT_CARGO = $(if $(filter 1,$(COMPACT)),python3 "$(CURDIR)/scripts/resumable_nextest.py" --compact-cargo)

INTENTD_DIR = packages/intentd
FE_DIR = packages/cloudlands-fe
IOS_DIR = packages/ios

# FE dependency freshness guard shared by every target that needs an installed
# frontend tree. pnpm writes the lockfile it installed from to
# node_modules/.pnpm/lock.yaml, so the tree is stale when that copy is missing
# or no longer byte-identical to pnpm-lock.yaml. Use as `$(FE_DEPS_FRESH) || (...)`.
FE_DEPS_FRESH = [ -f $(FE_DIR)/node_modules/.pnpm/lock.yaml ] && cmp -s $(FE_DIR)/pnpm-lock.yaml $(FE_DIR)/node_modules/.pnpm/lock.yaml
FE_DEPS_INSTALL_MSG = installing/refreshing FE deps (lockfile changed or node_modules missing)

# cargo install may place subcommands outside PATH when cargo itself comes from
# a distro package. Make every recipe discover the effective install bin dir.
CARGO_BIN_DIR ?= $(or $(CARGO_INSTALL_ROOT),$(CARGO_HOME),$(HOME)/.cargo)/bin
# Route every Rust recipe through the rustup toolchain pinned by
# packages/intentd/rust-toolchain.toml, even when another cargo (Homebrew,
# distro) is first on the caller's PATH. `rustup which` resolves the pin from
# $(INTENTD_DIR) without triggering a toolchain download (RUSTUP_AUTO_INSTALL=0
# guards rustup >= 1.28 auto-install). When rustup or the toolchain is absent
# this expands to empty and behavior is unchanged. cargo-nextest and other
# installed subcommands stay discoverable via $(CARGO_BIN_DIR).
#
# Resolution is deferred (recursive `=`), not parse-time (`:=`): on a fresh
# clone $(INTENTD_DIR) is an empty submodule dir until
# `ensure-intentd-submodule` runs, so a parse-time probe leaves the FIRST
# fmt/clippy/check of a clone unpinned. Make rebuilds the exported environment
# per recipe, so a deferred probe runs after prerequisites and sees the
# populated submodule. The probe requires rust-toolchain.toml to be readable —
# without it `rustup which` silently answers with the caller's DEFAULT
# toolchain, which is exactly the unpinned cargo this export exists to bypass.
# ORIG_PATH snapshots the caller's PATH so the recursive export never
# references itself, and $(addsuffix) keeps the export to a single
# $(RUSTUP_CARGO) expansion — one ~10ms `rustup which` per recipe, which no
# cargo invocation notices. An $(eval) memo does not help: an assignment made
# while make builds a recipe's environment does not outlive that expansion.
ORIG_PATH := $(PATH)
RUSTUP_CARGO = $(shell cd $(INTENTD_DIR) 2>/dev/null && [ -r rust-toolchain.toml ] && RUSTUP_AUTO_INSTALL=0 rustup which cargo 2>/dev/null)
export PATH = $(addsuffix :,$(dir $(RUSTUP_CARGO)))$(CARGO_BIN_DIR):$(ORIG_PATH)

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
# Resolve one stable, free port block for this worktree when a target first
# expands a port variable. The memoized result keeps non-listener targets such
# as doctor, bootstrap-dev-host, and sandbox-stop independent of port tooling
# and availability. The `?=` assignments preserve exact overrides.
DEV_PORT_VALUES =
resolve_dev_ports = $(if $(strip $(DEV_PORT_VALUES)),,$(eval DEV_PORT_VALUES := $(shell DEV_PORT= DEV_TCP_PORT= BRIDGE_PORT= CDP_PORT= scripts/dev-ports.sh || printf '__DEV_PORTS_ERROR__=1\n')))$(if $(filter __DEV_PORTS_ERROR__=1,$(DEV_PORT_VALUES)),$(error Could not resolve development ports; see the dev-ports error above))
dev_port_value = $(call resolve_dev_ports)$(patsubst $(1)=%,%,$(filter $(1)=%,$(DEV_PORT_VALUES)))
DEV_PORT ?= $(call dev_port_value,DEV_PORT)
DEV_TCP_PORT ?= $(call dev_port_value,DEV_TCP_PORT)
SANDBOX_READY_TIMEOUT ?= 60
SANDBOX_WARM_TIMEOUT ?= 60
INTENTD_PROFILE ?= dev
# Injectable platform seam for dev-prod's packaged-daemon socket default.
# An explicit INTENTD_SOCKET always takes precedence.
DEV_PROD_PLATFORM ?= $(shell uname -s)
# BRIDGE_PORT is the loopback port for `make uds-to-unauthed-wss-bridge` — the
# source-only dev shim that exposes the installed daemon's UDS socket as an
# UNAUTHENTICATED plain ws:// endpoint on 127.0.0.1. Its derived default stays
# clear of 5181 (held by the daemon's authed WSS for iOS). Overridable, e.g.
# `make uds-to-unauthed-wss-bridge BRIDGE_PORT=5182`.
BRIDGE_PORT ?= $(call dev_port_value,BRIDGE_PORT)
CDP_PORT ?= $(call dev_port_value,CDP_PORT)
# Injectable platform seam for the bridge's installed-daemon socket default.
# An explicit INTENTD_SOCKET always takes precedence.
BRIDGE_PLATFORM ?= $(shell uname -s)

.PHONY: check-app-ui-targets check-doc-links check-note-truncated-read-contract check-suggested-prompts-contract check-agent-worker-contract test-transfer-selection-contract check-transfer-selection-contract check-backend-keychain-contract ports status consumer-checks docs-check check-protocol-catalog check-mcp-bindings mcp-bindings-doc check-makefile-targets check-protocol-field-parity check-rulesets event-catalog-check shipped-in release-status rpc
ports: ## Print this worktree's resolved development ports
	@set -- .dev/sandbox/*.json; if [ -e "$$1" ]; then \
		echo "[ports] Note: these ports are for the next start; read running ports from 'make sandbox-status' or .dev/sandbox/<mode>.json." >&2; \
	fi
	@printf '%s\n' "DEV_PORT=$(DEV_PORT)" "DEV_TCP_PORT=$(DEV_TCP_PORT)" "BRIDGE_PORT=$(BRIDGE_PORT)" "CDP_PORT=$(CDP_PORT)"

status: ## Show host, ports, sandboxes, and submodule/PR state (STATUS_JSON=1 for JSON; DEV_STATUS_PORT_TIMEOUT=<seconds> bounds the port probe and DEV_STATUS_PROBE_TIMEOUT=<seconds> every other probe, default 10 each)
	@DEV_PORT="$(DEV_PORT)" DEV_TCP_PORT="$(DEV_TCP_PORT)" BRIDGE_PORT="$(BRIDGE_PORT)" CDP_PORT="$(CDP_PORT)" \
		STATUS_JSON="$(STATUS_JSON)" scripts/dev-status.sh

# Every monorepo consumer check the ci.yml docs-check job runs, as one runner
# that keeps going past a failure and ends with a per-check table naming the
# monorepo file(s) to update. The upstream (intentd / cloudlands-fe) consumer
# job calls the same script, so the two lists cannot drift. Advisory checks:
# CONSUMER_CHECKS_ADVISORY="<targets>"; CONSUMER_CHECKS_CONTEXT=upstream adds
# the fix-order line. See scripts/consumer-checks.sh for the mechanism.
consumer-checks: ## Run every monorepo consumer check (docs, catalogs, field parity) and print a per-check fix-path summary
	@MAKE="$(MAKE)" scripts/consumer-checks.sh

test-transfer-selection-contract: ensure-intentd-submodule ensure-fe-submodule ## Regenerate the transfer-selection contract and feed fresh responses to ModelPicker (requires both pinned harnesses and installed FE deps)
	@node scripts/test-transfer-selection-contract.mjs

check-transfer-selection-contract: ## Validate transfer-selection fixtures and provenance without compiling components
	@node scripts/check-transfer-selection-contract.mjs

check-app-ui-targets: ## Check Assistant navigation against the frontend registry
	@node scripts/check-app-ui-targets.mjs

check-doc-links: ## Check agent-facing Markdown links, paths, and heading anchors (CI: repo-hygiene without submodules, docs-check with the component pins)
	@node --test scripts/check-doc-links.test.mjs
	@node scripts/check-doc-links.mjs

check-note-truncated-read-contract: ## Validate the truncated note read vectors (no component runtime proof)
	@node --test docs/protocol/fixtures/notes/*.test.mjs

check-suggested-prompts-contract: ## Validate the shared suggested-prompts block cases and any adopted component copies (no component runtime proof)
	@node --test scripts/suggested-prompts-contract.test.mjs
	@node scripts/suggested-prompts-contract.mjs check

check-agent-worker-contract: ## Validate synthetic worker observation goldens, model and regression sensitivity
	@node scripts/agent-worker-contract.mjs
	@node --test scripts/agent-worker-contract.test.mjs scripts/agent-worker-contract-sensitivity.test.mjs

check-backend-keychain-contract: ## Validate canonical backend Keychain fixtures and any adopted component mirrors without compilation
	@node scripts/backend-keychain-contract.mjs check

docs-check: event-catalog-check check-mcp-bindings ## Check documented development targets, knobs, remote-host guidance, protocol-doc line lengths, and protocol table cell counts
	@scripts/docs-check.sh
	@node scripts/check-doc-line-length.mjs
	@node --test scripts/check-doc-line-length.test.mjs
	@node --test scripts/lib/markdown-tables.test.mjs
	@node scripts/check-doc-table-cells.mjs
	@node --test scripts/check-doc-table-cells.test.mjs
	@node --test docs/protocol/fixtures/scripts/monitors.test.mjs docs/protocol/fixtures/scripts/contract.test.mjs
	@node --test docs/protocol/fixtures/submission-correlation/contract.test.mjs

check-protocol-catalog: ## Check docs/protocol method catalog against methods/*.md and intentd's catalog.rs
	@node scripts/check-protocol-catalog.mjs

# The MCP `ws.*` binding surface is documented only by the help-text constants
# in intentd's tools.rs; docs/protocol/methods/mcp-bindings.md is the generated
# signature index, and prose mentions under docs/protocol/ must match it.
# The help text is read from the packages/intentd checkout (the run names the
# checkout and the recorded pin, and warns when they differ); PINNED=1 reads it
# from the recorded gitlink through git objects instead.
PINNED ?=
check-mcp-bindings: ## Check docs/protocol ws.* MCP binding index and prose against intentd's help text (PINNED=1 reads the recorded gitlink instead of the checkout)
	@node scripts/check-mcp-bindings.mjs $(if $(PINNED),--pinned)

mcp-bindings-doc: ## Regenerate docs/protocol/methods/mcp-bindings.md from intentd's help text (PINNED=1 reads the recorded gitlink instead of the checkout)
	@node scripts/check-mcp-bindings.mjs --write $(if $(PINNED),--pinned)

# Every `cargo ... -p <crate> --test <name>` this Makefile runs inside
# INTENTD_DIR must exist at the pinned intentd gitlink; a Makefile change that
# depends on an unmerged intentd PR must wait for the auto-bump.
# CHECK_MAKEFILE_TARGETS_GITLINK=<rev> checks another intentd commit instead
# (the upstream consumer-checks job passes HEAD, the caller's own head).
CHECK_MAKEFILE_TARGETS_GITLINK ?=
check-makefile-targets: ensure-intentd-submodule ## Check Makefile-referenced intentd crates and --test targets exist at the pinned gitlink
	@node scripts/check-makefile-targets.mjs --intentd-dir "$(INTENTD_DIR)" $(if $(CHECK_MAKEFILE_TARGETS_GITLINK),--gitlink $(CHECK_MAKEFILE_TARGETS_GITLINK))

# Every wire field an intentd row struct emits (AgentLite, Workspace) must be
# present in the cloudlands-fe type that consumes it, or listed in the script's
# ignore manifest with a reason; a stale ignore entry is a warning, not a failure.
# When a component checkout is off its recorded pin, a missing field is compared
# again against PARITY_BASE (default origin/main; empty when CI is set and not
# false/0) the way
# the upstream monorepo-consumer-checks job compares a component PR against
# monorepo main; a field that passes there is a pin-drift warning, not an error.
# PARITY_BASE= keeps the strict comparison against this worktree's docs and pins.
PARITY_BASE ?= $(if $(filter-out false 0,$(CI)),,origin/main)
check-protocol-field-parity: ensure-intentd-submodule ensure-fe-submodule ## Check intentd row struct fields against the cloudlands-fe types that consume them (PARITY_BASE=<ref> for off-pin checkouts, default origin/main)
	@node scripts/check-protocol-field-parity.mjs --intentd-dir "$(INTENTD_DIR)" --fe-dir "$(FE_DIR)" $(if $(PARITY_BASE),--base "$(PARITY_BASE)")$(CHECK_DEFER_PARITY)

# The live main-branch rulesets of intent, intentd and cloudlands-fe (required
# CI Gate check, thread resolution, merge queue) are snapshotted under
# .github/rulesets/; a silent edit on GitHub shows up as drift. UPDATE=1
# accepts the live rules into the snapshots; a token avoids the unauthenticated
# rate limit. With RULESET_ADMIN_TOKEN set (administration read on the three
# repositories) the rulesets' bypass actors are compared with
# .github/rulesets/*.bypass.json too; without it they are skipped with a warning.
check-rulesets: ## Check live GitHub main branch rulesets against .github/rulesets/*.json (UPDATE=1 rewrites them; RULESET_ADMIN_TOKEN adds bypass actors)
	@node scripts/check-rulesets.mjs $(if $(UPDATE),--update)

# The event-type catalog is vendored on three surfaces: the intentd golden
# (source of truth), the protocol sidecar docs/protocol/event-types.json, and
# the iOS test fixture. A copy whose submodule is not initialized is skipped.
event-catalog-check: ## Check the protocol event-type sidecar against the intentd golden, the iOS fixture, and 06-events.md
	@node scripts/check-event-catalog.mjs

# Release tracking: which cloudlands-releases alpha first carries one or more
# merged commits. Pass one pair as COMPONENT=... SHA=..., or several as
# PAIRS="intentd:<sha> cloudlands-fe:<sha>" (space-separated component:sha
# tokens, forwarded as positional pairs; the tag must carry every pair). The
# script exits 3 for "not shipped yet", 5 when additionally the newest
# cloudlands-fe Release Alpha run looks stalled (a job queued longer than
# SHIPPED_IN_STALL_MINUTES, default 30; 0 disables the probe), and 4 for a
# transient GitHub failure (rate limit, 5xx, network) worth retrying (make
# reports them as `Error 3` / `Error 5` / `Error 4`); background hooks should
# invoke scripts/shipped-in.sh directly so they can branch on those codes.
# `LIMIT=N` widens the scan window past the newest 10 releases.
shipped-in: ## Print the first cloudlands-releases tag carrying COMPONENT=intentd|cloudlands-fe SHA=<commit>, or every pair in PAIRS="intentd:<sha> cloudlands-fe:<sha>" (script exit 3 = not yet, 5 = not yet and Release Alpha run stalled, 4 = transient gh failure)
	@set -- $(if $(COMPONENT)$(SHA),"$(COMPONENT)" "$(SHA)",); \
	for pair in $(PAIRS); do \
		case "$$pair" in \
			*:*) set -- "$$@" "$${pair%%:*}" "$${pair#*:}" ;; \
			*) echo "shipped-in: PAIRS entries must be <component>:<sha>, got '$$pair'" >&2; exit 2 ;; \
		esac; \
	done; \
	scripts/shipped-in.sh "$$@" $(if $(LIMIT),--limit "$(LIMIT)",)

# Read-only release train snapshot for intentd and cloudlands-fe; every lookup
# is fail-soft (a failed one prints `unavailable`). See docs/RELEASING.md →
# Where to look.
release-status: ## Print the release train: latest tags, channel versions, fe daemon pin, release PRs with CI and merge-queue state, merge queue head, unshipped commits, last auto-cut decision, last auto-pin run, runner overrides (STATUS_JSON=1 for JSON; NO_LOGS=1 skips the slow run-log fetch)
	@STATUS_JSON="$(STATUS_JSON)" scripts/release-status.sh $(if $(NO_LOGS),--no-logs,)

# Build-artifact GC (cargo-sweep). Rust target/ dirs grow without bound as
# deps and toolchains churn; `sweep` prunes artifacts older than SWEEP_DAYS
# days in this worktree's intentd, and `sweep-all` does the same across every
# sibling worktree under WORKSPACES_DIR (the per-worktree monorepo checkouts
# live at $(WORKSPACES_DIR)/<name>/monorepo). Both need cargo-sweep
# (`cargo install cargo-sweep --locked`). Overridable, e.g. `make sweep SWEEP_DAYS=7`
# or `make sweep-all WORKSPACES_DIR=/elsewhere/workspaces`.
WORKSPACES_DIR ?= $(HOME)/intent/workspaces
SWEEP_DAYS ?= 3

# Parallelism caps shared by the Rust build/test/coverage targets
# (build-intentd, clippy, test-intentd, test-changed, test-select, coverage-changed,
# coverage-e2e, coverage-all).
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

# Progress rendering for the Rust gate targets. Agents run these as saved
# command-mode ws.script entries, which are PTY-backed, so nextest and cargo
# see an interactive stderr and redraw their progress bars into the captured
# buffer (one full-suite run produced ~530 KB of cursor-control sequences
# and overflowed an agent's context). Default to line-oriented output; a
# human at a terminal can restore the bars with
# `make test NEXTEST_SHOW_PROGRESS=bar CARGO_TERM_PROGRESS_WHEN=auto`.
# CI already sets CI=true, under which both tools are non-interactive anyway.
gate test test-intentd test-changed test-select coverage-changed coverage-e2e coverage-all list-tests: export NEXTEST_SHOW_PROGRESS ?= none
gate check clippy check-windows lint-sources build-intentd test test-intentd test-changed test-select coverage-changed coverage-e2e coverage-all list-tests: export CARGO_TERM_PROGRESS_WHEN ?= never
# Pagers on the same targets. A saved-script PTY has no keyboard, so any
# git/gh step that pages to `less` stalls forever waiting for a keypress.
# nextest ignores PAGER (only --no-pager / user config disable its paging),
# hence the explicit --no-pager on list-tests.
gate check clippy check-windows lint-sources build-intentd test test-intentd test-changed test-select coverage-changed coverage-e2e coverage-all list-tests: export PAGER ?= cat
gate check clippy check-windows lint-sources build-intentd test test-intentd test-changed test-select coverage-changed coverage-e2e coverage-all list-tests: export GIT_PAGER ?= cat

# Test time limits on the local test targets. Hang-guard budgets in intentd
# tests scale with INTENTD_TEST_TIMEOUT_MULTIPLIER (intentd-test-support's
# test_timeout; fixed_deadline_lint enforces it). Coverage CI already runs at
# 3 (coverage-e2e.sh, coverage-all.sh, changed-tests.sh --instrumented, hence
# coverage-changed); at 1 a busy shared dev host timed out three correct tests
# at their 15 s budget across two make test-changed runs, each passing alone.
# The local targets therefore default to 3 too. An explicit value, from the
# environment or the make command line, wins unchanged, including
# `make test INTENTD_TEST_TIMEOUT_MULTIPLIER=1` for the strict budgets.
# `gate` gets it through its recursive `make test`; its check/clippy steps and
# other targets keep the caller's environment. The runner prints the value and
# keys resume records by the effective stretch, so passes never mix across
# multipliers.
test test-intentd test-changed test-select: export INTENTD_TEST_TIMEOUT_MULTIPLIER ?= 3

# Resumable local test runs are opt-in. Records are keyed by the complete
# monorepo + intentd worktree state and kept outside the checkout. Each invocation
# prints its own attempt path, including fully resumed runs; see CONTRIBUTING.md.
RESUME ?= 0
GATE_FORCE ?= 0
# NO_FAIL_FAST=1 keeps nextest running past a known flake so the remaining
# tests still run and are recorded (the run still exits non-zero).
NO_FAIL_FAST ?= 0
GATE_CACHE_DIR ?= $(HOME)/.cache/intent/gate-runs
# HERMETIC=1 runs test / test-changed / test-select the way CI's runners see the machine:
# intentd's scripts/test-without-provider-clis.sh hides every provider CLI
# (codex, claude, opencode, ...) in a private mount namespace, so a test that
# only passes because the host has them fails here instead of on CI
# (intentd#2462). Linux only; needs bwrap. Node stays visible, as on CI: the
# gates' fixture checks need it, so HIDE_NODE=1 is refused here (run the
# script directly around cargo nextest for a Node-free run). Resume records
# are kept separate per mode. The wrapper's discovery self-check builds with
# $(BUILD_JOBS) jobs.
HERMETIC ?= 0
ifneq ($(filter-out 0 1,$(HERMETIC)),)
$(error HERMETIC must be 0 or 1, got '$(HERMETIC)')
endif
HERMETIC_WRAP := $(if $(filter 1,$(HERMETIC)),env INTENT_GATE_HERMETIC=1 CARGO_BUILD_JOBS=$(BUILD_JOBS) bash "$(INTENTD_DIR)/scripts/test-without-provider-clis.sh",)
HERMETIC_RUNNER_WRAP := $(if $(filter 1,$(HERMETIC)),env INTENT_GATE_HERMETIC=1 CARGO_BUILD_JOBS=$(BUILD_JOBS) bash "$$INTENTD_DIR/scripts/test-without-provider-clis.sh" ,)
# Fail before planning or building when HERMETIC=1 cannot run here, and say
# which mode the run uses (also under DRY_RUN=1).
HERMETIC_PREFLIGHT = if [ "$(HERMETIC)" = 1 ]; then \
		[ "$$(uname -s 2>/dev/null)" = Linux ] || { echo "[$@] ERROR: HERMETIC=1 is Linux only (it hides provider CLIs in a bwrap mount namespace)" >&2; exit 1; }; \
		command -v bwrap >/dev/null 2>&1 || { echo "[$@] ERROR: HERMETIC=1 needs bwrap; run make doctor (Debian/Ubuntu: sudo apt-get install bubblewrap)" >&2; exit 1; }; \
		[ "$${HIDE_NODE:-0}" != 1 ] || { echo "[$@] ERROR: HIDE_NODE=1 is not supported with HERMETIC=1: the gates' callback and transfer fixture checks need Node. For a Node-free run use $(INTENTD_DIR)/scripts/test-without-provider-clis.sh around cargo nextest" >&2; exit 1; }; \
		echo "[$@] HERMETIC=1: tests run with every provider CLI hidden ($(INTENTD_DIR)/scripts/test-without-provider-clis.sh)"; \
	fi

# Node heap ceiling (MB) for the FE production build. The renderer's vite build
# OOMs at Node's default heap (~2-4 GB) and often still OOMs at 8 GB on this
# app; default to 16 GB. dist-mac exports this via NODE_OPTIONS so every child
# Node process (vite, tsc, electron-builder) gets the bump. Overridable, e.g.
# make dist-mac FE_BUILD_HEAP_MB=24576.
FE_BUILD_HEAP_MB ?= 16384

.PHONY: all help doctor bootstrap-dev-host ensure-submodules ensure-intentd-submodule ensure-fe-submodule ensure-ios-submodule \
	ensure-fe-toolchain \
	update \
	build build-intentd build-sidecar gate test test-intentd test-scripts test-scripts-changed test-changed test-select list-tests coverage-changed coverage-e2e coverage-all \
	fmt clippy check-windows lint-sources lint-repo-slug lint-event-types lint-fixed-sleeps lint-raw-child lint-shell-sleeps lint-shell lint-workflows bash3 check clean clean-dev \
	sweep sweep-all seed-dev-providers seed-dev-workspaces dev-daemon release-daemon \
	run-intentd dev-ui dev-sandbox-ui dev-sandbox-app dev-sandbox-stack dev-fe fe-launch \
	sandbox-status sandbox-stop \
	run-fe-local uds-to-unauthed-wss-bridge dev-web-live dev dev-prod \
	ios-open ios-info ios-build-ios ios-build-visionos ios-test dist-mac

all: build

help: ## List documented targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '\nLocal Rust gates: COMPACT=1 make gate (also check, test, test-changed, test-select; Python 3.10+).\n'
	@printf '  Opt-in dev/test debug=0 and CARGO_INCREMENTAL=0; caller Rust flags retain precedence.\n'
	@printf '  Default: COMPACT=0. Compact/default resume records are separate; coverage rejects COMPACT=1.\n'
	@printf '  See CONTRIBUTING.md for debugging tradeoffs and the component mixed-goal boundary.\n'

doctor: ## Report missing intentd + cloudlands-fe development prerequisites
	@scripts/bootstrap-dev-host.sh --check

bootstrap-dev-host: ## Install missing development prerequisites (BOOTSTRAP_YES=1 for non-interactive use; BOOTSTRAP_COVERAGE=1 adds cargo-llvm-cov + llvm-tools-preview)
	@scripts/bootstrap-dev-host.sh $(if $(filter 1 yes true,$(BOOTSTRAP_YES)),--yes,) $(if $(filter 1 yes true,$(BOOTSTRAP_COVERAGE)),--coverage,)

# Frontend-toolchain preflight for the targets that shell out to
# `corepack pnpm`. Fails fast with doctor's [missing] wording plus
# `run: make bootstrap-dev-host` instead of a mid-run "corepack: command not
# found". Port-independent like doctor: it must never expand DEV_PORT. It reads
# the frontend package.json for the pinned pnpm version, so it must not race
# the submodule checkout under `make -j`: order it after ensure-fe-submodule
# rather than relying on the sibling prerequisite lists, which make is free to
# run in parallel.
ensure-fe-toolchain: ensure-fe-submodule
	@scripts/bootstrap-dev-host.sh --check-frontend

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
	cd $(INTENTD_DIR) && bash "$(CURDIR)/scripts/with-sccache.sh" cargo build --workspace --jobs $(BUILD_JOBS)

fmt: ensure-intentd-submodule ## cargo fmt --check
	cd "$(INTENTD_DIR)" && cargo fmt --check

clippy: ensure-intentd-submodule ## cargo clippy --all-targets -- -D warnings
	cd "$(INTENTD_DIR)" && $(COMPACT_CARGO) cargo clippy --workspace --all-targets --jobs $(BUILD_JOBS) -- -D warnings

# The Windows GNU target's production `cargo check` and `--all-targets`
# Clippy, from Linux or macOS: the local twin of intentd CI's PR-time
# `windows-cross-lint` job (the check covers production arms that test
# fixture features hide from Clippy). Run it before queueing a
# change that touches cfg(unix) / cfg(windows) code: the Linux `clippy` never
# compiles that code for Windows, and the queue's native `windows-lint` would
# eject the PR an hour later (intentd#2672). Not part of `check`: it needs a
# MinGW-w64 C compiler for the target's build scripts. The rustup target is
# added on demand (no privilege needed); the compiler must be installed.
WINDOWS_LINT_TARGET := x86_64-pc-windows-gnu
check-windows: ensure-intentd-submodule ## cargo check + clippy for Windows (x86_64-pc-windows-gnu) like CI's windows-cross-lint; needs MinGW-w64
	@command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || { \
		echo "make check-windows: x86_64-w64-mingw32-gcc not found. Install MinGW-w64:" >&2; \
		echo "  Debian/Ubuntu: sudo apt-get install gcc-mingw-w64-x86-64" >&2; \
		echo "  macOS:         brew install mingw-w64 (untested; CI covers Linux only)" >&2; \
		exit 2; }
	@cd "$(INTENTD_DIR)" && RUSTUP_AUTO_INSTALL=0 rustup which cargo >/dev/null 2>&1 || { echo "make check-windows: the rustup toolchain pinned in $(INTENTD_DIR)/rust-toolchain.toml is not installed (run make bootstrap-dev-host)" >&2; exit 2; }
	@cd "$(INTENTD_DIR)" && { RUSTUP_AUTO_INSTALL=0 rustup target list --installed | grep -qx '$(WINDOWS_LINT_TARGET)' || RUSTUP_AUTO_INSTALL=0 rustup target add $(WINDOWS_LINT_TARGET); } || { echo "make check-windows: could not add the $(WINDOWS_LINT_TARGET) rustup target to the pinned toolchain (offline?); run: cd $(INTENTD_DIR) && rustup target add $(WINDOWS_LINT_TARGET)" >&2; exit 2; }
	cd "$(INTENTD_DIR)" && $(COMPACT_CARGO) cargo check --workspace --target $(WINDOWS_LINT_TARGET) --jobs $(BUILD_JOBS)
	cd "$(INTENTD_DIR)" && $(COMPACT_CARGO) cargo clippy --workspace --all-targets --target $(WINDOWS_LINT_TARGET) --jobs $(BUILD_JOBS) -- -D warnings

# Source lints are discovered by convention: every `tests/*_lint.rs` in any
# intentd crate is a cargo test target whose name ends in `_lint`, and cargo's
# native --test glob selects all of them across the workspace. Adding a lint
# in intentd therefore needs no change here. Mirrors the intentd `check` CI
# job so local gates match CI. Arm the shared test-only caller policy at the
# child boundary, including compact mode; do not export it to build/dev targets.
lint-sources: ensure-intentd-submodule ## Run every intentd source lint (tests/*_lint.rs in any intentd crate)
	cd "$(INTENTD_DIR)" && bash scripts/with-test-policy.sh $(COMPACT_CARGO) cargo test --workspace --test '*_lint' --jobs $(BUILD_JOBS)

# Deprecated aliases of lint-sources, kept for one release so existing local
# scripts keep working; each now runs the full source-lint set.
lint-repo-slug: lint-sources ## Deprecated alias of lint-sources
lint-event-types: lint-sources ## Deprecated alias of lint-sources
lint-fixed-sleeps: lint-sources ## Deprecated alias of lint-sources
lint-raw-child: lint-sources ## Deprecated alias of lint-sources

# Fixed sleeps in scripts/*.test.sh must carry a `# timing-guard: <reason>`
# marker or be grandfathered in scripts/fixed-sleep-baseline.txt, which only
# ratchets down. Pure shell + awk; needs no submodule.
lint-shell-sleeps: ## Check scripts/*.test.sh fixed sleeps are marked or baselined
	@scripts/lint-fixed-sleeps.sh

# shellcheck over scripts/*.sh (the *.test.sh suites match the same glob); -x
# follows `source` lines into the sibling scripts. Rule policy lives in the
# repo-root .shellcheckrc. Not part of `make check` yet: dev hosts that have not
# re-run `make bootstrap-dev-host` lack the binary, so this fails fast with
# doctor's [missing] wording instead of falling back to npx.
lint-shell: ## Run shellcheck over scripts/*.sh (needs shellcheck; make bootstrap-dev-host installs it)
	@command -v shellcheck >/dev/null 2>&1 || { \
		echo "[missing]  shellcheck: required by make lint-shell; run make bootstrap-dev-host" >&2; exit 1; }
	@shellcheck -x scripts/*.sh

# actionlint over .github/workflows (with its shellcheck pass over run:
# scripts) at the pin in scripts/bootstrap-dev-host.sh. Main is kept clean, so
# any finding is new; CI's workflow-lint job runs this. Not part of `make
# check`, for the same missing-binary reason as lint-shell.
lint-workflows: ## Run the pinned actionlint over .github/workflows (needs actionlint + shellcheck; make bootstrap-dev-host installs them)
	@bash scripts/lint-workflows.sh

# Bash 3.2 for the scripts/*.test.sh compatibility passes (stock macOS bash is
# 3.2). CI builds it only for the merge queue, so build it once here and the
# suites' shared lookup (scripts/find-bash3.sh) finds this cache on its own.
# The no-op check pins the full 3.2.57 version so a pin change rebuilds.
# Export BASH3_CACHE_DIR (absolute) to move it; the suites read the same variable.
BASH3_CACHE_DIR ?= $(or $(XDG_CACHE_HOME),$(HOME)/.cache)/intent-bash3

bash3: ## Build Bash 3.2 for the shell suites' 3.2 pass into BASH3_CACHE_DIR (default ~/.cache/intent-bash3; no-op once built; make bootstrap-dev-host installs its build tools)
	@if "$(BASH3_CACHE_DIR)/bash" -c '[ "$${BASH_VERSION%%(*}" = 3.2.57 ]' >/dev/null 2>&1; then \
		echo "bash3: $(BASH3_CACHE_DIR)/bash is already built"; \
	elif /bin/bash -c '[ "$${BASH_VERSINFO[0]}" -eq 3 ]' >/dev/null 2>&1; then \
		echo "bash3: /bin/bash is already Bash 3 (stock macOS); the suites use it, nothing to build"; \
	else \
		echo "bash3: building Bash 3.2.57 into $(BASH3_CACHE_DIR) (a few minutes)"; \
		env -u GITHUB_ENV bash scripts/install-ci-bash3.sh "$(BASH3_CACHE_DIR)"; \
	fi

RUST_CHECK_TARGETS := check-makefile-targets check-protocol-field-parity lint-shell-sleeps fmt clippy lint-sources

.PHONY: check-callback-fixture
check-callback-fixture: ensure-intentd-submodule ## Validate the callback test fixture offline (explicit, or prepared from a ready ~/.cache entry) before Rust gates
	@python3 scripts/check_watch_capacity.py --quiet
	@python3 scripts/resumable_nextest.py --check-callback-fixture "$(INTENTD_DIR)"

# Ordering each leaf, not merely check itself, prevents -j from compiling
# before fixture validation. Standalone make check needs no callback fixture.
ifneq ($(filter gate,$(MAKECMDGOALS)),)
$(RUST_CHECK_TARGETS): | check-callback-fixture
endif

.PHONY: check-transfer-fixture
check-transfer-fixture: ## Preflight canonical transfer fixtures before Rust gates
	@python3 scripts/check_watch_capacity.py --quiet
	@python3 scripts/resumable_nextest.py --check-transfer-fixture "$(CURDIR)"

# Order every check leaf so parallel explicit full-test goals cannot compile first.
# Standalone check, changed dry runs and unrelated selections need no fixtures.
ifneq ($(filter test test-intentd gate,$(MAKECMDGOALS)),)
$(RUST_CHECK_TARGETS): | check-transfer-fixture
endif

# Under make check / make gate a failed check-protocol-field-parity is recorded
# instead of stopping make, so fmt, clippy and the source lints still run; the
# check recipe then reports it and fails, and gate stops before the tests.
# Standalone make check-protocol-field-parity / consumer-checks fail directly.
# The record is named after this make process ($$PPID of $(shell)), so
# concurrent runs in one worktree cannot clear each other's failure; it is
# reset before parity in case a crashed run with a reused PID left one behind.
ifneq ($(filter check gate,$(MAKECMDGOALS)),)
CHECK_DEFERRED := $(or $(TMPDIR),/tmp)/intent-check-deferred.$(shell echo $$PPID)
CHECK_DEFER_PARITY = || { echo check-protocol-field-parity >> "$(CHECK_DEFERRED)" && echo "make check: check-protocol-field-parity failed; continuing with the remaining check steps, check fails at the end" >&2; }
check-protocol-field-parity: | check-deferred-reset
endif

.PHONY: check-deferred-reset
check-deferred-reset:
	@[ -z "$(CHECK_DEFERRED)" ] || rm -f "$(CHECK_DEFERRED)"

check: $(RUST_CHECK_TARGETS) ## Makefile target check + protocol field parity + shell sleep lint + fmt + clippy + source lints (a parity failure is reported at the end)
	@if [ -s "$(CHECK_DEFERRED)" ]; then \
		failed=$$(tr '\n' ' ' < "$(CHECK_DEFERRED)"); rm -f "$(CHECK_DEFERRED)"; \
		echo "make check: FAILED: $${failed}(output above); every other check step passed" >&2; \
		exit 1; \
	fi; rm -f "$(CHECK_DEFERRED)"

gate: check | check-callback-fixture check-transfer-fixture ## Run all local Rust gates (fmt, clippy, source lints, then nextest)
	@$(MAKE) --no-print-directory test

test: test-intentd ## Run Rust tests; after interruption use RESUME=1 (GATE_FORCE=1 runs all, NO_FAIL_FAST=1 continues past failures, HERMETIC=1 hides provider CLIs like CI)

test-scripts: ## Run the Python script unit tests (Python 3.11+, no submodules needed)
	python3 -S -B -m unittest -v scripts.test_resumable_nextest scripts.test_compact_gate scripts.test_rust_test_policy scripts.test_seed_dev_providers scripts.test_seed_dev_workspaces scripts.test_cleanup_prereleases scripts.test_script_test_target scripts.test_test_select_target scripts.test_watch_capacity

# The script checks CI would run for this change (lint-shell, the ci.yml
# shell-tests suites, node:test for changed scripts/*.mjs); see CONTRIBUTING.md.
test-scripts-changed: ## Run CI's script checks for files changed vs BASE (default origin/main; DRY_RUN=1 prints the plan)
	@BASE="$(BASE)" DRY_RUN="$(DRY_RUN)" bash scripts/changed-script-tests.sh

# Runs under nextest so local full-suite runs pick up the same
# .config/nextest.toml protections CI uses (timing-serial test group,
# retries, slow-timeout). nextest does not run doctests; the workspace has
# none, so nothing is lost.
# Capped to $(TEST_THREADS) test threads / $(BUILD_JOBS) build jobs (CPUs-2
# by default) so a local run leaves CPU headroom; override for full speed,
# e.g. `make test TEST_THREADS=num-cpus BUILD_JOBS=default`. Progress bars
# are off by default (see NEXTEST_SHOW_PROGRESS / CARGO_TERM_PROGRESS_WHEN
# above); `make test NEXTEST_SHOW_PROGRESS=bar` restores nextest's.
# Apply the shared caller policy before the runner fingerprints resume evidence.
# Changed/coverage scripts apply this same wrapper at their test boundaries.
# test-select reuses this exact invocation, so its knobs cannot drift from test.
RUST_TEST_RUNNER = bash "$(INTENTD_DIR)/scripts/with-test-policy.sh" $(HERMETIC_WRAP) \
	python3 scripts/resumable_nextest.py --repo-root "$(CURDIR)" --intentd-dir "$(INTENTD_DIR)" \
	--cache-dir "$(GATE_CACHE_DIR)" --resume "$(RESUME)" --force "$(GATE_FORCE)" \
	--no-fail-fast "$(NO_FAIL_FAST)" --build-jobs "$(BUILD_JOBS)" --test-threads "$(TEST_THREADS)"
test-intentd: ensure-intentd-submodule | check-transfer-fixture
	@python3 scripts/check_watch_capacity.py --quiet
	@cargo nextest --version >/dev/null 2>&1 || { \
		echo "[test-intentd] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
		exit 1; \
	}
	@$(HERMETIC_PREFLIGHT)
	@$(RUST_TEST_RUNNER)

# Pre-queue gate when the full suite is impractical: runs only the nextest
# targets the intentd checkout changed vs BASE (default origin/main). The
# selection is intentd's $(INTENTD_DIR)/scripts/changed-tests.sh (see its
# header for the path → crate mapping; the same script drives intentd's
# pull_request `coverage-changed` job), executed through
# scripts/resumable_nextest.py, so the run writes the same gate-run record as
# `make test` (per-attempt run.json, coverage.json and available JUnit under
# GATE_CACHE_DIR; record path printed even on a fully resumed invocation).
# RESUME=1 / GATE_FORCE=1 apply unchanged. Reverse dependencies are
# propagated in full only from intent-core (to every crate depending on it,
# directly or transitively) and otherwise only in the narrow cases the
# script's header lists, so `make test` stays the complete gate. Like test and
# test-select it stretches test time limits 3x unless the caller sets
# INTENTD_TEST_TIMEOUT_MULTIPLIER (see its export above).
# The script exits 3 when a build-wide file (Cargo.toml/Cargo.lock, nextest
# config, toolchain) changed; the target then announces the fallback and runs
# the full `make test` (skipped under DRY_RUN=1, which only prints the plan).
# The runner line names its paths as "$VAR" references that the script's eval
# expands, so apostrophes or spaces in CURDIR/GATE_CACHE_DIR never reach a
# nested quote; the script execs the runner from this directory, so the
# relative scripts/ path resolves against the monorepo root.
test-changed: ensure-intentd-submodule ## Run only the Rust tests the intentd branch changed vs BASE, recording the run (RESUME=1 resumes, NO_FAIL_FAST=1 continues past failures, HERMETIC=1 hides provider CLIs like CI, DRY_RUN=1 prints the plan)
	@if [ -z "$(DRY_RUN)" ] || [ "$(DRY_RUN)" = 0 ]; then python3 scripts/check_watch_capacity.py --quiet; fi
	@cargo nextest --version >/dev/null 2>&1 || { \
		echo "[test-changed] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
		exit 1; \
	}
	@if [ -n "$(DRY_RUN)" ] && [ "$(DRY_RUN)" != 0 ] && [ "$(NO_FAIL_FAST)" = 1 ]; then \
		echo "[test-changed] NO_FAIL_FAST=1: nextest runs with --no-fail-fast"; \
	fi
	@$(HERMETIC_PREFLIGHT)
	@INTENTD_DIR="$(INTENTD_DIR)" BASE="$(BASE)" DRY_RUN="$(DRY_RUN)" \
		BUILD_JOBS="$(BUILD_JOBS)" TEST_THREADS="$(TEST_THREADS)" \
		GATE_REPO_ROOT="$(CURDIR)" GATE_CACHE_DIR="$(GATE_CACHE_DIR)" \
		RESUME="$(RESUME)" GATE_FORCE="$(GATE_FORCE)" NO_FAIL_FAST="$(NO_FAIL_FAST)" \
		NEXTEST_RUNNER='$(HERMETIC_RUNNER_WRAP)python3 scripts/resumable_nextest.py --repo-root "$$GATE_REPO_ROOT" --intentd-dir "$$INTENTD_DIR" --cache-dir "$$GATE_CACHE_DIR" --resume "$$RESUME" --force "$$GATE_FORCE" --no-fail-fast "$$NO_FAIL_FAST"' \
		"$(INTENTD_DIR)/scripts/changed-tests.sh"; status=$$?; \
	if [ "$$status" -ne 3 ]; then exit "$$status"; fi; \
	if [ -n "$(DRY_RUN)" ] && [ "$(DRY_RUN)" != 0 ]; then \
		echo "[test-changed] DRY_RUN: would fall back to the full 'make test'"; exit 0; \
	fi; \
	echo "[test-changed] falling back to the full 'make test'"; \
	exec $(MAKE) --no-print-directory test

# A chosen subset of the Rust tests, e.g. while fixing one test before the full
# gate: E is one nextest filterset, run across the workspace
# (`make test-select E='test(/repository_selection/)'`,
# `E='package(intent-acp) & test(/callback/)'`). It goes through the same runner,
# caller policy and fixture preparation as `make test` (raw `cargo nextest`
# leaves the callback/transfer fixture variables unset, so fixture tests fail
# in bulk) and writes a gate-run record of its own (RESUME=1, GATE_FORCE=1,
# NO_FAIL_FAST=1, HERMETIC=1 and COMPACT=1 apply unchanged). $(value E) keeps
# `$` (regex anchors) literal; apostrophes are escaped for the single-quoted
# hand-off below, so E reaches nextest byte-for-byte. E must come from the make
# command line (a stray exported E is not a selection) and is unexported, so it
# never reaches Cargo or test processes.
TEST_SELECT_E = $(subst ','\'',$(value E))
unexport E
ifneq ($(filter test-select,$(MAKECMDGOALS)),)
ifneq ($(origin E),command line)
$(error make test-select needs E='<nextest filterset>' on the make command line, e.g. make test-select E='test(/repository_selection/)')
endif
ifeq ($(strip $(value E)),)
$(error make test-select needs a non-empty E='<nextest filterset>', e.g. make test-select E='test(/repository_selection/)')
endif
endif

test-select: ensure-intentd-submodule | check-transfer-fixture ## Run only the Rust tests matching E='<nextest filterset>' through the make test runner (fixtures, records; RESUME=1, NO_FAIL_FAST=1, HERMETIC=1 as for test)
	@python3 scripts/check_watch_capacity.py --quiet
	@cargo nextest --version >/dev/null 2>&1 || { \
		echo "[test-select] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
		exit 1; \
	}
	@$(HERMETIC_PREFLIGHT)
	@$(RUST_TEST_RUNNER) --label test-select --filterset '$(TEST_SELECT_E)'

# Local equivalent of intentd's pull_request `coverage-changed` CI job: the
# same changed-tests.sh selection as test-changed, run under the cargo-llvm-cov
# instrumentation the merge queue's coverage-e2e / coverage-all jobs use
# (INTENTD_TEST_TIMEOUT_MULTIPLIER=3, the local test targets' default too;
# auggie_context_e2e excluded), so a test that only fails instrumented
# (intent-hq/intentd#1947) fails here before the queue. No report or floor
# is produced; a build-wide change runs the mapped crates/ selection instead
# of falling back. No gate-run record is written
# (the instrumented run is not resumable). The script does not install
# cargo-llvm-cov / llvm-tools itself, hence the preflight (skipped under
# DRY_RUN=1, which only prints the plan).
coverage-changed: ensure-intentd-submodule ## Run only the Rust tests the intentd branch changed vs BASE under llvm-cov, as intentd's PR coverage-changed job does (DRY_RUN=1 prints the plan)
	@if [ -z "$(DRY_RUN)" ] || [ "$(DRY_RUN)" = 0 ]; then \
		python3 scripts/check_watch_capacity.py --quiet || exit $$?; \
		cargo nextest --version >/dev/null 2>&1 || { \
			echo "[coverage-changed] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
			exit 1; \
		}; \
		cargo llvm-cov --version >/dev/null 2>&1 || { \
			echo "[coverage-changed] ERROR: cargo-llvm-cov is not installed — run 'cargo install cargo-llvm-cov --locked' and 'rustup component add llvm-tools-preview'"; \
			exit 1; \
		}; \
	fi
	@BASE="$(BASE)" DRY_RUN="$(DRY_RUN)" BUILD_JOBS="$(BUILD_JOBS)" TEST_THREADS="$(TEST_THREADS)" \
		$(INTENTD_DIR)/scripts/changed-tests.sh --instrumented

# nextest ignores PAGER, so --no-pager is passed explicitly (see the pager
# export above). ARGS passes through, e.g. `make list-tests ARGS="-p intentd"`.
list-tests: ensure-intentd-submodule ## List nextest tests without a pager (ARGS="-p <crate>" to narrow)
	@cargo nextest --version >/dev/null 2>&1 || { \
		echo "[list-tests] ERROR: cargo-nextest is not installed — run 'cargo install cargo-nextest --locked'"; \
		exit 1; \
	}
	cd $(INTENTD_DIR) && cargo nextest list --no-pager $(ARGS)

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
	@python3 scripts/check_watch_capacity.py --quiet
	cd $(INTENTD_DIR) && NEXTEST_TEST_THREADS=$(TEST_THREADS) CARGO_BUILD_JOBS=$(BUILD_JOBS) \
		./scripts/coverage-e2e.sh $(COVERAGE_FLOOR)

coverage-all: ensure-intentd-submodule ## Reproduce CI full-workspace coverage locally (slow, instrumented; not part of make test)
	@python3 scripts/check_watch_capacity.py --quiet
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
		echo "[sweep] ERROR: cargo-sweep is not installed — run 'cargo install cargo-sweep --locked'"; \
		exit 1; \
	}
	@if [ -d "$(INTENTD_DIR)/target" ]; then \
		cd $(INTENTD_DIR) && cargo sweep --time $(SWEEP_DAYS); \
	else \
		echo "[sweep] nothing to sweep — $(INTENTD_DIR)/target does not exist"; \
	fi

sweep-all: ## Sweep intentd build artifacts in every worktree under $(WORKSPACES_DIR)
	@cargo sweep --version >/dev/null 2>&1 || { \
		echo "[sweep-all] ERROR: cargo-sweep is not installed — run 'cargo install cargo-sweep --locked'"; \
		exit 1; \
	}
	@for dir in $(WORKSPACES_DIR)/*/monorepo/$(INTENTD_DIR) $(WORKSPACES_DIR)/*/intent/$(INTENTD_DIR); do \
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

dev-ui: ensure-fe-submodule ensure-fe-toolchain ## Run the fast browser-only frontend UI preview
	@$(FE_DEPS_FRESH) || (echo "[dev-ui] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && corepack pnpm install --frozen-lockfile)
	@script=$$(node -e 'const scripts = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts || {}; if (scripts["dev:ui"]) process.stdout.write("dev:ui"); else if (scripts["dev:web"]) process.stdout.write("dev:web"); else process.exit(1)' "$(FE_DIR)/package.json") || { \
		echo "[dev-ui] ERROR: frontend package.json defines neither dev:ui nor dev:web"; \
		exit 1; \
	}; \
	if [ "$$script" = "dev:ui" ]; then \
		echo "[dev-ui] using optimized browser-only dev:ui preview"; \
	else \
		echo "[dev-ui] dev:ui is unavailable on this frontend pin; falling back to browser-only dev:web"; \
	fi; \
	cd $(FE_DIR) && DEV_PORT="$(DEV_PORT)" corepack pnpm run "$$script"

dev-sandbox-ui: ensure-fe-submodule ensure-fe-toolchain ## UI preview sandbox on this worktree's derived DEV_PORT
	@$(FE_DEPS_FRESH) || (echo "[dev-sandbox-ui] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && corepack pnpm install --frozen-lockfile)
	@DEV_PORT="$(DEV_PORT)" DEV_TCP_PORT="$(DEV_TCP_PORT)" SANDBOX_READY_TIMEOUT="$(SANDBOX_READY_TIMEOUT)" \
		DEV_PORT_ORIGIN="$(origin DEV_PORT)" DEV_TCP_PORT_ORIGIN="$(origin DEV_TCP_PORT)" \
		FE_DIR="$(CURDIR)/$(FE_DIR)" exec scripts/dev-sandbox.sh ui

dev-sandbox-app: ensure-fe-submodule ensure-fe-toolchain ## Web renderer sandbox connected to the installed intentd
	@$(FE_DEPS_FRESH) || (echo "[dev-sandbox-app] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && corepack pnpm install --frozen-lockfile)
	@DEV_PORT="$(DEV_PORT)" DEV_TCP_PORT="$(DEV_TCP_PORT)" SANDBOX_READY_TIMEOUT="$(SANDBOX_READY_TIMEOUT)" \
		DEV_PORT_ORIGIN="$(origin DEV_PORT)" DEV_TCP_PORT_ORIGIN="$(origin DEV_TCP_PORT)" \
		SANDBOX_WARM_TIMEOUT="$(SANDBOX_WARM_TIMEOUT)" \
		FE_DIR="$(CURDIR)/$(FE_DIR)" exec scripts/dev-sandbox.sh app

dev-sandbox-stack: ensure-intentd-submodule ensure-fe-submodule ensure-fe-toolchain ## Dev-profile intentd + renderer (INTENTD_PROFILE=release or INTENTD_BIN=/path)
	@$(FE_DEPS_FRESH) || (echo "[dev-sandbox-stack] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && corepack pnpm install --frozen-lockfile)
	@DEV_PORT="$(DEV_PORT)" DEV_TCP_PORT="$(DEV_TCP_PORT)" DEV_DATA_DIR="$(DEV_DATA_DIR)" \
		DEV_PORT_ORIGIN="$(origin DEV_PORT)" DEV_TCP_PORT_ORIGIN="$(origin DEV_TCP_PORT)" \
		SANDBOX_TCP="$(SANDBOX_TCP)" SANDBOX_READY_TIMEOUT="$(SANDBOX_READY_TIMEOUT)" \
		SANDBOX_WARM_TIMEOUT="$(SANDBOX_WARM_TIMEOUT)" BUILD_JOBS="$(BUILD_JOBS)" \
		INTENTD_PROFILE="$(INTENTD_PROFILE)" INTENTD_BIN="$(INTENTD_BIN)" \
		INTENTD_DIR="$(CURDIR)/$(INTENTD_DIR)" FE_DIR="$(CURDIR)/$(FE_DIR)" \
		exec scripts/dev-sandbox.sh stack

sandbox-status: ## Show live sandbox state (SANDBOX_JSON=1 for JSON)
	@SANDBOX_JSON="$(SANDBOX_JSON)" scripts/dev-sandbox.sh status

sandbox-stop: ## Stop sandboxes in this worktree (optionally MODE=ui|app|stack)
	@MODE="$(MODE)" scripts/dev-sandbox.sh stop

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
# `make help`): FE_DEPS_FRESH install guard + `pnpm run dev`, inheriting the
# caller's INTENTD_SOCKET and resolving DEV_PORT only when the launcher runs.
fe-launch: ensure-fe-submodule
	@$(FE_DEPS_FRESH) || (echo "[fe-launch] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && pnpm install)
	cd $(FE_DIR) && DEV_PORT="$(DEV_PORT)" pnpm run dev

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
	@$(FE_DEPS_FRESH) || (echo "[run-fe-local] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && pnpm install)
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
	cd $(FE_DIR) && DEV_PORT="$(DEV_PORT)" INTENTD_SOCKET="$$sock" pnpm run dev

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

# One-shot JSON-RPC probe of a running intentd via scripts/uds-rpc.mjs
# (zero-dependency, Node >= 20). Prints each received frame as one JSON line;
# default mode exits when the response matching the request id arrives
# (nonzero if it is a JSON-RPC error), SUBSCRIBE=1 keeps the connection open
# until MAX_FRAMES frames printed or TIMEOUT_MS elapses. Socket resolution is
# left to the script: an explicit INTENTD_SOCKET always takes precedence, then
# an INTENTD_DATA_DIR-derived path, then the platform default. PARAMS is read
# from the recipe's environment (make exports command-line variables) so its
# JSON quoting survives expansion.
rpc: ## Send one JSON-RPC request to the running intentd: make rpc METHOD=workspace.list [PARAMS='{...}'] [SUBSCRIBE=1] [MAX_FRAMES=N] [TIMEOUT_MS=MS]
	@if [ -z "$(METHOD)" ]; then \
		echo "[rpc] ERROR: METHOD is required."; \
		echo "[rpc] usage: make rpc METHOD=<jsonrpc-method> [PARAMS='{...}'] [SUBSCRIBE=1] [MAX_FRAMES=N] [TIMEOUT_MS=MS]"; \
		exit 1; \
	fi; \
	set -- "$(METHOD)"; \
	if [ -n "$$PARAMS" ]; then set -- "$$@" "$$PARAMS"; fi; \
	if [ -n "$(filter 1 yes true,$(SUBSCRIBE))" ]; then set -- "$$@" --subscribe; fi; \
	if [ -n "$(MAX_FRAMES)" ]; then set -- "$$@" --max-frames "$(MAX_FRAMES)"; fi; \
	if [ -n "$(TIMEOUT_MS)" ]; then set -- "$$@" --timeout "$(TIMEOUT_MS)"; fi; \
	node scripts/uds-rpc.mjs "$$@"

dev-web-live: ## DEPRECATED alias for dev-sandbox-app
	@echo "[dev-web-live] DEPRECATED: use 'make dev-sandbox-app'."
	@$(MAKE) dev-sandbox-app

build-sidecar: ensure-intentd-submodule ensure-fe-submodule ## Build intentd release + stage the sidecar binary for FE packaging
	# Builds the intentd release binary (may take several minutes on first build) and
	# runs the FE copy-sidecar script to stage it for electron-builder. This is the
	# prerequisite for `pnpm run dist:mac` in packages/cloudlands-fe.
	# Ensure FE node_modules first so a fresh checkout does not fail when any
	# staging helper (or a future copy-sidecar dep) expects an installed tree —
	# and so `dist-mac` (which depends on this target) does not install after
	# the sidecar step.
	@$(FE_DEPS_FRESH) || (echo "[build-sidecar] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && pnpm install)
	@echo "[build-sidecar] Building intentd release binary..."
	cd $(INTENTD_DIR) && bash "$(CURDIR)/scripts/with-sccache.sh" cargo build --release --workspace
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
	@$(FE_DEPS_FRESH) || (echo "[dev] $(FE_DEPS_INSTALL_MSG)" && cd $(FE_DIR) && pnpm install)
	@echo "[dev] Building intentd release binary (no-op if already fresh)..."
	cd $(INTENTD_DIR) && bash "$(CURDIR)/scripts/with-sccache.sh" cargo build --release --workspace
	@mkdir -p "$(DEV_DATA_DIR)"
	@echo "[dev] Launching FE with sidecar mode enabled (INTENTD_SIDECAR=1)"
	@echo "[dev]   INTENTD_BIN=$(CURDIR)/$(INTENTD_DIR)/target/release/intentd"
	@echo "[dev]   INTENTD_DATA_DIR=$(DEV_DATA_DIR) (UDS: $(DEV_DATA_DIR)/intentd.sock)"
	@echo "[dev]   INTENTD_LEGACY_IMPORT_ROOTS=\"\" (legacy import disabled for the dev seat)"
	cd $(FE_DIR) && DEV_PORT="$(DEV_PORT)" INTENTD_SIDECAR=1 \
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

# Blessed xcodebuild wrappers — every iOS build/test runs through the ios
# repo's single entry point (scripts/xcodebuild.sh, from intent-hq/ios#219) so
# destinations, signing flags, and SDK selection cannot diverge. The
# missing-script guard covers a recorded iOS pin that still predates that PR:
# `ensure-ios-submodule` only initializes the submodule at the recorded pin,
# it does not advance it.
ios-build-ios: ensure-ios-submodule ## Build the iOS app for the iOS Simulator (blessed xcodebuild entry point)
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[ios-build-ios] ERROR: requires macOS (xcodebuild). Detected $$(uname -s)."; \
		exit 1; \
	fi
	@if [ ! -x "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
		if [ -e "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
			echo "[ios-build-ios] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh exists but is not executable — fix with: chmod +x $(IOS_DIR)/scripts/xcodebuild.sh"; \
		else \
			echo "[ios-build-ios] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh not found — the recorded iOS pin predates intent-hq/ios#219."; \
			echo "[ios-build-ios] Wait for auto-bump-submodules to advance the pin, or check out a newer ios ref: git -C $(IOS_DIR) fetch origin && git -C $(IOS_DIR) checkout origin/main"; \
		fi; \
		exit 1; \
	fi
	cd $(IOS_DIR) && scripts/xcodebuild.sh build-ios

ios-build-visionos: ensure-ios-submodule ## Build the iOS app for the visionOS Simulator (blessed xcodebuild entry point)
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[ios-build-visionos] ERROR: requires macOS (xcodebuild). Detected $$(uname -s)."; \
		exit 1; \
	fi
	@if [ ! -x "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
		if [ -e "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
			echo "[ios-build-visionos] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh exists but is not executable — fix with: chmod +x $(IOS_DIR)/scripts/xcodebuild.sh"; \
		else \
			echo "[ios-build-visionos] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh not found — the recorded iOS pin predates intent-hq/ios#219."; \
			echo "[ios-build-visionos] Wait for auto-bump-submodules to advance the pin, or check out a newer ios ref: git -C $(IOS_DIR) fetch origin && git -C $(IOS_DIR) checkout origin/main"; \
		fi; \
		exit 1; \
	fi
	cd $(IOS_DIR) && scripts/xcodebuild.sh build-visionos

ios-test: ensure-ios-submodule ## Run the iOS unit tests on a simulator (blessed xcodebuild entry point)
	@if [ "$$(uname -s)" != "Darwin" ]; then \
		echo "[ios-test] ERROR: requires macOS (xcodebuild). Detected $$(uname -s)."; \
		exit 1; \
	fi
	@if [ ! -x "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
		if [ -e "$(IOS_DIR)/scripts/xcodebuild.sh" ]; then \
			echo "[ios-test] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh exists but is not executable — fix with: chmod +x $(IOS_DIR)/scripts/xcodebuild.sh"; \
		else \
			echo "[ios-test] ERROR: $(IOS_DIR)/scripts/xcodebuild.sh not found — the recorded iOS pin predates intent-hq/ios#219."; \
			echo "[ios-test] Wait for auto-bump-submodules to advance the pin, or check out a newer ios ref: git -C $(IOS_DIR) fetch origin && git -C $(IOS_DIR) checkout origin/main"; \
		fi; \
		exit 1; \
	fi
	cd $(IOS_DIR) && scripts/xcodebuild.sh test-ios

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
