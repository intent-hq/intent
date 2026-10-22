#!/usr/bin/env bash
#
# Self-test for scripts/lint-workflows.sh (`make lint-workflows`).
#
# The precondition and pass-through cases run the lint under a PATH holding
# only a stub actionlint (and, where wanted, a stub shellcheck), so a host
# copy of shellcheck in /usr/bin cannot hide the "shellcheck missing" path. The
# real-actionlint cases run the pinned binary against a temp git repo carrying
# the repo's .github/actionlint.yaml: a broken workflow must fail, the
# self-hosted labels must pass, and the consumer-checks ignore must stay scoped
# to that one file. They are skipped when the pinned actionlint or shellcheck
# is absent, unless REQUIRE_ACTIONLINT=1 (CI's workflow-lint job sets it).
# Bash 3.2 compatible.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

pin=$(sed -n 's/^ACTIONLINT_VERSION="\(.*\)"$/\1/p' "$repo_root/scripts/bootstrap-dev-host.sh")
[ -n "$pin" ] || { echo "lint-workflows test: cannot read ACTIONLINT_VERSION" >&2; exit 1; }

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
pass() {
  echo "ok: $*"
}

# A fake repo: the lint and the pin file under scripts/, the real config.
fake=$temp_dir/repo
mkdir -p "$fake/scripts" "$fake/.github/workflows"
cp "$repo_root/scripts/lint-workflows.sh" "$repo_root/scripts/bootstrap-dev-host.sh" "$fake/scripts/"
cp "$repo_root/.github/actionlint.yaml" "$fake/.github/actionlint.yaml"

stub_bin=$temp_dir/stub-bin
mkdir -p "$stub_bin"
calls=$temp_dir/actionlint-calls
# Stub actionlint: STUB_VERSION / STUB_VERSION_FAIL drive --version; a lint
# call records its cwd and arguments and exits STUB_EXIT. Builtins only.
cat >"$stub_bin/actionlint" <<'SH'
#!/bin/sh
if [ "$1" = --version ]; then
  [ -z "${STUB_VERSION_FAIL:-}" ] || exit 1
  printf '%s\ninstalled by stub\n' "$STUB_VERSION"
  exit 0
fi
{ printf 'cwd=%s\n' "$(pwd)"; for arg in "$@"; do printf 'arg=%s\n' "$arg"; done; } >>"$STUB_CALLS"
[ "${STUB_EXIT:-0}" -eq 0 ] || echo "stub: finding"
exit "${STUB_EXIT:-0}"
SH
printf '#!/bin/sh\nexit 0\n' >"$stub_bin/shellcheck"
chmod +x "$stub_bin/actionlint" "$stub_bin/shellcheck"
no_shellcheck_bin=$temp_dir/no-shellcheck-bin
mkdir -p "$no_shellcheck_bin"
cp "$stub_bin/actionlint" "$no_shellcheck_bin/actionlint"
empty_bin=$temp_dir/empty-bin
mkdir -p "$empty_bin"

# run_lint PATH [args...]: runs the copied lint; sets status and output.
run_lint() {
  local path=$1
  shift
  : >"$calls"
  status=0
  output=$(cd "$temp_dir" && PATH=$path STUB_CALLS=$calls "$BASH" "$fake/scripts/lint-workflows.sh" "$@" 2>&1) || status=$?
}

expect() {
  local name=$1 want_status=$2 want_text=$3
  if [ "$status" -ne "$want_status" ]; then
    fail "$name: exit $status, want $want_status; output: $output"
  elif [ -n "$want_text" ] && [[ "$output" != *"$want_text"* ]]; then
    fail "$name: output lacks '$want_text'; output: $output"
  else
    pass "$name"
  fi
}

expect_no_lint_call() {
  if [ -s "$calls" ]; then fail "$1: actionlint lint ran anyway: $(cat "$calls")"; fi
}

# --- Preconditions -----------------------------------------------------------

run_lint "$empty_bin"
expect "actionlint missing names the pin and bootstrap" 1 "[missing]  actionlint $pin: required by make lint-workflows; run make bootstrap-dev-host"

STUB_VERSION=1.0.0 run_lint "$stub_bin"
expect "actionlint off the pin fails" 1 "[missing]  actionlint: found 1.0.0; make lint-workflows pins $pin; run make bootstrap-dev-host"
expect_no_lint_call "actionlint off the pin"

STUB_VERSION=$pin STUB_VERSION_FAIL=1 run_lint "$stub_bin"
expect "unrunnable actionlint fails" 1 "is on PATH but actionlint --version fails"

STUB_VERSION=$pin run_lint "$no_shellcheck_bin"
expect "shellcheck missing fails instead of skipping shell checks" 1 "[missing]  shellcheck: required by make lint-workflows"
expect_no_lint_call "shellcheck missing"

# --- Pass-through --------------------------------------------------------------

STUB_VERSION=$pin run_lint "$stub_bin" extra.yml
expect "clean run exits 0 and says so" 0 "lint-workflows: .github/workflows is clean (actionlint $pin)"
want_calls=$(printf 'cwd=%s\narg=-shellcheck\narg=%s\narg=extra.yml\n' "$fake" "$stub_bin/shellcheck")
if [ "$(cat "$calls")" = "$want_calls" ]; then
  pass "lint runs from the repo root with the resolved shellcheck and passes arguments"
else
  fail "lint call: got $(cat "$calls"), want $want_calls"
fi

STUB_VERSION=v$pin run_lint "$stub_bin"
expect "a v-prefixed go-install version matches the pin" 0 "is clean"

STUB_VERSION=$pin STUB_EXIT=1 run_lint "$stub_bin"
expect "findings fail with actionlint's exit code" 1 "stub: finding"
if [[ "$output" == *"is clean"* ]]; then fail "findings run still printed the clean line"; fi

# --- Real actionlint -----------------------------------------------------------

real_actionlint=$(command -v actionlint 2>/dev/null || true)
real_shellcheck=$(command -v shellcheck 2>/dev/null || true)
real_version=
if [ -n "$real_actionlint" ]; then
  real_version=$("$real_actionlint" --version 2>/dev/null | sed -n '1{s/^v//;p;}' || true)
fi
if [ -z "$real_shellcheck" ] || [ "$real_version" != "$pin" ]; then
  if [ "${REQUIRE_ACTIONLINT:-0}" = 1 ]; then
    fail "REQUIRE_ACTIONLINT=1 but actionlint $pin (found '${real_version:-none}') or shellcheck ('${real_shellcheck:-none}') is missing"
  else
    echo "skip: real-actionlint cases (needs actionlint $pin and shellcheck; REQUIRE_ACTIONLINT=1 forbids the skip)"
  fi
else
  real_bin=$temp_dir/real-bin
  mkdir -p "$real_bin"
  ln -s "$real_actionlint" "$real_bin/actionlint"
  ln -s "$real_shellcheck" "$real_bin/shellcheck"
  git -C "$fake" init -q

  write_workflow() {
    rm -f "$fake"/.github/workflows/*.yml
    cat >"$fake/.github/workflows/$1"
  }

  write_workflow labels.yml <<'YAML'
on: push
jobs:
  cache:
    runs-on: [self-hosted, intent-cache]
    steps:
      - run: echo default
  cache-xl:
    runs-on: [self-hosted, intent-cache-xl]
    steps:
      - run: echo xl
  cache-small:
    runs-on: [self-hosted, intent-cache-small]
    steps:
      - run: echo small
YAML
  run_lint "$real_bin"
  expect "real: intent-cache runner labels are known" 0 "is clean"

  write_workflow broken.yml <<'YAML'
on: push
jobs:
  broken:
    runs-on: [self-hosted, not-a-runner-label]
    steps:
      - run: echo "${{ github.no_such_property }}"
YAML
  run_lint "$real_bin"
  expect "real: an unknown runner label fails" 1 'label "not-a-runner-label" is unknown'
  expect "real: a bad expression fails" 1 'property "no_such_property" is not defined'

  write_workflow shell.yml <<'YAML'
on: push
jobs:
  shell:
    runs-on: ubuntu-24.04
    steps:
      - run: echo $UNQUOTED_VAR
YAML
  run_lint "$real_bin"
  expect "real: run: scripts get shellcheck" 1 "SC2086"

  # The job.workflow_* ignore is scoped to consumer-checks.yml: the same
  # expression in any other workflow still fails.
  workflow_sha_job='on: push
jobs:
  checkout:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "$REF"
        env:
          REF: ${{ job.workflow_sha || job.workflow_repository }}'
  printf '%s\n' "$workflow_sha_job" | write_workflow consumer-checks.yml
  run_lint "$real_bin"
  expect "real: job.workflow_* is ignored in consumer-checks.yml" 0 "is clean"
  printf '%s\n' "$workflow_sha_job" | write_workflow other.yml
  run_lint "$real_bin"
  expect "real: job.workflow_* still fails outside consumer-checks.yml" 1 'property "workflow_sha" is not defined'
fi

if [ "$failures" -ne 0 ]; then
  echo "lint-workflows test: $failures failure(s)" >&2
  exit 1
fi
echo "lint-workflows test: all cases passed"
