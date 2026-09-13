#!/usr/bin/env bash
# Run only the nextest targets a packages/intentd branch touched.
#
#   scripts/rust-changed-tests.sh [--dry-run] [--base REF] [--intentd-dir DIR]
#                                 [--build-jobs N] [--test-threads N]
#
# Each flag falls back to an environment variable: DRY_RUN=1, BASE (default
# origin/main), INTENTD_DIR (default packages/intentd next to this script),
# BUILD_JOBS, TEST_THREADS. NEXTEST_SHOW_PROGRESS / CARGO_TERM_PROGRESS_WHEN
# are inherited as-is (the Makefile sets them).
#
# The changed set is `git diff --name-only $(git merge-base HEAD BASE)` inside
# INTENTD_DIR (committed, staged and unstaged edits) plus the untracked files
# from `git ls-files --others`. Paths map to per-crate nextest selections:
#   crates/<c>/tests/<t>.rs          -p <c> --test <t>   (--tests once deleted)
#   crates/<c>/tests/<dir>/**        -p <c> --tests
#   crates/<c>/src/**                -p <c> --lib --bins --tests
#                                    (--lib only when src/lib.rs exists)
#   crates/<c>/benches|examples/**   ignored (nextest does not run them)
#   crates/<c>/<anything else>       -p <c>  (all test targets of <c>)
#   outside crates/, inert           ignored: *.md, LICENSE, NOTICE, .gitignore,
#                                    .github/**, docs/**, deny.toml,
#                                    release-plz.toml, dist-workspace.toml
#   outside crates/, anything else   full suite (exit 3) -- tests read repo
#                                    files such as scripts/install.sh via
#                                    CARGO_MANIFEST_DIR, so fail closed
# A broader selection subsumes narrower ones for the same crate. Cargo applies
# target flags to every -p package on one command line, so crates with
# different selections run as separate `cargo nextest run` invocations and
# crates with identical selections share one. Reverse dependencies are NOT
# propagated: crates/<c>/src selects <c>'s own tests only; `make test` stays
# the complete gate.
#
# Exit codes: 0 = nothing to test, or every invocation passed; 2 = usage error
# or BASE cannot be resolved; 3 = a build-wide file changed (Cargo.toml,
# Cargo.lock, crates/*/Cargo.toml, crates/*/build.rs, .config/nextest.toml,
# rust-toolchain.toml, .cargo/**) or a non-inert path outside crates/ changed
# -- run the full `make test` instead; any other code is the first failing
# cargo invocation's exit code.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
intentd_dir=${INTENTD_DIR:-$repo_root/packages/intentd}
base=${BASE:-origin/main}
build_jobs=${BUILD_JOBS:-}
test_threads=${TEST_THREADS:-}
dry_run=${DRY_RUN:-}

usage() {
  echo "Usage: $0 [--dry-run] [--base REF] [--intentd-dir DIR] [--build-jobs N] [--test-threads N]" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --base=*) base=${1#--base=} ;;
    --intentd-dir=*) intentd_dir=${1#--intentd-dir=} ;;
    --build-jobs=*) build_jobs=${1#--build-jobs=} ;;
    --test-threads=*) test_threads=${1#--test-threads=} ;;
    --base | --intentd-dir | --build-jobs | --test-threads)
      [[ $# -ge 2 && -n "$2" ]] || usage
      case "$1" in
        --base) base=$2 ;;
        --intentd-dir) intentd_dir=$2 ;;
        --build-jobs) build_jobs=$2 ;;
        --test-threads) test_threads=$2 ;;
      esac
      shift
      ;;
    *) usage ;;
  esac
  shift
done
[[ -n "$base" ]] || usage
[[ -n "$dry_run" && "$dry_run" != 0 ]] || dry_run=""

log() {
  echo "[test-changed] $*"
}

die() {
  local code=$1
  shift
  echo "[test-changed] $*" >&2
  exit "$code"
}

display_dir=${intentd_dir#"$PWD"/}
[[ -d "$intentd_dir" ]] || die 2 "intentd checkout not found at $display_dir (set INTENTD_DIR)"
cd "$intentd_dir"
git rev-parse --git-dir >/dev/null 2>&1 || die 2 "$display_dir is not a git checkout (set INTENTD_DIR)"
merge_base=$(git merge-base HEAD "$base" 2>/dev/null) ||
  die 2 "cannot resolve BASE '$base' in $display_dir; run 'git -C $display_dir fetch origin main' or set BASE=<ref>"

# Paths outside crates/ that no test can observe.
is_inert() {
  case "$1" in
    *.md | LICENSE | NOTICE | .gitignore | deny.toml | release-plz.toml | dist-workspace.toml) return 0 ;;
    .github/* | docs/*) return 0 ;;
  esac
  return 1
}

is_fallback() {
  case "$1" in
    Cargo.toml | Cargo.lock | rust-toolchain.toml | .config/nextest.toml | .cargo/*) return 0 ;;
    crates/*/Cargo.toml | crates/*/build.rs) return 0 ;;
    crates/*) return 1 ;;
  esac
  # Anything else outside crates/ may be read by a test through
  # CARGO_MANIFEST_DIR (scripts/install.sh, repo-wide lints), so fail closed.
  ! is_inert "$1"
}

# Prints "<crate>\t<kind>[\t<test>]" for a path under crates/, kinds ranked
# test < tests < src < all; prints nothing for ignored paths.
map_path() {
  local path=$1 rest crate sub name
  [[ "$path" == crates/*/* ]] || return 0
  rest=${path#crates/}
  crate=${rest%%/*}
  sub=${rest#*/}
  case "$sub" in
    tests/*)
      name=${sub#tests/}
      if [[ "$name" == *.rs && "$name" != */* && -f "$path" ]]; then
        printf '%s\ttest\t%s\n' "$crate" "${name%.rs}"
      else
        printf '%s\ttests\n' "$crate"
      fi
      ;;
    src/*) printf '%s\tsrc\n' "$crate" ;;
    benches/* | examples/*) ;;
    *) printf '%s\tall\n' "$crate" ;;
  esac
}

fallback=""
mapped=""
seen=""
classify() {
  local path=$1
  [[ -n "$path" && "$seen" != *$'\n'"$path"$'\n'* ]] || return 0
  seen+=$'\n'"$path"$'\n'
  if is_fallback "$path"; then
    fallback+="$path"$'\n'
  else
    mapped+="$(map_path "$path")"$'\n'
  fi
}

# Committed + staged + unstaged edits since the merge base, then untracked
# files. Both are read NUL-delimited so paths arrive raw (line-oriented
# porcelain output C-quotes names with spaces or non-ASCII characters) and
# with rename detection off so both sides of a move count as changed. The
# output goes through a file so a failing git command is not silently read
# as an empty change set.
changed_file=$(mktemp "${TMPDIR:-/tmp}/rust-changed-tests.XXXXXX")
trap 'rm -f "$changed_file"' EXIT
git diff --name-only -z --no-renames "$merge_base" -- >"$changed_file" ||
  die 2 "git diff --name-only $merge_base failed in $display_dir (exit $?)"
git ls-files -z --others --exclude-standard >>"$changed_file" ||
  die 2 "git ls-files --others failed in $display_dir (exit $?)"
while IFS= read -r -d '' path; do
  classify "$path"
done <"$changed_file"

if [[ -n "$fallback" ]]; then
  echo "[test-changed] build-wide change(s) vs $base need the full suite -- run 'make test':" >&2
  printf '%s' "$fallback" | while IFS= read -r path; do echo "  $path" >&2; done
  exit 3
fi

# Stock macOS ships Bash 3.2, which has no associative arrays: per-crate
# lookups scan the newline-separated "<crate>\t<kind>[\t<test>]" records.
crates=""
while IFS=$'\t' read -r crate _; do
  [[ -n "$crate" ]] && crates+="$crate"$'\n'
done <<<"$mapped"
crates=$(printf '%s' "$crates" | sort -u)

if [[ -z "$crates" ]]; then
  log "nothing to test (no Rust changes vs $base)"
  exit 0
fi

# Sets crate_filter to the target flags for one crate ("" = every test target).
crate_selection() {
  local crate=$1 best=test tests="" c kind test
  while IFS=$'\t' read -r c kind test; do
    [[ "$c" == "$crate" ]] || continue
    case "$kind" in
      all) best=all ;;
      src) [[ "$best" == all ]] || best=src ;;
      tests) [[ "$best" == all || "$best" == src ]] || best=tests ;;
      test) tests+="$test"$'\n' ;;
    esac
  done <<<"$mapped"
  case "$best" in
    all) crate_filter="" ;;
    src)
      crate_filter="--bins --tests"
      [[ -f "crates/$crate/src/lib.rs" ]] && crate_filter="--lib $crate_filter"
      log "note: crates/$crate/src changed; only $crate's own tests run (downstream crates are not selected)"
      ;;
    tests) crate_filter="--tests" ;;
    test)
      crate_filter=""
      while IFS= read -r test; do
        crate_filter+="${crate_filter:+ }--test $test"
      done <<<"$(printf '%s' "$tests" | sort -u)"
      ;;
  esac
}

selections=""
while IFS= read -r crate; do
  crate_selection "$crate"
  selections+="$crate"$'\t'"$crate_filter"$'\n'
done <<<"$crates"

# One invocation per distinct filter, in first-crate order: cargo applies
# target flags to every -p package on the command line.
plans=""
grouped=""
while IFS=$'\t' read -r crate filter; do
  [[ -n "$crate" && "$grouped" != *" $crate "* ]] || continue
  members=""
  while IFS=$'\t' read -r other other_filter; do
    if [[ -n "$other" && "$other_filter" == "$filter" ]]; then
      members+="-p $other "
      grouped+=" $other "
    fi
  done <<<"$selections"
  plans+="$members$filter"$'\n'
done <<<"$selections"

extra=""
[[ -n "$build_jobs" ]] && extra+=" --build-jobs $build_jobs"
[[ -n "$test_threads" ]] && extra+=" --test-threads $test_threads"

while IFS= read -r plan; do
  [[ -n "$plan" ]] || continue
  log "cargo nextest run ${plan% }$extra"
done <<<"$plans"

[[ -z "$dry_run" ]] || exit 0

# The plans are read from fd 3 so cargo keeps the caller's stdin.
while IFS= read -r -u 3 plan; do
  [[ -n "$plan" ]] || continue
  # $plan and $extra hold only the flags assembled above; split them on purpose.
  # shellcheck disable=SC2086
  set -- $plan $extra
  set +e
  cargo nextest run "$@"
  status=$?
  set -e
  [[ "$status" -eq 0 ]] || die "$status" "cargo nextest run ${plan% }$extra exited $status"
done 3<<<"$plans"
