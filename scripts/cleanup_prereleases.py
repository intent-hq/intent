#!/usr/bin/env python3
"""Preview GitHub prerelease retention; delete only from a serialized source job.

Keep the last 30 days and newest 20 versioned prereleases in each repository.
No third-party Python dependencies; all GitHub access uses authenticated `gh`.

APPLY CALLER CONTRACT: run in the component source repository under the SAME
Actions concurrency group as publication, mirroring and promotion, with
cancel-in-progress:false. The lock must span this entire process. Environment
checks below prevent accidental use; they do not prove lock ownership. Drain old
workflow revisions before enabling cleanup. Git tags are never deleted.

Daemon protection includes ALL extant frontend releases, not just this run's
retention survivors, so simultaneous frontend promotion cannot invalidate it.
Future arbitrary builds/pins of releases already removed are not supported.
Exit 0: preview/apply succeeded; 1: failed read or partial apply; 2: invalid use.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import hashlib
import os
import re
import subprocess
import sys
from urllib.parse import quote, unquote, urlsplit

DAEMON = "intent-hq/intentd"
DAEMON_MIRROR = "intent-hq/intentd-releases"
FE = "intent-hq/cloudlands-fe"
FE_MIRROR = "intent-hq/cloudlands-releases"
REPOSITORIES = (DAEMON, DAEMON_MIRROR, FE, FE_MIRROR)
PAIRS = {"intentd": (DAEMON, DAEMON_MIRROR), "cloudlands-fe": (FE, FE_MIRROR)}
CHANNELS = ("alpha", "beta", "stable")
VERSION = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")
FEEDS = {"latest-mac.yml", "latest.yml", "latest-linux.yml", "latest-linux-arm64.yml"}
PROTECTION_ASSETS = FEEDS | {"release-manifest.json", "alpha.json", "beta.json", "stable.json"}


class CleanupError(Exception):
    """A read/deletion failed; no further mutations are safe."""


def version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise CleanupError("missing or malformed version in protection data")
    return value.removeprefix("v")


def timestamp(value):
    if not isinstance(value, str):
        raise CleanupError("missing published_at")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CleanupError("invalid published_at") from error
    if parsed.tzinfo is None:
        raise CleanupError("published_at must include a timezone")
    return parsed


def validate_release(item):
    if not isinstance(item, dict):
        raise CleanupError("release inventory must contain objects")
    if type(item.get("id")) is not int or item["id"] <= 0:
        raise CleanupError("release has invalid id")
    if not isinstance(item.get("tag_name"), str) or not item["tag_name"]:
        raise CleanupError("release has invalid tag")
    if any(type(item.get(key)) is not bool for key in ("draft", "prerelease")):
        raise CleanupError("release has invalid draft/prerelease metadata")
    if not item["draft"]:
        timestamp(item.get("published_at"))


def select_releases(rows, now):
    """Return deterministic id -> retention reason; only 'eligible' may delete."""
    if not isinstance(rows, list):
        raise CleanupError("release inventory is not an array")
    reasons, candidates, tags = {}, [], set()
    for item in rows:
        validate_release(item)
        ident, tag = item["id"], item["tag_name"]
        if ident in reasons or tag in tags:
            raise CleanupError("duplicate release identity; inventory changed during pagination")
        tags.add(tag)
        if item["draft"]:
            reason = "draft"
        elif not item["prerelease"]:
            reason = "stable"
        elif tag.startswith("sitter-"):
            reason = "sitter"
        elif tag in CHANNELS or tag in {f"channel-{c}" for c in CHANNELS}:
            reason = "rolling-channel"
        elif not VERSION.fullmatch(tag):
            reason = "unrecognized-tag"
        else:
            reason = "eligible"
            candidates.append(item)
        reasons[ident] = reason
    candidates.sort(key=lambda r: (timestamp(r["published_at"]), r["id"]), reverse=True)
    for rank, item in enumerate(candidates):
        if timestamp(item["published_at"]) >= now - timedelta(days=30):
            reasons[item["id"]] = "within-30-days"
        elif rank < 20:
            reasons[item["id"]] = "newest-20"
    return dict(sorted(reasons.items()))


class GitHub:
    def __init__(self):
        self._asset_cache = {}
        self._pin_cache = {}

    def request(self, endpoint, *, method="GET", raw=False, missing_ok=False):
        args = ["gh", "api", "--hostname", "github.com", endpoint, "--method", method,
                "--include", "-H", "Accept: application/octet-stream" if raw else "Accept: application/vnd.github+json"]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=60,
                                    env={**os.environ, "GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat"})
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
            raise CleanupError(f"GitHub {method} {endpoint}: transport failure") from error
        output = result.stdout.replace("\r\n", "\n")
        # gh emits final response headers with --include, including on errors.
        match = re.match(r"HTTP/\S+ (\d{3})[^\n]*\n", output)
        if not match:
            raise CleanupError(f"GitHub {method} {endpoint}: missing HTTP status")
        rest = output[match.end():]
        if rest.startswith("\n"):
            body = rest[1:]
        else:
            _, separator, body = rest.partition("\n\n")
            if not separator:
                raise CleanupError(f"GitHub {method} {endpoint}: malformed HTTP response")
        status = int(match[1])
        if status == 404 and missing_ok:
            return None
        if result.returncode or status not in (200, 204):
            # Do not expose gh stderr, which may contain credentials. No automatic
            # retries on rate limits or uncertain DELETE outcomes: rerun safely.
            raise CleanupError(f"GitHub {method} {endpoint}: HTTP {status}; stopped without retry")
        if raw or status == 204:
            return body
        try:
            return json.loads(body)
        except ValueError as error:
            raise CleanupError(f"GitHub {method} {endpoint}: invalid JSON") from error

    def pages(self, endpoint):
        result, ids = [], set()
        for page in range(1, 1001):
            rows = self.request(f"{endpoint}?per_page=100&page={page}")
            if not isinstance(rows, list):
                raise CleanupError(f"{endpoint}: expected an array")
            for row in rows:
                if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] in ids:
                    raise CleanupError(f"{endpoint}: duplicate or invalid id during pagination")
                ids.add(row["id"])
            result.extend(rows)
            if len(rows) < 100:
                return result
        raise CleanupError(f"{endpoint}: pagination exceeded safety limit")

    def releases(self, repo):
        return self.pages(f"repos/{repo}/releases")

    def release(self, repo, ident):
        return self.request(f"repos/{repo}/releases/{ident}", missing_ok=True)

    def asset_texts(self, repo, item):
        # Cache only version records with inventory asset metadata. Channel feeds
        # are mutable and always read fresh. IDs, sizes and update timestamps in
        # a refreshed inventory invalidate this cache after replacement/upload.
        cacheable = VERSION.fullmatch(item["tag_name"]) and isinstance(item.get("assets"), list)
        key = (repo, item["id"], json.dumps(asset_signature(item.get("assets")), sort_keys=True))
        if cacheable and key in self._asset_cache:
            return dict(self._asset_cache[key])
        # An explicitly empty asset array is authoritative absence. Otherwise
        # paginate the asset endpoint: never infer absence from a partial list.
        assets = [] if item.get("assets") == [] else self.pages(f"repos/{repo}/releases/{item['id']}/assets")
        wanted = PROTECTION_ASSETS if item["tag_name"] in CHANNELS or item["tag_name"].startswith("channel-") else {"release-manifest.json"}
        found, names = {}, set()
        for asset in assets:
            name = asset.get("name")
            if not isinstance(name, str) or not name or name in names:
                raise CleanupError("duplicate or invalid release asset name")
            names.add(name)
            if name in wanted:
                found[name] = self.request(f"repos/{repo}/releases/assets/{asset['id']}", raw=True)
        if cacheable:
            self._asset_cache[key] = dict(found)
        return found

    def pin(self, ref):
        # Anchor cached contents to a resolved commit, never a mutable tag name.
        # Re-resolve on each graph rebuild, peeling annotated tags as necessary.
        target = ref
        if ref != "main":
            data = self.request(f"repos/{FE}/git/ref/tags/{quote(ref, safe='')}")
            for _ in range(10):
                obj = data.get("object") if isinstance(data, dict) else None
                if not isinstance(obj, dict) or not re.fullmatch(r"[0-9a-f]{40}", str(obj.get("sha", ""))):
                    raise CleanupError(f"{ref}: invalid tag target")
                target = obj["sha"]
                if obj.get("type") == "commit":
                    break
                if obj.get("type") != "tag":
                    raise CleanupError(f"{ref}: tag does not resolve to a commit")
                data = self.request(f"repos/{FE}/git/tags/{target}")
            else:
                raise CleanupError(f"{ref}: annotated tag chain exceeds safety limit")
            if target in self._pin_cache:
                return self._pin_cache[target]
        endpoint = f"repos/{FE}/contents/intentd.version?ref={quote(target, safe='')}"
        data = self.request(endpoint)
        if not isinstance(data, dict) or data.get("encoding") != "base64" or not isinstance(data.get("content"), str):
            raise CleanupError(f"{ref}: missing frontend pin contents")
        try:
            contents = base64.b64decode("".join(data["content"].split()), validate=True).decode("utf-8")
        except (ValueError, UnicodeError) as error:
            raise CleanupError(f"{ref}: malformed frontend pin contents") from error
        lines = [line.strip() for line in contents.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        if len(lines) != 1:
            raise CleanupError(f"{ref}: frontend pin must contain exactly one version")
        value = version(lines[0])
        if ref != "main":
            self._pin_cache[target] = value
        return value

    def delete_release(self, repo, ident):
        if repo not in REPOSITORIES or type(ident) is not int or ident <= 0:
            raise CleanupError("refusing an invalid deletion target")
        return self.request(f"repos/{repo}/releases/{ident}", method="DELETE", missing_ok=True) is not None


def json_object(text, label):
    try:
        data = json.loads(text)
    except (ValueError, TypeError) as error:
        raise CleanupError(f"{label}: malformed JSON") from error
    if not isinstance(data, dict):
        raise CleanupError(f"{label}: expected an object")
    return data


def feed_version(text):
    # Only parse electron-builder's root version scalar, not arbitrary YAML.
    # Unsupported shapes, duplicate keys and multiline scalars fail closed.
    matches = re.findall(r"^version:[ \t]*(.*?)[ \t]*$", text, re.MULTILINE)
    if len(matches) != 1:
        raise CleanupError("frontend channel feed needs one root version")
    scalar = matches[0].strip()
    if len(scalar) >= 2 and scalar[0] in "\"'" and scalar[-1] == scalar[0]:
        scalar = scalar[1:-1]
    return version(scalar)


def build_plan(gh, now):
    inventory = {repo: gh.releases(repo) for repo in REPOSITORIES}
    reasons = {repo: select_releases(rows, now) for repo, rows in inventory.items()}
    protected = {repo: {} for repo in REPOSITORIES}

    def protect(pair, value, reason):
        normalized = version(value)
        for repo in pair:
            protected[repo].setdefault(normalized, set()).add(reason)

    for pair in PAIRS.values():
        for repo in pair:
            for item in inventory[repo]:
                tag = item["tag_name"]
                if VERSION.fullmatch(tag) and reasons[repo][item["id"]] != "eligible":
                    protect(pair, tag, "retained-in-source-or-mirror")

    frontend_channel_versions = set()
    for repo in REPOSITORIES:
        daemon = repo in PAIRS["intentd"]
        for item in inventory[repo]:
            tag = item["tag_name"]
            channel = tag.removeprefix("channel-") if daemon else tag
            if channel not in CHANNELS:
                continue
            assets = gh.asset_texts(repo, item)
            if daemon:
                name = channel + ".json"
                data = json_object(assets.get(name), f"{repo}/{tag}/{name}")
                value = version(data.get("version"))
                if version(data.get("tag")) != value or data.get("channel") != channel:
                    raise CleanupError(f"{repo}/{tag}: inconsistent channel manifest")
                # Version fields and download URLs must agree: the sitter uses
                # platform URLs, so retaining only a misleading version field
                # would not protect the actual download target.
                platforms = data.get("platforms")
                if platforms is not None:
                    if not isinstance(platforms, dict) or not platforms:
                        raise CleanupError(f"{repo}/{tag}: invalid platforms")
                    for platform in platforms.values():
                        if not isinstance(platform, dict) or not isinstance(platform.get("url"), str):
                            raise CleanupError(f"{repo}/{tag}: invalid platform URL")
                        url = urlsplit(platform["url"])
                        parts = [unquote(part) for part in url.path.strip("/").split("/")]
                        if (url.scheme != "https" or url.netloc != "github.com" or len(parts) != 6
                                or "/".join(parts[:2]) not in PAIRS["intentd"]
                                or parts[2:4] != ["releases", "download"] or version(parts[4]) != value):
                            raise CleanupError(f"{repo}/{tag}: platform URL disagrees with manifest version")
                protect(PAIRS["intentd"], value, "daemon-channel")
            else:
                if "latest-mac.yml" not in assets:
                    raise CleanupError(f"{repo}/{tag}: missing required latest-mac.yml")
                for name in sorted(FEEDS & assets.keys()):
                    value = feed_version(assets[name])
                    frontend_channel_versions.add(value)
                    protect(PAIRS["cloudlands-fe"], value, "frontend-channel")
                if "release-manifest.json" in assets:
                    data = json_object(assets["release-manifest.json"], f"{repo}/{tag}/release-manifest.json")
                    protect(PAIRS["intentd"], data.get("intentdVersion"), "frontend-channel-sidecar")

    protect(PAIRS["intentd"], gh.pin("main"), "frontend-main-pin")
    # ALL extant FE records are included, even would-delete records: a concurrent
    # promotion of one must not expose a daemon candidate. Removed Git tags are
    # deliberately NOT enumerated. A later run can reclaim newly orphaned pins.
    frontend_tags = {}
    for repo in PAIRS["cloudlands-fe"]:
        for item in inventory[repo]:
            if item["tag_name"] not in CHANNELS:
                frontend_tags.setdefault(item["tag_name"], []).append((repo, item))
    for value in frontend_channel_versions:
        if not any(VERSION.fullmatch(tag) and version(tag) == value for tag in frontend_tags):
            frontend_tags["v" + value] = []
    for tag, records in sorted(frontend_tags.items()):
        manifests = 0
        for repo, item in records:
            assets = gh.asset_texts(repo, item)
            if "release-manifest.json" in assets:
                data = json_object(assets["release-manifest.json"], f"{repo}/{tag}/release-manifest.json")
                protect(PAIRS["intentd"], data.get("intentdVersion"), "frontend-release-pin")
                manifests += 1
        if not manifests:
            protect(PAIRS["intentd"], gh.pin(tag), "frontend-tag-pin")

    rows = []
    for repo in REPOSITORIES:
        for item in sorted(inventory[repo], key=lambda r: r["id"]):
            reason = reasons[repo][item["id"]]
            extra = protected[repo].get(version(item["tag_name"]), set()) if VERSION.fullmatch(item["tag_name"]) else set()
            rows.append({"repo": repo, "id": item["id"], "tag": item["tag_name"],
                         "published_at": item.get("published_at"),
                         "action": "delete" if reason == "eligible" and not extra else "retain",
                         "reasons": sorted(({reason} if reason != "eligible" else set()) | extra) or ["older-than-30-days-and-outside-newest-20"]})
    # A changed cross-component inventory during pin discovery can otherwise
    # hide a retained release at a pagination boundary. Fail closed and retry
    # next invocation. The same snapshot is checked before daemon mutations.
    fingerprint = frontend_fingerprint(inventory)
    if frontend_fingerprint({repo: gh.releases(repo) for repo in PAIRS["cloudlands-fe"]}) != fingerprint:
        raise CleanupError("frontend inventory changed during protection discovery; rerun")
    return {"generated_at": now.isoformat(), "policy": {"days": 30, "newest": 20},
            "frontend_fingerprint": fingerprint, "releases": rows}


def asset_signature(assets):
    if assets is None:
        return None
    if not isinstance(assets, list):
        raise CleanupError("invalid asset metadata in release inventory")
    result = []
    for asset in assets:
        if not isinstance(asset, dict) or type(asset.get("id")) is not int or not isinstance(asset.get("name"), str):
            raise CleanupError("invalid asset metadata in release inventory")
        result.append({key: asset.get(key) for key in ("id", "name", "size", "updated_at", "digest", "state")})
    return sorted(result, key=lambda a: a["id"])


def frontend_fingerprint(inventory):
    # Download counters (including our own manifest reads), release notes and
    # authors cannot affect pin protection and must not invalidate the snapshot.
    values = {}
    for repo in PAIRS["cloudlands-fe"]:
        values[repo] = []
        for row in inventory[repo]:
            validate_release(row)
            item = {key: row.get(key) for key in ("id", "tag_name", "draft", "prerelease", "published_at")}
            item["assets"] = asset_signature(row.get("assets"))
            values[repo].append(item)
        values[repo].sort(key=lambda r: r["id"])
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def apply_plan(gh, plan, component, now, max_delete=20, audit=None):
    """Apply a bounded batch inside the caller's writer lock; stop on failure.

    Refresh the entire protection graph once under the same-component lock.
    Before EACH daemon delete, refresh both FE inventories and main's pin.
    A changing FE inventory stops the batch rather than rebuilding hundreds of
    dependencies mid-flight. A later invocation resumes from live inventories.
    This preserves all pre-batch FE dependencies, including concurrent promotion
    targets; deletion of a FE record merely delays reclaiming its daemon pin.
    """
    if component not in PAIRS or type(max_delete) is not int or max_delete < 1:
        raise CleanupError("apply requires exactly one component and a positive batch limit")
    outcomes = []

    def record(outcome):
        outcomes.append(outcome)
        if audit:
            audit(outcome)

    candidates = [r for r in plan["releases"] if r["repo"] in PAIRS[component] and r["action"] == "delete"]
    try:
        fresh = build_plan(gh, now)
        current_rows = {(r["repo"], r["id"]): r for r in fresh["releases"]}
    except CleanupError as error:
        return {"ok": False, "outcomes": [], "error": str(error), "deferred": len(candidates)}
    attempted = 0
    for row in candidates:
        if attempted >= max_delete:
            break
        outcome = {key: row[key] for key in ("repo", "id", "tag")}
        try:
            current = current_rows.get((row["repo"], row["id"]))
            if current is None:
                outcome["outcome"] = "already-removed"
            elif current["tag"] != row["tag"] or current["action"] != "delete":
                outcome["outcome"] = "retained-on-recheck"
            else:
                if component == "intentd":
                    inventory = {repo: gh.releases(repo) for repo in PAIRS["cloudlands-fe"]}
                    if frontend_fingerprint(inventory) != fresh["frontend_fingerprint"]:
                        raise CleanupError("frontend inventory changed before deletion; rerun")
                    if version(gh.pin("main")) == version(row["tag"]):
                        record({**outcome, "outcome": "retained-on-recheck"})
                        continue
                # Writer exclusion closes the race after these reads. The
                # release-ID check also detects metadata edits or recreation.
                item = gh.release(row["repo"], row["id"])
                if item is None:
                    outcome["outcome"] = "already-removed"
                else:
                    validate_release(item)
                    if (item["tag_name"] != row["tag"] or item["draft"] or not item["prerelease"]
                            or item["published_at"] != current["published_at"]
                            or timestamp(item["published_at"]) >= now - timedelta(days=30)):
                        outcome["outcome"] = "retained-on-recheck"
                    else:
                        attempted += 1
                        if audit:
                            audit({**outcome, "outcome": "deleting"})
                        deleted = gh.delete_release(row["repo"], row["id"])
                        outcome["outcome"] = "deleted" if deleted else "already-removed"
            record(outcome)
        except CleanupError as error:
            record({**outcome, "outcome": "failed", "error": str(error)})
            return {"ok": False, "outcomes": outcomes, "deferred": len(candidates) - len(outcomes)}
    return {"ok": True, "outcomes": outcomes, "deferred": len(candidates) - len(outcomes)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--component", choices=["all", *PAIRS], default="all")
    parser.add_argument("--apply", action="store_true", help="delete eligible releases; requires component writer lock")
    parser.add_argument("--max-delete", type=int, default=20, help="maximum release deletions per apply (default: 20)")
    args = parser.parse_args(argv)
    if args.max_delete < 1:
        parser.error("--max-delete must be positive")
    if args.apply:
        if args.component == "all":
            parser.error("--apply requires --component intentd or cloudlands-fe")
        if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != PAIRS[args.component][0]:
            parser.error("--apply must run in its component source Actions job under the shared writer lock")
    now = datetime.now(timezone.utc)
    try:
        gh = GitHub()
        plan = build_plan(gh, now)
        selected = REPOSITORIES if args.component == "all" else PAIRS[args.component]
        report = {"mode": "apply" if args.apply else "preview", "component": args.component,
                  **plan, "releases": [r for r in plan["releases"] if r["repo"] in selected]}
        if args.apply:
            report.update(apply_plan(gh, plan, args.component, now, args.max_delete,
                                     audit=lambda entry: print(json.dumps(entry, sort_keys=True), file=sys.stderr, flush=True)))
        else:
            report["ok"] = True
        print(json.dumps(report, indent=2, sort_keys=True), flush=True)
        return 0 if report["ok"] else 1
    except CleanupError as error:
        print(json.dumps({"ok": False, "mode": "apply" if args.apply else "preview", "error": str(error)}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
