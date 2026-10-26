#!/usr/bin/env bash
# Tests for scripts/rustc-parallel.sh and the opt-in PARALLEL=1 Makefile knob.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WRAPPER="$ROOT/scripts/rustc-parallel.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# Fake compiler and fake chained wrapper: record argv and RUSTC_BOOTSTRAP.
cat >"$tmp/fake-rustc" <<'EOF'
#!/usr/bin/env bash
printf 'rustc bootstrap=%s args=%s\n' "${RUSTC_BOOTSTRAP-unset}" "$*" >>"$LOG"
EOF
cat >"$tmp/fake-sccache" <<'EOF'
#!/usr/bin/env bash
printf 'sccache\n' >>"$LOG"
exec "$@"
EOF
chmod +x "$tmp/fake-rustc" "$tmp/fake-sccache"
export LOG="$tmp/log"
ws="$tmp/intentd"
mkdir -p "$ws/crates/intent-services" "$ws/vendor/pprof" "$tmp/intentd-other" "$tmp/registry/anyhow"

# run_wrapper MANIFEST_DIR ARGS... : run the wrapper locally (never under CI).
run_wrapper() {
  local dir=$1
  shift
  : >"$LOG"
  env -u CI -u GITHUB_ACTIONS -u RUSTC_BOOTSTRAP CARGO_MANIFEST_DIR="$dir" \
    INTENT_PARALLEL_ROOT="${ROOT_OVERRIDE-$ws}" "$BASH" "$WRAPPER" "$@"
}
expect_log() { # description expected-log-content
  local got
  got=$(cat "$LOG")
  if [ "$got" = "$2" ]; then pass "$1"; else fail "$1: expected [$2] got [$got]"; fi
}

run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" --crate-name intent_services src/lib.rs
expect_log "workspace crate gets -Zthreads=8 and RUSTC_BOOTSTRAP=1" \
  "rustc bootstrap=1 args=--crate-name intent_services src/lib.rs -Zthreads=8"

run_wrapper "$ws/vendor/pprof" "$tmp/fake-rustc" --crate-name pprof
expect_log "vendored path crate under the workspace is threaded" \
  "rustc bootstrap=1 args=--crate-name pprof -Zthreads=8"

run_wrapper "$tmp/registry/anyhow" "$tmp/fake-rustc" --crate-name anyhow
expect_log "dependency outside the workspace is unchanged" \
  "rustc bootstrap=unset args=--crate-name anyhow"

run_wrapper "$tmp/intentd-other" "$tmp/fake-rustc" --crate-name other
expect_log "sibling directory sharing the root prefix is unchanged" \
  "rustc bootstrap=unset args=--crate-name other"

run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" -vV
expect_log "version probe is unchanged" "rustc bootstrap=unset args=-vV"

run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" - --crate-name ___ --print=file-names
expect_log "cargo --print probe is unchanged" \
  "rustc bootstrap=unset args=- --crate-name ___ --print=file-names"

ROOT_OVERRIDE="" run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" --crate-name x
expect_log "missing INTENT_PARALLEL_ROOT leaves every crate unchanged" "rustc bootstrap=unset args=--crate-name x"

# clippy shape: RUSTC_WRAPPER clippy-driver rustc ARGS...
run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" /bin/rustc --crate-name intent_services
expect_log "clippy-driver invocation is threaded" \
  "rustc bootstrap=1 args=/bin/rustc --crate-name intent_services -Zthreads=8"

INTENT_PARALLEL_THREADS=4 INTENT_PARALLEL_INNER_WRAPPER="$tmp/fake-sccache" \
  run_wrapper "$ws/crates/intent-services" "$tmp/fake-rustc" --crate-name intent_services
expect_log "caller wrapper is chained and PARALLEL_THREADS is honored" \
  "sccache
rustc bootstrap=1 args=--crate-name intent_services -Zthreads=4"

INTENT_PARALLEL_INNER_WRAPPER="$WRAPPER" run_wrapper "$tmp/registry/anyhow" "$tmp/fake-rustc" --crate-name anyhow
expect_log "the wrapper never chains to itself" "rustc bootstrap=unset args=--crate-name anyhow"

for bad in 0 abc -1 2x; do
  if INTENT_PARALLEL_THREADS=$bad run_wrapper "$ws" "$tmp/fake-rustc" x 2>/dev/null; then
    fail "INTENT_PARALLEL_THREADS='$bad' should be rejected"
  else
    pass "INTENT_PARALLEL_THREADS='$bad' is rejected"
  fi
done

for ci_var in CI=true GITHUB_ACTIONS=true; do
  : >"$LOG"
  if env "$ci_var" CARGO_MANIFEST_DIR="$ws" INTENT_PARALLEL_ROOT="$ws" "$BASH" "$WRAPPER" "$tmp/fake-rustc" x 2>/dev/null; then
    fail "wrapper must refuse under $ci_var"
  elif [ -s "$LOG" ]; then
    fail "wrapper ran the compiler under $ci_var"
  else
    pass "wrapper refuses under $ci_var"
  fi
done

# Makefile knob: inspect the parsed database in dry-run mode (no recipe runs).
make_db() { env -u CI -u GITHUB_ACTIONS -u RUSTC_WRAPPER make -C "$ROOT" -pn "$@" 2>&1; }
wrapper_line="RUSTC_WRAPPER := $WRAPPER"

out=$(make_db build) || fail "make -pn build failed: $out"
if grep -qxF "$wrapper_line" <<<"$out" || grep -q '^INTENT_PARALLEL_' <<<"$out"; then
  fail "default build must not set the parallel wrapper"
else
  pass "parallel front end is off by default"
fi

for goal in build check test gate test-changed test-select clippy lint-sources; do
  out=$(make_db "$goal" PARALLEL=1 DRY_RUN=1) || true
  if grep -qxF "$wrapper_line" <<<"$out" && grep -qxF "INTENT_PARALLEL_THREADS := 8" <<<"$out"; then
    pass "PARALLEL=1 make $goal sets the wrapper"
  else
    fail "PARALLEL=1 make $goal did not set the wrapper: $(tail -3 <<<"$out")"
  fi
done

out=$(make_db build PARALLEL=1 PARALLEL_THREADS=4) || true
if grep -qxF "INTENT_PARALLEL_THREADS := 4" <<<"$out"; then pass "PARALLEL_THREADS overrides"; else fail "PARALLEL_THREADS=4 not applied"; fi

target_of() { { grep -E '^CARGO_TARGET_DIR :?= ' <<<"$1" || true; } | tail -1 | sed -E 's/^CARGO_TARGET_DIR :?= //'; }
default_target=$(target_of "$(make_db build)")
t8=$(target_of "$(make_db build PARALLEL=1)")
t4=$(target_of "$(make_db build PARALLEL=1 PARALLEL_THREADS=4)")
if [ -z "$default_target" ] && [ "$t8" = "$ROOT/packages/intentd/target/parallel-t8" ] \
  && [ "$t4" = "$ROOT/packages/intentd/target/parallel-t4" ]; then
  pass "each thread count builds into its own target dir; the default is untouched"
else
  fail "target dirs not isolated per mode: default='$default_target' t8='$t8' t4='$t4'"
fi
out=$(env -u CI -u GITHUB_ACTIONS -u RUSTC_WRAPPER CARGO_TARGET_DIR=/tmp/own-target make -C "$ROOT" -pn build PARALLEL=1 2>&1) || true
if [ "$(target_of "$out")" = /tmp/own-target/parallel-t8 ]; then
  pass "a caller CARGO_TARGET_DIR is the base for the parallel tree"
else
  fail "caller CARGO_TARGET_DIR not used as base: '$(target_of "$out")'"
fi
out=$(env -u CI -u GITHUB_ACTIONS RUSTC_WRAPPER="$WRAPPER" INTENT_PARALLEL_TARGET_BASE=/tmp/base \
  CARGO_TARGET_DIR=/tmp/base/parallel-t8 make -C "$ROOT" -pn build PARALLEL=1 2>&1) || true
if [ "$(target_of "$out")" = /tmp/base/parallel-t8 ]; then
  pass "recursive make does not nest the parallel target dir"
else
  fail "recursive make nested the target dir: '$(target_of "$out")'"
fi

# Regression: Cargo ignores wrapper-added flags in its fingerprint, so a shared
# target dir would report a plain build Fresh after enabling the wrapper.
if command -v cargo >/dev/null 2>&1; then
  crate=$(mktemp -d)
  mkdir -p "$crate/src"
  printf '[package]\nname = "ptiny"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n' >"$crate/Cargo.toml"
  printf 'pub fn f() -> u32 { 1 }\n' >"$crate/src/lib.rs"
  log="$crate/wrapped.log"
  printf '#!/usr/bin/env bash\necho "$*" >>%q\nexec "$@"\n' "$log" >"$crate/logwrap.sh"
  chmod +x "$crate/logwrap.sh"
  plain() { (cd "$crate" && env -u CI -u GITHUB_ACTIONS -u RUSTC_WRAPPER CARGO_BUILD_RUSTC_WRAPPER= \
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$crate/target" cargo build --offline -q); }
  wrapped() { (cd "$crate" && env -u CI -u GITHUB_ACTIONS RUSTC_WRAPPER="$WRAPPER" \
    INTENT_PARALLEL_INNER_WRAPPER="$crate/logwrap.sh" INTENT_PARALLEL_ROOT="$crate" INTENT_PARALLEL_THREADS="$1" \
    CARGO_INCREMENTAL=0 CARGO_TARGET_DIR="$crate/target/parallel-t$1" cargo build --offline -q); }
  if plain && wrapped 8 && wrapped 4 && plain; then
    if grep -q -- '--crate-name ptiny.*-Zthreads=8' "$log" && grep -q -- '--crate-name ptiny.*-Zthreads=4' "$log"; then
      pass "switching modes with per-mode target dirs recompiles with the new -Zthreads"
    else
      fail "a mode switch reused artifacts built under another setting: $(cat "$log" 2>/dev/null)"
    fi
  else
    fail "tiny-crate mode-switch build failed"
  fi
  rm -rf "$crate"
else
  echo "skip: cargo not installed; tiny-crate mode-switch regression not run"
fi

out=$(env -u CI -u GITHUB_ACTIONS RUSTC_WRAPPER=/usr/bin/sccache make -C "$ROOT" -pn build PARALLEL=1 2>&1) || true
if grep -qxF "INTENT_PARALLEL_INNER_WRAPPER := /usr/bin/sccache" <<<"$out"; then
  pass "caller RUSTC_WRAPPER is kept as the inner wrapper"
else
  fail "caller RUSTC_WRAPPER not chained"
fi

out=$(env -u CI -u GITHUB_ACTIONS RUSTC_WRAPPER="$WRAPPER" make -C "$ROOT" -pn build PARALLEL=1 2>&1) || true
if grep -q '^INTENT_PARALLEL_INNER_WRAPPER := .*rustc-parallel' <<<"$out"; then
  fail "recursive make must not chain the wrapper to itself"
else
  pass "recursive make does not chain the wrapper to itself"
fi

out=$(env -u CI -u GITHUB_ACTIONS -u RUSTC_WRAPPER PARALLEL='--jobs 4' make -C "$ROOT" -pn build 2>&1) \
  || fail "an unrelated PARALLEL in the environment must not fail make: $out"
if grep -qxF "$wrapper_line" <<<"$out"; then
  fail "PARALLEL='--jobs 4' must not enable the wrapper"
else
  pass "only PARALLEL=1 enables the wrapper"
fi

for goal in build-sidecar coverage-all coverage-changed release-daemon dist-mac; do
  if out=$(make_db "$goal" PARALLEL=1); then
    fail "PARALLEL=1 make $goal must be rejected"
  elif grep -q 'PARALLEL=1 supports only' <<<"$out"; then
    pass "PARALLEL=1 make $goal is rejected before any recipe"
  else
    fail "PARALLEL=1 make $goal failed for another reason: $(tail -2 <<<"$out")"
  fi
done

for ci_var in CI=true GITHUB_ACTIONS=true; do
  if out=$(env "$ci_var" make -C "$ROOT" -pn build PARALLEL=1 2>&1); then
    fail "PARALLEL=1 must be rejected under $ci_var"
  elif grep -q 'rejected under CI' <<<"$out"; then
    pass "PARALLEL=1 is rejected under $ci_var"
  else
    fail "PARALLEL=1 under $ci_var failed for another reason: $(tail -2 <<<"$out")"
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "rustc-parallel.test.sh: $failures failure(s)" >&2
  exit 1
fi
echo "rustc-parallel.test.sh: all passed"
