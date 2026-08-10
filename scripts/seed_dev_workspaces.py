#!/usr/bin/env python3
"""Seed a dev intentd SQLite DB with workspace rows from the packaged seat.

Copies workspace *metadata* only (title, paths, branch, status, …). Does not
copy agents, notes, messages, assets, or on-disk worktrees — paths keep pointing
at the shared production checkouts (typically ~/intent/workspaces).
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

# Keep in sync with intent-store WORKSPACE_COLUMNS + auto_commit_enabled.
WORKSPACE_COLUMNS = (
    "id, title, branch, base_ref, base_commit_sha, status, "
    "status_message, status_image_asset_id, attention, path, repository_path, "
    "repository_owner, repository_name, worktree_path, scope, skip_worktree, "
    "is_remote, default_model, pr_number, pr_url, pr_status, active_pull_request, "
    "pull_requests, archived, archived_at, tags, created_at, updated_at, "
    "last_activity, token_usage, setup_script, checkout_mode, auto_commit_enabled"
)

# Skip virtual rows the daemon recreates itself (chief of staff).
SKIP_IDS = frozenset({"__chief__"})


def default_prod_db() -> Path | None:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library/Application Support/intentd/intentd.db"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        return Path(app_data) / "intentd/data/intentd.db" if app_data else None
    if sys.platform.startswith("linux"):
        data_home = os.environ.get("XDG_DATA_HOME")
        if data_home:
            return Path(data_home) / "intentd/intentd.db"
        return home / ".local/share/intentd/intentd.db"
    return None


def open_ro(path: Path) -> sqlite3.Connection:
    # URI read-only: survives a running packaged daemon's write lock / WAL.
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _cols(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(workspace)")}


def seed(
    dev_data_dir: Path,
    source_db: Path | None,
    *,
    include_archived: bool = False,
) -> str:
    if source_db is None or not source_db.is_file():
        return "packaged intentd.db not found; workspace seed skipped"

    dest_db = dev_data_dir / "intentd.db"
    if not dest_db.is_file():
        return f"dev DB missing at {dest_db}; initialize via make seed-dev-workspaces first"

    try:
        src, dst = open_ro(source_db), sqlite3.connect(dest_db)
    except sqlite3.Error as error:
        return f"DB unreadable ({error}); workspace seed skipped"

    try:
        wanted = [c.strip() for c in WORKSPACE_COLUMNS.split(",")]
        cols = [c for c in wanted if c in _cols(src) and c in _cols(dst)]
        if "id" not in cols:
            return "workspace table/columns missing; workspace seed skipped"

        status_filter = (
            "status IN ('Active', 'Archived')" if include_archived else "status = 'Active'"
        )
        col_sql = ", ".join(cols)
        rows = src.execute(
            f"SELECT {col_sql} FROM workspace WHERE {status_filter} ORDER BY id"
        ).fetchall()
        existing = {r[0] for r in dst.execute("SELECT id FROM workspace")}
        insert_sql = f"INSERT INTO workspace ({col_sql}) VALUES ({', '.join('?' for _ in cols)})"

        inserted = skipped = 0
        for row in rows:
            ws_id = row["id"]
            if ws_id in SKIP_IDS or ws_id in existing:
                skipped += 1
                continue
            try:
                dst.execute(insert_sql, [row[c] for c in cols])
            except sqlite3.IntegrityError:
                skipped += 1
                continue
            inserted += 1
            existing.add(ws_id)

        dst.commit()
        label = "Active+Archived" if include_archived else "Active"
        return f"seeded {inserted} {label} workspace(s) from {source_db} ({skipped} skipped)"
    except sqlite3.Error as error:
        return f"workspace seed failed ({error})"
    finally:
        src.close()
        dst.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev-data-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path, help="path to packaged intentd.db")
    parser.add_argument(
        "--include-archived",
        action="store_true",
        help="also copy Archived workspaces (default: Active only)",
    )
    args = parser.parse_args()
    source = args.source or default_prod_db()
    print(
        f"[seed-dev-workspaces] {seed(args.dev_data_dir, source, include_archived=args.include_archived)}"
    )


if __name__ == "__main__":
    main()
