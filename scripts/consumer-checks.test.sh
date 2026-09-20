#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
script=$repo_root/scripts/consumer-checks.sh
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

# The fixtures below run consumer-checks.sh under $script_bash against a
# stubbed make and append every exit code + output to $transcript, so a rerun
# under another interpreter (see the Bash 3 section at the end) can be
# compared byte for byte.
script_bash=${CONSUMER_CHECKS_TEST_BASH:-$BASH}
transcript=${CONSUMER_CHECKS_TEST_TRANSCRIPT:-$temp_dir/transcript}
: >"$transcript"

fail() {
  echo "consumer-checks test failed: $*" >&2
  exit 1
}

mkdir -p "$temp_dir/scripts" "$temp_dir/bin"
cp "$script" "$temp_dir/scripts/consumer-checks.sh"
stub_log=$temp_dir/make.log

# The stub logs its argv and fails when its last argument (the target) is in
# STUB_FAIL, so a run can pick which checks are red.
cat >"$temp_dir/bin/make" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$STUB_LOG"
for target in "$@"; do :; done
echo "stub make: $target"
for failing in ${STUB_FAIL:-}; do
  if [ "$failing" = "$target" ]; then
    echo "stub make: $target failed" >&2
    exit 2
  fi
done
EOF
chmod +x "$temp_dir/bin/make"

# run_check [STUB_FAIL=<targets>] [CONSUMER_CHECKS_ADVISORY=<targets>]
#           [CONSUMER_CHECKS_CONTEXT=<name>] <script args...>
run_check() {
  local status=0 stub_fail="" env_advisory="" env_context=""
  while :; do
    case "${1:-}" in
      STUB_FAIL=*) stub_fail=${1#*=} ;;
      CONSUMER_CHECKS_ADVISORY=*) env_advisory=${1#*=} ;;
      CONSUMER_CHECKS_CONTEXT=*) env_context=${1#*=} ;;
      *) break ;;
    esac
    shift
  done
  : >"$stub_log"
  check_output=$(cd "$temp_dir" && STUB_LOG="$stub_log" STUB_FAIL="$stub_fail" MAKE="$temp_dir/bin/make" \
    CONSUMER_CHECKS_ADVISORY="$env_advisory" CONSUMER_CHECKS_CONTEXT="$env_context" \
    "$script_bash" scripts/consumer-checks.sh "$@" 2>&1) || status=$?
  printf 'exit %s\n%s\n' "$status" "$check_output" >>"$transcript"
  return "$status"
}

all_checks="event-catalog-check check-mcp-bindings docs-check check-protocol-catalog check-makefile-targets check-protocol-field-parity"
expect_all_ran() {
  local target
  for target in $all_checks; do
    grep -q "^stub make: $target\$" <<<"$check_output" || fail "$1: $target did not run: $check_output"
  done
}

if ! run_check; then
  fail "all-green run exited non-zero: $check_output"
fi
expect_all_ran "all-green run"
grep -q -- '--no-print-directory RUSTUP_CARGO= -o event-catalog-check -o check-mcp-bindings docs-check$' "$stub_log" ||
  fail "docs-check was not invoked with its prerequisites assumed old: $(cat "$stub_log")"
[ "$(grep -c . "$stub_log")" -eq 6 ] || fail "expected 6 make invocations: $(cat "$stub_log")"
# The Makefile prepends the rust-toolchain.toml toolchain's bin/ to every
# recipe's PATH; upstream that file is the caller's PR head, so every make
# call must empty the probe on its command line (see the real-make run below).
[ "$(grep -c -- '--no-print-directory RUSTUP_CARGO= ' "$stub_log")" -eq 6 ] ||
  fail "not every make invocation carries the RUSTUP_CARGO= override: $(cat "$stub_log")"
grep -q -- '--no-print-directory RUSTUP_CARGO= check-makefile-targets$' "$stub_log" ||
  fail "monorepo context did not run check-makefile-targets at the pinned gitlink: $(cat "$stub_log")"
grep -q 'CHECK_MAKEFILE_TARGETS_GITLINK' "$stub_log" &&
  fail "monorepo context overrode the check-makefile-targets gitlink: $(cat "$stub_log")"
[ "$(grep -c '^  [a-z-]*  *pass  ' <<<"$check_output")" -eq 6 ] ||
  fail "summary table did not list 6 passing rows: $check_output"
grep -q '::warning::' <<<"$check_output" && fail "all-green run printed a warning: $check_output"
grep -q '^Fix order:' <<<"$check_output" && fail "monorepo context printed the upstream fix-order line: $check_output"
[ "$(tail -n 1 <<<"$check_output")" = "consumer-checks: all checks passed" ] ||
  fail "all-green run did not end with the pass line: $check_output"

if run_check STUB_FAIL=check-protocol-catalog; then
  fail "non-advisory failure was accepted"
fi
expect_all_ran "non-advisory failure"
grep -q '^  check-protocol-catalog  *FAIL  *docs/protocol/05-method-catalog.md + docs/protocol/methods/\*.md$' <<<"$check_output" ||
  fail "failed row did not name the catalog fix path: $check_output"
grep -q '^  event-catalog-check  *pass  *docs/protocol/event-types.json + docs/protocol/06-events.md$' <<<"$check_output" ||
  fail "passing row did not keep its fix path: $check_output"
grep -q '::warning::' <<<"$check_output" && fail "non-advisory failure printed a warning: $check_output"
[ "$(tail -n 1 <<<"$check_output")" = "consumer-checks: FAILED" ] ||
  fail "failed run did not end with the FAILED line: $check_output"

if ! run_check STUB_FAIL=check-mcp-bindings --advisory=check-mcp-bindings; then
  fail "advisory failure changed the exit code: $check_output"
fi
expect_all_ran "advisory failure"
grep -q "^::warning::consumer check 'check-mcp-bindings' failed (advisory); fix in the monorepo: docs/protocol/methods/mcp-bindings.md (make mcp-bindings-doc)" <<<"$check_output" ||
  fail "advisory failure did not print the warning with its fix path: $check_output"
grep -q '^  check-mcp-bindings  *warn  *docs/protocol/methods/mcp-bindings.md' <<<"$check_output" ||
  fail "advisory row was not marked warn: $check_output"
grep -q '^  docs-check  *pass  ' <<<"$check_output" ||
  fail "docs-check row was affected by the advisory check-mcp-bindings failure: $check_output"

if ! run_check STUB_FAIL=check-mcp-bindings --advisory "check-mcp-bindings event-catalog-check"; then
  fail "space-separated --advisory list was rejected: $check_output"
fi

if ! run_check STUB_FAIL=check-mcp-bindings CONSUMER_CHECKS_ADVISORY=check-mcp-bindings; then
  fail "CONSUMER_CHECKS_ADVISORY was not honored: $check_output"
fi
grep -q '^  check-mcp-bindings  *warn  ' <<<"$check_output" || fail "env advisory run lost the warn row: $check_output"

if run_check "STUB_FAIL=check-mcp-bindings docs-check" --advisory=check-mcp-bindings; then
  fail "non-advisory failure alongside an advisory one was accepted"
fi
grep -q '^  check-mcp-bindings  *warn  ' <<<"$check_output" || fail "mixed run lost the warn row: $check_output"
grep -q '^  docs-check  *FAIL  *AGENTS.md / README.md / docs/fe/DEVELOPER_GUIDE.md' <<<"$check_output" ||
  fail "mixed run did not fail the docs-check row with its fix path: $check_output"

if run_check --advisory=not-a-check; then
  fail "unknown advisory target was accepted"
fi
grep -q "unknown advisory target 'not-a-check'" <<<"$check_output" || fail "unknown advisory target was not named: $check_output"
[ "$(grep -c . "$stub_log")" -eq 0 ] || fail "unknown advisory target still ran checks"

if ! run_check --context upstream; then
  fail "upstream context run exited non-zero: $check_output"
fi
[ "$(tail -n 1 <<<"$check_output")" = "Fix order: additions land the monorepo docs change first (docs may lead the pin); removals land the component first and drop the docs entry after the bump; then re-run this job." ] ||
  fail "upstream context did not end with the fix-order line: $check_output"
[ "$(grep -c '^Fix order:' <<<"$check_output")" -eq 1 ] || fail "fix-order line printed more than once: $check_output"
# Upstream, packages/intentd is the caller's PR head rather than the pin, so
# check-makefile-targets must read that head instead of the monorepo gitlink.
grep -q -- '--no-print-directory RUSTUP_CARGO= CHECK_MAKEFILE_TARGETS_GITLINK=HEAD check-makefile-targets$' "$stub_log" ||
  fail "upstream context did not point check-makefile-targets at the caller head: $(cat "$stub_log")"
[ "$(grep -c 'CHECK_MAKEFILE_TARGETS_GITLINK' "$stub_log")" -eq 1 ] ||
  fail "the gitlink override leaked into another make invocation: $(cat "$stub_log")"

if run_check STUB_FAIL=docs-check CONSUMER_CHECKS_CONTEXT=upstream; then
  fail "upstream context masked a non-advisory failure"
fi
[ "$(tail -n 1 <<<"$check_output")" = "Fix order: additions land the monorepo docs change first (docs may lead the pin); removals land the component first and drop the docs entry after the bump; then re-run this job." ] ||
  fail "CONSUMER_CHECKS_CONTEXT=upstream did not end a failed run with the fix-order line: $check_output"
grep -q -- 'CHECK_MAKEFILE_TARGETS_GITLINK=HEAD check-makefile-targets$' "$stub_log" ||
  fail "CONSUMER_CHECKS_CONTEXT=upstream did not point check-makefile-targets at the caller head: $(cat "$stub_log")"

if run_check --context=elsewhere; then
  fail "unknown context was accepted"
fi
grep -q "unknown context 'elsewhere'" <<<"$check_output" || fail "unknown context was not named: $check_output"

if run_check --bogus; then
  fail "unknown argument was accepted"
fi
grep -q "unknown argument '--bogus'" <<<"$check_output" || fail "unknown argument was not named: $check_output"

# Real make against a copy of the repo Makefile. The Makefile resolves cargo
# from packages/intentd/rust-toolchain.toml (`rustup which cargo`) and puts
# that toolchain's bin/ first on every recipe's PATH. Upstream that file is the
# caller's PR head, so a `[toolchain] path = <dir>` entry there names a bin/
# the caller controls: without the RUSTUP_CARGO= override every
# `node scripts/...` recipe ran the caller's node and a failing trusted checker
# came back green. The fixture's trusted PATH carries a node that fails
# check-protocol-catalog, a rustup stub that answers `which cargo` from that
# path entry (as rustup does for a path toolchain), and marker cargo/node
# executables in the attacker dir. CARGO_BIN_DIR is the Makefile's other PATH
# prepend (default ~/.cargo/bin); pointing it at the trusted dir keeps the
# host's tools out of the run.
make_bin=$(command -v make 2>/dev/null) || fail "make not found; the real-make consumer run needs it"
fixture=$temp_dir/real-make
mkdir -p "$fixture/scripts" "$fixture/packages/intentd" "$fixture/packages/cloudlands-fe" \
  "$fixture/attacker/bin" "$fixture/trusted/bin"
cp "$repo_root/Makefile" "$fixture/Makefile"
cp "$script" "$fixture/scripts/consumer-checks.sh"
# The ensure-*-submodule prerequisites only look for the .git entry.
: >"$fixture/packages/intentd/.git"
: >"$fixture/packages/cloudlands-fe/.git"
printf '[toolchain]\npath = "%s"\n' "$fixture/attacker" >"$fixture/packages/intentd/rust-toolchain.toml"
marker_log=$fixture/marker.log
trusted_log=$fixture/trusted.log
for tool in cargo node; do
  printf '#!/bin/sh\necho "attacker %s $*" >>"%s"\n' "$tool" "$marker_log" >"$fixture/attacker/bin/$tool"
done
# A metacharacter-free recipe like `node scripts/x.mjs` skips the shell: stock
# GNU make execvp()s it against the recipe PATH (attacker node runs), while
# Apple's make posix_spawnp()s it, which searches the parent's PATH (trusted
# node runs with the attacker dir still first on its PATH). The trusted node
# records that second shape so the control and the hardened assertion observe
# the recipe PATH itself on both.
cat >"$fixture/trusted/bin/node" <<EOF
#!/bin/sh
echo "trusted node \$*" >>"$trusted_log"
case ":\$PATH:" in
  *":$fixture/attacker/bin:"*|*":$fixture/attacker/bin/:"*)
    echo "attacker bin on recipe PATH: node \$*" >>"$marker_log" ;;
esac
case "\$1" in
  scripts/check-protocol-catalog.mjs) echo "trusted checker: catalog drift" >&2; exit 1 ;;
esac
EOF
cat >"$fixture/trusted/bin/rustup" <<'EOF'
#!/bin/sh
[ "$1" = which ] && [ "$2" = cargo ] || exit 1
toolchain_path=$(sed -n 's/^path = "\(.*\)"$/\1/p' rust-toolchain.toml)
[ -n "$toolchain_path" ] || exit 1
echo "$toolchain_path/bin/cargo"
EOF
printf '#!/bin/sh\necho "trusted docs-check" >>"%s"\n' "$trusted_log" >"$fixture/scripts/docs-check.sh"
chmod +x "$fixture/attacker/bin/cargo" "$fixture/attacker/bin/node" "$fixture/trusted/bin/node" \
  "$fixture/trusted/bin/rustup" "$fixture/scripts/docs-check.sh"
run_real_make() {
  : >"$marker_log"
  : >"$trusted_log"
  real_status=0
  real_output=$(cd "$fixture" && PATH="$fixture/trusted/bin:$PATH" CARGO_BIN_DIR="$fixture/trusted/bin" \
    "$@" 2>&1) || real_status=$?
}
# Control: without the override this make puts the attacker's bin first on the
# recipe PATH (and runs the attacker's node where the recipe is execvp()ed), so
# the assertions on the runner below are not vacuous.
run_real_make "$make_bin" --no-print-directory check-protocol-catalog
grep -q -e '^attacker node scripts/check-protocol-catalog.mjs$' \
  -e '^attacker bin on recipe PATH: node scripts/check-protocol-catalog.mjs$' "$marker_log" ||
  fail "fixture control: an unhardened make did not expose the attacker's bin to the recipe (rustup stub or Makefile PATH prepend changed?); exit $real_status:"$'\n'"$real_output"$'\n'"$(cat "$marker_log")"
run_real_make env MAKE="$make_bin" "$script_bash" scripts/consumer-checks.sh --context upstream
[ "$real_status" -eq 1 ] ||
  fail "real-make run exited $real_status (expected 1: the trusted check-protocol-catalog fails):"$'\n'"$real_output"
[ ! -s "$marker_log" ] ||
  fail "a caller-controlled toolchain executable ran under consumer-checks:"$'\n'"$(cat "$marker_log")"$'\n'"$real_output"
grep -q '^trusted node scripts/check-protocol-catalog.mjs$' "$trusted_log" ||
  fail "the trusted node did not run check-protocol-catalog:"$'\n'"$(cat "$trusted_log")"
[ "$(grep -c '^trusted node ' "$trusted_log")" -eq 5 ] ||
  fail "expected the 5 node checks to run the trusted node:"$'\n'"$(cat "$trusted_log")"
grep -q '^trusted docs-check$' "$trusted_log" || fail "docs-check.sh did not run:"$'\n'"$(cat "$trusted_log")"
grep -q '^  check-protocol-catalog  *FAIL  ' <<<"$real_output" ||
  fail "the trusted checker's failure did not reach the summary table:"$'\n'"$real_output"
[ "$(grep -c '^  [a-z-]*  *pass  ' <<<"$real_output")" -eq 5 ] ||
  fail "real-make run did not list the other 5 checks as pass:"$'\n'"$real_output"

# The reusable workflow pipes the runner through `tee`, so its step must run
# under GitHub's `shell: bash` (`bash --noprofile --norc -eo pipefail {0}`);
# the default `run` shell is `bash -e` only and would report tee's exit 0.
# Extract the step as written and execute its body under that shell against
# a stubbed runner: a failing runner must fail the step with the summary
# still appended, a passing one must exit 0.
workflow=$repo_root/.github/workflows/consumer-checks.yml
# workflow_step <name> prints that step's YAML block.
workflow_step() {
  awk -v name="$1" '
    /^      - / { in_step = index($0, "- name: " name) > 0 }
    in_step { print }
  ' "$workflow"
}

# The monorepo checkout must pin the reusable workflow's own commit via the
# `job` context. `github.job_workflow_sha` / `github.job_workflow_ref` are OIDC
# claims, not `github` context properties, and evaluate to "" in expressions
# (cloudlands-fe#2702 silently ran the `main` fallback).
grep -nE '^[^#]*github\.job_workflow_(sha|ref)' "$workflow" &&
  fail "consumer-checks.yml references github.job_workflow_*; use job.workflow_sha / job.workflow_repository (see the lines above)"
checkout_block=$(workflow_step "Check out the monorepo at this workflow's commit")
[[ -n "$checkout_block" ]] || fail "monorepo checkout step not found in $workflow"
grep -q '^        id: monorepo$' <<<"$checkout_block" || fail "monorepo checkout step lost its id:"$'\n'"$checkout_block"
grep -qE "^          ref: \\$\\{\\{ job\\.workflow_sha \\|\\| 'main' \\}\\}$" <<<"$checkout_block" ||
  fail "monorepo checkout step must use ref: \${{ job.workflow_sha || 'main' }}:"$'\n'"$checkout_block"
grep -qE "^          repository: \\$\\{\\{ job\\.workflow_repository \\|\\| 'intent-hq/intent' \\}\\}$" <<<"$checkout_block" ||
  fail "monorepo checkout step must use repository: \${{ job.workflow_repository || 'intent-hq/intent' }}:"$'\n'"$checkout_block"

# Workflow contract the callers rely on: a `workflow_call` trigger and nothing
# else, `contents: read` as the only permission (the callers pass no secrets
# and the job never writes), and the fail-soft monorepo checkout — the
# checkout continues on error, a guard step warns when it did not succeed,
# and every later step is gated on its success so a monorepo outage yields a
# green job with a ::warning:: instead of a red caller PR.
triggers=$(awk '/^on:/ { on = 1; next } /^jobs:/ { on = 0 } on && /^  [a-z_]+:/ { sub(/^  /, ""); sub(/:.*/, ""); print }' "$workflow")
[ "$triggers" = "workflow_call" ] || fail "consumer-checks.yml must be triggered by workflow_call only; found: $triggers"
permissions=$(awk '
  /^[[:blank:]]*permissions:/ {
    indent = match($0, /[^ ]/)
    in_block = 1
    if ($0 !~ /permissions:[[:blank:]]*$/) print "inline " $0
    next
  }
  in_block {
    if (match($0, /[^ ]/) > indent) { sub(/^[[:blank:]]*/, ""); print } else { in_block = 0 }
  }
' "$workflow")
[ "$permissions" = "contents: read" ] ||
  fail "consumer-checks.yml must grant exactly 'permissions: contents: read'; found:"$'\n'"${permissions:-<none>}"
grep -q '^        continue-on-error: true$' <<<"$checkout_block" ||
  fail "monorepo checkout step lost continue-on-error: true (the job must stay green when the monorepo cannot be checked out):"$'\n'"$checkout_block"
guard_name='Skip when the monorepo checkout failed'
guard_block=$(workflow_step "$guard_name")
[[ -n "$guard_block" ]] || fail "workflow step '$guard_name' not found in $workflow"
grep -q "^        if: steps\.monorepo\.outcome != 'success'$" <<<"$guard_block" ||
  fail "guard step must run when steps.monorepo.outcome != 'success':"$'\n'"$guard_block"
grep -qE "^          MONOREPO_REF: \\$\\{\\{ job\\.workflow_sha \\|\\| 'main' \\}\\}$" <<<"$guard_block" ||
  fail "guard step must name the same ref the checkout used (MONOREPO_REF: \${{ job.workflow_sha || 'main' }}):"$'\n'"$guard_block"
guard_body=$(awk 'body { sub(/^          /, ""); print } /^        run: \|$/ { body = 1 }' <<<"$guard_block")
[[ -n "$guard_body" ]] || fail "guard step has no run body:"$'\n'"$guard_block"
grep -q '\${{' <<<"$guard_body" && fail "guard step run body has an unsubstituted expression:"$'\n'"$guard_body"
printf '%s\n' "$guard_body" >"$temp_dir/guard.sh"
# GitHub's default `run` shell is `bash -e {0}`; the guard's exit code is the
# job's, so the body must succeed and emit exactly the ::warning:: line, for a
# resolved workflow sha and for the `main` fallback alike.
for monorepo_ref in 0123456789abcdef0123456789abcdef01234567 main; do
  guard_status=0
  guard_output=$(MONOREPO_REF="$monorepo_ref" bash --noprofile --norc -e "$temp_dir/guard.sh" 2>&1) || guard_status=$?
  [ "$guard_status" -eq 0 ] || fail "guard step exited $guard_status for MONOREPO_REF=$monorepo_ref:"$'\n'"$guard_output"
  [ "$guard_output" = "::warning::consumer-checks: could not check out intent-hq/intent@${monorepo_ref:0:7}; skipping the monorepo consumer checks for this run." ] ||
    fail "guard step output for MONOREPO_REF=$monorepo_ref:"$'\n'"$guard_output"
done
gate_line="        if: steps.monorepo.outcome == 'success'"
downstream_gates=$(awk -v gate="$gate_line" -v guard="- name: $guard_name" '
  function flush() { if (after_guard && name != "") print (gated ? "gated " : "ungated ") name }
  /^      - / {
    flush()
    name = $0
    sub(/^      - (name: )?/, "", name)
    gated = 0
    if (guard_seen) after_guard = 1
    if (index($0, guard)) guard_seen = 1
    next
  }
  $0 == gate { gated = 1 }
  END { flush() }
' "$workflow")
grep -q '^ungated ' <<<"$downstream_gates" &&
  fail "every step after the guard must carry \"$gate_line\":"$'\n'"$downstream_gates"
[ "$(grep -c '^gated ' <<<"$downstream_gates")" -eq 4 ] ||
  fail "expected 4 gated steps after the guard (component checkout, sibling submodule, setup-node, runner):"$'\n'"$downstream_gates"

step_name='Run the consumer checks (upstream context)'
step_block=$(workflow_step "$step_name")
[[ -n "$step_block" ]] || fail "workflow step '$step_name' not found in $workflow"
grep -q '^        shell: bash$' <<<"$step_block" ||
  fail "workflow step '$step_name' does not declare 'shell: bash' (its piped run body needs pipefail):"$'\n'"$step_block"
grep -q '| tee ' <<<"$step_block" || fail "workflow step '$step_name' no longer pipes the runner; update this test"
run_body=$(awk 'body { sub(/^          /, ""); print } /^        run: \|$/ { body = 1 }' <<<"$step_block" |
  sed 's/\${{ github\.repository }}/intent-hq\/intentd/g')
grep -q '\${{' <<<"$run_body" && fail "workflow run body has an unsubstituted expression:"$'\n'"$run_body"
step_dir=$temp_dir/workflow-step
mkdir -p "$step_dir/scripts" "$step_dir/tmp"
printf '%s\n' "$run_body" >"$step_dir/step.sh"
# The body names the checked-out monorepo commit (`git rev-parse --short HEAD`
# in the workspace root), so the fixture is a repository with one commit.
git -C "$step_dir" init -q
git -C "$step_dir" -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m fixture
monorepo_short=$(git -C "$step_dir" rev-parse --short HEAD)
cat >"$step_dir/scripts/consumer-checks.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >"$STUB_ARGS"
echo "==> make stub-check"
echo "consumer-checks summary"
echo "  stub-check  FAIL  stub/fix/path"
echo "consumer-checks: ${STUB_RESULT}"
exit "${STUB_STATUS}"
EOF
chmod +x "$step_dir/scripts/consumer-checks.sh"
# run_step <status> <result word>; sets step_status and step_summary.
run_step() {
  local summary=$step_dir/summary.md
  : >"$summary"
  step_status=0
  step_output=$(cd "$step_dir" && STUB_ARGS="$step_dir/args" STUB_STATUS="$1" STUB_RESULT="$2" \
    RUNNER_TEMP="$step_dir/tmp" GITHUB_STEP_SUMMARY="$summary" HEAD_SHA=0123456789abcdef \
    bash --noprofile --norc -eo pipefail step.sh 2>&1) || step_status=$?
  step_summary=$(cat "$summary")
}
run_step 1 FAILED
[ "$step_status" -eq 1 ] ||
  fail "workflow step exited $step_status for a failing runner (expected 1):"$'\n'"$step_output"
[ "$(cat "$step_dir/args")" = "--context upstream --advisory=check-mcp-bindings" ] ||
  fail "workflow step invoked the runner with unexpected arguments: $(cat "$step_dir/args")"
grep -q "^### monorepo-consumer-checks — intent-hq/intentd@0123456 vs intent-hq/intent@$monorepo_short\$" <<<"$step_summary" ||
  fail "failed step did not write the summary heading:"$'\n'"$step_summary"
grep -q '^consumer-checks: FAILED$' <<<"$step_summary" ||
  fail "failed step did not append the runner's summary table:"$'\n'"$step_summary"
grep -q '^==> make stub-check$' <<<"$step_summary" &&
  fail "step summary included runner output above the summary table:"$'\n'"$step_summary"
run_step 0 "all checks passed"
[ "$step_status" -eq 0 ] ||
  fail "workflow step exited $step_status for a passing runner (expected 0):"$'\n'"$step_output"
grep -q '^consumer-checks: all checks passed$' <<<"$step_summary" ||
  fail "passing step did not append the runner's summary table:"$'\n'"$step_summary"

echo "consumer-checks tests passed under $("$script_bash" -c 'echo "bash $BASH_VERSION"')"
[[ -z "${CONSUMER_CHECKS_TEST_BASH:-}" ]] || exit 0

# Stock macOS /bin/bash is 3.2 (intent-hq/intent#4759). `bash -n` alone
# accepts Bash 4+ builtins and expansions, so reject them by pattern too,
# then rerun the fixtures under a real Bash 3 when one can be found (same
# lookup as docs-check.test.sh: BASH3_BIN, bash3, Homebrew bash@3, 3.x
# /bin/bash) and require a byte-identical transcript. A missing Bash 3 is a
# skip notice by default; set REQUIRE_BASH3 to a non-empty value (CI) to make
# it a failure instead.
bash -n "$script" || fail "consumer-checks.sh does not parse"
bash -n "${BASH_SOURCE[0]}" || fail "consumer-checks.test.sh does not parse"
bash4_constructs='(^|[^A-Za-z0-9_])(declare|local|typeset)([[:blank:]]+-[A-Za-z]+)*[[:blank:]]+-[A-Za-z]*[An][A-Za-z]*([^A-Za-z]|$)|(^|[^A-Za-z0-9_])(mapfile|readarray|coproc)([^A-Za-z0-9_]|$)|\$\{([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[@*#?!$-])(\[[^]]*\])?(\^\^?|,,?)[^}]*\}|&>>|\|&|;;?&'
# Full-line comments and the pattern itself are not scanned.
gate_matches() {
  grep -nE "$bash4_constructs" "$@" | grep -vE '^([^:]*:)?[0-9]+:[[:blank:]]*#' |
    grep -v -F -e 'bash4_constructs' || true
}
gate_hits=$(gate_matches "$script" "${BASH_SOURCE[0]}")
[[ -z "$gate_hits" ]] || fail "Bash 4+ constructs found (stock macOS bash is 3.2):"$'\n'"$gate_hits"

find_bash3() {
  local candidate resolved brew_prefix
  brew_prefix=$(brew --prefix bash@3 2>/dev/null) || brew_prefix=""
  for candidate in "${BASH3_BIN:-}" bash3 "${brew_prefix:+$brew_prefix/bin/bash}" \
    /opt/homebrew/opt/bash@3/bin/bash /usr/local/opt/bash@3/bin/bash /bin/bash; do
    [[ -n "$candidate" ]] || continue
    resolved=$(command -v "$candidate" 2>/dev/null) || continue
    [[ -x "$resolved" ]] || continue
    "$resolved" -c '[[ "${BASH_VERSINFO[0]}" -eq 3 ]]' 2>/dev/null || continue
    printf '%s\n' "$resolved"
    return 0
  done
  return 1
}

if [[ "${BASH_VERSINFO[0]}" -eq 3 ]]; then
  : # the fixtures above already ran under Bash 3
elif bash3=$(find_bash3); then
  bash3_transcript=$temp_dir/bash3-transcript
  CONSUMER_CHECKS_TEST_BASH="$bash3" CONSUMER_CHECKS_TEST_TRANSCRIPT="$bash3_transcript" \
    "$bash3" "${BASH_SOURCE[0]}"
  cmp -s "$transcript" "$bash3_transcript" ||
    fail "consumer-checks.sh output differs between bash $BASH_VERSION and $bash3:"$'\n'"$(diff "$transcript" "$bash3_transcript" || true)"
  echo "consumer-checks.sh output is identical under bash $BASH_VERSION and $bash3"
elif [[ -n "${REQUIRE_BASH3:-}" ]]; then
  fail "no Bash 3 interpreter found and REQUIRE_BASH3 is set (point BASH3_BIN at one, or unset REQUIRE_BASH3 to skip the real 3.2 run)"
else
  echo "consumer-checks tests: no Bash 3 interpreter found (set BASH3_BIN); real 3.2 run skipped, static gate only"
fi
