import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("seed_dev_workspaces.py")
SPEC = importlib.util.spec_from_file_location("seed_dev_workspaces", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

SCHEMA = """
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT,
  base_commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  status_message TEXT,
  status_image_asset_id TEXT,
  attention TEXT NOT NULL DEFAULT 'none',
  path TEXT,
  repository_path TEXT,
  repository_owner TEXT,
  repository_name TEXT,
  worktree_path TEXT,
  scope TEXT,
  skip_worktree INTEGER NOT NULL DEFAULT 0,
  is_remote INTEGER NOT NULL DEFAULT 0,
  default_model TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_status TEXT,
  active_pull_request TEXT,
  pull_requests TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity TEXT,
  token_usage TEXT,
  setup_script TEXT,
  checkout_mode TEXT,
  auto_commit_enabled INTEGER
);
"""


def _make_db(path: Path, rows: list[tuple]) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    cols = "id, title, branch, status, path, repository_path, worktree_path, created_at, updated_at"
    for row in rows:
        conn.execute(
            f"INSERT INTO workspace ({cols}) VALUES (?,?,?,?,?,?,?,?,?)",
            row,
        )
    conn.commit()
    conn.close()


def _ids(path: Path) -> set[str]:
    conn = sqlite3.connect(path)
    out = {r[0] for r in conn.execute("SELECT id FROM workspace")}
    conn.close()
    return out


class SeedDevWorkspacesTests(unittest.TestCase):
    def test_seeds_active_only_and_skips_chief(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.db"
            dev = root_path / "dev"
            dev.mkdir()
            dest = dev / "intentd.db"
            ts = "2026-01-01T00:00:00Z"
            _make_db(
                source,
                [
                    ("__chief__", "Chief", "main", "Active", None, None, None, ts, ts),
                    ("alpha", "Alpha", "b1", "Active", "/p/a", "/r/a", "/w/a", ts, ts),
                    ("beta", "Beta", "b2", "Archived", "/p/b", "/r/b", "/w/b", ts, ts),
                ],
            )
            _make_db(dest, [])

            result = MODULE.seed(dev, source)

            self.assertIn("seeded 1 Active", result)
            self.assertEqual(_ids(dest), {"alpha"})
            conn = sqlite3.connect(dest)
            row = conn.execute(
                "SELECT title, path, worktree_path FROM workspace WHERE id='alpha'"
            ).fetchone()
            conn.close()
            self.assertEqual(row, ("Alpha", "/p/a", "/w/a"))

    def test_include_archived(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.db"
            dev = root_path / "dev"
            dev.mkdir()
            dest = dev / "intentd.db"
            ts = "2026-01-01T00:00:00Z"
            _make_db(
                source,
                [
                    ("alpha", "Alpha", "b1", "Active", "/p/a", "/r/a", "/w/a", ts, ts),
                    ("beta", "Beta", "b2", "Archived", "/p/b", "/r/b", "/w/b", ts, ts),
                ],
            )
            _make_db(dest, [])

            result = MODULE.seed(dev, source, include_archived=True)

            self.assertIn("seeded 2 Active+Archived", result)
            self.assertEqual(_ids(dest), {"alpha", "beta"})

    def test_idempotent_second_run(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.db"
            dev = root_path / "dev"
            dev.mkdir()
            dest = dev / "intentd.db"
            ts = "2026-01-01T00:00:00Z"
            _make_db(
                source,
                [("alpha", "Alpha", "b1", "Active", "/p/a", "/r/a", "/w/a", ts, ts)],
            )
            _make_db(dest, [])
            MODULE.seed(dev, source)
            result = MODULE.seed(dev, source)
            self.assertIn("seeded 0", result)
            self.assertIn("1 skipped", result)
            self.assertEqual(_ids(dest), {"alpha"})

    def test_missing_source_is_noop(self):
        with tempfile.TemporaryDirectory() as root:
            dev = Path(root) / "dev"
            dev.mkdir()
            (dev / "intentd.db").write_bytes(b"")
            # empty file is still "present"; use a missing path
            result = MODULE.seed(dev, Path(root) / "missing.db")
            self.assertIn("not found", result)

    def test_missing_dest_db_is_noop(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "prod.db"
            dev = root_path / "dev"
            dev.mkdir()
            ts = "2026-01-01T00:00:00Z"
            _make_db(
                source,
                [("alpha", "Alpha", "b1", "Active", "/p/a", "/r/a", "/w/a", ts, ts)],
            )
            result = MODULE.seed(dev, source)
            self.assertIn("dev DB missing", result)


if __name__ == "__main__":
    unittest.main()
