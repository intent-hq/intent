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
# Run from the monorepo checkout with the caller head at packages/intentd.
# Selects when scripts/changed-tests.sh or scripts/with-test-policy.sh differ
# between that head and the intentd commit the monorepo pins (the suites are
# known to pass at the pin), when SELF_TEST is true (the monorepo's own
# exercise of this workflow), or when the comparison cannot be made: a failed
# read or fetch never becomes a skip. Other components never select.
#
# Writes selected=true|false and reason=<text> to $GITHUB_OUTPUT.
# Must parse and run under Bash 3.2 (stock macOS).

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
component=${COMPONENT:?COMPONENT is required}
self_test=${SELF_TEST:-false}
intentd_dir=${INTENTD_DIR:-packages/intentd}
watched="scripts/changed-tests.sh scripts/with-test-policy.sh"

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

[ "$component" = intentd ] || decide false "component $component does not own the changed-tests scripts"
[ "$self_test" = true ] && decide true "self-test exercises every step"

pin=$(git ls-tree HEAD -- "$intentd_dir" 2>/dev/null | awk '$2 == "commit" { print $3 }') || pin=""
[ -n "$pin" ] || unknown "no intentd gitlink at $intentd_dir in the monorepo tree"

if ! git -C "$intentd_dir" cat-file -e "$pin^{commit}" 2>/dev/null; then
  git -C "$intentd_dir" fetch --quiet --no-tags --depth=1 origin "$pin" 2>&1 ||
    unknown "could not fetch the pinned intentd commit ${pin:0:12}"
fi

status=0
# shellcheck disable=SC2086 # $watched is a fixed list of literal paths.
git -C "$intentd_dir" diff --quiet "$pin" HEAD -- $watched || status=$?
case "$status" in
  0) decide false "$watched match the pinned intentd ${pin:0:12}" ;;
  1)
    # shellcheck disable=SC2086
    changed=$(git -C "$intentd_dir" diff --name-only "$pin" HEAD -- $watched | tr '\n' ' ')
    decide true "${changed% } differ from the pinned intentd ${pin:0:12}"
    ;;
  *) unknown "could not compare the caller head with the pinned intentd ${pin:0:12}" ;;
esac
