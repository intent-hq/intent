"""Offline retention and destructive-path tests. Never contacts GitHub."""
import copy
import base64
import os
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("cleanup", Path(__file__).with_name("cleanup_prereleases.py"))
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)
NOW = datetime(2026, 9, 28, tzinfo=timezone.utc)
DAEMON, DAEMON_MIRROR, FE, FE_MIRROR = cleanup.REPOSITORIES


def release(number, age=60, **fields):
    value = {"id": number, "tag_name": f"v1.0.{number}", "prerelease": True,
             "draft": False, "published_at": (NOW - timedelta(days=age)).isoformat(),
             "created_at": (NOW - timedelta(days=age + 1)).isoformat()}
    value.update(fields)
    return value


class FakeGitHub:
    def __init__(self):
        self.inventory = {repo: [] for repo in cleanup.REPOSITORIES}
        self.assets = {}
        self.pins = {"main": "9.0.0"}
        self.deleted = []
        self.failure = None
        self.reads = []

    def releases(self, repo):
        self.reads.append(repo)
        return copy.deepcopy(self.inventory[repo])

    def asset_texts(self, repo, item):
        return dict(self.assets.get((repo, item["tag_name"]), {}))

    def pin(self, ref):
        if ref not in self.pins and ref in HISTORICAL_COMMITS:
            with patch.object(cleanup.GitHub, "request", side_effect=historical_request):
                return cleanup.GitHub().pin(ref)
        value = self.pins[ref]
        if isinstance(value, Exception):
            raise value
        return value

    def source_built(self, tag, manifest=None):
        with patch.object(cleanup.GitHub, "request", side_effect=historical_request):
            return cleanup.GitHub().source_built(tag, manifest)

    def release(self, repo, ident):
        return next((copy.deepcopy(r) for r in self.inventory[repo] if r["id"] == ident), None)

    def delete_release(self, repo, ident):
        if self.failure:
            raise self.failure
        self.deleted.append((repo, ident))
        self.inventory[repo] = [r for r in self.inventory[repo] if r["id"] != ident]
        return True


class SelectionTests(unittest.TestCase):
    def select(self, rows):
        return cleanup.select_releases(rows, NOW)

    def test_keep_newest_twenty_and_thirty_day_boundary(self):
        rows = [release(i, 40 + i) for i in range(1, 25)]
        rows += [release(50, 30), release(51, 29), release(52, -1)]
        reasons = self.select(list(reversed(rows)))
        self.assertEqual([i for i, why in reasons.items() if why == "eligible"], [18, 19, 20, 21, 22, 23, 24])
        self.assertEqual(reasons[50], "within-30-days")

    def test_stable_draft_channels_sitter_and_unknown_tags_are_never_candidates(self):
        rows = [release(1, prerelease=False), release(2, draft=True, published_at=None)]
        rows += [release(i + 3, tag_name=tag) for i, tag in enumerate(
            ["alpha", "beta", "stable", "channel-alpha", "channel-beta", "channel-stable", "sitter-v1.0.0", "sitter-latest", "unknown"])]
        self.assertNotIn("eligible", self.select(rows).values())

    def test_metadata_not_suffix_controls_prerelease_and_stable_does_not_consume_count(self):
        rows = [release(i) for i in range(1, 22)] + [release(99, 1, prerelease=False, tag_name="v2.0.0-beta.1")]
        self.assertEqual(sum(v == "eligible" for v in self.select(rows).values()), 1)

    def test_order_ties_are_deterministic(self):
        rows = [release(i) for i in range(1, 25)]
        self.assertEqual(self.select(rows), self.select(list(reversed(rows))))

    def test_invalid_metadata_fails_closed(self):
        for field, value in [("prerelease", "true"), ("draft", None), ("id", True),
                             ("published_at", None), ("published_at", "2026-01-01"), ("tag_name", "")]:
            with self.subTest(field=field, value=value), self.assertRaises(cleanup.CleanupError):
                self.select([release(1, **{field: value})])
        with self.assertRaises(cleanup.CleanupError):
            self.select([release(1), release(1)])


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()
        for repo in (DAEMON, DAEMON_MIRROR):
            self.gh.inventory[repo] = [release(i, 40 + i) for i in range(1, 25)]

    def plan(self):
        return cleanup.build_plan(self.gh, NOW)

    def test_source_and_mirror_channels_both_protect_versions(self):
        for repo, version in [(DAEMON, "1.0.23"), (DAEMON_MIRROR, "1.0.24")]:
            self.gh.inventory[repo].append(release(99, tag_name="channel-beta"))
            self.gh.assets[repo, "channel-beta"] = {"beta.json": json.dumps({"version": version, "tag": "v" + version, "channel": "beta"})}
        plan = self.plan()
        for repo in (DAEMON, DAEMON_MIRROR):
            self.assertEqual({r["tag"] for r in plan["releases"] if r["repo"] == repo and r["action"] == "delete"}, {"v1.0.21", "v1.0.22"})

    def test_stable_in_either_repo_protects_counterpart(self):
        self.gh.inventory[DAEMON][23]["prerelease"] = False
        self.assertFalse(any(r["action"] == "delete" and r["tag"] == "v1.0.24" for r in self.plan()["releases"]))

    def test_main_and_all_frontend_release_pins_protect_daemon(self):
        self.gh.pins["main"] = "1.0.21"
        self.gh.inventory[FE] = [release(30)]
        self.gh.pins["v1.0.30"] = "1.0.22"
        self.gh.inventory[FE_MIRROR] = [release(31)]
        self.gh.assets[FE_MIRROR, "v1.0.31"] = {"release-manifest.json": json.dumps({"intentdVersion": "1.0.23"})}
        self.assertEqual({r["tag"] for r in self.plan()["releases"] if r["action"] == "delete"}, {"v1.0.24"})

    def test_daemon_keeps_pin_even_for_frontend_release_selected_for_deletion(self):
        self.gh.inventory[FE] = [release(i, 40 + i) for i in range(1, 25)]
        for i in range(1, 25):
            self.gh.pins[f"v1.0.{i}"] = "9.0.0"
        self.gh.pins["v1.0.24"] = "1.0.24"
        rows = self.plan()["releases"]
        self.assertTrue(any(r["repo"] == FE and r["tag"] == "v1.0.24" and r["action"] == "delete" for r in rows))
        self.assertFalse(any(r["repo"] in (DAEMON, DAEMON_MIRROR) and r["tag"] == "v1.0.24" and r["action"] == "delete" for r in rows))

    def test_stable_and_draft_frontend_records_keep_their_daemon_pins(self):
        self.gh.inventory[FE] = [release(30, prerelease=False), release(31, draft=True, published_at=None)]
        self.gh.pins.update({"v1.0.30": "1.0.23", "v1.0.31": "1.0.24"})
        self.assertFalse(any(r["action"] == "delete" and r["tag"] in ("v1.0.23", "v1.0.24") for r in self.plan()["releases"]))

    def test_frontend_each_platform_feed_is_protected(self):
        for repo in (FE, FE_MIRROR):
            self.gh.inventory[repo] = [release(i, 40 + i) for i in range(1, 25)]
        for i in range(1, 25):
            self.gh.pins[f"v1.0.{i}"] = "9.0.0"
        self.gh.inventory[FE_MIRROR].append(release(99, tag_name="stable"))
        self.gh.assets[FE_MIRROR, "stable"] = {"latest-mac.yml": "version: '1.0.23'\n", "latest-linux.yml": "version: 1.0.24\n"}
        rows = self.plan()["releases"]
        self.assertFalse(any(r["action"] == "delete" and r["repo"] in (FE, FE_MIRROR) and r["tag"] in ("v1.0.23", "v1.0.24") for r in rows))

    def test_missing_channel_is_optional_but_existing_incomplete_channel_aborts(self):
        self.plan()
        self.gh.inventory[DAEMON].append(release(99, tag_name="channel-beta"))
        with self.assertRaises(cleanup.CleanupError):
            self.plan()

    def test_malformed_manifest_or_unreadable_pin_aborts_before_deletion(self):
        self.gh.inventory[FE] = [release(30)]
        self.gh.pins["v1.0.30"] = cleanup.CleanupError("missing historical pin")
        with self.assertRaises(cleanup.CleanupError):
            self.plan()
        self.gh.assets[FE, "v1.0.30"] = {"release-manifest.json": "{}"}
        with self.assertRaises(cleanup.CleanupError):
            self.plan()
        self.assertEqual(self.gh.deleted, [])

    def test_preview_makes_no_deletes(self):
        plan = self.plan()
        self.assertTrue(any(r["action"] == "delete" for r in plan["releases"]))
        self.assertEqual(self.gh.deleted, [])

    def test_apply_rechecks_protection_and_eligibility(self):
        plan = self.plan()
        self.gh.pins["main"] = "1.0.24"
        self.gh.inventory[DAEMON][22]["prerelease"] = False
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertTrue(result["ok"])
        self.assertEqual({ident for _, ident in self.gh.deleted}, {21, 22})

    def test_partial_delete_failure_stops_and_reports_outcomes(self):
        plan = self.plan()
        original = self.gh.delete_release
        def fail_second(repo, ident):
            if self.gh.deleted:
                raise cleanup.CleanupError("HTTP 403; rate limited")
            return original(repo, ident)
        self.gh.delete_release = fail_second
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertFalse(result["ok"])
        self.assertEqual([r["outcome"] for r in result["outcomes"]], ["deleted", "failed"])

    def test_removed_candidate_is_idempotent_and_tags_are_not_deleted(self):
        plan = self.plan()
        self.gh.inventory[DAEMON] = [r for r in self.gh.inventory[DAEMON] if r["id"] != 21]
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertTrue(result["ok"])
        self.assertIn("already-removed", [r["outcome"] for r in result["outcomes"]])
        self.assertEqual(cleanup.apply_plan(self.gh, plan, "intentd", NOW)["ok"], True)


class GitHubTests(unittest.TestCase):
    @patch.object(cleanup.GitHub, "request")
    def test_inventory_paginates_and_does_not_accept_failed_later_page(self, request):
        request.side_effect = [[release(i) for i in range(1, 101)], [release(101)]]
        self.assertEqual(len(cleanup.GitHub().releases(DAEMON)), 101)
        self.assertIn("page=2", request.call_args.args[0])
        request.side_effect = [[release(i) for i in range(1, 101)], cleanup.CleanupError("HTTP 429")]
        with self.assertRaises(cleanup.CleanupError):
            cleanup.GitHub().releases(DAEMON)

    @patch("subprocess.run")
    def test_delete_only_targets_release_id(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "HTTP/2.0 204 No Content\r\n\r\n", "")
        self.assertTrue(cleanup.GitHub().delete_release(DAEMON, 123))
        args = run.call_args.args[0]
        self.assertIn(f"repos/{DAEMON}/releases/123", args)
        self.assertIn("DELETE", args)
        self.assertFalse(any("refs/tags" in arg for arg in args))

    @patch("subprocess.run")
    def test_404_is_only_optional_when_requested_and_403_is_failure(self, run):
        gh = cleanup.GitHub()
        for status in (403, 429, 500):
            run.return_value = subprocess.CompletedProcess([], 1, f"HTTP/2.0 {status} Error\n\n{{}}", "secret")
            with self.assertRaises(cleanup.CleanupError):
                gh.request("repos/x/y/releases/1", missing_ok=True)
        run.return_value = subprocess.CompletedProcess([], 1, "HTTP/2.0 404 Not Found\n\n{}", "")
        self.assertIsNone(gh.request("repos/x/y/releases/1", missing_ok=True))
        with self.assertRaises(cleanup.CleanupError):
            gh.request("repos/x/y/releases/1")

    @patch.object(cleanup.GitHub, "request")
    def test_failed_asset_download_is_not_missing(self, request):
        request.side_effect = [[{"id": 1, "name": "beta.json"}], cleanup.CleanupError("HTTP 403")]
        with self.assertRaises(cleanup.CleanupError):
            cleanup.GitHub().asset_texts(DAEMON, release(2, tag_name="channel-beta"))


class ProtectionValidationTests(unittest.TestCase):
    def test_feed_parser_rejects_duplicate_empty_multiline_and_malformed_versions(self):
        for text in ["", "version: 1.2.3\nversion: 2.0.0\n", "version: |\n  1.2.3\n", "version: missing\n"]:
            with self.subTest(text=text), self.assertRaises(cleanup.CleanupError):
                cleanup.feed_version(text)

    def test_manifest_platform_url_cannot_reference_a_different_release(self):
        gh = FakeGitHub()
        gh.inventory[DAEMON] = [release(1, tag_name="channel-alpha")]
        manifest = {"version": "1.2.3", "tag": "v1.2.3", "channel": "alpha", "platforms": {
            "target": {"url": f"https://github.com/{DAEMON}/releases/download/v1.2.2/file.tar.xz"}}}
        gh.assets[DAEMON, "channel-alpha"] = {"alpha.json": json.dumps(manifest)}
        with self.assertRaisesRegex(cleanup.CleanupError, "platform URL"):
            cleanup.build_plan(gh, NOW)

    def test_missing_required_pin_404_does_not_mean_no_dependency(self):
        with patch.object(cleanup.GitHub, "request", side_effect=cleanup.CleanupError("HTTP 404")) as request:
            with self.assertRaises(cleanup.CleanupError):
                cleanup.GitHub().pin("v1.0.0")
            self.assertNotIn("missing_ok", request.call_args.kwargs)

    def test_pin_parsing_handles_comments_and_rejects_multiple_versions(self):
        for contents, expected in [("# comment\n1.2.3\n", "1.2.3"), ("1.2.3\n2.0.0\n", None), ("bad", None)]:
            with patch.object(cleanup.GitHub, "request", return_value={"encoding": "base64", "content": base64.b64encode(contents.encode()).decode()}):
                if expected:
                    self.assertEqual(cleanup.GitHub().pin("main"), expected)
                else:
                    with self.assertRaises(cleanup.CleanupError):
                        cleanup.GitHub().pin("main")

    def test_pin_cache_uses_resolved_commit_and_follows_moved_tag(self):
        first, second = "a" * 40, "b" * 40
        contents = lambda value: {"encoding": "base64", "content": base64.b64encode(value.encode()).decode()}
        responses = [{"object": {"sha": first, "type": "commit"}}, contents("1.2.3"),
                     {"object": {"sha": first, "type": "commit"}},
                     {"object": {"sha": second, "type": "commit"}}, contents("1.2.4")]
        with patch.object(cleanup.GitHub, "request", side_effect=responses) as request:
            gh = cleanup.GitHub()
            self.assertEqual(gh.pin("v3.0.0"), "1.2.3")
            self.assertEqual(gh.pin("v3.0.0"), "1.2.3")
            self.assertEqual(gh.pin("v3.0.0"), "1.2.4")
            self.assertEqual(request.call_count, 5)
            self.assertTrue(request.call_args_list[1].args[0].endswith("ref=" + first))
            self.assertTrue(request.call_args_list[4].args[0].endswith("ref=" + second))

    def test_pin_peels_annotated_tag(self):
        tag, commit = "a" * 40, "b" * 40
        responses = [{"object": {"sha": tag, "type": "tag"}}, {"object": {"sha": commit, "type": "commit"}},
                     {"encoding": "base64", "content": base64.b64encode(b"1.2.3").decode()}]
        with patch.object(cleanup.GitHub, "request", side_effect=responses) as request:
            self.assertEqual(cleanup.GitHub().pin("v3.0.0"), "1.2.3")
            self.assertIn("/git/tags/" + tag, request.call_args_list[1].args[0])

    def test_apply_library_refuses_all_components(self):
        with self.assertRaises(cleanup.CleanupError):
            cleanup.apply_plan(FakeGitHub(), {"releases": []}, "all", NOW)

    def test_audit_records_attempt_before_delete_then_result(self):
        gh = FakeGitHub()
        gh.inventory[DAEMON] = [release(i, 40 + i) for i in range(1, 22)]
        plan = cleanup.build_plan(gh, NOW)
        events = []
        original = gh.delete_release
        def checked(repo, ident):
            self.assertEqual(events[-1]["outcome"], "deleting")
            return original(repo, ident)
        gh.delete_release = checked
        result = cleanup.apply_plan(gh, plan, "intentd", NOW, audit=events.append)
        self.assertTrue(result["ok"])
        self.assertEqual([e["outcome"] for e in events], ["deleting", "deleted"])


class MockTransport:
    """Exercise the real gh adapter + CLI without a network or real gh binary."""
    def __init__(self, count=24):
        self.inventory = {repo: [release(i, 40 + i, assets=[]) for i in range(1, count + 1)] for repo in cleanup.REPOSITORIES}
        self.calls = []
        self.deleted = []
        self.fail_delete = None
        self.bodies = {}
        for row in self.inventory[FE_MIRROR]:
            ident = 10000 + row["id"]
            row["assets"] = [{"id": ident, "name": "release-manifest.json", "size": 28, "updated_at": "2026-01-01T00:00:00Z"}]
            self.bodies[ident] = json.dumps({"intentdVersion": "9.0.0"})

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        assert args[:4] == ["gh", "api", "--hostname", "github.com"]
        endpoint = args[4]
        parsed = urlsplit(endpoint)
        parts = parsed.path.split("/")
        repo = "/".join(parts[1:3])
        tail = parts[3:]
        method = args[args.index("--method") + 1]
        status = 200
        if method == "DELETE":
            assert tail[0] == "releases" and len(tail) == 2
            if self.fail_delete and len(self.deleted) == self.fail_delete - 1:
                status, data = 403, {"message": "rate limited"}
            else:
                ident = int(tail[1])
                self.deleted.append((repo, ident))
                self.inventory[repo] = [r for r in self.inventory[repo] if r["id"] != ident]
                status, data = 204, ""
        elif tail == ["releases"]:
            page = int(parse_qs(parsed.query)["page"][0])
            data = copy.deepcopy(self.inventory[repo][(page - 1) * 100:page * 100])
        elif tail[:2] == ["releases", "assets"]:
            data = self.bodies[int(tail[2])]
        elif tail[0] == "releases" and tail[-1] == "assets":
            row = next(r for r in self.inventory[repo] if r["id"] == int(tail[1]))
            data = copy.deepcopy(row["assets"])
        elif tail[0] == "releases":
            data = next((copy.deepcopy(r) for r in self.inventory[repo] if r["id"] == int(tail[1])), None)
            if data is None:
                status, data = 404, {}
        elif tail == ["contents", "intentd.version"]:
            data = {"encoding": "base64", "content": base64.b64encode(b"# pin\n9.0.0\n").decode()}
        else:
            raise AssertionError(f"unexpected GitHub call {args}")
        body = data if isinstance(data, str) else json.dumps(data)
        return subprocess.CompletedProcess(args, int(status >= 400), f"HTTP/2.0 {status} Test\nContent-Type: application/json\n\n{body}", "")


class FunctionalTests(unittest.TestCase):
    def run_cli(self, transport, args):
        output = io.StringIO()
        with patch("subprocess.run", side_effect=transport), patch("sys.stdout", output), patch("sys.stderr", io.StringIO()):
            code = cleanup.main(args)
        return code, json.loads(output.getvalue())

    def test_default_preview_all_repositories_without_mutation(self):
        transport = MockTransport()
        code, report = self.run_cli(transport, [])
        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "preview")
        self.assertEqual({r["repo"] for r in report["releases"]}, set(cleanup.REPOSITORIES))
        self.assertEqual(transport.deleted, [])
        self.assertTrue(all(args[args.index("--method") + 1] == "GET" for args in transport.calls))

    def test_apply_requires_one_pair_and_source_actions_environment(self):
        for args, env in [(["--apply"], {}), (["--apply", "--component", "intentd"], {}),
                          (["--apply", "--component", "intentd"], {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": FE})]:
            with self.subTest(args=args, env=env), patch.dict(os.environ, env, clear=True), patch("subprocess.run") as run, patch("sys.stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    cleanup.main(args)
                self.assertEqual(error.exception.code, 2)
                run.assert_not_called()

    def test_explicit_apply_is_bounded_to_component_and_resumes(self):
        for component, source in [("intentd", DAEMON), ("cloudlands-fe", FE)]:
            transport = MockTransport()
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": source}):
                code, report = self.run_cli(transport, ["--apply", "--component", component, "--max-delete", "2"])
                self.assertEqual(code, 0)
                self.assertEqual(len(transport.deleted), 2)
                self.assertEqual(report["deferred"], 6)
                self.assertTrue(all(repo in cleanup.PAIRS[component] for repo, _ in transport.deleted))
                code, report = self.run_cli(transport, ["--apply", "--component", component])
                self.assertEqual(code, 0)
                self.assertEqual(len(transport.deleted), 8)
                self.assertEqual(report["deferred"], 0)

    def test_partial_failure_preserves_audit_and_stops(self):
        transport = MockTransport()
        transport.fail_delete = 2
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": DAEMON}):
            code, report = self.run_cli(transport, ["--apply", "--component", "intentd"])
        self.assertEqual(code, 1)
        self.assertEqual([r["outcome"] for r in report["outcomes"]], ["deleted", "failed"])
        self.assertEqual(len(transport.deleted), 1)

    def test_large_history_request_budget_caches_version_data_not_main(self):
        transport = MockTransport(count=400)
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": DAEMON}):
            code, report = self.run_cli(transport, ["--apply", "--component", "intentd"])
        self.assertEqual(code, 0)
        self.assertEqual(len(transport.deleted), 20)
        self.assertEqual(report["deferred"], 740)
        self.assertLessEqual(len(transport.calls), 1150)
        manifest_reads = [args for args in transport.calls if "/releases/assets/" in args[4]]
        self.assertEqual(len(manifest_reads), 400)
        main_reads = [args for args in transport.calls if "/contents/intentd.version?ref=main" in args[4]]
        self.assertEqual(len(main_reads), 22)

    def test_download_counters_do_not_invalidate_protection_snapshot_or_asset_cache(self):
        transport = MockTransport()
        before = cleanup.frontend_fingerprint(transport.inventory)
        with patch("subprocess.run", side_effect=transport):
            gh = cleanup.GitHub()
            row = transport.inventory[FE_MIRROR][0]
            gh.asset_texts(FE_MIRROR, row)
            reads = len(transport.calls)
            row["assets"][0]["download_count"] = 50
            gh.asset_texts(FE_MIRROR, row)
            self.assertEqual(len(transport.calls), reads)
        self.assertEqual(cleanup.frontend_fingerprint(transport.inventory), before)

    def test_asset_cache_invalidates_when_inventory_metadata_changes(self):
        transport = MockTransport()
        with patch("subprocess.run", side_effect=transport):
            gh = cleanup.GitHub()
            first = copy.deepcopy(transport.inventory[FE_MIRROR][0])
            self.assertIn("release-manifest.json", gh.asset_texts(FE_MIRROR, first))
            reads = len(transport.calls)
            gh.asset_texts(FE_MIRROR, first)
            self.assertEqual(len(transport.calls), reads)
            transport.inventory[FE_MIRROR][0]["assets"][0]["updated_at"] = "2026-09-01T00:00:00Z"
            gh.asset_texts(FE_MIRROR, transport.inventory[FE_MIRROR][0])
            self.assertGreater(len(transport.calls), reads)


class RaceTests(unittest.TestCase):
    setUp = PlanTests.setUp
    plan = PlanTests.plan

    def test_inventory_changes_during_discovery_aborts(self):
        original = self.gh.releases
        calls = 0
        def changing(repo):
            nonlocal calls
            calls += 1
            if calls == 5:
                self.gh.inventory[FE].append(release(99))
            return original(repo)
        self.gh.releases = changing
        with self.assertRaisesRegex(cleanup.CleanupError, "inventory changed"):
            self.plan()

    def test_frontend_changes_after_batch_preflight_stop_deletion(self):
        plan = self.plan()
        original = self.gh.releases
        calls = 0
        def changing(repo):
            nonlocal calls
            calls += 1
            if calls == 7:
                self.gh.inventory[FE].append(release(99))
            return original(repo)
        self.gh.releases = changing
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertFalse(result["ok"])
        self.assertEqual(self.gh.deleted, [])

    def test_main_pin_is_fresh_between_deletions(self):
        plan = self.plan()
        original = self.gh.pin
        calls = 0
        def moving(ref):
            nonlocal calls
            if ref == "main":
                calls += 1
                if calls > 1:
                    return "1.0.21"
            return original(ref)
        self.gh.pin = moving
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertTrue(result["ok"])
        self.assertNotIn(21, [ident for _, ident in self.gh.deleted])

    def test_direct_candidate_recheck_prevents_promoted_release_deletion(self):
        plan = self.plan()
        original = self.gh.release
        def promoted(repo, ident):
            row = original(repo, ident)
            row["prerelease"] = False
            return row
        self.gh.release = promoted
        result = cleanup.apply_plan(self.gh, plan, "intentd", NOW)
        self.assertTrue(result["ok"])
        self.assertEqual(self.gh.deleted, [])

    def test_frontend_channel_missing_version_record_still_protects_pin(self):
        self.gh.inventory[FE_MIRROR].append(release(99, tag_name="alpha"))
        self.gh.assets[FE_MIRROR, "alpha"] = {"latest-mac.yml": "version: 2.0.1\n"}
        self.gh.pins["v2.0.1"] = "1.0.24"
        self.assertFalse(any(r["tag"] == "v1.0.24" and r["action"] == "delete" for r in self.plan()["releases"]))


HISTORICAL_COMMITS = {
    "v2.0.0": "05d52553e4b7a0b88c988b34bfe47f155a7ade56",
    "v2.0.8": "06fa9109bee33fa49cef5b7555948dce3567c68b",
}
LEGACY_MANIFEST = {
    "version": "2.0.8", "feTag": "20d962f3cda2fc2180dedb0c577f95754756a0b2",
    "feSha": "20d962f3cda2fc2180dedb0c577f95754756a0b2",
    "intentdSha": "beab5e01f79d54b6a2ecb40fea4852b51dd4dabb",
    "generatedAt": "2026-07-20T15:03:02.938Z",
}


def historical_request(endpoint, **kwargs):
    if "/git/ref/tags/" in endpoint:
        tag = endpoint.rsplit("/", 1)[-1]
        return {"object": {"sha": HISTORICAL_COMMITS[tag], "type": "commit"}}
    if "/contents/.github/workflows/release-beta.yml?ref=" in endpoint:
        commit = endpoint.split("ref=")[1]
        blob = {HISTORICAL_COMMITS["v2.0.0"]: "28844ebdac4d8ea6302f4af9c422777b99557a1c",
                HISTORICAL_COMMITS["v2.0.8"]: "f6333f811ba11c70edd90732a9467b7b856f0184",
                LEGACY_MANIFEST["feSha"]: "f6333f811ba11c70edd90732a9467b7b856f0184"}[commit]
        return {"type": "file", "path": ".github/workflows/release-beta.yml", "sha": blob}
    if endpoint == f"repos/{DAEMON}/git/commits/{LEGACY_MANIFEST['intentdSha']}":
        return {"sha": LEGACY_MANIFEST["intentdSha"]}
    raise cleanup.CleanupError("HTTP 404: fixture file is absent")


class HistoricalRegressionTests(unittest.TestCase):
    def test_exact_source_built_no_manifest_no_pin_can_be_planned(self):
        gh = FakeGitHub()
        gh.inventory[FE_MIRROR] = [release(1, tag_name="v2.0.0")]
        plan = cleanup.build_plan(gh, NOW)
        self.assertIn("v2.0.0", plan["source_built_frontend"])

    def test_validated_sha_only_manifest_has_no_versioned_release_dependency(self):
        gh = FakeGitHub()
        gh.inventory[FE_MIRROR] = [release(1, tag_name="v2.0.8")]
        gh.assets[FE_MIRROR, "v2.0.8"] = {"release-manifest.json": json.dumps(LEGACY_MANIFEST)}
        plan = cleanup.build_plan(gh, NOW)
        self.assertIn("v2.0.8", plan["source_built_frontend"])

    def test_unknown_missing_pin_still_fails_closed(self):
        with patch.object(cleanup.GitHub, "request", side_effect=[{"object": {"sha": "a" * 40, "type": "commit"}}, cleanup.CleanupError("HTTP 404")]):
            with self.assertRaises(cleanup.CleanupError):
                cleanup.GitHub().pin("v1.99.0")

    def test_known_tag_must_still_match_reviewed_commit(self):
        def moved(endpoint, **kwargs):
            if "/git/ref/tags/" in endpoint:
                return {"object": {"sha": "a" * 40, "type": "commit"}}
            return historical_request(endpoint, **kwargs)
        with patch.object(cleanup.GitHub, "request", side_effect=moved):
            with self.assertRaises(cleanup.CleanupError):
                cleanup.GitHub().pin("v2.0.0")

    def test_source_build_requires_successful_matching_workflow_metadata(self):
        for failure in [cleanup.CleanupError("HTTP 403"), cleanup.CleanupError("HTTP 404"),
                        {"type": "file", "path": ".github/workflows/release-beta.yml", "sha": "a" * 40}]:
            def denied(endpoint, **kwargs):
                if "/contents/.github/" in endpoint:
                    if isinstance(failure, Exception):
                        raise failure
                    return failure
                return historical_request(endpoint, **kwargs)
            with self.subTest(failure=failure), patch.object(cleanup.GitHub, "request", side_effect=denied):
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.GitHub().pin("v2.0.0")

    def test_legacy_requires_authenticated_matching_daemon_commit(self):
        for failure in [cleanup.CleanupError("HTTP 403"), cleanup.CleanupError("HTTP 404"), {"sha": "a" * 40}]:
            def invalid(endpoint, **kwargs):
                if endpoint.startswith(f"repos/{DAEMON}/git/commits/"):
                    if isinstance(failure, Exception):
                        raise failure
                    return failure
                return historical_request(endpoint, **kwargs)
            with self.subTest(failure=failure), patch.object(cleanup.GitHub, "request", side_effect=invalid):
                with self.assertRaises(cleanup.CleanupError):
                    cleanup.GitHub().source_built("v2.0.8", LEGACY_MANIFEST)

    def test_unknown_release_cannot_claim_legacy_schema(self):
        gh = FakeGitHub()
        gh.inventory[FE_MIRROR] = [release(1, tag_name="v3.0.8")]
        gh.assets[FE_MIRROR, "v3.0.8"] = {"release-manifest.json": json.dumps({**LEGACY_MANIFEST, "version": "3.0.8"})}
        with self.assertRaisesRegex(cleanup.CleanupError, "no reviewed source-build provenance"):
            cleanup.build_plan(gh, NOW)

    def test_malformed_or_mismatched_legacy_manifest_never_weakens_protection(self):
        for key, value in [("version", "2.0.7"), ("feSha", "a" * 40), ("feTag", "v2.0.8"),
                           ("intentdSha", "garbage"), ("generatedAt", "missing"),
                           ("intentdVersion", None), ("extra", True)]:
            data = {**LEGACY_MANIFEST, key: value}
            gh = FakeGitHub()
            gh.inventory[FE_MIRROR] = [release(1, tag_name="v2.0.8")]
            gh.assets[FE_MIRROR, "v2.0.8"] = {"release-manifest.json": json.dumps(data)}
            with self.subTest(key=key), self.assertRaises(cleanup.CleanupError):
                cleanup.build_plan(gh, NOW)


class Ambiguous404RegressionTests(unittest.TestCase):
    run_cli = FunctionalTests.run_cli
    def ambiguous(self, mode, confirmation="present", after_success=False):
        transport = MockTransport()
        missed = False
        def request(args, **kwargs):
            nonlocal missed
            method = args[args.index("--method") + 1]
            endpoint = args[4]
            should_miss = method == mode and endpoint.startswith(f"repos/{DAEMON}/releases/") and endpoint.rsplit("/", 1)[-1].isdigit()
            if after_success and not transport.deleted:
                should_miss = False
            if should_miss:
                missed = True
                transport.calls.append(args)
                if confirmation == "absent":
                    ident = int(endpoint.rsplit("/", 1)[-1])
                    transport.inventory[DAEMON] = [r for r in transport.inventory[DAEMON] if r["id"] != ident]
                return subprocess.CompletedProcess(args, 1, 'HTTP/2.0 404 Not Found\n\n{}', '')
            if missed and confirmation in ("403", "404", "429") and f"repos/{DAEMON}/releases?" in endpoint:
                transport.calls.append(args)
                return subprocess.CompletedProcess(args, 1, f'HTTP/2.0 {confirmation} Error\n\n{{}}', '')
            return transport(args, **kwargs)
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": DAEMON}):
            code, report = self.run_cli(request, ["--component", "intentd", "--apply"])
        return code, report, transport

    def test_get_and_delete_404_with_extant_candidate_fail_and_stop(self):
        for method in ("GET", "DELETE"):
            with self.subTest(method=method):
                code, report, transport = self.ambiguous(method)
                self.assertEqual(code, 1)
                self.assertFalse(report["ok"])
                self.assertEqual([r["outcome"] for r in report["outcomes"]], ["failed"])
                self.assertEqual(transport.deleted, [])
                self.assertLessEqual(sum(args[args.index("--method") + 1] == "DELETE" for args in transport.calls), 1)

    def test_genuine_confirmed_absence_is_idempotent(self):
        for method in ("GET", "DELETE"):
            code, report, _ = self.ambiguous(method, "absent")
            self.assertEqual(code, 0)
            self.assertTrue(report["ok"])
            self.assertIn("already-removed", [r["outcome"] for r in report["outcomes"]])

    def test_denied_or_failed_inventory_confirmation_is_failure(self):
        for status in ("403", "404", "429"):
            code, report, _ = self.ambiguous("DELETE", status)
            self.assertEqual(code, 1)
            self.assertEqual(report["outcomes"][-1]["outcome"], "failed")

    def test_prior_success_survives_ambiguous_404_failure(self):
        code, report, transport = self.ambiguous("DELETE", after_success=True)
        self.assertEqual(code, 1)
        self.assertEqual([r["outcome"] for r in report["outcomes"]], ["deleted", "failed"])
        self.assertEqual(len(transport.deleted), 1)


if __name__ == "__main__":
    unittest.main()
