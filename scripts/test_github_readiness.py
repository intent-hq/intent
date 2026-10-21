"""Hermetic response, budget and consumer tests; no live GitHub requests."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parent
SECRET = "ghp_readiness_secret_sentinel"
FAKE_GH = r'''
import json, os, subprocess, sys, time
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["GH_TEST_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
if args == ["--version"]:
    print("gh version 2.100.0")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    print("invalid token " + os.environ["GH_TOKEN"], file=sys.stderr)
    sys.exit(1)
if args[:2] == ["api", "rate_limit"]:
    print('{"resources":{"core":{"remaining":5000}}}')
    sys.exit(0)
if args[:2] == ["pr", "list"]:
    print('[{"number":123,"url":"https://github.com/intent-hq/intent/pull/123","state":"OPEN","statusCheckRollup":[]}]')
    sys.exit(0)
fixture = json.loads(Path(os.environ["GH_TEST_RESPONSES"]).read_text())
row = fixture[args[1]]
if row.get("stall"):
    child = subprocess.Popen([sys.executable, "-S", "-c", "import time; time.sleep(60)"],
                             start_new_session=row.get("detach", False))
    Path(os.environ["GH_TEST_CHILD"]).write_text(str(child.pid))
    with open(os.environ["GH_TEST_CHILDREN"], "a") as children:
        children.write(f"{os.getpid()} {child.pid}\n")
    time.sleep(60)
print(row.get("stdout", ""))
print(row.get("stderr", ""), file=sys.stderr)
sys.exit(row.get("code", 0))
'''


def response(status=200, body=None, headers=None, code=None, stderr=""):
    return {
        "stdout": f"HTTP/2.0 {status} Test\r\n" + "".join(
            f"{key}: {value}\r\n" for key, value in (headers or {}).items()
        ) + "\r\n" + json.dumps(body or {}),
        "stderr": stderr,
        "code": (0 if status == 200 else 1) if code is None else code,
    }


REST_OK = response(body={"login": "fixture"})
GRAPHQL_OK = response(body={"data": {"viewer": {"login": "fixture"}}})
RATE = response(403, {"message": "API rate limit exceeded"}, {
    "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790587121",
})


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        gh = self.bin / "gh"
        gh.write_text(f"#!{sys.executable} -S\n" + FAKE_GH)
        gh.chmod(0o755)
        self.log = self.root / "calls"
        self.responses = self.root / "responses.json"
        self.child = self.root / "child"
        self.children = self.root / "children"
        self.env = os.environ.copy()
        self.env.update(PATH=f"{self.bin}:{os.environ['PATH']}", GH_TOKEN=SECRET,
                        GH_TEST_LOG=str(self.log), GH_TEST_RESPONSES=str(self.responses),
                        GH_TEST_CHILD=str(self.child), GH_TEST_CHILDREN=str(self.children),
                        GITHUB_READINESS_TIMEOUT="3")
        self.set_responses()

    def set_responses(self, rest=REST_OK, graphql=GRAPHQL_OK):
        self.responses.write_text(json.dumps({"user": rest, "graphql": graphql}))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def run_helper(self, *args):
        proc = subprocess.run(["bash", str(SCRIPTS / "github-readiness.sh"), *args],
                              env=self.env, capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(SECRET, proc.stdout + proc.stderr)
        return proc.stdout

    def report(self):
        report = json.loads(self.run_helper())
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertEqual([call[:2] for call in calls], [["api", "user"], ["api", "graphql"]])
        for call in calls:
            self.assertIn("--include", call)
            self.assertIn("--hostname", call)
            self.assertNotIn(SECRET, " ".join(call))
        return report

    def test_authenticated(self):
        report = self.report()
        self.assertEqual(report["state"], "authenticated")
        self.assertTrue(report["prReady"])

    def test_rest_limit_preserves_graphql_and_ignores_quota_overview(self):
        self.set_responses(RATE)
        report = self.report()
        self.assertEqual(report["state"], "rate_limited")
        self.assertTrue(report["prReady"])
        self.assertEqual(report["rest"]["resetAt"], "2026-09-28T09:18:41Z")
        text = self.run_helper("--human")
        self.assertIn("REST rate limited", text)
        self.assertIn("GraphQL authenticated", text)
        self.assertNotIn("gh auth login", text)

    def test_missing_credentials(self):
        missing = {"code": 4, "stderr": "To get started with GitHub CLI, please run:  gh auth login"}
        self.set_responses(missing, missing)
        self.assertEqual(self.report()["state"], "unauthenticated")
        self.assertIn("gh auth login", self.run_helper("--human"))

    def test_unauthorized(self):
        self.set_responses(response(401), response(401))
        self.assertEqual(self.report()["state"], "unauthenticated")
        self.assertIn("gh auth login", self.run_helper("--human"))

    def test_forbidden_transport_and_server_errors_are_not_login_failures(self):
        for row, reason in [(response(403), "forbidden"),
                            ({"code": 1, "stderr": f"network failure {SECRET}"}, "transport"),
                            (response(503), "server_error")]:
            with self.subTest(reason=reason):
                self.log.unlink(missing_ok=True)
                self.set_responses(row, row)
                report = self.report()
                self.assertEqual(report["state"], "unknown")
                self.assertEqual(report["rest"]["reason"], reason)
                self.assertNotIn("gh auth login", self.run_helper("--human"))

    def test_graphql_limit_does_not_hide_rest_success(self):
        self.set_responses(REST_OK, response(body={"errors": [{"type": "RATE_LIMITED"}]}))
        report = self.report()
        self.assertEqual(report["rest"]["state"], "authenticated")
        self.assertEqual(report["graphql"]["state"], "rate_limited")
        self.assertFalse(report["prReady"])

    def test_rest_failures_do_not_disable_working_graphql(self):
        for row in [response(403), response(401), {"code": 1, "stderr": "connection reset"}]:
            with self.subTest(row=row):
                self.log.unlink(missing_ok=True)
                self.set_responses(row)
                report = self.report()
                self.assertTrue(report["prReady"])
                self.assertEqual(report["graphql"]["state"], "authenticated")
                self.assertNotIn("gh auth login", self.run_helper("--human"))

    def test_identity_and_debug_diagnostics_are_not_exposed(self):
        self.env["GH_DEBUG"] = "api"
        self.set_responses(response(body={"login": SECRET}, stderr=SECRET),
                           response(body={"data": {"viewer": {"login": SECRET}}}, stderr=SECRET))
        self.assertEqual(self.report()["state"], "authenticated")
        self.run_helper("--human")

    def test_retry_after_and_secondary_limits(self):
        for row, field, value in [
            (response(429, headers={"Retry-After": "42"}), "retryAfterSeconds", 42),
            (response(403, headers={"Retry-After": "Mon, 28 Sep 2026 09:18:41 GMT"}),
             "retryAt", "2026-09-28T09:18:41Z"),
            (response(403, {"message": "You have exceeded a secondary rate limit."}), None, None),
        ]:
            with self.subTest(field=field):
                self.log.unlink(missing_ok=True)
                self.set_responses(row)
                rest = self.report()["rest"]
                self.assertEqual(rest["state"], "rate_limited")
                if field:
                    self.assertEqual(rest[field], value)

    def test_success_with_zero_remaining_is_still_success(self):
        self.set_responses(response(body={"login": "fixture"}, headers={"X-RateLimit-Remaining": "0"}))
        self.assertEqual(self.report()["rest"]["state"], "authenticated")

    def test_malformed_payloads_and_sensitive_headers_are_not_printed(self):
        for row in [response(body={"data": []}), response(body={"errors": [SECRET]}),
                    response(403, {"message": SECRET}, {"Retry-After": SECRET,
                             "X-RateLimit-Reset": SECRET, "Authorization": SECRET}),
                    {"code": 1, "stdout": SECRET, "stderr": SECRET}]:
            with self.subTest(row=row):
                self.set_responses(row, row)
                self.assertNotIn("gh auth login", self.run_helper("--human"))

    def test_timeout_kills_children_and_is_bounded(self):
        self.env["GITHUB_READINESS_TIMEOUT"] = "0.5"
        self.set_responses({"stall": True}, {"stall": True})
        started = time.monotonic()
        report = self.report()
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(report["rest"]["reason"], "timeout")
        self.assertEqual(report["graphql"]["reason"], "timeout")
        # A killed child may briefly remain a zombie until the host reaps it.
        stat = Path(f"/proc/{self.child.read_text()}/stat")
        if stat.exists():
            self.assertEqual(stat.read_text().split(")", 1)[1].split()[0], "Z")

    def test_invalid_timeout_does_not_echo_secrets(self):
        self.env["GITHUB_READINESS_TIMEOUT"] = SECRET
        self.report()

    def test_timeout_discards_pipes_held_by_detached_children(self):
        self.env["GITHUB_READINESS_TIMEOUT"] = "0.1"
        self.set_responses({"stall": True, "detach": True}, {"stall": True, "detach": True})
        # Launch without host site instrumentation so the deadline measures
        # the probes, not Python startup hooks. The outer bound catches a
        # stuck cleanup and the finally block removes every fixture process.
        proc = subprocess.Popen([sys.executable, "-S", str(SCRIPTS / "github_readiness.py")],
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
        started = time.monotonic()
        try:
            out, err = proc.communicate(timeout=2)
            self.assertEqual(proc.returncode, 0, err)
            self.assertNotIn(SECRET, out + err)
            report = json.loads(out)
            self.assertEqual(report["rest"]["reason"], "timeout")
            self.assertEqual(report["graphql"]["reason"], "timeout")
            self.assertEqual(len(self.calls()), 2)
            self.assertLess(time.monotonic() - started, 2)
            for line in self.children.read_text().splitlines():
                parent, _ = map(int, line.split())
                with self.assertRaises(ProcessLookupError):
                    os.kill(parent, 0)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            if self.children.exists():
                for line in self.children.read_text().splitlines():
                    for pid in map(int, line.split()):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
            proc.communicate(timeout=2)

    def test_timeout_configuration_is_capped(self):
        spec = importlib.util.spec_from_file_location("github_readiness", SCRIPTS / "github_readiness.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for value in ["nan", "inf", "0", "-1", "1e99", SECRET]:
            with self.subTest(value=value), patch.dict(os.environ, {"GITHUB_READINESS_TIMEOUT": value}):
                self.assertGreater(module.probe_timeout(), 0)
                self.assertLessEqual(module.probe_timeout(), module.TIMEOUT_MAX)

    def test_missing_gh_is_fail_soft(self):
        self.env["PATH"] = str(self.bin)
        (self.bin / "gh").unlink()
        for command in ["bash", "dirname", "python3"]:
            (self.bin / command).symlink_to(shutil.which(command))
        report = json.loads(self.run_helper())
        self.assertEqual(report["state"], "missing_cli")
        self.assertNotIn("gh auth login", self.run_helper("--human"))

    def run_status(self, human=False):
        # Force branch PR lookups even when this checkout's submodules are
        # detached. All other git operations use the real, read-only probes.
        git = self.bin / "git"
        git.write_text(f"#!{sys.executable}\nimport os, sys\n"
                       "if sys.argv[-2:] == ['branch', '--show-current']:\n"
                       "    print('fixture'); sys.exit(0)\n"
                       f"os.execv({shutil.which('git')!r}, ['git'] + sys.argv[1:])\n")
        git.chmod(0o755)
        env = self.env.copy()
        env["STATUS_JSON"] = "0" if human else "1"
        # A fake response should not time out solely because of host load.
        env["GITHUB_READINESS_TIMEOUT"] = "3"
        env["DEV_STATUS_PROBE_TIMEOUT"] = "30"
        env["DEV_STATUS_PORT_TIMEOUT"] = "30"
        proc = subprocess.run(["bash", str(SCRIPTS / "dev-status.sh")], env=env,
                              capture_output=True, text=True, timeout=100)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn(SECRET, proc.stdout + proc.stderr)
        calls = self.calls()
        self.assertEqual(len([call for call in calls if call[0] == "api"]), 2, calls)
        self.assertFalse(any(call[:2] == ["auth", "status"] for call in calls), calls)
        return proc.stdout

    def test_status_reuses_readiness_and_keeps_pr_lookup_when_rest_is_limited(self):
        self.set_responses(RATE)
        report = json.loads(self.run_status())
        self.assertTrue(report["host"]["github"]["prReady"])
        initialized = [repo for repo in report["repos"].values() if repo["initialized"]]
        self.assertTrue(initialized, "CI initializes at least intentd")
        for repo in initialized:
            self.assertEqual(repo["pr"]["number"], 123)
        self.log.unlink()
        human = self.run_status(human=True)
        self.assertIn("REST rate limited", human)
        self.assertIn("GraphQL authenticated", human)
        self.assertNotIn("gh auth login", human)

    def test_status_skips_pr_lookup_when_graphql_is_limited(self):
        self.set_responses(REST_OK, RATE)
        report = json.loads(self.run_status())
        self.assertEqual(report["host"]["github"]["rest"]["state"], "authenticated")
        self.assertFalse(any(call[0] == "pr" for call in self.calls()))
        for repo in report["repos"].values():
            self.assertNotIn("pr", repo)

    def test_doctor_optional_failures_preserve_exit_status_and_safe_diagnostics(self):
        codes = []
        for rest, graphql, expected, login in [
            (REST_OK, GRAPHQL_OK, "REST authenticated", False),
            (RATE, GRAPHQL_OK, "REST rate limited", False),
            (response(403, {"message": SECRET}), GRAPHQL_OK, "HTTP 403", False),
            ({"code": 1, "stderr": SECRET}, GRAPHQL_OK, "transport failure", False),
            (response(401), response(401), "credentials missing or rejected", True),
        ]:
            with self.subTest(expected=expected):
                self.set_responses(rest, graphql)
                env = self.env.copy()
                env.pop("DEV_STATUS_SKIP_GITHUB", None)
                env["GITHUB_READINESS_TIMEOUT"] = "3"
                proc = subprocess.run(["bash", str(SCRIPTS / "bootstrap-dev-host.sh"), "--check"],
                                      env=env, capture_output=True, text=True, timeout=60)
                codes.append(proc.returncode)
                output = proc.stdout + proc.stderr
                self.assertIn(expected, output)
                self.assertEqual("gh auth login" in output, login)
                self.assertNotIn(SECRET, output)
        self.assertEqual(len(set(codes)), 1, codes)


if __name__ == "__main__":
    unittest.main()
