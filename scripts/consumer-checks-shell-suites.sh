#!/usr/bin/env bash
#
# Decide whether monorepo-consumer-checks runs the changed-tests shell suites
# (scripts/rust-changed-tests.test.sh and intentd's scripts/test-changed-tests.sh)
# for an intentd caller. Those suites otherwise run only in the monorepo merge
# queue, so an intentd change to the scripts they drive surfaced as a failed
# rolling pin bump instead of on its own PR: intentd#2720 added an `env` call
# that the monorepo stub PATH did not allow, and intent#7900 was ejected from
# the queue five times until intent#7905.
#
# Selects when the caller's own change touches a watched file: the diff from
# BASE_SHA (the PR base, or the merge group's base) to TEST_SHA (the commit
# GitHub tests: the PR's test-merge commit, or the merge group head), both
# fetched into packages/intentd. Comparing that merge commit rather than the
# branch head keeps a stale branch that never touched the scripts unselected.
# Also selects when SELF_TEST is true (the monorepo's own exercise of this
# workflow), or when the comparison cannot be made: a missing SHA or a failed
# fetch never becomes a skip. Other components never select.
#
# Writes selected=true|false and reason=<text> to $GITHUB_OUTPUT.
# Must parse and run under Bash 3.2 (stock macOS).

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
component=${COMPONENT:?COMPONENT is required}
self_test=${SELF_TEST:-false}
base=${BASE_SHA:-}
test_sha=${TEST_SHA:-}
intentd_dir=${INTENTD_DIR:-packages/intentd}
# The scripts under test, intentd's own suite and the files the two suites
# copy or name: rust-changed-tests.test.sh copies the Makefile and expects
# test-without-provider-clis.sh in runner argv; test-changed-tests.sh copies
# coverage-storage.py.
watched="scripts/changed-tests.sh scripts/with-test-policy.sh scripts/test-changed-tests.sh
scripts/coverage-storage.py scripts/test-without-provider-clis.sh Makefile"

decide() {
  printf 'selected=%s\nreason=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  if [ "$1" = true ]; then
    echo "consumer-checks-shell-suites: running the changed-tests shell suites: $2"
  else
    echo "consumer-checks-shell-suites: skipping the changed-tests shell suites: $2"
  fi
  exit 0
}

# A comparison that cannot be made still runs the suites, with a notice.
unknown() {
  echo "::notice::consumer-checks-shell-suites: $1; running the changed-tests shell suites to be safe"
  decide true "$1"
}

is_sha() {
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

[ "$component" = intentd ] || decide false "component $component does not own the changed-tests scripts"
[ "$self_test" = true ] && decide true "self-test exercises every step"

is_sha "$base" || unknown "no base commit for this event"
is_sha "$test_sha" || unknown "no tested commit for this event"

for sha in "$base" "$test_sha"; do
  if ! git -C "$intentd_dir" cat-file -e "$sha^{commit}" 2>/dev/null; then
    git -C "$intentd_dir" fetch --quiet --no-tags --depth=1 origin "$sha" 2>&1 ||
      unknown "could not fetch intentd commit ${sha:0:12}"
  fi
done

status=0
# shellcheck disable=SC2086 # $watched is a fixed list of literal paths.
git -C "$intentd_dir" diff --quiet "$base" "$test_sha" -- $watched || status=$?
case "$status" in
  0) decide false "this change does not touch the watched changed-tests files" ;;
  1)
    # shellcheck disable=SC2086
    changed=$(git -C "$intentd_dir" diff --name-only "$base" "$test_sha" -- $watched | tr '\n' ' ')
    decide true "this change touches ${changed% }"
    ;;
  *) unknown "could not compare ${base:0:12} with ${test_sha:0:12}" ;;
esac
