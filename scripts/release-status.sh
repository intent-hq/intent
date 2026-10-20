#!/usr/bin/env bash
# Print the whole release train for intentd and cloudlands-fe in a few lines.
#
#   scripts/release-status.sh [--no-logs]      (STATUS_JSON=1 for JSON)
#
# Read-only. For each component: the newest vX.Y.Z release and its age, the
# alpha/beta/stable channel versions, commits on main since that tag, open
# release-train PRs (release-plz / release-please Release PRs and the fe
# `auto/intentd-pin` pin-bump PR) with CI Gate state, head age and merge
# queue position, what the head of the main merge queue is waiting on (the
# whole queue waits behind it), and the last auto-cut-alpha.yml decision line
# -- the reason a cut skipped, deferred or merged, which otherwise exists only
# in raw run logs. Also: the daemon version cloudlands-fe main pins
# (intentd.version) against the intentd alpha, the last cloudlands-fe
# auto-pin-intentd.yml run with its failure streak and one-line failure
# reason (e.g. GH006 when the queued pin branch is locked), and active
# CI_*_RUNNER_DISABLED maintenance overrides with their reasons on intent,
# intentd and cloudlands-fe.
#
# Sources:
#   intentd releases         intent-hq/intentd releases; channels from
#                            intent-hq/intentd-releases channel-<c> / <c>.json
#   fe releases + channels   intent-hq/cloudlands-releases (alpha = newest
#                            vX.Y.Z; beta/stable = `version:` in the beta/stable
#                            releases' latest-mac.yml)
#   newest git tag           tags on each source repo: release-plz /
#                            release-please tag before the release build
#                            publishes, so a tag newer than the newest release
#                            is reported as "not published yet"
#   pin                      intentd.version on intent-hq/cloudlands-fe main
#   unshipped                compare <newest release>...main on each source repo
#   merge queue              GraphQL repository.mergeQueue(branch: "main"):
#                            entry positions/states/enqueue times, and the head
#                            entry's merge-group check rollup
#   auto-pin                 `gh run list` of cloudlands-fe auto-pin-intentd.yml;
#                            when the newest completed run failed, its
#                            `gh run view --log-failed` (first ::error::
#                            annotation, else GHnnn push rejection, else git
#                            fatal:/error:, else the failing step's exit code)
#   auto-cut decision        `gh run view --log` of the newest completed
#                            auto-cut-alpha.yml runs (up to 5, newest first):
#                            the structured `auto-cut-decision: <outcome>
#                            <reason> <detail>` line both workflows print once
#                            per run, else (older runs) a free-text match
#
# --no-logs skips the log fetches (the slowest part); the auto-cut section then
# shows only the newest run, and the auto-pin section no failure reason. Every
# lookup is independent and fail-soft: one that fails shows
# `unavailable: <gh error>` (JSON: `errors[]`) and the rest of the report
# still prints. Exit codes: 0 = report printed; 1 = gh missing or
# not authenticated; 2 = usage error. RELEASE_STATUS_NOW=<ISO-8601> pins the
# clock (tests).

set -euo pipefail

usage() {
  echo "Usage: $0 [--no-logs]   (STATUS_JSON=1 for JSON)" >&2
  exit 2
}

fetch_logs=1
while (($# > 0)); do
  case "$1" in
    --no-logs) fetch_logs=0 ;;
    *) usage ;;
  esac
  shift
done

command -v gh >/dev/null 2>&1 || {
  echo "release-status: gh is not installed (run make bootstrap-dev-host)" >&2
  exit 1
}
if ! gh auth status >/dev/null 2>&1; then
  echo "release-status: gh is not authenticated (run gh auth login)" >&2
  exit 1
fi

intentd_repo=intent-hq/intentd
intentd_dist=intent-hq/intentd-releases
fe_repo=intent-hq/cloudlands-fe
fe_dist=intent-hq/cloudlands-releases
monorepo=intent-hq/intent
max_runs=5
max_pin_runs=10

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# fetch <name> <gh args...>: stdout to <name>.out, stderr to <name>.err and
# the exit status to <name>.rc, never failing the script.
fetch() {
  local name=$1
  shift
  if gh "$@" >"$work/$name.out" 2>"$work/$name.err"; then
    echo 0 >"$work/$name.rc"
  else
    echo "$?" >"$work/$name.rc"
  fi
}

ok() { [[ -f "$work/$1.rc" && "$(<"$work/$1.rc")" == 0 ]]; }

py() { python3 -c "$@"; }

# Newest vX.Y.Z git tag (semver order) from a `gh api repos/<repo>/tags` file.
newest_git_tag() {
  py '
import json, re, sys
best = None
for tag in json.load(open(sys.argv[1])):
    match = re.match(r"^v(\d+)\.(\d+)\.(\d+)(-.*)?$", tag["name"])
    if match:
        key = tuple(int(part) for part in match.groups()[:3]) + (0 if match.group(4) else 1,)
        if best is None or key > best[0]:
            best = (key, tag["name"])
if best:
    print(best[1])
' "$1" 2>/dev/null || true
}

# Newest vX.Y.Z release from a `gh release list --json tagName,publishedAt` file.
newest_release() {
  py '
import json, re, sys
for release in json.load(open(sys.argv[1])):
    if re.match(r"^v\d+\.\d+\.\d+", release["tagName"]):
        print(release["tagName"])
        break
' "$1" 2>/dev/null || true
}

# component <key> <source repo> <release repo> <PR head prefixes>: the newest
# published release, the newest git tag (it exists while its release build is
# still running), unshipped commits since the newest published release (the
# git tag when releases are unreadable), release-train PRs and the auto-cut
# decision -- each chain in the background.
component() {
  local key=$1 repo=$2 releases=$3 prefixes=$4 tag base prefix index id
  {
    fetch "$key.releases" release list --repo "$releases" --limit 30 --exclude-drafts \
      --json tagName,publishedAt &
    {
      fetch "$key.tags" api "repos/$repo/tags?per_page=30"
      if ok "$key.tags"; then
        tag=$(newest_git_tag "$work/$key.tags.out")
        if [[ -n "$tag" ]]; then
          echo "$tag" >"$work/$key.gittag"
          fetch "$key.tagcommit" api "repos/$repo/commits/$tag"
        fi
      fi
    } &
    wait
    base=""
    if ok "$key.releases"; then
      base=$(newest_release "$work/$key.releases.out")
    fi
    if [[ -z "$base" && -f "$work/$key.gittag" ]]; then
      base=$(<"$work/$key.gittag")
    fi
    if [[ -n "$base" ]]; then
      echo "$base" >"$work/$key.base"
      fetch "$key.compare" api "repos/$repo/compare/$base...main?per_page=1"
    fi
  } &
  {
    # `head:` search is a branch-name prefix match, so each search returns
    # only release-train PRs (with every field), however many PRs are open.
    index=0
    for prefix in $prefixes; do
      fetch "$key.prs.$index" pr list --repo "$repo" --state open --limit 20 \
        --search "head:$prefix" \
        --json number,title,url,headRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup,commits &
      index=$((index + 1))
    done
    wait
  } &
  # The main merge queue: every entry's position/state, plus the head
  # entry's merge-group checks (what the whole queue is waiting on).
  fetch "$key.queue" api graphql -f query="$queue_query" -f owner="${repo%%/*}" -f name="${repo#*/}" &
  {
    fetch "$key.runs" run list --repo "$repo" --workflow auto-cut-alpha.yml \
      --limit "$max_runs" --json databaseId,status,conclusion,createdAt,event,url
    if ((fetch_logs)) && ok "$key.runs"; then
      py '
import json, sys
for run in json.load(open(sys.argv[1])):
    if run["status"] == "completed":
        print(run["databaseId"])
' "$work/$key.runs.out" 2>/dev/null |
        while IFS= read -r id; do
          fetch "$key.log.$id" run view "$id" --repo "$repo" --log
          ok "$key.log.$id" || break
          # Stop at the first (newest) run whose log holds a decision line.
          py "$decision_py" "$work/$key.log.$id.out" >"$work/$key.decision.$id" || true
          if [[ -s "$work/$key.decision.$id" ]] && [[ -n "$(tr -d '[:space:]' <"$work/$key.decision.$id")" ]]; then
            break
          fi
        done
    fi
  } &
  wait
}

# Last auto-cut decision in a run log, printed as one JSON object (or nothing).
# Both repos' auto-cut-alpha.yml print exactly one structured line per run,
#   auto-cut-decision: <outcome> <reason> <free-text detail>
# (intentd + cloudlands-fe "decision contract"), which wins whenever present.
# Runs from before that contract only have free text, so the fallback still
# tracks the old echo strings ("...; skipping.", "throttled", "deferring",
# "paused", "refusing", "squash-merged", ...); drop it once no such run is
# within reach. Lines carrying the \e[36;1m prefix are the step's echoed
# script source, not its output, so they never count.
decision_py='
import json, re, sys
structured = re.compile(r"^auto-cut-decision: ([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)(?: (.*))?$")
legacy = re.compile(
    r"skipping|throttl(ed|ing)|deferring|paused until|refusing|squash-merged|"
    r"Submitted Release PR|DRY RUN|nothing to chain into|gh pr merge failed")
found, fallback = None, ""
with open(sys.argv[1], errors="replace") as log:
    for line in log:
        if "\x1b[36;1m" in line:
            continue
        text = line.rstrip("\n").split("\t")[-1].lstrip("\ufeff")
        text = re.sub(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ", "", text)
        text = re.sub(r"^(##\[(notice|warning|error)\]|::(notice|warning|error)[^:]*::)", "", text).strip()
        match = structured.match(text)
        if match:
            found = {"source": "structured", "outcome": match.group(1), "reason": match.group(2),
                     "detail": (match.group(3) or "").strip()}
        elif legacy.search(text):
            fallback = text
if found is None and fallback:
    found = {"source": "pattern", "outcome": None, "reason": None, "detail": fallback}
if found:
    print(json.dumps(found))
'

queue_query='query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: "main") {
      url
      entries(first: 50) {
        totalCount
        nodes {
          position state enqueuedAt estimatedTimeToMerge
          pullRequest { number title headRefName }
          headCommit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion startedAt }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}'

component intentd "$intentd_repo" "$intentd_repo" "release-plz-" &
# cloudlands-fe auto-pin-intentd.yml: the newest runs, and the failed-step log
# of the newest completed run when it failed (its one-line reason).
{
  fetch fe.pinruns run list --repo "$fe_repo" --workflow auto-pin-intentd.yml \
    --limit "$max_pin_runs" --json databaseId,status,conclusion,createdAt,event,url
  if ((fetch_logs)) && ok fe.pinruns; then
    id=$(py '
import json, sys
for run in json.load(open(sys.argv[1])):
    if run["status"] == "completed":
        if run["conclusion"] in ("failure", "timed_out", "startup_failure"):
            print(run["databaseId"])
        break
' "$work/fe.pinruns.out" 2>/dev/null || true)
    if [[ -n "$id" ]]; then
      fetch "fe.pinlog.$id" run view "$id" --repo "$fe_repo" --log-failed
    fi
  fi
} &
component cloudlands-fe "$fe_repo" "$fe_dist" "release-please--branches--main auto/intentd-pin" &
for channel in alpha beta stable; do
  fetch "intentd.channel.$channel" release download "channel-$channel" --repo "$intentd_dist" \
    --pattern "$channel.json" --output - &
done
for channel in beta stable; do
  fetch "cloudlands-fe.channel.$channel" release download "$channel" --repo "$fe_dist" \
    --pattern latest-mac.yml --output - &
done
fetch fe.pin api -H "Accept: application/vnd.github.raw+json" \
  "repos/$fe_repo/contents/intentd.version?ref=main" &
for repo in "$monorepo" "$intentd_repo" "$fe_repo"; do
  fetch "vars.${repo#intent-hq/}" variable list --repo "$repo" --json name,value &
done
wait

python3 - "$work" "${STATUS_JSON:-}" "${RELEASE_STATUS_NOW:-}" "$fetch_logs" "$max_pin_runs" <<'PY'
import datetime, json, os, re, sys

work, as_json, now_arg, fetch_logs = sys.argv[1], sys.argv[2] == "1", sys.argv[3], sys.argv[4] == "1"
MAX_PIN_RUNS = int(sys.argv[5])
UTC = datetime.timezone.utc


def parse_time(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


now = parse_time(now_arg) if now_arg else datetime.datetime.now(UTC)
errors = []


def read(name):
    path = os.path.join(work, name)
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as handle:
        return handle.read()


def result(name, section):
    """Return the stdout of fetch <name>, or None after recording an error."""
    rc = read(name + ".rc")
    if rc is None:
        return None
    if rc.strip() != "0":
        detail = (read(name + ".err") or "").strip().splitlines()
        errors.append({"section": section, "message": detail[0] if detail else "gh exited " + rc.strip()})
        return None
    return read(name + ".out")


def section_failed(section):
    return any(error["section"] == section for error in errors)


def age_minutes(value):
    return max(0, int((now - parse_time(value)).total_seconds() // 60)) if value else None


def fmt_age(minutes):
    if minutes is None:
        return "?"
    if minutes < 60:
        return "%dm" % minutes
    if minutes < 48 * 60:
        return "%dh%02dm" % (minutes // 60, minutes % 60)
    return "%dd%dh" % (minutes // 1440, minutes % 1440 // 60)


def version_key(version):
    match = re.match(r"v?(\d+)\.(\d+)\.(\d+)(-.*)?$", version or "")
    if not match:
        return None
    # A prerelease sorts before its release.
    return tuple(int(part) for part in match.groups()[:3]) + (0 if match.group(4) else 1,)


def load_json(text, section):
    try:
        return json.loads(text)
    except ValueError:
        errors.append({"section": section, "message": "unparseable gh output"})
        return None


FAILING = ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE")


def ci_gate(rollup):
    """CI Gate state (the most recently started CI Gate run wins) and the
    number of failing checks in a statusCheckRollup."""
    gate, gate_started, failing = None, "", 0
    for check in rollup or []:
        name = check.get("name") or check.get("context") or ""
        state = (check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        if check.get("status") and check.get("status") != "COMPLETED":
            state = check["status"].upper()
        if state in FAILING:
            failing += 1
        started = check.get("startedAt") or check.get("createdAt") or ""
        if name == "CI Gate" and (gate is None or started >= gate_started):
            gate, gate_started = state or None, started
    return gate, failing


def merge_queue(key):
    """The main merge queue: entries in position order, and what the head
    entry's merge-group commit is still waiting on. None when unreadable."""
    section = key + ".mergeQueue"
    text = result(key + ".queue", section)
    payload = load_json(text, section) if text is not None else None
    if payload is None:
        return None
    if payload.get("errors"):
        errors.append({"section": section, "message": str(payload["errors"][0].get("message"))})
        return None
    queue = ((payload.get("data") or {}).get("repository") or {}).get("mergeQueue")
    if queue is None:
        return {"enabled": False, "url": None, "length": 0, "entries": [], "head": None}
    nodes = sorted((queue.get("entries") or {}).get("nodes") or [], key=lambda n: n.get("position") or 0)
    entries = [{"position": node.get("position"), "number": (node.get("pullRequest") or {}).get("number"),
                "title": (node.get("pullRequest") or {}).get("title"),
                "headRef": (node.get("pullRequest") or {}).get("headRefName"),
                "state": node.get("state"), "enqueuedAt": node.get("enqueuedAt"),
                "enqueuedAgeMinutes": age_minutes(node.get("enqueuedAt"))} for node in nodes]
    head = None
    if nodes:
        node = nodes[0]
        rollup = ((node.get("headCommit") or {}).get("statusCheckRollup") or {})
        pending, failing, pending_started = [], [], []
        for check in (rollup.get("contexts") or {}).get("nodes") or []:
            name = check.get("name") or check.get("context") or "?"
            started = check.get("startedAt") or check.get("createdAt")
            if check.get("__typename") == "StatusContext":
                state = (check.get("state") or "").upper()
                is_pending, is_failing = state in ("PENDING", "EXPECTED"), state in ("FAILURE", "ERROR")
            else:
                is_pending = (check.get("status") or "").upper() != "COMPLETED"
                is_failing = not is_pending and (check.get("conclusion") or "").upper() in FAILING
            if is_pending:
                pending.append(name)
                if started:
                    pending_started.append(started)
            elif is_failing:
                failing.append(name)
        started = min(pending_started) if pending_started else None
        head = dict(entries[0], hasMergeGroup=node.get("headCommit") is not None,
                    rollupState=rollup.get("state"), pendingChecks=pending, failingChecks=failing,
                    checksStartedAt=started, checksAgeMinutes=age_minutes(started),
                    estimatedTimeToMergeSeconds=node.get("estimatedTimeToMerge"))
    return {"enabled": True, "url": queue.get("url"),
            "length": (queue.get("entries") or {}).get("totalCount", len(entries)),
            "entries": entries, "head": head}


PIN_FAILED = ("failure", "timed_out", "startup_failure")


def failure_reason(log):
    """One line saying why a run failed, from its `gh run view --log-failed`
    output: an explicit ::error:: annotation, else a `remote: error: GHnnn`
    push rejection with its `remote:` explanation, else a git fatal:/error:
    line, else the step's exit code. Echoed script source never counts."""
    lines = []
    for raw in log.splitlines():
        if "\x1b[36;1m" in raw:
            continue
        parts = raw.split("\t")
        step = parts[1] if len(parts) >= 3 else ""
        text = re.sub(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ", "", parts[-1].lstrip("﻿")).strip()
        lines.append((step, text))
    annotations, pushes, git_errors, exits = [], [], [], []
    for index, (step, text) in enumerate(lines):
        match = re.match(r"^(?:##\[error\]|::error[^:]*::)(.*)$", text)
        if match:
            message = match.group(1).strip()
            code = re.match(r"^Process completed with exit code (\d+)", message)
            if code:
                named = step and step != "UNKNOWN STEP"
                exits.append("%s exited %s" % ("step '%s'" % step if named else "a step", code.group(1)))
            elif message:
                annotations.append(message)
            continue
        match = re.match(r"^remote: error: (GH\d+: .*)$", text)
        if match:
            detail = []
            # The remote's explanation follows until git's push result;
            # git's own stdout can interleave, so other lines are skipped.
            for _, follow in lines[index + 1:]:
                if re.match(r"^(To |! \[|##\[|::|error: |fatal: |remote: error: )", follow):
                    break
                more = re.match(r"^remote:(.*)$", follow)
                if more and more.group(1).strip():
                    detail.append(more.group(1).strip().lstrip("-").strip())
            pushes.append(match.group(1).strip() + (" (%s)" % " ".join(detail) if detail else ""))
            continue
        if re.match(r"^(fatal|error): ", text):
            git_errors.append(text)
    for group in (annotations, pushes, git_errors, exits):
        if group:
            return group[0]
    return None


def auto_pin():
    """The newest completed cloudlands-fe auto-pin-intentd.yml run, its
    failure streak, and why it failed."""
    section = "cloudlands-fe.autoPin"
    text = result("fe.pinruns", section)
    runs = load_json(text, section) if text is not None else None
    if not runs:
        return None
    completed = [run for run in runs if run.get("status") == "completed"]
    chosen = (completed or runs)[0]
    streak = 0
    for run in completed:
        if run.get("conclusion") not in PIN_FAILED:
            break
        streak += 1
    reason, log_fetched = None, False
    if chosen.get("status") == "completed" and chosen.get("conclusion") in PIN_FAILED and fetch_logs:
        log = result("fe.pinlog.%s" % chosen["databaseId"], section + ".log")
        if log is not None:
            log_fetched = True
            reason = failure_reason(log)
    return {"runId": chosen["databaseId"], "url": chosen.get("url"), "event": chosen.get("event"),
            "status": chosen.get("status"), "conclusion": chosen.get("conclusion"),
            "createdAt": chosen.get("createdAt"), "ageMinutes": age_minutes(chosen.get("createdAt")),
            "failedStreak": streak,
            "failedStreakCapped": bool(streak) and streak == len(completed) and len(runs) >= MAX_PIN_RUNS,
            "failureReason": reason, "failureLogRead": log_fetched,
            "newestRunId": runs[0]["databaseId"], "newestRunStatus": runs[0].get("status")}


def component(key):
    data = {"latestTag": None, "latestTagPublishedAt": None, "latestTagAgeMinutes": None,
            "newestGitTag": None, "newestGitTagAt": None, "newestGitTagAgeMinutes": None,
            "unreleasedTag": None,
            "channels": {"alpha": None, "beta": None, "stable": None},
            "unshippedCommits": None, "releasePrs": [], "autoCut": None}
    text = result(key + ".releases", key + ".latestTag")
    releases = load_json(text, key + ".latestTag") if text is not None else None
    for release in releases or []:
        if re.match(r"^v\d+\.\d+\.\d+", release["tagName"]):
            data["latestTag"] = release["tagName"]
            data["latestTagPublishedAt"] = release.get("publishedAt")
            data["latestTagAgeMinutes"] = age_minutes(release.get("publishedAt"))
            break
    if releases is not None and data["latestTag"] is None:
        errors.append({"section": key + ".latestTag", "message": "no vX.Y.Z release found"})

    text = result(key + ".tags", key + ".newestGitTag")
    if text is not None:
        tag = (read(key + ".gittag") or "").strip() or None
        data["newestGitTag"] = tag
        if tag is None:
            errors.append({"section": key + ".newestGitTag", "message": "no vX.Y.Z git tag found"})
        text = result(key + ".tagcommit", key + ".newestGitTag")
        commit = load_json(text, key + ".newestGitTag") if text is not None else None
        if commit is not None:
            data["newestGitTagAt"] = ((commit.get("commit") or {}).get("committer") or {}).get("date")
            data["newestGitTagAgeMinutes"] = age_minutes(data["newestGitTagAt"])
        # A tag newer than the newest release is still building/publishing.
        if tag and data["latestTag"] and version_key(tag) and version_key(data["latestTag"]) \
                and version_key(tag) > version_key(data["latestTag"]):
            data["unreleasedTag"] = tag

    if key == "intentd":
        for channel in ("alpha", "beta", "stable"):
            text = result("intentd.channel." + channel, "intentd.channels." + channel)
            manifest = load_json(text, "intentd.channels." + channel) if text is not None else None
            if manifest is not None:
                data["channels"][channel] = manifest.get("version")
    else:
        data["channels"]["alpha"] = data["latestTag"][1:] if data["latestTag"] else None
        for channel in ("beta", "stable"):
            text = result("cloudlands-fe.channel." + channel, "cloudlands-fe.channels." + channel)
            if text is not None:
                match = re.search(r"^version:\s*['\"]?([^'\"\s]+)", text, re.M)
                if match:
                    data["channels"][channel] = match.group(1)
                else:
                    errors.append({"section": "cloudlands-fe.channels." + channel,
                                   "message": "latest-mac.yml has no version"})

    data["unshippedSince"] = (read(key + ".base") or "").strip() or None
    text = result(key + ".compare", key + ".unshippedCommits")
    compare = load_json(text, key + ".unshippedCommits") if text is not None else None
    if compare is not None:
        data["unshippedCommits"] = compare.get("ahead_by")

    data["mergeQueue"] = queue = merge_queue(key)
    queued = {entry["number"]: entry for entry in (queue or {}).get("entries", [])}
    seen = set()
    index = 0
    while read("%s.prs.%d.rc" % (key, index)) is not None:
        text = result("%s.prs.%d" % (key, index), key + ".releasePrs")
        index += 1
        prs = load_json(text, key + ".releasePrs") if text is not None else None
        for pr in prs or []:
            # Search is fuzzy; keep only exact release-train head refs.
            if pr["number"] in seen or not re.match(
                    r"^(release-plz-|release-please--branches--main|auto/intentd-pin$)", pr.get("headRefName", "")):
                continue
            seen.add(pr["number"])
            gate, failing = ci_gate(pr.get("statusCheckRollup"))
            commits = pr.get("commits") or []
            head_at = commits[-1].get("committedDate") if commits else None
            head = pr.get("headRefName", "")
            data["releasePrs"].append({
                "number": pr["number"], "title": pr.get("title"), "url": pr.get("url"),
                "kind": "pin-bump" if head == "auto/intentd-pin" else "release",
                "headRef": head, "isDraft": pr.get("isDraft"),
                "mergeable": pr.get("mergeable"), "mergeStateStatus": pr.get("mergeStateStatus"),
                "ciGate": gate, "failingChecks": failing,
                "headCommittedAt": head_at, "headAgeMinutes": age_minutes(head_at),
                "mergeQueue": {key_: queued[pr["number"]][key_] for key_ in
                               ("position", "state", "enqueuedAt", "enqueuedAgeMinutes")}
                if pr["number"] in queued else None})
        data["releasePrs"].sort(key=lambda pr: (pr["kind"] != "release", pr["number"]))

    text = result(key + ".runs", key + ".autoCut")
    runs = load_json(text, key + ".autoCut") if text is not None else None
    if runs:
        completed = [run for run in runs if run.get("status") == "completed"]
        chosen, found = (completed or runs)[0], None
        if fetch_logs:
            for run in runs:
                if run.get("status") != "completed":
                    continue
                result("%s.log.%s" % (key, run["databaseId"]), key + ".autoCut")
                line = (read("%s.decision.%s" % (key, run["databaseId"])) or "").strip()
                if line:
                    chosen, found = run, json.loads(line)
                    break
        found = found or {}
        decision = found.get("detail")
        if found.get("source") == "structured":
            decision = "%s %s%s" % (found["outcome"], found["reason"],
                                    ": " + found["detail"] if found["detail"] else "")
        data["autoCut"] = {
            "runId": chosen["databaseId"], "url": chosen.get("url"), "event": chosen.get("event"),
            "status": chosen.get("status"), "conclusion": chosen.get("conclusion"),
            "createdAt": chosen.get("createdAt"), "ageMinutes": age_minutes(chosen.get("createdAt")),
            "decision": decision, "outcome": found.get("outcome"), "reason": found.get("reason"),
            "decisionSource": found.get("source"), "completedRunsScanned": len(completed) if fetch_logs else 0,
            "newestRunId": runs[0]["databaseId"], "newestRunStatus": runs[0].get("status")}
    if key == "cloudlands-fe":
        data["autoPin"] = auto_pin()
    return data


components = {key: component(key) for key in ("intentd", "cloudlands-fe")}

fe_pin = None
text = result("fe.pin", "fePin")
if text is not None:
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    version = lines[-1] if lines else None
    alpha = components["intentd"]["channels"]["alpha"]
    behind = None
    if version_key(version) and version_key(alpha):
        behind = version_key(version) < version_key(alpha)
    fe_pin = {"version": version, "intentdAlpha": alpha, "behindAlpha": behind}

overrides = []
for repo in ("intent", "intentd", "cloudlands-fe"):
    text = result("vars." + repo, "runnerOverrides." + repo)
    variables = load_json(text, "runnerOverrides." + repo) if text is not None else None
    values = {var["name"]: var.get("value", "") for var in variables or []}
    for name in sorted(values):
        match = re.match(r"^CI_([A-Z0-9]+)_RUNNER_DISABLED$", name)
        # Routing tests `=== 'true'` exactly (runner-route.yml), so must we.
        if match and values[name] == "true":
            overrides.append({"repo": "intent-hq/" + repo, "platform": match.group(1).lower(),
                              "variable": name, "reason": values.get(name + "_REASON")})

report = {"generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "components": components,
          "fePin": fe_pin, "runnerOverrides": overrides, "errors": errors}

if as_json:
    json.dump(report, sys.stdout, indent=2)
    print()
    sys.exit(0)


def unavailable(section):
    messages = [e["message"] for e in errors if e["section"] == section or e["section"].startswith(section + ".")]
    return "unavailable: " + messages[0] if messages else "unavailable"


def clip(text, width=150):
    return text if len(text) <= width else text[: width - 1] + "…"


out = ["Release train at %s" % now.strftime("%Y-%m-%d %H:%MZ")]
for key, data in components.items():
    if data["latestTag"]:
        head = "%s (%s ago)" % (data["latestTag"], fmt_age(data["latestTagAgeMinutes"]))
    else:
        head = unavailable(key + ".latestTag")
    if data["unreleasedTag"]:
        head += "; %s tagged %s ago, release not published yet" % (
            data["unreleasedTag"], fmt_age(data["newestGitTagAgeMinutes"]))
    if data["unshippedCommits"] is not None:
        head += ", %d unshipped commit%s on main since %s" % (
            data["unshippedCommits"], "" if data["unshippedCommits"] == 1 else "s", data["unshippedSince"])
    elif section_failed(key + ".unshippedCommits"):
        head += ", unshipped " + unavailable(key + ".unshippedCommits")
    out.append("%-14s %s" % (key, head))
    channels = " · ".join("%s %s" % (c, data["channels"][c] or "?") for c in ("alpha", "beta", "stable"))
    out.append("  %-12s %s" % ("channels", channels))
    if key == "cloudlands-fe":
        if fe_pin:
            pin = "intentd %s" % (fe_pin["version"] or "?")
            if fe_pin["behindAlpha"]:
                pin += " (behind intentd alpha %s)" % fe_pin["intentdAlpha"]
            elif fe_pin["behindAlpha"] is False:
                pin += " (matches or ahead of intentd alpha)"
        else:
            pin = unavailable("fePin")
        out.append("  %-12s %s" % ("daemon pin", pin))
    if section_failed(key + ".releasePrs") and not data["releasePrs"]:
        out.append("  %-12s %s" % ("release PRs", unavailable(key + ".releasePrs")))
    elif not data["releasePrs"]:
        out.append("  %-12s %s" % ("release PRs", "none open"))
    for index, pr in enumerate(data["releasePrs"]):
        bits = ["CI Gate %s" % (pr["ciGate"] or "missing")]
        if pr["failingChecks"]:
            bits.append("%d failing check%s" % (pr["failingChecks"], "" if pr["failingChecks"] == 1 else "s"))
        bits.append("head %s old" % fmt_age(pr["headAgeMinutes"]))
        if pr["isDraft"]:
            bits.append("draft")
        entry, queue = pr["mergeQueue"], data["mergeQueue"]
        if entry:
            # A queued PR's mergeable/mergeState reflect the queue (often
            # UNKNOWN or BLOCKED), so the queue entry replaces them.
            bits.append("in merge queue #%s of %s (%s, %s)" % (
                entry["position"], queue["length"], entry["state"], fmt_age(entry["enqueuedAgeMinutes"])))
        elif queue and queue["enabled"]:
            bits.append("not in merge queue")
        if entry:
            pass
        elif pr["mergeable"] == "UNKNOWN":
            bits.append("mergeable=UNKNOWN (GitHub still computing)")
        elif pr["mergeable"] and pr["mergeable"] != "MERGEABLE":
            bits.append("mergeable=%s" % pr["mergeable"])
        elif pr["mergeStateStatus"] and pr["mergeStateStatus"] not in ("CLEAN", "UNSTABLE", "HAS_HOOKS"):
            bits.append("mergeState=%s" % pr["mergeStateStatus"])
        label = "release PRs" if index == 0 else ""
        kind = "" if pr["kind"] == "release" else "[pin-bump] "
        out.append("  %-12s #%s %s%s — %s" % (label, pr["number"], kind, clip(pr["title"] or "", 60), ", ".join(bits)))
    queue = data["mergeQueue"]
    if queue is None:
        out.append("  %-12s %s" % ("merge queue", unavailable(key + ".mergeQueue")))
    elif not queue["enabled"]:
        out.append("  %-12s %s" % ("merge queue", "none on main"))
    elif not queue["head"]:
        out.append("  %-12s %s" % ("merge queue", "empty"))
    else:
        head = queue["head"]
        line = "%d queued; head #%s %s — %s for %s" % (
            queue["length"], head["number"], clip(head["title"] or "", 50), head["state"],
            fmt_age(head["enqueuedAgeMinutes"]))
        if head["pendingChecks"]:
            names = head["pendingChecks"]
            line += ", waiting on %d check%s (%s%s) running %s" % (
                len(names), "" if len(names) == 1 else "s", ", ".join(names[:3]),
                ", …" if len(names) > 3 else "", fmt_age(head["checksAgeMinutes"]))
        elif not head["hasMergeGroup"]:
            line += ", no merge-group checks started yet"
        if head["failingChecks"]:
            names = head["failingChecks"]
            line += ", %d failing check%s (%s%s)" % (
                len(names), "" if len(names) == 1 else "s", ", ".join(names[:3]), ", …" if len(names) > 3 else "")
        out.append("  %-12s %s" % ("merge queue", line))
    cut = data["autoCut"]
    if cut:
        where = "run %s, %s, %s ago" % (cut["runId"], cut["event"] or "?", fmt_age(cut["ageMinutes"]))
        if cut["decision"]:
            line = "%s [%s]" % (clip(cut["decision"], 140), where)
        elif not fetch_logs:
            line = "logs skipped (--no-logs); newest %s [%s]" % (cut["conclusion"] or cut["status"], where)
        elif section_failed(key + ".autoCut"):
            line = "%s [%s]" % (unavailable(key + ".autoCut"), where)
        else:
            line = "no decision line in the newest %d completed run(s); newest %s [%s]" % (
                cut["completedRunsScanned"], cut["conclusion"] or cut["status"], where)
        if cut["newestRunId"] != cut["runId"] and cut["newestRunStatus"] != "completed":
            line += " (run %s %s)" % (cut["newestRunId"], cut["newestRunStatus"])
    elif section_failed(key + ".autoCut"):
        line = unavailable(key + ".autoCut")
    else:
        line = "no auto-cut-alpha.yml runs"
    out.append("  %-12s %s" % ("auto-cut", line))
    if key != "cloudlands-fe":
        continue
    pin_run = data["autoPin"]
    if pin_run:
        where = "run %s, %s, %s ago" % (pin_run["runId"], pin_run["event"] or "?", fmt_age(pin_run["ageMinutes"]))
        line = pin_run["conclusion"] or pin_run["status"]
        if pin_run["failedStreak"] > 1:
            line += " (%d%s runs in a row)" % (pin_run["failedStreak"], "+" if pin_run["failedStreakCapped"] else "")
        if pin_run["conclusion"] in PIN_FAILED:
            if pin_run["failureReason"]:
                line += ": " + clip(pin_run["failureReason"], 160)
            elif not fetch_logs:
                line += ": logs skipped (--no-logs)"
            elif section_failed("cloudlands-fe.autoPin.log"):
                line += ": " + unavailable("cloudlands-fe.autoPin.log")
            else:
                line += ": no error line in the failed-step log"
        line += " [%s]" % where
        if pin_run["newestRunId"] != pin_run["runId"] and pin_run["newestRunStatus"] != "completed":
            line += " (run %s %s)" % (pin_run["newestRunId"], pin_run["newestRunStatus"])
    elif section_failed("cloudlands-fe.autoPin"):
        line = unavailable("cloudlands-fe.autoPin")
    else:
        line = "no auto-pin-intentd.yml runs"
    out.append("  %-12s %s" % ("auto-pin", line))

if overrides:
    out.append("runner overrides (CI_*_RUNNER_DISABLED)")
    for item in overrides:
        out.append("  %-14s %-8s %s" % (item["repo"].split("/")[1], item["platform"],
                                        clip(item["reason"] or "(no _REASON variable)", 120)))
else:
    out.append("runner overrides: none")
for repo in ("intent", "intentd", "cloudlands-fe"):
    if section_failed("runnerOverrides." + repo):
        out.append("  %-14s %s" % (repo, unavailable("runnerOverrides." + repo)))
print("\n".join(out))
PY
