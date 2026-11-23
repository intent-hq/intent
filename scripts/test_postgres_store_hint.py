"""Exercise scripts/postgres_store_hint.py against a scratch intentd checkout.

The Postgres store tests build only with the intent-store `postgres` feature,
so a filtered run without it skips them silently (intentd#3672: a parity test
left out of a 365-test make test-select). The hint must name the gated paths a
branch changes and the command that runs them, stay quiet otherwise, and never
fail the run it decorates.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "postgres_store_hint.py"
PARITY = "crates/intent-store/tests/postgres_backend/homes.rs"


class PostgresStoreHintTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / "intent d's tree"
        for path in (PARITY, "crates/intent-store/src/postgres/mod.rs",
                     "crates/intent-store/src/lib.rs", "crates/intent-store/tests/postgres_backend_lint.rs",
                     "crates/intentd-orchestrator/src/main.rs", "crates/intent-core/src/lib.rs"):
            self.write(path, "// base\n")
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
        self.git("checkout", "-qb", "feature")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    def write(self, path, text="// changed\n"):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, path):
        self.write(path)
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change")

    def hint(self, features="", filterset=None, base="main", env=None, label="test-select"):
        environment = {k: v for k, v in os.environ.items()
                       if k not in {"INTENT_STORE_TEST_PG_URL", "INTENT_STORE_REQUIRE_PG"}}
        environment.update(env or {})
        argv = [sys.executable, "-I", "-B", str(SCRIPT), "--label", label,
                "--intentd-dir", str(self.repo), "--base", base, "--features", features]
        if filterset is not None:
            argv += ["--filterset", filterset]
        result = subprocess.run(argv, env=environment, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "", "the hint writes to stderr only")
        return result.stderr

    def test_changed_parity_test_without_the_feature_names_path_and_rerun_command(self):
        self.commit(PARITY)
        stderr = self.hint()
        self.assertIn("[test-select] WARNING", stderr)
        self.assertIn(PARITY, stderr)
        self.assertIn("make test-select FEATURES=intent-store/postgres E='package(intent-store)'", stderr)
        self.assertIn("INTENT_STORE_TEST_PG_URL", stderr)

    def test_uncommitted_and_untracked_gated_files_count(self):
        paths = ("crates/intent-store/src/postgres/mod.rs", "crates/intent-store/tests/postgres_backend/new.rs",
                 "crates/intent-store/tests/postgres_neki.rs")
        for path in paths:
            self.write(path)
        stderr = self.hint()
        for path in paths:
            self.assertIn(path, stderr)

    def test_ungated_changes_are_silent(self):
        for path in ("crates/intent-store/src/lib.rs", "crates/intent-store/tests/postgres_backend_lint.rs",
                     "crates/intent-core/src/lib.rs"):
            self.commit(path)
        self.assertEqual(self.hint(), "")
        self.assertEqual(self.hint(label="test-changed"), "")

    def test_orchestrator_changes_ask_for_its_feature(self):
        self.commit("crates/intentd-orchestrator/src/main.rs")
        stderr = self.hint(label="test-changed")
        self.assertIn("[test-changed] WARNING", stderr)
        self.assertIn("FEATURES=intentd-orchestrator/postgres E='package(intentd-orchestrator)'", stderr)
        self.commit(PARITY)
        self.assertIn("FEATURES=intentd-orchestrator/postgres E='package(intent-store) | package(intentd-orchestrator)'",
                      self.hint())
        # intentd-orchestrator/postgres turns intent-store/postgres on.
        self.assertNotIn("WARNING", self.hint("intentd-orchestrator/postgres",
                                              env={"INTENT_STORE_TEST_PG_URL": "postgres://x"}))
        self.assertIn("WARNING", self.hint("intent-store/postgres",
                                           env={"INTENT_STORE_TEST_PG_URL": "postgres://x"}))

    def test_enabled_feature_with_a_database_is_silent(self):
        self.commit(PARITY)
        for features in ("intent-store/postgres", "a intent-store/postgres", "intent-store/postgres,b"):
            with self.subTest(features=features):
                self.assertEqual(self.hint(features, env={"INTENT_STORE_TEST_PG_URL": "postgres://x"}), "")

    def test_enabled_feature_without_a_database_warns_that_backend_tests_skip(self):
        stderr = self.hint("intent-store/postgres")
        self.assertIn("INTENT_STORE_TEST_PG_URL is unset", stderr)
        self.assertIn("skip", stderr)
        self.assertEqual(self.hint("intent-store/postgres", env={"INTENT_STORE_REQUIRE_PG": "1"}), "",
                         "INTENT_STORE_REQUIRE_PG=1 already fails a skipped test")
        self.assertEqual(self.hint("intent-store/postgres", env={"INTENT_STORE_TEST_PG_URL": "postgres://x"}), "")

    def test_filterset_naming_postgres_without_the_feature_warns_on_an_unchanged_branch(self):
        stderr = self.hint(filterset="binary_id(=intent-store::postgres_backend)")
        self.assertIn("E names Postgres tests", stderr)
        self.assertIn("FEATURES=intent-store/postgres", stderr)
        self.assertEqual(self.hint(filterset="test(/repository_selection/)"), "")
        # The schema/query lint binaries build without the feature.
        for expression in ("binary(postgres_backend_lint)", "binary(postgres_tenant_schema_lint)"):
            self.assertEqual(self.hint(filterset=expression), "", expression)
        for expression in ("package(intent-store) & test(/^postgres::/)", "binary(postgres_neki)"):
            self.assertIn("FEATURES=intent-store/postgres", self.hint(filterset=expression), expression)

    def test_filterset_naming_the_orchestrator_needs_its_feature(self):
        for features in ("", "intent-store/postgres"):
            with self.subTest(features=features):
                stderr = self.hint(features, filterset="package(intentd-orchestrator)",
                                   env={"INTENT_STORE_TEST_PG_URL": "postgres://x"})
                self.assertIn("FEATURES=intentd-orchestrator/postgres", stderr)
        self.assertEqual(self.hint("intentd-orchestrator/postgres", filterset="package(intentd-orchestrator)",
                                   env={"INTENT_STORE_TEST_PG_URL": "postgres://x"}), "")

    def test_bad_base_or_missing_checkout_never_fails_the_run(self):
        self.commit(PARITY)
        self.assertEqual(self.hint(base="no-such-ref"), "")
        self.repo = self.repo.parent / "missing"
        self.assertEqual(self.hint(), "")


if __name__ == "__main__":
    unittest.main()
