#!/usr/bin/env bash
#
# Explain a failed consumer-checks rerun that reused an old monorepo commit.
# Runs in the monorepo checkout of .github/workflows/consumer-checks.yml after
# a failed step.
#
# GitHub pins a reusable workflow's SHA on "Re-run failed jobs" (and on
# re-running one job), so a component caller on @main keeps checking against
# the monorepo commit its first attempt resolved. When the fix was a monorepo
# docs PR that merged after that attempt, the rerun fails the same way. On
# intentd#2825 (run 41041440483) a rerun at 13:43 UTC still used monorepo
# 981c54d3, two minutes after docs PR #8110 merged, and cost a CI cycle.
#
# Inputs (environment):
#   RUN_ATTEMPT  github.run_attempt; attempt 1 is never a stale rerun.
#   MAIN_REF     ref holding the current monorepo main (default origin/main;
#                the checkout uses fetch-depth 0, so it is fetched).
# Prints one ::error:: annotation when this is a rerun and HEAD is strictly
# behind MAIN_REF; prints nothing otherwise. Always exits 0: the job has
# already failed, and this step only explains why a rerun cannot help.
# Must parse and run under Bash 3.2 (stock macOS).

set -euo pipefail

attempt=${RUN_ATTEMPT:-1}
main_ref=${MAIN_REF:-origin/main}

case "$attempt" in
  '' | *[!0-9]*) exit 0 ;;
esac
[ "$attempt" -gt 1 ] || exit 0

head=$(git rev-parse --verify -q 'HEAD^{commit}') || exit 0
main=$(git rev-parse --verify -q "$main_ref^{commit}") || exit 0
[ "$head" != "$main" ] || exit 0
git merge-base --is-ancestor "$head" "$main" 2>/dev/null || exit 0

behind=$(git rev-list --count "$head..$main")
commits=commits
[ "$behind" -ne 1 ] || commits=commit
echo "::error::consumer-checks: attempt $attempt reused intent-hq/intent@${head:0:8}, which is $behind $commits behind main (${main:0:8}). \"Re-run failed jobs\" keeps the monorepo commit from the first attempt, so a monorepo fix merged since then is not in this run. Start a new run (for example, push to the PR branch) or use \"Re-run all jobs\"."
