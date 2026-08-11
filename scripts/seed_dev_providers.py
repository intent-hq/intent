#!/usr/bin/env python3
"""Seed an empty intentd dev seat with non-secret provider preferences."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tomllib


def default_prod_config() -> Path | None:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library/Application Support/intentd/config.toml"
    if sys.platform == "win32":
        app_data = os.environ.get("APPDATA")
        return Path(app_data) / "intentd/data/config.toml" if app_data else None
    if sys.platform.startswith("linux"):
        data_home = os.environ.get("XDG_DATA_HOME")
        if data_home:
            return Path(data_home) / "intentd/config.toml"
        return home / ".local/share/intentd/config.toml"
    return None


def toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_seed(providers: object) -> str | None:
    if not isinstance(providers, dict):
        return None
    active = providers.get("active")
    enabled = providers.get("enabled")
    paths = providers.get("paths")
    lines = [
        "# Seeded by make seed-dev-providers from the packaged intentd config.",
        "[providers]",
    ]
    seeded = False
    if isinstance(active, str) and active:
        lines.append(f"active = {toml_string(active)}")
        seeded = True
    if isinstance(enabled, dict) and all(
        isinstance(key, str) and isinstance(value, bool) for key, value in enabled.items()
    ):
        entries = ", ".join(
            f"{toml_string(key)} = {'true' if value else 'false'}"
            for key, value in sorted(enabled.items())
        )
        lines.append(f"enabled = {{ {entries} }}")
        seeded = True
    absolute_paths = {}
    if isinstance(paths, dict):
        absolute_paths = {
            key: value
            for key, value in paths.items()
            if isinstance(key, str) and isinstance(value, str) and os.path.isabs(value)
        }
    if absolute_paths:
        entries = ", ".join(
            f"{toml_string(key)} = {toml_string(value)}"
            for key, value in sorted(absolute_paths.items())
        )
        lines.append(f"paths = {{ {entries} }}")
        seeded = True
    return "\n".join(lines) + "\n" if seeded else None


def seed(dev_data_dir: Path, source: Path | None) -> str:
    if dev_data_dir.exists() and any(dev_data_dir.iterdir()):
        return "existing dev seat; provider seed skipped"
    if source is None or not source.is_file():
        return "packaged config not found; provider seed skipped"
    try:
        config = tomllib.loads(source.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        return f"packaged config unreadable ({error}); provider seed skipped"
    rendered = render_seed(config.get("providers"))
    if rendered is None:
        return "packaged config has no provider preferences; provider seed skipped"
    dev_data_dir.mkdir(parents=True, exist_ok=True)
    if any(dev_data_dir.iterdir()):
        return "existing dev seat; provider seed skipped"
    try:
        with (dev_data_dir / "config.toml").open("x", encoding="utf-8") as config_file:
            config_file.write(rendered)
    except FileExistsError:
        return "existing dev config; provider seed skipped"
    return f"seeded provider preferences from {source}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev-data-dir", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    source = args.source or default_prod_config()
    print(f"[seed-dev-providers] {seed(args.dev_data_dir, source)}")


if __name__ == "__main__":
    main()